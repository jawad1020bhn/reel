/* core.events — a tiny synchronous event bus.
   Features never import each other; they talk through this bus (or through
   application services). Payloads are plain objects; names live in
   core.domain.events so typos fail loudly in one place. */
XR.define("core.events", [], function () {
  "use strict";

  function createBus() {
    /** @type {Map<string, Set<Function>>} */
    const handlers = new Map();

    function on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => off(name, fn);
    }
    function off(name, fn) { handlers.get(name)?.delete(fn); }
    function once(name, fn) {
      const stop = on(name, (payload) => { stop(); fn(payload); });
      return stop;
    }
    const taps = new Set();                     // observers of every emit (diagnostics)
    function emit(name, payload) {
      for (const t of taps) { try { t(name, payload); } catch { /* never break emit */ } }
      const set = handlers.get(name);
      if (!set) return 0;
      for (const fn of [...set]) {
        try { fn(payload); } catch (err) { console.error(`[bus] handler for "${name}" failed`, err); }
      }
      return set.size;
    }
    const tap = (fn) => { taps.add(fn); return () => taps.delete(fn); };
    return { on, off, once, emit, tap, _handlers: handlers };
  }

  return { createBus, bus: createBus() };
});
