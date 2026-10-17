/* loader.js — turns src/manifest.js into <link>/<script> tags while the page is still
   parsing (document.write keeps the exact blocking/ordering semantics of static tags and
   works on file://). Also records load/syntax errors so boot.js can show WHICH file broke
   instead of a blank page. Keep this file dependency-free: it runs before the kernel. */
(function () {
  "use strict";
  var M = window.XREELS_MANIFEST;
  var errors = (window.XREELS_LOAD_ERRORS = []);
  if (!M) { errors.push({ file: "src/manifest.js", message: "manifest missing" }); return; }

  /* syntax errors in any module surface here as ErrorEvents with a filename */
  window.addEventListener("error", function (e) {
    if (!e || !e.filename) return;
    var file = String(e.filename).split("?")[0];
    var known = M.scripts.concat(M.vendor || []).some(function (s) { return file.slice(-s.length) === s; });
    if (known) errors.push({ file: file.replace(/^.*\/(src|vendor)\//, "$1/"), line: e.lineno, message: e.message });
  }, true);

  var base = (document.currentScript && document.currentScript.src || "").replace(/src\/kernel\/loader\.js.*$/, "");
  var esc = function (s) { return String(s).replace(/"/g, "&quot;"); };
  if (document.readyState === "loading" && typeof document.write === "function") {
    var out = "";
    M.styles.forEach(function (href) { out += '<link rel="stylesheet" href="' + esc(href) + '">'; });
    (M.vendor || []).forEach(function (src) { out += '<script src="' + esc(src) + '" defer><\/script>'; });
    M.scripts.forEach(function (src) { out += '<script src="' + esc(src) + '"><\/script>'; });
    document.write(out);
  } else {
    /* late injection (should not happen for index.html; kept for robustness) */
    M.styles.forEach(function (href) { var l = document.createElement("link"); l.rel = "stylesheet"; l.href = base + href; document.head.appendChild(l); });
    var all = (M.vendor || []).concat(M.scripts);
    all.forEach(function (src) { var s = document.createElement("script"); s.src = base + src; s.async = false; s.onerror = function () { errors.push({ file: src, message: "failed to load" }); }; document.head.appendChild(s); });
  }
})();
