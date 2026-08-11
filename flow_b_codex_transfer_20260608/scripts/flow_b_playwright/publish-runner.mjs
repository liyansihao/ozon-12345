import fs from "node:fs/promises";
import path from "node:path";

import * as defaultPolicy from "./publish-policy.mjs";
import { canonicalProductUrl } from "./publish-state.mjs";
import { mapOzonCategory } from "./category-commission.mjs";
import {
  fullFunnelSourceScores,
  clearJsonLinesFileCache,
  jsonLinesFileCacheStats,
  normalizeRuntimeSourceYieldRows,
  observedTitleFamilyScores,
  productTitleFamily,
  productTitlePriority,
  readJsonLinesIncremental,
  sourceYieldKey,
} from "./source-scanner.mjs";
import { boundedTransientFailure } from "./retry-policy.mjs";
import { AdaptiveConcurrency, isFatalBrowserError, loadCandidateFacts, loadPreflightPureSkus, mergeCandidateFacts } from "./continuous-runtime.mjs";
import {
  hasReliableSameItemCostEvidence,
  sameItemCostEvidence,
} from "./cost-evidence.mjs";
import { isOzonSoftBlockError } from "./ozon-access-controller.mjs";
import { submissionGatePolicy } from "./live-acceptance-gates.mjs";
import { productWeightGrams, selectShippingRoute } from "./shipping-route.mjs";
import { createProfitFilesReader, prioritizeProfitRows } from "./profit-priority.mjs";
import { assessProfitSafety, assessProfitSafetyGate } from "./profit-safety.mjs";
import { dailyWindowState } from "../daily-window.mjs";

const ECONOMY_SENTINEL = Object.freeze({
  title: "CEL Economy",
  price_list: { logistics_name: "CEL", logistics_speed: "economy" },
});
const observedPublishFeedbackCompositeCache = new Map();
const MIN_URGENT_ONLINE_SYNC_INTERVAL_MS = 180_000;
const MAX_ONLINE_SYNC_SERVER_BACKOFF_MS = 24 * 60 * 60 * 1000;
let currentStoreWriteSequence = 0;
const FATAL_RUNNER_STATE_CODES = new Set([
  "SUBMISSION_ACCEPTANCE_PERSIST_FAILED",
  "SUBMISSION_GATE_UNAVAILABLE",
]);

function isFatalAuthenticationError(error) {
  const status = Number(
    error?.status
    ?? error?.statusCode
    ?? error?.response?.status
    ?? error?.response?.statusCode,
  );
  if ([401, 403].includes(status)) return true;
  return /(?:maozi|毛子)[^\n]{0,100}(?:not logged in|login required|access\s*token|unauthenticated|unauthori[sz]ed|forbidden|authentication required|(?:HTTP\s*)?(?:401|403))|access\s*token[^\n]{0,80}(?:empty|expired|invalid|missing)|(?:\bmfa\b|multi[- ]factor|two[- ]factor|2fa|unauthenticated|authentication required|login required|session (?:has )?expired)|(?:HTTP\s*)?(?:401|403)[^\n]{0,80}(?:unauthenticated|unauthori[sz]ed|forbidden|auth|token|login)|(?:unauthenticated|unauthori[sz]ed|forbidden)[^\n]{0,80}(?:auth|token|login)/iu
    .test(String(error?.message || error || ""));
}

function isFatalRunnerError(error) {
  return isFatalBrowserError(error)
    || isFatalAuthenticationError(error)
    || FATAL_RUNNER_STATE_CODES.has(String(error?.code || ""));
}

function boundedBackoffMs(value, maximumMs = MAX_ONLINE_SYNC_SERVER_BACKOFF_MS) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) return null;
  return Math.min(Math.max(0, Number(maximumMs) || 0), Math.ceil(duration));
}

function retryAfterHeaderValue(headers) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    const value = headers.get("retry-after");
    if (value !== null && value !== undefined) return value;
  }
  if (typeof headers !== "object") return null;
  const entry = Object.entries(headers).find(([name]) => String(name).toLowerCase() === "retry-after");
  return entry?.[1] ?? null;
}

function retryAfterHeaderMs(value, nowMs) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/u.test(text)) return Number(text) * 1000;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

function messageRetryAfterMs(message) {
  const text = String(message || "");
  const duration = (amount, unit) => {
    const count = Number(amount);
    if (!Number.isFinite(count) || count < 0) return null;
    const normalizedUnit = String(unit || "seconds").toLowerCase();
    if (/^(?:ms|millisecond|milliseconds|毫秒)$/u.test(normalizedUnit)) return count;
    if (/^(?:m|min|mins|minute|minutes|分钟)$/u.test(normalizedUnit)) return count * 60_000;
    return count * 1000;
  };
  const retryAfter = text.match(
    /retry[-_\s]?after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m)?/iu,
  );
  if (retryAfter) return duration(retryAfter[1], retryAfter[2]);
  const humanWait = text.match(
    /(?:retry|try\s+again|back\s*off|wait)[^0-9]{0,32}(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m)/iu,
  );
  if (humanWait) return duration(humanWait[1], humanWait[2]);
  const chineseWait = text.match(/(\d+(?:\.\d+)?)\s*(毫秒|秒(?:钟)?|分钟)\s*(?:后|以后)/u);
  if (chineseWait) return duration(chineseWait[1], chineseWait[2] === "秒钟" ? "秒" : chineseWait[2]);
  return null;
}

export function onlineSyncRetryAfterMs(error, {
  nowMs = Date.now(),
  maximumMs = MAX_ONLINE_SYNC_SERVER_BACKOFF_MS,
} = {}) {
  const response = error?.response;
  const data = response?.data;
  const millisecondValues = [
    error?.retryAfterMs,
    error?.retry_after_ms,
    error?.backoffMs,
    error?.backoff_ms,
    response?.retryAfterMs,
    response?.retry_after_ms,
    data?.retryAfterMs,
    data?.retry_after_ms,
  ];
  const retryAfterValues = [
    error?.retryAfter,
    error?.retry_after,
    response?.retryAfter,
    response?.retry_after,
    data?.retryAfter,
    data?.retry_after,
    retryAfterHeaderValue(error?.headers),
    retryAfterHeaderValue(response?.headers),
  ];
  const messages = [
    error?.message,
    data?.message,
    data?.msg,
    data?.error,
    error?.cause?.message,
  ].filter(Boolean);
  const candidates = [
    ...millisecondValues.map((value) => Number(value)),
    ...retryAfterValues.map((value) => retryAfterHeaderMs(value, Number(nowMs))),
    ...messages.map(messageRetryAfterMs),
  ].filter((value) => Number.isFinite(value) && value >= 0);
  if (candidates.length === 0
    && messages.some((message) => /请求过于频繁|too many requests|\b429\b|rate.?limit|throttl/iu.test(String(message)))) {
    candidates.push(MIN_URGENT_ONLINE_SYNC_INTERVAL_MS);
  }
  if (candidates.length === 0) return null;
  return boundedBackoffMs(Math.max(...candidates), maximumMs);
}

export function strictSourceYieldEvidence({
  onlineProduct,
  profitRate,
  shippingMode,
  productUrl,
} = {}) {
  const onlineStatus = String(onlineProduct?.online_status || "").toLowerCase();
  const stock = Number(onlineProduct?.stock);
  const profit = Number(profitRate);
  const mode = String(shippingMode || "").toUpperCase();
  if (onlineStatus !== "selling" || !(stock > 0) || !(profit > 30) || mode !== "FBS") return {};
  let normalizedProductUrl = null;
  try {
    const url = new URL(String(productUrl || ""));
    if (/(?:^|\.)ozon\.ru$/iu.test(url.hostname)
      && /^\/product\/[^/]*\d+\/?$/iu.test(url.pathname)) {
      url.hash = "";
      url.search = "";
      if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
      normalizedProductUrl = url.toString();
    }
  } catch {}
  return {
    strict_confirmed: true,
    online_status: onlineStatus,
    stock,
    profit_rate: profit,
    shipping_mode: "FBS",
    ...(normalizedProductUrl ? { product_url: normalizedProductUrl } : {}),
  };
}

export function duplicateTitleKey(value) {
  const normalized = defaultPolicy.normalizeName(value);
  return normalized.length >= 24 ? normalized : null;
}

function normalizedContentText(value) {
  return String(value ?? "").replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "").trim();
}

function firstContentValue(detailValue, itemValue) {
  const detail = normalizedContentText(detailValue);
  if (detail) return { value: detail, source: "ozon-detail" };
  const item = normalizedContentText(itemValue);
  return { value: item, source: item ? "favorite-snapshot" : null };
}

function validHttpImageUrl(value) {
  try {
    const url = new URL(normalizedContentText(value));
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validCategoryParts(value) {
  return (Array.isArray(value) ? value : []).filter((part) => {
    if (typeof part === "number") return Number.isFinite(part) && part > 0;
    return typeof part === "string" && part.trim().length > 0;
  });
}

function commissionCategoryEvidence(rawCategory, mappedCategory, commissionTree) {
  const top = (Array.isArray(commissionTree) ? commissionTree : [])
    .find((row) => String(row?.cate_id ?? row?.value) === String(rawCategory[0]));
  const second = top?.children?.find(
    (row) => String(row?.cate_id ?? row?.value) === String(rawCategory[1]),
  );
  const tier = second?.children?.find(
    (row) => String(row?.value ?? row?.cate_id) === String(mappedCategory[2]),
  );
  const hierarchyLabels = [top?.label, second?.label].map(normalizedContentText).filter(Boolean);
  return {
    hierarchy_match: Boolean(top && second),
    tier_match: Boolean(tier),
    hierarchy_labels: hierarchyLabels,
  };
}

export function preSubmitContentQuality({
  item = {},
  detail = {},
  categoryData = {},
  category = {},
  commissionTree = [],
} = {}) {
  const titleValue = firstContentValue(detail?.title, item?.title);
  const imageValue = firstContentValue(detail?.cover_image, item?.cover_image);
  const title = titleValue.value;
  const image = imageValue.value;
  const rawCategory = validCategoryParts(categoryData?.cate);
  const mappedCategory = validCategoryParts(category?.mapped);
  const categoryEvidence = commissionCategoryEvidence(rawCategory, mappedCategory, commissionTree);
  const categoryText = [
    title,
    detail?.category,
    detail?.category_name,
    detail?.cate_name,
    item?.category,
    item?.category_name,
    item?.cate_name,
    ...categoryEvidence.hierarchy_labels,
  ].filter(Boolean).join(" ");
  const prohibitedReason = defaultPolicy.prohibitedCategorySkipReason(categoryText);
  const checks = {
    prohibited_category: prohibitedReason === null,
    title: /[\p{L}\p{N}]/u.test(title),
    image: validHttpImageUrl(image),
    category: rawCategory.length >= 2
      && mappedCategory.length >= 3
      && categoryEvidence.hierarchy_match
      && categoryEvidence.tier_match
      && categoryEvidence.hierarchy_labels.length === 2,
  };
  const categoryReason = rawCategory.length < 2
    ? "category-data-missing"
    : (!checks.category ? "category-mapping-unavailable" : null);
  let reason = prohibitedReason;
  if (!title) reason = "missing-title";
  else if (!checks.title) reason = "invalid-title";
  else if (!image) reason = "missing-cover-image";
  else if (!checks.image) reason = "invalid-cover-image-url";
  else if (categoryReason) reason = categoryReason;
  return {
    ok: reason === null,
    reason,
    checks,
    title,
    image,
    evidence: {
      title: { source: titleValue.source, value: title || null },
      image: { source: imageValue.source, url: image || null },
      category: {
        raw: rawCategory,
        mapped: mappedCategory,
        labels: (Array.isArray(category?.labels) ? category.labels : []).map(normalizedContentText).filter(Boolean),
        commission_tree_match: categoryEvidence.hierarchy_match,
        commission_tier_match: categoryEvidence.tier_match,
        hierarchy_labels: categoryEvidence.hierarchy_labels,
      },
    },
  };
}

export function preSubmitTechnicalQuality(input = {}) {
  const quality = preSubmitContentQuality(input);
  let reason = null;
  if (quality.reason === "prohibited-category") reason = "prohibited-category";
  else if (!quality.title) reason = "missing-title";
  else if (!quality.checks.title) reason = "invalid-title";
  else if (!quality.image) reason = "missing-cover-image";
  else if (!quality.checks.image) reason = "invalid-cover-image-url";
  else if (!quality.evidence.category.raw || quality.evidence.category.raw.length < 2) {
    reason = "category-data-missing";
  } else if (!quality.checks.category) {
    reason = "category-mapping-unavailable";
  }
  return {
    ...quality,
    ok: reason === null,
    reason,
    checks: {
      ...quality.checks,
    },
  };
}

export function normalizeCostFailureReason(cost = {}) {
  const evidence = `${cost?.reason || ""} ${cost?.error?.code || ""} ${cost?.error?.message || ""}`.trim();
  if (/timed?\s*out|timeout/i.test(evidence)) return "1688-timeout";
  if (/image|download|http\s*\d|fetch/i.test(evidence)) return "1688-image-fetch-failed";
  return "1688-no-reliable-match";
}

function reliable1688CostEvidence(data = {}, {
  requireContract = true,
  minimumMatches = 3,
} = {}) {
  if (!requireContract) {
    return data?.cost_verified === true
      && data?.cost?.ok === true
      && Number.isFinite(Number(data?.cost?.cost))
      && Number(data.cost.cost) > 0;
  }
  return hasReliableSameItemCostEvidence(data, { minimumMatches });
}

function publicationCostEvidence(cost = {}, {
  requireContract = false,
  minimumMatches = 3,
} = {}) {
  const explicitEvidence = sameItemCostEvidence(cost, { minimumMatches });
  const positiveCost = cost?.ok === true && Number(cost?.cost) > 0;
  return {
    cost_verified: positiveCost && (!requireContract || explicitEvidence.same_item_match === true),
    cost: { ...(cost || {}) },
    cost_source: String(cost?.source || "").trim() || null,
    cost_evidence: explicitEvidence,
  };
}

function deterministicProfitFailureReason(error) {
  const message = String(error?.message || error || "");
  if (/没有符合的物流方式|no (?:available|matching|suitable) logistics/i.test(message)) {
    return "missing-shipping-mode";
  }
  return null;
}

function transientCandidateBackoffMs(attempts) {
  const delays = [30_000, 60_000, 120_000];
  const index = Math.min(delays.length - 1, Math.max(0, Number(attempts) - 1));
  return delays[index];
}

function isDeferredCandidateReason(reason) {
  return [
    "1688-health-deferred",
    "ozon-detail-soft-block-deferred",
    "category-data-missing",
    "category-mapping-unavailable",
    "submission-not-sent-deferred",
  ].includes(String(reason || ""));
}

function asSku(item) {
  const sku = String(item?.sku ?? item?.id ?? "").trim();
  if (!sku) throw new Error("candidate SKU is required");
  return sku;
}

function economyResult(calc, logistics = "CEL") {
  if (calc?.economy?.price_list && calc.economy.price_list.logistics_name === logistics) return calc.economy;
  const rows = calc?.calc_result ?? calc?.data?.calc_result;
  if (!Array.isArray(rows)) return null;
  const row = rows.find((entry) => entry?.name === logistics && entry?.speed === "economy");
  return row ? { title: row.title, price_list: row.price_list } : null;
}

function offerDate(date) {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(date.getUTCFullYear()).slice(-2);
  return `${dd}${mm}${yy}`;
}

export function offerIdForSku(skuValue, date = new Date()) {
  const sku = String(skuValue || "").trim();
  if (!sku) throw new Error("offer SKU is required");
  return `mz-${offerDate(date)}-${sku}`;
}

function localDateKey(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function restoredDailyStoreUsage(entries, storeId, at = new Date(), timeZone = "Asia/Shanghai") {
  const targetDay = localDateKey(at, timeZone);
  const skus = new Set();
  for (const entry of entries || []) {
    const data = entry?.data || {};
    if (Number(data.store_id) !== Number(storeId)) continue;
    if (entry?.status !== "published" && data.submitted !== true && data.submission_pending !== true) continue;
    const timestamp = data.submitted_at || data.published_at || data.reconciled_at || data.prepared_at;
    if (localDateKey(timestamp, timeZone) !== targetDay) continue;
    const sku = String(entry?.sku ?? data.sku ?? "").trim();
    if (sku) skus.add(sku);
  }
  return skus.size;
}

export function verifiedWarehouseCandidates(store = {}) {
  const candidates = new Map();
  const visited = new Set();
  const warehouseField = /^(?:warehouse|warehouses|warehouse_list|warehouseList)$/;
  const listWrapperField = /^(?:data|items|list|rows|records)$/i;
  const recordCandidate = (row, allowGenericId = false) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return;
    const warehouseId = Number(row.warehouse_id || (allowGenericId ? row.id : 0));
    if (!(warehouseId > 0) || candidates.has(warehouseId)) return;
    candidates.set(warehouseId, { ...row, warehouse_id: warehouseId });
  };
  const visitWarehouseContainer = (value, arrayRow = false) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const row of value) visitWarehouseContainer(row, true);
      return;
    }
    recordCandidate(value, arrayRow);
    for (const [key, child] of Object.entries(value)) {
      if (!child || typeof child !== "object") continue;
      if (warehouseField.test(key) || listWrapperField.test(key)) {
        visitWarehouseContainer(child, Array.isArray(child));
      } else {
        findWarehouseFields(child);
      }
    }
  };
  function findWarehouseFields(value) {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const child of value) findWarehouseFields(child);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (!child || typeof child !== "object") continue;
      if (warehouseField.test(key)) visitWarehouseContainer(child);
      else findWarehouseFields(child);
    }
  }
  findWarehouseFields(store);
  return [...candidates.values()];
}

function rounded(value) {
  return Math.round(Number(value) * 100) / 100;
}

function plausibleCnyRubRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 5 && rate <= 30 ? rate : null;
}

function observedCandidateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(raw)
    ? `${raw.replace(" ", "T")}+08:00`
    : raw;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function freshCnySnapshotSalePrice(item, {
  now = new Date(),
  maximumAgeMs = 15 * 60_000,
} = {}) {
  if (String(item?.source_currency || "").toUpperCase() !== "CNY") return null;
  const salePrice = Number(item?.sell_price ?? item?.sale_price);
  if (!(salePrice > 0)) return null;
  const observedAt = [
    item?.update_time,
    item?.create_time,
    item?.favorited_at,
    item?.collected_at,
  ].map(observedCandidateTime).find((value) => value !== null);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  const ageMs = Number.isFinite(nowMs) && observedAt !== null ? nowMs - observedAt : Number.NaN;
  if (!Number.isFinite(ageMs) || ageMs < -60_000 || ageMs > Math.max(0, Number(maximumAgeMs) || 0)) {
    return null;
  }
  return rounded(salePrice);
}

function importErrorMessages(log) {
  const messages = [];
  for (const value of [log?.error_msg, ...(Array.isArray(log?.skus) ? log.skus.map((row) => row?.error_msg) : [])]) {
    const message = typeof value === "string" ? value : value?.message || value?.msg || value?.error;
    if (String(message || "").trim()) messages.push(String(message).trim());
  }
  return messages;
}

function importFailureReason(log) {
  const evidence = importErrorMessages(log).join(" | ");
  if (/суточн(?:ый|ого)\s+лимит|исчерпал\S*\s+суточн|daily\s+(?:product\s+)?limit/i.test(evidence)) {
    return "daily-product-limit";
  }
  if (/(?:^|\D)(?:408|425|429|5\d\d)(?:\D|$)|API\s*请求失败|request\s+failed|network|timeout|temporar|gateway|connection|ECONN(?:RESET|REFUSED)/i.test(evidence)) {
    return "import-transient-error";
  }
  return "import-failed";
}

function normalizedImportStatus(log) {
  const top = String(log?.import_status || "").toLowerCase();
  const nested = Array.isArray(log?.skus)
    ? log.skus.map((row) => String(row?.import_status || "").toLowerCase()).filter(Boolean)
    : [];
  if ([top, ...nested].some((status) => ["all_failed", "failed"].includes(status))) return "all_failed";
  if (["all_imported", "imported"].includes(top)) return top;
  if (nested.length > 0 && nested.every((status) => ["all_imported", "imported"].includes(status))) return "nested_imported";
  if ([top, ...nested].some((status) => ["pending", "processing", "unknown"].includes(status))) return "pending";
  return top;
}

function isEffectiveOnlineProduct(product) {
  return Number(product?.sku) > 0
    && String(product?.online_status || "") === "selling"
    && Number(product?.stock) > 0;
}

function hasTerminalModerationDecline(product) {
  return Array.isArray(product?.errors) && product.errors.some((error) => {
    const level = String(error?.level || "").toUpperCase();
    const state = String(error?.state || "").toLowerCase();
    const code = String(error?.code || "").toUpperCase();
    return level === "ERROR_LEVEL_ERROR" || state === "declined" || code.endsWith("_DECLINE");
  });
}

function hasTerminalStockActivationRejection(stockUpdate) {
  return (stockUpdate?.result || []).some((row) => (row?.errors || []).some((error) => (
    String(error?.code || "").toUpperCase() === "CB_DELIVERY_ONLY_FBP"
  )));
}

