/* Forcing a closed library open: the right passcode entered `forceTries` times in a row
   (default 7) opens a forced window of `forceMinutes` (default 30) — the only way through a
   closed door. A wrong passcode starts the count over; the forced window behaves like any
   other window (closes, grace, "Closing time."); it is remembered on the device for its own
   duration only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createXR } from "./helpers/xr.mjs";

const sha = (t) => createHash("sha256").update(t).digest("hex");
const CONFIG = { salt: "s4lt", hash: sha("s4lt:2055"), title: "saves", availability: { enabled: true, seed: "autumn", graceMinutes: 5 } };
const moment = (y, m, d, minute) => new Date(y, m - 1, d, Math.floor(minute / 60), minute % 60);
const MIN = 60000;

/** A tiny localStorage, shared between "page loads" of the same device. */
const memoryStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), get size() { return m.size; } }; };

function siteWith(config, { storage } = {}) {
  const { XR, load } = createXR();
  const globals = { window: { XREELS_SITE: config } };
  if (storage) globals.localStorage = storage;
  XR.provide("app.ports.platform", { isFile: () => false, sha256: async (t) => sha(t) });
  load("src/core/availability.js", globals);
  load("src/application/services/site.js", globals);
  return { site: XR.resolve("app.site"), A: XR.resolve("core.availability") };
}
/** An off day (the passcode works only inside its windows): a moment at the start of a closed
    stretch of at least an hour, and one inside the first window. */
function moments(A, seed = "autumn") {
  let d = 1; while (A.isWorkingDay(seed, 2026, 11, d)) d++;
  const plan = A.dayPlan(seed, 2026, 11, d);
  let start = 0, end = plan.open[0].start;                                   // windows never touch midnight
  for (let i = 0; end - start < 60 && i + 1 < plan.open.length; i++) { start = plan.open[i].end; end = plan.open[i + 1].start; }
  assert.ok(end - start >= 60, "a closed stretch of an hour exists");
  return { day: d, plan, stretch: { start, end }, closed: moment(2026, 11, d, start + 1), open: moment(2026, 11, d, plan.open[0].start + 1) };
}
const plain = (v) => JSON.parse(JSON.stringify(v));

test("defaults: 7 tries, 30 minutes; both clamped; 0 tries switches forcing off", () => {
  const { A } = siteWith(CONFIG);
  assert.deepEqual(plain(A.normalize({ enabled: true })), { enabled: true, seed: "", graceMinutes: 5, forceTries: 7, forceMinutes: 30 });
  assert.equal(A.normalize({ forceTries: 99 }).forceTries, 20);
  assert.equal(A.normalize({ forceTries: 0 }).forceTries, 0);
  assert.equal(A.normalize({ forceTries: "3" }).forceTries, 3);
  assert.equal(A.normalize({ forceMinutes: 120 }).forceMinutes, 30, "a forced opening is never longer than a window");
  assert.equal(A.normalize({ forceMinutes: 0 }).forceMinutes, 1);
  assert.equal(A.normalize({ forceMinutes: "nope" }).forceMinutes, 30);
  const { site } = siteWith(CONFIG);
  assert.equal(site.forceTries(), 7);
  assert.equal(site.forceMinutes(), 30);
});

test("the right passcode 7 times in a row forces a closed library open for 30 minutes", async () => {
  const { site, A } = siteWith(CONFIG);
  const { closed } = moments(A);
  assert.equal(site.status(closed).open, false, "the schedule says closed");
  for (let i = 1; i <= 6; i++) {
    const v = await site.check("2055", closed);
    assert.equal(v.ok, false, `try ${i} is still refused`);
    assert.equal(v.reason, "closed");
    assert.equal(v.streak, i);
    assert.equal(v.tries, 7);
    assert.equal(v.status.open, false);
  }
  assert.equal(site.streak(), 6);
  const seventh = await site.check("2055", closed);
  assert.equal(seventh.ok, true);
  assert.equal(seventh.reason, null);
  assert.equal(seventh.forced, true);
  assert.equal(seventh.status.open, true);
  assert.equal(seventh.status.forced, true);
  assert.equal(seventh.status.until.getTime(), closed.getTime() + 30 * MIN);
  assert.equal(seventh.status.remaining, 30);
  assert.equal(site.streak(), 0, "the count starts over after forcing");

  const during = new Date(closed.getTime() + 12 * MIN);
  const s = site.status(during);
  assert.equal(s.open, true); assert.equal(s.forced, true); assert.equal(s.remaining, 18);
  assert.equal(site.phase(s), "open");
  const again = await site.check("2055", during);
  assert.equal(again.ok, true, "inside the forced window the passcode works once more, with no count");
  assert.equal(again.forced, undefined);
  assert.equal(again.status.forced, true);
  const after = new Date(closed.getTime() + 30 * MIN + 1);
  const back = site.status(after);
  assert.equal(back.open, false, "then the schedule rules again");
  assert.equal(back.forced, undefined);
  const refused = await site.check("2055", after);
  assert.equal(refused.reason, "closed");
  assert.equal(refused.streak, 1, "a new count for a new forced window");
});

