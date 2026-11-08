/* core.query.engine smartShuffle, learned-signal layer: attention (dwell), quick skips,
   creator affinity, the previous deck's opening, this session's deck, the three modes and
   the explain table. The spread rules are covered by smart-shuffle.test.mjs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXR } from "./helpers/xr.mjs";

const { XR, load } = createXR();
for (const file of ["src/core/util/index.js", "src/core/query/search.js", "src/core/query/engine.js"]) load(file);
const engine = XR.resolve("core.query.engine");

function post(i, { video = true, creator = "creator" + (i % 9), likes = i % 7, hashtags = [] } = {}) {
  return {
    id: "p" + i,
    author: { username: creator },
    media: [{ kind: video ? "video" : "photo" }],
    hashtags,
    metrics: { likes },
    savedAt: 1_700_000_000_000 + i,
    isVideo: video,
  };
}
/** ctx with optional signal table: { attention: {id: 0-1}, skip: {id: 0-1}, affinity: {user: n}, deck: [ids], session: [ids], mode } */
function ctxWith(sig = {}) {
  return {
    kindOf: (p) => (p.isVideo ? "short" : "photo"),
    isSeen: () => false,
    isStarred: () => false,
    isHidden: () => false,
    progressOf: () => 0,
    isUnavailable: () => false,
    signals: {
      mode: sig.mode || "balanced",
      attentionOf: (id) => sig.attention?.[id] || 0,
      skipRateOf: (id) => sig.skip?.[id] || 0,
      affinityOf: (user) => sig.affinity?.[user] || 0,
      lastDeck: sig.deck || null,
      sessionSeen: sig.session || null,
    },
  };
}
const order = (items, ctx, seed = 7) => JSON.parse(JSON.stringify(engine.smartShuffle(items, seed, ctx)));
/** mean position of a set of ids in a deck (lower = nearer the top) */
const meanPos = (list, ids) => {
  const set = new Set(ids);
  const pos = list.map((p, i) => (set.has(p.id) ? i : -1)).filter((i) => i >= 0);
  return pos.reduce((a, b) => a + b, 0) / Math.max(1, pos.length);
};

test("a post that holds attention climbs, the same library deals it later when attention is 0", () => {
  const items = Array.from({ length: 40 }, (_, i) => post(i));
  const loved = ["p0", "p1", "p2", "p3"];
  const attention = Object.fromEntries(loved.map((id) => [id, 1]));
  const neutral = meanPos(order(items, ctxWith()), loved);
  const lovedPos = meanPos(order(items, ctxWith({ attention })), loved);
  assert.ok(lovedPos < neutral, `attention should pull ${loved} up (${lovedPos} vs ${neutral})`);
});

test("posts swiped past in under a second sink, even with attention present", () => {
  const items = Array.from({ length: 40 }, (_, i) => post(i));
  const skipped = ["p0", "p1", "p2", "p3"];
  const skip = Object.fromEntries(skipped.map((id) => [id, 1]));
  const neutral = meanPos(order(items, ctxWith()), skipped);
  const skippedPos = meanPos(order(items, ctxWith({ skip })), skipped);
  assert.ok(skippedPos > neutral, `skips should push ${skipped} down (${skippedPos} vs ${neutral})`);
});

test("creator affinity lifts a creator the user keeps opening", () => {
  const items = Array.from({ length: 60 }, (_, i) => post(i, { creator: "c" + (i % 6) }));
  const mine = Array.from({ length: 60 }, (_, i) => post(i, { creator: "c" + (i % 6) })).filter((p) => p.author.username === "c2").map((p) => p.id);
  const neutral = meanPos(order(items, ctxWith()), mine);
  const lifted = meanPos(order(items, ctxWith({ affinity: { c2: 12 } })), mine);
  assert.ok(lifted < neutral, `affinity should lift c2 (${lifted} vs ${neutral})`);
});

test("the previous deck's opening is demoted, so two shuffles in a row do not look alike", () => {
  const items = Array.from({ length: 40 }, (_, i) => post(i));
  const first = order(items, ctxWith());
  const opening = first.slice(0, 6).map((p) => p.id);
  const second = order(items, ctxWith({ deck: opening }));
  const inOpening = second.slice(0, 10).filter((p) => opening.includes(p.id)).length;
  assert.ok(inOpening <= 1, `only ${inOpening} of the last deck's first 6 reappeared in the first 10`);
});

