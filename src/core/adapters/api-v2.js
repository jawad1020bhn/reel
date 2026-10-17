/* core.adapters.apiV2 — X API v2 bookmarks response(s):
   { data: [{ id, text, created_at, author_id, attachments: { media_keys } , public_metrics }],
     includes: { media: [{ media_key, type, url, preview_image_url, variants, width, height, duration_ms }], users: [...] } }
   Also accepts an array of such pages (paginated dumps). */
XR.define("core.adapters.apiV2", ["core.adapters.registry", "core.adapters.common", "core.util"], function (registry, common, util) {
  "use strict";

  const pages = (json) => (Array.isArray(json) && json.every((p) => p && p.data) ? json : [json]);

  function score(json) {
    const first = pages(json)[0];
    if (!first || !Array.isArray(first.data) || !first.data.length) return 0;
    const hits = first.data.slice(0, 5).filter((t) => t && t.id && ("text" in t)).length;
    return hits ? (first.includes ? 0.9 : 0.6) : 0;
  }

  function normalize(json) {
    const out = [];
    let order = 0;
    for (const page of pages(json)) {
      const mediaByKey = new Map((page.includes?.media || []).map((m) => [m.media_key, m]));
      const users = new Map((page.includes?.users || []).map((u) => [u.id, u]));
      for (const t of page.data || []) {
        if (!t?.id) continue;
        const user = users.get(t.author_id) || {};
        const username = user.username || "";
        const keys = t.attachments?.media_keys || [];
        const media = keys.map((k) => mediaByKey.get(k)).filter(Boolean).map((m, i) => {
          const kind = m.type === "animated_gif" ? "gif" : m.type === "video" ? "video" : "photo";
          if (kind === "photo") return { index: i, kind, thumb: common.bareImageUrl(m.url), width: m.width, height: m.height, alt: m.alt_text };
          const { sources, hls } = common.videoSources({ variants: m.variants });
          return { index: i, kind, thumb: common.bareImageUrl(m.preview_image_url), poster: common.bareImageUrl(m.preview_image_url), sources, hls, width: m.width, height: m.height, duration: util.toNumber(m.duration_ms) / 1000, alt: m.alt_text };
        });
        const pm = t.public_metrics || {};
        out.push({
          id: String(t.id), url: common.statusUrl(username, t.id), text: t.text || "", lang: t.lang,
          createdAt: util.parseDate(t.created_at), order: ++order,
          author: { id: t.author_id, username, name: user.name, avatar: user.profile_image_url },
          metrics: { likes: pm.like_count, reposts: pm.retweet_count, replies: pm.reply_count, views: pm.impression_count, bookmarks: pm.bookmark_count },
          media, flags: { sensitive: !!t.possibly_sensitive, reply: !!t.in_reply_to_user_id },
        });
      }
    }
    return out;
  }
  return registry.register({ id: "api-v2", label: "X API v2 (data[] + includes.media[])", score, normalize });
});
