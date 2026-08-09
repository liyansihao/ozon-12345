export const PROFIT_LEARNING_VERSION = 1;
export const DEFAULT_PROFIT_WINDOW_DAYS = 30;
export const DEFAULT_MOTHER_MIN_ORDERS = 3;
export const DEFAULT_MAX_REFUND_CANCEL_RATE = 1;

const PROFIT_FIELDS = Object.freeze([
  "amount_cny",
  "purchase_cost_cny",
  "commission_cny",
  "international_logistics_cny",
  "last_mile_cny",
  "other_cost_cny",
  "refund_cny",
]);

const EXPENSE_FIELDS = new Set(PROFIT_FIELDS.filter((field) => field !== "amount_cny"));
const COMPLETED_STATUSES = new Set(["completed", "delivered"]);
const REFUND_CANCEL_STATUSES = new Set(["cancelled", "refunded"]);

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function firstDefined(values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function valueAt(source, path) {
  let value = source;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = value[key];
  }
  return value;
}

function firstPath(source, paths) {
  return firstDefined(paths.map((path) => valueAt(source, path)));
}

function firstMoneyPath(source, paths) {
  for (const path of paths) {
    const parsed = money(valueAt(source, path));
    if (parsed !== null) return parsed;
  }
  return null;
}

function money(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value && typeof value === "object") {
    return money(firstDefined([
      value.amount,
      value.value,
      value.sum,
      value.money,
      value.price,
      value.cny,
    ]));
  }
  let raw = text(value);
  if (!raw) return null;
  const negativeParentheses = /^\(.*\)$/u.test(raw);
  raw = raw.replace(/[()\s\u00a0]/gu, "");
  if (!raw.includes(".") && /^-?\d+,\d{1,2}$/u.test(raw)) raw = raw.replace(",", ".");
  else raw = raw.replace(/,/gu, "");
  const match = raw.match(/-?\d+(?:\.\d+)?/u);
  if (!match) return null;
  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed)) return null;
  return negativeParentheses ? -Math.abs(parsed) : parsed;
}

