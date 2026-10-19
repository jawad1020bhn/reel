import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/ui/pull-to-shuffle.js", import.meta.url), "utf8");
function setup() {
  let api, pill, shuffles = 0;
  const vibrations = [], listeners = new Map(), classes = new Set(), styles = new Map();
  const scroller = {
    scrollTop: 0,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
  };
  const dom = { h: (selector) => {
    const el = {
      selector, isConnected: false,
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
      },
      style: { setProperty: (name, value) => styles.set(name, value), removeProperty: (name) => styles.delete(name) },
      remove() { this.isConnected = false; },
    };
    if (selector === "div.pull-to-shuffle") pill = el;
    return el;
  } };
  runInNewContext(source, {
    XR: { define: (_name, _deps, factory) => { api = factory(dom, { icon: () => null }, { vibrate: (ms) => vibrations.push(ms) }, { t: (s) => s }); } },
    document: { body: { appendChild: (el) => { el.isConnected = true; } } },
  });
  const cleanup = api.attach(scroller, () => shuffles++);
  const send = (name, y = 0, count = 1) => listeners.get(name)?.({ touches: Array.from({ length: count }, () => ({ clientY: y })) });
  return { scroller, send, cleanup, classes, styles, vibrations, listeners, pill, get shuffles() { return shuffles; } };
}

test("pull from the top arms at 72px and shuffles once on release", () => {
  const s = setup();
  s.send("touchstart", 100);
  s.send("touchmove", 171);
  assert.ok(s.classes.has("is-pulling"));
  assert.ok(!s.classes.has("is-armed"));
  s.send("touchmove", 172);
  assert.ok(s.classes.has("is-armed"));
  assert.deepEqual(s.vibrations, [8]);
  assert.equal(s.shuffles, 0);
  s.send("touchend");
  s.send("touchend");
  assert.equal(s.shuffles, 1);
  assert.equal(s.classes.size, 0);
  assert.equal(s.styles.size, 0);
});

test("short pulls, upward swipes and pulls starting below the top do not shuffle", () => {
  for (const [top, end] of [[0, 150], [0, 50], [30, 250]]) {
    const s = setup();
    s.scroller.scrollTop = top;
    s.send("touchstart", 100);
    s.send("touchmove", end);
    s.send("touchend");
    assert.equal(s.shuffles, 0);
  }
});

test("cancel, multitouch and scrolling away from the top disarm an armed pull", () => {
  for (const cancel of ["touchcancel", "multitouch", "scroll"]) {
    const s = setup();
    s.send("touchstart", 100);
    s.send("touchmove", 200);
    assert.ok(s.classes.has("is-armed"));
    if (cancel === "touchcancel") s.send(cancel);
    if (cancel === "multitouch") s.send("touchmove", 210, 2);
    if (cancel === "scroll") { s.scroller.scrollTop = 10; s.send("touchmove", 210); }
    s.send("touchend");
    assert.equal(s.shuffles, 0);
    assert.equal(s.classes.size, 0);
  }
});

test("cleanup removes the floating pill and all listeners", () => {
  const s = setup();
  s.send("touchstart", 100);
  s.send("touchmove", 300);
  assert.ok(s.pill.isConnected);
  s.cleanup();
  assert.equal(s.pill.isConnected, false);
  assert.equal(s.listeners.size, 0);
  s.send("touchend");
  assert.equal(s.shuffles, 0);
});
