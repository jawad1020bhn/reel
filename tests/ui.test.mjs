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
const media = (kind = "video", width = 640, height = 360) => ({ kind, thumb: poster, poster, width, height, aspect: width / height, duration: kind === "photo" ? 0 : 32, sources: kind === "photo" ? [] : [{ url: "/__fixtures/clip.webm", type: "video/webm" }] });
function dataset() {
  const now = Date.now();
  const posts = Array.from({ length: 12 }, (_, i) => ({
    id: `clip-${i + 1}`, text: i === 0 ? "A deliberately long headline to check the mobile cinema layout at every size" : `Test clip ${i + 1}. A caption with enough words to exercise wrapping and metadata.`,
    createdAt: now - i * 86400000, savedAt: now - i * 86400000, order: i,
    author: { username: `test_creator_${i + 1}`, name: `Test Creator ${i + 1}` }, metrics: { likes: 100 + i },
    media: [media(i % 4 === 3 ? "photo" : "video")], flags: {}, hashtags: ["test"],
  }));
  posts.push({ ...posts[0], id: "portrait", media: [media("video", 360, 640)] });
  posts.push({ ...posts[1], id: "mixed", media: [media("photo"), media(), media("photo")] });
  posts.push({ ...posts[2], id: "broken", media: [{ ...media(), sources: [{ url: "/__fixtures/missing.webm", type: "video/webm" }] }] });
  return { export_version: "xreels-1", posts };
}
const DATA = dataset();
let server, browser, origin;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".woff2": "font/woff2", ".webm": "video/webm" };
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
      if (pathname === "/data/deleted-posts.js") {
        res.setHeader("Content-Type", "application/javascript");
        return res.end("window.XREELS_DELETED_IDS = [];");
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
      if (route.startsWith("watch")) {
        assert.equal(await page.$(".cell-unmute, .watch-fs, .watch-pip"), null, `${w}px: removed sound prompt, fullscreen and PiP controls`);
        assert.equal(await page.$eval(".cell.is-active video", (video) => video.disablePictureInPicture), true, `${w}px: browser PiP is disabled`);
      }
      const result = await page.evaluate(() => {
        const outlet = document.querySelector(".outlet");
        const nav = document.querySelector(".mobile-nav");
        return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, outletWidth: outlet.clientWidth, outletScrollWidth: outlet.scrollWidth,
          navVisible: !!nav.getClientRects().length, activeNav: nav.querySelector("[aria-current=page]")?.dataset.feature,
          heroHeight: document.querySelector(".bb-mobile-card")?.getBoundingClientRect().height || 0,
          shelfY: document.querySelector(".rail")?.getBoundingClientRect().top || 0,
          dockTop: nav.getBoundingClientRect().top || 0 };
      });
      assert.ok(result.pageWidth <= w + 1, `${w}/${route}: no document overflow`);
      assert.ok(result.outletScrollWidth <= result.outletWidth + 1, `${w}/${route}: no outlet overflow`);
      /* Phones — including phones held in landscape — get the bottom dock. */
      const docked = (w < 768 || (h < 500 && w < 1024)) && !route.startsWith("watch");
      assert.equal(result.navVisible, docked, `${w}/${route}: correct nav mode`);
      if (docked && w < 768 && route === "discover") {
        assert.ok(result.heroHeight < h * 0.61, "hero leaves room for browsing");
        assert.ok(result.shelfY < h * 0.88, "first shelf is visible without scrolling");
      }
      if (docked) {
        /* The dock itself must never cover bulk actions, toasts or page endings. */
        assert.ok(result.dockTop > h * 0.7, `${w}/${route}: dock sits in the thumb zone`);
      }
      if ([390, 844, 1440].includes(w) && ["discover", "library", "watch?post=clip-1"].includes(route)) {
        await page.screenshot({ path: resolve(SHOTS, `${w}x${h}-${route.split("?")[0]}.png`) });
      }
    }
    await page.close();
  }
});

