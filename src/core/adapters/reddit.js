/* core.adapters.reddit — the Reddit saved-posts export written by xextension
   (reddit-saved.js, source "reddit-saved-nsfw"):
     { export_version: 1|2, source: "reddit-saved-nsfw", posts: [{ fullname, title, subreddit, … }] }

   Ids are Reddit fullnames ("t3_…"). They never collide with numeric X ids, so both
   sites can share one catalog. Only URLs are read; nothing is fetched here.

   Media: a direct i.redd.it image is shown as-is. Reddit-hosted videos come in two
   flavours. Export v2 (extension ≥ 1.5) carries the real CMAF facts captured in the
   logged-in session — file ladder, audio track, duration, size — and the app plays
   the files with the audio track beside them. Legacy records have only the bare
   v.redd.it URL; they keep the HLS-first + DASH-guess behaviour. Galleries and link
   posts show their thumbnail, and the permalink ("Open on Reddit") always works. */
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

  /* A Reddit-hosted video is "https://v.redd.it/<id>". Export v2 records carry what the
     extension captured in the logged-in session: the master playlist (hls), the real
     CMAF video files (files[] — video-only, best-first), the audio file (audio),
     duration and dimensions. The player tries the files first and plays the audio track
     beside them; the master (which carries sound) is the last resort. Legacy records
     (bare URL) keep the old guesses: HLS first, silent DASH mp4s as fallback. */
  const videoBase = (url) => { const m = String(url || "").match(/^https:\/\/v\.redd\.it\/([A-Za-z0-9]+)\/?$/); return m ? "https://v.redd.it/" + m[1] : ""; };
  const SILENT_LADDER = [720, 480, 360, 240];

  /** One still per post at most: the image itself, or Reddit's thumbnail. Link posts (redgifs,
      external articles) and text posts carry a thumbnail too, so those still get a picture. */
  function mediaOf(p) {
    const list = Array.isArray(p.media) ? p.media : [];
    const direct = list.find((m) => m && m.kind === "image" && httpUrl(m.url));
    if (direct) return [{ kind: "photo", thumb: httpUrl(direct.url) }];
    const poster = httpUrl(p.thumbnail);
    const playable = list.find((m) => m && m.kind === "video" && (videoBase(m.url) || Array.isArray(m.files)));
    if (playable) {
      const base = videoBase(playable.url);
      const files = Array.isArray(playable.files)
        ? playable.files.filter((f) => f && httpUrl(f.url)).map((f) => ({ url: httpUrl(f.url), type: "video/mp4", bitrate: (parseInt(f.height, 10) || 480) * 1000 }))
        : [];
      const hls = httpUrl(playable.hls) || (base ? base + "/HLSPlaylist.m3u8" : "");
      const sources = files.length ? files : (base ? SILENT_LADDER.map((h) => ({ url: `${base}/DASH_${h}.mp4`, type: "video/mp4", bitrate: h * 1000 })) : []);
      return [{
        kind: "video", thumb: poster, poster,
        hls,
        hlsFirst: !files.length && !!hls,   // v2: files first (sound is the separate audio track); v1: the master is the only hope
        sources,
        audio: httpUrl(playable.audio),
        duration: Number(playable.duration) || 0,
        width: Number(playable.width) || 0,
        height: Number(playable.height) || 0,
        alt: "",
      }];
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
