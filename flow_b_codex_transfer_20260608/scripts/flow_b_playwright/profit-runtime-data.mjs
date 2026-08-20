import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function evidenceFromOutput(output) {
  const source = String(output || "");
  const key = source.match(/^MATCH_EVIDENCE_KEY\s+(.+)$/mu)?.[1]?.trim() || "";
  const selectedOfferId = source.match(/^SELECTED_OFFER_ID\s+(.+)$/mu)?.[1]?.trim() || "";
  const encoded = source.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1]?.trim() || "";
  if (!key || !selectedOfferId || !encoded) return null;
  if (crypto.createHash("sha256").update(encoded, "utf8").digest("hex") !== key) return null;
  const evidence = parseJson(encoded, null);
  if (!evidence) return null;
  if (text(evidence.selected_offer_id) !== selectedOfferId) return null;
  const selectedRow = (evidence.selected_cluster || []).find((row) => text(row?.offer_id) === selectedOfferId);
  if (!selectedRow || Number(selectedRow.price) !== Number(evidence.selected_cost)) return null;
  const offerIds = [...new Set((evidence.rows || [])
    .map((row) => text(row?.offer_id)).filter(Boolean))];
  if (!offerIds.includes(selectedOfferId)) return null;
  return { key, selected_offer_id: selectedOfferId, selected_offer_ids: [selectedOfferId], matched_offer_ids: offerIds };
}

