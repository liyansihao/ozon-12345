# Runtime contract

Read this file before changing a live run, acceptance logic, store routing, or CSV reporting.

## Acceptance invariants

- Window: one uninterrupted 24-hour run.
- Target: 500 new unique strict publications, 100 per store.
- Throughput goal: sustained strict confirmation rate of at least 35/hour.
- A valid SKU must be newly confirmed in the current window, unique, `selling`, stock greater than zero, and `profit_rate > 30`.
- Exclude SKU `2815247918` from every count and export. Do not duplicate a previously published SKU.
- Selected, submitted, import-pending, unknown, stock-zero, terminal, and moderation-rejected rows are not strict confirmations.

## Store routing

Use this order and evidence only:

| Order | Store | ID | Verified warehouse ID |
|---:|---|---:|---:|
| 1 | 丽丽二号 | 106637 | 1020005023256510 |
| 2 | 丽丽三号 | 106640 | 1020005023295220 |
| 3 | 丽丽四号 | 106644 | 1020005023295540 |
| 4 | 丽丽五号 | 106646 | unavailable until uniquely returned by ERP |
| 5 | 丽丽1号 | 104965 | 1020005022957960 |

Use watermark ID `60822`, needle `lysh`, with non-exact name matching allowed. Rotate after a store reaches its configured daily/total cap. Temporarily skip unavailable store 5, keep authorized sync/reprobe every 300 seconds, and never guess its warehouse ID.

## Repository and tests

Project directory:

```text
flow_b_codex_transfer_20260608
```

Run full tests from the repository root:

```bash
npm run test:flow-b
python3 -m unittest discover -s flow_b_codex_transfer_20260608/tests -p 'test_*.py'
```

Run `git diff --check` and inspect the task-only diff before committing. Never use `git reset`, `git checkout --`, or destructive cleanup on user/runtime files.

## Active-run discovery and status

Find candidate live runs without reading every log:

```bash
find runs/flow_b -maxdepth 2 -name acceptance_window.json -print | sort | tail -n 5
ps -axo pid,ppid,etime,command | rg 'run_acceptance_supervised|flow_b_playwright'
```

Then inspect one run compactly:

```bash
node scripts/flow_b_status_snapshot.mjs RUN_DIR --compact
tail -n 40 RUN_DIR/runtime_errors.jsonl
tail -n 60 RUN_DIR/console.log
```

Use `launchctl print gui/$(id -u)/com.codex.ozon.v43` only when v43 is the actual configured service. Do not use a service name from an old handoff without verifying its plist/run directory.

## CSV commands

Selected exporter argument order is `OUTPUT_DIR RUN_DIR...`:

```bash
node scripts/export_selected_store_skus.mjs OUTPUT_DIR RUN_DIR
```

Confirmed exporter argument order is `RUN_ROOT OUTPUT_DIR`:

```bash
node scripts/export_confirmed_store_skus.mjs RUN_DIR OUTPUT_DIR
```

Use a single run directory for acceptance evidence. A historical `runs/flow_b` aggregate is useful for duplicate prevention, but it must not be reported as current-run acceptance.

## Runtime evidence files

- `acceptance_window.json`: fixed window boundaries.
- `status_snapshot.json`, `summary.json`: compact status and final summary.
- `published.jsonl`, `selected.jsonl`, `sku_states.jsonl`: publication truth and lifecycle.
- `favorite_collection.jsonl`, `candidate_queue.jsonl`: collection and durable queue.
- `stage_timings.jsonl`, `source_yield.jsonl`: bottleneck and full-funnel source evidence.
- `runtime_errors.jsonl`, `failed.jsonl`, `skipped.jsonl`: errors and eliminations.
- `store_daily_usage.jsonl`, `store_total_usage.jsonl`, `store_switches.jsonl`, `store_syncs.jsonl`: routing/quota truth.
- `published_store_<id>.csv`, `selected_store_<id>.csv`: per-store output inside a run.

## Safe reload criteria

Before replacing only the supervised child, verify:

- the persistent supervisor remains alive;
- no active submission lacks a durable state/reason;
- the current source/favorite batch has completed or can be safely replayed;
- no CAPTCHA/security interaction is in progress;
- the same run directory and acceptance window will be reused.

After reload, verify exactly one child/browser owner, unchanged window/state, expected environment, no new reasonless SKU, and no unexpected runtime-error growth.
