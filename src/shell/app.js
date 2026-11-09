/* shell.app — boot sequence and global wiring.
   Order matters: storage → prefs → theme → activity → lock → catalog data →
   features → layout → router → outlet. Each step reports to the splash. */
XR.define("shell.app", ["ui.dom", "ui.keys", "ui.toast", "ui.dialog", "ui.menu", "app.ports.storage", "app.ports.platform", "app.migrations", "app.diagnostics", "app.prefs", "app.activity", "app.lock", "app.importer", "app.catalog", "app.features", "app.nav", "app.playback", "shell.theme", "shell.layout", "shell.outlet", "shell.lockGate", "shell.siteGate", "shell.availability", "shell.splash", "app.ports.offlineCache", "core.events", "core.domain.events"],
  function (dom, keys, toast, dialog, menu, storage, platform, migrations, diag, prefs, activity, lock, importer, catalog, features, nav, playback, theme, layout, outlet, lockGate, siteGate, availability, splash, offline, events, EV) {
    "use strict";

    async function start() {
      /* The site password comes first: a deployed build must not boot (or fetch
         the dataset) before the visitor is let in. No password configured → the
         promise resolves immediately and nothing changes for a local copy.
         The markup splash from index.html has to go first — it is above everything
         else on the page, so leaving it up would hide the passcode form entirely
         (the app then waits for a passcode nobody can type: a deadlock). */
      window.XREELS_READY = true;      // loaders stop showing their own "still opening" notice
      splash.clear();
      try { await siteGate.ensure(); } catch (err) { console.error("[app] site gate failed", err); }
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
        availability.start();   // opening hours: warns, then re-locks when the window closes
        const landing = catalog.size ? prefs.get("landing") : "import";
        nav.start(landing);
        outlet.start(layout.outlet);
        if (!catalog.size && nav.current?.name !== "import") nav.go("import", {}, {}, { replace: true });
        splash.hide();
        diag.mark("app:ready");
        document.documentElement.classList.add("app-ready");
        /* Only now, with the app on screen, may the service worker take over: registering
           earlier would put a worker install in front of the first paint. */
        try { offline.start({ enabled: prefs.get("offlineCache") !== false }); } catch (err) { console.warn("[app] offline cache unavailable", err); }
        /* Paint and boot timings, so "it feels slow" can be answered with numbers. */
        try {
          const marks = (performance.getEntriesByType?.("mark") || []).filter((m) => m.name.startsWith("xreels:"));
          const paint = performance.getEntriesByType?.("paint") || [];
          for (const m of marks) diag.mark(m.name.replace("xreels:", "") + " @" + Math.round(m.startTime) + "ms");
          for (const p of paint) diag.mark(`${p.name} @${Math.round(p.startTime)}ms`);
        } catch { /* diagnostics must never break boot */ }
      } catch (err) {
        console.error("[app] boot failed", err);
        splash.clear();
        splash.fail(err);
      }
    }

    function wireGlobals() {
      /* Keyboard insets: Chrome Android resizes the layout viewport, other engines
         overlay it. --kb-inset is 0 when nothing is covered, so bottom sheets can
         pad by it unconditionally. */
      const vv = window.visualViewport;
      if (vv) {
        const syncKeyboardInset = () => {
          const inset = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
          document.documentElement.style.setProperty("--kb-inset", inset + "px");
        };
        vv.addEventListener("resize", syncKeyboardInset, { passive: true });
        vv.addEventListener("scroll", syncKeyboardInset, { passive: true });
        syncKeyboardInset();
      }
      /* Pause when the page is hidden. Resume only when the same video was actually
         playing, we were away briefly, and the user is still in Watch. */
      let hiddenAt = 0, resumeHandle = null;
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          const active = playback.active;
          resumeHandle = active && active.video && !active.video.paused ? active : null;
          hiddenAt = Date.now();
          playback.pauseAll();
          return;
        }
        const handle = resumeHandle;
        resumeHandle = null;
        if (handle && handle.video?.isConnected && Date.now() - hiddenAt < 60000 && nav.current?.name === "watch") {
          handle.play();
        }
      });
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