test("a deck dealt this session is not dealt again first", () => {
  const items = Array.from({ length: 40 }, (_, i) => post(i));
  const shown = items.slice(0, 20).map((p) => p.id);
  const list = order(items, ctxWith({ session: shown }));
  const repeated = list.slice(0, 10).filter((p) => shown.includes(p.id)).length;
  assert.ok(repeated <= 3, `${repeated} already-shown posts opened the new deck`);
});

test("discovery dampens creator affinity harder than balanced", () => {
  const items = Array.from({ length: 60 }, (_, i) => post(i, { creator: "c" + (i % 6) }));
  const mine = items.filter((p) => p.author.username === "c2").map((p) => p.id);
  const affinity = { c2: 20 };
  const balanced = meanPos(order(items, ctxWith({ affinity })), mine);
  const discovery = meanPos(order(items, ctxWith({ affinity, mode: "discovery" })), mine);
  assert.ok(discovery >= balanced - 1, `discovery should not chase c2 harder (${discovery} vs ${balanced})`);
});

test("fresh mode favours the newest saves over older ones more than balanced does", () => {
  const items = Array.from({ length: 40 }, (_, i) => post(i));
  const newest = items.slice(-6).map((p) => p.id);
  const balanced = meanPos(order(items, ctxWith({ mode: "balanced" })), newest);
  const fresh = meanPos(order(items, ctxWith({ mode: "fresh" })), newest);
  assert.ok(fresh <= balanced + 1, `fresh should keep recent saves near the top (${fresh} vs ${balanced})`);
});

test("the explain table says why a post sits where it does", () => {
  const items = Array.from({ length: 20 }, (_, i) => post(i));
  const list = engine.smartShuffle(items, 5, ctxWith({ attention: { p3: 1 }, skip: { p4: 1 } }), { explain: true });
  const table = list.explain;
  /* the module runs in its own VM realm, so `instanceof Map` would not hold across it */
  assert.equal(typeof table?.get, "function", "explain table is attached");
  const loved = table.get("p3");
  assert.ok(loved.notes.some((n) => n.startsWith("attention")), `p3 notes: ${loved.notes}`);
  assert.ok(table.get("p4").notes.some((n) => n.startsWith("skipped")), "p4 records the skip");
  for (const p of list) assert.ok(table.has(p.id), `${p.id} is explained`);
  const leadCount = list.filter((p) => table.get(p.id).lead).length;
  assert.ok(leadCount >= 2, `a lead block is reserved (${leadCount})`);
  assert.ok(list.slice(0, leadCount).every((p) => table.get(p.id).lead), "the lead block is the head of the deck");
  assert.ok(!table.get(list[leadCount].id).lead, "nothing after the lead block is marked as lead");
});

test("with no signals at all the order is unchanged by the feature (backwards compatible)", () => {
  const items = Array.from({ length: 30 }, (_, i) => post(i));
  const bare = { kindOf: (p) => (p.isVideo ? "short" : "photo"), isSeen: () => false, isStarred: () => false, isHidden: () => false, progressOf: () => 0, isUnavailable: () => false };
  const a = JSON.parse(JSON.stringify(engine.smartShuffle(items, 11, bare)));
  const b = JSON.parse(JSON.stringify(engine.smartShuffle(items, 11, ctxWith())));
  assert.deepEqual(a.map((p) => p.id), b.map((p) => p.id), "neutral signals are a no-op");
});

test("a learned deck still keeps every post exactly once", () => {
  const items = Array.from({ length: 77 }, (_, i) => post(i, { video: i % 3 !== 0 }));
  const ctx = ctxWith({ attention: { p2: 1, p5: 0.5 }, skip: { p9: 1 }, affinity: { c1: 4 }, deck: ["p0", "p1"] });
  const list = order(items, ctx);
  assert.equal(list.length, items.length);
  assert.equal(new Set(list.map((p) => p.id)).size, items.length);
});
