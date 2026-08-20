import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  auditedSellerRoot,
  auditedSourceSetSha256,
  exactAuditedSourceUrl,
} from "./audited-source-portfolio.mjs";
import { parseOzonDetailText } from "./ozon-detail.mjs";

export const AUDITED_DISCOVERY_SEED_CONTRACT = "ozon-audited-validation-discovery-seeds-v1";
export const AUDITED_DISCOVERY_SEED_SCHEMA_VERSION = 1;
export const AUDITED_DISCOVERY_SEED_SCOPE = "audited-validation-seed-discovery";
export const AUDITED_DISCOVERY_SEED_ARTIFACT_SHA256 = "f0583aaac7cd3354368ebc0e57951632a57131b856bfaa1427ce71864fa37261";
export const AUDITED_DISCOVERY_EXACT_URL_TEXT_SHA256 = "b5805beefbc90a67be0915add90f4b8e37d124ff35cbf222515f5912094c9dbb";
export const AUDITED_DISCOVERY_SEED_BINDING_CONTRACT = "ozon-audited-validation-seed-binding-v1";
export const AUDITED_DISCOVERY_SEED_OBSERVATION_CONTRACT = "ozon-audited-validation-seed-observation-v1";
export const AUDITED_DISCOVERY_SEED_SCAN_CHECKPOINT_CONTRACT = "ozon-audited-validation-seed-scan-checkpoint-v1";
export const AUDITED_DISCOVERY_SEED_DETAIL_CHECKPOINT_CONTRACT = "ozon-audited-validation-seed-detail-checkpoint-v1";
export const AUDITED_DERIVED_SELLER_CONTRACT = "ozon-audited-validation-derived-seller-portfolio-v1";
export const AUDITED_DERIVED_SELLER_SCHEMA_VERSION = 1;
export const AUDITED_DERIVED_CAPACITY_SCOPE = "audited-validation-derived-capacity";
export const AUDITED_DERIVED_CAPACITY_BINDING_CONTRACT = "ozon-audited-derived-capacity-binding-v1";
export const AUDITED_DERIVED_CAPACITY_OBSERVATION_CONTRACT = "ozon-audited-derived-capacity-observation-v1";
export const AUDITED_DERIVED_CAPACITY_SCAN_CHECKPOINT_CONTRACT = "ozon-audited-derived-capacity-scan-checkpoint-v1";
export const AUDITED_DERIVED_CAPACITY_DETAIL_CHECKPOINT_CONTRACT = "ozon-audited-derived-capacity-detail-checkpoint-v1";
export const AUDITED_DERIVED_CAPACITY_ATTESTATION_CONTRACT = "ozon-audited-derived-capacity-attestation-v1";
export const AUDITED_DERIVED_CAPACITY_MINIMUM = 360;
export const AUDITED_DISCOVERY_LOGICAL_SEED_COUNT = 30;
export const AUDITED_DISCOVERY_EXACT_SOURCE_COUNT = 60;
export const AUDITED_DERIVED_MINIMUM_CURRENT_SELLERS = 20;
export const AUDITED_DERIVED_SELLER_CONTRIBUTION_CAP = 18;
export const AUDITED_DERIVED_MINIMUM_PER_SELLER_ROLE = 3;
export const AUDITED_CAMPAIGN_CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const AUDITED_CURRENT_PRICE_MAX_AGE_MS = 15 * 60 * 1_000;
export const AUDITED_DERIVED_COMPILER_VERSION = "audited-derived-seller-compiler-v1";
export const AUDITED_SEED_READ_ONLY_ADAPTER_CONTRACT = "ozon-audited-seed-read-only-adapter-v1";
export const AUDITED_LIVE_PRICE_EVIDENCE_SCOPE = "same-page-rub-price-and-live-rub-per-cny-rate";
export const AUDITED_LIVE_BRAND_EVIDENCE_SOURCE = "ozon-live-detail-brand-field";
export const AUDITED_LIVE_SELLER_EVIDENCE_SOURCE = "ozon-live-current-seller-widget";
export const AUDITED_CARD_PRICE_EVIDENCE_SCOPE = "ozon-listing-card-visible-nonstruck-current-rub-v1";

export const AUDITED_PRICE_DOM_CONTRACT = "webPrice.innerText + one same-page Maozi 跟卖最低价 RUB≈CNY line; parseOzonDetailText(fallback=null)-v1";
const MAX_API_RATE_RELATIVE_DRIFT = 0.01;

const SAFE_BRAND = /^(?:no[\s-]*(?:name|brand)|нет[\s-]*бренда)$/iu;
const AUDITED_LIVE_SELLER_WIDGETS = new Set(["webCurrentSeller", "current-seller-widget", "webSeller"]);
const ALLOWED_SEED_TYPES = new Set(["search", "category"]);
const ALLOWED_SEARCH_PARAMS = new Set([
  "currency_price",
  "is_global",
  "page",
  "sorting",
  "text",
]);
const ALLOWED_CATEGORY_PARAMS = new Set(["currency_price", "page", "sorting"]);
const DEFAULT_TECHNICAL_LATIN_TOKENS = new Set([
  "usb", "type", "micro", "mini", "hdmi", "displayport", "vga", "dvi", "rj", "ethernet",
  "aux", "jack", "dc", "sd", "tf", "otg", "led", "gu", "gx", "ip", "rgb", "uv", "awg",
  "pd", "qc", "pps", "gan", "hub", "card", "reader", "fast", "charge", "black", "white",
  "female", "male", "cat",
]);

function fail(message) {
  throw new Error(`audited discovery seed: ${message}`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nonEmpty(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) fail(`${label} must be a non-empty string`);
  return normalized;
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) fail(`${label} must be a positive integer`);
  return normalized;
}

function nonNegativeInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) fail(`${label} must be a non-negative integer`);
  return normalized;
}

function sha256Value(value, label) {
  const normalized = nonEmpty(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) fail(`${label} must be a lowercase SHA256 digest`);
  return normalized;
}

function timestamp(value, label, { notBefore = null, now = null } = {}) {
  const milliseconds = Date.parse(String(value || ""));
  if (!Number.isFinite(milliseconds)) fail(`${label} must be a valid timestamp`);
  if (notBefore !== null && milliseconds < notBefore) fail(`${label} predates campaign activation`);
  if (now !== null && milliseconds > now) fail(`${label} is in the future`);
  return new Date(milliseconds).toISOString();
}

function normalizeTerms(value, label, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value.length === 0)) return Object.freeze([]);
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  const terms = [...new Set(value.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean))];
  if (terms.length === 0) fail(`${label} must contain a non-empty term`);
  return Object.freeze(terms);
}

function normalizeTermGroups(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty array of term arrays`);
  }
  const seen = new Set();
  const groups = value.map((group, index) => {
    const normalized = normalizeTerms(group, `${label}[${index}]`);
    const key = JSON.stringify(normalized);
    if (seen.has(key)) fail(`${label} contains a duplicate group`);
    seen.add(key);
    return normalized;
  });
  return Object.freeze(groups);
}

function normalizeRegexPatterns(value, label, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value.length === 0)) return Object.freeze([]);
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty regex string array`);
  const patterns = [...new Set(value.map((entry) => nonEmpty(entry, label)))];
  for (const pattern of patterns) {
    try { new RegExp(pattern, "iu"); }
    catch { fail(`${label} contains an invalid regular expression`); }
  }
  return Object.freeze(patterns);
}

function normalizeRubBand(value, label) {
  const minimum = Number(value?.min);
  const maximum = Number(value?.max);
  if (!(Number.isFinite(minimum) && Number.isFinite(maximum) && minimum >= 0 && maximum > minimum)) {
    fail(`${label} must contain finite 0 <= min < max RUB bounds`);
  }
  return Object.freeze({ min: minimum, max: maximum });
}

function normalizeRoleAttributes(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a non-empty object`);
  }
  const entries = Object.entries(value).map(([rawKey, rawValue]) => {
    const key = nonEmpty(rawKey, `${label} key`).toLowerCase();
    const normalizedValue = nonEmpty(rawValue, `${label}.${key}`).toLowerCase();
    return [key, normalizedValue];
  }).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0 || new Set(entries.map(([key]) => key)).size !== entries.length) {
    fail(`${label} must contain unique non-empty attributes`);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function normalizeRoleAttributeEvidence(value, roleAttributes, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object keyed by every normalized role attribute`);
  }
  const expectedKeys = Object.keys(roleAttributes).sort();
  const actualKeys = Object.keys(value).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail(`${label} keys must exactly match live_role_attributes`);
  }
  return Object.freeze(Object.fromEntries(expectedKeys.map((key) => {
    const row = value[key];
    if (row?.source !== "ozon-live-detail-attribute-table") {
      fail(`${label}.${key}.source must be ozon-live-detail-attribute-table`);
    }
    const normalizedValue = nonEmpty(row?.normalized_value, `${label}.${key}.normalized_value`).toLowerCase();
    if (normalizedValue !== roleAttributes[key]) {
      fail(`${label}.${key}.normalized_value does not match live_role_attributes`);
    }
    return [key, Object.freeze({
      source: "ozon-live-detail-attribute-table",
      label: nonEmpty(row?.label, `${label}.${key}.label`),
      raw_value: nonEmpty(row?.raw_value, `${label}.${key}.raw_value`),
      normalized_value: normalizedValue,
    })];
  })));
}

