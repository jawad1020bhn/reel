/*
 * Bookmark timeline response reader.
 * Only the authenticated Bookmarks timeline is accepted; generic GraphQL Tweet
 * objects (recommendations, sidebars, etc.) are intentionally ignored.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XBookmarkTimeline = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TIMELINE_PATHS = [
    ["data", "bookmark_timeline_v2", "timeline"],
    ["data", "bookmark_timeline", "timeline"],
    ["data", "bookmark_collection_timeline", "timeline"],
    ["data", "bookmark_timeline_v2"],
    ["data", "bookmark_timeline"],
    ["data", "bookmark_collection_timeline"],
  ];

  function atPath(object, path) {
    let value = object;
    for (const key of path) {
      if (!value || typeof value !== "object") return null;
      value = value[key];
    }
    return value && typeof value === "object" ? value : null;
  }

  function findTimeline(json) {
    for (const path of TIMELINE_PATHS) {
      const candidate = atPath(json, path);
      if (!candidate) continue;
      const instructions = Array.isArray(candidate.instructions)
        ? candidate.instructions
        : Array.isArray(candidate.timeline?.instructions)
          ? candidate.timeline.instructions
          : null;
      if (instructions) return { path: path.join("."), timeline: candidate, instructions };
    }
    return null;
  }

  function asTweet(result) {
    if (!result || typeof result !== "object") return null;
    if (result.__typename === "TweetWithVisibilityResults" && result.tweet) {
      return asTweet(result.tweet);
    }
    if (result.__typename === "Tweet" && result.rest_id) return result;
    // A bookmark can remain in the timeline after its post is deleted or
    // withheld. Preserve its identity as an unavailable record rather than
    // silently dropping that slot.
    if (result.rest_id && /^\d+$/.test(String(result.rest_id))) {
      return { __typename: "Tweet", rest_id: String(result.rest_id), legacy: {}, core: {} };
    }
    return null;
  }

  function tweetsFromEntry(entry) {
    const tweets = [];
    const stack = [entry?.content || entry];
    const visited = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || visited.has(node)) continue;
      visited.add(node);
      if (Array.isArray(node)) {
        for (const item of node) stack.push(item);
        continue;
      }

      if (node.tweet_results && Object.prototype.hasOwnProperty.call(node.tweet_results, "result")) {
        const tweet = asTweet(node.tweet_results.result);
        if (tweet) tweets.push(tweet);
        // Do not walk into the tweet itself: its quoted/retweeted post is not a
        // separate bookmark entry.
        continue;
      }
      if (node.__typename === "Tweet" && node.rest_id) {
        const tweet = asTweet(node);
        if (tweet) tweets.push(tweet);
        continue;
      }
      if (node.__typename === "TweetWithVisibilityResults" && node.tweet) {
        const tweet = asTweet(node);
        if (tweet) tweets.push(tweet);
        continue;
      }

      for (const [key, value] of Object.entries(node)) {
        if (key === "tweet_results" || key === "legacy" || key === "core") continue;
        if (value && typeof value === "object") stack.push(value);
      }
    }

    if (!tweets.length) {
      const entryId = String(entry?.entryId || "");
      const match = entryId.match(/^tweet-(\d+)(?:$|[-_])/);
      if (match) tweets.push({ __typename: "Tweet", rest_id: match[1], legacy: {}, core: {} });
    }
    return tweets;
  }

  function entriesFromInstruction(instruction) {
    const entries = [];
    if (Array.isArray(instruction?.entries)) entries.push(...instruction.entries);
    if (instruction?.entry && typeof instruction.entry === "object") entries.push(instruction.entry);
    if (Array.isArray(instruction?.moduleItems)) entries.push(...instruction.moduleItems);
    return entries;
  }

  function collectCursor(entry, cursors) {
    const entryId = String(entry?.entryId || "");
    let type = /cursor-bottom/i.test(entryId) ? "Bottom" : /cursor-top/i.test(entryId) ? "Top" : "";
    const stack = [entry?.content || entry];
    const visited = new Set();
    let value = "";
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || visited.has(node)) continue;
      visited.add(node);
      if (Array.isArray(node)) {
        for (const item of node) stack.push(item);
        continue;
      }
      if (node.cursorType) type = String(node.cursorType);
      if (typeof node.value === "string" && (node.cursorType || type)) value = node.value;
      if (node.cursor && typeof node.cursor === "object") {
        if (node.cursor.cursorType) type = String(node.cursor.cursorType);
        if (typeof node.cursor.value === "string") value = node.cursor.value;
      }
      for (const [key, child] of Object.entries(node)) {
        if (key === "tweet_results" || key === "legacy" || key === "core") continue;
        if (child && typeof child === "object") stack.push(child);
      }
    }
    if (type || value || /^cursor-/i.test(entryId)) {
      if (!type) type = /bottom/i.test(entryId) ? "Bottom" : /top/i.test(entryId) ? "Top" : "Unknown";
      cursors.push({ type, value, entryId });
    }
  }

  function extractPage(json) {
    const found = findTimeline(json);
    if (!found) {
      return { recognized: false, path: null, tweets: [], cursors: [], hasBottomCursor: false, bottomCursor: "", entryCount: 0 };
    }

    const candidates = [];
    const cursors = [];
    for (const instruction of found.instructions) {
      for (const entry of entriesFromInstruction(instruction)) {
        candidates.push(...tweetsFromEntry(entry));
        collectCursor(entry, cursors);
      }
    }

    const byId = new Map();
    for (const tweet of candidates) {
      const id = String(tweet?.rest_id || "");
      if (id && !byId.has(id)) byId.set(id, tweet);
    }
    const bottom = [...cursors].reverse().find((cursor) => /bottom/i.test(cursor.type));

    return {
      recognized: true,
      path: found.path,
      tweets: [...byId.values()],
      cursors,
      hasBottomCursor: !!bottom,
      bottomCursor: bottom?.value || "",
      entryCount: found.instructions.reduce((sum, instruction) => sum + entriesFromInstruction(instruction).length, 0),
    };
  }

  return { extractPage, findTimeline, asTweet };
});
