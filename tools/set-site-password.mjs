#!/usr/bin/env node
/* tools/set-site-password.mjs — set (or clear) the password of a deployed build,
   and switch its opening hours.

   The password is never written to disk: the file keeps a random salt and the
   salted SHA-256 digest, exactly like app.lock does for the per-browser PIN.

     node tools/set-site-password.mjs "correct horse battery staple"
     node tools/set-site-password.mjs "correct horse battery staple" --hint "the usual"
     node tools/set-site-password.mjs --clear
     XREELS_SITE_PASSWORD="…" node tools/set-site-password.mjs

   Opening hours (see src/core/availability.js and DEPLOY.md) — these can be
   combined with a new password or used on their own, the password stays:

     node tools/set-site-password.mjs --hours on          # the password only works inside its windows
     node tools/set-site-password.mjs --hours off
     node tools/set-site-password.mjs --hours on --seed "autumn"   # reshuffle the calendar without a new password
     node tools/set-site-password.mjs --grace 3           # minutes to finish after a window closes (0–30)

   A closed library (\`closed: true\` in site.config.js) refuses all of this.
   Only \`--reopen\` — typed on purpose, together with a new password — opens it
   again, and it still has no data.

   Re-run it and redeploy for a change to take effect. */
import { createHash, randomBytes } from "node:crypto";
import { readSiteConfig, writeSiteConfig } from "./site-config.mjs";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const valueOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const TAKES_VALUE = new Set(["--hint", "--hours", "--seed", "--grace"]);
const REOPEN = flags.has("--reopen");
const positional = argv.filter((a, i) => !a.startsWith("--") && !TAKES_VALUE.has(argv[i - 1]));

function fail(message) {
  console.error(`\n  ✖ ${message}\n`);
  process.exit(1);
}

const current = readSiteConfig();
if (current.closed && !REOPEN) {
  fail("This library is closed (closed: true in site.config.js). Nothing here reopens it.\n    If you really mean to reopen it, read DEPLOY.md first, then run again with a new password and --reopen.");
}
if (REOPEN && !current.closed) fail("--reopen only applies to a closed library.");
const next = { ...current, availability: { ...current.availability } };
const notes = [];
if (REOPEN) {
  if (!(positional[0] ?? process.env.XREELS_SITE_PASSWORD)) fail("Reopening needs a new password: npm run site:password -- \"new password\" --reopen");
  next.closed = false; next.closedNotice = "";
  notes.push("library REOPENED — it has no dataset; import one in the browser or add data files again");
}

/* ---- opening hours --------------------------------------------------- */
const hours = valueOf("--hours");
if (flags.has("--hours")) {
  if (!/^(on|off|true|false|1|0)$/i.test(hours || "")) fail('--hours needs "on" or "off".');
  next.availability.enabled = /^(on|true|1)$/i.test(hours);
  notes.push(`opening hours ${next.availability.enabled ? "ON — the password only works inside its windows" : "OFF — the password works around the clock"}`);
}
if (flags.has("--seed")) {
  next.availability.seed = String(valueOf("--seed") ?? "").trim();
  notes.push(next.availability.seed ? `calendar seed set — the calendar is reshuffled` : "calendar seed cleared — the calendar follows the password digest again");
}
if (flags.has("--grace")) {
  const grace = Number(valueOf("--grace"));
  if (!Number.isFinite(grace) || grace < 0 || grace > 30) fail("--grace needs a number of minutes between 0 and 30.");
  next.availability.graceMinutes = Math.round(grace);
  notes.push(`grace after a window closes: ${next.availability.graceMinutes} min`);
}

/* ---- password -------------------------------------------------------- */
if (flags.has("--clear")) {
  writeSiteConfig({ ...next, salt: "", hash: "", hint: "" });
  console.log("  ✓ site password removed — redeploy for it to take effect");
  for (const n of notes) console.log(`  ✓ ${n}`);
  process.exit(0);
}

const password = positional[0] ?? process.env.XREELS_SITE_PASSWORD ?? "";
if (!password && !notes.length) {
  fail('No password given.\n    Usage: npm run site:password -- "your password" [--hint "the usual"] [--hours on|off] [--seed "…"] [--grace 5]\n    Or:    XREELS_SITE_PASSWORD="your password" npm run site:password');
}
if (password) {
  if (password.length < 4) fail("The password needs at least 4 characters.");
  next.salt = randomBytes(16).toString("hex");
  next.hash = createHash("sha256").update(`${next.salt}:${password}`).digest("hex");
  if (flags.has("--hint")) next.hint = String(valueOf("--hint") ?? "");
} else if (!next.hash) {
  fail("There is no site password yet — opening hours need one. Set it first: npm run site:password -- \"your password\" --hours on");
}

writeSiteConfig(next);
if (password) {
  console.log(`  ✓ site password set (salt ${next.salt.slice(0, 8)}…, digest ${next.hash.slice(0, 8)}…)`);
  if (next.hint) console.log(`  ✓ hint: ${next.hint}`);
  console.log("  → the password itself was not written anywhere");
}
for (const n of notes) console.log(`  ✓ ${n}`);
if (next.availability.enabled) console.log("  → preview the calendar: npm run site:hours");
console.log("  → deploy again (vercel --prod) for it to take effect\n");
