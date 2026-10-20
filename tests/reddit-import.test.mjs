/* The importer end to end, with the real adapters, catalog and importer code. Only storage,
   the data sources and the platform are faked. It covers how data/r-posts.json is read,
   merged beside the X library, and kept out of X libraries. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXR } from "./helpers/xr.mjs";

const redditExport = {
  export_version: 1, source: "reddit-saved-nsfw", count: 2,
  posts: [
    { fullname: "t3_abc123", title: "Sunset", subreddit: "NSFWPics", author: "alice", permalink: "/r/NSFWPics/comments/abc123/sunset/", url: "https://i.redd.it/x1.jpg", score: 4, comments: 0, created_at: "2026-05-01T12:00:00.000Z", nsfw: true, thumbnail: "nsfw", media: [{ kind: "image", url: "https://i.redd.it/x1.jpg" }], captured_at: "2026-10-19T08:00:00.000Z" },
    { fullname: "t3_def456", title: "Again", subreddit: "NSFW", author: "bob", permalink: "/r/NSFW/comments/def456/again/", url: "https://i.redd.it/x2.jpg", score: 9, comments: 2, created_at: "2026-05-02T12:00:00.000Z", nsfw: true, thumbnail: "nsfw", media: [{ kind: "image", url: "https://i.redd.it/x2.jpg" }], captured_at: "2026-10-19T08:00:00.000Z" },
  ],
};
const xExport = (ids) => ({
  export_version: 1, exported_at: "2026-10-19T17:00:00.000Z",
  bookmarks: ids.map((id, i) => ({ tweet_id: id, text: "post " + id, author_username: "someone", tweet_created_at: "2026-01-01T00:00:00Z", captured_at: "2026-10-19T17:00:00.000Z", capture_order: i + 1, media_items: [{ type: "photo", url: `https://pbs.twimg.com/media/${id}.jpg` }] })),
});

/* Each test gets a fresh module instance: the importer keeps its state in the module. */
const FILES = [
  "src/core/util/index.js",
  "src/core/events.js",
  "src/core/domain/events.js",
  "src/core/domain/model.js",
  "src/core/adapters/registry.js",
  "src/core/adapters/common.js",
  "src/core/adapters/xdash.js",
  "src/core/adapters/reddit.js",
  "src/core/query/search.js",
  "src/core/query/engine.js",
  "src/core/ranking/rails.js",
  "src/application/services/catalog.js",
  "src/application/services/importer.js",
];

const plain = (value) => JSON.parse(JSON.stringify(value));
const ids = (list) => Array.from(list, (p) => p.id);

/**
 * xText: the X library file (string). redditText: data/r-posts.json contents; `undefined` means
 * the static host has no Reddit source at all (file://), `null` means the file is missing.
 */
function setup({ xText = JSON.stringify(xExport(["1893", "1894"])), redditText, noX = false, deletedIds = [] } = {}) {
  const { XR, load } = createXR();
  for (const file of FILES) load(file);
  // Adapters register themselves when resolved, so resolve them before any import runs.
  XR.resolve("core.adapters.xdash");
  XR.resolve("core.adapters.reddit");
  const cache = new Map();
  const storage = {
    get: async (key) => structuredClone(cache.get(key)),
    set: async (key, value) => { cache.set(key, structuredClone(value)); },
    remove: async (key) => { cache.delete(key); },
    keys: async () => [...cache.keys()],
  };
  const sources = {
    get(kind) {
      if (kind === "auto") return { id: "auto", kind: "auto", label: "data/x-posts.json", available: () => true, load: async () => (noX ? null : { text: xText, label: "data/x-posts.json" }) };
      if (kind === "reddit") {
        if (redditText === undefined) return null;
        return { id: "reddit", kind: "reddit", label: "data/r-posts.json", available: () => true, load: async () => (redditText === null ? null : { text: redditText, label: "data/r-posts.json" }) };
      }
      return null;
    },
    deletionState: async () => ({ enabled: true, deletedIds }),
    deletePost: async (id) => ({ deleted: true, id, deletedIds: [...deletedIds, id] }),
  };
  const values = { keepTextOnly: false, showX: true, showReddit: true, shortMaxSeconds: 180, hideSensitive: false };
  XR.provide("app.ports.storage", storage);
  XR.provide("app.ports.dataSources", sources);
  XR.provide("app.ports.platform", { isFile: () => false, download() {}, copy: async () => true });
  XR.provide("app.prefs", { get: (k) => values[k], set: (patch) => Object.assign(values, patch) });
  XR.provide("app.diagnostics", { mark() {} });
  XR.provide("app.activity", {
    isSeen: () => false, isStarred: () => false, isHidden: () => false, inCollection: () => false,
    isUnavailable: () => false, progressOf: () => null, progressAt: () => 0, creatorAffinity: () => ({}),
    collections: () => [], recentOpens: () => [], counts: () => ({ seen: 0, starred: 0, hidden: 0, progress: 0, collections: 0 }),
  });
  return { importer: XR.resolve("app.importer"), catalog: XR.resolve("app.catalog"), cache };
}

