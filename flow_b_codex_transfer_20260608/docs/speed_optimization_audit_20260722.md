# Speed optimization audit — 2026-07-22

## Scope and rollback

- Exact validated business baseline: `776b91bf156e0697694a2f28649535454779ae54`.
- Current operational rollback baseline: `662138282028c1f47240d76606fa37c2b9a734ae` on `codex/ozon-speed-baseline-20260722`.
- Frozen audit commit: `87b7d8e6c5` on `codex/ozon-speed-audit-20260722`.
- No historical run, successful-SKU record, duplicate state, browser profile, cache, or untracked runtime artifact is in cleanup scope.
- Pre-cleanup size: 31 production files / 11,431 lines; 27 test files / 9,886 lines.

The real v75 entry chain is:

`launch.sh` -> acceptance preflight -> browser owner/CDP monitor -> status/checkpoint/export monitors -> `run_acceptance_supervised.sh` -> `flow_b_playwright.mjs accept` -> producer `scanSources` plus persistent consumer `createPublishRunner` -> strict ERP/Ozon reconciliation.

## Keep list

The following code is either reached by the real supervisor, covered by tests, used by a declared command, or owns safety/recovery state.

- Runtime owner and orchestration: `run_acceptance_supervised.sh`, `flow_b_playwright.mjs`, `flow_b_acceptance_preflight.mjs`, `flow_b_checkpoint.mjs`, `flow_b_status_snapshot.mjs`, and `export_confirmed_store_skus.mjs`.
- Browser/auth/recovery: `browser-context.mjs`, `maozi-client.mjs`, `continuous-runtime.mjs`, and `low-token-intervention.mjs`.
- Candidate acquisition: `source-scanner.mjs`, `candidate-queue.mjs`, `ozon-detail.mjs`, `publish-policy.mjs`, `category-commission.mjs`, and their persisted candidate/source/pacing histories.
- Cost pipeline: `cost-bridge.mjs`, `json-line-worker-pool.mjs`, `flow_b_1688_sync.py`, `flow_b_1688_worker.py`, and `1688_image_median.py`. The production v75 environment explicitly selects `flow_b_1688_sync.py`, which delegates to the existing median implementation; the persistent pool invokes the worker.
- Publish safety and final truth: `publish-runner.mjs` and `publish-state.mjs`, including profit `>30`, title/SKU dedupe, store rotation/quota, submitted-state reconciliation, stock activation, final `selling` confirmation, and append-only state compatibility.
- Declared operational tools: `transfer_prepared_run.mjs` plus `prepared-transfer.mjs` (`npm run flow:b:transfer`), `flow_b_discover_sellers.mjs` plus `seller-discovery.mjs`, `flow_b_prewarm_1688.mjs`, `backfill_fbs_source_history.mjs`, both SKU export scripts, and `verification.mjs`. They are not all in v75's hot path, but have command/test/maintenance responsibilities and therefore do not qualify for deletion.
- All current tests and frozen configs; they define or protect the accepted behavior.

## Candidate deletion list

Only one item currently satisfies all four deletion gates (no runtime reference, no test dependency, no config entry, and no persisted-state compatibility role):

- `DEFAULT_RUN_DIR` in `flow_b_playwright.mjs`: the symbol occurs only at its declaration. `parseCli` has its own active default resolution and no code reads this constant.

Cleanup group 1 impact is one declaration line, with no behavior/config/state effect. Rollback is `git revert` of the cleanup commit or restoration from `87b7d8e6c5`. The related CLI tests and then the full suite must pass before retaining it.

The 286 repeated exception records for one SKU are not merely redundant logging: they reveal repeated execution. They must be fixed by classifying the deterministic no-logistics outcome as a terminal skip, not by deleting failure evidence.

## Uncertain / do not delete

- `flow_b_scan_high_yield_sources.py`: absent from v75's hot path and without a direct test, but it is a historical source-pool operations entrypoint. No safe proof exists that external procedures no longer invoke it.
- `flow_b_discover_sellers.mjs`, `flow_b_prewarm_1688.mjs`, `transfer_prepared_run.mjs`, and `backfill_fbs_source_history.mjs`: auxiliary rather than hot-path, but each has tests and/or a declared command or state-migration role.
- `export_selected_store_skus.mjs`: v75 uses the stricter confirmed exporter, but the selected exporter is tested and may be needed for diagnosis; selected data is never final truth.
- Legacy cache-collapse handling in `cost-bridge.mjs`, CSV/JSONL fallback readers in `publish-state.mjs`, and seed-file readers in `source-scanner.mjs`: these are persisted-state compatibility layers. Their age is not deletion evidence.
- Pool-memory configuration and historical run specifications: not hot-path executable code, but they are operational/source evidence and are excluded from cleanup.

No whole production file currently passes the user's deletion gates.

