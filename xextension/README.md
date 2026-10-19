# X Bookmarks Exporter

A local Chrome/Chromium MV3 extension that captures the signed-in account's **Bookmarks** timeline and exports an XReels-compatible JSON file — plus paced **Unfollow everyone** and **Unsave all bookmarks** engines with local backups and saved checkpoints.

## Install and use

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select this `xextension/` directory.
3. Sign in to X and open `https://x.com/i/bookmarks` in the active tab.
4. Open the extension popup and select **Start capture**. Keep the tab open while the adaptive sweep runs. Pause/stop are safe; completed chunks are persisted as it goes.
5. Select **XReels JSON** to download a full `{ export_version, bookmarks: [...] }` export. In XReels, choose **Import → Upload JSON**. The export contains text-only bookmarks too; enable **Settings → Keep text-only posts** in XReels if they should appear in the media library.

## Popup layout

The popup now requests a taller **420 × 720** frame with four tabs — **Capture**, **Unfollow**, **Unsave**, **Export** — under a context-aware header. Chrome may cap native popups at 600px (or less on a small display); the middle region scrolls at either height, so long checklists and recovery instructions remain reachable while the header, tabs, activity log and footer stay put. Arrow/Home/End keys navigate the tabs.

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
- Capture, unfollow and unsave share a browser-owned Web Lock, preventing simultaneous runs across x.com tabs in the same browser profile. Pausing/stopping releases the lease; tab close/crash releases it automatically. No racing read-then-write storage flag is used as the lock.

## Unsave all bookmarks (removes bookmarks from X)

After updating, **reload the extension in `chrome://extensions` and refresh your
X tab** so the new MAIN-world bridge and content scripts are installed.

1. Capture/export first if you want an independent archive.
2. Open the signed-in account's main **`https://x.com/i/bookmarks`** page (not a
   bookmark folder), then choose **Unsave → Unsave all bookmarks**.
3. Read and confirm the destructive-action dialog. Cancel sends no Start command.
4. Keep the X tab open. Closing only the popup does not interrupt the engine.
   **Pause** or **Stop** waits for the single in-flight request and saves the
   remaining queue. Start/Resume requires confirmation again.
5. **Backup JSON** downloads `x-unsave-backup.json`, containing the locally
   backed-up post records, raw tweet data when supplied by X, links, timestamps
   and confirmed outcomes. It is not an automatic undo or a media-file download.

This changes your actual X bookmarks on every device; it does **not** delete the
posts, captured exports, XReels data files, or any Following relationships.
Re-bookmarking must be done manually. Export the backup before **Reset data**:
reset forgets this engine's records only and does not put bookmarks back.

### Discovery and execution

- The bridge observes X's own **Bookmarks/BookmarksAll** request and reuses its
  live variables and feature flags, rather than guessing API feature settings or
  clicking unstable DOM selectors. It reads exact top-level bookmark tweet IDs;
  quotes, recommendation modules, folder responses and unrelated timelines never
  become removal targets. Deleted/tombstoned entries retain their exact ID.
- It learns the rolling **DeleteBookmark** operation ID from live traffic or X's
  own loaded bundles. IDs are cached separately from UnfollowUser. A stale
  operation is forgotten and re-derived, not counted as a successful removal.
  If discovery is unavailable, remove one bookmark manually on X and Resume to
  calibrate the operation; there is no guessed bulk-delete or REST fallback.
- Every target's full backup record and backup index are saved **before** it is
  eligible for execution. Large raw backups are separate per-post records
  (`xUnsavePost.<account>.<tweet>`), not a giant array rewritten after each action.
  A storage failure stops the engine before any unbacked target is removed.
- One request is in flight at a time. Only HTTP 200 with the explicit
  `data.tweet_bookmark_delete: "Done"` payload counts as removed. Empty success
  objects, HTML, errors and unknown schemas retain the target and stop safely.
- Removing bookmarks shrinks the feed and can invalidate pagination. The engine
  re-reads the live **head** after each drained batch instead of trusting old DOM
  scroll positions. If X returns already-processed head entries it may traverse
  the observed bottom cursor, then returns to a fresh head check. Repeated stale
  or unfamiliar pages pause for review, never masquerading as completion.
- Completion requires **two separate empty live-head responses**, with no
  unknown entries or pagination cursor. This confirms only the feed X served;
  X can withhold historical, locked or otherwise unavailable bookmarks. Reload
  X after completion to refresh the site's own cached display.

### Pacing, recovery and account scope

- Uses the same unit-tested `XPacing` warm-up, jittered delays, irregular waves,
  rolling governor (~26/min ceiling), exponential backoff and retry budget as
  Unfollow. 429 responses also honor Retry-After/rate-reset headers. Authentication
  failures stop; consecutive transport failures trip the breaker.
- Each invocation pauses at 2,500 attempts or 3 hours. Queue + done IDs + counters
  are saved after mutations and on pause/stop, with a serialized 15-second
  heartbeat. Resume resets the invocation budget but preserves completed IDs.