function hasWarehouseStatusRejection(stockUpdate) {
  return (stockUpdate?.result || []).some((row) => (row?.errors || []).some((error) => (
    String(error?.code || "").toUpperCase() === "WAREHOUSE_WRONG_STATUS"
  )));
}

function isTerminalSubmittedFailure(entry) {
  const data = entry?.data || entry || {};
  if (data.terminal === true) return true;
  const reason = String(data.reason || "");
  if (reason === "import-failed" && importFailureReason(data.import_log) === "import-transient-error") return false;
  if (["daily-product-limit", "import-failed", "reconciliation-store-not-configured", "stock-activation-terminal-rejected", "fbs-evidence-missing"].includes(reason)) return true;
  if (reason === "stock-activation-rejected"
    && hasTerminalStockActivationRejection(data?.final_result?.stock_update || data?.stock_update)) return true;
  const moderationProduct = data?.final_result?.online_product || data?.online_product;
  const targetStoreId = Number(data?.store_id);
  const evidenceStoreId = Number(moderationProduct?.shop_id);
  const evidenceBelongsToAnotherStore = targetStoreId > 0
    && evidenceStoreId > 0
    && targetStoreId !== evidenceStoreId;
  if (reason === "online-product-rejected") return !evidenceBelongsToAnotherStore;
  return !evidenceBelongsToAnotherStore && hasTerminalModerationDecline(moderationProduct);
}

function reconciliationBackoffMs(attempts) {
  const count = Math.max(1, Number(attempts) || 1);
  if (count <= 10) return Math.min(60_000, 10_000 + count * 5_000);
  return Math.min(180_000, 60_000 + (count - 10) * 30_000);
}

export function prioritizePublishCandidates(items, preflightPureSkus = new Set(), familyScores = {}, sourceScores = new Map()) {
  return [...items]
    .map((item, index) => ({
      item,
      index,
      purePreflight: preflightPureSkus.has(String(item?.sku ?? item?.id ?? "")) ? 1 : 0,
      sourcePriority: Number(sourceScores?.get?.(sourceYieldKey(item?.source_url)) || 0),
      priority: Number(familyScores[productTitleFamily(item?.title)] || 0) + productTitlePriority(item?.title),
      salePrice: Number(item?.sell_price ?? item?.price ?? item?.price_info?.sell_price) || 0,
    }))
    .sort((left, right) => right.purePreflight - left.purePreflight
      || right.sourcePriority - left.sourcePriority
      || right.priority - left.priority
      || right.salePrice - left.salePrice
      || left.index - right.index)
    .map(({ item }) => item);
}

export function prioritizeProfitCandidates(items, snapshot, storeId, options = {}) {
  return prioritizeProfitRows(items, snapshot, { ...options, storeId: Number(storeId) });
}

function interleaveCandidateBatches(primary, secondary, batchSize) {
  const width = Math.max(1, Number(batchSize) || 1);
  const result = [];
  let primaryIndex = 0;
  let secondaryIndex = 0;
  while (primaryIndex < primary.length || secondaryIndex < secondary.length) {
    result.push(...primary.slice(primaryIndex, primaryIndex + width));
    primaryIndex += width;
    result.push(...secondary.slice(secondaryIndex, secondaryIndex + width));
    secondaryIndex += width;
  }
  return result;
}

export function clearObservedPublishFeedbackCache() {
  observedPublishFeedbackCompositeCache.clear();
  clearJsonLinesFileCache();
}

export function observedPublishFeedbackCacheStats(runDir) {
  const filename = path.resolve(runDir, "source_yield.jsonl");
  return jsonLinesFileCacheStats(filename);
}

export async function loadObservedPublishFeedback(runDir, seedFiles = []) {
  const filenames = [...new Set([
    ...(Array.isArray(seedFiles) ? seedFiles : []),
    path.resolve(runDir, "source_yield.jsonl"),
  ].map((filename) => path.resolve(filename)))];
  const histories = await Promise.all(filenames.map(readJsonLinesIncremental));
  const key = filenames.join("\0");
  const cached = observedPublishFeedbackCompositeCache.get(key);
  if (cached
    && cached.histories.length === histories.length
    && cached.histories.every((history, index) => history === histories[index])) return cached.value;
  const rows = normalizeRuntimeSourceYieldRows(histories.flat());
  const value = {
    familyScores: observedTitleFamilyScores(rows),
    sourceScores: fullFunnelSourceScores(rows),
  };
  observedPublishFeedbackCompositeCache.set(key, { histories, value });
  return value;
}

function buildPayload(item, detail, economy, targetConfig, now) {
  const sku = asSku(item);
  const price = rounded(economy.price_list.sell_price);
  const title = firstContentValue(detail?.title, item?.title).value;
  const coverImage = firstContentValue(detail?.cover_image, item?.cover_image).value;
  return {
    scene: "erp",
    shop_ids: [targetConfig.store.id],
    brand: "none",
    image_order: "none",
    watermark_id: targetConfig.watermark.id,
    floating_price: null,
    rows: [{
      id: item.id ?? item.favorite_id ?? detail.id ?? detail.favorite_id,
      sku,
      title,
      cover_image: coverImage || null,
      link: detail.link ?? detail.detail_url ?? item.link ?? item.detail_url ?? canonicalProductUrl(sku),
      sell_price: price,
      price,
      old_price: rounded(price * 2),
      offer_id: offerIdForSku(sku, now()),
      brand: "",
      source: "favorite",
      source_currency: "CNY",
    }],
  };
}

function targetConfigForPersistedRoute(targetConfig, item) {
  const warehouseId = Number(item?.warehouse_id || 0);
  return warehouseId > 0 ? { ...targetConfig, warehouseId } : targetConfig;
}

function profitCalculationInput({ sku, salePrice, purchasePrice, productInfo, detail, category, profitThreshold, logistics = "CEL" }) {
  return {
    sku,
    sell_price: salePrice,
    purchase_price: purchasePrice,
    package_weight: productInfo.weight ?? detail.weight ?? 1,
    package_length: productInfo.depth ?? productInfo.length ?? detail.depth ?? detail.length ?? 20,
    package_width: productInfo.width ?? detail.width ?? 20,
    package_height: productInfo.height ?? detail.height ?? 20,
    china_fee: 0,
    ad_rate: 0,
    other_rate: 1,
    logistics,
    profit_value: profitThreshold,
    profit_type: "percentage",
    cate: category.mapped,
  };
}

export function createConcurrencyGate(limit = 1) {
  const maximum = Number(limit);
  if (!Number.isInteger(maximum) || maximum <= 0) {
    throw new TypeError("concurrency gate limit must be a positive integer");
  }
  let active = 0;
  const waiters = [];

  async function run(operation) {
    if (typeof operation !== "function") throw new TypeError("gated operation must be a function");
    if (active >= maximum) await new Promise((resolve) => waiters.push(resolve));
    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
      waiters.shift()?.();
    }
  }

  return {
    run,
    stats: () => ({ active, queued: waiters.length, limit: maximum }),
  };
}

