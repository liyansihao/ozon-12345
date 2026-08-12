import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildIncidentDigest,
  clearOzonManualVerificationLock,
  compactProductionStatus,
  currentRunRetirementDecision,
  dailyAcceptedSummary,
  deploymentIdentityValid,
  directCompletionEvidenceDecision,
  doctor,
  effectiveRuntimeOwners,
  globalFlowBWorkerPids,
  optionalSeasonPriorityJsonIsValid,
  productionProfileOwnerPids,
  productionSupervisorPids,
  readProfitLearningStatus,
  readSeasonPriorityStatus,
  refreshCurrentRunSources,
  resumeMode,
  shouldResumeCurrentRun,
  validateConfig,
  validateCandidateSourcePortfolio,
} from "../scripts/ozon_24h_control.mjs";

const current = {
  run_id: "20260727_223532_ozon_24h_production",
  run_dir: "/tmp/state/runs/20260727_223532_ozon_24h_production",
  urls_file: "/tmp/state/sources/active_urls.txt",
};

test("daily start resumes the same safely stopped pending or formal run", () => {
  assert.equal(shouldResumeCurrentRun({ status: "STOPPED" }, {
    ...current,
    formal_started: false,
  }), true);
  assert.equal(shouldResumeCurrentRun({ status: "STOPPED" }, {
    ...current,
    formal_started: true,
  }), true);
  assert.equal(shouldResumeCurrentRun({ status: "WAITING_FOR_QUOTA_RESET" }, current), true);
  assert.equal(shouldResumeCurrentRun({ status: "PREWARMING_CANDIDATES" }, current), true);
  assert.equal(shouldResumeCurrentRun({ status: "PREPARING_CANDIDATE_BUFFER" }, current), true);
  assert.equal(shouldResumeCurrentRun({ status: "RECOVERY_BACKOFF" }, current), true);
  assert.equal(shouldResumeCurrentRun({
    status: "STOPPED",
    reason: "rolling-120-minute-strict-rate-below-threshold",
  }, {
    ...current,
    formal_started: true,
  }), false);
});

test("daily start never silently resumes fatal or completed state", () => {
  assert.equal(shouldResumeCurrentRun({ status: "FATAL_STOP" }, current), false);
  assert.equal(shouldResumeCurrentRun({ status: "WINDOW_COMPLETE" }, current), false);
  assert.equal(shouldResumeCurrentRun({ status: "TARGET_NOT_MET" }, current), false);
  assert.equal(shouldResumeCurrentRun({ status: "STOPPED" }, { run_id: "partial" }), false);
});

test("resume restarts the same checkpoint after an intentional safe stop", () => {
  assert.equal(resumeMode({ status: "STOPPED" }, current), "restart-current-run");
  assert.equal(resumeMode({ status: "WAITING_FOR_VERIFICATION" }, current), "verification");
  assert.equal(resumeMode({ status: "RUNNING" }, current), "wake-supervisor");
  assert.equal(resumeMode({ status: "RECOVERY_BACKOFF" }, current), "wake-supervisor");
  assert.equal(resumeMode({ status: "STOPPED" }, { run_id: "partial" }), "wake-supervisor");
});

test("verification resume clears the persistent Ozon access lock with audit evidence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-verification-resume-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const profileDir = path.join(stateRoot, "profiles", "production-profile");
  const accessState = path.join(path.dirname(profileDir), "ozon_access_state.json");
  await fs.mkdir(path.dirname(accessState), { recursive: true });
  await fs.writeFile(accessState, `${JSON.stringify({
    requires_manual_clear: true,
    reason: "Ozon CAPTCHA required for SKU 123",
    captcha_retry_pending: true,
  })}\n`);

  const result = await clearOzonManualVerificationLock({
    config: { browser: { profile_dir: profileDir }, flow_env: {} },
    stateRoot,
    now: new Date("2026-08-07T06:00:00.000Z"),
  });
  const saved = JSON.parse(await fs.readFile(accessState, "utf8"));
  const audit = JSON.parse((await fs.readFile(
    path.join(stateRoot, "ozon_access_manual_clearance.jsonl"),
    "utf8",
  )).trim());

  assert.equal(result.cleared, true);
  assert.equal(saved.requires_manual_clear, false);
  assert.equal(saved.reason, null);
  assert.equal(saved.captcha_retry_pending, false);
  assert.equal(saved.manually_cleared_at, "2026-08-07T06:00:00.000Z");
  assert.equal(audit.prior_reason, "Ozon CAPTCHA required for SKU 123");
  assert.equal(audit.source, "control-panel-verification-resume");
});

