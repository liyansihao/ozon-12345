const SCHEMA_VERSION = 1;

export const FEEDBACK_RESULTS = Object.freeze({
  NORMAL: "正常",
  LOSS: "亏本",
  UNAVAILABLE: "无法采购",
  WRONG_ITEM: "错货",
  WRONG_SPEC: "错规格",
});

const RESULT_CODES = Object.freeze({
  [FEEDBACK_RESULTS.NORMAL]: "normal",
  [FEEDBACK_RESULTS.LOSS]: "loss",
  [FEEDBACK_RESULTS.UNAVAILABLE]: "unavailable",
  [FEEDBACK_RESULTS.WRONG_ITEM]: "wrong_item",
  [FEEDBACK_RESULTS.WRONG_SPEC]: "wrong_spec",
});

const HEADER_ALIASES = Object.freeze({
  store_sku: [
    "本店Ozon SKU", "本店SKU", "Ozon SKU", "店铺SKU", "店铺商品SKU", "store_sku", "ozon_sku", "store_ozon_sku",
  ],
  result: [
    "核对结果", "核价结果", "审核结果", "检查结果", "结果", "result", "review_result", "check_result", "status",
  ],
  actual_cost: [
    "实际采购价", "实际采购价格", "实际成本", "商品采购价", "采购价", "actual_cost", "purchase_cost", "actual_purchase_price",
  ],
  correct_1688_url: [
    "正确1688链接", "正确1688商品链接", "正确货源链接", "正确链接", "correct_1688_url", "correct_offer_url",
  ],
  selected_offer_url: [
    "原1688链接", "当前1688链接", "选中1688链接", "1688商品链接", "1688链接", "货源链接", "selected_offer_url", "offer_url", "source_url",
  ],
  action: ["处理动作", "处理方式", "动作", "action", "handling_action"],
  note: ["备注", "说明", "原因", "note", "notes", "comment", "comments"],
  source_sku: ["跟卖SKU", "跟卖商品SKU", "源SKU", "原始SKU", "source_sku", "source_ozon_sku"],
  selected_offer_id: [
    "1688货源ID", "1688商品ID", "1688 Offer ID", "选中Offer ID", "selected_offer_id", "offer_id",
  ],
  store_id: ["店铺ID", "商店ID", "store_id", "shop_id"],
  updated_at: ["核对时间", "反馈时间", "更新时间", "导入时间", "updated_at", "feedback_at", "reviewed_at", "imported_at"],
});

function normalizedToken(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/^\uFEFF/u, "")
    .toLocaleLowerCase("und")
    .replace(/[\s_\-—:：/\\()[\]{}（）【】,.，。]+/gu, "")
    .trim();
}

const HEADER_BY_ALIAS = new Map();
for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
  HEADER_BY_ALIAS.set(normalizedToken(canonical), canonical);
  for (const alias of aliases) HEADER_BY_ALIAS.set(normalizedToken(alias), canonical);
}

const RESULT_BY_ALIAS = new Map();
function addResultAliases(result, aliases) {
  for (const alias of [result, ...aliases]) RESULT_BY_ALIAS.set(normalizedToken(alias), result);
}
addResultAliases(FEEDBACK_RESULTS.NORMAL, [
  "通过", "正确", "没问题", "无问题", "可采购", "可用", "正常可用", "normal", "ok", "okay", "pass", "passed", "correct", "valid", "matched",
]);
addResultAliases(FEEDBACK_RESULTS.LOSS, [
  "亏损", "赔钱", "无利润", "负利润", "利润不足", "低利润", "loss", "losing", "unprofitable", "negative profit", "low profit",
]);
addResultAliases(FEEDBACK_RESULTS.UNAVAILABLE, [
  "不能采购", "不可采购", "无法购买", "不能购买", "采购不了", "无法下单", "缺货", "无货", "链接失效", "已下架", "unavailable", "cannot purchase", "can't purchase", "cannot buy", "can't buy", "out of stock", "no stock", "discontinued",
]);
addResultAliases(FEEDBACK_RESULTS.WRONG_ITEM, [
  "货不对版", "不是同款", "非同款", "商品错误", "wrong item", "incorrect item", "item mismatch", "wrong product", "not same item", "mismatch",
]);
addResultAliases(FEEDBACK_RESULTS.WRONG_SPEC, [
  "规格错误", "型号错误", "尺寸错误", "款式错误", "wrong spec", "incorrect spec", "wrong specification", "wrong variant", "wrong size", "variant mismatch", "spec mismatch",
]);

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizedIso(value, fallback = null) {
  const candidate = value ?? fallback;
  const milliseconds = candidate instanceof Date
    ? candidate.getTime()
    : Date.parse(String(candidate ?? ""));
  if (!Number.isFinite(milliseconds)) throw new TypeError("feedback updated_at must be a valid timestamp");
  return new Date(milliseconds).toISOString();
}

