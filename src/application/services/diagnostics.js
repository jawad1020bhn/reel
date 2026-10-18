/* app.diagnostics — what the debug panel shows: boot timings (performance marks), a ring
   buffer of the last events on the bus, environment facts and a snapshot() for bug reports.
   Enable the event log with ?debug in the URL hash query or Settings → About → Debug. */
XR.define("app.diagnostics", ["core.events", "app.ports.storage", "app.ports.platform"], function (events, storage, platform) {
  "use strict";
  const marks = [];
  const t0 = (typeof performance !== "undefined" && performance.timeOrigin) ? 0 : Date.now();
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now() - t0);
  function mark(name) {
    marks.push({ name, at: Math.round(now()) });
    try { performance.mark("xreels:" + name); } catch { /* unsupported */ }
  }
  /* event log — always on, cheap (ring of 200 names + tiny payload summaries) */
  const LOG_MAX = 200;
  const log = [];
  const summarise = (p) => {
    if (p == null) return "";
    if (typeof p !== "object") return String(p).slice(0, 60);
    const keys = Object.keys(p).slice(0, 6).map((k) => { const v = p[k]; return `${k}=${Array.isArray(v) ? `[${v.length}]` : typeof v === "object" && v ? "{…}" : String(v).slice(0, 24)}`; });
    return keys.join(" ");
  };
  events.bus.tap((name, payload) => { log.push({ at: Math.round(now()), name, info: summarise(payload) }); if (log.length > LOG_MAX) log.shift(); });

  function env() {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    return {
      version: (typeof window !== "undefined" && window.XREELS_MANIFEST?.version) || "?",
      protocol: typeof location !== "undefined" ? location.protocol : "?",
      storage: storage.kind,
      touch: platform.isTouch(), dpr: platform.dpr(), reducedMotion: platform.reducedMotion(),
      viewport: typeof innerWidth !== "undefined" ? `${innerWidth}×${innerHeight}` : "?",
      ua: ua.slice(0, 160),
      memory: (typeof performance !== "undefined" && performance.memory) ? Math.round(performance.memory.usedJSHeapSize / 1048576) + " MB heap" : "n/a",
      hls: typeof window !== "undefined" && window.Hls ? "loaded" : "on demand",
      network: (() => { const n = platform.network ? platform.network() : null; return n ? `${n.effectiveType || "?"}${n.downlink ? " " + n.downlink + "Mbps" : ""}${n.saveData ? " save-data" : ""}` : "n/a"; })(),
      h264: (() => { try { return document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"') || "no"; } catch { return "?"; } })(),
    };
  }
  async function snapshot(extra = {}) {
    let estimate = null; try { estimate = await storage.estimate(); } catch { /* n/a */ }
    return { when: new Date().toISOString(), env: env(), marks: marks.slice(), events: log.slice(-60), storageEstimate: estimate, ...extra };
  }
  return { mark, marks: () => marks.slice(), log: () => log.slice(), env, snapshot };
});
