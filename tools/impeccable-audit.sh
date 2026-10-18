#!/usr/bin/env bash
# Dev-only Impeccable gate. Serve the app first:
#   python3 -m http.server 8899 --bind 0.0.0.0
#   IMPECCABLE_BROWSER=/path/to/chrome npm run audit:ui
# Options: --static (CSS only); --shots (also save rendered screenshots/metrics).
# AUDIT_URL, AUDIT_VIEWPORTS and AUDIT_ROUTES can narrow a run.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

IMPECCABLE="${IMPECCABLE:-.claude/skills/impeccable/scripts/impeccable}"
BASE="${AUDIT_URL:-http://localhost:${PORT:-8899}/index.html}"
OUT="${AUDIT_OUT:-.audit/impeccable}"
VIEWPORTS="${AUDIT_VIEWPORTS:-320x568 360x800 390x844 768x1024 844x390 1440x960}"
ROUTES="${AUDIT_ROUTES:-discover library watch settings insights}"
SHOTS=0; STATIC=0; RESULT=0
for arg in "$@"; do
  case "$arg" in
    --shots) SHOTS=1 ;;
    --static) STATIC=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done
mkdir -p "$OUT"

# Preserve the engine's JSON and diagnostics. A failed browser scan is never
# reported as a clean audit. Retry one tooling failure, not real findings.
scan() {
  local name="$1" target="$2" viewport="${3:-}" code=0 attempt=0
  local args=(detect "$target" --json)
  [ -n "$viewport" ] && args+=(--viewport "$viewport")
  while :; do
    "$IMPECCABLE" "${args[@]}" > "$OUT/$name.json" 2> "$OUT/$name.stderr.txt"
    code=$?
    if [ "$code" = 0 ] || [ "$code" = 2 ]; then break; fi
    if [ "$attempt" = 1 ]; then
      echo "ERROR $name: scan failed (exit $code)" >&2
      cat "$OUT/$name.stderr.txt" >&2
      RESULT=1; return
    fi
    attempt=1
  done
  node --input-type=module - "$OUT/$name.json" "$name" <<'NODE'
import { readFileSync } from "node:fs";
try {
  const findings = JSON.parse(readFileSync(process.argv[2], "utf8"));
  if (!Array.isArray(findings)) throw new Error("expected a findings array");
  const primary = findings.filter((f) => !f.advisory);
  console.log(`${process.argv[3]}: ${primary.length} findings, ${findings.length - primary.length} advisory`);
  for (const f of findings) console.log(`  [${f.antipattern}] ${f.snippet}${f.selector ? " · " + f.selector : ""}`);
  process.exitCode = primary.length ? 2 : 0;
} catch (error) {
  console.error(`${process.argv[3]}: invalid/missing audit output: ${error.message}`);
  process.exitCode = 1;
}
NODE
  code=$?
  if [ "$code" = 1 ]; then RESULT=1
  elif [ "$code" = 2 ] && [ "$RESULT" = 0 ]; then RESULT=2; fi
}

scan styles styles/
if [ "$STATIC" = 1 ]; then exit "$RESULT"; fi

if [ -z "${IMPECCABLE_BROWSER:-}" ]; then
  for candidate in google-chrome chromium chromium-browser microsoft-edge; do
    path="$(command -v "$candidate" 2>/dev/null || true)"
    if [ -n "$path" ]; then export IMPECCABLE_BROWSER="$path"; break; fi
  done
  if [ -z "${IMPECCABLE_BROWSER:-}" ] && [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
    export IMPECCABLE_BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  fi
fi
if [ -z "${IMPECCABLE_BROWSER:-}" ] || [ ! -x "$IMPECCABLE_BROWSER" ]; then
  echo "URL audit needs Chrome/Chromium. Set IMPECCABLE_BROWSER=/path/to/chrome. Static results only; URL audit NOT completed." >&2
  exit 1
fi
export PUPPETEER_EXECUTABLE_PATH="$IMPECCABLE_BROWSER" CHROME_PATH="$IMPECCABLE_BROWSER"
if ! node --input-type=module - "$BASE" <<'NODE'
try {
  const r = await fetch(process.argv[2], { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) { console.error(`Cannot reach audit URL: ${e.message}. Start the static server or set AUDIT_URL.`); process.exitCode = 1; }
NODE
then exit 1; fi

for viewport in $VIEWPORTS; do
  for route in $ROUTES; do scan "$viewport-$route" "${BASE}#/${route}" "$viewport"; done
done
if [ "$SHOTS" = 1 ]; then
  if ! AUDIT_URL="$BASE" node tools/audit-shots.mjs "$OUT/screenshots"; then RESULT=1; fi
fi
echo "Audit artifacts: $OUT (ignored by Git). Exit 0 = no primary findings; 2 = findings; 1 = incomplete/error."
exit "$RESULT"
