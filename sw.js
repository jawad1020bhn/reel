/* sw.js — the service worker behind infra.media.offline.

   Two caches:
     shell-*  the app itself (html, css, js, fonts, the library JSON). Stale-while-
              revalidate: a repeat visit opens from disk in a few milliseconds while a
              fresh copy is fetched behind the user's back.
     media-*  video/audio/image bytes. Cache-first, and only for the media hosts the page
              is already allowed to talk to. This is what makes seeking inside a clip you
              have already watched free: the bytes are on disk.

   Nothing here is allowed to break the app: every handler falls back to the network on
   any error, and unknown requests are passed straight through. */

const VERSION = "v1";
const SHELL_CACHE = `xreels-shell-${VERSION}`;
const MEDIA_CACHE = `xreels-media-${VERSION}`;
const CURRENT = new Set([SHELL_CACHE, MEDIA_CACHE]);
const MEDIA_BUDGET_BYTES = 900 * 1024 * 1024;   // stop caching media past ~900 MB
const MEDIA_MAX_ENTRY = 24 * 1024 * 1024;       // a single clip bigger than this is re-fetched

/* Same hosts the page's CSP already permits for media. */
const MEDIA_HOSTS = [
  "video.twimg.com",
  "pbs.twimg.com",
  "commondatastorage.googleapis.com",
  "v.redd.it",
  "preview.redd.it",
  "i.redd.it",
  "external-preview.redd.it",
];

const isMediaRequest = (req) => {
  const url = new URL(req.url);
  if (!MEDIA_HOSTS.includes(url.hostname)) return false;
  return req.destination === "video" || req.destination === "audio" || req.destination === "image" ||
    /\.(mp4|m4a|m4s|webm|ts|jpe?g|png|webp|avif|gif|mp3|aac)(\?|$)/i.test(url.pathname) ||
    req.headers.get("range") !== null;
};

/* Files that must never be served from a cache: the site password and the deletion
   ledger are checked on every boot, and /api/* is live data (the library endpoint). */
const NEVER_CACHE = [/^\/api\//, /^\/data\/deleted-posts\.js$/, /^\/site\.config\.js$/];

const sameOriginShell = (req) => {
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return false;
  if (NEVER_CACHE.some((re) => re.test(url.pathname))) return false;
  if (url.pathname === "/" || url.pathname === "") return true;
  return /\.(html|js|css|json|webmanifest|woff2?|svg|png|ico)$/i.test(url.pathname);
};

/** Range requests are the normal case for video: a partial response is not a full copy,
    so it is served but never written into the media cache. */
const isFullResponse = (res) => res && res.status === 200 && res.body && !res.headers.get("content-range");

async function putCached(cacheName, req, res) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(req, res.clone());
  } catch { /* quota or opaque response: not fatal */ }
}

async function trimMedia() {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const keys = await cache.keys();
    let total = 0;
    const sizes = [];
    for (const req of keys) {
      const res = await cache.match(req);
      const length = Number(res?.headers.get("content-length") || 0);
      sizes.push({ req, length });
      total += length;
    }
    if (total <= MEDIA_BUDGET_BYTES) return;
    /* oldest first — Cache Storage keys() is insertion ordered */
    for (const { req, length } of sizes) {
      if (total <= MEDIA_BUDGET_BYTES) break;
      await cache.delete(req);
      total -= length;
    }
  } catch { /* best effort */ }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    /* Do not block activation on the shell: a broken entry must not strand the user on an
       old worker. The shell is warmed from the page once it is idle. */
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith("xreels-") && !CURRENT.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  const reply = (payload) => event.ports?.[0]?.postMessage(payload);

  if (data.type === "warm-shell") {
    event.waitUntil((async () => {
      const cache = await caches.open(data.shellCache || SHELL_CACHE);
      const urls = Array.isArray(data.shell) ? data.shell : [];
      /* one at a time, ahead of nothing: this runs while the user is already reading */
      for (const url of urls) {
        try {
          if (await cache.match(url, { ignoreSearch: true })) continue;
          const res = await fetch(url, { cache: "no-cache" });
          if (res.ok) await cache.put(url, res);
        } catch { /* a missing file is fine */ }
      }
      reply({ ok: true, count: urls.length });
    })());
    return;
  }

  if (data.type === "usage") {
    event.waitUntil((async () => {
      let bytes = 0, entries = 0;
      try {
        const cache = await caches.open(data.mediaCache || MEDIA_CACHE);
        for (const req of await cache.keys()) {
          const res = await cache.match(req);
          bytes += Number(res?.headers.get("content-length") || 0);
          entries++;
        }
        const shell = await caches.open(data.shellCache || SHELL_CACHE);
        entries += (await shell.keys()).length;
      } catch { /* ignore */ }
      reply({ bytes, entries });
    })());
    return;
  }

  if (data.type === "clear-media") {
    event.waitUntil((async () => {
      try { await caches.delete(data.mediaCache || MEDIA_CACHE); reply({ ok: true }); }
      catch { reply({ ok: false }); }
    })());
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  /* Media: cache-first. A cached clip plays instantly and seeking inside it is free. */
  if (isMediaRequest(req)) {
    event.respondWith((async () => {
      const cache = await caches.open(MEDIA_CACHE);
      const hit = await cache.match(req, { ignoreVary: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (isFullResponse(res)) {
        const length = Number(res.headers.get("content-length") || 0);
        if (!length || length <= MEDIA_MAX_ENTRY) {
          event.waitUntil(putCached(MEDIA_CACHE, req, res).then(trimMedia));
        }
      }
      return res;
    })().catch(() => fetch(req)));
    return;
  }

  if (!sameOriginShell(req)) return;

  /* The shell: cache first (instant), refresh behind the user. */
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then(async (res) => {
      /* await the write: waitUntil keeps the worker alive exactly as long as this promise */
      if (res.ok) await putCached(SHELL_CACHE, req, res);
      return res;
    });
    /* Always register the write with the event, so the browser keeps the worker alive
       long enough to finish caching — a floating promise here would be killed. */
    event.waitUntil(network.catch(() => {}));
    if (hit) return hit;
    try { return await network; }
    catch { return hit || Response.error(); }
  })().catch(() => fetch(req)));
});
