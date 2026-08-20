import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUDITED_BROWSER_EXECUTABLE,
  AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES,
  AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG,
  AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG_SHA256,
  AUDITED_VALIDATION_DEBUG_PORT,
  AUDITED_VALIDATION_PROFILE,
  assertDedicatedPortOwnedByBrowserRoot,
  waitForAuditedPortOwnedByBrowserRoot,
} from "../scripts/audited_validation_discovery.mjs";
import {
  AuditedSmokeFailure,
  acquireAuditedSmokeInterlocks,
  assertPassingBusinessCallShape,
  cleanupExactAudited9224,
  compareProductionHashManifests,
  createAuditedSmokeForensicRun,
  createAuditedSmokeWatcher,
  evaluateAuditedSmokeWatchSample,
  hashNamedFiles,
  launchBaselineAllowed,
  networkMutationEvidence,
  parseAuditedSinglePageSmokeArgs,
  readProductionLaunchdState,
  productionRootPids,
  runAuditedSinglePageSmoke,
  runAuditedSinglePageSmokeCli,
} from "../scripts/audited_validation_single_page_smoke.mjs";

const ORCHESTRATOR_PID = 4100;
const ROOT_PID = 4200;
const LISTENER_PID = 4201;
const ORCHESTRATOR_START = "Wed Aug 19 20:00:00 2026";
const ROOT_START = "Wed Aug 19 20:00:01 2026";
const LISTENER_START = "Wed Aug 19 20:00:02 2026";
const EXACT_ROOT_COMMAND = `${AUDITED_BROWSER_EXECUTABLE} --user-data-dir=${AUDITED_VALIDATION_PROFILE} --remote-debugging-address=127.0.0.1 --remote-debugging-port=9224`;
const BOOTOUT = Object.freeze({ mode: "bootout", loaded: false });
const LOADED_NOT_RUNNING = Object.freeze({
  mode: "loaded_not_running",
  loaded: true,
  active_count: 0,
  state: "not running",
  runs: 17,
  last_exit_code: 0,
});
const DIGESTS = Object.freeze({ runner: "a".repeat(64), adapter: "b".repeat(64) });

function processRows({ root = true, rootParent = ORCHESTRATOR_PID, listener = true, exact = true } = {}) {
  return [
    { pid: ORCHESTRATOR_PID, ppid: 1, start_identity: ORCHESTRATOR_START, command: "node audited smoke orchestrator" },
    ...(root ? [{
      pid: ROOT_PID,
      ppid: rootParent,
      start_identity: ROOT_START,
      command: exact ? EXACT_ROOT_COMMAND : `${AUDITED_BROWSER_EXECUTABLE} --user-data-dir=${AUDITED_VALIDATION_PROFILE}`,
    }] : []),
    ...(listener ? [{ pid: LISTENER_PID, ppid: ROOT_PID, start_identity: LISTENER_START, command: "chrome --type=utility" }] : []),
  ];
}

function sample({
  roots = true,
  rootParent = ORCHESTRATOR_PID,
  listenerPids = [LISTENER_PID],
  exact = true,
  launch = BOOTOUT,
  criticalDigests = DIGESTS,
  productionRoots = [],
  port9223 = [],
} = {}) {
  return {
    orchestrator_pid: ORCHESTRATOR_PID,
    orchestrator_alive: true,
    orchestrator_start_identity: ORCHESTRATOR_START,
    process_rows: processRows({ root: roots, rootParent, listener: listenerPids.includes(LISTENER_PID), exact }),
    production_root_pids: productionRoots,
    listener_pids: { 9223: port9223, 9224: listenerPids },
    listener_bindings: {
      9223: {},
      9224: Object.fromEntries(listenerPids.map((pid) => [pid, ["127.0.0.1:9224"]])),
    },
    launch,
    disk_available_bytes: 20 * 1024 * 1024 * 1024,
    critical_digests: criticalDigests,
  };
}

function completeScopedNetworkSafety(overrides = {}) {
  return {
    bootstrap_host_resolver_blocked_before_dnr: true,
    bootstrap_proxy_disabled: true,
    bootstrap_prior_audited_rules_cleared_before_probe: true,
    bootstrap_protected_read_probe_blocked_before_dnr: true,
    bootstrap_persisted_full_host_lockdown: true,
    bootstrap_browser_fully_stopped_before_operational_launch: true,
    bootstrap_pre_observer_attempt_coverage: "offline-gate-only-no-attempt-observer",
    bootstrap_pre_observer_mutation_zero_proven: false,
    web_request_audit_scope: "operational-post-observer",
    operational_post_observer_web_request_audit_continuous: true,
    observer_heartbeat_interval_ms: 5_000,
    observer_heartbeat_successful_pings: 7,
    observer_heartbeat_continuous: true,
    observer_heartbeat_network_requests: 0,
    operational_post_observer_protected_analytics_upload_attempts_observed: 0,
    operational_post_observer_all_contexts_state_mutation_attempts_observed: 0,
    operational_post_observer_service_worker_state_mutation_attempts_observed: 0,
    ...overrides,
  };
}

function sampleForCurrentProcess(overrides = {}) {
  const value = sample(overrides);
  return {
    ...value,
    orchestrator_pid: process.pid,
    process_rows: value.process_rows.map((row) => ({
      ...row,
      pid: row.pid === ORCHESTRATOR_PID ? process.pid : row.pid,
      ppid: row.ppid === ORCHESTRATOR_PID ? process.pid : row.ppid,
    })),
  };
}

test("owned runner waits through root=1/listener=0 and proves the later listener ancestry", async () => {
  let milliseconds = 0;
  const listeners = [[], [], [LISTENER_PID]];
  const processText = processRows().map((row) => `${row.pid} ${row.ppid} ${row.command}`).join("\n");
  const result = await assertDedicatedPortOwnedByBrowserRoot(
    { pid: ROOT_PID, command: EXACT_ROOT_COMMAND },
    AUDITED_VALIDATION_DEBUG_PORT,
    {
      userDataDir: AUDITED_VALIDATION_PROFILE,
      chromiumExecutable: AUDITED_BROWSER_EXECUTABLE,
      remoteDebuggingPort: AUDITED_VALIDATION_DEBUG_PORT,
    },
    500,
    {
      orchestratorPid: ORCHESTRATOR_PID,
      processList: async () => processText,
      listenerPids: async () => listeners.shift() || [LISTENER_PID],
      now: () => milliseconds,
      delay: async (amount) => { milliseconds += amount; },
    },
  );
  assert.equal(result, true);
  assert.equal(milliseconds, 200);
});

test("smoke watcher accepts startup and shutdown root-only transients without weakening ownership", async () => {
  const rows = [];
  let current = sample({ roots: false, listenerPids: [] });
  let milliseconds = 0;
  const calls = {
    source_scan_requests: 0,
    live_detail_requests: 0,
    classification_requests: 0,
    favorite_mutation_attempts: 0,
    submission_attempts: 0,
  };
  const watcher = createAuditedSmokeWatcher({
    writer: { append: async (row) => { rows.push(row); } },
    probe: async () => current,
    launchBaseline: BOOTOUT,
    criticalDigestBaseline: DIGESTS,
    businessCalls: calls,
    orchestratorPid: ORCHESTRATOR_PID,
    monotonicNow: () => milliseconds,
    delay: async (amount) => { milliseconds += amount; },
    sampleIntervalMs: 60_000,
  });
  await watcher.ready();
  current = sample({ listenerPids: [] });
  await watcher.lifecycle.emit({
    phase: "bootstrap",
    state: "starting",
    cause: "startup",
    network_gate: "host_resolver_offline",
    observer_coverage: "not_available_before_dnr",
    mutation_zero_proven: false,
  });
  assert.ok(rows.some((row) => row.decision_code === "WATCH_START_GRACE"));
  current = sample();
  await watcher.lifecycle.emit({
    phase: "bootstrap",
    state: "listening",
    cause: "listener-ready",
    network_gate: "host_resolver_offline",
    observer_coverage: "not_available_before_dnr",
    mutation_zero_proven: false,
  });
  current = sample({ listenerPids: [] });
  await watcher.lifecycle.emit({
    phase: "bootstrap",
    state: "closing",
    cause: "closing",
    network_gate: "host_resolver_offline",
    observer_coverage: "not_available_before_dnr",
    mutation_zero_proven: false,
  });
  assert.ok(rows.some((row) => row.decision_code === "WATCH_CLOSE_GRACE"));
  current = sample({ roots: false, listenerPids: [] });
  await watcher.lifecycle.emit({
    phase: "bootstrap",
    state: "stopped",
    cause: "stopped",
    network_gate: "persisted_dnr_lockdown",
    observer_coverage: "not_available_before_dnr",
    mutation_zero_proven: false,
  });
  assert.equal(watcher.failed, null);
  assert.equal(watcher.snapshot().state, "stopped");
  assert.deepEqual(watcher.snapshot().business_calls, calls);
});

test("business call ceilings reject before increment and retain the legal one-page shape", async () => {
  async function makeWatcher() {
    const calls = {
      source_scan_requests: 0,
      live_detail_requests: 0,
      classification_requests: 0,
      favorite_mutation_attempts: 0,
      submission_attempts: 0,
    };
    let fatalCalls = 0;
    const watcher = createAuditedSmokeWatcher({
      writer: { append: async () => true },
      probe: async () => sample({ roots: false, listenerPids: [] }),
      launchBaseline: BOOTOUT,
      criticalDigestBaseline: DIGESTS,
      businessCalls: calls,
      orchestratorPid: ORCHESTRATOR_PID,
      onFatal: async () => { fatalCalls += 1; },
    });
    await watcher.ready();
    return { calls, watcher, fatalCalls: () => fatalCalls };
  }

  const scan = await makeWatcher();
  await scan.watcher.recordBusinessAttempt("source_scan_requests");
  await assert.rejects(
    scan.watcher.recordBusinessAttempt("source_scan_requests"),
    (error) => error.code === "SMOKE_OPERATION_FAILED",
  );
  await scan.watcher.awaitFatalAction();
  assert.equal(scan.calls.source_scan_requests, 1);
  assert.equal(scan.fatalCalls(), 1);

  const favorite = await makeWatcher();
  await assert.rejects(
    favorite.watcher.recordBusinessAttempt("favorite_mutation_attempts"),
    (error) => error.code === "SMOKE_OPERATION_FAILED",
  );
  await favorite.watcher.awaitFatalAction();
  assert.equal(favorite.calls.favorite_mutation_attempts, 0);
  assert.equal(favorite.fatalCalls(), 1);

  assert.equal(assertPassingBusinessCallShape({
    source_scan_requests: 1,
    live_detail_requests: 0,
    classification_requests: 0,
    favorite_mutation_attempts: 0,
    submission_attempts: 0,
  }), true);
  assert.throws(() => assertPassingBusinessCallShape({
    source_scan_requests: 0,
    live_detail_requests: 0,
    classification_requests: 0,
    favorite_mutation_attempts: 0,
    submission_attempts: 0,
  }), (error) => error.code === "SMOKE_OPERATION_FAILED");
  assert.throws(() => assertPassingBusinessCallShape({
    source_scan_requests: 1,
    live_detail_requests: 0,
    classification_requests: 1,
    favorite_mutation_attempts: 0,
    submission_attempts: 0,
  }), (error) => error.code === "SMOKE_OPERATION_FAILED");
});

