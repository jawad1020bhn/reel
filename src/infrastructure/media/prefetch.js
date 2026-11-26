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
  const jobs = new Map();
  const queue = [];
  let running = 0;
  const mayWarm = () => {
    const connection = typeof navigator !== "undefined" && navigator.connection;
    return enabled && !(typeof document !== "undefined" && document.hidden) && !(typeof navigator !== "undefined" && navigator.onLine === false) &&
      !connection?.saveData && !["slow-2g", "2g", "3g"].includes(connection?.effectiveType);
  };
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
      pending: running,
      queued: queue.length,
      hitRate: hits + misses ? hits / (hits + misses) : 0,
    };
  }

  /**
   * Download a clip into the cache. Returns the blob URL when it lands (or immediately if
   * it is already cached), null when it cannot be cached (too big, HLS, offline, aborted).
   * Internal: the scheduler owns deduplication and concurrency.
   */
  function download(url, { type = "video/mp4", expectedBytes = 0 }, controller) {
    if (!mayWarm() || !isMediaUrl(url)) return Promise.resolve(null);
    const hit = touch(url);
    if (hit) return Promise.resolve(hit.url);
    /* The caller may know the expected weight (bitrate × duration in warmAhead), in which
       case a clip that can never fit is refused before it costs a request. The authoritative
       check is still the response's own size, below. */
    if (expectedBytes > MAX_ENTRY_BYTES) return Promise.resolve(null);
    const job = fetch(url, { mode: "cors", credentials: "omit", cache: "force-cache", signal: controller.signal, priority: "low" })
      .then(async (res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        const length = Number(res.headers.get("content-length")) || 0;
        if (length > MAX_ENTRY_BYTES) { controller.abort(); throw new Error("too large"); }
        // Bound unknown-length responses too: res.blob() would first buffer the
        // entire download before discovering that it exceeds the mobile budget.
        let blob;
        if (res.body?.getReader) {
          const reader = res.body.getReader();
          const chunks = [];
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_ENTRY_BYTES) { controller.abort(); await reader.cancel(); throw new Error("too large"); }
            chunks.push(value);
          }
          blob = new Blob(chunks, { type: res.headers.get("content-type") || type });
        } else blob = await res.blob();
        if (controller.signal.aborted || !mayWarm()) return null;
        if (blob.size > MAX_ENTRY_BYTES) throw new Error("too large");
        if (!blob.size) throw new Error("empty");
        evictToFit(blob.size);
        const objectUrl = URL.createObjectURL(blob);
        entries.set(url, { blob, url: objectUrl, size: blob.size, type: type || blob.type || "video/mp4", at: Date.now() });
        bytes += blob.size;
        warmed++; warmedBytes += blob.size;
        return objectUrl;
      })
      .catch(() => null);
    return job;
  }

  /* Every speculative path shares this scheduler, including warmAhead. A URL
     has one job/promise, so neighbours and a playing clip never download it twice. */
  function finish(job, value) {
    if (jobs.get(job.url) === job) jobs.delete(job.url);
    job.resolve(value);
  }
  function pump() {
    while (running < WARM_PARALLEL && queue.length) {
      const job = queue.shift();
      if (!mayWarm()) { finish(job, null); continue; }
      job.started = true;
      running++;
      download(job.url, job.opts, job.controller).then((value) => finish(job, value)).finally(() => { running--; pump(); });
    }
  }
  /** priority 0 = imminent clip, 1 = later. Duplicate callers join the same job. */
  function prefetch(url, opts = {}, { priority = 1 } = {}) {
    if (!mayWarm() || !isMediaUrl(url)) return Promise.resolve(null);
    const cached = touch(url);
    if (cached) return Promise.resolve(cached.url);
    const existing = jobs.get(url);
    if (existing) {
      if (!existing.started && priority === 0) {
        queue.splice(queue.indexOf(existing), 1); queue.unshift(existing);
      }
      return existing.promise;
    }
    if (opts.expectedBytes > MAX_ENTRY_BYTES) return Promise.resolve(null);
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const job = { url, opts, resolve, promise, controller: new AbortController(), started: false };
    jobs.set(url, job);
    if (priority === 0) queue.unshift(job); else queue.push(job);
    if (queue.length > 8) finish(queue.pop(), null);
    pump();
    return promise;
  }
  const warm = (url, opts = {}) => prefetch(url, opts);

  /** Cancel obsolete speculative work, retaining already-cached media for back swipes.
      Slots are released only when aborted fetches settle, so rapid swipes cannot
      exceed the concurrency cap. Identity checks protect replacement jobs. */
  function retain(urls = []) {
    const keep = new Set(urls);
    for (const [url, job] of jobs) {
      if (keep.has(url)) continue;
      if (!job.started) queue.splice(queue.indexOf(job), 1);
      job.controller.abort();
      finish(job, null);
    }
  }

  /* --------------------------------------------------------- warm-ahead -- */
  /* While a clip plays, fetch the rest of it in the background. This is what makes
     dragging the playhead anywhere a local operation instead of a fresh range request.
     A duration ceiling keeps us from downloading a 40-minute video "just in case"; the
     byte ceiling inside warm() catches heavy clips that slip under it. */
  const AHEAD_MAX_SECONDS = 8 * 60;
  function warmAhead(video, url, { duration = 0, bitrate = 0 } = {}) {
    if (!mayWarm() || !isMediaUrl(url)) return;
    if (duration > AHEAD_MAX_SECONDS) return;             // long form streams natively
    if (entries.has(url)) return;
    /* bits per second × seconds ÷ 8, when both are known: refuse an obviously oversized
       clip up front instead of buffering 40 MB and then throwing it away. */
    const expectedBytes = duration && bitrate ? (bitrate * duration) / 8 : 0;
    prefetch(url, { type: "video/mp4", expectedBytes }, { priority: 0 });
  }

  /** Forget everything (Settings → clear cached media, and before a hard reload). */
  function clear() {
    for (const [, e] of entries) { try { URL.revokeObjectURL(e.url); } catch { /* ignore */ } }
    entries.clear();
    bytes = 0;
    retain([]);
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) clear();
  }

  return { blobUrl, warm, prefetch, warmAhead, has, stats, clear, retain, setEnabled, get enabled() { return enabled; }, MAX_ENTRY_BYTES };
});
