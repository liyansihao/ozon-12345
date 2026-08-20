import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hasReliableSameItemCostEvidence } from "./cost-evidence.mjs";
import { normalizeTargetVariant } from "./1688-supply-verifier.mjs";

export const RUNTIME_STATE_SCHEMA_VERSION = 4;

const FAILURE_CLASSES = new Set(["deterministic", "invariant", "transient"]);
const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const LEGACY_STATUSES = new Set([
  "processing",
  "submitted",
  "delayed",
  "published",
  "failed",
  "skipped",
  "online",
  "stock_updated",
]);
const CANONICAL_LINK_HEADERS = new Set(["product_link", "canonical_product_link"]);
const PRODUCT_URL_PATTERN = /https?:\/\/(?:www\.)?ozon\.ru\/product\/([^/?#,'"\s]+)/iu;
const OPERATIONAL_METADATA_INDEX = "sku_state_operational_metadata";
const OPERATIONAL_TERMINAL_DATA_INDEX = "sku_state_operational_terminal_data";
const OPERATIONAL_PAYLOAD_TABLE = "sku_state_operational_payloads";
const OPERATIONAL_PAYLOAD_FORMAT_METADATA_KEY = "operational_payload_format_version";
const OPERATIONAL_PAYLOAD_FORMAT_VERSION = "2";
const SUPPLY_GATE_CUTOVER_METADATA_KEY = "supply_gate_cutover_at";
const SUPPLY_EVIDENCE_CONTRACT = "1688-orderable-v1";
const SUPPLY_EVIDENCE_MAX_AGE_MS = 30 * 60_000;
const SUPPLY_PRICE_EPSILON = 1e-6;
const STRICT_SUPPLY_MATCH_TYPES = new Set(["strong_single", "corroborated_multi"]);
const IMAGE_PRIMARY_MATCH_BASIS = "image_primary_v1";
const IMAGE_PRIMARY_SOURCE_CONTRACT = "1688-returned-same-item-v3";
const IMAGE_PRIMARY_SEMANTIC_STRENGTHS = new Set([
  "exact_model",
  "two_high_information_terms",
  "one_high_information_term",
  "one_high_information_plus_product",
  "product_semantics",
  "image_backed",
]);
const IMAGE_PRIMARY_SIGNED_ROW_FIELDS = Object.freeze([
  "offer_id",
  "title",
  "supplier_id",
  "image_url",
  "image",
  "semantic_strength",
  "semantic_hits_v3",
  "spec_conflicts",
  "identity_conflicts",
  "accessory_conflict",
]);
const IMAGE_PRIMARY_SELECTION_METHODS = new Set([
  "image_primary_best_target_overlap",
  "image_primary_exact_thumbnail_url",
]);
const IMAGE_PRIMARY_EXACT_THUMBNAIL_SELECTION_METHOD = "image_primary_exact_thumbnail_url";
const LEGACY_ACCEPTED_AUDIT_RESERVATION_INDEX = "submission_reservations_accepted_audit_by_run";
const ACCEPTED_AUDIT_RESERVATION_INDEX = "submission_reservations_accepted_audit_by_run_v2";
const ACCEPTED_AUDIT_RUN_DIR_SQL = "CAST(json_extract(data_json, '$.runtime_run_dir') AS TEXT)";
const ACCEPTED_AUDIT_TIMESTAMP_SQL = `
  COALESCE(
    NULLIF(CAST(json_extract(data_json, '$.accepted_at') AS TEXT), ''),
    NULLIF(CAST(json_extract(data_json, '$.api_call_completed_at') AS TEXT), ''),
    NULLIF(CAST(json_extract(data_json, '$.api_call_accepted_at') AS TEXT), ''),
    NULLIF(CAST(json_extract(data_json, '$.submitted_at') AS TEXT), '')
  )
`;
const ACCEPTED_AUDIT_PREDICATE_SQL = `
  status IN ('submitted', 'closed')
  AND json_type(data_json, '$.submitted') = 'true'
  AND (${ACCEPTED_AUDIT_TIMESTAMP_SQL}) IS NOT NULL
`;

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
  ["online", 7],
  ["stock_updated", 7],
]);
const TERMINAL_OUTCOME_STAGES = new Set(["online", "stock_updated"]);
const DIRECT_FINAL_OUTCOMES = new Set([
  "submitted",
  "imported",
  "online",
  "stock_updated",
  "rejected",
  "skipped_cost",
  "skipped_profit",
  "indeterminate",
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

function freshPipelinePreparations(data) {
  const preparations = [];
  const context = data?.profit_recheck_context;
  if (context !== null && context !== undefined) {
    preparations.push({
      at: tolerantTimestamp(context?.observed_at),
      source: "profit_recheck_context.observed_at",
    });
  }
  const evidence = data?.supply_evidence;
  if (evidence !== null && evidence !== undefined) {
    preparations.push({
      at: tolerantTimestamp(evidence?.checked_at),
      source: "supply_evidence.checked_at",
    });
  }
  if (Object.prototype.hasOwnProperty.call(data || {}, "prepared_at")) {
    preparations.push({
      at: tolerantTimestamp(data?.prepared_at),
      source: "prepared_at",
    });
  }
  return preparations;
}

function clearPreCallAbandonMarkers(data) {
  if (!data || typeof data !== "object") return data;
  delete data.pre_call_intent_abandoned;
  delete data.pre_call_intent_abandoned_owner_id;
  delete data.pre_call_intent_abandoned_generation_id;
  delete data.pre_call_intent_reset_at;
  delete data.fresh_pipeline_required;
  return data;
}

function preparationRegression(previousData, requestedData) {
  const previousBySource = new Map(
    freshPipelinePreparations(previousData).map((preparation) => [preparation.source, preparation]),
  );
  if (previousBySource.size === 0) return null;
  for (const preparation of freshPipelinePreparations(requestedData)) {
    const previous = previousBySource.get(preparation.source);
    if (!preparation.at) return { ...preparation, previousAt: previous?.at ?? null };
    if (
      previous?.at
      && Date.parse(preparation.at) < Date.parse(previous.at)
    ) {
      return { ...preparation, previousAt: previous.at };
    }
  }
  return null;
}

function normalizeFailureClass(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (FAILURE_CLASSES.has(normalized)) return normalized;
  if (["permanent", "policy", "validation"].includes(normalized)) return "deterministic";
  return null;
}

function nonEmptyObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length > 0,
  );
}

function valid1688OfferUrl(value, offerId) {
  try {
    const parsed = new URL(String(value ?? "").trim());
    const hostname = parsed.hostname.toLowerCase();
    const normalizedOfferId = String(offerId ?? "").trim().toLowerCase();
    return (
      parsed.protocol === "https:"
      && (hostname === "1688.com" || hostname.endsWith(".1688.com"))
      && /^\d+$/u.test(normalizedOfferId)
      && parsed.pathname.toLowerCase() === `/offer/${normalizedOfferId}.html`
    );
  } catch {
    return false;
  }
}

function canonicalSupplyTarget(data) {
  return canonicalJsonValue(normalizeTargetVariant(data?.target_variant));
}

function installCanonicalSupplyBinding(data) {
  if (data && typeof data === "object" && data.api_call_started_at) {
    data.supply_target_variant_canonical = canonicalSupplyTarget(data);
  }
  return data;
}

function supplyCandidateBindingError(data, evidence) {
  const candidates = data?.supply_candidates;
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 3) {
    return "strict publication requires one to three bound strict 1688 supply candidates";
  }
  const evidenceOfferId = String(evidence?.offer_id ?? "").trim();
  const evidenceUrl = String(evidence?.offer_url ?? "").trim();
  const evidenceMatchKey = String(evidence?.match_evidence_key ?? "").trim().toLowerCase();
  const matchingCandidate = candidates.find((candidate) => (
    String(candidate?.offer_id ?? "").trim() === evidenceOfferId
    && String(candidate?.offer_url ?? "").trim().toLowerCase() === evidenceUrl.toLowerCase()
  ));
  if (!matchingCandidate) {
    return "strict publication requires supply evidence bound to a strict recalled offer";
  }
  if (
    matchingCandidate.platform !== "1688"
    || !valid1688OfferUrl(matchingCandidate.offer_url, matchingCandidate.offer_id)
    || !STRICT_SUPPLY_MATCH_TYPES.has(String(matchingCandidate.match_type ?? "").trim())
    || String(matchingCandidate.match_evidence_key ?? "").trim().toLowerCase() !== evidenceMatchKey
  ) {
    return "strict publication requires a valid strong_single or corroborated_multi 1688 candidate binding";
  }
  return null;
}

function matchingSupplyCandidate(data, evidence) {
  const evidenceOfferId = String(evidence?.offer_id ?? "").trim();
  const evidenceUrl = String(evidence?.offer_url ?? "").trim().toLowerCase();
  return Array.isArray(data?.supply_candidates)
    ? data.supply_candidates.find((candidate) => (
      String(candidate?.offer_id ?? "").trim() === evidenceOfferId
      && String(candidate?.offer_url ?? "").trim().toLowerCase() === evidenceUrl
    ))
    : null;
}

