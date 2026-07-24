# v141 单来源 headroom A/B

## 结论

`NOT PASS / REVERT`。连续 10 分钟最终确认 2 个，折算 12 个/小时。
将 per-source drain 从 2 提高到 4 增加了详情数量，但降低了候选质量和最终速度。

## 基线与变量

- commit: `dcd590b9d869321f255a863432c3d047bf11ac97`
- run: `runs/flow_b/20260724_183200_ozon10m_v141`
- window: `2026-07-24 18:31:59` 至 `18:41:59` CST
- 与 v140 相同的 12 个精确来源页
- 唯一变量: `FLOW_B_CANDIDATE_QUEUE_PER_SOURCE_DRAIN=2 -> 4`
- Ozon 全局间隔仍为 15 秒

## A/B

| 指标 | v140 drain=2 | v141 drain=4 |
|---|---:|---:|
| 最终确认 | 4 | 2 |
| 折算速度 | 24/小时 | 12/小时 |
| 详情尝试 | 6 | 13 |
| 收藏尝试 | 5 | 23 |
| non-pure-fbs | 0 | 10 |
| 利润淘汰 | 1 | 6 |
| ERP 提交 | 3 | 5 |
| online-product-rejected | 0 | 2 |

## 判断

更大 headroom 取得了更多同页尾部候选，但尾部候选的 pure FBS、利润和最终接受率
明显更差，最终速度减半。该变量无效，后续运行恢复 drain=2。

下一轮只改变来源调度，使用历史已经产生最终成功的 seller 查询变体之未扫分页；
不再继续扩大同页 headroom。
