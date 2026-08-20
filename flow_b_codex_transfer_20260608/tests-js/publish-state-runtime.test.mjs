import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createPublishState,
  reconcileRuntimeAuditOutputs,
} from "../scripts/flow_b_playwright/publish-state.mjs";
import { createRuntimeState } from "../scripts/flow_b_playwright/runtime-state.mjs";
import { restoredDailyStoreUsage } from "../scripts/flow_b_playwright/publish-runner.mjs";

async function withTempDir(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-publish-sqlite-"));
  try {
    return await callback(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function strictPublication(sku, overrides = {}) {
  const publicationAt = overrides.supply_publication_at
    ? new Date(overrides.supply_publication_at)
    : new Date();
  const supplyCheckedAt = new Date(publicationAt.getTime() - 60_000);
  const { supply_publication_at: _supplyPublicationAt, ...normalizedOverrides } = overrides;
  return {
    sku,
    profit_rate: 31.5,
    purchase_price: 10,
    online_status: "selling",
    stock: 1,
    mode: "FBS",
    shipping_mode: "FBS",
    preflight_mode: "FBS",
    fbs_evidence: {
      verified: true,
      observations: [{ mode: "FBS" }, { mode: "FBS" }],
    },
    cost_verified: true,
    cost_source: "search_first_page_p70_similarity_filtered",
    cost: {
      ok: true,
      cost: 10,
      source: "search_first_page_p70_similarity_filtered",
      prices: [9, 10, 11],
      match_evidence_key: "b".repeat(64),
      same_item_match: true,
      returned_evidence_verified: true,
      match_evidence_contract: "1688-returned-same-item-v2",
      matched_offer_count: 3,
    },
    cost_evidence: {
      contract: "1688-same-item-v1",
      source: "search_first_page_p70_similarity_filtered",
      reliable_source: true,
      same_item_match: true,
      match_evidence_key: "b".repeat(64),
      filtered_price_count: 3,
      returned_evidence_verified: true,
      match_evidence_contract: "1688-returned-same-item-v2",
      matched_offer_count: 3,
    },
    quality_gate_passed: true,
    quality_checks: {
      pure_fbs: true,
      reliable_1688_cost: true,
      profit_gt_30: true,
      prohibited_category: true,
      title: true,
      image: true,
      category: true,
      historical_and_cross_store_duplicate: true,
    },
    purchase_price_original_p70_p80: 10,
    api_call_started_at: publicationAt.toISOString(),
    supply_gate_passed: true,
    supply_candidates: [{
      platform: "1688",
      offer_id: "200000000002",
      offer_url: "https://detail.1688.com/offer/200000000002.html",
      match_type: "strong_single",
      match_evidence_key: "b".repeat(64),
    }],
    supply_evidence: {
      contract: "1688-orderable-v1",
      passed: true,
      platform: "1688",
      offer_id: "200000000002",
      offer_url: "https://detail.1688.com/offer/200000000002.html",
      item_level_match: true,
      target_variant: null,
      variant_attributes: {},
      moq: 1,
      orderable_quantity: 1,
      unit_price: 10,
      stock_state: "in_stock",
      orderable: true,
      match_evidence_key: "b".repeat(64),
      checked_at: supplyCheckedAt.toISOString(),
      valid_until: new Date(supplyCheckedAt.getTime() + 30 * 60_000).toISOString(),
    },
    ...normalizedOverrides,
  };
}

function imagePrimaryStrictPublication(sku, overrides = {}) {
  const base = strictPublication(sku);
  const signedRow = {
    offer_id: "200000000002",
    title: "GU10 red spotlight X100",
    supplier_id: "supplier-2002",
    image_url: "https://cbu01.alicdn.com/img/ibank/image-primary.jpg",
    image: { available: true, score: 0.79, color_score: 0.91, dhash_score: 0.70 },
    semantic_strength: "exact_model",
    semantic_hits_v3: {
      model: ["x100"],
      high_information: ["gu10"],
      feature: [],
      product: ["spotlight"],
    },
    spec_conflicts: [],
    accessory_conflict: false,
  };
  const imageEvidence = {
    source_contract: "1688-returned-same-item-v3",
    ...structuredClone(signedRow),
    lane: "strong_visual",
    corroborating_offer_ids: ["200000000002"],
  };
  return {
    ...base,
    ...overrides,
    target_variant: { required: true, attributes: { color: "红色", model: "GU10" } },
    cost: {
      ...base.cost,
      match_evidence_contract: "1688-returned-same-item-v3",
      selected_offer_id: "200000000002",
      balanced_supporting_offer_evidence: [structuredClone(signedRow)],
      ...(overrides.cost || {}),
    },
    cost_evidence: {
      ...base.cost_evidence,
      match_evidence_contract: "1688-returned-same-item-v3",
      selected_offer_id: "200000000002",
      ...(overrides.cost_evidence || {}),
    },
    supply_candidates: [{
      ...base.supply_candidates[0],
      match_basis: "image_primary_v1",
      image_match_evidence: structuredClone(imageEvidence),
    }],
    supply_evidence: {
      ...base.supply_evidence,
      variant_match_mode: "image_primary",
      match_basis: "image_primary_v1",
      image_match_evidence: structuredClone(imageEvidence),
      item_level_match: false,
      target_variant: { color: "red", model: "gu10" },
      variant_attributes: { color: "red" },
      variant_selection_required: true,
      variant_differences: [
        { name: "model", expected: "gu10", observed: null, kind: "unbound_soft" },
      ],
      selected_variant: {
        row_key: "sku-row-2002",
        sku_ids: ["sku-2002"],
        label: "红色 GU10",
        selection_method: "image_primary_best_target_overlap",
        soft_tie: false,
      },
      ...(overrides.supply_evidence || {}),
    },
  };
}

function persistRuntimeSupplySubmission(runtime, sku, data) {
  assert.equal(runtime.reserveSubmission(sku, {
    reason: "submission-api-call-started",
    data: {
      ...data,
      submission_intent: true,
      submitted: false,
    },
  }).recorded, true);
  assert.equal(runtime.confirmSubmission(sku, {
    reason: "erp-submission-accepted",
    data: {
      ...data,
      submitted: true,
    },
  }).recorded, true);
}

async function persistPublishStateSupplySubmission(state, data) {
  assert.equal(await state.transition(data.sku, "processing", {
    ...data,
    reason: "submission-api-call-started",
    submission_intent: true,
    submitted: false,
  }), true);
  assert.equal(await state.transition(data.sku, "processing", {
    ...data,
    reason: "erp-submission-accepted",
    submission_intent: false,
    submitted: true,
  }), true);
}

function sqliteCount(dbPath, table) {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
  } finally {
    database.close();
  }
}

test("publish state exposes atomic expired pre-call intent abandonment", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const publishedCsv = path.join(dir, "published.csv");
    const foregroundAt = new Date(Date.now() - 60_000);
    const foreground = createRuntimeState({
      dbPath,
      now: () => foregroundAt,
      ownerId: "foreground-owner",
      generationId: "foreground-generation",
      submissionLeaseMs: 1_000,
    });
    assert.equal(foreground.reserveSubmission("expired-pre-call", {
      reason: "submission-intent",
      data: {
        submission_intent: true,
        submission_payload: { rows: [{ offer_id: "expired-pre-call" }] },
      },
    }).recorded, true);
    foreground.close();

    const state = createPublishState({
      runDir,
      publishedCsv,
      runtimeStateDbPath: dbPath,
      exportRuntimeAuditOnClose: false,
    });
    await state.load();
    const retryAt = new Date(Date.now() - 1).toISOString();
    const abandoned = await state.abandonPreCallSubmissionIntent("expired-pre-call", {
      reason: "submission-not-sent-deferred",
      nextEligibleAt: retryAt,
      expectedOwnerId: "foreground-owner",
      expectedGenerationId: "foreground-generation",
      data: { original_reason: "submission-profit-context-invalid" },
    });
    assert.equal(abandoned.recorded, true);
    assert.equal(abandoned.reservation.status, "closed");
    assert.equal(abandoned.entry.status, "failed");
    assert.equal(abandoned.entry.data.failure_class, "transient");
    assert.equal(abandoned.entry.data.submission_intent, false);
    assert.equal(abandoned.entry.data.fresh_pipeline_required, true);
    assert.equal(abandoned.entry.data.retry_at, retryAt);

    const failedEvents = (await fs.readFile(path.join(runDir, "failed.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(failedEvents.length, 1);
    assert.equal(failedEvents[0].sku, "expired-pre-call");
    assert.equal(failedEvents[0].data.reason, "submission-not-sent-deferred");

    const reader = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const reservation = reader.prepare(`
        SELECT owner_id, generation_id, status, title_key, lease_expires_at
        FROM submission_reservations
        WHERE sku = 'expired-pre-call'
      `).get();
      assert.deepEqual({ ...reservation }, {
        owner_id: "foreground-owner",
        generation_id: "foreground-generation",
        status: "closed",
        title_key: null,
        lease_expires_at: null,
      });
    } finally {
      reader.close();
    }
    await state.close();

    const previousOwner = process.env.FLOW_B_SUBMISSION_OWNER;
    const previousGeneration = process.env.FLOW_B_WORKER_GENERATION;
    process.env.FLOW_B_SUBMISSION_OWNER = "foreground-owner";
    process.env.FLOW_B_WORKER_GENERATION = "foreground-generation";
    let persistentSession = null;
    try {
      persistentSession = createPublishState({
        runDir,
        publishedCsv,
        runtimeStateDbPath: dbPath,
        exportRuntimeAuditOnClose: false,
      });
      await persistentSession.load();
      const resetAt = abandoned.state.data.pre_call_intent_reset_at;
      const staleCallback = await persistentSession.transition("expired-pre-call", "processing", {
        reason: "stale-pre-call-callback",
        submission_intent: true,
        submitted: false,
        prepared_at: resetAt,
        profit_recheck_context: { observed_at: resetAt },
      });
      assert.equal(staleCallback, false);
      assert.equal(persistentSession.entryOf("expired-pre-call").status, "failed");
      assert.equal(
        persistentSession.entryOf("expired-pre-call").data.pre_call_intent_abandoned,
        true,
      );

      const freshPreparedAt = new Date(Date.parse(resetAt) + 1).toISOString();
      const freshPipeline = await persistentSession.transition("expired-pre-call", "processing", {
        reason: "fresh-pipeline-prepared",
        submission_intent: true,
        submitted: false,
        prepared_at: freshPreparedAt,
        profit_recheck_context: { observed_at: freshPreparedAt },
        supply_evidence: { checked_at: freshPreparedAt },
        submission_payload: { rows: [{ offer_id: "expired-pre-call-fresh" }] },
      });
      assert.equal(freshPipeline, true);
      const freshEntry = persistentSession.entryOf("expired-pre-call");
      assert.equal(freshEntry.status, "processing");
      assert.equal(freshEntry.data.prepared_at, freshPreparedAt);
      assert.equal(freshEntry.data.pre_call_intent_abandoned, undefined);
      assert.equal(freshEntry.data.pre_call_intent_reset_at, undefined);
      assert.equal(freshEntry.data.fresh_pipeline_required, undefined);
    } finally {
      await persistentSession?.close();
      if (previousOwner === undefined) delete process.env.FLOW_B_SUBMISSION_OWNER;
      else process.env.FLOW_B_SUBMISSION_OWNER = previousOwner;
      if (previousGeneration === undefined) delete process.env.FLOW_B_WORKER_GENERATION;
      else process.env.FLOW_B_WORKER_GENERATION = previousGeneration;
    }
  });
});

test("external SQLite is authoritative while legacy JSONL and CSV remain compatible audit outputs", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const publishedCsv = path.join(dir, "published.csv");
    const legacyState = path.join(dir, "legacy-state.jsonl");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(publishedCsv, [
      "product_link",
      "https://www.ozon.ru/product/historical",
      "",
    ].join("\n"));
    const legacyText = `${JSON.stringify({
      sku: "legacy-poison",
      status: "skipped",
      data: { reason: "prohibited-category" },
    })}\n`;
    await fs.writeFile(legacyState, legacyText);

    const state = createPublishState({
      runDir,
      publishedCsv,
      pendingStateFiles: [legacyState],
      runtimeStateDbPath: dbPath,
    });
    await state.load();
    assert.equal(state.hasPublished("historical"), true);
    assert.equal(state.statusOf("legacy-poison"), "skipped");
    const strictOne = strictPublication("strict-one");
    await persistPublishStateSupplySubmission(state, strictOne);
    assert.equal(await state.recordPublished(strictOne), true);
    assert.equal(await state.recordPublished(strictOne), false);
    await state.close();

    assert.equal(sqliteCount(dbPath, "strict_publications"), 1);
    assert.match(await fs.readFile(path.join(runDir, "published.jsonl"), "utf8"), /strict-one/);
    assert.match(await fs.readFile(publishedCsv, "utf8"), /strict-one/);
    assert.match(await fs.readFile(path.join(runDir, "runtime_state_audit.jsonl"), "utf8"), /strict-confirmed/);
    assert.equal(await fs.readFile(legacyState, "utf8"), legacyText);

    const eventCount = sqliteCount(dbPath, "events");
    const restored = createPublishState({
      runDir,
      publishedCsv,
      runtimeStateDbPath: dbPath,
    });
    await restored.load();
    assert.equal(restored.hasPublished("strict-one"), true);
    assert.equal(restored.runPublishedCount(), 1);
    assert.equal(await restored.recordPublished(strictPublication("strict-one")), false);
    await restored.close();
    assert.equal(sqliteCount(dbPath, "events"), eventCount);
  });
});

