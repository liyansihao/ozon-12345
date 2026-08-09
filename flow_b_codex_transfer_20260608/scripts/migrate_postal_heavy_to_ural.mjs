#!/usr/bin/env node

/**
 * Move products that are above the configured weight threshold and still have
 * free stock in the postal FBS warehouse into the matching Ural warehouse.
 *
 * The ERP keeps per-warehouse stock behind its authenticated browser page.
 * This command talks to that page through the local CDP endpoint, so no token
 * is ever returned to Node or written to disk. It is a dry run unless --apply
 * is supplied.
 */

import fs from "node:fs/promises";
import process from "node:process";

const DEFAULT_CONFIG = "/Users/mac/.ozon-24h-production/releases/stable/config/ozon_24h_production.json";
const DEFAULT_CDP = "http://127.0.0.1:9223";
const DEFAULT_THRESHOLD_GRAMS = 500;
const PAGE_SIZE = 100;
const STOCK_BATCH_SIZE = 20;
const UPDATE_BATCH_SIZE = 20;

function parseArgs(argv) {
  const args = { apply: false, threshold: DEFAULT_THRESHOLD_GRAMS, shopId: null, config: DEFAULT_CONFIG };
  for (let index = 2; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (value === "--apply") args.apply = true;
    else if (value === "--threshold") args.threshold = Number(argv[++index]);
    else if (value === "--shop-id") args.shopId = Number(argv[++index]);
    else if (value === "--config") args.config = String(argv[++index] || "");
    else if (value === "--help" || value === "-h") {
      console.log("Usage: migrate_postal_heavy_to_ural.mjs [--apply] [--shop-id ID] [--threshold GRAMS] [--config FILE]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  if (!Number.isFinite(args.threshold) || args.threshold < 0) throw new Error("threshold must be a non-negative number");
  if (args.shopId !== null && (!Number.isSafeInteger(args.shopId) || args.shopId <= 0)) throw new Error("shop-id must be a positive integer");
  return args;
}

function integer(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function grams(value) {
  const text = String(value ?? "").trim().replace(",", ".").toLowerCase();
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(kg|кг|g|г)?/i);
  if (!match) return 0;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return 0;
  return /kg|кг/i.test(match[2] || "") ? number * 1000 : number;
}

function uniqueById(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const id = String(row?.id ?? "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

async function cdpJson(endpoint, path) {
  const response = await fetch(`${endpoint}${path}`);
  if (!response.ok) throw new Error(`CDP discovery failed: HTTP ${response.status}`);
  return response.json();
}

function connectPage(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();
  const onMessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message || "CDP request failed"));
    else request.resolve(message);
  };
  socket.addEventListener("message", onMessage);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP page connection timed out")), 15_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", (error) => { clearTimeout(timer); reject(error); }, { once: true });
  });
  const send = async (method, params = {}, timeoutMs = 60_000) => {
    await ready;
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  const close = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("CDP connection closed"));
    }
    pending.clear();
    socket.close();
  };
  return { send, close };
}

