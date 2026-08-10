import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  candidateCohortIdentity,
  createPrewarmCostBridge,
  DEFAULT_1688_SYNC_SCRIPT_PATH,
  main,
  prewarmCandidateCosts,
  selectPrewarmCandidates,
} from "../scripts/flow_b_prewarm_1688.mjs";

function completeV5Result({
  action = "ALLOW",
  decision = action === "REJECT" ? "REJECT" : "FAST",
  priceCny = 100,
  selectedOfferId = "offer-1",
  valuableApplies = false,
  valuableCategory = null,
} = {}) {
  return {
    adaptive_action_complete: true,
    selected_offer_id: selectedOfferId,
    adaptive_match: {
      version: "adaptive-v5-shadow",
      decision,
      score: action === "REJECT" ? 20 : 95,
      reason: action === "REJECT" ? "strict rejection" : "strict allow",
      hard_conflicts: action === "REJECT" ? ["model:mismatch"] : [],
      missing_evidence: [],
      selected_offer_id: selectedOfferId,
      supporting_offer_ids: [selectedOfferId],
      action,
      policy_version: "adaptive-v5-policy-1",
      policy_reasons: [action === "REJECT" ? "hard_conflict:model:mismatch" : "policy_allow"],
      evidence_complete: true,
      valuable_digital: {
        applies: valuableApplies,
        category: valuableCategory,
        price_cny: priceCny,
        threshold_cny: 300,
      },
    },
  };
}

test("candidate cohort identity is unique, deterministic and order independent", () => {
  const forward = candidateCohortIdentity([
    { sku: "b" },
    { sku: "a" },
    { sku: "a" },
    { sku: "  " },
    {},
  ]);
  const reversed = candidateCohortIdentity([
    { sku: "a" },
    { sku: "b" },
    { sku: "a" },
  ]);

  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward, {
    candidate_sku_count: 2,
    candidate_skus_sha256: "911169ddaaf146aff539f58c26c489af3b892dff0fe283c1c264c65ae5aa59a2",
  });
  assert.deepEqual(candidateCohortIdentity([]), {
    candidate_sku_count: 0,
    candidate_skus_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  });
});

test("prewarm selection keeps only latest complete unprocessed favorites", () => {
  const favoriteEvents = [
    { sku: "ready", status: "favorited", title: "old", cover_image: "https://img/ready", shipping_mode: "FBS", sale_price: 90, source_url: "https://source/1" },
    { sku: "ready", status: "favorited", title: "new", cover_image: "https://img/ready", shipping_mode: "FBS", sale_price: 100, source_url: "https://source/1" },
    { sku: "published", status: "favorited", title: "done", cover_image: "https://img/done", shipping_mode: "FBS", sale_price: 100, source_url: "https://source/2" },
    { sku: "incomplete", status: "favorited", title: "missing image", shipping_mode: "FBS", sale_price: 100, source_url: "https://source/3" },
    { sku: "submitted", status: "favorited", title: "pending", cover_image: "https://img/submitted", shipping_mode: "FBS", sale_price: 100, source_url: "https://source/6" },
    { sku: "removed", status: "favorited", title: "removed", cover_image: "https://img/removed", shipping_mode: "FBS", sale_price: 100, source_url: "https://source/4" },
    { sku: "removed", status: "rejected", reason: "non-pure-fbs" },
    { sku: "2815247918", status: "favorited", title: "bad", cover_image: "https://img/bad", shipping_mode: "FBS", sale_price: 100, source_url: "https://source/5" },
  ];
  const stateEvents = [
    { sku: "published", status: "published", data: { profit_rate: 50 } },
    { sku: "submitted", status: "processing", data: { submitted: true, offer_id: "mz-submitted" } },
  ];

  assert.deepEqual(selectPrewarmCandidates({ favoriteEvents, stateEvents }), [{
    sku: "ready",
    title: "new",
    cover_image: "https://img/ready",
    shipping_mode: "FBS",
    sale_price: 100,
    sell_price: 100,
    source_url: "https://source/1",
  }]);
});

