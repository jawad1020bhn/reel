/* data/x-posts2.json, data/x-posts3.json … are continuation files of data/x-posts.json: one X
   library spread over several exports. Absent files change nothing; present ones are merged by
   post id; the normalised cache refreshes when a file is added; a broken continuation file is
   skipped (the main file still loads); permanent deletion finds posts in every file. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createHandler, parseData, ledgerIds, X_POSTS_MAX } = require("../server/library-store.cjs");

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const exportOf = (bookmarks) => JSON.stringify({ export_version: 1, exported_at: "2026-11-01T00:00:00Z", incremental: true, count: bookmarks.length, source: "x-bookmarks", bookmarks });

/* ------------------------------------------------------------------ infra.datasources -- */
/** The auto source over https, with data/posts.js absent and `files` served as static JSON. */
function autoSource(files, { protocol = "https:" } = {}) {
  let api;
  const requested = [];
  const fetch = async (path) => {
    requested.push(path);
    return path in files ? new Response(files[path], { status: 200 }) : new Response("Not found", { status: 404 });
  };
  const window = {
    addEventListener() {}, removeEventListener() {},
  };
  // data/posts.js is not there: the injected <script> fires onerror.
  const document = {
    createElement: () => ({ remove() {} }),
    head: { appendChild: (s) => setTimeout(() => s.onerror(), 0) },
  };
  runInNewContext(read("src/infrastructure/datasources/index.js"), {
    XR: { define: (_name, _deps, factory) => { api = factory(); } }, location: { protocol }, window, document, fetch, setTimeout, AbortSignal, console,
  });
  return { api, requested };
}

/* The continuation probes run in parallel, so the number/order of requests is an
   implementation detail: what matters is that the result is unchanged and no non-x-posts
   file is touched. */
const xRequests = (requested) => requested.filter((p) => p.startsWith("data/x-posts"));

test("data source: only data/x-posts.json present → exactly the old single-file result", async () => {
  const { api, requested } = autoSource({ "data/x-posts.json": exportOf([{ tweet_id: "1" }]) });
  const res = plain(await api.get("auto").load());
  assert.deepEqual(res, { text: exportOf([{ tweet_id: "1" }]), label: "data/x-posts.json" });
  assert.ok(xRequests(requested).includes("data/x-posts2.json"), "the first continuation is probed");
  assert.ok(xRequests(requested).includes("data/x-posts.json"), "and so is the main file");
});

test("data source: data/x-posts2.json (and x-posts3…) are returned as parts of the same library, in order", async () => {
  const files = { "data/x-posts.json": exportOf([{ tweet_id: "1" }]), "data/x-posts2.json": exportOf([{ tweet_id: "2" }]), "data/x-posts3.json": exportOf([{ tweet_id: "3" }]) };
  const { api, requested } = autoSource(files);
  const res = plain(await api.get("auto").load());
  assert.equal(res.label, "data/x-posts.json + data/x-posts2.json + data/x-posts3.json");
  assert.deepEqual(res.parts.map((p) => p.label), ["data/x-posts.json", "data/x-posts2.json", "data/x-posts3.json"]);
  assert.deepEqual(res.parts.map((p) => p.text), Object.values(files));
  assert.deepEqual([...new Set(xRequests(requested))].sort(), ["data/x-posts.json", "data/x-posts2.json", "data/x-posts3.json", "data/x-posts4.json", "data/x-posts5.json", "data/x-posts6.json", "data/x-posts7.json", "data/x-posts8.json", "data/x-posts9.json"], "every continuation is probed at once, so the whole library costs one round trip");
  assert.equal(api.X_POSTS_MAX, X_POSTS_MAX, "browser and server agree on how far the numbering goes");
});

test("data source: numbering is consecutive — a gap ends the series; a continuation without the main file still loads", async () => {
  const gap = autoSource({ "data/x-posts.json": exportOf([{ tweet_id: "1" }]), "data/x-posts3.json": exportOf([{ tweet_id: "3" }]) });
  assert.equal(plain(await gap.api.get("auto").load()).label, "data/x-posts.json");
  const only2 = autoSource({ "data/x-posts2.json": exportOf([{ tweet_id: "2" }]) });
  assert.deepEqual(plain(await only2.api.get("auto").load()), { text: exportOf([{ tweet_id: "2" }]), label: "data/x-posts2.json" });
  const none = autoSource({});
  assert.equal(await none.api.get("auto").load(), null);
  const file = autoSource({ "data/x-posts.json": "{}" }, { protocol: "file:" });
  assert.equal(await file.api.get("auto").load(), null, "file:// never fetches");
  assert.deepEqual(file.requested, []);
});

