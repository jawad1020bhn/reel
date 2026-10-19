/* Pure, conservative decisions for destructive bookmark operations.
 * Capture is intentionally more permissive; removal never targets a quoted
 * tweet, recommendation module, folder response, or arbitrary GraphQL object. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XBookmarkRemoval = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function extractPage(json) {
    const envelope = json?.data?.bookmark_timeline_v2 || json?.data?.bookmark_timeline;
    const instructions = envelope?.timeline?.instructions || envelope?.instructions;
    if (!Array.isArray(instructions) || json?.errors?.length) return { recognized: false, posts: [], bottomCursor: "", empty: false };
    const posts = new Map();
    let bottomCursor = "", unknown = false;
    for (const instruction of instructions) {
      for (const entry of [...(instruction.entries || []), ...(instruction.entry ? [instruction.entry] : [])]) {
        const match = /^tweet-(\d+)(?:$|[-_])/.exec(String(entry.entryId || ""));
        if (match) {
          const result = entry.content?.itemContent?.tweet_results?.result;
          const tweet = result?.__typename === "TweetWithVisibilityResults" ? result.tweet : result;
          // A tombstone still has an exact bookmark entry ID. Never descend
          // into quoted/retweeted posts to manufacture additional targets.
          const id = String(tweet?.rest_id || match[1]);
          if (id !== match[1]) { unknown = true; continue; }
          const user = tweet?.core?.user_results?.result;
          posts.set(id, { tweet_id: id, text: tweet?.note_tweet?.note_tweet_results?.result?.text || tweet?.legacy?.full_text || "", author_username: user?.core?.screen_name || user?.legacy?.screen_name || "", url: `https://x.com/i/status/${id}`, raw: tweet || null });
        } else {
          const cursor = entry.content?.operation?.cursor || entry.content;
          if (/bottom/i.test(cursor?.cursorType || entry.entryId || "")) bottomCursor = typeof cursor?.value === "string" ? cursor.value : "";
          // Unknown modules may be valid bookmarks in a future schema. Never
          // call them an empty account just because we cannot safely target them.
          else if (!/^cursor-/i.test(entry.entryId || "")) unknown = true;
        }
      }
      if (!["TimelineAddEntries", "TimelineReplaceEntry", "TimelineTerminateTimeline", "TimelineClearCache"].includes(instruction.type)) unknown = true;
    }
    return { recognized: true, posts: [...posts.values()], bottomCursor, empty: posts.size === 0 && !bottomCursor && !unknown, unknown };
  }

  function classify(reply) {
    if (reply?.outcome) return reply.outcome;
    const status = Number(reply?.status) || 0;
    const errors = Array.isArray(reply?.body?.errors) ? reply.body.errors : [];
    if (status === 429 || errors.some((e) => Number(e.code) === 88)) return "rate-limited";
    if (status === 401 || status === 403 || errors.some((e) => [32, 89, 99, 135, 215, 326].includes(Number(e.code)))) return "auth-error";
    if (!status) return "network-error";
    if (status >= 500) return "server-error";
    if (status === 400 || status === 404) return "stale-queryid";
    // HTTP 200 / an empty GraphQL object is NOT proof of a deletion.
    if (status === 200 && !errors.length && reply.body?.data?.tweet_bookmark_delete === "Done") return "ok";
    return "unconfirmed";
  }
  function accountId(cookie) {
    try { return /(?:^|;\s*)twid=u=(\d+)(?:;|$)/.exec(decodeURIComponent(cookie || ""))?.[1] || null; }
    catch { return null; }
  }
  return { extractPage, classify, accountId };
});
