#!/usr/bin/env node
/* tools/site-hours.mjs — preview the opening hours of the site password.

   Runs the very same src/core/availability.js the browser runs, with the seed
   from site.config.js, so what it prints is what the gate will do.

     npm run site:hours                          # this month, today, right now
     npm run site:hours -- --month 2026-11       # another month
     npm run site:hours -- --day 2026-11-03      # the windows of one day
     npm run site:hours -- --seed "autumn"       # what a reshuffled calendar would look like
     npm run site:hours -- --now "2026-11-03 21:15"   # the status at a given local time */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { ROOT, readSiteConfig } from "./site-config.mjs";

const argv = process.argv.slice(2);
const valueOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };

/* ---- load the engine ------------------------------------------------- */
const modules = new Map();
const XR = { define: (name, deps, factory) => modules.set(name, { deps, factory }), resolve(name) { const m = modules.get(name); if (!m) throw new Error(`unknown module ${name}`); if (!m.api) m.api = m.factory(...m.deps.map(XR.resolve)); return m.api; } };
runInNewContext(readFileSync(join(ROOT, "src/core/availability.js"), "utf8"), { XR, console });
const A = XR.resolve("core.availability");

/* ---- inputs ---------------------------------------------------------- */
const config = readSiteConfig();
const schedule = A.normalize(config.availability);
const seedOverride = valueOf("--seed");
const seed = seedOverride ?? (schedule.seed || config.hash || config.title || "saves");
const seedLabel = seedOverride != null ? `seed "${seedOverride}" (preview)` : schedule.seed ? `seed "${schedule.seed}"` : config.hash ? `seed = password digest ${config.hash.slice(0, 8)}…` : "no password set — seed from the title";
const now = valueOf("--now") ? new Date(valueOf("--now").replace(" ", "T")) : new Date();
if (Number.isNaN(now.getTime())) { console.error("  ✖ --now needs a local time like \"2026-11-03 21:15\""); process.exit(1); }
const monthArg = valueOf("--month"), dayArg = valueOf("--day");
const [year, month] = monthArg ? monthArg.split("-").map(Number) : dayArg ? dayArg.split("-").slice(0, 2).map(Number) : [now.getFullYear(), now.getMonth() + 1];
const day = dayArg ? Number(dayArg.split("-")[2]) : (year === now.getFullYear() && month === now.getMonth() + 1 ? now.getDate() : 1);
if (!year || !month || month < 1 || month > 12 || !day) { console.error("  ✖ use --month YYYY-MM or --day YYYY-MM-DD"); process.exit(1); }

/* ---- print ----------------------------------------------------------- */
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const monthName = new Date(year, month - 1, 1).toLocaleString("en", { month: "long" });
const plan = A.monthPlan(seed, year, month);
const C = A.constants;

console.log(`\n  Opening hours — ${config.hash ? "site password set" : "NO site password"} · schedule ${schedule.enabled ? "ON" : "OFF"} · grace ${schedule.graceMinutes} min · ${seedLabel}`);
if (!schedule.enabled && seedOverride == null) console.log("  (the schedule is off: the password works around the clock — this is what it would do when switched on)");
console.log(`\n  ${monthName} ${year} — working days (● the passcode works all day except ${C.SHARE_MINUTES} min of blackouts · · off day, only ${C.SHARE_MINUTES} min of windows)\n`);
for (const w of plan.weeks) {
  const cells = [];
  for (let d = w.from; d <= w.to; d++) cells.push(`${String(d).padStart(2)}${w.days.includes(d) ? "●" : "·"}`);
  console.log(`  week ${w.index}  ${cells.join(" ")}${" ".repeat(Math.max(0, 4 * (10 - cells.length)))}   ${w.days.length} of ${w.quota}: ${w.days.join(", ")}`);
}
const weekdayOf = (d) => new Date(year, month - 1, d).toLocaleString("en", { weekday: "short" });
console.log(`\n  ${plan.days.length} working days: ${plan.days.map((d) => `${weekdayOf(d)} ${d}`).join(" · ")}`);

const p = A.dayPlan(seed, year, month, day);
console.log(`\n  ${weekdayOf(day)} ${day} ${monthName} ${year} — ${p.working ? "WORKING day: the passcode works, except during these blackouts" : "OFF day: the passcode works only inside these windows"} (${p.windows.length} windows, ${p.windows.reduce((s, w) => s + w.end - w.start, 0)} min):`);
console.log(`  ${p.windows.map((w) => `${hhmm(w.start)}–${hhmm(w.end)}`).join("  ")}`);

const s = A.status(seed, now);
const when = now.toLocaleString("en", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
if (s.open) console.log(`\n  Now (${when}): OPEN — closes at ${s.until.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false })} (in ${Math.ceil(s.remaining)} min), then ${schedule.graceMinutes} min of grace.\n`);
else console.log(`\n  Now (${when}): CLOSED — opens ${s.daysAhead ? "tomorrow" : "again"} at ${s.until.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false })} (in ${Math.ceil(s.remaining)} min) · the gate will say "${A.phase(s)}".\n`);
