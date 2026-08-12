#!/usr/bin/env node

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Writable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createGunzip, createGzip } from "node:zlib";

const execFileAsync = promisify(execFile);
const GIB = 1024 ** 3;
const DEFAULT_WARNING_FREE_BYTES = 10 * GIB;
const DEFAULT_CRITICAL_FREE_BYTES = 5 * GIB;
const DEFAULT_WARNING_USED_PERCENT = 95;
const DEFAULT_CRITICAL_USED_PERCENT = 98;
const DEFAULT_TEMPORARY_MINIMUM_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAINTENANCE_LOCK_STALE_MS = 10 * 60 * 1000;
const MANIFEST_VERSION = 1;

function finiteNumber(value, fallback) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
}

function isoTimestampForFilename(value) {
  return new Date(value).toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
}

function pathInside(root, filename) {
  const normalizedRoot = path.resolve(root);
  const normalized = path.resolve(filename);
  const relative = path.relative(normalizedRoot, normalized);
  if (relative === "" || relative === ".") return { absolute: normalized, relative: "." };
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path is outside the state root: ${normalized}`);
  }
  return { absolute: normalized, relative: relative.split(path.sep).join("/") };
}

async function fsyncFile(filename) {
  const handle = await fs.open(filename, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomic(filename, value) {
  const absolute = path.resolve(filename);
  const directory = path.dirname(absolute);
  const temporary = `${absolute}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  let handle = null;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, absolute);
    await fsyncDirectory(directory);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function appendJsonLine(filename, value) {
  const absolute = path.resolve(filename);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const handle = await fs.open(absolute, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function statFingerprint(stat) {
  return {
    device: Number(stat.dev),
    inode: Number(stat.ino),
    size_bytes: Number(stat.size),
    mtime_ms: Number(stat.mtimeMs),
    mode: Number(stat.mode & 0o777),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
  };
}

function sameFingerprint(left, right) {
  return ["device", "inode", "size_bytes", "mtime_ms"].every((key) => left[key] === right[key]);
}

async function regularFileFingerprint(filename) {
  const stat = await fs.lstat(filename);
  if (stat.isSymbolicLink()) throw new Error(`refusing symbolic link: ${filename}`);
  if (!stat.isFile()) throw new Error(`source is not a regular file: ${filename}`);
  return statFingerprint(stat);
}

function hashTap(hash) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

function hashSink(hash) {
  return new Writable({
    write(chunk, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  });
}

async function verifyGzipArchive(filename) {
  const compressedHash = crypto.createHash("sha256");
  const restoredHash = crypto.createHash("sha256");
  await pipeline(
    fsSync.createReadStream(filename),
    hashTap(compressedHash),
    createGunzip(),
    hashSink(restoredHash),
  );
  return {
    archive_sha256: compressedHash.digest("hex"),
    restored_sha256: restoredHash.digest("hex"),
  };
}

export function classifyStoragePath(stateRoot, filename) {
  const { absolute, relative } = pathInside(stateRoot, filename);
  if (/^runtime\/flow_b_state\.sqlite(?:-wal|-shm)?$/u.test(relative)) {
    return {
      absolute,
      relative,
      kind: "authoritative-runtime-state",
      authority: "authoritative",
      archivable: false,
      removable: false,
      reason: "runtime SQLite, WAL, and SHM are protected",
    };
  }
  if (/^runtime\/flow_b_state\.sqlite\.schema-v[^/]+\.backup\.sqlite$/u.test(relative)) {
    return {
      absolute,
      relative,
      kind: "runtime-migration-backup",
      authority: "restorable-backup",
      archivable: true,
      removable: true,
      requires_safe_stop: false,
    };
  }
  if (/^backups\/[^/]+\/flow_b_state\.sqlite$/u.test(relative)) {
    return {
      absolute,
      relative,
      kind: "incident-runtime-backup",
      authority: "restorable-backup",
      archivable: true,
      removable: true,
      requires_safe_stop: false,
    };
  }
  if (/^runs\/[^/]+\/runtime_state_audit\.jsonl$/u.test(relative)) {
    return {
      absolute,
      relative,
      kind: "rebuildable-runtime-audit-export",
      authority: "compatibility-export",
      archivable: true,
      removable: true,
      requires_safe_stop: true,
    };
  }
  return {
    absolute,
    relative,
    kind: "unclassified",
    authority: "unknown",
    archivable: false,
    removable: false,
    reason: "path is not on the conservative archive allowlist",
  };
}

export function databaseMaintenancePolicy() {
  return {
    event_pruning_enabled: false,
    online_vacuum_enabled: false,
    protected_tables: [
      "events",
      "sku_state",
      "submission_reservations",
      "strict_publications",
      "strict_title_claims",
    ],
    reasons: [
      "events-event-key-is-durable-idempotence-evidence",
      "strict-publication-and-title-claim-foreign-keys-reference-events",
      "acceptance-replay-loads-complete-event-history",
      "runtime-audit-export-is-reconstructed-from-events",
    ],
    offline_migration_prerequisites: [
      "official-safe-stop-and-zero-supervisor-worker-owners",
      "zero-reserved-submissions-and-post-attempts-at-most-one",
      "sqlite-native-full-backup-with-quick-check-and-foreign-key-check",
      "permanent-event-key-identity-ledger",
      "acceptance-window-projection-and-historical-replay-equivalence",
      "two-verified-restore-drills-before-atomic-database-swap",
    ],
  };
}

export async function diskHealthSnapshot({
  stateRoot,
  warningFreeBytes = DEFAULT_WARNING_FREE_BYTES,
  criticalFreeBytes = DEFAULT_CRITICAL_FREE_BYTES,
  warningUsedPercent = DEFAULT_WARNING_USED_PERCENT,
  criticalUsedPercent = DEFAULT_CRITICAL_USED_PERCENT,
  now = () => new Date(),
  statfs = fs.statfs,
} = {}) {
  if (!stateRoot) throw new TypeError("stateRoot is required");
  const stats = await statfs(path.resolve(stateRoot), { bigint: true });
  const blockSize = BigInt(stats.bsize);
  const totalBytes = BigInt(stats.blocks) * blockSize;
  const availableBytes = BigInt(stats.bavail) * blockSize;
  const freeBytes = BigInt(stats.bfree) * blockSize;
  const usedBytes = totalBytes - freeBytes;
  const usedPercent = Number(totalBytes > 0n ? (usedBytes * 10_000n) / totalBytes : 0n) / 100;
  const warningFree = Math.max(0, finiteNumber(warningFreeBytes, DEFAULT_WARNING_FREE_BYTES));
  const criticalFree = Math.max(0, finiteNumber(criticalFreeBytes, DEFAULT_CRITICAL_FREE_BYTES));
  const warningUsed = finiteNumber(warningUsedPercent, DEFAULT_WARNING_USED_PERCENT);
  const criticalUsed = finiteNumber(criticalUsedPercent, DEFAULT_CRITICAL_USED_PERCENT);
  const availableNumber = Number(availableBytes);
  let severity = "healthy";
  const reasons = [];
  if (availableNumber < criticalFree) reasons.push("free-bytes-below-critical");
  if (usedPercent >= criticalUsed) reasons.push("used-percent-at-critical");
  if (reasons.length > 0) {
    severity = "critical";
  } else {
    if (availableNumber < warningFree) reasons.push("free-bytes-below-warning");
    if (usedPercent >= warningUsed) reasons.push("used-percent-at-warning");
    if (reasons.length > 0) severity = "warning";
  }
  return {
    observed_at: now().toISOString(),
    state_root: path.resolve(stateRoot),
    severity,
    alert: severity !== "healthy",
    reasons,
    total_bytes: Number(totalBytes),
    used_bytes: Number(usedBytes),
    available_bytes: availableNumber,
    used_percent: usedPercent,
    thresholds: {
      warning_free_bytes: warningFree,
      critical_free_bytes: criticalFree,
      warning_used_percent: warningUsed,
      critical_used_percent: criticalUsed,
    },
  };
}

export async function fileOpenStatus(filename, { exec = execFileAsync } = {}) {
  const candidates = process.platform === "darwin"
    ? ["/usr/sbin/lsof", "/usr/bin/lsof"]
    : ["/usr/bin/lsof", "/usr/sbin/lsof"];
  for (const executable of candidates) {
    try {
      const { stdout = "" } = await exec(executable, ["-F", "p", "--", path.resolve(filename)], {
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      });
      return { verified: true, open: /^p\d+/mu.test(stdout), owners: stdout.match(/^p\d+/gmu) || [] };
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      // lsof exits 1 when no process has the file open.
      if (Number(error?.code) === 1) return { verified: true, open: false, owners: [] };
      return { verified: false, open: null, error: String(error?.message || error) };
    }
  }
  return { verified: false, open: null, error: "lsof is unavailable" };
}

export async function validateSqliteBackup(filename, { exec = execFileAsync } = {}) {
  const candidates = ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"];
  const sql = [
    "PRAGMA query_only = ON;",
    "PRAGMA quick_check;",
    "SELECT 'FK_COUNT', count(*) FROM pragma_foreign_key_check;",
    "SELECT 'USER_VERSION', user_version FROM pragma_user_version;",
  ].join(" ");
  for (const executable of candidates) {
    try {
      const { stdout = "" } = await exec(executable, ["-readonly", path.resolve(filename), sql], {
        timeout: 300_000,
        maxBuffer: 5 * 1024 * 1024,
      });
      const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
      const fkLine = lines.find((line) => line.startsWith("FK_COUNT|"));
      const versionLine = lines.find((line) => line.startsWith("USER_VERSION|"));
      const quickCheck = lines.filter((line) => !line.startsWith("FK_COUNT|") && !line.startsWith("USER_VERSION|"));
      const foreignKeyViolations = Number(fkLine?.split("|")[1]);
      if (quickCheck.length !== 1 || quickCheck[0] !== "ok" || foreignKeyViolations !== 0) {
        throw new Error(`SQLite validation failed: ${JSON.stringify({ quickCheck, foreignKeyViolations })}`);
      }
      return {
        quick_check: "ok",
        foreign_key_violations: 0,
        user_version: Number(versionLine?.split("|")[1] || 0),
        sqlite_executable: executable,
      };
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`SQLite backup validation failed for ${filename}: ${error?.message || error}`);
    }
  }
  throw new Error("SQLite backup validation requires the sqlite3 command");
}

async function productionSafeStopStatus(stateRoot) {
  const ownersPath = path.join(stateRoot, "process_owners.json");
  const operationalPath = path.join(stateRoot, "operational_status.json");
  let owners = {};
  let operational = {};
  try {
    owners = JSON.parse(await fs.readFile(ownersPath, "utf8"));
  } catch {}
  try {
    operational = JSON.parse(await fs.readFile(operationalPath, "utf8"));
  } catch {}
  const supervisor = Number(owners?.counts?.supervisor ?? (owners?.supervisor_pid ? 1 : 0));
  const worker = Number(owners?.counts?.worker ?? (owners?.worker_pid ? 1 : 0));
  return {
    safe: supervisor === 0 && worker === 0 && operational?.status === "STOPPED",
    supervisor,
    worker,
    operational_status: operational?.status || null,
  };
}

async function readManifest(manifestPath) {
  try {
    const value = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (Number(value?.manifest_version) !== MANIFEST_VERSION || !Array.isArray(value?.archives)) {
      throw new Error(`unsupported storage archive manifest: ${manifestPath}`);
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return { manifest_version: MANIFEST_VERSION, archives: [] };
    throw error;
  }
}

function processIsDefinitelyAbsent(pid, { kill = process.kill } = {}) {
  const normalized = Number(pid);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) return false;
  try {
    kill(normalized, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

async function readLockRecord(filename) {
  const [text, stat] = await Promise.all([
    fs.readFile(filename, "utf8"),
    fs.lstat(filename),
  ]);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`invalid maintenance lock record: ${filename}`);
  return { text, value: JSON.parse(text), fingerprint: statFingerprint(stat) };
}

function staleLockRecord(record, {
  nowMs,
  staleMs,
  hostname,
  kill,
  allowLegacyHost = false,
} = {}) {
  const acquiredAt = Date.parse(String(record?.value?.acquired_at || ""));
  if (!Number.isFinite(acquiredAt) || nowMs - acquiredAt < staleMs) return false;
  const recordedHost = String(record?.value?.hostname || "").trim();
  if (recordedHost && recordedHost !== hostname) return false;
  if (!recordedHost && !allowLegacyHost) return false;
  return processIsDefinitelyAbsent(record?.value?.pid, { kill });
}

async function createRecoveryClaim(claimPath, value) {
  const handle = await fs.open(claimPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function acquireRecoveryClaim(lock, {
  now,
  staleMs,
  hostname,
  kill,
} = {}) {
  const claimPath = path.join(lock, "recovery-claim.json");
  const token = crypto.randomUUID();
  const claim = {
    pid: process.pid,
    hostname,
    acquired_at: now().toISOString(),
    token,
  };
  try {
    await createRecoveryClaim(claimPath, claim);
    return { claimPath, token };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  let existing;
  try {
    existing = await readLockRecord(claimPath);
  } catch (error) {
    throw new Error(`storage maintenance recovery claim cannot be verified: ${error?.message || error}`);
  }
  if (!staleLockRecord(existing, {
    nowMs: now().getTime(),
    staleMs,
    hostname,
    kill,
  })) {
    throw new Error(`storage maintenance recovery is already claimed: ${claimPath}`);
  }

  const displaced = `${lock}.recovery-claim.${process.pid}.${crypto.randomUUID()}.stale`;
  await fs.rename(claimPath, displaced);
  const moved = await readLockRecord(displaced);
  if (!sameFingerprint(existing.fingerprint, moved.fingerprint) || existing.text !== moved.text) {
    await fs.rename(displaced, claimPath).catch(() => {});
    throw new Error(`storage maintenance recovery claim changed during takeover: ${claimPath}`);
  }
  try {
    await createRecoveryClaim(claimPath, claim);
  } catch (error) {
    await fs.unlink(displaced).catch(() => {});
    throw new Error(`storage maintenance recovery was claimed concurrently: ${error?.message || error}`);
  }
  await fs.unlink(displaced);
  return { claimPath, token };
}

async function assertRecoveryClaim({ claimPath, token }) {
  const current = await readLockRecord(claimPath);
  if (String(current?.value?.token || "") !== token) {
    throw new Error(`storage maintenance recovery claim ownership changed: ${claimPath}`);
  }
}

function fingerprintAgeMs(fingerprint, nowMs) {
  return Number(nowMs) - Number(fingerprint?.mtime_ms);
}

async function removeDisplacedLock(displaced, entries) {
  await Promise.all(entries.map((entry) => fs.unlink(path.join(displaced, entry))));
  await fs.rmdir(displaced);
}

async function initialStaleLockCandidate(lock, {
  nowMs,
  staleMs,
  hostname,
  kill,
} = {}) {
  const fingerprint = statFingerprint(await fs.lstat(lock));
  let owner = null;
  try {
    owner = await readLockRecord(path.join(lock, "owner.json"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (owner) {
    if (!staleLockRecord(owner, {
      nowMs,
      staleMs,
      hostname,
      kill,
      allowLegacyHost: true,
    })) return null;
  } else if (fingerprintAgeMs(fingerprint, nowMs) < staleMs) {
    return null;
  }
  return { fingerprint, owner };
}

export async function acquireMaintenanceLock(stateRoot, {
  now = () => new Date(),
  staleMs = DEFAULT_MAINTENANCE_LOCK_STALE_MS,
  hostname = os.hostname(),
  kill = process.kill,
} = {}) {
  const lock = path.join(stateRoot, "storage-maintenance.lock");
  const normalizedStaleMs = Math.max(60_000, Number(staleMs) || DEFAULT_MAINTENANCE_LOCK_STALE_MS);
  let createdLock = false;
  try {
    await fs.mkdir(lock, { mode: 0o700 });
    createdLock = true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      const candidate = await initialStaleLockCandidate(lock, {
        nowMs: now().getTime(),
        staleMs: normalizedStaleMs,
        hostname,
        kill,
      });
      if (!candidate) throw new Error(`storage maintenance is already locked: ${lock}`);
      const claim = await acquireRecoveryClaim(lock, {
        now,
        staleMs: normalizedStaleMs,
        hostname,
        kill,
      });
      try {
        const ownerPath = path.join(lock, "owner.json");
        const owner = candidate.owner;
        if (owner) {
          const ownerAgain = await readLockRecord(ownerPath);
          if (!sameFingerprint(owner.fingerprint, ownerAgain.fingerprint)
            || owner.text !== ownerAgain.text
            || !staleLockRecord(ownerAgain, {
              nowMs: now().getTime(),
              staleMs: normalizedStaleMs,
              hostname,
              kill,
              allowLegacyHost: true,
            })) {
            throw new Error(`storage maintenance lock owner changed during recovery: ${lock}`);
          }
        } else {
          const entriesBeforeClaim = (await fs.readdir(lock)).filter((entry) => entry !== "recovery-claim.json");
          if (entriesBeforeClaim.length !== 0) throw new Error(`storage maintenance empty lock changed during recovery: ${lock}`);
        }
        await assertRecoveryClaim(claim);
        const entries = (await fs.readdir(lock)).sort();
        const expectedEntries = owner ? ["owner.json", "recovery-claim.json"] : ["recovery-claim.json"];
        if (entries.length !== expectedEntries.length || entries.some((entry, index) => entry !== expectedEntries[index])) {
          throw new Error(`storage maintenance lock contains unexpected entries: ${lock}`);
        }
        const staleLock = `${lock}.${process.pid}.${crypto.randomUUID()}.stale`;
        await fs.rename(lock, staleLock);
        await removeDisplacedLock(staleLock, entries);
        try {
          await fs.mkdir(lock, { mode: 0o700 });
          createdLock = true;
        } catch (mkdirError) {
          if (mkdirError?.code === "EEXIST") {
            throw new Error(`storage maintenance lock was acquired concurrently: ${lock}`);
          }
          throw mkdirError;
        }
      } catch (recoveryError) {
        await fs.unlink(claim.claimPath).catch(() => {});
        throw recoveryError;
      }
    } else {
      throw error;
    }
  }
  try {
    await writeJsonAtomic(path.join(lock, "owner.json"), {
      pid: process.pid,
      hostname,
      acquired_at: now().toISOString(),
    });
  } catch (ownerWriteError) {
    if (createdLock) {
      const entries = await fs.readdir(lock).catch(() => []);
      if (entries.length === 0) await fs.rmdir(lock).catch(() => {});
    }
    throw ownerWriteError;
  }
  return async () => {
    await fs.unlink(path.join(lock, "owner.json")).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await fs.rmdir(lock);
  };
}

export async function archiveStaticFile({
  stateRoot,
  source,
  archiveRoot = path.join(stateRoot || "", "archives", "storage"),
  manifestPath = path.join(archiveRoot, "manifest.json"),
  execute = false,
  removeSource = false,
  safeStopConfirmed = false,
  minimumAgeMs = 60 * 60 * 1000,
  now = () => new Date(),
  openStatus = fileOpenStatus,
  sqliteValidation = validateSqliteBackup,
} = {}) {
  if (!stateRoot) throw new TypeError("stateRoot is required");
  if (!source) throw new TypeError("source is required");
  pathInside(stateRoot, archiveRoot);
  pathInside(stateRoot, manifestPath);
  const classification = classifyStoragePath(stateRoot, source);
  if (!classification.archivable) throw new Error(classification.reason);
  const before = await regularFileFingerprint(classification.absolute);
  const ageMs = now().getTime() - before.mtime_ms;
  if (ageMs < Math.max(0, Number(minimumAgeMs) || 0)) {
    throw new Error(`source is too recent to archive: ${classification.relative}`);
  }
  const open = await openStatus(classification.absolute);
  if (!open?.verified) throw new Error(`could not verify that source is closed: ${classification.relative}`);
  if (open.open) throw new Error(`source is open by a process: ${classification.relative}`);
  if (classification.requires_safe_stop) {
    if (!safeStopConfirmed) throw new Error("compatibility audit export requires --safe-stop-confirmed");
    const stopped = await productionSafeStopStatus(path.resolve(stateRoot));
    if (!stopped.safe) {
      throw new Error(`production is not safely stopped: ${JSON.stringify(stopped)}`);
    }
  }
  const sqliteValidationResult = classification.authority === "restorable-backup"
    ? await sqliteValidation(classification.absolute)
    : null;
  const plan = {
    action: "archive",
    execute: Boolean(execute),
    remove_source: Boolean(removeSource),
    classification,
    fingerprint: before,
    sqlite_validation: sqliteValidationResult,
    archive_root: path.resolve(archiveRoot),
    manifest_path: path.resolve(manifestPath),
  };
  if (!execute) return { ...plan, status: "planned" };

  const releaseLock = await acquireMaintenanceLock(path.resolve(stateRoot));
  let temporary = null;
  try {
    await fs.mkdir(path.resolve(archiveRoot), { recursive: true });
    temporary = path.join(
      path.resolve(archiveRoot),
      `.${path.basename(classification.absolute)}.${process.pid}.${crypto.randomUUID()}.partial`,
    );
    const sourceHash = crypto.createHash("sha256");
    await pipeline(
      fsSync.createReadStream(classification.absolute),
      hashTap(sourceHash),
      createGzip({ level: 6 }),
      fsSync.createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    await fsyncFile(temporary);
    const sourceSha256 = sourceHash.digest("hex");
    const verification = await verifyGzipArchive(temporary);
    if (verification.restored_sha256 !== sourceSha256) {
      throw new Error(`archive restore hash mismatch for ${classification.relative}`);
    }
    const after = await regularFileFingerprint(classification.absolute);
    if (!sameFingerprint(before, after)) {
      throw new Error(`source changed while it was archived: ${classification.relative}`);
    }
    const archiveStat = await fs.stat(temporary);
    const archiveId = crypto.randomUUID();
    const archiveName = [
      path.basename(classification.absolute),
      isoTimestampForFilename(now()),
      sourceSha256.slice(0, 16),
      `${archiveId}.gz`,
    ].join(".");
    const archivePath = path.join(path.resolve(archiveRoot), archiveName);
    try {
      await fs.lstat(archivePath);
      throw new Error(`archive destination already exists: ${archivePath}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.rename(temporary, archivePath);
    temporary = null;
    await fsyncDirectory(path.dirname(archivePath));
    const createdAt = now().toISOString();
    const record = {
      archive_id: archiveId,
      created_at: createdAt,
      kind: classification.kind,
      authority: classification.authority,
      source: {
        relative_path: classification.relative,
        size_bytes: before.size_bytes,
        mtime_ms: before.mtime_ms,
        mode: before.mode,
        uid: before.uid,
        gid: before.gid,
        sha256: sourceSha256,
      },
      archive: {
        relative_path: path.relative(path.resolve(stateRoot), archivePath).split(path.sep).join("/"),
        codec: "gzip",
        size_bytes: Number(archiveStat.size),
        sha256: verification.archive_sha256,
        restored_sha256: verification.restored_sha256,
      },
      verification: {
        status: "passed",
        verified_at: createdAt,
        source_unchanged_during_archive: true,
        sqlite: sqliteValidationResult,
      },
      source_removed_at: null,
      restore: {
        refuses_overwrite: true,
        command: `node scripts/ozon-storage-maintenance.mjs restore --state-root ${JSON.stringify(path.resolve(stateRoot))} --archive-id ${archiveId} --execute`,
      },
    };
    const manifest = await readManifest(manifestPath);
    manifest.updated_at = createdAt;
    manifest.archives.push(record);
    await writeJsonAtomic(manifestPath, manifest);

    if (removeSource) {
      if (!classification.removable) throw new Error(`source is protected from removal: ${classification.relative}`);
      if (classification.requires_safe_stop) {
        const stopped = await productionSafeStopStatus(path.resolve(stateRoot));
        if (!stopped.safe) {
          throw new Error(`production safe-stop state changed before removal: ${JSON.stringify(stopped)}`);
        }
      }
      const removalOpen = await openStatus(classification.absolute);
      if (!removalOpen?.verified || removalOpen.open) {
        throw new Error(`source could not be proven closed before removal: ${classification.relative}`);
      }
      const removalFingerprint = await regularFileFingerprint(classification.absolute);
      if (!sameFingerprint(before, removalFingerprint)) {
        throw new Error(`source changed before removal: ${classification.relative}`);
      }
      await fs.unlink(classification.absolute);
      await fsyncDirectory(path.dirname(classification.absolute));
      record.source_removed_at = now().toISOString();
      manifest.updated_at = record.source_removed_at;
      await writeJsonAtomic(manifestPath, manifest);
    }
    return {
      ...plan,
      status: "archived",
      archive_id: archiveId,
      archive_path: archivePath,
      source_sha256: sourceSha256,
      archive_sha256: verification.archive_sha256,
      original_size_bytes: before.size_bytes,
      archive_size_bytes: Number(archiveStat.size),
      reclaimed_bytes: removeSource ? Math.max(0, before.size_bytes - Number(archiveStat.size)) : 0,
      source_removed: Boolean(removeSource),
    };
  } finally {
    if (temporary) {
      await fs.unlink(temporary).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    await releaseLock();
  }
}

export async function restoreArchive({
  stateRoot,
  archiveId,
  manifestPath = path.join(stateRoot || "", "archives", "storage", "manifest.json"),
  execute = false,
  sqliteValidation = validateSqliteBackup,
} = {}) {
  if (!stateRoot) throw new TypeError("stateRoot is required");
  if (!archiveId) throw new TypeError("archiveId is required");
  pathInside(stateRoot, manifestPath);
  const manifest = await readManifest(path.resolve(manifestPath));
  const record = manifest.archives.find((entry) => entry?.archive_id === archiveId);
  if (!record) throw new Error(`archive ID is not present in the manifest: ${archiveId}`);
  const archive = pathInside(stateRoot, path.join(stateRoot, record.archive.relative_path)).absolute;
  const target = pathInside(stateRoot, path.join(stateRoot, record.source.relative_path)).absolute;
  const classification = classifyStoragePath(stateRoot, target);
  if (!classification.archivable || classification.kind !== record.kind) {
    throw new Error(`manifest restore target is not on the matching allowlist: ${record.source.relative_path}`);
  }
  const verification = await verifyGzipArchive(archive);
  if (
    verification.archive_sha256 !== record.archive.sha256
    || verification.restored_sha256 !== record.source.sha256
  ) {
    throw new Error(`archive verification failed: ${archiveId}`);
  }
  try {
    await fs.lstat(target);
    throw new Error(`restore target already exists: ${target}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const plan = { action: "restore", execute: Boolean(execute), archive_id: archiveId, archive, target };
  if (!execute) return { ...plan, status: "planned" };
  const releaseLock = await acquireMaintenanceLock(path.resolve(stateRoot));
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.restore.tmp`;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await pipeline(
      fsSync.createReadStream(archive),
      createGunzip(),
      fsSync.createWriteStream(temporary, { flags: "wx", mode: record.source.mode || 0o600 }),
    );
    await fsyncFile(temporary);
    const restored = await regularFileFingerprint(temporary);
    if (restored.size_bytes !== Number(record.source.size_bytes)) {
      throw new Error(`restored size mismatch: ${archiveId}`);
    }
    const restoredHash = crypto.createHash("sha256");
    await pipeline(fsSync.createReadStream(temporary), hashSink(restoredHash));
    if (restoredHash.digest("hex") !== record.source.sha256) {
      throw new Error(`restored hash mismatch: ${archiveId}`);
    }
    if (record.authority === "restorable-backup") {
      await sqliteValidation(temporary);
    }
    await fs.chmod(temporary, record.source.mode || 0o600);
    const mtime = new Date(Number(record.source.mtime_ms));
    await fs.utimes(temporary, mtime, mtime);
    try {
      await fs.link(temporary, target);
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`restore target already exists: ${target}`);
      throw error;
    }
    await fs.unlink(temporary);
    await fsyncDirectory(path.dirname(target));
    return { ...plan, status: "restored", restored_size_bytes: restored.size_bytes };
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await releaseLock();
  }
}

export function isConservativeTemporaryName(name) {
  const normalized = String(name || "");
  if (!normalized || normalized.endsWith(".sqlite") || /\.sqlite-(?:wal|shm)$/u.test(normalized)) return false;
  return (
    /\.tmp-\d+(?:-[0-9A-Za-z.-]+)?$/u.test(normalized)
    || /\.\d+\.(?:[0-9a-f]{8}-[0-9a-f-]{27,}|\d+)(?:\.[0-9a-f]+)?\.tmp$/iu.test(normalized)
    || /^(?:1688_cache|candidate_queue|source_yield|summary|current_store)[^/]*\.tmp$/u.test(normalized)
    || /^\.[^/]+\.\d+\.[0-9a-f-]+\.partial$/iu.test(normalized)
  );
}

async function walkRegularFiles(root) {
  const rows = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return rows;
    throw error;
  }
  for (const entry of entries) {
    const filename = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) rows.push(...await walkRegularFiles(filename));
    else if (entry.isFile()) rows.push(filename);
  }
  return rows;
}

export async function staleTemporaryPlan({
  stateRoot,
  runDir = null,
  minimumAgeMs = DEFAULT_TEMPORARY_MINIMUM_AGE_MS,
  now = () => new Date(),
  openStatus = fileOpenStatus,
} = {}) {
  if (!stateRoot) throw new TypeError("stateRoot is required");
  const roots = [path.join(path.resolve(stateRoot), "cache")];
  if (runDir) roots.push(pathInside(stateRoot, runDir).absolute);
  const candidates = [];
  const skipped = [];
  for (const root of roots) {
    for (const filename of await walkRegularFiles(root)) {
      if (!isConservativeTemporaryName(path.basename(filename))) continue;
      const fingerprint = await regularFileFingerprint(filename);
      const ageMs = now().getTime() - fingerprint.mtime_ms;
      if (ageMs < Math.max(0, Number(minimumAgeMs) || 0)) {
        skipped.push({ path: filename, reason: "too-recent", age_ms: ageMs });
        continue;
      }
      const open = await openStatus(filename);
      if (!open?.verified || open.open) {
        skipped.push({
          path: filename,
          reason: open?.open ? "open-by-process" : "open-state-unverified",
          age_ms: ageMs,
        });
        continue;
      }
      candidates.push({ path: filename, age_ms: ageMs, fingerprint });
    }
  }
  return {
    observed_at: now().toISOString(),
    minimum_age_ms: Math.max(0, Number(minimumAgeMs) || 0),
    roots,
    candidate_count: candidates.length,
    candidate_bytes: candidates.reduce((sum, row) => sum + row.fingerprint.size_bytes, 0),
    candidates,
    skipped,
  };
}

export async function cleanupStaleTemporaries({ execute = false, ...options } = {}) {
  const plan = await staleTemporaryPlan(options);
  if (!execute) return { ...plan, execute: false, removed: [] };
  const stateRoot = path.resolve(options.stateRoot);
  const releaseLock = await acquireMaintenanceLock(stateRoot);
  const removed = [];
  const skippedDuringExecution = [];
  try {
    for (const candidate of plan.candidates) {
      const open = await (options.openStatus || fileOpenStatus)(candidate.path);
      if (!open?.verified || open.open) {
        skippedDuringExecution.push({ path: candidate.path, reason: "open-state-changed" });
        continue;
      }
      let current;
      try {
        current = await regularFileFingerprint(candidate.path);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (!sameFingerprint(candidate.fingerprint, current)) {
        skippedDuringExecution.push({ path: candidate.path, reason: "fingerprint-changed" });
        continue;
      }
      await fs.unlink(candidate.path);
      removed.push({ path: candidate.path, size_bytes: current.size_bytes });
    }
    if (removed.length > 0) {
      await appendJsonLine(path.join(stateRoot, "storage_cleanup_history.jsonl"), {
        at: new Date().toISOString(),
        action: "removed-stale-temporaries",
        removed,
      });
    }
    return {
      ...plan,
      execute: true,
      removed,
      removed_bytes: removed.reduce((sum, row) => sum + row.size_bytes, 0),
      skipped_during_execution: skippedDuringExecution,
    };
  } finally {
    await releaseLock();
  }
}

function parseArguments(argv) {
  const [command = "status", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2).replaceAll("-", "_");
    if (["execute", "remove_source", "safe_stop_confirmed"].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  const stateRoot = path.resolve(options.state_root || process.env.OZON_PRODUCTION_STATE_ROOT || "");
  if (!options.state_root && !process.env.OZON_PRODUCTION_STATE_ROOT) {
    throw new Error("--state-root is required");
  }
  let result;
  if (command === "status") {
    result = await diskHealthSnapshot({
      stateRoot,
      warningFreeBytes: options.warning_free_gib === undefined
        ? DEFAULT_WARNING_FREE_BYTES
        : Number(options.warning_free_gib) * GIB,
      criticalFreeBytes: options.critical_free_gib === undefined
        ? DEFAULT_CRITICAL_FREE_BYTES
        : Number(options.critical_free_gib) * GIB,
    });
  } else if (command === "database-plan") {
    result = databaseMaintenancePolicy();
  } else if (command === "archive") {
    result = await archiveStaticFile({
      stateRoot,
      source: options.source,
      execute: options.execute === true,
      removeSource: options.remove_source === true,
      safeStopConfirmed: options.safe_stop_confirmed === true,
      minimumAgeMs: Number(options.minimum_age_hours ?? 1) * 60 * 60 * 1000,
    });
  } else if (command === "restore") {
    result = await restoreArchive({
      stateRoot,
      archiveId: options.archive_id,
      execute: options.execute === true,
    });
  } else if (command === "cleanup-temporaries") {
    result = await cleanupStaleTemporaries({
      stateRoot,
      runDir: options.run_dir || null,
      execute: options.execute === true,
      minimumAgeMs: Number(options.minimum_age_hours ?? 24) * 60 * 60 * 1000,
    });
  } else {
    throw new Error(`unsupported storage maintenance command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) {
  main().then(
    (code) => { process.exitCode = Number(code) || 0; },
    (error) => {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        code: "OZON_STORAGE_MAINTENANCE_ERROR",
        error: String(error?.message || error),
      })}\n`);
      process.exitCode = 1;
    },
  );
}

export {
  DEFAULT_CRITICAL_FREE_BYTES,
  DEFAULT_CRITICAL_USED_PERCENT,
  DEFAULT_MAINTENANCE_LOCK_STALE_MS,
  DEFAULT_TEMPORARY_MINIMUM_AGE_MS,
  DEFAULT_WARNING_FREE_BYTES,
  DEFAULT_WARNING_USED_PERCENT,
  MANIFEST_VERSION,
};
