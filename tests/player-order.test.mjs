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

function load() {
  const { XR, load: loadFile } = createXR();
  XR.provide("app.ports.mediaResolver", {
    sources: (media) => media.sources || [],
    hls: (media) => media.hls || "",
    thumb: () => "",
    poster: () => "",
  });
  loadFile("src/infrastructure/media/player.js");
  return XR.resolve("infra.media.player");
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
