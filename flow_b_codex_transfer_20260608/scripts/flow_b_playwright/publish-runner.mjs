import * as defaultPolicy from "./publish-policy.mjs";
import { canonicalProductUrl } from "./publish-state.mjs";
import { mapOzonCategory } from "./category-commission.mjs";

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

function rounded(value) {
  return Math.round(Number(value) * 100) / 100;
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
      offer_id: `mz-${offerDate(now())}-${sku.slice(-6)}`,
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
} = {}) {
  if (!client || !costBridge || !state) throw new TypeError("client, costBridge, and state are required");
  if (!detailProvider || typeof detailProvider.getProductDetail !== "function") {
    throw new TypeError("Playwright Ozon detailProvider.getProductDetail is required");
  }
  const targetCount = Number(target);
  const profitThreshold = Number(threshold);
  if (!Number.isInteger(targetCount) || targetCount < 0) throw new TypeError("target must be a non-negative integer");
  if (!Number.isFinite(profitThreshold)) throw new TypeError("threshold must be numeric");
  let cnyRubRate = 10.4672;

  async function skip(sku, reason, data = {}) {
    await state.transition(sku, "skipped", { reason, ...data });
    return { status: "skipped", sku, reason };
  }

  async function processItem(item, targetConfig) {
    const sku = asSku(item);
    try {
      await state.transition(sku, "processing", { started_at: now().toISOString() });
      const [detailResult, categoryData] = await Promise.all([
        detailProvider.getProductDetail(sku, item),
        client.getCategoryBySku(sku),
      ]);
      const detail = { ...item, ...(detailResult || {}) };

      // Reuse the central policy for mode/category checks before paying the 1688 cost.
      const earlyReason = policy.preflightSkipReason({ ...detail, economy: ECONOMY_SENTINEL });
      if (earlyReason) return skip(sku, earlyReason);

      const salePrice = policy.selectSalePrice(detail);
      if (!(Number(salePrice) > 0)) return skip(sku, "missing-sale-price");

      const cost = await costBridge.estimate({ ...detail, sell_price: salePrice }, runDir);
      if (!cost?.ok) return skip(sku, cost?.reason || cost?.error?.code || "unreliable-1688-cost", { cost });

      const productInfo = categoryData?.product_info || {};
      const category = mapOzonCategory(
        categoryData?.cate,
        targetConfig.commissionTree,
        salePrice,
        cnyRubRate,
      );
      const calc = await client.calculateProfit({
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
      });
      if (Number(calc?.cnyrub_rate) > 0) cnyRubRate = Number(calc.cnyrub_rate);
      const economy = economyResult(calc);
      const preflightReason = policy.preflightSkipReason({ ...detail, economy });
      if (preflightReason) return skip(sku, preflightReason);

      const profit = {
        ...economy.price_list,
        purchase_price: economy.price_list.purchase_price ?? cost.cost,
        sell_price: economy.price_list.sell_price ?? salePrice,
      };
      const profitReason = policy.profitSkipReason(profit, profitThreshold);
      if (profitReason) return skip(sku, profitReason, { profit });

      const payload = buildPayload(item, detail, economy, targetConfig, now);
      const publishResult = await client.publish(payload);
      if (!publishResult?.ok) {
        await state.transition(sku, "failed", { reason: "publish-not-confirmed", publish_result: publishResult ?? null });
        return { status: "failed", sku, reason: "publish-not-confirmed" };
      }

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
        watermark_id: targetConfig.watermark.id,
        published_at: now().toISOString(),
      });
      return { status: "published", sku, payload, publishResult };
    } catch (error) {
      await state.transition(sku, "failed", { reason: "exception", error: String(error?.message || error) }).catch(() => {});
      return { status: "failed", sku, reason: "exception", error };
    }
  }

  async function run() {
    await state.load?.();
    state.summary?.(targetCount);
    const targetConfig = {
      ...await client.resolvePublishTarget({ storeNeedle, watermarkNeedle }),
      commissionTree: typeof client.listCategoryCommissions === "function" ? await client.listCategoryCommissions() : [],
    };
    const candidates = await client.listFavorites();
    let published = Number(state.runPublishedCount?.() ?? 0);
    let failed = 0;
    let skipped = 0;
    let attempted = 0;

    for (const item of candidates) {
      if (published >= targetCount) break;
      const sku = asSku(item);
      if (state.hasPublished(sku)) continue;

      const restoredStatus = state.statusOf?.(sku);
      if (restoredStatus === "processing" || restoredStatus === "failed") {
        try {
          const existing = await client.findPublishedSku(sku);
          if (existing) {
            await state.recordPublished({ ...item, ...existing, sku, reconciled: true, reconciled_at: now().toISOString() });
            published += 1;
            continue;
          }
        } catch (error) {
          await state.transition(sku, "failed", { reason: "reconciliation-check-failed", error: String(error?.message || error) }).catch(() => {});
          failed += 1;
          continue;
        }
      }

      attempted += 1;
      const result = await processItem(item, targetConfig);
      if (result.status === "published") published += 1;
      else if (result.status === "failed") failed += 1;
      else if (result.status === "skipped") skipped += 1;
    }

    return {
      published,
      failed,
      skipped,
      attempted,
      target: targetCount,
      state_summary: state.summary?.(targetCount),
    };
  }

  return { run, processItem };
}