export async function readCostEvidenceOffers(sharedCachePath) {
  const result = new Map();
  const filename = text(sharedCachePath);
  if (!filename) return result;
  let cache = {};
  try { cache = JSON.parse(await fs.readFile(path.resolve(filename), "utf8")); }
  catch (error) { if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  for (const entry of Object.values(cache?.entries || {})) {
    const evidence = evidenceFromOutput(entry?.output);
    if (evidence) result.set(evidence.key, evidence);
  }
  return result;
}

function categoryFor(data) {
  const evidence = data?.content_quality_evidence?.category || {};
  const labels = Array.isArray(evidence.labels) ? evidence.labels.filter(Boolean) : [];
  return text(evidence.mapped || labels.at(-1) || evidence.raw || data?.category_name || data?.cate_name);
}

function addIndex(map, key, row) {
  if (!key) return;
  const values = map.get(key) || [];
  values.push(row);
  map.set(key, values);
}

function exactOrUnique(map, storeId, value) {
  const normalized = text(value);
  if (!normalized) return null;
  const storeKey = Number(storeId) > 0 ? `${Number(storeId)}:${normalized}` : "";
  if (storeKey && map.get(storeKey)?.length) return map.get(storeKey).at(-1);
  // A supplied store ID is authoritative. Falling back across stores here can
  // teach one shop from another shop's sales when an ERP row is malformed.
  if (storeKey) return null;
  const matches = map.get(`*:${normalized}`) || [];
  const uniqueSources = new Set(matches.map((row) => row.source_sku));
  return uniqueSources.size === 1 ? matches.at(-1) : null;
}

export async function readProfitProductIndex({ runtimeDbPath, sharedCachePath = null } = {}) {
  const filename = text(runtimeDbPath);
  const rows = [];
  if (filename && fsSync.existsSync(path.resolve(filename))) {
    const database = new DatabaseSync(path.resolve(filename), { readOnly: true });
    try {
      const states = database.prepare("SELECT sku, updated_at, data_json FROM sku_state ORDER BY updated_at").all();
      for (const state of states) {
        const data = parseJson(state.data_json);
        const sourceSku = text(state.sku);
        if (!sourceSku) continue;
        const persistedSelectedOfferId = text(data?.cost?.selected_offer_id || data?.cost_evidence?.selected_offer_id);
        const unambiguousLegacySelectedOfferId = !persistedSelectedOfferId
          && Array.isArray(data?.cost?.selected_offer_ids)
          && data.cost.selected_offer_ids.map(text).filter(Boolean).length === 1
          ? text(data.cost.selected_offer_ids[0])
          : "";
        const selectedOfferId = persistedSelectedOfferId || unambiguousLegacySelectedOfferId;
        rows.push({
          source_sku: sourceSku,
          store_id: Number(data.store_id) > 0 ? Number(data.store_id) : null,
          store_sku: text(data.store_sku),
          offer_id: text(data.offer_id),
          title: text(data.title),
          category: categoryFor(data),
          match_evidence_key: text(data?.cost?.match_evidence_key || data?.cost_evidence?.match_evidence_key),
          selected_offer_id: selectedOfferId,
          selected_offer_ids: selectedOfferId ? [selectedOfferId] : [],
          matched_offer_ids: Array.isArray(data?.cost?.matched_offer_ids)
            ? data.cost.matched_offer_ids.map(text).filter(Boolean)
            : [],
          purchase_price: Number(data.purchase_price ?? data?.cost?.cost) || null,
          updated_at: text(state.updated_at),
          data,
        });
      }
    } finally {
      database.close();
    }
  }
  const evidenceOffers = await readCostEvidenceOffers(sharedCachePath);
  for (const row of rows) {
    if (row.selected_offer_id || !row.match_evidence_key) continue;
    const evidence = evidenceOffers.get(row.match_evidence_key);
    if (!evidence) continue;
    row.selected_offer_id = evidence.selected_offer_id;
    row.selected_offer_ids = evidence.selected_offer_ids;
    row.matched_offer_ids = evidence.matched_offer_ids;
  }
  const byStoreSku = new Map();
  const byOfferId = new Map();
  const bySourceSku = new Map();
  for (const row of rows) {
    addIndex(bySourceSku, row.source_sku, row);
    if (row.store_sku) {
      addIndex(byStoreSku, `${row.store_id || "*"}:${row.store_sku}`, row);
      addIndex(byStoreSku, `*:${row.store_sku}`, row);
    }
    if (row.offer_id) {
      addIndex(byOfferId, `${row.store_id || "*"}:${row.offer_id}`, row);
      addIndex(byOfferId, `*:${row.offer_id}`, row);
    }
  }
  const resolve = ({ store_id: storeId, store_sku: storeSku, offer_id: offerId, source_sku: sourceSku } = {}) => {
    if (text(sourceSku) && bySourceSku.get(text(sourceSku))?.length) return bySourceSku.get(text(sourceSku)).at(-1);
    return exactOrUnique(byStoreSku, storeId, storeSku)
      || exactOrUnique(byOfferId, storeId, offerId)
      || null;
  };
  const sourceSkuByStoreSku = new Map();
  const sourceSkuByOfferId = new Map();
  for (const row of rows) {
    if (row.store_sku) {
      sourceSkuByStoreSku.set(`${row.store_id}:${row.store_sku}`, row.source_sku);
      if ((byStoreSku.get(`*:${row.store_sku}`) || []).every((item) => item.source_sku === row.source_sku)) {
        sourceSkuByStoreSku.set(row.store_sku, row.source_sku);
      }
    }
    if (row.offer_id) {
      sourceSkuByOfferId.set(`${row.store_id}:${row.offer_id}`, row.source_sku);
      if ((byOfferId.get(`*:${row.offer_id}`) || []).every((item) => item.source_sku === row.source_sku)) {
        sourceSkuByOfferId.set(row.offer_id, row.source_sku);
      }
    }
  }
  return {
    rows,
    byStoreSku,
    byOfferId,
    bySourceSku,
    sourceSkuByStoreSku,
    sourceSkuByOfferId,
    resolve,
  };
}

export function enrichErpOrderRow(row, productIndex) {
  const storeId = row?.store_id ?? row?.shop_id ?? row?.storeId ?? row?.shopId ?? row?.shop?.id ?? row?.store?.id;
  const storeSku = row?.store_sku ?? row?.own_ozon_sku ?? row?.ozon_sku ?? row?.seller_sku ?? row?.sku ?? row?.product?.sku ?? row?.item?.sku;
  const offerId = row?.offer_id ?? row?.own_offer_id ?? row?.seller_offer_id ?? row?.vendor_code ?? row?.product?.offer_id ?? row?.item?.offer_id;
  const product = productIndex?.resolve?.({ store_id: storeId, store_sku: storeSku, offer_id: offerId }) || null;
  if (!product) return row;
  return {
    ...row,
    store_id: Number(storeId) > 0 ? Number(storeId) : product.store_id,
    store_sku: text(storeSku) || product.store_sku,
    offer_id: text(offerId) || product.offer_id,
    source_sku: text(row?.source_sku) || product.source_sku,
    title: text(row?.title || row?.product_title || row?.name) || product.title,
    category: text(row?.category || row?.category_name || row?.product_category) || product.category,
  };
}
