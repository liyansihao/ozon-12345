import fs from "node:fs/promises";
import path from "node:path";

const EMPTY_PRIORITY = Object.freeze({ schema_version: 1, stores: {} });
const EMPTY_SEASON = Object.freeze({
  schema_version: 1,
  time_zone: "Asia/Shanghai",
  events: [],
});
const EMPTY_FEEDBACK = Object.freeze({
  schema_version: 1,
  blocked_source_skus: [],
  blocked_offer_ids: [],
  blocked_match_evidence_keys: [],
  blocked_matches: [],
  cost_overrides: [],
  trusted_matches: [],
  loss_sources: [],
});
const MODEL_LAST_GOOD_BY_PATH = new Map();
const SEASON_LAST_GOOD_BY_PATH = new Map();
const MAX_SEASON_BOOST = 800;
const DEFAULT_SEASON_LEAD_DAYS = 45;
const DEFAULT_SEASON_BOOST = 600;
const PROFIT_MOTHER_TIER = 1_000;

const STOP_WORDS = new Set([
  "для", "или", "при", "под", "над", "без", "как", "это", "его", "ее", "она", "они",
  "the", "and", "for", "with", "from", "this", "that", "new", "set", "pcs", "шт",
  "набор", "товар", "product", "ozon", "цвет", "размер", "детский", "детская", "детские",
]);

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.values(value);
}

function normalizedText(value) {
  return text(value)
    .toLocaleLowerCase("und")
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}_]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function firstFiniteNumber(values, fallback = 0) {
  for (const value of values) {
    if (text(value) && Number.isFinite(Number(value))) return Number(value);
  }
  return fallback;
}

function motherSalesUnits(mother) {
  return Math.max(0, firstFiniteNumber([
    mother?.sales_units,
    mother?.completed_units,
    mother?.completed_unit_count,
    mother?.completed_orders,
    mother?.order_count,
  ]));
}

function motherRefundRate(mother) {
  return Math.min(1, Math.max(0, firstFiniteNumber([
    mother?.refund_cancel_rate,
    mother?.refund_rate,
  ])));
}

function motherProfitValue(mother) {
  return firstFiniteNumber([
    mother?.real_profit_cny,
    mother?.contribution_profit_cny,
    mother?.profit_cny,
    mother?.total_profit,
  ]);
}

function motherCompletedOrders(mother) {
  return Math.max(0, firstFiniteNumber([
    mother?.completed_orders,
    mother?.order_count,
  ]));
}

function compareMotherPerformance(left, right) {
  return motherSalesUnits(right) - motherSalesUnits(left)
    || motherRefundRate(left) - motherRefundRate(right)
    || motherProfitValue(right) - motherProfitValue(left)
    || motherCompletedOrders(right) - motherCompletedOrders(left);
}

function validDateKey(value) {
  const match = text(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function shiftDateKey(value, days) {
  if (!validDateKey(value)) throw new TypeError(`invalid seasonal date: ${value}`);
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + Number(days))).toISOString().slice(0, 10);
}

