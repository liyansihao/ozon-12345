import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { dailyWindowState, localDateKeyFor } from "./daily-window.mjs";

export const DEFAULT_REPORT_DIR = "/Users/mac/Desktop/Ozon每日核价";
export const REPORT_STATE_DIRNAME = "daily_pricing_reports";

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function skuText(value) {
  const raw = text(value);
  if (!raw) return "";
  if (/^\d+$/u.test(raw)) return raw;
  const result = Number(raw);
  return Number.isFinite(result) && result > 0 ? String(Math.trunc(result)) : "";
}

function readRuntimeStates(runtimeDbPath) {
  const rawPath = String(runtimeDbPath || "").trim();
  if (!rawPath) return new Map();
  const filename = path.resolve(rawPath);
  if (!fsSync.existsSync(filename)) return new Map();
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT sku, stage, terminal, reason, updated_at, data_json
      FROM sku_state
    `).all();
    const states = new Map();
    for (const row of rows) {
      let data = {};
      try { data = JSON.parse(row.data_json || "{}"); } catch {}
      states.set(String(row.sku), {
        sku: String(row.sku),
        stage: String(row.stage || ""),
        terminal: Number(row.terminal) === 1,
        reason: text(row.reason),
        updated_at: text(row.updated_at),
        data,
      });
    }
    return states;
  } finally {
    database.close();
  }
}

function storeMap(stores = []) {
  return new Map((stores || []).map((store) => [Number(store.id), {
    id: Number(store.id),
    name: text(store.name || store.needle),
    warehouse_id: numeric(store.warehouse_id),
    ural_warehouse_id: numeric(store.ural_warehouse_id),
  }]));
}

function acceptedKey(row) {
  return [Number(row.store_id), text(row.sku)].join(":");
}

function acceptedAt(row) {
  return row.accepted_at || row.api_call_accepted_at || row.at || row.timestamp || "";
}

function stateStoreId(state) {
  return numeric(state?.data?.store_id);
}

function rowStatus(state) {
  if (skuText(state?.data?.store_sku)) return "已生成本店SKU";
  if (state?.terminal === true) return "终态失败";
  return "等待本店SKU";
}

function terminalReason(state) {
  return text(state?.data?.reason || state?.reason || "terminal-failure");
}

function warehouseLabel(state, store) {
  const warehouseId = numeric(state?.data?.warehouse_id);
  if (warehouseId && numeric(store?.ural_warehouse_id) === warehouseId) return `ural (${warehouseId})`;
  if (warehouseId && numeric(store?.warehouse_id) === warehouseId) return `邮政 (${warehouseId})`;
  if (warehouseId) return `未知仓库 (${warehouseId})`;
  return "";
}

function normalizedRecord(accepted, state, store) {
  const data = state?.data || {};
  const acceptedTimestamp = acceptedAt(accepted);
  const ownSku = skuText(data.store_sku);
  const acceptedStoreId = numeric(accepted.store_id);
  const stateId = stateStoreId(state);
  const mismatch = state && stateId && acceptedStoreId && stateId !== acceptedStoreId;
  const status = mismatch ? "店铺ID不匹配" : rowStatus(state);
  return {
    store_id: acceptedStoreId,
    store_name: text(store?.name || data.store_name || accepted.store_name),
    own_ozon_sku: ownSku,
    own_offer_id: text(data.offer_id || accepted.offer_id),
    source_sku: text(accepted.sku),
    source_link: text(
      data.link
      || data.detail_url
      || data.source_url
      || data.source_link
      || accepted.source_url
      || accepted.source_link
      || accepted.url
      || `https://www.ozon.ru/product/${text(accepted.sku)}`,
    ),
    accepted_at: acceptedTimestamp,
    sku_generated_at: ownSku ? text(data.reconciled_at || data.published_at || state.updated_at) : "",
    weight_grams: numeric(data.package_weight_grams ?? data.package_weight ?? data.product_info?.weight),
    warehouse: warehouseLabel(state, store),
    sell_price: numeric(data.sell_price ?? data.sale_price),
    profit_rate: numeric(data.profit_rate),
    status,
    failure_reason: status === "终态失败" ? terminalReason(state) : mismatch ? `state-store-id=${stateId}` : "",
    state_stage: text(state?.stage),
    terminal: state?.terminal === true,
    has_own_sku: Boolean(ownSku),
    mismatch,
  };
}

export function reportStatePath(stateRoot, dateKey) {
  return path.join(path.resolve(stateRoot), REPORT_STATE_DIRNAME, `${dateKey}.json`);
}

export function reportOutputPath(reportDir, dateKey) {
  return path.join(path.resolve(reportDir || DEFAULT_REPORT_DIR), `Ozon人工核价_${dateKey}.xlsx`);
}

export function reportScopeReady(scope) {
  const blockingExceptions = Number(scope?.blocking_exception_count ?? scope?.mismatch_count ?? 0);
  return Number(scope?.pending_count || 0) === 0 && blockingExceptions === 0;
}