test("direct target completion is resumable when current-run ERP evidence is below 500", () => {
  assert.deepEqual(directCompletionEvidenceDecision({
    status: { status: "TARGET_COMPLETE" },
    current,
    acceptedCount: 0,
    target: 500,
  }), {
    action: "resume-current-run",
    accepted: 0,
    target: 500,
  });
  assert.deepEqual(directCompletionEvidenceDecision({
    status: { status: "TARGET_COMPLETE" },
    current,
    acceptedCount: 500,
    target: 500,
  }), {
    action: "complete",
    accepted: 500,
    target: 500,
  });
});

test("legacy target completion always resumes when direct publishing is unlimited", () => {
  assert.deepEqual(directCompletionEvidenceDecision({
    status: { status: "TARGET_COMPLETE" },
    current,
    acceptedCount: 499,
    target: 0,
  }), {
    action: "resume-current-run",
    accepted: 499,
    target: null,
    unlimited: true,
  });
});

test("direct daily status counts unique ERP acceptances in the Shanghai natural day", () => {
  assert.deepEqual(dailyAcceptedSummary([
    { sku: "previous", store_id: 1, accepted_at: "2026-07-31T15:59:59.999Z" },
    { sku: "today-a", store_id: 2, accepted_at: "2026-07-31T16:00:00.000Z" },
    { sku: "today-a", store_id: 2, accepted_at: "2026-08-01T01:00:00.000Z" },
    { sku: "today-b", store_id: 3, at: "2026-08-01T15:59:59.999Z" },
    { sku: "tomorrow", store_id: 3, accepted_at: "2026-08-01T16:00:00.000Z" },
  ], {
    now: "2026-08-01T12:00:00.000Z",
  }), {
    date: "2026-08-01",
    accepted: 2,
    by_store: { "2": 1, "3": 1 },
  });
});

test("legacy production run can only be retired after a zero-owner safe stop", () => {
  assert.deepEqual(currentRunRetirementDecision({
    status: { status: "STOPPED", reason: "safe stop requested" },
    current: {
      ...current,
      formal_started: true,
      acceptance_target: 469,
      acceptance_target_policy: "erp_remaining_capacity",
    },
    owners: { supervisor: 0, worker: 0, profile: 0 },
  }), {
    action: "retire",
    reason: "superseded-by-fixed-500-v3",
  });
  assert.equal(currentRunRetirementDecision({
    status: { status: "RUNNING" },
    current,
    owners: { supervisor: 0, worker: 0, profile: 0 },
  }).action, "reject");
  assert.equal(currentRunRetirementDecision({
    status: { status: "STOPPED" },
    current,
    owners: { supervisor: 0, worker: 1, profile: 0 },
  }).action, "reject");
  assert.deepEqual(currentRunRetirementDecision({
    status: { status: "FATAL_STOP", evidence_preserved: true },
    current,
    owners: { supervisor: 0, worker: 0, profile: 0 },
  }), {
    action: "retire",
    reason: "superseded-after-evidenced-fatal-stop",
  });
  assert.equal(currentRunRetirementDecision({
    status: { status: "FATAL_STOP", evidence_preserved: false },
    current,
    owners: { supervisor: 0, worker: 0, profile: 0 },
  }).action, "reject");
});

test("control ownership precheck finds flow_b workers from every run", () => {
  assert.deepEqual(globalFlowBWorkerPids([
    " 101 /usr/bin/node /app/scripts/flow_b_playwright.mjs accept /state/runs/current /state/urls.txt",
    " 202 /usr/bin/node /old/scripts/flow_b_playwright.mjs run /state/runs/old /state/urls.txt",
    " 303 /usr/bin/node /app/scripts/flow_b_playwright.mjs scan /state/urls.txt /tmp/out.json",
    " 404 /usr/bin/node /app/scripts/other.mjs publish",
    " 505 /bin/zsh -lc ps | rg 'flow_b_playwright.mjs run'",
  ]), [101, 202]);
});

test("owner detection ignores diagnostic shells that only mention process names", () => {
  const marker = "--user-data-dir=/state/profile";
  const lines = [
    " 101 /usr/bin/node /app/scripts/ozon_24h_supervisor.mjs supervise /app/config.json",
    " 202 /bin/zsh -lc ps | rg 'ozon_24h_supervisor.mjs supervise'",
    " 303 /Applications/Google Chrome for Testing --remote-debugging-port=9223 --user-data-dir=/state/profile about:blank",
    " 304 /Applications/Google Chrome Helper --type=renderer --remote-debugging-port=9223 --user-data-dir=/state/profile",
    " 404 /bin/zsh -lc echo '--remote-debugging-port=9223 --user-data-dir=/state/profile'",
  ];
  assert.deepEqual(productionSupervisorPids(lines), [101]);
  assert.deepEqual(productionProfileOwnerPids(
    lines,
    marker,
    "/Applications/Google Chrome for Testing",
  ), [303]);
});

