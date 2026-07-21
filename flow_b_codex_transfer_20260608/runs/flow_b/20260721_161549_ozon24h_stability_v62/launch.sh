#!/bin/zsh
set -u

cd /Users/mac/.codex/worktrees/3b6c/ozon/flow_b_codex_transfer_20260608
export PATH=/Users/mac/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

RUN_DIR=runs/flow_b/20260721_161549_ozon24h_stability_v62
EXPORT_DIR=../exports/confirmed_store_skus_20260721_v62
export FLOW_B_FROZEN_COMMIT=776b91bf156e0697694a2f28649535454779ae54
export FLOW_B_EXTENSION_DIR=/Users/mac/Downloads/maozi-plugin-3.0.9/maozi-plugin-3.0.9
export FLOW_B_MAOZI_CONTINUE_LOGIN=1
export FLOW_B_WATERMARK_ID=60822 FLOW_B_WATERMARK_NEEDLE=lysh
export FLOW_B_STORE_TARGETS='[{"id":106637,"needle":"丽丽二号","warehouseId":1020005023256510,"requireWarehouse":true},{"id":106640,"needle":"丽丽三号","warehouseId":1020005023295220,"requireWarehouse":true},{"id":106644,"needle":"丽丽四号","warehouseId":1020005023295540,"requireWarehouse":true},{"id":106646,"needle":"丽丽五号","warehouseId":null,"requireWarehouse":true},{"id":104965,"needle":"丽丽1号","warehouseId":1020005022957960,"requireWarehouse":true}]'
export FLOW_B_INITIAL_STOCK=1 FLOW_B_PROFIT_THRESHOLD=30 FLOW_B_EXCLUDED_SKUS=2815247918
export FLOW_B_ACCEPTANCE_SECONDS=86400 FLOW_B_ACCEPTANCE_TARGET=500 FLOW_B_STORE_ACCEPTANCE_TARGET=100 FLOW_B_RESUME_WINDOW=1
export FLOW_B_TARGET_PUBLISH_COUNT=500 FLOW_B_DAILY_STORE_LIMIT=100 FLOW_B_STORE_TOTAL_LIMIT=100
export FLOW_B_STORE_TOTAL_USAGE_SEED='{}' FLOW_B_STORE_TOTAL_USAGE_SEED_INCLUDES_RESTORED=0
export FLOW_B_STORE_DAILY_USAGE_SEED='{"date":"2026-07-21","usage":{"106637":0,"106640":0,"106644":0,"106646":0,"104965":0}}'
export FLOW_B_LOG_LEVEL=summary FLOW_B_LOW_TOKEN_INTERVENTION=1

export FLOW_B_PUBLISH_WORKERS=8 FLOW_B_MAX_PUBLISH_WORKERS=12
export FLOW_B_TAB_WORKERS=3 FLOW_B_MAX_TAB_WORKERS=4 FLOW_B_FAVORITE_WORKERS=3
export FLOW_B_TARGET_FAVORITES=1000 FLOW_B_MAX_LINKS_PER_SOURCE=8 FLOW_B_MAX_RETAINED_LINKS=0
export FLOW_B_IMPORTED_FAVORITE_CLEANUP_LIMIT=100
export FLOW_B_CANDIDATE_QUEUE_DRAIN_LIMIT=48 FLOW_B_CANDIDATE_QUEUE_PER_SOURCE_DRAIN=6
export FLOW_B_CACHED_FBS_FALLBACK_LINKS=0 FLOW_B_COOLDOWN_FBS_FALLBACK_LINKS=24
export FLOW_B_MAX_SOURCE_PRICE_CNY=1000
export FLOW_B_POLL_INTERVAL_MS=3000 FLOW_B_PRODUCER_INTERVAL_MS=5000
export FLOW_B_SKIP_RETAINED=1 FLOW_B_LOW_DELTA_THRESHOLD=4 FLOW_B_LOW_DELTA_BATCH_LIMIT=2
export FLOW_B_MAX_SOURCE_BATCHES_PER_TRANCHE=8 FLOW_B_SOURCE_STABLE_WINDOW=6
export FLOW_B_SOURCE_CHECKPOINT_BATCH_INTERVAL=8
export FLOW_B_FAVORITE_DETAIL_INTERVAL_MS=4000 FLOW_B_FAVORITE_API_INTERVAL_MS=500
export FLOW_B_MAX_FAVORITE_DETAIL_INTERVAL_MS=6000 FLOW_B_FAVORITE_DETAIL_SOFT_BLOCK_STEP_MS=1000
export FLOW_B_FAVORITE_DETAIL_RETRIES=0 FLOW_B_FAVORITE_DETAIL_TIMEOUT=8000
export FLOW_B_VERIFY_LISTING_FBS_DETAIL=1 FLOW_B_SOURCE_NON_FBS_SAMPLE_LIMIT=4
export FLOW_B_FAVORITE_TELEMETRY_TIMEOUT_MS=10000 FLOW_B_FAVORITE_PAGE_CREATE_TIMEOUT_MS=10000
export FLOW_B_OZON_DETAIL_TIMEOUT_MS=12000 FLOW_B_1688_ITEM_TIMEOUT=60
export FLOW_B_1688_PERSISTENT_POOL=1 FLOW_B_1688_WORKERS=4
export FLOW_B_1688_HEALTH_FAILURE_THRESHOLD=5 FLOW_B_1688_HEALTH_DEFERRED_TTL_MS=120000
export FLOW_B_1688_HEALTH_PROBE_BACKOFF_MS=30000 FLOW_B_1688_HEALTH_SKU_RETRY_LIMIT=1
export FLOW_B_CONFIRMATION_ATTEMPTS=1 FLOW_B_CONFIRMATION_INTERVAL_MS=0
export FLOW_B_ONLINE_SYNC_INTERVAL_MS=1800000
export FLOW_B_URGENT_ONLINE_SYNC_INTERVAL_MS=60000 FLOW_B_URGENT_ONLINE_SYNC_PENDING_COUNT=3
export FLOW_B_DAILY_STORE_TIMEZONE=UTC
export FLOW_B_WAREHOUSE_SYNC_ATTEMPTS=2 FLOW_B_WAREHOUSE_SYNC_INTERVAL_MS=5000
export FLOW_B_UNAVAILABLE_STORE_RETRY_MS=300000 FLOW_B_PROBE_INACTIVE_STORES=1
export FLOW_B_PENDING_STORE_STALL_MS=300000 FLOW_B_PENDING_STORE_STALL_COUNT=3 FLOW_B_PENDING_STORE_RETRY_MS=300000

