/*
 * Reddit DOM readers, shared by the capture and unsave content scripts.
 *
 * old.reddit.com renders a saved listing server-side: one `.thing` element per
 * saved item, with the facts the engines need on data attributes. Everything
 * here reads a Document (the live page or a DOMParser result) into plain
 * objects; the rules that decide what the objects mean live in reddit-saved.js
 * and reddit-removal.js, where they are unit-tested.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XRedditDom = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function absoluteRedditUrl(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    if (text.startsWith("//")) return "https:" + text;
    if (text.startsWith("/")) return "https://www.reddit.com" + text;
    return text;
  }

  /** Read one `.thing` row into the plain object reddit-saved.js expects. */
  function readRow(el) {
    const attr = (name) => el.getAttribute(name) || "";
    const titleEl = el.querySelector("a.title");
    const thumbEl = el.querySelector(".thumbnail img");
    const timeEl = el.querySelector("time[datetime]");
    let timestamp = Number(attr("data-timestamp")) || 0;
    if (!timestamp && timeEl) timestamp = Date.parse(timeEl.getAttribute("datetime")) || 0;
    return {
      fullname: attr("data-fullname"),
      className: el.className,
      nsfw: attr("data-nsfw"),
      promoted: attr("data-promoted"),
      title: titleEl ? titleEl.textContent : "",
      subreddit: attr("data-subreddit"),
      author: attr("data-author"),
      permalink: attr("data-permalink"),
      url: absoluteRedditUrl(attr("data-url")),
      domain: attr("data-domain"),
      score: attr("data-score"),
      comments: attr("data-comments-count"),
      timestamp,
      thumbnail: thumbEl ? absoluteRedditUrl(thumbEl.getAttribute("src")) : "",
      isGallery: attr("data-is-gallery"),
    };
  }

  function readRows(doc) {
    return Array.from(doc.querySelectorAll(".thing")).map(readRow);
  }

  function nextHref(doc) {
    const link = doc.querySelector('a[rel~="next"]');
    return link ? link.getAttribute("href") : null;
  }

  /**
   * A listing page always carries the `#siteTable` container, even when it
   * has nothing to show ("there doesn't seem to be anything here"). A page
   * without it is not a listing — a login wall, an error page, or a markup
   * change — and must never be read as "no saved posts left".
   */
  function isListing(doc) {
    return !!doc.querySelector("#siteTable, .sitetable.linklisting");
  }

  /** Logged-in signal: old.reddit adds `loggedin` to <body>. */
  function looksLoggedIn(doc) {
    return !!(doc && doc.body && doc.body.classList.contains("loggedin"));
  }

  /**
   * The session modhash (Reddit's CSRF token) is embedded in the page's own
   * forms as a hidden `uh` input — the logout form always carries one for a
   * signed-in user. Fallback only; /api/me.json is the primary source because
   * it also names the account the cookie belongs to.
   */
  function modhash(doc) {
    const input = doc.querySelector('input[name="uh"]');
    const value = input ? String(input.value || input.getAttribute("value") || "") : "";
    return /^[A-Za-z0-9]{10,}$/.test(value) ? value : null;
  }

  /** Reddit answered with a login wall or the over-18 interstitial. */
  function isGateUrl(url) {
    return /\/(login|over18)(?:[/?#]|$)/i.test(String(url || ""));
  }

  return { absoluteRedditUrl, readRow, readRows, nextHref, isListing, looksLoggedIn, modhash, isGateUrl };
});
