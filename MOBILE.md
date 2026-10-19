# XReels — Mobile adaptation audit

**Status:** Android implementation done (2026-10-19) — see §7. iOS-only items M-02, M-06, M-09, M-23 were intentionally skipped.
**Lens:** Impeccable `adapt` (desktop → mobile web), verified against `PRODUCT.md` and `DESIGN.md` §5.
**Scope:** phones, portrait first (320–430 px), plus short landscape and iPad-sized touch.

---

## 1. Method and what the evidence is worth

The app was authored as a desktop cinema: mouse hover, keyboard shortcuts, a wide stage, and
`max-width` breakpoints layered on top. The target context is a phone held in one hand —
touch only, ~390 px wide, iOS Safari and Android Chrome, safe-area insets, rotation, and an
intermittent connection.

**Evidence used:** a full static read of the mobile-relevant CSS and JS (breakpoints, gesture
handlers, overlay and router code, media pipeline). Every item below cites `file:line`.

**Evidence not used:** no device runs, no emulator, no screenshots, no gesture tests.
`npm run test:ui` cannot run in this checkout (no `node_modules`, no Chrome) and `.audit/tests`
does not exist. `adapt.md` is explicit that screenshots and resized viewports verify layout,
never a gesture — so gesture claims are marked `[verify]` and must be exercised on hardware
before they are called fixed.

Tags: `[code]` = derived directly from source (high confidence), `[verify]` = needs an iPhone
and an Android phone. Effort: **S** ≤ ½ day, **M** ≈ 1–2 days, **L** > 2 days.

---

## 2. The list at a glance

| ID | Tier | Area | Issue | Effort | Evidence |
|----|------|------|-------|--------|----------|
| M-01 | 0 | Watch / Viewer | Scrollable info cards and thumbnail strip cannot be panned | S–M | `[code]` |
| M-02 | 0 | Forms | Inputs are 14.5 px → iOS zooms the page on focus | S | `[code]` |
| M-03 | 0 | Discover | Billboard trailer streams on phones behind a hidden frame | S | `[code]` |
| M-04 | 1 | Overlays | Android Back leaves the page instead of closing the sheet | M | `[verify]` |
| M-05 | 1 | Tiles / Insights | Hover styles stick after a tap | S–M | `[code]` |
| M-06 | 1 | Tiles | Long-press races the iOS image callout | S | `[verify]` |
| M-07 | 1 | Rails | Horizontal scrollers trigger the iOS back-swipe | S | `[code]` |
| M-08 | 1 | Watch | Player options live in the hardest thumb zone | S | `[code]` |
| M-09 | 1 | Watch | Fullscreen / PiP buttons are dead on iPhone | S | `[code]` |
| M-10 | 1 | Viewer | Swipe-down-to-close missing; no touchcancel | M | `[verify]` |
| M-11 | 1 | Sheets | Keyboard covers sheet inputs | S–M | `[verify]` |
| M-12 | 1 | Global | Several controls are under 44 × 44 | S | `[code]` |
| M-13 | 1 | Watch | Toasts land on the seek bar in immersive mode | S | `[code]` |
| M-14 | 2 | Watch | Screen sleeps during playback (no Wake Lock) | S | `[code]` |
| M-15 | 2 | Watch | No Media Session: no lock-screen controls | M | `[code]` |
| M-16 | 2 | Shell | Not installable: no manifest / icons / standalone | M | `[code]` |
| M-17 | 2 | Post menu | No Share, though `platform.share()` exists | S | `[code]` |
| M-18 | 2 | Shell | Pauses on hide, never resumes — policy undefined | S | `[code]` |
| M-19 | 2 | Input | `isTouch` is true on touchscreen laptops | S | `[code]` |
| M-20 | 3 | Layout | `100vw` / `dvh` / mixed `vh` geometry | S | `[code]` |
| M-21 | 3 | Global | Only two surfaces suppress the tap highlight | S | `[code]` |
| M-22 | 3 | Dock | "Collections" truncates at 320 px | S | `[code]` |
| M-23 | 3 | Import | iOS file picker can hide JSON exports | S | `[verify]` |
| M-24 | 3 | Perf | No measured mobile budget; overscan untuned | M | `[verify]` |
| M-25 | 3 | Guardrails | Nothing stops these regressing | S–M | — |
| M-26 | 3 | Library | Sort is reachable but its state is invisible | S | `[code]` |

If only five things ship: **M-01, M-02, M-03, M-04, M-11**.

---

## Tier 0 — broken on a phone today

### M-01 · Scrollable cards inside Watch and Viewer are inert
`[code]` · S–M · Watch, Viewer · **P0**

**Evidence.** `.watch` sets `touch-action: none` (`styles/features/watch.css:2`) and `.viewer`
does the same (`styles/features/viewer.css:12`). Inside them, `.watch-info-card`
(`watch.css:228`), `.viewer-info-card` (`viewer.css:555`) and `.viewer-strip`
(`viewer.css:433`, scroller at `:447`) are `overflow: auto`. The JS deliberately steps aside for
exactly those regions — `watch/index.js:355` and `viewer/index.js:619`, `:685` — i.e. the code
expects the browser to pan them. It cannot: a `touch-action` of `none` on an ancestor wins, so
the effective action is `none` for the whole subtree.