test("native SQLite restore skips oversized legacy histories and hydrates latest SKU state", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const publishedCsv = path.join(dir, "published.csv");
    const state = createPublishState({ runDir, publishedCsv, runtimeStateDbPath: dbPath });
    assert.equal(await state.transition("sqlite-only", "processing", {
      reason: "submission-reconciliation",
      submitted: true,
      store_id: 106637,
      selected_at: "2026-08-03T00:00:00.000Z",
    }), true);
    await state.close();

    await fs.rm(path.join(runDir, "sku_states.jsonl"));
    await fs.mkdir(path.join(runDir, "sku_states.jsonl"));
    const unreadablePendingHistory = path.join(dir, "pending-history.jsonl");
    await fs.mkdir(unreadablePendingHistory);

    const restored = createPublishState({
      runDir,
      publishedCsv,
      pendingStateFiles: [unreadablePendingHistory],
      runtimeStateDbPath: dbPath,
    });
    await restored.load();
    assert.equal(restored.statusOf("sqlite-only"), "processing");
    assert.equal(restored.entryOf("sqlite-only").data.submitted, true);
    assert.equal(restored.directAcceptedCount(runDir), 1);
    await restored.close();
  });
});

test("recovered ERP acceptance takes over an expired worker lease without another POST", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const publishedCsv = path.join(dir, "published.csv");
    await fs.mkdir(runDir, { recursive: true });

    const deadWorker = createRuntimeState({
      dbPath,
      now: () => new Date("2026-08-13T07:22:21.000Z"),
      ownerId: "dead-worker",
      generationId: "dead-generation",
      submissionLeaseMs: 1_000,
    });
    assert.equal(deadWorker.reserveSubmission("recovered-expired-lease", {
      reason: "submission-api-call-started",
      data: {
        ...strictPublication("recovered-expired-lease", {
          supply_publication_at: "2026-08-13T07:22:21.000Z",
        }),
        runtime_run_dir: runDir,
        store_id: 113154,
        offer_id: "mz-recovered-expired-lease",
        api_call_started_at: "2026-08-13T07:22:21.000Z",
        api_call_attempts_total: 1,
        submission_intent: true,
        submitted: false,
      },
    }).recorded, true);
    deadWorker.close();

    const recoveredWorker = createPublishState({
      runDir,
      publishedCsv,
      runtimeStateDbPath: dbPath,
    });
    await recoveredWorker.load();
    const recorded = await recoveredWorker.transition("recovered-expired-lease", "processing", {
      reason: "erp-submission-accepted",
      runtime_run_dir: runDir,
      store_id: 113154,
      offer_id: "mz-recovered-expired-lease",
      submission_intent: false,
      submitted: true,
      submission_pending: false,
      accepted_at: "2026-08-13T07:24:00.000Z",
      publish_result: { recovered: true, evidence: "import-log" },
    });
    assert.equal(recorded, true);
    await recoveredWorker.close();

    const reader = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const reservation = reader.prepare(`
        SELECT status, owner_id, generation_id,
               CAST(json_extract(data_json, '$.api_call_attempts_total') AS INTEGER) AS attempts
        FROM submission_reservations
        WHERE sku = 'recovered-expired-lease'
      `).get();
      assert.equal(reservation.status, "submitted");
      assert.notEqual(reservation.owner_id, "dead-worker");
      assert.notEqual(reservation.generation_id, "dead-generation");
      assert.equal(reservation.attempts, 1);
    } finally {
      reader.close();
    }
  });
});

