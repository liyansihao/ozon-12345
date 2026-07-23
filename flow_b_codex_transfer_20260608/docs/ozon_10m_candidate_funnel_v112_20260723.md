# v112 高产来源刷新小样报告（2026-07-23）

## 结论

- 正式窗口：2026-07-23 17:28:47–17:38:47（Asia/Shanghai），连续 10 分钟。
- 最终严格确认：0 个，0 个/小时，NOT PASS。
- 候选详情：19 个；non-pure-fbs 18、prohibited-category 1、pure FBS 0。
- 1688 / 利润 / ERP 阶段输入均为 0，因为没有候选通过纯 FBS。
- Ozon CAPTCHA / 软拦截 / 浏览器崩溃：0 / 0 / 0。

## 与历史证据的变化

本轮清空完成 checkpoint 后，重新扫描历史高产的 Upcloud、Nature、Kids Wheels 当前 listing。结果表明这些来源的库存结构已经整体翻转：

- Upcloud 与 Nature 的首批当前详情全部 non-pure-fbs；
- Kids Wheels 当前首个详情同样 non-pure-fbs；
- v100–v108 的历史最终发布率已不能代表当前库存；
- 静态复扫旧高产 seller 不再有收益。

## 新发现的重复请求

Kids Wheels 的同一精确变体同时以：

- `?page=2&currency_price=...&sorting=rating`
- `?currency_price=...&sorting=rating&page=2`

进入调度。两者只是在 query 参数顺序上不同，却被当成两个来源各扫描一次，浪费了一个 15 秒全局访问槽位。

## 决策

1. 对来源 URL 按排序后的 query 参数做等价去重，并覆盖 input、derived URL 与 retained checkpoint；
2. 回归测试证明参数顺序不同的 URL 只调度一次；
3. 不继续复扫已证明干涸的 seller，下一轮恢复新来源发现；
4. 保持纯 FBS、1688 同品/P70、利润率严格大于 30%、去重、轮换和最终确认规则不变。

回滚方式：回退本报告对应 commit 的 source URL 去重改动，即恢复 v112 行为。
