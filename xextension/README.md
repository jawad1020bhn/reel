# XReels Exporter

A local Chrome/Chromium MV3 side-panel extension for two sites, one account each:

- **X** — captures the signed-in account's **Bookmarks** timeline into an XReels-compatible JSON export, plus paced **Unfollow everyone** and **Unsave all bookmarks** engines with local backups and saved checkpoints.
- **Reddit** — captures the signed-in account's **NSFW saved posts** from old.reddit.com (with playable video URLs), plus a paced **Unsave NSFW saved posts** engine built on the same backup-before-delete, verify-before-complete model.

(The extension was called *X Bookmarks Exporter* until 1.5; existing installs and storage keys are unchanged.)

## Install and use

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**. Requires Chrome 116 or newer.
2. Select this `xextension/` directory.
3. Sign in to X and open `https://x.com/i/bookmarks` in the active tab.
4. Click the toolbar icon to open the **side panel**, then select **Start capture**. Keep the tab open while the adaptive sweep runs. Pause/stop are safe; completed chunks are persisted as it goes.
5. Select **XReels JSON** to download a full `{ export_version, bookmarks: [...] }` export. In XReels, choose **Import → Upload JSON**. The export contains text-only bookmarks too; enable **Settings → Keep text-only posts** in XReels if they should appear in the media library.

## Side panel layout

The UI runs in Chrome's **side panel**, not a popup. Clicking the toolbar icon opens it (`openPanelOnActionClick`), and it stays open while you move between tabs. The panel takes the full height of the window and whatever width you give it, so nothing is pinned to a fixed frame. The header, site switcher, tabs, activity and footer stay in view, and only the middle region scrolls, so long checklists and recovery instructions remain reachable.

- The first row picks the **site**: **X** or **Reddit**. Each card shows what is in its local library (bookmarks / NSFW saved posts) and carries the same running/paused dot as the tabs, so a run on one site stays visible while you work on the other.
- Each site has its own job tabs with the same vocabulary. X: **Capture**, **Unfollow**, **Unsave**, **Export**. Reddit: **Capture**, **Unsave**, **Export**. Arrow/Home/End keys navigate within the visible tablist; each site remembers its last tab.
- Every job panel is built the same way: a status card (colour + dot shape + word, never colour alone), four counters, one primary action, Pause/Stop, then backup/reset in the panel foot and the explanations in collapsible disclosures. Destructive primaries use the error role; capture primaries are filled.
- The panel opens on whatever matters now: a live X engine, then a live Reddit engine, then the site of the page you are looking at.
- Below about 340px wide the stat tiles drop to a 2 × 2 grid and the site cards stack. Above about 680px the content holds a centred reading column.
- The context hint follows the active tab. Switching tabs or finishing a page load re-checks whether the current page is an X bookmarks or Following page, or a Reddit saved listing (and whose).
- The Activity log is collapsed by default and shared by every panel. Its summary keeps the latest line visible, and when open it takes up to about a third of the panel height.

The extension observes the authenticated page's bookmark-timeline responses; it does not ask for an X password, call an external service, or upload the archive. `unlimitedStorage` is used so large local bookmark libraries fit.

## Capture and verification

- The scroller accelerates through rendered rows and brakes near the infinite-scroll boundary. It waits on actual bookmark-response activity instead of fixed multi-second delays between every pass.
- Only recognized bookmark-timeline payloads are normalized. Unrelated GraphQL tweets (home recommendations, sidebars, etc.) are ignored.
- IDs are de-duplicated exactly. Similar text is **not** considered a duplicate, because two distinct posts may legitimately share a caption.
- Data is stored in 256-post chunks to avoid rewriting the entire archive after every batch. Existing `xBookmarks` arrays are migrated lazily and kept compatible with older installs. Export refuses to silently proceed if a chunk is missing or the stored count does not match its metadata.
- **Coverage check** compares unique tweet IDs observed in captured X responses with IDs persisted in the library, reports duplicates/invalid IDs, and shows large Snowflake-ID jumps as *heuristic hints only*. X does not expose a reliable total bookmark count in this flow, and ID gaps alone can never prove a skipped bookmark.
- Reaching a quiet end after repeated bottom checks is a strong operational signal, not a guarantee that X served every historical/locked/deleted bookmark.

