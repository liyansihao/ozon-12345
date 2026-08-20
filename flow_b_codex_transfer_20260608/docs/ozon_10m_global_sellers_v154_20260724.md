# v154 第一批未消费跨境 seller 闸门

## 结论

`SAMPLE GATE NOT PASS`。连续 10 分钟最终确认 1 个 SKU，来自 v153
待确认转正；本窗口新商品最终成功为 0。

## 配置

- commit: `fdf28accf58eff7c64aee47f3aedbf5c33aff44b`
- run: `runs/flow_b/20260724_220000_ozon10m_v154`
- window: `2026-07-24 21:57:18` 至 `22:07:18` CST
- 单变量: 用第一批 18 个未消费跨境中国 seller 替换耗尽来源
- listing FBS evidence: 严格开启
- Ozon 全局间隔: 15 秒

## 结果

| 指标 | 结果 |
|---|---:|
| 最终确认唯一 SKU | 1 |
| 本窗新商品最终成功 | 0 |
| 候选发现 | 9 |
| 非纯 FBS / 缺物流 | 3 |
| 1688 无可靠同品 | 4 |
| 利润率不高于 30% | 2 |
| ERP 提交 | 0 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 |
| runtime error | 0 |

## 下一单变量

第一批跨境 seller 没有形成完整漏斗成功。继续同一“新来源池”方向，切换到历史
source union 中下一批尚未消费的跨境 seller；不重复本批低产来源。

