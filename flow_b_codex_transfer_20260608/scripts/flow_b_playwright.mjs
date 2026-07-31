#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { ensureMaoziLogin, ensureMaoziPluginLogin, launchFlowContext, openMaoziPage, resolveBrowserOptions } from "./flow_b_playwright/browser-context.mjs";
import { createCostBridge } from "./flow_b_playwright/cost-bridge.mjs";
import { createMaoziClient, createMaoziPageTransport } from "./flow_b_playwright/maozi-client.mjs";
import { createOzonDetailProvider } from "./flow_b_playwright/ozon-detail.mjs";
import { ozonAccessControllerFor } from "./flow_b_playwright/ozon-access-controller.mjs";
import { createLowTokenInterventionController } from "./flow_b_playwright/low-token-intervention.mjs";
import { createPublishRunner } from "./flow_b_playwright/publish-runner.mjs";
import { createPublishState } from "./flow_b_playwright/publish-state.mjs";
import { scanSources } from "./flow_b_playwright/source-scanner.mjs";
import { runReadOnlyVerification } from "./flow_b_playwright/verification.mjs";
import { acceptanceSummary, collectionErrorSummary, isFatalBrowserError, operationalErrorSummary, perStoreAcceptanceTarget, rankSourcesByYield, runProducerLoop, summarizeConsumerRound, withRuntimeCleanup } from "./flow_b_playwright/continuous-runtime.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_PROFILE = path.join(ROOT, "runs/flow_b/playwright_setup/playwright_profile");
const DEFAULT_STORE_TARGETS = Object.freeze([
  { id: 106637, needle: "丽丽二号", warehouseId: 1020005023256510, requireWarehouse: true },
  { id: 106640, needle: "丽丽三号", warehouseId: 1020005023616740, requireWarehouse: true },
  { id: 106644, needle: "丽丽四号", warehouseId: 1020005023616380, requireWarehouse: true },
  { id: 106646, needle: "丽丽五号", warehouseId: 1020005023616970, requireWarehouse: true },
  { id: 104965, needle: "丽丽1号", warehouseId: 1020005023597900, requireWarehouse: true },
]);

function required(value, label) {
  if (!value || String(value).startsWith("--")) throw new Error(`${label} is required`);
  return path.resolve(String(value));
}

