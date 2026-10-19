/*
 * X Bookmark Store · v2
 *
 * A single giant chrome.storage.local array gets expensive to rewrite on every
 * flush and can hit Chromium's default quota long before a large bookmark
 * archive is complete. This tiny store writes bounded chunks and one compact
 * summary. The legacy `xBookmarks` array is still read and migrated in place.
 *
 * Shape of each record remains the XReels-compatible `bookmarks[]` shape.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XBookmarkStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const META_KEY = "xBookmarkMeta";
  const LEGACY_KEY = "xBookmarks";
  const CHUNK_PREFIX = "xBookmarkChunk.";
  const CHUNK_SIZE = 256;
  const MAX_CHUNKS = 100000;

  const local = () => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      throw new Error("Chrome extension storage is unavailable.");
    }
    return chrome.storage.local;
  };

  const chunkKey = (index) => CHUNK_PREFIX + String(index).padStart(6, "0");
  const validMeta = (meta) => !!meta && meta.version === 2 &&
    Number.isInteger(meta.chunkCount) && meta.chunkCount >= 0 && meta.chunkCount <= MAX_CHUNKS;

  function itemCounts(item) {
    const media = Array.isArray(item?.media_items) ? item.media_items : [];
    return {
      media: media.length,
      videos: media.reduce((n, entry) => n + (entry && (entry.type === "video" || entry.type === "animated_gif") ? 1 : 0), 0),
    };
  }

  function countsOf(items) {
    let mediaItems = 0, videos = 0;
    for (const item of items) {
      const c = itemCounts(item);
      mediaItems += c.media;
      videos += c.videos;
    }
    return { count: items.length, mediaItems, videos };
  }

  function summaryFromMeta(meta) {
    if (!validMeta(meta)) return null;
    return {
      count: Math.max(0, Number(meta.total) || 0),
      mediaItems: Math.max(0, Number(meta.mediaItems) || 0),
      videos: Math.max(0, Number(meta.videos) || 0),
      chunks: meta.chunkCount,
      version: 2,
    };
  }

  async function summary() {
    const data = await local().get([META_KEY, LEGACY_KEY]);
    const modern = summaryFromMeta(data[META_KEY]);
    if (modern) return modern;
    const legacy = Array.isArray(data[LEGACY_KEY]) ? data[LEGACY_KEY] : [];
    return { ...countsOf(legacy), chunks: 0, version: 1 };
  }

  async function readAll() {
    const data = await local().get([META_KEY, LEGACY_KEY]);
    const meta = data[META_KEY];
    if (validMeta(meta)) {
      if (!meta.chunkCount) return [];
      const keys = Array.from({ length: meta.chunkCount }, (_, i) => chunkKey(i));
      const chunks = await local().get(keys);
      const items = [];
      for (const key of keys) {
        if (!Array.isArray(chunks[key])) {
          throw new Error(`Bookmark storage is incomplete: missing chunk ${key}.`);
        }
        items.push(...chunks[key]);
      }
      if (Number.isFinite(Number(meta.total)) && items.length !== Number(meta.total)) {
        throw new Error(`Bookmark storage count mismatch: metadata lists ${meta.total} posts, but ${items.length} were read.`);
      }
      return items;
    }
    return Array.isArray(data[LEGACY_KEY]) ? data[LEGACY_KEY] : [];
  }

  async function clear() {
    const data = await local().get([META_KEY]);
    const meta = data[META_KEY];
    const keys = [META_KEY, LEGACY_KEY];
    if (validMeta(meta)) {
      for (let i = 0; i < meta.chunkCount; i++) keys.push(chunkKey(i));
    }
    if (keys.length) await local().remove(keys);
  }

  async function open() {
    const base = await local().get([META_KEY, LEGACY_KEY]);
    const meta = base[META_KEY];
    const legacy = Array.isArray(base[LEGACY_KEY]) ? base[LEGACY_KEY] : null;
    let chunks = [];
    let migratingLegacy = false;
    let persistedMeta = validMeta(meta);

    if (persistedMeta) {
      const keys = Array.from({ length: meta.chunkCount }, (_, i) => chunkKey(i));
      const saved = keys.length ? await local().get(keys) : {};
      const missingChunk = keys.find((key) => !Array.isArray(saved[key]));
      if (missingChunk) throw new Error(`Bookmark storage is incomplete: missing chunk ${missingChunk}.`);
      chunks = keys.map((key) => saved[key]);
      const actualCount = chunks.reduce((count, items) => count + items.length, 0);
      if (Number.isFinite(Number(meta.total)) && actualCount !== Number(meta.total)) {
        throw new Error(`Bookmark storage count mismatch: metadata lists ${meta.total} posts, but ${actualCount} were read.`);
      }
      // A previous migration may have committed metadata but been interrupted
      // before removing the old monolithic array. The chunks are authoritative.
      if (legacy) await local().remove(LEGACY_KEY);
    } else if (legacy?.length) {
      migratingLegacy = true;
      for (let i = 0; i < legacy.length; i += CHUNK_SIZE) {
        chunks.push(legacy.slice(i, i + CHUNK_SIZE));
      }
    }

    const byId = new Map();
    const locations = new Map();
    let total = 0, mediaItems = 0, videos = 0;
    const dirty = new Set();

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const items = chunks[chunkIndex];
      for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        const item = items[itemIndex];
        if (!item || typeof item !== "object") continue;
        total++;
        const counts = itemCounts(item);
        mediaItems += counts.media;
        videos += counts.videos;
        const id = String(item.tweet_id || "");
        if (id && !byId.has(id)) {
          byId.set(id, item);
          locations.set(id, { chunkIndex, itemIndex });
        }
      }
    }

    if (migratingLegacy) {
      for (let i = 0; i < chunks.length; i++) dirty.add(i);
    }

    const metaNeedsRepair = persistedMeta && (
      Number(meta.total) !== total || Number(meta.mediaItems) !== mediaItems || Number(meta.videos) !== videos ||
      Number(meta.chunkCount) !== chunks.length
    );
    if (metaNeedsRepair) persistedMeta = false;

    function upsert(item) {
      if (!item || typeof item !== "object") return { added: false, updated: false };
      const id = String(item.tweet_id || "");
      const existing = id ? byId.get(id) : null;
      if (existing) {
        const loc = locations.get(id);
        const previousCounts = itemCounts(existing);
        const merged = {
          ...existing,
          ...item,
          tweet_id: id,
          first_seen_at: existing.first_seen_at || item.first_seen_at,
          captured_at: existing.captured_at || item.captured_at,
          capture_order: Number(existing.capture_order) || Number(item.capture_order) || total,
        };
        chunks[loc.chunkIndex][loc.itemIndex] = merged;
        byId.set(id, merged);
        const nextCounts = itemCounts(merged);
        mediaItems += nextCounts.media - previousCounts.media;
        videos += nextCounts.videos - previousCounts.videos;
        dirty.add(loc.chunkIndex);
        return { added: false, updated: true };
      }

      let chunkIndex = chunks.length - 1;
      if (chunkIndex < 0 || chunks[chunkIndex].length >= CHUNK_SIZE) {
        chunkIndex = chunks.length;
        chunks.push([]);
      }
      const stored = {
        ...item,
        tweet_id: id || String(item.tweet_id || ""),
        capture_order: Number(item.capture_order) || total + 1,
      };
      const itemIndex = chunks[chunkIndex].length;
      chunks[chunkIndex].push(stored);
      if (id) {
        byId.set(id, stored);
        locations.set(id, { chunkIndex, itemIndex });
      }
      total++;
      const counts = itemCounts(stored);
      mediaItems += counts.media;
      videos += counts.videos;
      dirty.add(chunkIndex);
      return { added: true, updated: false };
    }

    async function flush() {
      if (!dirty.size && persistedMeta && !migratingLegacy) {
        return summaryFromMeta({ version: 2, total, mediaItems, videos, chunkCount: chunks.length });
      }

      const changes = {};
      for (const index of dirty) changes[chunkKey(index)] = chunks[index];
      const nextMeta = {
        version: 2,
        chunkSize: CHUNK_SIZE,
        chunkCount: chunks.length,
        total,
        mediaItems,
        videos,
        updatedAt: new Date().toISOString(),
      };
      changes[META_KEY] = nextMeta;
      await local().set(changes);
      if (migratingLegacy) await local().remove(LEGACY_KEY);
      dirty.clear();
      migratingLegacy = false;
      persistedMeta = true;
      return summaryFromMeta(nextMeta);
    }

    return {
      has: (id) => byId.has(String(id || "")),
      get: (id) => byId.get(String(id || "")) || null,
      upsert,
      flush,
      get total() { return total; },
      get mediaItems() { return mediaItems; },
      get videos() { return videos; },
      get chunks() { return chunks.length; },
      get pendingWrites() { return dirty.size; },
      get needsFlush() { return dirty.size > 0 || !persistedMeta || migratingLegacy; },
    };
  }

  return {
    META_KEY,
    LEGACY_KEY,
    CHUNK_PREFIX,
    CHUNK_SIZE,
    chunkKey,
    validMeta,
    summaryFromMeta,
    summary,
    readAll,
    clear,
    open,
  };
});
