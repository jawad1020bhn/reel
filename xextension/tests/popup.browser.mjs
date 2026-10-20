/* Popup UI regressions with a fake Chrome API, synthetic counts and NO X access.
 * IMPECCABLE_BROWSER=/path/to/chrome node --test xextension/tests/popup.browser.mjs */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import axe from "axe-core";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const SHOTS = resolve(ROOT, "../.audit/extension");
let server, browser, origin;
before(async () => {
  await mkdir(SHOTS, { recursive: true });
  server = createServer(async (req, res) => {
    const path = resolve(ROOT, "." + new URL(req.url, "http://test").pathname);
    if (!path.startsWith(ROOT + sep)) { res.statusCode = 403; res.end(); return; }
    try {
      res.setHeader("Content-Type", ({ ".html": "text/html", ".css": "text/css", ".js": "application/javascript" })[extname(path)] || "application/octet-stream");
      res.end(await readFile(path));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise((done) => server.listen(0, "0.0.0.0", done));
  origin = `http://localhost:${server.address().port}`;
  assert.ok(process.env.IMPECCABLE_BROWSER, "Set IMPECCABLE_BROWSER to Chrome/Chromium");
  browser = await puppeteer.launch({ executablePath: process.env.IMPECCABLE_BROWSER, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
});
after(async () => { await browser?.close(); if (server) await new Promise((done) => server.close(done)); });
async function popup(t, height = 720, dark = false, width = 420) {
  const page = await browser.newPage(); t.after(() => page.isClosed() ? undefined : page.close());
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], "no popup runtime errors"));
  await page.evaluateOnNewDocument((dark) => {
    const values = { bmPopupTheme: dark ? "dark" : "light" }, changed = [], runtime = [];
    window.commands = [];
    const emit = (key, value) => { const oldValue = values[key]; values[key] = value; changed.forEach((fn) => fn({ [key]: { oldValue, newValue: value } }, "local")); };
    window.chrome = {
      storage: { local: {
        async get(keys) {
          if (typeof keys === "string") return { [keys]: values[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, values[key]]));
          return { ...keys, ...Object.fromEntries(Object.keys(keys || values).filter((key) => key in values).map((key) => [key, values[key]])) };
        }, async set(patch) { for (const [key, value] of Object.entries(patch)) emit(key, value); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) { delete values[key]; changed.forEach((fn) => fn({ [key]: { newValue: undefined } }, "local")); } },
      }, onChanged: { addListener: (fn) => changed.push(fn) } },
      runtime: { getManifest: () => ({ version: "1.4.0" }), sendMessage: async () => {}, onMessage: { addListener: (fn) => runtime.push(fn) } },
      tabs: { query: async () => [{ id: 7, url: "https://x.com/i/bookmarks" }], sendMessage: async (_tab, msg) => {
        window.commands.push(msg.type);
        const status = { "unsave-start": "running", "unsave-pause": "paused", "unsave-stop": "stopped_by_user" }[msg.type];
        if (status) emit("xUnsaveState", { status, updatedAt: new Date().toISOString(), stats: { pending: 123, unsaved: 17, failed: 0, perMin: 19 } });
        if (msg.type === "unsave-reset") emit("xUnsaveState", null);
        return { ok: true };
      } }, downloads: { download: async () => 1 },
    };
    window.updateUnsave = (state) => emit("xUnsaveState", state);
  }, dark);
  await page.goto(origin + "/popup.html");
  await page.waitForFunction(() => document.querySelector("#logPreview").textContent.includes("Side panel ready"));
  return page;
}

