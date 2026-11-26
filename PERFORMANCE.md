# Performance follow-up — 2026-11-26

This pass preserves the vanilla runtime, file:// support, CSP, visual design,
and existing Library state restoration. No runtime dependency or bundle was added.

## What changed

### Less competing network and decoder work

- Source attachment no longer unconditionally starts a whole-file download
  alongside native streaming. After playback progresses, the existing warm-ahead
  policy can still cache a short clip for later seeking/replay.
- Fresh off-screen Watch cells warm neighbours through the shared queue; they no
  longer also attach native metadata sources (or start HLS setup) before activation.
- Reddit side-track elements use `preload="none"` and receive their audio source on
  first play, rather than downloading tracks for every off-screen cell.
- All speculative paths (`warm`, `prefetch`, `warmAhead`) now share a strict
  two-request scheduler. Previously direct `warm` and `warmAhead` bypassed the
  queue's concurrency limit. Duplicate callers share one job/promise.
- Changing the Watch window cancels queued/in-flight jobs that are no longer
  relevant. Leaving Watch or hiding it cancels its speculative work without
  evicting already-warm clips. Disabling preloading prunes pending work too.
- Neighbour warm-ups use bitrate × duration estimates to refuse obviously oversized
  downloads. Local-media configurations and HLS-first media do not speculatively
  fetch an unrelated remote MP4. Native playback/fallback remains available.
- Save-Data, offline, reported 2G/3G, and hidden-page guards remain conservative.
  The existing 64MiB cache and 14MiB per-entry limits are unchanged.

### Playback lifecycle

- Pause is immediate, not deferred until an outstanding play promise resolves.
- Play attempts carry an intent sequence. An engine/HLS readiness promise from
  before a swipe cannot start an obsolete clip; an old pause cannot stop a newly
  reactivated clip. Repeated play calls join a pending attempt.
- Late autoplay failures cannot change global mute state or retry a stale clip.
  Pending resume-metadata listeners are removed on destruction.

### Exact small-result selection

Sorted queries with a small positive integer limit use a stable max-heap top-K
selection, O(n log k), rather than sorting every match, O(n log n). This directly
serves Discover's 24-item shelves / 48-item rotation pools. Original-index tie
breaking preserves stable sort results; totals and query sort hints are unchanged.
Full Library queries, smart shuffle, and random shuffle retain their original
algorithms. No cross-query result cache or stale activity snapshot was introduced.

## Measurements

Repeatable, synthetic, private-data-free command:

```sh
npm run benchmark:performance -- --baseline 6d41a148b9b418a8e66c6d79f849e5172c22ccb7
```

One Node/sandbox run, 30,000 posts, eight sorted queries of 48 items each, median
of seven timed batches after two warm-ups:

| Probe | Baseline | This pass |
| --- | ---: | ---: |
| Eight-query batch | 177.02ms | 25.30ms |
| Duration reads for a longest-48 query | 786,562 | 65,506 |

That run is **7× faster for this query workload**, not a claim that the entire app
or physical-phone startup is 7× faster. The command checks exact result parity
against the supplied Git reference before timing. Timing varies with hardware,
input ordering, library size and active filters.

Existing Chromium 10,000-item masonry probe remains bounded: 28 tiles mounted at
deep scroll and 74 renders across the initial layout plus three jumps (~5ms
initial layout here). No new overscan tuning was needed.

## Verification

- `npm run check`: passes architectural and mobile contract guards.
- `npm run test:unit`: 173 tests pass, including stable top-K parity for every
  ordering, operation-count guard, scheduler deduplication/concurrency, cancellation
  and replacement races, and deferred-play/audio lifecycle tests.
- New real-media Chromium phone test passes: fresh neighbours have no source,
  repeated navigation leaves exactly one playing video and at most five video
  elements, and leaving Watch removes its video/audio elements.
- Library continuity and large-grid browser regressions also pass.
- Full Chromium UI suite: **21/24 pass**. Desktop hover capability assertion and
  the two site-gate verification tests fail; the same three failures reproduce on
  an untouched archive of this branch's HEAD using the same browser environment.
- Rendered phone Watch fixture inspected; no visual redesign intended.

## Still needs a physical device

No claim is made about measured Android FPS, peak process memory, battery usage,
first-frame latency over a real cellular CDN, or lock-screen behaviour. Test a
mid-range Android with a large library, rapid swipes, rotation, background/return,
slow cellular and Save-Data before treating those as validated. Browsers without
Network Information still get conservative one-neighbour warming. Future startup
or worker/index changes should follow a device trace rather than guesswork.

## Pre-merge review

Re-ran architecture checks, all 173 unit tests, the full browser suite, and the
three failing browser tests against an untouched baseline archive. Failures match
at the same assertions/lines; no new browser regression was observed. Review also
caught a loading-state edge case: a second play/pause toggle now cancels pending
engine readiness instead of joining it. A regression test verifies cancellation
and subsequent playback.

The repeated synthetic query benchmark remained faster (253.13ms baseline vs
27.98ms current in that run); timings are variable, not an end-to-end guarantee.
Deferring neighbour metadata/HLS and side-track audio intentionally trades
speculative readiness for lower network/decoder pressure. Real-device first-frame
and audio-start latency remain validation gaps, not claimed passes.
