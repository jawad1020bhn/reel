/* app.features — the feature registry (plugin host).

   A feature is a kernel module named "features.<id>" whose factory returns a manifest:
     {
       id: "library",                 // unique
       title: "Library",              // nav label
       icon: "grid",                  // ui.icons name
       route: "/library",             // pattern; may contain /:param or /:param?
       nav: true,                     // show in the sidebar/bottom bar
       order: 20,                     // nav order
       mount(outlet, route) {…},      // render into the outlet element
       unmount() {…},                 // cleanup (optional)
       update(route) {…},             // same route, new params/query (optional; default = unmount+mount)
       commands() → [{id,title,hint,run,keys?}]   // for the command palette (optional)
       shortcuts: { "g l": () => … } // optional global key chords
     }
   Features never import each other. They talk through app.nav, the event bus and app.* services. */
XR.define("app.features", ["app.nav", "core.util"], function (nav, util) {
  "use strict";
  const list = [];
  const byId = new Map();

  function register(manifest) {
    if (!manifest || !manifest.id) throw new Error("Feature manifest needs an id");
    if (byId.has(manifest.id)) { console.warn(`[features] duplicate feature "${manifest.id}" ignored`); return byId.get(manifest.id); }
    const m = { nav: false, order: 100, icon: "sparkles", title: manifest.id, ...manifest };
    list.push(m); byId.set(m.id, m);
    if (m.route) nav.register(m.id, m.route);
    list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    return m;
  }
  /** Boot helper: resolve every "features.*" module and register its manifest. */
  function registerAll() {
    for (const name of XR.names("features.").filter((n) => n.split(".").length === 2)) {
      try { const manifest = XR.resolve(name); if (manifest && manifest.id) register(manifest); }
      catch (err) { console.error(`[features] failed to load ${name}`, err); }
    }
    return list.slice();
  }
  const get = (id) => byId.get(id) || null;
  const all = () => list.slice();
  const navItems = () => list.filter((m) => m.nav);
  function commands() {
    const out = [];
    for (const m of list) if (typeof m.commands === "function") { try { out.push(...(m.commands() || []).map((c) => ({ ...c, feature: m.id }))); } catch (err) { console.error(err); } }
    return util.uniq(out, (c) => c.id);
  }
  return { register, registerAll, get, all, navItems, commands };
});
