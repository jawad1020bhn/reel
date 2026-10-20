/* Reddit unsave engine · content script on the signed-in account's own saved
 * listing (https://old.reddit.com/user/<you>/saved).
 *
 * Same discipline as the X unsave engine (unsave.js):
 *   - every target's full backup record and index are durably written BEFORE
 *     it becomes executable; a storage failure stops the run;
 *   - one request in flight at a time, bounded by a timeout;
 *   - XPacing warm-up, jittered gaps, irregular waves, closed-loop governor and
 *     exponential full-jitter backoff; rate limits honour Reddit's own timing;
 *   - durable checkpoints (queue + done set + counters) with a heartbeat, so a
 *     closed tab loses nothing and only the owning tab may auto-resume;
 *   - a browser-owned Web Lock keeps capture and unsave from running together;
 *   - account scoping through /api/me.json (the session's modhash doubles as
 *     Reddit's CSRF token and binds every mutation to that exact session);
 *   - completion requires repeated clean sweeps of the LIVE listing. Removing
 *     items shifts Reddit's pagination, so the engine always re-reads from
 *     the head after a batch instead of trusting an old page position.
 *
 * No MAIN-world bridge is needed here: old.reddit is server-rendered and its
 * own unsave button is a same-origin form POST, which the content script's
 * fetch() replays with the browser's session cookies. */