**Why it matters.** A long caption, the technical-details block, or a 40-thumbnail strip simply
cannot be moved with a finger. On touch the Watch card is capped at `min(56vh, 460px)`
(`watch.css:303`) — ~218 px on a 390 px-tall screen — so a normal caption overflows and the
overflow is unreachable.
`DESIGN.md` §5 treats the scrubber as a control and the card as content; content that cannot be
scrolled is not content.

**Fix sketch.**
- Move `touch-action: none` off the surface root onto the element that owns the gesture:
  `.cell-stage` in Watch (`watch.css:10`), `.viewer-media-box` + `.viewer-overlay` in Viewer.
- Give the scrollers back the axis they need: `.watch-info-card`, `.viewer-info-card`
  `{ touch-action: pan-y; overscroll-behavior: contain; }`; `.viewer-strip` `{ touch-action: pan-x; }`.
- Leave the surface roots on `manipulation` so double-tap stops zooming when the app means
  "seek −10 s" (`DESIGN.md` §5, *Double-tap seeks*).
- No JS change needed — the handlers already ignore these regions.

**Done when.** On iPhone Safari and Android Chrome: a 30-line caption scrolls inside its card
without changing posts; the viewer strip slides; the feed still swipes vertically; pinching the
stage does not zoom.

---

### M-02 · iOS zooms the page whenever a field is focused
`[code]` · S · Global · **P0** · `DESIGN.md` §5 violation

**Evidence.** `.input` inherits the 14.5 px body size (`styles/base.css:7`,
`styles/components.css:34`); `textarea.input` is 12.5 px (`components.css:46`); the Library
search field inherits 14.5 px (`library.css:24`); the palette *reduces* its 16 px base
(`palette.css:19`) to 15 px on phones (`palette.css:59`). iOS Safari zooms the visual viewport
when a focused field is under 16 px, and does not zoom back out cleanly — the layout stays
scaled and the dock is clipped.

`DESIGN.md` §5 *Touch Targets* already says it: "On touch, inputs and selects are at least
44 px tall and use 16 px text to avoid iOS focus zoom." The header search field is the one place
that already follows it (`styles/shell.css:255`).

**Fix sketch.** One rule, in the shared `[data-touch="on"]` layer:
`.input, .select, textarea.input, .lib-search, .palette-input { font-size: 16px; }` plus
`min-height: 44px` for `.input`/`.select`. Delete the 15 px palette override. Do not scale the
whole UI up — only fields.

**Done when.** Focusing Library search, a Settings text field, the import textarea and the
palette on an iPhone leaves the page at scale 1 and the dock fully visible.

---

### M-03 · The billboard trailer streams on phones, behind a hidden frame
`[code]` · S · Discover · **P0** (data + battery)

**Evidence.** Discover builds a trailer video and calls `video.play()` unconditionally when the
hero post has video (`src/features/discover/index.js:113–116`), choosing the *highest*-bitrate
source (`:115`). Below 768 px the entire `.billboard-frame` is `display: none`
(`styles/editorial.css:128`) and a static `.bb-mobile` artwork card is shown instead. The video
element still has a real `http(s)` `src` and starts fetching and playing, muted, on the phone.

**Why it matters.** A phone on cellular downloads and decodes a trailer it never shows, on the
screen where the app opens. It also competes with the images of the first shelf for bandwidth
on a slow connection.

**Fix sketch.** Build the `<video>` only when
`matchMedia("(min-width: 768px)").matches && !navigator.connection?.saveData && !reducedMotion`;
on a breakpoint change, `pause()` + remove `src` + `load()`. Keep the poster image path exactly
as it is now on phones.

**Done when.** With a 390 px viewport and clear cache, the network panel shows no
`video.twimg.com` media request from the billboard; at ≥768 px the trailer still autoplays muted.

---

## Tier 1 — per-surface fixes

### M-04 · Android Back skips the overlay and leaves the page
`[verify]` · M · Overlays (post sheet, palette, dialogs, player options)

**Evidence.** The router listens only to `hashchange`
(`src/infrastructure/router/hash.js`); `back()` is `history.back()` with a route fallback
(`src/application/services/navigation.js`). Menus, sheets and dialogs open without pushing any
history state (`src/ui/menu.js`, `src/ui/dialog.js`). `dialog.closeAll()` exists
(`dialog.js:94`) but is only used by the post menu (`post-menu.js:36`). So with a sheet open,
Back goes to the previous route — or exits the app — and the sheet is destroyed by the route
change rather than dismissed.

**Why it matters.** Back is *the* dismiss gesture on Android, and the escape hatch for a
mis-tap. Today it costs the user their place in the feed.

**Fix sketch.** A small overlay stack: on open, `history.pushState({ xrOverlay: id }, "",
location.href)`; on `popstate`, close the topmost overlay; on programmatic close, call
`history.back()` only if the current entry carries our marker. Keep the hash untouched so the
`hashchange` router never sees it. Register the stack once in the shell, not per feature.

**Done when.** Android: open a post sheet → Back closes it and the Library keeps its scroll
position; Back again returns to the previous route. iOS: the *edge-swipe* does not navigate away
from an open sheet (it should either be blocked or close the sheet — pick one and document it).

