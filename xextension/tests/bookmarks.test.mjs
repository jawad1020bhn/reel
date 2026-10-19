import test from "node:test";
import assert from "node:assert/strict";
import removal from "../bookmarks.js";
const tweet = (id, extra = {}) => ({ __typename: "Tweet", rest_id: id, legacy: { full_text: "A post" }, ...extra });
const entry = (id, result = tweet(id)) => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result } } } });
const timeline = (entries, extra = {}) => ({ data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: "TimelineAddEntries", entries }] } } }, ...extra });

test("removal targets exact main-bookmark entries, not quoted tweets or recommendation modules", () => {
  const json = timeline([entry("101", tweet("101", { quoted_status_result: { result: tweet("202") } })), entry("101"),
    { entryId: "recommendations", content: { items: [entry("999")] } },
    { entryId: "tweet-303", content: { tombstone: {} } },
    entry("404", { __typename: "TweetWithVisibilityResults", tweet: tweet("404") }),
    { entryId: "cursor-bottom-1", content: { cursorType: "Bottom", value: "next" } },
  ]);
  const page = removal.extractPage(json);
  assert.deepEqual(page.posts.map((p) => p.tweet_id), ["101", "303", "404"]);
  assert.equal(page.bottomCursor, "next");
  assert.equal(page.empty, false);
  assert.ok(page.unknown, "unrecognized modules preclude an empty-feed claim");
});

test("folders, home responses, errors and unknown shapes cannot look like an empty main feed", () => {
  const folder = { data: { bookmark_collection_timeline: timeline([]).data.bookmark_timeline_v2 } };
  for (const json of [folder, {}, { data: { home: {} } }, timeline([], { errors: [{ code: 88 }] })]) assert.equal(removal.extractPage(json).recognized, false);
  assert.equal(removal.extractPage(timeline([{ entryId: "new-schema", content: {} }])).empty, false);
  assert.equal(removal.extractPage(timeline([entry("1", tweet("2"))])).empty, false, "mismatched identity cannot be targeted");
  assert.equal(removal.extractPage(timeline([])).empty, true);
});

test("only an explicit DeleteBookmark Done payload confirms a removal", () => {
  const classify = (status, body) => removal.classify({ status, body });
  assert.equal(classify(200, { data: { tweet_bookmark_delete: "Done" } }), "ok");
  for (const body of [null, {}, { data: {} }, { data: { tweet_bookmark_delete: null } }]) assert.equal(classify(200, body), "unconfirmed");
  assert.equal(classify(200, { errors: [{ code: 88 }] }), "rate-limited");
  assert.equal(classify(429, {}), "rate-limited");
  assert.equal(classify(403, {}), "auth-error");
  assert.equal(classify(200, { errors: [{ code: 326 }] }), "auth-error");
  assert.equal(classify(503, {}), "server-error");
  assert.equal(classify(404, {}), "stale-queryid");
  assert.equal(classify(0, null), "network-error");
  assert.equal(removal.classify({ outcome: "calibration-needed" }), "calibration-needed");
});

test("account identity is exact and safely decoded", () => {
  assert.equal(removal.accountId("ct0=token; twid=u%3D12345; lang=en"), "12345");
  for (const cookie of ["", "twid=other", "twid=u%3Dinvalid", "twid=%broken"]) assert.equal(removal.accountId(cookie), null);
});
