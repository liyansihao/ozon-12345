import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  RUNTIME_STATE_SCHEMA_VERSION,
  createRuntimeState,
  initializeSubmissionGate,
  releaseSubmissionGate,
  supplyEvidenceV1InvariantError,
} from "../scripts/flow_b_playwright/runtime-state.mjs";
import { normalizeTargetVariant } from "../scripts/flow_b_playwright/1688-supply-verifier.mjs";

async function withTempDir(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-runtime-state-"));
  try {
    return await callback(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const supplyCheckedAt = new Date(Date.now() - 60_000);
const supplyValidUntil = new Date(supplyCheckedAt.getTime() + 30 * 60_000);
const supplyApiCallStartedAt = new Date(supplyCheckedAt.getTime() + 30_000);
const strictData = {
  profit_rate: 31.5,
  online_status: "selling",
  stock: 1,
  store_id: 106637,
  shipping_mode: "FBS",
  fbs_evidence: {
    verified: true,
    observations: [{ mode: "FBS" }, { mode: "FBS" }],
  },
  cost_verified: true,
  cost_source: "search_first_page_p70_similarity_filtered",
  cost: {
    ok: true,
    cost: 20,
    source: "search_first_page_p70_similarity_filtered",
    prices: [18, 20, 22],
    match_evidence_key: "a".repeat(64),
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
    match_evidence_key: "a".repeat(64),
    filtered_price_count: 3,
    returned_evidence_verified: true,
    match_evidence_contract: "1688-returned-same-item-v2",
    matched_offer_count: 3,
  },
  quality_gate_passed: true,
  purchase_price_original_p70_p80: 20,
  purchase_price: 20,
  api_call_started_at: supplyApiCallStartedAt.toISOString(),
  supply_gate_passed: true,
  supply_candidates: [{
    platform: "1688",
    offer_id: "100000000001",
    offer_url: "https://detail.1688.com/offer/100000000001.html",
    match_type: "strong_single",
    match_evidence_key: "a".repeat(64),
  }],
  supply_evidence: {
    contract: "1688-orderable-v1",
    passed: true,
    platform: "1688",
    offer_id: "100000000001",
    offer_url: "https://detail.1688.com/offer/100000000001.html",
    item_level_match: true,
    target_variant: null,
    variant_attributes: {},
    moq: 1,
    orderable_quantity: 1,
    unit_price: 20,
    stock_state: "in_stock",
    orderable: true,
    match_evidence_key: "a".repeat(64),
    checked_at: supplyCheckedAt.toISOString(),
    valid_until: supplyValidUntil.toISOString(),
  },
};

function strictDataAt(publicationAt, overrides = {}) {
  const publishedAt = new Date(publicationAt);
  const checkedAt = new Date(publishedAt.getTime() - 60_000);
  return {
    ...strictData,
    api_call_started_at: publishedAt.toISOString(),
    ...overrides,
    supply_evidence: {
      ...strictData.supply_evidence,
      checked_at: checkedAt.toISOString(),
      valid_until: new Date(checkedAt.getTime() + 30 * 60_000).toISOString(),
      ...(overrides.supply_evidence || {}),
    },
  };
}

function imagePrimaryMatchEvidence(overrides = {}) {
  return {
    offer_id: "100000000001",
    source_contract: "1688-returned-same-item-v3",
    title: "GU10 red spotlight X100",
    supplier_id: "supplier-1001",
    image_url: "https://cbu01.alicdn.com/img/ibank/image-primary.jpg",
    image: {
      available: true,
      score: 0.79,
      color_score: 0.91,
      dhash_score: 0.70,
    },
    semantic_strength: "exact_model",
    semantic_hits_v3: {
      model: ["x100"],
      high_information: ["gu10"],
      feature: [],
      product: ["spotlight"],
    },
    spec_conflicts: [],
    accessory_conflict: false,
    lane: "strong_visual",
    ...overrides,
  };
}

function imagePrimaryDataAt(publicationAt, {
  imageEvidenceOverrides = {},
  candidateOverrides = {},
  evidenceOverrides = {},
  targetVariant = {
    required: true,
    attributes: { color: "红色", model: "GU10" },
  },
} = {}) {
  const base = strictDataAt(publicationAt);
  const imageMatchEvidence = imagePrimaryMatchEvidence(imageEvidenceOverrides);
  const {
    source_contract: _sourceContract,
    lane: _lane,
    corroborating_offer_ids: _corroboratingOfferIds,
    ...signedCostRow
  } = imageMatchEvidence;
  const canonicalTarget = normalizeTargetVariant(targetVariant);
  const defaultVariantAttributes = Object.hasOwn(canonicalTarget, "color")
    ? { color: canonicalTarget.color }
    : {};
  const returnedVariantAttributes = evidenceOverrides.variant_attributes ?? defaultVariantAttributes;
  const canonicalReturnedAttributes = normalizeTargetVariant(returnedVariantAttributes);
  const defaultVariantDifferences = Object.entries(canonicalTarget)
    .filter(([name, value]) => canonicalReturnedAttributes[name] !== value)
    .map(([name, expected]) => ({ name, expected, observed: null, kind: "unbound_soft" }));
  return {
    ...base,
    target_variant: targetVariant,
    cost: {
      ...base.cost,
      match_evidence_contract: "1688-returned-same-item-v3",
      selected_offer_id: "100000000001",
      balanced_supporting_offer_evidence: [structuredClone(signedCostRow)],
    },
    cost_evidence: {
      ...base.cost_evidence,
      match_evidence_contract: "1688-returned-same-item-v3",
      selected_offer_id: "100000000001",
    },
    supply_candidates: [{
      ...base.supply_candidates[0],
      match_basis: "image_primary_v1",
      image_match_evidence: structuredClone(imageMatchEvidence),
      ...candidateOverrides,
    }],
    supply_evidence: {
      ...base.supply_evidence,
      variant_match_mode: "image_primary",
      match_basis: "image_primary_v1",
      image_match_evidence: structuredClone(imageMatchEvidence),
      item_level_match: false,
      target_variant: canonicalTarget,
      variant_attributes: returnedVariantAttributes,
      variant_selection_required: true,
      variant_differences: defaultVariantDifferences,
      selected_variant: {
        row_key: "sku-row-1",
        sku_ids: ["sku-1001"],
        label: "红色 GU10",
        selection_method: "image_primary_best_target_overlap",
        soft_tie: false,
      },
      ...evidenceOverrides,
    },
  };
}

function strictCostLaneDataAt(publicationAt, matchType) {
  const base = strictDataAt(publicationAt);
  const offerIds = matchType === "strong_single"
    ? ["100000000001"]
    : ["100000000001", "100000000002"];
  const supportRows = offerIds.map((offerId, index) => ({
    offer_id: offerId,
    title: `signed supply row ${index + 1}`,
    supplier_id: `signed-supplier-${index + 1}`,
    image_url: `https://cbu01.alicdn.com/img/ibank/signed-${index + 1}.jpg`,
    image: index === 0
      ? { available: true, score: 0.79, color_score: 0.92, dhash_score: 0.70 }
      : { available: false },
    semantic_strength: "exact_model",
    semantic_hits_v3: { model: ["x100"], high_information: ["x100"], feature: [], product: [] },
    spec_conflicts: [],
    accessory_conflict: false,
  }));
  const prices = matchType === "strong_single" ? [20] : [19, 20];
  return {
    ...base,
    cost: {
      ...base.cost,
      prices,
      match_evidence_contract: "1688-returned-same-item-v3",
      matched_offer_count: offerIds.length,
      matched_offer_ids: [...offerIds],
      selected_offer_id: offerIds[0],
      selected_offer_ids: [offerIds[0]],
      selected_cluster_offer_ids: [...offerIds],
      selected_cluster_prices: [...prices],
      balanced_match: true,
      balanced_match_type: matchType,
      balanced_supporting_offer_ids: [...offerIds],
      balanced_supporting_offer_evidence: supportRows,
    },
    cost_evidence: {
      ...base.cost_evidence,
      filtered_price_count: prices.length,
      match_evidence_contract: "1688-returned-same-item-v3",
      matched_offer_count: offerIds.length,
      selected_offer_id: offerIds[0],
    },
    supply_candidates: offerIds.map((offerId) => ({
      platform: "1688",
      offer_id: offerId,
      offer_url: `https://detail.1688.com/offer/${offerId}.html`,
      match_type: matchType,
      match_evidence_key: "a".repeat(64),
    })),
  };
}

function persistTrustedSupplySubmission(state, sku, data) {
  const reserved = state.reserveSubmission(sku, {
    reason: "submission-api-call-started",
    data: {
      ...data,
      submission_intent: true,
      submitted: false,
    },
  });
  assert.equal(reserved.recorded, true, `expected ${sku} supply submission reservation`);
  const confirmed = state.confirmSubmission(sku, {
    reason: "erp-submission-accepted",
    data: {
      ...data,
      submitted: true,
    },
  });
  assert.equal(confirmed.recorded, true, `expected ${sku} submitted supply evidence`);
}

test("runtime state requires an external database path and installs one versioned schema", async () => {
  assert.throws(() => createRuntimeState(), /dbPath is required/);

  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "state", "runtime.sqlite");
    assert.throws(
      () => createRuntimeState({ dbPath, timeZone: "UTC" }),
      /Asia\/Shanghai/,
    );
    const state = createRuntimeState({ dbPath });
    assert.equal(state.schemaVersion(), RUNTIME_STATE_SCHEMA_VERSION);
    assert.equal(await fs.stat(dbPath).then((value) => value.isFile()), true);
    state.close();

    const reopened = createRuntimeState({ dbPath });
    assert.equal(reopened.schemaVersion(), RUNTIME_STATE_SCHEMA_VERSION);
    reopened.close();
  });
});

test("schema v1, v2, and v3 databases migrate transactionally to v4 with a SQLite backup", async () => {
  await withTempDir(async (dir) => {
    for (const legacyVersion of [1, 2, 3]) {
      const dbPath = path.join(dir, `runtime-v${legacyVersion}.sqlite`);
      const original = createRuntimeState({ dbPath });
      original.recordProcessing(`legacy-v${legacyVersion}`, {
        reason: "pre-migration-state",
        data: { preserved: true },
      });
      original.close();

      const legacy = new DatabaseSync(dbPath);
      try {
        legacy.exec(`
          DROP INDEX IF EXISTS active_submission_title_key;
          DROP TABLE IF EXISTS strict_title_claims;
        `);
        if (legacyVersion === 1) {
          legacy.exec("DROP TABLE IF EXISTS submission_reservations;");
        } else {
          legacy.exec("ALTER TABLE submission_reservations DROP COLUMN title_key;");
        }
        legacy
          .prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'")
          .run(String(legacyVersion));
        legacy.exec(`PRAGMA user_version = ${legacyVersion};`);
      } finally {
        legacy.close();
      }

      const migrated = createRuntimeState({ dbPath });
      assert.equal(migrated.schemaVersion(), 4);
      assert.equal(migrated.get(`legacy-v${legacyVersion}`).data.preserved, true);
      const migratedReader = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(
          new Set(
            migratedReader
              .prepare("PRAGMA table_info(submission_reservations)")
              .all()
              .map((row) => row.name),
          ).has("title_key"),
          true,
        );
      } finally {
        migratedReader.close();
      }
      assert.equal(
        migrated.migrationBackupPath,
        `${dbPath}.schema-v${legacyVersion}.backup.sqlite`,
      );
      assert.equal(await fs.stat(migrated.migrationBackupPath).then((value) => value.isFile()), true);
      migrated.close();

      const backup = new DatabaseSync(`${dbPath}.schema-v${legacyVersion}.backup.sqlite`, {
        readOnly: true,
      });
      try {
        assert.equal(
          Number(backup.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value),
          legacyVersion,
        );
      } finally {
        backup.close();
      }
    }
  });
});

test("a failed schema migration rolls back and reuses its valid backup on retry", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime-v2-retry.sqlite");
    const initial = createRuntimeState({ dbPath });
    initial.recordProcessing("preserved-after-retry", {
      reason: "pre-migration-state",
      data: { preserved: true },
    });
    initial.close();

    const legacy = new DatabaseSync(dbPath);
    try {
      legacy.prepare("UPDATE metadata SET value = '2' WHERE key = 'schema_version'").run();
      legacy.exec(`
        PRAGMA user_version = 2;
        CREATE TRIGGER reject_schema_upgrade
        BEFORE UPDATE OF value ON metadata
        WHEN NEW.value = '4'
        BEGIN
          SELECT RAISE(ABORT, 'forced migration failure');
        END;
      `);
    } finally {
      legacy.close();
    }

    assert.throws(
      () => createRuntimeState({ dbPath }),
      /forced migration failure/,
    );
    const backupPath = `${dbPath}.schema-v2.backup.sqlite`;
    assert.equal(await fs.stat(backupPath).then((value) => value.isFile()), true);

    const rolledBack = new DatabaseSync(dbPath);
    try {
      assert.equal(
        Number(rolledBack.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value),
        2,
      );
      rolledBack.exec("DROP TRIGGER reject_schema_upgrade;");
    } finally {
      rolledBack.close();
    }

    const retried = createRuntimeState({ dbPath });
    assert.equal(retried.migrationBackupPath, backupPath);
    assert.equal(retried.schemaVersion(), 4);
    assert.equal(retried.get("preserved-after-retry").data.preserved, true);
    retried.close();
  });
});

test("v3 migration preserves strict history without inventing supply evidence and enforces its cutover", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime-v3.sqlite");
    const historicalAt = "2026-08-15T00:00:00.000Z";
    const cutoverAt = "2026-08-15T00:10:00.000Z";
    const initial = createRuntimeState({
      dbPath,
      now: () => new Date(historicalAt),
    });
    const historicalData = strictDataAt(historicalAt);
    persistTrustedSupplySubmission(initial, "historical-direct", historicalData);
    persistTrustedSupplySubmission(initial, "historical-strict", historicalData);
    initial.recordStrictPublication("historical-strict", {
      reason: "pre-v4-strict",
      data: historicalData,
    });
    initial.close();

    const legacy = new DatabaseSync(dbPath);
    try {
      legacy.exec(`
        DROP TRIGGER IF EXISTS events_strict_supply_evidence_insert;
        DROP TRIGGER IF EXISTS events_strict_supply_evidence_update;
        DROP TRIGGER IF EXISTS sku_state_strict_supply_evidence_insert;
        DROP TRIGGER IF EXISTS sku_state_strict_supply_evidence_update;
        DROP TRIGGER IF EXISTS strict_publications_supply_evidence_insert;
        DROP TRIGGER IF EXISTS strict_publications_supply_evidence_update;
        DROP TRIGGER IF EXISTS submission_reservations_supply_evidence_insert;
        DROP TRIGGER IF EXISTS submission_reservations_supply_evidence_update;
        DROP TRIGGER IF EXISTS submission_reservations_supply_evidence_immutable;
        DROP TRIGGER IF EXISTS events_direct_supply_evidence_insert;
        DROP TRIGGER IF EXISTS events_direct_supply_evidence_update;
        DROP TRIGGER IF EXISTS sku_state_direct_supply_evidence_insert;
        DROP TRIGGER IF EXISTS sku_state_direct_supply_evidence_update;
        DROP TRIGGER IF EXISTS runtime_supply_gate_cutover_update_guard;
        DROP TRIGGER IF EXISTS runtime_supply_gate_cutover_delete_guard;
        UPDATE events
        SET data_json = json_remove(
          data_json,
          '$.supply_gate_passed',
          '$.supply_evidence',
          '$.supply_candidates',
          '$.supply_target_variant_canonical'
        )
        WHERE strict = 1;
        UPDATE sku_state
        SET data_json = json_remove(
          data_json,
          '$.supply_gate_passed',
          '$.supply_evidence',
          '$.supply_candidates',
          '$.supply_target_variant_canonical'
        )
        WHERE strict = 1;
        UPDATE strict_publications
        SET data_json = json_remove(
          data_json,
          '$.supply_gate_passed',
          '$.supply_evidence',
          '$.supply_candidates',
          '$.supply_target_variant_canonical'
        );
        UPDATE events
        SET data_json = json_remove(
          data_json,
          '$.supply_gate_passed',
          '$.supply_evidence',
          '$.supply_candidates',
          '$.supply_target_variant_canonical'
        )
        WHERE sku = 'historical-direct';
        UPDATE sku_state
        SET data_json = json_remove(
          data_json,
          '$.supply_gate_passed',
          '$.supply_evidence',
          '$.supply_candidates',
          '$.supply_target_variant_canonical'
        )
        WHERE sku = 'historical-direct';
        UPDATE submission_reservations
        SET data_json = json_remove(
          data_json,
          '$.supply_gate_passed',
          '$.supply_evidence',
          '$.supply_candidates',
          '$.supply_target_variant_canonical'
        )
        WHERE sku = 'historical-direct';
        DELETE FROM metadata WHERE key = 'supply_gate_cutover_at';
        UPDATE metadata SET value = '3' WHERE key = 'schema_version';
        PRAGMA user_version = 3;
      `);
    } finally {
      legacy.close();
    }

    const migrated = createRuntimeState({
      dbPath,
      now: () => new Date(cutoverAt),
    });
    assert.equal(migrated.schemaVersion(), 4);
    assert.equal(migrated.migrationBackupPath, `${dbPath}.schema-v3.backup.sqlite`);
    assert.equal(migrated.get("historical-strict").strict, true);
    assert.equal(migrated.get("historical-strict").data.supply_evidence, undefined);
    assert.equal(migrated.strictPublications()[0].data.supply_gate_passed, undefined);
    assert.equal(migrated.get("historical-direct").data.supply_evidence, undefined);
    assert.equal(migrated.recordTerminalOutcome("historical-direct", {
      reason: "legacy-direct-online-reconciled",
      stage: "online",
      data: {
        ...migrated.get("historical-direct").data,
        outcome_status: "online",
      },
    }).recorded, true);

    const { supply_gate_passed: _gate, supply_evidence: _evidence, ...legacyStrictData } = strictData;
    assert.throws(() => migrated.recordStrictPublication("post-cutover-missing", {
      reason: "must-fail-closed",
      data: legacyStrictData,
    }), /supply_gate_passed=true/iu);
    const postCutoverData = strictDataAt(cutoverAt);
    persistTrustedSupplySubmission(migrated, "post-cutover-valid", postCutoverData);
    assert.equal(migrated.recordStrictPublication("post-cutover-valid", {
      reason: "supply-confirmed",
      data: postCutoverData,
    }).recorded, true);
    migrated.close();

    const reader = new DatabaseSync(dbPath);
    try {
      assert.equal(
        reader.prepare("SELECT value FROM metadata WHERE key = 'supply_gate_cutover_at'").get().value,
        cutoverAt,
      );
      assert.throws(
        () => reader.prepare("UPDATE metadata SET value = ? WHERE key = 'supply_gate_cutover_at'")
          .run("2099-01-01T00:00:00.000Z"),
        /cutover is immutable/iu,
      );
    } finally {
      reader.close();
    }
  });
});

