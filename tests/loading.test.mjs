/* Shell loading regressions without a browser or private library. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function harness() {
  let outlet, listener, resolveLoad, rejectLoad;
  const timers = new Map();
  let timerId = 0;
  const node = (tag, ...children) => ({ tag, children, style: {} });
  const host = {
    dataset: {}, attrs: {}, children: [], scrollTop: 0,
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(n) { this.children.push(n); },
  };
  let mounts = 0, unmounts = 0;
  const home = { id: 'home', title: 'Home', mount() { mounts++; host.appendChild(node('home')); }, unmount() { unmounts++; } };
  const lazy = { id: 'lazy', title: 'Lazy', lazy: true };
  const route = name => ({ name, params: {}, path: '/' + name });
  const features = {
    get: name => name === 'home' ? home : lazy,
    load: () => new Promise((resolve, reject) => {
      resolveLoad = () => { delete lazy.lazy; lazy.mount = () => host.appendChild(node('loaded')); resolve(); };
      rejectLoad = reject;
    }),
  };
  const deps = [
    { h: node, clear: () => { host.children = []; }, replace: (_, n) => { host.children = [n]; } },
    { empty: options => node('error', options) }, { install() {}, sweep() {} }, features,
    { current: route('home') }, { pauseAll() {} }, { setTitle() {} },
    { bus: { on: (_, fn) => { listener = fn; } } }, { ROUTE_CHANGED: 'route' },
  ];
  vm.runInNewContext(readFileSync(new URL('../src/shell/outlet.js', import.meta.url), 'utf8'), {
    XR: { define: (_id, _deps, factory) => { outlet = factory(...deps); }, resolve: () => ({ t: x => x }) },
    document: { documentElement: { dataset: {} }, visibilityState: 'visible' },
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id), requestAnimationFrame() {}, console,
  });
  outlet.start(host);
  return {
    host, outlet, go: name => listener({ route: route(name) }),
    flush: () => { for (const [id, fn] of timers) { timers.delete(id); fn(); } },
    resolve: () => resolveLoad(), reject: () => rejectLoad(new Error('offline')),
    counts: () => ({ mounts, unmounts }),
  };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test('fast lazy load retains current page and never flashes a skeleton', async () => {
  const h = harness();
  h.go('lazy');
  assert.equal(h.host.children[0].tag, 'home');
  h.resolve(); await settle(); h.flush();
  assert.equal(h.host.children[0].tag, 'loaded');
  assert.equal(h.host.attrs['aria-busy'], undefined);
});

test('slow load shows an accessible skeleton, then settles immediately', async () => {
  const h = harness(); h.go('lazy'); h.flush();
  assert.equal(h.host.children[0].tag, 'div.feature-loading');
  assert.equal(h.host.attrs['aria-busy'], 'true');
  h.resolve(); await settle();
  assert.equal(h.host.children[0].tag, 'loaded');
  assert.equal(h.host.attrs['aria-busy'], undefined);
});

test('navigation away cancels loading UI and ignores stale completion', async () => {
  const h = harness(); h.go('lazy'); h.go('home');
  h.flush(); h.resolve(); await settle();
  assert.equal(h.host.children[0].tag, 'home');
  assert.equal(h.outlet.current.id, 'home');
});

test('load failure cleans up old page and clears busy state', async () => {
  const h = harness(); h.go('lazy'); h.reject(); await settle(); h.flush();
  assert.equal(h.host.children[0].tag, 'error');
  assert.equal(h.host.attrs['aria-busy'], undefined);
  assert.equal(h.counts().unmounts, 1);
  assert.equal(h.outlet.current, null);
});
