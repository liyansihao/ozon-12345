# v152 历史成功标准化标题搜索闸门

## 结论

`SAMPLE GATE NOT PASS`。连续 10 分钟最终严格确认 0 个 SKU。12 个精确
搜索只形成 4 个 listing 纯 FBS 候选，均未通过完整漏斗。

## 配置

- commit: `9ced96cd67a913087a5cc44adfd10b48bb909524`
- run: `runs/flow_b/20260724_213300_ozon10m_v152`
- window: `2026-07-24 21:33:04` 至 `21:43:04` CST
- 单变量: 用历史成功标准化标题搜索替换 seller 深页
- listing FBS evidence: 严格开启
- Ozon 全局间隔: 15 秒

## 结果

| 指标 | 结果 |
|---|---:|
| 最终确认唯一 SKU | 0 |
| 搜索来源 | 12 |
| listing 纯 FBS 候选 | 4 |
| 禁售类目 | 1 |
| 利润率不高于 30% | 2 |
| 1688 无可靠同品 | 1 |
| ERP 提交 | 0 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 |
| runtime error | 0 |

## 下一单变量

标题搜索未形成足够候选。下一轮改用高产 seller 的 rating/discount 排序变体首页，
让 Ozon 重排目录并寻找未在 base 深页出现的候选；保持所有质量与访问规则不变。