test("prewarm runs bounded workers and distinguishes seed-price acceptance from rule rejection", async () => {
  let active = 0;
  let peak = 0;
  const bridge = {
    async estimate(item) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (item.sku === "cached") return {
        ok: true,
        cached: true,
        adaptive_match: { decision: "FAST", action: "ALLOW", evidence_complete: true },
      };
      if (item.sku === "reliable") return {
        ok: true,
        cached: false,
        adaptive_match: { decision: "REVIEW", action: "ALLOW", evidence_complete: true },
      };
      if (item.sku === "rejected") return {
        ok: false,
        reason: "no reliable match",
        cached: false,
        adaptive_match: { decision: "REJECT", action: "REJECT", evidence_complete: true },
      };
      return {
        ok: false,
        reason: "image download failed",
        error: { code: "image-download", message: "HTTP 404" },
        cached: false,
      };
    },
  };
  const outcomes = [];
  const summary = await prewarmCandidateCosts({
    candidates: ["cached", "reliable", "rejected", "error"].map((sku) => ({ sku, cover_image: `https://img/${sku}`, sell_price: 100 })),
    bridge,
    runDir: "/tmp/prewarm-test",
    concurrency: 2,
    onResult: (outcome) => outcomes.push(outcome),
    now: (() => {
      const readings = [0, 3_600_000];
      return () => readings.shift();
    })(),
  });

  assert.equal(peak, 2);
  assert.deepEqual(summary, {
    candidates: 4,
    completed: 4,
    duration_seconds: 3600,
    completed_per_hour: 4,
    cache_hits: 1,
    cache_misses: 3,
    seed_price_accepted: 2,
    seed_price_accepted_per_hour: 2,
    rule_rejected: 1,
    errors: 1,
    process_error_count: 0,
    deferred_count: 0,
    health_circuit_backoff_count: 0,
    actual_live_attempt_count: 0,
    actual_live_attempts_per_hour: 0,
    normal_process_completion_count: 0,
    normal_process_completions_per_hour: 0,
    unattempted_count: 4,
    adaptive_fast_count: 1,
    adaptive_review_count: 1,
    adaptive_reject_count: 1,
    adaptive_unclassified_count: 1,
    adaptive_classification_percent: 75,
    adaptive_fast_per_hour: 1,
    adaptive_review_per_hour: 1,
    adaptive_reject_per_hour: 1,
    adaptive_action_count: 0,
    adaptive_action_per_hour: 0,
    adaptive_allow_count: 0,
    adaptive_allow_per_hour: 0,
    adaptive_reject_action_count: 0,
    adaptive_reject_action_per_hour: 0,
    adaptive_action_unassessable_count: 4,
  });
  assert.equal(outcomes.length, 4);
  assert.deepEqual(outcomes.find((row) => row.item.sku === "error")?.result?.error, {
    code: "image-download",
    message: "HTTP 404",
  });
});

test("prewarm action telemetry counts only normal, fully verified v5 action results", async () => {
  const bridge = {
    async estimate(item, runDir) {
      let adaptive = completeV5Result();
      if (item.sku === "legacy") {
        adaptive = {
          adaptive_action_complete: true,
          selected_offer_id: "offer-1",
          adaptive_match: { decision: "FAST", action: "ALLOW", evidence_complete: true },
        };
      } else if (item.sku === "missing-policy") {
        adaptive = completeV5Result();
        delete adaptive.adaptive_match.policy_version;
      } else if (item.sku === "wrong-price") {
        adaptive = completeV5Result({ priceCny: 99 });
      } else if (item.sku === "blank-category") {
        adaptive = completeV5Result({
          valuableApplies: true,
          valuableCategory: "   ",
        });
      } else if (item.sku === "unverified") {
        adaptive = { ...completeV5Result(), adaptive_action_complete: false };
      }
      return {
        ok: true,
        cached: false,
        process_code: 0,
        outputPath: path.join(runDir, `${item.sku}.out`),
        ...adaptive,
      };
    },
  };
  const summary = await prewarmCandidateCosts({
    candidates: ["valid", "legacy", "missing-policy", "wrong-price", "blank-category", "unverified"]
      .map((sku) => ({ sku, sell_price: 100 })),
    bridge,
    runDir: "/tmp/prewarm-v5-contract",
    now: (() => {
      const readings = [0, 3_600_000];
      return () => readings.shift();
    })(),
  });

  assert.equal(summary.actual_live_attempt_count, 6);
  assert.equal(summary.normal_process_completion_count, 6);
  assert.equal(summary.adaptive_action_count, 1);
  assert.equal(summary.adaptive_allow_count, 1);
  assert.equal(summary.adaptive_reject_action_count, 0);
  assert.equal(summary.adaptive_action_unassessable_count, 5);
  assert.equal(summary.adaptive_action_per_hour, 1);
});