test("a migrated v4 trigger schema is parseable by the system SQLite CLI", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime-v3-system-sqlite.sqlite");
    const initial = createRuntimeState({
      dbPath,
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    initial.recordProcessing("preserved-through-system-sqlite-check", {
      reason: "pre-migration-state",
      data: { preserved: true },
    });
    initial.close();

    const legacy = new DatabaseSync(dbPath);
    try {
      legacy.exec(`
        DROP TRIGGER IF EXISTS runtime_supply_gate_cutover_update_guard;
        DROP TRIGGER IF EXISTS runtime_supply_gate_cutover_delete_guard;
        DELETE FROM metadata WHERE key = 'supply_gate_cutover_at';
        UPDATE metadata SET value = '3' WHERE key = 'schema_version';
        PRAGMA user_version = 3;
      `);
    } finally {
      legacy.close();
    }

    const migrated = createRuntimeState({
      dbPath,
      now: () => new Date("2026-08-15T00:10:00.000Z"),
    });
    assert.equal(migrated.schemaVersion(), 4);
    assert.equal(
      migrated.get("preserved-through-system-sqlite-check").data.preserved,
      true,
    );
    migrated.close();

    const cli = spawnSync("/usr/bin/sqlite3", ["-batch", dbPath], {
      encoding: "utf8",
      input: [
        ".bail on",
        "PRAGMA quick_check;",
        "SELECT count(*) FROM sqlite_schema WHERE type = 'trigger' AND name GLOB '*supply_evidence*';",
        "SELECT name || '|' || length(sql) || '|' || instr(sql, 'canonical_without_query')",
        "FROM sqlite_schema",
        "WHERE type = 'trigger' AND name = 'submission_reservations_supply_evidence_insert';",
        "",
      ].join("\n"),
    });
    assert.equal(cli.error, undefined);
    assert.equal(cli.signal, null);
    assert.equal(cli.status, 0, cli.stderr);
    const [quickCheck, triggerCount, triggerSchema] = cli.stdout.trim().split("\n");
    assert.equal(quickCheck, "ok");
    assert.equal(Number(triggerCount), 13);
    const [triggerName, triggerSqlLength, compactAliasOffset] = triggerSchema.split("|");
    assert.equal(triggerName, "submission_reservations_supply_evidence_insert");
    assert.ok(Number(triggerSqlLength) > 0 && Number(triggerSqlLength) < 60_000);
    assert.ok(Number(compactAliasOffset) > 0);
  });
});

test("submission, failure, skip, and delay transitions always require a durable reason", async () => {
  await withTempDir(async (dir) => {
    const state = createRuntimeState({ dbPath: path.join(dir, "runtime.sqlite") });

    assert.throws(() => state.recordSubmission("submitted", {}), /reason is required/);
    assert.throws(() => state.recordFailure("failed", { kind: "deterministic" }), /reason is required/);
    assert.throws(() => state.recordSkip("skipped", {}), /reason is required/);
    assert.throws(() => state.recordDelay("delayed", {
      nextEligibleAt: "2026-07-29T02:00:00.000Z",
    }), /reason is required/);

    state.recordSubmission("submitted", { reason: "erp-import-requested", data: { offer_id: "mz-1" } });
    state.recordDelay("delayed", {
      reason: "ozon-backpressure",
      nextEligibleAt: "2026-07-29T02:00:00.000Z",
    });
    assert.equal(state.get("submitted").reason, "erp-import-requested");
    assert.equal(state.get("delayed").reason, "ozon-backpressure");
    state.close();
  });
});

test("direct mode reopens legacy policy skips but preserves accepted, unknown, and direct-final SKU states", async () => {
  await withTempDir(async (dir) => {
    const state = createRuntimeState({ dbPath: path.join(dir, "runtime.sqlite") });
    state.recordSkip("legacy-fbs", {
      reason: "non-pure-fbs",
      data: { title: "legacy candidate" },
    });
    state.recordSkip("direct-cost", {
      reason: "no-reliable-1688-cost",
      data: { outcome_status: "skipped_cost" },
    });
    state.recordFailure("unknown-request", {
      reason: "publish-response-lost",
      kind: "deterministic",
      data: { submission_intent: true, api_call_started_at: "2026-07-31T01:00:00.000Z" },
    });
    state.recordSubmission("accepted", {
      reason: "erp-submission-accepted",
      data: { submitted: true, outcome_status: "submitted" },
    });

    assert.equal(state.reopenDirectCandidate("legacy-fbs").reopened, true);
    assert.equal(state.get("legacy-fbs").terminal, false);
    assert.equal(state.get("legacy-fbs").reason, "direct-policy-reopened");
    assert.equal(state.canAttempt("legacy-fbs").allowed, true);
    assert.equal(state.reopenDirectCandidate("direct-cost").reason, "direct-final-outcome");
    assert.equal(state.reopenDirectCandidate("unknown-request").reason, "submission-state-preserved");
    assert.equal(state.reopenDirectCandidate("accepted").reopened, false);
    assert.equal(state.get("accepted").stage, "submitted");
    state.close();
  });
});

test("submission reservations use an owner generation lease and become permanently submitted", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime.sqlite");
    let ownerANow = new Date("2026-07-29T01:00:00.000Z");
    let ownerBNow = new Date("2026-07-29T01:00:30.000Z");
    const ownerA = createRuntimeState({
      dbPath,
      now: () => ownerANow,
      ownerId: "worker-a",
      generationId: "generation-a",
      submissionLeaseMs: 60_000,
    });
    const ownerB = createRuntimeState({
      dbPath,
      now: () => ownerBNow,
      ownerId: "worker-b",
      generationId: "generation-b",
      submissionLeaseMs: 60_000,
    });

    assert.equal(ownerA.reserveSubmission("leased", {
      reason: "submission-intent",
      data: {
        ...strictDataAt("2026-07-29T01:00:00.000Z"),
        offer_id: "mz-leased",
      },
    }).recorded, true);
    const sameGeneration = ownerA.reserveSubmission("leased", {
      reason: "submission-intent-evidence-updated",
      data: { request_fingerprint: "request-1" },
    });
    assert.equal(sameGeneration.recorded, true);
    assert.equal(sameGeneration.state.data.reconcile_only, true);
    assert.equal(sameGeneration.state.data.same_generation_reentry, true);

    const conflicting = ownerB.reserveSubmission("leased", {
      reason: "must-not-submit-concurrently",
    });
    assert.equal(conflicting.recorded, false);
    assert.equal(conflicting.reason, "submission-reserved-by-another-generation");

    ownerBNow = new Date("2026-07-29T01:01:01.000Z");
    const takeover = ownerB.reserveSubmission("leased", {
      reason: "expired-generation-reconciliation",
      data: { recovery_started_at: ownerBNow.toISOString() },
    });
    assert.equal(takeover.recorded, true);
    assert.equal(takeover.takeover, true);
    assert.equal(takeover.state.data.offer_id, "mz-leased");
    assert.equal(takeover.state.data.reconcile_only, true);
    assert.equal(takeover.state.data.cross_generation_takeover, true);

    assert.equal(ownerA.confirmSubmission("leased", {
      reason: "stale-owner-must-not-confirm",
      data: { submitted: true },
    }).recorded, false);
    assert.equal(ownerB.confirmSubmission("leased", {
      reason: "erp-import-accepted",
      data: { submitted: true },
    }).recorded, true);
    assert.equal(ownerA.reserveSubmission("leased", {
      reason: "must-not-resubmit-after-acceptance",
    }).recorded, false);
    assert.equal(ownerA.submissionReservation("leased").status, "submitted");

    ownerA.close();
    ownerB.close();
  });
});

test("pre-call intent abandonment atomically closes the owned reservation without consuming retry budget", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime.sqlite");
    const now = new Date("2026-08-15T01:00:00.000Z");
    const state = createRuntimeState({
      dbPath,
      now: () => now,
      ownerId: "pre-call-owner",
      generationId: "pre-call-generation",
      submissionLeaseMs: 1_000,
    });
    assert.equal(state.reserveSubmission("pre-call-reset", {
      reason: "submission-intent",
      data: {
        submission_intent: true,
        submission_payload: { rows: [{ offer_id: "pre-call-reset" }] },
        profit_recheck_context: { profit_rate: 31.5 },
        supply_gate_passed: true,
        supply_evidence: { cached: true },
        supply_candidates: [{ offer_id: "100000000001" }],
        target_variant: { color: "red" },
      },
    }).recorded, true);

    const writer = new DatabaseSync(dbPath);
    try {
      writer.prepare(`
        INSERT INTO transient_attempts (sku, shanghai_day, attempts)
        VALUES ('pre-call-reset', '2026-08-15', 2)
      `).run();
    } finally {
      writer.close();
    }

    const retryAt = "2026-08-16T01:00:00.000Z";
    const abandoned = state.abandonPreCallSubmissionIntent("pre-call-reset", {
      reason: "submission-not-sent-deferred",
      nextEligibleAt: retryAt,
      expectedOwnerId: "pre-call-owner",
      expectedGenerationId: "pre-call-generation",
      data: { original_reason: "submission-profit-context-invalid" },
    });
    assert.equal(abandoned.recorded, true);
    assert.equal(abandoned.attempts, 2);
    assert.equal(abandoned.reservation.status, "closed");
    assert.equal(abandoned.reservation.titleKey, null);
    assert.equal(abandoned.reservation.leaseExpiresAt, null);
    assert.equal(abandoned.state.stage, "failed");
    assert.equal(abandoned.state.failureClass, "transient");
    assert.equal(abandoned.state.terminal, false);
    assert.equal(abandoned.state.nextEligibleAt, retryAt);
    assert.equal(abandoned.state.data.submission_intent, false);
    assert.equal(abandoned.state.data.submitted, false);
    assert.equal(abandoned.state.data.submission_payload, null);
    assert.equal(abandoned.state.data.profit_recheck_context, null);
    assert.equal(abandoned.state.data.supply_gate_passed, false);
    assert.equal(abandoned.state.data.supply_evidence, null);
    assert.deepEqual(abandoned.state.data.supply_candidates, []);
    assert.equal(abandoned.state.data.target_variant, null);
    assert.equal(abandoned.state.data.api_call_started_at, undefined);
    assert.equal(abandoned.state.data.fresh_pipeline_required, true);
    assert.equal(abandoned.state.data.pre_call_intent_abandoned, true);
    assert.equal(
      state.auditEvents().filter((event) => (
        event.sku === "pre-call-reset"
        && event.reason === "submission-not-sent-deferred"
      )).length,
      1,
    );

    const repeated = state.abandonPreCallSubmissionIntent("pre-call-reset", {
      reason: "must-not-record-twice",
      nextEligibleAt: retryAt,
      expectedOwnerId: "pre-call-owner",
      expectedGenerationId: "pre-call-generation",
    });
    assert.equal(repeated.recorded, false);
    assert.equal(repeated.reason, "submission-reservation-not-active");
    state.close();
  });
});

