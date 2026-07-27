import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  parseCli,
  parseDailyStoreUsageSeed,
  parseStoreTargets,
  parseStoreTotalUsageSeed,
  publishedCsvPath,
  sourceScanOutputFile,
} from "../scripts/flow_b_playwright.mjs";

test("publish CLI uses strict production defaults", () => {
  const parsed = parseCli(["publish", "/tmp/flow-run"], {});
  assert.equal(parsed.command, "publish");
  assert.equal(parsed.runDir, path.resolve("/tmp/flow-run"));
  assert.equal(parsed.threshold, 30);
  assert.equal(parsed.target, 500);
  assert.equal(parsed.storeNeedle, "丽丽1号");
  assert.equal(parsed.watermarkNeedle, "lysh");
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

test("run and accept can rotate to a safe gate-specific scan checkpoint", () => {
  const env = { FLOW_B_SOURCE_SCAN_STATE_FILE: "source_deep_scan_detail_verified.json" };
  assert.equal(
    sourceScanOutputFile("/tmp/run", env),
    "/tmp/run/source_deep_scan_detail_verified.json",
  );
  assert.equal(
    parseCli(["accept", "/tmp/run", "urls.txt"], env).outFile,
    "/tmp/run/source_deep_scan_detail_verified.json",
  );
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
  assert.deepEqual(parseStoreTargets({}), [
    { id: 106637, needle: "丽丽二号", warehouseId: 1020005023256510, requireWarehouse: true },
    { id: 106640, needle: "丽丽三号", warehouseId: 1020005023616740, requireWarehouse: true },
    { id: 106644, needle: "丽丽四号", warehouseId: 1020005023616380, requireWarehouse: true },
    { id: 106646, needle: "丽丽五号", warehouseId: 1020005023616970, requireWarehouse: true },
    { id: 104965, needle: "丽丽1号", warehouseId: 1020005023597900, requireWarehouse: true },
  ]);
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
