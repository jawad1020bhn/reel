/* =============================================================================
   Service worker

   Owns the toolbar badge — the extension's smallest surface, and the only part
   of the UI visible when the popup is closed. It has to obey the same design
   system as everything else, so the badge colour is derived from the live
   theme rather than hard-coded ad-hoc hexes.

   The colours below are the primary / onPrimary pair produced by
   M3EColor.scheme("#5B4CF5", { variant: "vibrant" }) for light and dark.
   They are inlined on purpose: an MV3 service worker that importScripts a
   sibling file fails the entire worker registration if that file is missing
   or fails to resolve at install time (NetworkError on WorkerGlobalScope).
   Keeping the worker self-contained means the badge still paints even when
   the shared colour engine is unavailable to this context.
   ============================================================================= */

const THEME_KEY = "bmPopupTheme";

/** Brand badge colours — keep in lockstep with dashboard/m3e/color.js defaults. */
const BADGE = {
  light: { color: "#373cff", text: "#ffffff" },
  dark: { color: "#d0bcff", text: "#001999" },
};

/**
 * Badge colour = the current scheme's `primary`, with `onPrimary` as the text.
 * A service worker has no DOM and no `matchMedia`, so it cannot detect the OS
 * scheme; it resolves the user's explicit light/dark choice and falls back to
 * light, which is what Chrome assumes for badge contrast anyway.
 */
async function badgeColors() {
  const { [THEME_KEY]: scheme = "system" } = await chrome.storage.local.get({
    [THEME_KEY]: "system",
  });
  return scheme === "dark" ? BADGE.dark : BADGE.light;
}

async function refreshBadge() {
  const { xBookmarkMeta = null, xBookmarks = [] } = await chrome.storage.local.get({ xBookmarkMeta: null, xBookmarks: [] });
  const count = Number.isFinite(Number(xBookmarkMeta?.total))
    ? Math.max(0, Number(xBookmarkMeta.total))
    : Array.isArray(xBookmarks) ? xBookmarks.length : 0;

  // Badges truncate around four glyphs, so large libraries get "12k"/"12.3k"
  // rather than a clipped, meaningless number.
  let text = "";
  if (count >= 1e6) text = Math.floor(count / 1e6) + "M";
  else if (count > 9999) {
    const k = count / 1000;
    text = (k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, "")) + "k";
  }
  else if (count) text = String(count);

  const { color, text: textColor } = await badgeColors();
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: textColor });
  }
  await chrome.action.setTitle({
    title: count
      ? "X Bookmarks Exporter — " + count.toLocaleString() +
        (count === 1 ? " post captured" : " posts captured")
      : "X Bookmarks Exporter",
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "badge") {
    refreshBadge().then(() => sendResponse({ ok: true }));
    return true; // keep the message channel open for the async response
  }
});

// Keep the badge honest even when the change came from somewhere else
// (a reset from the popup, another window, or a sync).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.xBookmarkMeta || changes.xBookmarks || changes[THEME_KEY])) refreshBadge();
});

chrome.runtime.onStartup.addListener(refreshBadge);
chrome.runtime.onInstalled.addListener(refreshBadge);
