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
  resolveProductionLayout,
} from "./ozon_24h_supervisor.mjs";

const execFileAsync = promisify(execFile);
const LABEL = "com.codex.ozon.24h-production";
const ACTIVE_STATUSES = new Set([
  "STARTING",
  "PREFLIGHTING_CAPACITY",
  "PREWARMING_CANDIDATES",
  "WAITING_FOR_QUOTA_RESET",
  "RUNNING",
  "RECOVERING",
  "WAITING_FOR_VERIFICATION",
]);
const RESUMABLE_STATUSES = new Set([...ACTIVE_STATUSES, "STOPPED"]);

export function shouldResumeCurrentRun(status, current) {
  if (!current?.run_id || !current?.run_dir || !current?.urls_file) return false;
  return RESUMABLE_STATUSES.has(String(status?.status || ""));
}

export function resumeMode(status, current) {
  if (String(status?.status || "") === "STOPPED" && shouldResumeCurrentRun(status, current)) {
    return "restart-current-run";
  }
  if (String(status?.status || "") === "WAITING_FOR_VERIFICATION") return "verification";
  return "wake-supervisor";
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

function validateConfig(config) {
  if (config?.frozen !== true) throw new Error("production config must be frozen");
  if (Number(config?.acceptance?.duration_seconds) !== 86400) throw new Error("acceptance duration must be 86400 seconds");
  const targetPolicy = String(config?.acceptance?.target_policy || "fixed");
  if (targetPolicy === "erp_remaining_capacity") {
    if (config?.acceptance?.minimum_average_per_hour_exclusive !== null) {
      throw new Error("dynamic ERP-capacity runs must not use a fixed hourly completion threshold");
    }
  } else if (targetPolicy === "fixed") {
    if (Number(config?.acceptance?.strict_target) < 481) throw new Error("strict target must be at least 481");
    if (Number(config?.acceptance?.minimum_average_per_hour_exclusive) !== 20) {
      throw new Error("minimum strict rate threshold must be exclusively greater than 20/hour");
    }
  } else {
    throw new Error("acceptance target policy must equal fixed or erp_remaining_capacity");
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
    source_refreshed_at: new Date().toISOString(),
  };
  await writeJsonAtomic(path.join(absoluteStateRoot, "current_run.json"), refreshed);
  return refreshed;
}

async function installCandidate({ sourceRoot, config, configSource }) {
  const paths = deploymentPaths(config);
  await fsp.mkdir(paths.releases, { recursive: true });
  await fsp.mkdir(paths.stateRoot, { recursive: true });
  const rsync = await run("/usr/bin/rsync", [
    "-a",
    "--delete",
    "--exclude", "runs/",
    "--exclude", "runtime/",
    "--exclude", "data/flow_b/",
    `${path.resolve(sourceRoot)}/`,
    `${paths.candidate}/`,
  ]);
  if (!rsync.ok) throw new Error(`candidate install failed: ${rsync.stderr || rsync.error}`);
  const repositoryRoot = path.resolve(sourceRoot, "..");
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
  await copyInitialState(sourceRoot, paths.stateRoot);
  const sourceRefresh = await run(process.execPath, [
    path.join(paths.candidate, "scripts", "ozon_source_portfolio.mjs"),
    "refresh",
    paths.stateRoot,
    "-",
    path.join(paths.candidate, "config", "ozon_source_seed.txt"),
  ], { cwd: paths.candidate });
  if (!sourceRefresh.ok) {
    throw new Error(`candidate source portfolio refresh failed: ${sourceRefresh.stderr || sourceRefresh.error}`);
  }
  const configText = await fsp.readFile(configSource, "utf8");
  const revision = await run("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
  await writeJsonAtomic(path.join(paths.candidate, "deployment_manifest.json"), {
    installed_at: new Date().toISOString(),
    source_root: path.resolve(sourceRoot),
    source_commit: revision.ok ? revision.stdout.trim() : null,
    config_sha256: sha256(configText),
    role: "candidate",
    launch_runtime_requires_git: false,
  });
  return {
    ok: true,
    candidate: paths.candidate,
    state_root: paths.stateRoot,
    config_sha256: sha256(configText),
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
  const required = {
    app: resolvedApp,
    config: path.join(resolvedApp, "config", "ozon_24h_production.json"),
    supervisor: path.join(resolvedApp, "scripts", "ozon_24h_supervisor.mjs"),
    worker: path.join(resolvedApp, "scripts", "flow_b_playwright.mjs"),
    browser: expandHome(config.browser.executable),
    profile: expandHome(config.browser.profile_dir),
    extension: expandHome(config.browser.extension_dir),
    dedupe: path.join(paths.stateRoot, "dedupe", "published_links.csv"),
    sources: path.join(paths.stateRoot, "sources", "active_urls.txt"),
  };
  for (const [name, filename] of Object.entries(required)) checks[name] = await pathExists(filename);
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
  const status = await readJson(path.join(paths.stateRoot, "operational_status.json"), {});
  const current = await readJson(path.join(paths.stateRoot, "current_run.json"), {});
  if (shouldResumeCurrentRun(status, current)) {
    const mode = resumeMode(status, current);
    const resumedCurrent = mode === "restart-current-run"
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

async function resume(config) {
  const paths = deploymentPaths(config);
  const status = await readJson(path.join(paths.stateRoot, "operational_status.json"), {});
  const current = await readJson(path.join(paths.stateRoot, "current_run.json"), {});
  if (resumeMode(status, current) === "restart-current-run") return start(config);
  await fsp.writeFile(path.join(paths.stateRoot, "resume.request"), `${new Date().toISOString()}\n`, "utf8");
  await kickstart(config);
  return { ok: true, resume_requested: true };
}

async function status(config) {
  const paths = deploymentPaths(config);
  const current = await readJson(path.join(paths.stateRoot, "current_run.json"), {});
  const operational = await readJson(path.join(paths.stateRoot, "operational_status.json"), {});
  const owners = await readJson(path.join(paths.stateRoot, "process_owners.json"), {});
  const checkpoint = current?.run_dir
    ? await readJson(path.join(current.run_dir, "compact_checkpoint.json"), {})
    : {};
  return { current_run: current, operational, owners, checkpoint: checkpoint.compact || checkpoint };
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
  } else if (command === "resume") {
    result = await resume(config);
  } else if (command === "status") {
    result = await status(config);
  } else if (command === "export") {
    result = await exportConfirmed(config);
  } else {
    throw new Error("usage: ozon_24h_production.sh [start|install-candidate|doctor-candidate|promote|doctor|status|stop|resume|export]");
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
  installCandidate,
  validateConfig,
};
