import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createXR } from './helpers/xr.mjs';

function queryFixture(count = 10000) {
  const { XR, load } = createXR();
  for (const file of ['src/core/util/index.js', 'src/core/query/search.js', 'src/core/query/engine.js']) load(file);
  const random = XR.resolve('core.util').seededRandom(42);
  const posts = Array.from({ length: count }, (_, i) => ({
    id: String(i), order: i, createdAt: Math.floor(random() * 1000), savedAt: Math.floor(random() * 1000),
    metrics: { likes: Math.floor(random() * 100), views: Math.floor(random() * 100) },
    author: { username: 'creator' + (i % 30), name: 'Creator' },
    media: [{ kind: 'video', duration: i % 100 }], hashtags: [], haystack: 'test',
  }));
  const ctx = { isHidden: () => false, isSeen: () => false, isStarred: () => false, progressOf: () => 0, duration: p => p.media[0].duration, kindOf: () => 'short' };
  return { engine: XR.resolve('core.query.engine'), posts, ctx };
}

test('limited sorted queries exactly match full stable sort, including ties and total counts', () => {
  const { engine, posts, ctx } = queryFixture();
  for (const sort of ['saved', 'newest', 'oldest', 'likes', 'views', 'longest', 'shortest', 'creator', 'random', 'smart']) {
    const full = engine.run(posts, { sort, seed: 123 }, ctx);
    for (const limit of [1, 24, 48, 5000, 15000]) {
      const limited = engine.run(posts, { sort, seed: 123, limit }, ctx);
      assert.equal(limited.total, full.total, sort);
      assert.deepEqual(Array.from(limited.items, p => p.id), Array.from(full.items.slice(0, limit), p => p.id), `${sort}, limit=${limit}`);
    }
  }
});

test('small shelves perform substantially fewer comparator calls, without changing results', () => {
  const { engine, posts, ctx } = queryFixture(20000);
  let calls = 0;
  ctx.duration = p => { calls++; return p.media[0].duration; };
  engine.run(posts, { sort: 'longest' }, ctx);
  const fullCalls = calls;
  calls = 0;
  const limited = engine.run(posts, { sort: 'longest', limit: 24 }, ctx);
  assert.equal(limited.items.length, 24);
  assert.ok(calls < fullCalls / 3, `${calls} limited vs ${fullCalls} full-sort duration reads`);
});

test('empty lists, filtered results and sort hints retain query semantics', () => {
  const { engine, posts, ctx } = queryFixture(500);
  const spec = { q: 'test sort:likes', sort: 'newest', limit: 24 };
  ctx.isHidden = id => Number(id) % 2 === 0;
  const full = engine.run(posts, { ...spec, limit: 0 }, ctx);
  const small = engine.run(posts, spec, ctx);
  assert.deepEqual(Array.from(small.items, p => p.id), Array.from(full.items.slice(0, 24), p => p.id));
  assert.equal(small.total, 250);
  assert.equal(small.spec.sort, 'likes');
  assert.equal(engine.run([], spec, ctx).items.length, 0);
});