test("persistEvidence cannot retroactively change an earlier slow sample", async () => {
  const rows = [];
  let probeCalls = 0;
  let releaseSlowProbe;
  const slowProbe = new Promise((resolve) => { releaseSlowProbe = resolve; });
  const current = sampleForCurrentProcess({ roots: false, listenerPids: [] });
  const watcher = createAuditedSmokeWatcher({
    writer: { append: async (row) => { rows.push(row); return row; } },
    probe: async () => {
      probeCalls += 1;
      if (probeCalls === 2) await slowProbe;
      return current;
    },
    launchBaseline: BOOTOUT,
    criticalDigestBaseline: DIGESTS,
    orchestratorPid: process.pid,
    sampleIntervalMs: 60_000,
  });
  await watcher.ready();
  const earlier = watcher.checkpoint("earlier_slow_sample");
  while (probeCalls < 2) await new Promise((resolve) => setImmediate(resolve));
  const later = watcher.persistEvidence("later_evidence_join", {
    observer_coverage: "all_contexts_continuous",
    network_gate: "dnr_default_deny_and_context_route",
    mutation_attempts_observed: 0,
    mutation_zero_proven: true,
  });
  releaseSlowProbe();
  await Promise.all([earlier, later]);
  assert.deepEqual(rows.slice(-2).map((row) => ({
    cause: row.cause,
    observer_coverage: row.observer_coverage,
    mutation_zero_proven: row.mutation_zero_proven,
  })), [
    {
      cause: "earlier_slow_sample",
      observer_coverage: "not_started",
      mutation_zero_proven: false,
    },
    {
      cause: "later_evidence_join",
      observer_coverage: "all_contexts_continuous",
      mutation_zero_proven: true,
    },
  ]);
});

test("mutation proof is scoped post-observer and still requires all bootstrap offline gates", () => {
  const complete = networkMutationEvidence({ network_safety: completeScopedNetworkSafety() });
  assert.equal(complete.offline_gate_proven, true);
  assert.equal(complete.operational_post_observer_mutation_zero_proven, true);
  assert.equal(complete.evidence_complete, true);

  const bootstrapGap = networkMutationEvidence({ network_safety: completeScopedNetworkSafety({
    bootstrap_browser_fully_stopped_before_operational_launch: false,
  }) });
  assert.equal(bootstrapGap.offline_gate_proven, false);
  assert.equal(bootstrapGap.operational_post_observer_mutation_zero_proven, true);
  assert.equal(bootstrapGap.evidence_complete, false);

  for (const [field, value] of [
    ["bootstrap_proxy_disabled", false],
    ["bootstrap_prior_audited_rules_cleared_before_probe", false],
    ["bootstrap_pre_observer_mutation_zero_proven", true],
  ]) {
    const invalid = networkMutationEvidence({ network_safety: completeScopedNetworkSafety({ [field]: value }) });
    assert.equal(invalid.offline_gate_proven, false, field);
    assert.equal(invalid.operational_post_observer_mutation_zero_proven, true, field);
    assert.equal(invalid.evidence_complete, false, field);
  }

  for (const [field, value] of [
    ["observer_heartbeat_continuous", false],
    ["observer_heartbeat_interval_ms", 5_001],
    ["observer_heartbeat_network_requests", 1],
  ]) {
    const invalid = networkMutationEvidence({ network_safety: completeScopedNetworkSafety({ [field]: value }) });
    assert.equal(invalid.observer_heartbeat_continuous, false, field);
    assert.equal(invalid.operational_post_observer_mutation_zero_proven, false, field);
    assert.equal(invalid.evidence_complete, false, field);
  }

  const observedMutation = networkMutationEvidence({ network_safety: completeScopedNetworkSafety({
    operational_post_observer_all_contexts_state_mutation_attempts_observed: 1,
  }) });
  assert.equal(observedMutation.offline_gate_proven, true);
  assert.equal(observedMutation.operational_post_observer_mutation_zero_proven, false);
  assert.equal(observedMutation.evidence_complete, true);
});

test("watch decisions fail closed for rogue/multiple/lost listeners, wrong ancestry, and pre-observer mutations", () => {
  const base = {
    phase: "operational",
    state: "listening",
    launchBaseline: BOOTOUT,
    criticalDigestBaseline: DIGESTS,
    orchestratorPid: ORCHESTRATOR_PID,
    orchestratorStartIdentity: ORCHESTRATOR_START,
    graceDeadlineMs: 10_000,
    nowMs: 1_000,
    observerCoverage: "all_contexts_continuous",
    networkGate: "dnr_default_deny_and_context_route",
  };
  const lost = evaluateAuditedSmokeWatchSample({
    ...base,
    sample: sample({ roots: false, listenerPids: [] }),
  });
  assert.equal(lost.code, "WATCH_UNEXPECTED_MIDRUN_LOSS");
  assert.equal(lost.confirm, true);
  assert.equal(evaluateAuditedSmokeWatchSample({
    ...base,
    sample: sample({ roots: false }),
  }).code, "WATCH_LISTENER_WITHOUT_ROOT");
  assert.equal(evaluateAuditedSmokeWatchSample({
    ...base,
    sample: sample({ listenerPids: [LISTENER_PID, 4999] }),
  }).code, "WATCH_LISTENER_COUNT_INVALID");
  assert.equal(evaluateAuditedSmokeWatchSample({
    ...base,
    sample: sample({ rootParent: 1 }),
  }).code, "WATCH_ROOT_ORCHESTRATOR_ANCESTRY_INVALID");
  assert.equal(evaluateAuditedSmokeWatchSample({
    ...base,
    sample: { ...sample(), listener_bindings: { 9223: {}, 9224: { [LISTENER_PID]: ["*:9224"] } } },
  }).code, "WATCH_LISTENER_BIND_ADDRESS_INVALID");
  assert.equal(evaluateAuditedSmokeWatchSample({
    ...base,
    sample: {
      ...sample(),
      listener_bindings: {
        9223: {},
        9224: { [LISTENER_PID]: ["127.0.0.1:9224", "*:9224"] },
      },
    },
  }).code, "WATCH_LISTENER_BIND_ADDRESS_INVALID");
  assert.equal(evaluateAuditedSmokeWatchSample({
    ...base,
    phase: "bootstrap",
    state: "starting",
    sample: sample({ roots: false, listenerPids: [] }),
    observerCoverage: "not_available_before_dnr",
    networkGate: "host_resolver_offline",
    mutationAttemptsObserved: 1,
  }).code, "WATCH_PRE_OBSERVER_MUTATION_SIGNAL");
});

test("default production matcher excludes pinned validation Chrome and detects exact production identities", () => {
  const validation = processRows();
  assert.deepEqual(productionRootPids(validation), []);
  const production = [
    ...validation,
    { pid: 9001, ppid: 1, start_identity: ROOT_START, command: "node /opt/app/ozon_24h_supervisor.mjs" },
    { pid: 9002, ppid: 1, start_identity: ROOT_START, command: `${AUDITED_BROWSER_EXECUTABLE} --user-data-dir=/Users/mac/.ozon-24h-production/state/profiles/production-playwright-151-v1 --remote-debugging-port=9223` },
    { pid: 9003, ppid: 1, start_identity: ROOT_START, command: "node /Users/mac/.ozon-24h-production/app/scripts/flow_b_playwright.mjs accept" },
    { pid: 9004, ppid: 1, start_identity: ROOT_START, command: "node /Users/mac/.ozon-24h-production/app/scripts/flow_b_playwright.mjs publish" },
  ];
  assert.deepEqual(productionRootPids(production), [9001, 9002, 9003, 9004]);
});

test("owned runner rejects startup timeout, rogue listener, multi-listener, and non-loopback binding with exact codes", async () => {
  const options = {
    userDataDir: AUDITED_VALIDATION_PROFILE,
    chromiumExecutable: AUDITED_BROWSER_EXECUTABLE,
    remoteDebuggingPort: AUDITED_VALIDATION_DEBUG_PORT,
  };
  const text = processRows().map((row) => `${row.pid} ${row.ppid} ${row.command}`).join("\n");
  let milliseconds = 0;
  await assert.rejects(waitForAuditedPortOwnedByBrowserRoot(
    { pid: ROOT_PID }, 9224, options, 100, {
      orchestratorPid: ORCHESTRATOR_PID,
      processList: async () => text,
      listenerPids: async () => [],
      now: () => milliseconds,
      delay: async (amount) => { milliseconds += amount; },
    },
  ), (error) => error.code === "AUDITED_PORT_LISTENER_START_TIMEOUT");
  await assert.rejects(waitForAuditedPortOwnedByBrowserRoot(
    { pid: ROOT_PID }, 9224, options, 100, {
      orchestratorPid: ORCHESTRATOR_PID,
      processList: async () => text,
      listenerPids: async () => [4999],
      now: () => 0,
      delay: async () => {},
    },
  ), (error) => error.code === "AUDITED_PORT_LISTENER_ROGUE");
  await assert.rejects(waitForAuditedPortOwnedByBrowserRoot(
    { pid: ROOT_PID }, 9224, options, 100, {
      orchestratorPid: ORCHESTRATOR_PID,
      processList: async () => text,
      listenerPids: async () => [LISTENER_PID, 4999],
      now: () => 0,
      delay: async () => {},
    },
  ), (error) => error.code === "AUDITED_PORT_LISTENER_COUNT_INVALID");
  await assert.rejects(waitForAuditedPortOwnedByBrowserRoot(
    { pid: ROOT_PID }, 9224, options, 100, {
      orchestratorPid: ORCHESTRATOR_PID,
      processList: async () => text,
      listenerAudit: async () => ({ pids: [LISTENER_PID], bindings: { [LISTENER_PID]: ["*:9224"] } }),
      now: () => 0,
      delay: async () => {},
    },
  ), (error) => error.code === "AUDITED_PORT_LISTENER_BIND_ADDRESS_INVALID");
  await assert.rejects(waitForAuditedPortOwnedByBrowserRoot(
    { pid: ROOT_PID }, 9224, options, 100, {
      orchestratorPid: ORCHESTRATOR_PID,
      processList: async () => text,
      listenerAudit: async () => ({
        pids: [LISTENER_PID],
        bindings: { [LISTENER_PID]: ["127.0.0.1:9224", "*:9224"] },
      }),
      now: () => 0,
      delay: async () => {},
    },
  ), (error) => error.code === "AUDITED_PORT_LISTENER_BIND_ADDRESS_INVALID");
});