test("four accessible tabs and a taller scrolling Unsave panel fit both preferred and Chrome-capped heights", async (t) => {
  for (const height of [720, 600]) {
    const page = await popup(t, height, height === 600);
    assert.equal(await page.$$eval('[role="tab"]', (els) => els.length), 4);
    await page.click("#tabUnsave");
    assert.equal(await page.$eval("#panelUnsave", (el) => el.hidden), false);
    const metrics = await page.evaluate(() => {
      const body = document.querySelector("#popupBody");
      return { scrollable: body.scrollHeight > body.clientHeight, overflow: document.documentElement.scrollWidth > innerWidth, footer: document.querySelector(".popup__foot").getBoundingClientRect().bottom <= innerHeight };
    });
    assert.equal(metrics.scrollable, true, "longer panel scrolls inside the popup");
    assert.equal(metrics.overflow, false, "four tabs do not clip horizontally");
    assert.equal(metrics.footer, true, "footer stays in the capped viewport");
    await page.screenshot({ path: resolve(SHOTS, `unsave-${height}.png`) });
    await page.evaluate(axe.source);
    const results = await page.evaluate(() => window.axe.run("#panelUnsave", { runOnly: { type: "rule", values: ["button-name", "color-contrast", "aria-valid-attr-value"] } }));
    assert.deepEqual(results.violations.map((v) => v.id), []);
    await page.focus("#tabCapture"); await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
    assert.equal(await page.$eval("#tabUnsave", (el) => el.getAttribute("aria-selected")), "true");
    await page.$eval("#popupBody", (el) => { el.scrollTop = el.scrollHeight; });
    await page.screenshot({ path: resolve(SHOTS, `unsave-${height}-scrolled.png`) });
    await page.close();
  }
});

test("side panel reflows across narrow, default and wide widths without horizontal overflow", async (t) => {
  for (const width of [300, 400, 760]) {
    const page = await popup(t, 800, false, width);
    const metrics = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      tabs: document.querySelectorAll('[role="tab"]').length,
      footer: document.querySelector(".popup__foot").getBoundingClientRect().bottom <= innerHeight,
      tabsFit: [...document.querySelectorAll('[role="tab"]')].every((el) => el.scrollWidth <= el.clientWidth + 1),
    }));
    assert.equal(metrics.overflow, false, `no horizontal overflow at ${width}px`);
    assert.equal(metrics.tabs, 4, "four tabs at every width");
    assert.equal(metrics.footer, true, `footer stays visible at ${width}px`);
    assert.equal(metrics.tabsFit, true, `tab labels are not clipped at ${width}px`);
    await page.click("#tabExport");
    const exportScrolls = await page.evaluate(() => { const b = document.querySelector("#popupBody"); return b.scrollHeight > b.clientHeight; });
    assert.equal(exportScrolls, true, `Export tab scrolls inside the panel at ${width}px`);
    await page.screenshot({ path: resolve(SHOTS, `sidepanel-${width}.png`) });
    await page.close();
  }
});

test("Unsave requires confirmation; cancellation sends nothing; pause/stop and live counters work", async (t) => {
  const page = await popup(t);
  await page.click("#tabUnsave"); await page.click("#usStartBtn");
  await page.waitForSelector('#dialog[data-open="true"]');
  assert.match(await page.$eval("#dialogContent", (el) => el.textContent), /every device/);
  await page.screenshot({ path: resolve(SHOTS, "unsave-confirm.png") });
  await page.click('#dialog [data-act="cancel"]');
  assert.deepEqual(await page.evaluate(() => window.commands), []);
  await page.click("#usStartBtn");
  await page.waitForSelector('#dialog[data-open="true"]', { visible: true });
  await page.waitForFunction(() => getComputedStyle(document.querySelector("#dialog")).opacity === "1");
  await page.click('#dialog [data-act="ok"]');
  await page.waitForFunction(() => document.querySelector("#usStartBtn").disabled);
  await page.waitForFunction(() => document.querySelector("#usDone").textContent === "17");
  assert.deepEqual(await page.evaluate(() => window.commands), ["unsave-start"]);
  assert.equal(await page.$eval("#unsaveDot", (el) => el.hidden), false);
  await page.click("#usPauseBtn");
  await page.waitForFunction(() => document.querySelector("#usStartLabel").textContent === "Resume unsaving");
  await page.click("#usStartBtn");
  await page.waitForSelector('#dialog[data-open="true"]', { visible: true });
  await page.waitForFunction(() => getComputedStyle(document.querySelector("#dialog")).opacity === "1");
  await page.click('#dialog [data-act="ok"]');
  await page.waitForFunction(() => !document.querySelector("#usStopBtn").disabled);
  await page.click("#usStopBtn");
  await page.waitForFunction(() => document.querySelector("#unsaveStatus").dataset.status === "stopped_by_user");
  assert.deepEqual(await page.evaluate(() => window.commands), ["unsave-start", "unsave-pause", "unsave-start", "unsave-stop"]);
});
