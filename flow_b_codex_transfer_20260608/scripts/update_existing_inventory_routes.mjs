#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  ensureMaoziLogin,
  launchFlowContext,
  openMaoziPage,
  resolveBrowserOptions,
} from "./flow_b_playwright/browser-context.mjs";
import { createMaoziPageTransport } from "./flow_b_playwright/maozi-client.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_CONFIG = path.join(ROOT, "config/ozon_24h_production.json");
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 500;
const DEFAULT_READ_CONCURRENCY = 4;
const DEFAULT_WRITE_CONCURRENCY = 2;
const TARGET_THRESHOLD_GRAMS = 400;

function cliValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback).trim() : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function expandPath(value, replacements = {}) {
  let output = String(value || "").trim();
  for (const [key, replacement] of Object.entries(replacements)) {
    output = output.replaceAll(`\${${key}}`, String(replacement));
  }
  return output.replace(/^~(?=\/|$)/u, os.homedir());
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function positiveInteger(value, label) {
  const number = integer(value);
  if (!(number > 0)) throw new Error(`${label} must be a positive integer`);
  return number;
}

function parseWeightGrams(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  const text = String(value ?? "").trim().replaceAll(",", ".");
  if (!text) return null;
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(kg|千克|公斤|g|克)?/iu);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return /kg|千克|公斤/iu.test(match[2] || "") ? amount * 1000 : amount;
}