test("live owner counts replace stale persisted owners after a safe stop", () => {
  assert.deepEqual(effectiveRuntimeOwners({
    counts: { supervisor: 1, worker: 1, profile_owner: 1 },
  }, {
    supervisor: 0,
    worker: 0,
    profile: 1,
  }), {
    supervisor: 0,
    worker: 0,
    profile: 1,
  });
  assert.deepEqual(effectiveRuntimeOwners({
    counts: { supervisor: 1, worker: 0, profile_owner: 1 },
  }), {
    supervisor: 1,
    worker: 0,
    profile: 1,
  });
});

test("doctor release identity requires exact commit, config hash, source hash, and schema v3", () => {
  const configText = "{\"fixed\":true}\n";
  const valid = {
    source_commit: "a".repeat(40),
    config_sha256: crypto.createHash("sha256").update(configText).digest("hex"),
    source_set_sha256: "b".repeat(64),
    source_smoke_sha256: "c".repeat(64),
    state_schema_version: 3,
  };
  assert.equal(deploymentIdentityValid(valid, configText), true);
  assert.equal(deploymentIdentityValid({ ...valid, source_commit: "" }, configText), false);
  assert.equal(deploymentIdentityValid({ ...valid, config_sha256: "0".repeat(64) }, configText), false);
  assert.equal(deploymentIdentityValid({ ...valid, source_set_sha256: "" }, configText), false);
  assert.equal(deploymentIdentityValid({ ...valid, state_schema_version: 2 }, configText), false);
});

