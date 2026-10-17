# Product

## Register

product

## Users

A single power-user archiving and re-experiencing their own X (Twitter) bookmark
collection locally. They open the app offline by double-clicking `index.html` at
home or in transit (often on a laptop, sometimes on a large secondary display),
in a dim room, when they want to browse, rewatch, or rediscover the media they
have saved. No login, no server, no sync: the library is their data.

## Product Purpose

XReels is a local-first cinematic viewer for personal X bookmarks with media.
It turns a raw exported bookmark dump into a curated streaming-grade surface:
discover rails, a searchable library, a short-video watch feed, full media
viewer, creator/tag/collection lenses, and an insights dashboard. Success is
the user forgetting it is a file viewer and feeling like a private streaming
service built only for them, faster and more beautiful than X itself.

## Brand Personality

Private cinema. Inspired confidence, tactile delight, quiet power.
Three words: cinematic, effortless, proprietary.

## Anti-references

- Generic SaaS dashboard (white cards, blue links, icon-grid features).
- Light theme or accent-color pickers: the artwork is authored for black;
  dark-only by design (explicit project decision).
- Cluttered bookmark-manager look (tables of links, checkbox toolbars).
- Cheap "hacker terminal" dark UI with neon green + scanlines.
- AI-slop patterns: gradient text, glassmorphism-by-default, side-stripe
  borders, identical card grids, modal-first thinking.

## Design Principles

1. **The media is the interface.** Artwork, posters and video own the surface;
   chrome stays thin, dark, and recedes.
2. **Local and instant.** Every interaction must feel faster than X's own app;
   no spinner should ever be a design feature.
3. **Streaming-grade polish, file-viewer practicality.** Everything works on
   `file://`, keyboard-first, no server, no network dependency beyond media.
4. **One crimson beats many colors.** A single accent (crimson) reserved for
   status and brand; anti-references stay out by discipline, not decoration.
5. **Tactile charm without noise.** Motion is fast-out, long-settle
   (`cubic-bezier(.22,1,.36,1)`); delight must never cost frames.

## Accessibility & Inclusion

- Full `prefers-reduced-motion` support is mandatory (existing global guard
  at `[data-motion="reduce"]`).
- Keyboard-first operation: command palette, shortcuts across all features.
- WCAG AA contrast on text over media (scrims are part of the design system).
- `aria-label`s on all icon-only controls; visible focus states.
