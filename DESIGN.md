---
name: XReels
description: Local-first cinematic viewer for personal X bookmarks, a private streaming service in a single file
colors:
  void: "#000000"
  zinc-page: "#18181b"
  sunken-well: "#101012"
  control-fill: "#1f1f23"
  hover-fill: "#2a2a2e"
  hover-fill-strong: "#3a3a3f"
  card-void: "#0b0b0b"
  glass-panel: "#141416"
  glass-panel-strong: "#1c1c1f"
  ink: "#f8f8f8"
  ink-muted: "#8f8f8f"
  hairline: "#222222"
  crimson: "#e50914"
  crimson-hot: "#f6121d"
  amber: "#ffc425"
  teal: "#54b9c5"
  success: "#46d488"
  warning: "#ffb547"
typography:
  display:
    fontFamily: "Bebas Neue, Arial Narrow, Impact, sans-serif"
    fontSize: "clamp(2.2rem, 4.5vw, 3.4rem)"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.015em"
  eyebrow:
    fontFamily: "Bebas Neue, Arial Narrow, Impact, sans-serif"
    fontSize: "10.5px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.16em"
  body:
    fontFamily: "Geist, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  pill: "999px"
spacing:
  gutter: "16px"
  tile-gap: "8px"
  header: "64px"
components:
  tile:
    rounded: "{rounded.lg}"
  button-pill:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.void}"
    rounded: "{rounded.pill}"
  button-pill-hover:
    backgroundColor: "rgba(248,248,248,0.85)"
    textColor: "{colors.void}"
    rounded: "{rounded.pill}"
  button-accent:
    backgroundColor: "{colors.crimson}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
  chip:
    backgroundColor: "rgba(255,255,255,0.14)"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
---

# Design System: XReels

## 1. Overview

**Creative North Star: "The Private Cinema"**

