import assert from "node:assert/strict";
import test from "node:test";
import {
  FIXED_STORE_IDS,
  evaluateThirtyMinuteGate,
  evaluateThreeSkuGate,
  evaluateTwentyFourHourGate,
  evaluateTwoHourGate,
  replayAcceptanceEvents,
} from "../scripts/flow_b_playwright/acceptance-replay.mjs";

const START = "2026-07-29T00:00:00.000Z";
const minute = (value) => new Date(Date.parse(START) + value * 60_000).toISOString();

function strictEvent(index, atMinute, overrides = {}) {
  const storeId = FIXED_STORE_IDS[index % FIXED_STORE_IDS.length];
  return {
    type: "strict-confirmed",
    at: minute(atMinute),
    submitted_at: minute(Math.max(0, atMinute - 0.25)),
    sku: `strict-${String(index + 1).padStart(3, "0")}`,
    store_id: storeId,
    strict_confirmed: true,
    online_status: "selling",
    stock: 1,
    profit_rate: 41,
    shipping_mode: "FBS",
    same_item_1688: true,
    cost_reliable: true,
    duplicate_precheck: true,
    forbidden_category: false,
    title_valid: true,
    image_valid: true,
    category_valid: true,
    ...overrides,
  };
}

function strictSeries(count, lastMinute) {
  return Array.from({ length: count }, (_, index) => (
    strictEvent(index, 1 + ((lastMinute - 1) * index) / Math.max(1, count - 1))
  ));
}

function healthyProcessSamples(endMinute) {
  return [0, endMinute / 2, endMinute].map((atMinute) => ({
    type: "process-snapshot",
    at: minute(atMinute),
    supervisor_count: 1,
    worker_count: 1,
    profile_owner_count: 1,
    orphan_browser_count: 0,
  }));
}

function closedThreeSkuEvents() {
  return [
    { type: "sku-transition", at: minute(1), sku: "safe-1", status: "submitted", reason: "erp-submit-accepted" },
    { type: "sku-transition", at: minute(2), sku: "safe-1", status: "published" },
    { type: "sku-transition", at: minute(3), sku: "safe-2", status: "skipped", reason: "duplicate-history" },
    {
      type: "sku-transition",
      at: minute(4),
      sku: "poison-1",
      status: "failed",
      reason: "forbidden-category",
      failure_class: "deterministic",
    },
  ];
}

test("success replay satisfies the 3-SKU, 30-minute, two-hour, and 24-hour gates", () => {
  const threeSku = evaluateThreeSkuGate({
    events: closedThreeSkuEvents(),
    targetSkus: ["safe-1", "safe-2", "poison-1"],
  });
  assert.equal(threeSku.passed, true);
  assert.deepEqual(threeSku.final_status_by_sku, {
    "poison-1": "failed",
    "safe-1": "published",
    "safe-2": "skipped",
  });

  const events = [
    ...strictSeries(500, 840),
    ...healthyProcessSamples(30),
    ...healthyProcessSamples(120),
    ...healthyProcessSamples(1_440),
    { type: "candidate-buffer", at: minute(0), ready_unique: 72, added_unique: 72 },
    { type: "candidate-buffer", at: minute(15), ready_unique: 74, added_unique: 19 },
    { type: "candidate-buffer", at: minute(30), ready_unique: 71, added_unique: 16 },
  ];

  const thirty = evaluateThirtyMinuteGate({
    events,
    startedAt: START,
    endedAt: minute(30),
  });
  assert.equal(thirty.passed, true);
  assert.equal(thirty.minimum_candidate_buffer, 71);

  const twoHour = evaluateTwoHourGate({
    events,
    startedAt: START,
    endedAt: minute(120),
  });
  assert.equal(twoHour.passed, true);
  assert.ok(twoHour.unique_current_window_strict >= 70);

  const fullDay = evaluateTwentyFourHourGate({
    events,
    startedAt: START,
    endedAt: minute(1_440),
  });
  assert.equal(fullDay.passed, true);
  assert.equal(fullDay.unique_current_window_strict, 500);
  assert.ok(fullDay.effective_strict_per_hour >= 35);
  assert.deepEqual(fullDay.strict_by_store, Object.fromEntries(FIXED_STORE_IDS.map((id) => [String(id), 100])));
});

test("duplicate replay fails closure and throughput gates even when raw strict rows reach the target", () => {
  const closureEvents = [
    ...closedThreeSkuEvents(),
    { type: "sku-transition", at: minute(5), sku: "safe-1", status: "submitted", reason: "duplicate-submit" },
  ];
  const closure = evaluateThreeSkuGate({
    events: closureEvents,
    targetSkus: ["safe-1", "safe-2", "poison-1"],
  });
  assert.equal(closure.passed, false);
  assert.equal(closure.checks.zero_duplicate_submissions, false);

  const rows = strictSeries(70, 115);
  rows.push({ ...rows[0], at: minute(116) });
  const replay = replayAcceptanceEvents(rows, { startedAt: START, endedAt: minute(120) });
  assert.equal(replay.raw_strict_events, 71);
  assert.equal(replay.unique_strict_count, 70);
  assert.equal(replay.duplicate_strict_events, 1);

  const gate = evaluateTwoHourGate({ events: rows, startedAt: START, endedAt: minute(120) });
  assert.equal(gate.passed, false);
  assert.equal(gate.checks.zero_duplicates, false);
});

