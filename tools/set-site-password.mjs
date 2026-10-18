#!/usr/bin/env node
/* tools/set-site-password.mjs — set (or clear) the password of a deployed build.

   The password is never written to disk: the file keeps a random salt and the
   salted SHA-256 digest, exactly like app.lock does for the per-browser PIN.

     node tools/set-site-password.mjs "correct horse battery staple"
     node tools/set-site-password.mjs "correct horse battery staple" --hint "the usual"
     node tools/set-site-password.mjs --clear
     XREELS_SITE_PASSWORD="…" node tools/set-site-password.mjs

   Re-run it and redeploy to change the password. */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "site.config.js");

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--"));
const hintIndex = argv.indexOf("--hint");
const hint = hintIndex >= 0 ? (argv[hintIndex + 1] ?? "") : "";

const TEMPLATE = (salt, hash, hintText) => `/* XReels — the password of this deployment.

   Empty salt + hash  → no site password: the app opens straight away
                         (this is what a local, double-clicked copy wants).
   Filled in           → every visitor of this deployment must type the
                         password before the app opens.

   Set it with:   npm run site:password -- "your password"
   Read more in:  DEPLOY.md

   Only the salted SHA-256 digest lives here — never the password itself.
   The digest is read by src/application/services/site.js and checked by
   src/shell/site-gate.js. */
window.XREELS_SITE = {
  salt: ${JSON.stringify(salt)},
  hash: ${JSON.stringify(hash)},
  hint: ${JSON.stringify(hintText)},
  title: "XReels",
};
`;

function fail(message) {
  console.error(`\n  ✖ ${message}\n`);
  process.exit(1);
}

if (flags.has("--clear")) {
  writeFileSync(FILE, TEMPLATE("", "", ""), "utf8");
  console.log("  ✓ site password removed — redeploy for it to take effect");
  process.exit(0);
}

const password = positional[0] ?? process.env.XREELS_SITE_PASSWORD ?? "";
if (!password) {
  fail('No password given.\n    Usage: npm run site:password -- "your password" [--hint "the usual"]\n    Or:    XREELS_SITE_PASSWORD="your password" npm run site:password');
}
if (password.length < 4) fail("The password needs at least 4 characters.");

const salt = randomBytes(16).toString("hex");
const hash = createHash("sha256").update(`${salt}:${password}`).digest("hex");
writeFileSync(FILE, TEMPLATE(salt, hash, hint), "utf8");

console.log(`  ✓ site password set (salt ${salt.slice(0, 8)}…, digest ${hash.slice(0, 8)}…)`);
if (hint) console.log(`  ✓ hint: ${hint}`);
console.log("  → the password itself was not written anywhere");
console.log("  → deploy again (vercel --prod) for it to take effect\n");
