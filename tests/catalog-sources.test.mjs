/* The Settings toggles (Show X posts / Show Reddit posts) filter the catalog. Hidden sites
   stay loaded in catalog.all, so switching them back on needs no re-import. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXR } from "./helpers/xr.mjs";

const { XR, load } = createXR();
for (const file of [
  "src/core/util/index.js",
  "src/core/events.js",
  "src/core/domain/events.js",
  "src/core/domain/model.js",
  "src/core/query/search.js",
  "src/core/query/engine.js",
  "src/core/ranking/rails.js",
  "src/application/services/catalog.js",
]) load(file);

const values = { showX: true, showReddit: true, shortMaxSeconds: 180, hideSensitive: false };
XR.provide("app.prefs", { get: (key) => values[key] });
XR.provide("app.activity", {
  isSeen: () => false, isStarred: () => false, isHidden: () => false, inCollection: () => false,
  isUnavailable: () => false, progressOf: () => null, progressAt: () => 0, creatorAffinity: () => ({}),
  collections: () => [], recentOpens: () => [], counts: () => ({ seen: 0, starred: 0, hidden: 0, progress: 0, collections: 0 }),
});
const events = XR.resolve("core.events");
const EV = XR.resolve("core.domain.events");
const model = XR.resolve("core.domain.model");
const catalog = XR.resolve("app.catalog");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const ids = (list) => Array.from(list, (p) => p.id);
const setPref = async (patch) => {
  Object.assign(values, patch);
  events.bus.emit(EV.PREFS_CHANGED, { prefs: values, patch });
  await tick();
};

const photo = (url) => [{ index: 0, kind: "photo", thumb: url }];
const video = (url) => [{ index: 0, kind: "video", thumb: url + ".jpg", poster: url + ".jpg", src: url + ".mp4", duration: 12 }];
const xPost = (id, user, media = photo("https://pbs.twimg.com/" + id + ".jpg")) => model.createPost({ id, text: "x " + id, author: { username: user }, media, source: "xdash" });
const redditPost = (id, media = photo("https://i.redd.it/" + id + ".jpg")) => model.createPost({ id, platform: "reddit", text: "r " + id, author: { username: "alice" }, media, source: "reddit" });
const redditVideo = (id) => redditPost(id, video("https://v.redd.it/" + id));
const library = () => [xPost("1", "someone"), xPost("2", "someone"), redditPost("t3_abc")];

test("switching a site off hides its posts everywhere, and switching it back on shows them again", async () => {
  await catalog.load(library(), { id: "auto", label: "data/x-posts.json" });
  assert.deepEqual(ids(catalog.posts), ["1", "2", "t3_abc"]);

  await setPref({ showReddit: false });
  assert.deepEqual(ids(catalog.posts), ["1", "2"]);
  assert.equal(catalog.size, 2);
  assert.equal(catalog.stats().posts, 2, "counts on Discover and Insights follow the toggle");
  assert.deepEqual(ids(catalog.query({ kind: "all" }).items), ["1", "2"], "search and lists follow the toggle");
  assert.equal(catalog.post("t3_abc"), null, "a hidden post cannot be opened by id");

  await setPref({ showReddit: true });
  assert.deepEqual(ids(catalog.posts), ["1", "2", "t3_abc"], "nothing was re-imported");
});

test("catalog.all keeps every loaded post, so hiding never loses data", async () => {
  await catalog.load(library(), { id: "auto", label: "data/x-posts.json" });
  await setPref({ showX: false });
  assert.deepEqual(ids(catalog.posts), ["t3_abc"]);
  assert.deepEqual(ids(catalog.all), ["1", "2", "t3_abc"]);
  const counts = catalog.countByPlatform();
  assert.equal(counts.x, 2, "counts per site ignore the toggles");
  assert.equal(counts.reddit, 1);
});

test("with both sites off the catalog is empty, and the library is still intact", async () => {
  await catalog.load(library(), { id: "auto", label: "data/x-posts.json" });
  await setPref({ showX: false, showReddit: false });
  assert.equal(catalog.size, 0);
  assert.equal(catalog.all.length, 3);
  await setPref({ showX: true });
  assert.deepEqual(ids(catalog.posts), ["1", "2"]);
});

test("a Reddit creator is marked as Reddit, and a handle shared with X falls back to the X profile", async () => {
  await setPref({ showX: true, showReddit: true });
  await catalog.load([redditPost("t3_solo")], { id: "reddit", label: "data/r-posts.json" });
  assert.equal(catalog.creator("alice").platform, "reddit");
  await catalog.load([redditPost("t3_solo"), xPost("9", "alice")], { id: "auto", label: "data/x-posts.json" });
  assert.equal(catalog.creator("alice").platform, "x");
});

test("Reddit \"Images only\" hides Reddit videos, keeps Reddit photos and galleries, and never touches X", async () => {
  await setPref({ showX: true, showReddit: true, redditImagesOnly: false });
  const gallery = redditPost("t3_gal", [...photo("https://i.redd.it/g1.jpg"), { index: 1, kind: "photo", thumb: "https://i.redd.it/g2.jpg" }]);
  const lib = [xPost("1", "someone"), xPost("2", "someone", video("https://video.twimg.com/2")), redditPost("t3_pic"), gallery, redditVideo("t3_vid")];
  await catalog.load(lib, { id: "auto", label: "data/x-posts.json" });
  assert.deepEqual(ids(catalog.posts), ["1", "2", "t3_pic", "t3_gal", "t3_vid"]);

  await setPref({ redditImagesOnly: true });
  assert.deepEqual(ids(catalog.posts), ["1", "2", "t3_pic", "t3_gal"], "only the Reddit video disappears; the X video stays");
  assert.equal(catalog.post("t3_vid"), null, "a hidden Reddit video cannot be opened by id");
  assert.deepEqual(ids(catalog.query({ kind: "all" }).items).sort(), ["1", "2", "t3_gal", "t3_pic"], "lists and search follow the sub-switch");
  assert.equal(catalog.countByPlatform().reddit, 3, "the per-site count still describes the whole library");
  assert.equal(catalog.all.length, 5, "nothing is unloaded");

  await setPref({ redditImagesOnly: false });
  assert.deepEqual(ids(catalog.posts), ["1", "2", "t3_pic", "t3_gal", "t3_vid"], "switching it back needs no re-import");
});

test("\"Images only\" is subordinate to the Reddit switch: Reddit off hides everything, and the kept value applies again when Reddit returns", async () => {
  await setPref({ showX: true, showReddit: true, redditImagesOnly: true });
  await catalog.load([xPost("1", "someone"), redditPost("t3_pic"), redditVideo("t3_vid")], { id: "auto", label: "data/x-posts.json" });
  assert.deepEqual(ids(catalog.posts), ["1", "t3_pic"]);
  await setPref({ showReddit: false });
  assert.deepEqual(ids(catalog.posts), ["1"]);
  await setPref({ showReddit: true });
  assert.deepEqual(ids(catalog.posts), ["1", "t3_pic"], "the sub-switch value survived while Reddit was off");
  await setPref({ redditImagesOnly: false });
  assert.deepEqual(ids(catalog.posts), ["1", "t3_pic", "t3_vid"]);
});
