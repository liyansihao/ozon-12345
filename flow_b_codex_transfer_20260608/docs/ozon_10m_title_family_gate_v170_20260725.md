# v170 listing-unknown 标题族预筛 10 分钟小样

## 结论

`NOT PASS`。连续 10 分钟最终严格确认 1 个唯一 SKU，速度 6 个/小时；该 SKU 是 v169 待确认提交。标题族预筛没有改善这组来源的纯 FBS 转化，因此已从生产代码撤销，不继续叠加。

## 窗口与单变量

- Run：`runs/flow_b/20260725_015700_ozon10m_v170`
- 窗口：`2026-07-24T17:57:35.141Z` 至 `2026-07-24T18:07:35.141Z`
- 冻结 commit：`12f010ee2e090bcb0ed57e89f4a7a41df40255b5`
- 单一变量：v169 相同四个公开进口 seller 和相同页面，仅允许 `socks/underwear/footwear/clothing/headwear` 的 listing-unknown 候选进入详情。
- Ozon 15 秒全局间隔、显式非 FBS 拒绝、真实详情纯 FBS、1688 可靠同品/P70、利润率严格大于 30%、最终确认、库存和去重均未改变。

## 漏斗

| 指标 | v169 | v170 |
|---|---:|---:|
| collection 尝试 | 28 | 25 |
| 真实纯 FBS | 4 | 0 |
| non-pure-fbs | 23（82.1%） | 23（92.0%） |
| 新提交 | 3 | 0 |
| 最终严格成功 | 0 | 1（carryover） |
| 折算速度 | 0/h | 6/h |
| CAPTCHA / 软拦截 / 崩溃 | 0 / 0 / 0 | 0 / 0 / 0 |

另有 `oversized-low-yield-title=1`、`prohibited-category=1`；collection/runtime 错误均为 0。

## 回退与下一瓶颈

v170 证明标题族能描述 1688 可匹配性，但不能替代真实 FBS 来源证据。补丁已完整回退到 v169 之前的生产行为；下一轮恢复 `FLOW_B_REQUIRE_LISTING_FBS_EVIDENCE=1`。最新高置信度证据是：

- v163：12 次详情、11 个真实纯 FBS、3 次提交，但只有 2 个最终成功；
- v165：Miaowu page 57 的两个服装候选均严格最终成功，利润率为 79.86% 和 45.08%；
- v170：listing-unknown 标题族的真实纯 FBS 为 0/25。

因此下一轮只改变来源前沿：从 v170 的公开进口 seller 切换到 `Miaowu page 58+`，保留严格 listing FBS 证据，验证 v165 的高产服装 seller 是否可连续供给。