test("prewarm cost bridge passes the production sync script default and env override", () => {
  const captured = [];
  const createBridge = (options) => {
    captured.push(options);
    return { options };
  };

  createPrewarmCostBridge({
    env: {
      FLOW_B_PYTHON: "python-test",
      FLOW_B_1688_ADAPTIVE_ACTION_POLICY: "shadow",
      FLOW_B_1688_ADAPTIVE_ACTION_SAMPLE_TARGET: "123",
    },
    sharedCachePath: "/tmp/prewarm-shared-cache.json",
    workerCount: 3,
    createBridge,
  });
  createPrewarmCostBridge({
    env: { FLOW_B_1688_SCRIPT: "fixtures/custom-1688-sync.py" },
    sharedCachePath: "/tmp/prewarm-shared-cache.json",
    workerCount: 2,
    createBridge,
  });
  createPrewarmCostBridge({
    env: { FLOW_B_1688_ADAPTIVE_ACTION_POLICY: "enforce" },
    sharedCachePath: "/tmp/prewarm-shared-cache.json",
    createBridge,
  });

  assert.equal(captured[0].python, "python-test");
  assert.equal(captured[0].scriptPath, DEFAULT_1688_SYNC_SCRIPT_PATH);
  assert.equal(path.basename(captured[0].scriptPath), "flow_b_1688_sync.py");
  assert.equal(captured[0].workerCount, 3);
  assert.equal(captured[0].adaptiveActionPolicy, "shadow");
  assert.equal(captured[0].adaptiveActionSampleTarget, 123);
  assert.equal(captured[1].scriptPath, path.resolve("fixtures/custom-1688-sync.py"));
  assert.equal(captured[1].workerCount, 2);
  assert.equal(captured[1].adaptiveActionPolicy, "shadow");
  assert.equal(captured[1].adaptiveActionSampleTarget, 100);
  assert.equal(captured[2].adaptiveActionPolicy, "enforce");
});