## v75 measured funnel and timing

Observed run: `/Users/mac/.ozon-24h-acceptance-v70/flow_b_codex_transfer_20260608/runs/flow_b/20260722_135200_ozon24h_stability_v75`, from `2026-07-22T05:56:30.484Z` to the user stop at `2026-07-22T07:23:46.284Z` (5,236 seconds).

- Final strict result: 8 unique `selling` SKUs with stock `>0`, 5.50/hour, duplicate 0, minimum profit rate 32.04%.
- Candidate discovery: 578 unique SKUs, approximately 412.26/hour over the discovery span.
- Ozon candidate-detail collection: 498 unique attempted; 28 unique favorited. This is 5.62% conversion and only 19.25 favorited candidates/hour over the observed window.
- Candidate-detail failures: 430 soft-block events affecting 293 unique SKUs; no recorded detail timeout. Other collection rejection events were predominantly non-pure-FBS 213, prohibited category 29, and missing shipping mode 9.
- Ozon detail/category after collection: 28 unique SKUs, event P50 178 ms, P95 212 ms, 0 timed-stage failures.
- 1688 cost: 28 unique SKUs, event P50 0 ms (cache), P95 2,257 ms, max 4,022 ms, 0 timed-stage failures/timeouts. Final outcomes included 10 terminal no-reliable-match skips and 3 deferred health failures.
- Profit calculation: 17 unique successful exact calculations out of 18 unique entrants; 5 profit-rate `<=30` terminal skips. One deterministic no-logistics SKU generated 286 failed upper-bound calls and 286 failed exact calls because it was retried each consumer round.
- ERP submission: 12 unique selected/submitted; `maozi_publish_and_confirm` P50 488 ms, P95 739 ms, no submission-call failure in the timing stream.
- ERP/Ozon final confirmation: 8 of 12 selected reached strict truth; selected-to-final P50 285,127 ms, P95 504,493 ms. Online sync failed 31 of 49 calls (63.27%), all because ERP required a three-minute interval while the run requested urgent sync every minute.
- Runtime incidents: 401=0, 403=0, page crash=0, browser disconnect=0, worker timeout=0, runtime-error rows=0, automatic browser restarts after initial start=0.
- Outcome failure events: 291 total but only 6 unique SKUs; 286 events are the one repeated no-logistics exception, 3 are 1688 health deferrals, and 2 are final online-product rejections.

## Baseline comparison and unique largest bottleneck

The validated v61 window produced 25 submissions and 17 strict confirmations in 30 minutes (50 selected/hour and 34 strict/hour). Its timing P50/P95 values were: Ozon detail 172/359 ms, 1688 2,764/4,844 ms, profit 190/247 ms, and publish call 410/702 ms. v75's post-collection Ozon, 1688, profit, and submit calls were not slower; most were faster.

Therefore the unique largest bottleneck is **candidate-detail collection availability/conversion under Ozon soft blocking**, not 1688, profit arithmetic, or the ERP submit request. It reduced the fresh publishable supply to 19.25/hour before later filtering, below the required 30/hour even at impossible 100% downstream conversion. The browser/network problem reported during v75 is consistent with the 293 unique soft-blocked candidates. This must be remeasured now that the browser page is reported healthy before changing scan pacing.

The first safe code cleanup is the unused constant. The first correctness/performance repair is separately scoped to one variable: make the deterministic ERP “no suitable logistics method” exception a terminal, logged `missing-shipping-mode` skip so one bad SKU cannot be executed and logged hundreds of times. Neither change alters the profit threshold, final confirmation, quotas, rotation, duplicate state, or recovery rules.

## Executed cleanup and optimization round 1

- Cleanup group 1 removed only the unused `DEFAULT_RUN_DIR` declaration. Related CLI tests passed 8/8 and the `--help` no-browser short path completed successfully.
- Optimization variable: deterministic ERP missing-logistics exception handling only.
- Baseline: one unique SKU generated 286 failed optimistic calls, 286 failed exact calls, and 286 duplicate exception events during v75.
- Hypothesis/target: record and remove that SKU as `missing-shipping-mode` once; a second consumer round must make zero further profit or 1688 calls for it.
- Regression-before-code: the new focused test failed with four profit calls across two rounds instead of the expected two.
- Result after the minimal change: focused test 1/1, publish-runner tests 86/86, full Node tests 423/423, Python tests 8/8, and `git diff --check` passed.
- Static post-change size is 31 production files / 11,442 lines and 27 test files / 9,924 lines. The actual cleanup is one deleted production line; the net increase comes from the narrowly scoped deterministic-error classifier and its regression test, not a new compatibility layer.

The real effect on final-confirmation speed is not inferred from unit tests. It must be measured in a fresh 5–10 minute sample against v75, while also checking whether the now-recovered browser restores candidate-detail conversion.
