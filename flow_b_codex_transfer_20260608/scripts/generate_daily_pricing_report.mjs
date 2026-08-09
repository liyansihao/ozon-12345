#!/usr/bin/env node

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  readDailyPricingScope,
  reportOutputPath,
} from "./daily-pricing-report.mjs";

const SCRIPT_DIR = path.resolve(import.meta.dirname);

function loadArtifactTool({ runtimeRoot, nodeModules } = {}) {
  const root = path.resolve(runtimeRoot || path.join(SCRIPT_DIR, "../../.report-runtime"));
  const modules = path.resolve(nodeModules || "");
  if (!modules || !fsSync.existsSync(modules)) {
    throw new Error("bundled @oai/artifact-tool node_modules path is unavailable");
  }
  fsSync.mkdirSync(root, { recursive: true });
  const link = path.join(root, "node_modules");
  try {
    const existing = fsSync.readlinkSync(link);
    if (path.resolve(root, existing) !== modules) fsSync.unlinkSync(link);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!fsSync.existsSync(link)) fsSync.symlinkSync(modules, link, "dir");
  const requireFromRuntime = createRequire(path.join(root, "artifact-entry.cjs"));
  return requireFromRuntime("@oai/artifact-tool");
}

function asDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : "";
}

function safeSheetName(value) {
  return String(value || "店铺").replace(/[\\/*?:[\]]/gu, "_").slice(0, 31) || "店铺";
}

function tableName(value, index) {
  const normalized = String(value || "Store").replace(/[^a-zA-Z0-9_]/gu, "_");
  return `Pricing_${normalized}_${index}`.slice(0, 200);
}

function styleTitle(sheet, range, fill = "#0F766E") {
  range.merge();
  range.format = {
    fill,
    font: { bold: true, color: "#FFFFFF" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
  };
  range.format.rowHeight = 28;
}

function styleHeader(range) {
  range.format = {
    fill: "#DDEBF7",
    font: { bold: true, color: "#17365D" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "outside", style: "thin", color: "#9EADBA" },
  };
  range.format.rowHeight = 32;
}

function setStoreSheet(sheet, store, rows, reportDate) {
  const columns = [
    "店铺名称", "店铺ID", "本店Ozon SKU", "本店货号", "跟卖SKU", "跟卖商品链接",
    "ERP接受时间", "SKU生成时间", "重量(g)", "上架仓库", "上品时售价", "利润率", "状态", "失败原因",
  ];
  sheet.showGridLines = false;
  styleTitle(sheet, sheet.getRange("A1:N1"), "#2563EB");
  sheet.getRange("A1").values = [[`${store.name} · 人工核价清单 · ${reportDate}`]];
  sheet.getRange("A2:N2").merge();
  sheet.getRange("A2").values = [["本店 Ozon SKU 已生成；本店货号与跟卖 SKU 均按文本保留。"]];
  sheet.getRange("A2:N2").format = { font: { italic: true, color: "#475569" }, wrapText: true };
  sheet.getRange("A4:N4").values = [columns];
  styleHeader(sheet.getRange("A4:N4"));
  const values = rows.map((row) => [
    row.store_name,
    String(row.store_id),
    String(row.own_ozon_sku),
    row.own_offer_id,
    row.source_sku,
    row.source_link,
    asDate(row.accepted_at),
    asDate(row.sku_generated_at),
    row.weight_grams ?? "",
    row.warehouse,
    row.sell_price ?? "",
    row.profit_rate ?? "",
    row.status,
    row.failure_reason,
  ]);
  if (values.length > 0) sheet.getRangeByIndexes(4, 0, values.length, columns.length).values = values;
  const endRow = Math.max(4, 4 + values.length);
  const dataEndRow = Math.max(5, endRow);
  const table = sheet.tables.add(`A4:N${endRow}`, true, tableName(store.name, store.id));
  table.style = "TableStyleMedium2";
  table.showFilterButton = true;
  sheet.freezePanes.freezeRows(4);
  sheet.getRange(`C5:E${dataEndRow}`).format.numberFormat = "@";
  sheet.getRange(`G5:H${dataEndRow}`).format.numberFormat = "yyyy-mm-dd hh:mm";
  sheet.getRange(`I5:I${dataEndRow}`).format.numberFormat = "#,##0.0";
  sheet.getRange(`K5:K${dataEndRow}`).format.numberFormat = "0.00";
  sheet.getRange(`L5:L${dataEndRow}`).format.numberFormat = "0.0";
  sheet.getRange(`A4:N${dataEndRow}`).format.borders = {
    insideHorizontal: { style: "thin", color: "#E2E8F0" },
    outside: { style: "thin", color: "#94A3B8" },
  };
  const widths = [16, 12, 18, 24, 16, 38, 20, 20, 12, 22, 14, 10, 16, 28];
  widths.forEach((width, index) => { sheet.getRangeByIndexes(0, index, 1, 1).format.columnWidth = width; });
}

function setSummarySheet(sheet, scope, stores, reportDate) {
  const headers = ["店铺名称", "店铺ID", "目标数", "成功提交数", "已生成本店SKU", "终态失败数", "待生成SKU", "不足数量", "日报状态"];
  sheet.showGridLines = false;
  styleTitle(sheet, sheet.getRange("A1:I1"), "#0F766E");
  sheet.getRange("A1").values = [[`Ozon 每日人工核价汇总 · ${reportDate}`]];
  sheet.getRange("A2:I2").merge();
  sheet.getRange("A2").values = [["每天每店目标100个；20:00停止新增，已提交但未生成本店SKU的非终态商品会继续等待。"]];
  sheet.getRange("A2:I2").format = { font: { italic: true, color: "#475569" }, wrapText: true };
  sheet.getRange("A4:I4").values = [headers];
  styleHeader(sheet.getRange("A4:I4"));
  const rows = stores.map((store, index) => {
    const id = String(Number(store.id));
    const summary = scope.by_store[id] || { accepted: 0, terminal_failed: 0, pending: 0 };
    const sheetName = safeSheetName(store.name);
    const rowNumber = 5 + index;
    return [
      store.name,
      Number(store.id),
      100,
      Number(summary.accepted || 0),
      null,
      Number(summary.terminal_failed || 0),
      Number(summary.pending || 0),
      null,
      scope.ready ? "已生成" : "等待中",
      sheetName,
      rowNumber,
    ];
  });
  sheet.getRange("A5:I14").values = rows.map((row) => row.slice(0, 9));
  rows.forEach((row, index) => {
    const rowNumber = 5 + index;
    sheet.getRange(`E${rowNumber}`).formulas = [[`=COUNTA('${row[9]}'!$C$5:$C$104)`]];
    sheet.getRange(`H${rowNumber}`).formulas = [[`=MAX(0,C${rowNumber}-D${rowNumber})`]];
  });
  const table = sheet.tables.add("A4:I14", true, "DailyPricingSummary");
  table.style = "TableStyleMedium4";
  table.showFilterButton = true;
  sheet.freezePanes.freezeRows(4);
  sheet.getRange("B5:H14").format.numberFormat = "#,##0";
  sheet.getRange("A4:I14").format.borders = {
    insideHorizontal: { style: "thin", color: "#E2E8F0" },
    outside: { style: "thin", color: "#94A3B8" },
  };
  [18, 12, 12, 14, 16, 12, 12, 12, 14].forEach((width, index) => { sheet.getRangeByIndexes(0, index, 1, 1).format.columnWidth = width; });
}

function setExceptionSheet(sheet, exceptions, reportDate) {
  const headers = ["店铺名称", "店铺ID", "本店货号", "跟卖SKU", "状态", "失败原因", "状态阶段"];
  sheet.showGridLines = false;
  styleTitle(sheet, sheet.getRange("A1:G1"), "#B45309");
  sheet.getRange("A1").values = [[`异常汇总 · ${reportDate}`]];
  sheet.getRange("A2:G2").merge();
  sheet.getRange("A2").values = [["终态失败不阻塞日报；店铺ID不匹配属于数据异常，必须先修复后再归入核价清单。"]];
  sheet.getRange("A2:G2").format = { font: { italic: true, color: "#92400E" }, wrapText: true };
  sheet.getRange("A4:G4").values = [headers];
  styleHeader(sheet.getRange("A4:G4"));
  const values = exceptions.map((row) => [
    row.store_name,
    String(row.store_id),
    row.own_offer_id,
    row.source_sku,
    row.status,
    row.failure_reason,
    row.state_stage || "",
  ]);
  if (values.length > 0) sheet.getRangeByIndexes(4, 0, values.length, headers.length).values = values;
  const endRow = Math.max(4, 4 + values.length);
  const dataEndRow = Math.max(5, endRow);
  const table = sheet.tables.add(`A4:G${endRow}`, true, "DailyPricingExceptions");
  table.style = "TableStyleMedium3";
  table.showFilterButton = true;
  sheet.freezePanes.freezeRows(4);
  sheet.getRange(`B5:D${dataEndRow}`).format.numberFormat = "@";
  [18, 12, 24, 16, 18, 34, 18].forEach((width, index) => { sheet.getRangeByIndexes(0, index, 1, 1).format.columnWidth = width; });
}

async function verifyWorkbook(workbook, sheetNames, previewDir) {
  const errors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 300 },
    summary: "daily pricing formula error scan",
  });
  const errorLines = String(errors.ndjson || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      try {
        const value = JSON.parse(line);
        return value?.kind === "match" || value?.matches?.length > 0;
      } catch {
        return /#REF!|#DIV\/0!|#VALUE!|#NAME\?|#N\/A/u.test(line);
      }
    });
  if (errorLines.length > 0) throw new Error(`workbook formula error: ${errorLines.join("\n")}`);
  if (!previewDir) return;
  await fs.mkdir(previewDir, { recursive: true });
  for (const sheetName of sheetNames) {
    const blob = await workbook.render({ sheetName, autoCrop: "all", scale: 1, format: "png" });
    await fs.writeFile(path.join(previewDir, `${sheetName.replace(/[^\p{L}\p{N}_-]/gu, "_")}.png`), new Uint8Array(await blob.arrayBuffer()));
  }
}

export async function generateDailyPricingReport({
  runDir,
  runtimeDbPath,
  stores,
  dateKey,
  timeZone = "Asia/Shanghai",
  cutoff = "20:00",
  reportAfter = "20:30",
  outputDir,
  runtimeRoot,
  nodeModules,
  verify = false,
  now = new Date(),
} = {}) {
  const scope = readDailyPricingScope({ runDir, runtimeDbPath, stores, dateKey, timeZone, cutoff, reportAfter, now });
  if (!scope.ready) {
    throw new Error(`daily pricing report is not ready: pending=${scope.pending_count}, mismatches=${scope.mismatch_count}`);
  }
  const { Workbook, SpreadsheetFile } = loadArtifactTool({ runtimeRoot, nodeModules });
  const workbook = Workbook.create();
  const summary = workbook.worksheets.add("汇总");
  const sheetNames = ["汇总"];
  const storeSheets = [];
  for (const store of stores) {
    const sheetName = safeSheetName(store.name);
    const sheet = workbook.worksheets.add(sheetName);
    storeSheets.push({ store, sheet, sheetName });
    sheetNames.push(sheetName);
  }
  const exception = workbook.worksheets.add("异常汇总");
  sheetNames.push("异常汇总");
  setSummarySheet(summary, scope, stores, scope.date);
  for (const { store, sheet } of storeSheets) {
    const rows = scope.rows.filter((row) => Number(row.store_id) === Number(store.id) && row.has_own_sku);
    setStoreSheet(sheet, store, rows, scope.date);
  }
  setExceptionSheet(exception, scope.exceptions, scope.date);
  const output = reportOutputPath(outputDir, scope.date);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  const xlsx = await SpreadsheetFile.exportXlsx(workbook);
  await xlsx.save(temporary);
  await fs.rename(temporary, output);
  if (verify) await verifyWorkbook(workbook, sheetNames, path.join(path.dirname(output), ".previews", scope.date));
  return { output, date: scope.date, scope, sheets: sheetNames };
}

function parseArgs(argv) {
  const args = [...argv];
  const valueAfter = (flag, fallback = "") => {
    const index = args.indexOf(flag);
    return index >= 0 ? String(args[index + 1] || fallback) : fallback;
  };
  return {
    runDir: valueAfter("--run-dir", process.env.FLOW_B_REPORT_RUN_DIR),
    runtimeDbPath: valueAfter("--runtime-db", process.env.FLOW_B_RUNTIME_STATE_DB),
    storesFile: valueAfter("--stores-file", process.env.FLOW_B_REPORT_STORES_FILE),
    dateKey: valueAfter("--date", ""),
    outputDir: valueAfter("--output-dir", process.env.FLOW_B_DAILY_REPORT_DIR),
    runtimeRoot: valueAfter("--runtime-root", process.env.FLOW_B_REPORT_RUNTIME_ROOT),
    nodeModules: valueAfter("--node-modules", process.env.FLOW_B_REPORT_NODE_MODULES),
    timeZone: valueAfter("--time-zone", process.env.FLOW_B_DAILY_STORE_TIMEZONE || "Asia/Shanghai"),
    cutoff: valueAfter("--cutoff", process.env.FLOW_B_DAILY_SUBMISSION_CUTOFF || "20:00"),
    reportAfter: valueAfter("--report-after", process.env.FLOW_B_DAILY_REPORT_AFTER || "20:30"),
    verify: args.includes("--verify"),
  };
}

async function invokedAsMain(argv1 = process.argv[1]) {
  if (!argv1) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try { return await fs.realpath(path.resolve(argv1)) === await fs.realpath(modulePath); } catch { return path.resolve(argv1) === path.resolve(modulePath); }
}

if (await invokedAsMain()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options.storesFile) throw new Error("--stores-file is required");
    const stores = JSON.parse(await fs.readFile(path.resolve(options.storesFile), "utf8"));
    const result = await generateDailyPricingReport({ ...options, stores });
    console.log(JSON.stringify({ ok: true, output: result.output, date: result.date, sheets: result.sheets }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error), stack: error?.stack }, null, 2));
    process.exitCode = 1;
  }
}
