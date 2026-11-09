/* infra.media.player: the order in which a video element is given its sources.
   Reddit videos (hlsFirst) try their HLS playlist first, then fall back to the silent MP4s.
   Every other item keeps the original order: listed sources first, HLS after. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXR } from "./helpers/xr.mjs";

function fakeVideo({ nativeHls = false } = {}) {
  const listeners = {};
  const video = {
    paused: true, currentTime: 0, error: null, assigned: [],
    canPlayType: (type) => (nativeHls && /mpegurl/.test(type) ? "maybe" : ""),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    removeAttribute: () => {}, load: () => {}, pause: () => {},
    play: () => Promise.resolve(),
    dispatchEvent: (event) => { (listeners[event.type] || []).forEach((fn) => fn(event)); return true; },
    fail(code = 4) { video.error = { code }; video.dispatchEvent({ type: "error" }); },
  };
  Object.defineProperty(video, "src", { get() { return this._src || ""; }, set(value) { this.assigned.push(value); this._src = value; } });
  return video;
}

function load({ cached = {} } = {}) {
  const { XR, load: loadFile } = createXR();
  XR.provide("app.ports.mediaResolver", {
    sources: (media) => media.sources || [],
    hls: (media) => media.hls || "",
    thumb: () => "",
    poster: () => "",
  });
  const warmCalls = [];
  XR.provide("app.ports.mediaPrefetch", {
    blobUrl: (url) => cached[url] || "",
    warm: async () => null,
    prefetch: async (url) => { warmCalls.push(url); return null; },
    warmAhead() {}, stats: () => ({}), clear() {}, setEnabled() {},
  });
  loadFile("src/infrastructure/media/player.js");
  const player = XR.resolve("infra.media.player");
  player.__warmCalls = warmCalls;
  return player;
}

const HLS = "https://v.redd.it/abc/HLSPlaylist.m3u8";
const MP4 = (h) => `https://v.redd.it/abc/DASH_${h}.mp4`;

test("a Reddit video (hlsFirst) starts on its HLS playlist, not on the silent MP4", () => {
  const player = load();
  const video = fakeVideo({ nativeHls: true });
  player.attach(video, { hls: HLS, hlsFirst: true, sources: [{ url: MP4(720), type: "video/mp4", bitrate: 720000 }] });
  assert.equal(video.assigned[0], HLS);
});

test("if HLS fails, a Reddit video falls back to its silent MP4s", () => {
  const player = load();
  const video = fakeVideo({ nativeHls: true });
  player.attach(video, { hls: HLS, hlsFirst: true, sources: [{ url: MP4(720), type: "video/mp4", bitrate: 720000 }, { url: MP4(480), type: "video/mp4", bitrate: 480000 }] });
  assert.equal(video.assigned[0], HLS);
  video.fail();
  assert.equal(video.assigned[1], MP4(720));
});

test("other media keep the original order: listed sources first, then HLS", () => {
  const player = load();
  const video = fakeVideo({ nativeHls: true });
  player.attach(video, { hls: "https://video.twimg.com/x.m3u8", sources: [{ url: "https://video.twimg.com/x.mp4", type: "video/mp4", bitrate: 832000 }] });
  assert.equal(video.assigned[0], "https://video.twimg.com/x.mp4");
});

test("hlsFirst without an HLS address is ignored: the listed sources play as before", () => {
  const player = load();
  const video = fakeVideo();
  player.attach(video, { hlsFirst: true, hls: "", sources: [{ url: MP4(360), type: "video/mp4", bitrate: 360000 }] });
  assert.equal(video.assigned[0], MP4(360));
});

test("a source that fails mid-playback must not strand the video: play resumes once the next source has data", () => {
  const player = load();
  const video = fakeVideo();
  const plays = [];
  video.play = () => { plays.push(video.src); return Promise.resolve(); };
  player.attach(video, { hls: "", sources: [{ url: "media/t3_x_1.mp4", type: "video/mp4", bitrate: 0 }, { url: MP4(720), type: "video/mp4", bitrate: 720000 }] });
  video.paused = false;
  video.dispatchEvent({ type: "play" });  // autoplay engaged on the (missing) local file
  video.fail();                           // 404: the swap aborts the pending play promise; the browser
  video.paused = true;                    // has already paused the element by the time the error arrives
  assert.equal(video.assigned[1], MP4(720), "the ladder moved on");
  assert.equal(plays.length, 0, "no futile synchronous play right after the src swap");
  video.dispatchEvent({ type: "loadeddata" });
  assert.equal(plays.length, 1, "playback resumed when the next source had data");
  assert.equal(plays[0], MP4(720));
  /* intent is one-shot: a second loadeddata (buffering) must not restart a paused video */
  video.dispatchEvent({ type: "loadeddata" });
  assert.equal(plays.length, 1);
});

test("a video that was paused before its source failed stays paused on the next source", () => {
  const player = load();
  const video = fakeVideo();
  const plays = [];
  video.play = () => { plays.push(1); return Promise.resolve(); };
  player.attach(video, { hls: "", sources: [{ url: MP4(480), type: "video/mp4", bitrate: 480000 }, { url: MP4(360), type: "video/mp4", bitrate: 360000 }] });
  video.fail();                          // never started playing: no intent to preserve
  video.dispatchEvent({ type: "loadeddata" });
  assert.equal(video.assigned[1], MP4(360), "the ladder still moved on");
  assert.equal(plays.length, 0, "but nothing resumed playback");
});

test("after detach, no loadeddata can resurrect playback", () => {
  const player = load();
  const video = fakeVideo();
  const plays = [];
  video.play = () => { plays.push(1); return Promise.resolve(); };
  player.attach(video, { hls: "", sources: [{ url: MP4(480), type: "video/mp4", bitrate: 480000 }] });
  video.paused = false;
  video.dispatchEvent({ type: "play" });
  video.fail();
  player.detach(video);
  video.dispatchEvent({ type: "loadeddata" });
  assert.equal(plays.length, 0);
});

/* ---- warm cache: a cached clip must play from memory, never from the network ---- */
test("a clip already in the warm cache plays from its blob URL, with no request", () => {
  const player = load({ cached: { [MP4(720)]: "blob:https://app/warm-1" } });
  const video = fakeVideo({ nativeHls: true });
  player.attach(video, { hls: "", hlsFirst: false, sources: [{ url: MP4(720), type: "video/mp4", bitrate: 720000 }] });
  assert.equal(video.assigned[0], "blob:https://app/warm-1", "plays the in-memory copy");
  assert.equal(video.dataset.warm, "1", "the cache hit is recorded on the element");
  assert.equal(video.assigned.length, 1, "exactly one source assignment: no fallback request");
});

test("a clip that is not cached plays from the CDN and is warmed for next time", () => {
  const player = load();
  const video = fakeVideo({ nativeHls: true });
  player.attach(video, { sources: [{ url: MP4(480), type: "video/mp4", bitrate: 480000 }] });
  assert.equal(video.assigned[0], MP4(480), "streams from the network now");
  assert.deepEqual(player.__warmCalls, [MP4(480)], "and asks the cache to keep it");
});

test("HLS playlists are never warmed (they are manifests, not bytes)", () => {
  const player = load();
  const video = fakeVideo({ nativeHls: true });
  player.attach(video, { hls: HLS, hlsFirst: true, sources: [] });
  assert.equal(video.assigned[0], HLS);
  assert.deepEqual(player.__warmCalls, [], "the .m3u8 is left to the engine");
});
