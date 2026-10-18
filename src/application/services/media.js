/* app.media — URL policy for stills (thumbnails, posters, avatars) on top of the
   MediaResolver port, the data budget every surface consults before it spends bytes,
   a lazy loader that understands nested scrollers, and a tiny prefetcher.
   Players use app.playback; this is for <img>.

   Sizing: callers pass the CSS box a still is drawn in; the resolver gets the device
   pixels its longest side needs and answers with the smallest rendition that covers
   it (a 260px tile gets a 360px still, not a 1200px one). */
XR.define("app.media", ["app.ports.mediaResolver", "app.ports.platform", "app.ports.storage", "app.prefs"], function (resolver, platform, storage, prefs) {
  "use strict";
  const DPR_MAX = 2;
  /* a rendition ~10% under the box is invisible and often saves a whole size step */
  const SLACK = 0.9;

  const aspectOf = (m) => (m && (m.aspect > 0 ? m.aspect : m.width > 0 && m.height > 0 ? m.width / m.height : 0)) || 1;
  const local = () => ({ localDir: prefs.get("localMediaDir") });
  const screenW = () => (typeof innerWidth !== "undefined" ? innerWidth : 1280);
  const screenH = () => (typeof innerHeight !== "undefined" ? innerHeight : 800);

  /**
   * Device px the longest side of a still needs to fill a w×h CSS box without upscaling.
   * fit "cover" fills the box (tiles, heroes), "contain" letterboxes (players, viewer).
   * Without h the box takes the media's own shape.
   */
  function needPx(media, w, h, fit = "cover") {
    const dpr = Math.min(DPR_MAX, platform.dpr());
    const a = aspectOf(media);
    const bw = Math.max(1, w) * dpr, bh = Math.max(1, h || w / a) * dpr;
    /* renditions fit inside N×N: width = N·min(1,a), height = N·min(1,1/a) */
    const byW = bw / Math.min(1, a), byH = bh / Math.min(1, 1 / a);
    return Math.round((fit === "contain" ? Math.min(byW, byH) : Math.max(byW, byH)) * SLACK);
  }
  /** Rendition name for a rendered width in CSS px (kept for callers that want a name). */
  function sizeFor(widthPx) {
    const w = widthPx * Math.min(DPR_MAX, platform.dpr());
    return w <= 680 ? "small" : w <= 1200 ? "medium" : "large";
  }

  /* The last thumbnail URL handed out per media: the tile that was just clicked already
     holds those pixels, so the Watch/Viewer can paint them instantly (memory cache) and
     use them for blurred backdrops instead of fetching yet another size. */
  const recent = new Map();
  const RECENT_MAX = 800;
  function remember(media, url) {
    if (!media || !media.id || !url) return url;
    recent.delete(media.id);
    recent.set(media.id, url);
    if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
    return url;
  }

  const thumb = (media, w = 320, h, fit) => remember(media, resolver.thumb(media, needPx(media, w, h, fit), local()));
  /** `max` caps the device px: a poster under a video that is about to play never needs
      to be sharper than the rung replacing it (≤ 720p) — 1200 covers that. */
  const poster = (media, w = 720, h, fit, max = Infinity) => resolver.poster(media, Math.min(max, needPx(media, w, h, fit)), local());
  /** The full still for a viewer box (defaults to the screen); the local mirror wins. */
  const full = (media, w, h) => resolver.full(media, local(), needPx(media, w || screenW(), h || screenH(), "contain"));
  /** Cheap pixels for backdrops and first paint: what a tile already loaded, else a small still. */
  const placeholder = (media) => (media && recent.get(media.id)) || resolver.thumb(media, needPx(media, 200), local());
  const avatar = (post, px = 48) => resolver.avatar(post.author.avatar, px * Math.min(DPR_MAX, platform.dpr()));
  const downloadUrl = (media) => resolver.download(media);

  /* ------------------------------------------------------------ budget -- */
  /**
   * What the connection and the user allow, asked before spending bytes:
   *   maxBitrate  — video cap in bit/s (0 = only the box limits the rung)
   *   speculative — preloading neighbours / prefetching stills is worth it
   *   trailer     — Discover may stream a muted background trailer (motion prefs are the caller's)
   */
  function budget() {
    const n = platform.network();
    const saver = !!prefs.get("dataSaver") || n.saveData;
    const type = n.effectiveType;
    let maxBitrate = 0;
    if (type === "slow-2g" || type === "2g") maxBitrate = 300_000;
    else if (saver || type === "3g") maxBitrate = 900_000;
    else if (n.downlink > 0 && n.downlink < 10) maxBitrate = Math.max(400_000, n.downlink * 1e6 * 0.6);
    const slow = saver || type === "slow-2g" || type === "2g" || type === "3g";
    return { maxBitrate, saver, speculative: !slow, trailer: !slow };
  }
  /** URL of the rung to stream in a w×h CSS box — for background video (the Discover
      trailer) that does not go through app.playback. Remote rungs only.
      opts: { fit: "cover"|"contain", maxBitrate } (the budget's cap always applies). */
  function videoFor(media, w, h, opts = {}) {
    const cap = [budget().maxBitrate, opts.maxBitrate].filter((b) => b > 0);
    const list = resolver.sources(media, { ...local(), box: { width: w, height: h }, fit: opts.fit || "contain", dpr: platform.dpr(), maxBitrate: cap.length ? Math.min(...cap) : 0 });
    const s = list.find((x) => !x.local);
    return s ? s.url : "";
  }

  /* --------------------------------------------------------- lazy load -- */
  /* An IntersectionObserver rooted at the viewport clips its targets to every scroller in
     between, so inside the outlet (the page scroller) a rootMargin never looked ahead:
     stills only started downloading once they were already on screen. Images are observed
     against their nearest [data-scroll-root] instead, with ¾ of a screen of look-ahead
     (one PageDown; small stills land well before a scroll covers that distance).
     Rails scroll sideways inside it: `scrollMargin` lets the tile just past a shelf's edge
     count as near — but only once the shelf itself is near, so off-screen shelves cost
     nothing. (Engines without scrollMargin ignore it: rail tiles load as they scroll in.) */
  const ROOT_MARGIN = "75% 0px", VIEWPORT_MARGIN = "600px 0px", SCROLL_MARGIN = "0px 120px";
  const rootIO = new WeakMap();      // scroll root element → observer
  const observedBy = new WeakMap();  // img → observer
  let viewportIO = null;
  const pending = new Map();         // img → frames waited for it to be mounted
  let flushing = false;

  function apply(el) {
    /* our observer already decided: native lazy-loading (viewport-based in some engines)
       must not hold the request back again inside the scroller */
    if (el.loading === "lazy") el.loading = "eager";
    const src = el.dataset.src;
    if (src) { el.src = src; delete el.dataset.src; }
    if (el.dataset.srcset) { el.srcset = el.dataset.srcset; delete el.dataset.srcset; }
  }
  function onIntersect(entries, io) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      observedBy.delete(e.target);
      apply(e.target);
    }
  }
  function observerFor(root) {
    if (!root) return viewportIO || (viewportIO = new IntersectionObserver(onIntersect, { rootMargin: VIEWPORT_MARGIN, scrollMargin: SCROLL_MARGIN }));
    let io = rootIO.get(root);
    if (!io) { io = new IntersectionObserver(onIntersect, { root, rootMargin: ROOT_MARGIN, scrollMargin: SCROLL_MARGIN }); rootIO.set(root, io); }
    return io;
  }
  /* images are created before they are mounted: find their scroller once they are */
  function flush() {
    flushing = false;
    for (const [img, frames] of pending) {
      if (!img.dataset.src) { pending.delete(img); continue; }
      if (!img.isConnected && frames < 60) { pending.set(img, frames + 1); continue; }
      pending.delete(img);
      const io = observerFor(img.isConnected ? img.closest("[data-scroll-root]") : null);
      observedBy.set(img, io);
      io.observe(img);
    }
    if (pending.size && !flushing) { flushing = true; requestAnimationFrame(flush); }
  }
  function lazy(img, src) {
    if (!src) return img;
    if (typeof IntersectionObserver === "undefined" || typeof requestAnimationFrame === "undefined") { img.src = src; return img; }
    img.dataset.src = src;
    pending.set(img, 0);
    if (!flushing) { flushing = true; queueMicrotask(flush); }
    return img;
  }
  /** Stop watching an image; `abort` also cancels a download still in flight (an unmounted tile). */
  function unlazy(img, abort = false) {
    pending.delete(img);
    const io = observedBy.get(img);
    if (io) { io.unobserve(img); observedBy.delete(img); }
    /* removing src (not setting "") cancels the request without firing `error` */
    if (abort && img.getAttribute("src") && !img.complete) img.removeAttribute("src");
  }

  /* ---------------------------------------------------------- prefetch -- */
  /* Warm the next stills while the user looks at the current one. The Image objects are
     kept (bounded) so the decoded pixels are not dropped before they are needed. */
  const warmed = new Map();
  function prefetch(urls) {
    if (!budget().speculative || typeof Image === "undefined") return;
    for (const url of urls) {
      if (!url || warmed.has(url)) continue;
      const img = new Image();
      img.decoding = "async";
      try { img.fetchPriority = "low"; } catch { /* older engines */ }
      img.src = url;
      warmed.set(url, img);
      if (warmed.size > 24) warmed.delete(warmed.keys().next().value);
    }
  }

  /* ------------------------------------------------- connection warm-up -- */
  /* DNS + TLS to a CDN costs 100–500 ms before the first byte. The origins this library's
     media lives on are remembered, so the next launch opens those connections while it is
     still reading storage and parsing the library — nothing is contacted that the library
     itself would not load anyway. */
  const ORIGINS_KEY = "xreels.mediaOrigins.v1";
  function warmUp() {
    Promise.resolve(storage.get(ORIGINS_KEY)).then((list) => {
      if (Array.isArray(list)) for (const o of list.slice(0, 3)) platform.preconnect(o);
    }, () => {});
  }
  function learnOrigins(posts) {
    const count = new Map();
    for (const p of (posts || []).slice(0, 400)) {
      for (const m of p.media || []) {
        for (const u of [m.thumb || m.poster, m.sources && m.sources[0] && m.sources[0].url]) {
          const o = /^https:\/\/[^/?#]+/.exec(u || "");
          if (o) count.set(o[0], (count.get(o[0]) || 0) + 1);
        }
      }
    }
    const top = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([o]) => o);
    for (const o of top) platform.preconnect(o);
    Promise.resolve(storage.set(ORIGINS_KEY, top)).catch(() => {});
  }

  /** Open the best source in a new tab (browsers block cross-origin forced downloads). */
  function open(media) { const url = downloadUrl(media); if (url) platform.openExternal(url); }

  return { thumb, poster, full, placeholder, avatar, downloadUrl, lazy, unlazy, prefetch, budget, videoFor, warmUp, learnOrigins, open, sizeFor, needPx };
});
