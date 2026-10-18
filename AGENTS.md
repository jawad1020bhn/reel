# XReels agent guide

For frontend work, use the installed **Impeccable 4.6.0** skill:
`.claude/skills/impeccable/SKILL.md`. Read `PRODUCT.md` and `DESIGN.md` first.
For mobile changes, load its `reference/adapt.md`; for final refinements, load
`reference/polish.md`. Preserve the Private Cinema direction unless the user
explicitly asks to replace it. Do not regenerate the existing product/design
files as a setup step.

- App runtime stays vanilla JavaScript (`XR.define`) and plain CSS, with no
  build step. New app files must be registered in `src/manifest.js`.
- Keep `file://` support and the existing CSP. Live Mode is optional and is not
  configured here; do not silently relax CSP to enable it.
- `npm run check` verifies architecture/manifest dependencies.
- `npm ci` installs **dev-only** browser test tools, not app dependencies.
- `IMPECCABLE_BROWSER=/path/to/chrome npm run test:ui` runs isolated synthetic
  media tests, real touch input in Chromium, and scoped accessibility checks.
- Serve the project, then run `npm run audit:ui`; point `IMPECCABLE_BROWSER` at
  Chrome/Chromium. Static-only: `npm run audit:ui -- --static`. A failed URL
  scan is an incomplete audit, not a pass.
- Keep `.audit/`, browser binaries, private library exports, and local agent
  state out of Git. Only deliberate brand-font exceptions are configured.

See `OVERHAUL.md` for installed tooling, changes, evidence, and remaining
physical-device validation.
