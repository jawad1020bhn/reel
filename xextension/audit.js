/*
 * X Bookmark Audit · structural and capture-coverage verification.
 *
 * Snowflake ID spacing is deliberately labelled a heuristic: bookmark feeds
 * are not contiguous tweet-ID ranges, so an ID gap cannot prove a missed post.
 * The useful check is whether every unique tweet ID observed in a recognized
 * Bookmarks timeline response ended up in the saved library.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XBookmarkAudit = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const GAP_THRESHOLD = 50_000_000n;
  const MAX_REPORTED_GAPS = 30;
  const idOf = (post) => String(post?.tweet_id || post?.id || "").trim();

  function audit(items, captureState = null) {
    const posts = Array.isArray(items) ? items : [];
    const seen = new Set();
    const duplicates = [];
    const invalidIds = [];
    const validIds = [];

    for (let index = 0; index < posts.length; index++) {
      const id = idOf(posts[index]);
      if (!/^\d+$/.test(id)) {
        invalidIds.push({ index, id: id || null });
        continue;
      }
      if (seen.has(id)) duplicates.push(id);
      else seen.add(id);
      validIds.push(id);
    }

    validIds.sort((a, b) => {
      const aa = BigInt(a), bb = BigInt(b);
      return aa < bb ? -1 : aa > bb ? 1 : 0;
    });

    const suspiciousGaps = [];
    let suspiciousGapCount = 0;
    for (let i = 1; i < validIds.length; i++) {
      const afterId = validIds[i - 1], beforeId = validIds[i];
      const diff = BigInt(beforeId) - BigInt(afterId);
      if (diff > GAP_THRESHOLD) {
        suspiciousGapCount++;
        if (suspiciousGaps.length < MAX_REPORTED_GAPS) {
          suspiciousGaps.push({ after: afterId, before: beforeId, gap: diff.toString() });
        }
      }
    }

    const cap = captureState?.audit || captureState || {};
    const hasFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
    const observed = hasFiniteNumber(cap.observedUniqueIds) ? cap.observedUniqueIds : null;
    const covered = hasFiniteNumber(cap.coveredUniqueIds) ? cap.coveredUniqueIds : null;
    const missing = hasFiniteNumber(cap.missingUniqueIds) ? cap.missingUniqueIds : null;
    const hasCaptureEvidence = Number.isFinite(observed) && observed >= 0;
    const endReached = cap.endReached === true;

    return {
      version: 1,
      auditedAt: new Date().toISOString(),
      rows: posts.length,
      uniqueIds: seen.size,
      duplicateIds: duplicates.length,
      duplicateSamples: duplicates.slice(0, 20),
      invalidIds: invalidIds.length,
      invalidSamples: invalidIds.slice(0, 20),
      suspiciousGapCount,
      suspiciousGaps,
      gapThreshold: GAP_THRESHOLD.toString(),
      capture: {
        available: hasCaptureEvidence,
        timelineResponses: Number(cap.timelineResponses) || 0,
        pagesWithTweets: Number(cap.pagesWithTweets) || 0,
        emptyResponses: Number(cap.emptyResponses) || 0,
        schemaMismatchResponses: Number(cap.schemaMismatchResponses) || 0,
        observedOccurrences: Number(cap.observedOccurrences) || 0,
        observedUniqueIds: observed,
        coveredUniqueIds: covered,
        missingUniqueIds: missing,
        missingSamples: Array.isArray(cap.missingIds) ? cap.missingIds.slice(0, 30) : [],
        normalizationFailures: Number(cap.normalizationFailures) || 0,
        failedUniqueIds: Number(cap.failedUniqueIds) || 0,
        duplicateOccurrences: Number(cap.duplicateOccurrences) || 0,
        cursorAdvances: Number(cap.cursorAdvances) || 0,
        repeatedCursors: Number(cap.repeatedCursors) || 0,
        bottomCursorSeen: cap.bottomCursorSeen === true,
        preCaptureDropped: Number(cap.preCaptureDropped) || 0,
        endReached,
        endReason: cap.endReason || null,
      },
      coverageVerified: hasCaptureEvidence && missing === 0,
      completeSweep: endReached,
      structurallyClean: duplicates.length === 0 && invalidIds.length === 0,
    };
  }

  function describe(result) {
    const status = result.coverageVerified && result.completeSweep && result.structurallyClean
      ? "Capture coverage checks out"
      : result.coverageVerified && result.structurallyClean
        ? "Observed posts accounted for; feed sweep not confirmed"
        : result.capture.available
          ? "Review capture gaps below"
          : "Library structure checked; no capture coverage record";
    return {
      status,
      summary: `${result.rows.toLocaleString()} rows · ${result.uniqueIds.toLocaleString()} unique IDs · ${result.duplicateIds} duplicate · ${result.invalidIds} invalid`,
      gapNote: `${result.suspiciousGapCount} large Snowflake ID gap hint(s); heuristic only, not proof of missing bookmarks.`,
    };
  }

  return { audit, describe, GAP_THRESHOLD: GAP_THRESHOLD.toString() };
});
