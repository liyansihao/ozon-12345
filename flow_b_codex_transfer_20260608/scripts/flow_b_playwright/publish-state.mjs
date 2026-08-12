import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { classifySkuFailure } from "./retry-policy.mjs";
import { createRuntimeState } from "./runtime-state.mjs";

const TERMINAL_STATUSES = new Set(["published", "failed", "skipped"]);
const VALID_STATUSES = new Set(["processing", ...TERMINAL_STATUSES]);
const CANONICAL_LINK_HEADERS = new Set(["product_link", "canonical_product_link"]);
const PRODUCT_URL_PATTERN = /https?:\/\/(?:www\.)?ozon\.ru\/product\/([^/?#,'"\s]+)/iu;
const ERP_ACCEPTED_PROJECTION_CHAINS = new Map();

function normalizeSku(value) {
  if (value === null || value === undefined) return null;
  const sku = String(value).trim();
  return sku || null;
}

function eventData(data) {
  if (data && typeof data === "object" && !Array.isArray(data)) return { ...data };
  return data === undefined ? {} : { value: data };
}

function enqueueErpAcceptedProjection(filename, operation) {
  const previous = ERP_ACCEPTED_PROJECTION_CHAINS.get(filename) || Promise.resolve();
  const queued = previous.catch(() => {}).then(operation);
  ERP_ACCEPTED_PROJECTION_CHAINS.set(filename, queued);
  queued.then(
    () => {
      if (ERP_ACCEPTED_PROJECTION_CHAINS.get(filename) === queued) {
        ERP_ACCEPTED_PROJECTION_CHAINS.delete(filename);
      }
    },
    () => {
      if (ERP_ACCEPTED_PROJECTION_CHAINS.get(filename) === queued) {
        ERP_ACCEPTED_PROJECTION_CHAINS.delete(filename);
      }
    },
  );
  return queued;
}

function erpAcceptedProjectionRow(value) {
  const data = value?.data && typeof value.data === "object" ? value.data : value;
  const sku = normalizeSku(value?.sku ?? data?.sku);
  const storeId = Number(data?.store_id);
  if (!sku || !(storeId > 0)) return null;
  const acceptedAt = String(
    data?.accepted_at
      || data?.api_call_completed_at
      || data?.api_call_accepted_at
      || data?.submitted_at
      || value?.updatedAt
      || new Date().toISOString(),
  );
  return {
    at: String(data?.at || acceptedAt),
    sku,
    store_id: storeId,
    accepted_at: acceptedAt,
    offer_id: data?.offer_id ?? null,
  };
}

function erpAcceptedProjectionKey(value) {
  const data = value?.data && typeof value.data === "object" ? value.data : value;
  const sku = normalizeSku(value?.sku ?? data?.sku);
  const storeId = Number(data?.store_id);
  return sku && storeId > 0 ? `${storeId}:${sku}` : null;
}

function canonicalSkuFromUrl(value) {
  const match = String(value ?? "").match(PRODUCT_URL_PATTERN);
  return normalizeSku(match?.[1]);
}

async function readTextIfPresent(filename) {
  try {
    return await fs.readFile(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function parseJsonLines(text) {
  const events = [];
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === "object" && !Array.isArray(value)) events.push(value);
    } catch {
      // A truncated or malformed history line must not make a resumable run unusable.
    }
  }
  return events;
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(String(text ?? "").trim());
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function eventFromHistory(value) {
  const sku = normalizeSku(value.sku ?? value.id);
  const status = String(value.status ?? "");
  if (!sku || !VALID_STATUSES.has(status)) return null;
  const data = value.data && typeof value.data === "object" && !Array.isArray(value.data)
    ? { ...value.data }
    : Object.fromEntries(Object.entries(value).filter(([key]) => !["sku", "id", "status", "timestamp"].includes(key)));
  return { sku, status, data };
}

function parseCsvRecords(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  const source = String(text ?? "");

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else if (character === "\r") {
      if (source[index + 1] === "\n") index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) return records;
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function normalizeHeader(value) {
  return String(value ?? "").replace(/^\uFEFF/u, "").trim().toLowerCase();
}

function csvPublishedSkus(text) {
  const skus = new Set();
  const records = parseCsvRecords(text);
  const headers = records[0] ?? [];
  const linkColumn = headers.findIndex((header) => CANONICAL_LINK_HEADERS.has(normalizeHeader(header)));
  if (linkColumn < 0) return skus;

  for (const record of records.slice(1)) {
    const sku = canonicalSkuFromUrl(record[linkColumn]);
    if (sku) skus.add(sku);
  }
  return skus;
}

function csvColumnValues(text, headerName) {
  const values = new Set();
  const records = parseCsvRecords(text);
  const headers = records[0] ?? [];
  const column = headers.findIndex((header) => normalizeHeader(header) === normalizeHeader(headerName));
  if (column < 0) return values;
  for (const record of records.slice(1)) {
    const value = String(record[column] ?? "").trim();
    if (value) values.add(value);
  }
  return values;
}

export function canonicalProductUrl(sku) {
  return `https://www.ozon.ru/product/${String(sku)}`;
}

const STORE_REPORT_HEADERS = [
  "store_id", "store_name", "sku", "product_link", "title", "profit_rate",
  "sell_price", "purchase_price", "offer_id", "published_at",
];
const SELECTION_REPORT_HEADERS = [
  "store_id", "store_name", "sku", "product_link", "title", "profit_rate",
  "sell_price", "purchase_price", "offer_id", "selected_at",
];

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function createPublishState({
  runDir,
  publishedCsv,
  pendingStateFiles = [],
  runtimeStateDbPath = null,
  enforceTitleUniqueness = true,
  writeLegacyStateAudit = true,
  exportRuntimeAuditOnClose = true,
}) {
  if (!runDir) throw new TypeError("runDir is required");
  if (!publishedCsv) throw new TypeError("publishedCsv is required");
  if (!Array.isArray(pendingStateFiles)) throw new TypeError("pendingStateFiles must be an array");
  if (runtimeStateDbPath !== null && (typeof runtimeStateDbPath !== "string" || !runtimeStateDbPath.trim())) {
    throw new TypeError("runtimeStateDbPath must be a non-empty external path");
  }

  const resolvedRunDir = path.resolve(runDir);
  const statePath = path.join(resolvedRunDir, "sku_states.jsonl");
  const publishedPath = path.join(resolvedRunDir, "published.jsonl");
  const failedPath = path.join(resolvedRunDir, "failed.jsonl");
  const skippedPath = path.join(resolvedRunDir, "skipped.jsonl");
  const selectedPath = path.join(resolvedRunDir, "selected.jsonl");
  const erpAcceptedPath = path.join(resolvedRunDir, "erp_accepted.jsonl");
  const summaryPath = path.join(resolvedRunDir, "summary.json");
  const runtimeAuditPath = path.join(resolvedRunDir, "runtime_state_audit.jsonl");
  const runtimeState = runtimeStateDbPath
    ? createRuntimeState({ dbPath: runtimeStateDbPath, enforceTitleUniqueness })
    : null;
  const states = new Map();
  const publishedSkus = new Set();
  const runPublishedSkus = new Set();
  const selectedKeys = new Set();
  let loaded = false;
  let loading = null;
  let summaryTarget;
  let writeChain = Promise.resolve();
  let publishedTransitionChain = Promise.resolve();
  let selectedTransitionChain = Promise.resolve();
  let closing = null;
  let acceptingOperations = true;
  let lastStrictAuditReconciliation = null;
  let lastErpAcceptedAuditReconciliation = null;
  const activeOperations = new Set();

  function trackOperation(task) {
    if (!acceptingOperations) {
      return Promise.reject(new Error("publish state is closing or closed"));
    }
    const operation = Promise.resolve().then(task);
    activeOperations.add(operation);
    operation.then(
      () => activeOperations.delete(operation),
      () => activeOperations.delete(operation),
    );
    return operation;
  }

  function queueWrite(task) {
    const queued = writeChain.then(task);
    writeChain = queued.catch(() => {});
    return queued;
  }

  function enqueuePublishedTransition(task) {
    const queued = publishedTransitionChain.then(task);
    publishedTransitionChain = queued.catch(() => {});
    return queued;
  }

  function enqueueSelectedTransition(task) {
    const queued = selectedTransitionChain.then(task);
    selectedTransitionChain = queued.catch(() => {});
    return queued;
  }

  async function newlineBeforeAppend(filename) {
    let handle;
    try {
      handle = await fs.open(filename, "r");
      const stat = await handle.stat();
      if (stat.size === 0) return "";
      const tail = Buffer.alloc(1);
      await handle.read(tail, 0, 1, stat.size - 1);
      return tail[0] === 10 || tail[0] === 13 ? "" : "\n";
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async function appendJsonl(filename, event) {
    await queueWrite(async () => {
      await fs.mkdir(resolvedRunDir, { recursive: true });
      const separator = await newlineBeforeAppend(filename);
      await fs.appendFile(filename, `${separator}${JSON.stringify(event)}\n`, "utf8");
    });
  }

  async function appendPublishedCsv(sku) {
    await queueWrite(async () => {
      await fs.mkdir(path.dirname(publishedCsv), { recursive: true });
      let existing = "";
      try {
        existing = await fs.readFile(publishedCsv, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!existing.trim()) {
        existing = "product_link\n";
        await fs.writeFile(publishedCsv, existing, "utf8");
      }
      const separator = existing.endsWith("\n") || existing.endsWith("\r") ? "" : "\n";
      await fs.appendFile(publishedCsv, `${separator}${canonicalProductUrl(sku)}\n`, "utf8");
    });
  }

  async function appendPublishedCsvIfMissing(sku, knownSkus) {
    if (knownSkus.has(sku)) return false;
    await appendPublishedCsv(sku);
    knownSkus.add(sku);
    return true;
  }

  async function appendStoreReports(sku, data) {
    const storeId = Number(data?.store_id);
    if (!(storeId > 0)) return;
    const row = {
      store_id: storeId,
      store_name: data?.store_name ?? "",
      sku,
      product_link: canonicalProductUrl(sku),
      title: data?.title ?? "",
      profit_rate: data?.profit_rate ?? "",
      sell_price: data?.sell_price ?? "",
      purchase_price: data?.purchase_price ?? "",
      offer_id: data?.offer_id ?? "",
      published_at: data?.published_at ?? "",
    };
    const line = `${STORE_REPORT_HEADERS.map((header) => csvCell(row[header])).join(",")}\n`;
    for (const filename of [
      path.join(runDir, "published_by_store.csv"),
      path.join(runDir, `published_store_${storeId}.csv`),
    ]) {
      await queueWrite(async () => {
        await fs.mkdir(path.dirname(filename), { recursive: true });
        const existing = await readTextIfPresent(filename);
        if (!existing.trim()) await fs.writeFile(filename, `${STORE_REPORT_HEADERS.join(",")}\n`, "utf8");
        await fs.appendFile(filename, line, "utf8");
      });
    }
  }

  async function appendStoreReportsIfMissing(sku, data, knownByFile) {
    const storeId = Number(data?.store_id);
    if (!(storeId > 0)) return 0;
    const row = {
      store_id: storeId,
      store_name: data?.store_name ?? "",
      sku,
      product_link: canonicalProductUrl(sku),
      title: data?.title ?? "",
      profit_rate: data?.profit_rate ?? "",
      sell_price: data?.sell_price ?? "",
      purchase_price: data?.purchase_price ?? "",
      offer_id: data?.offer_id ?? "",
      published_at: data?.published_at ?? "",
    };
    const line = `${STORE_REPORT_HEADERS.map((header) => csvCell(row[header])).join(",")}\n`;
    let appended = 0;
    for (const filename of [
      path.join(runDir, "published_by_store.csv"),
      path.join(runDir, `published_store_${storeId}.csv`),
    ]) {
      let known = knownByFile.get(filename);
      if (!known) {
        known = csvColumnValues(await readTextIfPresent(filename), "sku");
        knownByFile.set(filename, known);
      }
      if (known.has(sku)) continue;
      await queueWrite(async () => {
        await fs.mkdir(path.dirname(filename), { recursive: true });
        const existing = await readTextIfPresent(filename);
        if (!existing.trim()) {
          await fs.writeFile(filename, `${STORE_REPORT_HEADERS.join(",")}\n`, "utf8");
        }
        const separator = existing && !existing.endsWith("\n") && !existing.endsWith("\r")
          ? "\n"
          : "";
        await fs.appendFile(filename, `${separator}${line}`, "utf8");
      });
      known.add(sku);
      appended += 1;
    }
    return appended;
  }

  async function appendSelectionReports(sku, data) {
    const storeId = Number(data?.store_id);
    if (!(storeId > 0)) return;
    const row = {
      store_id: storeId,
      store_name: data?.store_name ?? "",
      sku,
      product_link: canonicalProductUrl(sku),
      title: data?.title ?? "",
      profit_rate: data?.profit_rate ?? "",
      sell_price: data?.sell_price ?? "",
      purchase_price: data?.purchase_price ?? "",
      offer_id: data?.offer_id ?? "",
      selected_at: data?.selected_at ?? "",
    };
    const line = `${SELECTION_REPORT_HEADERS.map((header) => csvCell(row[header])).join(",")}\n`;
    for (const filename of [
      path.join(runDir, "selected_by_store.csv"),
      path.join(runDir, `selected_store_${storeId}.csv`),
    ]) {
      await queueWrite(async () => {
        await fs.mkdir(path.dirname(filename), { recursive: true });
        const existing = await readTextIfPresent(filename);
        if (!existing.trim()) await fs.writeFile(filename, `${SELECTION_REPORT_HEADERS.join(",")}\n`, "utf8");
        await fs.appendFile(filename, line, "utf8");
      });
    }
  }

  function calculateSummary(target) {
    const numericTarget = Number.isFinite(Number(target)) ? Math.max(0, Number(target)) : 0;
    let failed = 0;
    let skipped = 0;
    for (const [sku, value] of states) {
      if (publishedSkus.has(sku)) continue;
      if (value.status === "failed") failed += 1;
      if (value.status === "skipped") skipped += 1;
    }
    return {
      published: runPublishedSkus.size,
      failed,
      skipped,
      remaining: Math.max(0, numericTarget - runPublishedSkus.size),
    };
  }

  function writeSummary(target) {
    summaryTarget = target;
    const summary = calculateSummary(target);
    const tempPath = `${summaryPath}.tmp`;
    fsSync.mkdirSync(runDir, { recursive: true });
    try {
      fsSync.writeFileSync(tempPath, `${JSON.stringify(summary)}\n`, "utf8");
      fsSync.renameSync(tempPath, summaryPath);
    } finally {
      try {
        fsSync.unlinkSync(tempPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return summary;
  }

  function applyLoadedEvent(event, { fallback = false } = {}) {
    const parsed = eventFromHistory(event);
    if (!parsed) return;
    const { sku, status, data } = parsed;
    if (status === "published") {
      publishedSkus.add(sku);
      runPublishedSkus.add(sku);
      states.set(sku, { status, data: { ...data, link: canonicalProductUrl(sku) } });
      return;
    }
    if (publishedSkus.has(sku)) return;
    if (fallback && states.has(sku)) return;
    states.set(sku, { status, data });
  }

  function runtimePublicStatus(stage) {
    if (stage === "published") return "published";
    if (stage === "skipped") return "skipped";
    if (stage === "failed") return "failed";
    return "processing";
  }

  function runtimePublicEntry(runtimeValue) {
    if (!runtimeValue) return null;
    const data = {
      ...(runtimeValue.data || {}),
      reason: runtimeValue.reason,
      terminal: Boolean(runtimeValue.terminal),
      strict_confirmed: Boolean(runtimeValue.strict),
    };
    if (runtimeValue.failureClass) data.failure_class = runtimeValue.failureClass;
    if (runtimeValue.nextEligibleAt) {
      data.retry_at ??= runtimeValue.nextEligibleAt;
      data.next_eligible_at = runtimeValue.nextEligibleAt;
    }
    if (!runtimeValue.terminal) {
      const eligibility = runtimeState.canAttemptFromState(runtimeValue);
      if (Number.isFinite(Number(eligibility.attempts))) {
        data.transient_attempts = Number(eligibility.attempts);
      }
      const reconciliationPending = (
        data.reconcile_only === true
        || data.submitted === true
        || data.submission_pending === true
        || data.submission_intent === true
      );
      if (eligibility.reason === "daily-transient-limit" && !reconciliationPending) {
        // This closure is valid for the current Shanghai day. SQLite retains the
        // attempt ledger, so the SKU becomes eligible naturally on the next day.
        data.terminal = true;
        data.retry_limit_scope = "shanghai-day";
      }
    }
    return {
      sku: runtimeValue.sku,
      status: runtimePublicStatus(runtimeValue.stage),
      data,
    };
  }

  function syncRuntimeSku(skuValue) {
    if (!runtimeState) return null;
    const sku = normalizeSku(skuValue);
    if (!sku) return null;
    const entry = runtimePublicEntry(runtimeState.get(sku));
    if (!entry) {
      states.delete(sku);
      publishedSkus.delete(sku);
      runPublishedSkus.delete(sku);
      return null;
    }
    states.set(sku, { status: entry.status, data: { ...entry.data } });
    if (entry.status === "published") publishedSkus.add(sku);
    else publishedSkus.delete(sku);
    return entry;
  }

  function hydrateFromRuntime({
    pendingSeeds = new Map(),
    localRunPublished = new Set(),
    runtimeEntries = runtimeState?.operationalStateEntries?.() ?? [],
  } = {}) {
    if (!runtimeState) return;
    states.clear();
    publishedSkus.clear();
    runPublishedSkus.clear();
    const runtimeBySku = new Map(runtimeEntries.map((entry) => [entry.sku, entry]));
    for (const runtimeValue of runtimeEntries) {
      const entry = runtimePublicEntry(runtimeValue);
      if (!entry) continue;
      const sku = entry.sku;
      states.set(sku, { status: entry.status, data: { ...entry.data } });
      if (entry.status === "published") publishedSkus.add(sku);
      const pendingSeed = pendingSeeds.get(sku);
      if (
        pendingSeed &&
        ["processing", "failed"].includes(entry.status) &&
        !entry.data.terminal &&
        (entry.data.submitted === true || entry.data.submission_pending === true)
      ) {
        entry.data.reconcile_only = true;
        entry.data.cross_run_seed = true;
        entry.data.seed_source_file = pendingSeed.filename;
        states.set(sku, { status: entry.status, data: { ...entry.data } });
      }
      const storeId = Number(entry.data?.store_id);
      if (storeId > 0 && (
        entry.status === "published"
        || entry.data?.selected_at
        || entry.data?.prepared_at
        || entry.data?.submission_intent === true
        || entry.data?.submission_pending === true
        || entry.data?.submitted === true
      )) {
        selectedKeys.add(`${storeId}:${sku}`);
      }
    }
    const runtimeRunSkus = new Set(
      runtimeEntries
        .filter((entry) => (
          entry.strict &&
          path.resolve(String(entry.data?.runtime_run_dir || "")) === resolvedRunDir
        ))
        .map((entry) => entry.sku),
    );
    for (const sku of new Set([...localRunPublished, ...runtimeRunSkus])) {
      if (runtimeBySku.get(sku)?.strict) runPublishedSkus.add(sku);
    }
  }

  function strictQualityError(sku, data) {
    if (String(sku) === "2815247918") return "excluded SKU cannot be counted as strict";
    const modes = [data?.mode, data?.shipping_mode, data?.preflight_mode]
      .filter((value) => value !== null && value !== undefined && value !== "");
    if (
      modes.length === 0 ||
      modes.some((value) => String(value).trim().toUpperCase() !== "FBS") ||
      data?.fbs_evidence?.verified !== true
    ) {
      return "strict publication requires verified pure FBS evidence";
    }
    if (!(Number(data?.purchase_price) > 0)) {
      return "strict publication requires a reliable 1688 cost";
    }
    if (
      data?.cost_verified !== true ||
      data?.cost?.ok !== true ||
      !(Number(data?.cost?.cost) > 0)
    ) {
      return "strict publication requires reliable 1688 cost evidence";
    }
    if (data?.quality_gate_passed !== true) {
      return "strict publication requires complete quality-gate evidence";
    }
    return null;
  }

  function durableReason(status, data) {
    const explicit = String(data?.reason || data?.error || "").trim();
    if (explicit) return explicit;
    if (status === "published") return "strict-confirmed";
    if (status === "skipped") return "policy-skipped";
    if (data?.submission_intent === true) return "submission-intent";
    if (data?.submission_pending === true) return "submission-prepared";
    if (data?.submitted === true) return "submission-reconciliation";
    return status === "processing" ? "processing-started" : "unclassified-failure";
  }

  function durableFailureKind(reason, data) {
    const explicit = String(data?.failure_class || data?.failureClass || "").trim().toLowerCase();
    if (["deterministic", "invariant", "transient"].includes(explicit)) {
      if (data?.terminal === true && explicit === "transient") return "invariant";
      return explicit;
    }
    if (/fbs-evidence-missing|transient-retry-limit-exhausted/iu.test(reason)) return "invariant";
    if (data?.terminal === true) return "deterministic";
    if (reason === "online-product-rejected") {
      const product = data?.final_result?.online_product || data?.online_product;
      const targetStoreId = Number(data?.store_id);
      const evidenceStoreId = Number(product?.shop_id);
      return targetStoreId > 0 && evidenceStoreId > 0 && targetStoreId !== evidenceStoreId
        ? "transient"
        : "deterministic";
    }
    if ([
      "daily-product-limit",
      "import-failed",
      "reconciliation-store-not-configured",
      "stock-activation-terminal-rejected",
    ].includes(reason)) {
      return "deterministic";
    }
    const classified = classifySkuFailure(reason);
    return classified === "deterministic" ? "deterministic" : "transient";
  }

  function recordRuntimeTransition(sku, status, data) {
    const reason = durableReason(status, data);
    const existingData = runtimeState.get(sku)?.data || {};
    let runtimeData = {
      ...existingData,
      ...data,
      reason,
      runtime_run_dir: resolvedRunDir,
    };
    const delayedAt = Date.parse(String(runtimeData.next_reconcile_at || ""));
    if (status === "published") {
      const qualityError = strictQualityError(sku, runtimeData);
      if (qualityError) throw new TypeError(qualityError);
      return runtimeState.recordStrictPublication(sku, {
        reason: "strict-confirmed",
        data: runtimeData,
      });
    }
    if (status === "skipped") {
      return runtimeState.recordSkip(sku, { reason, data: runtimeData });
    }
    if (
      status === "processing"
      && runtimeData.reconciliation_terminal !== true
      && runtimeData.submission_intent === true
      && runtimeData.submitted !== true
      && runtimeData.reconcile_only === true
      && Number.isFinite(delayedAt)
    ) {
      return runtimeState.recordDelay(sku, {
        reason,
        nextEligibleAt: new Date(delayedAt).toISOString(),
        data: runtimeData,
      });
    }
    if (
      status === "processing" &&
      data?.submission_intent === true &&
      data?.submitted !== true
    ) {
      return runtimeState.reserveSubmission(sku, {
        reason,
        data: runtimeData,
      });
    }
    if (runtimeData.submitted === true) {
      const reservation = runtimeState.submissionReservation(sku);
      if (reservation?.status === "reserved") {
        const confirmed = runtimeState.confirmSubmission(sku, {
          reason: "erp-submission-accepted",
          data: runtimeData,
        });
        if (!confirmed.recorded) return confirmed;
        // Confirmation is the irreversible ERP acceptance commit. Do not run
        // a second eligibility-checked processing transition: concurrent
        // reconciliation may have exhausted that retry budget after the POST,
        // and must never turn a successfully submitted reservation into a
        // reported persistence failure.
        return confirmed;
      }
    }
    if (
      status === "processing"
      && runtimeData.reconciliation_terminal === true
      && ["online", "stock_updated"].includes(String(runtimeData.outcome_status || ""))
    ) {
      return runtimeState.recordTerminalOutcome(sku, {
        reason,
        stage: runtimeData.outcome_status,
        data: runtimeData,
      });
    }
    if (status === "failed") {
      const kind = durableFailureKind(reason, data);
      if (kind !== "transient") {
        return runtimeState.recordFailure(sku, { reason, kind, data: runtimeData });
      }
      const configuredRetryAt = Date.parse(String(
        runtimeData.retry_at || runtimeData.next_reconcile_at || "",
      ));
      const nextEligibleAt = new Date(
        Number.isFinite(configuredRetryAt) ? configuredRetryAt : Date.now() + 300_000,
      ).toISOString();
      return runtimeState.recordFailure(sku, {
        reason,
        kind,
        nextEligibleAt,
        data: {
          ...runtimeData,
          retry_at: nextEligibleAt,
        },
      });
    }
    if (
      status === "processing"
      && Number.isFinite(delayedAt)
      && (
        runtimeData.reconcile_only === true
        || runtimeData.submitted === true
        || runtimeData.submission_pending === true
        || runtimeData.submission_intent === true
      )
    ) {
      return runtimeState.recordDelay(sku, {
        reason,
        nextEligibleAt: new Date(delayedAt).toISOString(),
        data: runtimeData,
      });
    }
    return runtimeState.recordProcessing(sku, { reason, data: runtimeData });
  }

  async function loadInternal() {
    if (loaded) return api;
    if (loading) return loading;
    loading = (async () => {
      await fs.mkdir(runDir, { recursive: true });
      const persistedSummary = parseJsonObject(await readTextIfPresent(summaryPath));
      if (persistedSummary && Number.isFinite(Number(persistedSummary.published)) && Number.isFinite(Number(persistedSummary.remaining))) {
        summaryTarget = Math.max(0, Number(persistedSummary.published) + Number(persistedSummary.remaining));
      }
      if (runtimeState?.hasNativeRuntimeEvents?.()) {
        hydrateFromRuntime();
        loaded = true;
        try {
          lastStrictAuditReconciliation = await reconcileStrictAuditOutputsInternal();
          lastErpAcceptedAuditReconciliation = await reconcileErpAcceptedAuditOutputsInternal();
        } catch (error) {
          loaded = false;
          throw error;
        }
        if (summaryTarget !== undefined) writeSummary(summaryTarget);
        return api;
      }
      const latestPendingSeeds = new Map();
      for (const filename of pendingStateFiles) {
        for (const event of parseJsonLines(await readTextIfPresent(filename))) {
          const parsed = eventFromHistory(event);
          if (parsed) latestPendingSeeds.set(parsed.sku, { ...parsed, filename });
        }
      }
      for (const { sku, status, data, filename } of latestPendingSeeds.values()) {
        const submitted = data?.submitted === true || data?.submission_pending === true;
        const importStatus = String(data?.import_log?.import_status || "").toLowerCase();
        if (!["processing", "failed"].includes(status)
          || !submitted
          || ["all_failed", "failed"].includes(importStatus)) continue;
        applyLoadedEvent({
          sku,
          status,
          data: {
            ...data,
            submitted: true,
            reconcile_only: true,
            cross_run_seed: true,
            seed_source_file: filename,
          },
        });
      }
      const stateEvents = parseJsonLines(await readTextIfPresent(statePath));
      for (const event of stateEvents) applyLoadedEvent(event);

      for (const event of parseJsonLines(await readTextIfPresent(publishedPath))) {
        applyLoadedEvent(event, { fallback: true });
      }
      for (const filename of [failedPath, skippedPath]) {
        for (const event of parseJsonLines(await readTextIfPresent(filename))) {
          applyLoadedEvent(event, { fallback: true });
        }
      }
      for (const event of parseJsonLines(await readTextIfPresent(selectedPath))) {
        const sku = normalizeSku(event?.sku ?? event?.data?.sku);
        const storeId = Number(event?.data?.store_id ?? event?.store_id);
        if (sku && storeId > 0) selectedKeys.add(`${storeId}:${sku}`);
      }

      for (const sku of csvPublishedSkus(await readTextIfPresent(publishedCsv))) {
        publishedSkus.add(sku);
        if (!runPublishedSkus.has(sku)) {
          states.set(sku, { status: "published", data: { link: canonicalProductUrl(sku), source: "csv" } });
        }
      }
      if (runtimeState) {
        const localRunPublished = new Set(runPublishedSkus);
        const hasNativeRuntimeEvents = runtimeState.hasNativeRuntimeEvents();
        if (!hasNativeRuntimeEvents) {
          // CSV is imported first so richer JSONL evidence can upgrade a
          // historical link-only publication to a strict publication.
          await runtimeState.importLegacy({ publishedCsv: [publishedCsv] });
          await runtimeState.importLegacy({ skuStates: pendingStateFiles });
          await runtimeState.importLegacy({
            skuStates: [statePath],
            published: [publishedPath],
            failed: [failedPath],
            skipped: [skippedPath],
          });
        }
        hydrateFromRuntime({
          pendingSeeds: latestPendingSeeds,
          localRunPublished,
        });
      }
      loaded = true;
      try {
        lastStrictAuditReconciliation = await reconcileStrictAuditOutputsInternal();
        lastErpAcceptedAuditReconciliation = await reconcileErpAcceptedAuditOutputsInternal();
      } catch (error) {
        loaded = false;
        throw error;
      }
      if (summaryTarget !== undefined) writeSummary(summaryTarget);
      return api;
    })();
    try {
      return await loading;
    } finally {
      loading = null;
    }
  }

  async function reconcileStrictAuditOutputsInternal() {
    if (!runtimeState) {
      return {
        strict: 0,
        state_jsonl_added: 0,
        published_jsonl_added: 0,
        published_csv_added: 0,
        store_csv_added: 0,
      };
    }
    const strictRows = runtimeState.strictPublications().filter((row) => {
      const runtimeRunDir = String(row.data?.runtime_run_dir || "").trim();
      return runtimeRunDir && path.resolve(runtimeRunDir) === resolvedRunDir;
    });
    const result = {
      strict: strictRows.length,
      state_jsonl_added: 0,
      published_jsonl_added: 0,
      published_csv_added: 0,
      store_csv_added: 0,
    };
    if (strictRows.length === 0) return result;
    const statePublished = new Set(
      parseJsonLines(await readTextIfPresent(statePath))
        .map(eventFromHistory)
        .filter((event) => event?.status === "published")
        .map((event) => event.sku),
    );
    const publishedJsonl = new Set(
      parseJsonLines(await readTextIfPresent(publishedPath))
        .map(eventFromHistory)
        .filter((event) => event?.status === "published")
        .map((event) => event.sku),
    );
    const publishedCsvSkus = csvPublishedSkus(await readTextIfPresent(publishedCsv));
    const knownStoreSkus = new Map();
    for (const row of strictRows) {
      const sku = row.sku;
      const data = {
        ...(row.data || {}),
        link: canonicalProductUrl(sku),
      };
      const event = {
        sku,
        status: "published",
        data,
        timestamp: String(data.published_at || row.publishedAt),
      };
      if (!statePublished.has(sku)) {
        await appendJsonl(statePath, event);
        statePublished.add(sku);
        result.state_jsonl_added += 1;
      }
      if (!publishedJsonl.has(sku)) {
        await appendJsonl(publishedPath, { ...event, link: canonicalProductUrl(sku) });
        publishedJsonl.add(sku);
        result.published_jsonl_added += 1;
      }
      if (await appendPublishedCsvIfMissing(sku, publishedCsvSkus)) {
        result.published_csv_added += 1;
      }
      result.store_csv_added += await appendStoreReportsIfMissing(sku, data, knownStoreSkus);
      publishedSkus.add(sku);
      runPublishedSkus.add(sku);
      states.set(sku, { status: "published", data });
    }
    return result;
  }

  async function appendErpAcceptedAuditRows(rows) {
    const candidates = (Array.isArray(rows) ? rows : [rows])
      .map(erpAcceptedProjectionRow)
      .filter(Boolean);
    if (candidates.length === 0) return { submitted: 0, added: 0 };
    return enqueueErpAcceptedProjection(erpAcceptedPath, async () => {
      const existingText = await readTextIfPresent(erpAcceptedPath);
      const known = new Set(
        parseJsonLines(existingText).map(erpAcceptedProjectionKey).filter(Boolean),
      );
      const additions = [];
      for (const row of candidates) {
        const key = erpAcceptedProjectionKey(row);
        if (!key || known.has(key)) continue;
        known.add(key);
        additions.push(row);
      }
      if (additions.length > 0) {
        await fs.mkdir(resolvedRunDir, { recursive: true });
        const separator = existingText && !existingText.endsWith("\n") && !existingText.endsWith("\r")
          ? "\n"
          : "";
        await fs.appendFile(
          erpAcceptedPath,
          `${separator}${additions.map((row) => JSON.stringify(row)).join("\n")}\n`,
          "utf8",
        );
      }
      return { submitted: candidates.length, added: additions.length };
    });
  }

  async function reconcileErpAcceptedAuditOutputsInternal() {
    if (!runtimeState || typeof runtimeState.acceptedReservationProjections !== "function") {
      return { submitted: 0, added: 0 };
    }
    return appendErpAcceptedAuditRows(runtimeState.acceptedReservationProjections(resolvedRunDir));
  }

  async function transitionInternal(skuValue, status, data = {}) {
    const sku = normalizeSku(skuValue);
    if (!sku) throw new TypeError("sku is required");
    if (!VALID_STATUSES.has(status)) throw new TypeError(`unsupported status: ${status}`);
    await loadInternal();

    if (hasPublished(sku)) return false;

    let nextData = eventData(data);
    if (status === "published") nextData.link = canonicalProductUrl(sku);
    if (runtimeState) {
      const result = recordRuntimeTransition(sku, status, nextData);
      if (!result.recorded) {
        syncRuntimeSku(sku);
        return false;
      }
      const persisted = syncRuntimeSku(sku);
      nextData = {
        ...(persisted?.data || nextData),
        ...(status === "published" ? { link: canonicalProductUrl(sku) } : {}),
      };
    }
    const event = {
      sku,
      status,
      data: nextData,
      timestamp: new Date().toISOString(),
    };
    const publicStatus = runtimeState ? (syncRuntimeSku(sku)?.status ?? status) : status;
    states.set(sku, { status: publicStatus, data: nextData });
    if (writeLegacyStateAudit) await appendJsonl(statePath, event);

    if (status === "published") {
      publishedSkus.add(sku);
      runPublishedSkus.add(sku);
      await appendJsonl(publishedPath, { ...event, link: canonicalProductUrl(sku) });
      await appendPublishedCsv(sku);
      await appendStoreReports(sku, nextData);
    } else if (status === "failed") {
      await appendJsonl(failedPath, event);
    } else if (status === "skipped") {
      await appendJsonl(skippedPath, event);
    }
    writeSummary(summaryTarget ?? 0);
    return true;
  }

  async function transitionOperation(skuValue, status, data = {}) {
    if (status === "published") {
      const sku = normalizeSku(skuValue);
      if (!sku) throw new TypeError("sku is required");
      return enqueuePublishedTransition(() => transitionInternal(sku, status, data));
    }
    return transitionInternal(skuValue, status, data);
  }

  function load() {
    return trackOperation(() => loadInternal());
  }

  function transition(skuValue, status, data = {}) {
    return trackOperation(() => transitionOperation(skuValue, status, data));
  }

  function hasPublished(skuValue) {
    const sku = normalizeSku(skuValue);
    if (sku === null) return false;
    if (runtimeState) return runtimeState.get(sku)?.stage === "published";
    return publishedSkus.has(sku);
  }

  function statusOf(skuValue) {
    const sku = normalizeSku(skuValue);
    if (sku === null) return null;
    if (runtimeState) return syncRuntimeSku(sku)?.status ?? null;
    if (publishedSkus.has(sku)) return "published";
    return states.get(sku)?.status ?? null;
  }

  function canAttempt(skuValue, options = {}) {
    const sku = normalizeSku(skuValue);
    if (sku === null) return { allowed: false, reason: "sku-required", state: null };
    if (runtimeState) return runtimeState.canAttempt(sku, options);
    const state = states.get(sku);
    if (publishedSkus.has(sku) || TERMINAL_STATUSES.has(state?.status)) {
      return { allowed: false, reason: "terminal-state", state: entryOf(sku) };
    }
    return { allowed: true, reason: "eligible", attempts: 0, state: entryOf(sku) };
  }

  function reopenDirectCandidate(skuValue) {
    return trackOperation(() => {
      const sku = normalizeSku(skuValue);
      if (sku === null) return { reopened: false, reason: "sku-required", state: null };
      if (runtimeState) {
        const result = runtimeState.reopenDirectCandidate(sku);
        syncRuntimeSku(sku);
        return result;
      }
      const current = states.get(sku);
      const data = current?.data || {};
      const protectedSubmission = publishedSkus.has(sku)
        || current?.status === "published"
        || data.submitted === true
        || data.submission_pending === true
        || data.submission_intent === true
        || data.api_call_started_at
        || data.api_call_completed_at
        || ["submitted", "imported", "online", "stock_updated", "rejected", "skipped_cost", "skipped_profit"]
          .includes(String(data.outcome_status || ""));
      if (protectedSubmission || !["failed", "skipped"].includes(String(current?.status || ""))) {
        return { reopened: false, reason: protectedSubmission ? "submission-state-preserved" : "not-reopenable", state: entryOf(sku) };
      }
      states.set(sku, {
        status: "processing",
        data: {
          ...data,
          reason: "direct-policy-reopened",
          terminal: false,
          skip_intent: false,
          skip_reason: null,
          outcome_status: null,
          migrated_from_reason: data.reason || null,
          direct_policy_reopened: true,
          reopened_at: new Date().toISOString(),
        },
      });
      return { reopened: true, reason: "legacy-policy-terminal", state: entryOf(sku) };
    });
  }

  function runPublishedCount() {
    return runPublishedSkus.size;
  }

  function directTargetUsage(targetRunDir = resolvedRunDir) {
    const normalizedRunDir = path.resolve(String(targetRunDir || resolvedRunDir));
    if (runtimeState) return runtimeState.directTargetUsage(normalizedRunDir);
    if (normalizedRunDir !== resolvedRunDir) return 0;
    return [...states].filter(([, value]) => {
      const data = value?.data || {};
      return value?.status === "published"
        || data.submitted === true
        || data.submission_pending === true
        || data.submission_intent === true;
    }).length;
  }

  function directAcceptedCount(targetRunDir = resolvedRunDir) {
    const normalizedRunDir = path.resolve(String(targetRunDir || resolvedRunDir));
    if (runtimeState) return runtimeState.directAcceptedCount(normalizedRunDir);
    if (normalizedRunDir !== resolvedRunDir) return 0;
    return [...states].filter(([, value]) => {
      const data = value?.data || {};
      return value?.status === "published"
        || data.submitted === true
        || data.submission_pending === true;
    }).length;
  }

  function entries() {
    return [...states].map(([sku, value]) => ({
      sku,
      status: value.status,
      data: { ...(value.data || {}) },
    }));
  }

  function entryOf(skuValue) {
    const sku = normalizeSku(skuValue);
    if (sku === null) return null;
    if (runtimeState) return syncRuntimeSku(sku);
    const value = states.get(sku);
    if (!value) return null;
    return {
      sku,
      status: value.status,
      data: { ...(value.data || {}) },
    };
  }

  function summary(target) {
    return writeSummary(target);
  }

  function recordPublished(item) {
    return trackOperation(() => enqueuePublishedTransition(async () => {
      const sku = normalizeSku(item?.sku ?? item?.id);
      if (!sku) throw new TypeError("published item sku is required");
      if (hasPublished(sku)) {
        await loadInternal();
        return false;
      }
      return transitionInternal(sku, "published", { ...(item ?? {}), link: canonicalProductUrl(sku) });
    }));
  }

  function recordSelected(item) {
    return trackOperation(() => enqueueSelectedTransition(async () => {
      await loadInternal();
      const sku = normalizeSku(item?.sku ?? item?.id);
      const storeId = Number(item?.store_id);
      if (!sku) throw new TypeError("selected item sku is required");
      if (!(storeId > 0)) throw new TypeError("selected item store_id is required");
      const key = `${storeId}:${sku}`;
      if (selectedKeys.has(key)) return false;
      const data = { ...(item || {}), sku, store_id: storeId, link: canonicalProductUrl(sku) };
      const event = { sku, data, timestamp: new Date().toISOString() };
      selectedKeys.add(key);
      await appendJsonl(selectedPath, event);
      await appendSelectionReports(sku, data);
      return true;
    }));
  }

  function recordErpAccepted(item) {
    return trackOperation(async () => {
      await loadInternal();
      const result = await appendErpAcceptedAuditRows(item);
      return result.added > 0;
    });
  }

  function reconcileStrictAuditOutputs() {
    return trackOperation(async () => {
      await loadInternal();
      lastStrictAuditReconciliation = await reconcileStrictAuditOutputsInternal();
      return lastStrictAuditReconciliation;
    });
  }

  function reconcileErpAcceptedAuditOutputs() {
    return trackOperation(async () => {
      await loadInternal();
      lastErpAcceptedAuditReconciliation = await reconcileErpAcceptedAuditOutputsInternal();
      return lastErpAcceptedAuditReconciliation;
    });
  }

  async function close() {
    if (closing) return closing;
    acceptingOperations = false;
    closing = (async () => {
      const errors = [];
      const capture = async (operation) => {
        try {
          return await operation;
        } catch (error) {
          errors.push(error);
          return null;
        }
      };
      if (loading) await capture(loading);
      while (activeOperations.size > 0) {
        await Promise.allSettled([...activeOperations]);
      }
      await capture(Promise.all([
        publishedTransitionChain,
        selectedTransitionChain,
      ]));
      await capture(writeChain);
      if (runtimeState) {
        try {
          const reconciliation = await capture(reconcileStrictAuditOutputsInternal());
          if (reconciliation) lastStrictAuditReconciliation = reconciliation;
          const acceptedReconciliation = await capture(reconcileErpAcceptedAuditOutputsInternal());
          if (acceptedReconciliation) {
            lastErpAcceptedAuditReconciliation = acceptedReconciliation;
          }
          await capture(writeChain);
          if (exportRuntimeAuditOnClose) {
            await capture(runtimeState.exportAuditJsonl(runtimeAuditPath));
          }
        } finally {
          runtimeState.close();
        }
      }
      if (errors.length > 0) throw errors[0];
    })();
    return closing;
  }

  function strictAuditReconciliation() {
    return lastStrictAuditReconciliation
      ? { ...lastStrictAuditReconciliation }
      : null;
  }

  function erpAcceptedAuditReconciliation() {
    return lastErpAcceptedAuditReconciliation
      ? { ...lastErpAcceptedAuditReconciliation }
      : null;
  }

  const api = {
    load,
    transition,
    hasPublished,
    statusOf,
    canAttempt,
    reopenDirectCandidate,
    entryOf,
    entries,
    runPublishedCount,
    directTargetUsage,
    directAcceptedCount,
    summary,
    recordPublished,
    recordSelected,
    recordErpAccepted,
    reconcileStrictAuditOutputs,
    reconcileErpAcceptedAuditOutputs,
    strictAuditReconciliation,
    erpAcceptedAuditReconciliation,
    close,
  };
  return api;
}

export async function reconcileRuntimeAuditOutputs({
  runtimeStateDbPath,
  runDir,
  publishedCsv,
} = {}) {
  const state = createPublishState({
    runtimeStateDbPath,
    runDir,
    publishedCsv,
  });
  try {
    await state.load();
    return state.strictAuditReconciliation();
  } finally {
    await state.close();
  }
}