test("3-SKU closure rejects any submitted, failed, skipped, or delayed status without a reason", () => {
  const events = closedThreeSkuEvents().map((event) => (
    event.sku === "safe-2" ? { ...event, reason: "" } : event
  ));
  const gate = evaluateThreeSkuGate({
    events,
    targetSkus: ["safe-1", "safe-2", "poison-1"],
  });
  assert.equal(gate.passed, false);
  assert.equal(gate.checks.zero_missing_reasons, false);
  assert.equal(gate.missing_reasons, 1);
});

test("deterministic poison SKU is closed once and any later attempt is rejected", () => {
  const safe = evaluateThreeSkuGate({
    events: closedThreeSkuEvents(),
    targetSkus: ["safe-1", "safe-2", "poison-1"],
  });
  assert.equal(safe.passed, true);
  assert.equal(safe.deterministic_terminal_retries, 0);

  const retried = evaluateThreeSkuGate({
    events: [
      ...closedThreeSkuEvents(),
      { type: "sku-attempt", at: minute(5), sku: "poison-1" },
    ],
    targetSkus: ["safe-1", "safe-2", "poison-1"],
  });
  assert.equal(retried.passed, false);
  assert.equal(retried.checks.no_deterministic_terminal_retries, false);
  assert.equal(retried.deterministic_terminal_retries, 1);
});

test("two-hour replay permits one lossless browser recovery but rejects a second or state loss", () => {
  const base = [
    ...strictSeries(70, 115),
    ...healthyProcessSamples(120),
  ];
  const recovered = {
    type: "browser-recovery",
    at: minute(60),
    outcome: "recovered",
    state_lost: false,
  };
  assert.equal(evaluateTwoHourGate({
    events: [...base, recovered],
    startedAt: START,
    endedAt: minute(120),
  }).passed, true);

  const twice = evaluateTwoHourGate({
    events: [
      ...base,
      recovered,
      { ...recovered, at: minute(90) },
    ],
    startedAt: START,
    endedAt: minute(120),
  });
  assert.equal(twice.passed, false);
  assert.equal(twice.checks.at_most_one_recovered_crash, false);

  const lost = evaluateTwoHourGate({
    events: [...base, { ...recovered, state_lost: true }],
    startedAt: START,
    endedAt: minute(120),
  });
  assert.equal(lost.passed, false);
  assert.equal(lost.checks.zero_state_loss, false);
});

test("two-hour replay excludes a confirmation submitted before the formal window", () => {
  const rows = strictSeries(70, 115);
  rows[0] = { ...rows[0], submitted_at: minute(-1) };
  const gate = evaluateTwoHourGate({
    events: [...rows, ...healthyProcessSamples(120)],
    startedAt: START,
    endedAt: minute(120),
  });
  assert.equal(gate.passed, false);
  assert.equal(gate.unique_current_window_strict, 69);
  assert.equal(gate.carried_in_strict_events, 1);
  assert.equal(gate.checks.zero_carried_in_strict, false);
});

test("30-minute gate rejects an orphan owner or a buffer that is not replenished", () => {
  const events = [
    ...healthyProcessSamples(30),
    { type: "process-snapshot", at: minute(20), supervisor_count: 1, worker_count: 0, profile_owner_count: 0, orphan_browser_count: 1 },
    { type: "candidate-buffer", at: minute(0), ready_unique: 70, added_unique: 70 },
    { type: "candidate-buffer", at: minute(30), ready_unique: 69, added_unique: 0 },
  ];
  const gate = evaluateThirtyMinuteGate({
    events,
    startedAt: START,
    endedAt: minute(30),
  });
  assert.equal(gate.passed, false);
  assert.equal(gate.checks.zero_orphan_processes, false);
  assert.equal(gate.checks.candidate_buffer_sustained, false);
  assert.equal(gate.checks.candidate_buffer_replenished, false);
});

test("ERP rate-limit replay enforces both the 180-second floor and longer server Retry-After", () => {
  const obeyed = replayAcceptanceEvents([
    { type: "erp-rate-limit", at: minute(5), retry_after_ms: 600_000 },
    { type: "erp-sync-attempt", at: minute(15) },
    { type: "erp-rate-limit", at: minute(20), retry_after_ms: 60_000 },
    { type: "erp-sync-attempt", at: minute(23) },
  ], { startedAt: START, endedAt: minute(30) });
  assert.equal(obeyed.erp_backoff_violations, 0);
  assert.equal(obeyed.erp_rate_limits, 2);

  const tooEarlyForServer = replayAcceptanceEvents([
    { type: "erp-rate-limit", at: minute(5), retry_after_ms: 600_000 },
    { type: "erp-sync-attempt", at: minute(14.99) },
  ], { startedAt: START, endedAt: minute(30) });
  assert.equal(tooEarlyForServer.erp_backoff_violations, 1);

  const tooEarlyForFloor = replayAcceptanceEvents([
    { type: "erp-rate-limit", at: minute(20), retry_after_ms: 60_000 },
    { type: "erp-sync-attempt", at: minute(22.99) },
  ], { startedAt: START, endedAt: minute(30) });
  assert.equal(tooEarlyForFloor.erp_backoff_violations, 1);
});

test("24-hour replay exposes reliable-cost and strict-profit violations as hard failures", () => {
  const rows = strictSeries(500, 840);
  rows[10] = { ...rows[10], cost_reliable: false };
  rows[11] = { ...rows[11], profit_rate: 30 };
  const gate = evaluateTwentyFourHourGate({
    events: [...rows, ...healthyProcessSamples(1_440)],
    startedAt: START,
    endedAt: minute(1_440),
  });
  assert.equal(gate.passed, false);
  assert.equal(gate.checks.zero_cost_violations, false);
  assert.equal(gate.checks.zero_profit_violations, false);
  assert.equal(gate.unique_current_window_strict, 498);
});
