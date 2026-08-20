import fs from "node:fs/promises";
import path from "node:path";

import { buildPriorityMotherProducts, expandMaoziOrderRows } from "./profit-learning.mjs";
import { enrichErpOrderRow, readProfitProductIndex } from "./profit-runtime-data.mjs";
import { importProfitFeedback } from "../import_profit_feedback.mjs";

export const DEFAULT_PROFIT_LEARNING_OUTPUT = "/Users/mac/Desktop/ozon每日上品/优先母款.json";
export const DEFAULT_PROFIT_LEARNING_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_PROFIT_LEARNING_WINDOW_DAYS = 30;

let temporarySequence = 0;

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function errorMessage(error) {
  return text(error?.message || error) || "unknown profit learning error";
}

function validDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(text(value));
}

function dateKeyFor(value, timeZone = "Asia/Shanghai") {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("profit learning now must be a valid timestamp");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function nowDate(value) {
  const candidate = typeof value === "function" ? value() : value;
  const date = candidate instanceof Date ? candidate : new Date(candidate ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError("profit learning now must be a valid timestamp");
  return date;
}

function rowsFrom(value) {
  if (Array.isArray(value)) return value;
  for (const candidate of [value?.rows, value?.data, value?.list, value?.items]) {
    if (Array.isArray(candidate)) return candidate;
  }
  throw new TypeError("profit learning Maozi response must contain an array of rows");
}

async function readJson(filename, fsApi = fs) {
  try {
    return JSON.parse(await fsApi.readFile(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function fileExists(filename, fsApi = fs) {
  try {
    await fsApi.access(filename);
    return true;
  } catch {
    return false;
  }
}

export async function writeProfitLearningJsonAtomic(filename, value, { fsApi = fs } = {}) {
  const absolute = path.resolve(filename);
  await fsApi.mkdir(path.dirname(absolute), { recursive: true });
  temporarySequence += 1;
  const temporary = `${absolute}.tmp-${process.pid}-${temporarySequence}`;
  try {
    await fsApi.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fsApi.rename(temporary, absolute);
  } catch (error) {
    await fsApi.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return absolute;
}

export function profitLearningPaths({
  stateRoot = null,
  runtimeRoot = null,
  statusPath = null,
  reportStatusPath = null,
  outputPath = null,
  outputDir = null,
  env = process.env,
} = {}) {
  const configuredStatus = text(statusPath || env?.FLOW_B_PROFIT_LEARNING_STATUS);
  const configuredRuntime = text(runtimeRoot || env?.FLOW_B_PROFIT_LEARNING_STATE);
  const resolvedRuntimeRoot = path.resolve(
    configuredRuntime
      ? (path.extname(configuredRuntime) ? path.dirname(configuredRuntime) : configuredRuntime)
      : configuredStatus
        ? path.dirname(configuredStatus)
        : path.join(path.resolve(text(stateRoot) || "."), "profit_learning"),
  );
  const resolvedStateRoot = path.resolve(text(stateRoot) || path.dirname(resolvedRuntimeRoot));
  return {
    state_root: resolvedStateRoot,
    runtime_root: resolvedRuntimeRoot,
    status: path.resolve(configuredStatus || path.join(resolvedRuntimeRoot, "status.json")),
    report_status: path.resolve(text(reportStatusPath) || path.join(resolvedStateRoot, "daily_pricing_report_status.json")),
    output: path.resolve(
      text(outputPath)
        || (text(outputDir) ? path.join(outputDir, "优先母款.json") : DEFAULT_PROFIT_LEARNING_OUTPUT),
    ),
  };
}

export function profitLearningDateStatePath(runtimeRoot, dateKey) {
  if (!validDateKey(dateKey)) throw new TypeError("profit learning dateKey must use YYYY-MM-DD");
  return path.join(path.resolve(runtimeRoot), `${dateKey}.json`);
}

async function persistOwnState(paths, dateKey, value, dependencies) {
  const atomicWrite = dependencies.writeJsonAtomic || writeProfitLearningJsonAtomic;
  const fsApi = dependencies.fsApi || fs;
  const dateState = profitLearningDateStatePath(paths.runtime_root, dateKey);
  const state = {
    schema_version: 1,
    ...value,
    date: dateKey,
    date_state: dateState,
  };
  const writes = await Promise.allSettled([
    atomicWrite(dateState, state, { fsApi }),
    atomicWrite(paths.status, state, { fsApi }),
  ]);
  const errors = writes.flatMap((result) => result.status === "rejected" ? [errorMessage(result.reason)] : []);
  return { state, ok: errors.length === 0, errors };
}

function reportFingerprint(report, dateKey, feedbackFingerprint = "") {
  const parts = [
    dateKey,
    text(report?.delivered_at),
    text(report?.output),
  ];
  if (text(feedbackFingerprint)) parts.push(text(feedbackFingerprint));
  return parts.join("|");
}

function negativeFeedbackRows(value = {}) {
  return [
    ...(value?.errors?.records || []),
    ...(value?.trusted?.cost_corrections || []),
  ];
}

async function importLatestFeedback(options, dependencies, fsApi) {
  if (!text(options.feedbackDir)
    || !text(options.feedbackFile)
    || !text(options.feedbackStateFile)
    || !text(options.runtimeDbPath)) return { result: null, error: null, artifact: null, fingerprint: "" };
  const importer = dependencies.importFeedback || importProfitFeedback;
  let result = null;
  let error = null;
  try {
    result = await importer({
      feedbackDir: options.feedbackDir,
      outputFile: options.feedbackFile,
      stateFile: options.feedbackStateFile,
      runtimeDbPath: options.runtimeDbPath,
      sharedCachePath: options.sharedCachePath,
      runtimeRoot: options.artifactRuntimeRoot || options.runtimeRoot,
      nodeModules: options.nodeModules,
      now: nowDate(options.now || dependencies.now),
    });
  } catch (caught) {
    error = errorMessage(caught);
  }
  const artifact = await readJson(path.resolve(options.feedbackFile), fsApi);
  const fingerprint = text(result?.fingerprint || artifact?.updated_at);
  return { result, error, artifact, fingerprint };
}

function refundRow(row = {}) {
  return {
    ...row,
    refund_status_raw: row?.status ?? row?.refund_status ?? null,
    status: "refunded",
    order_time: row?.order_time
      ?? row?.ordered_at
      ?? row?.order_date
      ?? row?.refund_at
      ?? row?.refunded_at
      ?? row?.return_at
      ?? row?.created_at,
    updated_at: row?.updated_at
      ?? row?.refund_at
      ?? row?.refunded_at
      ?? row?.return_at
      ?? row?.created_at,
    refund_cny: row?.refund_cny
      ?? row?.refund_amount_cny
      ?? row?.refund_loss_cny
      ?? row?.return_amount_cny
      ?? row?.amount_cny
      ?? row?.amount,
  };
}

function queryForWindow(startedAt, endedAt, timeZone) {
  return {
    in_process_at_start: dateKeyFor(startedAt, timeZone),
    in_process_at_end: dateKeyFor(endedAt, timeZone),
  };
}

function stateFailure({ prior, dateKey, observedAt, reason, error, output, report, attempt, feedbackFingerprint = "" }) {
  return {
    status: "error",
    reason,
    error: errorMessage(error),
    attempt: Number(attempt ?? prior?.attempt ?? 0),
    observed_at: observedAt,
    failed_at: observedAt,
    output,
    report_status: text(report?.status) || null,
    report_delivered_at: text(report?.delivered_at) || null,
    report_fingerprint: reportFingerprint(report, dateKey, feedbackFingerprint),
  };
}

export async function runProfitLearningOnce(options = {}, dependencies = {}) {
  const fsApi = dependencies.fsApi || fs;
  const paths = profitLearningPaths({ ...options, env: options.env || dependencies.env || process.env });
  let observedAt;
  let targetDate = validDateKey(options.dateKey) ? text(options.dateKey) : null;
  let prior = null;
  let report = null;
  let feedback = { result: null, error: null, artifact: null, fingerprint: "" };
  try {
    const observed = nowDate(options.now || dependencies.now);
    observedAt = observed.toISOString();
    const readReportStatus = dependencies.readReportStatus
      || ((filename) => readJson(filename, fsApi));
    report = await readReportStatus(paths.report_status);
    const deliveredDate = validDateKey(report?.date) ? text(report.date) : null;
    targetDate ||= deliveredDate || dateKeyFor(observed, options.timeZone || "Asia/Shanghai");
    const readState = dependencies.readState || ((filename) => readJson(filename, fsApi));
    prior = await readState(profitLearningDateStatePath(paths.runtime_root, targetDate));
    feedback = await importLatestFeedback(options, dependencies, fsApi);

    if (text(report?.status) !== "delivered" || !deliveredDate || deliveredDate !== targetDate) {
      const waiting = {
        status: "waiting",
        reason: text(report?.status) === "delivered" && deliveredDate
          ? "daily-report-date-mismatch"
          : "daily-report-not-delivered",
        observed_at: observedAt,
        output: paths.output,
        report_status: text(report?.status) || null,
        report_date: deliveredDate,
        attempt: Number(prior?.attempt || 0),
        feedback_import_status: feedback.result?.status || null,
        feedback_import_error: feedback.error,
      };
      const persisted = await persistOwnState(paths, targetDate, waiting, { ...dependencies, fsApi });
      return persisted.ok ? persisted.state : { ...persisted.state, state_write_errors: persisted.errors };
    }

    const fingerprint = reportFingerprint(report, targetDate, feedback.fingerprint);
    const exists = dependencies.fileExists || ((filename) => fileExists(filename, fsApi));
    if (options.force !== true
      && prior?.status === "completed"
      && text(prior?.report_fingerprint) === fingerprint
      && await exists(paths.output)) {
      const reused = {
        ...prior,
        status: "completed",
        reason: "already-completed",
        observed_at: observedAt,
        reused: true,
      };
      const persisted = await persistOwnState(paths, targetDate, reused, { ...dependencies, fsApi });
      return persisted.ok ? persisted.state : { ...persisted.state, state_write_errors: persisted.errors };
    }

    const attempt = Number(prior?.attempt || 0) + 1;
    const running = {
      status: "running",
      reason: "daily-report-delivered",
      attempt,
      observed_at: observedAt,
      started_at: observedAt,
      output: paths.output,
      report_status: "delivered",
      report_delivered_at: text(report.delivered_at) || null,
      report_fingerprint: fingerprint,
      feedback_fingerprint: feedback.fingerprint || null,
      feedback_import_status: feedback.result?.status || null,
      feedback_import_error: feedback.error,
    };
    const runningPersisted = await persistOwnState(paths, targetDate, running, { ...dependencies, fsApi });
    if (!runningPersisted.ok) {
      return {
        ...runningPersisted.state,
        status: "error",
        reason: "state-write-failed",
        state_write_errors: runningPersisted.errors,
      };
    }

    const clientProvider = options.maoziClientProvider || dependencies.maoziClientProvider;
    const maoziClient = options.maoziClient
      || dependencies.maoziClient
      || (typeof clientProvider === "function" ? await clientProvider() : null);
    if (typeof maoziClient?.listOrders !== "function" || typeof maoziClient?.listRefunds !== "function") {
      throw new TypeError("profit learning requires Maozi listOrders and listRefunds methods");
    }
    const windowDays = Number(options.windowDays || DEFAULT_PROFIT_LEARNING_WINDOW_DAYS);
    if (!(Number.isFinite(windowDays) && windowDays > 0)) throw new TypeError("profit learning windowDays must be positive");
    const startedAt = new Date(observed.getTime() - windowDays * 24 * 60 * 60_000);
    const buildQuery = dependencies.buildQuery || queryForWindow;
    const query = buildQuery(startedAt, observed, options.timeZone || "Asia/Shanghai");
    const pageSize = Math.max(1, Math.floor(Number(options.pageSize) || 100));
    const pagination = {
      pageSize,
      query,
      ...(Number(options.maxPages) > 0
        ? { maxPages: Math.floor(Number(options.maxPages)) }
        : {}),
    };
    const [ordersResult, refundsResult] = await Promise.all([
      maoziClient.listOrders(pagination),
      maoziClient.listRefunds(pagination),
    ]);
    const orders = rowsFrom(ordersResult);
    const refunds = rowsFrom(refundsResult);
    const orderLines = expandMaoziOrderRows(orders);
    const readProductIndex = dependencies.readProductIndex || readProfitProductIndex;
    const productIndex = await readProductIndex({
      runtimeDbPath: options.runtimeDbPath,
      sharedCachePath: options.sharedCachePath,
    });
    const enrich = dependencies.enrichOrderRow || enrichErpOrderRow;
    const combined = [
      ...orderLines.map((row) => enrich(row, productIndex)),
      ...refunds.map((row) => enrich(refundRow(row), productIndex)),
    ];
    const configuredStoreIds = Array.isArray(options.storeIds) ? options.storeIds : [];
    const storeIds = configuredStoreIds.length > 0
      ? configuredStoreIds
      : [...new Set((productIndex?.rows || []).map((row) => row?.store_id).filter(Boolean))];
    const buildPriority = dependencies.buildPriority || buildPriorityMotherProducts;
    const priority = buildPriority(combined, {
      generatedAt: observed,
      windowDays,
      storeIds,
      sourceSkuByOfferId: productIndex?.sourceSkuByOfferId,
      sourceSkuByStoreSku: productIndex?.sourceSkuByStoreSku,
      negativeFeedback: [
        ...(options.negativeFeedback || []),
        ...negativeFeedbackRows(feedback.artifact),
      ],
      minimumCompletedOrders: options.minimumCompletedOrders,
      maximumRefundCancelRate: options.maximumRefundCancelRate,
    });
    const output = {
      version: priority.version,
      generated_at: priority.generated_at,
      report_date: targetDate,
      window: priority.window,
      stores: priority.stores,
    };
    const atomicWrite = dependencies.writeJsonAtomic || writeProfitLearningJsonAtomic;
    await atomicWrite(paths.output, output, { fsApi });
    const motherCount = output.stores.reduce((sum, store) => sum + store.mother_products.length, 0);
    const completed = {
      status: "completed",
      reason: "priority-mothers-updated",
      attempt,
      observed_at: observedAt,
      started_at: running.started_at,
      completed_at: observedAt,
      output: paths.output,
      report_status: "delivered",
      report_delivered_at: text(report.delivered_at) || null,
      report_fingerprint: fingerprint,
      feedback_fingerprint: feedback.fingerprint || null,
      feedback_import_status: feedback.result?.status || null,
      feedback_import_error: feedback.error,
      orders_fetched: orders.length,
      order_lines_fetched: orderLines.length,
      refunds_fetched: refunds.length,
      rows_analyzed: combined.length,
      stores_written: output.stores.length,
      mother_products_written: motherCount,
    };
    const persisted = await persistOwnState(paths, targetDate, completed, { ...dependencies, fsApi });
    return persisted.ok ? persisted.state : { ...persisted.state, state_write_errors: persisted.errors };
  } catch (error) {
    try {
      observedAt ||= nowDate(options.now || dependencies.now).toISOString();
    } catch {
      observedAt = new Date().toISOString();
    }
    targetDate ||= validDateKey(options.dateKey) ? text(options.dateKey) : "1970-01-01";
    const failed = stateFailure({
      prior,
      dateKey: targetDate,
      observedAt,
      reason: "profit-learning-run-failed",
      error,
      output: paths.output,
      report,
      attempt: Number(prior?.attempt || 0) + 1,
      feedbackFingerprint: feedback.fingerprint,
    });
    try {
      const persisted = await persistOwnState(paths, targetDate, failed, { ...dependencies, fsApi });
      return persisted.ok ? persisted.state : { ...persisted.state, state_write_errors: persisted.errors };
    } catch (stateError) {
      return { ...failed, state_write_errors: [errorMessage(stateError)] };
    }
  }
}

export function createProfitLearningSidecar(options = {}, dependencies = {}) {
  const scheduleTimeout = dependencies.setTimeout || globalThis.setTimeout;
  const cancelTimeout = dependencies.clearTimeout || globalThis.clearTimeout;
  const intervalMs = Math.max(1, Math.floor(Number(options.intervalMs) || DEFAULT_PROFIT_LEARNING_INTERVAL_MS));
  let active = false;
  let timer = null;
  let inFlight = null;
  let lastResult = null;

  const execute = (overrides = {}) => {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(() => runProfitLearningOnce({ ...options, ...overrides }, dependencies))
      .catch((error) => ({ status: "error", reason: "profit-learning-sidecar-failed", error: errorMessage(error) }))
      .then((result) => {
        lastResult = result;
        return result;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  const schedule = (delay) => {
    if (!active || timer) return;
    timer = scheduleTimeout(() => {
      timer = null;
      void execute().finally(() => {
        if (active) schedule(intervalMs);
      });
    }, delay);
    timer?.unref?.();
  };

  return {
    runOnce: execute,

    start() {
      if (!active) {
        active = true;
        schedule(0);
      }
      return { running: active, scheduled: Boolean(timer), in_flight: Boolean(inFlight) };
    },

    stop() {
      active = false;
      if (timer) cancelTimeout(timer);
      timer = null;
      return { running: false, scheduled: false, in_flight: Boolean(inFlight) };
    },

    status() {
      return {
        running: active,
        scheduled: Boolean(timer),
        in_flight: Boolean(inFlight),
        last_result: lastResult,
      };
    },
  };
}
