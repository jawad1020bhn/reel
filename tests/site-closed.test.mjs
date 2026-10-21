/* A closed library: `closed: true` in site.config.js shuts everything, everywhere. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXR } from "./helpers/xr.mjs";

function world(config, { file = false } = {}) {
  const { XR, load } = createXR();
  const added = [];
  const node = () => ({ tabIndex: 0, focus() {}, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [] });
  const document = { title: "", hidden: false, body: { appendChild(el) { added.push(el); } }, documentElement: { classList: { classes: new Set(), add(...c) { c.forEach((x) => this.classes.add(x)); }, remove(...c) { c.forEach((x) => this.classes.delete(x)); } } }, addEventListener() {}, removeEventListener() {} };
  const globals = { window: { XREELS_SITE: config }, document };
  XR.provide("app.ports.platform", { isFile: () => file, sha256: async () => "" });
  XR.provide("ui.dom", { h: () => node() });
  XR.provide("ui.icons", { icon: () => node() });
  load("src/core/availability.js", globals);
  load("src/application/services/site.js", globals);
  load("src/shell/site-gate.js", globals);
  return { site: XR.resolve("app.site"), gate: XR.resolve("shell.siteGate"), document, added };
}
const settled = (p, ms = 50) => Promise.race([p.then(() => "settled"), new Promise((r) => setTimeout(() => r("pending"), ms))]);

test("closed: true closes the library — nothing boots, no passcode is asked", async () => {
  const { site, gate, document, added } = world({ closed: true, salt: "", hash: "", title: "saves" });
  assert.equal(site.isClosed(), true);
  assert.equal(site.closedNotice(), "This library has been closed by its owner.");
  assert.equal(site.applies(), false, "there is no passcode to apply");
  const boot = gate.ensure();
  assert.equal(await settled(boot), "pending", "the boot promise never settles");
  assert.equal(added.length, 1, "the closed screen is on the page");
  assert.ok(document.documentElement.classList.classes.has("is-site-closed"));
  assert.ok(document.documentElement.classList.classes.has("is-site-gated"));
  assert.equal(document.title, "saves — closed");
  assert.equal(gate.isShown(), true);
  gate.ensure();
  assert.equal(added.length, 1, "asking again does not stack screens");
});

test("closed wins over everything: a password, opening hours, even a local file:// copy", async () => {
  const { site, gate } = world({ closed: true, salt: "s", hash: "h", availability: { enabled: true } }, { file: true });
  assert.equal(site.isClosed(), true);
  assert.equal(await settled(gate.ensure()), "pending");
  assert.equal((await site.check("anything")).ok, true, "check() is irrelevant — the gate never asks");
});

test("without closed: true the gate behaves as before", async () => {
  const open = world({ closed: false, salt: "", hash: "", title: "saves" });
  assert.equal(open.site.isClosed(), false);
  assert.equal(await open.gate.ensure(), true, "no password → straight in");
  const custom = world({ closed: true, closedNotice: "Gone fishing." });
  assert.equal(custom.site.closedNotice(), "Gone fishing.");
  const stringy = world({ closed: "true" });
  assert.equal(stringy.site.isClosed(), false, "only the boolean closes — no accidental closure from a string");
});
