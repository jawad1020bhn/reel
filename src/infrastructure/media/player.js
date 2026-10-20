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
  let hlsLoading = null;

  /** hls.js is a 415 KB optional vendor; don't fetch or parse it unless an item needs it. */
  function loadHls() {
    const ready = hlsJs();
    if (ready || (typeof window !== "undefined" && window.Hls)) return Promise.resolve(ready);
    if (hlsLoading) return hlsLoading;
    const src = typeof window !== "undefined" ? window.XREELS_MANIFEST?.vendor?.find((f) => /hls\.min\.js$/i.test(f)) : "";
    if (!src || typeof document === "undefined") return Promise.resolve(null);
    hlsLoading = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => resolve(hlsJs());
      script.onerror = () => {
        const errors = window.XREELS_LOAD_ERRORS;
        if (Array.isArray(errors)) errors.push({ file: src, message: "failed to load" });
        hlsLoading = null;
        resolve(null);
      };
      document.head.appendChild(script);
    });
    return hlsLoading;
  }

  function startHls(video, url, rec) {
    const Hls = hlsJs();
    if (Hls) {
      rec.hls = new Hls({ enableWorker: false, lowLatencyMode: false, maxBufferLength: 30, backBufferLength: 10, capLevelToPlayerSize: true, startLevel: -1 });
      rec.hls.loadSource(url);
      rec.hls.attachMedia(video);
      rec.hlsRetries = 0;
      rec.hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        const giveUp = () => {
          try { rec.hls.destroy(); } catch { /* ignore */ }
          rec.hls = null;
          if (rec.hlsFirst && rec.idx < rec.sources.length) return hlsFailed(video, rec, false);
          video.dispatchEvent(new CustomEvent("xr:unplayable", { detail: { reason: data.details || data.type } }));
        };
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

  /* HLS first for media flagged hlsFirst (Reddit: its sound is in the playlist), otherwise after
     the listed sources. Every other item keeps the original order. */
  function tryNext(video, rec, resumeAfterHls = false) {
    if (rec.hlsFirst && rec.hlsUrl && !rec.triedHls) return tryHls(video, rec, resumeAfterHls);
    while (rec.idx < rec.sources.length) {
      const s = rec.sources[rec.idx++];
      if (saveData() && s.bitrate > MAX_BITRATE_ON_SAVE_DATA && rec.idx < rec.sources.length) continue;
      video.src = s.url;
      return true;
    }
    if (rec.hlsUrl && !rec.triedHls) return tryHls(video, rec, resumeAfterHls);
    rec.ready = Promise.resolve(false);
    video.dispatchEvent(new CustomEvent("xr:unplayable", { detail: { reason: "exhausted" } }));
    return false;
  }

  function tryHls(video, rec, resumeAfterHls) {
    rec.triedHls = true;
    video.removeAttribute("src");
    if (startHls(video, rec.hlsUrl, rec)) return true;
    rec.awaitingHls = true;
    rec.ready = loadHls().then((Hls) => {
      if (registry.get(video) !== rec) return false;
      rec.awaitingHls = false;
      if (Hls && startHls(video, rec.hlsUrl, rec)) {
        if (resumeAfterHls) video.play().catch(() => {});
        return true;
      }
      return hlsFailed(video, rec, resumeAfterHls);
    }).catch(() => {
      if (registry.get(video) === rec) {
        rec.awaitingHls = false;
        return hlsFailed(video, rec, resumeAfterHls);
      }
      return false;
    });
    return true;
  }

  /* HLS did not start: hlsFirst media falls back to its silent MP4s; the rest report unplayable. */
  function hlsFailed(video, rec, resumeAfterHls) {
    if (rec.hlsFirst && rec.idx < rec.sources.length) {
      const started = tryNext(video, rec, false);
      if (started && resumeAfterHls) video.play().catch(() => {});
      return started;
    }
    video.dispatchEvent(new CustomEvent("xr:unplayable", { detail: { reason: "exhausted" } }));
    return false;
  }

  function attach(video, media, opts = {}) {
    detach(video);
    const rec = { sources: resolver.sources(media, opts), idx: 0, hls: null, hlsUrl: resolver.hls ? resolver.hls(media) : media.hls, hlsFirst: !!media.hlsFirst, triedHls: false, ready: null, media };
    rec.onError = () => {
      const err = video.error;
      // MEDIA_ERR_ABORTED (1) is caused by our own src swaps; ignore it.
      if (err && err.code === 1) return;
      const wasPlaying = !video.paused;
      const t = video.currentTime;
      if (tryNext(video, rec, wasPlaying)) {
        if (t > 0) video.addEventListener("loadedmetadata", () => { try { video.currentTime = t; } catch { /* ignore */ } }, { once: true });
        if (wasPlaying && !rec.awaitingHls) video.play().catch(() => {});
      }
    };
    video.addEventListener("error", rec.onError);
    registry.set(video, rec);
    tryNext(video, rec);
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
