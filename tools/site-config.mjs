/* tools/site-config.mjs — read and write site.config.js (shared by the CLIs).

   site.config.js is a tiny script (`window.XREELS_SITE = {…}`), so reading it
   means running it with a fake `window`. Writing it always goes through one
   template, so every CLI leaves the same, commented file behind. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FILE = join(ROOT, "site.config.js");

export const DEFAULT_AVAILABILITY = { enabled: false, seed: "", graceMinutes: 5 };

/** The current config, or an empty one when the file is missing or unreadable. */
export function readSiteConfig() {
  if (!existsSync(FILE)) return { salt: "", hash: "", hint: "", title: "saves", availability: { ...DEFAULT_AVAILABILITY } };
  const window = {};
  try { runInNewContext(readFileSync(FILE, "utf8"), { window }); } catch { /* fall through to the empty config */ }
  const c = window.XREELS_SITE && typeof window.XREELS_SITE === "object" ? window.XREELS_SITE : {};
  const a = c.availability && typeof c.availability === "object" ? c.availability : {};
  return {
    salt: String(c.salt || ""), hash: String(c.hash || ""), hint: String(c.hint || ""), title: String(c.title || "saves"),
    availability: {
      enabled: a.enabled === true || a.enabled === "on" || a.enabled === 1,
      seed: String(a.seed ?? ""),
      graceMinutes: Number.isFinite(Number(a.graceMinutes)) ? Math.min(30, Math.max(0, Math.round(Number(a.graceMinutes)))) : 5,
    },
  };
}

const TEMPLATE = (c) => `/* saves — the password of this deployment.

   Empty salt + hash  → no site password: the app opens straight away
                         (this is what a local, double-clicked copy wants).
   Filled in           → every visitor of this deployment must type the
                         password before the app opens.

   Set it with:   npm run site:password -- "your password"
   Read more in:  DEPLOY.md

   Only the salted SHA-256 digest lives here — never the password itself.
   The digest is read by src/application/services/site.js and checked by
   src/shell/site-gate.js.

   availability — the opening hours of the password (src/core/availability.js):
     enabled       true → the password only works inside its windows
     seed          "" → the calendar is derived from the hash above (a new
                   password = a new calendar); any text reshuffles it on its own
     graceMinutes  minutes to finish after a window closes (0–30)
   Switch with:  npm run site:password -- --hours on|off   ·  preview:  npm run site:hours */
window.XREELS_SITE = {
  salt: ${JSON.stringify(c.salt)},
  hash: ${JSON.stringify(c.hash)},
  hint: ${JSON.stringify(c.hint)},
  title: ${JSON.stringify(c.title)},
  availability: { enabled: ${c.availability.enabled ? "true" : "false"}, seed: ${JSON.stringify(c.availability.seed)}, graceMinutes: ${c.availability.graceMinutes} },
};
`;

export function writeSiteConfig(config) {
  const c = { ...readSiteConfig(), ...config, availability: { ...DEFAULT_AVAILABILITY, ...(config.availability || {}) } };
  writeFileSync(FILE, TEMPLATE(c), "utf8");
  return c;
}
