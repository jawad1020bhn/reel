(() => {
  if (window.__xBookmarkCaptureInstalled) return;
  window.__xBookmarkCaptureInstalled = true;

  const isCandidateUrl = (url) => {
    if (typeof url !== "string") return false;
    return url.includes("/graphql/") || url.includes("/i/api/");
  };

  const isBookmarkRoute = (url, body = "") => {
    try { return /bookmark/i.test(decodeURIComponent(String(url || "") + " " + String(body || ""))); }
    catch { return /bookmark/i.test(String(url || "") + " " + String(body || "")); }
  };

  // The response shape is the authority on successful requests; endpoint slugs
  // vary as X rolls GraphQL operation IDs.
  const isBookmarkTimelineText = (text) => typeof text === "string" &&
    /bookmark_(?:timeline|collection)/i.test(text) && /instructions/i.test(text);

  // Following-list responses share the profile-timeline envelope. Forwarded
  // alongside bookmarks; each consumer filters by its own parser.
  const isFollowingTimelineText = (text) => typeof text === "string" &&
    /"user":\{"result":/.test(text) && /"instructions":/.test(text);

  const isForwardableTimelineText = (text) =>
    isBookmarkTimelineText(text) || isFollowingTimelineText(text);

  const forward = (payload) => {
    try {
      window.postMessage(
        { source: "x-bookmark-exporter", type: "bookmarks-response", payload },
        "*",
      );
    } catch { /* document may be navigating */ }
  };

  const readContentType = (response) => {
    try {
      return response.headers?.get?.("content-type") || "";
    } catch {
      return "";
    }
  };

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const input = args[0];
    const init = args[1] || {};
    const url = typeof input === "string" ? input : input?.url || "";
    const body = typeof init.body === "string" ? init.body : "";

    return originalFetch.apply(this, args).then((response) => {
      if (!isCandidateUrl(url)) return response;
      const contentType = readContentType(response);

      if (!response.ok) {
        if (isBookmarkRoute(url, body)) {
          forward({ ok: false, status: response.status, contentType, url });
        }
        return response;
      }
      if (contentType && !contentType.toLowerCase().includes("json")) return response;

      response.clone().text().then((text) => {
        if (!isForwardableTimelineText(text)) return;
        try {
          forward({ ok: true, status: response.status, contentType, json: JSON.parse(text) });
        } catch { /* ignore malformed or partial JSON */ }
      }).catch(() => {});

      return response;
    });
  };

  const originalOpen = window.XMLHttpRequest.prototype.open;
  window.XMLHttpRequest.prototype.open = function (...args) {
    const url = args[1];
    const candidate = isCandidateUrl(url);
    const bookmarkRoute = candidate && isBookmarkRoute(url);
    if (candidate) {
      this.addEventListener("load", () => {
        let contentType = "";
        let text = "";
        try {
          contentType = this.getResponseHeader?.("content-type") || "";
          if (this.responseType && this.responseType !== "text" && this.responseType !== "") return;
          text = this.responseText;
        } catch { return; }

        if (this.status >= 400) {
          if (bookmarkRoute) forward({ ok: false, status: this.status, contentType, url });
          return;
        }
        if (!isForwardableTimelineText(text)) return;
        try {
          forward({ ok: true, status: this.status, contentType, json: JSON.parse(text) });
        } catch { /* ignore malformed or partial JSON */ }
      });
    }
    return originalOpen.apply(this, args);
  };

  // Fallback for X clients that stream timeline payloads over WebSocket.
  try {
    const OriginalWebSocket = window.WebSocket;
    if (OriginalWebSocket?.prototype) {
      const WrappedWebSocket = function (...args) {
        const socket = new OriginalWebSocket(...args);
        try {
          socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string" || !isForwardableTimelineText(event.data)) return;
            try {
              forward({ ok: true, status: 200, contentType: "application/json", json: JSON.parse(event.data) });
            } catch { /* ignore non-JSON frames */ }
          });
        } catch { /* socket may already be closing */ }
        return socket;
      };
      WrappedWebSocket.prototype = OriginalWebSocket.prototype;
      for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
        WrappedWebSocket[key] = OriginalWebSocket[key];
      }
      window.WebSocket = WrappedWebSocket;
    }
  } catch { /* WebSocket may be locked down by the host page */ }
})();