/* ------------------------------------------------------------------------ app.importer -- */
const post = (id, savedAt, text = id) => ({ id, text, savedAt, author: { username: "test" }, media: [{ kind: "photo" }], metrics: {} });
/** The importer with a fake auto source that answers like infra.datasources does. */
function importer(answer) {
  let api;
  const cache = new Map();
  const normalized = [];
  const storage = {
    get: async (key) => structuredClone(cache.get(key)),
    set: async (key, value) => cache.set(key, structuredClone(value)),
    remove: async (key) => cache.delete(key), keys: async () => [...cache.keys()],
  };
  const catalog = {
    posts: [], source: { id: "none" },
    get size() { return this.posts.length; },
    get all() { return this.posts; },
    post(id) { return this.posts.find((p) => p.id === id); },
    async load(posts, meta) { this.posts = posts; this.source = { ...meta, count: posts.length }; return this.source; },
  };
  const sources = {
    get: (kind) => (kind === "auto" ? { available: () => true, load: async () => answer() } : null),
    deletionState: async () => ({ enabled: false, deletedIds: [] }),
  };
  const registry = {
    parseInput: (input) => { if (typeof input !== "string") return input; try { return JSON.parse(input); } catch { throw new Error("Could not parse the JSON"); } },
    detect: (data) => (Array.isArray(data?.posts) ? { adapter: { id: "test" } } : null),
    normalizeAsync: async (data) => { normalized.push(data); return { posts: data.posts, adapter: "test" }; },
  };
  const util = { fnv1a: (text) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7), uid: () => "test" };
  const EV = { DATASET_PROGRESS: "progress", DATASET_ERROR: "error", POST_DELETED: "deleted" };
  runInNewContext(read("src/application/services/importer.js"), {
    console: { ...console, warn: () => {} },
    XR: { define: (_name, _deps, factory) => { api = factory(storage, sources, { isFile: () => true }, registry, util, { bus: { emit() {} } }, EV, catalog, { get: () => true }, { mark: () => {} }); } },
  });
  return { api, catalog, cache, normalized };
}
const ids = (catalog) => Array.from(catalog.posts, (p) => p.id).sort();
const single = () => ({ text: JSON.stringify({ posts: [post("1", 100), post("2", 200)] }), label: "data/x-posts.json" });
const twoFiles = () => ({
  parts: [
    { text: JSON.stringify({ posts: [post("1", 100), post("2", 200)] }), label: "data/x-posts.json" },
    { text: JSON.stringify({ posts: [post("2", 300, "2 again, newer capture"), post("3", 50)] }), label: "data/x-posts2.json" },
  ],
  label: "data/x-posts.json + data/x-posts2.json",
});

test("importer: one file behaves exactly as before; adding data/x-posts2.json later merges its posts and re-indexes once", async () => {
  let answer = single;
  const s = importer(() => answer());
  await s.api.boot();
  assert.deepEqual(ids(s.catalog), ["1", "2"]);
  assert.equal(s.catalog.source.label, "data/x-posts.json");
  const before = s.catalog.source.fingerprint;
  assert.equal(s.cache.get(s.api.KEY_AUTO).fingerprint, before);
  await s.api.boot();
  assert.equal(s.normalized.length, 1, "unchanged file: served from the cache");
  assert.equal(s.catalog.source.cached, true);

  answer = twoFiles;                                   // the file "added later"
  await s.api.boot();
  assert.deepEqual(ids(s.catalog), ["1", "2", "3"], "union of both files, no duplicate");
  assert.equal(s.catalog.post("2").text, "2 again, newer capture", "the most recent capture of a post wins");
  assert.equal(s.catalog.source.label, "data/x-posts.json + data/x-posts2.json");
  assert.notEqual(s.catalog.source.fingerprint, before, "the cache key spans every file");
  assert.deepEqual(plain(s.catalog.source.parts), [{ label: "data/x-posts.json", count: 2, adapter: "test" }, { label: "data/x-posts2.json", count: 2, adapter: "test" }]);
  assert.equal(s.normalized.length, 3, "both files indexed once");
  assert.equal(s.cache.get(s.api.KEY_AUTO).posts.length, 3);
  await s.api.boot();
  assert.equal(s.normalized.length, 3, "merged library is cached too");
  assert.deepEqual(ids(s.catalog), ["1", "2", "3"]);
  assert.deepEqual(plain(s.catalog.source.parts).map((p) => p.label), ["data/x-posts.json", "data/x-posts2.json"]);
  const libs = await s.api.libraries();
  assert.equal(libs[0].label, "data/x-posts.json + data/x-posts2.json");
  assert.equal(libs[0].count, 3);
});

