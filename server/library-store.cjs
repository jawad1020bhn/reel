/* Optional Vercel backend. Secrets stay on the server; no filesystem writes to
 * Vercel's ephemeral disk. The dataset and deletion ledger change in ONE Git
 * commit, with non-force ref updates/retries to preserve concurrent edits. */
const { createHash, timingSafeEqual } = require("node:crypto");
const LEDGER = "data/deleted-posts.js";
const fail = (status, message) => Object.assign(new Error(message), { status });

function parseData(text) {
  const json = text.trim().replace(/^\uFEFF/, "").replace(/^\/\*[\s\S]*?\*\/\s*/, "")
    .replace(/^(\/\/[^\n]*\n\s*)+/, "")
    .replace(/^(?:window\.|globalThis\.|var |let |const )?[\w$]+\s*=\s*/, "")
    .replace(/;\s*$/, "");
  try { return JSON.parse(json); } catch { throw fail(422, "The library data file is not valid JSON. Nothing was changed."); }
}
function ledgerIds(text) {
  const ids = parseData(text);
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw fail(422, "The deletion list is invalid. Nothing was changed.");
  return [...new Set(ids)];
}
function removePost(text, id, path) {
  const data = parseData(text);
  const key = Array.isArray(data) ? null : ["bookmarks", "posts", "tweets", "data", "items", "results", "list"].find((k) => Array.isArray(data?.[k]));
  const rows = key ? data[key] : Array.isArray(data) ? data : null;
  if (!rows) throw fail(422, "Unsupported library format. Nothing was changed.");
  const rowId = (p) => String(p?.tweet_id || p?.id || p?.tweetId || p?.id_str || p?.rest_id || p?.original_tweet_id ||
    String(p?.tweet_url || p?.tweetUrl || p?.url || "").match(/\/status\/(\d+)/)?.[1] || "");
  const kept = rows.filter((p) => rowId(p) !== id);
  if (kept.length === rows.length) return null;
  if (key) {
    data[key] = kept;
    if ("count" in data) data.count = kept.length;
    if (data.meta && "result_count" in data.meta) data.meta.result_count = kept.length;
    // Export-time audits are no longer true after editing the rows.
    delete data.verification;
  }
  const json = JSON.stringify(key ? data : kept);
  if (!path.endsWith(".js")) return json + "\n";
  const name = text.match(/(?:window\.|globalThis\.|var |let |const )([\w$]+)\s*=/)?.[1];
  if (!name) throw fail(422, "The JavaScript data wrapper is unsupported. Nothing was changed.");
  return `window.${name} =\n${json}\n;\n`;
}

