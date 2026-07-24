# v148 Miaowu 新页集中扫描闸门

## 结论

`SAMPLE GATE NOT PASS`。连续 10 分钟最终严格确认 1 个唯一 SKU，折算
6 个/小时，低于 5 个和 30 个/小时闸门。

本轮单变量没有改善，按规则撤销，不将 Miaowu-only 继续用于正式窗口。

## 配置

- commit: `5a5dc11affb054cb01fc6d1fd6f07954468636ab`
- run: `runs/flow_b/20260724_204200_ozon10m_v148`
- window: `2026-07-24 20:41:19` 至 `20:51:19` CST
- 单变量: 去除 v147 实测零产 seller，只扫描 Miaowu pages 39–60
- Ozon 全局间隔: 15 秒
- drain: 2

## 结果

| 指标 | 结果 |
|---|---:|
| 最终确认唯一 SKU | 1 |
| 折算速度 | 6/小时 |
| 最低利润率 | 42.88% |
| 重复 SKU | 0 |
| 完成扫描页 | 18 |
| 收藏成功 | 6 |
| 详情/成本查询 | 7 |
| ERP 提交 | 3 |
| 最终拒绝 | 1 |
| 1688 无可靠同品 | 1 |
| 利润率不高于 30% | 2 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 |
| runtime error | 0 |

18 个完成扫描页中只有 pages 40、42、43、46、52、56 各自留下 1–2 个候选，
其余 12 页为 0；Miaowu 深页候选密度继续下降。

## 下一单变量

撤销 Miaowu-only。下一小样改为尚未深挖、但历史最终成功率有真实证据的 seller
相邻页：Kids Wheels、Mamaduduqi、Pervyy Transport 和 Wizzal。其余配置与
质量口径保持不变。

