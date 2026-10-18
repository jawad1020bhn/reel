/* ui.imageload — one place that knows when a content <img> has pixels.
   Adds `.is-loaded` on load/error (and sweeps already-decoded images right after a
   route mounts), so every surface can hold a skeleton until the frame arrives
   instead of popping in. Cached images fire `load` after insertion, but the sweep
   closes the gap where an image is decoded before the event listener sees it.

   Deliberately CSS-agnostic: consumers opt in by styling `:has(img:not(.is-loaded))`
   or `img:not(.is-loaded)`. Avatars are never swept because a shimmering 24px circle
   reads as noise, not progress. */
XR.define("ui.imageload", [], function () {
  "use strict";
  const MARK = "is-loaded";
  let installed = false;

  function mark(img) {
    if (img.tagName !== "IMG" || img.classList.contains(MARK)) return;
    if (img.complete && img.naturalWidth > 0) {
      img.classList.remove("is-broken");
      img.classList.add(MARK);
    }
  }
  function sweep(root) {
    if (!root) return;
    if (root.tagName === "IMG") mark(root);
    if (!root.querySelectorAll) return;
    for (const img of root.querySelectorAll("img:not(.avatar)")) mark(img);
  }
  function install() {
    if (installed || typeof document === "undefined") return;
    installed = true;
    document.addEventListener("load", (e) => {
      if (e.target && e.target.tagName === "IMG" && !e.target.classList.contains("avatar")) {
        e.target.classList.remove("is-broken");
        e.target.classList.add(MARK);
      }
    }, true);
    /* a dead URL gets its own flag: consumers can fall back to a poster; the
       loading animation stops while the slot retains its reserved dimensions */
    document.addEventListener("error", (e) => {
      if (e.target && e.target.tagName === "IMG") e.target.classList.add("is-broken");
    }, true);
  }
  return { install, sweep };
});
