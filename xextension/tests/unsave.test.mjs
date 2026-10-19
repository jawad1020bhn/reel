import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import removal from "../bookmarks.js";
import pacing from "../pacing.js";
const code = readFileSync(new URL("../unsave.js", import.meta.url), "utf8");
const page = (ids) => ({ data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: "TimelineAddEntries", entries: ids.map((id) => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result: { __typename: "Tweet", rest_id: id, legacy: { full_text: `Post ${id}` } } } } } })) }] } } } });
const tick = () => new Promise((done) => setImmediate(done));
async function until(check) { for (let n = 0; n < 300; n++) { if (check()) return; await new Promise((r) => setTimeout(r, 2)); } throw new Error("Engine condition timed out"); }
function leasePool() {
  let held = false;
  return { async acquire() { if (held) return null; held = true; return () => { held = false; }; }, get held() { return held; } };
}
function harness({ data = {}, lock = leasePool(), failBackup = false, execute, scan, pathname = "/i/bookmarks", cookie = "twid=u%3D42; ct0=test", now = Date.now } = {}) {
  const values = structuredClone(data), messages = [], listeners = new Map();
  let active = 0, maxActive = 0;
  const remaining = new Set(["101", "102"]);
  const window = { addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
    postMessage(msg) {
      if (msg.source !== "x-unsave-bridge") return;
      messages.push(msg);
      Promise.resolve().then(async () => {
        let result;
        if (msg.type === "scan") result = scan ? await scan(msg) : { status: 200, body: page([...remaining]) };
        else if (msg.type === "forget") result = { ok: true };
        else {
          active++; maxActive = Math.max(active, maxActive);
          assert.ok(values[`xUnsavePost.42.${msg.tweetId}`], "durable backup exists BEFORE a mutation");
          assert.ok(values.xUnsaveBackup.ids.includes(msg.tweetId));
          result = execute ? await execute(msg) : { status: 200, body: { data: { tweet_bookmark_delete: "Done" } } };
          if (removal.classify(result) === "ok") remaining.delete(msg.tweetId);
          active--;
        }
        for (const listener of listeners.get("message") || []) listener({ source: window, origin: "https://x.com", data: { source: "x-unsave-bridge-result", id: msg.id, ...result } });
      }).catch((error) => { for (const listener of listeners.get("message") || []) listener({ source: window, origin: "https://x.com", data: { source: "x-unsave-bridge-result", id: msg.id, outcome: "unconfirmed", detail: error.message } }); });
    },
  };
  const storage = {
    async get(keys) { const wanted = typeof keys === "string" ? [keys] : keys; return structuredClone(Object.fromEntries(wanted.map((key) => [key, values[key]]))); },
    async set(patch) { if (failBackup && Object.keys(patch).some((key) => key.startsWith("xUnsavePost."))) throw new Error("disk full"); Object.assign(values, structuredClone(patch)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
  };
  const location = { origin: "https://x.com", pathname }, document = { cookie };
  const session = new Map();
  const context = vm.createContext({ console: { warn() {} }, window, location, document, crypto: { randomUUID: () => "test-owner" },
    chrome: { storage: { local: storage }, runtime: { sendMessage: async () => {}, onMessage: { addListener() {} } } },
    sessionStorage: { getItem: (key) => session.get(key), setItem: (key, val) => session.set(key, val), removeItem: (key) => session.delete(key) },
    XEngineLock: lock, XBookmarkRemoval: removal,
    XPacing: { ...pacing, createPacer: () => ({ next: () => ({ kind: "steady", delayMs: 0 }), onAction() {} }) },
    // Keep long bridge deadlines real; shorten only planned waits in tests.
    setTimeout: (fn, ms) => setTimeout(fn, ms === 40000 ? 1500 : Math.min(ms, 1)), clearTimeout, setInterval, clearInterval,
    Date: class extends Date { static now() { return now(); } },
  });
  vm.runInContext(code, context);
  return { engine: vm.runInContext("US", context), values, messages, remaining, lock, location, document, storage, get maxActive() { return maxActive; } };
}

test("unsave backs up before writing, sends one mutation at a time and verifies an empty live head twice", async () => {
  const h = harness(); await tick();
  assert.equal((await h.engine.start()).ok, true);
  await until(() => h.values.xUnsaveState?.status === "completed");
  assert.equal(h.values.xUnsaveState.stats.unsaved, 2);
  assert.equal(h.maxActive, 1);
  assert.deepEqual(h.messages.filter((m) => m.type === "exec").map((m) => m.tweetId), ["101", "102"]);
  assert.ok(h.messages.filter((m) => m.type === "scan").length >= 3);
  assert.equal(h.values["xUnsavePost.42.101"].outcome, "unsaved");
  assert.equal(h.values.xUnsaveSession, undefined);
  assert.equal(h.lock.held, false);
});

test("pause waits for the in-flight mutation, preserves the rest, and resumes exactly", async () => {
  let finish;
  const h = harness({ execute: () => new Promise((resolve) => { finish = resolve; }) }); await tick();
  await h.engine.start();
  await until(() => !!finish);
  let paused = false;
  const pause = h.engine.pause().then(() => { paused = true; });
  await tick(); assert.equal(paused, false);
  finish({ status: 200, body: { data: { tweet_bookmark_delete: "Done" } } });
  await pause;
  assert.equal(h.values.xUnsaveState.status, "paused");
  assert.deepEqual(h.values.xUnsaveSession.queue, ["102"]);
  assert.equal(h.lock.held, false);
  const resumed = harness({ data: h.values, scan: async () => ({ status: 200, body: page([]) }) }); await tick();
  assert.equal((await resumed.engine.start()).resumed, true);
  await until(() => resumed.values.xUnsaveState?.status === "completed");
  assert.deepEqual(resumed.messages.filter((m) => m.type === "exec").map((m) => m.tweetId), ["102"]);
});

test("unknown success bodies and missing operations stop with the original target still queued", async () => {
  for (const result of [{ status: 200, body: {} }, { outcome: "calibration-needed" }, { status: 403 }]) {
    const h = harness({ execute: async () => result }); await tick(); await h.engine.start();
    await until(() => h.values.xUnsaveState?.status === "stopped_by_error");
    assert.equal(h.values.xUnsaveState.stats.unsaved, 0);
    assert.deepEqual(h.values.xUnsaveSession.queue, ["101", "102"]);
    assert.equal(h.messages.filter((m) => m.type === "exec").length, 1);
    assert.equal(h.lock.held, false);
  }
});

test("a storage failure cannot lead to an unbacked removal", async () => {
  const h = harness({ failBackup: true }); await tick(); await h.engine.start();
  await until(() => h.values.xUnsaveState?.status === "stopped_by_error");
  assert.equal(h.messages.filter((m) => m.type === "exec").length, 0);
  assert.equal(h.values.xUnsaveState.lastStopReason, "storage-error");
  assert.equal(h.lock.held, false);
});

test("429 backs off and retries the same ID, never marking a rate limit as removed", async () => {
  let tries = 0;
  const h = harness({ execute: async () => ++tries === 1 ? { status: 429 } : { status: 200, body: { data: { tweet_bookmark_delete: "Done" } } } }); await tick(); await h.engine.start();
  await until(() => h.values.xUnsaveState?.status === "completed");
  assert.deepEqual(h.messages.filter((m) => m.type === "exec").map((m) => m.tweetId), ["101", "101", "102"]);
  assert.equal(h.values.xUnsaveState.stats.rateLimits, 1);
  assert.equal(h.values.xUnsaveState.stats.unsaved, 2);
});

test("a second tab or engine cannot run concurrently; account and folder changes are refused", async () => {
  const lock = leasePool(), hold = await lock.acquire();
  const h = harness({ lock }); await tick();
  assert.equal((await h.engine.start()).reason, "engine-busy");
  hold();
  h.location.pathname = "/i/bookmarks/folder/1";
  assert.equal((await h.engine.start()).reason, "open-bookmarks");
  h.location.pathname = "/i/bookmarks";
  h.values.xUnsaveSession = { accountId: "another", savedAt: Date.now() };
  assert.equal((await h.engine.start()).reason, "account-changed");
  assert.equal(lock.held, false);
  assert.equal(h.messages.length, 0);
});

test("account switch during discovery stops before any mutation; unknown modules never mean complete", async () => {
  let h;
  h = harness({ scan: async () => { h.document.cookie = "twid=u%3D99"; return { status: 200, body: page(["101"]) }; } }); await tick(); await h.engine.start();
  await until(() => h.values.xUnsaveState?.status === "stopped_by_error");
  assert.equal(h.values.xUnsaveState.lastStopReason, "account-changed");
  assert.equal(h.messages.filter((m) => m.type === "exec").length, 0);
  const stale = harness({ scan: async () => ({ status: 200, body: { data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: "TimelineNewSchema", entries: [] }] } } } } }) });
  await tick(); await stale.engine.start();
  await until(() => stale.values.xUnsaveState?.status === "paused");
  assert.equal(stale.values.xUnsaveState.lastStopReason, "verification-needed");
});

