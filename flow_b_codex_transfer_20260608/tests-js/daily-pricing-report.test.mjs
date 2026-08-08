import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  readDailyPricingScope,
  reportOutputPath,
  reportScopeReady,
} from "../scripts/daily-pricing-report.mjs";

const stores = [
  { id: 104965, name: "丽丽1号", warehouse_id: 1020005023597900, ural_warehouse_id: 1020005026342280 },
  { id: 106637, name: "丽丽二号", warehouse_id: 1020005023256510, ural_warehouse_id: 1020005026343390 },
];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-daily-report-test-"));
  const runDir = path.join(root, "run");
  await fs.mkdir(runDir, { recursive: true });
  const accepted = [
    { sku: "SRC-001", store_id: 104965, offer_id: "OFFER-001", accepted_at: "2026-08-08T13:00:00.000Z" },
    { sku: "SRC-002", store_id: 104965, offer_id: "OFFER-002", accepted_at: "2026-08-08T13:01:00.000Z" },
    { sku: "SRC-003", store_id: 106637, offer_id: "OFFER-003", accepted_at: "2026-08-08T13:02:00.000Z" },
  ];
  await fs.writeFile(path.join(runDir, "erp_accepted.jsonl"), `${accepted.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const runtimeDbPath = path.join(root, "runtime.sqlite");
  const database = new DatabaseSync(runtimeDbPath);
  database.exec(`CREATE TABLE sku_state (
    sku TEXT PRIMARY KEY,
    stage TEXT,
    terminal INTEGER,
    reason TEXT,
    updated_at TEXT,
    data_json TEXT
  )`);
  const insert = database.prepare("INSERT INTO sku_state VALUES (?, ?, ?, ?, ?, ?)");
  insert.run(
    "SRC-001",
    "published",
    0,
    "",
    "2026-08-08T13:30:00.000Z",
    JSON.stringify({
      store_id: 104965,
      store_sku: "900000000001",
      offer_id: "OWN-001",
      warehouse_id: 1020005023597900,
      package_weight_grams: 400,
      sell_price: 99.9,
      profit_rate: 35,
      reconciled_at: "2026-08-08T13:30:00.000Z",
    }),
  );
  insert.run(
    "SRC-002",
    "publish-final-status-timeout",
    1,
    "import-rejected",
    "2026-08-08T13:31:00.000Z",
    JSON.stringify({ store_id: 104965, offer_id: "OWN-002" }),
  );
  insert.run(
    "SRC-003",
    "processing",
    0,
    "",
    "2026-08-08T13:32:00.000Z",
    JSON.stringify({ store_id: 106637, offer_id: "OWN-003" }),
  );
  database.close();
  return { root, runDir, runtimeDbPath };
}

test("daily scope waits for non-terminal own SKU but admits terminal failure", async () => {
  const value = await fixture();
  const scope = readDailyPricingScope({
    ...value,
    stores,
    dateKey: "2026-08-08",
    now: new Date("2026-08-08T12:30:00Z"),
  });
  assert.equal(scope.accepted_count, 3);
  assert.equal(scope.pending_count, 1);
  assert.equal(scope.terminal_failed_count, 1);
  assert.equal(scope.ready, false);
  assert.equal(scope.rows.find((row) => row.source_sku === "SRC-001").own_ozon_sku, "900000000001");
  assert.equal(scope.rows.find((row) => row.source_sku === "SRC-001").warehouse, "邮政 (1020005023597900)");
  assert.equal(scope.exceptions.find((row) => row.source_sku === "SRC-002").status, "终态失败");
  assert.equal(reportScopeReady(scope), false);
});

test("store ID mismatch blocks a report instead of mis-assigning a row", async () => {
  const value = await fixture();
  const database = new DatabaseSync(value.runtimeDbPath);
  database.prepare("UPDATE sku_state SET data_json=? WHERE sku=?").run(
    JSON.stringify({ store_id: 106637, store_sku: "900000000002", offer_id: "OWN-002" }),
    "SRC-002",
  );
  database.prepare("UPDATE sku_state SET data_json=? WHERE sku=?").run(
    JSON.stringify({ store_id: 104965, store_sku: "900000000003", offer_id: "OWN-003" }),
    "SRC-003",
  );
  database.close();
  const scope = readDailyPricingScope({
    ...value,
    stores,
    dateKey: "2026-08-08",
    now: new Date("2026-08-08T12:30:00Z"),
  });
  assert.equal(scope.mismatch_count, 2);
  assert.equal(scope.ready, false);
  assert.equal(scope.exceptions.filter((row) => row.status === "店铺ID不匹配").length, 2);
});

test("report output names are stable and date-scoped", () => {
  assert.equal(
    reportOutputPath("/tmp/Ozon每日核价", "2026-08-09"),
    "/tmp/Ozon每日核价/Ozon人工核价_2026-08-09.xlsx",
  );
});