export function seasonDateKey(value = new Date(), timeZone = "Asia/Shanghai") {
  if (String(timeZone || "Asia/Shanghai") !== "Asia/Shanghai") {
    throw new TypeError("seasonal priority time_zone must be Asia/Shanghai");
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("seasonal priority date must be valid");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function normalizedSeasonKeyword(value) {
  const normalized = normalizedText(value);
  return normalized.length >= 3 ? normalized : "";
}

function normalizeSeasonCategory(value, inheritedBoost) {
  const row = typeof value === "string" ? { name: value } : value;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new TypeError("seasonal category must be a string or object");
  }
  const name = text(row.name ?? row.category ?? row.label);
  const keywords = asArray(row.keywords ?? row.aliases ?? row.title_keywords)
    .map(normalizedSeasonKeyword)
    .filter(Boolean);
  if (name && /\p{Script=Cyrillic}/u.test(name)) keywords.push(normalizedSeasonKeyword(name));
  const uniqueKeywords = [...new Set(keywords.filter(Boolean))];
  if (!uniqueKeywords.length) {
    throw new TypeError(`seasonal category ${name || "<unnamed>"} needs a Russian name or valid keywords`);
  }
  const rawBoost = Number(row.boost ?? inheritedBoost ?? DEFAULT_SEASON_BOOST);
  const boost = Math.min(MAX_SEASON_BOOST, Math.max(0, Number.isFinite(rawBoost) ? rawBoost : 0));
  return { name, normalized_name: normalizedText(name), keywords: uniqueKeywords, boost };
}

export function normalizeSeasonPriority(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("seasonal priority file must contain a JSON object");
  }
  const timeZone = text(value.time_zone ?? value.timezone) || "Asia/Shanghai";
  if (timeZone !== "Asia/Shanghai") {
    throw new TypeError("seasonal priority time_zone must be Asia/Shanghai");
  }
  const eventsValue = value.events ?? value.calendar ?? [];
  if (!Array.isArray(eventsValue)) throw new TypeError("seasonal priority events must be an array");
  const events = eventsValue.map((event, index) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new TypeError(`seasonal event ${index + 1} must be an object`);
    }
    const salesStart = text(event.sales_start);
    const salesEnd = text(event.sales_end || event.sales_start);
    if (!validDateKey(salesStart) || !validDateKey(salesEnd) || salesEnd < salesStart) {
      throw new TypeError(`seasonal event ${text(event.id) || index + 1} has invalid sales dates`);
    }
    const leadDaysValue = event.lead_days ?? DEFAULT_SEASON_LEAD_DAYS;
    const leadDays = Number(leadDaysValue);
    if (leadDays !== DEFAULT_SEASON_LEAD_DAYS) {
      throw new TypeError(`seasonal event ${text(event.id) || index + 1} lead_days must equal 45`);
    }
    const eventBoostValue = Number(event.boost ?? DEFAULT_SEASON_BOOST);
    const eventBoost = Math.min(
      MAX_SEASON_BOOST,
      Math.max(0, Number.isFinite(eventBoostValue) ? eventBoostValue : 0),
    );
    if (!Array.isArray(event.categories) || event.categories.length === 0) {
      throw new TypeError(`seasonal event ${text(event.id) || index + 1} needs categories`);
    }
    return {
      id: text(event.id) || `event-${index + 1}`,
      name: text(event.name),
      enabled: event.enabled !== false,
      sales_start: salesStart,
      sales_end: salesEnd,
      active_from: shiftDateKey(salesStart, -leadDays),
      lead_days: leadDays,
      categories: event.categories.map((category) => normalizeSeasonCategory(category, eventBoost)),
    };
  });
  return {
    schema_version: Number(value.schema_version) || 1,
    updated_at: value.updated_at || null,
    time_zone: timeZone,
    events,
  };
}

