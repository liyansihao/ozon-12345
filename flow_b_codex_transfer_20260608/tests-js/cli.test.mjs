import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  acceptanceSourceConfig,
  acceptanceRoundPlan,
  allDirectStoresRejected,
  isRecoverableForegroundFavoritesTimeout,
  parseCli,
  parseDailyStoreUsageSeed,
  parseProfitSafetyActionPolicy,
  publishAttemptLimit,
  parseStoreTargets,
  parseStoreTotalUsageSeed,
  publishedCsvPath,
  resumedAcceptanceWindow,
  runForegroundPublishAttempt,
  sourceScanOutputFile,
  unlimitedPublishTarget,
} from "../scripts/flow_b_playwright.mjs";

function maoziTimeout(overrides = {}) {
  return Object.assign(new Error("Maozi GET favorites timed out"), {
    code: "MAOZI_REQUEST_TIMEOUT",
    endpoint: "/api.product.favorite/lists",
    method: "GET",
    phase: "context-fetch",
    timeout_ms: 30_000,
    ...overrides,
  });
}

test("foreground recovery only accepts a structured favorites GET timeout", async () => {
  const timeout = maoziTimeout();
  assert.equal(isRecoverableForegroundFavoritesTimeout(timeout), true);
  for (const error of [
    maoziTimeout({ method: "POST" }),
    maoziTimeout({ endpoint: "/api.product.import_logs/index" }),
    maoziTimeout({ code: "OTHER_TIMEOUT" }),
    Object.assign(new Error("Maozi favorites request failed: Unauthenticated"), { status: 401 }),
    maoziTimeout({ message: "Target page, context or browser has been closed" }),
  ]) {
    assert.equal(isRecoverableForegroundFavoritesTimeout(error), false);
    await assert.rejects(
      runForegroundPublishAttempt(async () => { throw error; }),
      (observed) => observed === error,
    );
  }
});

test("foreground favorites timeout discards its session and retries without cancelling the run", async () => {
  const directRunControl = { cancelled: false, fatalError: null };
  const shared = { session: { id: 1 } };
  let closed = 0;
  let recoveries = 0;
  let attempts = 0;
  const publishRound = async () => {
    attempts += 1;
    if (attempts === 1) {
      shared.session = null;
      closed += 1;
      throw maoziTimeout();
    }
    shared.session = { id: 2 };
    return { accepted: 1 };
  };

  const first = await runForegroundPublishAttempt(publishRound, {
    onRecoverableTimeout: async () => {
      recoveries += 1;
      assert.equal(shared.session, null);
    },
  });
  assert.equal(first.retry, true);
  assert.equal(closed, 1);
  assert.equal(recoveries, 1);
  assert.deepEqual(directRunControl, { cancelled: false, fatalError: null });

  const second = await runForegroundPublishAttempt(publishRound);
  assert.deepEqual(second, { retry: false, value: { accepted: 1 } });
  assert.equal(attempts, 2);
});

test("profit safety action policy defaults to shadow and requires an explicit enforce value", () => {
  assert.equal(parseProfitSafetyActionPolicy({}), "shadow");
  assert.equal(parseProfitSafetyActionPolicy({
    FLOW_B_PROFIT_SAFETY_ACTION_POLICY: " enforce ",
  }), "enforce");
  assert.throws(
    () => parseProfitSafetyActionPolicy({ FLOW_B_PROFIT_SAFETY_ACTION_POLICY: "automatic" }),
    /must be shadow or enforce/u,
  );
});

test("direct run stops only after every configured store is rejected", () => {
  assert.equal(allDirectStoresRejected({
    halt_reason: "daily-product-limit",
    stores_exhausted: { all: true },
  }), true);
  assert.equal(allDirectStoresRejected({
    halt_reason: "store-unavailable",
    stores_exhausted: { all: true },
  }), true);
  assert.equal(allDirectStoresRejected({
    halt_reason: "daily-product-limit",
    stores_exhausted: { all: false },
  }), false);
  assert.equal(allDirectStoresRejected({ halt_reason: "daily-product-limit" }), false);
  assert.equal(allDirectStoresRejected({
    halt_reason: "captcha",
    stores_exhausted: { all: true },
  }), false);
});

test("formal worker persists current-window-only source scope for restart", () => {
  assert.deepEqual(acceptanceSourceConfig({
    mode: "continuous-acceptance",
    current_window_only: false,
  }), {
    mode: "continuous-acceptance",
    current_window_only: true,
  });
});