## Unfollow everyone (paced mass-unfollow)

Side panel → **Unfollow everyone** → confirm. From any x.com tab the engine opens your Following list itself; on `x.com/<you>/following` it starts immediately.

### How it works

- **Discovery** rides the same interception technology as capture: the page hook forwards Following-timeline GraphQL responses, and `following.js` extracts exact user IDs (entryId `user-<digits>` plus the `following` flag). Who-to-follow modules embedded in the list are never treated as targets, and stale rows X marks `following: false` are skipped.
- **Execution** is single-flight through `bridge.js`, a MAIN-world bridge that replays the X web client's own request shape: same origin, same cookies, same CSRF/bearer headers, same `UnfollowUser` mutation. No credentials are requested — the bridge *observes* the authorization and `x-csrf-token` headers on requests the signed-in page already makes.
- **Rolling operation IDs**: the `UnfollowUser` queryId is learned from the app's own GraphQL URLs, lazily parsed from the page's script bundles when never observed, and falls back to the stable v1.1 `friendships/destroy` path. If an ID goes stale mid-run (GraphQL 400/404), the engine drops it, requeues the account, and re-derives — a transport miss never marks a user done.
- **Human pacing** (`pacing.js`, unit-tested): a warm-up ramp (first 6 actions slower), ±35% jittered gaps around a 2.4 s base, irregular 7–14-action waves followed by 7–22 s "reading" pauses, and a closed-loop governor that stretches delays whenever the measured rate crosses the ~26/min ceiling.
- **Backpressure**: HTTP 429 and 5xx ride exponential full-jitter backoff (6 s → 5 min, 10 retries); 401/403 stop the run; 5 consecutive transport failures trip the breaker. Rate limits don't count toward the breaker — X saying "slow down" is not a defect.
- **Sessions and safety valves**: queue + done-set + counters persist every 30 s, so closing the tab loses nothing and an orphaned run auto-resumes only when its owner is gone (per-tab `sessionStorage` heartbeat prevents double-runs). Each Start gets a 3-hour/2,500-attempt budget and then pauses with a *resumable* checkpoint — thousands of back-to-back unfollows in one sitting is exactly what looks inhuman.
- **Backup**: every targeted account is appended to a local JSON backup (`xUnfollowBackup`) with discovery timestamp and outcome. The side panel's **Backup** button exports it for review or re-following. **Reset unfollow data** clears engine records only.
- Capture, unfollow and unsave share a browser-owned Web Lock, preventing simultaneous runs across x.com tabs in the same browser profile. Pausing/stopping releases the lease; tab close/crash releases it automatically. No racing read-then-write storage flag is used as the lock.

## Unsave all bookmarks (removes bookmarks from X)

After updating, **reload the extension in `chrome://extensions` and refresh your
X tab** so the new MAIN-world bridge and content scripts are installed.

1. Capture/export first if you want an independent archive.
2. Open the signed-in account's main **`https://x.com/i/bookmarks`** page (not a
   bookmark folder), then choose **Unsave → Unsave all bookmarks**.
3. Read and confirm the destructive-action dialog. Cancel sends no Start command.
4. Keep the X tab open. Closing the side panel does not interrupt the engine.
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

## Reddit · Capture (NSFW saved posts)

**Reddit → Capture** captures the signed-in account's own saved posts that Reddit tags over-18; **Reddit → Export** downloads them as `reddit-nsfw-saved.json` and can download the videos.

1. Log in to `old.reddit.com` and turn on **I am over eighteen years old and willing to view adult content** in your preferences. Reddit hides NSFW rows otherwise; a fresh capture refuses to start while it is off, or while you are logged out or logged in as someone else.
2. Open `https://old.reddit.com/user/<your-name>/saved` in the active tab, reload it once after installing the extension, then open the side panel on **Reddit → Capture** and select **Start capture**.
3. The run reads the rendered rows, then follows the page's **next** links with same-origin requests, using your browser session. It never calls the Reddit API.

