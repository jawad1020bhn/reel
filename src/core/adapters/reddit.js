/* core.adapters.reddit — the Reddit saved-posts export written by xextension
   (reddit-saved.js, source "reddit-saved-nsfw"):
     { export_version: 1, source: "reddit-saved-nsfw", posts: [{ fullname, title, subreddit, … }] }

   Ids are Reddit fullnames ("t3_…"). They never collide with numeric X ids, so both
   sites can share one catalog. Only URLs are read; nothing is fetched here.

   Media: a direct i.redd.it image is shown as-is. Reddit-hosted videos and galleries
   show their thumbnail only, because playing them needs Reddit's DASH resolution,
   which this app does not do. The permalink ("Open on Reddit") still plays them. */
XR.define("core.adapters.reddit", ["core.adapters.registry", "core.util"], function (registry, util) {
  "use strict";

  const SOURCE = "reddit-saved-nsfw";
  const rows = (json) => (Array.isArray(json?.posts) ? json.posts : null);
  const isFullname = (value) => typeof value === "string" && /^t3_[A-Za-z0-9]+$/.test(value);

  function score(json) {
    const list = rows(json);
    if (!list || !list.length) return 0;
    if (json.source === SOURCE) return 1;
    // Same shape without the source tag (hand-edited or re-saved file): still clearly Reddit.
    const sample = list.slice(0, 5);
    return sample.every((p) => p && isFullname(p.fullname)) ? 0.9 : 0;
  }

  const httpUrl = (value) => (/^https?:\/\//i.test(String(value || "")) ? String(value) : "");
  /* The extension writes absolute permalinks; a bare "/r/…" path is made absolute the same way. */
  const permalinkOf = (value) => httpUrl(value) || (/^\/r\//.test(String(value || "")) ? "https://www.reddit.com" + value : "");
  const isRedditHost = (url) => { try { return /(^|\.)(reddit\.com|redd\.it|redditmedia\.com)$/i.test(new URL(url).hostname); } catch { return true; } };
  const toTime = (value) => { const t = Date.parse(value); return Number.isFinite(t) ? t : 0; };

  /* A Reddit-hosted video is "https://v.redd.it/<id>". Its sound is in the HLS playlist
     <id>/HLSPlaylist.m3u8, so that is played first (hlsFirst). The DASH_<h>.mp4 files are
     video-only: they are the silent fallback, and the muted hover preview uses the lowest one.
     Only this exact URL shape is accepted. */
  const videoBase = (url) => { const m = String(url || "").match(/^https:\/\/v\.redd\.it\/([A-Za-z0-9]+)\/?$/); return m ? "https://v.redd.it/" + m[1] : ""; };
  const SILENT_LADDER = [720, 480, 360, 240];

  /** One still per post at most: the image itself, or Reddit's thumbnail. Link posts (redgifs,
      external articles) and text posts carry a thumbnail too, so those still get a picture. */
  function mediaOf(p) {
    const list = Array.isArray(p.media) ? p.media : [];
    const direct = list.find((m) => m && m.kind === "image" && httpUrl(m.url));
    if (direct) return [{ kind: "photo", thumb: httpUrl(direct.url) }];
    const poster = httpUrl(p.thumbnail);
    const playable = list.find((m) => m && m.kind === "video" && videoBase(m.url));
    if (playable) {
      const base = videoBase(playable.url);
      const sources = SILENT_LADDER.map((h) => ({ url: `${base}/DASH_${h}.mp4`, type: "video/mp4", bitrate: h * 1000 }));
      return [{ kind: "video", thumb: poster, poster, hls: base + "/HLSPlaylist.m3u8", hlsFirst: true, sources, alt: "" }];
    }
    if (!poster) return [];
    const video = list.some((m) => m && m.kind === "video");
    const gallery = list.some((m) => m && m.kind === "gallery");
    const alt = video ? "Reddit video (still image, open on Reddit to play)"
      : gallery ? "Reddit gallery (first image, open on Reddit for all of it)" : "";
    return [{ kind: "photo", thumb: poster, alt }];
  }

  function normalize(json) {
    return rows(json).map((p, i) => {
      if (!p || typeof p !== "object") return null;
      const fullname = isFullname(p.fullname) ? p.fullname : (p.id ? "t3_" + String(p.id) : "");
      if (!isFullname(fullname)) return null;
      const author = String(p.author || "").replace(/^u\//i, "").trim();
      const subreddit = String(p.subreddit || "").replace(/^r\//i, "").trim().toLowerCase();
      const title = String(p.title || "");
      const created = toTime(p.created_at);
      const external = httpUrl(p.url);
      return {
        id: fullname,
        platform: "reddit",
        url: permalinkOf(p.permalink) || `https://www.reddit.com/comments/${fullname.slice(3)}/`,
        text: title,
        lang: "",
        createdAt: created,
        savedAt: toTime(p.captured_at) || created,
        order: i + 1,
        author: { id: author, username: author || "deleted", name: author ? "u/" + author : "[deleted]", avatar: "" },
        metrics: { likes: p.score, reposts: 0, replies: p.comments, views: 0, bookmarks: 0 },
        media: mediaOf(p),
        // The subreddit becomes a tag, so "#subreddit" groups saves the same way X hashtags do.
        hashtags: [...new Set([...util.extractHashtags(title), ...(subreddit ? [subreddit] : [])])],
        links: external && !isRedditHost(external) ? [external] : [],
        quoted: null,
        flags: { sensitive: p.nsfw !== false, reply: false, repostedBy: "" },
      };
    }).filter(Boolean);
  }

  return registry.register({ id: "reddit", label: "Reddit saved (NSFW)", score, normalize });
});
