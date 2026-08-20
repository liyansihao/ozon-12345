import assert from "node:assert/strict";
import test from "node:test";

import { validate24hAcceptanceEnv } from "../scripts/flow_b_acceptance_preflight.mjs";

function validEnv() {
  return {
    FLOW_B_ACCEPTANCE_SECONDS: "86400",
    FLOW_B_ACCEPTANCE_TARGET_POLICY: "fixed",
    FLOW_B_ACCEPTANCE_TARGET: "500",
    FLOW_B_STORE_ACCEPTANCE_TARGET: "100",
    FLOW_B_TARGET_PUBLISH_COUNT: "500",
    FLOW_B_REQUIRE_PER_STORE_ACCEPTANCE: "1",
    FLOW_B_MINIMUM_AVERAGE_PER_HOUR_EXCLUSIVE: "35",
    FLOW_B_DAILY_STORE_LIMIT: "100",
    FLOW_B_STORE_TOTAL_LIMIT: "100",
    FLOW_B_DAILY_STORE_TIMEZONE: "Asia/Shanghai",
    FLOW_B_PROFIT_THRESHOLD: "30",
    FLOW_B_EXCLUDED_SKUS: "2815247918",
    FLOW_B_WATERMARK_ID: "60822",
    FLOW_B_WATERMARK_NEEDLE: "lysh",
    FLOW_B_PUBLISH_WORKERS: "8",
    FLOW_B_MAX_PUBLISH_WORKERS: "12",
    FLOW_B_TAB_WORKERS: "3",
    FLOW_B_MAX_TAB_WORKERS: "4",
    FLOW_B_FAVORITE_DETAIL_INTERVAL_MS: "4000",
    FLOW_B_CONFIRMATION_ATTEMPTS: "1",
    FLOW_B_CONFIRMATION_INTERVAL_MS: "0",
    FLOW_B_1688_PERSISTENT_POOL: "1",
    FLOW_B_1688_WORKERS: "4",
    FLOW_B_VERIFY_LISTING_FBS_DETAIL: "1",
    FLOW_B_PROBE_INACTIVE_STORES: "1",
    FLOW_B_VERIFIED_SELLER_MIN_PUBLISHED: "2",
    FLOW_B_UNAVAILABLE_STORE_RETRY_MS: "300000",
    FLOW_B_URGENT_ONLINE_SYNC_INTERVAL_MS: "180000",
    FLOW_B_DERIVED_SEARCH_SOURCES: "0",
    FLOW_B_DERIVED_PRIORITY_SOURCES: "0",
    FLOW_B_PRIORITIZE_DERIVED_SEARCH: "0",
    FLOW_B_LOW_TOKEN_INTERVENTION: "0",
    FLOW_B_SOURCE_STRICT_WEIGHT: "6",
    FLOW_B_SOURCE_FBS_WEIGHT: "3",
    FLOW_B_SOURCE_EXPLORE_WEIGHT: "1",
    FLOW_B_STRICT_SOURCE_PORTFOLIO: "1",
    FLOW_B_SOURCE_ALLOWLIST_MATCH: "exact",
    FLOW_B_RUNTIME_STATE_DB: "/tmp/state/runtime/flow_b_state.sqlite",
    FLOW_B_RUNTIME_STATE_SCHEMA_VERSION: "4",
    FLOW_B_STORE_TARGETS: JSON.stringify([
      { id: 106637, needle: "丽丽二号", warehouseId: 1020005023256510, requireWarehouse: true },
      { id: 106640, needle: "丽丽三号", warehouseId: 1020005023616740, requireWarehouse: true },
      { id: 106644, needle: "丽丽四号", warehouseId: 1020005023616380, requireWarehouse: true },
      { id: 106646, needle: "丽丽五号", warehouseId: 1020005023616970, requireWarehouse: true },
      { id: 104965, needle: "丽丽1号", warehouseId: 1020005023597900, requireWarehouse: true },
    ]),
  };
}

test("24-hour acceptance preflight accepts the verified five-store contract", () => {
  const result = validate24hAcceptanceEnv(validEnv());
  assert.deepEqual(result.store_ids, [106637, 106640, 106644, 106646, 104965]);
  assert.equal(result.strict_profit_rule, "profit_rate > 30");
  assert.equal(result.target, 500);
  assert.equal(result.per_store_target, 100);
  assert.equal(result.minimum_average_per_hour, 35);
});

