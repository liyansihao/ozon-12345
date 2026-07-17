import test from "node:test";
import assert from "node:assert/strict";

import { buildStatusSnapshot } from "../scripts/flow_b_status_snapshot.mjs";

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
    ],
    skuStateEvents: [
      { sku: "waiting", status: "processing", data: { store_id: 3, submitted: true } },
    ],
    storeTargetEvents: [
      { at: "2026-07-17T01:00:00.000Z", store_id: 2, warehouse_id: 2002, daily_usage: 3, daily_limit: 100 },
      { at: "2026-07-17T01:01:00.000Z", store_id: 3, available: false, reason: "warehouse-unavailable-after-sync", daily_usage: 100, daily_limit: 100 },
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
  assert.deepEqual(snapshot.selected.by_store, { "2": 1, "3": 1 });
  assert.deepEqual(snapshot.rolling[60], { count: 3, per_hour: 3 });
  assert.equal(snapshot.pace_35.target_reached_at, null);
  assert.equal(snapshot.pace_35.passed, false);
  assert.equal(snapshot.runtime_errors.total, 1);
  assert.deepEqual(snapshot.quota.by_store, {
    "2": { daily_usage: 30, daily_limit: 100, daily_remaining: 70, available: true, warehouse_id: 2002, reason: null },
    "3": { daily_usage: 100, daily_limit: 100, daily_remaining: 0, available: false, warehouse_id: null, reason: "warehouse-unavailable-after-sync" },
  });
  assert.deepEqual(snapshot.quota.shortfall_by_store, { "2": 0, "3": 0 });
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
