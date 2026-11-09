/* The boot placeholder in index.html (#boot-splash) is the highest layer on the page: it
   paints the app's background before a single module runs. That is what makes the first
   frame instant — and it is also a trap. Any screen that takes over before the real splash
   appears (the site passcode, a closed library, a boot failure) would be *underneath* it,
   so the visitor sees "Opening your library" forever and can never type the passcode the
   app is waiting for. This test pins the rule: shell.app must clear the placeholder before
   it awaits the site gate, and the placeholder must never outlive a takeover screen. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createXR } from "./helpers/xr.mjs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

/* ------------------------------------------------------- the source-order rule -- */

test("shell.app clears the boot placeholder before it awaits the site gate", () => {
  const app = read("src/shell/app.js");
  const clearAt = app.indexOf("splash.clear()");
  const gateAt = app.indexOf("siteGate.ensure(");
  assert.ok(clearAt > -1, "shell.app must call splash.clear()");
  assert.ok(gateAt > -1, "shell.app must still await the site gate");
  assert.ok(clearAt < gateAt, "the placeholder has to go before the gate takes over, or the form is hidden");
});

test("every path that can leave the user on a screen of its own clears the placeholder", () => {
  const app = read("src/shell/app.js");
  /* the boot failure path shows splash.fail — the placeholder would cover it */
  const failAt = app.indexOf("splash.fail(");
  assert.ok(failAt > -1);
  const beforeFail = app.slice(Math.max(0, failAt - 200), failAt);
  assert.match(beforeFail, /splash\.clear\(\)/, "a boot failure must not stay hidden under the placeholder");
});

test("the placeholder is above every other layer, and the tokens agree", () => {
  const html = read("index.html");
  const z = Number((html.match(/#boot-splash\s*\{[^}]*z-index:\s*(\d+)/) || [])[1]);
  assert.ok(z >= 1000, `#boot-splash z-index is ${z}; it must be above the app`);
  const tokens = read("styles/tokens.css");
  const boot = Number((tokens.match(/--z-boot:\s*(\d+)/) || [])[1]);
  assert.equal(boot, z, "--z-boot must match the inline value in index.html");
  const others = [...tokens.matchAll(/(--z-[a-z]+):\s*(\d+)/g)]
    .filter((m) => m[1] !== "--z-boot")
    .map((m) => Number(m[2]));
  assert.ok(boot > Math.max(...others), "no app layer may ever sit above the boot placeholder");
});

/* ----------------------------------------------------------- the runtime rule -- */

/** A DOM just big enough for splash.js: getElementById + appendChild + classList. */
function splashHarness() {
  const removed = [];
  const boot = { id: "boot-splash", classes: new Set(), removed: false, classList: { add(c) { boot.classes.add(c); } }, remove() { boot.removed = true; removed.push("boot-splash"); } };
  const timers = [];
  const body = { children: [], appendChild(n) { body.children.push(n); } };
  const document = {
    getElementById: (id) => (id === "boot-splash" && !boot.removed ? boot : null),
    body,
    createElement: () => ({ style: {}, classList: { add() {} }, appendChild() {}, setAttribute() {} }),
  };
  const { XR, load } = createXR();
  /* what shell.splash needs from the rest of the app, in the smallest form that works */
  const icon = (name) => ({ tag: "svg", name });
  XR.provide("ui.dom", {
    h: (spec, ...kids) => ({ spec, kids: kids.filter((k) => k != null), classList: { add() {} }, appendChild() {}, style: {}, replaceChildren() {} }),
    replace: (node, ...rest) => { node.replaced = rest; },
  });
  XR.provide("ui.icons", { icon });
  XR.provide("core.events", { bus: { on: () => () => {}, emit() {} } });
  XR.provide("core.domain.events", { DATASET_PROGRESS: "dataset:progress" });
  load("src/shell/splash.js", { document, setTimeout: (fn) => { timers.push(fn); return timers.length; } });
  return { splash: XR.resolve("shell.splash"), boot, removed, body };
}

test("splash.clear() removes the placeholder immediately, so the passcode can be typed", () => {
  const s = splashHarness();
  assert.equal(s.boot.removed, false);
  s.splash.clear();
  assert.equal(s.boot.removed, true);
  /* idempotent: a second call (site gate, then the splash) must not throw */
  s.splash.clear();
});

test("the real splash adopts the placeholder instead of stacking on top of it, and still works after clear()", () => {
  const cleared = splashHarness();
  cleared.splash.clear();
  cleared.splash.show();                       // must not throw when the node is already gone
  assert.equal(cleared.body.children.length, 1, "the real splash still mounts");

  const kept = splashHarness();
  kept.splash.show();
  assert.ok(kept.boot.classes.has("is-done") || kept.boot.removed, "the placeholder fades out when the real splash appears");
});
