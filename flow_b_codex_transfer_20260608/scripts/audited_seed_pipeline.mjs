#!/usr/bin/env node

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUDITED_CURRENT_PRICE_MAX_AGE_MS,
  AUDITED_DERIVED_CAPACITY_OBSERVATION_CONTRACT,
  AUDITED_DERIVED_CAPACITY_SCAN_CHECKPOINT_CONTRACT,
  AUDITED_DERIVED_CAPACITY_DETAIL_CHECKPOINT_CONTRACT,
  AUDITED_DISCOVERY_SEED_DETAIL_CHECKPOINT_CONTRACT,
  AUDITED_DISCOVERY_SEED_OBSERVATION_CONTRACT,
  AUDITED_DISCOVERY_SEED_SCAN_CHECKPOINT_CONTRACT,
  attestAuditedDerivedCapacity,
  buildAuditedDerivedCapacityBinding,
  buildAuditedSeedBinding,
  compileAuditedDerivedSellerPortfolio,
  loadAuditedDiscoverySeedArtifact,
  promoteAuditedDerivedSellerPortfolio,
  runAuditedDerivedCapacityProbe,
  runAuditedSeedObservationDiscovery,
} from "./flow_b_playwright/audited-discovery-seed.mjs";
import { createPinnedAuditedSeedPlaywrightAdapter } from "./flow_b_playwright/audited-seed-playwright-adapter.mjs";
import {
  AUDITED_BROWSER_EXECUTABLE,
  AUDITED_EXTENSION_DIR,
  AUDITED_EXTENSION_OBSERVER_HEARTBEAT_INTERVAL_MS,
  AUDITED_VALIDATION_DEBUG_PORT,
  AUDITED_VALIDATION_PROFILE,
  AUDITED_VALIDATION_ROOT,
  withAuditedValidationOwnedContext,
} from "./audited_validation_discovery.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_ARTIFACT = path.join(PACKAGE_ROOT, "config", "ozon_audited_discovery_seeds.json");
const MODES = new Set(["all", "verify-artifact"]);
const ALL_OPTIONS = new Set(["artifact", "run-id", "seed-epoch", "capacity-epoch", "activated-at"]);
const VERIFY_OPTIONS = new Set(["artifact"]);

export const AUDITED_SEED_CAMPAIGNS_ROOT = path.join(AUDITED_VALIDATION_ROOT, "campaigns");
export const AUDITED_DERIVED_CAPACITY_ACTIVATION_CONTRACT = "ozon-audited-derived-capacity-activation-v1";

function cliError(message) {
  return new Error(`audited seed pipeline: ${message}`);
}

export class AuditedSeedPipelineNotReadyError extends Error {
  constructor(result) {
    super(`audited seed pipeline: ${result.status}`);
    this.name = "AuditedSeedPipelineNotReadyError";
    this.code = "AUDITED_SEED_PIPELINE_NOT_READY";
    this.result = result;
  }
}

function usage() {
  return [
    "Usage:",
    "  node scripts/audited_seed_pipeline.mjs verify-artifact [--artifact FILE]",
    "  node scripts/audited_seed_pipeline.mjs all --run-id ID --seed-epoch N --capacity-epoch N",
    "    --activated-at ISO [--artifact FILE]",
    "",
    `Campaign output is fixed beneath ${AUDITED_SEED_CAMPAIGNS_ROOT}.`,
    "The command uses only the pinned audited profile, extension, Chrome, port 9224,",
    "owned-context lifecycle, and default-deny mutation firewall. Production must be",
    "STOPPED and port 9223 free. No adapter module or output directory is configurable.",
  ].join("\n");
}

function safeRunId(value) {
  const runId = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/iu.test(runId)
    || runId === "." || runId === ".." || runId.includes("..")) {
    throw cliError("run-id must be a safe 1-96 character campaign directory name");
  }
  return runId;
}

