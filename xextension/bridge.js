/*
 * Unfollow bridge · MAIN world.
 *
 * Runs inside the page so every request is byte-for-byte what the X web
 * client itself would send: same origin, same cookies, same CSRF token, same
 * bearer, same mutation shape. Nothing here asks for credentials — the
 * bridge OBSERVES the authenticated app's own outgoing traffic:
 *
 *   1. authorization / x-csrf-token headers from any /i/api/ request the page
 *      already makes (the following timeline itself supplies these).
 *   2. The UnfollowUser queryId, learned from the app's own GraphQL URLs the
 *      moment the user (or this bridge) issues one — normal operation IDs roll,
 *      so a hardcoded ID would rot; observation never does.
 *   3. If no UnfollowUser ID has ever been observed on this page, one-time
 *      lazy parse of the page's own script bundles for the operation mapping
 *      (the mapping ships inside them).
 *   4. Fallback chain: v1.1 friendships/destroy — a stable path that needs no
 *      queryId at all — and finally a clear "calibrate once" signal.
 *
 * The bridge never initiates anything on its own; it only answers
 * `x-unfollow-bridge` exec/ping requests from the isolated engine.
 */
(() => {
  if (window.__xUnfollowBridgeInstalled) return;
  window.__xUnfollowBridgeInstalled = true;

  const SOURCE_IN = "x-unfollow-bridge";
  const SOURCE_OUT = "x-unfollow-bridge-result";
  const API_ORIGIN = "https://x.com";

  /* Public web-client bearer. Not a secret: it ships in every X web bundle
     and only identifies the client type. Used solely when the page's own
     live header has not been observed yet. */
  const WEB_BEARER =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

  const captured = { authorization: null, csrf: null };
  const observedQueryIds = new Map(); // operationName -> queryId
  const bundleQueryIds = new Map();
  const bundleScanTimes = new Map();
  const bundleScanPromises = new Map();
  let bookmarkRequest = null;
  let bookmarkBusy = false;

  const originalFetch = window.fetch;
  const originalOpen = window.XMLHttpRequest.prototype.open;
  const originalSetRequestHeader = window.XMLHttpRequest.prototype.setRequestHeader;
  const originalSend = window.XMLHttpRequest.prototype.send;

  /* ------------------------------------------------------------------ *
   * Observation
   * ------------------------------------------------------------------ */

  function normalizeHeaders(headers) {
    const out = {};
    try {
      if (!headers) return out;
      if (typeof headers.forEach === "function") {
        headers.forEach((value, key) => { out[String(key).toLowerCase()] = String(value); });
      } else if (Array.isArray(headers)) {
        for (const pair of headers) {
          if (pair && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1]);
        }
      } else {
        for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = String(value);
      }
    } catch { /* hostile header shape — ignore */ }
    return out;
  }

  function noteRequest(url, headers, method = "GET", body = null) {
    try {
      const text = String(url || "");
      if (!text.includes("/i/api/") || new URL(text, location.href).origin !== location.origin) return;
      const authorization = headers.authorization;
      if (authorization && /^bearer /i.test(authorization)) captured.authorization = authorization;
      const csrf = headers["x-csrf-token"];
      if (csrf && csrf !== "null") captured.csrf = csrf;
      const match = /\/graphql\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_]+)/.exec(text);
      if (match) {
        const [, queryId, operation] = match;
        if (operation && queryId) observedQueryIds.set(operation, queryId);
        if (/^(Bookmarks|BookmarksAll)$/.test(operation)) {
          bookmarkRequest = { url: new URL(text, location.href).href, method: String(method).toUpperCase(), body: typeof body === "string" ? body : null };
        }
      }
    } catch { /* never let bookkeeping break the page */ }
  }

  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url) noteRequest(url, normalizeHeaders(init?.headers || input?.headers), init?.method || input?.method, init?.body);
    } catch { /* continue through */ }
    return originalFetch.apply(this, arguments);
  };

  window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this.__xUnfollowUrl = String(url || "");
      this.__xUnfollowMethod = method;
      this.__xUnfollowHeaders = {};
    } catch { /* continue through */ }
    return originalOpen.call(this, method, url, ...rest);
  };

  window.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (this.__xUnfollowHeaders) this.__xUnfollowHeaders[String(name).toLowerCase()] = String(value);
    } catch { /* continue through */ }
    return originalSetRequestHeader.call(this, name, value);
  };

  window.XMLHttpRequest.prototype.send = function (...args) {
    try {
      if (this.__xUnfollowUrl) noteRequest(this.__xUnfollowUrl, this.__xUnfollowHeaders || {}, this.__xUnfollowMethod, args[0]);
    } catch { /* continue through */ }
    return originalSend.apply(this, args);
  };

  /* ------------------------------------------------------------------ *
   * queryId discovery
   * ------------------------------------------------------------------ */

  /**
   * X ships its operation table inside the loaded bundles as
   * `{queryId:"…",operationName:"UnfollowUser"}` (key order varies). Find the
   * queryId physically closest to the operation name — the mapping entry is
   * co-located, so nearest beats a naive first-match across a multi-MB file.
   */
  function findQueryIdInBundle(text, operationName) {
    if (typeof text !== "string" || !text) return null;
    const queryIds = [];
    const queryIdRe = /queryId:"([A-Za-z0-9_-]{10,})"/g;
    let match;
    while ((match = queryIdRe.exec(text))) queryIds.push({ id: match[1], index: match.index });
    if (!queryIds.length) return null;

    const opRe = new RegExp(`"${operationName}"`, "g");
    let best = null;
    let opMatch;
    while ((opMatch = opRe.exec(text))) {
      for (const candidate of queryIds) {
        const distance = Math.abs(candidate.index - opMatch.index);
        if (distance <= 700 && (!best || distance < best.distance)) {
          best = { id: candidate.id, distance };
        }
      }
    }
    return best ? best.id : null;
  }

  function collectBundleUrls() {
    const urls = [];
    const push = (value) => {
      try {
        if (!value) return;
        const url = new URL(value, location.href);
        if (url.origin !== location.origin && url.hostname !== "abs.twimg.com") return;
        if (!/\.js(?:$|\?)/.test(url.pathname + url.search)) return;
        if (!urls.includes(url.href)) urls.push(url.href);
      } catch { /* unusable href */ }
    };
    for (const script of document.scripts || []) push(script.src);
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        if (entry.initiatorType === "script" || /\.js(?:$|\?)/.test(entry.name)) push(entry.name);
      }
    } catch { /* performance may be restricted */ }
    // The app bundle is nearly always among the first scripts — try it early.
    urls.sort((a, b) => Number(/main/i.test(b)) - Number(/main/i.test(a)));
    return urls;
  }

  async function discoverQueryIdFromBundles(operationName, signal) {
    const now = Date.now();
    if (bundleQueryIds.has(operationName)) return bundleQueryIds.get(operationName);
    if (bundleScanPromises.has(operationName)) return bundleScanPromises.get(operationName);
    if (now - (bundleScanTimes.get(operationName) || 0) < 60000) return null;
    bundleScanTimes.set(operationName, now);

    const promise = (async () => {
      const urls = collectBundleUrls().slice(0, 14);
      for (const url of urls) {
        if (signal?.aborted) return null;
        try {
          const response = await originalFetch(url, { credentials: "include", signal: signal || AbortSignal.timeout(10000) });
          if (!response.ok) continue;
          const text = await response.text();
          const queryId = findQueryIdInBundle(text, operationName);
          if (queryId) {
            bundleQueryIds.set(operationName, queryId);
            observedQueryIds.set(operationName, queryId);
            return queryId;
          }
        } catch { /* try the next bundle */ }
      }
      return null;
    })();

    bundleScanPromises.set(operationName, promise);
    try { return await promise; }
    finally { bundleScanPromises.delete(operationName); }
  }

  /* ------------------------------------------------------------------ *
   * Auth resolution
   * ------------------------------------------------------------------ */

  function resolveAuth() {
    let csrf = captured.csrf;
    if (!csrf) {
      try {
        const match = /(?:^|;\s*)ct0=([^;]+)/.exec(document.cookie || "");
        if (match) csrf = decodeURIComponent(match[1]);
      } catch { /* cookie unreadable */ }
    }
    return {
      authorization: captured.authorization || WEB_BEARER,
      csrf: csrf || null,
      authSource: captured.authorization ? "page" : "builtin",
      csrfSource: captured.csrf ? "page" : (csrf ? "cookie" : "none"),
    };
  }

  /* ------------------------------------------------------------------ *
   * Execution
   * ------------------------------------------------------------------ */

  async function readBody(response) {
    try {
      const text = await response.text();
      try { return { text, json: text ? JSON.parse(text) : null }; }
      catch { return { text, json: null }; }
    } catch {
      return { text: "", json: null };
    }
  }

  async function postJson(url, payload, auth, signal) {
    return originalFetch(url, {
      method: "POST",
      signal: signal || AbortSignal.timeout(25000),
      credentials: "include",
      headers: {
        "authorization": auth.authorization,
        "content-type": "application/json",
        "accept": "*/*",
        "x-csrf-token": auth.csrf,
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-active-user": "yes",
        "x-twitter-client-language": "en",
      },
      body: JSON.stringify(payload),
    });
  }

  async function postForm(url, formBody, auth, signal) {
    return originalFetch(url, {
      method: "POST",
      signal: signal || AbortSignal.timeout(25000),
      credentials: "include",
      headers: {
        "authorization": auth.authorization,
        "content-type": "application/x-www-form-urlencoded",
        "accept": "*/*",
        "x-csrf-token": auth.csrf,
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-active-user": "yes",
        "x-twitter-client-language": "en",
      },
      body: formBody,
    });
  }

  async function executeUnfollow(userId, queryIdHint, signal) {
    if (!/^\d+$/.test(String(userId || ""))) {
      return { ok: false, outcome: "bad-request", detail: "non-numeric userId", transport: null };
    }
    const auth = resolveAuth();
    if (!auth.csrf) {
      return {
        ok: false, outcome: "auth-unavailable", transport: null, authSource: auth.authSource,
        detail: "no CSRF token observed — open x.com and reload",
      };
    }

    let queryId = observedQueryIds.get("UnfollowUser") || bundleQueryIds.get("UnfollowUser") ||
      String(queryIdHint || "") || null;
    let queryIdSource = observedQueryIds.has("UnfollowUser") ? "observed"
      : bundleQueryIds.has("UnfollowUser") ? "bundle"
        : queryIdHint ? "hint" : null;

    if (!queryId) {
      queryId = await discoverQueryIdFromBundles("UnfollowUser", signal) || null;
      queryIdSource = queryId ? "bundle" : null;
    }

    signal.throwIfAborted();
    if (queryId) {
      const url = `${API_ORIGIN}/i/api/graphql/${encodeURIComponent(queryId)}/UnfollowUser`;
      /* `source` mirrors the web client's follow-click payload. If X rejects
         the variables, one retry with the minimal shape covers schema drift. */
      let response = await postJson(url, { variables: { userId: String(userId), source: "follow-click" }, queryId }, auth, signal);
      if (response.status === 400) {
        const first = await readBody(response);
        if (/variable/i.test(first.text || "")) {
          response = await postJson(url, { variables: { userId: String(userId) }, queryId }, auth, signal);
        } else {
          const result = await readBody(response);
          return {
            ok: response.ok, status: response.status, body: result.json, raw: result.text,
            transport: "graphql", queryIdSource, authSource: auth.authSource,
          };
        }
      }
      const body = await readBody(response);
      return {
        ok: response.ok, status: response.status, body: body.json, raw: body.text,
        transport: "graphql", queryIdSource, authSource: auth.authSource,
      };
    }

    /* Stable v1.1 path — needs no rolling queryId. Web sessions with cookie +
       bearer + CSRF still reach friendships/destroy; if X ever retires it,
       the engine's calibration message tells the user how to recover. */
    try {
      const response = await postForm(
        `${API_ORIGIN}/i/api/1.1/friendships/destroy.json`,
        `user_id=${encodeURIComponent(String(userId))}`,
        auth, signal,
      );
      const body = await readBody(response);
      return {
        ok: response.ok, status: response.status, body: body.json, raw: body.text,
        transport: "rest", queryIdSource: "none", authSource: auth.authSource,
      };
    } catch (error) {
      return { ok: false, status: 0, outcome: "network-error", transport: "rest", detail: String(error?.message || error) };
    }
  }

  function retryAt(response) {
    if (response.status !== 429) return 0;
    const retry = response.headers?.get?.("retry-after") || "";
    const fromRetry = /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry) || 0;
    const reset = Number(response.headers?.get?.("x-rate-limit-reset")) * 1000 || 0;
    return Math.max(fromRetry, reset);
  }

  /* Bookmark removal has its own channel and operation cache. No REST guess
     or DeleteAll mutation: one exact tweet ID, one confirmed DeleteBookmark. */
  async function executeBookmark(data, signal) {
    if (!/^\/i\/bookmarks\/?$/.test(location.pathname)) return { outcome: "open-bookmarks" };
    const account = () => {
      try { return /(?:^|;\s*)twid=u=(\d+)(?:;|$)/.exec(decodeURIComponent(document.cookie || ""))?.[1]; }
      catch { return null; }
    };
    if (!data.accountId || account() !== data.accountId) return { outcome: "account-changed" };
    const auth = resolveAuth();
    if (!auth.csrf) return { outcome: "auth-unavailable" };
    if (data.type === "scan") {
      if (!bookmarkRequest) return { outcome: "timeline-unavailable" };
      const template = bookmarkRequest;
      const url = new URL(template.url);
      let payload = null;
      try {
        payload = template.method === "POST" ? JSON.parse(template.body || "{}") : null;
        const variables = payload ? { ...payload.variables } : JSON.parse(url.searchParams.get("variables") || "{}");
        if (data.cursor) variables.cursor = String(data.cursor); else delete variables.cursor;
        if (payload) payload.variables = variables; else url.searchParams.set("variables", JSON.stringify(variables));
      } catch { return { outcome: "timeline-unavailable" }; }
      if (account() !== data.accountId) return { outcome: "account-changed" };
      const response = payload ? await postJson(url.href, payload, auth, signal) : await originalFetch(url.href, {
        method: "GET", credentials: "include", cache: "no-store", signal,
        headers: { authorization: auth.authorization, "x-csrf-token": auth.csrf, "x-twitter-auth-type": "OAuth2Session", "x-twitter-active-user": "yes" },
      });
      const body = await readBody(response);
      return { status: response.status, body: body.json, raw: body.text, retryAt: retryAt(response) };
    }
    if (data.type !== "exec" || !/^\d+$/.test(String(data.tweetId || ""))) return { outcome: "invalid-target" };
    const queryId = observedQueryIds.get("DeleteBookmark") || await discoverQueryIdFromBundles("DeleteBookmark", signal);
    if (!queryId) return { outcome: "calibration-needed" };
    if (account() !== data.accountId || !/^\/i\/bookmarks\/?$/.test(location.pathname)) return { outcome: "account-changed" };
    signal.throwIfAborted();
    const response = await postJson(`${API_ORIGIN}/i/api/graphql/${encodeURIComponent(queryId)}/DeleteBookmark`, {
      variables: { tweet_id: String(data.tweetId) }, queryId,
    }, auth, signal);
    const body = await readBody(response);
    return { status: response.status, body: body.json, raw: body.text, retryAt: retryAt(response) };
  }
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== "x-unsave-bridge") return;
    const data = event.data;
    const reply = (result) => window.postMessage({ source: "x-unsave-bridge-result", id: data.id, ...result }, location.origin);
    if (data.type === "forget") {
      observedQueryIds.delete("DeleteBookmark"); bundleQueryIds.delete("DeleteBookmark"); bundleScanTimes.delete("DeleteBookmark");
      reply({ ok: true }); return;
    }
    if (bookmarkBusy) { reply({ outcome: "bridge-busy" }); return; }
    bookmarkBusy = true;
    executeBookmark(data, AbortSignal.timeout(30000)).then(reply).catch(() => reply({ status: 0, outcome: "network-error" })).finally(() => { bookmarkBusy = false; });
  });

  /* ------------------------------------------------------------------ *
   * Message protocol (isolated engine ⇄ bridge)
   * ------------------------------------------------------------------ */

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== SOURCE_IN) return;

    const reply = (payload) => {
      try { window.postMessage({ source: SOURCE_OUT, id: data.id, ...payload }, "*"); }
      catch { /* document navigating */ }
    };

    if (data.type === "forget") {
      /* Engine observed a stale UnfollowUser operation ID (400/404 on the
         GraphQL path). Drop every cached copy so the next exec re-derives
         from live traffic/bundles or falls to the stable REST path. */
      observedQueryIds.delete("UnfollowUser");
      bundleQueryIds.delete("UnfollowUser");
      bundleScanTimes.delete("UnfollowUser"); // allow an immediate re-scan next time
      reply({ ok: true, forgot: true });
      return;
    }

    if (data.type === "ping") {
      reply({
        ok: true,
        hasAuth: !!captured.authorization,
        hasCsrf: !!(captured.csrf || /(?:^|;\s*)ct0=/.test(document.cookie || "")),
        queryId: observedQueryIds.get("UnfollowUser") || bundleQueryIds.get("UnfollowUser") || null,
        observedOperations: observedQueryIds.size,
      });
      return;
    }

    if (data.type === "exec") {
      if (bookmarkBusy) { reply({ ok: false, status: 0, outcome: "network-error", detail: "bridge-busy" }); return; }
      bookmarkBusy = true;
      Promise.resolve()
        .then(() => executeUnfollow(data.userId, data.queryId, AbortSignal.timeout(30000)))
        .then((result) => reply({ ok: true, ...result }))
        .catch((error) => reply({
          ok: false, outcome: "network-error", status: 0,
          detail: String(error?.message || error),
        })).finally(() => { bookmarkBusy = false; });
    }
  });
})();
