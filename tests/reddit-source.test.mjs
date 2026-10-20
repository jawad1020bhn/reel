/* core.adapters.reddit: the Reddit saved-posts export (data/r-posts.json) becomes Post[]
   with platform "reddit", and the X adapters keep working unchanged. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXR } from "./helpers/xr.mjs";

const { XR, load } = createXR();
for (const file of [
  "src/core/util/index.js",
  "src/core/domain/model.js",
  "src/core/adapters/registry.js",
  "src/core/adapters/common.js",
  "src/core/adapters/xdash.js",
  "src/core/adapters/reddit.js",
]) load(file);
const registry = XR.resolve("core.adapters.registry");
XR.resolve("core.adapters.xdash");
XR.resolve("core.adapters.reddit");
const model = XR.resolve("core.domain.model");
// Values built inside the VM context carry that realm's Array prototype; a JSON round-trip makes them plain.
const plain = (value) => JSON.parse(JSON.stringify(value));
const normalize = (json, options) => plain(registry.normalize(json, options));

const CAPTURED = "2026-10-19T08:00:00.000Z";
const redditExport = {
  export_version: 1,
  exported_at: "2026-10-20T10:00:00.000Z",
  source: "reddit-saved-nsfw",
  account: "someone",
  count: 4,
  posts: [
    { fullname: "t3_abc123", title: "Sunset #evening", subreddit: "NSFWPics", author: "alice", permalink: "/r/NSFWPics/comments/abc123/sunset/", url: "https://i.redd.it/x1.jpg", domain: "i.redd.it", score: 42, comments: 7, created_at: "2026-05-01T12:00:00.000Z", nsfw: true, thumbnail: "https://b.thumbs.redditmedia.com/t.jpg", media: [{ kind: "image", url: "https://i.redd.it/x1.jpg" }], captured_at: CAPTURED },
    { fullname: "t3_vid999", title: "A clip", subreddit: "r/NSFW_GIF", author: "bob", permalink: "https://www.reddit.com/r/NSFW_GIF/comments/vid999/clip/", url: "https://v.redd.it/vid999", domain: "v.redd.it", score: 5, comments: 0, created_at: "2026-05-02T12:00:00.000Z", nsfw: true, thumbnail: "https://b.thumbs.redditmedia.com/v.jpg", media: [{ kind: "video", url: "https://v.redd.it/vid999" }], captured_at: CAPTURED },
    { fullname: "t3_txt001", title: "Text only", subreddit: "nsfw", author: "", permalink: "/r/nsfw/comments/txt001/", url: "https://example.com/article", domain: "example.com", score: 1, comments: 2, created_at: "2026-05-03T12:00:00.000Z", nsfw: true, thumbnail: "nsfw", media: [], captured_at: CAPTURED },
    { fullname: "t3_gal777", title: "Gallery", subreddit: "NSFW", author: "carol", permalink: "/r/NSFW/comments/gal777/gallery/", url: "https://www.reddit.com/gallery/gal777", domain: "reddit.com", score: 3, comments: 1, created_at: "2026-05-04T12:00:00.000Z", nsfw: true, thumbnail: "https://b.thumbs.redditmedia.com/g.jpg", media: [{ kind: "gallery", url: "https://www.reddit.com/r/NSFW/comments/gal777/gallery/" }], captured_at: CAPTURED },
  ],
};

const xExport = {
  export_version: 1,
  bookmarks: [{ tweet_id: "1893", text: "hello #world", author_username: "someone", tweet_created_at: "2026-01-01T00:00:00Z", media_items: [] }],
};

test("a Reddit export is detected as the reddit adapter, and X exports still go to xdash", () => {
  assert.equal(registry.detect(redditExport).adapter.id, "reddit");
  assert.equal(registry.detect(xExport).adapter.id, "xdash");
});

test("the same Reddit shape without the source tag is still recognised as Reddit", () => {
  const untagged = { posts: redditExport.posts };
  assert.equal(registry.detect(untagged).adapter.id, "reddit");
});

test("Reddit rows map to posts keyed by fullname, marked as Reddit, with the permalink as the link", () => {
  const { posts, adapter } = normalize(redditExport, { keepTextOnly: true });
  assert.equal(adapter, "reddit");
  assert.deepEqual(posts.map((p) => p.id), ["t3_abc123", "t3_vid999", "t3_txt001", "t3_gal777"]);
  const [photo] = posts;
  assert.equal(photo.platform, "reddit");
  assert.equal(photo.url, "https://www.reddit.com/r/NSFWPics/comments/abc123/sunset/");
  assert.equal(photo.author.username, "alice");
  assert.equal(photo.author.name, "u/alice");
  assert.equal(photo.createdAt, Date.parse("2026-05-01T12:00:00.000Z"));
  assert.equal(photo.savedAt, Date.parse(CAPTURED), "savedAt is the capture time");
  assert.equal(photo.text, "Sunset #evening");
  assert.deepEqual(photo.hashtags, ["evening", "nsfwpics"], "the subreddit becomes a tag beside the title's hashtags");
  assert.equal(photo.flags.sensitive, true, "NSFW Reddit posts are sensitive");
  assert.equal(photo.metrics.likes, 42);
  assert.equal(photo.media.length, 1);
  assert.equal(photo.media[0].kind, "photo");
  assert.equal(photo.media[0].thumb, "https://i.redd.it/x1.jpg");
});

test("a Reddit-hosted video plays through its HLS playlist (with sound); galleries stay stills", () => {
  const { posts } = normalize(redditExport, { keepTextOnly: true });
  const [, video, , gallery] = posts;
  assert.equal(video.media[0].kind, "video");
  assert.equal(video.media[0].hls, "https://v.redd.it/vid999/HLSPlaylist.m3u8");
  assert.equal(video.media[0].hlsFirst, true);
  assert.deepEqual(video.media[0].sources.map((s) => s.url), [720, 480, 360, 240].map((h) => `https://v.redd.it/vid999/DASH_${h}.mp4`));
  assert.equal(gallery.media[0].kind, "photo");
  assert.match(gallery.media[0].alt, /Reddit gallery/);
});

test("a video link that is not a v.redd.it address stays a still, never a guessed stream", () => {
  const json = {
    source: "reddit-saved-nsfw",
    posts: [{ fullname: "t3_odd001", title: "Odd", subreddit: "NSFW", author: "x", permalink: "/r/NSFW/comments/odd001/odd/", url: "https://example.com/v", thumbnail: "https://b.thumbs.redditmedia.com/o.jpg", media: [{ kind: "video", url: "https://example.com/v.mp4" }], score: 1, comments: 0, created_at: "2026-05-05T12:00:00.000Z", nsfw: true }],
  };
  const { posts } = normalize(json, { keepTextOnly: true });
  assert.equal(posts[0].media[0].kind, "photo");
  assert.equal(posts[0].media[0].hls, "");
  assert.match(posts[0].media[0].alt, /Reddit video/);
});

/* ------------------------------------------------------- export v2 (CMAF) -- */

