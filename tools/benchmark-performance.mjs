/* Synthetic CPU benchmark; never reads the user's library. Optional baseline:
   npm run benchmark:performance -- --baseline <git-ref>
   Timings are sandbox/Node evidence, not mobile frame-rate or network claims. */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

const baseline = process.argv.includes('--baseline') ? process.argv[process.argv.indexOf('--baseline') + 1] : null;
if (process.argv.includes('--baseline') && (!baseline || baseline.startsWith('-'))) throw new Error('Expected a git reference after --baseline');
function loadEngine(ref) {
  const modules = new Map();
  const XR = {
    define: (name, deps, factory) => modules.set(name, { deps, factory }),
    resolve(name) {
      const record = modules.get(name);
      return record.api ||= record.factory(...record.deps.map(dep => XR.resolve(dep)));
    },
  };
  for (const file of ['src/core/util/index.js', 'src/core/query/search.js', 'src/core/query/engine.js']) {
    const code = ref ? execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8' }) : readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    runInNewContext(code, { XR, URL, console });
  }
  return { engine: XR.resolve('core.query.engine'), util: XR.resolve('core.util') };
}
const current = loadEngine();
const previous = baseline ? loadEngine(baseline) : null;
const random = current.util.seededRandom(42);
const posts = Array.from({ length: 30000 }, (_, i) => ({
  id: String(i), order: i, createdAt: Math.floor(random() * 1e12), savedAt: Math.floor(random() * 1e12),
  metrics: { likes: Math.floor(random() * 100000), views: Math.floor(random() * 1000000) },
  author: { username: 'creator' + (i % 500), name: 'Creator' },
  media: [{ kind: 'video', duration: Math.floor(random() * 1000) }], hashtags: [], haystack: 'synthetic test clip',
}));
let durationReads = 0;
const ctx = { isHidden: () => false, isSeen: () => false, isStarred: () => false, progressOf: () => 0, duration: p => { durationReads++; return p.media[0].duration; }, kindOf: () => 'short' };
const specs = ['saved', 'newest', 'oldest', 'likes', 'views', 'longest', 'shortest', 'creator'].map(sort => ({ sort, limit: 48 }));
const ids = result => Array.from(result.items, post => post.id);
if (previous) for (const spec of specs) assert.deepEqual(ids(current.engine.run(posts, spec, ctx)), ids(previous.engine.run(posts, spec, ctx)), `baseline parity: ${spec.sort}`);
function measure(engine) {
  const samples = [];
  for (let i = 0; i < 9; i++) {
    const start = performance.now();
    for (const spec of specs) engine.run(posts, spec, ctx);
    if (i >= 2) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  durationReads = 0;
  engine.run(posts, { sort: 'longest', limit: 48 }, ctx);
  return { medianShelfBatchMs: +samples[samples.length >> 1].toFixed(2), longestDurationReads: durationReads };
}
const results = { posts: posts.length, shelves: specs.length, limit: 48 };
if (previous) results.baseline = measure(previous.engine);
results.current = measure(current.engine);
if (previous) results.speedup = +(results.baseline.medianShelfBatchMs / results.current.medianShelfBatchMs).toFixed(2);
console.log(JSON.stringify(results, null, 2));
