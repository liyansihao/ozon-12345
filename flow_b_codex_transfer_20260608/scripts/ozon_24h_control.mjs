#!/usr/bin/env node

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadControlStatusIndex } from "./control-status-index.mjs";
import { dailyWindowState } from "./daily-window.mjs";
import { diskHealthSnapshot } from "./ozon-storage-maintenance.mjs";

const execFileAsync = promisify(execFile);
let supervisorModulePromise;
const DEFAULT_REPORT_DIR = "/Users/mac/Desktop/ozon每日上品";

function loadSupervisorModule() {
  supervisorModulePromise ||= import("./ozon_24h_supervisor.mjs");
  return supervisorModulePromise;
}

function reportOutputPath(reportDir, dateKey) {
  return path.join(path.resolve(reportDir || DEFAULT_REPORT_DIR), `Ozon人工核价_${dateKey}.xlsx`);
}
const LABEL = "com.codex.ozon.24h-production";
const ACTIVE_STATUSES = new Set([
  "STARTING",
  "PREFLIGHTING_CAPACITY",
  "PREWARMING_CANDIDATES",
  "PREPARING_CANDIDATE_BUFFER",
  "WAITING_FOR_QUOTA_RESET",
  "RUNNING",
  "RECOVERING",
  "RECOVERY_BACKOFF",
  "WAITING_FOR_VERIFICATION",
]);
const RESUMABLE_STATUSES = new Set([...ACTIVE_STATUSES, "STOPPED"]);
const FAILED_WINDOW_STOP_REASONS = new Set([
  "rolling-120-minute-strict-rate-below-threshold",
  "rolling-rate-check-failed",
  "startup-checkpoint-failed",
  "repeated-browser-recovery-failure",
  "three-sku-production-gate-failed",
  "thirty-minute-production-gate-failed",
  "two-hour-a-production-gate-failed",
  "two-hour-b-production-gate-failed",
  "twenty-four-hour-production-gate-failed",
  "accepted-submission-cannot-reach-strict",
  "live-acceptance-evidence-failed",
]);
const DIRECT_PRODUCTION_STORE_IDS = Object.freeze([
  104965,
  106637,
  106640,
  106644,
  106646,
  113151,
  113153,
  113154,
  113155,
  113156,
]);

export function shouldResumeCurrentRun(status, current) {
  if (!current?.run_id || !current?.run_dir || !current?.urls_file) return false;
  if (String(status?.status || "") === "STOPPED"
    && current?.formal_started === true
    && FAILED_WINDOW_STOP_REASONS.has(String(status?.reason || ""))) {
    return false;
  }
  return RESUMABLE_STATUSES.has(String(status?.status || ""));
}

export function resumeMode(status, current) {
  if (String(status?.status || "") === "STOPPED" && shouldResumeCurrentRun(status, current)) {
    return "restart-current-run";
  }
  if (String(status?.status || "") === "WAITING_FOR_VERIFICATION") return "verification";
  return "wake-supervisor";
}

export function directCompletionEvidenceDecision({
  status = {},
  current = {},
  acceptedCount = 0,
  target = 500,
} = {}) {
  if (String(status?.status || "") !== "TARGET_COMPLETE") return { action: "unchanged" };
  if (!current?.run_id || !current?.run_dir || !current?.urls_file) return { action: "unchanged" };
  if (Number(target) === 0) {
    return { action: "resume-current-run", accepted: Math.max(0, Number(acceptedCount) || 0), target: null, unlimited: true };
  }
  const required = Math.max(1, Number(target) || 500);
  const accepted = Math.max(0, Number(acceptedCount) || 0);
  return accepted >= required
    ? { action: "complete", accepted, target: required }
    : { action: "resume-current-run", accepted, target: required };
}

export function currentRunRetirementDecision({
  status = {},
  current = {},
  owners = {},
} = {}) {
  const statusName = String(status?.status || "");
  const safelyStopped = statusName === "STOPPED"
    || (statusName === "FATAL_STOP" && status?.evidence_preserved === true);
  if (!safelyStopped) {
    return { action: "reject", reason: "current-run-is-not-safely-stopped" };
  }
  if (!current?.run_id || !current?.run_dir || !current?.urls_file) {
    return { action: "reject", reason: "current-run-identity-is-incomplete" };
  }
  if (["supervisor", "worker", "profile"].some((name) => Number(owners?.[name] || 0) !== 0)) {
    return { action: "reject", reason: "current-run-still-has-live-owners" };
  }
  return {
    action: "retire",
    reason: statusName === "FATAL_STOP"
      ? "superseded-after-evidenced-fatal-stop"
      : "superseded-by-fixed-500-v3",
  };
}

export function globalFlowBWorkerPids(lines = []) {
  const pids = new Set();
  for (const line of lines || []) {
    const match = String(line || "").trim().match(/^(\d+)\s+([\s\S]+)$/u);
    if (!match) continue;
    if (/^(?:\S*\/)?node\s+\S*flow_b_playwright\.mjs\s+(?:accept|run|publish)\b/u.test(match[2])) {
      pids.add(Number(match[1]));
    }
  }
  return [...pids].sort((left, right) => left - right);
}

export function productionSupervisorPids(lines = []) {
  const pids = new Set();
  for (const line of lines || []) {
    const match = String(line || "").trim().match(/^(\d+)\s+([\s\S]+)$/u);
    if (!match) continue;
    if (/^(?:\S*\/)?node\s+\S*ozon_24h_supervisor\.mjs\s+supervise\b/u.test(match[2])) {
      pids.add(Number(match[1]));
    }
  }
  return [...pids].sort((left, right) => left - right);
}

export function productionProfileOwnerPids(lines = [], profileMarker = "", browserExecutable = "") {
  if (!profileMarker || !browserExecutable) return [];
  const pids = new Set();
  for (const line of lines || []) {
    const match = String(line || "").trim().match(/^(\d+)\s+([\s\S]+)$/u);
    if (!match) continue;
    const command = match[2];
    if (command.startsWith(`${browserExecutable} `)
      && command.includes(profileMarker)
      && command.includes("--remote-debugging-port=")
      && !command.includes(" --type=")) {
      pids.add(Number(match[1]));
    }
  }
  return [...pids].sort((left, right) => left - right);
}

function expandHome(value) {
  return String(value || "").replaceAll("${HOME}", process.env.HOME || "/Users/mac");
}

function expandConfigTemplate(value, config = {}) {
  const appRoot = expandHome(config?.install_root);
  const stateRoot = expandHome(config?.state_root);
  return expandHome(value)
    .replaceAll("${APP_ROOT}", appRoot)
    .replaceAll("${STATE_ROOT}", stateRoot);
}

function resolvedProfitLearningConfig(config = {}) {
  const source = config?.profit_learning || {};
  const resolved = { ...source };
  for (const key of [
    "priority_file",
    "season_file",
    "feedback_file",
    "feedback_dir",
    "learning_status",
    "feedback_status",
    "runtime_root",
    "node",
    "node_modules",
  ]) {
    resolved[key] = source[key]
      ? path.resolve(expandConfigTemplate(source[key], config))
      : "";
  }
  return resolved;
}

async function readJson(filename, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== null) return fallback;
    throw error;
  }
}

async function readSidecarStatus(filename) {
  if (!filename) return { status: "not-configured", state_file: null };
  try {
    const value = JSON.parse(await fsp.readFile(filename, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("sidecar status must be a JSON object");
    }
    return { status: String(value.status || "unknown"), ...value, state_file: filename };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "not-started", state_file: filename };
    return {
      status: "invalid",
      state_file: filename,
      error: String(error?.message || error),
    };
  }
}

function seasonDateKey(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
    ? raw
    : null;
}

function shiftedSeasonDate(dateKey, days) {
  const valid = seasonDateKey(dateKey);
  if (!valid) return null;
  const [year, month, day] = valid.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function seasonDaysBetween(left, right) {
  const leftKey = seasonDateKey(left);
  const rightKey = seasonDateKey(right);
  if (!leftKey || !rightKey) return null;
  return Math.round((Date.parse(`${rightKey}T00:00:00.000Z`) - Date.parse(`${leftKey}T00:00:00.000Z`)) / 86_400_000);
}

function seasonShanghaiDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("season priority now must be a valid timestamp");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function seasonEvents(value = {}) {
  if (Array.isArray(value?.events)) return value.events;
  if (Array.isArray(value?.calendar)) return value.calendar;
  return [];
}

function seasonSourceEntries(value = {}) {
  const result = [];
  const append = (owner, sources) => {
    if (sources === undefined) return;
    if (!Array.isArray(sources)) {
      result.push({ owner, invalid: true, url: "" });
      return;
    }
    for (const source of sources) {
      const url = typeof source === "string"
        ? source.trim()
        : String(source?.url ?? source?.href ?? "").trim();
      result.push({ owner, invalid: !url, url });
    }
  };
  append("calendar", value?.sources);
  for (const [index, event] of seasonEvents(value).entries()) append(`event:${index}`, event?.sources);
  return result;
}

function normalizedSeasonCategoryKeyword(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLocaleLowerCase("und")
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}_]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length >= 3 ? normalized : "";
}

function seasonCategoryDecision(value) {
  const row = typeof value === "string" ? { name: value } : value;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return { valid: false, reason: "must be a string or object" };
  }
  const name = String(row.name ?? row.category ?? row.label ?? "").trim();
  const keywordValue = row.keywords ?? row.aliases ?? row.title_keywords;
  const keywordRows = Array.isArray(keywordValue)
    ? keywordValue
    : keywordValue && typeof keywordValue === "object"
      ? Object.values(keywordValue)
      : [];
  const keywords = keywordRows.map(normalizedSeasonCategoryKeyword).filter(Boolean);
  if (name && /\p{Script=Cyrillic}/u.test(name)) {
    const normalizedName = normalizedSeasonCategoryKeyword(name);
    if (normalizedName) keywords.push(normalizedName);
  }
  return [...new Set(keywords)].length > 0
    ? { valid: true }
    : { valid: false, reason: "needs a Russian name or a keyword/alias/title_keyword of at least 3 characters" };
}