async function main() {
  const args = parseArgs(process.argv);
  const config = await readJson(args.config);
  const cdpEndpoint = process.env.OZON_CDP_ENDPOINT || DEFAULT_CDP;
  const configuredStores = Array.isArray(config.stores) ? config.stores : [];
  const stores = configuredStores
    .filter((store) => args.shopId === null || Number(store.id) === args.shopId)
    .map((store) => ({
      id: Number(store.id),
      name: String(store.name || store.id),
      postalWarehouseId: Number(store.warehouse_id),
      uralWarehouseId: Number(store.ural_warehouse_id),
    }));
  if (stores.length === 0) throw new Error("no configured stores matched the requested shop");
  if (stores.some((store) => !Number.isSafeInteger(store.id)
    || !Number.isSafeInteger(store.postalWarehouseId)
    || !Number.isSafeInteger(store.uralWarehouseId))) {
    throw new Error("store configuration contains an invalid warehouse mapping");
  }

  const pages = await cdpJson(cdpEndpoint, "/json/list");
  const page = pages.find((candidate) => String(candidate?.url || "").startsWith("https://ozon.maozierp.com/"));
  if (!page?.webSocketDebuggerUrl) throw new Error("authenticated Maozi ERP page is not available on the production browser");
  const cdp = connectPage(page.webSocketDebuggerUrl);
  const evaluate = async (expression, timeoutMs = 120_000) => {
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (result?.result?.exceptionDetails) {
      throw new Error(result.result.exceptionDetails.text || "ERP page evaluation failed");
    }
    return result?.result?.result?.value;
  };

  const listPage = async (shopId, pageNumber) => evaluate(`(async()=>{
    let token = "";
    try { token = JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || ""; } catch {}
    const url = new URL("https://api.maozierp.com/api.product.online/lists");
    for (const [key, value] of Object.entries({page:${pageNumber}, page_size:${PAGE_SIZE}, shop_id:${shopId}})) url.searchParams.set(key, value);
    const response = await fetch(url, { credentials: "include", headers: { Accept: "application/json", "Accept-Language": "zh-CN", Client: "pc", ...(token ? { Authorization: "Bearer " + token } : {}) } });
    return { status: response.status, json: await response.json() };
  })()`);

  const getStockBatch = async (ids) => evaluate(`(async()=>{
    let token = "";
    try { token = JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || ""; } catch {}
    const headers = { Accept: "application/json", "Accept-Language": "zh-CN", Client: "pc", ...(token ? { Authorization: "Bearer " + token } : {}) };
    const ids = ${JSON.stringify(ids)};
    return Promise.all(ids.map(async (id) => {
      const url = new URL("https://api.maozierp.com/api.product.online/get_stock");
      url.searchParams.set("id", id);
      try {
        const response = await fetch(url, { credentials: "include", headers });
        return { id, status: response.status, json: await response.json() };
      } catch (error) {
        return { id, status: 0, error: String(error?.message || error) };
      }
    }));
  })()`);

  const updateBatch = async (shopId, products) => evaluate(`(async()=>{
    let token = "";
    try { token = JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || ""; } catch {}
    const response = await fetch("https://api.maozierp.com/api.product.online/batch_update_stock", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json", "Accept-Language": "zh-CN", Client: "pc", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify(${JSON.stringify({ shop_id: shopId, products })}),
    });
    return { status: response.status, json: await response.json() };
  })()`);

  const summary = {
    mode: args.apply ? "apply" : "dry-run",
    threshold_grams: args.threshold,
    browser_page: String(page.url || ""),
    stores: [],
    candidates: [],
    skipped: [],
    updates: [],
  };

  try {
    for (const store of stores) {
      let total = 0;
      let fetched = 0;
      const rows = [];
      for (let pageNumber = 1; pageNumber <= 100 && fetched < total || pageNumber === 1; pageNumber += 1) {
        let result;
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            result = await listPage(store.id, pageNumber);
            break;
          } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
          }
        }
        if (!result) throw new Error(`online product page ${pageNumber} failed for ${store.name}: ${lastError?.message || "unknown error"}`);
        if (Number(result.status) !== 200 || Number(result.json?.code) !== 1) {
          throw new Error(`online product page ${pageNumber} failed for ${store.name}: ${result.json?.msg || result.status}`);
        }
        const batch = Array.isArray(result.json?.data?.data) ? result.json.data.data : [];
        total = Number(result.json?.data?.total || total || 0);
        rows.push(...batch);
        fetched += batch.length;
        if (batch.length === 0 || fetched >= total) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      const heavy = rows.filter((row) => Number(row?.id) > 0
        && Number(row?.sku) > 0
        && Number(row?.stock) > 0
        && grams(row?.weight) > args.threshold);
      const stockRows = [];
      for (let offset = 0; offset < heavy.length; offset += STOCK_BATCH_SIZE) {
        const ids = heavy.slice(offset, offset + STOCK_BATCH_SIZE).map((row) => Number(row.id));
        const result = await getStockBatch(ids);
        stockRows.push(...result);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const stockById = new Map(stockRows.map((row) => [Number(row.id), row]));
      let postalFreeProducts = 0;
      let movedFreeUnits = 0;
      let reservedOnly = 0;
      let missingStock = 0;
      for (const row of heavy) {
        const stockResult = stockById.get(Number(row.id));
        const warehouses = Array.isArray(stockResult?.json?.data) ? stockResult.json.data : [];
        const postal = warehouses.find((warehouse) => Number(warehouse?.warehouse_id) === store.postalWarehouseId);
        const ural = warehouses.find((warehouse) => Number(warehouse?.warehouse_id) === store.uralWarehouseId);
        if (!postal) {
          missingStock += 1;
          summary.skipped.push({ store_id: store.id, store_name: store.name, id: row.id, offer_id: row.offer_id, sku: row.sku, weight: row.weight, reason: "postal_stock_not_found" });
          continue;
        }
        const present = integer(postal.present);
        const reserved = integer(postal.reserved);
        const free = Math.min(integer(postal.free_stock), Math.max(0, present - reserved));
        if (free <= 0) {
          reservedOnly += 1;
          summary.skipped.push({ store_id: store.id, store_name: store.name, id: row.id, offer_id: row.offer_id, sku: row.sku, weight: row.weight, reason: "postal_stock_reserved_or_zero", postal_present: present, postal_reserved: reserved });
          continue;
        }
        const uralPresent = integer(ural?.present);
        const target = {
          id: Number(row.id),
          offer_id: String(row.offer_id || ""),
          warehouses: [
            { warehouse_id: store.postalWarehouseId, stock: Math.max(reserved, present - free) },
            { warehouse_id: store.uralWarehouseId, stock: uralPresent + free },
          ],
        };
        if (!target.offer_id) {
          summary.skipped.push({ store_id: store.id, store_name: store.name, id: row.id, sku: row.sku, weight: row.weight, reason: "missing_offer_id" });
          continue;
        }
        postalFreeProducts += 1;
        movedFreeUnits += free;
        summary.candidates.push({
          store_id: store.id,
          store_name: store.name,
          id: Number(row.id),
          product_id: row.product_id,
          sku: row.sku,
          offer_id: row.offer_id,
          name: row.name,
          weight: row.weight,
          online_status: row.online_status,
          postal_present: present,
          postal_reserved: reserved,
          postal_free: free,
          ural_present: uralPresent,
          target,
        });
      }
      summary.stores.push({
        store_id: store.id,
        store_name: store.name,
        online_total: total,
        fetched,
        heavy_stock_products: heavy.length,
        postal_free_products: postalFreeProducts,
        moved_free_units: movedFreeUnits,
        reserved_only_or_zero: reservedOnly,
        postal_stock_not_found: missingStock,
      });
    }

    if (args.apply) {
      for (const store of stores) {
        const candidates = summary.candidates.filter((candidate) => candidate.store_id === store.id);
        for (let offset = 0; offset < candidates.length; offset += UPDATE_BATCH_SIZE) {
          const products = candidates.slice(offset, offset + UPDATE_BATCH_SIZE).map((candidate) => candidate.target);
          const result = await updateBatch(store.id, products);
          const ok = Number(result?.status) >= 200 && Number(result?.status) < 300 && Number(result?.json?.code) === 1;
          summary.updates.push({ store_id: store.id, store_name: store.name, count: products.length, ok, status: result?.status ?? 0, response: result?.json ?? null });
          if (!ok) throw new Error(`stock update failed for ${store.name}: ${result?.json?.msg || result?.status}`);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
    console.log(JSON.stringify(summary));
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
