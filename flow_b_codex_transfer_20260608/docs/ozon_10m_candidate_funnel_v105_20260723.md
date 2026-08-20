# v105 title-family funnel scoring 10 分钟小样（2026-07-23）

## 结论

`NOT PASS`。连续 10 分钟最终严格确认 1 个，速度 6 个/小时。标题细分类目评分改变了第二批来源，但没有改善最终速度和可靠成本率，因此按单变量规则整体撤销，不进入 30 分钟验收。

## 冻结信息

- commit：`1ae0c4df29`
- run：`runs/flow_b/20260723_135300_ozon10m_v105`
- 窗口：`2026-07-23T05:54:00.836Z`—`2026-07-23T06:04:00.836Z`
- browser owner PID：`815`
- 保留 v103 配置：`FLOW_B_MAX_SOURCE_BATCHES_PER_TRANCHE=1`
- 已撤销 v104 配置：`FLOW_B_SOURCE_NON_FBS_SAMPLE_LIMIT=4`
- Ozon 全局间隔：15,000ms
- 测试：Node 437/437、Python 13/13、`git diff --check` PASS

## 漏斗

| 指标 | v100 | v103 | v105 |
|---|---:|---:|---:|
| 详情候选 | 79 | 23 | 26 |
| pure FBS | 31（39.2%） | 11（47.8%） | 16（61.5%） |
| non-pure-fbs | 48（60.8%） | 11（47.8%） | 10（38.5%） |
| 进入 1688 | 29 | 13 | 13 |
| 1688可靠成本 | 14（48.3%） | 6（46.2%） | 3（23.1%） |
| ERP提交 | 10 | 3 | 1 |
| 最终成功 | 6/30min | 3/10min | 1/10min |
| 最终速度 | 12/h | 18/h | 6/h |

淘汰为 10 个 `1688-no-reliable-match`、1 个 `missing-shipping-mode`、1 个 `profit_rate<=30`、2 个 `profit-upper-bound<=30`、1 个 `duplicate-title`。没有 transport/health failure。

## 调度效果与撤销依据

- 第一批仍为 Kids Wheels 三个来源。
- 第二批按新评分切换为“金属收藏模型”搜索 page 1/2/3；后续继续使用该搜索的 sorting/page 变体。
- non-pure 比例降到 38.5%，但可靠成本率从 v103 的 46.2% 降到 23.1%，最终速度降到 6/h。
- 评分使用的历史被跨 run 重复候选污染：v105 的 26 个候选中，6 个与 v103 重复，9 个与 v104 重复。重复项包含已知 non-pure、1688 无可靠同品、物流失败和利润失败。

因此不能继续叠加标题评分；应先保证确定性 SKU 结果跨 run 生效，再重新统计未污染的来源/类目收益。

## 成功与稳定性

- 最终成功 SKU：`2042618363`。
- 店铺：丽丽二号；利润率 129.27%；状态 selling；库存 1。
- 唯一成功 1；重复 0；最低利润率 129.27%。
- CAPTCHA / 软拦截 / 页面崩溃 / runtime error：0 / 0 / 0 / 0。
- supervisor、worker、browser owner 均正常退出。

## 下一单变量

恢复 v103 代码调度，只修改跨 run 确定性候选排除：

- 从明确配置的历史 `favorite_collection`、`source_yield` 和已发布状态读取最新 SKU 结果；
- `non-pure-fbs`、原规则判定的 `1688-no-reliable-match`、利润失败、禁止类目、重复标题等确定性结果直接排除；
- `1688-health-deferred`、transport error、页面超时和其他可恢复失败仍可重试；
- published SKU 继续由现有严格去重状态排除；
- 不复用价格，不把历史候选直接标记为 pure FBS，不改变任何业务门槛。
