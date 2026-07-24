# v165 高成功 seller 未扫描普通分页 10 分钟小样（2026-07-25）

## 结论

`NOT PASS`。连续 10 分钟最终严格确认 2 个唯一 SKU，速度 12 个/小时。假设部分成立：Miaowu 未扫描页仍有新成功商品，但 v165 的前半来源调度候选密度不足，未达到 5 个/10 分钟闸门。

## 窗口与单变量

- Run：`runs/flow_b/20260725_005100_ozon10m_v165`
- 窗口：`2026-07-24T16:51:25.989Z` 至 `2026-07-24T17:01:25.989Z`
- 冻结 commit：`16c5b1fa75fc3bd2f03a2362f49db51bbc0f4c77`
- 单变量：从 v164 的三个低密度 seller 深页，切换到 11 个历史高成功 seller 的最后已扫普通页之后
- 严格列表/详情 pure-FBS、Ozon 15 秒全局间隔、1688 可靠同品与 P70、利润率严格大于 30%、最终确认、库存、去重与店铺状态均保持不变

## 漏斗

| 指标 | v164 | v165 |
|---|---:|---:|
| source 访问 | 26 | 26 |
| collection 尝试 | 3 | 4 |
| 真实 pure FBS | 2 | 4 |
| 新提交 | 1 | 2 |
| 最终严格确认 | 2（含 1 carryover） | 2（均为本窗口新增） |
| 折算速度 | 12/h | 12/h |
| CAPTCHA / 软拦截 / 崩溃 | 0 / 0 / 0 | 0 / 0 / 0 |

淘汰为 `profit_rate<=30=1`、`1688-no-reliable-match=1`，另有 2 次可恢复 `1688-health-deferred`；致命运行错误为 0。

## 最终严格成功

| SKU | 来源 | 利润率 | 店铺 | 状态/库存 |
|---|---|---:|---|---|
| 3350364210 | miaowu page 57 | 79.86% | 丽丽五号 | published / 1 |
| 3062389042 | miaowu page 57 | 45.08% | 丽丽五号 | published / 1 |

唯一 SKU 为 2，重复为 0，最低利润率为 45.08%。

## 来源反馈与下一轮

- Miaowu page 57 形成 2 个最终成功，证明未扫描普通分页不是无效重复；
- Nature page 21–23、Jicha page 29–31、Puhovikov page 17–18 没有形成候选；
- Guanhe page 22–23 形成 2 个 pure-FBS 候选，但分别为 `1688-no-reliable-match` 和 `profit_rate<=30`；
- 候选仍只来自少数 source 页。

下一轮只移动到 v165 尚未触达的高成功 seller 前沿：`devushka-nadezhda`、`mamaduduqi`、`pervyy-transport`、`fluff-joy`、`vse-v-dome-1946859` 与 `kids-wheels`。不重复本轮已经给出负样本的前沿页，不改变任何已验收业务或稳定性模块。