export function seasonPriorityDocumentDecision(value = {}) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: ["season priority must be a JSON object"], events: [], sources: [] };
  }
  if (value.schema_version !== undefined
    && (!Number.isInteger(Number(value.schema_version)) || Number(value.schema_version) < 1)) {
    errors.push("schema_version must be a positive integer");
  }
  const timeZone = value.time_zone ?? value.timezone;
  if (timeZone !== undefined && String(timeZone) !== "Asia/Shanghai") {
    errors.push("time_zone must equal Asia/Shanghai");
  }
  if (value.lead_days !== undefined) errors.push("root lead_days is not supported");
  if (value.events !== undefined && !Array.isArray(value.events)) errors.push("events must be an array");
  if (value.events === undefined && value.calendar !== undefined && !Array.isArray(value.calendar)) {
    errors.push("calendar must be an array");
  }
  for (const key of ["research_verified_at", "next_review_at", "coverage_until"]) {
    if (value[key] !== undefined && !seasonDateKey(value[key])) errors.push(`${key} must use YYYY-MM-DD`);
  }
  const normalizedEvents = [];
  for (const [index, event] of seasonEvents(value).entries()) {
    const prefix = `events[${index}]`;
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    const leadDays = Number(event.lead_days ?? 45);
    if (leadDays !== 45) errors.push(`${prefix}.lead_days must equal 45`);
    const salesStart = seasonDateKey(event.sales_start);
    const salesEnd = seasonDateKey(event.sales_end ?? event.sales_start);
    const explicitStart = seasonDateKey(event.active_from);
    const explicitEnd = seasonDateKey(event.active_until);
    if (!salesStart) errors.push(`${prefix}.sales_start must use YYYY-MM-DD`);
    if (event.sales_end !== undefined && !salesEnd) errors.push(`${prefix}.sales_end must use YYYY-MM-DD`);
    if (salesStart && salesEnd && salesEnd < salesStart) {
      errors.push(`${prefix}.sales_end must not be before sales_start`);
    }
    if (event.active_from !== undefined && !explicitStart) errors.push(`${prefix}.active_from must use YYYY-MM-DD`);
    if (event.active_until !== undefined && !explicitEnd) errors.push(`${prefix}.active_until must use YYYY-MM-DD`);
    const activeFrom = shiftedSeasonDate(salesStart, -leadDays);
    const activeUntil = salesEnd;
    if (explicitStart && salesStart && explicitStart !== shiftedSeasonDate(salesStart, -leadDays)) {
      errors.push(`${prefix}.active_from must be 45 days before sales_start`);
    }
    if (explicitEnd && salesEnd && explicitEnd !== salesEnd) {
      errors.push(`${prefix}.active_until must equal sales_end`);
    }
    if (activeFrom && activeUntil && activeFrom > activeUntil) {
      errors.push(`${prefix} active date range is reversed`);
    }
    if (!Array.isArray(event.categories) || event.categories.length === 0) {
      errors.push(`${prefix}.categories must be a non-empty array`);
    } else {
      for (const [categoryIndex, category] of event.categories.entries()) {
        const categoryDecision = seasonCategoryDecision(category);
        if (!categoryDecision.valid) {
          errors.push(`${prefix}.categories[${categoryIndex}] ${categoryDecision.reason}`);
        }
      }
    }
    normalizedEvents.push({
      id: String(event.id ?? event.name ?? `event-${index + 1}`),
      name: String(event.name ?? event.title ?? event.id ?? `event-${index + 1}`),
      sales_start: salesStart,
      sales_end: salesEnd,
      active_from: activeFrom,
      active_until: activeUntil,
      lead_days: leadDays,
      enabled: event.enabled !== false,
    });
  }
  const sources = seasonSourceEntries(value);
  for (const source of sources) {
    if (source.invalid || !/^https:\/\//iu.test(source.url)) {
      errors.push(`${source.owner} source must use an HTTPS URL`);
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    events: normalizedEvents,
    sources: sources.map((source) => source.url).filter(Boolean),
  };
}

export async function optionalSeasonPriorityJsonIsValid(filename) {
  if (!filename) return false;
  try {
    const value = JSON.parse(await fsp.readFile(filename, "utf8"));
    return seasonPriorityDocumentDecision(value).valid;
  } catch (error) {
    return error.code === "ENOENT";
  }
}

export async function readSeasonPriorityStatus(filename, { now = new Date() } = {}) {
  if (!filename) return { status: "not-configured", season_file: null };
  const absolute = path.resolve(filename);
  try {
    const raw = await fsp.readFile(absolute, "utf8");
    const value = JSON.parse(raw);
    const decision = seasonPriorityDocumentDecision(value);
    if (!decision.valid) {
      return {
        status: "invalid",
        season_file: absolute,
        error: decision.errors.join("; "),
      };
    }
    const date = seasonShanghaiDateKey(now);
    const activeEvents = decision.events.filter((event) => (
      event.enabled !== false
      && event.active_from && event.active_until && date >= event.active_from && date <= event.active_until
    ));
    const verifiedAt = seasonDateKey(value.research_verified_at);
    const nextReviewAt = seasonDateKey(value.next_review_at) || shiftedSeasonDate(verifiedAt, 7);
    const researchDue = !nextReviewAt || date >= nextReviewAt;
    const inferredCoverage = decision.events
      .map((event) => event.active_until)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    const coverageUntil = seasonDateKey(value.coverage_until) || inferredCoverage;
    const coverageDays = seasonDaysBetween(date, coverageUntil);
    const coverageWarning = coverageDays === null
      ? "coverage-date-missing"
      : coverageDays < 0
        ? "coverage-expired"
        : coverageDays < 90
          ? "coverage-under-90-days"
          : null;
    return {
      status: "ready",
      season_file: absolute,
      schema_version: Number(value.schema_version || 1),
      calendar_version: value.calendar_version || value.version || null,
      fingerprint_sha256: sha256(raw),
      date,
      time_zone: "Asia/Shanghai",
      generated_at: value.generated_at || value.updated_at || null,
      research_verified_at: verifiedAt,
      next_review_at: nextReviewAt,
      research_due: researchDue,
      coverage_until: coverageUntil,
      coverage_days_remaining: coverageDays,
      coverage_warning: coverageWarning,
      warnings: [
        ...(researchDue ? [verifiedAt ? "research-verification-due" : "research-date-missing"] : []),
        ...(coverageWarning ? [coverageWarning] : []),
      ],
      event_count: decision.events.length,
      active_event_count: activeEvents.length,
      active_events: activeEvents,
      source_count: decision.sources.length,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "not-started", season_file: absolute };
    return {
      status: "invalid",
      season_file: absolute,
      error: String(error?.message || error),
    };
  }
}

export async function readProfitLearningStatus(config, paths = null, options = {}) {
  const deployment = paths || deploymentPaths(config);
  const profitConfig = resolvedProfitLearningConfig({
    ...config,
    install_root: deployment.appLink || config?.install_root,
    state_root: deployment.stateRoot || config?.state_root,
  });
  if (profitConfig.enabled !== true) return { enabled: false };
  const [learning, feedbackImport, seasonPriority] = await Promise.all([
    readSidecarStatus(profitConfig.learning_status),
    readSidecarStatus(profitConfig.feedback_status),
    readSeasonPriorityStatus(profitConfig.season_file, options),
  ]);
  return {
    enabled: true,
    priority_file: profitConfig.priority_file,
    season_file: profitConfig.season_file,
    feedback_file: profitConfig.feedback_file,
    feedback_dir: profitConfig.feedback_dir,
    learning,
    feedback_import: feedbackImport,
    season_priority: seasonPriority,
  };
}