test("live prewarm report enforces a cold, error-free 20 products/hour gate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prewarm-live-gate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const favorites = path.join(root, "favorites.jsonl");
  const states = path.join(root, "states.jsonl");
  const runDir = path.join(root, "run");
  await fs.writeFile(favorites, `${JSON.stringify({
    status: "favorited",
    sku: "live-1",
    title: "portable lamp X100",
    cover_image: "https://img.example/live-1.jpg",
    shipping_mode: "FBS",
    sale_price: 100,
    source_url: "https://www.ozon.ru/product/live-1/",
  })}\n`);
  await fs.writeFile(states, "");
  const adaptiveResult = completeV5Result();
  const bridge = {
    estimate: async (_item, estimateRunDir) => ({
      ok: true,
      cached: false,
      process_code: 0,
      outputPath: path.join(estimateRunDir, "1688", "live-1.out"),
      ...adaptiveResult,
    }),
    close: async () => {},
  };
  const readings = [0, 1_000];
  const report = await main([
    "--favorites", favorites,
    "--states", states,
    "--run-dir", runDir,
    "--shared-cache", path.join(root, "shared-cache.json"),
    "--workers", "1",
    "--limit", "1",
    "--minimum-products-per-hour", "20",
  ], {}, {
    createBridge: () => bridge,
    now: () => readings.shift(),
  });

  assert.equal(report.scope, "live-1688-prewarm");
  assert.equal(report.adaptive_action_policy, "shadow");
  assert.deepEqual({
    candidate_sku_count: report.candidate_sku_count,
    candidate_skus_sha256: report.candidate_skus_sha256,
  }, candidateCohortIdentity([{ sku: "live-1" }]));
  assert.equal(report.completed_per_hour, 3600);
  assert.equal(report.normal_process_completion_count, 1);
  assert.deepEqual(report.acceptance, {
    metric: "actual_live_recognition_attempts_per_hour",
    minimum_products_per_hour: 20,
    measured_products_per_hour: 3600,
    completed_all_candidates: true,
    attempted_all_candidates: true,
    cold_cache: true,
    process_errors_zero: true,
    error_free: true,
    no_deferred_results: true,
    no_health_circuit_backoff: true,
    speed_passed: true,
    adaptive_action_policy: "shadow",
    quality_mode: "shadow-not-enforced",
    does_not_assert: [
      "adaptive_source_correctness",
      "binary_action_correctness",
      "profitability",
    ],
    passed: true,
  });
  assert.deepEqual(report.adaptive_ready_observation, {
    metric: "adaptive_fast_products_per_hour",
    minimum_products_per_hour: 20,
    measured_products_per_hour: 3600,
    adaptive_action_policy: "shadow",
    enforced: false,
    passed_if_enforced: true,
  });
  assert.deepEqual(report.binary_action_observation, {
    metric: "complete_binary_actions_per_hour",
    measured_products_per_hour: 3600,
    action_count: 1,
    allow_count: 1,
    reject_count: 0,
    unassessable_count: 0,
    matcher_version_required: "adaptive-v5-shadow",
    policy_version_required: "adaptive-v5-policy-1",
    evidence_complete_required: true,
    readiness: "collecting",
    adaptive_action_policy: "shadow",
    quality_mode: "shadow-not-enforced",
    enforced: false,
    automatic_enforcement: false,
    manual_approval_required: true,
    note: "Live prewarm proves health and throughput only; replay labels are required for approval.",
  });
  const resultRows = (await fs.readFile(path.join(runDir, "prewarm_1688_results.jsonl"), "utf8"))
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  assert.deepEqual(resultRows, [{
    at: resultRows[0].at,
    sku: "live-1",
    ok: true,
    cached: false,
    reason: "",
    cost: null,
    source: "",
    process_code: 0,
    deferred: false,
    actual_live_attempt: true,
    normal_process_completion: true,
    output_evidence: true,
    adaptive_match: adaptiveResult.adaptive_match,
    error: null,
  }]);
});

test("live prewarm rejects an invalid speed threshold before creating a bridge", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prewarm-invalid-threshold-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const favorites = path.join(root, "favorites.jsonl");
  const states = path.join(root, "states.jsonl");
  await fs.writeFile(favorites, "");
  await fs.writeFile(states, "");
  let bridgeCreated = false;

  await assert.rejects(
    main([
      "--favorites", favorites,
      "--states", states,
      "--run-dir", path.join(root, "run"),
      "--shared-cache", path.join(root, "shared-cache.json"),
      "--minimum-products-per-hour", "not-a-number",
    ], {}, {
      createBridge: () => {
        bridgeCreated = true;
        return { close: async () => {} };
      },
    }),
    /finite non-negative number/u,
  );
  assert.equal(bridgeCreated, false);
});

test("live prewarm evidence collection rejects enforce policy before creating a bridge", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prewarm-enforce-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let bridgeCreated = false;

  await assert.rejects(
    main([
      "--favorites", path.join(root, "favorites.jsonl"),
      "--states", path.join(root, "states.jsonl"),
      "--run-dir", path.join(root, "run"),
      "--shared-cache", path.join(root, "shared-cache.json"),
    ], {
      FLOW_B_1688_ADAPTIVE_ACTION_POLICY: "enforce",
    }, {
      createBridge: () => {
        bridgeCreated = true;
        return { close: async () => {} };
      },
    }),
    /requires .*shadow.*enforce is not allowed/iu,
  );
  assert.equal(bridgeCreated, false);
});

