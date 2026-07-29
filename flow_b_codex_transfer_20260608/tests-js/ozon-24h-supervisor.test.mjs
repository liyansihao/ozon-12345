import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  browserOwnerPidsForRecovery,
  buildLaunchdPlist,
  capacityPreflightDecision,
  checkpointEnvironment,
  chromeArguments,
  classifyWorkerFailure,
  clearStaleVerificationResumeRequest,
  cleanupBrowserProfileCaches,
  cleanupProfileCachesForConfig,
  currentRunDisposition,
  nextRestartDelaySeconds,
  pendingPrewarmDue,
  readAppendedTail,
  resolveProductionLayout,
  resolveSourceScanStateFile,
  resolveSupervisorAppRoot,
  runFinalArtifacts,
  stopBrowserProfileOwners,
  stopOwnedWorker,
  supervisorShouldHonorSafeStop,
  waitForWorkerOrBrowserFailure,
  workerEnvironment,
} from "../scripts/ozon_24h_supervisor.mjs";

test("production layout is installed outside a disposable git worktree", () => {
  const layout = resolveProductionLayout({
    sourceRoot: "/Users/mac/.codex/worktrees/3d05/ozon",
    installRoot: "/Users/mac/.ozon-24h-production",
  });

  assert.equal(layout.installRoot, "/Users/mac/.ozon-24h-production");
  assert.equal(layout.appRoot, "/Users/mac/.ozon-24h-production/app");
  assert.equal(layout.stateRoot, "/Users/mac/.ozon-24h-production/state");
  assert.equal(layout.entryScript, "/Users/mac/.ozon-24h-production/app/scripts/ozon_24h_production.sh");
  assert.equal(layout.entryScript.includes(".codex/worktrees"), false);
});

test("supervisor launches children from its real release instead of the app symlink", () => {
  assert.equal(
    resolveSupervisorAppRoot("/Users/mac/.ozon-24h-production/releases/stable/scripts"),
    "/Users/mac/.ozon-24h-production/releases/stable",
  );
});

test("supervisor prewarm uses only a run-local scan checkpoint filename", () => {
  assert.equal(
    resolveSourceScanStateFile("/tmp/run", {
      flow_env: { FLOW_B_SOURCE_SCAN_STATE_FILE: "source_deep_scan_detail_verified.json" },
    }),
    "/tmp/run/source_deep_scan_detail_verified.json",
  );
  assert.throws(
    () => resolveSourceScanStateFile("/tmp/run", {
      flow_env: { FLOW_B_SOURCE_SCAN_STATE_FILE: "../../outside.json" },
    }),
    /safe JSON filename/,
  );
});

test("pending candidate prewarm is bounded and yields to the quota reset", () => {
  const now = Date.parse("2026-07-27T14:00:00.000Z");
  assert.equal(pendingPrewarmDue({
    now,
    resetAt: "2026-07-27T16:00:00.000Z",
    lastCompletedAt: null,
  }), true);
  assert.equal(pendingPrewarmDue({
    now,
    resetAt: "2026-07-27T16:00:00.000Z",
    lastCompletedAt: "2026-07-27T13:50:00.000Z",
    intervalSeconds: 900,
  }), false);
  assert.equal(pendingPrewarmDue({
    now,
    resetAt: "2026-07-27T16:00:00.000Z",
    lastCompletedAt: "2026-07-27T13:59:30.000Z",
    lastSourceCommit: "old",
    currentSourceCommit: "new",
  }), true);
  assert.equal(pendingPrewarmDue({
    now: Date.parse("2026-07-27T15:58:30.000Z"),
    resetAt: "2026-07-27T16:00:00.000Z",
    lastCompletedAt: null,
  }), false);
});

test("capacity preflight waits for reset and never opens an under-capacity window", () => {
  assert.deepEqual(capacityPreflightDecision({
    all_stores_found: true,
    all_warehouses_verified: true,
    all_quotas_verified: true,
    total_remaining_capacity: 469,
    next_reset_at: "2026-07-27T16:00:00.000Z",
  }), {
    action: "wait-for-quota-reset",
    reason: "insufficient-current-day-capacity",
    next_reset_at: "2026-07-27T16:00:00.000Z",
  });
  assert.equal(capacityPreflightDecision({
    all_stores_found: true,
    all_warehouses_verified: true,
    all_quotas_verified: true,
    total_remaining_capacity: 481,
  }).action, "start-formal-window");
  assert.equal(capacityPreflightDecision({
    all_stores_found: true,
    all_warehouses_verified: false,
    all_quotas_verified: true,
    total_remaining_capacity: 500,
  }).action, "fatal-stop");
});