function normalizeStructuredDetailEvidence(value, categoryKey, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must bind category, item-count, bundle/set, and compatibility evidence`);
  }
  const category = value.category;
  if (category?.source !== "ozon-live-detail-breadcrumb"
    || nonEmpty(category?.normalized_value, `${label}.category.normalized_value`) !== categoryKey) {
    fail(`${label}.category does not bind the normalized category`);
  }
  const itemCount = value.item_count;
  const explicitItemCount = itemCount?.source === "ozon-live-detail-attribute-table"
    && Number(itemCount?.normalized_value) === 1;
  const negativeCueAudit = itemCount?.source === "ozon-live-detail-negative-bundle-cue-audit"
    && Number(itemCount?.normalized_value) === 1
    && itemCount?.title_checked === true
    && itemCount?.category_checked === true
    && itemCount?.attributes_checked === true
    && Number(itemCount?.bundle_cue_count) === 0;
  if (!explicitItemCount && !negativeCueAudit) {
    fail(`${label}.item_count must use an explicit count or a complete zero-bundle-cue audit`);
  }
  const bundle = value.bundle;
  if (!["ozon-live-detail-attribute-table", "ozon-live-detail-negative-bundle-cue-audit"].includes(bundle?.source)
    || bundle?.is_bundle !== false || bundle?.is_set !== false) {
    fail(`${label}.bundle must explicitly prove non-bundle/non-set status`);
  }
  const compatibility = value.compatibility;
  if (compatibility?.source !== "ozon-live-detail-attribute-table"
    || compatibility?.normalized_value !== "generic") {
    fail(`${label}.compatibility must explicitly prove generic compatibility`);
  }
  return Object.freeze({
    category: Object.freeze({
      source: "ozon-live-detail-breadcrumb",
      raw_value: nonEmpty(category.raw_value, `${label}.category.raw_value`),
      normalized_value: categoryKey,
    }),
    item_count: Object.freeze({
      source: itemCount.source,
      raw_value: nonEmpty(itemCount.raw_value, `${label}.item_count.raw_value`),
      normalized_value: 1,
      ...(negativeCueAudit ? {
        title_checked: true,
        category_checked: true,
        attributes_checked: true,
        bundle_cue_count: 0,
      } : {}),
    }),
    bundle: Object.freeze({
      source: bundle.source,
      raw_value: nonEmpty(bundle.raw_value, `${label}.bundle.raw_value`),
      is_bundle: false,
      is_set: false,
    }),
    compatibility: Object.freeze({
      source: "ozon-live-detail-attribute-table",
      raw_value: nonEmpty(compatibility.raw_value, `${label}.compatibility.raw_value`),
      normalized_value: "generic",
    }),
  });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function auditedCanonicalDocumentSha256(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

export function auditedDerivedArtifactSha256(value) {
  const {
    source_path: _sourcePath,
    artifact_sha256: _artifactSha256,
    file_sha256: _fileSha256,
    ...document
  } = value || {};
  return auditedCanonicalDocumentSha256(document);
}

function normalizeProductUrl(value, sku, label) {
  let url;
  try { url = new URL(nonEmpty(value, label)); }
  catch { fail(`${label} must be an absolute URL`); }
  if (url.protocol !== "https:"
    || !["ozon.ru", "www.ozon.ru"].includes(url.hostname.toLowerCase())
    || url.username
    || url.password
    || url.port
    || url.hash) {
    fail(`${label} must be a canonical HTTPS Ozon product URL`);
  }
  const queryKeys = [...url.searchParams.keys()];
  if (queryKeys.some((key) => key !== "sh") || url.searchParams.getAll("sh").length > 1) {
    fail(`${label} may only contain one optional Ozon sh query parameter`);
  }
  const match = url.pathname.match(/^\/product\/(?:[^/?#]*-)?(\d+)\/?$/u);
  if (!match || match[1] !== sku) fail(`${label} must end in the exact observation SKU`);
  url.hostname = "www.ozon.ru";
  url.pathname = `/product/${sku}/`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parseLocalizedPriceNumber(value) {
  const compact = String(value || "").trim().replace(/[\u00a0\u2009\u202f]/gu, " ");
  if (!compact || !/^\d[\d., ]*\d$|^\d$/u.test(compact)) return null;
  const whitespaceGroups = compact.split(/ +/u);
  if (whitespaceGroups.length > 1
    && whitespaceGroups.slice(1).some((group) => !/^\d{3}(?:[.,]\d{1,2})?$/u.test(group))) return null;
  const joined = compact.replace(/ /gu, "");
  const commaCount = (joined.match(/,/gu) || []).length;
  const dotCount = (joined.match(/\./gu) || []).length;
  let normalized;
  if (commaCount > 0 && dotCount > 0) {
    const lastComma = joined.lastIndexOf(",");
    const lastDot = joined.lastIndexOf(".");
    const decimal = lastComma > lastDot ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    const pieces = joined.split(decimal);
    if (pieces.length !== 2 || !/^\d{1,2}$/u.test(pieces[1])) return null;
    const groups = pieces[0].split(thousands);
    if (!/^\d{1,3}$/u.test(groups[0]) || groups.slice(1).some((group) => !/^\d{3}$/u.test(group))) return null;
    normalized = `${groups.join("")}.${pieces[1]}`;
  } else if (commaCount > 0 || dotCount > 0) {
    const separator = commaCount > 0 ? "," : ".";
    const groups = joined.split(separator);
    if (groups.some((group) => !/^\d+$/u.test(group))) return null;
    if (groups.length > 2) {
      if (!/^\d{1,3}$/u.test(groups[0]) || groups.slice(1).some((group) => !/^\d{3}$/u.test(group))) return null;
      normalized = groups.join("");
    } else if (groups[1].length <= 2) normalized = `${groups[0]}.${groups[1]}`;
    else if (groups[1].length === 3 && /^\d{1,3}$/u.test(groups[0])) normalized = groups.join("");
    else return null;
  } else normalized = joined;
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function explicitCurrencyPrice(priceText, currency) {
  const rawText = String(priceText || "").trim();
  const values = [];
  const symbolPattern = currency === "RUB" ? "₽" : "¥￥";
  const expression = new RegExp(
    `(?:([${symbolPattern}])\\s*([0-9](?:[0-9\\s\\u00a0\\u2009\\u202f.,]*[0-9])?)|([0-9](?:[0-9\\s\\u00a0\\u2009\\u202f.,]*[0-9])?)\\s*([${symbolPattern}]))`,
    "gu",
  );
  for (const match of rawText.matchAll(expression)) {
    const value = parseLocalizedPriceNumber(match[2] || match[3]);
    if (value > 0) values.push(value);
  }
  const distinct = [...new Set(values.map((value) => value.toFixed(6)))].map(Number);
  return distinct.length === 1 ? distinct[0] : null;
}

function nearlyEqual(left, right, tolerance = 0.011) {
  return Number.isFinite(Number(left)) && Number.isFinite(Number(right))
    && Math.abs(Number(left) - Number(right)) <= tolerance;
}

function normalizeLivePriceEvidence(row, label, { activatedAt, observedAt, priceBand } = {}) {
  if (row?.live_price_evidence_scope !== AUDITED_LIVE_PRICE_EVIDENCE_SCOPE) {
    fail(`${label}.live_price_evidence_scope must bind same-page RUB price and a live RUB-per-CNY rate`);
  }
  const evidence = row?.live_price_evidence;
  if (!evidence || evidence.method !== "ozon-detail-plugin-live" || evidence.live !== true
    || evidence.source_field !== "web_price_plus_same_page_follow_pair"
    || evidence.dom_contract !== AUDITED_PRICE_DOM_CONTRACT) {
    fail(`${label}.live_price_evidence must use the audited live Ozon price contract`);
  }
  const webPrice = nonEmpty(evidence.raw_web_price_text, `${label}.raw_web_price_text`);
  const currentPriceRubText = nonEmpty(
    evidence.current_price_rub_text,
    `${label}.current_price_rub_text`,
  );
  if (!webPrice.includes(currentPriceRubText)) {
    fail(`${label}.current_price_rub_text must be a dedicated node value present in raw_web_price_text`);
  }
  if (!Array.isArray(evidence.old_price_rub_texts)) {
    fail(`${label}.old_price_rub_texts must explicitly separate crossed-out/old price nodes`);
  }
  const oldPriceRubTexts = evidence.old_price_rub_texts.map((entry, index) => {
    const text = nonEmpty(entry, `${label}.old_price_rub_texts[${index}]`);
    if (!(explicitCurrencyPrice(text, "RUB") > 0)) fail(`${label}.old_price_rub_texts contains an invalid RUB price`);
    return text;
  });
  if (oldPriceRubTexts.includes(currentPriceRubText)
    || new Set(oldPriceRubTexts).size !== oldPriceRubTexts.length) {
    fail(`${label}.current and old RUB price nodes must be distinct`);
  }
  const followLine = nonEmpty(evidence.raw_follow_price_line, `${label}.raw_follow_price_line`);
  if (!/跟卖最低价[：:]/u.test(followLine) || !/(?:≈|~|=)/u.test(followLine)) {
    fail(`${label}.raw_follow_price_line must be one same-page Maozi RUB≈CNY line`);
  }
  const currentCny = explicitCurrencyPrice(currentPriceRubText, "CNY");
  const currentRub = explicitCurrencyPrice(currentPriceRubText, "RUB");
  if (currentCny || !(currentRub > 0)) {
    fail(`${label}.current_price_rub_text must expose one unambiguous current RUB price`);
  }
  if (!(currentRub >= Number(priceBand?.min) && currentRub <= Number(priceBand?.max))) {
    fail(`${label}.current RUB price is outside the audited RUB band`);
  }
  const followCny = explicitCurrencyPrice(followLine, "CNY");
  const followRub = explicitCurrencyPrice(followLine, "RUB");
  if (!(followCny > 0 && followRub > 0)) fail(`${label}.raw_follow_price_line lacks an explicit RUB≈CNY pair`);
  const rate = evidence.api_rate_reference;
  const rateObservedAt = Date.parse(String(rate?.observed_at || ""));
  const cnyPerRub = Number(rate?.cny_per_rub);
  if (rate?.source !== "maozi-current-exchange-rate-api"
    || !(cnyPerRub >= 0.03 && cnyPerRub <= 0.2)
    || !Number.isFinite(rateObservedAt)
    || rateObservedAt < Date.parse(activatedAt)
    || rateObservedAt > Date.parse(observedAt) + 30_000
    || Date.parse(observedAt) - rateObservedAt > 5 * 60_000) {
    fail(`${label}.api_rate_reference is outside the bound campaign window or invalid`);
  }
  const pairRate = followCny / followRub;
  if (Math.abs(pairRate - cnyPerRub) / cnyPerRub > MAX_API_RATE_RELATIVE_DRIFT) {
    fail(`${label}.same-page RUB≈CNY pair differs from the current Maozi API rate by more than 1%`);
  }
  const parsed = parseOzonDetailText(followLine, null, currentPriceRubText);
  if (!(parsed.selected_price > 0)
    || (currentCny && !nearlyEqual(parsed.current_price, currentCny))
    || (currentRub && !nearlyEqual(parsed.current_price_rub, currentRub))
    || !nearlyEqual(parsed.follow_min, followCny)
    || !nearlyEqual(parsed.follow_min_rub, followRub)) {
    fail(`${label}.live price evidence disagrees with the production Ozon price parser`);
  }
  return Object.freeze({
    live_price_evidence_scope: AUDITED_LIVE_PRICE_EVIDENCE_SCOPE,
    live_price_evidence: Object.freeze({
      method: "ozon-detail-plugin-live",
      live: true,
      source_field: "web_price_plus_same_page_follow_pair",
      dom_contract: AUDITED_PRICE_DOM_CONTRACT,
      raw_web_price_text: webPrice,
      current_price_rub_text: currentPriceRubText,
      old_price_rub_texts: Object.freeze(oldPriceRubTexts),
      raw_follow_price_line: followLine,
      parsed: Object.freeze({
        current_price: parsed.current_price,
        current_price_rub: parsed.current_price_rub,
        follow_min: parsed.follow_min,
        follow_min_rub: parsed.follow_min_rub,
        observed_cny_rub_rate: parsed.observed_cny_rub_rate,
        selected_price: parsed.selected_price,
      }),
      selection_basis: parsed.follow_min !== null ? "minimum-of-live-current-and-follow" : "live-current-only",
      rate_basis: "same-page-maozi-follow-pair-checked-against-current-api",
      api_rate_reference: Object.freeze({
        source: "maozi-current-exchange-rate-api",
        cny_per_rub: cnyPerRub,
        observed_at: new Date(rateObservedAt).toISOString(),
        maximum_relative_drift: MAX_API_RATE_RELATIVE_DRIFT,
      }),
      observed_at: observedAt,
    }),
  });
}

function sourcePage(value, label) {
  const normalized = exactAuditedSourceUrl(value);
  if (!normalized) fail(`${label} must be a valid exact URL`);
  let url;
  try { url = new URL(normalized); } catch { fail(`${label} is invalid`); }
  if (url.protocol !== "https:"
    || !["ozon.ru", "www.ozon.ru"].includes(url.hostname.toLowerCase())
    || url.username
    || url.password
    || url.port
    || url.hash) {
    fail(`${label} must be an HTTPS Ozon URL without auth, port, or hash`);
  }
  return { normalized, url };
}

function normalizedSeed(row, index, globalDenyTerms) {
  const label = `seeds[${index}]`;
  const id = nonEmpty(row?.id, `${label}.id`);
  const sourceType = nonEmpty(row?.source_type, `${label}.source_type`).toLowerCase();
  if (!ALLOWED_SEED_TYPES.has(sourceType)) fail(`${label}.source_type must be search or category`);
  const seedBand = normalizeRubBand(row?.seed_price_band_rub, `${label}.seed_price_band_rub`);
  const expectedBand = `${seedBand.min.toFixed(3)};${seedBand.max.toFixed(3)}`;
  const queryText = row?.query_text === null || row?.query_text === undefined
    ? null
    : nonEmpty(row.query_text, `${label}.query_text`);
  if (!Array.isArray(row?.source_urls) || row.source_urls.length !== 2) {
    fail(`${label}.source_urls must contain exactly page 1 and page 2`);
  }
  const sourceUrls = row.source_urls.map((value, sourceIndex) => {
    const { normalized: sourceUrl, url } = sourcePage(value, `${label}.source_urls[${sourceIndex}]`);
    const page = Number(url.searchParams.get("page"));
    if (!Number.isInteger(page) || page < 1 || page > 2) {
      fail(`${label}.source_urls must explicitly bind page 1 and page 2`);
    }
    if (url.searchParams.get("sorting") !== "rating") fail(`${label}.source_urls sorting must equal rating`);
    const allowedParams = sourceType === "search" ? ALLOWED_SEARCH_PARAMS : ALLOWED_CATEGORY_PARAMS;
    if ([...url.searchParams.keys()].some((key) => !allowedParams.has(key))) {
      fail(`${label}.source_urls contains an unsupported query parameter`);
    }
    if (url.searchParams.get("currency_price") !== expectedBand) {
      fail(`${label}.source_urls currency_price must exactly match seed_price_band_rub`);
    }
    if (sourceType === "search") {
      if (url.pathname !== "/search/") fail(`${label}.search source must use /search/`);
      if (url.searchParams.get("is_global") !== "true") fail(`${label}.search source must set is_global=true`);
      if (!queryText || url.searchParams.get("text") !== queryText) {
        fail(`${label}.search source text must exactly match query_text`);
      }
    } else {
      if (!/^\/category\/[a-z0-9][a-z0-9-]*-\d+\/?$/iu.test(url.pathname)) {
        fail(`${label}.category source path is invalid`);
      }
      if (queryText !== null) fail(`${label}.category source must not declare query_text`);
    }
    return { sourceUrl, page };
  }).sort((left, right) => left.page - right.page);
  if (sourceUrls[0].page !== 1 || sourceUrls[1].page !== 2) {
    fail(`${label}.source_urls must contain one URL for each of pages 1 and 2`);
  }
  const withoutPage = sourceUrls.map(({ sourceUrl }) => {
    const comparable = new URL(sourceUrl);
    comparable.searchParams.delete("page");
    comparable.searchParams.sort();
    return comparable.toString();
  });
  if (withoutPage[0] !== withoutPage[1]) {
    fail(`${label}.source_urls page pair must otherwise be identical`);
  }
  const titlePrefixTerms = normalizeTerms(
    row?.title_prefix_terms_any,
    `${label}.title_prefix_terms_any`,
  );
  const requiredGroups = normalizeTermGroups(
    row?.required_term_groups_all,
    `${label}.required_term_groups_all`,
  );
  const denyTerms = normalizeTerms(row?.deny_terms_any, `${label}.deny_terms_any`, { optional: true });
  if (denyTerms.some((term) => globalDenyTerms.includes(term))) {
    // Repeating a global deny is harmless, but rejecting it keeps the manifest concise
    // and prevents reviewers from mistaking target-local terms for a different policy.
    fail(`${label}.deny_terms_any must not duplicate global deny terms`);
  }
  const allowedLatinTokens = normalizeTerms(
    row?.allowed_latin_tokens,
    `${label}.allowed_latin_tokens`,
    { optional: true },
  );
  if (row?.deny_unknown_latin_tokens !== true) {
    fail(`${label}.deny_unknown_latin_tokens must be true`);
  }
  return Object.freeze({
    id,
    selection_priority: positiveInteger(row?.selection_priority, `${label}.selection_priority`),
    source_type: sourceType,
    source_urls: Object.freeze(sourceUrls.map((entry) => entry.sourceUrl)),
    query_text: queryText,
    category_key: nonEmpty(row?.category_key, `${label}.category_key`),
    accessory_role: nonEmpty(row?.accessory_role, `${label}.accessory_role`),
    required_role_attributes: normalizeRoleAttributes(
      row?.required_role_attributes,
      `${label}.required_role_attributes`,
    ),
    title_prefix_terms_any: titlePrefixTerms,
    required_term_groups_all: requiredGroups,
    deny_terms_any: denyTerms,
    deny_regex_any: normalizeRegexPatterns(row?.deny_regex_any, `${label}.deny_regex_any`, { optional: true }),
    allowed_latin_tokens: allowedLatinTokens,
    deny_unknown_latin_tokens: true,
    seed_price_band_rub: seedBand,
    seller_price_band_rub: normalizeRubBand(
      row?.seller_price_band_rub,
      `${label}.seller_price_band_rub`,
    ),
  });
}

export function validateAuditedDiscoverySeedArtifact(value, {
  sourcePath = "<memory>",
  now = new Date(),
} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${sourcePath} must be a JSON object`);
  if (value.contract !== AUDITED_DISCOVERY_SEED_CONTRACT
    || Number(value.schema_version) !== AUDITED_DISCOVERY_SEED_SCHEMA_VERSION) {
    fail(`${sourcePath} has an unsupported seed contract`);
  }
  if (value.deployment_phase !== "validation_only"
    || value.automatic_publish_eligible !== false
    || value.price_evidence_publish_eligible !== false
    || value.favorite_mutations_allowed !== false
    || value.submission_allowed !== false) {
    fail(`${sourcePath} must be validation-only with every mutation/publication capability disabled`);
  }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  const generatedAt = timestamp(value.generated_at, `${sourcePath}.generated_at`, { now: nowMs });
  const queryContract = value.source_query_contract || {};
  if (queryContract.price_parameter !== "currency_price"
    || queryContract.price_band_currency !== "RUB"
    || queryContract.effective_cny_evidence !== "live-same-page-rate-only"
    || queryContract.sorting !== "rating"
    || Number(queryContract.max_page) !== 2
    || queryContract.require_card_price_within_rub_band !== true
    || queryContract.require_detail_current_rub_within_band !== true
    || Number(queryContract.identity_checkpoint_max_age_ms) !== AUDITED_CAMPAIGN_CHECKPOINT_MAX_AGE_MS
    || Number(queryContract.current_price_max_age_ms) !== AUDITED_CURRENT_PRICE_MAX_AGE_MS
    || queryContract.next_stage_requires_live_price_refetch !== true) {
    fail(`${sourcePath} source_query_contract must bind currency_price to RUB, rating, page<=2, and live-only CNY conversion`);
  }
  const globalDenyTerms = normalizeTerms(
    value.global_guard?.deny_terms_any,
    `${sourcePath}.global_guard.deny_terms_any`,
  );
  const globalDenyRegex = normalizeRegexPatterns(
    value.global_guard?.deny_regex,
    `${sourcePath}.global_guard.deny_regex_any`,
  );
  const unknownLatinPolicy = value.global_guard?.unknown_latin_token_policy || {};
  if (unknownLatinPolicy.action !== "reject" || Number(unknownLatinPolicy.min_alpha_length) !== 3) {
    fail(`${sourcePath}.global_guard.unknown_latin_token_policy must reject tokens with at least 3 Latin letters`);
  }
  const globalLatinAllowlist = normalizeTerms(
    unknownLatinPolicy.allowlist,
    `${sourcePath}.global_guard.unknown_latin_token_policy.allowlist`,
  );
  if ([...DEFAULT_TECHNICAL_LATIN_TOKENS].some((token) => !globalLatinAllowlist.includes(token))) {
    fail(`${sourcePath}.global_guard.unknown_latin_token_policy.allowlist is missing a required technical token`);
  }
  if (value.global_guard?.live_brand_policy !== "empty-or-no-name-only") {
    fail(`${sourcePath}.global_guard.live_brand_policy must be empty-or-no-name-only`);
  }
  if (!Array.isArray(value.seeds) || value.seeds.length !== AUDITED_DISCOVERY_LOGICAL_SEED_COUNT) {
    fail(`${sourcePath}.seeds must contain exactly ${AUDITED_DISCOVERY_LOGICAL_SEED_COUNT} logical seeds`);
  }
  const seeds = value.seeds.map((row, index) => normalizedSeed(row, index, globalDenyTerms));
  const ids = new Set();
  const priorities = new Set();
  const urls = new Set();
  for (const seed of seeds) {
    if (ids.has(seed.id)) fail(`${sourcePath} contains duplicate seed id ${seed.id}`);
    if (priorities.has(seed.selection_priority)) fail(`${sourcePath} contains duplicate seed selection_priority`);
    if (seed.source_urls.some((url) => urls.has(url))) fail(`${sourcePath} contains duplicate exact seed URL`);
    ids.add(seed.id);
    priorities.add(seed.selection_priority);
    for (const url of seed.source_urls) urls.add(url);
  }
  if (urls.size !== AUDITED_DISCOVERY_EXACT_SOURCE_COUNT) {
    fail(`${sourcePath} must expand to exactly ${AUDITED_DISCOVERY_EXACT_SOURCE_COUNT} exact URLs`);
  }
  const priorityOrder = [...seeds]
    .sort((left, right) => left.selection_priority - right.selection_priority)
    .map((seed) => seed.id);
  if (value.assignment_policy?.global_dedup_key !== "sku"
    || JSON.stringify(value.assignment_policy?.rule) !== JSON.stringify([
      "highest_required_group_count", "priority_order", "seed_id",
    ])
    || JSON.stringify(value.assignment_policy?.priority_order) !== JSON.stringify(priorityOrder)) {
    fail(`${sourcePath}.assignment_policy must bind global SKU dedup and the exact seed priority order`);
  }
  const sourceSetSha256 = auditedSourceSetSha256([...urls]);
  if (sourceSetSha256 !== AUDITED_DISCOVERY_EXACT_URL_TEXT_SHA256) {
    fail(`${sourcePath}.source_set_sha256 does not match the externally audited 60-URL seed set`);
  }
  if (sha256Value(value.source_set_sha256, `${sourcePath}.source_set_sha256`) !== sourceSetSha256) {
    fail(`${sourcePath}.source_set_sha256 does not match exact seed URLs and order`);
  }
  const excludedSellers = Object.freeze([...new Set((value.excluded_seller_urls || []).map((entry, index) => {
    const seller = auditedSellerRoot(entry);
    if (!seller) fail(`${sourcePath}.excluded_seller_urls[${index}] is invalid`);
    return seller;
  }))]);
  const minimumDistinctSellers = positiveInteger(
    value.compiler_policy?.minimum_distinct_sellers,
    `${sourcePath}.compiler_policy.minimum_distinct_sellers`,
  );
  const maximumDistinctSellers = positiveInteger(
    value.compiler_policy?.maximum_distinct_sellers,
    `${sourcePath}.compiler_policy.maximum_distinct_sellers`,
  );
  if (minimumDistinctSellers < AUDITED_DERIVED_MINIMUM_CURRENT_SELLERS
    || maximumDistinctSellers < minimumDistinctSellers) {
    fail(`${sourcePath}.compiler_policy must require at least ${AUDITED_DERIVED_MINIMUM_CURRENT_SELLERS} current sellers`);
  }
  const minimumPerSellerRole = positiveInteger(
    value.compiler_policy?.minimum_observations_per_seller_role,
    `${sourcePath}.compiler_policy.minimum_observations_per_seller_role`,
  );
  if (minimumPerSellerRole !== AUDITED_DERIVED_MINIMUM_PER_SELLER_ROLE
    || Number(value.capacity_policy?.minimum_detail_strict_unique) !== AUDITED_DERIVED_CAPACITY_MINIMUM
    || Number(value.capacity_policy?.minimum_current_sellers) !== AUDITED_DERIVED_MINIMUM_CURRENT_SELLERS
    || Number(value.capacity_policy?.maximum_unique_per_seller) !== AUDITED_DERIVED_SELLER_CONTRIBUTION_CAP
    || value.capacity_policy?.forecast_counts_for_gate !== false
    || value.capacity_policy?.historical_proxy_counts_for_gate !== false) {
    fail(`${sourcePath} capacity/compiler policy must bind 3 per role, 360 unique, 20 sellers, cap 18, and no proxy/forecast credit`);
  }
  return Object.freeze({
    contract: AUDITED_DISCOVERY_SEED_CONTRACT,
    schema_version: AUDITED_DISCOVERY_SEED_SCHEMA_VERSION,
    deployment_phase: "validation_only",
    automatic_publish_eligible: false,
    price_evidence_publish_eligible: false,
    favorite_mutations_allowed: false,
    submission_allowed: false,
    generated_at: generatedAt,
    source_query_contract: Object.freeze({ ...queryContract }),
    global_guard: Object.freeze({
      deny_terms_any: globalDenyTerms,
      deny_regex_any: globalDenyRegex,
      unknown_latin_token_policy: Object.freeze({
        action: "reject",
        min_alpha_length: 3,
        allowlist: globalLatinAllowlist,
      }),
      live_brand_policy: "empty-or-no-name-only",
    }),
    compiler_policy: Object.freeze({
      minimum_observations_per_seller_role: minimumPerSellerRole,
      minimum_distinct_sellers: minimumDistinctSellers,
      maximum_distinct_sellers: maximumDistinctSellers,
    }),
    source_set_sha256: sourceSetSha256,
    assignment_policy: Object.freeze({
      global_dedup_key: "sku",
      rule: Object.freeze(["highest_required_group_count", "priority_order", "seed_id"]),
      priority_order: Object.freeze(priorityOrder),
    }),
    capacity_policy: Object.freeze({
      minimum_detail_strict_unique: AUDITED_DERIVED_CAPACITY_MINIMUM,
      minimum_current_sellers: AUDITED_DERIVED_MINIMUM_CURRENT_SELLERS,
      maximum_unique_per_seller: AUDITED_DERIVED_SELLER_CONTRIBUTION_CAP,
      forecast_counts_for_gate: false,
      historical_proxy_counts_for_gate: false,
    }),
    seeds: Object.freeze(seeds),
    excluded_seller_urls: excludedSellers,
  });
}