function normalizedCost(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const numeric = Number(String(value)
    .normalize("NFKC")
    .replace(/(?:CNY|RMB|人民币|元|¥|￥)/giu, "")
    .replace(/,/gu, "")
    .trim());
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new TypeError("actual purchase cost must be a positive number");
  }
  return numeric;
}

export function normalizeFeedbackHeader(value) {
  return HEADER_BY_ALIAS.get(normalizedToken(value)) || null;
}

export function normalizeFeedbackResult(value) {
  const token = normalizedToken(value);
  const exact = RESULT_BY_ALIAS.get(token);
  if (exact) return exact;
  if (/错规格|规格错误|型号错误|尺寸错误|wrong(?:spec|specification|variant|size)|incorrectspec|(?:spec|variant)mismatch/iu.test(token)) {
    return FEEDBACK_RESULTS.WRONG_SPEC;
  }
  if (/错货|货不对版|不是同款|非同款|wrong(?:item|product)|notsameitem|itemmismatch|incorrectitem/iu.test(token)) {
    return FEEDBACK_RESULTS.WRONG_ITEM;
  }
  if (/无法采购|不能采购|不可采购|无法购买|不能购买|采购不了|无法下单|缺货|无货|链接失效|unavailable|cannot(?:purchase|buy)|cant(?:purchase|buy)|outofstock|nostock|discontinued/iu.test(token)) {
    return FEEDBACK_RESULTS.UNAVAILABLE;
  }
  if (/亏本|亏损|赔钱|无利润|负利润|利润不足|unprofitable|negativeprofit|lowprofit|losing/iu.test(token)) {
    return FEEDBACK_RESULTS.LOSS;
  }
  if (/正常|通过|没问题|无问题|^ok$|^okay$|^pass(?:ed)?$|^correct$|^valid$|^matched$/iu.test(token)) {
    return FEEDBACK_RESULTS.NORMAL;
  }
  return null;
}

export function normalizeOfferUrl(value) {
  const text = cleanText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!/^https?:$/iu.test(url.protocol)) return text;
    url.hostname = url.hostname.toLocaleLowerCase("und");
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:spm|utm_.+|from|source|traceid|sk)$/iu.test(key)) url.searchParams.delete(key);
    }
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString();
  } catch {
    return text;
  }
}