test("ERP-capacity policy freezes the verified remaining capacity as today's target", () => {
  assert.deepEqual(capacityPreflightDecision({
    all_stores_found: true,
    all_warehouses_verified: true,
    all_quotas_verified: true,
    total_remaining_capacity: 469,
  }, 481, "erp_remaining_capacity"), {
    action: "start-formal-window",
    reason: null,
    effective_target: 469,
  });
  assert.equal(capacityPreflightDecision({
    all_stores_found: true,
    all_warehouses_verified: true,
    all_quotas_verified: true,
    total_remaining_capacity: 0,
    next_reset_at: "2026-07-28T16:00:00.000Z",
  }, 481, "erp_remaining_capacity").action, "wait-for-quota-reset");
});

test("worker inherits the one frozen ERP target instead of the static fallback", () => {
  const environment = workerEnvironment({
    browser: {
      cdp_endpoint: "http://127.0.0.1:9223",
      profile_dir: "/tmp/profile",
      extension_dir: "/tmp/extension",
      executable: "/tmp/chrome",
    },
    state_root: "/tmp/state",
    stores: [],
    acceptance: { target_policy: "erp_remaining_capacity" },
    flow_env: {
      FLOW_B_ACCEPTANCE_TARGET: "481",
      FLOW_B_TARGET_PUBLISH_COUNT: "481",
    },
  }, {
    run_id: "daily-run",
    acceptance_target: 469,
    acceptance_target_policy: "erp_remaining_capacity",
  });

  assert.equal(environment.FLOW_B_ACCEPTANCE_TARGET, "469");
  assert.equal(environment.FLOW_B_TARGET_PUBLISH_COUNT, "469");
  assert.equal(environment.FLOW_B_ACCEPTANCE_TARGET_POLICY, "erp_remaining_capacity");
});

test("checkpoint subprocess inherits the frozen release evidence and exact browser profile", () => {
  const environment = checkpointEnvironment({
    browser: {
      profile_dir: "/tmp/exact-profile",
    },
    state_root: "/tmp/production-state",
    frozen_commit: "abc123",
    frozen_config_hash: "config-sha256",
  }, {
    run_id: "daily-run",
  }, {
    PATH: "/usr/bin",
  });

  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.FLOW_B_PW_PROFILE, "/tmp/exact-profile");
  assert.equal(environment.FLOW_B_FROZEN_COMMIT, "abc123");
  assert.equal(environment.FLOW_B_FROZEN_CONFIG_HASH, "config-sha256");
  assert.equal(environment.FLOW_B_PRODUCTION_STATE_ROOT, "/tmp/production-state");
  assert.equal(environment.FLOW_B_PRODUCTION_RUN_ID, "daily-run");
});

test("supervised Chrome disables GPU acceleration after repeated SkSurface resource failures", () => {
  const args = chromeArguments({
    cdp_endpoint: "http://127.0.0.1:9223",
    profile_dir: "/tmp/profile",
    extension_dir: "/tmp/extension",
  });

  assert.equal(args.includes("--disable-gpu"), true);
  assert.equal(args.includes("--disable-software-rasterizer"), false);
});

test("launchd restarts abnormal exits without busy-looping a completed window", () => {
  const plist = buildLaunchdPlist({
    label: "com.codex.ozon.24h-production",
    entryScript: "/Users/mac/.ozon-24h-production/app/scripts/ozon_24h_production.sh",
    stateRoot: "/Users/mac/.ozon-24h-production/state",
  });

  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.match(
    plist,
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/u,
  );
  assert.match(plist, /<string>supervise<\/string>/u);
  assert.doesNotMatch(plist, /\.codex\/worktrees|gitdir|git rev-parse/u);
});

test("launchd supervisor exits successfully when no daily run is active", () => {
  assert.equal(currentRunDisposition(null), "idle");
  assert.equal(currentRunDisposition({}), "idle");
  assert.equal(currentRunDisposition({ run_id: "partial" }), "invalid");
  assert.equal(currentRunDisposition({
    run_id: "20260728_ozon_24h",
    run_dir: "/tmp/run",
    urls_file: "/tmp/sources.txt",
  }), "active");
});

test("launchd honors an intentional safe stop across computer restart", () => {
  assert.equal(supervisorShouldHonorSafeStop({ status: "STOPPED" }), true);
  assert.equal(supervisorShouldHonorSafeStop({ status: "WINDOW_COMPLETE" }), true);
  assert.equal(supervisorShouldHonorSafeStop({ status: "TARGET_NOT_MET" }), true);
  assert.equal(supervisorShouldHonorSafeStop({ status: "RUNNING" }), false);
  assert.equal(supervisorShouldHonorSafeStop({ status: "RECOVERING" }), false);
});

