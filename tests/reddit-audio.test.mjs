/* app.playback: the synced audio track for Reddit CMAF videos. The playable video
   files are silent; a hidden <audio> element carries the sound and is driven by the
   same handle the features already use. These tests run the real playback service
   against a fake engine, resolver, document and media elements. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXR } from "./helpers/xr.mjs";

/* Node has EventTarget/CustomEvent; a fake media element only needs what wire() touches. */
class FakeMedia extends EventTarget {
  constructor(tag) {
    super();
    this.tag = tag;
    this.src = "";
    this.muted = false;
    this.playbackRate = 1;
    this.preload = "";
    this.loop = false;
    this.poster = "";
    this.currentTime = 0;
    this.paused = true;
    this.plays = 0;
    this.pauses = 0;
    this.loads = 0;
  }
  setAttribute() { /* not interesting here */ }
  removeAttribute(name) { if (name === "src") this.src = ""; }
  play() { this.paused = false; this.plays++; this.dispatchEvent(new Event("play")); return Promise.resolve(); }
  pause() { this.pauses++; this.paused = true; this.dispatchEvent(new Event("pause")); }
  load() { this.loads++; }
  remove() { /* not interesting here */ }
}

function setup() {
  const { XR, load } = createXR();
  load("src/core/util/index.js");
  load("src/core/events.js");
  load("src/core/domain/events.js");
  const created = [];
  const fakeDocument = {
    createElement: (tag) => { const el = new FakeMedia(tag); created.push(el); return el; },
    body: { appendChild() { /* the fake element lives in `created`, not the DOM */ } },
  };
  load("src/application/services/playback.js", { document: fakeDocument });

  let currentSource = null;
  XR.provide("app.ports.playerEngine", {
    attach: () => ({ ready: null }),
    detach: () => {},
    currentSource: () => currentSource,
  });
  let candidates = [];
  XR.provide("app.ports.mediaResolver", { audio: () => candidates.slice(), poster: () => "" });
  XR.provide("app.activity", { progressEntry: () => null, noteOpen: () => {}, saveProgress: () => {}, clearProgress: () => {} });
  const values = { startMuted: false, speed: 1, loopShorts: false, rememberProgress: false, localMediaDir: "" };
  XR.provide("app.prefs", { get: (k) => values[k], set: () => {}, onChange: () => () => {} });
  return {
    playback: XR.resolve("app.playback"),
    created,
    set candidates(list) { candidates = list; },
    onHls: () => { currentSource = { url: "https://v.redd.it/x/HLSPlaylist.m3u8", type: "hls" }; },
  };
}

const videoMedia = (audio) => ({
  id: "t3_x:0", postId: "t3_x", index: 0, kind: "video", thumb: "", poster: "",
  sources: [{ url: "https://v.redd.it/x/CMAF_720.mp4", type: "video/mp4", bitrate: 720000 }],
  hls: "https://v.redd.it/x/HLSPlaylist.m3u8", hlsFirst: false,
  audio, width: 1280, height: 720, aspect: 16 / 9, duration: 41, alt: "",
});

test("a silent-file video wires a synced audio element: local file first, then the remote track", () => {
  const s = setup();
  s.candidates = [
    { url: "media/t3_x_1-audio.mp4", type: "audio/mp4", local: true },
    { url: "https://v.redd.it/x/CMAF_AUDIO_64.mp4", type: "audio/mp4" },
  ];
  const video = new FakeMedia("video");
  playback_wire(s, video, videoMedia("https://v.redd.it/x/CMAF_AUDIO_64.mp4"));
  const audio = s.created.find((el) => el.tag === "audio");
  assert.ok(audio, "an audio element was created");
  assert.equal(audio.src, "media/t3_x_1-audio.mp4", "the downloaded local file is tried first");
});

test("playing the video starts the audio track at the same position", async () => {
  const s = setup();
  s.candidates = [{ url: "https://v.redd.it/x/CMAF_AUDIO_64.mp4", type: "audio/mp4" }];
  const video = new FakeMedia("video");
  playback_wire(s, video, videoMedia("https://v.redd.it/x/CMAF_AUDIO_64.mp4"));
  const audio = s.created.find((el) => el.tag === "audio");
  video.currentTime = 3.2;
  await video.play();
  assert.equal(audio.plays, 1);
  assert.equal(audio.currentTime, 3.2);
  video.pause();
  assert.equal(audio.paused, true, "pausing the video pauses the track");
});

