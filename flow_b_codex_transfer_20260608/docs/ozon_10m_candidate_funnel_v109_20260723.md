# v109 候选来源小样报告（2026-07-23）

## 结论

- 正式窗口：2026-07-23 16:41:05–16:51:05（Asia/Shanghai），连续 10 分钟。
- 最终严格确认成功：0 个，0 个/小时，NOT PASS。
- Ozon CAPTCHA / 软拦截 / 浏览器崩溃：0 / 0 / 0。
- v109 的主要变量原计划为仅输入 Nature、Kids Wheels、Wizzal 三个历史高产 seller；但历史 `source_deep_scan.json` 和跨 run 收益证据仍派生出 Upcloud、Fluff 等来源，因此输入文件没有形成真正的运行时 allowlist，本轮变量未按预期生效。

## 同口径漏斗

| 指标 | v100 | v109 |
|---|---:|---:|
| 候选/详情采集尝试 | 79 | 21 |
| non-pure-fbs | 48 (60.8%) | 13 (61.9%) |
| 进入成本阶段 | 29 | 8 |
| 可靠 1688 成本 | 14 (48.3%) | 2 (25.0%) |
| 最终严格确认 | 6 | 0 |
| 折算最终速度 | 12/h | 0/h |

v109 的 `stage_timings` 为：Ozon 详情/类目 8 次，平均 8.825 秒；1688 成本 8 次，平均 2.978 秒；利润计算 2 次；ERP 提交/确认阶段 2 次。2 个商品在窗口结束时仍为 `publish-final-status-timeout` / 待协调状态，不计入最终成功。

## 来源证据

- Wizzal：13 个详情样本全部为 non-pure-fbs，近期 pure FBS 率 0%，已由来源降权机制暂停相应页面。
- Upcloud：产生本轮多数 pure FBS 候选，并形成 1 个高利润待确认提交；但它不在 v109 输入文件中，证明 checkpoint/历史派生来源绕过了输入列表。
- Fluff：形成 1 个高利润待确认提交，同样不在 v109 输入文件中。
- Nature / Kids Wheels：本窗口没有获得足够的新详情结果，无法用 v109 更新其历史最终成功率。

## 决策

v109 不进入 30 分钟正式验收。下一轮仅修改来源调度约束：

1. 在统一 source scanner 调度层加入可测试的来源 allowlist；
2. seller 根 URL 允许其排序、价格带和页码变体，但禁止历史 checkpoint/收益派生出未列入的 seller；
3. 根据最新完整漏斗和近期失败连续性，下一小样选择 Upcloud、Fluff、Nature，撤下近期 0/13 的 Wizzal；
4. 保持 Ozon 全局 15 秒间隔、1688 SSL 修复、利润/P70、去重、轮换和最终确认逻辑不变。

回滚方式：删除 `FLOW_B_SOURCE_ALLOWLIST_FILE` 即恢复原调度；代码 helper 在 allowlist 为空时原样返回全部来源。
