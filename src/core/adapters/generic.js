/* core.adapters.generic — last-resort adapter for "some array of post-like objects".
   It looks for an id/url, a text field, an author field and any media URLs,
   scanning one level of nesting. Low score so real adapters always win. */
XR.define("core.adapters.generic", ["core.adapters.registry", "core.adapters.common", "core.util"], function (registry, common, util) {
  "use strict";

  function findList(json) {
    if (Array.isArray(json)) return json;
    if (json && typeof json === "object") {
      for (const key of ["posts", "items", "results", "bookmarks", "tweets", "data", "list"]) {
        if (Array.isArray(json[key])) return json[key];
      }
      const arrays = Object.values(json).filter(Array.isArray);
      if (arrays.length === 1) return arrays[0];
    }
    return null;
  }
  function score(json) {
    const list = findList(json);
    if (!Array.isArray(list) || !list.length || typeof list[0] !== "object") return 0;
    return 0.1;
  }
  function collectUrls(value, out, depth = 0) {
    if (depth > 3 || value == null) return;
    if (typeof value === "string") {
      if (/^https?:\/\/.+\.(jpg|jpeg|png|gif|webp|mp4|m3u8|webm)(\?.*)?$/i.test(value) || /twimg\.com\/(media|ext_tw_video|amplify_video|tweet_video)/.test(value)) out.push(value);
      return;
    }
    if (Array.isArray(value)) { for (const v of value) collectUrls(v, out, depth + 1); return; }
    if (typeof value === "object") { for (const v of Object.values(value)) collectUrls(v, out, depth + 1); }
  }
  function normalize(json) {
    return findList(json).map((p, i) => {
      if (!p || typeof p !== "object") return null;
      const url = common.pick(p, "url", "link", "tweet_url", "tweetUrl", "permalink") || "";
      const id = String(common.pick(p, "id", "tweet_id", "tweetId", "id_str", "rest_id") || common.idFromUrl(url) || "");
      if (!id) return null;
      const urls = [];
      collectUrls(p, urls);
      const media = util.uniq(urls).filter((u) => !/profile_images|profile_banners/.test(u)).map(common.mediaFromUrl);
      const author = p.author || p.user || {};
      const username = String(common.pick(p, "author_username", "username", "screen_name", "authorHandle") || author.username || author.screen_name || common.usernameFromUrl(url) || "").replace(/^@/, "");
      return {
        id, url: url || common.statusUrl(username, id),
        text: common.pick(p, "text", "full_text", "content", "caption") || "",
        createdAt: util.parseDate(common.pick(p, "created_at", "createdAt", "date", "postedAt", "timestamp")),
        order: i + 1,
        author: { username, name: common.pick(p, "author_name", "name", "authorName") || author.name, avatar: common.pick(p, "author_profile_image_url", "avatar", "profile_image_url") || author.avatar || author.profile_image_url },
        metrics: { likes: common.pick(p, "likes", "like_count", "favorite_count"), views: common.pick(p, "views", "view_count") },
        media,
      };
    });
  }
  return registry.register({ id: "generic", label: "Generic post list (best effort)", score, normalize });
});