test("a failing audio candidate falls through to the next; exhaustion is reported, playback continues", async () => {
  const s = setup();
  s.candidates = [
    { url: "media/t3_x_1-audio.mp4", type: "audio/mp4", local: true },
    { url: "https://v.redd.it/x/CMAF_AUDIO_64.mp4", type: "audio/mp4" },
  ];
  const video = new FakeMedia("video");
  playback_wire(s, video, videoMedia("https://v.redd.it/x/CMAF_AUDIO_64.mp4"));
  const audio = s.created.find((el) => el.tag === "audio");
  const told = [];
  video.addEventListener("xr:audio-unavailable", (e) => told.push(e.detail));
  await video.play();

  audio.dispatchEvent(new Event("error"));   // the local file is missing
  assert.equal(audio.src, "https://v.redd.it/x/CMAF_AUDIO_64.mp4", "the remote track takes over");
  assert.equal(audio.plays, 2, "the track restarted");
  assert.deepEqual(told, [], "no complaint while a candidate remains");

  audio.dispatchEvent(new Event("error"));   // the remote track is blocked too
  assert.equal(told.length, 1, "the feature is told the sound is gone");
  assert.equal(told[0].url, "https://v.redd.it/x/CMAF_AUDIO_64.mp4");
  assert.equal(audio.paused, true);
  assert.equal(video.paused, false, "the video itself keeps playing, muted");
});

test("global mute and speed drive the audio track too", async () => {
  const s = setup();
  s.candidates = [{ url: "https://v.redd.it/x/CMAF_AUDIO_64.mp4", type: "audio/mp4" }];
  const video = new FakeMedia("video");
  playback_wire(s, video, videoMedia("https://v.redd.it/x/CMAF_AUDIO_64.mp4"));
  const audio = s.created.find((el) => el.tag === "audio");
  await video.play();
  s.playback.setMuted(true);
  assert.equal(audio.muted, true);
  s.playback.setSpeed(2);
  assert.equal(audio.playbackRate, 2);
  s.playback.setMuted(false);
  assert.equal(audio.muted, false);
});

test("when the ladder falls back to the HLS master, the side track steps aside (that stream has sound)", async () => {
  const s = setup();
  s.candidates = [{ url: "https://v.redd.it/x/CMAF_AUDIO_64.mp4", type: "audio/mp4" }];
  const video = new FakeMedia("video");
  playback_wire(s, video, videoMedia("https://v.redd.it/x/CMAF_AUDIO_64.mp4"));
  const audio = s.created.find((el) => el.tag === "audio");
  const told = [];
  video.addEventListener("xr:audio-unavailable", (e) => told.push(e));
  s.onHls();
  await video.play();
  assert.equal(audio.src, "", "the side track was cleared");
  assert.deepEqual(told, [], "no complaint: the HLS stream carries its own sound");
});

test("an X video (no audio field) wires no audio element at all", () => {
  const s = setup();
  s.candidates = [];
  const video = new FakeMedia("video");
  playback_wire(s, video, videoMedia(""));
  assert.equal(s.created.filter((el) => el.tag === "audio").length, 0);
});

test("destroy tears the track down with the video", async () => {
  const s = setup();
  s.candidates = [{ url: "https://v.redd.it/x/CMAF_AUDIO_64.mp4", type: "audio/mp4" }];
  const video = new FakeMedia("video");
  const handle = playback_wire(s, video, videoMedia("https://v.redd.it/x/CMAF_AUDIO_64.mp4"));
  const audio = s.created.find((el) => el.tag === "audio");
  await video.play();
  handle.destroy();
  assert.equal(audio.paused, true);
  const playsBefore = audio.plays;
  await video.play();
  assert.equal(audio.plays, playsBefore, "no audio resurrects after destroy");
});

function playback_wire(s, video, media) {
  return s.playback.wire(video, media, {});
}
