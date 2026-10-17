#!/usr/bin/env node
/* tools/lint-deps.mjs — architecture guard (docs/ARCHITECTURE.md §3 "allowed dependencies").
   Parses every XR.define(name, [deps], …) in src/ and checks that each dependency edge
   respects the layer rules, that features never import each other, and that every file
   referenced by src/manifest.js exists (and vice-versa). Zero dependencies; runs with
   `npm run lint` or `node tools/lint-deps.mjs`. Exit code 1 on violations. */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/* layer of a module name → prefix */
const layerOf = (name) => {
  if (name.startsWith("core.")) return "core";
  if (name.startsWith("app.ports")) return "ports";
  if (name.startsWith("app.")) return "app";
  if (name.startsWith("infra.")) return "infra";
  if (name.startsWith("ui.")) return "ui";
  if (name.startsWith("shell.")) return "shell";
  if (name.startsWith("features.")) return "features";
  if (name.startsWith("tests.")) return "tests";
  return "unknown";
};
/* who may depend on whom */
const ALLOWED = {
  core: ["core"],
  ports: ["core", "ports"],
  app: ["core", "ports", "app"],
  infra: ["core", "ports", "infra"],          // infra implements ports; never touches app services or ui
  ui: ["core", "ports", "app", "ui"],         // ui may read app services (prefs, activity) but never shell/features
  shell: ["core", "ports", "app", "ui", "shell"],
  features: ["core", "ports", "app", "ui", "features"], // features.x may only depend on features.x.* (own sub-modules)
  tests: ["core", "ports", "app", "infra", "ui", "shell", "features", "tests"],
};

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}
const DEFINE_RE = /XR\.define\(\s*"([^"]+)"\s*,\s*\[([^\]]*)\]/g;
const files = walk(SRC);
const modules = new Map();   // name → { file, deps }
const problems = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const rel = relative(ROOT, file);
  for (const m of text.matchAll(DEFINE_RE)) {
    const name = m[1];
    const deps = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    if (modules.has(name)) problems.push(`${rel}: module "${name}" defined twice (also in ${modules.get(name).file})`);
    modules.set(name, { file: rel, deps });
    /* file location must match the layer prefix */
    const layer = layerOf(name);
    const dirRule = { core: "src/core/", ports: "src/application/", app: "src/application/", infra: "src/infrastructure/", ui: "src/ui/", shell: "src/shell/", features: "src/features/" }[layer];
    if (dirRule && !rel.replace(/\\/g, "/").startsWith(dirRule)) problems.push(`${rel}: "${name}" should live under ${dirRule}`);
    if (layer === "unknown") problems.push(`${rel}: "${name}" has no known layer prefix`);
  }
}
/* ports are bound (XR.bind) in src/boot.js, not defined — collect them and check their targets are infra */
const bootText = readFileSync(join(ROOT, "src/boot.js"), "utf8");
const ports = new Map([...bootText.matchAll(/XR\.bind\(\s*"([^"]+)"\s*,\s*([^)]+)\)/g)].map((m) => [m[1], m[2]]));
for (const [port, target] of ports) {
  for (const impl of [...target.matchAll(/"([^"]+)"/g)].map((x) => x[1])) {
    if (!modules.has(impl)) problems.push(`boot.js: port "${port}" bound to undefined module "${impl}"`);
    else if (layerOf(impl) !== "infra") problems.push(`boot.js: port "${port}" must be bound to an infrastructure module, got "${impl}"`);
  }
}
/* edges */
for (const [name, { file, deps }] of modules) {
  const from = layerOf(name);
  for (const dep of deps) {
    const to = layerOf(dep);
    if (!modules.has(dep) && !ports.has(dep) && !dep.startsWith("tests.")) problems.push(`${file}: "${name}" depends on undefined module "${dep}"`);
    if (!(ALLOWED[from] || []).includes(to)) problems.push(`${file}: ${from} module "${name}" must not depend on ${to} module "${dep}"`);
    if (from === "features" && to === "features") {
      const a = name.split(".").slice(0, 2).join("."), b = dep.split(".").slice(0, 2).join(".");
      if (a !== b) problems.push(`${file}: feature "${name}" must not import another feature "${dep}" — talk through events or app services`);
    }
  }
}
/* manifest ↔ files */
const manifestText = readFileSync(join(ROOT, "src/manifest.js"), "utf8");
const listed = [...manifestText.matchAll(/"((?:src|vendor|data|styles)\/[^"]+)"/g)].map((m) => m[1]);
for (const p of listed) if (!existsSync(join(ROOT, p)) && !p.startsWith("data/")) problems.push(`manifest: listed file missing on disk: ${p}`);
for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  if (rel === "src/manifest.js" || rel.startsWith("src/kernel/") || rel === "src/boot.js") continue;
  if (!listed.includes(rel)) problems.push(`manifest: ${rel} exists but is not registered in src/manifest.js (it will never load)`);
}
/* report */
const byLayer = {};
for (const name of modules.keys()) byLayer[layerOf(name)] = (byLayer[layerOf(name)] || 0) + 1;
console.log(`lint-deps: ${modules.size} modules, ${ports.size} ports (${Object.entries(byLayer).map(([k, v]) => `${k} ${v}`).join(", ")})`);
if (problems.length) { for (const p of problems) console.log("  ✖ " + p); console.log(`${problems.length} violation(s)`); process.exit(1); }
console.log("  ✓ all dependency edges respect the layer rules; features are isolated; manifest is complete");
