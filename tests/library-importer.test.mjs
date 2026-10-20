import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const source = readFileSync(new URL("../src/application/services/importer.js", import.meta.url), "utf8");
const post = (id) => ({ id, text: id, author: { username: "test" }, media: [{ kind: "photo" }], metrics: {} });
const all = [post("1"), post("2")];
function setup({ deletedIds = [], imported = false, unavailable = false, enabled = true } = {}) {
  let api;
  const emitted = [];
  const cache = new Map();
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
    get: (kind) => (kind === "reddit" ? null : { available: () => true, load: async () => ({ json: { posts: all }, label: "test data" }) }),
    deletionState: async () => { if (unavailable) throw new Error("shared deletion service unavailable"); return { enabled, deletedIds }; },
    deletePost: async (id) => { if (unavailable) throw new Error("write failed"); return { deleted: true, id, deletedIds: [...deletedIds, id] }; },
  };
  const registry = {
    parseInput: (input) => input,
    detect: (data) => data.posts.length ? { adapter: { id: "test" } } : null,
    normalizeAsync: async (data) => ({ posts: data.posts, adapter: "test" }),
  };
  const util = { fnv1a: (text) => text.length, uid: () => "test" };
  const EV = { DATASET_PROGRESS: "progress", DATASET_ERROR: "error", POST_DELETED: "deleted" };
  runInNewContext(source, {
    console, XR: { define: (_name, _deps, factory) => { api = factory(storage, sources, { isFile: () => true }, registry, util, { bus: { emit: (...event) => emitted.push(event) } }, EV, catalog, { get: () => true }, { mark: () => {} }); } },
  });
  if (imported) {
    cache.set(api.KEY_INDEX, { active: "imported", items: [{ id: "imported", key: api.keyFor("imported"), count: 2, label: "imported" }] });
    cache.set(api.keyFor("imported"), { posts: all, adapter: "test" });
  }
  return { api, catalog, cache, sources, emitted };
}
const ids = (catalog) => Array.from(catalog.posts, (p) => p.id);

test("fresh browsers and cached imported libraries filter the same shared deletions", async () => {
  for (const imported of [false, true]) {
    const s = setup({ deletedIds: ["1"], imported });
    await s.api.boot();
    assert.deepEqual(ids(s.catalog), ["2"]);
    await s.api.boot();
    assert.deepEqual(ids(s.catalog), ["2"], "cache hits cannot resurrect deleted posts");
  }
});

test("a stale export cannot resurrect a deleted post through replace, merge or new-library import", async () => {
  const s = setup({ deletedIds: ["1"] });
  await s.api.boot();
  for (const mode of ["replace", "merge", "new"]) {
    await s.api.commit({ posts: all, adapter: "test", fingerprint: "stale", label: "old export" }, { mode });
    assert.deepEqual(ids(s.catalog), ["2"]);
    const stored = s.cache.get(s.api.keyFor(await s.api.activeId()));
    assert.deepEqual(stored.posts.map((p) => p.id), ["2"]);
  }
});

test("an unreachable configured deletion service fails closed even when an imported cache exists", async () => {
  const s = setup({ imported: true, unavailable: true });
  await s.api.boot();
  assert.deepEqual(ids(s.catalog), []);
  assert.match(s.catalog.source.error, /unavailable/);
  assert.ok(s.emitted.some(([name]) => name === "error"));
});

test("server-confirmed deletion removes the post from the catalog and every cached library", async () => {
  const s = setup({ imported: true });
  await s.api.boot();
  s.cache.set(s.api.KEY_AUTO, { posts: all });
  await s.api.deletePost("1", "test-password");
  assert.deepEqual(ids(s.catalog), ["2"]);
  for (const key of [s.api.KEY_AUTO, s.api.keyFor("imported")]) assert.deepEqual(s.cache.get(key).posts.map((p) => p.id), ["2"]);
  assert.equal(s.cache.get(s.api.KEY_INDEX).items[0].count, 1);
  assert.ok(s.emitted.some(([name, event]) => name === "deleted" && event.id === "1"));
  await s.api.boot();
  assert.deepEqual(ids(s.catalog), ["2"]);
});

test("failed server writes never silently hide or remove the post locally", async () => {
  const s = setup();
  await s.api.boot();
  s.sources.deletePost = async () => { throw new Error("write failed"); };
  await assert.rejects(() => s.api.deletePost("1", "test-password"), /write failed/);
  assert.deepEqual(ids(s.catalog), ["1", "2"]);
  assert.ok(!s.emitted.some(([name]) => name === "deleted"));
});

test("static hosts report setup requirements instead of pretending to delete", async () => {
  const s = setup({ enabled: false });
  await s.api.boot();
  assert.deepEqual(ids(s.catalog), ["1", "2"]);
  await assert.rejects(() => s.api.deletionReady(), /server setup/);
});

test("deleting the final post leaves a valid empty imported library on the next boot", async () => {
  const s = setup({ imported: true, deletedIds: ["1"] });
  await s.api.boot();
  await s.api.deletePost("2", "test-password");
  assert.deepEqual(ids(s.catalog), []);
  await s.api.boot();
  assert.equal(s.catalog.source.id, "imported");
  assert.deepEqual(ids(s.catalog), []);
});

function sourcePort({ protocol = "https:", shipped = ["old"], fetch }) {
  let api;
  const code = readFileSync(new URL("../src/infrastructure/datasources/index.js", import.meta.url), "utf8");
  runInNewContext(code, { XR: { define: (_name, _deps, factory) => { api = factory(); } }, location: { protocol }, window: { XREELS_DELETED_IDS: shipped }, fetch, AbortSignal });
  return api;
}

test("data source merges deployed and live deletion ledgers; static/file copies remain usable", async () => {
  const api = sourcePort({ fetch: async () => new Response(JSON.stringify({ enabled: true, deletedIds: ["new"] }), { headers: { "Content-Type": "application/json" } }) });
  const state = await api.deletionState();
  assert.equal(state.enabled, true);
  assert.deepEqual(Array.from(state.deletedIds), ["old", "new"]);
  const staticApi = sourcePort({ fetch: async () => new Response("Not found", { status: 404 }) });
  assert.deepEqual(Array.from((await staticApi.deletionState()).deletedIds), ["old"]);
  const fileApi = sourcePort({ protocol: "file:", fetch: () => { throw new Error("File mode must not fetch"); } });
  assert.equal((await fileApi.deletionState()).enabled, false);
  await assert.rejects(() => fileApi.deletePost("1", "test"), /hosted app/);
});

test("data source preserves server deletion errors and refuses unconfirmed deletion responses", async () => {
  const missing = sourcePort({ fetch: async () => new Response(JSON.stringify({ error: "This post is not in the shared data file." }), { status: 404, headers: { "Content-Type": "application/json" } }) });
  await assert.rejects(() => missing.deletePost("1", "test"), /not in the shared data file/);
  const invalid = sourcePort({ fetch: async () => new Response(JSON.stringify({ deleted: true, id: "1", deletedIds: [] }), { headers: { "Content-Type": "application/json" } }) });
  await assert.rejects(() => invalid.deletePost("1", "test"), /did not confirm deletion/);
});