test("phone search is a labelled mode and Escape or Cancel leaves it cleanly", async (t) => {
  const page = await pageFor(t);
  await open(page, "discover");
  await tap(page, ".hdr-search-btn");
  await page.waitForFunction(() => document.activeElement?.classList.contains("hdr-search-input"));
  const mode = await page.evaluate(() => {
    const bar = document.querySelector(".hdr-search").getBoundingClientRect();
    const cancel = document.querySelector(".hdr-search-cancel").getBoundingClientRect();
    return { searching: document.documentElement.classList.contains("is-searching"), width: bar.width, inBar: bar.top >= 0 && bar.bottom <= 56, cancel: cancel.width, label: document.querySelector(".hdr-search-cancel").textContent.trim(), placeholder: document.querySelector(".hdr-search-input").placeholder };
  });
  assert.equal(mode.searching, true, "search takes over the bar");
  assert.ok(mode.inBar, "the bar replaces the 56px app bar instead of floating over it");
  assert.ok(mode.cancel >= 44, "Cancel is a real touch target");
  assert.equal(mode.label, "Cancel");
  assert.ok(mode.placeholder.length > 0 && mode.placeholder.length < 40, "phone placeholder fits the field");
  await page.evaluate(axe.source);
  const report = await page.evaluate(() => window.axe.run(".hdr", {
    runOnly: { type: "rule", values: ["color-contrast", "button-name", "label", "aria-input-field-name", "aria-valid-attr-value"] },
  }));
  assert.deepEqual(report.violations.map((v) => v.id), [], "search mode passes named accessibility rules");
  await page.type(".hdr-search-input", "Test clip");
  await tap(page, ".hdr-search-cancel");
  await page.waitForFunction(() => document.querySelector(".hdr-search").hidden);
  assert.equal(await page.evaluate(() => location.hash), "#/discover", "Cancel does not navigate");
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("is-searching")), false);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("hdr-search-btn")), true, "focus returns to the search action");
  // Escape from inside the field closes it too
  await tap(page, ".hdr-search-btn");
  await page.waitForFunction(() => document.activeElement?.classList.contains("hdr-search-input"));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".hdr-search").hidden);
  // Enter navigates and the query it publishes is not wiped by a pending close
  await tap(page, ".hdr-search-btn");
  await page.waitForFunction(() => document.activeElement?.classList.contains("hdr-search-input"));
  await page.type(".hdr-search-input", "Test clip");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash.includes("q=Test"));
  await sleep(300);
  const landed = await page.evaluate(() => ({ hidden: document.querySelector(".hdr-search").hidden, value: document.querySelector(".hdr-search-input").value }));
  assert.equal(landed.hidden, true, "Enter closes the search bar");
  assert.equal(landed.value, "Test clip", "the routed query survives the close animation");
  await page.close();
});

test("tapping the current destination returns that page to the top", async (t) => {
  const page = await pageFor(t);
  await open(page, "library");
  await page.evaluate(() => { document.querySelector(".outlet").scrollTop = 600; });
  await page.waitForFunction(() => document.querySelector(".outlet").scrollTop > 100);
  await tap(page, '.mobile-nav-link[data-feature="library"]');
  await page.waitForFunction(() => document.querySelector(".outlet").scrollTop === 0);
  /* Leaving a scrolled page hands the bar back to the wordmark once the new
     page is at the top, and the compact page name follows the destination. */
  await tap(page, '.mobile-nav-link[data-feature="discover"]');
  await page.waitForSelector('.outlet[data-feature="discover"]');
  await sleep(300);
  const chrome = await page.evaluate(() => ({
    scrolled: document.querySelector(".hdr").classList.contains("is-scrolled"),
    context: document.querySelector(".hdr-context").textContent,
  }));
  assert.equal(chrome.scrolled, false, "a page at the top does not inherit the previous scroll state");
  assert.equal(chrome.context, "Discover");
  await page.close();
});

test("the More sheet closes by dragging its handle, not only by the backdrop", async (t) => {
  const page = await pageFor(t);
  await open(page, "discover");
  await tap(page, ".mobile-nav-more");
  await page.waitForSelector(".menu-sheet.in");
  assert.equal(await page.$eval(".navigation-menu .menu-cancel", (el) => !!el), true, "sheet has a labelled Cancel");
  await page.evaluate(axe.source);
  const report = await page.evaluate(() => window.axe.run(".navigation-menu", {
    runOnly: { type: "rule", values: ["color-contrast", "button-name", "aria-valid-attr-value"] },
  }));
  assert.deepEqual(report.violations.map((v) => v.id), [], "the refined sheet keeps its contrast and names");
  const grip = await (await page.$(".navigation-menu .sheet-drag")).boundingBox();
  const cdp = await page.createCDPSession();
  const x = grip.x + grip.width / 2, y = grip.y + 12;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + i * 16 }] });
    await sleep(12);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForFunction(() => !document.querySelector(".menu"));
  assert.equal(await page.$eval(".mobile-nav-more", (el) => el.getAttribute("aria-expanded")), "false");
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".mobile-nav-more")), true, "focus returns to the trigger");
  await page.close();
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

