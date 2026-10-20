import test from "node:test";
import assert from "node:assert/strict";
import removal from "../reddit-removal.js";
import saved from "../reddit-saved.js";
import dom from "../reddit-dom.js";

const MODHASH = "abcdef0123456789abcdef";

function row(overrides = {}) {
  return {
    fullname: "t3_abc123",
    className: "thing link over18",
    nsfw: "true",
    title: "A saved title",
    subreddit: "r/ExampleSub",
    author: "someone",
    permalink: "/r/ExampleSub/comments/abc123/a_saved_title/",
    url: "https://i.redd.it/xyz.jpg",
    domain: "i.redd.it",
    score: "42",
    comments: "7",
    timestamp: 1700000000000,
    thumbnail: "",
    isGallery: "",
    ...overrides,
  };
}

test("identity: /api/me.json names the session, carries the modhash and the NSFW preference", () => {
  const who = saved.parseIdentity({ kind: "t2", data: { name: "Jawad", modhash: MODHASH, over_18: true } });
  assert.deepEqual(who, { loggedIn: true, name: "Jawad", modhash: MODHASH, over18: true });
  assert.deepEqual(saved.parseIdentity({}), { loggedIn: false, name: null, modhash: null, over18: null });
  assert.deepEqual(saved.parseIdentity(null), { loggedIn: false, name: null, modhash: null, over18: null });
  const noPref = saved.parseIdentity({ data: { name: "x", modhash: MODHASH } });
  assert.equal(noPref.over18, null, "an absent preference is unknown, not false");
  assert.equal(saved.parseIdentity({ data: { name: "x", modhash: "short" } }).modhash, null, "a malformed modhash is never used");
});

test("listing head: canonical old.reddit saved URL for a valid account only", () => {
  assert.equal(saved.savedListingUrl("jawad"), "https://old.reddit.com/user/jawad/saved/");
  assert.equal(saved.savedListingUrl("bad name"), null);
  assert.equal(saved.savedListingUrl(""), null);
});

test("promoted rows are ads, never saved items — not captured and never a removal target", () => {
  assert.equal(saved.classifyRow(row({ className: "thing link promoted over18" })), "other");
  assert.equal(saved.classifyRow(row({ promoted: "true" })), "other");
  assert.equal(saved.classifyRow(row()), "nsfw-post");
});

test("request: replays old.reddit's own unsave POST; refuses comments and missing CSRF", () => {
  const request = removal.buildUnsaveRequest("t3_abc123", MODHASH);
  assert.equal(request.path, "/api/unsave");
  assert.equal(request.method, "POST");
  const params = new URLSearchParams(request.body);
  assert.equal(params.get("id"), "t3_abc123");
  assert.equal(params.get("uh"), MODHASH);
  assert.equal(params.get("executed"), "unsaved");
  assert.equal(params.get("renderstyle"), "html");
  assert.match(request.headers["content-type"], /x-www-form-urlencoded/);
  assert.equal(removal.buildUnsaveRequest("t1_comment", MODHASH), null, "comments are never unsaved");
  assert.equal(removal.buildUnsaveRequest("t3_abc123", null), null, "no request without the session modhash");
  assert.equal(removal.buildUnsaveRequest("t3_abc123", "short"), null);
  assert.equal(removal.buildUnsaveRequest("", MODHASH), null);
});

test("classify: only Reddit's explicit no-content success counts as removed", () => {
  assert.equal(removal.classify({ status: 200, body: {} }), "ok");
  assert.equal(removal.classify({ status: 200, body: { json: { errors: [] } } }), "ok");
  assert.equal(removal.classify({ status: 200, body: { success: true, jquery: [] } }), "ok");
  // Everything ambiguous retains the target.
  assert.equal(removal.classify({ status: 200, body: null, raw: "<!doctype html><html>login</html>" }), "unconfirmed");
  assert.equal(removal.classify({ status: 200, body: { something: "else" } }), "unconfirmed");
  assert.equal(removal.classify({ status: 200, body: { success: false, jquery: [[0, 1, "call", [".error.BAD_THING.field-id"]]] } }), "unconfirmed");
  assert.equal(removal.classify({ status: 200, body: [] }), "unconfirmed");
  assert.equal(removal.classify({ status: 302 }), "unconfirmed");
});

test("classify: auth, rate limits, server and transport failures in every payload shape", () => {
  assert.equal(removal.classify({ status: 403, body: { error: 403, message: "Forbidden" } }), "auth-error");
  assert.equal(removal.classify({ status: 401 }), "auth-error");
  assert.equal(removal.classify({ status: 200, body: { json: { errors: [["USER_REQUIRED", "please login to do that", null]] } } }), "auth-error");
  assert.equal(removal.classify({ status: 200, body: { jquery: [[0, 1, "call", ["please login to do that"]]], success: false } }), "auth-error");
  assert.equal(removal.classify({ status: 429 }), "rate-limited");
  assert.equal(removal.classify({ status: 200, body: { json: { errors: [["RATELIMIT", "you are doing that too much. try again in 9 minutes.", "ratelimit"]], ratelimit: 540 } } }), "rate-limited");
  assert.equal(removal.classify({ status: 200, body: { jquery: [[0, 1, "call", ["you are doing that too much. try again in 2 minutes."]]], success: false } }), "rate-limited");
  assert.equal(removal.classify({ status: 503 }), "server-error");
  assert.equal(removal.classify({ status: 0 }), "network-error");
  assert.equal(removal.classify({ status: 404 }), "endpoint-unavailable");
  assert.equal(removal.classify({ outcome: "request-timeout" }), "request-timeout");
  assert.equal(removal.classify({ outcome: "request-busy" }), "request-busy");
});

