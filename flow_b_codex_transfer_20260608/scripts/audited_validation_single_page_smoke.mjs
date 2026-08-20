#!/usr/bin/env node

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  AUDITED_BROWSER_EXECUTABLE,
  AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES,
  AUDITED_EXTENSION_DIR,
  AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG,
  AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG_SHA256,
  AUDITED_VALIDATION_DEBUG_PORT,
  AUDITED_VALIDATION_PROFILE,
  AUDITED_VALIDATION_ROOT,
  PRODUCTION_DEBUG_PORT,
  PRODUCTION_PROFILE,
  auditedExtensionPreflightFailureEvidence,
  auditedPidDescendsFrom,
  withAuditedValidationOwnedContext,
} from "./audited_validation_discovery.mjs";
import {
  AUDITED_DISCOVERY_SEED_OBSERVATION_CONTRACT,
  AUDITED_DISCOVERY_SEED_SCOPE,
  auditedCardPriceEligibility,
  auditedSeedObservationEligibility,
  auditedSeedTitleEligibility,
  buildAuditedSeedBinding,
  loadAuditedDiscoverySeedArtifact,
} from "./flow_b_playwright/audited-discovery-seed.mjs";
import { createPinnedAuditedSeedPlaywrightAdapter } from "./flow_b_playwright/audited-seed-playwright-adapter.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");

export const AUDITED_SINGLE_PAGE_SMOKE_CONTRACT = "ozon-audited-single-page-smoke-v1";
export const AUDITED_SMOKE_TIMELINE_CONTRACT = "ozon-audited-smoke-forensic-sample-v1";
export const AUDITED_SMOKE_FORENSIC_ROOT = path.join(AUDITED_VALIDATION_ROOT, "state", "forensics");
export const AUDITED_SMOKE_OWNER_LOCK = path.join(
  AUDITED_VALIDATION_ROOT,
  "state",
  "locks",
  "single-page-smoke-owner.json",
);
export const PRODUCTION_SUPERVISOR_LOCK_DIR = "/Users/mac/.ozon-24h-production/state/supervisor.lock";
export const DEFAULT_SEED_ARTIFACT = path.join(PACKAGE_ROOT, "config", "ozon_audited_discovery_seeds.json");
export const DEFAULT_SMOKE_DISK_FLOOR_BYTES = 8 * 1024 * 1024 * 1024;
export const AUDITED_SMOKE_STATES = Object.freeze([
  "before_launch",
  "starting",
  "listening",
  "closing",
  "stopped",
]);
export const AUDITED_SMOKE_DECISION_CODES = Object.freeze([
  "WATCH_OK",
  "WATCH_START_GRACE",
  "WATCH_CLOSE_GRACE",
  "WATCH_EDGE_CONFIRM_PENDING",
  "WATCH_STATE_TRANSITION_INVALID",
  "WATCH_LAUNCH_BASELINE_CHANGED",
  "WATCH_PRODUCTION_PROCESS_PRESENT",
  "WATCH_PRODUCTION_PORT_9223_IN_USE",
  "WATCH_DISK_FLOOR_BREACHED",
  "WATCH_CRITICAL_DIGEST_CHANGED",
  "WATCH_SAMPLE_GAP_EXCEEDED",
  "WATCH_PROCESS_IDENTITY_CHANGED",
  "WATCH_LISTENER_BIND_ADDRESS_INVALID",
  "WATCH_ROOT_COUNT_INVALID",
  "WATCH_ROOT_COMMAND_INVALID",
  "WATCH_ROOT_ORCHESTRATOR_ANCESTRY_INVALID",
  "WATCH_LISTENER_COUNT_INVALID",
  "WATCH_LISTENER_WITHOUT_ROOT",
  "WATCH_LISTENER_OWNER_INVALID",
  "WATCH_START_TIMEOUT",
  "WATCH_CLOSE_TIMEOUT",
  "WATCH_UNEXPECTED_MIDRUN_LOSS",
  "WATCH_UNEXPECTED_PROCESS_BEFORE_OR_AFTER_RUN",
  "WATCH_ORCHESTRATOR_NOT_LIVE",
  "WATCH_OBSERVER_COVERAGE_CLAIM_INVALID",
  "WATCH_PRE_OBSERVER_MUTATION_SIGNAL",
  "WATCH_MUTATION_OBSERVED",
  "WATCH_FORENSIC_PERSISTENCE_FAILED",
  "WATCH_STOPPED_PROVED",
  "SMOKE_LOCK_ACQUIRE_FAILED",
  "SMOKE_OPERATION_FAILED",
  "SMOKE_NETWORK_EVIDENCE_INCOMPLETE",
  "SMOKE_MUTATION_ZERO_NOT_PROVEN",
  "SMOKE_HASH_MANIFEST_READ_FAILED",
  "SMOKE_PRODUCTION_HASH_CHANGED",
  "SMOKE_EXACT_9224_CLEANUP_UNPROVEN",
  "SMOKE_PRODUCTION_BOOTOUT_UNPROVEN",
  ...Object.values(AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES),
]);

const STATE_RANK = new Map(AUDITED_SMOKE_STATES.map((state, index) => [state, index]));
const EXTENSION_PREFLIGHT_FAILURE_CODE_SET = new Set(
  Object.values(AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES),
);
const BUSINESS_CALL_KEYS = Object.freeze([
  "source_scan_requests",
  "live_detail_requests",
  "classification_requests",
  "favorite_mutation_attempts",
  "submission_attempts",
]);
const BUSINESS_CALL_LIMITS = Object.freeze({
  source_scan_requests: 1,
  live_detail_requests: 1,
  classification_requests: 1,
  favorite_mutation_attempts: 0,
  submission_attempts: 0,
});
const ALLOWED_PHASES = new Set(["preflight", "bootstrap", "operational"]);
const WEB_REQUEST_SMOKE_PROBE_BY_ID = new Map(
  AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG.map((descriptor, index) => [
    descriptor.probe_id,
    Object.freeze({ descriptor, index }),
  ]),
);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isoNow(now = () => new Date()) {
  const value = now();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function safeRunId(value) {
  const runId = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/iu.test(runId)
    || runId === "." || runId === ".." || runId.includes("..")) {
    throw new AuditedSmokeFailure("SMOKE_OPERATION_FAILED", null, "invalid smoke run id");
  }
  return runId;
}

function zeroBusinessCalls() {
  return Object.fromEntries(BUSINESS_CALL_KEYS.map((key) => [key, 0]));
}

function sanitizedBusinessCalls(value = {}) {
  return Object.freeze(Object.fromEntries(BUSINESS_CALL_KEYS.map((key) => [
    key,
    Number.isInteger(Number(value[key])) && Number(value[key]) >= 0 ? Number(value[key]) : 0,
  ])));
}

function sanitizedWebRequestSmokeProbeEvidence(value) {
  let source;
  try {
    source = value?.webRequestSmokeDiagnostics
      || value?.web_request_smoke_evidence
      || value;
  } catch {
    return null;
  }
  if (!source || typeof source !== "object") return null;
  try {
    const catalogSha256 = source.smokeProbeCatalogSha256
      ?? source.smoke_probe_catalog_sha256;
    const expectedCount = source.smokeProbeExpectedCount
      ?? source.smoke_probe_expected_count;
    const observedCount = source.smokeProbeObservedCount
      ?? source.smoke_probe_observed_count;
    const duplicateRequestCount = source.smokeProbeDuplicateRequestCount
      ?? source.smoke_probe_duplicate_request_count;
    const drainElapsedMs = source.smokeProbeDrainElapsedMs
      ?? source.smoke_probe_drain_elapsed_ms;
    const drainTimedOut = source.smokeProbeDrainTimedOut
      ?? source.smoke_probe_drain_timed_out;
    const missingSource = source.smokeProbeMissing
      ?? source.smoke_probe_missing;
    const schemeSource = source.smokeProbeSchemeCounts
      ?? source.smoke_probe_scheme_counts;
    if (catalogSha256 !== AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG_SHA256
      || expectedCount !== AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG.length
      || !Number.isSafeInteger(observedCount) || observedCount < 0 || observedCount > expectedCount
      || !Number.isSafeInteger(duplicateRequestCount) || duplicateRequestCount < 0
      || duplicateRequestCount > 1_000_000
      || !Number.isSafeInteger(drainElapsedMs) || drainElapsedMs < 0 || drainElapsedMs > 1_000
      || typeof drainTimedOut !== "boolean"
      || !Array.isArray(missingSource)
      || missingSource.length !== expectedCount - observedCount
      || !schemeSource || typeof schemeSource !== "object") return null;

    const seenIds = new Set();
    const missing = [];
    for (const input of missingSource) {
      const probeId = typeof input?.probe_id === "string" ? input.probe_id : "";
      const catalogEntry = WEB_REQUEST_SMOKE_PROBE_BY_ID.get(probeId);
      const observedSchemes = Array.isArray(input?.observed_schemes)
        ? [...input.observed_schemes]
        : null;
      if (!catalogEntry || seenIds.has(probeId) || !observedSchemes
        || new Set(observedSchemes).size !== observedSchemes.length
        || observedSchemes.some((scheme) => scheme !== "http" && scheme !== "https")) return null;
      seenIds.add(probeId);
      missing.push(Object.freeze({
        probe_id: catalogEntry.descriptor.probe_id,
        kind: catalogEntry.descriptor.expected_kind,
        requested_scheme: catalogEntry.descriptor.requested_scheme,
        observed_schemes: Object.freeze([...observedSchemes].sort()),
      }));
    }
    missing.sort((left, right) => (
      WEB_REQUEST_SMOKE_PROBE_BY_ID.get(left.probe_id).index
      - WEB_REQUEST_SMOKE_PROBE_BY_ID.get(right.probe_id).index
    ));

    const requestedHttp = schemeSource.requested_http;
    const requestedHttps = schemeSource.requested_https;
    const observedHttp = schemeSource.observed_http;
    const observedHttps = schemeSource.observed_https;
    const httpToHttps = schemeSource.http_to_https;
    const catalogRequestedHttp = AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG
      .filter((descriptor) => descriptor.requested_scheme === "http").length;
    const catalogRequestedHttps = expectedCount - catalogRequestedHttp;
    if (requestedHttp !== catalogRequestedHttp || requestedHttps !== catalogRequestedHttps
      || !Number.isSafeInteger(observedHttp) || observedHttp < 0 || observedHttp > expectedCount
      || !Number.isSafeInteger(observedHttps) || observedHttps < 0 || observedHttps > expectedCount
      || !Number.isSafeInteger(httpToHttps) || httpToHttps < 0 || httpToHttps > requestedHttp
      || (missing.length > 0) !== drainTimedOut) return null;

    return Object.freeze({
      smoke_probe_catalog_sha256: AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG_SHA256,
      smoke_probe_expected_count: expectedCount,
      smoke_probe_observed_count: observedCount,
      smoke_probe_missing: Object.freeze(missing),
      smoke_probe_scheme_counts: Object.freeze({
        requested_http: requestedHttp,
        requested_https: requestedHttps,
        observed_http: observedHttp,
        observed_https: observedHttps,
        http_to_https: httpToHttps,
      }),
      smoke_probe_duplicate_request_count: duplicateRequestCount,
      smoke_probe_drain_elapsed_ms: drainElapsedMs,
      smoke_probe_drain_timed_out: drainTimedOut,
    });
  } catch {
    return null;
  }
}

function sanitizedExtensionPreflightFailure(error, seen = new Set(), depth = 0) {
  if (!error || depth > 4 || seen.has(error)) return null;
  if ((typeof error === "object" || typeof error === "function")) seen.add(error);
  const requestedCode = String(error?.failure_code || error?.code || "");
  if (EXTENSION_PREFLIGHT_FAILURE_CODE_SET.has(requestedCode)) {
    const failure = auditedExtensionPreflightFailureEvidence({
      failure_code: requestedCode,
      preflight_step: error?.preflight_step,
      audit_phase: error?.audit_phase,
    }, error?.audit_phase);
    const evidence = error?.preflight_evidence;
    const smokeProbeEvidence = requestedCode
        === AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_SMOKE_INCOMPLETE
      ? sanitizedWebRequestSmokeProbeEvidence(evidence)
        || sanitizedWebRequestSmokeProbeEvidence(error)
      : null;
    return Object.freeze({
      failure_code: failure.failure_code,
      preflight_step: failure.preflight_step,
      audit_phase: failure.audit_phase,
      preflight_evidence: Object.freeze({
        bootstrap_lockdown_proven: evidence?.bootstrap_lockdown_proven === true,
        observer_was_bound: evidence?.observer_was_bound === true,
        dnr_rules_exact: evidence?.dnr_rules_exact === true,
        dnr_rule_set_sha256: /^[a-f0-9]{64}$/u.test(String(evidence?.dnr_rule_set_sha256 || ""))
          ? String(evidence.dnr_rule_set_sha256)
          : null,
        ...(smokeProbeEvidence || {}),
      }),
    });
  }
  for (const nested of Array.isArray(error?.errors) ? error.errors : []) {
    const failure = sanitizedExtensionPreflightFailure(nested, seen, depth + 1);
    if (failure) return failure;
  }
  return sanitizedExtensionPreflightFailure(error?.cause, seen, depth + 1);
}

export class AuditedSmokeFailure extends Error {
  constructor(code, failedSampleSeq = null, message = code, details = {}) {
    super(message);
    this.name = "AuditedSmokeFailure";
    this.code = AUDITED_SMOKE_DECISION_CODES.includes(code) ? code : "SMOKE_OPERATION_FAILED";
    this.failed_sample_seq = Number.isInteger(failedSampleSeq) ? failedSampleSeq : null;
    this.operation_entered = details.operation_entered === true;
    this.business_calls = sanitizedBusinessCalls(details.business_calls);
    const preflight = sanitizedExtensionPreflightFailure({
      code: this.code,
      failure_code: details.preflight_failure_code || this.code,
      preflight_step: details.preflight_step,
      audit_phase: details.audit_phase,
      preflight_evidence: details.preflight_evidence,
    });
    this.preflight_step = preflight?.preflight_step || null;
    this.audit_phase = preflight?.audit_phase || null;
    this.preflight_evidence = preflight?.preflight_evidence || null;
  }
}

async function fixedDirectoryCapability(directory, label, { create = false } = {}) {
  const absolute = path.resolve(directory);
  if (create) await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  const lstat = await fs.lstat(absolute);
  const stat = await fs.stat(absolute);
  const realpath = await fs.realpath(absolute);
  if (lstat.isSymbolicLink() || !lstat.isDirectory() || realpath !== absolute) {
    throw new AuditedSmokeFailure("WATCH_FORENSIC_PERSISTENCE_FAILED", null, `${label} is not a fixed real directory`);
  }
  return Object.freeze({ path: absolute, realpath, dev: stat.dev, ino: stat.ino });
}

