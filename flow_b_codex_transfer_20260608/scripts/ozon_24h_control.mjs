#!/usr/bin/env node

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildLaunchdPlist,
  productionRunContractDecision,
  resolveProductionLayout,
} from "./ozon_24h_supervisor.mjs";

const execFileAsync = promisify(execFile);
const LABEL = "com.codex.ozon.24h-production";
const ACTIVE_STATUSES = new Set([
  "STARTING",
  "PREFLIGHTING_CAPACITY",
  "PREWARMING_CANDIDATES",
  "PREPARING_CANDIDATE_BUFFER",
  "WAITING_FOR_QUOTA_RESET",
  "RUNNING",
  "RECOVERING",
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

export function currentRunRetirementDecision({
  status = {},
  current = {},
  owners = {},
} = {}) {
  if (String(status?.status || "") !== "STOPPED") {
    return { action: "reject", reason: "current-run-is-not-safely-stopped" };
  }
  if (!current?.run_id || !current?.run_dir || !current?.urls_file) {
    return { action: "reject", reason: "current-run-identity-is-incomplete" };
  }
  if (["supervisor", "worker", "profile"].some((name) => Number(owners?.[name] || 0) !== 0)) {
    return { action: "reject", reason: "current-run-still-has-live-owners" };
  }
  return { action: "retire", reason: "superseded-by-fixed-500-v3" };
}

export function globalFlowBWorkerPids(lines = []) {
  const pids = new Set();
  for (const line of lines || []) {
    const match = String(line || "").trim().match(/^(\d+)\s+([\s\S]+)$/u);
    if (!match) continue;
    const command = match[2];
    if (
      command.includes("flow_b_playwright.mjs")
      && /\b(?:accept|run|publish)\b/u.test(command)
    ) {
      pids.add(Number(match[1]));
    }
  }
  return [...pids].sort((left, right) => left - right);
}

function expandHome(value) {
  return String(value || "").replaceAll("${HOME}", process.env.HOME || "/Users/mac");
}

async function readJson(filename, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== null) return fallback;
    throw error;
  }
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

async function doctor(config, { appRoot = null } = {}) {
  const paths = deploymentPaths(config);
  const resolvedApp = appRoot ? path.resolve(appRoot) : paths.appLink;
  const checks = {};
  const runtimeConfig = expandedConfig(config);
  const python = expandTemplate(
    runtimeConfig?.flow_env?.FLOW_B_PYTHON,
    runtimeConfig,
  );
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
  };
  for (const [name, filename] of Object.entries(required)) checks[name] = await pathExists(filename);
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
  const status = await readJson(path.join(paths.stateRoot, "operational_status.json"), {});
  const current = await readJson(path.join(paths.stateRoot, "current_run.json"), {});
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
  await writeJsonAtomic(path.join(runDir, "pending_manifest.json"), {
    run_id: runId,
    requested_at: requestedAt.toISOString(),
    config_sha256: sha256(configText),
    source_sha256: sha256(sourceText),
    source_set_sha256: sha256(sourceText),
    state_schema_version: Number(config.state_schema_version || 3),
    formal_window_started: false,
  });
  await writeJsonAtomic(path.join(paths.stateRoot, "current_run.json"), {
    run_id: runId,
    run_dir: runDir,
    urls_file: sources,
    requested_at: requestedAt.toISOString(),
    formal_started: false,
    config_sha256: sha256(configText),
    source_sha256: sha256(sourceText),
    source_set_sha256: sha256(sourceText),
    state_schema_version: Number(config.state_schema_version || 3),
  });
  await writeJsonAtomic(path.join(paths.stateRoot, "operational_status.json"), {
    status: "PREFLIGHTING_CAPACITY",
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
    supervisor: lines.filter((line) => line.includes("ozon_24h_supervisor.mjs")).length,
    worker: globalFlowBWorkerPids(lines).length,
    profile: lines.filter((line) => (
      line.includes(profileMarker)
      && !line.includes(" --type=")
    )).length,
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
  const status = await readJson(path.join(paths.stateRoot, "operational_status.json"), {});
  const current = await readJson(path.join(paths.stateRoot, "current_run.json"), {});
  if (resumeMode(status, current) === "restart-current-run") return start(config);
  await fsp.writeFile(path.join(paths.stateRoot, "resume.request"), `${new Date().toISOString()}\n`, "utf8");
  await kickstart(config);
  return { ok: true, resume_requested: true };
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
  const checkpoint = current?.run_dir
    ? await readJson(path.join(current.run_dir, "compact_checkpoint.json"), {})
    : {};
  return compactProductionStatus({ current, operational, owners, checkpoint });
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
  const [command = "start", sourceRootArg, configPathArg] = argv;
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
  } else if (command === "incident") {
    result = await incident(config);
  } else if (command === "export") {
    result = await exportConfirmed(config);
  } else {
    throw new Error("usage: ozon_24h_production.sh [start|install-candidate|doctor-candidate|promote|doctor|status|incident|stop|retire-current|resume|export]");
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
