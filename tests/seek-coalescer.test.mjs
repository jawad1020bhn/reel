/* core.util.seekCoalescer — the "no freeze while scrubbing" primitive behind both the
   Watch cell's progress bar and the Viewer's scrubber. A drag fires an `input` for every
   pixel; applying each one makes the browser abandon a range request and start another,
   which is the freeze people notice on a long video. This keeps at most one seek per
   animation frame, and `flush()` lands the position the user actually let go of. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXR } from "./helpers/xr.mjs";

function harness() {
  const { XR, load } = createXR();
  load("src/core/util/index.js");
  const frames = [];
  const applied = [];
  /* a real frame queue: ids are unique, cancelling removes the callback */
  let nextId = 1;
  const frame = (fn) => { const id = nextId++; frames.push({ id, fn }); return id; };
  const cancelFrame = (id) => { const i = frames.findIndex((f) => f.id === id); if (i >= 0) frames.splice(i, 1); };
  const util = XR.resolve("core.util");
  const seeker = util.seekCoalescer((t) => applied.push(t), { frame, cancelFrame });
  const tick = () => { const next = frames.shift(); if (next) next.fn(); };
  return { seeker, applied, tick, frames };
}

test("seek coalescer: a burst of drag events becomes one seek per frame", () => {
  const { seeker, applied, tick, frames } = harness();
  for (let t = 1; t <= 25; t++) seeker.request(t);
  assert.deepEqual(applied, [], "nothing is applied synchronously — the frame decides");
  assert.equal(frames.length, 1, "one scheduled frame for the whole burst, not 25");

  tick();
  assert.deepEqual(applied, [25], "the newest target wins; the intermediate ones are dropped");
  assert.equal(seeker.pending, null);
});

test("seek coalescer: flush lands the final position immediately, even before the frame", () => {
  const { seeker, applied, frames } = harness();
  seeker.request(10);
  seeker.request(42);
  seeker.flush();
  assert.deepEqual(applied, [42], "releasing the drag applies the position the user meant");
  assert.equal(frames.length, 0, "the queued frame is cancelled by the flush");

  assert.deepEqual(applied, [42], "no double seek after a flush");
});

test("seek coalescer: a cancelled drag never seeks", () => {
  const { seeker, applied, frames, tick } = harness();
  seeker.request(30);
  seeker.cancel();
  tick();
  assert.deepEqual(applied, []);
});

test("seek coalescer: consecutive frames each apply their own latest target", () => {
  const { seeker, applied, tick } = harness();
  seeker.request(5);
  tick();
  seeker.request(6);
  seeker.request(7);
  tick();
  assert.deepEqual(applied, [5, 7]);
});
