# v110 候选来源小样报告（2026-07-23）

## 结论

- 正式窗口：2026-07-23 16:59:01–17:09:01（Asia/Shanghai），连续 10 分钟。
- 最终严格确认成功：0 个，0 个/小时，NOT PASS。
- Ozon CAPTCHA / 软拦截 / 浏览器崩溃：0 / 0 / 0。
- 统一 seller-family allowlist 已正确阻止 allowlist 外 seller，但 scanner 自动展开该 seller 的历史页码、排序和价格带；低产变体仍占据主要详情预算。

## 同口径漏斗

| 指标 | v100 | v109 | v110 |
|---|---:|---:|---:|
| 候选/详情采集尝试 | 79 | 21 | 25 |
| non-pure-fbs | 48 (60.8%) | 13 (61.9%) | 18 (72.0%) |
| 进入成本阶段 | 29 | 8 | 5 |
| 可靠 1688 成本 | 14 (48.3%) | 2 (25.0%) | 2 (40.0%) |
| 最终严格确认 | 6 | 0 | 0 |
| 折算最终速度 | 12/h | 0/h | 0/h |

另有 prohibited-category 2 个、1688-no-reliable-match 3 个、profit_rate<=30 1 个。1 个利润率 59.6% 的新商品完成提交，但正式窗口结束时仍为待最终确认，未计成功。

## 精确变体证据（v109+v110）

| source variant | pure FBS / 尝试 | 新提交 |
|---|---:|---:|
| Upcloud, 500/rating/page=3 | 2/2 | 1 |
| Upcloud, seller root | 3/3 | 0 |
| Upcloud, 500/rating/page=2 | 2/4 | 0 |
| Fluff, 500/rating | 1/2 | 1 |
| Fluff, 150/discount | 2/5 | 1 |
| Fluff, 500/rating/page=2 | 0/5 | 0 |
| Nature, 150/discount | 0/4 | 0 |
| Upcloud, 150/discount | 0/2 | 0 |

seller-family 粒度将同一 seller 下的高产与 0% 变体混在一起，正是 v110 比 v100 更差的直接原因。

## 下一轮单变量

将 allowlist 匹配从 seller family 收窄到精确 URL 变体，仅重扫已有真实高收益证据的变体；保持 Ozon 15 秒间隔、1688 可靠性、利润/P70、店铺轮换、去重和最终确认规则不变。

回滚方式：将 `FLOW_B_SOURCE_ALLOWLIST_MATCH` 删除或设为 `family`，即可恢复 v110 行为。
