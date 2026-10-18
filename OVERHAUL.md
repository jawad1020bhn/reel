# Impeccable applied to XReels

**2026-10-18 · Impeccable skill 4.6.0 · Mobile UI + player adaptation**

This is an implementation, not just a tool recommendation. It preserves the
**Private Cinema** identity: self-hosted Bebas Neue/Geist, dark surfaces, crimson
accent, existing content and media policy, `XR.define`, plain CSS, no build step.
`PRODUCT.md`, the entry-point CSP, and the MP4/HLS media engine are unchanged.

## Installed tooling

- The official Impeccable skill lives at `.claude/skills/impeccable/`, including
  its launcher and playbooks. `SOURCE.md`, `LICENSE`, and `NOTICE.md` record the
  upstream revision and licensing. The normal installer could not reach its
  bundle host in this sandbox, so the skill was installed from its GitHub source
  archive instead. Browser/engine binaries are **not** committed.
- `AGENTS.md` tells future agents where to find the skill and which constraints
  and checks matter here. The existing product context was read, not regenerated.
- `.impeccable/config.json` exempts only the deliberate Geist/Geist Mono brand
  choice. No quality rule is globally disabled. Hover metadata is properly
  identified as closed supplementary UI rather than suppressing the
  `content-hidden-at-rest` rule.
- Live Mode and edit hooks are **not** enabled. Live Mode's helper needs a
  development-only CSP allowance; this change deliberately does not add one.