function runtimeDefaults(env) {
  const threshold = Number(env.FLOW_B_PROFIT_THRESHOLD ?? 30);
  const target = Number(env.FLOW_B_TARGET_PUBLISH_COUNT ?? 500);
  if (!Number.isFinite(threshold)) throw new Error("FLOW_B_PROFIT_THRESHOLD must be numeric");
  if (!Number.isInteger(target) || target <= 0) throw new Error("FLOW_B_TARGET_PUBLISH_COUNT must be a positive integer");
  const storeNeedle = String(env.FLOW_B_STORE_NEEDLE ?? "丽丽1号").trim();
  const watermarkNeedle = String(env.FLOW_B_WATERMARK_NEEDLE ?? "lysh").trim();
  if (!storeNeedle) throw new Error("FLOW_B_STORE_NEEDLE is required");
  if (!watermarkNeedle) throw new Error("FLOW_B_WATERMARK_NEEDLE is required");
  return { threshold, target, storeNeedle, watermarkNeedle };
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
    if (!(id > 0) || !needle) throw new Error("FLOW_B_STORE_TARGETS entries require a positive id and needle");
    if (warehouseId !== null && !(warehouseId > 0)) throw new Error("FLOW_B_STORE_TARGETS warehouseId must be positive when configured");
    return { id, needle, warehouseId, requireWarehouse: row?.requireWarehouse !== false };
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
  if (command === "run") {
    const runDir = required(rest[0], "RUN_DIR");
    return { command, runDir, urlsFile: required(rest[1], "URLS.txt"), outFile: sourceScanOutputFile(runDir, env), ...defaults };
  }
  if (command === "accept") {
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

function createRuntimeMaoziTransport(page, context, env) {
  return createMaoziPageTransport({
    page,
    context,
    recoverUnauthorized: async (activePage) => {
      await activePage.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      const recoveredPage = await openMaoziPage(context, { settleMs: 1_000 });
      await ensureMaoziLogin(recoveredPage, {
        continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1",
        timeout: 60_000,
      });
      return recoveredPage;
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

async function closePublishingSession(session) {
  if (!session) return;
  await session.detailProvider?.close?.().catch(() => {});
  await session.costBridge?.close?.().catch(() => {});
  await session.state?.close?.().catch(() => {});
  await session.maoziPage?.close?.().catch(() => {});
}

async function createPublishingSession(context, options, env, shared) {
  const maoziPage = await openMaoziPage(context, { forceNew: true });
  let state = null;
  try {
    await ensureMaoziLogin(maoziPage, { continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1" });
    const client = createMaoziClient({ transport: createRuntimeMaoziTransport(maoziPage, context, env) });
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
    });
    const costBridge = createCostBridge({
      python: env.FLOW_B_PYTHON || "python3",
      scriptPath: env.FLOW_B_1688_SCRIPT || path.join(ROOT, "scripts/1688_image_median.py"),
      sharedCachePath: env.FLOW_B_1688_SHARED_CACHE || path.join(ROOT, "data/flow_b/1688_cache.json"),
      seedCacheFiles: String(env.FLOW_B_1688_CACHE_SEED_FILES || "").split(path.delimiter).filter(Boolean),
    });
    const detailProvider = createOzonDetailProvider({
      context,
      accessController: ozonAccessControllerFor(context, env),
      timeout: Math.max(1000, Number(env.FLOW_B_OZON_DETAIL_TIMEOUT_MS) || 10000),
      initialConcurrency: Math.max(1, Number(env.FLOW_B_PUBLISH_WORKERS) || 8),
      maxConcurrency: Math.max(1, Number(env.FLOW_B_MAX_PUBLISH_WORKERS) || 12),
    });
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
      reconciliationOnly: env.FLOW_B_RECONCILIATION_ONLY === "1",
      validationOnly: env.FLOW_B_VALIDATION_ONLY === "1",
      validationTarget: Math.max(1, Number(env.FLOW_B_VALIDATION_TARGET) || 3),
      concurrency: Math.max(1, Number(env.FLOW_B_PUBLISH_WORKERS) || 8),
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
      onlineSyncIntervalMs: Math.max(0, Number(env.FLOW_B_ONLINE_SYNC_INTERVAL_MS) || 1_800_000),
      urgentOnlineSyncIntervalMs: Math.max(0, Number(env.FLOW_B_URGENT_ONLINE_SYNC_INTERVAL_MS) || 600_000),
      urgentOnlineSyncPendingCount: Math.max(1, Number(env.FLOW_B_URGENT_ONLINE_SYNC_PENDING_COUNT) || 20),
      warehouseId: env.FLOW_B_WAREHOUSE_ID || null,
      initialStock: Math.max(1, Number(env.FLOW_B_INITIAL_STOCK) || 1),
      dailyStoreLimit: Math.max(1, Number(env.FLOW_B_DAILY_STORE_LIMIT) || 100),
      dailyStoreTimeZone: env.FLOW_B_DAILY_STORE_TIMEZONE || "Asia/Shanghai",
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
      probeInactiveStores: env.FLOW_B_PROBE_INACTIVE_STORES !== "0",
      submissionGateFile: env.FLOW_B_SUBMISSION_GATE_FILE || null,
      requireReliableCostContract: true,
    });
    return { maoziPage, costBridge, detailProvider, runner, state };
  } catch (error) {
    await state?.close?.().catch(() => {});
    await maoziPage.close().catch(() => {});
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
    await ensureMaoziLogin(page, { continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1" });
    await ensureMaoziPluginLogin(context, { continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1" });
    const client = createMaoziClient({ transport: createRuntimeMaoziTransport(page, context, env) });
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
    console.log(JSON.stringify({ ok: true, profile: browserOptions(env).profileDir, message: "请完成 Ozon/Maozi 登录，完成后按 Ctrl+C。" }, null, 2));
    await new Promise(() => {});
  } finally {
    await context.close().catch(() => {});
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
    await ensureMaoziLogin(authPage, { continueDeviceLogin: true, timeout: 60000 });
    await ensureMaoziPluginLogin(context, { continueDeviceLogin: true, timeout: 60000 });
    const authClient = createMaoziClient({ transport: createRuntimeMaoziTransport(authPage, context, {
      ...env,
      FLOW_B_MAOZI_CONTINUE_LOGIN: "1",
    }) });
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
  let producerFatalError = null;
  const scanTask = runProducerLoop({
    deadlineMs: endedAt.getTime(),
    intervalMs: Math.max(1_000, Number(env.FLOW_B_PRODUCER_INTERVAL_MS || 20_000)),
    idleIntervalsMs: String(env.FLOW_B_EMPTY_SOURCE_BACKOFF_MS || "30000,60000,120000")
      .split(",")
      .map(Number),
    isIdleResult: (result) => Number(result?.activity_count || 0) === 0,
    shouldStop: () => Boolean(producerFatalError),
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
      return scanSources({ context, urlsFile: options.urlsFile, outFile: options.outFile, env: runtimeEnv });
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
    while (Date.now() < endedAt.getTime()) {
      if (producerFatalError) throw producerFatalError;
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
      const wait = Math.min(Math.max(1_000, Number(env.FLOW_B_POLL_INTERVAL_MS || 10_000)), endedAt.getTime() - Date.now());
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
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
  flow_b_playwright.mjs run RUN_DIR URLS.txt
  flow_b_playwright.mjs accept RUN_DIR URLS.txt

Required for browser commands: FLOW_B_EXTENSION_DIR=/path/to/unpacked/maozi-plugin
Defaults: profit_rate > 30, target 500, five verified stores with a 100/store/day cap, watermark contains lysh`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseCli(argv, env);
  if (options.command === "help") { printHelp(); return { ok: true, command: "help" }; }
  if (options.command === "setup") return setup(options, env);
  if (options.command === "verify") {
    return withContext(env, (context) => verifyWithContext(context, options, env));
  }
  if (options.command === "scan") {
    return withContext(env, (context) => scanSources({ context, urlsFile: options.urlsFile, outFile: options.outFile, env }));
  }
  if (options.command === "publish") {
    return withContext(env, (context) => publishWithContext(
      context,
      options,
      env,
      {},
      { attemptLimit: publishAttemptLimit(env) },
    ));
  }
  if (options.command === "run") {
    return withContext(env, async (context) => {
      await createRunDir(options.runDir, {
        mode: "playwright-run",
        browser: "playwright-chrome-for-testing",
        urls_file: options.urlsFile,
        scan_output: options.outFile,
        profit_threshold: options.threshold,
        publish_target: options.target,
      });
      const scan = await scanSources({ context, urlsFile: options.urlsFile, outFile: options.outFile, env });
      const publish = await publishWithContext(
        context,
        options,
        env,
        {},
        { attemptLimit: publishAttemptLimit(env) },
      );
      return { scan, publish };
    });
  }
  if (options.command === "accept") {
    return withContext(env, (context) => runAcceptance(context, options, env));
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
    process.exitCode = 1;
  }
}