function rounded(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function normalizedFieldName(value) {
  return text(value)
    .toLocaleLowerCase("und")
    .replace(/(?:cny|rmb|rub|руб|人民币|卢布)/gu, "")
    .replace(/[\s_\-—–:：/\\()[\]{}.,，。]+/gu, "");
}

const PROFIT_ALIASES = new Map();

function registerAliases(field, aliases) {
  for (const alias of aliases) PROFIT_ALIASES.set(normalizedFieldName(alias), field);
}

registerAliases("amount_cny", [
  "amount", "amount_cny", "order_amount", "order_amount_cny", "sale_amount", "sales_amount",
  "revenue", "income", "goods_amount", "total_amount_cny", "商品金额", "订单金额", "销售金额", "销售收入", "实收金额",
  "成交金额", "выручка", "сумма заказа",
]);
registerAliases("purchase_cost_cny", [
  "purchase", "purchase_cost", "purchase_cost_cny", "purchase_amount", "procurement_cost",
  "product_cost", "goods_cost", "cost_cny", "total_cost", "采购成本", "采购金额", "商品成本", "货品成本", "себестоимость",
]);
registerAliases("commission_cny", [
  "commission", "commission_cny", "commission_fee", "platform_commission", "ozon_commission", "cate_fee", "sale_commission_cny",
  "佣金", "平台佣金", "ozon佣金", "категорийная комиссия", "комиссия",
]);
registerAliases("international_logistics_cny", [
  "international_logistics", "international_logistics_cny", "international_shipping", "cross_border_logistics",
  "first_mile", "logistics_fee", "logistics_cny", "processing_and_delivery_cny", "国际物流", "跨境物流", "头程物流", "物流费",
]);
registerAliases("last_mile_cny", [
  "last_mile", "last_mile_cny", "last_mile_delivery", "tail_delivery", "final_delivery", "delivery_fee", "services_amount_cny",
  "尾程", "尾程物流", "尾程派送", "末端配送", "последняя миля",
]);
registerAliases("other_cost_cny", [
  "other_cost", "other_cost_cny", "other_fee", "other_expense", "service_fee", "misc_fee", "others_amount_cny",
  "其他费用", "其它费用", "其他成本", "服务费", "прочие расходы",
]);
registerAliases("refund_cny", [
  "refund", "refund_cny", "refund_amount", "refund_loss", "return_loss", "return_amount",
  "退款", "退款损失", "退货损失", "возврат",
]);
registerAliases("erp_profit_cny", [
  "profit", "profit_cny", "erp_profit", "erp_profit_cny", "net_profit", "ERP利润", "利润", "净利润", "прибыль",
]);

function parseJson(value) {
  if (typeof value !== "string") return value;
  const raw = value.trim();
  if (!raw || !/^[{[]/u.test(raw)) return value;
  try { return JSON.parse(raw); } catch { return value; }
}

function collectProfitEntries(value, entries, inheritedLabel = "") {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectProfitEntries(item, entries, inheritedLabel);
    return;
  }
  if (!parsed || typeof parsed !== "object") {
    if (inheritedLabel) entries.push([inheritedLabel, parsed]);
    return;
  }
  const explicitLabel = text(firstDefined([
    parsed.key,
    parsed.code,
    parsed.type,
    parsed.name,
    parsed.label,
    parsed.title,
  ]));
  const explicitAmount = money(firstDefined([
    parsed.amount,
    parsed.value,
    parsed.sum,
    parsed.money,
    parsed.price,
    parsed.cny,
  ]));
  if ((explicitLabel || inheritedLabel) && explicitAmount !== null) {
    entries.push([explicitLabel || inheritedLabel, explicitAmount]);
    return;
  }
  for (const [key, item] of Object.entries(parsed)) {
    const direct = money(item);
    if (direct !== null) entries.push([key, direct]);
    else if (item && typeof item === "object") collectProfitEntries(item, entries, key);
  }
}

export function normalizeErpProfitList(value) {
  const result = Object.fromEntries([...PROFIT_FIELDS, "erp_profit_cny"].map((field) => [field, null]));
  const entries = [];
  collectProfitEntries(value, entries);
  for (const [label, rawAmount] of entries) {
    const field = PROFIT_ALIASES.get(normalizedFieldName(label));
    if (!field) continue;
    const amount = money(rawAmount);
    if (amount === null) continue;
    const normalized = EXPENSE_FIELDS.has(field) ? Math.abs(amount) : amount;
    if (field === "erp_profit_cny") {
      if (result[field] === null) result[field] = normalized;
    } else {
      result[field] = rounded(Number(result[field] || 0) + normalized, 4);
    }
  }
  return result;
}

const TOP_LEVEL_PROFIT_PATHS = Object.freeze({
  amount_cny: [
    "amount_cny", "order_amount_cny", "sale_amount_cny", "sales_amount_cny", "revenue_cny",
    "amount", "order_amount", "sale_amount", "financial.amount_cny", "data.amount_cny", "data.order_amount_cny",
  ],
  purchase_cost_cny: [
    "purchase_cost_cny", "purchase_amount_cny", "procurement_cost_cny", "product_cost_cny", "goods_cost_cny",
    "cost_cny", "financial.purchase_cost_cny", "data.purchase_cost_cny",
  ],
  commission_cny: [
    "commission_cny", "commission_fee_cny", "platform_commission_cny", "ozon_commission_cny", "cate_fee_cny",
    "financial.commission_cny", "data.commission_cny",
  ],
  international_logistics_cny: [
    "international_logistics_cny", "international_shipping_cny", "cross_border_logistics_cny", "first_mile_cny",
    "logistics_cny", "logistics_fee_cny", "financial.international_logistics_cny", "data.international_logistics_cny",
  ],
  last_mile_cny: [
    "last_mile_cny", "last_mile_delivery_cny", "tail_delivery_cny", "final_delivery_cny", "delivery_fee_cny",
    "financial.last_mile_cny", "data.last_mile_cny",
  ],
  other_cost_cny: [
    "other_cost_cny", "other_fee_cny", "other_expense_cny", "service_fee_cny", "misc_fee_cny",
    "financial.other_cost_cny", "data.other_cost_cny",
  ],
  refund_cny: [
    "refund_cny", "refund_amount_cny", "refund_loss_cny", "return_loss_cny", "return_amount_cny",
    "financial.refund_cny", "data.refund_cny",
  ],
  erp_profit_cny: [
    "erp_profit_cny", "profit_cny", "net_profit_cny", "financial.profit_cny", "data.profit_cny",
  ],
});

export function calculateContributionProfit(value = {}) {
  const rawProfitList = firstPath(value, ["profit_list", "profitList", "financial.profit_list", "data.profit_list"]);
  const profitList = normalizeErpProfitList(rawProfitList);
  const components = {};
  for (const field of PROFIT_FIELDS) {
    const direct = firstMoneyPath(value, TOP_LEVEL_PROFIT_PATHS[field]);
    const candidate = direct === null ? profitList[field] : direct;
    components[field] = candidate === null
      ? null
      : rounded(EXPENSE_FIELDS.has(field) ? Math.abs(candidate) : candidate, 4);
  }
  const directErpProfit = firstMoneyPath(value, TOP_LEVEL_PROFIT_PATHS.erp_profit_cny);
  const erpProfitCny = directErpProfit === null ? profitList.erp_profit_cny : directErpProfit;
  const missingFields = PROFIT_FIELDS.filter((field) => components[field] === null);
  const dataComplete = missingFields.length === 0;
  const contributionProfitCny = dataComplete
    ? rounded(
      components.amount_cny
        - components.purchase_cost_cny
        - components.commission_cny
        - components.international_logistics_cny
        - components.last_mile_cny
        - components.other_cost_cny
        - components.refund_cny,
    )
    : null;
  const normalizedErpProfit = erpProfitCny === null ? null : rounded(erpProfitCny);
  return {
    components,
    contribution_profit_cny: contributionProfitCny,
    erp_profit_cny: normalizedErpProfit,
    profit_difference_cny: contributionProfitCny !== null && normalizedErpProfit !== null
      ? rounded(contributionProfitCny - normalizedErpProfit)
      : null,
    data_complete: dataComplete,
    missing_fields: missingFields,
  };
}

function allocationWeights(products) {
  const raw = products.map((product) => {
    const price = money(product?.price);
    const quantity = money(product?.quantity);
    return Math.max(0, Number(price || 0) * Math.max(0, quantity === null ? 1 : quantity));
  });
  if (raw.some((value) => value > 0)) return raw;
  return raw.map(() => 1);
}

function allocateMoney(total, weights) {
  if (total === null || total === undefined) return weights.map(() => null);
  if (weights.length === 1) return [rounded(Number(total), 4)];
  const denominator = weights.reduce((sum, value) => sum + value, 0);
  const residualIndex = weights.findLastIndex((weight) => weight > 0);
  let remaining = rounded(Number(total), 4);
  return weights.map((weight, index) => {
    if (index === residualIndex) return remaining;
    if (!(weight > 0)) return 0;
    const allocated = rounded(Number(total) * (weight / denominator), 4);
    remaining = rounded(remaining - allocated, 4);
    return allocated;
  });
}

/**
 * Expand Maozi's live order shape (`products[]` plus an order-level
 * `profit_list`) into the product lines consumed by the learning aggregator.
 * Monetary values are allocated by price * quantity and the final line keeps
 * the rounding residual, so line totals always equal the ERP order totals.
 */
export function expandMaoziOrderRows(orders = []) {
  const lines = [];
  for (const order of orders || []) {
    if (!order || typeof order !== "object") continue;
    const products = Array.isArray(order.products) && order.products.length > 0
      ? order.products
      : [null];
    const weights = allocationWeights(products);
    const rawRefund = firstMoneyPath(order, TOP_LEVEL_PROFIT_PATHS.refund_cny)
      ?? normalizeErpProfitList(firstPath(order, ["profit_list", "profitList"])).refund_cny;
    const contribution = calculateContributionProfit(
      rawRefund === null ? { ...order, refund_cny: 0 } : order,
    );
    const allocations = Object.fromEntries([
      ...PROFIT_FIELDS.map((field) => [field, allocateMoney(contribution.components[field], weights)]),
      ["erp_profit_cny", allocateMoney(contribution.erp_profit_cny, weights)],
    ]);
    const orderId = text(firstPath(order, [
      "order_id", "posting_number", "order_number", "posting_id", "id",
    ]));
    const orderTime = firstPath(order, [
      "in_process_at", "order_time", "ordered_at", "order_date", "created_at",
    ]);
    const updatedAt = firstPath(order, [
      "update_time", "updated_at", "status_updated_at", "in_process_at", "created_at",
    ]);
    const { products: _products, ...orderFields } = order;
    products.forEach((productValue, index) => {
      const product = productValue && typeof productValue === "object" ? productValue : {};
      const productIdentity = text(firstDefined([
        product.order_line_id,
        product.line_id,
        product.item_id,
        product.id,
        product.sku,
        product.offer_id,
      ])) || "product";
      lines.push({
        ...orderFields,
        ...product,
        product,
        order_id: orderId,
        order_line_id: `${productIdentity}:${index + 1}`,
        shop_id: order.shop_id ?? order.store_id ?? order.shopId ?? order.storeId,
        status: order.status ?? order.order_status ?? order.posting_status,
        order_time: orderTime,
        updated_at: updatedAt,
        sku: product.sku ?? order.sku,
        offer_id: product.offer_id ?? order.offer_id ?? order.vendor_code,
        title: product.name ?? product.title ?? order.title,
        name: product.name ?? product.title ?? order.name,
        price: product.price ?? order.price,
        quantity: product.quantity ?? order.quantity ?? 1,
        ...Object.fromEntries(PROFIT_FIELDS.map((field) => [field, allocations[field][index]])),
        erp_profit_cny: allocations.erp_profit_cny[index],
      });
    });
  }
  return lines;
}

function canonicalStatus(value) {
  const raw = text(value).toLocaleLowerCase("und");
  if (!raw) return "unknown";
  const compact = raw.replace(/[\s_\-—–:：/\\()[\]{}.,，。]+/gu, "");
  if (/(cancel|отмен|取消)/u.test(compact)) return "cancelled";
  if (/(refund|returned|return|возврат|退款|退货)/u.test(compact)) return "refunded";
  if (/(delivered|доставлен|妥投|已签收|签收)/u.test(compact)) return "delivered";
  if (/(completed|complete|finished|fulfilled|заверш|выполн|已完成|完成)/u.test(compact)) return "completed";
  return "other";
}

function isoTimestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(text(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function mappingValue(mapping, storeId, value) {
  const key = text(value);
  if (!mapping || !key) return "";
  const candidates = [`${storeId}:${key}`, key];
  for (const candidate of candidates) {
    const found = mapping instanceof Map ? mapping.get(candidate) : mapping[candidate];
    if (found !== undefined && found !== null) {
      return text(found?.source_sku ?? found?.sku ?? found?.value ?? found);
    }
  }
  return "";
}

function explicitKeywords(value) {
  const values = Array.isArray(value) ? value : text(value).split(/[,，;；|]/u);
  return values.map((item) => text(item).toLocaleLowerCase("und")).filter(Boolean);
}

function keywordsFromTitle(value) {
  return (text(value).toLocaleLowerCase("und").match(/[\p{L}\p{N}]+/gu) || [])
    .filter((token) => token.length >= 2);
}

function uniqueKeywords(value, title) {
  return [...new Set([
    ...explicitKeywords(value),
    ...keywordsFromTitle(title),
  ])].slice(0, 12);
}

function negativeFeedback(value = {}) {
  const explicit = firstDefined([
    value.negative_feedback,
    value.has_negative_feedback,
    value.data?.negative_feedback,
  ]);
  if (explicit === true || explicit === 1 || text(explicit).toLowerCase() === "true") return true;
  const decision = text(firstDefined([
    value.feedback_result,
    value.feedback_status,
    value.audit_result,
    value.review_result,
    value.data?.feedback_result,
  ])).toLocaleLowerCase("und");
  return /(亏本|无法采购|错货|错规格|negative|invalid|blocked|unavailable|mismatch)/u.test(decision);
}

export function normalizeErpOrderLine(row = {}, {
  sourceSkuByOfferId = null,
  sourceSkuByStoreSku = null,
  sourceSkuFor = null,
} = {}) {
  const storeId = text(firstPath(row, [
    "store_id", "shop_id", "storeId", "shopId", "store.id", "shop.id", "data.store_id", "data.shop_id",
  ]));
  const storeSku = text(firstPath(row, [
    "store_sku", "own_ozon_sku", "ozon_sku", "seller_sku", "sku", "product.sku", "item.sku", "data.store_sku",
  ]));
  const offerId = text(firstPath(row, [
    "offer_id", "own_offer_id", "seller_offer_id", "vendor_code", "product.offer_id", "item.offer_id", "data.offer_id",
  ]));
  let sourceSku = text(firstPath(row, [
    "source_sku", "follow_sku", "origin_sku", "source.sku", "product.source_sku", "item.source_sku", "data.source_sku",
  ]));
  if (!sourceSku && typeof sourceSkuFor === "function") {
    sourceSku = text(sourceSkuFor({ store_id: storeId, store_sku: storeSku, offer_id: offerId, row }));
  }
  sourceSku ||= mappingValue(sourceSkuByOfferId, storeId, offerId);
  sourceSku ||= mappingValue(sourceSkuByStoreSku, storeId, storeSku);
  const productKey = sourceSku
    ? `source_sku:${sourceSku}`
    : offerId
      ? `offer_id:${offerId}`
      : storeSku
        ? `store_sku:${storeSku}`
        : "";
  const statusRaw = text(firstPath(row, [
    "status", "order_status", "posting_status", "state", "order.status", "posting.status", "data.status",
  ]));
  const orderTime = isoTimestamp(firstPath(row, [
    "order_time", "ordered_at", "order_date", "created_at", "in_process_at", "order.created_at", "posting.created_at", "data.order_time",
  ]));
  const updatedAt = isoTimestamp(firstPath(row, [
    "updated_at", "status_updated_at", "order.updated_at", "posting.updated_at", "data.updated_at",
  ]));
  const profit = calculateContributionProfit(row);
  const title = text(firstPath(row, [
    "title", "product_title", "name", "product.name", "item.name", "data.title",
  ]));
  return {
    store_id: storeId,
    store_sku: storeSku,
    offer_id: offerId,
    source_sku: sourceSku,
    product_key: productKey,
    order_id: text(firstPath(row, [
      "order_id", "posting_number", "order_number", "posting_id", "order.id", "posting.id", "data.order_id",
    ])),
    order_line_id: text(firstPath(row, [
      "order_line_id", "line_id", "item_id", "order_item_id", "product.id", "item.id", "data.order_line_id",
    ])),
    status: canonicalStatus(statusRaw),
    status_raw: statusRaw,
    order_time: orderTime,
    updated_at: updatedAt,
    profit_list: profit.components,
    contribution_profit_cny: profit.contribution_profit_cny,
    erp_profit_cny: profit.erp_profit_cny,
    profit_difference_cny: profit.profit_difference_cny,
    profit_data_complete: profit.data_complete,
    missing_profit_fields: profit.missing_fields,
    category: text(firstPath(row, [
      "category", "category_name", "product_category", "product.category", "item.category", "data.category",
    ])),
    title,
    title_keywords: uniqueKeywords(firstPath(row, ["title_keywords", "keywords", "data.title_keywords"]), title),
    negative_feedback: negativeFeedback(row),
  };
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), "und", { numeric: true, sensitivity: "base" });
}

function preferredLabel(counts) {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
    .map(([value]) => value)[0] || "";
}

function externalNegativeKeys(rows, normalizationOptions) {
  const keys = new Set();
  for (const row of rows || []) {
    if (typeof row === "string" || typeof row === "number") {
      const value = text(row);
      if (!value) continue;
      if (/^(?:source_sku|offer_id|store_sku):/u.test(value)) keys.add(`*|${value}`);
      else {
        keys.add(`*|source_sku:${value}`);
        keys.add(`*|offer_id:${value}`);
        keys.add(`*|store_sku:${value}`);
      }
      continue;
    }
    const normalized = normalizeErpOrderLine(row, normalizationOptions);
    const productKey = text(row?.product_key) || normalized.product_key;
    if (productKey) keys.add(`${normalized.store_id || "*"}|${productKey}`);
  }
  return keys;
}

function normalizeGeneratedAt(value) {
  const iso = isoTimestamp(value);
  if (!iso) throw new TypeError("profit learning generatedAt must be a valid timestamp");
  return iso;
}

function canonicalOrderProductIdentity(row, index) {
  const orderIdentity = row.order_id || `row:${index}`;
  const productIdentity = row.store_sku || row.offer_id || row.product_key;
  return `${row.store_id}|${orderIdentity}|${productIdentity}`;
}

function snapshotUpdatedMs(row) {
  return Date.parse(row.updated_at || row.order_time || "") || Date.parse(row.order_time || "") || 0;
}

function mergeOrderAndRefundSnapshot(base, refund) {
  if (!base) return { ...refund, refund_event: true };
  if (!refund) return base;

  const embeddedRefund = Number(base.profit_list?.refund_cny);
  const separateRefund = Number(refund.profit_list?.refund_cny);
  const embeddedAmount = Number.isFinite(embeddedRefund) && embeddedRefund > 0 ? embeddedRefund : 0;
  const separateAmount = Number.isFinite(separateRefund) && separateRefund > 0 ? separateRefund : 0;
  // A later order snapshot is treated as the final ERP ledger. Otherwise add
  // only a refund amount that is not already embedded in that ledger.
  const orderLedgerIsFinal = snapshotUpdatedMs(base) >= snapshotUpdatedMs(refund);
  const additionalRefund = embeddedAmount > 0 || orderLedgerIsFinal ? 0 : separateAmount;
  const hasBaseContribution = base.contribution_profit_cny !== null
    && Number.isFinite(Number(base.contribution_profit_cny));
  const hasRefundErpProfit = refund.erp_profit_cny !== null
    && Number.isFinite(Number(refund.erp_profit_cny));
  const hasBaseErpProfit = base.erp_profit_cny !== null
    && Number.isFinite(Number(base.erp_profit_cny));
  const contributionProfit = hasBaseContribution
    ? rounded(Number(base.contribution_profit_cny) - additionalRefund)
    : null;
  const erpProfit = hasRefundErpProfit
    ? rounded(Number(refund.erp_profit_cny))
    : hasBaseErpProfit
      ? rounded(Number(base.erp_profit_cny) - additionalRefund)
      : null;
  return {
    ...base,
    updated_at: snapshotUpdatedMs(refund) > snapshotUpdatedMs(base) ? refund.updated_at : base.updated_at,
    profit_list: {
      ...base.profit_list,
      refund_cny: rounded(embeddedAmount + additionalRefund),
    },
    contribution_profit_cny: contributionProfit,
    erp_profit_cny: erpProfit,
    profit_difference_cny: contributionProfit !== null && erpProfit !== null
      ? rounded(contributionProfit - erpProfit)
      : null,
    refund_event: true,
  };
}

export function aggregateRecentOrderLines(orderLines = [], {
  generatedAt = new Date(),
  windowDays = DEFAULT_PROFIT_WINDOW_DAYS,
  sourceSkuByOfferId = null,
  sourceSkuByStoreSku = null,
  sourceSkuFor = null,
  negativeFeedback: feedbackRows = [],
  minimumCompletedOrders = DEFAULT_MOTHER_MIN_ORDERS,
  maximumRefundCancelRate = DEFAULT_MAX_REFUND_CANCEL_RATE,
} = {}) {
  const generatedAtIso = normalizeGeneratedAt(generatedAt);
  const endedMs = Date.parse(generatedAtIso);
  const days = Number(windowDays);
  if (!(Number.isFinite(days) && days > 0)) throw new TypeError("profit learning windowDays must be positive");
  const startedMs = endedMs - days * 24 * 60 * 60_000;
  const normalizationOptions = { sourceSkuByOfferId, sourceSkuByStoreSku, sourceSkuFor };
  const feedbackKeys = externalNegativeKeys(feedbackRows, normalizationOptions);
  const snapshots = new Map();
  for (const [index, raw] of (orderLines || []).entries()) {
    const row = normalizeErpOrderLine(raw, normalizationOptions);
    const orderedMs = Date.parse(row.order_time || "");
    if (!row.store_id || !row.product_key || !Number.isFinite(orderedMs) || orderedMs < startedMs || orderedMs > endedMs) continue;
    const key = canonicalOrderProductIdentity(row, index);
    const updatedMs = snapshotUpdatedMs(row) || orderedMs;
    const entry = snapshots.get(key) || { base: null, refund: null, index };
    const slot = row.status === "refunded" ? "refund" : "base";
    if (!entry[slot] || updatedMs >= entry[slot].updated_ms) entry[slot] = { row, updated_ms: updatedMs };
    snapshots.set(key, entry);
  }
  const deduplicated = new Map();
  for (const [key, entry] of snapshots.entries()) {
    const base = entry.base?.row || null;
    const refund = entry.refund?.row || null;
    const row = mergeOrderAndRefundSnapshot(base, refund);
    if (!row) continue;
    deduplicated.set(key, {
      row,
      updated_ms: Math.max(entry.base?.updated_ms || 0, entry.refund?.updated_ms || 0),
      index: entry.index,
    });
  }

  const grouped = new Map();
  for (const { row, index } of deduplicated.values()) {
    const key = `${row.store_id}|${row.product_key}`;
    const group = grouped.get(key) || {
      store_id: row.store_id,
      source_sku: row.source_sku,
      product_key: row.product_key,
      rows: [],
    };
    if (!group.source_sku && row.source_sku) group.source_sku = row.source_sku;
    group.rows.push({ ...row, input_index: index });
    grouped.set(key, group);
  }

  const minimumOrders = Math.max(1, Math.floor(Number(minimumCompletedOrders) || DEFAULT_MOTHER_MIN_ORDERS));
  const maximumRate = Number(maximumRefundCancelRate);
  if (!(Number.isFinite(maximumRate) && maximumRate >= 0 && maximumRate <= 1)) {
    throw new TypeError("profit learning maximumRefundCancelRate must be between 0 and 1");
  }
  const groups = [];
  for (const group of grouped.values()) {
    const observedOrderIds = new Set();
    const completedOrderIds = new Set();
    const refundCancelOrderIds = new Set();
    const incompleteOrderIds = new Set();
    const storeSkus = new Set();
    const offerIds = new Set();
    const categoryCounts = new Map();
    const keywordCounts = new Map();
    let contributionProfit = 0;
    let realProfit = 0;
    let erpProfit = 0;
    let erpProfitRows = 0;
    let hasNegativeFeedback = false;
    for (const row of group.rows) {
      const orderIdentity = row.order_id || `row:${row.input_index}`;
      observedOrderIds.add(orderIdentity);
      if (row.store_sku) storeSkus.add(row.store_sku);
      if (row.offer_id) offerIds.add(row.offer_id);
      const refundAmount = Number(row.profit_list?.refund_cny);
      if (row.refund_event || REFUND_CANCEL_STATUSES.has(row.status) || (Number.isFinite(refundAmount) && refundAmount > 0)) {
        refundCancelOrderIds.add(orderIdentity);
      }
      hasNegativeFeedback ||= row.negative_feedback;
      if (!COMPLETED_STATUSES.has(row.status)) {
        if (REFUND_CANCEL_STATUSES.has(row.status)) {
          const hasRefundErpProfit = row.erp_profit_cny !== null
            && Number.isFinite(Number(row.erp_profit_cny));
          if (hasRefundErpProfit) {
            contributionProfit += Number(row.erp_profit_cny);
            realProfit += Number(row.erp_profit_cny);
          } else if (Number.isFinite(refundAmount) && refundAmount > 0) {
            contributionProfit -= refundAmount;
            realProfit -= refundAmount;
          }
        }
        continue;
      }
      completedOrderIds.add(orderIdentity);
      const hasErpProfit = row.erp_profit_cny !== null && Number.isFinite(Number(row.erp_profit_cny));
      if (row.profit_data_complete) contributionProfit += Number(row.contribution_profit_cny);
      if (hasErpProfit) {
        const authoritativeProfit = Number(row.erp_profit_cny);
        erpProfit += authoritativeProfit;
        erpProfitRows += 1;
        realProfit += authoritativeProfit;
      } else if (row.profit_data_complete) {
        realProfit += Number(row.contribution_profit_cny);
      } else {
        incompleteOrderIds.add(orderIdentity);
      }
      if (row.category) categoryCounts.set(row.category, Number(categoryCounts.get(row.category) || 0) + 1);
      for (const keyword of row.title_keywords) keywordCounts.set(keyword, Number(keywordCounts.get(keyword) || 0) + 1);
    }
    hasNegativeFeedback ||= feedbackKeys.has(`${group.store_id}|${group.product_key}`)
      || feedbackKeys.has(`*|${group.product_key}`);
    const observedOrderCount = observedOrderIds.size;
    const completedOrderCount = completedOrderIds.size;
    const refundCancelCount = refundCancelOrderIds.size;
    const refundCancelRate = observedOrderCount > 0 ? refundCancelCount / observedOrderCount : 0;
    const profitDataComplete = incompleteOrderIds.size === 0 && completedOrderCount > 0;
    const roundedProfit = rounded(contributionProfit);
    const roundedRealProfit = rounded(realProfit);
    groups.push({
      store_id: group.store_id,
      source_sku: group.source_sku || null,
      product_key: group.product_key,
      store_skus: [...storeSkus].sort(compareText),
      offer_ids: [...offerIds].sort(compareText),
      category: preferredLabel(categoryCounts) || null,
      title_keywords: [...keywordCounts.entries()]
        .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
        .slice(0, 8)
        .map(([keyword]) => keyword),
      observed_order_count: observedOrderCount,
      completed_order_count: completedOrderCount,
      refund_cancel_count: refundCancelCount,
      refund_cancel_rate: rounded(refundCancelRate, 4),
      contribution_profit_cny: roundedProfit,
      erp_profit_cny: erpProfitRows > 0 ? rounded(erpProfit) : null,
      real_profit_cny: roundedRealProfit,
      incomplete_profit_order_count: incompleteOrderIds.size,
      profit_data_complete: profitDataComplete,
      negative_feedback: hasNegativeFeedback,
      eligible: completedOrderCount >= minimumOrders
        && profitDataComplete
        && roundedRealProfit > 0
        && refundCancelRate <= maximumRate
        && !hasNegativeFeedback,
    });
  }
  groups.sort((left, right) => compareText(left.store_id, right.store_id) || compareText(left.product_key, right.product_key));
  return {
    version: PROFIT_LEARNING_VERSION,
    generated_at: generatedAtIso,
    window: {
      days,
      started_at: new Date(startedMs).toISOString(),
      ended_at: generatedAtIso,
    },
    groups,
  };
}

export function buildPriorityMotherProducts(orderLines = [], options = {}) {
  const aggregation = aggregateRecentOrderLines(orderLines, options);
  const configuredStoreIds = (options.storeIds || []).map(text).filter(Boolean);
  const storeIds = [...new Set([
    ...configuredStoreIds,
    ...aggregation.groups.map((group) => group.store_id),
  ])].sort(compareText);
  const stores = storeIds.map((storeId) => ({
    store_id: storeId,
    mother_products: aggregation.groups
      .filter((group) => group.store_id === storeId && group.eligible)
      .sort((left, right) => (
        right.real_profit_cny - left.real_profit_cny
          || right.completed_order_count - left.completed_order_count
          || compareText(left.product_key, right.product_key)
      ))
      .map((group) => ({
        source_sku: group.source_sku,
        product_key: group.product_key,
        store_skus: group.store_skus,
        offer_ids: group.offer_ids,
        category: group.category,
        title_keywords: group.title_keywords,
        order_count: group.completed_order_count,
        real_profit_cny: group.real_profit_cny,
        contribution_profit_cny: group.contribution_profit_cny,
        refund_cancel_rate: group.refund_cancel_rate,
      })),
  }));
  return {
    version: aggregation.version,
    generated_at: aggregation.generated_at,
    window: aggregation.window,
    stores,
  };
}
