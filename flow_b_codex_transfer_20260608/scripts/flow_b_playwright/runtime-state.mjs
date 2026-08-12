import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hasReliableSameItemCostEvidence } from "./cost-evidence.mjs";

export const RUNTIME_STATE_SCHEMA_VERSION = 3;

const FAILURE_CLASSES = new Set(["deterministic", "invariant", "transient"]);
const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const LEGACY_STATUSES = new Set([
  "processing",
  "submitted",
  "delayed",
  "published",
  "failed",
  "skipped",
]);
const CANONICAL_LINK_HEADERS = new Set(["product_link", "canonical_product_link"]);
const PRODUCT_URL_PATTERN = /https?:\/\/(?:www\.)?ozon\.ru\/product\/([^/?#,'"\s]+)/iu;
const OPERATIONAL_METADATA_INDEX = "sku_state_operational_metadata";
const OPERATIONAL_TERMINAL_DATA_INDEX = "sku_state_operational_terminal_data";
const OPERATIONAL_PAYLOAD_TABLE = "sku_state_operational_payloads";
const OPERATIONAL_PAYLOAD_FORMAT_METADATA_KEY = "operational_payload_format_version";
const OPERATIONAL_PAYLOAD_FORMAT_VERSION = "2";

export function runtimeSourceExcludedSkus(dbPath) {
  const configuredPath = String(dbPath ?? "").trim();
  if (!configuredPath || configuredPath === ":memory:") return null;
  let database = null;
  let transactionOpen = false;
  try {
    database = new DatabaseSync(path.resolve(configuredPath), { readOnly: true });
    database.exec(`
      PRAGMA query_only = ON;
      PRAGMA busy_timeout = 1000;
      BEGIN DEFERRED;
    `);
    transactionOpen = true;
    const schemaNames = new Set(database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE name IN ('events', 'sku_state', '${OPERATIONAL_PAYLOAD_TABLE}')
    `).all().map((row) => String(row.name)));
    if (
      !schemaNames.has("events")
      || !schemaNames.has("sku_state")
      || !schemaNames.has(OPERATIONAL_PAYLOAD_TABLE)
    ) {
      database.exec("ROLLBACK");
      transactionOpen = false;
      return null;
    }
    const native = database.prepare(`
      SELECT 1 AS present
      FROM events
      WHERE source = 'runtime'
      LIMIT 1
    `).get();
    if (!native?.present) {
      database.exec("ROLLBACK");
      transactionOpen = false;
      return null;
    }
    const excluded = new Set(database.prepare(`
      SELECT sku
      FROM sku_state INDEXED BY ${OPERATIONAL_METADATA_INDEX}
      WHERE stage IN ('skipped', 'published')
    `).all().map((row) => String(row.sku)));
    for (const row of database.prepare(`
      SELECT sku
      FROM ${OPERATIONAL_PAYLOAD_TABLE}
      WHERE
        json_type(data_json, '$.submitted') = 'true'
        OR json_type(data_json, '$.submission_pending') = 'true'
        OR json_type(data_json, '$.reconcile_only') = 'true'
    `).all()) {
      excluded.add(String(row.sku));
    }
    // Format-v2 compact payloads omit a terminal reconcile_only-only row.
    // Scan that narrow legacy shape in SQLite so the source exclusion contract
    // remains exact without materializing the compatibility JSONL in Node.
    for (const row of database.prepare(`
      SELECT sku
      FROM sku_state INDEXED BY ${OPERATIONAL_METADATA_INDEX}
      WHERE terminal = 1
        AND stage = 'failed'
        AND json_type(data_json, '$.reconcile_only') = 'true'
    `).all()) {
      excluded.add(String(row.sku));
    }
    database.exec("COMMIT");
    transactionOpen = false;
    return excluded;
  } catch (error) {
    if (transactionOpen) {
      try { database?.exec("ROLLBACK"); } catch {}
    }
    throw new Error("failed to read native runtime source exclusions", { cause: error });
  } finally {
    try { database?.close(); } catch {}
  }
}

// Terminal failed/skipped rows are only hydrated to restore publication safety
// bookkeeping. Keep the exact fields consumed by publish-state startup:
// selected-key dedupe, direct-run accepted/quota counts, store-limit recovery,
// and submission timestamps. Per-SKU reads continue to use authoritative
// sku_state.data_json, so reconciliation itself never consumes this projection.
const OPERATIONAL_TERMINAL_PAYLOAD_FIELDS = [
  "runtime_run_dir",
  "store_id",
  "store_name",
  "submitted",
  "submission_pending",
  "submission_intent",
  "selected_at",
  "prepared_at",
  "submitted_at",
  "reconciled_at",
  "published_at",
  "api_call_started_at",
  "api_call_completed_at",
  "erp_accepted_at",
  "store_rejection_day",
  "original_reason",
  "outcome_status",
  "next_reconcile_at",
  "retry_at",
];

function operationalTerminalDataPredicate(row = "") {
  const column = (name) => `${row ? `${row}.` : ""}${name}`;
  return `
  ${column("terminal")} = 1 AND (
    coalesce(CAST(json_extract(${column("data_json")}, '$.submitted') AS INTEGER), 0) = 1 OR
    coalesce(CAST(json_extract(${column("data_json")}, '$.submission_pending') AS INTEGER), 0) = 1 OR
    coalesce(CAST(json_extract(${column("data_json")}, '$.submission_intent') AS INTEGER), 0) = 1 OR
    coalesce(length(trim(CAST(json_extract(${column("data_json")}, '$.selected_at') AS TEXT))), 0) > 0 OR
    coalesce(length(trim(CAST(json_extract(${column("data_json")}, '$.prepared_at') AS TEXT))), 0) > 0
  )
`;
}

function operationalPayloadPredicate(row = "") {
  const column = (name) => `${row ? `${row}.` : ""}${name}`;
  return `
    ${column("terminal")} = 0 OR
    ${column("stage")} = 'published' OR
    ${column("strict")} = 1 OR
    (${operationalTerminalDataPredicate(row)})
  `;
}

function operationalPayloadJson(row = "") {
  const column = (name) => `${row ? `${row}.` : ""}${name}`;
  const dataJson = column("data_json");
  const compactFields = OPERATIONAL_TERMINAL_PAYLOAD_FIELDS
    .map((field) => `'${field}', ${dataJson} -> '$.${field}'`)
    .join(",\n      ");
  return `
    CASE
      WHEN ${column("terminal")} = 1
        AND ${column("stage")} IN ('failed', 'skipped')
        AND ${column("strict")} = 0
      THEN json_patch('{}', json_object(
        ${compactFields},
        'import_log', CASE
          WHEN json_type(${dataJson}, '$.import_log.shop_name') IS NULL THEN NULL
          ELSE json_object('shop_name', ${dataJson} -> '$.import_log.shop_name')
        END
      ))
      ELSE ${dataJson}
    END
  `;
}

const OPERATIONAL_TERMINAL_DATA_PREDICATE = operationalTerminalDataPredicate();
const STAGE_PRIORITY = new Map([
  ["processing", 1],
  ["submitted", 2],
  ["delayed", 3],
  ["failed", 4],
  ["skipped", 5],
  ["published", 6],
]);
const DIRECT_FINAL_OUTCOMES = new Set([
  "submitted",
  "imported",
  "online",
  "stock_updated",
  "rejected",
  "skipped_cost",
  "skipped_profit",
]);

export function directCandidateReopenDecision(state) {
  if (!state?.terminal) return { allowed: true, reason: "already-nonterminal" };
  const data = state.data || {};
  if (state.stage === "published" || state.strict === true) {
    return { allowed: false, reason: "historical-publication" };
  }
  if (
    data.submitted === true
    || data.submission_pending === true
    || data.submission_intent === true
    || data.api_call_started_at
    || data.api_call_completed_at
    || data.erp_accepted_at
  ) {
    return { allowed: false, reason: "submission-state-preserved" };
  }
  if (DIRECT_FINAL_OUTCOMES.has(String(data.outcome_status || ""))) {
    return { allowed: false, reason: "direct-final-outcome" };
  }
  if (!["failed", "skipped"].includes(String(state.stage || ""))) {
    return { allowed: false, reason: "unsupported-terminal-stage" };
  }
  return { allowed: true, reason: "legacy-policy-terminal" };
}

function normalizeSku(value) {
  const sku = value === null || value === undefined ? "" : String(value).trim();
  if (!sku) throw new TypeError("sku is required");
  return sku;
}

function optionalSku(value) {
  try {
    return normalizeSku(value);
  } catch {
    return null;
  }
}

function requireReason(value) {
  const reason = value === null || value === undefined ? "" : String(value).trim();
  if (!reason) throw new TypeError("reason is required");
  return reason;
}

function asData(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...value };
  return value === undefined ? {} : { value };
}

function stringifyData(value) {
  return JSON.stringify(asData(value));
}

function parseData(value) {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJsonValue(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalTitleKey(data) {
  const explicit = String(data?.title_key ?? "").trim();
  const source = explicit || String(data?.title ?? "");
  const normalized = source.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  return normalized.length >= 24 ? normalized : null;
}

function normalizedGateSkus(values, phase = "active") {
  const result = [...new Set((values || []).map((value) => String(value ?? "").trim()).filter(Boolean))]
    .sort();
  if (phase === "released") {
    if (result.length !== 0) {
      throw new TypeError("released submission gate requires zero target SKUs");
    }
    return result;
  }
  if (result.length !== 3) {
    throw new TypeError("submission gate requires exactly three unique target SKUs");
  }
  return result;
}

function ensureSubmissionGateTables(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS submission_gates (
      run_id TEXT PRIMARY KEY CHECK (length(trim(run_id)) > 0),
      run_dir TEXT NOT NULL UNIQUE CHECK (length(trim(run_dir)) > 0),
      phase TEXT NOT NULL CHECK (phase IN ('active', 'released', 'failed')),
      distinct_sku_budget INTEGER NOT NULL CHECK (distinct_sku_budget = 3),
      started_at TEXT NOT NULL,
      released_at TEXT,
      result_json TEXT NOT NULL CHECK (json_valid(result_json))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS submission_gate_skus (
      run_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
      sku TEXT NOT NULL CHECK (length(trim(sku)) > 0),
      PRIMARY KEY (run_id, ordinal),
      UNIQUE (run_id, sku),
      FOREIGN KEY (run_id) REFERENCES submission_gates(run_id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;
  `);
}

function submissionGateRow(database, runId) {
  const row = database.prepare(`
    SELECT run_id, run_dir, phase, distinct_sku_budget, started_at, released_at, result_json
    FROM submission_gates
    WHERE run_id = ?
  `).get(runId);
  if (!row) return null;
  const targets = database.prepare(`
    SELECT sku
    FROM submission_gate_skus
    WHERE run_id = ?
    ORDER BY ordinal
  `).all(runId).map((value) => String(value.sku));
  return {
    runId: String(row.run_id),
    runDir: String(row.run_dir),
    phase: String(row.phase),
    distinctSkuBudget: Number(row.distinct_sku_budget),
    startedAt: String(row.started_at),
    releasedAt: row.released_at === null ? null : String(row.released_at),
    result: parseData(row.result_json),
    targetSkus: targets,
  };
}

function withGateDatabase(dbPath, operation) {
  if (typeof dbPath !== "string" || !dbPath.trim() || dbPath.trim() === ":memory:") {
    throw new TypeError("dbPath must identify a durable external file");
  }
  const databasePath = path.resolve(dbPath);
  fsSync.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    ensureSubmissionGateTables(database);
    return operation(database);
  } finally {
    database.close();
  }
}

export function initializeSubmissionGate({
  dbPath,
  runId,
  runDir,
  targetSkus,
  startedAt = new Date().toISOString(),
  phase = "active",
  result = {},
} = {}) {
  const normalizedRunId = String(runId ?? "").trim();
  const normalizedRunDir = path.resolve(String(runDir ?? ""));
  if (!normalizedRunId) throw new TypeError("runId is required");
  if (!String(runDir ?? "").trim()) throw new TypeError("runDir is required");
  const normalizedPhase = String(phase || "").trim();
  if (!["active", "released"].includes(normalizedPhase)) {
    throw new TypeError("initial submission gate phase is invalid");
  }
  const normalizedTargets = normalizedGateSkus(targetSkus, normalizedPhase);
  const normalizedStartedAt = timestamp(startedAt, "startedAt");
  const normalizedResult = result && typeof result === "object" && !Array.isArray(result)
    ? result
    : {};
  return withGateDatabase(dbPath, (database) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = submissionGateRow(database, normalizedRunId);
      if (existing) {
        if (existing.runDir !== normalizedRunDir) {
          throw new Error("submission gate does not match its frozen run directory");
        }
        if (JSON.stringify(existing.targetSkus) !== JSON.stringify(normalizedTargets)) {
          throw new Error("submission gate does not match its frozen SKU set");
        }
        if (normalizedPhase === "released" && existing.phase !== "released") {
          throw new Error("submission gate does not match its initial released phase");
        }
        database.exec("COMMIT");
        return existing;
      }
      database.prepare(`
        INSERT INTO submission_gates (
          run_id, run_dir, phase, distinct_sku_budget, started_at, released_at, result_json
        ) VALUES (?, ?, ?, 3, ?, ?, ?)
      `).run(
        normalizedRunId,
        normalizedRunDir,
        normalizedPhase,
        normalizedStartedAt,
        normalizedPhase === "released" ? normalizedStartedAt : null,
        stringifyData(normalizedResult),
      );
      const insertTarget = database.prepare(`
        INSERT INTO submission_gate_skus (run_id, ordinal, sku)
        VALUES (?, ?, ?)
      `);
      normalizedTargets.forEach((sku, index) => insertTarget.run(normalizedRunId, index + 1, sku));
      database.exec("COMMIT");
      return submissionGateRow(database, normalizedRunId);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  });
}

function transitionSubmissionGate({
  dbPath,
  runId,
  phase,
  at,
  result = {},
}) {
  const normalizedRunId = String(runId ?? "").trim();
  if (!normalizedRunId) throw new TypeError("runId is required");
  if (!["released", "failed"].includes(phase)) throw new TypeError("submission gate phase is invalid");
  const changedAt = timestamp(at, phase === "released" ? "releasedAt" : "failedAt");
  return withGateDatabase(dbPath, (database) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = submissionGateRow(database, normalizedRunId);
      if (!existing) throw new Error("submission gate is missing");
      if (existing.phase === phase) {
        database.exec("COMMIT");
        return existing;
      }
      if (
        existing.phase !== "active"
        && !(phase === "failed" && existing.phase === "released")
      ) {
        throw new Error(`submission gate is already ${existing.phase}`);
      }
      database.prepare(`
        UPDATE submission_gates
        SET phase = ?, released_at = ?, result_json = ?
        WHERE run_id = ? AND phase IN ('active', 'released')
      `).run(phase, changedAt, stringifyData(result), normalizedRunId);
      database.exec("COMMIT");
      return submissionGateRow(database, normalizedRunId);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  });
}