const v2Export = {
  export_version: 2, source: "reddit-saved-nsfw", count: 1,
  posts: [{
    fullname: "t3_cmaf01", title: "A clip", subreddit: "NSFW_GIF", author: "bob",
    permalink: "/r/NSFW_GIF/comments/cmaf01/clip/", url: "https://v.redd.it/cmaf01",
    score: 5, comments: 0, created_at: "2026-05-02T12:00:00.000Z", nsfw: true,
    thumbnail: "https://b.thumbs.redditmedia.com/v.jpg",
    media: [{
      kind: "video", url: "https://v.redd.it/cmaf01",
      hls: "https://v.redd.it/cmaf01/HLSPlaylist.m3u8",
      duration: 41.83, width: 1280, height: 720,
      files: [
        { url: "https://v.redd.it/cmaf01/CMAF_720.mp4", height: 720, verified: true },
        { url: "https://v.redd.it/cmaf01/CMAF_220.mp4", height: 220, verified: false },
      ],
      audio: "https://v.redd.it/cmaf01/CMAF_AUDIO_64.mp4",
    }],
    captured_at: CAPTURED,
  }],
};

test("an export v2 video plays its captured file ladder first, with the audio track beside it", () => {
  const { posts } = normalize(v2Export, { keepTextOnly: true });
  const m = posts[0].media[0];
  assert.equal(m.kind, "video");
  assert.equal(m.hls, "https://v.redd.it/cmaf01/HLSPlaylist.m3u8");
  assert.equal(m.hlsFirst, false, "the real files come first; the master is the last resort");
  assert.deepEqual(m.sources.map((s) => s.url), ["https://v.redd.it/cmaf01/CMAF_720.mp4", "https://v.redd.it/cmaf01/CMAF_220.mp4"]);
  assert.deepEqual(m.sources.map((s) => s.bitrate), [720000, 220000]);
  assert.equal(m.audio, "https://v.redd.it/cmaf01/CMAF_AUDIO_64.mp4");
  assert.equal(m.duration, 41.83);
  assert.equal(m.width, 1280);
  assert.equal(m.height, 720);
});

