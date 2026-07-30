import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStagedGateState,
  evaluateLiveStagedGate,
  runtimeEvidenceToAcceptanceEvents,
  submissionGatePolicy,
} from "../scripts/flow_b_playwright/live-acceptance-gates.mjs";

const START = "2026-07-30T00:00:00.000Z";
const minute = (value) => new Date(Date.parse(START) + value * 60_000).toISOString();

function strictData(index, overrides = {}) {
  return {
    runtime_run_dir: "/tmp/formal-run",
    sku: `sku-${index}`,
    store_id: 106637,
    selected_at: minute(index),
    api_call_started_at: minute(index + 0.1),
    published_at: minute(index + 0.5),
    online_status: "selling",
    stock: 1,
    profit_rate: 41,
    shipping_mode: "FBS",
    fbs_evidence: { verified: true },
    purchase_price: 2,
    cost_verified: true,
    cost_source: "search_first_page_p70_similarity_filtered",
    cost: {
      ok: true,
      cost: 2,
      source: "search_first_page_p70_similarity_filtered",
      prices: [1.8, 2, 2.2],
      match_evidence_key: "c".repeat(64),
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
      match_evidence_key: "c".repeat(64),
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
    ...overrides,
  };
}

test("formal staged gates freeze one run, one clock, and exactly three initial SKUs", () => {
  const state = buildStagedGateState({
    runId: "fixed-500",
    runDir: "/tmp/formal-run",
    startedAt: START,
    endedAt: minute(1_440),
    targetSkus: ["3", "1", "2", "2"],
    identity: {
      commit_sha: "abc",
      config_sha256: "cfg",
      source_set_sha256: "src",
      state_schema_version: 3,
    },
  });

  assert.deepEqual(state.submission_gate, {
    phase: "three-sku",
    target_skus: ["1", "2", "3"],
  });
  assert.equal(state.gates.thirty_minute.ended_at, minute(30));
  assert.equal(state.gates.two_hour_a.ended_at, minute(120));
  assert.equal(state.gates.two_hour_b.started_at, minute(120));
  assert.equal(state.gates.two_hour_b.ended_at, minute(240));
  assert.equal(state.gates.twenty_four_hour.ended_at, minute(1_440));
});

test("submission gate fails closed until the persisted three-SKU prefix is released", () => {
  assert.deepEqual(submissionGatePolicy({
    phase: "three-sku",
    target_skus: ["a", "b", "c"],
  }), {
    phase: "three-sku",
    allowed_skus: new Set(["a", "b", "c"]),
  });
  assert.equal(submissionGatePolicy({ phase: "released", target_skus: ["a", "b", "c"] }).allowed_skus, null);
  assert.throws(
    () => submissionGatePolicy({ phase: "three-sku", target_skus: ["a", "b"] }),
    /exactly three/,
  );
  assert.throws(() => submissionGatePolicy({ phase: "failed", target_skus: ["a", "b", "c"] }), /closed/);
});

test("SQLite evidence maps one accepted submission and complete strict quality evidence", () => {
  const data = strictData(1);
  const events = runtimeEvidenceToAcceptanceEvents({
    runDir: "/tmp/formal-run",
    runtimeEvents: [
      {
        id: 1,
        sku: "sku-1",
        stage: "processing",
        reason: "submission-intent",
        terminal: false,
        strict: false,
        data,
        occurredAt: minute(1),
      },
      {
        id: 2,
        sku: "sku-1",
        stage: "submitted",
        reason: "submission-accepted",
        terminal: false,
        strict: false,
        data: { ...data, submitted: true },
        occurredAt: minute(1.2),
      },
      {
        id: 3,
        sku: "sku-1",
        stage: "submitted",
        reason: "submission-reconciliation",
        terminal: false,
        strict: false,
        data: { ...data, submitted: true },
        occurredAt: minute(1.3),
      },
      {
        id: 4,
        sku: "sku-1",
        stage: "published",
        reason: "strict-confirmed",
        terminal: true,
        strict: true,
        data,
        occurredAt: minute(1.5),
      },
    ],
    strictPublications: [{
      sku: "sku-1",
      publishedAt: minute(1.5),
      data,
    }],
  });

  assert.equal(events.filter((event) => event.type === "sku-transition" && event.status === "submitted").length, 1);
  const strict = events.find((event) => event.type === "strict-confirmed");
  assert.equal(strict.same_item_1688, true);
  assert.equal(strict.cost_reliable, true);
  assert.equal(strict.duplicate_precheck, true);
  assert.equal(strict.forbidden_category, false);
  assert.equal(strict.submitted_at, data.api_call_started_at);
});

test("live strict evidence rejects an arbitrary positive cost without reliable same-item proof", () => {
  const data = strictData(2, {
    cost_source: "arbitrary-positive-number",
    cost: { ok: true, cost: 2 },
    cost_evidence: null,
  });
  const events = runtimeEvidenceToAcceptanceEvents({
    runDir: "/tmp/formal-run",
    strictPublications: [{
      sku: "sku-2",
      publishedAt: minute(2),
      data,
    }],
  });
  const strict = events.find((event) => event.type === "strict-confirmed");
  assert.equal(strict.same_item_1688, false);
  assert.equal(strict.cost_reliable, false);
});

test("live two-hour gate excludes and reports a carry-in without failing solely for its presence", () => {
  const strict = Array.from({ length: 70 }, (_, index) => {
    const data = strictData(index, {
      store_id: [106637, 106640, 106644, 106646, 104965][index % 5],
      api_call_started_at: minute(1 + index),
      published_at: minute(1.5 + index),
    });
    return {
      type: "strict-confirmed",
      at: data.published_at,
      submitted_at: data.api_call_started_at,
      sku: data.sku,
      store_id: data.store_id,
      strict_confirmed: true,
      online_status: "selling",
      stock: 1,
      profit_rate: 41,
      shipping_mode: "FBS",
      same_item_1688: true,
      cost_reliable: true,
      duplicate_precheck: true,
      forbidden_category: false,
      title_valid: true,
      image_valid: true,
      category_valid: true,
    };
  });
  const snapshots = Array.from({ length: 121 }, (_, index) => ({
    type: "process-snapshot",
    at: minute(index),
    supervisor_count: 1,
    worker_count: 1,
    profile_owner_count: 1,
    expected_worker_count: 1,
    orphan_browser_count: 0,
    run_id: "fixed-500",
    commit_sha: "abc",
    config_sha256: "cfg",
    source_set_sha256: "src",
    state_schema_version: 3,
  }));
  const carryIn = {
    ...strict[0],
    sku: "carry-in",
    at: minute(80),
    submitted_at: minute(-1),
  };
  const result = evaluateLiveStagedGate({
    gate: "two-hour",
    events: [...strict, carryIn, ...snapshots],
    startedAt: START,
    endedAt: minute(120),
    expectedIdentity: {
      run_id: "fixed-500",
      commit_sha: "abc",
      config_sha256: "cfg",
      source_set_sha256: "src",
      state_schema_version: 3,
    },
  });

  assert.equal(result.passed, true);
  assert.equal(result.carried_in_strict_events, 1);
  assert.equal(result.unique_current_window_strict, 70);
});

test("live gate rejects sparse process evidence even when the synthetic replay is otherwise healthy", () => {
  const result = evaluateLiveStagedGate({
    gate: "30-minute",
    events: [
      {
        type: "process-snapshot",
        at: START,
        supervisor_count: 1,
        worker_count: 1,
        profile_owner_count: 1,
        expected_worker_count: 1,
        orphan_browser_count: 0,
        run_id: "fixed-500",
        commit_sha: "abc",
        config_sha256: "cfg",
        source_set_sha256: "src",
        state_schema_version: 3,
      },
      {
        type: "process-snapshot",
        at: minute(30),
        supervisor_count: 1,
        worker_count: 1,
        profile_owner_count: 1,
        expected_worker_count: 1,
        orphan_browser_count: 0,
        run_id: "fixed-500",
        commit_sha: "abc",
        config_sha256: "cfg",
        source_set_sha256: "src",
        state_schema_version: 3,
      },
      { type: "candidate-buffer", at: START, ready_unique: 110, added_unique: 110 },
      { type: "candidate-buffer", at: minute(30), ready_unique: 100, added_unique: 3 },
    ],
    startedAt: START,
    endedAt: minute(30),
    expectedIdentity: {
      run_id: "fixed-500",
      commit_sha: "abc",
      config_sha256: "cfg",
      source_set_sha256: "src",
      state_schema_version: 3,
    },
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.process_evidence_continuous, false);
});
