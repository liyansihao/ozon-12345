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

24 小时连续运行时仅将 `FLOW_B_ACCEPTANCE_SECONDS` 改为 `86400`、`FLOW_B_ACCEPTANCE_TARGET` 改为 `600`，并使用新的独立运行目录。每个 SKU 的错误会落盘后继续；设备已满时会走页面提供的设备接管流程，但不会绕过验证码或其他安全校验。

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