test("formal accept freezes one same-worker publish/refill tranche", () => {
  assert.deepEqual(acceptanceRoundPlan({
    FLOW_B_PUBLISH_TRANCHE_ATTEMPTS: "8",
    FLOW_B_BUFFER_REFILL_TARGET: "8",
    FLOW_B_BUFFER_REFILL_ATTEMPT_LIMIT: "24",
  }), {
    publish_attempt_limit: 8,
    refill_target: 8,
    refill_attempt_limit: 24,
  });
  assert.throws(
    () => acceptanceRoundPlan({ FLOW_B_BUFFER_REFILL_TARGET: "0" }),
    /positive integer/u,
  );
});

test("resuming a formal window preserves every fixed-500 contract field", () => {
  const result = resumedAcceptanceWindow({
    started_at: "2026-07-30T00:00:00.000Z",
    ended_at: "2026-07-31T00:00:00.000Z",
    acceptance_target: 500,
    acceptance_target_policy: "fixed",
    per_store_target: 100,
    rolling_rate_window_minutes: 120,
    current_window_only: true,
  }, {
    startedAt: "2026-07-30T00:00:00.000Z",
    endedAt: "2026-07-31T00:00:00.000Z",
    acceptanceTarget: 500,
    targetPolicy: "fixed",
    minimumAveragePerHourExclusive: 35,
  });
  assert.equal(result.per_store_target, 100);
  assert.equal(result.rolling_rate_window_minutes, 120);
  assert.equal(result.current_window_only, true);
  assert.equal(result.acceptance_target, 500);
});

test("publish CLI uses strict production defaults", () => {
  const parsed = parseCli(["publish", "/tmp/flow-run"], {});
  assert.equal(parsed.command, "publish");
  assert.equal(parsed.runDir, path.resolve("/tmp/flow-run"));
  assert.equal(parsed.threshold, 30);
  assert.equal(parsed.target, 500);
  assert.equal(parsed.storeNeedle, "丽丽1号");
  assert.equal(parsed.watermarkNeedle, "lysh");
});

test("direct production speed trial has an explicit bounded candidate-attempt budget", () => {
  assert.equal(publishAttemptLimit({}), 0);
  assert.equal(publishAttemptLimit({ FLOW_B_PUBLISH_ATTEMPT_LIMIT: "3" }), 3);
  assert.throws(
    () => publishAttemptLimit({ FLOW_B_PUBLISH_ATTEMPT_LIMIT: "0" }),
    /positive integer/u,
  );
  assert.throws(
    () => publishAttemptLimit({ FLOW_B_PUBLISH_ATTEMPT_LIMIT: "3.5" }),
    /positive integer/u,
  );
});

test("the direct run command accepts the same bounded candidate-attempt budget", () => {
  const parsed = parseCli(["run", "runs/speed", "urls.txt"], {
    FLOW_B_TARGET_PUBLISH_COUNT: "3",
    FLOW_B_PUBLISH_ATTEMPT_LIMIT: "3",
  });
  assert.equal(parsed.command, "run");
  assert.equal(parsed.target, 3);
  assert.equal(publishAttemptLimit({ FLOW_B_PUBLISH_ATTEMPT_LIMIT: "3" }), 3);
});

test("direct run accepts zero as an explicit unlimited publish target", () => {
  const parsed = parseCli(["run", "runs/continuous", "urls.txt"], {
    FLOW_B_TARGET_PUBLISH_COUNT: "0",
  });
  assert.equal(parsed.target, 0);
  assert.equal(unlimitedPublishTarget(parsed.target), true);
  assert.equal(unlimitedPublishTarget(500), false);
  assert.throws(
    () => parseCli(["run", "runs/invalid", "urls.txt"], { FLOW_B_TARGET_PUBLISH_COUNT: "-1" }),
    /zero \(unlimited\) or a positive integer/u,
  );
});

test("CLI accepts setup, scan, and run shapes", () => {
  assert.equal(parseCli(["setup"], {}).command, "setup");
  assert.equal(parseCli(["verify"], {}).command, "verify");
  assert.deepEqual(
    Object.keys(parseCli(["scan", "urls.txt", "out.json"], {})).filter((key) => ["command", "urlsFile", "outFile"].includes(key)),
    ["command", "urlsFile", "outFile"],
  );
  const run = parseCli(["run", "/tmp/run", "urls.txt"], {});
  assert.equal(run.command, "run");
  assert.equal(run.runDir, "/tmp/run");
  assert.equal(run.urlsFile, path.resolve("urls.txt"));
  assert.equal(run.outFile, "/tmp/run/source_deep_scan.json");
});

test("run can rotate to a safe scan checkpoint and the strict accept command is removed", () => {
  const env = { FLOW_B_SOURCE_SCAN_STATE_FILE: "source_deep_scan_detail_verified.json" };
  assert.equal(
    sourceScanOutputFile("/tmp/run", env),
    "/tmp/run/source_deep_scan_detail_verified.json",
  );
  assert.throws(() => parseCli(["accept", "/tmp/run", "urls.txt"], env), /unknown command/u);
  assert.throws(
    () => sourceScanOutputFile("/tmp/run", { FLOW_B_SOURCE_SCAN_STATE_FILE: "../outside.json" }),
    /safe JSON filename/,
  );
});

