/* infra.media.twimg — MediaResolverPort for X's CDNs (+ optional local folder).

   pbs.twimg.com/media/<id>.jpg      → ?format=webp|jpg&name=240x240|360x360|small|900x900|medium|large|orig
                                        (fit inside 240 / 360 / 680 / 900 / 1200 / 2048 px; orig = as uploaded)
   pbs.twimg.com/…/_video_thumb/…    → ?name=small|medium|large   (680 / 1200 / 2048)
   pbs.twimg.com/profile_images/…    → _normal (48) | _bigger (73) | _200x200 | _400x400
   video.twimg.com/…mp4              → as-is (ranged GET works cross-origin; HEAD does not)

   Sizes can be asked for by name (\"small\", \"large\", …) or by the number of device
   pixels the longest side needs: the smallest rendition that covers it is returned, so a
   260px tile no longer downloads a 1200px still. /media/ stills come as WebP when the
   browser decodes it (same pixels, ~30% fewer bytes); `orig` keeps the stored format.

   Video: sources(media, { box, fit, dpr, maxBitrate }) orders the MP4 ladder for the box
   the <video> is drawn in — the smallest rung that is sharp at that size and fits the
   bitrate budget first, then smaller rungs, then larger ones (the failure ladder).

   Local media: when opts.localDir is set, stills/videos are first looked up at
   <localDir>/<postId>_<index>.<ext>; the <img>/<video> error handler in the UI falls
   back to the CDN URL, so a partial local mirror is fine. */
XR.define("infra.media.twimg", [], function () {
  "use strict";
  const PBS = /^https?:\/\/pbs\.twimg\.com\//;
  /* renditions per URL family: [longest side px, name], ascending */
  const PHOTO_LADDER = [[240, "240x240"], [360, "360x360"], [680, "small"], [900, "900x900"], [1200, "medium"], [2048, "large"]];
  const THUMB_LADDER = [[680, "small"], [1200, "medium"], [2048, "large"]];
  const NAMED = { small: 680, medium: 1200, large: 2048 };

  /* WebP decode support, probed once with a 1×1 image (all current engines pass; the
     probe only protects old Safari). Until it answers, URLs keep their stored format. */
  let webp = false;
  try {
    if (typeof Image !== "undefined") {
      const probe = new Image();
      probe.onload = () => { webp = probe.width === 1; };
      probe.src = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
    }
  } catch { /* no DOM (tests) */ }

  /** Smallest rendition name whose longest side covers `px` (a name passes through). */
  function nameFor(size, ladder) {
    if (size === "orig") return "orig";
    const px = typeof size === "number" ? size : NAMED[size] || 1200;
    for (const [max, name] of ladder) if (px <= max) return name;
    return ladder[ladder.length - 1][1];
  }

  function sized(url, size) {
    if (!url) return "";
    if (!PBS.test(url)) return url;
    const m = url.match(/^(.*?)(?:\.(jpg|jpeg|png|gif|webp))?(?:\?.*)?$/i);
    if (!m) return url;
    const base = m[1];
    const given = (m[2] || (/[?&]format=(jpg|jpeg|png|gif|webp)\b/i.exec(url) || [])[1] || "jpg").toLowerCase();
    const stored = given === "jpeg" ? "jpg" : given;
    if (/_video_thumb\/|tweet_video_thumb\//.test(base)) return `${base}.${stored}?name=${nameFor(size, THUMB_LADDER)}`;
    const isPhoto = /\/media\//.test(base);
    const name = nameFor(size, isPhoto ? PHOTO_LADDER : THUMB_LADDER);
    const format = isPhoto && webp && name !== "orig" ? "webp" : stored;
    return `${base}?format=${format}&name=${name}`;
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

  /* ------------------------------------------------------------ video -- */
  /** Pixel size of a rung: X puts it in the path (/vid/1280x720/, /vid/avc1/720x1280/);
      otherwise estimate the short side from the bitrate and keep the clip's shape. */
  function rungSize(s, media) {
    const m = /\/(\d{2,4})x(\d{2,4})\//.exec(s.url || "");
    if (m) return { w: +m[1], h: +m[2] };
    const b = s.bitrate || 0;
    if (!b) return null;
    const a = media.aspect || (media.width > 0 && media.height > 0 ? media.width / media.height : 16 / 9);
    /* X's ladders: 256k → 480×270 | 320×568, 832k → 640×360 | 480×852, 2176k → 720p, above → 1080p */
    const short = b <= 400e3 ? (a >= 1 ? 270 : 320) : b <= 1.2e6 ? (a >= 1 ? 360 : 480) : b <= 3e6 ? 720 : 1080;
    return a >= 1 ? { w: Math.round(short * a), h: short } : { w: short, h: Math.round(short / a) };
  }
  /** Order remote MP4 rungs for a w×h CSS box at `dpr` (fit: contain|cover), under `maxBitrate`. */
  function rank(list, media, opts) {
    const box = opts?.box;
    const cap = opts?.maxBitrate > 0 ? opts.maxBitrate : Infinity;
    if (list.length < 2 || (!(box?.width > 0 && box?.height > 0) && cap === Infinity)) return list;
    const rungs = list.map((s) => ({ s, d: rungSize(s, media) }));
    const known = rungs.filter((r) => r.d).sort((a, b) => a.d.w * a.d.h - b.d.w * b.d.h || (a.s.bitrate || 0) - (b.s.bitrate || 0));
    if (known.length < 2) return list;
    /* video is judged at ≤ 1.5× density: upscaling is far less visible in motion than on a
       still, and a phone held at arm's length does not resolve 1080p in a 390px column */
    const dpr = Math.max(1, Math.min(opts.dpr || 1, 1.5));
    /* displayed width in device px is the same for every rung (same shape); 15% slack
       because a slightly upscaled rung is invisible in motion and saves a whole step */
    const scale = opts.fit === "cover" ? Math.max : Math.min;   // cover fills the box, contain letterboxes
    const shown = (d) => (box?.width > 0 ? d.w * scale(box.width / d.w, box.height / d.h) * dpr : Infinity);
    let pick = known.find((r) => r.d.w >= shown(r.d) * 0.85) || known[known.length - 1];
    if ((pick.s.bitrate || 0) > cap) {
      const under = known.filter((r) => (r.s.bitrate || 0) <= cap);
      pick = under.length ? under[under.length - 1] : known[0];
    }
    const i = known.indexOf(pick);
    return [pick, ...known.slice(0, i).reverse(), ...known.slice(i + 1), ...rungs.filter((r) => !r.d)].map((r) => r.s);
  }

  const api = {
    thumb: (media, size = "small", opts) => sized(media.thumb || media.poster, size),
    poster: (media, size = "medium", opts) => sized(media.poster || media.thumb, size),
    full: (media, opts, size = "large") => local(media, opts, "photo") || sized(media.thumb || media.poster, size),
    original: (media) => sized(media.thumb || media.poster, "orig"),
    avatar,
    /** Try-order for the player: local file (if configured), then the ladder ranked for opts.box. */
    sources(media, opts) {
      const list = [];
      const l = local(media, opts, "video");
      if (l) list.push({ url: l, type: "video/mp4", bitrate: 0, local: true });
      for (const s of rank(media.sources || [], media, opts)) list.push(s);
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
