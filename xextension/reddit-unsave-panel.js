/*
 * Reddit · Unsave panel.
 *
 * Mirrors the reddit-unsave.js engine the way popup.js mirrors the X unsave
 * engine: storage (redditUnsaveState) is the source of truth, the content
 * script in the saved-listing tab receives "reddit-unsave:*" commands, and the
 * panel never claims more than the engine's checkpoint says. The chrome (log,
 * snackbar, dialog, tab signals, downloads) comes from window.XPanel.
 */
(() => {
  "use strict";

  const S = globalThis.XRedditSaved;
  const P = window.XPanel || null;
  if (!S || typeof chrome === "undefined" || !chrome.storage) return;

  const $ = (selector) => document.querySelector(selector);
  const el = {
    queued: $("#ruQueued"),
    done: $("#ruDone"),
    failed: $("#ruFailed"),
    rate: $("#ruRate"),
    card: $("#rdUnsaveCard"),
    status: $("#rdUnsaveStatus"),
    startBtn: $("#ruStartBtn"),
    startLabel: $("#ruStartLabel"),
    pauseBtn: $("#ruPauseBtn"),
    stopBtn: $("#ruStopBtn"),
    backupBtn: $("#ruBackupBtn"),
    resetBtn: $("#ruResetBtn"),
    dot: $("#rdUnsaveDot"),
  };
  if (!el.startBtn || !el.status) return;

  const STATE_KEY = "redditUnsaveState";
  const SESSION_KEY = "redditUnsaveSession";
  const BACKUP_KEY = "redditUnsaveBackup";
  const POST_PREFIX = "redditUnsavePost.";
  const BACKUP_FILE = "reddit-unsave-backup.json";

  const STATUS = {
    idle: "Idle — no NSFW saved posts removed.",
    running: "Unsaving NSFW saved posts…",
    paused: "Paused — progress is saved.",
    completed: "Complete — two clean sweeps of your saved list found no NSFW posts.",
    stopped_by_user: "Stopped — Start resumes your saved queue.",
    stopped_by_error: "Stopped — progress is saved.",
  };

  /* Every engine reason gets a sentence a person can act on. */
  const REASONS = {
    "already-running": "The Reddit unsave engine is already active.",
    "open-saved": "Open old.reddit.com/user/<you>/saved (your own saved list), then start.",
    "engine-busy": "Another Reddit engine (capture or unsave) is active. Stop it first.",
    "running-elsewhere": "Another tab owns the active run. Pause or stop it from that tab.",
    "stop-first": "Stop the unsave run before resetting its data.",
    "account-changed": "This checkpoint belongs to another Reddit account. Switch back to resume, or export the backup and reset first.",
    "session-expired": "This checkpoint is over 7 days old. Export the backup and reset before a new run.",
    "auth-unavailable": "Reddit did not report a logged-in session. Log in on old.reddit.com, reload the saved page, then retry.",
    "auth-error": "Reddit rejected the session. Log in again on old.reddit.com, reload the saved page, then resume.",
    "account-mismatch": "You are logged in as a different account than this saved list belongs to. Open your own saved page.",
    "nsfw-hidden": "Reddit is hiding NSFW posts. Turn on \"I am over eighteen years old and willing to view adult content\" in Reddit preferences, then resume.",
    "rate-limited": "Rate limited by Reddit. Wait a few minutes before retrying.",
    "max-backoff-retries": "Rate limits persisted past the retry budget. Wait a few minutes and resume.",
    "too-many-errors": "Too many consecutive failures; the engine stopped to protect the account.",
    "unconfirmed": "Reddit did not confirm the removal. The post stays queued; check the saved page, then resume.",
    "endpoint-unavailable": "Reddit's unsave endpoint answered 404. old.reddit may have changed; nothing else will be removed until it can be confirmed.",
    "schema-mismatch": "Reddit returned a page that is not a saved listing. Reload old.reddit.com, check you are logged in, then resume.",
    "listing-unavailable": "Your saved listing could not be loaded (404). Reload the page and resume.",
    "verification-needed": "Reddit keeps listing a post after confirming its removal. Wait, reload the saved page, then resume. Completion was not claimed.",
    "verifying-list": "Checking the live saved list…",
    "backup-missing": "A target's backup is missing. No removal was attempted; export existing data and investigate storage.",
    "invalid-target": "A queued entry is not a Reddit post id. It was skipped and no request was sent.",
    "storage-error": "Could not save a backup or checkpoint. Free storage or reload, then resume. Captured data is untouched.",
    "request-timeout": "A request timed out. Reload the saved page and resume; the last outcome may be uncertain.",
    "request-busy": "A request is still in flight. Wait for it to finish, then resume.",
    "network-error": "The network dropped mid-request. Check the connection, then resume.",
    "server-error": "Reddit returned a server error. Wait a moment, then resume.",
    "run-cap": "Checkpoint reached (1,500 attempts or 3 hours). Take a break, then resume.",
    "verified-clean": "Two clean sweeps found no NSFW posts left in your saved list. Reload Reddit to update its display.",
    "run-error": "An unexpected error stopped the run. Saved progress is intact; retry.",
  };

  let state = null;
  let backupCount = 0;
  let tabInfo = { id: null, account: "", reachable: false, loggedIn: false, live: false };
  let pending = false; // a command is in flight

  const fmt = (value) => Number(value || 0).toLocaleString();
  const log = (message, level) => { if (P) P.log(message, level); };
  const toast = (message, options) => { if (P) P.snackbar.show(message, options); };
  const setStat = (slot, value) => {
    if (!slot) return;
    if (P) P.setStat(slot, value);
    else slot.textContent = fmt(value);
  };
  const explain = (reason) => REASONS[reason] || reason || "unknown";

  async function readStored() {
    try {
      const got = await chrome.storage.local.get({ [STATE_KEY]: null, [BACKUP_KEY]: null });
      state = got[STATE_KEY] || null;
      backupCount = got[BACKUP_KEY] && Array.isArray(got[BACKUP_KEY].ids) ? got[BACKUP_KEY].ids.length : 0;
    } catch {
      state = null;
      backupCount = 0;
    }
  }

  async function probeTab() {
    tabInfo = { id: null, account: "", reachable: false, loggedIn: false, live: false };
    let tab = null;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      tab = null;
    }
    const account = tab ? S.savedListingAccount(tab.url) : "";
    if (!account) return;
    tabInfo.id = tab.id;
    tabInfo.account = account;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "reddit-unsave:get-state" });
      if (res && res.ok) {
        tabInfo.reachable = true;
        tabInfo.loggedIn = !!res.loggedIn;
        tabInfo.live = !!res.live;
        if (res.state) state = res.state;
      }
    } catch {
      tabInfo.reachable = false; // page loaded before the extension: a reload enables it
    }
  }

  async function send(type) {
    if (!tabInfo.reachable || tabInfo.id == null) {
      toast("Open old.reddit.com/user/<you>/saved in the active tab first (reload it once after installing).", { error: true });
      log("No reachable Reddit saved-list tab for the unsave engine.", "warn");
      return null;
    }
    try {
      return await chrome.tabs.sendMessage(tabInfo.id, { type });
    } catch {
      toast("Can't reach the Reddit tab. Reload it and try again.", { error: true });
      log("Reddit content script unreachable — reload the tab.", "error");
      return null;
    }
  }

  /* ---------------------------------------------------------------------------
     Rendering — same rules as the X unsave mirror
     --------------------------------------------------------------------------- */

  function render() {
    const s = state || {};
    const status = STATUS[s.status] ? s.status : "idle";
    const st = s.stats || {};
    const running = status === "running";
    const paused = status === "paused";
    const resumable = paused || status === "stopped_by_user" || status === "stopped_by_error";
    const reason = s.lastStopReason || "";
    const backingOff = running && reason.startsWith("backoff-");
    const waveBreak = running && reason.startsWith("wave-break");

    let text = STATUS[status];
    if (backingOff) {
      const match = reason.match(/^backoff-([a-z-]+) \((\d+)s\)/);
      text = match
        ? (match[1] === "rate-limited" ? "Rate limited by Reddit" : "Backing off after " + match[1].replace(/-/g, " ")) + " — retrying in " + match[2] + "s"
        : reason;
    } else if (running && reason === "verifying-list") {
      text = REASONS["verifying-list"];
    } else if (running) {
      const parts = [];
      if (waveBreak) parts.push("reading pause");
      if (st.pending) parts.push(fmt(st.pending) + " queued");
      if (st.unsaved) parts.push(fmt(st.unsaved) + " done");
      if (st.perMin) parts.push(fmt(st.perMin) + "/min");
      if (st.rateLimits) parts.push(fmt(st.rateLimits) + " limit wait(s)");
      if (st.sweeps) parts.push(fmt(st.sweeps) + (st.sweeps === 1 ? " sweep" : " sweeps"));
      text = parts.join(" · ") || "Unsaving — warming up…";
    } else if (reason && REASONS[reason]) {
      text = REASONS[reason];
    } else if (reason && status !== "idle") {
      text = "Stopped: " + reason;
    } else if (status === "idle" && !tabInfo.account) {
      text = "Open old.reddit.com/user/<you>/saved in this tab to start.";
    } else if (status === "idle" && !tabInfo.reachable) {
      text = "Reload this saved page to enable the unsave engine.";
    } else if (status === "idle" && !tabInfo.loggedIn) {
      text = "Log in to old.reddit.com, then reload this page.";
    }
    if (s.updatedAt && status !== "idle" && !running) {
      text += " · " + new Date(s.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    const tone = backingOff ? "rate-limited" : status;
    el.status.textContent = text;
    el.status.dataset.status = tone;
    if (el.card) el.card.dataset.status = status === "idle" && tabInfo.account && !tabInfo.reachable ? "rate-limited" : tone;
    if (P) P.setTabSignal(el.dot, running ? "running" : paused ? "paused" : "");

    setStat(el.queued, st.pending || 0);
    setStat(el.done, st.unsaved || 0);
    setStat(el.failed, st.failed || 0);
    setStat(el.rate, st.perMin || 0);

    el.startBtn.disabled = pending || running;
    el.startBtn.setAttribute("aria-busy", String(pending || running));
    el.startLabel.textContent = running ? "Unsaving…" : resumable ? "Resume unsaving" : "Unsave NSFW saved posts";
    el.pauseBtn.disabled = pending || !running;
    el.stopBtn.disabled = pending || !running;
    el.backupBtn.disabled = backupCount <= 0;
    el.backupBtn.title = backupCount
      ? "Download " + fmt(backupCount) + (backupCount === 1 ? " backed-up post" : " backed-up posts") + " with the confirmed outcome of each removal"
      : "The backup fills as posts are queued";
    el.resetBtn.disabled = pending || running;
  }

  async function refresh() {
    await Promise.all([readStored(), probeTab()]);
    render();
  }

  /* ---------------------------------------------------------------------------
     Commands
     --------------------------------------------------------------------------- */

  async function command(type, onOk) {
    pending = true;
    render();
    try {
      const res = await send(type);
      if (!res) return;
      if (res.ok) onOk(res);
      else {
        const detail = res.reason === "account-mismatch" && res.signedInAs
          ? "You are logged in as u/" + res.signedInAs + ", not the owner of this saved list. Open your own saved page."
          : explain(res.reason);
        toast(detail, { error: true });
        log("Reddit unsave " + type.replace("reddit-unsave:", "") + ": " + (res.reason || "unknown"), "warn");
      }
    } finally {
      pending = false;
      await refresh();
    }
  }

  el.startBtn.addEventListener("click", () => {
    const start = () => command("reddit-unsave:start", (res) => {
      log(res.resumed ? "Reddit unsave resumed." : "Reddit unsave started — backup before each removal.");
    });
    if (!P) { start(); return; }
    P.confirmDialog({
      title: "Unsave every NSFW post from your Reddit saved list?",
      body: "This removes over-18 posts from the saved list of the logged-in Reddit account, on every device. SFW posts and saved comments are left alone. It does not delete the posts or your captured Reddit library. Every target is backed up before removal, but there is no automatic undo. Keep the saved-list tab open. The run uses paced requests and may pause for rate limits or a safety checkpoint.",
      confirmLabel: "Unsave NSFW posts",
      destructive: true,
      onConfirm: start,
    });
  });

  el.pauseBtn.addEventListener("click", () => command("reddit-unsave:pause", () => log("Reddit unsave paused — progress saved.")));
  el.stopBtn.addEventListener("click", () => command("reddit-unsave:stop", () => log("Reddit unsave stopped — progress saved.")));

  async function resetData() {
    pending = true;
    render();
    try {
      const canAsk = tabInfo.reachable && tabInfo.id != null;
      let res = null;
      if (canAsk) {
        try { res = await chrome.tabs.sendMessage(tabInfo.id, { type: "reddit-unsave:reset" }); } catch { res = null; }
      }
      if (res && res.ok === false) {
        toast(explain(res.reason), { error: true });
        log("Reddit unsave reset refused: " + res.reason, "error");
        return;
      }
      if (!res) {
        // No reachable tab: a live run cannot exist in a tab we cannot reach
        // only if that tab is gone; refuse while the checkpoint says running.
        if (state && state.status === "running") {
          toast(REASONS["stop-first"], { error: true });
          return;
        }
        const got = await chrome.storage.local.get({ [BACKUP_KEY]: null });
        const meta = got[BACKUP_KEY];
        const keys = [STATE_KEY, SESSION_KEY, BACKUP_KEY];
        if (meta && Array.isArray(meta.ids)) for (const id of meta.ids) keys.push(POST_PREFIX + meta.account + "." + id);
        await chrome.storage.local.remove(keys);
      }
      state = null;
      backupCount = 0;
      toast("Reddit unsave data reset.");
      log("Reddit unsave data reset.", "warn");
    } finally {
      pending = false;
      await refresh();
    }
  }

  el.resetBtn.addEventListener("click", () => {
    if (!P) { resetData(); return; }
    P.confirmDialog({
      title: "Reset Reddit unsave data?",
      body: "Deletes this engine's queue, counters and backup. It does not restore unsaved posts, clear the captured Reddit library, or touch X data. Download the backup first if you need it. Stop any active run before resetting.",
      confirmLabel: "Reset unsave data",
      destructive: true,
      onConfirm: resetData,
    });
  });

  /* ---------------------------------------------------------------------------
     Backup export — the undo record, shaped like a normal Reddit export so the
     app's importer accepts it (source + posts[].fullname), plus the outcome of
     every removal.
     --------------------------------------------------------------------------- */

  el.backupBtn.addEventListener("click", async () => {
    try {
      const { [BACKUP_KEY]: meta } = await chrome.storage.local.get(BACKUP_KEY);
      if (!meta || !Array.isArray(meta.ids) || !meta.ids.length) { toast("No Reddit unsave backup yet."); return; }
      const keys = meta.ids.map((id) => POST_PREFIX + meta.account + "." + id);
      const records = await chrome.storage.local.get(keys);
      const entries = keys.map((key) => records[key]);
      if (entries.some((entry) => !entry)) throw new Error("Backup records are missing; refusing a partial export.");
      const outcomes = { unsaved: 0, pending: 0 };
      for (const entry of entries) outcomes[entry.outcome === "unsaved" ? "unsaved" : "pending"]++;
      const payload = S.buildExport({ posts: entries, account: meta.account });
      payload.backup = {
        engine: "reddit-unsave",
        exported_at: payload.exported_at,
        unsaved: outcomes.unsaved,
        pending: outcomes.pending,
        note: "Posts carry discovered_at, unsaved_at and outcome. Media is stored as links; captured video file URLs live in the Capture export.",
      };
      const text = JSON.stringify(payload, null, 2);
      if (P) await P.download(BACKUP_FILE, text);
      else {
        const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        try { await chrome.downloads.download({ url, filename: BACKUP_FILE, saveAs: true }); }
        finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
      }
      toast("Backup exported (" + fmt(entries.length) + (entries.length === 1 ? " post" : " posts") + ").");
      log("Downloaded " + BACKUP_FILE + ".");
    } catch (error) {
      toast(error.message || "Could not export the Reddit unsave backup.", { error: true });
      log("Reddit unsave backup export failed: " + String(error && error.message || error), "error");
    }
  });

  /* ---------------------------------------------------------------------------
     Live updates
     --------------------------------------------------------------------------- */

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "reddit-unsave-state") { state = msg.state; render(); }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[STATE_KEY]) { state = changes[STATE_KEY].newValue || null; render(); }
      if (changes[BACKUP_KEY]) {
        const ids = changes[BACKUP_KEY].newValue && changes[BACKUP_KEY].newValue.ids;
        backupCount = Array.isArray(ids) ? ids.length : 0;
        render();
      }
    });
  } catch {
    /* not running as an extension */
  }

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