test("reset removes only unsave records, not captured bookmarks or unfollow backup", async () => {
  const h = harness({ data: { xBookmarks: [{ tweet_id: "keep" }], xUnfollowBackup: { entries: ["keep"] } } }); await tick(); await h.engine.start();
  await until(() => h.values.xUnsaveState?.status === "completed");
  assert.equal((await h.engine.reset()).ok, true);
  assert.deepEqual(h.values.xBookmarks, [{ tweet_id: "keep" }]);
  assert.deepEqual(h.values.xUnfollowBackup, { entries: ["keep"] });
  assert.ok(!Object.keys(h.values).some((key) => key.startsWith("xUnsave")));
});

test("attempt budget pauses at a resumable checkpoint instead of grinding indefinitely", async () => {
  const h = harness(); await tick(); h.engine.config.maxRunCount = 1;
  await h.engine.start();
  await until(() => h.values.xUnsaveState?.status === "paused");
  assert.equal(h.values.xUnsaveState.lastStopReason, "run-cap");
  assert.equal(h.values.xUnsaveState.stats.unsaved, 1);
  assert.deepEqual(h.values.xUnsaveSession.queue, ["102"]);
  assert.equal(h.lock.held, false);
  h.engine.config.maxRunCount = 5;
  await h.engine.start();
  await until(() => h.values.xUnsaveState?.status === "completed");
  assert.equal(h.values.xUnsaveState.stats.unsaved, 2);
});

test("Stop also waits for the last write, saves the remaining queue and never sends a second removal", async () => {
  let finish;
  const h = harness({ execute: () => new Promise((resolve) => { finish = resolve; }) }); await tick();
  await h.engine.start(); await until(() => !!finish);
  const stopped = h.engine.stop();
  finish({ status: 200, body: { data: { tweet_bookmark_delete: "Done" } } });
  await stopped;
  assert.equal(h.values.xUnsaveState.status, "stopped_by_user");
  assert.deepEqual(h.values.xUnsaveSession.queue, ["102"]);
  assert.equal(h.messages.filter((m) => m.type === "exec").length, 1);
});
