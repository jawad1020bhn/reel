/*
 * Following timeline response reader.
 *
 * Counterpart to timeline.js for the mass-unfollow engine: the authenticated
 * profile "Following" list is the only accepted source of targets. Generic
 * GraphQL users (Who-to-follow modules, sidebar suggestions, ad accounts)
 * are intentionally ignored — unfollowing an account the user never followed
 * would be a correctness bug with real consequences.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XFollowingTimeline = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* Profile-timeline shapes carry the Following list. `timeline_v2` is what
     current X serves; `timeline` remains as the legacy fallback. */
  const TIMELINE_PATHS = [
    ["data", "user", "result", "timeline_v2", "timeline"],
    ["data", "user", "result", "timeline", "timeline"],
    ["data", "user", "result", "timeline_v2"],
    ["data", "user", "result", "timeline"],
  ];

  /* Module/surface markers that mean "recommendation", never "someone I
     actually follow", even when a payload sneaks a following flag along. */
  const RECOMMENDATION_PATTERN = /recommend|who[_-]to[_-]follow|suggest|interest|followed_by/i;

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

  function resolveUser(result) {
    if (!result || typeof result !== "object") return null;
    /* UserResult wrappers: current payloads nest the record under `result`,
       older ones flatten it. Accept both, require a numeric ID. */
    const legacy = result.legacy || {};
    const core = result.core || {};
    const id = String(result.rest_id || result.id_str || core.rest_id || "");
    if (!/^\d+$/.test(id)) return null;
    return {
      user_id: id,
      screen_name: legacy.screen_name || core.screen_name || null,
      name: legacy.name || core.name || null,
      profile_image_url_https:
        legacy.profile_image_url_https ||
        (result.avatar && result.avatar.image_url) ||
        (typeof result.profile_image === "string" ? result.profile_image : null),
      /* Tri-state on purpose: `false` means X affirmatively says "not
         followed" (stale row — never enqueue), `null` means the field was
         absent and the entryId rule alone vouches for the row. */
      following: typeof legacy.following === "boolean" ? legacy.following : null,
      followed_by: typeof legacy.followed_by === "boolean" ? legacy.followed_by : null,
      protected: legacy.protected === true,
      verified: legacy.verified === true || core.verified_legacy === true ||
        !!(core.verification && core.verification.verified) || false,
      default_profile_image: legacy.default_profile_image === true,
    };
  }

  /**
   * Decide whether an entry represents a followed account.
   *
   * Primary rule: `entryId` of exactly `user-<digits>` — X's own key for a
   * relationship row inside a Following timeline. Fallback rule: a User item
   * whose legacy says `following: true` with a non-recommendation entry id.
   * The who-to-follow module embedded in the same list carries
   * `following: false`, so the fallback excludes it as well.
   */
  function userFromEntry(entry) {
    const entryId = String(entry?.entryId || "");
    const stack = [entry?.content || entry];
    const visited = new Set();
    let candidate = null;
    let sawTweet = false;

    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || visited.has(node)) continue;
      visited.add(node);
      if (Array.isArray(node)) {
        for (const item of node) stack.push(item);
        continue;
      }

      if (node.tweet_results) sawTweet = true;
      if (node.__typename === "Tweet" || node.__typename === "TweetWithVisibilityResults") sawTweet = true;

      if (node.user_results && Object.prototype.hasOwnProperty.call(node.user_results, "result")) {
        const user = resolveUser(node.user_results.result);
        if (user && !candidate) candidate = user;
        continue; // never walk into the user record itself
      }

      for (const [key, value] of Object.entries(node)) {
        if (key === "legacy" || key === "core" || key === "tweet_results" || key === "user_results") continue;
        if (value && typeof value === "object") stack.push(value);
      }
    }

    if (!candidate) return null;
    const directMatch = /^user-(\d+)$/.test(entryId);
    const fallbackMatch = candidate.following && !RECOMMENDATION_PATTERN.test(entryId);
    if (!directMatch && !fallbackMatch) return null;
    if (sawTweet) return null; // a tweet row is never a follow target
    return { ...candidate, entry_id: entryId || null };
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
      return {
        recognized: false, path: null, users: [], cursors: [],
        hasBottomCursor: false, bottomCursor: "", entryCount: 0,
        userEntryCount: 0, tweetEntryCount: 0, recommendationCount: 0,
      };
    }

    const users = [];
    const cursors = [];
    let userEntryCount = 0;
    let tweetEntryCount = 0;
    let recommendationCount = 0;

    for (const instruction of found.instructions) {
      for (const entry of entriesFromInstruction(instruction)) {
        const entryId = String(entry?.entryId || "");
        if (/^tweet-/.test(entryId)) tweetEntryCount++;
        else if (/^user-\d+$/.test(entryId)) userEntryCount++;
        else if (RECOMMENDATION_PATTERN.test(entryId)) recommendationCount++;

        collectCursor(entry, cursors);
        const user = userFromEntry(entry);
        if (user) users.push(user);
      }
    }

    const byId = new Map();
    for (const user of users) {
      if (!byId.has(user.user_id)) byId.set(user.user_id, user);
    }
    const bottom = [...cursors].reverse().find((cursor) => /bottom/i.test(cursor.type));

    return {
      recognized: true,
      path: found.path,
      users: [...byId.values()],
      cursors,
      hasBottomCursor: !!bottom,
      bottomCursor: bottom?.value || "",
      entryCount: found.instructions.reduce((sum, instruction) => sum + entriesFromInstruction(instruction).length, 0),
      userEntryCount,
      tweetEntryCount,
      recommendationCount,
    };
  }

  return { extractPage, findTimeline, resolveUser, userFromEntry };
});
