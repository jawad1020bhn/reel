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
  if (!S || typeof chrome === "undefined" || !chrome.runtime) return;

  const account = S.savedListingAccount(location.href);
  if (!account) return; // not the saved listing: nothing to do on this page

  const LOCK_NAME = "xreels-reddit-saved-capture";
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
    return !!(document.body && document.body.classList.contains("loggedin"));
  }

  /* ---------------------------------------------------------------------------
     DOM reading
     --------------------------------------------------------------------------- */

  function absoluteRedditUrl(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    if (text.startsWith("//")) return "https:" + text;
    if (text.startsWith("/")) return "https://www.reddit.com" + text;
    return text;
  }

  /** Read one `.thing` row into the plain object reddit-saved.js expects. */
  function readRow(el) {
    const attr = (name) => el.getAttribute(name) || "";
    const titleEl = el.querySelector("a.title");
    const thumbEl = el.querySelector(".thumbnail img");
    const timeEl = el.querySelector("time[datetime]");
    let timestamp = Number(attr("data-timestamp")) || 0;
    if (!timestamp && timeEl) timestamp = Date.parse(timeEl.getAttribute("datetime")) || 0;
    return {
      fullname: attr("data-fullname"),
      className: el.className,
      nsfw: attr("data-nsfw"),
      title: titleEl ? titleEl.textContent : "",
      subreddit: attr("data-subreddit"),
      author: attr("data-author"),
      permalink: attr("data-permalink"),
      url: absoluteRedditUrl(attr("data-url")),
      domain: attr("data-domain"),
      score: attr("data-score"),
      comments: attr("data-comments-count"),
      timestamp,
      thumbnail: thumbEl ? absoluteRedditUrl(thumbEl.getAttribute("src")) : "",
      isGallery: attr("data-is-gallery"),
    };
  }

  function readRows(doc) {
    return Array.from(doc.querySelectorAll(".thing")).map(readRow);
  }

  function nextHref(doc) {
    const link = doc.querySelector('a[rel~="next"]');
    return link ? link.getAttribute("href") : null;
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
        return { doc: new DOMParser().parseFromString(html, "text/html") };
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
        };
      } else {
        if (!looksLoggedIn() && !document.querySelector(".thing")) {
          await setState({ status: "error", error: "Log in to old.reddit.com, then reload this saved page." });
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
        await store.append(batch.posts, { account });
        counters = {
          pages: counters.pages + 1,
          rows: counters.rows + batch.counts.rows,
          nsfwKept: counters.nsfwKept + batch.counts.nsfwKept,
          sfwSkipped: counters.sfwSkipped + batch.counts.sfwSkipped,
          commentsSkipped: counters.commentsSkipped + batch.counts.commentsSkipped,
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

  /** Start or resume. A Web Lock keeps two open saved-listing tabs from running at once. */
  function startRun(mode) {
    if (running) return { ok: false, error: "Already capturing." };
    const launch = (lock) => {
      if (!lock) {
        setState({ status: "error", error: "Another tab is already capturing Reddit saved posts." });
        return;
      }
      return run(mode);
    };
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request(LOCK_NAME, { ifAvailable: true }, launch);
    } else {
      launch(true);
    }
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
        const started = startRun(state.nextUrl && state.account === account ? "resume" : "fresh");
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
          // The lock is free only if no other tab is mid-run; then this record is stale.
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
