/* core.availability — the opening hours of the deployment passcode.

   The passcode of a deployed build (app.site) is not meant to work around the
   clock. This module decides, deterministically, WHEN it works. It is pure:
   same seed + same moment → same answer on every device, after every reload,
   with nothing stored anywhere. There is no state to clear and no "try again"
   that changes the outcome.

   ── The month ──────────────────────────────────────────────────────────────
   A month is four weeks of working days ("the passcode works today"):

       week 1  days  1–7            4 working days
       week 2  days  8–14           3 working days
       week 3  days 15–21           3 working days
       week 4  days 22–month end    2 working days   (29–31 belong to week 4)

   Which days are picked is drawn from a seeded stream, but never regularly:
     · at most two working days in a row — never three, also across week and
       month boundaries;
     · no evenly spaced days inside a week (1-3-5-7, 9-11-13, 15-18-21 …) and no
       four evenly spaced working days anywhere in the month, so the calendar
       never settles into an every-other-day or every-third-day rhythm;
     · two neighbouring weeks never reuse the same weekdays ("Monday and
       Thursday again"), including week 4 → week 1 of the next month.
   Week 1 of a month is drawn without looking back; week 4 of the previous
   month is drawn knowing it, so the boundary rules hold without an infinite
   regress into the past.

   ── The day ────────────────────────────────────────────────────────────────
   Every day gives 20 % of its hours (288 minutes) to "the other side":
     · a working day has 288 minutes of BLACKOUT, the passcode fails then;
     · an off day has 288 minutes of ACCESS, the only time the passcode works.
   Those minutes are scattered into 10–15 windows of 12–30 minutes each (never
   more than 30), at least 30 minutes apart, never touching midnight (so two
   days can never merge into one long window). Where they land is weighted by
   the time of day: blackouts prefer the evening, access windows prefer waking
   hours — so the app is least available when it is most tempting.

   ── Honesty ────────────────────────────────────────────────────────────────
   This runs on the device clock, in the device's time zone. It is a
   self-discipline tool, not a security boundary: whoever controls the clock
   controls the calendar. The seed defaults to the passcode digest, so changing
   the passcode reshuffles the calendar; a `seed` in site.config.js reshuffles
   it without changing the passcode. */
