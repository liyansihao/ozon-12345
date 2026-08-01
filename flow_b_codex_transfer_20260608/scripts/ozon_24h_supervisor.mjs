#!/usr/bin/env node

import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  acceptedTerminalFailures,
  buildStagedGateState,
  evaluateLiveStagedGate,
  evidenceSnapshotHash,
  loadLiveAcceptanceEvidence,
} from "./flow_b_playwright/live-acceptance-gates.mjs";
import {
  failSubmissionGate,
  initializeSubmissionGate,
  releaseSubmissionGate,
} from "./flow_b_playwright/runtime-state.mjs";
import { hasReliableSameItemCostEvidence } from "./flow_b_playwright/cost-evidence.mjs";
import { archiveRestorableProfileSessions } from "./prepare_cdp_profile.mjs";

const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_LABEL = "com.codex.ozon.24h-production";
const DEFAULT_INSTALL_ROOT = path.join(process.env.HOME || "/Users/mac", ".ozon-24h-production");
const PRODUCTION_STORE_IDS = [106637, 106640, 106644, 106646, 104965];
const SECURITY_RE = /captcha|滑块|slider|mfa|two[- ]factor|verification required|安全检查|验证码/i;
const BROWSER_RECOVERY_RE = /econnrefused|econnreset|etimedout|enotfound|eai_again|CDP health check failed|target (?:page, )?context or browser has been closed|browsercontext\.(?:newpage|close).*target page has been closed|browser has been closed|favorite worker page creation timed out|net::err_/i;

function absolute(value, fallback) {
  return path.resolve(String(value || fallback || ""));
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

export function resolveProductionLayout({
  sourceRoot = path.resolve(import.meta.dirname, "../.."),
  installRoot = DEFAULT_INSTALL_ROOT,
} = {}) {
  const normalizedInstallRoot = absolute(installRoot);
  return {
    sourceRoot: absolute(sourceRoot),
    installRoot: normalizedInstallRoot,
    appRoot: path.join(normalizedInstallRoot, "app"),
    stateRoot: path.join(normalizedInstallRoot, "state"),
    entryScript: path.join(normalizedInstallRoot, "app", "scripts", "ozon_24h_production.sh"),
    configPath: path.join(normalizedInstallRoot, "app", "config", "ozon_24h_production.json"),
    launchAgentPath: path.join(
      process.env.HOME || "/Users/mac",
      "Library",
      "LaunchAgents",
      `${DEFAULT_LABEL}.plist`,
    ),
  };
}

export function resolveSupervisorAppRoot(moduleDirectory = import.meta.dirname) {
  return path.resolve(moduleDirectory, "..");
}

export function resolveSourceScanStateFile(runDir, config = {}) {
  const configured = String(config.flow_env?.FLOW_B_SOURCE_SCAN_STATE_FILE || "source_deep_scan.json").trim();
  if (!/^[a-zA-Z0-9._-]+\.json$/u.test(configured)) {
    throw new Error("FLOW_B_SOURCE_SCAN_STATE_FILE must be a safe JSON filename");
  }
  return path.join(path.resolve(runDir), configured);
}

export function nextRestartDelaySeconds(attempt, configured = [30, 60, 120]) {
  const values = configured
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const delays = values.length > 0 ? values : [30, 60, 120];
  const index = Math.min(Math.max(0, Math.trunc(Number(attempt) || 0)), delays.length - 1);
  return delays[index];
}

export function classifyWorkerFailure({ message = "", profileOwnerCount = 0 } = {}) {
  if (Number(profileOwnerCount) > 1) {
    return { action: "fatal-stop", reason: "duplicate-profile-owner-risk" };
  }
  const text = String(message || "");
  if (SECURITY_RE.test(text)) {
    return { action: "wait-for-verification", reason: "security-verification-required" };
  }
  if (BROWSER_RECOVERY_RE.test(text) || Number(profileOwnerCount) === 0) {
    return { action: "restart-browser-and-worker", reason: "browser-or-network-recoverable" };
  }
  return { action: "restart-worker", reason: "ordinary-worker-recoverable" };
}

export function browserOwnerPidsForRecovery(decision, owners = []) {
  if (decision?.action !== "restart-browser-and-worker" || owners.length !== 1) return [];
  const pid = Number(owners[0]?.pid);
  return Number.isInteger(pid) && pid > 0 ? [pid] : [];
}

export function currentRunDisposition(currentRun) {
  if (!currentRun || Object.keys(currentRun).length === 0) return "idle";
  if (!currentRun.run_id || !currentRun.run_dir || !currentRun.urls_file) return "invalid";
  return "active";
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactStoreIds(rows) {
  return (rows || []).map((row) => Number(row?.id));
}

export function productionRunContractDecision({
  currentRun = {},
  pendingManifest = {},
  acceptanceWindow = {},
  sourceConfig = {},
  frozenManifest = {},
  expectedConfigHash = null,
  expectedCommitSha = null,
} = {}) {
  const issues = [];
  const runId = String(currentRun?.run_id || "");
  const configHash = String(currentRun?.config_sha256 || "");
  const sourceSetHash = String(currentRun?.source_set_sha256 || currentRun?.source_sha256 || "");
  if (!runId) issues.push("current-run-id-missing");
  if (Number(currentRun?.state_schema_version) !== 3) issues.push("current-state-schema-not-v3");
  if (!configHash) issues.push("current-config-hash-missing");
  if (expectedConfigHash && configHash !== String(expectedConfigHash)) {
    issues.push("current-config-hash-mismatch");
  }
  if (!sourceSetHash) issues.push("current-source-set-hash-missing");

  if (currentRun?.formal_started === false) {
    if (String(pendingManifest?.run_id || "") !== runId) issues.push("pending-run-id-mismatch");
    if (String(pendingManifest?.config_sha256 || "") !== configHash) {
      issues.push("pending-config-hash-mismatch");
    }
    if (String(pendingManifest?.source_set_sha256 || pendingManifest?.source_sha256 || "") !== sourceSetHash) {
      issues.push("pending-source-set-hash-mismatch");
    }
    if (Number(pendingManifest?.state_schema_version) !== 3) issues.push("pending-state-schema-not-v3");
    if (pendingManifest?.formal_window_started !== false) issues.push("pending-formal-flag-invalid");
  } else if (currentRun?.formal_started === true) {
    if (Number(currentRun?.acceptance_target) !== 500) issues.push("current-target-not-500");
    if (String(currentRun?.acceptance_target_policy || "") !== "fixed") {
      issues.push("current-target-policy-not-fixed");
    }

    const startedMs = Date.parse(acceptanceWindow?.started_at || "");
    const endedMs = Date.parse(acceptanceWindow?.ended_at || "");
    if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs - startedMs !== 86_400_000) {
      issues.push("acceptance-window-not-24h");
    }
    if (Number(acceptanceWindow?.acceptance_target) !== 500) issues.push("window-target-not-500");
    if (String(acceptanceWindow?.acceptance_target_policy || "") !== "fixed") {
      issues.push("window-target-policy-not-fixed");
    }
    if (Number(acceptanceWindow?.per_store_target) !== 100) issues.push("window-store-target-not-100");
    if (Number(acceptanceWindow?.rolling_rate_window_minutes) !== 120) {
      issues.push("window-rate-period-not-120m");
    }
    if (Number(acceptanceWindow?.minimum_average_per_hour_exclusive) !== 35) {
      issues.push("window-rate-not-35");
    }
    if (acceptanceWindow?.current_window_only !== true) issues.push("window-scope-invalid");

    if (Number(sourceConfig?.acceptance_target) !== 500) issues.push("source-target-not-500");
    if (String(sourceConfig?.acceptance_target_policy || "") !== "fixed") {
      issues.push("source-target-policy-not-fixed");
    }
    if (Number(sourceConfig?.per_store_target) !== 100) issues.push("source-store-target-not-100");
    if (Number(sourceConfig?.minimum_average_per_hour_exclusive) !== 35) {
      issues.push("source-rate-not-35");
    }
    if (sourceConfig?.require_quality_evidence !== true) issues.push("source-quality-evidence-not-required");
    if (sourceConfig?.current_window_only !== true) issues.push("source-window-scope-invalid");
    if (exactStoreIds(sourceConfig?.store_targets).join(",") !== PRODUCTION_STORE_IDS.join(",")) {
      issues.push("source-store-set-mismatch");
    }
    const warehouseIds = (sourceConfig?.store_targets || []).map((row) => Number(row?.warehouseId));
    if (warehouseIds.length !== 5
      || warehouseIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
      || new Set(warehouseIds).size !== 5) {
      issues.push("source-warehouse-map-invalid");
    }

    if (String(frozenManifest?.run_id || "") !== runId) issues.push("frozen-run-id-mismatch");
    if (String(frozenManifest?.config_sha256 || "") !== configHash) {
      issues.push("frozen-config-hash-mismatch");
    }
    if (String(frozenManifest?.source_set_sha256 || "") !== sourceSetHash) {
      issues.push("frozen-source-set-hash-mismatch");
    }
    if (Number(frozenManifest?.state_schema_version) !== 3) issues.push("frozen-state-schema-not-v3");
    if (Number(frozenManifest?.acceptance_target) !== 500) issues.push("frozen-target-not-500");
    if (String(frozenManifest?.acceptance_target_policy || "") !== "fixed") {
      issues.push("frozen-target-policy-not-fixed");
    }
    if (Number(frozenManifest?.per_store_target) !== 100) issues.push("frozen-store-target-not-100");
    if (Number(frozenManifest?.rolling_rate_window_minutes) !== 120) {
      issues.push("frozen-rate-period-not-120m");
    }
    if (Number(frozenManifest?.minimum_strict_per_hour) !== 35) issues.push("frozen-rate-not-35");
    if (frozenManifest?.current_window_only !== true) issues.push("frozen-window-scope-invalid");
    if (expectedCommitSha && String(frozenManifest?.commit_sha || "") !== String(expectedCommitSha)) {
      issues.push("frozen-commit-mismatch");
    }
  } else {
    issues.push("formal-started-flag-must-be-boolean");
  }

  return issues.length === 0
    ? { action: "continue", reason: null, issues: [] }
    : { action: "fatal-stop", reason: "fixed-production-run-contract-mismatch", issues };
}

export function supervisorShouldHonorSafeStop(operationalStatus) {
  return new Set(["STOPPED", "FATAL_STOP", "WINDOW_COMPLETE", "TARGET_NOT_MET", "RETIRED"])
    .has(String(operationalStatus?.status || ""));
}

export function capacityPreflightDecision(
  snapshot,
  requiredCapacity = 500,
  targetPolicy = "fixed",
  { allowCurrentDayShortfall = false } = {},
) {
  if (String(targetPolicy || "") !== "fixed") {
    return { action: "fatal-stop", reason: "acceptance-target-policy-must-be-fixed" };
  }
  if (snapshot?.all_stores_found !== true
    || snapshot?.all_warehouses_verified !== true
    || snapshot?.all_quotas_verified !== true) {
    return { action: "fatal-stop", reason: "capacity-or-warehouse-verification-failed" };
  }
  if (Number(snapshot?.total_remaining_capacity) < Number(requiredCapacity)) {
    if (allowCurrentDayShortfall === true) {
      return {
        action: "start-formal-window",
        reason: "operator-authorized-current-day-capacity-shortfall",
        total_remaining_capacity: Number(snapshot?.total_remaining_capacity) || 0,
        required_capacity: Number(requiredCapacity),
      };
    }
    return {
      action: "fatal-stop",
      reason: "insufficient-current-day-capacity",
      total_remaining_capacity: Number(snapshot?.total_remaining_capacity) || 0,
      required_capacity: Number(requiredCapacity),
    };
  }
  return { action: "start-formal-window", reason: null };
}

export function browserRecoverySafeStopDecision(events = [], {
  now = new Date(),
  windowMs = 60 * 60_000,
  threshold = 2,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  if (!Number.isFinite(nowMs)) throw new TypeError("browser recovery decision now is invalid");
  let consecutiveFailures = 0;
  for (const event of events || []) {
    const at = Date.parse(String(event?.at || event?.timestamp || ""));
    if (!Number.isFinite(at) || at < nowMs - Number(windowMs) || at > nowMs) continue;
    if (String(event?.action || "") !== "browser-recovery-attempt") continue;
    if (String(event?.outcome || "") === "succeeded") consecutiveFailures = 0;
    else if (String(event?.outcome || "") === "failed") consecutiveFailures += 1;
  }
  if (consecutiveFailures >= Math.max(1, Number(threshold) || 2)) {
    return {
      action: "safe-stop",
      reason: "repeated-browser-recovery-failure",
      consecutive_failures: consecutiveFailures,
    };
  }
  return { action: "continue", reason: null, consecutive_failures: consecutiveFailures };
}

export function processOwnershipDecision({
  phase = "before-worker",
  supervisor = 0,
  worker = 0,
  profile_owner: profileOwner = 0,
} = {}) {
  if (Number(supervisor) !== 1) {
    return {
      action: "fatal-stop",
      reason: Number(supervisor) > 1
        ? "duplicate-supervisor-risk"
        : "supervisor-ownership-lost",
    };
  }
  if (Number(worker) > 1) return { action: "fatal-stop", reason: "duplicate-worker-generation-risk" };
  if (Number(profileOwner) > 1) return { action: "fatal-stop", reason: "duplicate-profile-owner-risk" };
  if (phase === "worker-running" && Number(worker) !== 1) {
    return { action: "fatal-stop", reason: "worker-generation-ownership-lost" };
  }
  if (phase === "worker-running" && Number(profileOwner) !== 1) {
    return { action: "fatal-stop", reason: "profile-owner-ownership-lost" };
  }
  if (phase === "browser-ready" && Number(profileOwner) !== 1) {
    return { action: "fatal-stop", reason: "profile-owner-ownership-lost" };
  }
  if (phase === "browser-ready" && Number(worker) !== 0) {
    return { action: "fatal-stop", reason: "unexpected-live-worker-generation" };
  }
  if (["before-worker", "after-exit"].includes(phase) && Number(worker) !== 0) {
    return { action: "fatal-stop", reason: "unexpected-live-worker-generation" };
  }
  if (phase === "after-exit" && Number(profileOwner) !== 0) {
    return { action: "fatal-stop", reason: "orphan-profile-owner-risk" };
  }
  return { action: "continue", reason: null };
}

export function rollingRateDecision({
  elapsedMinutes = 0,
  rolling120PerHour = 0,
  minimumPerHour = 35,
  targetReached = false,
} = {}) {
  if (targetReached === true) return { action: "continue", reason: "target-already-reached" };
  if (Number(elapsedMinutes) < 120) return { action: "observe", reason: "insufficient-120-minute-window" };
  if (Number(rolling120PerHour) < Number(minimumPerHour)) {
    return {
      action: "safe-stop",
      reason: "rolling-120-minute-strict-rate-below-threshold",
      observed_per_hour: Number(rolling120PerHour) || 0,
      minimum_per_hour: Number(minimumPerHour),
    };
  }
  return { action: "continue", reason: null };
}

export function candidateBufferDecision({
  uniqueReady = 0,
  targetHours = 2,
  minimumPerHour = 35,
  minimumReadyCandidates = 70,
} = {}) {
  const requiredReady = Math.max(
    Math.ceil(Number(targetHours) * Number(minimumPerHour)),
    Math.ceil(Number(minimumReadyCandidates) || 0),
  );
  const ready = Math.max(0, Math.floor(Number(uniqueReady) || 0));
  return ready >= requiredReady
    ? { action: "ready", unique_ready: ready, required_ready: requiredReady }
    : { action: "prepare", unique_ready: ready, required_ready: requiredReady };
}

function isQualifiedCandidateBufferRow(row) {
  const sku = String(row?.sku || "").trim();
  return (
    Boolean(sku)
    && sku !== "2815247918"
    && String(row?.status || "") === "validated"
    && String(row?.validation_mode || "") === "buffer"
    && String(row?.shipping_mode || "").toUpperCase() === "FBS"
    && row?.fbs_evidence?.verified === true
    && hasReliableSameItemCostEvidence(row)
    && Number(row?.purchase_price) > 0
    && Number(row?.profit_rate) > 30
    && row?.quality_gate_passed === true
  );
}

export function candidateBufferSnapshot(rows = [], { consumedSkus = [] } = {}) {
  const latest = new Map();
  const consumedValues = consumedSkus && typeof consumedSkus[Symbol.iterator] === "function"
    ? [...consumedSkus]
    : [];
  const consumed = new Set(consumedValues.map((value) => String(value || "").trim()).filter(Boolean));
  for (const row of rows || []) {
    const sku = String(row?.sku || "").trim();
    if (sku) latest.set(sku, row);
  }
  const readySkus = [...latest].filter(([sku, row]) => (
    !consumed.has(sku)
    && isQualifiedCandidateBufferRow(row)
  )).map(([sku]) => sku).sort();
  return {
    unique_ready: readySkus.length,
    ready_skus: readySkus,
    rejected_or_invalid: Math.max(0, latest.size - readySkus.length),
  };
}

export function candidateBufferInflow(rows = [], {
  consumedSkus = [],
  consumedBeforeSkus = [],
  previousAt,
  observedAt,
} = {}) {
  const previousMs = Date.parse(String(previousAt || ""));
  const observedMs = Date.parse(String(observedAt || ""));
  if (!Number.isFinite(previousMs) || !Number.isFinite(observedMs) || observedMs < previousMs) {
    throw new TypeError("candidate buffer inflow requires an ordered evidence interval");
  }
  const current = candidateBufferSnapshot(rows, { consumedSkus });
  const previous = candidateBufferSnapshot(
    (rows || []).filter((row) => {
      const at = qualifiedValidationTimestamp(row);
      return Number.isFinite(at) && at <= previousMs;
    }),
    { consumedSkus: consumedBeforeSkus },
  );
  const firstQualifiedAt = new Map();
  for (const row of rows || []) {
    const sku = String(row?.sku || "").trim();
    if (!sku || !isQualifiedCandidateBufferRow(row)) continue;
    const at = qualifiedValidationTimestamp(row);
    if (!Number.isFinite(at)) continue;
    const prior = firstQualifiedAt.get(sku);
    if (!Number.isFinite(prior) || at < prior) firstQualifiedAt.set(sku, at);
  }
  const currentReady = new Set(current.ready_skus);
  const addedSkus = [...firstQualifiedAt]
    .filter(([sku, at]) => currentReady.has(sku) && at > previousMs && at <= observedMs)
    .map(([sku]) => sku)
    .sort();
  return {
    current,
    previous,
    added_unique: addedSkus.length,
    added_skus: addedSkus,
  };
}

export function buildLaunchdPlist({
  label = DEFAULT_LABEL,
  entryScript,
  stateRoot,
} = {}) {
  if (!entryScript) throw new Error("entryScript is required");
  if (!stateRoot) throw new Error("stateRoot is required");
  const stdout = path.join(stateRoot, "launchd.stdout.log");
  const stderr = path.join(stateRoot, "launchd.stderr.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${xmlEscape(absolute(entryScript))}</string>
    <string>supervise</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(path.dirname(absolute(entryScript)))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderr)}</string>
</dict>
</plist>
`;
}

async function readJson(filename, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== null) return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, filename);
}

async function writeTextAtomic(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, String(value), "utf8");
  await fsp.rename(temporary, filename);
}

function liveProcessStatePath(runDir) {
  return path.join(path.resolve(runDir), "live_process_state.json");
}

async function updateLiveProcessState(runDir, update = {}) {
  const filename = liveProcessStatePath(runDir);
  const current = await readJson(filename, {
    schema_version: 1,
    formal_worker_started_at: null,
    worker_generation: 0,
    active_worker_pid: null,
    recovery_pending: false,
    recovery_started_at: null,
  });
  const next = {
    ...current,
    ...update,
    schema_version: 1,
    updated_at: new Date().toISOString(),
  };
  await writeJsonAtomic(filename, next);
  return next;
}

async function appendJsonLine(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.appendFile(filename, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonLines(filename) {
  try {
    const text = await fsp.readFile(filename, "utf8");
    return text.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function pidAlive(pid) {
  const normalized = Number(pid);
  if (!Number.isInteger(normalized) || normalized <= 0) return false;
  try {
    process.kill(normalized, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopOwnedWorker(activeWorker, {
  pidAliveFn = pidAlive,
  delayFn = delay,
  graceMs = 15_000,
} = {}) {
  if (!activeWorker) return false;
  const workerPid = Number(activeWorker.pid);
  if (!pidAliveFn(workerPid)) return false;
  activeWorker.kill("SIGTERM");
  const deadline = Date.now() + Math.max(0, Number(graceMs) || 0);
  while (pidAliveFn(workerPid) && Date.now() < deadline) await delayFn(100);
  if (pidAliveFn(workerPid)) activeWorker.kill("SIGKILL");
  return true;
}

async function acquireSupervisorLock(stateRoot) {
  const lockDir = path.join(stateRoot, "supervisor.lock");
  await fsp.mkdir(stateRoot, { recursive: true });
  try {
    await fsp.mkdir(lockDir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = await readJson(path.join(lockDir, "owner.json"), {});
    if (pidAlive(owner?.pid)) {
      const duplicate = new Error(`supervisor lock already held by PID ${owner.pid}`);
      duplicate.code = "OZON_DUPLICATE_SUPERVISOR";
      throw duplicate;
    }
    await fsp.rm(lockDir, { recursive: true, force: true });
    await fsp.mkdir(lockDir);
  }
  await writeJsonAtomic(path.join(lockDir, "owner.json"), {
    pid: process.pid,
    started_at: new Date().toISOString(),
  });
  return async () => {
    const owner = await readJson(path.join(lockDir, "owner.json"), {});
    if (Number(owner?.pid) === process.pid) {
      await fsp.rm(lockDir, { recursive: true, force: true });
    }
  };
}

async function processTable() {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return String(stdout || "").split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\s\S]+)$/u);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}

function exactProfileOwner(row, profileDir) {
  const marker = `--user-data-dir=${profileDir}`;
  return row.command.includes(marker) && !row.command.includes(" --type=");
}

async function profileOwners(profileDir) {
  return (await processTable()).filter((row) => exactProfileOwner(row, profileDir));
}

export function processOwnershipSnapshot(rows = [], {
  supervisorPid = process.pid,
  runDir,
  profileDir,
} = {}) {
  const supervisorPids = new Set();
  const workerPids = new Set();
  const normalizedProfileDir = absolute(profileDir);
  const profileOwnerPids = new Set();
  for (const row of rows || []) {
    const pid = Number(row?.pid);
    const command = String(row?.command || "");
    if (!(pid > 0)) continue;
    if (
      pid === Number(supervisorPid)
      || (command.includes("ozon_24h_supervisor.mjs") && /\bsupervise\b/u.test(command))
    ) {
      supervisorPids.add(pid);
    }
    if (
      command.includes("flow_b_playwright.mjs")
      && /\b(?:accept|run|publish)\b/u.test(command)
    ) {
      workerPids.add(pid);
    }
    if (exactProfileOwner(row, normalizedProfileDir)) profileOwnerPids.add(pid);
  }
  return {
    supervisor: supervisorPids.size,
    worker: workerPids.size,
    profile_owner: profileOwnerPids.size,
    supervisor_pids: [...supervisorPids].sort((left, right) => left - right),
    worker_pids: [...workerPids].sort((left, right) => left - right),
    profile_owner_pids: [...profileOwnerPids].sort((left, right) => left - right),
  };
}

async function assertProcessOwnership({ phase, runDir, profileDir }) {
  const snapshot = processOwnershipSnapshot(await processTable(), {
    supervisorPid: process.pid,
    runDir,
    profileDir,
  });
  const decision = processOwnershipDecision({ phase, ...snapshot });
  if (decision.action === "fatal-stop") {
    const error = new Error(decision.reason);
    error.code = "OZON_PROCESS_OWNERSHIP";
    error.ownership = snapshot;
    throw error;
  }
  return snapshot;
}

function endpointPort(endpoint) {
  const parsed = new URL(endpoint);
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid CDP endpoint port: ${endpoint}`);
  return port;
}

