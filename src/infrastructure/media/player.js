/* infra.media.player — PlayerEnginePort.
   Attaches a media item to a <video>: tries MP4 sources in the resolver's order (the
   rung sized for the element's box first) with a per-element failure ladder; when they
   all fail (or the item is HLS-only) it falls back to native HLS (Safari) or hls.js.

   hls.js (415 KB) is not part of the boot: X exports almost always carry MP4s, so the
   library is injected the first time a stream actually needs it.

   Policy choices (bitrate budget) live in app.playback; this module only knows how to
   get bytes into a <video>. */
XR.define("infra.media.player", ["app.ports.mediaResolver"], function (resolver) {
  "use strict";
  const registry = new WeakMap(); // video → { sources, idx, hls, onError }
  const MAX_BITRATE_ON_SAVE_DATA = 2_500_000;
  const HLS_SRC = (typeof window !== "undefined" && window.XREELS_MANIFEST?.onDemand?.hls) || "vendor/hls.min.js";

  const saveData = () => !!(typeof navigator !== "undefined" && navigator.connection && navigator.connection.saveData);
  const nativeHls = (video) => !!video.canPlayType && video.canPlayType("application/vnd.apple.mpegurl") !== "";
  const hlsJs = () => (typeof window !== "undefined" && window.Hls && window.Hls.isSupported()) ? window.Hls : null;

  /* one shared injection; resolves to the Hls constructor or null (missing file / no MSE) */
  let hlsLoading = null;
  function loadHls() {
    if (hlsJs()) return Promise.resolve(hlsJs());
    if (typeof document === "undefined") return Promise.resolve(null);
    if (!hlsLoading) {
      hlsLoading = new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = HLS_SRC;
        s.async = true;
        s.onload = () => resolve(hlsJs());
        s.onerror = () => { hlsLoading = null; s.remove(); resolve(null); };
        document.head.appendChild(s);
      });
    }
    return hlsLoading;
  }

  function useHlsJs(Hls, video, url, rec) {
    rec.hls = new Hls({ enableWorker: false, lowLatencyMode: false, maxBufferLength: 30, backBufferLength: 10, capLevelToPlayerSize: true, startLevel: -1 });
    rec.hls.loadSource(url);
    rec.hls.attachMedia(video);
    rec.hlsRetries = 0;
    rec.hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      const giveUp = () => { try { rec.hls.destroy(); } catch { /* ignore */ } rec.hls = null; video.dispatchEvent(new CustomEvent("xr:unplayable", { detail: { reason: data.details || data.type } })); };
      /* a fatal playlist error comes after hls.js's own retries, and startLoad() cannot
         recover it (there is no manifest to resume): without this the cell spun forever */
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && /manifest/i.test(data.details || "")) return giveUp();
      if (rec.hlsRetries++ >= 2) return giveUp();
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) setTimeout(() => rec.hls && rec.hls.startLoad(), 800 * rec.hlsRetries);
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) rec.hls.recoverMediaError();
      else giveUp();
    });
  }

  /** Start an HLS stream: hls.js if already loaded, native HLS (Safari), else load hls.js. */
  function startHls(video, url, rec) {
    const ready = hlsJs();
    if (ready) { useHlsJs(ready, video, url, rec); return; }
    if (nativeHls(video)) { video.src = url; return; }
    loadHls().then((Hls) => {
      if (registry.get(video) !== rec) return;           // detached / re-attached meanwhile
      if (!Hls) { video.dispatchEvent(new CustomEvent("xr:unplayable", { detail: { reason: "no-hls" } })); return; }
      useHlsJs(Hls, video, url, rec);
      /* attaching a new source resets `paused`: carry the play intent over */
      if (rec.resumePlay) video.play().catch(() => {});
    });
  }

  function tryNext(video, rec) {
    if (rec.idx < rec.sources.length) {
      video.src = rec.sources[rec.idx++].url;
      return true;
    }
    if (rec.hlsUrl && !rec.triedHls) { rec.triedHls = true; video.removeAttribute("src"); startHls(video, rec.hlsUrl, rec); return true; }
    video.dispatchEvent(new CustomEvent("xr:unplayable", { detail: { reason: "exhausted" } }));
    return false;
  }

  /** The CSS box the video is drawn in; the viewport when it is not laid out yet. */
  function boxOf(video) {
    const w = video.clientWidth, h = video.clientHeight;
    if (w > 0 && h > 0) return { width: w, height: h };
    return typeof innerWidth !== "undefined" ? { width: innerWidth, height: innerHeight } : null;
  }
  /** cover crops to fill the box and needs a sharper rung than contain (letterbox). */
  function fitOf(video) {
    try { return video.isConnected && getComputedStyle(video).objectFit === "cover" ? "cover" : "contain"; } catch { return "contain"; }
  }

  /**
   * opts: { localDir, box?: {width,height}, fit?, dpr?, maxBitrate? }
   * box/fit default to the element's rendered size and object-fit, dpr to devicePixelRatio;
   * without a maxBitrate a Save-Data connection still caps the ladder.
   */
  function attach(video, media, opts = {}) {
    detach(video);
    const ranking = {
      ...opts,
      box: opts.box || boxOf(video),
      fit: opts.fit || fitOf(video),
      dpr: opts.dpr || (typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1),
      maxBitrate: opts.maxBitrate ?? (saveData() ? MAX_BITRATE_ON_SAVE_DATA : 0),
    };
    const rec = { sources: resolver.sources(media, ranking), idx: 0, hls: null, hlsUrl: resolver.hls ? resolver.hls(media) : media.hls, triedHls: false, media };
    /* play intent = the last play/pause event: a failed load flips `paused` back to true
       before `error` fires, so reading the attribute there lost it and a successful
       fallback (next rung or HLS) sat paused on its poster */
    rec.onPlay = () => { rec.intent = true; };
    rec.onPause = () => { if (!rec.failing) rec.intent = false; };
    video.addEventListener("play", rec.onPlay);
    video.addEventListener("pause", rec.onPause);
    rec.onError = () => {
      const err = video.error;
      // MEDIA_ERR_ABORTED (1) is caused by our own src swaps; ignore it.
      if (err && err.code === 1) return;
      const wasPlaying = !video.paused || !!rec.intent;
      const t = video.currentTime;
      rec.resumePlay = wasPlaying;
      /* the failed load's own `pause` event arrives after this handler: ignore it */
      rec.failing = true;
      setTimeout(() => { rec.failing = false; }, 0);
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
    video.removeEventListener("play", rec.onPlay);
    video.removeEventListener("pause", rec.onPause);
    if (rec.hls) { try { rec.hls.destroy(); } catch { /* ignore */ } }
    registry.delete(video);
    try { video.pause(); video.removeAttribute("src"); video.load(); } catch { /* ignore */ }
  }
  const currentSource = (video) => { const rec = registry.get(video); return rec ? (rec.hls ? { url: rec.hlsUrl, type: "hls" } : rec.sources[rec.idx - 1] || null) : null; };

  /** HLS can play here: hls.js loaded or loadable on demand, or native support. */
  const canHls = () => !!hlsJs() || !!HLS_SRC || (typeof document !== "undefined" && nativeHls(document.createElement("video")));

  return { attach, detach, currentSource, canHls, loadHls };
});
