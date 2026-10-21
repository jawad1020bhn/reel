/* Opening hours of the site passcode — core.availability, app.site and shell.availability.
   Runs the shipped modules through the VM loader; nothing is mocked inside the engine. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createXR } from "./helpers/xr.mjs";

/* Modules run in a VM realm: compare by value, not by prototype. */
const eq = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const engine = () => { const { XR, load } = createXR(); load("src/core/availability.js"); return XR.resolve("core.availability"); };
const SEEDS = ["a512804f1371c3ecd8a4e9fa011de83b3991f848d78f2648d70babfc01ac0e54", "autumn", "2055", "x", "another calendar"];
const daysIn = (y, m) => new Date(y, m, 0).getDate();
const weekdays = (y, m, days) => new Set(days.map((d) => new Date(y, m - 1, d).getDay()));

test("the calendar is deterministic and seed-specific", () => {
  const A = engine(), B = engine();
  eq(A.monthPlan("autumn", 2026, 10).days, B.monthPlan("autumn", 2026, 10).days);
  eq(A.dayPlan("autumn", 2026, 10, 21).windows, B.dayPlan("autumn", 2026, 10, 21).windows);
  let differ = 0;
  for (let m = 1; m <= 12; m++) if (A.monthPlan("autumn", 2026, m).days.join() !== A.monthPlan("winter", 2026, m).days.join()) differ++;
  assert.ok(differ >= 10, `different seeds give different months (${differ}/12 differ)`);
});

test("a month is 4 / 3 / 3 / 2 working days, week 4 running to the month end", () => {
  const A = engine();
  for (const seed of SEEDS) for (let y = 2024; y <= 2030; y++) for (let m = 1; m <= 12; m++) {
    const plan = A.monthPlan(seed, y, m);
    eq(plan.weeks.map((w) => w.days.length), [4, 3, 3, 2], `${seed} ${y}-${m}`);
    eq(plan.weeks.map((w) => [w.from, w.to]), [[1, 7], [8, 14], [15, 21], [22, daysIn(y, m)]]);
    for (const w of plan.weeks) for (const d of w.days) assert.ok(d >= w.from && d <= w.to, `${seed} ${y}-${m}: day ${d} outside week ${w.index}`);
    assert.equal(plan.days.length, 12);
    assert.equal(new Set(plan.days).size, 12);
  }
});

test("working days never fall into a rhythm — across weeks and across months", () => {
  const A = engine();
  const { hasRun, hasRhythm, hasEvenTriple, reusesWeekdays } = A._internal;
  for (const seed of SEEDS) {
    let tail = [], tailWeekdays = null;
    for (let y = 2024; y <= 2030; y++) for (let m = 1; m <= 12; m++) {
      const plan = A.monthPlan(seed, y, m), last = daysIn(y, m), where = `${seed} ${y}-${m}`;
      const joined = [...tail, ...plan.days];
      assert.ok(!hasRun(joined), `${where}: three working days in a row (${joined.join(",")})`);
      assert.ok(!hasRhythm(joined, 4), `${where}: four evenly spaced working days (${joined.join(",")})`);
      const sets = plan.weeks.map((w) => weekdays(y, m, w.days));
      plan.weeks.forEach((w, i) => {
        assert.ok(!hasEvenTriple(w.days), `${where}: evenly spaced days inside week ${w.index} (${w.days.join(",")})`);
        if (i) assert.ok(!reusesWeekdays(sets[i - 1], sets[i]), `${where}: week ${w.index} reuses the weekdays of week ${w.index - 1}`);
      });
      if (tailWeekdays) assert.ok(!reusesWeekdays(tailWeekdays, sets[0]), `${where}: week 1 reuses the weekdays of the previous week 4`);
      tail = plan.days.filter((d) => d > last - 7).map((d) => d - last);   // month-relative: negatives and zero
      tailWeekdays = sets[3];
    }
  }
});

