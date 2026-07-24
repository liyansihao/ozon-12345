# v153 高产 seller 排序变体闸门

## 结论

`SAMPLE GATE NOT PASS`。连续 10 分钟最终确认 0 个 SKU。16 个排序变体中
14 页没有去重后 listing 纯 FBS 候选，最后两个 Miaowu discount 变体产生
3 个候选，但未在窗口内形成最终成功。

## 配置

- commit: `853de9c812316d57b2d61c41538d763be3cb2cb1`
- run: `runs/flow_b/20260724_214700_ozon10m_v153`
- window: `2026-07-24 21:45:24` 至 `21:55:24` CST
- 单变量: 用高产 seller rating/discount 排序变体替换标题搜索
- listing FBS evidence: 严格开启
- Ozon 全局间隔: 15 秒

## 结果

| 指标 | 结果 |
|---|---:|
| 最终确认唯一 SKU | 0 |
| 排序变体来源 | 16 |
| 收藏成功 | 3 |
| 详情/成本查询 | 2 |
| ERP 提交 | 1 |
| 利润率不高于 30% | 1 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 |
| runtime error | 0 |

## 下一单变量

已验证 seller 的 base、深页、搜索和排序变体均接近耗尽。下一轮从历史 source
union 选择尚未实际消费的跨境中国 seller，继续用严格 listing FBS evidence
筛选，建立新的候选池。