test("native SQLite restore compacts terminal evidence while preserving summary and submitted quota state", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "current-run");
    const previousRunDir = path.join(dir, "previous-run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const publishedCsv = path.join(dir, "published.csv");
    const runtime = createRuntimeState({ dbPath });
    const terminalPayload = "x".repeat(16 * 1024);
    for (let index = 0; index < 64; index += 1) {
      runtime.recordSkip(`terminal-history-${index}`, {
        reason: "historical-policy-rejection",
        data: {
          runtime_run_dir: runDir,
          terminal_payload: terminalPayload,
        },
      });
    }
    runtime.reserveSubmission("terminal-submitted", {
      reason: "submission-intent",
      data: {
        runtime_run_dir: runDir,
        store_id: 106637,
        submitted_at: "2026-08-12T04:00:00.000Z",
      },
    });
    runtime.confirmSubmission("terminal-submitted", {
      reason: "erp-submission-accepted",
      data: { submitted: true },
    });
    runtime.recordFailure("terminal-submitted", {
      reason: "daily-product-limit",
      kind: "deterministic",
      data: {
        runtime_run_dir: runDir,
        store_id: 106637,
        submitted: true,
        submitted_at: "2026-08-12T04:00:00.000Z",
        terminal_payload: terminalPayload,
      },
    });
    runtime.recordFailure("legacy-terminal-submitted", {
      reason: "historical-submission-failure",
      kind: "deterministic",
      data: {
        runtime_run_dir: runDir,
        store_id: 106637,
        submitted: true,
        submitted_at: "2026-08-12T04:01:00.000Z",
        terminal_payload: terminalPayload,
      },
    });
    runtime.recordSkip("terminal-selected-only", {
      reason: "historical-selection-skip",
      data: {
        store_id: 106637,
        selected_at: "2026-08-12T04:02:00.000Z",
        terminal_payload: terminalPayload,
      },
    });
    runtime.recordProcessing("prior-run-pending", {
      reason: "reconciliation-import-pending",
      data: {
        runtime_run_dir: previousRunDir,
        submitted: true,
        submission_pending: true,
        store_id: 106637,
      },
    });
    runtime.recordProcessing("legacy-pending", {
      reason: "reconciliation-import-pending",
      data: {
        submitted: true,
        submission_pending: true,
        store_id: 106637,
      },
    });
    runtime.recordFailure("daily-retry-exhausted", {
      reason: "temporary-timeout",
      kind: "transient",
      nextEligibleAt: "2026-08-12T00:00:00.000Z",
      data: { runtime_run_dir: previousRunDir },
    });
    runtime.recordFailure("daily-retry-exhausted", {
      reason: "temporary-timeout",
      kind: "transient",
      nextEligibleAt: "2026-08-12T00:00:00.000Z",
      data: { runtime_run_dir: previousRunDir },
    });
    const publishedCurrentRun = {
      ...strictPublication("published-current-run", {
        store_id: 106637,
        published_at: "2026-08-12T04:00:00.000Z",
      }),
      runtime_run_dir: path.resolve(runDir),
    };
    persistRuntimeSupplySubmission(runtime, "published-current-run", publishedCurrentRun);
    runtime.recordStrictPublication("published-current-run", {
      reason: "strict-confirmed",
      data: publishedCurrentRun,
    });
    runtime.close();

    const restored = createPublishState({
      runDir,
      publishedCsv,
      runtimeStateDbPath: dbPath,
      exportRuntimeAuditOnClose: false,
    });
    await restored.load();
    const startupEntries = restored.entries();
    assert.equal(startupEntries.length, 71);
    const startupBySku = new Map(startupEntries.map((entry) => [entry.sku, entry]));
    assert.deepEqual(startupBySku.get("terminal-history-63").data, {
      reason: "historical-policy-rejection",
      terminal: true,
      strict_confirmed: false,
      failure_class: "deterministic",
    });
    assert.equal(startupBySku.get("terminal-submitted").data.submitted, true);
    assert.equal(startupBySku.get("terminal-submitted").data.store_id, 106637);
    assert.equal(startupBySku.get("terminal-submitted").data.terminal_payload, undefined);
    assert.equal(startupBySku.get("legacy-terminal-submitted").data.submitted, true);
    assert.equal(startupBySku.get("legacy-terminal-submitted").data.store_id, 106637);
    assert.equal(startupBySku.get("legacy-terminal-submitted").data.terminal_payload, undefined);
    assert.equal(startupBySku.get("terminal-selected-only").data.selected_at, "2026-08-12T04:02:00.000Z");
    assert.equal(startupBySku.get("terminal-selected-only").data.terminal_payload, undefined);
    assert.equal(startupBySku.get("daily-retry-exhausted").data.transient_attempts, 2);
    assert.equal(startupBySku.get("daily-retry-exhausted").data.terminal, true);
    assert.equal(startupBySku.get("daily-retry-exhausted").data.retry_limit_scope, "shanghai-day");
    assert.equal(
      restoredDailyStoreUsage(startupEntries, 106637, new Date("2026-08-12T06:00:00.000Z")),
      3,
    );
    assert.equal(restored.directTargetUsage(runDir), 3);
    assert.equal(restored.directAcceptedCount(runDir), 3);
    assert.equal(restored.runPublishedCount(), 1);
    assert.deepEqual(restored.summary(100), {
      published: 1,
      failed: 3,
      skipped: 65,
      remaining: 99,
    });
    assert.equal(restored.entryOf("prior-run-pending").data.submission_pending, true);
    assert.equal(restored.entryOf("legacy-pending").data.submission_pending, true);

    // Startup hydration retains the compact terminal status, while the indexed
    // per-SKU path still exposes its complete authoritative evidence.
    assert.equal(restored.statusOf("terminal-history-63"), "skipped");
    assert.equal(restored.entryOf("terminal-history-63").data.terminal_payload, terminalPayload);
    assert.equal(restored.entryOf("terminal-submitted").data.terminal_payload, terminalPayload);
    assert.equal(restored.canAttempt("terminal-history-63").allowed, false);
    assert.equal(await restored.recordSelected({
      sku: "terminal-selected-only",
      store_id: 106637,
    }), false);
    await restored.close();
  });
});

