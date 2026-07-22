# Speed optimization rollback baseline — 2026-07-22

## Validated business baseline

- Commit: `776b91bf156e0697694a2f28649535454779ae54`
- Commit subject: `Freeze validated five-store acceptance baseline`
- Acceptance run: `runs/flow_b/20260721_122550_ozon30m_accept_v61`
- Durable evidence: `/Users/mac/.ozon-24h-acceptance-v70/flow_b_codex_transfer_20260608/runs/flow_b/20260721_122550_ozon30m_accept_v61`
- Window: `2026-07-21T04:27:27.515Z` through `2026-07-21T04:57:27.515Z` (1,800 continuous seconds)
- Result: PASS under the 30-minute target
- Strict ERP/Ozon confirmations: 17 unique SKUs (`selling`, stock `> 0`)
- Effective rate: 34/hour
- Minimum profit rate: 31.68% (`profit_rate > 30`)
- Duplicate SKUs: 0
- Store used by the successful window: `106646` (17 strict confirmations)
- Launch script SHA-256: `f95c03b7eb8e160a4d61b304047c97e907ed7cf3361eb167d467dc383155d832`
- Status snapshot SHA-256: `27cda68b956bf58f485d2b19fd81e096814518c980b5d39d5ee918bb35ac144b`
- Acceptance report SHA-256: `3663e53c21f514bd39da0111d7c405f455e617ced1104819978871580daaee1a`

The PASS configuration keeps the verified five-store order, watermark `60822` / `lysh`, initial stock `1`, publish concurrency `8..12`, strict final confirmation, and SKU `2815247918` exclusion. The exact tracked launch and source configuration remain in the v61 run directory.

## Current operational rollback baseline

- Commit: `662138282028c1f47240d76606fa37c2b9a734ae`
- Rollback branch: `codex/ozon-speed-baseline-20260722`
- Optimization branch: `codex/ozon-speed-audit-20260722`
- Purpose of post-PASS commits: checkpoint liveness, parameterized run paths, bounded Chromium cache, durable duplicate history, normal Chrome-for-Testing CDP attachment, and CDP extension recovery.
- Full tests rerun on this baseline: Node `422/422`, Python `8/8`, `git diff --check` PASS.
- Most recent real run: `/Users/mac/.ozon-24h-acceptance-v70/flow_b_codex_transfer_20260608/runs/flow_b/20260722_135200_ozon24h_stability_v75`
- v75 was stopped by user and is not a completed acceptance window. At stop it had 8 strict confirmations, 12 selected, 2 pending, 0 duplicates, and 0 runtime errors.

## Preserved runtime state

Do not delete or rewrite historical runs, exports, `data/flow_b/published_links.csv`, candidate/favorite state, source-yield history, 1688 cache, store usage/switch state, or browser profile state. Existing untracked runtime artifacts were present before cleanup work and are intentionally left untouched.

## Pre-cleanup size

- Production files under `scripts/`: 31
- Production lines under `scripts/`: 11,431
- Test files under `tests-js/` and `tests/`: 27
- Test lines: 9,886

Rollback is either `codex/ozon-speed-baseline-20260722` for the current operational baseline or commit `776b91bf156e0697694a2f28649535454779ae54` for the exact validated business baseline. Never reset over runtime evidence; use a separate worktree or branch comparison when rollback is needed.