test("in a row: a wrong passcode starts the count over; a window opening in between does too", async () => {
  const { site, A } = siteWith(CONFIG);
  const { closed, open } = moments(A);
  for (let i = 0; i < 4; i++) await site.check("2055", closed);
  assert.equal((await site.check("1234", closed)).reason, "wrong");
  assert.equal(site.streak(), 0);
  for (let i = 0; i < 6; i++) assert.equal((await site.check("2055", closed)).ok, false, "four + six is not seven in a row");
  assert.equal((await site.check("2055", closed)).forced, true, "the seventh in a row is");

  const fresh = siteWith(CONFIG).site;
  for (let i = 0; i < 5; i++) await fresh.check("2055", closed);
  const normal = await fresh.check("2055", open);
  assert.equal(normal.ok, true); assert.equal(normal.forced, undefined, "an open window is a normal entry");
  assert.equal(fresh.streak(), 0);
  assert.equal(fresh.status(new Date(open.getTime() + 1)).forced, undefined, "nothing was forced");
});

test("forceTries: 0 means a closed library can never be forced; forceMinutes sets the length", async () => {
  const never = siteWith({ ...CONFIG, availability: { ...CONFIG.availability, forceTries: 0 } });
  const { closed } = moments(never.A);
  for (let i = 0; i < 25; i++) assert.equal((await never.site.check("2055", closed)).reason, "closed");
  assert.equal(never.site.status(closed).open, false);

  const quick = siteWith({ ...CONFIG, availability: { ...CONFIG.availability, forceTries: 2, forceMinutes: 10 } });
  assert.equal((await quick.site.check("2055", closed)).streak, 1);
  const v = await quick.site.check("2055", closed);
  assert.equal(v.forced, true);
  assert.equal(v.status.until.getTime(), closed.getTime() + 10 * MIN);
});

test("the forced window is remembered on the device for its own duration — and not trusted beyond it", async () => {
  const storage = memoryStorage();
  const first = siteWith(CONFIG, { storage });
  const { closed } = moments(first.A);
  for (let i = 0; i < 7; i++) await first.site.check("2055", closed);
  assert.equal(first.site.status(closed).forced, true);
  assert.equal(storage.size, 1, "the deadline is stored");

  const reload = siteWith(CONFIG, { storage });                            // a reload inside the forced window
  const later = new Date(closed.getTime() + 5 * MIN);
  assert.equal(reload.site.status(later).forced, true);
  assert.equal((await reload.site.check("2055", later)).ok, true, "one passcode, not seven");

  const expired = siteWith(CONFIG, { storage });
  assert.equal(expired.site.status(new Date(closed.getTime() + 31 * MIN)).open, false);
  assert.equal(storage.size, 0, "an expired deadline is dropped");

  storage.setItem("xreels.site.forcedUntil", String(closed.getTime() + 6 * 60 * MIN));   // a clock set back, or a tampered value
  const tampered = siteWith(CONFIG, { storage });
  assert.equal(tampered.site.status(closed).open, false, "a deadline further away than a forced window can be is ignored");
  assert.equal(storage.size, 0);

  const other = siteWith(CONFIG);                                         // another device: nothing to remember
  assert.equal(other.site.status(later).open, false);
});

