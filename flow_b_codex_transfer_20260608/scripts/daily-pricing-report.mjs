import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { dailyWindowState, localDateKeyFor } from "./daily-window.mjs";
import { isTerminalSubmittedFailure } from "./flow_b_playwright/submission-evidence.mjs";

export const DEFAULT_REPORT_DIR = "/Users/mac/Desktop/ozon每日上品";
export const REPORT_STATE_DIRNAME = "daily_pricing_reports";

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function firstRecord(...values) {
  return values.map(record).find(Boolean) || {};
}

function compactText(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(compactText).filter(Boolean).join(" / ");
  if (typeof value === "object") {
    return Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => {
        const nested = compactText(entry);
        return nested ? `${key}: ${nested}` : "";
      })
      .filter(Boolean)
      .join("；");
  }
  return text(value);
}

function timestampMs(value) {
  const result = Date.parse(text(value));
  return Number.isFinite(result) ? result : null;
}

function offerUrlFor(offerId, ...values) {
  const explicit = values.map(text).find(Boolean);
  if (explicit) return explicit;
  const id = text(offerId);
  return /^\d+$/u.test(id) ? `https://detail.1688.com/offer/${id}.html` : "";
}

function variantIdFor(targetVariant, evidence) {
  const variant = record(targetVariant);
  if (!variant) return compactText(targetVariant);
  return text(
    variant.variant_id
    ?? variant.sku_id
    ?? variant.spec_id
    ?? variant.id
    ?? evidence.variant_id
    ?? evidence.sku_id,
  ) || compactText(variant);
}

function evidenceObject(data, accepted) {
  const verification = firstRecord(
    data.supply_verification,
    data.supply_verifier_result,
    data.supply_result,
    accepted.supply_verification,
  );
  return {
    evidence: firstRecord(
      data.supply_evidence,
      verification.evidence,
      accepted.supply_evidence,
    ),
    verification,
  };
}

function supplyGateFlag(data, accepted, verification) {
  for (const value of [
    data.supply_gate_passed,
    verification.supply_gate_passed,
    accepted.supply_gate_passed,
  ]) {
    if (value === true || value === false) return value;
  }
  return null;
}

function supplyEvidenceComplete(evidence) {
  const attributes = record(evidence.variant_attributes);
  const targetVariant = record(evidence.target_variant);
  const hasTargetVariant = Boolean(targetVariant && Object.keys(targetVariant).length > 0);
  const hasVariantAttributes = Boolean(attributes && Object.keys(attributes).length > 0);
  const variantMatched = evidence.item_level_match === true
    ? !hasTargetVariant && !hasVariantAttributes
    : hasTargetVariant && hasVariantAttributes;
  const checkedAt = timestampMs(evidence.checked_at ?? evidence.verified_at);
  const validUntil = timestampMs(evidence.valid_until ?? evidence.expires_at);
  let offerBound = false;
  try {
    const parsed = new URL(text(evidence.offer_url));
    offerBound = parsed.protocol === "https:"
      && (parsed.hostname === "1688.com" || parsed.hostname.endsWith(".1688.com"))
      && parsed.pathname.toLowerCase().includes(`/offer/${text(evidence.offer_id).toLowerCase()}.html`);
  } catch {}
  return text(evidence.contract) === "1688-orderable-v1"
    && evidence.passed === true
    && text(evidence.platform).toLowerCase() === "1688"
    && Boolean(text(evidence.offer_id))
    && offerBound
    && variantMatched
    && typeof evidence.unit_price === "number"
    && Number.isFinite(evidence.unit_price)
    && evidence.unit_price > 0
    && typeof evidence.moq === "number"
    && Number.isFinite(evidence.moq)
    && evidence.moq > 0
    && evidence.moq <= 1
    && typeof evidence.orderable_quantity === "number"
    && Number.isInteger(evidence.orderable_quantity)
    && evidence.orderable_quantity === 1
    && evidence.orderable === true
    && text(evidence.stock_state) === "in_stock"
    && /^[a-f0-9]{64}$/iu.test(text(evidence.match_evidence_key))
    && checkedAt !== null
    && validUntil !== null
    && validUntil > checkedAt
    && validUntil - checkedAt <= 30 * 60_000;
}

