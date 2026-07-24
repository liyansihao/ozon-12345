# v164 提交 seller 深页前沿 10 分钟小样（2026-07-25）

## 结论

`NOT PASS`。连续 10 分钟最终严格确认 2 个唯一 SKU，速度 12 个/小时；其中 1 个为 v163 待确认提交，1 个为本窗口新增提交并最终确认。

## 窗口与单变量

- Run：`runs/flow_b/20260725_003800_ozon10m_v164`
- 窗口：`2026-07-24T16:38:20.240Z` 至 `2026-07-24T16:48:20.240Z`
- 冻结 commit：`f7bdebc5f73b4ab1ad7b97182ab837e586b81bae`
- 单变量：把 source 收窄到 v163 实际产生提交的 `aldibaby1`、`primeselect-bystry-choice`、`lyuks-treyd-grupp`，扫描其未消费深页及排序变体
- Ozon 15 秒全局间隔、严格列表与详情 pure-FBS、1688 可靠同品/P70、利润率严格大于 30%、最终确认、去重、库存与店铺状态均未改变

## 漏斗

| 指标 | v163 | v164 |
|---|---:|---:|
| source 访问 | 18 | 26 |
| collection 尝试 | 12 | 3 |
| 真实 pure FBS | 11 | 2 |
| 新提交 | 3 | 1 |
| 窗口内最终确认 | 2 | 2 |
| 折算速度 | 12/h | 12/h |
| CAPTCHA / 软拦截 / 崩溃 | 0 / 0 / 0 | 0 / 0 / 0 |

v164 淘汰为 `prohibited-category=1`、`1688-no-reliable-match=1`，另有 1 个 `1688-health-deferred`。运行时致命错误为 0。

## 最终严格成功

| SKU | 来源 | 类型 | 利润率 | 店铺 | 状态/库存 |
|---|---|---|---:|---|---|
| 3566335988 | lyuks-treyd-grupp 首页 | v163 carryover | 67.14% | 丽丽五号 | published / 1 |
| 4024193231 | lyuks-treyd-grupp page 8 | v164 新提交 | 61.88% | 丽丽五号 | published / 1 |

唯一 SKU 为 2，重复为 0，最低利润率为 61.88%。

## 最新瓶颈与下一轮

本轮 26 次 source 访问只形成 3 次 collection 尝试，候选密度是唯一最大损耗；继续深挖这三个小型 seller 没有改善最终速度。

离线读取历史 `source_deep_scan.json` 后确认，多个已验证高成功 seller 的最后已扫页仍返回完整商品列表，而非真正干涸：

- Nature：最后 page 20 仍有 38 个商品链接；
- Jicha：最后 page 28 仍有 38 个；
- Magazin Puhovikov：最后 page 16 仍有 36 个；
- Guanhe：最后 page 20 仍有 35 个；
- Devushka Nadezhda：最后 page 12 仍有 46 个。

下一轮唯一变量改为延伸这些高成功 seller 的未扫描普通分页；不再继续 v164 的低密度三 seller 深页，也不加入排序/价格变体，不改变任何业务规则。

