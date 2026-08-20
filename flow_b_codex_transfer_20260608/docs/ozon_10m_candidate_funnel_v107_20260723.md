# v107 source checkpoint 恢复小样（2026-07-23）

## 结论

候选速度闸门 `PASS`，严格运行完整性 `NOT PASS`。

- 连续 10 分钟内 ERP/Ozon 最终严格确认 5 个唯一 SKU，折算 30 个/小时；
- 最低利润率 56.69%，全部严格大于 30%；
- 最终商品均为 `selling` 且库存 1；
- Ozon CAPTCHA / soft-block / 页面崩溃：0 / 0 / 0；
- 但 SKU `3900412704` 在 v106b 已提交、尚未最终确认，v107 又产生了一次新的 ERP 提交，因此 v107 不能作为“重复提交为 0”的正式验收。

性能单变量有效，应保留；正式窗口前必须把最近 run 的 `sku_states.jsonl` 同时加入已有的 `FLOW_B_PENDING_STATE_SEED_FILES`，让已提交状态走 `reconcile_only`，而不是重新提交。

## 冻结信息

- commit：`af5677476b`
- run：`runs/flow_b/20260723_143900_ozon10m_v107`
- 窗口：`2026-07-23T06:40:44.515Z`—`2026-07-23T06:50:44.515Z`
- 北京时间：14:40:44—14:50:44
- 单一性能变量：从 v106b 恢复 `source_deep_scan.json`
- Ozon 全局间隔：15,000ms
- source tranche：1
- 单来源样本上限：4
- 测试：Node 436/436、Python 13/13

## 修改前后漏斗

| 指标 | v106b | v107 |
|---|---:|---:|
| 候选采集尝试 | 29 | 26 |
| non-pure-fbs | 13（44.8%） | 14（53.8%） |
| Ozon detail | 12 个唯一 | 13 |
| 可靠 1688 成本 | 7/12（58.3%） | 11/12（91.7%） |
| 严格提交 | 5 | 10 |
| 窗口内最终确认 | 2 | 5 |
| 折算最终速度 | 12/小时 | 30/小时 |
| CAPTCHA / soft-block / 崩溃 | 0 / 0 / 0 | 0 / 0 / 0 |

v107 进入下游后的淘汰仅为 profit-upper-bound<=30、1688-no-reliable-match、profit_rate<=30 各 1 个。checkpoint 恢复把历史高产 Nature 来源提前到窗口第 1 分钟内，前 3 分 15 秒已经产生 5 个严格合格提交；v106b 达到 5 个提交是在窗口最后约 2 分钟。

## 最终确认商品

| SKU | 最终确认（UTC） | 店铺 | 利润率 | 状态 | 库存 |
|---|---|---|---:|---|---:|
| 3900412704 | 06:44:35 | 丽丽二号 | 218.33% | selling | 1 |
| 4839531039 | 06:46:46 | 丽丽二号 | 133.13% | selling | 1 |
| 4030742740 | 06:46:50 | 丽丽二号 | 56.69% | selling | 1 |
| 4215228277 | 06:47:19 | 丽丽二号 | 80.44% | selling | 1 |
| 3900654696 | 06:50:42 | 丽丽二号 | 65.33% | selling | 1 |

第 5 个最终确认发生在窗口结束前 2.351 秒，计数口径为 `published.jsonl` 中 ERP/Ozon 严格最终确认事件，不是提交数或待确认数。

## 重复提交根因与正式窗口保护

`FLOW_B_STATE_SEED_FILES` 只用于候选端的 terminal/deterministic 排除；它不会恢复已提交但未完成的 `processing` 状态。项目已有另一条专门的恢复入口 `FLOW_B_PENDING_STATE_SEED_FILES`：

- 仅恢复 `submitted/submission_pending` 且非确定性失败的状态；
- 强制写入 `reconcile_only: true`；
- 复用原 store/offer/SKU，只查询原提交的 ERP/Ozon 最终状态；
- 不重新执行发布。

v107 启动配置追加了最近 run 到前者，却没有追加到后者，所以 v106b 的 `3900412704` 被候选扫描再次发现并重新提交。正式 30 分钟窗口会同时追加最近 run 的状态文件到 pending-state seed；这是恢复已有安全职责，不改变候选性能变量、利润/成本口径、Ozon 节奏或五店规则。
