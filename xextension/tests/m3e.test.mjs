/* Regression checks for the mirrored design-system scripts.
 *
 * The popup only needs these files to load, so a syntax-level bug in the mirror
 * (a stray invocation on the UMD wrapper, an HTML-entity pass that rewrote the
 * escape map) takes the whole surface down before any popup code runs. Requiring
 * each file from Node catches that class of damage without a browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("m3e colour engine loads and builds a scheme", () => {
  const color = require("../m3e/color.js");

  assert.equal(typeof color.scheme, "function");
  assert.match(color.DEFAULT_SEED, /^#[0-9a-f]{6}$/i);

  const dark = color.scheme(color.DEFAULT_SEED, { dark: true });
  assert.match(dark.roles.primary, /^#[0-9a-f]{6}$/i);
  assert.match(dark.roles.surface, /^#[0-9a-f]{6}$/i);
  assert.notEqual(dark.roles.primary, dark.roles.surface);
});

test("m3e theme runtime loads against the colour engine", () => {
  const color = require("../m3e/color.js");
  const theme = require("../m3e/theme.js");

  assert.equal(typeof theme.createController, "function");
  assert.equal(typeof theme.apply, "function");
  assert.equal(theme.DEFAULTS.seed, color.DEFAULT_SEED);
  assert.ok(Array.isArray(theme.SEEDS) && theme.SEEDS.length > 0);
});

test("m3e interaction runtime loads and escapes HTML", () => {
  const interactions = require("../m3e/interactions.js");

  assert.equal(typeof interactions.createSnackbar, "function");
  assert.equal(typeof interactions.createOverlay, "function");
  assert.equal(
    interactions.escapeHtml('<b class="x">&\'</b>'),
    "&lt;b class=&quot;x&quot;&gt;&amp;&#39;&lt;/b&gt;"
  );
});