test("native seek, double-tap, play/pause, speed and sound controls operate on real video", { timeout: 30000 }, async (t) => {
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
  assert.equal(await page.$(".cell.is-active .cell-unmute"), null, "no on-video Tap for sound prompt");
  await tap(page, ".side-mute");
  assert.equal((await state(page)).muted, false, "sound stays available from the compact player rail");
  assert.equal(await page.$(".watch-fs, .watch-pip"), null, "no fullscreen or PiP buttons");
  await tap(page, ".side-options");
  await page.waitForSelector(".menu.in");
  const labels = await page.$$eval(".menu-label", (els) => els.map((el) => el.textContent));
  assert.ok(labels.includes("Fit / fill") && !labels.includes("Picture-in-picture"), "player options retain fit and omit PiP");
  await menuItem(page, "Fit / fill");
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains("watch"));
});

test("mobile fit does not rotate portrait video to landscape fullscreen", async (t) => {
  const page = await pageFor(t);
  await open(page, "watch?post=portrait");
  await tap(page, ".side-options");
  await menuItem(page, "Fit / fill");
  await sleep(100);
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), false, "portrait media keeps the phone orientation");
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

test('numeric site gate fits desktop, mobile and short landscape with accessible controls', async (t) => {
  const page = await pageFor(t);
  await open(page, 'discover');
  await page.evaluate(() => {
    const site = XR.resolve('app.site');
    site.hint = () => '';
    site.verify = async value => value === '001234';
    XR.resolve('shell.siteGate').show();
  });
  for (const [width, height] of [[1440, 900], [390, 844], [320, 568], [844, 390]]) {
    await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const geometry = await page.evaluate(() => {
      const gate = document.querySelector('.site-gate');
      const input = document.querySelector('.site-input');
      const button = document.querySelector('.site-submit');
      return { overflow: gate.scrollWidth > gate.clientWidth, input: input.getBoundingClientRect().height,
        button: button.getBoundingClientRect().height, mode: input.inputMode, type: input.type,
        remember: !!document.querySelector('.site-remember') };
    });
    assert.equal(geometry.overflow, false, `no horizontal overflow at ${width}`);
    assert.ok(geometry.input >= 44 && geometry.button >= 44);
    assert.equal(geometry.mode, 'numeric');
    assert.equal(geometry.type, 'password');
    assert.equal(geometry.remember, false, 'no "remember this browser" control');
    await page.screenshot({ path: `${SHOTS}/site-gate-${width}.png` });
  }
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.evaluate(axe.source);
  const report = await page.evaluate(async () => axe.run('.site-gate', {
    runOnly: { type: 'rule', values: ['color-contrast', 'label', 'button-name', 'aria-valid-attr-value'] },
  }));
  assert.deepEqual(report.violations.map(v => v.id), []);
  await page.click('.site-submit');
  assert.match(await page.$eval('.site-msg', el => el.textContent), /Enter your passcode/);
  await page.type('.site-input', 'abc');
  await page.click('.site-submit');
  assert.match(await page.$eval('.site-msg', el => el.textContent), /numbers only/);
  await page.$eval('.site-input', el => { el.value = ''; });
  await page.type('.site-input', '123');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.site-input').getAttribute('aria-invalid') === 'true');
  assert.match(await page.$eval('.site-msg', el => el.textContent), /isn't right/);
  await page.type('.site-input', '001234'); // failed input was selected for replacement
  await page.click('.site-reveal');
  assert.equal(await page.$eval('.site-input', el => el.type), 'text');
  assert.equal(await page.$eval('.site-input', el => el.value), '001234');
  await page.click('.site-reveal');
  assert.equal(await page.$eval('.site-input', el => el.type), 'password');
  await page.click('.site-submit');
  await page.waitForSelector('.site-gate', { hidden: true });
  // Nothing about the unlock is persisted, so no key or API survives it.
  const leftoverSite = await page.evaluate(async () => {
    const site = XR.resolve('app.site');
    const keys = await XR.resolve('app.ports.storage').keys();
    return { remember: typeof site.remember, isUnlocked: typeof site.isUnlocked,
      keys: keys.filter(key => key.includes('site.unlocked')) };
  });
  assert.deepEqual(leftoverSite, { remember: 'undefined', isUnlocked: 'undefined', keys: [] });
});

test('site gate recovers from verification errors and asks again on every load', async (t) => {
  const page = await pageFor(t, 1280, 800, false);
  await open(page, 'discover');
  await page.evaluate(() => {
    const site = XR.resolve('app.site');
    site.verify = async () => { throw new Error('offline'); };
    XR.resolve('shell.siteGate').show();
  });
  await page.type('.site-input', '001234');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.site-msg').textContent.includes("Couldn't check"));
  assert.equal(await page.$eval('.site-submit', el => el.disabled), false);
  await page.evaluate(() => {
    XR.resolve('app.site').verify = async value => value === '001234';
  });
  await page.click('.site-submit');
  await page.waitForFunction(() => !document.querySelector('.site-gate'));
  // A second boot must prompt again even though the code was just accepted.
  await page.evaluate(() => {
    const site = XR.resolve('app.site');
    site.applies = () => true;
    window.__gateState = 'pending';
    XR.resolve('shell.siteGate').ensure().then(() => { window.__gateState = 'resolved'; });
  });
  await page.waitForSelector('.site-gate');
  assert.equal(await page.evaluate(() => window.__gateState), 'pending');
  await page.type('.site-input', '001234');
  await page.click('.site-submit');
  await page.waitForFunction(() => !document.querySelector('.site-gate'));
  await page.waitForFunction(() => window.__gateState === 'resolved');
  assert.deepEqual(await page.evaluate(async () => (await XR.resolve('app.ports.storage').keys()).filter(k => k.includes('site.unlocked'))), []);
});

test('navigation markers align at desktop breakpoints and survive rapid route changes', async (t) => {
  const page = await pageFor(t, 1440, 900, false);
  await open(page, 'library');
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  for (const width of [1024, 1100, 1280, 1440]) {
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
    await page.waitForFunction(() => {
      const active = document.querySelector('.hdr-link.is-active').getBoundingClientRect();
      const marker = document.querySelector('.hdr-pill').getBoundingClientRect();
      return Math.abs(active.left - marker.left) < 2 && Math.abs(active.width - marker.width) < 2;
    });
    const bounds = await page.evaluate(() => {
      const nav = document.querySelector('.hdr-nav').getBoundingClientRect();
      const actions = document.querySelector('.hdr-actions').getBoundingClientRect();
      return { navRight: nav.right, actionsLeft: actions.left, actionsRight: actions.right, width: innerWidth };
    });
    assert.ok(bounds.navRight <= bounds.actionsLeft, `nav and actions don't collide at ${width}`);
    assert.ok(bounds.actionsRight <= bounds.width, `utilities stay in viewport at ${width}`);
  }
  await page.evaluate(() => {
    const nav = XR.resolve('app.nav');
    nav.go('collections'); nav.go('creators'); nav.go('library');
  });
  await page.waitForSelector('.outlet[data-feature="library"] .lib-grid');
  assert.equal(await page.$eval('.hdr-link[aria-current="page"]', el => el.dataset.feature), 'library');
  await page.evaluate(axe.source);
  const report = await page.evaluate(() => axe.run('.hdr', {
    runOnly: { type: 'rule', values: ['color-contrast', 'button-name', 'label', 'aria-valid-attr-value'] },
  }));
  assert.deepEqual(report.violations.map(v => v.id), []);
});

test('mobile More sheet reports state, traps keyboard focus and returns it on Escape', async (t) => {
  const page = await pageFor(t);
  await open(page, 'library');
  await tap(page, '.mobile-nav-more');
  await page.waitForFunction(() => document.activeElement?.classList.contains('menu-item'));
  assert.equal(await page.$eval('.mobile-nav-more', el => el.getAttribute('aria-expanded')), 'true');
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.navigation-menu .menu-item')), true);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.navigation-menu')).opacity === '1');
  await page.screenshot({ path: resolve(SHOTS, '390-navigation-more.png') });
  await page.evaluate(axe.source);
  const report = await page.evaluate(() => axe.run('.navigation-menu', {
    runOnly: { type: 'rule', values: ['color-contrast', 'button-name', 'aria-valid-attr-value'] },
  }));
  assert.deepEqual(report.violations.map(v => v.id), []);
  await page.keyboard.press('Escape');
  assert.equal(await page.$('.navigation-menu'), null);
  assert.equal(await page.$eval('.mobile-nav-more', el => el.getAttribute('aria-expanded')), 'false');
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.mobile-nav-more')), true);
  const marker = await page.evaluate(() => {
    const active = document.querySelector('.mobile-nav-link.is-active').getBoundingClientRect();
    const pill = document.querySelector('.mobile-nav-pill');
    return { delta: Math.abs(active.left - pill.getBoundingClientRect().left), duration: getComputedStyle(pill).transitionDuration };
  });
  assert.ok(marker.delta < 2);
  assert.equal(marker.duration, '0s', 'reduced motion disables marker travel');
});

