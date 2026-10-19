/*
 * Unfollow engine · isolated world.
 *
 * "Unfollow everyone" as a first-class, resumable run — the same architecture
 * that makes the bookmark capture trustworthy, applied to writes:
 *
 *   - Discovery rides the authenticated Following timeline via the page hook
 *     (no scraping of DOM rows, no brittle selectors, exact IDs).
 *   - Execution is single-flight through the MAIN-world bridge: one request
 *     in the air at a time, exactly as a person clicking would produce.
 *   - Pacing is closed-loop: warm-up ramp, ±35% jitter, irregular wave
 *     breaks, and a rolling-window governor that stretches delays whenever
 *     the measured rate crosses the ceiling (XPacing).
 *   - Failures degrade instead of hammering: 429 → full-jitter exponential
 *     backoff, 5xx/network → consecutive-error breaker, 401/403 → hard stop,
 *     stale queryId → drop the hint and re-route through the bridge fallback.
 *   - Sessions persist queue + done-set + counters, so closing the tab mid
 *     run loses nothing; a run-cap forces a natural human-sized break between
 *     resumptions instead of grinding thousands back-to-back.
 *   - A local JSON backup of every targeted account is maintained for
 *     re-following later; the popup exports it.
 *
 * Pure decisions (parsing, pacing, classification) live in following.js and
 * pacing.js and are unit-tested in tests/.
 */
