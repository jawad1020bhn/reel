/* app.prefs — user preferences: defaults, persistence, change events.
   UI never writes localStorage directly; it calls prefs.set(). The shell
   applies document-level effects (theme, density…) by listening to PREFS_CHANGED. */
XR.define("app.prefs", ["app.ports.storage", "core.events", "core.domain.events", "core.domain.model"], function (storage, events, EV, model) {
  "use strict";
  const KEY = "xreels.prefs.v1";

  const DEFAULTS = Object.freeze({
    /* appearance */
    language: "auto",         // auto | en | ar
    density: "cozy",          // compact | cozy | comfortable
    tileShape: "natural",     // natural | portrait | square
    tileInfo: "hover",        // hover | always | never  (creator/caption strip on tiles)
    hoverPreview: true,       // muted preview when the pointer rests on a video tile
    reduceMotion: "system",   // system | on | off
    landing: "discover",      // discover | library | watch
    /* playback */
    autoplay: true,
    startMuted: true,
    loopShorts: true,         // clips ≤ 60s loop, longer ones auto-advance
    autoAdvance: true,        // move to the next post when a clip ends
    imageSeconds: 0,          // 0 = images never auto-advance in Watch
    fit: "auto",              // auto | contain | cover
    rememberProgress: true,
    preload: true,            // warm the next/previous cells
    speed: 1,
    shortMaxSeconds: model.SHORT_MAX_SECONDS,
    tileOpens: "auto",        // auto: videos → Watch, photos/albums → Viewer
    wheelStep: true,          // one post per mouse-wheel notch in Watch
    /* privacy */
    blur: false,              // blur stills until hover/tap
    seenDim: true,            // dim tiles you already opened
    discreet: false,          // neutral tab title + icon
    hideSensitive: false,     // hide posts flagged sensitive by X
    lockMinutes: 0,           // auto-lock after N minutes hidden (0 = only on launch)
    /* data */
    dataPriority: "file",     // legacy (pre-1.1): migrated into the libraries index
    keepTextOnly: false,
    localMediaDir: "",        // e.g. "media" → media/<postId>_<n>.<ext> is tried first
  });

  let prefs = { ...DEFAULTS };
  let loaded = false;

  async function load() {
    try {
      const stored = await storage.get(KEY);
      if (stored && typeof stored === "object") prefs = { ...DEFAULTS, ...stored };
    } catch (err) { console.warn("[prefs] load failed", err); }
    loaded = true;
    events.bus.emit(EV.PREFS_CHANGED, { prefs, patch: prefs, initial: true });
    return prefs;
  }
  function get(key) { return key === undefined ? prefs : prefs[key]; }
  function set(patch) {
    const clean = {};
    for (const [k, v] of Object.entries(patch)) if (k in DEFAULTS && prefs[k] !== v) clean[k] = v;
    if (!Object.keys(clean).length) return prefs;
    prefs = { ...prefs, ...clean };
    storage.set(KEY, prefs).catch(() => {});
    events.bus.emit(EV.PREFS_CHANGED, { prefs, patch: clean });
    return prefs;
  }
  function reset() {
    prefs = { ...DEFAULTS };
    storage.set(KEY, prefs).catch(() => {});
    events.bus.emit(EV.PREFS_CHANGED, { prefs, patch: prefs, reset: true });
  }
  const onChange = (fn) => events.bus.on(EV.PREFS_CHANGED, fn);

  return { DEFAULTS, load, get, set, reset, onChange, isLoaded: () => loaded, KEY };
});