export function offerIdFromUrl(value) {
  const text = cleanText(value);
  if (!text) return null;
  const pathMatch = text.match(/\/offer\/(\d+)(?:\.html)?(?:[/?#]|$)/iu);
  if (pathMatch) return pathMatch[1];
  try {
    const url = new URL(text);
    for (const key of ["offerId", "offer_id", "id"]) {
      const identifier = cleanText(url.searchParams.get(key));
      if (identifier) return identifier;
    }
  } catch {}
  return null;
}

function aliasedObject(row = {}) {
  const result = {};
  for (const [header, value] of Object.entries(row || {})) {
    const canonical = normalizeFeedbackHeader(header);
    if (!canonical) continue;
    if (result[canonical] === undefined || result[canonical] === null || result[canonical] === "") {
      result[canonical] = value;
    }
  }
  return result;
}

export function stableFeedbackKey({ store_id: storeId, store_sku: storeSku } = {}) {
  const sku = cleanText(storeSku);
  if (!sku) throw new TypeError("feedback requires store_sku");
  const store = cleanText(storeId) || "*";
  return `feedback:v1:${encodeURIComponent(store)}:${encodeURIComponent(sku)}`;
}

export function normalizeFeedbackRow(row = {}, {
  defaultStoreId = null,
  updatedAt = null,
} = {}) {
  const value = aliasedObject(row);
  const storeSku = cleanText(value.store_sku);
  if (!storeSku) throw new TypeError("feedback requires 本店Ozon SKU/store_sku");
  const result = normalizeFeedbackResult(value.result);
  if (!result) throw new TypeError(`unsupported feedback result: ${String(value.result ?? "")}`);
  const storeId = cleanText(value.store_id) || cleanText(defaultStoreId);
  const selectedOfferUrl = normalizeOfferUrl(value.selected_offer_url);
  const correct1688Url = normalizeOfferUrl(value.correct_1688_url);
  const selectedOfferId = cleanText(value.selected_offer_id)
    || offerIdFromUrl(selectedOfferUrl);
  const timestamp = normalizedIso(value.updated_at, updatedAt ?? new Date());
  const normalized = {
    feedback_key: stableFeedbackKey({ store_id: storeId, store_sku: storeSku }),
    store_sku: storeSku,
    store_id: storeId,
    result,
    result_code: RESULT_CODES[result],
    actual_cost: normalizedCost(value.actual_cost),
    source_sku: cleanText(value.source_sku),
    selected_offer_id: selectedOfferId,
    selected_offer_url: selectedOfferUrl,
    correct_1688_url: correct1688Url,
    action: cleanText(value.action),
    note: cleanText(value.note),
    updated_at: timestamp,
  };
  return normalized;
}

export function parseCsvMatrix(text, { delimiter = null } = {}) {
  const input = String(text ?? "").replace(/^\uFEFF/u, "");
  let selectedDelimiter = delimiter;
  if (!selectedDelimiter) {
    const firstLine = input.split(/\r?\n/u, 1)[0] || "";
    const candidates = [",", "\t", ";"];
    selectedDelimiter = candidates.sort((left, right) => (
      firstLine.split(right).length - firstLine.split(left).length
    ))[0];
  }
  if (![",", "\t", ";"].includes(selectedDelimiter)) {
    throw new TypeError("CSV delimiter must be comma, tab, or semicolon");
  }

  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field === "") {
      quoted = true;
    } else if (character === selectedDelimiter) {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new TypeError("CSV has an unterminated quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((values) => values.some((value) => String(value).trim() !== ""));
}

function objectRows(rows, headers = null) {
  if (!Array.isArray(rows)) throw new TypeError("feedback rows must be an array");
  if (rows.length === 0) return [];
  if (!Array.isArray(rows[0])) return rows;
  const matrix = rows;
  const selectedHeaders = headers || matrix[0];
  const offset = headers ? 0 : 1;
  return matrix.slice(offset).map((values) => Object.fromEntries(
    selectedHeaders.map((header, index) => [header, values[index] ?? ""]),
  ));
}

export function mergeFeedbackRecords(existing = [], incoming = [], {
  defaultStoreId = null,
  updatedAt = null,
} = {}) {
  const merged = new Map();
  const batchTimestamp = updatedAt ?? new Date();
  const accept = (raw, fallbackTimestamp) => {
    const normalized = normalizeFeedbackRow(raw, {
      defaultStoreId,
      updatedAt: raw?.updated_at || fallbackTimestamp,
    });
    const previous = merged.get(normalized.feedback_key);
    if (!previous || Date.parse(normalized.updated_at) > Date.parse(previous.updated_at)) {
      merged.set(normalized.feedback_key, normalized);
    }
  };
  for (const row of existing || []) accept(row, batchTimestamp);
  for (const row of incoming || []) accept(row, batchTimestamp);
  return [...merged.values()].sort((left, right) => left.feedback_key.localeCompare(right.feedback_key));
}

export function parseFeedbackRows(rows, {
  headers = null,
  defaultStoreId = null,
  updatedAt = null,
} = {}) {
  const records = [];
  const errors = [];
  const batchTimestamp = updatedAt ?? new Date();
  const values = objectRows(rows, headers);
  for (let index = 0; index < values.length; index += 1) {
    try {
      records.push(normalizeFeedbackRow(values[index], { defaultStoreId, updatedAt: batchTimestamp }));
    } catch (error) {
      errors.push({
        row_number: index + (Array.isArray(rows?.[0]) && !headers ? 2 : 1),
        reason: String(error?.message || error),
      });
    }
  }
  return {
    records: mergeFeedbackRecords([], records, { updatedAt: batchTimestamp }),
    errors,
  };
}

export function parseFeedbackCsv(text, options = {}) {
  const matrix = parseCsvMatrix(text, options);
  return parseFeedbackRows(matrix, options);
}

function maximumUpdatedAt(records, fallback) {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const row of records) maximum = Math.max(maximum, Date.parse(row.updated_at || ""));
  return Number.isFinite(maximum) ? new Date(maximum).toISOString() : normalizedIso(fallback ?? new Date());
}

function offerIdentityTokens({ selected_offer_id: offerId, offer_url: offerUrl, selected_offer_url: selectedUrl } = {}) {
  const tokens = new Set();
  const normalizedId = cleanText(offerId);
  const normalizedUrl = normalizeOfferUrl(offerUrl || selectedUrl);
  if (normalizedId) tokens.add(`id:${normalizedId}`);
  const urlId = offerIdFromUrl(normalizedUrl);
  if (urlId) tokens.add(`id:${urlId}`);
  if (normalizedUrl) tokens.add(`url:${normalizedUrl}`);
  return tokens;
}

function blockKey(prefix, sourceSku, offerId, offerUrl) {
  const identities = [...offerIdentityTokens({ selected_offer_id: offerId, offer_url: offerUrl })].sort();
  if (identities.length === 0) return null;
  const source = sourceSku ? `source:${encodeURIComponent(sourceSku)}|` : "";
  return `${prefix}:${source}${identities[0]}`;
}

export function buildFeedbackArtifacts(records = [], { updatedAt = null } = {}) {
  const normalizedRecords = mergeFeedbackRecords([], records, { updatedAt });
  const artifactUpdatedAt = maximumUpdatedAt(normalizedRecords, updatedAt);
  const trustedRecords = normalizedRecords.filter((row) => (
    row.result === FEEDBACK_RESULTS.NORMAL || row.result === FEEDBACK_RESULTS.LOSS
  ));
  const errorRecords = normalizedRecords.filter((row) => (
    row.result === FEEDBACK_RESULTS.UNAVAILABLE
      || row.result === FEEDBACK_RESULTS.WRONG_ITEM
      || row.result === FEEDBACK_RESULTS.WRONG_SPEC
  ));
  const trusted = trustedRecords
    .filter((row) => row.result === FEEDBACK_RESULTS.NORMAL)
    .map((row) => ({
      feedback_key: row.feedback_key,
      store_sku: row.store_sku,
      store_id: row.store_id,
      source_sku: row.source_sku,
      selected_offer_id: row.selected_offer_id,
      offer_url: row.correct_1688_url || row.selected_offer_url,
      actual_cost: row.actual_cost,
      updated_at: row.updated_at,
    }));
  const costCorrections = trustedRecords
    .filter((row) => row.result === FEEDBACK_RESULTS.LOSS)
    .map((row) => ({
      feedback_key: row.feedback_key,
      store_sku: row.store_sku,
      store_id: row.store_id,
      source_sku: row.source_sku,
      selected_offer_id: row.selected_offer_id,
      offer_url: row.correct_1688_url || row.selected_offer_url,
      actual_cost: row.actual_cost,
      updated_at: row.updated_at,
    }));

  const blockedOffers = errorRecords
    .filter((row) => row.result === FEEDBACK_RESULTS.UNAVAILABLE)
    .map((row) => {
      const offerUrl = row.selected_offer_url;
      const selectedIdentities = offerIdentityTokens({ selected_offer_id: row.selected_offer_id, offer_url: offerUrl });
      const correctIdentities = offerIdentityTokens({ offer_url: row.correct_1688_url });
      if (identitiesOverlap(selectedIdentities, correctIdentities)) return null;
      const key = blockKey("offer", null, row.selected_offer_id, offerUrl);
      if (!key) return null;
      return {
        block_key: key,
        feedback_key: row.feedback_key,
        store_sku: row.store_sku,
        store_id: row.store_id,
        selected_offer_id: row.selected_offer_id || offerIdFromUrl(offerUrl),
        offer_url: offerUrl,
        reason: row.result,
        updated_at: row.updated_at,
      };
    })
    .filter(Boolean);
  const blockedMatches = errorRecords
    .filter((row) => row.result === FEEDBACK_RESULTS.WRONG_ITEM || row.result === FEEDBACK_RESULTS.WRONG_SPEC)
    .map((row) => {
      const sourceSku = cleanText(row.source_sku);
      const offerUrl = row.selected_offer_url;
      const selectedIdentities = offerIdentityTokens({ selected_offer_id: row.selected_offer_id, offer_url: offerUrl });
      const correctIdentities = offerIdentityTokens({ offer_url: row.correct_1688_url });
      if (identitiesOverlap(selectedIdentities, correctIdentities)) return null;
      const key = sourceSku ? blockKey("match", sourceSku, row.selected_offer_id, offerUrl) : null;
      if (!key) return null;
      return {
        block_key: key,
        feedback_key: row.feedback_key,
        store_sku: row.store_sku,
        store_id: row.store_id,
        source_sku: sourceSku,
        selected_offer_id: row.selected_offer_id || offerIdFromUrl(offerUrl),
        offer_url: offerUrl,
        correct_1688_url: row.correct_1688_url,
        reason: row.result,
        updated_at: row.updated_at,
      };
    })
    .filter(Boolean);

  return {
    trusted: {
      contract: "ozon-profit-feedback-trusted-v1",
      schema_version: SCHEMA_VERSION,
      updated_at: artifactUpdatedAt,
      records: trustedRecords,
      trusted,
      cost_corrections: costCorrections,
    },
    errors: {
      contract: "ozon-profit-feedback-errors-v1",
      schema_version: SCHEMA_VERSION,
      updated_at: artifactUpdatedAt,
      records: errorRecords,
      blocked_offers: blockedOffers,
      blocked_matches: blockedMatches,
    },
  };
}

function artifactRecords(artifacts = {}) {
  const trusted = artifacts?.trusted?.records
    || artifacts?.trusted_feedback?.records
    || [];
  const errors = artifacts?.errors?.records
    || artifacts?.error_sources?.records
    || artifacts?.blocked?.records
    || [];
  return [...trusted, ...errors];
}

export function mergeFeedbackArtifacts(existingArtifacts = {}, incomingRecords = [], options = {}) {
  const records = mergeFeedbackRecords(artifactRecords(existingArtifacts), incomingRecords, options);
  return buildFeedbackArtifacts(records, options);
}

function errorArtifact(value = {}) {
  return value?.errors || value?.error_sources || value?.blocked || value;
}

function identitiesOverlap(left, right) {
  for (const token of left) if (right.has(token)) return true;
  return false;
}

export function blockingDecision(value = {}, candidate = {}) {
  const errors = errorArtifact(value);
  const candidateIdentities = offerIdentityTokens({
    selected_offer_id: candidate.selected_offer_id ?? candidate.offer_id,
    offer_url: candidate.selected_offer_url ?? candidate.offer_url ?? candidate.correct_1688_url,
  });
  for (const block of errors?.blocked_offers || []) {
    if (identitiesOverlap(candidateIdentities, offerIdentityTokens(block))) {
      return { blocked: true, scope: "offer", reason: block.reason, block_key: block.block_key };
    }
  }
  const sourceSku = cleanText(candidate.source_sku);
  if (sourceSku) {
    for (const block of errors?.blocked_matches || []) {
      if (sourceSku === cleanText(block.source_sku)
        && identitiesOverlap(candidateIdentities, offerIdentityTokens(block))) {
        return { blocked: true, scope: "match", reason: block.reason, block_key: block.block_key };
      }
    }
  }
  return { blocked: false, scope: null, reason: null, block_key: null };
}

export function isOfferBlocked(value = {}, candidate = {}) {
  const decision = blockingDecision(value, candidate);
  return decision.blocked && decision.scope === "offer";
}

export function isMatchBlocked(value = {}, candidate = {}) {
  const errors = errorArtifact(value);
  const withoutGlobalBlocks = { ...errors, blocked_offers: [] };
  const decision = blockingDecision(withoutGlobalBlocks, candidate);
  return decision.blocked && decision.scope === "match";
}

export function isFeedbackBlocked(value = {}, candidate = {}) {
  return blockingDecision(value, candidate).blocked;
}