test("direct production can disable growing legacy state and close-time audit exports", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const state = createPublishState({
      runDir,
      publishedCsv: path.join(dir, "published.csv"),
      runtimeStateDbPath: dbPath,
      writeLegacyStateAudit: false,
      exportRuntimeAuditOnClose: false,
    });

    assert.equal(await state.transition("sqlite-audit-only", "processing", {
      reason: "direct-processing",
    }), true);
    await state.close();

    assert.equal(sqliteCount(dbPath, "sku_state"), 1);
    await assert.rejects(fs.access(path.join(runDir, "sku_states.jsonl")), /ENOENT/);
    await assert.rejects(fs.access(path.join(runDir, "runtime_state_audit.jsonl")), /ENOENT/);
  });
});

test("SQLite-backed publish state caps fresh transient failures without charging reconciliation delays", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const publishedCsv = path.join(dir, "published.csv");
    const state = createPublishState({
      runDir,
      publishedCsv,
      runtimeStateDbPath: dbPath,
    });

    assert.equal(await state.transition("poison", "failed", {
      reason: "fbs-evidence-missing",
      terminal: true,
    }), true);
    assert.equal(await state.transition("poison", "processing", { reason: "must-not-run" }), false);
    assert.equal(state.entryOf("poison").data.terminal, true);

    const eligible = new Date(Date.now() - 1_000).toISOString();
    assert.equal(await state.transition("retry", "failed", {
      reason: "ozon-detail-soft-block-deferred",
      retry_at: eligible,
    }), true);
    assert.equal(await state.transition("retry", "processing", { reason: "retry-two" }), true);
    assert.equal(await state.transition("retry", "failed", {
      reason: "ozon-detail-soft-block-deferred",
      retry_at: eligible,
    }), true);
    assert.equal(await state.transition("retry", "processing", { reason: "forbidden-third-retry" }), false);
    assert.equal(state.canAttempt("retry").allowed, false);
    assert.equal(state.canAttempt("retry").reason, "daily-transient-limit");
    assert.equal(state.entryOf("retry").data.terminal, true);
    assert.equal(state.entryOf("retry").data.transient_attempts, 2);

    const pendingAt = new Date(Date.now() - 1_000).toISOString();
    assert.equal(await state.transition("pending", "processing", {
      reason: "publish-final-status-timeout",
      submitted: true,
      next_reconcile_at: pendingAt,
    }), true);
    assert.equal(await state.transition("pending", "processing", {
      reason: "reconciliation-import-pending",
      submitted: true,
      next_reconcile_at: pendingAt,
    }), true);
    assert.equal(await state.transition("pending", "processing", {
      reason: "reconciliation-import-pending",
      submitted: true,
      next_reconcile_at: pendingAt,
    }), true);
    assert.equal(state.entryOf("pending").data.terminal, false);
    assert.equal(state.entryOf("pending").data.transient_attempts, 0);
    assert.equal(state.canAttempt("pending").allowed, true);
    await state.close();

    const auditRows = (await fs.readFile(path.join(runDir, "sku_states.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(auditRows.some((row) => row.data?.reason === "must-not-run"), false);
    assert.equal(auditRows.some((row) => row.data?.reason === "forbidden-third-retry"), false);
  });
});