// Synthetic shared server state: every page/context gets the same deletion ledger,
// while /data/posts.js deliberately remains the OLD export to test resurrection.
async function mockSharedLibrary(page, shared) {
  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    if (!new URL(req.url()).pathname.endsWith("/api/library")) return req.continue();
    let status = 200, body;
    if (req.method() === "DELETE") {
      const input = JSON.parse(req.postData());
      if (input.password !== "test-delete-password") { status = 401; body = { error: "Incorrect deletion password." }; }
      else { shared.add(input.id); body = { deleted: true, id: input.id, deletedIds: [...shared] }; }
    } else body = { enabled: true, deletedIds: [...shared] };
    await req.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
}
async function openDeletePrompt(page) {
  await page.$eval('.tile[data-id="clip-1"] .tile-more', (el) => el.click());
  await page.waitForSelector(".menu-item");
  await page.evaluate(() => [...document.querySelectorAll(".menu-item")].find((el) => el.textContent.trim() === "Delete from library").click());
  await page.waitForSelector('.dialog input[type="password"]', { visible: true });
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".dialog-backdrop")).opacity === "1");
}

test("Delete from library confirms, persists across fresh browsers and filters stale exports", async (t) => {
  const shared = new Set();
  const page = await pageFor(t);
  await mockSharedLibrary(page, shared);
  await open(page, "library?sort=saved");
  await openDeletePrompt(page);
  assert.match(await page.$eval(".dialog-body", (el) => el.textContent), /shared data file and every browser/);
  assert.equal(await page.$eval('.dialog input', (el) => el.getAttribute("aria-label")), "Deletion password");
  await page.screenshot({ path: resolve(SHOTS, "delete-confirm-mobile.png") });
  await page.evaluate(axe.source);
  const a11y = await page.evaluate(() => window.axe.run(".dialog", { runOnly: { type: "rule", values: ["button-name", "label", "color-contrast"] } }));
  assert.deepEqual(a11y.violations.map((v) => v.id), []);
  await page.type('.dialog input[type="password"]', "test-delete-password");
  await page.click(".dialog-foot .btn-danger");
  await page.waitForFunction(() => !XR.resolve("app.catalog").post("clip-1"));
  assert.ok(shared.has("clip-1"));
  assert.equal(await page.$('.tile[data-id="clip-1"]'), null);
  await page.waitForFunction(() => !document.querySelector(".dialog-backdrop"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".lib-grid");
  assert.equal(await page.evaluate(() => !!XR.resolve("app.catalog").post("clip-1")), false, "cached old export cannot resurrect it");
  const fresh = await pageFor(t, 1440, 900, false);
  await mockSharedLibrary(fresh, shared);
  await open(fresh, "library?sort=saved");
  assert.equal(await fresh.evaluate(() => !!XR.resolve("app.catalog").post("clip-1")), false, "another browser sees shared deletion");
  await page.close(); await fresh.close();
});

test("cancelling deletion and incorrect passwords leave the post untouched", async (t) => {
  const shared = new Set(), page = await pageFor(t, 1440, 900, false);
  await mockSharedLibrary(page, shared);
  await open(page, "library?sort=saved");
  await openDeletePrompt(page);
  await page.screenshot({ path: resolve(SHOTS, "delete-confirm-desktop.png") });
  await page.click(".dialog-foot .btn-ghost");
  await page.waitForFunction(() => !document.documentElement.classList.contains("has-dialog"));
  await sleep(180);
  assert.equal(shared.size, 0);
  await openDeletePrompt(page);
  await page.type('.dialog input[type="password"]', "wrong-password");
  await page.click(".dialog-foot .btn-danger");
  await page.waitForFunction(() => [...document.querySelectorAll(".toast-error")].some((el) => el.textContent.includes("Incorrect deletion password")));
  assert.ok(await page.evaluate(() => !!XR.resolve("app.catalog").post("clip-1")));
  assert.equal(shared.size, 0);
  await page.close();
});

test("Library returns from Watch with its deck, query and scroll; mobile tab keeps filters", async (t) => {
  const page = await pageFor(t);
  await open(page, "library?kind=video&sort=smart&q=Test");
  const before = await page.evaluate(() => {
    const grid = document.querySelector('.lib-grid .masonry') || document.querySelector('.lib-grid');
    const outlet = document.querySelector('.outlet');
    outlet.scrollTop = 500;
    return { y: outlet.scrollTop, query: location.hash, tiles: [...grid.querySelectorAll('[data-index]')].map(e => [e.dataset.index, e.dataset.id]) };
  });
  assert.ok(before.y > 0, 'fixture can scroll');
  await page.evaluate(() => XR.resolve('app.actions').watch(['clip-1', 'clip-2'], 0, { label: 'Test' }));
  await page.waitForSelector('.watch');
  await page.evaluate(() => XR.resolve('app.nav').back());
  await page.waitForSelector('.library');
  await page.waitForFunction(y => Math.abs(document.querySelector('.outlet').scrollTop - y) < 3, {}, before.y);
  assert.equal(await page.evaluate(() => location.hash), before.query);
  assert.equal(await page.$eval('.lib-search', e => e.value), 'Test');
  const after = await page.$$eval('.lib-grid [data-index]', els => els.map(e => [e.dataset.index, e.dataset.id]));
  assert.deepEqual(after, before.tiles, 'the same tiles keep their positions after playback');
  await page.evaluate(() => XR.resolve('app.nav').go('collections'));
  await page.waitForSelector('.outlet[data-feature="collections"] > :not(.feature-loading)');
  await tap(page, '.mobile-nav-link[data-feature="library"]');
  await page.waitForSelector('.library');
  assert.equal(await page.evaluate(() => location.hash), before.query);
  await page.waitForFunction(y => Math.abs(document.querySelector('.outlet').scrollTop - y) < 3, {}, before.y);
});

test("large mobile Library keeps a bounded DOM during a deep scroll", async (t) => {
  const page = await pageFor(t);
  await open(page, 'library?sort=saved');
  const result = await page.evaluate(async () => {
    const { createMasonry } = XR.resolve('ui.masonry');
    const host = document.createElement('div');
    const scroller = document.querySelector('.outlet');
    scroller.replaceChildren(host);
    let renders = 0;
    const grid = createMasonry(host, {
      scroller, minCols: 2, extraHeight: () => 0,
      render: (_, i) => { renders++; const el = document.createElement('div'); el.dataset.index = i; return { el, destroy: () => el.remove() }; },
    });
    const start = performance.now();
    grid.setItems(Array.from({ length: 10000 }, (_, id) => ({ id })));
    const layoutMs = performance.now() - start;
    for (const i of [1000, 5000, 9000]) { grid.scrollToIndex(i); await new Promise(requestAnimationFrame); }
    const result = { mounted: grid.mounted(), renders, layoutMs, height: host.offsetHeight };
    grid.destroy();
    return result;
  });
  assert.ok(result.mounted < 80, `bounded mounted tiles: ${JSON.stringify(result)}`);
  assert.ok(result.renders < 240, `only nearby tiles rendered: ${JSON.stringify(result)}`);
  assert.ok(result.height > 100000, 'full scroll geometry retained');
  t.diagnostic(JSON.stringify(result));
});

test('Watch starts only the visible video; fresh neighbours do not attach sources', async (t) => {
  const page = await pageFor(t);
  await open(page, 'library?sort=saved');
  await page.evaluate(() => {
    XR.resolve('app.actions').watch(['clip-1', 'clip-2', 'clip-3', 'clip-5', 'clip-6', 'clip-7'], 0);
  });
  await page.waitForSelector('.watch');
  await readyVideo(page);
  const fresh = await page.$$eval('.cell:not(.is-active) video', videos => videos.map(video => ({ src: video.getAttribute('src'), paused: video.paused })));
  assert.ok(fresh.length >= 2);
  assert.ok(fresh.every(video => !video.src && video.paused), 'neighbours use only the bounded warm queue, not native media loading');
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('ArrowDown');
    await sleep(220);
  }
  await page.waitForFunction(() => document.querySelector('.cell.is-active')?.dataset.id === 'clip-6');
  await readyVideo(page);
  const counts = await page.$$eval('.watch video', videos => ({ total: videos.length, playing: videos.filter(video => !video.paused).length }));
  assert.ok(counts.total <= 5, 'decoder elements remain windowed');
  assert.equal(counts.playing, 1, 'no stale play promise restarts a previous clip');
  await page.evaluate(() => XR.resolve('app.nav').go('library'));
  await page.waitForSelector('.library');
  assert.equal(await page.$$eval('.watch video, audio', nodes => nodes.length), 0, 'media elements are released on exit');
});

