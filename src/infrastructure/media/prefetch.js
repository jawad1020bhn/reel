/* infra.media.prefetch — MediaPrefetchPort: the "no buffering" layer.

   Two jobs:

   1. WARM — the feed tells us which clips are coming next; we download them in the
      background, two at a time, lowest priority, and keep the bytes in an LRU blob
      cache. When the player reaches that clip it plays from memory instead of the CDN,
      so a swipe is instant and a slow network never shows a spinner for a neighbour.

   2. CACHE — the same blob cache is what makes seeking cheap. A clip that is already
      in memory is fully seekable: the browser has every byte, so dragging the
      playhead anywhere is a local operation with no request at all. Clips bigger than
      `MAX_ENTRY_BYTES` are not cached whole (that would evict everything else); they
      are streamed by the browser with range requests as before.

   Policy, not plumbing: this module knows nothing about <video>. app.playback asks it
   for a blob URL to play from, and calls `warm()`/`warmAhead()` on its behalf.

   Memory is capped by BOTH a byte budget and an entry count; the eviction order is the
   access order (a hit moves the entry to the front). blob: URLs are revoked on evict so
   the bytes are actually released. */

XR.define("infra.media.prefetch", [], function () {
  "use strict";

  /* Memory, not disk: the service worker (infra.media.offline) already keeps watched
     clips on the device, so the in-RAM cache only needs to cover the swipe window. Keeping
     it modest matters on phones, where 96 MB of blobs is a real tab-kill risk. */
  const MAX_BYTES = 64 * 1024 * 1024;      // ~64 MB of warm media: a handful of clips ahead
  const MAX_ENTRIES = 32;
  const MAX_ENTRY_BYTES = 14 * 1024 * 1024; // bigger clips stream natively; caching them would thrash
  const WARM_PARALLEL = 2;

  /** @type {Map<string, {blob: Blob, url: string, size: number, type: string, at: number}>} */
  const entries = new Map();
  const inflight = new Map();
  let bytes = 0;
  let enabled = true;
  let hits = 0, misses = 0, warmed = 0, warmedBytes = 0;

  const isMediaUrl = (url) => typeof url === "string" && /^https?:\/\//i.test(url) && !/\.m3u8(\?|$)/i.test(url);

  function touch(key) {
    const e = entries.get(key);
    if (!e) return null;
    entries.delete(key);
    e.at = Date.now();
    entries.set(key, e);          // re-insert: last = newest
    return e;
  }

  function evictToFit(extra) {
    while (entries.size && (bytes + extra > MAX_BYTES || entries.size >= MAX_ENTRIES)) {
      const [key, e] = entries.entries().next().value;
      entries.delete(key);
      bytes -= e.size;
      try { URL.revokeObjectURL(e.url); } catch { /* ignore */ }
    }
  }

  /** Synchronous: a blob URL for an already-warm clip, or "" when it is not in memory. */
  function blobUrl(url) {
    if (!enabled) return "";
    const e = touch(url);
    if (!e) { misses++; return ""; }
    hits++;
    return e.url;
  }

  const has = (url) => entries.has(url);

  /** Media bytes currently in memory (for Settings / diagnostics). */
  function stats() {
    return {
      entries: entries.size,
      bytes,
      maxBytes: MAX_BYTES,
      hits,
      misses,
      warmed,
      warmedBytes,
      pending: inflight.size,
      hitRate: hits + misses ? hits / (hits + misses) : 0,
    };
  }

  /**
   * Download a clip into the cache. Returns the blob URL when it lands (or immediately if
   * it is already cached), null when it cannot be cached (too big, HLS, offline, aborted).
   * Safe to call repeatedly: a second call for the same URL joins the first request.
   */
  function warm(url, { type = "video/mp4", expectedBytes = 0 } = {}) {
    if (!enabled || !isMediaUrl(url)) return Promise.resolve(null);
    const hit = touch(url);
    if (hit) return Promise.resolve(hit.url);
    if (inflight.has(url)) return inflight.get(url);
    /* The caller may know the expected weight (bitrate × duration in warmAhead), in which
       case a clip that can never fit is refused before it costs a request. The authoritative
       check is still the response's own size, below. */
    if (expectedBytes > MAX_ENTRY_BYTES) return Promise.resolve(null);
    const job = fetch(url, { mode: "cors", credentials: "omit", cache: "force-cache" })
      .then(async (res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        const length = Number(res.headers.get("content-length")) || 0;
        if (length > MAX_ENTRY_BYTES) throw new Error("too large");
        const blob = await res.blob();
        if (blob.size > MAX_ENTRY_BYTES) throw new Error("too large");
        if (!blob.size) throw new Error("empty");
        evictToFit(blob.size);
        const objectUrl = URL.createObjectURL(blob);
        entries.set(url, { blob, url: objectUrl, size: blob.size, type: type || blob.type || "video/mp4", at: Date.now() });
        bytes += blob.size;
        warmed++; warmedBytes += blob.size;
        return objectUrl;
      })
      .catch(() => null)
      .finally(() => inflight.delete(url));
    inflight.set(url, job);
    return job;
  }

  /* ------------------------------------------------------------- queue -- */
  /* Warm requests are queued rather than fired at once: the feed can name six neighbours,
     but six parallel downloads would compete with the clip that is actually playing.
     Two at a time, and anything already warm is skipped before it reaches the queue. */
  const queue = [];      // [{url, opts, resolve, priority}]
  let running = 0;

  function pump() {
    while (running < WARM_PARALLEL && queue.length) {
      const job = queue.shift();
      if (entries.has(job.url)) { job.resolve(entries.get(job.url).url); continue; }
      running++;
      warm(job.url, job.opts).then((url) => { running--; job.resolve(url); pump(); });
    }
  }

  /** Queue a warm-up. priority 0 = next clip (front of the queue), 1 = later (back). */
  function prefetch(url, opts = {}, { priority = 1 } = {}) {
    if (!enabled || !isMediaUrl(url) || entries.has(url) || inflight.has(url)) return Promise.resolve(null);
    if (queue.some((j) => j.url === url)) return Promise.resolve(null);
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const job = { url, opts, resolve };
    if (priority === 0) queue.unshift(job); else queue.push(job);
    /* keep the queue bounded: far-away neighbours are not worth a slot */
    if (queue.length > 8) {
      const dropped = queue.pop();
      dropped.resolve(null);
    }
    pump();
    return promise;
  }

  /* --------------------------------------------------------- warm-ahead -- */
  /* While a clip plays, fetch the rest of it in the background. This is what makes
     dragging the playhead anywhere a local operation instead of a fresh range request.
     A duration ceiling keeps us from downloading a 40-minute video "just in case"; the
     byte ceiling inside warm() catches heavy clips that slip under it. */
  const AHEAD_MAX_SECONDS = 8 * 60;
  const aheadInFlight = new Set();
  function warmAhead(video, url, { duration = 0, bitrate = 0 } = {}) {
    if (!enabled || !isMediaUrl(url)) return;
    if (duration > AHEAD_MAX_SECONDS) return;             // long form streams natively
    if (entries.has(url) || aheadInFlight.has(url)) return;
    /* bits per second × seconds ÷ 8, when both are known: refuse an obviously oversized
       clip up front instead of buffering 40 MB and then throwing it away. */
    const expectedBytes = duration && bitrate ? (bitrate * duration) / 8 : 0;
    aheadInFlight.add(url);
    warm(url, { type: "video/mp4", expectedBytes }).finally(() => aheadInFlight.delete(url));
  }

  /** Forget everything (Settings → clear cached media, and before a hard reload). */
  function clear() {
    for (const [, e] of entries) { try { URL.revokeObjectURL(e.url); } catch { /* ignore */ } }
    entries.clear();
    bytes = 0;
    queue.length = 0;
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) clear();
  }

  return { blobUrl, warm, prefetch, warmAhead, has, stats, clear, setEnabled, get enabled() { return enabled; }, MAX_ENTRY_BYTES };
});
