/* ui.keys — keyboard shortcut manager with scopes and two-key chords ("g l").
   keys.bind(scope, "g l", handler, {desc}) ; keys.push(scope) / keys.pop(scope)
   Scope "global" is always active; the top-most pushed scope gets first dibs.
   Shortcuts are ignored while typing in inputs (except Escape). */
XR.define("ui.keys", ["ui.dom"], function (dom) {
  "use strict";
  const scopes = new Map(); // scope → Map(combo → {handler, desc})
  const stack = ["global"];
  let pendingPrefix = "", pendingTimer = 0;

  const norm = (e) => {
    const mods = (e.ctrlKey || e.metaKey ? "mod+" : "") + (e.altKey ? "alt+" : "") + (e.shiftKey && e.key.length > 1 ? "shift+" : "");
    let k = e.key;
    if (k === " ") k = "space";
    else if (k.length === 1) k = k.toLowerCase(); else k = k.toLowerCase();
    return mods + k;
  };
  function bind(scope, combo, handler, { desc = "", allowInInput = false } = {}) {
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    scopes.get(scope).set(combo, { handler, desc, allowInInput });
    return () => scopes.get(scope)?.delete(combo);
  }
  function unbindScope(scope) { scopes.delete(scope); }
  function push(scope) { const i = stack.indexOf(scope); if (i >= 0) stack.splice(i, 1); stack.push(scope); }
  function pop(scope) { const i = stack.indexOf(scope); if (i > 0) stack.splice(i, 1); }
  function lookup(combo, inInput) {
    for (let i = stack.length - 1; i >= 0; i--) {
      const m = scopes.get(stack[i]);
      const hit = m?.get(combo);
      if (hit && (!inInput || hit.allowInInput)) return hit;
    }
    return null;
  }
  function hasPrefix(prefix, inInput) {
    for (const sc of stack) for (const [combo, v] of scopes.get(sc) || []) if (combo.startsWith(prefix + " ") && (!inInput || v.allowInInput)) return true;
    return false;
  }
  function onKey(e) {
    if (e.defaultPrevented) return;
    const inInput = dom.isEditable(e.target);
    const key = norm(e);
    if (pendingPrefix) {
      const chord = pendingPrefix + " " + key;
      pendingPrefix = ""; clearTimeout(pendingTimer);
      const hit = lookup(chord, inInput);
      if (hit) { e.preventDefault(); hit.handler(e); return; }
    }
    if (!inInput && hasPrefix(key, inInput)) { pendingPrefix = key; pendingTimer = setTimeout(() => { pendingPrefix = ""; }, 900); return; }
    const hit = lookup(key, inInput);
    if (hit) { e.preventDefault(); hit.handler(e); }
  }
  function start(target = document) { target.addEventListener("keydown", onKey); }
  function list() { const out = []; for (const [scope, m] of scopes) for (const [combo, v] of m) if (v.desc) out.push({ scope, combo, desc: v.desc }); return out; }
  return { bind, unbindScope, push, pop, start, list, norm };
});