test('media loading becomes a recoverable slow wait, then clears on actual playback', { timeout: 30000 }, async (t) => {
  const page = await pageFor(t);
  await open(page, 'library');
  await page.setRequestInterception(true);
  let hold = true;
  const held = [];
  page.on('request', req => {
    if (hold && req.url().includes('/__fixtures/clip.webm')) held.push(req);
    else void req.continue().catch(() => {});
  });
  await page.evaluate(() => XR.resolve('app.actions').watch(['clip-1', 'clip-2']));
  const panel = '.cell.is-active .media-feedback';
  await page.waitForSelector(panel + '[data-state="loading"]', { visible: true });
  assert.equal(await page.$eval(panel + ' [role="status"]', e => e.getAttribute('aria-live')), 'polite');
  assert.equal(await page.$eval(panel + ' .media-feedback-title', e => e.textContent), 'Loading video…');
  await page.screenshot({ path: resolve(SHOTS, '390-media-loading.png') });
  await page.waitForSelector(panel + '[data-state="slow"]', { visible: true });
  assert.equal(await page.$eval('.cell.is-active', e => e.classList.contains('is-unplayable')), false, 'a slow request is not declared failed');
  assert.ok(await page.$eval(panel, e => /Retry/.test(e.textContent) && /Next/.test(e.textContent)));
  hold = false;
  await Promise.all(held.map(req => req.continue().catch(() => {})));
  await readyVideo(page);
  await page.waitForFunction(() => document.querySelector('.cell.is-active .media-feedback').hidden);
  await page.setOfflineMode(true);
  await page.waitForFunction(() => !navigator.onLine);
  assert.equal(await page.$eval(panel, e => e.hidden), true, 'going offline does not cover a buffered playing video');
});

