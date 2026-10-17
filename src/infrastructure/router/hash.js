/* infra.router.hash — RouterPort on location.hash ("#/library?kind=short").
   history.pushState is blocked on file:// in Chromium; hash changes are not. */
XR.define("infra.router.hash", [], function () {
  "use strict";
  const listeners = new Set();
  let bound = false;
  const read = () => { const h = (location.hash || "").replace(/^#/, ""); return h.startsWith("/") ? h : "/" + h; };
  function bind() {
    if (bound || typeof window === "undefined") return;
    bound = true;
    window.addEventListener("hashchange", () => { const p = read(); for (const fn of [...listeners]) fn(p); });
  }
  return {
    current: read,
    href: (path) => "#" + (path.startsWith("/") ? path : "/" + path),
    navigate(path, { replace = false } = {}) {
      const target = "#" + (path.startsWith("/") ? path : "/" + path);
      if (location.hash === target) { for (const fn of [...listeners]) fn(read()); return; }
      if (replace) { const url = location.href.replace(/#.*$/, "") + target; location.replace(url); }
      else location.hash = target;
    },
    back() { history.back(); },
    onChange(fn) { bind(); listeners.add(fn); return () => listeners.delete(fn); },
  };
});
