# Flow B Codex Transfer Pack

This pack contains the current Flow B scripts and records needed to continue Ozon/Maozi work on another computer.

## Current Rules

- Profit rate must be strictly greater than 30%.
- Use RMB/CNY prices.
- Skip food products.
- Skip human mannequin/body model products.
- Skip apparel/fashion and digital/3C products.
- Skip obvious branded/high-risk products, especially premium tool brands, before 1688 cost estimation.
- Skip FBO and mixed FBO,FBS products. Continue only with pure FBS.
- Favorites limit is 1000. If Maozi favorites approach 1000, process favorites before more scanning.
- Clear favorites only after every current favorite has been processed, published, skipped, or blocked.
- Do not bypass login, CAPTCHA, anti-bot, or security checks. Ask the user to log in if needed.

## Store Routes

Available route keys in `scripts/flow_b_process_batch.py`:

- `home`: JM-002家居类目 / LUU家具
- `pet`: JM-003宠物 / CUU宠物
- `baby`: JM-004母婴用品 / TLL母婴店
- `auto`: JM-001 / 鹿呦呦
- `unknown`: LILI / 粤泓
- `yh`: LL-百货YH / YH百货
- `yjm`: YJM / YJM

For a simple fixed sequence, set:

```bash
FLOW_B_ROUTE_SEQUENCE=baby:100,yh:100
```

Change this per the user's daily instruction.

For YJM-only publishing, set:

```bash
FLOW_B_ROUTE_SEQUENCE=yjm:100
```

## Typical Commands

Create a new run directory:

```bash
RUN_DIR="runs/flow_b/$(date '+%Y%m%d_%H%M%S_transfer')"
mkdir -p "$RUN_DIR"
cp runs/flow_b/20260608_urls/source_urls.txt "$RUN_DIR/source_urls.txt"
date -Iseconds > "$RUN_DIR/start_time.txt"
```

Scan Ozon source links:

```bash
FLOW_B_MAX_SCROLL_STEPS=1400 \
FLOW_B_MAX_NO_NEW_LINK_STEPS=70 \
FLOW_B_SCROLL_RATIO=0.9 \
FLOW_B_SCROLL_DELAY=0.8 \
python3 scripts/flow_b_rescan_sources_deep.py \
  "$RUN_DIR/source_urls.txt" \
  "$RUN_DIR/source_deep_scan.json"
```

Process Maozi favorites and publish qualified items:

```bash
FLOW_B_PROFIT_THRESHOLD=30 \
FLOW_B_ROUTE_SEQUENCE=baby:100,yh:100 \
python3 scripts/flow_b_process_batch.py "$RUN_DIR"
```

1688 search-page cost estimates use the image-search similarity order, filter invalid first-page candidates, and use the filtered first-page 70th percentile price.

## Chrome/Maozi Requirements

- Use the user's logged-in Google Chrome profile.
- Ozon and Maozi must both be logged in.
- Chrome must allow JavaScript from Apple Events.
- If Maozi returns `token must be` or `登录已失效`, stop and ask the user to log in again.

## Notes

Historical run images and 1688 result caches are intentionally not included to keep this zip small. New runs will regenerate them.