test("production config freezes unlimited direct runtime and external 1688 Python", async () => {
  const configPath = path.resolve(
    import.meta.dirname,
    "../config/ozon_24h_production.json",
  );
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.doesNotThrow(() => validateConfig(config));
  assert.equal(config.runtime_mode, "direct");
  assert.equal(config.publish_target, 0);
  assert.equal(config.unlimited_publish, true);
  assert.equal(config.flow_env.FLOW_B_DIRECT_PUBLISH, "1");
  assert.equal(config.flow_env.FLOW_B_TARGET_PUBLISH_COUNT, "0");
  assert.equal(config.flow_env.FLOW_B_UNLIMITED_PUBLISH, "1");
  assert.equal(config.flow_env.FLOW_B_DAILY_SUBMISSION_CUTOFF, "23:00");
  assert.equal(config.flow_env.FLOW_B_DAILY_REPORT_AFTER, "23:30");
  assert.equal(config.daily_pricing_report.cutoff, "23:00");
  assert.equal(config.daily_pricing_report.report_after, "23:30");
  assert.equal(config.flow_env.FLOW_B_1688_MIN_MATCHES, "1");
  assert.equal(config.flow_env.FLOW_B_1688_TOTAL_BUDGET_MS, "30000");
  assert.equal(config.flow_env.FLOW_B_1688_ITEM_TIMEOUT, "30");
  assert.equal(config.flow_env.FLOW_B_1688_TRANSIENT_RETRIES, "1");
  assert.equal(config.flow_env.FLOW_B_1688_WORKERS, "1");
  assert.equal(config.flow_env.FLOW_B_1688_SESSION_MAX_REQUESTS, "4");
  assert.equal(config.flow_env.FLOW_B_1688_SESSION_MAX_AGE_SECONDS, "120");
  assert.equal(config.flow_env.FLOW_B_1688_SESSION_RECYCLE_SLOW_SECONDS, "8");
  assert.equal(config.flow_env.FLOW_B_1688_CACHE_FLUSH_DEBOUNCE_MS, "5000");
  assert.equal(config.flow_env.FLOW_B_1688_MATCH_POLICY, "shadow");
  assert.equal(config.flow_env.FLOW_B_1688_MATCH_SHADOW_SAMPLES, "100");
  assert.equal(config.flow_env.FLOW_B_1688_ADAPTIVE_ACTION_POLICY, "enforce");
  assert.equal(config.flow_env.FLOW_B_1688_ADAPTIVE_ACTION_SAMPLE_TARGET, "100");
  assert.equal(config.flow_env.FLOW_B_PROFIT_SAFETY_ACTION_POLICY, "shadow");
  assert.equal(config.browser.no_proxy_server, false);
  assert.equal(config.browser.start_timeout_ms, 180_000);
  assert.equal(config.browser.start_probe_timeout_ms, 10_000);
  assert.equal(config.browser.existing_owner_grace_ms, 30_000);
  assert.equal(config.browser.cdp_health_timeout_ms, 10_000);
  assert.equal(config.browser.cdp_health_failure_threshold, 6);
  assert.equal(config.flow_env.NODE_USE_ENV_PROXY, "1");
  assert.equal(config.flow_env.HTTP_PROXY, "http://127.0.0.1:7897");
  assert.equal(config.flow_env.HTTPS_PROXY, "http://127.0.0.1:7897");
  assert.equal(config.flow_env.NO_PROXY, "127.0.0.1,localhost,::1");
  assert.equal(config.flow_env.FLOW_B_NO_PROXY_SERVER, "0");
  assert.deepEqual(config.direct_worker_watchdog, {
    enabled: true,
    source_error_threshold: 3,
    producer_stale_ms: 1_200_000,
    startup_grace_ms: 180_000,
    recovery_cooldown_ms: 1_800_000,
    recovery_window_ms: 7_200_000,
    max_recoveries_per_window: 2,
    probe_failure_threshold: 2,
  });
  assert.deepEqual(config.verification_auto_recovery, {
    enabled: true,
    probe_delays_seconds: [300, 600, 1_200, 1_800],
    ready_confirmations: 2,
    confirmation_interval_seconds: 30,
    confirmation_max_age_seconds: 90,
    probe_timeout_ms: 45_000,
    poll_interval_ms: 2_000,
    warmup_interval_ms: 8_000,
  });
  assert.equal(config.flow_env.FLOW_B_1688_MATCH_MIN_RETENTION_PERCENT, "75");
  assert.equal(config.flow_env.FLOW_B_1688_MATCH_MIN_IMAGE_PERCENT, "90");
  assert.equal(config.flow_env.FLOW_B_1688_MATCH_MAX_P95_MS, "15000");
  assert.equal(config.flow_env.FLOW_B_TAB_WORKERS, "3");
  assert.equal(config.flow_env.FLOW_B_FAVORITE_WORKERS, "3");
  assert.equal(config.flow_env.FLOW_B_PUBLISH_WORKERS, "8");
  assert.equal(config.flow_env.FLOW_B_OZON_DETAIL_WORKERS, "1");
  assert.equal(config.flow_env.FLOW_B_MAX_OZON_DETAIL_WORKERS, "1");
  assert.equal(config.flow_env.FLOW_B_PRUNE_ORPHAN_PAGES_ON_START, "1");
  assert.equal(config.flow_env.FLOW_B_ORPHAN_PAGE_KEEP_COUNT, "1");
  assert.equal(config.flow_env.FLOW_B_ORPHAN_PAGE_CLOSE_TIMEOUT_MS, "5000");
  assert.equal(config.flow_env.FLOW_B_OZON_WARMUP_INTERVAL_MS, "4000");
  assert.equal(config.flow_env.FLOW_B_OZON_BASE_INTERVAL_MS, "3000");
  assert.equal(config.flow_env.FLOW_B_OZON_MAX_INTERVAL_MS, "8000");
  assert.equal(config.flow_env.FLOW_B_SOURCE_PRODUCTIVE_WEIGHT, "3");
  assert.equal(config.flow_env.FLOW_B_SOURCE_EXPLORATION_WEIGHT, "1");
  assert.equal(config.flow_env.FLOW_B_FAVORITE_CACHE_TTL_MS, "30000");
  assert.equal(config.profit_learning.enabled, true);
  assert.equal(config.profit_learning.priority_file, "/Users/mac/Desktop/ozon每日上品/优先母款.json");
  assert.equal(config.profit_learning.season_file, "/Users/mac/Desktop/ozon每日上品/季节优先类目.json");
  assert.equal(config.profit_learning.feedback_file, "/Users/mac/Desktop/ozon每日上品/错误货源.json");
  assert.equal(config.profit_learning.feedback_dir, "/Users/mac/Desktop/ozon每日上品/核价反馈");
  assert.equal(config.profit_learning.learning_status, "${STATE_ROOT}/profit_learning/status.json");
  assert.equal(config.profit_learning.feedback_status, "${STATE_ROOT}/profit_learning/feedback_status.json");
  assert.equal(config.profit_learning.lookback_days, 30);
  assert.equal(config.profit_learning.minimum_completed_orders, 3);
  assert.equal(config.profit_learning.poll_interval_seconds, 60);
  assert.equal(config.profit_learning.order_page_size, 100);
  assert.equal(config.profit_learning.order_max_pages, 100);
  assert.equal(config.candidate_buffer, undefined);
  assert.equal(config.acceptance, undefined);
  assert.deepEqual(config.stores.map((row) => Number(row.id)), [
    104965, 106637, 106640, 106644, 106646, 113151, 113153, 113154, 113155, 113156,
  ]);
  assert.deepEqual(
    config.flow_env.FLOW_B_STORE_TARGETS.map((row) => Number(row.id)),
    config.stores.map((row) => Number(row.id)),
  );
  assert.equal(new Set(config.stores.map((row) => Number(row.warehouse_id))).size, 10);
  assert.deepEqual(
    config.flow_env.FLOW_B_STORE_TARGETS.map((row) => Number(row.warehouseId)),
    config.stores.map((row) => Number(row.warehouse_id)),
  );
  assert.equal(new Set(config.stores.map((row) => Number(row.ural_warehouse_id))).size, 10);
  assert.deepEqual(
    config.flow_env.FLOW_B_STORE_TARGETS.map((row) => Number(row.uralWarehouseId)),
    config.stores.map((row) => Number(row.ural_warehouse_id)),
  );
  assert.ok(config.flow_env.FLOW_B_STORE_TARGETS.every(
    (row) => row.weightRouting === true && Number(row.weightThresholdGrams) === 500,
  ));
  assert.throws(
    () => validateConfig({
      ...config,
      flow_env: {
        ...config.flow_env,
        FLOW_B_1688_MIN_MATCHES: "3",
      },
    }),
    /one verified 1688/u,
  );
  assert.throws(
    () => validateConfig({
      ...config,
      flow_env: {
        ...config.flow_env,
        FLOW_B_1688_ADAPTIVE_ACTION_POLICY: "automatic",
      },
    }),
    /adaptive action policy/u,
  );
  assert.doesNotThrow(() => validateConfig({
    ...config,
    flow_env: {
      ...config.flow_env,
      FLOW_B_PROFIT_SAFETY_ACTION_POLICY: "enforce",
    },
  }));
  assert.throws(
    () => validateConfig({
      ...config,
      flow_env: {
        ...config.flow_env,
        FLOW_B_PROFIT_SAFETY_ACTION_POLICY: undefined,
      },
    }),
    /profit safety action policy/u,
  );
  assert.throws(
    () => validateConfig({
      ...config,
      direct_worker_watchdog: {
        ...config.direct_worker_watchdog,
        enabled: false,
      },
    }),
    /direct worker watchdog/u,
  );
  assert.throws(
    () => validateConfig({
      ...config,
      direct_worker_watchdog: {
        ...config.direct_worker_watchdog,
        producer_stale_ms: 60_000,
      },
    }),
    /producer_stale_ms=1200000/u,
  );
  assert.throws(
    () => validateConfig({
      ...config,
      verification_auto_recovery: {
        ...config.verification_auto_recovery,
        enabled: false,
      },
    }),
    /automatic verification recovery/u,
  );
  assert.throws(
    () => validateConfig({
      ...config,
      verification_auto_recovery: {
        ...config.verification_auto_recovery,
        ready_confirmations: 1,
      },
    }),
    /ready_confirmations=2/u,
  );
  assert.throws(
    () => validateConfig({
      ...config,
      flow_env: {
        ...config.flow_env,
        FLOW_B_PROFIT_SAFETY_ACTION_POLICY: "automatic",
      },
    }),
    /profit safety action policy/u,
  );
  assert.throws(
    () => validateConfig({
      ...config,
      flow_env: {
        ...config.flow_env,
        FLOW_B_1688_ADAPTIVE_ACTION_SAMPLE_TARGET: "99",
      },
    }),
    /evidence target/u,
  );
  assert.throws(
    () => validateConfig({
      ...config,
      flow_env: {
        ...config.flow_env,
        FLOW_B_PYTHON: "python3",
      },
    }),
    /absolute external Python executable/u,
  );
  assert.throws(
    () => validateConfig({
      ...config,
      flow_env: {
        ...config.flow_env,
        FLOW_B_1688_TOTAL_BUDGET_MS: "45000",
      },
    }),
    /balanced speed contract/u,
  );
  assert.throws(
    () => validateConfig({
      ...config,
      publish_target: 500,
    }),
    /target zero/u,
  );
  assert.throws(
    () => validateConfig({ ...config, stores: config.stores.slice(0, 9) }),
    /ten verified stores/u,
  );
  assert.throws(
    () => validateConfig({
      ...config,
      stores: config.stores.map((row, index) => index === 9
        ? { ...row, warehouse_id: config.stores[8].warehouse_id }
        : row),
      flow_env: {
        ...config.flow_env,
        FLOW_B_STORE_TARGETS: config.flow_env.FLOW_B_STORE_TARGETS.map((row, index) => index === 9
          ? { ...row, warehouseId: config.stores[8].warehouse_id }
          : row),
      },
    }),
    /warehouse mappings must be unique/u,
  );
  assert.throws(
    () => validateConfig({
      ...config,
      flow_env: {
        ...config.flow_env,
        FLOW_B_STORE_TARGETS: [...config.flow_env.FLOW_B_STORE_TARGETS].reverse(),
      },
    }),
    /store targets must match/u,
  );
  assert.throws(
    () => validateConfig({
      ...config,
      profit_learning: {
        ...config.profit_learning,
        priority_file: "/tmp/优先母款.json",
      },
    }),
    /fixed daily-upload desktop folder/u,
  );
  assert.throws(
    () => validateConfig({
      ...config,
      profit_learning: {
        ...config.profit_learning,
        season_file: "/tmp/季节优先类目.json",
      },
    }),
    /fixed daily-upload desktop folder/u,
  );
});