export function readDailyPricingScope({
  runDir,
  runtimeDbPath,
  stores = [],
  dateKey,
  timeZone = "Asia/Shanghai",
  cutoff = "20:00",
  reportAfter = "20:30",
  now = new Date(),
} = {}) {
  if (!runDir) throw new TypeError("runDir is required");
  const window = dailyWindowState({ now, timeZone, cutoff, reportAfter });
  const targetDate = String(dateKey || window.date);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(targetDate)) throw new TypeError("dateKey must use YYYY-MM-DD");
  const storeById = storeMap(stores);
  const stateBySku = readRuntimeStates(runtimeDbPath);
  const acceptedRows = readJsonLinesSync(path.join(path.resolve(runDir), "erp_accepted.jsonl"));
  const latest = new Map();
  for (const accepted of acceptedRows) {
    const sku = text(accepted.sku);
    const storeId = numeric(accepted.store_id);
    if (!sku || !(storeId > 0)) continue;
    if (localDateKeyFor(acceptedAt(accepted), timeZone) !== targetDate) continue;
    const key = acceptedKey({ ...accepted, store_id: storeId, sku });
    const prior = latest.get(key);
    if (!prior || String(acceptedAt(accepted)) > String(acceptedAt(prior))) latest.set(key, { ...accepted, store_id: storeId, sku });
  }
  const rows = [];
  const exceptions = [];
  for (const accepted of latest.values()) {
    const state = stateBySku.get(String(accepted.sku));
    const store = storeById.get(Number(accepted.store_id));
    if (!store) {
      exceptions.push({
        store_id: Number(accepted.store_id),
        store_name: text(accepted.store_name) || "未知店铺",
        source_sku: text(accepted.sku),
        own_offer_id: text(accepted.offer_id),
        status: "店铺配置缺失",
        failure_reason: "accepted-store-not-configured",
      });
      continue;
    }
    const row = normalizedRecord(accepted, state, store);
    if (row.mismatch) {
      exceptions.push(row);
    } else if (row.terminal && !row.has_own_sku) {
      exceptions.push(row);
    } else {
      rows.push(row);
    }
  }
  rows.sort((left, right) => String(left.accepted_at).localeCompare(String(right.accepted_at)) || left.source_sku.localeCompare(right.source_sku));
  exceptions.sort((left, right) => String(left.accepted_at || "").localeCompare(String(right.accepted_at || "")) || String(left.source_sku).localeCompare(String(right.source_sku)));
  const pending = rows.filter((row) => !row.has_own_sku);
  const mismatchCount = exceptions.filter((row) => row.status === "店铺ID不匹配").length;
  const blockingExceptionCount = exceptions.filter((row) => row.status !== "终态失败").length;
  const byStore = {};
  for (const store of stores) {
    const id = String(Number(store.id));
    const storeRows = rows.filter((row) => Number(row.store_id) === Number(store.id) && row.has_own_sku);
    const storeExceptions = exceptions.filter((row) => Number(row.store_id) === Number(store.id));
    byStore[id] = {
      store_id: Number(store.id),
      store_name: text(store.name),
      target: 100,
      accepted: storeRows.length + pending.filter((row) => Number(row.store_id) === Number(store.id)).length + storeExceptions.length,
      sku_generated: storeRows.length,
      terminal_failed: storeExceptions.filter((row) => row.status === "终态失败").length,
      pending: pending.filter((row) => Number(row.store_id) === Number(store.id)).length,
      shortfall: Math.max(0, 100 - (storeRows.length + pending.filter((row) => Number(row.store_id) === Number(store.id)).length + storeExceptions.length)),
    };
  }
  return {
    date: targetDate,
    time_zone: timeZone,
    cutoff,
    report_after: reportAfter,
    observed_at: new Date(now).toISOString(),
    rows,
    exceptions,
    pending_count: pending.length,
    mismatch_count: mismatchCount,
    blocking_exception_count: blockingExceptionCount,
    accepted_count: latest.size,
    sku_generated_count: rows.filter((row) => row.has_own_sku).length,
    terminal_failed_count: exceptions.filter((row) => row.status === "终态失败").length,
    by_store: byStore,
    ready: reportScopeReady({ pending_count: pending.length, blocking_exception_count: blockingExceptionCount }),
    window,
  };
}

function readJsonLinesSync(filename) {
  let source = "";
  try {
    source = fsSync.readFileSync(filename, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return source.split(/\r?\n/u).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" ? [value] : [];
    } catch {
      return [];
    }
  });
}

export async function readReportState(stateRoot, dateKey) {
  try {
    return JSON.parse(await fs.readFile(reportStatePath(stateRoot, dateKey), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeReportState(stateRoot, dateKey, value) {
  const filename = reportStatePath(stateRoot, dateKey);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filename);
  return filename;
}

export { readRuntimeStates };