async function assertDirectoryCapability(capability, label) {
  const lstat = await fs.lstat(capability.path);
  const stat = await fs.stat(capability.path);
  const realpath = await fs.realpath(capability.path);
  if (lstat.isSymbolicLink() || !lstat.isDirectory() || realpath !== capability.realpath
    || stat.dev !== capability.dev || stat.ino !== capability.ino) {
    throw new AuditedSmokeFailure("WATCH_FORENSIC_PERSISTENCE_FAILED", null, `${label} identity changed`);
  }
}

async function assertSingleLinkHandle(handle, label) {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new AuditedSmokeFailure("WATCH_FORENSIC_PERSISTENCE_FAILED", null, `${label} is not a single-link regular file`);
  }
  return stat;
}

async function writeAtomicCapability(filename, document, parentCapability) {
  await assertDirectoryCapability(parentCapability, "forensic output parent");
  const absolute = path.resolve(filename);
  if (path.dirname(absolute) !== parentCapability.path) {
    throw new AuditedSmokeFailure("WATCH_FORENSIC_PERSISTENCE_FAILED", null, "forensic output escaped its run directory");
  }
  const existing = await fs.lstat(absolute).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)) {
    throw new AuditedSmokeFailure("WATCH_FORENSIC_PERSISTENCE_FAILED", null, "forensic output target is unsafe");
  }
  const temporary = `${absolute}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    await assertDirectoryCapability(parentCapability, "forensic output parent");
    await assertSingleLinkHandle(handle, "forensic temporary output");
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.sync();
    await handle.close();
    handle = null;
    await assertDirectoryCapability(parentCapability, "forensic output parent");
    await fs.rename(temporary, absolute);
    const finalHandle = await fs.open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    try { await assertSingleLinkHandle(finalHandle, "forensic atomic output"); }
    finally { await finalHandle.close(); }
    const parentHandle = await fs.open(parentCapability.path, fsConstants.O_RDONLY);
    try { await parentHandle.sync(); }
    finally { await parentHandle.close(); }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
}

async function readCapabilityFile(filename, parentCapability, expectedIdentity = null) {
  await assertDirectoryCapability(parentCapability, "forensic read parent");
  const absolute = path.resolve(filename);
  if (path.dirname(absolute) !== parentCapability.path) {
    throw new AuditedSmokeFailure("WATCH_FORENSIC_PERSISTENCE_FAILED", null, "forensic read escaped run directory");
  }
  const handle = await fs.open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const stat = await assertSingleLinkHandle(handle, "forensic read target");
    const pathStat = await fs.lstat(absolute);
    if (pathStat.isSymbolicLink() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino
      || (expectedIdentity && (stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino))) {
      throw new AuditedSmokeFailure("WATCH_FORENSIC_PERSISTENCE_FAILED", null, "forensic read target identity changed");
    }
    return Object.freeze({ bytes: await handle.readFile(), identity: Object.freeze({ dev: stat.dev, ino: stat.ino }) });
  } finally { await handle.close(); }
}

export async function createAuditedSmokeForensicRun({
  forensicRoot = AUDITED_SMOKE_FORENSIC_ROOT,
  runId,
  now = () => new Date(),
} = {}) {
  const safeId = safeRunId(runId);
  const root = await fixedDirectoryCapability(forensicRoot, "audited validation forensic root", { create: true });
  await assertDirectoryCapability(root, "audited validation forensic root");
  const directory = path.join(root.path, safeId);
  await fs.mkdir(directory, { mode: 0o700 });
  const parent = await fixedDirectoryCapability(directory, "audited smoke forensic run directory");
  await assertDirectoryCapability(root, "audited validation forensic root");
  const timelineFile = path.join(directory, "timeline.jsonl");
  const timelineHandle = await fs.open(
    timelineFile,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_APPEND | fsConstants.O_WRONLY
      | (fsConstants.O_NOFOLLOW || 0),
    0o600,
  );
  const timelineIdentity = await assertSingleLinkHandle(timelineHandle, "audited smoke timeline");
  let closed = false;
  let finalized = false;
  let releaseCommitted = false;
  let finalizedManifestSha256 = null;
  let previousRecordHash = null;

  async function assertTimelineIdentity() {
    await assertDirectoryCapability(parent, "audited smoke forensic run directory");
    const pathLstat = await fs.lstat(timelineFile);
    const handleStat = await assertSingleLinkHandle(timelineHandle, "audited smoke timeline");
    if (pathLstat.isSymbolicLink() || !pathLstat.isFile() || pathLstat.nlink !== 1
      || pathLstat.dev !== timelineIdentity.dev || pathLstat.ino !== timelineIdentity.ino
      || handleStat.dev !== timelineIdentity.dev || handleStat.ino !== timelineIdentity.ino) {
      throw new AuditedSmokeFailure("WATCH_FORENSIC_PERSISTENCE_FAILED", null, "audited smoke timeline identity changed");
    }
  }

  return Object.freeze({
    directory,
    timeline_file: timelineFile,
    async append(row) {
      if (closed) throw new AuditedSmokeFailure("WATCH_FORENSIC_PERSISTENCE_FAILED", row?.monotonic_seq, "timeline is closed");
      await assertTimelineIdentity();
      const chained = Object.freeze({ ...row, previous_record_hash: previousRecordHash });
      const record = Object.freeze({ ...chained, record_hash: sha256(JSON.stringify(chained)) });
      await timelineHandle.write(`${JSON.stringify(record)}\n`);
      await timelineHandle.sync();
      await assertTimelineIdentity();
      previousRecordHash = record.record_hash;
      return record;
    },
    async abort() {
      if (!closed) {
        await timelineHandle.sync().catch(() => {});
        await timelineHandle.close();
        closed = true;
      }
      return Object.freeze({ closed: true, finalized: false });
    },
    async finalize(result, productionManifest = null) {
      if (finalized) throw new AuditedSmokeFailure("WATCH_FORENSIC_PERSISTENCE_FAILED", null, "forensic run already finalized");
      finalized = true;
      if (!closed) {
        await assertTimelineIdentity();
        await timelineHandle.sync();
        await timelineHandle.close();
        closed = true;
      }
      await assertDirectoryCapability(parent, "audited smoke forensic run directory");
      const timelineRead = await readCapabilityFile(timelineFile, parent, timelineIdentity);
      const timelineBytes = timelineRead.bytes;
      const resultDocument = Object.freeze({
        contract: AUDITED_SINGLE_PAGE_SMOKE_CONTRACT,
        finalized_at: isoNow(now),
        ...result,
      });
      const resultFile = path.join(directory, "result.json");
      await writeAtomicCapability(resultFile, resultDocument, parent);
      const resultBytes = (await readCapabilityFile(resultFile, parent)).bytes;
      const manifestDocument = Object.freeze({
        contract: "ozon-audited-single-page-smoke-manifest-v1",
        run_id: safeId,
        result_sha256: sha256(resultBytes),
        timeline_sha256: sha256(timelineBytes),
        production_hash_manifest: productionManifest,
      });
      const manifestFile = path.join(directory, "manifest.json");
      await writeAtomicCapability(manifestFile, manifestDocument, parent);
      const manifestBytes = (await readCapabilityFile(manifestFile, parent)).bytes;
      const manifestSha256 = sha256(manifestBytes);
      await writeAtomicCapability(path.join(directory, "manifest.sha256.json"), Object.freeze({
        contract: "ozon-audited-single-page-smoke-manifest-digest-v1",
        manifest_sha256: manifestSha256,
      }), parent);
      finalizedManifestSha256 = manifestSha256;
      return Object.freeze({
        result_sha256: manifestDocument.result_sha256,
        timeline_sha256: manifestDocument.timeline_sha256,
        manifest_sha256: manifestSha256,
      });
    },
    async commitRelease(releaseEvidence) {
      if (!finalized || !closed || !finalizedManifestSha256) {
        throw new AuditedSmokeFailure(
          "WATCH_FORENSIC_PERSISTENCE_FAILED",
          null,
          "forensic manifest must be finalized before lock release is committed",
        );
      }
      if (releaseCommitted) {
        throw new AuditedSmokeFailure("WATCH_FORENSIC_PERSISTENCE_FAILED", null, "lock release is already committed");
      }
      const releaseDocument = Object.freeze({
        ...releaseEvidence,
        contract: "ozon-audited-single-page-smoke-release-commit-v1",
        committed_at: isoNow(now),
        run_id: safeId,
        manifest_sha256: finalizedManifestSha256,
      });
      const releaseFile = path.join(directory, "release-commit.json");
      await writeAtomicCapability(releaseFile, releaseDocument, parent);
      const releaseBytes = (await readCapabilityFile(releaseFile, parent)).bytes;
      const releaseCommitSha256 = sha256(releaseBytes);
      await writeAtomicCapability(path.join(directory, "release-commit.sha256.json"), Object.freeze({
        contract: "ozon-audited-single-page-smoke-release-commit-digest-v1",
        release_commit_sha256: releaseCommitSha256,
      }), parent);
      releaseCommitted = true;
      return Object.freeze({ release_commit_sha256: releaseCommitSha256 });
    },
  });
}

function commandHasExactArgument(command, name, value) {
  const expected = `${name}=${value}`;
  return String(command || "").split(/\s+/u)
    .some((token) => token.replace(/^['"]|['"]$/gu, "") === expected);
}

function commandExactArgumentOnce(command, name, value) {
  const prefix = `${name}=`;
  const values = String(command || "").split(/\s+/u)
    .map((token) => token.replace(/^['"]|['"]$/gu, ""))
    .filter((token) => token.startsWith(prefix));
  return values.length === 1 && values[0] === `${name}=${value}`;
}

export function auditedSmokeValidationRoots(processRows, {
  profile = AUDITED_VALIDATION_PROFILE,
  executable = AUDITED_BROWSER_EXECUTABLE,
  port = AUDITED_VALIDATION_DEBUG_PORT,
} = {}) {
  return Object.freeze((processRows || []).flatMap((row) => {
    const command = String(row?.command || "");
    if (!commandHasExactArgument(command, "--user-data-dir", profile)
      || /(?:^|\s)--type=/u.test(command)) return [];
    const exact = command.startsWith(`${executable} `)
      && commandExactArgumentOnce(command, "--user-data-dir", profile)
      && commandExactArgumentOnce(command, "--remote-debugging-address", "127.0.0.1")
      && commandExactArgumentOnce(command, "--remote-debugging-port", String(port))
      && !commandHasExactArgument(command, "--remote-debugging-port", String(PRODUCTION_DEBUG_PORT));
    return [Object.freeze({ pid: Number(row.pid), ppid: Number(row.ppid), exact })];
  }));
}

function ancestryFor(pid, rows) {
  const parentByPid = new Map((rows || []).map((row) => [Number(row.pid), Number(row.ppid)]));
  const ancestry = [];
  let cursor = Number(pid);
  const seen = new Set();
  while (cursor > 0 && !seen.has(cursor) && ancestry.length < 64) {
    ancestry.push(cursor);
    seen.add(cursor);
    cursor = parentByPid.get(cursor) || 0;
  }
  return Object.freeze(ancestry);
}

function processStartIdentity(rows, pid) {
  return String((rows || []).find((row) => Number(row.pid) === Number(pid))?.start_identity || "");
}

export function productionRootPids(rows) {
  return Object.freeze((rows || []).filter((row) => {
    const command = String(row?.command || "");
    const isPinnedValidationBrowser = commandHasExactArgument(command, "--user-data-dir", AUDITED_VALIDATION_PROFILE)
      && commandHasExactArgument(command, "--remote-debugging-port", String(AUDITED_VALIDATION_DEBUG_PORT));
    if (isPinnedValidationBrowser) return false;
    const productionBrowser = commandHasExactArgument(command, "--user-data-dir", PRODUCTION_PROFILE)
      || commandHasExactArgument(command, "--remote-debugging-port", String(PRODUCTION_DEBUG_PORT));
    const productionSupervisor = /(?:^|\s)\S*ozon_24h_supervisor\.mjs(?:\s|$)/u.test(command);
    const installedProductionWorker = /(?:^|\s)\S*\/\.ozon-24h-production\/app\/[^\s]*flow_b_playwright\.mjs\s+(?:accept|publish|run|start|resume)(?:\s|$)/u.test(command);
    return productionBrowser || productionSupervisor || installedProductionWorker;
  }).map((row) => Number(row.pid)));
}

function strictNonNegativeSafeInteger(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : Number.NaN;
  }
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function normalizeLaunchState(value) {
  if (value?.mode === "bootout" || value?.loaded === false) {
    return Object.freeze({ mode: "bootout", loaded: false });
  }
  return Object.freeze({
    mode: "loaded_not_running",
    loaded: true,
    active_count: strictNonNegativeSafeInteger(value?.active_count),
    state: String(value?.state || ""),
    runs: strictNonNegativeSafeInteger(value?.runs),
    last_exit_code: strictNonNegativeSafeInteger(value?.last_exit_code),
  });
}

function launchStateMatches(baseline, observed) {
  return JSON.stringify(normalizeLaunchState(baseline)) === JSON.stringify(normalizeLaunchState(observed));
}

function criticalDigestsMatch(baseline, observed) {
  return JSON.stringify(Object.fromEntries(Object.entries(baseline || {}).sort()))
    === JSON.stringify(Object.fromEntries(Object.entries(observed || {}).sort()));
}

function decision(code, { confirm = false } = {}) {
  return Object.freeze({ ok: ["WATCH_OK", "WATCH_START_GRACE", "WATCH_CLOSE_GRACE"].includes(code), code, confirm });
}

export function evaluateAuditedSmokeWatchSample({
  phase,
  state,
  sample,
  launchBaseline,
  criticalDigestBaseline,
  orchestratorPid,
  graceDeadlineMs,
  diskFloorBytes = DEFAULT_SMOKE_DISK_FLOOR_BYTES,
  nowMs = Date.now(),
  observerCoverage = "not_started",
  networkGate = "none",
  mutationZeroProven = false,
  mutationAttemptsObserved = 0,
  expectedRootIdentity = null,
  expectedListenerIdentity = null,
  orchestratorStartIdentity = null,
} = {}) {
  if (!ALLOWED_PHASES.has(phase) || !STATE_RANK.has(state)) return decision("WATCH_STATE_TRANSITION_INVALID");
  if (sample?.orchestrator_alive !== true) return decision("WATCH_ORCHESTRATOR_NOT_LIVE");
  if (!launchStateMatches(launchBaseline, sample?.launch)) return decision("WATCH_LAUNCH_BASELINE_CHANGED");
  if ((sample?.production_root_pids || []).length > 0) return decision("WATCH_PRODUCTION_PROCESS_PRESENT");
  if ((sample?.listener_pids?.[PRODUCTION_DEBUG_PORT] || []).length > 0) {
    return decision("WATCH_PRODUCTION_PORT_9223_IN_USE");
  }
  if (Number(sample?.disk_available_bytes) < Number(diskFloorBytes)) return decision("WATCH_DISK_FLOOR_BREACHED");
  if (!criticalDigestsMatch(criticalDigestBaseline, sample?.critical_digests)) {
    return decision("WATCH_CRITICAL_DIGEST_CHANGED");
  }
  if (Number(mutationAttemptsObserved) > 0) {
    return decision(observerCoverage === "not_available_before_dnr"
      ? "WATCH_PRE_OBSERVER_MUTATION_SIGNAL"
      : "WATCH_MUTATION_OBSERVED");
  }
  const bootstrapGateValid = networkGate === "host_resolver_offline"
    || (state === "stopped" && networkGate === "persisted_dnr_lockdown");
  if (phase === "bootstrap" && (!bootstrapGateValid
    || observerCoverage !== "not_available_before_dnr" || mutationZeroProven === true)) {
    return decision("WATCH_OBSERVER_COVERAGE_CLAIM_INVALID");
  }
  if (mutationZeroProven === true && observerCoverage !== "all_contexts_continuous") {
    return decision("WATCH_OBSERVER_COVERAGE_CLAIM_INVALID");
  }

  const rows = sample?.process_rows || [];
  const observedOrchestratorStart = processStartIdentity(rows, orchestratorPid);
  if (!observedOrchestratorStart
    || (orchestratorStartIdentity && observedOrchestratorStart !== orchestratorStartIdentity)) {
    return decision("WATCH_PROCESS_IDENTITY_CHANGED");
  }
  const roots = auditedSmokeValidationRoots(rows);
  const listeners = sample?.listener_pids?.[AUDITED_VALIDATION_DEBUG_PORT] || [];
  if (roots.length > 1) return decision("WATCH_ROOT_COUNT_INVALID");
  if (listeners.length > 1) return decision("WATCH_LISTENER_COUNT_INVALID");
  if (roots.length === 0 && listeners.length === 1) return decision("WATCH_LISTENER_WITHOUT_ROOT");
  if (roots.length === 1) {
    const startIdentity = processStartIdentity(rows, roots[0].pid);
    if (!startIdentity || (expectedRootIdentity
      && (expectedRootIdentity.pid !== roots[0].pid || expectedRootIdentity.start_identity !== startIdentity))) {
      return decision("WATCH_PROCESS_IDENTITY_CHANGED");
    }
    if (roots[0].exact !== true) return decision("WATCH_ROOT_COMMAND_INVALID");
    if (!auditedPidDescendsFrom(roots[0].pid, orchestratorPid, rows)) {
      return decision("WATCH_ROOT_ORCHESTRATOR_ANCESTRY_INVALID");
    }
  }
  if (listeners.length === 1 && (roots.length !== 1
    || !auditedPidDescendsFrom(listeners[0], roots[0].pid, rows))) {
    return decision("WATCH_LISTENER_OWNER_INVALID");
  }
  if (listeners.length === 1) {
    const startIdentity = processStartIdentity(rows, listeners[0]);
    if (!startIdentity || (expectedListenerIdentity
      && (expectedListenerIdentity.pid !== listeners[0]
        || expectedListenerIdentity.start_identity !== startIdentity))) {
      return decision("WATCH_PROCESS_IDENTITY_CHANGED");
    }
    const bindings = sample?.listener_bindings?.[AUDITED_VALIDATION_DEBUG_PORT]?.[listeners[0]];
    if (!Array.isArray(bindings) || bindings.length !== 1
      || !new RegExp(`^127\\.0\\.0\\.1:${AUDITED_VALIDATION_DEBUG_PORT}(?:\\s|$)`, "u")
        .test(String(bindings[0] || ""))) {
      return decision("WATCH_LISTENER_BIND_ADDRESS_INVALID");
    }
  }

  if (state === "before_launch" || state === "stopped") {
    return roots.length === 0 && listeners.length === 0
      ? decision("WATCH_OK")
      : decision("WATCH_UNEXPECTED_PROCESS_BEFORE_OR_AFTER_RUN");
  }
  if (state === "starting") {
    if (nowMs > Number(graceDeadlineMs)) return decision("WATCH_START_TIMEOUT");
    if (roots.length === 0 && listeners.length === 0) return decision("WATCH_START_GRACE");
    if (roots.length === 1 && listeners.length === 0) return decision("WATCH_START_GRACE");
    return decision("WATCH_OK");
  }
  if (state === "closing") {
    if (nowMs > Number(graceDeadlineMs)) return decision("WATCH_CLOSE_TIMEOUT");
    return roots.length === 0 && listeners.length === 0
      ? decision("WATCH_OK")
      : decision("WATCH_CLOSE_GRACE");
  }
  if (state === "listening" && roots.length === 1 && listeners.length === 1) return decision("WATCH_OK");
  return decision("WATCH_UNEXPECTED_MIDRUN_LOSS", { confirm: true });
}

function sanitizedSampleRow({
  sequence,
  timestamp,
  phase,
  state,
  cause,
  operationEntered,
  businessCalls,
  networkGate,
  observerCoverage,
  mutationZeroProven,
  sample,
  decisionCode,
  preflightFailure = null,
}) {
  const rows = sample?.process_rows || [];
  const roots = auditedSmokeValidationRoots(rows);
  const validationListeners = sample?.listener_pids?.[AUDITED_VALIDATION_DEBUG_PORT] || [];
  return Object.freeze({
    contract: AUDITED_SMOKE_TIMELINE_CONTRACT,
    timestamp,
    monotonic_seq: sequence,
    phase,
    state,
    cause,
    operation_entered: operationEntered === true,
    observer_coverage: observerCoverage,
    network_gate: networkGate,
    mutation_zero_proven: mutationZeroProven === true,
    business_calls: sanitizedBusinessCalls(businessCalls),
    launch: normalizeLaunchState(sample?.launch),
    validation: Object.freeze({
      root_count: roots.length,
      roots: Object.freeze(roots.map((root) => Object.freeze({
        pid: root.pid,
        ppid: root.ppid,
        start_identity: processStartIdentity(rows, root.pid),
        exact_cmdline: root.exact,
        ancestry: ancestryFor(root.pid, rows),
      }))),
      listener_count: validationListeners.length,
      listeners: Object.freeze(validationListeners.map((pid) => Object.freeze({
        pid,
        start_identity: processStartIdentity(rows, pid),
        bind_addresses: Object.freeze([
          ...(sample?.listener_bindings?.[AUDITED_VALIDATION_DEBUG_PORT]?.[pid] || []),
        ].map(String)),
        ancestry: ancestryFor(pid, rows),
      }))),
      orchestrator_pid: Number(sample?.orchestrator_pid),
      orchestrator_start_identity: String(sample?.orchestrator_start_identity || ""),
      orchestrator_alive: sample?.orchestrator_alive === true,
    }),
    production: Object.freeze({
      root_pids: Object.freeze([...(sample?.production_root_pids || [])]),
      port_9223_listener_pids: Object.freeze([...(sample?.listener_pids?.[PRODUCTION_DEBUG_PORT] || [])]),
    }),
    ports: Object.freeze({
      [PRODUCTION_DEBUG_PORT]: Object.freeze({
        listener_count: (sample?.listener_pids?.[PRODUCTION_DEBUG_PORT] || []).length,
        listener_pids: Object.freeze([...(sample?.listener_pids?.[PRODUCTION_DEBUG_PORT] || [])]),
      }),
      [AUDITED_VALIDATION_DEBUG_PORT]: Object.freeze({
        listener_count: validationListeners.length,
        listener_pids: Object.freeze([...validationListeners]),
      }),
    }),
    disk: Object.freeze({
      available_bytes: Number(sample?.disk_available_bytes),
    }),
    critical_digests: Object.freeze({ ...(sample?.critical_digests || {}) }),
    ...(preflightFailure ? {
      failure_code: preflightFailure.failure_code,
      preflight_step: preflightFailure.preflight_step,
      audit_phase: preflightFailure.audit_phase,
      preflight_evidence: preflightFailure.preflight_evidence,
    } : {}),
    decision_code: decisionCode,
  });
}

function transitionAllowed(previousPhase, previousState, nextPhase, nextState) {
  if (!ALLOWED_PHASES.has(nextPhase) || !STATE_RANK.has(nextState)) return false;
  if (previousPhase === "preflight" && previousState === "before_launch") {
    return nextPhase === "bootstrap" && nextState === "starting";
  }
  if (previousPhase === nextPhase) {
    return STATE_RANK.get(nextState) >= STATE_RANK.get(previousState);
  }
  return previousPhase === "bootstrap" && previousState === "stopped"
    && nextPhase === "operational" && nextState === "starting";
}

export function createAuditedSmokeWatcher({
  writer,
  probe,
  launchBaseline,
  criticalDigestBaseline,
  businessCalls = zeroBusinessCalls(),
  orchestratorPid = process.pid,
  now = () => new Date(),
  monotonicNow = () => Date.now(),
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  sampleIntervalMs = 1_000,
  startGraceMs = 8_000,
  closeGraceMs = 10_000,
  diskFloorBytes = DEFAULT_SMOKE_DISK_FLOOR_BYTES,
  maxSampleGapMs = 2_500,
  onFatal = null,
} = {}) {
  if (typeof writer?.append !== "function" || typeof probe !== "function") {
    throw new AuditedSmokeFailure("WATCH_FORENSIC_PERSISTENCE_FAILED", null, "watcher needs a durable writer and probe");
  }
  let phase = "preflight";
  let state = "before_launch";
  let sequence = 0;
  let operationEntered = false;
  let observerCoverage = "not_started";
  let networkGate = "none";
  let mutationZeroProven = false;
  let mutationAttemptsObserved = 0;
  let graceDeadlineMs = Number.POSITIVE_INFINITY;
  let running = false;
  let timer = null;
  let failure = null;
  let serialized = Promise.resolve();
  let lastSampleAtMs = null;
  let fatalActionPromise = null;
  let emergencyStoppedProven = false;
  let orchestratorStartIdentity = null;
  let ownedRootIdentity = null;
  let ownedListenerIdentity = null;
  let auditFailureSeq = null;

  function triggerFatal(error) {
    if (!failure) failure = error;
    if (!fatalActionPromise && typeof onFatal === "function") {
      try { fatalActionPromise = Promise.resolve(onFatal(failure)); }
      catch (fatalError) { fatalActionPromise = Promise.reject(fatalError); }
      fatalActionPromise.catch(() => {});
    }
    return failure;
  }

  async function appendEvent(row) {
    try { return await writer.append(row); }
    catch {
      throw triggerFatal(new AuditedSmokeFailure(
        "WATCH_FORENSIC_PERSISTENCE_FAILED",
        Number.isInteger(row?.monotonic_seq) ? row.monotonic_seq : sequence,
        "watch event persistence failed",
        { operation_entered: operationEntered, business_calls: businessCalls },
      ));
    }
  }

  async function persistAfterFatal(cause, { stopped = false } = {}) {
    let sample;
    try { sample = await probe(); }
    catch { return null; }
    const roots = auditedSmokeValidationRoots(sample?.process_rows || []);
    const listeners = sample?.listener_pids?.[AUDITED_VALIDATION_DEBUG_PORT] || [];
    if (stopped) state = "stopped";
    else if (state !== "stopped") state = "closing";
    const stoppedProven = stopped && roots.length === 0 && listeners.length === 0;
    emergencyStoppedProven ||= stoppedProven;
    sequence += 1;
    const row = sanitizedSampleRow({
      sequence,
      timestamp: isoNow(now),
      phase,
      state,
      cause,
      operationEntered,
      businessCalls,
      networkGate,
      observerCoverage,
      mutationZeroProven: false,
      sample,
      decisionCode: stoppedProven ? "WATCH_STOPPED_PROVED" : failure?.code || "SMOKE_OPERATION_FAILED",
    });
    try { await writer.append(row); }
    catch { return null; }
    return row;
  }

  async function persistSample(cause, { allowConfirm = true, preflightFailure = null } = {}) {
    if (failure) {
      await persistAfterFatal(`fatal_${cause}`);
      throw failure;
    }
    let sample;
    try { sample = await probe(); }
    catch {
      throw triggerFatal(new AuditedSmokeFailure(
        "WATCH_FORENSIC_PERSISTENCE_FAILED",
        sequence + 1,
        "watch probe failed",
        { operation_entered: operationEntered, business_calls: businessCalls },
      ));
    }
    const sampledAtMs = monotonicNow();
    const gapExceeded = lastSampleAtMs !== null && sampledAtMs - lastSampleAtMs > maxSampleGapMs;
    lastSampleAtMs = sampledAtMs;
    const sampleRows = sample?.process_rows || [];
    orchestratorStartIdentity ||= processStartIdentity(sampleRows, orchestratorPid);
    const assessed = gapExceeded ? decision("WATCH_SAMPLE_GAP_EXCEEDED") : evaluateAuditedSmokeWatchSample({
      phase,
      state,
      sample,
      launchBaseline,
      criticalDigestBaseline,
      orchestratorPid,
      graceDeadlineMs,
      diskFloorBytes,
      nowMs: sampledAtMs,
      observerCoverage,
      networkGate,
      mutationZeroProven,
      mutationAttemptsObserved,
      expectedRootIdentity: ownedRootIdentity,
      expectedListenerIdentity: ownedListenerIdentity,
      orchestratorStartIdentity,
    });
    sequence += 1;
    const row = sanitizedSampleRow({
      sequence,
      timestamp: isoNow(now),
      phase,
      state,
      cause,
      operationEntered,
      businessCalls,
      networkGate,
      observerCoverage,
      mutationZeroProven,
      sample,
      preflightFailure,
      decisionCode: assessed.confirm && allowConfirm ? "WATCH_EDGE_CONFIRM_PENDING" : assessed.code,
    });
    try { await writer.append(row); }
    catch {
      throw triggerFatal(new AuditedSmokeFailure(
        "WATCH_FORENSIC_PERSISTENCE_FAILED",
        sequence,
        "watch sample persistence failed",
        { operation_entered: operationEntered, business_calls: businessCalls },
      ));
    }
    if (assessed.confirm && allowConfirm) {
      await delay(100);
      return persistSample("edge_confirm_100ms", { allowConfirm: false });
    }
    if (!assessed.ok) {
      throw triggerFatal(new AuditedSmokeFailure(assessed.code, sequence, assessed.code, {
        operation_entered: operationEntered,
        business_calls: businessCalls,
      }));
    }
    const observedRoots = auditedSmokeValidationRoots(sampleRows);
    const observedListeners = sample?.listener_pids?.[AUDITED_VALIDATION_DEBUG_PORT] || [];
    if (!ownedRootIdentity && observedRoots.length === 1) {
      ownedRootIdentity = Object.freeze({
        pid: observedRoots[0].pid,
        start_identity: processStartIdentity(sampleRows, observedRoots[0].pid),
      });
    }
    if (!ownedListenerIdentity && observedListeners.length === 1) {
      ownedListenerIdentity = Object.freeze({
        pid: observedListeners[0],
        start_identity: processStartIdentity(sampleRows, observedListeners[0]),
      });
    }
    return row;
  }

  function enqueue(operation) {
    const current = serialized.then(operation);
    serialized = current.catch(() => {});
    return current;
  }

  async function transition(event) {
    return enqueue(async () => {
      if (failure) {
        await persistAfterFatal("fatal_lifecycle_event");
        throw failure;
      }
      const nextPhase = String(event?.phase || "");
      const nextState = String(event?.state || "");
      if (!transitionAllowed(phase, state, nextPhase, nextState)) {
        throw triggerFatal(new AuditedSmokeFailure("WATCH_STATE_TRANSITION_INVALID", sequence + 1, "invalid lifecycle transition", {
          operation_entered: operationEntered,
          business_calls: businessCalls,
        }));
      }
      if (nextPhase !== phase) {
        ownedRootIdentity = null;
        ownedListenerIdentity = null;
      }
      phase = nextPhase;
      state = nextState;
      if (event.network_gate !== undefined) networkGate = String(event.network_gate);
      if (event.observer_coverage !== undefined) observerCoverage = String(event.observer_coverage);
      if (event.mutation_attempts_observed !== undefined) {
        mutationAttemptsObserved = Number(event.mutation_attempts_observed) || 0;
      }
      if (event.mutation_zero_proven !== undefined) mutationZeroProven = event.mutation_zero_proven === true;
      if (state === "starting") graceDeadlineMs = monotonicNow() + startGraceMs;
      if (state === "closing") graceDeadlineMs = monotonicNow() + closeGraceMs;
      const preflightFailure = sanitizedExtensionPreflightFailure({
        failure_code: event?.failure_code,
        preflight_step: event?.preflight_step,
        audit_phase: event?.audit_phase,
        preflight_evidence: event,
      });
      const persisted = await persistSample(String(event.cause || `lifecycle_${phase}_${state}`), {
        preflightFailure,
      });
      if (preflightFailure && auditFailureSeq === null) {
        auditFailureSeq = Number.isInteger(persisted?.monotonic_seq)
          ? persisted.monotonic_seq
          : sequence;
      }
      await delay(100);
      return persistSample(`lifecycle_${phase}_${state}_confirm_100ms`, { allowConfirm: false });
    });
  }

  async function intervalTick() {
    if (!running) return;
    if (failure) await enqueue(() => persistAfterFatal("fatal_cleanup_interval"));
    else {
      try { await enqueue(() => persistSample("interval_1s")); }
      catch { /* fatal action is triggered by persistSample */ }
    }
    if (running && !emergencyStoppedProven) timer = setTimeout(intervalTick, sampleIntervalMs);
  }

  return Object.freeze({
    lifecycle: Object.freeze({ emit: transition }),
    get failed() { return failure; },
    get operation_entered() { return operationEntered; },
    get sequence() { return sequence; },
    throwIfFailed() { if (failure) throw failure; return true; },
    async checkpoint(cause) {
      if (failure) throw failure;
      const row = await enqueue(() => persistSample(cause));
      if (failure) throw failure;
      return row;
    },
    async ready() {
      await enqueue(() => persistSample("watcher_ready"));
      return true;
    },
    start() {
      if (!running) {
        running = true;
        timer = setTimeout(intervalTick, sampleIntervalMs);
      }
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      await serialized;
    },
    async markOperationEntered() {
      return enqueue(async () => {
        if (failure) throw failure;
        operationEntered = true;
        return appendEvent(Object.freeze({
          contract: AUDITED_SMOKE_TIMELINE_CONTRACT,
          timestamp: isoNow(now),
          monotonic_seq: ++sequence,
          phase,
          state,
          cause: "business_operation_entered",
          operation_entered: true,
          observer_coverage: observerCoverage,
          network_gate: networkGate,
          mutation_zero_proven: false,
          business_calls: sanitizedBusinessCalls(businessCalls),
          decision_code: "WATCH_OK",
        }));
      });
    },
    async recordBusinessAttempt(kind) {
      return enqueue(async () => {
        if (failure) throw failure;
        if (!BUSINESS_CALL_KEYS.includes(kind)) {
          throw triggerFatal(new AuditedSmokeFailure("SMOKE_OPERATION_FAILED", sequence, "unknown business call kind", {
            operation_entered: operationEntered,
            business_calls: businessCalls,
          }));
        }
        if (businessCalls[kind] >= BUSINESS_CALL_LIMITS[kind]) {
          throw triggerFatal(new AuditedSmokeFailure(
            "SMOKE_OPERATION_FAILED",
            sequence,
            `business call limit exceeded: ${kind}`,
            { operation_entered: operationEntered, business_calls: businessCalls },
          ));
        }
        businessCalls[kind] += 1;
        await appendEvent(Object.freeze({
          contract: AUDITED_SMOKE_TIMELINE_CONTRACT,
          timestamp: isoNow(now),
          monotonic_seq: ++sequence,
          phase,
          state,
          cause: "business_attempt_before_call",
          operation_entered: operationEntered,
          observer_coverage: observerCoverage,
          network_gate: networkGate,
          mutation_zero_proven: false,
          call_kind: kind,
          business_calls: sanitizedBusinessCalls(businessCalls),
          decision_code: "WATCH_OK",
        }));
        return businessCalls[kind];
      });
    },
    async recordAuditEvent(cause, fields = {}) {
      const safeFields = Object.freeze({
        ...(typeof fields.locks_cross_referenced === "boolean"
          ? { locks_cross_referenced: fields.locks_cross_referenced }
          : {}),
        ...(AUDITED_SMOKE_DECISION_CODES.includes(fields.fatal_code)
          ? { fatal_code: fields.fatal_code }
          : {}),
        ...(Number.isInteger(fields.failed_sample_seq)
          ? { failed_sample_seq: fields.failed_sample_seq }
          : {}),
      });
      return enqueue(() => appendEvent(Object.freeze({
        contract: AUDITED_SMOKE_TIMELINE_CONTRACT,
        timestamp: isoNow(now),
        monotonic_seq: ++sequence,
        phase,
        state,
        cause,
        operation_entered: operationEntered,
        observer_coverage: observerCoverage,
        network_gate: networkGate,
        mutation_zero_proven: mutationZeroProven,
        business_calls: sanitizedBusinessCalls(businessCalls),
        ...safeFields,
        decision_code: "WATCH_OK",
      })));
    },
    async persistEvidence(cause, evidence = {}) {
      return enqueue(async () => {
        if (failure) throw failure;
        if (evidence.observer_coverage !== undefined) observerCoverage = String(evidence.observer_coverage);
        if (evidence.network_gate !== undefined) networkGate = String(evidence.network_gate);
        if (evidence.mutation_attempts_observed !== undefined) {
          mutationAttemptsObserved = Number(evidence.mutation_attempts_observed) || 0;
        }
        if (evidence.mutation_zero_proven !== undefined) {
          mutationZeroProven = evidence.mutation_zero_proven === true;
        }
        return persistSample(cause);
      });
    },
    async journalEmergencyCleanup({ stopped = false, cause = "emergency_cleanup" } = {}) {
      return enqueue(() => persistAfterFatal(cause, { stopped }));
    },
    async awaitFatalAction() {
      return fatalActionPromise ? fatalActionPromise : null;
    },
    snapshot() {
      return Object.freeze({
        phase,
        state,
        sequence,
        operation_entered: operationEntered,
        observer_coverage: observerCoverage,
        network_gate: networkGate,
        mutation_zero_proven: mutationZeroProven,
        mutation_attempts_observed: mutationAttemptsObserved,
        audit_failure_seq: auditFailureSeq,
        preflight_failure_seq: auditFailureSeq,
        business_calls: sanitizedBusinessCalls(businessCalls),
        failed_code: failure?.code || null,
        failed_sample_seq: failure?.failed_sample_seq ?? null,
        emergency_stopped_proven: emergencyStoppedProven,
      });
    },
  });
}

async function lsofListenerAudit(port) {
  const result = await execFileAsync("/usr/sbin/lsof", [
    "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn",
  ]).catch((error) => Number(error?.code) === 1
    ? { stdout: error?.stdout || "" }
    : Promise.reject(error));
  const pids = [];
  const bindings = {};
  let currentPid = null;
  for (const line of String(result?.stdout || "").split(/\r?\n/u)) {
    if (/^p\d+$/u.test(line)) {
      currentPid = Number(line.slice(1));
      if (!pids.includes(currentPid)) pids.push(currentPid);
    } else if (line.startsWith("n") && currentPid) {
      bindings[currentPid] ||= [];
      bindings[currentPid].push(line.slice(1));
    }
  }
  return Object.freeze({
    pids: Object.freeze(pids),
    bindings: Object.freeze(Object.fromEntries(Object.entries(bindings)
      .map(([pid, rows]) => [pid, Object.freeze([...rows])]))),
  });
}

async function lsofListenerPids(port) {
  return (await lsofListenerAudit(port)).pids;
}

function parseSmokeProcessRows(text) {
  return Object.freeze(String(text || "").split(/\r?\n/u).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u);
    return match ? [Object.freeze({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      start_identity: match[3].replace(/\s+/gu, " "),
      command: match[4],
    })] : [];
  }));
}

export async function readProductionLaunchdState({
  label = "com.codex.ozon.24h-production",
  uid = process.getuid?.(),
  execute = execFileAsync,
} = {}) {
  const service = `gui/${uid}/${label}`;
  const result = await execute("/bin/launchctl", ["print", service])
    .catch((error) => ({ error, stdout: error?.stdout || "", stderr: error?.stderr || "" }));
  if (result.error) {
    const auditText = `${String(result.stderr || "")}\n${String(result.stdout || "")}`;
    if (Number(result.error?.code) === 113
      || /could not find service|service .* not found|no such process/iu.test(auditText)) {
      return Object.freeze({ mode: "bootout", loaded: false });
    }
    throw new AuditedSmokeFailure(
      "WATCH_LAUNCH_BASELINE_CHANGED",
      null,
      "launchd state could not be audited",
    );
  }
  const text = String(result.stdout || "");
  const field = (name) => text.match(new RegExp(`^\\s*${name} = (.+)$`, "mu"))?.[1]?.trim();
  return normalizeLaunchState({
    loaded: true,
    active_count: field("active count"),
    state: field("state"),
    runs: field("runs"),
    last_exit_code: field("last exit code"),
  });
}

export async function emergencyBootoutProductionLabel({
  label = "com.codex.ozon.24h-production",
  uid = process.getuid?.(),
  launchState = readProductionLaunchdState,
  execute = execFileAsync,
} = {}) {
  const service = `gui/${uid}/${label}`;
  const result = await execute("/bin/launchctl", ["bootout", service])
    .then(() => ({ already_bootout: false }))
    .catch((error) => {
      const auditText = `${String(error?.stderr || "")}\n${String(error?.stdout || "")}`;
      if (Number(error?.code) === 113
        || /could not find service|service .* not found|no such process/iu.test(auditText)) {
        return { already_bootout: true };
      }
      throw new AuditedSmokeFailure(
        "SMOKE_PRODUCTION_BOOTOUT_UNPROVEN",
        null,
        "exact production launchd bootout failed",
      );
    });
  const observed = normalizeLaunchState(await launchState({ label, uid }));
  return Object.freeze({
    exact_label: label,
    already_bootout: result.already_bootout,
    production_bootout_proven: observed.mode === "bootout",
  });
}

async function diskAvailableBytes(target = "/Users/mac") {
  const { stdout } = await execFileAsync("/bin/df", ["-Pk", target]);
  const line = String(stdout || "").trim().split(/\r?\n/u).at(-1) || "";
  const columns = line.trim().split(/\s+/u);
  const availableKb = Number(columns.at(-3));
  return Number.isFinite(availableKb) ? availableKb * 1024 : 0;
}

export async function hashNamedFiles(entries = {}, {
  chunkBytes = 4 * 1024 * 1024,
  createHash = () => crypto.createHash("sha256"),
  readChunk = (handle, buffer, offset, length, position) => (
    handle.read(buffer, offset, length, position)
  ),
} = {}) {
  const boundedChunkBytes = Number(chunkBytes);
  if (!Number.isSafeInteger(boundedChunkBytes)
    || boundedChunkBytes < 4 * 1024 || boundedChunkBytes > 16 * 1024 * 1024) {
    throw new AuditedSmokeFailure(
      "SMOKE_HASH_MANIFEST_READ_FAILED",
      null,
      "hash manifest chunk size is outside the bounded range",
    );
  }
  const rows = {};
  for (const [name, filename] of Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))) {
    let opened = false;
    try {
      const handle = await fs.open(path.resolve(filename), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      opened = true;
      try {
        const stat = await assertSingleLinkHandle(handle, `critical file ${name}`);
        const pathStat = await fs.lstat(path.resolve(filename));
        if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1
          || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino
          || pathStat.size !== stat.size || pathStat.mode !== stat.mode
          || pathStat.mtimeMs !== stat.mtimeMs || pathStat.ctimeMs !== stat.ctimeMs) {
          throw new AuditedSmokeFailure("WATCH_CRITICAL_DIGEST_CHANGED", null, `critical file ${name} path identity differs from fd`);
        }
        const digest = createHash();
        if (!digest || typeof digest.update !== "function" || typeof digest.digest !== "function") {
          throw new AuditedSmokeFailure(
            "SMOKE_HASH_MANIFEST_READ_FAILED",
            null,
            `critical file ${name} hash implementation is unavailable`,
          );
        }
        const buffer = Buffer.allocUnsafe(boundedChunkBytes);
        let position = 0;
        while (position < stat.size) {
          const length = Math.min(buffer.length, stat.size - position);
          const result = await readChunk(handle, buffer, 0, length, position);
          const bytesRead = Number(result?.bytesRead);
          if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > length) {
            throw new AuditedSmokeFailure(
              "WATCH_CRITICAL_DIGEST_CHANGED",
              null,
              `critical file ${name} ended or changed during hashing`,
            );
          }
          digest.update(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        const after = await handle.stat();
        const pathAfter = await fs.lstat(path.resolve(filename));
        if (after.dev !== stat.dev || after.ino !== stat.ino || after.nlink !== 1
          || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
          || after.mode !== stat.mode || pathAfter.isSymbolicLink() || !pathAfter.isFile()
          || pathAfter.dev !== stat.dev || pathAfter.ino !== stat.ino || pathAfter.nlink !== 1
          || pathAfter.size !== stat.size || pathAfter.mode !== stat.mode
          || pathAfter.mtimeMs !== stat.mtimeMs || pathAfter.ctimeMs !== stat.ctimeMs) {
          throw new AuditedSmokeFailure("WATCH_CRITICAL_DIGEST_CHANGED", null, `critical file ${name} changed during hashing`);
        }
        rows[name] = Object.freeze({
          sha256: digest.digest("hex"),
          size: stat.size,
          exists: true,
          dev: stat.dev,
          ino: stat.ino,
          nlink: stat.nlink,
          mode: stat.mode,
          mtime_ms: stat.mtimeMs,
          ctime_ms: stat.ctimeMs,
        });
      } finally { await handle.close(); }
    } catch (error) {
      if (error?.code !== "ENOENT" || opened) {
        if (error instanceof AuditedSmokeFailure) throw error;
        throw new AuditedSmokeFailure(
          "SMOKE_HASH_MANIFEST_READ_FAILED",
          null,
          `critical file ${name} could not be hashed`,
        );
      }
      rows[name] = Object.freeze({
        sha256: null,
        size: 0,
        exists: false,
        dev: null,
        ino: null,
        nlink: null,
        mode: null,
        mtime_ms: null,
        ctime_ms: null,
      });
    }
  }
  return Object.freeze(rows);
}

export function compareProductionHashManifests(before, after, allowedChangedNames = []) {
  const allowed = new Set(allowedChangedNames);
  const names = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort();
  const changed = names.filter((name) => JSON.stringify(before?.[name]) !== JSON.stringify(after?.[name]));
  const forbidden = changed.filter((name) => !allowed.has(name));
  return Object.freeze({
    exact_except_interlocks: forbidden.length === 0,
    changed_names: Object.freeze(changed),
    allowed_changed_names: Object.freeze(changed.filter((name) => allowed.has(name))),
    forbidden_changed_names: Object.freeze(forbidden),
  });
}

export function createDefaultAuditedSmokeProbe({
  criticalFiles,
  orchestratorPid = process.pid,
  launchState = readProductionLaunchdState,
  now = () => new Date(),
} = {}) {
  return async () => {
    const [{ stdout: processText }, listenerAudit9223, listenerAudit9224, launch, disk, criticalManifest] = await Promise.all([
      execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,lstart=,command="]),
      lsofListenerAudit(PRODUCTION_DEBUG_PORT),
      lsofListenerAudit(AUDITED_VALIDATION_DEBUG_PORT),
      launchState(),
      diskAvailableBytes(),
      hashNamedFiles(criticalFiles),
    ]);
    const rows = parseSmokeProcessRows(processText);
    const orchestratorStartIdentity = processStartIdentity(rows, orchestratorPid);
    return Object.freeze({
      timestamp: isoNow(now),
      orchestrator_pid: orchestratorPid,
      orchestrator_alive: Boolean(orchestratorStartIdentity),
      orchestrator_start_identity: orchestratorStartIdentity,
      process_rows: rows,
      production_root_pids: productionRootPids(rows),
      listener_pids: Object.freeze({
        [PRODUCTION_DEBUG_PORT]: listenerAudit9223.pids,
        [AUDITED_VALIDATION_DEBUG_PORT]: listenerAudit9224.pids,
      }),
      listener_bindings: Object.freeze({
        [PRODUCTION_DEBUG_PORT]: listenerAudit9223.bindings,
        [AUDITED_VALIDATION_DEBUG_PORT]: listenerAudit9224.bindings,
      }),
      launch,
      disk_available_bytes: disk,
      critical_digests: Object.freeze({ ...criticalManifest }),
    });
  };
}

async function createExclusiveJsonFile(filename, document, parentCapability) {
  await assertDirectoryCapability(parentCapability, "lock parent");
  const absolute = path.resolve(filename);
  if (path.dirname(absolute) !== parentCapability.path) {
    throw new AuditedSmokeFailure("SMOKE_LOCK_ACQUIRE_FAILED", null, "lock path escaped parent");
  }
  const handle = await fs.open(
    absolute,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    await assertDirectoryCapability(parentCapability, "lock parent");
    const stat = await assertSingleLinkHandle(handle, "lock owner");
    await handle.write(`${JSON.stringify(document, null, 2)}\n`);
    await handle.sync();
    return Object.freeze({ dev: stat.dev, ino: stat.ino });
  } finally { await handle.close(); }
}

async function readOwnedLock(filename, identity, tokenHash, parentCapability) {
  await assertDirectoryCapability(parentCapability, "lock parent");
  const handle = await fs.open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const stat = await assertSingleLinkHandle(handle, "lock owner");
    if (stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw new AuditedSmokeFailure("SMOKE_LOCK_ACQUIRE_FAILED", null, "lock owner inode changed");
    }
    const document = JSON.parse(await handle.readFile("utf8"));
    if (document.token_sha256 !== tokenHash || Number(document.pid) !== process.pid) {
      throw new AuditedSmokeFailure("SMOKE_LOCK_ACQUIRE_FAILED", null, "lock ownership changed");
    }
    return document;
  } finally { await handle.close(); }
}

async function updateOwnedLock(filename, identity, tokenHash, parentCapability, patch) {
  const current = await readOwnedLock(filename, identity, tokenHash, parentCapability);
  const handle = await fs.open(filename, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW || 0));
  try {
    const stat = await assertSingleLinkHandle(handle, "lock owner");
    if (stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw new AuditedSmokeFailure("SMOKE_LOCK_ACQUIRE_FAILED", null, "lock owner inode changed before update");
    }
    const bytes = Buffer.from(`${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
    await handle.truncate(0);
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.sync();
  } finally { await handle.close(); }
}