test("24-hour acceptance preflight rejects a dynamic or reduced target", () => {
  const env = {
    ...validEnv(),
    FLOW_B_ACCEPTANCE_TARGET_POLICY: "erp_remaining_capacity",
    FLOW_B_ACCEPTANCE_TARGET: "469",
    FLOW_B_TARGET_PUBLISH_COUNT: "469",
    FLOW_B_MINIMUM_AVERAGE_PER_HOUR_EXCLUSIVE: "",
  };
  assert.throws(
    () => validate24hAcceptanceEnv(env),
    /FLOW_B_ACCEPTANCE_TARGET_POLICY must equal fixed/,
  );
  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_ACCEPTANCE_TARGET: "499" }),
    /FLOW_B_ACCEPTANCE_TARGET must equal 500/,
  );
});

test("24-hour acceptance preflight rejects a relaxed or implicit profit threshold", () => {
  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_PROFIT_THRESHOLD: "29.99" }),
    /FLOW_B_PROFIT_THRESHOLD must equal 30/,
  );
  const env = validEnv();
  delete env.FLOW_B_PROFIT_THRESHOLD;
  assert.throws(() => validate24hAcceptanceEnv(env), /FLOW_B_PROFIT_THRESHOLD must equal 30/);
});

test("24-hour acceptance preflight rejects store order, unsafe warehouse, and missing bad-SKU exclusion", () => {
  const reordered = validEnv();
  reordered.FLOW_B_STORE_TARGETS = JSON.stringify(JSON.parse(reordered.FLOW_B_STORE_TARGETS).reverse());
  assert.throws(() => validate24hAcceptanceEnv(reordered), /store order must be/);

  const missingWarehouse = validEnv();
  const targets = JSON.parse(missingWarehouse.FLOW_B_STORE_TARGETS);
  targets[3].warehouseId = null;
  missingWarehouse.FLOW_B_STORE_TARGETS = JSON.stringify(targets);
  assert.throws(() => validate24hAcceptanceEnv(missingWarehouse), /positive warehouseId/);

  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_EXCLUDED_SKUS: "" }),
    /must include 2815247918/,
  );
});

test("24-hour acceptance preflight rejects disabled quality and reuse controls", () => {
  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_VERIFY_LISTING_FBS_DETAIL: "0" }),
    /FLOW_B_VERIFY_LISTING_FBS_DETAIL must equal 1/,
  );
  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_1688_PERSISTENT_POOL: "0" }),
    /FLOW_B_1688_PERSISTENT_POOL must equal 1/,
  );
  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_MAX_PUBLISH_WORKERS: "7" }),
    /publish concurrency must be 8..12/,
  );
  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_UNAVAILABLE_STORE_RETRY_MS: "1800000" }),
    /unavailable store retry must be at most 300000ms/,
  );
  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_PROBE_INACTIVE_STORES: "0" }),
    /FLOW_B_PROBE_INACTIVE_STORES must equal 1/,
  );
  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_VERIFIED_SELLER_MIN_PUBLISHED: "1" }),
    /FLOW_B_VERIFIED_SELLER_MIN_PUBLISHED must be at least 2/,
  );
  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_FAVORITE_DETAIL_INTERVAL_MS: "3000" }),
    /favorite detail interval must be at least 4000ms/,
  );
  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_CONFIRMATION_ATTEMPTS: "6" }),
    /confirmation attempts must equal 1/,
  );
  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_DAILY_STORE_TIMEZONE: "UTC" }),
    /FLOW_B_DAILY_STORE_TIMEZONE must equal Asia\/Shanghai/,
  );
  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_URGENT_ONLINE_SYNC_INTERVAL_MS: "179999" }),
    /urgent online sync interval must be at least 180000ms/,
  );
  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_REQUIRE_PER_STORE_ACCEPTANCE: "0" }),
    /FLOW_B_REQUIRE_PER_STORE_ACCEPTANCE must equal 1/,
  );
  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_DERIVED_SEARCH_SOURCES: "1" }),
    /FLOW_B_DERIVED_SEARCH_SOURCES must equal 0/,
  );
  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_SOURCE_EXPLORE_WEIGHT: "2" }),
    /source weights must freeze verified\/exploration at 90\/10/,
  );
  assert.throws(
    () => validate24hAcceptanceEnv({ ...validEnv(), FLOW_B_RUNTIME_STATE_DB: "" }),
    /external SQLite state/,
  );
});
