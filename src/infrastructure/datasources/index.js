/* infra.datasources — DataSourcesPort: the concrete ways JSON reaches the app.

   auto : <script src="data/posts.js"> injected at runtime (works on file://). Looks for
          window.XREELS_DATA, POSTS_DATA, POSTS, BOOKMARKS, xdashData. Falls back to
          fetch("data/x-posts.json") when running over http(s) — plus any continuation
          files data/x-posts2.json, data/x-posts3.json … (numbered consecutively; the
          first missing number ends the series). They are one library: the importer
          merges them by post id. A missing continuation file is normal, not an error.
   file : File/Blob (drag-drop or picker). Reads .json and .js (window.X = {...}).
   text : pasted text (the importer parses it; this is a pass-through for symmetry).
   url  : fetch(url) — http(s) only; blocked on file:// by the browser.
   reddit : fetch("data/r-posts.json") — the Reddit saved-posts export, read next to the
          X library on every boot. http(s) only, like data/x-posts.json. */
XR.define("infra.datasources", [], function () {
  "use strict";
  const GLOBALS = ["XREELS_DATA", "POSTS_DATA", "POSTS", "BOOKMARKS", "xdashData", "DATA"];
  const isFile = () => typeof location !== "undefined" && location.protocol === "file:";
  const X_POSTS = "data/x-posts.json";
  const X_POSTS_MAX = 9;                                   // data/x-posts2.json … data/x-posts9.json
  const xPostsPath = (n) => (n <= 1 ? X_POSTS : `data/x-posts${n}.json`);
  /** The text of a static JSON file, or null when it is absent/unreachable (404 is normal). */
  async function fetchText(path) {
    try {
      const res = await fetch(path, { cache: "no-store" });
      /* Keep the JSON as text until the importer checks its fingerprint. On a cache hit,
         this avoids parsing the full export just to discover that normalized posts exist. */
      if (res.ok) return await res.text();
    } catch { /* absent or unreachable */ }
    return null;
  }
  /** data/x-posts.json and its numbered continuations, in order. [] when none exists. */
  async function fetchXPosts() {
    const parts = [];
    const primary = await fetchText(X_POSTS);
    if (primary != null) parts.push({ text: primary, label: X_POSTS });
    for (let n = 2; n <= X_POSTS_MAX; n++) {
      const text = await fetchText(xPostsPath(n));
      if (text == null) break;                               // consecutive numbering: the first gap ends the series
      parts.push({ text, label: xPostsPath(n) });
    }
    return parts;
  }

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
        const parts = await fetchXPosts();
        if (parts.length === 1) return { text: parts[0].text, label: parts[0].label };
        if (parts.length > 1) return { parts, label: parts.map((p) => p.label).join(" + ") };
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

  /* The shared ledger is authoritative, not a browser-local hidden flag.
     Static/file copies use the ledger shipped with the deployment. When a
     configured API is unreachable we fail closed rather than show stale posts. */
  async function deletionRequest(options) {
    const res = await fetch("api/library", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(options ? 65000 : 20000), ...options });
    if (!options && (res.status === 404 || res.status === 405 || (res.ok && !res.headers.get("content-type")?.includes("application/json")))) return null;
    let body;
    try { body = await res.json(); } catch { throw new Error("The library server returned an invalid response. Reload and try again."); }
    if (!res.ok) throw new Error(body.error || "The library server is unavailable. Try again.");
    if (!Array.isArray(body.deletedIds) || body.deletedIds.some((id) => typeof id !== "string")) throw new Error("The shared deletion list is invalid. Reload and try again.");
    return body;
  }
  async function deletionState() {
    const shipped = Array.isArray(window.XREELS_DELETED_IDS) ? window.XREELS_DELETED_IDS : [];
    if (isFile()) return { enabled: false, deletedIds: shipped };
    let state;
    try { state = await deletionRequest(); }
    catch (err) { throw new Error("Could not check shared deletions. " + err.message); }
    return { enabled: !!state?.enabled, deletedIds: [...new Set([...shipped, ...(state?.deletedIds || [])])] };
  }
  async function deletePost(id, password) {
    if (isFile()) throw new Error("Permanent deletion requires the hosted app. See DEPLOY.md.");
    const result = await deletionRequest({ method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, password }) });
    if (!result?.deleted || result.id !== id || !result.deletedIds.includes(id)) throw new Error("The server did not confirm deletion. Nothing was removed locally.");
    return result;
  }

  const reddit = {
    id: "reddit", kind: "reddit", label: "data/r-posts.json",
    available: () => !isFile() && typeof fetch === "function",
    async load() {
      try {
        const res = await fetch("data/r-posts.json", { cache: "no-store" });
        // A missing file is normal (no Reddit export yet), so it is reported as absent, not as an error.
        if (res.ok) return { text: await res.text(), label: "data/r-posts.json" };
      } catch { /* absent or unreachable */ }
      return null;
    },
  };

  const list = [auto, file, text, url, reddit];
  return { get: (kind) => list.find((s) => s.kind === kind || s.id === kind) || null, all: () => list.slice(), GLOBALS, X_POSTS, X_POSTS_MAX, xPostsPath, fetchXPosts, deletionState, deletePost, clearGlobals: () => { for (const g of GLOBALS) try { delete window[g]; } catch { /* non-configurable */ } } };
});
