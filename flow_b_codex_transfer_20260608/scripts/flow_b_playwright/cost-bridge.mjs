import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  isReliable1688CostSource,
  sameItemCostEvidence,
  verifyReturnedSameItemEvidence,
} from "./cost-evidence.mjs";
import { createJsonLineWorkerPool } from "./json-line-worker-pool.mjs";
import {
  createProfitFilesReader,
  feedbackExcludedOfferIds,
  manualFeedbackDecision,
} from "./profit-priority.mjs";

function lineValue(text, label) {
  const match = String(text || "").match(new RegExp(`^${label}\\s+(.+)$`, "m"));
  return match?.[1]?.trim() || "";
}

export function compactCostOutput(text) {
  return [
    "SAME_ITEM_EVIDENCE",
    "MATCH_EVIDENCE_KEY",
    "SELECTED_OFFER_ID",
    "BALANCED_MATCH_OK",
    "BALANCED_MATCH_TYPE",
    "BALANCED_MATCH_REASON",
    "IMAGE_CHECK_AVAILABLE",
    "ADAPTIVE_MATCH_JSON",
    "COST_SOURCE",
    "REASON",
    "FILTERED_FIRST_PAGE_PRICES",
    "P70_COST",
  ]
    .map((label) => [label, lineValue(text, label)])
    .filter(([, value]) => value !== "")
    .map(([label, value]) => `${label} ${value}`)
    .join("\n");
}

function compactTerminalCostOutput(text, reason) {
  const compact = compactCostOutput(text);
  if (compact) return compact;
  const safeReason = String(reason || "cached terminal 1688 failure")
    .replace(/\s+/g, " ")
    .trim();
  return `REASON ${safeReason || "cached terminal 1688 failure"}\nP70_COST None`;
}

function parsePrices(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    const match = String(value || "").match(/^\[([^\]]*)\]$/);
    if (!match) return [];
    const parts = match[1].split(",").map((part) => part.trim()).filter(Boolean);
    const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
    if (!parts.length || parts.some((part) => !numeric.test(part))) return [];
    const prices = parts.map(Number);
    return prices.every(Number.isFinite) ? prices : [];
  }
}

function parseAdaptiveMatch(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
    const decision = parsed.decision;
    const score = parsed.score;
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    const stringArrays = [parsed.hard_conflicts, parsed.missing_evidence, parsed.supporting_offer_ids];
    if (!version
      || !["FAST", "REVIEW", "REJECT"].includes(decision)
      || typeof score !== "number"
      || !Number.isFinite(score)
      || score < 0
      || score > 100
      || !reason
      || !stringArrays.every((values) => Array.isArray(values) && values.every((entry) => typeof entry === "string"))
      || !(typeof parsed.selected_offer_id === "string" || parsed.selected_offer_id === null)) {
      return null;
    }
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(parsed, key);
    if (hasOwn("action") && !["ALLOW", "REJECT", null].includes(parsed.action)) return null;
    if (hasOwn("policy_version")
      && (typeof parsed.policy_version !== "string" || !parsed.policy_version.trim())) return null;
    if (hasOwn("policy_reasons")
      && (!Array.isArray(parsed.policy_reasons)
        || !parsed.policy_reasons.every((entry) => typeof entry === "string"))) return null;
    if (hasOwn("evidence_complete") && typeof parsed.evidence_complete !== "boolean") return null;
    if (hasOwn("valuable_digital")) {
      const valuable = parsed.valuable_digital;
      if (!valuable
        || typeof valuable !== "object"
        || Array.isArray(valuable)
        || typeof valuable.applies !== "boolean"
        || !(typeof valuable.category === "string" || valuable.category === null)
        || !(valuable.price_cny === null
          || (typeof valuable.price_cny === "number" && Number.isFinite(valuable.price_cny)))
        || valuable.threshold_cny !== 300) return null;
    }
    return {
      version,
      decision,
      score,
      reason,
      hard_conflicts: [...parsed.hard_conflicts],
      missing_evidence: [...parsed.missing_evidence],
      selected_offer_id: parsed.selected_offer_id,
      supporting_offer_ids: [...parsed.supporting_offer_ids],
      ...(hasOwn("action") ? { action: parsed.action } : {}),
      ...(hasOwn("policy_version") ? { policy_version: parsed.policy_version.trim() } : {}),
      ...(hasOwn("policy_reasons") ? { policy_reasons: [...parsed.policy_reasons] } : {}),
      ...(hasOwn("evidence_complete") ? { evidence_complete: parsed.evidence_complete } : {}),
      ...(hasOwn("valuable_digital") ? { valuable_digital: { ...parsed.valuable_digital } } : {}),
    };
  } catch {
    return null;
  }
}

export function parseCostOutput(text, sellPrice, {
  expectedMatchEvidence = null,
  requireSameItemEvidence = false,
  minimumSameItemMatches = 3,
  requiredEvidenceContract = null,
  requireBalancedMatch = false,
} = {}) {
  const requiredMatches = Math.max(1, Number(minimumSameItemMatches) || 1);
  const cost = Number(lineValue(text, "P70_COST"));
  const source = lineValue(text, "COST_SOURCE");
  const matchEvidenceKey = lineValue(text, "MATCH_EVIDENCE_KEY");
  const selectedOfferId = lineValue(text, "SELECTED_OFFER_ID");
  const encodedSameItemEvidence = lineValue(text, "SAME_ITEM_EVIDENCE");
  const prices = parsePrices(lineValue(text, "FILTERED_FIRST_PAGE_PRICES"));
  const sale = Number(sellPrice);
  const explicitReason = lineValue(text, "REASON");
  const adaptiveMatch = parseAdaptiveMatch(lineValue(text, "ADAPTIVE_MATCH_JSON"));
  const adaptiveResult = adaptiveMatch ? { adaptive_match: adaptiveMatch } : {};
  const rejected = (reason) => ({ ok: false, reason, ...adaptiveResult });

  if (!Number.isFinite(cost) || cost <= 0) return rejected(explicitReason || "missing or invalid P70 cost");
  if (!isReliable1688CostSource(source)) return rejected(`unreliable cost source: ${source || "missing"}`);
  if (prices.length < requiredMatches) {
    return rejected(`filtered first-page insufficient ${prices.length}`);
  }
  if (prices.some((price) => !Number.isFinite(price) || price <= 0)) return rejected("invalid filtered first-page prices");
  if (source === "search_first_page_p70_similarity_filtered" && Math.max(...prices) / Math.min(...prices) > 5) {
    return rejected("filtered first-page price spread greater than five");
  }
  if (!Number.isFinite(sale) || sale <= 0) return rejected("invalid sale price");
  if (cost < sale * 0.02) return rejected("1688 cost below 2% of sale price is not reliable");
  if (cost >= sale * 0.85) return rejected("1688 cost is at least 85% of sale price");
  const sameItemProof = verifyReturnedSameItemEvidence({
    encodedEvidence: encodedSameItemEvidence,
    evidenceKey: matchEvidenceKey,
    expectedRequest: expectedMatchEvidence,
    filteredPrices: prices,
    costSource: source,
    selectedCost: cost,
    selectedOfferId,
    minimumMatches: requiredMatches,
    requiredContract: requiredEvidenceContract,
    requireBalancedMatch,
  });
  if (requireSameItemEvidence && !sameItemProof.ok) {
    return rejected(`same-item evidence rejected: ${sameItemProof.reason}`);
  }
  return {
    ok: true,
    cost,
    source,
    prices,
    ...adaptiveResult,
    ...(sameItemProof.ok ? {
      match_evidence_key: matchEvidenceKey,
      same_item_match: true,
      returned_evidence_verified: true,
      match_evidence_contract: sameItemProof.contract,
      matched_offer_count: sameItemProof.matched_offer_count,
      matched_offer_ids: sameItemProof.offer_ids,
      selected_offer_id: sameItemProof.selected_offer_id,
      selected_offer_ids: sameItemProof.selected_offer_ids,
      selected_cluster_offer_ids: sameItemProof.selected_cluster_offer_ids,
      selected_cluster_prices: sameItemProof.selected_cluster_prices,
      balanced_match: sameItemProof.balanced_match,
      balanced_match_type: sameItemProof.balanced_match_type,
      balanced_match_reason: sameItemProof.balanced_match_reason,
      image_check_available: sameItemProof.image_check_available,
    } : {}),
  };
}

