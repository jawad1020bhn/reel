/* =============================================================================
   X Bookmarks Exporter · Side panel
   Material Design 3 Expressive

   Colour, tokens, and interactions come from dashboard/m3e/*. This file owns only
   popup behaviour: mirroring capture state into the UI, driving the transport
   controls, and exporting.

   The popup↔content-script protocol is unchanged:
      tabs.sendMessage {type: start|pause|stop|panic|reset|getState}
      runtime.onMessage {type:"state", state}
      storage.onChanged.xCaptureState
   ============================================================================= */
(() => {
  "use strict";

  // M3E is published by dashboard/m3e/interactions.js. If that script failed to
  // load, surface a clear message instead of throwing on destructure — the
  // classic "Cannot destructure property of undefined" that blanked the popup.
  const M3E = window.M3E;
  if (!M3E || typeof M3E.createSnackbar !== "function") {
    document.body.innerHTML =
      '<p style="font:14px/1.4 system-ui,sans-serif;padding:16px;margin:0">' +
      "Design system failed to load. Reload the extension from " +
      "<code>chrome://extensions</code>.</p>";
    return;
  }
  const { createSnackbar, createOverlay, bindRipple, escapeHtml, pulse } = M3E;

  /* ---------------------------------------------------------------------------
     1 · Constants
     --------------------------------------------------------------------------- */

  const STATUS = {
    idle:             { label: "Idle",          detail: "No capture run yet." },
    capturing:        { label: "Capturing",     detail: "Fast adaptive sweep · waiting on X only at page boundaries." },
    paused:           { label: "Paused",        detail: "Capture is saved. Resume to continue the full-feed sweep." },
    completed:        { label: "Completed",     detail: "Reached a quiet end of the bookmark feed." },
    incomplete:       { label: "Incomplete",    detail: "A safety limit stopped the sweep before the feed end." },
    stopped_by_user:  { label: "Stopped",       detail: "You stopped this run; saved posts are kept." },
    stopped_by_error: { label: "Stopped",       detail: "The run ended on an error." },
  };

  const REASONS = {
    "end-of-feed": "Reached the bottom after repeated quiet checks. Verify the capture below.",
    "max-runtime": "Hit the two-hour safety limit. Start again to continue scanning from the top.",
    "max-batches": "Hit the safety pass limit. Start again to continue scanning from the top.",
    "no-responses-seen": "No bookmark timeline responses were intercepted. Open x.com/i/bookmarks and reload the tab.",
    "schema-mismatch": "A bookmark timeline arrived, but no posts could be normalized — X may have changed its response shape.",
    "storage-error": "Could not save the next chunk. Free extension storage or reload, then resume; pending data was retained where possible.",
    "capture-error": "An unexpected error stopped the run. Already-saved chunks are safe; inspect the activity log and retry.",
    "too-many-errors": "Too many consecutive failures.",
    "rate-limited": "Rate limited by X. Wait a few minutes before retrying.",
    "auth-error": "Authentication problem — check that you are signed in on x.com.",
    "max-backoff-retries": "Max retries reached after rate limits. Try again later.",
    "panic-stop": "Capture aborted. Pending in-memory posts were discarded; saved chunks remain.",
  };

  /* Unfollow engine — its own status/reason vocabulary. The engine reports
     into `xUnfollowState`, mirrored live here. */
  const UF_STATUS = {
    idle:             "Idle — no unfollow run yet.",
    navigating:       "Opening your Following list…",
    running:          "Unfollowing — human pacing active.",
    paused:           "Paused — progress is saved. Resume to continue.",
    completed:        "Completed — X served a quiet, empty Following list.",
    stopped_by_user:  "Stopped — progress is saved; Start resumes the queue.",
    stopped_by_error: "Stopped on an error — see the activity log.",
  };

  const UF_REASONS = {
    "end-of-list": "Following list exhausted after repeated quiet checks.",
    "max-runtime": "Hit the 3-hour run budget. Start again to continue from the queue.",
    "run-cap": "Safety checkpoint after 2,500 attempts — a natural break, then resume.",
    "no-responses-seen": "No Following timeline responses were intercepted. Open your profile's Following page and reload the tab.",
    "auth-error": "X rejected the session. Sign in on x.com, then resume.",
    "auth-unavailable": "No session credentials observed yet — reload x.com, then retry.",
    "too-many-errors": "Too many consecutive failures; the engine stopped to protect the account.",
    "max-backoff-retries": "Rate limits persisted past the retry budget. Wait a few minutes and resume.",
    "running-elsewhere": "Another tab owns this unfollow session. Close it or wait a moment.",
    "capture-running": "Stop the bookmark capture first — only one engine runs at a time.",
    "stopped-by-user": "Stopped by you; progress is saved.",
    "navigation-timeout": "Navigation to the Following list timed out — open it manually and press Start.",
    "run-error": "An unexpected error stopped the run. Saved progress is intact; retry.",
  };

  const UF_START_REASONS = {
    "open-following": "Open your Following list (x.com/you/following) first — or stay on any x.com page and press Start to auto-open it.",
    "already-running": "The unfollow engine is already running.",
    "unfollow-running": "Stop the unfollow engine first — one engine at a time.",
    ...UF_REASONS,
  };

  const US_STATUS = {
    idle: "Idle — no bookmarks removed.", running: "Unsaving bookmarks…", paused: "Paused — progress is saved.",
    completed: "Complete — two live checks returned an empty bookmark feed.",
    stopped_by_user: "Stopped — Start resumes your saved queue.", stopped_by_error: "Stopped — progress is saved.",
  };
  const US_REASONS = {
    ...UF_REASONS,
    "open-bookmarks": "Open x.com/i/bookmarks (not a bookmark folder), then start.",
    "engine-busy": "Another capture, unfollow or unsave engine is active. Stop it first.",
    "running-elsewhere": "Another tab owns the active run. Pause or stop it from that tab.",
    "already-running": "The unsave engine is already active.",
    "stop-first": "Stop the unsave run before resetting its data.",
    "verified-empty": "Two live checks returned an empty bookmark feed. Reload X to update its display.",
    "account-unavailable": "Could not identify the signed-in account. Reload your bookmarks page and retry.",
    "account-changed": "Account changed. Switch back to resume, or export the backup and reset this engine first.",
    "session-expired": "This checkpoint is over 7 days old. Export the backup and reset before a new run.",
    "calibration-needed": "X's DeleteBookmark operation is unavailable. Remove one bookmark manually on X, then resume.",
    "timeline-unavailable": "Reload the bookmarks page so the engine can observe X's timeline request, then resume.",
    "verification-needed": "X is returning stale or unrecognized entries. Wait, reload bookmarks, then resume. Completion was not claimed.",
    "verifying-feed": "Checking the live bookmark feed…",
    "schema-mismatch": "X changed the bookmark response. Nothing else will be removed until it can be read safely.",
    "unconfirmed": "X did not confirm the removal. The target is saved; inspect X, then resume.",
    "bridge-timeout": "The page bridge timed out. Reload bookmarks before resuming; the last outcome may be uncertain.",
    "bridge-busy": "A request is still in flight. Wait for it to finish, then resume.",
    "backup-missing": "A target's backup is missing. No removal was attempted; export existing data and investigate storage.",
    "storage-error": "Could not save a backup/checkpoint. Free storage or reload, then resume. Captured data is untouched.",
    "run-cap": "Checkpoint reached (2,500 attempts or 3 hours). Take a break, then resume.",
  };
  UF_REASONS["engine-busy"] = US_REASONS["engine-busy"];
  UF_START_REASONS["engine-busy"] = US_REASONS["engine-busy"];
  REASONS["engine-busy"] = US_REASONS["engine-busy"];

  const LOG_MAX = 50;
  const THEME_KEY = "bmPopupTheme";
  const UF_BACKUP_KEY = "xUnfollowBackup";

  /* ---------------------------------------------------------------------------
     2 · DOM
     --------------------------------------------------------------------------- */

  const $ = (sel) => document.querySelector(sel);

  const el = {
    tabHint:        $("#tabHint"),
    tablist:        $(".tabs"),
    tabs:           Array.from(document.querySelectorAll(".tab")),
    panels:         Array.from(document.querySelectorAll(".panel[data-panel]")),
    popupBody:      $("#popupBody"),
    captureDot:     $("#captureDot"),
    unfollowDot:    $("#unfollowDot"),
    unsaveDot: $("#unsaveDot"),
    unsaveBackup: $("#unsaveBackup"),
    usStartBtn: $("#usStartBtn"),
    usStartLabel: $("#usStartLabel"),
    usPauseBtn: $("#usPauseBtn"),
    usStopBtn: $("#usStopBtn"),
    usResetBtn: $("#usResetBtn"),
    unsaveCard: $("#unsaveCard"),
    unsaveStatus: $("#unsaveStatus"),
    statusCard:     $("#statusCard"),
    statusLabel:    $("#statusLabel"),
    statusDetail:   $("#statusDetail"),
    progressHost:   $("#progressHost"),
    primaryBtn:     $("#primaryBtn"),
    primaryLabel:   $("#primaryLabel"),
    primaryIcon:    $("#primaryIcon"),
    pauseBtn:       $("#pauseBtn"),
    stopBtn:        $("#stopBtn"),
    panicBtn:       $("#panicBtn"),
    captureControls: $("#primaryBtn") ? $("#primaryBtn").closest(".controls") : null,
    exportJson:     $("#exportJson"),
    exportJsonl:    $("#exportJsonl"),
    exportCsv:      $("#exportCsv"),
    exportMd:       $("#exportMd"),
    exportHtml:     $("#exportHtml"),
    exportHint:     $("#exportHint"),
    appHelp:        $("#appHelp"),
    runAudit:       $("#runAudit"),
    auditResult:    $("#auditResult"),
    auditStatus:    $("#auditStatus"),
    auditMetrics:   $("#auditMetrics"),
    auditFindings:  $("#auditFindings"),
    log:            $("#log"),
    logCount:       $("#logCount"),
    logPreview:     $("#logPreview"),
    versionBadge:   $("#versionBadge"),
    resetBtn:       $("#resetBtn"),
    themeToggle:    $("#themeToggle"),
    mediaHint:      $("#mediaHint"),
    stats:          $("#stats"),
    unfollowBackup: $("#unfollowBackup"),
    ufStartBtn:     $("#ufStartBtn"),
    ufStartLabel:   $("#ufStartLabel"),
    ufPauseBtn:     $("#ufPauseBtn"),
    ufStopBtn:      $("#ufStopBtn"),
    ufResetBtn:     $("#ufResetBtn"),
    unfollowCard:   $("#unfollowCard"),
    unfollowStatus: $("#unfollowStatus"),
  };

  const usStats = { queued: $("#usQueued"), done: $("#usDone"), failed: $("#usFailed"), rate: $("#usRate") };
  const ufStats = {
    queued: $("#ufQueued"),
    done:   $("#ufDone"),
    failed: $("#ufFailed"),
    rate:   $("#ufRate"),
  };

  const stats = {
    captured: { el: $("#statCaptured"), box: document.querySelector(".stat--captured") },
    newItems: { el: $("#statNew"),      box: document.querySelector(".stat--new") },
    media:    { el: $("#statMedia"),    box: document.querySelector(".stat--media") },
    failed:   { el: $("#statFailed"),   box: document.querySelector(".stat--failed") },
  };

  const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
  const ICON_RESUME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>';

  const snackbar = createSnackbar($("#snackbar"));
  const dialog = createOverlay({ element: $("#dialog"), scrim: $("#scrim") });

  let currentState = null;
  let captureCount = 0;
  /* Unfollow engine mirror + backup size (for the Backup button gate). */
  let ufState = null;
  let ufBackupCount = 0;
  let usState = null, usBackupCount = 0;
  /* The dashboard is a media browser, so "how many posts" is no longer the
     number that tells you whether the capture is working. A run that found
     400 posts and zero photos means the media pipeline broke, and the old
     popup could not distinguish that from a good run. */
  let mediaCount = 0;
  let videoCount = 0;

  /* ---------------------------------------------------------------------------
     3 · Theme
     Reuses the shared engine. The popup keeps its own light/dark preference in
     extension storage; the seed matches the dashboard's default so the two
     surfaces are recognisably the same product.
     --------------------------------------------------------------------------- */

  const theme = M3ETheme.createController({
    seed: M3ETheme.DEFAULTS.seed,
    variant: M3ETheme.DEFAULTS.variant,
    scheme: "system",
    density: "comfortable",
  });

  async function loadTheme() {
    try {
      const stored = await chrome.storage.local.get({ [THEME_KEY]: "system" });
      theme.set({ scheme: stored[THEME_KEY] });
    } catch {
      /* storage unavailable (e.g. opened outside the extension) — keep default */
    }
    syncThemeToggleLabel();
  }

  /* The icon states the current scheme instead of always showing a sun; the
     button cycles system → light → dark, so one glyph must answer "which". */
  const THEME_ICONS = {
    system:
      '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2">' +
      '<circle cx="12" cy="12" r="9" />' +
      '<path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" stroke="none" />' +
      "</svg>",
    light:
      '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<circle cx="12" cy="12" r="4.5" />' +
      '<path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />' +
      "</svg>",
    dark:
      '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">' +
      '<path d="M20.5 13.3A8.5 8.5 0 1 1 10.7 3.5a6.7 6.7 0 0 0 9.8 9.8Z" />' +
      "</svg>",
  };

  function syncThemeToggleLabel() {
    const schemeLabels = { system: "System", light: "Light", dark: "Dark" };
    const currentScheme = theme.settings.scheme || "system";
    el.themeToggle.setAttribute(
      "aria-label",
      `Switch color scheme (current: ${schemeLabels[currentScheme]})`
    );
    el.themeToggle.title = `Switch color scheme (current: ${schemeLabels[currentScheme]})`;
    el.themeToggle.innerHTML = THEME_ICONS[currentScheme] || THEME_ICONS.system;
  }

  theme.subscribe(syncThemeToggleLabel);
  syncThemeToggleLabel();

  el.themeToggle.addEventListener("click", async () => {
    const schemes = ["system", "light", "dark"];
    const currentIndex = schemes.indexOf(theme.settings.scheme || "system");
    const next = schemes[(currentIndex + 1) % schemes.length];
    theme.set({ scheme: next });
    syncThemeToggleLabel();
    try { await chrome.storage.local.set({ [THEME_KEY]: next }); } catch {}
  });

  /* ---------------------------------------------------------------------------
     4 · Activity log
     --------------------------------------------------------------------------- */

  function log(message, level = "info") {
    const li = document.createElement("li");
    if (level === "warn") li.className = "is-warn";
    else if (level === "error") li.className = "is-error";

    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    li.innerHTML =
      "<span>" + escapeHtml(message) + "</span>" +
      '<span class="log__time">' + escapeHtml(time) + "</span>";

    el.log.prepend(li);
    while (el.log.children.length > LOG_MAX) el.log.removeChild(el.log.lastElementChild);
    el.logCount.textContent = String(el.log.children.length);
    /* The collapsed summary carries the latest line, so a quiet run still
       shows that something happened without opening the log. */
    if (el.logPreview) {
      el.logPreview.textContent = message;
      el.logPreview.title = message;
    }
  }

  /* ---------------------------------------------------------------------------
     5 · State rendering
     --------------------------------------------------------------------------- */

  const countUpRuns = new WeakMap();
  const nextCountUpRun = (el) => {
    const token = (countUpRuns.get(el) || 0) + 1;
    countUpRuns.set(el, token);
    return token;
  };

  function setStat(key, value) {
    const slot = stats[key];
    if (!slot || !slot.el) return;
    const nextNum = Number(value) || 0;
    const prev = Number(slot.el.dataset.countValue) || 0;
    slot.el.dataset.countValue = String(nextNum);

    // Emphasis must be correct on first paint too, so set it before the
    // early-out that skips the animation for unchanged values.
    if (slot.box) slot.box.dataset.nonzero = String(nextNum > 0);

    if (prev === nextNum) {
      nextCountUpRun(slot.el);
      if (slot.el.textContent !== nextNum.toLocaleString()) slot.el.textContent = nextNum.toLocaleString();
      return;
    }

    // Count-up animation for increasing numbers
    if (nextNum > prev && prev >= 0) {
      animateCountUp(slot.el, prev, nextNum);
    } else {
      nextCountUpRun(slot.el);
      slot.el.textContent = nextNum.toLocaleString();
    }
    // A number that changed should be *seen* to change. Expressive motion,
    // applied at the smallest possible scale.
    pulse(slot.el);
  }

  function animateCountUp(el, start, end, duration = 500) {
    const token = nextCountUpRun(el);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = end.toLocaleString();
      return;
    }
    const startTime = performance.now();
    const step = (now) => {
      if (countUpRuns.get(el) !== token) return;
      const progress = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // cubic ease-out
      const current = Math.round(start + (end - start) * eased);
      el.textContent = current.toLocaleString();
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function setPrimaryLoading(isLoading) {
    if (isLoading) el.primaryBtn.hidden = false;
    el.primaryBtn.classList.toggle("m3e-button--loading", isLoading);
    el.primaryBtn.setAttribute("aria-busy", String(isLoading));
    el.primaryBtn.disabled = isLoading || currentState?.status === "capturing";
    el.primaryIcon.style.display = isLoading ? "none" : "";
    if (isLoading) el.primaryLabel.textContent = "Starting…";
    else {
      const paused = currentState?.status === "paused";
      el.primaryLabel.textContent = paused ? "Resume capture" : "Start capture";
    }
  }

  function renderState() {
    const s = currentState || {};
    const status = s.status && STATUS[s.status] ? s.status : "idle";
    const meta = STATUS[status];
    const st = s.stats || {};
    const running = status === "capturing";
    const paused = status === "paused";

    el.statusCard.dataset.status = status;
    setTabSignal(el.captureDot, running ? "running" : paused ? "paused" : "");
    el.statusLabel.textContent = meta.label;

    // Detail line: live progress while capturing, stop reason when done
    let detail = meta.detail;
    if (running && s.lastStopReason?.startsWith("backoff-")) {
      const match = s.lastStopReason.match(/backoff-(\d+)\s+\(attempt\s+(\d+)\/(\d+),\s+(\d+)s\)/);
      if (match) {
        const [, httpStatus, attempt, maxAttempts, seconds] = match;
        detail = `Rate limited (HTTP ${httpStatus}) — retry ${attempt}/${maxAttempts} in ${seconds}s`;
        el.statusCard.dataset.status = "rate-limited";
      } else detail = s.lastStopReason;
    } else if (running) {
      const scrollBatches = Number(st.scrollBatches) || 0;
      const captured = Number(st.captured) || 0;
      const newItems = Number(st.newItems) || 0;
      const postsPerMin = Number(st.postsPerMin) || 0;
      const parts = [];
      if (scrollBatches > 0) parts.push(`Pass ${scrollBatches}`);
      if (captured > 0) parts.push(`${captured.toLocaleString()} posts`);
      if (newItems > 0) parts.push(`${newItems.toLocaleString()} new`);
      if (st.timelineResponses > 0) parts.push(`${Number(st.timelineResponses).toLocaleString()} pages`);
      if (postsPerMin > 0) parts.push(`${postsPerMin}/min`);
      detail = parts.join(" · ") || meta.detail;
    } else if (s.lastStopReason && !running) {
      detail = REASONS[s.lastStopReason] || "Stopped: " + s.lastStopReason;
    }
    if (s.updatedAt && status !== "idle") {
      const t = new Date(s.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      detail += " · " + t;
    }
    el.statusDetail.textContent = detail;

    el.progressHost.hidden = !running;

    setStat("captured", st.captured || 0);
    setStat("newItems", st.newItems || 0);
    /* Media replaces "duplicates" on the front tile set. A duplicate count is
       diagnostics for the scraper; a media count is the thing the user is
       actually here to collect, and it is the fastest signal that the run is
       producing something worth browsing. Duplicates move to the log. */
    setStat("media", mediaCount);
    setStat("failed", st.failed || 0);

    if (el.mediaHint) {
      const parts = [];
      if (mediaCount) {
        parts.push(videoCount
          ? videoCount.toLocaleString() + (videoCount === 1 ? " video" : " videos") + " included"
          : "Photos only so far");
      } else {
        parts.push("No photos or video yet");
      }
      // Duplicates lost their tile, so they keep a voice here — the signal is
      // still useful (it means an incremental pass is catching up) but it is
      // not worth a quarter of the counter row.
      if (st.duplicates) parts.push(st.duplicates.toLocaleString() + " already had");
      el.mediaHint.textContent = parts.join(" · ");
    }

    // One primary action whose meaning depends on state: start, or resume.
    // While a run is live there is nothing for it to do, so it leaves the
    // layout instead of sitting there as a dead 56px slab; Pause/Stop grow
    // into the space it vacated.
    el.primaryBtn.disabled = running;
    el.primaryBtn.hidden = running;
    if (el.captureControls) el.captureControls.dataset.running = String(running);
    el.primaryLabel.textContent = paused ? "Resume capture" : "Start capture";
    el.primaryIcon.innerHTML = paused ? ICON_RESUME : ICON_PLAY;

    el.pauseBtn.disabled = !running;
    el.stopBtn.disabled = !running && !paused;
    el.panicBtn.disabled = !running;
  }

  function renderExportHint() {
    if (!captureCount) {
      el.exportHint.textContent = "Nothing captured yet.";
      el.exportJson.disabled = true;
      el.exportJsonl.disabled = true;
      el.exportCsv.disabled = true;
      el.exportMd.disabled = true;
      el.exportHtml.disabled = true;
      el.runAudit.disabled = true;
      updateTabHint();
      return;
    }
    el.exportHint.textContent =
      captureCount.toLocaleString() + (captureCount === 1 ? " post" : " posts") +
      (mediaCount ? " · " + mediaCount.toLocaleString() + (mediaCount === 1 ? " media item" : " media items") : "") +
      " ready to export.";
    el.exportJson.disabled = false;
    el.exportJsonl.disabled = false;
    el.exportCsv.disabled = false;
    el.exportMd.disabled = false;
    el.exportHtml.disabled = false;
    el.runAudit.disabled = false;
    updateTabHint();
  }

  /* ---------------------------------------------------------------------------
     5b · Unfollow engine rendering
     --------------------------------------------------------------------------- */

  function setUfStat(slot, value) {
    if (!slot) return;
    const nextNum = Number(value) || 0;
    const prev = Number(slot.dataset.countValue) || 0;
    slot.dataset.countValue = String(nextNum);
    const box = slot.closest(".stat");
    if (box) box.dataset.nonzero = String(nextNum > 0);
    if (prev === nextNum) {
      nextCountUpRun(slot);
      if (slot.textContent !== nextNum.toLocaleString()) slot.textContent = nextNum.toLocaleString();
      return;
    }
    if (nextNum > prev && prev >= 0) animateCountUp(slot, prev, nextNum);
    else {
      nextCountUpRun(slot);
      slot.textContent = nextNum.toLocaleString();
    }
    pulse(slot);
  }

  function renderUnfollow() {
    const s = ufState || {};
    const status = UF_STATUS[s.status] ? s.status : "idle";
    const st = s.stats || {};
    const running = status === "running";
    const navigating = status === "navigating";
    const paused = status === "paused";
    const resumable = paused || status === "stopped_by_user" || status === "stopped_by_error";
    const backingOff = !!(s.lastStopReason && s.lastStopReason.startsWith("backoff-"));

    let text = UF_STATUS[status] || UF_STATUS.idle;
    if (running && backingOff) {
      const match = s.lastStopReason.match(/backoff-(\d+)\s+\(attempt\s+(\d+)\/(\d+),\s+(\d+)s\)/);
      text = match
        ? `Rate limited (HTTP ${match[1]}) — retry ${match[2]}/${match[3]} in ${match[4]}s`
        : s.lastStopReason;
    } else if (running) {
      const doneCount = (Number(st.unfollowed) || 0) + (Number(st.already) || 0);
      const parts = [];
      if (s.lastStopReason && s.lastStopReason.startsWith("wave-break")) parts.push("reading pause");
      if (st.pending) parts.push(`${Number(st.pending).toLocaleString()} queued`);
      if (doneCount) parts.push(`${doneCount.toLocaleString()} done`);
      if (st.perMin) parts.push(`${Number(st.perMin)}/min`);
      if (st.rateLimits) parts.push(`${Number(st.rateLimits)} limit wait(s)`);
      text = parts.join(" · ") || "Unfollowing — warming up…";
    } else if (s.lastStopReason && UF_REASONS[s.lastStopReason]) {
      text = UF_REASONS[s.lastStopReason];
    } else if (s.lastStopReason && status !== "idle") {
      text = "Stopped: " + s.lastStopReason;
    }
    const tone = running && backingOff ? "rate-limited" : status;
    el.unfollowStatus.textContent = text;
    el.unfollowStatus.dataset.status = tone;
    if (el.unfollowCard) el.unfollowCard.dataset.status = tone;
    setTabSignal(el.unfollowDot, running || navigating ? "running" : paused ? "paused" : "");

    const done = (Number(st.unfollowed) || 0) + (Number(st.already) || 0);
    setUfStat(ufStats.queued, st.pending || 0);
    setUfStat(ufStats.done, done);
    setUfStat(ufStats.failed, st.failed || 0);
    setUfStat(ufStats.rate, st.perMin || 0);

    const busy = running || navigating;
    el.ufStartBtn.disabled = busy;
    el.ufStartBtn.setAttribute("aria-busy", String(navigating));
    el.ufStartLabel.textContent = navigating ? "Opening…"
      : busy ? "Unfollowing…"
        : resumable ? "Resume unfollow"
          : "Start unfollow";
    el.ufPauseBtn.disabled = !running;
    el.ufStopBtn.disabled = !busy;
    el.unfollowBackup.disabled = ufBackupCount <= 0;
  }

  function renderUnsave() {
    const s = usState || {};
    const status = US_STATUS[s.status] ? s.status : "idle";
    const st = s.stats || {};
    const running = status === "running";
    const navigating = status === "navigating";
    const paused = status === "paused";
    const resumable = paused || status === "stopped_by_user" || status === "stopped_by_error";
    const backingOff = !!(s.lastStopReason && s.lastStopReason.startsWith("backoff-"));

    let text = US_STATUS[status] || US_STATUS.idle;
    if (running && backingOff) {
      const match = s.lastStopReason.match(/backoff-(\d+)\s+\(attempt\s+(\d+)\/(\d+),\s+(\d+)s\)/);
      text = match
        ? `Rate limited (HTTP ${match[1]}) — retry ${match[2]}/${match[3]} in ${match[4]}s`
        : s.lastStopReason;
    } else if (running) {
      const doneCount = (Number(st.unsaved) || 0) + (Number(st.already) || 0);
      const parts = [];
      if (s.lastStopReason && s.lastStopReason.startsWith("wave-break")) parts.push("reading pause");
      if (st.pending) parts.push(`${Number(st.pending).toLocaleString()} queued`);
      if (doneCount) parts.push(`${doneCount.toLocaleString()} done`);
      if (st.perMin) parts.push(`${Number(st.perMin)}/min`);
      if (st.rateLimits) parts.push(`${Number(st.rateLimits)} limit wait(s)`);
      text = s.lastStopReason === "verifying-feed" ? US_REASONS["verifying-feed"] : parts.join(" · ") || "Unsaving — warming up…";
    } else if (s.lastStopReason && US_REASONS[s.lastStopReason]) {
      text = US_REASONS[s.lastStopReason];
    } else if (s.lastStopReason && status !== "idle") {
      text = "Stopped: " + s.lastStopReason;
    }
    const tone = running && backingOff ? "rate-limited" : status;
    el.unsaveStatus.textContent = text;
    el.unsaveStatus.dataset.status = tone;
    if (el.unsaveCard) el.unsaveCard.dataset.status = tone;
    setTabSignal(el.unsaveDot, running || navigating ? "running" : paused ? "paused" : "");

    const done = (Number(st.unsaved) || 0) + (Number(st.already) || 0);
    setUfStat(usStats.queued, st.pending || 0);
    setUfStat(usStats.done, done);
    setUfStat(usStats.failed, st.failed || 0);
    setUfStat(usStats.rate, st.perMin || 0);

    const busy = running || navigating;
    el.usStartBtn.disabled = busy;
    el.usStartBtn.setAttribute("aria-busy", String(busy));
    el.usStartLabel.textContent = navigating ? "Opening…"
      : busy ? "Unsaving…"
        : resumable ? "Resume unsaving"
          : "Unsave all bookmarks";
    el.usPauseBtn.disabled = !running;
    el.usStopBtn.disabled = !busy;
    el.unsaveBackup.disabled = usBackupCount <= 0;
  }

  /* ---------------------------------------------------------------------------
     6 · Storage + messaging
     --------------------------------------------------------------------------- */

  async function loadState() {
    try {
      const [data, summary, ufData, backupData, usData, usBackup] = await Promise.all([
        chrome.storage.local.get({ xCaptureState: null }),
        XBookmarkStore.summary(),
        chrome.storage.local.get({ xUnfollowState: null }),
        chrome.storage.local.get({ [UF_BACKUP_KEY]: null }),
        chrome.storage.local.get({ xUnsaveState: null }),
        chrome.storage.local.get({ xUnsaveBackup: null }),
      ]);
      currentState = data.xCaptureState || null;
      captureCount = summary.count;
      mediaCount = summary.mediaItems;
      videoCount = summary.videos;
      usState = usData.xUnsaveState || null;
      usBackupCount = usBackup.xUnsaveBackup?.ids?.length || 0;
      ufState = ufData.xUnfollowState || null;
      ufBackupCount = Array.isArray(backupData[UF_BACKUP_KEY]?.entries)
        ? backupData[UF_BACKUP_KEY].entries.length : 0;
    } catch (error) {
      console.warn("[popup] Could not read capture state", error);
      currentState = null;
      captureCount = 0;
      mediaCount = 0;
      videoCount = 0;
      ufState = null;
      ufBackupCount = 0;
    }
    renderState();
    renderExportHint();
    renderUnfollow();
    renderUnsave();
  }

  async function activeTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    } catch {
      return null;
    }
  }

  const isBookmarksUrl = (url) => /^https:\/\/x\.com\/i\/bookmarks(?:[/?#]|$)/i.test(String(url || ""));
  const isFollowingUrl = (url) => /^https:\/\/x\.com\/[^/]+\/following(?:[/?#]|$)/i.test(String(url || ""));
  const isXUrl = (url) => /^https?:\/\/(?:www\.)?x\.com\//i.test(String(url || ""));

  /* ---------------------------------------------------------------------------
     6b · Tab navigation
     Four panels, one visible. Implemented as a real tablist (roving tabindex,
     arrow/Home/End keys) rather than four show/hide buttons, so the structure
     survives a screen reader and the keyboard.
     --------------------------------------------------------------------------- */

  const TAB_IDS = ["capture", "unfollow", "unsave", "export"];
  let activeView = "capture";
  let tabContext = null;

  /** Mark a tab with a live signal: running pulses, paused squares off. */
  function setTabSignal(dot, state) {
    if (!dot) return;
    dot.hidden = !state;
    dot.dataset.state = state || "";
    const tab = dot.closest(".tab");
    if (!tab) return;
    if (state) {
      tab.setAttribute(
        "aria-label",
        tab.dataset.label + (state === "paused" ? ", paused" : ", running")
      );
    } else {
      tab.removeAttribute("aria-label");
    }
  }

  /** Header hint follows the active tab — each surface needs a different tab. */
  function updateTabHint() {
    if (!el.tabHint) return;
    let text = "Checking this tab…";
    let warn = false;

    if (activeView === "export") {
      text = captureCount
        ? captureCount.toLocaleString() + (captureCount === 1 ? " post" : " posts") + " in your local library"
        : "Local library — nothing captured yet";
    } else if (tabContext) {
      if (activeView === "unsave") {
        text = tabContext.onBookmarks ? "Unsave from your X bookmarks" : "Open x.com/i/bookmarks to unsave";
        warn = !tabContext.onBookmarks;
      } else if (activeView === "unfollow") {
        if (tabContext.onFollowing) text = "Ready — Following list";
        else if (tabContext.onX) text = "Starts from this x.com page";
        else { text = "Open x.com to unfollow"; warn = true; }
      } else if (tabContext.onBookmarks) {
        text = "Ready — bookmarks page";
      } else if (tabContext.onX) {
        text = "Open x.com/i/bookmarks to capture";
        warn = true;
      } else {
        text = "Open x.com to capture";
        warn = true;
      }
    }

    el.tabHint.textContent = text;
    el.tabHint.classList.toggle("is-warn", warn);
  }

  function selectTab(id, { focus = false } = {}) {
    if (!TAB_IDS.includes(id)) id = "capture";
    activeView = id;

    for (const tab of el.tabs) {
      const selected = tab.dataset.tab === id;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus({ preventScroll: true });
    }
    for (const panel of el.panels) panel.hidden = panel.dataset.panel !== id;
    if (el.popupBody) el.popupBody.scrollTop = 0;
    updateTabHint();
  }

  function wireTabs() {
    for (const tab of el.tabs) {
      tab.addEventListener("click", () => selectTab(tab.dataset.tab));
    }
    if (!el.tablist) return;
    el.tablist.addEventListener("keydown", (event) => {
      const index = TAB_IDS.indexOf(activeView);
      let next = null;
      if (event.key === "ArrowRight") next = (index + 1) % TAB_IDS.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + TAB_IDS.length) % TAB_IDS.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = TAB_IDS.length - 1;
      if (next === null) return;
      event.preventDefault();
      selectTab(TAB_IDS[next], { focus: true });
    });
  }

  /** Tell the user, up front, which engine this tab can drive. */
  async function renderTabHint() {
    const tab = await activeTab();
    tabContext = {
      onBookmarks: !!(tab && isBookmarksUrl(tab.url)),
      onFollowing: !!(tab && isFollowingUrl(tab.url)),
      onX: !!(tab && isXUrl(tab.url)),
    };
    el.primaryBtn.dataset.ready = String(tabContext.onBookmarks);
    updateTabHint();
    return tabContext;
  }

  async function send(type) {
    const tab = await activeTab();
    if (!tab || !isBookmarksUrl(tab.url)) {
      snackbar.show("Open https://x.com/i/bookmarks in the active tab first.", { error: true });
      log("No x.com tab active.", "warn");
      return null;
    }
    try {
      return await chrome.tabs.sendMessage(tab.id, { type });
    } catch {
      snackbar.show("Can't reach the x.com tab. Reload it and try again.", { error: true });
      log("Content script unreachable — reload the tab.", "error");
      return null;
    }
  }

  /**
   * The unfollow engine accepts any x.com tab: from there it can auto-open
   * the Following list itself, so the gate is looser than capture's.
   */
  async function sendUnfollow(type) {
    const tab = await activeTab();
    if (!tab || !isXUrl(tab.url)) {
      snackbar.show("Open x.com in the active tab first.", { error: true });
      log("No x.com tab active for this engine.", "warn");
      return null;
    }
    try {
      return await chrome.tabs.sendMessage(tab.id, { type });
    } catch {
      snackbar.show("Can't reach the x.com tab. Reload it and try again.", { error: true });
      log("Content script unreachable — reload the tab.", "error");
      return null;
    }
  }

  /* ---------------------------------------------------------------------------
     7 · Transport controls
     --------------------------------------------------------------------------- */

  function wireControl(button, type, handlers) {
    button.addEventListener("click", async () => {
      const res = await send(type);
      if (!res) return;
      if (res.ok) {
        handlers.ok(res);
        setTimeout(loadState, 500);
      } else if (handlers.fail) {
        handlers.fail(res);
      } else {
        log(type + " failed: " + (res.reason || "unknown"), "error");
      }
    });
  }

  el.primaryBtn.addEventListener("click", async () => {
    setPrimaryLoading(true);
    const res = await send("start");
    if (!res) {
      setPrimaryLoading(false);
      return;
    }
    if (res.ok) {
      log(res.resumed ? "Capture resumed." : "Capture started.");
    } else if (res.reason === "already-running") {
      log("Capture is already running.", "warn");
    } else {
      const friendly = res.reason === "unfollow-running"
        ? "Stop the unfollow engine first — one engine runs at a time."
        : res.reason || "Couldn't start capture.";
      log("Couldn't start: " + (res.reason || "unknown"), "error");
      snackbar.show(friendly, { error: true });
    }
    await loadState();
    setPrimaryLoading(false);
  });

  wireControl(el.pauseBtn, "pause", {
    ok: () => log("Paused. Manual scrolling is still captured."),
  });

  wireControl(el.stopBtn, "stop", {
    ok: () => log("Stopping and flushing pending items…"),
  });

  el.panicBtn.addEventListener("click", () => {
    confirmDialog({
      title: "Abort this run?",
      body: "Panic stop halts capture immediately without flushing pending items. Anything already saved is kept.",
      confirmLabel: "Abort now",
      destructive: true,
      onConfirm: async () => {
        const res = await send("panic");
        if (res && res.ok) {
          log("Panic stop requested.", "warn");
          setTimeout(loadState, 400);
        }
      },
    });
  });

  /* ---------------------------------------------------------------------------
     7b · Unfollow controls
     --------------------------------------------------------------------------- */

  function setUfStartLoading(loading) {
    el.ufStartBtn.disabled = loading;
    el.ufStartBtn.setAttribute("aria-busy", String(loading));
    if (loading) el.ufStartLabel.textContent = "Starting…";
    else renderUnfollow();
  }

  el.ufStartBtn.addEventListener("click", () => {
    confirmDialog({
      title: "Unfollow everyone you follow?",
      body: "The engine sweeps your Following list and unfollows every account — one at a time, at human speed: warm-up ramp, jittered gaps, irregular wave breaks, a ~26/min ceiling, and automatic backoff when X pushes back. Every account is written to a local JSON backup so you can review it or re-follow later. You can pause or stop any time; the engine also takes a forced checkpoint break every 2,500 attempts.",
      confirmLabel: "Start unfollowing",
      destructive: true,
      onConfirm: async () => {
        setUfStartLoading(true);
        const res = await sendUnfollow("unfollow-start");
        setUfStartLoading(false);
        if (!res) return;
        if (res.ok) {
          if (res.navigating) {
            log("Opening the Following list — engine starts on arrival.");
            snackbar.show("Following list opening — the engine starts automatically.");
          } else {
            log(res.resumed ? "Unfollow run resumed." : "Unfollow run started.");
          }
        } else {
          const reason = res.reason || "unknown";
          log("Unfollow start failed: " + reason, "error");
          snackbar.show(UF_START_REASONS[reason] || reason, { error: true });
        }
        setTimeout(loadState, 500);
      },
    });
  });

  el.ufPauseBtn.addEventListener("click", async () => {
    const res = await sendUnfollow("unfollow-pause");
    if (!res) return;
    if (res.ok) {
      log("Unfollow paused — progress saved.");
      setTimeout(loadState, 400);
    } else {
      const reason = res.reason || "unknown";
      log("Unfollow pause failed: " + reason, "error");
      snackbar.show(UF_REASONS[reason] || reason, { error: true });
    }
  });

  el.ufStopBtn.addEventListener("click", async () => {
    const res = await sendUnfollow("unfollow-stop");
    if (!res) return;
    if (res.ok) {
      log("Unfollow stopped — progress saved; Start resumes the queue.");
      setTimeout(loadState, 400);
    } else {
      const reason = res.reason || "unknown";
      log("Unfollow stop failed: " + reason, "error");
      snackbar.show(UF_REASONS[reason] || reason, { error: true });
      setTimeout(loadState, 300);
    }
  });

  el.ufResetBtn.addEventListener("click", () => {
    confirmDialog({
      title: "Reset unfollow data?",
      body: "Clears the queue, counters, and the local JSON backup of targeted accounts. Accounts you already unfollowed are not re-followed — this only forgets the engine's records. Captured bookmarks are untouched.",
      confirmLabel: "Reset unfollow data",
      destructive: true,
      onConfirm: async () => {
        const res = await sendUnfollow("unfollow-reset");
        if (res && res.ok === false) {
          snackbar.show(UF_REASONS[res.reason] || res.reason, { error: true });
          log("Unfollow reset refused: " + res.reason, "error");
          return;
        }
        if (!res) {
          // No reachable tab: still clear from the popup side so a dead tab
          // cannot trap data.
          await chrome.storage.local.remove(["xUnfollowState", "xUnfollowSession", UF_BACKUP_KEY, "xUnfollowQueryId"]);
        }
        ufState = null;
        ufBackupCount = 0;
        renderUnfollow();
        snackbar.show("Unfollow data reset.");
        log("Unfollow data reset.", "warn");
      },
    });
  });

  // The new destructive operation shares the existing dialog, tabs, live
  // mirrors and messaging. Cancellation never sends an engine Start.
  el.usStartBtn.addEventListener("click", () => confirmDialog({
    title: "Unsave all bookmarks on X?",
    body: "This removes saved posts from the signed-in X account on every device. It does not delete the posts or your captured local library. Every target is backed up before removal, but there is no automatic undo. Keep the bookmarks tab open. The run uses paced requests and may pause for rate limits or a safety checkpoint.",
    confirmLabel: "Unsave all bookmarks", destructive: true,
    onConfirm: async () => {
      el.usStartBtn.disabled = true; el.usStartBtn.setAttribute("aria-busy", "true");
      const result = await sendUnfollow("unsave-start");
      if (result?.ok) log(result.resumed ? "Unsave run resumed." : "Unsave run started — backup before each removal.");
      else if (result) { snackbar.show(US_REASONS[result.reason] || result.reason, { error: true }); log("Unsave start: " + result.reason, "warn"); }
      await loadState();
    },
  }));
  for (const [button, command, message] of [[el.usPauseBtn, "unsave-pause", "Unsave paused — progress saved."], [el.usStopBtn, "unsave-stop", "Unsave stopped — progress saved."]]) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      const result = await sendUnfollow(command);
      if (result?.ok) log(message);
      else if (result) snackbar.show(US_REASONS[result.reason] || result.reason, { error: true });
      await loadState();
    });
  }
  el.usResetBtn.addEventListener("click", () => confirmDialog({
    title: "Reset unsave data?", confirmLabel: "Reset unsave data", destructive: true,
    body: "Deletes this engine's queue, counters and backup. It does not restore removed bookmarks, clear captured posts, or change Unfollow data. Download the backup first if you need it. Stop any active engine before resetting.",
    onConfirm: async () => {
      const result = await sendUnfollow("unsave-reset");
      if (result?.ok) log("Unsave data reset.", "warn");
      else if (result) snackbar.show(US_REASONS[result.reason] || result.reason, { error: true });
      await loadState();
    },
  }));
  el.unsaveBackup.addEventListener("click", async () => {
    try {
      const { xUnsaveBackup: meta } = await chrome.storage.local.get("xUnsaveBackup");
      if (!meta?.ids?.length) { snackbar.show("No unsave backup yet."); return; }
      const keys = meta.ids.map((id) => `xUnsavePost.${meta.accountId}.${id}`);
      const records = await chrome.storage.local.get(keys);
      const entries = keys.map((key) => records[key]);
      if (entries.some((entry) => !entry)) throw new Error("Backup records are missing; refusing a partial export.");
      const data = { export_version: 1, source: "x-bookmarks-unsave-backup", account_id: meta.accountId, exported_at: new Date().toISOString(), count: entries.length, bookmarks: entries };
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      try { await chrome.downloads.download({ url, filename: "x-unsave-backup.json", saveAs: true }); }
      finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
      log("Downloaded x-unsave-backup.json.");
    } catch (error) { snackbar.show(error.message || "Could not export the unsave backup.", { error: true }); }
  });

  /* ---------------------------------------------------------------------------
     8 · Export
     --------------------------------------------------------------------------- */

  // Track last export timestamp for incremental exports
  const LAST_EXPORT_KEY = "xLastExport";

  async function getLastExportTime() {
    const { [LAST_EXPORT_KEY]: time = 0 } = await chrome.storage.local.get({ [LAST_EXPORT_KEY]: 0 });
    return time;
  }

  async function setLastExportTime(time) {
    await chrome.storage.local.set({ [LAST_EXPORT_KEY]: time });
  }

  async function buildExport(format, incremental = false) {
    const xBookmarks = await XBookmarkStore.readAll();
    if (!xBookmarks.length) {
      snackbar.show("Nothing captured yet.");
      return null;
    }

    let items = xBookmarks.slice();

    if (incremental) {
      const lastExport = await getLastExportTime();
      if (lastExport > 0) {
        const cutoff = new Date(lastExport).toISOString();
        items = items.filter((b) => b.captured_at && b.captured_at > cutoff);
        if (!items.length) {
          snackbar.show("No new posts since last export.");
          return null;
        }
      }
    }

    const ids = new Set(items.map((b) => b.tweet_id));
    if (ids.size !== items.length) {
      log((items.length - ids.size) + " duplicate id(s) in the export.", "warn");
    }

    const exportMeta = {
      export_version: 1,
      exported_at: new Date().toISOString(),
      incremental,
      count: items.length,
      source: "x-bookmarks-exporter",
      verification: XBookmarkAudit.audit(items, incremental ? null : currentState),
      bookmarks: items,
    };

    switch (format) {
      case "jsonl":
        return items.map((b) => JSON.stringify(b)).join("\n");
      case "csv":
        return buildCsv(items);
      case "md":
        return buildMarkdown(items);
      case "html":
        return buildHtml(items);
      default: // Compact JSON avoids wasting time and bandwidth on pretty-print whitespace.
        return JSON.stringify(exportMeta);
    }
  }

  function buildCsv(items) {
    const headers = [
      "tweet_id", "text", "type", "author_username", "author_name",
      "tweet_created_at", "tweet_url", "like_count", "retweet_count",
      "reply_count", "view_count", "has_media", "media_types", "urls"
    ];
    const escape = (v) => {
      const s = String(v ?? "").replace(/"/g, '""');
      return s.includes(",") || s.includes("\n") || s.includes('"') ? `"${s}"` : s;
    };
    const rows = items.map((b) => [
      escape(b.tweet_id),
      escape(b.text),
      escape(b.type),
      escape(b.author_username),
      escape(b.author_name),
      escape(b.tweet_created_at),
      escape(b.tweet_url),
      escape(b.like_count_at_capture),
      escape(b.retweet_count_at_capture),
      escape(b.reply_count_at_capture),
      escape(b.view_count_at_capture),
      escape(b.has_media),
      escape((b.media_types || []).join(";")),
      escape((b.urls_expanded || []).join(";"))
    ].join(","));
    return [headers.join(","), ...rows].join("\n");
  }

  function buildMarkdown(items) {
    const lines = [
      "# X Bookmarks Export",
      "",
      `Exported: ${new Date().toISOString()}`,
      `Posts: ${items.length}`,
      "",
      "---",
      ""
    ];
    for (const b of items) {
      lines.push(`## @${b.author_username || "unknown"} — ${b.tweet_created_at || "unknown date"}`);
      lines.push("");
      lines.push(b.text || "*(empty)*");
      lines.push("");
      if (b.urls_expanded?.length) {
        lines.push("**Links:**");
        for (const url of b.urls_expanded) lines.push(`- ${url}`);
        lines.push("");
      }
      if (b.media_items?.length) {
        lines.push("**Media:**");
        for (const m of b.media_items) {
          if (m.type === "photo") lines.push(`![](${m.url})`);
          else if (m.type === "video") lines.push(`[Video](${m.mp4}) (poster: ${m.poster})`);
        }
        lines.push("");
      }
      lines.push(`[View on X](${b.tweet_url})`);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
    return lines.join("\n");
  }

  function buildHtml(items) {
    const safeUrl = (value) => {
      const url = String(value || "");
      return /^https?:\/\//i.test(url) ? escapeHtml(url) : "";
    };
    const css = `
      body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
      .post { border: 1px solid #ddd; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
      .post-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
      .avatar { width: 32px; height: 32px; border-radius: 50%; }
      .meta { color: #666; font-size: 0.875rem; }
      .text { white-space: pre-wrap; margin: 0.5rem 0; }
      .media { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.5rem; }
      .media img, .media video { max-width: 100%; height: auto; border-radius: 4px; }
      .links a { margin-right: 1rem; }
    `;
    const postsHtml = items.map((b) => {
      const mediaHtml = (b.media_items || []).map((m) => {
        const poster = safeUrl(m.poster || m.url);
        if (m.type === "photo") {
          const url = safeUrl(m.url || m.poster);
          return url ? `<img src="${url}" alt="${escapeHtml(m.alt || "")}" loading="lazy" />` : "";
        }
        if (m.type === "video") {
          const src = safeUrl(m.mp4);
          return src ? `<video src="${src}" poster="${poster}" controls preload="none"></video>` : "";
        }
        return "";
      }).join("");
      const linksHtml = (b.urls_expanded || []).map((value) => {
        const url = safeUrl(value);
        return url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)}</a>` : "";
      }).join(" ");
      const avatar = safeUrl(b.author_profile_image_url);
      const tweetUrl = safeUrl(b.tweet_url || b.canonical_url || b.url);
      return `
        <article class="post">
          <header class="post-header">
            ${avatar ? `<img class="avatar" src="${avatar}" alt="" loading="lazy" />` : ""}
            <div>
              <strong>@${escapeHtml(b.author_username || "unknown")}</strong>
              <span class="meta">${escapeHtml(b.author_name || "")} · ${escapeHtml(b.tweet_created_at || "")}</span>
            </div>
          </header>
          <div class="text">${escapeHtml(b.text || "")}</div>
          ${mediaHtml ? `<div class="media">${mediaHtml}</div>` : ""}
          ${linksHtml ? `<div class="links">${linksHtml}</div>` : ""}
          ${tweetUrl ? `<footer><a href="${tweetUrl}" target="_blank" rel="noopener noreferrer">View on X</a></footer>` : ""}
        </article>
      `;
    }).join("");
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>X Bookmarks Export</title><style>${css}</style></head><body>${postsHtml}</body></html>`;
  }

  let exportInProgress = false;

  async function runExport(format, filename, incremental = false) {
    if (exportInProgress) return;
    exportInProgress = true;
    const exportButtons = [el.exportJson, el.exportJsonl, el.exportCsv, el.exportMd, el.exportHtml];
    exportButtons.forEach((button) => { button.disabled = true; });
    try {
      const content = await buildExport(format, incremental);
      if (content === null) return;
      const mime = format === "html" ? "text/html"
        : format === "csv" ? "text/csv"
          : format === "md" ? "text/markdown"
            : format === "jsonl" ? "application/x-ndjson" : "application/json";
      const blobUrl = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
      try {
        await chrome.downloads.download({ url: blobUrl, filename, saveAs: true });
      } catch (downloadError) {
        // A Blob URL is bounded and fast; the anchor path also supports older
        // Chromium builds whose downloads API rejects extension-created blobs.
        const anchor = document.createElement("a");
        anchor.href = blobUrl;
        anchor.download = filename;
        anchor.hidden = true;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        log("Used browser download fallback: " + String(downloadError?.message || downloadError), "warn");
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000);
      await setLastExportTime(Date.now());
      snackbar.show("Exported " + filename + (incremental ? " (incremental)" : ""));
      log("Downloaded " + filename + (incremental ? " [incremental]" : "") + ".");
    } catch (error) {
      snackbar.show("Export failed.", { error: true });
      log("Export failed: " + String(error?.message || error), "error");
    } finally {
      exportInProgress = false;
      renderExportHint();
    }
  }

  // Shift-click makes an incremental export; a single click handler prevents
  // accidentally starting both full and incremental downloads.
  const exportBindings = [
    [el.exportJson, "json", "xreels-bookmarks.json"],
    [el.exportJsonl, "jsonl", "x-bookmarks.jsonl"],
    [el.exportCsv, "csv", "x-bookmarks.csv"],
    [el.exportMd, "md", "x-bookmarks.md"],
    [el.exportHtml, "html", "x-bookmarks.html"],
  ];
  for (const [button, format, filename] of exportBindings) {
    button.addEventListener("click", (event) => {
      if (event.shiftKey) {
        const ext = filename.split(".").pop();
        runExport(format, `xreels-bookmarks-incremental.${ext}`, true);
      } else runExport(format, filename);
    });
  }

  /* ---------------------------------------------------------------------------
     Unfollow backup export — the undo record the engine maintains locally.
     --------------------------------------------------------------------------- */

  async function runBackupExport() {
    try {
      const data = await chrome.storage.local.get({ [UF_BACKUP_KEY]: null });
      const entries = Array.isArray(data[UF_BACKUP_KEY]?.entries) ? data[UF_BACKUP_KEY].entries : [];
      if (!entries.length) {
        snackbar.show("No unfollow backup yet.");
        return;
      }
      const payload = {
        export_version: 1,
        exported_at: new Date().toISOString(),
        source: "x-unfollow-engine",
        count: entries.length,
        accounts: entries,
      };
      const blobUrl = URL.createObjectURL(
        new Blob([JSON.stringify(payload)], { type: "application/json;charset=utf-8" })
      );
      try {
        await chrome.downloads.download({ url: blobUrl, filename: "x-unfollow-backup.json", saveAs: true });
      } catch (downloadError) {
        const anchor = document.createElement("a");
        anchor.href = blobUrl;
        anchor.download = "x-unfollow-backup.json";
        anchor.hidden = true;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        log("Used browser download fallback: " + String(downloadError?.message || downloadError), "warn");
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000);
      snackbar.show("Backup exported (" + entries.length.toLocaleString() + " accounts).");
      log("Downloaded x-unfollow-backup.json.");
    } catch (error) {
      snackbar.show("Backup export failed.", { error: true });
      log("Backup export failed: " + String(error?.message || error), "error");
    }
  }

  el.unfollowBackup.addEventListener("click", runBackupExport);

  el.appHelp.addEventListener("click", () => {
    confirmDialog({
      title: "Use this export in XReels",
      body: "Choose XReels JSON to download one app-ready file. In the app, open Import → Upload JSON and select that file. The export includes every captured bookmark, including text-only posts; to display text-only items, enable Settings → Keep text-only posts.",
      confirmLabel: "Got it",
      onConfirm: async () => {},
    });
  });

  function renderAudit(result) {
    const description = XBookmarkAudit.describe(result);
    const captureAudit = result.capture;
    el.auditResult.hidden = false;
    el.auditStatus.textContent = description.status;
    const hasWarnings = result.duplicateIds > 0 || result.invalidIds > 0 ||
      (captureAudit.available && captureAudit.missingUniqueIds > 0) ||
      (captureAudit.available && !captureAudit.endReached);
    el.auditStatus.dataset.tone = hasWarnings ? "warn" : result.capture.available ? "good" : "info";
    el.auditMetrics.textContent = description.summary;
    el.auditFindings.replaceChildren();

    const findings = [];
    if (captureAudit.available) {
      findings.push({
        text: `Timeline coverage: ${Number(captureAudit.coveredUniqueIds || 0).toLocaleString()} of ${Number(captureAudit.observedUniqueIds || 0).toLocaleString()} unique IDs observed in X responses are in storage; ${Number(captureAudit.missingUniqueIds || 0).toLocaleString()} unaccounted.`,
        tone: captureAudit.missingUniqueIds ? "warn" : "good",
      });
      findings.push({
        text: `Feed sweep: ${captureAudit.endReached ? "repeated quiet checks reached the feed end" : "no confirmed feed-end sweep in the latest run"} · ${Number(captureAudit.timelineResponses || 0).toLocaleString()} timeline responses · ${Number(captureAudit.pagesWithTweets || 0).toLocaleString()} pages with posts · ${Number(captureAudit.emptyResponses || 0).toLocaleString()} empty pages.`,
        tone: captureAudit.endReached ? "good" : "warn",
      });
      if (captureAudit.schemaMismatchResponses) findings.push({
        text: `${Number(captureAudit.schemaMismatchResponses).toLocaleString()} recognized timeline response(s) contained entries the parser could not identify. X may have changed its response shape; update the extension and retry.`,
        tone: "warn",
      });
      if (captureAudit.normalizationFailures) findings.push({
        text: `${Number(captureAudit.normalizationFailures).toLocaleString()} normalization failure(s) across ${Number(captureAudit.failedUniqueIds || 0).toLocaleString()} unique IDs. ${captureAudit.missingSamples?.length ? "Missing ID sample: " + captureAudit.missingSamples.slice(0, 8).join(", ") : "A later retry may have saved some previously failing posts."}`,
        tone: "warn",
      });
      if (captureAudit.preCaptureDropped) findings.push({
        text: `${captureAudit.preCaptureDropped} pre-start cached item(s) were evicted; the run starts at the top and re-sweeps the feed.`,
        tone: "info",
      });
      if (captureAudit.repeatedCursors) findings.push({
        text: `X repeated a bottom cursor ${captureAudit.repeatedCursors} time(s). This can be a retry; verify the feed-end result.`,
        tone: "info",
      });
    } else {
      findings.push({ text: "No completed capture audit is available yet. Run capture to compare response IDs with saved posts.", tone: "info" });
    }
    if (result.duplicateIds) findings.push({ text: `The library contains ${result.duplicateIds} duplicate post ID(s).`, tone: "warn" });
    if (result.invalidIds) findings.push({ text: `${result.invalidIds} row(s) have missing or non-numeric tweet IDs.`, tone: "warn" });
    if (result.suspiciousGapCount) findings.push({ text: description.gapNote, tone: "info" });
    if (!findings.length || (!result.duplicateIds && !result.invalidIds && captureAudit.available && captureAudit.missingUniqueIds === 0 && captureAudit.endReached)) {
      findings.push({ text: "All IDs seen in the captured X timeline responses are accounted for in the library.", tone: "good" });
    }
    findings.push({ text: "Limit: X does not publish a reliable total bookmark count here. Snowflake ID gaps are heuristic hints, never proof that a bookmark was skipped.", tone: "info" });

    for (const finding of findings) {
      const item = document.createElement("li");
      item.textContent = finding.text;
      item.dataset.tone = finding.tone;
      el.auditFindings.appendChild(item);
    }
  }

  el.runAudit.addEventListener("click", async () => {
    el.runAudit.disabled = true;
    el.runAudit.textContent = "Checking…";
    try {
      const posts = await XBookmarkStore.readAll();
      const result = XBookmarkAudit.audit(posts, currentState);
      renderAudit(result);
      log(`Integrity audit: ${result.uniqueIds.toLocaleString()} unique IDs, ${result.duplicateIds} duplicate, ${result.suspiciousGapCount} gap hint(s).`);
    } catch (error) {
      snackbar.show("Audit failed.", { error: true });
      log("Audit failed: " + String(error?.message || error), "error");
    } finally {
      el.runAudit.textContent = "Verify";
      el.runAudit.disabled = captureCount === 0;
    }
  });

  /* ---------------------------------------------------------------------------
     9 · Destructive reset — always behind a confirmation
     --------------------------------------------------------------------------- */

  function confirmDialog({ title, body, confirmLabel, destructive, onConfirm }) {
    $("#dialogTitle").textContent = title;
    $("#dialogContent").innerHTML = '<p class="m3e-body-medium">' + escapeHtml(body) + "</p>";

    const actions = $("#dialogActions");
    actions.innerHTML =
      '<button class="m3e-button m3e-button--text m3e-state" data-act="cancel">Cancel</button>' +
      '<button class="m3e-button m3e-button--filled m3e-state' +
      (destructive ? " m3e-button--error-filled" : "") +
      '" data-act="ok">' + escapeHtml(confirmLabel) + "</button>";

    actions.querySelector('[data-act="cancel"]').addEventListener("click", () => dialog.close());
    actions.querySelector('[data-act="ok"]').addEventListener("click", async () => {
      dialog.close();
      await onConfirm();
    });

    dialog.open();
  }

  el.resetBtn.addEventListener("click", () => {
    confirmDialog({
      title: "Clear captured data?",
      body: "This deletes every captured post from the extension's storage. Files you have already exported are untouched. This cannot be undone.",
      confirmLabel: "Clear everything",
      destructive: true,
      onConfirm: async () => {
        const tab = await activeTab();
        if (tab && tab.id) {
          try { await chrome.tabs.sendMessage(tab.id, { type: "reset" }); } catch {}
        }
        await XBookmarkStore.clear();
        await chrome.storage.local.remove(["xCaptureState", "xDeadLetters", "xCaptureSession", LAST_EXPORT_KEY]);
        currentState = null;
        captureCount = 0;
        mediaCount = 0;
        videoCount = 0;
        el.auditResult.hidden = true;
        el.auditFindings.replaceChildren();
        renderState();
        renderExportHint();
        snackbar.show("Captured data cleared.");
        log("Cleared captured data.", "warn");
      },
    });
  });

  /* ---------------------------------------------------------------------------
     10 · Live updates
     --------------------------------------------------------------------------- */

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "state") {
        currentState = msg.state;
        if (currentState?.status === "capturing" && !currentState.audit) el.auditResult.hidden = true;
        renderState();
      }
      if (msg && msg.type === "unsave-state") { usState = msg.state; renderUnsave(); }
      if (msg && msg.type === "unfollow-state") {
        ufState = msg.state;
        renderUnfollow();
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.xCaptureState) {
        currentState = changes.xCaptureState.newValue || null;
        if (currentState?.status === "capturing" && !currentState.audit) el.auditResult.hidden = true;
        renderState();
      }
      if (changes.xUnsaveState) { usState = changes.xUnsaveState.newValue || null; renderUnsave(); }
      if (changes.xUnsaveBackup) { usBackupCount = changes.xUnsaveBackup.newValue?.ids?.length || 0; renderUnsave(); }
      if (changes.xUnfollowState) {
        ufState = changes.xUnfollowState.newValue || null;
        renderUnfollow();
      }
      if (changes[UF_BACKUP_KEY]) {
        const entries = changes[UF_BACKUP_KEY].newValue?.entries;
        ufBackupCount = Array.isArray(entries) ? entries.length : 0;
        renderUnfollow();
      }
      if (changes.xBookmarkMeta) {
        const summary = XBookmarkStore.summaryFromMeta(changes.xBookmarkMeta.newValue);
        if (summary) {
          captureCount = summary.count;
          mediaCount = summary.mediaItems;
          videoCount = summary.videos;
          renderState();
          renderExportHint();
        }
      } else if (changes.xBookmarks) {
        // Backward-compatible path while a legacy array is being migrated.
        loadState();
      }
    });
  } catch {
    /* not running as an extension */
  }

  /* ---------------------------------------------------------------------------
     11 · Init
     --------------------------------------------------------------------------- */

  bindRipple(document.body);
  wireTabs();

  try {
    const manifestVersion = chrome.runtime.getManifest().version;
    el.versionBadge.textContent = `v${manifestVersion} · M3E`;
  } catch {
    el.versionBadge.textContent = "v1.4.0 · M3E";
  }

  /* The side panel stays open while the user moves between tabs, so the
     context hint (and which engine can start) must follow the active tab. */
  function followActiveTab() {
    if (chrome.tabs.onActivated) {
      chrome.tabs.onActivated.addListener(() => { renderTabHint(); });
    }
    if (chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener((_tabId, info) => {
        if (info.url || info.status === "complete") renderTabHint();
      });
    }
  }

  async function init() {
    followActiveTab();
    /* Show the skeleton only while the first storage read is in flight. */
    el.stats.classList.add("skeleton");
    await Promise.all([loadTheme(), renderTabHint(), loadState()]);
    el.stats.classList.remove("skeleton");

    /* Open on the surface that matters right now: a live engine first, then
       the X page the user is actually looking at. */
    const captureLive = currentState?.status === "capturing" || currentState?.status === "paused";
    const unfollowLive = ["running", "navigating", "paused"].includes(ufState?.status);
    if (["running", "paused", "stopped_by_error"].includes(usState?.status) && !captureLive && !unfollowLive) selectTab("unsave");
    else if (unfollowLive && !captureLive) selectTab("unfollow");
    else if (!captureLive && tabContext?.onFollowing && !tabContext?.onBookmarks) selectTab("unfollow");
    else selectTab("capture");

    log("Side panel ready.");
  }

  init();
})();