export async function acquireAuditedSmokeInterlocks({
  runId,
  productionLockDirectory = PRODUCTION_SUPERVISOR_LOCK_DIR,
  validationLockFile = AUDITED_SMOKE_OWNER_LOCK,
  now = () => new Date(),
  createLockFile = createExclusiveJsonFile,
  unlinkFile = fs.unlink,
  afterProductionLock = async () => {},
} = {}) {
  const safeId = safeRunId(runId);
  const productionParent = await fixedDirectoryCapability(
    path.dirname(path.resolve(productionLockDirectory)),
    "production supervisor lock parent",
  );
  const validationParent = await fixedDirectoryCapability(
    path.dirname(path.resolve(validationLockFile)),
    "validation smoke lock parent",
  );
  const productionDirectory = path.resolve(productionLockDirectory);
  const productionOwner = path.join(productionDirectory, "owner.json");
  const validationOwner = path.resolve(validationLockFile);
  const tokenHash = sha256(crypto.randomBytes(32));
  const acquiredAt = isoNow(now);
  let productionDirectoryCapability;
  let productionIdentity;
  let validationIdentity;

  async function inspectOne(filename, identity, parentCapability, expectedPeer) {
    if (!identity || !parentCapability) return Object.freeze({ present: false, owned: false, peer_exact: false });
    try {
      const document = await readOwnedLock(filename, identity, tokenHash, parentCapability);
      const preflight = sanitizedExtensionPreflightFailure({
        failure_code: document.failure_code,
        preflight_step: document.preflight_step,
        audit_phase: document.audit_phase,
        preflight_evidence: document.preflight_evidence,
      });
      const retainedFailureEvidence = document.status === "retained_after_failure"
          && preflight?.preflight_evidence
        ? Object.freeze({
          failure_code: preflight.failure_code,
          preflight_step: preflight.preflight_step,
          audit_phase: preflight.audit_phase,
          failed_sample_seq: Number.isInteger(document.failed_sample_seq)
            ? document.failed_sample_seq
            : null,
          preflight_evidence: preflight.preflight_evidence,
        })
        : null;
      return Object.freeze({
        present: true,
        owned: true,
        peer_exact: document.peer_lock === expectedPeer,
        status: String(document.status || ""),
        retained_failure_evidence: retainedFailureEvidence,
      });
    } catch (error) {
      if (error?.code === "ENOENT") return Object.freeze({ present: false, owned: false, peer_exact: false });
      return Object.freeze({ present: true, owned: false, peer_exact: false });
    }
  }

  async function exactEvidence() {
    const production = await inspectOne(
      productionOwner,
      productionIdentity,
      productionDirectoryCapability,
      validationOwner,
    );
    const validation = await inspectOne(validationOwner, validationIdentity, validationParent, productionOwner);
    const retainedFailureEvidenceExact = Boolean(
      production.retained_failure_evidence
      && validation.retained_failure_evidence
      && JSON.stringify(production.retained_failure_evidence)
        === JSON.stringify(validation.retained_failure_evidence),
    );
    const retainedFailureEvidencePresent = Boolean(
      production.retained_failure_evidence || validation.retained_failure_evidence,
    );
    return Object.freeze({
      production_lock_present: production.present,
      production_lock_owned: production.owned,
      validation_lock_present: validation.present,
      validation_lock_owned: validation.owned,
      cross_reference_exact: production.owned && validation.owned
        && production.peer_exact && validation.peer_exact,
      retained: production.owned && validation.owned,
      production_status: production.status || null,
      validation_status: validation.status || null,
      ...(retainedFailureEvidencePresent ? {
        retained_failure_evidence_exact: retainedFailureEvidenceExact,
        retained_failure_evidence: retainedFailureEvidenceExact
          ? production.retained_failure_evidence
          : null,
      } : {}),
    });
  }

  async function unlinkOwned(filename, identity, parentCapability) {
    await readOwnedLock(filename, identity, tokenHash, parentCapability);
    const pathStat = await fs.lstat(filename);
    if (pathStat.dev !== identity.dev || pathStat.ino !== identity.ino) {
      throw new AuditedSmokeFailure("SMOKE_LOCK_ACQUIRE_FAILED", null, "lock path changed before release");
    }
    await unlinkFile(filename);
    const parentHandle = await fs.open(parentCapability.path, fsConstants.O_RDONLY);
    try { await parentHandle.sync(); }
    finally { await parentHandle.close(); }
  }

  const interlocks = Object.freeze({
    get evidence() {
      return Object.freeze({
        cross_reference_exact: Boolean(productionIdentity && validationIdentity),
        production_lock_created: Boolean(productionIdentity),
        validation_lock_created: Boolean(validationIdentity),
        owner_pid: process.pid,
      });
    },
    exactEvidence,
    async retainFailure(
      code,
      failedSampleSeq,
      cleanupEvidence,
      preflightStep = null,
      auditPhase = null,
      preflightEvidence = null,
    ) {
      const preflight = sanitizedExtensionPreflightFailure({
        failure_code: code,
        preflight_step: preflightStep,
        audit_phase: auditPhase,
        preflight_evidence: preflightEvidence,
      });
      const patch = Object.freeze({
        status: "retained_after_failure",
        failure_code: AUDITED_SMOKE_DECISION_CODES.includes(code) ? code : "SMOKE_OPERATION_FAILED",
        preflight_step: preflight?.preflight_step || null,
        audit_phase: preflight?.audit_phase || null,
        preflight_evidence: preflight?.preflight_evidence || null,
        failed_sample_seq: Number.isInteger(failedSampleSeq) ? failedSampleSeq : null,
        exact_9224_cleanup_proven: cleanupEvidence?.exact_9224_cleanup_proven === true,
        retained_at: isoNow(now),
      });
      if (productionIdentity && productionDirectoryCapability) {
        await updateOwnedLock(productionOwner, productionIdentity, tokenHash, productionDirectoryCapability, patch)
          .catch(() => {});
      }
      if (validationIdentity) {
        await updateOwnedLock(validationOwner, validationIdentity, tokenHash, validationParent, patch)
          .catch(() => {});
      }
      return exactEvidence();
    },
    async releaseSuccess() {
      const before = await exactEvidence();
      if (!before.cross_reference_exact) {
        const error = new AuditedSmokeFailure("SMOKE_LOCK_ACQUIRE_FAILED", null, "both exact interlocks are required before release");
        error.interlock_evidence = before;
        throw error;
      }
      try {
        await updateOwnedLock(productionOwner, productionIdentity, tokenHash, productionDirectoryCapability, {
          status: "release_prepared",
        });
        await updateOwnedLock(validationOwner, validationIdentity, tokenHash, validationParent, {
          status: "release_prepared",
        });
        const prepared = await exactEvidence();
        if (!prepared.cross_reference_exact
          || prepared.production_status !== "release_prepared"
          || prepared.validation_status !== "release_prepared") {
          throw new AuditedSmokeFailure("SMOKE_LOCK_ACQUIRE_FAILED", null, "interlock release preparation is incomplete");
        }
        await unlinkOwned(validationOwner, validationIdentity, validationParent);
        await unlinkOwned(productionOwner, productionIdentity, productionDirectoryCapability);
        await assertDirectoryCapability(productionDirectoryCapability, "production supervisor lock directory");
        await fs.rmdir(productionDirectory);
        const productionParentHandle = await fs.open(productionParent.path, fsConstants.O_RDONLY);
        try { await productionParentHandle.sync(); }
        finally { await productionParentHandle.close(); }
        return Object.freeze({
          retained: false,
          released: true,
          cross_reference_exact: true,
          production_lock_present: false,
          validation_lock_present: false,
        });
      } catch (error) {
        error.interlock_evidence = await exactEvidence();
        throw error;
      }
    },
  });

  try {
    const existingProduction = await fs.lstat(productionDirectory)
      .catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    const existingValidation = await fs.lstat(validationOwner)
      .catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (existingProduction || existingValidation) {
      throw new AuditedSmokeFailure("SMOKE_LOCK_ACQUIRE_FAILED", null, "one or both interlocks already exist");
    }
    await assertDirectoryCapability(productionParent, "production supervisor lock parent");
    await fs.mkdir(productionDirectory, { mode: 0o700 });
    productionDirectoryCapability = await fixedDirectoryCapability(productionDirectory, "production supervisor lock directory");
    productionIdentity = await createLockFile(productionOwner, Object.freeze({
      contract: "ozon-audited-smoke-production-interlock-v1",
      pid: process.pid,
      started_at: acquiredAt,
      run_id: safeId,
      token_sha256: tokenHash,
      peer_lock: validationOwner,
      status: "active",
    }), productionDirectoryCapability);
    await afterProductionLock();
    validationIdentity = await createLockFile(validationOwner, Object.freeze({
      contract: "ozon-audited-smoke-validation-interlock-v1",
      pid: process.pid,
      started_at: acquiredAt,
      run_id: safeId,
      token_sha256: tokenHash,
      peer_lock: productionOwner,
      status: "active",
    }), validationParent);
  } catch (error) {
    // A partial acquisition is deliberately retained.  Its live PID prevents
    // production or another smoke from starting until an operator audits it.
    const failure = error instanceof AuditedSmokeFailure
      ? error
      : new AuditedSmokeFailure("SMOKE_LOCK_ACQUIRE_FAILED", null, "could not acquire both smoke interlocks");
    failure.interlocks = interlocks;
    failure.interlock_evidence = await exactEvidence();
    throw failure;
  }
  return interlocks;
}