Primary upstream references:
[Impeccable](https://github.com/pbakaus/impeccable),
[mobile adaptation](https://github.com/pbakaus/impeccable/blob/main/.agent/skills/impeccable/reference/adapt.md).
Impeccable is development-time guidance/detection, not an app dependency or a
replacement playback engine. OpenUI's generative-UI runtime was not added.

## What changed

### Mobile browsing

- A stable five-item bottom navigation bar below 768px: **Discover, Library,
  Watch, Collections, More**. More retains Creators, Insights, Import, Settings,
  and the command palette. Tablet/desktop navigation remains intact.
- Safe-area-aware bottom spacing for page endings, bulk actions and notifications.
  Watch still uses an immersive layout with Back, not a permanent navigation bar.
- A visible Search action. Closed search is truly hidden and cannot leak into
  the tab order or overflow the viewport. Submitting with Enter no longer
  reopens the search field through an accidental second activation.
- Discover's mobile hero is capped to a compact viewport-relative height, uses
  a two-line title, one primary Play/View action and an icon for details. The
  first shelf is reachable in the initial phone viewport. The redundant mobile
  slate was removed; the desktop slate retains a contrast-safe opaque surface.
- Small-screen rails fit their two-column rhythm instead of clipping a second
  card at 320px. Tile metadata does not require hover on touch or phone widths.
  Virtual masonry reserves the creator-row height.
- Tiles use a real primary button alongside their More/Creator buttons, rather
  than placing buttons inside a parent with `role="button"`. Desktop metadata
  reveals for both pointer and keyboard focus, and hidden metadata is inert.

### Video experience

- Watch and Viewer now have **native range seek controls**, visible thumbs and
  real 44px interaction bands. They expose elapsed/total values to assistive
  technology, support keyboard ±5 seconds and Home/End, and retain touch dragging.
- Watch adds an explicit play/pause control, a **0.5×–2× speed menu**, visible
  elapsed time and a **Tap for sound** action for muted autoplay. The smallest
  phone width keeps elapsed time rather than squeezing in both timestamps.
- On touch, double-tap the left/right flanks to seek **−10s/+10s**. Centre
  double-tap still stars; desktop double-tap retains its existing behaviour.
- Fit/fill, PiP and the queue remain accessible through **Player options** on
  phones instead of relying on keyboard shortcuts for hidden controls.
- Carousel horizontal dragging no longer competes with seeking; vertical
  swiping still changes the feed item. Mixed photo/video albums show playback
  controls only for the video slide.
- Gesture cancellation, leaving a route during a hold, and cell virtualisation
  clean up pending work. Inactive cells are inert. Temporary hold-to-2× restores
  the chosen playback speed on release. Reduced-motion seek feedback stays visible.
- Short landscape layouts retain the recovery card's width cap and reflow its
  buttons. Nonfunctional sound controls do not overlap the failed-media card.
  **Retry creates a fresh player attachment**; manual **Next** works even when
  automatic advancement is disabled.
- A Star notification no longer intercepts a speed-menu selection. The first
  tap after idle reveals controls without unexpectedly pausing the video.

### Design-system consistency

- Functional CSS text now has an internal **11px legibility floor**. This is a
  project quality threshold, **not** an absolute WCAG font-size requirement.
- Muted text was lifted to `#9b9b9b` for raised surfaces. Crimson text uses the
  existing contrast-safe `#ff6b74` tint instead of the darker fill colour.
- Duration badges, menu/section labels, rail labels, footer text, and chart labels
  were updated. Skipped heading levels in Insights/shortcuts were corrected.
- Nested recap/data-management cards became quiet ledger rows. `DESIGN.md` now
  records the applied mobile/player rules and updated token values.

## Repeatable verification

The app still runs directly from `index.html`. The npm dependencies added here
are **dev-only** (`puppeteer-core`, `axe-core`); they are not loaded by the app.
Node 22+ and an installed Chrome/Chromium are needed for these checks.

```sh
npm ci
npm run check

# Isolated browser regression tests. No running server or real library needed.
IMPECCABLE_BROWSER=/path/to/chrome npm run test:ui

# In a separate terminal, serve the actual app for rendered detector scans:
python3 -m http.server 8899 --bind 0.0.0.0
IMPECCABLE_BROWSER=/path/to/chrome npm run audit:ui

# Optional screenshots/measurements of the served app:
IMPECCABLE_BROWSER=/path/to/chrome npm run audit:ui -- --shots

# CSS-only scan (not a substitute for rendered inspection):
npm run audit:ui -- --static

# Narrow a follow-up scan:
AUDIT_VIEWPORTS='390x844 844x390' AUDIT_ROUTES='watch' \
  IMPECCABLE_BROWSER=/path/to/chrome npm run audit:ui
```

`AUDIT_URL` can select a different served entry URL. The audit runner saves each
scan's JSON/diagnostics and returns **0** for no primary findings, **2** for
findings, **1** for an incomplete/erroring scan. It retries one tooling failure;
a missing browser, unreachable server or invalid detector output cannot count
as a pass. `index.html` alone is not an adequate static scan: the app loads its
styles through the manifest at runtime.

### Evidence from this implementation

- **11 browser regression tests passed.** They exercise native seeking on a real
  synthetic 32-second WebM, CDP-generated touch input, double-tap seeking, playback
  speed/mute, carousel-vs-feed axis handling, cancellation, hold release, Retry,
  manual Next, mobile navigation/search, keyboard tile activation, reduced motion,
  idle behaviour, and the `file://` launch path with the original CSP.
- **30 rendered Impeccable scans passed**: Discover, Library, Watch, Settings and
  Insights at 320×568, 360×800, 390×844, 768×1024, 844×390 and 1440×960. The CSS
  scan also returned zero findings/advisories. Only brand-font value exceptions
  were active.
- The scoped axe checks cover names, labels, ARIA values and nested interactive
  controls on the new navigation, hero, tile grid and Watch player. This is not
  a claim of complete WCAG conformance.
- Screenshots and separate hit-target/overflow/heading/runtime metrics are saved
  under **`.audit/` (Git-ignored)**. The visual audit excludes hidden/inert controls,
  recognises transparent hit-area extensions, and reports dense chart marks
  separately instead of miscounting clipped/offscreen rails as page overflow.
- Architecture/dependency lint, JavaScript syntax checks and `git diff --check`
  passed. No runtime/build framework, CSP relaxation or private data change was
  introduced.

## Limits and remaining device checks

- These are **Chromium** tests with emulated viewports and synthesized touch,
  not physical-device or Safari tests. Verify iOS Safari/Android Chrome safe
  areas, browser chrome/keyboard, rotation, fullscreen, PiP, HLS and sound on
  actual devices before calling the overhaul device-validated.
- The sandbox cannot reach X's image/video CDN. Rendered audits of the real
  library therefore include unavailable-media states. The isolated playback
  tests use a tiny, synthetic local fixture, not mocked media APIs; that proves
  interaction behaviour, not the availability of the user's remote videos.
- Captions/quality menus were not invented where the current media model supplies
  no subtitle tracks or selectable playback-quality API. The existing media
  engine/fallback policy remains in place.
- Dense heatmap/SVG chart marks need a separate accessibility review; a clean
  Impeccable scan is not a universal 44px target or WCAG-conformance guarantee.
