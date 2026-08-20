# v151 物流未知卡片真实详情验证闸门

## 结论

`SAMPLE GATE NOT PASS`。连续 10 分钟最终确认 1 个唯一 SKU，来自 v150
待确认商品；本窗口新商品最终成功为 0。

放开 listing 未知证据后，候选发现增至 61，但 28 次真实详情中 27 次确认非纯
FBS，纯 FBS 通过率只有 3.6%；唯一纯 FBS 又没有可靠 1688 同品。因此该变量
无效，恢复 `FLOW_B_REQUIRE_LISTING_FBS_EVIDENCE=1`。

## 配置

- commit: `eafcbe3a21d3fec4b6b60435551b9fc038094e19`
- run: `runs/flow_b/20260724_212000_ozon10m_v151`
- window: `2026-07-24 21:19:30` 至 `21:29:30` CST
- 单变量: listing FBS evidence required 从 1 改为 0
- 明确非 FBS: 仍提前排除
- 未知物流: 进入真实详情验证
- Ozon 全局间隔: 15 秒

## 结果

| 指标 | 结果 |
|---|---:|
| 最终确认唯一 SKU | 1 |
| 本窗新商品最终成功 | 0 |
| 候选发现 | 61 |
| 真实详情尝试 | 28 |
| non-pure-fbs | 27 |
| 真实纯 FBS | 1 |
| 纯 FBS 通过率 | 3.6% |
| 1688 无可靠同品 | 1 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 |
| runtime error | 0 |

## 下一单变量

恢复严格 listing FBS evidence。下一轮不再翻相同 seller 深页，改用历史成功商品
的标准化标题/类目构造精确 Ozon 搜索来源，寻找新的 listing 已确认纯 FBS 商品池。

