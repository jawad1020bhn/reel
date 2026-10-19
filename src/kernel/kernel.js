/* =============================================================================
   saves kernel — a 90-line module system + dependency container.

   Why this exists: the app must run from a double-clicked index.html. On
   file:// Chrome refuses ES-module imports, so every file is a classic
   <script>. The kernel gives those scripts what modules would have given them:
     • named units with explicit dependencies  (XR.define)
     • lazy, memoised construction               (XR.resolve)
     • dependency inversion                      (a module asks for a *name*,
       e.g. "app.ports.storage", and never knows which implementation answers)
     • load-order independence                   (definition is lazy; only the
       kernel must load first and boot.js last)

   Layer rule (see docs/ARCHITECTURE.md):
     core.*  →  app.*  →  infra.* / ui.*  →  shell.* / features.*
   A module may only depend on names from its own layer or layers to the left.
   ============================================================================= */
(function (global) {
  "use strict";

  /** @type {Map<string, {deps: string[], factory: Function, layer: string}>} */
  const definitions = new Map();
  /** @type {Map<string, any>} */
  const instances = new Map();
  /** Names bound at runtime (e.g. "app.ports.storage" → "infra.storage.auto"). */
  const bindings = new Map();

  const LAYER_ORDER = ["core", "app", "infra", "ui", "shell", "features", "tests"];
  const layerOf = (name) => String(name).split(".")[0];

  function define(name, deps, factory) {
    if (typeof deps === "function") { factory = deps; deps = []; }
    if (definitions.has(name)) throw new Error(`XR: module "${name}" defined twice`);
    definitions.set(name, { deps: deps || [], factory, layer: layerOf(name) });
  }

  /** Dependency inversion: make an abstract name resolve to a concrete module. */
  function bind(abstractName, concreteName) { bindings.set(abstractName, concreteName); }

  function checkLayer(from, to) {
    const a = LAYER_ORDER.indexOf(layerOf(from)), b = LAYER_ORDER.indexOf(layerOf(to));
    if (a === -1 || b === -1) return;
    // infra and ui are siblings; everything else must point left.
    const sibling = (x, y) => (x === "infra" && y === "ui") || (x === "ui" && y === "infra");
    if (b > a && !sibling(layerOf(from), layerOf(to))) {
      console.warn(`XR: layer violation — "${from}" (${layerOf(from)}) depends on "${to}" (${layerOf(to)})`);
    }
    // features are isolated: features.a.* may not depend on features.b.*
    if (layerOf(from) === "features" && layerOf(to) === "features") {
      const fa = String(from).split(".")[1], fb = String(to).split(".")[1];
      if (fa !== fb) console.warn(`XR: cross-feature dependency — "${from}" depends on "${to}" (use events or app.* services instead)`);
    }
  }

  function resolve(name, stack = []) {
    const target = bindings.get(name) || name;
    if (instances.has(target)) return instances.get(target);
    const def = definitions.get(target);
    if (!def) {
      const by = stack.length ? ` (required by "${stack[stack.length - 1]}")` : "";
      throw new Error(`XR: module "${name}" is not defined${by}`);
    }
    if (stack.includes(target)) throw new Error(`XR: circular dependency ${[...stack, target].join(" → ")}`);
    const next = [...stack, target];
    const args = def.deps.map((dep) => { checkLayer(target, dep); return resolve(dep, next); });
    const instance = def.factory(...args);
    instances.set(target, instance === undefined ? {} : instance);
    return instances.get(target);
  }

  /** Resolve every module whose name starts with a prefix (used to wake features). */
  function resolveAll(prefix) {
    return [...definitions.keys()].filter((n) => n.startsWith(prefix)).sort().map((n) => resolve(n));
  }

  const XR = {
    define, bind, resolve, resolveAll,
    has: (name) => definitions.has(bindings.get(name) || name),
    names: (prefix = "") => [...definitions.keys()].filter((n) => n.startsWith(prefix)).sort(),
    /** Test seam: throw away instances so a spec can rebuild the graph. */
    _reset: () => instances.clear(),
    version: "1.0.0",
  };

  global.XR = XR;
})(typeof window !== "undefined" ? window : globalThis);
