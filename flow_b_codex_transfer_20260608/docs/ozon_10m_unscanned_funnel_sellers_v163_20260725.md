# v163 未扫描漏斗 seller 10 分钟小样（2026-07-25）

## 结论

`NOT PASS`，但来源变量相对 v162 有明确改善。连续 10 分钟 ERP/Ozon 最终严格确认 2 个唯一 SKU，速度 12 个/小时；未达到 5 个/10 分钟闸门。

## 窗口与单变量

- Run：`runs/flow_b/20260725_002500_ozon10m_v163`
- 窗口：`2026-07-24T16:24:52.857Z` 至 `2026-07-24T16:34:52.857Z`
- 冻结 commit：`4b609e0085f526f67431619fb67835d27a07abb2`
- 单变量：恢复严格列表 FBS 证据，把标准化搜索替换为历史真实漏斗中曾提交、最终成功或得到可靠成本，但尚未作为 source 扫描的 seller 店铺页
- 其余规则不变：Ozon 15 秒全局间隔、真实详情 pure-FBS、1688 可靠同品与 P70、利润率严格大于 30%、最终确认、库存、去重及五店状态延续

## 漏斗

| 指标 | v162 | v163 |
|---|---:|---:|
| source 访问 | 10 | 18 |
| collection 尝试 | 22 | 12 |
| 真实 pure FBS | 0 | 11 |
| non-pure-fbs | 21 | 1 |
| 1688/利润后提交 | 0 | 3 |
| ERP/Ozon 最终确认 | 0 | 2 |
| 折算速度 | 0/h | 12/h |
| CAPTCHA / 软拦截 / 崩溃 | 0 / 0 / 0 | 0 / 0 / 0 |

淘汰为：`1688-no-reliable-match=4`、`profit_rate<=30=3`、`profit-upper-bound<=30=1`；另有 1 个 `1688-health-deferred`，运行时致命错误为 0。

## 最终严格成功

| SKU | seller/source | 店铺 | 利润率 | 状态 | 库存 |
|---|---|---|---:|---|---:|
| 4959651348 | aldibaby1 page 6 | 丽丽五号 | 120.28% | published | 1 |
| 2301279081 | primeselect-bystry-choice | 丽丽五号 | 59.23% | published | 1 |

唯一 SKU 为 2，重复为 0，最低利润率为 59.23%。

## 下一轮单变量

有效提交集中在三个 seller：`aldibaby1`、`primeselect-bystry-choice`、`lyuks-treyd-grupp`。低产 seller 尤其 `metal-puzzle-2459864` 连续产生可靠同品失败，消耗了后半窗口。

下一轮只缩窄 source 调度到上述三个已产生提交的 seller，并扫描尚未消费的深页及排序变体；严格列表 FBS、详情复核和所有业务口径保持不变。目标是减少已知低可靠同品 seller 占用，把候选详情预算集中到完整漏斗已有正收益的来源。

