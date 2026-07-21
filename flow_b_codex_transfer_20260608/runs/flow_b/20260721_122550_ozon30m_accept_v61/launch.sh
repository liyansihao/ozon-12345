#!/bin/zsh
set -u

source <(sed -n '1,65p' runs/flow_b/20260720_061500_ozon2h_erp_warehouse_discovery_v54/launch.sh)

RUN_DIR=runs/flow_b/20260721_122550_ozon30m_accept_v61
export FLOW_B_STORE_TARGETS='[{"id":106637,"needle":"丽丽二号","warehouseId":1020005023256510,"requireWarehouse":true},{"id":106640,"needle":"丽丽三号","warehouseId":1020005023295220,"requireWarehouse":true},{"id":106644,"needle":"丽丽四号","warehouseId":1020005023295540,"requireWarehouse":true},{"id":106646,"needle":"丽丽五号","warehouseId":null,"requireWarehouse":true},{"id":104965,"needle":"丽丽1号","warehouseId":1020005022957960,"requireWarehouse":true}]'
export FLOW_B_ACCEPTANCE_SECONDS=1800 FLOW_B_ACCEPTANCE_TARGET=15 FLOW_B_STORE_ACCEPTANCE_TARGET=100
export FLOW_B_STORE_TOTAL_USAGE_SEED='{"106637":100,"106640":100,"106644":100,"106646":72,"104965":10}'
export FLOW_B_STORE_DAILY_USAGE_SEED='{"date":"2026-07-21","usage":{"106637":0,"106640":0,"106644":0,"106646":0,"104965":0}}'
export FLOW_B_PYTHON=.venv-flowb/bin/python
export FLOW_B_1688_SCRIPT=scripts/flow_b_1688_sync.py
export FLOW_B_FRESH_SOURCE_FILES=runs/flow_b/20260721_v58_strict_supply_sources.txt
export FLOW_B_DERIVED_PRIORITY_SOURCES=24
export FLOW_B_URGENT_ONLINE_SYNC_INTERVAL_MS=60000

mkdir -p "$RUN_DIR"
scripts/run_acceptance_supervised.sh "$RUN_DIR" runs/flow_b/20260714_source_urls_union.txt \
  >> "$RUN_DIR/console.log" 2>> "$RUN_DIR/stderr.log"
run_status=$?
node scripts/flow_b_status_snapshot.mjs "$RUN_DIR" > "$RUN_DIR/status_snapshot.json" 2>/dev/null || true
exit $run_status