export function releaseSubmissionGate({
  dbPath,
  runId,
  releasedAt = new Date().toISOString(),
  result = {},
} = {}) {
  return transitionSubmissionGate({
    dbPath,
    runId,
    phase: "released",
    at: releasedAt,
    result,
  });
}

export function failSubmissionGate({
  dbPath,
  runId,
  failedAt = new Date().toISOString(),
  result = {},
} = {}) {
  return transitionSubmissionGate({
    dbPath,
    runId,
    phase: "failed",
    at: failedAt,
    result,
  });
}

function timestamp(value, label, { required = true } = {}) {
  if ((value === null || value === undefined || value === "") && !required) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function tolerantTimestamp(value) {
  try {
    return timestamp(value, "timestamp");
  } catch {
    return null;
  }
}

function normalizeFailureClass(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (FAILURE_CLASSES.has(normalized)) return normalized;
  if (["permanent", "policy", "validation"].includes(normalized)) return "deterministic";
  return null;
}

function strictInvariantError(data) {
  const profitRate = Number(data?.profit_rate);
  if (!Number.isFinite(profitRate) || !(profitRate > 30)) return "strict publication requires profit_rate > 30";
  if (String(data?.online_status ?? "").trim().toLowerCase() !== "selling") {
    return "strict publication requires online_status=selling";
  }
  const stock = Number(data?.stock);
  if (!Number.isFinite(stock) || !(stock > 0)) return "strict publication requires stock > 0";
  if (String(data?.shipping_mode ?? "").trim().toUpperCase() !== "FBS") {
    return "strict publication requires pure FBS";
  }
  if (data?.fbs_evidence?.verified !== true) {
    return "strict publication requires verified FBS evidence";
  }
  if (!hasReliableSameItemCostEvidence(data)) {
    return "strict publication requires reliable 1688 cost evidence";
  }
  if (data?.quality_gate_passed !== true) {
    return "strict publication requires complete quality-gate evidence";
  }
  return null;
}

function sqliteReliableCostEvidence(dataExpression) {
  return `(
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_verified') AS INTEGER), 0) = 1 AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost.ok') AS INTEGER), 0) = 1 AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost.cost') AS REAL), 0) > 0 AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.contract') AS TEXT), '') = '1688-same-item-v1' AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.reliable_source') AS INTEGER), 0) = 1 AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.same_item_match') AS INTEGER), 0) = 1 AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.filtered_price_count') AS INTEGER), 0) >= 3 AND
    coalesce(json_array_length(json_extract(${dataExpression}, '$.cost.prices')), 0) >= 3 AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_source') AS TEXT), '') IN (
      'search_first_page_p70_similarity_filtered',
      'search_first_page_cluster_p70_similarity_filtered',
      'search_first_page_cluster_p80_similarity_filtered'
    ) AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.source') AS TEXT), '') =
      coalesce(CAST(json_extract(${dataExpression}, '$.cost_source') AS TEXT), '') AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.match_evidence_key') AS TEXT), '') =
      coalesce(CAST(json_extract(${dataExpression}, '$.cost.match_evidence_key') AS TEXT), '') AND
    length(coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.match_evidence_key') AS TEXT), '')) = 64 AND
    lower(coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.match_evidence_key') AS TEXT), ''))
      NOT GLOB '*[^0-9a-f]*'
  )`;
}

function isStrictPublicationData(data) {
  return strictInvariantError(data) === null;
}

function rowToState(row) {
  if (!row) return null;
  return {
    sku: row.sku,
    stage: row.stage,
    reason: row.reason,
    failureClass: row.failure_class,
    terminal: Boolean(row.terminal),
    strict: Boolean(row.strict),
    nextEligibleAt: row.next_eligible_at,
    data: parseData(row.data_json),
    updatedAt: row.updated_at,
  };
}

function rowToEvent(row) {
  return {
    id: Number(row.id),
    eventKey: row.event_key,
    sku: row.sku,
    stage: row.stage,
    reason: row.reason,
    failureClass: row.failure_class,
    terminal: Boolean(row.terminal),
    strict: Boolean(row.strict),
    nextEligibleAt: row.next_eligible_at,
    data: parseData(row.data_json),
    occurredAt: row.occurred_at,
    source: row.source,
  };
}

function rowToReservation(row) {
  if (!row) return null;
  return {
    sku: row.sku,
    ownerId: row.owner_id,
    generationId: row.generation_id,
    status: row.status,
    titleKey: row.title_key,
    leaseExpiresAt: row.lease_expires_at,
    data: parseData(row.data_json),
    updatedAt: row.updated_at,
  };
}

function importedStateWins(existing, candidate) {
  if (!existing) return true;
  const timeOrder = candidate.occurredAt.localeCompare(existing.updatedAt);
  if (timeOrder !== 0) return timeOrder > 0;

  const candidatePriority = (STAGE_PRIORITY.get(candidate.stage) ?? 0) + (candidate.strict ? 100 : 0);
  const existingPriority = (STAGE_PRIORITY.get(existing.stage) ?? 0) + (existing.strict ? 100 : 0);
  if (candidatePriority !== existingPriority) return candidatePriority > existingPriority;

  const candidateTieBreak = JSON.stringify([
    candidate.stage,
    candidate.failureClass,
    candidate.terminal,
    candidate.reason,
    candidate.nextEligibleAt,
    candidate.data,
  ]);
  const existingTieBreak = JSON.stringify([
    existing.stage,
    existing.failureClass,
    existing.terminal,
    existing.reason,
    existing.nextEligibleAt,
    existing.data,
  ]);
  return candidateTieBreak.localeCompare(existingTieBreak) > 0;
}

async function readTextIfPresent(filename) {
  try {
    return await fs.readFile(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
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

  if (!quoted && (field.length > 0 || record.length > 0)) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function normalizeHeader(value) {
  return String(value ?? "").replace(/^\uFEFF/u, "").trim().toLowerCase();
}

function canonicalSkuFromUrl(value) {
  return optionalSku(String(value ?? "").match(PRODUCT_URL_PATTERN)?.[1]);
}

function legacyEventKey(kind, filename, ordinal, raw) {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify([kind, path.resolve(filename), ordinal, raw]))
    .digest("hex");
  return `legacy:${kind}:${digest}`;
}

function legacyTransientEventKey(spec) {
  const digest = crypto
    .createHash("sha256")
    .update(canonicalJson({
      sku: spec.sku,
      stage: spec.stage,
      reason: spec.reason,
      failureClass: spec.failureClass,
      terminal: spec.terminal,
      strict: spec.strict,
      nextEligibleAt: spec.nextEligibleAt,
      occurredAt: spec.occurredAtInferred ? null : spec.occurredAt,
      data: spec.data,
    }))
    .digest("hex");
  return `legacy:transient:${digest}`;
}

function validMigrationBackup(filename, expectedVersion) {
  let backup;
  try {
    backup = new DatabaseSync(filename, { readOnly: true });
    const quickCheck = backup.prepare("PRAGMA quick_check").get();
    const integrity = String(quickCheck?.quick_check ?? Object.values(quickCheck ?? {})[0] ?? "");
    const version = Number(
      backup.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()?.value,
    );
    return integrity.toLowerCase() === "ok" && version === Number(expectedVersion);
  } catch {
    return false;
  } finally {
    backup?.close();
  }
}

function legacyData(value) {
  if (value?.data && typeof value.data === "object" && !Array.isArray(value.data)) {
    return { ...value.data };
  }
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([key]) => !["sku", "id", "status", "timestamp"].includes(key)),
  );
}

function firstValue(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== "");
}

