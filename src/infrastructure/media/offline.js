/* infra.media.offline — a small service worker so the *second* visit starts from the
   device instead of the network.

   Why it matters for "zero buffering":
     • the shell (manifest, kernel, every src/*.js, every stylesheet, the fonts) is served
       from Cache Storage, so boot no longer waits on a round trip per file;
     • media bytes are cached here too, so a clip that was watched once is re-served from
       disk — seeking inside an already-watched clip never touches the network at all;
     • when the network *is* needed, the SW answers from cache immediately and refreshes
       in the background (stale-while-revalidate), so a slow connection cannot make the
       app slower than last time.

   Constraints this respects:
     • file:// has no service worker — register() simply does nothing there;
     • the app's CSP is untouched: the worker only *serves* the same origins the page is
       already allowed to fetch, and it never injects markup;
     • nothing here is required for the app to work. Every call is best-effort, and an
       unreachable /sw.js (a host without the file, a private window) is a no-op.

   The worker script itself lives at /sw.js because a service worker's scope is limited to
   its own directory: it must be served from the site root to control the whole app. */

XR.define("infra.media.offline", [], function () {
  "use strict";

  const VERSION = "v1";
  const SW_URL = "sw.js";
  const SHELL_CACHE = `xreels-shell-${VERSION}`;
  const MEDIA_CACHE = `xreels-media-${VERSION}`;

  /* The shell as it exists on disk. The worker fetches this list on install; entries that
     are missing are skipped, so the list can never break an install. */
  const SHELL = [
    "./", "index.html", "manifest.webmanifest", "site.config.js",
    "src/manifest.js", "src/kernel/kernel.js", "src/kernel/loader.js", "src/boot.js",
    "styles/tokens.css", "styles/base.css", "styles/components.css", "styles/editorial.css", "styles/layout.css",
    "styles/fonts/geist-latin.woff2", "styles/fonts/geist-mono.woff2", "styles/fonts/bebas-neue.woff2",
    "data/posts.js", "data/x-posts.json", "data/r-posts.json",
  ];

  const supported = () =>
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof location !== "undefined" &&
    location.protocol !== "file:" &&
    location.hostname !== "localhost";

  let registration = null;
  let state = { registered: false, controlled: false, ready: null };

  /** Inject the shell list the worker needs — it cannot read the JS manifest itself. */
  function config() {
    const scripts = (typeof window !== "undefined" && window.XREELS_MANIFEST?.scripts) || [];
    const styles = (typeof window !== "undefined" && window.XREELS_MANIFEST?.styles) || [];
    return { shell: [...new Set([...SHELL, ...styles, ...scripts])], shellCache: SHELL_CACHE, mediaCache: MEDIA_CACHE, version: VERSION };
  }

  /** Ask the worker to pre-cache a list of URLs while the user is reading (never blocking). */
  function warmShell() {
    if (!registration?.active) return Promise.resolve(false);
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const done = (ok) => { clearTimeout(timer); resolve(ok); };
      const timer = setTimeout(() => done(false), 20000);
      channel.port1.onmessage = (e) => done(!!e.data?.ok);
      try { registration.active.postMessage({ type: "warm-shell", ...config() }, [channel.port2]); }
      catch { done(false); }
    });
  }

  /** How many bytes the worker has cached, for the Settings page. */
  function usage() {
    if (!registration?.active) return Promise.resolve(null);
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 3000);
      channel.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data || null); };
      try { registration.active.postMessage({ type: "usage" }, [channel.port2]); }
      catch { clearTimeout(timer); resolve(null); }
    });
  }

  /** Drop the media cache (keeps the shell, so the app still opens instantly). */
  function clearMedia() {
    if (!registration?.active) return Promise.resolve(false);
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(false), 5000);
      channel.port1.onmessage = (e) => { clearTimeout(timer); resolve(!!e.data?.ok); };
      try { registration.active.postMessage({ type: "clear-media" }, [channel.port2]); }
      catch { clearTimeout(timer); resolve(false); }
    });
  }

  /** Register after the app is interactive: a service worker must never delay first paint.
      The caller owns the preference (infrastructure must not read app preferences). */
  function start({ enabled = true } = {}) {
    if (!supported() || !enabled) return Promise.resolve(state);
    if (state.ready) return state.ready;
    state.ready = (async () => {
      try {
        registration = await navigator.serviceWorker.register(SW_URL, { scope: "./", updateViaCache: "none" });
        state.registered = true;
        /* A brand-new worker is installing; warm the shell once it takes over. */
        const container = navigator.serviceWorker;
        const onReady = () => { state.controlled = true; };
        if (container.ready) container.ready.then(onReady, () => {});
        if (container.controller) state.controlled = true;
        /* Warm the *media* and *shell* caches only when the browser is idle, so this can
           never compete with the first videos the user actually asked for. */
        const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
        idle(() => { warmShell(); });
        return state;
      } catch (err) {
        console.warn("[offline] service worker unavailable", err);
        return state;
      }
    })();
    return state.ready;
  }

  return {
    start, warmShell, usage, clearMedia,
    config,
    get supported() { return supported(); },
    get state() { return { ...state, ready: undefined }; },
  };
});