test("pre-call intent abandonment CAS requires an expired lease and the reserved generation", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime.sqlite");
    let ownerANow = new Date("2026-08-15T02:00:00.000Z");
    let ownerBNow = new Date("2026-08-15T02:00:30.000Z");
    const ownerA = createRuntimeState({
      dbPath,
      now: () => ownerANow,
      ownerId: "cas-owner-a",
      generationId: "cas-generation-a",
      submissionLeaseMs: 60_000,
    });
    const ownerB = createRuntimeState({
      dbPath,
      now: () => ownerBNow,
      ownerId: "cas-owner-b",
      generationId: "cas-generation-b",
      submissionLeaseMs: 60_000,
    });

    assert.equal(ownerA.reserveSubmission("active-foreign-lease", {
      reason: "submission-intent",
      data: { submission_payload: { rows: [{ offer_id: "active-foreign-lease" }] } },
    }).recorded, true);
    const activeLease = ownerB.abandonPreCallSubmissionIntent("active-foreign-lease", {
      reason: "must-not-clear-active-lease",
      nextEligibleAt: "2026-08-15T02:10:00.000Z",
      expectedOwnerId: "cas-owner-a",
      expectedGenerationId: "cas-generation-a",
    });
    assert.equal(activeLease.recorded, false);
    assert.equal(activeLease.reason, "submission-reservation-lease-active");
    assert.equal(activeLease.reservation.status, "reserved");

    ownerBNow = new Date("2026-08-15T02:01:01.000Z");
    const expiredForeignLease = ownerB.abandonPreCallSubmissionIntent("active-foreign-lease", {
      reason: "expired-foreign-intent-reset",
      nextEligibleAt: "2026-08-15T02:10:00.000Z",
      expectedOwnerId: "cas-owner-a",
      expectedGenerationId: "cas-generation-a",
    });
    assert.equal(expiredForeignLease.recorded, true);
    assert.equal(expiredForeignLease.reservation.status, "closed");
    assert.equal(
      expiredForeignLease.state.data.pre_call_intent_abandoned_generation_id,
      "cas-generation-a",
    );

    ownerANow = new Date("2026-08-15T02:02:00.000Z");
    assert.equal(ownerA.reserveSubmission("stale-generation", {
      reason: "submission-intent",
      data: { submission_payload: { rows: [{ offer_id: "stale-generation" }] } },
    }).recorded, true);
    ownerBNow = new Date("2026-08-15T02:03:01.000Z");
    assert.equal(ownerB.reserveSubmission("stale-generation", {
      reason: "expired-generation-takeover",
    }).recorded, true);

    const staleAbandon = ownerA.abandonPreCallSubmissionIntent("stale-generation", {
      reason: "stale-owner-must-not-reset",
      nextEligibleAt: "2026-08-15T02:10:00.000Z",
      expectedOwnerId: "cas-owner-a",
      expectedGenerationId: "cas-generation-a",
    });
    assert.equal(staleAbandon.recorded, false);
    assert.equal(staleAbandon.reason, "submission-reserved-by-another-generation");
    assert.equal(staleAbandon.reservation.ownerId, "cas-owner-b");
    assert.equal(staleAbandon.reservation.generationId, "cas-generation-b");
    assert.equal(staleAbandon.reservation.status, "reserved");
    assert.equal(ownerA.get("stale-generation").data.submission_owner_id, "cas-owner-b");

    ownerBNow = new Date("2026-08-15T02:04:02.000Z");
    ownerANow = new Date("2026-08-15T02:04:02.000Z");
    const currentAbandon = ownerA.abandonPreCallSubmissionIntent("stale-generation", {
      reason: "current-owner-reset",
      nextEligibleAt: "2026-08-15T02:10:00.000Z",
      expectedOwnerId: "cas-owner-b",
      expectedGenerationId: "cas-generation-b",
    });
    assert.equal(currentAbandon.recorded, true);
    assert.equal(currentAbandon.reservation.status, "closed");

    ownerANow = new Date("2026-08-15T02:05:00.000Z");
    assert.equal(ownerA.reserveSubmission("abandoned-generation", {
      reason: "submission-intent",
    }).recorded, true);
    ownerANow = new Date("2026-08-15T02:06:01.000Z");
    assert.equal(ownerA.abandonPreCallSubmissionIntent("abandoned-generation", {
      reason: "fresh-pipeline-required",
      nextEligibleAt: "2026-08-15T02:07:00.000Z",
      expectedOwnerId: "cas-owner-a",
      expectedGenerationId: "cas-generation-a",
    }).recorded, true);
    ownerANow = new Date("2026-08-15T02:07:01.000Z");
    const abandonedGenerationReentry = ownerA.reserveSubmission("abandoned-generation", {
      reason: "old-intent-must-not-revive",
      data: {
        prepared_at: "2026-08-15T02:06:01.000Z",
        profit_recheck_context: { observed_at: "2026-08-15T02:06:01.000Z" },
      },
    });
    assert.equal(abandonedGenerationReentry.recorded, false);
    assert.equal(abandonedGenerationReentry.reason, "submission-generation-abandoned");
    assert.equal(
      abandonedGenerationReentry.preparationTimestampSource,
      "profit_recheck_context.observed_at",
    );
    assert.equal(
      abandonedGenerationReentry.requiredPreparedAfter,
      "2026-08-15T02:06:01.000Z",
    );
    assert.equal(
      abandonedGenerationReentry.observedPreparedAt,
      "2026-08-15T02:06:01.000Z",
    );

    const staleEvidenceReentry = ownerA.reserveSubmission("abandoned-generation", {
      reason: "fresh-context-must-not-hide-stale-supply",
      data: {
        prepared_at: "2026-08-15T02:07:00.000Z",
        profit_recheck_context: { observed_at: "2026-08-15T02:07:00.000Z" },
        supply_evidence: { checked_at: "2026-08-15T02:06:01.000Z" },
      },
    });
    assert.equal(staleEvidenceReentry.recorded, false);
    assert.equal(staleEvidenceReentry.reason, "submission-generation-abandoned");
    assert.equal(
      staleEvidenceReentry.preparationTimestampSource,
      "supply_evidence.checked_at",
    );

    const staleContextReentry = ownerA.reserveSubmission("abandoned-generation", {
      reason: "new-label-must-not-hide-stale-context",
      data: {
        prepared_at: "2026-08-15T02:07:00.000Z",
        profit_recheck_context: { observed_at: "2026-08-15T02:06:01.000Z" },
        supply_evidence: { checked_at: "2026-08-15T02:07:00.000Z" },
      },
    });
    assert.equal(staleContextReentry.recorded, false);
    assert.equal(staleContextReentry.reason, "submission-generation-abandoned");
    assert.equal(
      staleContextReentry.preparationTimestampSource,
      "profit_recheck_context.observed_at",
    );

    const malformedEvidenceReentry = ownerA.reserveSubmission("abandoned-generation", {
      reason: "malformed-supply-time-must-fail-closed",
      data: {
        prepared_at: "2026-08-15T02:07:00.000Z",
        profit_recheck_context: { observed_at: "2026-08-15T02:07:00.000Z" },
        supply_evidence: {},
      },
    });
    assert.equal(malformedEvidenceReentry.recorded, false);
    assert.equal(malformedEvidenceReentry.reason, "submission-generation-abandoned");
    assert.equal(
      malformedEvidenceReentry.preparationTimestampSource,
      "supply_evidence.checked_at",
    );
    assert.equal(malformedEvidenceReentry.observedPreparedAt, null);

    ownerANow = new Date("2026-08-15T02:07:03.000Z");
    const freshPreparedAt = "2026-08-15T02:07:02.000Z";
    const freshPipelineReentry = ownerA.reserveSubmission("abandoned-generation", {
      reason: "fresh-pipeline-prepared",
      data: {
        prepared_at: freshPreparedAt,
        profit_recheck_context: { observed_at: freshPreparedAt },
        supply_evidence: { checked_at: freshPreparedAt },
      },
    });
    assert.equal(freshPipelineReentry.recorded, true);
    assert.equal(freshPipelineReentry.freshPipelineReentry, true);
    assert.equal(freshPipelineReentry.reservation.status, "reserved");
    assert.equal(freshPipelineReentry.state.data.prepared_at, freshPreparedAt);
    assert.equal(freshPipelineReentry.state.data.pre_call_intent_abandoned, undefined);
    assert.equal(freshPipelineReentry.state.data.pre_call_intent_reset_at, undefined);
    assert.equal(freshPipelineReentry.state.data.fresh_pipeline_required, undefined);

    const lateOldCallback = ownerA.reserveSubmission("abandoned-generation", {
      reason: "late-old-callback-must-not-regress-fresh-intent",
      data: {
        prepared_at: "2026-08-15T02:06:01.000Z",
        profit_recheck_context: { observed_at: "2026-08-15T02:06:01.000Z" },
        supply_evidence: { checked_at: "2026-08-15T02:06:01.000Z" },
      },
    });
    assert.equal(lateOldCallback.recorded, false);
    assert.equal(lateOldCallback.reason, "submission-preparation-regressed");
    assert.equal(lateOldCallback.reservation.data.prepared_at, freshPreparedAt);

    ownerANow = new Date("2026-08-15T02:08:00.000Z");
    const markerData = strictDataAt(ownerANow, {
      submission_intent: true,
      submitted: false,
    });
    assert.equal(ownerA.reserveSubmission("api-marker-wins", {
      reason: "submission-api-call-started",
      data: markerData,
    }).recorded, true);
    ownerBNow = new Date("2026-08-15T02:09:01.000Z");
    const markerAbandon = ownerB.abandonPreCallSubmissionIntent("api-marker-wins", {
      reason: "must-not-clear-api-marker",
      nextEligibleAt: "2026-08-15T02:10:00.000Z",
      expectedOwnerId: "cas-owner-a",
      expectedGenerationId: "cas-generation-a",
    });
    assert.equal(markerAbandon.recorded, false);
    assert.equal(markerAbandon.reason, "submission-api-call-already-started");
    assert.equal(markerAbandon.reservation.status, "reserved");
    assert.equal(
      markerAbandon.reservation.data.api_call_started_at,
      markerData.api_call_started_at,
    );
    assert.equal(
      ownerA.get("api-marker-wins").data.api_call_started_at,
      markerData.api_call_started_at,
    );

    ownerA.close();
    ownerB.close();
  });
});

test("authoritative ERP recovery atomically confirms only an expired foreign reservation", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime.sqlite");
    const ownerA = createRuntimeState({
      dbPath,
      now: () => new Date("2026-08-13T07:22:21.000Z"),
      ownerId: "dead-worker",
      generationId: "dead-generation",
      submissionLeaseMs: 60_000,
    });
    assert.equal(ownerA.reserveSubmission("accepted-after-timeout", {
      reason: "submission-api-call-started",
      data: {
        ...strictDataAt("2026-08-13T07:22:21.000Z"),
        api_call_attempts_total: 1,
        submission_intent: true,
      },
    }).recorded, true);

    let recoveryNow = new Date("2026-08-13T07:23:20.999Z");
    const ownerB = createRuntimeState({
      dbPath,
      now: () => recoveryNow,
      ownerId: "recovery-worker",
      generationId: "recovery-generation",
      submissionLeaseMs: 60_000,
    });
    const activeLease = ownerB.confirmSubmission("accepted-after-timeout", {
      reason: "erp-submission-accepted",
      allowExpiredTakeover: true,
      data: {
        submitted: true,
        publish_result: { recovered: true, evidence: "import-log" },
      },
    });
    assert.equal(activeLease.recorded, false);
    assert.equal(activeLease.reason, "submission-reserved-by-another-generation");

    recoveryNow = new Date("2026-08-13T07:23:21.001Z");
    const recovered = ownerB.confirmSubmission("accepted-after-timeout", {
      reason: "erp-submission-accepted",
      allowExpiredTakeover: true,
      data: {
        submitted: true,
        publish_result: { recovered: true, evidence: "import-log" },
      },
    });
    assert.equal(recovered.recorded, true);
    assert.equal(recovered.takeover, true);
    assert.equal(recovered.reservation.status, "submitted");
    assert.equal(recovered.reservation.ownerId, "recovery-worker");
    assert.equal(recovered.reservation.generationId, "recovery-generation");
    assert.equal(recovered.reservation.data.api_call_attempts_total, 1);

    ownerA.close();
    ownerB.close();
  });
});

test("accepted audit repair uses a compact indexed projection and excludes uncertain closures", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime.sqlite");
    const runDir = path.join(dir, "active-run");
    const otherRunDir = path.join(dir, "other-run");
    let clock = new Date("2026-08-12T02:50:00.000Z");
    const state = createRuntimeState({
      dbPath,
      ownerId: "accepted-audit-owner",
      generationId: "accepted-audit-generation",
      // Force every mutable updated_at value to collide. Accepted audit order
      // must follow the durable acceptance timestamp, with SKU as its tie-break.
      now: () => clock,
    });
    clock = new Date("2026-08-12T03:10:00.000Z");

    const accept = (sku, targetRunDir, acceptedAt) => {
      const supplyData = strictDataAt(acceptedAt);
      assert.equal(state.reserveSubmission(sku, {
        reason: "submission-intent",
        data: {
          ...supplyData,
          runtime_run_dir: targetRunDir,
          store_id: 106637,
          offer_id: `mz-${sku}`,
          api_call_attempts_total: 1,
        },
      }).recorded, true);
      assert.equal(state.confirmSubmission(sku, {
        reason: "erp-submission-accepted",
        data: {
          ...supplyData,
          runtime_run_dir: targetRunDir,
          store_id: 106637,
          offer_id: `mz-${sku}`,
          at: acceptedAt,
          submitted: true,
          api_call_completed_at: acceptedAt,
          api_call_attempts_total: 1,
        },
      }).recorded, true);
    };

    accept("accepted-open", runDir, "2026-08-12T03:00:00.000Z");
    accept("accepted-closed", runDir, "2026-08-12T03:01:00.000Z");
    assert.equal(state.recordTerminalOutcome("accepted-closed", {
      reason: "background-online",
      stage: "online",
      data: {
        ...state.submissionReservation("accepted-closed").data,
        outcome_status: "online",
      },
    }).recorded, true);
    accept("accepted-other-run", otherRunDir, "2026-08-12T03:02:00.000Z");
    accept("accepted-same-b", runDir, "2026-08-12T03:03:00.000Z");
    accept("accepted-same-a", runDir, "2026-08-12T03:03:00.000Z");

    assert.equal(state.reserveSubmission("uncertain-closed", {
      reason: "submission-intent",
      data: {
        runtime_run_dir: runDir,
        store_id: 106637,
        offer_id: "mz-uncertain-closed",
        api_call_attempts_total: 0,
      },
    }).recorded, true);
    assert.equal(state.recordSkip("uncertain-closed", {
      reason: "reconciliation-age-exhausted",
      data: { outcome_status: "indeterminate" },
    }).recorded, true);

    assert.deepEqual(
      state.acceptedReservationProjections(runDir).map((row) => ({ ...row })),
      [
        {
          sku: "accepted-open",
          store_id: 106637,
          accepted_at: "2026-08-12T03:00:00.000Z",
          offer_id: "mz-accepted-open",
          at: "2026-08-12T03:00:00.000Z",
        },
        {
          sku: "accepted-closed",
          store_id: 106637,
          accepted_at: "2026-08-12T03:01:00.000Z",
          offer_id: "mz-accepted-closed",
          at: "2026-08-12T03:01:00.000Z",
        },
        {
          sku: "accepted-same-a",
          store_id: 106637,
          accepted_at: "2026-08-12T03:03:00.000Z",
          offer_id: "mz-accepted-same-a",
          at: "2026-08-12T03:03:00.000Z",
        },
        {
          sku: "accepted-same-b",
          store_id: 106637,
          accepted_at: "2026-08-12T03:03:00.000Z",
          offer_id: "mz-accepted-same-b",
          at: "2026-08-12T03:03:00.000Z",
        },
      ],
    );
    assert.deepEqual(
      state.submittedReservations(runDir).map((row) => row.sku),
      ["accepted-open", "accepted-closed", "accepted-same-a", "accepted-same-b"],
    );
    assert.equal(state.submissionReservation("uncertain-closed").data.submitted, false);
    state.close();

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const plan = database.prepare(`
        EXPLAIN QUERY PLAN
        SELECT
          sku,
          CAST(json_extract(data_json, '$.store_id') AS INTEGER) AS store_id,
          COALESCE(
            NULLIF(CAST(json_extract(data_json, '$.accepted_at') AS TEXT), ''),
            NULLIF(CAST(json_extract(data_json, '$.api_call_completed_at') AS TEXT), ''),
            NULLIF(CAST(json_extract(data_json, '$.api_call_accepted_at') AS TEXT), ''),
            NULLIF(CAST(json_extract(data_json, '$.submitted_at') AS TEXT), '')
          ) AS accepted_at,
          json_extract(data_json, '$.offer_id') AS offer_id,
          json_extract(data_json, '$.at') AS at
        FROM submission_reservations INDEXED BY submission_reservations_accepted_audit_by_run_v2
        WHERE status IN ('submitted', 'closed')
          AND json_type(data_json, '$.submitted') = 'true'
          AND COALESCE(
            NULLIF(CAST(json_extract(data_json, '$.accepted_at') AS TEXT), ''),
            NULLIF(CAST(json_extract(data_json, '$.api_call_completed_at') AS TEXT), ''),
            NULLIF(CAST(json_extract(data_json, '$.api_call_accepted_at') AS TEXT), ''),
            NULLIF(CAST(json_extract(data_json, '$.submitted_at') AS TEXT), '')
          ) IS NOT NULL
          AND CAST(json_extract(data_json, '$.runtime_run_dir') AS TEXT) = ?
        ORDER BY COALESCE(
          NULLIF(CAST(json_extract(data_json, '$.accepted_at') AS TEXT), ''),
          NULLIF(CAST(json_extract(data_json, '$.api_call_completed_at') AS TEXT), ''),
          NULLIF(CAST(json_extract(data_json, '$.api_call_accepted_at') AS TEXT), ''),
          NULLIF(CAST(json_extract(data_json, '$.submitted_at') AS TEXT), '')
        ), sku
      `).all(runDir).map((row) => String(row.detail)).join("\n");
      assert.match(
        plan,
        /SEARCH submission_reservations USING INDEX submission_reservations_accepted_audit_by_run_v2/u,
      );
      assert.doesNotMatch(plan, /SCAN submission_reservations/u);
      assert.doesNotMatch(plan, /USE TEMP B-TREE/u);
    } finally {
      database.close();
    }
  });
});

test("direct target slots are atomic across main and background runtime-state owners", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime.sqlite");
    const runDir = path.join(dir, "active-run");
    const main = createRuntimeState({
      dbPath,
      ownerId: "main-publisher",
      generationId: "main-generation",
    });
    const background = createRuntimeState({
      dbPath,
      ownerId: "background-reconciliation",
      generationId: "background-generation",
    });
    const boundarySupplyData = strictDataAt(new Date());

    const unknown = main.reserveSubmission("unknown-at-boundary", {
      reason: "submission-api-call-started",
      data: {
        ...boundarySupplyData,
        runtime_run_dir: runDir,
        direct_target_count: 1,
      },
    });
    assert.equal(unknown.recorded, true);
    assert.equal(main.directTargetUsage(runDir), 1);
    assert.equal(background.directTargetUsage(runDir), 1);
    assert.equal(main.directAcceptedCount(runDir), 0);

    const overTarget = background.reserveSubmission("must-not-be-501", {
      reason: "submission-intent",
      data: {
        runtime_run_dir: runDir,
        direct_target_count: 1,
      },
    });
    assert.equal(overTarget.recorded, false);
    assert.equal(overTarget.reason, "direct-target-capacity-reached");
    assert.equal(overTarget.targetUsage, 1);

    assert.equal(main.confirmSubmission("unknown-at-boundary", {
      reason: "erp-submission-accepted",
      data: {
        runtime_run_dir: runDir,
        direct_target_count: 1,
        submitted: true,
      },
    }).recorded, true);
    assert.equal(background.directAcceptedCount(runDir), 1);
    assert.equal(background.directTargetUsage(runDir), 1);

    main.close();
    background.close();
  });
});

