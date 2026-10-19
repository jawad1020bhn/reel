/* ui.overlayHistory — makes the Android back gesture close the top overlay
   before it navigates. Menus, dialogs and the palette register their close
   function; every open overlay keeps one history entry on top of the current
   route. Back pops that entry and closes the overlay.

   The hash router never sees these entries: pushState does not fire
   hashchange. When overlays are closed by code we hand the entries back with
   history.back(), but never if a navigation happened in the meantime — a
   palette command that changes route must not be undone by our cleanup. */
XR.define("ui.overlayHistory", [], function () {
  "use strict";
  const KEY = "xrOverlay";
  const stack = [];
  let depth = 0;        // history entries we pushed that are still above the route
  let timer = 0;
  let ignorePops = 0;   // synthetic back traversals we issued ourselves

  const isOurs = () => !!(history.state && history.state[KEY]);

  function register(close) {
    clearTimeout(timer);
    const entry = { close };
    stack.push(entry);
    try {
      history.pushState({ ...(history.state || {}), [KEY]: true }, "", location.href);
      depth += 1;
    } catch {
      /* file:// or blocked history: overlays keep their own controls */
    }
    return entry;
  }

  function releaseSoon() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (stack.length) return;
      /* The route changed after the last overlay closed: our entries now sit
         below the new page, so going back would undo the navigation. */
      if (!isOurs()) { depth = 0; return; }
      while (depth > 0) {
        depth -= 1;
        ignorePops += 1;
        try { history.back(); } catch { ignorePops = Math.max(0, ignorePops - 1); break; }
      }
    }, 40);
  }

  function release(entry) {
    const i = stack.indexOf(entry);
    if (i < 0) return;
    stack.splice(i, 1);
    if (!stack.length) releaseSoon();
  }

  function onPop() {
    if (ignorePops > 0) { ignorePops -= 1; return; }
    if (!stack.length) { depth = 0; return; }
    const entry = stack.pop();
    depth = Math.max(0, depth - 1);
    try { entry.close(); } catch (err) { console.error("[overlay] close failed", err); }
  }

  if (typeof window !== "undefined") window.addEventListener("popstate", onPop);
  return { register, release, get depth() { return stack.length; } };
});
