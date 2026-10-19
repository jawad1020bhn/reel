/*
 * Human pacing engine for the unfollow runner.
 *
 * Everything here is pure and injected (RNG, timestamps) so the behaviour that
 * protects the account is unit-testable instead of buried in timers:
 *
 *  - Pacer: warm-up ramp, jittered steady-state gaps, and irregular "wave"
 *    breaks so the request pattern never settles into machine-regular
 *    intervals (the easiest signature for abuse systems to classify).
 *  - Governor: closed-loop rate ceiling. If the observed unfollow rate climbs
 *    above the target, the pacer is stretched proportionally and eases back
 *    only when the rate has genuinely come down.
 *  - Backoff: exponential + full-jitter retry schedule for 429/5xx, identical
 *    in spirit to the capture loop's backoff.
 *  - Outcome classification: one place that maps HTTP status + GraphQL/REST
 *    payloads to the handful of outcomes the runner understands.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XPacing = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const DEFAULTS = {
    baseDelayMs: 2400,        // steady-state target gap → ~25 attempts/min ceiling
    jitterRatio: 0.35,        // ±35% around the target gap
    minDelayMs: 600,          // never faster than this, whatever the jitter
    warmupCount: 6,           // first actions are paced conservatively
    warmupFactor: 1.7,
    waveMin: 7,               // a "wave" of actions...
    waveMax: 14,              // ...drawn fresh each wave, so waves never repeat
    waveBreakMinMs: 7000,     // ...followed by a reading-length pause
    waveBreakMaxMs: 22000,
    rateCeilingPerMin: 26,    // hard behavioural ceiling the governor enforces
    rateWindowMs: 60000,
    maxThrottle: 2.5,         // never stretch delays beyond 2.5× in an emergency
    backoffBaseMs: 6000,
    backoffMaxMs: 5 * 60 * 1000,
    backoffMaxRetries: 10,
  };

  function randomInt(rng, min, max) {
    return min + Math.floor(rng() * (max - min + 1));
  }

  /**
   * Rolling-window throughput governor. `record(ts)` registers one completed
   * action; `multiplier(ts)` returns how much the next delay must stretch to
   * pull the rate back under the ceiling (1 = healthy, up to maxThrottle).
   */
  function createGovernor(options = {}) {
    const ceiling = Math.max(1, Number(options.rateCeilingPerMin) || DEFAULTS.rateCeilingPerMin);
    const windowMs = Math.max(1000, Number(options.rateWindowMs) || DEFAULTS.rateWindowMs);
    const maxThrottle = Math.max(1, Number(options.maxThrottle) || DEFAULTS.maxThrottle);
    const events = [];

    return {
      ceiling,
      windowMs,
      record(ts = Date.now()) {
        events.push(ts);
        // Prune on write so the window cannot grow without bound.
        let cutoff = 0;
        while (cutoff < events.length && events[cutoff] <= ts - windowMs) cutoff++;
        if (cutoff) events.splice(0, cutoff);
      },
      rate(ts = Date.now()) {
        const live = events.filter((ts2) => ts2 > ts - windowMs);
        return live.length * (60000 / windowMs);
      },
      multiplier(ts = Date.now()) {
        const rate = this.rate(ts);
        if (rate <= ceiling) return 1;
        return clamp(rate / ceiling, 1, maxThrottle);
      },
      /* True when throughput has fallen well below target while throttled —
         the caller uses this to decide the throttle has earned an ease-back. */
      get events() { return events.slice(); },
    };
  }

  /**
   * Stateful delay planner. `next()` answers "how long before the next
   * action?" and `onAction()` records that the action happened.
   */
  function createPacer(options = {}) {
    const cfg = { ...DEFAULTS, ...options };
    const rng = options.rng || Math.random;
    const throttle = typeof options.throttle === "function" ? options.throttle : () => 1;

    let actions = 0;
    let sinceBreak = 0;
    let nextWaveAt = randomInt(rng, cfg.waveMin, cfg.waveMax);

    function next() {
      // Wave break first: it overrides everything else, like a human stopping
      // to read a profile before continuing down the list.
      if (sinceBreak >= nextWaveAt) {
        return {
          kind: "wave-break",
          delayMs: randomInt(rng, cfg.waveBreakMinMs, cfg.waveBreakMaxMs),
        };
      }

      const warm = actions < cfg.warmupCount;
      const jitter = 1 + (rng() * 2 - 1) * cfg.jitterRatio;
      const base = cfg.baseDelayMs * jitter * (warm ? cfg.warmupFactor : 1);
      const delayMs = Math.round(clamp(base * throttle(), cfg.minDelayMs, 60000));
      return { kind: warm ? "warmup" : "steady", delayMs };
    }

    function onAction() {
      actions++;
      if (sinceBreak >= nextWaveAt) {
        sinceBreak = 0;
        nextWaveAt = randomInt(rng, cfg.waveMin, cfg.waveMax);
      } else {
        sinceBreak++;
      }
    }

    return {
      next,
      onAction,
      get actions() { return actions; },
      get sinceBreak() { return sinceBreak; },
      reset() { actions = 0; sinceBreak = 0; nextWaveAt = randomInt(rng, cfg.waveMin, cfg.waveMax); },
      config: cfg,
    };
  }

  /** Exponential backoff with ±25% jitter — mirrors the capture loop's schedule. */
  function computeBackoff(retries, options = {}) {
    const base = Number(options.baseMs) || DEFAULTS.backoffBaseMs;
    const max = Number(options.maxMs) || DEFAULTS.backoffMaxMs;
    const maxRetries = Number.isFinite(Number(options.maxRetries)) ? Number(options.maxRetries) : DEFAULTS.backoffMaxRetries;
    const rng = options.rng || Math.random;
    const attempt = Math.max(1, Number(retries) || 1);
    if (attempt > maxRetries) return { retry: false, delayMs: 0, attempt, maxRetries };
    const exp = base * Math.pow(2, attempt - 1);
    const jittered = exp * (0.75 + rng() * 0.5);
    return { retry: true, delayMs: Math.round(Math.min(jittered, max)), attempt, maxRetries };
  }

  /**
   * Map an unfollow attempt's HTTP status (+ optional parsed body or raw
   * text) onto one runner outcome:
   *
   *   ok | not-found | rate-limited | auth-error | server-error |
   *   network-error | bad-request | stale-queryid
   *
   * `transport` matters: on GraphQL, 404/400 mean the rolling operation ID
   * died (a *transport* miss — the account must be requeued), while on the
   * stable v1.1 REST path 404 genuinely means the relationship is gone.
   */
  function classifyOutcome(status, body = null, rawText = "", transport = null) {
    const text = typeof rawText === "string" && rawText ? rawText :
      (body == null ? "" : typeof body === "string" ? body : JSON.stringify(body));
    const lowered = text.toLowerCase();

    if (!Number.isFinite(status) || status === 0) return { outcome: "network-error" };
    if (status === 429 || lowered.includes("rate limit")) return { outcome: "rate-limited" };
    if (transport === "graphql" && status === 404) return { outcome: "stale-queryid" };
    if (status === 401 || status === 403) return { outcome: "auth-error" };
    if (status >= 500) return { outcome: "server-error" };
    if (status === 404) return { outcome: "not-found" };

    if (status === 200) {
      if (body && typeof body === "object") {
        const errors = Array.isArray(body.errors) ? body.errors : [];
        if (errors.length) {
          for (const error of errors) {
            const code = Number(error?.code);
            const message = String(error?.message || "").toLowerCase();
            if (code === 88 || message.includes("rate limit")) return { outcome: "rate-limited" };
            if (code === 34 || code === 50 || code === 63 || message.includes("not found")) return { outcome: "not-found" };
            if (code === 89 || code === 99 || message.includes("could not authenticate")) return { outcome: "auth-error" };
          }
          return { outcome: "bad-request", detail: errors.map((e) => e?.message || e?.code || "error").join("; ") };
        }
        /* 200 without errors is a resolved mutation. `following: false` in
           the payload is the SUCCESS shape of UnfollowUser, so it must not be
           mistaken for "was already unfollowed". */
        return { outcome: "ok" };
      }
      return { outcome: "ok" };
    }

    if (status === 400) return { outcome: transport === "graphql" ? "stale-queryid" : "bad-request" };
    return { outcome: "server-error" };
  }

  return { DEFAULTS, createPacer, createGovernor, computeBackoff, classifyOutcome };
});