test("retryAt: honours Retry-After, Reddit's seconds-until-reset header, and json.ratelimit", () => {
  const now = 1_000_000;
  assert.equal(removal.retryAt({ "retry-after": "30" }, null, now), now + 30000);
  assert.equal(removal.retryAt({ "x-ratelimit-reset": "45" }, null, now), now + 45000);
  assert.equal(removal.retryAt(null, { json: { ratelimit: 540 } }, now), now + 540000);
  assert.equal(removal.retryAt({ "retry-after": "10", "x-ratelimit-reset": "90" }, { json: { ratelimit: 5 } }, now), now + 90000, "the longest hint wins");
  assert.equal(removal.retryAt({}, {}, now), 0);
  const headers = new Map([["retry-after", "12"]]);
  assert.equal(removal.retryAt({ get: (name) => headers.get(name) }, null, now), now + 12000, "Headers-like objects work");
});

test("extractTargets: NSFW posts only; done ids are stale, queued ids are skipped, SFW/comments/ads never targeted", () => {
  const rows = [
    row({ fullname: "t3_new1" }),
    row({ fullname: "t3_sfw", className: "thing link", nsfw: "false" }),
    row({ fullname: "t1_cmt", className: "thing comment over18" }),
    row({ fullname: "t3_ad", className: "thing link promoted over18" }),
    row({ fullname: "t3_done1" }),
    row({ fullname: "t3_queued1" }),
    row({ fullname: "t3_new1" }), // duplicated by shifted pagination
    row({ fullname: "", className: "thing" }),
  ];
  const page = removal.extractTargets(rows, { done: new Set(["done1"]), queued: new Set(["queued1"]), capturedAt: "2026-10-20T00:00:00.000Z" });
  assert.deepEqual(page.targets.map((p) => p.id), ["new1"]);
  assert.deepEqual(page.stale, ["done1"]);
  assert.deepEqual(page.counts, { rows: 8, nsfw: 4, sfw: 1, comments: 1, other: 2 });
  const target = page.targets[0];
  assert.equal(target.fullname, "t3_new1");
  assert.equal(target.nsfw, true);
  assert.equal(target.subreddit, "ExampleSub");
  assert.equal(target.captured_at, "2026-10-20T00:00:00.000Z");
  assert.deepEqual(target.media, [{ kind: "image", url: "https://i.redd.it/xyz.jpg" }]);
  assert.deepEqual(removal.extractTargets(null), { targets: [], stale: [], counts: { rows: 0, nsfw: 0, sfw: 0, comments: 0, other: 0 } });
});

test("pacing profile sits under Reddit's web-session limits and keeps the retry budget bounded", () => {
  assert.ok(removal.PACING.rateCeilingPerMin <= 15);
  assert.ok(removal.PACING.baseDelayMs >= 3000);
  assert.ok(removal.PACING.backoffBaseMs >= 10000);
  assert.ok(removal.PACING.backoffMaxRetries <= 10);
  assert.deepEqual(removal.RETRYABLE, ["rate-limited", "server-error", "network-error", "request-timeout", "request-busy"]);
});

/* A minimal element stand-in: enough of the DOM surface the readers touch. */
function fakeElement({ attrs = {}, className = "", children = {} } = {}) {
  return {
    className,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    querySelector: (selector) => children[selector] || null,
    querySelectorAll: (selector) => children[selector] || [],
    get value() { return attrs.value; },
  };
}

test("dom readers: rows, next link, listing detection, modhash and gate URLs", () => {
  const thing = fakeElement({
    className: "thing link over18",
    attrs: { "data-fullname": "t3_abc123", "data-nsfw": "true", "data-subreddit": "ExampleSub", "data-author": "someone", "data-permalink": "/r/ExampleSub/comments/abc123/x/", "data-url": "/r/ExampleSub/comments/abc123/x/", "data-domain": "self.ExampleSub", "data-score": "42", "data-comments-count": "7", "data-timestamp": "1700000000000", "data-is-gallery": "", "data-promoted": "" },
    children: { "a.title": { textContent: " A  title " }, ".thumbnail img": { getAttribute: () => "//b.thumbs.redditmedia.com/t.jpg" } },
  });
  const raw = dom.readRow(thing);
  assert.equal(raw.fullname, "t3_abc123");
  assert.equal(raw.url, "https://www.reddit.com/r/ExampleSub/comments/abc123/x/");
  assert.equal(raw.thumbnail, "https://b.thumbs.redditmedia.com/t.jpg");
  assert.equal(raw.timestamp, 1700000000000);
  assert.equal(saved.classifyRow(raw), "nsfw-post");

  const doc = fakeElement({ children: {
    ".thing": [thing],
    'a[rel~="next"]': { getAttribute: () => "/user/jawad/saved/?count=25&after=t3_abc123" },
    "#siteTable, .sitetable.linklisting": {},
    'input[name="uh"]': { value: MODHASH },
  } });
  assert.equal(dom.readRows(doc).length, 1);
  assert.equal(dom.nextHref(doc), "/user/jawad/saved/?count=25&after=t3_abc123");
  assert.equal(dom.isListing(doc), true);
  assert.equal(dom.modhash(doc), MODHASH);
  assert.equal(dom.isListing(fakeElement()), false, "a page without #siteTable is not a listing");
  assert.equal(dom.modhash(fakeElement()), null);
  assert.equal(dom.isGateUrl("https://old.reddit.com/login?dest=..."), true);
  assert.equal(dom.isGateUrl("https://old.reddit.com/over18?dest=..."), true);
  assert.equal(dom.isGateUrl("https://old.reddit.com/user/jawad/saved/"), false);
});