const UF = (() => {
  "use strict";

  const STATE_KEY = "xUnfollowState";
  const SESSION_KEY = "xUnfollowSession";
  const BACKUP_KEY = "xUnfollowBackup";
  const QUERY_ID_HINT_KEY = "xUnfollowQueryId";
  const CAPTURE_STATE_KEY = "xCaptureState";

  const BRIDGE_IN = "x-unfollow-bridge";
  const BRIDGE_OUT = "x-unfollow-bridge-result";

  const config = {
    /* Discovery sweep — tuning identical to the capture fast-lane so the
       whole extension feels like one driver. */
    fastStepDelayMs: 42,
    nearBottomStepDelayMs: 95,
    fastStepViewports: 1.2,
    nearBottomStepViewports: 0.58,
    responseWaitMs: 1450,
    maxScrollStepsPerPass: 800,
    maxPassDurationMs: 20000,
    emptyScrollStop: 4,

    /* Run guards */
    maxRuntimeMs: 3 * 60 * 60 * 1000,   // per Start/Resume invocation
    maxRunCount: 2500,                  // attempts per invocation → forced break
    maxConsecutiveErrors: 5,
    sessionPersistMs: 30000,
    sessionMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
    navigatingMaxAgeMs: 90 * 1000,
    bridgeTimeoutMs: 45000,
    pendingCacheLimit: 10000,
    backupLimit: 100000,
    backupFlushEvery: 25,

    /* Human pacing — see pacing.js. ~26/min ceiling with waves ≈ low-20s per
       minute steady state; warm-up starts slower still. */
    pacing: {
      baseDelayMs: 2400,
      jitterRatio: 0.35,
      warmupCount: 6,
      warmupFactor: 1.7,
      waveMin: 7,
      waveMax: 14,
      waveBreakMinMs: 7000,
      waveBreakMaxMs: 22000,
      rateCeilingPerMin: 26,
    },
  };

  const isFollowingRoute = () => /^\/[^/]+\/following\/?$/.test(location.pathname);
  const isXHost = () => /^https?:\/\/(?:www\.)?x\.com$/i.test(location.origin);

  const defaultStats = () => ({
    discovered: 0,
    pending: 0,
    unfollowed: 0,
    already: 0,
    notFound: 0,
    staleSkipped: 0,
    failed: 0,
    errors: 0,
    rateLimits: 0,
    authErrors: 0,
    responses: 0,
    pages: 0,
    scrollBatches: 0,
    perMin: 0,
    runCount: 0,
    cap: config.maxRunCount,
    backup: 0,
  });

  /* ------------------------------------------------------------------ *
   * State + session persistence (same write-serialization pattern as
   * content.js so concurrent bumps cannot clobber each other).
   * ------------------------------------------------------------------ */

  let stateWriteQueue = Promise.resolve();

  async function getState() {
    const data = await chrome.storage.local.get(STATE_KEY);
    return data[STATE_KEY] || {
      status: "idle",
      startedAt: null,
      updatedAt: null,
      lastStopReason: null,
      stats: defaultStats(),
    };
  }

  function setState(patch) {
    const write = stateWriteQueue.then(async () => {
      const current = await getState();
      const resolved = typeof patch === "function" ? patch(current) : patch;
      const next = {
        ...current,
        ...resolved,
        stats: { ...(current.stats || {}), ...(resolved?.stats || {}) },
        updatedAt: new Date().toISOString(),
      };
      await chrome.storage.local.set({ [STATE_KEY]: next });
      try { chrome.runtime.sendMessage({ type: "unfollow-state", state: next }).catch(() => {}); }
      catch { /* popup closed */ }
      return next;
    });
    stateWriteQueue = write.catch((error) => {
      console.warn("[x-unfollow] state write failed", error);
    });
    return write;
  }

  async function loadBackup() {
    try {
      const data = await chrome.storage.local.get(BACKUP_KEY);
      const backup = data[BACKUP_KEY];
      if (backup && backup.version === 1 && Array.isArray(backup.entries)) return backup;
    } catch { /* start fresh */ }
    return { version: 1, updatedAt: null, entries: [] };
  }

  async function saveBackup(backup) {
    backup.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ [BACKUP_KEY]: backup });
  }

  function backupEntryFor(user) {
    return {
      user_id: user.user_id,
      screen_name: user.screen_name || null,
      name: user.name || null,
      profile_image_url: user.profile_image_url_https || null,
      discovered_at: new Date().toISOString(),
      unfollowed_at: null,
      outcome: null,
    };
  }

  /* ------------------------------------------------------------------ *
   * Bridge RPC
   * ------------------------------------------------------------------ */

  let bridgeSeq = 0;
  const bridgePending = new Map();

  function callBridge(payload, timeoutMs = config.bridgeTimeoutMs) {
    return new Promise((resolve) => {
      const id = ++bridgeSeq;
      const timer = setTimeout(() => {
        bridgePending.delete(id);
        resolve({ ok: false, outcome: "network-error", status: 0, detail: "bridge-timeout" });
      }, timeoutMs);
      bridgePending.set(id, (data) => {
        clearTimeout(timer);
        bridgePending.delete(id);
        resolve(data);
      });
      try {
        window.postMessage({ source: BRIDGE_IN, id, ...payload }, "*");
      } catch {
        clearTimeout(timer);
        bridgePending.delete(id);
        resolve({ ok: false, outcome: "network-error", status: 0, detail: "post-failed" });
      }
    });
  }

  async function pingBridge() {
    const reply = await callBridge({ type: "ping" }, 5000);
    return reply && reply.ok ? reply : null;
  }

  /* ------------------------------------------------------------------ *
   * Response intake (page hook → engine)
   * ------------------------------------------------------------------ */

  const pendingUsers = new Map();
  const pendingStats = { responses: 0, pages: 0, users: 0, dropped: 0, ignored: 0 };

  function acceptFollowingPage(page) {
    if (!page.recognized) return false;
    // A profile *tweets* timeline shares the shape; never ingest it.
    if (page.tweetEntryCount > 0 && page.userEntryCount === 0) return false;
    return true;
  }

  function ingestUsers(target, page) {
    let added = 0;
    for (const user of page.users) {
      if (!user.user_id) continue;
      if (user.following === false) {
        // X affirmatively says "not followed" — a stale row, never a target.
        if (target !== pendingUsers && target.stats) target.stats.staleSkipped++;
        pendingStats.ignored++;
        continue;
      }
      if (target !== pendingUsers) {
        if (target.doneIds.has(user.user_id) || target.queuedIds.has(user.user_id)) continue;
        target.queue.push(user);
        target.queuedIds.add(user.user_id);
        registerBackup(target, user);
        added++;
        continue;
      }
      if (target.has(user.user_id)) continue;
      target.set(user.user_id, user);
      added++;
    }
    return added;
  }

  function registerBackup(target, user) {
    if (!target.backup || target.backupById.has(user.user_id)) return;
    if (target.backup.entries.length >= config.backupLimit) return;
    target.backupById.set(user.user_id, target.backup.entries.length);
    target.backup.entries.push(backupEntryFor(user));
    target.backupDirty++;
  }

  function handleTimelinePayload(payload) {
    if (!payload || payload.ok === false) return;
    const page = XFollowingTimeline.extractPage(payload.json);
    if (!acceptFollowingPage(page)) return;

    pendingStats.responses++;
    if (page.users.length) pendingStats.pages++;

    if (run) {
      run.counters.responses++;
      if (page.users.length) run.counters.pages++;
      const added = ingestUsers(run, page);
      if (added) {
        run.activityVersion++;
        run.lastActivityAt = Date.now();
      }
      // Any accepted response ends the pagination wait early — same wake
      // discipline as the capture loop.
      wakeRun(run);
      run.stats.discovered = run.queuedIds.size + run.doneIds.size;
      run.stats.pending = run.queue.length;
      return;
    }

    ingestUsers(pendingUsers, page);
    pendingStats.users = pendingUsers.size;
    while (pendingUsers.size > config.pendingCacheLimit) {
      const oldest = pendingUsers.keys().next().value;
      pendingUsers.delete(oldest);
      pendingStats.dropped++;
    }
  }

  /* ------------------------------------------------------------------ *
   * Run lifecycle
   * ------------------------------------------------------------------ */

  let run = null;

  /* Per-tab ownership heartbeat. sessionStorage survives reloads and
     navigations within THIS tab but is invisible to other tabs — exactly
     the scope needed to tell "my run died mid-navigation" apart from
     "another window owns this session". */
  const OWNER_KEY = "xUnfollowOwner";
  function touchOwner() {
    try { sessionStorage.setItem(OWNER_KEY, String(Date.now())); } catch { /* private mode */ }
  }
  function tabOwnsRun(maxAgeMs = 90000) {
    try {
      const stamp = Number(sessionStorage.getItem(OWNER_KEY)) || 0;
      return stamp > 0 && Date.now() - stamp <= maxAgeMs;
    } catch {
      return false;
    }
  }

  function wakeRun(target) {
    if (!target?.waiters) return;
    for (const wake of [...target.waiters]) wake();
  }

  function waitRun(target, ms) {
    if (!target || target.stop || target.pause || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        target.waiters?.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      if (!target.waiters) target.waiters = new Set();
      target.waiters.add(finish);
    });
  }

  function createRun(saved = {}) {
    const stats = { ...defaultStats(), ...(saved.stats || {}) };
    const target = {
      stop: false,
      pause: false,
      startedAt: saved.navOnly ? Date.now() : (Number(saved.startedAt) || Date.now()),
      freshStart: !saved.navOnly && !saved.resumed,
      queue: Array.isArray(saved.queue) ? saved.queue.slice() : [],
      queuedIds: new Set(),
      doneIds: new Set(Array.isArray(saved.doneIds) ? saved.doneIds : []),
      stats,
      counters: {
        consecutiveErrors: Number(saved.counters?.consecutiveErrors) || 0,
        stableEmpty: Number(saved.counters?.stableEmpty) || 0,
        scrollBatches: Number(saved.counters?.scrollBatches) || 0,
        runCount: Number(saved.counters?.runCount) || 0,
        responses: Number(saved.counters?.responses) || 0,
        pages: Number(saved.counters?.pages) || 0,
        sinceBackupFlush: Number(saved.counters?.sinceBackupFlush) || 0,
        reason: saved.counters?.reason || null,
      },
      backoff: {
        retries: Number(saved.backoff?.retries) || 0,
        until: Number(saved.backoff?.until) || 0,
      },
      trip: saved.trip || null,
      backup: null,
      backupById: new Map(),
      backupDirty: 0,
      queryIdHint: null,
      pacer: null,
      governor: null,
      activityVersion: 0,
      lastActivityAt: 0,
      waiters: new Set(),
      lastSessionSave: Date.now(),
      loopPromise: null,
    };
    for (const user of target.queue) target.queuedIds.add(user.user_id);
    target.stats.pending = target.queue.length;
    return target;
  }

  async function saveSession(target) {
    if (!target) {
      await chrome.storage.local.remove(SESSION_KEY);
      return;
    }
    await chrome.storage.local.set({
      [SESSION_KEY]: {
        version: 1,
        savedAt: Date.now(),
        startedAt: target.startedAt,
        queue: target.queue,
        doneIds: [...target.doneIds],
        stats: target.stats,
        counters: target.counters,
        backoff: target.backoff,
        trip: target.trip,
        paused: target.pause,
        stopped: target.stop,
      },
    });
  }

  async function loadSession() {
    const data = await chrome.storage.local.get(SESSION_KEY);
    const session = data[SESSION_KEY];
    if (!session || session.version !== 1) return null;
    if (Date.now() - Number(session.savedAt || 0) > config.sessionMaxAgeMs) {
      await chrome.storage.local.remove(SESSION_KEY);
      return null;
    }
    return session;
  }

  async function clearSession() {
    await chrome.storage.local.remove(SESSION_KEY);
  }

  function tripRun(target, reason, status = "stopped_by_error") {
    target.trip = { reason, status };
    target.stop = true;
    wakeRun(target);
  }

  async function applyBackoff(target, kind) {
    const schedule = XPacing.computeBackoff(target.backoff.retries, { rng: Math.random });
    if (!schedule.retry) {
      tripRun(target, "max-backoff-retries");
      return 0;
    }
    target.backoff.until = Date.now() + schedule.delayMs;
    await setState({
      status: "running",
      lastStopReason: `backoff-${kind} (attempt ${schedule.attempt}/${schedule.maxRetries}, ${Math.ceil(schedule.delayMs / 1000)}s)`,
    });
    while (!target.stop && !target.pause && Date.now() < target.backoff.until) {
      await waitRun(target, Math.min(target.backoff.until - Date.now(), 1000));
    }
    if (!target.stop && !target.pause) {
      target.backoff.until = 0;
      await setState({ status: "running", lastStopReason: null });
    }
    return schedule.delayMs;
  }

  async function waitForBackoff(target) {
    while (!target.stop && !target.pause && target.backoff.until && Date.now() < target.backoff.until) {
      await waitRun(target, Math.min(target.backoff.until - Date.now(), 1000));
    }
    if (!target.stop && !target.pause && target.backoff.until) {
      target.backoff.until = 0;
      await setState({ status: "running", lastStopReason: null });
    }
  }

  /* ------------------------------------------------------------------ *
   * One unfollow attempt
   * ------------------------------------------------------------------ */

  function syncStats(target) {
    target.stats.pending = target.queue.length;
    target.stats.runCount = target.counters.runCount;
    target.stats.scrollBatches = target.counters.scrollBatches;
    if (target.governor) target.stats.perMin = Math.round(target.governor.rate());
    target.stats.backup = target.backup ? target.backup.entries.length : target.stats.backup;
    return target.stats;
  }

  async function pushState(target, extra = {}) {
    await setState({ ...extra, stats: { ...syncStats(target) } });
  }

  function markBackup(target, userId, outcome) {
    const index = target.backupById.get(userId);
    if (index == null || !target.backup) return;
    const entry = target.backup.entries[index];
    if (!entry) return;
    entry.unfollowed_at = new Date().toISOString();
    entry.outcome = outcome;
    target.backupDirty++;
  }

  async function executeOne(target, user) {
    target.counters.runCount++;
    const reply = await callBridge({
      type: "exec",
      userId: user.user_id,
      queryId: target.queryIdHint || undefined,
    });

    if (target.governor) target.governor.record();

    const classified = reply && reply.ok !== undefined && reply.status !== undefined && !reply.outcome
      ? XPacing.classifyOutcome(reply.status, reply.body, reply.raw, reply.transport)
      : { outcome: reply?.outcome || "network-error", detail: reply?.detail };

    const outcome = classified.outcome;
    const resolveSuccess = () => {
      target.counters.consecutiveErrors = 0;
      target.backoff.retries = 0;
      target.queue.shift();
      target.queuedIds.delete(user.user_id);
      target.doneIds.add(user.user_id);
    };

    switch (outcome) {
      case "ok":
        target.stats.unfollowed++;
        resolveSuccess();
        markBackup(target, user.user_id, "unfollowed");
        break;

      case "already":
        target.stats.already++;
        resolveSuccess();
        markBackup(target, user.user_id, "already");
        break;

      case "not-found":
        target.stats.notFound++;
        resolveSuccess();
        markBackup(target, user.user_id, "not-found");
        break;

      case "rate-limited":
        /* Rate limits ride the backoff schedule alone (capture parity):
           they are X saying "slow down", not a defect in the run. */
        target.stats.rateLimits++;
        target.backoff.retries++;
        await applyBackoff(target, "rate-limited");
        break;

      case "auth-error":
        target.stats.authErrors++;
        tripRun(target, "auth-error");
        break;

      case "server-error":
        target.stats.errors++;
        target.backoff.retries++;
        await applyBackoff(target, "server");
        break;

      case "network-error":
        target.stats.errors++;
        target.backoff.retries++;
        target.counters.consecutiveErrors++;
        if (target.counters.consecutiveErrors >= config.maxConsecutiveErrors) {
          tripRun(target, "too-many-errors");
        } else {
          await applyBackoff(target, "network");
        }
        break;

      case "stale-queryid":
        /* The rolling operation ID moved. Drop the hint, tell the bridge to
           forget its own cached ID too (bundle/observed copies may be just
           as stale), and requeue the account — never mark a user done on a
           transport miss. */
        target.queryIdHint = null;
        try { await chrome.storage.local.remove(QUERY_ID_HINT_KEY); } catch { /* optional */ }
        callBridge({ type: "forget" });
        target.counters.consecutiveErrors++;
        if (target.counters.consecutiveErrors >= config.maxConsecutiveErrors) {
          tripRun(target, "too-many-errors");
        }
        break;

      case "auth-unavailable":
        tripRun(target, "auth-unavailable");
        break;

      case "bad-request":
      default:
        target.stats.failed++;
        markBackup(target, user.user_id, outcome);
        target.queue.shift();
        target.queuedIds.delete(user.user_id);
        target.doneIds.add(user.user_id);
        target.counters.consecutiveErrors++;
        if (target.counters.consecutiveErrors >= config.maxConsecutiveErrors) {
          tripRun(target, "too-many-errors");
        }
        break;
    }

    if (target.pacer) target.pacer.onAction();
    return outcome;
  }

  /* ------------------------------------------------------------------ *
   * Discovery sweep (adaptive fast-lane scroll, capture parity)
   * ------------------------------------------------------------------ */

  function scrollMetrics() {
    const root = document.scrollingElement || document.documentElement || document.body;
    const height = Math.max(
      Number(root?.scrollHeight) || 0,
      Number(document.body?.scrollHeight) || 0,
      Number(document.documentElement?.scrollHeight) || 0,
    );
    const viewport = Math.max(1, Number(window.innerHeight) || Number(document.documentElement?.clientHeight) || 800);
    const y = Math.max(Number(window.scrollY) || 0, Number(root?.scrollTop) || 0);
    return { height, viewport, y, bottom: Math.max(0, height - viewport) };
  }

  async function scrollToBottomAdaptive(target) {
    const started = Date.now();
    let steps = 0;
    while (!target.stop && !target.pause &&
      steps < config.maxScrollStepsPerPass && Date.now() - started < config.maxPassDurationMs) {
      if (target.backoff.until && Date.now() < target.backoff.until) {
        await waitForBackoff(target);
        continue;
      }
      const { viewport, y, bottom } = scrollMetrics();
      const remaining = bottom - y;
      if (remaining <= 5) break;

      const nearBottom = remaining <= viewport * 2.25;
      const multiplier = nearBottom ? config.nearBottomStepViewports : config.fastStepViewports;
      const step = Math.min(remaining, Math.max(300, Math.round(viewport * multiplier)));
      window.scrollTo(0, y + step);
      steps++;
      await waitRun(target, nearBottom ? config.nearBottomStepDelayMs : config.fastStepDelayMs);
    }
    const { y, bottom } = scrollMetrics();
    return { steps, reachedBottom: bottom - y <= 5 };
  }

  /* ------------------------------------------------------------------ *
   * Main loop
   * ------------------------------------------------------------------ */

  async function persistIfDue(target, force = false) {
    if (force || Date.now() - target.lastSessionSave >= config.sessionPersistMs) {
      target.lastSessionSave = Date.now();
      await saveSession(target);
      if (target.backup && target.backupDirty > 0) {
        target.backupDirty = 0;
        try { await saveBackup(target.backup); } catch (error) { console.warn("[x-unfollow] backup save failed", error); }
      }
    }
  }

  async function runUnfollowLoop(target) {
    const persistTimer = setInterval(() => {
      if (run !== target || target.stop || target.pause) return;
      touchOwner();
      persistIfDue(target).catch(() => {});
    }, config.sessionPersistMs);

    try {
      if (target.freshStart && !target.stop && !target.pause) {
        window.scrollTo(0, 0);
        await waitRun(target, 150);
      }

      while (!target.stop && !target.pause) {
        if (Date.now() - target.startedAt > config.maxRuntimeMs) {
          target.counters.reason = "max-runtime";
          break;
        }
        if (target.counters.runCount >= config.maxRunCount) {
          // A deliberate, resumable checkpoint: thousands of back-to-back
          // unfollows in one sitting is exactly what looks inhuman.
          target.pause = true;
          target.counters.reason = "run-cap";
          break;
        }
        if (target.backoff.until && Date.now() < target.backoff.until) {
          await waitForBackoff(target);
          continue;
        }

        if (target.queue.length) {
          const user = target.queue[0];
          if (!user || target.doneIds.has(user.user_id)) {
            target.queue.shift();
            if (user) target.queuedIds.delete(user.user_id);
            continue;
          }

          const plan = target.pacer.next();
          if (plan.kind === "wave-break") {
            await pushState(target, {
              status: "running",
              lastStopReason: `wave-break (${Math.round(plan.delayMs / 1000)}s pause)`,
            });
          }
          await waitRun(target, plan.delayMs);
          if (target.stop || target.pause) break;

          const outcome = await executeOne(target, user);
          await pushState(target, {
            status: "running",
            lastStopReason: target.trip?.reason || null,
          });
          await persistIfDue(target);

          if (target.trip) break;
          if (outcome === "rate-limited" || outcome === "server-error" || outcome === "network-error") {
            continue; // backoff applied inside executeOne
          }
          continue;
        }

        /* Queue drained → sweep for the next page of the Following list. */
        const activityBefore = target.activityVersion;
        const heightBefore = scrollMetrics().height;
        const scrollResult = await scrollToBottomAdaptive(target);
        if (target.stop || target.pause) break;
        target.counters.scrollBatches++;

        if (!scrollResult.reachedBottom) {
          target.counters.stableEmpty = 0;
          await pushState(target, { status: "running" });
          continue;
        }

        await waitRun(target, config.responseWaitMs);
        const heightAfter = scrollMetrics().height;
        const grew = heightAfter - heightBefore > scrollMetrics().viewport * 1.25;
        const progressed = target.activityVersion > activityBefore || grew;
        if (progressed) target.counters.stableEmpty = 0;
        else target.counters.stableEmpty++;

        await pushState(target, { status: "running" });

        if (target.counters.stableEmpty >= config.emptyScrollStop && !target.queue.length) {
          target.counters.reason = target.counters.responses ? "end-of-list" : "no-responses-seen";
          break;
        }
      }

      await persistIfDue(target, true);
    } catch (error) {
      console.error("[x-unfollow] run loop failed", error);
      target.counters.reason = target.counters.reason || "run-error";
      tripRun(target, "run-error");
      try { await persistIfDue(target, true); } catch { /* storage may be down */ }
    } finally {
      clearInterval(persistTimer);
    }

    /* Finalize */
    const wasPaused = target.pause;
    const trip = target.trip;
    let status;
    let reason = target.counters.reason;
    if (wasPaused) status = "paused";
    else if (trip) { status = trip.status || "stopped_by_error"; reason = trip.reason; }
    else if (target.stop) { status = "stopped_by_user"; reason = reason || "stopped-by-user"; }
    else if (reason === "end-of-list") status = "completed";
    else if (reason === "no-responses-seen") status = "stopped_by_error";
    else if (reason) status = "paused"; // max-runtime etc. → resumable
    else status = "completed";

    if (status === "paused" && reason === "max-runtime") {
      // Time-box hit: treat like a pause so Start continues the queue.
      reason = "max-runtime";
    }

    if (target.backup) {
      try { await saveBackup(target.backup); } catch { /* non-fatal */ }
    }

    await setState({
      status,
      lastStopReason: reason,
      stats: { ...syncStats(target) },
    });

    if (status === "paused" || status === "stopped_by_user") {
      // Keep the session: queue + done-set survive for exact resume.
      if (run === target) run = null;
      await saveSession(target);
    } else {
      if (run === target) run = null;
      await clearSession();
    }
  }

  function launchLoop(target) {
    if (target.loopPromise) return target.loopPromise;
    target.loopPromise = runUnfollowLoop(target).finally(() => {
      target.loopPromise = null;
    });
    return target.loopPromise;
  }

  /* ------------------------------------------------------------------ *
   * Commands
   * ------------------------------------------------------------------ */

  async function captureIsRunning() {
    try {
      const data = await chrome.storage.local.get(CAPTURE_STATE_KEY);
      return data[CAPTURE_STATE_KEY]?.status === "capturing";
    } catch {
      return false;
    }
  }

  function findProfileHref() {
    const candidates = [
      'a[data-testid="AppTabBar_Profile_Link"]',
      'a[aria-label="Profile"]',
      'a[data-testid="DashButton_ProfileIcon_Link"]',
    ];
    for (const selector of candidates) {
      const link = document.querySelector(selector);
      const href = link && link.getAttribute("href");
      if (href && /^\/[^/]+$/.test(href)) return href;
    }
    return null;
  }

  async function beginRun(target) {
    target.pacer = XPacing.createPacer({ ...config.pacing, rng: Math.random });
    target.governor = XPacing.createGovernor({ rateCeilingPerMin: config.pacing.rateCeilingPerMin });
    touchOwner();

    const [hintData, ping] = await Promise.all([
      chrome.storage.local.get(QUERY_ID_HINT_KEY).catch(() => ({})),
      pingBridge(),
    ]);
    target.queryIdHint = hintData[QUERY_ID_HINT_KEY] || null;
    if (!target.queryIdHint && ping?.queryId) {
      target.queryIdHint = ping.queryId;
      chrome.storage.local.set({ [QUERY_ID_HINT_KEY]: ping.queryId }).catch(() => {});
    }

    target.backup = await loadBackup();
    target.backupById = new Map();
    target.backup.entries.forEach((entry, index) => target.backupById.set(String(entry.user_id), index));

    // Drain the pre-navigation cache before switching into live intake.
    for (const user of pendingUsers.values()) {
      if (target.doneIds.has(user.user_id) || target.queuedIds.has(user.user_id)) continue;
      target.queue.push(user);
      target.queuedIds.add(user.user_id);
      registerBackup(target, user);
    }
    pendingUsers.clear();
    pendingStats.users = 0;
    pendingStats.dropped = 0;

    target.stats.discovered = target.queuedIds.size + target.doneIds.size;
    target.stats.pending = target.queue.length;
    target.stats.backup = target.backup.entries.length;

    /* Runtime window and attempt cap are per invocation: resuming after the
       cap or a long pause must start a fresh budget, not trip instantly. */
    target.startedAt = Date.now();
    target.counters.runCount = 0;

    run = target;
    // Persist immediately: the very first seconds after Start must already
    // have a durable session so a reload/navigation loses nothing.
    await saveSession(target);
    await setState({
      status: "running",
      startedAt: new Date().toISOString(),
      lastStopReason: null,
      stats: { ...syncStats(target) },
    });
    launchLoop(target);
  }

  async function startUnfollow() {
    /* Only wait for a loop that is already FINALIZING (stop/pause pressed).
       Awaiting a live run would hang the popup's Start until the entire
       unfollow pass ends. */
    if (run && (run.stop || run.pause) && run.loopPromise) await run.loopPromise;

    if (run && !run.stop && run.pause) {
      const target = run;
      target.pause = false;
      target.counters.reason = null;
      target.freshStart = false;
      touchOwner();
      await setState({ status: "running", lastStopReason: null, stats: { ...syncStats(target) } });
      wakeRun(target);
      launchLoop(target);
      return { ok: true, resumed: true };
    }
    if (run && !run.stop) return { ok: false, reason: "already-running" };
    run = null;
    if (await captureIsRunning()) return { ok: false, reason: "capture-running" };

    if (!isFollowingRoute()) {
      const profileHref = findProfileHref();
      if (!profileHref || !isXHost()) return { ok: false, reason: "open-following" };
      /* Preserve any existing session across the navigation — a paused run's
         queue and done-set must survive, not be replaced by an empty shell. */
      const existing = await loadSession();
      const session = existing
        ? { ...existing, navOnly: true, savedAt: Date.now() }
        : { version: 1, savedAt: Date.now(), navOnly: true, queue: [], doneIds: [], stats: defaultStats() };
      await chrome.storage.local.set({ [SESSION_KEY]: session });
      touchOwner();
      await setState({ status: "navigating", lastStopReason: null, startedAt: new Date().toISOString(), stats: defaultStats() });
      location.assign(profileHref + "/following");
      return { ok: true, navigating: true };
    }

    const session = await loadSession();
    if (session) {
      if (!session.navOnly) {
        /* Another window may own this session (two tabs on /following).
           This tab's owner heartbeat proves local ownership; otherwise the
           session must have gone quiet long enough for its owner to be gone. */
        const sessionFresh = Date.now() - Number(session.savedAt || 0) < 35000;
        if (sessionFresh && !tabOwnsRun()) return { ok: false, reason: "running-elsewhere" };
      }
      const target = createRun({ ...session, resumed: !session.navOnly, navOnly: !!session.navOnly });
      await beginRun(target);
      return { ok: true, resumed: !session.navOnly, navigated: !!session.navOnly };
    }

    const target = createRun({ freshStart: true });
    await beginRun(target);
    return { ok: true };
  }

  async function pauseUnfollow() {
    const target = run;
    if (!target || target.pause || target.stop) return { ok: false, reason: "not-running" };
    target.pause = true;
    wakeRun(target);
    if (!target.loopPromise) launchLoop(target);
    await target.loopPromise;
    return { ok: true };
  }

  async function foreignRunIsLive() {
    /* No local run + a freshly heartbeating session ⇒ another tab owns it.
       Stopping/resetting here would fake success while that tab keeps
       pushing state. */
    const session = await loadSession();
    return !!session &&
      Date.now() - Number(session.savedAt || 0) < 40000 &&
      !tabOwnsRun();
  }

  async function stopUnfollow() {
    const target = run;
    if (!target) {
      const state = await getState();
      if (state.status === "running" || state.status === "navigating") {
        if (await foreignRunIsLive()) return { ok: false, reason: "running-elsewhere" };
        // Stale state after a crashed/closed tab: reconcile the status. A
        // pending navigation shell carries no queue — drop it so arrival on
        // the Following route cannot auto-start against the user's Stop. A
        // real session is kept for exact resume.
        if (state.status === "navigating") await clearSession();
        await setState({ status: "stopped_by_user", lastStopReason: "stopped-by-user" });
        return { ok: true, stale: true };
      }
      return { ok: false, reason: "idle" };
    }
    target.stop = true;
    target.pause = false;
    wakeRun(target);
    if (!target.loopPromise) launchLoop(target);
    await target.loopPromise;
    return { ok: true };
  }

  async function resetUnfollow() {
    const target = run;
    if (target) {
      target.stop = true;
      target.pause = false;
      target.trip = null;
      wakeRun(target);
      if (target.loopPromise) await target.loopPromise;
    } else if (await foreignRunIsLive()) {
      return { ok: false, reason: "running-elsewhere" };
    }
    run = null;
    pendingUsers.clear();
    pendingStats.responses = 0;
    pendingStats.pages = 0;
    pendingStats.users = 0;
    pendingStats.dropped = 0;
    pendingStats.ignored = 0;
    await chrome.storage.local.remove([STATE_KEY, SESSION_KEY, BACKUP_KEY, QUERY_ID_HINT_KEY]);
    await setState({ status: "idle", startedAt: null, lastStopReason: null, stats: defaultStats() });
    return { ok: true };
  }

  /* ------------------------------------------------------------------ *
   * Bootstrap — auto-resume when the (re)loaded document is the Following
   * route with a live run in storage. Covers the deliberate navigation in
   * startUnfollow() and tab closes mid-run.
   * ------------------------------------------------------------------ */

  async function bootstrap() {
    try {
      const [state, session] = await Promise.all([getState(), loadSession()]);
      if (!session) {
        // Phantom reconciliation: status says running/navigating but the
        // session is gone (expired, reset elsewhere). Only flip when the
        // record is clearly old — a just-completed finalize may race here.
        if ((state.status === "running" || state.status === "navigating") &&
            Date.now() - Date.parse(state.updatedAt || "") > config.navigatingMaxAgeMs) {
          await setState({ status: "idle", lastStopReason: null });
        }
        return;
      }

      if (session.navOnly) {
        if (isFollowingRoute()) {
          const target = createRun({ ...session, navOnly: true });
          await beginRun(target);
        } else if (Date.now() - Number(session.savedAt || 0) > config.navigatingMaxAgeMs) {
          await clearSession();
          await setState({ status: "idle", lastStopReason: "navigation-timeout" });
        }
        return;
      }

      /* Auto-resume only for a run this tab owned (reload/navigation death)
         or an orphaned session whose owner has been quiet past the heartbeat
         window. A paused run never auto-resumes — the user paused it. */
      if (state.status !== "running" || !isFollowingRoute()) return;
      const orphan = Date.now() - Number(session.savedAt || 0) > 95000;
      if (!tabOwnsRun() && !orphan) return;
      const target = createRun({ ...session, resumed: true });
      target.pause = false;
      await beginRun(target);
    } catch (error) {
      console.warn("[x-unfollow] bootstrap failed", error);
    }
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== BRIDGE_OUT) return;
    const resolver = bridgePending.get(data.id);
    if (resolver) resolver(data);
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== "x-bookmark-exporter" || data.type !== "bookmarks-response") return;
    if (data.payload?.ok === false) return; // capture handles its own errors
    handleTimelinePayload(data.payload);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const reply = (promise) => {
      promise.then(sendResponse).catch((error) => {
        console.error("[x-unfollow] command failed", error);
        sendResponse({ ok: false, reason: String(error?.message || error) });
      });
      return true;
    };
    switch (msg?.type) {
      case "unfollow-start": return reply(startUnfollow());
      case "unfollow-pause": return reply(pauseUnfollow());
      case "unfollow-stop": return reply(stopUnfollow());
      case "unfollow-reset": return reply(resetUnfollow());
      case "unfollow-get-state": return reply(getState());
      default: return false;
    }
  });

  if (isXHost()) bootstrap();

  return {
    config,
    isFollowingRoute,
    start: startUnfollow,
    pause: pauseUnfollow,
    stop: stopUnfollow,
    reset: resetUnfollow,
    getState,
  };
})();