test("window cleanup closes exact browser profile owners without deleting persisted state", async () => {
  const stopped = [];
  const result = await stopBrowserProfileOwners("/Users/operator/.ozon-production/profile", {
    profileOwnersFn: async (profileDir) => {
      assert.equal(profileDir, "/Users/operator/.ozon-production/profile");
      return [{ pid: 101 }, { pid: 202 }];
    },
    stopOwnerFn: async (pid) => stopped.push(pid),
  });

  assert.deepEqual(result, [101, 202]);
  assert.deepEqual(stopped, [101, 202]);
});

test("window cleanup removes only rebuildable browser caches and preserves login state", async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-browser-profile-"));
  const cacheFiles = [
    "Default/Cache/data.bin",
    "Default/Code Cache/js/code.bin",
    "Default/GPUCache/gpu.bin",
    "GraphiteDawnCache/graphite.bin",
  ];
  const protectedFiles = [
    "Default/Cookies",
    "Default/Local Storage/leveldb/state",
    "Default/IndexedDB/session/state",
    "Default/Local Extension Settings/plugin/token",
    "Local State",
  ];
  for (const relative of [...cacheFiles, ...protectedFiles]) {
    const filename = path.join(profile, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, relative);
  }

  const cleaned = await cleanupBrowserProfileCaches(profile);

  assert.deepEqual(cleaned.sort(), [
    "Default/Cache",
    "Default/Code Cache",
    "Default/GPUCache",
    "GraphiteDawnCache",
  ]);
  for (const relative of cacheFiles) {
    await assert.rejects(fs.access(path.join(profile, relative)), { code: "ENOENT" });
  }
  for (const relative of protectedFiles) {
    assert.equal(await fs.readFile(path.join(profile, relative), "utf8"), relative);
  }
  await fs.rm(profile, { recursive: true, force: true });
});

test("standalone profile cleanup refuses a live owner and reuses the cache whitelist", async () => {
  await assert.rejects(
    cleanupProfileCachesForConfig({ browser: {} }),
    /browser profile_dir is required/,
  );

  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-browser-profile-cli-"));
  const cacheFile = path.join(profile, "Default", "Cache", "data.bin");
  const cookieFile = path.join(profile, "Default", "Cookies");
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, "cache");
  await fs.writeFile(cookieFile, "login");

  await assert.rejects(
    cleanupProfileCachesForConfig({ browser: { profile_dir: profile } }, {
      profileOwnersFn: async () => [{ pid: 4242 }],
    }),
    (error) => error?.code === "OZON_PROFILE_IN_USE",
  );
  assert.equal(await fs.readFile(cacheFile, "utf8"), "cache");

  const result = await cleanupProfileCachesForConfig({ browser: { profile_dir: profile } }, {
    profileOwnersFn: async (profileDir) => {
      assert.equal(profileDir, profile);
      return [];
    },
  });
  assert.deepEqual(result.cleaned_browser_caches, ["Default/Cache"]);
  assert.equal(await fs.readFile(cookieFile, "utf8"), "login");
  await assert.rejects(fs.access(cacheFile), { code: "ENOENT" });
  await fs.rm(profile, { recursive: true, force: true });
});

test("safe stop retains the worker identity while its exit handler clears the owner slot", async () => {
  const signals = [];
  let owner = {
    pid: 4242,
    kill(signal) {
      signals.push(signal);
      owner = null;
    },
  };
  const activeWorker = owner;
  const alive = [true, false, false];

  await stopOwnedWorker(activeWorker, {
    pidAliveFn: () => alive.shift() ?? false,
    delayFn: async () => {},
  });

  assert.equal(owner, null);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("browser and CDP failures recover the same run with bounded backoff", () => {
  for (const message of [
    "connect ECONNREFUSED 127.0.0.1:9223",
    "browserContext.newPage: Target page, context or browser has been closed",
    "page.goto: net::ERR_CONNECTION_RESET",
  ]) {
    assert.deepEqual(classifyWorkerFailure({ message, profileOwnerCount: 0 }), {
      action: "restart-browser-and-worker",
      reason: "browser-or-network-recoverable",
    });
  }

  assert.deepEqual(
    [0, 1, 2, 3, 20].map((attempt) => nextRestartDelaySeconds(attempt)),
    [30, 60, 120, 120, 120],
  );

  const pageCreateDecision = classifyWorkerFailure({
    message: "favorite worker page creation timed out after 10000ms",
    profileOwnerCount: 1,
  });
  assert.deepEqual(pageCreateDecision, {
    action: "restart-browser-and-worker",
    reason: "browser-or-network-recoverable",
  });
  assert.deepEqual(
    browserOwnerPidsForRecovery(pageCreateDecision, [{ pid: 92462 }]),
    [92462],
  );
  assert.deepEqual(
    browserOwnerPidsForRecovery({ action: "restart-worker" }, [{ pid: 92462 }]),
    [],
  );
});

test("worker recovery ignores browser errors left by an earlier worker generation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-worker-evidence-"));
  const errors = path.join(root, "runtime_errors.jsonl");
  const historical = "browserContext.newPage: Target page, context or browser has been closed\n";
  await fs.writeFile(errors, historical);
  const generationOffset = Buffer.byteLength(historical);
  await fs.appendFile(errors, "ordinary worker exit\n");

  const currentEvidence = await readAppendedTail(errors, generationOffset);
  assert.equal(currentEvidence, "ordinary worker exit\n");
  assert.deepEqual(classifyWorkerFailure({
    message: currentEvidence,
    profileOwnerCount: 1,
  }), {
    action: "restart-worker",
    reason: "ordinary-worker-recoverable",
  });

  const nextOffset = generationOffset + Buffer.byteLength("ordinary worker exit\n");
  await fs.appendFile(errors, "page.goto: Target page, context or browser has been closed\n");
  assert.deepEqual(classifyWorkerFailure({
    message: await readAppendedTail(errors, nextOffset),
    profileOwnerCount: 1,
  }), {
    action: "restart-browser-and-worker",
    reason: "browser-or-network-recoverable",
  });
  await fs.rm(root, { recursive: true, force: true });
});