export async function loadAuditedDiscoverySeedArtifact(filename, {
  expectedSha256 = AUDITED_DISCOVERY_SEED_ARTIFACT_SHA256,
  now = new Date(),
} = {}) {
  const expected = sha256Value(expectedSha256, "expected seed artifact SHA256");
  const sourcePath = path.resolve(nonEmpty(filename, "seed artifact filename"));
  let bytes;
  let parsed;
  try {
    bytes = await fs.readFile(sourcePath);
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`${sourcePath} could not be loaded: ${error.message}`);
  }
  const digest = sha256(bytes);
  if (digest !== expected) fail(`${sourcePath} file SHA256 does not match the externally pinned seed artifact`);
  const artifact = validateAuditedDiscoverySeedArtifact(parsed, { sourcePath, now });
  return Object.freeze({ ...artifact, source_path: sourcePath, artifact_sha256: digest });
}

export function buildAuditedSeedBinding({
  artifact,
  runId,
  campaignEpoch,
  activatedAt,
  now = new Date(),
} = {}) {
  const artifactSha = sha256Value(artifact?.artifact_sha256, "seed binding artifact SHA256");
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  return Object.freeze({
    contract: AUDITED_DISCOVERY_SEED_BINDING_CONTRACT,
    run_id: nonEmpty(runId, "seed binding run_id"),
    campaign_epoch: nonNegativeInteger(campaignEpoch, "seed binding campaign_epoch"),
    activated_at: timestamp(activatedAt, "seed binding activated_at", { now: nowMs }),
    seed_artifact_sha256: artifactSha,
    seed_source_set_sha256: sha256Value(artifact?.source_set_sha256, "seed binding source-set SHA256"),
  });
}

function titleText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/gu, " ");
}

function latinTokens(value) {
  return [...new Set(titleText(value).match(/[a-z][a-z0-9.+-]*/gu) || [])];
}

function targetTitleEligibility(title, target, globalGuard) {
  const text = titleText(title);
  if (!text) return { eligible: false, reason: "title-missing" };
  if ((globalGuard?.deny_terms_any || []).some((term) => text.includes(term))) {
    return { eligible: false, reason: "global-risk-term" };
  }
  if ((globalGuard?.deny_regex_any || []).some((pattern) => new RegExp(pattern, "iu").test(text))) {
    return { eligible: false, reason: "global-risk-pattern" };
  }
  if ((target?.deny_terms_any || []).some((term) => text.includes(term))) {
    return { eligible: false, reason: "target-risk-term" };
  }
  if ((target?.deny_regex_any || []).some((pattern) => new RegExp(pattern, "iu").test(text))) {
    return { eligible: false, reason: "target-risk-pattern" };
  }
  if (!(target?.title_prefix_terms_any || []).some((term) => text.startsWith(term))) {
    return { eligible: false, reason: "title-prefix-mismatch" };
  }
  if (!(target?.required_term_groups_all || []).every(
    (group) => group.some((term) => text.includes(term)),
  )) {
    return { eligible: false, reason: "required-term-group-mismatch" };
  }
  if (target?.deny_unknown_latin_tokens === true) {
    const allowed = new Set([
      ...(globalGuard?.unknown_latin_token_policy?.allowlist || DEFAULT_TECHNICAL_LATIN_TOKENS),
      ...(target.allowed_latin_tokens || []),
    ]);
    const unknown = latinTokens(text).find((token) => {
      const alpha = token.replace(/[^a-z]/gu, "");
      return alpha.length >= 3 && !allowed.has(token) && !allowed.has(alpha);
    });
    if (unknown) return { eligible: false, reason: "unknown-latin-brand-token", token: unknown };
  }
  return { eligible: true, reason: null };
}

export function auditedSeedTitleEligibility(title, seedArtifact, seedId) {
  const target = seedArtifact?.seeds?.find((seed) => seed.id === seedId);
  if (!target) return { eligible: false, reason: "seed-not-found", target: null };
  const result = targetTitleEligibility(title, target, seedArtifact.global_guard);
  return { ...result, target: result.eligible ? target : null };
}

function safeBrand(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return !normalized || SAFE_BRAND.test(normalized);
}

function hasCompleteSafeBrandEvidence(row) {
  return row?.live_brand_extraction_complete === true
    && row?.live_brand_evidence_source === AUDITED_LIVE_BRAND_EVIDENCE_SOURCE
    && Object.hasOwn(row, "live_brand")
    && safeBrand(row.live_brand);
}

export function auditedSeedObservationEligibility(row, artifact, binding, { now = new Date() } = {}) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return { eligible: false, reason: "observation-missing", observation: null, seed: null };
  }
  const reject = (reason) => ({ eligible: false, reason, observation: null, seed: null });
  if (row.contract !== AUDITED_DISCOVERY_SEED_OBSERVATION_CONTRACT
    || row.evidence_scope !== AUDITED_DISCOVERY_SEED_SCOPE
    || row.status !== "observed") return reject("observation-contract-invalid");
  if (row.favorite_id !== undefined || row.favorited_at !== undefined
    || row.published_at !== undefined || row.submitted_at !== undefined) {
    return reject("observation-mutation-identity-forbidden");
  }
  if (binding?.contract !== AUDITED_DISCOVERY_SEED_BINDING_CONTRACT
    || String(row.run_id || "") !== binding.run_id
    || Number(row.campaign_epoch) !== binding.campaign_epoch
    || String(row.seed_artifact_sha256 || "") !== binding.seed_artifact_sha256
    || String(row.seed_source_set_sha256 || "") !== binding.seed_source_set_sha256
    || String(row.activated_at || "") !== binding.activated_at) {
    return reject("observation-campaign-binding-mismatch");
  }
  const seed = artifact?.seeds?.find((candidate) => candidate.id === String(row.seed_id || ""));
  const observedSourceUrl = exactAuditedSourceUrl(row.source_url);
  if (!seed || !seed.source_urls.includes(observedSourceUrl)
    || exactAuditedSourceUrl(row.final_source_url) !== observedSourceUrl) {
    return reject("observation-seed-source-mismatch");
  }
  let observedAt;
  try {
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
    observedAt = timestamp(row.observed_at, "observation observed_at", {
      notBefore: Date.parse(binding.activated_at),
      now: nowMs,
    });
  } catch {
    return reject("observation-time-invalid");
  }
  const sku = String(row.sku || "").trim();
  if (!/^\d+$/u.test(sku) || /^0+$/u.test(sku)) return reject("observation-sku-invalid");
  let productUrl;
  try { productUrl = normalizeProductUrl(row.product_url, sku, "observation product_url"); }
  catch { return reject("observation-product-url-invalid"); }
  let finalProductUrl;
  try { finalProductUrl = normalizeProductUrl(row.final_product_url, sku, "observation final_product_url"); }
  catch { return reject("observation-final-product-url-invalid"); }
  if (finalProductUrl !== productUrl) return reject("observation-product-redirect-mismatch");
  const sellerUrl = auditedSellerRoot(row.seller_url);
  if (!sellerUrl || artifact.excluded_seller_urls.includes(sellerUrl)) {
    return reject("observation-seller-invalid-or-excluded");
  }
  if (row.live_seller_evidence_source !== AUDITED_LIVE_SELLER_EVIDENCE_SOURCE) {
    return reject("observation-current-seller-widget-evidence-required");
  }
  if (!AUDITED_LIVE_SELLER_WIDGETS.has(String(row.live_seller_widget || ""))) {
    return reject("observation-current-seller-widget-identity-invalid");
  }
  if (String(row.category_key || "") !== seed.category_key
    || String(row.accessory_role || "") !== seed.accessory_role) {
    return reject("observation-category-role-mismatch");
  }
  const title = nonEmpty(row.live_title, "observation live_title");
  const titleEligibility = targetTitleEligibility(title, seed, artifact.global_guard);
  if (!titleEligibility.eligible) return reject(`observation-${titleEligibility.reason}`);
  if (!hasCompleteSafeBrandEvidence(row)) return reject("observation-live-brand-evidence-invalid-or-risk");
  if (Number(row.live_item_count) !== 1
    || row.live_is_bundle !== false
    || row.live_is_set !== false
    || row.live_compatibility_scope !== "generic") {
    return reject("observation-single-generic-item-required");
  }
  if (String(row.live_category_key || "") !== seed.category_key) {
    return reject("observation-live-category-mismatch");
  }
  let liveStructuredEvidence;
  try {
    liveStructuredEvidence = normalizeStructuredDetailEvidence(
      row.live_structured_evidence,
      seed.category_key,
      "observation live_structured_evidence",
    );
  } catch { return reject("observation-structured-detail-evidence-invalid"); }
  let liveRoleAttributes;
  try {
    liveRoleAttributes = normalizeRoleAttributes(
      row.live_role_attributes,
      "observation live_role_attributes",
    );
  } catch {
    return reject("observation-role-attributes-invalid");
  }
  if (JSON.stringify(liveRoleAttributes) !== JSON.stringify(seed.required_role_attributes)) {
    return reject("observation-role-attributes-mismatch");
  }
  let liveRoleAttributeEvidence;
  try {
    liveRoleAttributeEvidence = normalizeRoleAttributeEvidence(
      row.live_role_attribute_evidence,
      liveRoleAttributes,
      "observation live_role_attribute_evidence",
    );
  } catch { return reject("observation-role-attribute-evidence-invalid"); }
  let livePriceEvidence;
  try {
    livePriceEvidence = normalizeLivePriceEvidence(row, "observation", {
      activatedAt: binding.activated_at,
      observedAt,
      priceBand: seed.seed_price_band_rub,
    });
  }
  catch { return reject("observation-live-price-evidence-invalid"); }
  return {
    eligible: true,
    reason: null,
    seed,
    observation: Object.freeze({
      contract: AUDITED_DISCOVERY_SEED_OBSERVATION_CONTRACT,
      evidence_scope: AUDITED_DISCOVERY_SEED_SCOPE,
      status: "observed",
      run_id: binding.run_id,
      campaign_epoch: binding.campaign_epoch,
      activated_at: binding.activated_at,
      observed_at: observedAt,
      seed_artifact_sha256: binding.seed_artifact_sha256,
      seed_source_set_sha256: binding.seed_source_set_sha256,
      seed_id: seed.id,
      source_url: observedSourceUrl,
      final_source_url: observedSourceUrl,
      sku,
      product_url: productUrl,
      final_product_url: finalProductUrl,
      seller_url: sellerUrl,
      live_seller_evidence_source: AUDITED_LIVE_SELLER_EVIDENCE_SOURCE,
      live_seller_widget: row.live_seller_widget,
      live_title: title,
      live_brand: row.live_brand.trim(),
      live_brand_extraction_complete: true,
      live_brand_evidence_source: AUDITED_LIVE_BRAND_EVIDENCE_SOURCE,
      category_key: seed.category_key,
      accessory_role: seed.accessory_role,
      live_category_key: seed.category_key,
      live_item_count: 1,
      live_is_bundle: false,
      live_is_set: false,
      live_compatibility_scope: "generic",
      live_role_attributes: liveRoleAttributes,
      live_role_attribute_evidence: liveRoleAttributeEvidence,
      live_structured_evidence: liveStructuredEvidence,
      ...livePriceEvidence,
    }),
  };
}