export FLOW_B_FBS_SOURCE_HISTORY=data/flow_b/fbs_source_history.jsonl
export FLOW_B_SOURCE_STRICT_WEIGHT=6 FLOW_B_SOURCE_FBS_WEIGHT=3 FLOW_B_SOURCE_EXPLORE_WEIGHT=1
export FLOW_B_PURE_FBS_SELLER_MIN_FAVORITES=2 FLOW_B_PURE_FBS_SELLERS=50
export FLOW_B_DERIVED_SEARCH_SOURCES=24 FLOW_B_DERIVED_PRIORITY_SOURCES=24
export FLOW_B_DERIVED_SEARCH_PRICE_BANDS='150.000;,500.000;' FLOW_B_DERIVED_SEARCH_PAGES='1,2,3'
export FLOW_B_PUBLISHED_SOURCE_PAGES='2,3' FLOW_B_VERIFIED_SELLER_MIN_PUBLISHED=2
export FLOW_B_PRIORITIZE_DERIVED_SEARCH=1
export FLOW_B_FRESH_SOURCE_FILES=runs/flow_b/20260721_v58_strict_supply_sources.txt
export FLOW_B_SOURCE_SCAN_TIMEOUT_MS=60000 FLOW_B_PAGE_CLOSE_TIMEOUT_MS=5000
export FLOW_B_MAX_SCROLL_STEPS=18 FLOW_B_MAX_NO_NEW_LINK_STEPS=12 FLOW_B_RESTART_DELAY_SECONDS=5
export FLOW_B_SOURCE_YIELD_SEED_FILES="$(find runs/flow_b -mindepth 2 -maxdepth 2 -name source_yield.jsonl -type f ! -path "$RUN_DIR/*" | sort | paste -sd: -)"
export FLOW_B_STATE_SEED_FILES=''
export FLOW_B_PENDING_STATE_SEED_FILES=''
export FLOW_B_CANDIDATE_FACT_SEED_FILES=runs/flow_b/20260720_041100_ozon2h_source_dwell_v53/favorite_collection.jsonl:runs/flow_b/20260720_020700_ozon2h_seller_bias_v52/favorite_collection.jsonl:runs/flow_b/20260720_000100_ozon2h_warehouse_failover_v51/favorite_collection.jsonl
export FLOW_B_PUBLISH_FEEDBACK_SEED_FILES=data/flow_b/source_yield_history.jsonl
export FLOW_B_FAVORITE_SEED_FILES="$(find runs/flow_b -mindepth 2 -maxdepth 2 -name favorite_collection.jsonl -type f ! -path "$RUN_DIR/*" | sort | paste -sd: -)"
export FLOW_B_1688_SHARED_CACHE=data/flow_b/1688_cache.json FLOW_B_1688_CACHE_SEED_FILES=''
export FLOW_B_PYTHON=.venv-flowb/bin/python
export FLOW_B_1688_SCRIPT=scripts/flow_b_1688_sync.py

mkdir -p "$RUN_DIR/checkpoints" "$EXPORT_DIR"

if [[ "$(git rev-parse HEAD)" != "$FLOW_B_FROZEN_COMMIT" ]]; then
  print -r -- "frozen commit mismatch" > "$RUN_DIR/preflight_error.txt"
  exit 78
fi
if ! git diff --quiet "$FLOW_B_FROZEN_COMMIT" -- scripts tests-js tests; then
  print -r -- "tracked runtime code differs from frozen commit" > "$RUN_DIR/preflight_error.txt"
  exit 78
fi

node --input-type=module -e '
  import fs from "node:fs";
  const frozen = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("FLOW_B_")));
  fs.writeFileSync(process.argv[1], `${JSON.stringify(frozen, null, 2)}\n`);
' "$RUN_DIR/frozen_environment.json"

{
  git rev-parse HEAD
  shasum -a 256 scripts/flow_b_playwright.mjs scripts/flow_b_playwright/*.mjs scripts/flow_b_1688_sync.py scripts/1688_image_median.py
  shasum -a 256 data/flow_b/published_links.csv runs/flow_b/20260721_v58_strict_supply_sources.txt
} > "$RUN_DIR/frozen_checksums.sha256"

node scripts/flow_b_acceptance_preflight.mjs > "$RUN_DIR/preflight.json" 2> "$RUN_DIR/preflight_error.json" || exit $?

launcher_pid=$$
node --input-type=module -e '
  import fs from "node:fs";
  fs.writeFileSync(process.argv[1], `${JSON.stringify({ launcher_pid: Number(process.argv[2]), started_at: new Date().toISOString() }, null, 2)}\n`);
' "$RUN_DIR/process_info.json" "$launcher_pid"

(
  while kill -0 "$launcher_pid" 2>/dev/null; do
    if [[ ! -f "$RUN_DIR/acceptance_window.json" ]]; then sleep 5; continue; fi
    node scripts/flow_b_status_snapshot.mjs "$RUN_DIR" > "$RUN_DIR/status_snapshot.json.tmp" 2>/dev/null \
      && mv "$RUN_DIR/status_snapshot.json.tmp" "$RUN_DIR/status_snapshot.json"
    node scripts/export_confirmed_store_skus.mjs "$RUN_DIR" "$EXPORT_DIR" >/dev/null 2>&1 || true
    sleep 300
  done
) &
status_monitor_pid=$!

(
  while kill -0 "$launcher_pid" 2>/dev/null && [[ ! -f "$RUN_DIR/acceptance_window.json" ]]; do sleep 5; done
  if [[ -f "$RUN_DIR/acceptance_window.json" ]]; then
    node scripts/flow_b_checkpoint.mjs "$RUN_DIR" 00_start >> "$RUN_DIR/checkpoint_monitor.log" 2>&1 || true
    checkpoint_number=1
    while [[ $checkpoint_number -le 12 ]] && kill -0 "$launcher_pid" 2>/dev/null; do
      due_ms=$(node --input-type=module -e '
        import fs from "node:fs";
        const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        process.stdout.write(String(Date.parse(value.started_at) + Number(process.argv[2]) * 7200000));
      ' "$RUN_DIR/acceptance_window.json" "$checkpoint_number")
      while kill -0 "$launcher_pid" 2>/dev/null; do
        now_ms=$(node -e 'process.stdout.write(String(Date.now()))')
        [[ "$now_ms" -ge "$due_ms" ]] && break
        sleep 60
      done
      kill -0 "$launcher_pid" 2>/dev/null || break
      label=$(printf '%02d_2h' "$checkpoint_number")
      node scripts/flow_b_checkpoint.mjs "$RUN_DIR" "$label" >> "$RUN_DIR/checkpoint_monitor.log" 2>&1 || true
      checkpoint_number=$((checkpoint_number + 1))
    done
  fi
) &
checkpoint_monitor_pid=$!

scripts/run_acceptance_supervised.sh "$RUN_DIR" runs/flow_b/20260714_source_urls_union.txt \
  >> "$RUN_DIR/console.log" 2>> "$RUN_DIR/stderr.log"
run_status=$?

kill "$status_monitor_pid" "$checkpoint_monitor_pid" 2>/dev/null || true
wait "$status_monitor_pid" 2>/dev/null || true
wait "$checkpoint_monitor_pid" 2>/dev/null || true
node scripts/flow_b_status_snapshot.mjs "$RUN_DIR" > "$RUN_DIR/status_snapshot.json" 2>/dev/null || true
node scripts/flow_b_checkpoint.mjs "$RUN_DIR" final >> "$RUN_DIR/checkpoint_monitor.log" 2>&1 || true
node scripts/export_confirmed_store_skus.mjs "$RUN_DIR" "$EXPORT_DIR" >> "$RUN_DIR/console.log" 2>&1 || true
exit $run_status