test("direct target zero means unlimited and still preserves SKU reservations", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime.sqlite");
    const runDir = path.join(dir, "unlimited-run");
    const state = createRuntimeState({
      dbPath,
      ownerId: "unlimited-publisher",
      generationId: "unlimited-generation",
    });

    for (const sku of ["unlimited-a", "unlimited-b"]) {
      const reserved = state.reserveSubmission(sku, {
        reason: "submission-intent",
        data: {
          runtime_run_dir: runDir,
          direct_target_count: 0,
        },
      });
      assert.equal(reserved.recorded, true);
    }
    assert.equal(state.directTargetUsage(runDir), 2);

    const duplicate = state.reserveSubmission("unlimited-a", {
      reason: "submission-intent",
      data: {
        runtime_run_dir: runDir,
        direct_target_count: 0,
      },
    });
    assert.equal(duplicate.recorded, true);
    assert.equal(state.directTargetUsage(runDir), 2);

    state.close();
  });
});

test("formal prefix gate atomically permits only its three frozen distinct SKUs until release", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime.sqlite");
    const bootstrap = createRuntimeState({ dbPath });
    bootstrap.close();
    const gate = initializeSubmissionGate({
      dbPath,
      runId: "fixed-500",
      runDir: path.join(dir, "formal-run"),
      targetSkus: ["gate-c", "gate-a", "gate-b"],
      startedAt: "2026-07-30T00:00:00.000Z",
    });
    assert.equal(gate.phase, "active");
    assert.deepEqual(gate.targetSkus, ["gate-a", "gate-b", "gate-c"]);

    const worker = createRuntimeState({
      dbPath,
      ownerId: "worker",
      generationId: "generation",
      requiredSubmissionGateRunId: "fixed-500",
      requiredSubmissionGateRunDir: path.join(dir, "formal-run"),
    });
    assert.equal(worker.reserveSubmission("gate-a", {
      reason: "submission-intent",
    }).recorded, true);
    const blocked = worker.reserveSubmission("gate-d", {
      reason: "must-never-reach-erp",
    });
    assert.equal(blocked.recorded, false);
    assert.equal(blocked.reason, "prefix-gate-budget-exhausted");

    assert.equal(releaseSubmissionGate({
      dbPath,
      runId: "fixed-500",
      releasedAt: "2026-07-30T00:05:00.000Z",
      result: { passed: true },
    }).phase, "released");
    assert.equal(worker.reserveSubmission("gate-d", {
      reason: "submission-intent-after-release",
    }).recorded, true);
    worker.close();

    assert.throws(() => initializeSubmissionGate({
      dbPath,
      runId: "fixed-500",
      runDir: path.join(dir, "formal-run"),
      targetSkus: ["different-a", "different-b", "different-c"],
      startedAt: "2026-07-30T00:00:00.000Z",
    }), /does not match its frozen SKU set/);
  });
});

test("operator-direct submission gate is durably released at T0 without frozen SKUs", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime.sqlite");
    const bootstrap = createRuntimeState({ dbPath });
    bootstrap.close();
    const gate = initializeSubmissionGate({
      dbPath,
      runId: "direct-500",
      runDir: path.join(dir, "formal-run"),
      targetSkus: [],
      startedAt: "2026-07-31T00:00:00.000Z",
      phase: "released",
      result: {
        passed: true,
        skipped: true,
        reason: "operator-direct-publish-zero-buffer-authorized",
      },
    });
    assert.equal(gate.phase, "released");
    assert.equal(gate.releasedAt, "2026-07-31T00:00:00.000Z");
    assert.deepEqual(gate.targetSkus, []);
    assert.deepEqual(gate.result, {
      passed: true,
      skipped: true,
      reason: "operator-direct-publish-zero-buffer-authorized",
    });

    const worker = createRuntimeState({
      dbPath,
      ownerId: "worker",
      generationId: "generation",
      requiredSubmissionGateRunId: "direct-500",
      requiredSubmissionGateRunDir: path.join(dir, "formal-run"),
    });
    assert.equal(worker.reserveSubmission("first-qualified-sku", {
      reason: "submission-intent",
    }).recorded, true);
    worker.close();

    assert.throws(() => initializeSubmissionGate({
      dbPath,
      runId: "invalid-direct",
      runDir: path.join(dir, "invalid-formal-run"),
      targetSkus: ["must-not-freeze"],
      startedAt: "2026-07-31T00:00:00.000Z",
      phase: "released",
    }), /released submission gate requires zero target SKUs/);
  });
});

test("a production worker configured to require a missing prefix gate fails closed", async () => {
  await withTempDir(async (dir) => {
    const state = createRuntimeState({
      dbPath: path.join(dir, "runtime.sqlite"),
      requiredSubmissionGateRunId: "missing-gate",
      requiredSubmissionGateRunDir: path.join(dir, "formal-run"),
    });
    const result = state.reserveSubmission("never-submit", {
      reason: "submission-intent",
    });
    assert.equal(result.recorded, false);
    assert.equal(result.reason, "submission-gate-missing");
    state.close();
  });
});

test("submission reservations and strict publications atomically claim canonical title keys", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime.sqlite");
    const ownerA = createRuntimeState({
      dbPath,
      ownerId: "worker-a",
      generationId: "generation-a",
    });
    const ownerB = createRuntimeState({
      dbPath,
      ownerId: "worker-b",
      generationId: "generation-b",
    });
    const title = "Durable Extra Long Product Title With Model ZX-900";
    const titleSupplyData = { ...strictDataAt(new Date()), title };

    assert.equal(ownerA.reserveSubmission("title-a", {
      reason: "submission-intent",
      data: { title },
    }).recorded, true);
    const activeDuplicate = ownerB.reserveSubmission("title-b", {
      reason: "submission-intent",
      data: { title: "durable, extra-long product title with model ZX 900" },
    });
    assert.equal(activeDuplicate.recorded, false);
    assert.equal(activeDuplicate.reason, "duplicate-title-reservation");
    assert.equal(activeDuplicate.duplicateSku, "title-a");

    persistTrustedSupplySubmission(ownerA, "title-a", titleSupplyData);
    assert.equal(ownerA.recordStrictPublication("title-a", {
      reason: "strict-confirmed",
      data: titleSupplyData,
    }).recorded, true);
    const terminalDuplicate = ownerB.reserveSubmission("title-b", {
      reason: "must-not-duplicate-strict-title",
      data: { title },
    });
    assert.equal(terminalDuplicate.recorded, false);
    assert.equal(terminalDuplicate.reason, "duplicate-title-terminal");
    assert.equal(terminalDuplicate.duplicateSku, "title-a");

    ownerA.close();
    ownerB.close();
  });
});

test("direct submission reservations deduplicate by SKU without enforcing historical title claims", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime.sqlite");
    const strictOwner = createRuntimeState({
      dbPath,
      ownerId: "strict-worker",
      generationId: "strict-generation",
    });
    const directOwner = createRuntimeState({
      dbPath,
      ownerId: "direct-worker",
      generationId: "direct-generation",
      enforceTitleUniqueness: false,
    });
    const title = "Reusable Product Title Model ZX-900";
    const strictTitleSupplyData = { ...strictDataAt(new Date()), title };

    assert.equal(strictOwner.reserveSubmission("strict-title-sku", {
      reason: "submission-intent",
      data: { title },
    }).recorded, true);
    persistTrustedSupplySubmission(strictOwner, "strict-title-sku", strictTitleSupplyData);
    assert.equal(strictOwner.recordStrictPublication("strict-title-sku", {
      reason: "strict-confirmed",
      data: strictTitleSupplyData,
    }).recorded, true);

    const directReservation = directOwner.reserveSubmission("direct-title-sku", {
      reason: "submission-intent",
      data: { title },
    });
    assert.equal(directReservation.recorded, true);
    assert.equal(directReservation.reservation.titleKey, null);
    const directSupplyData = { ...strictDataAt(new Date()), title };
    assert.equal(directOwner.reserveSubmission("direct-title-sku", {
      reason: "same-sku-reentry",
      data: directSupplyData,
    }).recorded, true);
    assert.equal(
      directOwner.submissionReservation("direct-title-sku").data.api_call_started_at,
      directSupplyData.api_call_started_at,
    );

    strictOwner.close();
    directOwner.close();
  });
});

test("deterministic and invariant failures are terminal", async () => {
  await withTempDir(async (dir) => {
    const state = createRuntimeState({ dbPath: path.join(dir, "runtime.sqlite") });

    assert.equal(state.recordFailure("deterministic", {
      reason: "prohibited-category",
      kind: "deterministic",
    }).recorded, true);
    assert.equal(state.get("deterministic").terminal, true);
    assert.equal(state.recordSubmission("deterministic", {
      reason: "must-not-resubmit",
    }).recorded, false);

    assert.equal(state.recordFailure("invariant", {
      reason: "fbs-evidence-missing",
      kind: "invariant",
    }).recorded, true);
    assert.equal(state.get("invariant").terminal, true);
    assert.equal(state.recordDelay("invariant", {
      reason: "must-not-delay",
      nextEligibleAt: "2026-07-29T04:00:00.000Z",
    }).recorded, false);
    state.close();
  });
});

test("transient failures are capped at two attempts per SKU per Shanghai day", async () => {
  await withTempDir(async (dir) => {
    let now = new Date("2026-07-29T01:00:00.000Z"); // 09:00 Asia/Shanghai
    const state = createRuntimeState({
      dbPath: path.join(dir, "runtime.sqlite"),
      now: () => now,
    });

    const first = state.recordFailure("retry", {
      reason: "temporary-timeout",
      kind: "transient",
      nextEligibleAt: "2026-07-29T01:05:00.000Z",
    });
    assert.deepEqual(
      { recorded: first.recorded, attempts: first.attempts, dailyLimitReached: first.dailyLimitReached },
      { recorded: true, attempts: 1, dailyLimitReached: false },
    );
    assert.equal(state.canAttempt("retry", { at: "2026-07-29T01:04:59.000Z" }).allowed, false);
    assert.deepEqual(
      state.canAttemptFromState(state.get("retry"), { at: "2026-07-29T01:04:59.000Z" }),
      state.canAttempt("retry", { at: "2026-07-29T01:04:59.000Z" }),
    );
    assert.equal(state.recordSubmission("retry", {
      reason: "must-wait-until-next-eligible",
    }).recorded, false);

    now = new Date("2026-07-29T01:06:00.000Z");
    assert.equal(state.recordSubmission("retry", {
      reason: "eligible-retry-submitted",
    }).recorded, true);
    const second = state.recordFailure("retry", {
      reason: "temporary-timeout",
      kind: "transient",
      nextEligibleAt: "2026-07-29T01:10:00.000Z",
    });
    assert.deepEqual(
      { recorded: second.recorded, attempts: second.attempts, dailyLimitReached: second.dailyLimitReached },
      { recorded: true, attempts: 2, dailyLimitReached: true },
    );
    assert.equal(state.canAttempt("retry", { at: "2026-07-29T15:59:00.000Z" }).allowed, false);
    assert.deepEqual(
      state.canAttemptFromState(state.get("retry"), { at: "2026-07-29T15:59:00.000Z" }),
      state.canAttempt("retry", { at: "2026-07-29T15:59:00.000Z" }),
    );
    assert.equal(state.recordSubmission("retry", {
      reason: "must-not-submit-third-attempt",
    }).recorded, false);

    const third = state.recordFailure("retry", {
      reason: "must-not-record-third-attempt",
      kind: "transient",
      nextEligibleAt: "2026-07-29T21:00:00.000Z",
    });
    assert.deepEqual(
      { recorded: third.recorded, attempts: third.attempts, dailyLimitReached: third.dailyLimitReached },
      { recorded: false, attempts: 2, dailyLimitReached: true },
    );
    assert.equal(state.get("retry").reason, "temporary-timeout");

    // 16:01Z is 00:01 on the next Shanghai natural day.
    now = new Date("2026-07-29T16:01:00.000Z");
    assert.equal(state.canAttempt("retry").allowed, true);
    assert.deepEqual(
      state.canAttemptFromState(state.get("retry")),
      state.canAttempt("retry"),
    );
    assert.throws(
      () => state.canAttemptFromState(null),
      /state must be a runtime state entry/u,
    );
    const nextDay = state.recordFailure("retry", {
      reason: "next-day-timeout",
      kind: "transient",
      nextEligibleAt: "2026-07-29T16:06:00.000Z",
    });
    assert.equal(nextDay.attempts, 1);
    state.close();
  });
});

test("strict publications enforce acceptance invariants and one unique row per SKU", async () => {
  await withTempDir(async (dir) => {
    const state = createRuntimeState({ dbPath: path.join(dir, "runtime.sqlite") });
    const currentStrictData = strictDataAt(new Date());

    assert.throws(() => state.recordStrictPublication("bad-profit", {
      reason: "strict-confirmed",
      data: { ...strictData, profit_rate: 30 },
    }), /profit_rate > 30/);
    assert.throws(() => state.recordStrictPublication("bad-status", {
      reason: "strict-confirmed",
      data: { ...strictData, online_status: "unknown" },
    }), /online_status=selling/);
    assert.throws(() => state.recordStrictPublication("bad-stock", {
      reason: "strict-confirmed",
      data: { ...strictData, stock: 0 },
    }), /stock > 0/);
    assert.throws(() => state.recordStrictPublication("bad-mode", {
      reason: "strict-confirmed",
      data: { ...strictData, shipping_mode: "FBO" },
    }), /pure FBS/);
    assert.throws(() => state.recordStrictPublication("bad-fbs-proof", {
      reason: "strict-confirmed",
      data: { ...strictData, fbs_evidence: { verified: false } },
    }), /FBS evidence/);
    assert.throws(() => state.recordStrictPublication("bad-cost-proof", {
      reason: "strict-confirmed",
      data: { ...strictData, cost_verified: false },
    }), /reliable 1688 cost/);
    assert.throws(() => state.recordStrictPublication("bad-cost-value", {
      reason: "strict-confirmed",
      data: { ...strictData, cost: { ok: true, cost: 0 } },
    }), /reliable 1688 cost/);
    assert.throws(() => state.recordStrictPublication("bad-same-item-proof", {
      reason: "strict-confirmed",
      data: {
        ...strictDataAt("2026-07-29T01:00:00.000Z"),
        cost_evidence: { ...strictData.cost_evidence, same_item_match: false },
      },
    }), /reliable 1688 cost/);
    assert.throws(() => state.recordStrictPublication("bad-cost-source", {
      reason: "strict-confirmed",
      data: {
        ...strictData,
        cost_source: "arbitrary-positive-number",
        cost: { ...strictData.cost, source: "arbitrary-positive-number" },
        cost_evidence: {
          ...strictData.cost_evidence,
          source: "arbitrary-positive-number",
        },
      },
    }), /reliable 1688 cost/);
    assert.throws(() => state.recordStrictPublication("bad-quality-gate", {
      reason: "strict-confirmed",
      data: { ...strictData, quality_gate_passed: false },
    }), /quality-gate evidence/);
    assert.throws(() => state.recordStrictPublication("missing-supply-gate", {
      reason: "strict-confirmed",
      data: { ...strictData, supply_gate_passed: false },
    }), /supply_gate_passed=true/);
    assert.throws(() => state.recordStrictPublication("forged-supply-contract", {
      reason: "strict-confirmed",
      data: {
        ...strictData,
        supply_evidence: { ...strictData.supply_evidence, contract: "1688-orderable-v0" },
      },
    }), /contract=1688-orderable-v1/);
    assert.throws(() => state.recordStrictPublication("missing-variant-binding", {
      reason: "strict-confirmed",
      data: {
        ...strictData,
        supply_evidence: { ...strictData.supply_evidence, item_level_match: false },
      },
    }), /item-level evidence only when no explicit target variant exists/);
    assert.throws(() => state.recordStrictPublication("bad-moq", {
      reason: "strict-confirmed",
      data: {
        ...strictData,
        supply_evidence: { ...strictData.supply_evidence, moq: 2 },
      },
    }), /moq <= 1/);
    assert.throws(() => state.recordStrictPublication("not-orderable", {
      reason: "strict-confirmed",
      data: {
        ...strictData,
        supply_evidence: { ...strictData.supply_evidence, orderable: false },
      },
    }), /in-stock, orderable/);
    assert.throws(() => state.recordStrictPublication("expired-supply", {
      reason: "strict-confirmed",
      data: strictDataAt(new Date(), {
        supply_evidence: {
          checked_at: new Date(Date.now() - 31 * 60_000).toISOString(),
          valid_until: new Date(Date.now() - 60_000).toISOString(),
        },
      }),
    }), /valid when the ERP submission started/);

    persistTrustedSupplySubmission(state, "forged-submission-time", currentStrictData);
    assert.throws(() => state.recordStrictPublication("forged-submission-time", {
      reason: "strict-confirmed",
      data: {
        ...currentStrictData,
        api_call_started_at: new Date(
          Date.parse(currentStrictData.api_call_started_at) + 1_000,
        ).toISOString(),
      },
    }), /api_call_started_at from the trusted submission chain/iu);
    persistTrustedSupplySubmission(state, "forged-persisted-evidence", currentStrictData);
    assert.throws(() => state.recordStrictPublication("forged-persisted-evidence", {
      reason: "strict-confirmed",
      data: {
        ...currentStrictData,
        supply_evidence: { ...currentStrictData.supply_evidence, unit_price: 19 },
      },
    }), /supply evidence persisted before the ERP submission/iu);

    persistTrustedSupplySubmission(state, "strict", currentStrictData);
    assert.equal(state.recordStrictPublication("strict", {
      reason: "strict-confirmed",
      data: currentStrictData,
    }).recorded, true);
    const strictVariantData = {
      ...currentStrictData,
      target_variant: {
        required: true,
        attributes: { color: "red", size: "M" },
      },
      supply_evidence: {
        ...currentStrictData.supply_evidence,
        item_level_match: false,
        target_variant: { color: "red", size: "m" },
        variant_attributes: { color: "red", size: "m" },
      },
    };
    persistTrustedSupplySubmission(state, "strict-variant", strictVariantData);
    assert.equal(state.recordStrictPublication("strict-variant", {
      reason: "strict-variant-confirmed",
      data: strictVariantData,
    }).recorded, true);
    assert.equal(state.recordStrictPublication("strict", {
      reason: "duplicate-confirmation",
      data: currentStrictData,
    }).recorded, false);
    assert.equal(state.strictCount(), 2);
    assert.equal(state.get("strict").strict, true);
    assert.equal(state.recordFailure("strict", {
      reason: "must-not-regress",
      kind: "transient",
      nextEligibleAt: "2026-07-29T02:00:00.000Z",
    }).recorded, false);
    state.close();
  });
});

