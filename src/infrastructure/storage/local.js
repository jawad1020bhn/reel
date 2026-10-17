/* infra.storage.local — StoragePort on localStorage (≈5 MB; fine for prefs/activity,
   too small for a big dataset — large values fall through to the memory tier). */
XR.define("infra.storage.local", [], function () {
  "use strict";
  const PREFIX = "xr:";
  const ok = (() => { try { const k = "__xr_probe"; localStorage.setItem(k, "1"); localStorage.removeItem(k); return true; } catch { return false; } })();
  const mem = new Map();
  const api = {
    kind: ok ? "localstorage" : "memory",
    available: () => ok,
    async get(key) {
      if (mem.has(key)) return mem.get(key);
      if (!ok) return null;
      const raw = localStorage.getItem(PREFIX + key);
      if (raw == null) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    async set(key, value) {
      if (!ok) { mem.set(key, value); return true; }
      try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); mem.delete(key); return true; }
      catch (err) { console.warn("[storage.local] quota — keeping in memory", key); mem.set(key, value); return false; }
    },
    async remove(key) { mem.delete(key); if (ok) localStorage.removeItem(PREFIX + key); return true; },
    async keys() { const out = new Set(mem.keys()); if (ok) for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(PREFIX)) out.add(k.slice(PREFIX.length)); } return [...out]; },
    async clear() { mem.clear(); if (ok) for (const k of await api.keys()) localStorage.removeItem(PREFIX + k); return true; },
    async estimate() { if (!ok) return null; let used = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); used += (k?.length || 0) + (localStorage.getItem(k)?.length || 0); } return { used: used * 2, quota: 5 * 1024 * 1024 }; },
  };
  return api;
});
