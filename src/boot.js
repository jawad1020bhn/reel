/* boot.js — the composition root. The ONLY place that knows which concrete
   infrastructure answers each application port. Loaded last by index.html. */
(function () {
  "use strict";
  if (!window.XR) { document.body.innerHTML = "<p style='font:16px system-ui;padding:2rem'>kernel.js did not load — check the &lt;script&gt; order in index.html.</p>"; return; }

  /* 1. wire ports → implementations */
  /* tests/index.html sets window.XREELS_TEST so the suite never touches your real library */
  const TEST = (typeof window !== "undefined" && window.XREELS_TEST) || null;
  XR.bind("app.ports.storage", TEST && TEST.memoryStorage ? "infra.storage.memory" : "infra.storage.auto");
  XR.bind("app.ports.router", "infra.router.hash");
  XR.bind("app.ports.mediaResolver", "infra.media.twimg");
  XR.bind("app.ports.playerEngine", "infra.media.player");
  XR.bind("app.ports.platform", "infra.platform");
  XR.bind("app.ports.dataSources", "infra.datasources");

  /* 2. fail fast if an implementation does not satisfy its contract */
  const ports = XR.resolve("app.ports");
  for (const name of Object.keys(ports.SHAPES)) ports.assertPort(name, XR.resolve("app.ports." + name));

  /* 3. wake the format adapters so they register themselves */
  XR.resolveAll("core.adapters.");

  /* 4. go — but never leave a blank page: a module that failed to load or parse is reported by file + line */
  function fatal(title, lines) {
    document.body.innerHTML = "";
    const pre = document.createElement("pre");
    pre.style.cssText = "font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;padding:28px;color:#f3f3f3;background:#111;min-height:100vh;margin:0;white-space:pre-wrap";
    pre.textContent = `saves could not start\n\n${title}\n\n${lines.join("\n")}\n\nFix the file (or restore it from the zip) and reload.`;
    document.body.appendChild(pre);
  }
  function start() {
    const loadErrors = window.XREELS_LOAD_ERRORS || [];
    if (loadErrors.length) return fatal("These files did not load or contain a syntax error:", loadErrors.map((e) => `  • ${e.file}${e.line ? ":" + e.line : ""} — ${e.message}`));
    const missing = (window.XREELS_MANIFEST?.scripts || []).filter((f) => /^src\/(core|application|infrastructure|ui|shell|features)\//.test(f)).length && !XR.has("shell.app") ? ["shell.app"] : [];
    if (missing.length) return fatal("Core modules are missing:", missing);
    try { XR.resolve("shell.app").start(); }
    catch (err) { console.error(err); fatal("The application threw while starting:", [String(err && err.stack || err)]); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
