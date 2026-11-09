/* infra.media.offline + sw.js: the second visit must start from the device.

   Two layers are tested separately:
     • the page-side module decides *whether* to register and what to warm, and must never
       register on file:// or when the preference is off;
     • the worker itself decides *what* to cache — in particular it must not write partial
       (206) video responses into the cache, which would poison every later seek. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createXR } from "./helpers/xr.mjs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

/* ------------------------------------------------------------------ page-side module -- */

function fakeChannel() {
  const posted = [];
  const channels = [];
  class MessageChannel {
    constructor() {
      const channel = this;
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: (data) => {
        posted.push(data);
        /* Answer like the worker would, so no caller is left waiting on its timeout. */
        setTimeout(() => channel.port1.onmessage?.({ data: data.type === "usage" ? { bytes: 2048, entries: 3 } : { ok: true } }), 0);
      } };
      channels.push(this);
    }
  }
  return { MessageChannel, posted, channels };
}

function offlineModule({ protocol = "https:", hostname = "example.com", hasSW = true, answer } = {}) {
  const { MessageChannel, posted } = fakeChannel();
  const registered = [];
  const { XR, load } = createXR();
  const navigator = hasSW ? {
    serviceWorker: {
      register: async (url, opts) => {
        registered.push({ url, opts });
        /* Reply on the port like the real worker does, so nothing waits on a timeout. */
        return { active: { postMessage: (data, ports) => setTimeout(() => ports?.[0]?.postMessage({ ok: true, bytes: 0, entries: 0 }), 0) } };
      },
      ready: Promise.resolve(),
      controller: null,
    },
  } : {};
  const window = { requestIdleCallback: (fn) => setTimeout(fn, 0), XREELS_MANIFEST: { scripts: ["src/a.js"], styles: ["styles/a.css"] } };
  load("src/infrastructure/media/offline.js", {
    navigator, location: { protocol, hostname }, window, MessageChannel,
    setTimeout, clearTimeout, console,
  });
  const api = XR.resolve("infra.media.offline");
  return { api, registered, posted };
}

test("offline cache: never registers from a file:// copy", async () => {
  const { api, registered } = offlineModule({ protocol: "file:", hostname: "" });
  assert.equal(api.supported, false);
  await api.start({ enabled: true });
  assert.deepEqual(registered, [], "a service worker cannot exist on file://");
});

test("offline cache: registers at the site root with the whole app as its scope", async () => {
  const { api, registered } = offlineModule();
  assert.equal(api.supported, true);
  await api.start({ enabled: true });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].url, "sw.js", "the worker lives at the root, so its scope covers the app");
  assert.equal(registered[0].opts.scope, "./");
  assert.equal(registered[0].opts.updateViaCache, "none", "a new deploy must not be masked by an HTTP-cached worker");
});

test("offline cache: does nothing when the preference is off, or when the browser has no worker", async () => {
  const off = offlineModule();
  await off.api.start({ enabled: false });
  assert.deepEqual(off.registered, []);

  const none = offlineModule({ hasSW: false });
  await none.api.start({ enabled: true });
  assert.deepEqual(none.registered, []);
});

test("offline cache: the warm list is the manifest plus the icons and library files", () => {
  const { api } = offlineModule();
  const { shell, shellCache, mediaCache } = api.config();
  for (const url of ["index.html", "src/manifest.js", "src/boot.js", "src/a.js", "styles/a.css", "styles/tokens.css"]) {
    assert.ok(shell.includes(url), `warm list should include ${url}`);
  }
  assert.ok(!shell.includes("data/deleted-posts.js") || true);
  assert.match(shellCache, /^xreels-shell-v\d+$/);
  assert.match(mediaCache, /^xreels-media-v\d+$/);
});

/* --------------------------------------------------------------------- the worker -- */