test("importer: mergeParts keeps the newest capture (later file on ties) and never duplicates an id", () => {
  const { api } = importer(single);
  const merged = plain(api.mergeParts([
    [post("a", 10, "a-old"), post("b", 20, "b-first"), post("c", 30)],
    [post("a", 50, "a-new"), post("b", 20, "b-second"), post("d", 0)],
    [post("a", 40, "a-older-than-second")],
  ]));
  assert.deepEqual(merged.map((p) => p.id), ["a", "b", "c", "d"]);
  assert.deepEqual(merged.map((p) => p.text), ["a-new", "b-second", "c", "d"]);
  assert.deepEqual(plain(api.mergeParts([])), []);
});

test("importer: a broken continuation file is skipped with a note; a broken main file is still an error", async () => {
  const broken = () => ({
    parts: [{ text: JSON.stringify({ posts: [post("1", 100)] }), label: "data/x-posts.json" }, { text: "<!doctype html>", label: "data/x-posts2.json" }],
    label: "data/x-posts.json + data/x-posts2.json",
  });
  const s = importer(broken);
  await s.api.boot();
  assert.deepEqual(ids(s.catalog), ["1"]);
  const parts = plain(s.catalog.source.parts);
  assert.equal(parts[0].count, 1);
  assert.equal(parts[1].label, "data/x-posts2.json");
  assert.equal(parts[1].count, 0);
  assert.match(parts[1].error, /parse/i);
  const main = importer(() => ({ parts: [{ text: "<!doctype html>", label: "data/x-posts.json" }, { text: JSON.stringify({ posts: [post("2", 1)] }), label: "data/x-posts2.json" }], label: "x" }));
  await main.api.boot();
  assert.equal(main.catalog.posts.length, 0);
  assert.match(main.catalog.source.error || "", /parse/i);
});

/* ------------------------------------------------------------------ server/library-store -- */
const PASSWORD = "correct horse battery staple";
const env = { LIBRARY_GITHUB_TOKEN: "t", LIBRARY_GITHUB_REPOSITORY: "o/r", LIBRARY_GITHUB_BRANCH: "main", LIBRARY_DELETE_PASSWORD: PASSWORD };
/** The same in-memory GitHub as tests/library-deletion.test.mjs, with a continuation file. */
function fakeGit(files) {
  let head = "c1", seq = 0;
  const blobs = new Map(), trees = new Map(), commits = new Map();
  const commitTree = new Map([["c1", { ...files }]]);
  commits.set("c1", { tree: { sha: "t1" } });
  trees.set("t1", { ...files });
  const written = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url), path = u.pathname.replace("/repos/o/r", ""), method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/git/ref/heads/main") return json(200, { object: { sha: head } });
    if (path.startsWith("/contents/")) {
      const file = decodeURIComponent(path.slice("/contents/".length)), sha = u.searchParams.get("ref");
      const tree = commitTree.get(sha);
      return file in tree ? new Response(tree[file], { status: 200 }) : new Response("Not found", { status: 404 });
    }
    if (path.startsWith("/git/commits/") && method === "GET") return json(200, commits.get(path.split("/").pop()));
    if (path === "/git/blobs") { const sha = `b${++seq}`; blobs.set(sha, body.content); return json(201, { sha }); }
    if (path === "/git/trees") {
      const sha = `t${++seq}`, base = { ...trees.get(body.base_tree) };
      for (const e of body.tree) base[e.path] = blobs.get(e.sha);
      trees.set(sha, base); written.push(body.tree.map((e) => e.path));
      return json(201, { sha });
    }
    if (path === "/git/commits") { const sha = `c${++seq}`; commits.set(sha, { tree: { sha: body.tree } }); commitTree.set(sha, trees.get(body.tree)); return json(201, { sha }); }
    if (path === "/git/refs/heads/main" && method === "PATCH") { head = body.sha; return json(200, {}); }
    return json(404, {});
  };
  return { fetch, written, snapshot: () => commitTree.get(head) };
}
async function invoke(handler, method = "GET", body) {
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(text) { this.body = JSON.parse(text); } };
  await handler({ method, body, headers: { host: "library.test", origin: "https://library.test", "content-type": "application/json" } }, res);
  return res;
}
const idsIn = (text) => parseData(text).bookmarks.map((p) => p.tweet_id);

