import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedTransientFailure,
  classifySkuFailure,
  shanghaiDayKey,
} from "../scripts/flow_b_playwright/retry-policy.mjs";

test("deterministic quality failures are immediately terminal", () => {
  for (const reason of [
    "fbs-evidence-missing",
    "fbs-confirmation-inconsistent",
    "non-pure-fbs",
    "1688-no-reliable-match",
    "profit_rate<=30",
    "duplicate-title",
    "prohibited-category",
  ]) {
    assert.equal(classifySkuFailure(reason), "deterministic", reason);
  }
  assert.equal(classifySkuFailure("ozon-detail-soft-block-deferred"), "transient");
  assert.equal(classifySkuFailure("1688-health-deferred"), "transient");
});

test("a transient SKU receives at most two retries per Shanghai day", () => {
  const first = boundedTransientFailure({
    reason: "ozon-detail-soft-block-deferred",
    now: "2026-07-29T14:00:00.000Z",
    previousAttempts: 0,
    backoffMs: 30_000,
  });
  const second = boundedTransientFailure({
    reason: "ozon-detail-soft-block-deferred",
    now: "2026-07-29T14:00:31.000Z",
    previousAttempts: first.transient_attempts,
    previousDay: first.retry_day,
    backoffMs: 60_000,
  });
  const exhausted = boundedTransientFailure({
    reason: "ozon-detail-soft-block-deferred",
    now: "2026-07-29T14:01:32.000Z",
    previousAttempts: second.transient_attempts,
    previousDay: second.retry_day,
    backoffMs: 120_000,
  });

  assert.equal(first.terminal, false);
  assert.equal(first.retry_at, "2026-07-29T14:00:30.000Z");
  assert.equal(second.terminal, false);
  assert.equal(second.transient_attempts, 2);
  assert.equal(exhausted.terminal, true);
  assert.equal(exhausted.reason, "transient-retry-limit-exhausted");
  assert.equal(exhausted.original_reason, "ozon-detail-soft-block-deferred");
  assert.equal(exhausted.retry_at, null);
});

test("retry allowance resets at Shanghai midnight", () => {
  assert.equal(shanghaiDayKey("2026-07-29T15:59:59.999Z"), "2026-07-29");
  assert.equal(shanghaiDayKey("2026-07-29T16:00:00.000Z"), "2026-07-30");
  const reset = boundedTransientFailure({
    reason: "1688-health-deferred",
    now: "2026-07-29T16:00:00.000Z",
    previousAttempts: 2,
    previousDay: "2026-07-29",
    backoffMs: 30_000,
  });
  assert.equal(reset.transient_attempts, 1);
  assert.equal(reset.terminal, false);
});
