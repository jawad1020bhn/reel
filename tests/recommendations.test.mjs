/* Pure recommendation-algorithm regressions; no browser or private library is used. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const definitions = new Map();
globalThis.XR = { define: (name, deps, factory) => definitions.set(name, { deps, factory }) };
for (const file of ["src/core/util/index.js", "src/core/ranking/recommendations.js"]) {
  vm.runInThisContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), { filename: file });
}
delete globalThis.XR;
const instances = new Map();
function resolve(name) {
  if (instances.has(name)) return instances.get(name);
  const definition = definitions.get(name);
  const value = definition.factory(...definition.deps.map(resolve));
  instances.set(name, value);
  return value;
}
const recs = resolve("core.ranking.recommendations");

const makePost = (id, { creator = `creator-${id}`, tags = [], kind = "video", duration = 40, likes = 0, views = 0, savedAt = 0 } = {}) => ({
  id, text: `post ${id}`, createdAt: savedAt, savedAt,
  author: { username: creator, name: creator },
  metrics: { likes, reposts: 0, replies: 0, bookmarks: 0, views },
  media: kind === "photo" ? [{ kind: "photo", aspect: 1 }] : [{ kind, aspect: 0.65, duration }],
  hashtags: tags,
});
function context({ recent = [], starred = [], openedCreators = new Map() } = {}) {
  const starredIds = new Set(starred.map((post) => post.id));
  return {
    isHidden: () => false,
    isUnavailable: () => false,
    isSeen: () => false,
    isStarred: (id) => starredIds.has(id),
    creatorAffinity: () => openedCreators,
    recentlyOpened: () => recent,
    kindOf: (post) => post.media[0]?.kind === "photo" ? "photo" : "short",
  };
}

test("interest profile learns recent topics and creator affinity, with a PPMI side path", () => {
  const now = Date.now();
  const opened = Array.from({ length: 8 }, (_, i) => makePost(`open-${i}`, {
    creator: "familiar", tags: ["cinema", "frame"], savedAt: now - i * 1000,
  }));
  const bridge = Array.from({ length: 18 }, (_, i) => makePost(`bridge-${i}`, {
    creator: `new-${i}`, tags: ["cinema", "noir"], savedAt: now - i * 5000,
  }));
  const unrelated = Array.from({ length: 18 }, (_, i) => makePost(`unrelated-${i}`, {
    creator: `other-${i}`, tags: ["sports", "field"], savedAt: now - i * 5000,
  }));
  const posts = [...opened, ...bridge, ...unrelated];
  const profile = recs.buildProfile(posts, context({ recent: opened, openedCreators: new Map([["familiar", 6]]) }));

  assert.equal(profile.knownCreators.has("familiar"), true);
  assert.ok(recs.fit(bridge[0], profile, context()) > recs.fit(unrelated[0], profile, context()));
  assert.ok(recs.sideFit(bridge[0], profile) > 0, "co-tagged adjacent topic is discovered");
  assert.equal(recs.sideFit(unrelated[0], profile), 0, "unrelated topic is not invented as a match");
});

test("Bayesian quality rewards supported engagement and shrinks tiny samples", () => {
  const baseline = Array.from({ length: 40 }, (_, i) => makePost(`base-${i}`, { likes: 20, views: 1000 }));
  const tiny = makePost("tiny", { likes: 1, views: 1 });
  const supported = makePost("supported", { likes: 120, views: 1000 });
  const flat = makePost("flat", { likes: 0, views: 1000 });
  const profile = recs.buildProfile([...baseline, tiny, supported, flat], context());

  assert.ok(recs.quality(supported, profile) > recs.quality(flat, profile));
  assert.ok(recs.quality(tiny, profile) < recs.quality(supported, profile), "one lucky view does not dominate a supported signal");
});

test("MMR keeps relevance while spreading repeated creators and tags", () => {
  const candidates = [
    makePost("a1", { creator: "a", tags: ["same"] }),
    makePost("a2", { creator: "a", tags: ["same"] }),
    makePost("a3", { creator: "a", tags: ["same"] }),
    makePost("b", { creator: "b", tags: ["other"] }),
    makePost("c", { creator: "c", tags: ["third"] }),
    makePost("d", { creator: "d", tags: ["fourth"] }),
  ];
  const ctx = context();
  const scored = recs.scorePosts(candidates, () => 0.8, 7);
  const selected = recs.diversify(scored, 4, ctx, 0.32);

  assert.equal(selected.length, 4);
  assert.ok(new Set(selected.map((item) => item.post.author.username)).size >= 3);
});

test("five-minute queue is a duration-bounded 0/1 knapsack", () => {
  const candidates = [
    { post: { id: "long", duration: 280 }, score: 0.95 },
    { post: { id: "mid-a", duration: 160 }, score: 0.58 },
    { post: { id: "mid-b", duration: 140 }, score: 0.56 },
    { post: { id: "short-a", duration: 80 }, score: 0.41 },
    { post: { id: "short-b", duration: 80 }, score: 0.41 },
  ];
  const selected = recs.budgetedSelection(candidates, {
    seconds: 300, maxItems: 8, step: 5, durationOf: (post) => post.duration,
  });

  assert.ok(selected.length >= 2);
  assert.ok(selected.reduce((sum, item) => sum + item.post.duration, 0) <= 300);
  assert.equal(new Set(selected.map((item) => item.post.id)).size, selected.length);
  assert.ok(selected.reduce((sum, item) => sum + item.score, 0) >= 1.3, "chooses the stronger combined session over one high-scoring long clip");
});