---

### M-05 · Hover states stick after a tap
`[code]` · S–M · Tiles, Insights, Viewer chrome

**Evidence.** `.tile:hover .tile-media` lifts the card 3 px and adds a shadow
(`styles/components.css:232`); `.tile:hover .tile-play` reveals the play glyph (`:253`); Insights
has an unguarded `.top-item:hover` (`styles/features/insights.css:6`) and `.stat-link:hover`
(`components.css:107`). On iOS a tap applies `:hover` until the next tap elsewhere, so the last
opened tile stays raised with a play badge, and a "top item" stays highlighted. Only some hover
affordances are mirrored for touch (`.tile-more` at `components.css:260`).

**Fix sketch.** Wrap every visual `:hover` in `@media (hover: hover)`; where hover carried
meaning (reveal the More button, the play glyph) add an explicit `:active` or
`[data-touch="on"]` equivalent. This is a mechanical sweep across `styles/`, not a redesign —
purely decorative hovers can stay.

**Done when.** Tap a tile, open it, come back: the tile is flat and its play glyph hidden. Tap
outside an Insights row: no row is highlighted.

---

### M-06 · Long-press opens the sheet and the iOS image menu
`[verify]` · S · Tiles, cards

**Evidence.** Tiles open the post sheet from a 450 ms long-press (`src/ui/tile.js:98–108`) and
*also* handle `contextmenu` (`tile.js:96`). iOS Safari does not fire `contextmenu` for touch, but
it does show the "Save Image / Copy" callout for a long-pressed `<img>` at roughly the same
moment. Nothing in `styles/` sets `-webkit-touch-callout` or `user-select` on media. The result
can be two overlapping menus, or a text-selection loupe over a caption.

**Fix sketch.** `-webkit-touch-callout: none; user-select: none` on `.tile-media`, `.cell-stage`
and the caption blocks; keep the existing `contextmenu` prevention. Leave real text selectable
where copying matters (the info-card caption) by overriding `user-select: text` there.

**Done when.** A 700 ms press on a tile produces exactly one sheet, no image callout and no
selection loupe; the caption inside the Watch info card can still be selected.

---

### M-07 · Horizontal rails fight the iOS back-swipe
`[code]` · S · Library chips, Insights, bulk bar, viewer strip

**Evidence.** These are horizontal scrollers with no scroll containment:
`.chip-row-body` (`styles/features/library.css:94`), `.insights .stat-grid`
(`insights.css:27`), `.cal-grid` (`insights.css:78`), `.bulk-bar` (`library.css:154`),
`.viewer-strip` (`viewer.css:447`). Containment exists only on the vertical surfaces — `body` (`base.css:10`), `.outlet`
(`shell.css:6`), `.menu-sheet` (`components.css:193`) and `.palette-list` (`palette.css:30`). None of
the horizontal scrollers has it.

**Why it matters.** On iOS, a leftward swipe that begins on a rail near the screen edge is
claimed by the browser's back-navigation gesture; on Android the rail can rubber-band the
document instead of itself. In a Library whose filter chips are the main navigation, this is a
constant small failure.

**Fix sketch.** `overscroll-behavior-inline: contain` (plus `overscroll-behavior-x: contain` for older engines) on every horizontal scroller, and make sure the scroller's padding lets the
first/last item sit inside the safe area (already true for the chip row, `library.css:95`).

**Done when.** Swiping a chip rail from its left edge at the screen edge scrolls the chips and
never navigates back; reaching the end of a rail does not move the page.

---

### M-08 · Watch puts its rarest controls in the hardest place to reach
`[code]` · S · Watch

**Evidence.** The top bar holds Back, Fit, PiP, Player options and Fullscreen
(`src/features/watch/index.js:40–45`); the thumb-friendly bottom-right rail holds only Sound,
Info and More (`:46–49`). Below 900 px, Fit and PiP are hidden and Options is revealed
(`watch.css:192–193`) — so the phone bar is Back · title · Options · Fullscreen at the very top
of a 844 px screen, while the empty left edge of the bottom bar stays unused.

**Why it matters.** `adapt.md`'s thumbs-first rule. Player options is the phone's entry to
fit/fill, PiP and Up next (`watch/index.js:305–311`) — a primary control sitting at the top edge.

**Fix sketch.** After M-09 removes the iPhone-dead Fullscreen, move **Player options** into the
side rail (or a bottom-edge chip) on touch; keep the top bar for Back + title. Do not duplicate
it in both places.

**Done when.** Every control used mid-playback (sound, options, info, more) is reachable with a
thumb while holding the phone one-handed; the top bar contains only navigation.

---

### M-09 · Fullscreen and PiP are dead buttons on iPhone
`[code]` · S · Watch

**Evidence.** `platform.fullscreen()` only knows the standard Fullscreen API and its webkit
alias, and returns `true` silently when neither exists
(`src/infrastructure/platform/index.js:38–44`). iPhone Safari exposes neither on a `<div>`, so the
button does nothing at all — no error, no feedback. PiP checks `v.requestPictureInPicture`
(`watch/index.js:273`), which iPhone Safari also lacks, and flashes "Picture-in-picture not
supported" from a control that was offered anyway.

