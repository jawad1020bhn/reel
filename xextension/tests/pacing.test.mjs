import test from "node:test";
import assert from "node:assert/strict";
import pacing from "../pacing.js";

/* Deterministic RNG: each call advances an index over a preset sequence and
   holds the last value forever. */
function seqRng(values) {
  let i = 0;
  return () => {
    const value = values[Math.min(i, values.length - 1)];
    i++;
    return value;
  };
}

const constRng = (value = 0.5) => () => value;

test("pacer warms up slower than steady state, with exact jitter math", () => {
  const pacer = pacing.createPacer({
    rng: constRng(0.5), // jitter factor 1.0 → exact base
    baseDelayMs: 2000,
    warmupCount: 2,
    warmupFactor: 1.5,
    waveMin: 100,
    waveMax: 100,
  });

  const first = pacer.next();
  assert.equal(first.kind, "warmup");
  assert.equal(first.delayMs, 3000); // 2000 × 1.5

  pacer.onAction();
  const second = pacer.next();
  assert.equal(second.kind, "warmup");
  assert.equal(second.delayMs, 3000);

  pacer.onAction();
  const third = pacer.next();
  assert.equal(third.kind, "steady");
  assert.equal(third.delayMs, 2000);
});

test("pacer jitter stays inside the configured band and the throttle stretches it", () => {
  const pacer = pacing.createPacer({
    rng: seqRng([0, 0, 1]),        // construction draws one; then −35%, +35%
    baseDelayMs: 2000,
    jitterRatio: 0.35,
    warmupCount: 0,
    waveMin: 1000,
    waveMax: 1000,
    throttle: () => 2,
    minDelayMs: 600,
  });

  assert.equal(pacer.next().delayMs, 2600); // 2000 × 0.65 × 2
  assert.equal(pacer.next().delayMs, 5400); // 2000 × 1.35 × 2
});

test("pacer inserts irregular wave breaks and resets the wave counter after one", () => {
  const pacer = pacing.createPacer({
    rng: constRng(0.5),
    baseDelayMs: 1000,
    warmupCount: 0,
    waveMin: 3,
    waveMax: 3,
    waveBreakMinMs: 7000,
    waveBreakMaxMs: 22000,
  });

  const kinds = [];
  for (let i = 0; i < 4; i++) {
    kinds.push(pacer.next().kind);
    pacer.onAction();
  }
  // next() sees sinceBreak 0,1,2,3 → steady, steady, steady, wave-break
  assert.deepEqual(kinds, ["steady", "steady", "steady", "wave-break"]);
  assert.equal(pacer.sinceBreak, 0); // wave counter reset by onAction after the break
  assert.equal(pacer.next().kind, "steady");
});

test("pacer wave break delay lands in the human pause band", () => {
  const pacer = pacing.createPacer({
    rng: constRng(0.5),
    waveMin: 1,
    waveMax: 1,
    waveBreakMinMs: 7000,
    waveBreakMaxMs: 22000,
  });
  pacer.next();           // action 1…
  pacer.onAction();       // …fills the single-action wave
  const plan = pacer.next();
  assert.equal(plan.kind, "wave-break");
  assert.ok(plan.delayMs >= 7000 && plan.delayMs <= 22000, `got ${plan.delayMs}`);
});

test("governor stays transparent under the ceiling and clamps above it", () => {
  const governor = pacing.createGovernor({ rateCeilingPerMin: 26, windowMs: 60000, maxThrottle: 2.5 });
  const t = 1_000_000;

  assert.equal(governor.multiplier(t), 1); // nothing recorded yet

  for (let i = 0; i < 26; i++) governor.record(t - i * 1000);
  assert.equal(governor.multiplier(t), 1); // exactly at the ceiling

  for (let i = 26; i < 52; i++) governor.record(t - i * 500);
  const rate = governor.rate(t);
  assert.ok(rate > 26, `rate ${rate} should exceed ceiling`);
  const multiplier = governor.multiplier(t);
  assert.ok(multiplier > 1 && multiplier <= 2.5, `multiplier ${multiplier}`);
});

test("governor forgets events outside its rolling window", () => {
  const governor = pacing.createGovernor({ rateCeilingPerMin: 26, windowMs: 60000 });
  const t = 5_000_000;
  for (let i = 0; i < 60; i++) governor.record(t - 61000 + i); // all older than the window
  assert.equal(governor.rate(t), 0);
  assert.equal(governor.multiplier(t), 1);
});

test("backoff grows exponentially inside full jitter and caps at max", () => {
  const base = { baseMs: 1000, maxMs: 8000, maxRetries: 10 };

  const minRng = pacing.computeBackoff(1, { ...base, rng: () => 0 });
  assert.equal(minRng.retry, true);
  assert.equal(minRng.delayMs, 750); // 1000 × 0.75

  const maxRng = pacing.computeBackoff(3, { ...base, rng: () => 0.9999 });
  assert.ok(maxRng.delayMs <= 8000);

  const attempt4 = pacing.computeBackoff(4, { ...base, rng: () => 0.5 });
  assert.equal(attempt4.delayMs, 8000); // 1000 × 2³ × 1.0, capped at 8000

  const exhausted = pacing.computeBackoff(11, { ...base, rng: () => 0.5 });
  assert.equal(exhausted.retry, false);
});

test("classifyOutcome maps transport signals the runner depends on", () => {
  const c = pacing.classifyOutcome;

  assert.equal(c(200, { data: {} }).outcome, "ok");
  assert.equal(c(200, { data: { user: { result: { legacy: { following: false } } } } }).outcome, "ok");
  assert.equal(c(200, { errors: [{ code: 88, message: "Rate limit exceeded" }] }).outcome, "rate-limited");
  assert.equal(c(200, { errors: [{ code: 34, message: "Sorry, that page does not exist" }] }).outcome, "not-found");
  assert.equal(c(429, {}).outcome, "rate-limited");
  assert.equal(c(401, {}).outcome, "auth-error");
  assert.equal(c(403, {}).outcome, "auth-error");
  assert.equal(c(500, {}).outcome, "server-error");
  assert.equal(c(0, null).outcome, "network-error");
  assert.equal(c(200, '{"errors":[{"message":"Rate limit exceeded"}]}').outcome, "rate-limited");

  // Transport-aware 404/400: GraphQL misses are the rolling operation ID,
  // REST 404 is a genuine gone relationship.
  assert.equal(c(404, null, "", "graphql").outcome, "stale-queryid");
  assert.equal(c(404, null, "", "rest").outcome, "not-found");
  assert.equal(c(400, null, "", "graphql").outcome, "stale-queryid");
  assert.equal(c(400, null, "", "rest").outcome, "bad-request");

  assert.equal(c(200, { errors: [{ code: 136, message: "blocked" }] }).outcome, "bad-request");
});