XReels is a dark streaming interface built around a single conviction: the
artwork is authored for black, so the surface must be black. A zinc-900 page
(#18181b) floats in a pure-black void; the user's own bookmark collection is
presented as a streaming service catalog with rails, billboards, and a
short-video feed. Density is cinematic, not dashboard-like: large artwork,
thin chrome, generous rail scrolling, monolithic displays over quiet UI text.

The system explicitly rejects: light themes, accent pickers, gradient text,
decorative glassmorphism, SaaS white cards, neon-on-black hacker aesthetics,
and colored side-stripes. Success test: screenshot the screen; if any zone of
chrome draws more attention than the media on it, the chrome is too loud.

**Key Characteristics:**
- Dark-only, art-forward, one crimson accent used like a highlight reel.
- Bebas Neue monoliths screaming, Geist whispering underneath.
- Fast-out, long-settle expo motion; hover states everywhere, transitions under 550ms.
- Everything must survive `file://` with zero build step.

## 2. Colors

A zinc void scale from pure black to hover gray, with one crimson reserved for
status, progress, and brand moments.

### Primary
- **Crimson** (#e50914): the single accent. Badges, progress bars, focus states, brand marks, the discover billboard logo. Used sparingly; rarity is the point.

### Secondary (optional; used deliberately)
- **Amber** (#ffc425): rating chip only.
- **Teal** (#54b9c5): "explore" affordances only.
- **Success** (#46d488) / **Warning** (#ffb547) / **Danger** (#e01d29): system status, never decoration.

### Neutral
- **Void** (#000000): html background, header scrim origin, media matting.
- **Zinc Page** (#18181b): the page itself; hero vignettes end here.
- **Sunken Well** (#101012): code, masonry gaps, sunken wells.
- **Control Fill** (#1f1f23): inputs, quiet controls.
- **Hover Fill** (#2a2a2e) / **Strong** (#3a3a3f): interactive fills.
- **Card Void** (#0b0b0b): cards and popovers.
- **Glass Panel** (#141416) / **Strong** (#1c1c1f): opaque near-black menus, toasts, sheets.
- **Ink** (#f8f8f8): primary text; **Muted** (#8f8f8f) for secondary text.
- **Hairline** (#222222): borders and dividers; stronger hairlines at rgba(255,255,255,.15).

### Named Rules
**The One Crimson Rule.** #e50914 appears only where the system means it:
brand, focus, progress, live status. If a screen glows red on a whim, it is wrong.
**The Black Mat Rule.** Media never sits on gray. Artwork mats directly on
#000 or #18181b; mid-gray frames are forbidden.

## 3. Typography

**Display Font:** Bebas Neue (single weight 400, never faux-bolded)
**Body Font:** Geist (variable 300–800)
**Label/Mono Font:** Geist Mono (400–600)

**Character:** A headline voice that screams like a marquee over a body that
whispers like a service manual. Display is only ever crimson, white, or black
on media; body text caps at comfortable measure on dark surfaces.

### Hierarchy
- **Display** (400, clamp(2.2rem→3.4rem), line-height 1, tracking 0.015em): billboard titles, feature headings, splash. Bebas only; one weight.
- **Eyebrow** (400, 10.5px, tracking 0.16em, uppercase): section labels, colophon text.
- **Body** (400, 14px, line-height 1.55): paragraphs, descriptions, meta rows.
- **Label** (mono 500, 11px): metrics, timestamps, keyboard hints, data readouts.

### Named Rules
**The Single Weight Rule.** Bebas Neue ships one weight; faux-bold, faux-italic,
and per-letter scaling are forbidden. Hierarchy through size and tracking only.

## 4. Elevation

Dark-system layering is done tonally (void → page → well → hover), not with
color inversion. Shadows are deep, black, and genuinely rare: they exist to
separate floating media and chrome from the artwork behind them, never to
signify importance.

### Shadow Vocabulary
- **Tier 1** (`0 2px 10px rgb(0 0 0 / 0.4)`): small controls raised off media.
- **Tier 2** (`0 12px 34px rgb(0 0 0 / 0.55)`): menus, hover-cards, sticky chrome.
- **Tier 3** (`0 24px 64px rgb(0 0 0 / 0.7)`): modals, viewer surfaces, splash.
- **Card** (`0 22px 44px rgb(0 0 0 / 0.6)`): tile hover lift only.

### Named Rules
**The Floating Rule.** A surface at rest casts no shadow. Shadows appear only
on lift (hover, focus, dialog, preview) and return instantly on settle.

## 5. Components

### Buttons
- **Shape:** full pill (999px), padding 10px 20px.
- **Primary (pill):** white fill (#f8f8f8) on black text; the "Explore/Play" CTA. Hover dims to 85% and lifts 1px.
- **Accent (pill):** crimson fill, white text; reserved for brand-level actions (open on X, splash CTA).
- **Ghost:** transparent, white/14% hairline fill; live in panels and menus.
- **Focus:** crimson ring (2px, offset 2px); never removed, only styled.

### Chips
- **Style:** glass fill rgba(255,255,255,.14), white text, 999px, 4px 10px.
- **State:** selected = crimson fill with white text; unselected = neutral glass.

### Cards / Containers
- **Corner Style:** 10px radius for artwork cards; 14px for billboards; 6–8px for chrome.
- **Background:** card void #0b0b0b or transparent over media with black scrims.
- **Shadow Strategy:** see Floating Rule; lift 2–4px + Tier 1 shadow on hover.
- **Border:** 1px #222222 hairline on chrome; no borders on artwork.

### Inputs / Fields
- **Style:** #1f1f23 fill, #222222 1px border, 8px radius, Ink text, mono placeholder.
- **Focus:** crimson 2px ring; error states use #e01d29 copy, never red borders on the field.

### Navigation
- 64px header, black → transparent scrim origin, glass blur only when scrolled.
- Nav pills: Geist 13px; active = pill fill #2a2a2e; hover = white/6% fill.
- Keyboard-first: ⌘K palette shortcuts are always annotated in labels (mono).

### Signature Components
- **Rail:** horizontal scroller of tiles with 8px gaps, directional arrow scrims at ≥1024px, snap scrolling, no visible scrollbar by default.
- **Billboard:** full-bleed hero, artwork right, copy ladder left (eyebrow → display → meta → CTA), bottom vignette to #18181b.
- **Watch feed:** vertical near-fullscreen video stack; one video lives at a time, autoplay muted, scrubber as a 2px crimson line along the edge.

## 6. Do's and Don'ts

### Do:
- **Do** mat every artwork on pure black or #18181b with matched scrims under text.
- **Do** keep motion on `cubic-bezier(.22,1,.36,1)`; fast out (200ms), long settle (550ms).
- **Do** annotate every keyboard affordance in Geist Mono.
- **Do** use the crimson ring for focus across the whole app; one focus language.
- **Do** honor `[data-motion="reduce"]` for every animation shipped.

### Don't:
- **Don't** introduce a light theme or accent picker; the artwork is authored for black.
- **Don't** use gradient text (`background-clip: text`), side-stripe borders, or decorative glass.
- **Don't** build identical icon-card grids; layouts are rails, billboards, and masonry, not feature-card templates.
- **Don't** open a modal when an inline surface exists.
- **Don't** let chrome outshine media: if the screenshot's brightest zone is not the artwork, fix the chrome.
- **Don't** faux-bold Bebas Neue or letter-space body text.