export function parseAuditedSeedPipelineArgs(argv = []) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const mode = String(args.shift() || "");
  if (!MODES.has(mode)) throw cliError("mode must be all or verify-artifact");
  const allowed = mode === "all" ? ALL_OPTIONS : VERIFY_OPTIONS;
  const values = {};
  while (args.length > 0) {
    const key = args.shift();
    if (!key?.startsWith("--")) throw cliError(`unexpected argument ${key}`);
    const name = key.slice(2);
    if (!allowed.has(name)) throw cliError(`${key} is not supported in ${mode} mode`);
    if (Object.hasOwn(values, name)) throw cliError(`${key} may be specified only once`);
    if (args.length === 0 || args[0].startsWith("--")) throw cliError(`${key} requires a value`);
    values[name] = args.shift();
  }
  const parsed = {
    help: false,
    mode,
    artifact: path.resolve(values.artifact || DEFAULT_ARTIFACT),
    runId: mode === "all" ? safeRunId(values["run-id"]) : "",
    seedEpoch: Number(values["seed-epoch"]),
    capacityEpoch: Number(values["capacity-epoch"]),
    activatedAt: values["activated-at"] || "",
  };
  if (mode === "all") {
    if (!Number.isInteger(parsed.seedEpoch) || parsed.seedEpoch < 0
      || !Number.isInteger(parsed.capacityEpoch) || parsed.capacityEpoch < 0
      || !parsed.activatedAt || !Number.isFinite(Date.parse(parsed.activatedAt))) {
      throw cliError("all requires non-negative seed/capacity epochs and a valid activated-at timestamp");
    }
    if (parsed.capacityEpoch === parsed.seedEpoch) throw cliError("seed and capacity epochs must be distinct");
  }
  return parsed;
}

async function assertOutputParent(filename, guard) {
  if (!guard || !guard.files.has(filename) || path.dirname(filename) !== guard.directory) {
    throw cliError("output file is outside the bound campaign directory capability");
  }
  const parentLstat = await fs.lstat(guard.directory);
  const parentStat = await fs.stat(guard.directory);
  const parentReal = await fs.realpath(guard.directory);
  if (parentLstat.isSymbolicLink() || !parentLstat.isDirectory()
    || parentReal !== guard.directory
    || parentStat.dev !== guard.device || parentStat.ino !== guard.inode) {
    throw cliError("campaign directory identity changed after startup");
  }
}

async function assertRegularSingleLinkHandle(handle, label) {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1) {
    throw cliError(`${label} must be a regular file with exactly one hard link`);
  }
  return stat;
}

async function readOutputText(filename, guard) {
  await assertOutputParent(filename, guard);
  let handle;
  try {
    handle = await fs.open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    await assertOutputParent(filename, guard);
    await assertRegularSingleLinkHandle(handle, "pipeline input/output log");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function readJsonLines(filename, guard) {
  let text;
  text = await readOutputText(filename, guard);
  if (text === null) return [];
  return text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw cliError(`${filename}:${index + 1} is invalid JSON: ${error.message}`); }
  });
}

async function readContractJsonLines(filename, contract, label, guard) {
  const rows = await readJsonLines(filename, guard);
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]?.contract !== contract) {
      throw cliError(`${label} ${filename}:${index + 1} has foreign or missing contract`);
    }
  }
  return rows;
}