const RU = (() => {
  "use strict";
  const S = globalThis.XRedditSaved;
  const R = globalThis.XRedditRemoval;
  const D = globalThis.XRedditDom;
  const STATE = "redditUnsaveState", SESSION = "redditUnsaveSession", BACKUP = "redditUnsaveBackup";
  const OWNER = "redditUnsaveOwner", PREFIX = "redditUnsavePost.";
  const LOCK = (globalThis.XEngineLock && XEngineLock.REDDIT_LOCK) || "xreels-reddit-exclusive-engine";
  const config = {
    maxRuntimeMs: 3 * 60 * 60 * 1000, maxRunCount: 1500, sessionMaxAgeMs: 7 * 86400000,
    heartbeatMs: 15000, requestTimeoutMs: 30000, maxErrors: 5, maxAuthRefreshes: 2,
    cleanSweeps: 2, staleSweepLimit: 3, settleMs: 8000, identityEvery: 20,
  };
  const listingAccount = () => { const a = S.savedListingAccount(location.href); return a ? a.toLowerCase() : null; };
  const keyFor = (account, id) => PREFIX + account + "." + id;
  const defaults = () => ({ discovered: 0, pending: 0, unsaved: 0, failed: 0, requeued: 0, rateLimits: 0, responses: 0, pages: 0, sweeps: 0, perMin: 0, runCount: 0, backup: 0 });
  let run = null, starting = false;

  /* ---------------------------------------------------------------------------
     Transport · single-flight, bounded, same-origin
     --------------------------------------------------------------------------- */
  const transport = (() => {
    let busy = false;
    async function guarded(task) {
      if (busy) return { status: 0, outcome: "request-busy" };
      busy = true;
      try { return await task(AbortSignal.timeout(config.requestTimeoutMs)); }
      catch (error) { return { status: 0, outcome: error && error.name === "TimeoutError" ? "request-timeout" : "network-error", detail: String(error && error.message || error) }; }
      finally { busy = false; }
    }
    async function readBody(response) {
      const text = await response.text();
      try { return { text, json: text ? JSON.parse(text) : null }; } catch { return { text, json: null }; }
    }
    return {
      identity: () => guarded(async (signal) => {
        const response = await fetch(location.origin + S.ME_PATH, { credentials: "include", cache: "no-store", signal, headers: { accept: "application/json" } });
        const { json } = await readBody(response);
        return { status: response.status, identity: S.parseIdentity(json), retryAt: R.retryAt(response.headers, json) };
      }),
      scan: (url) => guarded(async (signal) => {
        const response = await fetch(url, { credentials: "include", cache: "no-store", redirect: "follow", signal, headers: { accept: "text/html" } });
        if (D.isGateUrl(response.url)) return { status: response.status, outcome: "auth-error" };
        const html = await response.text();
        return { status: response.status, doc: response.ok ? new DOMParser().parseFromString(html, "text/html") : null, retryAt: R.retryAt(response.headers, null) };
      }),
      exec: (request) => guarded(async (signal) => {
        const response = await fetch(location.origin + request.path, { method: request.method, credentials: "include", cache: "no-store", signal, headers: request.headers, body: request.body });
        const { text, json } = await readBody(response);
        return { status: response.status, body: json, raw: text.slice(0, 2000), retryAt: R.retryAt(response.headers, json) };
      }),
    };
  })();

  /* ---------------------------------------------------------------------------
     Checkpoints
     --------------------------------------------------------------------------- */
  const read = async (key) => (await chrome.storage.local.get(key))[key];
  function wake(target) { for (const done of [...target.waiters]) done(); }
  function wait(target, ms) {
    if (target.pause || target.stop || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); target.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms); target.waiters.add(done);
    });
  }
  const snapshot = (target) => ({
    version: 1, account: target.account, owner: target.owner, savedAt: Date.now(),
    queue: target.queue.slice(), doneIds: [...target.done], requeuedIds: [...target.requeued],
    stats: { ...target.stats }, backoffUntil: target.backoffUntil, retries: target.retries,
  });
  function checkpoint(target, status = "running", reason = target.reason) {
    const write = target.writes.then(async () => {
      const now = Date.now();
      target.stats.pending = target.queue.length;
      target.stats.perMin = Math.round(target.governor.rate());
      target.stats.backup = target.backup.ids.length;
      const state = { status, account: target.account, updatedAt: new Date(now).toISOString(), lastStopReason: reason || null, stats: { ...target.stats } };
      await chrome.storage.local.set({ [STATE]: state, [SESSION]: snapshot(target) });
      try { chrome.runtime.sendMessage({ type: "reddit-unsave-state", state }).catch(() => {}); } catch { /* popup closed */ }
      try { sessionStorage.setItem(OWNER, target.owner); } catch { /* ownership remains in session */ }
    });
    target.writes = write.catch(() => {});
    return write;
  }
  function validContext(target) {
    if (listingAccount() !== target.account) { target.reason = "open-saved"; return false; }
    return true;
  }

  /* ---------------------------------------------------------------------------
     Identity · the session must belong to the listing's account, be signed in,
     and have NSFW content visible — otherwise an empty sweep proves nothing.
     Returns "ok" | "retry" (transport trouble, backoff applied) | "stop".
     --------------------------------------------------------------------------- */
  async function ensureIdentity(target) {
    const reply = await transport.identity();
    if (reply.outcome || reply.status !== 200) {
      const outcome = reply.outcome || R.classify(reply);
      if (R.RETRYABLE.includes(outcome)) return (await handleFailure(target, reply, outcome)) ? "retry" : "stop";
      target.reason = outcome === "auth-error" ? "auth-error" : "auth-unavailable";
      return "stop";
    }
    const who = reply.identity;
    if (!who || !who.loggedIn || !who.modhash) { target.reason = "auth-unavailable"; return "stop"; }
    if (who.name.toLowerCase() !== target.account) { target.reason = "account-changed"; return "stop"; }
    if (who.over18 === false) { target.reason = "nsfw-hidden"; return "stop"; }
    target.modhash = who.modhash;
    target.sinceIdentity = 0;
    return "ok";
  }

  /* ---------------------------------------------------------------------------
     Intake · backup-before-queue
     --------------------------------------------------------------------------- */
  async function intake(target, posts) {
    const writes = {};
    for (const post of posts) {
      if (target.done.has(post.id) || target.queued.has(post.id)) continue;
      writes[keyFor(target.account, post.id)] = { ...post, discovered_at: new Date().toISOString(), unsaved_at: null, outcome: "pending" };
    }
    const ids = Object.values(writes).map((post) => post.id);
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

  /* ---------------------------------------------------------------------------
     Failure handling · returns true to continue the loop, false to stop
     --------------------------------------------------------------------------- */
  async function handleFailure(target, reply, outcome, { mutation = true } = {}) {
    if (outcome === "request-busy") { await wait(target, 2000); return true; }
    if (R.RETRYABLE.includes(outcome)) {
      target.retries++;
      if (outcome === "rate-limited") target.stats.rateLimits++;
      else if (++target.errors >= config.maxErrors) { target.reason = "too-many-errors"; return false; }
      const plan = XPacing.computeBackoff(target.retries, { baseMs: R.PACING.backoffBaseMs, maxMs: R.PACING.backoffMaxMs, maxRetries: R.PACING.backoffMaxRetries });
      if (!plan.retry) { target.reason = "max-backoff-retries"; return false; }
      const delay = Math.max(plan.delayMs, (Number(reply && reply.retryAt) || 0) - Date.now());
      target.backoffUntil = Date.now() + delay;
      await checkpoint(target, "running", `backoff-${outcome} (${Math.ceil(delay / 1000)}s)`);
      await wait(target, delay);
      return true;
    }
    if (outcome === "auth-error" && target.authRefreshes < config.maxAuthRefreshes) {
      // A modhash goes stale when the user signs out and back in. Re-read the
      // session once or twice; a different account or a logged-out session stops.
      target.authRefreshes++;
      await wait(target, 3000);
      const verdict = await ensureIdentity(target);
      return verdict !== "stop";
    }
    // Unknown 200s, HTML, missing endpoint and permission errors retain the
    // head target. Never skip it and claim everything was removed.
    target.reason = outcome;
    if (mutation) target.stats.failed++;
    return false;
  }

  /* ---------------------------------------------------------------------------
     Main loop
     --------------------------------------------------------------------------- */
  async function loop(target) {
    const heartbeat = setInterval(() => {
      if (run !== target || target.finalizing) return;
      checkpoint(target).catch(() => { target.reason = "storage-error"; target.stop = true; wake(target); });
    }, config.heartbeatMs);
    const head = S.savedListingUrl(target.account);
    let status = "stopped_by_error", pageUrl = head, visited = new Set(), sweepStale = false, cleanSweeps = 0, staleSweeps = 0;
    const resetSweep = () => { pageUrl = head; visited = new Set(); sweepStale = false; };
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
          const entry = await read(keyFor(target.account, id));
          if (!entry || entry.id !== id) { target.reason = "backup-missing"; break; }
          const plan = target.pacer.next();
          await checkpoint(target, "running", plan.kind === "wave-break" ? `wave-break (${Math.ceil(plan.delayMs / 1000)}s)` : null);
          await wait(target, plan.delayMs);
          if (target.stop || target.pause || !validContext(target)) break;
          if (target.sinceIdentity >= config.identityEvery) {
            const verdict = await ensureIdentity(target);
            if (verdict === "stop") break;
            if (verdict === "retry") continue;
          }
          const request = R.buildUnsaveRequest(entry.fullname, target.modhash);
          if (!request) { target.reason = "invalid-target"; break; }
          // Persist the queue before each request; a closed tab can only retry
          // an exact, already-backed-up ID, never silently lose a target.
          await checkpoint(target);
          target.stats.runCount++;
          const reply = await transport.exec(request);
          target.governor.record(); target.pacer.onAction(); target.sinceIdentity++;
          const outcome = R.classify(reply);
          if (outcome !== "ok") {
            if (!await handleFailure(target, reply, outcome)) break;
            continue;
          }
          await chrome.storage.local.set({ [keyFor(target.account, id)]: { ...entry, unsaved_at: new Date().toISOString(), outcome: "unsaved" } });
          target.queue.shift(); target.queued.delete(id); target.done.add(id);
          target.stats.unsaved++; target.retries = 0; target.errors = 0; target.authRefreshes = 0;
          resetSweep(); cleanSweeps = 0; staleSweeps = 0;
          await checkpoint(target);
          continue;
        }

        // Discovery: re-read the LIVE listing from its head after every batch.
        // Unsaving shifts Reddit's pagination, so no old position is trusted.
        const reply = await transport.scan(pageUrl);
        if (reply.outcome || reply.status !== 200 || !reply.doc) {
          let outcome = reply.outcome || R.classify({ status: reply.status, body: null });
          if (!reply.outcome && reply.status === 404) outcome = "listing-unavailable";
          if (!await handleFailure(target, reply, outcome, { mutation: false })) break;
          continue;
        }
        if (!D.isListing(reply.doc)) { target.reason = "schema-mismatch"; break; }
        const page = R.extractTargets(D.readRows(reply.doc), { done: target.done, queued: target.queued });
        target.stats.responses++; target.stats.pages++;
        await intake(target, page.targets);
        if (target.queue.length) { resetSweep(); continue; }

        if (page.stale.length) {
          sweepStale = true;
          for (const id of page.stale) {
            const seen = (target.staleSeen.get(id) || 0) + 1;
            target.staleSeen.set(id, seen);
            // Reddit confirmed the removal yet still lists the post after a
            // settle delay: retry exactly once (unsave is idempotent). A post
            // that survives that too keeps the run from ever claiming completion.
            if (seen >= 2 && !target.requeued.has(id)) {
              target.requeued.add(id); target.done.delete(id);
              target.queue.push(id); target.queued.add(id); target.stats.requeued++;
            }
          }
          if (target.queue.length) { resetSweep(); await checkpoint(target); continue; }
        }

        const next = S.resolveNextUrl(D.nextHref(reply.doc), pageUrl, target.account);
        if (next && !visited.has(next)) {
          visited.add(next); pageUrl = next;
          await checkpoint(target, "running", "verifying-list");
          await wait(target, target.reader.nextGap().ms);
          continue;
        }

        // End of the listing with nothing new to remove.
        target.stats.sweeps++;
        if (sweepStale) {
          cleanSweeps = 0;
          if (++staleSweeps >= config.staleSweepLimit) { target.reason = "verification-needed"; target.pause = true; break; }
        } else if (++cleanSweeps >= config.cleanSweeps) {
          // A clean listing proves nothing if NSFW rows are hidden or the
          // session changed under us: confirm the identity before claiming it.
          const verdict = await ensureIdentity(target);
          if (verdict === "stop") break;
          if (verdict === "retry") { cleanSweeps--; resetSweep(); continue; }
          status = "completed"; target.reason = "verified-clean"; break;
        }
        resetSweep();
        await checkpoint(target, "running", "verifying-list");
        await wait(target, config.settleMs);
      }
      if (target.pause) status = "paused";
      else if (target.stop) status = target.reason ? "stopped_by_error" : "stopped_by_user";
      target.finalizing = true;
      await target.writes;
      await checkpoint(target, status);
      if (status === "completed") await chrome.storage.local.remove(SESSION);
    } catch (error) {
      target.finalizing = true;
      console.warn("[reddit-unsave] run stopped", error);
      target.reason = "storage-error";
      try { await checkpoint(target, "stopped_by_error"); } catch { /* retain previous durable checkpoint */ }
    } finally {
      clearInterval(heartbeat);
      if (run === target) run = null;
      target.release();
    }
  }

  /* ---------------------------------------------------------------------------
     Commands
     --------------------------------------------------------------------------- */
  async function start() {
    if (starting || run) return { ok: false, reason: "already-running" };
    const account = listingAccount();
    if (!account) return { ok: false, reason: "open-saved" };
    starting = true;
    let release;
    try {
      release = await XEngineLock.acquire(LOCK);
      if (!release) return { ok: false, reason: "engine-busy" };
      const data = await chrome.storage.local.get([SESSION, BACKUP]);
      const session = data[SESSION];
      const backup = data[BACKUP] || { version: 1, account, ids: [] };
      if ((session && session.account !== account) || backup.account !== account) return { ok: false, reason: "account-changed" };
      if (session && Date.now() - session.savedAt > config.sessionMaxAgeMs) return { ok: false, reason: "session-expired" };
      // The session must be signed in as the listing's owner with NSFW visible
      // before the first checkpoint is written.
      const probe = await transport.identity();
      const who = probe.identity;
      if (probe.outcome || probe.status !== 200 || !who || !who.loggedIn || !who.modhash) return { ok: false, reason: probe.status === 429 ? "rate-limited" : "auth-unavailable" };
      if (who.name.toLowerCase() !== account) return { ok: false, reason: "account-mismatch", signedInAs: who.name };
      if (who.over18 === false) return { ok: false, reason: "nsfw-hidden" };
      const governor = XPacing.createGovernor({ rateCeilingPerMin: R.PACING.rateCeilingPerMin, rateWindowMs: R.PACING.rateWindowMs, maxThrottle: R.PACING.maxThrottle });
      const target = {
        account, owner: (session && session.owner) || crypto.randomUUID(), release, startedAt: Date.now(), pause: false, stop: false,
        modhash: who.modhash, sinceIdentity: 0, authRefreshes: 0,
        queue: (session && session.queue && session.queue.slice()) || [], queued: new Set((session && session.queue) || []),
        done: new Set((session && session.doneIds) || []), requeued: new Set((session && session.requeuedIds) || []), staleSeen: new Map(),
        stats: { ...defaults(), ...(session && session.stats), runCount: 0 }, backup, waiters: new Set(), writes: Promise.resolve(),
        retries: (session && session.retries) || 0, errors: 0, backoffUntil: (session && session.backoffUntil) || 0, reason: null,
        pacer: XPacing.createPacer({ ...R.PACING, throttle: () => governor.multiplier() }), governor,
        reader: S.createPacer(),
      };
      await checkpoint(target);
      run = target;
      target.promise = loop(target);
      release = null; // loop owns the browser lease now
      return { ok: true, resumed: !!session };
    } catch (error) { console.warn("[reddit-unsave] start failed", error); return { ok: false, reason: "storage-error" }; }
    finally { starting = false; if (release) release(); }
  }

  async function control(pause) {
    if (!run) {
      const release = await XEngineLock.acquire(LOCK);
      if (!release) return { ok: false, reason: "running-elsewhere" };
      try {
        const state = await read(STATE);
        if (state && state.status === "running") await chrome.storage.local.set({ [STATE]: { ...state, status: pause ? "paused" : "stopped_by_user", updatedAt: new Date().toISOString() } });
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
    const release = await XEngineLock.acquire(LOCK);
    if (!release) return { ok: false, reason: "engine-busy" };
    try {
      const meta = await read(BACKUP);
      // Reset owns only this engine's keys, never the captured Reddit library.
      await chrome.storage.local.remove([STATE, SESSION, BACKUP, ...((meta && meta.ids) || []).map((id) => keyFor(meta.account, id))]);
      try { sessionStorage.removeItem(OWNER); } catch { /* optional */ }
      return { ok: true };
    } finally { release(); }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    let task;
    switch (msg && msg.type) {
      case "reddit-unsave:start": task = start(); break;
      case "reddit-unsave:pause": task = control(true); break;
      case "reddit-unsave:stop": task = control(false); break;
      case "reddit-unsave:reset": task = reset(); break;
      case "reddit-unsave:get-state":
        task = read(STATE).then((state) => ({ ok: true, state: state || null, account: listingAccount(), loggedIn: D.looksLoggedIn(document), live: !!run }));
        break;
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
    if (state && state.status === "running" && session && session.owner && owner === session.owner && session.account === listingAccount()) await start();
  })().catch(() => {});

  return { start, pause: () => control(true), stop: () => control(false), reset, config };
})();