function legacyTransition(value, kind, fallbackOccurredAt) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sku = optionalSku(value.sku ?? value.id);
  if (!sku) return null;

  const defaultStatus = {
    published: "published",
    failed: "failed",
    skipped: "skipped",
  }[kind];
  const stage = String(value.status ?? defaultStatus ?? "").trim().toLowerCase();
  if (!LEGACY_STATUSES.has(stage)) return null;

  const data = legacyData(value);
  const reason = String(firstValue(
    data.reason,
    value.reason,
    data.error,
    value.error,
    `legacy-${stage}`,
  )).trim();
  const parsedOccurredAt = tolerantTimestamp(firstValue(
    value.timestamp,
    data.timestamp,
    value.published_at,
    data.published_at,
  ));
  const occurredAt = parsedOccurredAt ?? fallbackOccurredAt;
  const nextEligibleAt = tolerantTimestamp(firstValue(
    data.next_eligible_at,
    value.next_eligible_at,
    data.retry_at,
    value.retry_at,
    data.next_reconcile_at,
    value.next_reconcile_at,
  ));

  if (stage === "published") {
    return {
      sku,
      stage,
      reason,
      failureClass: null,
      terminal: true,
      strict: isStrictPublicationData(data),
      nextEligibleAt: null,
      data,
      occurredAt,
      occurredAtInferred: parsedOccurredAt === null,
    };
  }
  if (stage === "skipped") {
    return {
      sku,
      stage,
      reason,
      failureClass: "deterministic",
      terminal: true,
      strict: false,
      nextEligibleAt: null,
      data,
      occurredAt,
      occurredAtInferred: parsedOccurredAt === null,
    };
  }
  if (stage === "failed") {
    const explicitClass = normalizeFailureClass(firstValue(
      data.failure_class,
      value.failure_class,
      data.failureClass,
      value.failureClass,
    ));
    const failureClass = explicitClass ?? (nextEligibleAt ? "transient" : "deterministic");
    return {
      sku,
      stage,
      reason,
      failureClass,
      terminal: failureClass !== "transient",
      strict: false,
      nextEligibleAt: failureClass === "transient" ? (nextEligibleAt ?? occurredAt) : null,
      data,
      occurredAt,
      occurredAtInferred: parsedOccurredAt === null,
    };
  }
  if (stage === "delayed") {
    return {
      sku,
      stage,
      reason,
      failureClass: null,
      terminal: false,
      strict: false,
      nextEligibleAt: nextEligibleAt ?? occurredAt,
      data,
      occurredAt,
      occurredAtInferred: parsedOccurredAt === null,
    };
  }
  return {
    sku,
    stage,
    reason,
    failureClass: null,
    terminal: false,
    strict: false,
    nextEligibleAt: null,
    data,
    occurredAt,
    occurredAtInferred: parsedOccurredAt === null,
  };
}

