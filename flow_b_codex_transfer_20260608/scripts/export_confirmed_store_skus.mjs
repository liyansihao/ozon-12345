#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  "sell_price", "purchase_price", "offer_id", "online_status", "stock", "published_at", "source_file",
];

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function publishedFiles(root) {
  const result = [];
  async function visit(directory) {
    let entries = [];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() && entry.name === "published.jsonl") result.push(filename);
    }
  }
  await visit(root);
  return result.sort();
}

function confirmedRow(event, sourceFile) {
  const data = event?.data || {};
  const sku = String(event?.sku ?? data.sku ?? "").trim();
  const storeId = Number(data.store_id);
  if (event?.status !== "published"
    || !sku
    || EXCLUDED_SKUS.has(sku)
    || !STORES.some((store) => store.id === storeId)
    || !(Number(data.profit_rate) > 30)
    || String(data.online_status || "") !== "selling"
    || !(Number(data.stock) > 0)) return null;
  const store = STORES.find((candidate) => candidate.id === storeId);
  return {
    store_id: storeId,
    store_name: data.store_name || store.name,
    sku,
    product_link: `https://www.ozon.ru/product/${sku}`,
    title: data.title || "",
    profit_rate: data.profit_rate,
    sell_price: data.sell_price ?? "",
    purchase_price: data.purchase_price ?? "",
    offer_id: data.offer_id || "",
    online_status: data.online_status,
    stock: data.stock,
    published_at: data.published_at || event.timestamp || "",
    source_file: sourceFile,
  };
}

export async function exportConfirmedStoreSkus({ runsRoot, outputDir }) {
  let sourceStat;
  try { sourceStat = await fs.stat(runsRoot); } catch {}
  if (!sourceStat?.isDirectory()) throw new Error(`confirmed source root is unavailable: ${runsRoot}`);
  const bySku = new Map();
  for (const filename of await publishedFiles(runsRoot)) {
    const text = await fs.readFile(filename, "utf8");
    for (const line of text.split(/\r?\n/u)) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const row = confirmedRow(event, path.relative(runsRoot, filename));
      if (!row) continue;
      const existing = bySku.get(row.sku);
      if (!existing || String(row.published_at) > String(existing.published_at)) bySku.set(row.sku, row);
    }
  }

  await fs.mkdir(outputDir, { recursive: true });
  const summary = { generated_at: new Date().toISOString(), criteria: "profit_rate > 30, online_status=selling, stock>0", excluded_skus: [...EXCLUDED_SKUS], stores: {} };
  const aggregate = [];
  for (const store of STORES) {
    const rows = [...bySku.values()]
      .filter((row) => row.store_id === store.id)
      .sort((left, right) => left.sku.localeCompare(right.sku));
    aggregate.push(...rows);
    summary.stores[String(store.id)] = { name: store.name, confirmed: rows.length, file: `confirmed_store_${store.id}.csv` };
    const body = [HEADERS.join(","), ...rows.map((row) => HEADERS.map((header) => csvCell(row[header])).join(","))].join("\n");
    await fs.writeFile(path.join(outputDir, `confirmed_store_${store.id}.csv`), `${body}\n`, "utf8");
  }
  const aggregateBody = [HEADERS.join(","), ...aggregate.map((row) => HEADERS.map((header) => csvCell(row[header])).join(","))].join("\n");
  await fs.writeFile(path.join(outputDir, "confirmed_all_stores.csv"), `${aggregateBody}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

async function invokedAsMain(argv1 = process.argv[1]) {
  if (!argv1) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return await fs.realpath(path.resolve(argv1)) === await fs.realpath(modulePath);
  } catch {
    return path.resolve(argv1) === path.resolve(modulePath);
  }
}

if (await invokedAsMain()) {
  const root = path.resolve(import.meta.dirname, "..");
  const runsRoot = path.resolve(process.argv[2] || path.join(root, "runs/flow_b"));
  const outputDir = path.resolve(process.argv[3] || path.join(root, "../exports/confirmed_store_skus"));
  console.log(JSON.stringify(await exportConfirmedStoreSkus({ runsRoot, outputDir }), null, 2));
}
