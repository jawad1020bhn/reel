/* infra.storage.memory — StoragePort that forgets on reload (tests, private mode fallbacks). */
XR.define("infra.storage.memory", [], function () {
  "use strict";
  const map = new Map();
  return {
    kind: "memory",
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async set(key, value) { map.set(key, value); return true; },
    async remove(key) { map.delete(key); return true; },
    async keys() { return [...map.keys()]; },
    async clear() { map.clear(); return true; },
    async estimate() { return null; },
  };
});
