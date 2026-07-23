# v111 精确来源小样报告（2026-07-23）

## 结论

- 正式窗口：2026-07-23 17:15:35–17:25:35（Asia/Shanghai），连续 10 分钟。
- ERP/Ozon 窗口内最终严格确认：1 个，6 个/小时，NOT PASS。
- 该 SKU `2856744182` 是 v110 已提交的待确认商品；v111 仅完成最终协调，不是 v111 新来源产生的新提交。
- v111 新候选：4 个，全部 non-pure-fbs；新可靠成本、新利润通过、新提交均为 0。
- Ozon CAPTCHA / 软拦截 / 浏览器崩溃：0 / 0 / 0。

## 根因证据

精确 allowlist 同时约束了新扫描和 retained checkpoint，来源没有越界。但 7 个精确来源均已存在于完成 checkpoint，跨 run 去重又排除了已尝试 SKU：

- checkpoint 最终仅有 8 条记录（其中一条是参数顺序不同但规范化后相同的 URL）；
- scanner 报告 `pending: 0`；
- 17:16:51 后没有新的 Ozon 访问，supervisor 继续存活并只做待确认协调；
- 首个历史高产变体 Nature 500/rating/page=4 的最新样本为 0/4 pure FBS，旧的 2/5 历史纯 FBS 证据已失效。

因此，静态精确白名单虽然避免低产派生来源，但会因完成 checkpoint 和商品去重迅速干涸，不能支持持续吞吐。

## 下一轮单变量

刷新经过历史完整漏斗验证的精确 source portfolio：

1. 不复用“已完成”的 source checkpoint，强制重新读取当前 listing；
2. 保留精确 URL 约束；
3. 以历史最终发布率和最新失败连续性选择 Kids Wheels、Nature、Upcloud 的高产页面；
4. 跨 run SKU 状态继续完整继承，防止重新扫描导致重复上架。

保持 Ozon 15 秒全局间隔、1688 可靠性、P70、利润率严格大于 30%、五店轮换和最终确认逻辑不变。

回滚方式：重新使用 v111 的 `source_deep_scan.json` 作为 checkpoint，即恢复 v111 行为。
