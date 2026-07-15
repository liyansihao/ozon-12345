function skuOf(item) {
  return String(item?.sku ?? item?.id ?? "").trim();
}

function pureFbs(item) {
  const mode = String(item?.shipping_mode ?? item?.mode ?? "").trim().toUpperCase();
  return mode === "FBS";
}

function requiredPreparedFieldReason(item) {
  if (!(Number(item?.id) > 0)) return "missing-favorite-id";
  if (!String(item?.title || "").trim()) return "missing-title";
  if (!String(item?.cover_image || "").trim()) return "missing-cover-image";
  if (!/^https?:\/\//i.test(String(item?.link || ""))) return "missing-source-link";
  if (!(Number(item?.sell_price ?? item?.sale_price) > 0)) return "missing-sale-price";
  if (!(Number(item?.purchase_price) > 0)) return "missing-purchase-price";
  if (!(Number(item?.cate_rate) > 0) || !(Number(item?.cate_fee) > 0)) return "missing-category-economics";
  return null;
}

export function selectPreparedTransferCandidates(rows, {
  requestedSkus = null,
  threshold = 30,
  excludedSkus = new Set(["2815247918"]),
} = {}) {
  const requested = requestedSkus instanceof Set ? requestedSkus : null;
  const excluded = excludedSkus instanceof Set ? excludedSkus : new Set(excludedSkus || []);
  const latest = new Map();
  for (const row of rows || []) {
    const item = row?.data && typeof row.data === "object" ? { ...row.data, sku: row.sku ?? row.data.sku } : row;
    const sku = skuOf(item);
    if (sku) latest.set(sku, { ...item, sku });
  }
  const accepted = [];
  const rejected = [];
  for (const [sku, item] of latest) {
    if (requested && !requested.has(sku)) continue;
    let reason = null;
    if (excluded.has(sku)) reason = "excluded-sku";
    else if (!pureFbs(item)) reason = "non-pure-fbs";
    else if (!(Number(item.profit_rate) > Number(threshold))) reason = "profit_rate<=30";
    else reason = requiredPreparedFieldReason(item);
    if (reason) rejected.push({ sku, reason, item });
    else accepted.push(item);
  }
  return { accepted, rejected };
}

export function buildPreparedTransferPayload(item, { storeId, watermarkId, offerId }) {
  const sku = skuOf(item);
  if (!sku) throw new Error("prepared transfer SKU is required");
  const price = Math.round(Number(item.sell_price ?? item.sale_price) * 100) / 100;
  return {
    scene: "erp",
    shop_ids: [Number(storeId)],
    brand: "none",
    image_order: "none",
    watermark_id: Number(watermarkId),
    floating_price: null,
    rows: [{
      id: Number(item.id),
      sku,
      title: String(item.title),
      cover_image: String(item.cover_image),
      link: String(item.link),
      sell_price: price,
      price,
      old_price: Math.round(price * 200) / 100,
      offer_id: String(offerId),
      brand: "",
      source: "favorite",
      source_currency: "CNY",
    }],
  };
}

function importStatus(log) {
  const statuses = [log?.import_status, ...(Array.isArray(log?.skus) ? log.skus.map((row) => row?.import_status) : [])]
    .map((value) => String(value || "").toLowerCase())
    .filter(Boolean);
  if (statuses.some((value) => ["all_failed", "failed"].includes(value))) return "failed";
  if (statuses.some((value) => ["all_imported", "imported"].includes(value))) return "imported";
  return log ? "pending" : "missing";
}

function effectiveOnline(product) {
  return Number(product?.sku) > 0
    && String(product?.online_status || "") === "selling"
    && Number(product?.stock) > 0;
}

async function recordEffective({ state, item, offerId, target, online, status }) {
  await state.recordPublished({
    ...item,
    sku: skuOf(item),
    store_id: Number(target.store.id),
    watermark_id: Number(target.watermark.id),
    offer_id: offerId,
    store_sku: online.sku,
    product_id: online.product_id,
    product_record_id: online.id,
    online_status: online.online_status,
    stock: online.stock,
    import_status: status,
    transferred: true,
    published_at: new Date().toISOString(),
  });
}

export async function transferPreparedCandidates({
  client,
  state,
  candidates,
  storeId,
  storeNeedle,
  watermarkId,
  watermarkNeedle,
} = {}) {
  if (!client || !state) throw new TypeError("client and state are required");
  const target = await client.resolvePublishTarget({ storeId, storeNeedle, watermarkId, watermarkNeedle });
  if (Number(target.store?.id) !== Number(storeId)) throw new Error("resolved transfer store ID does not match requested store");
  if (Number(target.watermark?.id) !== Number(watermarkId)) throw new Error("resolved transfer watermark ID does not match requested watermark");

  const result = { requested: candidates.length, submitted: 0, existing_pending: 0, confirmed: 0, failed: 0 };
  for (const item of candidates) {
    const sku = skuOf(item);
    const offerId = String(item.offer_id || `mz-transfer-${sku}`);
    const base = {
      ...item,
      sku,
      store_id: Number(storeId),
      watermark_id: Number(watermarkId),
      offer_id: offerId,
      submission_pending: true,
      transfer_prepared: true,
    };
    try {
      const online = await client.findOnlineProduct({ shopId: storeId, offerId });
      if (effectiveOnline(online)) {
        await recordEffective({ state, item: base, offerId, target, online, status: "exact-online-offer" });
        result.confirmed += 1;
        continue;
      }
      const log = await client.findImportLog({ shopId: storeId, sku, offerId });
      const status = importStatus(log);
      if (status !== "missing") {
        const reason = status === "failed" ? "target-import-failed" : `target-import-${status}`;
        await state.transition(sku, status === "failed" ? "failed" : "processing", {
          ...base,
          reason,
          submitted: true,
          import_log: log,
        });
        if (status === "failed") result.failed += 1;
        else result.existing_pending += 1;
        continue;
      }

      const payload = buildPreparedTransferPayload(item, { storeId, watermarkId, offerId });
      const submission = await client.publish(payload);
      if (!submission?.ok) {
        await state.transition(sku, "failed", { ...base, reason: "target-submit-rejected", submission });
        result.failed += 1;
        continue;
      }
      await state.transition(sku, "processing", {
        ...base,
        reason: "target-submitted-pending",
        submitted: true,
        submitted_at: new Date().toISOString(),
        publish_result: submission,
      });
      result.submitted += 1;
    } catch (error) {
      await state.transition(sku, "failed", {
        ...base,
        reason: "target-transfer-exception",
        error: String(error?.message || error),
      }).catch(() => {});
      result.failed += 1;
    }
  }
  if (result.submitted > 0 && typeof client.syncOnlineShops === "function") {
    try { await client.syncOnlineShops([Number(storeId)], "all"); } catch {}
  }
  return result;
}
