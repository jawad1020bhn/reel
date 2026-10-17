/* infra.media.player — PlayerEnginePort.
   Attaches a media item to a <video>: tries MP4 sources best-first with a
   per-element failure ladder; when they all fail (or the item is HLS-only) it
   falls back to hls.js (vendor/hls.min.js) or native HLS (Safari).

   Policy choices live in app.playback; this module only knows how to get bytes
   into a <video>. */
XR.define("infra.media.player", ["app.ports.mediaResolver"], function (resolver) {
  "use strict";
  const registry = new WeakMap(); // video → { sources, idx, hls, onError }
  const MAX_BITRATE_ON_SAVE_DATA = 2_500_000;

  const saveData = () => !!(navigator.connection && navigator.connection.saveData);
  const nativeHls = (video) => !!video.canPlayType && video.canPlayType("application/vnd.apple.mpegurl") !== "";
  const hlsJs = () => (typeof window !== "undefined" && window.Hls && window.Hls.isSupported()) ? window.Hls : null;

  function startHls(video, url, rec) {
    const Hls = hlsJs();
    if (Hls) {
      rec.hls = new Hls({ enableWorker: false, lowLatencyMode: false, maxBufferLength: 30, backBufferLength: 10, capLevelToPlayerSize: true, startLevel: -1 });
      rec.hls.loadSource(url);
      rec.hls.attachMedia(video);
      rec.hlsRetries = 0;
      rec.hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        const giveUp = () => { try { rec.hls.destroy(); } catch { /* ignore */ } rec.hls = null; video.dispatchEvent(new CustomEvent("xr:unplayable", { detail: { reason: data.details || data.type } })); };
        if (rec.hlsRetries++ >= 2) return giveUp();
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) setTimeout(() => rec.hls && rec.hls.startLoad(), 800 * rec.hlsRetries);
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) rec.hls.recoverMediaError();
        else giveUp();
      });
      return true;
    }
    if (nativeHls(video)) { video.src = url; return true; }
    return false;
  }

  function tryNext(video, rec) {
    while (rec.idx < rec.sources.length) {
      const s = rec.sources[rec.idx++];
      if (saveData() && s.bitrate > MAX_BITRATE_ON_SAVE_DATA && rec.idx < rec.sources.length) continue;
      video.src = s.url;
      return true;
    }
    if (rec.hlsUrl && !rec.triedHls) { rec.triedHls = true; video.removeAttribute("src"); if (startHls(video, rec.hlsUrl, rec)) return true; }
    video.dispatchEvent(new CustomEvent("xr:unplayable", { detail: { reason: "exhausted" } }));
    return false;
  }

  function attach(video, media, opts = {}) {
    detach(video);
    const rec = { sources: resolver.sources(media, opts), idx: 0, hls: null, hlsUrl: resolver.hls ? resolver.hls(media) : media.hls, triedHls: false, media };
    rec.onError = () => {
      const err = video.error;
      // MEDIA_ERR_ABORTED (1) is caused by our own src swaps; ignore it.
      if (err && err.code === 1) return;
      const wasPlaying = !video.paused;
      const t = video.currentTime;
      if (tryNext(video, rec)) {
        if (t > 0) video.addEventListener("loadedmetadata", () => { try { video.currentTime = t; } catch { /* ignore */ } }, { once: true });
        if (wasPlaying) video.play().catch(() => {});
      }
    };
    video.addEventListener("error", rec.onError);
    registry.set(video, rec);
    if (!rec.sources.length && rec.hlsUrl) { rec.triedHls = true; startHls(video, rec.hlsUrl, rec); }
    else tryNext(video, rec);
    return rec;
  }
  function detach(video) {
    const rec = registry.get(video);
    if (!rec) return;
    video.removeEventListener("error", rec.onError);
    if (rec.hls) { try { rec.hls.destroy(); } catch { /* ignore */ } }
    registry.delete(video);
    try { video.pause(); video.removeAttribute("src"); video.load(); } catch { /* ignore */ }
  }
  const currentSource = (video) => { const rec = registry.get(video); return rec ? (rec.hls ? { url: rec.hlsUrl, type: "hls" } : rec.sources[rec.idx - 1] || null) : null; };

  return { attach, detach, currentSource, canHls: () => !!hlsJs() };
});
