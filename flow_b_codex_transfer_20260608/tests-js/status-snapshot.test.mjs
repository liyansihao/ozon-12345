import test from "node:test";
import assert from "node:assert/strict";

import { buildStatusSnapshot, compactStatusSnapshot } from "../scripts/flow_b_status_snapshot.mjs";

test("compact status reports strict per-store progress and rolling speed", () => {
  const snapshot = buildStatusSnapshot({
    config: {
      window_started_at: "2026-07-17T00:00:00.000Z",
      window_ended_at: "2026-07-18T00:00:00.000Z",
      per_store_target: 2,
      daily_store_timezone: "UTC",
      store_targets: [
        { id: 2, needle: "丽丽二号" },
        { id: 3, needle: "丽丽三号" },
      ],
    },
    published: [
      { sku: "ok-1", store_id: 2, profit_rate: 31, online_status: "selling", stock: 1, published_at: "2026-07-17T01:10:00.000Z" },
      { sku: "ok-2", store_id: 2, profit_rate: 80, online_status: "selling", stock: 2, published_at: "2026-07-17T01:40:00.000Z" },
      { sku: "ok-3", status: "published", data: { store_id: 3, profit_rate: 50, online_status: "selling", stock: 1, published_at: "2026-07-17T01:50:00.000Z" } },
      { sku: "equal-30", store_id: 3, profit_rate: 30, online_status: "selling", stock: 1, published_at: "2026-07-17T01:55:00.000Z" },
      { sku: "2815247918", store_id: 3, profit_rate: 99, online_status: "selling", stock: 1, published_at: "2026-07-17T01:56:00.000Z" },
    ],
    selected: [
      { sku: "ok-1", store_id: 2, profit_rate: 31 },
      { sku: "waiting", store_id: 3, profit_rate: 45 },
      { sku: "terminal", store_id: 3, profit_rate: 46 },
    ],
    skuStateEvents: [
      { sku: "waiting", status: "processing", data: { store_id: 3, submitted: true } },
      { sku: "terminal", status: "failed", data: { store_id: 3, submitted: true, reason: "import-failed" } },
    ],
    storeTargetEvents: [
      { at: "2026-07-17T01:00:00.000Z", store_id: 2, warehouse_id: 2002, daily_usage: 3, daily_limit: 100 },
      { at: "2026-07-17T01:01:00.000Z", store_id: 3, available: false, reason: "warehouse-unavailable-after-sync", daily_usage: 100, daily_limit: 100 },
      { at: "2026-07-17T02:01:00.000Z", store_id: 2, warehouse_id: 9999, daily_usage: 99, daily_limit: 100 },
    ],
    storeDailyUsageEvents: [
      { at: "2026-07-17T01:45:00.000Z", store_id: 2, usage: 30, limit: 100, event: "submission-accepted" },
      { at: "2026-07-16T23:59:00.000Z", store_id: 2, usage: 99, limit: 100, event: "submission-accepted" },
    ],
    runtimeErrors: [{ at: "2026-07-17T01:30:00.000Z" }],
    observedAt: "2026-07-17T02:00:00.000Z",
  });

  assert.equal(snapshot.window.complete, false);
  assert.equal(snapshot.strict.total, 3);
  assert.equal(snapshot.strict.per_hour, 1.5);
  assert.deepEqual(snapshot.strict.by_store, { "2": 2, "3": 1 });
  assert.deepEqual(snapshot.strict.remaining_by_store, { "2": 0, "3": 1 });
  assert.deepEqual(snapshot.selected.by_store, { "2": 1, "3": 2 });
  assert.deepEqual(snapshot.rolling[60], { count: 3, per_hour: 3 });
  assert.equal(snapshot.pace_35.target_reached_at, null);
  assert.equal(snapshot.pace_35.passed, false);
  assert.equal(snapshot.runtime_errors.total, 1);
  assert.deepEqual(snapshot.quota.by_store, {
    "2": { daily_usage: 30, daily_limit: 100, daily_remaining: 70, erp_daily_usage: 3, run_submitted_today: 30, strict_gap: 0, selected_terminal: 0, capacity_shortfall_until_reset: 0, available: true, warehouse_id: 2002, reason: null },
    "3": { daily_usage: 100, daily_limit: 100, daily_remaining: 0, erp_daily_usage: 100, run_submitted_today: 0, strict_gap: 1, selected_terminal: 1, capacity_shortfall_until_reset: 0, available: false, warehouse_id: null, reason: "warehouse-unavailable-after-sync" },
  });
  assert.deepEqual(snapshot.quota.shortfall_by_store, { "2": 0, "3": 0 });
  assert.deepEqual(snapshot.quota.capacity_shortfall_until_reset_by_store, { "2": 0, "3": 0 });
  assert.deepEqual(snapshot.quota.constrained_stores, ["3"]);
  assert.equal(snapshot.quota.next_reset_at, "2026-07-18T00:00:00.000Z");
  assert.ok(JSON.stringify(snapshot).length < 2500);
});

