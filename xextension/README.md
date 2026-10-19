# X Bookmarks Exporter

A local Chrome/Chromium MV3 extension that captures the signed-in account's **Bookmarks** timeline and exports an XReels-compatible JSON file — plus a paced **Unfollow everyone** engine that clears the account's Following list without acting like a bot.

## Install and use

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select this `xextension/` directory.
3. Sign in to X and open `https://x.com/i/bookmarks` in the active tab.
4. Open the extension popup and select **Start capture**. Keep the tab open while the adaptive sweep runs. Pause/stop are safe; completed chunks are persisted as it goes.
5. Select **XReels JSON** to download a full `{ export_version, bookmarks: [...] }` export. In XReels, choose **Import → Upload JSON**. The export contains text-only bookmarks too; enable **Settings → Keep text-only posts** in XReels if they should appear in the media library.

## Popup layout

The popup is a fixed 384 × 600 frame with three tabs — **Capture**, **Unfollow**, **Export** — under a header that always states what the current tab can do. Only the middle region scrolls; the activity log and footer stay put.

- The tab you land on follows the page you opened the popup from (a Following page opens Unfollow, a bookmarks page opens Capture), or a run that is already live.
- A pulsing dot on a tab shows a run continuing while you are looking at another tab; a square dot means it is paused.
- The collapsed activity summary carries the latest log line, so a run never looks silent.
- Long explanations live behind disclosures instead of pushing actions below the fold.

The extension observes the authenticated page's bookmark-timeline responses; it does not ask for an X password, call an external service, or upload the archive. `unlimitedStorage` is used so large local bookmark libraries do not stop at Chromium's small default extension-storage quota.

## Capture and verification

- The scroller accelerates through rendered rows and brakes near the infinite-scroll boundary. It waits on actual bookmark-response activity instead of fixed multi-second delays between every pass.
- Only recognized bookmark-timeline payloads are normalized. Unrelated GraphQL tweets (home recommendations, sidebars, etc.) are ignored.
- IDs are de-duplicated exactly. Similar text is **not** considered a duplicate, because two distinct posts may legitimately share a caption.
- Data is stored in 256-post chunks to avoid rewriting the entire archive after every batch. Existing `xBookmarks` arrays are migrated lazily and kept compatible with older installs. Export refuses to silently proceed if a chunk is missing or the stored count does not match its metadata.
- **Coverage check** compares unique tweet IDs observed in captured X responses with IDs persisted in the library, reports duplicates/invalid IDs, and shows large Snowflake-ID jumps as *heuristic hints only*. X does not expose a reliable total bookmark count in this flow, and ID gaps alone can never prove a skipped bookmark.
- Reaching a quiet end after repeated bottom checks is a strong operational signal, not a guarantee that X served every historical/locked/deleted bookmark.

## Unfollow everyone (paced mass-unfollow)

Popup → **Unfollow everyone** → confirm. From any x.com tab the engine opens your Following list itself; on `x.com/<you>/following` it starts immediately.

### How it works

- **Discovery** rides the same interception technology as capture: the page hook forwards Following-timeline GraphQL responses, and `following.js` extracts exact user IDs (entryId `user-<digits>` plus the `following` flag). Who-to-follow modules embedded in the list are never treated as targets, and stale rows X marks `following: false` are skipped.
- **Execution** is single-flight through `bridge.js`, a MAIN-world bridge that replays the X web client's own request shape: same origin, same cookies, same CSRF/bearer headers, same `UnfollowUser` mutation. No credentials are requested — the bridge *observes* the authorization and `x-csrf-token` headers on requests the signed-in page already makes.
- **Rolling operation IDs**: the `UnfollowUser` queryId is learned from the app's own GraphQL URLs, lazily parsed from the page's script bundles when never observed, and falls back to the stable v1.1 `friendships/destroy` path. If an ID goes stale mid-run (GraphQL 400/404), the engine drops it, requeues the account, and re-derives — a transport miss never marks a user done.
- **Human pacing** (`pacing.js`, unit-tested): a warm-up ramp (first 6 actions slower), ±35% jittered gaps around a 2.4 s base, irregular 7–14-action waves followed by 7–22 s "reading" pauses, and a closed-loop governor that stretches delays whenever the measured rate crosses the ~26/min ceiling.
- **Backpressure**: HTTP 429 and 5xx ride exponential full-jitter backoff (6 s → 5 min, 10 retries); 401/403 stop the run; 5 consecutive transport failures trip the breaker. Rate limits don't count toward the breaker — X saying "slow down" is not a defect.
- **Sessions and safety valves**: queue + done-set + counters persist every 30 s, so closing the tab loses nothing and an orphaned run auto-resumes only when its owner is gone (per-tab `sessionStorage` heartbeat prevents double-runs). Each Start gets a 3-hour/2,500-attempt budget and then pauses with a *resumable* checkpoint — thousands of back-to-back unfollows in one sitting is exactly what looks inhuman.
- **Backup**: every targeted account is appended to a local JSON backup (`xUnfollowBackup`) with discovery timestamp and outcome. The popup's **Backup** button exports it for review or re-following. **Reset unfollow data** clears engine records only.
- Capture and unfollow refuse to run at the same time — one engine per profile.

## Design system

`m3e/` is a mirrored copy of the dashboard design system (the sync tool is not part of this repo). If you refresh the mirror, re-run the smoke tests — the copy has previously arrived with a broken UMD wrapper in `color.js`, HTML-entity damage in `interactions.js`, and a `tokens.css` block accidentally nested inside `:root`, all of which silently disable parts of the popup.

## Tests

From the repository root:

```sh
node --test xextension/tests/*.test.mjs
```

Covered: bookmark timeline extraction, Following-list parsing (recommendation exclusion, dedupe, tri-state flags), the pacing/governor/backoff/outcome-classification engine, and chunked store integrity.