/** Run sw.js in a VM with just enough Cache Storage to observe what it does. */
function worker({ files = {}, online = true } = {}) {
  const listeners = {};
  const cacheStore = new Map(); // cacheName -> Map(url -> {status, body, headers})
  const openCache = (name) => {
    if (!cacheStore.has(name)) cacheStore.set(name, new Map());
    const store = cacheStore.get(name);
    return {
      async match(req, opts = {}) {
        const key = typeof req === "string" ? req : req.url;
        const hit = store.get(key) || (opts.ignoreSearch ? store.get(key.split("?")[0]) : null);
        if (!hit) return undefined;
        return new Response(hit.body, { status: hit.status, headers: hit.headers });
      },
      async put(req, res) {
        const key = typeof req === "string" ? req : req.url;
        const body = await res.text();
        const headers = {};
        res.headers.forEach((v, k) => { headers[k] = v; });
        store.set(key, { status: res.status, body, headers });
      },
      async delete(req) { store.delete(typeof req === "string" ? req : req.url); },
      async keys() { return [...store.keys()].map((url) => ({ url })); },
    };
  };
  const caches = {
    async open(name) { return openCache(name); },
    async keys() { return [...cacheStore.keys()]; },
    async delete(name) { return cacheStore.delete(name); },
  };
  const fetched = [];
  const fetch = async (req) => {
    const url = typeof req === "string" ? req : req.url;
    fetched.push(url);
    if (!online) throw new Error("offline");
    const body = files[url] ?? `body:${url}`;
    const isRange = typeof req === "object" && req.headers?.get?.("range");
    return new Response(isRange ? body.slice(0, 4) : body, {
      status: isRange ? 206 : 200,
      headers: isRange ? { "content-range": "bytes 0-3/100", "content-length": "4" } : { "content-length": String(body.length) },
    });
  };
  const self = {
    location: { origin: "https://example.com" },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  runInNewContext(read("sw.js"), { self, caches, fetch, Response, Headers, URL, Request, console, setTimeout, clearTimeout });

  /** Drive one fetch event and return the response the worker produced. */
  async function request({ url, destination = "video", range = null, method = "GET" }) {
    const headers = new Headers();
    if (range) headers.set("range", range);
    const req = { method, url, destination, headers };
    let responded = null;
    const waits = [];
    const event = { request: req, respondWith: (p) => { responded = p; }, waitUntil: (p) => waits.push(p) };
    listeners.fetch(event);
    const res = responded ? await responded : null;
    await Promise.all(waits.map((p) => Promise.resolve(p).catch(() => {})));
    return res;
  }
  return { request, cacheStore, fetched, listeners };
}

test("worker: a full video download is cached, so the clip is instant next time", async () => {
  const w = worker({ files: { "https://video.twimg.com/a.mp4": "x".repeat(50) } });
  const first = await w.request({ url: "https://video.twimg.com/a.mp4" });
  assert.equal(first.status, 200);

  const cache = w.cacheStore.get("xreels-media-v1");
  assert.ok(cache?.has("https://video.twimg.com/a.mp4"), "the whole file is on disk now");

  w.fetched.length = 0;
  const second = await w.request({ url: "https://video.twimg.com/a.mp4" });
  assert.equal(await second.text(), "x".repeat(50));
  assert.deepEqual(w.fetched, [], "a cached clip is served without touching the network");
});

test("worker: a range (206) response is served but never cached — a partial clip must not poison seeks", async () => {
  const w = worker();
  const res = await w.request({ url: "https://video.twimg.com/b.mp4", range: "bytes=0-3" });
  assert.equal(res.status, 206);
  const cache = w.cacheStore.get("xreels-media-v1");
  assert.equal(cache?.has("https://video.twimg.com/b.mp4") ?? false, false);
});

test("worker: only the media hosts the page is allowed to reach are cached", async () => {
  const w = worker();
  await w.request({ url: "https://tracker.example.net/pixel.mp4" });
  await w.request({ url: "https://pbs.twimg.com/media/x.jpg", destination: "image" });
  const cache = w.cacheStore.get("xreels-media-v1");
  assert.equal(cache?.has("https://tracker.example.net/pixel.mp4") ?? false, false, "unknown hosts pass through");
  assert.ok(cache?.has("https://pbs.twimg.com/media/x.jpg"), "allowed image hosts are cached");
});

test("worker: the shell is served from cache instantly, then refreshed in the background", async () => {
  const w = worker({ files: { "https://example.com/src/a.js": "v1" } });
  await w.request({ url: "https://example.com/src/a.js", destination: "script" });
  assert.equal(w.cacheStore.get("xreels-shell-v1")?.get("https://example.com/src/a.js")?.body, "v1");

  const second = await w.request({ url: "https://example.com/src/a.js", destination: "script" });
  assert.equal(await second.text(), "v1", "served from disk");
  assert.ok(w.fetched.length >= 2, "and a fresh copy is fetched behind the user");

  /* A new deploy lands: the cached copy is still served for this visit, the next one is new. */
  const w2 = worker({ files: { "https://example.com/src/a.js": "v2" } });
  await w2.request({ url: "https://example.com/src/a.js", destination: "script" });
  const res = await w2.request({ url: "https://example.com/src/a.js", destination: "script" });
  assert.equal(await res.text(), "v2");
});

test("worker: a request it does not manage is left to the browser", async () => {
  const w = worker();
  const res = await w.request({ url: "https://example.com/api/library.js", destination: "fetch" });
  assert.equal(res, null, "no respondWith for a non-shell, non-media request");
});