test("every day scatters exactly 20 % into 10–15 windows of 12–30 minutes, ≥ 30 min apart, clear of midnight", () => {
  const A = engine();
  for (const seed of SEEDS.slice(0, 3)) for (let y = 2025; y <= 2027; y++) for (let m = 1; m <= 12; m++) for (let d = 1; d <= daysIn(y, m); d++) {
    const p = A.dayPlan(seed, y, m, d), where = `${seed} ${y}-${m}-${d}`;
    assert.ok(p.windows.length >= 10 && p.windows.length <= 15, `${where}: ${p.windows.length} windows`);
    assert.equal(p.windows.reduce((s, w) => s + (w.end - w.start), 0), 288, `${where}: total minutes`);
    p.windows.forEach((w, i) => {
      const len = w.end - w.start;
      assert.ok(len >= 12 && len <= 30, `${where}: window of ${len} min`);
      if (i) assert.ok(w.start - p.windows[i - 1].end >= 30, `${where}: windows only ${w.start - p.windows[i - 1].end} min apart`);
    });
    assert.ok(p.windows[0].start >= 30 && p.windows[p.windows.length - 1].end <= 1410, `${where}: a window touches midnight`);
    const open = p.open.reduce((s, w) => s + (w.end - w.start), 0);
    assert.equal(open, p.working ? 1152 : 288, `${where}: open minutes on a ${p.working ? "working" : "off"} day`);
  }
});

test("blackouts lean on the evening, access windows lean on waking hours", () => {
  const A = engine();
  const byHour = { blackout: Array(24).fill(0), access: Array(24).fill(0) };
  for (let y = 2025; y <= 2027; y++) for (let m = 1; m <= 12; m++) for (let d = 1; d <= 28; d++) {
    const p = A.dayPlan("autumn", y, m, d);
    for (const w of p.windows) byHour[p.working ? "blackout" : "access"][Math.floor(w.start / 60)]++;
  }
  const sum = (list, from, to) => list.slice(from, to).reduce((a, b) => a + b, 0) / (to - from);
  assert.ok(sum(byHour.blackout, 18, 24) > 1.6 * sum(byHour.blackout, 1, 6), "blackouts: evening hours ≫ night hours");
  assert.ok(sum(byHour.access, 9, 18) > 1.6 * sum(byHour.access, 1, 6), "access: daytime hours ≫ night hours");
  assert.ok(sum(byHour.blackout, 18, 24) > 1.15 * sum(byHour.access, 18, 24) * (sum(byHour.blackout, 0, 24) / sum(byHour.access, 0, 24)), "relative to their totals, blackouts favour the evening more than access windows do");
});

test("status knows whether the passcode works now and when that changes", () => {
  const A = engine(), seed = "autumn";
  // a working day: open outside the blackouts, closed inside
  let y = 2026, m = 10, d = 1;
  while (!A.isWorkingDay(seed, y, m, d)) d++;
  const work = A.dayPlan(seed, y, m, d), b = work.windows[0];
  const inside = A.status(seed, new Date(y, m - 1, d, Math.floor((b.start + 1) / 60), (b.start + 1) % 60));
  assert.equal(inside.open, false); assert.equal(inside.working, true);
  assert.equal(inside.until.getTime(), new Date(y, m - 1, d, Math.floor(b.end / 60), b.end % 60).getTime());
  assert.ok(inside.remaining > 0 && inside.remaining <= 30);
  const before = A.status(seed, new Date(y, m - 1, d, 0, 0));
  assert.equal(before.open, true); assert.equal(before.remaining, b.start);
  // an off day: closed outside the windows, open inside
  d = 1; while (A.isWorkingDay(seed, y, m, d)) d++;
  const off = A.dayPlan(seed, y, m, d), w = off.windows[0];
  assert.equal(A.status(seed, new Date(y, m - 1, d, 0, 5)).open, false);
  const during = A.status(seed, new Date(y, m - 1, d, Math.floor(w.start / 60), w.start % 60));
  assert.equal(during.open, true); assert.equal(during.working, false); assert.equal(Math.round(during.remaining), w.end - w.start);
  // after the last window of an off day the next opening is tomorrow
  const late = A.status(seed, new Date(y, m - 1, d, 23, 45));
  assert.equal(late.open, false); assert.equal(late.daysAhead, 1);
  assert.equal(late.until.getDate(), new Date(y, m - 1, d + 1).getDate());
  // coarse phases
  assert.equal(A.phase({ open: true }), "open");
  assert.equal(A.phase({ open: false, remaining: 8, daysAhead: 1 }), "soon");
  assert.equal(A.phase({ open: false, remaining: 120, daysAhead: 0 }), "hours");
  assert.equal(A.phase({ open: false, remaining: 400, daysAhead: 0 }), "today");
  assert.equal(A.phase({ open: false, remaining: 400, daysAhead: 1 }), "tomorrow");
});

