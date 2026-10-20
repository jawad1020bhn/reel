/* Reddit unsave engine · behavioural tests against a fake old.reddit server.
 * No network, no real account: the harness emulates /api/me.json, the saved
 * listing (25 rows a page, `next` links) and POST /api/unsave. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import saved from "../reddit-saved.js";
import removal from "../reddit-removal.js";
import pacing from "../pacing.js";

const code = readFileSync(new URL("../reddit-unsave.js", import.meta.url), "utf8");
const MODHASH = "modhash0123456789abcdef";
const PAGE = 25;
const tick = () => new Promise((done) => setImmediate(done));
async function until(check, label = "Engine condition") {
  for (let n = 0; n < 600; n++) { if (check()) return; await new Promise((r) => setTimeout(r, 2)); }
  throw new Error(label + " timed out");
}
function leasePool() {
  let held = false;
  return { REDDIT_LOCK: "xreels-reddit-exclusive-engine", async acquire() { if (held) return null; held = true; return () => { held = false; }; }, get held() { return held; } };
}
const nsfw = (id) => ({ fullname: "t3_" + id, className: "thing link over18", nsfw: "true", title: "post " + id, subreddit: "r/x", permalink: `/r/x/comments/${id}/p/`, url: "https://i.redd.it/" + id + ".jpg", domain: "i.redd.it" });
const sfw = (id) => ({ fullname: "t3_" + id, className: "thing link", nsfw: "false", title: "sfw " + id, subreddit: "r/y", permalink: `/r/y/comments/${id}/p/`, url: "https://example.com/" + id, domain: "example.com" });
const comment = (id) => ({ fullname: "t1_" + id, className: "thing comment over18", nsfw: "true", title: "", subreddit: "r/x", permalink: `/r/x/comments/zz/p/${id}/` });

/**
 * The fake site. `listing` is the live saved list (most recent first). Unsave
 * removes from it unless `sticky` keeps an item listed after a confirmed
 * removal (to exercise verification).
 */
function fakeReddit({ listing, identity = { name: "Jawad", modhash: MODHASH, over_18: true }, unsave, sticky = new Set(), listingStatus = 200 } = {}) {
  const site = { listing: listing.slice(), identity, requests: [], unsaves: [], active: 0, maxActive: 0, listingStatus, sticky };
  site.fetch = async (url, init = {}) => {
    const target = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    site.requests.push(method + " " + target.pathname + target.search);
    const respond = (status, body, { finalUrl = target.href, headers = {} } = {}) => ({
      status, ok: status >= 200 && status < 300, url: finalUrl,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    });
    if (target.pathname === "/api/me.json") {
      const who = typeof site.identity === "function" ? site.identity() : site.identity;
      return respond(200, who ? { kind: "t2", data: who } : {});
    }
    if (/^\/user\/[^/]+\/saved\/?$/.test(target.pathname)) {
      if (site.listingStatus !== 200) return respond(site.listingStatus, "<html>nope</html>");
      if (site.identity && site.identity.gate) return respond(200, "<html>login</html>", { finalUrl: "https://old.reddit.com/login?dest=x" });
      const count = Number(target.searchParams.get("count")) || 0;
      const after = target.searchParams.get("after");
      let start = 0;
      if (after) { const idx = site.listing.findIndex((row) => row.fullname === after); start = idx >= 0 ? idx + 1 : site.listing.length; }
      const rows = site.listing.slice(start, start + PAGE);
      const last = rows[rows.length - 1];
      const next = start + PAGE < site.listing.length && last ? `/user/jawad/saved/?count=${count + PAGE}&after=${last.fullname}` : null;
      return respond(200, { listing: true, rows, next });
    }
    if (target.pathname === "/api/unsave" && method === "POST") {
      site.active++; site.maxActive = Math.max(site.maxActive, site.active);
      try {
        const params = new URLSearchParams(init.body);
        site.unsaves.push(params.get("id"));
        if (unsave) { const custom = await unsave(params, site); if (custom) return respond(custom.status, custom.body, { headers: custom.headers }); }
        if (params.get("uh") !== (typeof site.identity === "function" ? site.identity() : site.identity)?.modhash) return respond(200, { jquery: [[0, 1, "call", ["please login to do that"]]], success: false });
        if (!sticky.has(params.get("id"))) site.listing = site.listing.filter((row) => row.fullname !== params.get("id"));
        return respond(200, {});
      } finally { site.active--; }
    }
    return respond(404, "<html>404</html>");
  };
  return site;
}

