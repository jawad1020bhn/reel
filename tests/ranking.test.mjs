/* Discover rail composition regressions on a generated library; never reads data/posts.json. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const definitions = new Map();
globalThis.XR = { define: (name, deps, factory) => definitions.set(name, { deps, factory }) };
for (const file of [
  "src/core/util/index.js",
  "src/core/query/search.js",
  "src/core/query/engine.js",
  "src/core/ranking/recommendations.js",
  "src/core/ranking/rails.js",
]) {
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
const util = resolve("core.util");
const ranking = resolve("core.ranking.rails");

function dataset() {
  const now = Date.now();
  const posts = Array.from({ length: 900 }, (_, i) => {
    const kind = i % 10 < 5 ? "video" : i % 10 < 8 ? "photo" : i % 10 === 8 ? "gif" : "carousel";
    const topic = ["travel", "music", "food"][i % 3];
    const companion = ["night", "city", "festival", "studio", "recipe", "street"][Math.floor(i / 3) % 6];
    const tags = [topic, companion];
    if (i >= 120 && topic === "travel" && i % 5 === 0) tags.push("streetfood");
    const duration = 10 + (i * 13) % 280;
    const media = kind === "carousel"
      ? [{ id: `m${i}-a`, kind: "photo", aspect: 1 }, { id: `m${i}-b`, kind: "photo", aspect: 1 }]
      : [{ id: `m${i}`, kind, aspect: kind === "video" ? (i % 2 ? 0.65 : 1.7) : 1, duration: kind === "video" ? duration : 0 }];
    const createdAt = now - (i * 7 % 700) * 864e5;
    const savedAt = now - (i * 17 % 250) * 864e5;
    const author = { username: `creator${i % 70}`, name: `Creator ${i % 70}` };
    const text = `Post ${i} #${tags.join(" #")}`;
    return {
      id: `post-${i}`, text, haystack: `${text} @${author.username}`.toLowerCase(), lang: i % 2 ? "en" : "fr",
      createdAt, savedAt, order: i, author,
      metrics: { likes: i * 17 % 2000, reposts: i * 5 % 150, replies: i % 90, views: 500 + i * 131 % 50000, bookmarks: i % 70 },
      media, hashtags: tags, quoted: i % 17 === 0 ? {} : null, flags: {},
    };
  });
  const seen = new Set(posts.slice(0, 110).map((post) => post.id));
  const starred = new Set(posts.slice(0, 50).map((post) => post.id));
  const progressing = new Set(posts.slice(50, 58).map((post) => post.id));
  const tagCounts = new Map();
  const monthCounts = new Map(), savedMonthCounts = new Map();
  for (const post of posts) {
    for (const tag of post.hashtags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    const month = util.monthKey(post.createdAt), savedMonth = util.monthKey(post.savedAt);
    monthCounts.set(month, (monthCounts.get(month) || 0) + 1);
    savedMonthCounts.set(savedMonth, (savedMonthCounts.get(savedMonth) || 0) + 1);
  }
  const list = (map) => [...map].map(([key, count]) => ({ key, count }));
  const collectionIds = new Set(posts.slice(200, 250).map((post) => post.id));
  const ctx = {
    kindOf: (post) => {
      if (post.media.some((media) => media.kind === "gif")) return "gif";
      if (post.media.some((media) => media.kind !== "photo")) return post.media[0].duration > 90 ? "long" : "short";
      return post.media.length > 1 ? "carousel" : "photo";
    },
    duration: (post) => Math.max(0, ...post.media.map((media) => media.duration || 0)),
    isSeen: (id) => seen.has(id), isStarred: (id) => starred.has(id),
    isHidden: () => false, isUnavailable: () => false, isDuplicate: () => false,
    progressOf: (post) => progressing.has(post.id) ? 0.5 : 0,
    progressAt: (post) => progressing.has(post.id) ? now - Number(post.id.slice(5)) : 0,
    creatorAffinity: () => new Map([["creator1", 12], ["creator2", 6]]),
    collections: () => [{ id: "collection-1", name: "Night drives", ids: [...collectionIds] }],
    inCollection: (id, postId) => id === "collection-1" && collectionIds.has(postId),
    hashtags: (limit) => [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit),
    months: () => list(monthCounts), savedMonths: () => list(savedMonthCounts),
    recentlyOpened: (limit = 12) => posts.slice(0, limit),
    related: (id, limit) => {
      const source = posts.find((post) => post.id === id);
      return posts.filter((post) => post.id !== id && (post.author.username === source?.author.username || post.hashtags.some((tag) => source?.hashtags.includes(tag)))).slice(0, limit);
    },
  };
  return { posts, ctx, now };
}

test("Discover builds twenty distinct, seeded rails and rotates the mix", () => {
  const { posts, ctx, now } = dataset();
  const first = ranking.build(posts, ctx, { seed: 101, now, limit: 24 });
  const repeated = ranking.build(posts, ctx, { seed: 101, now, limit: 24 });
  const nextVisit = ranking.build(posts, ctx, { seed: 202, now, limit: 24 });
  const ids = (rails) => rails.map((rail) => rail.id);

  assert.equal(ranking.COUNT, 20);
  assert.equal(first.length, 20);
  assert.equal(new Set(ids(first)).size, 20, "no duplicate rail definitions on one visit");
  assert.deepEqual(ids(repeated), ids(first), "a seed reproduces the same rail selection");
  assert.notDeepEqual(ids(nextVisit), ids(first), "a new seed rotates rail selection");
  assert.ok(first.every((rail) => rail.items.length >= 2));
  assert.ok(ranking.POOL.length > ranking.COUNT, "there is a larger pool to rotate through");
});

test("creative recommendation rails are in the rotating pool and build valid lineups", () => {
  const { posts, ctx, now } = dataset();
  const ids = new Set(["foryou", "sidequest", "sleepers", "fivemin", "freshfaces", "formatflip"]);
  const rails = ranking.build(posts, ctx, { seed: 303, now, limit: 24, count: ranking.POOL.length });
  const selected = rails.filter((rail) => ids.has(rail.id));

  assert.equal(selected.length, ids.size);
  assert.ok(selected.every((rail) => rail.items.length >= 2));
  const queue = rails.find((rail) => rail.id === "fivemin");
  assert.ok(queue.items.reduce((sum, post) => sum + ctx.duration(post), 0) <= 300, "session queue respects its five-minute budget");
  const sideQuest = rails.find((rail) => rail.id === "sidequest");
  assert.ok(sideQuest.items.every((post) => !ctx.isSeen(post.id)), "discovery suggestions do not repeat opened posts");
});