What is kept: posts only (`t3_`), and only rows marked NSFW (the `over18` class or `data-nsfw="true"`). SFW posts are counted but not stored, and comments are skipped. Each record has `id`, `title`, `subreddit`, `author`, `permalink`, `url`, `domain`, `score`, `comments`, `created_at`, `thumbnail` and `media`. Media is `{kind, url}` for `i.redd.it` (image), `v.redd.it` (video) and galleries (the post permalink). Nothing is downloaded.

Export shape: `{ export_version: 1, exported_at, source: "reddit-saved-nsfw", account, count, scan: {pages, rows, nsfw_kept, sfw_skipped, comments_skipped}, posts: [...] }`.

To show these posts in the XReels app, rename the file to `r-posts.json` and place it in the app's `data/` folder (next to `x-posts.json`). The app reads it on every load over http(s). The **Settings → Sources** toggles hide or show Reddit and X posts separately.

Behaviour:
- Pages are paced 2.5–5 s apart, with a longer 8–20 s break every 8–14 pages. A 429 or 5xx response is retried with jittered backoff (30 s doubling, capped at 5 min). A login or age-check redirect stops the run with a message.
- Pause and Stop keep the position, and Start resumes from the next unprocessed page. Reset clears every captured post; it is refused while a run is live.
- Posts are stored in 256-item chunks under `redditSavedChunk.NNNNNN`, with `redditSavedMeta` and `redditCaptureState`. A capture belongs to one account. Starting it for a different account requires a Reset first.
- A browser-owned Web Lock (`xreels-reddit-exclusive-engine`) is shared with the unsave engine: two saved-listing tabs cannot capture at once, and Capture and Unsave never run together.

Limits and unverified points:
- The DOM selectors and the NSFW markers were written from old.reddit's markup and checked only against fixtures. They have not been run against a live account. Confirm on your own saved page before relying on the output.
- Reddit's saved listing stops around 1,000 items. Posts beyond that cap will not appear.
- Media URLs are links, not files. `i.redd.it` and `preview` URLs are signed or time-limited, and `v.redd.it` audio is a separate DASH track, so links can stop working later.
- Reddit has said it intends to restrict old.reddit.com to logged-in use and to curb abusive scraping. This section depends on that page continuing to render server-side. Automated access may breach Reddit's terms and can get the account restricted. Use it at your own risk.

Tests for the pure logic are in `tests/reddit-saved.test.mjs`. The DOM and side panel paths were checked with a jsdom harness outside the repo.

## Reddit · Unsave NSFW saved posts (removes saved posts on Reddit)

**Reddit → Unsave** removes every over-18 post from the logged-in account's saved list, one at a time, and leaves SFW posts and saved comments alone. It is the Reddit counterpart of **Unsave all bookmarks** and keeps the same guarantees: a local backup is written before each removal, only an explicit success counts, completion is verified against the live list, and every run is a resumable checkpoint.

1. Capture and export first if you want an archive with playable video URLs — the unsave backup keeps post data and links only.
2. Stay logged in on `old.reddit.com` with the over-18 preference on, open `https://old.reddit.com/user/<your-name>/saved` in the active tab (reload once after installing), then **Reddit → Unsave → Unsave NSFW saved posts** and confirm. Keep the tab open; Pause/Stop are safe.
3. Afterwards, **Backup JSON** downloads `reddit-unsave-backup.json`: a normal Reddit export (`source: "reddit-saved-nsfw"`, `posts[]` with `fullname`) that the XReels importer accepts, where each post also carries `discovered_at`, `unsaved_at` and `outcome`.

### Discovery and execution

