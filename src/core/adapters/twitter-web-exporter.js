/* core.adapters.twe — prinsss/twitter-web-exporter JSON rows:
   [{ id, created_at, full_text, media: [{type, url, thumbnail, original, ext_alt_text}],
      screen_name, profile_name, profile_image_url, favorite_count, …, url, metadata? }]
   When "Include all metadata" was ticked, `metadata` holds the GraphQL tweet with
   legacy.extended_entities.media[].video_info.variants — used for real bitrates. */
XR.define("core.adapters.twe", ["core.adapters.registry", "core.adapters.common", "core.util"], function (registry, common, util) {
  "use strict";

  function score(json) {
    const list = Array.isArray(json) ? json : json?.tweets;
    if (!Array.isArray(list) || !list.length) return 0;
    const sample = list.slice(0, 5);
    const hits = sample.filter((p) => p && ("full_text" in p || "screen_name" in p) && ("media" in p || "metadata" in p)).length;
    return hits ? 0.4 + 0.5 * (hits / sample.length) : 0;
  }

  function fromMetadata(meta) {
    const ents = meta?.legacy?.extended_entities?.media || meta?.legacy?.entities?.media || [];
    return ents.map((m, i) => {
      const kind = m.type === "animated_gif" ? "gif" : m.type === "video" ? "video" : "photo";
      const base = { index: i, kind, width: m.original_info?.width, height: m.original_info?.height, alt: m.ext_alt_text };
      if (kind === "photo") return { ...base, thumb: common.bareImageUrl(m.media_url_https) };
      const vi = m.video_info || {};
      const { sources, hls } = common.videoSources({ variants: vi.variants });
      const ar = Array.isArray(vi.aspect_ratio) ? vi.aspect_ratio[0] / vi.aspect_ratio[1] : 0;
      return { ...base, thumb: common.bareImageUrl(m.media_url_https), poster: common.bareImageUrl(m.media_url_https), sources, hls, aspect: ar, duration: util.toNumber(vi.duration_millis) / 1000 };
    });
  }

  function fromRows(media) {
    return (media || []).map((m, i) => {
      const kind = m.type === "animated_gif" ? "gif" : m.type === "video" ? "video" : "photo";
      const still = common.bareImageUrl(m.thumbnail || (kind === "photo" ? m.original : ""));
      if (kind === "photo") return { index: i, kind, thumb: common.bareImageUrl(m.original || m.thumbnail), alt: m.ext_alt_text };
      const { sources, hls } = common.videoSources({ mp4: common.isVideoFile(m.original) ? m.original : "" });
      return { index: i, kind, thumb: still, poster: still, sources, hls, alt: m.ext_alt_text };
    });
  }

  function normalize(json) {
    const list = Array.isArray(json) ? json : json.tweets;
    return list.map((p, i) => {
      if (!p) return null;
      const meta = p.metadata;
      const id = String(p.id || meta?.rest_id || common.idFromUrl(p.url) || "");
      if (!id) return null;
      const user = meta?.core?.user_results?.result;
      const username = p.screen_name || user?.core?.screen_name || user?.legacy?.screen_name || common.usernameFromUrl(p.url);
      const legacy = meta?.legacy || {};
      const media = meta ? fromMetadata(meta) : fromRows(p.media);
      return {
        id,
        url: p.url || common.statusUrl(username, id),
        text: p.full_text || legacy.full_text || "",
        lang: legacy.lang || "",
        createdAt: util.parseDate(p.created_at || legacy.created_at),
        savedAt: 0,
        order: i + 1,
        author: { id: p.user_id || user?.rest_id, username, name: p.profile_name || user?.core?.name || user?.legacy?.name, avatar: p.profile_image_url || user?.avatar?.image_url || user?.legacy?.profile_image_url_https },
        metrics: { likes: p.favorite_count ?? legacy.favorite_count, reposts: p.retweet_count ?? legacy.retweet_count, replies: p.reply_count ?? legacy.reply_count, views: p.views_count ?? util.toNumber(meta?.views?.count), bookmarks: p.bookmark_count ?? legacy.bookmark_count },
        media: media.length ? media : fromRows(p.media),
        flags: { sensitive: !!legacy.possibly_sensitive, reply: !!(p.in_reply_to || legacy.in_reply_to_status_id_str), repostedBy: p.retweeted_status ? String(p.retweeted_status) : "" },
      };
    });
  }

  return registry.register({ id: "twe", label: "twitter-web-exporter JSON", score, normalize });
});
