/* app.store — a minimal reactive container.
   createStore(initial) → { get, set, update, subscribe, select }
   Notifications are batched into one microtask so a burst of writes repaints once. */
XR.define("app.store", [], function () {
  "use strict";

  function createStore(initial = {}) {
    let state = { ...initial };
    const subs = new Set();
    let scheduled = false, pending = {};

    function flush() {
      scheduled = false;
      const patch = pending; pending = {};
      for (const fn of [...subs]) {
        try { fn(state, patch); } catch (err) { console.error("[store] subscriber failed", err); }
      }
    }
    function set(patch) {
      let changed = false;
      for (const k of Object.keys(patch)) {
        if (state[k] !== patch[k]) { changed = true; pending[k] = patch[k]; }
      }
      if (!changed) return;
      state = { ...state, ...patch };
      if (!scheduled) { scheduled = true; queueMicrotask(flush); }
    }
    const update = (fn) => set(fn(state) || {});
    const get = (key) => (key === undefined ? state : state[key]);
    function subscribe(fn, { immediate = false } = {}) {
      subs.add(fn);
      if (immediate) fn(state, {});
      return () => subs.delete(fn);
    }
    /** Subscribe to a derived value; fires only when it changes (===). */
    function select(selector, fn, { immediate = true } = {}) {
      let last = selector(state);
      if (immediate) fn(last, undefined);
      return subscribe((s) => {
        const next = selector(s);
        if (next !== last) { const prev = last; last = next; fn(next, prev); }
      });
    }
    return { get, set, update, subscribe, select };
  }

  return { createStore };
});