test("confirmed ERP submission stays accepted when a decorative processing transition is ineligible", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const state = createPublishState({
      runDir,
      publishedCsv: path.join(dir, "published.csv"),
      runtimeStateDbPath: dbPath,
    });
    const submissionData = strictPublication("atomic-accepted");

    assert.equal(await state.transition("atomic-accepted", "processing", {
      ...submissionData,
      reason: "submission-intent",
      submission_intent: true,
      submitted: false,
      store_id: 106637,
      offer_id: "mz-atomic-accepted",
      api_call_attempts_total: 1,
    }), true);

    // Simulate concurrent reconciliation exhausting the ordinary processing
    // retry budget after the POST reservation but before the accepted response
    // is persisted. Confirmation must remain the authoritative commit point.
    const concurrent = createRuntimeState({
      dbPath,
      ownerId: "concurrent-reconciliation",
      generationId: "concurrent-generation",
    });
    const retryAt = new Date(Date.now() - 1_000).toISOString();
    assert.equal(concurrent.recordFailure("atomic-accepted", {
      reason: "publish-final-status-timeout",
      kind: "transient",
      nextEligibleAt: retryAt,
      data: { api_call_started_at: submissionData.api_call_started_at },
    }).recorded, true);
    assert.equal(concurrent.recordFailure("atomic-accepted", {
      reason: "publish-final-status-timeout",
      kind: "transient",
      nextEligibleAt: retryAt,
      data: { api_call_started_at: submissionData.api_call_started_at },
    }).recorded, true);
    concurrent.close();

    assert.equal(await state.transition("atomic-accepted", "processing", {
      reason: "submission-accepted",
      submitted: true,
      submission_intent: false,
      submission_pending: false,
      store_id: 106637,
      offer_id: "mz-atomic-accepted",
      api_call_accepted_at: "2026-08-12T03:00:00.000Z",
      api_call_completed_at: "2026-08-12T03:00:00.000Z",
      api_call_attempts_total: 1,
    }), true);

    const observer = createRuntimeState({
      dbPath,
      ownerId: "acceptance-observer",
      generationId: "acceptance-observer-generation",
    });
    assert.equal(observer.submissionReservation("atomic-accepted").status, "submitted");
    assert.equal(observer.submissionReservation("atomic-accepted").data.api_call_attempts_total, 1);
    observer.close();
    assert.equal(state.entryOf("atomic-accepted").data.submitted, true);
    await state.close();
  });
});

