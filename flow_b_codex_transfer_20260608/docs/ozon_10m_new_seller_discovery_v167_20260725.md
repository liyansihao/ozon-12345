# v167 新 seller 发现 10 分钟小样（2026-07-25）

## 结论

`NOT PASS`。连续 10 分钟最终严格确认 0 个。混合本地历史 seller 与公开新 seller 的来源池没有改善，且历史分数仍优先消耗低产 seller。

## 窗口与单变量

- Run：`runs/flow_b/20260725_011800_ozon10m_v167`
- 窗口：`2026-07-24T17:16:44.621Z` 至 `2026-07-24T17:26:44.621Z`
- 冻结 commit：`88f6ee985ec70b672dfadb26e534e042b9cda742`
- 单变量：使用此前从未作为 source 扫描的新 seller，来源为本地真实详情 seller URL 与公开可索引 Ozon 店铺页
- 严格列表与详情 FBS、Ozon 15 秒间隔及其余业务口径均不变

## 漏斗

| 指标 | v166 | v167 |
|---|---:|---:|
| source 访问 | 22 | 22 |
| collection 尝试 | 2 | 3 |
| 真实 pure FBS | 2 | 2 |
| 新提交 | 1 | 0 |
| 最终严格确认 | 1 | 0 |
| 折算速度 | 6/h | 0/h |
| CAPTCHA / 软拦截 / 崩溃 | 0 / 0 / 0 | 0 / 0 / 0 |

淘汰/延后分别为 `non-pure-fbs=1`、`1688-no-reliable-match=1`、`1688-health-deferred=1`；运行时致命错误为 0。

公开发现的 `china-import-specialty-store`、`joom`、`chaning-pool` 与 `official-dream` 页面均被正常访问，但没有形成严格列表 FBS 候选。继续扩页没有数据依据。

## 下一轮证据

静态调用关系显示 `sourceUrlPriority()` 明确为 URL 中的 `tovary-iz-kitaya` 保留 Global 加权，并为服饰类来源再加目标品类权重；但历史 run 的 source 文件中从未出现这类 URL。公开索引确认 Ozon 当前存在 `https://www.ozon.ru/category/tovary-iz-kitaya-odezhda/`。

下一轮唯一变量改为只扫描该可分页 Global/服饰类目，不混入 seller 或搜索来源。最终仍要求列表明确 FBS、详情真实 pure FBS、可靠 1688/P70 和利润率严格大于 30%。

