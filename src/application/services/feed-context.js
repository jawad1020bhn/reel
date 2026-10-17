/* app.feedContext — the ordered list a player surface (Watch / Viewer) plays through.
   Any feature can hand over "these posts, start here"; Watch/Viewer read it.
   Survives a reload via sessionStorage when available (file:// included). */
XR.define("app.feedContext", ["core.util"], function (util) {
  "use strict";
  const KEY = "xreels.feed.ctx";
  let ctx = null;

  function restore() {
    if (ctx) return ctx;
    try { const raw = sessionStorage.getItem(KEY); if (raw) ctx = JSON.parse(raw); } catch { /* unavailable */ }
    return ctx;
  }
  /**
   * @param {string[]} ids   post ids in play order
   * @param {number} index   starting position
   * @param {object} meta    { label, spec, origin }
   */
  function set(ids, index = 0, meta = {}) {
    ctx = { ids: ids.slice(), index: util.clamp(index, 0, Math.max(0, ids.length - 1)), label: meta.label || "", spec: meta.spec || null, origin: meta.origin || "", at: Date.now() };
    try { sessionStorage.setItem(KEY, JSON.stringify(ctx)); } catch { /* ignore */ }
    return ctx;
  }
  function get() { return restore(); }
  function setIndex(i) { if (ctx) { ctx.index = i; try { sessionStorage.setItem(KEY, JSON.stringify(ctx)); } catch { /* ignore */ } } }
  function clear() { ctx = null; try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } }
  return { set, get, setIndex, clear };
});