function configuration(env) {
  const values = [env.LIBRARY_GITHUB_TOKEN, env.LIBRARY_GITHUB_REPOSITORY, env.LIBRARY_GITHUB_BRANCH, env.LIBRARY_DELETE_PASSWORD];
  if (values.every((v) => !v)) return null;
  if (values.some((v) => !v) || env.LIBRARY_DELETE_PASSWORD.length < 16) throw fail(503, "Permanent deletion is not configured. See DEPLOY.md.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.LIBRARY_GITHUB_REPOSITORY)) throw fail(503, "The library repository setting is invalid.");
  const path = env.LIBRARY_DATA_PATH || "data/posts.json";
  if (!["data/posts.json", "data/posts.js"].includes(path)) throw fail(503, "The library data path must be data/posts.json or data/posts.js.");
  // A preview must never silently mutate the production branch.
  if (env.VERCEL_ENV === "preview" && env.LIBRARY_GITHUB_BRANCH !== env.VERCEL_GIT_COMMIT_REF) throw fail(503, "Deletion is disabled for this preview branch.");
  return { token: env.LIBRARY_GITHUB_TOKEN, repository: env.LIBRARY_GITHUB_REPOSITORY, branch: env.LIBRARY_GITHUB_BRANCH, password: env.LIBRARY_DELETE_PASSWORD, path };
}

function createHandler({ env = process.env, fetch: request = globalThis.fetch } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    try {
      if (!["GET", "DELETE"].includes(req.method)) { res.setHeader("Allow", "GET, DELETE"); return send(405, { error: "Method not allowed" }); }
      const config = configuration(env);
      if (!config) return send(req.method === "GET" ? 200 : 503, { enabled: false, deletedIds: [], error: "Permanent deletion is not configured. See DEPLOY.md." });
      if (req.method === "DELETE") {
        const origin = req.headers.origin;
        if (origin) {
          let host;
          try { host = new URL(origin).host; } catch { throw fail(403, "Invalid request origin."); }
          if (host !== req.headers.host) throw fail(403, "Cross-origin deletion is not allowed.");
        }
        if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) throw fail(415, "Expected a JSON request.");
        let body = req.body;
        if (typeof body === "string" || Buffer.isBuffer(body)) {
          if (Buffer.byteLength(body) > 4096) throw fail(413, "Request too large.");
          try { body = JSON.parse(String(body)); } catch { throw fail(400, "Invalid JSON request."); }
        }
        const password = body?.password;
        if (typeof password !== "string" || password.length > 1024) throw fail(401, "Incorrect deletion password.");
        const digest = (s) => createHash("sha256").update(s).digest();
        if (!timingSafeEqual(digest(password), digest(config.password))) throw fail(401, "Incorrect deletion password.");
        if (typeof body?.id !== "string" || !/^[\w-]{1,128}$/.test(body.id)) throw fail(400, "Invalid post ID.");
        req.deleteId = body.id;
      }
      const base = `https://api.github.com/repos/${config.repository}`;
      async function github(path, { method = "GET", body, raw = false, optional = false } = {}) {
        let response;
        try {
          response = await request(base + path, {
            method, cache: "no-store", headers: { "Cache-Control": "no-cache", Authorization: `Bearer ${config.token}`, Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "saves-library", ...(body ? { "Content-Type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
          });
        } catch { throw fail(503, "The library server could not reach its data store. Try again."); }
        if (optional && response.status === 404) return null;
        if (!response.ok) {
          if (method === "PATCH" && [409, 422].includes(response.status)) throw fail(409, "The library changed during deletion. Try again.");
          throw fail(502, "The library data store could not be updated. Check server permissions and settings.");
        }
        return raw ? response.text() : response.json();
      }
      const ref = `/git/refs/heads/${config.branch.split("/").map(encodeURIComponent).join("/")}`;
      const read = (path, sha, optional = false) => github(`/contents/${path}?ref=${encodeURIComponent(sha)}`, { raw: true, optional });
      // Pin every read to the SAME commit, rather than racing a changing branch.
      for (let attempt = 0; attempt < 3; attempt++) {
        const head = (await github(ref.replace("/git/refs/", "/git/ref/"))).object.sha;
        const ledger = await read(LEDGER, head, true);
        const deletedIds = ledger === null ? [] : ledgerIds(ledger);
        if (req.method === "GET") return send(200, { enabled: true, deletedIds });
        const id = req.deleteId;
        const text = await read(config.path, head);
        const updated = removePost(text, id, config.path);
        if (updated === null && deletedIds.includes(id)) return send(200, { deleted: true, id, deletedIds });
        if (updated === null) throw fail(404, "This post is not in the shared data file. Nothing was deleted.");
        if (!deletedIds.includes(id)) deletedIds.push(id);
        const commit = await github(`/git/commits/${head}`);
        const files = [
          { path: config.path, content: updated },
          { path: LEDGER, content: `window.XREELS_DELETED_IDS = ${JSON.stringify(deletedIds)};\n` },
        ];
        const treeEntries = await Promise.all(files.map(async ({ path, content }) => ({ path, mode: "100644", type: "blob", sha: (await github("/git/blobs", { method: "POST", body: { content, encoding: "utf-8" } })).sha })));
        const tree = await github("/git/trees", { method: "POST", body: { base_tree: commit.tree.sha, tree: treeEntries } });
        const next = await github("/git/commits", { method: "POST", body: { message: `Delete post ${id} from library`, tree: tree.sha, parents: [head] } });
        try {
          await github(ref, { method: "PATCH", body: { sha: next.sha, force: false } });
          return send(200, { deleted: true, id, deletedIds });
        } catch (err) { if (err.status !== 409 || attempt === 2) throw err; }
      }
    } catch (err) {
      send(err.status || 500, { error: err.status ? err.message : "Deletion failed. Reload the library before trying again." });
    }
  };
}
module.exports = { createHandler, parseData, ledgerIds, removePost, configuration };