test("normalize() reads the site.config.js block defensively", () => {
  const A = engine();
  eq(A.normalize(undefined), { enabled: false, seed: "", graceMinutes: 5 });
  eq(A.normalize({ enabled: "on", seed: "  autumn ", graceMinutes: "3" }), { enabled: true, seed: "autumn", graceMinutes: 3 });
  eq(A.normalize({ enabled: true, graceMinutes: 99 }), { enabled: true, seed: "", graceMinutes: 30 });
  eq(A.normalize({ enabled: "yes", graceMinutes: -2 }), { enabled: false, seed: "", graceMinutes: 0 });
});

/* ---------------------------------------------------------------- app.site -- */
const sha = (t) => createHash("sha256").update(t).digest("hex");
function siteWith(config, { file = false, now } = {}) {
  const { XR, load } = createXR();
  const globals = { window: { XREELS_SITE: config } };
  if (now) {
    let clock = now;
    class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock); } static now() { return clock; } }
    globals.Date = FakeDate;
    globals.__setNow = (ms) => { clock = ms; };
  }
  XR.provide("app.ports.platform", { isFile: () => file, sha256: async (t) => sha(t) });
  load("src/core/availability.js", globals);
  load("src/application/services/site.js", globals);
  return { site: XR.resolve("app.site"), A: XR.resolve("core.availability"), setNow: globals.__setNow };
}
const CONFIG = { salt: "s4lt", hash: sha("s4lt:2055"), title: "saves", availability: { enabled: true, seed: "autumn", graceMinutes: 5 } };
const moment = (y, m, d, minute) => new Date(y, m - 1, d, Math.floor(minute / 60), minute % 60);

test("app.site: the right passcode is refused outside the opening hours — with the reason", async () => {
  const { site, A } = siteWith(CONFIG);
  assert.equal(site.scheduled(), true);
  assert.equal(site.seed(), "autumn");
  assert.equal(site.graceMinutes(), 5);
  let d = 1; while (!A.isWorkingDay("autumn", 2026, 11, d)) d++;
  const plan = A.dayPlan("autumn", 2026, 11, d);
  const closed = moment(2026, 11, d, plan.windows[0].start + 1), open = moment(2026, 11, d, plan.open[0].start + 1);
  eq((await site.check("1234", open)).reason, "wrong");
  eq((await site.check("1234", closed)).reason, "wrong", "a wrong passcode is wrong at any hour");
  const refused = await site.check("2055", closed);
  assert.equal(refused.ok, false); assert.equal(refused.reason, "closed"); assert.equal(refused.status.open, false);
  const accepted = await site.check("2055", open);
  assert.equal(accepted.ok, true); assert.equal(accepted.reason, null); assert.ok(accepted.status.remaining > 0);
  assert.equal(await site.verify("2055", closed), false);
  assert.equal(await site.verify("2055", open), true);
  assert.equal(site.phase(site.status(closed)), "soon");
});

