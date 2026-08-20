# v104 low-FBS sample-limit 10 分钟小样（2026-07-23）

## 结论

`NOT PASS`。连续 10 分钟最终严格确认 1 个，速度 6 个/小时。`SOURCE_NON_FBS_SAMPLE_LIMIT=3` 降低了 non-pure-FBS 比例，但最终速度从 v103 的 18/h 降到 6/h，按单变量规则撤销；保留 v103 的 `MAX_SOURCE_BATCHES_PER_TRANCHE=1`。

## 冻结信息

- commit：`387cc05f6d`
- run：`runs/flow_b/20260723_134000_ozon10m_v104`
- 窗口：`2026-07-23T05:36:07.921Z`—`2026-07-23T05:46:07.921Z`
- browser owner PID：`44722`
- 单变量：`FLOW_B_SOURCE_NON_FBS_SAMPLE_LIMIT=3`（v103 为 4）
- 保留配置：`FLOW_B_MAX_SOURCE_BATCHES_PER_TRANCHE=1`
- Ozon 全局间隔：15,000ms
- 测试：Node 436/436、Python 13/13、`git diff --check` PASS

## 漏斗对比

| 指标 | v100 | v103 | v104 |
|---|---:|---:|---:|
| 详情候选 | 79 | 23 | 23 |
| pure FBS | 31（39.2%） | 11（47.8%） | 13（56.5%） |
| non-pure-fbs | 48（60.8%） | 11（47.8%） | 10（43.5%） |
| 1688可靠/唯一处理 SKU | 14/29（48.3%） | 6/13（46.2%） | 6/13（46.2%） |
| ERP提交 | 10 | 3 | 3 |
| 最终成功 | 6/30min | 3/10min | 1/10min |
| 最终速度 | 12/h | 18/h | 6/h |

下游淘汰为 7 个 `1688-no-reliable-match`、1 个 `missing-shipping-mode`、2 个 `profit_rate<=30`；另有 2 次可恢复 `1688-health-deferred`。本轮变量对可靠成本率没有改善。

## 成功与稳定性

- 最终成功 SKU：`2229485603`。
- 店铺：丽丽二号；利润率 46.64%；状态 selling；库存 1。
- 唯一成功 1；重复 0；最低利润率 46.64%。
- CAPTCHA / 软拦截 / 页面崩溃 / runtime error：0 / 0 / 0 / 0。
- supervisor、worker、browser owner 均正常退出。

## 撤销依据与下一轮

3 个连续 non-pure 的限制只是让同一 URL 更早停止，但同 seller 的 page、sorting 和价格带仍会分别产生候选；10 个 source 页面中全部来自 Kids Wheels 的变体。non-pure 仅减少 1 个，最终成功反而减少 2 个，因此不保留本轮配置。

最新最大损耗是候选细分类目的 1688 同品可靠率。当前 `other` 标题族把儿童电动车、标准化收藏模型和大量普通商品混为一类，历史最终发布量让这个大类的分数达到上限，却不能区分：

- 标准化模型：历史最终转化和 1688 可靠率高；
- 儿童电动车：pure FBS 高，但可靠同品波动大；
- 普通 `other`：样本庞大、最终率低。

下一轮只修改标题细分类目及其完整漏斗得分，让标准化模型/高可靠细分在 source 搜索和候选队列中优先；最终 pure-FBS、1688 同品和利润仍逐 SKU 严格验证。
