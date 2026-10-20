/* app.activity: the one-time reset of "unavailable" marks on Reddit saves. A Reddit save
   (id "t3_…") marked while its images were blocked must not stay marked. X marks are kept. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXR } from "./helpers/xr.mjs";

async function loadActivity(stored) {
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
  const activity = XR.resolve("app.activity");
  await activity.load();
  return { activity, writes };
}

test("Reddit saves marked unavailable before the fix are cleared once; X marks are kept", async () => {
  const { activity, writes } = await loadActivity({
    unavailable: { t3_abc123: 1, t3_def456: 2, "1893": 3 },
    seen: {},
  });
  assert.equal(activity.isUnavailable("t3_abc123"), false);
  assert.equal(activity.isUnavailable("t3_def456"), false);
  assert.equal(activity.isUnavailable("1893"), true);
  await new Promise((resolve) => setTimeout(resolve, 600));   // activity saves are debounced (400 ms)
  assert.ok(writes.length >= 1, "the reset is saved");
  assert.equal(writes[writes.length - 1].redditMarksReset, "v3");
});

test("the reset does not run again, so a fresh Reddit mark from a later check is kept", async () => {
  const { activity } = await loadActivity({
    unavailable: { "1893": 3 },
    redditMarksReset: "v3",
  });
  activity.markUnavailable(["t3_new999"], true);
  assert.equal(activity.isUnavailable("t3_new999"), true);
});