test("supervisor detects an unresponsive CDP while the worker is still running", async () => {
  const worker = new EventEmitter();
  const probes = [false, false];
  const result = await waitForWorkerOrBrowserFailure(worker, {
    cdpEndpoint: "http://127.0.0.1:9223",
    probeIntervalMs: 1,
    probeTimeoutMs: 1,
    failureThreshold: 2,
    cdpReadyFn: async () => probes.shift() ?? true,
    delayFn: async () => {},
  });

  assert.equal(result.browser_unhealthy, true);
  assert.match(result.error.message, /CDP health check failed/i);
  assert.deepEqual(classifyWorkerFailure({
    message: result.error.message,
    profileOwnerCount: 1,
  }), {
    action: "restart-browser-and-worker",
    reason: "browser-or-network-recoverable",
  });
});

test("security checks wait in-place and duplicate profile owners hard-stop", () => {
  assert.deepEqual(classifyWorkerFailure({
    message: "Ozon CAPTCHA slider verification required",
    profileOwnerCount: 1,
  }), {
    action: "wait-for-verification",
    reason: "security-verification-required",
  });

  assert.deepEqual(classifyWorkerFailure({
    message: "ordinary worker exit",
    profileOwnerCount: 2,
  }), {
    action: "fatal-stop",
    reason: "duplicate-profile-owner-risk",
  });
});

test("verification wait discards a stale resume request before accepting a new one", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-verification-resume-"));
  const resumeFile = path.join(stateRoot, "resume.request");
  await fs.writeFile(resumeFile, "stale-request\n");

  assert.equal(await clearStaleVerificationResumeRequest(stateRoot), true);
  await assert.rejects(fs.access(resumeFile), { code: "ENOENT" });
  assert.equal(await clearStaleVerificationResumeRequest(stateRoot), false);

  await fs.rm(stateRoot, { recursive: true, force: true });
});

test("window finalization reconstructs a missing report before exporting five-store CSVs", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-final-state-"));
  const runDir = path.join(stateRoot, "runs", "formal");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "acceptance_window.json"), JSON.stringify({
    started_at: "2026-07-27T00:00:00.000Z",
    ended_at: "2026-07-28T00:00:00.000Z",
  }));
  await fs.writeFile(path.join(runDir, "source_config.json"), JSON.stringify({
    acceptance_target: 481,
    per_store_target: null,
    store_targets: [{ id: 104965, needle: "丽丽1号" }],
  }));
  await fs.writeFile(path.join(runDir, "published.jsonl"), `${JSON.stringify({
    status: "published",
    sku: "123456",
    data: {
      store_id: 104965,
      store_name: "丽丽1号",
      profit_rate: 31,
      online_status: "selling",
      stock: 1,
      published_at: "2026-07-27T01:00:00.000Z",
    },
  })}\n`);
  const result = await runFinalArtifacts(
    path.resolve(import.meta.dirname, ".."),
    stateRoot,
    { run_id: "formal" },
    runDir,
  );
  assert.equal(result.output, path.join(stateRoot, "exports", "formal"));
  assert.equal(result.report.success_count, 1);
  assert.equal(result.report.passed, false);
  await fs.access(path.join(result.output, "24h_report.json"));
  await fs.access(path.join(result.output, "confirmed_all_stores.csv"));
  await fs.access(path.join(result.output, "confirmed_store_104965.csv"));
  await fs.rm(stateRoot, { recursive: true, force: true });
});