- **Identity first.** Start reads `/api/me.json`: it must report a logged-in user whose name matches the saved list's owner, a modhash, and `over_18: true`. Otherwise the run refuses with `account-mismatch` (naming the signed-in user), `nsfw-hidden`, or `auth-unavailable`. With NSFW hidden, Reddit serves an empty list, which would look like completion — so that state can never complete a run.
- **Discovery reads the live list**, not the captured library: the head page of `/user/<you>/saved/`, then the `next` links, with the capture's own 2.5–5 s page pacing. Only rows that are posts (`t3_`), marked over-18, and not promoted become targets. A login or over-18 wall, a page that is not a saved listing, or a 404 stops before anything is removed (`auth-error`, `schema-mismatch`, `listing-unavailable`).
- **Backup before removal.** Each target is normalized (same record shape as the capture) and written to `redditUnsavePost.<account>.<id>` plus the `redditUnsaveBackup` index *before* it is queued. If that write fails, nothing is sent (`storage-error`); a queued id whose backup is missing is never sent either (`backup-missing`).
- **Execution replays old.reddit's own form** — `POST /api/unsave` with `id=t3_<id>`, `executed=unsaved`, `uh=<modhash>` — same-origin, with your session cookies, one request at a time. No MAIN-world hook is needed, because the CSRF token comes from `/api/me.json` (with the page's `input[name=uh]` as fallback).
- **Only Reddit's explicit success counts** (`{}`, `success: true`, or an empty `errors` list). HTML, `success: false`, unknown 200 bodies and other statuses are `unconfirmed`: the post stays queued and the run stops for review. 429 or `RATELIMIT` → `rate-limited`; 401/403, `USER_REQUIRED` or "please login" → `auth-error`; 5xx → `server-error`; 404 → `endpoint-unavailable`.
- **Verification.** Removing posts shifts Reddit's pagination, so the head of the list is re-read after every batch, and the whole list is swept again when the queue is empty. Completion needs **two clean sweeps** with an 8 s settle between them, plus a final identity check (still logged in, same account, NSFW still visible) — reported as `verified-clean`. A post Reddit keeps listing after a confirmed removal is retried once (unsave is idempotent); if it is still there, the run pauses with `verification-needed` instead of claiming completion.

### Pacing, recovery and account scope

- Same `pacing.js` engine as the X engines: warm-up ramp, jittered gaps, wave breaks, a rate governor and backoff — tuned to about 14 removals per minute for Reddit's tighter web limits. Reddit's own `Retry-After` / `X-Ratelimit-Reset` / `ratelimit` hints are honoured when they exceed the computed backoff.
- Rate limits back off and retry the same post without counting it removed and never trip the error breaker. Server and network errors retry with backoff; five consecutive failures stop the run (`too-many-errors`). An `auth-error` triggers up to two identity refreshes (a rotated modhash is picked up transparently) before stopping.
- Pause and Stop wait for the in-flight request, then save the queue. Each run checkpoints after 1,500 attempts or 3 hours (`run-cap`); Start resumes. Checkpoints belong to one account (`account-changed`) and expire after 7 days (`session-expired`). The engine's heartbeat marks an interrupted run paused on reload; only the same tab and account auto-resume.
- Storage keys: `redditUnsaveState`, `redditUnsaveSession`, `redditUnsaveBackup`, `redditUnsavePost.<account>.<id>`. Reset removes only these; the captured Reddit library and all X data are untouched, and Reset is refused while a run is live.
- The side panel mirrors `redditUnsaveState` live, explains every stop reason in plain words, and never claims more than the checkpoint says.

The same limits apply as for capture: the markup and the `/api/unsave` form were written from old.reddit's pages and verified against fixtures and a fake server, not a live account. Automated unsaving may breach Reddit's terms. Use it at your own risk.

Tests: `tests/reddit-removal.test.mjs` (pure rules: request shape, outcome classification, retry hints, target extraction, DOM readers) and `tests/reddit-unsave.test.mjs` (the engine against a fake old.reddit: backup before removal, NSFW-only targeting, multi-page discovery, pause/stop/resume, unconfirmed and auth failures, rate limits, modhash rotation, scope guards, hidden-NSFW mid-run, sticky posts, reset scope, run cap).

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
limits; account/route guards; session budgets; chunked-store integrity; Reddit saved-list
parsing, video facts, unsave rules and the Reddit unsave engine against a fake server.

Side panel browser tests (synthetic Chrome APIs; **no real X or Reddit requests or mutations**):

```sh
npm ci
IMPECCABLE_BROWSER=/path/to/chrome node --test xextension/tests/popup.browser.mjs
```

These check the 720px preferred and 600px capped frames, scrolling, the site switcher
and per-site keyboard navigation, confirmation/cancellation for both unsave engines,
live counters and site signals, pause/stop, and scoped accessibility in light/dark
mode. Screenshots stay under `.audit/extension/`.
