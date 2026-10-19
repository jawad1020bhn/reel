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
    capturing:        { label: "Capturing",     detail: "Scrolling slowly and deliberately — accuracy over speed." },
    paused:           { label: "Paused",        detail: "Manual scrolling is still captured." },
    completed:        { label: "Completed",     detail: "All available bookmarks captured." },
    stopped_by_user:  { label: "Stopped",       detail: "You stopped this run." },
    stopped_by_error: { label: "Stopped",       detail: "The run ended on an error." },
  };

  const REASONS = {
    "end-of-feed": "Reached the end of the feed — every page answered empty.",
    "incremental-complete": "Incremental pass complete — no new bookmarks.",
    "max-runtime": "Hit the safety time limit.",
    "max-batches": "Hit the safety scroll limit — start again to continue from here.",
    "no-responses-seen": "No timeline responses were intercepted. The page may stream over a transport this tool can't see.",
    "schema-mismatch": "Responses arrived but no posts could be read — X changed the response shape.",
    "too-many-errors": "Too many consecutive failures.",
    "rate-limited": "Rate limited by X. Wait a few minutes before retrying.",
    "auth-error": "Authentication problem — check you're signed in on x.com.",
    "max-backoff-retries": "Max retries reached after rate limits. Try again later.",
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
    openDashboard:  $("#openDashboard"),
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
  const ICON_LOADER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" stroke-dasharray="31.4 31.4" stroke-dashoffset="31.4"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></svg>';

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

  function setStat(key, value) {
    const slot = stats[key];
    if (!slot || !slot.el) return;
    const next = String(value);
    const prev = Number(slot.el.textContent) || 0;
    const nextNum = Number(value) || 0;

    // Emphasis must be correct on first paint too, so set it before the
    // early-out that skips the animation for unchanged values.
    if (slot.box) slot.box.dataset.nonzero = String(nextNum > 0);

    if (slot.el.textContent === next) return;

    // Count-up animation for increasing numbers
    if (nextNum > prev && prev >= 0) {
      animateCountUp(slot.el, prev, nextNum);
    } else {
      slot.el.textContent = next;
    }
    // A number that changed should be *seen* to change. Expressive motion,
    // applied at the smallest possible scale.
    pulse(slot.el);
  }

  function animateCountUp(el, start, end, duration = 500) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = end.toLocaleString();
      return;
    }
    const startTime = performance.now();
    const step = (now) => {
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
    el.primaryBtn.disabled = isLoading;
    if (isLoading) {
      el.primaryLoader.innerHTML = ICON_LOADER;
      el.primaryIcon.style.display = "none";
    } else {
      el.primaryLoader.innerHTML = "";
      el.primaryIcon.style.display = "";
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
    if (running) {
      // Live progress: "Scroll batch 12/400 • 2.3k posts • 847 new • 12 videos • 45/min • ~12min left"
      const scrollBatches = st.scrollBatches || 0;
      const maxBatches = st.maxScrollBatches || 400;
      const captured = st.captured || 0;
      const newItems = st.newItems || 0;
      const postsPerMin = st.postsPerMin || 0;
      const etaMinutes = st.etaMinutes;
      const parts = [];
      if (scrollBatches > 0) parts.push(`Batch ${scrollBatches}/${maxBatches}`);
      if (captured > 0) parts.push(`${captured.toLocaleString()} posts`);
      if (newItems > 0) parts.push(`${newItems.toLocaleString()} new`);
      if (videoCount > 0) parts.push(`${videoCount.toLocaleString()} videos`);
      if (postsPerMin > 0) parts.push(`${postsPerMin}/min`);
      if (etaMinutes != null && etaMinutes > 0) parts.push(`~${etaMinutes}min left`);
      detail = parts.join(" · ");
    } else if (paused && s.lastStopReason?.startsWith("backoff-")) {
      // Rate limit backoff with countdown: "backoff-429 (attempt 3/10, 45s)"
      const match = s.lastStopReason.match(/backoff-(\d+)\s+\(attempt\s+(\d+)\/(\d+),\s+(\d+)s\)/);
      if (match) {
        const [, httpStatus, attempt, maxAttempts, seconds] = match;
        detail = `Rate limited (HTTP ${httpStatus}) — retry ${attempt}/${maxAttempts} in ${seconds}s`;
        el.statusCard.dataset.status = "rate-limited"; // Special styling
      } else {
        detail = s.lastStopReason;
      }
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
  }

  /* ---------------------------------------------------------------------------
     6 · Storage + messaging
     --------------------------------------------------------------------------- */

  async function loadState() {
    try {
      const { xCaptureState = null, xBookmarks = [] } =
        await chrome.storage.local.get({ xCaptureState: null, xBookmarks: [] });
      currentState = xCaptureState;
      captureCount = xBookmarks.length;

      let media = 0, video = 0;
      for (const b of xBookmarks) {
        const items = (b && b.media_items) || [];
        media += items.length;
        for (const m of items) {
          if (m && (m.type === "video" || m.type === "animated_gif")) video++;
        }
      }
      mediaCount = media;
      videoCount = video;
    } catch {
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

  /** Tell the user, up front, whether this popup can do anything at all. */
  async function renderTabHint() {
    const tab = await activeTab();
    const ok = tab && tab.url && /^https:\/\/x\.com\//.test(tab.url);
    if (ok) {
      el.tabHint.textContent = "Ready on x.com";
      el.tabHint.classList.remove("is-warn");
    } else {
      el.tabHint.textContent = "Open x.com/i/history to capture";
      el.tabHint.classList.add("is-warn");
    }
    el.primaryBtn.dataset.ready = String(!!ok);
    return ok;
  }

  async function send(type) {
    const tab = await activeTab();
    if (!tab || !tab.url || !/^https:\/\/x\.com\//.test(tab.url)) {
      snackbar.show("Open https://x.com/i/history in the active tab first.", { error: true });
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

  wireControl(el.primaryBtn, "start", {
    ok: (res) => {
      log(res.resumed ? "Capture resumed." : "Capture started.");
      setPrimaryLoading(false);
    },
    fail: (res) => {
      setPrimaryLoading(false);
      if (res.reason === "already-running") log("Capture is already running.", "warn");
      else log("Couldn't start: " + (res.reason || "unknown"), "error");
    },
  });

  // Override primary button click to add loading state
  el.primaryBtn.addEventListener("click", async () => {
    const res = await send("start");
    if (!res) return;
    if (res.ok) {
      log(res.resumed ? "Capture resumed." : "Capture started.");
    } else if (res.reason === "already-running") {
      log("Capture is already running.", "warn");
    } else {
      log("Couldn't start: " + (res.reason || "unknown"), "error");
    }
    setPrimaryLoading(false);
    setTimeout(loadState, 500);
  }, { once: false }); // We handle the click directly now

  // Remove the wireControl for primaryBtn since we handle it manually
  el.primaryBtn.onclick = null;

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
    const { xBookmarks = [] } = await chrome.storage.local.get({ xBookmarks: [] });
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
      bookmarks: items
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
      default: // json
        return JSON.stringify(exportMeta, null, 2);
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
        if (m.type === "photo") return `<img src="${m.url}" alt="${escapeHtml(m.alt || "")}" />`;
        if (m.type === "video") return `<video src="${m.mp4}" poster="${m.poster}" controls></video>`;
        return "";
      }).join("");
      const linksHtml = (b.urls_expanded || []).map((u) => `<a href="${u}" target="_blank">${u}</a>`).join(" ");
      return `
        <article class="post">
          <header class="post-header">
            <img class="avatar" src="${b.author_profile_image_url || ""}" alt="" />
            <div>
              <strong>@${escapeHtml(b.author_username || "unknown")}</strong>
              <span class="meta">${escapeHtml(b.author_name || "")} · ${escapeHtml(b.tweet_created_at || "")}</span>
            </div>
          </header>
          <div class="text">${escapeHtml(b.text || "")}</div>
          ${mediaHtml ? `<div class="media">${mediaHtml}</div>` : ""}
          ${linksHtml ? `<div class="links">${linksHtml}</div>` : ""}
          <footer><a href="${b.tweet_url}" target="_blank">View on X</a></footer>
        </article>
      `;
    }).join("");
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>X Bookmarks Export</title><style>${css}</style></head><body>${postsHtml}</body></html>`;
  }

  async function runExport(format, filename, incremental = false) {
    const content = await buildExport(format, incremental);
    if (content === null) return;
    const mime = format === "html" ? "text/html" : format === "csv" ? "text/csv" : format === "md" ? "text/markdown" : "application/json";
    try {
      await chrome.downloads.download({
        url: `data:${mime};charset=utf-8,` + encodeURIComponent(content),
        filename,
        saveAs: true,
      });
      await setLastExportTime(Date.now());
      snackbar.show("Exported " + filename + (incremental ? " (incremental)" : ""));
      log("Downloaded " + filename + (incremental ? " [incremental]" : "") + ".");
    } catch (e) {
      snackbar.show("Export failed.", { error: true });
      log("Export failed: " + e.message, "error");
    }
  }

  // Event listeners for all export formats
  el.exportJson.addEventListener("click", () => runExport("json", "x-bookmarks.json"));
  el.exportJsonl.addEventListener("click", () => runExport("jsonl", "x-bookmarks.jsonl"));
  el.exportCsv.addEventListener("click", () => runExport("csv", "x-bookmarks.csv"));
  el.exportMd.addEventListener("click", () => runExport("md", "x-bookmarks.md"));
  el.exportHtml.addEventListener("click", () => runExport("html", "x-bookmarks.html"));

  // Incremental export (Shift+click on any export button)
  const exportButtons = [el.exportJson, el.exportJsonl, el.exportCsv, el.exportMd, el.exportHtml];
  for (const btn of exportButtons) {
    btn.addEventListener("click", (e) => {
      if (e.shiftKey) {
        const format = btn.id.replace("export", "").toLowerCase();
        const ext = format === "json" ? "json" : format;
        runExport(format, `x-bookmarks-incremental.${ext}`, true);
      }
    });
  }

  // Export overflow menu toggle
  el.exportMore.addEventListener("click", (e) => {
    e.stopPropagation();
    exportOverflowOpen = !exportOverflowOpen;
    el.exportOverflowMenu.hidden = !exportOverflowOpen;
    el.exportMore.setAttribute("aria-expanded", exportOverflowOpen);
  });

  // Close overflow menu on outside click
  document.addEventListener("click", () => {
    if (exportOverflowOpen) {
      exportOverflowOpen = false;
      el.exportOverflowMenu.hidden = true;
      el.exportMore.setAttribute("aria-expanded", "false");
    }
  });

  /* Open the library as an extension page, reusing an existing tab rather than
     stacking a duplicate every time the button is pressed.

     Finding that tab uses `runtime.getContexts`, NOT `tabs.query({url})`.
     Filtering a tab query by URL requires the "tabs" permission, which Chrome
     surfaces at install time as "read your browsing history" — an absurd ask
     for a tool whose entire pitch is that your data stays local, and one this
     feature does not otherwise need. `getContexts` only ever reports the
     extension's own pages, so it needs no permission at all. */
  el.openDashboard.addEventListener("click", async () => {
    const url = chrome.runtime.getURL("dashboard/index.html");

    try {
      if (chrome.runtime.getContexts) {
        const [existing] = await chrome.runtime.getContexts({
          contextTypes: ["TAB"],
          documentUrls: [url],
        });
        if (existing && existing.tabId != null) {
          await chrome.tabs.update(existing.tabId, { active: true });
          if (chrome.windows && existing.windowId != null) {
            await chrome.windows.update(existing.windowId, { focused: true });
          }
          window.close();
          return;
        }
      }
    } catch (_) {
      // getContexts is Chrome 116+. On anything older, just open a new tab.
    }

    await chrome.tabs.create({ url });
    window.close();
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
        await chrome.storage.local.remove(["xBookmarks", "xCaptureState", "xDeadLetters"]);
        currentState = null;
        captureCount = 0;
        mediaCount = 0;
        videoCount = 0;
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
        renderState();
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.xCaptureState) {
        currentState = changes.xCaptureState.newValue || null;
        renderState();
      }
      if (changes.xBookmarks) {
        const list = changes.xBookmarks.newValue || [];
        captureCount = list.length;
        let media = 0, video = 0;
        for (const b of list) {
          const items = (b && b.media_items) || [];
          media += items.length;
          for (const m of items) {
            if (m && (m.type === "video" || m.type === "animated_gif")) video++;
          }
        }
        mediaCount = media;
        videoCount = video;
        renderState();
        renderExportHint();
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
    el.versionBadge.textContent = "v0.1.0 · M3E";
  }

  loadTheme();
  renderTabHint();

  // Show skeleton loading state while first load completes
  el.stats.classList.add("skeleton");
  loadState().then(() => {
    el.stats.classList.remove("skeleton");
  });

  // Set primary button loading state on start
  const originalSend = send;
  window.send = async (type) => {
    if (type === "start") {
      setPrimaryLoading(true);
    }
    return originalSend(type);
  };

  log("Popup ready.");
})();