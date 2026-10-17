/* core.adapters.xreels — XReels' own export (already in the canonical shape):
   { export_version: "xreels-1", posts: [Post] }. Round-trips losslessly. */
XR.define("core.adapters.xreels", ["core.adapters.registry"], function (registry) {
  "use strict";
  const score = (json) => (json && typeof json.export_version === "string" && json.export_version.startsWith("xreels") && Array.isArray(json.posts)) ? 1 : 0;
  function normalize(json) {
    return json.posts.map((p) => p && p.id ? {
      id: p.id, url: p.url, text: p.rawText || p.text, lang: p.lang, createdAt: p.createdAt, savedAt: p.savedAt, order: p.order,
      author: p.author, metrics: p.metrics, hashtags: p.hashtags, links: p.links, quoted: p.quoted, flags: p.flags,
      media: (p.media || []).map((m, i) => ({ index: i, kind: m.kind, thumb: m.thumb, poster: m.poster, sources: m.sources, hls: m.hls, width: m.width, height: m.height, aspect: m.aspect, duration: m.duration, alt: m.alt })),
    } : null);
  }
  return registry.register({ id: "xreels", label: "XReels export", score, normalize });
});
