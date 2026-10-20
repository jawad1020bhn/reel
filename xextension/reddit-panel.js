/*
 * Reddit saved (NSFW) section of the popup's Export tab.
 *
 * Storage is the source of truth: the content script writes progress to
 * redditCaptureState and the captured posts to redditSavedMeta/Chunk keys.
 * Controls send "reddit:*" messages to the saved-listing tab when one is
 * reachable. Reset also works without a tab, by clearing storage directly.
 */
(() => {
  "use strict";

  const S = globalThis.XRedditSaved;
  if (!S || typeof chrome === "undefined" || !chrome.storage) return;

  const $ = (selector) => document.querySelector(selector);
  const el = {
    saved: $("#rdSaved"),
    pages: $("#rdPages"),
    rows: $("#rdRows"),
    skipped: $("#rdSkipped"),
    card: $("#rdCard"),
    status: $("#rdStatus"),
    startBtn: $("#rdStartBtn"),
    startLabel: $("#rdStartLabel"),
    pauseBtn: $("#rdPauseBtn"),
    stopBtn: $("#rdStopBtn"),
    resetBtn: $("#rdResetBtn"),
    exportBtn: $("#rdExport"),
    hint: $("#rdHint"),
  };
  if (!el.startBtn || !el.exportBtn) return;

  const STATUS_TONE = {
    idle: "idle",
    running: "running",
    paused: "paused",
    stopped: "paused",
    done: "completed",
    error: "stopped_by_error",
  };

  let stored = { state: null, meta: null };
  let tabInfo = { id: null, onSavedPage: false, reachable: false, loggedIn: false };
  let notice = null;          // transient feedback, cleared on the next render
  let resetArmed = false;
  let resetTimer = null;
  let busy = false;

  const fmt = (value) => Number(value || 0).toLocaleString();

  async function readStored() {
    const got = await chrome.storage.local.get([S.STATE_KEY, S.META_KEY]);
    stored = { state: got[S.STATE_KEY] || null, meta: got[S.META_KEY] || null };
  }

  async function probeTab() {
    tabInfo = { id: null, onSavedPage: false, reachable: false, loggedIn: false };
    let tab = null;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      tab = null;
    }
    if (!tab || !S.savedListingAccount(tab.url)) return;
    tabInfo.id = tab.id;
    tabInfo.onSavedPage = true;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "reddit:getState" });
      if (res && res.ok) {
        tabInfo.reachable = true;
        tabInfo.loggedIn = !!res.loggedIn;
      }
    } catch {
      tabInfo.reachable = false; // page loaded before the extension: a reload enables it
    }
  }

  async function send(type) {
    if (!tabInfo.reachable || tabInfo.id == null) return null;
    try {
      return await chrome.tabs.sendMessage(tabInfo.id, { type });
    } catch {
      return null;
    }
  }

  function describe(state, meta) {
    const status = state ? state.status : "idle";
    const pages = state ? state.pages || 0 : 0;
    const saved = meta ? meta.count || 0 : 0;
    if (notice) return { tone: "error", text: notice };
    if (status === "running") return { tone: "running", text: "Capturing page " + fmt(pages) + " · " + fmt(saved) + " NSFW saved so far." };
    if (status === "paused") return { tone: "paused", text: "Paused on page " + fmt(pages) + ". Resume picks up where it stopped." };
    if (status === "stopped") return { tone: "paused", text: "Stopped after page " + fmt(pages) + ". Resume picks up from there." };
    if (status === "done") return { tone: "completed", text: "Finished. Reached the end of your saved list." };
    if (status === "error") return { tone: "error", text: (state && state.error) || "Capture stopped with an error." };
    if (!tabInfo.onSavedPage) return { tone: "idle", text: "Open old.reddit.com/user/<you>/saved in this tab to capture." };
    if (!tabInfo.reachable) return { tone: "warn", text: "Reload this saved page to enable capture." };
    if (!tabInfo.loggedIn) return { tone: "warn", text: "Log in to old.reddit.com, then reload this page." };
    return { tone: "idle", text: "Ready. Start captures this page and every page after it." };
  }

  function render() {
    const state = stored.state;
    const meta = stored.meta;
    const status = state ? state.status : "idle";
    const running = status === "running";
    const resumable = !!(state && state.nextUrl && (status === "paused" || status === "stopped" || status === "error"));
    const saved = meta ? meta.count || 0 : 0;

    el.saved.textContent = fmt(saved);
    el.pages.textContent = fmt(state ? state.pages : 0);
    el.rows.textContent = fmt(state ? state.rows : 0);
    el.skipped.textContent = fmt(state ? state.sfwSkipped : 0);

    const view = describe(state, meta);
    el.card.dataset.status = running ? "running" : STATUS_TONE[status] || "idle";
    if (view.tone === "warn") el.card.dataset.status = "rate-limited";
    el.status.textContent = view.text;
    el.status.dataset.tone = view.tone;

    el.startLabel.textContent = resumable ? "Resume capture" : status === "done" ? "Capture again" : "Start capture";
    el.startBtn.disabled = busy || !tabInfo.reachable || running;
    el.pauseBtn.disabled = busy || !tabInfo.reachable || !running;
    el.stopBtn.disabled = busy || !tabInfo.reachable || !running;
    el.resetBtn.disabled = busy || running || (saved === 0 && !state);
    el.resetBtn.querySelector("span").textContent = resetArmed ? "Confirm reset" : "Reset";
    el.exportBtn.disabled = busy || saved === 0;

    el.hint.textContent = saved
      ? fmt(saved) + (saved === 1 ? " NSFW post" : " NSFW posts") + " ready to export" +
        (meta && meta.account ? " from u/" + meta.account : "") + ". Media is stored as links."
      : "Only over-18 posts are kept. Media is stored as links, not files.";
  }

  async function refresh() {
    await Promise.all([readStored(), probeTab()]);
    render();
  }

  /* ---------------------------------------------------------------------------
     Actions
     --------------------------------------------------------------------------- */

  async function withBusy(fn) {
    busy = true;
    render();
    try {
      await fn();
    } finally {
      busy = false;
      await refresh();
    }
  }

  el.startBtn.addEventListener("click", () => withBusy(async () => {
    notice = null;
    const res = await send("reddit:start");
    if (!res || !res.ok) notice = (res && res.error) || "Can't reach the Reddit tab. Reload it and try again.";
  }));

  el.pauseBtn.addEventListener("click", () => withBusy(async () => {
    notice = null;
    await send("reddit:pause");
  }));

  el.stopBtn.addEventListener("click", () => withBusy(async () => {
    notice = null;
    await send("reddit:stop");
  }));

  el.resetBtn.addEventListener("click", () => {
    if (!resetArmed) {
      // Two-step confirm, no dialog: the first click arms it for a few seconds.
      resetArmed = true;
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => { resetArmed = false; render(); }, 4000);
      render();
      return;
    }
    resetArmed = false;
    clearTimeout(resetTimer);
    withBusy(async () => {
      notice = null;
      const res = await send("reddit:reset");
      if (!res) {
        // No reachable tab: clear storage directly. Refused while a run is live.
        const live = stored.state && stored.state.status === "running";
        if (live) notice = "Pause or stop before resetting.";
        else await S.createStore(chrome.storage.local).clear().then(() => chrome.storage.local.remove(S.STATE_KEY));
      } else if (!res.ok) {
        notice = res.error || "Reset failed.";
      }
    });
  });

  el.exportBtn.addEventListener("click", () => withBusy(async () => {
    notice = null;
    const store = S.createStore(chrome.storage.local);
    const posts = await store.readAll();
    if (!posts.length) {
      notice = "Nothing to export yet.";
      return;
    }
    const meta = stored.meta || {};
    const state = stored.state || {};
    const payload = S.buildExport({
      posts,
      account: meta.account,
      scan: {
        pages: state.pages,
        rows: state.rows,
        nsfwKept: state.nsfwKept,
        sfwSkipped: state.sfwSkipped,
        commentsSkipped: state.commentsSkipped,
      },
    });
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    try {
      await chrome.downloads.download({ url, filename: S.FILE_NAME, saveAs: true });
    } catch {
      // Some Chromium builds reject extension-created blobs in downloads.download: fall back to a link click.
      const a = document.createElement("a");
      a.href = url;
      a.download = S.FILE_NAME;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes[S.STATE_KEY] && !changes[S.META_KEY]) return;
    readStored().then(render);
  });

  /* The side panel persists across tabs: re-check whether the active tab is a saved listing. */
  if (chrome.tabs.onActivated) chrome.tabs.onActivated.addListener(() => { refresh(); });
  if (chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((_tabId, info) => {
      if (info.url || info.status === "complete") refresh();
    });
  }

  refresh();
})();
