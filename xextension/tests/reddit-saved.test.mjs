import test from "node:test";
import assert from "node:assert/strict";
import reddit from "../reddit-saved.js";

/* In-memory stand-in for chrome.storage.local (get/set/remove return promises). */
function memoryArea() {
  const data = new Map();
  return {
    data,
    async get(keys) {
      const out = {};
      for (const key of keys) if (data.has(key)) out[key] = structuredClone(data.get(key));
      return out;
    },
    async set(obj) {
      for (const [key, value] of Object.entries(obj)) data.set(key, structuredClone(value));
    },
    async remove(keys) {
      for (const key of keys) data.delete(key);
    },
  };
}

/* Deterministic RNG: returns the preset values in order, then holds the last one. */
function seqRng(values) {
  let i = 0;
  return () => {
    const value = values[Math.min(i, values.length - 1)];
    i++;
    return value;
  };
}

function row(overrides = {}) {
  return {
    fullname: "t3_abc123",
    className: "thing link over18",
    nsfw: "true",
    title: "  A   saved  title ",
    subreddit: "r/ExampleSub",
    author: "someone",
    permalink: "/r/ExampleSub/comments/abc123/a_saved_title/",
    url: "https://i.redd.it/xyz.jpg",
    domain: "i.redd.it",
    score: "42",
    comments: "7",
    timestamp: 1700000000000,
    thumbnail: "https://b.thumbs.redditmedia.com/t.jpg",
    isGallery: "",
    ...overrides,
  };
}

function post(n) {
  return {
    id: "p" + n,
    fullname: "t3_p" + n,
    title: "post " + n,
    nsfw: true,
    media: [],
  };
}

test("saved listing: accepts only the user's own old.reddit saved page", () => {
  assert.equal(reddit.savedListingAccount("https://old.reddit.com/user/jawad/saved"), "jawad");
  assert.equal(reddit.savedListingAccount("https://old.reddit.com/user/jawad/saved/?count=25&after=t3_x"), "jawad");
  assert.equal(reddit.savedListingAccount("https://old.reddit.com/user/jawad/comments"), null);
  assert.equal(reddit.savedListingAccount("https://www.reddit.com/user/jawad/saved"), null);
  assert.equal(reddit.savedListingAccount("https://old.reddit.com/r/pics/"), null);
});

test("next link: same origin and same account only", () => {
  const base = "https://old.reddit.com/user/jawad/saved/?count=25";
  assert.equal(
    reddit.resolveNextUrl("/user/jawad/saved/?count=25&after=t3_abc", base, "jawad"),
    "https://old.reddit.com/user/jawad/saved/?count=25&after=t3_abc",
  );
  assert.equal(reddit.resolveNextUrl("https://evil.example/user/jawad/saved/", base, "jawad"), null);
  assert.equal(reddit.resolveNextUrl("/user/someoneelse/saved/?after=t3_x", base, "jawad"), null);
  assert.equal(reddit.resolveNextUrl("", base, "jawad"), null);
});

test("classification: NSFW by class or data attribute; comments and SFW never kept", () => {
  assert.equal(reddit.classifyRow(row()), "nsfw-post");
  assert.equal(reddit.classifyRow(row({ className: "thing link", nsfw: "true" })), "nsfw-post");
  assert.equal(reddit.classifyRow(row({ className: "thing link over18", nsfw: "false" })), "nsfw-post");
  assert.equal(reddit.classifyRow(row({ className: "thing link", nsfw: "false" })), "sfw-post");
  assert.equal(reddit.classifyRow(row({ className: "thing link", nsfw: "" })), "sfw-post");
  assert.equal(reddit.classifyRow(row({ fullname: "t1_c0mment", className: "thing comment over18" })), "comment");
  assert.equal(reddit.classifyRow(row({ fullname: "", className: "thing" })), "other");
});

