/* infra.storage.idb — StoragePort on IndexedDB (works on file:// in Chromium/Firefox).
   One object store, key → structured-cloned value. All methods return Promises. */
XR.define("infra.storage.idb", [], function () {
  "use strict";
  const DB = "xreels", STORE = "kv", VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
      let req;
      try { req = indexedDB.open(DB, VERSION); } catch (err) { return reject(err); }
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
      req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); resolve(db); };
      req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }
  function tx(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      try { result = fn(store); } catch (err) { reject(err); return; }
      t.oncomplete = () => resolve(result && "result" in result ? result.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("IndexedDB aborted"));
    }));
  }
  const api = {
    kind: "indexeddb",
    get: (key) => tx("readonly", (s) => s.get(key)).then((v) => (v === undefined ? null : v)),
    set: (key, value) => tx("readwrite", (s) => s.put(value, key)).then(() => true),
    remove: (key) => tx("readwrite", (s) => s.delete(key)).then(() => true),
    keys: () => tx("readonly", (s) => s.getAllKeys()).then((k) => k || []),
    clear: () => tx("readwrite", (s) => s.clear()).then(() => true),
    estimate: async () => { try { const e = await navigator.storage?.estimate?.(); return e ? { used: e.usage || 0, quota: e.quota || 0 } : null; } catch { return null; } },
    /** Probe: resolves true when a round-trip works. */
    probe: () => api.set("__probe", 1).then(() => api.remove("__probe")).then(() => true),
  };
  return api;
});