test('offline media has honest copy, reconnect does not imply recovery, and Retry loads again', async (t) => {
  for (const [width, height] of [[320, 568], [844, 390]]) {
    const page = await pageFor(t, width, height);
    await open(page, 'library');
    await page.setOfflineMode(true);
    await page.evaluate(() => XR.resolve('app.actions').watch(['clip-1', 'clip-2']));
    const panel = '.cell.is-active .media-feedback';
    await page.waitForSelector(panel + '[data-state="offline"]', { visible: true });
    const copy = await page.$eval(panel, e => e.textContent);
    assert.match(copy, /isn't necessarily downloaded/);
    assert.doesNotMatch(copy, /deleted|refused|available offline/);
    const box = await (await page.$(panel)).boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, 'offline recovery stays on screen');
    await page.screenshot({ path: resolve(SHOTS, `${width}-media-offline.png`) });
    await page.setOfflineMode(false);
    await page.waitForSelector(panel + '[data-state="reconnect"]', { visible: true });
    const retry = await page.evaluateHandle(selector => [...document.querySelectorAll(selector + ' .btn')].find(btn => btn.textContent === 'Retry'), panel);
    await retry.asElement().click();
    await readyVideo(page);
    await page.waitForFunction(() => document.querySelector('.cell.is-active .media-feedback').hidden);
    await page.close();
  }
});