function productWeightGrams(row) {
  for (const candidate of [
    row?.weight,
    row?.weight_grams,
    row?.package_weight_grams,
    row?.package_weight,
  ]) {
    const parsed = parseWeightGrams(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function responseData(response, label) {
  if (!(Number(response?.status) >= 200 && Number(response?.status) < 300)) {
    throw new Error(`${label} HTTP ${response?.status ?? "unknown"}`);
  }
  if (Number(response?.json?.code) !== 1) {
    throw new Error(`${label}: ${response?.json?.msg || response?.json?.message || "ERP returned code != 1"}`);
  }
  return response.json.data;
}

function listRows(data, label) {
  const rows = Array.isArray(data) ? data : data?.data ?? data?.list ?? data?.rows ?? data?.items;
  if (!Array.isArray(rows)) throw new Error(`${label} did not return a list`);
  return rows;
}

function normalizeStockRows(data, product) {
  const rows = listRows(data, `stock ${product.id}`);
  return rows.map((row) => {
    const warehouseId = integer(row?.warehouse_id ?? row?.warehouseId);
    const present = integer(row?.present);
    const reserved = integer(row?.reserved);
    const freeStock = integer(row?.free_stock ?? row?.freeStock);
    if (!(warehouseId > 0)) throw new Error(`stock ${product.id} contains an invalid warehouse ID`);
    if (present < 0 || reserved < 0 || freeStock < 0) {
      throw new Error(`stock ${product.id} contains a negative inventory value`);
    }
    if (present < reserved || present - reserved !== freeStock) {
      throw new Error(`stock ${product.id} has inconsistent present/reserved/free_stock values`);
    }
    return {
      warehouse_id: warehouseId,
      warehouse_name: String(row?.warehouse_name || "").trim() || null,
      present,
      reserved,
      free_stock: freeStock,
    };
  });
}

function stockFingerprint(rows) {
  return JSON.stringify([...rows]
    .map((row) => ({
      warehouse_id: Number(row.warehouse_id),
      present: Number(row.present),
      reserved: Number(row.reserved),
      free_stock: Number(row.free_stock),
    }))
    .sort((left, right) => left.warehouse_id - right.warehouse_id));
}

function routeForWeight(weightGrams) {
  return weightGrams <= TARGET_THRESHOLD_GRAMS ? "postal" : "ural";
}

function buildPlan(product, stockRows, store) {
  const weightGrams = productWeightGrams(product);
  if (weightGrams === null) {
    return {
      status: "skipped",
      reason: "unknown-weight",
      product,
      stock_rows: stockRows,
      weight_grams: null,
    };
  }
  const route = routeForWeight(weightGrams);
  const postalWarehouseId = Number(store.warehouse_id);
  const uralWarehouseId = Number(store.ural_warehouse_id);
  const targetWarehouseId = route === "postal" ? postalWarehouseId : uralWarehouseId;
  const knownWarehouseIds = new Set([postalWarehouseId, uralWarehouseId]);
  const totalFreeStock = stockRows.reduce((sum, row) => sum + row.free_stock, 0);
  const oldWarehouseFreeStock = stockRows
    .filter((row) => row.warehouse_id !== targetWarehouseId)
    .reduce((sum, row) => sum + row.free_stock, 0);
  const oldWarehouseReservedStock = stockRows
    .filter((row) => row.warehouse_id !== targetWarehouseId)
    .reduce((sum, row) => sum + row.reserved, 0);
  const currentByWarehouse = new Map(stockRows.map((row) => [row.warehouse_id, row]));
  const desiredByWarehouse = new Map();
  for (const row of stockRows) {
    desiredByWarehouse.set(row.warehouse_id, row.warehouse_id === targetWarehouseId ? totalFreeStock : 0);
  }
  for (const warehouseId of knownWarehouseIds) {
    if (!desiredByWarehouse.has(warehouseId)) {
      desiredByWarehouse.set(warehouseId, warehouseId === targetWarehouseId ? totalFreeStock : 0);
    }
  }
  const desiredStocks = [...desiredByWarehouse.entries()]
    .sort(([left], [right]) => left - right)
    .map(([warehouse_id, stock]) => ({ warehouse_id, stock }));
  const currentStocks = [...desiredByWarehouse.keys()]
    .sort((left, right) => left - right)
    .map((warehouse_id) => ({ warehouse_id, stock: currentByWarehouse.get(warehouse_id)?.free_stock || 0 }));
  const changed = JSON.stringify(currentStocks) !== JSON.stringify(desiredStocks);
  return {
    status: changed ? "planned" : "unchanged",
    reason: changed ? "weight-route-normalization" : "already-normalized",
    product,
    store_id: Number(store.id),
    store_name: String(store.name || store.needle || store.id),
    weight_grams: weightGrams,
    route,
    postal_warehouse_id: postalWarehouseId,
    ural_warehouse_id: uralWarehouseId,
    target_warehouse_id: targetWarehouseId,
    stock_rows: stockRows,
    current_stocks: currentStocks,
    desired_stocks: desiredStocks,
    total_free_stock: totalFreeStock,
    old_warehouse_free_stock: oldWarehouseFreeStock,
    old_warehouse_reserved_stock: oldWarehouseReservedStock,
    known_warehouse_ids: [...knownWarehouseIds].sort((left, right) => left - right),
    before_fingerprint: stockFingerprint(stockRows),
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function listOnlineProducts(transport, { pageSize = DEFAULT_PAGE_SIZE, maxPages = DEFAULT_MAX_PAGES } = {}) {
  const rows = [];
  let advertisedLastPage = null;
  let previousPageFingerprint = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await transport("/api.product.online/lists", {
      method: "GET",
      transportMode: "context",
      query: { page, page_size: pageSize },
    });
    const data = responseData(response, `online products page ${page}`);
    const batch = listRows(data, `online products page ${page}`);
    const pageFingerprint = JSON.stringify(batch.map((row) => String(row?.id ?? row?.sku ?? "")));
    if (page > 1 && pageFingerprint === previousPageFingerprint) {
      throw new Error(`online product pagination repeated page ${page}`);
    }
    previousPageFingerprint = pageFingerprint;
    rows.push(...batch);
    const candidateLastPage = Number(data?.last_page ?? data?.last ?? data?.pages ?? data?.pagination?.last_page);
    if (Number.isInteger(candidateLastPage) && candidateLastPage > 0) advertisedLastPage = candidateLastPage;
    if (advertisedLastPage !== null && page >= advertisedLastPage) break;
    if (batch.length < pageSize) break;
  }
  if (rows.length === 0) return [];
  const byId = new Map();
  for (const row of rows) {
    const id = integer(row?.id);
    if (id > 0) byId.set(id, row);
  }
  return [...byId.values()];
}

async function readStock(transport, product) {
  const response = await transport("/api.product.online/get_stock", {
    method: "GET",
    transportMode: "context",
    query: { id: Number(product.id) },
  });
  return normalizeStockRows(responseData(response, `stock ${product.id}`), product);
}

async function updateStock(transport, product, desiredStocks) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await transport("/api.product.online/update_stock", {
        method: "POST",
        transportMode: "context",
        body: { id: Number(product.id), stocks: desiredStocks },
        timeoutMs: 30_000,
      });
      const data = responseData(response, `update stock ${product.id}`);
      const errors = Array.isArray(data)
        ? data.flatMap((row) => Array.isArray(row?.errors) ? row.errors : [])
        : [];
      if (errors.length > 0) throw new Error(`warehouse update errors: ${JSON.stringify(errors)}`);
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        const rateLimited = /TOO_MANY_REQUESTS|updated too frequently/iu.test(String(error?.message || error));
        await new Promise((resolve) => setTimeout(resolve, rateLimited ? 20_000 * attempt : 500 * attempt));
      }
    }
  }
  throw lastError;
}