test("35 per hour pace uses time to complete every store quota, not the idle 24 hour tail", () => {
  const rows = [
    { sku: "2-a", store_id: 2, profit_rate: 40, online_status: "selling", stock: 1, published_at: "2026-07-17T00:01:00.000Z" },
    { sku: "3-a", store_id: 3, profit_rate: 40, online_status: "selling", stock: 1, published_at: "2026-07-17T00:02:00.000Z" },
    { sku: "2-b", store_id: 2, profit_rate: 40, online_status: "selling", stock: 1, published_at: "2026-07-17T00:05:00.000Z" },
    { sku: "3-b", store_id: 3, profit_rate: 40, online_status: "selling", stock: 1, published_at: "2026-07-17T00:06:00.000Z" },
  ];
  const snapshot = buildStatusSnapshot({
    config: {
      window_started_at: "2026-07-17T00:00:00.000Z",
      window_ended_at: "2026-07-18T00:00:00.000Z",
      per_store_target: 2,
      store_targets: [{ id: 2, needle: "丽丽二号" }, { id: 3, needle: "丽丽三号" }],
    },
    published: rows,
    observedAt: "2026-07-17T12:00:00.000Z",
  });

  assert.equal(snapshot.strict.per_hour, 0.33);
  assert.equal(snapshot.pace_35.target_reached_at, "2026-07-17T00:06:00.000Z");
  assert.equal(snapshot.pace_35.hours_to_target, 0.1);
  assert.equal(snapshot.pace_35.active_per_hour, 40);
  assert.equal(snapshot.pace_35.passed, true);
});

test("ERP-capacity completion is not rejected because a sub-481 daily cap cannot average 20 over 24 hours", () => {
  const snapshot = buildStatusSnapshot({
    config: {
      window_started_at: "2026-07-17T00:00:00.000Z",
      window_ended_at: "2026-07-18T00:00:00.000Z",
      acceptance_target: 1,
      minimum_average_per_hour_exclusive: null,
      per_store_target: null,
      store_targets: [{ id: 2, needle: "丽丽二号" }],
    },
    published: [{
      sku: "capacity-final",
      store_id: 2,
      profit_rate: 31,
      online_status: "selling",
      stock: 1,
      published_at: "2026-07-17T23:59:00.000Z",
    }],
    observedAt: "2026-07-18T00:00:00.000Z",
  });

  assert.equal(snapshot.strict.total, 1);
  assert.equal(snapshot.strict.per_hour, 0.04);
  assert.equal(snapshot.strict.passed, true);
});

test("token-light status keeps acceptance blockers without verbose store metadata", () => {
  const compact = compactStatusSnapshot({
    observed_at: "2026-07-17T02:00:00.000Z",
    window: { elapsed_hours: 2, remaining_seconds: 79_200, complete: false },
    strict: {
      total: 40,
      target: 500,
      per_hour: 20,
      by_store: { "2": 40, "3": 0 },
      remaining_by_store: { "2": 60, "3": 100 },
      passed: false,
    },
    selected: { total: 42, by_store: { "2": 42, "3": 0 } },
    rolling: { 15: { count: 9, per_hour: 36 }, 30: { count: 20, per_hour: 40 }, 60: { count: 30, per_hour: 30 }, 120: { count: 40, per_hour: 20 } },
    quota: {
      pending_confirmation_by_store: { "2": 2, "3": 0 },
      shortfall_by_store: { "2": 2, "3": 0 },
      constrained_stores: ["2", "3"],
      next_reset_at: "2026-07-18T00:00:00.000Z",
      by_store: {
        "2": { daily_usage: 42, daily_remaining: 58, available: true, warehouse_id: 2002, reason: null },
        "3": { daily_usage: 0, daily_remaining: 100, available: false, warehouse_id: null, reason: "warehouse-unavailable-after-sync" },
      },
    },
    runtime_errors: { total: 1, last_at: "2026-07-17T01:59:00.000Z" },
    pace_35: { active_per_hour: 20, required_remaining_per_hour: 38.33, passed: false },
  });

  assert.deepEqual(compact, {
    at: "2026-07-17T02:00:00.000Z",
    elapsed_h: 2,
    remaining_s: 79_200,
    strict: 40,
    target: 500,
    rate_h: 20,
    by_store: { "2": 40, "3": 0 },
    selected: 42,
    pending: { "2": 2, "3": 0 },
    rolling_h: { "15": 36, "30": 40, "60": 30, "120": 20 },
    constrained: ["2", "3"],
    capacity_shortfall_until_reset: { "2": 2, "3": 0 },
    shortfall: { "2": 2, "3": 0 },
    unavailable: { "3": "warehouse-unavailable-after-sync" },
    next_reset_at: "2026-07-18T00:00:00.000Z",
    errors: 1,
    pace35: false,
    required_h: 38.33,
    complete: false,
    passed: false,
  });
  assert.ok(JSON.stringify(compact).length < 650);
});
