import test from "node:test";
import assert from "node:assert/strict";
import RV from "../reddit-video.js";

/* Synthetic playlists shaped like the real thing the user's browser showed:
   a master (HLSPlaylist.m3u8) pointing at CMAF variant playlists, which map
   byte-ranges onto single CMAF_*.mp4 files, plus an audio rendition. */
const MASTER_URL = "https://v.redd.it/imn1w9qr5mgh1/HLSPlaylist.m3u8";
const MASTER = [
  "#EXTM3U",
  "#EXT-X-VERSION:6",
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="CMAF_AUDIO_64.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="a1"',
  "CMAF_720.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=416x234,CODECS="avc1.42c00c,mp4a.40.2",AUDIO="a1"',
  "CMAF_220.m3u8",
  "",
].join("\n");
const VARIANT = (name) => [
  "#EXTM3U",
  "#EXT-X-VERSION:6",
  "#EXT-X-TARGETDURATION:10",
  `#EXT-X-MAP:URI="${name}.mp4"`,
  "#EXTINF:4.0,",
  "#EXT-X-BYTERANGE:200000@0",
  `${name}.mp4`,
  "#EXT-X-ENDLIST",
  "",
].join("\n");
const POST_JSON = [{
  kind: "Listing",
  data: { children: [{ kind: "t3", data: { media: { reddit_video: {
    hls_url: MASTER_URL,
    dash_url: "https://v.redd.it/imn1w9qr5mgh1/DASHPlaylist.mpd",
    fallback_url: "https://v.redd.it/imn1w9qr5mgh1/DASH_720.mp4",
    duration: 41.83, width: 1280, height: 720, is_gif: false,
  } } } }] },
}];

const RECORD = {
  id: "imn1w9qr5mgh1",
  fullname: "t3_imn1w9qr5mgh1",
  permalink: "https://www.reddit.com/r/NSFW/comments/imn1w9qr5mgh1/clip/",
  media: [{ kind: "video", url: "https://v.redd.it/imn1w9qr5mgh1" }],
};

test("the master playlist yields its variant playlists and the audio rendition", () => {
  const { variants, audio } = RV.parseMasterPlaylist(MASTER, MASTER_URL);
  assert.deepEqual(variants.map((v) => v.url), [
    "https://v.redd.it/imn1w9qr5mgh1/CMAF_720.m3u8",
    "https://v.redd.it/imn1w9qr5mgh1/CMAF_220.m3u8",
  ]);
  assert.equal(variants[0].height, 720);
  assert.equal(variants[0].bandwidth, 1000000);
  assert.equal(audio.url, "https://v.redd.it/imn1w9qr5mgh1/CMAF_AUDIO_64.m3u8");
});

test("a master without an audio rendition is a genuinely silent post, not a failure", () => {
  const { variants, audio } = RV.parseMasterPlaylist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=100x100\nv.m3u8\n", "https://v.redd.it/x/HLSPlaylist.m3u8");
  assert.equal(variants.length, 1);
  assert.equal(audio, null);
});

test("a variant playlist names the single file its byte-ranges live in", () => {
  const { fileUrl } = RV.parseVariantPlaylist(VARIANT("CMAF_720"), "https://v.redd.it/imn1w9qr5mgh1/CMAF_720.m3u8");
  assert.equal(fileUrl, "https://v.redd.it/imn1w9qr5mgh1/CMAF_720.mp4");
});

test("a variant playlist without #EXT-X-MAP falls back to its first segment URI", () => {
  const text = "#EXTM3U\n#EXTINF:4.0,\nseg-1.mp4\n";
  const { fileUrl } = RV.parseVariantPlaylist(text, "https://v.redd.it/x/CMAF_480.m3u8");
  assert.equal(fileUrl, "https://v.redd.it/x/seg-1.mp4");
});

test("post JSON gives up the hosted-video facts", () => {
  assert.deepEqual(RV.videoInfoFromPostJson(POST_JSON), {
    hls: MASTER_URL,
    dash: "https://v.redd.it/imn1w9qr5mgh1/DASHPlaylist.mpd",
    fallback: "https://v.redd.it/imn1w9qr5mgh1/DASH_720.mp4",
    duration: 41.83, width: 1280, height: 720, isGif: false,
  });
  assert.equal(RV.videoInfoFromPostJson([{ data: { children: [{ data: {} }] } }]), null);
});

