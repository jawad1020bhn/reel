/* Unsave engine · isolated world. Reuses XPacing + the authenticated MAIN-world
 * bridge, with disk-before-delete backups and fresh-head pagination because
 * removing bookmarks can invalidate a scrolling timeline's cursor/positions. */
const US = (() => {
  "use strict";
  const STATE = "xUnsaveState", SESSION = "xUnsaveSession", BACKUP = "xUnsaveBackup";
  const OWNER = "xUnsaveOwner", PREFIX = "xUnsavePost.";
  const config = { maxRuntimeMs: 3 * 60 * 60 * 1000, maxRunCount: 2500, sessionMaxAgeMs: 7 * 86400000, heartbeatMs: 15000, bridgeTimeoutMs: 40000, maxErrors: 5, emptyChecks: 2 };
  const onBookmarks = () => location.origin === "https://x.com" && /^\/i\/bookmarks\/?$/.test(location.pathname);
  const account = () => XBookmarkRemoval.accountId(document.cookie);
  const keyFor = (accountId, id) => PREFIX + accountId + "." + id;
  const defaults = () => ({ discovered: 0, pending: 0, unsaved: 0, failed: 0, rateLimits: 0, responses: 0, perMin: 0, runCount: 0, backup: 0 });
  let run = null, starting = false, sequence = 0;
  const pending = new Map();
  function rpc(payload) {
    return new Promise((resolve) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); resolve({ outcome: "bridge-timeout" }); }, config.bridgeTimeoutMs);
      pending.set(id, (data) => { clearTimeout(timer); pending.delete(id); resolve(data); });
      try { window.postMessage({ source: "x-unsave-bridge", id, ...payload }, location.origin); }
      catch { clearTimeout(timer); pending.delete(id); resolve({ outcome: "network-error" }); }
    });
  }
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== "x-unsave-bridge-result") return;
    pending.get(event.data.id)?.(event.data);
  });
  const read = async (key) => (await chrome.storage.local.get(key))[key];
  function wake(target) { for (const done of [...target.waiters]) done(); }
  function wait(target, ms) {
    if (target.pause || target.stop || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); target.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms); target.waiters.add(done);
    });
  }
  const snapshot = (target) => ({ version: 1, accountId: target.accountId, owner: target.owner, savedAt: Date.now(), queue: target.queue.slice(), doneIds: [...target.done], stats: { ...target.stats }, backoffUntil: target.backoffUntil, retries: target.retries });
  function checkpoint(target, status = "running", reason = target.reason) {
    const write = target.writes.then(async () => {
      const now = Date.now();
      target.stats.pending = target.queue.length;
      target.stats.perMin = Math.round(target.governor.rate());
      target.stats.backup = target.backup.ids.length;
      const state = { status, accountId: target.accountId, updatedAt: new Date(now).toISOString(), lastStopReason: reason || null, stats: { ...target.stats } };
      await chrome.storage.local.set({ [STATE]: state, [SESSION]: snapshot(target) });
      try { chrome.runtime.sendMessage({ type: "unsave-state", state }).catch(() => {}); } catch { /* popup closed */ }
      try { sessionStorage.setItem(OWNER, target.owner); } catch { /* ownership remains in session */ }
    });
    target.writes = write.catch(() => {});
    return write;
  }
  function validContext(target) {
    if (!onBookmarks()) { target.reason = "open-bookmarks"; return false; }
    if (account() !== target.accountId) { target.reason = "account-changed"; return false; }
    return true;
  }
  async function intake(target, posts) {
    const writes = {};
    for (const post of posts) {
      if (target.done.has(post.tweet_id) || target.queued.has(post.tweet_id)) continue;
      let normalized = {};
      try { if (post.raw && typeof normalizeTweet === "function") normalized = normalizeTweet(post.raw); } catch { /* retain the exact raw record */ }
      writes[keyFor(target.accountId, post.tweet_id)] = { ...normalized, ...post, discovered_at: new Date().toISOString(), unsaved_at: null, outcome: "pending" };
    }
    const ids = Object.values(writes).map((post) => post.tweet_id);
    if (!ids.length) return;
    const nextIds = [...new Set([...target.backup.ids, ...ids])];
    // No target enters the executable queue until its complete backup AND
    // index have been durably acknowledged. Storage errors stop the run.
    await chrome.storage.local.set({ ...writes, [BACKUP]: { ...target.backup, ids: nextIds, updatedAt: new Date().toISOString() } });
    target.backup.ids = nextIds;
    for (const id of ids) { target.queue.push(id); target.queued.add(id); }
    target.stats.discovered += ids.length;
    await checkpoint(target);
  }
  async function handleFailure(target, reply, outcome) {
    if (outcome === "stale-queryid") {
      await rpc({ type: "forget" });
      target.errors++;
      if (target.errors >= config.maxErrors) { target.reason = "calibration-needed"; return false; }
      await wait(target, 3000);
      return true;
    }
    if (["rate-limited", "server-error", "network-error"].includes(outcome)) {
      target.retries++;
      if (outcome === "rate-limited") target.stats.rateLimits++;
      else if (++target.errors >= config.maxErrors) { target.reason = "too-many-errors"; return false; }
      const plan = XPacing.computeBackoff(target.retries);
      if (!plan.retry) { target.reason = "max-backoff-retries"; return false; }
      const delay = Math.max(plan.delayMs, (Number(reply.retryAt) || 0) - Date.now());
      target.backoffUntil = Date.now() + delay;
      await checkpoint(target, "running", `backoff-${outcome} (${Math.ceil(delay / 1000)}s)`);
      await wait(target, delay);
      return true;
    }
    // Unknown 200s, schema drift, missing auth/operation IDs and permission
    // errors retain the head target. Never skip it and claim all were removed.
    target.reason = outcome;
    target.stats.failed++;
    return false;
  }
  async function loop(target) {
    const heartbeat = setInterval(() => {
      if (run !== target || target.finalizing) return;
      checkpoint(target).catch(() => { target.reason = "storage-error"; target.stop = true; wake(target); });
    }, config.heartbeatMs);
    let status = "stopped_by_error", cursor = "", emptyChecks = 0, stalled = 0;
    const cursors = new Set();
    try {
      while (!target.stop && !target.pause) {
        if (!validContext(target)) break;
        if (Date.now() - target.startedAt >= config.maxRuntimeMs || target.stats.runCount >= config.maxRunCount) {
          target.pause = true; target.reason = "run-cap"; break;
        }
        if (target.backoffUntil > Date.now()) {
          await wait(target, target.backoffUntil - Date.now());
          if (target.stop || target.pause) break;
        }
        target.backoffUntil = 0;
        if (target.queue.length) {
          const id = target.queue[0];
          const entry = await read(keyFor(target.accountId, id));
          if (!entry || entry.tweet_id !== id) { target.reason = "backup-missing"; break; }
          const plan = target.pacer.next();
          await checkpoint(target, "running", plan.kind === "wave-break" ? `wave-break (${Math.ceil(plan.delayMs / 1000)}s)` : null);
          await wait(target, plan.delayMs);
          if (target.stop || target.pause || !validContext(target)) break;
          // Persist the queue before each request; a closed tab can only retry
          // an exact, already-backed-up ID, never silently lose a target.
          await checkpoint(target);
          target.stats.runCount++;
          const reply = await rpc({ type: "exec", accountId: target.accountId, tweetId: id });
          target.governor.record(); target.pacer.onAction();
          const outcome = XBookmarkRemoval.classify(reply);
          if (outcome !== "ok") {
            if (!await handleFailure(target, reply, outcome)) break;
            continue;
          }
          await chrome.storage.local.set({ [keyFor(target.accountId, id)]: { ...entry, unsaved_at: new Date().toISOString(), outcome: "unsaved" } });
          target.queue.shift(); target.queued.delete(id); target.done.add(id);
          target.stats.unsaved++; target.retries = 0; target.errors = 0;
          cursor = ""; cursors.clear(); emptyChecks = 0; stalled = 0;
          await checkpoint(target);
          continue;
        }
        // Re-read the LIVE head after removals; do not trust a DOM position or
        // a cursor created before the list shrank. Traverse stale heads only
        // when needed, then verify the head again before calling it complete.
        const reply = await rpc({ type: "scan", accountId: target.accountId, cursor });
        if (reply.status !== 200 || reply.body?.errors?.length || reply.outcome) {
          if (!await handleFailure(target, reply, XBookmarkRemoval.classify(reply))) break;
          continue;
        }
        const page = XBookmarkRemoval.extractPage(reply.body);
        if (!page.recognized) { target.reason = "schema-mismatch"; break; }
        target.stats.responses++;
        await intake(target, page.posts);
        if (target.queue.length) { emptyChecks = 0; continue; }
        if (!cursor && page.empty) {
          if (++emptyChecks >= config.emptyChecks) { status = "completed"; target.reason = "verified-empty"; break; }
        } else emptyChecks = 0;
        if (page.bottomCursor && !cursors.has(page.bottomCursor)) {
          cursor = page.bottomCursor; cursors.add(cursor);
        } else {
          cursor = ""; cursors.clear();
          if (++stalled >= 4 && !page.empty) { target.reason = "verification-needed"; target.pause = true; break; }
        }
        await checkpoint(target, "running", "verifying-feed");
        await wait(target, 2000);
      }
      if (target.pause) status = "paused";
      else if (target.stop) status = target.reason ? "stopped_by_error" : "stopped_by_user";
      target.finalizing = true;
      await target.writes;
      await checkpoint(target, status);
      if (status === "completed") await chrome.storage.local.remove(SESSION);
    } catch (error) {
      target.finalizing = true;
      console.warn("[x-unsave] run stopped", error);
      target.reason = "storage-error";
      try { await checkpoint(target, "stopped_by_error"); } catch { /* retain previous durable checkpoint */ }
    } finally {
      clearInterval(heartbeat);
      if (run === target) run = null;
      target.release();
    }
  }
  async function start() {
    if (starting || run) return { ok: false, reason: "already-running" };
    if (!onBookmarks()) return { ok: false, reason: "open-bookmarks" };
    const accountId = account();
    if (!accountId) return { ok: false, reason: "account-unavailable" };
    starting = true;
    let release;
    try {
      release = await XEngineLock.acquire();
      if (!release) return { ok: false, reason: "engine-busy" };
      const data = await chrome.storage.local.get([SESSION, BACKUP]);
      const session = data[SESSION];
      const backup = data[BACKUP] || { version: 1, accountId, ids: [] };
      if ((session && session.accountId !== accountId) || backup.accountId !== accountId) return { ok: false, reason: "account-changed" };
      if (session && Date.now() - session.savedAt > config.sessionMaxAgeMs) return { ok: false, reason: "session-expired" };
      const governor = XPacing.createGovernor();
      const target = {
        accountId, owner: session?.owner || crypto.randomUUID(), release, startedAt: Date.now(), pause: false, stop: false,
        queue: session?.queue?.slice() || [], queued: new Set(session?.queue || []), done: new Set(session?.doneIds || []),
        stats: { ...defaults(), ...session?.stats, runCount: 0 }, backup, waiters: new Set(), writes: Promise.resolve(),
        retries: session?.retries || 0, errors: 0, backoffUntil: session?.backoffUntil || 0, reason: null,
        pacer: XPacing.createPacer({ throttle: () => governor.multiplier() }), governor,
      };
      await checkpoint(target);
      run = target;
      target.promise = loop(target);
      release = null; // loop owns the browser lease now
      return { ok: true, resumed: !!session };
    } catch (error) { console.warn("[x-unsave] start failed", error); return { ok: false, reason: "storage-error" }; }
    finally { starting = false; release?.(); }
  }
  async function control(pause) {
    if (!run) {
      const release = await XEngineLock.acquire();
      if (!release) return { ok: false, reason: "running-elsewhere" };
      try {
        const state = await read(STATE);
        if (state?.status === "running") await chrome.storage.local.set({ [STATE]: { ...state, status: pause ? "paused" : "stopped_by_user", updatedAt: new Date().toISOString() } });
        return { ok: true };
      } finally { release(); }
    }
    const target = run;
    target.pause = pause; target.stop = !pause; target.reason = null;
    wake(target);
    await target.promise; // at most the one in-flight request finishes first
    return { ok: true };
  }
  async function reset() {
    if (run || starting) return { ok: false, reason: "stop-first" };
    const release = await XEngineLock.acquire();
    if (!release) return { ok: false, reason: "engine-busy" };
    try {
      const meta = await read(BACKUP);
      // Reset owns only this engine's keys, never the captured library or UF.
      await chrome.storage.local.remove([STATE, SESSION, BACKUP, ...(meta?.ids || []).map((id) => keyFor(meta.accountId, id))]);
      try { sessionStorage.removeItem(OWNER); } catch { /* optional */ }
      return { ok: true };
    } finally { release(); }
  }
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    let task;
    switch (msg?.type) {
      case "unsave-start": task = start(); break;
      case "unsave-pause": task = control(true); break;
      case "unsave-stop": task = control(false); break;
      case "unsave-reset": task = reset(); break;
      case "unsave-get-state": task = read(STATE); break;
      default: return false;
    }
    task.then(respond).catch(() => respond({ ok: false, reason: "storage-error" }));
    return true;
  });
  // Only this same tab/account may auto-resume a running checkpoint on reload.
  // Other tabs require an explicit Start; paused/stopped sessions stay paused.
  (async () => {
    const state = await read(STATE), session = await read(SESSION);
    let owner; try { owner = sessionStorage.getItem(OWNER); } catch { /* unavailable */ }
    if (state?.status === "running" && session?.owner && owner === session.owner && onBookmarks() && session.accountId === account()) await start();
  })().catch(() => {});
  return { start, pause: () => control(true), stop: () => control(false), reset, config };
})();