- The readable X `twid` account cookie scopes both the isolated engine and the
  bridge. Unknown identity, account switches, expired (7-day) sessions, and folder
  routes are refused rather than acting on a different account. Return to the
  original account to resume, or export/reset the old backup before a new one.
- A running checkpoint can auto-resume after reload only in its **own** tab and
  account (sessionStorage ownership). Paused/stopped runs never auto-resume.
  Another tab requires an explicit Start; if an old run still shows Running after
  its tab was closed, press Stop to reconcile its status, then Resume.
- Pause/Stop does not reverse a request already sent to X. A timed-out request's
  result may be uncertain; reload the bookmarks page before resuming. The bridge
  bounds network requests and does not launch a second overlapping mutation.
- Pacing is conservative, not a promise of account safety. X may impose limits
  or change its private API. No live account was cleared as part of automated
  testing; test carefully with your own intentionally disposable bookmarks.

## Reddit saved posts (NSFW only)

The **Export** tab has a second section, **Reddit saved · NSFW only**. It captures the signed-in account's own saved posts that Reddit tags over-18, and exports them as `reddit-nsfw-saved.json`.

1. Log in to `old.reddit.com` and turn on **Show NSFW content** in your preferences. Reddit hides NSFW rows otherwise.
2. Open `https://old.reddit.com/user/<your-name>/saved` in the active tab, reload it once after installing the extension, then open the popup on **Export** and select **Start capture**.
3. The run reads the rendered rows, then follows the page's **next** links with same-origin requests, using your browser session. It never calls the Reddit API.

What is kept: posts only (`t3_`), and only rows marked NSFW (the `over18` class or `data-nsfw="true"`). SFW posts are counted but not stored, and comments are skipped. Each record has `id`, `title`, `subreddit`, `author`, `permalink`, `url`, `domain`, `score`, `comments`, `created_at`, `thumbnail` and `media`. Media is `{kind, url}` for `i.redd.it` (image), `v.redd.it` (video) and galleries (the post permalink). Nothing is downloaded.

Export shape: `{ export_version: 1, exported_at, source: "reddit-saved-nsfw", account, count, scan: {pages, rows, nsfw_kept, sfw_skipped, comments_skipped}, posts: [...] }`.

Behaviour:
- Pages are paced 2.5–5 s apart, with a longer 8–20 s break every 8–14 pages. A 429 or 5xx response is retried with jittered backoff (30 s doubling, capped at 5 min). A login or age-check redirect stops the run with a message.
- Pause and Stop keep the position, and Start resumes from the next unprocessed page. Reset clears every captured post; it is refused while a run is live.
- Posts are stored in 256-item chunks under `redditSavedChunk.NNNNNN`, with `redditSavedMeta` and `redditCaptureState`. A capture belongs to one account. Starting it for a different account requires a Reset first.
- A Web Lock stops two saved-listing tabs from capturing at once.

Limits and unverified points:
- The DOM selectors and the NSFW markers were written from old.reddit's markup and checked only against fixtures. They have not been run against a live account. Confirm on your own saved page before relying on the output.
- Reddit's saved listing stops around 1,000 items. Posts beyond that cap will not appear.
- Media URLs are links, not files. `i.redd.it` and `preview` URLs are signed or time-limited, and `v.redd.it` audio is a separate DASH track, so links can stop working later.
- Reddit has said it intends to restrict old.reddit.com to logged-in use and to curb abusive scraping. This section depends on that page continuing to render server-side. Automated access may breach Reddit's terms and can get the account restricted. Use it at your own risk.

Tests for the pure logic are in `tests/reddit-saved.test.mjs`. The DOM and popup paths were checked with a jsdom harness outside the repo.

## Design system

`m3e/` is a mirrored copy of the dashboard design system (the sync tool is not part of this repo). If you refresh the mirror, re-run the smoke tests — the copy has previously arrived with a broken UMD wrapper in `color.js`, HTML-entity damage in `interactions.js`, and a `tokens.css` block accidentally nested inside `:root`, all of which silently disable parts of the popup.

## Tests

From the repository root:

```sh
node --test xextension/tests/*.test.mjs
```

Covered: bookmark capture and conservative removal parsing; Following-list parsing;
pacing/governor/backoff; operation discovery and cache isolation; bridge single-flight
requests; browser-owned exclusivity; backup-before-delete; pause/stop/resume; rate
limits; account/route guards; session budgets; and chunked-store integrity.

Popup browser tests (synthetic Chrome APIs; **no real X requests or mutations**):

```sh
npm ci
IMPECCABLE_BROWSER=/path/to/chrome node --test xextension/tests/popup.browser.mjs
```

These check the 720px preferred and 600px capped frames, scrolling, four-tab
keyboard navigation, confirmation/cancellation, live counters, pause/stop, and
scoped accessibility in light/dark mode. Screenshots stay under `.audit/extension/`.