test("strict cost evidence requires one bound strong offer or two independent corroborated offers", async () => {
  await withTempDir(async (dir) => {
    const state = createRuntimeState({ dbPath: path.join(dir, "runtime.sqlite") });
    const publicationAt = new Date();
    const strong = strictCostLaneDataAt(publicationAt, "strong_single");
    const corroborated = strictCostLaneDataAt(publicationAt, "corroborated_multi");

    persistTrustedSupplySubmission(state, "strict-cost-strong-one", strong);
    assert.equal(state.recordStrictPublication("strict-cost-strong-one", {
      reason: "strict-cost-strong-one-confirmed",
      data: strong,
    }).recorded, true);
    persistTrustedSupplySubmission(state, "strict-cost-corroborated-two", corroborated);
    assert.equal(state.recordStrictPublication("strict-cost-corroborated-two", {
      reason: "strict-cost-corroborated-two-confirmed",
      data: corroborated,
    }).recorded, true);

    const forgedStrong = structuredClone(strong);
    forgedStrong.cost.balanced_supporting_offer_evidence = [];
    assert.throws(() => state.recordStrictPublication("forged-strong-count", {
      reason: "forged-strong-count",
      data: forgedStrong,
    }), /reliable 1688 cost/iu);

    const forgedCorroborated = structuredClone(corroborated);
    forgedCorroborated.cost.balanced_supporting_offer_evidence[1].supplier_id =
      forgedCorroborated.cost.balanced_supporting_offer_evidence[0].supplier_id;
    assert.throws(() => state.recordStrictPublication("forged-corroborated-supplier", {
      reason: "forged-corroborated-supplier",
      data: forgedCorroborated,
    }), /reliable 1688 cost/iu);

    const genericOne = structuredClone(strong);
    genericOne.cost.balanced_match = false;
    genericOne.cost.balanced_match_type = "rejected";
    assert.throws(() => state.recordStrictPublication("generic-one-row", {
      reason: "generic-one-row",
      data: genericOne,
    }), /reliable 1688 cost/iu);
    state.close();
  });
});

test("image-primary SupplyEvidenceV1 accepts strong or corroborated visual proof and rejects weakened bindings", () => {
  const publicationAt = "2026-08-15T02:00:00.000Z";
  const validStrong = imagePrimaryDataAt(publicationAt);
  assert.equal(supplyEvidenceV1InvariantError(validStrong, publicationAt), null);
  const validTextSoft = imagePrimaryDataAt(publicationAt, {
    imageEvidenceOverrides: {
      semantic_strength: "image_backed",
      identity_conflicts: [],
      lane: "strong_visual_text_soft",
      image: {
        available: true,
        score: 0.90,
        color_score: 0.90,
        dhash_score: 0.82,
      },
    },
  });
  assert.equal(supplyEvidenceV1InvariantError(validTextSoft, publicationAt), null);

  const missingTextSoftIdentityBinding = structuredClone(validTextSoft);
  delete missingTextSoftIdentityBinding.supply_candidates[0].image_match_evidence.identity_conflicts;
  delete missingTextSoftIdentityBinding.supply_evidence.image_match_evidence.identity_conflicts;
  delete missingTextSoftIdentityBinding.cost.balanced_supporting_offer_evidence[0].identity_conflicts;
  assert.match(
    supplyEvidenceV1InvariantError(missingTextSoftIdentityBinding, publicationAt),
    /strong_visual_text_soft evidence is below/iu,
  );

  const conflictedTextSoftIdentity = structuredClone(validTextSoft);
  for (const row of [
    conflictedTextSoftIdentity.supply_candidates[0].image_match_evidence,
    conflictedTextSoftIdentity.supply_evidence.image_match_evidence,
    conflictedTextSoftIdentity.cost.balanced_supporting_offer_evidence[0],
  ]) row.identity_conflicts = ["explicit_model_conflict:X100!=Y200"];
  assert.match(
    supplyEvidenceV1InvariantError(conflictedTextSoftIdentity, publicationAt),
    /conflict-free v3 image metrics/iu,
  );

  const tamperedTextSoftCostIdentity = structuredClone(validTextSoft);
  tamperedTextSoftCostIdentity.cost.balanced_supporting_offer_evidence[0].identity_conflicts = [
    "explicit_model_conflict:X100!=Y200",
  ];
  assert.match(
    supplyEvidenceV1InvariantError(tamperedTextSoftCostIdentity, publicationAt),
    /canonically match its supporting cost row/iu,
  );

  for (const [component, value] of [
    ["score", 0.89],
    ["color_score", 0.89],
    ["dhash_score", 0.81],
  ]) {
    const belowTextSoftThreshold = imagePrimaryDataAt(publicationAt, {
      imageEvidenceOverrides: {
        semantic_strength: "image_backed",
        identity_conflicts: [],
        lane: "strong_visual_text_soft",
        image: {
          available: true,
          score: 0.90,
          color_score: 0.90,
          dhash_score: 0.82,
          [component]: value,
        },
      },
    });
    assert.match(
      supplyEvidenceV1InvariantError(belowTextSoftThreshold, publicationAt),
      /strong_visual_text_soft evidence is below/iu,
      component,
    );
  }

  const forgedLowThresholdImageBacked = imagePrimaryDataAt(publicationAt, {
      imageEvidenceOverrides: { semantic_strength: "image_backed" },
  });
  assert.match(
    supplyEvidenceV1InvariantError(forgedLowThresholdImageBacked, publicationAt),
    /strong_visual evidence is below/iu,
  );
  const forgedTextBackedSoftLane = imagePrimaryDataAt(publicationAt, {
    imageEvidenceOverrides: {
      lane: "strong_visual_text_soft",
      image: { available: true, score: 0.95, color_score: 0.95, dhash_score: 0.90 },
    },
  });
  assert.match(
    supplyEvidenceV1InvariantError(forgedTextBackedSoftLane, publicationAt),
    /strong_visual_text_soft evidence is below/iu,
  );
  assert.equal(supplyEvidenceV1InvariantError(strictDataAt(publicationAt), publicationAt), null);
  const validExactThumbnail = imagePrimaryDataAt(publicationAt, {
    evidenceOverrides: {
      selected_variant: {
        row_key: "sku-row-1",
        sku_ids: ["sku-1001"],
        label: "红色 GU10",
        selection_method: "image_primary_exact_thumbnail_url",
        selected_sku_image_url: "https://cbu01.alicdn.com/img/ibank/image-primary.jpg",
        soft_tie: false,
      },
    },
  });
  assert.equal(supplyEvidenceV1InvariantError(validExactThumbnail, publicationAt), null);
  const resizedSignedThumbnail = imagePrimaryDataAt(publicationAt, {
    imageEvidenceOverrides: {
      image_url: "https://cbu01.alicdn.com/img/ibank/image-primary.jpg_sum.jpg?resize=64#sku",
    },
    evidenceOverrides: {
      selected_variant: {
        row_key: "sku-row-1",
        sku_ids: ["sku-1001"],
        label: "红色 GU10",
        selection_method: "image_primary_exact_thumbnail_url",
        selected_sku_image_url: "https://cbu01.alicdn.com/img/ibank/image-primary.jpg",
        soft_tie: false,
      },
    },
  });
  assert.equal(supplyEvidenceV1InvariantError(resizedSignedThumbnail, publicationAt), null);
  const forgedExactThumbnail = structuredClone(validExactThumbnail);
  forgedExactThumbnail.supply_evidence.selected_variant.selected_sku_image_url =
    "https://cbu01.alicdn.com/img/ibank/forged.jpg";
  assert.match(
    supplyEvidenceV1InvariantError(forgedExactThumbnail, publicationAt),
    /thumbnail must exactly match/iu,
  );
  const misleadingBestOverlap = structuredClone(validStrong);
  misleadingBestOverlap.supply_evidence.selected_variant.selected_sku_image_url =
    misleadingBestOverlap.supply_evidence.image_match_evidence.image_url;
  assert.match(
    supplyEvidenceV1InvariantError(misleadingBestOverlap, publicationAt),
    /thumbnail must exactly match/iu,
  );

  const validCorroborated = imagePrimaryDataAt(publicationAt, {
    candidateOverrides: { match_type: "corroborated_multi" },
    imageEvidenceOverrides: {
      lane: "corroborated_visual",
      image: {
        available: true,
        score: 0.62,
        color_score: 0.84,
        dhash_score: 0.48,
      },
      corroborating_offer_ids: ["100000000001", 100000000002],
    },
  });
  assert.equal(supplyEvidenceV1InvariantError(validCorroborated, publicationAt), null);

  const forgedImage = structuredClone(validStrong);
  forgedImage.supply_evidence.image_match_evidence.image.score = 0.99;
  assert.match(
    supplyEvidenceV1InvariantError(forgedImage, publicationAt),
    /canonically match the bound candidate image evidence/iu,
  );

  const lowScore = imagePrimaryDataAt(publicationAt, {
    imageEvidenceOverrides: {
      image: {
        available: true,
        score: 0.67,
        color_score: 0.91,
        dhash_score: 0.70,
      },
    },
  });
  assert.match(supplyEvidenceV1InvariantError(lowScore, publicationAt), /below the required image thresholds/iu);

  const lowColor = imagePrimaryDataAt(publicationAt, {
    imageEvidenceOverrides: {
      image: {
        available: true,
        score: 0.79,
        color_score: 0.89,
        dhash_score: 0.70,
      },
    },
  });
  assert.match(supplyEvidenceV1InvariantError(lowColor, publicationAt), /below the required image thresholds/iu);

  for (const semanticStrength of ["feature_only", "weak_or_none"]) {
    const weakSemantic = imagePrimaryDataAt(publicationAt, {
      imageEvidenceOverrides: { semantic_strength: semanticStrength },
    });
    assert.match(
      supplyEvidenceV1InvariantError(weakSemantic, publicationAt),
      /conflict-free v3 image metrics/iu,
    );
  }

  const conflict = imagePrimaryDataAt(publicationAt, {
    imageEvidenceOverrides: { spec_conflicts: ["color:red!=blue"] },
  });
  assert.match(supplyEvidenceV1InvariantError(conflict, publicationAt), /conflict-free v3 image metrics/iu);

  const accessory = imagePrimaryDataAt(publicationAt, {
    imageEvidenceOverrides: { accessory_conflict: true },
  });
  assert.match(supplyEvidenceV1InvariantError(accessory, publicationAt), /conflict-free v3 image metrics/iu);

  const candidateMismatch = imagePrimaryDataAt(publicationAt, {
    candidateOverrides: { match_basis: "title_only" },
  });
  assert.match(supplyEvidenceV1InvariantError(candidateMismatch, publicationAt), /candidate\.match_basis=image_primary_v1/iu);

  const wrongCorroboratedType = imagePrimaryDataAt(publicationAt, {
    imageEvidenceOverrides: {
      lane: "corroborated_visual",
      image: { available: true, score: 0.62, color_score: 0.84, dhash_score: 0.48 },
      corroborating_offer_ids: ["100000000001", "100000000002"],
    },
  });
  assert.match(
    supplyEvidenceV1InvariantError(wrongCorroboratedType, publicationAt),
    /lacks two corroborating offers/iu,
  );

  const corroborationMissingCurrentOffer = imagePrimaryDataAt(publicationAt, {
    candidateOverrides: { match_type: "corroborated_multi" },
    imageEvidenceOverrides: {
      lane: "corroborated_visual",
      image: { available: true, score: 0.62, color_score: 0.84, dhash_score: 0.48 },
      corroborating_offer_ids: ["100000000002", "100000000003"],
    },
  });
  assert.match(
    supplyEvidenceV1InvariantError(corroborationMissingCurrentOffer, publicationAt),
    /lacks two corroborating offers/iu,
  );

  const unboundCostRow = imagePrimaryDataAt(publicationAt);
  unboundCostRow.cost.balanced_supporting_offer_evidence = [];
  assert.match(
    supplyEvidenceV1InvariantError(unboundCostRow, publicationAt),
    /bound signed supporting cost row/iu,
  );

  const forgedCostRow = imagePrimaryDataAt(publicationAt);
  forgedCostRow.cost.balanced_supporting_offer_evidence[0].title = "different signed title";
  assert.match(
    supplyEvidenceV1InvariantError(forgedCostRow, publicationAt),
    /canonically match its supporting cost row/iu,
  );

  const insecureImageUrl = imagePrimaryDataAt(publicationAt, {
    imageEvidenceOverrides: { image_url: "http://cbu01.alicdn.com/img/ibank/image-primary.jpg" },
  });
  assert.match(
    supplyEvidenceV1InvariantError(insecureImageUrl, publicationAt),
    /signed row|conflict-free v3 image metrics/iu,
  );

  const missingSelectedVariant = imagePrimaryDataAt(publicationAt);
  delete missingSelectedVariant.supply_evidence.selected_variant;
  assert.match(
    supplyEvidenceV1InvariantError(missingSelectedVariant, publicationAt),
    /non-ambiguous selected variant row/iu,
  );

  const softTie = imagePrimaryDataAt(publicationAt, {
    evidenceOverrides: {
      selected_variant: {
        row_key: "sku-row-1",
        label: "红色 GU10",
        selection_method: "image_primary_soft_tie_dom_order",
        soft_tie: true,
      },
    },
  });
  assert.match(supplyEvidenceV1InvariantError(softTie, publicationAt), /non-ambiguous selected variant row/iu);

  const unsupportedSelectionMethod = imagePrimaryDataAt(publicationAt, {
    evidenceOverrides: {
      selected_variant: {
        row_key: "sku-row-1",
        label: "红色 GU10",
        selection_method: "image_primary_soft_tie_dom_order",
        soft_tie: false,
      },
    },
  });
  assert.match(
    supplyEvidenceV1InvariantError(unsupportedSelectionMethod, publicationAt),
    /non-ambiguous selected variant row/iu,
  );

  const missingDifference = imagePrimaryDataAt(publicationAt, {
    evidenceOverrides: { variant_differences: [] },
  });
  assert.match(
    supplyEvidenceV1InvariantError(missingDifference, publicationAt),
    /must equal every unbound target attribute/iu,
  );

  const forgedDifference = imagePrimaryDataAt(publicationAt, {
    evidenceOverrides: {
      variant_differences: [
        { name: "model", expected: "gu11", observed: null, kind: "unbound_soft" },
      ],
    },
  });
  assert.match(
    supplyEvidenceV1InvariantError(forgedDifference, publicationAt),
    /does not match the unbound target attributes/iu,
  );

  const explicitSet = imagePrimaryDataAt(publicationAt, {
    targetVariant: {
      required: true,
      attributes: { color: "红色", model: "GU10", set_quantity: 3 },
    },
    evidenceOverrides: {
      target_variant: { color: "red", model: "gu10", set_quantity: "3" },
    },
  });
  assert.match(supplyEvidenceV1InvariantError(explicitSet, publicationAt), /set_quantity greater than 1/iu);
});

