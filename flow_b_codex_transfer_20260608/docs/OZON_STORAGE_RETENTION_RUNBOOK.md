# Ozon Production Storage Retention Runbook

This policy treats recovery, POST de-duplication, and acceptance evidence as more important than reclaiming space. The maintenance command is dry-run by default. It never prunes the live database and it refuses paths outside the production state root.

## Retention contract

| Data | Authority | Online action | Retention |
| --- | --- | --- | --- |
| `runtime/flow_b_state.sqlite`, `-wal`, `-shm` | Authoritative state, submission reservations, event-key de-duplication | Never archive, delete, copy as a backup, or VACUUM while the worker is running | Indefinite |
| `events`, `sku_state`, `submission_reservations`, `strict_publications`, `strict_title_claims` | POST safety and acceptance evidence | No row pruning is implemented | Indefinite until the offline migration below is proven |
| `runtime/flow_b_state.sqlite.schema-v*.backup.sqlite` | Static migration rollback copies | May be gzip-archived only when `lsof` proves the file is closed; verify the restored-stream SHA-256 before removing the source | Keep the verified compressed archive and manifest; never delete the last restorable full backup |
| `backups/*/flow_b_state.sqlite` | Incident recovery copy | Same archive contract as migration backups | Keep at least one validated incident snapshot in addition to migration archives |
| `runs/*/runtime_state_audit.jsonl` | Rebuildable compatibility export; SQLite remains authoritative | Archive/remove only after the official safe stop, zero supervisor/worker owners, and explicit `--safe-stop-confirmed` | Keep the verified archive while the corresponding SQLite history exists |
| `selected.jsonl`, `erp_accepted.jsonl`, `sku_states.jsonl`, reports and manifests | Business/audit evidence | Never selected by temporary cleanup | Indefinite |
| allowlisted `*.tmp*` atomic-write remnants | Non-authoritative | May be deleted after 24 hours only when `lsof` proves closed and the device/inode/size/mtime fingerprint is unchanged at deletion | 24 hours |
| `archives/storage/manifest.json` and archive payloads | Recovery catalog | Never remove automatically | Indefinite; copy off-volume before any future expiry policy |

The archive sequence is: validate allowlist and age; prove the source is not open; stream gzip to a unique partial file; fsync; decompress and compare the restored SHA-256 with the source SHA-256; prove the source fingerprint did not change; atomically rename; fsync the directory; atomically persist the manifest; then, and only with `--remove-source`, recheck closure and fingerprint before unlinking the source. Restore refuses to overwrite an existing file.

## Alert and automatic temporary cleanup

`ozon_24h_production.sh status` now includes `storage` with free bytes, used percentage, severity, and threshold reasons. Production defaults are:

- warning: less than 10 GiB available or at least 95% used;
- critical: less than 5 GiB available or at least 98% used;
- health scan: every 5 minutes in direct mode;
- cleanup attempt while storage is warning: at most every 6 hours; critical storage retries at most every 5 minutes;
- only closed, allowlisted temporary files at least 24 hours old are eligible.

The supervisor writes the compact current snapshot to `storage_status.json` and records severity transitions in `storage_alerts.jsonl`. Cleanup is non-fatal: failure is reported but never broadens the deletion allowlist or stops the worker.

Read-only inspection:

```sh
node scripts/ozon-storage-maintenance.mjs status \
  --state-root /Users/mac/.ozon-24h-production/state

node scripts/ozon-storage-maintenance.mjs database-plan \
  --state-root /Users/mac/.ozon-24h-production/state

node scripts/ozon-storage-maintenance.mjs cleanup-temporaries \
  --state-root /Users/mac/.ozon-24h-production/state \
  --run-dir /Users/mac/.ozon-24h-production/state/runs/RUN_ID \
  --minimum-age-hours 24
```

Add `--execute` only after reviewing the exact temporary-file plan.

## Static backup archive and restore

Dry-run one explicit allowlisted source first:

