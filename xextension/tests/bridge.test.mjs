import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const code = readFileSync(new URL("../bridge.js", import.meta.url), "utf8");
const tick = () => new Promise((done) => setImmediate(done));
function harness({ bundles = '', cookie = "twid=u%3D42; ct0=test-csrf", fetch: customFetch } = {}) {
  const listeners = [], replies = [], calls = [];
  const location = { origin: "https://x.com", href: "https://x.com/i/bookmarks", pathname: "/i/bookmarks" };
  const document = { cookie, scripts: bundles ? [{ src: "https://abs.twimg.com/responsive-web/client-web/main.test.js" }] : [] };
  class XHR { open() {} setRequestHeader() {} send() {} }
  const window = { XMLHttpRequest: XHR, addEventListener: (_type, fn) => listeners.push(fn), postMessage: (msg) => replies.push(msg),
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), ...init });
      if (String(url).includes("abs.twimg.com")) return new Response(bundles);
      if (customFetch) return customFetch(url, init);
      return new Response(JSON.stringify({ data: { tweet_bookmark_delete: "Done" } }), { headers: { "Content-Type": "application/json" } });
    },
  };
  vm.runInNewContext(code, { window, document, location, performance: { getEntriesByType: () => [] }, URL, AbortSignal, console });
  let seq = 0;
  async function rpc(payload, channel = "x-unsave-bridge") {
    const id = ++seq;
    for (const fn of listeners) fn({ source: window, origin: location.origin, data: { source: channel, id, ...payload } });
    for (let n = 0; n < 100; n++) { const result = replies.find((r) => r.id === id); if (result) return result; await tick(); }
    throw new Error("Missing bridge response");
  }
  const observe = (operation, queryId = "observed-operation-1234", init = {}) => window.fetch(`https://x.com/i/api/graphql/${queryId}/${operation}?variables=${encodeURIComponent(JSON.stringify({ count: 20, cursor: "old-cursor" }))}&features=%7B%22test%22%3Atrue%7D`, { headers: { authorization: "Bearer test-client", "x-csrf-token": "observed-csrf" }, ...init });
  return { rpc, observe, calls, location, document };
}

test("bookmark bridge learns X's own operation and sends one exact tweet ID with same-session auth", async () => {
  const h = harness();
  await h.observe("DeleteBookmark", "delete-operation-1234");
  await h.observe("UnfollowUser", "unfollow-operation-1234");
  const result = await h.rpc({ type: "exec", accountId: "42", tweetId: "101" });
  assert.equal(result.body.data.tweet_bookmark_delete, "Done");
  const call = h.calls.at(-1);
  assert.ok(call.url.endsWith("/delete-operation-1234/DeleteBookmark"));
  assert.equal(call.method, "POST");
  assert.equal(call.credentials, "include");
  assert.equal(call.headers.authorization, "Bearer test-client");
  assert.equal(call.headers["x-csrf-token"], "observed-csrf");
  assert.deepEqual(JSON.parse(call.body), { variables: { tweet_id: "101" }, queryId: "delete-operation-1234" });
});

test("live-head scan removes old cursors but preserves X's features and count", async () => {
  const h = harness(); await h.observe("Bookmarks");
  await h.rpc({ type: "scan", accountId: "42" });
  const head = new URL(h.calls.at(-1).url);
  assert.deepEqual(JSON.parse(head.searchParams.get("variables")), { count: 20 });
  assert.deepEqual(JSON.parse(head.searchParams.get("features")), { test: true });
  await h.rpc({ type: "scan", accountId: "42", cursor: "next-page" });
  assert.equal(JSON.parse(new URL(h.calls.at(-1).url).searchParams.get("variables")).cursor, "next-page");
});