async function appendJsonLine(filename, row, guard) {
  await assertOutputParent(filename, guard);
  const handle = await fs.open(
    filename,
    fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    await assertOutputParent(filename, guard);
    await assertRegularSingleLinkHandle(handle, "pipeline append target");
    await handle.write(`${JSON.stringify(row)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function rejectSymbolicFile(filename, label) {
  try {
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw cliError(`${label} must be a regular non-symlink file with exactly one hard link`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writeJsonAtomic(filename, value, guard) {
  await assertOutputParent(filename, guard);
  await rejectSymbolicFile(filename, "pipeline output");
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await fs.open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      await assertOutputParent(filename, guard);
      await assertRegularSingleLinkHandle(handle, "pipeline temporary output");
      await handle.write(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertOutputParent(filename, guard);
    try {
      const existing = await fs.lstat(filename);
      if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
        throw cliError("pipeline output leaf changed or became hard-linked before rename");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.rename(temporary, filename);
    await assertOutputParent(filename, guard);
    const finalHandle = await fs.open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    try { await assertRegularSingleLinkHandle(finalHandle, "pipeline final output"); }
    finally { await finalHandle.close(); }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function readJsonOptional(filename, label, guard) {
  const text = await readOutputText(filename, guard);
  if (text === null) return null;
  try { return JSON.parse(text); }
  catch (error) { throw cliError(`${label} is invalid JSON: ${error.message}`); }
}

function withinDirectory(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function fixedCampaignRootRealpath(campaignRoot, { allowTestRoot = false } = {}) {
  const requestedRoot = path.resolve(campaignRoot);
  if (allowTestRoot) {
    const stat = await fs.lstat(requestedRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw cliError("test campaign root must be a real directory");
    return fs.realpath(requestedRoot);
  }
  const lexicalValidationRoot = path.resolve(AUDITED_VALIDATION_ROOT);
  const lexicalCampaignRoot = path.join(lexicalValidationRoot, "campaigns");
  if (requestedRoot !== lexicalCampaignRoot) throw cliError("campaign root must equal the pinned audited validation root");
  try {
    const rootStat = await fs.lstat(lexicalValidationRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw cliError("pinned audited validation root must be a real directory, never a symlink");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(lexicalValidationRoot, { mode: 0o700 });
  }
  const validationReal = await fs.realpath(lexicalValidationRoot);
  if (validationReal !== lexicalValidationRoot) {
    throw cliError("pinned audited validation root realpath differs from its fixed lexical path");
  }
  try {
    const campaignStat = await fs.lstat(lexicalCampaignRoot);
    if (campaignStat.isSymbolicLink() || !campaignStat.isDirectory()) {
      throw cliError("pinned campaigns root must be a real directory, never a symlink");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(lexicalCampaignRoot, { mode: 0o700 });
  }
  const campaignReal = await fs.realpath(lexicalCampaignRoot);
  if (campaignReal !== lexicalCampaignRoot) {
    throw cliError("pinned campaigns root realpath differs from its fixed lexical path");
  }
  try {
    const productionReal = await fs.realpath("/Users/mac/.ozon-24h-production");
    if (campaignReal === productionReal
      || withinDirectory(productionReal, campaignReal)
      || withinDirectory(campaignReal, productionReal)) {
      throw cliError("audited campaign root overlaps the production root");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return campaignReal;
}

async function prepareCampaignFiles({ campaignRoot, runId, artifactFile, allowTestRoot = false }) {
  const requestedRoot = path.resolve(campaignRoot);
  const rootReal = await fixedCampaignRootRealpath(requestedRoot, { allowTestRoot });
  const artifactReal = await fs.realpath(artifactFile);
  if (artifactReal === rootReal || withinDirectory(rootReal, artifactReal)) {
    throw cliError("the seed artifact input must be outside the dedicated campaign output root");
  }
  const requestedCampaign = path.join(rootReal, runId);
  if (path.dirname(requestedCampaign) !== rootReal) throw cliError("campaign output escaped the dedicated root");
  try {
    const existing = await fs.lstat(requestedCampaign);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw cliError("campaign output must be a real directory, never a symlink");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(requestedCampaign, { mode: 0o700 });
  }
  const campaignReal = await fs.realpath(requestedCampaign);
  if (path.dirname(campaignReal) !== rootReal) throw cliError("campaign output realpath escaped the dedicated root");
  await fs.chmod(campaignReal, 0o700);
  const campaignLstat = await fs.lstat(campaignReal);
  const campaignStat = await fs.stat(campaignReal);
  if (campaignLstat.isSymbolicLink() || !campaignLstat.isDirectory()) {
    throw cliError("campaign output must remain a real directory after creation");
  }
  const files = Object.freeze({
    seedScans: path.join(campaignReal, "seed_source_checkpoints.jsonl"),
    seedDetails: path.join(campaignReal, "seed_detail_checkpoints.jsonl"),
    seedObservations: path.join(campaignReal, "seed_observations.jsonl"),
    derived: path.join(campaignReal, "derived_seller_portfolio.json"),
    capacityActivation: path.join(campaignReal, "capacity_activation.json"),
    capacityScans: path.join(campaignReal, "capacity_source_checkpoints.jsonl"),
    capacityDetails: path.join(campaignReal, "capacity_detail_checkpoints.jsonl"),
    capacityObservations: path.join(campaignReal, "capacity_observations.jsonl"),
    attestation: path.join(campaignReal, "capacity_attestation.json"),
    promoted: path.join(campaignReal, "derived_validation_ready.json"),
    result: path.join(campaignReal, "pipeline_result.json"),
  });
  if (new Set(Object.values(files)).size !== Object.keys(files).length) {
    throw cliError("campaign input/output paths are not mutually exclusive");
  }
  const artifactStat = await fs.stat(artifactReal);
  for (const [name, filename] of Object.entries(files)) {
    if (path.dirname(filename) !== campaignReal) throw cliError(`${name} output escaped the campaign directory`);
    try {
      const outputLstat = await fs.lstat(filename);
      if (outputLstat.isSymbolicLink() || !outputLstat.isFile()) {
        throw cliError(`${name} output must be a regular non-symlink file`);
      }
      const outputStat = await fs.stat(filename);
      if (outputStat.nlink !== 1) {
        throw cliError(`${name} output must have exactly one hard link`);
      }
      if (outputStat.dev === artifactStat.dev && outputStat.ino === artifactStat.ino) {
        throw cliError(`${name} output aliases the seed artifact input`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const outputGuard = Object.freeze({
    directory: campaignReal,
    device: campaignStat.dev,
    inode: campaignStat.ino,
    files: new Set(Object.values(files)),
  });
  return Object.freeze({ campaignDirectory: campaignReal, files, outputGuard });
}

function assertOwnedValidationEnvironment(env) {
  if (!env || env.FLOW_B_VALIDATION_ONLY !== "1"
    || env.FLOW_B_AUDITED_DISCOVERY_ONLY !== "1"
    || env.FLOW_B_AUDITED_DISCOVERY_OWNED_CONTEXT !== "1"
    || env.FLOW_B_DIRECT_PUBLISH !== "0"
    || env.FLOW_B_MAOZI_AUTOFAVORITE !== "0"
    || env.FLOW_B_CDP_ENDPOINT !== ""
    || Object.keys(env).some((key) => key.startsWith("OZON_24H_"))) {
    throw cliError("owned runner did not provide the sanitized validation-only environment");
  }
  return env;
}

function validateManagedAdapterHandle(value) {
  if (!value || typeof value !== "object" || !value.adapter
    || typeof value.close !== "function" || typeof value.snapshot !== "function") {
    throw cliError("pinned adapter factory must return a managed adapter, close, and snapshot handle");
  }
  return value;
}

function firewallCounters(snapshot, adapterSnapshot, networkSafety) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || snapshot.observation_scope !== "playwright-context-route-does-not-cover-service-worker"
    || !snapshot.by_method_path || typeof snapshot.by_method_path !== "object"
    || !snapshot.context_route_blocked_by_mutation_kind
    || typeof snapshot.context_route_blocked_by_mutation_kind !== "object"
    || !snapshot.all_contexts_protected_attempts_by_kind
    || typeof snapshot.all_contexts_protected_attempts_by_kind !== "object") {
    throw cliError("owned runner did not return verifiable context-route firewall counters");
  }
  if (!networkSafety || typeof networkSafety !== "object" || Array.isArray(networkSafety)
    || networkSafety.contract !== "ozon-audited-validation-network-safety-v1"
    || networkSafety.bootstrap_contract !== "ozon-audited-validation-bootstrap-lockdown-v1"
    || networkSafety.bootstrap_host_resolver_blocked_before_dnr !== true
    || networkSafety.bootstrap_prior_audited_rules_cleared_before_probe !== true
    || networkSafety.bootstrap_protected_read_probe_blocked_before_dnr !== true
    || networkSafety.bootstrap_proxy_disabled !== true
    || networkSafety.bootstrap_persisted_full_host_lockdown !== true
    || networkSafety.bootstrap_browser_fully_stopped_before_operational_launch !== true
    || !/^[a-f0-9]{64}$/u.test(String(networkSafety.bootstrap_lockdown_rule_sha256 || ""))
    || networkSafety.operational_preflight_observed_persisted_lockdown !== true
    || !/^[a-f0-9]{64}$/u.test(String(networkSafety.dnr_rule_set_sha256 || ""))
    || networkSafety.dnr_rules_exact_at_start_and_end !== true
    || networkSafety.dnr_no_conflicting_dynamic_or_session_overrides_at_start_and_end !== true
    || networkSafety.check_data_service_worker_smoke_blocked_at_start_and_end !== true
    || networkSafety.dnr_all_protected_maozi_path_smokes_blocked_at_start_and_end !== true
    || networkSafety.dnr_http_maozi_path_smokes_blocked_at_start_and_end !== true
    || networkSafety.dnr_ambiguous_maozi_path_smokes_blocked_at_start_and_end !== true
    || networkSafety.dnr_pinned_safe_rule_9001_audited_at_start_and_end !== true
    || networkSafety.sku3_post_read_smoke_ok_at_start_and_end !== true
    || networkSafety.web_request_audit_continuous !== true
    || networkSafety.observer_heartbeat_continuous !== true
    || !Number.isInteger(networkSafety.observer_heartbeat_interval_ms)
    || networkSafety.observer_heartbeat_interval_ms < 1
    || networkSafety.observer_heartbeat_interval_ms > AUDITED_EXTENSION_OBSERVER_HEARTBEAT_INTERVAL_MS
    || !Number.isInteger(networkSafety.observer_heartbeat_successful_pings)
    || networkSafety.observer_heartbeat_successful_pings < 0
    || networkSafety.observer_heartbeat_network_requests !== 0
    || networkSafety.protected_mutation_requests_allowed_outbound !== false
    || !networkSafety.all_contexts_protected_attempts_by_kind
    || typeof networkSafety.all_contexts_protected_attempts_by_kind !== "object") {
    throw cliError("owned runner did not return complete DNR and all-context network safety evidence");
  }
  if (networkSafety.dnr_match_telemetry_available === true) {
    if (!networkSafety.dnr_matched_rule_count_deltas
      || typeof networkSafety.dnr_matched_rule_count_deltas !== "object") {
      throw cliError("owned runner DNR match telemetry is incomplete");
    }
  } else if (networkSafety.dnr_match_telemetry_available !== false
    || typeof networkSafety.dnr_match_telemetry_unavailable_reason !== "string"
    || networkSafety.dnr_match_telemetry_unavailable_reason.trim() === "") {
    throw cliError("owned runner DNR match telemetry status is invalid");
  }
  const blockedRequests = Number(snapshot.blocked_requests);
  const contextRouteMutationAttempts = Number(snapshot.context_route_blocked_mutation_attempts);
  const serviceWorkerMutationAttempts = Number(networkSafety.service_worker_state_mutation_attempts_observed);
  const allContextsMutationAttempts = Number(networkSafety.all_contexts_state_mutation_attempts_observed);
  const analyticsUploadAttempts = Number(networkSafety.protected_analytics_upload_attempts_observed);
  const routeByKind = snapshot.context_route_blocked_by_mutation_kind;
  const networkByKind = networkSafety.all_contexts_protected_attempts_by_kind;
  const kindCount = (counts, kind) => Number(counts[kind] || 0);
  const favoriteMutationAttempts = kindCount(networkByKind, "favorite")
    + kindCount(networkByKind, "collect");
  const networkSubmissionAttempts = Object.entries(networkByKind).reduce((total, [kind, count]) => (
    ["favorite", "collect", "analytics-upload"].includes(kind) ? total : total + Number(count || 0)
  ), 0);
  const adapterFavoriteAttempts = Number(adapterSnapshot?.favorite_mutation_attempts);
  const adapterSubmissionAttempts = Number(adapterSnapshot?.submission_attempts);
  for (const [label, value] of Object.entries({
    blockedRequests,
    contextRouteMutationAttempts,
    serviceWorkerMutationAttempts,
    allContextsMutationAttempts,
    analyticsUploadAttempts,
    favoriteMutationAttempts,
    networkSubmissionAttempts,
    adapterFavoriteAttempts,
    adapterSubmissionAttempts,
  })) {
    if (!Number.isInteger(value) || value < 0) throw cliError(`${label} counter is invalid`);
  }
  const result = Object.freeze({
    blocked_mutation_attempts: allContextsMutationAttempts + analyticsUploadAttempts,
    context_route_blocked_mutation_attempts: contextRouteMutationAttempts,
    service_worker_mutation_attempts: serviceWorkerMutationAttempts,
    all_contexts_mutation_attempts: allContextsMutationAttempts,
    favorite_mutation_attempts: favoriteMutationAttempts + adapterFavoriteAttempts,
    submission_attempts: networkSubmissionAttempts + adapterSubmissionAttempts,
    request_firewall: snapshot,
    network_safety: networkSafety,
    adapter: adapterSnapshot,
  });
  const networkStateMutationAttempts = Object.entries(networkByKind).reduce((sum, [kind, value]) => (
    kind === "analytics-upload" ? sum : sum + Number(value || 0)
  ), 0);
  if (contextRouteMutationAttempts !== Object.values(routeByKind).reduce((sum, value) => sum + Number(value || 0), 0)
    || allContextsMutationAttempts < contextRouteMutationAttempts + serviceWorkerMutationAttempts
    || allContextsMutationAttempts !== networkStateMutationAttempts
    || analyticsUploadAttempts !== Number(networkByKind["analytics-upload"] || 0)
    || Number(snapshot.service_worker_mutation_attempts_observed) !== serviceWorkerMutationAttempts
    || Number(snapshot.all_contexts_mutation_attempts_observed) !== allContextsMutationAttempts
    || Number(snapshot.protected_analytics_upload_attempts_observed) !== analyticsUploadAttempts
    || JSON.stringify(snapshot.all_contexts_protected_attempts_by_kind) !== JSON.stringify(networkByKind)) {
    throw cliError("firewall mutation counters are internally inconsistent or incomplete");
  }
  if (result.blocked_mutation_attempts !== 0
    || result.favorite_mutation_attempts !== 0
    || result.submission_attempts !== 0) {
    throw cliError("a mutation, favorite, or submission attempt reached the audited firewall");
  }
  return result;
}

function maximumBoundTime(activatedAt, rows) {
  return new Date(Math.max(
    Date.parse(activatedAt),
    ...(rows || []).map((row) => Date.parse(row?.observed_at)).filter(Number.isFinite),
  ));
}

async function createOrLoadCapacityActivation({ filename, compiled, options, now, outputGuard }) {
  const expected = {
    contract: AUDITED_DERIVED_CAPACITY_ACTIVATION_CONTRACT,
    schema_version: 1,
    deployment_phase: "validation_only",
    automatic_publish_eligible: false,
    run_id: `${options.runId}-capacity`,
    campaign_epoch: options.capacityEpoch,
    derived_artifact_sha256: compiled.artifact_sha256,
    source_set_sha256: compiled.artifact.source_set_sha256,
  };
  const existing = await readJsonOptional(filename, "capacity activation manifest", outputGuard);
  if (existing) {
    for (const [key, value] of Object.entries(expected)) {
      if (existing[key] !== value) throw cliError(`capacity activation manifest ${key} mismatch`);
    }
    const activated = Date.parse(String(existing.activated_at || ""));
    if (!Number.isFinite(activated) || activated > now.getTime()) {
      throw cliError("capacity activation manifest activated_at is invalid or future");
    }
    return Object.freeze(existing);
  }
  const manifest = Object.freeze({ ...expected, activated_at: now.toISOString() });
  await writeJsonAtomic(filename, manifest, outputGuard);
  return manifest;
}

async function executePipelineInsideOwnedContext({
  options,
  artifact,
  files,
  outputGuard,
  runtime,
  deps,
  seedBinding,
}) {
  assertOwnedValidationEnvironment(runtime.env);
  const managed = validateManagedAdapterHandle(await deps.createPinnedAdapter(Object.freeze({
    context: runtime.context,
    rateProvider: runtime.rateProvider,
    accessController: runtime.accessController,
    artifact,
  })));
  let operationError = null;
  try {
    const seedRows = await readContractJsonLines(
      files.seedObservations,
      AUDITED_DISCOVERY_SEED_OBSERVATION_CONTRACT,
      "seed observation log",
      outputGuard,
    );
    const seedScans = await readContractJsonLines(
      files.seedScans,
      AUDITED_DISCOVERY_SEED_SCAN_CHECKPOINT_CONTRACT,
      "seed source checkpoint log",
      outputGuard,
    );
    const seedDetails = await readContractJsonLines(
      files.seedDetails,
      AUDITED_DISCOVERY_SEED_DETAIL_CHECKPOINT_CONTRACT,
      "seed detail checkpoint log",
      outputGuard,
    );
    const seedDiscovery = await deps.runSeedDiscovery({
      seedArtifact: artifact,
      seedBinding,
      adapter: managed.adapter,
      resumeScans: seedScans,
      resumeObservations: seedRows,
      resumeDetails: seedDetails,
      now: deps.now,
      onObservation: (row) => appendJsonLine(files.seedObservations, row, outputGuard),
      onCheckpoint: (row) => {
        if (row?.contract === AUDITED_DISCOVERY_SEED_SCAN_CHECKPOINT_CONTRACT) {
          return appendJsonLine(files.seedScans, row, outputGuard);
        }
        if (row?.contract === AUDITED_DISCOVERY_SEED_DETAIL_CHECKPOINT_CONTRACT) {
          return appendJsonLine(files.seedDetails, row, outputGuard);
        }
        throw cliError("seed runner emitted an unknown checkpoint type");
      },
    });
    const compiled = deps.compileDerived({
      seedArtifact: artifact,
      seedBinding,
      observations: seedDiscovery.accepted_observations,
      generatedAt: maximumBoundTime(options.activatedAt, seedDiscovery.accepted_observations),
    });
    await writeJsonAtomic(files.derived, compiled.artifact, outputGuard);
    if (!compiled.target_minimum_met) {
      return Object.freeze({
        status: "not_ready_insufficient_current_sellers",
        compiled,
        seedDiscovery,
        adapterSnapshot: managed.snapshot(),
      });
    }
    const capacityNow = deps.now();
    const capacityActivation = await createOrLoadCapacityActivation({
      filename: files.capacityActivation,
      compiled,
      options,
      now: capacityNow,
      outputGuard,
    });
    const capacityBinding = buildAuditedDerivedCapacityBinding({
      derivedArtifact: compiled.artifact,
      derivedArtifactSha256: compiled.artifact_sha256,
      runId: capacityActivation.run_id,
      campaignEpoch: capacityActivation.campaign_epoch,
      activatedAt: capacityActivation.activated_at,
      now: capacityNow,
    });
    const capacityRows = await readContractJsonLines(
      files.capacityObservations,
      AUDITED_DERIVED_CAPACITY_OBSERVATION_CONTRACT,
      "capacity observation log",
      outputGuard,
    );
    const capacityScans = await readContractJsonLines(
      files.capacityScans,
      AUDITED_DERIVED_CAPACITY_SCAN_CHECKPOINT_CONTRACT,
      "capacity source checkpoint log",
      outputGuard,
    );
    const capacityDetails = await readContractJsonLines(
      files.capacityDetails,
      AUDITED_DERIVED_CAPACITY_DETAIL_CHECKPOINT_CONTRACT,
      "capacity detail checkpoint log",
      outputGuard,
    );
    const probe = await deps.runCapacityProbe({
      derivedArtifact: compiled.artifact,
      derivedArtifactSha256: compiled.artifact_sha256,
      capacityBinding,
      adapter: managed.adapter,
      resumeScans: capacityScans,
      resumeObservations: capacityRows,
      resumeDetails: capacityDetails,
      now: deps.now,
      onObservation: (row) => appendJsonLine(files.capacityObservations, row, outputGuard),
      onCheckpoint: (row) => {
        if (row?.contract === AUDITED_DERIVED_CAPACITY_SCAN_CHECKPOINT_CONTRACT) {
          return appendJsonLine(files.capacityScans, row, outputGuard);
        }
        if (row?.contract === AUDITED_DERIVED_CAPACITY_DETAIL_CHECKPOINT_CONTRACT) {
          return appendJsonLine(files.capacityDetails, row, outputGuard);
        }
        throw cliError("capacity runner emitted an unknown checkpoint type");
      },
    });
    // Capacity observations remain reusable for identity/capacity for the bounded
    // checkpoint TTL, but their price is "current" for only 15 minutes.  Bind the
    // attestation to the actual attestation clock so a resumed campaign cannot
    // make an old price fresh by reusing the observation timestamp as generatedAt.
    const generatedAt = deps.now();
    const attested = deps.attestCapacity({
      derivedArtifact: compiled.artifact,
      derivedArtifactSha256: compiled.artifact_sha256,
      capacityBinding,
      observations: probe.accepted_observations,
      generatedAt,
    });
    return Object.freeze({
      status: attested.attestation.ready ? "ready_for_validation_discovery" : "not_ready_capacity_gate",
      compiled,
      seedDiscovery,
      capacityActivation,
      capacityBinding,
      probe,
      attested,
      generatedAt,
      adapterSnapshot: managed.snapshot(),
    });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      const closed = await managed.close();
      if (closed?.closed !== true) throw cliError("pinned adapter did not prove its pages and workers closed");
    } catch (closeError) {
      if (operationError) {
        throw new AggregateError([operationError, closeError], "seed pipeline and pinned adapter cleanup both failed");
      }
      throw closeError;
    }
  }
}

export async function runAuditedSeedPipelineCli(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseAuditedSeedPipelineArgs(argv);
  if (options.help) return { help: true, text: usage() };
  const deps = {
    now: () => new Date(),
    loadSeedArtifact: loadAuditedDiscoverySeedArtifact,
    withOwnedContext: withAuditedValidationOwnedContext,
    createPinnedAdapter: createPinnedAuditedSeedPlaywrightAdapter,
    runSeedDiscovery: runAuditedSeedObservationDiscovery,
    compileDerived: compileAuditedDerivedSellerPortfolio,
    runCapacityProbe: runAuditedDerivedCapacityProbe,
    attestCapacity: attestAuditedDerivedCapacity,
    promoteDerived: promoteAuditedDerivedSellerPortfolio,
    campaignRoot: AUDITED_SEED_CAMPAIGNS_ROOT,
    ownedContextDependencies: undefined,
    ...dependencies,
  };
  const now = deps.now();
  const artifact = await deps.loadSeedArtifact(options.artifact, { now });
  if (options.mode === "verify-artifact") {
    return {
      help: false,
      text: JSON.stringify({
        mode: options.mode,
        validation_only: true,
        automatic_publish_eligible: false,
        price_evidence_publish_eligible: false,
        next_stage_requires_live_price_refetch: true,
        identity_checkpoint_max_age_ms: artifact.source_query_contract.identity_checkpoint_max_age_ms,
        current_price_max_age_ms: artifact.source_query_contract.current_price_max_age_ms,
        artifact_sha256: artifact.artifact_sha256,
        source_set_sha256: artifact.source_set_sha256,
        logical_seed_count: artifact.seeds.length,
        exact_source_count: artifact.seeds.flatMap((seed) => seed.source_urls).length,
      }, null, 2),
    };
  }
  const { campaignDirectory, files, outputGuard } = await prepareCampaignFiles({
    campaignRoot: deps.campaignRoot,
    runId: options.runId,
    artifactFile: options.artifact,
    allowTestRoot: Object.hasOwn(dependencies, "campaignRoot"),
  });
  const seedBinding = buildAuditedSeedBinding({
    artifact,
    runId: `${options.runId}-seed`,
    campaignEpoch: options.seedEpoch,
    activatedAt: options.activatedAt,
    now,
  });
  const owned = await deps.withOwnedContext({
    userDataDir: AUDITED_VALIDATION_PROFILE,
    extension: AUDITED_EXTENSION_DIR,
    chromiumExecutable: AUDITED_BROWSER_EXECUTABLE,
    remoteDebuggingPort: AUDITED_VALIDATION_DEBUG_PORT,
  }, (runtime) => executePipelineInsideOwnedContext({
    options,
    artifact,
    files,
    outputGuard,
    runtime,
    deps,
    seedBinding,
  }), deps.ownedContextDependencies);
  const core = owned?.value;
  if (!core?.status) throw cliError("owned runner returned no pipeline result");
  const counters = firewallCounters(owned.request_firewall, core.adapterSnapshot, owned.network_safety);
  let promoted = null;
  if (core.attested) {
    await writeJsonAtomic(files.attestation, core.attested.attestation, outputGuard);
    if (core.attested.attestation.ready) {
      promoted = deps.promoteDerived({
        draftArtifact: core.compiled.artifact,
        draftArtifactSha256: core.compiled.artifact_sha256,
        capacityAttestation: core.attested.attestation,
        capacityAttestationSha256: core.attested.attestation_sha256,
        generatedAt: core.generatedAt,
      });
      await writeJsonAtomic(files.promoted, promoted.artifact, outputGuard);
    }
  }
  if (!promoted) {
    const existingPromoted = await readJsonOptional(files.promoted, "promoted artifact", outputGuard);
    if (existingPromoted) throw cliError("not-ready campaign contains a stale promoted artifact");
  }
  const result = Object.freeze({
    mode: "audited-seed-two-stage-validation-only",
    status: core.status,
    validation_only: true,
    automatic_publish_eligible: false,
    price_evidence_publish_eligible: false,
    next_stage_requires_live_price_refetch: true,
    current_price_max_age_ms: AUDITED_CURRENT_PRICE_MAX_AGE_MS,
    campaign_directory: campaignDirectory,
    seed_artifact_sha256: artifact.artifact_sha256,
    seed_source_set_sha256: artifact.source_set_sha256,
    accepted_seed_observations: core.compiled.accepted_observation_count,
    derived_target_count: core.compiled.selected_target_count,
    derived_artifact_sha256: core.compiled.artifact_sha256,
    capacity_activation: core.capacityActivation || null,
    capacity_attestation_sha256: core.attested?.attestation_sha256 || null,
    brand_safe_unique_skus: core.attested?.attestation.brand_safe_unique_skus || 0,
    current_price_observation_count: core.attested?.attestation.current_price_observation_count || 0,
    identity_capacity_only_observation_count:
      core.attested?.attestation.identity_capacity_only_observation_count || 0,
    current_sellers: core.attested?.attestation.current_sellers || core.compiled.selected_target_count,
    promoted_artifact_sha256: promoted?.artifact_sha256 || null,
    publication_attempts: counters.submission_attempts,
    favorite_mutations: counters.favorite_mutation_attempts,
    blocked_mutation_attempts: counters.blocked_mutation_attempts,
    request_firewall: counters.request_firewall,
    network_safety: counters.network_safety,
    adapter_safety_counters: counters.adapter,
    files,
  });
  await writeJsonAtomic(files.result, result, outputGuard);
  if (!promoted) throw new AuditedSeedPipelineNotReadyError(result);
  return { help: false, text: JSON.stringify(result, null, 2) };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runAuditedSeedPipelineCli().then(({ text }) => process.stdout.write(`${text}\n`)).catch((error) => {
    if (error?.result) process.stderr.write(`${JSON.stringify(error.result, null, 2)}\n`);
    process.stderr.write(`${error?.message || error}\n\n${usage()}\n`);
    process.exitCode = 1;
  });
}
