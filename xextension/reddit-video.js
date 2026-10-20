/*
 * Reddit video enrichment: pure logic.
 *
 * Reddit serves hosted videos as CMAF/HLS: a master playlist (HLSPlaylist.m3u8)
 * lists video variant playlists (CMAF_<x>.m3u8) and an audio rendition
 * (CMAF_AUDIO_<x>.m3u8); each variant playlist maps byte-ranges onto a single
 * file (CMAF_<x>.mp4). The old DASH_<h>.mp4 rendition names no longer exist for
 * these posts, and Reddit blocks third-party pages from the audio while the
 * logged-in session plays everything — so the *capture* step, which runs inside
 * that session, records the real URLs and (optionally) downloads the files.
 *
 * Nothing in this file touches the DOM, the network, or chrome.* directly:
 *  - parseMasterPlaylist / parseVariantPlaylist read playlist text,
  *  - videoInfoFromPostJson reads a post's .json payload,
 *  - enrichMedia merges the findings into a captured record (export v2),
 *  - planDownloads names the local files the app's media folder expects
 *    (<postId>_<n>.mp4 and <postId>_<n>-audio.mp4).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XRedditVideo = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** Downloads land in <browser downloads>/xreels-media/; the app's "Local media
      folder" setting must point at a copy of that folder next to index.html. */
  const DOWNLOAD_DIR = "xreels-media";
  /** Best variant height to capture/download; 720 keeps files small and plays everywhere. */
  const DEFAULT_MAX_HEIGHT = 720;

  /* --------------------------------------------------------------------- */
  /* URL helpers                                                            */
  /* --------------------------------------------------------------------- */

  function resolveUrl(href, baseUrl) {
    try {
      return new URL(String(href || ""), baseUrl).href;
    } catch {
      return "";
    }
  }

  function attrsOf(line) {
    /* "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=416x234,URI=\"x.m3u8\"" → {BANDWIDTH:"1",...} */
    const out = {};
    const colon = line.indexOf(":");
    if (colon < 0) return out;
    const body = line.slice(colon + 1);
    for (const part of body.split(",")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const key = part.slice(0, eq).trim();
      let value = part.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      out[key.toUpperCase()] = value;
    }
    return out;
  }

  /* --------------------------------------------------------------------- */
  /* Playlist parsing                                                       */
  /* --------------------------------------------------------------------- */

  /**
   * Parse a Reddit HLS master playlist.
   * Returns { variants: [{url, height, bandwidth}], audio: {url} | null }.
   * Variants are sorted best (tallest) first; URIs are resolved against the master URL.
   */
  function parseMasterPlaylist(text, masterUrl) {
    const lines = String(text || "").split(/\r?\n/);
    const variants = [];
    let audio = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.startsWith("#EXT-X-MEDIA:")) {
        const attrs = attrsOf(line);
        if (attrs.TYPE === "AUDIO" && attrs.URI) {
          const url = resolveUrl(attrs.URI, masterUrl);
          if (url && !audio) audio = { url }; // first audio rendition is the default one
        }
        continue;
      }
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const attrs = attrsOf(line);
        const uri = (lines[i + 1] || "").trim();
        if (!uri || uri.startsWith("#")) continue;
        const url = resolveUrl(uri, masterUrl);
        if (!url) continue;
        const res = String(attrs.RESOLUTION || "").toLowerCase().split("x");
        const height = parseInt(res[1], 10) || 0;
        variants.push({ url, height, bandwidth: parseInt(attrs.BANDWIDTH, 10) || 0 });
        i++; // the URI line is consumed
        continue;
      }
    }
    variants.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
    return { variants, audio };
  }

  /**
   * Parse a variant (media) playlist for the single file it maps byte-ranges onto.
   * Returns { fileUrl } — from #EXT-X-MAP:URI (fMP4 init) or the first segment
   * URI, resolved against the playlist URL. Returns { fileUrl: "" } when nothing
   * readable is found.
   */
  function parseVariantPlaylist(text, playlistUrl) {
    const lines = String(text || "").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#EXT-X-MAP:")) {
        const attrs = attrsOf(trimmed);
        if (attrs.URI) return { fileUrl: resolveUrl(attrs.URI, playlistUrl) };
      }
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      return { fileUrl: resolveUrl(trimmed, playlistUrl) };
    }
    return { fileUrl: "" };
  }

  /* --------------------------------------------------------------------- */
  /* Post JSON                                                              */
  /* --------------------------------------------------------------------- */

  /**
   * Read a Reddit post .json payload (the shape of /comments/<id>.json) and
   * return the hosted-video facts: { hls, dash, fallback, duration, width,
   * height, isGif } or null when the post has no reddit-hosted video.
   */
  function videoInfoFromPostJson(json) {
    const post = Array.isArray(json) && json[0]?.data?.children?.[0]?.data
      ? json[0].data.children[0].data
      : (json?.data?.children?.[0]?.data) || null;
    const video = post && (post.media?.reddit_video || post.secure_media?.reddit_video ||
      post.media?.redditVideo || post.secure_media?.redditVideo || null);
    if (!video) return null;
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    return {
      hls: String(video.hls_url || video.hlsUrl || ""),
      dash: String(video.dash_url || video.dashUrl || ""),
      fallback: String(video.fallback_url || video.fallbackUrl || ""),
      duration: num(video.duration),
      width: num(video.width),
      height: num(video.height),
      isGif: !!(video.is_gif || video.isGif),
    };
  }

  /* --------------------------------------------------------------------- */
  /* Record enrichment (export v2)                                          */
  /* --------------------------------------------------------------------- */

  /**
   * Merge captured playlist facts into a stored record's video media entry.
   * `facts` comes from the enrichment walk:
   *   { info, master, verified: { "<variant file url>": true }, }
   * Returns the new media array (the record is not mutated) or null when the
   * record has no video to enrich.
   *
   * Resulting media entry (v2):
   *   { kind: "video", url, hls, duration, width, height,
   *     files: [{url, height, verified}], audio }
   * `files` are best-first direct file URLs; `verified` marks the ones whose
   * playlist was actually read (the rest are derived .m3u8→.mp4 and may 404).
   */
  function enrichMedia(record, facts) {
    if (!record || !Array.isArray(record.media)) return null;
    const entry = record.media.find((m) => m && m.kind === "video");
    if (!entry) return null;
    const info = facts && facts.info ? facts.info : {};
    const master = facts && facts.master ? facts.master : { variants: [], audio: null };
    const verified = (facts && facts.verified) || {};

    const files = [];
    for (const variant of master.variants || []) {
      const derived = variant.url.replace(/\.m3u8(\?.*)?$/i, ".mp4");
      if (!derived || derived === variant.url) continue;
      files.push({ url: derived, height: variant.height || 0, verified: !!verified[derived] });
    }
    /* Keep the audio URL only when its playlist was actually read — an
       unverified guess must never reach a download. */
    const audioFile = master.audio ? master.audio.url.replace(/\.m3u8(\?.*)?$/i, ".mp4") : "";
    const audio = audioFile && verified[audioFile] ? audioFile : "";
    const enriched = {
      kind: "video",
      url: entry.url,
      hls: info.hls || entry.hls || "",
      duration: info.duration || 0,
      width: info.width || 0,
      height: info.height || 0,
      files,
      audio,
    };
    return record.media.map((m) => (m === entry ? enriched : m));
  }

  /* --------------------------------------------------------------------- */
  /* Download planning                                                      */
  /* --------------------------------------------------------------------- */

  /** Best file at or below maxHeight; falls back to the smallest above it. */
  function chooseFile(files, maxHeight = DEFAULT_MAX_HEIGHT) {
    const usable = (files || []).filter((f) => f && f.url);
    if (!usable.length) return null;
    const atOrBelow = usable.filter((f) => (f.height || 0) <= maxHeight);
    if (atOrBelow.length) return atOrBelow.reduce((best, f) => ((f.height || 0) > (best.height || 0) ? f : best));
    return usable.reduce((best, f) => ((f.height || 0) < (best.height || 0) ? f : best));
  }

  /**
   * Plan the local files for one stored video record, using the naming the app's
   * local-media resolver expects: <fullname>_<n>.mp4 (video) and
   * <fullname>_<n>-audio.mp4 (audio), n = 1-based position in the post's media.
   * Only verified files are planned — a download must not guess.
   * Returns { video: {url, filename} | null, audio: {url, filename} | null, skipped: reason? }.
   */
  function planDownloads(record, options = {}) {
    const maxHeight = options.maxHeight || DEFAULT_MAX_HEIGHT;
    const out = { video: null, audio: null, skipped: "" };
    if (!record || !Array.isArray(record.media)) { out.skipped = "no media"; return out; }
    const index = Math.max(1, record.media.findIndex((m) => m && m.kind === "video") + 1);
    const entry = record.media[index - 1];
    if (!entry) { out.skipped = "no video"; return out; }
    const base = String(record.fullname || ("t3_" + record.id) || "").replace(/[^A-Za-z0-9_-]/g, "");
    if (!base) { out.skipped = "no id"; return out; }
    const file = chooseFile((entry.files || []).filter((f) => f.verified), maxHeight);
    if (!file) { out.skipped = "no verified video file"; return out; }
    out.video = { url: file.url, filename: `${base}_${index}.mp4` };
    if (entry.audio) out.audio = { url: entry.audio, filename: `${base}_${index}-audio.mp4` };
    return out;
  }

  return {
    DOWNLOAD_DIR,
    DEFAULT_MAX_HEIGHT,
    resolveUrl,
    attrsOf,
    parseMasterPlaylist,
    parseVariantPlaylist,
    videoInfoFromPostJson,
    enrichMedia,
    chooseFile,
    planDownloads,
  };
});