test("bundle discovery keeps DeleteBookmark and UnfollowUser caches separate and supports X-owned script host", async () => {
  const h = harness({ bundles: '{queryId:"delete-bundle-operation-1234",operationName:"DeleteBookmark"}' });
  await h.observe("UnfollowUser", "unfollow-operation-1234");
  await h.rpc({ type: "exec", accountId: "42", tweetId: "101" });
  assert.ok(h.calls.at(-1).url.endsWith("/delete-bundle-operation-1234/DeleteBookmark"));
  await h.rpc({ type: "forget" });
  const ping = await h.rpc({ type: "ping" }, "x-unfollow-bridge");
  assert.equal(ping.queryId, "unfollow-operation-1234");
});

test("bridge refuses different accounts, folder routes and unknown mutation IDs without a fallback write", async () => {
  const h = harness();
  assert.equal((await h.rpc({ type: "exec", accountId: "99", tweetId: "101" })).outcome, "account-changed");
  h.location.pathname = "/i/bookmarks/folder/1";
  assert.equal((await h.rpc({ type: "exec", accountId: "42", tweetId: "101" })).outcome, "open-bookmarks");
  h.location.pathname = "/i/bookmarks";
  assert.equal((await h.rpc({ type: "exec", accountId: "42", tweetId: "101" })).outcome, "calibration-needed");
  assert.equal(h.calls.length, 0, "no guessed bulk endpoint or REST fallback");
});

test("bridge single-flight gate rejects overlapping requests", async () => {
  let finish;
  const h = harness({ fetch: async (url, init) => init.method === "POST" ? new Promise((resolve) => { finish = () => resolve(new Response('{"data":{"tweet_bookmark_delete":"Done"}}')); }) : new Response("{}") });
  await h.observe("DeleteBookmark");
  const first = h.rpc({ type: "exec", accountId: "42", tweetId: "101" });
  await tick();
  const second = await h.rpc({ type: "exec", accountId: "42", tweetId: "102" });
  assert.equal(second.outcome, "bridge-busy");
  finish(); await first;
  assert.equal(h.calls.filter((c) => c.method === "POST").length, 1);
});

test("browser-owned engine lock is exclusive across documents and releasable", async () => {
  let held = false;
  const navigator = { locks: { async request(_name, _options, fn) {
    if (held) return fn(null);
    held = true;
    try { await fn({ name: "engine" }); } finally { held = false; }
  } } };
  const code = readFileSync(new URL("../engine-lock.js", import.meta.url), "utf8");
  const first = vm.createContext({ navigator }), second = vm.createContext({ navigator });
  vm.runInContext(code, first); vm.runInContext(code, second);
  const lease = await first.XEngineLock.acquire();
  assert.equal(await second.XEngineLock.acquire(), null);
  lease(); await tick();
  const next = await second.XEngineLock.acquire();
  assert.equal(typeof next, "function"); next(); await tick();
  assert.equal(held, false);
});

test("existing UnfollowUser execution still works and shares the cross-operation single-flight gate", async () => {
  let finish;
  const h = harness({ fetch: async (_url, init) => init.method === "POST" ? new Promise((resolve) => { finish = () => resolve(new Response('{"data":{"user":{"result":{"legacy":{"following":false}}}}}')); }) : new Response("{}") });
  await h.observe("UnfollowUser", "unfollow-existing-operation");
  const first = h.rpc({ type: "exec", userId: "501" }, "x-unfollow-bridge");
  await tick();
  assert.equal((await h.rpc({ type: "exec", accountId: "42", tweetId: "101" })).outcome, "bridge-busy");
  const call = h.calls.at(-1);
  assert.ok(call.url.endsWith("/unfollow-existing-operation/UnfollowUser"));
  assert.equal(JSON.parse(call.body).variables.userId, "501");
  finish(); assert.equal((await first).status, 200);
});

test("bookmark rate-limit replies preserve the server's Retry-After boundary", async () => {
  const h = harness({ fetch: async (_url, init) => init.method === "POST" ? new Response('{}', { status: 429, headers: { "Retry-After": "60" } }) : new Response("{}") });
  await h.observe("DeleteBookmark");
  const before = Date.now();
  const result = await h.rpc({ type: "exec", accountId: "42", tweetId: "101" });
  assert.equal(result.status, 429);
  assert.ok(result.retryAt >= before + 60000);
});
