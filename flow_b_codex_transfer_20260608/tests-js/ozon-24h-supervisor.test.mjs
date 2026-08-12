import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDirectWorkerHealthTracker,
  directWorkerErrorSignature,
} from "../scripts/flow_b_playwright/direct-worker-health.mjs";

import {
  advanceStorageCleanupAttemptAt,
  browserOwnerPidsForRecovery,
  browserCdpStartupSettings,
  browserRecoverySafeStopDecision,
  buildLaunchdPlist,
  capacityPreflightDecision,
  checkpointEnvironment,
  chromeArguments,
  classifyWorkerFailure,
  candidateBufferDecision,
  candidateBufferInflow,
  candidateBufferSnapshot,
  clearStaleVerificationResumeRequest,
  cleanupBrowserProfileCaches,
  cleanupProfileCachesForConfig,
  currentRunDisposition,
  directWorkerHealthDecision,
  directWatchdogRecoveryDecision,
  expandedConfig,
  nextRestartDelaySeconds,
  processOwnershipDecision,
  processOwnershipSnapshot,
  productionRunContractDecision,
  refreshStorageMaintenance,
  readAppendedTail,
  readWorkerGenerationEvidence,
  resolveProductionLayout,
  resolveSourceScanStateFile,
  resolveSupervisorAppRoot,
  runOzonVerificationProbe,
  storageCleanupDue,
  runDirectSourceRefresh,
  runFormalSourceRefresh,
  runInitialSourceRefresh,
  runFinalArtifacts,
  rollingRateDecision,
  stopBrowserProfileOwners,
  stopOwnedWorker,
  submissionGateConvergenceDecision,
  supervisorShouldHonorSafeStop,
  verificationAutoRecoverySettings,
  verificationLockToken,
  verificationProbeSchedule,
  waitForVerification,
  waitForBrowserCdp,
  waitForWorkerOrBrowserFailure,
  workerEnvironment,
} from "../scripts/ozon_24h_supervisor.mjs";

