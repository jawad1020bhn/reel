/* Real-browser regression checks. Dev-only: npm ci; set IMPECCABLE_BROWSER to
 * Chrome/Chromium, then npm run test:ui. Uses real synthetic video bytes and
 * CDP touch input, not mocked HTMLMediaElement methods. No user library is read. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import axe from "axe-core";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const SHOTS = resolve(ROOT, ".audit/tests");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const poster = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#26394b"/><path d="M0 300L240 100l200 200 120-160 80 160" fill="#3b5663"/><text x="32" y="54" fill="#fff" font-family="sans-serif" font-size="24">XReels test media</text></svg>');
const media = (kind = "video") => ({ kind, thumb: poster, poster, width: 640, height: 360, duration: kind === "photo" ? 0 : 32, sources: kind === "photo" ? [] : [{ url: "/__fixtures/clip.webm", type: "video/webm" }] });
function dataset() {
  const now = Date.now();
  const posts = Array.from({ length: 12 }, (_, i) => ({
    id: `clip-${i + 1}`, text: i === 0 ? "A deliberately long headline to check the mobile cinema layout at every size" : `Test clip ${i + 1}. A caption with enough words to exercise wrapping and metadata.`,
    createdAt: now - i * 86400000, savedAt: now - i * 86400000, order: i,
    author: { username: `test_creator_${i + 1}`, name: `Test Creator ${i + 1}` }, metrics: { likes: 100 + i },
    media: [media(i % 4 === 3 ? "photo" : "video")], flags: {}, hashtags: ["test"],
  }));
  posts.push({ ...posts[1], id: "mixed", media: [media("photo"), media(), media("photo")] });
  posts.push({ ...posts[2], id: "broken", media: [{ ...media(), sources: [{ url: "/__fixtures/missing.webm", type: "video/webm" }] }] });
  return { export_version: "xreels-1", posts };
}
const DATA = dataset();
let server, browser, origin;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".webm": "video/webm" };
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    try {
      if (pathname === "/data/posts.js") {
        res.setHeader("Content-Type", "application/javascript");
        return res.end(`window.XREELS_DATA = ${JSON.stringify(DATA)};`);
      }
      if (pathname === "/site.config.js") {
        res.setHeader("Content-Type", "application/javascript");
        return res.end("window.XREELS_SITE = {};");
      }
      // Never serve the real private library through the test server.
      if (pathname.startsWith("/data/")) { res.statusCode = 404; return res.end(); }
      const path = resolve(ROOT, pathname === "/__fixtures/clip.webm" ? "tests/fixtures/clip.webm" : "." + decodeURIComponent(pathname === "/" ? "/index.html" : pathname));
      if (!path.startsWith(ROOT + sep) && path !== ROOT) { res.statusCode = 403; return res.end(); }
      const body = await readFile(path);
      res.setHeader("Content-Type", mime[extname(path)] || "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) {
        const start = Number(range[1]), end = Math.min(body.length - 1, range[2] ? Number(range[2]) : body.length - 1);
        res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${body.length}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
        return res.end(body.subarray(start, end + 1));
      }
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise((done) => server.listen(0, "0.0.0.0", done));
  origin = `http://localhost:${server.address().port}`;
  const executablePath = process.env.IMPECCABLE_BROWSER || process.env.CHROME_PATH || [
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find(existsSync);
  assert.ok(executablePath, "Set IMPECCABLE_BROWSER=/path/to/chrome; puppeteer-core does not download a browser.");
  browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--mute-audio", "--autoplay-policy=no-user-gesture-required"] });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
});

async function pageFor(t, width = 390, height = 844, touch = true) {
  const context = await browser.createBrowserContext();
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (/\[(?:outlet|bus)\].*(?:failed|crashed)/.test(message.text())) errors.push(message.text()); });
  t.after(() => assert.deepEqual(errors, [], "no runtime or mount errors"));
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch });
  // Reduced motion keeps multi-route layout checks deterministic; the separate
  // gesture test below runs with the normal motion preference as well.
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  return page;
}
async function open(page, route) {
  const response = await page.goto(`${origin}/index.html#/${route}`, { waitUntil: "load" });
  if (response) assert.equal(response.status(), 200, "test server serves the app");
  await page.waitForSelector(`.outlet[data-feature="${route.split("?")[0]}"] > :not(.feature-loading)`);
  await page.waitForFunction(() => !document.querySelector(".splash"));
  await page.evaluate(() => document.fonts.ready);
}
async function tap(page, selector) {
  const el = await page.waitForSelector(selector, { visible: true });
  const r = await el.boundingBox();
  assert.ok(r && r.width && r.height, `visible target: ${selector}`);
  await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
}
async function menuItem(page, label) {
  const menu = await page.waitForSelector(".menu.in");
  await menu.evaluate(async (el) => { await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {}))); });
  const handle = await page.evaluateHandle((text) => [...document.querySelectorAll(".menu-item")].find((el) => el.querySelector(".menu-label")?.textContent === text), label);
  const r = await handle.asElement()?.boundingBox();
  assert.ok(r, `menu item: ${label}`);
  const atPoint = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".menu-item")?.querySelector(".menu-label")?.textContent, { x: r.x + r.width / 2, y: r.y + r.height / 2 });
  assert.equal(atPoint, label, "menu item is stable and not obscured");
  await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
}
async function drag(page, from, to, cancel = false) {
  const cdp = await page.createCDPSession();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8 }] });
    await sleep(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
  await cdp.detach();
}
const state = (page) => page.evaluate(() => {
  const v = document.querySelector(".cell.is-active video");
  return { time: v?.currentTime, paused: v?.paused, muted: v?.muted, rate: v?.playbackRate, id: document.querySelector(".cell.is-active")?.dataset.id };
});
async function readyVideo(page) {
  await page.waitForFunction(() => { const v = document.querySelector(".cell.is-active video"); return v && v.readyState >= 2 && !v.paused; });
}

// Layout is measured on rendered screens. Scroll tracks and blurred media
// backdrops are intentional overflow; assert the actual page scrollers instead.
test("responsive chrome and compact hero at phone, tablet, landscape and desktop widths", { timeout: 120000 }, async (t) => {
  const viewports = [[320, 568], [360, 800], [390, 844], [768, 1024], [844, 390], [1440, 960]];
  for (const [w, h] of viewports) {
    const page = await pageFor(t, w, h, w < 1000);
    for (const route of ["discover", "library", "settings", "insights", "watch?post=clip-1"]) {
      await open(page, route);
      const result = await page.evaluate(() => {
        const outlet = document.querySelector(".outlet");
        const nav = document.querySelector(".mobile-nav");
        return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, outletWidth: outlet.clientWidth, outletScrollWidth: outlet.scrollWidth,
          navVisible: !!nav.getClientRects().length, activeNav: nav.querySelector("[aria-current=page]")?.dataset.feature,
          heroHeight: document.querySelector(".bb-mobile-card")?.getBoundingClientRect().height || 0,
          shelfY: document.querySelector(".rail")?.getBoundingClientRect().top || 0 };
      });
      assert.ok(result.pageWidth <= w + 1, `${w}/${route}: no document overflow`);
      assert.ok(result.outletScrollWidth <= result.outletWidth + 1, `${w}/${route}: no outlet overflow`);
      assert.equal(result.navVisible, w < 768 && !route.startsWith("watch"), `${w}/${route}: correct nav mode`);
      if (w < 768 && route === "discover") {
        assert.ok(result.heroHeight < h * 0.61, "hero leaves room for browsing");
        assert.ok(result.shelfY < h * 0.88, "first shelf is visible without scrolling");
      }
      if ([390, 844, 1440].includes(w) && ["discover", "library", "watch?post=clip-1"].includes(route)) {
        await page.screenshot({ path: resolve(SHOTS, `${w}x${h}-${route.split("?")[0]}.png`) });
      }
    }
    await page.close();
  }
});

test("bottom navigation, More pages, search and Back work with touch", async (t) => {
  const page = await pageFor(t);
  await open(page, "discover");
  await tap(page, '.mobile-nav-link[data-feature="library"]');
  await page.waitForSelector('.outlet[data-feature="library"] .lib-grid');
  assert.equal(await page.$eval('.mobile-nav-link[aria-current="page"]', (el) => el.dataset.feature), "library");
  await tap(page, ".hdr-search-btn");
  await page.waitForFunction(() => document.activeElement?.classList.contains("hdr-search-input"));
  await page.type(".hdr-search-input", "Test clip");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash.includes("q=Test"));
  assert.equal(await page.$eval(".hdr-search", (el) => el.hidden), true);
  await tap(page, ".mobile-nav-more");
  await menuItem(page, "Creators");
  await page.waitForSelector('.outlet[data-feature="creators"] .creators');
  assert.equal(await page.$eval(".mobile-nav-more", (el) => el.classList.contains("is-active")), true);
  await tap(page, '.mobile-nav-link[data-feature="watch"]');
  await page.waitForSelector(".watch");
  await tap(page, ".watch-back");
  await page.waitForSelector('.outlet[data-feature="creators"]');
});

test("native seek, double-tap, play/pause, speed and unmute operate on real video", { timeout: 30000 }, async (t) => {
  const page = await pageFor(t);
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  await open(page, "watch?post=clip-1");
  await readyVideo(page);
  await tap(page, ".cell.is-active .cell-play");
  await page.waitForFunction(() => document.querySelector(".cell.is-active video").paused);
  const r = await (await page.$(".cell.is-active .cell-seek")).boundingBox();
  assert.ok(r.height >= 44, "native slider has a real 44px target");
  await drag(page, { x: r.x + 7, y: r.y + r.height / 2 }, { x: r.x + r.width * 0.72, y: r.y + r.height / 2 });
  await page.waitForFunction(() => document.querySelector(".cell.is-active video").currentTime > 19);
  const sought = (await state(page)).time;
  await page.touchscreen.tap(90, 320); await sleep(70); await page.touchscreen.tap(90, 320);
  await sleep(100);
  assert.ok(Math.abs((await state(page)).time - (sought - 10)) < 0.7, "double-tap left seeks back ten seconds");
  const left = (await state(page)).time;
  await page.touchscreen.tap(290, 320); await sleep(70); await page.touchscreen.tap(290, 320);
  await sleep(100);
  assert.ok(Math.abs((await state(page)).time - (left + 10)) < 0.7, "double-tap right seeks forward ten seconds");
  await page.touchscreen.tap(195, 320); await sleep(70); await page.touchscreen.tap(195, 320);
  assert.equal(await page.evaluate(() => XR.resolve("app.activity").isStarred("clip-1")), true, "centre double-tap still stars");
  await tap(page, ".cell.is-active .cell-speed");
  await menuItem(page, "1.5×");
  assert.equal((await state(page)).rate, 1.5);
  await tap(page, ".cell.is-active .cell-play");
  await readyVideo(page);
  await tap(page, ".cell.is-active .cell-unmute.on");
  assert.equal((await state(page)).muted, false);
  await tap(page, ".watch-options");
  await page.waitForSelector(".menu.in");
  const labels = await page.$$eval(".menu-label", (els) => els.map((el) => el.textContent));
  assert.ok(labels.includes("Fit / fill") && labels.includes("Picture-in-picture"), "phone retains player features");
});

test("carousel horizontal drag and feed vertical swipe do not steal each other's axis", async (t) => {
  const page = await pageFor(t);
  await open(page, "watch?post=mixed");
  assert.equal(await page.$eval(".cell.is-active .cell-bar", (el) => el.hidden), true, "photo has no video bar");
  await drag(page, { x: 305, y: 340 }, { x: 65, y: 342 });
  await page.waitForFunction(() => document.querySelector(".cell.is-active .carousel-counter")?.textContent === "2 / 3");
  await readyVideo(page);
  assert.equal(await page.$eval(".cell.is-active .cell-bar", (el) => el.hidden), false, "video after a photo gains controls");
  await drag(page, { x: 190, y: 520 }, { x: 192, y: 230 });
  await page.waitForFunction(() => document.querySelector(".cell.is-active")?.dataset.id !== "mixed");
});

test("seek cancellation and leaving during a hold clean up gesture state", async (t) => {
  const page = await pageFor(t);
  await open(page, "watch?post=clip-1"); await readyVideo(page);
  const r = await (await page.$(".cell.is-active .cell-seek")).boundingBox();
  await drag(page, { x: r.x + 7, y: r.y + r.height / 2 }, { x: r.x + r.width / 2, y: r.y + r.height / 2 }, true);
  assert.equal(await page.$eval(".cell.is-active", (el) => el.classList.contains("is-scrubbing")), false);
  const cdp = await page.createCDPSession();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 190, y: 320 }] });
  await sleep(500);
  assert.equal((await state(page)).rate, 2, "hold temporarily boosts speed");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  assert.equal((await state(page)).rate, 1, "release restores the chosen speed");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 190, y: 320 }] });
  await page.evaluate(() => XR.resolve("app.nav").go("library"));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await cdp.detach(); await sleep(550);
  await page.waitForSelector(".library");
});

test("recovery card stays inside short screens; manual Next works with auto-advance off", async (t) => {
  for (const [w, h] of [[320, 568], [844, 390]]) {
    const page = await pageFor(t, w, h);
    await open(page, "watch?post=broken");
    await page.waitForSelector(".cell.is-active.is-unplayable");
    assert.equal(await page.$$eval(".cell:not(.is-active)", (els) => els.every((el) => el.inert)), true, "offscreen cells including the end card cannot steal keyboard focus");
    const r = await (await page.$(".cell.is-active .cell-unplayable")).boundingBox();
    assert.ok(r.x >= 0 && r.x + r.width <= w && r.y >= 0 && r.y + r.height <= h, "recovery card fits");
    await page.evaluate(() => { window.failedCell = document.querySelector(".cell.is-active"); });
    const retry = await page.evaluateHandle(() => [...document.querySelectorAll(".cell.is-active .cell-unplayable .btn")].find((b) => b.textContent.trim() === "Retry"));
    const rr = await retry.asElement().boundingBox();
    await page.touchscreen.tap(rr.x + rr.width / 2, rr.y + rr.height / 2);
    await page.waitForFunction(() => document.querySelector(".cell.is-active") !== window.failedCell);
    await page.waitForSelector(".cell.is-active.is-unplayable");
    const nextButton = await page.evaluateHandle(() => [...document.querySelectorAll(".cell.is-active .cell-unplayable .btn")].find((b) => b.textContent.trim() === "Next"));
    await page.evaluate(() => XR.resolve("app.prefs").set({ autoAdvance: false }));
    const nr = await nextButton.asElement().boundingBox();
    await page.touchscreen.tap(nr.x + nr.width / 2, nr.y + nr.height / 2);
    await page.waitForFunction(() => document.querySelector(".cell.is-active")?.dataset.id !== "broken");
    await page.close();
  }
});

test("viewer native slider supports touch and keyboard seeking without changing the post", async (t) => {
  const page = await pageFor(t);
  await open(page, "library");
  await page.evaluate(async () => { await XR.resolve("app.features").load("viewer"); XR.resolve("app.actions").view(["clip-1", "clip-2"]); });
  await page.waitForFunction(() => { const v = document.querySelector(".viewer video"); return v?.readyState >= 2; });
  await tap(page, ".viewer-ctrl-play");
  const r = await (await page.$(".viewer-seek")).boundingBox();
  assert.ok(r.height >= 44 && r.width > 200, "viewer gives seeking its own full-width row");
  await drag(page, { x: r.x + 7, y: r.y + r.height / 2 }, { x: r.x + r.width * 0.6, y: r.y + r.height / 2 });
  const before = await page.$eval(".viewer video", (v) => v.currentTime);
  assert.ok(before > 15, "touch drag seeks real video");
  await page.focus(".viewer-seek"); await page.keyboard.press("ArrowRight");
  const after = await page.$eval(".viewer video", (v) => v.currentTime);
  assert.ok(Math.abs(after - before - 5) < 0.5, "range keyboard handler seeks five seconds instead of navigating posts");
  assert.match(await page.$eval(".viewer-pos", (el) => el.textContent), /1/);
  await page.screenshot({ path: resolve(SHOTS, "390x844-viewer.png") });
});

test("new navigation and player controls pass named accessibility rules", async (t) => {
  const page = await pageFor(t);
  const violations = [];
  for (const route of ["discover", "library", "watch?post=clip-1"]) {
    await open(page, route);
    await page.evaluate(axe.source);
    const results = await page.evaluate(async () => window.axe.run({ include: [document.querySelector(".watch") ? ".cell.is-active" : document.querySelector(".library") ? ".lib-grid" : ".mobile-nav", ...(document.querySelector(".bb-mobile") ? [".bb-mobile"] : [])] }, {
      runOnly: { type: "rule", values: ["button-name", "label", "aria-input-field-name", "aria-valid-attr-value", "aria-allowed-attr", "nested-interactive"] },
    }));
    violations.push(...results.violations.map((v) => ({ route, rule: v.id, nodes: v.nodes.map((n) => n.target) })));
  }
  assert.deepEqual(violations, []);
});

test("file URL still boots and plays the local fixture with the original CSP", async (t) => {
  const page = await pageFor(t);
  const fileData = dataset();
  const clip = await readFile(resolve(ROOT, "tests/fixtures/clip.webm"));
  for (const post of fileData.posts) for (const m of post.media) for (const source of m.sources || []) source.url = "data:video/webm;base64," + clip.toString("base64");
  await page.evaluateOnNewDocument((data) => { window.XREELS_DATA = data; }, fileData);
  await page.goto(pathToFileURL(resolve(ROOT, "index.html")).href + "#/watch?post=clip-1", { waitUntil: "load" });
  await page.waitForSelector(".watch"); await readyVideo(page);
  assert.equal(await page.$eval('meta[http-equiv="Content-Security-Policy"]', (el) => el.content.includes("script-src 'self' file:")), true);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.file), "on");
});


test("desktop tile metadata reveals for keyboard focus without nested buttons or double opening", async (t) => {
  const page = await pageFor(t, 1440, 960, false);
  await open(page, "library");
  assert.equal(await page.$eval(".tile-info", (el) => el.inert), true);
  await page.focus(".tile-open");
  assert.equal(await page.$eval(".tile-info", (el) => el.inert), false);
  assert.equal(await page.$eval(".tile-info", (el) => el.getAttribute("aria-hidden")), "false");
  await page.evaluate(() => XR.resolve("app.features").load("viewer"));
  await page.evaluate(() => {
    window.tileOpens = 0;
    const bus = XR.resolve("core.events").bus;
    bus.on("route:changed", () => window.tileOpens++);
    bus.on("viewer:open", () => window.tileOpens++);
  });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".watch, .viewer"));
  assert.equal(await page.evaluate(() => window.tileOpens), 1, "native tile button activates exactly once");
});

test("reduced-motion seeking still gives visible feedback and idle tap only reveals controls", async (t) => {
  const page = await pageFor(t);
  await open(page, "watch?post=clip-1"); await readyVideo(page);
  await page.touchscreen.tap(90, 320); await sleep(70); await page.touchscreen.tap(90, 320);
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".watch-seekflash")).opacity) > 0.95);
  assert.equal(await page.$eval(".watch-seekflash", (el) => el.classList.contains("pop")), true);
  assert.equal(await page.$eval(".watch-seekflash", (el) => getComputedStyle(el).animationName), "none");
  await page.waitForFunction(() => !document.querySelector(".watch-seekflash").classList.contains("pop"));
  await page.waitForSelector(".watch.is-idle");
  await page.touchscreen.tap(195, 320); await sleep(320);
  assert.equal((await state(page)).paused, false, "first idle tap does not unexpectedly pause playback");
  assert.equal(await page.$eval(".watch", (el) => el.classList.contains("is-idle")), false);
});