```sh
node scripts/ozon-storage-maintenance.mjs archive \
  --state-root /Users/mac/.ozon-24h-production/state \
  --source /Users/mac/.ozon-24h-production/state/runtime/flow_b_state.sqlite.schema-v3.backup.sqlite \
  --remove-source
```

The dry-run does not create an archive or remove anything. To perform the verified archive and reclaim the original bytes, repeat with `--execute`. Process only one large source at a time so the compressed staging file cannot exhaust the volume.

Restore is also dry-run by default:

```sh
node scripts/ozon-storage-maintenance.mjs restore \
  --state-root /Users/mac/.ozon-24h-production/state \
  --archive-id ARCHIVE_UUID
```

Review the target, then repeat with `--execute`. A restore target that already exists is a hard error.

The compatibility audit export additionally requires the official safe stop, `process_owners` supervisor/worker counts of `0/0`, `operational_status=STOPPED`, and `--safe-stop-confirmed`. Do not use a direct process kill to satisfy this gate.

## 2026-08-13 read-only inventory

At the audit time the Data volume had 6.64 GiB available and was 97.09% used. Production state was about 13 GiB:

- live SQLite: 3,121,704,960 bytes, `quick_check=ok`, zero foreign-key violations;
- `events`: 402,096 rows and about 2,756.6 MiB of the live database;
- two static runtime migration backups: 4,593,455,104 bytes total; both independently passed SQLite `quick_check` with zero foreign-key violations (user versions 3 and 4);
- stale rebuildable `runtime_state_audit.jsonl`: 2,108,273,683 bytes;
- closed allowlisted temporary remnants older than 24 hours: 378,087,506 bytes;
- one incident database backup: 1,114,533,888 bytes, retained as the separate incident snapshot.

A read-only gzip level-1 sizing pass reduced the two migration backups to 679,055,035 bytes total (14.8% of original), for 3,914,400,069 bytes of net reclaim while preserving restorable compressed copies. This is the first recovery action because it does not touch the live database, dedupe ledger, POST reservations, or acceptance artifacts.

The same read-only sizing pass reduced the stale compatibility audit export to 297,769,211 bytes (14.1% of original). After an official safe stop, archiving that export would reclaim another 1,810,504,472 bytes. Together with the verified stale-temporary plan, the measured safe reclaim potential is 6,102,992,047 bytes (about 5.68 GiB), without deleting a database row or business evidence file.

## Why database event pruning is disabled

The `events` table is not just a log:

- `event_key UNIQUE` is durable import/idempotence evidence;
- strict publication and title-claim rows have foreign keys to event IDs;
- acceptance-gate replay currently reads the complete event history;
- compatibility audit export is reconstructed from the complete table;
- runtime-native state detection depends on event provenance.

Deleting old rows now could admit duplicate imports, break foreign keys, or make a previously passed acceptance window unreplayable. `database_event_pruning_enabled` therefore remains `false`, and the maintenance command has no SQL delete or VACUUM operation.

Any future event compaction must be an offline schema migration, not a cleanup command:

1. Officially safe-stop; verify supervisor/worker owners `0/0`, no reserved submission, POST attempts at most one, and no active SQLite/WAL file descriptor.
2. Produce a SQLite-native backup with the backup API or `VACUUM INTO` while offline. Never use a raw copy of a live WAL database.
3. Add a permanent compact event-identity ledger that retains every `event_key`, plus exact acceptance projections partitioned by run/window. Preserve every event referenced by a foreign key, every nonterminal/current SKU event, and every submitted/accepted audit row.
4. Export candidate payload partitions to immutable compressed archives with row count, min/max event ID, min/max timestamp, source SHA-256, archive SHA-256, and restored-stream SHA-256.
5. Prove with tests that fresh-state hydration, duplicate import rejection, no-repeat POST, strict/title foreign keys, current and historical gate replay, JSONL re-export, and restore all produce byte- or event-equivalent results.
6. Run two restore drills from the archive plus compact database and compare `quick_check`, `foreign_key_check`, table counts, event identity counts, reservation projections, and acceptance results.
7. Only after those proofs, build a new database offline and atomically swap it while retaining the prior full database as a verified rollback archive. No in-place online VACUUM.
