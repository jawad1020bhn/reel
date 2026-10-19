import test from "node:test";
import assert from "node:assert/strict";
import auditApi from "../audit.js";

test("reports exact duplicates, malformed IDs, response coverage, and non-fatal snowflake hints", () => {
  const posts = [
    { tweet_id: "1000000000000000000" },
    { tweet_id: "1000000000000000000" },
    { tweet_id: "1000000001000000000" },
    { tweet_id: "not-an-id" },
  ];
  const result = auditApi.audit(posts, { audit: {
    timelineResponses: 4,
    pagesWithTweets: 3,
    emptyResponses: 1,
    schemaMismatchResponses: 2,
    observedOccurrences: 5,
    observedUniqueIds: 3,
    coveredUniqueIds: 2,
    missingUniqueIds: 1,
    missingIds: ["1000000001000000000"],
    endReached: false,
  } });

  assert.equal(result.rows, 4);
  assert.equal(result.uniqueIds, 2);
  assert.equal(result.duplicateIds, 1);
  assert.equal(result.invalidIds, 1);
  assert.equal(result.capture.available, true);
  assert.equal(result.capture.missingUniqueIds, 1);
  assert.equal(result.capture.schemaMismatchResponses, 2);
  assert.equal(result.capture.emptyResponses, 1);
  assert.equal(result.coverageVerified, false);
  assert.ok(result.suspiciousGapCount > 0);
  assert.match(auditApi.describe(result).gapNote, /heuristic only/);
});

test("does not claim capture coverage when the library has no capture audit", () => {
  const result = auditApi.audit([{ tweet_id: "1000000000000000001" }]);
  assert.equal(result.capture.available, false);
  assert.equal(result.coverageVerified, false);
  assert.equal(result.completeSweep, false);
});