test("SQLite supply triggers enforce the image-primary evidence contract independently of Node validation", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime.sqlite");
    const state = createRuntimeState({ dbPath, now: () => new Date("2026-08-15T02:00:00.000Z") });
    const valid = imagePrimaryDataAt("2026-08-15T02:00:00.000Z");
    assert.equal(state.reserveSubmission("image-primary-node-and-sql", {
      reason: "submission-api-call-started",
      data: { ...valid, submission_intent: true, submitted: false },
    }).recorded, true);

    const writer = new DatabaseSync(dbPath);
    const insertRaw = writer.prepare(`
      INSERT INTO submission_reservations (
        sku, owner_id, generation_id, status, title_key,
        lease_expires_at, data_json, updated_at
      ) VALUES (?, 'forged-owner', 'forged-generation', 'reserved', NULL,
        '2026-08-15T02:30:00.000Z', ?, '2026-08-15T02:00:00.000Z')
    `);
    const rawData = {
      ...valid,
      supply_target_variant_canonical: { color: "red", model: "gu10" },
      submission_intent: true,
      submitted: false,
    };
    rawData.supply_evidence = {
      ...rawData.supply_evidence,
      image_match_evidence: Object.fromEntries(
        Object.entries(rawData.supply_evidence.image_match_evidence).reverse(),
      ),
    };
    try {
      assert.doesNotThrow(() => insertRaw.run("image-primary-raw-valid", JSON.stringify(rawData)));

      const textSoft = imagePrimaryDataAt("2026-08-15T02:00:00.000Z", {
        imageEvidenceOverrides: {
          semantic_strength: "image_backed",
          identity_conflicts: [],
          lane: "strong_visual_text_soft",
          image: { available: true, score: 0.90, color_score: 0.90, dhash_score: 0.82 },
        },
      });
      textSoft.supply_target_variant_canonical = { color: "red", model: "gu10" };
      textSoft.submission_intent = true;
      textSoft.submitted = false;
      assert.doesNotThrow(() => insertRaw.run("image-primary-raw-text-soft", JSON.stringify(textSoft)));

      const missingTextSoftIdentityBinding = structuredClone(textSoft);
      delete missingTextSoftIdentityBinding.supply_candidates[0].image_match_evidence.identity_conflicts;
      delete missingTextSoftIdentityBinding.supply_evidence.image_match_evidence.identity_conflicts;
      delete missingTextSoftIdentityBinding.cost.balanced_supporting_offer_evidence[0].identity_conflicts;
      assert.throws(
        () => insertRaw.run("image-primary-raw-text-soft-missing-identity", JSON.stringify(missingTextSoftIdentityBinding)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const conflictedTextSoftIdentity = structuredClone(textSoft);
      for (const row of [
        conflictedTextSoftIdentity.supply_candidates[0].image_match_evidence,
        conflictedTextSoftIdentity.supply_evidence.image_match_evidence,
        conflictedTextSoftIdentity.cost.balanced_supporting_offer_evidence[0],
      ]) row.identity_conflicts = ["explicit_model_conflict:X100!=Y200"];
      assert.throws(
        () => insertRaw.run("image-primary-raw-text-soft-conflict", JSON.stringify(conflictedTextSoftIdentity)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const tamperedTextSoftCostIdentity = structuredClone(textSoft);
      tamperedTextSoftCostIdentity.cost.balanced_supporting_offer_evidence[0].identity_conflicts = [
        "explicit_model_conflict:X100!=Y200",
      ];
      assert.throws(
        () => insertRaw.run("image-primary-raw-text-soft-cost-tamper", JSON.stringify(tamperedTextSoftCostIdentity)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const lowTextSoftDhash = structuredClone(textSoft);
      lowTextSoftDhash.supply_candidates[0].image_match_evidence.image.dhash_score = 0.81;
      lowTextSoftDhash.supply_evidence.image_match_evidence.image.dhash_score = 0.81;
      lowTextSoftDhash.cost.balanced_supporting_offer_evidence[0].image.dhash_score = 0.81;
      assert.throws(
        () => insertRaw.run("image-primary-raw-text-soft-low-dhash", JSON.stringify(lowTextSoftDhash)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const forgedLegacyTextSoft = structuredClone(textSoft);
      forgedLegacyTextSoft.supply_candidates[0].image_match_evidence.lane = "strong_visual";
      forgedLegacyTextSoft.supply_evidence.image_match_evidence.lane = "strong_visual";
      assert.throws(
        () => insertRaw.run("image-primary-raw-text-soft-forged-legacy-lane", JSON.stringify(forgedLegacyTextSoft)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const forgedTextBackedSoftLane = structuredClone(textSoft);
      forgedTextBackedSoftLane.supply_candidates[0].image_match_evidence.semantic_strength = "exact_model";
      forgedTextBackedSoftLane.supply_evidence.image_match_evidence.semantic_strength = "exact_model";
      forgedTextBackedSoftLane.cost.balanced_supporting_offer_evidence[0].semantic_strength = "exact_model";
      assert.throws(
        () => insertRaw.run("image-primary-raw-text-backed-soft-lane", JSON.stringify(forgedTextBackedSoftLane)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const exactThumbnail = structuredClone(rawData);
      exactThumbnail.supply_evidence.selected_variant.selection_method = "image_primary_exact_thumbnail_url";
      exactThumbnail.supply_evidence.selected_variant.selected_sku_image_url =
        exactThumbnail.supply_evidence.image_match_evidence.image_url;
      assert.doesNotThrow(() => insertRaw.run("image-primary-raw-exact-thumbnail", JSON.stringify(exactThumbnail)));

      const resizedThumbnail = imagePrimaryDataAt("2026-08-15T02:00:00.000Z", {
        imageEvidenceOverrides: {
          image_url: "https://cbu01.alicdn.com/img/ibank/image-primary.jpg_sum.jpg?resize=64#sku",
        },
        evidenceOverrides: {
          selected_variant: {
            row_key: "sku-row-1",
            sku_ids: ["sku-1001"],
            label: "红色 GU10",
            selection_method: "image_primary_exact_thumbnail_url",
            selected_sku_image_url: "https://cbu01.alicdn.com/img/ibank/image-primary.jpg",
            soft_tie: false,
          },
        },
      });
      resizedThumbnail.supply_target_variant_canonical = { color: "red", model: "gu10" };
      resizedThumbnail.submission_intent = true;
      resizedThumbnail.submitted = false;
      assert.doesNotThrow(() => insertRaw.run(
        "image-primary-raw-resized-thumbnail",
        JSON.stringify(resizedThumbnail),
      ));

      const forgedExactThumbnail = structuredClone(exactThumbnail);
      forgedExactThumbnail.supply_evidence.selected_variant.selected_sku_image_url =
        "https://cbu01.alicdn.com/img/ibank/forged.jpg";
      assert.throws(
        () => insertRaw.run("image-primary-raw-forged-thumbnail", JSON.stringify(forgedExactThumbnail)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const misleadingBestOverlap = structuredClone(rawData);
      misleadingBestOverlap.supply_evidence.selected_variant.selected_sku_image_url =
        misleadingBestOverlap.supply_evidence.image_match_evidence.image_url;
      assert.throws(
        () => insertRaw.run("image-primary-raw-misleading-thumbnail", JSON.stringify(misleadingBestOverlap)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const lowScore = structuredClone(rawData);
      lowScore.supply_candidates[0].image_match_evidence.image.score = 0.67;
      lowScore.supply_evidence.image_match_evidence.image.score = 0.67;
      lowScore.cost.balanced_supporting_offer_evidence[0].image.score = 0.67;
      assert.throws(
        () => insertRaw.run("image-primary-raw-low-score", JSON.stringify(lowScore)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const lowColor = structuredClone(rawData);
      lowColor.supply_candidates[0].image_match_evidence.image.color_score = 0.89;
      lowColor.supply_evidence.image_match_evidence.image.color_score = 0.89;
      lowColor.cost.balanced_supporting_offer_evidence[0].image.color_score = 0.89;
      assert.throws(
        () => insertRaw.run("image-primary-raw-low-color", JSON.stringify(lowColor)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const weakSemantic = structuredClone(rawData);
      weakSemantic.supply_candidates[0].image_match_evidence.semantic_strength = "feature_only";
      weakSemantic.supply_evidence.image_match_evidence.semantic_strength = "feature_only";
      weakSemantic.cost.balanced_supporting_offer_evidence[0].semantic_strength = "feature_only";
      assert.throws(
        () => insertRaw.run("image-primary-raw-weak-semantic", JSON.stringify(weakSemantic)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const forgedBinding = structuredClone(rawData);
      forgedBinding.supply_evidence.image_match_evidence.image_url = "https://forged.example/image.jpg";
      assert.throws(
        () => insertRaw.run("image-primary-raw-forged-binding", JSON.stringify(forgedBinding)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const conflicts = structuredClone(rawData);
      conflicts.supply_candidates[0].image_match_evidence.spec_conflicts = ["model conflict"];
      conflicts.supply_evidence.image_match_evidence.spec_conflicts = ["model conflict"];
      conflicts.cost.balanced_supporting_offer_evidence[0].spec_conflicts = ["model conflict"];
      assert.throws(
        () => insertRaw.run("image-primary-raw-conflict", JSON.stringify(conflicts)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const wrongCorroboratedType = structuredClone(rawData);
      for (const imageEvidence of [
        wrongCorroboratedType.supply_candidates[0].image_match_evidence,
        wrongCorroboratedType.supply_evidence.image_match_evidence,
      ]) {
        imageEvidence.lane = "corroborated_visual";
        imageEvidence.image = { available: true, score: 0.62, color_score: 0.84, dhash_score: 0.48 };
        imageEvidence.corroborating_offer_ids = ["100000000001", "100000000002"];
      }
      wrongCorroboratedType.cost.balanced_supporting_offer_evidence[0].image = {
        available: true,
        score: 0.62,
        color_score: 0.84,
        dhash_score: 0.48,
      };
      assert.throws(
        () => insertRaw.run("image-primary-raw-wrong-corroborated-type", JSON.stringify(wrongCorroboratedType)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const missingCurrentCorroboration = structuredClone(wrongCorroboratedType);
      missingCurrentCorroboration.supply_candidates[0].match_type = "corroborated_multi";
      missingCurrentCorroboration.supply_candidates[0].image_match_evidence.corroborating_offer_ids = [
        "100000000002", "100000000003",
      ];
      missingCurrentCorroboration.supply_evidence.image_match_evidence.corroborating_offer_ids = [
        "100000000002", "100000000003",
      ];
      assert.throws(
        () => insertRaw.run("image-primary-raw-missing-current-corroboration", JSON.stringify(missingCurrentCorroboration)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const unboundCostRow = structuredClone(rawData);
      unboundCostRow.cost.balanced_supporting_offer_evidence = [];
      assert.throws(
        () => insertRaw.run("image-primary-raw-unbound-cost-row", JSON.stringify(unboundCostRow)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const forgedCostRow = structuredClone(rawData);
      forgedCostRow.cost.balanced_supporting_offer_evidence[0].supplier_id = "forged-supplier";
      assert.throws(
        () => insertRaw.run("image-primary-raw-forged-cost-row", JSON.stringify(forgedCostRow)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const insecureImage = structuredClone(rawData);
      insecureImage.supply_candidates[0].image_match_evidence.image_url =
        "http://cbu01.alicdn.com/img/ibank/image-primary.jpg";
      insecureImage.supply_evidence.image_match_evidence.image_url =
        "http://cbu01.alicdn.com/img/ibank/image-primary.jpg";
      insecureImage.cost.balanced_supporting_offer_evidence[0].image_url =
        "http://cbu01.alicdn.com/img/ibank/image-primary.jpg";
      assert.throws(
        () => insertRaw.run("image-primary-raw-insecure-image", JSON.stringify(insecureImage)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const softTie = structuredClone(rawData);
      softTie.supply_evidence.selected_variant.soft_tie = true;
      assert.throws(
        () => insertRaw.run("image-primary-raw-soft-tie", JSON.stringify(softTie)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const unsupportedSelectionMethod = structuredClone(rawData);
      unsupportedSelectionMethod.supply_evidence.selected_variant.selection_method =
        "image_primary_soft_tie_dom_order";
      assert.throws(
        () => insertRaw.run("image-primary-raw-unsupported-selection", JSON.stringify(unsupportedSelectionMethod)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const missingDifference = structuredClone(rawData);
      missingDifference.supply_evidence.variant_differences = [];
      assert.throws(
        () => insertRaw.run("image-primary-raw-missing-difference", JSON.stringify(missingDifference)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const forgedDifference = structuredClone(rawData);
      forgedDifference.supply_evidence.variant_differences[0].expected = "gu11";
      assert.throws(
        () => insertRaw.run("image-primary-raw-forged-difference", JSON.stringify(forgedDifference)),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );

      const setQuantity = imagePrimaryDataAt("2026-08-15T02:00:00.000Z", {
        targetVariant: { required: true, attributes: { set_quantity: 3 } },
        evidenceOverrides: {
          target_variant: { set_quantity: "3" },
          variant_attributes: {},
        },
      });
      assert.throws(
        () => insertRaw.run("image-primary-raw-set", JSON.stringify({
          ...setQuantity,
          supply_target_variant_canonical: { set_quantity: "3" },
        })),
        /ERP submission requires valid SupplyEvidenceV1/iu,
      );
    } finally {
      writer.close();
      state.close();
    }
  });
});

test("the ERP POST boundary persists immutable supply evidence and later confirmations use the POST time", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime.sqlite");
    const apiStartedAt = "2026-08-15T02:00:00.000Z";
    let clock = new Date(apiStartedAt);
    const state = createRuntimeState({
      dbPath,
      now: () => clock,
    });
    const validData = strictDataAt(apiStartedAt);
    const missingEvidence = {
      api_call_started_at: apiStartedAt,
      submission_intent: true,
    };
    assert.throws(() => state.reserveSubmission("post-backdated-api", {
      reason: "submission-api-call-started",
      data: {
        api_call_started_at: "2026-08-15T01:59:59.000Z",
        submission_intent: true,
      },
    }), /cannot backdate api_call_started_at/iu);
    assert.throws(() => state.reserveSubmission("post-missing-supply", {
      reason: "submission-api-call-started",
      data: missingEvidence,
    }), /supply_gate_passed=true/iu);
    const missingPriceChain = { ...validData };
    delete missingPriceChain.purchase_price_original_p70_p80;
    assert.throws(() => state.reserveSubmission("post-missing-price-chain", {
      reason: "submission-api-call-started",
      data: missingPriceChain,
    }), /numeric original and final purchase prices/iu);
    assert.throws(() => state.reserveSubmission("post-low-original-price", {
      reason: "submission-api-call-started",
      data: {
        ...validData,
        purchase_price_original_p70_p80: 19,
      },
    }), /original P70\/P80 cost bound to the verified cost result/iu);
    assert.throws(() => state.reserveSubmission("post-low-final-price", {
      reason: "submission-api-call-started",
      data: {
        ...validData,
        purchase_price: 24,
        supply_evidence: { ...validData.supply_evidence, unit_price: 25 },
      },
    }), /purchase_price >= max/iu);
    assert.equal(state.reserveSubmission("post-price-epsilon", {
      reason: "submission-api-call-started",
      data: {
        ...validData,
        purchase_price: 24.9999995,
        supply_evidence: { ...validData.supply_evidence, unit_price: 25 },
      },
    }).recorded, true);

    assert.throws(() => state.reserveSubmission("post-wrong-candidate", {
      reason: "submission-api-call-started",
      data: {
        ...validData,
        supply_candidates: [{
          ...validData.supply_candidates[0],
          offer_id: "100000000002",
          offer_url: "https://detail.1688.com/offer/100000000002.html",
        }],
      },
    }), /bound to a strict recalled offer/iu);

    const mismatchedVariantData = {
      ...validData,
      target_variant: {
        required: true,
        attributes: { color: "red" },
      },
      supply_evidence: {
        ...validData.supply_evidence,
        item_level_match: false,
        target_variant: { color: "blue" },
        variant_attributes: { color: "blue" },
      },
    };
    assert.throws(() => state.reserveSubmission("post-wrong-variant", {
      reason: "submission-api-call-started",
      data: mismatchedVariantData,
    }), /exact normalized target and selected variant attributes/iu);
    assert.throws(() => state.reserveSubmission("post-explicit-item-level", {
      reason: "submission-api-call-started",
      data: {
        ...mismatchedVariantData,
        supply_evidence: {
          ...validData.supply_evidence,
          item_level_match: true,
          target_variant: null,
          variant_attributes: {},
        },
      },
    }), /exact normalized target and selected variant attributes/iu);

    const normalizedVariantData = {
      ...validData,
      target_variant: {
        required: true,
        attributes: { color: "红色", capacity: "500 毫升" },
      },
      supply_evidence: {
        ...validData.supply_evidence,
        item_level_match: false,
        target_variant: { color: "red", capacity: "500ml" },
        variant_attributes: { color: "red", capacity: "500ml" },
      },
    };
    assert.equal(state.reserveSubmission("post-normalized-variant", {
      reason: "submission-api-call-started",
      data: normalizedVariantData,
    }).recorded, true);

    const expiredAtPost = strictDataAt(apiStartedAt, {
      supply_evidence: {
        checked_at: "2026-08-15T01:00:00.000Z",
        valid_until: "2026-08-15T01:30:00.000Z",
      },
    });
    assert.throws(() => state.reserveSubmission("post-expired-supply", {
      reason: "submission-api-call-started",
      data: expiredAtPost,
    }), /valid when the ERP submission started/iu);

    assert.equal(state.reserveSubmission("immutable-post-evidence", {
      reason: "submission-api-call-started",
      data: validData,
    }).recorded, true);
    assert.throws(() => state.reserveSubmission("immutable-post-evidence", {
      reason: "forged-reentry",
      data: {
        supply_evidence: { ...validData.supply_evidence, unit_price: 19 },
      },
    }), /immutable/iu);
    assert.throws(() => state.reserveSubmission("immutable-post-evidence", {
      reason: "forged-price-reentry",
      data: { purchase_price: 999 },
    }), /immutable/iu);
    const writer = new DatabaseSync(dbPath);
    try {
      const persistedVariantData = state.submissionReservation("post-normalized-variant").data;
      const insertRawReservation = writer.prepare(`
        INSERT INTO submission_reservations (
          sku, owner_id, generation_id, status, title_key,
          lease_expires_at, data_json, updated_at
        ) VALUES (?, 'forged-owner', 'forged-generation', 'reserved', NULL,
          '2026-08-15T02:30:00.000Z', ?, '2026-08-15T02:00:00.000Z')
      `);
      assert.throws(() => writer.prepare(`
        INSERT INTO submission_reservations (
          sku, owner_id, generation_id, status, title_key,
          lease_expires_at, data_json, updated_at
        ) VALUES (
          'forged-backdated-api', 'forged-owner', 'forged-generation', 'reserved', NULL,
          '2026-08-15T02:30:00.000Z',
          json_object('api_call_started_at', '2026-08-15T01:59:59.000Z'),
          '2026-08-15T01:59:59.000Z'
        )
      `).run(), /ERP submission requires valid SupplyEvidenceV1/iu);
      assert.throws(() => insertRawReservation.run(
        "forged-candidate-binding",
        JSON.stringify({
          ...persistedVariantData,
          supply_candidates: [{
            ...persistedVariantData.supply_candidates[0],
            offer_id: "100000000002",
            offer_url: "https://detail.1688.com/offer/100000000002.html",
          }],
        }),
      ), /ERP submission requires valid SupplyEvidenceV1/iu);
      assert.throws(() => insertRawReservation.run(
        "forged-target-binding",
        JSON.stringify({
          ...persistedVariantData,
          supply_evidence: {
            ...persistedVariantData.supply_evidence,
            target_variant: { color: "blue", capacity: "500ml" },
            variant_attributes: { color: "blue", capacity: "500ml" },
          },
        }),
      ), /ERP submission requires valid SupplyEvidenceV1/iu);
      assert.throws(() => insertRawReservation.run(
        "forged-price-chain",
        JSON.stringify({
          ...persistedVariantData,
          purchase_price: 19,
        }),
      ), /ERP submission requires valid SupplyEvidenceV1/iu);
      assert.throws(() => insertRawReservation.run(
        "forged-external-offer-url",
        JSON.stringify({
          ...persistedVariantData,
          supply_candidates: [{
            ...persistedVariantData.supply_candidates[0],
            offer_url: "https://evil.example/.1688.com/offer/100000000001.html",
          }],
          supply_evidence: {
            ...persistedVariantData.supply_evidence,
            offer_url: "https://evil.example/.1688.com/offer/100000000001.html",
          },
        }),
      ), /ERP submission requires valid SupplyEvidenceV1/iu);
      assert.throws(() => writer.prepare(`
        UPDATE submission_reservations
        SET data_json = json_set(data_json, '$.supply_evidence.unit_price', 999)
        WHERE sku = 'immutable-post-evidence'
      `).run(), /immutable/iu);
      assert.throws(() => writer.prepare(`
        UPDATE submission_reservations
        SET data_json = json_set(data_json, '$.purchase_price', 999)
        WHERE sku = 'immutable-post-evidence'
      `).run(), /immutable/iu);
    } finally {
      writer.close();
    }

    const directWriter = new DatabaseSync(dbPath);
    try {
      assert.throws(() => directWriter.prepare(`
        INSERT INTO events (
          event_key, sku, stage, reason, failure_class, terminal, strict,
          next_eligible_at, data_json, occurred_at, source
        ) VALUES (
          'forged-direct-online', 'forged-direct-online', 'online', 'forged-online',
          NULL, 1, 0, NULL, '{}', ?, 'forged'
        )
      `).run(apiStartedAt), /direct terminal outcome requires valid SupplyEvidenceV1/iu);
      assert.throws(() => directWriter.prepare(`
        INSERT INTO events (
          event_key, sku, stage, reason, failure_class, terminal, strict,
          next_eligible_at, data_json, occurred_at, source
        ) VALUES (
          'forged-backdated-direct', 'forged-backdated-direct', 'online', 'forged-online',
          NULL, 1, 0, NULL, '{}', '2026-08-15T01:59:59.000Z', 'forged'
        )
      `).run(), /direct terminal outcome requires valid SupplyEvidenceV1/iu);
    } finally {
      directWriter.close();
    }

    persistTrustedSupplySubmission(state, "late-strict-confirmation", validData);
    persistTrustedSupplySubmission(state, "late-direct-confirmation", validData);
    clock = new Date("2026-08-15T04:00:00.000Z");
    assert.equal(state.recordStrictPublication("late-strict-confirmation", {
      reason: "strict-confirmed-after-online-delay",
      data: validData,
    }).recorded, true);
    assert.equal(state.recordTerminalOutcome("late-direct-confirmation", {
      reason: "background-online-after-delay",
      stage: "online",
      data: {
        ...state.submissionReservation("late-direct-confirmation").data,
        outcome_status: "online",
      },
    }).recorded, true);
    state.close();
  });
});

test("SQLite itself rejects forged strict evidence and a mismatched SKU/event pair", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "runtime.sqlite");
    const state = createRuntimeState({ dbPath });
    state.recordSubmission("event-owner", {
      reason: "erp-import-requested",
    });
    state.close();

    const database = new DatabaseSync(dbPath);
    try {
      database.exec("PRAGMA foreign_keys = ON");
      assert.throws(() => database.prepare(`
        INSERT INTO events (
          event_key, sku, stage, reason, failure_class, terminal, strict,
          next_eligible_at, data_json, occurred_at, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "forged-strict-event",
        "forged",
        "published",
        "forged-strict",
        null,
        1,
        1,
        null,
        JSON.stringify({ ...strictData, profit_rate: 1 }),
        "2026-07-29T01:00:00.000Z",
        "forged",
      ), /constraint|strict publication requires/i);
      assert.throws(() => database.prepare(`
        INSERT INTO events (
          event_key, sku, stage, reason, failure_class, terminal, strict,
          next_eligible_at, data_json, occurred_at, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "forged-backdated-strict-supply",
        "forged-backdated-strict-supply",
        "published",
        "forged-backdated-strict",
        null,
        1,
        1,
        null,
        JSON.stringify(strictData),
        "2026-07-29T01:00:00.000Z",
        "forged",
      ), /SupplyEvidenceV1/iu);
      assert.throws(() => database.prepare(`
        INSERT INTO events (
          event_key, sku, stage, reason, failure_class, terminal, strict,
          next_eligible_at, data_json, occurred_at, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "forged-strict-without-quality-proof",
        "forged-without-quality-proof",
        "published",
        "forged-strict",
        null,
        1,
        1,
        null,
        JSON.stringify({
          profit_rate: 31.5,
          online_status: "selling",
          stock: 1,
          shipping_mode: "FBS",
        }),
        "2026-07-29T01:00:00.000Z",
        "forged",
      ), /constraint|strict publication requires/i);

      const cutoverAt = database.prepare(`
        SELECT value FROM metadata WHERE key = 'supply_gate_cutover_at'
      `).get().value;
      const postCutoverAt = new Date(Date.parse(cutoverAt) + 1_000).toISOString();
      const insertForgedStrict = database.prepare(`
        INSERT INTO events (
          event_key, sku, stage, reason, failure_class, terminal, strict,
          next_eligible_at, data_json, occurred_at, source
        ) VALUES (?, ?, 'published', 'forged-strict', NULL, 1, 1, NULL, ?, ?, 'forged')
      `);
      const missingSupply = { ...strictData };
      delete missingSupply.supply_gate_passed;
      delete missingSupply.supply_evidence;
      assert.throws(
        () => insertForgedStrict.run(
          "post-cutover-missing-supply",
          "post-cutover-missing-supply",
          JSON.stringify(missingSupply),
          postCutoverAt,
        ),
        /SupplyEvidenceV1/iu,
      );
      assert.throws(
        () => insertForgedStrict.run(
          "post-cutover-forged-supply",
          "post-cutover-forged-supply",
          JSON.stringify({
            ...strictData,
            supply_evidence: { ...strictData.supply_evidence, platform: "pinduoduo" },
          }),
          postCutoverAt,
        ),
        /SupplyEvidenceV1/iu,
      );

      const eventId = database
        .prepare("SELECT id FROM events WHERE sku = 'event-owner'")
        .get()
        .id;
      assert.throws(() => database.prepare(`
        INSERT INTO strict_publications (sku, event_id, published_at, data_json)
        VALUES (?, ?, ?, ?)
      `).run(
        "different-owner",
        eventId,
        "2026-07-29T01:00:00.000Z",
        JSON.stringify(strictData),
      ), /constraint|strict publication event|SupplyEvidenceV1/i);
    } finally {
      database.close();
    }
  });
});

test("legacy JSONL and published CSV import is read-only and idempotent", async () => {
  await withTempDir(async (dir) => {
    const legacy = path.join(dir, "legacy");
    await fs.mkdir(legacy);
    const skuStates = path.join(legacy, "sku_states.jsonl");
    const published = path.join(legacy, "published.jsonl");
    const failed = path.join(legacy, "failed.jsonl");
    const skipped = path.join(legacy, "skipped.jsonl");
    const publishedCsv = path.join(legacy, "published_links.csv");
    const legacyStrictData = { ...strictData };
    delete legacyStrictData.supply_gate_passed;
    delete legacyStrictData.supply_evidence;

    await fs.writeFile(skuStates, [
      JSON.stringify({ sku: "pending", status: "processing", data: { reason: "legacy-submitted", submitted: true } }),
      JSON.stringify({ sku: "temporary", status: "failed", data: { reason: "temporary-timeout", retry_at: "2026-07-30T01:00:00.000Z" } }),
      "malformed trailing line",
    ].join("\n"));
    await fs.writeFile(published, `${JSON.stringify({
      sku: "strict-history",
      status: "published",
      data: { reason: "legacy-strict", ...legacyStrictData },
      timestamp: "2026-07-28T01:00:00.000Z",
    })}\n`);
    await fs.writeFile(failed, `${JSON.stringify({
      sku: "terminal-failure",
      status: "failed",
      data: { reason: "prohibited-category", failure_class: "deterministic" },
    })}\n`);
    await fs.writeFile(skipped, `${JSON.stringify({
      sku: "policy-skip",
      status: "skipped",
      data: { reason: "duplicate-title" },
    })}\n`);
    await fs.writeFile(publishedCsv, [
      "product_link,created_at",
      "https://www.ozon.ru/product/csv-history,2026-07-28",
      "not-a-product,ignored",
    ].join("\n"));

    const legacyFiles = [skuStates, published, failed, skipped, publishedCsv];
    const before = await Promise.all(legacyFiles.map((filename) => fs.readFile(filename, "utf8")));
    const state = createRuntimeState({ dbPath: path.join(dir, "state", "runtime.sqlite") });
    const options = {
      skuStates: [skuStates],
      published: [published],
      failed: [failed],
      skipped: [skipped],
      publishedCsv: [publishedCsv],
    };

    const first = await state.importLegacy(options);
    const eventCount = state.auditEvents().length;
    const second = await state.importLegacy(options);
    assert.ok(first.importedEvents > 0);
    assert.equal(second.importedEvents, 0);
    assert.equal(state.auditEvents().length, eventCount);
    assert.equal(state.get("pending").reason, "legacy-submitted");
    assert.equal(state.get("temporary").failureClass, "transient");
    assert.equal(state.get("terminal-failure").terminal, true);
    assert.equal(state.get("policy-skip").terminal, true);
    assert.equal(state.get("strict-history").strict, true);
    assert.equal(state.get("csv-history").strict, false);
    assert.equal(state.get("csv-history").terminal, true);
    assert.equal(state.strictCount(), 1);
    assert.throws(() => state.recordStrictPublication("csv-history", {
      reason: "strict-evidence-reconciled",
      data: strictData,
    }), /trusted submitted reservation/iu);
    assert.equal(state.get("csv-history").strict, false);
    assert.equal(state.strictCount(), 1);
    assert.deepEqual(
      await Promise.all(legacyFiles.map((filename) => fs.readFile(filename, "utf8"))),
      before,
    );
    state.close();
  });
});

test("legacy import resolves latest state by event time and terminalizes a third daily transient failure", async () => {
  await withTempDir(async (dir) => {
    const history = path.join(dir, "sku_states.jsonl");
    await fs.writeFile(history, [
      JSON.stringify({
        sku: "out-of-order",
        status: "processing",
        timestamp: "2026-07-29T02:00:00.000Z",
        data: { reason: "newest-stage" },
      }),
      JSON.stringify({
        sku: "out-of-order",
        status: "processing",
        timestamp: "2026-07-29T01:00:00.000Z",
        data: { reason: "older-stage" },
      }),
      ...[1, 2, 3].map((attempt) => JSON.stringify({
        sku: "legacy-retry-cap",
        status: "failed",
        timestamp: `2026-07-29T01:0${attempt}:00.000Z`,
        data: {
          reason: `transient-${attempt}`,
          failure_class: "transient",
          retry_at: `2026-07-29T01:1${attempt}:00.000Z`,
        },
      })),
    ].join("\n"));

    const state = createRuntimeState({ dbPath: path.join(dir, "runtime.sqlite") });
    const options = { skuStates: [history] };
    assert.ok((await state.importLegacy(options)).importedEvents > 0);
    assert.equal(state.get("out-of-order").reason, "newest-stage");
    assert.match(state.get("legacy-retry-cap").reason, /legacy-transient-daily-limit-exceeded/);
    assert.equal(state.get("legacy-retry-cap").failureClass, "invariant");
    assert.equal(state.get("legacy-retry-cap").terminal, true);
    assert.equal(
      state.auditEvents().filter((event) => event.sku === "legacy-retry-cap").length,
      3,
    );
    assert.equal((await state.importLegacy(options)).importedEvents, 0);
    state.close();
  });
});

test("legacy transient failures mirrored across JSONL files consume one retry attempt", async () => {
  await withTempDir(async (dir) => {
    const skuStates = path.join(dir, "sku_states.jsonl");
    const failed = path.join(dir, "failed.jsonl");
    const mirrored = JSON.stringify({
      sku: "mirrored-transient",
      status: "failed",
      timestamp: "2026-07-29T01:01:00.000Z",
      data: {
        reason: "import-transient-error",
        failure_class: "transient",
        retry_at: "2026-07-29T01:10:00.000Z",
      },
    });
    await fs.writeFile(skuStates, `${mirrored}\n`);
    await fs.writeFile(failed, `${mirrored}\n`);

    const state = createRuntimeState({ dbPath: path.join(dir, "runtime.sqlite") });
    assert.equal((await state.importLegacy({
      skuStates: [skuStates],
      failed: [failed],
    })).importedEvents, 1);
    assert.equal(
      state.auditEvents().filter((event) => event.sku === "mirrored-transient").length,
      1,
    );
    assert.equal(
      state.canAttempt("mirrored-transient", { at: "2026-07-29T01:11:00.000Z" }).attempts,
      1,
    );
    assert.equal((await state.importLegacy({
      skuStates: [skuStates],
      failed: [failed],
    })).importedEvents, 0);
    state.close();
  });
});

test("SQLite remains authoritative while audit events can be re-exported as JSONL", async () => {
  await withTempDir(async (dir) => {
    const state = createRuntimeState({ dbPath: path.join(dir, "state.sqlite") });
    state.recordSubmission("audit", {
      reason: "erp-import-requested",
      data: { offer_id: "mz-audit" },
    });
    state.recordFailure("audit", {
      reason: "import-transient-error",
      kind: "transient",
      nextEligibleAt: "2026-07-29T02:00:00.000Z",
    });

    const auditPath = path.join(dir, "audit", "sku_events.jsonl");
    const exported = await state.exportAuditJsonl(auditPath);
    assert.equal(exported, 2);
    const rows = (await fs.readFile(auditPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.map((row) => row.reason), ["erp-import-requested", "import-transient-error"]);

    await fs.writeFile(auditPath, `${JSON.stringify({ sku: "forged", stage: "published" })}\n`);
    assert.equal(state.get("forged"), null);
    assert.equal(await state.exportAuditJsonl(auditPath), 2);
    assert.equal(state.get("audit").reason, "import-transient-error");
    state.close();
  });
});

test("strict publication rows expose authoritative data for compatibility audit repair", async () => {
  await withTempDir(async (dir) => {
    const state = createRuntimeState({
      dbPath: path.join(dir, "state.sqlite"),
      now: () => new Date("2026-07-29T01:00:00.000Z"),
    });
    const strictQueryData = {
      ...strictDataAt("2026-07-29T01:00:00.000Z"),
      runtime_run_dir: path.join(dir, "run"),
      published_at: "2026-07-29T01:02:03.000Z",
    };
    persistTrustedSupplySubmission(state, "strict-query", strictQueryData);
    state.recordStrictPublication("strict-query", {
      reason: "strict-confirmed",
      data: strictQueryData,
    });

    assert.deepEqual(state.strictPublications(), [{
      sku: "strict-query",
      eventId: 3,
      publishedAt: "2026-07-29T01:00:00.000Z",
      data: { ...strictQueryData, supply_target_variant_canonical: {} },
    }]);
    state.close();
  });
});

test("operational state entries compact ordinary terminal evidence without weakening runtime semantics", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "state.sqlite");
    const state = createRuntimeState({ dbPath });
    const terminalPayload = "x".repeat(32 * 1024);
    for (let index = 0; index < 128; index += 1) {
      state.recordSkip(`terminal-skip-${index}`, {
        reason: "historical-policy-rejection",
        data: { terminal_payload: terminalPayload },
      });
    }
    state.recordFailure("terminal-failure", {
      reason: "historical-invariant-failure",
      kind: "invariant",
      data: { terminal_payload: terminalPayload },
    });
    state.reserveSubmission("terminal-submitted", {
      reason: "submission-intent",
      data: {
        runtime_run_dir: path.join(dir, "submitted-run"),
        store_id: 106637,
        submitted_at: "2026-08-12T04:00:00.000Z",
      },
    });
    state.confirmSubmission("terminal-submitted", {
      reason: "erp-submission-accepted",
      data: { submitted: true },
    });
    state.recordFailure("terminal-submitted", {
      reason: "daily-product-limit",
      kind: "deterministic",
      data: {
        runtime_run_dir: path.join(dir, "submitted-run"),
        store_id: 106637,
        submitted: true,
        submitted_at: "2026-08-12T04:00:00.000Z",
        terminal_payload: terminalPayload,
      },
    });
    state.recordFailure("legacy-terminal-submitted", {
      reason: "historical-submission-failure",
      kind: "deterministic",
      data: {
        runtime_run_dir: path.join(dir, "legacy-submitted-run"),
        store_id: 106637,
        submitted: true,
        submitted_at: "2026-08-12T04:01:00.000Z",
        terminal_payload: terminalPayload,
      },
    });
    state.recordSkip("terminal-selected-only", {
      reason: "historical-selection-skip",
      data: {
        store_id: 106637,
        selected_at: "2026-08-12T04:02:00.000Z",
        terminal_payload: terminalPayload,
      },
    });
    state.recordProcessing("previous-run-reconciliation", {
      reason: "reconciliation-import-pending",
      data: {
        runtime_run_dir: path.join(dir, "previous-run"),
        submitted: true,
        submission_pending: true,
      },
    });
    state.recordProcessing("legacy-reconciliation", {
      reason: "reconciliation-import-pending",
      data: {
        submitted: true,
        submission_pending: true,
      },
    });
    state.recordFailure("transient-retry", {
      reason: "1688-health-deferred",
      kind: "transient",
      nextEligibleAt: "2026-08-12T05:00:00.000Z",
      data: { runtime_run_dir: path.join(dir, "previous-run") },
    });
    const legacyPublished = path.join(dir, "legacy-published.jsonl");
    await fs.writeFile(legacyPublished, `${JSON.stringify({
      sku: "legacy-published",
      status: "published",
      timestamp: "2026-08-12T04:00:00.000Z",
      data: { runtime_run_dir: path.join(dir, "legacy-published-run") },
    })}\n`);
    await state.importLegacy({ published: [legacyPublished] });
    const publishedHistoryData = {
      ...strictDataAt(new Date()),
      runtime_run_dir: path.join(dir, "published-run"),
    };
    persistTrustedSupplySubmission(state, "published-history", publishedHistoryData);
    state.recordStrictPublication("published-history", {
      reason: "strict-confirmed",
      data: publishedHistoryData,
    });

    const operationalEntries = state.operationalStateEntries();
    assert.equal(operationalEntries.length, 137);
    const operationalBySku = new Map(operationalEntries.map((entry) => [entry.sku, entry]));
    assert.deepEqual(operationalBySku.get("terminal-skip-127").data, {});
    assert.deepEqual(operationalBySku.get("terminal-failure").data, {});
    assert.equal(operationalBySku.get("previous-run-reconciliation").data.submission_pending, true);
    assert.equal(operationalBySku.get("legacy-reconciliation").data.submission_pending, true);
    assert.equal(operationalBySku.get("legacy-published").data.runtime_run_dir, path.join(dir, "legacy-published-run"));
    assert.equal(operationalBySku.get("published-history").data.runtime_run_dir, path.join(dir, "published-run"));
    assert.equal(operationalBySku.get("terminal-submitted").data.submitted, true);
    assert.equal(operationalBySku.get("terminal-submitted").data.store_id, 106637);
    assert.equal(state.submissionReservation("terminal-submitted").status, "closed");
    assert.equal(state.submissionReservation("legacy-terminal-submitted"), null);
    assert.equal(operationalBySku.get("legacy-terminal-submitted").data.submitted, true);
    assert.equal(operationalBySku.get("legacy-terminal-submitted").data.store_id, 106637);
    assert.equal(operationalBySku.get("legacy-terminal-submitted").data.terminal_payload, undefined);
    assert.equal(state.submissionReservation("terminal-selected-only"), null);
    assert.equal(operationalBySku.get("terminal-selected-only").data.selected_at, "2026-08-12T04:02:00.000Z");
    assert.equal(operationalBySku.get("terminal-selected-only").data.terminal_payload, undefined);
    const allEntries = state.stateEntries();
    assert.equal(allEntries.length, 137);
    assert.equal(allEntries.find((entry) => entry.sku === "terminal-skip-127").data.terminal_payload, terminalPayload);
    assert.equal(allEntries.find((entry) => entry.sku === "terminal-failure").data.terminal_payload, terminalPayload);
    state.recordSkip("projection-membership-transition", {
      reason: "historical-policy-rejection",
      data: { projection_marker: "terminal-omitted" },
    });
    assert.deepEqual(
      state.operationalStateEntries().find((entry) => entry.sku === "projection-membership-transition").data,
      {},
    );
    assert.equal(state.reopenDirectCandidate("projection-membership-transition").reopened, true);
    assert.equal(
      state.operationalStateEntries().find((entry) => entry.sku === "projection-membership-transition").data.projection_marker,
      "terminal-omitted",
    );
    state.recordSkip("projection-membership-transition", {
      reason: "historical-policy-rejection",
      data: { projection_marker: "terminal-omitted-again" },
    });
    assert.deepEqual(
      state.operationalStateEntries().find((entry) => entry.sku === "projection-membership-transition").data,
      {},
    );
    state.recordProcessing("projection-update-delete", {
      reason: "projection-test",
      data: { projection_version: 1 },
    });
    state.recordProcessing("projection-update-delete", {
      reason: "projection-test",
      data: { projection_version: 2 },
    });
    assert.equal(
      state.operationalStateEntries().find((entry) => entry.sku === "projection-update-delete").data.projection_version,
      2,
    );
    state.close();

    const database = new DatabaseSync(dbPath);
    try {
      const metadataPlan = database.prepare(`
        EXPLAIN QUERY PLAN
        SELECT
          sku, stage, reason, failure_class, terminal, strict, next_eligible_at,
          '{}' AS data_json,
          updated_at
        FROM sku_state INDEXED BY sku_state_operational_metadata
        ORDER BY sku
      `).all().map((row) => String(row.detail)).join("\n");
      assert.match(
        metadataPlan,
        /SCAN sku_state USING COVERING INDEX sku_state_operational_metadata/u,
      );

      const payloadPlan = database.prepare(`
        EXPLAIN QUERY PLAN
        SELECT sku, data_json
        FROM sku_state_operational_payloads
        ORDER BY sku
      `).all().map((row) => String(row.detail)).join("\n");
      assert.match(
        payloadPlan,
        /SCAN sku_state_operational_payloads/u,
      );
      assert.doesNotMatch(
        payloadPlan,
        /SEARCH sku_state/u,
      );
      assert.equal(
        JSON.parse(database.prepare(`
          SELECT data_json
          FROM sku_state_operational_payloads
          WHERE sku = 'projection-update-delete'
        `).get().data_json).projection_version,
        2,
      );
      const compactTerminalPayload = database.prepare(`
        SELECT data_json, length(data_json) AS bytes
        FROM sku_state_operational_payloads
        WHERE sku = 'legacy-terminal-submitted'
      `).get();
      assert.deepEqual(JSON.parse(compactTerminalPayload.data_json), {
        runtime_run_dir: path.join(dir, "legacy-submitted-run"),
        store_id: 106637,
        submitted: true,
        submitted_at: "2026-08-12T04:01:00.000Z",
      });
      assert.ok(Number(compactTerminalPayload.bytes) < 512);
      assert.equal(database.prepare(`
        SELECT value
        FROM metadata
        WHERE key = 'operational_payload_format_version'
      `).get().value, "2");
      database.prepare("DELETE FROM sku_state WHERE sku = ?").run("projection-update-delete");
      assert.equal(database.prepare(`
        SELECT 1 AS present
        FROM sku_state_operational_payloads
        WHERE sku = 'projection-update-delete'
      `).get(), undefined);

      database.exec(`
        DROP TRIGGER sku_state_operational_payload_insert;
        DROP TRIGGER sku_state_operational_payload_update;
        DROP TRIGGER sku_state_operational_payload_delete;
        DROP TABLE sku_state_operational_payloads;
      `);
    } finally {
      database.close();
    }

    const reopened = createRuntimeState({ dbPath });
    try {
      const reopenedEntries = reopened.operationalStateEntries();
      const reopenedBySku = new Map(reopenedEntries.map((entry) => [entry.sku, entry]));
      assert.deepEqual(reopenedBySku.get("terminal-skip-127").data, {});
      assert.equal(reopenedBySku.get("previous-run-reconciliation").data.submission_pending, true);
      assert.equal(reopenedBySku.get("legacy-terminal-submitted").data.submitted, true);
      assert.equal(reopenedBySku.get("terminal-selected-only").data.selected_at, "2026-08-12T04:02:00.000Z");
      assert.equal(reopenedBySku.get("legacy-published").data.runtime_run_dir, path.join(dir, "legacy-published-run"));
      assert.equal(reopenedBySku.get("published-history").data.runtime_run_dir, path.join(dir, "published-run"));
      assert.deepEqual(reopenedBySku.get("projection-membership-transition").data, {});
      assert.equal(reopenedBySku.has("projection-update-delete"), false);

      const concurrentlyReopened = createRuntimeState({ dbPath });
      try {
        assert.deepEqual(
          concurrentlyReopened.operationalStateEntries(),
          reopenedEntries,
        );
      } finally {
        concurrentlyReopened.close();
      }
    } finally {
      reopened.close();
    }
  });
});

test("existing full operational payloads rebuild once and install compact maintenance triggers", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "state.sqlite");
    const terminalPayload = "z".repeat(64 * 1024);
    const initial = createRuntimeState({ dbPath });
    initial.recordFailure("legacy-full-payload", {
      reason: "daily-product-limit",
      kind: "deterministic",
      data: {
        runtime_run_dir: path.join(dir, "run"),
        store_id: 106637,
        store_name: "store-two",
        submitted: true,
        submission_pending: true,
        submission_intent: true,
        selected_at: "2026-08-12T04:00:00.000Z",
        prepared_at: "2026-08-12T04:00:01.000Z",
        submitted_at: "2026-08-12T04:00:02.000Z",
        api_call_started_at: "2026-08-12T04:00:01.500Z",
        api_call_completed_at: "2026-08-12T04:00:02.500Z",
        store_rejection_day: "2026-08-12",
        original_reason: "daily-product-limit",
        import_log: { shop_name: "store-two", oversized: terminalPayload },
        terminal_payload: terminalPayload,
      },
    });
    initial.close();

    const legacy = new DatabaseSync(dbPath);
    try {
      legacy.exec(`
        UPDATE sku_state_operational_payloads
        SET data_json = (
          SELECT sku_state.data_json
          FROM sku_state
          WHERE sku_state.sku = sku_state_operational_payloads.sku
        );
        DELETE FROM metadata WHERE key = 'operational_payload_format_version';
        DROP TRIGGER sku_state_operational_payload_insert;
        CREATE TRIGGER sku_state_operational_payload_insert
        AFTER INSERT ON sku_state
        FOR EACH ROW
        BEGIN
          INSERT INTO sku_state_operational_payloads (sku, stage, data_json)
          VALUES (NEW.sku, NEW.stage, NEW.data_json);
        END;
      `);
      assert.ok(Number(legacy.prepare(`
        SELECT length(data_json) AS bytes
        FROM sku_state_operational_payloads
        WHERE sku = 'legacy-full-payload'
      `).get().bytes) > 64 * 1024);
    } finally {
      legacy.close();
    }

    const migrated = createRuntimeState({ dbPath });
    const restored = migrated.operationalStateEntries()
      .find((entry) => entry.sku === "legacy-full-payload");
    assert.deepEqual(restored.data, {
      runtime_run_dir: path.join(dir, "run"),
      store_id: 106637,
      store_name: "store-two",
      submitted: true,
      submission_pending: true,
      submission_intent: true,
      selected_at: "2026-08-12T04:00:00.000Z",
      prepared_at: "2026-08-12T04:00:01.000Z",
      submitted_at: "2026-08-12T04:00:02.000Z",
      api_call_started_at: "2026-08-12T04:00:01.500Z",
      api_call_completed_at: "2026-08-12T04:00:02.500Z",
      store_rejection_day: "2026-08-12",
      original_reason: "daily-product-limit",
      import_log: { shop_name: "store-two" },
    });
    assert.equal(migrated.get("legacy-full-payload").data.terminal_payload, terminalPayload);

    migrated.recordFailure("post-migration-trigger", {
      reason: "daily-product-limit",
      kind: "deterministic",
      data: {
        runtime_run_dir: path.join(dir, "run"),
        store_id: 106637,
        submitted: true,
        terminal_payload: terminalPayload,
      },
    });
    assert.deepEqual(
      migrated.operationalStateEntries().find((entry) => entry.sku === "post-migration-trigger").data,
      {
        runtime_run_dir: path.join(dir, "run"),
        store_id: 106637,
        submitted: true,
      },
    );
    migrated.close();

    const verified = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(verified.prepare(`
        SELECT value
        FROM metadata
        WHERE key = 'operational_payload_format_version'
      `).get().value, "2");
      const triggerSql = String(verified.prepare(`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'trigger' AND name = 'sku_state_operational_payload_insert'
      `).get().sql);
      assert.match(triggerSql, /json_patch/u);
    } finally {
      verified.close();
    }
  });
});
