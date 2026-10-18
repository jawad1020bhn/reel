/* loader.js — turns src/manifest.js into <link>/<script> tags while the page is still
   parsing. Ordered `defer` scripts let the body parse while scripts download, then execute
   in manifest order; classic scripts preserve the app's file:// support. Also records
   load/syntax errors so boot.js can name broken files. Keep this file dependency-free. */
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
  if (document.readyState === "loading" && typeof document.write === "function") {
    var out = "";
    M.styles.forEach(function (href) { out += '<link rel="stylesheet" href="' + esc(href) + '">'; });
    M.scripts.forEach(function (src) { out += '<script defer src="' + esc(src) + '"><\/script>'; });
    /* Optional vendors are requested by the feature that needs them. */
    document.write(out);
  } else {
    /* late injection (should not happen for index.html; kept for robustness) */
    M.styles.forEach(function (href) { var l = document.createElement("link"); l.rel = "stylesheet"; l.href = base + href; document.head.appendChild(l); });
    var all = M.scripts;
    all.forEach(function (src) { var s = document.createElement("script"); s.src = base + src; s.async = false; s.onerror = function () { errors.push({ file: src, message: "failed to load" }); }; document.head.appendChild(s); });
  }
})();