test("app.site: no schedule, or a local file, and the passcode works around the clock", async () => {
  const off = siteWith({ ...CONFIG, availability: { enabled: false } });
  assert.equal(off.site.scheduled(), false);
  assert.equal(off.site.status().open, true);
  assert.equal(off.site.status().always, true);
  for (let h = 0; h < 24; h++) assert.equal(await off.site.verify("2055", new Date(2026, 10, 3, h, 7)), true);
  const seeded = siteWith({ ...CONFIG, availability: { enabled: true, seed: "" } });
  assert.equal(seeded.site.seed(), CONFIG.hash, "without a seed the calendar follows the passcode digest");
  const local = siteWith(CONFIG, { file: true });
  assert.equal(local.site.scheduled(), false);
  assert.equal((await local.site.check("anything")).ok, true);
});

/* ------------------------------------------------------- shell.availability -- */
function guardWith({ startAt }) {
  const { XR, load } = createXR();
  let clock = startAt.getTime();
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock); } static now() { return clock; } }
  const timers = []; let nextId = 0;
  let monotonic = 1000;   // a monotonic clock: moves with advance(), pauses in jump() (sleep), ignores setClock()
  /* Timers are monotonic, as in a browser: a changed wall clock neither hurries nor delays them. */
  const schedule = (fn, ms, interval) => { timers.push({ id: ++nextId, fn, due: monotonic + Math.max(0, ms || 0), interval: interval || 0 }); return nextId; };
  const cancel = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  const document = { hidden: false, listeners: {}, addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); } };
  const globals = { Date: FakeDate, setTimeout: (fn, ms) => schedule(fn, ms, 0), setInterval: (fn, ms) => schedule(fn, ms, ms), clearTimeout: cancel, clearInterval: cancel, window: { XREELS_SITE: CONFIG }, document, performance: { now: () => monotonic } };
  const log = { toasts: [], pauses: 0, ensures: [], dismissed: 0 };
  let releaseGate = null;
  XR.provide("app.ports.platform", { isFile: () => false, sha256: async (t) => sha(t) });
  XR.provide("ui.dom", { h: () => ({ textContent: "" }) });
  XR.provide("ui.toast", { show: (o) => { log.toasts.push(o); return () => { log.dismissed++; }; }, toast: (message, kind, extra) => log.toasts.push({ message, kind, ...extra }) });
  XR.provide("app.playback", { pauseAll: () => { log.pauses++; } });
  XR.provide("shell.siteGate", { ensure: (opts) => { log.ensures.push(opts); return new Promise((resolve) => { releaseGate = resolve; }); } });
  load("src/core/availability.js", globals);
  load("src/application/services/site.js", globals);
  load("src/shell/availability.js", globals);
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  /** Let time pass with timers running, as in an awake tab. */
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
  /** Let time pass with timers frozen, as in a sleeping laptop or a suspended tab (the monotonic clock pauses too). */
  const jump = (ms) => { clock += ms; };
  /** Set the wall clock — the device clock being changed by hand. */
  const setClock = (ms) => { clock = ms; };
  const fire = async (type) => { for (const fn of document.listeners[type] || []) fn(); await settle(); };
  const enter = async () => { releaseGate?.(true); releaseGate = null; await settle(); };
  return { guard: XR.resolve("shell.availability"), log, advance, jump, fire, enter, setClock, document };
}