function skuFromProductLink(value) {
  try {
    const url = new URL(String(value || ""));
    return url.pathname.match(/^\/product\/(?:[^/?#]*-)?(\d+)\/?$/u)?.[1] || "";
  } catch {
    return "";
  }
}

function validateSeedReadOnlyAdapter(adapter) {
  if (adapter?.contract !== AUDITED_SEED_READ_ONLY_ADAPTER_CONTRACT
    || adapter?.owned_context !== true
    || adapter?.mutation_firewall_installed !== true
    || adapter?.favorite_mutations_allowed !== false
    || adapter?.submission_allowed !== false
    || typeof adapter?.scanSource !== "function"
    || typeof adapter?.fetchProductDetail !== "function"
    || typeof adapter?.classifyProduct !== "function") {
    fail("a firewall-protected owned-context seed read-only adapter is required");
  }
  return adapter;
}

export function createAuditedSeedReadOnlyAdapter({
  scanSource,
  fetchProductDetail,
  classifyProduct,
  ownedContext = false,
  mutationFirewallInstalled = false,
  ...unsupported
} = {}) {
  if (Object.keys(unsupported).length > 0) {
    fail(`unsupported seed read-only adapter field(s): ${Object.keys(unsupported).sort().join(", ")}`);
  }
  if (typeof scanSource !== "function"
    || typeof fetchProductDetail !== "function"
    || typeof classifyProduct !== "function") {
    fail("seed adapter requires scanSource, fetchProductDetail, and classifyProduct callbacks");
  }
  if (ownedContext !== true || mutationFirewallInstalled !== true) {
    fail("seed adapter requires an owned context with the mutation firewall already installed");
  }
  return Object.freeze({
    contract: AUDITED_SEED_READ_ONLY_ADAPTER_CONTRACT,
    owned_context: true,
    mutation_firewall_installed: true,
    favorite_mutations_allowed: false,
    submission_allowed: false,
    scanSource,
    fetchProductDetail,
    classifyProduct,
  });
}

function detailPriceFields(detail) {
  return {
    live_price_evidence_scope: detail?.live_price_evidence_scope,
    live_price_evidence: detail?.live_price_evidence,
  };
}

function exactSourceScanResult(requestedUrl, result, label) {
  const finalUrl = exactAuditedSourceUrl(result?.final_url);
  if (finalUrl !== requestedUrl) {
    fail(`${label} redirected away from its exact audited source URL`);
  }
  if (result?.status !== "completed" || result?.complete !== true
    || /blocked|captcha|timeout|max[_ -]?steps|failed|incomplete/iu.test(String(result?.stop_reason || ""))) {
    fail(`${label} scan is incomplete or retryable and cannot be checkpointed as completed`);
  }
  if (!Array.isArray(result?.links) || result.links.length === 0) {
    fail(`${label} must return at least one link from a complete source scan`);
  }
  return result.links;
}

function checkpointTime(value, binding, now, label) {
  const nowValue = now instanceof Date ? now : new Date(now);
  const checked = timestamp(value, `${label}.observed_at`, {
    notBefore: Date.parse(binding.activated_at),
    now: nowValue.getTime(),
  });
  if (nowValue.getTime() - Date.parse(checked) > AUDITED_CAMPAIGN_CHECKPOINT_MAX_AGE_MS) {
    fail(`${label}.observed_at is older than the 24-hour campaign checkpoint TTL`);
  }
  return checked;
}

function validateSeedScanCheckpoint(row, artifact, binding, now) {
  if (row?.contract !== AUDITED_DISCOVERY_SEED_SCAN_CHECKPOINT_CONTRACT
    || row?.evidence_scope !== AUDITED_DISCOVERY_SEED_SCOPE
    || row?.status !== "completed"
    || row?.complete !== true
    || row?.run_id !== binding.run_id
    || Number(row?.campaign_epoch) !== binding.campaign_epoch
    || row?.activated_at !== binding.activated_at
    || row?.seed_artifact_sha256 !== binding.seed_artifact_sha256
    || row?.seed_source_set_sha256 !== binding.seed_source_set_sha256) {
    fail("seed resume scan checkpoint campaign identity is invalid");
  }
  checkpointTime(row.observed_at, binding, now, "seed resume scan checkpoint");
  const seed = artifact.seeds.find((entry) => entry.id === row.seed_id);
  const sourceUrl = exactAuditedSourceUrl(row.source_url);
  if (!seed || !seed.source_urls.includes(sourceUrl)) fail("seed resume scan checkpoint source binding is invalid");
  exactSourceScanResult(sourceUrl, row, `seed resume ${seed.id}`);
  return row;
}

function validateCapacityScanCheckpoint(row, artifact, binding, now) {
  if (row?.contract !== AUDITED_DERIVED_CAPACITY_SCAN_CHECKPOINT_CONTRACT
    || row?.evidence_scope !== AUDITED_DERIVED_CAPACITY_SCOPE
    || row?.status !== "completed"
    || row?.complete !== true
    || row?.run_id !== binding.run_id
    || Number(row?.campaign_epoch) !== binding.campaign_epoch
    || row?.activated_at !== binding.activated_at
    || row?.derived_artifact_sha256 !== binding.derived_artifact_sha256
    || row?.source_set_sha256 !== binding.source_set_sha256) {
    fail("capacity resume scan checkpoint campaign identity is invalid");
  }
  checkpointTime(row.observed_at, binding, now, "capacity resume scan checkpoint");
  const sourceUrl = exactAuditedSourceUrl(row.source_url);
  const sourceBinding = artifact.active_source_bindings.find((entry) => entry.source_url === sourceUrl);
  if (!sourceBinding || sourceBinding.target_id !== row.target_id) {
    fail("capacity resume scan checkpoint source binding is invalid");
  }
  exactSourceScanResult(sourceUrl, row, `capacity resume ${sourceBinding.target_id}`);
  return row;
}

function normalizedSeedDetailOccurrences(occurrences, sku) {
  const rows = (occurrences || []).map((entry) => Object.freeze({
    seed_id: entry.seed.id,
    source_url: exactAuditedSourceUrl(entry.sourceUrl),
    product_url: normalizeProductUrl(entry.productUrl, sku, "seed detail occurrence product_url"),
  })).sort((left, right) => left.seed_id.localeCompare(right.seed_id)
    || left.source_url.localeCompare(right.source_url)
    || left.product_url.localeCompare(right.product_url));
  if (rows.length === 0 || new Set(rows.map((row) => JSON.stringify(row))).size !== rows.length) {
    fail("seed detail occurrences must contain unique campaign-bound sources");
  }
  return Object.freeze(rows);
}

function normalizedCapacityDetailOccurrences(occurrences, sku) {
  const rows = (occurrences || []).map((entry) => Object.freeze({
    target_id: entry.sourceBinding.target_id,
    source_url: exactAuditedSourceUrl(entry.sourceBinding.source_url),
    product_url: normalizeProductUrl(entry.productUrl, sku, "capacity detail occurrence product_url"),
  })).sort((left, right) => left.target_id.localeCompare(right.target_id)
    || left.source_url.localeCompare(right.source_url)
    || left.product_url.localeCompare(right.product_url));
  if (rows.length === 0 || new Set(rows.map((row) => JSON.stringify(row))).size !== rows.length) {
    fail("capacity detail occurrences must contain unique campaign-bound sources");
  }
  return Object.freeze(rows);
}

function normalizedCheckpointOccurrenceRows(value, keys, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty occurrence array`);
  return Object.freeze(value.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...keys].sort())) {
      fail(`${label}[${index}] fields are invalid`);
    }
    return Object.freeze(Object.fromEntries(keys.map((key) => [key, nonEmpty(row[key], `${label}[${index}].${key}`)])));
  }).sort((left, right) => keys.reduce((result, key) => result || left[key].localeCompare(right[key]), 0)));
}

function validateSeedDetailCheckpoint(row, occurrences, artifact, binding, now) {
  if (row?.contract !== AUDITED_DISCOVERY_SEED_DETAIL_CHECKPOINT_CONTRACT
    || row?.evidence_scope !== AUDITED_DISCOVERY_SEED_SCOPE
    || row?.stage !== "seed-product-detail"
    || row?.terminal !== true
    || !["accepted", "terminal-rejected"].includes(row?.status)
    || row?.run_id !== binding.run_id
    || Number(row?.campaign_epoch) !== binding.campaign_epoch
    || row?.activated_at !== binding.activated_at
    || row?.seed_artifact_sha256 !== binding.seed_artifact_sha256
    || row?.seed_source_set_sha256 !== binding.seed_source_set_sha256) {
    fail("seed resume detail checkpoint campaign identity is invalid");
  }
  checkpointTime(row.observed_at, binding, now, "seed resume detail checkpoint");
  const sku = String(row.sku || "").trim();
  if (!/^\d+$/u.test(sku) || /^0+$/u.test(sku)) fail("seed resume detail checkpoint SKU is invalid");
  const expected = normalizedSeedDetailOccurrences(occurrences, sku);
  const observed = normalizedCheckpointOccurrenceRows(
    row.occurrences,
    ["seed_id", "source_url", "product_url"],
    "seed resume detail checkpoint occurrences",
  );
  if (JSON.stringify(observed) !== JSON.stringify(expected)
    || row.occurrence_set_sha256 !== auditedCanonicalDocumentSha256(expected)) {
    fail("seed resume detail checkpoint occurrence set is stale or tampered");
  }
  const productUrl = normalizeProductUrl(row.product_url, sku, "seed resume detail checkpoint product_url");
  if (!expected.some((entry) => entry.product_url === productUrl)) {
    fail("seed resume detail checkpoint product URL is outside its occurrence set");
  }
  if (row.status === "accepted") {
    const selected = expected.find((entry) => entry.seed_id === row.selected_seed_id
      && entry.source_url === exactAuditedSourceUrl(row.selected_source_url));
    if (!selected || !/^[a-f0-9]{64}$/u.test(String(row.observation_sha256 || ""))) {
      fail("accepted seed detail checkpoint lacks selected source and observation identity");
    }
  } else if (row.reason !== "no-detail-strict-seed-role-match"
    || row.selected_seed_id !== null || row.selected_source_url !== null
    || row.observation_sha256 !== null) {
    fail("terminal seed detail rejection checkpoint is invalid");
  }
  return Object.freeze({ ...row, sku, product_url: productUrl, occurrences: expected });
}

function validateCapacityDetailCheckpoint(row, occurrences, artifact, binding, now) {
  if (row?.contract !== AUDITED_DERIVED_CAPACITY_DETAIL_CHECKPOINT_CONTRACT
    || row?.evidence_scope !== AUDITED_DERIVED_CAPACITY_SCOPE
    || row?.stage !== "capacity-product-detail"
    || row?.terminal !== true
    || !["accepted", "terminal-rejected"].includes(row?.status)
    || row?.run_id !== binding.run_id
    || Number(row?.campaign_epoch) !== binding.campaign_epoch
    || row?.activated_at !== binding.activated_at
    || row?.derived_artifact_sha256 !== binding.derived_artifact_sha256
    || row?.source_set_sha256 !== binding.source_set_sha256) {
    fail("capacity resume detail checkpoint campaign identity is invalid");
  }
  checkpointTime(row.observed_at, binding, now, "capacity resume detail checkpoint");
  const sku = String(row.sku || "").trim();
  if (!/^\d+$/u.test(sku) || /^0+$/u.test(sku)) fail("capacity resume detail checkpoint SKU is invalid");
  const expected = normalizedCapacityDetailOccurrences(occurrences, sku);
  const observed = normalizedCheckpointOccurrenceRows(
    row.occurrences,
    ["target_id", "source_url", "product_url"],
    "capacity resume detail checkpoint occurrences",
  );
  if (JSON.stringify(observed) !== JSON.stringify(expected)
    || row.occurrence_set_sha256 !== auditedCanonicalDocumentSha256(expected)) {
    fail("capacity resume detail checkpoint occurrence set is stale or tampered");
  }
  const productUrl = normalizeProductUrl(row.product_url, sku, "capacity resume detail checkpoint product_url");
  if (!expected.some((entry) => entry.product_url === productUrl)) {
    fail("capacity resume detail checkpoint product URL is outside its occurrence set");
  }
  if (row.status === "accepted") {
    const selected = expected.find((entry) => entry.target_id === row.selected_target_id
      && entry.source_url === exactAuditedSourceUrl(row.selected_source_url));
    if (!selected || !/^[a-f0-9]{64}$/u.test(String(row.observation_sha256 || ""))) {
      fail("accepted capacity detail checkpoint lacks selected source and observation identity");
    }
  } else if (row.reason !== "no-detail-strict-derived-target-match"
    || row.selected_target_id !== null || row.selected_source_url !== null
    || row.observation_sha256 !== null) {
    fail("terminal capacity detail rejection checkpoint is invalid");
  }
  return Object.freeze({ ...row, sku, product_url: productUrl, occurrences: expected });
}

export function auditedCardPriceEligibility(link, priceBand) {
  try {
    const evidence = link?.card_price_evidence;
    if (evidence?.scope !== AUDITED_CARD_PRICE_EVIDENCE_SCOPE
      || evidence?.current_candidate_count !== 1
      || evidence?.current_price_node?.evidence_source !== "listing-card-visible-nonstruck-leaf-v1"
      || evidence.current_price_node.visible !== true
      || evidence.current_price_node.line_through !== false
      || evidence.current_price_node.installment !== false
      || !Array.isArray(evidence.excluded_price_nodes)
      || evidence.excluded_price_nodes.some((row) => row?.visible !== true || row?.line_through !== true)) {
      throw new Error("structured card price evidence is incomplete or ambiguous");
    }
    const cardRub = explicitCurrencyPrice(evidence.current_price_node.raw_text, "RUB");
    if (!(cardRub > 0)
      || !nearlyEqual(cardRub, Number(link?.current_price_rub ?? link?.price_rub))) {
      throw new Error("structured card current price disagrees with the numeric card price");
    }
    const cardPriceEvidence = Object.freeze({
      scope: AUDITED_CARD_PRICE_EVIDENCE_SCOPE,
      current_candidate_count: 1,
      raw_card_text: nonEmpty(evidence.raw_card_text, "card price evidence raw_card_text"),
      current_price_node: Object.freeze({
        evidence_source: "listing-card-visible-nonstruck-leaf-v1",
        raw_text: nonEmpty(evidence.current_price_node.raw_text, "card current price raw_text"),
        visible: true,
        line_through: false,
        installment: false,
      }),
      excluded_price_nodes: Object.freeze(evidence.excluded_price_nodes.map((row, index) => Object.freeze({
        evidence_source: "listing-card-visible-struck-leaf-v1",
        raw_text: nonEmpty(row.raw_text, `card excluded price ${index} raw_text`),
        visible: true,
        line_through: true,
        exclusion_reason: "line-through-old-price",
      }))),
    });
    if (cardRub < Number(priceBand?.min) || cardRub > Number(priceBand?.max)) {
      return Object.freeze({ eligible: false, reason: "card-rub-price-out-of-band", current_price_rub: cardRub, evidence: cardPriceEvidence });
    }
    return Object.freeze({ eligible: true, reason: null, current_price_rub: cardRub, evidence: cardPriceEvidence });
  } catch {
    return Object.freeze({ eligible: false, reason: "card-rub-price-evidence-invalid", current_price_rub: null, evidence: null });
  }
}

function stageOneTargetLinks(target, links, globalGuard, priceBand) {
  const accepted = [];
  const rejected = [];
  for (const link of links) {
    const cardTitle = String(link?.title || link?.text || "").trim();
    if (!cardTitle) {
      rejected.push(Object.freeze({ sku: String(link?.sku || "") || null, reason: "card-title-missing" }));
      continue;
    }
    const titleEligibility = targetTitleEligibility(cardTitle, target, globalGuard);
    if (!titleEligibility.eligible) {
      rejected.push(Object.freeze({ sku: String(link?.sku || "") || null, reason: `card-${titleEligibility.reason}` }));
      continue;
    }
    const cardPrice = auditedCardPriceEligibility(link, priceBand);
    if (!cardPrice.eligible) {
      rejected.push(Object.freeze({ sku: String(link?.sku || "") || null, reason: cardPrice.reason }));
      continue;
    }
    accepted.push({
      ...link,
      title: cardTitle,
      current_price_rub: cardPrice.current_price_rub,
      card_price_evidence: cardPrice.evidence,
    });
  }
  return { accepted, rejected };
}

function seedObservationFromDetail({ seed, sourceUrl, sku, productUrl, detail, classification, binding }) {
  return {
    contract: AUDITED_DISCOVERY_SEED_OBSERVATION_CONTRACT,
    evidence_scope: AUDITED_DISCOVERY_SEED_SCOPE,
    status: "observed",
    run_id: binding.run_id,
    campaign_epoch: binding.campaign_epoch,
    activated_at: binding.activated_at,
    observed_at: detail?.observed_at,
    seed_artifact_sha256: binding.seed_artifact_sha256,
    seed_source_set_sha256: binding.seed_source_set_sha256,
    seed_id: seed.id,
    source_url: sourceUrl,
    final_source_url: sourceUrl,
    sku,
    product_url: productUrl,
    final_product_url: detail?.final_url,
    seller_url: detail?.seller_url,
    live_seller_evidence_source: detail?.seller_evidence_source,
    live_seller_widget: detail?.seller_widget,
    live_title: detail?.title,
    live_brand: detail?.brand,
    live_brand_extraction_complete: detail?.brand_extraction_complete,
    live_brand_evidence_source: detail?.brand_evidence_source,
    category_key: seed.category_key,
    accessory_role: seed.accessory_role,
    live_category_key: classification?.category_key,
    live_item_count: classification?.item_count,
    live_is_bundle: classification?.is_bundle,
    live_is_set: classification?.is_set,
    live_compatibility_scope: classification?.compatibility_scope,
    live_role_attributes: classification?.role_attributes,
    live_role_attribute_evidence: classification?.role_attribute_evidence,
    live_structured_evidence: classification?.structured_evidence,
    ...detailPriceFields(detail),
  };
}

export async function runAuditedSeedObservationDiscovery({
  seedArtifact,
  seedBinding,
  adapter,
  resumeScans = [],
  resumeObservations = [],
  resumeDetails = [],
  onObservation = null,
  onCheckpoint = null,
  now = () => new Date(),
} = {}) {
  if (seedArtifact?.contract !== AUDITED_DISCOVERY_SEED_CONTRACT
    || seedArtifact?.deployment_phase !== "validation_only"
    || !/^[a-f0-9]{64}$/u.test(String(seedArtifact?.artifact_sha256 || ""))) {
    fail("seed observation discovery requires a loaded, externally pinned validation-only seed artifact");
  }
  if (seedBinding?.contract !== AUDITED_DISCOVERY_SEED_BINDING_CONTRACT
    || seedBinding.seed_artifact_sha256 !== seedArtifact.artifact_sha256
    || seedBinding.seed_source_set_sha256 !== seedArtifact.source_set_sha256) {
    fail("seed observation discovery binding does not match the loaded artifact");
  }
  const readOnly = validateSeedReadOnlyAdapter(adapter);
  if (onObservation !== null && typeof onObservation !== "function") fail("onObservation must be a function");
  if (onCheckpoint !== null && typeof onCheckpoint !== "function") fail("onCheckpoint must be a function");
  const resumedScans = new Map();
  for (const row of resumeScans || []) {
    const checked = validateSeedScanCheckpoint(row, seedArtifact, seedBinding, now());
    const sourceUrl = exactAuditedSourceUrl(checked.source_url);
    if (!sourceUrl || resumedScans.has(sourceUrl)) fail("resumeScans must contain unique exact source URLs");
    resumedScans.set(sourceUrl, checked);
  }
  const occurrencesBySku = new Map();
  const stageOneRejected = [];
  let scannedSourceCount = 0;
  for (const seed of seedArtifact.seeds) {
    for (const sourceUrl of seed.source_urls) {
      const resumed = resumedScans.get(sourceUrl);
      const scan = resumed || await readOnly.scanSource(Object.freeze({
          source_url: sourceUrl,
          seed_id: seed.id,
          category_key: seed.category_key,
          accessory_role: seed.accessory_role,
        }));
      const rawLinks = exactSourceScanResult(sourceUrl, scan, `seed ${seed.id}`);
      const stageOne = stageOneTargetLinks(
        seed,
        rawLinks,
        seedArtifact.global_guard,
        seed.seed_price_band_rub,
      );
      stageOneRejected.push(...stageOne.rejected.map((entry) => ({ ...entry, seed_id: seed.id, source_url: sourceUrl })));
      scannedSourceCount += 1;
      const checkpointLinks = [];
      for (const link of stageOne.accepted) {
        const rawUrl = String(link?.href || link?.url || "");
        const sku = String(link?.sku || skuFromProductLink(rawUrl)).trim();
        if (!/^\d+$/u.test(sku) || /^0+$/u.test(sku)) continue;
        let productUrl;
        try { productUrl = normalizeProductUrl(rawUrl, sku, `seed ${seed.id} card product URL`); }
        catch { continue; }
        const occurrences = occurrencesBySku.get(sku) || [];
        occurrences.push(Object.freeze({ seed, sourceUrl, productUrl, cardTitle: link.title }));
        occurrencesBySku.set(sku, occurrences);
        checkpointLinks.push(Object.freeze({
          sku,
          href: productUrl,
          title: link.title,
          current_price_rub: link.current_price_rub,
          card_price_evidence: link.card_price_evidence,
        }));
      }
      if (!resumed && checkpointLinks.length > 0 && onCheckpoint) await onCheckpoint(Object.freeze({
        contract: AUDITED_DISCOVERY_SEED_SCAN_CHECKPOINT_CONTRACT,
        evidence_scope: AUDITED_DISCOVERY_SEED_SCOPE,
        stage: "seed-source-scan",
        status: "completed",
        complete: true,
        stop_reason: "completed",
        run_id: seedBinding.run_id,
        campaign_epoch: seedBinding.campaign_epoch,
        activated_at: seedBinding.activated_at,
        observed_at: timestamp(now(), "seed scan checkpoint observed_at"),
        seed_artifact_sha256: seedBinding.seed_artifact_sha256,
        seed_source_set_sha256: seedBinding.seed_source_set_sha256,
        source_url: sourceUrl,
        final_url: sourceUrl,
        seed_id: seed.id,
        links: Object.freeze(checkpointLinks),
        stage1_rejected_count: stageOne.rejected.length,
      }));
    }
  }
  if (scannedSourceCount !== AUDITED_DISCOVERY_EXACT_SOURCE_COUNT) {
    fail(`seed observation discovery must scan exactly ${AUDITED_DISCOVERY_EXACT_SOURCE_COUNT} sources`);
  }
  const accepted = [];
  const resumedSku = new Set();
  const resumedObservationBySku = new Map();
  for (const row of resumeObservations || []) {
    const eligibility = auditedSeedObservationEligibility(row, seedArtifact, seedBinding, { now: now() });
    if (!eligibility.eligible) fail(`resume observation rejected: ${eligibility.reason}`);
    if (resumedSku.has(eligibility.observation.sku)) fail("resume observations contain duplicate SKU identity");
    resumedSku.add(eligibility.observation.sku);
    accepted.push(eligibility.observation);
    resumedObservationBySku.set(eligibility.observation.sku, eligibility.observation);
  }
  const resumedDetailsBySku = new Map();
  for (const row of resumeDetails || []) {
    const sku = String(row?.sku || "").trim();
    const occurrences = occurrencesBySku.get(sku);
    if (!occurrences) fail(`seed resume detail checkpoint SKU ${sku || "<missing>"} was not rediscovered`);
    const checked = validateSeedDetailCheckpoint(row, occurrences, seedArtifact, seedBinding, now());
    if (resumedDetailsBySku.has(checked.sku)) fail("seed resume detail checkpoints contain duplicate SKU identity");
    const observation = resumedObservationBySku.get(checked.sku);
    if (checked.status === "accepted") {
      if (!observation || checked.observation_sha256 !== auditedCanonicalDocumentSha256(observation)) {
        fail("accepted seed detail checkpoint does not match its persisted observation");
      }
    } else if (observation) {
      fail("terminal-rejected seed detail checkpoint conflicts with an accepted observation");
    }
    resumedDetailsBySku.set(checked.sku, checked);
  }
  for (const observation of resumedObservationBySku.values()) {
    const occurrences = occurrencesBySku.get(observation.sku);
    const selectedOccurrence = occurrences?.find((entry) => entry.seed.id === observation.seed_id
      && entry.sourceUrl === observation.source_url && entry.productUrl === observation.product_url);
    if (!selectedOccurrence) fail("resumed seed observation is outside the current source occurrence set");
    if (!resumedDetailsBySku.has(observation.sku) && onCheckpoint) {
      const normalizedOccurrences = normalizedSeedDetailOccurrences(occurrences, observation.sku);
      await onCheckpoint(Object.freeze({
        contract: AUDITED_DISCOVERY_SEED_DETAIL_CHECKPOINT_CONTRACT,
        evidence_scope: AUDITED_DISCOVERY_SEED_SCOPE,
        stage: "seed-product-detail",
        status: "accepted",
        terminal: true,
        run_id: seedBinding.run_id,
        campaign_epoch: seedBinding.campaign_epoch,
        activated_at: seedBinding.activated_at,
        observed_at: timestamp(now(), "seed accepted detail checkpoint observed_at"),
        seed_artifact_sha256: seedBinding.seed_artifact_sha256,
        seed_source_set_sha256: seedBinding.seed_source_set_sha256,
        sku: observation.sku,
        product_url: observation.product_url,
        occurrences: normalizedOccurrences,
        occurrence_set_sha256: auditedCanonicalDocumentSha256(normalizedOccurrences),
        selected_seed_id: observation.seed_id,
        selected_source_url: observation.source_url,
        observation_sha256: auditedCanonicalDocumentSha256(observation),
        reason: null,
      }));
    }
  }
  const rejected = [];
  for (const [sku, occurrences] of [...occurrencesBySku.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (resumedSku.has(sku)) continue;
    const resumedDetail = resumedDetailsBySku.get(sku);
    if (resumedDetail?.status === "terminal-rejected") {
      rejected.push(Object.freeze({ sku, reason: resumedDetail.reason, resumed: true }));
      continue;
    }
    const ranked = [...occurrences].sort((left, right) => right.seed.required_term_groups_all.length
      - left.seed.required_term_groups_all.length
      || left.seed.selection_priority - right.seed.selection_priority
      || left.seed.id.localeCompare(right.seed.id));
    const requestedProductUrl = ranked[0].productUrl;
    const detail = await readOnly.fetchProductDetail(Object.freeze({
      sku,
      product_url: requestedProductUrl,
      seed_ids: Object.freeze([...new Set(ranked.map((entry) => entry.seed.id))]),
    }));
    let selected = null;
    for (const occurrence of ranked) {
      const titleEligibility = targetTitleEligibility(detail?.title, occurrence.seed, seedArtifact.global_guard);
      if (!titleEligibility.eligible) continue;
      const classification = await readOnly.classifyProduct(Object.freeze({
        sku,
        product_url: requestedProductUrl,
        detail,
        seed: occurrence.seed,
      }));
      const candidate = seedObservationFromDetail({
        seed: occurrence.seed,
        sourceUrl: occurrence.sourceUrl,
        sku,
        productUrl: requestedProductUrl,
        detail,
        classification,
        binding: seedBinding,
      });
      const eligibility = auditedSeedObservationEligibility(candidate, seedArtifact, seedBinding, { now: now() });
      if (eligibility.eligible) {
        selected = eligibility.observation;
        break;
      }
    }
    if (!selected) {
      rejected.push(Object.freeze({ sku, reason: "no-detail-strict-seed-role-match" }));
      if (onCheckpoint) {
        const normalizedOccurrences = normalizedSeedDetailOccurrences(occurrences, sku);
        await onCheckpoint(Object.freeze({
        contract: AUDITED_DISCOVERY_SEED_DETAIL_CHECKPOINT_CONTRACT,
        evidence_scope: AUDITED_DISCOVERY_SEED_SCOPE,
        stage: "seed-product-detail",
        terminal: true,
        run_id: seedBinding.run_id,
        campaign_epoch: seedBinding.campaign_epoch,
        activated_at: seedBinding.activated_at,
        observed_at: timestamp(now(), "seed rejected detail checkpoint observed_at"),
        seed_artifact_sha256: seedBinding.seed_artifact_sha256,
        seed_source_set_sha256: seedBinding.seed_source_set_sha256,
        sku,
        product_url: requestedProductUrl,
        occurrences: normalizedOccurrences,
        occurrence_set_sha256: auditedCanonicalDocumentSha256(normalizedOccurrences),
        status: "terminal-rejected",
        reason: "no-detail-strict-seed-role-match",
        selected_seed_id: null,
        selected_source_url: null,
        observation_sha256: null,
      }));
      }
      continue;
    }
    accepted.push(selected);
    if (onObservation) await onObservation(selected);
    if (onCheckpoint) {
      const normalizedOccurrences = normalizedSeedDetailOccurrences(occurrences, sku);
      await onCheckpoint(Object.freeze({
      contract: AUDITED_DISCOVERY_SEED_DETAIL_CHECKPOINT_CONTRACT,
      evidence_scope: AUDITED_DISCOVERY_SEED_SCOPE,
      stage: "seed-product-detail",
      terminal: true,
      run_id: seedBinding.run_id,
      campaign_epoch: seedBinding.campaign_epoch,
      activated_at: seedBinding.activated_at,
      observed_at: timestamp(now(), "seed accepted detail checkpoint observed_at"),
      seed_artifact_sha256: seedBinding.seed_artifact_sha256,
      seed_source_set_sha256: seedBinding.seed_source_set_sha256,
      sku,
      product_url: selected.product_url,
      occurrences: normalizedOccurrences,
      occurrence_set_sha256: auditedCanonicalDocumentSha256(normalizedOccurrences),
      status: "accepted",
      selected_seed_id: selected.seed_id,
      selected_source_url: selected.source_url,
      observation_sha256: auditedCanonicalDocumentSha256(selected),
      reason: null,
    }));
    }
  }
  return Object.freeze({
    scanned_source_count: scannedSourceCount,
    discovered_unique_skus: occurrencesBySku.size,
    accepted_observations: Object.freeze(accepted),
    rejected_observations: Object.freeze(rejected),
    stage1_rejected_links: Object.freeze(stageOneRejected),
  });
}

function sellerSourceUrl(sellerUrl, band, page) {
  const url = new URL(sellerUrl);
  url.searchParams.set("currency_price", `${band.min.toFixed(3)};${band.max.toFixed(3)}`);
  if (page > 1) url.searchParams.set("page", String(page));
  url.searchParams.set("sorting", "rating");
  url.searchParams.sort();
  return url.toString();
}

function derivedSourceRows(targets) {
  return targets.flatMap((target) => [1, 2].map((page) => Object.freeze({
    source_url: sellerSourceUrl(target.seller_url, target.seller_price_band_rub, page),
    target_id: target.id,
    seller_url: target.seller_url,
    category_key: target.category_key,
    accessory_role: target.accessory_role,
    page,
  })));
}

function derivedTargetFromGroup(sellerUrl, winner, observations) {
  const seed = winner.seed;
  const sellerSlug = new URL(sellerUrl).pathname.split("/").filter(Boolean).at(-1);
  return Object.freeze({
    id: `${sellerSlug}-${seed.id}`,
    seller_url: sellerUrl,
    originating_seed_id: seed.id,
    category_key: seed.category_key,
    accessory_role: seed.accessory_role,
    // This is the normalized value actually observed on every row in the
    // seller×seed×role-signature group, not a classifier-supplied placeholder.
    required_role_attributes: observations[0].live_role_attributes,
    title_prefix_terms_any: seed.title_prefix_terms_any,
    required_term_groups_all: seed.required_term_groups_all,
    deny_terms_any: seed.deny_terms_any,
    deny_regex_any: seed.deny_regex_any,
    allowed_latin_tokens: seed.allowed_latin_tokens,
    deny_unknown_latin_tokens: true,
    seller_price_band_rub: seed.seller_price_band_rub,
    sorting: "rating",
    max_page: 2,
    seed_observation_count: observations.length,
    seed_observation_skus: Object.freeze(observations.map((row) => row.sku).sort()),
  });
}

export function compileAuditedDerivedSellerPortfolio({
  seedArtifact,
  seedBinding,
  observations = [],
  generatedAt = new Date(),
} = {}) {
  if (seedArtifact?.contract !== AUDITED_DISCOVERY_SEED_CONTRACT
    || seedArtifact?.deployment_phase !== "validation_only") {
    fail("compiler requires a loaded validation-only seed artifact");
  }
  if (seedBinding?.contract !== AUDITED_DISCOVERY_SEED_BINDING_CONTRACT
    || seedBinding.seed_artifact_sha256 !== seedArtifact.artifact_sha256
    || seedBinding.seed_source_set_sha256 !== seedArtifact.source_set_sha256) {
    fail("compiler seed binding does not match the loaded seed artifact");
  }
  const accepted = [];
  const rejected = [];
  for (const row of observations) {
    const result = auditedSeedObservationEligibility(row, seedArtifact, seedBinding, { now: generatedAt });
    if (result.eligible) accepted.push(result.observation);
    else rejected.push({ reason: result.reason, sku: String(row?.sku || "") || null });
  }
  const seedPriority = new Map(seedArtifact.seeds.map((seed) => [seed.id, seed.selection_priority]));
  const unique = new Map();
  let mutuallyExclusiveDedupCount = 0;
  const seedById = new Map(seedArtifact.seeds.map((seed) => [seed.id, seed]));
  for (const row of [...accepted].sort((left, right) => {
    const leftSeed = seedById.get(left.seed_id);
    const rightSeed = seedById.get(right.seed_id);
    return rightSeed.required_term_groups_all.length - leftSeed.required_term_groups_all.length
      || seedPriority.get(left.seed_id) - seedPriority.get(right.seed_id)
      || left.seed_id.localeCompare(right.seed_id);
  })) {
    const previous = unique.get(row.sku);
    if (previous && (previous.product_url !== row.product_url
      || previous.seller_url !== row.seller_url
      || previous.live_title !== row.live_title
      || previous.live_brand !== row.live_brand)) {
      fail(`seed observation SKU ${row.sku} has conflicting seller, product, title, or brand identity`);
    }
    // Overlapping search seeds are mutually exclusive by an artifact-pinned
    // specificity priority.  Seller/product/brand conflicts still fail closed;
    // only category/role overlap may be resolved by the declared priority.
    if (!previous) unique.set(row.sku, row);
    else mutuallyExclusiveDedupCount += 1;
  }
  const sellerRoleGroups = new Map();
  for (const row of unique.values()) {
    const roleAttributeSignature = JSON.stringify(row.live_role_attributes);
    const key = `${row.seller_url}\0${row.seed_id}\0${roleAttributeSignature}`;
    const group = sellerRoleGroups.get(key) || {
      seller_url: row.seller_url,
      seed_id: row.seed_id,
      role_attribute_signature: roleAttributeSignature,
      rows: [],
    };
    group.rows.push(row);
    sellerRoleGroups.set(key, group);
  }
  const candidatesBySeller = new Map();
  for (const group of sellerRoleGroups.values()) {
    if (group.rows.length < seedArtifact.compiler_policy.minimum_observations_per_seller_role) continue;
    const seed = seedArtifact.seeds.find((entry) => entry.id === group.seed_id);
    const values = candidatesBySeller.get(group.seller_url) || [];
    values.push({ ...group, seed });
    candidatesBySeller.set(group.seller_url, values);
  }
  const selected = [...candidatesBySeller.entries()].map(([sellerUrl, groups]) => {
    const ranked = groups.sort((left, right) => right.rows.length - left.rows.length
      || left.seed.selection_priority - right.seed.selection_priority
      || left.seed.id.localeCompare(right.seed.id));
    return derivedTargetFromGroup(sellerUrl, ranked[0], ranked[0].rows);
  }).sort((left, right) => right.seed_observation_count - left.seed_observation_count
    || left.seller_url.localeCompare(right.seller_url))
    .slice(0, seedArtifact.compiler_policy.maximum_distinct_sellers);
  const sourceRows = derivedSourceRows(selected);
  if (new Set(sourceRows.map((row) => row.source_url)).size !== sourceRows.length) {
    fail("compiler produced duplicate exact seller source URLs");
  }
  const createdAt = timestamp(generatedAt, "derived artifact generated_at");
  const sourceSetSha256 = auditedSourceSetSha256(sourceRows.map((row) => row.source_url));
  const observationSetSha256 = auditedCanonicalDocumentSha256(
    [...unique.values()].sort((left, right) => left.seller_url.localeCompare(right.seller_url)
      || left.seed_id.localeCompare(right.seed_id) || left.sku.localeCompare(right.sku)),
  );
  const draft = Object.freeze({
    contract: AUDITED_DERIVED_SELLER_CONTRACT,
    schema_version: AUDITED_DERIVED_SELLER_SCHEMA_VERSION,
    deployment_phase: "validation_only",
    automatic_publish_eligible: false,
    price_evidence_publish_eligible: false,
    favorite_mutations_allowed: false,
    submission_allowed: false,
    generated_at: createdAt,
    compiler_version: AUDITED_DERIVED_COMPILER_VERSION,
    provenance: Object.freeze({
      parent_seed_artifact_sha256: seedArtifact.artifact_sha256,
      parent_seed_source_set_sha256: seedArtifact.source_set_sha256,
      seed_run_id: seedBinding.run_id,
      seed_campaign_epoch: seedBinding.campaign_epoch,
      seed_activated_at: seedBinding.activated_at,
      accepted_observation_set_sha256: observationSetSha256,
      accepted_observation_count: unique.size,
      rejected_observation_count: rejected.length,
      mutually_exclusive_dedup_count: mutuallyExclusiveDedupCount,
      historical_proxy_publication_credit: 0,
    }),
    source_query_contract: Object.freeze({
      price_parameter: "currency_price",
      price_band_currency: "RUB",
      effective_cny_evidence: "live-same-page-rate-only",
      sorting: "rating",
      max_page: 2,
      identity_checkpoint_max_age_ms: AUDITED_CAMPAIGN_CHECKPOINT_MAX_AGE_MS,
      current_price_max_age_ms: AUDITED_CURRENT_PRICE_MAX_AGE_MS,
      next_stage_requires_live_price_refetch: true,
    }),
    global_guard: seedArtifact.global_guard,
    readiness: Object.freeze({
      status: "capacity_unverified",
      minimum_brand_safe_unique_skus: AUDITED_DERIVED_CAPACITY_MINIMUM,
      brand_safe_unique_skus: 0,
      historical_proxy_counts_for_gate: false,
      capacity_forecast_only: true,
      minimum_current_sellers: AUDITED_DERIVED_MINIMUM_CURRENT_SELLERS,
      current_sellers: 0,
      seller_contribution_cap: AUDITED_DERIVED_SELLER_CONTRIBUTION_CAP,
      price_evidence_publish_eligible: false,
      next_stage_requires_live_price_refetch: true,
    }),
    target_count: selected.length,
    minimum_distinct_sellers: seedArtifact.compiler_policy.minimum_distinct_sellers,
    targets: Object.freeze(selected),
    active_source_bindings: Object.freeze(sourceRows),
    active_urls: Object.freeze(sourceRows.map((row) => row.source_url)),
    source_set_sha256: sourceSetSha256,
  });
  return Object.freeze({
    artifact: draft,
    artifact_sha256: auditedDerivedArtifactSha256(draft),
    selected_target_count: selected.length,
    target_minimum_met: selected.length >= seedArtifact.compiler_policy.minimum_distinct_sellers,
    accepted_observation_count: unique.size,
    rejected_observations: Object.freeze(rejected),
  });
}

function normalizedDerivedTarget(row, index) {
  const label = `targets[${index}]`;
  const sellerUrl = auditedSellerRoot(row?.seller_url);
  if (!sellerUrl) fail(`${label}.seller_url is invalid`);
  const target = Object.freeze({
    id: nonEmpty(row?.id, `${label}.id`),
    seller_url: sellerUrl,
    originating_seed_id: nonEmpty(row?.originating_seed_id, `${label}.originating_seed_id`),
    category_key: nonEmpty(row?.category_key, `${label}.category_key`),
    accessory_role: nonEmpty(row?.accessory_role, `${label}.accessory_role`),
    required_role_attributes: normalizeRoleAttributes(
      row?.required_role_attributes,
      `${label}.required_role_attributes`,
    ),
    title_prefix_terms_any: normalizeTerms(row?.title_prefix_terms_any, `${label}.title_prefix_terms_any`),
    required_term_groups_all: normalizeTermGroups(row?.required_term_groups_all, `${label}.required_term_groups_all`),
    deny_terms_any: normalizeTerms(row?.deny_terms_any, `${label}.deny_terms_any`, { optional: true }),
    deny_regex_any: normalizeRegexPatterns(row?.deny_regex_any, `${label}.deny_regex_any`, { optional: true }),
    allowed_latin_tokens: normalizeTerms(row?.allowed_latin_tokens, `${label}.allowed_latin_tokens`, { optional: true }),
    deny_unknown_latin_tokens: row?.deny_unknown_latin_tokens === true,
    seller_price_band_rub: normalizeRubBand(row?.seller_price_band_rub, `${label}.seller_price_band_rub`),
    sorting: nonEmpty(row?.sorting, `${label}.sorting`),
    max_page: positiveInteger(row?.max_page, `${label}.max_page`),
    seed_observation_count: positiveInteger(row?.seed_observation_count, `${label}.seed_observation_count`),
    seed_observation_skus: Object.freeze([...new Set((row?.seed_observation_skus || []).map(String))].sort()),
  });
  if (!target.deny_unknown_latin_tokens || target.sorting !== "rating" || target.max_page !== 2) {
    fail(`${label} must enforce unknown Latin token denial, rating, and page<=2`);
  }
  if (target.seed_observation_skus.length !== target.seed_observation_count
    || target.seed_observation_skus.some((sku) => !/^\d+$/u.test(sku))) {
    fail(`${label}.seed_observation_skus must exactly support seed_observation_count`);
  }
  return target;
}

export function validateAuditedDerivedSellerArtifact(value, { sourcePath = "<memory>", now = new Date() } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${sourcePath} must be a JSON object`);
  if (value.contract !== AUDITED_DERIVED_SELLER_CONTRACT
    || Number(value.schema_version) !== AUDITED_DERIVED_SELLER_SCHEMA_VERSION) {
    fail(`${sourcePath} has an unsupported derived seller contract`);
  }
  if (value.deployment_phase !== "validation_only"
    || value.automatic_publish_eligible !== false
    || value.price_evidence_publish_eligible !== false
    || value.favorite_mutations_allowed !== false
    || value.submission_allowed !== false) {
    fail(`${sourcePath} must remain validation-only and mutation-disabled`);
  }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  const generatedAt = timestamp(value.generated_at, `${sourcePath}.generated_at`, { now: nowMs });
  if (value.compiler_version !== AUDITED_DERIVED_COMPILER_VERSION) fail(`${sourcePath}.compiler_version is unsupported`);
  for (const key of [
    "parent_seed_artifact_sha256",
    "parent_seed_source_set_sha256",
    "accepted_observation_set_sha256",
  ]) sha256Value(value.provenance?.[key], `${sourcePath}.provenance.${key}`);
  if (Number(value.provenance?.historical_proxy_publication_credit) !== 0) {
    fail(`${sourcePath} historical proxy cannot receive publication credit`);
  }
  const query = value.source_query_contract || {};
  if (query.price_parameter !== "currency_price" || query.price_band_currency !== "RUB"
    || query.effective_cny_evidence !== "live-same-page-rate-only"
    || query.sorting !== "rating" || Number(query.max_page) !== 2
    || Number(query.identity_checkpoint_max_age_ms) !== AUDITED_CAMPAIGN_CHECKPOINT_MAX_AGE_MS
    || Number(query.current_price_max_age_ms) !== AUDITED_CURRENT_PRICE_MAX_AGE_MS
    || query.next_stage_requires_live_price_refetch !== true) {
    fail(`${sourcePath}.source_query_contract is invalid`);
  }
  const globalDeny = normalizeTerms(value.global_guard?.deny_terms_any, `${sourcePath}.global_guard.deny_terms_any`);
  const globalDenyRegex = normalizeRegexPatterns(
    value.global_guard?.deny_regex_any,
    `${sourcePath}.global_guard.deny_regex_any`,
  );
  const derivedLatinPolicy = value.global_guard?.unknown_latin_token_policy || {};
  if (derivedLatinPolicy.action !== "reject" || Number(derivedLatinPolicy.min_alpha_length) !== 3) {
    fail(`${sourcePath}.global_guard.unknown_latin_token_policy is invalid`);
  }
  const derivedLatinAllowlist = normalizeTerms(
    derivedLatinPolicy.allowlist,
    `${sourcePath}.global_guard.unknown_latin_token_policy.allowlist`,
  );
  if (value.global_guard?.live_brand_policy !== "empty-or-no-name-only") {
    fail(`${sourcePath}.global_guard.live_brand_policy is invalid`);
  }
  if (!Array.isArray(value.targets)) fail(`${sourcePath}.targets must be an array`);
  const targets = value.targets.map(normalizedDerivedTarget);
  if (Number(value.target_count) !== targets.length) fail(`${sourcePath}.target_count does not match targets`);
  const minimumDistinctSellers = positiveInteger(
    value.minimum_distinct_sellers,
    `${sourcePath}.minimum_distinct_sellers`,
  );
  if (minimumDistinctSellers < AUDITED_DERIVED_MINIMUM_CURRENT_SELLERS) {
    fail(`${sourcePath}.minimum_distinct_sellers must be at least ${AUDITED_DERIVED_MINIMUM_CURRENT_SELLERS}`);
  }
  const ids = new Set();
  const sellers = new Set();
  for (const target of targets) {
    if (ids.has(target.id) || sellers.has(target.seller_url)) fail(`${sourcePath} target ids and sellers must be unique`);
    ids.add(target.id);
    sellers.add(target.seller_url);
  }
  const sourceRows = derivedSourceRows(targets);
  const suppliedRows = value.active_source_bindings || [];
  if (suppliedRows.length !== sourceRows.length
    || suppliedRows.some((row, index) => exactAuditedSourceUrl(row?.source_url) !== sourceRows[index].source_url
      || row?.target_id !== sourceRows[index].target_id
      || row?.seller_url !== sourceRows[index].seller_url
      || row?.category_key !== sourceRows[index].category_key
      || row?.accessory_role !== sourceRows[index].accessory_role
      || Number(row?.page) !== sourceRows[index].page)) {
    fail(`${sourcePath}.active_source_bindings do not match deterministic target expansion`);
  }
  const activeUrls = sourceRows.map((row) => row.source_url);
  if (!Array.isArray(value.active_urls) || value.active_urls.length !== activeUrls.length
    || value.active_urls.some((url, index) => exactAuditedSourceUrl(url) !== activeUrls[index])) {
    fail(`${sourcePath}.active_urls do not match deterministic target expansion`);
  }
  const sourceSetSha256 = auditedSourceSetSha256(activeUrls);
  if (sha256Value(value.source_set_sha256, `${sourcePath}.source_set_sha256`) !== sourceSetSha256) {
    fail(`${sourcePath}.source_set_sha256 does not match active_urls`);
  }
  const status = nonEmpty(value.readiness?.status, `${sourcePath}.readiness.status`);
  if (!new Set(["capacity_unverified", "not_ready", "ready_for_validation_discovery"]).has(status)) {
    fail(`${sourcePath}.readiness.status is unsupported`);
  }
  const minimum = positiveInteger(
    value.readiness?.minimum_brand_safe_unique_skus,
    `${sourcePath}.readiness.minimum_brand_safe_unique_skus`,
  );
  if (minimum !== AUDITED_DERIVED_CAPACITY_MINIMUM
    || value.readiness?.historical_proxy_counts_for_gate !== false
    || Number(value.readiness?.minimum_current_sellers) !== AUDITED_DERIVED_MINIMUM_CURRENT_SELLERS
    || Number(value.readiness?.seller_contribution_cap) !== AUDITED_DERIVED_SELLER_CONTRIBUTION_CAP
    || value.readiness?.price_evidence_publish_eligible !== false
    || value.readiness?.next_stage_requires_live_price_refetch !== true) {
    fail(`${sourcePath}.readiness must use the 360 live brand-safe gate and exclude historical proxy counts`);
  }
  const brandSafeCount = nonNegativeInteger(
    value.readiness?.brand_safe_unique_skus,
    `${sourcePath}.readiness.brand_safe_unique_skus`,
  );
  const currentSellers = nonNegativeInteger(
    value.readiness?.current_sellers,
    `${sourcePath}.readiness.current_sellers`,
  );
  const readyByCounts = brandSafeCount >= minimum
    && currentSellers >= AUDITED_DERIVED_MINIMUM_CURRENT_SELLERS
    && targets.length >= minimumDistinctSellers;
  if (currentSellers > targets.length) fail(`${sourcePath}.readiness.current_sellers exceeds target_count`);
  if ((status === "ready_for_validation_discovery") !== readyByCounts) {
    fail(`${sourcePath}.readiness status does not match its brand-safe capacity`);
  }
  return Object.freeze({
    ...value,
    generated_at: generatedAt,
    global_guard: Object.freeze({
      deny_terms_any: globalDeny,
      deny_regex_any: globalDenyRegex,
      unknown_latin_token_policy: Object.freeze({
        action: "reject",
        min_alpha_length: 3,
        allowlist: derivedLatinAllowlist,
      }),
      live_brand_policy: "empty-or-no-name-only",
    }),
    targets: Object.freeze(targets),
    active_source_bindings: Object.freeze(sourceRows),
    active_urls: Object.freeze(activeUrls),
    source_set_sha256: sourceSetSha256,
    readiness: Object.freeze({ ...value.readiness, brand_safe_unique_skus: brandSafeCount }),
  });
}

export async function loadAuditedDerivedSellerArtifact(filename, {
  expectedFileSha256,
  expectedArtifactSha256,
  now = new Date(),
} = {}) {
  const expectedFile = sha256Value(expectedFileSha256, "expected derived artifact file SHA256");
  const expectedArtifact = sha256Value(expectedArtifactSha256, "expected derived artifact semantic SHA256");
  const sourcePath = path.resolve(nonEmpty(filename, "derived artifact filename"));
  let bytes;
  let parsed;
  try {
    bytes = await fs.readFile(sourcePath);
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`${sourcePath} could not be loaded: ${error.message}`);
  }
  if (sha256(bytes) !== expectedFile) fail(`${sourcePath} file SHA256 does not match the external pin`);
  const artifact = validateAuditedDerivedSellerArtifact(parsed, { sourcePath, now });
  const semanticSha256 = auditedDerivedArtifactSha256(artifact);
  if (semanticSha256 !== expectedArtifact) fail(`${sourcePath} semantic SHA256 does not match the external activation pin`);
  return Object.freeze({ ...artifact, source_path: sourcePath, artifact_sha256: semanticSha256, file_sha256: expectedFile });
}

export function buildAuditedDerivedCapacityBinding({
  derivedArtifact,
  derivedArtifactSha256,
  runId,
  campaignEpoch,
  activatedAt,
  now = new Date(),
} = {}) {
  const artifactSha = sha256Value(
    derivedArtifactSha256 || derivedArtifact?.artifact_sha256,
    "capacity binding derived artifact SHA256",
  );
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  return Object.freeze({
    contract: AUDITED_DERIVED_CAPACITY_BINDING_CONTRACT,
    run_id: nonEmpty(runId, "capacity binding run_id"),
    campaign_epoch: nonNegativeInteger(campaignEpoch, "capacity binding campaign_epoch"),
    activated_at: timestamp(activatedAt, "capacity binding activated_at", { now: nowMs }),
    derived_artifact_sha256: artifactSha,
    source_set_sha256: sha256Value(derivedArtifact?.source_set_sha256, "capacity binding source-set SHA256"),
  });
}

function capacityObservationFromDetail({ target, sourceUrl, sku, productUrl, detail, classification, binding }) {
  const observedCurrentSellerUrl = String(detail?.seller_url || "").trim()
    ? auditedSellerRoot(detail.seller_url)
    : null;
  if (String(detail?.seller_url || "").trim() && !observedCurrentSellerUrl) {
    fail("capacity detail current seller URL is present but not canonicalizable");
  }
  return {
    contract: AUDITED_DERIVED_CAPACITY_OBSERVATION_CONTRACT,
    evidence_scope: AUDITED_DERIVED_CAPACITY_SCOPE,
    status: "observed",
    run_id: binding.run_id,
    campaign_epoch: binding.campaign_epoch,
    activated_at: binding.activated_at,
    observed_at: detail?.observed_at,
    derived_artifact_sha256: binding.derived_artifact_sha256,
    source_set_sha256: binding.source_set_sha256,
    source_url: sourceUrl,
    final_source_url: sourceUrl,
    target_id: target.id,
    // The exact seller page that exposed this card is authoritative. Ozon's
    // product page may default to a different offer/seller.
    seller_url: target.seller_url,
    observed_current_seller_url: observedCurrentSellerUrl,
    category_key: target.category_key,
    accessory_role: target.accessory_role,
    sku,
    product_url: productUrl,
    final_product_url: detail?.final_url,
    live_title: detail?.title,
    live_brand: detail?.brand,
    live_brand_extraction_complete: detail?.brand_extraction_complete,
    live_brand_evidence_source: detail?.brand_evidence_source,
    live_category_key: classification?.category_key,
    live_item_count: classification?.item_count,
    live_is_bundle: classification?.is_bundle,
    live_is_set: classification?.is_set,
    live_compatibility_scope: classification?.compatibility_scope,
    live_role_attributes: classification?.role_attributes,
    live_role_attribute_evidence: classification?.role_attribute_evidence,
    live_structured_evidence: classification?.structured_evidence,
    ...detailPriceFields(detail),
  };
}

export async function runAuditedDerivedCapacityProbe({
  derivedArtifact,
  derivedArtifactSha256,
  capacityBinding,
  adapter,
  resumeScans = [],
  resumeObservations = [],
  resumeDetails = [],
  onObservation = null,
  onCheckpoint = null,
  now = () => new Date(),
} = {}) {
  const checkedArtifact = validateAuditedDerivedSellerArtifact(derivedArtifact, { now: now() });
  const semanticSha = auditedDerivedArtifactSha256(checkedArtifact);
  if (sha256Value(derivedArtifactSha256, "capacity probe derived artifact SHA256") !== semanticSha) {
    fail("capacity probe derived artifact semantic SHA256 mismatch");
  }
  if (capacityBinding?.contract !== AUDITED_DERIVED_CAPACITY_BINDING_CONTRACT
    || capacityBinding.derived_artifact_sha256 !== semanticSha
    || capacityBinding.source_set_sha256 !== checkedArtifact.source_set_sha256) {
    fail("capacity probe binding does not match the derived artifact");
  }
  const readOnly = validateSeedReadOnlyAdapter(adapter);
  if (onObservation !== null && typeof onObservation !== "function") fail("onObservation must be a function");
  if (onCheckpoint !== null && typeof onCheckpoint !== "function") fail("onCheckpoint must be a function");
  const targetById = new Map(checkedArtifact.targets.map((target) => [target.id, target]));
  const resumedScans = new Map();
  for (const row of resumeScans || []) {
    const checked = validateCapacityScanCheckpoint(row, checkedArtifact, capacityBinding, now());
    const sourceUrl = exactAuditedSourceUrl(checked.source_url);
    if (!sourceUrl || resumedScans.has(sourceUrl)) fail("capacity resumeScans must contain unique exact source URLs");
    resumedScans.set(sourceUrl, checked);
  }
  const occurrencesBySku = new Map();
  const stageOneRejected = [];
  for (const sourceBinding of checkedArtifact.active_source_bindings) {
    const target = targetById.get(sourceBinding.target_id);
    if (!target) fail(`capacity target ${sourceBinding.target_id} is missing`);
    const resumed = resumedScans.get(sourceBinding.source_url);
    const scan = resumed || await readOnly.scanSource(Object.freeze({
      source_url: sourceBinding.source_url,
      target_id: sourceBinding.target_id,
      originating_seed_id: target.originating_seed_id,
      seller_url: sourceBinding.seller_url,
      category_key: sourceBinding.category_key,
      accessory_role: sourceBinding.accessory_role,
    }));
    const rawLinks = exactSourceScanResult(
      sourceBinding.source_url,
      scan,
      `derived target ${sourceBinding.target_id}`,
    );
    const stageOne = stageOneTargetLinks(
      target,
      rawLinks,
      checkedArtifact.global_guard,
      target.seller_price_band_rub,
    );
    stageOneRejected.push(...stageOne.rejected.map((entry) => ({
      ...entry,
      target_id: target.id,
      source_url: sourceBinding.source_url,
    })));
    const checkpointLinks = [];
    for (const link of stageOne.accepted) {
      const rawUrl = String(link?.href || link?.url || "");
      const sku = String(link?.sku || skuFromProductLink(rawUrl)).trim();
      if (!/^\d+$/u.test(sku) || /^0+$/u.test(sku)) continue;
      let productUrl;
      try { productUrl = normalizeProductUrl(rawUrl, sku, "derived capacity card product URL"); }
      catch { continue; }
      const occurrences = occurrencesBySku.get(sku) || [];
      occurrences.push(Object.freeze({ sourceBinding, productUrl }));
      occurrencesBySku.set(sku, occurrences);
      checkpointLinks.push(Object.freeze({
        sku,
        href: productUrl,
        title: link.title,
        current_price_rub: link.current_price_rub,
        card_price_evidence: link.card_price_evidence,
      }));
    }
    if (!resumed && checkpointLinks.length > 0 && onCheckpoint) await onCheckpoint(Object.freeze({
      contract: AUDITED_DERIVED_CAPACITY_SCAN_CHECKPOINT_CONTRACT,
      evidence_scope: AUDITED_DERIVED_CAPACITY_SCOPE,
      stage: "capacity-source-scan",
      status: "completed",
      complete: true,
      stop_reason: "completed",
      run_id: capacityBinding.run_id,
      campaign_epoch: capacityBinding.campaign_epoch,
      activated_at: capacityBinding.activated_at,
      observed_at: timestamp(now(), "capacity scan checkpoint observed_at"),
      derived_artifact_sha256: capacityBinding.derived_artifact_sha256,
      source_set_sha256: capacityBinding.source_set_sha256,
      source_url: sourceBinding.source_url,
      final_url: sourceBinding.source_url,
      target_id: target.id,
      links: Object.freeze(checkpointLinks),
      stage1_rejected_count: stageOne.rejected.length,
    }));
  }
  const accepted = [];
  const resumedSku = new Set();
  const resumedObservationBySku = new Map();
  for (const row of resumeObservations || []) {
    const eligibility = capacityObservationIdentity(row, checkedArtifact, capacityBinding, now());
    if (!eligibility.eligible) fail(`capacity resume observation rejected: ${eligibility.reason}`);
    if (resumedSku.has(eligibility.observation.sku)) fail("capacity resume observations contain duplicate SKU identity");
    resumedSku.add(eligibility.observation.sku);
    accepted.push(eligibility.observation);
    resumedObservationBySku.set(eligibility.observation.sku, eligibility.observation);
  }
  const resumedDetailsBySku = new Map();
  for (const row of resumeDetails || []) {
    const sku = String(row?.sku || "").trim();
    const occurrences = occurrencesBySku.get(sku);
    if (!occurrences) fail(`capacity resume detail checkpoint SKU ${sku || "<missing>"} was not rediscovered`);
    const checked = validateCapacityDetailCheckpoint(row, occurrences, checkedArtifact, capacityBinding, now());
    if (resumedDetailsBySku.has(checked.sku)) fail("capacity resume detail checkpoints contain duplicate SKU identity");
    const observation = resumedObservationBySku.get(checked.sku);
    if (checked.status === "accepted") {
      if (!observation || checked.observation_sha256 !== auditedCanonicalDocumentSha256(observation)) {
        fail("accepted capacity detail checkpoint does not match its persisted observation");
      }
    } else if (observation) {
      fail("terminal-rejected capacity detail checkpoint conflicts with an accepted observation");
    }
    resumedDetailsBySku.set(checked.sku, checked);
  }
  for (const observation of resumedObservationBySku.values()) {
    const occurrences = occurrencesBySku.get(observation.sku);
    const selectedOccurrence = occurrences?.find((entry) => entry.sourceBinding.target_id === observation.target_id
      && entry.sourceBinding.source_url === observation.source_url
      && entry.productUrl === observation.product_url);
    if (!selectedOccurrence) fail("resumed capacity observation is outside the current source occurrence set");
    if (!resumedDetailsBySku.has(observation.sku) && onCheckpoint) {
      const normalizedOccurrences = normalizedCapacityDetailOccurrences(occurrences, observation.sku);
      await onCheckpoint(Object.freeze({
        contract: AUDITED_DERIVED_CAPACITY_DETAIL_CHECKPOINT_CONTRACT,
        evidence_scope: AUDITED_DERIVED_CAPACITY_SCOPE,
        stage: "capacity-product-detail",
        status: "accepted",
        terminal: true,
        run_id: capacityBinding.run_id,
        campaign_epoch: capacityBinding.campaign_epoch,
        activated_at: capacityBinding.activated_at,
        observed_at: timestamp(now(), "capacity accepted detail checkpoint observed_at"),
        derived_artifact_sha256: capacityBinding.derived_artifact_sha256,
        source_set_sha256: capacityBinding.source_set_sha256,
        sku: observation.sku,
        product_url: observation.product_url,
        occurrences: normalizedOccurrences,
        occurrence_set_sha256: auditedCanonicalDocumentSha256(normalizedOccurrences),
        selected_target_id: observation.target_id,
        selected_source_url: observation.source_url,
        observation_sha256: auditedCanonicalDocumentSha256(observation),
        reason: null,
      }));
    }
  }
  const rejected = [];
  for (const [sku, occurrences] of [...occurrencesBySku.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (resumedSku.has(sku)) continue;
    const resumedDetail = resumedDetailsBySku.get(sku);
    if (resumedDetail?.status === "terminal-rejected") {
      rejected.push(Object.freeze({ sku, reason: resumedDetail.reason, resumed: true }));
      continue;
    }
    const ranked = [...occurrences].sort((left, right) => left.sourceBinding.target_id.localeCompare(right.sourceBinding.target_id)
      || left.sourceBinding.page - right.sourceBinding.page);
    const requestedProductUrl = ranked[0].productUrl;
    const detail = await readOnly.fetchProductDetail(Object.freeze({
      sku,
      product_url: requestedProductUrl,
      target_ids: Object.freeze([...new Set(ranked.map((entry) => entry.sourceBinding.target_id))]),
    }));
    let selected = null;
    for (const occurrence of ranked) {
      const target = targetById.get(occurrence.sourceBinding.target_id);
      if (!target) continue;
      const titleEligibility = targetTitleEligibility(detail?.title, target, checkedArtifact.global_guard);
      if (!titleEligibility.eligible) continue;
      const classification = await readOnly.classifyProduct(Object.freeze({
        sku,
        product_url: requestedProductUrl,
        detail,
        target,
      }));
      const candidate = capacityObservationFromDetail({
        target,
        sourceUrl: occurrence.sourceBinding.source_url,
        sku,
        productUrl: requestedProductUrl,
        detail,
        classification,
        binding: capacityBinding,
      });
      const eligibility = capacityObservationIdentity(candidate, checkedArtifact, capacityBinding, now());
      if (eligibility.eligible) {
        selected = eligibility.observation;
        break;
      }
    }
    if (!selected) {
      rejected.push(Object.freeze({ sku, reason: "no-detail-strict-derived-target-match" }));
      if (onCheckpoint) {
        const normalizedOccurrences = normalizedCapacityDetailOccurrences(occurrences, sku);
        await onCheckpoint(Object.freeze({
        contract: AUDITED_DERIVED_CAPACITY_DETAIL_CHECKPOINT_CONTRACT,
        evidence_scope: AUDITED_DERIVED_CAPACITY_SCOPE,
        stage: "capacity-product-detail",
        terminal: true,
        run_id: capacityBinding.run_id,
        campaign_epoch: capacityBinding.campaign_epoch,
        activated_at: capacityBinding.activated_at,
        observed_at: timestamp(now(), "capacity rejected detail checkpoint observed_at"),
        derived_artifact_sha256: capacityBinding.derived_artifact_sha256,
        source_set_sha256: capacityBinding.source_set_sha256,
        sku,
        product_url: requestedProductUrl,
        occurrences: normalizedOccurrences,
        occurrence_set_sha256: auditedCanonicalDocumentSha256(normalizedOccurrences),
        status: "terminal-rejected",
        reason: "no-detail-strict-derived-target-match",
        selected_target_id: null,
        selected_source_url: null,
        observation_sha256: null,
      }));
      }
      continue;
    }
    accepted.push(selected);
    if (onObservation) await onObservation(selected);
    if (onCheckpoint) {
      const normalizedOccurrences = normalizedCapacityDetailOccurrences(occurrences, sku);
      await onCheckpoint(Object.freeze({
      contract: AUDITED_DERIVED_CAPACITY_DETAIL_CHECKPOINT_CONTRACT,
      evidence_scope: AUDITED_DERIVED_CAPACITY_SCOPE,
      stage: "capacity-product-detail",
      terminal: true,
      run_id: capacityBinding.run_id,
      campaign_epoch: capacityBinding.campaign_epoch,
      activated_at: capacityBinding.activated_at,
      observed_at: timestamp(now(), "capacity accepted detail checkpoint observed_at"),
      derived_artifact_sha256: capacityBinding.derived_artifact_sha256,
      source_set_sha256: capacityBinding.source_set_sha256,
      sku,
      product_url: selected.product_url,
      occurrences: normalizedOccurrences,
      occurrence_set_sha256: auditedCanonicalDocumentSha256(normalizedOccurrences),
      status: "accepted",
      selected_target_id: selected.target_id,
      selected_source_url: selected.source_url,
      observation_sha256: auditedCanonicalDocumentSha256(selected),
      reason: null,
    }));
    }
  }
  return Object.freeze({
    scanned_source_count: checkedArtifact.active_source_bindings.length,
    discovered_unique_skus: occurrencesBySku.size,
    accepted_observations: Object.freeze(accepted),
    rejected_observations: Object.freeze(rejected),
    stage1_rejected_links: Object.freeze(stageOneRejected),
  });
}

function capacityObservationIdentity(row, artifact, binding, now) {
  const reject = (reason) => ({ eligible: false, reason, target: null, observation: null });
  if (!row || row.contract !== AUDITED_DERIVED_CAPACITY_OBSERVATION_CONTRACT
    || row.evidence_scope !== AUDITED_DERIVED_CAPACITY_SCOPE || row.status !== "observed") {
    return reject("capacity-observation-contract-invalid");
  }
  if (row.favorite_id !== undefined || row.favorited_at !== undefined
    || row.published_at !== undefined || row.submitted_at !== undefined) {
    return reject("capacity-observation-mutation-identity-forbidden");
  }
  if (binding?.contract !== AUDITED_DERIVED_CAPACITY_BINDING_CONTRACT
    || String(row.run_id || "") !== binding.run_id
    || Number(row.campaign_epoch) !== binding.campaign_epoch
    || String(row.derived_artifact_sha256 || "") !== binding.derived_artifact_sha256
    || String(row.source_set_sha256 || "") !== binding.source_set_sha256
    || String(row.activated_at || "") !== binding.activated_at) {
    return reject("capacity-observation-campaign-binding-mismatch");
  }
  const sourceUrl = exactAuditedSourceUrl(row.source_url);
  const finalSourceUrl = exactAuditedSourceUrl(row.final_source_url);
  const bindingRow = artifact.active_source_bindings.find((entry) => entry.source_url === sourceUrl);
  if (!bindingRow || finalSourceUrl !== sourceUrl) return reject("capacity-observation-source-mismatch");
  const target = artifact.targets.find((entry) => entry.id === bindingRow.target_id);
  if (!target || String(row.target_id || "") !== target.id
    || auditedSellerRoot(row.seller_url) !== target.seller_url
    || String(row.category_key || "") !== target.category_key
    || String(row.accessory_role || "") !== target.accessory_role) {
    return reject("capacity-observation-target-binding-mismatch");
  }
  const rawObservedCurrentSeller = String(row.observed_current_seller_url || "").trim();
  const observedCurrentSellerUrl = rawObservedCurrentSeller
    ? auditedSellerRoot(rawObservedCurrentSeller)
    : null;
  if (rawObservedCurrentSeller && !observedCurrentSellerUrl) {
    return reject("capacity-observation-current-seller-diagnostic-invalid");
  }
  let observedAt;
  try {
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
    observedAt = timestamp(row.observed_at, "capacity observation observed_at", {
      notBefore: Date.parse(binding.activated_at),
      now: nowMs,
    });
  } catch { return reject("capacity-observation-time-invalid"); }
  const sku = String(row.sku || "").trim();
  if (!/^\d+$/u.test(sku) || /^0+$/u.test(sku)) return reject("capacity-observation-sku-invalid");
  let productUrl;
  try { productUrl = normalizeProductUrl(row.product_url, sku, "capacity observation product_url"); }
  catch { return reject("capacity-observation-product-url-invalid"); }
  let finalProductUrl;
  try { finalProductUrl = normalizeProductUrl(row.final_product_url, sku, "capacity observation final_product_url"); }
  catch { return reject("capacity-observation-final-product-url-invalid"); }
  if (finalProductUrl !== productUrl) return reject("capacity-observation-product-redirect-mismatch");
  if (Number(row.live_item_count) !== 1
    || row.live_is_bundle !== false
    || row.live_is_set !== false
    || row.live_compatibility_scope !== "generic") {
    return reject("capacity-observation-single-generic-item-required");
  }
  if (String(row.live_category_key || "") !== target.category_key) {
    return reject("capacity-observation-live-category-mismatch");
  }
  let liveStructuredEvidence;
  try {
    liveStructuredEvidence = normalizeStructuredDetailEvidence(
      row.live_structured_evidence,
      target.category_key,
      "capacity observation live_structured_evidence",
    );
  } catch { return reject("capacity-observation-structured-detail-evidence-invalid"); }
  if (!hasCompleteSafeBrandEvidence(row)) {
    return reject("capacity-observation-live-brand-evidence-invalid-or-risk");
  }
  let liveRoleAttributes;
  try {
    liveRoleAttributes = normalizeRoleAttributes(
      row.live_role_attributes,
      "capacity observation live_role_attributes",
    );
  } catch { return reject("capacity-observation-role-attributes-invalid"); }
  if (JSON.stringify(liveRoleAttributes) !== JSON.stringify(target.required_role_attributes)) {
    return reject("capacity-observation-role-attributes-mismatch");
  }
  let liveRoleAttributeEvidence;
  try {
    liveRoleAttributeEvidence = normalizeRoleAttributeEvidence(
      row.live_role_attribute_evidence,
      liveRoleAttributes,
      "capacity observation live_role_attribute_evidence",
    );
  } catch { return reject("capacity-observation-role-attribute-evidence-invalid"); }
  let livePriceEvidence;
  try {
    livePriceEvidence = normalizeLivePriceEvidence(row, "capacity observation", {
      activatedAt: binding.activated_at,
      observedAt,
      priceBand: target.seller_price_band_rub,
    });
  }
  catch { return reject("capacity-observation-live-price-evidence-invalid"); }
  return {
    eligible: true,
    reason: null,
    target,
    observation: Object.freeze({
      contract: AUDITED_DERIVED_CAPACITY_OBSERVATION_CONTRACT,
      evidence_scope: AUDITED_DERIVED_CAPACITY_SCOPE,
      status: "observed",
      run_id: binding.run_id,
      campaign_epoch: binding.campaign_epoch,
      activated_at: binding.activated_at,
      observed_at: observedAt,
      derived_artifact_sha256: binding.derived_artifact_sha256,
      source_set_sha256: binding.source_set_sha256,
      source_url: sourceUrl,
      final_source_url: sourceUrl,
      target_id: target.id,
      seller_url: target.seller_url,
      observed_current_seller_url: observedCurrentSellerUrl,
      category_key: target.category_key,
      accessory_role: target.accessory_role,
      sku,
      product_url: productUrl,
      final_product_url: finalProductUrl,
      live_title: String(row.live_title || "").trim(),
      live_brand: typeof row.live_brand === "string" ? row.live_brand.trim() : row.live_brand,
      live_brand_extraction_complete: row.live_brand_extraction_complete,
      live_brand_evidence_source: row.live_brand_evidence_source,
      live_category_key: target.category_key,
      live_item_count: 1,
      live_is_bundle: false,
      live_is_set: false,
      live_compatibility_scope: "generic",
      live_role_attributes: liveRoleAttributes,
      live_role_attribute_evidence: liveRoleAttributeEvidence,
      live_structured_evidence: liveStructuredEvidence,
      ...livePriceEvidence,
    }),
  };
}

export function attestAuditedDerivedCapacity({
  derivedArtifact,
  derivedArtifactSha256,
  capacityBinding,
  observations = [],
  generatedAt = new Date(),
  minimum = AUDITED_DERIVED_CAPACITY_MINIMUM,
} = {}) {
  const artifact = validateAuditedDerivedSellerArtifact(derivedArtifact, { now: generatedAt });
  const artifactSha = sha256Value(derivedArtifactSha256, "derived artifact SHA256");
  if (auditedDerivedArtifactSha256(artifact) !== artifactSha) {
    fail("capacity derived artifact semantic SHA256 mismatch");
  }
  if (capacityBinding?.derived_artifact_sha256 !== artifactSha
    || capacityBinding?.source_set_sha256 !== artifact.source_set_sha256) {
    fail("capacity binding does not match the derived artifact");
  }
  const threshold = positiveInteger(minimum, "capacity minimum");
  if (threshold !== AUDITED_DERIVED_CAPACITY_MINIMUM) fail("capacity minimum must remain 360");
  const valid = [];
  for (const row of observations) {
    const result = capacityObservationIdentity(row, artifact, capacityBinding, generatedAt);
    if (!result.eligible) fail(`capacity observation identity rejected: ${result.reason}`);
    valid.push({ row: result.observation, target: result.target });
  }
  const bySku = new Map();
  for (const entry of valid) {
    const previous = bySku.get(entry.row.sku);
    if (previous && (previous.row.product_url !== entry.row.product_url
      || previous.row.target_id !== entry.row.target_id
      || previous.row.seller_url !== entry.row.seller_url
      || previous.row.live_title !== entry.row.live_title
      || previous.row.live_brand !== entry.row.live_brand
      || JSON.stringify(previous.row.live_role_attributes) !== JSON.stringify(entry.row.live_role_attributes))) {
      fail(`capacity observation SKU ${entry.row.sku} has conflicting product, target, seller, title, brand, or role identity`);
    }
    if (!previous) bySku.set(entry.row.sku, entry);
  }
  const rejectionCounts = {};
  let guardedTitleCount = 0;
  const brandSafeBySeller = new Map();
  for (const entry of bySku.values()) {
    const titleEligibility = targetTitleEligibility(entry.row.live_title, entry.target, artifact.global_guard);
    if (!titleEligibility.eligible) {
      rejectionCounts[titleEligibility.reason] = (rejectionCounts[titleEligibility.reason] || 0) + 1;
      continue;
    }
    guardedTitleCount += 1;
    if (!hasCompleteSafeBrandEvidence(entry.row)) {
      rejectionCounts["live-brand-risk"] = (rejectionCounts["live-brand-risk"] || 0) + 1;
      continue;
    }
    const rows = brandSafeBySeller.get(entry.row.seller_url) || [];
    rows.push(entry.row);
    brandSafeBySeller.set(entry.row.seller_url, rows);
  }
  const accepted = [];
  let uncappedBrandSafeCount = 0;
  const sellerContributions = {};
  for (const [sellerUrl, rows] of [...brandSafeBySeller.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    rows.sort((left, right) => left.sku.localeCompare(right.sku));
    uncappedBrandSafeCount += rows.length;
    const contribution = rows.slice(0, AUDITED_DERIVED_SELLER_CONTRIBUTION_CAP);
    sellerContributions[sellerUrl] = contribution.length;
    accepted.push(...contribution);
  }
  const brandSafeCount = accepted.length;
  const currentSellerCount = Object.values(sellerContributions).filter((count) => count > 0).length;
  const generatedAtIso = timestamp(generatedAt, "capacity attestation generated_at");
  const generatedAtMs = Date.parse(generatedAtIso);
  const currentPriceObservationCount = accepted.filter((row) => (
    generatedAtMs - Date.parse(row.observed_at) <= AUDITED_CURRENT_PRICE_MAX_AGE_MS
  )).length;
  const observationSetSha256 = auditedCanonicalDocumentSha256(
    [...bySku.values()].map((entry) => entry.row).sort((left, right) => left.sku.localeCompare(right.sku)),
  );
  const attestation = Object.freeze({
    contract: AUDITED_DERIVED_CAPACITY_ATTESTATION_CONTRACT,
    schema_version: 1,
    deployment_phase: "validation_only",
    automatic_publish_eligible: false,
    price_evidence_publish_eligible: false,
    next_stage_requires_live_price_refetch: true,
    generated_at: generatedAtIso,
    derived_artifact_sha256: artifactSha,
    source_set_sha256: artifact.source_set_sha256,
    capacity_run_id: capacityBinding.run_id,
    capacity_campaign_epoch: capacityBinding.campaign_epoch,
    capacity_activated_at: capacityBinding.activated_at,
    observation_set_sha256: observationSetSha256,
    raw_bound_unique_skus: bySku.size,
    guarded_title_unique_skus: guardedTitleCount,
    uncapped_brand_safe_unique_skus: uncappedBrandSafeCount,
    brand_safe_unique_skus: brandSafeCount,
    current_price_observation_count: currentPriceObservationCount,
    identity_capacity_only_observation_count: brandSafeCount - currentPriceObservationCount,
    current_price_max_age_ms: AUDITED_CURRENT_PRICE_MAX_AGE_MS,
    minimum_brand_safe_unique_skus: threshold,
    current_sellers: currentSellerCount,
    minimum_current_sellers: AUDITED_DERIVED_MINIMUM_CURRENT_SELLERS,
    seller_contribution_cap: AUDITED_DERIVED_SELLER_CONTRIBUTION_CAP,
    seller_contributions: Object.freeze(sellerContributions),
    historical_proxy_counts_for_gate: false,
    ready: brandSafeCount >= threshold
      && currentSellerCount >= AUDITED_DERIVED_MINIMUM_CURRENT_SELLERS,
    rejection_counts: Object.freeze(rejectionCounts),
  });
  return Object.freeze({
    attestation,
    attestation_sha256: auditedCanonicalDocumentSha256(attestation),
    accepted_observations: Object.freeze(accepted),
  });
}

export function promoteAuditedDerivedSellerPortfolio({
  draftArtifact,
  draftArtifactSha256,
  capacityAttestation,
  capacityAttestationSha256,
  generatedAt = new Date(),
} = {}) {
  const draft = validateAuditedDerivedSellerArtifact(draftArtifact, { now: generatedAt });
  const draftSha = sha256Value(draftArtifactSha256, "draft artifact SHA256");
  if (auditedDerivedArtifactSha256(draft) !== draftSha) {
    fail("draft artifact semantic SHA256 mismatch");
  }
  const attestationSha = sha256Value(capacityAttestationSha256, "capacity attestation SHA256");
  if (auditedCanonicalDocumentSha256(capacityAttestation) !== attestationSha) {
    fail("capacity attestation SHA256 does not match its document");
  }
  if (capacityAttestation?.contract !== AUDITED_DERIVED_CAPACITY_ATTESTATION_CONTRACT
    || capacityAttestation.derived_artifact_sha256 !== draftSha
    || capacityAttestation.source_set_sha256 !== draft.source_set_sha256
    || capacityAttestation.price_evidence_publish_eligible !== false
    || capacityAttestation.next_stage_requires_live_price_refetch !== true
    || Number(capacityAttestation.current_price_max_age_ms) !== AUDITED_CURRENT_PRICE_MAX_AGE_MS
    || capacityAttestation.historical_proxy_counts_for_gate !== false
    || Number(capacityAttestation.minimum_brand_safe_unique_skus) !== AUDITED_DERIVED_CAPACITY_MINIMUM
    || Number(capacityAttestation.brand_safe_unique_skus) < AUDITED_DERIVED_CAPACITY_MINIMUM
    || !Number.isInteger(Number(capacityAttestation.current_price_observation_count))
    || Number(capacityAttestation.current_price_observation_count) < 0
    || !Number.isInteger(Number(capacityAttestation.identity_capacity_only_observation_count))
    || Number(capacityAttestation.identity_capacity_only_observation_count) < 0
    || Number(capacityAttestation.current_price_observation_count)
      + Number(capacityAttestation.identity_capacity_only_observation_count)
      !== Number(capacityAttestation.brand_safe_unique_skus)
    || Number(capacityAttestation.current_sellers) < AUDITED_DERIVED_MINIMUM_CURRENT_SELLERS
    || Number(capacityAttestation.minimum_current_sellers) !== AUDITED_DERIVED_MINIMUM_CURRENT_SELLERS
    || Number(capacityAttestation.seller_contribution_cap) !== AUDITED_DERIVED_SELLER_CONTRIBUTION_CAP
    || Object.values(capacityAttestation.seller_contributions || {})
      .some((count) => Number(count) > AUDITED_DERIVED_SELLER_CONTRIBUTION_CAP)
    || capacityAttestation.ready !== true) {
    fail("capacity attestation is not a ready, live brand-safe attestation for this draft");
  }
  const promoted = validateAuditedDerivedSellerArtifact({
    ...draft,
    generated_at: timestamp(generatedAt, "promoted artifact generated_at"),
    provenance: {
      ...draft.provenance,
      capacity_draft_artifact_sha256: draftSha,
      capacity_attestation_sha256: attestationSha,
      capacity_observation_set_sha256: capacityAttestation.observation_set_sha256,
    },
    readiness: {
      status: "ready_for_validation_discovery",
      minimum_brand_safe_unique_skus: AUDITED_DERIVED_CAPACITY_MINIMUM,
      brand_safe_unique_skus: Number(capacityAttestation.brand_safe_unique_skus),
      historical_proxy_counts_for_gate: false,
      capacity_forecast_only: false,
      minimum_current_sellers: AUDITED_DERIVED_MINIMUM_CURRENT_SELLERS,
      current_sellers: Number(capacityAttestation.current_sellers),
      seller_contribution_cap: AUDITED_DERIVED_SELLER_CONTRIBUTION_CAP,
      price_evidence_publish_eligible: false,
      next_stage_requires_live_price_refetch: true,
    },
  }, { now: generatedAt });
  return Object.freeze({
    artifact: promoted,
    artifact_sha256: auditedDerivedArtifactSha256(promoted),
  });
}
