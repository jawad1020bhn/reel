/* Dev-only rendered audit: npm ci, then set IMPECCABLE_BROWSER and run with a
 * served app. Screenshots are layout evidence, not gesture evidence. Real touch
 * gestures and real synthetic video are covered by tests/ui.test.mjs instead.
 * No user data or generated screenshots should be committed. */
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const OUT = process.argv[2] || ".audit/screenshots";
const BASE = process.env.AUDIT_URL || `http://localhost:${process.env.PORT || "8899"}/index.html`;
const VIEWPORTS = [[320, 568], [360, 800], [390, 844], [768, 1024], [844, 390], [1440, 960]];
const ROUTES = (process.env.AUDIT_ROUTES || "discover library watch settings insights").split(/\s+/);
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.IMPECCABLE_BROWSER || process.env.CHROME_PATH,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars", "--mute-audio"],
});
const report = [];
try {
  for (const [w, h] of VIEWPORTS) for (const route of ROUTES) {
    const page = await browser.newPage();
    const runtimeErrors = [];
    page.on("pageerror", (e) => runtimeErrors.push(e.message));
    page.on("console", (msg) => { if (/\[(?:outlet|bus)\].*(?:failed|crashed)/.test(msg.text())) runtimeErrors.push(msg.text()); });
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: w < 1000, hasTouch: w < 1000 });
    const item = { viewport: `${w}x${h}`, route, runtimeErrors };
    try {
      await page.goto(`${BASE}#/${route}`, { waitUntil: "load", timeout: 30000 });
      await page.waitForSelector(`.outlet[data-feature="${route}"] > :not(.feature-loading)`, { timeout: 15000 });
      await page.waitForFunction(() => !document.querySelector(".splash"), { timeout: 15000 });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `${OUT}/${w}x${h}-${route}.png` });
      Object.assign(item, await page.evaluate(() => {
        const out = { smallTargets: [], denseChartMarks: 0, missingNames: [], skippedHeadings: [] };
        const visible = (el, inViewport = true) => {
          if (el.closest('[inert], [aria-hidden="true"]') || !el.getClientRects().length) return false;
          let r = el.getBoundingClientRect();
          if (!r.width || !r.height || (inViewport && (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth))) return false;
          for (let a = el; a; a = a.parentElement) {
            const s = getComputedStyle(a);
            if (s.display === "none" || s.visibility === "hidden" || +s.opacity <= 0.01) return false;
            if (a !== el && inViewport) {
              const ar = a.getBoundingClientRect();
              if (/(hidden|clip|scroll|auto)/.test(s.overflowX) && (r.right <= ar.left || r.left >= ar.right)) return false;
              if (/(hidden|clip|scroll|auto)/.test(s.overflowY) && (r.bottom <= ar.top || r.top >= ar.bottom)) return false;
            }
          }
          return true;
        };
        const selector = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "." + (el.getAttribute("class") || "").trim().replace(/\s+/g, "."));
        for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])')) {
          if (!visible(el) || el.matches(":disabled")) continue;
          const r = el.getBoundingClientRect();
          let width = r.width, height = r.height;
          // A transparent pseudo-element can enlarge the real hit area of a
          // small icon. Count it, but retain the drawn dimensions as evidence.
          const hit = getComputedStyle(el, "::after");
          if (hit.content !== "none" && hit.content !== "normal" && hit.position === "absolute") {
            const inset = (v) => Number.isFinite(parseFloat(v)) ? Math.min(0, parseFloat(v)) : 0;
            width -= inset(hit.left) + inset(hit.right); height -= inset(hit.top) + inset(hit.bottom);
          }
          if (width < 43.9 || height < 43.9) {
            if (el.matches(".cal-cell, .bar")) out.denseChartMarks++;
            else out.smallTargets.push({ selector: selector(el), drawn: [Math.round(r.width), Math.round(r.height)], hit: [Math.round(width), Math.round(height)] });
          }
          const name = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title") || el.textContent.trim() || (el.labels && [...el.labels].some((l) => l.textContent.trim()));
          if (!name) out.missingNames.push(selector(el));
        }
        const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter((el) => visible(el, false));
        for (let i = 1; i < headings.length; i++) if (+headings[i].tagName[1] > +headings[i - 1].tagName[1] + 1) out.skippedHeadings.push([headings[i - 1].textContent.slice(0, 40), headings[i].textContent.slice(0, 40)]);
        const outlet = document.querySelector(".outlet");
        out.horizontalOverflow = { document: document.documentElement.scrollWidth > innerWidth + 1, outlet: outlet.scrollWidth > outlet.clientWidth + 1 };
        out.unavailableMedia = document.querySelectorAll(".tile-broken, .is-unplayable, img.is-broken").length;
        return out;
      }));
    } catch (e) { item.error = e.message; }
    report.push(item);
    console.log(`${item.viewport}/${route}: ${item.error ? "ERROR " + item.error : `tap<44=${item.smallTargets.length} dense-chart-marks=${item.denseChartMarks} heading-skips=${item.skippedHeadings.length} unnamed=${item.missingNames.length} runtime-errors=${runtimeErrors.length}`}`);
    await page.close();
  }
} finally { await browser.close(); }
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2) + "\n");
console.log(`Saved ${OUT}/report.json and screenshots. Touch emulation is Chromium, not physical iOS/Android validation.`);
if (report.some((r) => r.error || r.runtimeErrors.length)) process.exitCode = 1;
