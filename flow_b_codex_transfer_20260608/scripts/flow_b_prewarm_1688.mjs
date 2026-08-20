#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { createCostBridge } from "./flow_b_playwright/cost-bridge.mjs";
import { isPureFbs } from "./flow_b_playwright/publish-policy.mjs";

const BAD_SKUS = new Set(["2815247918"]);
const FACT_FIELDS = ["title", "cover_image", "shipping_mode", "mode", "sale_price", "sell_price", "source_url"];
const ADAPTIVE_V5_VERSION = "adaptive-v5-shadow";
const ADAPTIVE_V5_POLICY_VERSION = "adaptive-v5-policy-1";
export const DEFAULT_1688_SYNC_SCRIPT_PATH = path.resolve(import.meta.dirname, "flow_b_1688_sync.py");

function rounded(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function countPerHour(count, durationSeconds) {
  if (!(durationSeconds > 0)) return 0;
  return rounded(Number(count || 0) * 3600 / durationSeconds, 2);
}

export function candidateCohortIdentity(candidates = []) {
  const skus = [...new Set((candidates || [])
    .map((candidate) => String(candidate?.sku ?? "").trim())
    .filter(Boolean))]
    .sort();
  const payload = skus.length > 0 ? `${skus.join("\n")}\n` : "";
  return {
    candidate_sku_count: skus.length,
    candidate_skus_sha256: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
  };
}

function adaptiveActionPolicy(env = {}) {
  const policy = String(env.FLOW_B_1688_ADAPTIVE_ACTION_POLICY || "shadow").trim().toLowerCase();
  if (!["shadow", "enforce"].includes(policy)) {
    throw new Error("FLOW_B_1688_ADAPTIVE_ACTION_POLICY must be shadow or enforce");
  }
  return policy;
}

function processTelemetry(result) {
  const rawProcessCode = result?.process_code;
  const processCode = rawProcessCode === null
    || rawProcessCode === undefined
    || typeof rawProcessCode === "boolean"
    || String(rawProcessCode).trim() === ""
    ? null
    : Number(rawProcessCode);
  const outputEvidence = typeof result?.outputPath === "string" && result.outputPath.trim().length > 0;
  const actualLiveAttempt = result?.cached !== true
    && outputEvidence
    && Number.isFinite(processCode);
  const processError = Number.isFinite(processCode) && ![0, 2].includes(processCode);
  const normalProcessCompletion = actualLiveAttempt
    && !processError
    && !result?.error
    && result?.deferred !== true;
  return {
    processCode,
    outputEvidence,
    actualLiveAttempt,
    processError,
    normalProcessCompletion,
  };
}

function isCompleteV5AdaptiveAction(result, item) {
  const adaptive = result?.adaptive_match;
  const valuable = adaptive?.valuable_digital;
  const expectedPrice = Number(item?.sell_price);
  const adaptivePrice = valuable?.price_cny;
  const selectedOfferId = String(adaptive?.selected_offer_id || "").trim();
  const stringArray = (value) => Array.isArray(value)
    && value.every((entry) => typeof entry === "string");
  return result?.adaptive_action_complete === true
    && adaptive?.version === ADAPTIVE_V5_VERSION
    && ["FAST", "REVIEW", "REJECT"].includes(adaptive?.decision)
    && typeof adaptive?.score === "number"
    && Number.isFinite(adaptive.score)
    && adaptive.score >= 0
    && adaptive.score <= 100
    && typeof adaptive?.reason === "string"
    && adaptive.reason.trim().length > 0
    && stringArray(adaptive?.hard_conflicts)
    && stringArray(adaptive?.missing_evidence)
    && stringArray(adaptive?.supporting_offer_ids)
    && adaptive?.policy_version === ADAPTIVE_V5_POLICY_VERSION
    && ["ALLOW", "REJECT"].includes(adaptive?.action)
    && adaptive?.evidence_complete === true
    && Array.isArray(adaptive?.policy_reasons)
    && adaptive.policy_reasons.length > 0
    && adaptive.policy_reasons.every((reason) => typeof reason === "string" && reason.trim().length > 0)
    && selectedOfferId.length > 0
    && selectedOfferId === String(result?.selected_offer_id || "").trim()
    && valuable
    && typeof valuable === "object"
    && !Array.isArray(valuable)
    && typeof valuable.applies === "boolean"
    && (typeof valuable.category === "string" || valuable.category === null)
    && (valuable.applies !== true
      || (typeof valuable.category === "string" && valuable.category.trim().length > 0))
    && typeof adaptivePrice === "number"
    && Number.isFinite(adaptivePrice)
    && Number.isFinite(expectedPrice)
    && expectedPrice > 0
    && adaptivePrice === expectedPrice
    && valuable.threshold_cny === 300;
}

async function readJsonLines(filename) {
  let text = "";
  try { text = await fs.readFile(path.resolve(filename), "utf8"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const rows = [];
  for (const line of text.split(/\r?\n/u)) {
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row);
    } catch {}
  }
  return rows;
}

function eventPayload(event) {
  return event?.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? { ...event, ...event.data }
    : event || {};
}

export function selectPrewarmCandidates({ favoriteEvents = [], stateEvents = [], excludedSkus = BAD_SKUS } = {}) {
  const latestFavorite = new Map();
  const latestState = new Map();
  const facts = new Map();
  for (const event of favoriteEvents) {
    const sku = String(event?.sku ?? event?.data?.sku ?? "").trim();
    if (!sku) continue;
    latestFavorite.set(sku, event);
    const payload = eventPayload(event);
    const merged = { ...(facts.get(sku) || {}) };
    for (const field of FACT_FIELDS) {
      if (payload[field] !== null && payload[field] !== undefined && payload[field] !== "") merged[field] = payload[field];
    }
    facts.set(sku, merged);
  }
  for (const event of stateEvents) {
    const sku = String(event?.sku ?? event?.data?.sku ?? "").trim();
    if (sku) latestState.set(sku, event);
  }
  const candidates = [];
  for (const [sku, event] of latestFavorite) {
    if (event?.status !== "favorited" || excludedSkus.has(sku)) continue;
    const latest = latestState.get(sku);
    const latestData = eventPayload(latest);
    if (["published", "skipped"].includes(String(latest?.status || ""))
      || latestData.submitted === true || latestData.submission_pending === true) continue;
    const fact = facts.get(sku) || {};
    const sellPrice = Number(fact.sale_price ?? fact.sell_price);
    if (!fact.title || !/^https?:\/\//iu.test(String(fact.cover_image || ""))
      || !isPureFbs(fact.shipping_mode ?? fact.mode) || !(sellPrice > 0) || !fact.source_url) continue;
    candidates.push({
      sku,
      title: fact.title,
      cover_image: fact.cover_image,
      shipping_mode: fact.shipping_mode ?? fact.mode,
      sale_price: sellPrice,
      sell_price: sellPrice,
      source_url: fact.source_url,
    });
  }
  return candidates;
}

export function createPrewarmCostBridge({
  env = process.env,
  sharedCachePath,
  workerCount = 4,
  createBridge = createCostBridge,
} = {}) {
  if (typeof createBridge !== "function") throw new TypeError("createBridge must be a function");
  const configuredScript = String(env.FLOW_B_1688_SCRIPT || "").trim();
  const actionPolicy = adaptiveActionPolicy(env);
  const rawSampleTarget = Number(env.FLOW_B_1688_ADAPTIVE_ACTION_SAMPLE_TARGET);
  const actionSampleTarget = Number.isFinite(rawSampleTarget) && rawSampleTarget > 0
    ? Math.max(1, Math.floor(rawSampleTarget))
    : 100;
  return createBridge({
    python: env.FLOW_B_PYTHON || "python3",
    scriptPath: path.resolve(configuredScript || DEFAULT_1688_SYNC_SCRIPT_PATH),
    sharedCachePath: path.resolve(sharedCachePath),
    workerCount: Math.max(1, Number(workerCount) || 4),
    adaptiveActionPolicy: actionPolicy,
    adaptiveActionSampleTarget: actionSampleTarget,
  });
}

export async function prewarmCandidateCosts({
  candidates = [],
  bridge,
  runDir,
  concurrency = 4,
  onProgress = () => {},
  onResult = () => {},
  now = () => performance.now(),
} = {}) {
  if (!bridge || typeof bridge.estimate !== "function") throw new TypeError("bridge.estimate is required");
  const queue = [...candidates];
  const summary = {
    candidates: queue.length,
    completed: 0,
    duration_seconds: 0,
    completed_per_hour: 0,
    cache_hits: 0,
    cache_misses: 0,
    seed_price_accepted: 0,
    seed_price_accepted_per_hour: 0,
    rule_rejected: 0,
    errors: 0,
    process_error_count: 0,
    deferred_count: 0,
    health_circuit_backoff_count: 0,
    actual_live_attempt_count: 0,
    actual_live_attempts_per_hour: 0,
    normal_process_completion_count: 0,
    normal_process_completions_per_hour: 0,
    unattempted_count: 0,
    adaptive_fast_count: 0,
    adaptive_review_count: 0,
    adaptive_reject_count: 0,
    adaptive_unclassified_count: 0,
    adaptive_classification_percent: 0,
    adaptive_fast_per_hour: 0,
    adaptive_review_per_hour: 0,
    adaptive_reject_per_hour: 0,
    adaptive_action_count: 0,
    adaptive_action_per_hour: 0,
    adaptive_allow_count: 0,
    adaptive_allow_per_hour: 0,
    adaptive_reject_action_count: 0,
    adaptive_reject_action_per_hour: 0,
    adaptive_action_unassessable_count: 0,
  };
  const startedAt = Number(now());
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      let result;
      try {
        result = await bridge.estimate(item, runDir);
        const {
          actualLiveAttempt,
          normalProcessCompletion,
          processError,
        } = processTelemetry(result);
        if (actualLiveAttempt) summary.actual_live_attempt_count += 1;
        else summary.unattempted_count += 1;
        if (normalProcessCompletion) summary.normal_process_completion_count += 1;
        if (processError) summary.process_error_count += 1;
        if (result?.deferred === true) summary.deferred_count += 1;
        if (/health circuit backoff/iu.test(String(result?.reason || ""))) {
          summary.health_circuit_backoff_count += 1;
        }
        if (result?.cached) summary.cache_hits += 1;
        else summary.cache_misses += 1;
        if (processError || result?.error) summary.errors += 1;
        else if (result?.ok) summary.seed_price_accepted += 1;
        else if (result?.reason) summary.rule_rejected += 1;
        else summary.errors += 1;
        const adaptiveDecision = String(result?.adaptive_match?.decision || "").toUpperCase();
        if (adaptiveDecision === "FAST") summary.adaptive_fast_count += 1;
        else if (adaptiveDecision === "REVIEW") summary.adaptive_review_count += 1;
        else if (adaptiveDecision === "REJECT") summary.adaptive_reject_count += 1;
        else summary.adaptive_unclassified_count += 1;
        const adaptiveAction = String(result?.adaptive_match?.action || "").toUpperCase();
        const completeAction = normalProcessCompletion && isCompleteV5AdaptiveAction(result, item);
        if (completeAction) {
          summary.adaptive_action_count += 1;
          if (adaptiveAction === "ALLOW") summary.adaptive_allow_count += 1;
          else summary.adaptive_reject_action_count += 1;
        } else {
          summary.adaptive_action_unassessable_count += 1;
        }
      } catch (error) {
        result = { ok: false, error: { code: error?.code || "prewarm-exception", message: String(error?.message || error) } };
        summary.cache_misses += 1;
        summary.errors += 1;
        summary.unattempted_count += 1;
        summary.adaptive_unclassified_count += 1;
        summary.adaptive_action_unassessable_count += 1;
      } finally {
        summary.completed += 1;
        onProgress({ ...summary });
        onResult({ item, result });
      }
    }
  }
  const workerCount = Math.min(queue.length || 1, Math.max(1, Number(concurrency) || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const finishedAt = Number(now());
  const durationSeconds = Math.max(0, finishedAt - startedAt) / 1000;
  summary.duration_seconds = rounded(durationSeconds, 6);
  summary.completed_per_hour = countPerHour(summary.completed, durationSeconds);
  summary.actual_live_attempts_per_hour = countPerHour(summary.actual_live_attempt_count, durationSeconds);
  summary.normal_process_completions_per_hour = countPerHour(
    summary.normal_process_completion_count,
    durationSeconds,
  );
  summary.seed_price_accepted_per_hour = countPerHour(summary.seed_price_accepted, durationSeconds);
  const classified = summary.adaptive_fast_count + summary.adaptive_review_count + summary.adaptive_reject_count;
  summary.adaptive_classification_percent = summary.completed > 0
    ? rounded(classified * 100 / summary.completed, 2)
    : 0;
  summary.adaptive_fast_per_hour = countPerHour(summary.adaptive_fast_count, durationSeconds);
  summary.adaptive_review_per_hour = countPerHour(summary.adaptive_review_count, durationSeconds);
  summary.adaptive_reject_per_hour = countPerHour(summary.adaptive_reject_count, durationSeconds);
  summary.adaptive_action_per_hour = countPerHour(summary.adaptive_action_count, durationSeconds);
  summary.adaptive_allow_per_hour = countPerHour(summary.adaptive_allow_count, durationSeconds);
  summary.adaptive_reject_action_per_hour = countPerHour(summary.adaptive_reject_action_count, durationSeconds);
  return summary;
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  { createBridge = createCostBridge, now = () => performance.now() } = {},
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      favorites: { type: "string" },
      states: { type: "string" },
      "run-dir": { type: "string" },
      "shared-cache": { type: "string" },
      workers: { type: "string", default: env.FLOW_B_1688_WORKERS || "4" },
      limit: { type: "string", default: "0" },
      "minimum-products-per-hour": {
        type: "string",
        default: env.FLOW_B_1688_MIN_PRODUCTS_PER_HOUR || "20",
      },
    },
    strict: true,
  });
  for (const name of ["favorites", "states", "run-dir", "shared-cache"]) {
    if (!values[name]) throw new Error(`--${name} is required`);
  }
  const minimumProductsPerHour = Number(values["minimum-products-per-hour"]);
  if (!Number.isFinite(minimumProductsPerHour) || minimumProductsPerHour < 0) {
    throw new Error("--minimum-products-per-hour must be a finite non-negative number");
  }
  const configuredActionPolicy = adaptiveActionPolicy(env);
  if (configuredActionPolicy !== "shadow") {
    throw new Error(
      "live 1688 prewarm evidence collection requires FLOW_B_1688_ADAPTIVE_ACTION_POLICY=shadow; enforce is not allowed",
    );
  }
  const favoriteEvents = await readJsonLines(values.favorites);
  const stateEvents = await readJsonLines(values.states);
  let candidates = selectPrewarmCandidates({ favoriteEvents, stateEvents });
  const limit = Math.max(0, Number(values.limit) || 0);
  if (limit > 0) candidates = candidates.slice(0, limit);
  const candidateCohort = candidateCohortIdentity(candidates);
  const workerCount = Math.max(1, Number(values.workers) || 4);
  const bridge = createPrewarmCostBridge({
    env,
    sharedCachePath: path.resolve(values["shared-cache"]),
    workerCount,
    createBridge,
  });
  let lastReported = 0;
  const failures = [];
  const results = [];
  try {
    const summary = await prewarmCandidateCosts({
      candidates,
      bridge,
      runDir: path.resolve(values["run-dir"]),
      concurrency: workerCount,
      now,
      onProgress(progress) {
        if (progress.completed === progress.candidates || progress.completed - lastReported >= 20) {
          lastReported = progress.completed;
          process.stderr.write(`prewarm ${progress.completed}/${progress.candidates}\n`);
        }
      },
      onResult({ item, result }) {
        const {
          processCode,
          outputEvidence,
          actualLiveAttempt,
          normalProcessCompletion,
        } = processTelemetry(result);
        const resultRow = {
          at: new Date().toISOString(),
          sku: String(item?.sku || ""),
          ok: result?.ok === true,
          cached: result?.cached === true,
          reason: String(result?.reason || ""),
          cost: result?.cost !== null && result?.cost !== undefined
            && String(result.cost).trim() !== "" && Number.isFinite(Number(result.cost))
            ? Number(result.cost)
            : null,
          source: String(result?.source || ""),
          process_code: Number.isFinite(processCode) ? processCode : null,
          deferred: result?.deferred === true,
          actual_live_attempt: actualLiveAttempt,
          normal_process_completion: normalProcessCompletion,
          output_evidence: outputEvidence,
          adaptive_match: result?.adaptive_match && typeof result.adaptive_match === "object"
            ? result.adaptive_match
            : null,
          error: result?.error
            ? {
                code: String(result.error.code || "prewarm-error"),
                message: String(result.error.message || result.error),
              }
            : null,
        };
        results.push(resultRow);
        if (resultRow.error) failures.push({
          at: resultRow.at,
          sku: resultRow.sku,
          cover_image: String(item?.cover_image || ""),
          code: resultRow.error.code,
          error: resultRow.error.message,
        });
      },
    });
    const completedAll = summary.normal_process_completion_count === summary.candidates
      && summary.candidates > 0;
    const attemptedAll = summary.actual_live_attempt_count === summary.candidates
      && summary.unattempted_count === 0;
    const coldCache = summary.cache_hits === 0 && summary.cache_misses === summary.candidates;
    const noProcessErrors = summary.process_error_count === 0;
    const errorFree = summary.errors === 0 && noProcessErrors;
    const noDeferred = summary.deferred_count === 0;
    const noCircuitBackoff = summary.health_circuit_backoff_count === 0;
    const speedPassed = summary.actual_live_attempts_per_hour >= minimumProductsPerHour;
    const adaptiveReadySpeedPassed = summary.adaptive_fast_per_hour >= minimumProductsPerHour;
    const report = {
      generated_at: new Date().toISOString(),
      scope: "live-1688-prewarm",
      adaptive_action_policy: configuredActionPolicy,
      ...summary,
      ...candidateCohort,
      acceptance: {
        metric: "actual_live_recognition_attempts_per_hour",
        minimum_products_per_hour: minimumProductsPerHour,
        measured_products_per_hour: summary.actual_live_attempts_per_hour,
        completed_all_candidates: completedAll,
        attempted_all_candidates: attemptedAll,
        cold_cache: coldCache,
        process_errors_zero: noProcessErrors,
        error_free: errorFree,
        no_deferred_results: noDeferred,
        no_health_circuit_backoff: noCircuitBackoff,
        speed_passed: speedPassed,
        adaptive_action_policy: configuredActionPolicy,
        quality_mode: `${configuredActionPolicy}-not-enforced`,
        does_not_assert: [
          "adaptive_source_correctness",
          "binary_action_correctness",
          "profitability",
        ],
        passed: completedAll && attemptedAll && coldCache && noProcessErrors && errorFree
          && noDeferred && noCircuitBackoff && speedPassed,
      },
      adaptive_ready_observation: {
        metric: "adaptive_fast_products_per_hour",
        minimum_products_per_hour: minimumProductsPerHour,
        measured_products_per_hour: summary.adaptive_fast_per_hour,
        adaptive_action_policy: configuredActionPolicy,
        enforced: configuredActionPolicy === "enforce",
        passed_if_enforced: adaptiveReadySpeedPassed,
      },
      binary_action_observation: {
        metric: "complete_binary_actions_per_hour",
        measured_products_per_hour: summary.adaptive_action_per_hour,
        action_count: summary.adaptive_action_count,
        allow_count: summary.adaptive_allow_count,
        reject_count: summary.adaptive_reject_action_count,
        unassessable_count: summary.adaptive_action_unassessable_count,
        matcher_version_required: ADAPTIVE_V5_VERSION,
        policy_version_required: ADAPTIVE_V5_POLICY_VERSION,
        evidence_complete_required: true,
        readiness: "collecting",
        adaptive_action_policy: configuredActionPolicy,
        quality_mode: `${configuredActionPolicy}-not-enforced`,
        enforced: configuredActionPolicy === "enforce",
        automatic_enforcement: false,
        manual_approval_required: true,
        note: "Live prewarm proves health and throughput only; replay labels are required for approval.",
      },
    };
    await fs.mkdir(path.resolve(values["run-dir"]), { recursive: true });
    if (results.length > 0) {
      await fs.writeFile(
        path.join(path.resolve(values["run-dir"]), "prewarm_1688_results.jsonl"),
        `${results.map((row) => JSON.stringify(row)).join("\n")}\n`,
      );
    }
    if (failures.length > 0) {
      await fs.appendFile(
        path.join(path.resolve(values["run-dir"]), "prewarm_1688_failures.jsonl"),
        `${failures.map((row) => JSON.stringify(row)).join("\n")}\n`,
      );
    }
    await fs.writeFile(path.join(path.resolve(values["run-dir"]), "prewarm_1688_summary.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report;
  } finally {
    await bridge.close();
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main()
    .then((report) => {
      if (report?.acceptance?.passed !== true) process.exitCode = 3;
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
      process.exitCode = 1;
    });
}
