# X Bookmarks Exporter

A local Chrome/Chromium MV3 extension that captures the signed-in account's **Bookmarks** timeline and exports an XReels-compatible JSON file.

## Install and use

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select this `xextension/` directory.
3. Sign in to X and open `https://x.com/i/bookmarks` in the active tab.
4. Open the extension popup and select **Start capture**. Keep the tab open while the adaptive sweep runs. Pause/stop are safe; completed chunks are persisted as it goes.
5. Select **XReels JSON** to download a full `{ export_version, bookmarks: [...] }` export. In XReels, choose **Import → Upload JSON**. The export contains text-only bookmarks too; enable **Settings → Keep text-only posts** in XReels if they should appear in the media library.

The extension observes the authenticated page's bookmark-timeline responses; it does not ask for an X password, call an external service, or upload the archive. `unlimitedStorage` is used so large local bookmark libraries do not stop at Chromium's small default extension-storage quota.

## Capture and verification

- The scroller accelerates through rendered rows and brakes near the infinite-scroll boundary. It waits on actual bookmark-response activity instead of fixed multi-second delays between every pass.
- Only recognized bookmark-timeline payloads are normalized. Unrelated GraphQL tweets (home recommendations, sidebars, etc.) are ignored.
- IDs are de-duplicated exactly. Similar text is **not** considered a duplicate, because two distinct posts may legitimately share a caption.
- Data is stored in 256-post chunks to avoid rewriting the entire archive after every batch. Existing `xBookmarks` arrays are migrated lazily and kept compatible with older installs. Export refuses to silently proceed if a chunk is missing or the stored count does not match its metadata.
- **Coverage check** compares unique tweet IDs observed in captured X responses with IDs persisted in the library, reports duplicates/invalid IDs, and shows large Snowflake-ID jumps as *heuristic hints only*. X does not expose a reliable total bookmark count in this flow, and ID gaps alone can never prove a skipped bookmark.
- Reaching a quiet end after repeated bottom checks is a strong operational signal, not a guarantee that X served every historical/locked/deleted bookmark.

## Tests

From the repository root:

```sh
node --test xextension/tests/*.test.mjs
```
