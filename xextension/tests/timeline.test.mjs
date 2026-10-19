import test from "node:test";
import assert from "node:assert/strict";
import timeline from "../timeline.js";

const tweet = (id, text = `post ${id}`) => ({
  __typename: "Tweet",
  rest_id: String(id),
  legacy: { full_text: text },
});

const timelineJson = (entries) => ({
  data: {
    bookmark_timeline_v2: {
      timeline: {
        instructions: [{ type: "TimelineAddEntries", entries }],
      },
    },
  },
});

test("extracts unique bookmark tweets and the bottom cursor", () => {
  const json = timelineJson([
    { entryId: "tweet-101", content: { itemContent: { tweet_results: { result: tweet(101) } } } },
    { entryId: "tweet-102", content: { itemContent: { tweet_results: { result: { __typename: "TweetWithVisibilityResults", tweet: tweet(102) } } } } },
    { entryId: "tweet-101", content: { itemContent: { tweet_results: { result: tweet(101) } } } },
    { entryId: "cursor-bottom-token", content: { operation: { cursor: { cursorType: "Bottom", value: "next-page" } } } },
  ]);

  const page = timeline.extractPage(json);
  assert.equal(page.recognized, true);
  assert.deepEqual(page.tweets.map((item) => item.rest_id), ["101", "102"]);
  assert.equal(page.hasBottomCursor, true);
  assert.equal(page.bottomCursor, "next-page");
  assert.equal(page.entryCount, 4);
});

test("reads posts inside timeline modules and keeps deleted bookmark identity", () => {
  const json = timelineJson([
    {
      entryId: "profile-conversation-1",
      content: {
        items: [{ item: { itemContent: { tweet_results: { result: tweet(303) } } } }],
      },
    },
    { entryId: "tweet-404", content: { tombstone: { text: "Post unavailable" } } },
  ]);

  const page = timeline.extractPage(json);
  assert.deepEqual(page.tweets.map((item) => item.rest_id), ["303", "404"]);
  assert.equal(page.tweets[1].legacy.full_text, undefined);
});

test("ignores unrelated GraphQL timelines instead of collecting arbitrary tweets", () => {
  const json = {
    data: {
      home: { timeline: { instructions: [{ entries: [
        { entryId: "tweet-999", content: { itemContent: { tweet_results: { result: tweet(999) } } } },
      ] }] } },
    },
  };

  const page = timeline.extractPage(json);
  assert.equal(page.recognized, false);
  assert.deepEqual(page.tweets, []);
});
