(() => {
  if (window.__xBookmarkCaptureInstalled) return;
  window.__xBookmarkCaptureInstalled = true;

  const isCandidateUrl = (url) => {
    if (typeof url !== "string") return false;
    return url.includes("/graphql/") || url.includes("/i/api/");
  };

  const isTimelineJson = (text) =>
    typeof text === "string" &&
    (text.includes("tweet_results") ||
      text.includes("TimelineAddEntries") ||
      text.includes("full_text"));

  const forward = (payload) => {
    try {
      window.postMessage(
        { source: "x-bookmark-exporter", type: "bookmarks-response", payload },
        "*"
      );
    } catch {}
  };

  const readContentType = (response) => {
    try {
      return (response.headers && response.headers.get && response.headers.get("content-type")) || "";
    } catch {
      return "";
    }
  };

  const originalFetch = window.fetch;

  window.fetch = async (...args) => {
    const input = args[0];
    const init = args[1] || {};
    const url = typeof input === "string" ? input : input && input.url;
    const body = typeof init.body === "string" ? init.body : "";

    const response = await originalFetch.apply(this, args);

    if (!isCandidateUrl(url)) return response;

    const contentType = readContentType(response);

    if (!response.ok) {
      forward({ ok: false, status: response.status, contentType });
      return response;
    }

    if (contentType && !contentType.includes("json")) {
      return response;
    }

    response
      .clone()
      .text()
      .then((text) => {
        if (isTimelineJson(text)) {
          try {
            forward({ ok: true, status: response.status, contentType, json: JSON.parse(text) });
          } catch {}
        }
      })
      .catch(() => {});

    return response;
  };

  const originalOpen = window.XMLHttpRequest.prototype.open;
  window.XMLHttpRequest.prototype.open = function (...args) {
    const url = args[1];
    if (isCandidateUrl(url)) {
      this.addEventListener("load", () => {
        const ct = (this.getResponseHeader && this.getResponseHeader("content-type")) || "";
        if (this.status >= 400) {
          forward({ ok: false, status: this.status, contentType: ct });
          return;
        }
        if (isTimelineJson(this.responseText)) {
          try {
            forward({ ok: true, status: this.status, contentType: ct, json: JSON.parse(this.responseText) });
          } catch {}
        }
      });
    }
    return originalOpen.apply(this, args);
  };

  // WebSocket fallback: history/bookmarks may stream over WS.
  try {
    const OrigWS = window.WebSocket;
    if (OrigWS && OrigWS.prototype) {
      const Wrapped = function (...args) {
        const ws = new OrigWS(...args);
        try {
          ws.addEventListener("message", (ev) => {
            try {
              const data = typeof ev.data === "string" ? ev.data : null;
              if (data && isTimelineJson(data)) {
                forward({ ok: true, status: 200, contentType: "application/json", json: JSON.parse(data) });
              }
            } catch {}
          });
        } catch {}
        return ws;
      };
      Wrapped.prototype = OrigWS.prototype;
      Wrapped.CONNECTING = OrigWS.CONNECTING;
      Wrapped.OPEN = OrigWS.OPEN;
      Wrapped.CLOSING = OrigWS.CLOSING;
      Wrapped.CLOSED = OrigWS.CLOSED;
      window.WebSocket = Wrapped;
    }
  } catch {}
})();