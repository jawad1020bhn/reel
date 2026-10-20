/*
 * Pure, conservative decisions for the Reddit unsave engine.
 *
 * The counterpart of bookmarks.js (XBookmarkRemoval) for old.reddit.com.
 * Nothing here touches the DOM, the network or chrome.*: the engine
 * (reddit-unsave.js) hands in plain objects and gets decisions back, so the
 * rules that protect the account are unit-tested rather than buried in timers.
 *
 *  - Targets: only rows Reddit itself tags over-18 AND that are posts (t3_).
 *    SFW posts, comments, ads and unrecognised rows can never become targets.
 *  - Request: byte-for-byte what old.reddit's own "unsave" click sends —
 *    same endpoint, same form fields, the session's own modhash as CSRF.
 *  - Outcome: HTTP 200 with Reddit's explicit no-content success is the ONLY
 *    "removed". HTML, redirects, jQuery-style error payloads, unknown bodies
 *    and every non-200 status retain the target.
 *  - Pacing: the shared XPacing engine, tuned below X's ceiling because the
 *    web session is rate-limited more tightly than X's GraphQL client.
 */
(function (root, factory) {
  const saved = root && root.XRedditSaved ? root.XRedditSaved
    : (typeof require === "function" ? require("./reddit-saved.js") : null);
  const api = factory(saved);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XRedditRemoval = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (S) {
  "use strict";

  const UNSAVE_PATH = "/api/unsave";

  /* XPacing options for mutations. ~14/min ceiling, warm-up ramp, ±35% jitter,
     6–12-action waves followed by 9–26 s reading pauses, 15 s → 10 min
     full-jitter backoff with an 8-retry budget. */
  const PACING = Object.freeze({
    baseDelayMs: 3800,
    jitterRatio: 0.35,
    minDelayMs: 1500,
    warmupCount: 6,
    warmupFactor: 1.6,
    waveMin: 6,
    waveMax: 12,
    waveBreakMinMs: 9000,
    waveBreakMaxMs: 26000,
    rateCeilingPerMin: 14,
    rateWindowMs: 60000,
    maxThrottle: 2.5,
    backoffBaseMs: 15000,
    backoffMaxMs: 10 * 60 * 1000,
    backoffMaxRetries: 8,
  });

  /* Outcomes that are worth a retry after backoff. Everything else retains the
     target and stops the engine for review. */
  const RETRYABLE = Object.freeze(["rate-limited", "server-error", "network-error", "request-timeout", "request-busy"]);

  /* ---------------------------------------------------------------------------
     Request shape
     --------------------------------------------------------------------------- */

  /**
   * The exact POST old.reddit's own unsave button issues. Returns null for
   * anything that is not a post fullname or when no modhash is available —
   * the engine treats null as "do not send", never as "send without CSRF".
   */
  function buildUnsaveRequest(fullname, modhash) {
    if (!S || !S.isPostFullname(fullname)) return null;
    if (typeof modhash !== "string" || !/^[A-Za-z0-9]{10,}$/.test(modhash)) return null;
    const body = new URLSearchParams({ id: String(fullname), executed: "unsaved", uh: modhash, renderstyle: "html" });
    return {
      path: UNSAVE_PATH,
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "accept": "application/json, text/javascript, */*; q=0.01",
        "x-requested-with": "XMLHttpRequest",
      },
      body: body.toString(),
    };
  }

  /* ---------------------------------------------------------------------------
     Outcome classification
     --------------------------------------------------------------------------- */

  /**
   * Error codes from the three payload shapes Reddit uses:
   *   api_type=json  → { json: { errors: [[CODE, message, field]] } }
   *   legacy jQuery  → { jquery: [[…, "call", [".error.CODE.field-…"]], …], success: false }
   *   HTTP errors    → { error: 403, message: "Forbidden" }
   */
  function collectErrors(body) {
    const codes = [];
    if (!body || typeof body !== "object" || Array.isArray(body)) return codes;
    const jsonErrors = body.json && Array.isArray(body.json.errors) ? body.json.errors : [];
    for (const error of jsonErrors) {
      const code = Array.isArray(error) ? error[0] : (error && typeof error === "object" ? error.code : error);
      if (code != null && code !== "") codes.push(String(code).toUpperCase());
    }
    if (Array.isArray(body.jquery)) {
      const text = JSON.stringify(body.jquery);
      const re = /\.error\.([A-Z][A-Z0-9_]*)/g;
      let match;
      while ((match = re.exec(text))) if (!codes.includes(match[1])) codes.push(match[1]);
      if (/please login/i.test(text) && !codes.includes("USER_REQUIRED")) codes.push("USER_REQUIRED");
      if (/doing that too much/i.test(text) && !codes.includes("RATELIMIT")) codes.push("RATELIMIT");
    }
    if (body.error != null && body.error !== "") codes.push("HTTP_" + String(body.error).toUpperCase());
    if (body.success === false && !codes.length) codes.push("UNKNOWN");
    return codes;
  }

  /**
   * Map a transport reply onto one engine outcome:
   *
   *   ok | rate-limited | auth-error | network-error | request-timeout |
   *   request-busy | server-error | endpoint-unavailable | unconfirmed |
   *   (any transport-level outcome passed through on `reply.outcome`)
   *
   * Only HTTP 200 with Reddit's explicit no-content success (`{}`), or an
   * api_type=json envelope with an empty error list, is "ok".
   */
  function classify(reply) {
    if (reply && reply.outcome) return reply.outcome;
    const status = Number(reply && reply.status) || 0;
    const body = reply ? reply.body : null;
    const codes = collectErrors(body);
    if (status === 429 || codes.includes("RATELIMIT") || codes.includes("HTTP_429")) return "rate-limited";
    if (status === 401 || status === 403 || codes.includes("USER_REQUIRED") || codes.includes("HTTP_401") || codes.includes("HTTP_403")) return "auth-error";
    if (!status) return "network-error";
    if (status >= 500) return "server-error";
    if (status === 404) return "endpoint-unavailable";
    if (status !== 200) return "unconfirmed";
    if (!body || typeof body !== "object" || Array.isArray(body)) return "unconfirmed"; // HTML, text, empty
    if (codes.length || body.success === false) return "unconfirmed";
    if (Object.keys(body).length === 0) return "ok";
    if (body.success === true) return "ok";
    if (body.json && Array.isArray(body.json.errors) && body.json.errors.length === 0) return "ok";
    return "unconfirmed";
  }

  /**
   * When Reddit says how long to wait, honour it. Reddit's X-Ratelimit-Reset
   * is "seconds until the window resets" (not an epoch), Retry-After is
   * seconds or an HTTP date, and api_type=json rate-limit errors carry
   * `json.ratelimit` seconds. Returns an absolute timestamp or 0.
   */
  function retryAt(headers, body, now = Date.now()) {
    const get = (name) => {
      try {
        if (!headers) return "";
        if (typeof headers.get === "function") return String(headers.get(name) || "");
        const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
        return key ? String(headers[key] || "") : "";
      } catch { return ""; }
    };
    const seconds = [];
    const retry = get("retry-after");
    if (/^\d+(\.\d+)?$/.test(retry)) seconds.push(Number(retry));
    else if (retry) { const at = Date.parse(retry); if (Number.isFinite(at) && at > now) seconds.push((at - now) / 1000); }
    const reset = get("x-ratelimit-reset");
    if (/^\d+(\.\d+)?$/.test(reset)) seconds.push(Number(reset));
    const fromBody = body && body.json && Number(body.json.ratelimit);
    if (Number.isFinite(fromBody) && fromBody > 0) seconds.push(fromBody);
    const wait = seconds.filter((s) => Number.isFinite(s) && s > 0);
    return wait.length ? now + Math.round(Math.max(...wait) * 1000) : 0;
  }

  /* ---------------------------------------------------------------------------
     Target extraction
     --------------------------------------------------------------------------- */

  /**
   * One scanned page → the posts the engine may act on.
   *
   *   targets – NSFW posts not yet queued or done, normalised exactly like the
   *             capture store's records (so the backup is a usable archive)
   *   stale   – ids already marked removed that Reddit still lists. A stale id
   *             blocks any completion claim until a fresh sweep no longer shows it.
   *   counts  – what the page contained, for diagnostics
   */
  function extractTargets(rows, { done, queued, capturedAt } = {}) {
    const counts = { rows: 0, nsfw: 0, sfw: 0, comments: 0, other: 0 };
    const targets = [];
    const stale = [];
    const seen = new Set();
    const stamp = capturedAt || new Date().toISOString();
    for (const raw of Array.isArray(rows) ? rows : []) {
      counts.rows++;
      const kind = S ? S.classifyRow(raw) : "other";
      if (kind === "sfw-post") { counts.sfw++; continue; }
      if (kind === "comment") { counts.comments++; continue; }
      if (kind !== "nsfw-post") { counts.other++; continue; }
      counts.nsfw++;
      const post = S.normalizePost(raw, stamp);
      if (!post || !post.id || seen.has(post.id)) continue;
      seen.add(post.id);
      if (done && done.has(post.id)) stale.push(post.id);
      else if (!queued || !queued.has(post.id)) targets.push(post);
    }
    return { targets, stale, counts };
  }

  return { UNSAVE_PATH, PACING, RETRYABLE, buildUnsaveRequest, collectErrors, classify, retryAt, extractTargets };
});
