import test from "node:test";
import assert from "node:assert/strict";
import following from "../following.js";

const user = (id, screenName, legacy = {}) => ({
  __typename: "User",
  rest_id: String(id),
  legacy: { screen_name: screenName, name: screenName.toUpperCase(), following: true, ...legacy },
});

const followingJson = (entries) => ({
  data: {
    user: {
      result: {
        __typename: "User",
        timeline_v2: {
          timeline: {
            instructions: [{ type: "TimelineAddEntries", entries }],
          },
        },
      },
    },
  },
});

const userEntry = (id, record) => ({
  entryId: `user-${id}`,
  content: {
    entryType: "TimelineTimelineItem",
    itemContent: { user_results: { result: record } },
  },
});

test("extracts followed accounts and the bottom cursor from a Following page", () => {
  const json = followingJson([
    userEntry(101, user(101, "alice")),
    userEntry(102, user(102, "bob", { protected: true })),
    { entryId: "cursor-bottom-token", content: { operation: { cursor: { cursorType: "Bottom", value: "next-page" } } } },
  ]);

  const page = following.extractPage(json);
  assert.equal(page.recognized, true);
  assert.deepEqual(page.users.map((u) => u.screen_name), ["alice", "bob"]);
  assert.equal(page.userEntryCount, 2);
  assert.equal(page.hasBottomCursor, true);
  assert.equal(page.bottomCursor, "next-page");
  assert.equal(page.users[0].following, true);
});

test("dedupes accounts by user id across repeated entries", () => {
  const json = followingJson([
    userEntry(101, user(101, "alice")),
    userEntry(101, user(101, "alice")),
    userEntry(102, user(102, "bob")),
  ]);

  const page = following.extractPage(json);
  assert.deepEqual(page.users.map((u) => u.user_id), ["101", "102"]);
});

test("never treats who-to-follow recommendations as unfollow targets", () => {
  const json = followingJson([
    userEntry(101, user(101, "alice")),
    {
      entryId: "userrecommendation-202",
      content: {
        items: [{
          item: { itemContent: { user_results: { result: user(202, "suggested", { following: false }) } } },
        }],
      },
    },
  ]);

  const page = following.extractPage(json);
  assert.deepEqual(page.users.map((u) => u.user_id), ["101"]);
  assert.equal(page.recommendationCount, 1);
});

test("keeps a following row X marks stale (following:false) identifiable", () => {
  const json = followingJson([
    userEntry(101, user(101, "stale", { following: false })),
    userEntry(102, user(102, "bob")),
  ]);

  const page = following.extractPage(json);
  assert.equal(page.users.find((u) => u.user_id === "101").following, false);
  assert.equal(page.users.find((u) => u.user_id === "102").following, true);
});

test("extracts users from timeline modules nested in the list", () => {
  const json = followingJson([
    {
      entryId: "homeConversation-0-303",
      content: {
        items: [{ item: { itemContent: { user_results: { result: user(303, "modular") } } } }],
      },
    },
  ]);

  const page = following.extractPage(json);
  // entryId is not `user-<digits>` but legacy.following vouches for the row.
  assert.deepEqual(page.users.map((u) => u.user_id), ["303"]);
});

test("a profile tweets timeline is recognized but carries zero follow targets", () => {
  const json = {
    data: {
      user: {
        result: {
          timeline: {
            timeline: {
              instructions: [{
                type: "TimelineAddEntries",
                entries: [{
                  entryId: "tweet-999",
                  content: { itemContent: { tweet_results: { result: { __typename: "Tweet", rest_id: "999", legacy: {} } } } },
                }],
              }],
            },
          },
        },
      },
    },
  };

  const page = following.extractPage(json);
  assert.equal(page.recognized, true);
  assert.equal(page.tweetEntryCount, 1);
  assert.equal(page.userEntryCount, 0);
  assert.deepEqual(page.users, []);
});

test("ignores unrelated GraphQL payloads (home, bookmarks)", () => {
  const home = {
    data: { home: { timeline: { instructions: [{ type: "TimelineAddEntries", entries: [] }] } } },
  };
  const bookmarks = {
    data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: "TimelineAddEntries", entries: [] }] } } },
  };

  assert.equal(following.extractPage(home).recognized, false);
  assert.equal(following.extractPage(bookmarks).recognized, false);
});

test("resolveUser falls back to core fields and requires a numeric id", () => {
  const resolved = following.resolveUser({
    rest_id: "42",
    core: { screen_name: "core_name", name: "Core Name" },
    legacy: {},
  });
  assert.equal(resolved.screen_name, "core_name");
  assert.equal(resolved.following, null); // absent → tri-state null, not false

  assert.equal(following.resolveUser({ legacy: { screen_name: "no-id" } }), null);
  assert.equal(following.resolveUser(null), null);
});
