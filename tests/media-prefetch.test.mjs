import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function harness(connection = {}, fetcher) {
  let api, requests = 0;
  vm.runInNewContext(readFileSync(new URL('../src/infrastructure/media/prefetch.js', import.meta.url), 'utf8'), {
    XR: { define: (_, __, factory) => { api = factory(); } },
    navigator: { connection, onLine: true }, AbortController, Blob,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    fetch: async (...args) => { requests++; return fetcher ? fetcher(...args) : new Response(new Uint8Array(10)); },
  });
  return { api, requests: () => requests };
}
const url = 'https://video.twimg.com/test.mp4';

test('speculative downloads respect Save-Data and slow connections', async () => {
  for (const connection of [{ saveData: true }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }, { effectiveType: '3g' }]) {
    const h = harness(connection);
    assert.equal(await h.api.warm(url), null);
    assert.equal(await h.api.prefetch(url), null);
    h.api.warmAhead(null, url, { duration: 20 });
    assert.equal(h.requests(), 0);
  }
});

test('fast connections still warm and reuse clips', async () => {
  const h = harness({ effectiveType: '4g' });
  assert.equal(await h.api.warm(url), 'blob:test');
  assert.equal(h.api.blobUrl(url), 'blob:test');
  assert.equal(await h.api.warm(url), 'blob:test');
  assert.equal(h.requests(), 1);
  assert.equal(h.api.stats().bytes, 10);
});

test('unknown-length media stops reading at the byte limit', async () => {
  let reads = 0, cancelled = false, signal;
  const h = harness({}, async (_, opts) => {
    signal = opts.signal;
    return { ok: true, headers: new Headers(), body: { getReader: () => ({
      read: async () => { reads++; return { done: false, value: new Uint8Array(1024 * 1024) }; },
      cancel: async () => { cancelled = true; },
    }) } };
  });
  assert.equal(await h.api.warm(url), null);
  assert.equal(reads, 15);
  assert.ok(cancelled && signal.aborted);
  assert.equal(h.api.stats().bytes, 0);
});

test('clearing aborts active downloads and settles queued promises', async () => {
  const signals = [];
  const h = harness({}, (_, { signal }) => new Promise((resolve, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const jobs = [1, 2, 3, 4].map(i => h.api.prefetch(url + '?clip=' + i));
  h.api.clear();
  assert.deepEqual(await Promise.all(jobs), [null, null, null, null]);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(s => s.aborted));
  await new Promise(setImmediate);
  assert.equal(h.api.stats().pending, 0);
});

test('warm, warmAhead and prefetch share one two-request scheduler and one promise per URL', async () => {
  let active = 0, peak = 0;
  const complete = [];
  const h = harness({}, (_, { signal }) => new Promise(resolve => {
    active++; peak = Math.max(peak, active);
    complete.push(() => { active--; resolve(new Response(new Uint8Array(10))); });
  }));
  const first = h.api.warm(url);
  assert.equal(h.api.prefetch(url), first, 'duplicate caller joins existing work');
  h.api.warmAhead(null, url + '?second', { duration: 20 });
  const third = h.api.warm(url + '?third');
  const fourth = h.api.prefetch(url + '?fourth');
  assert.equal(h.requests(), 2);
  assert.equal(h.api.stats().queued, 2);
  complete.shift()(); complete.shift()();
  await new Promise(setImmediate);
  assert.equal(h.requests(), 4);
  complete.shift()(); complete.shift()();
  await Promise.all([first, third, fourth]);
  assert.equal(peak, 2);
});

test('retaining a new swipe window aborts old work, preserves cache, and accepts a replacement URL safely', async () => {
  const pending = [];
  const h = harness({}, (requestUrl, { signal }) => new Promise(resolve => pending.push({ requestUrl, signal, resolve })));
  const old = h.api.warm(url);
  const keep = h.api.warm(url + '?keep');
  const queued = h.api.warm(url + '?obsolete');
  h.api.retain([url + '?keep']);
  assert.equal(await old, null);
  assert.equal(await queued, null);
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending[1].signal.aborted, false);
  const replacement = h.api.warm(url);
  // Simulate a fetch implementation that finishes despite cancellation. It must
  // not publish bytes or delete the replacement job for the same URL.
  pending[0].resolve(new Response(new Uint8Array(10)));
  pending[1].resolve(new Response(new Uint8Array(10)));
  await keep; await new Promise(setImmediate);
  assert.equal(h.api.has(url), false);
  assert.equal(h.api.has(url + '?keep'), true);
  assert.equal(h.api.warm(url), replacement);
  pending[2].resolve(new Response(new Uint8Array(10)));
  assert.equal(await replacement, 'blob:test');
  assert.equal(h.api.stats().entries, 2);
});

test('queued requests stop when Save-Data changes before a slot opens', async () => {
  const connection = {};
  const pending = [];
  const h = harness(connection, () => new Promise(resolve => pending.push(resolve)));
  const jobs = [1, 2, 3].map(i => h.api.warm(url + i));
  connection.saveData = true;
  for (const resolve of pending) resolve(new Response(new Uint8Array(10)));
  assert.deepEqual(await Promise.all(jobs), [null, null, null]);
  assert.equal(h.requests(), 2);
  assert.equal(h.api.stats().entries, 0);
});
