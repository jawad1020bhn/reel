/* app.activity, the learned ranking signals: dwell (attention + quick skips) and deck
   memory. Both are written quietly — they must never re-render the UI (no ACTIVITY_CHANGED)
   — and both must survive a flush, an export/import and a reset. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXR } from "./helpers/xr.mjs";

async function loadActivity(stored = {}) {
  const { XR, load } = createXR();
  for (const file of ["src/core/util/index.js", "src/core/events.js", "src/core/domain/events.js", "src/application/services/activity.js"]) load(file);
  const writes = [];
  const storage = {
    get: async () => structuredClone(stored),
    set: async (key, value) => { writes.push(structuredClone(value)); },
    remove: async () => {},
    keys: async () => [],
  };
  XR.provide("app.ports.storage", storage);
  const events = XR.resolve("core.events");
  const changes = [];
  events.bus.on(XR.resolve("core.domain.events").ACTIVITY_CHANGED, (e) => changes.push(e.kind));
  const activity = XR.resolve("app.activity");
  await activity.load();
  return { activity, writes, changes };
}

test("a long visit raises attention, a sub-second swipe past counts as a skip", async () => {
  const { activity } = await loadActivity();
  activity.noteDwell("a", 8000, { ratio: 0.8 });
  activity.noteDwell("b", 900, { ratio: 0.02 });
  activity.noteDwell("b", 700, { ratio: 0.01 });
  assert.ok(activity.attentionOf("a") > 0.5, `attention ${activity.attentionOf("a")}`);
  assert.equal(activity.attentionOf("b"), 0, "a post that was only skipped has no attention");
  assert.equal(activity.dwellStats("b").skipRate, 1);
  assert.equal(activity.dwellStats("a").skipRate, 0);
  assert.equal(activity.dwellStats("never-seen"), null);
});

test("a visit that ran past a third of the clip is not a skip, however quick", async () => {
  const { activity } = await loadActivity();
  activity.noteDwell("x", 500, { ratio: 0.6 });
  assert.equal(activity.dwellStats("x").skipRate, 0);
});

test("dwell and deck writes are silent: no ACTIVITY_CHANGED, but they are persisted", async () => {
  const { activity, changes, writes } = await loadActivity();
  activity.noteDwell("a", 5000, { ratio: 0.5 });
  activity.rememberDeck(4242, ["a", "b", "c"]);
  assert.deepEqual(changes, [], "ranking signals never wake the UI");
  await activity.flush();
  assert.ok(writes.length >= 1, "quiet writes still reach storage");
  assert.ok(writes[writes.length - 1].dwell.a.t >= 4);
});

test("the last deck keeps only its opening, so storage stays small", async () => {
  const { activity } = await loadActivity();
  activity.rememberDeck(7, Array.from({ length: 500 }, (_, i) => "p" + i));
  const deck = activity.lastDeck();
  assert.equal(deck.seed, 7);
  assert.ok(deck.ids.length <= 60, `${deck.ids.length} ids kept`);
  assert.equal(deck.ids[0], "p0");
  activity.clearDeck();
  assert.equal(activity.lastDeck(), null);
});

test("dwell survives an export/import round trip and a merge", async () => {
  const { activity } = await loadActivity();
  activity.noteDwell("a", 6000, { ratio: 0.9 });
  const dump = activity.exportState();
  assert.ok(dump.dwell.a, "dwell travels in the backup");
  const { activity: other } = await loadActivity({});
  other.importState(dump, { merge: true });
  assert.ok(other.attentionOf("a") > 0.5, "restored attention is usable");
});

test("reset all clears the learned signals", async () => {
  const { activity } = await loadActivity({ dwell: { a: { t: 10, n: 1, s: 0, at: 1 } }, deck: { seed: 1, ids: ["a"], at: 1 } });
  assert.ok(activity.dwellStats("a"));
  await activity.resetAll();
  assert.equal(activity.dwellStats("a"), null);
  assert.equal(activity.lastDeck(), null);
});