/** Holds the FIRST unsave until the test releases it (later ones behave normally). */
function heldUnsave() {
  const slot = { finish: null };
  slot.unsave = (params, site) => {
    if (slot.finish) return null;
    return new Promise((resolve) => {
      slot.finish = (result) => {
        if (result && result.status === 200) site.listing = site.listing.filter((row) => row.fullname !== params.get("id"));
        resolve(result);
      };
    });
  };
  return slot;
}

function harness({ site, data = {}, lock = leasePool(), failBackup = false, pathname = "/user/jawad/saved/", now = Date.now } = {}) {
  const values = structuredClone(data), listeners = [];
  const storage = {
    async get(keys) { const wanted = typeof keys === "string" ? [keys] : keys; return structuredClone(Object.fromEntries(wanted.map((key) => [key, values[key]]))); },
    async set(patch) { if (failBackup && Object.keys(patch).some((key) => key.startsWith("redditUnsavePost."))) throw new Error("disk full"); Object.assign(values, structuredClone(patch)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
  };
  const location = { origin: "https://old.reddit.com", pathname, get href() { return this.origin + this.pathname; } };
  const session = new Map();
  const dom = {
    readRows: (doc) => doc.rows || [], nextHref: (doc) => doc.next || null, isListing: (doc) => !!doc.listing,
    looksLoggedIn: () => true, isGateUrl: (url) => /\/(login|over18)(?:[/?#]|$)/i.test(String(url || "")),
  };
  const context = vm.createContext({
    console: { warn() {} }, location, document: {}, crypto: { randomUUID: () => "test-owner" },
    fetch: (url, init) => site.fetch(url, init),
    DOMParser: class { parseFromString(text) { try { return JSON.parse(text); } catch { return { listing: false }; } } },
    AbortSignal: { timeout: () => ({ aborted: false, throwIfAborted() {} }) },
    chrome: { storage: { local: storage }, runtime: { sendMessage: async () => {}, onMessage: { addListener(fn) { listeners.push(fn); } } } },
    sessionStorage: { getItem: (key) => session.get(key), setItem: (key, val) => session.set(key, val), removeItem: (key) => session.delete(key) },
    XEngineLock: lock, XRedditSaved: { ...saved, createPacer: () => ({ nextGap: () => ({ ms: 0, wave: false }) }) }, XRedditRemoval: removal, XRedditDom: dom,
    XPacing: { ...pacing, createPacer: () => ({ next: () => ({ kind: "steady", delayMs: 0 }), onAction() {} }) },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 1)), clearTimeout, clearInterval,
    setInterval: (fn, ms) => { const timer = setInterval(fn, ms); if (timer.unref) timer.unref(); return timer; },
    Date: class extends Date { static now() { return now(); } },
  });
  vm.runInContext(code, context);
  return { engine: vm.runInContext("RU", context), values, lock, location, listeners, site, storage };
}

test("backs up before each removal, sends one request at a time, removes only NSFW posts and completes after two clean sweeps", async () => {
  const site = fakeReddit({ listing: [nsfw("a1"), sfw("s1"), comment("c1"), nsfw("a2"), sfw("s2")] });
  const h = harness({ site }); await tick();
  assert.equal((await h.engine.start()).ok, true);
  await until(() => h.values.redditUnsaveState?.status === "completed");
  assert.deepEqual(site.unsaves, ["t3_a1", "t3_a2"]);
  assert.deepEqual(site.listing.map((row) => row.fullname), ["t3_s1", "t1_c1", "t3_s2"], "SFW posts and comments are untouched");
  assert.equal(site.maxActive, 1);
  assert.equal(h.values.redditUnsaveState.stats.unsaved, 2);
  assert.equal(h.values.redditUnsaveState.stats.failed, 0);
  assert.equal(h.values.redditUnsaveState.lastStopReason, "verified-clean");
  assert.ok(h.values.redditUnsaveState.stats.sweeps >= 2, "two clean sweeps before completion");
  assert.equal(h.values["redditUnsavePost.jawad.a1"].outcome, "unsaved");
  assert.ok(h.values["redditUnsavePost.jawad.a1"].unsaved_at);
  assert.equal(h.values["redditUnsavePost.jawad.a1"].fullname, "t3_a1");
  assert.deepEqual(h.values.redditUnsaveBackup.ids, ["a1", "a2"]);
  assert.equal(h.values.redditUnsaveSession, undefined);
  assert.equal(h.lock.held, false);
  // The backup for a1 was written before its unsave was sent.
  const firstUnsave = site.requests.findIndex((r) => r.startsWith("POST /api/unsave"));
  assert.ok(firstUnsave > 0);
});

test("finds NSFW posts deep in a multi-page listing and keeps re-reading the head as the list shrinks", async () => {
  const listing = [];
  for (let i = 0; i < 60; i++) listing.push(sfw("s" + i));
  listing.splice(30, 0, nsfw("deep1"));
  listing.push(nsfw("deep2"), nsfw("deep3"));
  const site = fakeReddit({ listing });
  const h = harness({ site }); await tick();
  await h.engine.start();
  await until(() => h.values.redditUnsaveState?.status === "completed");
  assert.deepEqual(new Set(site.unsaves), new Set(["t3_deep1", "t3_deep2", "t3_deep3"]));
  assert.equal(site.listing.length, 60);
  assert.ok(site.listing.every((row) => row.className === "thing link"));
  const scans = site.requests.filter((r) => r.startsWith("GET /user/jawad/saved"));
  assert.ok(scans.filter((r) => !r.includes("after=")).length >= 4, "the head is re-read after each removal batch");
});

test("pause waits for the in-flight removal, preserves the rest, and resumes exactly", async () => {
  const held = heldUnsave();
  const site = fakeReddit({ listing: [nsfw("a1"), nsfw("a2")], unsave: held.unsave });
  const h = harness({ site }); await tick();
  await h.engine.start();
  await until(() => !!held.finish);
  let paused = false;
  const pause = h.engine.pause().then(() => { paused = true; });
  await tick(); assert.equal(paused, false, "pause waits for the request in flight");
  held.finish({ status: 200, body: {} });
  await pause;
  assert.equal(h.values.redditUnsaveState.status, "paused");
  assert.deepEqual(h.values.redditUnsaveSession.queue, ["a2"]);
  assert.equal(h.lock.held, false);
  site.listing = site.listing.filter((row) => row.fullname !== "t3_a1");
  const resumed = harness({ site: fakeReddit({ listing: [nsfw("a2")] }), data: h.values }); await tick();
  assert.equal((await resumed.engine.start()).resumed, true);
  await until(() => resumed.values.redditUnsaveState?.status === "completed");
  assert.deepEqual(resumed.site.unsaves, ["t3_a2"]);
  assert.equal(resumed.values.redditUnsaveState.stats.unsaved, 2);
});

test("unknown success bodies, HTML, auth failures and a missing endpoint stop with the target still queued", async () => {
  for (const result of [
    { status: 200, body: { weird: true } },
    { status: 200, body: "<!doctype html><html>login</html>" },
    { status: 403, body: { error: 403 } },
    { status: 404, body: "<html>404</html>" },
  ]) {
    const site = fakeReddit({ listing: [nsfw("a1"), nsfw("a2")], unsave: async () => result });
    const h = harness({ site }); await tick(); await h.engine.start();
    await until(() => h.values.redditUnsaveState?.status === "stopped_by_error", JSON.stringify(result));
    assert.equal(h.values.redditUnsaveState.stats.unsaved, 0);
    assert.deepEqual(h.values.redditUnsaveSession.queue, ["a1", "a2"]);
    assert.equal(h.values["redditUnsavePost.jawad.a1"].outcome, "pending");
    assert.equal(site.listing.length, 2);
    assert.equal(h.lock.held, false);
  }
});

test("a storage failure cannot lead to an unbacked removal", async () => {
  const site = fakeReddit({ listing: [nsfw("a1")] });
  const h = harness({ site, failBackup: true }); await tick(); await h.engine.start();
  await until(() => h.values.redditUnsaveState?.status === "stopped_by_error");
  assert.equal(site.unsaves.length, 0);
  assert.equal(h.values.redditUnsaveState.lastStopReason, "storage-error");
  assert.equal(h.lock.held, false);
});

test("429 backs off, honours Reddit's own wait hint, and retries the same post without counting it removed", async () => {
  let tries = 0;
  const site = fakeReddit({ listing: [nsfw("a1"), nsfw("a2")], unsave: async () => (++tries === 1 ? { status: 429, body: { error: 429 }, headers: { "x-ratelimit-reset": "0.001" } } : null) });
  const h = harness({ site }); await tick(); await h.engine.start();
  await until(() => h.values.redditUnsaveState?.status === "completed");
  assert.deepEqual(site.unsaves, ["t3_a1", "t3_a1", "t3_a2"]);
  assert.equal(h.values.redditUnsaveState.stats.rateLimits, 1);
  assert.equal(h.values.redditUnsaveState.stats.unsaved, 2);
  assert.equal(h.values.redditUnsaveState.stats.failed, 0);
});

test("a stale modhash triggers one identity refresh and the run continues with the new session token", async () => {
  const fresh = "freshmodhash0123456789";
  let rotated = false;
  const site = fakeReddit({ listing: [nsfw("a1"), nsfw("a2")] });
  site.identity = () => ({ name: "Jawad", modhash: rotated ? fresh : MODHASH, over_18: true });
  const h = harness({ site }); await tick(); await h.engine.start();
  // Rotate the session after the engine learned the first modhash.
  await until(() => site.requests.some((r) => r === "GET /api/me.json"));
  rotated = true;
  await until(() => h.values.redditUnsaveState?.status === "completed");
  assert.ok(site.unsaves.length >= 3, "the rejected attempt was retried after the refresh");
  assert.equal(h.values.redditUnsaveState.stats.unsaved, 2);
  assert.equal(site.listing.length, 0);
});

test("exclusivity and scope guards: busy lock, wrong page, other account's checkpoint, mismatched login, hidden NSFW, logged out", async () => {
  const lock = leasePool(), hold = await lock.acquire();
  const site = fakeReddit({ listing: [nsfw("a1")] });
  const h = harness({ site, lock }); await tick();
  assert.equal((await h.engine.start()).reason, "engine-busy");
  hold();
  h.location.pathname = "/user/jawad/comments/";
  assert.equal((await h.engine.start()).reason, "open-saved");
  h.location.pathname = "/user/jawad/saved/";
  h.values.redditUnsaveSession = { account: "someoneelse", savedAt: Date.now() };
  assert.equal((await h.engine.start()).reason, "account-changed");
  delete h.values.redditUnsaveSession;
  site.identity = { name: "OtherPerson", modhash: MODHASH, over_18: true };
  const mismatch = await h.engine.start();
  assert.equal(mismatch.reason, "account-mismatch");
  assert.equal(mismatch.signedInAs, "OtherPerson");
  site.identity = { name: "Jawad", modhash: MODHASH, over_18: false };
  assert.equal((await h.engine.start()).reason, "nsfw-hidden");
  site.identity = null;
  assert.equal((await h.engine.start()).reason, "auth-unavailable");
  assert.equal(lock.held, false);
  assert.equal(site.unsaves.length, 0);
});

test("hiding NSFW content mid-run stops the engine instead of letting an empty listing look complete", async () => {
  const site = fakeReddit({ listing: [nsfw("a1"), nsfw("hidden1")] });
  let unsaved = 0;
  site.identity = () => ({ name: "Jawad", modhash: MODHASH, over_18: unsaved === 0 });
  const original = site.fetch;
  site.fetch = async (url, init) => {
    const res = await original(url, init);
    if (new URL(url).pathname === "/api/unsave") { unsaved++; site.listing = site.listing.filter((row) => row.className !== "thing link over18"); /* Reddit now hides NSFW rows */ }
    return res;
  };
  const h = harness({ site }); await tick(); await h.engine.start();
  await until(() => ["stopped_by_error", "completed"].includes(h.values.redditUnsaveState?.status));
  assert.equal(h.values.redditUnsaveState.status, "stopped_by_error");
  assert.equal(h.values.redditUnsaveState.lastStopReason, "nsfw-hidden");
});

test("a post Reddit keeps listing after a confirmed removal is retried once, then pauses for review — never completion", async () => {
  const site = fakeReddit({ listing: [nsfw("ghost")], sticky: new Set(["t3_ghost"]) });
  const h = harness({ site }); await tick(); await h.engine.start();
  await until(() => h.values.redditUnsaveState?.status === "paused");
  assert.equal(h.values.redditUnsaveState.lastStopReason, "verification-needed");
  assert.equal(site.unsaves.filter((id) => id === "t3_ghost").length, 2, "exactly one idempotent retry");
  assert.equal(h.values.redditUnsaveState.stats.requeued, 1);
  assert.notEqual(h.values.redditUnsaveState.status, "completed");
});

test("a login wall or a non-listing page stops before anything is removed; a listing 403 is an auth error", async () => {
  const gated = fakeReddit({ listing: [nsfw("a1")], identity: { name: "Jawad", modhash: MODHASH, over_18: true, gate: true } });
  const g = harness({ site: gated }); await tick(); await g.engine.start();
  await until(() => g.values.redditUnsaveState?.status === "stopped_by_error");
  assert.equal(g.values.redditUnsaveState.lastStopReason, "auth-error");
  assert.equal(gated.unsaves.length, 0);

  const broken = fakeReddit({ listing: [nsfw("a1")] });
  const base = broken.fetch;
  broken.fetch = async (url, init) => /\/saved/.test(url) ? { status: 200, ok: true, url, headers: { get: () => null }, text: async () => "<html>new reddit shell</html>" } : base(url, init);
  const b = harness({ site: broken }); await tick(); await b.engine.start();
  await until(() => b.values.redditUnsaveState?.status === "stopped_by_error");
  assert.equal(b.values.redditUnsaveState.lastStopReason, "schema-mismatch");
  assert.equal(broken.unsaves.length, 0);

  const forbidden = fakeReddit({ listing: [nsfw("a1")], listingStatus: 403 });
  const f = harness({ site: forbidden }); await tick(); await f.engine.start();
  await until(() => f.values.redditUnsaveState?.status === "stopped_by_error");
  assert.equal(f.values.redditUnsaveState.lastStopReason, "auth-error");
  assert.equal(f.values.redditUnsaveState.stats.failed, 0, "scan failures are not mutation failures");
});

test("reset removes only this engine's records, never the captured Reddit library or X data", async () => {
  const site = fakeReddit({ listing: [nsfw("a1")] });
  const h = harness({ site, data: { redditSavedMeta: { count: 3 }, "redditSavedChunk.000000": [{ id: "keep" }], xUnsaveBackup: { ids: ["x"] } } }); await tick(); await h.engine.start();
  await until(() => h.values.redditUnsaveState?.status === "completed");
  assert.equal((await h.engine.reset()).ok, true);
  assert.deepEqual(h.values.redditSavedMeta, { count: 3 });
  assert.deepEqual(h.values["redditSavedChunk.000000"], [{ id: "keep" }]);
  assert.deepEqual(h.values.xUnsaveBackup, { ids: ["x"] });
  assert.ok(!Object.keys(h.values).some((key) => key.startsWith("redditUnsave")));
});

test("attempt budget pauses at a resumable checkpoint; the next Start continues the queue", async () => {
  const site = fakeReddit({ listing: [nsfw("a1"), nsfw("a2")] });
  const h = harness({ site }); await tick(); h.engine.config.maxRunCount = 1;
  await h.engine.start();
  await until(() => h.values.redditUnsaveState?.status === "paused");
  assert.equal(h.values.redditUnsaveState.lastStopReason, "run-cap");
  assert.equal(h.values.redditUnsaveState.stats.unsaved, 1);
  assert.deepEqual(h.values.redditUnsaveSession.queue, ["a2"]);
  assert.equal(h.lock.held, false);
  h.engine.config.maxRunCount = 5;
  await h.engine.start();
  await until(() => h.values.redditUnsaveState?.status === "completed");
  assert.equal(h.values.redditUnsaveState.stats.unsaved, 2);
});

test("Stop waits for the last write, saves the remaining queue and never sends a second removal", async () => {
  const held = heldUnsave();
  const site = fakeReddit({ listing: [nsfw("a1"), nsfw("a2")], unsave: held.unsave });
  const h = harness({ site }); await tick();
  await h.engine.start(); await until(() => !!held.finish);
  const stopped = h.engine.stop();
  held.finish({ status: 200, body: {} });
  await stopped;
  assert.equal(h.values.redditUnsaveState.status, "stopped_by_user");
  assert.deepEqual(h.values.redditUnsaveSession.queue, ["a2"]);
  assert.equal(site.unsaves.length, 1);
  assert.equal(h.lock.held, false);
});

test("messages: get-state reports the listing account; reset is refused while a run is live", async () => {
  const held = heldUnsave();
  const site = fakeReddit({ listing: [nsfw("a1")], unsave: held.unsave });
  const h = harness({ site }); await tick();
  const ask = (type) => new Promise((resolve) => h.listeners[0]({ type }, {}, resolve));
  const idle = await ask("reddit-unsave:get-state");
  assert.equal(idle.account, "jawad");
  assert.equal(idle.live, false);
  await h.engine.start(); await until(() => !!held.finish);
  assert.equal((await ask("reddit-unsave:reset")).reason, "stop-first");
  assert.equal((await ask("reddit-unsave:get-state")).live, true);
  held.finish({ status: 200, body: {} });
  await until(() => h.values.redditUnsaveState?.status === "completed");
  assert.equal((await ask("reddit-unsave:reset")).ok, true);
  assert.equal((await ask("reddit-unsave:get-state")).state, null);
});