test("an export v2 video without an audio track is silent, not broken", () => {
  const json = structuredClone(v2Export);
  delete json.posts[0].media[0].audio;
  const { posts } = normalize(json, { keepTextOnly: true });
  assert.equal(posts[0].media[0].audio, "");
  assert.equal(posts[0].media[0].hlsFirst, false);
});

test("a v2 record whose file list is empty falls back to the legacy ladder, never to nothing", () => {
  const json = structuredClone(v2Export);
  json.posts[0].media[0].files = [];
  const { posts } = normalize(json, { keepTextOnly: true });
  const m = posts[0].media[0];
  assert.equal(m.hlsFirst, true, "no files → the master playlist is the only hope again");
  assert.deepEqual(m.sources.map((s) => s.url), [720, 480, 360, 240].map((h) => `https://v.redd.it/cmaf01/DASH_${h}.mp4`));
});

test("text-only Reddit posts keep their external link and an explicit deleted author", () => {
  const { posts } = normalize(redditExport, { keepTextOnly: true });
  const text = posts[2];
  assert.equal(text.media.length, 0);
  assert.deepEqual(text.links, ["https://example.com/article"]);
  assert.equal(text.author.username, "deleted");
  assert.equal(text.author.name, "[deleted]");
});

test("text-only Reddit posts are dropped unless text-only posts are kept", () => {
  assert.equal(normalize(redditExport, { keepTextOnly: false }).posts.length, 3);
  assert.equal(normalize(redditExport, { keepTextOnly: true }).posts.length, 4);
});

test("rows without a valid Reddit fullname are skipped, not guessed at", () => {
  const json = { source: "reddit-saved-nsfw", posts: [{ fullname: "abc", title: "bad" }, { title: "no id" }, { fullname: "t3_ok1", title: "good", media: [], nsfw: true }] };
  assert.deepEqual(normalize(json).posts.map((p) => p.id), ["t3_ok1"]);
});

test("X posts keep platform x, and Reddit ids never collide with numeric X ids", () => {
  const [x] = normalize(xExport).posts;
  assert.equal(x.platform, "x");
  assert.equal(model.platformLabel(x), "X");
  assert.equal(model.platformLabel(normalize(redditExport).posts[0]), "Reddit");
  assert.ok(!/^\d+$/.test("t3_abc123"));
});

test("the async pipeline (used by the importer) gives the same Reddit posts", async () => {
  const { posts, adapter } = plain(await registry.normalizeAsync(redditExport, { keepTextOnly: true }));
  assert.equal(adapter, "reddit");
  assert.equal(posts.length, 4);
  assert.ok(posts.every((p) => p.platform === "reddit"));
});

test("a link post's Reddit thumbnail becomes its still, and a post with no thumbnail stays text-only", () => {
  const json = {
    source: "reddit-saved-nsfw",
    posts: [
      { fullname: "t3_link01", title: "Clip from a site", subreddit: "NSFW", author: "dan", permalink: "/r/NSFW/comments/link01/clip/", url: "https://www.redgifs.com/watch/abc", thumbnail: "https://external-preview.redd.it/thumb-link01.jpeg?width=140", media: [], score: 3, comments: 0, created_at: "2026-05-03T12:00:00.000Z", nsfw: true },
      { fullname: "t3_self02", title: "Just words", subreddit: "NSFW", author: "eve", permalink: "/r/NSFW/comments/self02/words/", url: "https://www.reddit.com/r/NSFW/comments/self02/words/", thumbnail: "self", media: [], score: 1, comments: 0, created_at: "2026-05-04T12:00:00.000Z", nsfw: true },
    ],
  };
  const { posts } = normalize(json, { keepTextOnly: true });
  assert.equal(posts[0].media.length, 1);
  assert.equal(posts[0].media[0].kind, "photo");
  assert.equal(posts[0].media[0].thumb, "https://external-preview.redd.it/thumb-link01.jpeg?width=140");
  assert.equal(posts[1].media.length, 0);
});
