#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_PATH="${FLOW_B_CONFIG:-$ROOT_DIR/config/flow_b.json}"
RUN_ID="$(date '+%Y%m%d_%H%M%S')"
RUN_DIR="$ROOT_DIR/runs/flow_b/$RUN_ID"
DATA_DIR="$ROOT_DIR/data/flow_b"
TMP_DIR="$ROOT_DIR/tmp/flow_b/$RUN_ID"

mkdir -p "$RUN_DIR" "$DATA_DIR" "$TMP_DIR"

PUBLISHED_LINKS="$DATA_DIR/published_links.csv"
CANDIDATE_RECORDS="$DATA_DIR/candidates.jsonl"
BLOCKED_RECORDS="$DATA_DIR/blocked.jsonl"

touch "$CANDIDATE_RECORDS" "$BLOCKED_RECORDS"
if [[ ! -f "$PUBLISHED_LINKS" ]]; then
  printf 'product_link\n' > "$PUBLISHED_LINKS"
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Flow B config not found: $CONFIG_PATH" >&2
  exit 1
fi

SHARED_1688_SCRIPT="${FLOW_B_1688_SCRIPT:-$ROOT_DIR/scripts/1688_image_median.py}"

{
  echo "Flow B run: $RUN_ID"
  echo "Root: $ROOT_DIR"
  echo "Config: $CONFIG_PATH"
  echo "Run dir: $RUN_DIR"
  echo "Published links: $PUBLISHED_LINKS"
  echo "Candidate records: $CANDIDATE_RECORDS"
  echo "Blocked records: $BLOCKED_RECORDS"
  echo "Shared 1688 script: $SHARED_1688_SCRIPT"
} | tee "$RUN_DIR/run_info.txt"

if [[ ! -f "$SHARED_1688_SCRIPT" ]]; then
  {
    echo
    echo "Shared 1688 script is not present yet."
    echo "Set FLOW_B_1688_SCRIPT to the existing 1688 cost script path, or copy the shared script to:"
    echo "  $ROOT_DIR/scripts/1688_image_median.py"
  } | tee -a "$RUN_DIR/run_info.txt"
fi

cat <<'EOF' | tee "$RUN_DIR/checklist.txt"
Flow B checklist

1. Open the target Ozon seller store page and scroll to bottom until no new products load.
2. Open MaoziERP favorites: 商品 -> 收藏夹.
3. Extract favorites rows and open each 商品标题 product link.
4. On each Ozon product detail page, open MaoziERP 计算利润.
5. Use selected sale price: min(current Ozon sale price, Maozi follow-sell lowest price).
6. Run shared 1688 image cost check and fill 采购成本.
7. Confirm CEL, click 开始计算, select Economy (陆运), and read final profit rate.
8. Publish only when final profit rate > 20%.
9. For listing, open 一键上架, set 显示所有SKU to 否, confirm store JM-001 and watermark 鹿呦呦.
10. Fill 我的售价 with the selected sale price and click 一键上架至OZON.
11. Save successful product links to data/flow_b/published_links.csv.
EOF

echo
echo "Flow B workspace is ready. Automation DOM helpers will be filled during live testing."
echo "Run artifacts are under: $RUN_DIR"
