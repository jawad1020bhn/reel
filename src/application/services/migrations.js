/* app.migrations — versioned, idempotent upgrades of what is persisted in the storage port.

   Each storage key has a schema number recorded in `xreels.schema.v1` ({ [name]: version }).
   A migration is { name, from, to, up(storage) } and runs once, in order, at boot before any
   service reads its data. Register new ones here (keep the old ones — they document history).

   How to add one: bump the target version in the owning service, append
   `register({ name: "activity", from: 1, to: 2, async up(storage) { ... } })` below,
   and describe the change in docs/ARCHITECTURE.md §8. */
XR.define("app.migrations", ["app.ports.storage"], function (storage) {
  "use strict";
  const KEY = "xreels.schema.v1";
  const list = [];
  const register = (m) => { list.push(m); return m; };

  /* --- history ------------------------------------------------------------ */

  /* 1 → 2 (datasets): the single "imported" dataset becomes an entry in the datasets index,
     so several libraries can coexist (Settings → Data → Libraries). Data is not copied. */
  register({
    name: "datasets", from: 1, to: 2,
    async up(s) {
      const legacy = await s.get("xreels.dataset.imported.v1").catch(() => null);
      const index = (await s.get("xreels.datasets.v1").catch(() => null)) || { active: "auto", items: [] };
      if (legacy && Array.isArray(legacy.posts) && legacy.posts.length && !index.items.some((d) => d.id === "imported")) {
        index.items.push({ id: "imported", key: "xreels.dataset.imported.v1", label: legacy.label || "Imported file", count: legacy.posts.length, adapter: legacy.adapter || "", fingerprint: legacy.fingerprint || "", at: legacy.at || Date.now() });
        const prefs = (await s.get("xreels.prefs.v1").catch(() => null)) || {};
        if (prefs.dataPriority === "imported") index.active = "imported";
      }
      await s.set("xreels.datasets.v1", index);
    },
  });

  /* --- runner --------------------------------------------------------------- */
  async function run() {
    const state = (await storage.get(KEY).catch(() => null)) || {};
    const applied = [];
    for (const m of list) {
      const cur = state[m.name] || 1;
      if (cur !== m.from) continue;
      try { await m.up(storage); state[m.name] = m.to; applied.push(`${m.name} ${m.from}→${m.to}`); }
      catch (err) { console.error(`[migrations] ${m.name} ${m.from}→${m.to} failed`, err); break; }
    }
    if (applied.length) await storage.set(KEY, state).catch(() => {});
    return { applied, state };
  }
  const versionOf = async (name) => ((await storage.get(KEY).catch(() => null)) || {})[name] || 1;
  return { register, run, versionOf, list: () => list.slice(), KEY };
});