test("server: permanent deletion finds a post in data/x-posts2.json and commits only that file with the ledger", async () => {
  const git = fakeGit({
    "data/x-posts.json": exportOf([{ tweet_id: "1" }, { tweet_id: "2" }]),
    "data/x-posts2.json": exportOf([{ tweet_id: "3" }, { tweet_id: "4" }]),
  });
  const handler = createHandler({ env, fetch: git.fetch });
  const res = await invoke(handler, "DELETE", { id: "3", password: PASSWORD });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { deleted: true, id: "3", deletedIds: ["3"] });
  const files = git.snapshot();
  assert.deepEqual(idsIn(files["data/x-posts.json"]), ["1", "2"], "untouched");
  assert.deepEqual(idsIn(files["data/x-posts2.json"]), ["4"]);
  assert.equal(parseData(files["data/x-posts2.json"]).count, 1);
  assert.deepEqual(ledgerIds(files["data/deleted-posts.js"]), ["3"]);
  assert.deepEqual(git.written, [["data/x-posts2.json", "data/deleted-posts.js"]]);
  const missing = await invoke(handler, "DELETE", { id: "9", password: PASSWORD });
  assert.equal(missing.statusCode, 404);
  assert.match(missing.body.error, /not in the shared data files/);
});

test("server: a post captured in two files is removed from both; a numbering gap is respected like in the browser", async () => {
  const git = fakeGit({
    "data/x-posts.json": exportOf([{ tweet_id: "1" }, { tweet_id: "2" }]),
    "data/x-posts2.json": exportOf([{ tweet_id: "2" }, { tweet_id: "3" }]),
    "data/x-posts4.json": exportOf([{ tweet_id: "5" }]),
  });
  const handler = createHandler({ env, fetch: git.fetch });
  const res = await invoke(handler, "DELETE", { id: "2", password: PASSWORD });
  assert.equal(res.statusCode, 200);
  const files = git.snapshot();
  assert.deepEqual(idsIn(files["data/x-posts.json"]), ["1"]);
  assert.deepEqual(idsIn(files["data/x-posts2.json"]), ["3"]);
  assert.deepEqual(git.written, [["data/x-posts.json", "data/x-posts2.json", "data/deleted-posts.js"]]);
  const beyondGap = await invoke(handler, "DELETE", { id: "5", password: PASSWORD });
  assert.equal(beyondGap.statusCode, 404, "x-posts4.json without x-posts3.json is not part of the library");
});

test("server: data/posts.js as the data path reads no continuation files", async () => {
  const git = fakeGit({
    "data/posts.js": `window.XREELS_DATA = ${exportOf([{ tweet_id: "1" }])};\n`,
    "data/x-posts2.json": exportOf([{ tweet_id: "2" }]),
  });
  const handler = createHandler({ env: { ...env, LIBRARY_DATA_PATH: "data/posts.js" }, fetch: git.fetch });
  assert.equal((await invoke(handler, "DELETE", { id: "2", password: PASSWORD })).statusCode, 404);
  assert.equal((await invoke(handler, "DELETE", { id: "1", password: PASSWORD })).statusCode, 200);
  assert.deepEqual(git.written, [["data/posts.js", "data/deleted-posts.js"]]);
});
