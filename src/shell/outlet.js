/* shell.outlet — mounts/unmounts features in response to route changes, keeps
   per-route scroll positions, animates the swap and updates the document title.

   Motion: when the browser supports the View Transitions API we let it snapshot the
   page area and cross-fade old → new while the new DOM is already mounted (so the
   route is interactive the moment the animation starts). Without it the feature's
   own `page-in` entrance still runs. Reduced-motion users get a hard cut either way. */
XR.define("shell.outlet", ["ui.dom", "ui.widgets", "ui.imageload", "app.features", "app.nav", "app.playback", "shell.theme", "core.events", "core.domain.events"],
  function (dom, W, imageload, features, nav, playback, theme, events, EV) {
    "use strict";
    let host = null, current = null, currentKey = "", booted = false;
    let wanted = null; /* the most recent route the shell was asked to show */
    const scrollMemo = new Map();
    const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    let vtRunning = null, vtSeq = 0;

    const keyOf = (route) => route.name + JSON.stringify(route.params);
    const reduced = () => (mq && mq.matches) || document.documentElement.dataset.motion === "reduce";
    const canTransition = () =>
      booted &&
      typeof document.startViewTransition === "function" &&
      document.visibilityState === "visible" &&
      !reduced();

    function unmountCurrent() {
      if (!current) return;
      try { current.unmount?.(); } catch (err) { console.error(`[outlet] unmount ${current.id} failed`, err); }
      current = null;
      dom.clear(host);
      host.scrollTop = 0;
    }

    /** Mount a route. Everything here runs inside the transition callback, so it must
        stay synchronous: the new page has to exist before the snapshot is taken. */
    function apply(route) {
      wanted = route;
      const f = features.get(route.name);
      const key = keyOf(route);
      if (current) scrollMemo.set(currentKey, host.scrollTop);
      playback.pauseAll();
      unmountCurrent();

      if (!f || !f.mount) {
        host.dataset.feature = "notfound";
        host.appendChild(W.empty({
          icon: "compass",
          title: "Nothing here",
          text: `No screen answers to “${route.path}”.`,
          action: { label: "Go to Discover", run: () => nav.go("discover") },
        }));
        theme.setTitle("");
      } else {
        current = f; currentKey = key;
        host.dataset.feature = f.id;
        try { f.mount(host, route); }
        catch (err) {
          console.error(`[outlet] mount ${f.id} failed`, err);
          dom.replace(host, W.empty({ icon: "alert", title: `${f.title} crashed`, text: String(err && err.message || err), action: { label: "Reload", run: () => location.reload() } }));
        }
        theme.setTitle(typeof f.pageTitle === "function" ? f.pageTitle(route) : XR.resolve("core.i18n").t(f.title));
      }

      /* restore scroll synchronously: the View Transition snapshot is taken after this
         callback returns, so a rAF here would photograph the page at the top. */
      const y = scrollMemo.get(key);
      if (y) {
        host.scrollTop = y;
        /* a second pass once the browser has laid the page out; skipped while a
           View Transition is mid-flight to keep the snapshot stable */
        requestAnimationFrame(() => { if (!vtRunning && Math.abs(host.scrollTop - y) > 2) host.scrollTop = y; });
      }
      imageload.sweep(host);
    }

    /** If the newest transition was skipped before its update callback ran, the DOM
        can still be showing the previous screen. Make sure the route in the URL wins. */
    function catchUp() {
      if (!wanted) return;
      const f = features.get(wanted.name);
      if (current && f && current.id === f.id && keyOf(wanted) === currentKey) return;
      apply(wanted);
    }

    function transitionTo(route) {
      if (vtRunning) {
        /* a second navigation landed mid-animation: finish the old snapshot now,
           then run the new one from whatever is actually on screen */
        const prev = vtRunning; vtRunning = null;
        try { prev.skipTransition(); } catch { /* already finished */ }
      }
      const seq = ++vtSeq;
      let t;
      try {
        t = document.startViewTransition(() => {
          /* a skipped transition can still invoke its callback later; never let an
             old snapshot overwrite a newer route */
          if (route !== wanted) return;
          apply(route);
          /* the snapshot is the entrance; a second page-in would double the fade */
          const fresh = host.firstElementChild;
          if (fresh) fresh.style.animation = "none";
        });
      } catch {
        apply(route);
        return;
      }
      vtRunning = t;
      const done = () => {
        if (seq !== vtSeq) return;
        vtRunning = null;
        catchUp();
      };
      t.finished.then(done, done);
      /* a newer navigation skips this transition; the API rejects `ready` and Chrome
         reports that as an uncaught rejection unless somebody listens */
      t.ready.then(null, () => {});
      t.updateCallbackDone.then(null, (err) => console.error("[outlet] transition update failed", err));
    }

    function mount(route) {
      wanted = route;
      const f = features.get(route.name);
      const key = keyOf(route);
      /* query-only updates (filters, sort) re-render in place — never animate those,
         it would make every chip press feel like a page load */
      if (f && current && current.id === f.id && key === currentKey && typeof f.update === "function") {
        try { f.update(route); } catch (err) { console.error(`[outlet] update ${f.id} failed`, err); }
        return;
      }
      if (canTransition()) transitionTo(route);
      else apply(route);
    }

    function start(outletEl) {
      host = outletEl;
      imageload.install();
      events.bus.on(EV.ROUTE_CHANGED, ({ route }) => mount(route));
      if (nav.current) {
        apply(nav.current);
        booted = true;
        imageload.sweep(host);
      }
    }
    return { start, get current() { return current; }, get host() { return host; } };
  });
