/* core.adapters.common — helpers shared by the format adapters. */
XR.define("core.adapters.common", ["core.util"], function (util) {
  "use strict";

  /** Build a best-first MP4 ladder (+ HLS last) from assorted variant shapes. */
  function videoSources({ mp4, variants, hls }) {
    const list = [];
    const seen = new Set();
    const push = (url, type, bitrate) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      list.push({ url, type: type || guessType(url), bitrate: util.toNumber(bitrate) });
    };
    const sorted = (variants || [])
      .filter((v) => v && (v.url || v.src))
      .map((v) => ({ url: v.url || v.src, type: v.content_type || v.contentType || v.type || "", bitrate: v.bitrate ?? v.bit_rate ?? 0 }))
      .filter((v) => !/mpegurl/i.test(v.type) && !/\.m3u8/i.test(v.url))
      .sort((a, b) => util.toNumber(b.bitrate) - util.toNumber(a.bitrate));
    if (mp4) push(mp4, "video/mp4", sorted[0]?.bitrate);
    for (const v of sorted) push(v.url, v.type || "video/mp4", v.bitrate);
    const hlsUrl = hls || (variants || []).find((v) => v && /mpegurl|\.m3u8/i.test((v.content_type || v.type || "") + (v.url || "")))?.url;
    return { sources: list, hls: hlsUrl || "" };
  }
  function guessType(url) {
    if (/\.m3u8(\?|$)/i.test(url)) return "application/vnd.apple.mpegurl";
    if (/\.webm(\?|$)/i.test(url)) return "video/webm";
    return "video/mp4";
  }

  /** pbs.twimg.com/…/xxx.jpg?format=png&name=900x900 → bare URL (sizing is re-applied later). */
  function bareImageUrl(url) {
    if (!url) return "";
    try {
      const u = new URL(url);
      if (/twimg\.com$/.test(u.hostname)) {
        const format = u.searchParams.get("format");
        u.search = "";
        let s = u.toString();
        if (format && !/\.(jpg|jpeg|png|gif|webp)$/i.test(s)) s += "." + format;
        return s;
      }
      return url;
    } catch { return url; }
  }

  const isVideoThumb = (url) => /ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb/.test(url || "");
  const isVideoFile = (url) => /\.(mp4|m3u8|webm|mov)(\?|$)/i.test(url || "") || /video\.twimg\.com/.test(url || "");

  function mediaFromUrl(url, index) {
    if (isVideoFile(url)) return { index, kind: "video", thumb: "", sources: [{ url, type: guessType(url) }] };
    return { index, kind: "photo", thumb: bareImageUrl(url), posterOnly: isVideoThumb(url) };
  }

  function statusUrl(username, id) {
    return `https://x.com/${username || "i"}/status/${id}`;
  }
  function idFromUrl(url) {
    const m = String(url || "").match(/status(?:es)?\/(\d+)/);
    return m ? m[1] : "";
  }
  function usernameFromUrl(url) {
    const m = String(url || "").match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status/);
    return m ? m[1] : "";
  }
  const pick = (obj, ...keys) => { for (const k of keys) { if (obj && obj[k] != null && obj[k] !== "") return obj[k]; } return undefined; };

  return { videoSources, bareImageUrl, isVideoThumb, isVideoFile, mediaFromUrl, statusUrl, idFromUrl, usernameFromUrl, pick };
});
