/* app.importer — how posts get into the catalog, and the registry of *libraries*.

   Sources (DataSourcePort implementations live in infra.datasources):
     auto   : data/posts.js (script tag) → data/posts.json (http only)
     file   : a File dropped/picked by the user
     text   : JSON pasted by the user
     url    : a remote JSON (http contexts only)

   Libraries (datasets). `xreels.datasets.v1` = { active, items: [{id, key, label, count, adapter, fingerprint, at}] }.
     "auto"  is the implicit library for data/posts.js (cached under xreels.dataset.auto.v1).
     Every upload/paste can REPLACE the active imported library, MERGE into it, or become a NEW one.
     Switching libraries only changes which Post[] the catalog holds; activity is global (keyed by post id).

   What gets stored is always the *normalised* Post[] (small, vendor-free), keyed with a
   fingerprint so an unchanged data/posts.js costs no re-parsing. Large exports are indexed in
   chunks (and in a Worker when served over http) so the splash keeps animating. */
XR.define("app.importer", ["app.ports.storage", "app.ports.dataSources", "app.ports.platform", "core.adapters.registry", "core.util", "core.events", "core.domain.events", "app.catalog", "app.prefs", "app.diagnostics"],
  function (storage, sources, platform, registry, util, events, EV, catalog, prefs, diag) {
    "use strict";
    const KEY_AUTO = "xreels.dataset.auto.v1";       // cache of the normalised data/posts.js
    const KEY_INDEX = "xreels.datasets.v1";          // libraries index
    const keyFor = (id) => `xreels.dataset.${id}.v1`;
    const WORKER_MIN = 3000;                         // posts; below this the main thread is fine

    const progress = (phase, message, extra = {}) => events.bus.emit(EV.DATASET_PROGRESS, { phase, message, ...extra });
    const mark = (name) => diag.mark(`importer:${name}`);

    function fingerprintOf(json) {
      const text = typeof json === "string" ? json : JSON.stringify(json);
      return `${text.length}:${util.fnv1a(text.length > 4e6 ? text.slice(0, 2e6) + text.slice(-2e6) : text)}`;
    }

    /* ------------------------------------------------------------- index -- */
    let index = null;
    async function loadIndex() {
      if (!index) index = (await storage.get(KEY_INDEX).catch(() => null)) || { active: "auto", items: [] };
      if (!Array.isArray(index.items)) index.items = [];
      if (!index.active) index.active = "auto";
      return index;
    }
    const saveIndex = () => storage.set(KEY_INDEX, index).catch(() => {});
    /** All libraries, auto first. */
    async function libraries() {
      await loadIndex();
      const auto = { id: "auto", label: "data/posts.js", builtin: true, count: catalog.source?.id === "auto" ? catalog.size : (await storage.get(KEY_AUTO).catch(() => null))?.posts?.length || 0 };
      return [auto, ...index.items.map((d) => ({ ...d, builtin: false }))];
    }
    const activeId = async () => (await loadIndex()).active;

    /* ----------------------------------------------------------- analyse -- */
    async function normalizeInput(input, label) {
      const json = registry.parseInput(input);
      const detected = registry.detect(json);
      if (!detected) throw new Error("Unrecognised format — see docs/DATA-FORMATS.md for the shapes XReels understands.");
      const approx = Array.isArray(json) ? json.length : (json.bookmarks || json.tweets || json.posts || json.data || []).length || 0;
      let result = null;
      if (approx >= WORKER_MIN && !platform.isFile() && typeof Worker === "function" && XR.has("infra.workers")) {
        try { result = await XR.resolve("infra.workers").normalize(json, { keepTextOnly: true }, (done, total) => progress("index", `Indexing ${done}/${total}…`, { progress: done / total })); }
        catch (err) { console.warn("[importer] worker failed, falling back to main thread", err); }
      }
      if (!result) result = await registry.normalizeAsync(json, { keepTextOnly: true }, (done, total) => { if (total > 1500) progress("index", `Indexing ${done}/${total}…`, { progress: done / total }); });
      return { json, result, detected };
    }

    /**
     * Parse + normalise without touching the catalog (used for previews). Includes a diff
     * against the current library so the Import page can say what is new / gone / changed.
     */
    async function analyze(input, { label = "import" } = {}) {
      const { json, result } = await normalizeInput(input, label);
      const withMedia = result.posts.filter((p) => p.media.length).length;
      const videos = result.posts.filter((p) => p.media.some((m) => m.kind !== "photo")).length;
      return { ...result, label, fingerprint: fingerprintOf(json), withMedia, videos, creators: new Set(result.posts.map((p) => p.author.username)).size, diff: diffAgainstCatalog(result.posts) };
    }
    /** {added, missing, changed, same, missingIds, addedIds} relative to what is loaded now. */
    function diffAgainstCatalog(posts) {
      const incoming = new Map(posts.map((p) => [p.id, p]));
      const addedIds = [], missingIds = [], changedIds = [];
      let same = 0;
      for (const p of posts) if (!catalog.post(p.id)) addedIds.push(p.id);
      for (const p of catalog.posts) {
        const q = incoming.get(p.id);
        if (!q) { missingIds.push(p.id); continue; }
        if (q.text !== p.text || q.media.length !== p.media.length || (q.metrics.likes || 0) !== (p.metrics.likes || 0)) changedIds.push(p.id); else same++;
      }
      return { added: addedIds.length, missing: missingIds.length, changed: changedIds.length, same, addedIds, missingIds, changedIds, empty: catalog.size === 0 };
    }

    async function activate(posts, source) {
      const list = prefs.get("keepTextOnly") ? posts : posts.filter((p) => p.media.length);
      progress("index", "Building your library index…");
      mark("catalog-index:start");
      await catalog.load(list, source);
      mark("catalog-index:end");
      return catalog.source;
    }

    /* --------------------------------------------------------- auto path -- */
    async function loadAuto() {
      const auto = sources.get("auto");
      if (!auto?.available()) return null;
      progress("read", "Reading data/posts.js…");
      mark("auto-read:start");
      const res = await auto.load();          // throws with a precise message on a syntax error
      mark("auto-read:end");
      if (!res) return null;
      const input = res.json ?? res.text;
      mark("fingerprint:start");
      const fp = fingerprintOf(input);
      mark("fingerprint:end");
      mark("auto-cache-read:start");
      const cached = await storage.get(KEY_AUTO).catch(() => null);
      mark("auto-cache-read:end");
      if (cached && cached.fingerprint === fp && Array.isArray(cached.posts) && cached.posts.length) {
        mark("normalize:cache-hit");
        return { posts: cached.posts, source: { id: "auto", label: res.label, fingerprint: fp, adapter: cached.adapter, cached: true } };
      }
      progress("index", "Indexing posts…");
      mark("normalize:start");
      const { result } = await normalizeInput(input, res.label);
      mark("normalize:end");
      mark("auto-cache-write:start");
      await storage.set(KEY_AUTO, { fingerprint: fp, posts: result.posts, adapter: result.adapter, at: Date.now() }).catch(() => {});
      mark("auto-cache-write:end");
      return { posts: result.posts, source: { id: "auto", label: res.label, fingerprint: fp, adapter: result.adapter, cached: false } };
    }
    async function loadLibrary(id) {
      await loadIndex();
      const meta = index.items.find((d) => d.id === id);
      if (!meta) return null;
      mark("library-cache-read:start");
      const stored = await storage.get(meta.key || keyFor(id)).catch(() => null);
      mark("library-cache-read:end");
      if (!stored || !Array.isArray(stored.posts) || !stored.posts.length) return null;
      return { posts: stored.posts, source: { id, label: meta.label, fingerprint: stored.fingerprint || "", adapter: stored.adapter, at: stored.at, library: meta } };
    }

    /** Called once at boot (and after switching libraries). Resolves with the catalog source. */
    async function boot() {
      mark("boot:start");
      mark("dataset-index-read:start");
      await loadIndex();
      mark("dataset-index-read:end");
      const steps = index.active && index.active !== "auto" ? [() => loadLibrary(index.active), loadAuto] : [loadAuto];
      let lastError = null;
      for (const step of steps) {
        try {
          const found = await step();
          if (found) {
            const source = await activate(found.posts, found.source);
            mark("boot:end");
            return source;
          }
        } catch (err) {
          console.error("[importer] source failed", err);
          lastError = err;
          events.bus.emit(EV.DATASET_ERROR, { error: err });
        }
      }
      /* nothing usable: fall back to the first stored library, if any */
      for (const d of index.items) {
        try {
          const found = await loadLibrary(d.id);
          if (found) {
            index.active = d.id;
            await saveIndex();
            const source = await activate(found.posts, found.source);
            mark("boot:end");
            return source;
          }
        } catch { /* next */ }
      }
      const source = await activate([], { id: "none", label: "No data", error: lastError ? String(lastError.message || lastError) : "" });
      mark("boot:end");
      return source;
    }

    /* --------------------------------------------------------- user path -- */
    /**
     * Commit a previously analysed import.
     * @param {Awaited<ReturnType<analyze>>} an
     * @param {{mode?: "replace"|"merge"|"new", merge?: boolean, name?: string}} opts
     *   replace → overwrite the active imported library (or create "imported" when the active one is data/posts.js)
     *   merge   → union by post id with the current catalog
     *   new     → create a separate library and switch to it
     */
    async function commit(an, opts = {}) {
      await loadIndex();
      const mode = opts.mode || (opts.merge ? "merge" : "replace");
      let posts = an.posts;
      if (mode === "merge" && catalog.size) {
        const seen = new Set(posts.map((p) => p.id));
        posts = [...posts, ...catalog.posts.filter((p) => !seen.has(p.id))];
      }
      let id = index.active && index.active !== "auto" ? index.active : "imported";
      if (mode === "new") id = "lib-" + util.uid();
      let meta = index.items.find((d) => d.id === id);
      const label = opts.name || (mode === "merge" && meta ? meta.label : an.label);
      if (!meta) { meta = { id, key: keyFor(id), label, count: 0, adapter: an.adapter, fingerprint: an.fingerprint, at: Date.now() }; index.items.push(meta); }
      Object.assign(meta, { label, count: posts.length, adapter: an.adapter, fingerprint: an.fingerprint, at: Date.now() });
      await storage.set(meta.key, { fingerprint: an.fingerprint, posts, adapter: an.adapter, label, at: Date.now() });
      index.active = id;
      await saveIndex();
      return activate(posts, { id, label, fingerprint: an.fingerprint, adapter: an.adapter, at: Date.now(), library: meta });
    }
    async function importFile(file) { const src = sources.get("file"); const res = await src.load(file); return analyze(res.text, { label: res.label }); }
    async function importText(text, label = "Pasted JSON") { return analyze(text, { label }); }
    async function importUrl(url) { const src = sources.get("url"); if (!src?.available()) throw new Error("URL import needs the app to be served over http(s)."); const res = await src.load(url); return analyze(res.json ?? res.text, { label: res.label }); }

    /* ------------------------------------------------------- libraries -- */
    async function switchTo(id) {
      await loadIndex();
      if (id !== "auto" && !index.items.some((d) => d.id === id)) throw new Error("Unknown library " + id);
      index.active = id; await saveIndex();
      sources.clearGlobals?.();
      return boot();
    }
    async function renameLibrary(id, name) { await loadIndex(); const d = index.items.find((x) => x.id === id); if (d) { d.label = String(name || d.label).slice(0, 80); await saveIndex(); if (catalog.source?.id === id) catalog.source.label = d.label; } }
    async function removeLibrary(id) {
      await loadIndex();
      const d = index.items.find((x) => x.id === id);
      if (!d) return;
      await storage.remove(d.key || keyFor(id)).catch(() => {});
      index.items = index.items.filter((x) => x.id !== id);
      if (index.active === id) index.active = "auto";
      await saveIndex();
      if (catalog.source?.id === id || index.active === "auto") return boot();
    }
    /** Back-compat name used by Settings: removes the active imported library. */
    async function forgetImported() { const id = (await loadIndex()).active; if (id && id !== "auto") return removeLibrary(id); return boot(); }
    async function clearCache() { await storage.remove(KEY_AUTO); }
    async function reload() { await clearCache(); sources.clearGlobals?.(); return boot(); }

    /** Export helpers (the normalised shape, re-importable). */
    function exportPosts(posts, { asScript = false } = {}) {
      const payload = { export_version: "xreels-1", exported_at: new Date().toISOString(), count: posts.length, posts };
      const json = JSON.stringify(payload, null, 1);
      return asScript ? `window.XREELS_DATA =\n${json}\n;\n` : json;
    }

    return {
      boot, analyze, commit, importFile, importText, importUrl, diffAgainstCatalog,
      libraries, activeId, switchTo, renameLibrary, removeLibrary, forgetImported, clearCache, reload,
      exportPosts, fingerprintOf, KEY_AUTO, KEY_INDEX, keyFor,
    };
  });