test("fatal running sample aborts work, journals cleanup proof, and retains cross-referenced locks", async () => {
  const timeline = [];
  let cleanupCalls = 0;
  let bootoutCalls = 0;
  let retainedCalls = 0;
  let secondBusinessStage = false;
  const manifest = Object.freeze({ only: Object.freeze({
    sha256: "c".repeat(64), size: 1, exists: true, dev: 1, ino: 2, nlink: 1,
    mode: 0o100600, mtime_ms: 1, ctime_ms: 1,
  }) });
  const faultSample = (overrides = {}) => {
    const value = sample({ criticalDigests: manifest, ...overrides });
    return {
      ...value,
      orchestrator_pid: process.pid,
      process_rows: value.process_rows.map((row) => ({
        ...row,
        pid: row.pid === ORCHESTRATOR_PID ? process.pid : row.pid,
        ppid: row.ppid === ORCHESTRATOR_PID ? process.pid : row.ppid,
      })),
    };
  };
  let current = faultSample({ roots: false, listenerPids: [] });
  const output = await runAuditedSinglePageSmoke({
    runId: "fault-running-abort",
    expectedLaunchdBaselineMode: "bootout",
    dependencies: {
      createForensicRun: async () => ({
        append: async (row) => { timeline.push(row); return row; },
        finalize: async () => ({
          result_sha256: "d".repeat(64), timeline_sha256: "e".repeat(64), manifest_sha256: "f".repeat(64),
        }),
      }),
      hashManifest: async () => manifest,
      readLaunchState: async () => BOOTOUT,
      probe: async () => current,
      watcherOptions: { sampleIntervalMs: 5, delay: async () => {} },
      acquireInterlocks: async () => ({
        evidence: { cross_reference_exact: true },
        retainFailure: async () => { retainedCalls += 1; return { retained: true, cross_reference_exact: true }; },
        releaseSuccess: async () => { throw new Error("must not release on fatal"); },
      }),
      cleanupOwned9224: async () => {
        cleanupCalls += 1;
        current = faultSample({ roots: false, listenerPids: [], productionRoots: [] });
        return { exact_9224_cleanup_proven: true };
      },
      emergencyBootout: async () => { bootoutCalls += 1; return { production_bootout_proven: true }; },
      loadArtifact: async () => ({ artifact_sha256: "1".repeat(64), source_set_sha256: "2".repeat(64) }),
      runOwned: async (_options, operation, ownedDeps) => {
        await ownedDeps.lifecycle.emit({ phase: "bootstrap", state: "starting", network_gate: "host_resolver_offline", observer_coverage: "not_available_before_dnr" });
        current = faultSample();
        await ownedDeps.lifecycle.emit({ phase: "bootstrap", state: "listening", network_gate: "host_resolver_offline", observer_coverage: "not_available_before_dnr" });
        await ownedDeps.lifecycle.emit({ phase: "bootstrap", state: "closing", network_gate: "host_resolver_offline", observer_coverage: "not_available_before_dnr" });
        current = faultSample({ roots: false, listenerPids: [] });
        await ownedDeps.lifecycle.emit({ phase: "bootstrap", state: "stopped", network_gate: "persisted_dnr_lockdown", observer_coverage: "not_available_before_dnr" });
        await ownedDeps.lifecycle.emit({ phase: "operational", state: "starting", network_gate: "persisted_dnr_lockdown", observer_coverage: "not_available_before_dnr" });
        current = faultSample();
        await ownedDeps.lifecycle.emit({ phase: "operational", state: "listening", network_gate: "dnr_default_deny_and_context_route", observer_coverage: "all_contexts_continuous" });
        return operation({ context: {}, rateProvider: async () => ({}), accessController: {} });
      },
      runBusiness: async ({ recordAttempt, checkpoint }) => {
        await checkpoint("stage_one_pre");
        await recordAttempt("source_scan_requests");
        current = faultSample({ productionRoots: [9999] });
        await new Promise((resolve) => setTimeout(resolve, 25));
        await checkpoint("stage_two_pre");
        secondBusinessStage = true;
        return { outcome: "should_not_happen" };
      },
    },
  });
  assert.equal(output.status, "failed");
  assert.equal(output.failure_code, "WATCH_PRODUCTION_PROCESS_PRESENT", JSON.stringify(timeline, null, 2));
  assert.equal(output.operation_entered, true);
  assert.equal(output.business_calls.source_scan_requests, 1);
  assert.equal(output.business_calls.live_detail_requests, 0);
  assert.equal(secondBusinessStage, false);
  assert.equal(cleanupCalls, 2);
  assert.equal(bootoutCalls, 1);
  assert.equal(retainedCalls, 1);
  assert.equal(output.locks_retained, true);
  assert.ok(timeline.some((row) => row.decision_code === "WATCH_STOPPED_PROVED"));
  const initialized = timeline.find((row) => row.cause === "business_calls_initialized");
  assert.equal(initialized.operation_entered, false);
  assert.deepEqual(initialized.business_calls, {
    source_scan_requests: 0,
    live_detail_requests: 0,
    classification_requests: 0,
    favorite_mutation_attempts: 0,
    submission_attempts: 0,
  });
  assert.deepEqual(timeline.map((row) => row.monotonic_seq),
    Array.from({ length: timeline.length }, (_unused, index) => index));
});

test("fatal cleanup uses a fresh generation when a browser root appears after an early root-zero proof", async () => {
  const timeline = [];
  let cleanupCalls = 0;
  let current = sampleForCurrentProcess({ roots: false, listenerPids: [] });
  let resolveEarlyCleanup;
  const earlyCleanup = new Promise((resolve) => { resolveEarlyCleanup = resolve; });
  const manifest = Object.freeze({ only: Object.freeze({
    sha256: "c".repeat(64), size: 1, exists: true, dev: 1, ino: 2, nlink: 1,
    mode: 0o100600, mtime_ms: 1, ctime_ms: 1,
  }) });
  const output = await runAuditedSinglePageSmoke({
    runId: "late-root-fresh-cleanup-generation",
    expectedLaunchdBaselineMode: "bootout",
    dependencies: {
      createForensicRun: async () => ({
        append: async (row) => { timeline.push(row); return row; },
        finalize: async () => ({
          result_sha256: "d".repeat(64), timeline_sha256: "e".repeat(64), manifest_sha256: "f".repeat(64),
        }),
      }),
      hashManifest: async () => manifest,
      readLaunchState: async () => BOOTOUT,
      probe: async () => ({ ...current, critical_digests: manifest }),
      watcherOptions: { sampleIntervalMs: 60_000, delay: async () => {} },
      acquireInterlocks: async () => ({
        evidence: { cross_reference_exact: true },
        retainFailure: async () => ({ retained: true, cross_reference_exact: true }),
        releaseSuccess: async () => { throw new Error("must retain after fatal"); },
      }),
      cleanupOwned9224: async () => {
        cleanupCalls += 1;
        if (cleanupCalls === 1) {
          resolveEarlyCleanup();
          return { exact_9224_cleanup_proven: true };
        }
        return { exact_9224_cleanup_proven: false, final_root_count: 1, final_listener_count: 1 };
      },
      emergencyBootout: async () => ({ production_bootout_proven: true }),
      loadArtifact: async () => ({ artifact_sha256: "1".repeat(64), source_set_sha256: "2".repeat(64) }),
      runOwned: async (_options, operation) => {
        try {
          return await operation({ context: {}, rateProvider: async () => ({}), accessController: {} });
        } catch {
          await earlyCleanup;
          current = sampleForCurrentProcess();
          throw new Error("injected runner cleanup failure after late browser root");
        }
      },
      runBusiness: async ({ checkpoint }) => {
        current = sampleForCurrentProcess({ roots: false, listenerPids: [], productionRoots: [9999] });
        await checkpoint("fatal_before_validation_root");
        throw new Error("unreachable");
      },
    },
  });
  assert.equal(cleanupCalls, 2);
  assert.equal(output.status, "failed");
  assert.equal(output.failure_code, "SMOKE_EXACT_9224_CLEANUP_UNPROVEN");
  assert.equal(output.exact_9224_cleanup_proven, false);
  assert.equal(output.locks_retained, true);
  assert.equal(timeline.some((row) => row.decision_code === "WATCH_STOPPED_PROVED"), false);
});