**Fix sketch.** Capability-detect at render, not at click: show Fullscreen only if
`document.fullscreenEnabled || root.webkitRequestFullscreen`, else use `video.webkitEnterFullscreen()`
for iPhone (native player takes over — document that trade-off) or hide the control. Hide PiP
unless `video.requestPictureInPicture || video.webkitSetPresentationMode`. Never ship a control
whose only outcome is an error toast.

**Done when.** On iPhone and Android, every visible player control performs its action on the
first tap; on desktop nothing changes.

---

### M-10 · The Viewer's swipe has no lifecycle and no way out
`[verify]` · M · Viewer

**Evidence.** The Viewer binds passive `touchstart/move/end` and computes a swipe on release
(`src/features/viewer/index.js:616–690`). There is no `touchcancel` — verify by grep: Watch has
one (`watch/index.js:445`), Viewer does not. There is no downward dismiss, and the desktop
prev/next arrows are removed on touch (`viewer.css:241`), so vertical swipe is the *only* way to
move between posts. A system gesture (Control Center, notification shade, a call) can leave the
gesture state half-applied.

**Why it matters.** `DESIGN.md` §5 says "Gestures have lifecycles … Cancellation … clear pending
work." The Viewer is the app's full-screen detail view; the bottom-sheet idiom (drag down to
dismiss) is what a thumb expects there.

**Fix sketch.** Add `touchcancel` → reset transform/state. Add a downward drag that rubber-bands
the frame and closes past ~80 px (or 0.35 × height), with `prefers-reduced-motion` falling back
to a fade. Keep horizontal for prev/next or delete it deliberately — an unused axis is fine, an
unfinished one is not.

**Done when.** Triggering a system gesture mid-swipe leaves the frame in a clean position; a
100 px downward drag closes the Viewer and returns focus to the originating tile.

---

### M-11 · The keyboard covers the field you are typing in
`[verify]` · S–M · Sheets and dialogs

**Evidence.** Nothing in `src/` references `visualViewport` (grep: zero hits), and the viewport
meta has no `interactive-widget` (`index.html:4`). Bottom sheets are pinned with
`bottom: 0` and `max-height: min(86dvh, …)` (`components.css:186–190`); phone dialogs align to
`end` (`components.css:162`). `dialog.prompt` is used for "Save this view"
(`library/index.js:332`) and collection naming, so a text field sits at the bottom edge exactly
where the iOS keyboard appears. The sheet does not move.

**Fix sketch.** Add `interactive-widget=resizes-content` to the viewport meta (fixes Chrome
Android). Add one `visualViewport` listener in the shell that writes
`--kb-inset: <innerHeight − vv.height − vv.offsetTop>` on `<html>`, and pad `.menu-sheet`,
`.dialog` and `.palette` by `var(--kb-inset, 0px)`; reset on `blur`. Keep the field scrolled
into view in the sheet's own scroller.

**Done when.** On an iPhone, opening "Save this view" from the Library More sheet keeps the
input, Cancel and Save visible above the keyboard at 390 × 844 and at 320 × 568.

---

### M-12 · Several controls are under the 44 px target
`[code]` · S · Global

**Evidence.** `.toast-x` is a 14 px icon with 4 px padding, ≈22 px (`components.css:147`);
`.palette-close` is 34 × 34 (`palette.css:22`); `.lib-more` is 40 × 40 (`library.css:44`);
`.btn-sm` is 30 px (`components.css:28`); `.seg` is 28 px (`components.css:53`); `.chip` is 34 px
(`components.css:70`). A grep for 44-px sizing finds only 15 declarations across all of `styles/`. The
Library has already solved this once, correctly, with a touch layer
(`library.css:166–167`).

