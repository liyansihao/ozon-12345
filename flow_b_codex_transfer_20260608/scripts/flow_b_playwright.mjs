#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  ensureMaoziLogin,
  ensureMaoziPluginLogin,
  launchFlowContext,
  openMaoziPage,
  pruneOrphanedFlowPages,
  resolveBrowserOptions,
} from "./flow_b_playwright/browser-context.mjs";
import {
  createCostBridge,
  DEFAULT_1688_CACHE_FLUSH_DEBOUNCE_MS,
  normalize1688CacheFlushDebounceMs,
} from "./flow_b_playwright/cost-bridge.mjs";
import { createDirectWorkerHealthTracker } from "./flow_b_playwright/direct-worker-health.mjs";
import {
  createMaoziClient,
  createMaoziPageTransport,
  MAOZI_FAVORITES_ENDPOINT,
  MAOZI_REQUEST_TIMEOUT_CODE,
} from "./flow_b_playwright/maozi-client.mjs";
import { createOzonDetailProvider } from "./flow_b_playwright/ozon-detail.mjs";
import { loadAuditedSourceArtifact } from "./flow_b_playwright/audited-source-portfolio.mjs";
import { ozonAccessControllerFor } from "./flow_b_playwright/ozon-access-controller.mjs";
import { createLowTokenInterventionController } from "./flow_b_playwright/low-token-intervention.mjs";
import { create1688SupplyVerifier } from "./flow_b_playwright/1688-supply-verifier.mjs";
import {
  createPacedSupplyPageProvider,
  supplyPageMinimumIntervalMs,
} from "./flow_b_playwright/supply-page-pacing.mjs";
import {
  createOnlineSupplyAuditor,
  loadStrictPublicationsReadOnly,
  writeOnlineSupplyAudit,
} from "./flow_b_playwright/online-supply-audit.mjs";
import { createConcurrencyGate, createPublishRunner } from "./flow_b_playwright/publish-runner.mjs";
import { createPublishState } from "./flow_b_playwright/publish-state.mjs";
import { createProfitLearningSidecar } from "./flow_b_playwright/profit-learning-sidecar.mjs";
import { scanSources } from "./flow_b_playwright/source-scanner.mjs";
import { runReadOnlyVerification } from "./flow_b_playwright/verification.mjs";
import {
  loadValidationCandidatesFromEnv,
  withValidationCandidateFavorites,
} from "./flow_b_playwright/validation-candidate-file.mjs";
import { loadValidationCommissionSeedFromEnv } from "./flow_b_playwright/validation-commission-seed.mjs";
import { loadValidationSignedEvidenceReplayFromEnv } from "./flow_b_playwright/validation-signed-evidence-replay.mjs";
import { validationSupplyOnlyFromEnv } from "./flow_b_playwright/validation-supply-only.mjs";
import {
  acceptanceSummary,
  collectionErrorSummary,
  createRuntimeWakeSignal,
  isFatalBrowserError,
  operationalErrorSummary,
  perStoreAcceptanceTarget,
  rankSourcesByYield,
  runProducerLoop,
  runtimeEmptyBackoffIntervals,
  runtimeIdleDelay,
  runtimeRoundHasActivity,
  summarizeConsumerRound,
  withRuntimeCleanup,
  withAuditedAutomaticPublishFavorites,
} from "./flow_b_playwright/continuous-runtime.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_PROFILE = path.join(ROOT, "runs/flow_b/playwright_setup/playwright_profile");
const DEFAULT_STORE_TARGETS = Object.freeze([
  {
    id: 104965,
    needle: "丽丽1号",
    warehouseId: 1020005023597900,
    uralWarehouseId: 1020005026342280,
    weightThresholdGrams: 400,
    weightRouting: true,
    requireWarehouse: true,
  },
  { id: 106637, needle: "丽丽二号", warehouseId: 1020005023256510, uralWarehouseId: 1020005026343390, weightThresholdGrams: 400, weightRouting: true, requireWarehouse: true },
  { id: 106640, needle: "丽丽三号", warehouseId: 1020005023616740, uralWarehouseId: 1020005026339130, weightThresholdGrams: 400, weightRouting: true, requireWarehouse: true },
  { id: 106644, needle: "丽丽四号", warehouseId: 1020005023616380, uralWarehouseId: 1020005026343030, weightThresholdGrams: 400, weightRouting: true, requireWarehouse: true },
  { id: 106646, needle: "丽丽五号", warehouseId: 1020005023616970, uralWarehouseId: 1020005026342580, weightThresholdGrams: 400, weightRouting: true, requireWarehouse: true },
  { id: 113151, needle: "丽丽六号", warehouseId: 1020005024854760, uralWarehouseId: 1020005026343600, weightThresholdGrams: 400, weightRouting: true, requireWarehouse: true },
  { id: 113153, needle: "丽丽七号", warehouseId: 1020005024855310, uralWarehouseId: 1020005026341880, weightThresholdGrams: 400, weightRouting: true, requireWarehouse: true },
  { id: 113154, needle: "丽丽八号", warehouseId: 1020005024855600, uralWarehouseId: 1020005026343890, weightThresholdGrams: 400, weightRouting: true, requireWarehouse: true },
  { id: 113155, needle: "丽丽九号", warehouseId: 1020005024855790, uralWarehouseId: 1020005026344240, weightThresholdGrams: 400, weightRouting: true, requireWarehouse: true },
  { id: 113156, needle: "丽丽十号", warehouseId: 1020005024856090, uralWarehouseId: 1020005026344600, weightThresholdGrams: 400, weightRouting: true, requireWarehouse: true },
]);

function required(value, label) {
  if (!value || String(value).startsWith("--")) throw new Error(`${label} is required`);
  return path.resolve(String(value));
}

function runtimeDefaults(env) {
  const threshold = Number(env.FLOW_B_PROFIT_THRESHOLD ?? 30);
  const target = Number(env.FLOW_B_TARGET_PUBLISH_COUNT ?? 500);
  if (!Number.isFinite(threshold)) throw new Error("FLOW_B_PROFIT_THRESHOLD must be numeric");
  if (!Number.isInteger(target) || target < 0) {
    throw new Error("FLOW_B_TARGET_PUBLISH_COUNT must be zero (unlimited) or a positive integer");
  }
  const storeNeedle = String(env.FLOW_B_STORE_NEEDLE ?? "丽丽1号").trim();
  const watermarkNeedle = String(env.FLOW_B_WATERMARK_NEEDLE ?? "lysh").trim();
  if (!storeNeedle) throw new Error("FLOW_B_STORE_NEEDLE is required");
  if (!watermarkNeedle) throw new Error("FLOW_B_WATERMARK_NEEDLE is required");
  return { threshold, target, storeNeedle, watermarkNeedle };
}

export function unlimitedPublishTarget(target) {
  return Number(target) === 0;
}

export function ozonDetailQueueSlotCount(env = process.env) {
  return Math.max(1, Number(env.FLOW_B_PUBLISH_WORKERS) || 8);
}

export function parseProfitSafetyActionPolicy(env = {}) {
  const policy = String(env.FLOW_B_PROFIT_SAFETY_ACTION_POLICY ?? "shadow")
    .trim()
    .toLowerCase();
  if (!["shadow", "enforce"].includes(policy)) {
    throw new Error("FLOW_B_PROFIT_SAFETY_ACTION_POLICY must be shadow or enforce");
  }
  return policy;
}

function positiveIntegerList(value, fallback) {
  const parsed = String(value || "")
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry >= 0);
  return parsed.length ? parsed : [...fallback];
}

async function createSupplyVerifierForContext(context, env = process.env) {
  const pageSession = createPacedSupplyPageProvider(context, {
    minimumIntervalMs: supplyPageMinimumIntervalMs(env),
    blockMutatingPurchaseRequests: env.FLOW_B_VALIDATION_ONLY === "1",
  });
  const rawVerifier = create1688SupplyVerifier({
    pageProvider: pageSession.pageProvider,
    retryDelaysMs: positiveIntegerList(env.FLOW_B_SUPPLY_RETRY_DELAYS_MS, [60_000, 600_000]),
    maxCandidates: Math.min(3, Math.max(1, Number(env.FLOW_B_SUPPLY_GATE_MAX_OFFERS) || 3)),
    evidenceTtlMs: Math.max(1_000, Number(env.FLOW_B_SUPPLY_EVIDENCE_TTL_MS) || 1_800_000),
    failureCacheMs: Math.max(0, Number(env.FLOW_B_SUPPLY_FAILURE_CACHE_MS) || 300_000),
  });
  const serial = createConcurrencyGate(1);
  return {
    verifier: {
      verify: (input) => serial.run(() => rawVerifier.verify(input)),
      close: async () => {
        await rawVerifier.close?.().catch(() => {});
        await pageSession.close();
      },
    },
    page: pageSession.page,
  };
}

export function allDirectStoresRejected(publish = {}) {
  return ["daily-product-limit", "store-unavailable"].includes(String(publish?.halt_reason || ""))
    && publish?.stores_exhausted?.all === true;
}

export function isRecoverableForegroundFavoritesTimeout(error) {
  return error?.code === MAOZI_REQUEST_TIMEOUT_CODE
    && String(error?.method || "").toUpperCase() === "GET"
    && String(error?.endpoint || "") === MAOZI_FAVORITES_ENDPOINT
    && !isFatalBrowserError(error);
}

export async function runForegroundPublishAttempt(operation, {
  onRecoverableTimeout = async () => {},
} = {}) {
  if (typeof operation !== "function") throw new TypeError("foreground publish operation is required");
  if (typeof onRecoverableTimeout !== "function") {
    throw new TypeError("onRecoverableTimeout must be a function");
  }
  try {
    return { retry: false, value: await operation() };
  } catch (error) {
    if (!isRecoverableForegroundFavoritesTimeout(error)) throw error;
    await onRecoverableTimeout(error);
    return { retry: true, error };
  }
}