test("when a scheduled window and a forced window overlap, the later end decides", async () => {
  const { site, A } = siteWith({ ...CONFIG, availability: { ...CONFIG.availability, forceMinutes: 10 } });
  const { day, plan } = moments(A);
  // Force the door 2 minutes before a window (every window lasts 12–30 min, a forced one here 10).
  const w = plan.open[0];
  const justBefore = moment(2026, 11, day, w.start - 2);
  assert.equal(site.status(justBefore).open, false);
  for (let i = 0; i < 7; i++) await site.check("2055", justBefore);
  assert.equal(site.status(moment(2026, 11, day, w.start - 1)).forced, true, "forced until the window opens…");
  const s = site.status(moment(2026, 11, day, w.start + 5));
  assert.equal(s.open, true);
  assert.equal(s.forced, undefined, "…then the scheduled window lasts longer, so it rules");
  assert.equal(s.until.getTime(), moment(2026, 11, day, w.end).getTime());
  const flipped = siteWith(CONFIG);                                         // forced 30 min, window shorter than that
  const short = plan.open.find((x) => x.end - x.start < 28) || w;
  const before = moment(2026, 11, day, short.start - 1);
  for (let i = 0; i < 7; i++) await flipped.site.check("2055", before);
  const f = flipped.site.status(moment(2026, 11, day, short.start + 1));
  assert.equal(f.forced, true, "the forced window outlasts the scheduled one");
  assert.equal(f.until.getTime(), before.getTime() + 30 * MIN);
});

/* ------------------------------------------------------- shell.availability -- */
function guardWith({ startAt }) {
  const { XR, load } = createXR();
  let clock = startAt.getTime();
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock); } static now() { return clock; } }
  const timers = []; let nextId = 0; let monotonic = 1000;
  const schedule = (fn, ms, interval) => { timers.push({ id: ++nextId, fn, due: monotonic + Math.max(0, ms || 0), interval: interval || 0 }); return nextId; };
  const cancel = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  const document = { hidden: false, listeners: {}, addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); } };
  const globals = { Date: FakeDate, setTimeout: (fn, ms) => schedule(fn, ms, 0), setInterval: (fn, ms) => schedule(fn, ms, ms), clearTimeout: cancel, clearInterval: cancel, window: { XREELS_SITE: CONFIG }, document, performance: { now: () => monotonic } };
  const log = { toasts: [], pauses: 0, ensures: [] };
  let releaseGate = null;
  XR.provide("app.ports.platform", { isFile: () => false, sha256: async (t) => sha(t) });
  XR.provide("ui.dom", { h: () => ({ textContent: "" }) });
  XR.provide("ui.toast", { show: (o) => { log.toasts.push(o); return () => {}; }, toast: (message, kind, extra) => log.toasts.push({ message, kind, ...extra }) });
  XR.provide("app.playback", { pauseAll: () => { log.pauses++; } });
  XR.provide("shell.siteGate", { ensure: (opts) => { log.ensures.push(opts); return new Promise((resolve) => { releaseGate = resolve; }); } });
  load("src/core/availability.js", globals);
  load("src/application/services/site.js", globals);
  load("src/shell/availability.js", globals);
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  async function advance(ms) {
    const target = monotonic + ms;
    for (;;) {
      const due = timers.filter((t) => t.due <= target).sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      clock += due.due - monotonic; monotonic = due.due;
      if (due.interval) due.due += due.interval; else cancel(due.id);
      due.fn();
      await settle();
    }
    clock += target - monotonic; monotonic = target;
  }
  const enter = async () => { releaseGate?.(true); releaseGate = null; await settle(); };
  return { site: XR.resolve("app.site"), guard: XR.resolve("shell.availability"), log, advance, enter, now: () => clock };
}

test("shell.availability: a forced window closes like any other — toast on entry, grace, then Closing time", async () => {
  const { A } = siteWith(CONFIG);
  const { closed } = moments(A);
  const { site, guard, log, advance, enter, now } = guardWith({ startAt: closed });
  for (let i = 0; i < 7; i++) await site.check("2055");                      // forced open at `closed`
  assert.equal(guard.start(), true);
  assert.equal(guard.closesAt, closed.getTime() + 30 * MIN);
  assert.equal(guard.graceUntil, guard.closesAt + 5 * MIN);
  assert.equal(log.toasts.length, 1);
  assert.match(String(log.toasts[0].message), /Forced open — the library closes again in 30 min/);
  await advance(30 * MIN + 500);                                             // the forced window ends: the countdown shows
  assert.equal(log.toasts.length, 2);
  assert.match(String(log.toasts[1].message?.textContent ?? log.toasts[1].message), /locks in/);
  assert.equal(log.ensures.length, 0);
  await advance(5 * MIN);                                                    // the grace runs out
  assert.equal(log.pauses, 1);
  assert.deepEqual(plain(log.ensures), [{ reason: "closed" }], "Closing time.");
  // Still closed by the schedule: seven more right passcodes force it again, then re-entry re-arms on the new window.
  for (let i = 0; i < 6; i++) assert.equal((await site.check("2055")).reason, "closed");
  assert.equal((await site.check("2055")).forced, true);
  await enter();
  assert.equal(guard.closesAt, now() + 30 * MIN);
});
