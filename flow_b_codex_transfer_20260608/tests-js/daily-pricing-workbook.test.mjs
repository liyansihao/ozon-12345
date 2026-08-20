import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

import { STORE_SHEET_COLUMNS } from "../scripts/generate_daily_pricing_report.mjs";

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
  const supplyCheckedAt = new Date(Date.now() - 60_000);
  const supplyValidUntil = new Date(supplyCheckedAt.getTime() + 30 * 60_000);
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
      supply_gate_passed: true,
      supply_evidence: {
        contract: "1688-orderable-v1",
        passed: true,
        platform: "1688",
        offer_id: "987654321",
        offer_url: "https://detail.1688.com/offer/987654321.html",
        target_variant: { variant_id: "VARIANT-BLACK-L", label: "黑色 L" },
        variant_attributes: { 颜色: "黑色", 尺码: "L" },
        unit_price: 12.8,
        moq: 1,
        orderable_quantity: 1,
        orderable: true,
        stock_state: "in_stock",
        checked_at: supplyCheckedAt.toISOString(),
        valid_until: supplyValidUntil.toISOString(),
        match_evidence_key: "a".repeat(64),
        status: "verified",
      },
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
  const output = path.join(outputDir, "Ozon人工核价_2026-08-08.xlsx");
  await fs.access(output);
  await fs.access(path.join(outputDir, ".previews", "2026-08-08", "汇总.png"));

  const inspector = `
    import { createRequire } from "node:module";
    const require = createRequire(process.argv[1]);
    const { FileBlob, SpreadsheetFile } = require("@oai/artifact-tool");
    const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(process.argv[2]));
    const store = workbook.worksheets.getItem("丽丽1号");
    const summary = workbook.worksheets.getItem("汇总");
    const table = store.tables.items[0];
    console.log(JSON.stringify({
      values: store.getRange("A4:Y5").values,
      table_headers: table.getHeaderRowRange().values,
      link_formulas: store.getRange("O5:O5").formulas,
      summary_formulas: summary.getRange("E5:H5").formulas,
    }));
  `;
  const inspected = await execFileAsync(bundledNode, [
    "--input-type=module",
    "-e",
    inspector,
    path.join(root, "report-runtime", "artifact-entry.cjs"),
    output,
  ], { maxBuffer: 4 * 1024 * 1024 });
  const workbook = JSON.parse(inspected.stdout.trim().split(/\r?\n/u).at(-1));
  assert.deepEqual(workbook.values[0], [...STORE_SHEET_COLUMNS]);
  assert.deepEqual(workbook.table_headers[0], [...STORE_SHEET_COLUMNS]);
  assert.match(workbook.link_formulas[0][0], /^=HYPERLINK\("https:\/\/detail\.1688\.com\/offer\/987654321\.html","打开1688"\)$/u);
  assert.equal(workbook.values[1][15], "987654321");
  assert.equal(workbook.values[1][16], "VARIANT-BLACK-L");
  assert.equal(workbook.values[1][18], 12.8);
  assert.equal(workbook.values[1][19], 1);
  assert.equal(workbook.values[1][21], "可购买（1件）");
  assert.equal(workbook.values[1][24], "通过");
  assert.equal(workbook.summary_formulas[0][0], "=COUNTA('丽丽1号'!$C$5:$C$104)");
  assert.equal(workbook.summary_formulas[0][3], "=MAX(0,C5-D5)");
});
