# v108c 30 分钟正式验收（2026-07-23）

## 结论

`NOT PASS`。窗口连续运行满 30 分钟，Ozon CAPTCHA / soft-block / 页面崩溃均为 0，但 ERP/Ozon 最终严格确认只有 2 个唯一 SKU，速度 4 个/小时，未达到 15 个/30 分钟。

30 分钟全停冷却有效恢复了 Ozon 稳定访问；当前唯一主要瓶颈重新回到候选来源收益，不能通过进一步等待、降低 Ozon 间隔或放宽业务规则解决。

## 冻结信息

- commit：`42edca76fc`
- run：`runs/flow_b/20260723_160300_ozon30m_v108c`
- 窗口：`2026-07-23T08:04:18.934Z`—`2026-07-23T08:34:18.934Z`
- 北京时间：16:04:18—16:34:18
- Ozon 全局间隔：15,000ms
- source tranche：1
- 单来源样本上限：4
- supervisor/browser owner：单实例、正常退出

## 结果与漏斗

| 指标 | v108c |
|---|---:|
| 候选采集尝试 | 76 |
| non-pure-fbs | 52（68.4%） |
| prohibited-category | 5 |
| missing-shipping-mode | 1 |
| oversized-low-yield-title | 1 |
| Ozon detail / 1688 cost | 17 / 17 |
| 可靠成本进入利润计算 | 10（58.8% of detail） |
| 1688-no-reliable-match | 5 |
| profit_rate<=30 | 9 |
| 新鲜严格提交 | 1 |
| 最终严格确认 | 2 |
| 最终速度 | 4/小时 |
| CAPTCHA / soft-block / 崩溃 | 0 / 0 / 0 |

最终 SKU 为 `4465087058`、`4726795162`，均为唯一 SKU。`4726795162` 利润率 42.37%，严格大于 30%；最终确认状态为 `selling` 且库存 1。

## 最新最大瓶颈

v108c 扫描推进到历史低收益来源后，source checkpoint 本身无法保证下一批 source 仍有高漏斗收益：

- 76 个候选中 52 个在真实详情校验时为 non-pure-fbs；
- 10 个可靠成本商品中 9 个利润率不达标；
- 大量 `miaowu`、`fluff-joy` 普通分页和泛玩具来源没有最终成功；
- 只有 `fluff-joy?currency_price=500...sorting=discount` 在本窗口产生 1 个新最终成功。

跨 v100–v108c 的最终确认历史显示：

| 来源 | 候选 | pure FBS | 最终确认 | 最终率 |
|---|---:|---:|---:|---:|
| nature page=3 | 7 | 5 | 4 | 57.1% |
| nature page=4 | 7 | 4 | 3 | 42.9% |
| nature base | 12 | 7 | 3 | 25.0% |
| kids-wheels page=2 | 28 | 23 | 4 | 14.3% |
| kids-wheels base | 27 | 19 | 4 | 14.8% |
| wizzal-kids base | 12 | 3 | 3 | 25.0% |

这些来源同时拥有真实最终确认样本，优于只按候选数量或当前文件顺序继续扫描。

## 下一轮单变量

v109 只改变 source 输入集合及顺序：优先保留 `nature`、`kids-wheels`、`wizzal-kids` 三个有历史最终确认的 source family，让现有 scanner 从已完成 checkpoint 后的深页继续；其余代码、Ozon 15 秒间隔、1688 可靠同品、P70、利润率、五店轮换、去重、库存和最终确认均不变。

先运行新的连续 10 分钟小样；若最终速度和漏斗没有改善，则撤销该 source allowlist，不进入正式窗口。
