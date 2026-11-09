/* The smart shuffle as a system, not a function: simulate sessions and check that it
   converges on what the user actually watches, that a deck is never lost or duplicated,
   that the new signals never make it slow, and that explain mode survives engine.run. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXR } from "./helpers/xr.mjs";

const { XR, load } = createXR();
for (const file of ["src/core/util/index.js", "src/core/query/search.js", "src/core/query/engine.js"]) load(file);
const engine = XR.resolve("core.query.engine");

function post(i, creator = "c" + (i % 8), video = i % 3 !== 0) {
  return {
    id: "p" + i,
    author: { username: creator },
    media: [{ kind: video ? "video" : "photo" }],
    hashtags: ["t" + (i % 5)],
    metrics: { likes: i % 11 },
    savedAt: 1_700_000_000_000 + i,
    isVideo: video,
  };
}
/** a ctx backed by mutable tables, standing in for app.activity */
function memory() {
  const state = { attention: {}, skip: {}, affinity: {}, deck: null, seen: new Set() };
  const ctx = {
    kindOf: (p) => (p.isVideo ? "short" : "photo"),
    isSeen: (id) => state.seen.has(id),
    isStarred: () => false,
    isHidden: () => false,
    progressOf: () => 0,
    isUnavailable: () => false,
    signals: {
      mode: "balanced",
      attentionOf: (id) => state.attention[id] || 0,
      skipRateOf: (id) => state.skip[id] || 0,
      affinityOf: (u) => state.affinity[u] || 0,
      lastDeck: () => state.deck,
      sessionSeen: null,
    },
  };
  return { state, ctx };
}
const ids = (list) => list.map((p) => p.id);
const rank = (list, id) => list.findIndex((p) => p.id === id);

test("over six sessions the posts that hold attention climb toward the top", () => {
  const items = Array.from({ length: 60 }, (_, i) => post(i));
  const loved = ["p4", "p11", "p23"];
  const { state, ctx } = memory();
  const firstRank = rank(engine.smartShuffle(items, 1, ctx), "p4");
  /* the user watches three posts to the end every session; the rest are swiped past */
  for (let session = 0; session < 6; session++) {
    const deck = engine.smartShuffle(items, 100 + session, ctx);
    state.deck = ids(deck).slice(0, 20);
    for (const p of deck) {
      if (loved.includes(p.id)) state.attention[p.id] = Math.min(1, (state.attention[p.id] || 0) + 0.4);
      else state.skip[p.id] = Math.min(1, (state.skip[p.id] || 0) + 0.2);
    }
  }
  const last = engine.smartShuffle(items, 999, ctx);
  const lastRank = rank(last, "p4");
  assert.ok(lastRank < firstRank, `p4 should rise over sessions (${firstRank} → ${lastRank})`);
  assert.ok(lastRank <= 8, `a post watched six times should open the deck (rank ${lastRank})`);
});

test("a creator the user keeps skipping falls in the order over sessions", () => {
  const items = Array.from({ length: 60 }, (_, i) => post(i, i < 20 ? "loud" : "c" + (i % 7)));
  const loud = items.filter((p) => p.author.username === "loud").map((p) => p.id);
  const mean = (list) => {
    const pos = ids(list).map((id, i) => (loud.includes(id) ? i : -1)).filter((i) => i >= 0);
    return pos.reduce((a, b) => a + b, 0) / pos.length;
  };
  const { state, ctx } = memory();
  const before = mean(engine.smartShuffle(items, 7, ctx));
  state.affinity.loud = -3;                    // activity: opens decayed away, skips accumulated
  for (const id of loud) state.skip[id] = 0.8;
  const after = mean(engine.smartShuffle(items, 7, ctx));
  assert.ok(after > before + 2, `@loud should sink (${before.toFixed(1)} → ${after.toFixed(1)})`);
});

test("two consecutive shuffles share at most a couple of opening posts", () => {
  const items = Array.from({ length: 80 }, (_, i) => post(i));
  const { state, ctx } = memory();
  for (let round = 0; round < 5; round++) {
    const a = engine.smartShuffle(items, 200 + round, ctx);
    const opening = ids(a).slice(0, 8);
    state.deck = ids(a).slice(0, 24);
    const b = engine.smartShuffle(items, 300 + round, ctx);
    const overlap = ids(b).slice(0, 10).filter((id) => opening.includes(id)).length;
    assert.ok(overlap <= 2, `round ${round}: ${overlap} of the previous opening repeated`);
  }
});

test("every deck keeps every post exactly once, whatever the signals say", () => {
  const items = Array.from({ length: 137 }, (_, i) => post(i));
  const { state, ctx } = memory();
  for (let i = 0; i < 40; i++) { state.attention["p" + i] = 0.7; state.skip["p" + (i + 40)] = 0.5; }
  state.affinity.c3 = 4;
  state.deck = ids(items).slice(0, 24);
  for (let seed = 1; seed <= 12; seed++) {
    const deck = engine.smartShuffle(items, seed, ctx);
    assert.equal(deck.length, items.length, `seed ${seed}`);
    assert.equal(new Set(ids(deck)).size, items.length, `seed ${seed} has duplicates`);
  }
});

test("the learned deck does not get slower as the library grows (5 000 posts < 400 ms)", () => {
  const items = Array.from({ length: 5000 }, (_, i) => post(i, "c" + (i % 120)));
  const { state, ctx } = memory();
  for (let i = 0; i < 500; i++) { state.attention["p" + i] = 0.6; state.skip["p" + (i + 500)] = 0.4; }
  state.deck = ids(items).slice(0, 24);
  const t0 = performance.now();
  const deck = engine.smartShuffle(items, 42, ctx);
  const ms = performance.now() - t0;
  assert.equal(deck.length, items.length);
  assert.ok(ms < 400, `smart shuffle took ${Math.round(ms)} ms for 5 000 posts`);
});

test("engine.run carries the explain table through, and neutral signals still match a plain deck", () => {
  const items = Array.from({ length: 40 }, (_, i) => post(i));
  const { ctx } = memory();
  const plain = { ...ctx, signals: undefined };
  const res = engine.run(items, { sort: "smart", seed: 5, explain: true }, ctx);
  assert.ok(res.explain && typeof res.explain.get === "function", "run returns the table");
  assert.ok(res.explain.get(res.items[0].id), "the opening post is explained");
  assert.equal(res.items.length, items.length);
  assert.deepEqual(
    ids(engine.run(items, { sort: "smart", seed: 5 }, plain).items),
    ids(engine.run(items, { sort: "smart", seed: 5 }, ctx).items),
    "empty signals are a no-op",
  );
});

test("the lead block never shows the same creator twice when it can avoid it", () => {
  const items = Array.from({ length: 40 }, (_, i) => post(i, "c" + (i % 4)));
  const { ctx } = memory();
  const deck = engine.smartShuffle(items, 3, ctx);
  const lead = deck.slice(0, 4).map((p) => p.author.username);
  assert.equal(new Set(lead).size, lead.length, `lead creators: ${lead}`);
});
