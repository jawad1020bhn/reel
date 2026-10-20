/*
 * Reddit · Capture and Export panels.
 *
 * Storage is the source of truth: the content script writes progress to
 * redditCaptureState and the captured posts to redditSavedMeta/Chunk keys.
 * Controls send "reddit:*" messages to the saved-listing tab when one is
 * reachable. Reset also works without a tab, by clearing storage directly.
 *
 * The panel chrome (log, snackbar, dialog, tab signals, downloads) is shared
 * through window.XPanel, published by popup.js.
 */
(() => {
  "use strict";

  const S = globalThis.XRedditSaved;
  const RV = globalThis.XRedditVideo;
  const P = window.XPanel || null;
  if (!S || typeof chrome === "undefined" || !chrome.storage) return;

  const $ = (selector) => document.querySelector(selector);
  const el = {
    saved: $("#rdSaved"),
    pages: $("#rdPages"),
    videos: $("#rdVideos"),
    skipped: $("#rdSkipped"),
    card: $("#rdCard"),
    statusLabel: $("#rdStatusLabel"),
    status: $("#rdStatus"),
    progressHost: $("#rdProgressHost"),
    controls: $("#rdControls"),
    startBtn: $("#rdStartBtn"),
    startLabel: $("#rdStartLabel"),
    pauseBtn: $("#rdPauseBtn"),
    stopBtn: $("#rdStopBtn"),
    resetBtn: $("#rdResetBtn"),
    account: $("#rdAccount"),
    dot: $("#rdCaptureDot"),
    hint: $("#rdHint"),
    exportHint: $("#rdExportHint"),
    exportBtn: $("#rdExport"),
    mediaBtn: $("#rdMediaBtn"),
    mediaLabel: $("#rdMediaLabel"),
  };
  if (!el.startBtn || !el.exportBtn) return;

  /* The capture status card speaks the same vocabulary as the X one: a
     coloured container, a dot shape, and a word — never colour alone. */
  const STATUS = {
    idle:    { tone: "idle",             label: "Idle" },
    running: { tone: "running",          label: "Capturing" },
    paused:  { tone: "paused",           label: "Paused" },
    stopped: { tone: "stopped_by_user",  label: "Stopped" },
    done:    { tone: "completed",        label: "Completed" },
    error:   { tone: "stopped_by_error", label: "Stopped" },
  };

  let stored = { state: null, meta: null };
  let tabInfo = { id: null, onSavedPage: false, reachable: false, loggedIn: false };
  let notice = null;          // transient feedback, cleared on the next render
  let busy = false;
  let videos = { ready: 0, enriched: 0 }; // stored videos with captured (playable) file URLs
  let media = { status: "idle" };         // the background's download progress

  const fmt = (value) => Number(value || 0).toLocaleString();
  const plural = (n, one, many) => fmt(n) + " " + (Number(n) === 1 ? one : many);
  const log = (message, level) => { if (P) P.log(message, level); };
  const toast = (message, options) => { if (P) P.snackbar.show(message, options); };
  const setStat = (slot, value) => {
    if (!slot) return;
    if (P) P.setStat(slot, value);
    else slot.textContent = fmt(value);
  };

  async function readStored() {
    const got = await chrome.storage.local.get([S.STATE_KEY, S.META_KEY]);
    stored = { state: got[S.STATE_KEY] || null, meta: got[S.META_KEY] || null };
  }

  /** Cached per-render: how many stored videos carry verified file URLs, and
      the background's download progress. readAll() only runs when meta changed. */
  let readMetaCount = -1;
  async function readVideoStats() {
    const count = stored.meta ? stored.meta.count || 0 : 0;
    if (count !== readMetaCount || count === 0) {
      readMetaCount = count;
      videos = { ready: 0, enriched: 0 };
      if (RV && count) {
        try {
          const posts = await S.createStore(chrome.storage.local).readAll();
          for (const post of posts) {
            const entry = (post.media || []).find((m) => m && m.kind === "video");
            if (!entry) continue;
            videos.enriched++;
            if (RV.planDownloads(post).video) videos.ready++;
          }
        } catch { /* storage hiccup: the button just stays disabled */ }
      }
    }
    const got = await chrome.storage.local.get({ redditMediaDownloads: { status: "idle" } });
    media = got.redditMediaDownloads || { status: "idle" };
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
    if (notice) return { tone: "stopped_by_error", text: notice };
    if (status === "running") return { tone: "running", text: "Page " + fmt(pages) + " · " + plural(saved, "NSFW post", "NSFW posts") + " so far" + (state.videos ? " · " + plural(state.videos, "video", "videos") : "") };
    if (status === "paused") return { tone: "paused", text: (state.error ? state.error + " " : "") + "Paused on page " + fmt(pages) + ". Resume picks up where it stopped." };
    if (status === "stopped") return { tone: "stopped_by_user", text: "Stopped after page " + fmt(pages) + ". Resume picks up from there." };
    if (status === "done") return { tone: "completed", text: "Reached the end of your saved list — " + plural(saved, "NSFW post", "NSFW posts") + " captured." };
    if (status === "error") return { tone: "stopped_by_error", text: (state && state.error) || "Capture stopped with an error." };
    if (!tabInfo.onSavedPage) return { tone: "idle", text: "Open old.reddit.com/user/<you>/saved in this tab to capture." };
    if (!tabInfo.reachable) return { tone: "rate-limited", text: "Reload this saved page to enable capture." };
    if (!tabInfo.loggedIn) return { tone: "rate-limited", text: "Log in to old.reddit.com, then reload this page." };
    return { tone: "idle", text: "Ready. Start captures this page and every page after it." };
  }

  function render() {
    const state = stored.state;
    const meta = stored.meta;
    const status = state ? state.status : "idle";
    const running = status === "running";
    const paused = status === "paused";
    const resumable = !!(state && state.nextUrl && (paused || status === "stopped" || status === "error"));
    const saved = meta ? meta.count || 0 : 0;

    setStat(el.saved, saved);
    setStat(el.pages, state ? state.pages : 0);
    setStat(el.videos, state ? state.videos || videos.enriched : videos.enriched);
    setStat(el.skipped, state ? state.sfwSkipped : 0);

    const view = describe(state, meta);
    const label = (STATUS[status] || STATUS.idle).label;
    el.card.dataset.status = view.tone;
    if (el.statusLabel) el.statusLabel.textContent = notice ? "Attention" : label;
    el.status.textContent = view.text;
    if (el.progressHost) el.progressHost.hidden = !running;
    if (P) P.setTabSignal(el.dot, running ? "running" : paused ? "paused" : "");

    /* One primary action; it leaves the layout while a run is live, like X capture. */
    el.startLabel.textContent = resumable ? "Resume capture" : status === "done" ? "Capture again" : "Start capture";
    el.startBtn.disabled = busy || !tabInfo.reachable || running;
    el.startBtn.hidden = running;
    if (el.controls) el.controls.dataset.running = String(running);
    el.startBtn.title = tabInfo.reachable ? "" : "Open your old.reddit.com saved page in this tab (reload it once after installing).";
    el.pauseBtn.disabled = busy || !tabInfo.reachable || !running;
    el.stopBtn.disabled = busy || !tabInfo.reachable || !running;
    el.resetBtn.disabled = busy || running || (saved === 0 && !state);

    if (el.account) {
      const owner = (meta && meta.account) || (state && state.account);
      el.account.textContent = owner
        ? "u/" + owner + (state && state.updatedAt ? " · " + new Date(state.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "")
        : "No account captured yet.";
    }

    el.hint.textContent = saved
      ? plural(saved, "NSFW post", "NSFW posts") + " ready to export" + (meta && meta.account ? " from u/" + meta.account : "") + "." +
        (videos.enriched ? " " + plural(videos.enriched, "video", "videos") + " with playable URLs." : " Media is stored as links.")
      : "Only over-18 posts are kept. Media is stored as links, not files.";

    /* Export panel */
    el.exportBtn.disabled = busy || saved === 0;
    if (el.exportHint) {
      el.exportHint.textContent = saved
        ? plural(saved, "NSFW saved post", "NSFW saved posts") + (meta && meta.account ? " from u/" + meta.account : "") +
          (videos.enriched ? " · " + plural(videos.enriched, "video", "videos") : "") + " ready to export."
        : "Nothing captured yet.";
    }
    if (el.mediaBtn) {
      const downloading = media.status === "running";
      el.mediaLabel.textContent = downloading
        ? `Downloading ${fmt(media.done || 0)} / ${fmt(media.total || 0)}…`
        : media.status === "done" && (media.done || 0) > 0
          ? `Downloaded ${fmt(media.done)} file${media.done === 1 ? "" : "s"} — again`
          : `Download videos (${fmt(videos.ready)})`;
      el.mediaBtn.disabled = busy || downloading || saved === 0 || !videos.ready;
      el.mediaBtn.title = videos.ready
        ? "Saves the video + audio files into Downloads/xreels-media/. Copy that folder next to the app's index.html and set it as the Local media folder in Settings, then Reddit videos play with sound offline."
        : "No stored videos with captured file URLs yet — run a capture first (enrichment happens during capture).";
    }

    if (P) P.setSiteMeta("reddit", { count: saved, noun: "NSFW post", empty: "Saved · NSFW" });
  }

  async function refresh() {
    await Promise.all([readStored(), probeTab()]);
    await readVideoStats();
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
    if (!res || !res.ok) {
      notice = (res && res.error) || "Can't reach the Reddit tab. Reload it and try again.";
      log("Reddit capture could not start: " + notice, "error");
      toast(notice, { error: true });
    } else {
      log(res.state && res.state.nextUrl ? "Reddit capture resumed." : "Reddit capture started.");
    }
  }));

  el.pauseBtn.addEventListener("click", () => withBusy(async () => {
    notice = null;
    await send("reddit:pause");
    log("Reddit capture pausing after the current page.");
  }));

  el.stopBtn.addEventListener("click", () => withBusy(async () => {
    notice = null;
    await send("reddit:stop");
    log("Reddit capture stopping — the position is kept.");
  }));

  async function resetCapture() {
    notice = null;
    const res = await send("reddit:reset");
    if (!res) {
      // No reachable tab: clear storage directly. Refused while a run is live.
      const live = stored.state && stored.state.status === "running";
      if (live) { notice = "Pause or stop before resetting."; return; }
      await S.createStore(chrome.storage.local).clear().then(() => chrome.storage.local.remove(S.STATE_KEY));
    } else if (!res.ok) {
      notice = res.error || "Reset failed.";
      return;
    }
    readMetaCount = -1;
    toast("Reddit capture cleared.");
    log("Cleared the captured Reddit library.", "warn");
  }

  let resetArmed = false;
  let resetTimer = null;
  el.resetBtn.addEventListener("click", () => {
    if (P) {
      P.confirmDialog({
        title: "Clear the captured Reddit library?",
        body: "Deletes every captured NSFW saved post and the capture position from the extension's storage. Files you already exported, your Reddit account, and the Unsave engine's backup are untouched. This cannot be undone.",
        confirmLabel: "Clear Reddit library",
        destructive: true,
        onConfirm: () => withBusy(resetCapture),
      });
      return;
    }
    // Without the shared dialog: a two-step confirm, armed for a few seconds.
    if (!resetArmed) {
      resetArmed = true;
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => { resetArmed = false; el.resetBtn.textContent = "Reset capture"; }, 4000);
      el.resetBtn.textContent = "Confirm reset";
      return;
    }
    resetArmed = false;
    clearTimeout(resetTimer);
    el.resetBtn.textContent = "Reset capture";
    withBusy(resetCapture);
  });

  el.exportBtn.addEventListener("click", () => withBusy(async () => {
    notice = null;
    const store = S.createStore(chrome.storage.local);
    const posts = await store.readAll();
    if (!posts.length) {
      toast("Nothing to export yet.");
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
    const text = JSON.stringify(payload, null, 2);
    if (P) await P.download(S.FILE_NAME, text);
    else {
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      try {
        await chrome.downloads.download({ url, filename: S.FILE_NAME, saveAs: true });
      } catch {
        const a = document.createElement("a");
        a.href = url;
        a.download = S.FILE_NAME;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    toast("Exported " + S.FILE_NAME);
    log("Downloaded " + S.FILE_NAME + " (" + plural(posts.length, "post", "posts") + ").");
  }));

  el.mediaBtn && el.mediaBtn.addEventListener("click", () => withBusy(async () => {
    notice = null;
    if (!RV) { toast("Video support is unavailable in this build.", { error: true }); return; }
    const posts = await S.createStore(chrome.storage.local).readAll();
    const items = [];
    const seen = new Set();
    for (const post of posts) {
      const plan = RV.planDownloads(post);
      for (const file of [plan.video, plan.audio]) {
        if (!file || seen.has(file.filename)) continue;
        seen.add(file.filename);
        items.push(file);
      }
    }
    if (!items.length) { toast("No downloadable video files in the captured posts. Run a fresh capture first.", { error: true }); return; }
    log("Downloading " + plural(items.length, "media file", "media files") + " into Downloads/xreels-media/…");
    try {
      const res = await chrome.runtime.sendMessage({ type: "reddit:downloadMedia", items });
      if (!res || (!res.ok && !res.downloaded)) toast((res && res.error) || "The downloads were refused.", { error: true });
      else if (res.failed && res.failed.length) toast(res.downloaded + " downloaded, " + res.failed.length + " failed.", { error: true });
      else toast("Downloaded " + plural(res.downloaded || items.length, "file", "files") + ".");
    } catch {
      toast("Could not reach the background worker for downloads.", { error: true });
    }
    await readVideoStats();
  }));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.redditMediaDownloads) {
      media = { ...media, ...changes.redditMediaDownloads.newValue };
      render();
      return;
    }
    if (!changes[S.STATE_KEY] && !changes[S.META_KEY]) return;
    readStored().then(() => readVideoStats()).then(render);
  });

  /* The side panel persists across tabs: re-check whether the active tab is a
     saved listing. popup.js already follows the active tab; reuse its signal. */
  if (P) P.onContext(() => { refresh(); });
  else {
    if (chrome.tabs.onActivated) chrome.tabs.onActivated.addListener(() => { refresh(); });
    if (chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener((_tabId, info) => {
        if (info.url || info.status === "complete") refresh();
      });
    }
  }

  refresh();
})();
