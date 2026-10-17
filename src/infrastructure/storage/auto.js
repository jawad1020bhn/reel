/* infra.storage.auto — picks the best available StoragePort at runtime:
   IndexedDB → localStorage → memory. Calls made before the probe finishes are
   queued, so app code can use it synchronously from the first tick.
   Large values (datasets) go to IndexedDB only; when it is missing they stay in
   memory for the session and the app keeps working from data/posts.js. */
XR.define("infra.storage.auto", ["infra.storage.idb", "infra.storage.local", "infra.storage.memory"], function (idb, local, memory) {
  "use strict";
  let primary = null;
  const ready = (async () => {
    try { await Promise.race([idb.probe(), new Promise((_, rej) => setTimeout(() => rej(new Error("idb timeout")), 2500))]); primary = idb; }
    catch (err) { console.warn("[storage] IndexedDB unavailable → " + (local.available() ? "localStorage" : "memory"), err?.message || err); primary = local.available() ? local : memory; }
    return primary;
  })();
  const call = (m, ...args) => ready.then((p) => p[m](...args));
  return {
    get kind() { return primary ? primary.kind : "pending"; },
    ready,
    get: (k) => call("get", k),
    set: (k, v) => call("set", k, v),
    remove: (k) => call("remove", k),
    keys: () => call("keys"),
    clear: () => call("clear"),
    estimate: () => call("estimate"),
  };
});