async function cdpReady(endpoint, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs) || 1500));
  try {
    const response = await fetch(new URL("/json/version", endpoint), { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForWorkerOrBrowserFailure(worker, {
  cdpEndpoint,
  probeIntervalMs = 15_000,
  probeTimeoutMs = 3_000,
  failureThreshold = 2,
  cdpReadyFn = cdpReady,
  delayFn = delay,
} = {}) {
  const interval = Math.max(1, Number(probeIntervalMs) || 15_000);
  const timeout = Math.max(100, Number(probeTimeoutMs) || 3_000);
  const threshold = Math.max(1, Math.floor(Number(failureThreshold) || 2));
  let settled = false;
  return new Promise((resolve) => {
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    worker.once("error", (error) => finish({
      code: 127,
      signal: null,
      error,
      browser_unhealthy: false,
    }));
    worker.once("exit", (code, signal) => finish({
      code: Number(code ?? 1),
      signal,
      error: null,
      browser_unhealthy: false,
    }));
    void (async () => {
      let consecutiveFailures = 0;
      while (!settled) {
        await delayFn(interval);
        if (settled) return;
        const healthy = await cdpReadyFn(cdpEndpoint, timeout);
        if (settled) return;
        consecutiveFailures = healthy ? 0 : consecutiveFailures + 1;
        if (consecutiveFailures >= threshold) {
          finish({
            code: 1,
            signal: null,
            error: new Error(`Chrome CDP health check failed ${consecutiveFailures} consecutive times at ${cdpEndpoint}`),
            browser_unhealthy: true,
          });
        }
      }
    })().catch((error) => finish({
      code: 1,
      signal: null,
      error,
      browser_unhealthy: true,
    }));
  });
}

async function stopExactOwner(pid, waitMs = 10_000) {
  if (!pidAlive(pid)) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + waitMs;
  while (pidAlive(pid) && Date.now() < deadline) await delay(100);
  if (pidAlive(pid)) process.kill(pid, "SIGKILL");
}

export async function stopBrowserProfileOwners(profileDir, {
  profileOwnersFn = profileOwners,
  stopOwnerFn = stopExactOwner,
} = {}) {
  const owners = await profileOwnersFn(absolute(profileDir));
  const stopped = [];
  for (const owner of owners) {
    const pid = Number(owner?.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    await stopOwnerFn(pid);
    stopped.push(pid);
  }
  return stopped;
}

const REBUILDABLE_BROWSER_CACHE_PATHS = [
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "Default/Media Cache",
  "Default/DawnGraphiteCache",
  "Default/DawnWebGPUCache",
  "ShaderCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "component_crx_cache",
];

export async function cleanupBrowserProfileCaches(profileDir, {
  removeFn = (filename) => fsp.rm(filename, { recursive: true, force: true }),
} = {}) {
  const root = absolute(profileDir);
  const cleaned = [];
  for (const relative of REBUILDABLE_BROWSER_CACHE_PATHS) {
    const filename = path.join(root, ...relative.split("/"));
    try {
      await fsp.lstat(filename);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    await removeFn(filename);
    cleaned.push(relative);
  }
  return cleaned;
}

export async function cleanupProfileCachesForConfig(config, {
  profileOwnersFn = profileOwners,
  cleanupFn = cleanupBrowserProfileCaches,
} = {}) {
  const resolvedConfig = expandedConfig(config);
  const configuredProfileDir = String(resolvedConfig.browser?.profile_dir || "").trim();
  if (!configuredProfileDir) throw new Error("browser profile_dir is required");
  const profileDir = absolute(configuredProfileDir);
  const owners = await profileOwnersFn(profileDir);
  if (owners.length > 0) {
    const error = new Error(
      `refusing browser cache cleanup while profile owner is active: ${owners.map((row) => row.pid).join(",")}`,
    );
    error.code = "OZON_PROFILE_IN_USE";
    throw error;
  }
  const cleanedBrowserCaches = await cleanupFn(profileDir);
  return {
    profile_dir: profileDir,
    cleaned_browser_caches: cleanedBrowserCaches,
    preserved: [
      "cookies",
      "local-storage",
      "indexeddb",
      "extension-login-state",
      "local-state",
      "checkpoint",
      "dedupe",
      "run-evidence",
      "exports",
    ],
  };
}

export function chromeArguments(browser) {
  const args = [
    `--remote-debugging-port=${endpointPort(browser.cdp_endpoint)}`,
    `--user-data-dir=${absolute(browser.profile_dir)}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--disable-blink-features=AutomationControlled",
    "--disable-gpu",
    `--disable-extensions-except=${absolute(browser.extension_dir)}`,
    `--load-extension=${absolute(browser.extension_dir)}`,
    `--disk-cache-size=${Number(browser.disk_cache_size_bytes) || 104857600}`,
    `--media-cache-size=${Number(browser.media_cache_size_bytes) || 52428800}`,
  ];
  if (browser.no_proxy_server !== false) args.push("--no-proxy-server");
  args.push("about:blank");
  return args;
}

export async function ensureBrowserOwner({ config, stateRoot, runDir }) {
  const browser = config.browser || {};
  const profileDir = absolute(browser.profile_dir);
  let owners = await profileOwners(profileDir);
  if (owners.length > 1) {
    const error = new Error(`duplicate browser profile owners: ${owners.map((row) => row.pid).join(",")}`);
    error.code = "OZON_DUPLICATE_PROFILE_OWNER";
    throw error;
  }
  if (owners.length === 1 && await cdpReady(browser.cdp_endpoint)) {
    return { pid: owners[0].pid, reused: true };
  }
  if (owners.length === 1) {
    await stopExactOwner(owners[0].pid);
    await appendJsonLine(path.join(stateRoot, "recovery.jsonl"), {
      at: new Date().toISOString(),
      run_dir: runDir,
      action: "terminated-unresponsive-profile-owner",
      pid: owners[0].pid,
    });
  }
  owners = await profileOwners(profileDir);
  if (owners.length > 0) {
    const error = new Error(`refusing session archive while profile owner is active: ${owners.map((row) => row.pid).join(",")}`);
    error.code = "OZON_PROFILE_IN_USE";
    throw error;
  }
  const sessionArchive = await archiveRestorableProfileSessions({
    profileDir,
    runDir,
    archiveId: `browser-start-${Date.now()}`,
  });
  await appendJsonLine(path.join(stateRoot, "recovery.jsonl"), {
    at: new Date().toISOString(),
    run_dir: runDir,
    action: "archived-restorable-browser-tabs",
    archived_count: sessionArchive.archived_count,
    archive_dir: sessionArchive.archive_dir,
  });
  await fsp.mkdir(profileDir, { recursive: true });
  const stdoutFd = fs.openSync(path.join(stateRoot, "chrome.stdout.log"), "a");
  const stderrFd = fs.openSync(path.join(stateRoot, "chrome.stderr.log"), "a");
  const chrome = spawn(absolute(browser.executable), chromeArguments(browser), {
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  chrome.unref();
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  const deadline = Date.now() + Math.max(10_000, Number(browser.start_timeout_ms) || 60_000);
  while (Date.now() < deadline) {
    if (!pidAlive(chrome.pid)) break;
    if (await cdpReady(browser.cdp_endpoint)) {
      owners = await profileOwners(profileDir);
      if (owners.length === 1) return { pid: owners[0].pid, reused: false };
      if (owners.length > 1) {
        const error = new Error(`duplicate browser profile owners after launch: ${owners.map((row) => row.pid).join(",")}`);
        error.code = "OZON_DUPLICATE_PROFILE_OWNER";
        throw error;
      }
    }
    await delay(500);
  }
  throw new Error(`Chrome CDP failed to become ready at ${browser.cdp_endpoint}`);
}

function expandTemplate(value, config = {}) {
  return String(value || "")
    .replaceAll("${HOME}", process.env.HOME || "/Users/mac")
    .replaceAll("${APP_ROOT}", String(config.install_root || ""))
    .replaceAll("${STATE_ROOT}", String(config.state_root || ""));
}

function expandedConfig(config) {
  const cloned = structuredClone(config);
  for (const key of ["install_root", "state_root"]) {
    if (cloned[key]) cloned[key] = expandTemplate(cloned[key], cloned);
  }
  for (const key of ["executable", "profile_dir", "extension_dir"]) {
    if (cloned.browser?.[key]) cloned.browser[key] = expandTemplate(cloned.browser[key], cloned);
  }
  return cloned;
}

function runtimeStateDatabasePath(config) {
  const configured = config?.flow_env?.FLOW_B_RUNTIME_STATE_DB;
  if (!configured) throw new Error("FLOW_B_RUNTIME_STATE_DB is required for formal production");
  return absolute(expandTemplate(configured, config));
}

export function checkpointEnvironment(config, currentRun, baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  environment.FLOW_B_PW_PROFILE = absolute(config.browser.profile_dir);
  environment.FLOW_B_PRODUCTION_STATE_ROOT = absolute(config.state_root);
  environment.FLOW_B_PRODUCTION_RUN_ID = String(currentRun.run_id);
  environment.FLOW_B_FROZEN_COMMIT = String(config.frozen_commit || "");
  environment.FLOW_B_FROZEN_CONFIG_HASH = String(config.frozen_config_hash || "");
  environment.FLOW_B_FROZEN_SOURCE_SET_HASH = String(
    currentRun.source_set_sha256 || currentRun.source_sha256 || "",
  );
  environment.FLOW_B_STATE_SCHEMA_VERSION = String(config.state_schema_version || 3);
  return environment;
}

export function workerEnvironment(config, currentRun) {
  let environment = { ...process.env };
  for (const [key, value] of Object.entries(config.flow_env || {})) {
    if (value === null || value === undefined) continue;
    environment[key] = typeof value === "string" ? expandTemplate(value, config) : JSON.stringify(value);
  }
  environment = checkpointEnvironment(config, currentRun, environment);
  environment.FLOW_B_CDP_ENDPOINT = config.browser.cdp_endpoint;
  environment.FLOW_B_EXTENSION_DIR = absolute(config.browser.extension_dir);
  environment.FLOW_B_CHROMIUM_EXECUTABLE = absolute(config.browser.executable);
  if (config.runtime_mode === "direct") {
    const configuredTargets = Array.isArray(config.flow_env?.FLOW_B_STORE_TARGETS)
      ? config.flow_env.FLOW_B_STORE_TARGETS
      : [];
    const startingStoreId = Number(currentRun.current_store_id || config.starting_store_id || 0);
    const startingIndex = configuredTargets.findIndex((row) => Number(row?.id) === startingStoreId);
    if (startingIndex > 0) {
      environment.FLOW_B_STORE_TARGETS = JSON.stringify([
        ...configuredTargets.slice(startingIndex),
        ...configuredTargets.slice(0, startingIndex),
      ]);
    }
    environment.FLOW_B_DIRECT_PUBLISH = "1";
    environment.FLOW_B_1688_MIN_MATCHES = "1";
    environment.FLOW_B_VALIDATION_ONLY = "0";
    environment.FLOW_B_TARGET_PUBLISH_COUNT = String(Number(config.publish_target));
    environment.FLOW_B_UNLIMITED_PUBLISH = Number(config.publish_target) === 0 ? "1" : "0";
    environment.FLOW_B_PROFIT_THRESHOLD = String(Number(config.minimum_profit_rate_exclusive) || 30);
    delete environment.FLOW_B_SUBMISSION_GATE_FILE;
    delete environment.FLOW_B_SUBMISSION_GATE_RUN_ID;
    delete environment.FLOW_B_SUBMISSION_GATE_RUN_DIR;
    delete environment.FLOW_B_RESUME_WINDOW;
    return environment;
  }
  environment.FLOW_B_RESUME_WINDOW = "1";
  environment.FLOW_B_CAPACITY_STORES = JSON.stringify(config.stores || []);
  environment.FLOW_B_ACCEPTANCE_TARGET = "500";
  environment.FLOW_B_TARGET_PUBLISH_COUNT = "500";
  environment.FLOW_B_STORE_ACCEPTANCE_TARGET = "100";
  environment.FLOW_B_REQUIRE_PER_STORE_ACCEPTANCE = "1";
  environment.FLOW_B_MINIMUM_AVERAGE_PER_HOUR_EXCLUSIVE = "35";
  environment.FLOW_B_ACCEPTANCE_TARGET_POLICY = "fixed";
  if (currentRun.formal_started === true) {
    environment.FLOW_B_SUBMISSION_GATE_FILE = path.join(
      absolute(currentRun.run_dir),
      "staged_acceptance_gates.json",
    );
    environment.FLOW_B_SUBMISSION_GATE_RUN_ID = String(currentRun.run_id);
    environment.FLOW_B_SUBMISSION_GATE_RUN_DIR = absolute(currentRun.run_dir);
  } else {
    delete environment.FLOW_B_SUBMISSION_GATE_FILE;
    delete environment.FLOW_B_SUBMISSION_GATE_RUN_ID;
    delete environment.FLOW_B_SUBMISSION_GATE_RUN_DIR;
  }
  return environment;
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.once("error", (error) => resolve({ code: 127, signal: null, error }));
    child.once("exit", (code, signal) => resolve({ code: Number(code ?? 1), signal, error: null }));
  });
}

async function readTail(filename, maxBytes = 64 * 1024) {
  try {
    const stat = await fsp.stat(filename);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fsp.open(filename, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function fileSize(filename) {
  try {
    return (await fsp.stat(filename)).size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

export async function readAppendedTail(filename, offset = 0, maxBytes = 64 * 1024) {
  try {
    const stat = await fsp.stat(filename);
    const normalizedOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    const generationStart = stat.size >= normalizedOffset ? normalizedOffset : 0;
    const start = Math.max(generationStart, stat.size - Math.max(1, Number(maxBytes) || 64 * 1024));
    const handle = await fsp.open(filename, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

export async function readWorkerGenerationEvidence({
  stderrPath,
  runtimeErrorsPath,
  stderrOffset = 0,
  runtimeErrorsOffset = 0,
  error = null,
} = {}) {
  return [
    await readAppendedTail(stderrPath, stderrOffset),
    await readAppendedTail(runtimeErrorsPath, runtimeErrorsOffset),
    error?.message || "",
  ].join("\n");
}

async function updateOperationalState(stateRoot, currentRun, patch) {
  const event = {
    run_id: currentRun.run_id,
    run_dir: currentRun.run_dir,
    observed_at: new Date().toISOString(),
    ...patch,
  };
  await writeJsonAtomic(path.join(stateRoot, "operational_status.json"), event);
  await appendJsonLine(path.join(stateRoot, "operational_history.jsonl"), event);
}

async function acceptanceEnded(runDir) {
  const window = await readJson(path.join(runDir, "acceptance_window.json"), {});
  const endedAt = Date.parse(window?.ended_at || "");
  return Number.isFinite(endedAt) && Date.now() >= endedAt;
}

async function runCheckpoint(appRoot, runDir, label, environment = process.env) {
  const script = path.join(appRoot, "scripts", "flow_b_checkpoint.mjs");
  return runCommand(process.execPath, [script, runDir, label], {
    cwd: appRoot,
    env: environment,
    stdio: "ignore",
  });
}

export async function reconcileStrictRuntimeAudit(appRoot, stateRoot, runDir) {
  const stateModule = await import(
    pathToFileURL(path.join(appRoot, "scripts", "flow_b_playwright", "publish-state.mjs")).href
  );
  return stateModule.reconcileRuntimeAuditOutputs({
    runtimeStateDbPath: path.join(stateRoot, "runtime", "flow_b_state.sqlite"),
    runDir,
    publishedCsv: path.join(stateRoot, "dedupe", "published_links.csv"),
  });
}

export async function runFinalArtifacts(
  appRoot,
  stateRoot,
  currentRun,
  runDir,
  releaseIdentity = {},
) {
  const output = path.join(stateRoot, "exports", currentRun.run_id);
  await fsp.mkdir(output, { recursive: true });
  await reconcileStrictRuntimeAudit(appRoot, stateRoot, runDir);
  const acceptanceReport = path.join(runDir, "acceptance_summary.json");
  const [window, sourceConfig, frozenManifest] = await Promise.all([
    readJson(path.join(runDir, "acceptance_window.json")),
    readJson(path.join(runDir, "source_config.json")),
    readJson(path.join(runDir, "frozen_manifest.json")),
  ]);
  const contract = productionRunContractDecision({
    currentRun,
    acceptanceWindow: window,
    sourceConfig,
    frozenManifest,
    expectedConfigHash: releaseIdentity.config_sha256 || currentRun.config_sha256,
    expectedCommitSha: releaseIdentity.source_commit || frozenManifest.commit_sha,
  });
  if (contract.action !== "continue") {
    const error = new Error(`${contract.reason}: ${contract.issues.join(",")}`);
    error.code = "OZON_PRODUCTION_RUN_CONTRACT";
    error.contract = contract;
    throw error;
  }
  const reportModule = await import(pathToFileURL(path.join(appRoot, "scripts", "flow_b_playwright.mjs")).href);
  await reportModule.writeAcceptanceReport(
    runDir,
    window.started_at,
    window.ended_at,
    500,
    { productionContract: true },
  );
  const exported = await runCommand(process.execPath, [
    path.join(appRoot, "scripts", "export_confirmed_store_skus.mjs"),
    runDir,
    output,
  ], {
    cwd: appRoot,
    env: process.env,
    stdio: "ignore",
  });
  if (exported.code !== 0) throw new Error("final five-store CSV export failed");
  let report = null;
  if (fs.existsSync(acceptanceReport)) {
    report = await readJson(acceptanceReport);
    await fsp.copyFile(acceptanceReport, path.join(output, "24h_report.json"));
  }
  return { output, report };
}

async function runSourceRefresh(appRoot, stateRoot, runDir) {
  const script = path.join(appRoot, "scripts", "ozon_source_portfolio.mjs");
  const seed = path.join(appRoot, "config", "ozon_source_seed.txt");
  return runCommand(process.execPath, [script, "refresh", stateRoot, runDir || "-", seed], {
    cwd: appRoot,
    env: process.env,
    stdio: "ignore",
  });
}

export async function runFormalSourceRefresh(
  appRoot,
  stateRoot,
  runDir,
  currentRun,
  {
    refresh = runSourceRefresh,
    now = () => new Date(),
  } = {},
) {
  const result = await refresh(appRoot, stateRoot, runDir);
  if (result.code !== 0) return result;
  const sourceText = await fsp.readFile(currentRun.urls_file, "utf8");
  if (!sourceText.split(/\r?\n/u).some((line) => /^https:\/\//u.test(line.trim()))) {
    throw new Error("refreshed formal source set has no usable URLs");
  }
  const sourceSetHash = sha256(sourceText);
  const epochRows = await readJsonLines(path.join(runDir, "source_set_epochs.jsonl"));
  const epoch = Number(epochRows.at(-1)?.epoch || 0) + 1;
  const observedAt = now().toISOString();
  await appendJsonLine(path.join(runDir, "source_set_epochs.jsonl"), {
    type: "source-set-epoch",
    at: observedAt,
    epoch,
    source_set_sha256: sourceSetHash,
    previous_source_set_sha256: epochRows.at(-1)?.source_set_sha256 || null,
    update_interval_seconds: 7_200,
  });
  Object.assign(currentRun, {
    active_source_set_sha256: sourceSetHash,
    source_set_epoch: epoch,
    source_refreshed_at: observedAt,
  });
  await writeJsonAtomic(path.join(stateRoot, "current_run.json"), currentRun);
  return { ...result, source_set_sha256: sourceSetHash, epoch };
}

export async function runInitialSourceRefresh({
  appRoot,
  stateRoot,
  runDir,
  currentRun,
  genericRefresh = runSourceRefresh,
  formalRefresh = runFormalSourceRefresh,
  now = () => new Date(),
} = {}) {
  if (currentRun?.formal_started === true) {
    const sourceText = await fsp.readFile(currentRun.urls_file, "utf8");
    const activeSourceSetHash = sha256(sourceText);
    const sourceEpochs = await readJsonLines(path.join(runDir, "source_set_epochs.jsonl"));
    const lastEpoch = sourceEpochs.at(-1) || null;
    const authorizedHash = String(
      lastEpoch?.source_set_sha256
      || currentRun.active_source_set_sha256
      || currentRun.source_set_sha256
      || "",
    );
    if (!authorizedHash || activeSourceSetHash !== authorizedHash) {
      const error = new Error("formal source set hash is not authorized by the last epoch or T0");
      error.code = "OZON_SOURCE_SET_NOT_AUTHORIZED";
      throw error;
    }
    const lastRefreshMs = Date.parse(String(
      lastEpoch?.at
      || currentRun.source_refreshed_at
      || currentRun.source_set_frozen_at
      || currentRun.started_at
      || "",
    ));
    const nowMs = now().getTime();
    if (
      Number.isFinite(lastRefreshMs)
      && Number.isFinite(nowMs)
      && nowMs - lastRefreshMs < 7_200_000
    ) {
      return {
        code: 0,
        skipped: true,
        reason: "formal-source-refresh-not-due",
        source_set_sha256: activeSourceSetHash,
        epoch: Number(lastEpoch?.epoch ?? currentRun.source_set_epoch ?? 0),
      };
    }
    return formalRefresh(appRoot, stateRoot, runDir, currentRun);
  }
  return genericRefresh(appRoot, stateRoot, runDir);
}

async function runCapacityPreflight(config, appRoot, stateRoot, currentRun) {
  const script = path.join(appRoot, "scripts", "ozon_capacity_preflight.mjs");
  const output = path.join(stateRoot, "capacity_preflight.json");
  const stdoutFd = fs.openSync(path.join(stateRoot, "capacity.stdout.log"), "a");
  const stderrFd = fs.openSync(path.join(stateRoot, "capacity.stderr.log"), "a");
  try {
    return await runCommand(process.execPath, [script, output], {
      cwd: appRoot,
      env: workerEnvironment(config, currentRun),
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
}

function spawnCandidateBufferPreparation(
  config,
  appRoot,
  runDir,
  urlsFile,
  currentRun,
  remainingTarget,
) {
  const stdoutFd = fs.openSync(path.join(runDir, "candidate-buffer.stdout.log"), "a");
  const stderrFd = fs.openSync(path.join(runDir, "candidate-buffer.stderr.log"), "a");
  const maximumMs = Math.max(
    60,
    Number(config.candidate_buffer?.preparation_max_run_seconds) || 600,
  ) * 1000;
  const child = spawn(process.execPath, [
    path.join(appRoot, "scripts", "flow_b_playwright.mjs"),
    "run",
    runDir,
    urlsFile,
  ], {
    cwd: appRoot,
    env: {
      ...workerEnvironment(config, currentRun),
      FLOW_B_VALIDATION_ONLY: "1",
      FLOW_B_VALIDATION_TARGET: String(Math.max(1, Number(remainingTarget) || 1)),
      FLOW_B_DEADLINE_AT: new Date(Date.now() + maximumMs).toISOString(),
    },
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  return child;
}

async function activateFormalWindow({
  config,
  stateRoot,
  currentRun,
  runDir,
  appRoot,
  readySkus,
}) {
  const frozenReadySkus = [...new Set((readySkus || []).map((value) => String(value || "").trim()).filter(Boolean))]
    .sort();
  const directPublish = config?.operator_direct_publish?.enabled === true;
  if (!directPublish && frozenReadySkus.length < 3) {
    throw new Error("formal window requires at least three frozen qualified SKUs");
  }
  const directAuthorization = directPublish ? {
    authorized_by: String(config.operator_direct_publish.authorized_by || "").trim(),
    authorized_at: String(config.operator_direct_publish.authorized_at || "").trim(),
    reason: String(config.operator_direct_publish.reason || "").trim(),
  } : null;
  const directGateResult = directPublish ? {
    passed: true,
    skipped: true,
    reason: "operator-direct-publish-zero-buffer-authorized",
    audit: {
      authorized_by: directAuthorization.authorized_by,
      authorized_at: new Date(directAuthorization.authorized_at).toISOString(),
      authorization_reason: directAuthorization.reason,
    },
  } : {};
  const sourceText = await fsp.readFile(currentRun.urls_file, "utf8");
  if (!sourceText.split(/\r?\n/u).some((line) => /^https:\/\//u.test(line.trim()))) {
    throw new Error("formal window source set has no usable URLs");
  }
  const sourceSetHash = sha256(sourceText);
  const sourceSnapshotPath = path.join(runDir, "source_set_t0.txt");
  await writeTextAtomic(sourceSnapshotPath, sourceText);
  const proposedStartedAt = new Date();
  const runtimeDbPath = runtimeStateDatabasePath(config);
  const sqliteGate = initializeSubmissionGate({
    dbPath: runtimeDbPath,
    runId: currentRun.run_id,
    runDir,
    targetSkus: directPublish ? [] : frozenReadySkus.slice(0, 3),
    startedAt: proposedStartedAt.toISOString(),
    phase: directPublish ? "released" : "active",
    result: directGateResult,
  });
  const startedAt = new Date(sqliteGate.startedAt);
  const endedAt = new Date(startedAt.getTime() + Number(config.acceptance.duration_seconds) * 1000);
  const frozenTarget = 500;
  const targetPolicy = "fixed";
  const preflight = await readJson(path.join(stateRoot, "capacity_preflight.json"));
  const configText = await fsp.readFile(path.join(appRoot, "config", "ozon_24h_production.json"), "utf8");
  const crypto = await import("node:crypto");
  const configHash = crypto.createHash("sha256").update(configText).digest("hex");
  const stagedGates = buildStagedGateState({
    runId: currentRun.run_id,
    runDir,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    targetSkus: sqliteGate.targetSkus,
    operatorDirectPublish: directAuthorization,
    identity: {
      commit_sha: config.frozen_commit || "",
      config_sha256: configHash,
      source_set_sha256: sourceSetHash,
      state_schema_version: Number(config.state_schema_version || 3),
    },
  });
  await writeJsonAtomic(path.join(runDir, "staged_acceptance_gates.json"), stagedGates);
  await updateLiveProcessState(runDir, {
    formal_worker_started_at: null,
    worker_generation: 0,
    active_worker_pid: null,
    recovery_pending: false,
    recovery_started_at: null,
  });
  await writeJsonAtomic(path.join(runDir, "acceptance_window.json"), {
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    acceptance_target: frozenTarget,
    acceptance_target_policy: targetPolicy,
    per_store_target: 100,
    rolling_rate_window_minutes: 120,
    minimum_average_per_hour_exclusive: 35,
    current_window_only: true,
  });
  const preparedSourceConfig = await readJson(path.join(runDir, "source_config.json"), {});
  await writeJsonAtomic(path.join(runDir, "source_config.json"), {
    ...preparedSourceConfig,
    mode: "continuous-acceptance",
    window_started_at: startedAt.toISOString(),
    window_ended_at: endedAt.toISOString(),
    publish_target: 500,
    acceptance_target: 500,
    acceptance_target_policy: "fixed",
    minimum_average_per_hour_exclusive: 35,
    per_store_target: 100,
    require_quality_evidence: true,
    current_window_only: true,
    source_set_sha256: sourceSetHash,
    source_set_snapshot: sourceSnapshotPath,
    store_targets: (config.stores || []).map((store) => ({
      id: Number(store.id),
      needle: String(store.name || ""),
      warehouseId: Number(store.warehouse_id),
      requireWarehouse: true,
    })),
    daily_store_timezone: "Asia/Shanghai",
  });
  await writeJsonAtomic(path.join(runDir, "frozen_manifest.json"), {
    run_id: currentRun.run_id,
    requested_at: currentRun.requested_at,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    commit_sha: config.frozen_commit || null,
    config_sha256: configHash,
    source_set_sha256: sourceSetHash,
    source_set_snapshot: sourceSnapshotPath,
    state_schema_version: Number(config.state_schema_version || 3),
    capacity_preflight: preflight,
    acceptance_target: frozenTarget,
    acceptance_target_policy: targetPolicy,
    per_store_target: 100,
    rolling_rate_window_minutes: 120,
    minimum_strict_per_hour: 35,
    current_window_only: true,
  });
  await appendJsonLine(path.join(runDir, "live_gate_evidence.jsonl"), {
    type: "candidate-buffer",
    at: startedAt.toISOString(),
    ready_unique: frozenReadySkus.length,
    added_unique: frozenReadySkus.length,
    source: "formal-window-initial-qualified-buffer",
  });
  await appendJsonLine(path.join(runDir, "source_set_epochs.jsonl"), {
    type: "source-set-epoch",
    at: startedAt.toISOString(),
    epoch: 0,
    source_set_sha256: sourceSetHash,
    previous_source_set_sha256: null,
    update_interval_seconds: 7_200,
  });
  Object.assign(currentRun, {
    formal_started: true,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    config_sha256: configHash,
    source_sha256: sourceSetHash,
    source_set_sha256: sourceSetHash,
    source_set_snapshot: sourceSnapshotPath,
    source_set_frozen_at: startedAt.toISOString(),
    active_source_set_sha256: sourceSetHash,
    source_set_epoch: 0,
    acceptance_target: frozenTarget,
    acceptance_target_policy: targetPolicy,
  });
  await writeJsonAtomic(path.join(stateRoot, "current_run.json"), currentRun);
}

async function waitForVerification({
  stateRoot,
  currentRun,
  appRoot,
  runDir,
  stopFile,
  checkpointEnv = process.env,
}) {
  const resumeFile = path.join(stateRoot, "resume.request");
  await clearStaleVerificationResumeRequest(stateRoot);
  await updateOperationalState(stateRoot, currentRun, {
    status: "WAITING_FOR_VERIFICATION",
    reason: "CAPTCHA, slider, MFA, or account security verification is required",
    resume_file: resumeFile,
  });
  while (!fs.existsSync(resumeFile) && !fs.existsSync(stopFile) && !await acceptanceEnded(runDir)) {
    await delay(30_000);
  }
  if (fs.existsSync(resumeFile)) await fsp.unlink(resumeFile).catch(() => {});
  await runCheckpoint(appRoot, runDir, "verification-wait", checkpointEnv);
}

export async function clearStaleVerificationResumeRequest(stateRoot) {
  const resumeFile = path.join(absolute(stateRoot), "resume.request");
  try {
    await fsp.unlink(resumeFile);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeProcessOwners({
  stateRoot,
  currentRun,
  browserPid,
  workerPid = null,
  supervisorPid = process.pid,
}) {
  await writeJsonAtomic(path.join(stateRoot, "process_owners.json"), {
    observed_at: new Date().toISOString(),
    run_id: currentRun.run_id,
    supervisor_pid: supervisorPid,
    worker_pid: workerPid,
    profile_owner_pid: browserPid,
    counts: {
      supervisor: supervisorPid ? 1 : 0,
      worker: workerPid ? 1 : 0,
      profile_owner: browserPid ? 1 : 0,
    },
  });
}

function qualifiedValidationTimestamp(row) {
  return Date.parse(String(row?.validated_at || row?.at || row?.timestamp || ""));
}

async function captureLiveGateEvidence({
  config,
  stateRoot,
  currentRun,
  runDir,
}) {
  const gateState = await readJson(path.join(runDir, "staged_acceptance_gates.json"), {});
  if (!gateState?.formal_started_at || !gateState?.identity) {
    throw new Error("staged acceptance gate state is missing");
  }
  const runtimeDbPath = runtimeStateDatabasePath(config);
  const loaded = await loadLiveAcceptanceEvidence({
    runDir,
    stateRoot,
    runtimeDbPath,
  });
  const evidenceFile = path.join(runDir, "live_gate_evidence.jsonl");
  const priorEvidence = await readJsonLines(evidenceFile);
  const liveProcessState = await readJson(liveProcessStatePath(runDir));
  const sourceEpochs = await readJsonLines(path.join(runDir, "source_set_epochs.jsonl"));
  const activeSourceText = await fsp.readFile(currentRun.urls_file, "utf8");
  const activeSourceSetHash = sha256(activeSourceText);
  const activeSourceEpoch = sourceEpochs.at(-1) || null;
  const previousSnapshot = priorEvidence
    .filter((event) => event?.type === "process-snapshot")
    .at(-1) || null;
  const previousAt = Date.parse(String(previousSnapshot?.at || gateState.formal_started_at));
  const now = new Date();
  const validationRows = await readJsonLines(path.join(runDir, "validation_gate.jsonl"));
  const consumedSkus = new Set(loaded.runtimeEvents.map((row) => String(row?.sku || "").trim()).filter(Boolean));
  const consumedBefore = new Set(loaded.runtimeEvents.filter((row) => {
    const at = Date.parse(String(row?.occurredAt || row?.occurred_at || ""));
    return Number.isFinite(at) && at <= previousAt;
  }).map((row) => String(row?.sku || "").trim()).filter(Boolean));
  const bufferInflow = candidateBufferInflow(validationRows, {
    consumedSkus,
    consumedBeforeSkus: consumedBefore,
    previousAt: new Date(previousAt).toISOString(),
    observedAt: now.toISOString(),
  });
  const buffer = bufferInflow.current;
  const ownership = processOwnershipSnapshot(await processTable(), {
    supervisorPid: process.pid,
    runDir,
    profileDir: config.browser.profile_dir,
  });
  const snapshot = {
    type: "process-snapshot",
    at: now.toISOString(),
    run_id: currentRun.run_id,
    commit_sha: gateState.identity.commit_sha,
    config_sha256: gateState.identity.config_sha256,
    source_set_sha256: gateState.identity.source_set_sha256,
    active_source_set_sha256: activeSourceSetHash,
    source_set_epoch: Number(activeSourceEpoch?.epoch || 0),
    source_set_epoch_authorized: Boolean(
      activeSourceEpoch
      && String(activeSourceEpoch.source_set_sha256 || "") === activeSourceSetHash
    ),
    state_schema_version: Number(gateState.identity.state_schema_version),
    supervisor_count: ownership.supervisor,
    worker_count: ownership.worker,
    profile_owner_count: ownership.profile_owner,
    expected_worker_count: liveProcessState.formal_worker_started_at
      && liveProcessState.recovery_pending !== true ? 1 : 0,
    expected_profile_owner_count: liveProcessState.recovery_pending === true ? 0 : 1,
    formal_worker_started: Boolean(liveProcessState.formal_worker_started_at),
    formal_worker_started_at: liveProcessState.formal_worker_started_at,
    worker_generation: Number(liveProcessState.worker_generation || 0),
    active_worker_pid: Number(liveProcessState.active_worker_pid) || null,
    recovery_pending: liveProcessState.recovery_pending === true,
    recovery_started_at: liveProcessState.recovery_started_at || null,
    orphan_browser_count: Math.max(0, ownership.profile_owner - 1),
    supervisor_pids: ownership.supervisor_pids,
    worker_pids: ownership.worker_pids,
    profile_owner_pids: ownership.profile_owner_pids,
    state_integrity: loaded.state.integrity,
    state_event_count: loaded.state.event_count,
    state_max_event_id: loaded.state.max_event_id,
    state_strict_count: loaded.state.strict_count,
    previous_snapshot_hash: previousSnapshot?.snapshot_hash || null,
  };
  snapshot.snapshot_hash = evidenceSnapshotHash(snapshot);
  await appendJsonLine(evidenceFile, snapshot);
  await appendJsonLine(evidenceFile, {
    type: "candidate-buffer",
    at: now.toISOString(),
    ready_unique: buffer.unique_ready,
    added_unique: bufferInflow.added_unique,
    consumed_unique: consumedSkus.size,
    source: "qualified-validation-buffer-net-inflow",
  });
  return {
    snapshot,
    buffer,
    qualified_inflow: bufferInflow.added_unique,
    live: loaded,
    gate_state: gateState,
  };
}

function stagedGateFailureReason(gateName) {
  return {
    three_sku: "three-sku-production-gate-failed",
    thirty_minute: "thirty-minute-production-gate-failed",
    two_hour_a: "two-hour-a-production-gate-failed",
    two_hour_b: "two-hour-b-production-gate-failed",
    twenty_four_hour: "twenty-four-hour-production-gate-failed",
  }[gateName] || "production-acceptance-gate-failed";
}

export function submissionGateConvergenceDecision({
  jsonGate,
  sqliteGate,
  runId,
  runDir,
} = {}) {
  const jsonPhase = String(jsonGate?.phase || "");
  const sqliteMatches = sqliteGate
    && String(sqliteGate.run_id) === String(runId || "")
    && String(sqliteGate.run_dir || "").trim()
    && path.resolve(String(sqliteGate.run_dir)) === path.resolve(String(runDir || ""))
    && Number(sqliteGate.distinct_sku_budget) === 3;
  if (jsonPhase === "failed" || sqliteGate?.phase === "failed") {
    return { action: "safe-stop", reason: "persisted-submission-gate-failed" };
  }
  if (!sqliteMatches || (jsonPhase === "released" && sqliteGate.phase !== "released")) {
    return { action: "safe-stop", reason: "submission-gate-state-mismatch" };
  }
  return { action: "continue", reason: null };
}

async function failLiveStagedGate({
  config,
  stateRoot,
  currentRun,
  runDir,
  gateState,
  gateName,
  result,
  reason = stagedGateFailureReason(gateName),
}) {
  const failedAt = new Date().toISOString();
  gateState.submission_gate.phase = "failed";
  if (gateState.gates?.[gateName]) {
    Object.assign(gateState.gates[gateName], {
      status: "failed",
      evaluated_at: failedAt,
      result,
    });
  }
  let sqliteFailure = null;
  try {
    failSubmissionGate({
      dbPath: runtimeStateDatabasePath(config),
      runId: currentRun.run_id,
      failedAt,
      result: { gate: gateName, reason, result },
    });
  } catch (error) {
    sqliteFailure = String(error?.message || error);
  }
  await writeJsonAtomic(path.join(runDir, "staged_acceptance_gates.json"), gateState);
  await updateOperationalState(stateRoot, currentRun, {
    status: "STOPPED",
    reason,
    acceptance_gate: gateName,
    gate_result: result,
    evidence_preserved: true,
    ...(sqliteFailure ? { sqlite_gate_failure: sqliteFailure } : {}),
  });
  return {
    action: "safe-stop",
    reason,
    gate: gateName,
    result,
    ...(sqliteFailure ? { sqlite_gate_failure: sqliteFailure } : {}),
  };
}

async function evaluateDueLiveGates({
  config,
  stateRoot,
  currentRun,
  runDir,
  now = new Date(),
}) {
  const gateFile = path.join(runDir, "staged_acceptance_gates.json");
  const gateState = await readJson(gateFile, {});
  if (!gateState?.submission_gate || !gateState?.gates) {
    throw new Error("staged acceptance gate state is missing");
  }
  const loaded = await loadLiveAcceptanceEvidence({
    runDir,
    stateRoot,
    runtimeDbPath: runtimeStateDatabasePath(config),
  });
  const sqliteGate = loaded.state.submission_gate;
  const convergence = submissionGateConvergenceDecision({
    jsonGate: gateState.submission_gate,
    sqliteGate,
    runId: currentRun.run_id,
    runDir,
  });
  const failedGateEntry = Object.entries(gateState.gates)
    .find(([, value]) => value?.status === "failed");
  if (convergence.reason === "persisted-submission-gate-failed") {
    const [failedGateName = "three_sku", failedGate = {}] = failedGateEntry || [];
    return failLiveStagedGate({
      config,
      stateRoot,
      currentRun,
      runDir,
      gateState,
      gateName: failedGateName,
      result: failedGate.result || sqliteGate?.result || { passed: false },
      reason: stagedGateFailureReason(failedGateName),
    });
  }
  if (convergence.reason === "submission-gate-state-mismatch") {
    return failLiveStagedGate({
      config,
      stateRoot,
      currentRun,
      runDir,
      gateState,
      gateName: "three_sku",
      result: {
        passed: false,
        reason: "submission-gate-state-mismatch",
        json_phase: gateState.submission_gate.phase,
        sqlite_gate: sqliteGate,
      },
      reason: "submission-gate-state-mismatch",
    });
  }
  const terminalFailures = acceptedTerminalFailures(loaded.runtimeEvents);
  if (terminalFailures.length > 0) {
    return failLiveStagedGate({
      config,
      stateRoot,
      currentRun,
      runDir,
      gateState,
      gateName: "three_sku",
      result: { passed: false, accepted_terminal_failures: terminalFailures },
      reason: "accepted-submission-cannot-reach-strict",
    });
  }
  const identity = gateState.identity;
  const targetSkus = gateState.submission_gate.target_skus;
  const nowMs = now.getTime();
  if (gateState.gates.three_sku.status === "pending") {
    const three = evaluateLiveStagedGate({
      gate: "three-sku",
      events: loaded.events,
      targetSkus,
      expectedIdentity: identity,
      requireStateEvidence: true,
    });
    const timeoutAt = Date.parse(gateState.formal_started_at) + 30 * 60_000;
    if (three.unclosed_skus.length === 0 || nowMs >= timeoutAt) {
      if (!three.passed) {
        return failLiveStagedGate({
          config,
          stateRoot,
          currentRun,
          runDir,
          gateState,
          gateName: "three_sku",
          result: three,
        });
      }
      const passedAt = now.toISOString();
      releaseSubmissionGate({
        dbPath: runtimeStateDatabasePath(config),
        runId: currentRun.run_id,
        releasedAt: passedAt,
        result: three,
      });
      gateState.submission_gate.phase = "released";
      Object.assign(gateState.gates.three_sku, {
        ended_at: passedAt,
        status: "passed",
        evaluated_at: passedAt,
        result: three,
      });
      await writeJsonAtomic(gateFile, gateState);
    }
  }
  if (gateState.gates.three_sku.status !== "passed") {
    return { action: "continue", gate: "three_sku", status: "pending" };
  }
  for (const [gateName, replayGate] of [
    ["thirty_minute", "30-minute"],
    ["two_hour_a", "two-hour"],
    ["two_hour_b", "two-hour"],
  ]) {
    const gate = gateState.gates[gateName];
    if (gate.status !== "pending" || nowMs < Date.parse(gate.ended_at)) continue;
    const result = evaluateLiveStagedGate({
      gate: replayGate,
      events: loaded.events,
      startedAt: gate.started_at,
      endedAt: gate.ended_at,
      expectedIdentity: identity,
      minimumCandidateBuffer: 70,
      requireStateEvidence: true,
    });
    if (!result.passed) {
      return failLiveStagedGate({
        config,
        stateRoot,
        currentRun,
        runDir,
        gateState,
        gateName,
        result,
      });
    }
    Object.assign(gate, {
      status: "passed",
      evaluated_at: now.toISOString(),
      result,
    });
    await writeJsonAtomic(gateFile, gateState);
  }
  return { action: "continue", gate: null, status: "healthy" };
}

async function superviseDirectPublishing({
  config,
  appRoot,
  stateRoot,
  currentRun,
  runDir,
  urlsFile,
  stopFile,
  releaseLock,
}) {
  let worker = null;
  let shuttingDown = false;
  let restartAttempt = 0;
  const stopWorker = async () => {
    await stopOwnedWorker(worker);
    worker = null;
  };
  const onSignal = () => {
    shuttingDown = true;
    void stopWorker();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("SIGHUP", onSignal);
  try {
    await fsp.mkdir(runDir, { recursive: true });
    while (!shuttingDown) {
      if (fs.existsSync(stopFile)) {
        await stopWorker();
        await fsp.unlink(stopFile).catch(() => {});
        await updateOperationalState(stateRoot, currentRun, {
          status: "STOPPED",
          reason: "safe stop requested",
        });
        return 0;
      }
      let browserOwner;
      try {
        await assertProcessOwnership({
          phase: "before-worker",
          runDir,
          profileDir: config.browser.profile_dir,
        });
        browserOwner = await ensureBrowserOwner({ config, stateRoot, runDir });
      } catch (error) {
        const owners = await profileOwners(absolute(config.browser.profile_dir)).catch(() => []);
        const decision = classifyWorkerFailure({
          message: error?.message,
          profileOwnerCount: owners.length,
        });
        if (decision.action === "fatal-stop") {
          await updateOperationalState(stateRoot, currentRun, {
            status: "FATAL_STOP",
            reason: decision.reason,
            error: String(error?.message || error),
          });
          return 0;
        }
        const seconds = nextRestartDelaySeconds(restartAttempt++, config.restart_delays_seconds);
        await updateOperationalState(stateRoot, currentRun, {
          status: decision.action === "wait-for-verification"
            ? "WAITING_FOR_VERIFICATION"
            : "RECOVERING",
          reason: decision.reason,
          retry_in_seconds: seconds,
        });
        if (decision.action === "wait-for-verification") {
          await waitForVerification({
            stateRoot,
            currentRun,
            appRoot,
            runDir,
            stopFile,
            checkpointEnv: workerEnvironment(config, currentRun),
          });
        } else {
          await delay(seconds * 1000);
        }
        continue;
      }

      const stdoutFd = fs.openSync(path.join(runDir, "console.log"), "a");
      const stderrPath = path.join(runDir, "stderr.log");
      const runtimeErrorsPath = path.join(runDir, "runtime_errors.jsonl");
      const stderrOffset = await fileSize(stderrPath);
      const runtimeErrorsOffset = await fileSize(runtimeErrorsPath);
      const stderrFd = fs.openSync(stderrPath, "a");
      const startedAt = Date.now();
      const persistedStore = await readJson(path.join(runDir, "current_store.json"), {});
      const runtimeRun = {
        ...currentRun,
        current_store_id: Number(persistedStore?.store_id || currentRun.current_store_id || config.starting_store_id || 0),
      };
      worker = spawn(process.execPath, [
        path.join(appRoot, "scripts", "flow_b_playwright.mjs"),
        "run",
        runDir,
        urlsFile,
      ], {
        cwd: appRoot,
        env: workerEnvironment(config, runtimeRun),
        stdio: ["ignore", stdoutFd, stderrFd],
      });
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
      await writeProcessOwners({
        stateRoot,
        currentRun,
        browserPid: browserOwner.pid,
        workerPid: worker.pid,
      });
      await updateOperationalState(stateRoot, currentRun, {
        status: "RUNNING",
        reason: null,
        target_metric: Number(config.publish_target) === 0
          ? "daily_erp_accepted_unique_skus"
          : "erp_accepted_unique_skus",
        target: Number(config.publish_target) === 0 ? null : Number(config.publish_target),
        unlimited: Number(config.publish_target) === 0,
        worker_pid: Number(worker.pid) || null,
      });
      const activeWorker = worker;
      const result = await waitForWorkerOrBrowserFailure(activeWorker, {
        cdpEndpoint: config.browser.cdp_endpoint,
        probeIntervalMs: config.browser.cdp_health_interval_ms,
        probeTimeoutMs: config.browser.cdp_health_timeout_ms,
        failureThreshold: config.browser.cdp_health_failure_threshold,
      });
      if (result.browser_unhealthy) await stopOwnedWorker(activeWorker);
      worker = null;
      await writeProcessOwners({ stateRoot, currentRun, browserPid: browserOwner.pid, workerPid: null });
      const evidence = await readWorkerGenerationEvidence({
        stderrPath,
        runtimeErrorsPath,
        stderrOffset,
        runtimeErrorsOffset,
        error: result.error,
      });
      if (shuttingDown) break;
      if (result.code === 0 && !result.browser_unhealthy && Number(config.publish_target) > 0) {
        await updateOperationalState(stateRoot, currentRun, {
          status: "TARGET_COMPLETE",
          reason: "erp-accepted-target-reached",
          target_metric: "erp_accepted_unique_skus",
          target: Number(config.publish_target) || 500,
        });
        return 0;
      }
      if (/FLOW_B_ALL_STORES_REJECTED|all configured stores rejected direct publishing/iu.test(evidence)) {
        await updateOperationalState(stateRoot, currentRun, {
          status: "FATAL_STOP",
          reason: "all-configured-stores-rejected",
          evidence_preserved: true,
        });
        return 0;
      }
      const owners = await profileOwners(absolute(config.browser.profile_dir)).catch(() => []);
      const decision = classifyWorkerFailure({ message: evidence, profileOwnerCount: owners.length });
      if (decision.action === "fatal-stop") {
        await updateOperationalState(stateRoot, currentRun, {
          status: "FATAL_STOP",
          reason: decision.reason,
          evidence_preserved: true,
        });
        return 0;
      }
      if (Date.now() - startedAt >= 10 * 60_000) restartAttempt = 0;
      const seconds = nextRestartDelaySeconds(restartAttempt++, config.restart_delays_seconds);
      await appendJsonLine(path.join(stateRoot, "recovery.jsonl"), {
        at: new Date().toISOString(),
        run_dir: runDir,
        action: decision.action,
        reason: decision.reason,
        delay_seconds: seconds,
      });
      await updateOperationalState(stateRoot, currentRun, {
        status: decision.action === "wait-for-verification"
          ? "WAITING_FOR_VERIFICATION"
          : "RECOVERING",
        reason: decision.reason,
        retry_in_seconds: seconds,
      });
      if (decision.action === "wait-for-verification") {
        await waitForVerification({
          stateRoot,
          currentRun,
          appRoot,
          runDir,
          stopFile,
          checkpointEnv: workerEnvironment(config, currentRun),
        });
      } else {
        await delay(seconds * 1000);
      }
    }
    await updateOperationalState(stateRoot, currentRun, {
      status: "STOPPED",
      reason: "supervisor signal received",
    });
    return 0;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("SIGHUP", onSignal);
    await stopWorker();
    await releaseLock();
  }
}

export async function supervise(configPath) {
  const config = expandedConfig(await readJson(configPath));
  // Node resolves an invoked symlink to the real release path for import.meta.
  // Spawn child entry points from that same release so their main-module guard
  // executes instead of silently returning code 0.
  const appRoot = resolveSupervisorAppRoot();
  const deployment = await readJson(path.join(appRoot, "deployment_manifest.json"), {});
  config.frozen_commit = deployment?.source_commit || null;
  config.frozen_config_hash = deployment?.config_sha256 || null;
  const stateRoot = absolute(config.state_root, path.join(DEFAULT_INSTALL_ROOT, "state"));
  const currentRunPath = path.join(stateRoot, "current_run.json");
  const releaseLock = await acquireSupervisorLock(stateRoot);
  const currentRun = await readJson(currentRunPath, {});
  const disposition = currentRunDisposition(currentRun);
  if (disposition === "idle") {
    await writeJsonAtomic(path.join(stateRoot, "operational_status.json"), {
      observed_at: new Date().toISOString(),
      status: "IDLE",
      reason: "no active production run",
    });
    await releaseLock();
    return 0;
  }
  if (disposition === "invalid") {
    await releaseLock();
    const error = new Error(`invalid current run state: ${currentRunPath}`);
    error.code = "OZON_INVALID_CURRENT_RUN";
    throw error;
  }
  const configText = await fsp.readFile(configPath, "utf8");
  const actualConfigHash = sha256(configText);
  const deploymentIssues = [];
  if (!String(deployment?.source_commit || "")) deploymentIssues.push("deployment-commit-missing");
  if (String(deployment?.config_sha256 || "") !== actualConfigHash) {
    deploymentIssues.push("deployment-config-hash-mismatch");
  }
  if (Number(deployment?.state_schema_version) !== 3) deploymentIssues.push("deployment-state-schema-not-v3");
  if (deploymentIssues.length > 0) {
    await updateOperationalState(stateRoot, currentRun, {
      status: "FATAL_STOP",
      reason: "deployment-identity-invalid",
      issues: deploymentIssues,
      evidence_preserved: true,
    });
    await releaseLock();
    return 0;
  }
  const startupStatus = await readJson(path.join(stateRoot, "operational_status.json"), {});
  if (supervisorShouldHonorSafeStop(startupStatus)) {
    await releaseLock();
    return 0;
  }
  const runDir = absolute(currentRun.run_dir);
  const urlsFile = absolute(currentRun.urls_file);
  const stopFile = path.join(stateRoot, "stop.request");
  const statePathIssues = [];
  if (path.dirname(runDir) !== path.join(stateRoot, "runs")) {
    statePathIssues.push("run-directory-outside-state-root");
  }
  if (urlsFile !== path.join(stateRoot, "sources", "active_urls.txt")) {
    statePathIssues.push("source-file-outside-state-root");
  }
  if (statePathIssues.length > 0) {
    await updateOperationalState(stateRoot, currentRun, {
      status: "FATAL_STOP",
      reason: "production-state-path-invalid",
      issues: statePathIssues,
      evidence_preserved: true,
    });
    await releaseLock();
    return 0;
  }
  if (config.runtime_mode === "direct") {
    return superviseDirectPublishing({
      config,
      appRoot,
      stateRoot,
      currentRun,
      runDir,
      urlsFile,
      stopFile,
      releaseLock,
    });
  }
  const runContract = productionRunContractDecision({
    currentRun,
    pendingManifest: await readJson(path.join(runDir, "pending_manifest.json"), {}),
    acceptanceWindow: await readJson(path.join(runDir, "acceptance_window.json"), {}),
    sourceConfig: await readJson(path.join(runDir, "source_config.json"), {}),
    frozenManifest: await readJson(path.join(runDir, "frozen_manifest.json"), {}),
    expectedConfigHash: actualConfigHash,
    expectedCommitSha: deployment.source_commit,
  });
  if (runContract.action !== "continue") {
    await updateOperationalState(stateRoot, currentRun, {
      status: "FATAL_STOP",
      reason: runContract.reason,
      issues: runContract.issues,
      evidence_preserved: true,
    });
    await releaseLock();
    return 0;
  }
  let worker = null;
  let checkpointTimer = null;
  let sourceRefreshTimer = null;
  let gateTimer = null;
  let shuttingDown = false;
  let forcedSafeStopReason = null;
  let browserRecoveryEvents = [];
  let browserRecoveryPending = false;
  const stopWorker = async () => {
    const activeWorker = worker;
    await stopOwnedWorker(activeWorker);
  };
  const onSignal = () => {
    shuttingDown = true;
    void stopWorker();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("SIGHUP", onSignal);
  try {
    await fsp.mkdir(runDir, { recursive: true });
    browserRecoveryEvents = (await readJsonLines(path.join(stateRoot, "recovery.jsonl")))
      .filter((event) => (
        path.resolve(String(event?.run_dir || "")) === runDir
        && event?.action === "browser-recovery-attempt"
      ));
    if (currentRun.formal_started === true) {
      const persistedLiveProcessState = await readJson(liveProcessStatePath(runDir));
      browserRecoveryPending = persistedLiveProcessState.recovery_pending === true;
    }
    const ensureOwnedBrowser = async () => {
      try {
        const owner = await ensureBrowserOwner({ config, stateRoot, runDir });
        if (browserRecoveryPending) {
          const succeeded = {
            at: new Date().toISOString(),
            run_dir: runDir,
            action: "browser-recovery-attempt",
            outcome: "succeeded",
            profile_owner_pid: owner.pid,
          };
          browserRecoveryEvents.push(succeeded);
          await appendJsonLine(path.join(stateRoot, "recovery.jsonl"), succeeded);
          browserRecoveryPending = false;
          if (currentRun.formal_started === true) {
            await updateLiveProcessState(runDir, {
              recovery_pending: false,
              recovery_completed_at: succeeded.at,
              recovery_started_at: null,
            });
          }
        }
        return owner;
      } catch (error) {
        const failed = {
          at: new Date().toISOString(),
          run_dir: runDir,
          action: "browser-recovery-attempt",
          outcome: "failed",
          error: String(error?.message || error),
        };
        browserRecoveryEvents.push(failed);
        browserRecoveryPending = true;
        await appendJsonLine(path.join(stateRoot, "recovery.jsonl"), failed);
        if (currentRun.formal_started === true) {
          const processState = await readJson(liveProcessStatePath(runDir));
          await updateLiveProcessState(runDir, {
            recovery_pending: true,
            recovery_started_at: processState.recovery_started_at || failed.at,
          });
        }
        const recoveryDecision = browserRecoverySafeStopDecision(browserRecoveryEvents);
        if (recoveryDecision.action === "safe-stop") {
          const stopped = new Error(recoveryDecision.reason);
          stopped.code = "OZON_BROWSER_RECOVERY_SAFE_STOP";
          stopped.recovery = recoveryDecision;
          throw stopped;
        }
        throw error;
      }
    };
    await assertProcessOwnership({
      phase: "before-worker",
      runDir,
      profileDir: config.browser.profile_dir,
    });
    const sourceRefresh = await runInitialSourceRefresh({
      appRoot,
      stateRoot,
      runDir,
      currentRun,
    });
    if (sourceRefresh.code !== 0) throw new Error("initial source portfolio refresh failed");
    while (currentRun.formal_started === false && !shuttingDown) {
      if (fs.existsSync(stopFile)) {
        await updateOperationalState(stateRoot, currentRun, {
          status: "STOPPED",
          reason: "safe stop requested before formal window",
        });
        await fsp.unlink(stopFile).catch(() => {});
        return 0;
      }
      let browserOwner;
      try {
        browserOwner = await ensureOwnedBrowser();
        await assertProcessOwnership({
          phase: "browser-ready",
          runDir,
          profileDir: config.browser.profile_dir,
        });
        await writeProcessOwners({ stateRoot, currentRun, browserPid: browserOwner.pid });
        const result = await runCapacityPreflight(config, appRoot, stateRoot, currentRun);
        if (result.code !== 0) throw result.error || new Error(`capacity preflight exited ${result.code}`);
        const snapshot = await readJson(path.join(stateRoot, "capacity_preflight.json"));
        const decision = capacityPreflightDecision(
          snapshot,
          config.acceptance.strict_target,
          config.acceptance.target_policy,
          {
            allowCurrentDayShortfall:
              config?.operator_direct_publish?.allow_current_day_capacity_shortfall === true,
          },
        );
        if (decision.action === "fatal-stop") {
          await updateOperationalState(stateRoot, currentRun, {
            status: "FATAL_STOP",
            reason: decision.reason,
            capacity_preflight: snapshot,
          });
          return 0;
        }
        if (decision.action === "start-formal-window") {
          const directPublish = config?.operator_direct_publish?.enabled === true;
          if (decision.reason === "operator-authorized-current-day-capacity-shortfall") {
            await appendJsonLine(path.join(runDir, "live_gate_evidence.jsonl"), {
              type: "operator-capacity-override",
              at: new Date().toISOString(),
              authorized_by: config.operator_direct_publish.authorized_by,
              authorized_at: config.operator_direct_publish.authorized_at,
              reason: config.operator_direct_publish.reason,
              total_remaining_capacity: decision.total_remaining_capacity,
              fixed_target: decision.required_capacity,
              target_reduced: false,
            });
          }
          const validationRows = await readJsonLines(path.join(runDir, "validation_gate.jsonl"));
          const bufferBefore = candidateBufferSnapshot(validationRows);
          const bufferDecision = candidateBufferDecision({
            uniqueReady: bufferBefore.unique_ready,
            targetHours: directPublish ? 0 : (config.candidate_buffer?.minimum_hours || 2),
            minimumPerHour: directPublish ? 0 : (config.candidate_buffer?.minimum_strict_per_hour || 35),
            minimumReadyCandidates: directPublish
              ? Number(config.operator_direct_publish.minimum_ready_candidates)
              : (config.candidate_buffer?.minimum_ready_candidates || 70),
          });
          if (bufferDecision.action === "ready") {
            await activateFormalWindow({
              config,
              stateRoot,
              currentRun,
              runDir,
              appRoot,
              readySkus: bufferBefore.ready_skus,
            });
            break;
          }
          const refreshed = await runSourceRefresh(appRoot, stateRoot, runDir);
          if (refreshed.code !== 0) throw new Error("candidate-buffer source refresh failed");
          const prepareStartedAt = new Date();
          worker = spawnCandidateBufferPreparation(
            config,
            appRoot,
            runDir,
            urlsFile,
            currentRun,
            bufferDecision.required_ready - bufferDecision.unique_ready,
          );
          const preparationResult = new Promise((resolve) => {
            worker.once("error", (error) => resolve({ code: 127, signal: null, error }));
            worker.once("exit", (code, signal) => resolve({
              code: Number(code ?? 1),
              signal,
              error: null,
            }));
          });
          if (pidAlive(worker.pid)) {
            await assertProcessOwnership({
              phase: "worker-running",
              runDir,
              profileDir: config.browser.profile_dir,
            });
          }
          await writeProcessOwners({
            stateRoot,
            currentRun,
            browserPid: browserOwner.pid,
            workerPid: worker.pid,
          });
          await updateOperationalState(stateRoot, currentRun, {
            status: "PREPARING_CANDIDATE_BUFFER",
            reason: directPublish
              ? "operator-direct-production requires three fully-qualified initial SKUs"
              : "two-hour fully-qualified candidate buffer is below the hard gate",
            unique_ready: bufferDecision.unique_ready,
            required_ready: bufferDecision.required_ready,
            preparation_started_at: prepareStartedAt.toISOString(),
            operator_direct_publish: directPublish,
          });
          const prepared = await preparationResult;
          worker = null;
          await assertProcessOwnership({
            phase: "browser-ready",
            runDir,
            profileDir: config.browser.profile_dir,
          });
          const bufferAfter = candidateBufferSnapshot(
            await readJsonLines(path.join(runDir, "validation_gate.jsonl")),
          );
          await writeJsonAtomic(path.join(stateRoot, "candidate_buffer_status.json"), {
            run_id: currentRun.run_id,
            observed_at: new Date().toISOString(),
            required_ready: bufferDecision.required_ready,
            ...bufferAfter,
            preparation_exit_code: prepared.code,
            preparation_signal: prepared.signal,
          });
          if (prepared.code !== 0) {
            throw prepared.error || new Error(`candidate-buffer preparation exited ${prepared.code}`);
          }
          if (bufferAfter.unique_ready <= bufferBefore.unique_ready) {
            throw new Error("qualified candidate buffer did not grow");
          }
          if (bufferAfter.unique_ready >= bufferDecision.required_ready) {
            await activateFormalWindow({
              config,
              stateRoot,
              currentRun,
              runDir,
              appRoot,
              readySkus: bufferAfter.ready_skus,
            });
            break;
          }
          continue;
        }
        throw new Error(`unexpected capacity preflight decision: ${decision.action}`);
      } catch (error) {
        if (error?.code === "OZON_BROWSER_RECOVERY_SAFE_STOP") {
          forcedSafeStopReason = error.recovery?.reason || "repeated-browser-recovery-failure";
          await updateOperationalState(stateRoot, currentRun, {
            status: "STOPPED",
            reason: forcedSafeStopReason,
            recovery: error.recovery || null,
            evidence_preserved: true,
          });
          return 0;
        }
        if (error?.code === "OZON_PROCESS_OWNERSHIP") {
          await updateOperationalState(stateRoot, currentRun, {
            status: "FATAL_STOP",
            reason: String(error.message),
            ownership: error.ownership || null,
          });
          return 0;
        }
        const evidence = `${error?.message || error}\n${await readTail(path.join(stateRoot, "capacity.stderr.log"))}`;
        const owners = await profileOwners(absolute(config.browser.profile_dir)).catch(() => []);
        const decision = classifyWorkerFailure({ message: evidence, profileOwnerCount: owners.length });
        if (decision.action === "fatal-stop") {
          await updateOperationalState(stateRoot, currentRun, {
            status: "FATAL_STOP",
            reason: decision.reason,
            error: String(error?.message || error),
          });
          return 0;
        }
        if (decision.action === "wait-for-verification") {
          await waitForVerification({
            stateRoot,
            currentRun,
            appRoot,
            runDir,
            stopFile,
            checkpointEnv: checkpointEnvironment(config, currentRun),
          });
          continue;
        }
        const seconds = nextRestartDelaySeconds(0, config.restart_delays_seconds);
        await updateOperationalState(stateRoot, currentRun, {
          status: "RECOVERING",
          reason: "capacity-preflight-recoverable",
          retry_in_seconds: seconds,
        });
        await delay(seconds * 1000);
      }
    }
    if (shuttingDown) {
      await updateOperationalState(stateRoot, currentRun, {
        status: "STOPPED",
        reason: "safe stop requested before formal window",
      });
      await fsp.unlink(stopFile).catch(() => {});
      return 0;
    }
    if (currentRun.formal_started === false) return 0;
    const startupCheckpoint = await runCheckpoint(
      appRoot,
      runDir,
      "supervisor-start",
      checkpointEnvironment(config, currentRun),
    );
    if (startupCheckpoint.code !== 0) {
      await updateOperationalState(stateRoot, currentRun, {
        status: "STOPPED",
        reason: "startup-checkpoint-failed",
        error: String(startupCheckpoint.error?.message || `checkpoint exited ${startupCheckpoint.code}`),
        evidence_preserved: true,
      });
      return 0;
    }
    let gateCheckRunning = false;
    let sourceRefreshRunning = false;
    const captureAndEvaluateLiveGates = async () => {
      if (gateCheckRunning || sourceRefreshRunning || shuttingDown) return null;
      gateCheckRunning = true;
      try {
        await captureLiveGateEvidence({
          config,
          stateRoot,
          currentRun,
          runDir,
        });
        const decision = await evaluateDueLiveGates({
          config,
          stateRoot,
          currentRun,
          runDir,
        });
        if (decision.action === "safe-stop") {
          forcedSafeStopReason = decision.reason;
          shuttingDown = true;
          await stopWorker().catch(() => {});
        }
        return decision;
      } catch (error) {
        forcedSafeStopReason = "live-acceptance-evidence-failed";
        shuttingDown = true;
        const gateState = await readJson(
          path.join(runDir, "staged_acceptance_gates.json"),
          {},
        ).catch(() => ({}));
        if (gateState?.submission_gate) {
          await failLiveStagedGate({
            config,
            stateRoot,
            currentRun,
            runDir,
            gateState,
            gateName: "three_sku",
            result: {
              passed: false,
              evidence_error: String(error?.message || error),
            },
            reason: forcedSafeStopReason,
          }).catch(() => {});
        } else {
          await updateOperationalState(stateRoot, currentRun, {
            status: "STOPPED",
            reason: forcedSafeStopReason,
            error: String(error?.message || error),
            evidence_preserved: true,
          }).catch(() => {});
        }
        await stopWorker().catch(() => {});
        return { action: "safe-stop", reason: forcedSafeStopReason, error };
      } finally {
        gateCheckRunning = false;
      }
    };
    await captureAndEvaluateLiveGates();
    if (shuttingDown) return 0;
    gateTimer = setInterval(() => {
      void captureAndEvaluateLiveGates();
    }, 60_000);
    gateTimer.unref();
    let paceCheckRunning = false;
    const enforceRollingPace = async ({ writeCheckpoint = true } = {}) => {
      if (paceCheckRunning || shuttingDown) return;
      paceCheckRunning = true;
      try {
        if (writeCheckpoint) {
          const checkpointResult = await runCheckpoint(
            appRoot,
            runDir,
            "2h",
            checkpointEnvironment(config, currentRun),
          );
          if (checkpointResult.code !== 0) {
            throw checkpointResult.error || new Error(`rolling checkpoint exited ${checkpointResult.code}`);
          }
        }
        const checkpoint = await readJson(path.join(runDir, "compact_checkpoint.json"), {});
        const observedMs = Date.parse(checkpoint?.observed_at || "");
        const startedMs = Date.parse(currentRun.started_at || "");
        const elapsedMinutes = Number.isFinite(observedMs) && Number.isFinite(startedMs)
          ? (observedMs - startedMs) / 60_000
          : 0;
        const decision = rollingRateDecision({
          elapsedMinutes,
          rolling120PerHour: checkpoint?.compact?.rolling_h?.["120"] ?? 0,
          minimumPerHour: 35,
          targetReached: (
            Number(checkpoint?.compact?.strict || 0) >= 500
            && checkpoint?.compact?.pace35 === true
          ),
        });
        if (decision.action !== "safe-stop") return;
        forcedSafeStopReason = decision.reason;
        shuttingDown = true;
        await appendJsonLine(path.join(stateRoot, "recovery.jsonl"), {
          at: new Date().toISOString(),
          run_dir: runDir,
          action: "rolling-rate-hard-gate",
          ...decision,
        });
        await updateOperationalState(stateRoot, currentRun, {
          status: "STOPPED",
          reason: decision.reason,
          rolling_rate: decision,
          evidence_preserved: true,
        });
        await stopWorker().catch(() => {});
      } catch (error) {
        forcedSafeStopReason ||= "rolling-rate-check-failed";
        shuttingDown = true;
        await appendJsonLine(path.join(stateRoot, "recovery.jsonl"), {
          at: new Date().toISOString(),
          run_dir: runDir,
          action: "rolling-rate-check-failed",
          error: String(error?.message || error),
        });
        await updateOperationalState(stateRoot, currentRun, {
          status: "STOPPED",
          reason: forcedSafeStopReason,
          error: String(error?.message || error),
          evidence_preserved: true,
        }).catch(() => {});
        await stopWorker().catch(() => {});
      } finally {
        paceCheckRunning = false;
      }
    };
    await enforceRollingPace({ writeCheckpoint: false });
    if (shuttingDown) {
      await updateOperationalState(stateRoot, currentRun, {
        status: "STOPPED",
        reason: forcedSafeStopReason,
        evidence_preserved: true,
      });
      return 0;
    }
    checkpointTimer = setInterval(() => {
      void enforceRollingPace();
    }, Math.max(60_000, Number(config.rate_check_interval_seconds || 300) * 1000));
    checkpointTimer.unref();
    sourceRefreshTimer = setInterval(() => {
      if (sourceRefreshRunning || shuttingDown) return;
      sourceRefreshRunning = true;
      void runFormalSourceRefresh(appRoot, stateRoot, runDir, currentRun)
        .catch(async (error) => {
          await appendJsonLine(path.join(runDir, "runtime_errors.jsonl"), {
            at: new Date().toISOString(),
            stage: "source-set-epoch-refresh",
            error: String(error?.message || error),
          }).catch(() => {});
        })
        .finally(() => {
          sourceRefreshRunning = false;
        });
    }, Math.max(7_200_000, Number(config.source_refresh_seconds || 7_200) * 1000));
    sourceRefreshTimer.unref();
    let restartAttempt = 0;
    let windowFinalized = false;
    while (!shuttingDown) {
      if (fs.existsSync(stopFile)) {
        await updateOperationalState(stateRoot, currentRun, { status: "STOPPED", reason: "safe stop requested" });
        await fsp.unlink(stopFile).catch(() => {});
        break;
      }
      if (await acceptanceEnded(runDir)) {
        await stopOwnedWorker(worker);
        worker = null;
        let finalBrowserOwner;
        try {
          finalBrowserOwner = await ensureOwnedBrowser();
          await assertProcessOwnership({
            phase: "browser-ready",
            runDir,
            profileDir: config.browser.profile_dir,
          });
          if (browserRecoveryPending) {
            throw new Error("browser recovery remained unresolved at the acceptance boundary");
          }
          await writeProcessOwners({
            stateRoot,
            currentRun,
            browserPid: finalBrowserOwner.pid,
          });
        } catch (error) {
          await updateOperationalState(stateRoot, currentRun, {
            status: "FATAL_STOP",
            reason: "window-end-runtime-health-failed",
            error: String(error?.message || error),
            ownership: error?.ownership || null,
            evidence_preserved: true,
          });
          return 0;
        }
        let artifacts;
        let finalLiveGate;
        try {
          await reconcileStrictRuntimeAudit(appRoot, stateRoot, runDir);
          const checkpointResult = await runCheckpoint(
            appRoot,
            runDir,
            "window-complete",
            checkpointEnvironment(config, currentRun),
          );
          if (checkpointResult.code !== 0) {
            throw checkpointResult.error || new Error(`final checkpoint exited ${checkpointResult.code}`);
          }
          artifacts = await runFinalArtifacts(appRoot, stateRoot, currentRun, runDir, {
            config_sha256: config.frozen_config_hash,
            source_commit: config.frozen_commit,
          });
          const [gateState, acceptanceWindow, liveEvidence] = await Promise.all([
            readJson(path.join(runDir, "staged_acceptance_gates.json"), {}),
            readJson(path.join(runDir, "acceptance_window.json"), {}),
            loadLiveAcceptanceEvidence({
              runDir,
              stateRoot,
              runtimeDbPath: runtimeStateDatabasePath(config),
            }),
          ]);
          finalLiveGate = evaluateLiveStagedGate({
            gate: "24-hour",
            events: liveEvidence.events,
            startedAt: acceptanceWindow.started_at,
            endedAt: acceptanceWindow.ended_at,
            expectedIdentity: gateState.identity,
            requireStateEvidence: true,
          });
          const prerequisiteNames = [
            "three_sku",
            "thirty_minute",
            "two_hour_a",
            "two_hour_b",
          ];
          const prerequisiteGatesPassed = prerequisiteNames.every(
            (name) => gateState.gates?.[name]?.status === "passed",
          );
          finalLiveGate.checks.prior_staged_gates_passed = prerequisiteGatesPassed;
          if (!prerequisiteGatesPassed) {
            finalLiveGate.passed = false;
            finalLiveGate.failed_checks = [
              ...new Set([...finalLiveGate.failed_checks, "prior_staged_gates_passed"]),
            ];
          }
          Object.assign(gateState.gates.twenty_four_hour, {
            status: finalLiveGate.passed ? "passed" : "failed",
            evaluated_at: new Date().toISOString(),
            result: finalLiveGate,
          });
          if (!finalLiveGate.passed) {
            gateState.submission_gate.phase = "failed";
            failSubmissionGate({
              dbPath: runtimeStateDatabasePath(config),
              runId: currentRun.run_id,
              result: {
                gate: "twenty_four_hour",
                reason: "twenty-four-hour-production-gate-failed",
                result: finalLiveGate,
              },
            });
          }
          await writeJsonAtomic(path.join(runDir, "staged_acceptance_gates.json"), gateState);
        } catch (error) {
          await updateOperationalState(stateRoot, currentRun, {
            status: "FATAL_STOP",
            reason: "final-acceptance-artifact-failed",
            error: String(error?.message || error),
            contract: error?.contract || null,
            evidence_preserved: true,
          });
          return 0;
        }
        const stoppedBrowserPids = await stopBrowserProfileOwners(config.browser.profile_dir);
        await assertProcessOwnership({
          phase: "after-exit",
          runDir,
          profileDir: config.browser.profile_dir,
        });
        let cleanedBrowserCaches = [];
        let browserCacheCleanupError = null;
        try {
          cleanedBrowserCaches = await cleanupBrowserProfileCaches(config.browser.profile_dir);
        } catch (error) {
          browserCacheCleanupError = String(error?.message || error);
        }
        await appendJsonLine(path.join(stateRoot, "recovery.jsonl"), {
          at: new Date().toISOString(),
          run_dir: runDir,
          action: "window-complete-owner-cleanup",
          stopped_browser_pids: stoppedBrowserPids,
          cleaned_browser_caches: cleanedBrowserCaches,
          browser_cache_cleanup_error: browserCacheCleanupError,
          preserved: ["browser-profile", "checkpoint", "dedupe", "run-evidence", "exports"],
        });
        const finalPassed = artifacts.report?.passed === true && finalLiveGate?.passed === true;
        await updateOperationalState(stateRoot, currentRun, {
          status: finalPassed ? "WINDOW_COMPLETE" : "TARGET_NOT_MET",
          reason: finalPassed ? null : "strict 24-hour acceptance criteria not met",
          artifacts_dir: artifacts.output,
          strict_result: {
            artifact_report: artifacts.report || null,
            live_acceptance_gate: finalLiveGate || null,
          },
          owner_cleanup: {
            worker_stopped: true,
            stopped_browser_pids: stoppedBrowserPids,
            cleaned_browser_caches: cleanedBrowserCaches,
            browser_cache_cleanup_error: browserCacheCleanupError,
            persisted_state_preserved: true,
          },
        });
        windowFinalized = true;
        break;
      }

      let browserOwner;
      try {
        browserOwner = await ensureOwnedBrowser();
        await assertProcessOwnership({
          phase: "browser-ready",
          runDir,
          profileDir: config.browser.profile_dir,
        });
      } catch (error) {
        if (error?.code === "OZON_BROWSER_RECOVERY_SAFE_STOP") {
          forcedSafeStopReason = error.recovery?.reason || "repeated-browser-recovery-failure";
          await updateOperationalState(stateRoot, currentRun, {
            status: "STOPPED",
            reason: forcedSafeStopReason,
            recovery: error.recovery || null,
            evidence_preserved: true,
          });
          break;
        }
        if (error?.code === "OZON_PROCESS_OWNERSHIP") {
          await updateOperationalState(stateRoot, currentRun, {
            status: "FATAL_STOP",
            reason: String(error.message),
            ownership: error.ownership || null,
          });
          return 0;
        }
        const owners = await profileOwners(absolute(config.browser.profile_dir)).catch(() => []);
        const decision = classifyWorkerFailure({ message: error?.message, profileOwnerCount: owners.length });
        if (decision.action === "fatal-stop") {
          await updateOperationalState(stateRoot, currentRun, {
            status: "FATAL_STOP",
            reason: decision.reason,
            error: String(error?.message || error),
          });
          return 0;
        }
        const seconds = nextRestartDelaySeconds(restartAttempt++, config.restart_delays_seconds);
        await appendJsonLine(path.join(stateRoot, "recovery.jsonl"), {
          at: new Date().toISOString(),
          run_dir: runDir,
          action: decision.action,
          reason: decision.reason,
          delay_seconds: seconds,
          error: String(error?.message || error),
        });
        await delay(seconds * 1000);
        continue;
      }

      const runtimeErrorsFile = path.join(runDir, "runtime_errors.jsonl");
      const stderrFile = path.join(runDir, "stderr.log");
      const evidenceOffsets = {
        runtimeErrors: await fileSize(runtimeErrorsFile),
        stderr: await fileSize(stderrFile),
      };
      const stdoutFd = fs.openSync(path.join(runDir, "console.log"), "a");
      const stderrFd = fs.openSync(stderrFile, "a");
      const startedAt = Date.now();
      worker = spawn(process.execPath, [
        path.join(appRoot, "scripts", "flow_b_playwright.mjs"),
        "accept",
        runDir,
        urlsFile,
      ], {
        cwd: appRoot,
        env: workerEnvironment(config, currentRun),
        stdio: ["ignore", stdoutFd, stderrFd],
      });
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
      const spawnedAt = new Date().toISOString();
      const persistedProcessState = await readJson(liveProcessStatePath(runDir));
      await updateLiveProcessState(runDir, {
        formal_worker_started_at: persistedProcessState.formal_worker_started_at || spawnedAt,
        worker_generation: Number(persistedProcessState.worker_generation || 0) + 1,
        active_worker_pid: Number(worker.pid) || null,
      });
      if (pidAlive(worker.pid)) {
        await assertProcessOwnership({
          phase: "worker-running",
          runDir,
          profileDir: config.browser.profile_dir,
        });
      }
      await writeProcessOwners({
        stateRoot,
        currentRun,
        browserPid: browserOwner.pid,
        workerPid: worker.pid,
      });
      await updateOperationalState(stateRoot, currentRun, { status: "RUNNING", reason: null });
      await captureAndEvaluateLiveGates();
      if (shuttingDown) {
        await stopOwnedWorker(worker);
        worker = null;
        break;
      }
      const activeWorker = worker;
      const result = await waitForWorkerOrBrowserFailure(activeWorker, {
        cdpEndpoint: config.browser.cdp_endpoint,
        probeIntervalMs: config.browser.cdp_health_interval_ms,
        probeTimeoutMs: config.browser.cdp_health_timeout_ms,
        failureThreshold: config.browser.cdp_health_failure_threshold,
      });
      const exitedAt = new Date().toISOString();
      const windowEnded = await acceptanceEnded(runDir);
      if (result.browser_unhealthy) {
        const recoveryStarted = {
          at: exitedAt,
          run_dir: runDir,
          action: "browser-recovery-attempt",
          outcome: "started",
          reason: "cdp-health-check-failed",
          worker_pid: activeWorker.pid,
        };
        browserRecoveryEvents.push(recoveryStarted);
        browserRecoveryPending = true;
        await appendJsonLine(path.join(stateRoot, "recovery.jsonl"), recoveryStarted);
        await updateLiveProcessState(runDir, {
          active_worker_pid: null,
          recovery_pending: true,
          recovery_started_at: exitedAt,
        });
      } else {
        await updateLiveProcessState(runDir, {
          active_worker_pid: null,
        });
      }
      await appendJsonLine(path.join(runDir, "live_gate_evidence.jsonl"), {
        type: "process-exit",
        at: exitedAt,
        process: "worker",
        pid: activeWorker.pid,
        code: result.code,
        signal: result.signal,
        planned: Boolean(shuttingDown || windowEnded),
        browser_unhealthy: result.browser_unhealthy,
      });
      if (result.browser_unhealthy) await stopOwnedWorker(activeWorker);
      worker = null;
      await assertProcessOwnership({
        phase: "browser-ready",
        runDir,
        profileDir: config.browser.profile_dir,
      });
      await writeProcessOwners({ stateRoot, currentRun, browserPid: browserOwner.pid });
      if (shuttingDown) break;
      if (windowEnded) continue;
      const owners = await profileOwners(absolute(config.browser.profile_dir)).catch(() => []);
      const evidence = [
        result.error?.message || "",
        await readAppendedTail(runtimeErrorsFile, evidenceOffsets.runtimeErrors),
        await readAppendedTail(stderrFile, evidenceOffsets.stderr),
      ].join("\n");
      const decision = classifyWorkerFailure({ message: evidence, profileOwnerCount: owners.length });
      if (decision.action === "fatal-stop") {
        await updateOperationalState(stateRoot, currentRun, {
          status: "FATAL_STOP",
          reason: decision.reason,
          worker_exit_code: result.code,
        });
        return 0;
      }
      if (decision.action === "wait-for-verification") {
        await waitForVerification({
          stateRoot,
          currentRun,
          appRoot,
          runDir,
          stopFile,
          checkpointEnv: checkpointEnvironment(config, currentRun),
        });
        restartAttempt = 0;
        continue;
      }
      for (const pid of browserOwnerPidsForRecovery(decision, owners)) {
        await stopExactOwner(pid);
        await appendJsonLine(path.join(stateRoot, "recovery.jsonl"), {
          at: new Date().toISOString(),
          run_dir: runDir,
          action: "recycled-unresponsive-profile-owner",
          pid,
          reason: decision.reason,
        });
      }
      if (Date.now() - startedAt >= 10 * 60_000) restartAttempt = 0;
      const seconds = nextRestartDelaySeconds(restartAttempt++, config.restart_delays_seconds);
      await appendJsonLine(path.join(stateRoot, "recovery.jsonl"), {
        at: new Date().toISOString(),
        run_dir: runDir,
        action: decision.action,
        reason: decision.reason,
        delay_seconds: seconds,
        worker_exit_code: result.code,
        worker_signal: result.signal,
      });
      await updateOperationalState(stateRoot, currentRun, {
        status: "RECOVERING",
        reason: decision.reason,
        retry_in_seconds: seconds,
      });
      await delay(seconds * 1000);
    }
    await stopWorker();
    if (shuttingDown) {
      await updateOperationalState(stateRoot, currentRun, {
        status: "STOPPED",
        reason: forcedSafeStopReason || "safe stop requested",
        evidence_preserved: Boolean(forcedSafeStopReason),
      });
      await fsp.unlink(stopFile).catch(() => {});
    }
    await runCheckpoint(
      appRoot,
      runDir,
      "supervisor-stop",
      checkpointEnvironment(config, currentRun),
    );
    if (windowFinalized) {
      await writeProcessOwners({
        stateRoot,
        currentRun,
        browserPid: null,
        workerPid: null,
        supervisorPid: null,
      });
    }
    return 0;
  } finally {
    if (checkpointTimer) clearInterval(checkpointTimer);
    if (sourceRefreshTimer) clearInterval(sourceRefreshTimer);
    if (gateTimer) clearInterval(gateTimer);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("SIGHUP", onSignal);
    let cleanupError = null;
    try {
      await stopOwnedWorker(worker);
      worker = null;
      await stopBrowserProfileOwners(config.browser.profile_dir);
      await assertProcessOwnership({
        phase: "after-exit",
        runDir,
        profileDir: config.browser.profile_dir,
      });
      await writeProcessOwners({
        stateRoot,
        currentRun,
        browserPid: null,
        workerPid: null,
        supervisorPid: null,
      });
    } catch (error) {
      cleanupError = error;
      await appendJsonLine(path.join(stateRoot, "recovery.jsonl"), {
        at: new Date().toISOString(),
        run_dir: runDir,
        action: "owner-cleanup-failed",
        error: String(error?.message || error),
        ownership: error?.ownership || null,
      }).catch(() => {});
      await updateOperationalState(stateRoot, currentRun, {
        status: "FATAL_STOP",
        reason: "owner-cleanup-failed",
        error: String(error?.message || error),
        ownership: error?.ownership || null,
      }).catch(() => {});
    }
    await releaseLock();
    if (cleanupError) throw cleanupError;
  }
}

async function main(argv = process.argv.slice(2)) {
  const [command, configPath] = argv;
  if (command === "plist") {
    const layout = resolveProductionLayout();
    process.stdout.write(buildLaunchdPlist({
      entryScript: layout.entryScript,
      stateRoot: layout.stateRoot,
    }));
    return 0;
  }
  if (command === "supervise") {
    if (!configPath) throw new Error("config path is required");
    return supervise(configPath);
  }
  if (command === "probe-browser") {
    if (!configPath) throw new Error("config path is required");
    const config = expandedConfig(await readJson(configPath));
    const owner = await ensureBrowserOwner({
      config,
      stateRoot: absolute(config.state_root),
      runDir: "browser-recovery-probe",
    });
    process.stdout.write(`${JSON.stringify(owner)}\n`);
    return 0;
  }
  if (command === "cleanup-profile-caches") {
    if (!configPath) throw new Error("config path is required");
    const result = await cleanupProfileCachesForConfig(await readJson(configPath));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  throw new Error(
    "usage: ozon_24h_supervisor.mjs plist | supervise CONFIG_PATH | probe-browser CONFIG_PATH"
      + " | cleanup-profile-caches CONFIG_PATH",
  );
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) {
  main().then(
    (code) => { process.exitCode = Number(code) || 0; },
    (error) => {
      console.error(error?.stack || String(error));
      process.exitCode = error?.code === "OZON_DUPLICATE_SUPERVISOR" ? 73 : 1;
    },
  );
}
