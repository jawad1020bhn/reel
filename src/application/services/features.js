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
  const loading = new Map();
  const loadedScripts = new Set();
  const loadedStyles = new Set();
  const styleLoads = new Map();

  function register(manifest) {
    if (!manifest || !manifest.id) throw new Error("Feature manifest needs an id");
    const existing = byId.get(manifest.id);
    if (existing) {
      /* A lightweight nav descriptor is upgraded in place when its feature module arrives. */
      if (existing.lazy && !manifest.lazy) {
        Object.assign(existing, manifest);
        delete existing.lazy;
        delete existing.scripts;
        delete existing.styles;
        list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        return existing;
      }
      console.warn(`[features] duplicate feature "${manifest.id}" ignored`);
      return existing;
    }
    const m = { nav: false, order: 100, icon: "sparkles", title: manifest.id, ...manifest };
    list.push(m); byId.set(m.id, m);
    if (m.route) nav.register(m.id, m.route);
    list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    return m;
  }

  function loadScript(src) {
    if (loadedScripts.has(src)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => { loadedScripts.add(src); script.remove(); resolve(); };
      script.onerror = () => { script.remove(); reject(new Error(`Could not load ${src}`)); };
      document.head.appendChild(script);
    });
  }

  function loadStyle(href) {
    if (loadedStyles.has(href)) return Promise.resolve();
    if (styleLoads.has(href)) return styleLoads.get(href);
    const promise = new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.onload = () => { loadedStyles.add(href); resolve(); };
      link.onerror = () => { link.remove(); reject(new Error(`Could not load ${href}`)); };
      document.head.appendChild(link);
    });
    styleLoads.set(href, promise);
    promise.then(() => styleLoads.delete(href), () => styleLoads.delete(href));
    return promise;
  }

  /** Load an optional feature's stylesheet and classic script(s), then register it. */
  function load(id) {
    const feature = byId.get(id);
    if (!feature) return Promise.reject(new Error(`Unknown feature "${id}"`));
    if (!feature.lazy) return Promise.resolve(feature);
    if (loading.has(id)) return loading.get(id);

    const promise = (async () => {
      await Promise.all((feature.styles || []).map(loadStyle));
      for (const src of feature.scripts || []) await loadScript(src);
      const manifest = XR.resolve(`features.${id}`);
      const registered = register(manifest);
      try { registered.init?.(); } catch (err) { console.error(`[features] init ${id} failed`, err); }
      return registered;
    })();
    loading.set(id, promise);
    const clear = () => { if (loading.get(id) === promise) loading.delete(id); };
    promise.then(clear, clear);
    return promise;
  }

  /** The command palette uses this on demand so commands from unloaded features remain discoverable. */
  function loadAll() {
    return Promise.all(list.filter((feature) => feature.lazy).map((feature) =>
      load(feature.id).catch((err) => { console.error(`[features] load ${feature.id} failed`, err); return null; })));
  }

  /** Boot helper: resolve eager modules, then register lightweight nav descriptors for lazy ones. */
  function registerAll() {
    for (const name of XR.names("features.").filter((n) => n.split(".").length === 2)) {
      try { const manifest = XR.resolve(name); if (manifest && manifest.id) register(manifest); }
      catch (err) { console.error(`[features] failed to load ${name}`, err); }
    }
    const lazyFeatures = typeof window === "undefined" ? [] : (window.XREELS_MANIFEST?.lazyFeatures || []);
    for (const descriptor of lazyFeatures) {
      if (!byId.has(descriptor.id)) register({ ...descriptor, lazy: true });
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
  return { register, registerAll, get, all, navItems, commands, load, loadAll };
});
