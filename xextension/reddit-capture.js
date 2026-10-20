/*
 * Reddit saved-posts capture: content script for old.reddit.com.
 *
 * Runs only on the signed-in user's own saved listing
 * (https://old.reddit.com/user/<name>/saved). It never calls the Reddit API.
 * It reads the rows already rendered on the page, then walks the "next" links
 * with same-origin fetch() so the browser's own session cookies are used.
 *
 * The popup drives it through runtime messages (type "reddit:*"). Progress is
 * written to chrome.storage.local (redditCaptureState) so the popup stays in
 * sync and a reload does not lose track of where the capture stopped.
 *
 * Pure rules (what counts as NSFW, normalization, pacing, storage shape) live in
 * reddit-saved.js. This file is only the DOM reader and the run loop.
 */
(() => {
  "use strict";

  const S = globalThis.XRedditSaved;
  const D = globalThis.XRedditDom;   // shared DOM readers (reddit-dom.js)
  const RV = globalThis.XRedditVideo; // the v2 video-facts module (reddit-video.js)
  if (!S || !D || typeof chrome === "undefined" || !chrome.runtime) return;

  const account = S.savedListingAccount(location.href);
  if (!account) return; // not the saved listing: nothing to do on this page

  /* One Reddit engine at a time: capture and unsave share the site's lock. */
  const LOCK_NAME = (globalThis.XEngineLock && XEngineLock.REDDIT_LOCK) || "xreels-reddit-exclusive-engine";
  const store = S.createStore(chrome.storage.local);
  const control = { pause: false, stop: false };
  let running = false;
  let state = emptyState();

  function emptyState() {
    return {
      status: "idle",
      account,
      pages: 0,
      rows: 0,
      nsfwKept: 0,
      sfwSkipped: 0,
      commentsSkipped: 0,
      saved: 0,
      videos: 0,
      videosEnriched: 0,
      nextUrl: null,
      error: null,
      updatedAt: new Date().toISOString(),
    };
  }

  /* ---------------------------------------------------------------------------
     Small helpers
     --------------------------------------------------------------------------- */

  /** Sleep that wakes early when the user pauses or stops. */
  function sleep(ms) {
    return new Promise((resolve) => {
      const end = Date.now() + Math.max(0, ms);
      const tick = () => {
        if (control.pause || control.stop || Date.now() >= end) return resolve();
        setTimeout(tick, Math.min(250, Math.max(0, end - Date.now())));
      };
      tick();
    });
  }

  async function setState(patch) {
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
    await chrome.storage.local.set({ [S.STATE_KEY]: state });
    return state;
  }

  /** Logged-in signal: old.reddit adds `loggedin` to <body>. Rows on the page are the fallback. */
  function looksLoggedIn() {
    return D.looksLoggedIn(document);
  }

  /* DOM reading is shared with the unsave engine (reddit-dom.js). */
  const readRows = (doc) => D.readRows(doc);
  const nextHref = (doc) => D.nextHref(doc);

  /**
   * Who the session belongs to, from /api/me.json. A fresh capture refuses to
   * start for a logged-out session, for a different account than the listing's
   * owner, or while the "I am over eighteen" preference is off — Reddit hides
   * every NSFW row in that state, so a capture would silently find nothing.
   * Returns null when the probe itself fails (the run then relies on the page).
   */
  async function probeIdentity() {
    try {
      const res = await fetch(location.origin + S.ME_PATH, { credentials: "include", cache: "no-store", headers: { Accept: "application/json" } });
      if (res.status !== 200) return null;
      return S.parseIdentity(await res.json());
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------------------------
     Network
     --------------------------------------------------------------------------- */

  /**
   * Fetch one saved page and parse it. Retries 429/5xx and network errors with
   * jittered backoff. Anything else (login, age gate, 403/404) is fatal.
   * Returns { doc } | { error } | { interrupted: true }.
   */
  async function fetchPage(url) {
    const maxRetries = S.DEFAULT_PACING.maxRetries;
    for (let attempt = 0; ; attempt++) {
      if (control.pause || control.stop) return { interrupted: true };

      let res;
      try {
        res = await fetch(url, {
          credentials: "include",
          redirect: "follow",
          headers: { Accept: "text/html" },
        });
      } catch {
        if (attempt >= maxRetries) return { error: "Network error loading the next saved page. Capture stopped." };
        await sleep(S.computeBackoff(attempt));
        continue;
      }

      const verdict = S.classifyStatus(res.status);
      if (verdict === "ok") {
        if (/\/(login|over18)(?:[/?#]|$)/i.test(res.url || "")) {
          return { error: "Reddit sent the page to a login or age-check screen. Log in and enable NSFW content, then Start again." };
        }
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        if (!D.isListing(doc)) return { error: "Reddit returned a page that is not a saved listing. Reload old.reddit.com and check that you are still logged in." };
        return { doc };
      }
      if (verdict === "retry" && attempt < maxRetries) {
        await sleep(S.computeBackoff(attempt));
        continue;
      }
      if (verdict === "retry") return { error: "Reddit kept rate-limiting this capture (HTTP " + res.status + "). Wait a while, then Start again." };
      return { error: "Reddit returned HTTP " + res.status + " for a saved page. Capture stopped." };
    }
  }

  /* ---------------------------------------------------------------------------
     Video enrichment (export v2)
     For each captured v.redd.it video, read the post's .json (same-origin, with
     the session) for the HLS master URL, then read the master and the chosen
     variant playlists through the background worker (v.redd.it is cross-origin
     here). The real file URLs land in the record. Every failure is skipped
     silently: enrichment must never stop a capture.
     --------------------------------------------------------------------------- */

  const sleepJitter = (lo, hi) => sleep(lo + Math.random() * (hi - lo));

  /** Fetch text through the background worker, which holds the v.redd.it host
      permission. Returns { text } | { error } | null when unavailable. */
  async function bgFetchText(url) {
    if (!RV) return null;
    try {
      const res = await chrome.runtime.sendMessage({ type: "reddit:fetchText", url });
      if (res && res.ok) return { text: res.text };
      return { error: (res && res.status) || "unavailable" };
    } catch {
      return { error: "message failed" };
    }
  }

  /** The post's own .json, fetched same-origin so the session cookies apply. */
  async function fetchPostJson(permalink) {
    let path = "";
    try {
      path = new URL(permalink, location.origin).pathname.replace(/\/$/, "");
    } catch {
      return null;
    }
    if (!/^\/r\//.test(path) && !/^\/comments\//.test(path)) return null;
    try {
      const res = await fetch(location.origin + path + ".json", { credentials: "include", headers: { Accept: "application/json" } });
      if (S.classifyStatus(res.status) !== "ok") return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /** Enrich one stored record in place. Returns true when v2 facts were added. */
  async function enrichVideoPost(post) {
    if (!RV) return false;
    const entry = (post.media || []).find((m) => m && m.kind === "video");
    if (!entry) return false;
    const info = RV.videoInfoFromPostJson(await fetchPostJson(post.permalink));
    if (!info || !info.hls) return false;

    const masterRes = await bgFetchText(info.hls);
    if (!masterRes || masterRes.error) return false;
    const master = RV.parseMasterPlaylist(masterRes.text, info.hls);
    if (!master.variants.length && !master.audio) return false;

    /* Verify the variant we would download (≤720) plus the audio rendition by
       reading their playlists — the only guaranteed-correct file URLs. */
    const want = [];
    const chosen = RV.chooseFile(master.variants.map((v) => ({ url: v.url, height: v.height })), RV.DEFAULT_MAX_HEIGHT);
    if (chosen) want.push(chosen.url);
    if (master.audio) want.push(master.audio.url);
    const verified = {};
    for (const playlistUrl of want) {
      const variantRes = await bgFetchText(playlistUrl);
      if (variantRes && !variantRes.error) {
        const { fileUrl } = RV.parseVariantPlaylist(variantRes.text, playlistUrl);
        if (fileUrl) verified[fileUrl] = true;
      }
      await sleepJitter(400, 900);
    }
    const media = RV.enrichMedia(post, { info, master, verified });
    if (!media) return false;
    post.media = media;
    return true;
  }

  /** Enrich every video post of a captured batch, paced. Updates state counters. */
  async function enrichBatch(posts) {
    let videos = 0;
    let enriched = 0;
    for (const post of posts) {
      if (control.stop || control.pause) break;
      if (!(post.media || []).some((m) => m && m.kind === "video")) continue;
      videos++;
      if (await enrichVideoPost(post)) enriched++;
      await sleepJitter(900, 1800);
    }
    return { videos, enriched };
  }

  /* ---------------------------------------------------------------------------
     Run loop
     --------------------------------------------------------------------------- */

  async function run(mode) {
    running = true;
    control.pause = false;
    control.stop = false;
    try {
      const owner = (await store.load()) && store.account();
      if (owner && owner.toLowerCase() !== account.toLowerCase()) {
        await setState({ status: "error", error: "Captured posts belong to u/" + owner + ". Export them or Reset before capturing u/" + account + "." });
        return;
      }

      const canResume = mode === "resume" && state.nextUrl && state.account === account;
      let doc = null;
      let url = location.href;
      let counters = { pages: 0, rows: 0, nsfwKept: 0, sfwSkipped: 0, commentsSkipped: 0 };

      if (canResume) {
        url = state.nextUrl;
        counters = {
          pages: state.pages, rows: state.rows, nsfwKept: state.nsfwKept,
          sfwSkipped: state.sfwSkipped, commentsSkipped: state.commentsSkipped,
          videos: state.videos || 0, videosEnriched: state.videosEnriched || 0,
        };
      } else {
        if (!looksLoggedIn() && !document.querySelector(".thing")) {
          await setState({ status: "error", error: "Log in to old.reddit.com, then reload this saved page." });
          return;
        }
        const who = await probeIdentity();
        if (who && !who.loggedIn) {
          await setState({ status: "error", error: "Log in to old.reddit.com, then reload this saved page." });
          return;
        }
        if (who && who.loggedIn && who.name.toLowerCase() !== account.toLowerCase()) {
          await setState({ status: "error", error: "You are logged in as u/" + who.name + ", but this is u/" + account + "'s saved page. Open your own saved page." });
          return;
        }
        if (who && who.over18 === false) {
          await setState({ status: "error", error: "Reddit is hiding NSFW posts. Turn on \"I am over eighteen years old and willing to view adult content\" in your Reddit preferences, then Start again." });
          return;
        }
        doc = document;
      }

      const visited = new Set();
      await setState({ status: "running", error: null, account, nextUrl: canResume ? url : null, ...counters, saved: store.count() });

      while (true) {
        if (control.stop) { await setState({ status: "stopped" }); return; }
        if (control.pause) { await setState({ status: "paused" }); return; }

        if (!doc) {
          visited.add(url);
          const fetched = await fetchPage(url);
          if (fetched.interrupted) continue;
          if (fetched.error) { await setState({ status: "error", error: fetched.error }); return; }
          doc = fetched.doc;
        }

        const batch = S.processRows(readRows(doc), new Date().toISOString());
        /* Videos learn their real CMAF URLs before being stored (export v2). */
        const enrichStats = await enrichBatch(batch.posts);
        await store.append(batch.posts, { account });
        counters = {
          pages: counters.pages + 1,
          rows: counters.rows + batch.counts.rows,
          nsfwKept: counters.nsfwKept + batch.counts.nsfwKept,
          sfwSkipped: counters.sfwSkipped + batch.counts.sfwSkipped,
          commentsSkipped: counters.commentsSkipped + batch.counts.commentsSkipped,
          videos: counters.videos + enrichStats.videos,
          videosEnriched: counters.videosEnriched + enrichStats.enriched,
        };

        const next = S.resolveNextUrl(nextHref(doc), url, account);
        const repeated = next && visited.has(next);
        await setState({ ...counters, saved: store.count(), nextUrl: repeated ? null : next, status: "running" });

        if (!next || repeated) {
          await setState({ status: "done", nextUrl: null });
          return;
        }

        url = next;
        doc = null;
        await sleep(pacer.nextGap().ms);
      }
    } catch (err) {
      await setState({ status: "error", error: "Capture failed: " + (err && err.message ? err.message : String(err)) });
    } finally {
      running = false;
    }
  }

  const pacer = S.createPacer({ rng: Math.random });

  /**
   * Start or resume. The browser-owned Web Lock is shared with the unsave
   * engine, so neither two capturing tabs nor a capture and an unsave can run
   * against the same session at once. The lease is held for the whole run and
   * released when it pauses, stops, finishes or the tab goes away.
   */
  async function startRun(mode) {
    if (running) return { ok: false, error: "Already capturing." };
    let release = null;
    if (globalThis.XEngineLock) {
      release = await XEngineLock.acquire(LOCK_NAME);
      if (!release) return { ok: false, error: "Another Reddit engine (capture or unsave) is already running. Stop it first." };
    } else if (!navigator.locks) {
      return { ok: false, error: "This browser cannot guarantee a single run. Update Chrome." };
    }
    running = true; // claim synchronously so a double-click cannot start two runs
    run(mode).finally(() => { if (release) release(); });
    return { ok: true };
  }

  /* ---------------------------------------------------------------------------
     Messages from the popup
     --------------------------------------------------------------------------- */

  async function handle(msg) {
    switch (msg.type) {
      case "reddit:getState":
        return { ok: true, state, loggedIn: looksLoggedIn() };

      case "reddit:start": {
        const started = await startRun(state.nextUrl && state.account === account ? "resume" : "fresh");
        return { ...started, state };
      }

      case "reddit:pause":
        if (running) control.pause = true;
        return { ok: true };

      case "reddit:stop":
        if (running) control.stop = true;
        return { ok: true };

      case "reddit:reset": {
        if (running) return { ok: false, error: "Pause or stop before resetting." };
        await store.clear();
        state = emptyState();
        await setState({});
        return { ok: true, state };
      }

      default:
        return { ok: false, error: "Unknown message." };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("reddit:")) return false;
    handle(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  });

  /* ---------------------------------------------------------------------------
     Startup: restore the last state. A "running" record with no live run means
     the tab was closed or reloaded mid-capture, so show it as paused.
     --------------------------------------------------------------------------- */

  (async () => {
    try {
      const got = await chrome.storage.local.get(S.STATE_KEY);
      if (got && got[S.STATE_KEY]) state = { ...emptyState(), ...got[S.STATE_KEY] };
      if (state.status === "running") {
        const markInterrupted = () => setState({
          status: "paused",
          error: "Capture was interrupted when the page was closed or reloaded. Start to resume.",
        });
        if (navigator.locks && navigator.locks.request) {
          // The lock is free only if no other Reddit engine is mid-run; then this record is stale.
          navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => (lock ? markInterrupted() : undefined));
        } else {
          await markInterrupted();
        }
      }
    } catch {
      /* storage unavailable: start from an empty state */
    }
  })();
})();
