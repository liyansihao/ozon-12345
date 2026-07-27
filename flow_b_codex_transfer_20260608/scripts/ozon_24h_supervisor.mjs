#!/usr/bin/env node

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_LABEL = "com.codex.ozon.24h-production";
const DEFAULT_INSTALL_ROOT = path.join(process.env.HOME || "/Users/mac", ".ozon-24h-production");
const SECURITY_RE = /captcha|滑块|slider|mfa|two[- ]factor|verification required|安全检查|验证码/i;
const BROWSER_RECOVERY_RE = /econnrefused|econnreset|etimedout|enotfound|eai_again|target (?:page, )?context or browser has been closed|browsercontext\.(?:newpage|close).*target page has been closed|browser has been closed|net::err_/i;

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

async function appendJsonLine(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.appendFile(filename, `${JSON.stringify(value)}\n`, "utf8");
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

async function stopExactOwner(pid, waitMs = 10_000) {
  if (!pidAlive(pid)) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + waitMs;
  while (pidAlive(pid) && Date.now() < deadline) await delay(100);
  if (pidAlive(pid)) process.kill(pid, "SIGKILL");
}

function chromeArguments(browser) {
  const args = [
    `--remote-debugging-port=${endpointPort(browser.cdp_endpoint)}`,
    `--user-data-dir=${absolute(browser.profile_dir)}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
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

function workerEnvironment(config, currentRun) {
  const environment = { ...process.env };
  for (const [key, value] of Object.entries(config.flow_env || {})) {
    if (value === null || value === undefined) continue;
    environment[key] = typeof value === "string" ? expandTemplate(value, config) : JSON.stringify(value);
  }
  environment.FLOW_B_CDP_ENDPOINT = config.browser.cdp_endpoint;
  environment.FLOW_B_PW_PROFILE = absolute(config.browser.profile_dir);
  environment.FLOW_B_EXTENSION_DIR = absolute(config.browser.extension_dir);
  environment.FLOW_B_CHROMIUM_EXECUTABLE = absolute(config.browser.executable);
  environment.FLOW_B_RESUME_WINDOW = "1";
  environment.FLOW_B_PRODUCTION_STATE_ROOT = absolute(config.state_root);
  environment.FLOW_B_PRODUCTION_RUN_ID = String(currentRun.run_id);
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

async function updateOperationalState(stateRoot, currentRun, patch) {
  await writeJsonAtomic(path.join(stateRoot, "operational_status.json"), {
    run_id: currentRun.run_id,
    run_dir: currentRun.run_dir,
    observed_at: new Date().toISOString(),
    ...patch,
  });
}

async function acceptanceEnded(runDir) {
  const window = await readJson(path.join(runDir, "acceptance_window.json"), {});
  const endedAt = Date.parse(window?.ended_at || "");
  return Number.isFinite(endedAt) && Date.now() >= endedAt;
}

async function runCheckpoint(appRoot, runDir, label) {
  const script = path.join(appRoot, "scripts", "flow_b_checkpoint.mjs");
  return runCommand(process.execPath, [script, runDir, label], {
    cwd: appRoot,
    env: process.env,
    stdio: "ignore",
  });
}

async function waitForVerification({ stateRoot, currentRun, appRoot, runDir, stopFile }) {
  const resumeFile = path.join(stateRoot, "resume.request");
  await updateOperationalState(stateRoot, currentRun, {
    status: "WAITING_FOR_VERIFICATION",
    reason: "CAPTCHA, slider, MFA, or account security verification is required",
    resume_file: resumeFile,
  });
  while (!fs.existsSync(resumeFile) && !fs.existsSync(stopFile) && !await acceptanceEnded(runDir)) {
    await delay(30_000);
  }
  if (fs.existsSync(resumeFile)) await fsp.unlink(resumeFile).catch(() => {});
  await runCheckpoint(appRoot, runDir, "verification-wait");
}

async function writeProcessOwners({ stateRoot, currentRun, browserPid, workerPid = null }) {
  await writeJsonAtomic(path.join(stateRoot, "process_owners.json"), {
    observed_at: new Date().toISOString(),
    run_id: currentRun.run_id,
    supervisor_pid: process.pid,
    worker_pid: workerPid,
    profile_owner_pid: browserPid,
    counts: {
      supervisor: 1,
      worker: workerPid ? 1 : 0,
      profile_owner: browserPid ? 1 : 0,
    },
  });
}

export async function supervise(configPath) {
  const config = expandedConfig(await readJson(configPath));
  const appRoot = absolute(config.install_root, path.resolve(import.meta.dirname, ".."));
  const stateRoot = absolute(config.state_root, path.join(DEFAULT_INSTALL_ROOT, "state"));
  const currentRunPath = path.join(stateRoot, "current_run.json");
  const currentRun = await readJson(currentRunPath);
  const runDir = absolute(currentRun.run_dir);
  const urlsFile = absolute(currentRun.urls_file);
  const stopFile = path.join(stateRoot, "stop.request");
  const releaseLock = await acquireSupervisorLock(stateRoot);
  let worker = null;
  let checkpointTimer = null;
  let shuttingDown = false;
  const stopWorker = async () => {
    if (worker && pidAlive(worker.pid)) {
      worker.kill("SIGTERM");
      const deadline = Date.now() + 15_000;
      while (pidAlive(worker.pid) && Date.now() < deadline) await delay(100);
      if (pidAlive(worker.pid)) worker.kill("SIGKILL");
    }
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
    await runCheckpoint(appRoot, runDir, "supervisor-start");
    checkpointTimer = setInterval(() => {
      void runCheckpoint(appRoot, runDir, "2h");
    }, Math.max(60_000, Number(config.checkpoint_interval_seconds || 7200) * 1000));
    checkpointTimer.unref();
    let restartAttempt = 0;
    while (!shuttingDown) {
      if (fs.existsSync(stopFile)) {
        await updateOperationalState(stateRoot, currentRun, { status: "STOPPED", reason: "safe stop requested" });
        await fsp.unlink(stopFile).catch(() => {});
        break;
      }
      if (await acceptanceEnded(runDir)) {
        await updateOperationalState(stateRoot, currentRun, { status: "WINDOW_COMPLETE", reason: null });
        await runCheckpoint(appRoot, runDir, "window-complete");
        break;
      }

      let browserOwner;
      try {
        browserOwner = await ensureBrowserOwner({ config, stateRoot, runDir });
      } catch (error) {
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

      const stdoutFd = fs.openSync(path.join(runDir, "console.log"), "a");
      const stderrFd = fs.openSync(path.join(runDir, "stderr.log"), "a");
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
      await writeProcessOwners({
        stateRoot,
        currentRun,
        browserPid: browserOwner.pid,
        workerPid: worker.pid,
      });
      await updateOperationalState(stateRoot, currentRun, { status: "RUNNING", reason: null });
      const result = await new Promise((resolve) => {
        worker.once("error", (error) => resolve({ code: 127, signal: null, error }));
        worker.once("exit", (code, signal) => resolve({ code: Number(code ?? 1), signal, error: null }));
      });
      worker = null;
      await writeProcessOwners({ stateRoot, currentRun, browserPid: browserOwner.pid });
      if (shuttingDown) break;
      if (await acceptanceEnded(runDir)) continue;
      const owners = await profileOwners(absolute(config.browser.profile_dir)).catch(() => []);
      const evidence = [
        result.error?.message || "",
        await readTail(path.join(runDir, "runtime_errors.jsonl")),
        await readTail(path.join(runDir, "stderr.log")),
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
        await waitForVerification({ stateRoot, currentRun, appRoot, runDir, stopFile });
        restartAttempt = 0;
        continue;
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
    await runCheckpoint(appRoot, runDir, "supervisor-stop");
    return 0;
  } finally {
    if (checkpointTimer) clearInterval(checkpointTimer);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("SIGHUP", onSignal);
    await releaseLock();
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
  throw new Error("usage: ozon_24h_supervisor.mjs plist | supervise CONFIG_PATH | probe-browser CONFIG_PATH");
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
