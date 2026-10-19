/* =============================================================================
   X Bookmarks Exporter · Popup
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

  const LOG_MAX = 50;
  const THEME_KEY = "bmPopupTheme";

  /* ---------------------------------------------------------------------------
     2 · DOM
     --------------------------------------------------------------------------- */

  const $ = (sel) => document.querySelector(sel);

  const el = {
    tabHint:        $("#tabHint"),
    statusCard:     $("#statusCard"),
    statusLabel:    $("#statusLabel"),
    statusDetail:   $("#statusDetail"),
    progressHost:   $("#progressHost"),
    primaryBtn:     $("#primaryBtn"),
    primaryLabel:   $("#primaryLabel"),
    primaryIcon:    $("#primaryIcon"),
    primaryLoader:  $(".m3e-button__loader"),
    pauseBtn:       $("#pauseBtn"),
    stopBtn:        $("#stopBtn"),
    panicBtn:       $("#panicBtn"),
    exportJson:     $("#exportJson"),
    exportJsonl:    $("#exportJsonl"),
    exportCsv:      $("#exportCsv"),
    exportMd:       $("#exportMd"),
    exportHtml:     $("#exportHtml"),
    exportMore:     $("#exportMore"),
    exportOverflowMenu: $("#exportOverflowMenu"),
    exportHint:     $("#exportHint"),
    appHelp:        $("#appHelp"),
    runAudit:       $("#runAudit"),
    auditResult:    $("#auditResult"),
    auditStatus:    $("#auditStatus"),
    auditMetrics:   $("#auditMetrics"),
    auditFindings:  $("#auditFindings"),
    log:            $("#log"),
    logCount:       $("#logCount"),
    versionBadge:   $("#versionBadge"),
    resetBtn:       $("#resetBtn"),
    themeToggle:    $("#themeToggle"),
    mediaHint:      $("#mediaHint"),
    stats:          $("#stats"),
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
  /* The dashboard is a media browser, so "how many posts" is no longer the
     number that tells you whether the capture is working. A run that found
     400 posts and zero photos means the media pipeline broke, and the old
     popup could not distinguish that from a good run. */
  let mediaCount = 0;
  let videoCount = 0;
  let exportOverflowOpen = false;

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

  function syncThemeToggleLabel() {
    const dark = M3ETheme.resolveDark(theme.settings);
    const schemeLabels = { system: "System", light: "Light", dark: "Dark" };
    const currentScheme = theme.settings.scheme || "system";
    el.themeToggle.setAttribute(
      "aria-label",
      `Switch color scheme (current: ${schemeLabels[currentScheme]})`
    );
    el.themeToggle.title = `Switch color scheme (current: ${schemeLabels[currentScheme]})`;
  }

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
    el.primaryBtn.classList.toggle("m3e-button--loading", isLoading);
    el.primaryBtn.setAttribute("aria-busy", String(isLoading));
    el.primaryBtn.disabled = isLoading || currentState?.status === "capturing";
    el.primaryIcon.style.display = isLoading ? "none" : "";
    el.primaryLoader.textContent = "";
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
    el.primaryBtn.disabled = running;
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
  }

  /* ---------------------------------------------------------------------------
     6 · Storage + messaging
     --------------------------------------------------------------------------- */

  async function loadState() {
    try {
      const [data, summary] = await Promise.all([
        chrome.storage.local.get({ xCaptureState: null }),
        XBookmarkStore.summary(),
      ]);
      currentState = data.xCaptureState || null;
      captureCount = summary.count;
      mediaCount = summary.mediaItems;
      videoCount = summary.videos;
    } catch (error) {
      console.warn("[popup] Could not read capture state", error);
      currentState = null;
      captureCount = 0;
      mediaCount = 0;
      videoCount = 0;
    }
    renderState();
    renderExportHint();
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

  /** Tell the user, up front, whether this popup can do anything at all. */
  async function renderTabHint() {
    const tab = await activeTab();
    const ok = tab && isBookmarksUrl(tab.url);
    if (ok) {
      el.tabHint.textContent = "Ready on x.com";
      el.tabHint.classList.remove("is-warn");
    } else {
      el.tabHint.textContent = "Open x.com/i/bookmarks to capture";
      el.tabHint.classList.add("is-warn");
    }
    el.primaryBtn.dataset.ready = String(!!ok);
    return ok;
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
      log("Couldn't start: " + (res.reason || "unknown"), "error");
      snackbar.show(res.reason || "Couldn't start capture.", { error: true });
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

  // Export overflow menu toggle
  el.exportMore.addEventListener("click", (e) => {
    e.stopPropagation();
    exportOverflowOpen = !exportOverflowOpen;
    el.exportOverflowMenu.hidden = !exportOverflowOpen;
    el.exportOverflowMenu.toggleAttribute("open", exportOverflowOpen);
    el.exportMore.setAttribute("aria-expanded", String(exportOverflowOpen));
  });

  // Close overflow menu on outside click
  document.addEventListener("click", () => {
    if (exportOverflowOpen) {
      exportOverflowOpen = false;
      el.exportOverflowMenu.hidden = true;
      el.exportOverflowMenu.removeAttribute("open");
      el.exportMore.setAttribute("aria-expanded", "false");
    }
  });

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
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.xCaptureState) {
        currentState = changes.xCaptureState.newValue || null;
        if (currentState?.status === "capturing" && !currentState.audit) el.auditResult.hidden = true;
        renderState();
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

  try {
    const manifestVersion = chrome.runtime.getManifest().version;
    el.versionBadge.textContent = `v${manifestVersion} · M3E`;
  } catch {
    el.versionBadge.textContent = "v1.1.0 · M3E";
  }

  loadTheme();
  renderTabHint();

  // Show skeleton loading state while first load completes
  el.stats.classList.add("skeleton");
  loadState().then(() => {
    el.stats.classList.remove("skeleton");
  });

  log("Popup ready.");
})();