test("secure_media and crosspost video blocks are read too", () => {
  const json = [{ data: { children: [{ data: { secure_media: { reddit_video: { hls_url: "https://v.redd.it/a/HLSPlaylist.m3u8", duration: 2 } } } }] } }];
  assert.equal(RV.videoInfoFromPostJson(json).hls, "https://v.redd.it/a/HLSPlaylist.m3u8");
});

test("enrichMedia writes the v2 entry: file ladder, verified-only audio, real facts", () => {
  const info = RV.videoInfoFromPostJson(POST_JSON);
  const master = RV.parseMasterPlaylist(MASTER, MASTER_URL);
  const verified = {
    "https://v.redd.it/imn1w9qr5mgh1/CMAF_720.mp4": true,   // chosen variant, playlist read
    "https://v.redd.it/imn1w9qr5mgh1/CMAF_AUDIO_64.mp4": true, // audio, playlist read
  };
  const media = RV.enrichMedia(RECORD, { info, master, verified });
  assert.equal(media.length, 1);
  const entry = media[0];
  assert.equal(entry.kind, "video");
  assert.equal(entry.hls, MASTER_URL);
  assert.equal(entry.duration, 41.83);
  assert.equal(entry.width, 1280);
  assert.deepEqual(entry.files.map((f) => f.url), [
    "https://v.redd.it/imn1w9qr5mgh1/CMAF_720.mp4",
    "https://v.redd.it/imn1w9qr5mgh1/CMAF_220.mp4",
  ]);
  assert.deepEqual(entry.files.map((f) => f.verified), [true, false]); // 220 is a derived guess
  assert.equal(entry.audio, "https://v.redd.it/imn1w9qr5mgh1/CMAF_AUDIO_64.mp4");
});

test("an unverified audio URL never reaches the export", () => {
  const info = RV.videoInfoFromPostJson(POST_JSON);
  const master = RV.parseMasterPlaylist(MASTER, MASTER_URL);
  const media = RV.enrichMedia(RECORD, { info, master, verified: {} });
  assert.equal(media[0].audio, "");
});

test("chooseFile prefers the best variant at or below the cap, else the smallest above", () => {
  const files = [{ url: "a", height: 1080 }, { url: "b", height: 720 }, { url: "c", height: 220 }];
  assert.equal(RV.chooseFile(files).url, "b");
  assert.equal(RV.chooseFile(files, 200).url, "c");
  assert.equal(RV.chooseFile([{ url: "only", height: 1080 }], 720).url, "only");
  assert.equal(RV.chooseFile([]), null);
});

test("planDownloads names files exactly as the app's local-media resolver expects", () => {
  const info = RV.videoInfoFromPostJson(POST_JSON);
  const master = RV.parseMasterPlaylist(MASTER, MASTER_URL);
  const verified = { "https://v.redd.it/imn1w9qr5mgh1/CMAF_720.mp4": true, "https://v.redd.it/imn1w9qr5mgh1/CMAF_AUDIO_64.mp4": true };
  const record = { ...RECORD, media: RV.enrichMedia(RECORD, { info, master, verified }) };
  const plan = RV.planDownloads(record);
  assert.deepEqual(plan.video, { url: "https://v.redd.it/imn1w9qr5mgh1/CMAF_720.mp4", filename: "t3_imn1w9qr5mgh1_1.mp4" });
  assert.deepEqual(plan.audio, { url: "https://v.redd.it/imn1w9qr5mgh1/CMAF_AUDIO_64.mp4", filename: "t3_imn1w9qr5mgh1_1-audio.mp4" });
});

test("planDownloads refuses to guess: nothing verified, nothing planned", () => {
  const info = RV.videoInfoFromPostJson(POST_JSON);
  const master = RV.parseMasterPlaylist(MASTER, MASTER_URL);
  const record = { ...RECORD, media: RV.enrichMedia(RECORD, { info, master, verified: {} }) };
  const plan = RV.planDownloads(record);
  assert.equal(plan.video, null);
  assert.equal(plan.audio, null);
  assert.match(plan.skipped, /no verified video file/);
});

test("a legacy record (bare URL, no facts) plans nothing and says why", () => {
  const plan = RV.planDownloads(RECORD);
  assert.equal(plan.video, null);
  assert.match(plan.skipped, /no verified video file/);
});