function verifyPlan(plan, afterRows) {
  const byWarehouse = new Map(afterRows.map((row) => [row.warehouse_id, row]));
  const targetFreeStock = byWarehouse.get(plan.target_warehouse_id)?.free_stock || 0;
  const totalFreeAfter = afterRows.reduce((sum, row) => sum + row.free_stock, 0);
  const nonTargetFreeStock = afterRows
    .filter((row) => row.warehouse_id !== plan.target_warehouse_id)
    .reduce((sum, row) => sum + row.free_stock, 0);
  return {
    ok: targetFreeStock === plan.total_free_stock
      && totalFreeAfter === plan.total_free_stock
      && nonTargetFreeStock === 0,
    target_free_stock: targetFreeStock,
    total_free_after: totalFreeAfter,
    non_target_free_stock: nonTargetFreeStock,
    after_rows: afterRows,
  };
}

async function loadConfig(filename) {
  const config = JSON.parse(await fs.readFile(filename, "utf8"));
  if (!Array.isArray(config?.stores) || config.stores.length === 0) throw new Error("config.stores is empty");
  const stores = new Map();
  for (const row of config.stores) {
    const id = integer(row?.id);
    const postal = integer(row?.warehouse_id);
    const ural = integer(row?.ural_warehouse_id);
    if (!(id > 0 && postal > 0 && ural > 0)) throw new Error(`invalid warehouse mapping for store ${id}`);
    stores.set(id, {
      id,
      name: row?.name,
      needle: row?.name,
      warehouse_id: postal,
      ural_warehouse_id: ural,
    });
  }
  return { config, stores };
}

function productionBrowserEnv(config) {
  const home = os.homedir();
  const stateRoot = expandPath(config.state_root, { HOME: home });
  const browser = config.browser || {};
  return {
    FLOW_B_PW_PROFILE: expandPath(browser.profile_dir, { HOME: home, STATE_ROOT: stateRoot }),
    FLOW_B_EXTENSION_DIR: expandPath(browser.extension_dir, { HOME: home, STATE_ROOT: stateRoot }),
    FLOW_B_CDP_ENDPOINT: String(browser.cdp_endpoint || "http://127.0.0.1:9223"),
    FLOW_B_CHROMIUM_EXECUTABLE: expandPath(browser.executable, { HOME: home, STATE_ROOT: stateRoot }),
  };
}

function summarize(plans, results, meta) {
  const summary = {
    ...meta,
    products_listed: meta.products_listed,
    products_considered: plans.length,
    products_with_unknown_weight: plans.filter((plan) => plan.reason === "unknown-weight").length,
    products_already_normalized: plans.filter((plan) => plan.status === "unchanged").length,
    products_planned: plans.filter((plan) => plan.status === "planned").length,
    postal_route_products: plans.filter((plan) => plan.route === "postal").length,
    ural_route_products: plans.filter((plan) => plan.route === "ural").length,
    free_units_to_move: plans.reduce((sum, plan) => sum + (plan.old_warehouse_free_stock || 0), 0),
    reserved_units_left_in_old_warehouse: plans.reduce((sum, plan) => sum + (plan.old_warehouse_reserved_stock || 0), 0),
    results: {
      unchanged: results.filter((row) => row.status === "unchanged").length,
      updated: results.filter((row) => row.status === "updated").length,
      skipped_changed_since_snapshot: results.filter((row) => row.status === "skipped-changed-since-snapshot").length,
      failed: results.filter((row) => row.status === "failed").length,
      verified: results.filter((row) => row.verification?.ok === true).length,
      verification_failed: results.filter((row) => row.status === "updated" && row.verification?.ok !== true).length,
    },
  };
  return summary;
}