XR.define("core.availability", [], function () {
  "use strict";

  /* ------------------------------------------------------------ constants -- */
  const DAY = 1440;                 // minutes in a day
  const SLOT = 30;                  // the grid a window lives in — and the longest a window can be
  const SHARE = 0.2;                // the share of every day given to the other side
  const SHARE_MINUTES = Math.round(DAY * SHARE);   // 288
  const WINDOW_MIN = 12, WINDOW_MAX = SLOT;        // minutes
  const WINDOWS_MIN = 10, WINDOWS_MAX = 15;        // 10 × 30 ≥ 288 ≥ 15 × 12, and 15 non-adjacent slots always fit
  const FIRST_SLOT = 1, LAST_SLOT = 46;            // 00:00–00:30 and 23:30–24:00 never host a window
  const QUOTAS = [4, 3, 3, 2];                      // working days per week of the month
  const MAX_RUN = 2;                                // working days in a row
  const GRACE_DEFAULT = 5, GRACE_MAX = 30;          // minutes to finish after a window closes

  /* Time-of-day weights, one per hour. Blackouts (working days) lean on the
     evening; access windows (off days) lean on waking hours. */
  const WEIGHT_BLACKOUT = [0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 0.8, 0.8, 0.8, 1, 1, 1, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.8, 1.8, 1.8, 1.8, 1.8, 1.8];
  const WEIGHT_ACCESS = [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 1, 1, 1, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.1, 1.1, 1.1, 1.1, 0.7, 0.7];

  /* ---------------------------------------------------------- randomness -- */
  /** cyrb128: a string → four 32-bit words (public domain, bryc). */
  function cyrb128(str) {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0, k; i < str.length; i++) {
      k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
  }
  /** sfc32: small, fast, well-mixed PRNG over four words (public domain). */
  function sfc32(a, b, c, d) {
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }
  /** An independent stream per purpose: rng(seed, "month", 2026, 10, 1). */
  function rng(...parts) {
    const r = sfc32(...cyrb128(parts.join("\u001f")));
    for (let i = 0; i < 12; i++) r();   // discard the warm-up
    return r;
  }
  const pick = (r, list) => list[Math.floor(r() * list.length)];

  /* -------------------------------------------------------------- config -- */
  function normalize(raw) {
    const c = raw && typeof raw === "object" ? raw : {};
    const enabled = c.enabled === true || c.enabled === 1 || c.enabled === "on" || c.enabled === "true";
    const grace = Number(c.graceMinutes);
    return {
      enabled,
      seed: String(c.seed ?? "").trim(),
      graceMinutes: Number.isFinite(grace) ? Math.min(GRACE_MAX, Math.max(0, Math.round(grace))) : GRACE_DEFAULT,
    };
  }

  /* ------------------------------------------------------------ calendar -- */
  const daysInMonth = (year, month) => new Date(year, month, 0).getDate();   // month is 1-based
  const weekday = (year, month, day) => new Date(year, month - 1, day).getDay();
  function weeksOf(year, month) {
    const last = daysInMonth(year, month);
    return [[1, 7], [8, 14], [15, 21], [22, last]].map(([from, to], i) => ({ index: i + 1, from, to, quota: QUOTAS[i] }));
  }

  /** Every k-subset of the integers from..to, in lexicographic order. */
  function combos(from, to, k) {
    const out = [];
    (function walk(start, acc) {
      if (acc.length === k) { out.push(acc.slice()); return; }
      for (let d = start; d <= to; d++) { acc.push(d); walk(d + 1, acc); acc.pop(); }
    })(from, []);
    return out;
  }
  const sortedUnion = (...lists) => [...new Set([].concat(...lists))].sort((a, b) => a - b);

  /** Three (MAX_RUN + 1) consecutive calendar days in a sorted list of day numbers. */
  function hasRun(sorted) {
    for (let i = MAX_RUN; i < sorted.length; i++) if (sorted[i] - sorted[i - MAX_RUN] === MAX_RUN) return true;
    return false;
  }
  /** `terms` consecutive entries with identical gaps — an every-n-days rhythm. */
  function hasRhythm(sorted, terms) {
    for (let i = terms - 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      let regular = true;
      for (let j = i - terms + 2; j <= i; j++) if (sorted[j] - sorted[j - 1] !== gap) { regular = false; break; }
      if (regular) return true;
    }
    return false;
  }
  /** Any three evenly spaced days inside one week (1-3-5, 2-5-8 …). */
  function hasEvenTriple(days) {
    for (let i = 0; i < days.length; i++) for (let j = i + 1; j < days.length; j++) for (let k = j + 1; k < days.length; k++) if (days[j] - days[i] === days[k] - days[j]) return true;
    return false;
  }
  /** The smaller weekday set sits inside the larger one: "the same weekdays again". */
  function reusesWeekdays(a, b) {
    if (!a || !b || !a.size || !b.size) return false;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const w of small) if (!large.has(w)) return false;
    return true;
  }

  /** Draw one week. `ctx.before`/`ctx.after` are fixed working days (month-relative
      numbering, so next month's day 1 arrives as last+1) and the weekday sets of the
      neighbouring weeks. Rules relax in order if the neighbours leave no room. */
  function drawWeek(r, year, month, week, ctx) {
    const all = combos(week.from, week.to, week.quota);
    const around = (c) => sortedUnion(ctx.before, c, ctx.after);
    const noRun = (c) => !hasRun(around(c));
    const noRhythm = (c) => !hasRhythm(around(c), 4) && !hasEvenTriple(c);
    const freshWeekdays = (c) => { const w = new Set(c.map((d) => weekday(year, month, d))); return !reusesWeekdays(w, ctx.beforeWeekdays) && !reusesWeekdays(w, ctx.afterWeekdays); };
    const ladder = [
      (c) => noRun(c) && noRhythm(c) && freshWeekdays(c),
      (c) => noRun(c) && noRhythm(c),
      noRun,
      () => true,
    ];
    for (const rule of ladder) {
      const pool = all.filter(rule);
      if (pool.length) return pick(r, pool);
    }
    return all[0] || [];
  }
  const weekdaysOf = (year, month, days) => new Set(days.map((d) => weekday(year, month, d)));

  /** Week 1 never looks back — it is the anchor the previous month's week 4 adapts to. */
  function firstWeek(seed, year, month) {
    const week = weeksOf(year, month)[0];
    return drawWeek(rng(seed, "month", year, month, 1), year, month, week, { before: [], after: [], beforeWeekdays: null, afterWeekdays: null });
  }

  const cache = new Map();
  /** The working days of a month: { year, month, days:number[], set:Set, weeks:[{index,from,to,quota,days}] }. */
  function monthPlan(seed, year, month) {
    const key = `${seed}\u001f${year}\u001f${month}`;
    if (cache.has(key)) return cache.get(key);
    const weeks = weeksOf(year, month);
    const last = daysInMonth(year, month);
    const nextYear = month === 12 ? year + 1 : year, nextMonth = month === 12 ? 1 : month + 1;
    const nextFirst = firstWeek(seed, nextYear, nextMonth);
    const chosen = [];
    for (const week of weeks) {
      const isLast = week.index === weeks.length;
      const previous = chosen[chosen.length - 1];
      const ctx = {
        before: chosen.flatMap((w) => w.days),
        after: isLast ? nextFirst.map((d) => d + last) : [],
        beforeWeekdays: previous ? weekdaysOf(year, month, previous.days) : null,
        afterWeekdays: isLast ? weekdaysOf(nextYear, nextMonth, nextFirst) : null,
      };
      const days = week.index === 1 ? firstWeek(seed, year, month) : drawWeek(rng(seed, "month", year, month, week.index), year, month, week, ctx);
      chosen.push({ ...week, days });
    }
    const days = chosen.flatMap((w) => w.days);
    const plan = { year, month, days, set: new Set(days), weeks: chosen };
    if (cache.size > 96) cache.clear();
    cache.set(key, plan);
    return plan;
  }
  const isWorkingDay = (seed, year, month, day) => monthPlan(seed, year, month).set.has(day);

  /* ----------------------------------------------------------------- day -- */
  /** Split `total` minutes into n irregular lengths, each within [lo, hi]. */
  function splitMinutes(r, total, n, lo, hi) {
    const base = Math.floor(total / n);
    const lengths = Array.from({ length: n }, (_, i) => base + (i < total - base * n ? 1 : 0));
    for (let k = 0; k < n * 6; k++) {
      const i = Math.floor(r() * n), j = Math.floor(r() * n), t = 1 + Math.floor(r() * 6);
      if (i !== j && lengths[i] - t >= lo && lengths[j] + t <= hi) { lengths[i] -= t; lengths[j] += t; }
    }
    return lengths;
  }
  /** n half-hour slots, never adjacent, weighted by the hour they fall in. */
  function pickSlots(r, n, weights) {
    const free = new Set();
    for (let s = FIRST_SLOT; s <= LAST_SLOT; s++) free.add(s);
    const chosen = [];
    while (chosen.length < n && free.size) {
      const slots = [...free].sort((a, b) => a - b);
      const total = slots.reduce((sum, s) => sum + weights[Math.floor(s / 2)], 0);
      let x = r() * total, slot = slots[slots.length - 1];
      for (const s of slots) { x -= weights[Math.floor(s / 2)]; if (x < 0) { slot = s; break; } }
      chosen.push(slot);
      free.delete(slot - 1); free.delete(slot); free.delete(slot + 1);
    }
    return chosen.sort((a, b) => a - b);
  }
  /** The open intervals of a day whose closed intervals are `windows` (sorted, disjoint). */
  function complement(windows) {
    const out = [];
    let cursor = 0;
    for (const w of windows) { if (w.start > cursor) out.push({ start: cursor, end: w.start }); cursor = w.end; }
    if (cursor < DAY) out.push({ start: cursor, end: DAY });
    return out;
  }

  /** One day: { year, month, day, working, windows:[{start,end}], open:[{start,end}] } in minutes since local midnight.
      On a working day `windows` are the blackouts; on an off day they are the only open time. */
  function dayPlan(seed, year, month, day) {
    const working = isWorkingDay(seed, year, month, day);
    const r = rng(seed, "day", year, month, day);
    const n = WINDOWS_MIN + Math.floor(r() * (WINDOWS_MAX - WINDOWS_MIN + 1));
    const lengths = splitMinutes(r, SHARE_MINUTES, n, WINDOW_MIN, WINDOW_MAX);
    const slots = pickSlots(r, n, working ? WEIGHT_BLACKOUT : WEIGHT_ACCESS);
    const windows = slots.map((slot, i) => {
      const length = lengths[i];
      const start = slot * SLOT + Math.floor(r() * (SLOT - length + 1));
      return { start, end: start + length };
    });
    return { year, month, day, working, windows, open: working ? complement(windows) : windows };
  }

  /* -------------------------------------------------------------- status -- */
  const minuteOf = (date) => date.getHours() * 60 + date.getMinutes() + (date.getSeconds() + date.getMilliseconds() / 1000) / 60;
  const atMinute = (year, month, day, minute) => new Date(year, month - 1, day, Math.floor(minute / 60), minute % 60, 0, 0);
  const shiftDay = (year, month, day, by) => { const d = new Date(year, month - 1, day + by); return [d.getFullYear(), d.getMonth() + 1, d.getDate()]; };

  /** Is the passcode allowed to work at `now`, and when does that change?
      { open, working, window, until (Date of the next change), remaining (minutes), daysAhead } */
  function status(seed, now = new Date()) {
    const year = now.getFullYear(), month = now.getMonth() + 1, day = now.getDate();
    const plan = dayPlan(seed, year, month, day);
    const t = minuteOf(now);
    const current = plan.open.find((w) => t >= w.start && t < w.end);
    if (current) return { open: true, working: plan.working, window: current, until: atMinute(year, month, day, current.end), remaining: current.end - t, daysAhead: 0 };
    const later = plan.open.find((w) => w.start > t);
    if (later) return { open: false, working: plan.working, window: later, until: atMinute(year, month, day, later.start), remaining: later.start - t, daysAhead: 0 };
    for (let ahead = 1; ahead <= 7; ahead++) {   // an off day always has windows, so this ends tomorrow at the latest
      const [y, m, d] = shiftDay(year, month, day, ahead);
      const next = dayPlan(seed, y, m, d).open[0];
      if (next) return { open: false, working: plan.working, window: next, until: atMinute(y, m, d, next.start), remaining: (DAY - t) + (ahead - 1) * DAY + next.start, daysAhead: ahead };
    }
    return { open: false, working: plan.working, window: null, until: null, remaining: Infinity, daysAhead: Infinity };
  }

  /** A coarse word for "how long until it opens" — enough to stop refreshing, not enough to plan around. */
  function phase(s) {
    if (!s || s.open) return "open";
    if (s.remaining < 60) return "soon";       // also 23:52 → 00:00: "within the hour", not "tomorrow"
    if (s.remaining < 180) return "hours";
    if (s.daysAhead >= 2) return "later";
    if (s.daysAhead === 1) return "tomorrow";
    return "today";
  }

  return {
    normalize, monthPlan, dayPlan, status, phase, isWorkingDay,
    constants: { DAY, SLOT, SHARE, SHARE_MINUTES, WINDOW_MIN, WINDOW_MAX, WINDOWS_MIN, WINDOWS_MAX, QUOTAS, MAX_RUN, GRACE_DEFAULT, GRACE_MAX },
    _internal: { rng, cyrb128, combos, hasRun, hasRhythm, hasEvenTriple, reusesWeekdays, splitMinutes, pickSlots, complement },
  };
});