test("secure forensic JSONL is hash-chained and rejects a new hard link before another durable append", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "audited-smoke-forensic-")));
  try {
    const first = await createAuditedSmokeForensicRun({ forensicRoot: temporary, runId: "hash-chain" });
    await first.append({ monotonic_seq: 1, decision_code: "WATCH_OK" });
    await first.append({ monotonic_seq: 2, decision_code: "WATCH_OK" });
    const digests = await first.finalize({ status: "failed", failure_code: "SMOKE_OPERATION_FAILED" });
    const lines = (await fs.readFile(first.timeline_file, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(lines[0].previous_record_hash, null);
    assert.equal(lines[1].previous_record_hash, lines[0].record_hash);
    for (const row of lines) {
      const { record_hash: recordHash, ...chained } = row;
      assert.equal(recordHash, crypto.createHash("sha256").update(JSON.stringify(chained)).digest("hex"));
    }
    assert.match(digests.result_sha256, /^[a-f0-9]{64}$/u);
    assert.match(digests.timeline_sha256, /^[a-f0-9]{64}$/u);
    assert.match(digests.manifest_sha256, /^[a-f0-9]{64}$/u);

    const second = await createAuditedSmokeForensicRun({ forensicRoot: temporary, runId: "hardlink" });
    await fs.link(second.timeline_file, path.join(second.directory, "timeline-alias.jsonl"));
    await assert.rejects(second.append({ monotonic_seq: 1 }), (error) => (
      error.code === "WATCH_FORENSIC_PERSISTENCE_FAILED"
    ));
    await second.abort();
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("production hash comparison permits only named interlock differences", () => {
  const before = {
    db: { sha256: "1".repeat(64), dev: 1, ino: 1 },
    production_interlock_owner: { exists: false },
  };
  const allowedAfter = {
    db: { sha256: "1".repeat(64), dev: 1, ino: 1 },
    production_interlock_owner: { exists: true },
  };
  assert.equal(compareProductionHashManifests(
    before,
    allowedAfter,
    ["production_interlock_owner"],
  ).exact_except_interlocks, true);
  assert.deepEqual(compareProductionHashManifests(
    before,
    { ...allowedAfter, db: { sha256: "2".repeat(64), dev: 1, ino: 1 } },
    ["production_interlock_owner"],
  ).forbidden_changed_names, ["db"]);
});

test("hash manifest streams bounded chunks beyond 2 GiB and fails closed on read or identity changes", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "audited-smoke-hash-stream-")));
  try {
    const sparse = path.join(temporary, "larger-than-two-gib.bin");
    const virtualSize = 2 * 1024 * 1024 * 1024 + 17;
    await fs.writeFile(sparse, "");
    await fs.truncate(sparse, virtualSize);
    let totalBytes = 0;
    let readCalls = 0;
    let maximumRead = 0;
    const streamed = await hashNamedFiles({ sparse }, {
      createHash: () => ({
        update: (chunk) => { totalBytes += chunk.length; },
        digest: () => "a".repeat(64),
      }),
      readChunk: async (_handle, _buffer, _offset, length) => {
        readCalls += 1;
        maximumRead = Math.max(maximumRead, length);
        return { bytesRead: length };
      },
    });
    assert.equal(streamed.sparse.size, virtualSize);
    assert.equal(streamed.sparse.sha256, "a".repeat(64));
    assert.equal(totalBytes, virtualSize);
    assert.ok(readCalls > 512);
    assert.ok(maximumRead <= 4 * 1024 * 1024);

    const stable = path.join(temporary, "stable.bin");
    await fs.writeFile(stable, "bounded-stream\n");
    const stableManifest = await hashNamedFiles({ stable });
    assert.equal(stableManifest.stable.sha256,
      crypto.createHash("sha256").update("bounded-stream\n").digest("hex"));

    const shortRead = path.join(temporary, "short-read.bin");
    const shortReadBytes = Buffer.from("0123456789", "utf8");
    await fs.writeFile(shortRead, shortReadBytes);
    const shortReadManifest = await hashNamedFiles({ shortRead }, {
      readChunk: async (handle, buffer, offset, length, position) => (
        handle.read(buffer, offset, Math.min(2, length), position)
      ),
    });
    assert.equal(shortReadManifest.shortRead.sha256,
      crypto.createHash("sha256").update(shortReadBytes).digest("hex"));

    let eofReads = 0;
    await assert.rejects(hashNamedFiles({ shortRead }, {
      readChunk: async (handle, buffer, offset, length, position) => {
        eofReads += 1;
        if (eofReads > 1) return { bytesRead: 0 };
        return handle.read(buffer, offset, Math.min(2, length), position);
      },
    }), (error) => error.code === "WATCH_CRITICAL_DIGEST_CHANGED");

    const changing = path.join(temporary, "changing.bin");
    await fs.writeFile(changing, "before");
    let changed = false;
    await assert.rejects(hashNamedFiles({ changing }, {
      readChunk: async (handle, buffer, offset, length, position) => {
        const result = await handle.read(buffer, offset, length, position);
        if (!changed) {
          changed = true;
          await fs.appendFile(changing, "-after");
        }
        return result;
      },
    }), (error) => error.code === "WATCH_CRITICAL_DIGEST_CHANGED");

    await assert.rejects(hashNamedFiles({ stable }, {
      readChunk: async () => { throw Object.assign(new Error("injected read failure"), { code: "EIO" }); },
    }), (error) => error.code === "SMOKE_HASH_MANIFEST_READ_FAILED");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("watcher reports durable persistence failure with the exact failed sample sequence", async () => {
  let writes = 0;
  const watcher = createAuditedSmokeWatcher({
    writer: {
      append: async () => {
        writes += 1;
        if (writes === 2) throw new Error("fault injected");
      },
    },
    probe: async () => sample({ roots: false, listenerPids: [] }),
    launchBaseline: BOOTOUT,
    criticalDigestBaseline: DIGESTS,
    orchestratorPid: ORCHESTRATOR_PID,
    onFatal: async () => true,
  });
  await watcher.ready();
  await assert.rejects(watcher.recordAuditEvent("fault"), (error) => (
    error instanceof AuditedSmokeFailure
      && error.code === "WATCH_FORENSIC_PERSISTENCE_FAILED"
      && Number.isInteger(error.failed_sample_seq)
  ));
  await assert.rejects(watcher.checkpoint("after_fault"), (error) => (
    error instanceof AuditedSmokeFailure
      && error.code === "WATCH_FORENSIC_PERSISTENCE_FAILED"
      && Number.isInteger(error.failed_sample_seq)
  ));
});

test("launchd collection accepts only explicit not-found as bootout and fails closed on audit errors", async () => {
  const notFound = Object.assign(new Error("not found"), { code: 113, stderr: "Could not find service" });
  assert.deepEqual(await readProductionLaunchdState({
    execute: async () => { throw notFound; },
  }), BOOTOUT);
  const denied = Object.assign(new Error("denied"), { code: 1, stderr: "Operation not permitted" });
  await assert.rejects(readProductionLaunchdState({
    execute: async () => { throw denied; },
  }), (error) => error.code === "WATCH_LAUNCH_BASELINE_CHANGED");
});

test("PID reuse and sampling gaps fail with exact watcher enums", async () => {
  const reusedRows = processRows().map((row) => row.pid === ROOT_PID
    ? { ...row, start_identity: "Wed Aug 19 21:00:01 2026" }
    : row);
  const reused = evaluateAuditedSmokeWatchSample({
    phase: "operational",
    state: "listening",
    sample: { ...sample(), process_rows: reusedRows },
    launchBaseline: BOOTOUT,
    criticalDigestBaseline: DIGESTS,
    orchestratorPid: ORCHESTRATOR_PID,
    orchestratorStartIdentity: ORCHESTRATOR_START,
    expectedRootIdentity: { pid: ROOT_PID, start_identity: ROOT_START },
    graceDeadlineMs: 10_000,
    nowMs: 1_000,
    observerCoverage: "all_contexts_continuous",
    networkGate: "dnr_default_deny_and_context_route",
  });
  assert.equal(reused.code, "WATCH_PROCESS_IDENTITY_CHANGED");

  let milliseconds = 0;
  const watcher = createAuditedSmokeWatcher({
    writer: { append: async () => true },
    probe: async () => sample({ roots: false, listenerPids: [] }),
    launchBaseline: BOOTOUT,
    criticalDigestBaseline: DIGESTS,
    orchestratorPid: ORCHESTRATOR_PID,
    monotonicNow: () => milliseconds,
    maxSampleGapMs: 2_500,
    onFatal: async () => true,
  });
  await watcher.ready();
  milliseconds = 3_000;
  await assert.rejects(watcher.checkpoint("late"), (error) => (
    error.code === "WATCH_SAMPLE_GAP_EXCEEDED"
  ));
});

test("exact 9224 cleanup revalidates lstart, exact command, and ancestry before TERM and KILL", async () => {
  const reusedStart = "Wed Aug 19 21:00:01 2026";
  const initialRows = processRows();
  const reusedRows = initialRows.map((row) => row.pid === ROOT_PID
    ? { ...row, ppid: 1, start_identity: reusedStart, command: "node unrelated-worker.mjs" }
    : row).filter((row) => row.pid !== LISTENER_PID);
  const asPs = (rows) => rows
    .map((row) => `${row.pid} ${row.ppid} ${row.start_identity} ${row.command}`)
    .join("\n");
  const processSnapshots = [
    asPs(initialRows),
    asPs(initialRows),
    asPs(reusedRows),
    asPs(reusedRows),
  ];
  const listenerSnapshots = [[LISTENER_PID], []];
  const signals = [];
  const evidence = await cleanupExactAudited9224({
    orchestratorPid: ORCHESTRATOR_PID,
    processList: async () => processSnapshots.shift() || asPs(reusedRows),
    listenerPids: async () => listenerSnapshots.shift() || [],
    signal: (pid, name) => { signals.push({ pid, name }); },
    graceMs: 0,
  });
  assert.deepEqual(signals, [{ pid: ROOT_PID, name: "SIGTERM" }]);
  assert.equal(evidence.pid_reuse_suppressed_count, 1);
  assert.equal(evidence.exact_9224_cleanup_proven, true);
  assert.equal(evidence.final_root_count, 0);
  assert.equal(evidence.final_listener_count, 0);

  const reusedBeforeTerm = [
    asPs(initialRows),
    asPs(reusedRows),
    asPs(reusedRows),
    asPs(reusedRows),
  ];
  const suppressedSignals = [];
  const suppressed = await cleanupExactAudited9224({
    orchestratorPid: ORCHESTRATOR_PID,
    processList: async () => reusedBeforeTerm.shift() || asPs(reusedRows),
    listenerPids: (() => {
      const snapshots = [[LISTENER_PID], []];
      return async () => snapshots.shift() || [];
    })(),
    signal: (pid, name) => { suppressedSignals.push({ pid, name }); },
    graceMs: 0,
  });
  assert.deepEqual(suppressedSignals, []);
  assert.equal(suppressed.pid_reuse_suppressed_count, 2);
  assert.equal(suppressed.exact_9224_cleanup_proven, true);
});

test("partial acquisition and partial release report exact interlock evidence without claiming both retained", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "audited-smoke-locks-")));
  try {
    const productionParent = path.join(temporary, "production-state");
    const validationParent = path.join(temporary, "validation-state");
    await fs.mkdir(productionParent);
    await fs.mkdir(validationParent);
    const productionLockDirectory = path.join(productionParent, "supervisor.lock");
    const validationLockFile = path.join(validationParent, "smoke-owner.json");
    let partialError;
    try {
      await acquireAuditedSmokeInterlocks({
        runId: "partial-acquire",
        productionLockDirectory,
        validationLockFile,
        afterProductionLock: async () => { throw new Error("fault after production lock"); },
      });
    } catch (error) { partialError = error; }
    assert.ok(partialError?.interlocks);
    assert.equal(partialError.interlock_evidence.production_lock_owned, true);
    assert.equal(partialError.interlock_evidence.validation_lock_present, false);
    assert.equal(partialError.interlock_evidence.retained, false);
    const retainedPartial = await partialError.interlocks.retainFailure(
      "SMOKE_LOCK_ACQUIRE_FAILED",
      null,
      { exact_9224_cleanup_proven: true },
    );
    assert.equal(retainedPartial.production_lock_owned, true);
    assert.equal(retainedPartial.validation_lock_owned, false);
    assert.equal(retainedPartial.retained, false);

    await fs.rm(productionLockDirectory, { recursive: true, force: true });
    const complete = await acquireAuditedSmokeInterlocks({
      runId: "partial-release",
      productionLockDirectory,
      validationLockFile,
      unlinkFile: (() => {
        let calls = 0;
        return async (filename) => {
          calls += 1;
          if (calls === 2) throw new Error("fault before production owner unlink");
          await fs.unlink(filename);
        };
      })(),
    });
    await assert.rejects(complete.releaseSuccess(), (error) => {
      assert.equal(error.interlock_evidence.production_lock_owned, true);
      assert.equal(error.interlock_evidence.validation_lock_present, false);
      assert.equal(error.interlock_evidence.retained, false);
      return true;
    });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("CLI is inert without the explicit execute flag", async () => {
  assert.deepEqual(await runAuditedSinglePageSmokeCli([]), {
    contract: "ozon-audited-single-page-smoke-v1",
    status: "not_executed",
    execution_requires_explicit_flag: true,
  });
});

test("launchd CLI pins canonical counters and loaded mode requires exact runs and last exit", async () => {
  assert.deepEqual(parseAuditedSinglePageSmokeArgs([
    "--execute",
    "--run-id", "loaded-pins",
    "--launchd-baseline", "loaded_not_running",
    "--launchd-runs", "17",
    "--launchd-last-exit-code", "0",
  ]), {
    execute: true,
    runId: "loaded-pins",
    launchdBaseline: "loaded_not_running",
    launchdRuns: 17,
    launchdLastExitCode: 0,
  });
  for (const invalid of ["-1", "+1", "1.0", "01", "9007199254740992"]) {
    assert.throws(() => parseAuditedSinglePageSmokeArgs([
      "--launchd-runs", invalid,
    ]), (error) => error.code === "SMOKE_OPERATION_FAILED");
  }
  assert.throws(() => parseAuditedSinglePageSmokeArgs([
    "--launchd-runs", "1", "--launchd-runs", "2",
  ]), (error) => error.code === "SMOKE_OPERATION_FAILED");
  await assert.rejects(runAuditedSinglePageSmoke({
    runId: "loaded-missing-pins",
    expectedLaunchdBaselineMode: "loaded_not_running",
  }), (error) => error.code === "SMOKE_OPERATION_FAILED");
  await assert.rejects(runAuditedSinglePageSmoke({
    runId: "bootout-with-loaded-pins",
    expectedLaunchdBaselineMode: "bootout",
    expectedLaunchdRuns: 0,
    expectedLaunchdLastExitCode: 0,
  }), (error) => error.code === "SMOKE_OPERATION_FAILED");
  assert.equal(launchBaselineAllowed(BOOTOUT, "bootout"), true);
  assert.equal(launchBaselineAllowed(LOADED_NOT_RUNNING, "loaded_not_running", {
    expectedRuns: 17,
    expectedLastExitCode: 0,
  }), true);
  assert.equal(launchBaselineAllowed(LOADED_NOT_RUNNING, "loaded_not_running", {
    expectedRuns: 16,
    expectedLastExitCode: 0,
  }), false);
  assert.equal(launchBaselineAllowed(LOADED_NOT_RUNNING, "loaded_not_running", {
    expectedRuns: 17,
    expectedLastExitCode: 1,
  }), false);
  assert.equal(launchBaselineAllowed({
    ...LOADED_NOT_RUNNING,
    runs: "017",
  }, "loaded_not_running", {
    expectedRuns: 17,
    expectedLastExitCode: 0,
  }), false);
});

test("loaded-not-running full fake succeeds only with exact launchd counters", async () => {
  const timeline = [];
  let current = sampleForCurrentProcess({ roots: false, listenerPids: [] });
  let launchReads = 0;
  const manifest = Object.freeze({ only: Object.freeze({
    sha256: "c".repeat(64), size: 1, exists: true, dev: 1, ino: 2, nlink: 1,
    mode: 0o100600, mtime_ms: 1, ctime_ms: 1,
  }) });
  const withManifest = (value) => ({
    ...value,
    launch: LOADED_NOT_RUNNING,
    critical_digests: manifest,
  });
  const noBrowser = () => withManifest(sampleForCurrentProcess({ roots: false, listenerPids: [] }));
  const browser = () => withManifest(sampleForCurrentProcess());
  const output = await runAuditedSinglePageSmoke({
    runId: "loaded-full-fake-success",
    expectedLaunchdBaselineMode: "loaded_not_running",
    expectedLaunchdRuns: 17,
    expectedLaunchdLastExitCode: 0,
    dependencies: {
      createForensicRun: async () => ({
        append: async (row) => { timeline.push(row); return row; },
        finalize: async () => ({
          result_sha256: "d".repeat(64), timeline_sha256: "e".repeat(64), manifest_sha256: "f".repeat(64),
        }),
        commitRelease: async () => ({ release_commit_sha256: "9".repeat(64) }),
      }),
      hashManifest: async () => manifest,
      readLaunchState: async () => { launchReads += 1; return LOADED_NOT_RUNNING; },
      probe: async () => withManifest(current),
      watcherOptions: { sampleIntervalMs: 60_000, delay: async () => {} },
      acquireInterlocks: async () => ({
        evidence: { cross_reference_exact: true },
        exactEvidence: async () => ({ retained: true, cross_reference_exact: true }),
        retainFailure: async () => ({ retained: true, cross_reference_exact: true }),
        releaseSuccess: async () => ({ released: true }),
      }),
      cleanupOwned9224: async () => ({ exact_9224_cleanup_proven: true }),
      emergencyBootout: async () => ({ production_bootout_proven: true }),
      loadArtifact: async () => ({ artifact_sha256: "1".repeat(64), source_set_sha256: "2".repeat(64) }),
      runOwned: async (_options, operation, ownedDeps) => {
        await ownedDeps.lifecycle.emit({
          phase: "bootstrap", state: "starting", network_gate: "host_resolver_offline",
          observer_coverage: "not_available_before_dnr",
        });
        current = browser();
        await ownedDeps.lifecycle.emit({
          phase: "bootstrap", state: "listening", network_gate: "host_resolver_offline",
          observer_coverage: "not_available_before_dnr",
        });
        await ownedDeps.lifecycle.emit({
          phase: "bootstrap", state: "closing", network_gate: "host_resolver_offline",
          observer_coverage: "not_available_before_dnr",
        });
        current = noBrowser();
        await ownedDeps.lifecycle.emit({
          phase: "bootstrap", state: "stopped", network_gate: "persisted_dnr_lockdown",
          observer_coverage: "not_available_before_dnr",
        });
        await ownedDeps.lifecycle.emit({
          phase: "operational", state: "starting", network_gate: "persisted_dnr_lockdown",
          observer_coverage: "not_available_before_dnr",
        });
        current = browser();
        await ownedDeps.lifecycle.emit({
          phase: "operational", state: "listening", network_gate: "dnr_default_deny_and_context_route",
          observer_coverage: "all_contexts_continuous",
        });
        const value = await operation({ context: {}, rateProvider: async () => ({}), accessController: {} });
        await ownedDeps.lifecycle.emit({
          phase: "operational", state: "listening", network_gate: "dnr_default_deny_and_context_route",
          observer_coverage: "all_contexts_continuous", mutation_zero_proven: true,
          mutation_attempts_observed: 0,
        });
        await ownedDeps.lifecycle.emit({ phase: "operational", state: "closing" });
        current = noBrowser();
        await ownedDeps.lifecycle.emit({ phase: "operational", state: "stopped" });
        return { value, network_safety: completeScopedNetworkSafety() };
      },
      runBusiness: async ({ recordAttempt }) => {
        await recordAttempt("source_scan_requests");
        return { outcome: "no_eligible_card", eligible: false, reason: "no_eligible_card" };
      },
    },
  });
  assert.equal(output.status, "passed", JSON.stringify(timeline, null, 2));
  assert.equal(output.launch_baseline_expected_runs, 17);
  assert.equal(output.launch_baseline_expected_last_exit_code, 0);
  assert.equal(output.operational_post_observer_mutation_zero_proven, true);
  assert.equal(output.offline_gate_proven, true);
  assert.equal(launchReads, 3);
});

test("fake-owned full success writes chained forensic artifacts and releases both real temporary interlocks", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "audited-smoke-success-")));
  try {
    const forensicRoot = path.join(temporary, "forensics");
    const productionParent = path.join(temporary, "production-state");
    const validationParent = path.join(temporary, "validation-state");
    await fs.mkdir(forensicRoot);
    await fs.mkdir(productionParent);
    await fs.mkdir(validationParent);
    const productionLockDirectory = path.join(productionParent, "supervisor.lock");
    const validationLockFile = path.join(validationParent, "smoke-owner.json");
    const fixture = path.join(temporary, "fixture.txt");
    await fs.writeFile(fixture, "stable\n");
    const criticalFiles = { fixture };
    const criticalManifest = await hashNamedFiles(criticalFiles);
    const productionHashFiles = {
      fixture,
      production_interlock_owner: path.join(productionLockDirectory, "owner.json"),
      validation_smoke_lock: validationLockFile,
    };
    let current = sampleForCurrentProcess({
      roots: false,
      listenerPids: [],
      criticalDigests: criticalManifest,
    });
    const noBrowser = () => sampleForCurrentProcess({
      roots: false,
      listenerPids: [],
      criticalDigests: criticalManifest,
    });
    const browser = () => sampleForCurrentProcess({ criticalDigests: criticalManifest });
    let launchReads = 0;
    const output = await runAuditedSinglePageSmoke({
      runId: "fake-owned-success",
      expectedLaunchdBaselineMode: "bootout",
      forensicRoot,
      criticalFiles,
      productionHashFiles,
      dependencies: {
        readLaunchState: async () => { launchReads += 1; return BOOTOUT; },
        probe: async () => current,
        watcherOptions: { sampleIntervalMs: 60_000, delay: async () => {} },
        acquireInterlocks: (request) => acquireAuditedSmokeInterlocks({
          ...request,
          productionLockDirectory,
          validationLockFile,
        }),
        cleanupOwned9224: async () => ({ exact_9224_cleanup_proven: true }),
        emergencyBootout: async () => ({ production_bootout_proven: true }),
        loadArtifact: async () => ({ artifact_sha256: "1".repeat(64), source_set_sha256: "2".repeat(64) }),
        runOwned: async (_options, operation, ownedDeps) => {
          await ownedDeps.lifecycle.emit({ phase: "bootstrap", state: "starting", network_gate: "host_resolver_offline", observer_coverage: "not_available_before_dnr" });
          current = browser();
          await ownedDeps.lifecycle.emit({ phase: "bootstrap", state: "listening", network_gate: "host_resolver_offline", observer_coverage: "not_available_before_dnr" });
          await ownedDeps.lifecycle.emit({ phase: "bootstrap", state: "closing", network_gate: "host_resolver_offline", observer_coverage: "not_available_before_dnr" });
          current = noBrowser();
          await ownedDeps.lifecycle.emit({ phase: "bootstrap", state: "stopped", network_gate: "persisted_dnr_lockdown", observer_coverage: "not_available_before_dnr" });
          await ownedDeps.lifecycle.emit({ phase: "operational", state: "starting", network_gate: "persisted_dnr_lockdown", observer_coverage: "not_available_before_dnr" });
          current = browser();
          await ownedDeps.lifecycle.emit({ phase: "operational", state: "listening", network_gate: "persisted_dnr_lockdown", observer_coverage: "not_available_before_dnr" });
          await ownedDeps.lifecycle.emit({ phase: "operational", state: "listening", network_gate: "dnr_default_deny_and_context_route", observer_coverage: "all_contexts_continuous" });
          const value = await operation({ context: {}, rateProvider: async () => ({}), accessController: {} });
          await ownedDeps.lifecycle.emit({ phase: "operational", state: "listening", network_gate: "dnr_default_deny_and_context_route", observer_coverage: "all_contexts_continuous", mutation_zero_proven: true, mutation_attempts_observed: 0 });
          await ownedDeps.lifecycle.emit({ phase: "operational", state: "closing" });
          current = noBrowser();
          await ownedDeps.lifecycle.emit({ phase: "operational", state: "stopped" });
          return {
            value,
            request_firewall: { protected_analytics_upload_attempts_observed: 0 },
            network_safety: completeScopedNetworkSafety(),
          };
        },
        runBusiness: async ({ recordAttempt, checkpoint }) => {
          await checkpoint("scan_pre");
          await recordAttempt("source_scan_requests");
          await checkpoint("detail_pre");
          await recordAttempt("live_detail_requests");
          await checkpoint("classification_pre");
          await recordAttempt("classification_requests");
          return {
            outcome: "eligible",
            eligible: true,
            reason: null,
            eligible_card_count: 3,
            artifact_sha256: "1".repeat(64),
            source_sha256: "3".repeat(64),
            selected_binding_sha256: "4".repeat(64),
          };
        },
      },
    });
    assert.equal(output.status, "passed");
    assert.equal(output.lock_release_state, "released_after_forensic_finalize");
    assert.equal(output.locks_retained, false);
    assert.equal(launchReads, 3);
    assert.equal(output.operational_post_observer_mutation_zero_proven, true);
    assert.equal(output.offline_gate_proven, true);
    assert.equal(output.observer_heartbeat_interval_ms, 5_000);
    assert.equal(output.observer_heartbeat_successful_pings, 7);
    assert.equal(output.observer_heartbeat_continuous, true);
    assert.equal(output.observer_heartbeat_network_requests, 0);
    assert.equal(output.analytics_upload_attempts, 0);
    assert.equal(output.all_contexts_state_mutation_attempts, 0);
    assert.equal(output.service_worker_state_mutation_attempts, 0);
    assert.equal(output.bootstrap_pre_observer_attempt_coverage, "offline-gate-only-no-attempt-observer");
    assert.equal(Object.hasOwn(output, "mutation_zero_proven"), false);
    assert.deepEqual(output.business_calls, {
      source_scan_requests: 1,
      live_detail_requests: 1,
      classification_requests: 1,
      favorite_mutation_attempts: 0,
      submission_attempts: 0,
    });
    await assert.rejects(fs.access(productionLockDirectory));
    await assert.rejects(fs.access(validationLockFile));
    const runDirectory = path.join(forensicRoot, "fake-owned-success");
    const timeline = (await fs.readFile(path.join(runDirectory, "timeline.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.ok(timeline.length > 10);
    for (let index = 0; index < timeline.length; index += 1) {
      assert.equal(timeline[index].previous_record_hash, index === 0 ? null : timeline[index - 1].record_hash);
    }
    const manifest = JSON.parse(await fs.readFile(path.join(runDirectory, "manifest.json"), "utf8"));
    const persistedResult = JSON.parse(await fs.readFile(path.join(runDirectory, "result.json"), "utf8"));
    const resultBytes = await fs.readFile(path.join(runDirectory, "result.json"));
    assert.equal(manifest.result_sha256, crypto.createHash("sha256").update(resultBytes).digest("hex"));
    assert.equal(persistedResult.lock_release_state, "pending_after_forensic_finalize");
    assert.equal(persistedResult.locks_retained, true);
    const releaseCommit = JSON.parse(await fs.readFile(path.join(runDirectory, "release-commit.json"), "utf8"));
    assert.equal(releaseCommit.status, "released");
    assert.equal(releaseCommit.manifest_sha256, output.manifest_sha256);
    assert.deepEqual(releaseCommit.launch_before_release, BOOTOUT);
    assert.deepEqual(releaseCommit.launch_after_release, BOOTOUT);
    assert.match(output.manifest_sha256, /^[a-f0-9]{64}$/u);
    assert.match(output.release_commit_sha256, /^[a-f0-9]{64}$/u);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("forensic finalize failure performs fatal containment and retains locks before any release", async () => {
  let releaseCalls = 0;
  let retainCalls = 0;
  let bootoutCalls = 0;
  const manifest = Object.freeze({ only: Object.freeze({
    sha256: "c".repeat(64), size: 1, exists: true, dev: 1, ino: 2, nlink: 1,
    mode: 0o100600, mtime_ms: 1, ctime_ms: 1,
  }) });
  const watcher = {
    sequence: 7,
    operation_entered: false,
    lifecycle: { emit: async () => true },
    ready: async () => true,
    start: () => true,
    recordAuditEvent: async () => true,
    markOperationEntered: async () => { watcher.operation_entered = true; },
    recordBusinessAttempt: async () => true,
    checkpoint: async () => true,
    persistEvidence: async () => true,
    stop: async () => true,
    snapshot: () => ({ operation_entered: watcher.operation_entered }),
  };
  await assert.rejects(runAuditedSinglePageSmoke({
    runId: "finalize-failure-retains-locks",
    expectedLaunchdBaselineMode: "bootout",
    dependencies: {
      createForensicRun: async () => ({
        append: async () => true,
        finalize: async () => { throw new Error("injected final fsync failure"); },
      }),
      hashManifest: async () => manifest,
      readLaunchState: async () => BOOTOUT,
      probe: async () => sampleForCurrentProcess({ roots: false, listenerPids: [], criticalDigests: manifest }),
      createWatcher: () => watcher,
      acquireInterlocks: async () => ({
        evidence: { cross_reference_exact: true },
        exactEvidence: async () => ({ retained: true, cross_reference_exact: true }),
        releaseSuccess: async () => { releaseCalls += 1; return { released: true }; },
        retainFailure: async () => { retainCalls += 1; return { retained: true, cross_reference_exact: true }; },
      }),
      cleanupOwned9224: async () => ({ exact_9224_cleanup_proven: true }),
      emergencyBootout: async () => { bootoutCalls += 1; return { production_bootout_proven: true }; },
      loadArtifact: async () => ({ artifact_sha256: "1".repeat(64), source_set_sha256: "2".repeat(64) }),
      runOwned: async (_options, operation) => ({
        value: await operation({ context: {}, rateProvider: async () => ({}), accessController: {} }),
        request_firewall: { protected_analytics_upload_attempts_observed: 0 },
        network_safety: completeScopedNetworkSafety(),
      }),
      runBusiness: async () => ({ outcome: "ineligible", eligible: false, reason: "fixture" }),
    },
  }), (error) => error.code === "WATCH_FORENSIC_PERSISTENCE_FAILED");
  assert.equal(releaseCalls, 0);
  assert.equal(retainCalls, 1);
  assert.equal(bootoutCalls, 1);
});

test("failure before operation persists zero calls and retains both real temporary interlocks", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "audited-smoke-preop-fail-")));
  try {
    const forensicRoot = path.join(temporary, "forensics");
    const productionParent = path.join(temporary, "production-state");
    const validationParent = path.join(temporary, "validation-state");
    await fs.mkdir(forensicRoot);
    await fs.mkdir(productionParent);
    await fs.mkdir(validationParent);
    const productionLockDirectory = path.join(productionParent, "supervisor.lock");
    const validationLockFile = path.join(validationParent, "smoke-owner.json");
    const fixture = path.join(temporary, "fixture.txt");
    await fs.writeFile(fixture, "stable\n");
    const criticalFiles = { fixture };
    const criticalManifest = await hashNamedFiles(criticalFiles);
    const productionHashFiles = {
      fixture,
      production_interlock_owner: path.join(productionLockDirectory, "owner.json"),
      validation_smoke_lock: validationLockFile,
    };
    const current = sampleForCurrentProcess({ roots: false, listenerPids: [], criticalDigests: criticalManifest });
    const output = await runAuditedSinglePageSmoke({
      runId: "fake-owned-preop-failure",
      expectedLaunchdBaselineMode: "bootout",
      forensicRoot,
      criticalFiles,
      productionHashFiles,
      dependencies: {
        readLaunchState: async () => BOOTOUT,
        probe: async () => current,
        watcherOptions: { sampleIntervalMs: 60_000, delay: async () => {} },
        acquireInterlocks: (request) => acquireAuditedSmokeInterlocks({
          ...request,
          productionLockDirectory,
          validationLockFile,
        }),
        cleanupOwned9224: async () => ({ exact_9224_cleanup_proven: true }),
        emergencyBootout: async () => ({ production_bootout_proven: true }),
        loadArtifact: async () => ({ artifact_sha256: "1".repeat(64), source_set_sha256: "2".repeat(64) }),
        runOwned: async (_options, _operation, ownedDeps) => {
          await ownedDeps.lifecycle.emit({ phase: "bootstrap", state: "starting", network_gate: "host_resolver_offline", observer_coverage: "not_available_before_dnr" });
          throw new AuditedSmokeFailure("SMOKE_OPERATION_FAILED", null, "injected before operation");
        },
        runBusiness: async () => { throw new Error("must not enter business callback"); },
      },
    });
    assert.equal(output.status, "failed");
    assert.equal(output.operation_entered, false);
    assert.deepEqual(output.business_calls, {
      source_scan_requests: 0,
      live_detail_requests: 0,
      classification_requests: 0,
      favorite_mutation_attempts: 0,
      submission_attempts: 0,
    });
    assert.equal(output.locks_retained, true);
    await fs.access(path.join(productionLockDirectory, "owner.json"));
    await fs.access(validationLockFile);
    const result = JSON.parse(await fs.readFile(
      path.join(forensicRoot, "fake-owned-preop-failure", "result.json"),
      "utf8",
    ));
    assert.equal(result.status, "failed");
    assert.equal(result.operation_entered, false);
    assert.equal(result.business_calls.source_scan_requests, 0);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("granular extension postflight failure preserves phase and occurrence sequence in all artifacts", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "audited-smoke-preflight-code-")));
  const secretSentinel = "secret-token-header-body-query-sentinel";
  const secretDigest = crypto.createHash("sha256").update(secretSentinel).digest("hex");
  try {
    const forensicRoot = path.join(temporary, "forensics");
    const productionParent = path.join(temporary, "production-state");
    const validationParent = path.join(temporary, "validation-state");
    await fs.mkdir(forensicRoot);
    await fs.mkdir(productionParent);
    await fs.mkdir(validationParent);
    const productionLockDirectory = path.join(productionParent, "supervisor.lock");
    const productionOwner = path.join(productionLockDirectory, "owner.json");
    const validationLockFile = path.join(validationParent, "smoke-owner.json");
    const fixture = path.join(temporary, "fixture.txt");
    await fs.writeFile(fixture, "stable\n");
    const criticalFiles = { fixture };
    const criticalManifest = await hashNamedFiles(criticalFiles);
    const productionHashFiles = {
      fixture,
      production_interlock_owner: productionOwner,
      validation_smoke_lock: validationLockFile,
    };
    let current = sampleForCurrentProcess({ roots: false, listenerPids: [], criticalDigests: criticalManifest });
    const code = AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST;
    const output = await runAuditedSinglePageSmoke({
      runId: "fake-owned-granular-preflight-failure",
      expectedLaunchdBaselineMode: "bootout",
      forensicRoot,
      criticalFiles,
      productionHashFiles,
      dependencies: {
        readLaunchState: async () => BOOTOUT,
        probe: async () => current,
        watcherOptions: { sampleIntervalMs: 60_000, delay: async () => {} },
        acquireInterlocks: (request) => acquireAuditedSmokeInterlocks({
          ...request,
          productionLockDirectory,
          validationLockFile,
        }),
        cleanupOwned9224: async () => {
          current = sampleForCurrentProcess({ roots: false, listenerPids: [], criticalDigests: criticalManifest });
          return { exact_9224_cleanup_proven: true };
        },
        emergencyBootout: async () => ({ production_bootout_proven: true }),
        loadArtifact: async () => ({ artifact_sha256: "1".repeat(64), source_set_sha256: "2".repeat(64) }),
        runOwned: async (_options, operation, ownedDeps) => {
          await ownedDeps.lifecycle.emit({
            phase: "bootstrap", state: "starting", cause: "bootstrap_launch_armed",
            network_gate: "host_resolver_offline", observer_coverage: "not_available_before_dnr",
          });
          current = sampleForCurrentProcess({ criticalDigests: criticalManifest });
          await ownedDeps.lifecycle.emit({
            phase: "bootstrap", state: "listening", cause: "bootstrap_listener_owned",
            network_gate: "host_resolver_offline", observer_coverage: "not_available_before_dnr",
          });
          await ownedDeps.lifecycle.emit({
            phase: "bootstrap", state: "closing", cause: "bootstrap_close_armed",
            network_gate: "host_resolver_offline", observer_coverage: "not_available_before_dnr",
          });
          current = sampleForCurrentProcess({ roots: false, listenerPids: [], criticalDigests: criticalManifest });
          await ownedDeps.lifecycle.emit({
            phase: "bootstrap", state: "stopped", cause: "bootstrap_stopped",
            network_gate: "persisted_dnr_lockdown", observer_coverage: "not_available_before_dnr",
          });
          await ownedDeps.lifecycle.emit({
            phase: "operational", state: "starting", cause: "operational_launch_armed",
            network_gate: "persisted_dnr_lockdown", observer_coverage: "not_available_before_dnr",
          });
          current = sampleForCurrentProcess({ criticalDigests: criticalManifest });
          await ownedDeps.lifecycle.emit({
            phase: "operational", state: "listening", cause: "operational_observer_bound",
            network_gate: "dnr_default_deny_and_context_route", observer_coverage: "all_contexts_continuous",
          });
          await operation(Object.freeze({
            context: Object.freeze({}),
            rateProvider: Object.freeze({}),
            accessController: Object.freeze({}),
          }));
          await ownedDeps.lifecycle.emit({
            phase: "operational", state: "listening", cause: "operational_postflight_failed",
            failure_code: code,
            preflight_step: "web_request_observer_continuity",
            audit_phase: "postflight",
            failure_occurrence: "postflight",
            bootstrap_lockdown_proven: true,
            observer_was_bound: true,
            dnr_rules_exact: true,
            dnr_rule_set_sha256: "a".repeat(64),
            network_gate: "dnr_default_deny_and_context_route",
            observer_coverage: "observer_was_bound_pre_failure",
          });
          const safeError = new Error(secretSentinel);
          safeError.code = code;
          safeError.failure_code = code;
          safeError.preflight_step = "web_request_observer_continuity";
          safeError.audit_phase = "postflight";
          safeError.preflight_evidence = {
            bootstrap_lockdown_proven: true,
            observer_was_bound: true,
            dnr_rules_exact: true,
            dnr_rule_set_sha256: "a".repeat(64),
            raw_secret: secretSentinel,
          };
          throw new AggregateError([safeError, new Error(secretSentinel)], secretSentinel);
        },
        runBusiness: async ({ recordAttempt }) => {
          await recordAttempt("source_scan_requests");
          return { outcome: "read_only_scan_completed", eligible: false, reason: "postflight_pending" };
        },
      },
    });
    assert.equal(output.status, "failed");
    assert.equal(output.failure_code, code);
    assert.equal(output.preflight_step, "web_request_observer_continuity");
    assert.equal(output.audit_phase, "postflight");
    assert.deepEqual(output.preflight_evidence, {
      bootstrap_lockdown_proven: true,
      observer_was_bound: true,
      dnr_rules_exact: true,
      dnr_rule_set_sha256: "a".repeat(64),
    });
    assert.equal(output.offline_gate_proven, true);
    assert.equal(output.operation_entered, true);
    assert.equal(output.business_calls.source_scan_requests, 1);
    assert.equal(output.analytics_upload_attempts, null);
    assert.equal(output.all_contexts_state_mutation_attempts, null);
    assert.equal(output.service_worker_state_mutation_attempts, null);
    assert.equal(output.locks_retained, true);

    const runDirectory = path.join(forensicRoot, "fake-owned-granular-preflight-failure");
    const timeline = (await fs.readFile(path.join(runDirectory, "timeline.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    const failureRow = timeline.find((row) => row.cause === "operational_postflight_failed");
    assert.equal(failureRow.state, "listening");
    assert.equal(failureRow.failure_code, code);
    assert.equal(failureRow.preflight_step, "web_request_observer_continuity");
    assert.equal(failureRow.audit_phase, "postflight");
    assert.equal(output.failed_sample_seq, failureRow.monotonic_seq);
    assert.equal(timeline.filter((row) => row.monotonic_seq > failureRow.monotonic_seq)
      .some((row) => Object.hasOwn(row, "failure_code")), false);
    assert.equal(timeline.some((row) => row.decision_code === "WATCH_STATE_TRANSITION_INVALID"), false);

    for (const owner of [productionOwner, validationLockFile]) {
      const document = JSON.parse(await fs.readFile(owner, "utf8"));
      assert.equal(document.failure_code, code);
      assert.equal(document.preflight_step, "web_request_observer_continuity");
      assert.equal(document.audit_phase, "postflight");
      assert.equal(document.failed_sample_seq, failureRow.monotonic_seq);
      assert.equal(document.status, "retained_after_failure");
    }
    const artifactText = (await Promise.all([
      "timeline.jsonl", "result.json", "manifest.json", "manifest.sha256.json",
    ].map((filename) => fs.readFile(path.join(runDirectory, filename), "utf8"))))
      .join("\n") + await fs.readFile(productionOwner, "utf8") + await fs.readFile(validationLockFile, "utf8");
    assert.equal(artifactText.includes(secretSentinel), false);
    assert.equal(artifactText.includes(secretDigest), false);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("fake-owned webRequest smoke failure preserves only catalog-bound probe evidence across the exact failure chain", async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "audited-smoke-probe-fail-")));
  const secretSentinel = "secret-url-query-request-id-audit-smoke-token-header-raw-error-sentinel";
  const secretDigest = crypto.createHash("sha256").update(secretSentinel).digest("hex");
  try {
    const forensicRoot = path.join(temporary, "forensics");
    const productionParent = path.join(temporary, "production-state");
    const validationParent = path.join(temporary, "validation-state");
    await fs.mkdir(forensicRoot);
    await fs.mkdir(productionParent);
    await fs.mkdir(validationParent);
    const productionLockDirectory = path.join(productionParent, "supervisor.lock");
    const productionOwner = path.join(productionLockDirectory, "owner.json");
    const validationLockFile = path.join(validationParent, "smoke-owner.json");
    const fixture = path.join(temporary, "fixture.txt");
    await fs.writeFile(fixture, "stable\n");
    const criticalFiles = { fixture };
    const criticalManifest = await hashNamedFiles(criticalFiles);
    const productionHashFiles = {
      fixture,
      production_interlock_owner: productionOwner,
      validation_smoke_lock: validationLockFile,
    };
    const expectedCount = AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG.length;
    const requestedHttp = AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG
      .filter((descriptor) => descriptor.requested_scheme === "http").length;
    const requestedHttps = expectedCount - requestedHttp;
    const unsafeSmokeEvidence = Object.freeze({
      smoke_probe_catalog_sha256: AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG_SHA256,
      smoke_probe_expected_count: expectedCount,
      smoke_probe_observed_count: expectedCount - 1,
      smoke_probe_missing: Object.freeze([Object.freeze({
        probe_id: "p16",
        kind: secretSentinel,
        requested_scheme: secretSentinel,
        observed_schemes: Object.freeze(["https"]),
        url: secretSentinel,
        query: secretSentinel,
        request_id: secretSentinel,
      })]),
      smoke_probe_scheme_counts: Object.freeze({
        requested_http: requestedHttp,
        requested_https: requestedHttps,
        observed_http: requestedHttp - 1,
        observed_https: requestedHttps + 1,
        http_to_https: 1,
        raw_url: secretSentinel,
      }),
      smoke_probe_duplicate_request_count: 0,
      smoke_probe_drain_elapsed_ms: 750,
      smoke_probe_drain_timed_out: true,
      url: secretSentinel,
      query: secretSentinel,
      requestId: secretSentinel,
      auditNonce: secretSentinel,
      smokeNonce: secretSentinel,
      token: secretSentinel,
      header: secretSentinel,
      raw_error: secretSentinel,
    });
    const expectedSmokeEvidence = Object.freeze({
      smoke_probe_catalog_sha256: AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG_SHA256,
      smoke_probe_expected_count: expectedCount,
      smoke_probe_observed_count: expectedCount - 1,
      smoke_probe_missing: Object.freeze([Object.freeze({
        probe_id: "p16",
        kind: "analytics-upload",
        requested_scheme: "http",
        observed_schemes: Object.freeze(["https"]),
      })]),
      smoke_probe_scheme_counts: Object.freeze({
        requested_http: requestedHttp,
        requested_https: requestedHttps,
        observed_http: requestedHttp - 1,
        observed_https: requestedHttps + 1,
        http_to_https: 1,
      }),
      smoke_probe_duplicate_request_count: 0,
      smoke_probe_drain_elapsed_ms: 750,
      smoke_probe_drain_timed_out: true,
    });
    const expectedPreflightEvidence = Object.freeze({
      bootstrap_lockdown_proven: true,
      observer_was_bound: true,
      dnr_rules_exact: true,
      dnr_rule_set_sha256: "b".repeat(64),
      ...expectedSmokeEvidence,
    });
    let current = sampleForCurrentProcess({
      roots: false,
      listenerPids: [],
      criticalDigests: criticalManifest,
    });
    const noBrowser = () => sampleForCurrentProcess({
      roots: false,
      listenerPids: [],
      criticalDigests: criticalManifest,
    });
    const browser = () => sampleForCurrentProcess({ criticalDigests: criticalManifest });
    let businessEntered = false;
    const code = AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_SMOKE_INCOMPLETE;
    const output = await runAuditedSinglePageSmoke({
      runId: "fake-owned-smoke-probe-failure",
      expectedLaunchdBaselineMode: "bootout",
      forensicRoot,
      criticalFiles,
      productionHashFiles,
      dependencies: {
        readLaunchState: async () => BOOTOUT,
        probe: async () => current,
        watcherOptions: { sampleIntervalMs: 60_000, delay: async () => {} },
        acquireInterlocks: (request) => acquireAuditedSmokeInterlocks({
          ...request,
          productionLockDirectory,
          validationLockFile,
        }),
        cleanupOwned9224: async () => {
          current = noBrowser();
          return { exact_9224_cleanup_proven: true };
        },
        emergencyBootout: async () => ({ production_bootout_proven: true }),
        loadArtifact: async () => ({ artifact_sha256: "1".repeat(64), source_set_sha256: "2".repeat(64) }),
        runOwned: async (_options, _operation, ownedDeps) => {
          await ownedDeps.lifecycle.emit({
            phase: "bootstrap", state: "starting", cause: "bootstrap_launch_armed",
            network_gate: "host_resolver_offline", observer_coverage: "not_available_before_dnr",
          });
          current = browser();
          await ownedDeps.lifecycle.emit({
            phase: "bootstrap", state: "listening", cause: "bootstrap_listener_owned",
            network_gate: "host_resolver_offline", observer_coverage: "not_available_before_dnr",
          });
          await ownedDeps.lifecycle.emit({
            phase: "bootstrap", state: "closing", cause: "bootstrap_close_armed",
            network_gate: "host_resolver_offline", observer_coverage: "not_available_before_dnr",
          });
          current = noBrowser();
          await ownedDeps.lifecycle.emit({
            phase: "bootstrap", state: "stopped", cause: "bootstrap_stopped",
            network_gate: "persisted_dnr_lockdown", observer_coverage: "not_available_before_dnr",
          });
          await ownedDeps.lifecycle.emit({
            phase: "operational", state: "starting", cause: "operational_launch_armed",
            network_gate: "persisted_dnr_lockdown", observer_coverage: "not_available_before_dnr",
          });
          current = browser();
          await ownedDeps.lifecycle.emit({
            phase: "operational", state: "listening", cause: "operational_observer_bound",
            network_gate: "dnr_default_deny_and_context_route", observer_coverage: "all_contexts_continuous",
          });
          await ownedDeps.lifecycle.emit({
            phase: "operational", state: "listening", cause: "operational_preflight_failed",
            failure_code: code,
            preflight_step: "web_request_smoke_keys",
            audit_phase: "preflight",
            bootstrap_lockdown_proven: true,
            observer_was_bound: true,
            dnr_rules_exact: true,
            dnr_rule_set_sha256: "b".repeat(64),
            ...unsafeSmokeEvidence,
            network_gate: "dnr_default_deny_and_context_route",
            observer_coverage: "observer_was_bound_pre_failure",
            mutation_zero_proven: false,
          });
          const safeError = new Error(secretSentinel);
          safeError.code = code;
          safeError.failure_code = code;
          safeError.preflight_step = "web_request_smoke_keys";
          safeError.audit_phase = "preflight";
          safeError.preflight_evidence = {
            bootstrap_lockdown_proven: true,
            observer_was_bound: true,
            dnr_rules_exact: true,
            dnr_rule_set_sha256: "b".repeat(64),
            ...unsafeSmokeEvidence,
            error: new Error(secretSentinel),
          };
          throw new AggregateError([safeError, new Error(secretSentinel)], secretSentinel);
        },
        runBusiness: async () => {
          businessEntered = true;
          throw new Error("business callback must not be entered");
        },
      },
    });

    assert.equal(output.status, "failed");
    assert.equal(output.failure_code, code);
    assert.equal(output.operation_entered, false);
    assert.equal(businessEntered, false);
    assert.deepEqual(output.preflight_evidence, expectedPreflightEvidence);
    assert.equal(output.preflight_evidence.smoke_probe_missing[0].probe_id, "p16");

    const runDirectory = path.join(forensicRoot, "fake-owned-smoke-probe-failure");
    const timeline = (await fs.readFile(path.join(runDirectory, "timeline.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    const failureRow = timeline.find((row) => row.cause === "operational_preflight_failed");
    assert.ok(failureRow);
    assert.equal(output.failed_sample_seq, failureRow.monotonic_seq);
    assert.deepEqual(failureRow.preflight_evidence, expectedPreflightEvidence);
    assert.equal(failureRow.preflight_evidence.smoke_probe_missing[0].probe_id, "p16");

    const persistedResult = JSON.parse(await fs.readFile(path.join(runDirectory, "result.json"), "utf8"));
    assert.equal(persistedResult.failed_sample_seq, failureRow.monotonic_seq);
    assert.deepEqual(persistedResult.preflight_evidence, expectedPreflightEvidence);
    const manifest = JSON.parse(await fs.readFile(path.join(runDirectory, "manifest.json"), "utf8"));
    const manifestFailure = manifest.production_hash_manifest.interlocks.retained_failure_evidence;
    assert.equal(manifest.production_hash_manifest.interlocks.retained_failure_evidence_exact, true);
    assert.equal(manifestFailure.failed_sample_seq, failureRow.monotonic_seq);
    assert.deepEqual(manifestFailure.preflight_evidence, expectedPreflightEvidence);

    for (const owner of [productionOwner, validationLockFile]) {
      const document = JSON.parse(await fs.readFile(owner, "utf8"));
      assert.equal(document.failure_code, code);
      assert.equal(document.failed_sample_seq, failureRow.monotonic_seq);
      assert.deepEqual(document.preflight_evidence, expectedPreflightEvidence);
      assert.equal(document.preflight_evidence.smoke_probe_missing[0].probe_id, "p16");
    }

    for (const filename of ["timeline.jsonl", "result.json", "manifest.json", "manifest.sha256.json"]) {
      const artifact = await fs.readFile(path.join(runDirectory, filename), "utf8");
      assert.equal(artifact.includes(secretSentinel), false, filename);
      assert.equal(artifact.includes(secretDigest), false, filename);
    }
    for (const owner of [productionOwner, validationLockFile]) {
      const artifact = await fs.readFile(owner, "utf8");
      assert.equal(artifact.includes(secretSentinel), false, owner);
      assert.equal(artifact.includes(secretDigest), false, owner);
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
