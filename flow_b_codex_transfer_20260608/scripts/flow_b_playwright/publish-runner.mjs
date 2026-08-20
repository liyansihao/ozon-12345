import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

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
import {
  IMAGE_PRIMARY_EXACT_THUMBNAIL_SELECTION_METHOD,
  IMAGE_PRIMARY_MATCH_BASIS,
  assessImagePrimaryCandidate,
  canonicalAlibabaImageAssetUrl,
  normalizeSupplySpecValue,
  normalizeTargetVariant,
} from "./1688-supply-verifier.mjs";
import { AdaptiveConcurrency, isFatalBrowserError, loadCandidateFacts, loadPreflightPureSkus, mergeCandidateFacts } from "./continuous-runtime.mjs";
import {
  hasReliableSameItemCostEvidence,
  sameItemCostEvidence,
} from "./cost-evidence.mjs";
import { isOzonSoftBlockError } from "./ozon-access-controller.mjs";
import { submissionGatePolicy } from "./live-acceptance-gates.mjs";
import {
  productWeightGrams,
  selectShippingRoute,
} from "./shipping-route.mjs";
import { createProfitFilesReader, prioritizeProfitRows } from "./profit-priority.mjs";
import { assessProfitSafety, assessProfitSafetyGate } from "./profit-safety.mjs";
import { dailyWindowState } from "../daily-window.mjs";
import {
  hasTerminalModerationDecline,
  hasTerminalStockActivationRejection,
  importFailureReason,
  isTerminalSubmittedFailure,
} from "./submission-evidence.mjs";

const ECONOMY_SENTINEL = Object.freeze({
  title: "CEL Economy",
  price_list: { logistics_name: "CEL", logistics_speed: "economy" },
});
const observedPublishFeedbackCompositeCache = new Map();
const MIN_URGENT_ONLINE_SYNC_INTERVAL_MS = 180_000;
const MAX_ONLINE_SYNC_SERVER_BACKOFF_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECONCILIATION_MAX_ATTEMPTS = 240;
const DEFAULT_RECONCILIATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DIRECT_RECONCILIATION_FINAL_OUTCOMES = new Set([
  "online",
  "stock_updated",
  "rejected",
  "indeterminate",
]);
let currentStoreWriteSequence = 0;
const FATAL_RUNNER_STATE_CODES = new Set([
  "SUBMISSION_ACCEPTANCE_PERSIST_FAILED",
  "SUBMISSION_GATE_UNAVAILABLE",
  "SUBMISSION_RESET_PERSIST_FAILED",
  "SUPPLY_GATE_AUTH_REQUIRED",
  "VALIDATION_COMMISSION_SEED_CATEGORY_MISMATCH",
]);
const STRICT_1688_MATCH_TYPES = new Set(["strong_single", "corroborated_multi"]);
const SUPPLY_EVIDENCE_CONTRACT = "1688-orderable-v1";
const PROFIT_RECHECK_CONTEXT_CONTRACT = "profit-recheck-v1";
const PROFIT_RECHECK_CONTEXT_TTL_MS = 60 * 60 * 1000;
const PROFIT_QUOTE_PRICE_EPSILON = 0.000001;
const PROFIT_QUOTE_RATE_EPSILON = 0.1;
const SUPPLY_GATE_MAX_SEARCH_ROUNDS = 3;
const DEFAULT_SEMANTIC_MISS_QUEUE_RETIRE_MS = 24 * 60 * 60 * 1000;
const CURRENT_1688_MATCH_POLICY_VERSION = "image-text-soft-v2";
const DETERMINISTIC_SUPPLY_EXIT_POLICY_VERSION = "deterministic-supply-exit-v1";
const SEMANTIC_MISS_QUEUE_RETIRE_POLICY_VERSION = "semantic-miss-queue-retire-v1";
const SUPPLY_GATE_RESEARCHABLE_FAILURE_CODES = new Set([
  "image_identity_conflict",
  "moq_above_one",
  "offer_offline",
  "out_of_stock",
  "spec_mismatch",
  "variant_unavailable",
  "variant_unbound",
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

const CURRENT_POLICY_SEMANTIC_MISS_REASONS = new Set([
  "no explicit title/model/category semantic same-item matches",
]);
const TRANSIENT_SUPPLY_FAILURE_CODES = new Set([
  "authentication_required",
  "captcha",
  "http_transient",
  "navigation_error",
  "timeout",
  "unexpected_final_url",
]);
const UNRESOLVED_IMAGE_FAILURE_CODES = new Set([
  "image_evidence_invalid",
  "image_primary_bundle_unpriced",
]);

function supplyFailurePayloads(result, cost) {
  return [result, cost, result?.replacement_cost]
    .filter((value) => value && typeof value === "object" && !Array.isArray(value));
}

function supplyFailureRows(result) {
  return Array.isArray(result?.candidate_failures) ? result.candidate_failures : [];
}

function supplyFailureCode(value) {
  return String(compactText(value?.reason_code ?? value?.code ?? value?.error?.code) || "")
    .toLocaleLowerCase("und");
}

function supplyFailureText(value) {
  return compactText([
    value?.reason,
    value?.error?.message,
    value?.message,
  ].filter(Boolean).join(" "));
}

function unresolvedSupplyFailure({ reason, result, cost }) {
  const payloads = supplyFailurePayloads(result, cost);
  const rows = supplyFailureRows(result);
  if ([...payloads, ...rows].some((value) => (
    value?.deferred === true
    || value?.terminal === false
    || value?.transient === true
    || value?.retryable === true
    || value?.transport_error === true
    || value?.global_gate_closed === true
    || value?.alert_required === true
  ))) return "transient-or-retryable";
  const codes = [...payloads, ...rows].map(supplyFailureCode).filter(Boolean);
  if (codes.some((code) => TRANSIENT_SUPPLY_FAILURE_CODES.has(code))) return "transport-auth-captcha-timeout";
  if (codes.some((code) => UNRESOLVED_IMAGE_FAILURE_CODES.has(code))) return "image-evidence-unresolved";
  if (codes.some((code) => /(?:timeout|captcha|auth|login|transport|network|socket|econn|ssl|image.*(?:download|fetch)|(?:download|fetch).*image)/iu.test(code))) {
    return "transport-auth-captcha-timeout-or-image";
  }
  const text = [reason, ...payloads.map(supplyFailureText), ...rows.map(supplyFailureText)].join(" ");
  if (/(?:captcha|验证码|authentication|login required|session expired|登录|会话失效|timed?\s*out|timeout|超时|network|socket|econn|ssl|transport|image\s+(?:download|fetch)|cover image (?:download|url)|图片(?:下载|获取))/iu.test(text)) {
    return "transport-auth-captcha-timeout-or-image";
  }
  return null;
}

function currentPolicyCostSemanticMiss(value) {
  return value
    && String(value.match_policy_version || "").trim() === CURRENT_1688_MATCH_POLICY_VERSION
    && value.search_executed_live === true
    && Number(value.process_code) === 2
    && value.transport_error !== true
    && CURRENT_POLICY_SEMANTIC_MISS_REASONS.has(
      String(compactText(value.reason) || "").toLocaleLowerCase("und"),
    );
}

function hardSupplyIdentityFailure(value) {
  const code = supplyFailureCode(value);
  if (!["image_identity_conflict", "spec_mismatch", "supporting_model_conflict"].includes(code)) return false;
  return /(?:core_accessory_conflict|declared_(?:brand|model)_missing|branded_core_digital_(?:clone_cue|brand_(?:missing|conflict)|model_(?:missing|conflict)|selected_model_(?:missing|conflict))|explicit_(?:supporting_)?(?:brand|model)_conflict|wrong_product_type)/iu.test(supplyFailureText(value));
}

function coveredFinalSupplyFailures(result, candidates) {
  const candidateIds = [...new Set((Array.isArray(candidates) ? candidates : [])
    .map((candidate) => compactText(candidate?.offer_id))
    .filter(Boolean))];
  const rows = supplyFailureRows(result);
  if (!candidateIds.length || !rows.length) return null;
  const finalRows = candidateIds.map((offerId) => rows
    .filter((failure) => compactText(failure?.offer_id) === offerId)
    .at(-1));
  if (finalRows.some((failure) => !failure)) return null;
  if (finalRows.some((failure) => (
    failure?.deterministic !== true
    || failure?.transient === true
    || failure?.retryable === true
  ))) return null;
  return finalRows;
}

function completedHardIdentitySupplySearch(result, candidates) {
  if (result?.supply_policy_completed !== true
    || String(result?.supply_policy_version || "") !== DETERMINISTIC_SUPPLY_EXIT_POLICY_VERSION
    || result?.alternative_search_completion_basis !== "maximum-alternative-search-rounds-exhausted"
    || Number(result?.search_round) !== SUPPLY_GATE_MAX_SEARCH_ROUNDS
    || String(result?.match_policy_version || "").trim() !== CURRENT_1688_MATCH_POLICY_VERSION
    || result?.search_executed_live !== true
    || result?.deterministic !== true
    || result?.transient === true
    || result?.retryable === true) return false;
  const finalRows = coveredFinalSupplyFailures(result, candidates);
  if (!finalRows?.length || !finalRows.every(hardSupplyIdentityFailure)) return false;
  const history = Array.isArray(result?.search_history) ? result.search_history : [];
  if (history.length !== SUPPLY_GATE_MAX_SEARCH_ROUNDS - 1) return false;
  return history.every((record, index) => {
    if (Number(record?.failed_search_round) !== index + 1) return false;
    if (String(record?.match_policy_version || "").trim() !== CURRENT_1688_MATCH_POLICY_VERSION
      || record?.search_executed_live !== true) return false;
    const offerIds = [...new Set((Array.isArray(record?.failed_offer_ids)
      ? record.failed_offer_ids
      : []).map(compactText).filter(Boolean))];
    const rows = Array.isArray(record?.candidate_failures) ? record.candidate_failures : [];
    if (!offerIds.length || !rows.length) return false;
    const covered = offerIds.map((offerId) => rows
      .filter((failure) => compactText(failure?.offer_id) === offerId)
      .at(-1));
    return covered.every((failure) => failure
      && failure.deterministic === true
      && failure.transient !== true
      && failure.retryable !== true
      && hardSupplyIdentityFailure(failure));
  });
}

/**
 * A deterministic page result is not automatically a permanent SKU result.
 * This decision stays closed until the current cost/search policy explicitly
 * proves that no alternative remains, while transport and image uncertainty
 * always continue through the deferred path.
 */
export function deterministicSupplyQueueExitDecision({
  reason,
  result = null,
  cost = null,
  candidates = [],
} = {}) {
  const base = {
    eligible: false,
    policy_version: DETERMINISTIC_SUPPLY_EXIT_POLICY_VERSION,
    basis: null,
    disposition: null,
  };
  const unresolved = unresolvedSupplyFailure({ reason, result, cost });
  if (unresolved) return { ...base, audit_reason: unresolved };

  const payloads = supplyFailurePayloads(result, cost);
  const semanticMiss = payloads.find(currentPolicyCostSemanticMiss);
  if (semanticMiss) {
    return {
      ...base,
      eligible: true,
      basis: "current-policy-code2-semantic-miss",
      disposition: "queue-retire",
      terminal: false,
      policy_version: SEMANTIC_MISS_QUEUE_RETIRE_POLICY_VERSION,
      match_policy_version: CURRENT_1688_MATCH_POLICY_VERSION,
    };
  }
  if (completedHardIdentitySupplySearch(result, candidates)) {
    return {
      ...base,
      eligible: true,
      basis: "exhausted-hard-identity-conflicts",
      disposition: "terminal-skip",
      terminal: true,
    };
  }
  return { ...base, audit_reason: "terminal-identity-proof-incomplete" };
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

function compactText(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/\s+/gu, " ").trim();
  return normalized || null;
}

function offerUrl(offerId) {
  const normalized = compactText(offerId);
  return normalized ? `https://detail.1688.com/offer/${encodeURIComponent(normalized)}.html` : null;
}

export function strict1688SupplyCandidates(cost = {}, { maximum = 3 } = {}) {
  const matchType = compactText(cost?.balanced_match_type);
  if (
    cost?.ok !== true
    || cost?.returned_evidence_verified !== true
    || cost?.balanced_match !== true
    || !STRICT_1688_MATCH_TYPES.has(matchType)
    || cost?.match_evidence_contract !== "1688-returned-same-item-v3"
  ) return [];

  const supporting = Array.isArray(cost?.balanced_supporting_offer_ids)
    ? cost.balanced_supporting_offer_ids
    : [];
  const supportingEvidence = new Map((Array.isArray(cost?.balanced_supporting_offer_evidence)
    ? cost.balanced_supporting_offer_evidence
    : []).flatMap((row) => {
    const offerId = compactText(row?.offer_id);
    return offerId ? [[offerId, row]] : [];
  }));
  // Only the offer ids signed as actual supporters of the strict match may
  // proceed to a detail-page purchase check. A price-cluster member is not,
  // by itself, same-item evidence.
  const boundIds = supporting;
  if (!boundIds.length) return [];
  const selected = compactText(cost?.selected_offer_id);
  const ordered = [
    ...(selected && boundIds.some((value) => compactText(value) === selected) ? [selected] : []),
    ...boundIds,
  ];
  const seen = new Set();
  return ordered.flatMap((value) => {
    const offerId = compactText(value);
    if (!offerId || !/^\d+$/u.test(offerId) || seen.has(offerId)) return [];
    seen.add(offerId);
    const candidate = {
      platform: "1688",
      offer_id: offerId,
      offer_url: offerUrl(offerId),
      match_type: matchType,
      match_evidence_key: compactText(cost?.match_evidence_key),
    };
    const signedImageRow = supportingEvidence.get(offerId);
    if (signedImageRow) {
      candidate.image_match_evidence = {
        source_contract: cost.match_evidence_contract,
        ...signedImageRow,
        corroborating_offer_ids: boundIds.map(compactText).filter(Boolean),
      };
      const assessment = assessImagePrimaryCandidate(candidate);
      if (assessment.ok) {
        candidate.match_basis = IMAGE_PRIMARY_MATCH_BASIS;
        candidate.image_match_evidence = assessment.evidence;
      } else {
        delete candidate.image_match_evidence;
      }
    }
    return [candidate];
  }).slice(0, Math.max(1, Number(maximum) || 3));
}

const SUPPLY_ATTRIBUTE_ALIASES = Object.freeze({
  model: /^(?:model|model_name|модель|型号|款号)$/iu,
  article: /^(?:article|articul|артикул|货号|商品编号)$/iu,
  color: /^(?:colou?r|цвет|颜色|色号)$/iu,
  size: /^(?:size|размер|尺寸|尺码|规格)$/iu,
  capacity: /^(?:capacity|volume|объ[её]м|емкость|容量|容积)$/iu,
  voltage_v: /^(?:voltage|voltage_v|напряжение|电压)$/iu,
  current_a: /^(?:current|current_a|amperage|ток|сила_тока|电流)$/iu,
  power_w: /^(?:power|power_w|wattage|мощность|功率)$/iu,
  cct_k: /^(?:cct|cct_k|colou?r_?temperature|цветовая_?температура|температура_?света|色温)$/iu,
  set_quantity: /^(?:set_?quantity|set_?count|pack_?count|package_?quantity|quantity|count|количество|комплект|套装数量|件数|数量)$/iu,
  head_count: /^(?:head_?count|heads|lamp_?heads?|spot_?count|количество_?плафонов|плафонов|灯头数|头数)$/iu,
  shape: /^(?:shape|form|форма|形状|外形)$/iu,
  interface: /^(?:interface|connector|port|интерфейс|разъ[её]м|接口)$/iu,
});

function canonicalSupplyAttributeName(value) {
  const normalized = compactText(value)?.toLowerCase().replace(/[\s-]+/gu, "_");
  if (!normalized) return null;
  return Object.entries(SUPPLY_ATTRIBUTE_ALIASES)
    .find(([, pattern]) => pattern.test(normalized))?.[0] || null;
}

function collectSupplyAttributes(source, attributes, sourceName) {
  if (!source || typeof source !== "object") return;
  for (const [name, value] of Object.entries(source)) {
    const canonical = canonicalSupplyAttributeName(name);
    const normalized = compactText(value);
    if (canonical && normalized && !attributes[canonical]) {
      attributes[canonical] = normalized;
      attributes._sources[canonical] = sourceName;
    }
  }
  const rows = Array.isArray(source.attributes)
    ? source.attributes
    : Array.isArray(source.variant_attributes)
      ? source.variant_attributes
      : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const canonical = canonicalSupplyAttributeName(row.name ?? row.label ?? row.key ?? row.attribute_name);
    const normalized = compactText(row.value ?? row.values?.[0] ?? row.text ?? row.attribute_value);
    if (canonical && normalized && !attributes[canonical]) {
      attributes[canonical] = normalized;
      attributes._sources[canonical] = sourceName;
    }
  }
}

const OZON_TITLE_FIELDS = Object.freeze([
  "title",
  "product_title",
  "productTitle",
  "product_name",
  "productName",
]);

const OZON_ROSE_GOLD_COLOR_PATTERN = /玫瑰金|(?:^|[^\p{L}\p{N}])rose[\s-]*gold(?=$|[^\p{L}\p{N}])|розов\p{L}*[\s-]+золот\p{L}*/iu;

const OZON_TITLE_COLOR_PATTERNS = Object.freeze([
  ["black", /(?:^|[^\p{L}\p{N}])(?:black|\u0447\u0435\u0440\u043d(?:\u044b\u0439|\u0430\u044f|\u043e\u0435|\u044b\u0435|\u043e\u0433\u043e|\u0443\u044e|\u043e\u043c)|\u0447\u0451\u0440\u043d(?:\u044b\u0439|\u0430\u044f|\u043e\u0435|\u044b\u0435|\u043e\u0433\u043e|\u0443\u044e|\u043e\u043c)|\u9ed1\u8272)(?=$|[^\p{L}\p{N}])/iu],
  ["white", /(?:^|[^\p{L}\p{N}])(?:white|\u0431\u0435\u043b(?:\u044b\u0439|\u0430\u044f|\u043e\u0435|\u044b\u0435|\u043e\u0433\u043e|\u0443\u044e|\u043e\u043c)|\u767d\u8272)(?=$|[^\p{L}\p{N}])/iu],
  ["gray", /(?:^|[^\p{L}\p{N}])(?:gr[ae]y|\u0441\u0435\u0440(?:\u044b\u0439|\u0430\u044f|\u043e\u0435|\u044b\u0435|\u043e\u0433\u043e|\u0443\u044e|\u043e\u043c)|\u7070\u8272)(?=$|[^\p{L}\p{N}])/iu],
  ["red", /(?:^|[^\p{L}\p{N}])(?:red|\u043a\u0440\u0430\u0441\u043d(?:\u044b\u0439|\u0430\u044f|\u043e\u0435|\u044b\u0435|\u043e\u0433\u043e|\u0443\u044e|\u043e\u043c)|\u7ea2\u8272)(?=$|[^\p{L}\p{N}])/iu],
  ["blue", /(?:^|[^\p{L}\p{N}])(?:blue|\u0441\u0438\u043d(?:\u0438\u0439|\u044f\u044f|\u0435\u0435|\u0438\u0435|\u0435\u0433\u043e|\u044e\u044e|\u0435\u043c)|\u84dd\u8272)(?=$|[^\p{L}\p{N}])/iu],
  ["green", /(?:^|[^\p{L}\p{N}])(?:green|\u0437\u0435\u043b(?:\u0435|\u0451)\u043d(?:\u044b\u0439|\u0430\u044f|\u043e\u0435|\u044b\u0435|\u043e\u0433\u043e|\u0443\u044e|\u043e\u043c)|\u0441\u0430\u043b\u0430\u0442\u043d(?:\u044b\u0439|\u0430\u044f|\u043e\u0435|\u044b\u0435|\u043e\u0433\u043e|\u0443\u044e|\u043e\u043c)|\u8367\u5149\u7eff|\u7eff\u8272)(?=$|[^\p{L}\p{N}])/iu],
  ["yellow", /(?:^|[^\p{L}\p{N}])(?:yellow|\u0436(?:\u0435|\u0451)\u043b\u0442(?:\u044b\u0439|\u0430\u044f|\u043e\u0435|\u044b\u0435|\u043e\u0433\u043e|\u0443\u044e|\u043e\u043c)|\u9ec4\u8272)(?=$|[^\p{L}\p{N}])/iu],
  ["pink", /(?:^|[^\p{L}\p{N}])(?:pink|\u0440\u043e\u0437\u043e\u0432(?:\u044b\u0439|\u0430\u044f|\u043e\u0435|\u044b\u0435|\u043e\u0433\u043e|\u0443\u044e|\u043e\u043c)|\u7c89\u8272)(?=$|[^\p{L}\p{N}])/iu],
  ["purple", /(?:^|[^\p{L}\p{N}])(?:purple|violet|\u0444\u0438\u043e\u043b\u0435\u0442\u043e\u0432(?:\u044b\u0439|\u0430\u044f|\u043e\u0435|\u044b\u0435|\u043e\u0433\u043e|\u0443\u044e|\u043e\u043c)|\u043f\u0443\u0440\u043f\u0443\u0440\u043d(?:\u044b\u0439|\u0430\u044f|\u043e\u0435|\u044b\u0435|\u043e\u0433\u043e|\u0443\u044e|\u043e\u043c)|\u7d2b\u8272)(?=$|[^\p{L}\p{N}])/iu],
  ["rose_gold", OZON_ROSE_GOLD_COLOR_PATTERN],
  ["gold", /(?:^|[^\p{L}\p{N}])(?:gold(?:en)?|\u0437\u043e\u043b\u043e\u0442(?:\u043e\u0439|\u0430\u044f|\u043e\u0435|\u044b\u0435|\u043e\u0433\u043e|\u0443\u044e|\u043e\u043c)|(?:\u9ec4\u91d1|\u91d1\u9ec4|\u91d1)\u8272)(?=$|[^\p{L}\p{N}])/iu],
]);

function titleModelCandidates(title) {
  const values = new Set();
  const source = String(title || "").normalize("NFKC").toLocaleUpperCase("und");
  const pattern = /(?:^|[^A-Z0-9])([A-Z]{1,7}[-_]?\d{2,9}[A-Z0-9-]*)(?=$|[^A-Z0-9])/gu;
  for (const match of source.matchAll(pattern)) {
    const value = String(match[1] || "").replace(/[-_]/gu, "");
    if (!value || /^(?:IP\d+|ARGB\d*|RGB\d*|PWM\d*|USB\d*|GU10|GX53)$/u.test(value)) continue;
    values.add(value.toLocaleLowerCase("und"));
  }
  return values;
}

function ozonTitleTexts(...sources) {
  const values = [];
  const seen = new Set();
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const field of OZON_TITLE_FIELDS) {
      const title = compactText(source[field]);
      if (!title || seen.has(title)) continue;
      seen.add(title);
      values.push(title);
    }
  }
  return values;
}