test("load idempotently projects missing submitted reservations to ERP accepted audit", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const publishedCsv = path.join(dir, "published.csv");
    const runtime = createRuntimeState({
      dbPath,
      ownerId: "projection-publisher",
      generationId: "projection-generation",
    });
    assert.equal(runtime.reserveSubmission("projection-missing", {
      reason: "submission-intent",
      data: {
        runtime_run_dir: runDir,
        store_id: 106637,
        offer_id: "mz-projection-missing",
        api_call_attempts_total: 1,
      },
    }).recorded, true);
    assert.equal(runtime.confirmSubmission("projection-missing", {
      reason: "erp-submission-accepted",
      data: {
        runtime_run_dir: runDir,
        store_id: 106637,
        offer_id: "mz-projection-missing",
        submitted: true,
        api_call_accepted_at: "2026-08-12T03:05:00.000Z",
        api_call_completed_at: "2026-08-12T03:05:00.000Z",
        api_call_attempts_total: 1,
      },
    }).recorded, true);
    runtime.close();

    const concurrentStates = Array.from({ length: 2 }, () => createPublishState({
      runDir,
      publishedCsv,
      runtimeStateDbPath: dbPath,
    }));
    await Promise.all(concurrentStates.map((state) => state.load()));
    await Promise.all(concurrentStates.map((state) => state.close()));
    const restarted = createPublishState({ runDir, publishedCsv, runtimeStateDbPath: dbPath });
    await restarted.load();
    await restarted.close();

    const acceptedRows = (await fs.readFile(path.join(runDir, "erp_accepted.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(acceptedRows, [{
      at: "2026-08-12T03:05:00.000Z",
      sku: "projection-missing",
      store_id: 106637,
      accepted_at: "2026-08-12T03:05:00.000Z",
      offer_id: "mz-projection-missing",
    }]);

    const observer = createRuntimeState({
      dbPath,
      ownerId: "projection-observer",
      generationId: "projection-observer-generation",
    });
    assert.equal(observer.submissionReservation("projection-missing").data.api_call_attempts_total, 1);
    observer.close();
  });
});

