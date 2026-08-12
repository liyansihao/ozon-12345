import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  archiveStaticFile,
  classifyStoragePath,
  cleanupStaleTemporaries,
  databaseMaintenancePolicy,
  diskHealthSnapshot,
  isConservativeTemporaryName,
  restoreArchive,
  staleTemporaryPlan,
  validateSqliteBackup,
} from "../scripts/ozon-storage-maintenance.mjs";

async function withTempState(fn) {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-storage-maintenance-"));
  try {
    await fn(stateRoot);
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
}

const closedFile = async () => ({ verified: true, open: false, owners: [] });
const validSqlite = async () => ({ quick_check: "ok", foreign_key_violations: 0, user_version: 3 });

test("storage classifier protects authority files and only allowlists restorable evidence", () => {
  const root = "/tmp/ozon-state";
  assert.deepEqual(
    classifyStoragePath(root, path.join(root, "runtime", "flow_b_state.sqlite")),
    {
      absolute: path.join(root, "runtime", "flow_b_state.sqlite"),
      relative: "runtime/flow_b_state.sqlite",
      kind: "authoritative-runtime-state",
      authority: "authoritative",
      archivable: false,
      removable: false,
      reason: "runtime SQLite, WAL, and SHM are protected",
    },
  );
  assert.equal(classifyStoragePath(
    root,
    path.join(root, "runtime", "flow_b_state.sqlite-wal"),
  ).archivable, false);
  const backup = classifyStoragePath(
    root,
    path.join(root, "runtime", "flow_b_state.sqlite.schema-v3.backup.sqlite"),
  );
  assert.equal(backup.kind, "runtime-migration-backup");
  assert.equal(backup.archivable, true);
  assert.equal(backup.requires_safe_stop, false);
  const audit = classifyStoragePath(
    root,
    path.join(root, "runs", "run-1", "runtime_state_audit.jsonl"),
  );
  assert.equal(audit.authority, "compatibility-export");
  assert.equal(audit.requires_safe_stop, true);
  assert.equal(classifyStoragePath(root, path.join(root, "runs", "run-1", "selected.jsonl")).archivable, false);
  assert.throws(
    () => classifyStoragePath(root, "/tmp/outside-state/file"),
    /outside the state root/u,
  );
});

test("database maintenance policy has no online prune or VACUUM escape hatch", () => {
  const policy = databaseMaintenancePolicy();
  assert.equal(policy.event_pruning_enabled, false);
  assert.equal(policy.online_vacuum_enabled, false);
  assert.ok(policy.protected_tables.includes("events"));
  assert.ok(policy.protected_tables.includes("submission_reservations"));
  assert.ok(policy.offline_migration_prerequisites.includes(
    "two-verified-restore-drills-before-atomic-database-swap",
  ));
});

test("SQLite backup validation requires quick_check and zero foreign-key violations", async () => {
  const valid = await validateSqliteBackup("/tmp/backup.sqlite", {
    exec: async () => ({ stdout: "ok\nFK_COUNT|0\nUSER_VERSION|3\n" }),
  });
  assert.equal(valid.quick_check, "ok");
  assert.equal(valid.foreign_key_violations, 0);
  assert.equal(valid.user_version, 3);
  await assert.rejects(
    validateSqliteBackup("/tmp/broken.sqlite", {
      exec: async () => ({ stdout: "database disk image is malformed\nFK_COUNT|2\nUSER_VERSION|3\n" }),
    }),
    /SQLite backup validation failed/u,
  );
});

test("disk health exposes warning and critical threshold reasons without mutating state", async () => {
  const warning = await diskHealthSnapshot({
    stateRoot: "/state",
    warningFreeBytes: 20,
    criticalFreeBytes: 5,
    warningUsedPercent: 80,
    criticalUsedPercent: 98,
    statfs: async () => ({ bsize: 1n, blocks: 100n, bfree: 15n, bavail: 15n }),
    now: () => new Date("2026-08-13T00:00:00.000Z"),
  });
  assert.equal(warning.severity, "warning");
  assert.equal(warning.alert, true);
  assert.deepEqual(warning.reasons.sort(), ["free-bytes-below-warning", "used-percent-at-warning"]);
  assert.equal(warning.used_percent, 85);

  const critical = await diskHealthSnapshot({
    stateRoot: "/state",
    warningFreeBytes: 20,
    criticalFreeBytes: 5,
    warningUsedPercent: 80,
    criticalUsedPercent: 98,
    statfs: async () => ({ bsize: 1n, blocks: 100n, bfree: 2n, bavail: 2n }),
  });
  assert.equal(critical.severity, "critical");
  assert.deepEqual(critical.reasons.sort(), ["free-bytes-below-critical", "used-percent-at-critical"]);
});

test("archive is gzip-verified and manifested before optional source removal, then restores losslessly", async () => {
  await withTempState(async (stateRoot) => {
    const source = path.join(stateRoot, "runtime", "flow_b_state.sqlite.schema-v3.backup.sqlite");
    await fs.mkdir(path.dirname(source), { recursive: true });
    const content = Buffer.concat([
      Buffer.from("SQLite format 3\0"),
      Buffer.alloc(256 * 1024, 65),
      Buffer.from("durable-backup-tail"),
    ]);
    await fs.writeFile(source, content);
    const old = new Date("2026-08-01T00:00:00.000Z");
    await fs.utimes(source, old, old);

    const planned = await archiveStaticFile({
      stateRoot,
      source,
      execute: false,
      removeSource: true,
      minimumAgeMs: 0,
      openStatus: closedFile,
      sqliteValidation: validSqlite,
    });
    assert.equal(planned.status, "planned");
    await assert.rejects(fs.access(path.join(stateRoot, "archives")), /ENOENT/u);

    const archived = await archiveStaticFile({
      stateRoot,
      source,
      execute: true,
      removeSource: true,
      minimumAgeMs: 0,
      openStatus: closedFile,
      sqliteValidation: validSqlite,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    });
    assert.equal(archived.status, "archived");
    assert.equal(archived.source_removed, true);
    assert.ok(archived.archive_size_bytes < archived.original_size_bytes);
    await assert.rejects(fs.access(source), /ENOENT/u);
    const manifest = JSON.parse(await fs.readFile(
      path.join(stateRoot, "archives", "storage", "manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.manifest_version, 1);
    assert.equal(manifest.archives.length, 1);
    assert.equal(manifest.archives[0].archive_id, archived.archive_id);
    assert.equal(manifest.archives[0].verification.status, "passed");
    assert.equal(manifest.archives[0].verification.sqlite.quick_check, "ok");
    assert.match(manifest.archives[0].source.sha256, /^[0-9a-f]{64}$/u);
    assert.match(manifest.archives[0].archive.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(manifest.archives[0].source_removed_at);

    const restorePlan = await restoreArchive({
      stateRoot,
      archiveId: archived.archive_id,
      sqliteValidation: validSqlite,
    });
    assert.equal(restorePlan.status, "planned");
    const restored = await restoreArchive({
      stateRoot,
      archiveId: archived.archive_id,
      execute: true,
      sqliteValidation: validSqlite,
    });
    assert.equal(restored.status, "restored");
    assert.deepEqual(await fs.readFile(source), content);
    await assert.rejects(
      restoreArchive({
        stateRoot,
        archiveId: archived.archive_id,
        execute: true,
        sqliteValidation: validSqlite,
      }),
      /restore target already exists/u,
    );
  });
});

test("compatibility audit export cannot be archived without a real safe stop", async () => {
  await withTempState(async (stateRoot) => {
    const source = path.join(stateRoot, "runs", "run-1", "runtime_state_audit.jsonl");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "{\"sku\":\"one\"}\n");
    const old = new Date("2026-08-01T00:00:00.000Z");
    await fs.utimes(source, old, old);
    await fs.writeFile(path.join(stateRoot, "process_owners.json"), JSON.stringify({
      supervisor_pid: 123,
      worker_pid: 456,
      counts: { supervisor: 1, worker: 1 },
    }));
    await fs.writeFile(path.join(stateRoot, "operational_status.json"), JSON.stringify({ status: "RUNNING" }));
    await assert.rejects(
      archiveStaticFile({
        stateRoot,
        source,
        minimumAgeMs: 0,
        openStatus: closedFile,
        now: () => new Date("2026-08-13T00:00:00.000Z"),
      }),
      /requires --safe-stop-confirmed/u,
    );
    await assert.rejects(
      archiveStaticFile({
        stateRoot,
        source,
        safeStopConfirmed: true,
        minimumAgeMs: 0,
        openStatus: closedFile,
        now: () => new Date("2026-08-13T00:00:00.000Z"),
      }),
      /production is not safely stopped/u,
    );
  });
});

test("temporary cleanup only removes old, closed, allowlisted files after a second fingerprint check", async () => {
  await withTempState(async (stateRoot) => {
    const cache = path.join(stateRoot, "cache");
    const runDir = path.join(stateRoot, "runs", "run-1");
    await fs.mkdir(cache, { recursive: true });
    await fs.mkdir(runDir, { recursive: true });
    const oldCache = path.join(cache, "1688_cache.json.93398.c86d8567-ab94-4049-b941-ee9b7860d3fe.tmp");
    const openTemp = path.join(runDir, "candidate_queue.json.44.12345678-1234-1234-1234-123456789abc.tmp");
    const recentTemp = path.join(runDir, "current_store.json.tmp-99");
    const protectedWal = path.join(runDir, "flow_b_state.sqlite-wal");
    const businessEvidence = path.join(runDir, "selected.jsonl");
    await Promise.all([
      fs.writeFile(oldCache, Buffer.alloc(4096, 1)),
      fs.writeFile(openTemp, Buffer.alloc(2048, 2)),
      fs.writeFile(recentTemp, Buffer.alloc(1024, 3)),
      fs.writeFile(protectedWal, Buffer.alloc(512, 4)),
      fs.writeFile(businessEvidence, Buffer.alloc(256, 5)),
    ]);
    const old = new Date("2026-08-01T00:00:00.000Z");
    await fs.utimes(oldCache, old, old);
    await fs.utimes(openTemp, old, old);
    const now = () => new Date("2026-08-13T00:00:00.000Z");
    const openStatus = async (filename) => ({ verified: true, open: filename === openTemp });

    const plan = await staleTemporaryPlan({
      stateRoot,
      runDir,
      minimumAgeMs: 24 * 60 * 60 * 1000,
      now,
      openStatus,
    });
    assert.deepEqual(plan.candidates.map((row) => row.path), [oldCache]);
    assert.equal(plan.candidate_bytes, 4096);
    assert.ok(plan.skipped.some((row) => row.path === openTemp && row.reason === "open-by-process"));
    assert.ok(plan.skipped.some((row) => row.path === recentTemp && row.reason === "too-recent"));

    const cleaned = await cleanupStaleTemporaries({
      stateRoot,
      runDir,
      minimumAgeMs: 24 * 60 * 60 * 1000,
      now,
      openStatus,
      execute: true,
    });
    assert.equal(cleaned.removed_bytes, 4096);
    assert.deepEqual(cleaned.removed.map((row) => row.path), [oldCache]);
    await assert.rejects(fs.access(oldCache), /ENOENT/u);
    await Promise.all([
      fs.access(openTemp),
      fs.access(recentTemp),
      fs.access(protectedWal),
      fs.access(businessEvidence),
    ]);
    assert.match(await fs.readFile(path.join(stateRoot, "storage_cleanup_history.jsonl"), "utf8"), /oldCache|1688_cache/u);
  });
});

test("temporary name allowlist rejects SQLite and business evidence", () => {
  assert.equal(isConservativeTemporaryName("1688_cache.json.42.12345678-1234-1234-1234-123456789abc.tmp"), true);
  assert.equal(isConservativeTemporaryName("current_store.json.tmp-42"), true);
  assert.equal(isConservativeTemporaryName("flow_b_state.sqlite"), false);
  assert.equal(isConservativeTemporaryName("flow_b_state.sqlite-wal"), false);
  assert.equal(isConservativeTemporaryName("selected.jsonl"), false);
});