test("normalize: stores export-ready fields and media URLs, no bytes", () => {
  const record = reddit.normalizePost(row(), "2026-10-20T00:00:00.000Z");
  assert.equal(record.id, "abc123");
  assert.equal(record.fullname, "t3_abc123");
  assert.equal(record.title, "A saved title");
  assert.equal(record.subreddit, "ExampleSub");
  assert.equal(record.permalink, "https://www.reddit.com/r/ExampleSub/comments/abc123/a_saved_title/");
  assert.equal(record.created_at, new Date(1700000000000).toISOString());
  assert.equal(record.score, 42);
  assert.equal(record.comments, 7);
  assert.equal(record.nsfw, true);
  assert.deepEqual(record.media, [{ kind: "image", url: "https://i.redd.it/xyz.jpg" }]);
  assert.equal(record.captured_at, "2026-10-20T00:00:00.000Z");
});

test("media: v.redd.it is video, galleries point at the permalink, other hosts have none", () => {
  const video = reddit.normalizePost(row({ url: "https://v.redd.it/vid123", domain: "v.redd.it" }), "t");
  assert.deepEqual(video.media, [{ kind: "video", url: "https://v.redd.it/vid123" }]);

  const gallery = reddit.normalizePost(row({ url: "https://www.reddit.com/gallery/abc123", domain: "reddit.com", isGallery: "true" }), "t");
  assert.equal(gallery.media[0].kind, "gallery");
  assert.equal(gallery.media[0].url, "https://www.reddit.com/r/ExampleSub/comments/abc123/a_saved_title/");

  const link = reddit.normalizePost(row({ url: "https://example.com/story", domain: "example.com" }), "t");
  assert.deepEqual(link.media, []);
});

test("normalize: a bad timestamp or score becomes null rather than NaN", () => {
  const record = reddit.normalizePost(row({ timestamp: "nope", score: "" }), "t");
  assert.equal(record.created_at, null);
  assert.equal(record.score, null);
});

test("processRows: keeps NSFW posts and counts everything else", () => {
  const rows = [
    row({ fullname: "t3_one" }),
    row({ fullname: "t3_two", className: "thing link", nsfw: "false" }),
    row({ fullname: "t1_com", className: "thing comment over18" }),
    row({ fullname: "t3_three" }),
  ];
  const { posts, counts } = reddit.processRows(rows, "t");
  assert.deepEqual(posts.map((p) => p.id), ["one", "three"]);
  assert.deepEqual(counts, { rows: 4, nsfwKept: 2, sfwSkipped: 1, commentsSkipped: 1, otherSkipped: 0 });
});

test("dedupe: drops known ids and repeats inside the batch", () => {
  const fresh = reddit.dedupe([post(1), post(2), post(2), post(3)], new Set(["p1"]));
  assert.deepEqual(fresh.map((p) => p.id), ["p2", "p3"]);
});

test("pacer: gaps stay within bounds and a wave break lands within 8–14 pages", () => {
  const pacer = reddit.createPacer({ rng: seqRng([0, 0.5, 0.25, 0.75, 0.1, 0.9]) });
  const gaps = [];
  for (let i = 0; i < 30; i++) gaps.push(pacer.nextGap());
  const waves = gaps.map((g, i) => (g.wave ? i + 1 : 0)).filter(Boolean);
  assert.ok(waves.length >= 2, "expected at least two wave breaks in 30 pages");
  for (let i = 1; i < waves.length; i++) {
    const spacing = waves[i] - waves[i - 1];
    assert.ok(spacing >= 8 && spacing <= 14, "wave spacing " + spacing + " out of range");
  }
  for (const gap of gaps) {
    if (gap.wave) assert.ok(gap.ms >= reddit.DEFAULT_PACING.waveMinMs && gap.ms <= reddit.DEFAULT_PACING.waveMaxMs);
    else assert.ok(gap.ms >= reddit.DEFAULT_PACING.minDelayMs && gap.ms <= reddit.DEFAULT_PACING.maxDelayMs);
  }
});

