# v149 未深挖高历史成功 seller 闸门

## 结论

`SAMPLE GATE NOT PASS`。连续 10 分钟最终严格确认 1 个唯一 SKU，折算
6 个/小时。该成功是 v148 待确认商品在本窗口转正；本窗口新商品最终成功为 0。

本轮单变量没有改善，按规则撤销。

## 配置

- commit: `c9c97b733fb4200d2a34088e87c990498228ca78`
- run: `runs/flow_b/20260724_205500_ozon10m_v149`
- window: `2026-07-24 20:54:02` 至 `21:04:02` CST
- 单变量: 用 Kids Wheels、Mamaduduqi、Pervyy Transport、Wizzal 的未深挖页
  替换 Miaowu 深页
- Ozon 全局间隔: 15 秒
- drain: 2

## 结果

| 指标 | 结果 |
|---|---:|
| 最终确认唯一 SKU | 1 |
| 本窗新商品最终成功 | 0 |
| 折算速度 | 6/小时 |
| 收藏成功 | 5 |
| 详情/成本查询 | 8 |
| ERP 提交 | 1 |
| 最终拒绝 | 1 |
| 1688 无可靠同品 | 4 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 |
| runtime error | 0 |

新 seller 深页虽能形成少量纯 FBS 候选，但 1688 可靠同品转化为 0，已经不是
可继续扩展的高产来源。

## 下一单变量

恢复包含多 seller 的来源基线，只改变候选供给方式：重新启用代码中已有、测试
覆盖的“小批量历史 exact-FBS 未尝试候选 replay”，上限 12。该 replay 仍会执行
真实详情、1688、利润、ERP/Ozon 最终确认和去重，不复用失败/已上架 SKU。

