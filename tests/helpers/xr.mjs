/* Test-only loader for the app's `XR.define` modules. It runs the real source files in a
   fresh VM context, so tests exercise the shipped code, not copies. Dependencies resolve
   lazily, as in the kernel. Fakes can be provided for ports the test does not exercise. */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

export function createXR() {
  const modules = new Map();
  const XR = {
    define(name, deps, factory) { modules.set(name, { deps, factory, api: null }); },
    has: (name) => modules.has(name),
    resolve(name) {
      const m = modules.get(name);
      if (!m) throw new Error(`unknown module ${name}`);
      if (!m.api) m.api = m.factory(...m.deps.map((d) => XR.resolve(d)));
      return m.api;
    },
    provide(name, api) { modules.set(name, { deps: [], factory: () => api, api: null }); },
  };
  const load = (file) => {
    runInNewContext(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"), { XR, console, URL, setTimeout, clearTimeout });  // browsers provide these; a bare VM context does not
  };
  return { XR, load };
}
