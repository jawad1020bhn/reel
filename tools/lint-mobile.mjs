#!/usr/bin/env node
/* tools/lint-mobile.mjs — static guards for the mobile contract (MOBILE.md).
   No browser, no dependencies. Runs after lint-deps via `npm run check`.
   These do not prove the behaviour — they stop the specific regressions that
   made the mobile audit necessary from creeping back into the stylesheet. */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };

/* Split a stylesheet into { selectors: string[], decls: string } rules. Good
   enough for flat declaration blocks (the ones these guards care about). */
function rules(css) {
  const out = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    /* m[1] can carry an @media header (or its opening brace) from the outer
       block; the actual selector is the text after the last brace. */
    const selectorText = m[1].split("{").pop();
    const selectors = selectorText.split(",").map((s) => s.trim()).filter(Boolean);
    out.push({ selectors, decls: m[2] });
  }
  return out;
}
function rule(css, selector) {
  return rules(css).find((r) => r.selectors.includes(selector)) || null;
}
function every(css, selector, test) {
  return rules(css).some((r) => r.selectors.includes(selector) && test(r.decls));
}
const has = (decls, prop, value) =>
  !!decls && new RegExp(`${prop}\\s*:\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(decls);

const watchCss = read("styles/features/watch.css");
const viewerCss = read("styles/features/viewer.css");
const componentsCss = read("styles/components.css");
const libraryCss = read("styles/features/library.css");
const paletteCss = read("styles/features/palette.css");
const html = read("index.html");
const manifest = read("src/manifest.js");

/* 1 — touch-action ownership (M-01). The surface root may not disarm the
   scrollers inside it; the element that owns the gesture must. */
const watchRoot = rule(watchCss, ".watch");
check(watchRoot && !has(watchRoot.decls, "touch-action", "none"),
  "watch.css: .watch must not use touch-action:none (it kills the info-card scroller)");
check(has(rule(watchCss, ".cell-stage")?.decls, "touch-action", "none"),
  "watch.css: .cell-stage must own touch-action:none");
const viewerRoot = rule(viewerCss, ".viewer");
check(viewerRoot && !has(viewerRoot.decls, "touch-action", "none"),
  "viewer.css: .viewer must not use touch-action:none (it kills the strip and info card)");
check(has(rule(viewerCss, ".viewer-media-box")?.decls, "touch-action", "none"),
  "viewer.css: .viewer-media-box must own touch-action:none");

/* 2 — scrollers keep their axis and containment (M-01, M-07). */
check(has(rule(watchCss, ".watch-info-card")?.decls, "touch-action", "pan-y"),
  "watch.css: .watch-info-card needs touch-action:pan-y");
check(has(rule(viewerCss, ".viewer-info-card")?.decls, "touch-action", "pan-y"),
  "viewer.css: .viewer-info-card needs touch-action:pan-y");
check(has(rule(viewerCss, ".viewer-strip")?.decls, "touch-action", "pan-x"),
  "viewer.css: .viewer-strip needs touch-action:pan-x");
check(every(libraryCss, ".chip-row-body", (d) => /overscroll-behavior-(inline|x):\s*contain/.test(d)),
  "library.css: chip rail needs horizontal overscroll containment");

/* 3 — fields stay 16px / 44px on touch (M-02, M-12). */
const touchFields = rules(componentsCss).find((r) => r.selectors.includes('[data-touch="on"] .input'));
check(has(touchFields?.decls, "font-size", "16px") && has(touchFields?.decls, "min-height", "44px"),
  "components.css: [data-touch] .input/.select need 16px text and 44px height");

/* 4 — measured tap targets (M-12). */
check(has(rule(componentsCss, '[data-touch="on"] .toast-x')?.decls, "width", "44px"),
  "components.css: toast dismiss needs a 44px target under [data-touch]");
check(has(rule(libraryCss, '[data-touch="on"] .lib-more')?.decls, "width", "44px"),
  "library.css: .lib-more needs a 44px target under [data-touch]");
check(!!rule(paletteCss, ".palette-close::after"),
  "palette.css: palette close needs a transparent ::after hit area");

/* 5 — hover is capability-gated, not left to stick after a tap (M-05, M-19). */
const sticky = /(^|\n)\s*(\.tile:hover \.tile-media|\.tile:hover \.tile-play(?: \.icon)?|\.stat-link:hover|\.top-item:hover|\.cal-cell[^{]*:hover)\s*\{/;
check(!sticky.test(componentsCss), "components.css: tile/stat hover must be prefixed with [data-hover=\"on\"]");
check(!sticky.test(read("styles/features/insights.css")),
  "insights.css: row/heatmap hover must be prefixed with [data-hover=\"on\"]");

/* 6 — viewport and installability (M-11, M-16, M-20). */
check(html.includes("interactive-widget=resizes-content"), "index.html: viewport needs interactive-widget=resizes-content");
check(html.includes('rel="manifest"'), "index.html: missing manifest link");
check(html.includes('name="theme-color"'), "index.html: missing theme-color meta");
check(componentsCss.includes("var(--kb-inset"), "components.css: sheets/dialogs must pad by --kb-inset");
check(viewerCss.includes("height: 100vh !important") && !viewerCss.includes("width: 100vw !important"),
  "viewer.css: mobile frame needs the 100vh fallback and must not use 100vw");
const wm = JSON.parse(read("manifest.webmanifest"));
check(wm.display === "standalone", "manifest.webmanifest: display must be standalone");
check(Array.isArray(wm.icons) && wm.icons.length >= 3, "manifest.webmanifest: needs 192/512/maskable icons");
for (const icon of wm.icons || []) check(existsSync(join(ROOT, icon.src)), `manifest.webmanifest: missing ${icon.src}`);

/* 7 — Back closes overlays (M-04). */
check(manifest.includes('"src/ui/overlay-history.js"'), "src/manifest.js: ui.overlayHistory is not loaded");
for (const file of ["src/ui/menu.js", "src/ui/dialog.js", "src/features/palette/index.js"]) {
  check(read(file).includes('"ui.overlayHistory"'), `${file}: missing ui.overlayHistory dependency`);
}

if (problems.length) {
  console.error("lint-mobile: " + problems.length + " problem(s)\n");
  for (const p of problems) console.error("  ✗ " + p);
  process.exit(1);
}
console.log("lint-mobile: mobile contract guards pass (touch-action, scrollers, targets, hover, install, overlays)");
