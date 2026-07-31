import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  evaluateThirtyMinuteGate,
  evaluateThreeSkuGate,
  evaluateTwentyFourHourGate,
  evaluateTwoHourGate,
} from "./acceptance-replay.mjs";
import { hasReliableSameItemCostEvidence } from "./cost-evidence.mjs";

const EXPECTED_IDENTITY_FIELDS = Object.freeze([
  "run_id",
  "commit_sha",
  "config_sha256",
  "source_set_sha256",
  "state_schema_version",
]);

function timestamp(value, label = "timestamp") {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a valid timestamp`);
  return parsed;
}

function iso(value, label) {
  return new Date(timestamp(value, label)).toISOString();
}

function normalizedSku(value) {
  return String(value ?? "").trim();
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...value };
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sortedUniqueSkus(values) {
  return [...new Set((values || []).map(normalizedSku).filter(Boolean))].sort();
}

function gateWindow(startedAt, offsetStartMinutes, offsetEndMinutes) {
  const startMs = timestamp(startedAt, "startedAt");
  return {
    started_at: new Date(startMs + offsetStartMinutes * 60_000).toISOString(),
    ended_at: new Date(startMs + offsetEndMinutes * 60_000).toISOString(),
    status: "pending",
    evaluated_at: null,
    result: null,
  };
}

export function buildStagedGateState({
  runId,
  runDir,
  startedAt,
  endedAt,
  targetSkus,
  identity = {},
  operatorDirectPublish = null,
} = {}) {
  const normalizedRunId = String(runId || "").trim();
  const normalizedRunDir = path.resolve(String(runDir || ""));
  if (!normalizedRunId) throw new TypeError("runId is required");
  if (!String(runDir || "").trim()) throw new TypeError("runDir is required");
  const start = iso(startedAt, "startedAt");
  const end = iso(endedAt, "endedAt");
  if (timestamp(end) - timestamp(start) < 24 * 60 * 60_000) {
    throw new TypeError("formal acceptance window must cover at least 24 hours");
  }
  const directPublish = operatorDirectPublish !== null && operatorDirectPublish !== undefined;
  const frozenTargets = sortedUniqueSkus(targetSkus);
  if (directPublish) {
    if (frozenTargets.length !== 0) {
      throw new TypeError("operator-direct gate must not freeze target SKUs");
    }
    if (
      !String(operatorDirectPublish?.authorized_by || "").trim()
      || !String(operatorDirectPublish?.reason || "").trim()
    ) {
      throw new TypeError("operator-direct gate requires audited authorization");
    }
    iso(operatorDirectPublish.authorized_at, "operatorDirectPublish.authorized_at");
  } else {
    frozenTargets.splice(3);
    if (frozenTargets.length !== 3) {
      throw new TypeError("three-SKU gate requires exactly three unique target SKUs");
    }
  }
  const directGateResult = directPublish ? {
    passed: true,
    skipped: true,
    reason: "operator-direct-publish-zero-buffer-authorized",
    audit: {
      authorized_by: String(operatorDirectPublish.authorized_by).trim(),
      authorized_at: iso(operatorDirectPublish.authorized_at, "operatorDirectPublish.authorized_at"),
      authorization_reason: String(operatorDirectPublish.reason).trim(),
    },
  } : null;
  return {
    schema_version: 1,
    run_id: normalizedRunId,
    run_dir: normalizedRunDir,
    formal_started_at: start,
    formal_ended_at: end,
    identity: {
      run_id: normalizedRunId,
      commit_sha: String(identity.commit_sha || ""),
      config_sha256: String(identity.config_sha256 || ""),
      source_set_sha256: String(identity.source_set_sha256 || ""),
      state_schema_version: Number(identity.state_schema_version || 0),
    },
    submission_gate: {
      phase: directPublish ? "released" : "three-sku",
      target_skus: frozenTargets,
    },
    gates: {
      three_sku: {
        started_at: start,
        ended_at: directPublish ? start : null,
        status: directPublish ? "passed" : "pending",
        evaluated_at: directPublish ? start : null,
        result: directGateResult,
      },
      thirty_minute: gateWindow(start, 0, 30),
      two_hour_a: gateWindow(start, 0, 120),
      two_hour_b: gateWindow(start, 120, 240),
      twenty_four_hour: {
        started_at: start,
        ended_at: end,
        status: "pending",
        evaluated_at: null,
        result: null,
      },
    },
  };
}

export function submissionGatePolicy(value = {}) {
  const gate = value?.submission_gate && typeof value.submission_gate === "object"
    ? value.submission_gate
    : value;
  const phase = String(gate?.phase || "").trim();
  const targetSkus = sortedUniqueSkus(gate?.target_skus);
  if (phase === "released") return { phase, allowed_skus: null };
  if (phase === "three-sku" || phase === "active") {
    if (targetSkus.length !== 3) {
      throw new Error("active submission gate must freeze exactly three unique SKUs");
    }
    return { phase: "three-sku", allowed_skus: new Set(targetSkus) };
  }
  if (phase === "failed") throw new Error("submission gate is closed after a failed acceptance gate");
  throw new Error("submission gate is missing or invalid");
}

function runtimeEventData(row) {
  return parseObject(row?.data ?? row?.data_json);
}

function runtimeEventTime(row) {
  return String(row?.occurredAt ?? row?.occurred_at ?? row?.timestamp ?? row?.at ?? "");
}

function strictPublicationTime(row) {
  return String(row?.publishedAt ?? row?.published_at ?? row?.timestamp ?? row?.at ?? "");
}

function qualityStrictEvent(row) {
  const data = runtimeEventData(row);
  const checks = parseObject(data.quality_checks);
  const reliableCost = hasReliableSameItemCostEvidence(data)
    && Number(data.purchase_price) > 0;
  return {
    type: "strict-confirmed",
    at: strictPublicationTime(row),
    submitted_at: data.api_call_started_at || data.submitted_at || data.selected_at || null,
    sku: normalizedSku(row?.sku ?? data.sku),
    store_id: Number(data.store_id),
    strict_confirmed: true,
    online_status: String(data.online_status || ""),
    stock: Number(data.stock),
    profit_rate: Number(data.profit_rate),
    shipping_mode: String(data.shipping_mode || data.mode || ""),
    same_item_1688: reliableCost,
    cost_reliable: reliableCost,
    duplicate_precheck: checks.historical_and_cross_store_duplicate === true,
    forbidden_category: checks.prohibited_category === true ? false : null,
    title_valid: checks.title === true,
    image_valid: checks.image === true,
    category_valid: checks.category === true,
  };
}

function transitionStatus(row, data) {
  const stage = String(row?.stage || row?.status || "").trim();
  const reason = String(row?.reason || data.reason || "").trim();
  if (["submission-accepted", "erp-submission-accepted"].includes(reason)) return "submitted";
  if (["published", "failed", "skipped", "delayed"].includes(stage)) return stage;
  return "processing";
}

function scopedRows(rows, runDir) {
  const normalizedRunDir = path.resolve(runDir);
  return (rows || []).filter((row) => {
    const data = runtimeEventData(row);
    const rowRunDir = String(data.runtime_run_dir || "").trim();
    return rowRunDir && path.resolve(rowRunDir) === normalizedRunDir;
  });
}

function recoveryEvents(rows, runDir) {
  const normalizedRunDir = path.resolve(runDir);
  const attempts = (rows || []).filter((row) => (
    path.resolve(String(row?.run_dir || "")) === normalizedRunDir
    && String(row?.action || "") === "browser-recovery-attempt"
  ));
  const result = [];
  let pendingFailure = null;
  for (const row of attempts) {
    const outcome = String(row?.outcome || "");
    if (outcome === "started" || outcome === "failed") {
      pendingFailure = row;
      continue;
    }
    if (outcome === "succeeded") {
      result.push({
        type: "browser-recovery",
        at: row.at,
        outcome: "recovered",
        state_lost: row.state_lost === true,
      });
      pendingFailure = null;
    }
  }
  if (pendingFailure) {
    result.push({
      type: "browser-recovery",
      at: pendingFailure.at,
      outcome: "failed",
      state_lost: pendingFailure.state_lost === true,
    });
  }
  return result;
}

function storeSyncEvents(rows) {
  const result = [];
  for (const row of rows || []) {
    const at = String(row?.at || "");
    const storeId = Number(row?.store_id);
    result.push({ type: "erp-sync-attempt", at, store_id: storeId });
    if (
      row?.ok === false
      && (
        Number(row?.retry_after_ms) > 0
        || String(row?.blocked_until || "").trim()
        || /频繁|rate.?limit|too many requests|429/iu.test(String(row?.error || ""))
      )
    ) {
      result.push({
        type: "erp-rate-limit",
        at,
        store_id: storeId,
        retry_after_ms: Math.max(0, Number(row?.retry_after_ms) || 0),
        blocked_until: row?.blocked_until || null,
      });
    }
  }
  return result;
}

function stateLossEvents(evidenceRows) {
  const result = [];
  let previous = null;
  for (const row of (evidenceRows || [])
    .filter((event) => event?.type === "process-snapshot")
    .sort((left, right) => timestamp(left.at) - timestamp(right.at))) {
    const current = {
      eventCount: Number(row.state_event_count),
      maxEventId: Number(row.state_max_event_id),
      strictCount: Number(row.state_strict_count),
    };
    if (
      previous
      && [current.eventCount, current.maxEventId, current.strictCount].every(Number.isFinite)
      && (
        current.eventCount < previous.eventCount
        || current.maxEventId < previous.maxEventId
        || current.strictCount < previous.strictCount
      )
    ) {
      result.push({
        type: "state-loss",
        at: row.at,
        previous,
        current,
      });
    }
    if ([current.eventCount, current.maxEventId, current.strictCount].every(Number.isFinite)) {
      previous = current;
    }
  }
  return result;
}

function securityBypassEvents(runtimeEvents, operationalRows, runDir) {
  const normalizedRunDir = path.resolve(runDir);
  const statuses = (operationalRows || [])
    .filter((row) => (
      String(row?.run_dir || "").trim()
      && path.resolve(String(row.run_dir)) === normalizedRunDir
    ))
    .map((row) => ({ ...row, atMs: Date.parse(String(row?.observed_at || row?.at || "")) }))
    .filter((row) => Number.isFinite(row.atMs))
    .sort((left, right) => left.atMs - right.atMs);
  const waitingIntervals = [];
  let waitingAt = null;
  for (const row of statuses) {
    if (row.status === "WAITING_FOR_VERIFICATION") {
      waitingAt ??= row.atMs;
    } else if (waitingAt !== null && row.atMs >= waitingAt) {
      waitingIntervals.push([waitingAt, row.atMs]);
      waitingAt = null;
    }
  }
  if (waitingAt !== null) waitingIntervals.push([waitingAt, Number.POSITIVE_INFINITY]);
  return (runtimeEvents || []).flatMap((row) => {
    if (!["submission-accepted", "erp-submission-accepted"].includes(String(row?.reason || ""))) return [];
    const at = Date.parse(runtimeEventTime(row));
    if (!waitingIntervals.some(([start, end]) => at >= start && at < end)) return [];
    return [{
      type: "security-bypass",
      at: runtimeEventTime(row),
      sku: normalizedSku(row?.sku),
    }];
  });
}

export function runtimeEvidenceToAcceptanceEvents({
  runDir,
  runtimeEvents = [],
  strictPublications = [],
  evidenceEvents = [],
  recoveryRows = [],
  storeSyncRows = [],
  operationalRows = [],
} = {}) {
  if (!String(runDir || "").trim()) throw new TypeError("runDir is required");
  const scopedRuntime = scopedRows(runtimeEvents, runDir);
  const transitions = scopedRuntime.map((row) => {
    const data = runtimeEventData(row);
    return {
      type: "sku-transition",
      at: runtimeEventTime(row),
      sku: normalizedSku(row?.sku ?? data.sku),
      status: transitionStatus(row, data),
      reason: String(row?.reason || data.reason || "").trim(),
      failure_class: row?.failureClass ?? row?.failure_class ?? data.failure_class ?? null,
      terminal: Boolean(row?.terminal),
    };
  });
  const attempts = scopedRuntime
    .filter((row) => String(row?.reason || "") === "processing-started")
    .map((row) => ({
      type: "sku-attempt",
      at: runtimeEventTime(row),
      sku: normalizedSku(row?.sku),
    }));
  const strict = scopedRows(strictPublications, runDir).map(qualityStrictEvent);
  const evidence = (evidenceEvents || []).filter((event) => event && typeof event === "object");
  return [
    ...transitions,
    ...attempts,
    ...strict,
    ...evidence,
    ...recoveryEvents(recoveryRows, runDir),
    ...storeSyncEvents(storeSyncRows),
    ...stateLossEvents(evidence),
    ...securityBypassEvents(scopedRuntime, operationalRows, runDir),
  ].filter((event) => Number.isFinite(Date.parse(String(event?.at || ""))))
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

function appendChecks(result, checks, details = {}) {
  const mergedChecks = { ...result.checks, ...checks };
  const failedChecks = Object.entries(mergedChecks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);
  return {
    ...result,
    ...details,
    passed: failedChecks.length === 0,
    checks: mergedChecks,
    failed_checks: failedChecks,
  };
}

function processEvidenceChecks(events, {
  startedAt,
  endedAt,
  expectedIdentity,
  minimumSamples,
  maximumGapMinutes = 5.5,
  requireStateEvidence = false,
} = {}) {
  const startMs = timestamp(startedAt, "startedAt");
  const endMs = timestamp(endedAt, "endedAt");
  const allSnapshots = (events || [])
    .filter((event) => event?.type === "process-snapshot")
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const samples = allSnapshots.filter((event) => (
    Date.parse(String(event.at || "")) >= startMs
    && Date.parse(String(event.at || "")) <= endMs
  ));
  const points = [startMs, ...samples.map((row) => Date.parse(row.at)), endMs];
  let maximumGapMs = Number.POSITIVE_INFINITY;
  if (samples.length > 0) {
    maximumGapMs = 0;
    for (let index = 1; index < points.length; index += 1) {
      maximumGapMs = Math.max(maximumGapMs, points[index] - points[index - 1]);
    }
  }
  const identityConsistent = samples.length > 0 && samples.every((sample) => (
    EXPECTED_IDENTITY_FIELDS.every((field) => (
      String(sample?.[field] ?? "") === String(expectedIdentity?.[field] ?? "")
    ))
  ));
  const stateSamples = samples.filter((sample) => (
    Number.isFinite(Number(sample.state_event_count))
    && Number.isFinite(Number(sample.state_max_event_id))
    && Number.isFinite(Number(sample.state_strict_count))
    && String(sample.state_integrity || "") === "ok"
  ));
  let previousHash = null;
  const snapshotChainValid = allSnapshots.every((sample, index) => {
    if (!String(sample.snapshot_hash || "").trim()) return false;
    if (index > 0 && String(sample.previous_snapshot_hash || "") !== String(previousHash || "")) {
      return false;
    }
    if (index === 0 && sample.previous_snapshot_hash !== null && sample.previous_snapshot_hash !== undefined) {
      return false;
    }
    const valid = evidenceSnapshotHash(sample) === sample.snapshot_hash;
    previousHash = sample.snapshot_hash;
    return valid;
  });
  return {
    checks: {
      process_evidence_continuous: samples.length >= minimumSamples
        && maximumGapMs <= maximumGapMinutes * 60_000,
      production_identity_consistent: identityConsistent,
      source_set_epoch_authorized: !requireStateEvidence || (
        samples.length > 0
        && samples.every((sample) => (
          sample.source_set_epoch_authorized === true
          && /^[a-f0-9]{64}$/u.test(String(sample.active_source_set_sha256 || ""))
        ))
      ),
      sqlite_state_evidence_complete: !requireStateEvidence || stateSamples.length === samples.length,
      evidence_hash_chain_valid: !requireStateEvidence || snapshotChainValid,
    },
    details: {
      process_evidence_samples: samples.length,
      maximum_process_sample_gap_minutes: Number.isFinite(maximumGapMs)
        ? Math.round((maximumGapMs / 60_000) * 1_000) / 1_000
        : null,
      sqlite_state_evidence_samples: stateSamples.length,
    },
  };
}

export function evaluateLiveStagedGate({
  gate,
  events,
  startedAt,
  endedAt,
  targetSkus = [],
  expectedIdentity = {},
  minimumCandidateBuffer = 70,
  requireStateEvidence = false,
} = {}) {
  let base;
  let minimumSamples;
  if (gate === "three-sku") {
    base = evaluateThreeSkuGate({ events, targetSkus });
    const rows = (events || []).filter((event) => event?.type === "process-snapshot");
    const first = rows[0]?.at || startedAt;
    const last = rows.at(-1)?.at || endedAt || first;
    const evidence = processEvidenceChecks(events, {
      startedAt: first,
      endedAt: last,
      expectedIdentity,
      minimumSamples: 2,
      maximumGapMinutes: 5.5,
      requireStateEvidence,
    });
    return appendChecks(base, evidence.checks, evidence.details);
  }
  if (gate === "30-minute") {
    base = evaluateThirtyMinuteGate({
      events,
      startedAt,
      endedAt,
      minimumCandidateBuffer,
    });
    minimumSamples = 7;
  } else if (gate === "two-hour") {
    base = evaluateTwoHourGate({ events, startedAt, endedAt });
    minimumSamples = 25;
  } else if (gate === "24-hour") {
    base = evaluateTwentyFourHourGate({ events, startedAt, endedAt });
    minimumSamples = 289;
  } else {
    throw new TypeError(`unsupported live acceptance gate: ${gate}`);
  }
  const evidence = processEvidenceChecks(events, {
    startedAt,
    endedAt,
    expectedIdentity,
    minimumSamples,
    maximumGapMinutes: 5.5,
    requireStateEvidence,
  });
  return appendChecks(base, evidence.checks, evidence.details);
}

async function readJsonLines(filename) {
  try {
    return (await fs.readFile(filename, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function readRuntimeDatabase(dbPath, runDir) {
  const database = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
    const integrity = String(database.prepare("PRAGMA quick_check").get()?.quick_check || "");
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
    const rows = database.prepare(`
      SELECT id, sku, stage, reason, failure_class, terminal, strict,
             data_json, occurred_at
      FROM events
      ORDER BY id
    `).all().map((row) => ({
      id: Number(row.id),
      sku: row.sku,
      stage: row.stage,
      reason: row.reason,
      failureClass: row.failure_class,
      terminal: Boolean(row.terminal),
      strict: Boolean(row.strict),
      data: parseObject(row.data_json),
      occurredAt: row.occurred_at,
    }));
    const publications = database.prepare(`
      SELECT sku, event_id, published_at, data_json
      FROM strict_publications
      ORDER BY event_id
    `).all().map((row) => ({
      sku: row.sku,
      eventId: Number(row.event_id),
      publishedAt: row.published_at,
      data: parseObject(row.data_json),
    }));
    const gateRow = database.prepare(`
      SELECT run_id, run_dir, phase, distinct_sku_budget, started_at, released_at, result_json
      FROM submission_gates
      WHERE run_dir = ?
    `).get(path.resolve(runDir));
    const submissionGate = gateRow ? {
      run_id: String(gateRow.run_id),
      run_dir: String(gateRow.run_dir),
      phase: String(gateRow.phase),
      distinct_sku_budget: Number(gateRow.distinct_sku_budget),
      started_at: String(gateRow.started_at),
      released_at: gateRow.released_at === null ? null : String(gateRow.released_at),
      result: parseObject(gateRow.result_json),
      target_skus: database.prepare(`
        SELECT sku
        FROM submission_gate_skus
        WHERE run_id = ?
        ORDER BY ordinal
      `).all(String(gateRow.run_id)).map((row) => String(row.sku)),
    } : null;
    return {
      runtimeEvents: rows,
      strictPublications: publications,
      state: {
        integrity: integrity === "ok" && foreignKeyViolations.length === 0 ? "ok" : "failed",
        quick_check: integrity,
        foreign_key_violations: foreignKeyViolations.length,
        event_count: rows.length,
        max_event_id: rows.at(-1)?.id || 0,
        strict_count: publications.length,
        submission_gate: submissionGate,
      },
    };
  } finally {
    database.close();
  }
}

export async function loadLiveAcceptanceEvidence({
  runDir,
  stateRoot,
  runtimeDbPath,
} = {}) {
  const resolvedRunDir = path.resolve(runDir);
  const resolvedStateRoot = path.resolve(stateRoot);
  const database = readRuntimeDatabase(runtimeDbPath, resolvedRunDir);
  const [
    evidenceEvents,
    recoveryRows,
    storeSyncRows,
    operationalRows,
  ] = await Promise.all([
    readJsonLines(path.join(resolvedRunDir, "live_gate_evidence.jsonl")),
    readJsonLines(path.join(resolvedStateRoot, "recovery.jsonl")),
    readJsonLines(path.join(resolvedRunDir, "store_syncs.jsonl")),
    readJsonLines(path.join(resolvedStateRoot, "operational_history.jsonl")),
  ]);
  return {
    events: runtimeEvidenceToAcceptanceEvents({
      runDir: resolvedRunDir,
      runtimeEvents: database.runtimeEvents,
      strictPublications: database.strictPublications,
      evidenceEvents,
      recoveryRows,
      storeSyncRows,
      operationalRows,
    }),
    runtimeEvents: scopedRows(database.runtimeEvents, resolvedRunDir),
    strictPublications: scopedRows(database.strictPublications, resolvedRunDir),
    state: database.state,
  };
}

export function acceptedTerminalFailures(runtimeEvents = []) {
  const latest = new Map();
  for (const row of runtimeEvents || []) latest.set(normalizedSku(row?.sku), row);
  return [...latest.values()].filter((row) => {
    const data = runtimeEventData(row);
    return row?.terminal === true
      && data.submitted === true
      && String(row?.stage || "") !== "published";
  }).map((row) => ({
    sku: normalizedSku(row.sku),
    stage: String(row.stage || ""),
    reason: String(row.reason || ""),
    store_id: Number(runtimeEventData(row).store_id) || null,
  }));
}

export function evidenceSnapshotHash(snapshot) {
  const clone = { ...snapshot };
  delete clone.snapshot_hash;
  return createHash("sha256").update(JSON.stringify(clone)).digest("hex");
}