test("storage maintenance records threshold transitions and only cleans when explicitly due", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-storage-supervisor-"));
  const runDir = path.join(stateRoot, "runs", "run-1");
  await fs.mkdir(runDir, { recursive: true });
  let cleanupCalls = 0;
  const snapshot = async () => ({
    observed_at: "2026-08-13T00:00:00.000Z",
    severity: "warning",
    alert: true,
    reasons: ["free-bytes-below-warning"],
    available_bytes: 7 * 1024 ** 3,
    used_percent: 97,
  });
  const cleanup = async ({ execute, minimumAgeMs }) => {
    cleanupCalls += 1;
    assert.equal(execute, true);
    assert.equal(minimumAgeMs, 24 * 60 * 60 * 1000);
    return { removed: [{ path: "old.tmp", size_bytes: 4096 }], removed_bytes: 4096 };
  };
  try {
    const first = await refreshStorageMaintenance({
      stateRoot,
      runDir,
      config: { storage_maintenance: { temporary_minimum_age_hours: 24 } },
      allowCleanup: false,
      cleanup,
      snapshot,
    });
    assert.equal(first.severity, "warning");
    assert.equal(cleanupCalls, 0);
    const second = await refreshStorageMaintenance({
      stateRoot,
      runDir,
      config: { storage_maintenance: { temporary_minimum_age_hours: 24 } },
      allowCleanup: true,
      cleanup,
      snapshot,
    });
    assert.equal(cleanupCalls, 1);
    assert.equal(second.automatic_cleanup.removed_bytes, 4096);
    const status = JSON.parse(await fs.readFile(path.join(stateRoot, "storage_status.json"), "utf8"));
    assert.equal(status.severity, "warning");
    assert.equal(status.automatic_cleanup.removed_count, 1);
    const alerts = (await fs.readFile(path.join(stateRoot, "storage_alerts.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.equal(alerts.length, 2);
    assert.equal(alerts[0].previous_severity, null);
    assert.equal(alerts[1].cleanup_removed_bytes, 4096);
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test("critical storage transition cleans immediately and every cleanup failure is alerted", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-storage-critical-"));
  const runDir = path.join(stateRoot, "runs", "run-1");
  await fs.mkdir(runDir, { recursive: true });
  let cleanupCalls = 0;
  try {
    await fs.writeFile(path.join(stateRoot, "storage_status.json"), JSON.stringify({ severity: "healthy" }));
    const options = {
      stateRoot,
      runDir,
      config: { storage_maintenance: {} },
      allowCleanup: false,
      snapshot: async () => ({
        observed_at: "2026-08-13T00:00:00.000Z",
        severity: "critical",
        alert: true,
        reasons: ["free-bytes-below-critical"],
      }),
      cleanup: async () => {
        cleanupCalls += 1;
        throw new Error(`cleanup-failure-${cleanupCalls}`);
      },
    };
    const first = await refreshStorageMaintenance(options);
    assert.equal(cleanupCalls, 1);
    assert.equal(first.automatic_cleanup.error, "cleanup-failure-1");
    const second = await refreshStorageMaintenance({ ...options, allowCleanup: true });
    assert.equal(cleanupCalls, 2);
    assert.equal(second.automatic_cleanup.error, "cleanup-failure-2");
    const alerts = (await fs.readFile(path.join(stateRoot, "storage_alerts.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.equal(alerts.length, 2);
    assert.deepEqual(alerts.map((row) => row.action), [
      "storage-temporary-cleanup-failed",
      "storage-temporary-cleanup-failed",
    ]);
    assert.deepEqual(alerts.map((row) => row.cleanup_error), [
      "cleanup-failure-1",
      "cleanup-failure-2",
    ]);
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test("storage cleanup cadence advances only from a newer persisted attempt", () => {
  const previous = Date.parse("2026-08-13T00:00:00.000Z");
  assert.equal(advanceStorageCleanupAttemptAt(previous, { severity: "warning" }), previous);
  assert.equal(advanceStorageCleanupAttemptAt(previous, {
    automatic_cleanup: { attempted_at: "2026-08-12T23:00:00.000Z" },
  }), previous);
  assert.equal(advanceStorageCleanupAttemptAt(previous, {
    automatic_cleanup: { attempted_at: "2026-08-13T01:00:00.000Z" },
  }), Date.parse("2026-08-13T01:00:00.000Z"));
});

test("critical storage retries every five minutes without cleanup storms", () => {
  const lastAttemptAt = Date.parse("2026-08-13T00:00:00.000Z");
  const critical = { severity: "critical", automatic_cleanup: { error: "disk-busy" } };
  assert.equal(storageCleanupDue({
    status: critical,
    lastAttemptAt,
    nowMs: Date.parse("2026-08-13T00:04:59.999Z"),
  }), false);
  assert.equal(storageCleanupDue({
    status: critical,
    lastAttemptAt,
    nowMs: Date.parse("2026-08-13T00:05:00.000Z"),
  }), true);
  assert.equal(storageCleanupDue({
    status: { severity: "warning" },
    lastAttemptAt,
    nowMs: Date.parse("2026-08-13T05:59:59.999Z"),
  }), false);
  assert.equal(storageCleanupDue({
    status: { severity: "warning" },
    lastAttemptAt,
    nowMs: Date.parse("2026-08-13T06:00:00.000Z"),
  }), true);
});

const RELIABLE_COST = Object.freeze({
  cost_verified: true,
  cost_source: "search_first_page_p70_similarity_filtered",
  cost: Object.freeze({
    ok: true,
    cost: 2,
    source: "search_first_page_p70_similarity_filtered",
    prices: Object.freeze([1.8, 2, 2.2]),
    match_evidence_key: "d".repeat(64),
    same_item_match: true,
    returned_evidence_verified: true,
    match_evidence_contract: "1688-returned-same-item-v2",
    matched_offer_count: 3,
  }),
  cost_evidence: Object.freeze({
    contract: "1688-same-item-v1",
    source: "search_first_page_p70_similarity_filtered",
    reliable_source: true,
    same_item_match: true,
    match_evidence_key: "d".repeat(64),
    filtered_price_count: 3,
    returned_evidence_verified: true,
    match_evidence_contract: "1688-returned-same-item-v2",
    matched_offer_count: 3,
  }),
});

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

test("a failed JSON or SQLite submission gate always converges to a safe stop", () => {
  const baseSqlite = {
    run_id: "run-1",
    run_dir: "/tmp/run-1",
    phase: "active",
    distinct_sku_budget: 3,
  };
  assert.equal(submissionGateConvergenceDecision({
    jsonGate: { phase: "failed" },
    sqliteGate: baseSqlite,
    runId: "run-1",
    runDir: "/tmp/run-1",
  }).action, "safe-stop");
  assert.equal(submissionGateConvergenceDecision({
    jsonGate: { phase: "three-sku" },
    sqliteGate: { ...baseSqlite, phase: "failed" },
    runId: "run-1",
    runDir: "/tmp/run-1",
  }).action, "safe-stop");
  assert.equal(submissionGateConvergenceDecision({
    jsonGate: { phase: "released" },
    sqliteGate: baseSqlite,
    runId: "run-1",
    runDir: "/tmp/run-1",
  }).reason, "submission-gate-state-mismatch");
  assert.deepEqual(submissionGateConvergenceDecision({
    jsonGate: { phase: "released", target_skus: [] },
    sqliteGate: {
      ...baseSqlite,
      phase: "released",
      target_skus: [],
    },
    runId: "run-1",
    runDir: "/tmp/run-1",
  }), {
    action: "continue",
    reason: null,
  });
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

test("capacity preflight fatally rejects any capacity below the fixed 500 target", () => {
  assert.deepEqual(capacityPreflightDecision({
    all_stores_found: true,
    all_warehouses_verified: true,
    all_quotas_verified: true,
    total_remaining_capacity: 469,
    next_reset_at: "2026-07-27T16:00:00.000Z",
  }), {
    action: "fatal-stop",
    reason: "insufficient-current-day-capacity",
    total_remaining_capacity: 469,
    required_capacity: 500,
  });
  assert.equal(capacityPreflightDecision({
    all_stores_found: true,
    all_warehouses_verified: true,
    all_quotas_verified: true,
    total_remaining_capacity: 500,
  }).action, "start-formal-window");
  assert.equal(capacityPreflightDecision({
    all_stores_found: true,
    all_warehouses_verified: false,
    all_quotas_verified: true,
    total_remaining_capacity: 500,
  }).action, "fatal-stop");
});

test("capacity preflight permits an explicit operator-authorized current-day shortfall without reducing the fixed target", () => {
  assert.deepEqual(capacityPreflightDecision({
    all_stores_found: true,
    all_warehouses_verified: true,
    all_quotas_verified: true,
    total_remaining_capacity: 469,
  }, 500, "fixed", {
    allowCurrentDayShortfall: true,
  }), {
    action: "start-formal-window",
    reason: "operator-authorized-current-day-capacity-shortfall",
    total_remaining_capacity: 469,
    required_capacity: 500,
  });
});

test("capacity preflight rejects dynamic target policies", () => {
  assert.deepEqual(
    capacityPreflightDecision({
      all_stores_found: true,
      all_warehouses_verified: true,
      all_quotas_verified: true,
      total_remaining_capacity: 500,
    }, 500, "erp_remaining_capacity"),
    { action: "fatal-stop", reason: "acceptance-target-policy-must-be-fixed" },
  );
});

test("worker environment cannot inherit a reduced target", () => {
  const environment = workerEnvironment({
    browser: {
      cdp_endpoint: "http://127.0.0.1:9223",
      profile_dir: "/tmp/profile",
      extension_dir: "/tmp/extension",
      executable: "/tmp/chrome",
    },
    state_root: "/tmp/state",
    stores: [],
    acceptance: { target_policy: "fixed", strict_target: 500 },
    flow_env: {
      FLOW_B_ACCEPTANCE_TARGET: "500",
      FLOW_B_TARGET_PUBLISH_COUNT: "500",
    },
  }, {
    run_id: "daily-run",
    acceptance_target: 469,
    acceptance_target_policy: "erp_remaining_capacity",
  });

  assert.equal(environment.FLOW_B_ACCEPTANCE_TARGET, "500");
  assert.equal(environment.FLOW_B_TARGET_PUBLISH_COUNT, "500");
  assert.equal(environment.FLOW_B_ACCEPTANCE_TARGET_POLICY, "fixed");
  assert.equal(environment.FLOW_B_STORE_ACCEPTANCE_TARGET, "100");
  assert.equal(environment.FLOW_B_REQUIRE_PER_STORE_ACCEPTANCE, "1");
  assert.equal(environment.FLOW_B_MINIMUM_AVERAGE_PER_HOUR_EXCLUSIVE, "35");
});

test("direct worker starts from the persisted store and has no strict submission gate", () => {
  const environment = workerEnvironment({
    runtime_mode: "direct",
    publish_target: 0,
    minimum_profit_rate_exclusive: 30,
    starting_store_id: 104965,
    state_root: "/state",
    browser: {
      cdp_endpoint: "http://127.0.0.1:9223",
      extension_dir: "/extension",
      executable: "/chrome",
      profile_dir: "/profile",
    },
    flow_env: {
      FLOW_B_STORE_TARGETS: [
        { id: 106637, needle: "丽丽二号" },
        { id: 104965, needle: "丽丽1号" },
      ],
    },
  }, {
    run_id: "direct-run",
    run_dir: "/state/runs/direct-run",
    current_store_id: 104965,
  });
  const stores = JSON.parse(environment.FLOW_B_STORE_TARGETS);
  assert.equal(stores[0].id, 104965);
  assert.equal(environment.FLOW_B_DIRECT_PUBLISH, "1");
  assert.equal(environment.FLOW_B_1688_MIN_MATCHES, "1");
  assert.equal(environment.FLOW_B_TARGET_PUBLISH_COUNT, "0");
  assert.equal(environment.FLOW_B_UNLIMITED_PUBLISH, "1");
  assert.equal(environment.FLOW_B_SUBMISSION_GATE_FILE, undefined);
  assert.equal(environment.FLOW_B_VALIDATION_ONLY, "0");
});

test("profit learning paths expand once and are injected without changing the direct publish contract", () => {
  const config = expandedConfig({
    runtime_mode: "direct",
    publish_target: 0,
    minimum_profit_rate_exclusive: 30,
    starting_store_id: 104965,
    install_root: "/tmp/ozon-app",
    state_root: "/tmp/ozon-state",
    browser: {
      cdp_endpoint: "http://127.0.0.1:9223",
      extension_dir: "/tmp/extension",
      executable: "/tmp/chrome",
      profile_dir: "/tmp/profile",
    },
    profit_learning: {
      enabled: true,
      priority_file: "${APP_ROOT}/priority.json",
      season_file: "${APP_ROOT}/season.json",
      feedback_file: "${APP_ROOT}/feedback.json",
      feedback_dir: "${APP_ROOT}/核价反馈",
      learning_status: "${STATE_ROOT}/profit_learning/status.json",
      feedback_status: "${STATE_ROOT}/profit_learning/feedback_status.json",
      runtime_root: "${STATE_ROOT}/profit_learning",
      node: "/tmp/node",
      node_modules: "/tmp/node_modules",
      file_refresh_ms: 5_000,
      poll_interval_seconds: 60,
      lookback_days: 30,
      minimum_completed_orders: 3,
      order_page_size: 100,
      order_max_pages: 100,
    },
    flow_env: {
      FLOW_B_STORE_TARGETS: [{ id: 104965, needle: "丽丽1号" }],
    },
  });
  const environment = workerEnvironment(config, {
    run_id: "direct-run",
    run_dir: "/tmp/ozon-state/runs/direct-run",
    current_store_id: 104965,
  });

  assert.equal(config.profit_learning.learning_status, "/tmp/ozon-state/profit_learning/status.json");
  assert.equal(environment.FLOW_B_PROFIT_PRIORITY_FILE, "/tmp/ozon-app/priority.json");
  assert.equal(environment.FLOW_B_SEASON_PRIORITY_FILE, "/tmp/ozon-app/season.json");
  assert.equal(environment.FLOW_B_PROFIT_FEEDBACK_FILE, "/tmp/ozon-app/feedback.json");
  assert.equal(environment.FLOW_B_PROFIT_FEEDBACK_DIR, "/tmp/ozon-app/核价反馈");
  assert.equal(environment.FLOW_B_PROFIT_LEARNING_STATUS, "/tmp/ozon-state/profit_learning/status.json");
  assert.equal(environment.FLOW_B_PROFIT_FEEDBACK_STATE, "/tmp/ozon-state/profit_learning/feedback_status.json");
  assert.equal(environment.FLOW_B_PROFIT_RUNTIME_ROOT, "/tmp/ozon-state/profit_learning");
  assert.equal(environment.FLOW_B_PROFIT_NODE, "/tmp/node");
  assert.equal(environment.FLOW_B_PROFIT_NODE_MODULES, "/tmp/node_modules");
  assert.equal(environment.FLOW_B_PROFIT_FILE_REFRESH_MS, "5000");
  assert.equal(environment.FLOW_B_PROFIT_LOOKBACK_DAYS, "30");
  assert.equal(environment.FLOW_B_PROFIT_MOTHER_MIN_ORDERS, "3");
  assert.equal(environment.FLOW_B_PROFIT_LEARNING_ENABLED, "1");
  assert.equal(environment.FLOW_B_PROFIT_POLL_INTERVAL_MS, "60000");
  assert.equal(environment.FLOW_B_PROFIT_ORDER_PAGE_SIZE, "100");
  assert.equal(environment.FLOW_B_PROFIT_ORDER_MAX_PAGES, "100");
  assert.equal(environment.FLOW_B_PROFIT_REPORT_STATUS, "/tmp/ozon-state/daily_pricing_report_status.json");
  assert.equal(environment.FLOW_B_PROFIT_ARTIFACT_RUNTIME_ROOT, "/tmp/ozon-state/profit_learning/artifact-runtime");
  assert.equal(environment.FLOW_B_DIRECT_PUBLISH, "1");
  assert.equal(environment.FLOW_B_TARGET_PUBLISH_COUNT, "0");
});

test("two failed browser recoveries within sixty minutes force a safe stop", () => {
  const failed = (at) => ({ at, action: "browser-recovery-attempt", outcome: "failed" });
  assert.deepEqual(browserRecoverySafeStopDecision([
    failed("2026-07-29T10:00:00.000Z"),
    failed("2026-07-29T10:59:59.000Z"),
  ], { now: "2026-07-29T11:00:00.000Z" }), {
    action: "safe-stop",
    reason: "repeated-browser-recovery-failure",
    consecutive_failures: 2,
  });
  assert.equal(browserRecoverySafeStopDecision([
    failed("2026-07-29T09:59:59.000Z"),
    failed("2026-07-29T10:59:59.000Z"),
  ], { now: "2026-07-29T11:00:00.000Z" }).action, "continue");
  assert.equal(browserRecoverySafeStopDecision([
    failed("2026-07-29T10:00:00.000Z"),
    { at: "2026-07-29T10:30:00.000Z", action: "browser-recovery-attempt", outcome: "succeeded" },
    failed("2026-07-29T10:59:59.000Z"),
  ], { now: "2026-07-29T11:00:00.000Z" }).action, "continue");
});

test("process ownership enforces one supervisor, one generation, and one profile owner", () => {
  assert.equal(processOwnershipDecision({
    phase: "before-worker",
    supervisor: 1,
    worker: 0,
    profile_owner: 0,
  }).action, "continue");
  assert.equal(processOwnershipDecision({
    phase: "worker-running",
    supervisor: 1,
    worker: 1,
    profile_owner: 1,
  }).action, "continue");
  assert.deepEqual(processOwnershipDecision({
    phase: "worker-running",
    supervisor: 1,
    worker: 2,
    profile_owner: 1,
  }), {
    action: "fatal-stop",
    reason: "duplicate-worker-generation-risk",
  });
  assert.equal(processOwnershipDecision({
    phase: "after-exit",
    supervisor: 1,
    worker: 0,
    profile_owner: 0,
  }).action, "continue");
});

test("rolling 120-minute speed and two-hour candidate buffer are hard gates", () => {
  assert.equal(rollingRateDecision({ elapsedMinutes: 119, rolling120PerHour: 0 }).action, "observe");
  assert.equal(rollingRateDecision({ elapsedMinutes: 120, rolling120PerHour: 34.99 }).action, "safe-stop");
  assert.equal(rollingRateDecision({ elapsedMinutes: 120, rolling120PerHour: 35 }).action, "continue");
  assert.equal(rollingRateDecision({
    elapsedMinutes: 900,
    rolling120PerHour: 0,
    targetReached: true,
  }).action, "continue");
  assert.deepEqual(candidateBufferDecision({ uniqueReady: 69 }), {
    action: "prepare",
    unique_ready: 69,
    required_ready: 70,
  });
  assert.equal(candidateBufferDecision({ uniqueReady: 70 }).action, "ready");
  assert.deepEqual(candidateBufferDecision({
    uniqueReady: 0,
    targetHours: 0,
    minimumPerHour: 0,
    minimumReadyCandidates: 0,
  }), {
    action: "ready",
    unique_ready: 0,
    required_ready: 0,
  });
});

test("candidate buffer counts only latest unique fully qualified validations", () => {
  assert.deepEqual(candidateBufferSnapshot([
    {
      sku: "1",
      status: "validated",
      validation_mode: "buffer",
      shipping_mode: "FBS",
      profit_rate: 31,
      purchase_price: 2,
      ...RELIABLE_COST,
      fbs_evidence: { verified: true },
      quality_gate_passed: true,
    },
    { sku: "1", status: "rejected", reason: "duplicate-title" },
    {
      sku: "2",
      status: "validated",
      validation_mode: "buffer",
      shipping_mode: "FBS",
      profit_rate: 31,
      purchase_price: 2,
      ...RELIABLE_COST,
      fbs_evidence: { verified: true },
      quality_gate_passed: true,
    },
    {
      sku: "3",
      status: "validated",
      validation_mode: "buffer",
      shipping_mode: "FBO",
      profit_rate: 99,
      purchase_price: 2,
      ...RELIABLE_COST,
      fbs_evidence: { verified: true },
      quality_gate_passed: true,
    },
    {
      sku: "2815247918",
      status: "validated",
      validation_mode: "buffer",
      shipping_mode: "FBS",
      profit_rate: 99,
      purchase_price: 2,
      ...RELIABLE_COST,
      fbs_evidence: { verified: true },
      quality_gate_passed: true,
    },
  ]), {
    unique_ready: 1,
    ready_skus: ["2"],
    rejected_or_invalid: 3,
  });
});

test("candidate buffer inflow counts only newly qualified unconsumed unique SKUs", () => {
  const base = {
    status: "validated",
    validation_mode: "buffer",
    shipping_mode: "FBS",
    profit_rate: 31,
    purchase_price: 2,
    ...RELIABLE_COST,
    fbs_evidence: { verified: true },
    quality_gate_passed: true,
  };
  const result = candidateBufferInflow([
    { ...base, sku: "existing", validated_at: "2026-07-30T00:00:00.000Z" },
    { ...base, sku: "existing", validated_at: "2026-07-30T00:02:00.000Z" },
    {
      ...base,
      sku: "weak",
      cost_evidence: null,
      validated_at: "2026-07-30T00:02:00.000Z",
    },
    { ...base, sku: "new", validated_at: "2026-07-30T00:02:00.000Z" },
    { ...base, sku: "consumed", validated_at: "2026-07-30T00:02:30.000Z" },
    {
      ...base,
      sku: "live-pre-submit",
      validation_mode: "live-pre-submit",
      validated_at: "2026-07-30T00:02:30.000Z",
    },
  ], {
    consumedSkus: ["consumed"],
    previousAt: "2026-07-30T00:01:00.000Z",
    observedAt: "2026-07-30T00:03:00.000Z",
  });
  assert.deepEqual(result.added_skus, ["new"]);
  assert.equal(result.added_unique, 1);
});

test("candidate buffer evidence accepts durable consumed SKU sets", () => {
  const row = {
    sku: "consumed",
    status: "validated",
    validation_mode: "buffer",
    shipping_mode: "FBS",
    profit_rate: 31,
    purchase_price: 2,
    ...RELIABLE_COST,
    fbs_evidence: { verified: true },
    quality_gate_passed: true,
  };
  assert.deepEqual(candidateBufferSnapshot([row], {
    consumedSkus: new Set(["consumed"]),
  }), {
    unique_ready: 0,
    ready_skus: [],
    rejected_or_invalid: 1,
  });
});

test("process ownership snapshot rejects a worker from any old run", () => {
  const rows = [
    { pid: 10, command: "/usr/bin/node /app/scripts/ozon_24h_supervisor.mjs supervise /app/config.json" },
    { pid: 20, command: "/usr/bin/node /app/scripts/flow_b_playwright.mjs accept /state/runs/run-1 /state/urls.txt" },
    { pid: 21, command: "/usr/bin/node /app/scripts/flow_b_playwright.mjs accept /state/runs/other /state/urls.txt" },
    { pid: 30, command: "/Applications/Chrome --user-data-dir=/state/profile about:blank" },
    { pid: 31, command: "/Applications/Chrome --type=renderer --user-data-dir=/state/profile" },
  ];
  assert.deepEqual(processOwnershipSnapshot(rows, {
    supervisorPid: 10,
    runDir: "/state/runs/run-1",
    profileDir: "/state/profile",
  }), {
    supervisor: 1,
    worker: 2,
    profile_owner: 1,
    supervisor_pids: [10],
    worker_pids: [20, 21],
    profile_owner_pids: [30],
  });
  assert.equal(processOwnershipDecision({
    phase: "before-worker",
    ...processOwnershipSnapshot(rows, {
      supervisorPid: 10,
      runDir: "/state/runs/run-1",
      profileDir: "/state/profile",
    }),
  }).reason, "duplicate-worker-generation-risk");
});

test("formal resume never refreshes before two hours and rejects an unauthorized source hash", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-formal-source-resume-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const runDir = path.join(root, "run");
  const urlsFile = path.join(root, "active_urls.txt");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });
  const sourceText = "https://www.ozon.ru/seller/verified-12345/\\n";
  const sourceHash = crypto.createHash("sha256").update(sourceText).digest("hex");
  await fs.writeFile(urlsFile, sourceText);
  await fs.writeFile(path.join(runDir, "source_set_epochs.jsonl"), `${JSON.stringify({
    type: "source-set-epoch",
    at: "2026-07-30T00:00:00.000Z",
    epoch: 2,
    source_set_sha256: sourceHash,
  })}\n`);
  const currentRun = {
    formal_started: true,
    urls_file: urlsFile,
    active_source_set_sha256: sourceHash,
    source_set_epoch: 2,
  };
  let formalCalls = 0;
  const skipped = await runInitialSourceRefresh({
    appRoot: root,
    stateRoot,
    runDir,
    currentRun,
    now: () => new Date("2026-07-30T01:59:59.000Z"),
    formalRefresh: async () => {
      formalCalls += 1;
      return { code: 0 };
    },
  });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.epoch, 2);
  assert.equal(formalCalls, 0);

  await runInitialSourceRefresh({
    appRoot: root,
    stateRoot,
    runDir,
    currentRun,
    now: () => new Date("2026-07-30T02:00:00.000Z"),
    formalRefresh: async () => {
      formalCalls += 1;
      return { code: 0 };
    },
  });
  assert.equal(formalCalls, 1);

  await fs.writeFile(urlsFile, "https://www.ozon.ru/seller/unauthorized-99999/\\n");
  await assert.rejects(
    runInitialSourceRefresh({
      appRoot: root,
      stateRoot,
      runDir,
      currentRun,
      now: () => new Date("2026-07-30T01:00:00.000Z"),
    }),
    /not authorized/u,
  );
});

test("formal source refresh appends an authorized epoch before updating current run", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-formal-source-epoch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const runDir = path.join(root, "run");
  const urlsFile = path.join(root, "active_urls.txt");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });
  const oldText = "https://www.ozon.ru/seller/verified-old-12345/\\n";
  const oldHash = crypto.createHash("sha256").update(oldText).digest("hex");
  const newText = "https://www.ozon.ru/seller/verified-new-67890/\\n";
  await fs.writeFile(urlsFile, oldText);
  await fs.writeFile(path.join(runDir, "source_set_epochs.jsonl"), `${JSON.stringify({
    type: "source-set-epoch",
    at: "2026-07-30T00:00:00.000Z",
    epoch: 0,
    source_set_sha256: oldHash,
  })}\n`);
  const currentRun = {
    run_id: "formal-run",
    formal_started: true,
    urls_file: urlsFile,
    active_source_set_sha256: oldHash,
    source_set_epoch: 0,
  };
  const refreshed = await runFormalSourceRefresh(root, stateRoot, runDir, currentRun, {
    refresh: async () => {
      await fs.writeFile(urlsFile, newText);
      return { code: 0 };
    },
    now: () => new Date("2026-07-30T02:00:00.000Z"),
  });
  const newHash = crypto.createHash("sha256").update(newText).digest("hex");
  assert.equal(refreshed.epoch, 1);
  assert.equal(refreshed.source_set_sha256, newHash);
  const epochs = (await fs.readFile(path.join(runDir, "source_set_epochs.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(epochs.at(-1).previous_source_set_sha256, oldHash);
  assert.equal(epochs.at(-1).source_set_sha256, newHash);
  const persisted = JSON.parse(await fs.readFile(path.join(stateRoot, "current_run.json"), "utf8"));
  assert.equal(persisted.active_source_set_sha256, newHash);
  assert.equal(persisted.source_set_epoch, 1);
});

test("direct source refresh reuses a current epoch and repairs a legacy unauthorized set", async () => {
  const calls = [];
  const shared = {
    appRoot: "/tmp/app",
    stateRoot: "/tmp/state",
    runDir: "/tmp/run",
    currentRun: { formal_started: true },
  };
  const skipped = await runDirectSourceRefresh({
    ...shared,
    initialRefresh: async (options) => {
      calls.push(["initial", options]);
      return { code: 0, skipped: true };
    },
    formalRefresh: async () => {
      calls.push(["formal"]);
      return { code: 0 };
    },
  });
  assert.equal(skipped.skipped, true);
  assert.deepEqual(calls.map(([name]) => name), ["initial"]);

  calls.length = 0;
  const repaired = await runDirectSourceRefresh({
    ...shared,
    initialRefresh: async () => {
      const error = new Error("legacy set needs authorization");
      error.code = "OZON_SOURCE_SET_NOT_AUTHORIZED";
      throw error;
    },
    formalRefresh: async (...args) => {
      calls.push(["formal", args]);
      return { code: 0, epoch: 1 };
    },
  });
  assert.equal(repaired.epoch, 1);
  assert.deepEqual(calls.map(([name]) => name), ["formal"]);
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
  assert.equal(environment.FLOW_B_STATE_SCHEMA_VERSION, "3");
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
  assert.equal(args.includes("--disable-session-crashed-bubble"), true);
  assert.equal(args.includes("--disable-software-rasterizer"), false);
});

test("browser startup gives slow but live CDP a bounded grace window", async () => {
  assert.deepEqual(browserCdpStartupSettings({}), {
    probeTimeoutMs: 10_000,
    existingOwnerGraceMs: 30_000,
    startTimeoutMs: 180_000,
  });

  let now = 0;
  let probes = 0;
  const ready = await waitForBrowserCdp("http://127.0.0.1:9223", {
    timeoutMs: 30_000,
    probeTimeoutMs: 10_000,
    ownerPid: 4242,
    nowFn: () => now,
    delayFn: async (ms) => { now += ms; },
    pidAliveFn: () => true,
    cdpReadyFn: async (_endpoint, timeoutMs) => {
      probes += 1;
      assert.equal(timeoutMs <= 10_000, true);
      now += 3_500;
      return probes === 2;
    },
  });

  assert.equal(ready, true);
  assert.equal(probes, 2);
});

test("browser startup stops waiting when the exact owner exits", async () => {
  let now = 0;
  let aliveChecks = 0;
  const ready = await waitForBrowserCdp("http://127.0.0.1:9223", {
    timeoutMs: 180_000,
    probeTimeoutMs: 10_000,
    ownerPid: 4242,
    nowFn: () => now,
    delayFn: async (ms) => { now += ms; },
    pidAliveFn: () => ++aliveChecks === 1,
    cdpReadyFn: async () => false,
  });

  assert.equal(ready, false);
  assert.equal(aliveChecks, 2);
});

test("Chrome CDP startup timeout is classified as browser recovery", () => {
  assert.deepEqual(classifyWorkerFailure({
    message: "Chrome CDP failed to become ready at http://127.0.0.1:9223",
    profileOwnerCount: 1,
  }), {
    action: "restart-browser-and-worker",
    reason: "browser-or-network-recoverable",
  });
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

test("production resume contract rejects legacy dynamic windows and accepts the fixed identity", () => {
  const currentRun = {
    run_id: "fixed-run",
    run_dir: "/state/runs/fixed-run",
    urls_file: "/state/sources/active_urls.txt",
    formal_started: true,
    acceptance_target: 500,
    acceptance_target_policy: "fixed",
    config_sha256: "config-hash",
    source_set_sha256: "source-hash",
    state_schema_version: 3,
  };
  const acceptanceWindow = {
    started_at: "2026-07-27T00:00:00.000Z",
    ended_at: "2026-07-28T00:00:00.000Z",
    acceptance_target: 500,
    acceptance_target_policy: "fixed",
    per_store_target: 100,
    rolling_rate_window_minutes: 120,
    minimum_average_per_hour_exclusive: 35,
    current_window_only: true,
  };
  const sourceConfig = {
    acceptance_target: 500,
    acceptance_target_policy: "fixed",
    per_store_target: 100,
    minimum_average_per_hour_exclusive: 35,
    require_quality_evidence: true,
    current_window_only: true,
    store_targets: [
      { id: 106637, warehouseId: 1 },
      { id: 106640, warehouseId: 2 },
      { id: 106644, warehouseId: 3 },
      { id: 106646, warehouseId: 4 },
      { id: 104965, warehouseId: 5 },
    ],
  };
  const frozenManifest = {
    run_id: "fixed-run",
    commit_sha: "release-commit",
    config_sha256: "config-hash",
    source_set_sha256: "source-hash",
    state_schema_version: 3,
    acceptance_target: 500,
    acceptance_target_policy: "fixed",
    per_store_target: 100,
    rolling_rate_window_minutes: 120,
    minimum_strict_per_hour: 35,
    current_window_only: true,
  };
  assert.equal(productionRunContractDecision({
    currentRun,
    acceptanceWindow,
    sourceConfig,
    frozenManifest,
    expectedConfigHash: "config-hash",
    expectedCommitSha: "release-commit",
  }).action, "continue");
  const legacy = productionRunContractDecision({
    currentRun: {
      ...currentRun,
      acceptance_target: 469,
      acceptance_target_policy: "erp_remaining_capacity",
    },
    acceptanceWindow: {
      ...acceptanceWindow,
      acceptance_target: 469,
      acceptance_target_policy: "erp_remaining_capacity",
    },
    sourceConfig,
    frozenManifest,
    expectedConfigHash: "config-hash",
    expectedCommitSha: "release-commit",
  });
  assert.equal(legacy.action, "fatal-stop");
  assert.ok(legacy.issues.includes("current-target-not-500"));
  assert.ok(legacy.issues.includes("current-target-policy-not-fixed"));
});

test("pre-formal resume requires matching config, source-set, and state identities", () => {
  const currentRun = {
    run_id: "pending-run",
    run_dir: "/state/runs/pending-run",
    urls_file: "/state/sources/active_urls.txt",
    formal_started: false,
    config_sha256: "config-hash",
    source_set_sha256: "source-hash",
    state_schema_version: 3,
  };
  const pendingManifest = {
    run_id: "pending-run",
    config_sha256: "config-hash",
    source_set_sha256: "source-hash",
    state_schema_version: 3,
    formal_window_started: false,
  };
  assert.equal(productionRunContractDecision({
    currentRun,
    pendingManifest,
    expectedConfigHash: "config-hash",
  }).action, "continue");
  assert.equal(productionRunContractDecision({
    currentRun,
    pendingManifest: { ...pendingManifest, source_set_sha256: "old-source" },
    expectedConfigHash: "config-hash",
  }).action, "fatal-stop");
});

test("launchd honors an intentional safe stop across computer restart", () => {
  assert.equal(supervisorShouldHonorSafeStop({ status: "STOPPED" }), true);
  assert.equal(supervisorShouldHonorSafeStop({ status: "FATAL_STOP" }), true);
  assert.equal(supervisorShouldHonorSafeStop({ status: "WINDOW_COMPLETE" }), true);
  assert.equal(supervisorShouldHonorSafeStop({ status: "TARGET_NOT_MET" }), true);
  assert.equal(supervisorShouldHonorSafeStop({ status: "RETIRED" }), true);
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
    "browserType.connectOverCDP: Timeout 30000ms exceeded.",
    "browserContext.newPage: Target page, context or browser has been closed",
    "page.goto: net::ERR_CONNECTION_RESET",
  ]) {
    assert.deepEqual(classifyWorkerFailure({ message, profileOwnerCount: 0 }), {
      action: "restart-browser-and-worker",
      reason: "browser-or-network-recoverable",
    });
  }

  const sessionTimeoutDecision = classifyWorkerFailure({
    message: "browserType.connectOverCDP: Timeout 30000ms exceeded.",
    profileOwnerCount: 1,
  });
  assert.deepEqual(sessionTimeoutDecision, {
    action: "restart-browser-and-worker",
    reason: "browser-or-network-recoverable",
  });
  assert.deepEqual(browserOwnerPidsForRecovery(sessionTimeoutDecision, [{ pid: 84424 }]), [84424]);

  assert.deepEqual(
    [0, 1, 2, 3, 20].map((attempt) => nextRestartDelaySeconds(attempt)),
    [30, 60, 120, 120, 120],
  );

  const pageCreateDecision = classifyWorkerFailure({
    message: "favorite worker page creation timed out after 10000ms",
    profileOwnerCount: 1,
  });
  assert.deepEqual(pageCreateDecision, {
    action: "restart-worker",
    reason: "ordinary-worker-recoverable",
  });
  assert.deepEqual(
    browserOwnerPidsForRecovery(pageCreateDecision, [{ pid: 92462 }]),
    [],
  );
  assert.deepEqual(classifyWorkerFailure({
    message: "favorite worker page creation timed out after 10000ms",
    profileOwnerCount: 0,
  }), {
    action: "restart-browser-and-worker",
    reason: "browser-or-network-recoverable",
  });
  assert.deepEqual(
    browserOwnerPidsForRecovery({ action: "restart-worker" }, [{ pid: 92462 }]),
    [],
  );
});

test("Maozi extension startup failures recycle the browser without broad timeout matching", () => {
  for (const message of [
    "Maozi extension did not load in Chrome for Testing",
    "Maozi extension popup committed to an unexpected URL: about:blank",
    [
      "page.goto: Timeout 10000ms exceeded.",
      "Call log:",
      "  - navigating to \"chrome-extension://kifocjelffhjimimdnjohjldolickjaa/popup.html\", waiting until \"domcontentloaded\"",
    ].join("\n"),
    [
      "page.goto: Timeout 10000ms exceeded.",
      "Call log:",
      "  - navigating to \"chrome-extension://kifocjelffhjimimdnjohjldolickjaa/popup.html\", waiting until \"commit\"",
    ].join("\n"),
  ]) {
    assert.deepEqual(classifyWorkerFailure({ message, profileOwnerCount: 1 }), {
      action: "restart-browser-and-worker",
      reason: "browser-or-network-recoverable",
    });
  }

  for (const message of [
    "page.goto: Timeout 10000ms exceeded while opening https://ozon.maozierp.com/",
    [
      "page.goto: Timeout 10000ms exceeded.",
      "Call log:",
      "  - navigating to \"chrome-extension://abcdefghijklmnop/popup.html\", waiting until \"commit\"",
    ].join("\n"),
    "an unrelated extension failed to load",
  ]) {
    assert.deepEqual(classifyWorkerFailure({ message, profileOwnerCount: 1 }), {
      action: "restart-worker",
      reason: "ordinary-worker-recoverable",
    });
  }
});

test("a foreground Maozi favorites GET timeout is worker-only when CDP remains owned", () => {
  const decision = classifyWorkerFailure({
    message: "Maozi GET /api.product.favorite/lists timed out during get-total-budget after 120000ms",
    profileOwnerCount: 1,
  });
  assert.deepEqual(decision, {
    action: "restart-worker",
    reason: "ordinary-worker-recoverable",
  });
  assert.deepEqual(browserOwnerPidsForRecovery(decision, [{ pid: 92462 }]), []);
});

test("owner and security risks take priority over Maozi extension recovery", () => {
  const popupTimeout = [
    "page.goto: Timeout 10000ms exceeded.",
    "Ozon CAPTCHA verification required",
    "  - navigating to \"chrome-extension://kifocjelffhjimimdnjohjldolickjaa/popup.html\", waiting until \"commit\"",
  ].join("\n");
  assert.deepEqual(classifyWorkerFailure({ message: popupTimeout, profileOwnerCount: 1 }), {
    action: "wait-for-verification",
    reason: "security-verification-required",
  });
  assert.deepEqual(classifyWorkerFailure({
    message: "Maozi extension did not load in Chrome for Testing",
    profileOwnerCount: 2,
  }), {
    action: "fatal-stop",
    reason: "duplicate-profile-owner-risk",
  });
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

test("direct supervisor preserves current worker browser evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-direct-worker-evidence-"));
  const stderrPath = path.join(root, "stderr.log");
  const runtimeErrorsPath = path.join(root, "runtime_errors.jsonl");
  await fs.writeFile(stderrPath, "historical stderr\n");
  await fs.writeFile(runtimeErrorsPath, "historical runtime error\n");
  const stderrOffset = Buffer.byteLength("historical stderr\n");
  const runtimeErrorsOffset = Buffer.byteLength("historical runtime error\n");
  await fs.appendFile(stderrPath, "worker exited with code 1\n");
  await fs.appendFile(
    runtimeErrorsPath,
    "browserContext.newPage: Target page, context or browser has been closed\n",
  );

  const evidence = await readWorkerGenerationEvidence({
    stderrPath,
    runtimeErrorsPath,
    stderrOffset,
    runtimeErrorsOffset,
  });
  assert.doesNotMatch(evidence, /historical/);
  assert.match(evidence, /Target page, context or browser has been closed/);
  assert.deepEqual(classifyWorkerFailure({
    message: evidence,
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

test("direct worker health tracks consecutive scan errors and resets only on empty success", async () => {
  const writes = [];
  let tick = 0;
  const tracker = createDirectWorkerHealthTracker({
    filename: "/tmp/direct-worker-health.json",
    runId: "run-1",
    generation: "generation-1",
    workerPid: 4321,
    now: () => new Date(Date.UTC(2026, 7, 10, 10, 0, tick++)),
    write: async (_filename, value) => { writes.push(structuredClone(value)); },
  });

  await tracker.start();
  await tracker.scanStarted();
  await tracker.scanProgress({ kind: "source-batch-completed" });
  assert.equal(tracker.snapshot().producer.last_progress_kind, "source-batch-completed");
  await tracker.scanFailed(new Error("Maximum call stack size exceeded"));
  await tracker.scanStarted();
  await tracker.scanFailed(new Error("Maximum   call stack size exceeded"));
  assert.equal(tracker.snapshot().producer.consecutive_errors, 2);
  assert.equal(
    tracker.snapshot().producer.error_signature,
    directWorkerErrorSignature(new Error("Maximum call stack size exceeded")),
  );

  await tracker.scanStarted();
  await tracker.scanFailed(new Error("different scan failure"));
  assert.equal(tracker.snapshot().producer.consecutive_errors, 3);
  assert.equal(
    tracker.snapshot().producer.error_signature,
    directWorkerErrorSignature(new Error("different scan failure")),
  );
  await tracker.scanStarted();
  await tracker.scanSucceeded({ candidate_activity_count: 0 });
  assert.equal(tracker.snapshot().producer.phase, "healthy");
  assert.equal(tracker.snapshot().producer.consecutive_errors, 0);
  assert.equal(tracker.snapshot().producer.activity_count, 0);
  assert.ok(writes.length >= 9);
});

test("direct worker watchdog restarts after three consecutive failures or twenty minutes stale", () => {
  const workerStartedAt = Date.parse("2026-08-10T10:00:00.000Z");
  const baseHealth = {
    schema_version: 1,
    run_id: "run-1",
    worker_generation: "generation-1",
    worker_pid: 4321,
    heartbeat_at: "2026-08-10T10:02:00.000Z",
    producer: {
      phase: "error",
      consecutive_errors: 2,
      error_signature: "a".repeat(64),
    },
  };
  const decide = (health, now, extra = {}) => directWorkerHealthDecision({
    health,
    expectedRunId: "run-1",
    expectedGeneration: "generation-1",
    expectedWorkerPid: 4321,
    workerStartedAt,
    now,
    startupGraceMs: 180_000,
    staleMs: 1_200_000,
    errorThreshold: 3,
    recoveryCooldownMs: 300_000,
    ...extra,
  });

  assert.equal(decide(baseHealth, Date.parse("2026-08-10T10:02:15.000Z")).action, "continue");
  const threeErrors = decide({
    ...baseHealth,
    producer: { ...baseHealth.producer, consecutive_errors: 3 },
  }, Date.parse("2026-08-10T10:02:15.000Z"));
  assert.equal(threeErrors.action, "restart-worker");
  assert.equal(threeErrors.reason, "direct-source-scan-consecutive-errors");

  const healthy = {
    ...baseHealth,
    heartbeat_at: "2026-08-10T10:10:00.000Z",
    producer: { phase: "healthy", consecutive_errors: 0 },
  };
  assert.equal(
    decide(healthy, Date.parse("2026-08-10T10:29:59.999Z")).action,
    "continue",
  );
  assert.equal(decide({
    ...healthy,
    heartbeat_at: "2026-08-10T10:25:00.000Z",
    producer: {
      phase: "scanning",
      attempt_started_at: "2026-08-10T10:00:00.000Z",
      last_progress_at: "2026-08-10T10:25:00.000Z",
      consecutive_errors: 0,
    },
  }, Date.parse("2026-08-10T10:30:00.000Z")).action, "continue");
  const stale = decide(healthy, Date.parse("2026-08-10T10:30:00.000Z"));
  assert.equal(stale.action, "restart-worker");
  assert.equal(stale.reason, "direct-producer-progress-stale");
});

test("direct worker watchdog rejects old generations and respects startup, window, and cooldown gates", () => {
  const workerStartedAt = Date.parse("2026-08-10T10:00:00.000Z");
  const oldHealth = {
    schema_version: 1,
    run_id: "run-1",
    worker_generation: "old-generation",
    worker_pid: 1111,
    heartbeat_at: "2026-08-10T10:02:00.000Z",
    producer: { phase: "healthy", consecutive_errors: 0 },
  };
  const decide = (now, extra = {}) => directWorkerHealthDecision({
    health: oldHealth,
    expectedRunId: "run-1",
    expectedGeneration: "generation-1",
    expectedWorkerPid: 4321,
    workerStartedAt,
    now,
    startupGraceMs: 180_000,
    staleMs: 1_200_000,
    errorThreshold: 3,
    recoveryCooldownMs: 300_000,
    ...extra,
  });

  assert.equal(
    decide(Date.parse("2026-08-10T10:02:59.999Z")).reason,
    "direct-producer-startup-grace",
  );
  assert.equal(decide(Date.parse("2026-08-10T10:03:00.000Z")).action, "restart-worker");
  assert.equal(
    decide(Date.parse("2026-08-10T10:30:00.000Z"), { eligible: false }).action,
    "continue",
  );
  const cooldown = decide(Date.parse("2026-08-10T10:30:00.000Z"), {
    lastRecoveryAt: "2026-08-10T10:28:00.000Z",
  });
  assert.equal(cooldown.action, "defer-recovery");
  assert.equal(cooldown.reason, "direct-producer-recovery-cooldown");
});

test("direct worker recovery budget delays only unhealthy workers and retries automatically", () => {
  const workerStartedAt = Date.parse("2026-08-10T10:00:00.000Z");
  const health = {
    schema_version: 1,
    run_id: "run-1",
    worker_generation: "generation-1",
    worker_pid: 4321,
    heartbeat_at: "2026-08-10T10:10:00.000Z",
    producer: { phase: "healthy", consecutive_errors: 0 },
  };
  const decide = (candidateHealth, now) => directWorkerHealthDecision({
    health: candidateHealth,
    expectedRunId: "run-1",
    expectedGeneration: "generation-1",
    expectedWorkerPid: 4321,
    workerStartedAt,
    now,
    staleMs: 1_200_000,
    recoveryHistory: [
      { at: "2026-08-10T09:00:00.000Z" },
      { at: "2026-08-10T09:30:00.000Z" },
    ],
    recoveryCooldownMs: 1_800_000,
    recoveryWindowMs: 7_200_000,
    maxRecoveriesPerWindow: 2,
  });

  assert.equal(decide(health, Date.parse("2026-08-10T10:15:00.000Z")).action, "continue");
  const deferred = decide({
    ...health,
    heartbeat_at: "2026-08-10T10:10:00.000Z",
    producer: { phase: "error", consecutive_errors: 3 },
  }, Date.parse("2026-08-10T10:15:00.000Z"));
  assert.equal(deferred.action, "defer-recovery");
  assert.equal(deferred.reason, "direct-producer-recovery-budget");
  assert.equal(deferred.trigger_reason, "direct-source-scan-consecutive-errors");
  const retryInProgress = decide({
    ...health,
    heartbeat_at: "2026-08-10T10:14:59.000Z",
    producer: { phase: "scanning", consecutive_errors: 3 },
  }, Date.parse("2026-08-10T10:15:00.000Z"));
  assert.equal(retryInProgress.action, "continue");
  assert.equal(retryInProgress.reason, "direct-producer-retry-in-progress");

  const retry = decide({
    ...health,
    heartbeat_at: "2026-08-10T11:00:00.000Z",
    producer: { phase: "error", consecutive_errors: 3 },
  }, Date.parse("2026-08-10T11:00:00.001Z"));
  assert.equal(retry.action, "restart-worker");
  assert.equal(retry.reason, "direct-source-scan-consecutive-errors");
});

test("supervisor restarts only the worker after two unhealthy producer probes", async () => {
  const worker = new EventEmitter();
  let probes = 0;
  const result = await waitForWorkerOrBrowserFailure(worker, {
    cdpEndpoint: "http://127.0.0.1:9223",
    probeIntervalMs: 1,
    probeTimeoutMs: 1,
    failureThreshold: 2,
    workerHealthFailureThreshold: 2,
    cdpReadyFn: async () => true,
    workerHealthFn: async () => {
      probes += 1;
      return {
        action: "restart-worker",
        reason: "direct-source-scan-consecutive-errors",
        consecutive_errors: 3,
      };
    },
    delayFn: async () => {},
  });

  assert.equal(probes, 2);
  assert.equal(result.browser_unhealthy, false);
  assert.equal(result.worker_unhealthy, true);
  assert.equal(result.worker_health.reason, "direct-source-scan-consecutive-errors");
});

test("watchdog producer failures preserve the browser unless ownership or verification is unsafe", () => {
  const workerHealth = { reason: "direct-source-scan-consecutive-errors" };
  assert.deepEqual(directWatchdogRecoveryDecision({
    workerUnhealthy: true,
    workerHealth,
    classifiedDecision: {
      action: "restart-browser-and-worker",
      reason: "browser-or-network-recoverable",
    },
  }), {
    action: "restart-worker",
    reason: "direct-source-scan-consecutive-errors",
  });
  assert.deepEqual(directWatchdogRecoveryDecision({
    workerUnhealthy: true,
    workerHealth,
    classifiedDecision: {
      action: "fatal-stop",
      reason: "duplicate-profile-owner-risk",
    },
  }), {
    action: "fatal-stop",
    reason: "duplicate-profile-owner-risk",
  });
  assert.deepEqual(directWatchdogRecoveryDecision({
    workerUnhealthy: true,
    workerHealth,
    classifiedDecision: {
      action: "wait-for-verification",
      reason: "security-verification-required",
    },
  }), {
    action: "wait-for-verification",
    reason: "security-verification-required",
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
    message: "Maozi login required",
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

test("verification recovery schedules only inside the submission window", () => {
  const settings = verificationAutoRecoverySettings({
    verification_auto_recovery: {
      enabled: true,
      probe_delays_seconds: [300, 600, 1200, 1800],
      ready_confirmations: 2,
      confirmation_interval_seconds: 30,
      confirmation_max_age_seconds: 90,
    },
  });
  const accessState = {
    requires_manual_clear: true,
    updated_at: "2026-08-11T10:00:00.000Z",
    reason: "Ozon CAPTCHA required",
    last_url: "https://www.ozon.ru/seller/example/",
  };
  const token = verificationLockToken(accessState);
  assert.match(token, /^[a-f0-9]{64}$/u);
  assert.equal(verificationProbeSchedule({
    accessState,
    settings,
    now: new Date("2026-08-11T10:04:59.999Z"),
    submissionWindow: { open: true },
  }).action, "wait");
  assert.equal(verificationProbeSchedule({
    accessState,
    settings,
    now: new Date("2026-08-11T10:05:00.000Z"),
    submissionWindow: { open: true },
  }).action, "probe");
  const closed = verificationProbeSchedule({
    accessState,
    settings,
    now: new Date("2026-08-11T15:30:00.000Z"),
    submissionWindow: { open: false, next_open_at: "2026-08-11T16:00:00.000Z" },
  });
  assert.equal(closed.action, "wait");
  assert.equal(closed.next_probe_at, "2026-08-11T16:00:00.000Z");

  const recoveryState = {
    lock_token: token,
    ready_confirmations: 1,
    last_ready_at: "2026-08-11T10:05:00.000Z",
    next_probe_at: "2026-08-11T10:05:30.000Z",
  };
  assert.equal(verificationProbeSchedule({
    accessState,
    recoveryState,
    settings,
    now: new Date("2026-08-11T10:05:30.000Z"),
    submissionWindow: { open: true },
  }).ready_confirmations, 1);
  assert.equal(verificationProbeSchedule({
    accessState,
    recoveryState,
    settings,
    now: new Date("2026-08-11T10:06:31.000Z"),
    submissionWindow: { open: true },
  }).ready_confirmations, 0);
  assert.equal(verificationProbeSchedule({
    accessState,
    recoveryState,
    settings,
    now: new Date("2026-08-11T15:30:00.000Z"),
    submissionWindow: { open: false, next_open_at: "2026-08-11T16:00:00.000Z" },
  }).ready_confirmations, 0);
});

test("verification probe subprocess accepts only a structured tri-state result", async () => {
  let execOptions;
  const ready = await runOzonVerificationProbe({
    appRoot: "/app",
    cdpEndpoint: "http://127.0.0.1:9223",
    url: "https://www.ozon.ru/seller/example/",
    execFileFn: async (_executable, _arguments, options) => {
      execOptions = options;
      return {
        stdout: `warning\n${JSON.stringify({
        version: "ozon-verification-probe-v1",
        classification: "READY",
        reason: "listing-structure-ready",
        final_url: "https://www.ozon.ru/seller/example/",
        http_status: 200,
        product_link_count: 3,
        product_evidence: false,
        captcha: false,
        authentication: false,
        soft_block: false,
        text_sha256: "a".repeat(64),
        })}\n`,
      };
    },
  });
  assert.equal(ready.classification, "READY");
  assert.match(execOptions.env.NO_PROXY, /(?:^|,)127\.0\.0\.1(?:,|$)/u);
  assert.match(execOptions.env.no_proxy, /(?:^|,)localhost(?:,|$)/u);

  const malformed = await runOzonVerificationProbe({
    appRoot: "/app",
    cdpEndpoint: "http://127.0.0.1:9223",
    url: "https://www.ozon.ru/seller/example/",
    execFileFn: async () => ({ stdout: "{}\n" }),
  });
  assert.equal(malformed.classification, "INDETERMINATE");
  assert.equal(malformed.reason, "probe-process-failed");
});

test("verification wait requires two READY probes for the same lock before automatic recovery", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-verification-auto-"));
  const runDir = path.join(stateRoot, "runs", "run");
  const profileDir = path.join(stateRoot, "profiles", "profile");
  const accessStateFile = path.join(path.dirname(profileDir), "ozon_access_state.json");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(path.dirname(profileDir), { recursive: true });
  await fs.writeFile(accessStateFile, `${JSON.stringify({
    version: 2,
    updated_at: "2026-08-11T01:00:00.000Z",
    verification_last_detected_at: "2026-08-11T01:00:00.000Z",
    requires_manual_clear: true,
    reason: "Ozon CAPTCHA required",
    last_url: "https://www.ozon.ru/seller/example/",
    current_interval_ms: 3_000,
    warmup_complete: true,
  })}\n`);
  await fs.writeFile(path.join(stateRoot, "verification_recovery_state.json"), "{invalid-json\n");
  let clock = Date.parse("2026-08-11T02:00:00.000Z");
  let probes = 0;
  await waitForVerification({
    stateRoot,
    currentRun: { run_id: "run", run_dir: runDir },
    appRoot: path.resolve(import.meta.dirname, ".."),
    runDir,
    stopFile: path.join(stateRoot, "stop.request"),
    checkpointEnv: { FLOW_B_PW_PROFILE: profileDir },
    config: {
      browser: { profile_dir: profileDir, cdp_endpoint: "http://127.0.0.1:9223" },
      flow_env: {
        FLOW_B_DAILY_STORE_TIMEZONE: "Asia/Shanghai",
        FLOW_B_DAILY_SUBMISSION_CUTOFF: "23:00",
        FLOW_B_DAILY_REPORT_AFTER: "23:30",
      },
      verification_auto_recovery: {
        enabled: true,
        probe_delays_seconds: [300, 600, 1_200, 1_800],
        ready_confirmations: 2,
        confirmation_interval_seconds: 30,
        confirmation_max_age_seconds: 90,
        probe_timeout_ms: 45_000,
        poll_interval_ms: 500,
        warmup_interval_ms: 8_000,
      },
    },
    now: () => new Date(clock),
    delayFn: async (ms) => { clock += ms; },
    profileOwnersFn: async () => [{ pid: 123 }],
    cdpReadyFn: async () => true,
    probeFn: async () => {
      probes += 1;
      if (probes === 2) clock += 61_000;
      return {
        classification: "READY",
        reason: "listing-structure-ready",
        final_url: "https://www.ozon.ru/seller/example/",
        title: "Example — OZON",
        text_sha256: "a".repeat(64),
      };
    },
    runCheckpointFn: async () => {},
  });
  assert.equal(probes, 3);
  const saved = JSON.parse(await fs.readFile(accessStateFile, "utf8"));
  assert.equal(saved.requires_manual_clear, false);
  assert.equal(saved.warmup_complete, false);
  assert.equal(saved.current_interval_ms, 8_000);
  const audit = (await fs.readFile(path.join(stateRoot, "verification_recovery.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.deepEqual(audit.map((row) => row.event), [
    "recovery-state-reset",
    "probe",
    "probe",
    "probe",
    "automatic-recovery",
  ]);
  await fs.rm(stateRoot, { recursive: true, force: true });
});

test("non-Ozon security waits for an explicit resume instead of entering the Ozon probe loop", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-non-ozon-verification-"));
  const runDir = path.join(stateRoot, "runs", "run");
  const profileDir = path.join(stateRoot, "profiles", "profile");
  const accessStateFile = path.join(path.dirname(profileDir), "ozon_access_state.json");
  const resumeFile = path.join(stateRoot, "resume.request");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(path.dirname(profileDir), { recursive: true });
  await fs.writeFile(accessStateFile, `${JSON.stringify({
    version: 2,
    requires_manual_clear: false,
  })}\n`);
  let probeCalls = 0;
  let delays = 0;
  await waitForVerification({
    stateRoot,
    currentRun: { run_id: "run", run_dir: runDir },
    appRoot: path.resolve(import.meta.dirname, ".."),
    runDir,
    stopFile: path.join(stateRoot, "stop.request"),
    checkpointEnv: { FLOW_B_PW_PROFILE: profileDir },
    config: {
      verification_auto_recovery: { enabled: true },
      flow_env: {},
    },
    delayFn: async () => {
      delays += 1;
      await fs.writeFile(resumeFile, "resume\n");
    },
    probeFn: async () => {
      probeCalls += 1;
      return { classification: "READY" };
    },
    runCheckpointFn: async () => {},
  });
  assert.equal(delays, 1);
  assert.equal(probeCalls, 0);
  await assert.rejects(fs.access(resumeFile), { code: "ENOENT" });
  await fs.rm(stateRoot, { recursive: true, force: true });
});

test("a READY probe that crosses the submission cutoff cannot clear the verification lock", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-verification-cutoff-"));
  const runDir = path.join(stateRoot, "runs", "run");
  const profileDir = path.join(stateRoot, "profiles", "profile");
  const accessStateFile = path.join(path.dirname(profileDir), "ozon_access_state.json");
  const stopFile = path.join(stateRoot, "stop.request");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(path.dirname(profileDir), { recursive: true });
  await fs.writeFile(accessStateFile, `${JSON.stringify({
    version: 2,
    updated_at: "2026-08-11T14:00:00.000Z",
    verification_last_detected_at: "2026-08-11T14:00:00.000Z",
    requires_manual_clear: true,
    reason: "Ozon CAPTCHA required",
    last_url: "https://www.ozon.ru/seller/example/",
  })}\n`);
  let clock = Date.parse("2026-08-11T14:59:50.000Z");
  await waitForVerification({
    stateRoot,
    currentRun: { run_id: "run", run_dir: runDir },
    appRoot: path.resolve(import.meta.dirname, ".."),
    runDir,
    stopFile,
    checkpointEnv: { FLOW_B_PW_PROFILE: profileDir },
    config: {
      browser: { profile_dir: profileDir, cdp_endpoint: "http://127.0.0.1:9223" },
      flow_env: {
        FLOW_B_DAILY_STORE_TIMEZONE: "Asia/Shanghai",
        FLOW_B_DAILY_SUBMISSION_CUTOFF: "23:00",
        FLOW_B_DAILY_REPORT_AFTER: "23:30",
      },
      verification_auto_recovery: {
        enabled: true,
        probe_delays_seconds: [300, 600, 1_200, 1_800],
        ready_confirmations: 2,
        confirmation_interval_seconds: 30,
        confirmation_max_age_seconds: 90,
        poll_interval_ms: 500,
      },
    },
    now: () => new Date(clock),
    delayFn: async (ms) => {
      clock += ms;
      await fs.writeFile(stopFile, "stop\n");
    },
    profileOwnersFn: async () => [{ pid: 123 }],
    cdpReadyFn: async () => true,
    probeFn: async () => {
      clock += 20_000;
      return { classification: "READY", reason: "listing-structure-ready" };
    },
    runCheckpointFn: async () => {},
  });
  const saved = JSON.parse(await fs.readFile(accessStateFile, "utf8"));
  assert.equal(saved.requires_manual_clear, true);
  const audit = (await fs.readFile(path.join(stateRoot, "verification_recovery.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(audit.some((row) => row.reason === "submission-window-closed-after-probe"), true);
  await fs.rm(stateRoot, { recursive: true, force: true });
});

test("window finalization reconstructs a missing report before exporting five-store CSVs", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-final-state-"));
  const runDir = path.join(stateRoot, "runs", "formal");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "acceptance_window.json"), JSON.stringify({
    started_at: "2026-07-27T00:00:00.000Z",
    ended_at: "2026-07-28T00:00:00.000Z",
    acceptance_target: 500,
    acceptance_target_policy: "fixed",
    per_store_target: 100,
    rolling_rate_window_minutes: 120,
    minimum_average_per_hour_exclusive: 35,
    current_window_only: true,
  }));
  await fs.writeFile(path.join(runDir, "source_config.json"), JSON.stringify({
    acceptance_target: 500,
    acceptance_target_policy: "fixed",
    per_store_target: 100,
    minimum_average_per_hour_exclusive: 35,
    require_quality_evidence: true,
    current_window_only: true,
    store_targets: [
      { id: 106637, needle: "丽丽二号", warehouseId: 1 },
      { id: 106640, needle: "丽丽三号", warehouseId: 2 },
      { id: 106644, needle: "丽丽四号", warehouseId: 3 },
      { id: 106646, needle: "丽丽五号", warehouseId: 4 },
      { id: 104965, needle: "丽丽1号", warehouseId: 5 },
    ],
  }));
  await fs.writeFile(path.join(runDir, "frozen_manifest.json"), JSON.stringify({
    run_id: "formal",
    commit_sha: "release-commit",
    config_sha256: "config-hash",
    source_set_sha256: "source-hash",
    state_schema_version: 3,
    acceptance_target: 500,
    acceptance_target_policy: "fixed",
    per_store_target: 100,
    rolling_rate_window_minutes: 120,
    minimum_strict_per_hour: 35,
    current_window_only: true,
  }));
  await fs.writeFile(path.join(runDir, "acceptance_summary.json"), JSON.stringify({
    passed: true,
    target: 1,
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
      submitted_at: "2026-07-27T00:30:00.000Z",
      shipping_mode: "FBS",
      fbs_evidence: { verified: true },
      ...RELIABLE_COST,
      quality_gate_passed: true,
    },
  })}\n`);
  const result = await runFinalArtifacts(
    path.resolve(import.meta.dirname, ".."),
    stateRoot,
    {
      run_id: "formal",
      run_dir: runDir,
      urls_file: path.join(stateRoot, "sources", "active_urls.txt"),
      formal_started: true,
      acceptance_target: 500,
      acceptance_target_policy: "fixed",
      config_sha256: "config-hash",
      source_set_sha256: "source-hash",
      state_schema_version: 3,
    },
    runDir,
    { config_sha256: "config-hash", source_commit: "release-commit" },
  );
  assert.equal(result.output, path.join(stateRoot, "exports", "formal"));
  assert.equal(result.report.success_count, 1);
  assert.equal(result.report.passed, false);
  await fs.access(path.join(result.output, "24h_report.json"));
  await fs.access(path.join(result.output, "confirmed_all_stores.csv"));
  await fs.access(path.join(result.output, "confirmed_store_104965.csv"));
  await fs.rm(stateRoot, { recursive: true, force: true });
});
