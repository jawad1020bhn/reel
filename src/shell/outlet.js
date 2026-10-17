/* shell.outlet — mounts/unmounts features in response to route changes,
   keeps per-route scroll positions and updates the document title. */
XR.define("shell.outlet", ["ui.dom", "ui.widgets", "app.features", "app.nav", "app.playback", "shell.theme", "core.events", "core.domain.events"],
  function (dom, W, features, nav, playback, theme, events, EV) {
    "use strict";
    let host = null, current = null, currentKey = "";
    const scrollMemo = new Map();

    const keyOf = (route) => route.name + JSON.stringify(route.params);

    function unmountCurrent() {
      if (!current) return;
      try { current.unmount?.(); } catch (err) { console.error(`[outlet] unmount ${current.id} failed`, err); }
      current = null;
      dom.clear(host);
      host.scrollTop = 0;
    }
    function mount(route) {
      const f = features.get(route.name);
      if (!f || !f.mount) {
        unmountCurrent();
        host.appendChild(W.empty({ icon: "compass", title: "Nothing here", text: `No screen answers to “${route.path}”.`, action: { label: "Go to Discover", run: () => nav.go("discover") } }));
        theme.setTitle("");
        return;
      }
      const key = keyOf(route);
      if (current && current.id === f.id && key === currentKey && typeof f.update === "function") {
        try { f.update(route); } catch (err) { console.error(`[outlet] update ${f.id} failed`, err); }
        return;
      }
      if (current) scrollMemo.set(currentKey, host.scrollTop);
      playback.pauseAll();
      unmountCurrent();
      current = f; currentKey = key;
      host.dataset.feature = f.id;
      try { f.mount(host, route); }
      catch (err) {
        console.error(`[outlet] mount ${f.id} failed`, err);
        dom.replace(host, W.empty({ icon: "alert", title: `${f.title} crashed`, text: String(err && err.message || err), action: { label: "Reload", run: () => location.reload() } }));
      }
      theme.setTitle(typeof f.pageTitle === "function" ? f.pageTitle(route) : XR.resolve("core.i18n").t(f.title));
      const y = scrollMemo.get(key);
      if (y) requestAnimationFrame(() => { host.scrollTop = y; });
    }
    function start(outletEl) {
      host = outletEl;
      events.bus.on(EV.ROUTE_CHANGED, ({ route }) => mount(route));
      if (nav.current) mount(nav.current);
    }
    return { start, get current() { return current; }, get host() { return host; } };
  });