test("profit learning status reports sidecars and the active Shanghai season without blocking on warnings", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-profit-status-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const statusDir = path.join(stateRoot, "profit_learning");
  await fs.mkdir(statusDir, { recursive: true });
  await fs.writeFile(path.join(statusDir, "status.json"), `${JSON.stringify({
    status: "completed",
    completed_at: "2026-08-09T12:30:00.000Z",
    priority_count: 7,
  })}\n`);
  await fs.writeFile(path.join(statusDir, "feedback_status.json"), "{broken-json\n");
  const seasonFile = path.join(root, "季节优先类目.json");
  await fs.writeFile(seasonFile, `${JSON.stringify({
    schema_version: 1,
    time_zone: "Asia/Shanghai",
    research_verified_at: "2026-08-01",
    next_review_at: "2026-08-08",
    coverage_until: "2026-09-15",
    sources: [{ url: "https://seller.ozon.ru/media/trends/seasonal-products" }],
    events: [{
      id: "school-2026",
      name: "开学季",
      sales_start: "2026-09-01",
      sales_end: "2026-09-15",
      lead_days: 45,
      categories: [{ name: "文具", keywords: ["канцелярия"] }],
    }, {
      id: "disabled-school-2026",
      enabled: false,
      sales_start: "2026-09-01",
      sales_end: "2026-09-15",
      lead_days: 45,
      categories: ["Канцтовары"],
    }],
  })}\n`);

  const result = await readProfitLearningStatus({
    install_root: path.join(root, "app"),
    state_root: stateRoot,
    profit_learning: {
      enabled: true,
      priority_file: path.join(root, "优先母款.json"),
      season_file: seasonFile,
      feedback_file: path.join(root, "错误货源.json"),
      feedback_dir: path.join(root, "核价反馈"),
      learning_status: "${STATE_ROOT}/profit_learning/status.json",
      feedback_status: "${STATE_ROOT}/profit_learning/feedback_status.json",
    },
  }, {
    appLink: path.join(root, "app"),
    stateRoot,
  }, {
    now: new Date("2026-08-09T00:00:00.000Z"),
  });

  assert.equal(result.enabled, true);
  assert.equal(result.learning.status, "completed");
  assert.equal(result.learning.priority_count, 7);
  assert.equal(result.feedback_import.status, "invalid");
  assert.match(result.feedback_import.error, /JSON/u);
  assert.equal(result.season_priority.status, "ready");
  assert.equal(result.season_priority.date, "2026-08-09");
  assert.equal(result.season_priority.event_count, 2);
  assert.equal(result.season_priority.active_event_count, 1);
  assert.equal(result.season_priority.active_events[0].id, "school-2026");
  assert.equal(result.season_priority.active_events[0].active_from, "2026-07-18");
  assert.equal(result.season_priority.research_due, true);
  assert.equal(result.season_priority.coverage_warning, "coverage-under-90-days");
});

