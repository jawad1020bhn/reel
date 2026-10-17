/* app.nav — routing facade over the RouterPort. Features call nav.go(...) and
   never touch location.hash themselves, so the routing scheme can change in one place.

   Route shape: { name, params: {…path params}, query: {…} , path, raw }
   Patterns are registered by features through app.features (manifest.route). */
XR.define("app.nav", ["app.ports.router", "core.events", "core.domain.events"], function (router, events, EV) {
  "use strict";
  const routes = []; // { name, pattern: "/library", keys: [], regex }
  let current = null, started = false;

  function compile(pattern) {
    const keys = [];
    const regex = new RegExp("^" + pattern.replace(/\/:(\w+)\??/g, (_, k) => { keys.push(k); return "(?:/([^/]+))?"; }).replace(/\//g, "\\/") + "/?$", "i");
    return { keys, regex };
  }
  function register(name, pattern) { routes.push({ name, pattern, ...compile(pattern) }); }

  function match(path) {
    for (const r of routes) {
      const m = r.regex.exec(path);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { if (m[i + 1] !== undefined) params[k] = decodeURIComponent(m[i + 1]); });
        return { name: r.name, params };
      }
    }
    return null;
  }
  function parse(raw) {
    const [path = "/", qs = ""] = raw.split("?");
    const query = {};
    for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
    const found = match(path || "/");
    return { name: found?.name || "notfound", params: found?.params || {}, query, path: path || "/", raw };
  }
  function build(name, params = {}, query = {}) {
    const r = routes.find((x) => x.name === name);
    if (!r) throw new Error(`Unknown route "${name}"`);
    let path = r.pattern;
    for (const k of r.keys) path = path.replace(new RegExp(`/:${k}\\??`), params[k] !== undefined && params[k] !== "" ? "/" + encodeURIComponent(params[k]) : "");
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    const s = qs.toString();
    return path + (s ? "?" + s : "");
  }
  function go(name, params, query, { replace = false } = {}) { router.navigate(build(name, params, query), { replace }); }
  function goPath(path, { replace = false } = {}) { router.navigate(path, { replace }); }
  function setQuery(query, { replace = true } = {}) { if (current) go(current.name, current.params, query, { replace }); }
  function back(fallbackName = "discover") { if (history.length > 1) router.back(); else go(fallbackName); }

  function handle(raw) {
    const prev = current;
    current = parse(raw);
    events.bus.emit(EV.ROUTE_CHANGED, { route: current, prev });
  }
  function start(defaultName = "discover") {
    if (started) return current;
    started = true;
    router.onChange(handle);
    const raw = router.current();
    if (!raw || raw === "/") { go(defaultName, {}, {}, { replace: true }); if (!current) handle(router.current()); }
    else handle(raw);
    return current;
  }
  return { register, start, go, goPath, setQuery, back, build, parse, get current() { return current; }, routes: () => routes.slice() };
});
