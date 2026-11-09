/* Every `XR.define(name, [deps], factory)` must take exactly as many parameters as it
   declares dependencies. The kernel injects positionally, so a module that gains a
   dependency without gaining a parameter does not fail loudly: every argument silently
   shifts by one and the bug surfaces far away, as "prefs.get is not a function" or a
   mis-bound port. This test is the cheap guard against that. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const files = execSync("git ls-files 'src/**/*.js' 'data/*.js'", { cwd: new URL("..", import.meta.url) })
  .toString().trim().split("\n").filter(Boolean);

/** Split a comma-separated parameter/dependency list, ignoring commas inside strings. */
function splitList(text) {
  const out = [];
  let depth = 0, quote = null, cell = "";
  for (const ch of text) {
    if (quote) { cell += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; cell += ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { out.push(cell.trim()); cell = ""; continue; }
    cell += ch;
  }
  if (cell.trim()) out.push(cell.trim());
  return out.filter(Boolean);
}

function defines(source) {
  const found = [];
  const re = /XR\.define\(\s*"([^"]+)"\s*,\s*\[([\s\S]*?)\]\s*,\s*(?:function\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*\(([\s\S]*?)\)\s*\{|\(([\s\S]*?)\)\s*=>|([A-Za-z_$][\w$]*)\s*=>)/g;
  let m;
  while ((m = re.exec(source))) {
    const params = m[3] ?? m[4] ?? m[5] ?? "";
    found.push({ name: m[1], deps: splitList(m[2]), params: splitList(params), arrow: m[5] !== undefined });
  }
  return found;
}

test("every XR.define factory declares one parameter per dependency", () => {
  const problems = [];
  let checked = 0;
  for (const file of files) {
    for (const d of defines(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"))) {
      checked++;
      if (d.deps.length !== d.params.length) {
        problems.push(`${file} :: ${d.name} — ${d.deps.length} deps but ${d.params.length} parameters (${d.params.join(", ") || "none"})`);
      }
    }
  }
  assert.ok(checked > 40, `expected to check the whole app, only saw ${checked} defines`);
  /* guard against the regex silently matching nothing */
  assert.ok(checked >= 55, `only ${checked} defines found — did the XR.define shape change?`);
  assert.deepEqual(problems, [], `dependency/parameter count mismatch:\n${problems.join("\n")}`);
});

test("no factory names the same parameter twice", () => {
  const problems = [];
  for (const file of files) {
    for (const d of defines(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"))) {
      const seen = new Set();
      for (const p of d.params) {
        if (p.startsWith("{") || p.startsWith("[")) continue; // destructuring: not comparable here
        const name = p.split("=")[0].trim();
        if (!name) continue;
        if (seen.has(name)) problems.push(`${file} :: ${d.name} — "${name}" twice`);
        seen.add(name);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});
