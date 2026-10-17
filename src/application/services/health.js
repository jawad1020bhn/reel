/* app.health — "Check media availability": probes each post's poster/thumbnail against X's
   CDN (Image loads, no CORS needed) with limited concurrency, marks dead posts in
   app.activity (unavailable) and reports a summary. Cancellable; emits DATASET_PROGRESS
   with phase "health" so any screen can show progress. */
XR.define("app.health", ["app.catalog", "app.activity", "app.media", "core.events", "core.domain.events"], function (catalog, activity, media, events, EV) {
  "use strict";
  let running = null;

  function probe(url, timeoutMs = 12000) {
    return new Promise((resolve) => {
      if (!url) return resolve(false);
      const img = new Image();
      const t = setTimeout(() => { img.src = ""; resolve(null); }, timeoutMs);   // null = unknown (timeout)
      img.onload = () => { clearTimeout(t); resolve(true); };
      img.onerror = () => { clearTimeout(t); resolve(false); };
      img.referrerPolicy = "no-referrer";
      img.src = url;
    });
  }

  /**
   * @param {{ids?: string[], concurrency?: number, onProgress?: (done:number,total:number,dead:number)=>void}} opts
   * @returns {Promise<{checked:number, dead:string[], unknown:string[], cancelled:boolean}>}
   */
  function run(opts = {}) {
    if (running) return running.promise;
    const posts = (opts.ids ? catalog.postsByIds(opts.ids) : catalog.posts).filter((p) => p.media.length);
    const concurrency = opts.concurrency || 6;
    const dead = [], unknown = [];
    let done = 0, cancelled = false, cursor = 0;
    const report = () => { opts.onProgress?.(done, posts.length, dead.length); events.bus.emit(EV.DATASET_PROGRESS, { phase: "health", message: `Checked ${done}/${posts.length} · ${dead.length} unavailable`, progress: posts.length ? done / posts.length : 1 }); };
    async function worker() {
      while (!cancelled && cursor < posts.length) {
        const p = posts[cursor++];
        const m = p.media[0];
        const ok = await probe(media.thumb(m, 160));
        if (ok === false) dead.push(p.id); else if (ok === null) unknown.push(p.id);
        done++;
        if (done % 10 === 0 || done === posts.length) report();
      }
    }
    const promise = Promise.all(Array.from({ length: Math.min(concurrency, posts.length) }, worker)).then(() => {
      if (dead.length) activity.markUnavailable(dead, true);
      /* posts that were marked before but load again are cleared */
      const revived = activity.unavailableIds().filter((id) => catalog.post(id) && !dead.includes(id) && !unknown.includes(id) && posts.some((p) => p.id === id));
      if (revived.length) activity.markUnavailable(revived, false);
      running = null;
      events.bus.emit(EV.DATASET_PROGRESS, { phase: "health-done", message: `${dead.length} unavailable of ${posts.length}`, progress: 1 });
      return { checked: done, dead, unknown, cancelled };
    });
    running = { promise, cancel: () => { cancelled = true; } };
    return promise;
  }
  const cancel = () => running?.cancel();
  const isRunning = () => !!running;
  return { run, cancel, isRunning, probe };
});