function finiteUnitInterval(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validHttpsUrl(value) {
  try {
    const parsed = new URL(String(value ?? "").trim());
    return parsed.protocol === "https:" && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function canonicalAlibabaImageAssetUrl(value) {
  try {
    const parsed = new URL(String(value ?? "").trim());
    if (parsed.protocol !== "https:" || !parsed.hostname) return null;
    const hostname = parsed.hostname.toLocaleLowerCase("und");
    if (hostname === "alicdn.com" || hostname.endsWith(".alicdn.com")) {
      parsed.search = "";
      parsed.hash = "";
      if (parsed.pathname.endsWith("_sum.jpg")) {
        parsed.pathname = parsed.pathname.slice(0, -"_sum.jpg".length);
      }
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function signedImageRow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = {};
  for (const field of IMAGE_PRIMARY_SIGNED_ROW_FIELDS) {
    if (["semantic_hits_v3", "identity_conflicts"].includes(field) && !Object.hasOwn(value, field)) continue;
    row[field] = value[field];
  }
  return row;
}

function imagePrimaryCostRowBindingError(data, candidate, evidence) {
  const candidateRow = signedImageRow(candidate?.image_match_evidence);
  const costRows = data?.cost?.balanced_supporting_offer_evidence;
  const offerId = String(evidence?.offer_id ?? "").trim();
  const matchingRows = Array.isArray(costRows)
    ? costRows.filter((row) => String(row?.offer_id ?? "").trim() === offerId)
    : [];
  if (!candidateRow || matchingRows.length !== 1) {
    return "image-primary supply evidence requires one bound signed supporting cost row";
  }
  const costRow = signedImageRow(matchingRows[0]);
  if (
    !costRow
    || typeof candidateRow.title !== "string"
    || !candidateRow.title.trim()
    || typeof candidateRow.supplier_id !== "string"
    || !candidateRow.supplier_id.trim()
    || !validHttpsUrl(candidateRow.image_url)
    || !validHttpsUrl(costRow.image_url)
    || canonicalJson(candidateRow) !== canonicalJson(costRow)
  ) {
    return "image-primary candidate signed row must canonically match its supporting cost row";
  }
  return null;
}

function imagePrimaryVariantDifferenceError(targetVariant, variantAttributes, differences) {
  if (!Array.isArray(differences)) {
    return "image-primary supply evidence requires a canonical variant_differences array";
  }
  const expected = Object.entries(targetVariant)
    .filter(([name, value]) => (
      !Object.hasOwn(variantAttributes, name)
      || canonicalJson(variantAttributes[name]) !== canonicalJson(value)
    ))
    .map(([name, value]) => ({
      name,
      expected: value,
      observed: null,
      kind: "unbound_soft",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const normalized = [];
  const names = new Set();
  for (const difference of differences) {
    if (!difference || typeof difference !== "object" || Array.isArray(difference)) {
      return "image-primary variant_differences must contain canonical difference objects";
    }
    const keys = Object.keys(difference).sort();
    if (canonicalJson(keys) !== canonicalJson(["expected", "kind", "name", "observed"])) {
      return "image-primary variant_differences contains an unsupported field";
    }
    const name = String(difference.name ?? "").trim();
    const normalizedExpected = canonicalJsonValue(difference.expected);
    if (
      !name
      || names.has(name)
      || !Object.hasOwn(targetVariant, name)
      || difference.kind !== "unbound_soft"
      || difference.observed !== null
      || canonicalJson(normalizedExpected) !== canonicalJson(targetVariant[name])
    ) {
      return "image-primary variant_differences does not match the unbound target attributes";
    }
    names.add(name);
    normalized.push({
      name,
      expected: normalizedExpected,
      observed: null,
      kind: "unbound_soft",
    });
  }
  normalized.sort((left, right) => left.name.localeCompare(right.name));
  if (canonicalJson(normalized) !== canonicalJson(expected)) {
    return "image-primary variant_differences must equal every unbound target attribute";
  }
  return null;
}

function imagePrimaryEvidenceError(data, evidence) {
  if (evidence?.match_basis !== IMAGE_PRIMARY_MATCH_BASIS) {
    return `image-primary supply evidence requires match_basis=${IMAGE_PRIMARY_MATCH_BASIS}`;
  }
  const candidate = matchingSupplyCandidate(data, evidence);
  if (candidate?.match_basis !== IMAGE_PRIMARY_MATCH_BASIS) {
    return `image-primary supply evidence requires candidate.match_basis=${IMAGE_PRIMARY_MATCH_BASIS}`;
  }
  const imageEvidence = evidence?.image_match_evidence;
  if (!imageEvidence || typeof imageEvidence !== "object" || Array.isArray(imageEvidence)) {
    return "image-primary supply evidence requires image_match_evidence";
  }
  if (canonicalJson(candidate?.image_match_evidence) !== canonicalJson(imageEvidence)) {
    return "image-primary supply evidence must canonically match the bound candidate image evidence";
  }
  const costRowError = imagePrimaryCostRowBindingError(data, candidate, evidence);
  if (costRowError) return costRowError;
  const image = imageEvidence.image;
  const offerId = String(evidence?.offer_id ?? "").trim();
  if (
    String(imageEvidence.offer_id ?? "").trim() !== offerId
    || imageEvidence.source_contract !== IMAGE_PRIMARY_SOURCE_CONTRACT
    || !validHttpsUrl(imageEvidence.image_url)
    || !image
    || typeof image !== "object"
    || Array.isArray(image)
    || image.available !== true
    || !finiteUnitInterval(image.score)
    || !finiteUnitInterval(image.color_score)
    || !finiteUnitInterval(image.dhash_score)
    || !IMAGE_PRIMARY_SEMANTIC_STRENGTHS.has(String(imageEvidence.semantic_strength ?? ""))
    || !Array.isArray(imageEvidence.spec_conflicts)
    || imageEvidence.spec_conflicts.length !== 0
    || (Object.hasOwn(imageEvidence, "identity_conflicts")
      && (!Array.isArray(imageEvidence.identity_conflicts)
        || imageEvidence.identity_conflicts.length !== 0))
    || imageEvidence.accessory_conflict !== false
  ) {
    return "image-primary supply evidence requires bound, conflict-free v3 image metrics";
  }
  if (imageEvidence.lane === "strong_visual") {
    // `image_backed` means the signed worker could not bind reliable product
    // text.  It must never inherit the lower, text-supported visual lane.
    if (imageEvidence.semantic_strength === "image_backed"
      || image.score < 0.68
      || image.dhash_score < 0.55
      || image.color_score < 0.90) {
      return "image-primary strong_visual evidence is below the required image thresholds";
    }
  } else if (imageEvidence.lane === "strong_visual_text_soft") {
    if (!Object.hasOwn(imageEvidence, "identity_conflicts")
      || !Array.isArray(imageEvidence.identity_conflicts)
      || imageEvidence.identity_conflicts.length !== 0
      || imageEvidence.semantic_strength !== "image_backed"
      || image.score < 0.90
      || image.dhash_score < 0.82
      || image.color_score < 0.90) {
      return "image-primary strong_visual_text_soft evidence is below the required image thresholds";
    }
  } else if (imageEvidence.lane === "corroborated_visual") {
    const corroboratingIds = imageEvidence.corroborating_offer_ids;
    const normalizedIds = Array.isArray(corroboratingIds)
      ? corroboratingIds.map((value) => String(value ?? "").trim())
      : [];
    if (
      image.score < 0.60
      || image.dhash_score < 0.46
      || image.color_score < 0.82
      || normalizedIds.length < 2
      || normalizedIds.some((value) => !/^\d+$/u.test(value))
      || new Set(normalizedIds).size !== normalizedIds.length
      || !normalizedIds.includes(offerId)
      || candidate?.match_type !== "corroborated_multi"
    ) {
      return "image-primary corroborated_visual evidence is below thresholds or lacks two corroborating offers";
    }
  } else {
    return "image-primary supply evidence requires a supported visual lane";
  }
  return null;
}

export function supplyEvidenceV1InvariantError(data, submissionAt = new Date()) {
  if (data?.supply_gate_passed !== true) {
    return "strict publication requires supply_gate_passed=true";
  }
  const evidence = data?.supply_evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return "strict publication requires SupplyEvidenceV1";
  }
  if (evidence.contract !== SUPPLY_EVIDENCE_CONTRACT) {
    return `strict publication requires supply_evidence.contract=${SUPPLY_EVIDENCE_CONTRACT}`;
  }
  if (evidence.passed !== true || evidence.platform !== "1688") {
    return "strict publication requires passed 1688 supply evidence";
  }
  const offerId = String(evidence.offer_id ?? "").trim();
  if (!offerId || !valid1688OfferUrl(evidence.offer_url, offerId)) {
    return "strict publication requires a bound 1688 offer ID and URL";
  }
  const candidateError = supplyCandidateBindingError(data, evidence);
  if (candidateError) return candidateError;
  const targetVariant = canonicalSupplyTarget(data);
  const evidenceTargetVariant = canonicalJsonValue(normalizeTargetVariant(evidence.target_variant));
  const evidenceVariantAttributes = canonicalJsonValue(normalizeTargetVariant(evidence.variant_attributes));
  const targetRequired = data?.target_variant?.required === true || nonEmptyObject(targetVariant);
  if (targetRequired && !nonEmptyObject(targetVariant)) {
    return "strict publication cannot bind an explicit target variant without normalized attributes";
  }
  const variantMatchMode = String(evidence.variant_match_mode ?? "").trim();
  const imagePrimary = variantMatchMode === "image_primary";
  if (variantMatchMode && !["exact", "image_primary"].includes(variantMatchMode)) {
    return "strict publication requires a supported variant_match_mode";
  }
  if (imagePrimary) {
    const imageError = imagePrimaryEvidenceError(data, evidence);
    if (imageError) return imageError;
    const selectedVariant = evidence.selected_variant;
    if (
      evidence.variant_selection_required !== true
      || !selectedVariant
      || typeof selectedVariant !== "object"
      || Array.isArray(selectedVariant)
      || typeof selectedVariant.row_key !== "string"
      || !selectedVariant.row_key.trim()
      || typeof selectedVariant.label !== "string"
      || !selectedVariant.label.trim()
      || selectedVariant.soft_tie !== false
      || !IMAGE_PRIMARY_SELECTION_METHODS.has(selectedVariant.selection_method)
    ) {
      return "image-primary supply evidence requires one non-ambiguous selected variant row";
    }
    const exactThumbnailSelection = selectedVariant.selection_method
      === IMAGE_PRIMARY_EXACT_THUMBNAIL_SELECTION_METHOD;
    if (
      exactThumbnailSelection
        ? !validHttpsUrl(selectedVariant.selected_sku_image_url)
          || !canonicalAlibabaImageAssetUrl(selectedVariant.selected_sku_image_url)
          || canonicalAlibabaImageAssetUrl(selectedVariant.selected_sku_image_url)
            !== canonicalAlibabaImageAssetUrl(evidence.image_match_evidence?.image_url)
        : Object.hasOwn(selectedVariant, "selected_sku_image_url")
    ) {
      return "image-primary selected SKU thumbnail must exactly match the signed offer image URL";
    }
    if (
      evidence.item_level_match !== false
      || !evidence.variant_attributes
      || typeof evidence.variant_attributes !== "object"
      || Array.isArray(evidence.variant_attributes)
      || canonicalJson(canonicalJsonValue(evidence.variant_attributes)) !==
        canonicalJson(evidenceVariantAttributes)
      || (nonEmptyObject(targetVariant) && (
        canonicalJson(canonicalJsonValue(evidence.target_variant)) !== canonicalJson(targetVariant)
      ))
      || canonicalJson(evidenceTargetVariant) !== canonicalJson(targetVariant)
    ) {
      return "image-primary supply evidence must preserve the normalized target variant";
    }
    const differenceError = imagePrimaryVariantDifferenceError(
      targetVariant,
      evidenceVariantAttributes,
      evidence.variant_differences,
    );
    if (differenceError) return differenceError;
    const setQuantity = Number(targetVariant.set_quantity);
    if (Object.hasOwn(targetVariant, "set_quantity") && Number.isFinite(setQuantity) && setQuantity > 1) {
      return "image-primary supply evidence cannot verify an explicit set_quantity greater than 1";
    }
  } else if (targetRequired) {
    if (
      evidence.item_level_match === true
      || !nonEmptyObject(evidence.target_variant)
      || !nonEmptyObject(evidence.variant_attributes)
      || canonicalJson(evidenceTargetVariant) !== canonicalJson(targetVariant)
      || canonicalJson(evidenceVariantAttributes) !== canonicalJson(targetVariant)
    ) {
      return "strict publication requires exact normalized target and selected variant attributes";
    }
  } else if (
    evidence.item_level_match !== true
    || !evidence.variant_attributes
    || typeof evidence.variant_attributes !== "object"
    || Array.isArray(evidence.variant_attributes)
    || nonEmptyObject(evidenceTargetVariant)
    || nonEmptyObject(evidenceVariantAttributes)
  ) {
    return "strict publication requires item-level evidence only when no explicit target variant exists";
  }
  const moq = evidence.moq;
  if (!Number.isFinite(moq) || !(moq > 0 && moq <= 1)) {
    return "strict publication requires supply_evidence.moq <= 1";
  }
  if (!Number.isInteger(evidence.orderable_quantity) || evidence.orderable_quantity !== 1) {
    return "strict publication requires orderable_quantity=1";
  }
  const unitPrice = evidence.unit_price;
  if (!Number.isFinite(unitPrice) || !(unitPrice > 0)) {
    return "strict publication requires a positive one-piece supply price";
  }
  const originalCost = data?.purchase_price_original_p70_p80;
  const finalPurchasePrice = data?.purchase_price;
  const costResultPrice = data?.cost?.cost;
  if (
    !Number.isFinite(originalCost)
    || !(originalCost > 0)
    || !Number.isFinite(finalPurchasePrice)
    || !(finalPurchasePrice > 0)
    || !Number.isFinite(costResultPrice)
    || !(costResultPrice > 0)
  ) {
    return "strict publication requires numeric original and final purchase prices";
  }
  if (originalCost + SUPPLY_PRICE_EPSILON < costResultPrice) {
    return "strict publication requires original P70/P80 cost bound to the verified cost result";
  }
  if (
    finalPurchasePrice + SUPPLY_PRICE_EPSILON < originalCost
    || finalPurchasePrice + SUPPLY_PRICE_EPSILON < unitPrice
  ) {
    return "strict publication requires purchase_price >= max(original cost, live one-piece price)";
  }
  if (evidence.stock_state !== "in_stock" || evidence.orderable !== true) {
    return "strict publication requires in-stock, orderable supply evidence";
  }
  const matchEvidenceKey = String(evidence.match_evidence_key ?? "").trim();
  const costMatchEvidenceKey = String(data?.cost_evidence?.match_evidence_key ?? "").trim();
  if (
    !/^[0-9a-f]{64}$/iu.test(matchEvidenceKey)
    || matchEvidenceKey.toLowerCase() !== costMatchEvidenceKey.toLowerCase()
  ) {
    return "strict publication requires supply evidence bound to same-item match evidence";
  }
  const checkedAt = typeof evidence.checked_at === "string"
    ? Date.parse(evidence.checked_at)
    : Number.NaN;
  const validUntil = typeof evidence.valid_until === "string"
    ? Date.parse(evidence.valid_until)
    : Number.NaN;
  const submittedAt = submissionAt instanceof Date
    ? submissionAt.getTime()
    : Date.parse(String(submissionAt ?? ""));
  if (![checkedAt, validUntil, submittedAt].every(Number.isFinite)) {
    return "strict publication requires valid supply evidence timestamps";
  }
  if (!(validUntil > checkedAt) || validUntil - checkedAt > SUPPLY_EVIDENCE_MAX_AGE_MS) {
    return "strict publication requires a supply evidence validity window of at most 30 minutes";
  }
  if (checkedAt > submittedAt || submittedAt >= validUntil) {
    return "strict publication requires supply evidence valid when the ERP submission started";
  }
  return null;
}

function trustedSupplySubmissionInvariantError(data, reservation, strictAt) {
  const supplyError = supplyEvidenceV1InvariantError(data, data?.api_call_started_at);
  if (supplyError) return supplyError;
  if (
    !reservation
    || !["submitted", "closed"].includes(String(reservation.status || ""))
    || reservation.data?.submitted !== true
    || reservation.data?.supply_gate_passed !== true
  ) {
    return "strict publication requires a trusted submitted reservation with supply evidence";
  }
  const suppliedApiCallStartedAt = tolerantTimestamp(data?.api_call_started_at);
  const reservedApiCallStartedAt = tolerantTimestamp(reservation.data?.api_call_started_at);
  const strictTimestamp = tolerantTimestamp(strictAt);
  if (
    !suppliedApiCallStartedAt
    || suppliedApiCallStartedAt !== reservedApiCallStartedAt
    || !strictTimestamp
    || Date.parse(suppliedApiCallStartedAt) > Date.parse(strictTimestamp)
  ) {
    return "strict publication requires api_call_started_at from the trusted submission chain";
  }
  if (
    canonicalJson(data?.supply_evidence) !== canonicalJson(reservation.data?.supply_evidence)
    || canonicalJson(data?.supply_candidates) !== canonicalJson(reservation.data?.supply_candidates)
    || canonicalJson(data?.supply_target_variant_canonical) !==
      canonicalJson(reservation.data?.supply_target_variant_canonical)
    || data?.purchase_price_original_p70_p80 !==
      reservation.data?.purchase_price_original_p70_p80
    || data?.purchase_price !== reservation.data?.purchase_price
    || data?.cost?.cost !== reservation.data?.cost?.cost
  ) {
    return "strict publication requires supply evidence persisted before the ERP submission with unchanged bindings";
  }
  return null;
}

function submissionSupplyInvariantError(data, cutoverAt, recordedAt, {
  allowPreCutover = false,
} = {}) {
  const rawApiCallStartedAt = data?.api_call_started_at;
  if (rawApiCallStartedAt === null || rawApiCallStartedAt === undefined || rawApiCallStartedAt === "") {
    return null;
  }
  const apiCallStartedAt = tolerantTimestamp(rawApiCallStartedAt);
  const normalizedCutoverAt = tolerantTimestamp(cutoverAt);
  const normalizedRecordedAt = tolerantTimestamp(recordedAt);
  if (!apiCallStartedAt || !normalizedCutoverAt || !normalizedRecordedAt) {
    return "submission requires a valid api_call_started_at and supply gate cutover";
  }
  if (Date.parse(apiCallStartedAt) > Date.parse(normalizedRecordedAt)) {
    return "submission api_call_started_at cannot be later than its durable runtime event";
  }
  if (Date.parse(apiCallStartedAt) < Date.parse(normalizedCutoverAt)) {
    return allowPreCutover
      ? null
      : "new ERP submission cannot backdate api_call_started_at before the supply gate cutover";
  }
  return supplyEvidenceV1InvariantError(data, apiCallStartedAt);
}

function trustedHistoricalSubmissionInvariantError(data, reservation, cutoverAt, eventAt) {
  const apiCallStartedAt = tolerantTimestamp(data?.api_call_started_at);
  const reservedApiCallStartedAt = tolerantTimestamp(reservation?.data?.api_call_started_at);
  const normalizedCutoverAt = tolerantTimestamp(cutoverAt);
  const normalizedEventAt = tolerantTimestamp(eventAt);
  if (
    !apiCallStartedAt
    || !reservedApiCallStartedAt
    || !normalizedCutoverAt
    || !normalizedEventAt
    || Date.parse(apiCallStartedAt) >= Date.parse(normalizedCutoverAt)
    || apiCallStartedAt !== reservedApiCallStartedAt
    || Date.parse(apiCallStartedAt) > Date.parse(normalizedEventAt)
    || !["submitted", "closed"].includes(String(reservation?.status || ""))
    || reservation?.data?.submitted !== true
  ) {
    return "direct terminal outcome requires a trusted pre-cutover submission chain";
  }
  return null;
}

function protectedSubmissionSupplyChanged(previousData, nextData, cutoverAt) {
  const previousApiCallStartedAt = tolerantTimestamp(previousData?.api_call_started_at);
  const normalizedCutoverAt = tolerantTimestamp(cutoverAt);
  if (
    !previousApiCallStartedAt
    || !normalizedCutoverAt
    || Date.parse(previousApiCallStartedAt) < Date.parse(normalizedCutoverAt)
  ) {
    return false;
  }
  return (
    previousApiCallStartedAt !== tolerantTimestamp(nextData?.api_call_started_at)
    || previousData?.supply_gate_passed !== nextData?.supply_gate_passed
    || canonicalJson(previousData?.supply_evidence) !== canonicalJson(nextData?.supply_evidence)
    || canonicalJson(previousData?.supply_candidates) !== canonicalJson(nextData?.supply_candidates)
    || canonicalJson(previousData?.target_variant) !== canonicalJson(nextData?.target_variant)
    || canonicalJson(previousData?.supply_target_variant_canonical) !==
      canonicalJson(nextData?.supply_target_variant_canonical)
    || previousData?.purchase_price_original_p70_p80 !==
      nextData?.purchase_price_original_p70_p80
    || previousData?.purchase_price !== nextData?.purchase_price
    || previousData?.cost?.cost !== nextData?.cost?.cost
  );
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

function sqliteReliableCostEvidenceCounts(dataExpression, { allowSubqueries = true } = {}) {
  const filteredCount = `coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.filtered_price_count') AS INTEGER), 0)`;
  const priceCount = `coalesce(json_array_length(json_extract(${dataExpression}, '$.cost.prices')), 0)`;
  const matchedCount = `coalesce(CAST(json_extract(${dataExpression}, '$.cost.matched_offer_count') AS INTEGER), 0)`;
  const evidenceMatchedCount = `coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.matched_offer_count') AS INTEGER), 0)`;
  const supportIds = `json_extract(${dataExpression}, '$.cost.balanced_supporting_offer_ids')`;
  const supportRows = `json_extract(${dataExpression}, '$.cost.balanced_supporting_offer_evidence')`;
  const selectedIds = `json_extract(${dataExpression}, '$.cost.selected_cluster_offer_ids')`;
  const selectedPrices = `json_extract(${dataExpression}, '$.cost.selected_cluster_prices')`;
  const matchedIds = `json_extract(${dataExpression}, '$.cost.matched_offer_ids')`;
  const supportId = (index) => `trim(CAST(json_extract(${supportIds}, '$[${index}]') AS TEXT))`;
  const supportRowId = (index) => `trim(CAST(json_extract(${supportRows}, '$[${index}].offer_id') AS TEXT))`;
  const supplierId = (index) => `trim(CAST(json_extract(${supportRows}, '$[${index}].supplier_id') AS TEXT))`;
  const arrayContains = (array, value) => `EXISTS (
    SELECT 1 FROM json_each(${array}) AS bound_value
    WHERE trim(CAST(bound_value.value AS TEXT)) = ${value}
  )`;
  const laneBindings = (count) => `(
    json_type(${supportIds}) = 'array' AND json_array_length(${supportIds}) = ${count} AND
    json_type(${supportRows}) = 'array' AND json_array_length(${supportRows}) = ${count} AND
    json_type(${selectedIds}) = 'array' AND json_array_length(${selectedIds}) >= ${count} AND
    json_type(${selectedPrices}) = 'array' AND json_array_length(${selectedPrices}) >= ${count} AND
    json_type(${matchedIds}) = 'array' AND json_array_length(${matchedIds}) >= ${count} AND
    ${Array.from({ length: count }, (_, index) => `(
      length(${supportId(index)}) > 0 AND
      ${supportId(index)} = ${supportRowId(index)}
      ${allowSubqueries ? `AND ${arrayContains(selectedIds, supportId(index))} AND ${arrayContains(matchedIds, supportId(index))}` : ""}
    )`).join(" AND ")}
  )`;
  return `(
    ${filteredCount} = ${priceCount} AND
    ${matchedCount} = ${evidenceMatchedCount} AND
    (
      (
        json_type(${dataExpression}, '$.cost.balanced_match') = 'true' AND
        trim(CAST(json_extract(${dataExpression}, '$.cost.balanced_match_type') AS TEXT)) = 'strong_single' AND
        ${filteredCount} >= 1 AND ${matchedCount} >= 1 AND
        ${laneBindings(1)}
      ) OR (
        json_type(${dataExpression}, '$.cost.balanced_match') = 'true' AND
        trim(CAST(json_extract(${dataExpression}, '$.cost.balanced_match_type') AS TEXT)) = 'corroborated_multi' AND
        ${filteredCount} >= 2 AND ${matchedCount} >= 2 AND
        ${laneBindings(2)} AND
        ${supportId(0)} <> ${supportId(1)} AND
        length(${supplierId(0)}) > 0 AND length(${supplierId(1)}) > 0 AND
        ${supplierId(0)} <> ${supplierId(1)}
      ) OR (
        ${filteredCount} >= 3 AND ${matchedCount} >= 3
      )
    )
  )`;
}

function sqliteReliableCostEvidence(dataExpression) {
  return `(
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_verified') AS INTEGER), 0) = 1 AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost.ok') AS INTEGER), 0) = 1 AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost.cost') AS REAL), 0) > 0 AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.contract') AS TEXT), '') = '1688-same-item-v1' AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.reliable_source') AS INTEGER), 0) = 1 AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.same_item_match') AS INTEGER), 0) = 1 AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.returned_evidence_verified') AS INTEGER), 0) = 1 AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost.same_item_match') AS INTEGER), 0) = 1 AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost.returned_evidence_verified') AS INTEGER), 0) = 1 AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.match_evidence_contract') AS TEXT), '') IN (
      '1688-returned-same-item-v2', '1688-returned-same-item-v3'
    ) AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost.match_evidence_contract') AS TEXT), '') =
      coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.match_evidence_contract') AS TEXT), '') AND
    ${sqliteReliableCostEvidenceCounts(dataExpression)} AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_source') AS TEXT), '') IN (
      'search_first_page_p70_similarity_filtered',
      'search_first_page_cluster_p70_similarity_filtered',
      'search_first_page_cluster_p80_similarity_filtered'
    ) AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.source') AS TEXT), '') =
      coalesce(CAST(json_extract(${dataExpression}, '$.cost_source') AS TEXT), '') AND
    coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.match_evidence_key') AS TEXT), '') =
      coalesce(CAST(json_extract(${dataExpression}, '$.cost.match_evidence_key') AS TEXT), '') AND
    (
      coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.match_evidence_contract') AS TEXT), '') =
        '1688-returned-same-item-v2' OR (
        length(trim(CAST(json_extract(${dataExpression}, '$.cost.selected_offer_id') AS TEXT))) > 0 AND
        trim(CAST(json_extract(${dataExpression}, '$.cost.selected_offer_id') AS TEXT)) =
          trim(CAST(json_extract(${dataExpression}, '$.cost_evidence.selected_offer_id') AS TEXT))
      )
    ) AND
    length(coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.match_evidence_key') AS TEXT), '')) = 64 AND
    lower(coalesce(CAST(json_extract(${dataExpression}, '$.cost_evidence.match_evidence_key') AS TEXT), ''))
      NOT GLOB '*[^0-9a-f]*'
  )`;
}

function sqliteValid1688OfferUrl(offerUrlExpression, offerIdExpression) {
  const offerId = `trim(CAST(${offerIdExpression} AS TEXT))`;
  const offerUrl = `lower(trim(CAST(${offerUrlExpression} AS TEXT)))`;
  const offerUrlAfterScheme = `substr(${offerUrl}, 9)`;
  const offerPathOffset = `instr(${offerUrlAfterScheme}, '/offer/')`;
  const offerAuthority = `substr(${offerUrlAfterScheme}, 1, ${offerPathOffset} - 1)`;
  const expectedOfferPath = `'/offer/' || ${offerId} || '.html'`;
  const offerPathAndSuffix = `substr(${offerUrlAfterScheme}, ${offerPathOffset})`;
  return `coalesce((
    length(${offerId}) > 0 AND
    ${offerId} NOT GLOB '*[^0-9]*' AND
    ${offerUrl} GLOB 'https://*' AND
    ${offerPathOffset} > 1 AND
    (${offerAuthority} = '1688.com' OR ${offerAuthority} GLOB '*.1688.com') AND
    ${offerAuthority} NOT GLOB '*[/:@]*' AND
    (
      ${offerPathAndSuffix} = ${expectedOfferPath} OR
      substr(${offerPathAndSuffix}, length(${expectedOfferPath}) + 1, 1) IN ('?', '#')
    )
  ), 0)`;
}

function sqliteCanonicalAlibabaImageAssetUrl(urlExpression) {
  // Keep each normalization stage behind a scalar-subquery alias. Inlining the
  // previous nested CASE expression duplicated its children exponentially and
  // produced ~120 KiB trigger definitions that /usr/bin/sqlite3 could not
  // reparse ("parser stack overflow"). This is the same SQL predicate, expressed
  // once per stage so the durable schema remains portable across SQLite builds.
  return `(SELECT CASE
    WHEN lower(canonical_without_query) GLOB 'https://*'
      AND canonical_path_offset > 1
      AND (
        lower(canonical_authority) = 'alicdn.com' OR
        lower(canonical_authority) GLOB '*.alicdn.com'
      )
      AND canonical_authority NOT GLOB '*[/:@]*'
      THEN 'https://' || lower(canonical_authority) ||
        CASE
          WHEN substr(canonical_pathname, -8) = '_sum.jpg'
            THEN substr(canonical_pathname, 1, length(canonical_pathname) - 8)
          ELSE canonical_pathname
        END
    ELSE canonical_raw
  END
  FROM (
    SELECT
      canonical_raw,
      canonical_without_query,
      canonical_path_offset,
      substr(canonical_after_scheme, 1, canonical_path_offset - 1) AS canonical_authority,
      substr(canonical_after_scheme, canonical_path_offset) AS canonical_pathname
    FROM (
      SELECT
        canonical_raw,
        canonical_without_query,
        canonical_after_scheme,
        instr(canonical_after_scheme, '/') AS canonical_path_offset
      FROM (
        SELECT
          canonical_raw,
          canonical_without_query,
          substr(canonical_without_query, 9) AS canonical_after_scheme
        FROM (
          SELECT
            canonical_raw,
            CASE
              WHEN instr(canonical_without_fragment, '?') > 0
                THEN substr(
                  canonical_without_fragment,
                  1,
                  instr(canonical_without_fragment, '?') - 1
                )
              ELSE canonical_without_fragment
            END AS canonical_without_query
          FROM (
            SELECT
              canonical_raw,
              CASE
                WHEN instr(canonical_raw, '#') > 0
                  THEN substr(canonical_raw, 1, instr(canonical_raw, '#') - 1)
                ELSE canonical_raw
              END AS canonical_without_fragment
            FROM (
              SELECT trim(CAST(${urlExpression} AS TEXT)) AS canonical_raw
            )
          )
        )
      )
    )
  ))`;
}

function sqliteSameFlatJsonObject(leftExpression, rightExpression) {
  return `(
    json_type(${leftExpression}) = 'object' AND
    json_type(${rightExpression}) = 'object' AND
    (SELECT count(*) FROM json_each(${leftExpression})) =
      (SELECT count(*) FROM json_each(${rightExpression})) AND
    NOT EXISTS (
      SELECT 1
      FROM json_each(${leftExpression}) AS expected_attribute
      LEFT JOIN json_each(${rightExpression}) AS actual_attribute
        ON actual_attribute.key = expected_attribute.key
      WHERE actual_attribute.key IS NULL
        OR actual_attribute.type <> expected_attribute.type
        OR CAST(actual_attribute.value AS TEXT) <> CAST(expected_attribute.value AS TEXT)
    )
  )`;
}

function sqliteSameJsonValue(leftExpression, rightExpression) {
  return `(
    json_type(${leftExpression}) IS NOT NULL AND
    json_type(${rightExpression}) IS NOT NULL AND
    (SELECT count(*) FROM json_tree(${leftExpression})) =
      (SELECT count(*) FROM json_tree(${rightExpression})) AND
    NOT EXISTS (
      SELECT 1
      FROM json_tree(${leftExpression}) AS expected_node
      LEFT JOIN json_tree(${rightExpression}) AS actual_node
        ON actual_node.fullkey = expected_node.fullkey
      WHERE actual_node.fullkey IS NULL
        OR actual_node.type <> expected_node.type
        OR (
          expected_node.type NOT IN ('array', 'object') AND
          coalesce(CAST(actual_node.atom AS TEXT), '<json-null>') <>
            coalesce(CAST(expected_node.atom AS TEXT), '<json-null>')
        )
    )
  )`;
}

function sqliteSupplyEvidence(dataExpression, submissionAtExpression) {
  const evidence = `${dataExpression} -> '$.supply_evidence'`;
  const value = (field) => `json_extract(${evidence}, '$.${field}')`;
  const type = (field) => `json_type(${evidence}, '$.${field}')`;
  const text = (field) => `trim(CAST(${value(field)} AS TEXT))`;
  const lowerText = (field) => `lower(${text(field)})`;
  const offerId = text("offer_id");
  const offerUrl = lowerText("offer_url");
  const matchEvidenceKey = lowerText("match_evidence_key");
  const costMatchEvidenceKey = `lower(trim(CAST(json_extract(${dataExpression}, '$.cost_evidence.match_evidence_key') AS TEXT)))`;
  const targetVariant = value("target_variant");
  const variantAttributes = value("variant_attributes");
  const canonicalTarget = `${dataExpression} -> '$.supply_target_variant_canonical'`;
  const variantMatchMode = text("variant_match_mode");
  const exactVariantMode = `(
    ${type("variant_match_mode")} IS NULL OR
    ${type("variant_match_mode")} = 'null' OR
    (${type("variant_match_mode")} = 'text' AND ${variantMatchMode} IN ('', 'exact'))
  )`;
  const imagePrimaryMode = `(
    ${type("variant_match_mode")} = 'text' AND ${variantMatchMode} = 'image_primary'
  )`;
  const imageMatchEvidence = `${evidence} -> '$.image_match_evidence'`;
  const imageMetrics = `${imageMatchEvidence} -> '$.image'`;
  const selectedVariant = `${evidence} -> '$.selected_variant'`;
  const variantDifferences = `${evidence} -> '$.variant_differences'`;
  const imageEvidenceValue = (field) => `json_extract(${imageMatchEvidence}, '$.${field}')`;
  const imageEvidenceType = (field) => `json_type(${imageMatchEvidence}, '$.${field}')`;
  const imageMetricValue = (field) => `json_extract(${imageMetrics}, '$.${field}')`;
  const imageMetricType = (field) => `json_type(${imageMetrics}, '$.${field}')`;
  const imageMetricInUnitInterval = (field) => `(
    ${imageMetricType(field)} IN ('integer', 'real') AND
    CAST(${imageMetricValue(field)} AS REAL) BETWEEN 0 AND 1
  )`;
  return `coalesce((
    json_type(${dataExpression}, '$.supply_gate_passed') = 'true' AND
    json_type(${dataExpression}, '$.supply_evidence') = 'object' AND
    ${type("contract")} = 'text' AND ${text("contract")} = '${SUPPLY_EVIDENCE_CONTRACT}' AND
    ${type("passed")} = 'true' AND
    ${type("platform")} = 'text' AND ${text("platform")} = '1688' AND
    ${type("offer_id")} IN ('text', 'integer') AND length(${offerId}) > 0 AND
    ${type("offer_url")} = 'text' AND
    ${sqliteValid1688OfferUrl(value("offer_url"), value("offer_id"))} AND
    json_type(${dataExpression}, '$.supply_candidates') = 'array' AND
    json_array_length(${dataExpression} -> '$.supply_candidates') BETWEEN 1 AND 3 AND
    EXISTS (
      SELECT 1
      FROM json_each(${dataExpression}, '$.supply_candidates') AS supply_candidate
      WHERE json_type(supply_candidate.value) = 'object'
        AND json_type(supply_candidate.value, '$.platform') = 'text'
        AND trim(CAST(json_extract(supply_candidate.value, '$.platform') AS TEXT)) = '1688'
        AND json_type(supply_candidate.value, '$.offer_id') IN ('text', 'integer')
        AND trim(CAST(json_extract(supply_candidate.value, '$.offer_id') AS TEXT)) = ${offerId}
        AND json_type(supply_candidate.value, '$.offer_url') = 'text'
        AND lower(trim(CAST(json_extract(supply_candidate.value, '$.offer_url') AS TEXT))) = ${offerUrl}
        AND ${sqliteValid1688OfferUrl(
          "json_extract(supply_candidate.value, '$.offer_url')",
          "json_extract(supply_candidate.value, '$.offer_id')",
        )}
        AND json_type(supply_candidate.value, '$.match_type') = 'text'
        AND trim(CAST(json_extract(supply_candidate.value, '$.match_type') AS TEXT))
          IN ('strong_single', 'corroborated_multi')
        AND json_type(supply_candidate.value, '$.match_evidence_key') = 'text'
        AND lower(trim(CAST(json_extract(supply_candidate.value, '$.match_evidence_key') AS TEXT))) =
          ${matchEvidenceKey}
    ) AND
    json_type(${dataExpression}, '$.supply_target_variant_canonical') = 'object' AND
    (
      (
        ${exactVariantMode} AND
        json(${canonicalTarget}) = '{}' AND
        ${type("item_level_match")} = 'true' AND
        (
          ${type("target_variant")} IS NULL OR
          ${type("target_variant")} = 'null' OR
          (${type("target_variant")} = 'object' AND json(${targetVariant}) = '{}')
        ) AND
        ${type("variant_attributes")} = 'object' AND
        json(${variantAttributes}) = '{}'
      ) OR (
        ${exactVariantMode} AND
        json(${canonicalTarget}) <> '{}' AND
        ${type("item_level_match")} = 'false' AND
        ${type("target_variant")} = 'object' AND
        ${type("variant_attributes")} = 'object' AND
        ${sqliteSameFlatJsonObject(canonicalTarget, targetVariant)} AND
        ${sqliteSameFlatJsonObject(canonicalTarget, variantAttributes)}
      ) OR (
        ${imagePrimaryMode} AND
        ${type("match_basis")} = 'text' AND ${text("match_basis")} = '${IMAGE_PRIMARY_MATCH_BASIS}' AND
        ${type("item_level_match")} = 'false' AND
        ${type("variant_selection_required")} = 'true' AND
        ${type("variant_differences")} = 'array' AND
        json_type(${selectedVariant}) = 'object' AND
        json_type(${selectedVariant}, '$.row_key') = 'text' AND
        length(trim(CAST(json_extract(${selectedVariant}, '$.row_key') AS TEXT))) > 0 AND
        json_type(${selectedVariant}, '$.label') = 'text' AND
        length(trim(CAST(json_extract(${selectedVariant}, '$.label') AS TEXT))) > 0 AND
        json_type(${selectedVariant}, '$.soft_tie') = 'false' AND
        json_type(${selectedVariant}, '$.selection_method') = 'text' AND
        trim(CAST(json_extract(${selectedVariant}, '$.selection_method') AS TEXT)) IN (
          'image_primary_best_target_overlap',
          '${IMAGE_PRIMARY_EXACT_THUMBNAIL_SELECTION_METHOD}'
        ) AND
        (
          (
            trim(CAST(json_extract(${selectedVariant}, '$.selection_method') AS TEXT)) =
              'image_primary_best_target_overlap' AND
            json_type(${selectedVariant}, '$.selected_sku_image_url') IS NULL
          ) OR (
            trim(CAST(json_extract(${selectedVariant}, '$.selection_method') AS TEXT)) =
              '${IMAGE_PRIMARY_EXACT_THUMBNAIL_SELECTION_METHOD}' AND
            json_type(${selectedVariant}, '$.selected_sku_image_url') = 'text' AND
            lower(trim(CAST(json_extract(${selectedVariant}, '$.selected_sku_image_url') AS TEXT)))
              GLOB 'https://*' AND
            ${sqliteCanonicalAlibabaImageAssetUrl(
              `json_extract(${selectedVariant}, '$.selected_sku_image_url')`,
            )} = ${sqliteCanonicalAlibabaImageAssetUrl(imageEvidenceValue("image_url"))}
          )
        ) AND
        ${type("variant_attributes")} = 'object' AND
        (
          (
            json(${canonicalTarget}) = '{}' AND
            (
              ${type("target_variant")} IS NULL OR
              ${type("target_variant")} = 'null' OR
              (${type("target_variant")} = 'object' AND json(${targetVariant}) = '{}')
            )
          ) OR (
            json(${canonicalTarget}) <> '{}' AND
            ${type("target_variant")} = 'object' AND
            ${sqliteSameFlatJsonObject(canonicalTarget, targetVariant)}
          )
        ) AND
        NOT coalesce((
          json_type(${canonicalTarget}, '$.set_quantity') IN ('integer', 'real', 'text') AND
          CAST(json_extract(${canonicalTarget}, '$.set_quantity') AS REAL) > 1
        ), 0) AND
        (
          SELECT count(*)
          FROM json_each(${variantDifferences}) AS reported_difference
        ) = (
          SELECT count(*)
          FROM json_each(${canonicalTarget}) AS target_attribute
          WHERE NOT EXISTS (
            SELECT 1
            FROM json_each(${variantAttributes}) AS bound_attribute
            WHERE bound_attribute.key = target_attribute.key
              AND bound_attribute.type = target_attribute.type
              AND coalesce(CAST(bound_attribute.atom AS TEXT), '<json-null>') =
                coalesce(CAST(target_attribute.atom AS TEXT), '<json-null>')
          )
        ) AND
        (
          SELECT count(DISTINCT trim(CAST(json_extract(reported_difference.value, '$.name') AS TEXT)))
          FROM json_each(${variantDifferences}) AS reported_difference
        ) = json_array_length(${variantDifferences}) AND
        NOT EXISTS (
          SELECT 1
          FROM json_each(${variantDifferences}) AS reported_difference
          WHERE json_type(reported_difference.value) <> 'object'
            OR (SELECT count(*) FROM json_each(reported_difference.value)) <> 4
            OR json_type(reported_difference.value, '$.name') <> 'text'
            OR json_type(reported_difference.value, '$.kind') <> 'text'
            OR trim(CAST(json_extract(reported_difference.value, '$.kind') AS TEXT)) <> 'unbound_soft'
            OR json_type(reported_difference.value, '$.observed') <> 'null'
            OR NOT EXISTS (
              SELECT 1
              FROM json_each(${canonicalTarget}) AS target_attribute
              WHERE target_attribute.key = trim(CAST(json_extract(reported_difference.value, '$.name') AS TEXT))
                AND json_type(reported_difference.value, '$.expected') = target_attribute.type
                AND coalesce(CAST(json_extract(reported_difference.value, '$.expected') AS TEXT), '<json-null>') =
                  coalesce(CAST(target_attribute.atom AS TEXT), '<json-null>')
                AND NOT EXISTS (
                  SELECT 1
                  FROM json_each(${variantAttributes}) AS bound_attribute
                  WHERE bound_attribute.key = target_attribute.key
                    AND bound_attribute.type = target_attribute.type
                    AND coalesce(CAST(bound_attribute.atom AS TEXT), '<json-null>') =
                      coalesce(CAST(target_attribute.atom AS TEXT), '<json-null>')
                )
            )
        ) AND
        json_type(${imageMatchEvidence}) = 'object' AND
        ${imageEvidenceType("offer_id")} IN ('text', 'integer') AND
        trim(CAST(${imageEvidenceValue("offer_id")} AS TEXT)) = ${offerId} AND
        ${imageEvidenceType("source_contract")} = 'text' AND
        trim(CAST(${imageEvidenceValue("source_contract")} AS TEXT)) = '${IMAGE_PRIMARY_SOURCE_CONTRACT}' AND
        ${imageEvidenceType("image_url")} = 'text' AND
        lower(trim(CAST(${imageEvidenceValue("image_url")} AS TEXT))) GLOB 'https://*' AND
        json_type(${imageMetrics}) = 'object' AND
        ${imageMetricType("available")} = 'true' AND
        ${imageMetricInUnitInterval("score")} AND
        ${imageMetricInUnitInterval("color_score")} AND
        ${imageMetricInUnitInterval("dhash_score")} AND
        ${imageEvidenceType("semantic_strength")} = 'text' AND
        trim(CAST(${imageEvidenceValue("semantic_strength")} AS TEXT)) IN (
          'exact_model', 'two_high_information_terms', 'one_high_information_term',
          'one_high_information_plus_product', 'product_semantics', 'image_backed'
        ) AND
        ${imageEvidenceType("spec_conflicts")} = 'array' AND
        json_array_length(${imageEvidenceValue("spec_conflicts")}) = 0 AND
        (
          ${imageEvidenceType("identity_conflicts")} IS NULL OR
          (
            ${imageEvidenceType("identity_conflicts")} = 'array' AND
            json_array_length(${imageEvidenceValue("identity_conflicts")}) = 0
          )
        ) AND
        ${imageEvidenceType("accessory_conflict")} = 'false' AND
        ${imageEvidenceType("lane")} = 'text' AND
        (
          (
            trim(CAST(${imageEvidenceValue("lane")} AS TEXT)) = 'strong_visual' AND
            trim(CAST(${imageEvidenceValue("semantic_strength")} AS TEXT)) <> 'image_backed' AND
            CAST(${imageMetricValue("score")} AS REAL) >= 0.68 AND
            CAST(${imageMetricValue("dhash_score")} AS REAL) >= 0.55 AND
            CAST(${imageMetricValue("color_score")} AS REAL) >= 0.90
          ) OR (
            trim(CAST(${imageEvidenceValue("lane")} AS TEXT)) = 'strong_visual_text_soft' AND
            trim(CAST(${imageEvidenceValue("semantic_strength")} AS TEXT)) = 'image_backed' AND
            ${imageEvidenceType("identity_conflicts")} = 'array' AND
            json_array_length(${imageEvidenceValue("identity_conflicts")}) = 0 AND
            CAST(${imageMetricValue("score")} AS REAL) >= 0.90 AND
            CAST(${imageMetricValue("dhash_score")} AS REAL) >= 0.82 AND
            CAST(${imageMetricValue("color_score")} AS REAL) >= 0.90
          ) OR (
            trim(CAST(${imageEvidenceValue("lane")} AS TEXT)) = 'corroborated_visual' AND
            CAST(${imageMetricValue("score")} AS REAL) >= 0.60 AND
            CAST(${imageMetricValue("dhash_score")} AS REAL) >= 0.46 AND
            CAST(${imageMetricValue("color_score")} AS REAL) >= 0.82 AND
            ${imageEvidenceType("corroborating_offer_ids")} = 'array' AND
            json_array_length(${imageEvidenceValue("corroborating_offer_ids")}) >= 2 AND
            NOT EXISTS (
              SELECT 1
              FROM json_each(${imageEvidenceValue("corroborating_offer_ids")}) AS corroborating_offer
              WHERE corroborating_offer.type NOT IN ('text', 'integer')
                OR length(trim(CAST(corroborating_offer.value AS TEXT))) = 0
                OR trim(CAST(corroborating_offer.value AS TEXT)) GLOB '*[^0-9]*'
            ) AND
            (
              SELECT count(DISTINCT trim(CAST(corroborating_offer.value AS TEXT)))
              FROM json_each(${imageEvidenceValue("corroborating_offer_ids")}) AS corroborating_offer
            ) = json_array_length(${imageEvidenceValue("corroborating_offer_ids")}) AND
            EXISTS (
              SELECT 1
              FROM json_each(${imageEvidenceValue("corroborating_offer_ids")}) AS corroborating_offer
              WHERE trim(CAST(corroborating_offer.value AS TEXT)) = ${offerId}
            )
          )
        ) AND
        EXISTS (
          SELECT 1
          FROM json_each(${dataExpression}, '$.supply_candidates') AS image_supply_candidate
          WHERE json_type(image_supply_candidate.value) = 'object'
            AND trim(CAST(json_extract(image_supply_candidate.value, '$.offer_id') AS TEXT)) = ${offerId}
            AND lower(trim(CAST(json_extract(image_supply_candidate.value, '$.offer_url') AS TEXT))) = ${offerUrl}
            AND json_type(image_supply_candidate.value, '$.match_basis') = 'text'
            AND trim(CAST(json_extract(image_supply_candidate.value, '$.match_basis') AS TEXT)) =
              '${IMAGE_PRIMARY_MATCH_BASIS}'
            AND (
              trim(CAST(${imageEvidenceValue("lane")} AS TEXT)) <> 'corroborated_visual' OR
              (
                json_type(image_supply_candidate.value, '$.match_type') = 'text' AND
                trim(CAST(json_extract(image_supply_candidate.value, '$.match_type') AS TEXT)) =
                  'corroborated_multi'
              )
            )
            AND ${sqliteSameJsonValue(
              "image_supply_candidate.value -> '$.image_match_evidence'",
              imageMatchEvidence,
            )}
            AND (
              SELECT count(*)
              FROM json_each(${dataExpression}, '$.cost.balanced_supporting_offer_evidence') AS supporting_cost_row
              WHERE trim(CAST(json_extract(supporting_cost_row.value, '$.offer_id') AS TEXT)) = ${offerId}
            ) = 1
            AND EXISTS (
              SELECT 1
              FROM json_each(${dataExpression}, '$.cost.balanced_supporting_offer_evidence') AS supporting_cost_row
              WHERE json_type(supporting_cost_row.value) = 'object'
                AND json_type(supporting_cost_row.value, '$.offer_id') = 'text'
                AND json_type(image_supply_candidate.value, '$.image_match_evidence.offer_id') = 'text'
                AND json_extract(supporting_cost_row.value, '$.offer_id') =
                  json_extract(image_supply_candidate.value, '$.image_match_evidence.offer_id')
                AND trim(CAST(json_extract(supporting_cost_row.value, '$.offer_id') AS TEXT)) = ${offerId}
                AND json_type(supporting_cost_row.value, '$.title') = 'text'
                AND json_type(image_supply_candidate.value, '$.image_match_evidence.title') = 'text'
                AND length(trim(CAST(json_extract(supporting_cost_row.value, '$.title') AS TEXT))) > 0
                AND json_extract(supporting_cost_row.value, '$.title') =
                  json_extract(image_supply_candidate.value, '$.image_match_evidence.title')
                AND json_type(supporting_cost_row.value, '$.supplier_id') = 'text'
                AND json_type(image_supply_candidate.value, '$.image_match_evidence.supplier_id') = 'text'
                AND length(trim(CAST(json_extract(supporting_cost_row.value, '$.supplier_id') AS TEXT))) > 0
                AND json_extract(supporting_cost_row.value, '$.supplier_id') =
                  json_extract(image_supply_candidate.value, '$.image_match_evidence.supplier_id')
                AND json_type(supporting_cost_row.value, '$.image_url') = 'text'
                AND json_type(image_supply_candidate.value, '$.image_match_evidence.image_url') = 'text'
                AND lower(trim(CAST(json_extract(supporting_cost_row.value, '$.image_url') AS TEXT)))
                  GLOB 'https://*'
                AND json_extract(supporting_cost_row.value, '$.image_url') =
                  json_extract(image_supply_candidate.value, '$.image_match_evidence.image_url')
                AND ${sqliteSameJsonValue(
                  "supporting_cost_row.value -> '$.image'",
                  "image_supply_candidate.value -> '$.image_match_evidence.image'",
                )}
                AND json_type(supporting_cost_row.value, '$.semantic_strength') = 'text'
                AND json_type(image_supply_candidate.value, '$.image_match_evidence.semantic_strength') = 'text'
                AND json_extract(supporting_cost_row.value, '$.semantic_strength') =
                  json_extract(image_supply_candidate.value, '$.image_match_evidence.semantic_strength')
                AND (
                  (
                    json_type(supporting_cost_row.value, '$.semantic_hits_v3') IS NULL AND
                    json_type(image_supply_candidate.value, '$.image_match_evidence.semantic_hits_v3') IS NULL
                  ) OR (
                    json_type(supporting_cost_row.value, '$.semantic_hits_v3') = 'object' AND
                    json_type(image_supply_candidate.value, '$.image_match_evidence.semantic_hits_v3') = 'object' AND
                    ${sqliteSameJsonValue(
                      "supporting_cost_row.value -> '$.semantic_hits_v3'",
                      "image_supply_candidate.value -> '$.image_match_evidence.semantic_hits_v3'",
                    )}
                  )
                )
                AND ${sqliteSameJsonValue(
                  "supporting_cost_row.value -> '$.spec_conflicts'",
                  "image_supply_candidate.value -> '$.image_match_evidence.spec_conflicts'",
                )}
                AND (
                  (
                    json_type(supporting_cost_row.value, '$.identity_conflicts') IS NULL AND
                    json_type(image_supply_candidate.value, '$.image_match_evidence.identity_conflicts') IS NULL
                  ) OR (
                    json_type(supporting_cost_row.value, '$.identity_conflicts') = 'array' AND
                    json_type(image_supply_candidate.value, '$.image_match_evidence.identity_conflicts') = 'array' AND
                    ${sqliteSameJsonValue(
                      "supporting_cost_row.value -> '$.identity_conflicts'",
                      "image_supply_candidate.value -> '$.image_match_evidence.identity_conflicts'",
                    )}
                  )
                )
                AND json_type(supporting_cost_row.value, '$.accessory_conflict') = 'false'
                AND json_type(image_supply_candidate.value, '$.image_match_evidence.accessory_conflict') = 'false'
            )
        )
      )
    ) AND
    ${type("moq")} IN ('integer', 'real') AND
    CAST(${value("moq")} AS REAL) > 0 AND CAST(${value("moq")} AS REAL) <= 1 AND
    ${type("orderable_quantity")} = 'integer' AND CAST(${value("orderable_quantity")} AS INTEGER) = 1 AND
    ${type("unit_price")} IN ('integer', 'real') AND CAST(${value("unit_price")} AS REAL) > 0 AND
    json_type(${dataExpression}, '$.purchase_price_original_p70_p80') IN ('integer', 'real') AND
    CAST(json_extract(${dataExpression}, '$.purchase_price_original_p70_p80') AS REAL) > 0 AND
    json_type(${dataExpression}, '$.purchase_price') IN ('integer', 'real') AND
    CAST(json_extract(${dataExpression}, '$.purchase_price') AS REAL) > 0 AND
    json_type(${dataExpression}, '$.cost.cost') IN ('integer', 'real') AND
    CAST(json_extract(${dataExpression}, '$.cost.cost') AS REAL) > 0 AND
    CAST(json_extract(${dataExpression}, '$.purchase_price_original_p70_p80') AS REAL) +
      ${SUPPLY_PRICE_EPSILON} >= CAST(json_extract(${dataExpression}, '$.cost.cost') AS REAL) AND
    CAST(json_extract(${dataExpression}, '$.purchase_price') AS REAL) + ${SUPPLY_PRICE_EPSILON} >=
      CAST(json_extract(${dataExpression}, '$.purchase_price_original_p70_p80') AS REAL) AND
    CAST(json_extract(${dataExpression}, '$.purchase_price') AS REAL) + ${SUPPLY_PRICE_EPSILON} >=
      CAST(${value("unit_price")} AS REAL) AND
    ${type("stock_state")} = 'text' AND ${text("stock_state")} = 'in_stock' AND
    ${type("orderable")} = 'true' AND
    ${type("match_evidence_key")} = 'text' AND
    length(${matchEvidenceKey}) = 64 AND ${matchEvidenceKey} NOT GLOB '*[^0-9a-f]*' AND
    ${matchEvidenceKey} = ${costMatchEvidenceKey} AND
    ${type("checked_at")} = 'text' AND julianday(${value("checked_at")}) IS NOT NULL AND
    ${type("valid_until")} = 'text' AND julianday(${value("valid_until")}) IS NOT NULL AND
    julianday(${value("valid_until")}) > julianday(${value("checked_at")}) AND
    unixepoch(${value("valid_until")}) - unixepoch(${value("checked_at")}) <= ${SUPPLY_EVIDENCE_MAX_AGE_MS / 1000} AND
    julianday(${value("checked_at")}) <= julianday(${submissionAtExpression}) AND
    julianday(${submissionAtExpression}) < julianday(${value("valid_until")})
  ), 0)`;
}

function sqliteTrustedSupplySubmission(dataExpression, skuExpression, strictAtExpression) {
  const apiCallStartedAt = `json_extract(${dataExpression}, '$.api_call_started_at')`;
  return `EXISTS (
    SELECT 1
    FROM submission_reservations AS trusted_supply_submission
    WHERE trusted_supply_submission.sku = ${skuExpression}
      AND trusted_supply_submission.status IN ('submitted', 'closed')
      AND json_type(trusted_supply_submission.data_json, '$.submitted') = 'true'
      AND json_type(trusted_supply_submission.data_json, '$.supply_gate_passed') = 'true'
      AND json_type(trusted_supply_submission.data_json, '$.api_call_started_at') = 'text'
      AND trim(CAST(json_extract(
        trusted_supply_submission.data_json,
        '$.api_call_started_at'
      ) AS TEXT)) = trim(CAST(${apiCallStartedAt} AS TEXT))
      AND julianday(${apiCallStartedAt}) IS NOT NULL
      AND julianday(${apiCallStartedAt}) <= julianday(${strictAtExpression})
      AND json_type(trusted_supply_submission.data_json, '$.supply_evidence') = 'object'
      AND json(trusted_supply_submission.data_json -> '$.supply_evidence') =
        json(${dataExpression} -> '$.supply_evidence')
      AND json_type(trusted_supply_submission.data_json, '$.supply_candidates') = 'array'
      AND json(trusted_supply_submission.data_json -> '$.supply_candidates') =
        json(${dataExpression} -> '$.supply_candidates')
      AND json_type(
        trusted_supply_submission.data_json,
        '$.supply_target_variant_canonical'
      ) = 'object'
      AND json(trusted_supply_submission.data_json -> '$.supply_target_variant_canonical') =
        json(${dataExpression} -> '$.supply_target_variant_canonical')
      AND json_type(
        trusted_supply_submission.data_json,
        '$.purchase_price_original_p70_p80'
      ) IN ('integer', 'real')
      AND CAST(json_extract(
        trusted_supply_submission.data_json,
        '$.purchase_price_original_p70_p80'
      ) AS REAL) = CAST(json_extract(
        ${dataExpression},
        '$.purchase_price_original_p70_p80'
      ) AS REAL)
      AND json_type(trusted_supply_submission.data_json, '$.purchase_price') IN ('integer', 'real')
      AND CAST(json_extract(trusted_supply_submission.data_json, '$.purchase_price') AS REAL) =
        CAST(json_extract(${dataExpression}, '$.purchase_price') AS REAL)
      AND json_type(trusted_supply_submission.data_json, '$.cost.cost') IN ('integer', 'real')
      AND CAST(json_extract(trusted_supply_submission.data_json, '$.cost.cost') AS REAL) =
        CAST(json_extract(${dataExpression}, '$.cost.cost') AS REAL)
  )`;
}

function sqliteTrustedHistoricalSubmission(dataExpression, skuExpression, eventAtExpression) {
  const apiCallStartedAt = `json_extract(${dataExpression}, '$.api_call_started_at')`;
  const cutover = `(
    SELECT value FROM metadata WHERE key = '${SUPPLY_GATE_CUTOVER_METADATA_KEY}'
  )`;
  return `EXISTS (
    SELECT 1
    FROM submission_reservations AS trusted_historical_submission
    WHERE trusted_historical_submission.sku = ${skuExpression}
      AND trusted_historical_submission.status IN ('submitted', 'closed')
      AND json_type(trusted_historical_submission.data_json, '$.submitted') = 'true'
      AND json_type(trusted_historical_submission.data_json, '$.api_call_started_at') = 'text'
      AND trim(CAST(json_extract(
        trusted_historical_submission.data_json,
        '$.api_call_started_at'
      ) AS TEXT)) = trim(CAST(${apiCallStartedAt} AS TEXT))
      AND julianday(${apiCallStartedAt}) IS NOT NULL
      AND julianday(${apiCallStartedAt}) < julianday(${cutover})
      AND julianday(${apiCallStartedAt}) <= julianday(${eventAtExpression})
  )`;
}

function sqliteAtOrAfterSupplyGateCutover(timestampExpression) {
  const cutover = `(
    SELECT value FROM metadata WHERE key = '${SUPPLY_GATE_CUTOVER_METADATA_KEY}'
  )`;
  return `(
    julianday(${cutover}) IS NULL OR
    julianday(${timestampExpression}) IS NULL OR
    julianday(${timestampExpression}) >= julianday(${cutover})
  )`;
}

function sqliteBeforeSupplyGateCutover(timestampExpression) {
  const cutover = `(
    SELECT value FROM metadata WHERE key = '${SUPPLY_GATE_CUTOVER_METADATA_KEY}'
  )`;
  return `(
    julianday(${cutover}) IS NOT NULL AND
    julianday(${timestampExpression}) IS NOT NULL AND
    julianday(${timestampExpression}) < julianday(${cutover})
  )`;
}

function sqliteLegacyEventInsert(eventKeyExpression, sourceExpression, occurredAtExpression) {
  return `(
    CAST(${eventKeyExpression} AS TEXT) GLOB 'legacy:*' AND
    CAST(${sourceExpression} AS TEXT) GLOB 'legacy:*' AND
    ${sqliteBeforeSupplyGateCutover(occurredAtExpression)}
  )`;
}

function sqliteLegacyStateProjection({
  dataExpression,
  skuExpression,
  stageExpression,
  strictExpression,
  updatedAtExpression,
}) {
  return `EXISTS (
    SELECT 1
    FROM events AS legacy_projection_event
    WHERE legacy_projection_event.sku = ${skuExpression}
      AND legacy_projection_event.stage = ${stageExpression}
      AND legacy_projection_event.strict = ${strictExpression}
      AND legacy_projection_event.event_key GLOB 'legacy:*'
      AND legacy_projection_event.source GLOB 'legacy:*'
      AND legacy_projection_event.occurred_at = ${updatedAtExpression}
      AND ${sqliteBeforeSupplyGateCutover("legacy_projection_event.occurred_at")}
      AND json(legacy_projection_event.data_json) = json(${dataExpression})
  )`;
}

function sqliteLegacyStrictPublication({
  dataExpression,
  skuExpression,
  eventIdExpression,
  publishedAtExpression,
}) {
  return `EXISTS (
    SELECT 1
    FROM events AS legacy_strict_event
    WHERE legacy_strict_event.id = ${eventIdExpression}
      AND legacy_strict_event.sku = ${skuExpression}
      AND legacy_strict_event.strict = 1
      AND legacy_strict_event.event_key GLOB 'legacy:*'
      AND legacy_strict_event.source GLOB 'legacy:*'
      AND legacy_strict_event.occurred_at = ${publishedAtExpression}
      AND ${sqliteBeforeSupplyGateCutover("legacy_strict_event.occurred_at")}
      AND json(legacy_strict_event.data_json) = json(${dataExpression})
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
  if (TERMINAL_OUTCOME_STAGES.has(stage)) {
    return {
      sku,
      stage,
      reason,
      failureClass: null,
      terminal: true,
      strict: false,
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
  let supplyGateCutoverAt = null;

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
    const preexistingSupplyGateCutover = metadataExists
      ? database.prepare("SELECT value FROM metadata WHERE key = ?")
        .get(SUPPLY_GATE_CUTOVER_METADATA_KEY)?.value
      : null;
    if (
      preexistingVersion !== null &&
      Number.isFinite(preexistingVersion) &&
      ![1, 2, 3, RUNTIME_STATE_SCHEMA_VERSION].includes(preexistingVersion)
    ) {
      throw new Error(
        `unsupported runtime-state schema version ${preexistingVersion}; expected ${RUNTIME_STATE_SCHEMA_VERSION}`,
      );
    }
    if (preexistingVersion === RUNTIME_STATE_SCHEMA_VERSION) {
      if (!tolerantTimestamp(preexistingSupplyGateCutover)) {
        throw new Error("runtime-state schema v4 is missing a valid supply gate cutover timestamp");
      }
    }
    if ([1, 2, 3].includes(preexistingVersion)) {
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
            ${sqliteReliableCostEvidenceCounts("data_json", { allowSubqueries: false })} AND
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
            ${sqliteReliableCostEvidenceCounts("data_json", { allowSubqueries: false })} AND
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
          ${sqliteReliableCostEvidenceCounts("data_json", { allowSubqueries: false })} AND
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

      DROP INDEX IF EXISTS ${LEGACY_ACCEPTED_AUDIT_RESERVATION_INDEX};

      CREATE INDEX IF NOT EXISTS ${ACCEPTED_AUDIT_RESERVATION_INDEX}
      ON submission_reservations (
        ${ACCEPTED_AUDIT_RUN_DIR_SQL},
        (${ACCEPTED_AUDIT_TIMESTAMP_SQL}),
        sku,
        CAST(json_extract(data_json, '$.store_id') AS INTEGER),
        json_extract(data_json, '$.offer_id'),
        json_extract(data_json, '$.at')
      )
      WHERE ${ACCEPTED_AUDIT_PREDICATE_SQL};

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
    if (preexistingVersion === RUNTIME_STATE_SCHEMA_VERSION) {
      supplyGateCutoverAt = timestamp(preexistingSupplyGateCutover, "supply gate cutover");
    } else {
      supplyGateCutoverAt = currentTimestamp();
      database.exec(`
        DROP TRIGGER IF EXISTS runtime_supply_gate_cutover_update_guard;
        DROP TRIGGER IF EXISTS runtime_supply_gate_cutover_delete_guard;
      `);
      database.prepare(`
        INSERT INTO metadata (key, value)
        VALUES (?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `).run(SUPPLY_GATE_CUTOVER_METADATA_KEY, supplyGateCutoverAt);
    }
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

      DROP TRIGGER IF EXISTS events_strict_supply_evidence_insert;
      DROP TRIGGER IF EXISTS events_strict_supply_evidence_update;
      DROP TRIGGER IF EXISTS sku_state_strict_supply_evidence_insert;
      DROP TRIGGER IF EXISTS sku_state_strict_supply_evidence_update;
      DROP TRIGGER IF EXISTS strict_publications_supply_evidence_insert;
      DROP TRIGGER IF EXISTS strict_publications_supply_evidence_update;
      DROP TRIGGER IF EXISTS submission_reservations_supply_evidence_insert;
      DROP TRIGGER IF EXISTS submission_reservations_supply_evidence_update;
      DROP TRIGGER IF EXISTS submission_reservations_supply_evidence_immutable;
      DROP TRIGGER IF EXISTS events_direct_supply_evidence_insert;
      DROP TRIGGER IF EXISTS events_direct_supply_evidence_update;
      DROP TRIGGER IF EXISTS sku_state_direct_supply_evidence_insert;
      DROP TRIGGER IF EXISTS sku_state_direct_supply_evidence_update;

      CREATE TRIGGER submission_reservations_supply_evidence_insert
      BEFORE INSERT ON submission_reservations
      FOR EACH ROW
      WHEN json_type(NEW.data_json, '$.api_call_started_at') IS NOT NULL
        AND NOT (
          ${sqliteAtOrAfterSupplyGateCutover("json_extract(NEW.data_json, '$.api_call_started_at')")}
          AND ${sqliteSupplyEvidence("NEW.data_json", "json_extract(NEW.data_json, '$.api_call_started_at')")}
          AND julianday(json_extract(NEW.data_json, '$.api_call_started_at')) <= julianday(NEW.updated_at)
        )
      BEGIN
        SELECT RAISE(ABORT, 'ERP submission requires valid SupplyEvidenceV1');
      END;

      CREATE TRIGGER submission_reservations_supply_evidence_update
      BEFORE UPDATE OF data_json ON submission_reservations
      FOR EACH ROW
      WHEN json_type(NEW.data_json, '$.api_call_started_at') IS NOT NULL
        AND NOT (
          (
            json_type(OLD.data_json, '$.api_call_started_at') = 'text'
            AND NOT ${sqliteAtOrAfterSupplyGateCutover("json_extract(OLD.data_json, '$.api_call_started_at')")}
            AND trim(CAST(json_extract(NEW.data_json, '$.api_call_started_at') AS TEXT)) =
              trim(CAST(json_extract(OLD.data_json, '$.api_call_started_at') AS TEXT))
          ) OR (
            ${sqliteAtOrAfterSupplyGateCutover("json_extract(NEW.data_json, '$.api_call_started_at')")}
            AND ${sqliteSupplyEvidence("NEW.data_json", "json_extract(NEW.data_json, '$.api_call_started_at')")}
            AND julianday(json_extract(NEW.data_json, '$.api_call_started_at')) <= julianday(NEW.updated_at)
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'ERP submission requires valid SupplyEvidenceV1');
      END;

      CREATE TRIGGER submission_reservations_supply_evidence_immutable
      BEFORE UPDATE OF data_json ON submission_reservations
      FOR EACH ROW
      WHEN json_type(OLD.data_json, '$.api_call_started_at') = 'text'
        AND ${sqliteAtOrAfterSupplyGateCutover("json_extract(OLD.data_json, '$.api_call_started_at')")}
        AND (
          coalesce(json_type(NEW.data_json, '$.api_call_started_at'), '') <> 'text' OR
          coalesce(trim(CAST(json_extract(NEW.data_json, '$.api_call_started_at') AS TEXT)), '') <>
            trim(CAST(json_extract(OLD.data_json, '$.api_call_started_at') AS TEXT)) OR
          coalesce(json_type(NEW.data_json, '$.supply_gate_passed'), '') <> 'true' OR
          coalesce(json(NEW.data_json -> '$.supply_evidence'), 'null') <>
            coalesce(json(OLD.data_json -> '$.supply_evidence'), 'null') OR
          coalesce(json(NEW.data_json -> '$.supply_candidates'), 'null') <>
            coalesce(json(OLD.data_json -> '$.supply_candidates'), 'null') OR
          coalesce(json(NEW.data_json -> '$.target_variant'), 'null') <>
            coalesce(json(OLD.data_json -> '$.target_variant'), 'null') OR
          coalesce(json(NEW.data_json -> '$.supply_target_variant_canonical'), 'null') <>
            coalesce(json(OLD.data_json -> '$.supply_target_variant_canonical'), 'null') OR
          coalesce(json_extract(NEW.data_json, '$.purchase_price_original_p70_p80'), '') <>
            coalesce(json_extract(OLD.data_json, '$.purchase_price_original_p70_p80'), '') OR
          coalesce(json_extract(NEW.data_json, '$.purchase_price'), '') <>
            coalesce(json_extract(OLD.data_json, '$.purchase_price'), '') OR
          coalesce(json_extract(NEW.data_json, '$.cost.cost'), '') <>
            coalesce(json_extract(OLD.data_json, '$.cost.cost'), '')
        )
      BEGIN
        SELECT RAISE(ABORT, 'submitted supply evidence is immutable');
      END;

      CREATE TRIGGER events_direct_supply_evidence_insert
      BEFORE INSERT ON events
      FOR EACH ROW
      WHEN NEW.stage IN ('online', 'stock_updated')
        AND NOT (
          ${sqliteLegacyEventInsert("NEW.event_key", "NEW.source", "NEW.occurred_at")} OR
          (
            ${sqliteAtOrAfterSupplyGateCutover("json_extract(NEW.data_json, '$.api_call_started_at')")}
            AND ${sqliteSupplyEvidence("NEW.data_json", "json_extract(NEW.data_json, '$.api_call_started_at')")}
            AND ${sqliteTrustedSupplySubmission("NEW.data_json", "NEW.sku", "NEW.occurred_at")}
          ) OR ${sqliteTrustedHistoricalSubmission("NEW.data_json", "NEW.sku", "NEW.occurred_at")}
        )
      BEGIN
        SELECT RAISE(ABORT, 'direct terminal outcome requires valid SupplyEvidenceV1');
      END;

      CREATE TRIGGER events_direct_supply_evidence_update
      BEFORE UPDATE OF stage, data_json, occurred_at ON events
      FOR EACH ROW
      WHEN NEW.stage IN ('online', 'stock_updated')
        AND NOT (
          ${sqliteLegacyEventInsert("NEW.event_key", "NEW.source", "NEW.occurred_at")} OR
          (
            ${sqliteAtOrAfterSupplyGateCutover("json_extract(NEW.data_json, '$.api_call_started_at')")}
            AND ${sqliteSupplyEvidence("NEW.data_json", "json_extract(NEW.data_json, '$.api_call_started_at')")}
            AND ${sqliteTrustedSupplySubmission("NEW.data_json", "NEW.sku", "NEW.occurred_at")}
          ) OR ${sqliteTrustedHistoricalSubmission("NEW.data_json", "NEW.sku", "NEW.occurred_at")}
        )
      BEGIN
        SELECT RAISE(ABORT, 'direct terminal outcome requires valid SupplyEvidenceV1');
      END;

      CREATE TRIGGER sku_state_direct_supply_evidence_insert
      BEFORE INSERT ON sku_state
      FOR EACH ROW
      WHEN NEW.stage IN ('online', 'stock_updated')
        AND NOT (
          ${sqliteLegacyStateProjection({
            dataExpression: "NEW.data_json",
            skuExpression: "NEW.sku",
            stageExpression: "NEW.stage",
            strictExpression: "NEW.strict",
            updatedAtExpression: "NEW.updated_at",
          })} OR
          (
            ${sqliteAtOrAfterSupplyGateCutover("json_extract(NEW.data_json, '$.api_call_started_at')")}
            AND ${sqliteSupplyEvidence("NEW.data_json", "json_extract(NEW.data_json, '$.api_call_started_at')")}
            AND ${sqliteTrustedSupplySubmission("NEW.data_json", "NEW.sku", "NEW.updated_at")}
          ) OR ${sqliteTrustedHistoricalSubmission("NEW.data_json", "NEW.sku", "NEW.updated_at")}
        )
      BEGIN
        SELECT RAISE(ABORT, 'direct terminal outcome requires valid SupplyEvidenceV1');
      END;

      CREATE TRIGGER sku_state_direct_supply_evidence_update
      BEFORE UPDATE OF stage, data_json, updated_at ON sku_state
      FOR EACH ROW
      WHEN NEW.stage IN ('online', 'stock_updated')
        AND NOT (
          ${sqliteLegacyStateProjection({
            dataExpression: "NEW.data_json",
            skuExpression: "NEW.sku",
            stageExpression: "NEW.stage",
            strictExpression: "NEW.strict",
            updatedAtExpression: "NEW.updated_at",
          })} OR
          (
            ${sqliteAtOrAfterSupplyGateCutover("json_extract(NEW.data_json, '$.api_call_started_at')")}
            AND ${sqliteSupplyEvidence("NEW.data_json", "json_extract(NEW.data_json, '$.api_call_started_at')")}
            AND ${sqliteTrustedSupplySubmission("NEW.data_json", "NEW.sku", "NEW.updated_at")}
          ) OR ${sqliteTrustedHistoricalSubmission("NEW.data_json", "NEW.sku", "NEW.updated_at")}
        )
      BEGIN
        SELECT RAISE(ABORT, 'direct terminal outcome requires valid SupplyEvidenceV1');
      END;

      CREATE TRIGGER events_strict_supply_evidence_insert
      BEFORE INSERT ON events
      FOR EACH ROW
      WHEN NEW.strict = 1
        AND NOT (
          ${sqliteLegacyEventInsert("NEW.event_key", "NEW.source", "NEW.occurred_at")} OR (
            ${sqliteSupplyEvidence("NEW.data_json", "json_extract(NEW.data_json, '$.api_call_started_at')")}
            AND ${sqliteTrustedSupplySubmission("NEW.data_json", "NEW.sku", "NEW.occurred_at")}
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'strict publication requires valid SupplyEvidenceV1');
      END;

      CREATE TRIGGER events_strict_supply_evidence_update
      BEFORE UPDATE OF strict, data_json, occurred_at ON events
      FOR EACH ROW
      WHEN NEW.strict = 1
        AND NOT (
          ${sqliteLegacyEventInsert("NEW.event_key", "NEW.source", "NEW.occurred_at")} OR (
            ${sqliteSupplyEvidence("NEW.data_json", "json_extract(NEW.data_json, '$.api_call_started_at')")}
            AND ${sqliteTrustedSupplySubmission("NEW.data_json", "NEW.sku", "NEW.occurred_at")}
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'strict publication requires valid SupplyEvidenceV1');
      END;

      CREATE TRIGGER sku_state_strict_supply_evidence_insert
      BEFORE INSERT ON sku_state
      FOR EACH ROW
      WHEN NEW.strict = 1
        AND NOT (
          ${sqliteLegacyStateProjection({
            dataExpression: "NEW.data_json",
            skuExpression: "NEW.sku",
            stageExpression: "NEW.stage",
            strictExpression: "NEW.strict",
            updatedAtExpression: "NEW.updated_at",
          })} OR (
            ${sqliteSupplyEvidence("NEW.data_json", "json_extract(NEW.data_json, '$.api_call_started_at')")}
            AND ${sqliteTrustedSupplySubmission("NEW.data_json", "NEW.sku", "NEW.updated_at")}
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'strict publication requires valid SupplyEvidenceV1');
      END;

      CREATE TRIGGER sku_state_strict_supply_evidence_update
      BEFORE UPDATE OF strict, data_json, updated_at ON sku_state
      FOR EACH ROW
      WHEN NEW.strict = 1
        AND NOT (
          ${sqliteLegacyStateProjection({
            dataExpression: "NEW.data_json",
            skuExpression: "NEW.sku",
            stageExpression: "NEW.stage",
            strictExpression: "NEW.strict",
            updatedAtExpression: "NEW.updated_at",
          })} OR (
            ${sqliteSupplyEvidence("NEW.data_json", "json_extract(NEW.data_json, '$.api_call_started_at')")}
            AND ${sqliteTrustedSupplySubmission("NEW.data_json", "NEW.sku", "NEW.updated_at")}
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'strict publication requires valid SupplyEvidenceV1');
      END;

      CREATE TRIGGER strict_publications_supply_evidence_insert
      BEFORE INSERT ON strict_publications
      FOR EACH ROW
      WHEN NOT (
          ${sqliteLegacyStrictPublication({
            dataExpression: "NEW.data_json",
            skuExpression: "NEW.sku",
            eventIdExpression: "NEW.event_id",
            publishedAtExpression: "NEW.published_at",
          })} OR (
            ${sqliteSupplyEvidence("NEW.data_json", "json_extract(NEW.data_json, '$.api_call_started_at')")}
            AND ${sqliteTrustedSupplySubmission("NEW.data_json", "NEW.sku", "NEW.published_at")}
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'strict publication requires valid SupplyEvidenceV1');
      END;

      CREATE TRIGGER strict_publications_supply_evidence_update
      BEFORE UPDATE OF data_json, published_at ON strict_publications
      FOR EACH ROW
      WHEN NOT (
          ${sqliteLegacyStrictPublication({
            dataExpression: "NEW.data_json",
            skuExpression: "NEW.sku",
            eventIdExpression: "NEW.event_id",
            publishedAtExpression: "NEW.published_at",
          })} OR (
            ${sqliteSupplyEvidence("NEW.data_json", "json_extract(NEW.data_json, '$.api_call_started_at')")}
            AND ${sqliteTrustedSupplySubmission("NEW.data_json", "NEW.sku", "NEW.published_at")}
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'strict publication requires valid SupplyEvidenceV1');
      END;

      CREATE TRIGGER IF NOT EXISTS runtime_supply_gate_cutover_update_guard
      BEFORE UPDATE OF value ON metadata
      FOR EACH ROW
      WHEN OLD.key = '${SUPPLY_GATE_CUTOVER_METADATA_KEY}' AND NEW.value <> OLD.value
      BEGIN
        SELECT RAISE(ABORT, 'supply gate cutover is immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS runtime_supply_gate_cutover_delete_guard
      BEFORE DELETE ON metadata
      FOR EACH ROW
      WHEN OLD.key = '${SUPPLY_GATE_CUTOVER_METADATA_KEY}'
      BEGIN
        SELECT RAISE(ABORT, 'supply gate cutover is immutable');
      END;
    `);

    const versionRow = database
      .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get();
    if (!versionRow) {
      database
        .prepare("INSERT INTO metadata (key, value) VALUES ('schema_version', ?)")
        .run(String(RUNTIME_STATE_SCHEMA_VERSION));
    } else if ([1, 2, 3].includes(Number(versionRow.value))) {
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
  const selectAcceptedReservationProjectionsForRun = database.prepare(`
    SELECT
      sku,
      CAST(json_extract(data_json, '$.store_id') AS INTEGER) AS store_id,
      (${ACCEPTED_AUDIT_TIMESTAMP_SQL}) AS accepted_at,
      json_extract(data_json, '$.offer_id') AS offer_id,
      json_extract(data_json, '$.at') AS at
    FROM submission_reservations INDEXED BY ${ACCEPTED_AUDIT_RESERVATION_INDEX}
    WHERE ${ACCEPTED_AUDIT_PREDICATE_SQL}
      AND ${ACCEPTED_AUDIT_RUN_DIR_SQL} = ?
    ORDER BY (${ACCEPTED_AUDIT_TIMESTAMP_SQL}), sku
  `);
  const selectSubmittedReservationsForRun = database.prepare(`
    SELECT *
    FROM submission_reservations INDEXED BY ${ACCEPTED_AUDIT_RESERVATION_INDEX}
    WHERE ${ACCEPTED_AUDIT_PREDICATE_SQL}
      AND ${ACCEPTED_AUDIT_RUN_DIR_SQL} = ?
    ORDER BY (${ACCEPTED_AUDIT_TIMESTAMP_SQL}), sku
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
  const recoverExpiredReservationSubmitted = database.prepare(`
    UPDATE submission_reservations
    SET owner_id = ?, generation_id = ?, status = 'submitted',
        lease_expires_at = NULL, data_json = ?, updated_at = ?
    WHERE sku = ?
      AND status = 'reserved'
      AND lease_expires_at <= ?
  `);
  const closeReservation = database.prepare(`
    UPDATE submission_reservations
    SET status = 'closed', lease_expires_at = NULL, updated_at = ?
    WHERE sku = ? AND status <> 'closed'
  `);
  const abandonOwnedPreCallReservation = database.prepare(`
    UPDATE submission_reservations
    SET status = 'closed', title_key = NULL, lease_expires_at = NULL,
        data_json = ?, updated_at = ?
    WHERE sku = ?
      AND owner_id = ?
      AND generation_id = ?
      AND status = 'reserved'
      AND (? = 1 OR lease_expires_at <= ?)
      AND coalesce(
        trim(CAST(json_extract(data_json, '$.api_call_started_at') AS TEXT)),
        ''
      ) = ''
      AND NOT EXISTS (
        SELECT 1
        FROM sku_state AS current_state
        WHERE current_state.sku = ?
          AND coalesce(
            trim(CAST(json_extract(current_state.data_json, '$.api_call_started_at') AS TEXT)),
            ''
          ) <> ''
      )
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
    if (TERMINAL_OUTCOME_STAGES.has(spec.stage)) {
      clearPreCallAbandonMarkers(spec.data);
      installCanonicalSupplyBinding(spec.data);
    }
    const directApiCallStartedAt = tolerantTimestamp(spec.data?.api_call_started_at);
    const directOutcomeAtSupplyGate = (
      TERMINAL_OUTCOME_STAGES.has(spec.stage)
      && Date.parse(occurredAt) >= Date.parse(supplyGateCutoverAt)
    );
    const directHistoricalSubmission = Boolean(
      directOutcomeAtSupplyGate
      && directApiCallStartedAt
      && Date.parse(directApiCallStartedAt) < Date.parse(supplyGateCutoverAt),
    );
    const directSupplyRequired = directOutcomeAtSupplyGate && !directHistoricalSubmission;
    if (directSupplyRequired) {
      const supplyInvariantError = supplyEvidenceV1InvariantError(
        spec.data,
        spec.data?.api_call_started_at,
      );
      if (supplyInvariantError) throw new TypeError(supplyInvariantError);
    }

    return transaction(() => {
      const existing = getState(sku);
      if (existing?.terminal) {
        return { recorded: false, reason: "terminal-state", state: existing };
      }
      if (directOutcomeAtSupplyGate) {
        const reservation = getReservation(sku);
        const supplySubmissionError = directHistoricalSubmission
          ? trustedHistoricalSubmissionInvariantError(
            spec.data,
            reservation,
            supplyGateCutoverAt,
            occurredAt,
          )
          : trustedSupplySubmissionInvariantError(
            spec.data,
            reservation,
            occurredAt,
          );
        if (supplySubmissionError) throw new TypeError(supplySubmissionError);
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
      let freshPipelineReentry = false;
      if (
        reservation?.status === "closed"
        && reservation.ownerId === normalizedOwnerId
        && reservation.generationId === normalizedGenerationId
        && reservation.data?.pre_call_intent_abandoned === true
      ) {
        const resetAt = tolerantTimestamp(reservation.data?.pre_call_intent_reset_at);
        const preparations = freshPipelinePreparations(requestedData);
        const invalidPreparation = preparations.find((preparation) => (
          !preparation.at
          || !resetAt
          || Date.parse(preparation.at) <= Date.parse(resetAt)
        ));
        if (
          !resetAt
          || preparations.length === 0
          || invalidPreparation
        ) {
          return {
            recorded: false,
            reason: "submission-generation-abandoned",
            requiredPreparedAfter: resetAt,
            observedPreparedAt: invalidPreparation?.at ?? null,
            preparationTimestampSource: invalidPreparation?.source ?? null,
            preparationTimestamps: preparations,
            reservation,
            state: existing,
          };
        }
        freshPipelineReentry = true;
      }
      const sameGeneration = (
        reservation?.status === "reserved" &&
        reservation.ownerId === normalizedOwnerId &&
        reservation.generationId === normalizedGenerationId
      );
      const regressedPreparation = sameGeneration
        ? preparationRegression(reservation.data, requestedData)
        : null;
      if (regressedPreparation) {
        return {
          recorded: false,
          reason: "submission-preparation-regressed",
          preparationTimestampSource: regressedPreparation.source,
          observedPreparedAt: regressedPreparation.at,
          requiredPreparedAtOrAfter: regressedPreparation.previousAt,
          reservation,
          state: existing,
        };
      }
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
      clearPreCallAbandonMarkers(mergedData);
      installCanonicalSupplyBinding(mergedData);
      const supplyInvariantError = submissionSupplyInvariantError(
        mergedData,
        supplyGateCutoverAt,
        occurredAt,
        {
          allowPreCutover: Boolean(
            tolerantTimestamp(reservation?.data?.api_call_started_at)
            && tolerantTimestamp(reservation?.data?.api_call_started_at) ===
              tolerantTimestamp(mergedData?.api_call_started_at)
            && Date.parse(tolerantTimestamp(reservation?.data?.api_call_started_at)) <
              Date.parse(supplyGateCutoverAt)
          ),
        },
      );
      if (supplyInvariantError) throw new TypeError(supplyInvariantError);
      if (reservation && protectedSubmissionSupplyChanged(
        reservation.data,
        mergedData,
        supplyGateCutoverAt,
      )) {
        throw new TypeError("submitted supply evidence and api_call_started_at are immutable");
      }
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
        freshPipelineReentry,
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
      const sameGeneration = (
        reservation?.status === "reserved"
        && reservation.ownerId === normalizedOwnerId
        && reservation.generationId === normalizedGenerationId
      );
      const expiredTakeover = (
        options.allowExpiredTakeover === true
        && reservation?.status === "reserved"
        && !sameGeneration
        && Date.parse(reservation.leaseExpiresAt) <= Date.parse(occurredAt)
      );
      if (!sameGeneration && !expiredTakeover) {
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
        ...(expiredTakeover ? {
          cross_generation_takeover: true,
          previous_submission_owner_id: reservation.ownerId,
          previous_submission_generation_id: reservation.generationId,
        } : {}),
      };
      delete mergedData.submission_lease_expires_at;
      clearPreCallAbandonMarkers(mergedData);
      installCanonicalSupplyBinding(mergedData);
      const supplyInvariantError = submissionSupplyInvariantError(
        mergedData,
        supplyGateCutoverAt,
        occurredAt,
        {
          allowPreCutover: Boolean(
            tolerantTimestamp(reservation.data?.api_call_started_at)
            && tolerantTimestamp(reservation.data?.api_call_started_at) ===
              tolerantTimestamp(mergedData?.api_call_started_at)
            && Date.parse(tolerantTimestamp(reservation.data?.api_call_started_at)) <
              Date.parse(supplyGateCutoverAt)
          ),
        },
      );
      if (supplyInvariantError) throw new TypeError(supplyInvariantError);
      if (protectedSubmissionSupplyChanged(
        reservation.data,
        mergedData,
        supplyGateCutoverAt,
      )) {
        throw new TypeError("submitted supply evidence and api_call_started_at are immutable");
      }
      const changed = expiredTakeover
        ? recoverExpiredReservationSubmitted.run(
          normalizedOwnerId,
          normalizedGenerationId,
          stringifyData(mergedData),
          occurredAt,
          sku,
          occurredAt,
        )
        : markReservationSubmitted.run(
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
        takeover: expiredTakeover,
        reservation: getReservation(sku),
        state: getState(sku),
      };
    });
  }

  function abandonPreCallSubmissionIntent(rawSku, options = {}) {
    const sku = normalizeSku(rawSku);
    const reason = requireReason(options.reason);
    const nextEligibleAt = timestamp(options.nextEligibleAt, "nextEligibleAt");
    const expectedOwnerId = String(options.expectedOwnerId ?? "").trim();
    const expectedGenerationId = String(options.expectedGenerationId ?? "").trim();
    if (!expectedOwnerId) throw new TypeError("expectedOwnerId is required");
    if (!expectedGenerationId) throw new TypeError("expectedGenerationId is required");
    const requestedData = asData(options.data);
    const occurredAt = currentTimestamp();
    const sameCallerGeneration = (
      expectedOwnerId === normalizedOwnerId
      && expectedGenerationId === normalizedGenerationId
    );

    return transaction(() => {
      const existing = getState(sku);
      if (existing?.terminal) {
        return { recorded: false, reason: "terminal-state", state: existing };
      }
      const reservation = getReservation(sku);
      if (!reservation) {
        return {
          recorded: false,
          reason: "submission-reservation-missing",
          reservation: null,
          state: existing,
        };
      }
      if (reservation.status !== "reserved") {
        return {
          recorded: false,
          reason: reservation.status === "submitted"
            ? "submission-already-submitted"
            : "submission-reservation-not-active",
          reservation,
          state: existing,
        };
      }
      if (
        reservation.ownerId !== expectedOwnerId
        || reservation.generationId !== expectedGenerationId
      ) {
        return {
          recorded: false,
          reason: "submission-reserved-by-another-generation",
          reservation,
          state: existing,
        };
      }
      if (
        !sameCallerGeneration
        && Date.parse(reservation.leaseExpiresAt) > Date.parse(occurredAt)
      ) {
        return {
          recorded: false,
          reason: "submission-reservation-lease-active",
          reservation,
          state: existing,
        };
      }
      if (
        String(reservation.data?.api_call_started_at ?? "").trim()
        || String(existing?.data?.api_call_started_at ?? "").trim()
      ) {
        return {
          recorded: false,
          reason: "submission-api-call-already-started",
          reservation,
          state: existing,
        };
      }

      const resetData = {
        ...(existing?.data || {}),
        ...(reservation.data || {}),
        ...requestedData,
        reason,
        submission_intent: false,
        submitted: false,
        submission_pending: false,
        reconcile_only: false,
        next_reconcile_at: null,
        submission_payload: null,
        profit_recheck_context: null,
        supply_gate_passed: false,
        supply_evidence: null,
        supply_candidates: [],
        target_variant: null,
        supply_target_variant_canonical: null,
        retry_at: nextEligibleAt,
        terminal: false,
        failure_class: "transient",
        pre_call_intent_reset_at: occurredAt,
        fresh_pipeline_required: true,
        pre_call_intent_abandoned: true,
        pre_call_intent_abandoned_owner_id: expectedOwnerId,
        pre_call_intent_abandoned_generation_id: expectedGenerationId,
      };
      delete resetData.api_call_started_at;
      delete resetData.previous_api_call_started_at;
      delete resetData.api_call_completed_at;
      delete resetData.submission_owner_id;
      delete resetData.submission_generation_id;
      delete resetData.submission_lease_expires_at;
      delete resetData.same_generation_reentry;
      delete resetData.cross_generation_takeover;
      delete resetData.previous_submission_owner_id;
      delete resetData.previous_submission_generation_id;

      const changed = abandonOwnedPreCallReservation.run(
        stringifyData(resetData),
        occurredAt,
        sku,
        expectedOwnerId,
        expectedGenerationId,
        sameCallerGeneration ? 1 : 0,
        occurredAt,
        sku,
      );
      if (Number(changed.changes) !== 1) {
        const currentReservation = getReservation(sku);
        const currentState = getState(sku);
        const markerPersisted = Boolean(
          String(currentReservation?.data?.api_call_started_at ?? "").trim()
          || String(currentState?.data?.api_call_started_at ?? "").trim(),
        );
        return {
          recorded: false,
          reason: markerPersisted
            ? "submission-api-call-already-started"
            : (
              !sameCallerGeneration
              && currentReservation?.status === "reserved"
              && Date.parse(currentReservation.leaseExpiresAt) > Date.parse(occurredAt)
                ? "submission-reservation-lease-active"
                : "submission-reservation-cas-conflict"
            ),
          reservation: currentReservation,
          state: currentState,
        };
      }

      const spec = {
        sku,
        stage: "failed",
        reason,
        failureClass: "transient",
        terminal: false,
        strict: false,
        nextEligibleAt,
        data: resetData,
        occurredAt,
        source: "runtime",
      };
      const eventId = addEvent(spec);
      writeState(spec);
      return {
        recorded: true,
        eventId,
        attempts: Number(selectAttempt.get(sku, shanghaiDay(occurredAt))?.attempts ?? 0),
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

  function recordTerminalOutcome(sku, options = {}) {
    const stage = String(options.stage || options.data?.outcome_status || "").trim();
    if (!TERMINAL_OUTCOME_STAGES.has(stage)) {
      throw new TypeError("terminal outcome stage must be online or stock_updated");
    }
    return recordTransition(sku, options, {
      stage,
      terminal: true,
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
    clearPreCallAbandonMarkers(data);
    installCanonicalSupplyBinding(data);
    const titleKey = canonicalTitleKey(data);
    if (titleKey) data.title_key = titleKey;
    const occurredAt = currentTimestamp();
    const invariantError = strictInvariantError(data)
      || supplyEvidenceV1InvariantError(data, data?.api_call_started_at);
    if (invariantError) throw new TypeError(invariantError);
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
      const supplySubmissionError = trustedSupplySubmissionInvariantError(
        data,
        getReservation(sku),
        occurredAt,
      );
      if (supplySubmissionError) throw new TypeError(supplySubmissionError);
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

  function acceptedReservationProjections(runDir) {
    assertOpen();
    const normalizedRunDir = normalizedDirectRunDir(runDir);
    if (!normalizedRunDir) return [];
    return selectAcceptedReservationProjectionsForRun.all(normalizedRunDir);
  }

  // Compatibility access for callers that need the complete durable
  // reservation. Startup audit repair uses the compact projection above so it
  // never hydrates every accepted reservation's large data_json into Node.
  function submittedReservations(runDir) {
    assertOpen();
    const normalizedRunDir = normalizedDirectRunDir(runDir);
    if (!normalizedRunDir) return [];
    return selectSubmittedReservationsForRun.all(normalizedRunDir).map(rowToReservation);
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
    abandonPreCallSubmissionIntent,
    recordProcessing,
    recordTerminalOutcome,
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
    acceptedReservationProjections,
    submittedReservations,
    directTargetUsage,
    directAcceptedCount,
    auditEvents,
    importLegacy,
    exportAuditJsonl,
    close,
  };
}