export function createRuntimeState({
  dbPath,
  now = () => new Date(),
  timeZone = SHANGHAI_TIME_ZONE,
  ownerId = process.env.FLOW_B_SUBMISSION_OWNER || `pid:${process.pid}`,
  generationId = process.env.FLOW_B_WORKER_GENERATION || crypto.randomUUID(),
  submissionLeaseMs = 5 * 60_000,
  enforceTitleUniqueness = true,
  requiredSubmissionGateRunId = process.env.FLOW_B_SUBMISSION_GATE_RUN_ID || null,
  requiredSubmissionGateRunDir = process.env.FLOW_B_SUBMISSION_GATE_RUN_DIR || null,
} = {}) {
  if (typeof dbPath !== "string" || !dbPath.trim()) throw new TypeError("dbPath is required");
  if (dbPath.trim() === ":memory:") throw new TypeError("dbPath must identify a durable external file");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (timeZone !== SHANGHAI_TIME_ZONE) {
    throw new TypeError(`timeZone must be ${SHANGHAI_TIME_ZONE}`);
  }
  const normalizedOwnerId = String(ownerId ?? "").trim();
  const normalizedGenerationId = String(generationId ?? "").trim();
  if (!normalizedOwnerId) throw new TypeError("ownerId is required");
  if (!normalizedGenerationId) throw new TypeError("generationId is required");
  const normalizedSubmissionLeaseMs = Number(submissionLeaseMs);
  const titleUniquenessEnabled = enforceTitleUniqueness !== false;
  if (!Number.isFinite(normalizedSubmissionLeaseMs) || normalizedSubmissionLeaseMs < 1_000) {
    throw new TypeError("submissionLeaseMs must be at least 1000 milliseconds");
  }
  const normalizedGateRunId = String(requiredSubmissionGateRunId ?? "").trim() || null;
  const normalizedGateRunDir = String(requiredSubmissionGateRunDir ?? "").trim()
    ? path.resolve(String(requiredSubmissionGateRunDir))
    : null;
  if ((normalizedGateRunId === null) !== (normalizedGateRunDir === null)) {
    throw new TypeError("required submission gate run ID and run directory must be configured together");
  }

  let dayFormatter;
  try {
    dayFormatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    throw new TypeError("timeZone must be a valid IANA time zone");
  }

  const databasePath = path.resolve(dbPath);
  fsSync.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  let closed = false;
  let migrationBackupPath = null;
  let migrationTransactionOpen = false;

  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    const metadataExists = Boolean(database.prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = 'metadata'
    `).get());
    const preexistingVersion = metadataExists
      ? Number(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()?.value)
      : null;
    const preexistingOperationalPayloadFormat = metadataExists
      ? String(database.prepare("SELECT value FROM metadata WHERE key = ?")
        .get(OPERATIONAL_PAYLOAD_FORMAT_METADATA_KEY)?.value ?? "")
      : "";
    if (
      preexistingVersion !== null &&
      Number.isFinite(preexistingVersion) &&
      ![1, 2, RUNTIME_STATE_SCHEMA_VERSION].includes(preexistingVersion)
    ) {
      throw new Error(
        `unsupported runtime-state schema version ${preexistingVersion}; expected ${RUNTIME_STATE_SCHEMA_VERSION}`,
      );
    }
    if ([1, 2].includes(preexistingVersion)) {
      const stableBackupPath = `${databasePath}.schema-v${preexistingVersion}.backup.sqlite`;
      if (
        !fsSync.existsSync(stableBackupPath) ||
        validMigrationBackup(stableBackupPath, preexistingVersion)
      ) {
        migrationBackupPath = stableBackupPath;
      } else {
        migrationBackupPath = `${stableBackupPath}.retry-${Date.now()}-${crypto.randomUUID()}`;
      }
      if (!fsSync.existsSync(migrationBackupPath)) {
        database.prepare("VACUUM INTO ?").run(migrationBackupPath);
      }
    }
    database.exec("BEGIN IMMEDIATE");
    migrationTransactionOpen = true;
    const operationalPayloadTableExists = Boolean(database.prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(OPERATIONAL_PAYLOAD_TABLE));
    const operationalPayloadNeedsRebuild = (
      !operationalPayloadTableExists
      || preexistingOperationalPayloadFormat !== OPERATIONAL_PAYLOAD_FORMAT_VERSION
    );
    database.exec(`

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        sku TEXT NOT NULL,
        stage TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
        failure_class TEXT CHECK (
          failure_class IS NULL OR
          failure_class IN ('deterministic', 'invariant', 'transient')
        ),
        terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
        strict INTEGER NOT NULL CHECK (strict IN (0, 1)),
        next_eligible_at TEXT,
        data_json TEXT NOT NULL CHECK (json_valid(data_json)),
        occurred_at TEXT NOT NULL,
        source TEXT NOT NULL,
        UNIQUE (sku, id),
        CHECK (strict = 0 OR (stage = 'published' AND terminal = 1)),
        CHECK (
          strict = 0 OR (
            coalesce(CAST(json_extract(data_json, '$.profit_rate') AS REAL), 0) > 30 AND
            coalesce(lower(trim(CAST(json_extract(data_json, '$.online_status') AS TEXT))), '') = 'selling' AND
            coalesce(CAST(json_extract(data_json, '$.stock') AS REAL), 0) > 0 AND
            coalesce(upper(trim(CAST(json_extract(data_json, '$.shipping_mode') AS TEXT))), '') = 'FBS' AND
            coalesce(CAST(json_extract(data_json, '$.fbs_evidence.verified') AS INTEGER), 0) = 1 AND
            coalesce(CAST(json_extract(data_json, '$.cost_verified') AS INTEGER), 0) = 1 AND
            coalesce(CAST(json_extract(data_json, '$.cost.ok') AS INTEGER), 0) = 1 AND
            coalesce(CAST(json_extract(data_json, '$.cost.cost') AS REAL), 0) > 0 AND
            coalesce(CAST(json_extract(data_json, '$.cost_evidence.contract') AS TEXT), '') = '1688-same-item-v1' AND
            coalesce(CAST(json_extract(data_json, '$.cost_evidence.reliable_source') AS INTEGER), 0) = 1 AND
            coalesce(CAST(json_extract(data_json, '$.cost_evidence.same_item_match') AS INTEGER), 0) = 1 AND
            coalesce(CAST(json_extract(data_json, '$.cost_evidence.filtered_price_count') AS INTEGER), 0) >= 3 AND
            coalesce(json_array_length(json_extract(data_json, '$.cost.prices')), 0) >= 3 AND
            coalesce(CAST(json_extract(data_json, '$.cost_source') AS TEXT), '') IN (
              'search_first_page_p70_similarity_filtered',
              'search_first_page_cluster_p70_similarity_filtered',
              'search_first_page_cluster_p80_similarity_filtered'
            ) AND
            coalesce(CAST(json_extract(data_json, '$.cost_evidence.source') AS TEXT), '') =
              coalesce(CAST(json_extract(data_json, '$.cost_source') AS TEXT), '') AND
            coalesce(CAST(json_extract(data_json, '$.cost_evidence.match_evidence_key') AS TEXT), '') =
              coalesce(CAST(json_extract(data_json, '$.cost.match_evidence_key') AS TEXT), '') AND
            length(coalesce(CAST(json_extract(data_json, '$.cost_evidence.match_evidence_key') AS TEXT), '')) = 64 AND
            lower(coalesce(CAST(json_extract(data_json, '$.cost_evidence.match_evidence_key') AS TEXT), ''))
              NOT GLOB '*[^0-9a-f]*' AND
            coalesce(CAST(json_extract(data_json, '$.quality_gate_passed') AS INTEGER), 0) = 1
          )
        ),
        CHECK (
          failure_class IS NULL OR
          failure_class = 'transient' OR
          terminal = 1
        ),
        CHECK (
          failure_class IS NULL OR
          failure_class <> 'transient' OR
          (terminal = 0 AND next_eligible_at IS NOT NULL)
        ),
        CHECK (stage <> 'delayed' OR next_eligible_at IS NOT NULL)
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS events_one_strict_publication_per_sku
      ON events(sku) WHERE strict = 1;

      CREATE TABLE IF NOT EXISTS sku_state (
        sku TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
        failure_class TEXT CHECK (
          failure_class IS NULL OR
          failure_class IN ('deterministic', 'invariant', 'transient')
        ),
        terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
        strict INTEGER NOT NULL CHECK (strict IN (0, 1)),
        next_eligible_at TEXT,
        data_json TEXT NOT NULL CHECK (json_valid(data_json)),
        updated_at TEXT NOT NULL,
        CHECK (strict = 0 OR (stage = 'published' AND terminal = 1)),
        CHECK (
          strict = 0 OR (
            coalesce(CAST(json_extract(data_json, '$.profit_rate') AS REAL), 0) > 30 AND
            coalesce(lower(trim(CAST(json_extract(data_json, '$.online_status') AS TEXT))), '') = 'selling' AND
            coalesce(CAST(json_extract(data_json, '$.stock') AS REAL), 0) > 0 AND
            coalesce(upper(trim(CAST(json_extract(data_json, '$.shipping_mode') AS TEXT))), '') = 'FBS' AND
            coalesce(CAST(json_extract(data_json, '$.fbs_evidence.verified') AS INTEGER), 0) = 1 AND
            coalesce(CAST(json_extract(data_json, '$.cost_verified') AS INTEGER), 0) = 1 AND
            coalesce(CAST(json_extract(data_json, '$.cost.ok') AS INTEGER), 0) = 1 AND
            coalesce(CAST(json_extract(data_json, '$.cost.cost') AS REAL), 0) > 0 AND
            coalesce(CAST(json_extract(data_json, '$.cost_evidence.contract') AS TEXT), '') = '1688-same-item-v1' AND
            coalesce(CAST(json_extract(data_json, '$.cost_evidence.reliable_source') AS INTEGER), 0) = 1 AND
            coalesce(CAST(json_extract(data_json, '$.cost_evidence.same_item_match') AS INTEGER), 0) = 1 AND
            coalesce(CAST(json_extract(data_json, '$.cost_evidence.filtered_price_count') AS INTEGER), 0) >= 3 AND
            coalesce(json_array_length(json_extract(data_json, '$.cost.prices')), 0) >= 3 AND
            coalesce(CAST(json_extract(data_json, '$.cost_source') AS TEXT), '') IN (
              'search_first_page_p70_similarity_filtered',
              'search_first_page_cluster_p70_similarity_filtered',
              'search_first_page_cluster_p80_similarity_filtered'
            ) AND
            coalesce(CAST(json_extract(data_json, '$.cost_evidence.source') AS TEXT), '') =
              coalesce(CAST(json_extract(data_json, '$.cost_source') AS TEXT), '') AND
            coalesce(CAST(json_extract(data_json, '$.cost_evidence.match_evidence_key') AS TEXT), '') =
              coalesce(CAST(json_extract(data_json, '$.cost.match_evidence_key') AS TEXT), '') AND
            length(coalesce(CAST(json_extract(data_json, '$.cost_evidence.match_evidence_key') AS TEXT), '')) = 64 AND
            lower(coalesce(CAST(json_extract(data_json, '$.cost_evidence.match_evidence_key') AS TEXT), ''))
              NOT GLOB '*[^0-9a-f]*' AND
            coalesce(CAST(json_extract(data_json, '$.quality_gate_passed') AS INTEGER), 0) = 1
          )
        ),
        CHECK (
          failure_class IS NULL OR
          failure_class = 'transient' OR
          terminal = 1
        ),
        CHECK (
          failure_class IS NULL OR
          failure_class <> 'transient' OR
          (terminal = 0 AND next_eligible_at IS NOT NULL)
        ),
        CHECK (stage <> 'delayed' OR next_eligible_at IS NOT NULL)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS transient_attempts (
        sku TEXT NOT NULL,
        shanghai_day TEXT NOT NULL,
        attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 2),
        PRIMARY KEY (sku, shanghai_day)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS ${OPERATIONAL_METADATA_INDEX}
      ON sku_state(
        sku, stage, reason, failure_class, terminal, strict, next_eligible_at, updated_at
      );

      CREATE INDEX IF NOT EXISTS ${OPERATIONAL_TERMINAL_DATA_INDEX}
      ON sku_state(sku)
      WHERE ${OPERATIONAL_TERMINAL_DATA_PREDICATE};

      CREATE TABLE IF NOT EXISTS ${OPERATIONAL_PAYLOAD_TABLE} (
        sku TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      ) STRICT, WITHOUT ROWID;

      ${operationalPayloadNeedsRebuild ? `
        DROP TRIGGER IF EXISTS sku_state_operational_payload_insert;
        DROP TRIGGER IF EXISTS sku_state_operational_payload_update;
        DROP TRIGGER IF EXISTS sku_state_operational_payload_delete;
      ` : ""}

      CREATE TRIGGER IF NOT EXISTS sku_state_operational_payload_insert
      AFTER INSERT ON sku_state
      FOR EACH ROW
      WHEN ${operationalPayloadPredicate("NEW")}
      BEGIN
        INSERT INTO ${OPERATIONAL_PAYLOAD_TABLE} (sku, stage, data_json)
        VALUES (NEW.sku, NEW.stage, ${operationalPayloadJson("NEW")});
      END;

      CREATE TRIGGER IF NOT EXISTS sku_state_operational_payload_update
      AFTER UPDATE OF sku, stage, terminal, strict, data_json ON sku_state
      FOR EACH ROW
      BEGIN
        DELETE FROM ${OPERATIONAL_PAYLOAD_TABLE} WHERE sku = OLD.sku;
        INSERT INTO ${OPERATIONAL_PAYLOAD_TABLE} (sku, stage, data_json)
        SELECT NEW.sku, NEW.stage, ${operationalPayloadJson("NEW")}
        WHERE ${operationalPayloadPredicate("NEW")};
      END;

      CREATE TRIGGER IF NOT EXISTS sku_state_operational_payload_delete
      AFTER DELETE ON sku_state
      FOR EACH ROW
      BEGIN
        DELETE FROM ${OPERATIONAL_PAYLOAD_TABLE} WHERE sku = OLD.sku;
      END;

      CREATE TABLE IF NOT EXISTS strict_publications (
        sku TEXT PRIMARY KEY,
        event_id INTEGER NOT NULL UNIQUE,
        published_at TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json)),
        CHECK (
          coalesce(CAST(json_extract(data_json, '$.profit_rate') AS REAL), 0) > 30 AND
          coalesce(lower(trim(CAST(json_extract(data_json, '$.online_status') AS TEXT))), '') = 'selling' AND
          coalesce(CAST(json_extract(data_json, '$.stock') AS REAL), 0) > 0 AND
          coalesce(upper(trim(CAST(json_extract(data_json, '$.shipping_mode') AS TEXT))), '') = 'FBS' AND
          coalesce(CAST(json_extract(data_json, '$.fbs_evidence.verified') AS INTEGER), 0) = 1 AND
          coalesce(CAST(json_extract(data_json, '$.cost_verified') AS INTEGER), 0) = 1 AND
          coalesce(CAST(json_extract(data_json, '$.cost.ok') AS INTEGER), 0) = 1 AND
          coalesce(CAST(json_extract(data_json, '$.cost.cost') AS REAL), 0) > 0 AND
          coalesce(CAST(json_extract(data_json, '$.cost_evidence.contract') AS TEXT), '') = '1688-same-item-v1' AND
          coalesce(CAST(json_extract(data_json, '$.cost_evidence.reliable_source') AS INTEGER), 0) = 1 AND
          coalesce(CAST(json_extract(data_json, '$.cost_evidence.same_item_match') AS INTEGER), 0) = 1 AND
          coalesce(CAST(json_extract(data_json, '$.cost_evidence.filtered_price_count') AS INTEGER), 0) >= 3 AND
          coalesce(json_array_length(json_extract(data_json, '$.cost.prices')), 0) >= 3 AND
          coalesce(CAST(json_extract(data_json, '$.cost_source') AS TEXT), '') IN (
            'search_first_page_p70_similarity_filtered',
            'search_first_page_cluster_p70_similarity_filtered',
            'search_first_page_cluster_p80_similarity_filtered'
          ) AND
          coalesce(CAST(json_extract(data_json, '$.cost_evidence.source') AS TEXT), '') =
            coalesce(CAST(json_extract(data_json, '$.cost_source') AS TEXT), '') AND
          coalesce(CAST(json_extract(data_json, '$.cost_evidence.match_evidence_key') AS TEXT), '') =
            coalesce(CAST(json_extract(data_json, '$.cost.match_evidence_key') AS TEXT), '') AND
          length(coalesce(CAST(json_extract(data_json, '$.cost_evidence.match_evidence_key') AS TEXT), '')) = 64 AND
          lower(coalesce(CAST(json_extract(data_json, '$.cost_evidence.match_evidence_key') AS TEXT), ''))
            NOT GLOB '*[^0-9a-f]*' AND
          coalesce(CAST(json_extract(data_json, '$.quality_gate_passed') AS INTEGER), 0) = 1
        ),
        FOREIGN KEY (sku, event_id) REFERENCES events(sku, id)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS submission_reservations (
        sku TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
        generation_id TEXT NOT NULL CHECK (length(trim(generation_id)) > 0),
        status TEXT NOT NULL CHECK (status IN ('reserved', 'submitted', 'closed')),
        title_key TEXT,
        lease_expires_at TEXT,
        data_json TEXT NOT NULL CHECK (json_valid(data_json)),
        updated_at TEXT NOT NULL,
        CHECK (
          (status = 'reserved' AND lease_expires_at IS NOT NULL) OR
          (status <> 'reserved' AND lease_expires_at IS NULL)
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS strict_title_claims (
        title_key TEXT PRIMARY KEY,
        sku TEXT NOT NULL UNIQUE,
        event_id INTEGER NOT NULL UNIQUE,
        claimed_at TEXT NOT NULL,
        FOREIGN KEY (sku, event_id) REFERENCES events(sku, id)
      ) STRICT, WITHOUT ROWID;

      CREATE TRIGGER IF NOT EXISTS strict_publications_event_guard
      BEFORE INSERT ON strict_publications
      FOR EACH ROW
      WHEN NOT EXISTS (
        SELECT 1
        FROM events
        WHERE id = NEW.event_id
          AND sku = NEW.sku
          AND strict = 1
          AND stage = 'published'
          AND terminal = 1
      )
      BEGIN
        SELECT RAISE(ABORT, 'strict publication event mismatch');
      END;
    `);
    if (operationalPayloadNeedsRebuild) {
      database.exec(`
        DELETE FROM ${OPERATIONAL_PAYLOAD_TABLE};
        INSERT OR REPLACE INTO ${OPERATIONAL_PAYLOAD_TABLE} (sku, stage, data_json)
        WITH hydration_skus AS (
          SELECT sku
          FROM sku_state INDEXED BY ${OPERATIONAL_METADATA_INDEX}
          WHERE terminal = 0 OR stage = 'published' OR strict = 1
          UNION
          SELECT sku
          FROM sku_state INDEXED BY ${OPERATIONAL_TERMINAL_DATA_INDEX}
          WHERE ${OPERATIONAL_TERMINAL_DATA_PREDICATE}
        )
        SELECT s.sku, s.stage, ${operationalPayloadJson("s")}
        FROM hydration_skus AS h
        CROSS JOIN sku_state AS s INDEXED BY sqlite_autoindex_sku_state_1
          ON s.sku = h.sku;
      `);
    }
    database.prepare(`
      INSERT INTO metadata (key, value)
      VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `).run(OPERATIONAL_PAYLOAD_FORMAT_METADATA_KEY, OPERATIONAL_PAYLOAD_FORMAT_VERSION);
    ensureSubmissionGateTables(database);
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS events_strict_same_item_cost_insert
      BEFORE INSERT ON events
      FOR EACH ROW
      WHEN NEW.strict = 1 AND NOT ${sqliteReliableCostEvidence("NEW.data_json")}
      BEGIN
        SELECT RAISE(ABORT, 'strict publication requires reliable same-item 1688 cost evidence');
      END;

      CREATE TRIGGER IF NOT EXISTS events_strict_same_item_cost_update
      BEFORE UPDATE OF strict, data_json ON events
      FOR EACH ROW
      WHEN NEW.strict = 1 AND NOT ${sqliteReliableCostEvidence("NEW.data_json")}
      BEGIN
        SELECT RAISE(ABORT, 'strict publication requires reliable same-item 1688 cost evidence');
      END;

      CREATE TRIGGER IF NOT EXISTS sku_state_strict_same_item_cost_insert
      BEFORE INSERT ON sku_state
      FOR EACH ROW
      WHEN NEW.strict = 1 AND NOT ${sqliteReliableCostEvidence("NEW.data_json")}
      BEGIN
        SELECT RAISE(ABORT, 'strict publication requires reliable same-item 1688 cost evidence');
      END;

      CREATE TRIGGER IF NOT EXISTS sku_state_strict_same_item_cost_update
      BEFORE UPDATE OF strict, data_json ON sku_state
      FOR EACH ROW
      WHEN NEW.strict = 1 AND NOT ${sqliteReliableCostEvidence("NEW.data_json")}
      BEGIN
        SELECT RAISE(ABORT, 'strict publication requires reliable same-item 1688 cost evidence');
      END;

      CREATE TRIGGER IF NOT EXISTS strict_publications_same_item_cost_insert
      BEFORE INSERT ON strict_publications
      FOR EACH ROW
      WHEN NOT ${sqliteReliableCostEvidence("NEW.data_json")}
      BEGIN
        SELECT RAISE(ABORT, 'strict publication requires reliable same-item 1688 cost evidence');
      END;

      CREATE TRIGGER IF NOT EXISTS strict_publications_same_item_cost_update
      BEFORE UPDATE OF data_json ON strict_publications
      FOR EACH ROW
      WHEN NOT ${sqliteReliableCostEvidence("NEW.data_json")}
      BEGIN
        SELECT RAISE(ABORT, 'strict publication requires reliable same-item 1688 cost evidence');
      END;
    `);

    const versionRow = database
      .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get();
    if (!versionRow) {
      database
        .prepare("INSERT INTO metadata (key, value) VALUES ('schema_version', ?)")
        .run(String(RUNTIME_STATE_SCHEMA_VERSION));
    } else if ([1, 2].includes(Number(versionRow.value))) {
      database
        .prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'")
        .run(String(RUNTIME_STATE_SCHEMA_VERSION));
    } else if (Number(versionRow.value) !== RUNTIME_STATE_SCHEMA_VERSION) {
      throw new Error(
        `unsupported runtime-state schema version ${versionRow.value}; expected ${RUNTIME_STATE_SCHEMA_VERSION}`,
      );
    }
    const reservationColumns = new Set(
      database.prepare("PRAGMA table_info(submission_reservations)").all().map((row) => row.name),
    );
    if (!reservationColumns.has("title_key")) {
      database.exec("ALTER TABLE submission_reservations ADD COLUMN title_key TEXT;");
    }
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS active_submission_title_key
      ON submission_reservations(title_key)
      WHERE title_key IS NOT NULL AND status IN ('reserved', 'submitted');
    `);
    const selectExistingStrictTitles = database.prepare(`
      SELECT sku, event_id, published_at, data_json
      FROM strict_publications
      ORDER BY event_id
    `);
    const backfillStrictTitle = database.prepare(`
      INSERT OR IGNORE INTO strict_title_claims (title_key, sku, event_id, claimed_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const row of selectExistingStrictTitles.all()) {
      const titleKey = canonicalTitleKey(parseData(row.data_json));
      if (titleKey) backfillStrictTitle.run(titleKey, row.sku, row.event_id, row.published_at);
    }
    database.exec(`PRAGMA user_version = ${RUNTIME_STATE_SCHEMA_VERSION};`);
    database.exec("COMMIT");
    migrationTransactionOpen = false;
  } catch (error) {
    if (migrationTransactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {}
    }
    database.close();
    throw error;
  }

  const selectState = database.prepare("SELECT * FROM sku_state WHERE sku = ?");
  const selectAllStates = database.prepare("SELECT * FROM sku_state ORDER BY sku");
  const selectOperationalMetadata = database.prepare(`
    SELECT
      sku, stage, reason, failure_class, terminal, strict, next_eligible_at,
      '{}' AS data_json,
      updated_at
    FROM sku_state INDEXED BY ${OPERATIONAL_METADATA_INDEX}
    ORDER BY sku
  `);
  const selectOperationalPayloads = database.prepare(`
    SELECT sku, data_json
    FROM ${OPERATIONAL_PAYLOAD_TABLE}
    ORDER BY sku
  `);
  const selectNativeRuntimeEvent = database.prepare(`
    SELECT 1 AS present
    FROM events
    WHERE source = 'runtime'
    LIMIT 1
  `);
  const selectAttempt = database.prepare(`
    SELECT attempts FROM transient_attempts WHERE sku = ? AND shanghai_day = ?
  `);
  const upsertAttempt = database.prepare(`
    INSERT INTO transient_attempts (sku, shanghai_day, attempts)
    VALUES (?, ?, ?)
    ON CONFLICT (sku, shanghai_day) DO UPDATE SET attempts = excluded.attempts
  `);
  const insertEvent = database.prepare(`
    INSERT INTO events (
      event_key, sku, stage, reason, failure_class, terminal, strict,
      next_eligible_at, data_json, occurred_at, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEventIfNew = database.prepare(`
    INSERT OR IGNORE INTO events (
      event_key, sku, stage, reason, failure_class, terminal, strict,
      next_eligible_at, data_json, occurred_at, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertState = database.prepare(`
    INSERT INTO sku_state (
      sku, stage, reason, failure_class, terminal, strict,
      next_eligible_at, data_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (sku) DO UPDATE SET
      stage = excluded.stage,
      reason = excluded.reason,
      failure_class = excluded.failure_class,
      terminal = excluded.terminal,
      strict = excluded.strict,
      next_eligible_at = excluded.next_eligible_at,
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `);
  const insertStrictPublication = database.prepare(`
    INSERT INTO strict_publications (sku, event_id, published_at, data_json)
    VALUES (?, ?, ?, ?)
  `);
  const hasStrictPublication = database.prepare(`
    SELECT 1 AS present FROM strict_publications WHERE sku = ?
  `);
  const selectReservation = database.prepare(`
    SELECT * FROM submission_reservations WHERE sku = ?
  `);
  const selectActiveTitleReservation = database.prepare(`
    SELECT sku, owner_id, generation_id, status
    FROM submission_reservations
    WHERE title_key = ? AND status IN ('reserved', 'submitted')
  `);
  const selectStrictTitleClaim = database.prepare(`
    SELECT title_key, sku, event_id, claimed_at
    FROM strict_title_claims
    WHERE title_key = ?
  `);
  const insertReservation = database.prepare(`
    INSERT INTO submission_reservations (
      sku, owner_id, generation_id, status, title_key, lease_expires_at, data_json, updated_at
    ) VALUES (?, ?, ?, 'reserved', ?, ?, ?, ?)
  `);
  const selectRequiredSubmissionGate = database.prepare(`
    SELECT run_id, run_dir, phase
    FROM submission_gates
    WHERE run_id = ?
  `);
  const selectRequiredSubmissionGateSku = database.prepare(`
    SELECT 1 AS present
    FROM submission_gate_skus
    WHERE run_id = ? AND sku = ?
  `);
  const updateOwnedReservation = database.prepare(`
    UPDATE submission_reservations
    SET title_key = ?, lease_expires_at = ?, data_json = ?, updated_at = ?
    WHERE sku = ?
      AND owner_id = ?
      AND generation_id = ?
      AND status = 'reserved'
  `);
  const takeOverReservation = database.prepare(`
    UPDATE submission_reservations
    SET owner_id = ?, generation_id = ?, status = 'reserved',
        title_key = ?, lease_expires_at = ?, data_json = ?, updated_at = ?
    WHERE sku = ?
      AND status IN ('reserved', 'closed')
      AND (
        status = 'closed' OR
        lease_expires_at <= ?
      )
  `);
  const markReservationSubmitted = database.prepare(`
    UPDATE submission_reservations
    SET status = 'submitted', lease_expires_at = NULL, data_json = ?, updated_at = ?
    WHERE sku = ?
      AND owner_id = ?
      AND generation_id = ?
      AND status = 'reserved'
  `);
  const closeReservation = database.prepare(`
    UPDATE submission_reservations
    SET status = 'closed', lease_expires_at = NULL, updated_at = ?
    WHERE sku = ? AND status <> 'closed'
  `);
  const countDirectTargetUsage = database.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT sku
      FROM submission_reservations
      WHERE status IN ('reserved', 'submitted')
        AND CAST(json_extract(data_json, '$.runtime_run_dir') AS TEXT) = ?
      UNION
      SELECT sku
      FROM ${OPERATIONAL_PAYLOAD_TABLE}
      WHERE CAST(json_extract(data_json, '$.runtime_run_dir') AS TEXT) = ?
        AND (
          stage = 'published'
          OR coalesce(CAST(json_extract(data_json, '$.submitted') AS INTEGER), 0) = 1
          OR coalesce(CAST(json_extract(data_json, '$.submission_pending') AS INTEGER), 0) = 1
        )
    )
  `);
  const countDirectAccepted = database.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT sku
      FROM submission_reservations
      WHERE status = 'submitted'
        AND CAST(json_extract(data_json, '$.runtime_run_dir') AS TEXT) = ?
      UNION
      SELECT sku
      FROM ${OPERATIONAL_PAYLOAD_TABLE}
      WHERE CAST(json_extract(data_json, '$.runtime_run_dir') AS TEXT) = ?
        AND (
          stage = 'published'
          OR coalesce(CAST(json_extract(data_json, '$.submitted') AS INTEGER), 0) = 1
          OR coalesce(CAST(json_extract(data_json, '$.submission_pending') AS INTEGER), 0) = 1
        )
    )
  `);
  const selectStrictPublications = database.prepare(`
    SELECT sku, event_id, published_at, data_json
    FROM strict_publications
    ORDER BY event_id
  `);
  const insertStrictTitleClaim = database.prepare(`
    INSERT INTO strict_title_claims (title_key, sku, event_id, claimed_at)
    VALUES (?, ?, ?, ?)
  `);
  const insertStrictTitleClaimIfNew = database.prepare(`
    INSERT OR IGNORE INTO strict_title_claims (title_key, sku, event_id, claimed_at)
    VALUES (?, ?, ?, ?)
  `);

  function assertOpen() {
    if (closed) throw new Error("runtime state is closed");
  }

  function currentTimestamp() {
    return timestamp(now(), "now");
  }

  function shanghaiDay(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("timestamp must be valid");
    const parts = Object.fromEntries(
      dayFormatter
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function transaction(callback) {
    assertOpen();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function getState(sku) {
    return rowToState(selectState.get(sku));
  }

  function stateEntries() {
    assertOpen();
    return selectAllStates.all().map(rowToState);
  }

  function operationalStateEntries() {
    assertOpen();
    let readTransactionOpen = false;
    try {
      database.exec("BEGIN DEFERRED");
      readTransactionOpen = true;
      const metadataRows = selectOperationalMetadata.all();
      const payloadBySku = new Map(
        selectOperationalPayloads.all().map((row) => [row.sku, row.data_json]),
      );
      database.exec("COMMIT");
      readTransactionOpen = false;
      return metadataRows.map((row) => rowToState({
        ...row,
        data_json: payloadBySku.get(row.sku) ?? row.data_json,
      }));
    } catch (error) {
      if (readTransactionOpen) {
        try {
          database.exec("ROLLBACK");
        } catch {}
      }
      throw error;
    }
  }

  function hasNativeRuntimeEvents() {
    assertOpen();
    return Boolean(selectNativeRuntimeEvent.get()?.present);
  }

  function getReservation(sku) {
    return rowToReservation(selectReservation.get(sku));
  }

  function normalizedDirectRunDir(value) {
    const configured = String(value ?? "").trim();
    return configured ? path.resolve(configured) : null;
  }

  function directTargetUsage(runDir) {
    assertOpen();
    const normalizedRunDir = normalizedDirectRunDir(runDir);
    if (!normalizedRunDir) return 0;
    return Number(
      countDirectTargetUsage.get(normalizedRunDir, normalizedRunDir)?.count ?? 0,
    );
  }

  function directAcceptedCount(runDir) {
    assertOpen();
    const normalizedRunDir = normalizedDirectRunDir(runDir);
    if (!normalizedRunDir) return 0;
    return Number(
      countDirectAccepted.get(normalizedRunDir, normalizedRunDir)?.count ?? 0,
    );
  }

  function addEvent(spec, { eventKey = `runtime:${crypto.randomUUID()}`, idempotent = false } = {}) {
    const statement = idempotent ? insertEventIfNew : insertEvent;
    const result = statement.run(
      eventKey,
      spec.sku,
      spec.stage,
      spec.reason,
      spec.failureClass,
      spec.terminal ? 1 : 0,
      spec.strict ? 1 : 0,
      spec.nextEligibleAt,
      stringifyData(spec.data),
      spec.occurredAt,
      spec.source,
    );
    return Number(result.changes) === 1 ? Number(result.lastInsertRowid) : null;
  }

  function writeState(spec) {
    upsertState.run(
      spec.sku,
      spec.stage,
      spec.reason,
      spec.failureClass,
      spec.terminal ? 1 : 0,
      spec.strict ? 1 : 0,
      spec.nextEligibleAt,
      stringifyData(spec.data),
      spec.occurredAt,
    );
  }

  function recordTransition(rawSku, options, transition) {
    const sku = normalizeSku(rawSku);
    const reason = requireReason(options?.reason);
    const occurredAt = currentTimestamp();
    const spec = {
      sku,
      stage: transition.stage,
      reason,
      failureClass: transition.failureClass ?? null,
      terminal: Boolean(transition.terminal),
      strict: Boolean(transition.strict),
      nextEligibleAt: transition.nextEligibleAt ?? null,
      data: asData(options?.data),
      occurredAt,
      source: "runtime",
    };

    return transaction(() => {
      const existing = getState(sku);
      if (existing?.terminal) {
        return { recorded: false, reason: "terminal-state", state: existing };
      }
      if (transition.enforceEligibility) {
        const attempts = Number(selectAttempt.get(sku, shanghaiDay(occurredAt))?.attempts ?? 0);
        if (attempts >= 2) {
          return {
            recorded: false,
            reason: "daily-transient-limit",
            attempts,
            dailyLimitReached: true,
            state: existing,
          };
        }
        if (
          existing?.nextEligibleAt &&
          Date.parse(occurredAt) < Date.parse(existing.nextEligibleAt)
        ) {
          return {
            recorded: false,
            reason: "not-yet-eligible",
            attempts,
            dailyLimitReached: false,
            nextEligibleAt: existing.nextEligibleAt,
            state: existing,
          };
        }
      }
      const eventId = addEvent(spec);
      if (spec.strict) {
        insertStrictPublication.run(sku, eventId, occurredAt, stringifyData(spec.data));
      }
      writeState(spec);
      if (spec.terminal) closeReservation.run(occurredAt, sku);
      return { recorded: true, eventId, state: rowToState(selectState.get(sku)) };
    });
  }

  function reserveSubmission(rawSku, options = {}) {
    const sku = normalizeSku(rawSku);
    const reason = requireReason(options.reason);
    const requestedData = asData(options.data);
    const occurredAt = currentTimestamp();
    const leaseExpiresAt = new Date(
      Date.parse(occurredAt) + normalizedSubmissionLeaseMs,
    ).toISOString();

    return transaction(() => {
      if (normalizedGateRunId !== null) {
        const gate = selectRequiredSubmissionGate.get(normalizedGateRunId);
        if (!gate) {
          return { recorded: false, reason: "submission-gate-missing", state: getState(sku) };
        }
        if (path.resolve(String(gate.run_dir)) !== normalizedGateRunDir) {
          return { recorded: false, reason: "submission-gate-run-mismatch", state: getState(sku) };
        }
        if (String(gate.phase) === "failed") {
          return { recorded: false, reason: "submission-gate-failed", state: getState(sku) };
        }
        if (
          String(gate.phase) === "active"
          && !selectRequiredSubmissionGateSku.get(normalizedGateRunId, sku)
        ) {
          return { recorded: false, reason: "prefix-gate-budget-exhausted", state: getState(sku) };
        }
        if (!["active", "released"].includes(String(gate.phase))) {
          return { recorded: false, reason: "submission-gate-invalid", state: getState(sku) };
        }
      }
      const existing = getState(sku);
      if (existing?.terminal) {
        return { recorded: false, reason: "terminal-state", state: existing };
      }
      const attempts = Number(selectAttempt.get(sku, shanghaiDay(occurredAt))?.attempts ?? 0);
      if (attempts >= 2) {
        return {
          recorded: false,
          reason: "daily-transient-limit",
          attempts,
          dailyLimitReached: true,
          state: existing,
        };
      }
      if (
        existing?.nextEligibleAt &&
        Date.parse(occurredAt) < Date.parse(existing.nextEligibleAt)
      ) {
        return {
          recorded: false,
          reason: "not-yet-eligible",
          attempts,
          dailyLimitReached: false,
          nextEligibleAt: existing.nextEligibleAt,
          state: existing,
        };
      }

      const reservation = getReservation(sku);
      if (reservation?.status === "submitted") {
        return {
          recorded: false,
          reason: "submission-already-submitted",
          reservation,
          state: existing,
        };
      }
      const sameGeneration = (
        reservation?.status === "reserved" &&
        reservation.ownerId === normalizedOwnerId &&
        reservation.generationId === normalizedGenerationId
      );
      const leaseActive = (
        reservation?.status === "reserved" &&
        Date.parse(reservation.leaseExpiresAt) > Date.parse(occurredAt)
      );
      if (reservation && !sameGeneration && leaseActive) {
        return {
          recorded: false,
          reason: "submission-reserved-by-another-generation",
          reservation,
          state: existing,
        };
      }
      const directRunDir = normalizedDirectRunDir(requestedData.runtime_run_dir);
      const directTarget = Number(requestedData.direct_target_count);
      if (directRunDir) requestedData.runtime_run_dir = directRunDir;
      if (
        directRunDir
        && Number.isInteger(directTarget)
        && directTarget > 0
      ) {
        const reservationRunDir = normalizedDirectRunDir(
          reservation?.data?.runtime_run_dir,
        );
        const alreadyHoldsTargetSlot = (
          reservation
          && ["reserved", "submitted"].includes(reservation.status)
          && reservationRunDir === directRunDir
        );
        const targetUsage = directTargetUsage(directRunDir);
        if (!alreadyHoldsTargetSlot && targetUsage >= directTarget) {
          return {
            recorded: false,
            reason: "direct-target-capacity-reached",
            directTarget,
            targetUsage,
            state: existing,
          };
        }
      }

      const takeover = Boolean(
        reservation &&
        reservation.status === "reserved" &&
        !sameGeneration,
      );
      const sameGenerationReentry = Boolean(
        sameGeneration &&
        reservation?.data?.api_call_started_at,
      );
      const mergedData = {
        ...(existing?.data || {}),
        ...(reservation?.data || {}),
        ...requestedData,
        submission_intent: true,
        submitted: false,
        submission_pending: false,
        submission_owner_id: normalizedOwnerId,
        submission_generation_id: normalizedGenerationId,
        submission_lease_expires_at: leaseExpiresAt,
        ...(takeover ? {
          reconcile_only: true,
          cross_generation_takeover: true,
          previous_submission_owner_id: reservation.ownerId,
          previous_submission_generation_id: reservation.generationId,
        } : {}),
        ...(sameGenerationReentry ? {
          reconcile_only: true,
          same_generation_reentry: true,
        } : {}),
      };
      const titleKey = titleUniquenessEnabled ? canonicalTitleKey(mergedData) : null;
      if (titleKey) mergedData.title_key = titleKey;
      const strictTitleClaim = titleKey ? selectStrictTitleClaim.get(titleKey) : null;
      if (strictTitleClaim && strictTitleClaim.sku !== sku) {
        return {
          recorded: false,
          reason: "duplicate-title-terminal",
          duplicateSku: strictTitleClaim.sku,
          state: existing,
        };
      }
      const activeTitleReservation = titleKey
        ? selectActiveTitleReservation.get(titleKey)
        : null;
      if (activeTitleReservation && activeTitleReservation.sku !== sku) {
        return {
          recorded: false,
          reason: "duplicate-title-reservation",
          duplicateSku: activeTitleReservation.sku,
          state: existing,
        };
      }

      let reservationChanged;
      if (!reservation) {
        reservationChanged = insertReservation.run(
          sku,
          normalizedOwnerId,
          normalizedGenerationId,
          titleKey,
          leaseExpiresAt,
          stringifyData(mergedData),
          occurredAt,
        );
      } else if (sameGeneration) {
        reservationChanged = updateOwnedReservation.run(
          titleKey,
          leaseExpiresAt,
          stringifyData(mergedData),
          occurredAt,
          sku,
          normalizedOwnerId,
          normalizedGenerationId,
        );
      } else {
        reservationChanged = takeOverReservation.run(
          normalizedOwnerId,
          normalizedGenerationId,
          titleKey,
          leaseExpiresAt,
          stringifyData(mergedData),
          occurredAt,
          sku,
          occurredAt,
        );
      }
      if (Number(reservationChanged.changes) !== 1) {
        return {
          recorded: false,
          reason: "submission-reservation-cas-conflict",
          reservation: getReservation(sku),
          state: getState(sku),
        };
      }

      const spec = {
        sku,
        stage: "submitted",
        reason,
        failureClass: null,
        terminal: false,
        strict: false,
        nextEligibleAt: null,
        data: mergedData,
        occurredAt,
        source: "runtime",
      };
      const eventId = addEvent(spec);
      writeState(spec);
      return {
        recorded: true,
        eventId,
        takeover,
        reservation: getReservation(sku),
        state: getState(sku),
      };
    });
  }

  function confirmSubmission(rawSku, options = {}) {
    const sku = normalizeSku(rawSku);
    const reason = requireReason(options.reason);
    const occurredAt = currentTimestamp();
    return transaction(() => {
      const existing = getState(sku);
      if (existing?.terminal) {
        return { recorded: false, reason: "terminal-state", state: existing };
      }
      const reservation = getReservation(sku);
      if (reservation?.status === "submitted") {
        return {
          recorded: false,
          reason: "submission-already-submitted",
          reservation,
          state: existing,
        };
      }
      if (
        reservation?.status !== "reserved" ||
        reservation.ownerId !== normalizedOwnerId ||
        reservation.generationId !== normalizedGenerationId
      ) {
        return {
          recorded: false,
          reason: reservation
            ? "submission-reserved-by-another-generation"
            : "submission-reservation-missing",
          reservation,
          state: existing,
        };
      }
      const mergedData = {
        ...(existing?.data || {}),
        ...(reservation.data || {}),
        ...asData(options.data),
        submission_intent: false,
        submitted: true,
        submission_pending: false,
        submission_owner_id: normalizedOwnerId,
        submission_generation_id: normalizedGenerationId,
      };
      delete mergedData.submission_lease_expires_at;
      const changed = markReservationSubmitted.run(
        stringifyData(mergedData),
        occurredAt,
        sku,
        normalizedOwnerId,
        normalizedGenerationId,
      );
      if (Number(changed.changes) !== 1) {
        return {
          recorded: false,
          reason: "submission-reservation-cas-conflict",
          reservation: getReservation(sku),
          state: getState(sku),
        };
      }
      const spec = {
        sku,
        stage: "submitted",
        reason,
        failureClass: null,
        terminal: false,
        strict: false,
        nextEligibleAt: null,
        data: mergedData,
        occurredAt,
        source: "runtime",
      };
      const eventId = addEvent(spec);
      writeState(spec);
      return {
        recorded: true,
        eventId,
        reservation: getReservation(sku),
        state: getState(sku),
      };
    });
  }

  function recordSubmission(sku, options = {}) {
    return reserveSubmission(sku, options);
  }

  function recordProcessing(sku, options = {}) {
    return recordTransition(sku, options, {
      stage: "processing",
      terminal: false,
      enforceEligibility: true,
    });
  }

  function recordDelay(sku, options = {}) {
    const reason = requireReason(options.reason);
    const nextEligibleAt = timestamp(options.nextEligibleAt, "nextEligibleAt");
    return recordTransition(sku, { ...options, reason }, {
      stage: "delayed",
      terminal: false,
      nextEligibleAt,
    });
  }

  function recordSkip(sku, options = {}) {
    return recordTransition(sku, options, {
      stage: "skipped",
      failureClass: "deterministic",
      terminal: true,
    });
  }

  function recordFailure(rawSku, options = {}) {
    const sku = normalizeSku(rawSku);
    const reason = requireReason(options.reason);
    const failureClass = normalizeFailureClass(options.kind);
    if (!failureClass) {
      throw new TypeError("kind must be deterministic, invariant, or transient");
    }

    if (failureClass !== "transient") {
      return recordTransition(sku, { ...options, reason }, {
        stage: "failed",
        failureClass,
        terminal: true,
      });
    }

    const nextEligibleAt = timestamp(options.nextEligibleAt, "nextEligibleAt");
    const occurredAt = currentTimestamp();
    const day = shanghaiDay(occurredAt);
    const spec = {
      sku,
      stage: "failed",
      reason,
      failureClass,
      terminal: false,
      strict: false,
      nextEligibleAt,
      data: asData(options.data),
      occurredAt,
      source: "runtime",
    };

    return transaction(() => {
      const existing = getState(sku);
      if (existing?.terminal) {
        return {
          recorded: false,
          attempts: Number(selectAttempt.get(sku, day)?.attempts ?? 0),
          dailyLimitReached: false,
          reason: "terminal-state",
          state: existing,
        };
      }

      const attempts = Number(selectAttempt.get(sku, day)?.attempts ?? 0);
      if (attempts >= 2) {
        return {
          recorded: false,
          attempts,
          dailyLimitReached: true,
          reason: "daily-transient-limit",
          state: existing,
        };
      }

      const nextAttempts = attempts + 1;
      upsertAttempt.run(sku, day, nextAttempts);
      const eventId = addEvent(spec);
      writeState(spec);
      if (
        spec.data?.submitted !== true &&
        !String(spec.data?.api_call_started_at || "").trim()
      ) {
        closeReservation.run(occurredAt, sku);
      }
      return {
        recorded: true,
        eventId,
        attempts: nextAttempts,
        dailyLimitReached: nextAttempts >= 2,
        state: rowToState(selectState.get(sku)),
      };
    });
  }

  function recordStrictPublication(rawSku, options = {}) {
    const sku = normalizeSku(rawSku);
    const reason = requireReason(options.reason);
    const data = asData(options.data);
    const titleKey = canonicalTitleKey(data);
    if (titleKey) data.title_key = titleKey;
    const invariantError = strictInvariantError(data);
    if (invariantError) throw new TypeError(invariantError);
    const occurredAt = currentTimestamp();
    const spec = {
      sku,
      stage: "published",
      reason,
      failureClass: null,
      terminal: true,
      strict: true,
      nextEligibleAt: null,
      data,
      occurredAt,
      source: "runtime",
    };

    return transaction(() => {
      const existing = getState(sku);
      const canUpgradeHistoricalPublication = (
        existing?.terminal &&
        existing.stage === "published" &&
        !existing.strict
      );
      if (
        hasStrictPublication.get(sku) ||
        (existing?.terminal && !canUpgradeHistoricalPublication)
      ) {
        return { recorded: false, reason: "terminal-state", state: existing };
      }
      const strictTitleClaim = titleKey ? selectStrictTitleClaim.get(titleKey) : null;
      if (strictTitleClaim && strictTitleClaim.sku !== sku) {
        return {
          recorded: false,
          reason: "duplicate-title-terminal",
          duplicateSku: strictTitleClaim.sku,
          state: existing,
        };
      }
      const activeTitleReservation = titleKey
        ? selectActiveTitleReservation.get(titleKey)
        : null;
      if (activeTitleReservation && activeTitleReservation.sku !== sku) {
        return {
          recorded: false,
          reason: "duplicate-title-reservation",
          duplicateSku: activeTitleReservation.sku,
          state: existing,
        };
      }
      const eventId = addEvent(spec);
      insertStrictPublication.run(sku, eventId, occurredAt, stringifyData(data));
      if (titleKey && !strictTitleClaim) {
        insertStrictTitleClaim.run(titleKey, sku, eventId, occurredAt);
      }
      writeState(spec);
      closeReservation.run(occurredAt, sku);
      return { recorded: true, eventId, state: rowToState(selectState.get(sku)) };
    });
  }

  function attemptDecision(sku, state, { at } = {}) {
    const checkAt = at === undefined ? currentTimestamp() : timestamp(at, "at");
    if (state?.terminal) {
      return { allowed: false, reason: "terminal-state", state };
    }
    if (state?.nextEligibleAt && Date.parse(checkAt) < Date.parse(state.nextEligibleAt)) {
      return {
        allowed: false,
        reason: "not-yet-eligible",
        nextEligibleAt: state.nextEligibleAt,
        state,
      };
    }
    const attempts = Number(selectAttempt.get(sku, shanghaiDay(checkAt))?.attempts ?? 0);
    if (attempts >= 2) {
      return { allowed: false, reason: "daily-transient-limit", attempts, state };
    }
    return { allowed: true, reason: "eligible", attempts, state };
  }

  function canAttemptFromState(state, options = {}) {
    assertOpen();
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new TypeError("state must be a runtime state entry");
    }
    return attemptDecision(normalizeSku(state.sku), state, options);
  }

  function canAttempt(rawSku, options = {}) {
    assertOpen();
    const sku = normalizeSku(rawSku);
    return attemptDecision(sku, getState(sku), options);
  }

  function reopenDirectCandidate(rawSku) {
    assertOpen();
    const sku = normalizeSku(rawSku);
    return transaction(() => {
      const existing = getState(sku);
      const decision = directCandidateReopenDecision(existing);
      if (!decision.allowed || decision.reason === "already-nonterminal") {
        return { reopened: false, ...decision, state: existing };
      }
      const occurredAt = currentTimestamp();
      const data = {
        ...(existing.data || {}),
        reason: "direct-policy-reopened",
        terminal: false,
        failure_class: null,
        skip_intent: false,
        skip_reason: null,
        outcome_status: null,
        migrated_from_reason: existing.reason || existing.data?.reason || null,
        direct_policy_reopened: true,
        reopened_at: occurredAt,
      };
      const spec = {
        sku,
        stage: "processing",
        reason: "direct-policy-reopened",
        failureClass: null,
        terminal: false,
        strict: false,
        nextEligibleAt: null,
        data,
        occurredAt,
        source: "runtime",
      };
      const eventId = addEvent(spec);
      writeState(spec);
      return {
        reopened: true,
        reason: decision.reason,
        eventId,
        state: rowToState(selectState.get(sku)),
      };
    });
  }

  function applyImported(spec, eventKey, source) {
    return transaction(() => {
      let normalizedSpec = spec;
      let acceptedTransientDay = null;
      let acceptedTransientAttempts = null;
      if (spec.failureClass === "transient") {
        const day = shanghaiDay(spec.occurredAt);
        const attempts = Number(selectAttempt.get(spec.sku, day)?.attempts ?? 0);
        if (attempts >= 2) {
          normalizedSpec = {
            ...spec,
            reason: `legacy-transient-daily-limit-exceeded: ${spec.reason}`,
            failureClass: "invariant",
            terminal: true,
            nextEligibleAt: null,
            data: {
              ...spec.data,
              original_reason: spec.reason,
              original_failure_class: "transient",
              invariant_reason: "daily-transient-limit",
            },
          };
        } else {
          acceptedTransientDay = day;
          acceptedTransientAttempts = attempts + 1;
        }
      }

      const existing = getState(normalizedSpec.sku);
      const canUpgradeHistoricalPublication = (
        normalizedSpec.strict &&
        existing?.stage === "published" &&
        !existing.strict
      );
      const canApply = (
        importedStateWins(existing, normalizedSpec) ||
        canUpgradeHistoricalPublication
      );
      const storedSpec = {
        ...normalizedSpec,
        strict: normalizedSpec.strict && canApply,
        source,
      };
      const eventId = addEvent(storedSpec, { eventKey, idempotent: true });
      if (eventId === null) return false;

      if (acceptedTransientDay !== null) {
        upsertAttempt.run(storedSpec.sku, acceptedTransientDay, acceptedTransientAttempts);
      }
      if (canApply) {
        if (storedSpec.strict) {
          insertStrictPublication.run(
            storedSpec.sku,
            eventId,
            storedSpec.occurredAt,
            stringifyData(storedSpec.data),
          );
          const titleKey = canonicalTitleKey(storedSpec.data);
          if (titleKey) {
            insertStrictTitleClaimIfNew.run(
              titleKey,
              storedSpec.sku,
              eventId,
              storedSpec.occurredAt,
            );
          }
        }
        writeState(storedSpec);
      }
      return true;
    });
  }

  async function collectJsonlCandidates(kind, filenames) {
    const candidates = [];
    for (const filename of filenames) {
      const text = await readTextIfPresent(filename);
      const lines = text.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index].trim();
        if (!raw) continue;
        let value;
        try {
          value = JSON.parse(raw);
        } catch {
          continue;
        }
        const fallbackOccurredAt = currentTimestamp();
        const spec = legacyTransition(value, kind, fallbackOccurredAt);
        if (!spec) continue;
        const eventKey = spec.failureClass === "transient"
          ? legacyTransientEventKey(spec)
          : legacyEventKey(kind, filename, index + 1, raw);
        const source = `legacy:${kind}:${path.resolve(filename)}`;
        candidates.push({ spec, eventKey, source });
      }
    }
    return candidates;
  }

  async function collectPublishedCsvCandidates(filenames) {
    const candidates = [];
    for (const filename of filenames) {
      const text = await readTextIfPresent(filename);
      const records = parseCsvRecords(text);
      const headers = records[0] ?? [];
      const linkColumn = headers.findIndex((header) => CANONICAL_LINK_HEADERS.has(normalizeHeader(header)));
      if (linkColumn < 0) continue;
      const createdAtColumn = headers.findIndex((header) => (
        ["created_at", "published_at"].includes(normalizeHeader(header))
      ));

      for (let index = 1; index < records.length; index += 1) {
        const record = records[index];
        const sku = canonicalSkuFromUrl(record[linkColumn]);
        if (!sku) continue;
        const occurredAt = tolerantTimestamp(
          createdAtColumn >= 0 ? record[createdAtColumn] : null,
        ) ?? currentTimestamp();
        const raw = JSON.stringify(record);
        const spec = {
          sku,
          stage: "published",
          reason: "legacy-published-csv",
          failureClass: null,
          terminal: true,
          strict: false,
          nextEligibleAt: null,
          data: {
            product_link: record[linkColumn],
            source: "csv",
          },
          occurredAt,
        };
        const eventKey = legacyEventKey("published-csv", filename, index + 1, raw);
        const source = `legacy:published-csv:${path.resolve(filename)}`;
        candidates.push({ spec, eventKey, source });
      }
    }
    return candidates;
  }

  async function importLegacy({
    skuStates = [],
    published = [],
    failed = [],
    skipped = [],
    publishedCsv = [],
  } = {}) {
    assertOpen();
    const groups = { skuStates, published, failed, skipped, publishedCsv };
    for (const [name, filenames] of Object.entries(groups)) {
      if (!Array.isArray(filenames)) throw new TypeError(`${name} must be an array`);
    }

    const candidates = (await Promise.all([
      collectJsonlCandidates("sku-states", skuStates),
      collectJsonlCandidates("published", published),
      collectJsonlCandidates("failed", failed),
      collectJsonlCandidates("skipped", skipped),
      collectPublishedCsvCandidates(publishedCsv),
    ])).flat();
    candidates.sort((left, right) => (
      left.spec.occurredAt.localeCompare(right.spec.occurredAt) ||
      left.spec.sku.localeCompare(right.spec.sku) ||
      left.eventKey.localeCompare(right.eventKey)
    ));

    let importedEvents = 0;
    for (const candidate of candidates) {
      if (applyImported(candidate.spec, candidate.eventKey, candidate.source)) {
        importedEvents += 1;
      }
    }
    return { importedEvents };
  }

  function get(rawSku) {
    assertOpen();
    return getState(normalizeSku(rawSku));
  }

  function schemaVersion() {
    assertOpen();
    return Number(
      database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()?.value,
    );
  }

  function strictCount() {
    assertOpen();
    return Number(database.prepare("SELECT count(*) AS count FROM strict_publications").get().count);
  }

  function strictPublications() {
    assertOpen();
    return selectStrictPublications.all().map((row) => ({
      sku: row.sku,
      eventId: Number(row.event_id),
      publishedAt: row.published_at,
      data: parseData(row.data_json),
    }));
  }

  function submissionReservation(rawSku) {
    assertOpen();
    return getReservation(normalizeSku(rawSku));
  }

  function auditEvents() {
    assertOpen();
    return database.prepare("SELECT * FROM events ORDER BY id").all().map(rowToEvent);
  }

  async function exportAuditJsonl(filename) {
    assertOpen();
    if (typeof filename !== "string" || !filename.trim()) {
      throw new TypeError("filename is required");
    }
    const resolved = path.resolve(filename);
    const temp = `${resolved}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const rows = database.prepare("SELECT * FROM events ORDER BY id");
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    let handle = null;
    let count = 0;
    let batch = "";
    try {
      handle = await fs.open(temp, "w");
      for (const row of rows.iterate()) {
        batch += `${JSON.stringify(rowToEvent(row))}\n`;
        count += 1;
        if (Buffer.byteLength(batch) >= 1024 * 1024) {
          await handle.write(batch, null, "utf8");
          batch = "";
        }
      }
      if (batch) await handle.write(batch, null, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, resolved);
      return count;
    } finally {
      await handle?.close().catch(() => {});
      await fs.unlink(temp).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  function close() {
    if (closed) return;
    database.close();
    closed = true;
  }

  return {
    databasePath,
    migrationBackupPath,
    schemaVersion,
    recordSubmission,
    reserveSubmission,
    confirmSubmission,
    recordProcessing,
    recordFailure,
    recordSkip,
    recordDelay,
    recordStrictPublication,
    canAttempt,
    canAttemptFromState,
    reopenDirectCandidate,
    get,
    stateEntries,
    operationalStateEntries,
    hasNativeRuntimeEvents,
    strictCount,
    strictPublications,
    submissionReservation,
    directTargetUsage,
    directAcceptedCount,
    auditEvents,
    importLegacy,
    exportAuditJsonl,
    close,
  };
}