export async function cleanupExactAudited9224({
  orchestratorPid = process.pid,
  processList = async () => (await execFileAsync(
    "/bin/ps",
    ["-axo", "pid=,ppid=,lstart=,command="],
  )).stdout,
  listenerPids = lsofListenerPids,
  signal = (pid, name) => process.kill(pid, name),
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  graceMs = 3_000,
} = {}) {
  const rows = parseSmokeProcessRows(await processList());
  const orchestratorStartIdentity = processStartIdentity(rows, orchestratorPid);
  if (!orchestratorStartIdentity) {
    throw new AuditedSmokeFailure(
      "SMOKE_EXACT_9224_CLEANUP_UNPROVEN",
      null,
      "cleanup could not bind the orchestrator process identity",
    );
  }
  const roots = auditedSmokeValidationRoots(rows);
  const listeners = await listenerPids(AUDITED_VALIDATION_DEBUG_PORT);
  const ownedRoots = roots.filter((root) => root.exact === true
    && auditedPidDescendsFrom(root.pid, orchestratorPid, rows)).map((root) => Object.freeze({
    pid: root.pid,
    start_identity: processStartIdentity(rows, root.pid),
  })).filter((root) => root.start_identity);
  const ownedListenerPids = listeners.filter((pid) => ownedRoots.some((root) => (
    auditedPidDescendsFrom(pid, root.pid, rows)
  )));
  let pidReuseSuppressedCount = 0;

  async function refreshExactOwnedRoot(identity) {
    const currentRows = parseSmokeProcessRows(await processList());
    const samePid = currentRows.find((row) => Number(row.pid) === Number(identity.pid));
    const orchestratorSame = processStartIdentity(currentRows, orchestratorPid) === orchestratorStartIdentity;
    const currentRoot = auditedSmokeValidationRoots(currentRows)
      .find((root) => Number(root.pid) === Number(identity.pid) && root.exact === true);
    const exact = orchestratorSame && currentRoot
      && processStartIdentity(currentRows, identity.pid) === identity.start_identity
      && auditedPidDescendsFrom(identity.pid, orchestratorPid, currentRows);
    if (!exact && samePid && String(samePid.start_identity || "") !== identity.start_identity) {
      pidReuseSuppressedCount += 1;
    }
    return exact ? Object.freeze({ rows: currentRows, root: currentRoot }) : null;
  }

  for (const root of ownedRoots) {
    if (await refreshExactOwnedRoot(root)) {
      try { signal(root.pid, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    let anyOriginalRootAlive = false;
    for (const root of ownedRoots) {
      if (await refreshExactOwnedRoot(root)) anyOriginalRootAlive = true;
    }
    if (!anyOriginalRootAlive) break;
    await delay(100);
  }
  for (const root of ownedRoots) {
    if (await refreshExactOwnedRoot(root)) {
      try { signal(root.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
    }
  }
  const finalRows = parseSmokeProcessRows(await processList());
  const finalOrchestratorIdentityExact = processStartIdentity(finalRows, orchestratorPid)
    === orchestratorStartIdentity;
  const finalRoots = auditedSmokeValidationRoots(finalRows);
  const finalListeners = await listenerPids(AUDITED_VALIDATION_DEBUG_PORT);
  return Object.freeze({
    exact_9224_cleanup_proven: finalOrchestratorIdentityExact
      && finalRoots.length === 0 && finalListeners.length === 0,
    orchestrator_identity_reverified: finalOrchestratorIdentityExact,
    owned_root_count: ownedRoots.length,
    owned_listener_count: ownedListenerPids.length,
    rogue_listener_count: Math.max(0, listeners.length - ownedListenerPids.length),
    pid_reuse_suppressed_count: pidReuseSuppressedCount,
    final_root_count: finalRoots.length,
    final_listener_count: finalListeners.length,
  });
}

function exactProductLink(link) {
  const raw = String(link?.href || "");
  try {
    const url = new URL(raw);
    const match = url.pathname.match(/^\/product\/(?:[^/?#]*-)?(\d+)\/?$/u);
    if (!match || !/^https:$/.test(url.protocol) || !/^(?:www\.)?ozon\.ru$/iu.test(url.hostname)) return null;
    return Object.freeze({ sku: match[1], product_url: `https://www.ozon.ru${url.pathname}` });
  } catch { return null; }
}

function numericStringCompare(left, right) {
  return left.length - right.length || left.localeCompare(right);
}

function observationFromSmokeDetail({ seed, sourceUrl, selected, detail, classification, binding }) {
  return {
    contract: AUDITED_DISCOVERY_SEED_OBSERVATION_CONTRACT,
    evidence_scope: AUDITED_DISCOVERY_SEED_SCOPE,
    status: "observed",
    run_id: binding.run_id,
    campaign_epoch: binding.campaign_epoch,
    activated_at: binding.activated_at,
    observed_at: detail?.observed_at,
    seed_artifact_sha256: binding.seed_artifact_sha256,
    seed_source_set_sha256: binding.seed_source_set_sha256,
    seed_id: seed.id,
    source_url: sourceUrl,
    final_source_url: sourceUrl,
    sku: selected.sku,
    product_url: selected.product_url,
    final_product_url: detail?.final_url,
    seller_url: detail?.seller_url,
    live_seller_evidence_source: detail?.seller_evidence_source,
    live_seller_widget: detail?.seller_widget,
    live_title: detail?.title,
    live_brand: detail?.brand,
    live_brand_extraction_complete: detail?.brand_extraction_complete,
    live_brand_evidence_source: detail?.brand_evidence_source,
    category_key: seed.category_key,
    accessory_role: seed.accessory_role,
    live_category_key: classification?.category_key,
    live_item_count: classification?.item_count,
    live_is_bundle: classification?.is_bundle,
    live_is_set: classification?.is_set,
    live_compatibility_scope: classification?.compatibility_scope,
    live_role_attributes: classification?.role_attributes,
    live_role_attribute_evidence: classification?.role_attribute_evidence,
    live_structured_evidence: classification?.structured_evidence,
    live_price_evidence_scope: detail?.live_price_evidence_scope,
    live_price_evidence: detail?.live_price_evidence,
  };
}

export async function runPinnedL01SinglePageBusiness({
  context,
  rateProvider,
  accessController,
  artifact,
  binding,
  recordAttempt,
  checkpoint = async () => true,
} = {}) {
  const seed = artifact?.seeds?.find((row) => row.id === "L01");
  const sourceUrl = seed?.source_urls?.[0];
  if (!seed || !sourceUrl) throw new AuditedSmokeFailure("SMOKE_OPERATION_FAILED", null, "pinned L01 page 1 is missing");
  const pinned = createPinnedAuditedSeedPlaywrightAdapter({ context, rateProvider, accessController, artifact });
  let adapterSnapshot = null;
  try {
    await checkpoint("before_source_scan");
    await recordAttempt("source_scan_requests");
    const scan = await pinned.adapter.scanSource(Object.freeze({
      source_url: sourceUrl,
      seed_id: seed.id,
      category_key: seed.category_key,
      accessory_role: seed.accessory_role,
    }));
    await checkpoint("after_source_scan");
    if (scan?.status !== "completed" || scan?.complete !== true || scan?.final_url !== sourceUrl) {
      return Object.freeze({
        outcome: "scan_incomplete",
        eligible: false,
        reason: "scan_incomplete",
        eligible_card_count: 0,
        artifact_sha256: artifact.artifact_sha256,
        source_sha256: sha256(sourceUrl),
        selected_binding_sha256: null,
      });
    }
    const eligibleLinks = (scan.links || []).flatMap((link) => {
      const exact = exactProductLink(link);
      if (!exact) return [];
      const title = auditedSeedTitleEligibility(link.title, artifact, seed.id);
      const price = auditedCardPriceEligibility(link, seed.seed_price_band_rub);
      return title.eligible && price.eligible ? [{ ...exact, title: link.title }] : [];
    }).sort((left, right) => numericStringCompare(left.sku, right.sku));
    const selected = eligibleLinks[0];
    if (!selected) return Object.freeze({
      outcome: "no_eligible_card",
      eligible: false,
      reason: "no_eligible_card",
      eligible_card_count: 0,
      artifact_sha256: artifact.artifact_sha256,
      source_sha256: sha256(sourceUrl),
      selected_binding_sha256: null,
    });
    await checkpoint("before_live_detail");
    await recordAttempt("live_detail_requests");
    const detail = await pinned.adapter.fetchProductDetail(Object.freeze({
      sku: selected.sku,
      product_url: selected.product_url,
      seed_ids: Object.freeze([seed.id]),
    }));
    await checkpoint("after_live_detail");
    const liveTitle = auditedSeedTitleEligibility(detail?.title, artifact, seed.id);
    if (!liveTitle.eligible) return Object.freeze({
      outcome: "live_title_rejected",
      eligible: false,
      reason: String(liveTitle.reason || "live_title_rejected"),
      eligible_card_count: eligibleLinks.length,
      artifact_sha256: artifact.artifact_sha256,
      source_sha256: sha256(sourceUrl),
      selected_binding_sha256: sha256(`${selected.sku}\n${selected.product_url}`),
    });
    await checkpoint("before_classification");
    await recordAttempt("classification_requests");
    const classification = await pinned.adapter.classifyProduct(Object.freeze({
      sku: selected.sku,
      product_url: selected.product_url,
      detail,
      seed,
    }));
    await checkpoint("after_classification");
    const eligibility = auditedSeedObservationEligibility(observationFromSmokeDetail({
      seed,
      sourceUrl,
      selected,
      detail,
      classification,
      binding,
    }), artifact, binding, { now: new Date() });
    return Object.freeze({
      outcome: eligibility.eligible ? "eligible" : "strict_rejected",
      eligible: eligibility.eligible === true,
      reason: eligibility.eligible ? null : String(eligibility.reason || "strict_rejected"),
      eligible_card_count: eligibleLinks.length,
      artifact_sha256: artifact.artifact_sha256,
      source_sha256: sha256(sourceUrl),
      selected_binding_sha256: sha256(`${selected.sku}\n${selected.product_url}`),
    });
  } finally {
    await pinned.close();
    adapterSnapshot = pinned.snapshot();
    if (adapterSnapshot.favorite_mutation_attempts !== 0 || adapterSnapshot.submission_attempts !== 0) {
      throw new AuditedSmokeFailure("SMOKE_MUTATION_ZERO_NOT_PROVEN", null, "adapter mutation counters are non-zero");
    }
  }
}

const DEFAULT_CRITICAL_FILES = Object.freeze({
  seed_artifact: DEFAULT_SEED_ARTIFACT,
  owned_runner: path.join(SCRIPT_DIR, "audited_validation_discovery.mjs"),
  seed_adapter: path.join(SCRIPT_DIR, "flow_b_playwright", "audited-seed-playwright-adapter.mjs"),
  seed_contract: path.join(SCRIPT_DIR, "flow_b_playwright", "audited-discovery-seed.mjs"),
  smoke_orchestrator: fileURLToPath(import.meta.url),
});

const DEFAULT_PRODUCTION_HASH_FILES = Object.freeze({
  production_config: path.join(PACKAGE_ROOT, "config", "ozon_24h_production.json"),
  production_runtime_db: "/Users/mac/.ozon-24h-production/state/runtime/flow_b_state.sqlite",
  production_runtime_db_wal: "/Users/mac/.ozon-24h-production/state/runtime/flow_b_state.sqlite-wal",
  production_runtime_db_shm: "/Users/mac/.ozon-24h-production/state/runtime/flow_b_state.sqlite-shm",
  production_source_funnel: "/Users/mac/.ozon-24h-production/state/sources/source_funnel.jsonl",
  production_operational_status: "/Users/mac/.ozon-24h-production/state/operational_status.json",
  production_chrome_stderr: "/Users/mac/.ozon-24h-production/state/chrome.stderr.log",
  production_launchd_stdout: "/Users/mac/.ozon-24h-production/state/launchd.stdout.log",
  production_interlock_owner: path.join(PRODUCTION_SUPERVISOR_LOCK_DIR, "owner.json"),
  validation_smoke_lock: AUDITED_SMOKE_OWNER_LOCK,
});

export function launchBaselineAllowed(observed, expectedMode, {
  expectedRuns,
  expectedLastExitCode,
} = {}) {
  const normalized = normalizeLaunchState(observed);
  if (expectedMode === "bootout") return normalized.mode === "bootout";
  return expectedMode === "loaded_not_running"
    && Number.isSafeInteger(expectedRuns) && expectedRuns >= 0
    && Number.isSafeInteger(expectedLastExitCode) && expectedLastExitCode >= 0
    && normalized.mode === "loaded_not_running"
    && normalized.active_count === 0
    && normalized.state === "not running"
    && normalized.runs === expectedRuns
    && normalized.last_exit_code === expectedLastExitCode;
}

function manifestDigestMap(manifest) {
  return Object.freeze({ ...(manifest || {}) });
}

export function networkMutationEvidence(owned) {
  const safety = owned?.network_safety || {};
  const heartbeatInterval = Number(safety.observer_heartbeat_interval_ms ?? -1);
  const heartbeatPings = Number(safety.observer_heartbeat_successful_pings ?? -1);
  const heartbeatNetworkRequests = Number(safety.observer_heartbeat_network_requests ?? -1);
  const heartbeatContinuous = safety.observer_heartbeat_continuous === true
    && Number.isInteger(heartbeatInterval) && heartbeatInterval >= 1 && heartbeatInterval <= 5_000
    && Number.isInteger(heartbeatPings) && heartbeatPings >= 0
    && heartbeatNetworkRequests === 0;
  const analytics = Number(safety.operational_post_observer_protected_analytics_upload_attempts_observed ?? -1);
  const allContexts = Number(
    safety.operational_post_observer_all_contexts_state_mutation_attempts_observed ?? -1,
  );
  const serviceWorker = Number(
    safety.operational_post_observer_service_worker_state_mutation_attempts_observed ?? -1,
  );
  const continuous = safety.web_request_audit_scope === "operational-post-observer"
    && safety.operational_post_observer_web_request_audit_continuous === true;
  const offlineGateProven = safety.bootstrap_host_resolver_blocked_before_dnr === true
    && safety.bootstrap_proxy_disabled === true
    && safety.bootstrap_prior_audited_rules_cleared_before_probe === true
    && safety.bootstrap_protected_read_probe_blocked_before_dnr === true
    && safety.bootstrap_persisted_full_host_lockdown === true
    && safety.bootstrap_browser_fully_stopped_before_operational_launch === true
    && safety.bootstrap_pre_observer_attempt_coverage === "offline-gate-only-no-attempt-observer"
    && safety.bootstrap_pre_observer_mutation_zero_proven === false;
  const countersComplete = analytics >= 0 && allContexts >= 0 && serviceWorker >= 0;
  return Object.freeze({
    observer_coverage: continuous ? "operational_post_observer_all_contexts_continuous" : "incomplete",
    observer_scope: "operational-post-observer",
    bootstrap_pre_observer_attempt_coverage: safety.bootstrap_pre_observer_attempt_coverage
      || "offline-gate-only-no-attempt-observer",
    offline_gate_proven: offlineGateProven,
    observer_heartbeat_interval_ms: heartbeatInterval >= 1 ? heartbeatInterval : null,
    observer_heartbeat_successful_pings: heartbeatPings >= 0 ? heartbeatPings : null,
    observer_heartbeat_continuous: heartbeatContinuous,
    observer_heartbeat_network_requests: heartbeatNetworkRequests >= 0
      ? heartbeatNetworkRequests
      : null,
    analytics_upload_attempts: analytics,
    all_contexts_state_mutation_attempts: allContexts,
    service_worker_state_mutation_attempts: serviceWorker,
    operational_post_observer_mutation_zero_proven: continuous && heartbeatContinuous && countersComplete
      && analytics === 0 && allContexts === 0 && serviceWorker === 0,
    evidence_complete: offlineGateProven && continuous && heartbeatContinuous && countersComplete,
  });
}

export function assertPassingBusinessCallShape(calls) {
  const normalized = sanitizedBusinessCalls(calls);
  const valid = normalized.source_scan_requests === 1
    && normalized.live_detail_requests <= 1
    && normalized.classification_requests <= normalized.live_detail_requests
    && normalized.favorite_mutation_attempts === 0
    && normalized.submission_attempts === 0;
  if (!valid) {
    throw new AuditedSmokeFailure(
      "SMOKE_OPERATION_FAILED",
      null,
      "business call counts do not match the one-page smoke contract",
      { operation_entered: true, business_calls: calls },
    );
  }
  return true;
}

function resultBase({
  runId,
  expectedLaunchdBaselineMode,
  expectedLaunchdRuns = null,
  expectedLaunchdLastExitCode = null,
  calls,
}) {
  return {
    run_id: runId,
    launch_baseline_mode: expectedLaunchdBaselineMode,
    launch_baseline_expected_runs: expectedLaunchdRuns ?? null,
    launch_baseline_expected_last_exit_code: expectedLaunchdLastExitCode ?? null,
    status: "failed",
    failure_code: null,
    primary_failure_code: null,
    preflight_step: null,
    audit_phase: null,
    preflight_evidence: null,
    failed_sample_seq: null,
    operation_entered: false,
    observer_coverage: "not_started",
    network_gate: "none",
    bootstrap_pre_observer_attempt_coverage: "offline-gate-only-no-attempt-observer",
    offline_gate_proven: false,
    operational_post_observer_mutation_zero_proven: false,
    observer_heartbeat_interval_ms: null,
    observer_heartbeat_successful_pings: null,
    observer_heartbeat_continuous: false,
    observer_heartbeat_network_requests: null,
    business_calls: sanitizedBusinessCalls(calls),
    analytics_upload_attempts: null,
    all_contexts_state_mutation_attempts: null,
    service_worker_state_mutation_attempts: null,
    favorite_mutation_attempts: 0,
    submission_attempts: 0,
    business_outcome: null,
    business_eligible: false,
    business_reason: null,
    eligible_card_count: 0,
    artifact_sha256: null,
    source_sha256: null,
    selected_binding_sha256: null,
    exact_9224_cleanup_proven: false,
    locks_cross_referenced: false,
    locks_retained: false,
    lock_release_state: "not_acquired",
    release_commit_sha256: null,
    production_hash_exact_except_interlocks: false,
    production_bootout_proven: false,
  };
}

export async function runAuditedSinglePageSmoke({
  runId,
  expectedLaunchdBaselineMode,
  expectedLaunchdRuns = null,
  expectedLaunchdLastExitCode = null,
  seedArtifact = DEFAULT_SEED_ARTIFACT,
  forensicRoot = AUDITED_SMOKE_FORENSIC_ROOT,
  criticalFiles = DEFAULT_CRITICAL_FILES,
  productionHashFiles = DEFAULT_PRODUCTION_HASH_FILES,
  diskFloorBytes = DEFAULT_SMOKE_DISK_FLOOR_BYTES,
  now = () => new Date(),
  dependencies = {},
} = {}) {
  const safeId = safeRunId(runId);
  if (!new Set(["bootout", "loaded_not_running"]).has(expectedLaunchdBaselineMode)) {
    throw new AuditedSmokeFailure("SMOKE_OPERATION_FAILED", null, "explicit launchd baseline mode is required");
  }
  if (expectedLaunchdBaselineMode === "loaded_not_running"
    && (!Number.isSafeInteger(expectedLaunchdRuns) || expectedLaunchdRuns < 0
      || !Number.isSafeInteger(expectedLaunchdLastExitCode) || expectedLaunchdLastExitCode < 0)) {
    throw new AuditedSmokeFailure(
      "SMOKE_OPERATION_FAILED",
      null,
      "loaded launchd baseline requires explicit non-negative runs and last exit code",
    );
  }
  if (expectedLaunchdBaselineMode === "bootout"
    && (expectedLaunchdRuns !== null || expectedLaunchdLastExitCode !== null)) {
    throw new AuditedSmokeFailure(
      "SMOKE_OPERATION_FAILED",
      null,
      "bootout launchd baseline must not include loaded-service counters",
    );
  }
  const calls = zeroBusinessCalls();
  let result = resultBase({
    runId: safeId,
    expectedLaunchdBaselineMode,
    expectedLaunchdRuns,
    expectedLaunchdLastExitCode,
    calls,
  });
  const deps = {
    createForensicRun: createAuditedSmokeForensicRun,
    hashManifest: hashNamedFiles,
    readLaunchState: readProductionLaunchdState,
    acquireInterlocks: acquireAuditedSmokeInterlocks,
    cleanupOwned9224: cleanupExactAudited9224,
    emergencyBootout: emergencyBootoutProductionLabel,
    loadArtifact: loadAuditedDiscoverySeedArtifact,
    runOwned: withAuditedValidationOwnedContext,
    runBusiness: runPinnedL01SinglePageBusiness,
    createProbe: createDefaultAuditedSmokeProbe,
    createWatcher: createAuditedSmokeWatcher,
    ownedContextDependencies: {},
    ...dependencies,
  };
  const forensic = await deps.createForensicRun({ forensicRoot, runId: safeId, now });
  let watcher = null;
  let locks = null;
  let preProductionManifest = null;
  let postProductionManifest = null;
  let cleanupEvidence = Object.freeze({ exact_9224_cleanup_proven: false });
  let productionComparison = null;
  let owned = null;
  let business = null;
  let failure = null;
  let finalDigests = null;
  let cleanupPromise = null;
  let cleanupGeneration = 0;
  let fatalContainmentPromise = null;
  let bootoutEvidence = Object.freeze({ production_bootout_proven: false });
  let launchBaseline = null;

  function ensureExact9224Cleanup({ fresh = false } = {}) {
    if (fresh || !cleanupPromise) {
      const generation = ++cleanupGeneration;
      cleanupPromise = Promise.resolve()
        .then(() => deps.cleanupOwned9224({ orchestratorPid: process.pid }))
        .then((evidence) => Object.freeze({ ...evidence, cleanup_generation: generation }));
    }
    return cleanupPromise;
  }

  function ensureFatalContainment() {
    if (!fatalContainmentPromise) {
      fatalContainmentPromise = Promise.allSettled([
        ensureExact9224Cleanup(),
        deps.emergencyBootout(),
      ]).then(([cleanupResult, bootoutResult]) => {
        cleanupEvidence = cleanupResult.status === "fulfilled"
          ? cleanupResult.value
          : Object.freeze({ exact_9224_cleanup_proven: false });
        bootoutEvidence = bootoutResult.status === "fulfilled"
          ? bootoutResult.value
          : Object.freeze({ production_bootout_proven: false });
        return Object.freeze({ cleanup: cleanupEvidence, bootout: bootoutEvidence });
      });
    }
    return fatalContainmentPromise;
  }

  try {
    await forensic.append(Object.freeze({
      contract: AUDITED_SMOKE_TIMELINE_CONTRACT,
      timestamp: isoNow(now),
      monotonic_seq: 0,
      phase: "preflight",
      state: "before_launch",
      cause: "business_calls_initialized",
      operation_entered: false,
      observer_coverage: "not_started",
      network_gate: "none",
      mutation_zero_proven: false,
      business_calls: sanitizedBusinessCalls(calls),
      decision_code: "WATCH_OK",
    }));
    preProductionManifest = await deps.hashManifest(productionHashFiles);
    const criticalManifest = await deps.hashManifest(criticalFiles);
    const criticalDigestBaseline = manifestDigestMap(criticalManifest);
    launchBaseline = normalizeLaunchState(await deps.readLaunchState());
    if (!launchBaselineAllowed(launchBaseline, expectedLaunchdBaselineMode, {
      expectedRuns: expectedLaunchdRuns,
      expectedLastExitCode: expectedLaunchdLastExitCode,
    })) {
      throw new AuditedSmokeFailure("WATCH_LAUNCH_BASELINE_CHANGED", 1, "launchd baseline does not match explicit mode", {
        business_calls: calls,
      });
    }
    const probe = dependencies.probe || deps.createProbe({
      criticalFiles,
      orchestratorPid: process.pid,
      launchState: deps.readLaunchState,
      now,
    });
    watcher = deps.createWatcher({
      writer: forensic,
      probe,
      launchBaseline,
      criticalDigestBaseline,
      businessCalls: calls,
      orchestratorPid: process.pid,
      now,
      diskFloorBytes,
      ...(dependencies.watcherOptions || {}),
      onFatal: () => ensureFatalContainment(),
    });
    await watcher.ready();
    watcher.start();
    try { locks = await deps.acquireInterlocks({ runId: safeId, now }); }
    catch (error) {
      if (error?.interlocks) locks = error.interlocks;
      throw error;
    }
    await watcher.recordAuditEvent("cross_referenced_interlocks_acquired", {
      locks_cross_referenced: locks.evidence?.cross_reference_exact === true,
    });
    const artifact = await deps.loadArtifact(seedArtifact, { now: now() });
    const activatedAt = isoNow(now);
    const binding = buildAuditedSeedBinding({
      artifact,
      runId: safeId,
      campaignEpoch: Math.max(0, Math.floor(Date.parse(activatedAt) / 1_000)),
      activatedAt,
      now: new Date(activatedAt),
    });
    owned = await deps.runOwned({
      userDataDir: AUDITED_VALIDATION_PROFILE,
      extension: AUDITED_EXTENSION_DIR,
      chromiumExecutable: AUDITED_BROWSER_EXECUTABLE,
      remoteDebuggingPort: AUDITED_VALIDATION_DEBUG_PORT,
    }, async ({ context, rateProvider, accessController }) => {
      await watcher.markOperationEntered();
      return deps.runBusiness({
        context,
        rateProvider,
        accessController,
        artifact,
        binding,
        recordAttempt: (kind) => watcher.recordBusinessAttempt(kind),
        checkpoint: (cause) => watcher.checkpoint(`business_${cause}`),
      });
    }, {
      ...deps.ownedContextDependencies,
      lifecycle: watcher.lifecycle,
    });
    business = owned.value;
    const network = networkMutationEvidence(owned);
    const favorite = Number(calls.favorite_mutation_attempts);
    const submission = Number(calls.submission_attempts);
    const mutationZero = network.evidence_complete
      && network.operational_post_observer_mutation_zero_proven === true
      && favorite === 0 && submission === 0;
    if (!network.evidence_complete) {
      throw new AuditedSmokeFailure("SMOKE_NETWORK_EVIDENCE_INCOMPLETE", watcher.sequence, "network evidence is incomplete", {
        operation_entered: watcher.operation_entered,
        business_calls: calls,
      });
    }
    if (!mutationZero) {
      throw new AuditedSmokeFailure("SMOKE_MUTATION_ZERO_NOT_PROVEN", watcher.sequence, "zero mutation was not proven", {
        operation_entered: watcher.operation_entered,
        business_calls: calls,
      });
    }
    assertPassingBusinessCallShape(calls);
    await watcher.persistEvidence("mutation_zero_evidence_joined", {
      observer_coverage: "all_contexts_continuous",
      network_gate: "dnr_default_deny_and_context_route",
      mutation_attempts_observed: 0,
      mutation_zero_proven: true,
    });
    cleanupEvidence = await ensureExact9224Cleanup({ fresh: true });
    if (cleanupEvidence.exact_9224_cleanup_proven !== true) {
      throw new AuditedSmokeFailure("SMOKE_EXACT_9224_CLEANUP_UNPROVEN", watcher.sequence, "exact 9224 cleanup is unproven", {
        operation_entered: watcher.operation_entered,
        business_calls: calls,
      });
    }
    await watcher.checkpoint("normal_exact_9224_cleanup_proven");
    await watcher.stop();
    postProductionManifest = await deps.hashManifest(productionHashFiles);
    productionComparison = compareProductionHashManifests(
      preProductionManifest,
      postProductionManifest,
      ["production_interlock_owner", "validation_smoke_lock"],
    );
    if (!productionComparison.exact_except_interlocks) {
      throw new AuditedSmokeFailure("SMOKE_PRODUCTION_HASH_CHANGED", watcher.sequence, "production files changed outside interlocks", {
        operation_entered: watcher.operation_entered,
        business_calls: calls,
      });
    }
    const finalNetwork = networkMutationEvidence(owned);
    const watch = watcher.snapshot();
    result = {
      ...result,
      status: "passed",
      failure_code: null,
      primary_failure_code: null,
      failed_sample_seq: null,
      operation_entered: watch.operation_entered,
      observer_coverage: finalNetwork.observer_coverage,
      network_gate: "dnr_default_deny_and_context_route",
      bootstrap_pre_observer_attempt_coverage:
        finalNetwork.bootstrap_pre_observer_attempt_coverage,
      offline_gate_proven: finalNetwork.offline_gate_proven,
      operational_post_observer_mutation_zero_proven:
        finalNetwork.operational_post_observer_mutation_zero_proven,
      observer_heartbeat_interval_ms: finalNetwork.observer_heartbeat_interval_ms,
      observer_heartbeat_successful_pings: finalNetwork.observer_heartbeat_successful_pings,
      observer_heartbeat_continuous: finalNetwork.observer_heartbeat_continuous,
      observer_heartbeat_network_requests: finalNetwork.observer_heartbeat_network_requests,
      business_calls: sanitizedBusinessCalls(calls),
      analytics_upload_attempts: finalNetwork.analytics_upload_attempts,
      all_contexts_state_mutation_attempts: finalNetwork.all_contexts_state_mutation_attempts,
      service_worker_state_mutation_attempts: finalNetwork.service_worker_state_mutation_attempts,
      favorite_mutation_attempts: calls.favorite_mutation_attempts,
      submission_attempts: calls.submission_attempts,
      business_outcome: String(business?.outcome || "unknown"),
      business_eligible: business?.eligible === true,
      business_reason: business?.reason === null ? null : String(business?.reason || "unknown"),
      eligible_card_count: Number(business?.eligible_card_count || 0),
      artifact_sha256: business?.artifact_sha256 || null,
      source_sha256: business?.source_sha256 || null,
      selected_binding_sha256: business?.selected_binding_sha256 || null,
      exact_9224_cleanup_proven: true,
      locks_cross_referenced: locks.evidence?.cross_reference_exact === true,
      locks_retained: true,
      lock_release_state: "pending_after_forensic_finalize",
      production_hash_exact_except_interlocks: true,
      production_bootout_proven: false,
    };
  } catch (error) {
    const preflight = sanitizedExtensionPreflightFailure(error);
    const auditFailureSeq = watcher?.snapshot?.().audit_failure_seq;
    failure = error instanceof AuditedSmokeFailure
      ? error
      : new AuditedSmokeFailure(
        preflight?.failure_code || error?.code,
        preflight && Number.isInteger(auditFailureSeq)
          ? auditFailureSeq
          : watcher?.sequence ?? null,
        "smoke operation failed",
        {
        operation_entered: watcher?.operation_entered === true,
        business_calls: calls,
        preflight_failure_code: preflight?.failure_code,
        preflight_step: preflight?.preflight_step,
        audit_phase: preflight?.audit_phase,
        preflight_evidence: preflight?.preflight_evidence,
        },
      );
    await watcher?.recordAuditEvent("fatal_containment_armed", {
      fatal_code: failure.code,
      failed_sample_seq: failure.failed_sample_seq,
    }).catch(() => {});
    const containment = await ensureFatalContainment().catch(() => Object.freeze({
      cleanup: Object.freeze({ exact_9224_cleanup_proven: false }),
      bootout: Object.freeze({ production_bootout_proven: false }),
    }));
    bootoutEvidence = containment.bootout;
    cleanupEvidence = await ensureExact9224Cleanup({ fresh: true }).catch(() => Object.freeze({
      exact_9224_cleanup_proven: false,
      cleanup_generation: cleanupGeneration,
    }));
    await watcher?.journalEmergencyCleanup({
      stopped: cleanupEvidence.exact_9224_cleanup_proven === true,
      cause: cleanupEvidence.exact_9224_cleanup_proven === true
        ? "emergency_exact_9224_stopped_proved"
        : "emergency_exact_9224_cleanup_unproven",
    }).catch(() => {});
    await watcher?.stop().catch(() => {});
    let lockEvidence = Object.freeze({ retained: false, cross_reference_exact: false });
    if (locks) {
      lockEvidence = await locks.retainFailure(
        failure.code,
        failure.failed_sample_seq,
        cleanupEvidence,
        failure.preflight_step,
        failure.audit_phase,
        failure.preflight_evidence,
      ).catch(() => Object.freeze({
        retained: false,
        cross_reference_exact: false,
        production_lock_present: null,
        validation_lock_present: null,
      }));
    }
    postProductionManifest = await deps.hashManifest(productionHashFiles).catch(() => null);
    if (preProductionManifest && postProductionManifest) {
      productionComparison = compareProductionHashManifests(
        preProductionManifest,
        postProductionManifest,
        ["production_interlock_owner", "validation_smoke_lock"],
      );
    }
    const watch = watcher?.snapshot?.() || {};
    const primaryCode = failure.code;
    const finalCode = bootoutEvidence.production_bootout_proven !== true
      ? "SMOKE_PRODUCTION_BOOTOUT_UNPROVEN"
      : cleanupEvidence.exact_9224_cleanup_proven !== true
      ? "SMOKE_EXACT_9224_CLEANUP_UNPROVEN"
      : productionComparison?.exact_except_interlocks === false
        ? "SMOKE_PRODUCTION_HASH_CHANGED"
        : primaryCode;
    const network = owned ? networkMutationEvidence(owned) : null;
    result = {
      ...result,
      status: "failed",
      failure_code: finalCode,
      primary_failure_code: finalCode === primaryCode ? null : primaryCode,
      preflight_step: failure.preflight_step,
      audit_phase: failure.audit_phase,
      preflight_evidence: failure.preflight_evidence,
      failed_sample_seq: failure.failed_sample_seq,
      operation_entered: watch.operation_entered === true || failure.operation_entered === true,
      observer_coverage: network?.observer_coverage || watch.observer_coverage || "not_started",
      network_gate: watch.network_gate || "none",
      offline_gate_proven: network?.offline_gate_proven === true
        || failure.preflight_evidence?.bootstrap_lockdown_proven === true,
      bootstrap_pre_observer_attempt_coverage: network?.bootstrap_pre_observer_attempt_coverage
        || (failure.preflight_evidence?.bootstrap_lockdown_proven === true
          ? "offline-gate-only-no-attempt-observer"
          : "not_proven"),
      operational_post_observer_mutation_zero_proven: false,
      observer_heartbeat_interval_ms: network?.observer_heartbeat_interval_ms ?? null,
      observer_heartbeat_successful_pings: network?.observer_heartbeat_successful_pings ?? null,
      observer_heartbeat_continuous: network?.observer_heartbeat_continuous === true,
      observer_heartbeat_network_requests: network?.observer_heartbeat_network_requests ?? null,
      business_calls: sanitizedBusinessCalls(calls),
      analytics_upload_attempts: network?.evidence_complete === true
        ? Math.max(0, Number(network.analytics_upload_attempts))
        : null,
      all_contexts_state_mutation_attempts: network?.evidence_complete === true
        ? Math.max(0, Number(network.all_contexts_state_mutation_attempts))
        : null,
      service_worker_state_mutation_attempts: network?.evidence_complete === true
        ? Math.max(0, Number(network.service_worker_state_mutation_attempts))
        : null,
      favorite_mutation_attempts: calls.favorite_mutation_attempts,
      submission_attempts: calls.submission_attempts,
      business_outcome: business?.outcome ? String(business.outcome) : null,
      business_eligible: business?.eligible === true,
      business_reason: business?.reason === null ? null : business?.reason ? String(business.reason) : null,
      eligible_card_count: Math.max(0, Number(business?.eligible_card_count || 0)),
      artifact_sha256: business?.artifact_sha256 || null,
      source_sha256: business?.source_sha256 || null,
      selected_binding_sha256: business?.selected_binding_sha256 || null,
      exact_9224_cleanup_proven: cleanupEvidence.exact_9224_cleanup_proven === true,
      locks_cross_referenced: lockEvidence.cross_reference_exact === true,
      locks_retained: lockEvidence.retained === true,
      lock_release_state: lockEvidence.retained === true
        ? "retained_after_failure"
        : "failure_retention_unproven",
      production_hash_exact_except_interlocks: productionComparison?.exact_except_interlocks === true,
      production_bootout_proven: bootoutEvidence.production_bootout_proven === true,
    };
  } finally {
    const finalInterlockEvidence = locks?.exactEvidence
      ? await locks.exactEvidence().catch(() => Object.freeze({
        cross_reference_exact: false,
        retained: false,
        evidence_unavailable: true,
      }))
      : locks?.evidence || null;
    const productionManifest = Object.freeze({
      before: preProductionManifest,
      after: postProductionManifest,
      comparison: productionComparison,
      cleanup: cleanupEvidence,
      production_bootout: bootoutEvidence,
      interlocks: finalInterlockEvidence,
    });
    try {
      finalDigests = await forensic.finalize(Object.freeze(result), productionManifest);
    } catch (error) {
      const forensicFailure = error instanceof AuditedSmokeFailure
        ? error
        : new AuditedSmokeFailure(
          "WATCH_FORENSIC_PERSISTENCE_FAILED",
          watcher?.sequence ?? null,
          "forensic result finalization failed",
          { operation_entered: watcher?.operation_entered === true, business_calls: calls },
        );
      const containment = await ensureFatalContainment().catch(() => Object.freeze({
        cleanup: Object.freeze({ exact_9224_cleanup_proven: false }),
        bootout: Object.freeze({ production_bootout_proven: false }),
      }));
      const finalCleanup = await ensureExact9224Cleanup({ fresh: true }).catch(() => Object.freeze({
        exact_9224_cleanup_proven: false,
        cleanup_generation: cleanupGeneration,
      }));
      if (locks) {
        forensicFailure.interlock_evidence = await locks.retainFailure(
          forensicFailure.code,
          forensicFailure.failed_sample_seq,
          finalCleanup,
          forensicFailure.preflight_step,
          forensicFailure.audit_phase,
          forensicFailure.preflight_evidence,
        ).catch(() => Object.freeze({ retained: false, cross_reference_exact: false }));
      }
      throw forensicFailure;
    }
  }

  if (result.status !== "passed") return Object.freeze({ ...result, ...finalDigests });

  try {
    const launchBeforeRelease = normalizeLaunchState(await deps.readLaunchState());
    if (!launchStateMatches(launchBaseline, launchBeforeRelease)) {
      throw new AuditedSmokeFailure(
        "WATCH_LAUNCH_BASELINE_CHANGED",
        watcher?.sequence ?? null,
        "launchd baseline changed before lock release",
        { operation_entered: watcher?.operation_entered === true, business_calls: calls },
      );
    }
    const releaseEvidence = await locks.releaseSuccess();
    const launchAfterRelease = normalizeLaunchState(await deps.readLaunchState());
    if (!launchStateMatches(launchBaseline, launchAfterRelease)) {
      throw new AuditedSmokeFailure(
        "WATCH_LAUNCH_BASELINE_CHANGED",
        watcher?.sequence ?? null,
        "launchd baseline changed after lock release",
        { operation_entered: watcher?.operation_entered === true, business_calls: calls },
      );
    }
    if (typeof forensic.commitRelease !== "function") {
      throw new AuditedSmokeFailure(
        "WATCH_FORENSIC_PERSISTENCE_FAILED",
        watcher?.sequence ?? null,
        "forensic lock-release commit capability is missing",
        { operation_entered: watcher?.operation_entered === true, business_calls: calls },
      );
    }
    const releaseDigests = await forensic.commitRelease(Object.freeze({
      status: "released",
      locks_released: releaseEvidence?.released === true,
      production_lock_present: releaseEvidence?.production_lock_present === true,
      validation_lock_present: releaseEvidence?.validation_lock_present === true,
      launch_before_release: launchBeforeRelease,
      launch_after_release: launchAfterRelease,
    }));
    return Object.freeze({
      ...result,
      ...finalDigests,
      ...releaseDigests,
      locks_retained: false,
      lock_release_state: "released_after_forensic_finalize",
    });
  } catch (error) {
    const releaseFailure = error instanceof AuditedSmokeFailure
      ? error
      : new AuditedSmokeFailure(
        "SMOKE_LOCK_ACQUIRE_FAILED",
        watcher?.sequence ?? null,
        "audited interlock release failed",
        { operation_entered: watcher?.operation_entered === true, business_calls: calls },
      );
    const containment = await ensureFatalContainment().catch(() => Object.freeze({
      cleanup: Object.freeze({ exact_9224_cleanup_proven: false }),
      bootout: Object.freeze({ production_bootout_proven: false }),
    }));
    const finalCleanup = await ensureExact9224Cleanup({ fresh: true }).catch(() => Object.freeze({
      exact_9224_cleanup_proven: false,
      cleanup_generation: cleanupGeneration,
    }));
    const lockEvidence = await locks.retainFailure(
      releaseFailure.code,
      releaseFailure.failed_sample_seq,
      finalCleanup,
      releaseFailure.preflight_step,
      releaseFailure.audit_phase,
      releaseFailure.preflight_evidence,
    ).catch(() => Object.freeze({ retained: false, cross_reference_exact: false }));
    const failedRelease = Object.freeze({
      ...result,
      status: "failed",
      failure_code: releaseFailure.code,
      primary_failure_code: null,
      failed_sample_seq: releaseFailure.failed_sample_seq,
      locks_cross_referenced: lockEvidence.cross_reference_exact === true,
      locks_retained: lockEvidence.retained === true,
      lock_release_state: lockEvidence.retained === true
        ? "retained_after_release_failure"
        : "release_failure_retention_unproven",
      production_bootout_proven: containment.bootout.production_bootout_proven === true,
      exact_9224_cleanup_proven: finalCleanup.exact_9224_cleanup_proven === true,
    });
    const releaseDigests = typeof forensic.commitRelease === "function"
      ? await forensic.commitRelease(Object.freeze({
        status: "failed",
        failure_code: releaseFailure.code,
        locks_retained: lockEvidence.retained === true,
        locks_cross_referenced: lockEvidence.cross_reference_exact === true,
        production_bootout_proven: containment.bootout.production_bootout_proven === true,
      })).catch(() => Object.freeze({ release_commit_sha256: null }))
      : Object.freeze({ release_commit_sha256: null });
    return Object.freeze({ ...failedRelease, ...finalDigests, ...releaseDigests });
  }
}

export function parseAuditedSinglePageSmokeArgs(argv = []) {
  const values = {};
  const seen = new Set();
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") { execute = true; continue; }
    if (!["--run-id", "--launchd-baseline", "--launchd-runs", "--launchd-last-exit-code"].includes(argument)) {
      throw new AuditedSmokeFailure("SMOKE_OPERATION_FAILED", null, "unsupported smoke argument");
    }
    if (!argv[index + 1] || argv[index + 1].startsWith("--")) {
      throw new AuditedSmokeFailure("SMOKE_OPERATION_FAILED", null, "smoke argument requires a value");
    }
    const name = argument.slice(2);
    if (seen.has(name)) {
      throw new AuditedSmokeFailure("SMOKE_OPERATION_FAILED", null, "duplicate smoke argument");
    }
    seen.add(name);
    values[name] = argv[++index];
  }
  const parseNonNegativeInteger = (name) => {
    if (values[name] === undefined) return null;
    if (!/^(?:0|[1-9]\d*)$/u.test(values[name])) {
      throw new AuditedSmokeFailure("SMOKE_OPERATION_FAILED", null, `${name} must be a non-negative integer`);
    }
    const parsed = Number(values[name]);
    if (!Number.isSafeInteger(parsed)) {
      throw new AuditedSmokeFailure("SMOKE_OPERATION_FAILED", null, `${name} must be a safe integer`);
    }
    return parsed;
  };
  return Object.freeze({
    execute,
    runId: values["run-id"] || "",
    launchdBaseline: values["launchd-baseline"] || "",
    launchdRuns: parseNonNegativeInteger("launchd-runs"),
    launchdLastExitCode: parseNonNegativeInteger("launchd-last-exit-code"),
  });
}

export async function runAuditedSinglePageSmokeCli(argv = process.argv.slice(2)) {
  const parsed = parseAuditedSinglePageSmokeArgs(argv);
  if (!parsed.execute) return Object.freeze({
    contract: AUDITED_SINGLE_PAGE_SMOKE_CONTRACT,
    status: "not_executed",
    execution_requires_explicit_flag: true,
  });
  return runAuditedSinglePageSmoke({
    runId: parsed.runId,
    expectedLaunchdBaselineMode: parsed.launchdBaseline,
    expectedLaunchdRuns: parsed.launchdRuns,
    expectedLaunchdLastExitCode: parsed.launchdLastExitCode,
  });
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runAuditedSinglePageSmokeCli().then((output) => {
    process.stdout.write(`${JSON.stringify(output)}\n`);
    if (output.status === "failed") process.exitCode = 1;
  }).catch((error) => {
    const output = Object.freeze({
      contract: AUDITED_SINGLE_PAGE_SMOKE_CONTRACT,
      status: "failed",
      failure_code: AUDITED_SMOKE_DECISION_CODES.includes(error?.code)
        ? error.code
        : "SMOKE_OPERATION_FAILED",
      preflight_step: sanitizedExtensionPreflightFailure(error)?.preflight_step || null,
      audit_phase: sanitizedExtensionPreflightFailure(error)?.audit_phase || null,
      failed_sample_seq: Number.isInteger(error?.failed_sample_seq) ? error.failed_sample_seq : null,
      operation_entered: error?.operation_entered === true,
      business_calls: sanitizedBusinessCalls(error?.business_calls),
    });
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = 1;
  });
}