test('Viewer reports exhausted image fallbacks and Retry clears failure on a real image load', async (t) => {
  const page = await pageFor(t);
  await open(page, 'library');
  await page.evaluate(async () => {
    await XR.resolve('app.features').load('viewer');
    const m = XR.resolve('app.catalog').post('clip-4').media[0];
    window.originalImage = { thumb: m.thumb, poster: m.poster };
    m.thumb = '/__fixtures/missing-image.jpg'; m.poster = '/__fixtures/missing-preview.jpg';
    XR.resolve('app.actions').view(['clip-4', 'clip-1']);
  });
  const panel = '.viewer .media-feedback';
  await page.waitForSelector(panel + '[data-state="error"]', { visible: true });
  assert.match(await page.$eval(panel, e => e.textContent), /Couldn't load this image/);
  await page.screenshot({ path: resolve(SHOTS, '390-viewer-image-error.png') });
  await page.evaluate(() => {
    Object.assign(XR.resolve('app.catalog').post('clip-4').media[0], window.originalImage);
    [...document.querySelectorAll('.viewer .media-feedback .btn')].find(btn => btn.textContent === 'Retry').click();
  });
  await page.waitForFunction(() => {
    const img = document.querySelector('.viewer-img');
    return img?.complete && img.naturalWidth > 0 && document.querySelector('.viewer .media-feedback').hidden;
  });
  assert.equal(await page.$eval('.viewer-frame', el => el.classList.contains('is-unplayable')), false);
});

test('Watch album feedback follows only the selected image or video', async (t) => {
  const page = await pageFor(t);
  await open(page, 'library');
  await page.evaluate(() => {
    const m = XR.resolve('app.catalog').post('mixed').media[0];
    m.thumb = '/__fixtures/missing-image.jpg'; m.poster = '/__fixtures/missing-preview.jpg';
    XR.resolve('app.actions').watch(['mixed', 'clip-1']);
  });
  await page.waitForSelector('.cell.is-active .media-feedback[data-state="error"]', { visible: true });
  await drag(page, { x: 325, y: 600 }, { x: 65, y: 600 });
  await readyVideo(page);
  await page.waitForFunction(() => !document.querySelector('.cell.is-active').classList.contains('is-unplayable'));
  assert.equal(await page.$$eval('.cell.is-active .media-feedback', nodes => nodes.every(node => node.hidden)), true, 'old image error does not cover the playing album video');
});

test('restored mobile players retain original navigation and separate action rails', async (t) => {
  for (const [width, height] of [[320, 568], [844, 390]]) {
    const page = await pageFor(t, width, height);
    await open(page, 'watch?post=mixed');
    assert.equal(await page.$('.carousel-navigation, .watch-nav-label'), null);
    assert.equal(await page.$eval('.watch-arrows', el => !!el.getClientRects().length), false);
    assert.equal(await page.$eval('.cell.is-active .carousel-next', el => !!el.getClientRects().length), false);
    assert.equal(await page.$eval('.side-options .side-label', el => el.textContent), 'Options');
    assert.equal(await page.$$eval('.watch-side .side-btn', els => els.filter(el => el.getClientRects().length).length), 4);
    await tap(page, '.side-options');
    const menuText = await page.$eval('.menu', el => el.textContent);
    assert.ok(menuText.includes('Fit / fill') && menuText.includes('Up next'));
    assert.equal(menuText.includes('Copy link'), false, 'post actions are separate again');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: resolve(SHOTS, `${width}-restored-watch.png`) });
    await page.evaluate(async () => { await XR.resolve('app.features').load('viewer'); XR.resolve('app.actions').view(['mixed', 'clip-1']); });
    await page.waitForSelector('.viewer.in');
    assert.equal(await page.$('.viewer-media-nav, .viewer-nav-label'), null);
    assert.equal(await page.$eval('.viewer-vnav', el => !!el.getClientRects().length), false);
    assert.equal(await page.$$eval('.viewer-rail-btn', els => els.filter(el => el.getClientRects().length).length), 6);
    await page.screenshot({ path: resolve(SHOTS, `${width}-restored-viewer.png`) });
    await page.close();
  }
});
