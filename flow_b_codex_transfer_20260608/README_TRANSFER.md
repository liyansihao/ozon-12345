# Flow B Playwright 上架流程

当前唯一支持的浏览器流程是 Playwright + Chrome for Testing。毛子采集插件以未打包扩展加载，Ozon 与毛子 ERP 共用一个持久 profile。

## 固定规则

- 目标：确认成功上架 100 个商品。
- 最终利润率必须严格大于 30%；等于 30% 不上架。
- 只允许纯 FBS，拒绝 FBO 及 FBO/FBS 混合模式。
- 必须存在 CEL Economy 计算结果，且 `cate_rate > 0`、`cate_fee > 0`。
- 店铺固定使用已验证的 `store_id=104965`（丽丽1号），水印固定使用 `watermark_id=60822`（允许用 `lysh` 非精确匹配作兼容校验）。
- 单个 SKU 失败会写入失败记录并继续下一个；成功 SKU 不重复上架。
- 没有 dry-run 或单品试跑分支；`publish` 和 `run` 会真实调用上架接口。

## 首次登录

在仓库根目录执行：

```bash
export FLOW_B_EXTENSION_DIR=/Users/mac/Downloads/maozi-plugin-3.0.9/maozi-plugin-3.0.9
npm run flow:b:setup
```

在打开的 Chrome for Testing 中完成 Ozon 和毛子 ERP 登录，然后按 `Ctrl+C` 结束 setup。默认 profile 位于 `runs/flow_b/playwright_setup/playwright_profile`，也可通过 `FLOW_B_PW_PROFILE` 指定。

## 正式命令

只扫描来源并让插件采集收藏：

```bash
npm run flow:b:scan -- runs/flow_b/source_urls.txt runs/flow_b/source_deep_scan.json
```

从毛子收藏中继续可恢复上架：

```bash
npm run flow:b:publish -- runs/flow_b/20260713_playwright_publish
```

使用一个浏览器上下文完成扫描并上架：

```bash
npm run flow:b:run -- runs/flow_b/20260713_playwright_publish runs/flow_b/source_urls.txt
```

连续验收或 24 小时运行使用监督脚本。它会沿用同一个固定窗口和运行目录，浏览器意外退出后自动恢复，不会重置验收计数：

```bash
export FLOW_B_EXTENSION_DIR=/Users/mac/Downloads/maozi-plugin-3.0.9/maozi-plugin-3.0.9
export FLOW_B_STORE_ID=104965 FLOW_B_WATERMARK_ID=60822
export FLOW_B_STORE_NEEDLE=丽丽1号 FLOW_B_WATERMARK_NEEDLE=lysh
export FLOW_B_ACCEPTANCE_SECONDS=7200 FLOW_B_ACCEPTANCE_TARGET=50
export FLOW_B_TARGET_PUBLISH_COUNT=600 FLOW_B_SKIP_RETAINED=1
scripts/run_acceptance_supervised.sh runs/flow_b/acceptance_2h runs/flow_b/source_urls.txt
```

2026-07-14 的固定两小时窗口用以下生产参数确认 52 个有效唯一 SKU（26 个/小时）。24 小时连续运行沿用同一安全配置，将验收目标设为 600、发布上限留出到 720，并使用新的独立运行目录：

```bash
export FLOW_B_EXTENSION_DIR=/Users/mac/Downloads/maozi-plugin-3.0.9/maozi-plugin-3.0.9
export FLOW_B_MAOZI_CONTINUE_LOGIN=1
export FLOW_B_STORE_ID=104965 FLOW_B_WATERMARK_ID=60822
export FLOW_B_STORE_NEEDLE=丽丽1号 FLOW_B_WATERMARK_NEEDLE=lysh
export FLOW_B_ACCEPTANCE_SECONDS=86400 FLOW_B_ACCEPTANCE_TARGET=600
export FLOW_B_TARGET_PUBLISH_COUNT=720 FLOW_B_EXCLUDED_SKUS=2815247918
export FLOW_B_PUBLISH_WORKERS=8 FLOW_B_MAX_PUBLISH_WORKERS=12
export FLOW_B_TAB_WORKERS=6 FLOW_B_MAX_TAB_WORKERS=10 FLOW_B_FAVORITE_WORKERS=6
export FLOW_B_TARGET_FAVORITES=1000 FLOW_B_MAX_LINKS_PER_SOURCE=12
export FLOW_B_POLL_INTERVAL_MS=5000 FLOW_B_PRODUCER_INTERVAL_MS=10000
export FLOW_B_SKIP_RETAINED=1 FLOW_B_LOW_DELTA_BATCH_LIMIT=0
export FLOW_B_FAVORITE_DETAIL_INTERVAL_MS=1000 FLOW_B_FAVORITE_API_INTERVAL_MS=500
export FLOW_B_FAVORITE_DETAIL_RETRIES=0 FLOW_B_FAVORITE_DETAIL_TIMEOUT=8000
export FLOW_B_OZON_DETAIL_TIMEOUT_MS=12000 FLOW_B_1688_ITEM_TIMEOUT=60
export FLOW_B_RESTART_DELAY_SECONDS=5

RUN_DIR=runs/flow_b/$(date +%Y%m%d_%H%M%S)_ozon_24h
SEED_DIR=runs/flow_b/20260714_135000_ozon500_acceptance_2h_v2
export FLOW_B_SOURCE_YIELD_SEED_FILES="$SEED_DIR/source_yield.jsonl"
export FLOW_B_STATE_SEED_FILES="$SEED_DIR/sku_states.jsonl"
export FLOW_B_FAVORITE_SEED_FILES="$SEED_DIR/favorite_collection.jsonl"

scripts/run_acceptance_supervised.sh \
  "$RUN_DIR" \
  runs/flow_b/20260623_131244_gap_to_maozi/source_urls_priority_for_1000.txt
```

采集端会按最新发布收益把已扫描来源切成 60 条反馈小批，复用未尝试链接；成功批次自动提高来源优先级。`Failed to fetch`、HTTP 0、超时或 Ozon 软拦截会触发并发降级与 60/120/180 秒移动冷却。每个 SKU 的错误会落盘后继续；设备已满时会走页面提供的设备接管流程，但不会绕过验证码或其他安全校验。

可覆盖参数：

```bash
FLOW_B_PROFIT_THRESHOLD=30
FLOW_B_TARGET_PUBLISH_COUNT=100
FLOW_B_STORE_NEEDLE=丽丽1号
FLOW_B_WATERMARK_NEEDLE=lysh
```

## 记录与恢复

每个运行目录保存 `sku_states.jsonl`、`published.jsonl`、`failed.jsonl`、`skipped.jsonl` 和原子更新的 `summary.json`。连续验收还会保存 `acceptance_window.json`、`acceptance_summary.json`、`favorite_collection.jsonl`、`stage_timings.jsonl`、`stage_summary.json`、`source_yield.jsonl` 与 `source_yield_summary.json`。全局 `data/flow_b/published_links.csv` 继续用于历史去重。失败或中断的 SKU 在重试前会先查询毛子“已导入”列表，确认外部已成功时只补记本地状态，不重复提交。

1688 图片成本仍由 `scripts/1688_image_median.py` 计算；历史运行目录、图片证据和发布记录不会被清理。

## 测试

```bash
npm run test:flow-b
```