async function writeDailySubmissionWindowMarker(runDir, publish, {
  now = new Date(),
  timeZone = "Asia/Shanghai",
} = {}) {
  const window = publish?.daily_submission_window || {};
  const date = String(window.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  const marker = {
    schema_version: 1,
    observed_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    date,
    time_zone: String(window.time_zone || timeZone),
    daily_window_closed: publish?.daily_window_closed === true,
    submission_complete: publish?.daily_window_closed === true
      || publish?.stores_exhausted?.all === true,
    drained: true,
    daily_submission_window: window,
    halt_reason: publish?.halt_reason || null,
    store_submitted_usage: publish?.store_submitted_usage || {},
    stores_exhausted: publish?.stores_exhausted || null,
  };
  const filename = path.join(runDir, "daily_submission_window.json");
  const temporary = `${filename}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filename);
  const dailyFilename = path.join(runDir, `daily_submission_window_${date}.json`);
  const dailyTemporary = `${dailyFilename}.tmp-${process.pid}`;
  await fs.writeFile(dailyTemporary, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  await fs.rename(dailyTemporary, dailyFilename);
  return marker;
}

export function parseStoreTargets(env = process.env) {
  const source = String(env.FLOW_B_STORE_TARGETS || "").trim();
  if (!source) return DEFAULT_STORE_TARGETS.map((row) => ({ ...row }));
  let rows;
  try {
    rows = JSON.parse(source);
  } catch {
    throw new Error("FLOW_B_STORE_TARGETS must be valid JSON");
  }
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("FLOW_B_STORE_TARGETS must be a non-empty JSON array");
  return rows.map((row) => {
    const id = Number(row?.id);
    const needle = String(row?.needle || row?.name || "").trim();
    const warehouseId = row?.warehouseId === null || row?.warehouseId === undefined ? null : Number(row.warehouseId);
    const uralWarehouseId = row?.uralWarehouseId === null || row?.uralWarehouseId === undefined ? null : Number(row.uralWarehouseId);
  const weightThresholdGrams = Number(row?.weightThresholdGrams ?? 400);
    const weightRouting = row?.weightRouting === true;
    if (!(id > 0) || !needle) throw new Error("FLOW_B_STORE_TARGETS entries require a positive id and needle");
    if (warehouseId !== null && !(warehouseId > 0)) throw new Error("FLOW_B_STORE_TARGETS warehouseId must be positive when configured");
    if (uralWarehouseId !== null && !(uralWarehouseId > 0)) throw new Error("FLOW_B_STORE_TARGETS uralWarehouseId must be positive when configured");
    if (!(weightThresholdGrams > 0)) throw new Error("FLOW_B_STORE_TARGETS weightThresholdGrams must be positive");
    if (weightRouting && uralWarehouseId === null) throw new Error(`FLOW_B_STORE_TARGETS store ${id} requires uralWarehouseId when weight routing is enabled`);
    const target = { id, needle, warehouseId, requireWarehouse: row?.requireWarehouse !== false };
    if (row?.uralWarehouseId !== null && row?.uralWarehouseId !== undefined) target.uralWarehouseId = uralWarehouseId;
    if (row?.weightThresholdGrams !== null && row?.weightThresholdGrams !== undefined) target.weightThresholdGrams = weightThresholdGrams;
    if (row?.weightRouting !== null && row?.weightRouting !== undefined) target.weightRouting = weightRouting;
    return target;
  });
}

export function parseDailyStoreUsageSeed(env = process.env) {
  const source = String(env.FLOW_B_STORE_DAILY_USAGE_SEED || "").trim();
  if (!source) return null;
  let value;
  try { value = JSON.parse(source); }
  catch { throw new Error("FLOW_B_STORE_DAILY_USAGE_SEED must be valid JSON"); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value?.date || "")) || !value?.usage || typeof value.usage !== "object" || Array.isArray(value.usage)) {
    throw new Error("FLOW_B_STORE_DAILY_USAGE_SEED requires date YYYY-MM-DD and an usage object");
  }
  const usage = {};
  for (const [storeId, count] of Object.entries(value.usage)) {
    const id = Number(storeId);
    const numericCount = Number(count);
    if (!(id > 0) || !Number.isInteger(numericCount) || numericCount < 0) {
      throw new Error("FLOW_B_STORE_DAILY_USAGE_SEED usage entries require a positive store ID and non-negative integer count");
    }
    usage[id] = numericCount;
  }
  return { date: String(value.date), usage };
}

export function parseStoreTotalUsageSeed(env = process.env) {
  const source = String(env.FLOW_B_STORE_TOTAL_USAGE_SEED || "").trim();
  if (!source) return {};
  let value;
  try { value = JSON.parse(source); }
  catch { throw new Error("FLOW_B_STORE_TOTAL_USAGE_SEED must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("FLOW_B_STORE_TOTAL_USAGE_SEED must be an object");
  }
  const usage = {};
  for (const [storeId, count] of Object.entries(value)) {
    const id = Number(storeId);
    const numericCount = Number(count);
    if (!(id > 0) || !Number.isInteger(numericCount) || numericCount < 0) {
      throw new Error("FLOW_B_STORE_TOTAL_USAGE_SEED entries require a positive store ID and non-negative integer count");
    }
    usage[id] = numericCount;
  }
  return usage;
}

export function sourceScanOutputFile(runDir, env = process.env) {
  const configured = String(env.FLOW_B_SOURCE_SCAN_STATE_FILE || "source_deep_scan.json").trim();
  if (!/^[a-zA-Z0-9._-]+\.json$/u.test(configured)) {
    throw new Error("FLOW_B_SOURCE_SCAN_STATE_FILE must be a safe JSON filename");
  }
  return path.join(path.resolve(runDir), configured);
}

export function resumedAcceptanceWindow(existingWindow, {
  startedAt,
  endedAt,
  acceptanceTarget,
  targetPolicy,
  minimumAveragePerHourExclusive,
} = {}) {
  const existing = existingWindow && typeof existingWindow === "object" && !Array.isArray(existingWindow)
    ? existingWindow
    : {};
  return {
    ...existing,
    started_at: new Date(startedAt).toISOString(),
    ended_at: new Date(endedAt).toISOString(),
    acceptance_target: Number(acceptanceTarget),
    acceptance_target_policy: String(targetPolicy || "fixed"),
    minimum_average_per_hour_exclusive: minimumAveragePerHourExclusive,
  };
}

export function acceptanceRoundPlan(env = process.env) {
  const positiveInteger = (name, fallback) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
    return value;
  };
  return {
    publish_attempt_limit: positiveInteger("FLOW_B_PUBLISH_TRANCHE_ATTEMPTS", 8),
    refill_target: positiveInteger("FLOW_B_BUFFER_REFILL_TARGET", 8),
    refill_attempt_limit: positiveInteger("FLOW_B_BUFFER_REFILL_ATTEMPT_LIMIT", 24),
  };
}

export function publishAttemptLimit(env = process.env) {
  const raw = String(env.FLOW_B_PUBLISH_ATTEMPT_LIMIT ?? "").trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("FLOW_B_PUBLISH_ATTEMPT_LIMIT must be a positive integer");
  }
  return value;
}

export function parseCli(argv, env = process.env) {
  const args = [...argv];
  if (!args.length || args.includes("--help") || args.includes("-h")) return { command: "help" };
  const [command, ...rest] = args;
  const defaults = runtimeDefaults(env);
  if (command === "setup") {
    return { command, runDir: path.resolve(rest[0] || path.join(ROOT, "runs/flow_b/playwright_setup")), ...defaults };
  }
  if (command === "verify") return { command, ...defaults };
  if (command === "scan") {
    return { command, urlsFile: required(rest[0], "URLS.txt"), outFile: required(rest[1], "OUT.json"), ...defaults };
  }
  if (command === "publish") {
    return { command, runDir: required(rest[0], "RUN_DIR"), ...defaults };
  }
  if (command === "validate-supply") {
    return { command, runDir: required(rest[0], "RUN_DIR"), ...defaults };
  }
  if (command === "audit-supply") {
    return {
      command,
      outputDir: path.resolve(rest[0] || env.FLOW_B_SUPPLY_AUDIT_DIR || path.join(ROOT, "runs/flow_b/supply_audit")),
      ...defaults,
    };
  }
  if (command === "run") {
    const runDir = required(rest[0], "RUN_DIR");
    return { command, runDir, urlsFile: required(rest[1], "URLS.txt"), outFile: sourceScanOutputFile(runDir, env), ...defaults };
  }
  throw new Error(`unknown command: ${command}`);
}

function browserOptions(env) {
  return resolveBrowserOptions({
    ...env,
    FLOW_B_PW_PROFILE: env.FLOW_B_PW_PROFILE || DEFAULT_PROFILE,
  });
}

export function publishedCsvPath(env = process.env) {
  return path.resolve(env.FLOW_B_PUBLISHED_CSV || path.join(ROOT, "data/flow_b/published_links.csv"));
}

function createRuntimeMaoziTransport(page, context, env, initialAccessToken = "") {
  return createMaoziPageTransport({
    page,
    context,
    initialAccessToken,
    recoverUnauthorized: async (activePage) => {
      await activePage.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      const recoveredPage = await openMaoziPage(context, { settleMs: 1_000 });
      const accessToken = await ensureMaoziLogin(recoveredPage, {
        continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1",
        timeout: 60_000,
      });
      return { page: recoveredPage, accessToken };
    },
  });
}

async function createRunDir(runDir, sourceConfig) {
  await fs.mkdir(runDir, { recursive: true });
  const startFile = path.join(runDir, "start_time.txt");
  try { await fs.access(startFile); } catch { await fs.writeFile(startFile, `${new Date().toISOString()}\n`); }
  if (sourceConfig) await fs.writeFile(path.join(runDir, "source_config.json"), `${JSON.stringify(sourceConfig, null, 2)}\n`);
}

export function acceptanceSourceConfig(value = {}) {
  return {
    ...value,
    current_window_only: true,
  };
}

export const DEFAULT_PUBLISHING_CLEANUP_TIMEOUT_MS = 20_000;
export const SIGNAL_PUBLISHING_CLEANUP_TIMEOUT_MS = 10_000;

export function directWorkerSignalStopError(signal) {
  const normalizedSignal = String(signal || "SIGTERM").trim().toUpperCase() || "SIGTERM";
  const error = new Error(`direct worker stopped by ${normalizedSignal} after bounded cleanup`);
  error.code = "FLOW_B_DIRECT_WORKER_SIGNAL_STOP";
  error.signal = normalizedSignal;
  error.exitCode = normalizedSignal === "SIGINT" ? 130 : 143;
  return error;
}

export function directWorkerCleanupError({
  signal = null,
  cleanupError = null,
  signalCacheFlushError = null,
} = {}) {
  if (signal) {
    const signalError = directWorkerSignalStopError(signal);
    signalError.cleanup_error = cleanupError || signalCacheFlushError || null;
    if (signalError.cleanup_error) signalError.cause = signalError.cleanup_error;
    return signalError;
  }
  return signalCacheFlushError || cleanupError || null;
}

export async function runBoundedCleanup(label, operation, {
  timeoutMs = DEFAULT_PUBLISHING_CLEANUP_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof operation !== "function") throw new TypeError("cleanup operation is required");
  const boundedTimeoutMs = Number(timeoutMs);
  if (!Number.isSafeInteger(boundedTimeoutMs) || boundedTimeoutMs <= 0) {
    throw new RangeError("cleanup timeout must be a positive integer");
  }
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeoutFn(() => {
      const error = new Error(`${String(label || "cleanup")} timed out after ${boundedTimeoutMs}ms`);
      error.code = "FLOW_B_CLEANUP_TIMEOUT";
      error.cleanup_label = String(label || "cleanup");
      reject(error);
    }, boundedTimeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    clearTimeoutFn(timer);
  }
}

async function settleBoundedCleanup(steps, options = {}) {
  const results = await Promise.allSettled((steps || []).map(({ label, operation }) => (
    runBoundedCleanup(label, operation, options)
  )));
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "bounded cleanup failed");
}

export async function closePublishingSession(session, {
  timeoutMs = DEFAULT_PUBLISHING_CLEANUP_TIMEOUT_MS,
} = {}) {
  if (!session) return;
  await settleBoundedCleanup([
    ["supply verifier", session.supplyVerifier],
    ["Ozon detail provider", session.detailProvider],
    ["1688 cost bridge", session.costBridge],
    ["publish state", session.state],
    ["Maozi page", session.maoziPage],
  ].filter(([, resource]) => typeof resource?.close === "function")
    .map(([label, resource]) => ({ label, operation: () => resource.close() })), {
    timeoutMs,
  });
}

async function createPublishingSession(context, options, env, shared) {
  // Load and validate the replay input before opening a page. The loader fails
  // closed unless the whole session is explicitly validation-only.
  const validationCandidates = Array.isArray(shared?.validationCandidates)
    ? shared.validationCandidates
    : await loadValidationCandidatesFromEnv(env);
  const validationSupplyOnly = validationSupplyOnlyFromEnv(env);
  const auditedSourceMode = env.FLOW_B_AUDITED_SOURCE_PORTFOLIO === "1";
  const auditedArtifactPath = String(env.FLOW_B_AUDITED_SOURCE_ARTIFACT || "").trim();
  if (auditedSourceMode && !auditedArtifactPath) {
    throw new Error("FLOW_B_AUDITED_SOURCE_ARTIFACT is required in audited source portfolio mode");
  }
  const auditedArtifact = auditedSourceMode
    ? await loadAuditedSourceArtifact(auditedArtifactPath)
    : null;
  const minimumSameItemMatches = Math.max(1, Number(env.FLOW_B_1688_MIN_MATCHES) || 1);
  // Dedicated replay evidence is loaded before any browser page is opened and
  // is unavailable outside snapshot-price validation-only runs.
  const validationSignedEvidenceReplay = shared?.validationSignedEvidenceReplay
    || await loadValidationSignedEvidenceReplayFromEnv(env, {
      candidates: validationCandidates,
      minimumSameItemMatches,
    });
  const validationCommissionSeed = shared?.validationCommissionSeed
    || await loadValidationCommissionSeedFromEnv(env, {
      candidates: validationCandidates,
    });
  let maoziPage = null;
  let state = null;
  let supplyVerifier = null;
  try {
    if (String(env.FLOW_B_SUPPLY_GATE_POLICY || "enforce").trim().toLowerCase() !== "enforce") {
      throw new Error("direct publishing requires FLOW_B_SUPPLY_GATE_POLICY=enforce");
    }
    let liveClient;
    if (validationSupplyOnly) {
      const forbidden = (method) => async () => {
        throw new Error(`Maozi ${method} is forbidden in validation supply-only mode`);
      };
      liveClient = {
        listFavorites: async () => [],
        listAllFavorites: forbidden("listAllFavorites"),
        resolvePublishTarget: forbidden("resolvePublishTarget"),
        listCategoryCommissions: forbidden("listCategoryCommissions"),
        getCategoryBySku: forbidden("getCategoryBySku"),
        calculateProfit: forbidden("calculateProfit"),
        publish: forbidden("publish"),
      };
    } else {
      maoziPage = await openMaoziPage(context, { forceNew: true });
      const accessToken = await ensureMaoziLogin(maoziPage, {
        continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1",
      });
      liveClient = createMaoziClient({
        transport: createRuntimeMaoziTransport(maoziPage, context, env, accessToken),
      });
    }
    const candidateClient = validationCandidates
      ? withValidationCandidateFavorites(liveClient, validationCandidates, { validationOnly: true })
      : liveClient;
    const client = auditedArtifact
      ? withAuditedAutomaticPublishFavorites(candidateClient, {
        runDir: options.runDir,
        artifact: auditedArtifact,
        activeUrlsFile: options.urlsFile,
        validationOnly: env.FLOW_B_VALIDATION_ONLY === "1",
      })
      : candidateClient;
    const runtimeStateDbPath = String(env.FLOW_B_RUNTIME_STATE_DB || "").trim();
    const resolvedRuntimeStateDbPath = runtimeStateDbPath ? path.resolve(runtimeStateDbPath) : null;
    if (
      resolvedRuntimeStateDbPath &&
      (
        resolvedRuntimeStateDbPath === path.resolve(options.runDir) ||
        resolvedRuntimeStateDbPath.startsWith(`${path.resolve(options.runDir)}${path.sep}`)
      )
    ) {
      throw new Error("FLOW_B_RUNTIME_STATE_DB must be outside the disposable run directory");
    }
    state = createPublishState({
      runDir: options.runDir,
      publishedCsv: publishedCsvPath(env),
      pendingStateFiles: String(env.FLOW_B_PENDING_STATE_SEED_FILES || "").split(path.delimiter).filter(Boolean),
      runtimeStateDbPath: resolvedRuntimeStateDbPath,
      enforceTitleUniqueness: env.FLOW_B_DIRECT_PUBLISH !== "1",
      // SQLite is the durable source of truth in direct production. Rewriting
      // the ever-growing compatibility audit on every recoverable session
      // close stalls publishing and can exhaust memory on long-lived runs.
      writeLegacyStateAudit: env.FLOW_B_WRITE_LEGACY_STATE_AUDIT === "1",
      exportRuntimeAuditOnClose: env.FLOW_B_EXPORT_RUNTIME_AUDIT_ON_CLOSE === "1",
    });
    const costBridge = createCostBridge({
      python: env.FLOW_B_PYTHON || "python3",
      scriptPath: env.FLOW_B_1688_SCRIPT || path.join(ROOT, "scripts/1688_image_median.py"),
      sharedCachePath: env.FLOW_B_1688_SHARED_CACHE || path.join(ROOT, "data/flow_b/1688_cache.json"),
      seedCacheFiles: String(env.FLOW_B_1688_CACHE_SEED_FILES || "").split(path.delimiter).filter(Boolean),
      minimumSameItemMatches,
      totalBudgetMs: Math.max(1, Number(env.FLOW_B_1688_TOTAL_BUDGET_MS) || 15_000),
      workerCount: Math.max(1, Number(env.FLOW_B_1688_WORKERS) || 4),
      workerFailureThreshold: Math.max(1, Number(env.FLOW_B_1688_WORKER_FAILURE_THRESHOLD) || 3),
      cacheFlushDebounceMs: normalize1688CacheFlushDebounceMs(
        String(env.FLOW_B_1688_CACHE_FLUSH_DEBOUNCE_MS || "").trim()
          ? env.FLOW_B_1688_CACHE_FLUSH_DEBOUNCE_MS
          : DEFAULT_1688_CACHE_FLUSH_DEBOUNCE_MS,
      ),
      matchPolicy: env.FLOW_B_1688_MATCH_POLICY || "balanced",
      matchPolicySampleSize: Math.max(1, Number(env.FLOW_B_1688_MATCH_SHADOW_SAMPLES) || 100),
      matchPolicyRetentionPercent: Math.max(0, Number(env.FLOW_B_1688_MATCH_MIN_RETENTION_PERCENT) || 75),
      matchPolicyImageAvailabilityPercent: Math.max(0, Number(env.FLOW_B_1688_MATCH_MIN_IMAGE_PERCENT) || 90),
      matchPolicyP95Ms: Math.max(1, Number(env.FLOW_B_1688_MATCH_MAX_P95_MS) || 15_000),
      adaptiveActionPolicy: env.FLOW_B_1688_ADAPTIVE_ACTION_POLICY || "shadow",
      adaptiveActionSampleTarget: Math.max(
        1,
        Number(env.FLOW_B_1688_ADAPTIVE_ACTION_SAMPLE_TARGET) || 100,
      ),
      feedbackFile: env.FLOW_B_PROFIT_FEEDBACK_FILE || null,
      feedbackRefreshMs: Math.max(0, Number(env.FLOW_B_PROFIT_FILE_REFRESH_MS) || 5_000),
      validationSignedEvidenceReplay,
    });
    await costBridge.refreshProfitFeedback?.({ force: false });
    const detailProvider = validationSupplyOnly
      ? {
        getProductDetail: async () => {
          throw new Error("Ozon detail is forbidden in validation supply-only mode");
        },
        close: async () => {},
      }
      : createOzonDetailProvider({
        context,
        accessController: ozonAccessControllerFor(context, env),
        timeout: Math.max(1000, Number(env.FLOW_B_OZON_DETAIL_TIMEOUT_MS) || 10000),
        initialConcurrency: Math.max(
          1,
          Number(env.FLOW_B_OZON_DETAIL_WORKERS)
            || Number(env.FLOW_B_PUBLISH_WORKERS)
            || 8,
        ),
        maxConcurrency: Math.max(
          1,
          Number(env.FLOW_B_MAX_OZON_DETAIL_WORKERS)
            || Number(env.FLOW_B_OZON_DETAIL_WORKERS)
            || Number(env.FLOW_B_MAX_PUBLISH_WORKERS)
            || 12,
        ),
        // Ozon access is globally serialized, so the queue can contain the
        // complete publish worker tranche even when the page pool is deliberately
        // held at one page. Queue TTL must describe callers, not page capacity.
        queueSlotCount: ozonDetailQueueSlotCount(env),
      });
    const supplySession = await createSupplyVerifierForContext(context, env);
    supplyVerifier = supplySession.verifier;
    const runner = createPublishRunner({
      client,
      detailProvider,
      costBridge,
      state,
      runDir: options.runDir,
      target: options.target,
      threshold: options.threshold,
      storeNeedle: options.storeNeedle,
      watermarkNeedle: options.watermarkNeedle,
      storeId: Number(env.FLOW_B_STORE_ID || 104965),
      watermarkId: Number(env.FLOW_B_WATERMARK_ID || 60822),
      storeTargets: parseStoreTargets(env),
      excludedSkus: new Set(
        String(env.FLOW_B_EXCLUDED_SKUS || "")
          .split(/[,\s]+/u)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
      reconciliationOnly: env.FLOW_B_RECONCILIATION_ONLY === "1",
      validationOnly: env.FLOW_B_VALIDATION_ONLY === "1",
      validationUseSnapshotPrice: env.FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE === "1",
      validationSupplyOnly,
      validationSignedEvidenceReplay,
      validationTarget: Math.max(1, Number(env.FLOW_B_VALIDATION_TARGET) || 100),
      validationCommissionSeed,
      concurrency: Math.max(1, Number(env.FLOW_B_PUBLISH_WORKERS) || 8),
      costConcurrency: Math.max(1, Number(env.FLOW_B_1688_WORKERS) || 4),
      maxConcurrency: Math.max(1, Number(env.FLOW_B_MAX_PUBLISH_WORKERS) || 12),
      dryCandidateLimit: Math.max(0, Number(env.FLOW_B_MAX_DRY_CANDIDATES) || 0),
      deadlineAt: env.FLOW_B_DEADLINE_AT || null,
      targetConfigCache: shared.targetConfigCache || null,
      targetRefreshIntervalMs: Math.max(0, Number(env.FLOW_B_TARGET_REFRESH_INTERVAL_MS) || 60_000),
      targetMetricHeartbeatMs: Math.max(0, Number(env.FLOW_B_TARGET_METRIC_HEARTBEAT_MS) || 1_800_000),
      sourceYieldHistoryPath: env.FLOW_B_SOURCE_YIELD_HISTORY || path.join(ROOT, "data/flow_b/source_yield_history.jsonl"),
      publishFeedbackSeedFiles: String(env.FLOW_B_PUBLISH_FEEDBACK_SEED_FILES || "").split(path.delimiter).filter(Boolean),
      candidateFactSeedFiles: String(env.FLOW_B_CANDIDATE_FACT_SEED_FILES || "").split(path.delimiter).filter(Boolean),
      importedFavoriteCleanupLimit: Math.max(0, Number(env.FLOW_B_IMPORTED_FAVORITE_CLEANUP_LIMIT) || 0),
      confirmationAttempts: Math.max(1, Number(env.FLOW_B_CONFIRMATION_ATTEMPTS) || 6),
      confirmationIntervalMs: Math.max(0, Number(env.FLOW_B_CONFIRMATION_INTERVAL_MS) || 2000),
      reconciliationMaxAttempts: String(env.FLOW_B_RECONCILIATION_MAX_ATTEMPTS || "").trim()
        ? Number(env.FLOW_B_RECONCILIATION_MAX_ATTEMPTS)
        : 240,
      reconciliationMaxAgeMs: String(env.FLOW_B_RECONCILIATION_MAX_AGE_MS || "").trim()
        ? Number(env.FLOW_B_RECONCILIATION_MAX_AGE_MS)
        : 24 * 60 * 60 * 1000,
      onlineSyncIntervalMs: Math.max(0, Number(env.FLOW_B_ONLINE_SYNC_INTERVAL_MS) || 1_800_000),
      urgentOnlineSyncIntervalMs: Math.max(0, Number(env.FLOW_B_URGENT_ONLINE_SYNC_INTERVAL_MS) || 600_000),
      urgentOnlineSyncPendingCount: Math.max(1, Number(env.FLOW_B_URGENT_ONLINE_SYNC_PENDING_COUNT) || 20),
      warehouseId: env.FLOW_B_WAREHOUSE_ID || null,
      initialStock: Math.max(1, Number(env.FLOW_B_INITIAL_STOCK) || 1),
      dailyStoreLimit: Math.max(1, Number(env.FLOW_B_DAILY_STORE_LIMIT) || 100),
      dailyStoreTimeZone: env.FLOW_B_DAILY_STORE_TIMEZONE || "Asia/Shanghai",
      enforceDirectDailyLimit: env.FLOW_B_ENFORCE_DIRECT_DAILY_LIMIT === "1",
      dailySubmissionCutoff: env.FLOW_B_DAILY_SUBMISSION_CUTOFF || "23:00",
      dailyReportAfter: env.FLOW_B_DAILY_REPORT_AFTER || "23:30",
      dailyStoreUsageSeed: parseDailyStoreUsageSeed(env),
      totalStoreLimit: Math.max(1, Number(env.FLOW_B_STORE_TOTAL_LIMIT) || 100),
      totalStoreUsageSeed: parseStoreTotalUsageSeed(env),
      totalStoreUsageSeedIncludesRestored: env.FLOW_B_STORE_TOTAL_USAGE_SEED_INCLUDES_RESTORED === "1",
      warehouseSyncAttempts: Math.max(1, Number(env.FLOW_B_WAREHOUSE_SYNC_ATTEMPTS) || 2),
      warehouseSyncIntervalMs: Math.max(0, Number(env.FLOW_B_WAREHOUSE_SYNC_INTERVAL_MS) || 5000),
      unavailableStoreRetryMs: Math.max(0, Number(env.FLOW_B_UNAVAILABLE_STORE_RETRY_MS) || 1_800_000),
      pendingStoreStallMs: Math.max(0, Number(env.FLOW_B_PENDING_STORE_STALL_MS) || 300_000),
      pendingStoreStallCount: Math.max(1, Number(env.FLOW_B_PENDING_STORE_STALL_COUNT) || 3),
      pendingStoreRetryMs: Math.max(0, Number(env.FLOW_B_PENDING_STORE_RETRY_MS) || 300_000),
      probeInactiveStores: false,
      submissionGateFile: null,
      requireReliableCostContract: true,
      directMode: true,
      directRunControl: shared.directRunControl || null,
      minimumSameItemMatches: Math.max(1, Number(env.FLOW_B_1688_MIN_MATCHES) || 1),
      costEstimateTimeoutMs: Math.max(1, Number(env.FLOW_B_1688_TOTAL_BUDGET_MS) || 15_000),
      supplyVerifier,
      requireSupplyGate: true,
      supplyGateMaximumOffers: Math.min(3, Math.max(1, Number(env.FLOW_B_SUPPLY_GATE_MAX_OFFERS) || 3)),
      supplyGateRetryMs: Math.max(1_000, Number(env.FLOW_B_SUPPLY_GATE_RETRY_MS) || 1_800_000),
      profitSafetyActionPolicy: parseProfitSafetyActionPolicy(env),
      profitPriorityFile: env.FLOW_B_PROFIT_PRIORITY_FILE || null,
      profitFeedbackFile: env.FLOW_B_PROFIT_FEEDBACK_FILE || null,
      seasonPriorityFile: env.FLOW_B_SEASON_PRIORITY_FILE || null,
      profitFileRefreshMs: Math.max(0, Number(env.FLOW_B_PROFIT_FILE_REFRESH_MS) || 5_000),
      onProgress: shared.onProgress || (() => {}),
    });
    return { maoziPage, client, costBridge, detailProvider, supplyVerifier, runner, state };
  } catch (error) {
    await supplyVerifier?.close?.().catch(() => {});
    await state?.close?.().catch(() => {});
    await maoziPage?.close?.().catch(() => {});
    throw error;
  }
}

async function publishWithContext(context, options, env, shared = {}, runOptions = {}) {
  await createRunDir(options.runDir);
  const persistent = shared.persistent === true;
  const session = shared.session || await createPublishingSession(context, options, env, shared);
  if (persistent) shared.session = session;
  try {
    return await session.runner.run(runOptions);
  } catch (error) {
    if (persistent) shared.session = null;
    await closePublishingSession(session);
    throw error;
  } finally {
    if (!persistent) await closePublishingSession(session);
  }
}

async function withContext(env, operation) {
  const context = await launchFlowContext(browserOptions(env));
  try {
    return await operation(context);
  } finally {
    await context.close().catch(() => {});
  }
}

async function verifyWithContext(context, options, env) {
  const page = await openMaoziPage(context);
  try {
    const accessToken = await ensureMaoziLogin(page, { continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1" });
    await ensureMaoziPluginLogin(context, { continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1" });
    const client = createMaoziClient({
      transport: createRuntimeMaoziTransport(page, context, env, accessToken),
    });
    const manifest = JSON.parse(await fs.readFile(path.join(browserOptions(env).extensionDir, "manifest.json"), "utf8"));
    return runReadOnlyVerification({
      client,
      extensionVersion: manifest.version,
      storeNeedle: options.storeNeedle,
      watermarkNeedle: options.watermarkNeedle,
    });
  } finally {
    await page.close().catch(() => {});
  }
}

async function setup(options, env) {
  await createRunDir(options.runDir);
  const context = await launchFlowContext(browserOptions(env));
  try {
    await openMaoziPage(context);
    const ozon = await context.newPage();
    await ozon.goto("https://www.ozon.ru/", { waitUntil: "domcontentloaded", timeout: 60000 });
    const alibaba = await context.newPage();
    await alibaba.goto("https://detail.1688.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    console.log(JSON.stringify({
      ok: true,
      profile: browserOptions(env).profileDir,
      message: "请完成 Ozon、Maozi 和 1688 登录；确认 1688 商品详情页可打开后按 Ctrl+C。",
    }, null, 2));
    await new Promise(() => {});
  } finally {
    await context.close().catch(() => {});
  }
}

async function auditSupplyWithContext(context, options, env) {
  const runtimeStateDbPath = String(env.FLOW_B_RUNTIME_STATE_DB || "").trim();
  if (!runtimeStateDbPath) throw new Error("FLOW_B_RUNTIME_STATE_DB is required for the online supply audit");
  await fs.mkdir(options.outputDir, { recursive: true });
  const maoziPage = await openMaoziPage(context, { forceNew: true });
  let costBridge = null;
  let supplyVerifier = null;
  try {
    const accessToken = await ensureMaoziLogin(maoziPage, {
      continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1",
    });
    const client = createMaoziClient({
      transport: createRuntimeMaoziTransport(maoziPage, context, env, accessToken),
    });
    costBridge = createCostBridge({
      python: env.FLOW_B_PYTHON || "python3",
      scriptPath: env.FLOW_B_1688_SCRIPT || path.join(ROOT, "scripts/1688_image_median.py"),
      sharedCachePath: env.FLOW_B_1688_SHARED_CACHE || path.join(ROOT, "data/flow_b/1688_cache.json"),
      seedCacheFiles: String(env.FLOW_B_1688_CACHE_SEED_FILES || "").split(path.delimiter).filter(Boolean),
      minimumSameItemMatches: Math.max(1, Number(env.FLOW_B_1688_MIN_MATCHES) || 1),
      totalBudgetMs: Math.max(1, Number(env.FLOW_B_1688_TOTAL_BUDGET_MS) || 30_000),
      workerCount: 1,
      matchPolicy: "balanced",
      adaptiveActionPolicy: "shadow",
      feedbackFile: env.FLOW_B_PROFIT_FEEDBACK_FILE || null,
      feedbackRefreshMs: Math.max(0, Number(env.FLOW_B_PROFIT_FILE_REFRESH_MS) || 5_000),
    });
    const supplySession = await createSupplyVerifierForContext(context, env);
    supplyVerifier = supplySession.verifier;
    const onlineProducts = await client.listOnlineProducts({
      pageSize: Math.max(1, Number(env.FLOW_B_SUPPLY_AUDIT_PAGE_SIZE) || 100),
      maxPages: Math.max(1, Number(env.FLOW_B_SUPPLY_AUDIT_MAX_PAGES) || 1_000),
    });
    const strictPublications = loadStrictPublicationsReadOnly(path.resolve(runtimeStateDbPath));
    const auditor = createOnlineSupplyAuditor({
      costBridge,
      supplyVerifier,
      now: () => new Date(),
      runDir: options.outputDir,
      checkpointFile: path.join(options.outputDir, "online_supply_audit_checkpoint.jsonl"),
      maximumOffers: Math.min(3, Math.max(1, Number(env.FLOW_B_SUPPLY_GATE_MAX_OFFERS) || 3)),
      failureCacheMs: Math.max(0, Number(env.FLOW_B_SUPPLY_FAILURE_CACHE_MS) || 300_000),
    });
    const audit = await auditor.run({
      onlineProducts,
      strictPublications,
      limit: Math.max(0, Number(env.FLOW_B_SUPPLY_AUDIT_LIMIT) || 0),
      force: env.FLOW_B_SUPPLY_AUDIT_FORCE === "1",
    });
    return writeOnlineSupplyAudit(audit, options.outputDir);
  } finally {
    await closePublishingSession({ supplyVerifier, costBridge, maoziPage });
  }
}

async function readJsonLines(filename) {
  let text = "";
  try { text = await fs.readFile(filename, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

function countsBy(rows, field) {
  const result = {};
  for (const row of rows) {
    const key = String(row?.data?.[field] ?? row?.[field] ?? "unknown");
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function collectionEliminationReason(row) {
  if (row?.reason) return String(row.reason);
  const error = String(row?.error || "");
  if (/missing-shipping-mode/i.test(error)) return "missing-shipping-mode";
  if (/soft blocked/i.test(error)) return "ozon-soft-block";
  if (/target page, context or browser has been closed/i.test(error)) return "browser-context-closed";
  if (/timeout/i.test(error)) return "page-timeout";
  return "collection-failed";
}

export async function writeAcceptanceReport(
  runDir,
  startedAt,
  endedAt,
  target,
  { productionContract = false } = {},
) {
  const publishedEvents = await readJsonLines(path.join(runDir, "published.jsonl"));
  const skipped = await readJsonLines(path.join(runDir, "skipped.jsonl"));
  const failed = await readJsonLines(path.join(runDir, "failed.jsonl"));
  const runtimeErrors = await readJsonLines(path.join(runDir, "runtime_errors.jsonl"));
  const favoriteCollection = await readJsonLines(path.join(runDir, "favorite_collection.jsonl"));
  const timings = await readJsonLines(path.join(runDir, "stage_timings.jsonl"));
  const yieldEvents = await readJsonLines(path.join(runDir, "source_yield.jsonl"));
  const published = publishedEvents.map((row) => ({ ...row, ...(row.data || {}) }));
  let sourceConfig = {};
  try { sourceConfig = JSON.parse(await fs.readFile(path.join(runDir, "source_config.json"), "utf8")); } catch {}
  const minimumAveragePerHourExclusive = productionContract
    ? 35
    : Object.prototype.hasOwnProperty.call(sourceConfig, "minimum_average_per_hour_exclusive")
      ? sourceConfig.minimum_average_per_hour_exclusive
      : 20;
  const reportTarget = productionContract ? 500 : target;
  const reportStoreIds = productionContract
    ? [106637, 106640, 106644, 106646, 104965]
    : (sourceConfig.store_targets || []).map((entry) => entry?.id);
  const acceptance = acceptanceSummary({
    rows: published,
    startedAt,
    endedAt,
    target: reportTarget,
    storeIds: reportStoreIds,
    perStoreTarget: productionContract ? 100 : sourceConfig.per_store_target ?? null,
    minimumAveragePerHourExclusive,
    requireZeroDuplicates: true,
    requireQualityEvidence: productionContract || sourceConfig.require_quality_evidence === true,
    requireCurrentWindowSubmission: productionContract || sourceConfig.current_window_only === true,
    requireExactTarget: productionContract,
    requireExactPerStore: productionContract,
  });
  const windowStart = Date.parse(startedAt);
  const windowEnd = Date.parse(endedAt);
  const favoriteCollectionInWindow = favoriteCollection.filter((row) => {
    const at = Date.parse(row?.at || row?.timestamp || "");
    return at >= windowStart && at <= windowEnd;
  });
  const stageMap = new Map();
  for (const row of timings) {
    const values = stageMap.get(row.stage) || [];
    values.push(Number(row.duration_ms) || 0);
    stageMap.set(row.stage, values);
  }
  const stageSummary = Object.fromEntries([...stageMap].map(([stage, values]) => [stage, {
    count: values.length,
    total_ms: values.reduce((sum, value) => sum + value, 0),
    average_ms: Math.round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)),
  }]));
  const sourceMap = new Map();
  for (const row of yieldEvents) {
    const key = String(row.source_url || "unknown");
    const value = sourceMap.get(key) || { source_url: key, attempted: 0, published: 0, failed: 0, skipped: 0 };
    if (row.status !== "ignored") value.attempted += 1;
    if (row.status in value) value[row.status] += 1;
    sourceMap.set(key, value);
  }
  const sourceYield = rankSourcesByYield([...sourceMap.values()]);
  const report = {
    ...acceptance,
    stage_timings: stageSummary,
    collection_elimination_reasons: countsBy(
      favoriteCollectionInWindow
        .filter((row) => row.status === "rejected" || row.status === "failed")
        .map((row) => ({ ...row, reason: collectionEliminationReason(row) })),
      "reason",
    ),
    elimination_reasons: countsBy(skipped, "reason"),
    failure_reasons: countsBy(failed, "reason"),
    ...collectionErrorSummary(favoriteCollectionInWindow),
    ...operationalErrorSummary({
      successCount: acceptance.success_count,
      skippedCount: skipped.length,
      failedCount: failed.length,
      runtimeErrorCount: runtimeErrors.length,
    }),
    invalid_sku_2815247918_counted: false,
  };
  await Promise.all([
    fs.writeFile(path.join(runDir, "acceptance_summary.json"), `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(path.join(runDir, "stage_summary.json"), `${JSON.stringify(stageSummary, null, 2)}\n`),
    fs.writeFile(path.join(runDir, "source_yield_summary.json"), `${JSON.stringify(sourceYield, null, 2)}\n`),
  ]);
  return report;
}