function positiveTitleNumber(value) {
  const parsed = Number(String(value || "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : null;
}

function titleCapacityCandidates(title) {
  const values = new Set();
  const pattern = /(?:^|[^\p{L}\p{N}])(\d+(?:[.,]\d+)?)\s*(\u043c\u043b|ml|\u6beb\u5347|\u043b\u0438\u0442\u0440(?:\u0430|\u043e\u0432)?|\u043b|l|\u5347|\u0433\u0431|gb|\u0442\u0431|tb)(?=$|[^\p{L}\p{N}])/giu;
  for (const match of String(title || "").matchAll(pattern)) {
    const amount = positiveTitleNumber(match[1]);
    if (!amount) continue;
    const unitText = String(match[2] || "").toLocaleLowerCase("und");
    const unit = /^(?:\u043c\u043b|ml|\u6beb\u5347)$/u.test(unitText)
      ? "ml"
      : /^(?:\u043b\u0438\u0442\u0440(?:\u0430|\u043e\u0432)?|\u043b|l|\u5347)$/u.test(unitText)
        ? "l"
        : /^(?:\u0433\u0431|gb)$/u.test(unitText)
          ? "gb"
          : "tb";
    values.add(normalizeSupplySpecValue(`${amount}${unit}`, "capacity"));
  }
  return values;
}

function titleNozzleSizeCandidates(title) {
  const source = String(title || "").normalize("NFKC");
  // Millimetres occur in many unrelated product dimensions. Only promote the
  // value into a procurement SKU target when the title explicitly describes a
  // nozzle/hotend or a diameter. Multiple values remain ambiguous and are not
  // bound automatically.
  if (!/(?:nozzle|hotend|сопл|хотенд|diameter|диаметр|喷嘴|喷头|热端|口径)/iu.test(source)) {
    return new Set();
  }
  const values = new Set();
  const pattern = /(?<![a-zа-яё0-9])(\d+(?:[.,]\d+)?)\s*(?:mm|мм|毫米)(?![a-zа-яё0-9])/giu;
  for (const match of source.matchAll(pattern)) {
    const amount = positiveTitleNumber(match[1]);
    if (amount) values.add(normalizeSupplySpecValue(`${amount}mm`, "size"));
  }
  return values;
}

function titleElectricalMetricCandidates(title, metric) {
  const values = new Set();
  const patterns = {
    voltage_v: /(?:(?<![a-zа-яё0-9.])|(?<=[vawв]))(\d+(?:[.,]\d+)?)\s*(?:v|в|вольт(?:а|ов)?|伏特?)(?![a-zа-яё])/giu,
    current_a: /(?:(?<![a-zа-яё0-9.])|(?<=[vawв]))(\d+(?:[.,]\d+)?)\s*(?:a|а|amps?|ампер(?:а|ов)?|安培?)(?![a-zа-яё])/giu,
    power_w: /(?:(?<![a-zа-яё0-9.])|(?<=[vawв]))(\d+(?:[.,]\d+)?)\s*(?:w|вт|watts?|ватт(?:а|ов)?|瓦)(?![a-zа-яё])/giu,
  };
  const suffixes = { voltage_v: "v", current_a: "a", power_w: "w" };
  for (const match of String(title || "").normalize("NFKC").matchAll(patterns[metric])) {
    const amount = positiveTitleNumber(match[1]);
    if (amount) values.add(normalizeSupplySpecValue(`${amount}${suffixes[metric]}`, metric));
  }
  return values;
}

function titleCctCandidates(title) {
  const values = new Set();
  const source = String(title || "").normalize("NFKC");
  if (!/(?:led|lamp|bulb|light|lighting|cct|ламп|свет|освещ|цветов\p{L}*\s+температур|照明|灯|燈|光源|色温)/iu.test(source)) {
    return values;
  }
  const pattern = /(?:(?<![\p{L}\p{N}.])|(?<=[vawk]))(\d{4})\s*(?:k|к)(?![a-zа-яё0-9])/giu;
  for (const match of source.matchAll(pattern)) {
    const amount = positiveTitleNumber(match[1]);
    if (amount) values.add(normalizeSupplySpecValue(`${amount}k`, "cct_k"));
  }
  return values;
}

function casingColorTitleText(title) {
  return String(title || "").normalize("NFKC")
    .replace(/(?:^|[^\p{L}\p{N}])(?:warm|daylight|day[ -]?light|natural|neutral|cool|cold)\s+white(?:\s+(?:light|lighting))?(?=$|[^\p{L}\p{N}])/giu, " ")
    .replace(/(?:^|[^\p{L}\p{N}])(?:т[её]пл|дневн|нейтральн|естественн|холодн)\p{L}*\s+бел\p{L}*(?:\s+свет\p{L}*)?(?=$|[^\p{L}\p{N}])/giu, " ")
    .replace(/(?:暖白|日光白|自然白|中性白|冷白)(?:光|灯光)?/gu, " ");
}

function titleSetQuantityCandidates(title) {
  const values = new Set();
  const suffixPattern = /(?:^|[^\p{L}\p{N}])(\d{1,4})\s*(?:\u0448\u0442(?:\.|\u0443\u043a(?:\u0430|\u0438|\u043e\u0432)?)?|pcs?\.?|pieces?|\u4ef6|\u5957)(?=$|[^\p{L}\p{N}])/giu;
  const prefixPattern = /(?:^|[^\p{L}\p{N}])(?:pack|set)\s*(?:of\s*)?(\d{1,4})(?=$|[^\p{L}\p{N}])/giu;
  const hyphenPattern = /(?:^|[^\p{L}\p{N}])(\d{1,4})\s*-\s*(?:pack|set)(?=$|[^\p{L}\p{N}])/giu;
  for (const pattern of [suffixPattern, prefixPattern, hyphenPattern]) {
    for (const match of String(title || "").matchAll(pattern)) {
      const count = positiveTitleNumber(match[1]);
      if (count) values.add(normalizeSupplySpecValue(count, "set_quantity"));
    }
  }
  return values;
}

function titleHeadCountCandidates(title) {
  const values = new Set();
  const patterns = [
    /(?:^|[^\p{L}\p{N}])(\d{1,3})\s*(?:плафон(?:а|ов)?|голов(?:а|ы)?|灯头|头)(?=$|[^\p{L}\p{N}])/giu,
    /(?:^|[^\p{L}\p{N}])(\d{1,3})\s*[- ]?heads?(?=$|[^\p{L}\p{N}])/giu,
  ];
  for (const pattern of patterns) {
    for (const match of String(title || "").matchAll(pattern)) {
      const count = positiveTitleNumber(match[1]);
      if (count) values.add(normalizeSupplySpecValue(count, "head_count"));
    }
  }
  return values;
}

function titleShapeCandidates(title) {
  const values = new Set();
  const source = String(title || "");
  if (/(?:方形|方型|正方形)|(?:^|[^\p{L}\p{N}])(?:square|квадратн(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu.test(source)) {
    values.add("square");
  }
  if (/(?:圆形|圆型|圆款)|(?:^|[^\p{L}\p{N}])(?:round|кругл(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu.test(source)) {
    values.add("round");
  }
  return values;
}

function titleInterfaceCandidates(title) {
  const text = String(title || "");
  const values = new Set();
  const normalizedHdmi = normalizeSupplySpecValue(text, "interface");
  if (normalizedHdmi === "mini-hdmi" || normalizedHdmi === "micro-hdmi") {
    values.add(normalizedHdmi);
  } else if (normalizedHdmi === "__ambiguous__") {
    values.add("mini-hdmi");
    values.add("micro-hdmi");
  }
  const typeC = /(?:^|[^\p{L}\p{N}])(?:type[\s_-]*c|usb[\s_-]+c)(?=$|[^\p{L}\p{N}])/giu;
  const socket = /(?:^|[^\p{L}\p{N}])((?:gu\s*-?\s*(?:10|5[.,]3)|gx\s*-?\s*53|e\s*-?\s*(?:14|27|40)|g\s*-?\s*(?:4|9)|b\s*-?\s*22|r\s*-?\s*7s|2g\s*-?\s*11))(?=$|[^\p{L}\p{N}])/giu;
  for (const match of text.matchAll(typeC)) values.add("type-c");
  for (const match of text.matchAll(socket)) {
    values.add(normalizeSupplySpecValue(match[1], "interface").replace(/[\s-]+/gu, "").replace(",", "."));
  }
  // "USB-C" names one connector. "USB/Type-C" explicitly names alternatives,
  // so it must not be collapsed into a Type-C binding.
  const genericUsb = /(?:^|[^\p{L}\p{N}])usb(?![\s_-]*c(?=$|[^\p{L}\p{N}]))(?=$|[^\p{L}\p{N}])/iu.test(text);
  const ambiguousUsbTypeC = values.has("type-c") && genericUsb;
  return { values, ambiguous: ambiguousUsbTypeC };
}

function collectOzonTitleSupplyAttributes(titles, attributes) {
  const candidates = {
    model: new Set(),
    color: new Set(),
    size: new Set(),
    capacity: new Set(),
    voltage_v: new Set(),
    current_a: new Set(),
    power_w: new Set(),
    cct_k: new Set(),
    set_quantity: new Set(),
    head_count: new Set(),
    shape: new Set(),
    interface: new Set(),
  };
  let ambiguousInterface = false;
  for (const title of titles) {
    for (const value of titleModelCandidates(title)) candidates.model.add(value);
    const casingColorText = casingColorTitleText(title);
    const hasRoseGold = OZON_ROSE_GOLD_COLOR_PATTERN.test(casingColorText);
    const colorRemainder = hasRoseGold
      ? casingColorText.replace(/玫瑰金|(?:^|[^\p{L}\p{N}])rose[\s-]*gold(?=$|[^\p{L}\p{N}])|розов\p{L}*[\s-]+золот\p{L}*/giu, " ")
      : casingColorText;
    for (const [color, pattern] of OZON_TITLE_COLOR_PATTERNS) {
      if (color !== "rose_gold" && pattern.test(colorRemainder)) candidates.color.add(color);
    }
    if (hasRoseGold) candidates.color.add("rose_gold");
    for (const value of titleNozzleSizeCandidates(title)) candidates.size.add(value);
    for (const value of titleCapacityCandidates(title)) candidates.capacity.add(value);
    for (const value of titleElectricalMetricCandidates(title, "voltage_v")) candidates.voltage_v.add(value);
    for (const value of titleElectricalMetricCandidates(title, "current_a")) candidates.current_a.add(value);
    for (const value of titleElectricalMetricCandidates(title, "power_w")) candidates.power_w.add(value);
    for (const value of titleCctCandidates(title)) candidates.cct_k.add(value);
    for (const value of titleSetQuantityCandidates(title)) candidates.set_quantity.add(value);
    for (const value of titleHeadCountCandidates(title)) candidates.head_count.add(value);
    for (const value of titleShapeCandidates(title)) candidates.shape.add(value);
    const interfaces = titleInterfaceCandidates(title);
    for (const value of interfaces.values) candidates.interface.add(value);
    ambiguousInterface ||= interfaces.ambiguous;
  }
  for (const [name, values] of Object.entries(candidates)) {
    if (attributes[name] || values.size !== 1 || (name === "interface" && ambiguousInterface)) continue;
    attributes[name] = [...values][0];
    attributes._sources[name] = "ozon_title";
  }
}

export function supplyTargetVariant({ item = {}, detail = {}, productInfo = {} } = {}) {
  const attributes = { _sources: {} };
  collectSupplyAttributes(productInfo, attributes, "product_info");
  collectSupplyAttributes(detail, attributes, "ozon_detail");
  collectSupplyAttributes(item, attributes, "candidate");
  collectOzonTitleSupplyAttributes(ozonTitleTexts(productInfo, detail, item), attributes);
  const sources = attributes._sources;
  delete attributes._sources;
  const required = Object.keys(attributes).length > 0;
  return {
    required,
    attributes,
    sources,
    label: required
      ? Object.entries(attributes).map(([name, value]) => `${name}=${value}`).join("; ")
      : null,
  };
}

export function validateSupplyEvidence(evidence, {
  at = new Date(),
  matchEvidenceKey = null,
  candidates = null,
  targetVariant = null,
  envelope = null,
} = {}) {
  const timestamp = at instanceof Date ? at.getTime() : Date.parse(String(at));
  const checkedAt = Date.parse(String(evidence?.checked_at || ""));
  const validUntil = Date.parse(String(evidence?.valid_until || ""));
  const nonEmptyObject = (value) => value && typeof value === "object"
    && !Array.isArray(value) && Object.keys(value).length > 0;
  const canonicalJson = (value) => JSON.stringify((function normalize(entry) {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]));
  }(value)));
  let boundOfferUrl = false;
  try {
    const parsed = new URL(String(evidence?.offer_url || ""));
    const normalizedOfferId = compactText(evidence?.offer_id)?.toLowerCase();
    boundOfferUrl = parsed.protocol === "https:"
      && (parsed.hostname === "1688.com" || parsed.hostname.endsWith(".1688.com"))
      && /^\d+$/u.test(normalizedOfferId || "")
      && parsed.pathname.toLowerCase() === `/offer/${normalizedOfferId}.html`;
  } catch {}
  let reason = null;
  const targetAttributes = normalizeTargetVariant(targetVariant);
  const returnedTarget = normalizeTargetVariant(evidence?.target_variant);
  const returnedAttributes = normalizeTargetVariant(evidence?.variant_attributes);
  const targetRequired = targetVariant?.required === true || Object.keys(targetAttributes).length > 0;
  const candidateRows = Array.isArray(candidates) ? candidates : null;
  const matchingCandidate = candidateRows?.find((row) => (
    compactText(row?.offer_id) === compactText(evidence?.offer_id)
    && compactText(row?.offer_url)?.toLowerCase() === compactText(evidence?.offer_url)?.toLowerCase()
  )) || null;
  const normalizedMatchEvidenceKey = compactText(evidence?.match_evidence_key)?.toLowerCase() || "";
  const expectedMatchEvidenceKey = compactText(matchEvidenceKey)?.toLowerCase() || "";
  const imagePrimary = evidence?.variant_match_mode === "image_primary";
  const candidateImageAssessment = matchingCandidate ? assessImagePrimaryCandidate(matchingCandidate) : null;
  const selectedVariant = evidence?.selected_variant;
  const allowedImageSelectionMethods = new Set([
    "image_primary_best_target_overlap",
    IMAGE_PRIMARY_EXACT_THUMBNAIL_SELECTION_METHOD,
  ]);
  const exactThumbnailSelection = compactText(selectedVariant?.selection_method)
    === IMAGE_PRIMARY_EXACT_THUMBNAIL_SELECTION_METHOD;
  const expectedVariantDifferences = Object.entries(targetAttributes)
    .filter(([name, value]) => (
      normalizeSupplySpecValue(returnedAttributes[name], name) !== normalizeSupplySpecValue(value, name)
    ))
    .map(([name, value]) => ({
      name,
      expected: normalizeSupplySpecValue(value, name),
      observed: null,
      kind: "unbound_soft",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const returnedVariantDifferences = Array.isArray(evidence?.variant_differences)
    ? evidence.variant_differences.flatMap((difference) => {
      if (!difference || typeof difference !== "object" || Array.isArray(difference)) return [];
      const name = compactText(difference.name);
      if (
        !name
        || canonicalJson(Object.keys(difference).sort()) !== canonicalJson(["expected", "kind", "name", "observed"])
      ) return [];
      return [{
        name,
        expected: normalizeSupplySpecValue(difference.expected, name),
        observed: difference.observed,
        kind: difference.kind,
      }];
    }).sort((left, right) => left.name.localeCompare(right.name))
    : null;
  if (envelope && (
    envelope.ok !== true
    || envelope.supply_gate_passed !== true
    || envelope.status !== "passed"
    || envelope.blocked === true
    || envelope.retryable === true
  )) reason = "envelope";
  else if (evidence?.contract !== SUPPLY_EVIDENCE_CONTRACT) reason = "contract";
  else if (evidence?.passed !== true || evidence?.platform !== "1688") reason = "not-passed";
  else if (!boundOfferUrl) reason = "offer";
  else if (candidateRows && (!candidateRows.length || !matchingCandidate)) reason = "candidate-binding";
  else if (matchingCandidate && (
    matchingCandidate.platform !== "1688"
    || !STRICT_1688_MATCH_TYPES.has(compactText(matchingCandidate.match_type))
    || compactText(matchingCandidate.match_evidence_key)?.toLowerCase() !== normalizedMatchEvidenceKey
  )) reason = "candidate-binding";
  else if (imagePrimary && (
    evidence?.match_basis !== IMAGE_PRIMARY_MATCH_BASIS
    || matchingCandidate?.match_basis !== IMAGE_PRIMARY_MATCH_BASIS
    || !candidateImageAssessment?.ok
    || canonicalJson(evidence?.image_match_evidence) !== canonicalJson(candidateImageAssessment?.evidence)
  )) reason = "image-evidence-binding";
  else if (imagePrimary && (
    evidence?.item_level_match !== false
    || evidence?.variant_selection_required !== true
    || !selectedVariant
    || typeof selectedVariant !== "object"
    || Array.isArray(selectedVariant)
    || !compactText(selectedVariant.row_key)
    || !compactText(selectedVariant.label)
    || selectedVariant.soft_tie !== false
    || !allowedImageSelectionMethods.has(compactText(selectedVariant.selection_method))
    || (exactThumbnailSelection
      ? !canonicalAlibabaImageAssetUrl(selectedVariant.selected_sku_image_url)
        || canonicalAlibabaImageAssetUrl(selectedVariant.selected_sku_image_url)
          !== canonicalAlibabaImageAssetUrl(candidateImageAssessment?.evidence?.image_url)
      : Object.hasOwn(selectedVariant, "selected_sku_image_url"))
    || !returnedVariantDifferences
    || returnedVariantDifferences.length !== evidence.variant_differences.length
    || canonicalJson(returnedVariantDifferences) !== canonicalJson(expectedVariantDifferences)
    || !evidence?.variant_attributes
    || typeof evidence.variant_attributes !== "object"
    || Array.isArray(evidence.variant_attributes)
    || Number(targetAttributes.set_quantity) > 1
    || canonicalJson(returnedTarget) !== canonicalJson(targetAttributes)
  )) reason = "variant-binding";
  else if (!imagePrimary && targetRequired && evidence?.item_level_match === true) reason = "variant-binding";
  else if (!imagePrimary && targetRequired && (!nonEmptyObject(evidence?.target_variant) || !nonEmptyObject(evidence?.variant_attributes))) reason = "variant-binding";
  else if (!imagePrimary && !targetRequired && evidence?.item_level_match !== true && !(
    nonEmptyObject(evidence?.target_variant) && nonEmptyObject(evidence?.variant_attributes)
  )) reason = "variant-binding";
  else if (!imagePrimary && targetRequired && Object.entries(targetAttributes).some(([name, value]) => (
    normalizeSupplySpecValue(returnedTarget[name], name) !== normalizeSupplySpecValue(value, name)
    || normalizeSupplySpecValue(returnedAttributes[name], name) !== normalizeSupplySpecValue(value, name)
  ))) reason = "variant-conflict";
  else if (typeof evidence?.moq !== "number" || !Number.isFinite(evidence.moq) || !(evidence.moq > 0) || evidence.moq > 1) reason = "moq";
  else if (typeof evidence?.orderable_quantity !== "number" || !Number.isInteger(evidence.orderable_quantity) || evidence.orderable_quantity !== 1) reason = "quantity";
  else if (typeof evidence?.unit_price !== "number" || !Number.isFinite(evidence.unit_price) || !(evidence.unit_price > 0)) reason = "unit-price";
  else if (evidence?.stock_state !== "in_stock" || evidence?.orderable !== true) reason = "unavailable";
  else if (!/^[a-f0-9]{64}$/u.test(normalizedMatchEvidenceKey)) reason = "match-evidence-key";
  else if (expectedMatchEvidenceKey && normalizedMatchEvidenceKey !== expectedMatchEvidenceKey) reason = "match-evidence-key";
  else if (!Number.isFinite(timestamp) || !Number.isFinite(checkedAt) || !Number.isFinite(validUntil)) reason = "timestamps";
  else if (!(validUntil > checkedAt) || validUntil - checkedAt > 30 * 60 * 1000) reason = "validity-window";
  else if (checkedAt > timestamp || timestamp >= validUntil) reason = "expired";
  return { ok: reason === null, reason };
}

function supplyGateAuthenticationFailure(result = {}) {
  if (result?.global_gate_closed === true || result?.alert_required === true) return true;
  const text = `${result?.code || ""} ${result?.reason || ""} ${result?.error || ""} ${result?.message || ""}`;
  return /(?:auth(?:entication)?|login|logged[ -]?out|session[ -]?expired|登录|会话失效)/iu.test(text);
}

function deterministicSupplyResearchOfferIds(result = {}, candidates = []) {
  if (
    result?.deterministic !== true
    || result?.transient === true
    || result?.retryable === true
    || result?.global_gate_closed === true
    || result?.alert_required === true
  ) return [];
  const candidateIds = [...new Set((Array.isArray(candidates) ? candidates : [])
    .map((candidate) => compactText(candidate?.offer_id))
    .filter(Boolean))];
  const failures = Array.isArray(result?.candidate_failures)
    ? result.candidate_failures
    : [];
  if (!candidateIds.length) return [];
  if (!failures.length) {
    return hardSupplyIdentityFailure(result) ? candidateIds : [];
  }
  for (const offerId of candidateIds) {
    const finalFailure = failures.filter((failure) => (
      compactText(failure?.offer_id) === offerId
    )).at(-1);
    if (
      finalFailure?.deterministic !== true
      || finalFailure?.transient === true
      || finalFailure?.retryable === true
      || !SUPPLY_GATE_RESEARCHABLE_FAILURE_CODES.has(compactText(finalFailure?.reason_code))
    ) return [];
  }
  return candidateIds;
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
  const normalized = String(reason || "");
  return /^1688-supply-/u.test(normalized) || [
    "1688-health-deferred",
    "ozon-detail-soft-block-deferred",
    "category-data-missing",
    "category-mapping-unavailable",
    "profit-calculation-deferred",
    "profit-calculation-response-deferred",
    "submission-not-sent-deferred",
  ].includes(normalized);
}

function asSku(item) {
  const sku = String(item?.sku ?? item?.id ?? "").trim();
  if (!sku) throw new Error("candidate SKU is required");
  return sku;
}

function economyResult(calc, logistics = "CEL") {
  if (
    calc?.economy?.price_list
    && calc.economy.price_list.logistics_name === logistics
    && calc.economy.price_list.logistics_speed === "economy"
  ) return calc.economy;
  const rows = calc?.calc_result ?? calc?.data?.calc_result;
  if (!Array.isArray(rows)) return null;
  const row = rows.find((entry) => entry?.name === logistics && entry?.speed === "economy");
  return row ? { title: row.title, price_list: row.price_list } : null;
}

function mappedCategoryRate(categoryMapped) {
  const tier = Array.isArray(categoryMapped) ? categoryMapped.at(-1) : null;
  const match = String(tier ?? "").match(/(?:^|,)(\d+(?:\.\d+)?)$/u);
  const value = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function profitQuoteValidation(priceList, expectedPurchasePrice, {
  expectedSalePrice = null,
  expectedLogistics = null,
  expectedCategory = null,
  expectedPackageWeight = null,
} = {}) {
  const expected = Number(expectedPurchasePrice);
  if (!priceList || typeof priceList !== "object" || Array.isArray(priceList)) {
    return { ok: false, reason: "missing" };
  }
  const requiredNumbers = [
    "purchase_price",
    "sell_price",
    "cate_rate",
    "cate_fee",
    "profit_rate",
  ];
  if (requiredNumbers.some((name) => (
    typeof priceList[name] !== "number" || !Number.isFinite(priceList[name])
  ))) {
    return { ok: false, reason: "malformed" };
  }
  if (
    !(priceList.purchase_price > 0)
    || !(priceList.sell_price > 0)
    || priceList.cate_rate < 0
    || priceList.cate_fee < 0
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (!(expected > 0) || Math.abs(priceList.purchase_price - expected) > PROFIT_QUOTE_PRICE_EPSILON) {
    return {
      ok: false,
      reason: "purchase-price-mismatch",
      returned_purchase_price: priceList.purchase_price,
      expected_purchase_price: expected,
    };
  }
  const expectedSale = Number(expectedSalePrice);
  if (expectedSale > 0
    && Math.abs(priceList.sell_price - expectedSale) > PROFIT_QUOTE_PRICE_EPSILON) {
    return {
      ok: false,
      reason: "sell-price-mismatch",
      returned_sell_price: priceList.sell_price,
      expected_sell_price: expectedSale,
    };
  }
  const expectedProvider = String(expectedLogistics || "").trim();
  if (expectedProvider && (
    priceList.logistics_name !== expectedProvider
    || priceList.logistics_speed !== "economy"
  )) {
    return {
      ok: false,
      reason: "logistics-mismatch",
      returned_logistics_name: priceList.logistics_name ?? null,
      returned_logistics_speed: priceList.logistics_speed ?? null,
      expected_logistics_name: expectedProvider,
      expected_logistics_speed: "economy",
    };
  }
  const expectedCateRate = mappedCategoryRate(expectedCategory);
  if (expectedCateRate !== null
    && Math.abs(priceList.cate_rate - expectedCateRate) > PROFIT_QUOTE_PRICE_EPSILON) {
    return {
      ok: false,
      reason: "category-rate-mismatch",
      returned_cate_rate: priceList.cate_rate,
      expected_cate_rate: expectedCateRate,
    };
  }
  const expectedCateFee = expectedCateRate === null
    ? null
    : (priceList.sell_price * expectedCateRate) / 100;
  if (expectedCateFee !== null
    && Math.abs(priceList.cate_fee - expectedCateFee) > 0.011) {
    return {
      ok: false,
      reason: "category-fee-mismatch",
      returned_cate_fee: priceList.cate_fee,
      expected_cate_fee: expectedCateFee,
    };
  }
  const expectedWeight = Number(expectedPackageWeight);
  if (expectedWeight > 0) {
    if (typeof priceList.package_weight !== "number"
      || !Number.isFinite(priceList.package_weight)
      || !(priceList.package_weight > 0)) {
      return { ok: false, reason: "package-weight-missing" };
    }
    if (Math.abs(priceList.package_weight - expectedWeight) > 0.001) {
      return {
        ok: false,
        reason: "package-weight-mismatch",
        returned_package_weight: priceList.package_weight,
        expected_package_weight: expectedWeight,
      };
    }
  }
  // Maozi defines profit_rate as profit / total cost. Even before logistics,
  // advertising, and other fees, purchase + category commission are unavoidable.
  // A reported rate above this best-case bound cannot belong to this request.
  if (expectedSale > 0 && expectedProvider && expectedCateRate !== null) {
    const minimumKnownCost = priceList.purchase_price + Math.max(0, expectedCateFee - 0.01);
    const maximumPossibleProfit = priceList.sell_price - minimumKnownCost;
    const maximumPossibleProfitRate = minimumKnownCost > 0
      ? (maximumPossibleProfit / minimumKnownCost) * 100
      : Number.NEGATIVE_INFINITY;
    if (
      !Number.isFinite(maximumPossibleProfitRate)
      || priceList.profit_rate > maximumPossibleProfitRate + PROFIT_QUOTE_RATE_EPSILON
    ) {
      return {
        ok: false,
        reason: "profit-arithmetic-impossible",
        returned_profit_rate: priceList.profit_rate,
        maximum_possible_profit_rate: maximumPossibleProfitRate,
        minimum_known_cost: minimumKnownCost,
      };
    }
  }
  if (expectedSale > 0 && expectedProvider && expectedCateRate !== null && expectedWeight > 0) {
    const componentNames = [
      "china_fee",
      "logi_fee",
      "ad_fee",
      "other_fee",
      "wc_fee",
      "total_cost",
      "profit",
    ];
    if (componentNames.some((name) => (
      typeof priceList[name] !== "number" || !Number.isFinite(priceList[name])
    ))) {
      return { ok: false, reason: "profit-components-missing" };
    }
    if ([
      priceList.china_fee,
      priceList.logi_fee,
      priceList.ad_fee,
      priceList.other_fee,
      priceList.wc_fee,
    ].some((value) => value < 0) || !(priceList.total_cost > 0)) {
      return { ok: false, reason: "profit-components-malformed" };
    }
    const componentTotal = priceList.purchase_price
      + priceList.china_fee
      + priceList.logi_fee
      + priceList.cate_fee
      + priceList.ad_fee
      + priceList.other_fee
      + priceList.wc_fee;
    if (Math.abs(priceList.total_cost - componentTotal) > 0.05) {
      return {
        ok: false,
        reason: "total-cost-mismatch",
        returned_total_cost: priceList.total_cost,
        expected_total_cost: componentTotal,
      };
    }
    const expectedProfit = priceList.sell_price - priceList.total_cost;
    if (Math.abs(priceList.profit - expectedProfit) > 0.02) {
      return {
        ok: false,
        reason: "profit-total-mismatch",
        returned_profit: priceList.profit,
        expected_profit: expectedProfit,
      };
    }
    const expectedProfitRate = (priceList.profit / priceList.total_cost) * 100;
    if (Math.abs(priceList.profit_rate - expectedProfitRate) > 0.02) {
      return {
        ok: false,
        reason: "profit-rate-mismatch",
        returned_profit_rate: priceList.profit_rate,
        expected_profit_rate: expectedProfitRate,
      };
    }
  }
  return { ok: true, reason: null };
}

function canonicalProfitRecheckContext(context = {}) {
  return {
    contract: context.contract,
    observed_at: context.observed_at,
    valid_until: context.valid_until,
    sale_price: context.sale_price,
    product_info: context.product_info,
    detail_package: context.detail_package,
    package_evidence: context.package_evidence,
    category_mapped: context.category_mapped,
    profit_threshold: context.profit_threshold,
    effective_profit_floor: context.effective_profit_floor,
    logistics: context.logistics,
  };
}

function profitRecheckContextDigest(context) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalProfitRecheckContext(context)))
    .digest("hex");
}

function createProfitRecheckContext(context, observedAt) {
  const observed = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (!Number.isFinite(observed.getTime())) throw new TypeError("profit recheck context time is invalid");
  const value = {
    contract: PROFIT_RECHECK_CONTEXT_CONTRACT,
    observed_at: observed.toISOString(),
    valid_until: new Date(observed.getTime() + PROFIT_RECHECK_CONTEXT_TTL_MS).toISOString(),
    ...context,
  };
  return {
    ...value,
    context_sha256: profitRecheckContextDigest(value),
  };
}

function validateProfitRecheckContext(context, {
  at = new Date(),
  minimumHeadroomMs = 0,
} = {}) {
  const timestamp = at instanceof Date ? at.getTime() : Date.parse(String(at));
  const observedAt = Date.parse(String(context?.observed_at || ""));
  const validUntil = Date.parse(String(context?.valid_until || ""));
  let reason = null;
  if (!context || typeof context !== "object" || Array.isArray(context)) reason = "missing";
  else if (context.contract !== PROFIT_RECHECK_CONTEXT_CONTRACT) reason = "contract";
  else if (!Number.isFinite(observedAt) || !Number.isFinite(validUntil)) reason = "timestamps";
  else if (!(validUntil > observedAt) || validUntil - observedAt > PROFIT_RECHECK_CONTEXT_TTL_MS) reason = "validity-window";
  else if (!Number.isFinite(timestamp) || timestamp < observedAt || timestamp + minimumHeadroomMs >= validUntil) reason = "expired";
  else if (!/^[a-f0-9]{64}$/u.test(String(context.context_sha256 || ""))
    || context.context_sha256 !== profitRecheckContextDigest(context)) reason = "digest";
  else if (typeof context.sale_price !== "number" || !Number.isFinite(context.sale_price) || !(context.sale_price > 0)) reason = "sale-price";
  else if (typeof context.profit_threshold !== "number" || !Number.isFinite(context.profit_threshold)) reason = "profit-threshold";
  else if (typeof context.effective_profit_floor !== "number" || !Number.isFinite(context.effective_profit_floor)) reason = "profit-floor";
  else if (!String(context.logistics || "").trim()) reason = "logistics";
  return { ok: reason === null, reason };
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

function hasWarehouseStatusRejection(stockUpdate) {
  return (stockUpdate?.result || []).some((row) => (row?.errors || []).some((error) => (
    String(error?.code || "").toUpperCase() === "WAREHOUSE_WRONG_STATUS"
  )));
}

function reconciliationBackoffMs(attempts) {
  const count = Math.max(1, Number(attempts) || 1);
  if (count <= 10) return Math.min(60_000, 10_000 + count * 5_000);
  return Math.min(180_000, 60_000 + (count - 10) * 30_000);
}

function isDurableReconciliationFinal(entry) {
  const data = entry?.data || entry || {};
  if (["published", "skipped"].includes(String(entry?.status || ""))) return true;
  if (data.terminal === true) return true;
  return DIRECT_RECONCILIATION_FINAL_OUTCOMES.has(String(data.outcome_status || ""));
}

function reconciliationStartedAtMs(item) {
  const timestamps = [
    item?.reconciliation_started_at,
    item?.accepted_at,
    item?.erp_accepted_at,
    item?.api_call_started_at,
    item?.api_call_completed_at,
    item?.submitted_at,
    item?.prepared_at,
    item?.selected_at,
  ]
    .map((value) => Date.parse(String(value || "")))
    .filter(Number.isFinite);
  return timestamps.length > 0 ? Math.min(...timestamps) : null;
}

function reconciliationExpiryReason(item, {
  attempts,
  nowMs,
  maxAttempts,
  maxAgeMs,
}) {
  if (Math.max(0, Number(attempts) || 0) >= maxAttempts) {
    return "reconciliation-max-attempts-exhausted";
  }
  const startedAt = reconciliationStartedAtMs(item);
  if (startedAt !== null && nowMs >= startedAt && nowMs - startedAt >= maxAgeMs) {
    return "reconciliation-max-age-exhausted";
  }
  return null;
}

function reconciliationDueAtMs(item) {
  const scheduledAt = Date.parse(String(item?.next_reconcile_at || ""));
  if (Number.isFinite(scheduledAt)) return scheduledAt;
  return reconciliationStartedAtMs(item) ?? Number.NEGATIVE_INFINITY;
}

function prioritizeDueReconciliations(items, cursorSku = null) {
  const ranked = [...items]
    .map((item, index) => ({
      item,
      index,
      sku: asSku(item),
      dueAt: reconciliationDueAtMs(item),
      startedAt: reconciliationStartedAtMs(item) ?? Number.NEGATIVE_INFINITY,
    }))
    .sort((left, right) => left.dueAt - right.dueAt
      || left.startedAt - right.startedAt
      || left.sku.localeCompare(right.sku)
      || left.index - right.index);
  const cursorIndex = ranked.findIndex((row) => row.sku === String(cursorSku || ""));
  if (cursorIndex < 0) return ranked.map(({ item }) => item);

  // Oldest-due order is authoritative. The cursor rotates only an exact-time
  // tie, so a repeatedly failing head row cannot starve its peers without
  // allowing newer work to jump ahead of genuinely older work.
  const cursor = ranked[cursorIndex];
  let groupStart = cursorIndex;
  let groupEnd = cursorIndex + 1;
  while (groupStart > 0
    && ranked[groupStart - 1].dueAt === cursor.dueAt
    && ranked[groupStart - 1].startedAt === cursor.startedAt) groupStart -= 1;
  while (groupEnd < ranked.length
    && ranked[groupEnd].dueAt === cursor.dueAt
    && ranked[groupEnd].startedAt === cursor.startedAt) groupEnd += 1;
  const group = ranked.slice(groupStart, groupEnd);
  const groupCursor = group.findIndex((row) => row.sku === cursor.sku);
  ranked.splice(
    groupStart,
    group.length,
    ...group.slice(groupCursor + 1),
    ...group.slice(0, groupCursor + 1),
  );
  return ranked.map(({ item }) => item);
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

function resolvedPackageWeight(productInfo = {}, detail = {}) {
  return productInfo.weight ?? detail.weight ?? 1;
}

function profitCalculationInput({ sku, salePrice, purchasePrice, productInfo, detail, category, profitThreshold, logistics = "CEL" }) {
  return {
    sku,
    sell_price: salePrice,
    purchase_price: purchasePrice,
    package_weight: resolvedPackageWeight(productInfo, detail),
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

const COST_GATE_LANES = new Set(["continuation", "normal"]);

function costGateAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason ? String(signal.reason) : "1688 cost gate operation aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

/**
 * Prefer in-progress alternative searches without starving new initial cost
 * lookups. Each lane is FIFO and no more than `continuationBurstLimit`
 * continuation jobs may start while a normal job is waiting.
 */
export function createFairCostGate(limit = 1, {
  continuationBurstLimit = 3,
  clock = () => Date.now(),
  onTelemetry = () => {},
} = {}) {
  const maximum = Number(limit);
  const maximumContinuationBurst = Number(continuationBurstLimit);
  if (!Number.isInteger(maximum) || maximum <= 0) {
    throw new TypeError("fair cost gate limit must be a positive integer");
  }
  if (!Number.isInteger(maximumContinuationBurst) || maximumContinuationBurst <= 0) {
    throw new TypeError("continuationBurstLimit must be a positive integer");
  }
  if (typeof clock !== "function") throw new TypeError("fair cost gate clock must be a function");
  if (typeof onTelemetry !== "function") {
    throw new TypeError("fair cost gate onTelemetry must be a function");
  }

  let active = 0;
  let continuationStartsWhileNormalWaiting = 0;
  const queues = {
    continuation: [],
    normal: [],
  };

  function clockMs() {
    try {
      const value = Number(clock());
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  function depthSnapshot() {
    return {
      active,
      continuation: queues.continuation.length,
      normal: queues.normal.length,
      limit: maximum,
    };
  }

  function emitTelemetry(row) {
    try {
      const pending = onTelemetry(row);
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch {
      // Cost work must not fail because best-effort timing telemetry failed.
    }
  }

  function detachAbortListener(job) {
    if (job.signal && job.abortListener) {
      job.signal.removeEventListener("abort", job.abortListener);
      job.abortListener = null;
    }
  }

  function selectedLane() {
    const continuationWaiting = queues.continuation.length > 0;
    const normalWaiting = queues.normal.length > 0;
    if (!continuationWaiting) {
      if (!normalWaiting) continuationStartsWhileNormalWaiting = 0;
      return normalWaiting ? "normal" : null;
    }
    if (!normalWaiting) {
      continuationStartsWhileNormalWaiting = 0;
      return "continuation";
    }
    return continuationStartsWhileNormalWaiting >= maximumContinuationBurst
      ? "normal"
      : "continuation";
  }

  function drain() {
    while (active < maximum) {
      const lane = selectedLane();
      if (!lane) return;
      const job = queues[lane].shift();
      if (!job || job.settled) continue;
      if (job.signal?.aborted) {
        job.settled = true;
        detachAbortListener(job);
        const finishedAt = clockMs();
        emitTelemetry({
          lane,
          queue_ms: Math.max(0, finishedAt - job.enqueuedAt),
          service_ms: 0,
          status: "cancelled",
          depths: {
            enqueued: job.depthsAtEnqueue,
            started: null,
            finished: depthSnapshot(),
          },
        });
        job.reject(costGateAbortError(job.signal));
        continue;
      }

      if (lane === "normal") continuationStartsWhileNormalWaiting = 0;
      else if (queues.normal.length > 0) continuationStartsWhileNormalWaiting += 1;

      job.started = true;
      detachAbortListener(job);
      active += 1;
      job.startedAt = clockMs();
      job.depthsAtStart = depthSnapshot();
      void (async () => {
        let value;
        let failed = false;
        let failure = null;
        try {
          value = await Promise.resolve().then(() => job.operation(job.signal));
        } catch (error) {
          failed = true;
          failure = error;
        }

        const finishedAt = clockMs();
        active -= 1;
        job.settled = true;
        emitTelemetry({
          lane,
          queue_ms: Math.max(0, job.startedAt - job.enqueuedAt),
          service_ms: Math.max(0, finishedAt - job.startedAt),
          status: failed ? (job.signal?.aborted ? "cancelled" : "rejected") : "fulfilled",
          depths: {
            enqueued: job.depthsAtEnqueue,
            started: job.depthsAtStart,
            finished: depthSnapshot(),
          },
        });
        drain();
        if (failed) job.reject(failure);
        else job.resolve(value);
      })();
    }
  }

  function run(operation, { lane = "normal", signal = null } = {}) {
    if (typeof operation !== "function") throw new TypeError("gated operation must be a function");
    if (!COST_GATE_LANES.has(lane)) throw new TypeError("fair cost gate lane must be continuation or normal");
    if (signal !== null && signal !== undefined
      && (typeof signal !== "object"
        || typeof signal.addEventListener !== "function"
        || typeof signal.removeEventListener !== "function")) {
      throw new TypeError("fair cost gate signal must be an AbortSignal");
    }
    if (signal?.aborted) return Promise.reject(costGateAbortError(signal));

    return new Promise((resolve, reject) => {
      const job = {
        operation,
        lane,
        signal,
        resolve,
        reject,
        enqueuedAt: clockMs(),
        startedAt: null,
        started: false,
        settled: false,
        abortListener: null,
        depthsAtEnqueue: null,
        depthsAtStart: null,
      };
      queues[lane].push(job);
      job.depthsAtEnqueue = depthSnapshot();
      if (signal) {
        job.abortListener = () => {
          if (job.started || job.settled) return;
          const index = queues[lane].indexOf(job);
          if (index < 0) return;
          queues[lane].splice(index, 1);
          job.settled = true;
          detachAbortListener(job);
          const finishedAt = clockMs();
          emitTelemetry({
            lane,
            queue_ms: Math.max(0, finishedAt - job.enqueuedAt),
            service_ms: 0,
            status: "cancelled",
            depths: {
              enqueued: job.depthsAtEnqueue,
              started: null,
              finished: depthSnapshot(),
            },
          });
          reject(costGateAbortError(signal));
          drain();
        };
        signal.addEventListener("abort", job.abortListener, { once: true });
      }
      drain();
    });
  }

  return {
    run,
    stats: () => ({
      active,
      queued: queues.continuation.length + queues.normal.length,
      limit: maximum,
      continuation_streak: continuationStartsWhileNormalWaiting,
      depths: {
        continuation: queues.continuation.length,
        normal: queues.normal.length,
      },
    }),
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
  excludedSkus = new Set(),
  reconciliationOnly = false,
  validationOnly = false,
  validationUseSnapshotPrice = false,
  validationSupplyOnly = false,
  validationSignedEvidenceReplay = null,
  validationCommissionSeed = null,
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
  reconciliationMaxAttempts = DEFAULT_RECONCILIATION_MAX_ATTEMPTS,
  reconciliationMaxAgeMs = DEFAULT_RECONCILIATION_MAX_AGE_MS,
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
  supplyVerifier = null,
  requireSupplyGate = false,
  supplyGateMaximumOffers = 3,
  supplyGateRetryMs = 30 * 60 * 1000,
  semanticMissQueueRetireMs = DEFAULT_SEMANTIC_MISS_QUEUE_RETIRE_MS,
  profitPriorityFile = null,
  profitFeedbackFile = null,
  seasonPriorityFile = null,
  profitFileRefreshMs = 5_000,
  profitSafetyActionPolicy = "shadow",
  onProgress = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!client || !costBridge || !state) throw new TypeError("client, costBridge, and state are required");
  if (!detailProvider || typeof detailProvider.getProductDetail !== "function") {
    throw new TypeError("Playwright Ozon detailProvider.getProductDetail is required");
  }
  if (typeof onProgress !== "function") throw new TypeError("onProgress must be a function");
  const targetCount = Number(target);
  const profitThreshold = Number(threshold);
  const activeExcludedSkus = new Set(
    [...(excludedSkus instanceof Set ? excludedSkus : excludedSkus || [])]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean),
  );
  const activeDirectMode = Boolean(directMode);
  const activeValidationSnapshotPrice = validationUseSnapshotPrice === true;
  const activeValidationSupplyOnly = validationSupplyOnly === true;
  const activeValidationCommissionSeed = validationCommissionSeed === null
    || validationCommissionSeed === undefined
    ? null
    : validationCommissionSeed;
  const enforceDailyQuota = !activeDirectMode
    || (enforceDirectDailyLimit === true && !reconciliationOnly);
  const unlimitedTarget = activeDirectMode && targetCount === 0;
  const sharedDirectRunControl = directRunControl && typeof directRunControl === "object"
    ? directRunControl
    : null;
  const requiredSameItemMatches = Number(minimumSameItemMatches);
  const configuredCostEstimateTimeoutMs = Number(costEstimateTimeoutMs);
  const configuredSupplyGateMaximumOffers = Number(supplyGateMaximumOffers);
  const configuredSupplyGateRetryMs = Number(supplyGateRetryMs);
  const configuredSemanticMissQueueRetireMs = Number(semanticMissQueueRetireMs);
  const configuredReconciliationMaxAttempts = Number(reconciliationMaxAttempts);
  const configuredReconciliationMaxAgeMs = Number(reconciliationMaxAgeMs);
  const configuredProfitSafetyActionPolicy = String(profitSafetyActionPolicy || "")
    .trim()
    .toLowerCase();
  const profitFiles = createProfitFilesReader({
    priorityFile: profitPriorityFile,
    feedbackFile: profitFeedbackFile,
    seasonFile: seasonPriorityFile,
    refreshMs: Math.max(0, Number(profitFileRefreshMs) || 0),
  });
  function reportProgress(progress = {}) {
    try {
      return Promise.resolve(onProgress({
        lane: reconciliationOnly ? "reconciliation" : "consumer",
        ...progress,
      })).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }
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
  if (!Number.isInteger(configuredSupplyGateMaximumOffers)
    || configuredSupplyGateMaximumOffers < 1
    || configuredSupplyGateMaximumOffers > 3) {
    throw new TypeError("supplyGateMaximumOffers must be an integer from 1 to 3");
  }
  if (!Number.isFinite(configuredSupplyGateRetryMs) || configuredSupplyGateRetryMs < 1_000) {
    throw new TypeError("supplyGateRetryMs must be at least one second");
  }
  if (!Number.isFinite(configuredSemanticMissQueueRetireMs)
    || configuredSemanticMissQueueRetireMs < 1_000) {
    throw new TypeError("semanticMissQueueRetireMs must be at least one second");
  }
  if (requireSupplyGate && (!supplyVerifier || typeof supplyVerifier.verify !== "function")) {
    throw new TypeError("enforced supply gate requires supplyVerifier.verify");
  }
  if (!Number.isInteger(configuredReconciliationMaxAttempts) || configuredReconciliationMaxAttempts <= 0) {
    throw new TypeError("reconciliationMaxAttempts must be a positive integer");
  }
  if (!Number.isFinite(configuredReconciliationMaxAgeMs) || configuredReconciliationMaxAgeMs <= 0) {
    throw new TypeError("reconciliationMaxAgeMs must be a positive number");
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
  if (activeValidationSnapshotPrice && (!activeDirectMode || !activeValidationOnly)) {
    throw new TypeError("validationUseSnapshotPrice requires directMode=true and validationOnly=true");
  }
  if (activeValidationSnapshotPrice && (requireReliableCostContract !== true || requireSupplyGate !== true)) {
    throw new TypeError("validationUseSnapshotPrice requires strict cost evidence and the enforced supply gate");
  }
  if (activeValidationSupplyOnly && !activeValidationSnapshotPrice) {
    throw new TypeError("validationSupplyOnly requires validationUseSnapshotPrice=true");
  }
  if (activeValidationSupplyOnly
    && validationSignedEvidenceReplay !== null
    && validationSignedEvidenceReplay !== undefined
    && typeof validationSignedEvidenceReplay.requestFor !== "function") {
    throw new TypeError("validationSupplyOnly signed evidence replay must expose requestFor()");
  }
  if (activeValidationCommissionSeed && !activeValidationSnapshotPrice) {
    throw new TypeError("validationCommissionSeed requires validationUseSnapshotPrice=true");
  }
  if (activeValidationCommissionSeed
    && (!Array.isArray(activeValidationCommissionSeed.commissionTree)
      || typeof activeValidationCommissionSeed.categoryForSku !== "function")) {
    throw new TypeError("validationCommissionSeed must be a loaded snapshot commission seed");
  }
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
      weightThresholdGrams: Number(entry?.weightThresholdGrams ?? 400),
      weightRouting: entry?.weightRouting === true,
      requireWarehouse: entry?.requireWarehouse !== false,
    }))
    : [{
      id: Number(storeId),
      needle: String(storeNeedle),
      warehouseId: warehouseId == null ? null : Number(warehouseId),
      uralWarehouseId: null,
      weightThresholdGrams: 400,
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
  let reconciliationFairnessCursor = null;
  const adaptive = new AdaptiveConcurrency({
    initial: workerCount,
    max: activeDirectMode
      ? workerCount
      : Math.max(workerCount, Number(maxConcurrency) || workerCount),
  });
  // The 1688 pool can intentionally be smaller than the surrounding publish
  // pipeline. Acquire a real cost-worker slot before starting the per-item
  // hard deadline so queue wait cannot consume the query budget. Alternative
  // searches get bounded priority, while one waiting initial lookup is forced
  // after every three continuation starts.
  const costGate = createFairCostGate(costWorkerCount, {
    onTelemetry: (row) => recordMetric("cost_gate.jsonl", row),
  });

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

  async function projectErpAccepted(row) {
    try {
      if (typeof state.recordErpAccepted === "function") {
        await state.recordErpAccepted(row);
      } else {
        recordMetric("erp_accepted.jsonl", row);
      }
    } catch (error) {
      // The submitted reservation is authoritative. A compatibility audit
      // projection can be repaired from SQLite on load and must not reclassify
      // an accepted POST as failed or invite another POST.
      recordMetric("runtime_errors.jsonl", {
        stage: "erp-accepted-projection",
        sku: row?.sku ?? null,
        error: String(error?.message || error),
      });
    }
  }

  function directStoreFreezeReason(storeId) {
    const normalizedStoreId = Number(storeId || 0);
    if ((activeValidationOnly && activeValidationSnapshotPrice)
      || !activeDirectMode
      || !(normalizedStoreId > 0)
      || !directRejectedStoreIds.has(normalizedStoreId)) {
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
    void reportProgress({ kind: "stage-started", sku, stage });
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

  async function confirmPublication(sku, payload, targetConfig, {
    attempts: attemptOverride = null,
    initialImportLog = null,
  } = {}) {
    const offerId = payload.rows[0].offer_id;
    const attempts = Math.max(1, Number(attemptOverride ?? confirmationAttempts) || 1);
    let lastImportLog = null;
    let lastOnlineProduct = null;
    let lastStockUpdate = null;
    const stockAttempts = new Set();
    const targetWarehouseId = Number(targetConfig.warehouseId || 0);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const importLog = attempt === 0 && initialImportLog
        ? initialImportLog
        : await client.findImportLog({ shopId: targetConfig.store.id, sku, offerId });
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
      reason: activeDirectMode ? "erp-submission-accepted" : "submission-accepted",
      submission_intent: false,
      submitted: true,
      submission_pending: false,
      submitted_at: acceptedAt,
      api_call_accepted_at: acceptedAt,
      api_call_completed_at: acceptedAt,
      publish_result: publishResult ?? null,
      ...(activeDirectMode ? {
        reconcile_only: true,
        accepted_at: acceptedAt,
        next_reconcile_at: new Date(Date.parse(acceptedAt) + 10_000).toISOString(),
        outcome_status: "submitted",
        background_status: {
          imported: false,
          online: false,
          stock_updated: false,
          rejected: false,
        },
      } : {}),
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

  async function repriceSubmissionImmediatelyBeforePost({
    sku,
    currentData,
    purchasePrice,
    supplyEvidence,
    payload,
  }) {
    const context = currentData?.profit_recheck_context;
    const contextValidity = validateProfitRecheckContext(context, {
      at: now(),
      minimumHeadroomMs: 60_000,
    });
    if (!contextValidity.ok) {
      return {
        ok: false,
        reason: `submission-profit-context-${contextValidity.reason}`,
        reset_pre_call_intent: true,
      };
    }
    let calc;
    try {
      calc = await timed(sku, "profit_calculation_supply_pre_post", () => client.calculateProfit(profitCalculationInput({
        sku,
        salePrice: context.sale_price,
        purchasePrice,
        productInfo: context.product_info || {},
        detail: context.detail_package || {},
        category: { mapped: context.category_mapped },
        profitThreshold: context.profit_threshold,
        logistics: context.logistics,
      })));
    } catch (error) {
      if (isFatalRunnerError(error)) throw error;
      return {
        ok: false,
        reason: "1688-supply-reprice-calculation-failed",
        error: String(error?.message || error),
      };
    }
    const economy = economyResult(calc, context.logistics);
    if (!economy?.price_list || typeof economy.price_list !== "object") {
      return { ok: false, reason: "1688-supply-reprice-economy-missing" };
    }
    const quoteValidity = profitQuoteValidation(economy.price_list, purchasePrice, {
      expectedSalePrice: context.sale_price,
      expectedLogistics: context.logistics,
      expectedCategory: context.category_mapped,
      expectedPackageWeight: resolvedPackageWeight(
        context.product_info || {},
        context.detail_package || {},
      ),
    });
    if (!quoteValidity.ok) {
      return {
        ok: false,
        reason: `1688-supply-profit-quote-${quoteValidity.reason}`,
        quote_validation: quoteValidity,
      };
    }
    const profit = {
      ...economy.price_list,
      purchase_price: purchasePrice,
      sell_price: economy.price_list.sell_price ?? context.sale_price,
    };
    const effectiveProfitFloor = Number(context.effective_profit_floor);
    const profitReason = policy.profitSkipReason(profit, context.profit_threshold);
    if (profitReason || !(Number(profit.profit_rate) > effectiveProfitFloor)) {
      return {
        ok: false,
        reason: profitReason || `1688-supply-live-price-profit_rate<=${effectiveProfitFloor}`,
        profit,
      };
    }
    const profitSafetyShadow = assessProfitSafety({
      profit,
      cost: { ...(currentData.cost || {}), cost: purchasePrice },
      packageEvidence: context.package_evidence || {},
    });
    const profitSafetyGate = assessProfitSafetyGate({
      profitSafety: profitSafetyShadow,
      cost: { ...(currentData.cost || {}), cost: purchasePrice },
      policy: configuredProfitSafetyActionPolicy,
      directMode: activeDirectMode,
    });
    if (profitSafetyGate.enforced === true) {
      return {
        ok: false,
        reason: "1688-supply-live-price-profit-safety-rejected",
        profit,
        profit_safety_shadow: profitSafetyShadow,
        profit_safety_gate: profitSafetyGate,
      };
    }
    const sellPrice = rounded(profit.sell_price);
    if (!(sellPrice > 0) || !payload?.rows?.[0]) {
      return { ok: false, reason: "1688-supply-reprice-payload-invalid" };
    }
    payload.rows[0].sell_price = sellPrice;
    payload.rows[0].price = sellPrice;
    payload.rows[0].old_price = rounded(sellPrice * 2);
    const statePatch = {
      sell_price: sellPrice,
      purchase_price: purchasePrice,
      purchase_price_live_one_piece: Number(supplyEvidence.unit_price),
      profit_rate: profit.profit_rate,
      cate_rate: profit.cate_rate,
      cate_fee: profit.cate_fee,
      profit_safety_shadow: profitSafetyShadow,
      profit_safety_gate: profitSafetyGate,
      submission_payload: payload,
      supply_repriced_before_post_at: now().toISOString(),
    };
    recordMetric("supply_gate.jsonl", {
      sku,
      status: "pre-post-profit-recalculated",
      previous_effective_price: Number(currentData.purchase_price) || null,
      refreshed_effective_price: purchasePrice,
      profit_rate: Number(profit.profit_rate),
      sell_price: sellPrice,
      offer_id: supplyEvidence.offer_id,
      checked_at: supplyEvidence.checked_at,
    });
    return { ok: true, statePatch };
  }

  async function refreshSupplyImmediatelyBeforePost(sku, submissionState, payload) {
    if (!requireSupplyGate) return { ok: true, submissionState };
    const currentEntry = typeof state.entryOf === "function" ? state.entryOf(sku) : null;
    const currentData = {
      ...submissionState,
      ...(currentEntry?.data || {}),
    };
    const contextValidity = validateProfitRecheckContext(currentData.profit_recheck_context, {
      at: now(),
      minimumHeadroomMs: 60_000,
    });
    if (!contextValidity.ok) {
      return {
        ok: false,
        reason: `submission-profit-context-${contextValidity.reason}`,
        not_submitted: true,
        reset_pre_call_intent: true,
      };
    }
    const currentValidity = validateSupplyEvidence(currentData.supply_evidence, {
      at: now(),
      matchEvidenceKey: currentData?.cost?.match_evidence_key,
      candidates: currentData.supply_candidates,
      targetVariant: currentData.target_variant,
    });
    const evidenceHeadroomMs = Date.parse(String(currentData?.supply_evidence?.valid_until || ""))
      - now().getTime();
    if (
      currentData.supply_gate_passed === true
      && currentValidity.ok
      && evidenceHeadroomMs >= 60_000
    ) {
      Object.assign(submissionState, {
        supply_gate_passed: true,
        supply_evidence: currentData.supply_evidence,
      });
      return { ok: true, submissionState };
    }
    const refreshed = await verifyOrderableSupply({
      item: currentData,
      cost: currentData.cost,
      detail: currentData,
      productInfo: currentData.product_info || {},
      targetVariant: currentData.target_variant || null,
      force: true,
    });
    if (!refreshed.ok) {
      return {
        ok: false,
        reason: refreshed.reason,
        not_submitted: true,
        supply_gate: refreshed.result,
      };
    }
    const refreshedContextValidity = validateProfitRecheckContext(currentData.profit_recheck_context, {
      at: now(),
      minimumHeadroomMs: 60_000,
    });
    if (!refreshedContextValidity.ok) {
      return {
        ok: false,
        reason: `submission-profit-context-${refreshedContextValidity.reason}`,
        not_submitted: true,
        reset_pre_call_intent: true,
      };
    }
    const refreshedPurchasePrice = Math.max(
      Number(currentData?.purchase_price_original_p70_p80 || currentData?.cost?.cost),
      Number(refreshed.evidence.unit_price),
    );
    if (!(refreshedPurchasePrice > 0)) {
      return {
        ok: false,
        reason: "1688-supply-live-price-invalid",
        not_submitted: true,
        supply_gate: {
          prior_purchase_price: Number(currentData.purchase_price) || null,
          refreshed_purchase_price: refreshedPurchasePrice,
          supply_evidence: refreshed.evidence,
        },
      };
    }
    let repricePatch = {};
    if (Math.abs(refreshedPurchasePrice - Number(currentData.purchase_price)) > 0.000001) {
      const repriced = await repriceSubmissionImmediatelyBeforePost({
        sku,
        currentData,
        purchasePrice: refreshedPurchasePrice,
        supplyEvidence: refreshed.evidence,
        payload,
      });
      if (!repriced.ok) {
        return {
          ok: false,
          reason: repriced.reason,
          not_submitted: true,
          reset_pre_call_intent: repriced.reset_pre_call_intent === true,
          supply_gate: {
            ...repriced,
            prior_purchase_price: Number(currentData.purchase_price) || null,
            refreshed_purchase_price: refreshedPurchasePrice,
            supply_evidence: refreshed.evidence,
          },
        };
      }
      repricePatch = repriced.statePatch;
    }
    const refreshedState = {
      ...currentData,
      ...repricePatch,
      supply_gate_passed: true,
      supply_evidence: refreshed.evidence,
      purchase_price_live_one_piece: Number(refreshed.evidence.unit_price),
      supply_candidates: refreshed.candidates,
      target_variant: refreshed.targetVariant,
      supply_rechecked_before_post_at: now().toISOString(),
    };
    const recorded = await state.transition(sku, "processing", refreshedState);
    if (recorded === false) {
      return {
        ok: false,
        reason: "submission-api-call-reservation-lost",
        not_submitted: true,
      };
    }
    Object.assign(submissionState, refreshedState);
    return { ok: true, submissionState };
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
      const supplyReady = await refreshSupplyImmediatelyBeforePost(sku, submissionState, payload);
      if (!supplyReady.ok) return supplyReady;
      const apiCallStartedAt = now().toISOString();
      const apiCallState = {
        ...submissionState,
        reason: "submission-api-call-started",
        submission_intent: true,
        submitted: false,
        submission_pending: false,
        api_call_started_at: apiCallStartedAt,
        supply_verified_for_submission_at: apiCallStartedAt,
        api_call_attempts_total: Math.max(1, Number(submissionState?.api_call_attempts_total) || 1),
        api_call_attempts_day: Math.max(1, Number(submissionState?.api_call_attempts_day) || 1),
        api_call_day: submissionState?.api_call_day || localDateKey(apiCallStartedAt, dailyStoreTimeZone),
      };
      const apiCallRecorded = await state.transition(sku, "processing", apiCallState);
      if (apiCallRecorded === false) {
        return {
          ok: false,
          reason: "submission-api-call-reservation-not-acquired",
          not_submitted: true,
        };
      }
      Object.assign(submissionState, apiCallState);
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

  function fatalSupplyAuthenticationError(result) {
    recordMetric("supply_gate.jsonl", {
      status: "global-gate-closed",
      reason: String(result?.reason || result?.error || "1688-login-required"),
      code: result?.reason_code || result?.code || "SUPPLY_GATE_AUTH_REQUIRED",
      alert_required: true,
      supply_gate: result ?? null,
    });
    const error = new Error(
      `1688 supply gate is safely closed because authentication is unavailable: ${String(result?.reason || result?.error || "login required")}`,
    );
    error.code = "SUPPLY_GATE_AUTH_REQUIRED";
    error.supply_gate = result ?? null;
    return error;
  }

  function normalizedSupplyFailureReason(result = {}) {
    const raw = compactText(result?.reason ?? result?.code ?? result?.error) || "unconfirmed";
    if (/captcha|验证码/iu.test(raw)) return "1688-supply-captcha";
    if (/timeout|timed out|超时/iu.test(raw)) return "1688-supply-timeout";
    if (/moq|minimum|起订|起批/iu.test(raw)) return "1688-supply-moq";
    if (/stock|sold.?out|缺货|无货/iu.test(raw)) return "1688-supply-out-of-stock";
    if (/offline|removed|下架|失效|not.?found|404/iu.test(raw)) return "1688-supply-offline";
    if (/spec|variant|型号|颜色|尺寸|容量|规格|套装/iu.test(raw)) return "1688-supply-spec-conflict";
    if (/strict|same.?item|match|同款/iu.test(raw)) return "1688-supply-no-strict-same-item";
    return "1688-supply-unconfirmed";
  }

  async function deferSupplyGate(item, reason, {
    cost = null,
    candidates = [],
    targetVariant = null,
    result = null,
    retryAt = null,
  } = {}) {
    const sku = asSku(item);
    const terminalDecision = deterministicSupplyQueueExitDecision({
      reason,
      result,
      cost,
      candidates,
    });
    if (terminalDecision.eligible && terminalDecision.disposition === "queue-retire") {
      const retiredAt = now().toISOString();
      const nextEligibleAt = new Date(
        now().getTime() + configuredSemanticMissQueueRetireMs,
      ).toISOString();
      const { outcome_status: _discardedOutcomeStatus, ...retireItem } = item || {};
      const retirement = {
        ...retireItem,
        supply_gate_passed: false,
        supply_gate_reason: reason,
        supply_gate_result: result,
        supply_candidates: candidates,
        target_variant: targetVariant,
        cost,
        terminal: false,
        failure_class: "transient",
        retry_at: nextEligibleAt,
        next_eligible_at: nextEligibleAt,
        submitted: false,
        submission_pending: false,
        submission_intent: false,
        query_policy_version: CURRENT_1688_MATCH_POLICY_VERSION,
        semantic_miss_queue_retire: {
          ...terminalDecision,
          retired_at: retiredAt,
          next_eligible_at: nextEligibleAt,
        },
      };
      if (activeValidationOnly) {
        recordMetric("supply_gate.jsonl", {
          sku,
          status: "queue-retire-validation-only",
          reason,
          ...retirement,
        });
        recordMetric("validation_gate.jsonl", {
          sku,
          status: "rejected",
          reason,
          ...retirement,
        });
        return {
          status: "skipped",
          sku,
          source_url: item.source_url ?? null,
          reason,
          terminal: false,
          retry_at: nextEligibleAt,
        };
      }
      const intentState = {
        ...retirement,
        reason: "1688-supply-semantic-miss-retire-intent",
        queue_retire_intent: true,
        favorite_deleted: false,
        queue_retire_intent_at: retiredAt,
      };
      const intentRecorded = await state.transition(sku, "processing", intentState);
      if (intentRecorded === false) {
        return {
          status: "ignored",
          sku,
          source_url: item.source_url ?? null,
          reason: "queue-retire-intent-not-recorded",
        };
      }
      try {
        await client.deleteFavorite(item);
      } catch (error) {
        if (isFatalRunnerError(error)) {
          cancelDirectRun(error);
          throw error;
        }
        const failedRetirement = {
          ...intentState,
          reason: "1688-supply-semantic-miss-delete-failed",
          queue_retire_intent: false,
          error: String(error?.message || error),
        };
        await state.transition(sku, "failed", failedRetirement);
        recordMetric("supply_gate.jsonl", {
          sku,
          status: "queue-retire-delete-failed",
          ...failedRetirement,
        });
        return {
          status: "deferred",
          sku,
          source_url: item.source_url ?? null,
          reason: failedRetirement.reason,
          retry_at: nextEligibleAt,
        };
      }
      const closedRetirement = {
        ...intentState,
        reason: "1688-supply-semantic-miss-retired",
        queue_retire_intent: false,
        favorite_deleted: true,
        favorite_deleted_at: now().toISOString(),
      };
      const recorded = await state.transition(sku, "failed", closedRetirement);
      recordMetric("supply_gate.jsonl", {
        sku,
        status: "queue-retired-nonterminal",
        ...closedRetirement,
      });
      return recorded === false
        ? { status: "ignored", sku, source_url: item.source_url ?? null, reason: "queue-retire-close-not-recorded" }
        : {
            status: "deferred",
            sku,
            source_url: item.source_url ?? null,
            reason: closedRetirement.reason,
            retry_at: nextEligibleAt,
          };
    }
    if (terminalDecision.eligible && terminalDecision.disposition === "terminal-skip") {
      const completedAt = now().toISOString();
      const data = {
        supply_gate_passed: false,
        supply_gate_reason: reason,
        supply_gate_result: result,
        supply_candidates: candidates,
        target_variant: targetVariant,
        cost,
        terminal: true,
        failure_class: "deterministic",
        retry_at: null,
        submitted: false,
        submission_pending: false,
        submission_intent: false,
        deterministic_supply_exit: {
          ...terminalDecision,
          completed_at: completedAt,
        },
        outcome_status: activeDirectMode ? "skipped_cost" : undefined,
      };
      recordMetric("supply_gate.jsonl", {
        sku,
        status: "terminal-deterministic",
        reason,
        ...data,
      });
      if (activeValidationOnly) {
        recordMetric("validation_gate.jsonl", {
          sku,
          status: "rejected",
          reason,
          ...data,
        });
        return {
          status: "skipped",
          sku,
          source_url: item.source_url ?? null,
          reason,
          terminal: true,
        };
      }
      return completeSkipIntent(item, reason, data);
    }
    const parsedRetryAt = Date.parse(String(retryAt || ""));
    const effectiveRetryAt = Number.isFinite(parsedRetryAt) && parsedRetryAt > now().getTime()
      ? new Date(parsedRetryAt).toISOString()
      : new Date(now().getTime() + configuredSupplyGateRetryMs).toISOString();
    const data = {
      supply_gate_passed: false,
      supply_gate_reason: reason,
      supply_gate_result: result,
      supply_candidates: candidates,
      target_variant: targetVariant,
      cost,
      terminal: false,
      failure_class: "transient",
      retry_at: effectiveRetryAt,
      submitted: false,
      submission_pending: false,
      submission_intent: false,
    };
    recordMetric("supply_gate.jsonl", {
      sku,
      status: "deferred",
      reason,
      retry_at: effectiveRetryAt,
      ...data,
    });
    if (activeValidationOnly) {
      recordMetric("validation_gate.jsonl", {
        sku,
        status: "rejected",
        reason,
        ...data,
      });
    } else {
      await state.transition(sku, "failed", {
        ...item,
        ...data,
        reason,
      });
    }
    return {
      status: "deferred",
      sku,
      source_url: item.source_url ?? null,
      reason,
      retry_at: effectiveRetryAt,
    };
  }

  async function deferTransientCandidate(item, reason, {
    error = null,
    backoffMs = 5 * 60_000,
    data = {},
  } = {}) {
    const sku = asSku(item);
    const retryAt = new Date(now().getTime() + Math.max(1, Number(backoffMs) || 0)).toISOString();
    const deferred = {
      ...item,
      ...data,
      reason,
      error: error ? String(error?.message || error) : null,
      terminal: false,
      failure_class: "transient",
      retry_at: retryAt,
      submitted: false,
      submission_pending: false,
      submission_intent: false,
    };
    recordMetric("transient_deferred.jsonl", {
      sku,
      status: "deferred",
      reason,
      retry_at: retryAt,
      error: deferred.error,
    });
    if (!activeValidationOnly) await state.transition(sku, "failed", deferred);
    return {
      status: "deferred",
      sku,
      source_url: item.source_url ?? null,
      reason,
      retry_at: retryAt,
    };
  }

  async function verifyOrderableSupply({
    item,
    cost,
    detail,
    productInfo,
    force = false,
    targetVariant: targetVariantOverride = null,
    searchInput = null,
  }) {
    const targetVariant = targetVariantOverride || supplyTargetVariant({ item, detail, productInfo });
    let currentCost = cost;
    let costFloor = Number(cost?.cost);
    const excludedOfferIds = new Set();
    const searchHistory = [];
    const completedSupplyPolicyFailure = (failure, completionBasis) => ({
      ...failure,
      result: {
        ...(failure?.result || {}),
        supply_policy_version: DETERMINISTIC_SUPPLY_EXIT_POLICY_VERSION,
        supply_policy_completed: true,
        alternative_search_status: "completed",
        alternative_search_completion_basis: completionBasis,
        match_policy_version: currentCost?.match_policy_version ?? null,
        search_executed_live: currentCost?.search_executed_live === true,
      },
    });
    for (let searchRound = 1; searchRound <= SUPPLY_GATE_MAX_SEARCH_ROUNDS; searchRound += 1) {
      const candidates = strict1688SupplyCandidates(currentCost, {
        maximum: configuredSupplyGateMaximumOffers,
      }).filter((candidate) => !excludedOfferIds.has(compactText(candidate?.offer_id)));
      if (!candidates.length) {
        const failure = {
          ok: false,
          reason: "1688-supply-no-strict-same-item",
          candidates,
          targetVariant,
          cost: currentCost,
          costFloor,
          searchHistory,
          result: {
            reason: "no new v3 strong_single or corroborated_multi offer is bound to the signed match evidence",
            excluded_offer_ids: [...excludedOfferIds],
            search_history: searchHistory,
            strict_candidate_count: 0,
            match_policy_version: currentCost?.match_policy_version ?? null,
          },
        };
        return failure;
      }
      let result;
      try {
        result = await timed(
          asSku(item),
          force ? "1688_supply_recheck" : searchRound === 1 ? "1688_supply_gate" : `1688_supply_gate_round_${searchRound}`,
          () => supplyVerifier.verify({
            candidates,
            targetVariant,
            targetTitle: item?.title || detail?.title || productInfo?.title || null,
            itemLevelMatch: targetVariant.required !== true,
            matchEvidenceKey: currentCost.match_evidence_key,
            balancedMatch: {
              passed: currentCost.balanced_match === true,
              match_type: currentCost.balanced_match_type,
              supporting_offer_ids: currentCost.balanced_supporting_offer_ids || [],
            },
            force,
          }),
        );
      } catch (error) {
        if (supplyGateAuthenticationFailure(error)) throw fatalSupplyAuthenticationError(error);
        result = {
          passed: false,
          retryable: true,
          transient: true,
          deterministic: false,
          reason: compactText(error?.message || error) || "supply verifier exception",
        };
      }
      if (supplyGateAuthenticationFailure(result)) throw fatalSupplyAuthenticationError(result);
      const evidence = result?.evidence && typeof result.evidence === "object"
        ? result.evidence
        : result;
      const validity = validateSupplyEvidence(evidence, {
        at: now(),
        matchEvidenceKey: currentCost.match_evidence_key,
        candidates,
        targetVariant,
        envelope: result,
      });
      if (validity.ok) {
        recordMetric("supply_gate.jsonl", {
          sku: asSku(item),
          title: compactText(item?.title || detail?.title || productInfo?.title),
          ozon_image_url: compactText(item?.cover_image || detail?.cover_image || productInfo?.cover_image),
          status: "passed",
          offer_id: evidence.offer_id,
          offer_url: evidence.offer_url,
          target_variant: evidence.target_variant ?? targetVariant,
          variant_attributes: evidence.variant_attributes ?? null,
          variant_match_mode: evidence.variant_match_mode || "exact",
          match_basis: evidence.match_basis || "exact_variant",
          image_score: Number(evidence?.image_match_evidence?.image?.score) || null,
          image_lane: evidence?.image_match_evidence?.lane || null,
          variant_differences: evidence.variant_differences || [],
          selected_variant: evidence.selected_variant || null,
          moq: Number(evidence.moq),
          orderable_quantity: Number(evidence.orderable_quantity),
          unit_price: Number(evidence.unit_price),
          checked_at: evidence.checked_at,
          valid_until: evidence.valid_until,
          match_evidence_key: evidence.match_evidence_key,
          search_round: searchRound,
          excluded_offer_ids: [...excludedOfferIds],
          purchase_price_cost_floor: costFloor,
        });
        return {
          ok: true,
          evidence,
          candidates,
          targetVariant,
          result,
          cost: currentCost,
          costFloor,
          searchHistory,
        };
      }
      const failureResult = {
        ok: false,
        reason: normalizedSupplyFailureReason({
          ...result,
          reason: result?.reason || validity.reason,
        }),
        candidates,
        targetVariant,
        cost: currentCost,
        costFloor,
        searchHistory,
        result: {
          ...result,
          search_round: searchRound,
          excluded_offer_ids: [...excludedOfferIds],
          search_history: searchHistory,
        },
      };
      const failedOfferIds = deterministicSupplyResearchOfferIds(result, candidates);
      if (force || !searchInput || failedOfferIds.length !== candidates.length) return failureResult;
      if (searchRound >= SUPPLY_GATE_MAX_SEARCH_ROUNDS) {
        return completedSupplyPolicyFailure(failureResult, "maximum-alternative-search-rounds-exhausted");
      }
      for (const offerId of failedOfferIds) excludedOfferIds.add(offerId);
      const researchRecord = {
        failed_search_round: searchRound,
        failed_offer_ids: failedOfferIds,
        excluded_offer_ids: [...excludedOfferIds],
        candidate_failures: coveredFinalSupplyFailures(result, candidates) || [],
        failure_codes: Array.isArray(result?.candidate_failures) && result.candidate_failures.length
          ? result.candidate_failures.map((failure) => failure.reason_code)
          : [result?.reason_code].filter(Boolean),
        match_policy_version: currentCost?.match_policy_version ?? null,
        search_executed_live: currentCost?.search_executed_live === true,
        prior_cost: Number(currentCost.cost),
        prior_match_evidence_key: currentCost.match_evidence_key,
      };
      searchHistory.push(researchRecord);
      recordMetric("supply_gate.jsonl", {
        sku: asSku(item),
        status: "alternative-search-started",
        ...researchRecord,
      });
      let replacementCost;
      try {
        replacementCost = await timed(asSku(item), `1688_cost_supply_research_${searchRound + 1}`, () => costGate.run(
          () => boundedCostEstimate(() => costBridge.estimate({
            ...searchInput,
            excluded_1688_offer_ids: [...excludedOfferIds],
          }, runDir)),
          { lane: "continuation" },
        ));
      } catch (error) {
        if (isFatalRunnerError(error) || supplyGateAuthenticationFailure(error)) throw error;
        return {
          ...failureResult,
          reason: "1688-supply-unconfirmed",
          result: {
            ...failureResult.result,
            retryable: true,
            transient: true,
            deterministic: false,
            reason: compactText(error?.message || error) || "alternative 1688 sourcing failed",
          },
        };
      }
      if (supplyGateAuthenticationFailure(replacementCost)) {
        throw fatalSupplyAuthenticationError(replacementCost);
      }
      if (!replacementCost?.ok || !(Number(replacementCost?.cost) > 0)) {
        const failure = {
          ...failureResult,
          reason: replacementCost?.deferred === true || replacementCost?.terminal === false
            ? normalizeCostFailureReason(replacementCost)
            : "1688-supply-no-strict-same-item",
          result: {
            ...failureResult.result,
            replacement_cost: replacementCost,
            reason: replacementCost?.reason || "no strict alternative 1688 offer was found",
          },
        };
        return failure;
      }
      const replacementCostEvidence = publicationCostEvidence(replacementCost, {
        requireContract: requireReliableCostContract,
        minimumMatches: requiredSameItemMatches,
      });
      const replacementCandidates = strict1688SupplyCandidates(replacementCost, {
        maximum: configuredSupplyGateMaximumOffers,
      }).filter((candidate) => !excludedOfferIds.has(compactText(candidate?.offer_id)));
      if (replacementCostEvidence.cost_verified !== true || !replacementCandidates.length) {
        const failure = {
          ...failureResult,
          reason: "1688-supply-no-strict-same-item",
          candidates: replacementCandidates,
          cost: replacementCost,
          costFloor: Math.max(costFloor, Number(replacementCost.cost)),
          result: {
            ...failureResult.result,
            replacement_cost: replacementCost,
            reason: replacementCostEvidence.cost_verified !== true
              ? "alternative cost lacks the required reliable same-item evidence"
              : "alternative signed evidence only returned already-failed 1688 offers",
          },
        };
        return failure;
      }
      costFloor = Math.max(costFloor, Number(replacementCost.cost));
      currentCost = replacementCost;
    }
    throw new Error("unreachable supply gate search loop");
  }

  async function abandonPreCallSubmissionIntent(item, {
    reason = "submission-pre-call-intent-revalidation-required",
    finalResult = null,
  } = {}) {
    const sku = asSku(item);
    if (String(item?.api_call_started_at || "").trim()) {
      return {
        status: "ignored",
        sku,
        source_url: item?.source_url ?? null,
        reason: "submission-api-status-unknown",
      };
    }
    const retryAt = new Date(now().getTime() + configuredSupplyGateRetryMs).toISOString();
    const resetState = {
      ...item,
      reason: "submission-not-sent-deferred",
      original_reason: reason,
      submission_intent: false,
      submitted: false,
      submission_pending: false,
      reconcile_only: false,
      previous_api_call_started_at: null,
      api_call_started_at: null,
      api_call_completed_at: null,
      next_reconcile_at: null,
      submission_payload: null,
      profit_recheck_context: null,
      supply_gate_passed: false,
      supply_evidence: null,
      supply_candidates: [],
      target_variant: null,
      retry_at: retryAt,
      terminal: false,
      failure_class: "transient",
      pre_call_intent_reset_at: now().toISOString(),
      fresh_pipeline_required: true,
      final_result: finalResult,
    };
    if (typeof state.abandonPreCallSubmissionIntent === "function") {
      const expectedOwnerId = String(item?.submission_owner_id || "").trim();
      const expectedGenerationId = String(item?.submission_generation_id || "").trim();
      if (!expectedOwnerId || !expectedGenerationId) {
        return {
          status: "ignored",
          sku,
          source_url: item?.source_url ?? null,
          reason: "submission-pre-call-identity-missing",
        };
      }
      const abandoned = await state.abandonPreCallSubmissionIntent(sku, {
        reason: "submission-not-sent-deferred",
        nextEligibleAt: retryAt,
        expectedOwnerId,
        expectedGenerationId,
        data: resetState,
      });
      if (!abandoned?.recorded) {
        const activeLease = abandoned?.reason === "submission-reservation-lease-active";
        return {
          status: "ignored",
          sku,
          source_url: item?.source_url ?? null,
          reason: abandoned?.reason || "submission-pre-call-abandon-conflict",
          ...(activeLease && abandoned?.reservation?.leaseExpiresAt
            ? { retry_at: abandoned.reservation.leaseExpiresAt }
            : {}),
        };
      }
      return {
        status: "deferred",
        sku,
        source_url: item?.source_url ?? null,
        reason: "submission-not-sent-deferred",
        retry_at: retryAt,
      };
    }
    const recorded = await state.transition(sku, "failed", resetState);
    if (recorded === false) {
      const error = new Error(`pre-call submission reset could not be persisted for SKU ${sku}`);
      error.code = "SUBMISSION_RESET_PERSIST_FAILED";
      error.sku = sku;
      throw error;
    }
    return {
      status: "deferred",
      sku,
      source_url: item?.source_url ?? null,
      reason: "submission-not-sent-deferred",
      retry_at: retryAt,
    };
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
      recordMetric("direct_funnel.jsonl", {
        sku,
        stage: "erp_accepted",
        source_url: submissionState.source_url ?? submissionState.seller_url ?? null,
        store_id: Number(submissionState.store_id),
        outcome_status: "submitted",
      });
      await projectErpAccepted({
        sku,
        store_id: Number(submissionState.store_id),
        accepted_at: acceptedAt,
        offer_id: submissionState.offer_id,
      });
      return {
        status: "submitted",
        accepted: true,
        sku,
        source_url: item?.source_url ?? submissionState.source_url ?? null,
        reason: "erp-submission-accepted",
      };
    }
    if (finalResult?.not_submitted === true && finalResult?.reset_pre_call_intent === true) {
      return abandonPreCallSubmissionIntent(submissionState, {
        reason: finalResult?.reason || "submission-profit-context-invalid",
        finalResult,
      });
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
      const supplyRetry = /^1688-supply-/u.test(reason) || Boolean(finalResult?.supply_gate);
      const retryAt = new Date(
        now().getTime() + (supplyRetry ? configuredSupplyGateRetryMs : 0),
      ).toISOString();
      const recorded = await state.transition(sku, "failed", {
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
      if (recorded === false) {
        const error = new Error(`deferred submission state could not be persisted for SKU ${sku}`);
        error.code = "SUBMISSION_RESET_PERSIST_FAILED";
        error.sku = sku;
        throw error;
      }
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
      let supplyEvidence = null;
      let supplyCandidates = [];
      let supplyTarget = null;
      let effectivePurchasePrice = null;
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
            thresholdGrams: Number(targetConfig.weightThresholdGrams || 400),
            routeReason: "postal-default",
          };
          return shippingRoute;
        }
        shippingRoute = selectShippingRoute({
          weightGrams,
          postalWarehouseId: targetConfig.postalWarehouseId || targetConfig.warehouseId,
          uralWarehouseId: targetConfig.uralWarehouseId,
          thresholdGrams: targetConfig.weightThresholdGrams,
          weightRouting: targetConfig.weightRouting === true,
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

        if (activeValidationSupplyOnly) {
          detail = {
            ...item,
            title: snapshotTitle,
            cover_image: snapshotImage,
            current_price: Number(salePrice),
            snapshot_price_used: true,
          };
          category = { mapped: [], labels: [] };
        } else {
          categoryData = await timed(sku, "erp_category_and_specs", () => client.getCategoryBySku(sku));
          if (activeValidationCommissionSeed) {
            const expected = activeValidationCommissionSeed.categoryForSku(sku)?.expected_category_hierarchy;
            const observed = Array.isArray(categoryData?.cate) ? categoryData.cate.slice(0, 2) : [];
            const matches = Array.isArray(expected)
              && expected.length === 2
              && observed.length >= 2
              && expected.every((value, index) => String(value) === String(observed[index]));
            if (!matches) {
              const error = new Error(
                `live category for SKU ${sku} differs from the bound snapshot commission seed`,
              );
              error.code = "VALIDATION_COMMISSION_SEED_CATEGORY_MISMATCH";
              error.expected_category = Array.isArray(expected) ? [...expected] : null;
              error.observed_category = observed;
              throw error;
            }
          }
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
        }
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
      const validationReplayRequest = activeValidationSupplyOnly
        ? validationSignedEvidenceReplay?.requestFor?.(item) || null
        : null;
      const costEstimateInput = {
        ...detail,
        sell_price: salePrice,
        expect_title: detail?.title ?? item?.title ?? "",
        expect_model: validationReplayRequest?.expect_model ?? costModel ?? "",
        expect_category: validationReplayRequest?.expect_category
          ?? (category?.labels || []).slice(0, 2).join(" "),
      };
      let cost = await timed(sku, "1688_cost", () => costGate.run(
        () => boundedCostEstimate(() => costBridge.estimate(costEstimateInput, runDir)),
        { lane: "normal" },
      ));
      if (!cost?.ok && cost?.deferred === true && cost?.terminal === false) {
        const deferredReason = cost?.health?.circuit === "open"
          ? "1688-health-deferred"
          : normalizeCostFailureReason(cost);
        return deferSupplyGate(item, deferredReason, {
          cost,
          result: cost,
          targetVariant: supplyTargetVariant({ item, detail, productInfo }),
          retryAt: cost?.retry_at,
        });
      }
      if (!cost?.ok || !(Number(cost?.cost) > 0)) {
        return deferSupplyGate(item, normalizeCostFailureReason(cost), {
          cost,
          result: cost,
          targetVariant: supplyTargetVariant({ item, detail, productInfo }),
        });
      }
      let costEvidence = publicationCostEvidence(cost, {
        requireContract: requireReliableCostContract,
        minimumMatches: requiredSameItemMatches,
      });
      if (requireReliableCostContract && costEvidence.cost_verified !== true) {
        return deferSupplyGate(item, "1688-same-item-evidence-missing", {
          cost,
          result: { cost_evidence: costEvidence.cost_evidence },
          targetVariant: supplyTargetVariant({ item, detail, productInfo }),
        });
      }
      if (requireSupplyGate && strict1688SupplyCandidates(cost, {
        maximum: configuredSupplyGateMaximumOffers,
      }).length === 0) {
        return deferSupplyGate(item, "1688-supply-no-strict-same-item", {
          cost,
          candidates: [],
          targetVariant: supplyTargetVariant({ item, detail, productInfo }),
          result: {
            balanced_match: cost?.balanced_match ?? null,
            balanced_match_type: cost?.balanced_match_type ?? null,
            match_evidence_contract: cost?.match_evidence_contract ?? null,
            match_policy_version: cost?.match_policy_version ?? null,
            strict_candidate_count: 0,
            supply_policy_completed: false,
            alternative_search_status: "unresolved",
          },
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
        if (activeValidationSupplyOnly) {
          recordMetric("direct_funnel.jsonl", {
            sku,
            stage: "validation_supply_only_snapshot_used",
            source_url: item.source_url ?? item.seller_url ?? null,
            sale_price: Number(salePrice),
            title: normalizedContentText(item?.title),
            cover_image: normalizedContentText(item?.cover_image),
          });
        } else if (activeValidationSnapshotPrice) {
          const snapshotTitle = normalizedContentText(item?.title);
          const snapshotImage = normalizedContentText(item?.cover_image);
          const snapshotSalePrice = Number(item?.sell_price);
          if (!snapshotTitle || !validHttpImageUrl(snapshotImage) || !(snapshotSalePrice > 0)) {
            return skip(item, "invalid-validation-snapshot", { outcome_status: "rejected" });
          }
          salePrice = snapshotSalePrice;
          detailResult = {
            title: snapshotTitle,
            cover_image: snapshotImage,
            current_price: snapshotSalePrice,
            snapshot_price_used: true,
          };
          firstDetail = { ...item, ...detailResult };
          observedMode = item.mode || item.shipping_mode || null;
          detail = {
            ...firstDetail,
            mode: observedMode,
            shipping_mode: item.shipping_mode || observedMode,
          };
          category = mapOzonCategory(
            categoryData?.cate,
            targetConfig.commissionTree,
            salePrice,
            cnyRubRate,
          );
          fbsEvidence = {
            verified: null,
            rule: "validation-only candidate snapshot; live Ozon detail was intentionally not requested",
            observations: [{
              observed_at: now().toISOString(),
              mode: observedMode,
              detail_url: item.detail_url || item.link || null,
              snapshot_price_used: true,
            }],
          };
          recordMetric("direct_funnel.jsonl", {
            sku,
            stage: "validation_snapshot_price_used",
            source_url: item.source_url ?? item.seller_url ?? null,
            sale_price: snapshotSalePrice,
            title: snapshotTitle,
            cover_image: snapshotImage,
            category: category.mapped,
          });
        } else {
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
      }

      let purchasePriceOriginalP70P80 = Number(cost.cost);
      effectivePurchasePrice = purchasePriceOriginalP70P80;
      if (requireSupplyGate) {
        const supply = await verifyOrderableSupply({
          item,
          cost,
          detail,
          productInfo,
          searchInput: costEstimateInput,
        });
        if (!supply.ok) {
          return deferSupplyGate(item, supply.reason, {
            cost: supply.cost || cost,
            candidates: supply.candidates,
            targetVariant: supply.targetVariant,
            result: supply.result,
          });
        }
        cost = supply.cost || cost;
        purchasePriceOriginalP70P80 = Math.max(
          purchasePriceOriginalP70P80,
          Number(supply.costFloor),
          Number(cost.cost),
        );
        costEvidence = publicationCostEvidence(cost, {
          requireContract: requireReliableCostContract,
          minimumMatches: requiredSameItemMatches,
        });
        if (costEvidence.cost_verified !== true) {
          return deferSupplyGate(item, "1688-same-item-evidence-missing", {
            cost,
            candidates: supply.candidates,
            targetVariant: supply.targetVariant,
            result: { cost_evidence: costEvidence.cost_evidence },
          });
        }
        supplyEvidence = supply.evidence;
        supplyCandidates = supply.candidates;
        supplyTarget = supply.targetVariant;
        effectivePurchasePrice = Math.max(
          purchasePriceOriginalP70P80,
          Number(supplyEvidence.unit_price),
        );
        if (activeDirectMode) {
          recordMetric("direct_funnel.jsonl", {
            sku,
            stage: "supply_gate_passed",
            source_url: item.source_url ?? item.seller_url ?? null,
            offer_id: supplyEvidence.offer_id,
            offer_url: supplyEvidence.offer_url,
            target_variant: supplyEvidence.target_variant ?? supplyTarget,
            purchase_price_original: purchasePriceOriginalP70P80,
            purchase_price_current_round_p70_p80: Number(cost.cost),
            purchase_price_live_one_piece: Number(supplyEvidence.unit_price),
            purchase_price_effective: effectivePurchasePrice,
          });
        }
      }

      if (activeValidationSupplyOnly) {
        const evidenceValidity = validateSupplyEvidence(supplyEvidence, {
          at: now(),
          matchEvidenceKey: cost.match_evidence_key,
          candidates: supplyCandidates,
          targetVariant: supplyTarget,
        });
        if (!evidenceValidity.ok) {
          return deferSupplyGate(item, `1688-supply-evidence-${evidenceValidity.reason}`, {
            cost,
            candidates: supplyCandidates,
            targetVariant: supplyTarget,
            result: { supply_evidence: supplyEvidence },
          });
        }
        const supplyValidatedAt = now().toISOString();
        recordMetric("validation_gate.jsonl", {
          sku,
          status: "supply_validated_pending_profit",
          reason: "profit-validation-pending",
          title: normalizedContentText(item?.title),
          cover_image: normalizedContentText(item?.cover_image),
          sale_price_snapshot: Number(salePrice),
          purchase_price: Number(effectivePurchasePrice),
          purchase_price_original_p70_p80: Number(purchasePriceOriginalP70P80),
          purchase_price_live_one_piece: Number(supplyEvidence?.unit_price),
          cost,
          cost_verified: costEvidence.cost_verified,
          cost_source: costEvidence.cost_source,
          cost_evidence: costEvidence.cost_evidence,
          supply_gate_passed: true,
          supply_evidence_type: "SupplyEvidenceV1",
          supply_evidence: supplyEvidence,
          supply_candidates: supplyCandidates,
          target_variant: supplyTarget,
          profit_validation_pending: true,
          full_validation_passed: false,
          snapshot_price_used: true,
          validation_mode: "supply-only",
          supply_validated_at: supplyValidatedAt,
        });
        recordMetric("direct_funnel.jsonl", {
          sku,
          stage: "supply_validated_pending_profit",
          offer_id: supplyEvidence.offer_id,
          offer_url: supplyEvidence.offer_url,
          purchase_price_effective: Number(effectivePurchasePrice),
          checked_at: supplyEvidence.checked_at,
          valid_until: supplyEvidence.valid_until,
        });
        await metricsChain;
        return {
          status: "supply_validated_pending_profit",
          sku,
          source_url: item.source_url ?? null,
          reason: "profit-validation-pending",
        };
      }

      let calc;
      try {
        applyShippingRoute();
        calc = await timed(sku, "profit_calculation", () => client.calculateProfit(profitCalculationInput({
          sku,
          salePrice,
          purchasePrice: effectivePurchasePrice,
          productInfo,
          detail,
          category,
          profitThreshold,
          logistics: shippingRoute.logistics,
        })));
      } catch (error) {
        if (isFatalRunnerError(error)) throw error;
        if (!activeDirectMode) throw error;
        return deferTransientCandidate(item, "profit-calculation-deferred", {
          error,
          data: { outcome_status: "deferred_profit" },
        });
      }
      const calculatedCnyRubRate = plausibleCnyRubRate(calc?.cnyrub_rate);
      if (calculatedCnyRubRate !== null) {
        cnyRubRate = calculatedCnyRubRate;
        cnyRubRateConfirmed = true;
      }
      let economy = economyResult(calc, shippingRoute.logistics);
      if (!economy?.price_list || typeof economy.price_list !== "object") {
        if (activeDirectMode) {
          return deferTransientCandidate(item, "profit-calculation-response-deferred", {
            data: { outcome_status: "deferred_profit" },
          });
        }
        return skip(item, "missing-supported-economy", {
          outcome_status: activeDirectMode ? "skipped_profit" : undefined,
        });
      }
      if (requireSupplyGate || activeDirectMode) {
        const quoteValidity = profitQuoteValidation(
          economy.price_list,
          effectivePurchasePrice,
          requireSupplyGate ? {
            expectedSalePrice: salePrice,
            expectedLogistics: shippingRoute.logistics,
            expectedCategory: category.mapped,
            expectedPackageWeight: resolvedPackageWeight(productInfo, detail),
          } : {},
        );
        if (!quoteValidity.ok) {
          if (requireSupplyGate) {
            return deferSupplyGate(item, `1688-supply-profit-quote-${quoteValidity.reason}`, {
              cost,
              candidates: supplyCandidates,
              targetVariant: supplyTarget,
              result: {
                quote_validation: quoteValidity,
                supply_evidence: supplyEvidence,
              },
            });
          }
          return deferTransientCandidate(item, "profit-calculation-response-deferred", {
            data: {
              outcome_status: "deferred_profit",
              quote_validation: quoteValidity,
            },
          });
        }
      }
      const preflightReason = activeDirectMode
        ? null
        : policy.preflightSkipReason({ ...detail, economy });
      if (preflightReason) return skip(item, preflightReason);

      let profit = {
        ...economy.price_list,
        purchase_price: effectivePurchasePrice,
        sell_price: economy.price_list.sell_price ?? salePrice,
      };
      const profitReason = policy.profitSkipReason(profit, profitThreshold);
      if (profitReason) {
        return skip(item, profitReason, {
          profit,
          outcome_status: activeDirectMode ? "skipped_profit" : undefined,
        });
      }
      const effectiveProfitFloor = activeValidationSnapshotPrice
        ? Math.max(30, profitThreshold)
        : activeDirectMode
          ? profitThreshold
          : Math.max(30, profitThreshold);
      if (!(Number(profit.profit_rate) > effectiveProfitFloor)) {
        return skip(item, `profit_rate<=${effectiveProfitFloor}`, {
          profit,
          outcome_status: activeDirectMode ? "skipped_profit" : undefined,
        });
      }
      let profitSafetyShadow = assessProfitSafety({
        profit,
        cost: { ...cost, cost: effectivePurchasePrice },
        packageEvidence: {
          weight: productInfo.weight ?? detail.weight,
          length: productInfo.depth ?? productInfo.length ?? detail.depth ?? detail.length,
          width: productInfo.width ?? detail.width,
          height: productInfo.height ?? detail.height,
        },
      });
      let profitSafetyGate = assessProfitSafetyGate({
        profitSafety: profitSafetyShadow,
        cost: { ...cost, cost: effectivePurchasePrice },
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

      if (requireSupplyGate) {
        const freshness = validateSupplyEvidence(supplyEvidence, {
          at: now(),
          matchEvidenceKey: cost.match_evidence_key,
          candidates: supplyCandidates,
          targetVariant: supplyTarget,
        });
        if (!freshness.ok) {
          const refreshed = await verifyOrderableSupply({
            item,
            cost,
            detail,
            productInfo,
            force: true,
          });
          if (!refreshed.ok) {
            return deferSupplyGate(item, refreshed.reason, {
              cost,
              candidates: refreshed.candidates,
              targetVariant: refreshed.targetVariant,
              result: refreshed.result,
            });
          }
          const refreshedPurchasePrice = Math.max(
            purchasePriceOriginalP70P80,
            Number(refreshed.evidence.unit_price),
          );
          if (Math.abs(refreshedPurchasePrice - effectivePurchasePrice) > 0.000001) {
            let refreshedCalc;
            try {
              refreshedCalc = await timed(sku, "profit_calculation_supply_reprice", () => client.calculateProfit(profitCalculationInput({
                sku,
                salePrice,
                purchasePrice: refreshedPurchasePrice,
                productInfo,
                detail,
                category,
                profitThreshold,
                logistics: shippingRoute.logistics,
              })));
            } catch (error) {
              if (isFatalRunnerError(error)) throw error;
              return deferSupplyGate(item, "1688-supply-reprice-calculation-failed", {
                cost,
                candidates: refreshed.candidates,
                targetVariant: refreshed.targetVariant,
                result: {
                  error: String(error?.message || error),
                  refreshed_effective_price: refreshedPurchasePrice,
                  supply_evidence: refreshed.evidence,
                },
              });
            }
            const refreshedEconomy = economyResult(refreshedCalc, shippingRoute.logistics);
            if (!refreshedEconomy?.price_list || typeof refreshedEconomy.price_list !== "object") {
              if (activeDirectMode) {
                return deferSupplyGate(item, "1688-supply-reprice-economy-missing", {
                  cost,
                  candidates: refreshed.candidates,
                  targetVariant: refreshed.targetVariant,
                  result: { supply_evidence: refreshed.evidence },
                });
              }
              return skip(item, "missing-supported-economy", {
                outcome_status: activeDirectMode ? "skipped_profit" : undefined,
              });
            }
            const refreshedQuoteValidity = profitQuoteValidation(
              refreshedEconomy.price_list,
              refreshedPurchasePrice,
              {
                expectedSalePrice: salePrice,
                expectedLogistics: shippingRoute.logistics,
                expectedCategory: category.mapped,
                expectedPackageWeight: resolvedPackageWeight(productInfo, detail),
              },
            );
            if (!refreshedQuoteValidity.ok) {
              return deferSupplyGate(item, `1688-supply-profit-quote-${refreshedQuoteValidity.reason}`, {
                cost,
                candidates: refreshed.candidates,
                targetVariant: refreshed.targetVariant,
                result: {
                  quote_validation: refreshedQuoteValidity,
                  supply_evidence: refreshed.evidence,
                },
              });
            }
            const refreshedPreflightReason = activeDirectMode
              ? null
              : policy.preflightSkipReason({ ...detail, economy: refreshedEconomy });
            if (refreshedPreflightReason) return skip(item, refreshedPreflightReason);
            const refreshedProfit = {
              ...refreshedEconomy.price_list,
              purchase_price: refreshedPurchasePrice,
              sell_price: refreshedEconomy.price_list.sell_price ?? salePrice,
            };
            const refreshedProfitReason = policy.profitSkipReason(refreshedProfit, profitThreshold);
            if (refreshedProfitReason || !(Number(refreshedProfit.profit_rate) > effectiveProfitFloor)) {
              return skip(item, refreshedProfitReason || `profit_rate<=${effectiveProfitFloor}`, {
                profit: refreshedProfit,
                supply_evidence: refreshed.evidence,
                outcome_status: activeDirectMode ? "skipped_profit" : undefined,
              });
            }
            const refreshedProfitSafetyShadow = assessProfitSafety({
              profit: refreshedProfit,
              cost: { ...cost, cost: refreshedPurchasePrice },
              packageEvidence: {
                weight: productInfo.weight ?? detail.weight,
                length: productInfo.depth ?? productInfo.length ?? detail.depth ?? detail.length,
                width: productInfo.width ?? detail.width,
                height: productInfo.height ?? detail.height,
              },
            });
            const refreshedProfitSafetyGate = assessProfitSafetyGate({
              profitSafety: refreshedProfitSafetyShadow,
              cost: { ...cost, cost: refreshedPurchasePrice },
              policy: configuredProfitSafetyActionPolicy,
              directMode: activeDirectMode,
            });
            if (refreshedProfitSafetyGate.enforced === true) {
              return skip(item, "profit-safety-nonpositive-stressed-profit", {
                profit: refreshedProfit,
                supply_evidence: refreshed.evidence,
                profit_safety_shadow: refreshedProfitSafetyShadow,
                profit_safety_gate: refreshedProfitSafetyGate,
                outcome_status: "skipped_profit",
              });
            }
            effectivePurchasePrice = refreshedPurchasePrice;
            economy = refreshedEconomy;
            profit = refreshedProfit;
            profitSafetyShadow = refreshedProfitSafetyShadow;
            profitSafetyGate = refreshedProfitSafetyGate;
            recordMetric("supply_gate.jsonl", {
              sku,
              status: "profit-recalculated",
              previous_effective_price: effectivePurchasePrice,
              refreshed_effective_price: refreshedPurchasePrice,
              profit_rate: Number(refreshedProfit.profit_rate),
              offer_id: refreshed.evidence.offer_id,
              checked_at: refreshed.evidence.checked_at,
            });
          }
          supplyEvidence = refreshed.evidence;
          supplyCandidates = refreshed.candidates;
          supplyTarget = refreshed.targetVariant;
        }
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
        shipping_route_reason: shippingRoute.routeReason,
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
        supply_gate_passed: requireSupplyGate ? true : null,
        supply_evidence: supplyEvidence,
        supply_candidates: requireSupplyGate ? supplyCandidates : [],
        target_variant: requireSupplyGate ? supplyTarget : null,
        purchase_price_original_p70_p80: purchasePriceOriginalP70P80,
        purchase_price_live_one_piece: requireSupplyGate
          ? Number(supplyEvidence?.unit_price)
          : null,
        profit_recheck_context: requireSupplyGate ? createProfitRecheckContext({
          sale_price: Number(salePrice),
          product_info: {
            weight: productInfo.weight ?? null,
            depth: productInfo.depth ?? null,
            length: productInfo.length ?? null,
            width: productInfo.width ?? null,
            height: productInfo.height ?? null,
          },
          detail_package: {
            weight: detail.weight ?? null,
            depth: detail.depth ?? null,
            length: detail.length ?? null,
            width: detail.width ?? null,
            height: detail.height ?? null,
          },
          package_evidence: {
            weight: productInfo.weight ?? detail.weight ?? null,
            length: productInfo.depth ?? productInfo.length ?? detail.depth ?? detail.length ?? null,
            width: productInfo.width ?? detail.width ?? null,
            height: productInfo.height ?? detail.height ?? null,
          },
          category_mapped: category.mapped,
          profit_threshold: Number(profitThreshold),
          effective_profit_floor: Number(effectiveProfitFloor),
          logistics: shippingRoute.logistics,
        }, preparedAt) : null,
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
        supply_orderable_quantity_one: requireSupplyGate
          ? validateSupplyEvidence(supplyEvidence, {
            at: now(),
            matchEvidenceKey: cost.match_evidence_key,
            candidates: supplyCandidates,
            targetVariant: supplyTarget,
          }).ok
          : null,
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
        purchase_price_original_p70_p80: submissionState.purchase_price_original_p70_p80,
        purchase_price_live_one_piece: submissionState.purchase_price_live_one_piece,
        profit_rate: submissionState.profit_rate,
        store_id: submissionState.store_id,
        watermark_id: submissionState.watermark_id,
        cost,
        cost_verified: costEvidence.cost_verified,
        cost_source: costEvidence.cost_source,
        cost_evidence: costEvidence.cost_evidence,
        supply_gate_passed: submissionState.supply_gate_passed,
        supply_evidence: submissionState.supply_evidence,
        profit_safety_shadow: profitSafetyShadow,
        profit_safety_gate: profitSafetyGate,
        fbs_evidence: fbsEvidence,
        quality_gate_passed: true,
        quality_checks: submissionState.quality_checks,
        quality_evidence: submissionState.content_quality_evidence,
        snapshot_price_used: activeValidationSnapshotPrice,
        validated_at: now().toISOString(),
        validation_mode: activeValidationSnapshotPrice
          ? "buffer-snapshot-price"
          : activeValidationOnly
            ? "buffer"
            : "live-pre-submit",
      });
      if (activeValidationOnly) {
        await metricsChain;
        return { status: "validated", sku, source_url: item.source_url ?? null };
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
      if (typeof state.recordSelected === "function") {
        await state.recordSelected(submissionState);
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
      const apiCallState = {
        ...submissionState,
        api_call_attempts_total: 1,
        api_call_attempts_day: 1,
        api_call_day: localDateKey(now(), dailyStoreTimeZone),
      };
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

  function reconciliationStartIso(item) {
    const startedAt = reconciliationStartedAtMs(item);
    return new Date(startedAt ?? now().getTime()).toISOString();
  }

  async function terminalizeDirectReconciliation(item, reconciliationTarget, {
    reason,
    attempts = Math.max(0, Number(item?.reconcile_attempts) || 0),
    importLog = item?.import_log || null,
    finalResult = item?.final_result || null,
  }) {
    const sku = asSku(item);
    const currentEntry = state.entryOf?.(sku);
    if (isDurableReconciliationFinal(currentEntry)) {
      return { status: "ignored", sku, reason: "background-final-already-recorded" };
    }
    const recorded = await state.transition(sku, "failed", {
      ...item,
      reason,
      original_reason: String(item?.reason || "").trim() || null,
      import_log: importLog,
      final_result: finalResult,
      store_id: Number(reconciliationTarget.store.id),
      store_name: reconciliationTarget.store.name ?? reconciliationTarget.store.title ?? item.store_name ?? "",
      reconcile_attempts: Math.max(0, Number(attempts) || 0),
      reconciliation_started_at: reconciliationStartIso(item),
      reconciliation_expired_at: now().toISOString(),
      reconcile_only: false,
      next_reconcile_at: null,
      retry_at: null,
      terminal: true,
      failure_class: "deterministic",
      outcome_status: "indeterminate",
      background_status: {
        imported: Boolean(importLog),
        online: false,
        stock_updated: false,
        rejected: false,
        expired: true,
      },
      reconciled_at: now().toISOString(),
    });
    if (recorded === false) {
      return { status: "ignored", sku, reason: "background-final-already-recorded" };
    }
    recordMetric("background_status.jsonl", {
      sku,
      stage: "expired",
      store_id: Number(reconciliationTarget.store.id),
      imported: Boolean(importLog),
      online: false,
      stock_updated: false,
      rejected: false,
      expired: true,
      reason,
    });
    return { status: "ignored", sku, reason };
  }

  async function scheduleReconciliationRetry(item, reconciliationTarget, {
    reason,
    error = null,
    attempts = Math.max(0, Number(item?.reconcile_attempts) || 0) + 1,
    importLog = item?.import_log || null,
    finalResult = item?.final_result || null,
  }) {
    const sku = asSku(item);
    const normalizedAttempts = Math.max(0, Number(attempts) || 0);
    const expiryReason = reconciliationExpiryReason(item, {
      attempts: normalizedAttempts,
      nowMs: now().getTime(),
      maxAttempts: configuredReconciliationMaxAttempts,
      maxAgeMs: configuredReconciliationMaxAgeMs,
    });
    if (expiryReason) {
      return terminalizeDirectReconciliation(item, reconciliationTarget, {
        reason: expiryReason,
        attempts: normalizedAttempts,
        importLog,
        finalResult,
      });
    }
    const nextReconcileAt = new Date(
      now().getTime() + reconciliationBackoffMs(normalizedAttempts),
    ).toISOString();
    const recorded = await state.transition(sku, "processing", {
      ...item,
      reason,
      ...(error ? {
        reconciliation_error: String(error?.message || error),
        reconciliation_error_at: now().toISOString(),
      } : {}),
      import_log: importLog,
      final_result: finalResult,
      reconcile_only: true,
      reconcile_attempts: normalizedAttempts,
      reconciliation_started_at: reconciliationStartIso(item),
      next_reconcile_at: nextReconcileAt,
    });
    return {
      status: "ignored",
      sku,
      source_url: item.source_url ?? null,
      reason: recorded === false ? "reconciliation-state-not-recorded" : reason,
      retry_at: nextReconcileAt,
    };
  }

  async function recoverSubmissionIntent(item, targetConfig, batchControl = null) {
    const sku = asSku(item);
    const payload = item?.submission_payload;
    const offerId = String(item?.offer_id || payload?.rows?.[0]?.offer_id || "").trim();
    const apiCallStarted = String(item?.api_call_started_at || "").trim();
    const leaseExpiresAt = Date.parse(String(item?.submission_lease_expires_at || ""));
    if (
      reconciliationOnly
      && !apiCallStarted
      && Number.isFinite(leaseExpiresAt)
      && leaseExpiresAt > now().getTime()
    ) {
      return {
        status: "ignored",
        sku,
        source_url: item?.source_url ?? null,
        reason: "submission-pre-call-lease-active",
        retry_at: new Date(leaseExpiresAt).toISOString(),
      };
    }
    const currentReconcileAttempts = Math.max(0, Number(item.reconcile_attempts) || 0);
    const currentExpiryReason = reconciliationExpiryReason(item, {
      attempts: currentReconcileAttempts,
      nowMs: now().getTime(),
      maxAttempts: configuredReconciliationMaxAttempts,
      maxAgeMs: configuredReconciliationMaxAgeMs,
    });
    if (currentExpiryReason) {
      return terminalizeDirectReconciliation(item, targetConfig, {
        reason: currentExpiryReason,
        attempts: currentReconcileAttempts,
      });
    }
    if (!reconciliationOnly) {
      const lease = await state.transition(sku, "processing", {
        ...item,
        reason: "submission-intent-recovery",
        submission_intent: true,
        submitted: false,
        submission_pending: false,
        reconcile_only: true,
        reconciliation_started_at: reconciliationStartIso(item),
      });
      if (lease === false) {
        return {
          status: "ignored",
          sku,
          source_url: item.source_url ?? null,
          reason: "submission-recovery-reservation-not-acquired",
        };
      }
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
      return scheduleReconciliationRetry(item, targetConfig, {
        reason: "submission-intent-verification-failed",
        error,
      });
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

    if (!String(item?.api_call_started_at || "").trim()) {
      return abandonPreCallSubmissionIntent(item, {
        reason: "submission-pre-call-intent-revalidation-required",
        finalResult: {
          ok: false,
          not_submitted: true,
          reset_pre_call_intent: true,
          verification_completed_at: now().toISOString(),
        },
      });
    }

    if (reconciliationOnly || (activeDirectMode && item?.api_call_started_at)) {
      return scheduleReconciliationRetry({
        ...item,
        submission_intent: true,
        submitted: false,
        submission_pending: false,
        verification_completed_at: now().toISOString(),
      }, targetConfig, {
        reason: "submission-api-status-unknown",
        attempts: currentReconcileAttempts + 1,
      });
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

    const retryState = {
      ...item,
      reason: "submission-intent-bounded-retry",
      submission_intent: true,
      submitted: false,
      submission_pending: false,
      reconcile_only: true,
      submission_payload: usablePayload,
      previous_api_call_started_at: item?.api_call_started_at || null,
      api_call_started_at: null,
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
    const requestedValidationOnly = Boolean(validationMode);
    // Validate the requested mode before mutating the runner-wide flag.  A
    // rejected concurrent call must not be able to switch an in-flight
    // snapshot validation run into the publishing path.
    if (activeValidationSnapshotPrice && !requestedValidationOnly) {
      throw new TypeError("validationUseSnapshotPrice cannot run outside validation-only mode");
    }
    activeValidationOnly = requestedValidationOnly;
    void reportProgress({ kind: "runner-started" });
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
    const restoredBySku = new Map(restoredEntries.map((entry) => [String(entry.sku), entry]));
    const restoredValidatedSkus = new Set();
    const restoredSupplyValidatedSkus = new Set();
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
      if (status === "supply_validated_pending_profit") restoredSupplyValidatedSkus.add(sku);
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
      if (activeValidationSupplyOnly && restoredSupplyValidatedSkus.has(sku)) return false;
      if (Number(validationTransientAttempts.get(sku) || 0) >= 2) return false;
      const latest = latestValidation.get(sku);
      if (!["deferred", "failed"].includes(String(latest?.status || ""))) return true;
      const retryAt = Date.parse(String(latest?.retry_at || ""));
      return !Number.isFinite(retryAt) || retryAt <= now().getTime();
    };
    const cleanupLimit = reconciliationOnly
      ? 0
      : Math.max(0, Math.floor(Number(importedFavoriteCleanupLimit) || 0));
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
        weightThresholdGrams: Number(spec.weightThresholdGrams || 400),
        weightRouting: spec.weightRouting === true,
      };
      recordStoreTargetMetric({
        store_id: Number(resolved.store?.id || spec.id),
        store_name: resolved.store?.name ?? resolved.store?.title ?? spec.needle,
        warehouse_id: targetWarehouseId || null,
        ural_warehouse_id: Number(spec.uralWarehouseId || 0) || null,
        weight_threshold_grams: Number(spec.weightThresholdGrams || 400),
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
    const fixedSnapshotTargetMode = activeValidationOnly && activeValidationSnapshotPrice;
    if (!fixedSnapshotTargetMode && activeDirectMode) {
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
    if (fixedSnapshotTargetMode) {
      const fixedStoreId = Number(storeId);
      const fixedWatermarkId = Number(watermarkId);
      if (!(fixedStoreId > 0) || !(fixedWatermarkId > 0)) {
        throw new TypeError("snapshot validation requires configured positive storeId and watermarkId");
      }
      let commissionTree = activeValidationSupplyOnly
        ? []
        : activeValidationCommissionSeed?.commissionTree || targetConfigCache?.commissionTree;
      if (!commissionTree) {
        commissionTree = typeof client.listCategoryCommissions === "function"
          ? await client.listCategoryCommissions()
          : [];
        if (targetConfigCache) targetConfigCache.commissionTree = commissionTree;
      }
      const configuredTarget = targetPlan.find((entry) => Number(entry.id) === fixedStoreId);
      const fixedWarehouseId = Number(configuredTarget?.warehouseId || warehouseId || 0) || null;
      targetConfig = {
        store: { id: fixedStoreId, name: `validation-snapshot-store-${fixedStoreId}` },
        watermark: { id: fixedWatermarkId, name: `validation-snapshot-watermark-${fixedWatermarkId}` },
        commissionTree,
        warehouseId: fixedWarehouseId,
        postalWarehouseId: fixedWarehouseId,
        uralWarehouseId: Number(configuredTarget?.uralWarehouseId || 0) || null,
        weightThresholdGrams: Number(configuredTarget?.weightThresholdGrams || 400),
        weightRouting: configuredTarget?.weightRouting === true,
      };
    } else {
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
    }
    if (activeDirectMode && !fixedSnapshotTargetMode) {
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
      fixedSnapshotTargetMode
        ? "validation-snapshot-fixed-target"
        : storeSwitches.at(-1)?.reason || initialPauseReason || "active",
    );
    const facts = await loadCandidateFacts(runDir, candidateFactSeedFiles);
    const listedFavorites = reconciliationOnly ? [] : await client.listFavorites();
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
        return !activeExcludedSkus.has(sku)
          && (!allowedSkus || allowedSkus.has(sku))
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
        && !activeExcludedSkus.has(String(entry.sku))
        && (!allowedSkus || allowedSkus.has(String(entry.sku)))
        && !isDurableReconciliationFinal(entry)
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
    const nonTerminalFavorites = favorites.filter((item) => {
      const restored = restoredBySku.get(String(item?.sku ?? item?.id ?? ""));
      if (["published", "skipped"].includes(String(restored?.status || ""))) return true;
      // A deterministic final outcome is protected from recalculation, but a
      // persisted skip intent must still re-enter the cleanup lane until the
      // favorite deletion itself succeeds.
      if (restored?.data?.skip_intent === true) return true;
      return !isDurableReconciliationFinal(restored)
        && !(restored?.status === "failed" && isTerminalSubmittedFailure(restored));
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
    const rankedDueReconciliations = prioritizeDueReconciliations(
      (activeValidationOnly || (activeDirectMode && !reconciliationOnly)
        ? []
        : [...delayedSubmissions, ...actionableFavorites.filter(isReconciliationCandidate)]).filter((item) => {
        const nextReconcileAt = Date.parse(item?.next_reconcile_at || "");
        return !Number.isFinite(nextReconcileAt) || nextReconcileAt <= now().getTime();
      }),
      reconciliationFairnessCursor,
    );
    const dueReconciliationLimit = reconciliationOnly
      ? (activeAttemptLimit > 0 ? Math.min(workerCount, activeAttemptLimit) : workerCount)
      : rankedDueReconciliations.length;
    const dueReconciliations = rankedDueReconciliations.slice(0, dueReconciliationLimit);
    if (dueReconciliations.length > 0) {
      reconciliationFairnessCursor = asSku(dueReconciliations.at(-1));
    }
    if (dueReconciliations.length > 0) {
      const delayedCountByStore = new Map();
      for (const item of dueReconciliations) {
        if (item?.submitted !== true && item?.submission_pending !== true) continue;
        if (activeDirectMode && reconciliationExpiryReason(item, {
          attempts: Math.max(0, Number(item.reconcile_attempts) || 0),
          nowMs: now().getTime(),
          maxAttempts: configuredReconciliationMaxAttempts,
          maxAgeMs: configuredReconciliationMaxAgeMs,
        })) continue;
        const delayedStoreId = Number(item.store_id) || Number(targetConfig.store.id);
        delayedCountByStore.set(delayedStoreId, Number(delayedCountByStore.get(delayedStoreId) || 0) + 1);
      }
      for (const [delayedStoreId, pendingCount] of delayedCountByStore) {
        await maybeSyncOnlineShop({ store: { id: delayedStoreId } }, { pendingCount });
      }
    }
    const candidates = [
      ...terminalCleanupCandidates,
      ...interleaveCandidateBatches(freshCandidates, dueReconciliations, workerCount),
    ];
    const terminalCleanupSet = new Set(terminalCleanupCandidates);
    const freshCandidateSet = new Set(freshCandidates);
    const initialProductiveWorkExpected = activeDirectMode
      && !reconciliationOnly
      && !activeValidationOnly
      && dailyWindow.open
      && !freshSubmissionsPaused
      && !targetPlan.every((entry) => directRejectedStoreIds.has(Number(entry.id)))
      && freshCandidates.length > 0;
    if (initialProductiveWorkExpected) {
      await reportProgress({
        kind: "productive-work-expected",
        eligible_backlog_count: freshCandidates.length,
        productive_watch_eligible: true,
      });
    }
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
    let eligibleFreshAttemptCount = 0;
    let submittedPending = activeDirectMode
      ? [...acceptedSkus].filter((sku) => restoredBySku.get(sku)?.status !== "published").length
      : 0;
    let dryCandidates = 0;
    let validated = 0;
    let supplyValidatedPendingProfit = 0;
    const validationCompletionCount = () => (
      activeValidationSupplyOnly ? supplyValidatedPendingProfit : validated
    );
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
      const currentEntry = state.entryOf?.(sku);
      if (online && isDurableReconciliationFinal(currentEntry)) {
        return { status: "ignored", sku, reason: "background-final-already-recorded" };
      }
      const reconcileAttempts = Math.max(0, Number(item.reconcile_attempts) || 0) + 1;
      const expiryReason = online ? null : reconciliationExpiryReason(item, {
        attempts: reconcileAttempts,
        nowMs: now().getTime(),
        maxAttempts: configuredReconciliationMaxAttempts,
        maxAgeMs: configuredReconciliationMaxAgeMs,
      });
      if (expiryReason) {
        return terminalizeDirectReconciliation(item, reconciliationTarget, {
          reason: expiryReason,
          attempts: reconcileAttempts,
          importLog,
          finalResult: extra?.final_result || null,
        });
      }
      const recorded = await state.transition(sku, "processing", {
        ...item,
        ...extra,
        reason: online ? "background-online" : "background-imported",
        submitted: true,
        submission_pending: false,
        reconcile_only: !online,
        reconciliation_terminal: online,
        terminal: online,
        failure_class: null,
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
        reconciliation_started_at: reconciliationStartIso(item),
        reconcile_attempts: reconcileAttempts,
        retry_at: null,
        next_reconcile_at: online
          ? null
          : new Date(now().getTime() + reconciliationBackoffMs(reconcileAttempts)).toISOString(),
      });
      if (recorded === false) {
        return { status: "ignored", sku, reason: "background-final-already-recorded" };
      }
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
      if (activeExcludedSkus.has(sku)) {
        return { status: "ignored", sku, source_url: inputItem.source_url ?? null, reason: "excluded-sku" };
      }
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
        ? mergeCandidateFacts(
          latestEntry.data?.fresh_pipeline_required === true
            ? { ...(latestEntry.data || {}), ...inputItem, sku }
            : { ...inputItem, ...(latestEntry.data || {}), sku },
          facts.get(String(sku)) || {},
        )
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
      if (!isReconciliationCandidate(item)) {
        const blocked = await attemptBlock(sku);
        if (blocked) return { ...blocked, source_url: inputItem.source_url ?? null };
      }
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
        if (activeDirectMode) {
          const expiryReason = reconciliationExpiryReason(item, {
            attempts: Math.max(0, Number(item.reconcile_attempts) || 0),
            nowMs: now().getTime(),
            maxAttempts: configuredReconciliationMaxAttempts,
            maxAgeMs: configuredReconciliationMaxAgeMs,
          });
          if (expiryReason) {
            return terminalizeDirectReconciliation(item, reconciliationTarget, {
              reason: expiryReason,
            });
          }
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
              const expiryReason = activeDirectMode ? reconciliationExpiryReason(item, {
                attempts: reconcileAttempts,
                nowMs: now().getTime(),
                maxAttempts: configuredReconciliationMaxAttempts,
                maxAgeMs: configuredReconciliationMaxAgeMs,
              }) : null;
              if (expiryReason) {
                return terminalizeDirectReconciliation(item, reconciliationTarget, {
                  reason: expiryReason,
                  attempts: reconcileAttempts,
                  importLog,
                });
              }
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
                reconciliation_started_at: reconciliationStartIso(item),
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
              ...(activeDirectMode ? {
                reconcile_only: false,
                next_reconcile_at: null,
                retry_at: null,
                terminal: true,
                failure_class: "deterministic",
              } : {}),
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
            }, reconciliationTarget, { attempts: 1, initialImportLog: importLog });
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
              const expiryReason = activeDirectMode && retryablePending
                ? reconciliationExpiryReason(item, {
                    attempts: reconcileAttempts,
                    nowMs: now().getTime(),
                    maxAttempts: configuredReconciliationMaxAttempts,
                    maxAgeMs: configuredReconciliationMaxAgeMs,
                  })
                : null;
              if (expiryReason) {
                return terminalizeDirectReconciliation(item, reconciliationTarget, {
                  reason: expiryReason,
                  attempts: reconcileAttempts,
                  importLog,
                  finalResult: confirmed,
                });
              }
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
                  reconciliation_started_at: reconciliationStartIso(item),
                  next_reconcile_at: new Date(now().getTime() + reconciliationBackoffMs(reconcileAttempts)).toISOString(),
                } : activeDirectMode ? {
                  reconcile_only: false,
                  next_reconcile_at: null,
                  retry_at: null,
                  terminal: true,
                  failure_class: "deterministic",
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
            if (activeDirectMode) {
              const reconcileAttempts = Math.max(0, Number(item.reconcile_attempts) || 0) + 1;
              const expiryReason = reconciliationExpiryReason(item, {
                attempts: reconcileAttempts,
                nowMs: now().getTime(),
                maxAttempts: configuredReconciliationMaxAttempts,
                maxAgeMs: configuredReconciliationMaxAgeMs,
              });
              if (expiryReason) {
                return terminalizeDirectReconciliation(item, reconciliationTarget, {
                  reason: expiryReason,
                  attempts: reconcileAttempts,
                });
              }
              const reason = item.submission_intent === true
                ? "submission-api-status-unknown"
                : "reconciliation-import-not-visible";
              await state.transition(sku, "processing", {
                ...item,
                reason,
                reconcile_only: true,
                reconcile_attempts: reconcileAttempts,
                reconciliation_started_at: reconciliationStartIso(item),
                next_reconcile_at: new Date(now().getTime() + reconciliationBackoffMs(reconcileAttempts)).toISOString(),
              });
              return { status: "ignored", sku, reason };
            }
            return { status: "ignored", sku, reason: "reconciliation-import-not-visible" };
          }
        } catch (error) {
          if (isFatalRunnerError(error)) throw error;
          const deferred = await scheduleReconciliationRetry(item, reconciliationTarget, {
            reason: "reconciliation-check-failed",
            error,
          }).catch(() => ({
            status: "ignored",
            sku,
            reason: "reconciliation-state-not-recorded",
          }));
          return DIRECT_RECONCILIATION_FINAL_OUTCOMES.has(
            String(state.entryOf?.(sku)?.data?.outcome_status || ""),
          )
            ? deferred
            : { ...deferred, status: "failed", error };
        }
      }

      return {
        ...await processItem(item, targetConfig, batchControl, { eligibilityChecked: true }),
        attempted: true,
      };
    }

    async function recordCandidateResult(item, result) {
      const progressKind = ["published", "submitted"].includes(String(result?.status || ""))
        ? "erp-accepted"
        : "candidate-result";
      // ERP acceptance has already been persisted before handleCandidate returns.
      // Await its health projection so the productive watchdog cannot lose an
      // accepted reset behind a later round-completed snapshot.
      await reportProgress({
        kind: progressKind,
        sku: result?.sku ?? item?.sku ?? null,
        status: result?.status ?? null,
        attempted: result?.attempted === true,
      });
      if (freshCandidateSet.has(item) && result?.attempted === true) {
        eligibleFreshAttemptCount += 1;
      }
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
      } else if (result.status === "supply_validated_pending_profit") {
        supplyValidatedPendingProfit += 1;
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
          await recordCandidateResult(item, result);
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
        && validationCompletionCount() + inFlight.size >= activeValidationTarget;
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
        if (activeValidationOnly && validationCompletionCount() + inFlight.size >= activeValidationTarget) break;

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
    if (activeDirectMode
      && !fixedSnapshotTargetMode
      && ["daily-product-limit", "store-unavailable"].includes(haltReason)) {
      const nextConfig = await advanceStore(haltReason, targetConfig);
      if (nextConfig) targetConfig = nextConfig;
    }

    await probeInactiveTargetConfigs();
    await metricsChain;

    if (!haltReason && freshSubmissionsPaused && initialPauseReason) haltReason = initialPauseReason;

    const finalDailyWindow = dailyWindowState({
      now: now(),
      timeZone: dailyStoreTimeZone,
      cutoff: dailySubmissionCutoff,
      reportAfter: dailyReportAfter,
    });
    const allStoresExhausted = activeDirectMode
      && targetPlan.every((entry) => directRejectedStoreIds.has(Number(entry.id)));
    const productiveBlockReason = !activeDirectMode
      ? "not-direct-mode"
      : reconciliationOnly
        ? "reconciliation-only"
        : activeValidationOnly
          ? "validation-only"
          : !finalDailyWindow.open || dailyWindowClosed
            ? "submission-window-closed"
            : allStoresExhausted
              ? "all-stores-exhausted"
              : freshSubmissionsPaused
                ? String(haltReason || initialPauseReason || "fresh-submissions-paused")
                : eligibleFreshAttemptCount <= 0
                  ? "eligible-queue-empty"
                  : null;
    const productiveWatchEligible = productiveBlockReason === null;

    await reportProgress({
      kind: "runner-completed",
      attempted,
      accepted: acceptedCount(),
      eligible_backlog_count: eligibleFreshAttemptCount,
      productive_watch_eligible: productiveWatchEligible,
      productive_block_reason: productiveBlockReason,
    });

    return {
      published,
      accepted: acceptedCount(),
      remaining: unlimitedTarget ? null : Math.max(0, targetCount - acceptedCount()),
      validated,
      supply_validated_pending_profit: supplyValidatedPendingProfit,
      failed,
      skipped,
      attempted,
      eligible_backlog_count: eligibleFreshAttemptCount,
      queue_candidate_count: freshCandidates.length,
      productive_watch_eligible: productiveWatchEligible,
      productive_block_reason: productiveBlockReason,
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
      daily_submission_window: finalDailyWindow,
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
