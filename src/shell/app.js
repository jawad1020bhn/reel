/* shell.app — boot sequence and global wiring.
   Order matters: storage → prefs → theme → activity → lock → catalog data →
   features → layout → router → outlet. Each step reports to the splash. */
XR.define("shell.app", ["ui.dom", "ui.keys", "ui.toast", "ui.dialog", "ui.menu", "app.ports.storage", "app.ports.platform", "app.migrations", "app.diagnostics", "app.prefs", "app.activity", "app.lock", "app.importer", "app.catalog", "app.features", "app.nav", "app.playback", "shell.theme", "shell.layout", "shell.outlet", "shell.lockGate", "shell.splash", "core.events", "core.domain.events"],
  function (dom, keys, toast, dialog, menu, storage, platform, migrations, diag, prefs, activity, lock, importer, catalog, features, nav, playback, theme, layout, outlet, lockGate, splash, events, EV) {
    "use strict";

    async function start() {
      splash.show();
      try {
        diag.mark("boot:start");
        splash.set("Opening local storage…");
        await storage.ready?.catch?.(() => {});
        diag.mark("storage:ready");
        await migrations.run();
        diag.mark("migrations:done");
        await prefs.load();
        theme.start();
        splash.set("Loading your activity…");
        await activity.load();
        await lock.load();
        diag.mark("activity:ready");
        splash.set("Reading posts…");
        await importer.boot();
        diag.mark("catalog:ready");
        splash.set("Building the interface…");
        features.registerAll();
        for (const f of features.all()) { try { f.init?.(); } catch (err) { console.error(`[app] init ${f.id} failed`, err); } }
        layout.build();
        wireGlobals();
        keys.start(document);
        lockGate.start();
        const landing = catalog.size ? prefs.get("landing") : "import";
        nav.start(landing);
        outlet.start(layout.outlet);
        if (!catalog.size && nav.current?.name !== "import") nav.go("import", {}, {}, { replace: true });
        splash.hide();
        diag.mark("app:ready");
        document.documentElement.classList.add("app-ready");
      } catch (err) {
        console.error("[app] boot failed", err);
        splash.fail(err);
      }
    }

    function wireGlobals() {
      // pause media when the tab is hidden; resume the active one when back
      document.addEventListener("visibilitychange", () => { if (document.hidden) playback.pauseAll(); });
      /* Viewer code is loaded only on first use. Queue the latest request until its
         listener and stylesheet are ready, then replay it once. */
      let viewerLoading = false, queuedViewer = null;
      events.bus.on(EV.VIEWER_OPEN, (payload) => {
        const viewer = features.get("viewer");
        if (viewer && !viewer.lazy) return;
        queuedViewer = payload;
        if (viewerLoading) return;
        viewerLoading = true;
        features.load("viewer").then(() => {
          viewerLoading = false;
          const pending = queuedViewer; queuedViewer = null;
          if (pending) events.bus.emit(EV.VIEWER_OPEN, pending);
        }).catch((err) => {
          viewerLoading = false; queuedViewer = null;
          console.error("[app] viewer failed to load", err);
          toast.toast("Couldn't open the viewer: " + String(err && err.message || err), "error");
        });
      });
      // drag & drop a JSON/JS export anywhere → Import screen handles it
      let dragDepth = 0;
      document.addEventListener("dragenter", (e) => { if (hasFiles(e)) { dragDepth++; document.documentElement.classList.add("is-dragging"); } });
      document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.documentElement.classList.remove("is-dragging"); } });
      document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
      document.addEventListener("drop", (e) => {
        dragDepth = 0; document.documentElement.classList.remove("is-dragging");
        if (!hasFiles(e)) return;
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) { nav.go("import"); setTimeout(() => events.bus.emit(EV.DATASET_PROGRESS, { phase: "dropped", message: file.name, file }), 50); }
      });
      // global shortcuts
      const g = (combo, run, desc) => keys.bind("global", combo, run, { desc });
      for (const f of features.all()) if (f.nav && f.key) g("g " + f.key, () => nav.go(f.id), `Go to ${f.title}`);
      g("/", () => layout.focusSearch(), "Focus search");
      g("mod+k", () => events.bus.emit(EV.PALETTE_OPEN, {}), "Command palette");
      g("m", () => playback.toggleMuted(), "Mute / unmute");
      g("shift+l", () => { if (lock.isEnabled()) lock.lock(); else toast.toast("Set a PIN in Settings → Privacy first"); }, "Lock");
      g("shift+b", () => prefs.set({ blur: !prefs.get("blur") }), "Toggle privacy blur");
      g("shift+?", () => events.bus.emit(EV.PALETTE_OPEN, { query: "?" }), "Show shortcuts");
      g("escape", () => { menu.close(); }, "");
      // playback hint when autoplay-with-sound was blocked
      let warned = false;
      events.bus.on(EV.PLAYBACK_CHANGED, ({ muted }) => { if (muted && !warned && playback.userUnmuted) { warned = true; } });
      events.bus.on(EV.DATASET_ERROR, ({ error }) => toast.toast(String(error?.message || error), "error", { timeout: 6000 }));
    }
    const hasFiles = (e) => !!(e.dataTransfer && [...e.dataTransfer.types || []].includes("Files"));

    return { start };
  });