test("load repairs a missing ERP accepted projection after reconciliation closes the submitted reservation", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const publishedCsv = path.join(dir, "published.csv");
    const runtime = createRuntimeState({
      dbPath,
      ownerId: "closed-projection-publisher",
      generationId: "closed-projection-generation",
    });
    const closedProjectionSupply = strictPublication("closed-projection");
    assert.equal(runtime.reserveSubmission("closed-projection", {
      reason: "submission-intent",
      data: {
        ...closedProjectionSupply,
        runtime_run_dir: runDir,
        store_id: 106637,
        offer_id: "mz-closed-projection",
        api_call_attempts_total: 1,
      },
    }).recorded, true);
    assert.equal(runtime.confirmSubmission("closed-projection", {
      reason: "erp-submission-accepted",
      data: {
        runtime_run_dir: runDir,
        store_id: 106637,
        offer_id: "mz-closed-projection",
        submitted: true,
        api_call_completed_at: "2026-08-12T03:07:00.000Z",
        api_call_attempts_total: 1,
      },
    }).recorded, true);
    assert.equal(runtime.recordTerminalOutcome("closed-projection", {
      reason: "background-online",
      stage: "online",
      data: {
        ...runtime.submissionReservation("closed-projection").data,
        runtime_run_dir: runDir,
        store_id: 106637,
        offer_id: "mz-closed-projection",
        submitted: true,
        api_call_completed_at: "2026-08-12T03:07:00.000Z",
        api_call_attempts_total: 1,
        outcome_status: "online",
      },
    }).recorded, true);
    assert.equal(runtime.submissionReservation("closed-projection").status, "closed");
    runtime.close();

    const first = createPublishState({ runDir, publishedCsv, runtimeStateDbPath: dbPath });
    await first.load();
    assert.deepEqual(first.erpAcceptedAuditReconciliation(), { submitted: 1, added: 1 });
    await first.close();
    const second = createPublishState({ runDir, publishedCsv, runtimeStateDbPath: dbPath });
    await second.load();
    assert.deepEqual(second.erpAcceptedAuditReconciliation(), { submitted: 1, added: 0 });
    await second.close();

    const acceptedRows = (await fs.readFile(path.join(runDir, "erp_accepted.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(acceptedRows, [{
      at: "2026-08-12T03:07:00.000Z",
      sku: "closed-projection",
      store_id: 106637,
      accepted_at: "2026-08-12T03:07:00.000Z",
      offer_id: "mz-closed-projection",
    }]);
  });
});

