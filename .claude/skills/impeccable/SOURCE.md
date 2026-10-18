# Impeccable installation

Vendored from `pbakaus/impeccable`, version **4.6.0**, GitHub revision
`1e46f67` (2026-10-18). The normal CLI installer could not reach its bundle host
in the sandbox, so the published skill directory was copied from the GitHub
source archive. The upstream Apache-2.0 license and third-party notices are
included here. Trailing whitespace and one extra final blank line in three
reference Markdown files were normalized for a clean patch; the guidance is
otherwise unchanged.

Only agent guidance and launcher assets are stored in this directory; the
platform engine is installed in the user's cache, not in the app or Git.
The launcher downloads the version-pinned engine when needed. Do not add a
platform binary to this repository. No edit hooks or Live Mode were enabled.

This installation does not replace `PRODUCT.md` or the existing visual identity
in `DESIGN.md`. See `OVERHAUL.md` for project-specific use and verification.