export function profitTokens(value) {
  return [...new Set(normalizedText(value)
    .match(/[\p{L}\p{N}]+/gu) || [])]
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function motherKeywords(row) {
  const explicit = asArray(row?.keywords ?? row?.title_keywords).map(normalizedText).filter(Boolean);
  return explicit.length > 0
    ? [...new Set(explicit)]
    : profitTokens(row?.title || row?.product_name || row?.name);
}

function normalizeMother(row, inheritedStoreId = null) {
  if (!row || typeof row !== "object") return null;
  const storeId = Number(row.store_id ?? row.shop_id ?? inheritedStoreId);
  const sourceSku = text(row.source_sku ?? row.sku ?? row.original_sku);
  const title = text(row.title ?? row.product_name ?? row.name);
  const category = text(row.category ?? row.category_name ?? row.cate_name);
  const keywords = motherKeywords({ ...row, title });
  if (!(storeId > 0) || (!sourceSku && !title && !keywords.length)) return null;
  return {
    ...row,
    store_id: storeId,
    source_sku: sourceSku,
    title,
    category,
    keywords,
  };
}

export function normalizeProfitPriority(value = {}) {
  const stores = {};
  const add = (row, storeId = null) => {
    const normalized = normalizeMother(row, storeId);
    if (!normalized) return;
    const key = String(normalized.store_id);
    stores[key] ||= { store_id: normalized.store_id, store_name: "", mothers: [] };
    stores[key].store_name ||= text(row?.store_name ?? row?.shop_name);
    stores[key].mothers.push(normalized);
  };
  if (value?.stores && typeof value.stores === "object") {
    for (const [storeId, entry] of Object.entries(value.stores)) {
      const container = entry && typeof entry === "object" ? entry : {};
      const rows = asArray(container.mothers ?? container.mother_products ?? container.priority_mothers ?? container.rows ?? entry);
      for (const row of rows) add(row, Number(container.store_id ?? storeId));
      const key = String(Number(container.store_id ?? storeId));
      if (stores[key]) stores[key].store_name ||= text(container.store_name ?? container.name);
    }
  }
  for (const row of asArray(value?.mothers ?? value?.priority_mothers ?? value?.rows)) add(row);
  for (const store of Object.values(stores)) {
    const unique = new Map();
    for (const mother of store.mothers) {
      const key = mother.source_sku || `${normalizedText(mother.title)}:${normalizedText(mother.category)}`;
      const prior = unique.get(key);
      if (!prior || compareMotherPerformance(mother, prior) < 0) {
        unique.set(key, mother);
      }
    }
    store.mothers = [...unique.values()];
  }
  return {
    schema_version: Number(value?.schema_version) || 1,
    updated_at: value?.updated_at || null,
    stores,
  };
}

function normalizedFeedbackEntry(row) {
  if (typeof row === "string" || typeof row === "number") return { value: text(row) };
  return row && typeof row === "object" ? { ...row } : null;
}

function feedbackRows(value, keys) {
  for (const key of keys) {
    if (value?.[key] !== undefined) return asArray(value[key]).map(normalizedFeedbackEntry).filter(Boolean);
  }
  return [];
}

export function normalizeProfitFeedback(value = {}) {
  return {
    schema_version: Number(value?.schema_version) || 1,
    updated_at: value?.updated_at || null,
    blocked_source_skus: feedbackRows(value, ["blocked_source_skus", "blocked_sources"]),
    blocked_offer_ids: feedbackRows(value, ["blocked_offer_ids", "blocked_1688_offer_ids"])
      .concat(feedbackRows(value?.errors || {}, ["blocked_offers"])),
    blocked_match_evidence_keys: feedbackRows(value, ["blocked_match_evidence_keys"]),
    blocked_matches: feedbackRows(value, ["blocked_relations"])
      .concat(feedbackRows(value?.errors || {}, ["blocked_matches"])),
    cost_overrides: feedbackRows(value, ["cost_overrides", "purchase_cost_overrides"])
      .concat(feedbackRows(value?.trusted || {}, ["cost_corrections"])),
    trusted_matches: feedbackRows(value, ["trusted_matches", "trusted_sources"])
      .concat(feedbackRows(value?.trusted || {}, ["trusted"])),
    loss_sources: feedbackRows(value, ["loss_sources", "unprofitable_sources"])
      .concat(feedbackRows(value?.trusted || {}, ["cost_corrections"])),
  };
}

async function readJsonAttempt(filename) {
  if (!text(filename)) return { ok: false, reason: "not-configured" };
  const resolved = path.resolve(filename);
  try {
    const value = JSON.parse(await fs.readFile(resolved, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("profit sidecar file must contain a JSON object");
    }
    MODEL_LAST_GOOD_BY_PATH.set(resolved, value);
    return { ok: true, value };
  } catch (error) {
    if (MODEL_LAST_GOOD_BY_PATH.has(resolved)) {
      return { ok: true, value: MODEL_LAST_GOOD_BY_PATH.get(resolved), last_known_good: true, error };
    }
    return {
      ok: false,
      reason: error?.code === "ENOENT" ? "missing" : "invalid",
      error,
    };
  }
}

async function readSeasonAttempt(filename) {
  if (!text(filename)) return { ok: false, reason: "not-configured" };
  const resolved = path.resolve(filename);
  try {
    const parsed = JSON.parse(await fs.readFile(resolved, "utf8"));
    const value = normalizeSeasonPriority(parsed);
    SEASON_LAST_GOOD_BY_PATH.set(resolved, value);
    return { ok: true, value };
  } catch (error) {
    if (SEASON_LAST_GOOD_BY_PATH.has(resolved)) {
      return { ok: true, value: SEASON_LAST_GOOD_BY_PATH.get(resolved), last_known_good: true, error };
    }
    return {
      ok: false,
      reason: error?.code === "ENOENT" ? "missing" : "invalid",
      error,
    };
  }
}

export function createProfitFilesReader({
  priorityFile,
  feedbackFile,
  seasonFile,
  refreshMs = 5_000,
  now = () => Date.now(),
} = {}) {
  let snapshotValue = {
    priority: normalizeProfitPriority(EMPTY_PRIORITY),
    feedback: normalizeProfitFeedback(EMPTY_FEEDBACK),
    season: normalizeSeasonPriority(EMPTY_SEASON),
  };
  let priorityLoaded = false;
  let feedbackLoaded = false;
  let seasonLoaded = false;
  let refreshedAt = 0;
  let refreshPromise = null;
  return {
    current() { return snapshotValue; },
    async snapshot({ force = false } = {}) {
      if (!force && refreshedAt > 0 && now() - refreshedAt < Math.max(0, Number(refreshMs) || 0)) {
        return snapshotValue;
      }
      if (!refreshPromise) {
        refreshPromise = Promise.all([
          readJsonAttempt(priorityFile),
          readJsonAttempt(feedbackFile),
          readSeasonAttempt(seasonFile),
        ]).then(([priorityAttempt, feedbackAttempt, seasonAttempt]) => {
          const priority = priorityAttempt.ok
            ? normalizeProfitPriority(priorityAttempt.value)
            : snapshotValue.priority;
          const feedback = feedbackAttempt.ok
            ? normalizeProfitFeedback(feedbackAttempt.value)
            : snapshotValue.feedback;
          const season = seasonAttempt.ok ? seasonAttempt.value : snapshotValue.season;
          priorityLoaded ||= priorityAttempt.ok;
          feedbackLoaded ||= feedbackAttempt.ok;
          seasonLoaded ||= seasonAttempt.ok;
          snapshotValue = {
            priority: priorityLoaded ? priority : normalizeProfitPriority(EMPTY_PRIORITY),
            feedback: feedbackLoaded ? feedback : normalizeProfitFeedback(EMPTY_FEEDBACK),
            season: seasonLoaded ? season : normalizeSeasonPriority(EMPTY_SEASON),
          };
          refreshedAt = now();
          return snapshotValue;
        }).finally(() => { refreshPromise = null; });
      }
      return refreshPromise;
    },
  };
}

function candidateText(row) {
  return [row?.title, row?.text, row?.product_name, row?.name, row?.card_text]
    .map(text).filter(Boolean).join(" ");
}

function performanceBonus(mother) {
  const salesUnits = motherSalesUnits(mother);
  const profit = Math.max(0, motherProfitValue(mother));
  const refundRate = motherRefundRate(mother);
  return Math.min(600, (salesUnits * 25 + Math.log1p(profit) * 55) * (1 - refundRate));
}

function similarityScore(row, mother) {
  const sku = text(row?.sku ?? row?.source_sku ?? row?.id);
  if (sku && mother.source_sku && sku === mother.source_sku) return 5_000 + performanceBonus(mother);
  const source = normalizedText(candidateText(row));
  if (!source) return 0;
  const tokens = new Set(profitTokens(source));
  const keywords = mother.keywords || [];
  let phraseHits = 0;
  let tokenHits = 0;
  for (const keyword of keywords) {
    const normalized = normalizedText(keyword);
    if (!normalized) continue;
    if (normalized.includes(" ") && source.includes(normalized)) phraseHits += 1;
    for (const token of profitTokens(normalized)) if (tokens.has(token)) tokenHits += 1;
  }
  const uniqueHitCount = Math.min(keywords.length, tokenHits);
  let score = Math.min(1_800, phraseHits * 900 + (uniqueHitCount >= 2
    ? 600 + uniqueHitCount * 220
    : uniqueHitCount === 1 && keywords.some((keyword) => normalizedText(keyword).length >= 6)
      ? 350
      : 0));
  const category = normalizedText(mother.category);
  const candidateCategory = normalizedText(row?.category ?? row?.category_name ?? row?.cate_name);
  if (category && candidateCategory && (category.includes(candidateCategory) || candidateCategory.includes(category))) score += 450;
  if (score > 0) score += performanceBonus(mother);
  return score;
}

function lossPenalty(feedback, row, storeId = null) {
  let penalty = 0;
  for (const loss of feedback?.loss_sources || []) {
    const lossStore = Number(loss?.store_id ?? loss?.shop_id);
    if (storeId !== null && lossStore > 0 && lossStore !== Number(storeId)) continue;
    const mother = normalizeMother(loss, lossStore || Number(storeId));
    if (!mother) continue;
    const score = similarityScore(row, mother);
    if (score > 0) penalty = Math.min(penalty, -Math.min(1_400, Math.max(300, score * 0.65)));
  }
  return penalty;
}

function containsSeasonPhrase(source, keyword) {
  if (!source || !keyword) return false;
  return ` ${source} `.includes(` ${keyword} `);
}

export function seasonPriorityScore(snapshotValue, row, { now = new Date() } = {}) {
  const season = snapshotValue?.season || snapshotValue || EMPTY_SEASON;
  const dateKey = seasonDateKey(now, season.time_zone || "Asia/Shanghai");
  const categoryValues = [row?.category, row?.category_name, row?.cate_name]
    .map(normalizedText)
    .filter(Boolean);
  const source = normalizedText([
    row?.title,
    row?.text,
    row?.product_name,
    row?.name,
    ...categoryValues,
  ].map(text).filter(Boolean).join(" "));
  if (!source) return 0;
  let score = 0;
  for (const event of season.events || []) {
    if (event?.enabled === false || dateKey < event.active_from || dateKey > event.sales_end) continue;
    for (const category of event.categories || []) {
      const exactCategory = category.normalized_name
        && categoryValues.includes(category.normalized_name);
      const matchedKeywords = (category.keywords || [])
        .filter((keyword) => containsSeasonPhrase(source, keyword));
      const explicitPhrase = matchedKeywords.some((keyword) => keyword.includes(" "));
      const distinctSingleKeywords = new Set(
        matchedKeywords.filter((keyword) => !keyword.includes(" ")),
      ).size;
      if (exactCategory || explicitPhrase || distinctSingleKeywords >= 2) {
        score = Math.max(score, Math.min(MAX_SEASON_BOOST, Math.max(0, Number(category.boost) || 0)));
      }
    }
  }
  return score;
}

export function profitPriorityScore(snapshot, row, { storeId = null, now = new Date() } = {}) {
  const model = snapshot?.priority ? snapshot : {
    priority: normalizeProfitPriority(snapshot),
    feedback: normalizeProfitFeedback({}),
    season: normalizeSeasonPriority(EMPTY_SEASON),
  };
  const stores = model.priority?.stores || {};
  const targetStores = storeId === null
    ? Object.values(stores)
    : stores[String(Number(storeId))] ? [stores[String(Number(storeId))]] : [];
  let score = 0;
  for (const store of targetStores) {
    for (const mother of store.mothers || []) score = Math.max(score, similarityScore(row, mother));
  }
  const profitScore = score + lossPenalty(model.feedback, row, storeId);
  const seasonScore = seasonPriorityScore(model, row, { now });
  if (profitScore < 0) return Math.round(profitScore);
  return Math.round((profitScore > 0 ? PROFIT_MOTHER_TIER : 0) + profitScore + seasonScore);
}

export function prioritizeProfitRows(rows, snapshot, { storeId = null, now = new Date() } = {}) {
  return [...(rows || [])]
    .map((row, index) => ({ row, index, score: profitPriorityScore(snapshot, row, { storeId, now }) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ row }) => row);
}

function entryValue(row, keys) {
  for (const key of keys) {
    const value = text(row?.[key]);
    if (value) return value;
  }
  return text(row?.value);
}

function matchingEntry(rows, value, keys) {
  const target = text(value);
  if (!target) return null;
  return (rows || []).find((row) => entryValue(row, keys) === target) || null;
}

export function manualFeedbackDecision(feedbackValue, {
  sourceSku,
  matchEvidenceKey,
  offerIds = [],
} = {}) {
  const feedback = feedbackValue?.feedback || normalizeProfitFeedback(feedbackValue);
  const blockedSource = matchingEntry(feedback.blocked_source_skus, sourceSku, ["source_sku", "sku"]);
  if (blockedSource) return { blocked: true, reason: "manual-feedback-blocked-source", entry: blockedSource };
  const blockedEvidence = matchingEntry(
    feedback.blocked_match_evidence_keys,
    matchEvidenceKey,
    ["match_evidence_key", "evidence_key"],
  );
  if (blockedEvidence) return { blocked: true, reason: "manual-feedback-blocked-match", entry: blockedEvidence };
  for (const offerId of offerIds || []) {
    const blockedOffer = matchingEntry(feedback.blocked_offer_ids, offerId, ["offer_id", "selected_offer_id"]);
    if (blockedOffer) return { blocked: true, reason: "manual-feedback-blocked-1688-offer", entry: blockedOffer };
  }
  for (const relation of feedback.blocked_matches || []) {
    const relationSource = entryValue(relation, ["source_sku", "sku"]);
    if (!relationSource || relationSource !== text(sourceSku)) continue;
    const relationOffer = entryValue(relation, ["offer_id", "selected_offer_id"]);
    if (relationOffer && (offerIds || []).map(text).includes(relationOffer)) {
      return { blocked: true, reason: "manual-feedback-blocked-match", entry: relation };
    }
  }
  const override = matchingEntry(feedback.cost_overrides, matchEvidenceKey, ["match_evidence_key", "evidence_key"])
    || (offerIds || []).map((offerId) => matchingEntry(feedback.cost_overrides, offerId, ["offer_id", "selected_offer_id"])).find(Boolean)
    || matchingEntry(feedback.cost_overrides, sourceSku, ["source_sku", "sku"]);
  const overrideCost = Number(override?.actual_purchase_price ?? override?.actual_cost ?? override?.purchase_price);
  return {
    blocked: false,
    cost_override: Number.isFinite(overrideCost) && overrideCost > 0 ? overrideCost : null,
    override: override || null,
    trusted: Boolean(
      matchingEntry(feedback.trusted_matches, matchEvidenceKey, ["match_evidence_key", "evidence_key"])
      || (offerIds || []).some((offerId) => matchingEntry(feedback.trusted_matches, offerId, ["offer_id", "selected_offer_id"])),
    ),
  };
}

export function feedbackExcludedOfferIds(feedbackValue, sourceSku = null) {
  const feedback = feedbackValue?.feedback || normalizeProfitFeedback(feedbackValue);
  const result = new Set();
  for (const entry of feedback.blocked_offer_ids || []) {
    const offerId = entryValue(entry, ["offer_id", "selected_offer_id"]);
    if (offerId) result.add(offerId);
  }
  const source = text(sourceSku);
  if (source) {
    for (const entry of feedback.blocked_matches || []) {
      if (entryValue(entry, ["source_sku", "sku"]) !== source) continue;
      const offerId = entryValue(entry, ["offer_id", "selected_offer_id"]);
      if (offerId) result.add(offerId);
    }
  }
  return [...result].sort((left, right) => left.localeCompare(right, "und", { numeric: true }));
}