test("season priority validation allows absence but rejects unsafe sources and non-45-day rules", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-season-status-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "季节优先类目.json");
  assert.equal(await optionalSeasonPriorityJsonIsValid(filename), true);
  assert.equal((await readSeasonPriorityStatus(filename)).status, "not-started");

  await fs.writeFile(filename, `${JSON.stringify({
    schema_version: 1,
    timezone: "Europe/Moscow",
    lead_days: 45,
    sources: ["http://example.com/calendar"],
    events: [{
      sales_start: "2026-12-01",
      sales_end: "2026-12-31",
      lead_days: 30,
      categories: ["文具", { keywords: ["ab"] }, 42],
    }],
  })}\n`);
  assert.equal(await optionalSeasonPriorityJsonIsValid(filename), false);
  const invalid = await readSeasonPriorityStatus(filename, {
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.equal(invalid.status, "invalid");
  assert.match(invalid.error, /time_zone must equal Asia\/Shanghai/u);
  assert.match(invalid.error, /root lead_days is not supported/u);
  assert.match(invalid.error, /lead_days must equal 45/u);
  assert.match(invalid.error, /needs a Russian name/u);
  assert.match(invalid.error, /must be a string or object/u);
  assert.match(invalid.error, /HTTPS URL/u);

  await fs.writeFile(filename, `${JSON.stringify({
    events: [{
      sales_start: "2026-09-10",
      sales_end: "2026-09-01",
      categories: [{ name: "Канцтовары" }],
    }],
  })}\n`);
  assert.equal(await optionalSeasonPriorityJsonIsValid(filename), false);
  assert.match(
    (await readSeasonPriorityStatus(filename)).error,
    /sales_end must not be before sales_start/u,
  );

  await fs.writeFile(filename, `${JSON.stringify({
    schema_version: 1,
    time_zone: "Asia/Shanghai",
    sources: ["https://seller.ozon.ru/media/trends/seasonal-products"],
    events: [{
      id: "single-day-defaults",
      sales_start: "2026-09-01",
      categories: [{ name: "文具", keywords: ["канцелярия"] }],
    }],
  })}\n`);
  assert.equal(await optionalSeasonPriorityJsonIsValid(filename), true);
  const defaults = await readSeasonPriorityStatus(filename, {
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.equal(defaults.status, "ready");
  assert.equal(defaults.active_events[0].lead_days, 45);
  assert.equal(defaults.active_events[0].active_from, "2026-07-18");
  assert.equal(defaults.active_events[0].active_until, "2026-09-01");
});

test("doctor expands its Python path without supervisor-only helpers", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-control-doctor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  await fs.mkdir(stateRoot, { recursive: true });
  const priorityFile = path.join(root, "daily", "优先母款.json");
  const seasonFile = path.join(root, "daily", "季节优先类目.json");
  await fs.mkdir(path.dirname(priorityFile), { recursive: true });
  await fs.writeFile(priorityFile, "{broken-json\n");
  await fs.writeFile(seasonFile, "{broken-json\n");
  const result = await doctor({
    install_root: path.join(root, "app"),
    state_root: stateRoot,
    flow_env: {
      FLOW_B_PYTHON: "${HOME}/definitely-missing-ozon-python",
    },
    profit_learning: {
      enabled: true,
      priority_file: priorityFile,
      season_file: seasonFile,
      feedback_file: path.join(root, "daily", "错误货源.json"),
      feedback_dir: path.join(root, "daily", "核价反馈"),
      learning_status: "${STATE_ROOT}/profit_learning/status.json",
      feedback_status: "${STATE_ROOT}/profit_learning/feedback_status.json",
      runtime_root: "${STATE_ROOT}/profit_learning",
      node: process.execPath,
      node_modules: path.dirname(process.execPath),
    },
    browser: {
      executable: path.join(root, "missing-browser"),
      profile_dir: path.join(root, "missing-profile"),
      extension_dir: path.join(root, "missing-extension"),
    },
    minimum_free_disk_kb: 0,
  }, { appRoot: path.join(root, "candidate") });
  assert.equal(result.ok, false);
  assert.equal(result.checks.python, false);
  assert.equal(result.checks.profit_priority_json, false);
  assert.equal(result.checks.season_priority_json, false);
  assert.equal(result.checks.profit_feedback_json, true);
  assert.equal(result.checks.profit_learning_status_json, true);
  assert.equal(result.checks.profit_feedback_status_json, true);
  assert.equal(result.checks.profit_feedback_dir, true);
  assert.equal(result.checks.profit_runtime_root, true);
  assert.equal(result.app_root, path.join(root, "candidate"));
});

test("same-run resume refreshes the active source pool from the promoted release", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-24h-resume-sources-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const runDir = path.join(stateRoot, "runs", current.run_id);
  const urlsFile = path.join(stateRoot, "sources", "active_urls.txt");
  const seedFile = path.join(root, "candidate-seed.txt");
  const promotedSource = "https://www.ozon.ru/seller/verified-seller-12345/";
  const existing = {
    ...current,
    run_dir: runDir,
    urls_file: urlsFile,
    source_sha256: "old-source-hash",
  };
  await fs.mkdir(path.join(stateRoot, "history"), { recursive: true });
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(path.dirname(urlsFile), { recursive: true });
  await fs.writeFile(urlsFile, "https://www.ozon.ru/seller/old-source/\n");
  await fs.writeFile(seedFile, `${promotedSource}\n`);
  await fs.writeFile(path.join(stateRoot, "current_run.json"), `${JSON.stringify(existing)}\n`);

  const refreshed = await refreshCurrentRunSources({
    appRoot: path.resolve(import.meta.dirname, ".."),
    stateRoot,
    current: existing,
    seedFile,
  });

  assert.match(await fs.readFile(urlsFile, "utf8"), /seller\/verified-seller-12345/);
  assert.match(refreshed.source_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(refreshed.source_set_sha256, refreshed.source_sha256);
  assert.notEqual(refreshed.source_sha256, existing.source_sha256);
  assert.ok(Date.parse(refreshed.source_refreshed_at) > 0);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(stateRoot, "current_run.json"), "utf8")),
    refreshed,
  );
});

