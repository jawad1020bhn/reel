/* infra.media.twimg — MediaResolverPort for X's CDNs (+ optional local folder).

   pbs.twimg.com/media/<id>.jpg      → ?format=jpg&name=small|medium|large|orig   (360 / 1200 / 2048 / original)
   pbs.twimg.com/…/_video_thumb/…    → ?name=small|medium|large
   pbs.twimg.com/profile_images/…    → _normal (48) | _bigger (73) | _200x200 | _400x400
   video.twimg.com/…mp4              → as-is (ranged GET works cross-origin; HEAD does not)

   Local media: when opts.localDir is set, stills/videos are first looked up at
   <localDir>/<postId>_<index>.<ext>; the <img>/<video> error handler in the UI falls
   back to the CDN URL, so a partial local mirror is fine. */
XR.define("infra.media.twimg", [], function () {
  "use strict";
  const SIZES = { small: "small", medium: "medium", large: "large", orig: "orig" };
  const PBS = /^https?:\/\/pbs\.twimg\.com\//;

  function sized(url, size) {
    if (!url) return "";
    if (!PBS.test(url)) return url;
    const m = url.match(/^(.*?)(?:\.(jpg|jpeg|png|gif|webp))?(?:\?.*)?$/i);
    if (!m) return url;
    const base = m[1];
    const format = (m[2] || "jpg").toLowerCase() === "jpeg" ? "jpg" : (m[2] || "jpg").toLowerCase();
    if (/_video_thumb\/|tweet_video_thumb\//.test(base)) return `${base}.${format}?name=${SIZES[size] || "medium"}`;
    return `${base}?format=${format}&name=${SIZES[size] || "medium"}`;
  }
  function avatar(url, px = 96) {
    if (!url) return "";
    const want = px <= 48 ? "_normal" : px <= 96 ? "_bigger" : px <= 200 ? "_200x200" : "_400x400";
    return url.replace(/_(normal|bigger|mini|200x200|400x400)(\.\w+)$/, `${want}$2`);
  }
  function ext(url, fallback) { const m = String(url || "").match(/\.(\w{3,4})(?:\?|$)/); return m ? m[1].toLowerCase() : fallback; }
  function local(media, opts, kind) {
    const dir = opts?.localDir; if (!dir) return "";
    const e = kind === "video" ? "mp4" : ext(media.thumb, "jpg");
    return `${dir.replace(/\/+$/, "")}/${media.postId}_${media.index + 1}.${e}`;
  }

  const api = {
    thumb: (media, size = "small", opts) => sized(media.thumb || media.poster, size),
    poster: (media, size = "medium", opts) => sized(media.poster || media.thumb, size),
    full: (media, opts) => local(media, opts, "photo") || sized(media.thumb || media.poster, "large"),
    original: (media) => sized(media.thumb || media.poster, "orig"),
    avatar,
    /** Best-first list the player should try. Local file (if configured) goes first. */
    sources(media, opts) {
      const list = [];
      const l = local(media, opts, "video");
      if (l) list.push({ url: l, type: "video/mp4", bitrate: 0, local: true });
      for (const s of media.sources || []) list.push(s);
      return list;
    },
    hls: (media) => media.hls || "",
    download(media) {
      if (media.kind === "photo") return sized(media.thumb, "orig");
      const best = (media.sources || []).filter((s) => /mp4/.test(s.type || s.url)).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      return best?.url || media.hls || "";
    },
    canHls: () => typeof window !== "undefined" && !!window.Hls && window.Hls.isSupported(),
    sized,
  };
  return api;
});