`DESIGN.md` §5 allows the fix explicitly: "A smaller drawing may use a transparent hit-area
extension (for example the tile's 30 px More circle has a 44 px hit area)."

**Fix sketch.** Prefer a `::after { inset: -Npx }` hit-area extension so the visual language does
not change; bump only where the extra padding fits (palette close, toast close, lib-more). Add
`:active` feedback so the larger invisible target still feels connected to the drawing.

**Done when.** Measured interactive boxes on a 390 px device are ≥44 × 44 for toast dismiss,
palette close, library More, segmented controls and chips (spacing may overlap the extension).

---

### M-13 · Toasts land on the seek bar in immersive Watch
`[code]` · S · Watch

**Evidence.** `.toast-host` sits at `bottom: calc(18px + var(--bottom-nav-h))`
(`components.css:136`). In immersive Watch the dock is removed and the variable is zeroed
(`shell.css:384`), so a toast appears 18 px from the bottom — on top of `.cell-bar`, whose
scrubber is a 44 px hit band with the clock beside it (`watch.css:46`). Watch
itself mostly uses the in-viewport HUD flash, but global toasts (star, copy, share) still fire.

**Fix sketch.** In immersive mode only, offset the toast host above the player bar:
`:root:has(.app-immersive) .toast-host { bottom: calc(18px + 72px + env(safe-area-inset-bottom, 0px)); }`
(or route Watch-originated toasts through `flash()`).

**Done when.** A toast fired from the Watch side rail never covers the scrubber, elapsed time or
play button, portrait or landscape.

---

## Tier 2 — platform integration

### M-14 · The screen sleeps while a video plays
`[code]` · S · Watch

**Evidence.** No `navigator.wakeLock` anywhere in `src/` (grep: zero). A 12-minute bookmark plays
and the phone dims after the OS timeout — the single most common "is this app broken?" moment
for a video app.

**Fix sketch.** Request a screen wake lock when a Watch cell starts playing; release on pause,
on route leave, and on `visibilitychange`; re-request on return if playback resumes. Feature-
detect; a failure is silent (iOS 16.4+, Chrome Android).

**Done when.** On a physical iPhone and Android, 10 minutes of continuous Watch playback does
not dim or lock; pausing releases the lock (verified by the OS indicator / absence of lock).

---

### M-15 · Nothing survives to the lock screen
`[code]` · M · Watch

**Evidence.** Zero `mediaSession` references in `src/`. Locking the phone stops the experience:
no title, no artwork, no play/pause, no next/prev, and headphone buttons do nothing.

**Fix sketch.** On cell activation, set `MediaMetadata` (post author + text excerpt, artwork from
the thumbnail — CSP already allows `pbs.twimg.com`) and handlers for `play`, `pause`,
`previoustrack`, `nexttrack`, `seekbackward`, `seekforward`. Update `setPositionState` on
timeupdate (throttled). Clear on leave.

**Done when.** With the screen off, the lock screen shows artwork/title and its play, pause and
next buttons control the feed; headphone play/pause works.

---

### M-16 · The app cannot be installed
`[code]` · M · Shell

**Evidence.** `index.html` has no manifest link, no `apple-mobile-web-app-*` metas and no
`apple-touch-icon` (`index.html:1–27`). `src/manifest.js` is the *module* load list, not a web-app
manifest. `theme-color` is a fixed `#141414` (`index.html:6`) and is written back as the same
constant (`src/shell/theme.js:25–26`), so the browser chrome never matches the black Watch
surface.

**Why it matters.** A daily-driver media app on a phone belongs on the home screen, without
browser chrome, with a real icon and splash. Right now "Add to Home Screen" produces a generic
tab-like bookmark.

**Fix sketch.** Add `manifest.webmanifest` (`display: standalone`, `theme_color #141414`,
`background_color #0b0b0b`, 192/512 icons incl. one `maskable`), `<link rel="manifest">`,
`apple-touch-icon` (180), `apple-mobile-web-app-title`. Update the theme-color meta to `#000`
while an immersive route is active and back on exit. Serve-time only; the local `file://` mode
degrades gracefully.

**Done when.** Add to Home Screen on iOS and Android launches standalone with the correct icon,
splash colour and status-bar area; no browser URL bar.

---

### M-17 · There is no Share action
`[code]` · S · Post menu / Viewer / Watch

**Evidence.** `platform.share()` exists and is wired to `navigator.share`
(`src/infrastructure/platform/index.js:20`) — but grep finds no caller. The post menu offers
Open on X and Copy link (`src/ui/post-menu.js:21–22`), not Share. On a phone, sharing to a
contact or another app is a top-three action.

**Fix sketch.** Add `{ label: "Share", icon: "share", run: () => actions.share(post) }` above
Copy link when `navigator.share` exists (else show Copy link only). Pass title/text/url; catch
`AbortError` silently. Add the same action to the Viewer rail and the Watch side menu.

**Done when.** Tapping Share opens the native sheet with the post's X link; cancelling produces
no toast or error.

---

### M-18 · Pause on hide has no stated resume policy
`[code]` · S · Shell

**Evidence.** `app.js:52` pauses all playback when the document becomes hidden. Nothing resumes
it, and I found no stated policy about what should happen on return. That is
safe for data, but the user comes back to a frozen frame with no explanation of whether the app
forgot or is waiting.

**Fix sketch.** Decide and write it down. Recommended: remember `{ id, time, wasPlaying }` on
hide; if visible again within 60 s and the route is still Watch, restore position and resume
only if it was playing; otherwise remain paused and show the paused state clearly. Do not
auto-resume after long absences on cellular.

**Done when.** The behaviour is documented in `PRODUCT.md` (or a comment at `app.js:52`) and
matches an iPhone/Android test: home → return in 5 s resumes; return after 5 min stays paused.

---

### M-19 · `isTouch` misreads hybrids
`[code]` · S · Global

**Evidence.** `isTouch()` is `(pointer: coarse) || maxTouchPoints > 0`
(`src/infrastructure/platform/index.js:48`), and drives `data-touch` (`theme.js:21`). That attribute
hides the viewer rail arrows (`viewer.css:241`), forces tile metadata permanently expanded
(`tile.js:78–81`) and hides the Watch arrows (`watch.css:104`). A touchscreen laptop or an iPad with a trackpad — both have a fine pointer —
therefore loses affordances their input supports.

**Fix sketch.** Split capabilities: `hasTouch`, `primaryCoarse = (pointer: coarse)`,
`canHover = (hover: hover)`. Keep `data-touch` for hit-area sizing; add `data-hover` for hover
UI and gate rail arrows and hover-reveal affordances on `canHover`, not on `hasTouch`. This pairs with M-05's
`@media (hover: hover)` sweep.

**Done when.** On a Surface/iPad with a mouse or trackpad, hover previews and rail arrows work;
on a phone they stay hidden; touch targets stay 44 px in both cases.

---

## Tier 3 — polish, robustness, guardrails

### M-20 · Viewport-unit hygiene
`[code]` · S · Layout

`100vw !important` on the phone Viewer frame (`viewer.css:629`) outruns the visual viewport as
soon as a scrollbar or zoom appears; the `100vw` maths in `.rail-item` (`components.css:422`)
has the same edge; `100dvh` is used without a `100vh` fallback (`base.css:6`, `shell.css:4`,
`viewer.css:630`, dialog `92dvh` at `components.css:162`); and fixed chrome mixes `vh` with the
scrolling layer (Watch card `62vh` / `56vh` on touch, `watch.css:235`, `:303`; palette backdrop
`12vh`, `palette.css:5`).

Use `height: 100vh; height: 100dvh` (fallback pattern), replace the frame's `100vw/100dvh` with
`inset: 0` on the already-full-size `.viewer-stage`, and prefer `svh` for the Watch card so it
does not jump when the URL bar collapses.

**Done when.** At 320/390/430 px and at 100 %→150 % text size, no route scrolls horizontally and
the Viewer frame always matches the visible viewport.

---

### M-21 · Tap feedback is inconsistent
`[code]` · S · Global

Only two surfaces suppress the WebKit tap highlight: `.tile` (`components.css:214`) and the dock
link (`shell.css:283`). Every other control shows the grey flash on iOS or has no `:active`
state. `DESIGN.md` §5 asks for press states that feel intentional; `.btn:active` and `.chip:active`
exist (`components.css:14`, `:77`), but the header, rail buttons, sheet items and toast dismiss
have neither a transform nor a tap-highlight reset.

Add `[data-touch="on"] button, [data-touch="on"] a, [data-touch="on"] .tile { -webkit-tap-highlight-color: transparent; }`
and one shared `:active` treatment (opacity/scale 0.98, 90 ms) for icon buttons and menu rows.
Do not remove focus-visible rings.

**Done when.** Every tap in the dock, header, rail and sheet has immediate visual feedback and
no grey flash.

---

### M-22 · The dock is illegible at 320 px
`[code]` · S · Shell

The dock is five equal columns inside 10 px insets (`shell.css:259–286`) → ≈58 px per cell at
320 px; labels are 11 px and `text-overflow: ellipsis`. "Collections" truncates to roughly
"Collect…". `DESIGN.md` §5 accepts truncation, so this is a check, not a violation: if the
shortened label stops identifying the destination, either shorten the IA label at ≤360 px or
drop to icons + a 4 px label gap.

**Done when.** At 320 × 568 all five labels are distinguishable without opening them.

---

### M-23 · The iOS file picker can hide a valid JSON export
`[verify]` · S · Import

`accept=".json,.js,.txt,application/json,text/javascript"` (`src/features/import/index.js:22`).
Files delivered from third-party providers as `public.data` (some cloud drives, some share
extensions) do not match `public.json` by extension alone and can appear greyed out on iOS.
Adding `text/plain,application/octet-stream` costs nothing and widens the net.

**Done when.** A `.json` export stored in iCloud Drive, Google Drive and a Files "On My iPhone"
folder is selectable in Safari; validation still rejects non-XReels JSON with a readable error.

---

### M-24 · No measured mobile budget
`[verify]` · M · Performance

The pipeline is already careful: `saveData` caps player bitrate, HLS is lazy, image size is
capped at dpr ≤ 2 (`src/application/services/media.js`), off-screen images are lazy, the Watch
feed is virtualised ±2 and the Library grid is windowed masonry
(`src/ui/masonry.js:24`, overscan 900). There is no `backdrop-filter` anywhere, which is exactly
right for cheap Android GPUs.

Two untested costs remain: the 900 px masonry overscan mounts ~10 extra tiles on a phone, and
the billboard bug (M-03) is a real byte leak. Do not virtualise further and do not rewrite the
grid — measure first: cold load and 60 s of scrolling on a throttled mid-range Android
(4× CPU, Slow 4G), recording LCP, INP and transferred bytes. Then try
`overscan: innerWidth < 768 ? 600 : 900` and keep it only if the numbers improve.

**Done when.** A baseline table exists (device, network, LCP, INP, bytes) and any tuning change
is justified against it.

---

### M-25 · Nothing stops these regressing
`[code]` · S–M · Tests

`tests/ui.test.mjs` already runs static checks. Add four cheap guards:
1. no `:hover` selector outside `@media (hover: hover)` (allowlist data display);
2. no `touch-action: none` on an element whose subtree contains `overflow: auto`;
3. every `input`/`select`/`textarea` has ≥16 px text and ≥44 px height under `[data-touch]`;
4. every inline `width/height` in px used as a control is ≥44 or has a documented hit-area
   extension.

**Done when.** `npm run check` fails on a deliberate violation of each rule.

---

### M-26 · Sort is reachable but invisible
`[code]` · S · Library

On phones, ordering does exist — inside the Filters sheet, which is retitled *Sort & filter*
below 700 px (`src/features/library/index.js:162–181`). The toolbar button still reads "Filters"
(`:110`), and its badge counts only narrowing filters (`filterCount()`, `:132`), not the order. A
user who switches to "Newest" sees no trace of it once the sheet closes, and the default smart
shuffle is indistinguishable from a deliberate sort.

**Fix sketch.** When the sort differs from the default, show it: a small "Newest" suffix on the
Filters button, or a removable "Sorted by …" chip in the applied row (`renderChips`). Rename the
button "Sort & filter" on phones, matching the sheet it opens.

**Done when.** After choosing a non-default order, the toolbar reflects it without reopening the
sheet, and the filter badge no longer implies only filters.

---

## 3. Verification pass (the part that actually closes this)

`adapt.md` requires real devices and says what each kind of evidence can prove. Batched round,
one iPhone (Safari, notch) and one Android (Chrome, mid-range):

| Check | What to do | Rule |
|---|---|---|
| Layout | 320, 390, 430 portrait; 844 × 390 and 568 × 320 landscape; 150 % text | Screenshots prove layout only |
| Scroll in cards | Long caption in Watch and Viewer; drag the card | M-01 |
| Gestures | Watch swipe, double-tap ±10 s, hold-2×, carousel drag, Viewer swipe, sheet drag | Drag must complete, not just start |
| Cross-axis | Swipe across the seek bar and the chip rail | Page must not move; control must not fire |
| Keyboard | Focus every sheet field | Field + buttons stay visible |
| Back | Android back with sheet, palette, dialog open | Overlay closes first |
| Media | Lock screen, headphone buttons, screen-off audio | Title/art/controls present |
| Data | 60 s on the Library on Slow 4G | No billboard video bytes; no runaway decode |
| Rotation | Rotate mid-playback and mid-sheet | No stale geometry; state preserved |

Record the OS/browser for each row. Anything not run is a reported gap, not a pass.

---

## 4. Already right — do not regress while fixing the above

- Phone navigation matches `DESIGN.md` §5: 56 px bar + 64 px inset dock, 10 px insets, a single
  moving surface with a crimson cap, `84px + safe-area` content reserve
  (`shell.css:200`, `:259–292`), compact 48 px bar in short landscape (`shell.css:296–305`).
- `viewport-fit=cover` and safe-area padding on the header, dock, palette and gate
  (`index.html:4`, `shell.css:58–59`, `palette.css:54`, `site-gate.css:6,52`).
- Immersive Watch removes both the header and the dock and zeroes the reserve
  (`shell.css:314–315`, `:384`).
- Phone palette is a full-screen sheet with top/bottom safe areas and a labelled close
  (`palette.css:50–63`); the site gate is already 60 px tall at 20 px text with
  `inputmode="numeric"` and `autocomplete="off"` (`site-gate.css:28–33`, `site-gate.js:67–70`).
- Watch's thumb-side rail, 44 px seek band, double-tap seek, hold-to-2×, up-next countdown,
  fit cycle and landscape recovery card (`watch.css:206–218`; `watch/index.js:305–311`).
- Player options on phones already carries Fit/fill, PiP and Up next — the DESIGN §5 promise is
  structurally met (`watch/index.js:305–311`); M-09 is about the two dead iOS entries.
- Library collapses its toolbar behind More below 700 px **for grid actions**, keeps Filters
  visible, and gives search/actions a 44 px touch layer (`library.css:88–89`, `:166–167`).
- Insights turns its stat grid into a snapping scroller at 640 px (`insights.css:23–36`); Import
  is one column below 900 px; Settings turns its nav into a pill row below 1000 px.
- The billboard already has a purpose-built phone card with a static artwork, two-line title and
  `52svh` height (`editorial.css:125–135`) — the bug is only the hidden trailer still playing.
- The media pipeline: `saveData` bitrate cap, dpr-capped images, lazy loading, windowed masonry.
  Do not virtualise the Library and do not add a separate mobile bundle.

---

## 5. Anti-patterns to avoid (from `adapt.md`, applied)

- **Do not hide features on mobile.** The Library already does this well: the toolbar collapses
  below 700 px but Select/Shuffle/Views move into More and Sort moves into the *Sort & filter*
  sheet (`library/index.js:162–181`). Every "simplify for phones" pass must preserve that
  destination, not just the removal.
- **Do not scale the desktop UI down.** Fix targets and text sizes; do not zoom the app.
- **Do not trust DevTools for gestures.** Every Tier 0/1 gesture fix needs a phone.
- **Do not chase device widths.** The existing content-driven breakpoints (700/767/768/900/1023)
  are fine; add range checks, not new device buckets.
- **Do not fork the codebase.** One responsive app, feature-detected (`hover`, `pointer`,
  `visualViewport`, `navigator.share`, `wakeLock`), not UA-sniffed.

---

## 6. Suggested order

1. **Week 1 — stop the bleeding:** M-01, M-02, M-03, then M-11 (keyboard) and M-12 (targets).
2. **Week 2 — make the surfaces feel native:** M-04, M-05, M-06, M-07, M-08, M-09, M-10, M-13.
3. **Week 3 — platform:** M-14, M-15, M-16, M-17, M-18, M-19.
4. **Then:** M-20–M-26, the device pass in §3, and re-run this audit against the result.

Definition of done for the whole effort: the §3 table passes on one iPhone and one Android, the
four guards in M-25 run in CI, and none of the §4 behaviours regressed.


---

## 7. Implementation status — Android only

Scope decision: the app ships on **Android phones**. Every item that affects Android was implemented.
M-02, M-06, M-09 and M-23 are iOS-Safari-specific and were skipped; no iOS forks, UA sniffing or
separate mobile bundle were added. Evidence is static (`npm run check`, `node --check`); no device or
emulator was available, so every `[verify]` item below remains **unverified on hardware**.

| ID | State | Change |
|----|-------|--------|
| M-01 | fixed | `watch.css`: `.watch` is `manipulation`, `.cell-stage` owns `none`; `.watch-info-card` is `pan-y` + `overscroll-behavior: contain`. `viewer.css`: `.viewer` is `manipulation`, `.viewer-media-box` owns `none`; `.viewer-info-card` `pan-y`, `.viewer-strip` `pan-x`. |
| M-02 | n/a on Android | Focus zoom is iOS-only. Field sizing is still per `DESIGN.md` §5: `.input/.select` get 16 px + 44 px under `[data-touch]`, and the palette no longer drops to 15 px on phones. |
| M-03 | fixed | `discover/index.js`: the trailer is only built and played at ≥768 px, skips `saveData`/reduced-motion, and drops its `src` when the viewport narrows. |
| M-04 | fixed | `src/ui/overlay-history.js` (one history entry per open overlay, synthetic pops ignored, no back after a route change) wired into menu, dialog and palette; registered in `src/manifest.js`. |
| M-05 | fixed (visible states) | Tile lift/play badge, Insights rows/heatmap, header links, dialog choices and chips only react to `[data-hover="on"]`; press states carry the feedback instead. |
| M-06 | skipped | iOS image callout only. |
| M-07 | fixed | Horizontal containment on chip rail, bulk bar, rail track, Insights stat grid, calendar grid and viewer strip. |
| M-08 | fixed | Player options moved to the side rail on touch (`.side-options`), top-bar options hidden under `(hover: none)`; still exposed on pointer devices. |
| M-09 | skipped | iPhone-only controls. Unrelated hardening stays: PiP is hidden/skipped when the engine lacks it and the fullscreen button hides when no Fullscreen API exists. |
| M-10 | fixed | Viewer gained `touchcancel` (settles the frame) and swipe-down-to-close **at the first post**, so the same gesture still means "previous" elsewhere. |
| M-11 | fixed | `interactive-widget=resizes-content` in the viewport meta; `visualViewport` drives `--kb-inset`; sheets, dialogs and the palette pad by it. Android Chrome resizes natively, so the inset is 0 there. |
| M-12 | fixed | 44 px targets for toast dismiss, palette close (transparent `::after`), library More, viewer close, sheet rows and dialog choices; `btn-sm`/`seg`/`chip`/`input` were already covered by `[data-touch]`. |
| M-13 | fixed | `:root:has(.app-immersive) .toast-host` clears the 44 px player bar. |
| M-14 | fixed | Screen Wake Lock follows the active cell ("playing"/"paused"), re-acquired on return, released on pause, cell change, unmount and hide. |
| M-15 | fixed | Media Session metadata + play/pause/prev/next/±10 s handlers, throttled `setPositionState`; handlers cleared on unmount. |
| M-16 | fixed | `manifest.webmanifest` (standalone, maskable 192/512 icons in `assets/icons/`), `<link rel="manifest">`, and `theme-color` follows immersive `.app` (`#000000` / `#141414`). Apple metas omitted with iOS. |
| M-17 | fixed | "Share…" in the post menu when `navigator.share` exists (Watch side sheet and Viewer More both use it); cancel is silent. |
| M-18 | fixed | `wireGlobals()`: remembers a playing handle on hide, resumes only if still connected, away <60 s and still on Watch; otherwise stays paused. Policy documented in the code comment. |
| M-19 | fixed | `data-hover` now gates hover UI, rail arrows and tile metadata; `data-touch` remains for hit areas only. |
| M-20 | fixed | `100vh`→`100dvh` fallbacks (body, app, dialogs, sheet, viewer frame), `svh` for the Watch card and palette offset, viewer frame is `100%` not `100vw`. `.rail-item`'s `100vw` is left: Android has no layout scrollbar. |
| M-21 | fixed | Tap highlight suppressed for touch controls; shared `:active` scale for header/rail/menu/choice/toast targets. |
| M-22 | fixed | ≤360 px: dock insets 8 px and 10 px labels, so "Collections" fits without truncation. |
| M-23 | skipped | iOS file picker only. |
| M-24 | **gap** | Not measured: needs a throttled mid-range Android. Masonry overscan (900) and the media pipeline are unchanged on purpose. |
| M-25 | fixed | `tools/lint-mobile.mjs` runs in `npm run check`; it guards touch-action ownership, scroll axes/containment, field/target sizes, hover gating, viewport/manifest/icons and overlay-history wiring. |
| M-26 | fixed | A non-default order now prints its label on the Filters button (`.lib-sort-flag`) and is announced in its `aria-label`; the sheet is still titled *Sort & filter*. |

### What is still unproven

`[verify]` rows from §3 (gestures, keyboard, Android Back, lock screen, install, 320 px labels and
performance) need a real phone. Static checks prove the rules exist, not that a drag completes.
