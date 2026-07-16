import fs from "node:fs/promises";
import path from "node:path";

import * as defaultPolicy from "./publish-policy.mjs";
import { canonicalProductUrl } from "./publish-state.mjs";
import { mapOzonCategory } from "./category-commission.mjs";
import {
  fullFunnelSourceScores,
  observedTitleFamilyScores,
  productTitleFamily,
  productTitlePriority,
  sourceYieldKey,
} from "./source-scanner.mjs";
import { AdaptiveConcurrency, hasReusableCandidateFacts, isFatalBrowserError, loadCandidateFacts, mergeCandidateFacts } from "./continuous-runtime.mjs";

const ECONOMY_SENTINEL = Object.freeze({
  title: "CEL Economy",
  price_list: { logistics_name: "CEL", logistics_speed: "economy" },
});

function asSku(item) {
  const sku = String(item?.sku ?? item?.id ?? "").trim();
  if (!sku) throw new Error("candidate SKU is required");
  return sku;
}

function economyResult(calc) {
  if (calc?.economy?.price_list) return calc.economy;
  const rows = calc?.calc_result ?? calc?.data?.calc_result;
  if (!Array.isArray(rows)) return null;
  const row = rows.find((entry) => entry?.name === "CEL" && entry?.speed === "economy");
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

function rounded(value) {
  return Math.round(Number(value) * 100) / 100;
}

function importErrorMessages(log) {
  const messages = [];
  for (const value of [log?.error_msg, ...(Array.isArray(log?.skus) ? log.skus.map((row) => row?.error_msg) : [])]) {
    const message = typeof value === "string" ? value : value?.message;
    if (String(message || "").trim()) messages.push(String(message).trim());
  }
  return messages;
}

function importFailureReason(log) {
  const evidence = importErrorMessages(log).join(" | ");
  if (/суточн(?:ый|ого)\s+лимит|исчерпал\S*\s+суточн|daily\s+(?:product\s+)?limit/i.test(evidence)) {
    return "daily-product-limit";
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

function isTerminalSubmittedFailure(entry) {
  const data = entry?.data || entry || {};
  const reason = String(data.reason || "");
  if (["daily-product-limit", "import-failed", "reconciliation-store-not-configured", "stock-activation-terminal-rejected"].includes(reason)) return true;
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

async function loadPreflightPureSkus(runDir) {
  const result = new Set();
  try {
    const text = await fs.readFile(path.join(runDir, "favorite_collection.jsonl"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line);
        if (event?.status === "favorited" && event?.preflight_mode === "FBS" && event?.sku) {
          result.add(String(event.sku));
        }
      } catch {}
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return result;
}

async function loadObservedPublishFeedback(runDir) {
  try {
    const text = await fs.readFile(path.join(runDir, "source_yield.jsonl"), "utf8");
    const rows = text.split(/\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    return {
      familyScores: observedTitleFamilyScores(rows),
      sourceScores: fullFunnelSourceScores(rows),
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { familyScores: {}, sourceScores: new Map() };
  }
}

function buildPayload(item, detail, economy, targetConfig, now) {
  const sku = asSku(item);
  const price = rounded(economy.price_list.sell_price);
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
      title: detail.title ?? item.title ?? "",
      cover_image: detail.cover_image ?? item.cover_image ?? null,
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
  concurrency = 1,
  maxConcurrency = 12,
  dryCandidateLimit = 0,
  deadlineAt = null,
  targetConfigCache = null,
  targetRefreshIntervalMs = 60_000,
  sourceYieldHistoryPath = null,
  confirmationAttempts = 6,
  confirmationIntervalMs = 2000,
  onlineSyncIntervalMs = 1_800_000,
  urgentOnlineSyncIntervalMs = 600_000,
  urgentOnlineSyncPendingCount = 20,
  warehouseId = null,
  initialStock = 1,
  dailyStoreLimit = 100,
  dailyStoreTimeZone = "Asia/Shanghai",
  dailyStoreUsageSeed = null,
  totalStoreLimit = 100,
  totalStoreUsageSeed = {},
  warehouseSyncAttempts = 2,
  warehouseSyncIntervalMs = 5000,
  unavailableStoreRetryMs = 1_800_000,
  pendingStoreStallMs = 300_000,
  pendingStoreStallCount = 3,
  pendingStoreRetryMs = 300_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!client || !costBridge || !state) throw new TypeError("client, costBridge, and state are required");
  if (!detailProvider || typeof detailProvider.getProductDetail !== "function") {
    throw new TypeError("Playwright Ozon detailProvider.getProductDetail is required");
  }
  const targetCount = Number(target);
  const profitThreshold = Number(threshold);
  if (!Number.isInteger(targetCount) || targetCount < 0) throw new TypeError("target must be a non-negative integer");
  if (!Number.isFinite(profitThreshold)) throw new TypeError("threshold must be numeric");
  const workerCount = Number(concurrency);
  if (!Number.isInteger(workerCount) || workerCount <= 0) throw new TypeError("concurrency must be a positive integer");
  const dryLimit = Number(dryCandidateLimit);
  if (!Number.isInteger(dryLimit) || dryLimit < 0) throw new TypeError("dryCandidateLimit must be a non-negative integer");
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
      requireWarehouse: entry?.requireWarehouse !== false,
    }))
    : [{ id: Number(storeId), needle: String(storeNeedle), warehouseId: warehouseId == null ? null : Number(warehouseId), requireWarehouse: false }];
  for (const entry of targetPlan) {
    if (!(entry.id > 0) || !entry.needle) throw new TypeError("each store target requires a positive id and needle");
    if (entry.warehouseId !== null && !(entry.warehouseId > 0)) throw new TypeError("store target warehouseId must be positive when configured");
  }
  let cnyRubRate = 10.4672;
  let publishChain = Promise.resolve();
  let metricsChain = Promise.resolve();
  let haltReason = null;
  let activeTargetIndex = 0;
  const storeSwitches = [];
  const storeDailyUsage = new Map();
  const storeDailyLimits = new Map();
  const storeTotalUsage = new Map();
  const storeTotalReservations = new Set();
  let storeUsageDay = null;
  const lastOnlineSyncAt = new Map();
  const unavailableStoreUntil = new Map();
  const lastStoreSwitchDiagnosticAt = new Map();
  let lastAllStoresStalledAt = 0;
  const adaptive = new AdaptiveConcurrency({ initial: workerCount, max: Math.max(workerCount, Number(maxConcurrency) || workerCount) });

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
        return { ok: false, reason: importFailureReason(importLog), import_log: importLog };
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
    return { ok: false, reason: "publish-final-status-timeout" };
  }

  async function maybeSyncOnlineShop(targetConfig, { pendingCount = 0 } = {}) {
    if (typeof client.syncOnlineShops !== "function") return;
    const activeStoreId = Number(targetConfig.store.id);
    const currentTime = now().getTime();
    const lastSync = Number(lastOnlineSyncAt.get(activeStoreId) || 0);
    const urgent = Number(pendingCount) >= Math.max(1, Number(urgentOnlineSyncPendingCount) || 1);
    const cooldownMs = urgent
      ? Math.min(
        Math.max(0, Number(onlineSyncIntervalMs) || 0),
        Math.max(0, Number(urgentOnlineSyncIntervalMs) || 0),
      )
      : Math.max(0, Number(onlineSyncIntervalMs) || 0);
    if (currentTime - lastSync < cooldownMs) return;
    lastOnlineSyncAt.set(activeStoreId, currentTime);
    try {
      const syncResult = await client.syncOnlineShops([activeStoreId], "all");
      recordMetric("store_syncs.jsonl", {
        store_id: activeStoreId,
        kind: "online-products",
        ok: true,
        pending_count: Math.max(0, Number(pendingCount) || 0),
        cooldown_ms: cooldownMs,
        urgent,
        result: syncResult ?? null,
      });
    } catch (error) {
      recordMetric("store_syncs.jsonl", {
        store_id: activeStoreId,
        kind: "online-products",
        ok: false,
        pending_count: Math.max(0, Number(pendingCount) || 0),
        cooldown_ms: cooldownMs,
        urgent,
        error: String(error?.message || error),
      });
    }
  }

  async function publishSerial(sku, payload, targetConfig) {
    const submission = publishChain.then(async () => {
      if (haltReason) return { ok: false, reason: haltReason, not_submitted: true };
      return client.publish(payload);
    });
    publishChain = submission.catch(() => {});
    const publishResult = await submission;
    if (!publishResult?.ok) return { ok: false, reason: publishResult?.reason || "publish-not-confirmed", publish_result: publishResult ?? null };
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
    await maybeSyncOnlineShop(targetConfig);
    const confirmation = await confirmPublication(sku, payload, targetConfig);
    if (confirmation.reason === "daily-product-limit") haltReason = confirmation.reason;
    return { ...confirmation, publish_result: publishResult };
  }

  async function skip(item, reason, data = {}) {
    const sku = asSku(item);
    try {
      await client.deleteFavorite(item);
    } catch (error) {
      if (isFatalBrowserError(error)) throw error;
      await state.transition(sku, "failed", {
        reason: "favorite-delete-failed",
        skip_reason: reason,
        error: String(error?.message || error),
      });
      return { status: "failed", sku, source_url: item.source_url ?? null, reason: "favorite-delete-failed" };
    }
    await state.transition(sku, "skipped", { reason, favorite_deleted: true, ...data });
    return { status: "skipped", sku, source_url: item.source_url ?? null, reason };
  }

  async function processItem(item, targetConfig) {
    const sku = asSku(item);
    try {
      await state.transition(sku, "processing", { started_at: now().toISOString() });
      const reusable = hasReusableCandidateFacts(item);
      const [detailResult, categoryData] = await timed(sku, "ozon_detail_and_category", () => Promise.all([
        reusable ? Promise.resolve({
          mode: item.shipping_mode ?? item.mode,
          title: item.title,
          cover_image: item.cover_image,
          current_price: item.sale_price ?? item.sell_price,
          detail_url: item.link,
          reused_collection_facts: true,
        }) : detailProvider.getProductDetail(sku, item),
        client.getCategoryBySku(sku),
      ]));
      const detail = { ...item, ...(detailResult || {}) };
      if (!item.seller_url && detail.seller_url) item.seller_url = detail.seller_url;

      // Reuse the central policy for mode/category checks before paying the 1688 cost.
      const earlyReason = policy.preflightSkipReason({ ...detail, economy: ECONOMY_SENTINEL });
      if (earlyReason) return skip(item, earlyReason);

      const salePrice = policy.selectSalePrice(detail);
      if (!(Number(salePrice) > 0)) return skip(item, "missing-sale-price");

      const cost = await timed(sku, "1688_cost", () => costBridge.estimate({ ...detail, sell_price: salePrice }, runDir));
      if (!cost?.ok) return skip(item, cost?.reason || cost?.error?.code || "unreliable-1688-cost", { cost });

      const productInfo = categoryData?.product_info || {};
      const category = mapOzonCategory(
        categoryData?.cate,
        targetConfig.commissionTree,
        salePrice,
        cnyRubRate,
      );
      const calc = await timed(sku, "profit_calculation", () => client.calculateProfit({
        sku,
        sell_price: salePrice,
        purchase_price: cost.cost,
        package_weight: productInfo.weight ?? detail.weight ?? 1,
        package_length: productInfo.depth ?? productInfo.length ?? detail.depth ?? detail.length ?? 20,
        package_width: productInfo.width ?? detail.width ?? 20,
        package_height: productInfo.height ?? detail.height ?? 20,
        china_fee: 0,
        ad_rate: 0,
        other_rate: 1,
        logistics: "CEL",
        profit_value: profitThreshold,
        profit_type: "percentage",
        cate: category.mapped,
      }));
      if (Number(calc?.cnyrub_rate) > 0) cnyRubRate = Number(calc.cnyrub_rate);
      const economy = economyResult(calc);
      const preflightReason = policy.preflightSkipReason({ ...detail, economy });
      if (preflightReason) return skip(item, preflightReason);

      const profit = {
        ...economy.price_list,
        purchase_price: economy.price_list.purchase_price ?? cost.cost,
        sell_price: economy.price_list.sell_price ?? salePrice,
      };
      const profitReason = policy.profitSkipReason(profit, profitThreshold);
      if (profitReason) return skip(item, profitReason, { profit });

      const payload = buildPayload(item, detail, economy, targetConfig, now);
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
        offer_id: payload.rows[0].offer_id,
        submission_pending: true,
        prepared_at: now().toISOString(),
        selected_at: now().toISOString(),
      };
      await state.recordSelected?.(submissionState);
      await state.transition(sku, "processing", submissionState);
      const finalResult = await timed(sku, "maozi_publish_and_confirm", () => publishSerial(sku, payload, targetConfig));
      if (!finalResult?.ok) {
        const reason = finalResult?.reason || "publish-not-confirmed";
        const submitted = Boolean(finalResult?.publish_result?.ok && !finalResult?.publish_result?.not_submitted);
        const retryablePending = submitted && [
          "publish-final-status-timeout",
          "online-product-not-selling",
          "stock-activation-failed",
          "stock-activation-rejected",
        ].includes(reason);
        await state.transition(sku, retryablePending ? "processing" : "failed", {
          ...submissionState,
          reason,
          submitted,
          final_result: finalResult ?? null,
          ...(retryablePending ? {
            reconcile_attempts: 0,
            next_reconcile_at: new Date(now().getTime() + 10_000).toISOString(),
          } : {}),
        });
        if (!retryablePending && submitted) {
          const reservationKey = `${Number(targetConfig.store.id)}:${sku}`;
          if (storeTotalReservations.delete(reservationKey)) {
            storeTotalUsage.set(Number(targetConfig.store.id), Math.max(0, Number(storeTotalUsage.get(Number(targetConfig.store.id)) || 0) - 1));
          }
        }
        return { status: retryablePending ? "submitted" : "failed", sku, source_url: item.source_url ?? null, reason };
      }

      const onlineProduct = finalResult.online_product;

      await state.recordPublished({
        ...item,
        sku,
        link: payload.rows[0].link,
        sell_price: payload.rows[0].sell_price,
        purchase_price: profit.purchase_price,
        profit_rate: profit.profit_rate,
        cate_rate: profit.cate_rate,
        cate_fee: profit.cate_fee,
        store_id: targetConfig.store.id,
        store_name: targetConfig.store.name ?? targetConfig.store.title ?? "",
        watermark_id: targetConfig.watermark.id,
        offer_id: finalResult.import_log?.offer_id || payload.rows[0].offer_id,
        store_sku: onlineProduct.sku,
        product_id: onlineProduct.product_id,
        product_record_id: onlineProduct.id,
        online_status: onlineProduct.online_status,
        stock: onlineProduct.stock,
        import_status: normalizedImportStatus(finalResult.import_log),
        published_at: now().toISOString(),
      });
      return { status: "published", sku, source_url: item.source_url ?? null, payload, finalResult };
    } catch (error) {
      if (isFatalBrowserError(error)) throw error;
      await state.transition(sku, "failed", { reason: "exception", error: String(error?.message || error) }).catch(() => {});
      return { status: "failed", sku, source_url: item.source_url ?? null, reason: "exception", error };
    }
  }

  async function run() {
    await state.load?.();
    const restoredEntries = typeof state.entries === "function" ? state.entries() : [];
    storeTotalUsage.clear();
    storeTotalReservations.clear();
    for (const [storeId, usage] of Object.entries(totalStoreUsageSeed || {})) {
      const id = Number(storeId);
      const count = Number(usage);
      if (id > 0 && Number.isInteger(count) && count >= 0) storeTotalUsage.set(id, count);
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
    for (const entry of restoredEntries) {
      const data = entry?.data || {};
      if (data.reason !== "daily-product-limit") continue;
      const timestamp = data.reconciled_at || data.published_at || data.submitted_at || data.prepared_at;
      if (localDateKey(timestamp, dailyStoreTimeZone) !== currentUsageDay) continue;
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
          if (event?.kind !== "online-products" || event?.ok !== true) continue;
          const storeKey = Number(event.store_id);
          const timestamp = Date.parse(event.at);
          if (storeKey > 0 && Number.isFinite(timestamp)) {
            lastOnlineSyncAt.set(storeKey, Math.max(timestamp, Number(lastOnlineSyncAt.get(storeKey) || 0)));
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
      });
      const dailyCreate = resolved.store?.product_limit?.daily_create;
      const dailyLimit = Number(dailyCreate?.limit);
      const dailyUsage = Number(dailyCreate?.usage);
      const effectiveDailyLimit = dailyLimit > 0
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
      if (!allowExhausted && Number(storeTotalUsage.get(spec.id) || 0) >= configuredTotalStoreLimit) {
        const error = new Error(`verified total target exhausted for store ${spec.id}`);
        error.code = "STORE_TOTAL_LIMIT";
        throw error;
      }
      if (!allowExhausted && effectiveDailyUsage >= effectiveDailyLimit) {
        const error = new Error(`daily creation quota exhausted for store ${spec.id}`);
        error.code = "STORE_DAILY_LIMIT";
        throw error;
      }
      let discoveredWarehouses = Array.isArray(resolved.store?.warehouse) ? resolved.store.warehouse : [];
      let discoveredWarehouseId = discoveredWarehouses.length === 1
        ? Number(discoveredWarehouses[0]?.warehouse_id)
        : 0;
      if (spec.requireWarehouse
        && !(Number(spec.warehouseId) > 0)
        && !(discoveredWarehouseId > 0)
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
          });
          discoveredWarehouses = Array.isArray(resolved.store?.warehouse) ? resolved.store.warehouse : [];
          discoveredWarehouseId = discoveredWarehouses.length === 1
            ? Number(discoveredWarehouses[0]?.warehouse_id)
            : 0;
        }
      }
      const targetWarehouseId = Number(spec.warehouseId || discoveredWarehouseId || 0);
      if (spec.requireWarehouse && !(targetWarehouseId > 0)) {
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
      const value = { ...resolved, commissionTree, warehouseId: targetWarehouseId || null };
      recordMetric("store_targets.jsonl", {
        store_id: Number(resolved.store?.id || spec.id),
        store_name: resolved.store?.name ?? resolved.store?.title ?? spec.needle,
        warehouse_id: targetWarehouseId || null,
        warehouse_source: Number(spec.warehouseId) > 0 ? "configured" : "erp-discovered",
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
        if (!allowExhausted && Number(storeTotalUsage.get(spec.id) || 0) >= configuredTotalStoreLimit) {
          const error = new Error(`verified total target exhausted for store ${spec.id}`);
          error.code = "STORE_TOTAL_LIMIT";
          throw error;
        }
        if (!allowExhausted
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
        if (["all_imported", "imported", "nested_imported"].includes(importStatus)) return false;
        const submittedAt = Date.parse(entry.data?.prepared_at || entry.data?.selected_at || entry.data?.submitted_at || "");
        return Number.isFinite(submittedAt) && now().getTime() - submittedAt >= Math.max(0, Number(pendingStoreStallMs) || 0);
      });
    }

    async function advanceStore(reason, currentConfig, { excludedStoreIds = new Set() } = {}) {
      const fromStoreId = Number(currentConfig?.store?.id || targetPlan[activeTargetIndex]?.id);
      const startingIndex = activeTargetIndex;
      for (let offset = 1; offset < targetPlan.length; offset += 1) {
        const candidateIndex = (startingIndex + offset) % targetPlan.length;
        if (excludedStoreIds.has(Number(targetPlan[candidateIndex].id))) continue;
        activeTargetIndex = candidateIndex;
        try {
          const nextConfig = await resolveTargetConfig(activeTargetIndex);
          storeSwitches.push({ from_store_id: fromStoreId, to_store_id: Number(nextConfig.store.id), reason });
          recordMetric("store_switches.jsonl", storeSwitches.at(-1));
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

    const stalledStoresThisRun = new Set();
    let targetConfig;
    try {
      targetConfig = await resolveTargetConfig(activeTargetIndex);
    } catch (error) {
      haltReason = error?.code === "STORE_DAILY_LIMIT"
        ? "daily-product-limit"
        : error?.code === "STORE_TOTAL_LIMIT" ? "store-total-limit" : "store-target-unavailable";
      targetConfig = await advanceStore(haltReason, { store: { id: targetPlan[activeTargetIndex].id } });
      if (!targetConfig) throw error;
    }
    let freshSubmissionsPaused = false;
    while (!freshSubmissionsPaused) {
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
    const facts = await loadCandidateFacts(runDir);
    const restoredBySku = new Map(restoredEntries.map((entry) => [String(entry.sku), entry]));
    const favorites = (await client.listFavorites()).map((item) => {
      const sku = String(item?.sku ?? item?.id ?? "");
      const restored = restoredBySku.get(sku);
      return mergeCandidateFacts({ ...(restored?.data || {}), ...item }, facts.get(sku) || {});
    });
    const favoriteSkus = new Set(favorites.map((item) => String(item?.sku ?? item?.id ?? "")));
    const delayedSubmissions = restoredEntries
      .filter((entry) => ["processing", "failed"].includes(entry.status)
        && !(entry.status === "failed" && isTerminalSubmittedFailure(entry))
        && !favoriteSkus.has(String(entry.sku))
        && (entry.data?.submitted === true
          || entry.data?.submission_pending === true
          || entry.data?.reason === "publish-final-status-timeout"))
      .map((entry) => mergeCandidateFacts({
        ...(entry.data || {}),
        sku: String(entry.sku),
        reconcile_only: true,
      }, facts.get(String(entry.sku)) || {}));
    if (delayedSubmissions.length > 0) {
      const delayedCountByStore = new Map();
      for (const item of delayedSubmissions) {
        const delayedStoreId = Number(item.store_id) || Number(targetConfig.store.id);
        delayedCountByStore.set(delayedStoreId, Number(delayedCountByStore.get(delayedStoreId) || 0) + 1);
      }
      for (const [delayedStoreId, pendingCount] of delayedCountByStore) {
        await maybeSyncOnlineShop({ store: { id: delayedStoreId } }, { pendingCount });
      }
    }
    const runnableFavorites = reconciliationOnly || freshSubmissionsPaused
      ? favorites.filter((item) => {
        const restored = restoredBySku.get(String(item?.sku ?? item?.id ?? ""));
        return restored?.data?.submitted === true || restored?.data?.submission_pending === true;
      })
      : favorites;
    const preflightPureSkus = await loadPreflightPureSkus(runDir);
    const { familyScores, sourceScores } = await loadObservedPublishFeedback(runDir);
    const isReconciliationCandidate = (item) => item?.reconcile_only === true
      || item?.submitted === true
      || item?.submission_pending === true;
    const freshCandidates = prioritizePublishCandidates(
      runnableFavorites.filter((item) => !isReconciliationCandidate(item)),
      preflightPureSkus,
      familyScores,
      sourceScores,
    );
    const dueReconciliations = prioritizePublishCandidates(
      [...delayedSubmissions, ...runnableFavorites.filter(isReconciliationCandidate)].filter((item) => {
        const nextReconcileAt = Date.parse(item?.next_reconcile_at || "");
        return !Number.isFinite(nextReconcileAt) || nextReconcileAt <= now().getTime();
      }),
      preflightPureSkus,
      familyScores,
      sourceScores,
    );
    const candidates = interleaveCandidateBatches(freshCandidates, dueReconciliations, workerCount);
    let published = Number(state.runPublishedCount?.() ?? 0);
    let failed = 0;
    let skipped = 0;
    let attempted = 0;
    let submittedPending = 0;
    let dryCandidates = 0;

    async function handleCandidate(inputItem) {
      const sku = asSku(inputItem);
      if (state.hasPublished(sku)) return { status: "ignored", sku };

      const latestEntry = typeof state.entries === "function"
        ? state.entries().find((entry) => String(entry.sku) === String(sku))
        : null;
      const restoredStatus = latestEntry?.status ?? state.statusOf?.(sku);
      const restoredEntry = latestEntry || restoredBySku.get(String(sku));
      const item = latestEntry
        ? mergeCandidateFacts({ ...inputItem, ...(latestEntry.data || {}), sku }, facts.get(String(sku)) || {})
        : inputItem;
      if (restoredStatus === "failed" && isTerminalSubmittedFailure(restoredEntry)) {
        return { status: "ignored", sku, reason: "terminal-submission-failure" };
      }
      if (restoredStatus === "skipped") {
        try {
          await client.deleteFavorite(item);
        } catch (error) {
          if (isFatalBrowserError(error)) throw error;
          await state.transition(sku, "failed", { reason: "favorite-delete-failed", error: String(error?.message || error) }).catch(() => {});
          return { status: "failed", sku, reason: "favorite-delete-failed" };
        }
        return { status: "ignored", sku };
      }
      if (restoredStatus === "processing" || restoredStatus === "failed") {
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
            if (reason === "daily-product-limit") {
              const exhaustedStoreId = Number(reconciliationTarget.store.id);
              const exhaustedStoreLimit = Number(storeDailyLimits.get(exhaustedStoreId) || configuredDailyStoreLimit);
              storeDailyUsage.set(exhaustedStoreId, exhaustedStoreLimit);
              if (exhaustedStoreId === Number(targetConfig.store.id)) haltReason = reason;
            }
            await state.transition(sku, "failed", {
              ...item,
              store_id: reconciliationTarget.store.id,
              store_name: reconciliationTarget.store.name ?? reconciliationTarget.store.title ?? item.store_name ?? "",
              reason,
              import_log: importLog,
              reconciled_at: now().toISOString(),
            });
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
                ...(retryablePending ? {
                  reconcile_attempts: reconcileAttempts,
                  next_reconcile_at: new Date(now().getTime() + reconciliationBackoffMs(reconcileAttempts)).toISOString(),
                } : {}),
              });
              return { status: retryablePending ? "ignored" : "failed", sku, reason };
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
              reconciled: true,
              reconciled_at: now().toISOString(),
              published_at: now().toISOString(),
            });
            return { status: "published", sku, source_url: item.source_url ?? null, reconciled: true };
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
                reconciled: true,
                reconciled_at: now().toISOString(),
                published_at: now().toISOString(),
              });
              return { status: "published", sku, source_url: item.source_url ?? null, reconciled: true };
            }
          }
          if (importLog) {
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
          if (isFatalBrowserError(error)) throw error;
          await state.transition(sku, "failed", {
            ...item,
            reason: "reconciliation-check-failed",
            error: String(error?.message || error),
          }).catch(() => {});
          return { status: "failed", sku, reason: "reconciliation-check-failed", error };
        }
      }

      return { ...await processItem(item, targetConfig), attempted: true };
    }

    let cursor = 0;
    while (cursor < candidates.length
      && !haltReason
      && (!deadlineAt || Date.now() < Date.parse(deadlineAt))
      && (dryLimit === 0 || dryCandidates < dryLimit)) {
      const activeStoreId = Number(targetConfig.store.id);
      const nextCandidate = candidates[cursor];
      const nextIsReconciliation = nextCandidate?.reconcile_only === true
        || nextCandidate?.submitted === true
        || nextCandidate?.submission_pending === true;
      if (!nextIsReconciliation && published >= targetCount) {
        cursor += 1;
        continue;
      }
      if (!nextIsReconciliation
        && stalledPendingForStore(activeStoreId).length >= Math.max(1, Number(pendingStoreStallCount) || 1)) {
        stalledStoresThisRun.add(activeStoreId);
        const nextConfig = await advanceStore("submission-stall", targetConfig, {
          excludedStoreIds: stalledStoresThisRun,
        });
        if (nextConfig) {
          unavailableStoreUntil.set(activeStoreId, now().getTime() + Math.max(0, Number(pendingStoreRetryMs) || 0));
          targetConfig = nextConfig;
          continue;
        }
        freshSubmissionsPaused = true;
        break;
      }
      const remainingDailyStoreQuota = Number(storeDailyLimits.get(activeStoreId) || configuredDailyStoreLimit)
        - Number(storeDailyUsage.get(activeStoreId) || 0);
      const remainingTotalStoreQuota = configuredTotalStoreLimit - Number(storeTotalUsage.get(activeStoreId) || 0);
      const remainingStoreQuota = Math.min(remainingDailyStoreQuota, remainingTotalStoreQuota);
      if (remainingStoreQuota <= 0) {
        haltReason = remainingTotalStoreQuota <= 0 ? "store-total-limit" : "daily-product-limit";
        const nextConfig = await advanceStore(haltReason, targetConfig);
        if (nextConfig) {
          targetConfig = nextConfig;
          continue;
        }
        break;
      }
      const nearTarget = published >= targetCount - (adaptive.current - 1);
      const width = Math.min(remainingStoreQuota, nearTarget ? 1 : adaptive.current);
      const batch = candidates.slice(cursor, cursor + width);
      cursor += batch.length;
      const results = await Promise.all(batch.map(handleCandidate));
      for (const [index, result] of results.entries()) {
        const item = batch[index];
        if (result.status !== "ignored") {
          recordMetric("source_yield.jsonl", {
            sku: result.sku,
            source_url: result.source_url ?? item?.source_url ?? null,
            seller_url: item?.seller_url ?? null,
            title: item?.title ?? null,
            title_family: productTitleFamily(item?.title),
            status: result.status,
            reason: result.reason ?? null,
          });
        }
        if (result.status === "failed") adaptive.recordFailure(result.error || new Error(result.reason || "publish-failed"));
        else if (["published", "submitted"].includes(result.status)) adaptive.recordSuccess();
        if (result.attempted) attempted += 1;
        if (result.status === "published") {
          published += 1;
          dryCandidates = 0;
        } else if (result.status === "submitted") {
          submittedPending += 1;
          dryCandidates = 0;
        } else {
          if (result.attempted) dryCandidates += 1;
          if (result.status === "failed") failed += 1;
          else if (result.status === "skipped") skipped += 1;
        }
      }
      const currentStoreId = Number(targetConfig.store.id);
      const currentStoreLimit = Number(storeDailyLimits.get(currentStoreId) || configuredDailyStoreLimit);
      if (Number(storeDailyUsage.get(currentStoreId) || 0) >= currentStoreLimit) haltReason = "daily-product-limit";
      else if (Number(storeTotalUsage.get(currentStoreId) || 0) >= configuredTotalStoreLimit) haltReason = "store-total-limit";
      if (["daily-product-limit", "store-total-limit"].includes(haltReason)) {
        const nextConfig = await advanceStore(haltReason, targetConfig);
        if (nextConfig) targetConfig = nextConfig;
      }
    }

    await metricsChain;

    return {
      published,
      failed,
      skipped,
      attempted,
      submitted_pending: submittedPending,
      dry_candidates: dryCandidates,
      final_concurrency: adaptive.current,
      deadline_reached: Boolean(deadlineAt && Date.now() >= Date.parse(deadlineAt)),
      target: targetCount,
      halt_reason: haltReason,
      fresh_submissions_paused: freshSubmissionsPaused,
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