async function readJsonLines(filename) {
  try {
    return (await fsp.readFile(filename, "utf8")).split(/\r?\n/u).filter(Boolean).flatMap((line) => {
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

async function writeJsonAtomic(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, filename);
}

async function appendJsonLine(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.appendFile(filename, `${JSON.stringify(value)}\n`, "utf8");
}

export async function clearOzonManualVerificationLock({
  config,
  stateRoot,
  now = new Date(),
} = {}) {
  const profileDir = expandHome(config?.browser?.profile_dir);
  const configured = expandHome(config?.flow_env?.FLOW_B_OZON_ACCESS_STATE);
  const filename = configured
    ? path.resolve(configured)
    : profileDir
      ? path.join(path.dirname(path.resolve(profileDir)), "ozon_access_state.json")
      : null;
  if (!filename) return { cleared: false, reason: "access-state-path-unavailable" };
  const prior = await readJson(filename, {});
  if (prior?.requires_manual_clear !== true) {
    return { cleared: false, reason: "manual-clearance-lock-not-set", filename };
  }
  const requestedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const priorReason = String(prior.reason || "manual verification requested");
  const evidence = {
    requested_at: requestedAt,
    source: "control-panel-verification-resume",
    prior_reason: priorReason,
  };
  await writeJsonAtomic(filename, {
    ...prior,
    updated_at: requestedAt,
    requires_manual_clear: false,
    captcha_retry_pending: false,
    captcha_retry_at: null,
    reason: null,
    manually_cleared_at: requestedAt,
    manual_clearance_evidence: evidence,
  });
  await appendJsonLine(path.join(stateRoot, "ozon_access_manual_clearance.jsonl"), evidence);
  return { cleared: true, filename, evidence };
}

async function pathExists(filename) {
  try {
    await fsp.access(filename);
    return true;
  } catch {
    return false;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function deploymentIdentityValid(deployment, configText) {
  return (
    /^[a-f0-9]{40}$/u.test(String(deployment?.source_commit || ""))
    && String(deployment?.config_sha256 || "") === sha256(configText)
    && /^[a-f0-9]{64}$/u.test(String(deployment?.source_set_sha256 || ""))
    && /^[a-f0-9]{64}$/u.test(String(deployment?.source_smoke_sha256 || ""))
    && Number(deployment?.state_schema_version) === 3
  );
}

function validateConfig(config) {
  if (config?.frozen !== true) throw new Error("production config must be frozen");
  if (config?.runtime_mode === "direct") {
    if (Number(config?.publish_target) !== 0 || config?.unlimited_publish !== true) {
      throw new Error("direct publishing must use target zero with unlimited_publish enabled");
    }
    if (Number(config?.minimum_profit_rate_exclusive) !== 30) {
      throw new Error("direct profit rate must be exclusively greater than 30");
    }
    if (String(config?.flow_env?.FLOW_B_DIRECT_PUBLISH || "") !== "1") {
      throw new Error("direct publishing must be enabled");
    }
    if (Number(config?.flow_env?.FLOW_B_1688_MIN_MATCHES) !== 1) {
      throw new Error("direct publishing requires one verified 1688 same-item match");
    }
    const adaptiveActionPolicy = String(
      config?.flow_env?.FLOW_B_1688_ADAPTIVE_ACTION_POLICY || "",
    ).trim().toLowerCase();
    if (!["shadow", "enforce"].includes(adaptiveActionPolicy)) {
      throw new Error("1688 adaptive action policy must be shadow or enforce");
    }
    const profitSafetyActionPolicy = String(
      config?.flow_env?.FLOW_B_PROFIT_SAFETY_ACTION_POLICY || "",
    ).trim().toLowerCase();
    if (!["shadow", "enforce"].includes(profitSafetyActionPolicy)) {
      throw new Error("profit safety action policy must be shadow or enforce");
    }
    const directWorkerWatchdog = config?.direct_worker_watchdog || {};
    const watchdogContract = {
      source_error_threshold: 3,
      producer_stale_ms: 1_200_000,
      consumer_stale_ms: 1_200_000,
      productive_stale_ms: 1_200_000,
      reconciliation_stale_ms: 1_200_000,
      startup_grace_ms: 180_000,
      recovery_cooldown_ms: 1_800_000,
      recovery_window_ms: 7_200_000,
      max_recoveries_per_window: 2,
      probe_failure_threshold: 2,
    };
    if (directWorkerWatchdog.enabled !== true) {
      throw new Error("direct worker watchdog must be enabled");
    }
    for (const [name, expected] of Object.entries(watchdogContract)) {
      if (Number(directWorkerWatchdog[name]) !== expected) {
        throw new Error(`direct worker watchdog requires ${name}=${expected}`);
      }
    }
    const verificationRecovery = config?.verification_auto_recovery || {};
    const verificationContract = {
      ready_confirmations: 2,
      confirmation_interval_seconds: 30,
      confirmation_max_age_seconds: 90,
      probe_timeout_ms: 45_000,
      poll_interval_ms: 2_000,
      warmup_interval_ms: 8_000,
    };
    if (verificationRecovery.enabled !== true
      || JSON.stringify(verificationRecovery.probe_delays_seconds) !== JSON.stringify([300, 600, 1_200, 1_800])) {
      throw new Error("automatic verification recovery must be enabled with 300/600/1200/1800 second probes");
    }
    for (const [name, expected] of Object.entries(verificationContract)) {
      if (Number(verificationRecovery[name]) !== expected) {
        throw new Error(`automatic verification recovery requires ${name}=${expected}`);
      }
    }
    if (Number(config?.flow_env?.FLOW_B_1688_ADAPTIVE_ACTION_SAMPLE_TARGET) !== 100) {
      throw new Error("1688 adaptive action evidence target must be 100");
    }
    if (Number(config?.flow_env?.FLOW_B_TARGET_PUBLISH_COUNT) !== 0
      || String(config?.flow_env?.FLOW_B_UNLIMITED_PUBLISH || "") !== "1") {
      throw new Error("direct publishing must be unlimited");
    }
    const balancedSpeedContract = {
      FLOW_B_1688_TOTAL_BUDGET_MS: "30000",
      FLOW_B_1688_ITEM_TIMEOUT: "30",
      FLOW_B_1688_TRANSIENT_RETRIES: "1",
      FLOW_B_1688_RETRY_BUDGET_SECONDS: "30",
      FLOW_B_1688_WORKERS: "1",
      FLOW_B_1688_SESSION_MAX_REQUESTS: "4",
      FLOW_B_1688_SESSION_MAX_AGE_SECONDS: "120",
      FLOW_B_1688_SESSION_RECYCLE_SLOW_SECONDS: "8",
      FLOW_B_1688_CACHE_FLUSH_DEBOUNCE_MS: "5000",
      FLOW_B_1688_MATCH_POLICY: "shadow",
      FLOW_B_1688_MATCH_SHADOW_SAMPLES: "100",
      FLOW_B_1688_MATCH_MIN_RETENTION_PERCENT: "75",
      FLOW_B_1688_MATCH_MIN_IMAGE_PERCENT: "90",
      FLOW_B_1688_MATCH_MAX_P95_MS: "15000",
      FLOW_B_PUBLISH_WORKERS: "8",
      FLOW_B_MAX_PUBLISH_WORKERS: "8",
      FLOW_B_OZON_DETAIL_WORKERS: "1",
      FLOW_B_MAX_OZON_DETAIL_WORKERS: "1",
      FLOW_B_PRUNE_ORPHAN_PAGES_ON_START: "1",
      FLOW_B_ORPHAN_PAGE_KEEP_COUNT: "1",
      FLOW_B_ORPHAN_PAGE_CLOSE_TIMEOUT_MS: "5000",
      FLOW_B_TAB_WORKERS: "3",
      FLOW_B_FAVORITE_WORKERS: "3",
      FLOW_B_OZON_BASE_INTERVAL_MS: "3000",
      FLOW_B_OZON_WARMUP_INTERVAL_MS: "4000",
      FLOW_B_OZON_MAX_INTERVAL_MS: "8000",
      FLOW_B_OZON_WARMUP_DURATION_MS: "1800000",
      FLOW_B_OZON_WARMUP_SUCCESS_COUNT: "20",
      FLOW_B_OZON_STABLE_SUCCESS_COUNT: "20",
      FLOW_B_OZON_INTERVAL_STEP_MS: "500",
      FLOW_B_OZON_SOFT_BLOCK_STEP_MS: "1500",
      FLOW_B_SOURCE_PRODUCTIVE_WEIGHT: "3",
      FLOW_B_SOURCE_EXPLORATION_WEIGHT: "1",
      FLOW_B_FAVORITE_CACHE_TTL_MS: "30000",
      FLOW_B_RUNTIME_EMPTY_BACKOFF_MS: "1000,3000,10000",
    };
    for (const [name, expected] of Object.entries(balancedSpeedContract)) {
      if (String(config?.flow_env?.[name] ?? "") !== expected) {
        throw new Error(`balanced speed contract requires ${name}=${expected}`);
      }
    }
    const stores = Array.isArray(config?.stores) ? config.stores : [];
    const storeTargets = Array.isArray(config?.flow_env?.FLOW_B_STORE_TARGETS)
      ? config.flow_env.FLOW_B_STORE_TARGETS
      : [];
    const storeIds = stores.map((row) => Number(row?.id));
    const targetIds = storeTargets.map((row) => Number(row?.id));
    if (storeIds.join(",") !== DIRECT_PRODUCTION_STORE_IDS.join(",")) {
      throw new Error("direct production config must contain the ten verified stores in rotation order");
    }
    if (targetIds.join(",") !== storeIds.join(",")) {
      throw new Error("direct store targets must match the ten-store rotation order");
    }
    const warehouseIds = stores.map((store) => Number(store?.warehouse_id));
    const targetWarehouseIds = storeTargets.map((store) => Number(store?.warehouseId));
    const uralWarehouseIds = stores.map((store) => Number(store?.ural_warehouse_id));
    const targetUralWarehouseIds = storeTargets.map((store) => Number(store?.uralWarehouseId));
    if (warehouseIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error("all ten stores require an ERP-verified warehouse mapping");
    }
    if (new Set(warehouseIds).size !== DIRECT_PRODUCTION_STORE_IDS.length) {
      throw new Error("ten-store warehouse mappings must be unique");
    }
    if (targetWarehouseIds.join(",") !== warehouseIds.join(",")) {
      throw new Error("direct store target warehouses must match the verified store mappings");
    }
    if (uralWarehouseIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error("all ten stores require an ERP-verified Ural warehouse mapping");
    }
    if (new Set(uralWarehouseIds).size !== DIRECT_PRODUCTION_STORE_IDS.length) {
      throw new Error("ten-store Ural warehouse mappings must be unique");
    }
    if (targetUralWarehouseIds.join(",") !== uralWarehouseIds.join(",")) {
      throw new Error("direct store target Ural warehouses must match the verified store mappings");
    }
    if (!storeTargets.every((store) => store?.weightRouting === true && Number(store?.weightThresholdGrams) === 500)) {
      throw new Error("every direct store target must route weights above 500g through Ural");
    }
    if (!storeTargets.every((store) => store?.requireWarehouse === true)) {
      throw new Error("every direct store target must require its verified warehouse");
    }
    if (!storeIds.includes(Number(config?.starting_store_id))) {
      throw new Error("direct starting store must belong to the ten-store rotation");
    }
    for (const store of stores) {
      if (!Number.isSafeInteger(Number(store.warehouse_id))) {
        throw new Error(`store ${store.id} is missing an ERP-verified warehouse mapping`);
      }
    }
    if (Number(config?.state_schema_version) !== 3
      || Number(config?.flow_env?.FLOW_B_RUNTIME_STATE_SCHEMA_VERSION) !== 3
      || !String(config?.flow_env?.FLOW_B_RUNTIME_STATE_DB || "").endsWith(".sqlite")) {
      throw new Error("external SQLite state schema must equal version 3");
    }
    const externalPython = String(config?.flow_env?.FLOW_B_PYTHON || "");
    if (!path.isAbsolute(expandHome(externalPython)) || externalPython === "python3") {
      throw new Error("production 1688 runtime must use an absolute external Python executable");
    }
    if (String(config?.browser?.cdp_endpoint) !== "http://127.0.0.1:9223") {
      throw new Error("production CDP endpoint must be the unique localhost owner on port 9223");
    }
    if (String(config?.flow_env?.FLOW_B_ENFORCE_DIRECT_DAILY_LIMIT || "") !== "1"
      || Number(config?.flow_env?.FLOW_B_DAILY_STORE_LIMIT) !== 100) {
      throw new Error("direct publishing must enforce a 100-item per-store daily limit");
    }
    const dailyCutoff = String(config?.flow_env?.FLOW_B_DAILY_SUBMISSION_CUTOFF || "");
    const dailyReportAfter = String(config?.flow_env?.FLOW_B_DAILY_REPORT_AFTER || "");
    const validClock = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
    if (!validClock(dailyCutoff) || dailyCutoff !== "23:00"
      || !validClock(dailyReportAfter) || dailyReportAfter !== "23:30") {
      throw new Error("direct daily submission cutoff/report window must be 23:00/23:30");
    }
    const dailyReport = config?.daily_pricing_report;
    if (dailyReport?.enabled !== true
      || String(dailyReport?.time_zone || "") !== "Asia/Shanghai"
      || String(dailyReport?.cutoff || "") !== "23:00"
      || String(dailyReport?.report_after || "") !== "23:30"
      || Number(dailyReport?.poll_interval_seconds) < 30) {
      throw new Error("daily pricing report must be enabled for Asia/Shanghai at 23:30");
    }
    for (const [name, value] of Object.entries({
      report_node: dailyReport?.node,
      report_node_modules: dailyReport?.node_modules,
      report_output_dir: dailyReport?.output_dir,
    })) {
      if (!path.isAbsolute(expandHome(String(value || "")))) {
        throw new Error(`${name} must be an absolute path`);
      }
    }
    const profitLearning = resolvedProfitLearningConfig(config);
    if (profitLearning.enabled !== true) {
      throw new Error("profit learning sidecars must be enabled");
    }
    for (const [name, value] of Object.entries({
      profit_priority_file: profitLearning.priority_file,
      profit_season_file: profitLearning.season_file,
      profit_feedback_file: profitLearning.feedback_file,
      profit_feedback_dir: profitLearning.feedback_dir,
      profit_learning_status: profitLearning.learning_status,
      profit_feedback_status: profitLearning.feedback_status,
      profit_runtime_root: profitLearning.runtime_root,
      profit_node: profitLearning.node,
      profit_node_modules: profitLearning.node_modules,
    })) {
      if (!path.isAbsolute(String(value || ""))) {
        throw new Error(`${name} must be an absolute path`);
      }
    }
    if (profitLearning.priority_file !== "/Users/mac/Desktop/ozon每日上品/优先母款.json"
      || profitLearning.season_file !== "/Users/mac/Desktop/ozon每日上品/季节优先类目.json"
      || profitLearning.feedback_file !== "/Users/mac/Desktop/ozon每日上品/错误货源.json"
      || profitLearning.feedback_dir !== "/Users/mac/Desktop/ozon每日上品/核价反馈") {
      throw new Error("profit learning files must use the fixed daily-upload desktop folder");
    }
    const expectedProfitStateRoot = path.join(
      path.resolve(expandHome(config.state_root)),
      "profit_learning",
    );
    if (profitLearning.learning_status !== path.join(expectedProfitStateRoot, "status.json")
      || profitLearning.feedback_status !== path.join(expectedProfitStateRoot, "feedback_status.json")) {
      throw new Error("profit learning sidecar states must stay under the production state root");
    }
    if (Number(profitLearning.lookback_days) !== 30
      || Number(profitLearning.minimum_completed_orders) !== 3) {
      throw new Error("profit learning must use a 30-day window and at least three completed orders");
    }
    if (!Number.isFinite(Number(profitLearning.file_refresh_ms))
      || Number(profitLearning.file_refresh_ms) < 1_000) {
      throw new Error("profit learning file refresh must be at least 1000ms");
    }
    return config;
  }
  if (Number(config?.acceptance?.duration_seconds) !== 86400) throw new Error("acceptance duration must be 86400 seconds");
  const targetPolicy = String(config?.acceptance?.target_policy || "fixed");
  if (targetPolicy !== "fixed") throw new Error("acceptance target policy must equal fixed");
  if (Number(config?.acceptance?.strict_target) !== 500) throw new Error("strict target must equal 500");
  if (Number(config?.acceptance?.per_store_target) !== 100) throw new Error("per-store strict target must equal 100");
  if (Number(config?.acceptance?.rolling_rate_window_minutes) !== 120) {
    throw new Error("rolling strict rate window must equal 120 minutes");
  }
  if (Number(config?.acceptance?.minimum_average_per_hour_exclusive) !== 35) {
    throw new Error("minimum strict rate threshold must equal 35/hour");
  }
  if (Number(config?.acceptance?.minimum_profit_rate_exclusive) !== 30) {
    throw new Error("profit rate must be exclusively greater than 30");
  }
  const storeIds = (config?.stores || []).map((row) => Number(row?.id));
  if (storeIds.join(",") !== "106637,106640,106644,106646,104965") {
    throw new Error("production config must contain the five stores in the verified rotation order");
  }
  for (const store of config.stores) {
    if (!Number.isSafeInteger(Number(store.warehouse_id))) {
      throw new Error(`store ${store.id} is missing an ERP-verified warehouse mapping`);
    }
  }
  if (new Set(config.stores.map((store) => String(store.warehouse_id))).size !== 5) {
    throw new Error("five-store warehouse mappings must be unique");
  }
  if (String(config?.flow_env?.FLOW_B_REQUIRE_PER_STORE_ACCEPTANCE || "") !== "1") {
    throw new Error("per-store acceptance must be enabled");
  }
  if (Number(config?.flow_env?.FLOW_B_URGENT_ONLINE_SYNC_INTERVAL_MS) < 180_000) {
    throw new Error("urgent online sync interval must be at least 180000ms");
  }
  if (
    Number(config?.candidate_buffer?.minimum_hours) !== 2
    || Number(config?.candidate_buffer?.minimum_strict_per_hour) !== 35
    || Number(config?.candidate_buffer?.minimum_ready_candidates) < 70
  ) {
    throw new Error("candidate buffer must contain at least two hours / 70 fully-qualified SKUs");
  }
  if (config?.operator_direct_publish?.enabled === true) {
    if (
      config.operator_direct_publish.allow_current_day_capacity_shortfall !== true
      || Number(config.operator_direct_publish.minimum_ready_candidates) !== 0
      || String(config.operator_direct_publish.authorized_by || "") !== "workspace-user"
      || !Number.isFinite(Date.parse(String(config.operator_direct_publish.authorized_at || "")))
      || !String(config.operator_direct_publish.reason || "").trim()
    ) {
      throw new Error("operator direct publish requires an explicit audited zero-buffer authorization");
    }
  }
  if (Number(config?.source_refresh_seconds) !== 7_200) {
    throw new Error("formal source policy refresh interval must equal 7200 seconds");
  }
  if ([
    Number(config?.flow_env?.FLOW_B_PUBLISH_TRANCHE_ATTEMPTS),
    Number(config?.flow_env?.FLOW_B_BUFFER_REFILL_TARGET),
    Number(config?.flow_env?.FLOW_B_BUFFER_REFILL_ATTEMPT_LIMIT),
  ].join(",") !== "8,8,24") {
    throw new Error("same-worker publish/refill tranche must be frozen at 8/8/24");
  }
  if (
    Number(config?.flow_env?.FLOW_B_MAX_SOURCE_BATCHES_PER_TRANCHE) !== 1
    || Number(config?.flow_env?.FLOW_B_PRODUCER_INTERVAL_MS) < 60_000
  ) {
    throw new Error("source producer must yield after one batch for at least 60000ms");
  }
  if (Number(config?.flow_env?.FLOW_B_FAVORITE_PAGE_CREATE_TIMEOUT_MS) !== 30_000) {
    throw new Error("favorite worker page creation timeout must equal 30000ms");
  }
  if (
    Number(config?.rate_check_interval_seconds) < 60
    || Number(config?.rate_check_interval_seconds) > 300
  ) {
    throw new Error("rolling rate must be checked every 60..300 seconds");
  }
  for (const name of [
    "FLOW_B_DERIVED_SEARCH_SOURCES",
    "FLOW_B_DERIVED_PRIORITY_SOURCES",
    "FLOW_B_PRIORITIZE_DERIVED_SEARCH",
    "FLOW_B_LOW_TOKEN_INTERVENTION",
  ]) {
    if (String(config?.flow_env?.[name] || "") !== "0") {
      throw new Error(`${name} must equal 0`);
    }
  }
  if (String(config?.flow_env?.FLOW_B_STRICT_SOURCE_PORTFOLIO || "") !== "1"
    || String(config?.flow_env?.FLOW_B_SOURCE_ALLOWLIST_MATCH || "") !== "exact") {
    throw new Error("production sourcing must use the exact strict seller portfolio");
  }
  if ([
    Number(config?.flow_env?.FLOW_B_SOURCE_STRICT_WEIGHT),
    Number(config?.flow_env?.FLOW_B_SOURCE_FBS_WEIGHT),
    Number(config?.flow_env?.FLOW_B_SOURCE_EXPLORE_WEIGHT),
  ].join(",") !== "6,3,1") {
    throw new Error("source weights must freeze verified/exploration at 90/10");
  }
  if (Number(config?.state_schema_version) !== 3
    || Number(config?.flow_env?.FLOW_B_RUNTIME_STATE_SCHEMA_VERSION) !== 3
    || !String(config?.flow_env?.FLOW_B_RUNTIME_STATE_DB || "").endsWith(".sqlite")) {
    throw new Error("external SQLite state schema must equal version 3");
  }
  if (
    String(config?.flow_env?.FLOW_B_PYTHON || "")
    !== "${HOME}/.ozon-24h-production/python-1688-v1/bin/python"
  ) {
    throw new Error("production 1688 runtime must use the frozen external Python environment");
  }
  for (const [rule, required] of Object.entries(config?.immutable_rules || {})) {
    if (required !== true) throw new Error(`immutable rule is not enabled: ${rule}`);
  }
  if (String(config?.browser?.cdp_endpoint) !== "http://127.0.0.1:9223") {
    throw new Error("production CDP endpoint must be the unique localhost owner on port 9223");
  }
  return config;
}

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    });
    return { ok: true, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    return {
      ok: false,
      code: error.code,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      error: String(error?.message || error),
    };
  }
}

function deploymentPaths(config) {
  const appLink = path.resolve(expandHome(config.install_root));
  const base = path.dirname(appLink);
  const releases = path.join(base, "releases");
  return {
    base,
    appLink,
    stateRoot: path.resolve(expandHome(config.state_root)),
    releases,
    candidate: path.join(releases, "candidate"),
    stable: path.join(releases, "stable"),
    rollback: path.join(releases, "rollback"),
    plist: path.join(process.env.HOME || "/Users/mac", "Library", "LaunchAgents", `${LABEL}.plist`),
  };
}

async function copyInitialState(sourceRoot, stateRoot) {
  const mappings = [
    ["data/flow_b/published_links.csv", "dedupe/published_links.csv"],
    ["data/flow_b/source_yield_history.jsonl", "history/source_yield_history.jsonl"],
    ["data/flow_b/fbs_source_history.jsonl", "history/fbs_source_history.jsonl"],
    ["data/flow_b/1688_cache.json", "cache/1688_cache.json"],
    ["config/ozon_source_seed.txt", "sources/active_urls.txt"],
  ];
  for (const [relativeSource, relativeTarget] of mappings) {
    const source = path.join(sourceRoot, relativeSource);
    const target = path.join(stateRoot, relativeTarget);
    if (!await pathExists(source) || await pathExists(target)) continue;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  }
}

export async function validateCandidateSourcePortfolio({
  appRoot,
  releasesRoot,
  seedFile = path.join(appRoot, "config", "ozon_source_seed.txt"),
} = {}) {
  const resolvedAppRoot = path.resolve(appRoot);
  const resolvedReleasesRoot = path.resolve(releasesRoot);
  await fsp.mkdir(resolvedReleasesRoot, { recursive: true });
  const stagingStateRoot = await fsp.mkdtemp(
    path.join(resolvedReleasesRoot, ".candidate-source-smoke-"),
  );
  try {
    const seedSourceText = await fsp.readFile(path.resolve(seedFile), "utf8");
    const sourceRefresh = await run(process.execPath, [
      path.join(resolvedAppRoot, "scripts", "ozon_source_portfolio.mjs"),
      "refresh",
      stagingStateRoot,
      "-",
      path.resolve(seedFile),
    ], { cwd: resolvedAppRoot });
    if (!sourceRefresh.ok) {
      throw new Error(
        `candidate source portfolio smoke check failed: ${sourceRefresh.stderr || sourceRefresh.error}`,
      );
    }
    const sourceText = await fsp.readFile(
      path.join(stagingStateRoot, "sources", "active_urls.txt"),
      "utf8",
    );
    const activeUrls = sourceText
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      activeUrls.length === 0
      || activeUrls.some((value) => !/^https:\/\/(?:www\.)?ozon\.ru\/seller\//u.test(value))
    ) {
      throw new Error("candidate source portfolio smoke check produced a non-seller source set");
    }
    return {
      sourceText,
      sourceSetSha256: sha256(seedSourceText),
      smokeSourceSetSha256: sha256(sourceText),
      activeSourceCount: activeUrls.length,
    };
  } finally {
    await fsp.rm(stagingStateRoot, { recursive: true, force: true });
  }
}

export async function refreshCurrentRunSources({
  appRoot,
  stateRoot,
  current,
  seedFile = path.join(appRoot, "config", "ozon_source_seed.txt"),
} = {}) {
  const absoluteStateRoot = path.resolve(stateRoot);
  const urlsFile = path.resolve(String(current?.urls_file || ""));
  const runDir = path.resolve(String(current?.run_dir || ""));
  if (urlsFile !== path.join(absoluteStateRoot, "sources", "active_urls.txt")) {
    throw new Error("current run source path is outside the production source state");
  }
  if (path.dirname(runDir) !== path.join(absoluteStateRoot, "runs")) {
    throw new Error("current run directory is outside the production run state");
  }
  const sourceRefresh = await run(process.execPath, [
    path.join(appRoot, "scripts", "ozon_source_portfolio.mjs"),
    "refresh",
    absoluteStateRoot,
    runDir,
    seedFile,
  ], { cwd: appRoot });
  if (!sourceRefresh.ok) {
    throw new Error(`same-run source portfolio refresh failed: ${sourceRefresh.stderr || sourceRefresh.error}`);
  }
  const sourceText = await fsp.readFile(urlsFile, "utf8");
  if (!sourceText.split(/\r?\n/u).some((line) => /^https:\/\//u.test(line.trim()))) {
    throw new Error("refreshed same-run source pool has no usable URLs");
  }
  const refreshed = {
    ...current,
    source_sha256: sha256(sourceText),
    source_set_sha256: sha256(sourceText),
    source_refreshed_at: new Date().toISOString(),
  };
  if (current?.formal_started === false) {
    const pendingPath = path.join(runDir, "pending_manifest.json");
    const pending = await readJson(pendingPath, {});
    await writeJsonAtomic(pendingPath, {
      ...pending,
      source_sha256: refreshed.source_sha256,
      source_set_sha256: refreshed.source_set_sha256,
      source_refreshed_at: refreshed.source_refreshed_at,
    });
  }
  await writeJsonAtomic(path.join(absoluteStateRoot, "current_run.json"), refreshed);
  return refreshed;
}

async function installCandidate({ sourceRoot, config, configSource }) {
  const paths = deploymentPaths(config);
  const repositoryRoot = path.resolve(sourceRoot, "..");
  const sourceRelative = path.relative(repositoryRoot, path.resolve(sourceRoot));
  const versionedInputs = [
    path.join(sourceRelative, "config"),
    path.join(sourceRelative, "scripts"),
    "package.json",
    "package-lock.json",
  ];
  const sourceStatus = await run("/usr/bin/git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...versionedInputs,
  ], { cwd: repositoryRoot });
  if (!sourceStatus.ok) {
    throw new Error(`cannot verify candidate source revision: ${sourceStatus.stderr || sourceStatus.error}`);
  }
  if (sourceStatus.stdout.trim()) {
    throw new Error(
      "candidate production inputs must be committed before install so deployment_manifest.source_commit is exact",
    );
  }
  await fsp.mkdir(paths.releases, { recursive: true });
  await fsp.mkdir(paths.stateRoot, { recursive: true });
  const rsync = await run("/usr/bin/rsync", [
    "-a",
    "--delete",
    "--exclude", "runs/",
    "--exclude", "runtime/",
    "--exclude", "data/flow_b/",
    "--exclude", "docs/",
    "--exclude", "tests/",
    "--exclude", "tests-js/",
    "--exclude", "exports/",
    "--exclude", ".pytest_cache/",
    "--exclude", ".DS_Store",
    "--exclude", "*.md",
    "--exclude", "*.jsonl",
    "--exclude", "current_store.json",
    `${path.resolve(sourceRoot)}/`,
    `${paths.candidate}/`,
  ]);
  if (!rsync.ok) throw new Error(`candidate install failed: ${rsync.stderr || rsync.error}`);
  for (const filename of ["package.json", "package-lock.json"]) {
    const source = path.join(repositoryRoot, filename);
    if (await pathExists(source)) await fsp.copyFile(source, path.join(paths.candidate, filename));
  }
  const npm = await run("/usr/bin/env", [
    "npm",
    "ci",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ], { cwd: paths.candidate });
  if (!npm.ok) throw new Error(`candidate dependency install failed: ${npm.stderr || npm.error}`);
  const candidateSources = await validateCandidateSourcePortfolio({
    appRoot: paths.candidate,
    releasesRoot: paths.releases,
    seedFile: path.join(paths.candidate, "config", "ozon_source_seed.txt"),
  });
  await copyInitialState(sourceRoot, paths.stateRoot);
  const configText = await fsp.readFile(configSource, "utf8");
  const revision = await run("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
  await writeJsonAtomic(path.join(paths.candidate, "deployment_manifest.json"), {
    installed_at: new Date().toISOString(),
    source_root: path.resolve(sourceRoot),
    source_commit: revision.ok ? revision.stdout.trim() : null,
    config_sha256: sha256(configText),
    source_set_sha256: candidateSources.sourceSetSha256,
    source_smoke_sha256: candidateSources.smokeSourceSetSha256,
    state_schema_version: Number(config.state_schema_version || 3),
    role: "candidate",
    launch_runtime_requires_git: false,
  });
  return {
    ok: true,
    candidate: paths.candidate,
    state_root: paths.stateRoot,
    config_sha256: sha256(configText),
    source_set_sha256: candidateSources.sourceSetSha256,
    active_source_count: candidateSources.activeSourceCount,
    state_schema_version: Number(config.state_schema_version || 3),
  };
}

async function replaceAppSymlink(appLink, stable) {
  const temporary = `${appLink}.next-${process.pid}`;
  await fsp.symlink(stable, temporary);
  try {
    const current = await fsp.lstat(appLink);
    if (!current.isSymbolicLink()) {
      const archived = `${appLink}.legacy-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
      await fsp.rename(appLink, archived);
    } else {
      await fsp.unlink(appLink);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fsp.rename(temporary, appLink);
}

async function promoteCandidate(config) {
  const paths = deploymentPaths(config);
  if (!await pathExists(path.join(paths.candidate, "deployment_manifest.json"))) {
    throw new Error("candidate is not installed");
  }
  const currentStatus = await readJson(path.join(paths.stateRoot, "operational_status.json"), {});
  if (ACTIVE_STATUSES.has(String(currentStatus?.status || ""))) {
    throw new Error(`cannot promote while production status is ${currentStatus.status}`);
  }
  if (await pathExists(paths.stable)) {
    await fsp.mkdir(paths.rollback, { recursive: true });
    const backup = await run("/usr/bin/rsync", ["-a", "--delete", `${paths.stable}/`, `${paths.rollback}/`]);
    if (!backup.ok) throw new Error(`rollback snapshot failed: ${backup.stderr || backup.error}`);
  }
  await fsp.mkdir(paths.stable, { recursive: true });
  const promotion = await run("/usr/bin/rsync", ["-a", "--delete", `${paths.candidate}/`, `${paths.stable}/`]);
  if (!promotion.ok) throw new Error(`candidate promotion failed: ${promotion.stderr || promotion.error}`);
  await replaceAppSymlink(paths.appLink, paths.stable);
  const { buildLaunchdPlist, resolveProductionLayout } = await loadSupervisorModule();
  const layout = resolveProductionLayout({ installRoot: paths.base });
  const plist = buildLaunchdPlist({
    label: config.launchd_label || LABEL,
    entryScript: layout.entryScript,
    stateRoot: paths.stateRoot,
  });
  await fsp.mkdir(path.dirname(paths.plist), { recursive: true });
  await fsp.writeFile(paths.plist, plist, "utf8");
  const lint = await run("/usr/bin/plutil", ["-lint", paths.plist]);
  if (!lint.ok) throw new Error(`launchd plist is invalid: ${lint.stderr || lint.error}`);
  const domain = `gui/${process.getuid()}`;
  const service = `${domain}/${config.launchd_label || LABEL}`;
  const loaded = await run("/bin/launchctl", ["print", service]);
  if (loaded.ok) await run("/bin/launchctl", ["bootout", service]);
  const bootstrap = await run("/bin/launchctl", ["bootstrap", domain, paths.plist]);
  if (!bootstrap.ok) throw new Error(`launchd bootstrap failed: ${bootstrap.stderr || bootstrap.error}`);
  await writeJsonAtomic(path.join(paths.stateRoot, "release_state.json"), {
    promoted_at: new Date().toISOString(),
    app_link: paths.appLink,
    stable: paths.stable,
    candidate: paths.candidate,
    rollback: await pathExists(paths.rollback) ? paths.rollback : null,
  });
  return { ok: true, stable: paths.stable, rollback: await pathExists(paths.rollback) ? paths.rollback : null };
}

async function optionalJsonObjectIsValid(filename) {
  if (!filename) return false;
  try {
    const value = JSON.parse(await fsp.readFile(filename, "utf8"));
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch (error) {
    return error.code === "ENOENT";
  }
}

async function doctor(config, { appRoot = null } = {}) {
  const paths = deploymentPaths(config);
  const resolvedApp = appRoot ? path.resolve(appRoot) : paths.appLink;
  const checks = {};
  const python = expandHome(config?.flow_env?.FLOW_B_PYTHON);
  const reportConfig = config?.daily_pricing_report || {};
  const reportNode = expandHome(reportConfig.node);
  const reportNodeModules = expandHome(reportConfig.node_modules);
  const reportOutputDir = expandHome(reportConfig.output_dir);
  const profitConfig = resolvedProfitLearningConfig(config);
  const required = {
    app: resolvedApp,
    config: path.join(resolvedApp, "config", "ozon_24h_production.json"),
    supervisor: path.join(resolvedApp, "scripts", "ozon_24h_supervisor.mjs"),
    worker: path.join(resolvedApp, "scripts", "flow_b_playwright.mjs"),
    python,
    python_requirements: path.join(resolvedApp, "requirements-1688.txt"),
    browser: expandHome(config.browser.executable),
    profile: expandHome(config.browser.profile_dir),
    extension: expandHome(config.browser.extension_dir),
    dedupe: path.join(paths.stateRoot, "dedupe", "published_links.csv"),
    sources: path.join(paths.stateRoot, "sources", "active_urls.txt"),
    report_generator: path.join(resolvedApp, "scripts", "generate_daily_pricing_report.mjs"),
    report_node: reportNode,
    report_node_modules: reportNodeModules,
  };
  if (profitConfig.enabled === true) {
    Object.assign(required, {
      profit_learning_core: path.join(
        resolvedApp,
        "scripts",
        "flow_b_playwright",
        "profit-learning.mjs",
      ),
      profit_learning_sidecar: path.join(
        resolvedApp,
        "scripts",
        "flow_b_playwright",
        "profit-learning-sidecar.mjs",
      ),
      profit_feedback_importer: path.join(resolvedApp, "scripts", "import_profit_feedback.mjs"),
      profit_node: profitConfig.node,
      profit_node_modules: profitConfig.node_modules,
    });
  }
  for (const [name, filename] of Object.entries(required)) checks[name] = await pathExists(filename);
  if (reportOutputDir) {
    await fsp.mkdir(reportOutputDir, { recursive: true });
    checks.report_output_dir = await pathExists(reportOutputDir);
  } else {
    checks.report_output_dir = false;
  }
  if (profitConfig.enabled === true) {
    const profitDirectories = {
      profit_output_dir: path.dirname(profitConfig.priority_file),
      profit_feedback_dir: profitConfig.feedback_dir,
      profit_runtime_root: profitConfig.runtime_root,
      profit_state_dir: path.dirname(profitConfig.learning_status),
    };
    for (const [name, directory] of Object.entries(profitDirectories)) {
      if (directory) await fsp.mkdir(directory, { recursive: true });
      checks[name] = Boolean(directory) && await pathExists(directory);
    }
    const profitJsonFiles = {
      profit_priority_json: profitConfig.priority_file,
      profit_feedback_json: profitConfig.feedback_file,
      profit_learning_status_json: profitConfig.learning_status,
      profit_feedback_status_json: profitConfig.feedback_status,
    };
    for (const [name, filename] of Object.entries(profitJsonFiles)) {
      checks[name] = await optionalJsonObjectIsValid(filename);
    }
    checks.season_priority_json = await optionalSeasonPriorityJsonIsValid(profitConfig.season_file);
  }
  if (checks.report_node && checks.report_node_modules) {
    const reportRuntime = path.join(paths.stateRoot, "report-runtime");
    const artifactProbe = await run(reportNode, [
      "-e",
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const { createRequire } = require('node:module');",
        "const root = process.argv[1];",
        "const modules = process.argv[2];",
        "fs.mkdirSync(root, { recursive: true });",
        "const link = path.join(root, 'node_modules');",
        "try { if (fs.existsSync(link) || fs.lstatSync(link)) fs.unlinkSync(link); } catch {}",
        "if (!fs.existsSync(link)) fs.symlinkSync(modules, link, 'dir');",
        "const requireFromRuntime = createRequire(path.join(root, 'entry.cjs'));",
        "const { Workbook, SpreadsheetFile } = requireFromRuntime('@oai/artifact-tool');",
        "const workbook = Workbook.create(); workbook.worksheets.add('doctor').getRange('A1').values = [['ok']];",
        "SpreadsheetFile.exportXlsx(workbook).then((file) => file.save(path.join(root, 'artifact-doctor.xlsx'))).then(() => { if (!fs.existsSync(path.join(root, 'artifact-doctor.xlsx'))) throw new Error('artifact export did not create a workbook'); }).catch((error) => { console.error(error); process.exitCode = 1; });",
      ].join("\n"),
      reportRuntime,
      reportNodeModules,
    ], {
      cwd: resolvedApp,
      env: process.env,
    });
    checks.report_artifact_tool = artifactProbe.ok;
  } else {
    checks.report_artifact_tool = false;
  }
  if (checks.python && checks.worker) {
    const probe = await run(python, [
      "-c",
      [
        "import importlib.util, pathlib, sys",
        "script = pathlib.Path(sys.argv[1]).resolve()",
        "spec = importlib.util.spec_from_file_location('ozon_1688_doctor', script)",
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "session_class = module.load_sync_session_class()",
        "assert session_class.__name__ == 'Sync1688Session'",
      ].join("; "),
      path.join(resolvedApp, "scripts", "flow_b_1688_sync.py"),
    ], { timeout: 15_000 });
    checks.python_1688_runtime = probe.ok;
  } else {
    checks.python_1688_runtime = false;
  }
  try {
    const [releaseConfigText, deployment] = await Promise.all([
      fsp.readFile(required.config, "utf8"),
      readJson(path.join(resolvedApp, "deployment_manifest.json"), {}),
    ]);
    checks.release_identity = deploymentIdentityValid(deployment, releaseConfigText);
  } catch {
    checks.release_identity = false;
  }
  const disk = await run("/bin/df", ["-Pk", paths.stateRoot]);
  const availableKb = disk.ok ? Number(disk.stdout.trim().split(/\s+/).slice(-3, -2)[0]) : 0;
  checks.disk = availableKb >= Number(config.minimum_free_disk_kb || 5242880);
  const processResult = await run("/bin/ps", ["-axo", "command="]);
  const marker = `--user-data-dir=${expandHome(config.browser.profile_dir)}`;
  const ownerCount = processResult.ok
    ? processResult.stdout.split(/\r?\n/).filter((line) => line.includes(marker) && !line.includes(" --type=")).length
    : 0;
  checks.profile_owner_unique = ownerCount <= 1;
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    profile_owner_count: ownerCount,
    app_root: resolvedApp,
    state_root: paths.stateRoot,
    available_disk_kb: availableKb,
  };
}

function localRunId(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((entry) => [entry.type, entry.value]));
  return `${value.year}${value.month}${value.day}_${value.hour}${value.minute}${value.second}_ozon_24h_production`;
}

async function kickstart(config) {
  const service = `gui/${process.getuid()}/${config.launchd_label || LABEL}`;
  const result = await run("/bin/launchctl", ["kickstart", "-k", service]);
  if (!result.ok) throw new Error(`launchd kickstart failed: ${result.stderr || result.error}`);
}

async function normalizeDirectCompletionStatus(config, paths, status, current) {
  if (config.runtime_mode !== "direct") return status;
  const acceptedRows = current?.run_dir
    ? await readJsonLines(path.join(current.run_dir, "erp_accepted.jsonl"))
    : [];
  const decision = directCompletionEvidenceDecision({
    status,
    current,
    acceptedCount: uniqueSkuCount(acceptedRows),
    target: config.publish_target,
  });
  if (decision.action !== "resume-current-run") return status;
  const repaired = {
    ...status,
    status: "STOPPED",
    reason: decision.unlimited
      ? "legacy-target-removed-continuous-resume"
      : "direct-target-completion-evidence-missing",
    observed_at: new Date().toISOString(),
    accepted: decision.accepted,
    target: decision.target,
    unlimited: decision.unlimited === true,
  };
  await writeJsonAtomic(path.join(paths.stateRoot, "operational_status.json"), repaired);
  return repaired;
}

async function start(config) {
  const paths = deploymentPaths(config);
  const processResult = await run("/bin/ps", ["-axo", "pid=,command="]);
  if (!processResult.ok) {
    const error = new Error(`cannot verify global worker ownership: ${processResult.stderr || processResult.error}`);
    error.code = "OZON_PROCESS_OWNERSHIP_UNKNOWN";
    throw error;
  }
  const existingWorkerPids = globalFlowBWorkerPids(processResult.stdout.split(/\r?\n/u));
  if (existingWorkerPids.length > 0) {
    const error = new Error(`refusing production start while a flow_b worker is active: ${existingWorkerPids.join(",")}`);
    error.code = "OZON_GLOBAL_WORKER_ALREADY_RUNNING";
    error.worker_pids = existingWorkerPids;
    throw error;
  }
  let status = await readJson(path.join(paths.stateRoot, "operational_status.json"), {});
  const current = await readJson(path.join(paths.stateRoot, "current_run.json"), {});
  status = await normalizeDirectCompletionStatus(config, paths, status, current);
  if (shouldResumeCurrentRun(status, current)) {
    const [releaseConfigText, deployment] = await Promise.all([
      fsp.readFile(path.join(paths.appLink, "config", "ozon_24h_production.json"), "utf8"),
      readJson(path.join(paths.appLink, "deployment_manifest.json"), {}),
    ]);
    const releaseConfigHash = sha256(releaseConfigText);
    if (!String(deployment?.source_commit || "")
      || String(deployment?.config_sha256 || "") !== releaseConfigHash
      || Number(deployment?.state_schema_version) !== 3) {
      const error = new Error("promoted release identity is missing or inconsistent");
      error.code = "OZON_RELEASE_IDENTITY_INVALID";
      throw error;
    }
    const runDir = path.resolve(current.run_dir);
    if (path.dirname(runDir) !== path.join(paths.stateRoot, "runs")
      || path.resolve(current.urls_file) !== path.join(paths.stateRoot, "sources", "active_urls.txt")) {
      const error = new Error("current run paths are outside the production state root");
      error.code = "OZON_PRODUCTION_STATE_PATH_INVALID";
      throw error;
    }
    if (config.runtime_mode !== "direct") {
      const { productionRunContractDecision } = await loadSupervisorModule();
      const contract = productionRunContractDecision({
        currentRun: current,
        pendingManifest: await readJson(path.join(runDir, "pending_manifest.json"), {}),
        acceptanceWindow: await readJson(path.join(runDir, "acceptance_window.json"), {}),
        sourceConfig: await readJson(path.join(runDir, "source_config.json"), {}),
        frozenManifest: await readJson(path.join(runDir, "frozen_manifest.json"), {}),
        expectedConfigHash: releaseConfigHash,
        expectedCommitSha: deployment.source_commit,
      });
      if (contract.action !== "continue") {
        const error = new Error(`${contract.reason}: ${contract.issues.join(",")}`);
        error.code = "OZON_PRODUCTION_RUN_CONTRACT";
        error.contract = contract;
        throw error;
      }
    }
    const mode = resumeMode(status, current);
    const resumedCurrent = mode === "restart-current-run" && current.formal_started === false
      ? await refreshCurrentRunSources({
        appRoot: paths.appLink,
        stateRoot: paths.stateRoot,
        current,
      })
      : current;
    await fsp.unlink(path.join(paths.stateRoot, "stop.request")).catch(() => {});
    await writeJsonAtomic(path.join(paths.stateRoot, "operational_status.json"), {
      ...status,
      status: "STARTING",
      reason: "user requested same-run resume",
      observed_at: new Date().toISOString(),
      run_id: resumedCurrent.run_id,
      run_dir: resumedCurrent.run_dir,
    });
    await kickstart(config);
    return {
      ok: true,
      resumed: true,
      run_id: resumedCurrent.run_id,
      run_dir: resumedCurrent.run_dir,
      source_sha256: resumedCurrent.source_sha256,
    };
  }
  const sourceRefresh = await run(process.execPath, [
    path.join(paths.appLink, "scripts", "ozon_source_portfolio.mjs"),
    "refresh",
    paths.stateRoot,
    "-",
    path.join(paths.appLink, "config", "ozon_source_seed.txt"),
  ], { cwd: paths.appLink });
  if (!sourceRefresh.ok) throw new Error(`source portfolio refresh failed: ${sourceRefresh.stderr || sourceRefresh.error}`);
  const sources = path.join(paths.stateRoot, "sources", "active_urls.txt");
  if (!await pathExists(sources)) throw new Error("active source pool is missing");
  const sourceText = await fsp.readFile(sources, "utf8");
  if (!sourceText.split(/\r?\n/).some((line) => /^https:\/\//u.test(line.trim()))) {
    throw new Error("active source pool has no usable URLs");
  }
  const runId = localRunId();
  const runDir = path.join(paths.stateRoot, "runs", runId);
  await fsp.mkdir(runDir, { recursive: true });
  const requestedAt = new Date();
  const configText = await fsp.readFile(path.join(paths.appLink, "config", "ozon_24h_production.json"), "utf8");
  const directMode = config.runtime_mode === "direct";
  await writeJsonAtomic(path.join(runDir, directMode ? "direct_manifest.json" : "pending_manifest.json"), {
    run_id: runId,
    requested_at: requestedAt.toISOString(),
    config_sha256: sha256(configText),
    source_sha256: sha256(sourceText),
    source_set_sha256: sha256(sourceText),
    state_schema_version: Number(config.state_schema_version || 3),
    runtime_mode: directMode ? "direct" : "strict-acceptance",
    target_metric: directMode ? "daily_erp_accepted_unique_skus" : "strict_online_skus",
    publish_target: directMode ? null : undefined,
    unlimited_publish: directMode ? true : undefined,
    current_store_id: directMode ? Number(config.starting_store_id || 0) || undefined : undefined,
    formal_window_started: directMode,
  });
  if (directMode) {
    await writeJsonAtomic(path.join(runDir, "source_config.json"), {
      mode: "direct-publish",
      urls_file: sources,
      target_metric: "daily_erp_accepted_unique_skus",
      publish_target: null,
      unlimited_publish: true,
      minimum_profit_rate_exclusive: Number(config.minimum_profit_rate_exclusive || 30),
      minimum_same_item_matches: 1,
      store_targets: config.flow_env?.FLOW_B_STORE_TARGETS || [],
    });
  }
  await writeJsonAtomic(path.join(paths.stateRoot, "current_run.json"), {
    run_id: runId,
    run_dir: runDir,
    urls_file: sources,
    requested_at: requestedAt.toISOString(),
    formal_started: directMode,
    runtime_mode: directMode ? "direct" : "strict-acceptance",
    target_metric: directMode ? "daily_erp_accepted_unique_skus" : "strict_online_skus",
    publish_target: directMode ? null : undefined,
    unlimited_publish: directMode ? true : undefined,
    current_store_id: directMode ? Number(config.starting_store_id || 0) || undefined : undefined,
    config_sha256: sha256(configText),
    source_sha256: sha256(sourceText),
    source_set_sha256: sha256(sourceText),
    state_schema_version: Number(config.state_schema_version || 3),
  });
  await writeJsonAtomic(path.join(paths.stateRoot, "operational_status.json"), {
    status: directMode ? "STARTING" : "PREFLIGHTING_CAPACITY",
    observed_at: new Date().toISOString(),
    run_id: runId,
    run_dir: runDir,
  });
  await kickstart(config);
  return { ok: true, resumed: false, run_id: runId, run_dir: runDir };
}

async function stop(config) {
  const paths = deploymentPaths(config);
  await fsp.writeFile(path.join(paths.stateRoot, "stop.request"), `${new Date().toISOString()}\n`, "utf8");
  const service = `gui/${process.getuid()}/${config.launchd_label || LABEL}`;
  await run("/bin/launchctl", ["kill", "SIGTERM", service]);
  return {
    ok: true,
    stop_requested: true,
    behavior: "supervisor is stopping its owned child at a durable state-machine boundary",
  };
}

async function actualRuntimeOwnerCounts(config, current) {
  const processResult = await run("/bin/ps", ["-axo", "pid=,command="]);
  if (!processResult.ok) {
    const error = new Error(`cannot verify production process ownership: ${processResult.stderr || processResult.error}`);
    error.code = "OZON_PROCESS_OWNERSHIP_UNKNOWN";
    throw error;
  }
  const lines = processResult.stdout.split(/\r?\n/u).filter(Boolean);
  const profileMarker = `--user-data-dir=${expandHome(config.browser.profile_dir)}`;
  return {
    supervisor: productionSupervisorPids(lines).length,
    worker: globalFlowBWorkerPids(lines).length,
    profile: productionProfileOwnerPids(
      lines,
      profileMarker,
      expandHome(config.browser.executable),
    ).length,
  };
}

export function effectiveRuntimeOwners(persisted = {}, actual = null) {
  if (actual && typeof actual === "object") {
    return {
      supervisor: Math.max(0, Number(actual.supervisor) || 0),
      worker: Math.max(0, Number(actual.worker) || 0),
      profile: Math.max(0, Number(actual.profile) || 0),
    };
  }
  return {
    supervisor: Math.max(0, Number(persisted?.counts?.supervisor) || 0),
    worker: Math.max(0, Number(persisted?.counts?.worker) || 0),
    profile: Math.max(0, Number(persisted?.counts?.profile_owner) || 0),
  };
}

async function retireCurrentRun(config) {
  const paths = deploymentPaths(config);
  const [statusValue, current] = await Promise.all([
    readJson(path.join(paths.stateRoot, "operational_status.json"), {}),
    readJson(path.join(paths.stateRoot, "current_run.json"), {}),
  ]);
  const owners = await actualRuntimeOwnerCounts(config, current);
  const decision = currentRunRetirementDecision({
    status: statusValue,
    current,
    owners,
  });
  if (decision.action !== "retire") {
    const error = new Error(decision.reason);
    error.code = "OZON_CURRENT_RUN_RETIREMENT_REJECTED";
    error.owners = owners;
    throw error;
  }
  const retiredAt = new Date();
  const safeRunId = String(current.run_id).replace(/[^a-zA-Z0-9_.-]/gu, "_");
  const archivePath = path.join(
    paths.stateRoot,
    "history",
    "retired_runs",
    `${retiredAt.toISOString().replace(/\D/gu, "").slice(0, 14)}_${safeRunId}.json`,
  );
  await writeJsonAtomic(archivePath, {
    retired_at: retiredAt.toISOString(),
    reason: decision.reason,
    owners,
    operational_status: statusValue,
    current_run: current,
    evidence_preserved_at: current.run_dir,
  });
  await writeJsonAtomic(path.join(paths.stateRoot, "operational_status.json"), {
    observed_at: retiredAt.toISOString(),
    status: "RETIRED",
    reason: decision.reason,
    retired_run_id: current.run_id,
    retired_run_dir: current.run_dir,
    archive_path: archivePath,
  });
  await writeJsonAtomic(path.join(paths.stateRoot, "current_run.json"), {});
  await writeJsonAtomic(path.join(paths.stateRoot, "process_owners.json"), {
    observed_at: retiredAt.toISOString(),
    run_id: null,
    supervisor_pid: null,
    worker_pid: null,
    profile_owner_pid: null,
    counts: {
      supervisor: 0,
      worker: 0,
      profile_owner: 0,
    },
  });
  return {
    ok: true,
    retired_run_id: current.run_id,
    retired_run_dir: current.run_dir,
    archive_path: archivePath,
    evidence_preserved: true,
  };
}

async function resume(config) {
  const paths = deploymentPaths(config);
  let status = await readJson(path.join(paths.stateRoot, "operational_status.json"), {});
  const current = await readJson(path.join(paths.stateRoot, "current_run.json"), {});
  status = await normalizeDirectCompletionStatus(config, paths, status, current);
  const mode = resumeMode(status, current);
  const manualClearance = mode === "verification" || mode === "restart-current-run"
    ? await clearOzonManualVerificationLock({ config, stateRoot: paths.stateRoot })
    : { cleared: false, reason: "not-waiting-for-verification" };
  if (mode === "restart-current-run") {
    return { ...(await start(config)), manual_clearance: manualClearance };
  }
  await fsp.writeFile(path.join(paths.stateRoot, "resume.request"), `${new Date().toISOString()}\n`, "utf8");
  await kickstart(config);
  return { ok: true, resume_requested: true, manual_clearance: manualClearance };
}

function shortText(value, maximum = 160) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

export function compactProductionStatus({
  current = {},
  operational = {},
  owners = {},
  checkpoint = {},
} = {}) {
  const value = checkpoint?.compact || checkpoint || {};
  const hasCurrentRun = Boolean(String(current?.run_id || "").trim());
  return {
    at: operational.observed_at || value.at || null,
    status: operational.status || "UNKNOWN",
    reason: shortText(operational.reason || "", 160) || null,
    run_id: current.run_id || null,
    formal_started: current.formal_started === true,
    strict: Number(value.strict || 0),
    target: Number(value.target || 500),
    rate_h: Number(value.rate_h || 0),
    rolling_120_h: Number(value?.rolling_h?.["120"] || 0),
    by_store: value.by_store || {},
    pending: value.pending || {},
    constrained: value.constrained || [],
    errors: Number(value.errors || 0),
    owners: {
      supervisor: hasCurrentRun ? Number(owners?.counts?.supervisor || 0) : 0,
      worker: hasCurrentRun ? Number(owners?.counts?.worker || 0) : 0,
      profile: hasCurrentRun ? Number(owners?.counts?.profile_owner || 0) : 0,
    },
    identity: {
      config_sha256: current.config_sha256 || null,
      source_set_sha256: current.source_set_sha256 || current.source_sha256 || null,
      state_schema_version: Number(current.state_schema_version || 3),
    },
  };
}

function uniqueSkuCount(rows) {
  return new Set((rows || []).map((row) => String(row?.sku ?? row?.data?.sku ?? "").trim()).filter(Boolean)).size;
}

export function shanghaiDateKey(value = new Date(), timeZone = "Asia/Shanghai") {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((entry) => [entry.type, entry.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function dailyAcceptedSummary(rows = [], {
  now = new Date(),
  timeZone = "Asia/Shanghai",
} = {}) {
  const date = shanghaiDateKey(now, timeZone);
  const acceptedBySku = new Map();
  for (const row of rows || []) {
    const sku = String(row?.sku ?? row?.data?.sku ?? "").trim();
    const acceptedAt = row?.accepted_at || row?.api_call_accepted_at || row?.at || row?.timestamp;
    if (!sku || shanghaiDateKey(acceptedAt, timeZone) !== date) continue;
    acceptedBySku.set(sku, row);
  }
  const byStore = {};
  for (const row of acceptedBySku.values()) {
    const key = String(Number(row?.store_id ?? row?.data?.store_id) || "unknown");
    byStore[key] = Number(byStore[key] || 0) + 1;
  }
  return {
    date,
    accepted: acceptedBySku.size,
    by_store: byStore,
  };
}

function errorFingerprint(row) {
  const source = shortText(
    row?.reason || row?.error || row?.message || row?.data?.reason || row?.data?.error || "unknown",
    500,
  ).toLowerCase()
    .replace(/https?:\/\/\S+/gu, "<url>")
    .replace(/\b\d+\b/gu, "<n>");
  return {
    fingerprint: sha256(source).slice(0, 12),
    reason: shortText(source, 120),
  };
}

export function buildIncidentDigest({
  failed = [],
  skipped = [],
  runtimeErrors = [],
  candidates = [],
  selected = [],
  published = [],
  recoveries = [],
} = {}) {
  const fingerprints = new Map();
  for (const row of [...failed, ...skipped, ...runtimeErrors]) {
    const value = errorFingerprint(row);
    const existing = fingerprints.get(value.fingerprint) || { ...value, count: 0 };
    existing.count += 1;
    fingerprints.set(value.fingerprint, existing);
  }
  return {
    generated_at: new Date().toISOString(),
    unique_skus: {
      failed: uniqueSkuCount(failed),
      skipped: uniqueSkuCount(skipped),
      runtime_error: uniqueSkuCount(runtimeErrors),
    },
    funnel: {
      candidate: uniqueSkuCount(candidates),
      selected: uniqueSkuCount(selected),
      strict_published: uniqueSkuCount(published),
    },
    error_fingerprints: [...fingerprints.values()]
      .sort((left, right) => right.count - left.count || left.fingerprint.localeCompare(right.fingerprint))
      .slice(0, 10),
    recent_recoveries: recoveries.slice(-5).map((row) => ({
      at: row?.at || null,
      action: shortText(row?.action || "", 80),
      outcome: shortText(row?.outcome || row?.reason || "", 120) || null,
    })),
  };
}

async function status(config) {
  const paths = deploymentPaths(config);
  const current = await readJson(path.join(paths.stateRoot, "current_run.json"), {});
  const operational = await readJson(path.join(paths.stateRoot, "operational_status.json"), {});
  const owners = await readJson(path.join(paths.stateRoot, "process_owners.json"), {});
  const storageConfig = config?.storage_maintenance || {};
  const storage = await diskHealthSnapshot({
    stateRoot: paths.stateRoot,
    warningFreeBytes: Number(storageConfig.warning_free_disk_kb || 10 * 1024 * 1024) * 1024,
    criticalFreeBytes: Number(storageConfig.critical_free_disk_kb || 5 * 1024 * 1024) * 1024,
    warningUsedPercent: Number(storageConfig.warning_used_percent || 95),
    criticalUsedPercent: Number(storageConfig.critical_used_percent || 98),
  }).catch((error) => ({
    observed_at: new Date().toISOString(),
    severity: "unknown",
    alert: true,
    reasons: ["storage-health-unavailable"],
    error: shortText(error?.message || error, 160),
  }));
  const actualOwners = await actualRuntimeOwnerCounts(config, current).catch(() => null);
  const effectiveOwners = effectiveRuntimeOwners(owners, actualOwners);
  const checkpoint = current?.run_dir
    ? await readJson(path.join(current.run_dir, "compact_checkpoint.json"), {})
    : {};
  const profitLearning = await readProfitLearningStatus(config, paths);
  if (config.runtime_mode === "direct" && current?.run_dir) {
    const acceptedTimeZone = String(
      config?.flow_env?.FLOW_B_DAILY_STORE_TIMEZONE || "Asia/Shanghai",
    );
    const configuredIndexFile = String(process.env.OZON_CONTROL_STATUS_INDEX_FILE || "").trim();
    const indexFile = configuredIndexFile
      ? path.resolve(configuredIndexFile)
      : path.join(paths.stateRoot, "control_status_index_v1.json");
    let directMetrics;
    try {
      directMetrics = await loadControlStatusIndex(current.run_dir, {
        indexFile,
        timeZone: acceptedTimeZone,
      });
    } catch {
      // Preserve status availability if the optional cache cannot be read. The
      // JSONL evidence remains authoritative and this is the prior exact path.
      const [funnel, acceptedRows, backgroundRows] = await Promise.all([
        readJsonLines(path.join(current.run_dir, "direct_funnel.jsonl")),
        readJsonLines(path.join(current.run_dir, "erp_accepted.jsonl")),
        readJsonLines(path.join(current.run_dir, "background_status.jsonl")),
      ]);
      const byStoreRun = {};
      for (const row of acceptedRows) {
        const key = String(Number(row?.store_id) || "unknown");
        byStoreRun[key] = Number(byStoreRun[key] || 0) + 1;
      }
      directMetrics = {
        stage_counts: Object.fromEntries([
          "candidate_required_fields_passed",
          "snapshot_category_passed",
          "cost_passed",
          "live_price_confirmed",
          "profit_passed",
        ].map((stage) => [stage, uniqueSkuCount(funnel.filter((row) => row?.stage === stage))])),
        run_accepted: uniqueSkuCount(acceptedRows),
        by_store_run: byStoreRun,
        today: dailyAcceptedSummary(acceptedRows, { timeZone: acceptedTimeZone }),
        online: uniqueSkuCount(backgroundRows.filter((row) => row?.online === true)),
      };
    }
    const matchPolicyState = await readJson(path.join(current.run_dir, "1688_match_policy.json"), {});
    const stageCount = (stage) => Number(directMetrics?.stage_counts?.[stage] || 0);
    const runAccepted = Number(directMetrics.run_accepted || 0);
    const byStoreRun = directMetrics.by_store_run || {};
    const today = directMetrics.today;
    const dailyTimeZone = String(config?.daily_pricing_report?.time_zone
      || config?.flow_env?.FLOW_B_DAILY_STORE_TIMEZONE
      || "Asia/Shanghai");
    const submissionWindow = dailyWindowState({
      now: new Date(),
      timeZone: dailyTimeZone,
      cutoff: config?.daily_pricing_report?.cutoff || "20:00",
      reportAfter: config?.daily_pricing_report?.report_after || "20:30",
    });
    const reportStatus = await readJson(
      path.join(paths.stateRoot, "daily_pricing_report_status.json"),
      {
        status: submissionWindow.report_eligible ? "waiting" : "waiting_for_report_time",
        date: submissionWindow.date,
        output: reportOutputPath(config?.daily_pricing_report?.output_dir, submissionWindow.date),
      },
    );
    const dailyByStore = Object.fromEntries((config.stores || []).map((store) => {
      const id = String(Number(store.id));
      const accepted = Number(today.by_store[id] || 0);
      return [id, {
        store_id: Number(store.id),
        store_name: store.name || store.needle || id,
        target: 100,
        accepted,
        remaining: Math.max(0, 100 - accepted),
      }];
    }));
    return {
      at: operational.observed_at || new Date().toISOString(),
      status: operational.status || "UNKNOWN",
      reason: shortText(operational.reason || "", 160) || null,
      run_id: current.run_id || null,
      runtime_mode: "direct",
      target_metric: "daily_erp_accepted_unique_skus",
      count_date: today.date,
      target: null,
      remaining: null,
      unlimited: true,
      run_accepted: runAccepted,
      funnel: {
        candidate_required_fields_passed: stageCount("candidate_required_fields_passed"),
        snapshot_category_passed: stageCount("snapshot_category_passed"),
        cost_passed: stageCount("cost_passed"),
        live_price_confirmed: stageCount("live_price_confirmed"),
        profit_passed: stageCount("profit_passed"),
        erp_accepted: today.accepted,
        online: Number(directMetrics.online || 0),
      },
      by_store: today.by_store,
      daily_by_store: dailyByStore,
      by_store_run: byStoreRun,
      daily_submission_window: submissionWindow,
      daily_pricing_report: reportStatus,
      storage,
      profit_learning: profitLearning,
      match_policy: {
        configured: matchPolicyState.configured_policy || config?.flow_env?.FLOW_B_1688_MATCH_POLICY || "shadow",
        effective: matchPolicyState.effective_policy || config?.flow_env?.FLOW_B_1688_MATCH_POLICY || "shadow",
        sample_count: Number(matchPolicyState?.summary?.sample_count || 0),
        retention_percent: Number(matchPolicyState?.summary?.retention_percent || 0),
        image_availability_percent: Number(matchPolicyState?.summary?.image_availability_percent || 0),
        p95_ms: Number(matchPolicyState?.summary?.p95_ms || 0),
        promoted_at: matchPolicyState.promoted_at || null,
        adaptive_action: {
          configured: matchPolicyState.adaptive_action_policy
            || config?.flow_env?.FLOW_B_1688_ADAPTIVE_ACTION_POLICY
            || "shadow",
          effective: matchPolicyState.adaptive_action_policy
            || config?.flow_env?.FLOW_B_1688_ADAPTIVE_ACTION_POLICY
            || "shadow",
          sample_target: Number(
            matchPolicyState.adaptive_action_sample_target
              || config?.flow_env?.FLOW_B_1688_ADAPTIVE_ACTION_SAMPLE_TARGET
              || 100,
          ),
          complete_samples: Number(matchPolicyState?.summary?.complete_action_samples || 0),
          collection_status: matchPolicyState?.summary?.collection_status || "collecting",
          allow_count: Number(matchPolicyState?.summary?.action_allow_count || 0),
          allow_percent: Number(matchPolicyState?.summary?.action_allow_percent || 0),
          reject_count: Number(matchPolicyState?.summary?.action_reject_count || 0),
          reject_percent: Number(matchPolicyState?.summary?.action_reject_percent || 0),
          automatic_enforcement: false,
        },
      },
      owners: {
        supervisor: effectiveOwners.supervisor,
        worker: effectiveOwners.worker,
        profile: effectiveOwners.profile,
      },
      identity: {
        config_sha256: current.config_sha256 || null,
        source_set_sha256: current.source_set_sha256 || current.source_sha256 || null,
        state_schema_version: Number(current.state_schema_version || 3),
      },
    };
  }
  return {
    ...compactProductionStatus({
      current,
      operational,
      owners: {
        counts: {
          supervisor: effectiveOwners.supervisor,
          worker: effectiveOwners.worker,
          profile_owner: effectiveOwners.profile,
        },
      },
      checkpoint,
    }),
    storage,
    profit_learning: profitLearning,
  };
}

async function reportStatus(config, dateKey = null) {
  const paths = deploymentPaths(config);
  const selectedDate = dateKey || null;
  const value = selectedDate
    ? await readJson(path.join(paths.stateRoot, "daily_pricing_reports", `${selectedDate}.json`), {
        status: "not-started",
        date: selectedDate,
        output: reportOutputPath(config?.daily_pricing_report?.output_dir, selectedDate),
      })
    : await readJson(path.join(paths.stateRoot, "daily_pricing_report_status.json"), {
        status: "not-started",
        date: null,
      });
  return {
    ...value,
    state_root: paths.stateRoot,
    output: value.output || (value.date
      ? reportOutputPath(config?.daily_pricing_report?.output_dir, value.date)
      : null),
  };
}

async function manualGenerateReport(config, dateKey = null) {
  const paths = deploymentPaths(config);
  const current = await readJson(path.join(paths.stateRoot, "current_run.json"), {});
  if (!current?.run_dir) throw new Error("current production run is unavailable");
  const { runDailyPricingReportCheck } = await loadSupervisorModule();
  const result = await runDailyPricingReportCheck({
    config,
    stateRoot: paths.stateRoot,
    runDir: current.run_dir,
    currentRun: current,
    appRoot: paths.appLink,
    dateKey,
    notify: false,
  });
  return {
    ok: ["delivered", "generating"].includes(String(result?.status || "")),
    ...result,
  };
}

async function incident(config) {
  const paths = deploymentPaths(config);
  const current = await readJson(path.join(paths.stateRoot, "current_run.json"), {});
  const runDir = path.resolve(String(current?.run_dir || path.join(paths.stateRoot, "runs", "missing")));
  const [failed, skipped, runtimeErrors, candidates, selected, published, recoveries] = await Promise.all([
    readJsonLines(path.join(runDir, "failed.jsonl")),
    readJsonLines(path.join(runDir, "skipped.jsonl")),
    readJsonLines(path.join(runDir, "runtime_errors.jsonl")),
    readJsonLines(path.join(runDir, "candidate_queue.jsonl")),
    readJsonLines(path.join(runDir, "selected.jsonl")),
    readJsonLines(path.join(runDir, "published.jsonl")),
    readJsonLines(path.join(paths.stateRoot, "recovery.jsonl")),
  ]);
  return buildIncidentDigest({
    failed,
    skipped,
    runtimeErrors,
    candidates,
    selected,
    published,
    recoveries: recoveries.filter((row) => path.resolve(String(row?.run_dir || "")) === runDir),
  });
}

async function exportConfirmed(config) {
  const paths = deploymentPaths(config);
  const current = await readJson(path.join(paths.stateRoot, "current_run.json"));
  const output = path.join(paths.stateRoot, "exports", current.run_id);
  await fsp.mkdir(output, { recursive: true });
  const confirmed = await run(process.execPath, [
    path.join(paths.appLink, "scripts", "export_confirmed_store_skus.mjs"),
    current.run_dir,
    output,
  ], { cwd: paths.appLink });
  if (!confirmed.ok) throw new Error(`confirmed export failed: ${confirmed.stderr || confirmed.error}`);
  return { ok: true, output_dir: output };
}

async function main(argv = process.argv.slice(2)) {
  const [command = "start", firstArg, secondArg, thirdArg] = argv;
  const reportCommand = command === "report" || command === "report-status";
  const dateKey = reportCommand && /^\d{4}-\d{2}-\d{2}$/u.test(String(firstArg || ""))
    ? String(firstArg)
    : null;
  const sourceRootArg = dateKey ? secondArg : firstArg;
  const configPathArg = dateKey ? thirdArg : secondArg;
  const sourceRoot = path.resolve(sourceRootArg || import.meta.dirname, sourceRootArg ? "." : "..");
  const configPath = path.resolve(configPathArg || path.join(sourceRoot, "config", "ozon_24h_production.json"));
  const config = validateConfig(await readJson(configPath));
  let result;
  if (command === "install-candidate" || command === "install") {
    result = await installCandidate({ sourceRoot, config, configSource: configPath });
  } else if (command === "promote") {
    result = await promoteCandidate(config);
  } else if (command === "doctor") {
    result = await doctor(config);
  } else if (command === "doctor-candidate") {
    result = await doctor(config, { appRoot: deploymentPaths(config).candidate });
  } else if (command === "start") {
    result = await start(config);
  } else if (command === "stop") {
    result = await stop(config);
  } else if (command === "retire-current") {
    result = await retireCurrentRun(config);
  } else if (command === "resume") {
    result = await resume(config);
  } else if (command === "status") {
    result = await status(config);
  } else if (command === "report-status") {
    result = await reportStatus(config, dateKey);
  } else if (command === "report") {
    result = await manualGenerateReport(config, dateKey);
  } else if (command === "incident") {
    result = await incident(config);
  } else if (command === "export") {
    result = await exportConfirmed(config);
  } else {
    throw new Error("usage: ozon_24h_production.sh [start|install-candidate|doctor-candidate|promote|doctor|status|report-status [YYYY-MM-DD]|report [YYYY-MM-DD]|incident|stop|retire-current|resume|export]");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result?.ok === false ? 1 : 0;
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) {
  main().then(
    (code) => { process.exitCode = Number(code) || 0; },
    (error) => {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        code: error?.code || "OZON_PRODUCTION_CONTROL_ERROR",
        error: String(error?.message || error),
      })}\n`);
      process.exitCode = 1;
    },
  );
}

export {
  deploymentPaths,
  doctor,
  incident,
  installCandidate,
  retireCurrentRun,
  status,
  validateConfig,
};
