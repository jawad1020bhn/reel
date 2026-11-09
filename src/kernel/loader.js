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
    /* `loaded` also lets the boot deadline tell "still arriving" from "arrived, app is slow" */
    s.onload = function () { try { s.dataset.loaded = "1"; } catch (e) { /* no dataset */ } };
    document.head.appendChild(s);
    return s;
  }

  M.styles.forEach(addStyle);
  var tags = M.scripts.map(function (src) { return addScript(src); });

  /* A hung request (a proxy that never answers, a captive portal, a flaky mobile link) fires
     neither onload nor onerror — the chain then stops silently and the page sits on the boot
     splash forever. If the last script has not finished by the deadline, say so on the screen
     the visitor is actually looking at, with a reload button. Slow is fine; stuck is not. */
  var BOOT_DEADLINE_MS = 20000;
  setTimeout(function () {
    if (window.XREELS_READY) return;
    var last = tags[tags.length - 1];
    if (!last || last.dataset.loaded === "1") {
      /* every file arrived, so the delay is boot work: leave the app's own splash alone */
      if (last) return;
    }
    var pending = tags.filter(function (t) { return t.dataset.loaded !== "1"; })
      .map(function (t) { return String(t.src || "").replace(base, ""); })
      .filter(Boolean);
    var boot = document.getElementById("boot-splash");
    if (!boot) return;
    var wrap = boot.querySelector(".bs-wrap") || boot;
    wrap.innerHTML = "";
    var title = document.createElement("p");
    title.style.cssText = "margin:0 0 10px;font:600 15px/1.4 system-ui,sans-serif;color:#f2f2f4";
    title.textContent = "Still opening…";
    var note = document.createElement("p");
    note.style.cssText = "margin:0 0 16px;max-width:34em;text-align:center;font:400 13px/1.6 system-ui,sans-serif;color:#8b8b92";
    note.textContent = pending.length
      ? "Some files are taking unusually long to arrive. Check your connection, then try again."
      : "Your library is taking longer than usual to read.";
    wrap.appendChild(title);
    wrap.appendChild(note);
    if (pending.length) {
      var list = document.createElement("p");
      list.style.cssText = "margin:0 0 16px;font:400 12px/1.6 ui-monospace,Menlo,monospace;color:#6f6f76";
      list.textContent = pending.slice(0, 6).join(" · ");
      wrap.appendChild(list);
    }
    var btn = document.createElement("button");
    btn.textContent = "Try again";
    btn.style.cssText = "padding:10px 18px;border-radius:999px;border:0;background:#e50914;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer";
    btn.onclick = function () { location.reload(); };
    wrap.appendChild(btn);
    boot.style.zIndex = "9999";
  }, BOOT_DEADLINE_MS);

  /* boot.js sets this once it has taken over; until then the deadline above stays armed. */

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
