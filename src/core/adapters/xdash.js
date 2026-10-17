/* core.adapters.xdash — the X bookmarks capture export ("graphql-bookmarks"):
   { export_version, exported_at, bookmarks: [{ tweet_id, text, author_*, media_items: [...] , raw? }] }
   This is the primary format (data/posts.js ships in it). `raw` is ignored. */
XR.define("core.adapters.xdash", ["core.adapters.registry", "core.adapters.common", "core.util"], function (registry, common, util) {
  "use strict";

  function score(json) {
    const list = Array.isArray(json) ? json : json?.bookmarks;
    if (!Array.isArray(list) || !list.length) return 0;
    const sample = list.slice(0, 5);
    const hits = sample.filter((p) => p && (p.tweet_id || p.media_items || p.author_username)).length;
    return hits ? 0.5 + 0.5 * (hits / sample.length) : 0;
  }

  function mapMedia(item, index) {
    const type = item.type === "animated_gif" ? "gif" : item.type === "video" ? "video" : "photo";
    if (type === "photo") {
      return { index, kind: "photo", thumb: common.bareImageUrl(item.url || item.poster), width: item.width, height: item.height, aspect: item.aspect, alt: item.alt };
    }
    const { sources, hls } = common.videoSources({ mp4: item.mp4, variants: item.mp4_variants, hls: item.hls });
    return {
      index, kind: type,
      thumb: common.bareImageUrl(item.poster || item.url), poster: common.bareImageUrl(item.poster || item.url),
      sources, hls, width: item.width, height: item.height, aspect: item.aspect,
      duration: util.toNumber(item.duration) / 1000, alt: item.alt,
    };
  }

  function normalize(json) {
    const list = Array.isArray(json) ? json : json.bookmarks;
    return list.map((p, i) => {
      if (!p) return null;
      const id = String(p.tweet_id || p.original_tweet_id || common.idFromUrl(p.tweet_url || p.url) || "");
      if (!id) return null;
      const username = p.author_username || p.author_username_at_capture || common.usernameFromUrl(p.tweet_url || p.url);
      const legacy = p.raw?.legacy || {};
      const quoted = p.quoted_tweet ? {
        id: String(p.quoted_tweet.tweet_id || p.quoted_tweet_id || ""), username: p.quoted_tweet.author_username || "",
        name: p.quoted_tweet.author_name || "", text: util.cleanText(p.quoted_tweet.text || ""), url: p.quoted_tweet.url || "",
      } : null;
      return {
        id,
        url: p.canonical_url || p.tweet_url || p.url || common.statusUrl(username, id),
        text: p.text || legacy.full_text || "",
        lang: legacy.lang || "",
        createdAt: util.parseDate(p.tweet_created_at || legacy.created_at),
        savedAt: util.parseDate(p.captured_at || p.first_seen_at),
        order: util.toNumber(p.capture_order) || i + 1,
        author: { id: p.author_id, username, name: p.author_name || p.author_name_at_capture, avatar: p.author_profile_image_url },
        metrics: {
          likes: p.like_count_at_capture ?? legacy.favorite_count, reposts: p.retweet_count_at_capture ?? legacy.retweet_count,
          replies: p.reply_count_at_capture ?? legacy.reply_count, views: p.view_count_at_capture || util.toNumber(p.raw?.views?.count),
          bookmarks: legacy.bookmark_count,
        },
        media: (Array.isArray(p.media_items) ? p.media_items : []).map(mapMedia),
        links: Array.isArray(p.urls_expanded) ? p.urls_expanded.map((u) => (typeof u === "string" ? u : u?.expanded_url || u?.url)).filter(Boolean) : [],
        quoted,
        flags: { sensitive: !!legacy.possibly_sensitive, reply: !!p.in_reply_to_status_id, repostedBy: p.retweeted_by_username || "" },
      };
    });
  }

  return registry.register({ id: "xdash", label: "X bookmarks export (bookmarks[] / media_items[])", score, normalize });
});