test("backoff: grows exponentially, never exceeds the cap, keeps jitter in range", () => {
  const top = reddit.computeBackoff(0, { rng: () => 1 });
  assert.equal(top, reddit.DEFAULT_PACING.backoffBaseMs);
  const low = reddit.computeBackoff(0, { rng: () => 0 });
  assert.equal(low, reddit.DEFAULT_PACING.backoffBaseMs / 2);
  assert.equal(reddit.computeBackoff(1, { rng: () => 1 }), reddit.DEFAULT_PACING.backoffBaseMs * 2);
  assert.equal(reddit.computeBackoff(20, { rng: () => 1 }), reddit.DEFAULT_PACING.backoffCapMs);
});

test("status: 2xx ok, 429 and 5xx retry, other codes stop", () => {
  assert.equal(reddit.classifyStatus(200), "ok");
  assert.equal(reddit.classifyStatus(429), "retry");
  assert.equal(reddit.classifyStatus(503), "retry");
  assert.equal(reddit.classifyStatus(403), "fatal");
  assert.equal(reddit.classifyStatus(404), "fatal");
});

test("store: chunks at 256, keeps capture order, dedupes across instances", async () => {
  const area = memoryArea();
  const store = reddit.createStore(area);
  const posts = Array.from({ length: 300 }, (_, i) => post(i));
  assert.equal(await store.append(posts.slice(0, 200), { account: "jawad" }), 200);
  assert.equal(await store.append(posts.slice(150, 300)), 100, "150–199 are repeats, 200–299 are new");

  assert.equal(area.data.get(reddit.META_KEY).chunks, 2);
  assert.equal(area.data.get(reddit.META_KEY).count, 300);
  assert.equal(area.data.get(reddit.META_KEY).account, "jawad");
  assert.equal(area.data.get("redditSavedChunk.000000").length, 256);
  assert.equal(area.data.get("redditSavedChunk.000001").length, 44);

  const reopened = reddit.createStore(area);
  await reopened.load();
  assert.equal(await reopened.append([post(5), post(299), post(300)]), 1, "only post 300 is new");

  const all = await reddit.createStore(area).readAll();
  assert.equal(all.length, 301);
  assert.equal(all[0].id, "p0");
  assert.equal(all[300].id, "p300");
});

test("store: clear removes every chunk and the meta record", async () => {
  const area = memoryArea();
  const store = reddit.createStore(area);
  await store.append(Array.from({ length: 300 }, (_, i) => post(i)), { account: "jawad" });
  await store.clear();
  assert.equal(area.data.size, 0);
  assert.deepEqual(await reddit.createStore(area).readAll(), []);
});

test("store: empty storage reads as empty and reports no account", async () => {
  const store = reddit.createStore(memoryArea());
  await store.load();
  assert.equal(store.count(), 0);
  assert.equal(store.account(), null);
  assert.deepEqual(await store.readAll(), []);
});

test("export: envelope matches the documented shape", () => {
  const out = reddit.buildExport({
    posts: [post(1), post(2)],
    account: "jawad",
    exportedAt: "2026-10-20T10:00:00.000Z",
    scan: { pages: 3, rows: 70, nsfwKept: 2, sfwSkipped: 60, commentsSkipped: 8 },
  });
  assert.deepEqual(Object.keys(out), ["export_version", "exported_at", "source", "account", "count", "scan", "posts"]);
  assert.equal(out.export_version, 2); // v2: video media carry captured CMAF files + audio
  assert.equal(out.source, "reddit-saved-nsfw");
  assert.equal(out.account, "jawad");
  assert.equal(out.count, 2);
  assert.deepEqual(out.scan, { pages: 3, rows: 70, nsfw_kept: 2, sfw_skipped: 60, comments_skipped: 8 });
  assert.equal(out.posts.length, 2);
  assert.equal(reddit.FILE_NAME, "reddit-nsfw-saved.json");
});
