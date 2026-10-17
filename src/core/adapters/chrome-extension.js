/* core.adapters.chromeExt — DOM-scraping Chrome exporters:
   { meta, tweets|bookmarks: [{ id, url, authorHandle, authorName, postedAt, text, mediaUrls: [] }] }
   Videos usually arrive as poster thumbnails only; those become photo stills
   flagged `posterOnly` so the UI can say "open on X to play". */
XR.define("core.adapters.chromeExt", ["core.adapters.registry", "core.adapters.common", "core.util"], function (registry, common, util) {
  "use strict";

  function rows(json) {
    if (Array.isArray(json)) return json;
    return json?.tweets || json?.bookmarks || json?.items || null;
  }
  function score(json) {
    const list = rows(json);
    if (!Array.isArray(list) || !list.length) return 0;
    const sample = list.slice(0, 5);
    const hits = sample.filter((p) => p && ("mediaUrls" in p || "authorHandle" in p || "media_urls" in p || "tweetUrl" in p)).length;
    return hits ? 0.4 + 0.5 * (hits / sample.length) : 0;
  }
  function normalize(json) {
    return rows(json).map((p, i) => {
      if (!p) return null;
      const url = common.pick(p, "url", "tweetUrl", "tweet_url", "link") || "";
      const id = String(common.pick(p, "id", "tweetId", "tweet_id") || common.idFromUrl(url) || "");
      if (!id) return null;
      const username = String(common.pick(p, "authorHandle", "author_handle", "username", "screen_name", "senderHandle") || common.usernameFromUrl(url) || "").replace(/^@/, "");
      const urls = common.pick(p, "mediaUrls", "media_urls", "media", "images") || [];
      const media = (Array.isArray(urls) ? urls : [urls]).map((m) => (typeof m === "string" ? m : m?.url || m?.src)).filter(Boolean).map(common.mediaFromUrl);
      return {
        id, url: url || common.statusUrl(username, id),
        text: common.pick(p, "text", "content", "full_text") || "",
        createdAt: util.parseDate(common.pick(p, "postedAt", "posted_at", "created_at", "date")),
        savedAt: util.parseDate(common.pick(p, "bookmarkCapturedAt", "capturedAt", "captured_at", "savedAt")),
        order: i + 1,
        author: { username, name: common.pick(p, "authorName", "author_name", "name", "senderName"), avatar: common.pick(p, "authorAvatar", "avatar", "profile_image_url") },
        metrics: { likes: common.pick(p, "likes", "likeCount", "favorite_count"), reposts: common.pick(p, "retweets", "repostCount", "retweet_count"), replies: common.pick(p, "replies", "replyCount"), views: common.pick(p, "views", "viewCount") },
        media,
      };
    });
  }
  return registry.register({ id: "chrome-ext", label: "Chrome bookmark exporter JSON (mediaUrls[])", score, normalize });
});
