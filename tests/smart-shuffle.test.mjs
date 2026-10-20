/* core.query.engine smartShuffle: no more than five videos in a row while a non-video is
   left, images paced across the deck, every post kept exactly once, and the same seed gives
   the same deck. Videos are short/long clips; photos, carousels, GIFs and text are non-video. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXR } from "./helpers/xr.mjs";

const { XR, load } = createXR();
for (const file of ["src/core/util/index.js", "src/core/query/search.js", "src/core/query/engine.js"]) load(file);
const engine = XR.resolve("core.query.engine");

function post(i, video, creator) {
  return {
    id: "p" + i,
    author: { username: creator },
    media: video ? [{ kind: "video" }] : [{ kind: "photo" }],
    hashtags: [],
    metrics: { likes: i % 7 },
    savedAt: 1_700_000_000_000 + i,
    isVideo: video,
  };
}
const ctx = {
  kindOf: (p) => (p.isVideo ? "short" : "photo"),
  isSeen: () => false,
  isStarred: () => false,
  isHidden: () => false,
  progressOf: () => 0,
  isUnavailable: () => false,
};
function deck(videos, images) {
  const items = [];
  for (let i = 0; i < videos; i++) items.push(post(i, true, "creator" + (i % 9)));
  for (let i = 0; i < images; i++) items.push(post(videos + i, false, "creator" + (i % 9)));
  return items;
}
const order = (items, seed) => JSON.parse(JSON.stringify(engine.smartShuffle(items, seed, ctx)));
const longestVideoRun = (list) => {
  let best = 0, run = 0;
  for (const p of list) { run = p.isVideo ? run + 1 : 0; best = Math.max(best, run); }
  return best;
};

test("with enough images, no run of six videos appears, for many seeds", () => {
  const items = deck(120, 40);
  for (let seed = 1; seed <= 25; seed++) assert.ok(longestVideoRun(order(items, seed)) <= 5, `seed ${seed}`);
});

test("with a 1:1 mix, the cap holds and images are spread through the deck", () => {
  const items = deck(60, 60);
  for (let seed = 1; seed <= 10; seed++) {
    const list = order(items, seed);
    assert.ok(longestVideoRun(list) <= 5, `seed ${seed}`);
    const firstHalfImages = list.slice(0, 60).filter((p) => !p.isVideo).length;
    assert.ok(firstHalfImages >= 20 && firstHalfImages <= 40, `seed ${seed}: ${firstHalfImages} images in the first half`);
  }
});

test("when images are scarce, the rule holds for as long as images last, then videos follow", () => {
  /* 5 images can only break up the first 30 videos; the rule cannot hold past that, so the
     images are used where the rule applies and the rest of the deck is videos. */
  const items = deck(100, 5);
  for (let seed = 1; seed <= 10; seed++) {
    const list = order(items, seed);
    const positions = list.map((p, i) => (p.isVideo ? -1 : i)).filter((i) => i >= 0);
    assert.equal(positions.length, 5);
    assert.ok(positions[positions.length - 1] <= 35, `seed ${seed}: last image at ${positions[positions.length - 1]}`);
    assert.ok(longestVideoRun(list.slice(0, positions[positions.length - 1] + 1)) <= 5, `seed ${seed}: cap held while images lasted`);
  }
});

test("no post is lost or duplicated, and the same seed gives the same deck", () => {
  const items = deck(37, 23);
  const a = order(items, 9);
  assert.equal(a.length, items.length);
  assert.equal(new Set(a.map((p) => p.id)).size, items.length);
  assert.deepEqual(order(items, 9).map((p) => p.id), a.map((p) => p.id));
});

test("an all-video or all-image library still shuffles normally", () => {
  assert.equal(order(deck(30, 0), 4).length, 30);
  assert.equal(order(deck(0, 30), 4).length, 30);
});