test("CLI validates numbers, commands, and required paths without launching", () => {
  assert.throws(() => parseCli(["scan", "urls.txt"], {}), /OUT\.json/);
  assert.throws(() => parseCli(["publish"], {}), /RUN_DIR/);
  assert.throws(() => parseCli(["unknown"], {}), /unknown command/i);
  assert.throws(() => parseCli(["publish", "/tmp/run"], { FLOW_B_TARGET_PUBLISH_COUNT: "zero" }), /TARGET.*integer/i);
  assert.equal(parseCli(["--help"], {}).command, "help");
});

test("environment overrides production defaults explicitly", () => {
  const parsed = parseCli(["publish", "/tmp/run"], {
    FLOW_B_PROFIT_THRESHOLD: "35.5",
    FLOW_B_TARGET_PUBLISH_COUNT: "12",
    FLOW_B_STORE_NEEDLE: "店铺A",
    FLOW_B_WATERMARK_NEEDLE: "wm",
  });
  assert.equal(parsed.threshold, 35.5);
  assert.equal(parsed.target, 12);
  assert.equal(parsed.storeNeedle, "店铺A");
  assert.equal(parsed.watermarkNeedle, "wm");
});

test("published state can use a durable CSV outside the recyclable worktree", () => {
  assert.equal(
    publishedCsvPath({ FLOW_B_PUBLISHED_CSV: "/tmp/ozon-durable/published_links.csv" }),
    "/tmp/ozon-durable/published_links.csv",
  );
  assert.match(publishedCsvPath({}), /data\/flow_b\/published_links\.csv$/);
});

test("store target environment parses an ordered verified rotation plan", () => {
  assert.deepEqual(parseStoreTargets({
    FLOW_B_STORE_TARGETS: JSON.stringify([
      { id: 104965, needle: "丽丽1号", warehouseId: 1020005022957960 },
      { id: 106637, needle: "丽丽二号" },
    ]),
  }), [
    { id: 104965, needle: "丽丽1号", warehouseId: 1020005022957960, requireWarehouse: true },
    { id: 106637, needle: "丽丽二号", warehouseId: null, requireWarehouse: true },
  ]);
  const defaults = parseStoreTargets({});
  assert.deepEqual(defaults.map((row) => row.id), [
    104965, 106637, 106640, 106644, 106646, 113151, 113153, 113154, 113155, 113156,
  ]);
  assert.deepEqual(defaults.map((row) => row.warehouseId), [
    1020005023597900, 1020005023256510, 1020005023616740, 1020005023616380, 1020005023616970,
    1020005024854760, 1020005024855310, 1020005024855600, 1020005024855790, 1020005024856090,
  ]);
  assert.deepEqual(defaults.map((row) => row.uralWarehouseId), [
    1020005026342280, 1020005026343390, 1020005026339130, 1020005026343030, 1020005026342580,
    1020005026343600, 1020005026341880, 1020005026343890, 1020005026344240, 1020005026344600,
  ]);
  assert.ok(defaults.every((row) => row.requireWarehouse
    && row.weightRouting === true
    && row.weightThresholdGrams === 500));
  assert.throws(() => parseStoreTargets({ FLOW_B_STORE_TARGETS: "not-json" }), /STORE_TARGETS.*JSON/i);
});

test("daily store usage seed is date-scoped so it cannot leak into the next day", () => {
  assert.deepEqual(parseDailyStoreUsageSeed({
    FLOW_B_STORE_DAILY_USAGE_SEED: JSON.stringify({ date: "2026-07-15", usage: { 106637: 45 } }),
  }), { date: "2026-07-15", usage: { 106637: 45 } });
  assert.equal(parseDailyStoreUsageSeed({}), null);
  assert.throws(() => parseDailyStoreUsageSeed({
    FLOW_B_STORE_DAILY_USAGE_SEED: JSON.stringify({ date: "15-07-2026", usage: { 106637: 45 } }),
  }), /STORE_DAILY_USAGE_SEED/i);
});

test("total store usage seed persists the verified per-store target across day rollover", () => {
  assert.deepEqual(parseStoreTotalUsageSeed({
    FLOW_B_STORE_TOTAL_USAGE_SEED: JSON.stringify({ 106637: 94, 106640: 0 }),
  }), { 106637: 94, 106640: 0 });
  assert.deepEqual(parseStoreTotalUsageSeed({}), {});
  assert.throws(() => parseStoreTotalUsageSeed({
    FLOW_B_STORE_TOTAL_USAGE_SEED: JSON.stringify({ 106637: -1 }),
  }), /STORE_TOTAL_USAGE_SEED/i);
});