test("SQLite-backed strict publication rejects weakened quality evidence before writing compatibility files", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const publishedCsv = path.join(dir, "published.csv");
    const state = createPublishState({
      runDir,
      publishedCsv,
      runtimeStateDbPath: dbPath,
    });

    await assert.rejects(
      state.recordPublished(strictPublication("bad-fbs", {
        mode: "FBO",
        shipping_mode: "FBO",
        fbs_evidence: { verified: false },
      })),
      /pure FBS/,
    );
    await assert.rejects(
      state.recordPublished(strictPublication("bad-profit", { profit_rate: 30 })),
      /profit_rate > 30/,
    );
    await assert.rejects(
      state.recordPublished(strictPublication("bad-cost", { purchase_price: 0 })),
      /reliable 1688 cost/,
    );
    const missingSupply = strictPublication("missing-supply");
    delete missingSupply.supply_gate_passed;
    delete missingSupply.supply_evidence;
    await assert.rejects(
      state.recordPublished(missingSupply),
      /SupplyEvidenceV1/,
    );
    const forgedSupply = strictPublication("forged-supply");
    forgedSupply.supply_evidence = {
      ...forgedSupply.supply_evidence,
      offer_url: "https://example.invalid/offer/200000000002.html",
    };
    await assert.rejects(
      state.recordPublished(forgedSupply),
      /bound 1688 offer ID and URL/,
    );
    const softTieImage = imagePrimaryStrictPublication("image-soft-tie", {
      supply_evidence: {
        selected_variant: {
          row_key: "sku-row-2002",
          label: "红色 GU10",
          selection_method: "image_primary_soft_tie_dom_order",
          soft_tie: true,
        },
      },
    });
    await assert.rejects(
      state.recordPublished(softTieImage),
      /non-ambiguous selected variant row/iu,
    );
    const unsupportedSelectionImage = imagePrimaryStrictPublication("image-unsupported-selection", {
      supply_evidence: {
        selected_variant: {
          row_key: "sku-row-2002",
          label: "红色 GU10",
          selection_method: "image_primary_orderable_row",
          soft_tie: false,
        },
      },
    });
    await assert.rejects(
      state.recordPublished(unsupportedSelectionImage),
      /non-ambiguous selected variant row/iu,
    );
    const unboundCostImage = imagePrimaryStrictPublication("image-unbound-cost", {
      cost: { balanced_supporting_offer_evidence: [] },
    });
    await assert.rejects(
      state.recordPublished(unboundCostImage),
      /bound signed supporting cost row/iu,
    );
    const forgedDifferenceImage = imagePrimaryStrictPublication("image-forged-difference", {
      supply_evidence: {
        variant_differences: [
          { name: "model", expected: "gu11", observed: null, kind: "unbound_soft" },
        ],
      },
    });
    await assert.rejects(
      state.recordPublished(forgedDifferenceImage),
      /does not match the unbound target attributes/iu,
    );
    await state.close();

    assert.equal(sqliteCount(dbPath, "strict_publications"), 0);
    await assert.rejects(fs.access(path.join(runDir, "published.jsonl")));
  });
});

test("load and close idempotently repair missing strict JSONL and CSV audit outputs from SQLite", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const publishedCsv = path.join(dir, "published.csv");
    const runtime = createRuntimeState({
      dbPath,
      now: () => new Date("2026-07-29T01:00:00.000Z"),
    });
    const repairStrict = {
      ...strictPublication("repair-strict", {
        store_id: 106637,
        store_name: "丽丽二号",
        published_at: "2026-07-29T01:00:00.000Z",
        supply_publication_at: "2026-07-29T01:00:00.000Z",
      }),
      runtime_run_dir: path.resolve(runDir),
    };
    persistRuntimeSupplySubmission(runtime, "repair-strict", repairStrict);
    runtime.recordStrictPublication("repair-strict", {
      reason: "strict-confirmed",
      data: repairStrict,
    });
    runtime.close();

    const standalone = await reconcileRuntimeAuditOutputs({
      runDir,
      publishedCsv,
      runtimeStateDbPath: dbPath,
    });
    assert.equal(standalone.strict, 1);
    assert.equal(standalone.published_jsonl_added, 1);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = createPublishState({
        runDir,
        publishedCsv,
        runtimeStateDbPath: dbPath,
      });
      await state.load();
      assert.equal(state.runPublishedCount(), 1);
      await state.reconcileStrictAuditOutputs();
      await state.close();
    }

    const publishedRows = (await fs.readFile(path.join(runDir, "published.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    const stateRows = (await fs.readFile(path.join(runDir, "sku_states.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    const globalCsvRows = (await fs.readFile(publishedCsv, "utf8")).trim().split(/\r?\n/u);
    const storeCsvRows = (await fs.readFile(path.join(runDir, "published_store_106637.csv"), "utf8"))
      .trim().split(/\r?\n/u);
    assert.equal(publishedRows.filter((row) => row.sku === "repair-strict").length, 1);
    assert.equal(stateRows.filter((row) => row.sku === "repair-strict" && row.status === "published").length, 1);
    assert.equal(globalCsvRows.filter((row) => row.includes("/repair-strict")).length, 1);
    assert.equal(storeCsvRows.filter((row) => row.includes(",repair-strict,")).length, 1);
  });
});

test("close waits for ordinary active transitions and rejects operations started after closing", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const state = createPublishState({
      runDir,
      publishedCsv: path.join(dir, "published.csv"),
      runtimeStateDbPath: dbPath,
    });
    await state.load();

    const inFlight = state.transition("in-flight", "processing", {
      reason: "processing-started",
    });
    const closing = state.close();
    await assert.rejects(
      state.transition("too-late", "processing", { reason: "must-not-start" }),
      /publish state is closing/,
    );
    assert.equal(await inFlight, true);
    await closing;
    await state.close();

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(
        database.prepare("SELECT count(*) AS count FROM sku_state WHERE sku = 'in-flight'").get().count,
        1,
      );
      assert.equal(
        database.prepare("SELECT count(*) AS count FROM sku_state WHERE sku = 'too-late'").get().count,
        0,
      );
    } finally {
      database.close();
    }
    assert.match(await fs.readFile(path.join(runDir, "sku_states.jsonl"), "utf8"), /in-flight/);
  });
});