test("shell.availability: warns when the window closes, locks after the grace, re-arms after re-entry", async () => {
  const A = engine();
  let d = 1; while (!A.isWorkingDay("autumn", 2026, 11, d)) d++;
  const [, b, c] = A.dayPlan("autumn", 2026, 11, d).windows;                  // the 2nd and 3rd blackouts of a working day
  const { guard, log, advance, enter } = guardWith({ startAt: moment(2026, 11, d, b.start - 10) });
  assert.equal(guard.start(), true);
  assert.equal(guard.closesAt, moment(2026, 11, d, b.start).getTime());
  assert.equal(guard.graceUntil, guard.closesAt + 5 * 60000);
  assert.equal(log.toasts.length, 1, "entering with 10 minutes left shows the heads-up");
  assert.match(String(log.toasts[0].message), /closes in about 10 min/);
  await advance(10 * 60000 + 500);                                            // the blackout starts
  assert.equal(log.toasts.length, 2, "the countdown toast appears at closing time");
  assert.equal(log.toasts[1].timeout, 0);
  assert.match(log.toasts[1].message.textContent, /locks in (5:00|4:5\d)\./);
  assert.equal(log.ensures.length, 0, "not locked during the grace");
  await advance(5 * 60000);                                                   // grace over
  assert.equal(log.pauses, 1, "playback paused");
  assert.equal(log.dismissed, 1, "countdown dismissed");
  eq(log.ensures, [{ reason: "closed" }], "the gate is back as Closing time");
  await advance((b.end - b.start) * 60000);                                   // the visitor waits the blackout out…
  await enter();                                                              // …and types the passcode again
  assert.equal(guard.locking, false);
  assert.equal(guard.closesAt, moment(2026, 11, d, c.start).getTime(), "re-armed on the next blackout");
});

test("shell.availability: a sleeping laptop cannot stretch a window — an overdue grace locks on wake", async () => {
  const A = engine();
  let d = 1; while (A.isWorkingDay("autumn", 2026, 11, d)) d++;                 // an off day: inside an access window
  const w = A.dayPlan("autumn", 2026, 11, d).windows[2];
  const { guard, log, jump, fire, document } = guardWith({ startAt: moment(2026, 11, d, w.start + 2) });
  guard.start();
  assert.equal(guard.closesAt, moment(2026, 11, d, w.end).getTime());
  document.hidden = true; await fire("visibilitychange");
  jump((w.end - w.start) * 60000 + 45 * 60000);                               // lid closed: timers frozen, 45 min past the close
  assert.equal(log.ensures.length, 0, "nothing could run while asleep");
  document.hidden = false; await fire("visibilitychange");
  eq(log.ensures, [{ reason: "closed" }], "locked on wake — the grace is long gone");
  assert.equal(log.pauses, 1);
});

test("shell.availability: setting the device clock back while inside does not stretch the window", async () => {
  const A = engine();
  let d = 1; while (!A.isWorkingDay("autumn", 2026, 11, d)) d++;
  const b = A.dayPlan("autumn", 2026, 11, d).windows[1];
  const { guard, log, advance, setClock, fire } = guardWith({ startAt: moment(2026, 11, d, b.start - 20) });
  guard.start();
  await advance(15 * 60000);                                                  // 5 minutes before the blackout…
  setClock(moment(2026, 11, d, b.start - 60).getTime());                      // …the clock is wound back an hour
  assert.equal(log.ensures.length, 0);
  await advance(5 * 60000 + 5 * 60000 + 1000);                                // true time: close + grace have passed
  assert.deepEqual(log.ensures.length, 1, "locked on true time, not on the wound-back clock");
  await fire("visibilitychange");
  assert.equal(log.ensures.length, 1, "no double lock");
});

test("shell.availability: stays idle without a schedule", () => {
  const { XR, load } = createXR();
  XR.provide("app.ports.platform", { isFile: () => false, sha256: async () => "" });
  XR.provide("ui.dom", { h: () => ({}) }); XR.provide("ui.toast", { show() {}, toast() {} }); XR.provide("app.playback", { pauseAll() {} }); XR.provide("shell.siteGate", { ensure: async () => true });
  const globals = { window: { XREELS_SITE: { ...CONFIG, availability: { enabled: false } } }, document: { addEventListener() {} } };
  load("src/core/availability.js", globals); load("src/application/services/site.js", globals); load("src/shell/availability.js", globals);
  const guard = XR.resolve("shell.availability");
  assert.equal(guard.start(), false);
  assert.equal(guard.closesAt, 0);
});
