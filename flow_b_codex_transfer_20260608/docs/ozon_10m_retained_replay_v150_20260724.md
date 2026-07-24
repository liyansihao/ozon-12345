# v150 bounded retained replay 闸门

## 结论

`SAMPLE GATE NOT PASS`。连续 10 分钟最终严格确认 0 个 SKU。完整加载
v130–v149 状态后，历史 exact-FBS 未尝试候选 replay 实际取用数为 0，说明
历史候选池已经耗尽。

本轮变量没有改善，`FLOW_B_MAX_RETAINED_LINKS` 撤销回 0。

## 配置

- commit: `e77f916ddb385ea82cd26a273666f0b17c89947c`
- run: `runs/flow_b/20260724_211000_ozon10m_v150`
- window: `2026-07-24 21:06:45` 至 `21:16:45` CST
- 单变量: retained replay 上限从 0 改为 12
- 安全约束: 完整加载 v130–v149 状态，排除已成功和已终止 SKU
- Ozon 全局间隔: 15 秒

## 结果

| 指标 | 结果 |
|---|---:|
| 最终确认唯一 SKU | 0 |
| retained replay 取用 | 0 |
| 收藏成功 | 4 |
| 详情/成本查询 | 5 |
| ERP 提交 | 1 |
| 1688 无可靠同品 | 3 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 |
| runtime error | 0 |

## 下一单变量

当前 listing 插件证据门槛把“物流未知”和“明确非 FBS”同样挡在详情前，22 个
来源页只形成 4 个收藏详情候选。下一轮仅允许物流未知卡片进入真实详情验证；
明确非 FBS 仍提前排除，详情页纯 FBS 验证、1688、利润和最终确认不变。

