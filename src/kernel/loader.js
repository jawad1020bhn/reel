/* loader.js — turns src/manifest.js into <link>/<script> tags while the page is still
   parsing. Classic scripts preserve the app's file:// support.

   Why not document.write: it inserts a *parser-blocking* stream, so the browser cannot even
   finish the <head> until every URL in the manifest has been announced, and nothing paints
   until the stylesheets arrive. Here every stylesheet and script is appended instead, which
   is not parser-blocking: index.html's inline critical CSS paints the splash immediately,
   and the whole chain downloads in parallel.

   The scripts are appended with `async = false`, which the HTML spec executes in insertion
   order — the same guarantee `defer` gives, without blocking the parser. Stylesheets are
   still awaited before the first script runs (that is what browser engines do, and it is
   what avoids a flash of unstyled app), so the critical CSS above is what makes the first
   frame instant rather than the stylesheet chain.

   Also records load/syntax errors so boot.js can name broken files. Dependency-free. */
(function () {
  "use strict";
  var M = window.XREELS_MANIFEST;
  var errors = (window.XREELS_LOAD_ERRORS = []);
  if (!M) { errors.push({ file: "src/manifest.js", message: "manifest missing" }); return; }

  /* syntax errors in any module surface here as ErrorEvents with a filename */
  window.addEventListener("error", function (e) {
    if (!e || !e.filename) return;
    var file = String(e.filename).split("?")[0];
    var lazyScripts = (M.lazyFeatures || []).reduce(function (all, feature) { return all.concat(feature.scripts || []); }, []);
    var known = M.scripts.concat(M.vendor || [], lazyScripts).some(function (s) { return file.slice(-s.length) === s; });
    if (known) errors.push({ file: file.replace(/^.*\/(src|vendor)\//, "$1/"), line: e.lineno, message: e.message });
  }, true);

  var base = (document.currentScript && document.currentScript.src || "").replace(/src\/kernel\/loader\.js.*$/, "");
  var esc = function (s) { return String(s).replace(/"/g, "&quot;"); };

  /* --- styles: download in parallel, apply when they land (no render block) --- */
  function addStyle(href) {
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = base + href;
    /* a stylesheet that fails must not leave an unstyled page silently */
    link.onerror = function () { errors.push({ file: href, message: "failed to load" }); };
    document.head.appendChild(link);
  }

  /* --- scripts: appended in order with async=false → executed in order --- */
  function addScript(src, opts) {
    var s = document.createElement("script");
    s.src = base + src;
    s.async = false;                       // preserves execution order across the whole chain
    if (opts && opts.defer) s.defer = true;
    s.onerror = function () { errors.push({ file: src, message: "failed to load" }); };
    document.head.appendChild(s);
    return s;
  }

  M.styles.forEach(addStyle);
  M.scripts.forEach(function (src) { addScript(src); });

  /* Warm the first documents a visitor is most likely to ask for. Cheap (same-origin, only
     when the tag is missing) and it overlaps the script chain: the library JSON is usually
     the slowest thing on the critical path after the scripts themselves. */
  if (location.protocol !== "file:") {
    ["data/posts.js", "data/x-posts.json"].forEach(function (href) {
      var l = document.createElement("link");
      l.rel = "prefetch";
      l.href = base + href;
      document.head.appendChild(l);
    });
  }

  /* Mark the moment the whole chain was announced: boot.js compares it with
     performance.now() to report how much of the wait was script fetching. */
  try { performance.mark("xreels:chain-announced"); } catch (e) { /* older engines */ }

  /* Optional vendors (hls.js) are requested by the feature that needs them — never here. */
})();
