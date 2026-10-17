/* app.media — URL policy for stills (thumbnails, posters, avatars) on top of the
   MediaResolver port, plus a tiny shared IntersectionObserver for lazy loading
   and a download helper. Players use app.playback; this is for <img>. */
XR.define("app.media", ["app.ports.mediaResolver", "app.ports.platform", "app.prefs"], function (resolver, platform, prefs) {
  "use strict";

  /** Pick a thumbnail size name from a rendered width in CSS px. */
  function sizeFor(widthPx) {
    const dpr = Math.min(2, platform.dpr());
    const w = widthPx * dpr;
    if (w <= 240) return "small";
    if (w <= 700) return "medium";
    return "large";
  }
  const thumb = (media, widthPx = 320) => resolver.thumb(media, sizeFor(widthPx), { localDir: prefs.get("localMediaDir") });
  const poster = (media, widthPx = 720) => resolver.poster(media, sizeFor(widthPx), { localDir: prefs.get("localMediaDir") });
  const full = (media) => resolver.full(media, { localDir: prefs.get("localMediaDir") });
  const avatar = (post, px = 48) => resolver.avatar(post.author.avatar, px * Math.min(2, platform.dpr()));
  const downloadUrl = (media) => resolver.download(media);

  /* Shared lazy loader: elements with data-src get their src when near the viewport. */
  let io = null;
  function observer() {
    if (io || typeof IntersectionObserver === "undefined") return io;
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target;
        io.unobserve(el);
        const src = el.dataset.src;
        if (src) { el.src = src; delete el.dataset.src; }
        if (el.dataset.srcset) { el.srcset = el.dataset.srcset; delete el.dataset.srcset; }
      }
    }, { rootMargin: "600px 0px" });
    return io;
  }
  function lazy(img, src) {
    if (!src) return img;
    const o = observer();
    if (!o) { img.src = src; return img; }
    img.dataset.src = src;
    o.observe(img);
    return img;
  }
  function unlazy(img) { if (io) io.unobserve(img); }

  /** Open the best source in a new tab (browsers block cross-origin forced downloads). */
  function open(media) { const url = downloadUrl(media); if (url) platform.openExternal(url); }

  return { thumb, poster, full, avatar, downloadUrl, lazy, unlazy, open, sizeFor };
});