test("candidate source smoke check is isolated from production state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-candidate-source-smoke-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const releasesRoot = path.join(root, "releases");
  const productionState = path.join(root, "production-state");
  const productionSources = path.join(productionState, "sources", "active_urls.txt");
  const seedFile = path.join(root, "candidate-seed.txt");
  const sentinel = "https://www.ozon.ru/seller/current-production-source/\n";
  await fs.mkdir(path.dirname(productionSources), { recursive: true });
  await fs.writeFile(productionSources, sentinel);
  await fs.writeFile(seedFile, "https://www.ozon.ru/seller/candidate-source/\n");

  const result = await validateCandidateSourcePortfolio({
    appRoot: path.resolve(import.meta.dirname, ".."),
    releasesRoot,
    seedFile,
  });

  assert.equal(await fs.readFile(productionSources, "utf8"), sentinel);
  assert.match(result.sourceText, /seller\/candidate-source/);
  assert.match(result.sourceSetSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.activeSourceCount > 0, true);
  assert.deepEqual(
    (await fs.readdir(releasesRoot)).filter((name) => name.startsWith(".candidate-source-smoke-")),
    [],
  );
});

test("normal production status is bounded below two kilobytes", () => {
  const compact = compactProductionStatus({
    current: {
      run_id: "run-1",
      formal_started: true,
      config_sha256: "c".repeat(64),
      source_set_sha256: "s".repeat(64),
      state_schema_version: 3,
    },
    operational: {
      observed_at: "2026-07-29T00:00:00.000Z",
      status: "RUNNING",
      reason: "x".repeat(20_000),
      capacity_preflight: { giant: "not included".repeat(10_000) },
    },
    owners: { counts: { supervisor: 1, worker: 1, profile_owner: 1 } },
    checkpoint: {
      compact: {
        strict: 70,
        target: 500,
        rate_h: 35,
        rolling_h: { 120: 35 },
        by_store: { "1": 14, "2": 14, "3": 14, "4": 14, "5": 14 },
      },
    },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 2048);
  assert.equal(compact.reason.endsWith("…"), true);
  assert.equal(compact.owners.worker, 1);
});

test("idle or retired status never reports stale persisted process owners", () => {
  const compact = compactProductionStatus({
    current: {},
    operational: {
      observed_at: "2026-07-30T00:00:00.000Z",
      status: "RETIRED",
    },
    owners: { counts: { supervisor: 1, worker: 1, profile_owner: 1 } },
  });
  assert.deepEqual(compact.owners, {
    supervisor: 0,
    worker: 0,
    profile: 0,
  });
});

test("incident digest groups repeated errors before bounded diagnosis", () => {
  const digest = buildIncidentDigest({
    failed: [
      { sku: "1", reason: "ERP 429 retry after 180 seconds" },
      { sku: "2", reason: "ERP 429 retry after 300 seconds" },
    ],
    skipped: [{ sku: "3", reason: "duplicate-title" }],
    runtimeErrors: [{ error: "browser closed" }],
    candidates: [{ sku: "1" }, { sku: "1" }, { sku: "2" }],
    selected: [{ sku: "1" }],
    published: [{ sku: "1" }],
    recoveries: Array.from({ length: 8 }, (_, index) => ({
      at: `2026-07-29T00:00:0${index}.000Z`,
      action: "restart-worker",
    })),
  });
  assert.equal(digest.unique_skus.failed, 2);
  assert.deepEqual(digest.funnel, { candidate: 2, selected: 1, strict_published: 1 });
  assert.equal(digest.error_fingerprints[0].count, 2);
  assert.equal(digest.recent_recoveries.length, 5);
});
