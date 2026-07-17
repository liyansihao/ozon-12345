import test from "node:test";
import assert from "node:assert/strict";

import { buildStatusSnapshot } from "../scripts/flow_b_status_snapshot.mjs";

test("compact status reports strict per-store progress and rolling speed", () => {
  const snapshot = buildStatusSnapshot({
    config: {
      window_started_at: "2026-07-17T00:00:00.000Z",
      window_ended_at: "2026-07-18T00:00:00.000Z",
      per_store_target: 2,
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
  assert.equal(snapshot.runtime_errors.total, 1);
  assert.ok(JSON.stringify(snapshot).length < 1500);
});
