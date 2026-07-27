import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCapacityPreflight,
  nextShanghaiQuotaReset,
} from "../scripts/flow_b_playwright/capacity-preflight.mjs";

const configuredStores = [
  { id: 106637, name: "丽丽二号", warehouse_id: 11 },
  { id: 106640, name: "丽丽三号", warehouse_id: 22 },
  { id: 106644, name: "丽丽四号", warehouse_id: 33 },
  { id: 106646, name: "丽丽五号", warehouse_id: 44 },
  { id: 104965, name: "丽丽1号", warehouse_id: 55 },
];

function erpStores(usage = {}, resetAt = {}) {
  return configuredStores.map((store) => ({
    id: store.id,
    name: store.name,
    warehouse: store.id === 106646 ? [] : [{ warehouse_id: store.warehouse_id }],
    product_limit: {
      daily_create: {
        limit: 100,
        usage: Number(usage[store.id] || 0),
        ...(resetAt[store.id] ? { reset_at: resetAt[store.id] } : {}),
      },
    },
  }));
}

test("capacity preflight confirms exact ERP warehouses and current Shanghai-day quota", () => {
  const snapshot = buildCapacityPreflight({
    configuredStores,
    erpStores: erpStores({ 106637: 10 }),
    profileStores: [{ id: 106646, warehouse: [{ warehouse_id: 44 }] }],
    checkedAt: "2026-07-27T15:30:00.000Z",
  });
  assert.equal(snapshot.quota_day, "2026-07-27");
  assert.equal(snapshot.next_reset_at, "2026-07-27T16:00:00.000Z");
  assert.equal(snapshot.next_reset_source, "shanghai-midnight-fallback");
  assert.equal(snapshot.all_warehouses_verified, true);
  assert.equal(snapshot.all_quotas_verified, true);
  assert.equal(snapshot.total_remaining_capacity, 490);
  assert.equal(snapshot.capacity_sufficient, true);
});

test("used quota below 481 waits for reset and an unverified warehouse never counts", () => {
  const used = buildCapacityPreflight({
    configuredStores,
    erpStores: erpStores({ 106637: 20, 106640: 7, 104965: 31 }),
    profileStores: [{ id: 106646, warehouse: [{ warehouse_id: 44 }] }],
    checkedAt: "2026-07-27T12:00:00.000Z",
  });
  assert.equal(used.total_remaining_capacity, 442);
  assert.equal(used.capacity_sufficient, false);

  const badWarehouse = buildCapacityPreflight({
    configuredStores,
    erpStores: erpStores(),
    profileStores: [{ id: 106646, warehouse: [{ warehouse_id: 999 }] }],
  });
  assert.equal(badWarehouse.all_warehouses_verified, false);
  assert.equal(badWarehouse.stores.find((row) => row.store_id === 106646).available, false);
});

test("capacity preflight uses the ERP daily-create reset that can clear the shortfall", () => {
  const resetAt = "2026-07-28T00:00:00.000Z";
  const snapshot = buildCapacityPreflight({
    configuredStores,
    erpStores: erpStores(
      { 104965: 31 },
      { 104965: resetAt },
    ),
    profileStores: [{ id: 106646, warehouse: [{ warehouse_id: 44 }] }],
    checkedAt: "2026-07-27T16:01:00.000Z",
  });

  assert.equal(snapshot.total_remaining_capacity, 469);
  assert.equal(snapshot.capacity_sufficient, false);
  assert.equal(snapshot.next_reset_at, resetAt);
  assert.equal(snapshot.next_reset_source, "erp-daily-create");
  assert.equal(
    snapshot.stores.find((row) => row.store_id === 104965).erp_daily_reset_at,
    resetAt,
  );
});

test("Shanghai quota reset remains next local midnight", () => {
  assert.equal(nextShanghaiQuotaReset("2026-07-27T16:00:01.000Z"), "2026-07-28T16:00:00.000Z");
});
