#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STORES = [
  { id: 104965, name: "丽丽1号" },
  { id: 106637, name: "丽丽二号" },
  { id: 106640, name: "丽丽三号" },
  { id: 106644, name: "丽丽四号" },
  { id: 106646, name: "丽丽五号" },
];
const EXCLUDED_SKUS = new Set(["2815247918"]);
const HEADERS = [
  "store_id", "store_name", "sku", "product_link", "title", "profit_rate",
  "sell_price", "purchase_price", "offer_id", "selected_at", "source_run",
];

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function selectedRow(event, runDir) {
  const data = event?.data || event || {};
  const sku = String(event?.sku ?? data.sku ?? "").trim();
  const store = STORES.find((entry) => entry.id === Number(data.store_id));
  if (!store || !sku || EXCLUDED_SKUS.has(sku) || !(Number(data.profit_rate) > 30)) return null;
  return {
    store_id: store.id,
    store_name: data.store_name || store.name,
    sku,
    product_link: `https://www.ozon.ru/product/${sku}`,
    title: data.title || "",
    profit_rate: data.profit_rate,
    sell_price: data.sell_price ?? data.sale_price ?? "",
    purchase_price: data.purchase_price ?? "",
    offer_id: data.offer_id || "",
    selected_at: data.selected_at || event.timestamp || "",
    source_run: path.basename(runDir),
  };
}

export async function exportSelectedStoreSkus({ runDirs, outputDir }) {
  const resolvedOutputDir = path.resolve(outputDir);
  if (runDirs.some((runDir) => path.resolve(runDir) === resolvedOutputDir)) {
    throw new Error("output directory must not be a source run directory");
  }
  const byAssignment = new Map();
  for (const runDir of runDirs) {
    let text = "";
    try { text = await fs.readFile(path.join(runDir, "selected.jsonl"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const line of text.split(/\r?\n/u)) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const row = selectedRow(event, runDir);
      if (!row) continue;
      const key = `${row.store_id}:${row.sku}`;
      const existing = byAssignment.get(key);
      if (!existing || String(row.selected_at) > String(existing.selected_at)) byAssignment.set(key, row);
    }
  }

  await fs.mkdir(outputDir, { recursive: true });
  const summary = { generated_at: new Date().toISOString(), criteria: "selected assignment with profit_rate > 30; not a confirmed-selling count", stores: {} };
  const aggregate = [];
  for (const store of STORES) {
    const rows = [...byAssignment.values()].filter((row) => row.store_id === store.id)
      .sort((left, right) => String(left.selected_at).localeCompare(String(right.selected_at)) || left.sku.localeCompare(right.sku));
    aggregate.push(...rows);
    const filename = `selected_store_${store.id}.csv`;
    summary.stores[String(store.id)] = { name: store.name, selected: rows.length, file: filename };
    const body = [HEADERS.join(","), ...rows.map((row) => HEADERS.map((header) => csvCell(row[header])).join(","))].join("\n");
    await fs.writeFile(path.join(outputDir, filename), `${body}\n`, "utf8");
  }
  const aggregateBody = [HEADERS.join(","), ...aggregate.map((row) => HEADERS.map((header) => csvCell(row[header])).join(","))].join("\n");
  await fs.writeFile(path.join(outputDir, "selected_all_stores.csv"), `${aggregateBody}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputDir = path.resolve(process.argv[2]);
  const runDirs = process.argv.slice(3).map((value) => path.resolve(value));
  if (!outputDir || runDirs.length === 0) throw new Error("usage: export_selected_store_skus.mjs OUTPUT_DIR RUN_DIR...");
  console.log(JSON.stringify(await exportSelectedStoreSkus({ runDirs, outputDir }), null, 2));
}