test("health-circuit short-circuits cannot satisfy the live-attempt speed gate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prewarm-circuit-gate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const favorites = path.join(root, "favorites.jsonl");
  const states = path.join(root, "states.jsonl");
  await fs.writeFile(favorites, `${JSON.stringify({
    status: "favorited",
    sku: "circuit-1",
    title: "portable lamp X100",
    cover_image: "https://img.example/circuit-1.jpg",
    shipping_mode: "FBS",
    sale_price: 100,
    source_url: "https://www.ozon.ru/product/circuit-1/",
  })}\n`);
  await fs.writeFile(states, "");
  const readings = [0, 1];
  const report = await main([
    "--favorites", favorites,
    "--states", states,
    "--run-dir", path.join(root, "run"),
    "--shared-cache", path.join(root, "shared-cache.json"),
    "--workers", "1",
  ], {}, {
    createBridge: () => ({
      estimate: async () => ({
        ok: false,
        reason: "1688 health circuit backoff",
        deferred: true,
      }),
      close: async () => {},
    }),
    now: () => readings.shift(),
  });

  assert.equal(report.completed_per_hour, 3_600_000);
  assert.equal(report.actual_live_attempts_per_hour, 0);
  assert.equal(report.health_circuit_backoff_count, 1);
  assert.equal(report.acceptance.attempted_all_candidates, false);
  assert.equal(report.acceptance.no_health_circuit_backoff, false);
  assert.equal(report.acceptance.passed, false);
});

test("a cached v5 action cannot satisfy cold live acceptance or action collection", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prewarm-cached-gate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const favorites = path.join(root, "favorites.jsonl");
  const states = path.join(root, "states.jsonl");
  await fs.writeFile(favorites, `${JSON.stringify({
    status: "favorited",
    sku: "cached-1",
    title: "portable lamp X100",
    cover_image: "https://img.example/cached-1.jpg",
    shipping_mode: "FBS",
    sale_price: 100,
    source_url: "https://www.ozon.ru/product/cached-1/",
  })}\n`);
  await fs.writeFile(states, "");
  const runDir = path.join(root, "run");
  const readings = [0, 1];
  const report = await main([
    "--favorites", favorites,
    "--states", states,
    "--run-dir", runDir,
    "--shared-cache", path.join(root, "shared-cache.json"),
    "--workers", "1",
  ], {}, {
    createBridge: () => ({
      estimate: async () => ({
        ok: true,
        cached: true,
        process_code: 0,
        outputPath: path.join(runDir, "1688", "cached-1.out"),
        ...completeV5Result(),
      }),
      close: async () => {},
    }),
    now: () => readings.shift(),
  });

  assert.equal(report.cache_hits, 1);
  assert.equal(report.actual_live_attempt_count, 0);
  assert.equal(report.normal_process_completion_count, 0);
  assert.equal(report.adaptive_action_count, 0);
  assert.equal(report.adaptive_action_unassessable_count, 1);
  assert.equal(report.acceptance.cold_cache, false);
  assert.equal(report.acceptance.attempted_all_candidates, false);
  assert.equal(report.acceptance.completed_all_candidates, false);
  assert.equal(report.acceptance.passed, false);
});

test("a fast process-code-one crash cannot satisfy the live recognition gate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prewarm-process-error-gate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const favorites = path.join(root, "favorites.jsonl");
  const states = path.join(root, "states.jsonl");
  await fs.writeFile(favorites, `${JSON.stringify({
    status: "favorited",
    sku: "crash-1",
    title: "portable lamp X100",
    cover_image: "https://img.example/crash-1.jpg",
    shipping_mode: "FBS",
    sale_price: 100,
    source_url: "https://www.ozon.ru/product/crash-1/",
  })}\n`);
  await fs.writeFile(states, "");
  const runDir = path.join(root, "run");
  const readings = [0, 1];
  const report = await main([
    "--favorites", favorites,
    "--states", states,
    "--run-dir", runDir,
    "--shared-cache", path.join(root, "shared-cache.json"),
    "--workers", "1",
  ], {}, {
    createBridge: () => ({
      estimate: async () => ({
        ok: false,
        reason: "python worker crashed",
        process_code: 1,
        outputPath: path.join(runDir, "1688", "crash-1.out"),
      }),
      close: async () => {},
    }),
    now: () => readings.shift(),
  });

  assert.equal(report.actual_live_attempt_count, 1);
  assert.equal(report.normal_process_completion_count, 0);
  assert.equal(report.process_error_count, 1);
  assert.equal(report.errors, 1);
  assert.equal(report.rule_rejected, 0);
  assert.equal(report.acceptance.completed_all_candidates, false);
  assert.equal(report.acceptance.process_errors_zero, false);
  assert.equal(report.acceptance.error_free, false);
  assert.equal(report.acceptance.passed, false);
});