export function createPublishRunner({
  client,
  detailProvider = client,
  costBridge,
  state,
  policy = defaultPolicy,
  target = 100,
  threshold = 30,
  now = () => new Date(),
  runDir = process.cwd(),
  storeNeedle = "丽丽1号",
  watermarkNeedle = "lysh",
  storeId = 104965,
  watermarkId = 60822,
  storeTargets = null,
  reconciliationOnly = false,
  validationOnly = false,
  validationTarget = 3,
  concurrency = 1,
  costConcurrency = concurrency,
  maxConcurrency = 12,
  dryCandidateLimit = 0,
  deadlineAt = null,
  targetConfigCache = null,
  targetRefreshIntervalMs = 60_000,
  targetMetricHeartbeatMs = 1_800_000,
  sourceYieldHistoryPath = null,
  publishFeedbackSeedFiles = [],
  candidateFactSeedFiles = [],
  importedFavoriteCleanupLimit = 0,
  confirmationAttempts = 6,
  confirmationIntervalMs = 2000,
  onlineSyncIntervalMs = 1_800_000,
  urgentOnlineSyncIntervalMs = 600_000,
  urgentOnlineSyncPendingCount = 20,
  warehouseId = null,
  initialStock = 1,
  dailyStoreLimit = 100,
  dailyStoreTimeZone = "Asia/Shanghai",
  enforceDirectDailyLimit = false,
  dailySubmissionCutoff = "23:00",
  dailyReportAfter = "23:30",
  dailyStoreUsageSeed = null,
  totalStoreLimit = 100,
  totalStoreUsageSeed = {},
  totalStoreUsageSeedIncludesRestored = false,
  warehouseSyncAttempts = 2,
  warehouseSyncIntervalMs = 5000,
  unavailableStoreRetryMs = 1_800_000,
  pendingStoreStallMs = 300_000,
  pendingStoreStallCount = 3,
  pendingStoreRetryMs = 300_000,
  probeInactiveStores = false,
  submissionGateFile = null,
  requireReliableCostContract = false,
  directMode = false,
  directRunControl = null,
  minimumSameItemMatches = 3,
  costEstimateTimeoutMs = 15_000,
  profitPriorityFile = null,
  profitFeedbackFile = null,
  seasonPriorityFile = null,
  profitFileRefreshMs = 5_000,
  profitSafetyActionPolicy = "shadow",
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!client || !costBridge || !state) throw new TypeError("client, costBridge, and state are required");
  if (!detailProvider || typeof detailProvider.getProductDetail !== "function") {
    throw new TypeError("Playwright Ozon detailProvider.getProductDetail is required");
  }
  const targetCount = Number(target);
  const profitThreshold = Number(threshold);
  const activeDirectMode = Boolean(directMode);
  const enforceDailyQuota = !activeDirectMode
    || (enforceDirectDailyLimit === true && !reconciliationOnly);
  const unlimitedTarget = activeDirectMode && targetCount === 0;
  const sharedDirectRunControl = directRunControl && typeof directRunControl === "object"
    ? directRunControl
    : null;
  const requiredSameItemMatches = Number(minimumSameItemMatches);
  const configuredCostEstimateTimeoutMs = Number(costEstimateTimeoutMs);
  const configuredProfitSafetyActionPolicy = String(profitSafetyActionPolicy || "")
    .trim()
    .toLowerCase();
  const profitFiles = createProfitFilesReader({
    priorityFile: profitPriorityFile,
    feedbackFile: profitFeedbackFile,
    seasonFile: seasonPriorityFile,
    refreshMs: Math.max(0, Number(profitFileRefreshMs) || 0),
  });
  dailyWindowState({
    now: now(),
    timeZone: dailyStoreTimeZone,
    cutoff: dailySubmissionCutoff,
    reportAfter: dailyReportAfter,
  });
  if (!Number.isInteger(targetCount) || targetCount < 0) throw new TypeError("target must be a non-negative integer");
  if (!Number.isFinite(profitThreshold)) throw new TypeError("threshold must be numeric");
  if (!Number.isInteger(requiredSameItemMatches) || requiredSameItemMatches <= 0) {
    throw new TypeError("minimumSameItemMatches must be a positive integer");
  }
  if (!(configuredCostEstimateTimeoutMs > 0)) {
    throw new TypeError("costEstimateTimeoutMs must be a positive number");
  }
  if (!["shadow", "enforce"].includes(configuredProfitSafetyActionPolicy)) {
    throw new TypeError("profitSafetyActionPolicy must be shadow or enforce");
  }
  const workerCount = Number(concurrency);
  if (!Number.isInteger(workerCount) || workerCount <= 0) throw new TypeError("concurrency must be a positive integer");
  const costWorkerCount = Number(costConcurrency);
  if (!Number.isInteger(costWorkerCount) || costWorkerCount <= 0) {
    throw new TypeError("costConcurrency must be a positive integer");
  }
  const dryLimit = Number(dryCandidateLimit);
  if (!Number.isInteger(dryLimit) || dryLimit < 0) throw new TypeError("dryCandidateLimit must be a non-negative integer");
  const validationTargetCount = Number(validationTarget);
  if (!Number.isInteger(validationTargetCount) || validationTargetCount <= 0) {
    throw new TypeError("validationTarget must be a positive integer");
  }
  let activeValidationOnly = Boolean(validationOnly);
  const verifiedWarehouseId = Number(warehouseId);
  const activationStock = Number(initialStock);
  if (warehouseId !== null && warehouseId !== undefined && !(verifiedWarehouseId > 0)) {
    throw new TypeError("warehouseId must be a positive number when configured");
  }
  if (!Number.isInteger(activationStock) || activationStock <= 0) throw new TypeError("initialStock must be a positive integer");
  const configuredDailyStoreLimit = Number(dailyStoreLimit);
  if (!Number.isInteger(configuredDailyStoreLimit) || configuredDailyStoreLimit <= 0) {
    throw new TypeError("dailyStoreLimit must be a positive integer");
  }
  const configuredTotalStoreLimit = Number(totalStoreLimit);
  if (!Number.isInteger(configuredTotalStoreLimit) || configuredTotalStoreLimit <= 0) {
    throw new TypeError("totalStoreLimit must be a positive integer");
  }
  const targetPlan = Array.isArray(storeTargets) && storeTargets.length > 0
    ? storeTargets.map((entry) => ({
      id: Number(entry?.id),
      needle: String(entry?.needle || entry?.name || "").trim(),
      warehouseId: entry?.warehouseId === null || entry?.warehouseId === undefined ? null : Number(entry.warehouseId),
      uralWarehouseId: entry?.uralWarehouseId === null || entry?.uralWarehouseId === undefined ? null : Number(entry.uralWarehouseId),
      weightThresholdGrams: Number(entry?.weightThresholdGrams ?? 500),
      weightRouting: entry?.weightRouting === true,
      requireWarehouse: entry?.requireWarehouse !== false,
    }))
    : [{
      id: Number(storeId),
      needle: String(storeNeedle),
      warehouseId: warehouseId == null ? null : Number(warehouseId),
      uralWarehouseId: null,
      weightThresholdGrams: 500,
      weightRouting: false,
      requireWarehouse: false,
    }];
  for (const entry of targetPlan) {
    if (!(entry.id > 0) || !entry.needle) throw new TypeError("each store target requires a positive id and needle");
    if (entry.warehouseId !== null && !(entry.warehouseId > 0)) throw new TypeError("store target warehouseId must be positive when configured");
    if (entry.uralWarehouseId !== null && !(entry.uralWarehouseId > 0)) throw new TypeError("store target uralWarehouseId must be positive when configured");
    if (!(entry.weightThresholdGrams > 0)) throw new TypeError("store target weightThresholdGrams must be positive");
    if (entry.weightRouting && entry.uralWarehouseId === null) throw new TypeError("weight-routed store target requires uralWarehouseId");
  }
  let cnyRubRate = 10.4672;
  let cnyRubRateConfirmed = false;
  let publishChain = Promise.resolve();
  let metricsChain = Promise.resolve();
  let haltReason = null;
  let directAcceptedCount = () => 0;
  let markDirectAccepted = () => {};
  let directActiveStoreId = () => 0;
  let activeTargetIndex = 0;
  const storeSwitches = [];
  let directRejectedStoreIds = new Set();
  let directRejectedStoreReasons = new Map();
  if (activeDirectMode && sharedDirectRunControl) {
    if (!(sharedDirectRunControl.rejectedStoreIds instanceof Set)) {
      sharedDirectRunControl.rejectedStoreIds = new Set(
        Array.isArray(sharedDirectRunControl.rejectedStoreIds)
          ? sharedDirectRunControl.rejectedStoreIds.map(Number).filter((id) => id > 0)
          : [],
      );
    }
    if (!(sharedDirectRunControl.rejectionReasons instanceof Map)) {
      sharedDirectRunControl.rejectionReasons = new Map(
        sharedDirectRunControl.rejectionReasons
          && typeof sharedDirectRunControl.rejectionReasons === "object"
          ? Object.entries(sharedDirectRunControl.rejectionReasons)
            .map(([id, reason]) => [Number(id), String(reason || "")])
            .filter(([id, reason]) => id > 0 && reason)
          : [],
      );
    }
    directRejectedStoreIds = sharedDirectRunControl.rejectedStoreIds;
    directRejectedStoreReasons = sharedDirectRunControl.rejectionReasons;
    sharedDirectRunControl.storeSwitchChain ||= Promise.resolve();
  }
  const storeDailyUsage = new Map();
  const storeDailyLimits = new Map();
  const storeTotalUsage = new Map();
  const storeTotalReservations = new Set();
  let storeUsageDay = null;
  const lastOnlineSyncAt = new Map();
  const lastOnlineSyncPendingCount = new Map();
  const onlineSyncBlockedUntil = new Map();
  const unavailableStoreUntil = new Map();
  const lastStoreSwitchDiagnosticAt = new Map();
  const lastStoreTargetMetrics = new Map();
  const selectedTitleOwners = new Map();
  let lastAllStoresStalledAt = 0;
  const adaptive = new AdaptiveConcurrency({
    initial: workerCount,
    max: activeDirectMode
      ? workerCount
      : Math.max(workerCount, Number(maxConcurrency) || workerCount),
  });
  // The 1688 pool can intentionally be smaller than the surrounding publish
  // pipeline. Acquire a real cost-worker slot before starting the per-item
  // hard deadline so queue wait cannot consume the query budget.
  const costGate = costWorkerCount >= workerCount
    ? { run: (operation) => operation() }
    : createConcurrencyGate(costWorkerCount);

  function cancelDirectRun(error, batchControl = null) {
    for (const control of new Set([batchControl, sharedDirectRunControl].filter(Boolean))) {
      control.cancelled = true;
      control.fatalError ||= error;
    }
  }

  async function activeSubmissionGate() {
    if (activeDirectMode) return { phase: "released", allowed_skus: null };
    const filename = String(submissionGateFile || "").trim();
    if (!filename) return { phase: "released", allowed_skus: null };
    let document;
    try {
      document = JSON.parse(await fs.readFile(path.resolve(filename), "utf8"));
    } catch (error) {
      const blocked = new Error(`production submission gate unavailable: ${error?.message || error}`);
      blocked.code = "SUBMISSION_GATE_UNAVAILABLE";
      throw blocked;
    }
    return submissionGatePolicy(document);
  }

  function reserveSelectedTitle(title, sku, storeId) {
    const titleKey = duplicateTitleKey(title);
    const normalizedStoreId = Number(storeId);
    if (!titleKey || !sku || !(normalizedStoreId > 0)) return;
    const owners = selectedTitleOwners.get(titleKey) || new Map();
    if (!owners.has(normalizedStoreId)) owners.set(normalizedStoreId, String(sku));
    selectedTitleOwners.set(titleKey, owners);
  }

  function crossStoreDuplicateOwner(title, sku, storeId) {
    const titleKey = duplicateTitleKey(title);
    const normalizedStoreId = Number(storeId);
    const owners = titleKey ? selectedTitleOwners.get(titleKey) : null;
    if (!owners || !(normalizedStoreId > 0) || owners.has(normalizedStoreId)) return null;
    const owner = [...owners].find(([, ownerSku]) => ownerSku !== String(sku));
    return owner ? { storeId: owner[0], sku: owner[1] } : null;
  }

  function recordMetric(filename, row) {
    metricsChain = metricsChain.then(async () => {
      const event = { at: now().toISOString(), ...row };
      await fs.mkdir(runDir, { recursive: true });
      await fs.appendFile(path.join(runDir, filename), `${JSON.stringify(event)}\n`);
      if (filename === "source_yield.jsonl" && sourceYieldHistoryPath && event.source_url && event.status !== "ignored") {
        await fs.mkdir(path.dirname(sourceYieldHistoryPath), { recursive: true });
        await fs.appendFile(sourceYieldHistoryPath, `${JSON.stringify(event)}\n`);
      }
    });
  }

  function directStoreFreezeReason(storeId) {
    const normalizedStoreId = Number(storeId || 0);
    if (!activeDirectMode || !(normalizedStoreId > 0) || !directRejectedStoreIds.has(normalizedStoreId)) {
      return null;
    }
    return String(directRejectedStoreReasons.get(normalizedStoreId) || "daily-product-limit");
  }

  function freezeDirectStore(storeId, reason, evidence = {}, { record = true } = {}) {
    const normalizedStoreId = Number(storeId || 0);
    const normalizedReason = String(reason || "store-unavailable");
    if (!activeDirectMode || !(normalizedStoreId > 0)) return false;
    const firstSignal = !directRejectedStoreIds.has(normalizedStoreId);
    directRejectedStoreIds.add(normalizedStoreId);
    directRejectedStoreReasons.set(normalizedStoreId, normalizedReason);
    if (sharedDirectRunControl) {
      sharedDirectRunControl.storeSwitchReason = normalizedReason;
      sharedDirectRunControl.storeSwitchRequestedAt = now().toISOString();
    }
    if (firstSignal && record) {
      recordMetric("store_rejections.jsonl", {
        store_id: normalizedStoreId,
        reason: normalizedReason,
        ...evidence,
      });
    }
    return firstSignal;
  }

  async function recordCurrentStore(targetConfig, reason = "active") {
    if (activeDirectMode && reconciliationOnly) return false;
    const write = metricsChain.then(async () => {
      const filename = path.join(runDir, "current_store.json");
      const value = {
        at: now().toISOString(),
        store_id: Number(targetConfig?.store?.id || 0),
        store_name: String(targetConfig?.store?.name || targetConfig?.store?.title || "").trim() || null,
        warehouse_id: Number(targetConfig?.warehouseId || 0) || null,
        reason,
      };
      await fs.mkdir(runDir, { recursive: true });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        currentStoreWriteSequence += 1;
        const temp = `${filename}.${process.pid}.${currentStoreWriteSequence}.${attempt}.tmp`;
        try {
          await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
          await fs.rename(temp, filename);
          return;
        } catch (error) {
          await fs.unlink(temp).catch(() => {});
          if (error?.code !== "ENOENT" || attempt > 0) throw error;
        }
      }
    });
    metricsChain = write;
    await write;
    return true;
  }

  function recordStoreTargetMetric(row) {
    const key = String(Number(row?.store_id || 0));
    const signature = JSON.stringify(row);
    const currentTime = now().getTime();
    const previous = lastStoreTargetMetrics.get(key);
    const heartbeat = Math.max(0, Number(targetMetricHeartbeatMs) || 0);
    if (previous?.signature === signature && heartbeat > 0 && currentTime - previous.at < heartbeat) return false;
    lastStoreTargetMetrics.set(key, { signature, at: currentTime });
    recordMetric("store_targets.jsonl", row);
    return true;
  }

  async function timed(sku, stage, operation) {
    const started = Date.now();
    try {
      const value = await operation();
      recordMetric("stage_timings.jsonl", { sku, stage, duration_ms: Date.now() - started, ok: true });
      return value;
    } catch (error) {
      recordMetric("stage_timings.jsonl", { sku, stage, duration_ms: Date.now() - started, ok: false, error: String(error?.message || error) });
      throw error;
    }
  }

  async function boundedCostEstimate(operation) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({
        ok: false,
        reason: `1688 end-to-end budget exceeded after ${configuredCostEstimateTimeoutMs}ms`,
        error: {
          code: "1688-total-timeout",
          message: `1688 end-to-end budget exceeded after ${configuredCostEstimateTimeoutMs}ms`,
        },
      }), configuredCostEstimateTimeoutMs);
    });
    return Promise.race([Promise.resolve().then(operation), timeout])
      .finally(() => clearTimeout(timer));
  }

  async function confirmPublication(sku, payload, targetConfig, { attempts: attemptOverride = null } = {}) {
    const offerId = payload.rows[0].offer_id;
    const attempts = Math.max(1, Number(attemptOverride ?? confirmationAttempts) || 1);
    let lastImportLog = null;
    let lastOnlineProduct = null;
    let lastStockUpdate = null;
    const stockAttempts = new Set();
    const targetWarehouseId = Number(targetConfig.warehouseId || 0);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const importLog = await client.findImportLog({ shopId: targetConfig.store.id, sku, offerId });
      lastImportLog = importLog || lastImportLog;
      const status = normalizedImportStatus(importLog);
      if (["all_failed", "failed"].includes(status)) {
        const reason = importFailureReason(importLog);
        if (reason !== "import-transient-error") {
          return { ok: false, reason, import_log: importLog };
        }
      }
      if (["all_imported", "imported", "nested_imported"].includes(status)) {
        const confirmedOfferId = String(importLog?.offer_id || offerId);
        const onlineProduct = await client.findOnlineProduct({ shopId: targetConfig.store.id, offerId: confirmedOfferId });
        lastOnlineProduct = onlineProduct || lastOnlineProduct;
        if (isEffectiveOnlineProduct(onlineProduct)) return { ok: true, import_log: importLog, online_product: onlineProduct };
        if (hasTerminalModerationDecline(onlineProduct)) {
          return { ok: false, reason: "online-product-rejected", import_log: importLog, online_product: onlineProduct };
        }
        const stockAttemptKey = String(onlineProduct?.id || confirmedOfferId);
        if (targetWarehouseId > 0
          && Number(onlineProduct?.sku) > 0
          && String(onlineProduct?.online_status || "") === "ready_to_sell"
          && Number(onlineProduct?.stock) <= 0
          && !stockAttempts.has(stockAttemptKey)) {
          stockAttempts.add(stockAttemptKey);
          try {
            lastStockUpdate = await client.updateProductStock({
              shopId: targetConfig.store.id,
              product: onlineProduct,
              warehouseId: targetWarehouseId,
              stock: activationStock,
            });
          } catch (error) {
            return {
              ok: false,
              reason: "stock-activation-failed",
              import_log: importLog,
              online_product: onlineProduct,
              error: String(error?.message || error),
            };
          }
          const updated = Array.isArray(lastStockUpdate?.result)
            && lastStockUpdate.result.some((row) => row?.updated === true && (!Array.isArray(row?.errors) || row.errors.length === 0));
          if (!updated) {
            return {
              ok: false,
              reason: hasTerminalStockActivationRejection(lastStockUpdate)
                ? "stock-activation-terminal-rejected"
                : "stock-activation-rejected",
              import_log: importLog,
              online_product: onlineProduct,
              stock_update: lastStockUpdate,
            };
          }
        }
      }
      if (attempt + 1 < attempts && Number(confirmationIntervalMs) > 0) await sleep(Number(confirmationIntervalMs));
    }
    if (lastOnlineProduct) {
      return {
        ok: false,
        reason: "online-product-not-selling",
        import_log: lastImportLog,
        online_product: lastOnlineProduct,
        stock_update: lastStockUpdate,
      };
    }
    if (lastImportLog && importFailureReason(lastImportLog) === "import-transient-error") {
      return { ok: false, reason: "import-transient-error", import_log: lastImportLog };
    }
    return { ok: false, reason: "publish-final-status-timeout" };
  }

  async function maybeSyncOnlineShop(targetConfig, { pendingCount = 0 } = {}) {
    if (typeof client.syncOnlineShops !== "function") return;
    const activeStoreId = Number(targetConfig.store.id);
    const currentTime = now().getTime();
    const lastSync = Number(lastOnlineSyncAt.get(activeStoreId) || 0);
    const normalizedPendingCount = Math.max(0, Number(pendingCount) || 0);
    const hasPreviousPendingCount = lastOnlineSyncPendingCount.has(activeStoreId);
    const previousPendingCount = Math.max(0, Number(lastOnlineSyncPendingCount.get(activeStoreId)) || 0);
    const urgent = normalizedPendingCount >= Math.max(1, Number(urgentOnlineSyncPendingCount) || 1)
      || (normalizedPendingCount > 0 && previousPendingCount > 0);
    const normalCooldownMs = Math.max(0, Number(onlineSyncIntervalMs) || 0);
    const configuredUrgentCooldownMs = Math.max(0, Number(urgentOnlineSyncIntervalMs) || 0);
    const cooldownMs = urgent
      ? Math.max(
        MIN_URGENT_ONLINE_SYNC_INTERVAL_MS,
        Math.min(normalCooldownMs, configuredUrgentCooldownMs),
      )
      : normalCooldownMs;
    const firstNonEmptyAfterEmpty = normalizedPendingCount > 0
      && hasPreviousPendingCount
      && previousPendingCount === 0;
    const blockedUntil = Number(onlineSyncBlockedUntil.get(activeStoreId) || 0);
    if (blockedUntil > currentTime) {
      lastOnlineSyncPendingCount.set(activeStoreId, normalizedPendingCount);
      return;
    }
    if (blockedUntil > 0) onlineSyncBlockedUntil.delete(activeStoreId);
    if (!(firstNonEmptyAfterEmpty && !urgent) && currentTime - lastSync < cooldownMs) return;
    lastOnlineSyncAt.set(activeStoreId, currentTime);
    lastOnlineSyncPendingCount.set(activeStoreId, normalizedPendingCount);
    try {
      const syncResult = await client.syncOnlineShops([activeStoreId], "all");
      onlineSyncBlockedUntil.delete(activeStoreId);
      recordMetric("store_syncs.jsonl", {
        store_id: activeStoreId,
        kind: "online-products",
        ok: true,
        pending_count: normalizedPendingCount,
        cooldown_ms: cooldownMs,
        urgent,
        result: syncResult ?? null,
      });
    } catch (error) {
      const retryAfterMs = onlineSyncRetryAfterMs(error, { nowMs: currentTime });
      const blockedForMs = retryAfterMs === null
        ? 0
        : Math.max(cooldownMs, retryAfterMs);
      const nextBlockedUntil = blockedForMs > 0
        ? currentTime + boundedBackoffMs(blockedForMs)
        : 0;
      if (nextBlockedUntil > 0) {
        onlineSyncBlockedUntil.set(
          activeStoreId,
          Math.max(Number(onlineSyncBlockedUntil.get(activeStoreId) || 0), nextBlockedUntil),
        );
      }
      recordMetric("store_syncs.jsonl", {
        store_id: activeStoreId,
        kind: "online-products",
        ok: false,
        pending_count: normalizedPendingCount,
        cooldown_ms: cooldownMs,
        urgent,
        error: String(error?.message || error),
        ...(retryAfterMs === null ? {} : {
          retry_after_ms: retryAfterMs,
          blocked_until: new Date(nextBlockedUntil).toISOString(),
        }),
      });
    }
  }

  async function persistAcceptedSubmission(sku, submissionState, publishResult, targetConfig) {
    const acceptedAt = now().toISOString();
    const acceptedState = {
      ...submissionState,
      reason: "submission-accepted",
      submission_intent: false,
      submitted: true,
      submission_pending: false,
      submitted_at: acceptedAt,
      api_call_accepted_at: acceptedAt,
      api_call_completed_at: acceptedAt,
      publish_result: publishResult ?? null,
    };
    const recorded = await state.transition(sku, "processing", acceptedState);
    if (recorded === false) {
      const error = new Error(`accepted submission state could not be persisted for SKU ${sku}`);
      error.code = "SUBMISSION_ACCEPTANCE_PERSIST_FAILED";
      error.sku = sku;
      throw error;
    }
    if (activeDirectMode) markDirectAccepted(sku);

    const submittedStoreId = Number(targetConfig.store.id);
    storeDailyUsage.set(submittedStoreId, Number(storeDailyUsage.get(submittedStoreId) || 0) + 1);
    const reservationKey = `${submittedStoreId}:${sku}`;
    if (!storeTotalReservations.has(reservationKey)) {
      storeTotalReservations.add(reservationKey);
      storeTotalUsage.set(submittedStoreId, Number(storeTotalUsage.get(submittedStoreId) || 0) + 1);
    }
    recordMetric("store_daily_usage.jsonl", {
      store_id: submittedStoreId,
      sku,
      usage: storeDailyUsage.get(submittedStoreId),
      limit: storeDailyLimits.get(submittedStoreId) || configuredDailyStoreLimit,
      event: "submission-accepted",
    });
    recordMetric("store_total_usage.jsonl", {
      store_id: submittedStoreId,
      sku,
      usage: storeTotalUsage.get(submittedStoreId),
      limit: configuredTotalStoreLimit,
      event: "submission-reserved",
    });
    return acceptedState;
  }

  async function publishSerial(sku, payload, targetConfig, submissionState, batchControl = null) {
    const submission = publishChain.then(async () => {
      const intendedStoreId = Number(targetConfig?.store?.id || 0);
      const frozenStoreReason = directStoreFreezeReason(intendedStoreId);
      if (frozenStoreReason) {
        if (intendedStoreId === Number(directActiveStoreId() || 0)) haltReason = frozenStoreReason;
        return { ok: false, reason: frozenStoreReason, not_submitted: true };
      }
      if (haltReason) return { ok: false, reason: haltReason, not_submitted: true };
      if (batchControl?.cancelled || sharedDirectRunControl?.cancelled) {
        return { ok: false, reason: "batch-fatal-cancelled", not_submitted: true };
      }
      if (activeDirectMode) {
        if (!unlimitedTarget && directAcceptedCount() >= targetCount) {
          return { ok: false, reason: "target-already-reached", not_submitted: true };
        }
        const activeStoreId = Number(directActiveStoreId() || 0);
        if (activeStoreId > 0 && Number(targetConfig?.store?.id || 0) !== activeStoreId) {
          return { ok: false, reason: "publish-target-changed", not_submitted: true };
        }
        const currentEntry = typeof state.entryOf === "function" ? state.entryOf(sku) : null;
        const currentData = currentEntry?.data || {};
        if (currentEntry?.status === "published"
          || currentData.submitted === true
          || currentData.submission_pending === true) {
          return { ok: false, reason: "submission-already-recorded", not_submitted: true };
        }
        if (currentData.reconcile_only === true && currentData.previous_api_call_started_at) {
          return { ok: false, reason: "submission-api-status-unknown", not_submitted: true };
        }
        if (submissionState?.api_call_started_at
          && currentData.api_call_started_at
          && currentData.api_call_started_at !== submissionState.api_call_started_at) {
          return { ok: false, reason: "submission-api-call-reservation-lost", not_submitted: true };
        }
      }
      let publishResult;
      try {
        publishResult = await client.publish(payload);
      } catch (error) {
        if (!activeDirectMode || isFatalRunnerError(error)) {
          if (isFatalRunnerError(error)) cancelDirectRun(error, batchControl);
          throw error;
        }
        return {
          ok: false,
          reason: "submission-api-status-unknown",
          error: String(error?.message || error),
          uncertain: true,
        };
      }
      if (!publishResult?.ok) {
        const publishEvidence = [
          publishResult?.reason,
          publishResult?.response?.message,
          publishResult?.response?.msg,
          publishResult?.response?.error,
        ].filter(Boolean).join(" ");
        const publishStatus = Number(
          publishResult?.status
          ?? publishResult?.statusCode
          ?? publishResult?.response?.status
          ?? publishResult?.response?.statusCode,
        );
        const authenticationError = Object.assign(
          new Error(
            `Maozi publish request failed: ${publishEvidence || (Number.isFinite(publishStatus) ? `HTTP ${publishStatus}` : "unknown response")}`,
          ),
          Number.isFinite(publishStatus) ? { status: publishStatus } : {},
        );
        if (activeDirectMode && isFatalAuthenticationError(authenticationError)) {
          cancelDirectRun(authenticationError, batchControl);
          throw authenticationError;
        }
        const directFailureReason = /суточн(?:ый|ого)\s+лимит|daily\s+(?:product\s+)?limit/iu.test(publishEvidence)
          ? "daily-product-limit"
          : /магазин|store|shop/iu.test(publishEvidence)
            && /недоступ|отключ|disabled|unavailable|inactive/iu.test(publishEvidence)
            ? "store-unavailable"
            : null;
        const storeRejectionDay = directFailureReason
          ? String(
            submissionState?.api_call_day
              || localDateKey(submissionState?.api_call_started_at, dailyStoreTimeZone)
              || localDateKey(now(), dailyStoreTimeZone)
              || "",
          )
          : null;
        if (activeDirectMode && directFailureReason) {
          const rejectedStoreId = Number(targetConfig?.store?.id || 0);
          const rejectionEvidence = {
            sku,
            source: "publish-response",
            quota_day: storeRejectionDay,
          };
          if (storeRejectionDay === localDateKey(now(), dailyStoreTimeZone)) {
            freezeDirectStore(rejectedStoreId, directFailureReason, rejectionEvidence);
            haltReason = directFailureReason;
          } else {
            recordMetric("store_rejections.jsonl", {
              store_id: rejectedStoreId,
              reason: directFailureReason,
              ...rejectionEvidence,
            });
          }
        }
        return {
          ok: false,
          reason: directFailureReason || publishResult?.reason || "publish-not-confirmed",
          publish_result: publishResult ?? null,
          ...(storeRejectionDay ? { store_rejection_day: storeRejectionDay } : {}),
          ...(activeDirectMode && !directFailureReason
            ? { uncertain: true }
            : { not_submitted: true }),
        };
      }
      const acceptedState = await persistAcceptedSubmission(
        sku,
        submissionState,
        publishResult,
        targetConfig,
      );
      return { ok: true, publish_result: publishResult, accepted_state: acceptedState };
    });
    publishChain = submission.catch(() => {});
    const accepted = await submission;
    if (!accepted?.ok) return accepted;
    if (activeDirectMode) {
      return {
        ok: true,
        accepted: true,
        reason: "erp-submission-accepted",
        publish_result: accepted.publish_result,
        accepted_state: accepted.accepted_state,
      };
    }
    await maybeSyncOnlineShop(targetConfig, { pendingCount: 1 });
    const confirmation = await confirmPublication(sku, payload, targetConfig);
    if (confirmation.reason === "daily-product-limit") haltReason = confirmation.reason;
    return {
      ...confirmation,
      publish_result: accepted.publish_result,
      accepted_state: accepted.accepted_state,
    };
  }

  async function completeSkipIntent(item, reason, data = {}, { intentRecorded = false } = {}) {
    const sku = asSku(item);
    if (activeValidationOnly) {
      recordMetric("validation_gate.jsonl", {
        sku,
        status: "rejected",
        reason,
        ...data,
      });
      return { status: "skipped", sku, source_url: item.source_url ?? null, reason };
    }
    const skipReason = String(reason || item?.skip_reason || item?.reason || "policy-skipped");
    const intentState = {
      ...item,
      ...data,
      reason: skipReason,
      skip_reason: skipReason,
      skip_intent: true,
      favorite_deleted: false,
      skip_intent_at: item?.skip_intent_at || now().toISOString(),
    };
    if (!intentRecorded) {
      const recorded = await state.transition(sku, "processing", intentState);
      if (recorded === false) {
        return {
          status: "ignored",
          sku,
          source_url: item.source_url ?? null,
          reason: "skip-intent-not-recorded",
        };
      }
    }
    try {
      await client.deleteFavorite(item);
    } catch (error) {
      if (isFatalRunnerError(error)) {
        cancelDirectRun(error);
        throw error;
      }
      await state.transition(sku, "failed", {
        ...intentState,
        reason: "favorite-delete-failed",
        skip_reason: skipReason,
        skip_intent: true,
        error: String(error?.message || error),
      });
      return { status: "failed", sku, source_url: item.source_url ?? null, reason: "favorite-delete-failed" };
    }
    const closed = await state.transition(sku, "skipped", {
      ...intentState,
      reason: skipReason,
      skip_reason: skipReason,
      skip_intent: false,
      favorite_deleted: true,
      favorite_deleted_at: now().toISOString(),
    });
    return closed === false
      ? { status: "ignored", sku, source_url: item.source_url ?? null, reason: "skip-close-not-recorded" }
      : { status: "skipped", sku, source_url: item.source_url ?? null, reason: skipReason };
  }

  async function skip(item, reason, data = {}) {
    return completeSkipIntent(item, reason, data);
  }

  async function attemptBlock(sku) {
    if (typeof state.canAttempt !== "function") return null;
    const decision = await state.canAttempt(sku, { at: now().toISOString() });
    if (!decision || decision.allowed !== false) return null;
    return {
      status: "ignored",
      sku,
      reason: String(decision.reason || "state-attempt-not-allowed"),
      ...(decision.nextEligibleAt ? { retry_at: decision.nextEligibleAt } : {}),
    };
  }

  async function contentQualityFailure(item, sku, quality) {
    if (quality.ok) return null;
    if (["category-data-missing", "category-mapping-unavailable"].includes(quality.reason)) {
      const retry = boundedTransientFailure({
        reason: quality.reason,
        now: now(),
        previousAttempts: activeValidationOnly ? 0 : item?.transient_attempts,
        previousDay: activeValidationOnly ? null : item?.retry_day,
        backoffMs: 300_000,
      });
      if (!activeValidationOnly) {
        await state.transition(sku, "failed", {
          ...item,
          ...retry,
          submitted: false,
          submission_pending: false,
          quality_gate_passed: false,
          quality_checks: quality.checks,
          quality_evidence: quality.evidence,
        });
      }
      return {
        status: retry.terminal ? "failed" : "deferred",
        sku,
        source_url: item.source_url ?? null,
        reason: retry.reason,
        retry_at: retry.retry_at,
      };
    }
    return skip(item, quality.reason, {
      outcome_status: activeDirectMode ? "rejected" : undefined,
      quality_gate_passed: false,
      quality_checks: quality.checks,
      quality_evidence: quality.evidence,
    });
  }

  async function finalizePublicationAttempt({
    item,
    submissionState,
    payload,
    finalResult,
  }) {
    const sku = asSku(submissionState);
    const acceptedState = finalResult?.accepted_state || null;
    if (activeDirectMode && finalResult?.ok && acceptedState?.submitted === true) {
      const acceptedAt = acceptedState.api_call_completed_at
        || acceptedState.submitted_at
        || now().toISOString();
      const recorded = await state.transition(sku, "processing", {
        ...submissionState,
        ...acceptedState,
        reason: "erp-submission-accepted",
        submission_intent: false,
        submitted: true,
        submission_pending: false,
        reconcile_only: true,
        accepted_at: acceptedAt,
        next_reconcile_at: new Date(now().getTime() + 10_000).toISOString(),
        background_status: {
          imported: false,
          online: false,
          stock_updated: false,
          rejected: false,
        },
        outcome_status: "submitted",
        final_result: finalResult ?? null,
      });
      if (recorded !== false) {
        recordMetric("direct_funnel.jsonl", {
          sku,
          stage: "erp_accepted",
          source_url: submissionState.source_url ?? submissionState.seller_url ?? null,
          store_id: Number(submissionState.store_id),
          outcome_status: "submitted",
        });
        recordMetric("erp_accepted.jsonl", {
          sku,
          store_id: Number(submissionState.store_id),
          accepted_at: acceptedAt,
          offer_id: submissionState.offer_id,
        });
      }
      return recorded === false
        ? {
          status: "ignored",
          sku,
          source_url: item?.source_url ?? submissionState.source_url ?? null,
          reason: "submission-acceptance-already-recorded",
        }
        : {
          status: "submitted",
          accepted: true,
          sku,
          source_url: item?.source_url ?? submissionState.source_url ?? null,
          reason: "erp-submission-accepted",
        };
    }
    if (activeDirectMode && finalResult?.not_submitted === true) {
      const reason = finalResult?.reason || "submission-not-sent";
      if (["submission-already-recorded", "submission-api-call-reservation-lost"].includes(reason)) {
        return {
          status: "ignored",
          sku,
          source_url: item?.source_url ?? submissionState.source_url ?? null,
          reason,
        };
      }
      const retryAt = now().toISOString();
      await state.transition(sku, "failed", {
        ...submissionState,
        reason: "submission-not-sent-deferred",
        original_reason: reason,
        submission_intent: false,
        submitted: false,
        submission_pending: false,
        api_call_started_at: null,
        api_call_completed_at: retryAt,
        ...(finalResult?.store_rejection_day
          ? { store_rejection_day: finalResult.store_rejection_day }
          : {}),
        retry_at: retryAt,
        terminal: false,
        final_result: finalResult ?? null,
      });
      return {
        status: "deferred",
        sku,
        source_url: item?.source_url ?? submissionState.source_url ?? null,
        reason: "submission-not-sent-deferred",
        retry_at: retryAt,
      };
    }
    if (activeDirectMode && finalResult?.uncertain === true) {
      const nextReconcileAt = new Date(now().getTime() + 30_000).toISOString();
      await state.transition(sku, "processing", {
        ...submissionState,
        reason: "submission-api-status-unknown",
        submission_intent: true,
        submitted: false,
        submission_pending: false,
        reconcile_only: true,
        next_reconcile_at: nextReconcileAt,
        final_result: finalResult ?? null,
      });
      return {
        status: "ignored",
        sku,
        source_url: item?.source_url ?? submissionState.source_url ?? null,
        reason: "submission-api-status-unknown",
        retry_at: nextReconcileAt,
      };
    }
    if (!finalResult?.ok) {
      const reason = finalResult?.reason || "publish-not-confirmed";
      const submitted = acceptedState?.submitted === true;
      const retryablePending = submitted && [
        "publish-final-status-timeout",
        "import-transient-error",
        "online-product-not-selling",
        "stock-activation-failed",
        "stock-activation-rejected",
      ].includes(reason);
      const completedAt = now().toISOString();
      await state.transition(sku, retryablePending ? "processing" : "failed", {
        ...submissionState,
        ...(acceptedState || {}),
        reason,
        submission_intent: false,
        submitted,
        submission_pending: false,
        api_call_completed_at: acceptedState?.api_call_completed_at || completedAt,
        final_result: finalResult ?? null,
        ...(retryablePending ? {
          reconcile_attempts: 0,
          next_reconcile_at: new Date(now().getTime() + 10_000).toISOString(),
        } : {}),
      });
      if (!retryablePending && submitted) {
        const reservationKey = `${Number(submissionState.store_id)}:${sku}`;
        if (storeTotalReservations.delete(reservationKey)) {
          storeTotalUsage.set(
            Number(submissionState.store_id),
            Math.max(0, Number(storeTotalUsage.get(Number(submissionState.store_id)) || 0) - 1),
          );
        }
      }
      return {
        status: retryablePending ? "submitted" : "failed",
        sku,
        source_url: item?.source_url ?? submissionState.source_url ?? null,
        reason,
      };
    }

    const onlineProduct = finalResult.online_product;
    const recorded = await state.recordPublished({
      ...submissionState,
      ...(acceptedState || {}),
      sku,
      link: payload.rows[0].link,
      offer_id: finalResult.import_log?.offer_id || payload.rows[0].offer_id,
      store_sku: onlineProduct.sku,
      product_id: onlineProduct.product_id,
      product_record_id: onlineProduct.id,
      online_status: onlineProduct.online_status,
      stock: onlineProduct.stock,
      import_status: normalizedImportStatus(finalResult.import_log),
      submission_intent: false,
      submitted: true,
      submission_pending: false,
      mode: "FBS",
      shipping_mode: "FBS",
      preflight_mode: "FBS",
      quality_gate_passed: true,
      published_at: now().toISOString(),
    });
    if (recorded === false) {
      return {
        status: "ignored",
        sku,
        source_url: item?.source_url ?? submissionState.source_url ?? null,
        reason: "publication-already-recorded",
      };
    }
    return {
      status: "published",
      sku,
      source_url: item?.source_url ?? submissionState.source_url ?? null,
      payload,
      finalResult,
      source_yield_evidence: strictSourceYieldEvidence({
        onlineProduct,
        profitRate: submissionState.profit_rate,
        shippingMode: "FBS",
        productUrl: submissionState.detail_url
          || submissionState.link
          || submissionState.href
          || canonicalProductUrl(sku),
      }),
    };
  }

  async function processItem(item, targetConfig, batchControl = null, {
    eligibilityChecked = false,
  } = {}) {
    const sku = asSku(item);
    try {
      if (!eligibilityChecked) {
        const blocked = await attemptBlock(sku);
        if (blocked) return { ...blocked, source_url: item.source_url ?? null };
      }
      if (batchControl?.cancelled) {
        return { status: "ignored", sku, source_url: item.source_url ?? null, reason: "batch-fatal-cancelled" };
      }
      if (!activeValidationOnly) {
        const started = await state.transition(sku, "processing", {
          ...item,
          reason: "processing-started",
          started_at: now().toISOString(),
        });
        if (started === false) {
          return {
            status: "ignored",
            sku,
            source_url: item.source_url ?? null,
            reason: "processing-reservation-not-acquired",
          };
        }
      }
      let detailResult = null;
      let confirmationResult = null;
      let categoryData = null;
      let firstDetail = null;
      let detail = null;
      let salePrice = null;
      let productInfo = {};
      let category = null;
      let contentQuality = null;
      let observedMode = null;
      let fbsEvidence = null;
      let shippingRoute = null;
      const applyShippingRoute = () => {
        if (shippingRoute) return shippingRoute;
        const weightGrams = productWeightGrams(productInfo, detail || item);
        if (targetConfig.weightRouting !== true) {
          shippingRoute = {
            available: true,
            route: "postal",
            logistics: "CEL",
            warehouseId: Number(targetConfig.warehouseId || 0) || null,
            weightGrams,
            thresholdGrams: Number(targetConfig.weightThresholdGrams || 500),
          };
          return shippingRoute;
        }
        shippingRoute = selectShippingRoute({
          weightGrams,
          postalWarehouseId: targetConfig.postalWarehouseId || targetConfig.warehouseId,
          uralWarehouseId: targetConfig.uralWarehouseId,
          thresholdGrams: targetConfig.weightThresholdGrams,
          weightRouting: true,
        });
        if (!shippingRoute.available) {
          const error = new Error(`Ural warehouse is unavailable for store ${targetConfig?.store?.id || "unknown"}`);
          error.code = "URAL_WAREHOUSE_UNAVAILABLE";
          throw error;
        }
        targetConfig = { ...targetConfig, warehouseId: shippingRoute.warehouseId };
        return shippingRoute;
      };

      if (activeDirectMode) {
        const snapshotTitle = normalizedContentText(item?.title);
        const snapshotImage = normalizedContentText(item?.cover_image);
        if (!snapshotTitle) return skip(item, "missing-title", { outcome_status: "rejected" });
        if (!/[\p{L}\p{N}]/u.test(snapshotTitle)) {
          return skip(item, "invalid-title", { outcome_status: "rejected" });
        }
        if (!snapshotImage) return skip(item, "missing-cover-image", { outcome_status: "rejected" });
        if (!validHttpImageUrl(snapshotImage)) {
          return skip(item, "invalid-cover-image-url", { outcome_status: "rejected" });
        }
        salePrice = policy.selectSalePrice(item);
        if (!(Number(salePrice) > 0)) {
          return skip(item, "missing-snapshot-sale-price", { outcome_status: "rejected" });
        }
        recordMetric("direct_funnel.jsonl", {
          sku,
          stage: "candidate_required_fields_passed",
          source_url: item.source_url ?? item.seller_url ?? null,
          snapshot_sale_price: Number(salePrice),
        });

        categoryData = await timed(sku, "erp_category_and_specs", () => client.getCategoryBySku(sku));
        if (batchControl?.cancelled) {
          return { status: "ignored", sku, source_url: item.source_url ?? null, reason: "batch-fatal-cancelled" };
        }
        productInfo = categoryData?.product_info || {};
        category = mapOzonCategory(
          categoryData?.cate,
          targetConfig.commissionTree,
          salePrice,
          cnyRubRate,
        );
        contentQuality = preSubmitTechnicalQuality({
          item,
          detail: {},
          categoryData,
          category,
          commissionTree: targetConfig.commissionTree,
        });
        const qualityFailure = await contentQualityFailure(item, sku, contentQuality);
        if (qualityFailure) return qualityFailure;
        recordMetric("direct_funnel.jsonl", {
          sku,
          stage: "snapshot_category_passed",
          source_url: item.source_url ?? item.seller_url ?? null,
          snapshot_sale_price: Number(salePrice),
          category: category.mapped,
        });
        detail = { ...item };
        applyShippingRoute();
      } else {
        [detailResult, categoryData] = await timed(sku, "ozon_detail_and_category", () => Promise.all([
          detailProvider.getProductDetail(sku, item),
          client.getCategoryBySku(sku),
        ]));
        if (batchControl?.cancelled) {
          return { status: "ignored", sku, source_url: item.source_url ?? null, reason: "batch-fatal-cancelled" };
        }
        firstDetail = { ...item, ...(detailResult || {}) };
        const firstReason = policy.preflightSkipReason({ ...firstDetail, economy: ECONOMY_SENTINEL });
        if (firstReason) return skip(item, firstReason);
        confirmationResult = await timed(sku, "ozon_fbs_confirmation", () => (
          detailProvider.getProductDetail(sku, {
            ...item,
            link: firstDetail.detail_url || firstDetail.link || item.link,
          })
        ));
        fbsEvidence = {
          verified: policy.isPureFbs(firstDetail.mode) && policy.isPureFbs(confirmationResult?.mode),
          rule: "two independent live Ozon detail observations must both be exact FBS",
          observations: [
            {
              observed_at: now().toISOString(),
              mode: firstDetail.mode ?? null,
              detail_url: firstDetail.detail_url || firstDetail.link || null,
            },
            {
              observed_at: now().toISOString(),
              mode: confirmationResult?.mode ?? null,
              detail_url: confirmationResult?.detail_url || confirmationResult?.link || null,
            },
          ],
        };
        if (!fbsEvidence.verified) {
          return skip(item, "fbs-confirmation-inconsistent", { fbs_evidence: fbsEvidence });
        }
        observedMode = firstDetail.mode || firstDetail.shipping_mode || item.mode || item.shipping_mode || null;
        detail = { ...firstDetail, ...(confirmationResult || {}), mode: "FBS", shipping_mode: "FBS" };
        if (!item.seller_url && detail.seller_url) item.seller_url = detail.seller_url;
        const earlyReason = policy.preflightSkipReason({ ...detail, economy: ECONOMY_SENTINEL });
        if (earlyReason) return skip(item, earlyReason);
        salePrice = policy.selectSalePrice(detail);
        if (!(Number(salePrice) > 0)) return skip(item, "missing-sale-price");
        productInfo = categoryData?.product_info || {};
        category = mapOzonCategory(
          categoryData?.cate,
          targetConfig.commissionTree,
          salePrice,
          cnyRubRate,
        );
        applyShippingRoute();
        contentQuality = preSubmitContentQuality({
          item,
          detail: { ...(detailResult || {}), ...(confirmationResult || {}) },
          categoryData,
          category,
          commissionTree: targetConfig.commissionTree,
        });
        const qualityFailure = await contentQualityFailure(item, sku, contentQuality);
        if (qualityFailure) return qualityFailure;

        let optimisticCalc = null;
        try {
          optimisticCalc = await timed(sku, "profit_upper_bound", () => client.calculateProfit(profitCalculationInput({
            sku,
            salePrice,
            purchasePrice: 0.01,
            productInfo,
            detail,
            category,
            profitThreshold,
            logistics: shippingRoute.logistics,
          })));
        } catch {
          // This fast-path must never replace the original exact calculation on transient ERP failures.
        }
        const optimisticEconomy = economyResult(optimisticCalc, shippingRoute.logistics);
        const optimisticRateValue = optimisticEconomy?.price_list?.profit_rate;
        const optimisticRate = optimisticRateValue === null || optimisticRateValue === undefined || optimisticRateValue === ""
          ? Number.NaN
          : Number(optimisticRateValue);
        if (Number.isFinite(optimisticRate) && optimisticRate <= profitThreshold) {
          return skip(item, `profit-upper-bound<=${profitThreshold}`, {
            profit_upper_bound: optimisticEconomy.price_list,
            optimistic_purchase_price: 0.01,
          });
        }
      }

      const costModel = [
        productInfo?.model,
        productInfo?.model_name,
        productInfo?.article,
        detail?.model,
        detail?.model_name,
        detail?.article,
      ].find((value) => (
        (typeof value === "string" && value.trim() !== "")
        || typeof value === "number"
      ));
      const cost = await timed(sku, "1688_cost", () => costGate.run(
        () => boundedCostEstimate(() => costBridge.estimate({
          ...detail,
          sell_price: salePrice,
          expect_title: detail?.title ?? item?.title ?? "",
          expect_model: costModel ?? "",
          expect_category: (category?.labels || []).slice(0, 2).join(" "),
        }, runDir)),
      ));
      if (!cost?.ok && cost?.deferred === true && cost?.terminal === false) {
        if (activeDirectMode) {
          return skip(item, normalizeCostFailureReason(cost), {
            cost,
            outcome_status: "skipped_cost",
          });
        }
        const retry = boundedTransientFailure({
          reason: "1688-health-deferred",
          now: now(),
          previousAttempts: activeValidationOnly ? 0 : item?.transient_attempts,
          previousDay: activeValidationOnly ? null : item?.retry_day,
          backoffMs: 300_000,
          retryAt: cost.retry_at,
        });
        if (!activeValidationOnly) {
          await state.transition(sku, "failed", {
            ...item,
            ...retry,
            submitted: false,
            submission_pending: false,
            cost,
          });
        }
        if (retry.terminal) {
          return {
            status: "failed",
            sku,
            source_url: item.source_url ?? null,
            reason: retry.reason,
          };
        }
        return {
          status: "deferred",
          sku,
          source_url: item.source_url ?? null,
          reason: "1688-health-deferred",
          retry_at: retry.retry_at,
        };
      }
      if (!cost?.ok || !(Number(cost?.cost) > 0)) {
        return skip(item, normalizeCostFailureReason(cost), {
          cost,
          outcome_status: activeDirectMode ? "skipped_cost" : undefined,
        });
      }
      const costEvidence = publicationCostEvidence(cost, {
        requireContract: requireReliableCostContract,
        minimumMatches: requiredSameItemMatches,
      });
      if (requireReliableCostContract && costEvidence.cost_verified !== true) {
        return skip(item, "1688-same-item-evidence-missing", {
          cost,
          cost_evidence: costEvidence.cost_evidence,
          outcome_status: activeDirectMode ? "skipped_cost" : undefined,
        });
      }
      if (activeDirectMode) {
        recordMetric("direct_funnel.jsonl", {
          sku,
          stage: "cost_passed",
          source_url: item.source_url ?? item.seller_url ?? null,
          purchase_price: Number(cost.cost),
        });

        if (batchControl?.cancelled) {
          return { status: "ignored", sku, source_url: item.source_url ?? null, reason: "batch-fatal-cancelled" };
        }
        detailResult = await timed(sku, "ozon_live_price", () => detailProvider.getProductDetail(sku, item));
        if (batchControl?.cancelled) {
          return { status: "ignored", sku, source_url: item.source_url ?? null, reason: "batch-fatal-cancelled" };
        }
        const observedCnyRubRate = plausibleCnyRubRate(detailResult?.observed_cny_rub_rate);
        if (observedCnyRubRate !== null) {
          cnyRubRate = observedCnyRubRate;
          cnyRubRateConfirmed = true;
        }
        const liveCurrentPrice = Number(detailResult?.current_price) > 0
          ? Number(detailResult.current_price)
          : cnyRubRateConfirmed && Number(detailResult?.current_price_rub) > 0
            ? rounded(Number(detailResult.current_price_rub) / cnyRubRate)
            : null;
        const liveFollowMin = Number(detailResult?.follow_min) > 0
          ? Number(detailResult.follow_min)
          : cnyRubRateConfirmed && Number(detailResult?.follow_min_rub) > 0
            ? rounded(Number(detailResult.follow_min_rub) / cnyRubRate)
            : null;
        detailResult = {
          ...(detailResult || {}),
          current_price: liveCurrentPrice,
          follow_min: liveFollowMin,
        };
        firstDetail = { ...item, ...(detailResult || {}) };
        observedMode = firstDetail.mode || firstDetail.shipping_mode || item.mode || item.shipping_mode || null;
        detail = {
          ...firstDetail,
          mode: observedMode,
          shipping_mode: firstDetail.shipping_mode || observedMode,
        };
        if (!item.seller_url && detail.seller_url) item.seller_url = detail.seller_url;
        const confirmedLivePrices = [
          detailResult?.current_price,
          detailResult?.follow_min,
        ].map(Number).filter((value) => value > 0);
        const freshSnapshotPrice = confirmedLivePrices.length
          ? null
          : freshCnySnapshotSalePrice(item, { now: now() });
        salePrice = confirmedLivePrices.length
          ? Math.min(...confirmedLivePrices)
          : freshSnapshotPrice;
        if (!(Number(salePrice) > 0)) {
          return skip(item, "missing-live-sale-price", { outcome_status: "skipped_profit" });
        }
        category = mapOzonCategory(
          categoryData?.cate,
          targetConfig.commissionTree,
          salePrice,
          cnyRubRate,
        );
        contentQuality = preSubmitTechnicalQuality({
          item,
          detail: detailResult || {},
          categoryData,
          category,
          commissionTree: targetConfig.commissionTree,
        });
        const qualityFailure = await contentQualityFailure(item, sku, contentQuality);
        if (qualityFailure) return qualityFailure;
        fbsEvidence = {
          verified: null,
          rule: "shipping mode is observed for telemetry only",
          observations: [{
            observed_at: now().toISOString(),
            mode: observedMode,
            detail_url: firstDetail.detail_url || firstDetail.link || null,
          }],
        };
        recordMetric("direct_funnel.jsonl", {
          sku,
          stage: freshSnapshotPrice === null ? "live_price_confirmed" : "fresh_snapshot_price_fallback",
          source_url: item.source_url ?? item.seller_url ?? null,
          current_price: Number(detailResult?.current_price) || null,
          current_price_rub: Number(detailResult?.current_price_rub) || null,
          follow_min: Number(detailResult?.follow_min) || null,
          follow_min_rub: Number(detailResult?.follow_min_rub) || null,
          observed_cny_rub_rate: observedCnyRubRate,
          sale_price: Number(salePrice),
          snapshot_observed_at: freshSnapshotPrice === null
            ? null
            : item.update_time || item.create_time || item.favorited_at || item.collected_at || null,
          category: category.mapped,
        });
      }

      let calc;
      try {
        applyShippingRoute();
        calc = await timed(sku, "profit_calculation", () => client.calculateProfit(profitCalculationInput({
          sku,
          salePrice,
          purchasePrice: cost.cost,
          productInfo,
          detail,
          category,
          profitThreshold,
          logistics: shippingRoute.logistics,
        })));
      } catch (error) {
        if (isFatalRunnerError(error)) throw error;
        if (!activeDirectMode) throw error;
        return skip(item, "profit-calculation-failed", {
          outcome_status: "skipped_profit",
          error: String(error?.message || error),
        });
      }
      const calculatedCnyRubRate = plausibleCnyRubRate(calc?.cnyrub_rate);
      if (calculatedCnyRubRate !== null) {
        cnyRubRate = calculatedCnyRubRate;
        cnyRubRateConfirmed = true;
      }
      const economy = economyResult(calc, shippingRoute.logistics);
      if (!economy?.price_list || typeof economy.price_list !== "object") {
        return skip(item, "missing-supported-economy", {
          outcome_status: activeDirectMode ? "skipped_profit" : undefined,
        });
      }
      const preflightReason = activeDirectMode
        ? null
        : policy.preflightSkipReason({ ...detail, economy });
      if (preflightReason) return skip(item, preflightReason);

      const profit = {
        ...economy.price_list,
        purchase_price: economy.price_list.purchase_price ?? cost.cost,
        sell_price: economy.price_list.sell_price ?? salePrice,
      };
      const profitReason = policy.profitSkipReason(profit, profitThreshold);
      if (profitReason) {
        return skip(item, profitReason, {
          profit,
          outcome_status: activeDirectMode ? "skipped_profit" : undefined,
        });
      }
      const effectiveProfitFloor = activeDirectMode ? profitThreshold : Math.max(30, profitThreshold);
      if (!(Number(profit.profit_rate) > effectiveProfitFloor)) {
        return skip(item, `profit_rate<=${effectiveProfitFloor}`, {
          profit,
          outcome_status: activeDirectMode ? "skipped_profit" : undefined,
        });
      }
      const profitSafetyShadow = assessProfitSafety({
        profit,
        cost,
        packageEvidence: {
          weight: productInfo.weight ?? detail.weight,
          length: productInfo.depth ?? productInfo.length ?? detail.depth ?? detail.length,
          width: productInfo.width ?? detail.width,
          height: productInfo.height ?? detail.height,
        },
      });
      const profitSafetyGate = assessProfitSafetyGate({
        profitSafety: profitSafetyShadow,
        cost,
        policy: configuredProfitSafetyActionPolicy,
        directMode: activeDirectMode,
      });
      if (activeDirectMode) {
        recordMetric("profit_safety_gate.jsonl", {
          sku,
          store_id: Number(targetConfig.store.id),
          source_url: item.source_url ?? item.seller_url ?? null,
          profit_safety_gate: profitSafetyGate,
          profit_safety_shadow: profitSafetyShadow,
          cost_evidence: {
            match_evidence_contract: cost.match_evidence_contract ?? null,
            returned_evidence_verified: cost.returned_evidence_verified === true,
            selected_offer_id: cost.selected_offer_id ?? null,
            selected_cluster_prices: Array.isArray(cost.selected_cluster_prices)
              ? cost.selected_cluster_prices
              : [],
            selected_cost: Number.isFinite(Number(cost.cost)) ? Number(cost.cost) : null,
          },
        });
      }
      if (profitSafetyGate.enforced === true) {
        return skip(item, "profit-safety-nonpositive-stressed-profit", {
          profit,
          profit_safety_shadow: profitSafetyShadow,
          profit_safety_gate: profitSafetyGate,
          outcome_status: "skipped_profit",
        });
      }
      if (activeDirectMode) {
        recordMetric("direct_funnel.jsonl", {
          sku,
          stage: "profit_passed",
          source_url: item.source_url ?? item.seller_url ?? null,
          profit_rate: Number(profit.profit_rate),
        });
      }

      const payload = buildPayload(item, detail, economy, targetConfig, now);
      const preparedAt = now().toISOString();
      const submissionState = {
        ...item,
        sku,
        title: payload.rows[0].title,
        link: payload.rows[0].link,
        sell_price: payload.rows[0].sell_price,
        purchase_price: profit.purchase_price,
        profit_rate: profit.profit_rate,
        cate_rate: profit.cate_rate,
        cate_fee: profit.cate_fee,
        store_id: targetConfig.store.id,
        store_name: targetConfig.store.name ?? targetConfig.store.title ?? "",
        watermark_id: targetConfig.watermark.id,
        warehouse_id: shippingRoute.warehouseId,
        shipping_route: shippingRoute.route,
        logistics_provider: shippingRoute.logistics,
        package_weight_grams: shippingRoute.weightGrams,
        weight_threshold_grams: shippingRoute.thresholdGrams,
        offer_id: payload.rows[0].offer_id,
        mode: activeDirectMode ? observedMode : "FBS",
        shipping_mode: activeDirectMode ? observedMode : "FBS",
        preflight_mode: activeDirectMode ? observedMode : "FBS",
        fbs_evidence: fbsEvidence,
        content_quality_evidence: contentQuality.evidence,
        ...costEvidence,
        profit_safety_shadow: profitSafetyShadow,
        profit_safety_gate: profitSafetyGate,
        submission_intent: true,
        submitted: false,
        submission_pending: false,
        submission_payload: payload,
        prepared_at: preparedAt,
        selected_at: preparedAt,
        ...(activeDirectMode ? { direct_target_count: targetCount } : {}),
      };
      const duplicateOwner = activeDirectMode
        ? null
        : crossStoreDuplicateOwner(submissionState.title, sku, targetConfig.store.id);
      if (duplicateOwner) {
        return skip(item, "duplicate-title", {
          duplicate_of_sku: duplicateOwner.sku,
          duplicate_store_id: duplicateOwner.storeId,
        });
      }
      submissionState.quality_gate_passed = true;
      submissionState.quality_checks = {
        pure_fbs: activeDirectMode ? null : fbsEvidence.verified === true,
        reliable_1688_cost: costEvidence.cost_verified === true,
        profit_gt_threshold: Number(profit.profit_rate) > effectiveProfitFloor,
        prohibited_category: contentQuality.checks.prohibited_category,
        title: contentQuality.checks.title,
        image: contentQuality.checks.image,
        category: contentQuality.checks.category,
        historical_and_cross_store_duplicate: true,
      };
      recordMetric("validation_gate.jsonl", {
        sku,
        status: "validated",
        title: submissionState.title,
        link: submissionState.link,
        shipping_mode: detail.mode ?? detail.shipping_mode ?? item.preflight_mode,
        sale_price: submissionState.sell_price,
        purchase_price: submissionState.purchase_price,
        profit_rate: submissionState.profit_rate,
        store_id: submissionState.store_id,
        watermark_id: submissionState.watermark_id,
        cost,
        cost_verified: costEvidence.cost_verified,
        cost_source: costEvidence.cost_source,
        cost_evidence: costEvidence.cost_evidence,
        profit_safety_shadow: profitSafetyShadow,
        profit_safety_gate: profitSafetyGate,
        fbs_evidence: fbsEvidence,
        quality_gate_passed: true,
        quality_checks: submissionState.quality_checks,
        quality_evidence: submissionState.content_quality_evidence,
        validated_at: now().toISOString(),
        validation_mode: activeValidationOnly ? "buffer" : "live-pre-submit",
      });
      if (activeValidationOnly) {
        await metricsChain;
        return { status: "validated", sku, source_url: item.source_url ?? null };
      }
      if (typeof state.recordSelected === "function") {
        await state.recordSelected(submissionState);
      }
      const reserved = await state.transition(sku, "processing", {
        ...submissionState,
        reason: "submission-intent",
      });
      if (reserved === false) {
        return {
          status: "ignored",
          sku,
          source_url: item.source_url ?? null,
          reason: "submission-reservation-not-acquired",
        };
      }
      const persistedIntent = typeof state.entryOf === "function"
        ? state.entryOf(sku)
        : null;
      const persistedIntentData = persistedIntent?.data || {};
      if (persistedIntentData.reconcile_only === true || persistedIntentData.api_call_started_at) {
        return recoverSubmissionIntent(
          { ...submissionState, ...persistedIntentData, sku },
          targetConfig,
          batchControl,
        );
      }
      const apiCallStartedAt = now().toISOString();
      const apiCallState = {
        ...submissionState,
        reason: "submission-api-call-started",
        submission_intent: true,
        submitted: false,
        submission_pending: false,
        api_call_started_at: apiCallStartedAt,
        api_call_attempts_total: 1,
        api_call_attempts_day: 1,
        api_call_day: localDateKey(apiCallStartedAt, dailyStoreTimeZone),
      };
      const apiCallRecorded = await state.transition(sku, "processing", apiCallState);
      if (apiCallRecorded === false) {
        return {
          status: "ignored",
          sku,
          source_url: item.source_url ?? null,
          reason: "submission-api-call-reservation-not-acquired",
        };
      }
      reserveSelectedTitle(submissionState.title, sku, targetConfig.store.id);
      const finalResult = await timed(
        sku,
        "maozi_publish_and_confirm",
        () => publishSerial(sku, payload, targetConfig, apiCallState, batchControl),
      );
      return finalizePublicationAttempt({
        item,
        submissionState: apiCallState,
        payload,
        finalResult,
      });
    } catch (error) {
      if (isFatalRunnerError(error)) {
        cancelDirectRun(error, batchControl);
        throw error;
      }
      const deterministicReason = deterministicProfitFailureReason(error);
      if (deterministicReason) {
        return skip(item, deterministicReason, { error: String(error?.message || error) });
      }
      if (isOzonSoftBlockError(error)) {
        const nextAttempt = Math.max(0, Number(item?.transient_attempts) || 0) + 1;
        const retry = boundedTransientFailure({
          reason: "ozon-detail-soft-block-deferred",
          now: now(),
          previousAttempts: activeValidationOnly ? 0 : item?.transient_attempts,
          previousDay: activeValidationOnly ? null : item?.retry_day,
          backoffMs: transientCandidateBackoffMs(nextAttempt),
        });
        if (!activeValidationOnly) {
          await state.transition(sku, "failed", {
            ...item,
            ...retry,
            error: String(error?.message || error),
            submitted: false,
            submission_pending: false,
          }).catch(() => {});
        }
        if (retry.terminal) {
          return {
            status: "failed",
            sku,
            source_url: item.source_url ?? null,
            reason: retry.reason,
          };
        }
        return {
          status: "deferred",
          sku,
          source_url: item.source_url ?? null,
          reason: "ozon-detail-soft-block-deferred",
          retry_at: retry.retry_at,
        };
      }
      if (!activeValidationOnly) {
        await state.transition(sku, "failed", { reason: "exception", error: String(error?.message || error) }).catch(() => {});
      }
      return { status: "failed", sku, source_url: item.source_url ?? null, reason: "exception", error };
    }
  }

  async function recoverSubmissionIntent(item, targetConfig, batchControl = null) {
    const sku = asSku(item);
    const payload = item?.submission_payload;
    const offerId = String(item?.offer_id || payload?.rows?.[0]?.offer_id || "").trim();
    const lease = await state.transition(sku, "processing", {
      ...item,
      reason: "submission-intent-recovery",
      submission_intent: true,
      submitted: false,
      submission_pending: false,
      reconcile_only: true,
    });
    if (lease === false) {
      return {
        status: "ignored",
        sku,
        source_url: item.source_url ?? null,
        reason: "submission-recovery-reservation-not-acquired",
      };
    }
    if (batchControl?.cancelled) {
      return { status: "ignored", sku, source_url: item.source_url ?? null, reason: "batch-fatal-cancelled" };
    }

    const verificationAttempts = Math.max(1, Math.min(2, Number(confirmationAttempts) || 1));
    let importLog = null;
    let onlineProduct = null;
    try {
      for (let attempt = 0; attempt < verificationAttempts; attempt += 1) {
        [importLog, onlineProduct] = await Promise.all([
          typeof client.findImportLog === "function"
            ? client.findImportLog({
              shopId: targetConfig.store.id,
              sku,
              offerId: offerId || undefined,
            })
            : null,
          offerId && typeof client.findOnlineProduct === "function"
            ? client.findOnlineProduct({
              shopId: targetConfig.store.id,
              offerId,
            })
            : null,
        ]);
        if (importLog || onlineProduct) break;
        if (attempt + 1 < verificationAttempts && Number(confirmationIntervalMs) > 0) {
          await sleep(Number(confirmationIntervalMs));
        }
      }
    } catch (error) {
      if (isFatalRunnerError(error)) throw error;
      await state.transition(sku, "processing", {
        ...item,
        reason: "submission-intent-verification-failed",
        submission_intent: true,
        submitted: false,
        submission_pending: false,
        reconcile_only: true,
        verification_error: String(error?.message || error),
        next_reconcile_at: new Date(now().getTime() + 30_000).toISOString(),
      }).catch(() => {});
      return {
        status: "ignored",
        sku,
        source_url: item.source_url ?? null,
        reason: "submission-intent-verification-failed",
      };
    }

    const usablePayload = payload?.rows?.[0]
      ? payload
      : offerId
        ? {
          rows: [{
            offer_id: offerId,
            link: item.link || canonicalProductUrl(sku),
          }],
        }
        : null;
    if (importLog || onlineProduct) {
      const recoveredPublishResult = {
        ok: true,
        recovered: true,
        evidence: importLog ? "import-log" : "online-product",
      };
      const acceptedState = await persistAcceptedSubmission(
        sku,
        item,
        recoveredPublishResult,
        targetConfig,
      );
      await maybeSyncOnlineShop(targetConfig, { pendingCount: 1 });
      let finalResult;
      if (isEffectiveOnlineProduct(onlineProduct)) {
        finalResult = {
          ok: true,
          import_log: importLog,
          online_product: onlineProduct,
        };
      } else if (usablePayload) {
        finalResult = await confirmPublication(sku, usablePayload, targetConfig, { attempts: 1 });
      } else {
        finalResult = { ok: false, reason: "submission-intent-payload-missing", import_log: importLog };
      }
      return finalizePublicationAttempt({
        item,
        submissionState: acceptedState,
        payload: usablePayload || {
          rows: [{ offer_id: offerId, link: item.link || canonicalProductUrl(sku) }],
        },
        finalResult: {
          ...finalResult,
          publish_result: recoveredPublishResult,
          accepted_state: acceptedState,
        },
      });
    }

    if (activeDirectMode && item?.api_call_started_at) {
      const nextReconcileAt = new Date(now().getTime() + 30_000).toISOString();
      await state.transition(sku, "processing", {
        ...item,
        reason: "submission-api-status-unknown",
        submission_intent: true,
        submitted: false,
        submission_pending: false,
        reconcile_only: true,
        verification_completed_at: now().toISOString(),
        next_reconcile_at: nextReconcileAt,
      });
      return {
        status: "ignored",
        sku,
        source_url: item.source_url ?? null,
        reason: "submission-api-status-unknown",
        retry_at: nextReconcileAt,
      };
    }

    const callDay = localDateKey(now(), dailyStoreTimeZone);
    const previousDay = String(item?.api_call_day || "");
    const attemptsTotal = Math.max(
      item?.api_call_started_at ? 1 : 0,
      Math.floor(Number(item?.api_call_attempts_total) || 0),
    );
    const attemptsToday = previousDay === callDay
      ? Math.max(1, Math.floor(Number(item?.api_call_attempts_day) || 0))
      : 0;
    if (!usablePayload || attemptsTotal >= 2 || attemptsToday >= 2) {
      await state.transition(sku, "failed", {
        ...item,
        reason: usablePayload
          ? "submission-api-uncertain-retry-exhausted"
          : "submission-intent-payload-missing",
        submission_intent: false,
        submitted: false,
        submission_pending: false,
        terminal: true,
        reconcile_only: false,
        verification_completed_at: now().toISOString(),
      });
      return {
        status: "failed",
        sku,
        source_url: item.source_url ?? null,
        reason: usablePayload
          ? "submission-api-uncertain-retry-exhausted"
          : "submission-intent-payload-missing",
      };
    }

    const retryStartedAt = now().toISOString();
    const retryState = {
      ...item,
      reason: "submission-intent-bounded-retry",
      submission_intent: true,
      submitted: false,
      submission_pending: false,
      reconcile_only: true,
      submission_payload: usablePayload,
      previous_api_call_started_at: item?.api_call_started_at || null,
      api_call_started_at: retryStartedAt,
      api_call_attempts_total: attemptsTotal + 1,
      api_call_attempts_day: attemptsToday + 1,
      api_call_day: callDay,
    };
    const retryReserved = await state.transition(sku, "processing", retryState);
    if (retryReserved === false) {
      return {
        status: "ignored",
        sku,
        source_url: item.source_url ?? null,
        reason: "submission-retry-reservation-not-acquired",
      };
    }
    const finalResult = await timed(
      sku,
      "maozi_publish_and_confirm",
      () => publishSerial(sku, usablePayload, targetConfig, retryState, batchControl),
    );
    return finalizePublicationAttempt({
      item,
      submissionState: retryState,
      payload: usablePayload,
      finalResult,
    });
  }

  async function run({
    validationOnly: validationMode = validationOnly,
    validationTarget: runValidationTarget = validationTargetCount,
    attemptLimit = 0,
  } = {}) {
    activeValidationOnly = Boolean(validationMode);
    const activeValidationTarget = Number(runValidationTarget);
    if (!Number.isInteger(activeValidationTarget) || activeValidationTarget <= 0) {
      throw new TypeError("run validationTarget must be a positive integer");
    }
    const activeAttemptLimit = Number(attemptLimit);
    if (!Number.isInteger(activeAttemptLimit) || activeAttemptLimit < 0) {
      throw new TypeError("run attemptLimit must be a non-negative integer");
    }
    await state.load?.();
    const profitSnapshot = await profitFiles.snapshot();
    const gate = await activeSubmissionGate();
    const allowedSkus = activeValidationOnly ? null : gate.allowed_skus;
    const restoredEntries = typeof state.entries === "function" ? state.entries() : [];
    const restoredValidatedSkus = new Set();
    const rejectedValidationSkus = new Set();
    const validationTransientAttempts = new Map();
    const validationDay = localDateKey(now(), dailyStoreTimeZone);
    const latestValidation = new Map();
    for (const row of await readJsonLinesIncremental(path.join(runDir, "validation_gate.jsonl"))) {
      const sku = String(row?.sku || "").trim();
      if (!sku) continue;
      latestValidation.set(sku, row);
      const status = String(row?.status || "");
      if (status === "validated") restoredValidatedSkus.add(sku);
      if (status === "rejected") rejectedValidationSkus.add(sku);
      if (["deferred", "failed"].includes(status)
        && localDateKey(row?.at, dailyStoreTimeZone) === validationDay) {
        validationTransientAttempts.set(
          sku,
          Number(validationTransientAttempts.get(sku) || 0) + 1,
        );
      }
    }
    const validationCandidateEligible = (sku) => {
      if (restoredValidatedSkus.has(sku) || rejectedValidationSkus.has(sku)) return false;
      if (Number(validationTransientAttempts.get(sku) || 0) >= 2) return false;
      const latest = latestValidation.get(sku);
      if (!["deferred", "failed"].includes(String(latest?.status || ""))) return true;
      const retryAt = Date.parse(String(latest?.retry_at || ""));
      return !Number.isFinite(retryAt) || retryAt <= now().getTime();
    };
    const cleanupLimit = Math.max(0, Math.floor(Number(importedFavoriteCleanupLimit) || 0));
    if (!activeValidationOnly && cleanupLimit > 0 && typeof client.listAllFavorites === "function") {
      let allFavorites = [];
      let cleanupFailed = 0;
      try {
        allFavorites = await client.listAllFavorites();
      } catch (error) {
        if (isFatalRunnerError(error)) throw error;
        cleanupFailed += 1;
        recordMetric("failed.jsonl", {
          reason: "imported-favorite-list-failed",
          error: String(error?.message || error),
        });
      }
      const restoredForCleanup = new Map(restoredEntries.map((entry) => [String(entry.sku), entry]));
      const cleanupCandidates = allFavorites.filter((item) => {
        const imported = [true, 1, "1", "true"].includes(item?.is_imported);
        const entry = restoredForCleanup.get(asSku(item));
        return imported
          || entry?.status === "published"
          || entry?.status === "skipped"
          || (entry?.status === "failed" && isTerminalSubmittedFailure(entry));
      });
      const cleanupBatch = cleanupCandidates.slice(0, cleanupLimit);
      let cleanupDeleted = 0;
      for (const item of cleanupBatch) {
        try {
          await client.deleteFavorite(item);
          cleanupDeleted += 1;
        } catch (error) {
          if (isFatalRunnerError(error)) throw error;
          cleanupFailed += 1;
          recordMetric("failed.jsonl", {
            sku: asSku(item),
            reason: "imported-favorite-delete-failed",
            error: String(error?.message || error),
          });
        }
      }
      if (allFavorites.length > 0 || cleanupFailed > 0) {
        recordMetric("favorite_cleanup.jsonl", {
          available: allFavorites.length,
          eligible: cleanupCandidates.length,
          attempted: cleanupBatch.length,
          deleted: cleanupDeleted,
          failed: cleanupFailed,
        });
      }
    }
    selectedTitleOwners.clear();
    for (const entry of restoredEntries) {
      const data = entry?.data || {};
      const sku = String(entry?.sku ?? data.sku ?? "").trim();
      const reservesTitle = entry?.status === "published"
        || (entry?.status === "processing" && (data.submitted === true || data.submission_pending === true));
      if (reservesTitle) reserveSelectedTitle(data.title, sku, data.store_id);
    }
    storeTotalUsage.clear();
    storeTotalReservations.clear();
    const restoredAcceptedByStore = new Map();
    for (const entry of restoredEntries) {
      const data = entry?.data || {};
      const entryStoreId = Number(data.store_id || 0);
      const sku = String(entry?.sku ?? data.sku ?? "").trim();
      if (!(entryStoreId > 0) || !sku) continue;
      const accepted = entry.status === "published"
        || data.submitted === true
        || data.submission_pending === true;
      if (accepted) restoredAcceptedByStore.set(entryStoreId, Number(restoredAcceptedByStore.get(entryStoreId) || 0) + 1);
    }
    for (const [storeId, usage] of Object.entries(totalStoreUsageSeed || {})) {
      const id = Number(storeId);
      const count = Number(usage);
      if (!(id > 0) || !Number.isInteger(count) || count < 0) continue;
      const restoredAccepted = Number(restoredAcceptedByStore.get(id) || 0);
      const priorOnlyCount = totalStoreUsageSeedIncludesRestored
        ? Math.max(0, count - restoredAccepted)
        : count;
      storeTotalUsage.set(id, priorOnlyCount);
    }
    for (const entry of restoredEntries) {
      const data = entry?.data || {};
      const entryStoreId = Number(data.store_id || 0);
      const sku = String(entry?.sku ?? data.sku ?? "").trim();
      if (!(entryStoreId > 0) || !sku) continue;
      const publishedEntry = entry.status === "published";
      const pendingEntry = ["processing", "failed"].includes(entry.status)
        && !isTerminalSubmittedFailure(entry)
        && (data.submitted === true || data.submission_pending === true);
      if (!publishedEntry && !pendingEntry) continue;
      storeTotalUsage.set(entryStoreId, Number(storeTotalUsage.get(entryStoreId) || 0) + 1);
      if (pendingEntry) storeTotalReservations.add(`${entryStoreId}:${sku}`);
    }
    const currentUsageDay = localDateKey(now(), dailyStoreTimeZone);
    if (storeUsageDay !== currentUsageDay) {
      storeUsageDay = currentUsageDay;
      activeTargetIndex = 0;
      haltReason = null;
      const sharedUsageDay = String(sharedDirectRunControl?.storeUsageDay || "");
      if (!sharedDirectRunControl || sharedUsageDay !== currentUsageDay) {
        directRejectedStoreIds.clear();
        directRejectedStoreReasons.clear();
        if (sharedDirectRunControl) {
          sharedDirectRunControl.storeUsageDay = currentUsageDay;
          sharedDirectRunControl.activeStoreId = null;
          sharedDirectRunControl.storeSwitchReason = null;
          sharedDirectRunControl.storeSwitchRequestedAt = null;
        }
      }
      storeDailyUsage.clear();
      storeDailyLimits.clear();
      if (dailyStoreUsageSeed?.date === currentUsageDay) {
        for (const [storeId, usage] of Object.entries(dailyStoreUsageSeed.usage || {})) {
          const id = Number(storeId);
          const count = Number(usage);
          if (id > 0 && Number.isInteger(count) && count >= 0) storeDailyUsage.set(id, count);
        }
      }
      unavailableStoreUntil.clear();
      if (targetConfigCache?.targets) targetConfigCache.targets = {};
      if (targetConfigCache?.value) delete targetConfigCache.value;
      if (targetConfigCache?.targetResolvedAt) delete targetConfigCache.targetResolvedAt;
    }
    if (activeDirectMode) {
      for (const event of await readJsonLinesIncremental(path.join(runDir, "store_rejections.jsonl"))) {
        const eventReason = String(event?.reason || "");
        const eventStoreId = Number(event?.store_id || 0);
        if (!["daily-product-limit", "store-unavailable"].includes(eventReason)) continue;
        const eventQuotaDay = String(event?.quota_day || localDateKey(event?.at, dailyStoreTimeZone) || "");
        if (eventQuotaDay !== currentUsageDay) continue;
        if (!targetPlan.some((entry) => Number(entry.id) === eventStoreId)) continue;
        freezeDirectStore(eventStoreId, eventReason, {}, { record: false });
      }
    }
    for (const entry of restoredEntries) {
      const data = entry?.data || {};
      const restoredLimitReason = String(
        data.reason === "submission-not-sent-deferred"
          ? data.original_reason || ""
          : data.reason || "",
      );
      if (activeDirectMode) {
        if (!["daily-product-limit", "store-unavailable"].includes(restoredLimitReason)) continue;
      } else if (restoredLimitReason !== "daily-product-limit") continue;
      const quotaTimestamp = data.api_call_completed_at
        || data.submitted_at
        || data.api_call_started_at
        || data.prepared_at
        || data.reconciled_at
        || data.published_at;
      const restoredQuotaDay = String(
        data.store_rejection_day || localDateKey(quotaTimestamp, dailyStoreTimeZone) || "",
      );
      if (restoredQuotaDay !== currentUsageDay) continue;
      let exhaustedStoreId = Number(data.store_id || 0);
      if (!(exhaustedStoreId > 0)) {
        const shopName = String(data.import_log?.shop_name || data.store_name || "").trim();
        const matched = targetPlan.find((spec) => {
          const needle = String(spec.needle || "").trim();
          return shopName && needle && (shopName.includes(needle) || needle.includes(shopName));
        });
        exhaustedStoreId = Number(matched?.id || 0);
      }
      if (exhaustedStoreId > 0) {
        if (activeDirectMode) {
          freezeDirectStore(exhaustedStoreId, restoredLimitReason, {
            source: "restored-state",
          }, { record: false });
        }
        storeDailyUsage.set(exhaustedStoreId, Math.max(
          Number(storeDailyUsage.get(exhaustedStoreId) || 0),
          configuredDailyStoreLimit,
        ));
      }
    }
    try {
      const syncEvents = await fs.readFile(path.join(runDir, "store_syncs.jsonl"), "utf8");
      for (const line of syncEvents.split(/\n/).filter(Boolean)) {
        try {
          const event = JSON.parse(line);
          if (event?.kind !== "online-products") continue;
          const storeKey = Number(event.store_id);
          const timestamp = Date.parse(event.at);
          if (storeKey > 0 && Number.isFinite(timestamp)) {
            const previous = Number(lastOnlineSyncAt.get(storeKey) || 0);
            if (timestamp >= previous) {
              lastOnlineSyncAt.set(storeKey, timestamp);
              const pendingCount = Number(event.pending_count);
              if (Number.isFinite(pendingCount) && pendingCount >= 0) {
                lastOnlineSyncPendingCount.set(storeKey, pendingCount);
              }
              onlineSyncBlockedUntil.delete(storeKey);
              const blockedUntil = Date.parse(event.blocked_until || "");
              if (event.ok !== true && Number.isFinite(blockedUntil) && blockedUntil > now().getTime()) {
                onlineSyncBlockedUntil.set(
                  storeKey,
                  Math.min(
                    blockedUntil,
                    timestamp + MAX_ONLINE_SYNC_SERVER_BACKOFF_MS,
                  ),
                );
              }
            }
          }
        } catch {}
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    state.summary?.(targetCount);
    const resolvedTargetsThisRun = new Map();
    const resolvingTargetsThisRun = new Map();
    async function resolveTargetConfigUncached(index, { allowExhausted = false } = {}) {
      const spec = targetPlan[index];
      const cacheKey = String(spec.id);
      const unavailableUntil = Number(unavailableStoreUntil.get(spec.id) || 0);
      if (!allowExhausted && unavailableUntil > now().getTime()) {
        const error = new Error(`store ${spec.id} remains unavailable until ${new Date(unavailableUntil).toISOString()}`);
        error.code = "STORE_WAREHOUSE_UNAVAILABLE";
        throw error;
      }
      let resolved = await client.resolvePublishTarget({
        storeNeedle: spec.needle,
        watermarkNeedle,
        storeId: spec.id,
        watermarkId,
        includeUserProfile: true,
      });
      if (!(Number(resolved?.store?.id) > 0) || !(Number(resolved?.watermark?.id) > 0)) {
        const error = new Error(`store or watermark configuration is incomplete for target ${spec.id}`);
        error.code = "STORE_TARGET_INVALID";
        throw error;
      }
      const dailyCreate = resolved.store?.product_limit?.daily_create;
      const dailyLimit = Number(dailyCreate?.limit);
      const dailyUsage = Number(dailyCreate?.usage);
      const effectiveDailyLimit = activeDirectMode && !enforceDirectDailyLimit
        ? Number.MAX_SAFE_INTEGER
        : dailyLimit > 0
          ? Math.min(configuredDailyStoreLimit, dailyLimit)
          : configuredDailyStoreLimit;
      const restoredUsage = restoredDailyStoreUsage(restoredEntries, spec.id, now(), dailyStoreTimeZone);
      const effectiveDailyUsage = Math.max(
        Number(storeDailyUsage.get(spec.id) || 0),
        Number.isFinite(dailyUsage) && dailyUsage > 0 ? dailyUsage : 0,
        restoredUsage,
      );
      storeDailyLimits.set(spec.id, effectiveDailyLimit);
      storeDailyUsage.set(spec.id, effectiveDailyUsage);
      if (!activeDirectMode
        && !allowExhausted
        && Number(storeTotalUsage.get(spec.id) || 0) >= configuredTotalStoreLimit) {
        const error = new Error(`verified total target exhausted for store ${spec.id}`);
        error.code = "STORE_TOTAL_LIMIT";
        throw error;
      }
      if (enforceDailyQuota && !allowExhausted && effectiveDailyUsage >= effectiveDailyLimit) {
        if (activeDirectMode) {
          freezeDirectStore(spec.id, "daily-product-limit", {
            source: "configured-daily-limit",
            quota_day: currentUsageDay,
          }, { record: false });
        }
        const error = new Error(`daily creation quota exhausted for store ${spec.id}`);
        error.code = "STORE_DAILY_LIMIT";
        throw error;
      }
      let discoveredWarehouses = verifiedWarehouseCandidates(resolved.store);
      let discoveredWarehouseId = discoveredWarehouses.length === 1
        ? Number(discoveredWarehouses[0]?.warehouse_id)
        : 0;
      if (spec.requireWarehouse
        && !(Number(spec.warehouseId) > 0)
        && !(discoveredWarehouseId > 0)
        && !activeValidationOnly
        && typeof client.syncWarehouses === "function") {
        await client.syncWarehouses([spec.id]);
        const attempts = Math.max(1, Number(warehouseSyncAttempts) || 1);
        for (let attempt = 0; attempt < attempts && !(discoveredWarehouseId > 0); attempt += 1) {
          if (Number(warehouseSyncIntervalMs) > 0) await sleep(Number(warehouseSyncIntervalMs));
          resolved = await client.resolvePublishTarget({
            storeNeedle: spec.needle,
            watermarkNeedle,
            storeId: spec.id,
            watermarkId,
            includeUserProfile: true,
          });
          discoveredWarehouses = verifiedWarehouseCandidates(resolved.store);
          discoveredWarehouseId = discoveredWarehouses.length === 1
            ? Number(discoveredWarehouses[0]?.warehouse_id)
            : 0;
        }
      }
      const targetWarehouseId = Number(spec.warehouseId || discoveredWarehouseId || 0);
      if (spec.requireWarehouse && !(targetWarehouseId > 0)) {
        recordStoreTargetMetric({
          store_id: Number(resolved.store?.id || spec.id),
          store_name: resolved.store?.name ?? resolved.store?.title ?? spec.needle,
          available: false,
          reason: discoveredWarehouses.length > 1
            ? "warehouse-not-uniquely-verified"
            : "warehouse-unavailable-after-sync",
          warehouse_count: discoveredWarehouses.length,
          warehouse_candidates: discoveredWarehouses.map((warehouse) => ({
            warehouse_id: Number(warehouse?.warehouse_id || warehouse?.id || 0) || null,
            name: String(warehouse?.name || warehouse?.title || "").trim() || null,
            type: String(warehouse?.type || warehouse?.warehouse_type || "").trim() || null,
            status: String(warehouse?.status || "").trim() || null,
          })),
          daily_usage: effectiveDailyUsage,
          daily_limit: effectiveDailyLimit,
          watermark_id: Number(resolved.watermark?.id || watermarkId),
        });
        await metricsChain;
        unavailableStoreUntil.set(spec.id, now().getTime() + Math.max(0, Number(unavailableStoreRetryMs) || 0));
        const error = new Error(`verified FBS warehouse unavailable for store ${spec.id}`);
        error.code = "STORE_WAREHOUSE_UNAVAILABLE";
        throw error;
      }
      unavailableStoreUntil.delete(spec.id);
      let commissionTree = targetConfigCache?.commissionTree;
      if (!commissionTree) {
        commissionTree = typeof client.listCategoryCommissions === "function" ? await client.listCategoryCommissions() : [];
        if (targetConfigCache) targetConfigCache.commissionTree = commissionTree;
      }
      const value = {
        ...resolved,
        commissionTree,
        warehouseId: targetWarehouseId || null,
        postalWarehouseId: targetWarehouseId || null,
        uralWarehouseId: Number(spec.uralWarehouseId || 0) || null,
        weightThresholdGrams: Number(spec.weightThresholdGrams || 500),
        weightRouting: spec.weightRouting === true,
      };
      recordStoreTargetMetric({
        store_id: Number(resolved.store?.id || spec.id),
        store_name: resolved.store?.name ?? resolved.store?.title ?? spec.needle,
        warehouse_id: targetWarehouseId || null,
        ural_warehouse_id: Number(spec.uralWarehouseId || 0) || null,
        weight_threshold_grams: Number(spec.weightThresholdGrams || 500),
        weight_routing: spec.weightRouting === true,
        warehouse_source: Number(spec.warehouseId) > 0 ? "configured" : "erp-discovered",
        daily_usage: effectiveDailyUsage,
        daily_limit: effectiveDailyLimit,
        watermark_id: Number(resolved.watermark?.id || watermarkId),
      });
      resolvedTargetsThisRun.set(cacheKey, value);
      if (targetConfigCache) {
        if (targetPlan.length === 1) {
          targetConfigCache.value = value;
          targetConfigCache.targetResolvedAt = now().getTime();
        }
        else {
          targetConfigCache.targets ||= {};
          targetConfigCache.targets[cacheKey] = value;
          if (!targetConfigCache.targetResolvedAt || typeof targetConfigCache.targetResolvedAt !== "object") {
            targetConfigCache.targetResolvedAt = {};
          }
          targetConfigCache.targetResolvedAt[cacheKey] = now().getTime();
        }
      }
      return value;
    }

    async function resolveTargetConfig(index, options = {}) {
      const allowExhausted = options.allowExhausted === true;
      const spec = targetPlan[index];
      const cacheKey = String(spec.id);
      const cachedValue = targetPlan.length === 1
        ? targetConfigCache?.value
        : targetConfigCache?.targets?.[cacheKey];
      const cachedAt = targetPlan.length === 1
        ? Number(targetConfigCache?.targetResolvedAt || 0)
        : Number(targetConfigCache?.targetResolvedAt?.[cacheKey] || 0);
      const cacheFresh = cachedValue
        && now().getTime() - cachedAt < Math.max(0, Number(targetRefreshIntervalMs) || 0);
      if (cacheFresh && (allowExhausted || storeDailyLimits.has(spec.id))) {
        if (!activeDirectMode
          && !allowExhausted
          && Number(storeTotalUsage.get(spec.id) || 0) >= configuredTotalStoreLimit) {
          const error = new Error(`verified total target exhausted for store ${spec.id}`);
          error.code = "STORE_TOTAL_LIMIT";
          throw error;
        }
        if (enforceDailyQuota
          && !allowExhausted
          && Number(storeDailyUsage.get(spec.id) || 0) >= Number(storeDailyLimits.get(spec.id) || configuredDailyStoreLimit)) {
          const error = new Error(`daily creation quota exhausted for store ${spec.id}`);
          error.code = "STORE_DAILY_LIMIT";
          throw error;
        }
        resolvedTargetsThisRun.set(cacheKey, cachedValue);
        return cachedValue;
      }
      if (!allowExhausted) return resolveTargetConfigUncached(index, options);
      if (resolvedTargetsThisRun.has(cacheKey)) return resolvedTargetsThisRun.get(cacheKey);
      if (resolvingTargetsThisRun.has(cacheKey)) return resolvingTargetsThisRun.get(cacheKey);
      const operation = resolveTargetConfigUncached(index, options);
      resolvingTargetsThisRun.set(cacheKey, operation);
      try {
        return await operation;
      } finally {
        resolvingTargetsThisRun.delete(cacheKey);
      }
    }

    function stalledPendingForStore(storeId) {
      const entries = typeof state.entries === "function" ? state.entries() : restoredEntries;
      return entries.filter((entry) => {
        if (!["processing", "failed"].includes(entry.status)) return false;
        if (entry.status === "failed" && isTerminalSubmittedFailure(entry)) return false;
        if (Number(entry.data?.store_id) !== Number(storeId)) return false;
        if (entry.data?.submitted !== true && entry.data?.submission_pending !== true) return false;
        const importStatus = normalizedImportStatus(entry.data?.import_log || entry.data?.final_result?.import_log);
        const warehouseStatusRejected = entry.data?.reason === "stock-activation-rejected"
          && hasWarehouseStatusRejection(entry.data?.final_result?.stock_update || entry.data?.stock_update);
        if (["all_imported", "imported", "nested_imported"].includes(importStatus) && !warehouseStatusRejected) return false;
        const submittedAt = Date.parse(entry.data?.prepared_at || entry.data?.selected_at || entry.data?.submitted_at || "");
        return Number.isFinite(submittedAt) && now().getTime() - submittedAt >= Math.max(0, Number(pendingStoreStallMs) || 0);
      });
    }

    async function advanceStoreUnlocked(reason, currentConfig, { excludedStoreIds = new Set() } = {}) {
      const fromStoreId = Number(currentConfig?.store?.id || targetPlan[activeTargetIndex]?.id);
      const startingIndex = activeTargetIndex;
      const blockedStoreIds = new Set([
        ...excludedStoreIds,
        ...(activeDirectMode ? directRejectedStoreIds : []),
      ].map(Number));
      for (let offset = 1; offset < targetPlan.length; offset += 1) {
        const candidateIndex = (startingIndex + offset) % targetPlan.length;
        if (blockedStoreIds.has(Number(targetPlan[candidateIndex].id))) continue;
        activeTargetIndex = candidateIndex;
        try {
          const nextConfig = await resolveTargetConfig(activeTargetIndex);
          storeSwitches.push({ from_store_id: fromStoreId, to_store_id: Number(nextConfig.store.id), reason });
          recordMetric("store_switches.jsonl", storeSwitches.at(-1));
          await recordCurrentStore(nextConfig, reason);
          if (sharedDirectRunControl) {
            sharedDirectRunControl.activeStoreId = Number(nextConfig.store.id);
            sharedDirectRunControl.storeSwitchReason = null;
            sharedDirectRunControl.storeSwitchRequestedAt = null;
          }
          haltReason = null;
          return nextConfig;
        } catch (error) {
          const event = {
            from_store_id: fromStoreId,
            to_store_id: targetPlan[activeTargetIndex].id,
            reason: error?.code === "STORE_DAILY_LIMIT"
              ? "daily-product-limit"
              : error?.code === "STORE_TOTAL_LIMIT" ? "store-total-limit" : "store-target-unavailable",
            error: String(error?.message || error),
          };
          const diagnosticKey = `${event.from_store_id}:${event.to_store_id}:${event.reason}`;
          const diagnosticAt = now().getTime();
          const lastDiagnosticAt = Number(lastStoreSwitchDiagnosticAt.get(diagnosticKey) || 0);
          if (diagnosticAt - lastDiagnosticAt >= Math.max(60_000, Number(pendingStoreRetryMs) || 0)) {
            lastStoreSwitchDiagnosticAt.set(diagnosticKey, diagnosticAt);
            recordMetric("store_switches.jsonl", event);
          }
        }
      }
      activeTargetIndex = startingIndex;
      return null;
    }

    async function advanceStore(reason, currentConfig, options = {}) {
      if (!activeDirectMode || !sharedDirectRunControl) {
        return advanceStoreUnlocked(reason, currentConfig, options);
      }
      const fromStoreId = Number(currentConfig?.store?.id || targetPlan[activeTargetIndex]?.id);
      const previous = Promise.resolve(sharedDirectRunControl.storeSwitchChain).catch(() => {});
      const turn = previous.then(async () => {
        const sharedStoreId = Number(sharedDirectRunControl.activeStoreId || 0);
        if (sharedStoreId > 0
          && sharedStoreId !== fromStoreId
          && !directRejectedStoreIds.has(sharedStoreId)) {
          const sharedIndex = targetPlan.findIndex((entry) => Number(entry.id) === sharedStoreId);
          if (sharedIndex >= 0) {
            activeTargetIndex = sharedIndex;
            const sharedConfig = await resolveTargetConfig(sharedIndex);
            await recordCurrentStore(sharedConfig, "shared-store-switch");
            haltReason = null;
            return sharedConfig;
          }
        }
        return advanceStoreUnlocked(reason, currentConfig, options);
      });
      sharedDirectRunControl.storeSwitchChain = turn.then(() => undefined, () => undefined);
      return turn;
    }

    async function probeInactiveTargetConfigs() {
      if (activeDirectMode
        || !probeInactiveStores
        || targetPlan.length < 2
        || (deadlineAt && now().getTime() >= Date.parse(deadlineAt))) return;
      const currentIndex = activeTargetIndex;
      for (let offset = 1; offset < targetPlan.length; offset += 1) {
        const candidateIndex = (currentIndex + offset) % targetPlan.length;
        try {
          await resolveTargetConfig(candidateIndex);
        } catch {
          // A missing warehouse or exhausted quota must not interrupt the
          // active store. The normal retry cooldown remains authoritative.
        }
      }
    }

    const stalledStoresThisRun = new Set();
    const dailyWindow = dailyWindowState({
      now: now(),
      timeZone: dailyStoreTimeZone,
      cutoff: dailySubmissionCutoff,
      reportAfter: dailyReportAfter,
    });
    let freshSubmissionsPaused = activeDirectMode && !reconciliationOnly && !dailyWindow.open;
    let dailyWindowClosed = freshSubmissionsPaused;
    let initialPauseReason = null;
    let targetConfig;
    if (activeDirectMode) {
      const preferredStoreId = Number(sharedDirectRunControl?.activeStoreId || 0);
      const preferredIndex = preferredStoreId > 0
        ? targetPlan.findIndex((entry) => Number(entry.id) === preferredStoreId)
        : -1;
      if (preferredIndex >= 0 && !directRejectedStoreIds.has(preferredStoreId)) {
        activeTargetIndex = preferredIndex;
      } else {
        const firstAvailableIndex = targetPlan.findIndex(
          (entry) => !directRejectedStoreIds.has(Number(entry.id)),
        );
        if (firstAvailableIndex >= 0) activeTargetIndex = firstAvailableIndex;
      }
    }
    try {
      targetConfig = await resolveTargetConfig(activeTargetIndex);
    } catch (error) {
      haltReason = error?.code === "STORE_DAILY_LIMIT"
        ? "daily-product-limit"
        : error?.code === "STORE_TOTAL_LIMIT" ? "store-total-limit" : "store-target-unavailable";
      targetConfig = await advanceStore(haltReason, { store: { id: targetPlan[activeTargetIndex].id } });
      if (!targetConfig) {
        try {
          targetConfig = await resolveTargetConfig(activeTargetIndex, { allowExhausted: true });
          freshSubmissionsPaused = true;
          dailyWindowClosed = activeDirectMode
            && enforceDirectDailyLimit === true
            && haltReason === "daily-product-limit";
          initialPauseReason = haltReason;
          haltReason = null;
        } catch {
          throw error;
        }
      }
    }
    if (activeDirectMode) {
      const initialFreezeReason = directStoreFreezeReason(targetConfig.store.id);
      if (initialFreezeReason) {
        haltReason = initialFreezeReason;
        const nextConfig = await advanceStore(initialFreezeReason, targetConfig);
        if (nextConfig) targetConfig = nextConfig;
      } else if (sharedDirectRunControl) {
        sharedDirectRunControl.activeStoreId = Number(targetConfig.store.id);
      }
    }
    while (!activeDirectMode && !activeValidationOnly && !freshSubmissionsPaused) {
      const stalledPending = stalledPendingForStore(targetConfig.store.id);
      if (stalledPending.length < Math.max(1, Number(pendingStoreStallCount) || 1)) break;
      const stalledStoreId = Number(targetConfig.store.id);
      stalledStoresThisRun.add(stalledStoreId);
      const nextConfig = await advanceStore("submission-stall", targetConfig, {
        excludedStoreIds: stalledStoresThisRun,
      });
      if (nextConfig) {
        unavailableStoreUntil.set(stalledStoreId, now().getTime() + Math.max(0, Number(pendingStoreRetryMs) || 0));
        targetConfig = nextConfig;
      } else {
        freshSubmissionsPaused = true;
        const currentTime = now().getTime();
        if (currentTime - lastAllStoresStalledAt >= Math.max(60_000, Number(pendingStoreRetryMs) || 0)) {
          lastAllStoresStalledAt = currentTime;
          const event = {
            from_store_id: stalledStoreId,
            to_store_id: null,
            reason: "all-store-imports-stalled",
          };
          storeSwitches.push(event);
          recordMetric("store_switches.jsonl", event);
        }
      }
    }
    await recordCurrentStore(
      targetConfig,
      storeSwitches.at(-1)?.reason || initialPauseReason || "active",
    );
    const facts = await loadCandidateFacts(runDir, candidateFactSeedFiles);
    const restoredBySku = new Map(restoredEntries.map((entry) => [String(entry.sku), entry]));
    const listedFavorites = await client.listFavorites();
    for (const item of listedFavorites.filter((row) => !String(row?.sku ?? row?.id ?? "").trim())) {
      recordMetric("source_yield.jsonl", {
        sku: null,
        source_url: item?.source_url ?? null,
        status: "rejected",
        reason: "missing-sku",
        outcome_status: "rejected",
      });
    }
    const favorites = listedFavorites
      .filter((item) => String(item?.sku ?? item?.id ?? "").trim())
      .filter((item) => {
        const sku = String(item?.sku ?? item?.id ?? "");
        return (!allowedSkus || allowedSkus.has(sku))
          && (!activeValidationOnly || validationCandidateEligible(sku));
      })
      .map((item) => {
        const sku = String(item?.sku ?? item?.id ?? "");
        const restored = restoredBySku.get(sku);
        return mergeCandidateFacts({ ...(restored?.data || {}), ...item }, facts.get(sku) || {});
      });
    const favoriteSkus = new Set(favorites.map((item) => String(item?.sku ?? item?.id ?? "")));
    const delayedSubmissions = (activeValidationOnly ? [] : restoredEntries)
      .filter((entry) => ["processing", "failed"].includes(entry.status)
        && (!allowedSkus || allowedSkus.has(String(entry.sku)))
        && !(entry.status === "failed" && isTerminalSubmittedFailure(entry))
        && !favoriteSkus.has(String(entry.sku))
        && (entry.data?.submitted === true
          || entry.data?.submission_pending === true
          || entry.data?.submission_intent === true
          || entry.data?.reason === "publish-final-status-timeout"))
      .map((entry) => mergeCandidateFacts({
        ...(entry.data || {}),
        sku: String(entry.sku),
        reconcile_only: true,
      }, facts.get(String(entry.sku)) || {}));
    if (delayedSubmissions.length > 0) {
      const delayedCountByStore = new Map();
      for (const item of delayedSubmissions) {
        if (item?.submitted !== true && item?.submission_pending !== true) continue;
        const delayedStoreId = Number(item.store_id) || Number(targetConfig.store.id);
        delayedCountByStore.set(delayedStoreId, Number(delayedCountByStore.get(delayedStoreId) || 0) + 1);
      }
      for (const [delayedStoreId, pendingCount] of delayedCountByStore) {
        await maybeSyncOnlineShop({ store: { id: delayedStoreId } }, { pendingCount });
      }
    }
    const nonTerminalFavorites = favorites.filter((item) => {
      const restored = restoredBySku.get(String(item?.sku ?? item?.id ?? ""));
      return !(restored?.status === "failed" && isTerminalSubmittedFailure(restored));
    });
    const runnableFavorites = activeValidationOnly
      ? nonTerminalFavorites.filter((item) => {
        const restored = restoredBySku.get(String(item?.sku ?? item?.id ?? ""));
        return restored?.data?.submitted !== true
          && restored?.data?.submission_pending !== true
          && restored?.data?.submission_intent !== true;
      })
      : reconciliationOnly || freshSubmissionsPaused
      ? nonTerminalFavorites.filter((item) => {
        const restored = restoredBySku.get(String(item?.sku ?? item?.id ?? ""));
        return restored?.data?.submitted === true
          || restored?.data?.submission_pending === true
          || restored?.data?.submission_intent === true;
      })
      : nonTerminalFavorites;
    const preflightPureSkus = await loadPreflightPureSkus(runDir, candidateFactSeedFiles);
    for (const sku of restoredValidatedSkus) preflightPureSkus.add(sku);
    const { familyScores, sourceScores } = await loadObservedPublishFeedback(runDir, publishFeedbackSeedFiles);
    const isReconciliationCandidate = (item) => item?.reconcile_only === true
      || item?.submitted === true
      || item?.submission_pending === true
      || item?.submission_intent === true;
    const terminalCleanupCandidates = (activeValidationOnly ? [] : runnableFavorites).filter((item) => {
      const restored = restoredBySku.get(String(item?.sku ?? item?.id ?? ""));
      return restored?.status === "published" || restored?.status === "skipped";
    });
    const actionableFavorites = runnableFavorites.filter((item) => {
      const restored = restoredBySku.get(String(item?.sku ?? item?.id ?? ""));
      return restored?.status !== "published" && restored?.status !== "skipped";
    });
    const freshCandidates = prioritizeProfitCandidates(prioritizePublishCandidates(
      actionableFavorites.filter((item) => !isReconciliationCandidate(item)),
      preflightPureSkus,
      familyScores,
      sourceScores,
    ), profitSnapshot, targetConfig.store.id);
    const dueReconciliations = prioritizePublishCandidates(
      (activeValidationOnly || (activeDirectMode && !reconciliationOnly)
        ? []
        : [...delayedSubmissions, ...actionableFavorites.filter(isReconciliationCandidate)]).filter((item) => {
        const nextReconcileAt = Date.parse(item?.next_reconcile_at || "");
        return !Number.isFinite(nextReconcileAt) || nextReconcileAt <= now().getTime();
      }),
      preflightPureSkus,
      familyScores,
      sourceScores,
    );
    const candidates = [
      ...terminalCleanupCandidates,
      ...interleaveCandidateBatches(freshCandidates, dueReconciliations, workerCount),
    ];
    const terminalCleanupSet = new Set(terminalCleanupCandidates);
    const reorderRemainingFreshForStore = (fromIndex, storeId) => {
      const positions = [];
      const pendingFresh = [];
      for (let index = Math.max(0, Number(fromIndex) || 0); index < candidates.length; index += 1) {
        const item = candidates[index];
        if (terminalCleanupSet.has(item) || isReconciliationCandidate(item)) continue;
        positions.push(index);
        pendingFresh.push(item);
      }
      const ranked = prioritizeProfitCandidates(pendingFresh, profitSnapshot, storeId);
      positions.forEach((position, index) => { candidates[position] = ranked[index]; });
    };
    let published = Number(state.runPublishedCount?.() ?? 0);
    const resolvedRunDir = path.resolve(runDir);
    const acceptedSkus = new Set(
      activeDirectMode
        ? restoredEntries
          .filter((entry) => {
            const data = entry?.data || {};
            const runtimeRunDir = String(data.runtime_run_dir || "").trim();
            const belongsToRun = runtimeRunDir
              && path.resolve(runtimeRunDir) === resolvedRunDir;
            return belongsToRun && (
              entry.status === "published"
              || data.submitted === true
              || data.submission_pending === true
            );
          })
          .map((entry) => String(entry.sku))
        : [],
    );
    let failed = 0;
    let skipped = 0;
    let attempted = 0;
    let submittedPending = activeDirectMode
      ? [...acceptedSkus].filter((sku) => state.entryOf?.(sku)?.status !== "published").length
      : 0;
    let dryCandidates = 0;
    let validated = 0;
    const durableDirectAcceptedCount = () => (
      activeDirectMode && typeof state.directAcceptedCount === "function"
        ? Math.max(0, Number(state.directAcceptedCount(resolvedRunDir)) || 0)
        : 0
    );
    const directTargetUsage = () => (
      activeDirectMode && typeof state.directTargetUsage === "function"
        ? Math.max(0, Number(state.directTargetUsage(resolvedRunDir)) || 0)
        : acceptedSkus.size
    );
    const acceptedCount = () => (
      activeDirectMode
        ? Math.max(acceptedSkus.size, durableDirectAcceptedCount())
        : published
    );
    directAcceptedCount = acceptedCount;
    markDirectAccepted = (sku) => acceptedSkus.add(String(sku));
    directActiveStoreId = () => Number(
      sharedDirectRunControl?.activeStoreId || targetConfig?.store?.id || 0,
    );

    async function recordDirectBackgroundOnline(item, existing, importLog, reconciliationTarget, extra = {}) {
      const sku = asSku(item);
      const online = isEffectiveOnlineProduct(existing);
      const stockUpdated = Number(existing?.stock) > 0;
      await state.transition(sku, "processing", {
        ...item,
        ...extra,
        reason: online ? "background-online" : "background-imported",
        submitted: true,
        submission_pending: false,
        reconcile_only: !online,
        outcome_status: online ? "online" : "imported",
        store_id: Number(reconciliationTarget.store.id),
        store_name: reconciliationTarget.store.name ?? reconciliationTarget.store.title ?? item.store_name ?? "",
        offer_id: importLog?.offer_id || item.offer_id,
        import_log: importLog || item.import_log || null,
        import_status: normalizedImportStatus(importLog) || item.import_status || "not-visible",
        store_sku: existing?.sku || item.store_sku || null,
        product_id: existing?.product_id || item.product_id || null,
        product_record_id: existing?.id || item.product_record_id || null,
        online_status: existing?.online_status || item.online_status || null,
        stock: Number.isFinite(Number(existing?.stock)) ? Number(existing.stock) : item.stock ?? null,
        background_status: {
          imported: Boolean(importLog),
          online,
          stock_updated: stockUpdated,
          rejected: false,
        },
        reconciled_at: now().toISOString(),
        next_reconcile_at: online
          ? null
          : new Date(now().getTime() + reconciliationBackoffMs(Number(item.reconcile_attempts) + 1)).toISOString(),
      });
      recordMetric("background_status.jsonl", {
        sku,
        stage: online ? "online" : "imported",
        store_id: Number(reconciliationTarget.store.id),
        imported: Boolean(importLog),
        online,
        stock_updated: stockUpdated,
        rejected: false,
      });
      return { status: "ignored", sku, reason: online ? "background-online" : "background-imported" };
    }

    async function handleCandidate(inputItem, batchControl = null) {
      const sku = asSku(inputItem);
      if (batchControl?.cancelled) {
        return { status: "ignored", sku, source_url: inputItem.source_url ?? null, reason: "batch-fatal-cancelled" };
      }
      let latestEntry = typeof state.entryOf === "function"
        ? state.entryOf(sku)
        : typeof state.entries === "function"
          ? state.entries().find((entry) => String(entry.sku) === String(sku))
          : null;
      let reopenedLegacyPolicy = false;
      if (
        activeDirectMode
        && ["failed", "skipped"].includes(String(latestEntry?.status || ""))
        && typeof state.reopenDirectCandidate === "function"
      ) {
        const reopen = await state.reopenDirectCandidate(sku);
        if (reopen?.reopened === true) {
          reopenedLegacyPolicy = true;
          latestEntry = state.entryOf?.(sku) || latestEntry;
        }
      }
      let restoredStatus = reopenedLegacyPolicy
        ? null
        : latestEntry?.status ?? state.statusOf?.(sku);
      const restoredEntry = latestEntry || restoredBySku.get(String(sku));
      let item = latestEntry
        ? mergeCandidateFacts({ ...inputItem, ...(latestEntry.data || {}), sku }, facts.get(String(sku)) || {})
        : inputItem;
      if (activeValidationOnly) {
        if (state.hasPublished(sku) || restoredStatus === "published") {
          return { status: "ignored", sku, reason: "historical-published" };
        }
        if (restoredStatus === "skipped"
          || item?.skip_intent === true
          || item?.submitted === true
          || item?.submission_pending === true
          || item?.submission_intent === true) {
          return { status: "ignored", sku, reason: "validation-existing-state" };
        }
        const blocked = await attemptBlock(sku);
        if (blocked) return { ...blocked, source_url: inputItem.source_url ?? null };
        return {
          ...await processItem(item, targetConfig, batchControl, { eligibilityChecked: true }),
          attempted: true,
        };
      }
      if (state.hasPublished(sku)) {
        try {
          await client.deleteFavorite(inputItem);
        } catch (error) {
          if (isFatalRunnerError(error)) throw error;
          recordMetric("failed.jsonl", {
            sku,
            reason: "historical-favorite-delete-failed",
            error: String(error?.message || error),
          });
          return { status: "ignored", sku, reason: "historical-favorite-delete-failed" };
        }
        return { status: "ignored", sku, reason: "historical-favorite-deleted" };
      }
      if (item?.skip_intent === true) {
        return {
          ...await completeSkipIntent(
            item,
            item.skip_reason || item.reason,
            item,
            { intentRecorded: true },
          ),
          attempted: true,
        };
      }
      if (item?.submission_intent === true && item?.submitted !== true) {
        let recoveryTarget = targetConfig;
        const intentStoreId = Number(item.store_id || 0);
        if (intentStoreId > 0 && intentStoreId !== Number(targetConfig.store.id)) {
          const intentTargetIndex = targetPlan.findIndex((entry) => Number(entry.id) === intentStoreId);
          if (intentTargetIndex < 0) {
            await state.transition(sku, "failed", {
              ...item,
              reason: "reconciliation-store-not-configured",
            });
            return { status: "failed", sku, reason: "reconciliation-store-not-configured" };
          }
          recoveryTarget = await resolveTargetConfig(intentTargetIndex, { allowExhausted: true });
        }
        recoveryTarget = targetConfigForPersistedRoute(recoveryTarget, item);
        return {
          ...await recoverSubmissionIntent(item, recoveryTarget, batchControl),
          attempted: true,
        };
      }
      if (!activeDirectMode
        && ["processing", "failed"].includes(restoredStatus)
        && (item?.submitted === true || item?.submission_pending === true)
        && item?.fbs_evidence?.verified !== true) {
        await state.transition(sku, "failed", {
          ...item,
          reason: "fbs-evidence-missing",
          submitted: true,
          submission_pending: false,
          quarantined_at: now().toISOString(),
        });
        return { status: "failed", sku, source_url: item.source_url ?? null, reason: "fbs-evidence-missing" };
      }
      if (["processing", "failed"].includes(restoredStatus)
        && (item?.submitted === true || item?.submission_pending === true)
        && !reliable1688CostEvidence(item, {
          requireContract: requireReliableCostContract,
          minimumMatches: requiredSameItemMatches,
        })) {
        await state.transition(sku, "failed", {
          ...item,
          reason: "1688-cost-evidence-missing",
          terminal: true,
          submitted: true,
          submission_pending: false,
          quarantined_at: now().toISOString(),
        });
        return {
          status: "failed",
          sku,
          source_url: item.source_url ?? null,
          reason: "1688-cost-evidence-missing",
        };
      }
      const deferredCandidate = isDeferredCandidateReason(item?.reason)
        || isDeferredCandidateReason(item?.original_reason);
      const deferredRetryAt = Date.parse(item?.retry_at || "");
      if (deferredCandidate && item?.terminal === true) {
        return { status: "ignored", sku, reason: "terminal-deferred-failure" };
      }
      if (deferredCandidate
        && Number.isFinite(deferredRetryAt)
        && deferredRetryAt > now().getTime()) {
        const backoffReason = item?.reason === "1688-health-deferred"
          ? "1688-health-backoff"
          : item?.reason === "ozon-detail-soft-block-deferred"
            ? "ozon-detail-soft-block-backoff"
            : "category-quality-backoff";
        return {
          status: "ignored",
          sku,
          reason: backoffReason,
        };
      }
      if (restoredStatus === "failed" && isTerminalSubmittedFailure(restoredEntry)) {
        return { status: "ignored", sku, reason: "terminal-submission-failure" };
      }
      if (restoredStatus === "skipped") {
        try {
          await client.deleteFavorite(item);
        } catch (error) {
          if (isFatalRunnerError(error)) throw error;
          await state.transition(sku, "failed", { reason: "favorite-delete-failed", error: String(error?.message || error) }).catch(() => {});
          return { status: "failed", sku, reason: "favorite-delete-failed" };
        }
        return { status: "ignored", sku };
      }
      const blocked = await attemptBlock(sku);
      if (blocked) return { ...blocked, source_url: inputItem.source_url ?? null };
      if (!activeDirectMode && !isReconciliationCandidate(item)) {
        const duplicateOwner = crossStoreDuplicateOwner(item?.title, sku, targetConfig.store.id);
        if (duplicateOwner) {
          return {
            ...await skip(item, "duplicate-title", {
              duplicate_of_sku: duplicateOwner.sku,
              duplicate_store_id: duplicateOwner.storeId,
            }),
            attempted: true,
          };
        }
      }
      if ((restoredStatus === "processing" || restoredStatus === "failed") && !deferredCandidate) {
        let reconciliationTarget = targetConfig;
        const restoredStoreId = Number(item.store_id || 0);
        if (restoredStoreId > 0 && restoredStoreId !== Number(targetConfig.store.id)) {
          const restoredTargetIndex = targetPlan.findIndex((entry) => Number(entry.id) === restoredStoreId);
          if (restoredTargetIndex < 0) {
            await state.transition(sku, "failed", {
              ...item,
              reason: "reconciliation-store-not-configured",
            });
            return { status: "failed", sku, reason: "reconciliation-store-not-configured" };
          }
          reconciliationTarget = await resolveTargetConfig(restoredTargetIndex, { allowExhausted: true });
        }
        reconciliationTarget = targetConfigForPersistedRoute(reconciliationTarget, item);
        const nextReconcileAt = Date.parse(item.next_reconcile_at || "");
        if ((item.submitted || item.submission_pending)
          && Number.isFinite(nextReconcileAt)
          && nextReconcileAt > now().getTime()) {
          return { status: "ignored", sku, reason: "reconciliation-backoff" };
        }
        try {
          const importLog = await client.findImportLog({
            shopId: reconciliationTarget.store.id,
            sku,
            offerId: item.offer_id || undefined,
          });
          const importStatus = normalizedImportStatus(importLog);
          if (["all_failed", "failed"].includes(importStatus)) {
            const reason = importFailureReason(importLog);
            if (reason === "import-transient-error") {
              const reconcileAttempts = Math.max(0, Number(item.reconcile_attempts) || 0) + 1;
              await state.transition(sku, "processing", {
                ...item,
                store_id: reconciliationTarget.store.id,
                store_name: reconciliationTarget.store.name ?? reconciliationTarget.store.title ?? item.store_name ?? "",
                reason,
                import_log: importLog,
                submitted: true,
                submission_pending: true,
                reconcile_only: true,
                reconcile_attempts: reconcileAttempts,
                next_reconcile_at: new Date(now().getTime() + reconciliationBackoffMs(reconcileAttempts)).toISOString(),
              });
              return { status: "ignored", sku, source_url: item.source_url ?? null, reason };
            }
            let storeRejectionDay = null;
            if (reason === "daily-product-limit") {
              const exhaustedStoreId = Number(reconciliationTarget.store.id);
              const quotaTimestamp = item.api_call_completed_at
                || item.submitted_at
                || item.api_call_started_at
                || item.prepared_at
                || now();
              storeRejectionDay = localDateKey(quotaTimestamp, dailyStoreTimeZone);
              const currentDay = localDateKey(now(), dailyStoreTimeZone);
              if (storeRejectionDay === currentDay) {
                const exhaustedStoreLimit = Number(storeDailyLimits.get(exhaustedStoreId) || configuredDailyStoreLimit);
                storeDailyUsage.set(exhaustedStoreId, exhaustedStoreLimit);
                freezeDirectStore(exhaustedStoreId, reason, {
                  sku,
                  source: "background-import-log",
                  quota_day: storeRejectionDay,
                });
                if (exhaustedStoreId === Number(targetConfig.store.id)) haltReason = reason;
              }
            }
            await state.transition(sku, "failed", {
              ...item,
              store_id: reconciliationTarget.store.id,
              store_name: reconciliationTarget.store.name ?? reconciliationTarget.store.title ?? item.store_name ?? "",
              reason,
              import_log: importLog,
              outcome_status: activeDirectMode ? "rejected" : undefined,
              background_status: activeDirectMode ? {
                imported: false,
                online: false,
                stock_updated: false,
                rejected: true,
              } : item.background_status,
              ...(storeRejectionDay ? { store_rejection_day: storeRejectionDay } : {}),
              reconciled_at: now().toISOString(),
            });
            if (activeDirectMode) {
              recordMetric("background_status.jsonl", {
                sku,
                stage: "rejected",
                store_id: Number(reconciliationTarget.store.id),
                imported: false,
                online: false,
                stock_updated: false,
                rejected: true,
                reason,
              });
            }
            const reservationKey = `${Number(reconciliationTarget.store.id)}:${sku}`;
            if (storeTotalReservations.delete(reservationKey)) {
              storeTotalUsage.set(Number(reconciliationTarget.store.id), Math.max(0, Number(storeTotalUsage.get(Number(reconciliationTarget.store.id)) || 0) - 1));
            }
            return { status: "failed", sku, source_url: item.source_url ?? null, reason };
          }
          if (["all_imported", "imported"].includes(importStatus)) {
            const confirmed = await confirmPublication(sku, {
              rows: [{ offer_id: importLog.offer_id || item.offer_id }],
            }, reconciliationTarget, { attempts: 1 });
            const existing = confirmed.online_product;
            if (!confirmed.ok || !existing) {
              const reason = confirmed.reason || "reconciliation-online-product-missing";
              const retryablePending = [
                "publish-final-status-timeout",
                "import-transient-error",
                "online-product-not-selling",
                "reconciliation-online-product-missing",
                "stock-activation-failed",
                "stock-activation-rejected",
              ].includes(reason);
              const reconcileAttempts = Math.max(0, Number(item.reconcile_attempts) || 0) + 1;
              await state.transition(sku, retryablePending ? "processing" : "failed", {
                ...item,
                reason,
                import_log: importLog,
                final_result: confirmed,
                submitted: true,
                outcome_status: activeDirectMode
                  ? (retryablePending ? "imported" : "rejected")
                  : item.outcome_status,
                background_status: activeDirectMode ? {
                  imported: true,
                  online: false,
                  stock_updated: false,
                  rejected: !retryablePending,
                } : item.background_status,
                ...(retryablePending ? {
                  reconcile_attempts: reconcileAttempts,
                  next_reconcile_at: new Date(now().getTime() + reconciliationBackoffMs(reconcileAttempts)).toISOString(),
                } : {}),
              });
              return { status: retryablePending ? "ignored" : "failed", sku, reason };
            }
            if (activeDirectMode) {
              return recordDirectBackgroundOnline(
                item,
                existing,
                importLog,
                reconciliationTarget,
                { final_result: confirmed },
              );
            }
            await state.recordPublished({
              ...item,
              sku,
              store_id: reconciliationTarget.store.id,
              store_name: reconciliationTarget.store.name ?? reconciliationTarget.store.title ?? "",
              offer_id: importLog.offer_id,
              store_sku: existing.sku,
              product_id: existing.product_id,
              product_record_id: existing.id,
              online_status: existing.online_status,
              stock: existing.stock,
              import_status: importStatus,
              mode: "FBS",
              shipping_mode: "FBS",
              preflight_mode: "FBS",
              fbs_evidence: item.fbs_evidence,
              ...publicationCostEvidence(item.cost, {
                requireContract: requireReliableCostContract,
              }),
              reconciled: true,
              reconciled_at: now().toISOString(),
              published_at: now().toISOString(),
            });
            return {
              status: "published",
              sku,
              source_url: item.source_url ?? null,
              reconciled: true,
              source_yield_evidence: strictSourceYieldEvidence({
                onlineProduct: existing,
                profitRate: item.profit_rate,
                shippingMode: item.shipping_mode || item.preflight_mode || item.mode,
                productUrl: item.detail_url || item.link || item.href || canonicalProductUrl(sku),
              }),
            };
          }
          const pendingOfferId = importLog?.offer_id || item.offer_id;
          if (pendingOfferId && (importLog || item.submitted || item.submission_pending)) {
            let existing = await client.findOnlineProduct({
              shopId: reconciliationTarget.store.id,
              offerId: pendingOfferId,
            });
            const targetWarehouseId = Number(reconciliationTarget.warehouseId || 0);
            if (targetWarehouseId > 0
              && Number(existing?.sku) > 0
              && String(existing?.online_status || "") === "ready_to_sell"
              && Number(existing?.stock) <= 0) {
              const stockUpdate = await client.updateProductStock({
                shopId: reconciliationTarget.store.id,
                product: existing,
                warehouseId: targetWarehouseId,
                stock: activationStock,
              });
              const updated = Array.isArray(stockUpdate?.result)
                && stockUpdate.result.some((row) => row?.updated === true && (!Array.isArray(row?.errors) || row.errors.length === 0));
              if (updated) {
                existing = await client.findOnlineProduct({
                  shopId: reconciliationTarget.store.id,
                  offerId: pendingOfferId,
                });
              }
            }
            if (isEffectiveOnlineProduct(existing)) {
              if (activeDirectMode) {
                return recordDirectBackgroundOnline(
                  item,
                  existing,
                  importLog,
                  reconciliationTarget,
                  { confirmation_source: "exact-online-offer" },
                );
              }
              await state.recordPublished({
                ...item,
                sku,
                store_id: reconciliationTarget.store.id,
                store_name: reconciliationTarget.store.name ?? reconciliationTarget.store.title ?? "",
                offer_id: pendingOfferId,
                store_sku: existing.sku,
                product_id: existing.product_id,
                product_record_id: existing.id,
                online_status: existing.online_status,
                stock: existing.stock,
                import_status: importStatus || "not-visible",
                confirmation_source: "exact-online-offer",
                mode: "FBS",
                shipping_mode: "FBS",
                preflight_mode: "FBS",
                fbs_evidence: item.fbs_evidence,
                ...publicationCostEvidence(item.cost, {
                  requireContract: requireReliableCostContract,
                }),
                reconciled: true,
                reconciled_at: now().toISOString(),
                published_at: now().toISOString(),
              });
              return {
                status: "published",
                sku,
                source_url: item.source_url ?? null,
                reconciled: true,
                source_yield_evidence: strictSourceYieldEvidence({
                  onlineProduct: existing,
                  profitRate: item.profit_rate,
                  shippingMode: item.shipping_mode || item.preflight_mode || item.mode,
                  productUrl: item.detail_url || item.link || item.href || canonicalProductUrl(sku),
                }),
              };
            }
          }
          if (importLog) {
            if (activeDirectMode) {
              return recordDirectBackgroundOnline(item, null, importLog, reconciliationTarget);
            }
            const reconcileAttempts = Math.max(0, Number(item.reconcile_attempts) || 0) + 1;
            await state.transition(sku, "processing", {
              ...item,
              reason: "reconciliation-import-pending",
              import_log: importLog,
              submitted: true,
              reconcile_attempts: reconcileAttempts,
              next_reconcile_at: new Date(now().getTime() + reconciliationBackoffMs(reconcileAttempts)).toISOString(),
            });
            return { status: "ignored", sku, reason: "reconciliation-import-pending" };
          }
          if (item.reconcile_only || item.submitted || item.submission_pending) {
            return { status: "ignored", sku, reason: "reconciliation-import-not-visible" };
          }
        } catch (error) {
          if (isFatalRunnerError(error)) throw error;
          await state.transition(sku, "failed", {
            ...item,
            reason: "reconciliation-check-failed",
            error: String(error?.message || error),
          }).catch(() => {});
          return { status: "failed", sku, reason: "reconciliation-check-failed", error };
        }
      }

      return {
        ...await processItem(item, targetConfig, batchControl, { eligibilityChecked: true }),
        attempted: true,
      };
    }

    function recordCandidateResult(item, result) {
      if (activeValidationOnly
        && result.attempted
        && ["deferred", "failed"].includes(result.status)) {
        const used = Number(validationTransientAttempts.get(result.sku) || 0);
        const transientAttempts = used + 1;
        validationTransientAttempts.set(result.sku, transientAttempts);
        const explicitRetryAt = Date.parse(String(result.retry_at || ""));
        const retryAt = Number.isFinite(explicitRetryAt) && explicitRetryAt > now().getTime()
          ? new Date(explicitRetryAt).toISOString()
          : new Date(now().getTime() + transientCandidateBackoffMs(transientAttempts)).toISOString();
        const event = {
          sku: result.sku,
          status: result.status,
          reason: result.reason ?? "validation-transient-failure",
          retry_at: retryAt,
          retry_day: validationDay,
          transient_attempts: transientAttempts,
          validation_mode: "buffer",
        };
        latestValidation.set(result.sku, event);
        recordMetric("validation_gate.jsonl", event);
      }
      if (result.status !== "ignored") {
        recordMetric("source_yield.jsonl", {
          sku: result.sku,
          source_url: result.source_url ?? item?.source_url ?? null,
          seller_url: item?.seller_url ?? null,
          title: item?.title ?? null,
          title_family: productTitleFamily(item?.title),
          status: result.status,
          reason: result.reason ?? null,
          ...(result.source_yield_evidence || {}),
        });
      }
      if (result.status === "failed") adaptive.recordFailure(result.error || new Error(result.reason || "publish-failed"));
      else if (["published", "submitted"].includes(result.status)) adaptive.recordSuccess();
      if (result.attempted) attempted += 1;
      if (result.status === "published") {
        published += 1;
        if (activeDirectMode) acceptedSkus.add(String(result.sku));
        dryCandidates = 0;
      } else if (result.status === "submitted") {
        if (!activeDirectMode || !acceptedSkus.has(String(result.sku))) submittedPending += 1;
        if (activeDirectMode) acceptedSkus.add(String(result.sku));
        dryCandidates = 0;
      } else if (result.status === "validated") {
        validated += 1;
        dryCandidates = 0;
      } else {
        if (result.attempted) dryCandidates += 1;
        if (result.status === "failed") failed += 1;
        else if (result.status === "skipped") skipped += 1;
      }
    }

    let cursor = 0;
    const schedulerControl = sharedDirectRunControl || {
      cancelled: false,
      fatalError: null,
    };
    schedulerControl.cancelled = Boolean(schedulerControl.cancelled);
    schedulerControl.fatalError ||= null;
    const inFlight = new Set();
    const freshInFlightByStore = new Map();

    function inFlightFreshCount(storeId = null) {
      if (storeId !== null) return Number(freshInFlightByStore.get(Number(storeId)) || 0);
      return [...freshInFlightByStore.values()].reduce((sum, count) => sum + Number(count || 0), 0);
    }

    function launchCandidate(item, candidateTarget, reconciliation) {
      const storeKey = Number(candidateTarget.store.id);
      if (!reconciliation) {
        freshInFlightByStore.set(storeKey, inFlightFreshCount(storeKey) + 1);
      }
      let task;
      task = (async () => {
        try {
          const result = await handleCandidate(item, schedulerControl);
          recordCandidateResult(item, result);
        } catch (error) {
          cancelDirectRun(error, schedulerControl);
        } finally {
          if (!reconciliation) {
            const remaining = Math.max(0, inFlightFreshCount(storeKey) - 1);
            if (remaining > 0) freshInFlightByStore.set(storeKey, remaining);
            else freshInFlightByStore.delete(storeKey);
          }
          inFlight.delete(task);
        }
      })();
      inFlight.add(task);
    }

    schedulerLoop:
    while (cursor < candidates.length || inFlight.size > 0) {
      if (schedulerControl.fatalError) break;
      const deadlineReached = deadlineAt && Date.now() >= Date.parse(deadlineAt);
      const attemptLimitReached = activeAttemptLimit > 0
        && attempted + inFlight.size >= activeAttemptLimit;
      const dryLimitReached = dryLimit > 0
        && dryCandidates + inFlight.size >= dryLimit;
      const validationLimitReached = activeValidationOnly
        && validated + inFlight.size >= activeValidationTarget;
      if (deadlineReached || attemptLimitReached || dryLimitReached || validationLimitReached) {
        if (inFlight.size > 0) {
          await Promise.race([...inFlight]);
          continue;
        }
        break;
      }

      if (!activeValidationOnly) {
        if (activeDirectMode) {
          const frozenStoreReason = directStoreFreezeReason(targetConfig?.store?.id);
          if (frozenStoreReason) haltReason = frozenStoreReason;
        }
        const switchableHalt = activeDirectMode
          ? ["daily-product-limit", "store-unavailable"].includes(haltReason)
          : ["daily-product-limit", "store-total-limit"].includes(haltReason);
        if (switchableHalt) {
          if (inFlight.size > 0) {
            await Promise.race([...inFlight]);
            continue;
          }
          const nextConfig = await advanceStore(haltReason, targetConfig);
          if (!nextConfig) break;
          targetConfig = nextConfig;
          reorderRemainingFreshForStore(cursor, targetConfig.store.id);
          continue;
        }
        if (haltReason) {
          if (inFlight.size > 0) {
            await Promise.race([...inFlight]);
            continue;
          }
          break;
        }
      }

      let launched = false;
      while (cursor < candidates.length && inFlight.size < adaptive.current) {
        if (activeDirectMode) {
          const frozenStoreReason = directStoreFreezeReason(targetConfig?.store?.id);
          if (frozenStoreReason) {
            haltReason = frozenStoreReason;
            continue schedulerLoop;
          }
        }
        if (schedulerControl.cancelled) break;
        if (activeAttemptLimit > 0 && attempted + inFlight.size >= activeAttemptLimit) break;
        if (dryLimit > 0 && dryCandidates + inFlight.size >= dryLimit) break;
        if (activeValidationOnly && validated + inFlight.size >= activeValidationTarget) break;

        const item = candidates[cursor];
        const reconciliation = item?.reconcile_only === true
          || item?.submitted === true
          || item?.submission_pending === true
          || item?.submission_intent === true;
        if (activeDirectMode && !reconciliation && !dailyWindowState({
          now: now(),
          timeZone: dailyStoreTimeZone,
          cutoff: dailySubmissionCutoff,
          reportAfter: dailyReportAfter,
        }).open) {
          freshSubmissionsPaused = true;
          dailyWindowClosed = true;
          break schedulerLoop;
        }
        if (!unlimitedTarget
          && !activeValidationOnly
          && inFlightFreshCount() > 0
          && acceptedCount() + inFlightFreshCount() >= targetCount) {
          break;
        }
        if (!unlimitedTarget
          && !activeValidationOnly
          && !reconciliation
          && acceptedCount() >= targetCount) {
          cursor += 1;
          continue;
        }

        const activeStoreId = Number(targetConfig.store.id);
        if (!activeDirectMode
          && !activeValidationOnly
          && !reconciliation
          && stalledPendingForStore(activeStoreId).length >= Math.max(1, Number(pendingStoreStallCount) || 1)) {
          if (inFlight.size > 0) break;
          stalledStoresThisRun.add(activeStoreId);
          const nextConfig = await advanceStore("submission-stall", targetConfig, {
            excludedStoreIds: stalledStoresThisRun,
          });
          if (nextConfig) {
            unavailableStoreUntil.set(activeStoreId, now().getTime() + Math.max(0, Number(pendingStoreRetryMs) || 0));
            targetConfig = nextConfig;
            reorderRemainingFreshForStore(cursor, targetConfig.store.id);
            continue schedulerLoop;
          }
          freshSubmissionsPaused = true;
          break schedulerLoop;
        }

        const remainingDailyStoreQuota = !enforceDailyQuota
          ? Number.POSITIVE_INFINITY
          : Number(storeDailyLimits.get(activeStoreId) || configuredDailyStoreLimit)
            - Number(storeDailyUsage.get(activeStoreId) || 0);
        const remainingTotalStoreQuota = activeDirectMode
          ? Number.POSITIVE_INFINITY
          : configuredTotalStoreLimit - Number(storeTotalUsage.get(activeStoreId) || 0);
        const remainingStoreQuota = Math.min(remainingDailyStoreQuota, remainingTotalStoreQuota)
          - inFlightFreshCount(activeStoreId);
        if (!activeValidationOnly && !reconciliation && remainingStoreQuota <= 0) {
          if (inFlight.size > 0) break;
          haltReason = remainingDailyStoreQuota <= 0 ? "daily-product-limit" : "store-total-limit";
          const nextConfig = await advanceStore(haltReason, targetConfig);
          if (!nextConfig) {
            if (activeDirectMode && enforceDirectDailyLimit === true && haltReason === "daily-product-limit") {
              dailyWindowClosed = true;
            }
            break schedulerLoop;
          }
          targetConfig = nextConfig;
          reorderRemainingFreshForStore(cursor, targetConfig.store.id);
          continue schedulerLoop;
        }

        if (!unlimitedTarget && !reconciliation) {
          const remainingTarget = targetCount - acceptedCount() - inFlightFreshCount();
          if (!activeValidationOnly && remainingTarget <= 0) break;
        }
        cursor += 1;
        launchCandidate(item, targetConfig, reconciliation);
        launched = true;
      }

      if (inFlight.size === 0) break;
      if (!launched || inFlight.size >= adaptive.current || cursor >= candidates.length) {
        await Promise.race([...inFlight]);
      }
    }

    schedulerControl.cancelled ||= Boolean(schedulerControl.fatalError);
    await Promise.allSettled([...inFlight, publishChain, metricsChain]);
    if (schedulerControl.fatalError) throw schedulerControl.fatalError;
    if (activeDirectMode && ["daily-product-limit", "store-unavailable"].includes(haltReason)) {
      const nextConfig = await advanceStore(haltReason, targetConfig);
      if (nextConfig) targetConfig = nextConfig;
    }

    await probeInactiveTargetConfigs();
    await metricsChain;

    if (!haltReason && freshSubmissionsPaused && initialPauseReason) haltReason = initialPauseReason;

    return {
      published,
      accepted: acceptedCount(),
      remaining: unlimitedTarget ? null : Math.max(0, targetCount - acceptedCount()),
      validated,
      failed,
      skipped,
      attempted,
      submitted_pending: submittedPending,
      dry_candidates: dryCandidates,
      final_concurrency: adaptive.current,
      deadline_reached: Boolean(deadlineAt && Date.now() >= Date.parse(deadlineAt)),
      target: unlimitedTarget ? null : targetCount,
      unlimited: unlimitedTarget,
      halt_reason: haltReason,
      direct_target_slots_used: activeDirectMode ? directTargetUsage() : null,
      stores_exhausted: activeDirectMode ? {
        rejected_store_ids: [...directRejectedStoreIds].sort((left, right) => left - right),
        all: targetPlan.every((entry) => directRejectedStoreIds.has(Number(entry.id))),
      } : null,
      fresh_submissions_paused: freshSubmissionsPaused,
      daily_window_closed: dailyWindowClosed,
      daily_submission_window: dailyWindowState({
        now: now(),
        timeZone: dailyStoreTimeZone,
        cutoff: dailySubmissionCutoff,
        reportAfter: dailyReportAfter,
      }),
      active_store_id: Number(targetConfig?.store?.id || 0),
      store_switches: storeSwitches,
      store_submitted_usage: Object.fromEntries([...storeDailyUsage].map(([id, usage]) => [String(id), usage])),
      store_total_usage: Object.fromEntries([...storeTotalUsage].map(([id, usage]) => [String(id), usage])),
      store_confirmed_count: Object.fromEntries(
        [...(typeof state.entries === "function" ? state.entries() : [])]
          .filter((entry) => entry.status === "published" && Number(entry.data?.store_id) > 0)
          .reduce((counts, entry) => {
            const id = String(Number(entry.data.store_id));
            counts.set(id, Number(counts.get(id) || 0) + 1);
            return counts;
          }, new Map()),
      ),
      state_summary: state.summary?.(targetCount),
    };
  }

  return { run, processItem };
}
