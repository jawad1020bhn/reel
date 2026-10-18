/* infra.datasources — DataSourcesPort: the concrete ways JSON reaches the app.

   auto : <script src="data/posts.js"> injected at runtime (works on file://). Looks for
          window.XREELS_DATA, POSTS_DATA, POSTS, BOOKMARKS, xdashData. Falls back to
          fetch("data/posts.json") when running over http(s).
   file : File/Blob (drag-drop or picker). Reads .json and .js (window.X = {...}).
   text : pasted text (the importer parses it; this is a pass-through for symmetry).
   url  : fetch(url) — http(s) only; blocked on file:// by the browser. */
XR.define("infra.datasources", [], function () {
  "use strict";
  const GLOBALS = ["XREELS_DATA", "POSTS_DATA", "POSTS", "BOOKMARKS", "xdashData", "DATA"];
  const isFile = () => typeof location !== "undefined" && location.protocol === "file:";

  function findGlobal() {
    for (const g of GLOBALS) {
      const v = window[g];
      if (v && (typeof v === "object" || typeof v === "string")) return { name: g, value: v };
    }
    return null;
  }
  /** Resolves {ok, error?}: a syntax error inside the file is captured via the window error event. */
  function injectScript(src) {
    return new Promise((resolve) => {
      const s = document.createElement("script");
      const file = src.split("?")[0];
      let syntax = null;
      const onErr = (e) => { if (e && e.filename && String(e.filename).split("?")[0].endsWith(file)) { syntax = `${file}:${e.lineno || "?"} — ${e.message}`; e.preventDefault(); } };
      window.addEventListener("error", onErr, true);
      const done = (ok) => { window.removeEventListener("error", onErr, true); s.remove(); resolve({ ok: ok && !syntax, error: syntax }); };
      s.src = src; s.async = true;
      s.onload = () => done(true);
      s.onerror = () => done(false);
      document.head.appendChild(s);
    });
  }

  const auto = {
    id: "auto", kind: "auto", label: "data/posts.js",
    available: () => typeof document !== "undefined",
    async load() {
      let found = findGlobal();
      if (!found) {
        const r = await injectScript("data/posts.js?v=" + Date.now());
        if (r.error) throw new Error("data/posts.js could not be parsed (" + r.error + "). Check that it starts with `window.XREELS_DATA =` and ends with `;`.");
        if (r.ok) found = findGlobal();
      }
      if (found) {
        const value = found.value;
        return typeof value === "string" ? { text: value, label: "data/posts.js" } : { json: value, label: "data/posts.js" };
      }
      if (!isFile() && typeof fetch === "function") {
        try {
          const res = await fetch("data/posts.json", { cache: "no-store" });
          /* Keep the JSON as text until the importer checks its fingerprint. On a cache hit,
             this avoids parsing the full export just to discover that normalized posts exist. */
          if (res.ok) return { text: await res.text(), label: "data/posts.json" };
        } catch { /* absent */ }
      }
      return null;
    },
  };

  const file = {
    id: "file", kind: "file", label: "Upload",
    available: () => typeof FileReader !== "undefined",
    load(blob) {
      return new Promise((resolve, reject) => {
        if (!blob) return reject(new Error("No file"));
        if (blob.size > 300 * 1024 * 1024) return reject(new Error("File is larger than 300 MB"));
        const reader = new FileReader();
        reader.onload = () => resolve({ text: String(reader.result || ""), label: blob.name || "Uploaded file", size: blob.size });
        reader.onerror = () => reject(reader.error || new Error("Could not read file"));
        reader.readAsText(blob);
      });
    },
  };

  const text = { id: "text", kind: "text", label: "Paste", available: () => true, async load(str) { return { text: String(str || ""), label: "Pasted JSON" }; } };

  const url = {
    id: "url", kind: "url", label: "URL",
    available: () => !isFile() && typeof fetch === "function",
    async load(href) {
      const res = await fetch(href, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      return { text: body, label: href };
    },
  };

  const list = [auto, file, text, url];
  return { get: (kind) => list.find((s) => s.kind === kind || s.id === kind) || null, all: () => list.slice(), GLOBALS, clearGlobals: () => { for (const g of GLOBALS) try { delete window[g]; } catch { /* non-configurable */ } } };
});
