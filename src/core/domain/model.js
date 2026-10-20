/* core.domain.model — the canonical shapes every layer agrees on.

   Adapters (core.adapters.*) turn *any* export format into Post/Media; nothing
   downstream ever sees a vendor field again. Keep this file free of DOM and
   storage concerns: it is the contract, not a service.

   @typedef {Object} Media
   @property {string}  id        `${postId}:${index}`
   @property {string}  postId
   @property {number}  index     0-based position inside the post
   @property {'photo'|'video'|'gif'} kind
   @property {string}  thumb     still image URL (photo itself, or video poster)
   @property {string}  [poster]
   @property {{url:string,type:string,bitrate?:number}[]} sources  best-first video ladder
   @property {string}  [hls]
   @property {number}  width
   @property {number}  height
   @property {number}  aspect    width / height (1 when unknown)
   @property {number}  duration  seconds (0 for stills)
   @property {string}  alt

   @typedef {Object} Post
   @property {string}  id
   @property {string}  url
   @property {string}  text        cleaned caption (trailing t.co removed)
   @property {string}  rawText
   @property {string}  lang
   @property {number}  createdAt   ms, when the post was published
   @property {number}  savedAt     ms, when it was bookmarked/captured (falls back to createdAt)
   @property {number}  order       capture order (lower = saved earlier)
   @property {{id:string,username:string,name:string,avatar:string}} author
   @property {{likes:number,reposts:number,replies:number,views:number,bookmarks:number}} metrics
   @property {Media[]} media
   @property {string[]} hashtags
   @property {string[]} links
   @property {{id:string,username:string,name:string,text:string,url:string}|null} quoted
   @property {{sensitive:boolean,reply:boolean,repostedBy:string}} flags
   @property {string}  source      adapter id
   @property {'x'|'reddit'} platform where the post came from (missing = 'x', for older caches)
   @property {string}  haystack    lowercase search blob (built by catalog)
*/
XR.define("core.domain.model", ["core.util"], function (util) {
  "use strict";

  /** Shorts vs long-form boundary (seconds). Overridable through prefs. */
  const SHORT_MAX_SECONDS = 180;
  const KINDS = Object.freeze(["photo", "video", "gif"]);

  function createMedia(partial) {
    const width = util.toNumber(partial.width), height = util.toNumber(partial.height);
    let aspect = util.toNumber(partial.aspect);
    if (!aspect && width && height) aspect = width / height;
    if (!aspect) aspect = 1;
    const kind = KINDS.includes(partial.kind) ? partial.kind : "photo";
    const sources = Array.isArray(partial.sources) ? partial.sources.filter((s) => s && s.url) : [];
    return {
      id: `${partial.postId}:${partial.index ?? 0}`,
      postId: String(partial.postId),
      index: partial.index ?? 0,
      kind,
      thumb: partial.thumb || partial.poster || "",
      poster: partial.poster || (kind === "photo" ? partial.thumb : "") || "",
      sources,
      hls: partial.hls || "",
      hlsFirst: !!partial.hlsFirst && !!partial.hls,   // play the HLS stream before the listed sources
      width, height, aspect,
      duration: Math.max(0, util.toNumber(partial.duration)),
      alt: partial.alt || "",
    };
  }

  function createPost(partial) {
    const id = String(partial.id);
    const rawText = String(partial.text || "");
    const createdAt = util.toNumber(partial.createdAt);
    const media = (partial.media || []).map((m, i) => createMedia({ ...m, postId: id, index: m.index ?? i }));
    const author = partial.author || {};
    const username = String(author.username || "").replace(/^@/, "") || "unknown";
    return {
      id,
      url: partial.url || `https://x.com/${username}/status/${id}`,
      text: util.cleanText(rawText),
      rawText,
      lang: partial.lang || "",
      createdAt,
      savedAt: util.toNumber(partial.savedAt) || createdAt,
      order: util.toNumber(partial.order),
      author: {
        id: String(author.id || ""),
        username,
        name: author.name || username,
        avatar: author.avatar || "",
      },
      metrics: {
        likes: util.toNumber(partial.metrics?.likes),
        reposts: util.toNumber(partial.metrics?.reposts),
        replies: util.toNumber(partial.metrics?.replies),
        views: util.toNumber(partial.metrics?.views),
        bookmarks: util.toNumber(partial.metrics?.bookmarks),
      },
      media,
      hashtags: partial.hashtags?.length ? partial.hashtags : util.extractHashtags(rawText),
      links: Array.isArray(partial.links) ? partial.links.filter(Boolean) : [],
      quoted: partial.quoted || null,
      flags: {
        sensitive: !!partial.flags?.sensitive,
        reply: !!partial.flags?.reply,
        repostedBy: partial.flags?.repostedBy || "",
      },
      source: partial.source || "unknown",
      platform: partial.platform === "reddit" ? "reddit" : "x",
      haystack: "",
    };
  }

  /** Human name of the site a post came from, for menus and links. */
  const platformLabel = (post) => (post && post.platform === "reddit" ? "Reddit" : "X");

  /* ----------------------------------------------------- classification -- */
  const hasMedia = (post) => post.media.length > 0;
  const isCarousel = (post) => post.media.length > 1;
  const primary = (post) => post.media[0] || null;
  const hasVideo = (post) => post.media.some((m) => m.kind !== "photo");
  const isGif = (post) => post.media.some((m) => m.kind === "gif");
  /** Longest clip in the post, seconds. */
  const duration = (post) => post.media.reduce((max, m) => Math.max(max, m.duration), 0);
  const isShort = (post, max = SHORT_MAX_SECONDS) => hasVideo(post) && duration(post) <= max;
  const isLong = (post, max = SHORT_MAX_SECONDS) => hasVideo(post) && duration(post) > max;
  /** 'vertical' | 'square' | 'landscape' from the primary media. */
  function orientation(media) {
    const a = media?.aspect || 1;
    return a < 0.9 ? "vertical" : a > 1.1 ? "landscape" : "square";
  }
  /** Primary classification used by facets. */
  function kindOf(post, shortMax = SHORT_MAX_SECONDS) {
    if (!hasMedia(post)) return "text";
    if (isGif(post) && !post.media.some((m) => m.kind === "video")) return "gif";
    if (hasVideo(post)) return duration(post) > shortMax ? "long" : "short";
    return isCarousel(post) ? "carousel" : "photo";
  }

  /** Lowercase search blob: text, author, @username, #tags, quoted text, links. */
  function haystack(p) {
    return [p.text, p.author.name, "@" + p.author.username, p.hashtags.map((t) => "#" + t).join(" "), p.quoted?.text || "", p.links.join(" ")]
      .filter(Boolean).join(" \n ").toLowerCase();
  }

  return {
    SHORT_MAX_SECONDS, KINDS, createMedia, createPost, haystack, platformLabel,
    hasMedia, isCarousel, primary, hasVideo, isGif, duration, isShort, isLong, orientation, kindOf,
  };
});