function safeSku(value) {
  const sku = String(value ?? "").trim();
  if (!sku || sku.length > 128 || sku === "." || sku === ".." || !/^[A-Za-z0-9._-]+$/.test(sku)) {
    throw Object.assign(new Error("unsafe SKU; path traversal is not allowed"), { code: "invalid-sku" });
  }
  return sku;
}

async function defaultDownload(url, destinationPath, { timeout = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeout) || 15_000));
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`image download HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error("downloaded image is empty");
    await fs.writeFile(destinationPath, bytes);
  } finally {
    clearTimeout(timer);
  }
}

const TRANSIENT_DOWNLOAD_ERROR_CODES = new Set([
  "ABORT_ERR",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_ABORTED",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function downloadErrorChain(error) {
  const chain = [];
  const pending = [error];
  const seen = new Set();
  while (pending.length > 0 && chain.length < 12) {
    const current = pending.shift();
    if (current === null || current === undefined || seen.has(current)) continue;
    seen.add(current);
    chain.push(current);
    if (typeof current === "object") {
      if (current.cause !== null && current.cause !== undefined) pending.push(current.cause);
      if (Array.isArray(current.errors)) pending.push(...current.errors.slice(0, 4));
    }
  }
  return chain;
}

function isTransientDownloadError(error) {
  const chain = downloadErrorChain(error);
  for (const current of chain) {
    const message = String(current?.message || current || "");
    const status = Number(message.match(/HTTP\s+(\d{3})/i)?.[1]);
    if (status > 0) return status >= 500 && status <= 599;
  }
  return chain.some((current) => {
    const code = String(current?.code || "").trim().toUpperCase();
    if (TRANSIENT_DOWNLOAD_ERROR_CODES.has(code)) return true;
    if (String(current?.name || "").trim() === "AbortError") return true;
    const message = String(current?.message || current || "");
    return /\b(?:ABORT_ERR|ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EPIPE|ETIMEDOUT|EAI_AGAIN|UND_ERR_(?:ABORTED|BODY_TIMEOUT|CLOSED|CONNECT_TIMEOUT|HEADERS_TIMEOUT|SOCKET))\b/i.test(message);
  });
}

function isTransient1688TransportFailure(result, combinedOutput) {
  if (Number(result?.code) !== 1) return false;
  const text = `${String(combinedOutput || "")}\n${String(result?.stderr || "")}`;
  return /unexpected_eof_while_reading|eof occurred in violation of protocol|sslerror|connection(?:error| reset)|remote end closed|failed to resolve|name or service not known|timed?\s*out|timeout/i.test(text);
}

function defaultRunProcess({ command, args, cwd, timeout = 90000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Object.assign(new Error(`1688 process timed out after ${timeout}ms`), {
        code: "process-timeout",
        stdout,
        stderr,
      }));
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(Object.assign(error, { stdout, stderr }));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function readableFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function defaultWriteCache(filename, cache, serializedPayload = null) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const payload = serializedPayload ?? `${JSON.stringify(cache)}\n`;
  await fs.writeFile(temporary, payload, "utf8");
  await fs.rename(temporary, filename);
}

export function createCostBridge({
  python = "python3",
  scriptPath = path.resolve(import.meta.dirname, "../1688_image_median.py"),
  runProcess = defaultRunProcess,
  download = defaultDownload,
  sharedCachePath = null,
  seedCacheFiles = [],
  workerPool = null,
  workerScriptPath = path.resolve(import.meta.dirname, "../flow_b_1688_worker.py"),
  workerCount = Number(process.env.FLOW_B_1688_WORKERS || 4),
  createWorkerPool = createJsonLineWorkerPool,
  healthFailureThreshold = Number(process.env.FLOW_B_1688_HEALTH_FAILURE_THRESHOLD || 5),
  healthDeferredTtlMs = Number(process.env.FLOW_B_1688_HEALTH_DEFERRED_TTL_MS || 300_000),
  healthProbeBackoffMs = Number(process.env.FLOW_B_1688_HEALTH_PROBE_BACKOFF_MS || 30_000),
  healthSkuRetryLimit = Number(process.env.FLOW_B_1688_HEALTH_SKU_RETRY_LIMIT || 1),
  minimumSameItemMatches = Number(process.env.FLOW_B_1688_MIN_MATCHES || 3),
  totalBudgetMs = Number(process.env.FLOW_B_1688_TOTAL_BUDGET_MS || 15_000),
  workerFailureThreshold = Number(process.env.FLOW_B_1688_WORKER_FAILURE_THRESHOLD || 3),
  cacheFlushDebounceMs = Number(process.env.FLOW_B_1688_CACHE_FLUSH_DEBOUNCE_MS || 150),
  matchPolicy = String(process.env.FLOW_B_1688_MATCH_POLICY || "shadow"),
  matchPolicySampleSize = Number(process.env.FLOW_B_1688_MATCH_SHADOW_SAMPLES || 100),
  matchPolicyRetentionPercent = Number(process.env.FLOW_B_1688_MATCH_MIN_RETENTION_PERCENT || 75),
  matchPolicyImageAvailabilityPercent = Number(process.env.FLOW_B_1688_MATCH_MIN_IMAGE_PERCENT || 90),
  matchPolicyP95Ms = Number(process.env.FLOW_B_1688_MATCH_MAX_P95_MS || 15_000),
  adaptiveActionPolicy = String(process.env.FLOW_B_1688_ADAPTIVE_ACTION_POLICY || "shadow"),
  adaptiveActionSampleTarget = Number(process.env.FLOW_B_1688_ADAPTIVE_ACTION_SAMPLE_TARGET || 100),
  feedbackFile = process.env.FLOW_B_PROFIT_FEEDBACK_FILE || null,
  feedbackRefreshMs = Number(process.env.FLOW_B_PROFIT_FILE_REFRESH_MS || 5_000),
  trustedFeedbackMaxAgeMs = Number(process.env.FLOW_B_PROFIT_TRUSTED_MAX_AGE_MS || 30 * 24 * 60 * 60 * 1000),
  writeCache = defaultWriteCache,
  now = () => Date.now(),
  downloadAttempts = 2,
  downloadTimeoutMs = 15_000,
  sleep: wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const inFlight = new Map();
  const cacheByRun = new Map();
  const cacheLoadsByRun = new Map();
  const crossRunKeysByRun = new Map();
  let cacheWriteChain = Promise.resolve();
  let pendingCacheGeneration = null;
  let backgroundCacheWriteError = null;
  let ownedWorkerPool = null;
  let persistentWorkersDisabled = process.env.FLOW_B_1688_PERSISTENT_POOL === "0";
  let workerInfrastructureFailures = 0;
  const matchPolicyByRun = new Map();
  let matchPolicyWriteChain = Promise.resolve();
  const configuredAdaptiveActionPolicy = String(adaptiveActionPolicy).trim().toLowerCase() === "enforce"
    ? "enforce"
    : "shadow";
  const parsedAdaptiveActionSampleTarget = Number(adaptiveActionSampleTarget);
  const configuredAdaptiveActionSampleTarget = Number.isFinite(parsedAdaptiveActionSampleTarget)
    && parsedAdaptiveActionSampleTarget > 0
    ? Math.max(1, Math.floor(parsedAdaptiveActionSampleTarget))
    : 100;
  const profitFiles = createProfitFilesReader({
    feedbackFile,
    refreshMs: Math.max(0, Number(feedbackRefreshMs) || 0),
    now,
  });
  // Prime the two small sidecar files outside the per-product hot path. Later
  // refreshes are fire-and-forget so manual feedback never adds disk latency to
  // an Ozon publishing request.
  let profitFilesReady = profitFiles.snapshot().catch(() => profitFiles.current());
  const health = {
    circuit: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    nextProbeAt: 0,
    probeInFlight: false,
    reason: null,
  };

  function matchEvidence(item) {
    const value = (candidate) => String(candidate ?? "").replace(/\s+/g, " ").trim();
    const sellPrice = Number(item?.sell_price);
    return {
      expect_title: value(item?.expect_title || item?.title),
      expect_model: value(item?.expect_model || item?.model || item?.model_name || item?.article),
      expect_category: value(item?.expect_category || item?.category_name || item?.cate_name),
      expect_price_cny: Number.isFinite(sellPrice) && sellPrice > 0 ? sellPrice : null,
    };
  }

  function parseOptions(item) {
    const expectedMatchEvidence = matchEvidence(item);
    const hasSemanticEvidence = [
      expectedMatchEvidence.expect_title,
      expectedMatchEvidence.expect_model,
      expectedMatchEvidence.expect_category,
    ].some(Boolean);
    return {
      expectedMatchEvidence,
      requireSameItemEvidence: hasSemanticEvidence,
      minimumSameItemMatches: Math.max(1, Number(minimumSameItemMatches) || 1),
      requiredEvidenceContract: hasSemanticEvidence
        ? "1688-returned-same-item-v3"
        : null,
    };
  }

  function trustedFeedbackCost(feedback, item) {
    const sourceSku = String(item?.sku || "").trim();
    const salePrice = Number(item?.sell_price);
    if (!sourceSku || !Number.isFinite(salePrice) || salePrice <= 0) return null;
    const rows = Array.isArray(feedback?.trusted_matches) ? feedback.trusted_matches : [];
    const entry = rows
      .filter((row) => String(row?.source_sku || row?.sku || "").trim() === sourceSku)
      .sort((left, right) => Date.parse(right?.updated_at || "") - Date.parse(left?.updated_at || ""))[0];
    if (!entry) return null;
    const updatedAt = Date.parse(entry.updated_at || "");
    const currentTime = Number(now());
    const maxAge = Math.max(1, Number(trustedFeedbackMaxAgeMs) || 0);
    if (!Number.isFinite(updatedAt)
      || updatedAt > currentTime + 5 * 60 * 1000
      || currentTime - updatedAt > maxAge) return null;
    const cost = Number(entry.actual_cost ?? entry.actual_purchase_price ?? entry.purchase_price);
    if (!Number.isFinite(cost) || cost <= 0 || cost < salePrice * 0.02 || cost >= salePrice * 0.85) return null;
    const selectedOfferId = String(entry.selected_offer_id || entry.offer_id || "").trim();
    const verified = entry?.verified_cost && typeof entry.verified_cost === "object"
      ? entry.verified_cost
      : null;
    if (!selectedOfferId || !verified || String(verified.selected_offer_id || "").trim() !== selectedOfferId) return null;
    const candidate = {
      ...verified,
      ok: true,
      cost,
      selected_offer_id: selectedOfferId,
      selected_offer_ids: [selectedOfferId],
    };
    const evidence = sameItemCostEvidence(candidate, {
      minimumMatches: Math.max(1, Number(minimumSameItemMatches) || 1),
    });
    if (evidence.same_item_match !== true || evidence.selected_offer_id !== selectedOfferId) return null;
    return {
      ...candidate,
      estimated_cost: Number(entry.estimated_cost ?? verified.cost) || null,
      manual_feedback_trusted: true,
      manual_feedback_cache: true,
      feedback_updated_at: new Date(updatedAt).toISOString(),
    };
  }

  function percentile95(values) {
    if (!values.length) return 0;
    const sorted = [...values].map(Number).filter(Number.isFinite).sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] || 0;
  }

  function isCompleteAdaptiveAction(adaptiveMatch, {
    verifiedSelectedOfferId = null,
    expectedPriceCny = null,
  } = {}) {
    const valuable = adaptiveMatch?.valuable_digital;
    const selectedOfferId = String(adaptiveMatch?.selected_offer_id || "").trim();
    const verifiedOfferId = String(verifiedSelectedOfferId || "").trim();
    const expectedPrice = Number(expectedPriceCny);
    return adaptiveMatch?.version === "adaptive-v5-shadow"
      && adaptiveMatch?.policy_version === "adaptive-v5-policy-1"
      && ["ALLOW", "REJECT"].includes(adaptiveMatch?.action)
      && Array.isArray(adaptiveMatch?.policy_reasons)
      && adaptiveMatch.policy_reasons.every((entry) => typeof entry === "string")
      && adaptiveMatch?.evidence_complete === true
      && selectedOfferId
      && verifiedOfferId === selectedOfferId
      && valuable
      && typeof valuable === "object"
      && !Array.isArray(valuable)
      && typeof valuable.applies === "boolean"
      && (typeof valuable.category === "string" || valuable.category === null)
      && (valuable.applies !== true
        || (typeof valuable.category === "string" && valuable.category.trim().length > 0))
      && (valuable.price_cny === null
        || (typeof valuable.price_cny === "number" && Number.isFinite(valuable.price_cny)))
      && Number.isFinite(expectedPrice)
      && expectedPrice > 0
      && valuable.price_cny === expectedPrice
      && valuable.threshold_cny === 300;
  }

  function isCompleteActionSample(row) {
    return isCompleteAdaptiveAction({
      version: row?.adaptive_match_version,
      policy_version: row?.adaptive_policy_version,
      action: row?.adaptive_action,
      policy_reasons: row?.adaptive_policy_reasons,
      evidence_complete: row?.adaptive_evidence_complete,
      valuable_digital: row?.adaptive_valuable_digital,
      selected_offer_id: row?.adaptive_selected_offer_id,
      supporting_offer_ids: row?.adaptive_supporting_offer_ids,
    }, {
      verifiedSelectedOfferId: row?.adaptive_verified_selected_offer_id,
      expectedPriceCny: row?.adaptive_expected_price_cny,
    });
  }

  function summarizeMatchPolicy(samples, actionSamples = []) {
    const rows = Array.isArray(samples) ? samples : [];
    const adaptiveRows = rows.filter((row) => ["FAST", "REVIEW", "REJECT"].includes(row?.adaptive_decision));
    const adaptiveCount = adaptiveRows.length;
    const decisionCount = (decision) => adaptiveRows.filter((row) => row.adaptive_decision === decision).length;
    const decisionPercent = (count) => adaptiveCount > 0
      ? Number((count * 100 / adaptiveCount).toFixed(2))
      : 0;
    const fastCount = decisionCount("FAST");
    const reviewCount = decisionCount("REVIEW");
    const rejectCount = decisionCount("REJECT");
    const actionRows = (Array.isArray(actionSamples) ? actionSamples : []).filter(isCompleteActionSample);
    const actionCount = actionRows.length;
    const actionCountFor = (action) => actionRows.filter((row) => row.adaptive_action === action).length;
    const actionPercent = (count) => actionCount > 0
      ? Number((count * 100 / actionCount).toFixed(2))
      : 0;
    const actionAllowCount = actionCountFor("ALLOW");
    const actionRejectCount = actionCountFor("REJECT");
    return {
      sample_count: rows.length,
      retention_percent: rows.length > 0
        ? Number((rows.filter((row) => row.balanced_passed).length * 100 / rows.length).toFixed(2))
        : 0,
      image_availability_percent: rows.length > 0
        ? Number((rows.filter((row) => row.image_check_available).length * 100 / rows.length).toFixed(2))
        : 0,
      p95_ms: percentile95(rows.map((row) => row.elapsed_ms)),
      adaptive_sample_count: adaptiveCount,
      fast_count: fastCount,
      fast_percent: decisionPercent(fastCount),
      review_count: reviewCount,
      review_percent: decisionPercent(reviewCount),
      reject_count: rejectCount,
      reject_percent: decisionPercent(rejectCount),
      complete_action_samples: actionCount,
      sample_target: configuredAdaptiveActionSampleTarget,
      collection_status: actionCount >= configuredAdaptiveActionSampleTarget ? "complete" : "collecting",
      action_allow_count: actionAllowCount,
      action_allow_percent: actionPercent(actionAllowCount),
      action_reject_count: actionRejectCount,
      action_reject_percent: actionPercent(actionRejectCount),
    };
  }

  async function loadMatchPolicyState(runDir) {
    const root = path.resolve(runDir);
    if (matchPolicyByRun.has(root)) return matchPolicyByRun.get(root);
    const configured = ["shadow", "balanced"].includes(String(matchPolicy).trim().toLowerCase())
      ? String(matchPolicy).trim().toLowerCase()
      : "shadow";
    let state = {
      version: 1,
      matcher_version: "balanced-v3.2",
      configured_policy: configured,
      effective_policy: configured,
      adaptive_action_policy: configuredAdaptiveActionPolicy,
      adaptive_action_sample_target: configuredAdaptiveActionSampleTarget,
      samples: [],
      action_samples: [],
      summary: summarizeMatchPolicy([], []),
      promoted_at: configured === "balanced" ? new Date(now()).toISOString() : null,
    };
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(root, "1688_match_policy.json"), "utf8"));
      if (parsed?.version === 1 && parsed?.matcher_version === state.matcher_version) {
        state = {
          ...state,
          ...parsed,
          configured_policy: configured,
          effective_policy: configured === "balanced" ? "balanced" : parsed.effective_policy,
          adaptive_action_policy: configuredAdaptiveActionPolicy,
          adaptive_action_sample_target: configuredAdaptiveActionSampleTarget,
          samples: Array.isArray(parsed.samples) ? parsed.samples : [],
          action_samples: Array.isArray(parsed.action_samples)
            ? parsed.action_samples
            : (Array.isArray(parsed.samples) ? parsed.samples.filter(isCompleteActionSample) : []),
        };
        state.action_samples = state.action_samples
          .filter(isCompleteActionSample)
          .slice(-configuredAdaptiveActionSampleTarget);
        state.summary = summarizeMatchPolicy(state.samples, state.action_samples);
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    matchPolicyByRun.set(root, state);
    return state;
  }

  async function applyMatchPolicy(result, runDir, {
    elapsedMs = 0,
    recordShadowSample = false,
    expectedPriceCny = null,
  } = {}) {
    const root = path.resolve(runDir);
    return (matchPolicyWriteChain = matchPolicyWriteChain.then(async () => {
      const state = await loadMatchPolicyState(root);
      const effectiveBefore = state.effective_policy;
      const completeAdaptiveAction = isCompleteAdaptiveAction(result?.adaptive_match, {
        verifiedSelectedOfferId: result?.selected_offer_id,
        expectedPriceCny,
      });
      const recordLegacyShadowSample = recordShadowSample && result?.ok && effectiveBefore === "shadow";
      const recordAdaptiveActionSample = recordShadowSample
        && result?.ok
        && completeAdaptiveAction
        && state.action_samples.length < configuredAdaptiveActionSampleTarget;
      if (recordLegacyShadowSample || recordAdaptiveActionSample) {
        const sample = {
          at: new Date(now()).toISOString(),
          matcher_version: state.matcher_version,
          balanced_passed: result?.balanced_match === true,
          balanced_match_type: result?.balanced_match_type || "rejected",
          balanced_match_reason: result?.balanced_match_reason || null,
          image_check_available: result?.image_check_available === true,
          adaptive_match_version: result?.adaptive_match?.version || null,
          adaptive_decision: result?.adaptive_match?.decision || null,
          adaptive_score: Number.isFinite(result?.adaptive_match?.score) ? result.adaptive_match.score : null,
          adaptive_action: completeAdaptiveAction ? result.adaptive_match.action : null,
          adaptive_policy_version: completeAdaptiveAction ? result.adaptive_match.policy_version : null,
          adaptive_policy_reasons: completeAdaptiveAction ? [...result.adaptive_match.policy_reasons] : null,
          adaptive_evidence_complete: completeAdaptiveAction ? result.adaptive_match.evidence_complete : null,
          adaptive_selected_offer_id: completeAdaptiveAction ? result.adaptive_match.selected_offer_id : null,
          adaptive_supporting_offer_ids: completeAdaptiveAction
            ? [...result.adaptive_match.supporting_offer_ids]
            : null,
          adaptive_verified_selected_offer_id: completeAdaptiveAction ? result.selected_offer_id : null,
          adaptive_expected_price_cny: completeAdaptiveAction ? Number(expectedPriceCny) : null,
          adaptive_valuable_digital: completeAdaptiveAction
            ? { ...result.adaptive_match.valuable_digital }
            : null,
          elapsed_ms: Math.max(0, Number(elapsedMs) || 0),
        };
        const legacySampleLimit = Math.max(1, Number(matchPolicySampleSize) || 100);
        if (recordLegacyShadowSample) {
          state.samples = [...state.samples, sample].slice(-legacySampleLimit);
        }
        if (recordAdaptiveActionSample) {
          state.action_samples = [...state.action_samples, sample].slice(-configuredAdaptiveActionSampleTarget);
        }
        state.summary = summarizeMatchPolicy(state.samples, state.action_samples);
        const healthy = recordLegacyShadowSample
          && state.samples.length >= legacySampleLimit
          && state.summary.retention_percent >= Number(matchPolicyRetentionPercent)
          && state.summary.image_availability_percent >= Number(matchPolicyImageAvailabilityPercent)
          && state.summary.p95_ms <= Number(matchPolicyP95Ms);
        if (healthy) {
          state.effective_policy = "balanced";
          state.promoted_at = new Date(now()).toISOString();
        }
        state.updated_at = new Date(now()).toISOString();
        await fs.mkdir(root, { recursive: true });
        await fs.appendFile(path.join(root, "1688_match_quality.jsonl"), `${JSON.stringify(sample)}\n`, "utf8");
        await defaultWriteCache(path.join(root, "1688_match_policy.json"), state);
      }
      const policyResult = {
        ...result,
        match_policy_configured: state.configured_policy,
        match_policy_effective: effectiveBefore,
        match_policy_summary: state.summary,
        match_policy_promoted: effectiveBefore === "shadow" && state.effective_policy === "balanced",
        adaptive_action_policy_configured: configuredAdaptiveActionPolicy,
        adaptive_action_policy_effective: configuredAdaptiveActionPolicy,
        adaptive_action_complete: completeAdaptiveAction,
      };
      if (configuredAdaptiveActionPolicy === "enforce"
        && completeAdaptiveAction
        && result?.adaptive_match?.action === "REJECT"
        && result?.ok) {
        return {
          ...policyResult,
          ok: false,
          reason: `adaptive 1688 action rejected: ${result.adaptive_match.policy_reasons.join("; ") || result.adaptive_match.reason}`,
          terminal: true,
          adaptive_action_rejected: true,
        };
      }
      if (configuredAdaptiveActionPolicy !== "enforce"
        && effectiveBefore === "balanced"
        && result?.ok
        && result?.balanced_match !== true) {
        return {
          ...policyResult,
          ok: false,
          reason: `balanced 1688 match rejected: ${result?.balanced_match_reason || "insufficient v3 evidence"}`,
          terminal: true,
        };
      }
      return policyResult;
    })).catch((error) => {
      matchPolicyWriteChain = Promise.resolve();
      throw error;
    });
  }

  function isCandidateCollapse(result) {
    const reason = String(result?.reason || result?.error?.message || "");
    return /filtered[ -]first[ -]page(?:\s+1688)?\s+candidates?\s+fewer\s+than\s+3/i.test(reason);
  }

  function healthMetadata(extra = {}) {
    return {
      circuit: health.circuit,
      consecutive_failures: health.consecutiveFailures,
      reason: health.reason || "1688-first-page-candidate-collapse",
      opened_at: health.openedAt,
      next_probe_at: health.nextProbeAt > 0 ? new Date(health.nextProbeAt).toISOString() : null,
      ...extra,
    };
  }

  async function rebuildOwnedWorkerPool() {
    if (!ownedWorkerPool) return;
    const stale = ownedWorkerPool;
    ownedWorkerPool = null;
    await stale.close().catch(() => {});
  }

  function totalBudgetError(total) {
    return Object.assign(new Error(`1688 end-to-end budget exceeded after ${total}ms`), {
      code: "1688-total-timeout",
    });
  }

  function totalBudgetResult(total) {
    const error = totalBudgetError(total);
    return {
      ok: false,
      reason: error.message,
      error: { code: error.code, message: error.message },
    };
  }

  function withinTotalBudget(operation, {
    deadlineAt,
    budget,
    onTimeout = () => {},
  }) {
    const remaining = Math.max(0, Number(deadlineAt) - Date.now());
    if (remaining <= 0) {
      try { onTimeout(); } catch {}
      return Promise.resolve(totalBudgetResult(budget));
    }
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        try { onTimeout(); } catch {}
        resolve(totalBudgetResult(budget));
      }, remaining);
    });
    return Promise.race([Promise.resolve(operation), timeout])
      .finally(() => clearTimeout(timer));
  }

  async function downloadImage(url, destinationPath, { deadlineAt, budget } = {}) {
    const attempts = Math.max(1, Math.min(2, Math.floor(Number(downloadAttempts) || 1)));
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const remaining = Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : Number(downloadTimeoutMs);
      if (remaining <= 0) throw totalBudgetError(budget);
      try {
        await download(url, destinationPath, {
          timeout: Math.max(1, Math.min(Number(downloadTimeoutMs) || 15_000, remaining)),
        });
        return;
      } catch (error) {
        lastError = error;
        if (!isTransientDownloadError(error) || attempt + 1 >= attempts) throw error;
        const delay = 500 * (attempt + 1);
        if (Number.isFinite(deadlineAt) && Date.now() + delay >= deadlineAt) {
          throw totalBudgetError(budget);
        }
        await wait(delay);
      }
    }
    throw lastError;
  }

  function activeWorkerPool() {
    if (persistentWorkersDisabled) return null;
    if (workerPool) return workerPool;
    if (runProcess !== defaultRunProcess && createWorkerPool === createJsonLineWorkerPool) return null;
    if (!ownedWorkerPool) {
      ownedWorkerPool = createWorkerPool({
        command: python,
        args: ["-u", path.resolve(workerScriptPath), "--script", path.resolve(scriptPath)],
        size: Math.max(1, Number(workerCount) || 1),
      });
    }
    return ownedWorkerPool;
  }

  async function run1688Process(imagePath, timeout, item, { signal = null } = {}) {
    const healthProbe = health.circuit === "open";
    const evidence = matchEvidence(item);
    const budget = Math.max(1, Math.min(
      Number(timeout) || Number.POSITIVE_INFINITY,
      Math.max(1, Number(totalBudgetMs) || 15_000),
    ));
    const deadlineAt = Date.now() + budget;
    const pool = activeWorkerPool();
    if (pool) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          throw Object.assign(new Error(`1688 total budget exceeded after ${budget}ms`), {
            code: "worker-queue-timeout",
          });
        }
        try {
          const result = await pool.run({
            image: String(imagePath),
            minimum_same_item_matches: Math.max(1, Number(minimumSameItemMatches) || 1),
            excluded_offer_ids: Array.isArray(item?.excluded_1688_offer_ids)
              ? item.excluded_1688_offer_ids.map(String)
              : [],
            ...evidence,
          }, remaining, { signal });
          workerInfrastructureFailures = 0;
          return { ...result, health_probe: healthProbe };
        } catch (error) {
          if (["worker-timeout", "worker-queue-timeout", "worker-aborted"].includes(error?.code)) throw error;
          workerInfrastructureFailures += 1;
          if (workerInfrastructureFailures >= Math.max(1, Number(workerFailureThreshold) || 1)) {
            persistentWorkersDisabled = true;
            if (ownedWorkerPool) {
              await ownedWorkerPool.close().catch(() => {});
              ownedWorkerPool = null;
            }
            break;
          }
        }
      }
    }
    const evidenceArgs = [];
    for (const [flag, key] of [
      ["--expect-title", "expect_title"],
      ["--expect-model", "expect_model"],
      ["--expect-category", "expect_category"],
      ["--expect-price-cny", "expect_price_cny"],
    ]) {
      if (evidence[key]) evidenceArgs.push(flag, String(evidence[key]));
    }
    evidenceArgs.push("--min-matches", String(Math.max(1, Number(minimumSameItemMatches) || 1)));
    for (const offerId of item?.excluded_1688_offer_ids || []) {
      evidenceArgs.push("--exclude-offer-id", String(offerId));
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      throw Object.assign(new Error(`1688 total budget exceeded after ${budget}ms`), {
        code: "worker-queue-timeout",
      });
    }
    const result = await runProcess({
      command: python,
      args: [path.resolve(scriptPath), imagePath, ...evidenceArgs],
      cwd: path.resolve(process.cwd()),
      timeout: remaining,
    });
    return { ...result, health_probe: healthProbe };
  }

  function cacheKey(item) {
    const imageUrl = String(item?.cover_image || "").trim();
    if (!imageUrl) return null;
    const evidence = matchEvidence(item);
    const hasEvidence = Object.values(evidence).some(Boolean);
    const payload = hasEvidence
      ? JSON.stringify({
        version: 7,
        image_url: imageUrl,
        minimum_same_item_matches: Math.max(1, Number(minimumSameItemMatches) || 1),
        excluded_offer_ids: [...new Set((item?.excluded_1688_offer_ids || []).map(String))].sort(),
        ...evidence,
      })
      : `${imageUrl}:min-matches=${Math.max(1, Number(minimumSameItemMatches) || 1)}`;
    return crypto.createHash("sha256").update(payload).digest("hex");
  }

  async function loadCache(runDir) {
    const root = path.resolve(runDir);
    if (cacheByRun.has(root)) return cacheByRun.get(root);
    if (cacheLoadsByRun.has(root)) return cacheLoadsByRun.get(root);
    const operation = (async () => {
      async function readEntries(filename) {
        try {
          const parsed = JSON.parse(await fs.readFile(path.resolve(filename), "utf8"));
          if (!parsed?.entries || typeof parsed.entries !== "object") return {};
          return Object.fromEntries(Object.entries(parsed.entries).map(([key, entry]) => [key, {
            ...entry,
            output: entry?.terminal
              ? compactTerminalCostOutput(entry?.output)
              : compactCostOutput(entry?.output),
          }]));
        } catch (error) {
          if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
          return {};
        }
      }
      const runEntries = await readEntries(path.join(root, "1688_cache.json"));
      const crossRunEntries = {};
      for (const filename of [sharedCachePath, ...seedCacheFiles].filter(Boolean)) {
        Object.assign(crossRunEntries, await readEntries(filename));
      }
      const cache = { version: 1, entries: { ...crossRunEntries, ...runEntries } };
      crossRunKeysByRun.set(root, new Set(Object.keys(crossRunEntries).filter((key) => !(key in runEntries))));
      cacheByRun.set(root, cache);
      return cache;
    })();
    cacheLoadsByRun.set(root, operation);
    try {
      return await operation;
    } finally {
      if (cacheLoadsByRun.get(root) === operation) cacheLoadsByRun.delete(root);
    }
  }

  function createCacheGeneration() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return {
      writes: new Map(),
      promise,
      resolve,
      reject,
      timer: null,
      started: false,
      operation: null,
    };
  }

  function beginCacheFlush(generation = pendingCacheGeneration) {
    if (!generation) return Promise.resolve();
    if (generation.started) return generation.operation;
    generation.started = true;
    if (pendingCacheGeneration === generation) pendingCacheGeneration = null;
    clearTimeout(generation.timer);
    generation.timer = null;
    const entries = [...generation.writes.entries()];
    generation.writes.clear();
    const operation = cacheWriteChain.then(async () => {
      const serializedByCache = new Map();
      for (const [filename, cache] of entries) {
        let serializedPayload = null;
        if (writeCache === defaultWriteCache) {
          if (!serializedByCache.has(cache)) {
            serializedByCache.set(cache, `${JSON.stringify(cache)}\n`);
          }
          serializedPayload = serializedByCache.get(cache);
        }
        await writeCache(filename, cache, serializedPayload);
      }
    });
    generation.operation = operation;
    cacheWriteChain = operation.catch(() => {});
    operation.catch((error) => {
      backgroundCacheWriteError ||= error;
    });
    operation.then(generation.resolve, generation.reject);
    return operation;
  }

  function scheduleCacheFlush() {
    if (!pendingCacheGeneration) pendingCacheGeneration = createCacheGeneration();
    const generation = pendingCacheGeneration;
    if (!generation.timer) {
      generation.timer = setTimeout(() => {
        beginCacheFlush(generation).catch(() => {});
      }, Math.max(0, Number(cacheFlushDebounceMs) || 0));
    }
    return generation;
  }

  function saveCache(runDir, cache) {
    const filenames = [path.join(path.resolve(runDir), "1688_cache.json"), sharedCachePath]
      .filter(Boolean)
      .map((filename) => path.resolve(filename));
    const generation = scheduleCacheFlush();
    for (const filename of new Set(filenames)) {
      generation.writes.set(filename, cache);
    }
    // Estimates must not spend their public 1688 deadline rewriting the
    // ever-growing run and shared cache snapshots. The generation remains
    // tracked and close() still flushes it durably.
    generation.promise.catch(() => {});
    return generation.promise;
  }

  async function flushCacheWrites() {
    while (pendingCacheGeneration) {
      await beginCacheFlush(pendingCacheGeneration).catch(() => {});
    }
    await cacheWriteChain;
    if (backgroundCacheWriteError) {
      const error = backgroundCacheWriteError;
      backgroundCacheWriteError = null;
      throw error;
    }
  }

  async function estimateUncached(item, runDir, {
    budget = Math.max(1, Number(totalBudgetMs) || 15_000),
    deadlineAt = Date.now() + Math.max(1, Number(totalBudgetMs) || 15_000),
    signal = null,
  } = {}) {
      const estimateStartedAt = Date.now();
      let sku;
      try {
        sku = safeSku(item?.sku);
      } catch (error) {
        return { ok: false, error: { code: error.code || "invalid-sku", message: error.message } };
      }

      const root = path.resolve(runDir);
      const imageDir = path.join(root, "images");
      const outputDir = path.join(root, "1688");
      const imagePath = path.join(imageDir, `${sku}.jpg`);
      const outputPath = path.join(outputDir, `${sku}.out`);
      let processStarted = false;

      try {
        await fs.mkdir(imageDir, { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });

        if ((item?.excluded_1688_offer_ids || []).length === 0 && await readableFile(outputPath)) {
          const cachedText = await fs.readFile(outputPath, "utf8");
          if (/^P70_COST\s+/m.test(cachedText)) {
            const cached = parseCostOutput(cachedText, item?.sell_price, parseOptions(item));
            if (cached.ok) {
              return applyMatchPolicy({ ...cached, cached: true, outputPath }, root, {
                expectedPriceCny: item?.sell_price,
              });
            }
          }
        }

        if (!(await readableFile(imagePath))) {
          const imageUrl = String(item?.cover_image || "").trim();
          if (!/^https?:\/\//i.test(imageUrl)) throw Object.assign(new Error("valid cover image URL is required"), { code: "invalid-cover-image" });
          await downloadImage(imageUrl, imagePath, { deadlineAt, budget });
          if (!(await readableFile(imagePath))) throw Object.assign(new Error("cover image download produced no file"), { code: "empty-image" });
        }

        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw totalBudgetError(budget);
        processStarted = true;
        const result = await run1688Process(
          imagePath,
          Math.min(Number(process.env.FLOW_B_1688_ITEM_TIMEOUT || 90) * 1000, remaining),
          item,
          { signal },
        );
        const stdout = String(result?.stdout || "");
        const stderr = String(result?.stderr || "");
        const combined = `${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`;
        await fs.writeFile(outputPath, combined, "utf8");
        if (Number(result?.code) !== 0) {
          const parsed = parseCostOutput(combined, item?.sell_price, parseOptions(item));
          const transportError = isTransient1688TransportFailure(result, combined);
          return {
            ok: false,
            reason: transportError
              ? "1688 transient transport failure"
              : lineValue(combined, "REASON") || parsed.reason || `1688 process exited ${result?.code}`,
            ...(parsed.adaptive_match ? { adaptive_match: parsed.adaptive_match } : {}),
            process_code: Number(result?.code),
            transport_error: transportError,
            retry_count: Number(result?.retry_count) || Number(lineValue(combined, "TRANSIENT_RETRY_COUNT")) || 0,
            outputPath,
            health_probe: result?.health_probe === true,
          };
        }
        const parsed = {
          ...parseCostOutput(combined, item?.sell_price, parseOptions(item)),
          process_code: 0,
          cached: false,
          outputPath,
          health_probe: result?.health_probe === true,
        };
        return applyMatchPolicy(parsed, root, {
          elapsedMs: Date.now() - estimateStartedAt,
          recordShadowSample: parsed.ok === true,
          expectedPriceCny: item?.sell_price,
        });
      } catch (error) {
        if (processStarted) {
          const evidence = [
            String(error?.stdout || ""),
            "STDERR:",
            String(error?.stderr || ""),
            "ERROR:",
            String(error?.message || error),
          ].join("\n");
          await fs.writeFile(outputPath, evidence, "utf8").catch(() => {});
        }
        return {
          ok: false,
          error: { code: error?.code || "cost-estimate-failed", message: String(error?.message || error) },
          outputPath,
        };
      }
  }

  async function estimateWithinBudget(item, runDir, {
    budget,
    deadlineAt,
    signal,
    onTimeout,
  }) {
    const key = cacheKey(item);
    if (!key) return estimateUncached(item, runDir, { budget, deadlineAt, signal });
    const root = path.resolve(runDir);
    const compositeKey = `${root}:${key}`;
    const cache = await loadCache(root);
    const cached = cache.entries[key];
    const cachedHealthRetryCount = Math.max(0, Number(cached?.health_retry_count) || 0);
    if (cached?.output) {
      const parsed = parseCostOutput(cached.output, item?.sell_price, parseOptions(item));
      const legacyCandidateCollapse = cached.terminal === true
        && cached.deferred !== true
        && isCandidateCollapse({ ...parsed, reason: cached.reason || parsed.reason });
      const legacyTransportFailure = cached.terminal === true && Number(cached.process_code) === 1;
      const expiresAt = Date.parse(String(cached.expires_at || ""));
      if (!legacyCandidateCollapse && !legacyTransportFailure && cached.deferred && Number.isFinite(expiresAt) && expiresAt > now()) {
        return {
          ...parsed,
          reason: cached.reason || parsed.reason,
          deferred: true,
          terminal: false,
          retry_at: cached.expires_at,
          health: cached.health || healthMetadata(),
          process_code: Number.isFinite(Number(cached.process_code)) ? Number(cached.process_code) : undefined,
          transport_error: cached.transport_error === true,
          retry_count: Number(cached.retry_count) || 0,
          cached: true,
          shared_cache: true,
          cross_run_cache: crossRunKeysByRun.get(root)?.has(key) === true,
          cache_key: key,
        };
      }
      if (!legacyCandidateCollapse && !legacyTransportFailure && (parsed.ok || cached.terminal)) {
        return applyMatchPolicy({
          ...parsed,
          process_code: Number.isFinite(Number(cached.process_code)) ? Number(cached.process_code) : undefined,
          cached: true,
          shared_cache: true,
          cross_run_cache: crossRunKeysByRun.get(root)?.has(key) === true,
          cache_key: key,
        }, root, { expectedPriceCny: item?.sell_price });
      }
    }
    if (inFlight.has(compositeKey)) {
      const result = await inFlight.get(compositeKey);
      return { ...result, shared_cache: true, cache_key: key };
    }
    let isHealthProbe = false;
    if (health.circuit === "open") {
      const probeBackoff = Math.max(0, Number(healthProbeBackoffMs) || 0);
      if (health.probeInFlight || now() < health.nextProbeAt) {
        const retryAtMs = Math.max(health.nextProbeAt, now() + probeBackoff, now() + 1);
        return {
          ok: false,
          reason: "1688 health circuit backoff",
          deferred: true,
          terminal: false,
          retry_at: new Date(retryAtMs).toISOString(),
          health: healthMetadata({
            probe_blocked: !health.probeInFlight,
            probe_in_flight: health.probeInFlight,
          }),
          shared_cache: false,
          cache_key: key,
        };
      }
      health.probeInFlight = true;
      isHealthProbe = true;
    }
    const rawOperation = (async () => {
      let result;
      let healthRetryCount = cachedHealthRetryCount;
      try {
        result = await estimateUncached(item, root, { budget, deadlineAt, signal });
        if (isCandidateCollapse(result) || result?.transport_error === true) {
          const transportFailure = result?.transport_error === true;
          health.reason = transportFailure
            ? "1688-transient-transport-failure"
            : "1688-first-page-candidate-collapse";
          healthRetryCount += 1;
          health.consecutiveFailures += 1;
          const thresholdReached = health.consecutiveFailures >= Math.max(1, Number(healthFailureThreshold) || 1);
          if (thresholdReached || isHealthProbe) {
            const wasOpen = health.circuit === "open";
            health.circuit = "open";
            health.openedAt ||= new Date(now()).toISOString();
            health.nextProbeAt = now() + Math.max(0, Number(healthProbeBackoffMs) || 0);
            if (!wasOpen || isHealthProbe) await rebuildOwnedWorkerPool();
          }
          const isolatedRetryExhausted = !transportFailure
            && health.circuit !== "open"
            && healthRetryCount > Math.max(0, Number(healthSkuRetryLimit) || 0);
          if (isolatedRetryExhausted) {
            result = { ...result, terminal: true, health_retry_count: healthRetryCount, health: healthMetadata() };
          } else {
            const delay = health.circuit === "open"
              ? Math.max(health.nextProbeAt - now(), 1)
              : Math.max(1, Number(healthDeferredTtlMs) || 1);
            result = {
              ...result,
              deferred: true,
              terminal: false,
              retry_at: new Date(now() + delay).toISOString(),
              health_retry_count: healthRetryCount,
              health: healthMetadata(),
            };
          }
        } else if (result?.ok) {
          const recovered = isHealthProbe && health.circuit === "open";
          health.circuit = "closed";
          health.consecutiveFailures = 0;
          health.openedAt = null;
          health.nextProbeAt = 0;
          health.reason = null;
          result = {
            ...result,
            health_retry_count: 0,
            health: healthMetadata(recovered ? { recovered: true } : {}),
          };
        } else if (isHealthProbe) {
          health.nextProbeAt = now() + Math.max(0, Number(healthProbeBackoffMs) || 0);
          await rebuildOwnedWorkerPool();
          result = {
            ...result,
            deferred: true,
            terminal: false,
            retry_at: new Date(Math.max(health.nextProbeAt, now() + 1)).toISOString(),
            health_retry_count: healthRetryCount,
            health: healthMetadata(),
          };
        } else {
          health.consecutiveFailures = 0;
          health.reason = null;
        }
      } finally {
        if (isHealthProbe) health.probeInFlight = false;
      }
      if (result?.outputPath && (result?.ok || result?.reason)) {
        const output = await fs.readFile(result.outputPath, "utf8");
        cache.entries[key] = {
          output: compactTerminalCostOutput(output, result.reason),
          terminal: result.deferred !== true,
          deferred: result.deferred === true,
          expires_at: result.retry_at,
          reason: result.reason,
          health: result.health,
          health_retry_count: result.health_retry_count,
          process_code: result.process_code,
          transport_error: result.transport_error === true,
          retry_count: Number(result.retry_count) || 0,
          source_image: String(item.cover_image),
          updated_at: new Date().toISOString(),
        };
        crossRunKeysByRun.get(root)?.delete(key);
        void saveCache(root, cache);
      }
      return { ...result, shared_cache: false, cache_key: key };
    })();
    const operation = withinTotalBudget(rawOperation, {
      deadlineAt,
      budget,
      onTimeout,
    });
    inFlight.set(compositeKey, operation);
    try {
      return await operation;
    } finally {
      inFlight.delete(compositeKey);
      if (isHealthProbe && signal?.aborted) health.probeInFlight = false;
    }
  }

  async function estimate(item, runDir) {
    const files = profitFiles.current();
    void profitFiles.snapshot().catch(() => {});
    const excludedOfferIds = feedbackExcludedOfferIds(files.feedback, item?.sku);
    const effectiveItem = excludedOfferIds.length > 0
      ? { ...item, excluded_1688_offer_ids: excludedOfferIds }
      : item;
    const sourceDecision = manualFeedbackDecision(files.feedback, {
      sourceSku: item?.sku,
    });
    if (sourceDecision.blocked) {
      return {
        ok: false,
        terminal: true,
        feedback_blocked: true,
        reason: sourceDecision.reason,
      };
    }
    const trusted = trustedFeedbackCost(files.feedback, item);
    if (trusted) {
      const trustedDecision = manualFeedbackDecision(files.feedback, {
        sourceSku: item?.sku,
        matchEvidenceKey: trusted.match_evidence_key,
        offerIds: [trusted.selected_offer_id],
      });
      if (trustedDecision.blocked) {
        return {
          ...trusted,
          ok: false,
          terminal: true,
          feedback_blocked: true,
          reason: trustedDecision.reason,
        };
      }
      return {
        ...trusted,
        adaptive_action_override: "ALLOW",
        adaptive_action_override_source: "trusted-verified-feedback",
        adaptive_action_policy_configured: configuredAdaptiveActionPolicy,
        adaptive_action_policy_effective: configuredAdaptiveActionPolicy,
      };
    }
    const budget = Math.max(1, Number(totalBudgetMs) || 15_000);
    const deadlineAt = Date.now() + budget;
    const controller = new AbortController();
    const onTimeout = () => controller.abort(totalBudgetError(budget));
    const result = await withinTotalBudget(
      estimateWithinBudget(effectiveItem, runDir, {
        budget,
        deadlineAt,
        signal: controller.signal,
        onTimeout,
      }),
      { deadlineAt, budget, onTimeout },
    );
    const adaptiveActionRejected = result?.adaptive_action_rejected === true;
    if (!result?.ok && !adaptiveActionRejected) return result;
    const selectedOfferIds = String(result?.selected_offer_id || "").trim()
      ? [String(result.selected_offer_id).trim()]
      : (Array.isArray(result?.selected_offer_ids) && result.selected_offer_ids.length === 1
        ? result.selected_offer_ids.map(String)
        : []);
    const decision = manualFeedbackDecision(files.feedback, {
      sourceSku: item?.sku,
      matchEvidenceKey: result?.match_evidence_key,
      offerIds: selectedOfferIds,
    });
    if (decision.blocked) {
      return {
        ...result,
        ok: false,
        terminal: true,
        feedback_blocked: true,
        reason: decision.reason,
      };
    }
    if (adaptiveActionRejected) return result;
    if (Number(decision.cost_override) > 0) {
      return {
        ...result,
        estimated_cost: result.cost,
        cost: Number(decision.cost_override),
        manual_cost_override: true,
        manual_feedback_trusted: decision.trusted === true,
      };
    }
    return decision.trusted === true
      ? { ...result, manual_feedback_trusted: true }
      : result;
  }

  return {
    async refreshProfitFeedback({ force = true } = {}) {
      await profitFilesReady;
      if (force) {
        profitFilesReady = profitFiles.snapshot({ force: true }).catch(() => profitFiles.current());
      }
      return profitFilesReady;
    },
    estimate,
    async close() {
      let closeError = null;
      await flushCacheWrites().catch((error) => { closeError ||= error; });
      await matchPolicyWriteChain.catch((error) => { closeError ||= error; });
      await workerPool?.close?.().catch(() => {});
      await ownedWorkerPool?.close?.().catch(() => {});
      ownedWorkerPool = null;
      if (closeError) throw closeError;
    },
  };
}