function normalizedSupplyEvidence(data, accepted, observedAt) {
  const { evidence, verification } = evidenceObject(data, accepted);
  const gateFlag = supplyGateFlag(data, accepted, verification);
  const legacyOfferId = text(
    data.cost?.selected_offer_id
    || data.cost_evidence?.selected_offer_id
    || data.selected_offer_id
    || accepted.selected_offer_id,
  );
  const offerId = text(evidence.offer_id) || legacyOfferId;
  const offerUrl = offerUrlFor(
    offerId,
    evidence.offer_url,
    data.selected_offer_url,
    data.cost?.selected_offer_url,
    accepted.selected_offer_url,
  );
  const targetVariant = evidence.target_variant ?? evidence.variant ?? evidence.variant_id ?? evidence.sku_id;
  const variantAttributes = firstRecord(evidence.variant_attributes, record(targetVariant)?.variant_attributes);
  const checkedAt = text(evidence.checked_at ?? evidence.verified_at);
  const validUntil = text(evidence.valid_until ?? evidence.expires_at);
  const validUntilMs = timestampMs(validUntil);
  const observedAtMs = observedAt instanceof Date ? observedAt.getTime() : timestampMs(observedAt);
  const evidenceExpired = validUntilMs !== null
    && observedAtMs !== null
    && validUntilMs <= observedAtMs;
  const verificationStatus = text(
    data.supply_gate_status
    || verification.status
    || evidence.status,
  ).toLowerCase();
  const explicitlyDeferred = /deferred|pending|review/u.test(verificationStatus);
  const explicitlyBlocked = /blocked|failed|rejected/u.test(verificationStatus);
  const complete = supplyEvidenceComplete(evidence);
  let gateStatus = "待复核";
  if (explicitlyDeferred) {
    gateStatus = "待复核（验证延后）";
  } else if (gateFlag === false || evidence.passed === false || explicitlyBlocked) {
    gateStatus = "未通过";
  } else if (evidenceExpired) {
    gateStatus = "待复核（证据已过期）";
  } else if (gateFlag === true && complete) {
    gateStatus = "通过";
  }
  const orderableQuantity = numeric(evidence.orderable_quantity);
  const orderable = evidence.orderable === true ? true : evidence.orderable === false ? false : null;
  return {
    supply_1688_url: offerUrl,
    supply_offer_id: offerId,
    supply_variant_id: variantIdFor(targetVariant, evidence),
    supply_spec_summary: text(evidence.spec_summary)
      || compactText(variantAttributes)
      || (evidence.item_level_match === true ? "整款（无规格）" : ""),
    supply_unit_price: numeric(evidence.unit_price),
    supply_moq: numeric(evidence.moq),
    supply_stock_state: text(evidence.stock_state),
    supply_orderable: orderable,
    supply_orderable_quantity: orderableQuantity,
    supply_orderable_status: orderable === true
      ? `可购买${orderableQuantity === 1 ? "（1件）" : ""}`
      : orderable === false ? "不可购买" : "未知",
    supply_checked_at: checkedAt,
    supply_valid_until: validUntil,
    supply_gate_status: gateStatus,
    supply_evidence_complete: complete,
    supply_evidence_expired: evidenceExpired,
  };
}

function skuText(value) {
  const raw = text(value);
  if (!raw) return "";
  if (/^\d+$/u.test(raw)) return raw;
  const result = Number(raw);
  return Number.isFinite(result) && result > 0 ? String(Math.trunc(result)) : "";
}

const RUNTIME_STATE_QUERY_CHUNK_SIZE = 400;

function readRuntimeStates(runtimeDbPath, skus = []) {
  const requestedSkus = [...new Set([...skus].map((sku) => text(sku)).filter(Boolean))];
  if (requestedSkus.length === 0) return new Map();
  const rawPath = String(runtimeDbPath || "").trim();
  if (!rawPath) return new Map();
  const filename = path.resolve(rawPath);
  if (!fsSync.existsSync(filename)) return new Map();
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const states = new Map();
    for (let offset = 0; offset < requestedSkus.length; offset += RUNTIME_STATE_QUERY_CHUNK_SIZE) {
      const chunk = requestedSkus.slice(offset, offset + RUNTIME_STATE_QUERY_CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = database.prepare(`
        SELECT sku, stage, terminal, reason, updated_at, data_json
        FROM sku_state
        WHERE sku IN (${placeholders})
      `).all(...chunk);
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

function resolveOwnSku(state, acceptedStoreId) {
  const data = state?.data || {};
  const canonical = skuText(data.store_sku);
  if (canonical) return canonical;
  for (const product of [data.final_result?.online_product, data.online_product]) {
    const nestedSku = skuText(product?.sku);
    const evidenceStoreId = numeric(product?.shop_id);
    if (nestedSku && acceptedStoreId > 0 && evidenceStoreId === acceptedStoreId) return nestedSku;
  }
  return "";
}

function isDurableTerminalFailure(state) {
  if (state?.terminal === true) return true;
  return state?.data?.submitted === true && isTerminalSubmittedFailure(state);
}

function rowStatus({ ownSku, terminal }) {
  if (ownSku) return "已生成本店SKU";
  if (terminal) return "终态失败";
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

function normalizedRecord(accepted, state, store, observedAt) {
  const data = state?.data || {};
  const acceptedTimestamp = acceptedAt(accepted);
  const acceptedStoreId = numeric(accepted.store_id);
  const ownSku = resolveOwnSku(state, acceptedStoreId);
  const terminal = isDurableTerminalFailure(state);
  const stateId = stateStoreId(state);
  const mismatch = state && stateId && acceptedStoreId && stateId !== acceptedStoreId;
  const status = mismatch ? "店铺ID不匹配" : rowStatus({ ownSku, terminal });
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
    terminal,
    has_own_sku: Boolean(ownSku),
    mismatch,
    ...normalizedSupplyEvidence(data, accepted, observedAt),
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
  const stateBySku = readRuntimeStates(runtimeDbPath, [...latest.values()].map((accepted) => accepted.sku));
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
    const row = normalizedRecord(accepted, state, store, now);
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
