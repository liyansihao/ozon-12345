import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);
const bundledNode = process.env.OZON_REPORT_NODE
  || "/Users/mac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node";

test("bundled artifact runtime exports and verifies the daily workbook", async (t) => {
  try {
    await fs.access(bundledNode);
  } catch {
    t.skip("bundled Node runtime is unavailable");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-daily-workbook-test-"));
  const runDir = path.join(root, "run");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "erp_accepted.jsonl"), `${JSON.stringify({
    sku: "SRC-001",
    store_id: 104965,
    offer_id: "OFFER-001",
    accepted_at: "2026-08-08T13:00:00.000Z",
  })}\n`);
  const dbPath = path.join(root, "runtime.sqlite");
  const database = new DatabaseSync(dbPath);
  database.exec("CREATE TABLE sku_state (sku TEXT PRIMARY KEY, stage TEXT, terminal INTEGER, reason TEXT, updated_at TEXT, data_json TEXT)");
  database.prepare("INSERT INTO sku_state VALUES (?, ?, ?, ?, ?, ?)").run(
    "SRC-001",
    "published",
    0,
    "",
    "2026-08-08T13:20:00.000Z",
    JSON.stringify({
      store_id: 104965,
      store_sku: "900000000001",
      offer_id: "OWN-001",
      warehouse_id: 1020005023597900,
      package_weight_grams: 600,
      sell_price: 129,
      profit_rate: 33,
      reconciled_at: "2026-08-08T13:20:00.000Z",
    }),
  );
  database.close();
  const stores = [
    [104965, "丽丽1号", 1020005023597900, 1020005026342280],
    [106637, "丽丽二号", 1020005023256510, 1020005026343390],
    [106640, "丽丽三号", 1020005023616740, 1020005026339130],
    [106644, "丽丽四号", 1020005023616380, 1020005026343030],
    [106646, "丽丽五号", 1020005023616970, 1020005026342580],
    [113151, "丽丽六号", 1020005024854760, 1020005026343600],
    [113153, "丽丽七号", 1020005024855310, 1020005026341880],
    [113154, "丽丽八号", 1020005024855600, 1020005026343890],
    [113155, "丽丽九号", 1020005024855790, 1020005026344240],
    [113156, "丽丽十号", 1020005024856090, 1020005026344600],
  ].map(([id, name, warehouse_id, ural_warehouse_id]) => ({ id, name, warehouse_id, ural_warehouse_id }));
  const storesFile = path.join(root, "stores.json");
  await fs.writeFile(storesFile, JSON.stringify(stores));
  const outputDir = path.join(root, "out");
  const generator = path.resolve(import.meta.dirname, "../scripts/generate_daily_pricing_report.mjs");
  const { stdout } = await execFileAsync(bundledNode, [
    generator,
    "--run-dir", runDir,
    "--runtime-db", dbPath,
    "--stores-file", storesFile,
    "--date", "2026-08-08",
    "--output-dir", outputDir,
    "--runtime-root", path.join(root, "report-runtime"),
    "--node-modules", "/Users/mac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules",
    "--verify",
  ], { cwd: path.resolve(import.meta.dirname, "../.."), maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(stdout.slice(stdout.lastIndexOf('{\n  "ok"')));
  assert.equal(result.ok, true);
  assert.equal(result.sheets.length, 12);
  await fs.access(path.join(outputDir, "Ozon人工核价_2026-08-08.xlsx"));
  await fs.access(path.join(outputDir, ".previews", "2026-08-08", "汇总.png"));
});
