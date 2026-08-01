import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  RUNTIME_STATE_SCHEMA_VERSION,
  createRuntimeState,
  initializeSubmissionGate,
  releaseSubmissionGate,
} from "../scripts/flow_b_playwright/runtime-state.mjs";

async function withTempDir(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-runtime-state-"));
  try {
    return await callback(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

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
};

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

test("schema v1 and v2 databases migrate transactionally to v3 with a SQLite backup", async () => {
  await withTempDir(async (dir) => {
    for (const legacyVersion of [1, 2]) {
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
      assert.equal(migrated.schemaVersion(), 3);
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
        WHEN NEW.value = '3'
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
    assert.equal(retried.schemaVersion(), 3);
    assert.equal(retried.get("preserved-after-retry").data.preserved, true);
    retried.close();
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
        offer_id: "mz-leased",
        api_call_started_at: "2026-07-29T01:00:00.000Z",
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

    const unknown = main.reserveSubmission("unknown-at-boundary", {
      reason: "submission-api-call-started",
      data: {
        runtime_run_dir: runDir,
        direct_target_count: 1,
        api_call_started_at: "2026-07-31T01:00:00.000Z",
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

    assert.equal(ownerA.recordStrictPublication("title-a", {
      reason: "strict-confirmed",
      data: { ...strictData, title },
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

    assert.equal(strictOwner.reserveSubmission("strict-title-sku", {
      reason: "submission-intent",
      data: { title },
    }).recorded, true);
    assert.equal(strictOwner.recordStrictPublication("strict-title-sku", {
      reason: "strict-confirmed",
      data: { ...strictData, title },
    }).recorded, true);

    const directReservation = directOwner.reserveSubmission("direct-title-sku", {
      reason: "submission-intent",
      data: { title },
    });
    assert.equal(directReservation.recorded, true);
    assert.equal(directReservation.reservation.titleKey, null);
    assert.equal(directOwner.reserveSubmission("direct-title-sku", {
      reason: "same-sku-reentry",
      data: { title, api_call_started_at: "2026-07-31T04:00:00.000Z" },
    }).recorded, true);
    assert.equal(
      directOwner.submissionReservation("direct-title-sku").data.api_call_started_at,
      "2026-07-31T04:00:00.000Z",
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
        ...strictData,
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

    assert.equal(state.recordStrictPublication("strict", {
      reason: "strict-confirmed",
      data: strictData,
    }).recorded, true);
    assert.equal(state.recordStrictPublication("strict", {
      reason: "duplicate-confirmation",
      data: strictData,
    }).recorded, false);
    assert.equal(state.strictCount(), 1);
    assert.equal(state.get("strict").strict, true);
    assert.equal(state.recordFailure("strict", {
      reason: "must-not-regress",
      kind: "transient",
      nextEligibleAt: "2026-07-29T02:00:00.000Z",
    }).recorded, false);
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
      ), /constraint|strict publication event/i);
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

    await fs.writeFile(skuStates, [
      JSON.stringify({ sku: "pending", status: "processing", data: { reason: "legacy-submitted", submitted: true } }),
      JSON.stringify({ sku: "temporary", status: "failed", data: { reason: "temporary-timeout", retry_at: "2026-07-30T01:00:00.000Z" } }),
      "malformed trailing line",
    ].join("\n"));
    await fs.writeFile(published, `${JSON.stringify({
      sku: "strict-history",
      status: "published",
      data: { reason: "legacy-strict", ...strictData },
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
    assert.equal(state.recordStrictPublication("csv-history", {
      reason: "strict-evidence-reconciled",
      data: strictData,
    }).recorded, true);
    assert.equal(state.get("csv-history").strict, true);
    assert.equal(state.strictCount(), 2);
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
    state.recordStrictPublication("strict-query", {
      reason: "strict-confirmed",
      data: {
        ...strictData,
        runtime_run_dir: path.join(dir, "run"),
        published_at: "2026-07-29T01:02:03.000Z",
      },
    });

    assert.deepEqual(state.strictPublications(), [{
      sku: "strict-query",
      eventId: 1,
      publishedAt: "2026-07-29T01:00:00.000Z",
      data: {
        ...strictData,
        runtime_run_dir: path.join(dir, "run"),
        published_at: "2026-07-29T01:02:03.000Z",
      },
    }]);
    state.close();
  });
});
