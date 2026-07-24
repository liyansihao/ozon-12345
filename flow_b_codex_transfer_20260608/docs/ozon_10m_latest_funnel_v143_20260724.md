# v143 最新完整漏斗来源闸门

## 结论

`SAMPLE GATE PASS`。连续 10 分钟 ERP/Ozon 最终严格确认 7 个唯一 SKU，
折算 42 个/小时，高于 5 个和 30 个/小时的正式验收启动闸门。

通用 `acceptance_summary.passed` 仍为 false，是因为该字段同时检查长期“五店各
100 个”的 per-store 目标；本轮样本闸门按用户指定的 10 分钟最终确认数判定。

## 配置

- commit: `7db6f8f9a66603f3e885dde110d1fef4638ec0d0`
- run: `runs/flow_b/20260724_185700_ozon10m_v143`
- window: `2026-07-24 18:56:31` 至 `19:06:31` CST
- drain: 2
- 单变量: 按最新完整漏斗重排到 Fluff discount、Miaowu base、Jicha rating
  的未扫页
- Ozon 全局间隔: 15 秒

## 结果

| 指标 | 结果 |
|---|---:|
| 最终确认唯一 SKU | 7 |
| 折算速度 | 42/小时 |
| 最低利润率 | 32.95% |
| 重复 SKU | 0 |
| 候选发现 | 30 |
| 收藏成功 | 13 |
| ERP 提交 | 7 |
| non-pure-fbs | 6 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 |
| runtime error | 0 |

淘汰：利润率不高于 30% 为 4，1688 无可靠同品为 2；最终拒绝 1。

## 来源反馈

Miaowu pages 13–16 是本窗口主产出来源；此前 Fluff discount 的待确认商品也在
本窗口转正。下一正式窗口继续 Miaowu 的相邻未扫页，并用 Fluff discount 和
Jicha rating 的相邻未扫页补充来源，保持所有质量与风控约束不变。