test("Reddit posts load beside the X library on boot", async () => {
  const { importer, catalog } = setup({ redditText: JSON.stringify(redditExport) });
  await importer.boot();
  assert.deepEqual(ids(catalog.posts), ["1893", "1894", "t3_abc123", "t3_def456"]);
  assert.equal(importer.redditStatus().state, "ready");
  assert.equal(importer.redditStatus().count, 2);
});

test("an X import that replaces the library keeps the Reddit posts visible", async () => {
  const { importer, catalog } = setup({ redditText: JSON.stringify(redditExport) });
  await importer.boot();
  const analysed = await importer.analyze(JSON.stringify(xExport(["5", "6", "7"])), { label: "new export" });
  await importer.commit(analysed, { mode: "replace" });
  assert.deepEqual(ids(catalog.posts), ["5", "6", "7", "t3_abc123", "t3_def456"]);
});

test("Reddit posts are never written into an X library, even on a merge", async () => {
  const { importer, catalog, cache } = setup({ redditText: JSON.stringify(redditExport) });
  await importer.boot();
  const analysed = await importer.analyze(JSON.stringify(xExport(["5"])), { label: "more" });
  await importer.commit(analysed, { mode: "merge" });
  const stored = [...cache.values()].filter((v) => Array.isArray(v?.posts) && v.adapter !== "reddit");
  assert.ok(stored.length > 0);
  for (const library of stored) assert.ok(library.posts.every((p) => p.platform !== "reddit"), "no Reddit post inside an X library");
  assert.ok(ids(catalog.posts).includes("t3_abc123"));
  assert.deepEqual(plain(importer.diffAgainstCatalog(analysed.posts).addedIds), [], "the X diff ignores Reddit posts");
});

test("a missing data/r-posts.json is reported as missing and never blocks the X library", async () => {
  const { importer, catalog } = setup({ redditText: null });
  await importer.boot();
  assert.equal(importer.redditStatus().state, "missing");
  assert.deepEqual(ids(catalog.posts), ["1893", "1894"]);
  assert.equal(catalog.source.reddit.state, "missing");
});

test("a file that is not a Reddit export is refused with a clear message, and X still opens", async () => {
  const { importer, catalog } = setup({ redditText: JSON.stringify(xExport(["42"])) });
  await importer.boot();
  const status = importer.redditStatus();
  assert.equal(status.state, "error");
  assert.match(status.error, /not a Reddit export/);
  assert.deepEqual(ids(catalog.posts), ["1893", "1894"]);
});

test("an unreadable data/r-posts.json reports an error and never stops the X library", async () => {
  const { importer, catalog } = setup({ redditText: "{ not json" });
  await importer.boot();
  assert.equal(importer.redditStatus().state, "error");
  assert.match(importer.redditStatus().error, /Not valid JSON/);
  assert.deepEqual(ids(catalog.posts), ["1893", "1894"]);
});

test("Reddit posts cannot be deleted through the shared X data file", async () => {
  const { importer } = setup({ redditText: JSON.stringify(redditExport) });
  await importer.boot();
  await assert.rejects(() => importer.deletePost("t3_abc123", "test-password"), /can't be deleted here/);
});

test("with no X library, the Reddit posts become the source instead of 'No data'", async () => {
  const { importer, catalog } = setup({ noX: true, redditText: JSON.stringify(redditExport) });
  await importer.boot();
  assert.equal(catalog.source.id, "reddit");
  assert.deepEqual(ids(catalog.posts), ["t3_abc123", "t3_def456"]);
});

test("an unchanged data/r-posts.json is served from cache on the next boot", async () => {
  const { importer, catalog } = setup({ redditText: JSON.stringify(redditExport) });
  await importer.boot();
  assert.equal(importer.redditStatus().cached, false);
  await importer.boot();
  assert.equal(importer.redditStatus().cached, true);
  assert.deepEqual(ids(catalog.posts), ["1893", "1894", "t3_abc123", "t3_def456"]);
});

test("a Reddit-free setup (file:// has no r-posts source) behaves exactly as before", async () => {
  const { importer, catalog } = setup({ redditText: undefined });
  await importer.boot();
  assert.equal(importer.redditStatus().state, "unavailable");
  assert.deepEqual(ids(catalog.posts), ["1893", "1894"]);
});

test("Reddit saves without media are left out; the Reddit count is the number of saves with a picture", async () => {
  const withText = {
    ...redditExport, count: 3,
    posts: [...redditExport.posts,
      { fullname: "t3_txt789", title: "Words only", subreddit: "NSFW", author: "eve", permalink: "/r/NSFW/comments/txt789/words/", url: "https://www.reddit.com/r/NSFW/comments/txt789/words/", score: 2, comments: 1, created_at: "2026-05-03T12:00:00.000Z", nsfw: true, thumbnail: "self", media: [] }],
  };
  const { importer, catalog } = setup({ redditText: JSON.stringify(withText) });
  await importer.boot();
  assert.ok(!ids(catalog.posts).includes("t3_txt789"), "the text-only Reddit save is not in the library");
  assert.equal(importer.redditStatus().count, 2);
});
