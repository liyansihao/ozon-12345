# v142 查询变体来源闸门

## 结论

`NOT PASS`。连续 10 分钟最终确认 3 个，折算 18 个/小时。

## 配置

- commit: `2211c78db47bd1072f0f32c1190e21106d5d1fd0`
- run: `runs/flow_b/20260724_184500_ozon10m_v142`
- window: `2026-07-24 18:44:43` 至 `18:54:43` CST
- per-source drain 已恢复为 2
- 单变量: Jicha rating、Fluff discount、Wizzal rating 的 12 个未扫页
- Ozon 全局间隔: 15 秒

## 漏斗

| 指标 | 数量 |
|---|---:|
| 收藏尝试 | 16 |
| non-pure-fbs | 6 |
| 详情/成本处理 | 11 |
| ERP 提交 | 6 |
| 最终确认 | 3 |
| online-product-rejected | 2 |

淘汰：1688 无可靠同品 2，利润率不高于 30% 为 2。
Ozon CAPTCHA、soft block、browser crash 和 runtime error 均为 0。

## 来源反馈

Fluff discount pages 4–7 产生 2 个最终成功，Jicha rating pages 11–14 产生 1 个，
Wizzal rating pages 4–7 没有最终产出。下一轮按最新完整漏斗收益继续推进
Fluff discount 和 Miaowu base 的未扫页，降低已证实干涸来源权重。
