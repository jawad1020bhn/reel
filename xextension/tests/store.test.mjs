import test from "node:test";
import assert from "node:assert/strict";
import storeApi from "../store.js";

function storageMock(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    api: {
      async get(keys) {
        if (typeof keys === "string") return keys in values ? { [keys]: structuredClone(values[keys]) } : {};
        if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in values).map((key) => [key, structuredClone(values[key])]));
        return structuredClone(values);
      },
      async set(changes) { Object.assign(values, structuredClone(changes)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
    },
  };
}

function installStorage(initial = {}) {
  const mock = storageMock(initial);
  globalThis.chrome = { storage: { local: mock.api } };
  return mock;
}

const post = (id, type = "photo") => ({
  tweet_id: String(id),
  capture_order: 0,
  media_items: [{ type, url: `https://pbs.twimg.com/${id}.jpg` }],
  first_seen_at: "2026-01-01T00:00:00.000Z",
  captured_at: "2026-01-01T00:00:00.000Z",
});

test("writes bounded chunks and returns complete, ordered exports", async () => {
  const mock = installStorage();
  const store = await storeApi.open();
  for (let id = 1; id <= 1100; id++) store.upsert(post(id, id % 3 === 0 ? "video" : "photo"));
  const summary = await store.flush();

  assert.equal(summary.count, 1100);
  assert.equal(summary.chunks, 5);
  assert.equal(summary.mediaItems, 1100);
  assert.equal(summary.videos, 366);
  assert.equal(Object.keys(mock.values).filter((key) => key.startsWith(storeApi.CHUNK_PREFIX)).length, 5);
  assert.equal((await storeApi.readAll()).length, 1100);
});

test("initializes metadata on an empty store without waiting for new posts", async () => {
  const mock = installStorage();
  const store = await storeApi.open();
  assert.equal(store.needsFlush, true);
  await store.flush();
  assert.equal(store.needsFlush, false);
  assert.equal(mock.values.xBookmarkMeta.total, 0);
});

test("upserts by exact tweet ID without collapsing similar posts", async () => {
  installStorage();
  const store = await storeApi.open();
  store.upsert({ ...post("111"), text: "same caption" });
  store.upsert({ ...post("222"), text: "same caption" });
  store.upsert({ ...post("111", "video"), text: "edited caption", last_seen_at: "2026-02-01T00:00:00.000Z" });
  await store.flush();

  const items = await storeApi.readAll();
  assert.equal(items.length, 2);
  assert.equal(items.find((item) => item.tweet_id === "111").text, "edited caption");
  assert.equal(items.find((item) => item.tweet_id === "111").capture_order, 1);
});

test("migrates the legacy xBookmarks array once without dropping records", async () => {
  const legacy = Array.from({ length: 300 }, (_, index) => post(index + 1));
  const mock = installStorage({ xBookmarks: legacy });
  const store = await storeApi.open();
  assert.equal(store.total, 300);
  await store.flush();

  assert.equal("xBookmarks" in mock.values, false);
  assert.equal(mock.values.xBookmarkMeta.version, 2);
  assert.equal(mock.values.xBookmarkMeta.total, 300);
  assert.equal((await storeApi.readAll()).length, 300);
});

test("refuses to export silently when a chunk is missing", async () => {
  installStorage({
    xBookmarkMeta: { version: 2, chunkCount: 2, total: 3, mediaItems: 0, videos: 0 },
    [storeApi.chunkKey(0)]: [post("1"), post("2")],
  });
  await assert.rejects(storeApi.readAll(), /missing chunk/);
});

test("clear removes modern chunks and metadata", async () => {
  const mock = installStorage();
  const store = await storeApi.open();
  store.upsert(post("900"));
  await store.flush();
  await storeApi.clear();
  assert.deepEqual(await storeApi.readAll(), []);
  assert.equal("xBookmarkMeta" in mock.values, false);
});
