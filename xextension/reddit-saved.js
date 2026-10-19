/*
 * Reddit saved-posts capture (NSFW only): pure logic.
 *
 * Nothing in this file touches the DOM, the network, or chrome.* directly. The
 * content script (reddit-capture.js) reads rows from old.reddit.com and hands
 * plain objects in here; the popup (reddit-panel.js) reads the store back out.
 * Keeping the rules here means the important decisions are unit-testable:
 *
 *  - Filter: only posts Reddit tags over-18 are kept. SFW posts are counted,
 *    never stored. Comments (t1_) are skipped entirely.
 *  - Normalize: a row becomes a compact, export-ready record with media URLs
 *    for i.redd.it, v.redd.it and galleries. URLs only; no bytes are fetched.
 *  - Store: 256-item chunks under chrome.storage.local keys, with a meta record
 *    that also pins the account the data belongs to.
 *  - Pacing: jittered gaps between pages with occasional longer "wave" breaks,
 *    and an exponential backoff for 429/5xx responses.
 *  - Export: the JSON envelope written to reddit-nsfw-saved.json.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XRedditSaved = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EXPORT_VERSION = 1;
  const SOURCE = "reddit-saved-nsfw";
  const CHUNK_SIZE = 256;
  const META_KEY = "redditSavedMeta";
  const STATE_KEY = "redditCaptureState";
  const CHUNK_PREFIX = "redditSavedChunk.";
  const FILE_NAME = "reddit-nsfw-saved.json";

  const DEFAULT_PACING = Object.freeze({
    minDelayMs: 2500,       // gap between pages, lower bound
    maxDelayMs: 5000,       // gap between pages, upper bound
    waveMinPages: 8,        // a wave break lands every 8–14 pages
    waveMaxPages: 14,
    waveMinMs: 8000,
    waveMaxMs: 20000,
    backoffBaseMs: 30000,
    backoffCapMs: 300000,
    maxRetries: 4,
  });

  const SAVED_URL = /^https:\/\/old\.reddit\.com\/user\/([A-Za-z0-9_-]{1,40})\/saved(?:[/?#]|$)/i;

  /* ---------------------------------------------------------------------------
     URL and identity helpers
     --------------------------------------------------------------------------- */

  /** Account name when `url` is the user's own saved listing, else null. */
  function savedListingAccount(url) {
    const match = SAVED_URL.exec(String(url || ""));
    return match ? match[1] : null;
  }

  /** Resolve a "next" href against the current page; accept same-origin saved pages only. */
  function resolveNextUrl(href, baseUrl, account) {
    if (!href) return null;
    let next;
    try {
      next = new URL(href, baseUrl);
    } catch {
      return null;
    }
    if (next.origin !== "https://old.reddit.com") return null;
    const owner = savedListingAccount(next.href);
    if (!owner || (account && owner.toLowerCase() !== String(account).toLowerCase())) return null;
    return next.href;
  }

  const isPostFullname = (fullname) => /^t3_[a-z0-9]+$/i.test(String(fullname || ""));

  /* ---------------------------------------------------------------------------
     Row classification
     --------------------------------------------------------------------------- */

  /**
   * NSFW marker. Old Reddit tags an over-18 row with the `over18` class and
   * `data-nsfw="true"`. Either one counts.
   */
  function isNsfwRow(raw) {
    const classes = String(raw.className || "").split(/\s+/);
    if (classes.includes("over18")) return true;
    return String(raw.nsfw || "").toLowerCase() === "true";
  }

  /**
   * Decide what a row is. Returns one of:
   *   "nsfw-post" – keep
   *   "sfw-post"  – count only
   *   "comment"   – skip
   *   "other"     – not a recognisable thing (ads, stubs)
   */
  function classifyRow(raw) {
    const fullname = String(raw.fullname || "");
    if (fullname.startsWith("t1_")) return "comment";
    if (!isPostFullname(fullname)) return "other";
    return isNsfwRow(raw) ? "nsfw-post" : "sfw-post";
  }

  /* ---------------------------------------------------------------------------
     Normalization
     --------------------------------------------------------------------------- */

  const clean = (value, max) => {
    const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    return max && text.length > max ? text.slice(0, max - 1) + "…" : text;
  };

  const toInt = (value) => {
    const number = parseInt(String(value == null ? "" : value).replace(/[^0-9-]/g, ""), 10);
    return Number.isFinite(number) ? number : null;
  };

  function toIso(timestampMs) {
    const ms = Number(timestampMs);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function hostOf(value) {
    try {
      return new URL(String(value || "")).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  function absolutePermalink(path) {
    const text = String(path || "");
    if (!text) return null;
    if (/^https?:\/\//i.test(text)) return text;
    return "https://www.reddit.com" + (text.startsWith("/") ? text : "/" + text);
  }

  /**
   * Media for the three shapes we keep. URL only, nothing downloaded:
   *   image   – i.redd.it
   *   video   – v.redd.it (the bare URL; DASH/HLS resolution is left to the viewer)
   *   gallery – reddit gallery (points at the post permalink, which lists the items)
   */
  function classifyMedia(raw) {
    const url = String(raw.url || "");
    const host = hostOf(url) || hostOf(raw.domain ? "https://" + raw.domain : "");
    const isGallery = String(raw.isGallery || "").toLowerCase() === "true" || /\/gallery\//.test(url);
    if (isGallery) {
      return [{ kind: "gallery", url: absolutePermalink(raw.permalink) }];
    }
    if (host === "i.redd.it") return [{ kind: "image", url }];
    if (host === "v.redd.it") return [{ kind: "video", url }];
    return [];
  }

  /**
   * Build the stored record for a row already classified as "nsfw-post".
   * Returns null if the row is not an NSFW post.
   */
  function normalizePost(raw, capturedAt) {
    if (classifyRow(raw) !== "nsfw-post") return null;
    const fullname = String(raw.fullname);
    const subreddit = clean(raw.subreddit, 120).replace(/^r\//i, "");
    const thumbnail = clean(raw.thumbnail, 2000);
    return {
      id: fullname.slice(3),
      fullname,
      title: clean(raw.title, 400),
      subreddit,
      author: clean(raw.author, 60) || null,
      permalink: absolutePermalink(raw.permalink),
      url: clean(raw.url, 2000) || null,
      domain: clean(raw.domain, 200) || null,
      score: toInt(raw.score),
      comments: toInt(raw.comments),
      created_at: toIso(raw.timestamp),
      nsfw: true,
      thumbnail: /^https?:\/\//i.test(thumbnail) ? thumbnail : null,
      media: classifyMedia(raw),
      captured_at: capturedAt,
    };
  }

  /**
   * Process one page of rows. Returns the NSFW posts plus counts, so the caller
   * can keep a running tally across pages.
   */
  function processRows(rows, capturedAt) {
    const counts = { rows: 0, nsfwKept: 0, sfwSkipped: 0, commentsSkipped: 0, otherSkipped: 0 };
    const posts = [];
    for (const raw of rows || []) {
      counts.rows++;
      const kind = classifyRow(raw);
      if (kind === "nsfw-post") {
        const post = normalizePost(raw, capturedAt);
        if (post) {
          posts.push(post);
          counts.nsfwKept++;
        }
      } else if (kind === "sfw-post") counts.sfwSkipped++;
      else if (kind === "comment") counts.commentsSkipped++;
      else counts.otherSkipped++;
    }
    return { posts, counts };
  }

  /** Drop posts whose id is already in `knownIds` (or repeated within the batch). */
  function dedupe(posts, knownIds) {
    const seen = new Set(knownIds || []);
    const fresh = [];
    for (const post of posts || []) {
      if (!post || !post.id || seen.has(post.id)) continue;
      seen.add(post.id);
      fresh.push(post);
    }
    return fresh;
  }

  /* ---------------------------------------------------------------------------
     Pacing
     --------------------------------------------------------------------------- */

  /**
   * Pacer for page-to-page gaps. `rng` returns [0,1). Every 8–14 pages a longer
   * wave break is inserted so the cadence never becomes machine-regular.
   */
  function createPacer(options = {}) {
    const cfg = { ...DEFAULT_PACING, ...options };
    const rng = typeof options.rng === "function" ? options.rng : Math.random;
    const between = (lo, hi) => lo + (hi - lo) * rng();
    let pagesSinceWave = 0;
    let nextWaveAt = cfg.waveMinPages + Math.floor(rng() * (cfg.waveMaxPages - cfg.waveMinPages + 1));

    return {
      /** Call once per page fetched. Returns { ms, wave } for the gap that follows. */
      nextGap() {
        pagesSinceWave++;
        if (pagesSinceWave >= nextWaveAt) {
          pagesSinceWave = 0;
          nextWaveAt = cfg.waveMinPages + Math.floor(rng() * (cfg.waveMaxPages - cfg.waveMinPages + 1));
          return { ms: Math.round(between(cfg.waveMinMs, cfg.waveMaxMs)), wave: true };
        }
        return { ms: Math.round(between(cfg.minDelayMs, cfg.maxDelayMs)), wave: false };
      },
    };
  }

  /** Exponential backoff with jitter for retry attempt n (0-based). */
  function computeBackoff(attempt, options = {}) {
    const cfg = { ...DEFAULT_PACING, ...options };
    const rng = typeof options.rng === "function" ? options.rng : Math.random;
    const ceiling = Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * Math.pow(2, Math.max(0, attempt)));
    return Math.round(ceiling * (0.5 + 0.5 * rng()));
  }

  /** Map an HTTP status to what the loop should do next. */
  function classifyStatus(status) {
    if (status >= 200 && status < 300) return "ok";
    if (status === 429 || status >= 500) return "retry";
    return "fatal"; // 401/403/404 and anything else: stop rather than hammer
  }

  /* ---------------------------------------------------------------------------
     Store: 256-item chunks in an injected storage area
     (area = chrome.storage.local, or any object with get/set/remove returning promises)
     --------------------------------------------------------------------------- */

  const chunkKey = (index) => CHUNK_PREFIX + String(index).padStart(6, "0");

  function createStore(area) {
    let meta = null;
    let knownIds = null;

    async function readMeta() {
      const got = await area.get([META_KEY]);
      const stored = got && got[META_KEY];
      meta = stored && typeof stored === "object"
        ? { version: EXPORT_VERSION, account: stored.account || null, count: stored.count || 0, chunks: stored.chunks || 0 }
        : { version: EXPORT_VERSION, account: null, count: 0, chunks: 0 };
      return meta;
    }

    async function readChunks(count) {
      if (!count) return [];
      const keys = Array.from({ length: count }, (_, i) => chunkKey(i));
      const got = await area.get(keys);
      return keys.map((key) => (got && Array.isArray(got[key]) ? got[key] : []));
    }

    async function load() {
      await readMeta();
      const chunks = await readChunks(meta.chunks);
      knownIds = new Set();
      for (const chunk of chunks) for (const post of chunk) if (post && post.id) knownIds.add(post.id);
      return { ...meta };
    }

    return {
      /** Load meta and every stored id once. append() calls this on demand. */
      load,

      /** Account the stored data belongs to (null when the store is empty). */
      account() {
        return meta ? meta.account : null;
      },

      count() {
        return meta ? meta.count : 0;
      },

      /**
       * Append posts that are not already stored. Only the tail chunk is read,
       * then changed chunks and meta go out in one set() call. Returns the
       * number of posts actually added.
       */
      async append(posts, { account } = {}) {
        if (!meta || !knownIds) await load();
        const fresh = dedupe(posts, knownIds);
        if (!fresh.length) return 0;

        const nextMeta = { ...meta, account: meta.account || account || null };
        let index = 0;
        let tail = [];
        if (meta.chunks > 0) {
          index = meta.chunks - 1;
          const got = await area.get([chunkKey(index)]);
          const stored = got && got[chunkKey(index)];
          tail = Array.isArray(stored) ? stored.slice() : [];
          if (tail.length >= CHUNK_SIZE) {
            index++;
            tail = [];
          }
        }

        const write = {};
        for (const post of fresh) {
          if (tail.length >= CHUNK_SIZE) {
            write[chunkKey(index)] = tail;
            index++;
            tail = [];
          }
          tail.push(post);
          knownIds.add(post.id);
        }
        write[chunkKey(index)] = tail;

        nextMeta.chunks = index + 1;
        nextMeta.count = meta.count + fresh.length;
        write[META_KEY] = nextMeta;
        await area.set(write);
        meta = nextMeta;
        return fresh.length;
      },

      /** Every stored post, in capture order. */
      async readAll() {
        const current = await readMeta();
        const chunks = await readChunks(current.chunks);
        return chunks.flat();
      },

      /** Remove all stored posts and the meta record. */
      async clear() {
        const current = await readMeta();
        const keys = Array.from({ length: current.chunks }, (_, i) => chunkKey(i));
        keys.push(META_KEY);
        await area.remove(keys);
        meta = null;
        knownIds = null;
      },
    };
  }

  /* ---------------------------------------------------------------------------
     Export
     --------------------------------------------------------------------------- */

  /** The JSON envelope written to reddit-nsfw-saved.json. */
  function buildExport({ posts, account, exportedAt, scan }) {
    const list = Array.isArray(posts) ? posts : [];
    const counts = scan || {};
    return {
      export_version: EXPORT_VERSION,
      exported_at: exportedAt || new Date().toISOString(),
      source: SOURCE,
      account: account || null,
      count: list.length,
      scan: {
        pages: counts.pages || 0,
        rows: counts.rows || 0,
        nsfw_kept: counts.nsfwKept || 0,
        sfw_skipped: counts.sfwSkipped || 0,
        comments_skipped: counts.commentsSkipped || 0,
      },
      posts: list,
    };
  }

  return {
    EXPORT_VERSION,
    SOURCE,
    CHUNK_SIZE,
    META_KEY,
    STATE_KEY,
    CHUNK_PREFIX,
    FILE_NAME,
    DEFAULT_PACING,
    savedListingAccount,
    resolveNextUrl,
    isPostFullname,
    isNsfwRow,
    classifyRow,
    classifyMedia,
    normalizePost,
    processRows,
    dedupe,
    createPacer,
    computeBackoff,
    classifyStatus,
    chunkKey,
    createStore,
    buildExport,
  };
});