async function main() {
  const configPath = path.resolve(cliValue("--config", DEFAULT_CONFIG));
  const apply = hasFlag("--apply");
  const idFilter = cliValue("--id", "") ? positiveInteger(cliValue("--id"), "--id") : null;
  const limit = cliValue("--limit", "") ? positiveInteger(cliValue("--limit"), "--limit") : null;
  const readConcurrency = positiveInteger(cliValue("--read-concurrency", String(DEFAULT_READ_CONCURRENCY)), "--read-concurrency");
  const writeConcurrency = positiveInteger(cliValue("--write-concurrency", String(DEFAULT_WRITE_CONCURRENCY)), "--write-concurrency");
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const outputPath = path.resolve(cliValue(
    "--output",
    path.join(ROOT, "..", "outputs", `inventory_route_migration_${timestamp}.json`),
  ));
  const { config, stores } = await loadConfig(configPath);
  const browserEnv = productionBrowserEnv(config);
  const context = await launchFlowContext(resolveBrowserOptions(browserEnv));
  const page = await openMaoziPage(context, { forceNew: true, settleMs: 500 });
  try {
    const accessToken = await ensureMaoziLogin(page);
    const transport = createMaoziPageTransport({
      page,
      context,
      initialAccessToken: accessToken,
      maxGetAttempts: 2,
      requestTimeoutMs: 30_000,
      getTotalBudgetMs: 60_000,
    });
    const listedRows = await listOnlineProducts(transport);
    const candidates = listedRows
      .filter((row) => String(row?.online_status || "selling").toLowerCase() === "selling")
      .filter((row) => stores.has(integer(row?.shop_id ?? row?.store_id)))
      .filter((row) => integer(row?.id) > 0)
      .filter((row) => integer(row?.stock) > 0)
      .map((row) => ({
        id: integer(row.id),
        offer_id: String(row?.offer_id || ""),
        sku: String(row?.sku || ""),
        shop_id: integer(row?.shop_id ?? row?.store_id),
        title: String(row?.title || row?.name || "").trim() || null,
        weight: row?.weight ?? null,
        package_weight: row?.package_weight ?? null,
        package_weight_grams: row?.package_weight_grams ?? null,
        online_status: String(row?.online_status || ""),
        stock: integer(row?.stock),
      }));
    const filteredCandidates = idFilter === null
      ? candidates
      : candidates.filter((row) => row.id === idFilter);
    const selected = limit === null ? filteredCandidates : filteredCandidates.slice(0, limit);
    const snapshotRows = await mapLimit(selected, readConcurrency, async (product) => {
      const store = stores.get(product.shop_id);
      const stockRows = await readStock(transport, product);
      return buildPlan(product, stockRows, store);
    });
    const plans = snapshotRows.filter((plan) => plan.status !== "skipped");
    const snapshot = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      mode: apply ? "apply" : "dry-run",
      threshold_grams: TARGET_THRESHOLD_GRAMS,
      boundary: "weight <= 400g -> postal; weight > 400g -> ural",
      config_path: configPath,
      products_listed: listedRows.length,
      candidates: selected.length,
      plans: snapshotRows,
    };
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    if (!apply) {
      const summary = summarize(plans, [], { mode: "dry-run", output_path: outputPath, products_listed: listedRows.length });
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    const writablePlans = plans.filter((plan) => plan.status === "planned");
    const results = await mapLimit(writablePlans, writeConcurrency, async (plan) => {
      try {
        const freshRows = await readStock(transport, plan.product);
        if (stockFingerprint(freshRows) !== plan.before_fingerprint) {
          return {
            status: "skipped-changed-since-snapshot",
            id: plan.product.id,
            sku: plan.product.sku,
            before_fingerprint: plan.before_fingerprint,
            current_fingerprint: stockFingerprint(freshRows),
          };
        }
        await updateStock(transport, plan.product, plan.desired_stocks);
        const afterRows = await readStock(transport, plan.product);
        const verification = verifyPlan(plan, afterRows);
        return {
          status: verification.ok ? "updated" : "failed",
          id: plan.product.id,
          sku: plan.product.sku,
          offer_id: plan.product.offer_id,
          shop_id: plan.product.shop_id,
          weight_grams: plan.weight_grams,
          route: plan.route,
          moved_free_stock: plan.old_warehouse_free_stock,
          reserved_old_stock: plan.old_warehouse_reserved_stock,
          verification,
        };
      } catch (error) {
        return {
          status: "failed",
          id: plan.product.id,
          sku: plan.product.sku,
          offer_id: plan.product.offer_id,
          shop_id: plan.product.shop_id,
          weight_grams: plan.weight_grams,
          route: plan.route,
          error: String(error?.message || error),
        };
      }
    });
    const summary = summarize(plans, results, {
      mode: "apply",
      output_path: outputPath,
      products_listed: listedRows.length,
    });
    const finalReport = { ...snapshot, completed_at: new Date().toISOString(), summary, results };
    await fs.writeFile(outputPath, `${JSON.stringify(finalReport, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(summary, null, 2));
    if (summary.results.failed > 0 || summary.results.verification_failed > 0) process.exitCode = 2;
  } finally {
    await page.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
  process.exitCode = 1;
});