async function runAcceptance(context, options, env) {
  const durationMs = Math.max(1_000, Number(env.FLOW_B_ACCEPTANCE_SECONDS || 7200) * 1000);
  const acceptanceTarget = Math.max(1, Number(env.FLOW_B_ACCEPTANCE_TARGET || 50));
  const minimumAverageRaw = env.FLOW_B_MINIMUM_AVERAGE_PER_HOUR_EXCLUSIVE;
  const minimumAveragePerHourExclusive = minimumAverageRaw === undefined
    ? 20
    : String(minimumAverageRaw).trim() === ""
      ? null
      : Number(minimumAverageRaw);
  const authPage = await openMaoziPage(context, { forceNew: true, settleMs: 1500 });
  try {
    const accessToken = await ensureMaoziLogin(authPage, { continueDeviceLogin: true, timeout: 60000 });
    await ensureMaoziPluginLogin(context, { continueDeviceLogin: true, timeout: 60000 });
    const authClient = createMaoziClient({ transport: createRuntimeMaoziTransport(authPage, context, {
      ...env,
      FLOW_B_MAOZI_CONTINUE_LOGIN: "1",
    }, accessToken) });
    await Promise.all([authClient.listShops(), authClient.listWatermarks()]);
  } finally {
    await authPage.close().catch(() => {});
  }
  let startedAt = new Date();
  let endedAt = new Date(startedAt.getTime() + durationMs);
  const windowPath = path.join(options.runDir, "acceptance_window.json");
  let existingWindow = {};
  if (env.FLOW_B_RESUME_WINDOW === "1") {
    try {
      existingWindow = JSON.parse(await fs.readFile(windowPath, "utf8"));
      const existingStart = new Date(existingWindow.started_at);
      const existingEnd = new Date(existingWindow.ended_at);
      if (Number.isFinite(existingStart.getTime()) && Number.isFinite(existingEnd.getTime())) {
        startedAt = existingStart;
        endedAt = existingEnd;
      }
    } catch {}
  }
  const runtimeEnv = {
    ...env,
    FLOW_B_DEADLINE_AT: endedAt.toISOString(),
    FLOW_B_MAOZI_CONTINUE_LOGIN: "1",
    FLOW_B_LOG_LEVEL: env.FLOW_B_LOG_LEVEL || "summary",
  };
  const storeTargets = parseStoreTargets(env);
  await createRunDir(options.runDir, acceptanceSourceConfig({
    mode: "continuous-acceptance",
    urls_file: options.urlsFile,
    scan_output: options.outFile,
    window_started_at: startedAt.toISOString(),
    window_ended_at: endedAt.toISOString(),
    publish_target: options.target,
    acceptance_target: acceptanceTarget,
    acceptance_target_policy: env.FLOW_B_ACCEPTANCE_TARGET_POLICY || "fixed",
    minimum_average_per_hour_exclusive: minimumAveragePerHourExclusive,
    per_store_target: perStoreAcceptanceTarget(env),
    require_quality_evidence: true,
    store_id: Number(env.FLOW_B_STORE_ID || 104965),
    store_targets: storeTargets,
    watermark_id: Number(env.FLOW_B_WATERMARK_ID || 60822),
    warehouse_id: env.FLOW_B_WAREHOUSE_ID ? Number(env.FLOW_B_WAREHOUSE_ID) : null,
    initial_stock: Math.max(1, Number(env.FLOW_B_INITIAL_STOCK) || 1),
    daily_store_timezone: env.FLOW_B_DAILY_STORE_TIMEZONE || "Asia/Shanghai",
    initial_concurrency: Number(env.FLOW_B_PUBLISH_WORKERS || 8),
    max_concurrency: Number(env.FLOW_B_MAX_PUBLISH_WORKERS || 12),
  }));
  await fs.writeFile(windowPath, `${JSON.stringify(resumedAcceptanceWindow(existingWindow, {
    startedAt,
    endedAt,
    acceptanceTarget,
    targetPolicy: env.FLOW_B_ACCEPTANCE_TARGET_POLICY || "fixed",
    minimumAveragePerHourExclusive,
  }), null, 2)}\n`);
  const shared = { targetConfigCache: {}, persistent: true, session: null };
  const roundPlan = acceptanceRoundPlan(env);
  const lowTokenController = createLowTokenInterventionController({
    runDir: options.runDir,
    env: runtimeEnv,
  });
  const runtimeWake = createRuntimeWakeSignal();
  const emptyBackoffIntervals = runtimeEmptyBackoffIntervals(runtimeEnv);
  let producerFatalError = null;
  const scanTask = runProducerLoop({
    deadlineMs: endedAt.getTime(),
    intervalMs: Math.max(
      1_000,
      Number(runtimeEnv.FLOW_B_PRODUCER_INTERVAL_MS) || 60_000,
    ),
    idleIntervalsMs: emptyBackoffIntervals,
    isIdleResult: (result) => Number(
      result?.candidate_activity_count ?? result?.activity_count ?? 0,
    ) === 0,
    shouldStop: () => Boolean(producerFatalError),
    onActivity: async () => { runtimeWake.wake(); },
    scan: async () => {
      try {
        await lowTokenController.refresh();
      } catch (error) {
        await fs.appendFile(path.join(options.runDir, "runtime_errors.jsonl"), `${JSON.stringify({
          at: new Date().toISOString(),
          stage: "low-token-intervention",
          error: String(error?.message || error),
        })}\n`);
      }
      return scanSources({
        context,
        urlsFile: options.urlsFile,
        outFile: options.outFile,
        env: runtimeEnv,
        onCandidateActivity: () => runtimeWake.wake(),
      });
    },
    onError: async (error) => {
      await fs.appendFile(path.join(options.runDir, "runtime_errors.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), stage: "producer", error: String(error?.message || error) })}\n`);
      if (isFatalBrowserError(error)) {
        producerFatalError = error;
      }
    },
  });
  return withRuntimeCleanup(async () => {
    let roundSummary;
    let idleStreak = 0;
    while (Date.now() < endedAt.getTime()) {
      if (producerFatalError) throw producerFatalError;
      let roundActive = false;
      try {
        const publishRound = await publishWithContext(
          context,
          options,
          runtimeEnv,
          shared,
          {
            validationOnly: false,
            attemptLimit: roundPlan.publish_attempt_limit,
          },
        );
        roundActive ||= runtimeRoundHasActivity(publishRound);
        roundSummary = summarizeConsumerRound(roundSummary, publishRound);
        if (Date.now() < endedAt.getTime() && !producerFatalError) {
          const refillRound = await publishWithContext(
            context,
            options,
            runtimeEnv,
            shared,
            {
              validationOnly: true,
              validationTarget: roundPlan.refill_target,
              attemptLimit: roundPlan.refill_attempt_limit,
            },
          );
          roundActive ||= runtimeRoundHasActivity(refillRound);
          await fs.appendFile(path.join(options.runDir, "candidate_replenishment.jsonl"), `${JSON.stringify({
            at: new Date().toISOString(),
            mode: "same-worker-validation-only",
            publish_attempt_limit: roundPlan.publish_attempt_limit,
            refill_target: roundPlan.refill_target,
            refill_attempt_limit: roundPlan.refill_attempt_limit,
            validated: Number(refillRound?.validated || 0),
            attempted: Number(refillRound?.attempted || 0),
            validation_only: true,
          })}\n`);
        }
      } catch (error) {
        await fs.appendFile(path.join(options.runDir, "runtime_errors.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), stage: "consumer", error: String(error?.message || error) })}\n`);
        if (isFatalBrowserError(error)) {
          producerFatalError = error;
          break;
        }
      }
      if (roundActive) {
        idleStreak = 0;
        continue;
      }
      idleStreak += 1;
      const wait = Math.min(
        runtimeIdleDelay(idleStreak, emptyBackoffIntervals),
        endedAt.getTime() - Date.now(),
      );
      if (wait > 0) await runtimeWake.wait(wait);
    }
    const scan = await scanTask;
    if (producerFatalError) throw producerFatalError;
    const report = await writeAcceptanceReport(options.runDir, startedAt.toISOString(), endedAt.toISOString(), acceptanceTarget);
    return { report, scan, round_summary: roundSummary || null };
  }, {
    backgroundTask: scanTask,
    cleanup: async () => {
      await closePublishingSession(shared.session);
      shared.session = null;
    },
  });
}

function printHelp() {
  console.log(`Usage:
  flow_b_playwright.mjs setup [RUN_DIR]
  flow_b_playwright.mjs verify
  flow_b_playwright.mjs scan URLS.txt OUT.json
  flow_b_playwright.mjs publish RUN_DIR
  flow_b_playwright.mjs validate-supply RUN_DIR
  flow_b_playwright.mjs audit-supply [OUTPUT_DIR]
  flow_b_playwright.mjs run RUN_DIR URLS.txt

Required for browser commands: FLOW_B_EXTENSION_DIR=/path/to/unpacked/maozi-plugin
Validation-only pacing: FLOW_B_SUPPLY_PAGE_MIN_INTERVAL_MS=N (default 0/off)
Defaults: strict 1688 same-item plus current one-piece orderability evidence, profit_rate > 30, FLOW_B_TARGET_PUBLISH_COUNT=0 for continuous publishing, watermark contains lysh`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseCli(argv, env);
  if (options.command === "help") { printHelp(); return { ok: true, command: "help" }; }
  let validationSnapshotCandidates = null;
  const startupValidationEnv = {
    ...env,
    FLOW_B_VALIDATION_ONLY: options.command === "validate-supply"
      ? "1"
      : options.command === "publish"
        ? env.FLOW_B_VALIDATION_ONLY
        : "0",
  };
  if (["publish", "validate-supply", "audit-supply", "run"].includes(options.command)) {
    // Validate the scope before any browser context is launched. A non-zero
    // pacing override is intentionally available only to read-only validation.
    supplyPageMinimumIntervalMs(startupValidationEnv);
  }
  validationSupplyOnlyFromEnv(startupValidationEnv);
  if (env.FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE === "1") {
    // This read happens before a browser context is launched. Invalid scope,
    // missing files, or malformed candidates therefore fail at startup.
    validationSnapshotCandidates = await loadValidationCandidatesFromEnv(startupValidationEnv);
  }
  const validationSignedEvidenceReplay = await loadValidationSignedEvidenceReplayFromEnv(
    startupValidationEnv,
    {
      candidates: validationSnapshotCandidates,
      minimumSameItemMatches: Math.max(1, Number(env.FLOW_B_1688_MIN_MATCHES) || 1),
    },
  );
  // A configured commission seed is verified before launchFlowContext. Raw and
  // canonical candidate digests, source provenance, complete SKU coverage, and
  // TTL therefore all fail closed before any browser or Maozi request exists.
  const validationCommissionSeed = await loadValidationCommissionSeedFromEnv(
    startupValidationEnv,
    { candidates: validationSnapshotCandidates },
  );
  if (options.command === "setup") return setup(options, env);
  if (options.command === "verify") {
    return withContext(env, (context) => verifyWithContext(context, options, env));
  }
  if (options.command === "scan") {
    return withContext(env, (context) => scanSources({ context, urlsFile: options.urlsFile, outFile: options.outFile, env }));
  }
  if (options.command === "audit-supply") {
    return withContext(env, (context) => auditSupplyWithContext(context, options, env));
  }
  if (options.command === "publish") {
    return withContext(env, (context) => publishWithContext(
      context,
      options,
      env,
      validationSnapshotCandidates ? {
        validationCandidates: validationSnapshotCandidates,
        validationSignedEvidenceReplay,
        validationCommissionSeed,
      } : {},
      { attemptLimit: publishAttemptLimit(env) },
    ));
  }
  if (options.command === "validate-supply") {
    const validationEnv = {
      ...env,
      FLOW_B_DIRECT_PUBLISH: "1",
      FLOW_B_VALIDATION_ONLY: "1",
      FLOW_B_VALIDATION_TARGET: String(Math.max(100, Number(env.FLOW_B_VALIDATION_TARGET) || 100)),
      FLOW_B_RUNTIME_STATE_DB: "",
      FLOW_B_1688_MATCH_POLICY: "balanced",
      FLOW_B_1688_ADAPTIVE_ACTION_POLICY: "shadow",
      FLOW_B_SUPPLY_GATE_POLICY: "enforce",
    };
    return withContext(validationEnv, (context) => publishWithContext(
      context,
      options,
      validationEnv,
      validationSnapshotCandidates ? {
        validationCandidates: validationSnapshotCandidates,
        validationSignedEvidenceReplay,
        validationCommissionSeed,
      } : {},
      { validationOnly: true, validationTarget: Number(validationEnv.FLOW_B_VALIDATION_TARGET) },
    ));
  }
  if (options.command === "run") {
    return withContext(env, async (context) => {
      const directEnv = {
        ...env,
        FLOW_B_DIRECT_PUBLISH: "1",
        FLOW_B_1688_MIN_MATCHES: String(Math.max(1, Number(env.FLOW_B_1688_MIN_MATCHES) || 1)),
        FLOW_B_1688_MATCH_POLICY: env.FLOW_B_1688_MATCH_POLICY || "balanced",
        FLOW_B_1688_ADAPTIVE_ACTION_POLICY: env.FLOW_B_1688_ADAPTIVE_ACTION_POLICY || "shadow",
        FLOW_B_SUPPLY_GATE_POLICY: env.FLOW_B_SUPPLY_GATE_POLICY || "enforce",
        FLOW_B_VALIDATION_ONLY: "0",
      };
      await createRunDir(options.runDir, {
        mode: "direct-publish",
        browser: "playwright-chrome-for-testing",
        urls_file: options.urlsFile,
        scan_output: options.outFile,
        profit_threshold: options.threshold,
        publish_target: unlimitedPublishTarget(options.target) ? null : options.target,
        unlimited_publish: unlimitedPublishTarget(options.target),
        target_metric: unlimitedPublishTarget(options.target)
          ? "daily_erp_accepted_unique_skus"
          : "erp_accepted_unique_skus",
        minimum_same_item_matches: 1,
        match_policy: directEnv.FLOW_B_1688_MATCH_POLICY,
        adaptive_action_policy: directEnv.FLOW_B_1688_ADAPTIVE_ACTION_POLICY || "shadow",
        supply_gate_policy: directEnv.FLOW_B_SUPPLY_GATE_POLICY,
        supply_gate_max_offers: Math.min(3, Math.max(1, Number(directEnv.FLOW_B_SUPPLY_GATE_MAX_OFFERS) || 3)),
        supply_evidence_ttl_ms: Math.max(1_000, Number(directEnv.FLOW_B_SUPPLY_EVIDENCE_TTL_MS) || 1_800_000),
        adaptive_action_sample_target: Math.max(
          1,
          Number(directEnv.FLOW_B_1688_ADAPTIVE_ACTION_SAMPLE_TARGET) || 100,
        ),
      });
      const producerIntervalMs = Math.max(
        1_000,
        Number(directEnv.FLOW_B_PRODUCER_INTERVAL_MS) || 60_000,
      );
      const directWorkerHealth = createDirectWorkerHealthTracker({
        filename: path.join(options.runDir, "direct_worker_health.json"),
        runId: directEnv.FLOW_B_PRODUCTION_RUN_ID || path.basename(options.runDir),
        generation: directEnv.FLOW_B_DIRECT_WORKER_GENERATION
          || `standalone-${process.pid}-${Date.now()}`,
      });
      const recordProducerHealth = async (operation) => {
        try {
          return await operation();
        } catch (error) {
          await fs.appendFile(path.join(options.runDir, "runtime_errors.jsonl"), `${JSON.stringify({
            at: new Date().toISOString(),
            stage: "direct-worker-health",
            error: String(error?.message || error),
          })}\n`).catch(() => {});
          return null;
        }
      };
      let lastProducerHealthProgressAt = 0;
      const recordScanProgress = (progress = {}) => {
        const now = Date.now();
        if (now - lastProducerHealthProgressAt < 30_000) return;
        lastProducerHealthProgressAt = now;
        void recordProducerHealth(() => directWorkerHealth.scanProgress({
          kind: progress.phase || "candidate-activity",
        }));
      };
      const laneProgressAt = new Map();
      const recordRuntimeProgress = (progress = {}) => {
        const lane = String(progress?.lane || "consumer");
        const now = Date.now();
        const last = Number(laneProgressAt.get(lane) || 0);
        const urgent = ["erp-accepted", "productive-work-expected"].includes(progress?.kind);
        if (!urgent && now - last < 30_000) return null;
        laneProgressAt.set(lane, now);
        const operation = lane === "reconciliation"
          ? () => directWorkerHealth.reconciliationProgress({ kind: progress?.kind })
          : () => directWorkerHealth.consumerProgress({
              kind: progress?.kind,
              eligibleBacklogCount: progress?.eligible_backlog_count,
              productiveWatchEligible: progress?.productive_watch_eligible,
            });
        const recorded = recordProducerHealth(operation);
        if (urgent) return recorded;
        void recorded;
        return null;
      };
      await recordProducerHealth(() => directWorkerHealth.start());
      const pageCleanup = directEnv.FLOW_B_PRUNE_ORPHAN_PAGES_ON_START === "1"
        ? await pruneOrphanedFlowPages(context, {
            preserveOrdinaryPages: Math.max(
              0,
              Number(directEnv.FLOW_B_ORPHAN_PAGE_KEEP_COUNT) || 1,
            ),
            closeTimeoutMs: Math.max(
              1,
              Number(directEnv.FLOW_B_ORPHAN_PAGE_CLOSE_TIMEOUT_MS) || 5_000,
            ),
          })
        : {
            observed_pages: context.pages().length,
            closed_pages: 0,
            failed_pages: 0,
            preserved_pages: context.pages().length,
            protected_pages: 0,
            disabled: true,
          };
      await fs.appendFile(path.join(options.runDir, "browser_page_cleanup.jsonl"), `${JSON.stringify({
        at: new Date().toISOString(),
        stage: "direct-worker-start",
        ...pageCleanup,
      })}\n`);
      const directRunControl = {
        cancelled: false,
        fatalError: null,
        rejectedStoreIds: new Set(),
        rejectionReasons: new Map(),
        storeUsageDay: null,
        activeStoreId: null,
        storeSwitchReason: null,
        storeSwitchRequestedAt: null,
      };
      const shared = {
        targetConfigCache: {},
        persistent: true,
        session: null,
        directRunControl,
        onProgress: recordRuntimeProgress,
      };
      const profitLearningSidecar = directEnv.FLOW_B_PROFIT_LEARNING_ENABLED === "1"
        ? createProfitLearningSidecar({
            stateRoot: directEnv.FLOW_B_PRODUCTION_STATE_ROOT,
            runtimeRoot: directEnv.FLOW_B_PROFIT_RUNTIME_ROOT,
            statusPath: directEnv.FLOW_B_PROFIT_LEARNING_STATUS,
            reportStatusPath: directEnv.FLOW_B_PROFIT_REPORT_STATUS,
            outputPath: directEnv.FLOW_B_PROFIT_PRIORITY_FILE,
            feedbackDir: directEnv.FLOW_B_PROFIT_FEEDBACK_DIR,
            feedbackFile: directEnv.FLOW_B_PROFIT_FEEDBACK_FILE,
            feedbackStateFile: directEnv.FLOW_B_PROFIT_FEEDBACK_STATE,
            artifactRuntimeRoot: directEnv.FLOW_B_PROFIT_ARTIFACT_RUNTIME_ROOT,
            nodeModules: directEnv.FLOW_B_PROFIT_NODE_MODULES,
            runtimeDbPath: directEnv.FLOW_B_RUNTIME_STATE_DB,
            sharedCachePath: directEnv.FLOW_B_1688_SHARED_CACHE,
            storeIds: parseStoreTargets(directEnv).map((target) => target.id),
            windowDays: Math.max(1, Number(directEnv.FLOW_B_PROFIT_LOOKBACK_DAYS) || 30),
            minimumCompletedOrders: Math.max(1, Number(directEnv.FLOW_B_PROFIT_MOTHER_MIN_ORDERS) || 3),
            pageSize: Math.max(1, Number(directEnv.FLOW_B_PROFIT_ORDER_PAGE_SIZE) || 100),
            maxPages: Math.max(1, Number(directEnv.FLOW_B_PROFIT_ORDER_MAX_PAGES) || 100),
            intervalMs: Math.max(1_000, Number(directEnv.FLOW_B_PROFIT_POLL_INTERVAL_MS) || 60_000),
            timeZone: directEnv.FLOW_B_DAILY_STORE_TIMEZONE || "Asia/Shanghai",
            maoziClientProvider: () => shared.session?.client || null,
          })
        : null;
      profitLearningSidecar?.start();
      let backgroundStop = false;
      let backgroundError = null;
      const runtimeWake = createRuntimeWakeSignal();
      const stopDirectRun = (error) => {
        directRunControl.cancelled = true;
        directRunControl.fatalError ||= error;
        runtimeWake.wake();
      };
      let gracefulStopSignal = null;
      let signalCacheFlushError = null;
      let signalCacheFlushPromise = Promise.resolve();
      const requestGracefulStop = (signal) => {
        if (gracefulStopSignal) return;
        gracefulStopSignal = String(signal || "SIGTERM");
        directRunControl.cancelled = true;
        signalCacheFlushPromise = runBoundedCleanup(
          "signal 1688 cache flush",
          () => shared.session?.costBridge?.flushPendingCache?.(),
          { timeoutMs: SIGNAL_PUBLISHING_CLEANUP_TIMEOUT_MS },
        );
        signalCacheFlushPromise.catch((error) => {
          signalCacheFlushError ||= error;
          directRunControl.fatalError ||= error;
          runtimeWake.wake();
        });
        runtimeWake.wake();
      };
      const onSigterm = () => requestGracefulStop("SIGTERM");
      const onSigint = () => requestGracefulStop("SIGINT");
      process.on("SIGTERM", onSigterm);
      process.on("SIGINT", onSigint);
      const backgroundEnv = {
        ...directEnv,
        FLOW_B_RECONCILIATION_ONLY: "1",
        FLOW_B_CONFIRMATION_ATTEMPTS: "1",
        FLOW_B_CONFIRMATION_INTERVAL_MS: "0",
      };
      const backgroundTask = (async () => {
        while (!backgroundStop) {
          let backgroundSession = null;
          try {
            await recordProducerHealth(() => directWorkerHealth.reconciliationRoundStarted());
            backgroundSession = await createPublishingSession(
              context,
              options,
              backgroundEnv,
              {
                targetConfigCache: {},
                directRunControl,
                onProgress: recordRuntimeProgress,
              },
            );
            const backgroundResult = await backgroundSession.runner.run();
            await recordProducerHealth(() => directWorkerHealth.reconciliationRoundCompleted(
              backgroundResult,
            ));
            if (runtimeRoundHasActivity(backgroundResult)) runtimeWake.wake();
          } catch (error) {
            await recordProducerHealth(() => directWorkerHealth.reconciliationRoundFailed(error));
            await fs.appendFile(path.join(options.runDir, "runtime_errors.jsonl"), `${JSON.stringify({
              at: new Date().toISOString(),
              stage: "background-reconciliation",
              error: String(error?.message || error),
            })}\n`);
            if (isFatalBrowserError(error)
              || /captcha|验证码|mfa|verification required|login|登录/iu.test(String(error?.message || error))) {
              backgroundError = error;
              stopDirectRun(error);
              return;
            }
          } finally {
            await closePublishingSession(backgroundSession);
          }
          if (!backgroundStop) {
            await new Promise((resolve) => setTimeout(resolve, 15_000));
          }
        }
      })();
      let scan = null;
      let publish = null;
      const deadlineMs = env.FLOW_B_DEADLINE_AT ? Date.parse(env.FLOW_B_DEADLINE_AT) : Number.POSITIVE_INFINITY;
      const emptyBackoffIntervals = runtimeEmptyBackoffIntervals(directEnv);
      let producerStop = false;
      let producerError = null;
      const scanTask = runProducerLoop({
        deadlineMs,
        intervalMs: producerIntervalMs,
        idleIntervalsMs: emptyBackoffIntervals,
        isIdleResult: (result) => Number(
          result?.candidate_activity_count ?? result?.activity_count ?? 0,
        ) === 0,
        shouldStop: () => (
          producerStop
          || backgroundStop
          || Boolean(backgroundError)
          || Boolean(directRunControl.cancelled)
        ),
        onActivity: async () => { runtimeWake.wake(); },
        scan: async () => {
          await recordProducerHealth(() => directWorkerHealth.scanStarted());
          scan = await scanSources({
            context,
            urlsFile: options.urlsFile,
            outFile: options.outFile,
            env: directEnv,
            onCandidateActivity: () => {
              runtimeWake.wake();
              recordScanProgress({ phase: "candidate-activity" });
            },
            onProgress: recordScanProgress,
          });
          await recordProducerHealth(() => directWorkerHealth.scanSucceeded(scan));
          return scan;
        },
        onError: async (error) => {
          await fs.appendFile(path.join(options.runDir, "runtime_errors.jsonl"), `${JSON.stringify({
            at: new Date().toISOString(),
            stage: "direct-source-scan",
            error: String(error?.message || error),
          })}\n`);
          await recordProducerHealth(() => directWorkerHealth.scanFailed(error, {
            retryAt: new Date(Date.now() + producerIntervalMs).toISOString(),
          }));
          if (isFatalBrowserError(error)
            || /captcha|验证码|mfa|verification required|login|登录/iu.test(String(error?.message || error))) {
            producerError = error;
            stopDirectRun(error);
          }
        },
      });
      try {
        let idleStreak = 0;
        while (Date.now() < deadlineMs) {
          if (backgroundError) throw backgroundError;
          if (producerError) throw producerError;
          if (directRunControl.fatalError) throw directRunControl.fatalError;
          if (gracefulStopSignal) break;
          const retryDelayMs = runtimeIdleDelay(idleStreak + 1, emptyBackoffIntervals);
          await recordProducerHealth(() => directWorkerHealth.consumerRoundStarted());
          const foregroundAttempt = await runForegroundPublishAttempt(
            () => publishWithContext(
              context,
              options,
              directEnv,
              shared,
              { attemptLimit: publishAttemptLimit(directEnv) },
            ),
            {
              onRecoverableTimeout: async (error) => {
                const observedAt = new Date();
                await fs.appendFile(path.join(options.runDir, "runtime_recovery.jsonl"), `${JSON.stringify({
                  at: observedAt.toISOString(),
                  stage: "foreground-favorites-list",
                  action: "recreate-maozi-session-and-retry",
                  reason: "maozi-favorites-get-timeout",
                  error_code: String(error.code),
                  endpoint: String(error.endpoint),
                  method: String(error.method).toUpperCase(),
                  phase: String(error.phase || "request"),
                  timeout_ms: Number(error.timeout_ms) || null,
                  retry_in_ms: retryDelayMs,
                  retry_at: new Date(observedAt.getTime() + retryDelayMs).toISOString(),
                  browser_preserved: true,
                  session_discarded: shared.session === null,
                })}\n`);
              },
            },
          );
          if (foregroundAttempt.retry) {
            await recordProducerHealth(() => directWorkerHealth.consumerProgress({
              kind: "recoverable-timeout",
            }));
            idleStreak += 1;
            await runtimeWake.wait(retryDelayMs);
            continue;
          }
          publish = foregroundAttempt.value;
          await recordProducerHealth(() => directWorkerHealth.consumerRoundCompleted(publish));
          await writeDailySubmissionWindowMarker(options.runDir, publish, {
            timeZone: directEnv.FLOW_B_DAILY_STORE_TIMEZONE || "Asia/Shanghai",
          });
          if (publish?.daily_window_closed === true) {
            idleStreak += 1;
            const nextOpenAt = Date.parse(String(publish?.daily_submission_window?.next_open_at || ""));
            const waitUntilOpen = Number.isFinite(nextOpenAt)
              ? Math.max(1_000, nextOpenAt - Date.now())
              : runtimeIdleDelay(idleStreak, emptyBackoffIntervals);
            await runtimeWake.wait(Math.min(waitUntilOpen, 5 * 60_000));
            continue;
          }
          if (!unlimitedPublishTarget(options.target)
            && Number(publish?.accepted || 0) >= options.target) break;
          if (allDirectStoresRejected(publish)) {
            const error = new Error(`all configured stores rejected direct publishing: ${publish.halt_reason}`);
            error.code = "FLOW_B_ALL_STORES_REJECTED";
            throw error;
          }
          if (["daily-product-limit", "store-unavailable"].includes(String(publish?.halt_reason || ""))) {
            idleStreak += 1;
            await runtimeWake.wait(runtimeIdleDelay(idleStreak, emptyBackoffIntervals));
            continue;
          }
          if (!unlimitedPublishTarget(options.target)
            && Number(publish?.direct_target_slots_used || 0) >= options.target) {
            idleStreak += 1;
            await runtimeWake.wait(runtimeIdleDelay(idleStreak, emptyBackoffIntervals));
            continue;
          }
          if (runtimeRoundHasActivity(publish)) {
            idleStreak = 0;
            continue;
          }
          idleStreak += 1;
          await runtimeWake.wait(runtimeIdleDelay(idleStreak, emptyBackoffIntervals));
        }
        return { scan, publish };
      } finally {
        profitLearningSidecar?.stop();
        producerStop = true;
        backgroundStop = true;
        directRunControl.cancelled = true;
        runtimeWake.wake();
        const foregroundSession = shared.session;
        shared.session = null;
        const cleanupTimeoutMs = gracefulStopSignal
          ? SIGNAL_PUBLISHING_CLEANUP_TIMEOUT_MS
          : DEFAULT_PUBLISHING_CLEANUP_TIMEOUT_MS;
        let cleanupError = null;
        try {
          await settleBoundedCleanup([
            { label: "signal 1688 cache flush", operation: () => signalCacheFlushPromise },
            {
              label: "foreground publishing session",
              operation: () => closePublishingSession(foregroundSession, {
                timeoutMs: cleanupTimeoutMs,
              }),
            },
            { label: "background reconciliation", operation: () => backgroundTask },
            { label: "source scanner", operation: () => scanTask },
          ], { timeoutMs: cleanupTimeoutMs });
        } catch (error) {
          cleanupError = error;
        } finally {
          process.off("SIGTERM", onSigterm);
          process.off("SIGINT", onSigint);
        }
        const finalCleanupError = directWorkerCleanupError({
          signal: gracefulStopSignal,
          cleanupError,
          signalCacheFlushError,
        });
        if (finalCleanupError) throw finalCleanupError;
      }
    });
  }
  throw new Error(`unsupported command: ${options.command}`);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const result = await main();
    if (result && result.command !== "help") console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error), stack: error?.stack }, null, 2));
    process.exitCode = Number.isSafeInteger(Number(error?.exitCode))
      ? Number(error.exitCode)
      : 1;
  }
}
