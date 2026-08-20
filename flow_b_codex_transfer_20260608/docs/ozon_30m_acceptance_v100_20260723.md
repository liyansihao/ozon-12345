# v100 1688 修复后 30 分钟完整验收（2026-07-23）

## 最终结论

- 1688 SSL/transport 专项：**PASS**。
- 连续 30 分钟完整验收：**NOT PASS**。
- NOT PASS 原因：窗口内 ERP/Ozon 最终严格成功 6 个唯一 SKU，实际速度 12 个/小时，未达到 15 个和 30 个/小时。
- 安全指标通过：重复 SKU 0，最低利润率 36.2%，6 个成功商品均为 `selling` 且库存 1；Ozon CAPTCHA、软拦截、浏览器崩溃均为 0；runtime error 0。
- 1688 SSL EOF 已消失，但严格同品/价格簇无法给出可靠成本成为本窗口最大业务淘汰原因。因此完整验收条件“1688 不再成为主要淘汰原因”也未通过。

## 冻结基线

- 验收 commit：`ec731495453e184db6f95af5be575f749ebf52d2`
- SSL EOF 最小修复 commit：`c41c257ffdfc1909c92de2299321511f4e6694f9`
- transient cache 修复 commit：`ec731495453e184db6f95af5be575f749ebf52d2`
- run：`runs/flow_b/20260723_113000_ozon30m_v100`
- 正式窗口：2026-07-23 11:06:57.426 至 11:36:57.426（Asia/Shanghai），精确 1,800,000ms。
- Ozon 全局访问间隔：15,000ms；一个 supervisor、一个 browser profile owner。
- 1688 单次请求超时 5 秒，transport 最多重试 2 次，总预算 45 秒；TLS 证书验证保持开启。

## 1688 SSL EOF 根因与修复

生产 Python `requests.Session` 原先继承进程环境中的 HTTP/HTTPS/SOCKS 代理。经该链路访问 `h5api.m.1688.com` 时，TLS 握手被持续关闭；全新 session 的首次请求也能复现，因此不是失效 keep-alive、TLS session 复用、长期 worker 污染、并发或重试风暴。

最小修复只作用于 1688：设置 `Session.trust_env=False`，保留证书验证；transport 异常后销毁 session 并重建，执行有上限的指数退避和抖动；业务匹配失败不重试，不写入 0、默认价或虚假成本；transport 最终失败只进入可过期 deferred cache。

详细复现、修改前后对比和代码证据见 `docs/1688_ssl_eof_root_cause_and_acceptance_20260723.md`。

## 1688 专项验收：PASS

run：`runs/flow_b/20260723_111000_1688_repeatability_accept_v99`

| 指标 | 结果 | 门槛 |
|---|---:|---:|
| 唯一真实 SKU live 查询 | 30 | >=30 |
| 可靠成本 | 28/30，93.3% | >=90% |
| SSL EOF 最终失败 | 0/30，0% | <=5% |
| HTTP 请求 | 125/125 成功 | 无传输失败 |
| 平均重试 | 0 | 无重试风暴 |
| P50 / P95 | 1,008ms / 1,954ms | 记录项 |

两个失败 SKU 均被原有 `extreme price spread without strong main cluster` 规则拒绝，没有伪造成本。

## v100 连续 30 分钟完整验收

### 最终成功

| 指标 | 结果 |
|---|---:|
| 最终严格成功 | 6 个唯一 SKU |
| 实际速度 | 12 个/小时 |
| 提交 | 10 个唯一 SKU |
| 重复 SKU | 0 |
| 最低 / 最高利润率 | 36.2% / 126.02% |
| 成功店铺 | 丽丽二号（106637）：6 |
| runtime error | 0 |

严格成功 SKU：`1629780149`、`1907037466`、`1907037305`、`1907037500`、`1469569193`、`2137680315`。六个商品均为 `online_status=selling`、`stock=1`、`profit_rate>30`。

### 1688 运行表现

- 1688 stage 调用 35 次；26 个唯一 SKU 生成独立原始输出。
- 唯一输出中可靠成本 14、严格业务拒绝 12；SSL EOF 0、transport retry 0、session rebuild 0。
- stage P50 1,882ms、P95 3,397ms、平均 1,862ms。
- 最终淘汰：`1688-no-reliable-match` 15 次；`1688-health-deferred` 6 次，均有界延后后继续，不存在无限重试。
- 这证明 SSL/transport 修复在完整流水线中稳定，但当前候选与严格同品/价格簇规则的匹配通过率不足。

### 阶段耗时

| 阶段 | 数量 | P50 | P95 | 平均 |
|---|---:|---:|---:|---:|
| Ozon 详情/类目 | 37 | 170ms | 17,176ms | 1,558ms |
| 利润上界 | 37 | 185ms | 244ms | 193ms |
| 1688 成本 | 35 | 1,882ms | 3,397ms | 1,862ms |
| 利润计算 | 14 | 178ms | 206ms | 181ms |
| ERP 提交与确认调用 | 10 | 408ms | 688ms | 474ms |

### 淘汰与稳定性

- 候选采集尝试 79 次，采集请求失败 0；`non-pure-fbs` 淘汰 48。
- 流水线淘汰：`1688-no-reliable-match` 15、`profit_rate<=30` 3、`profit-upper-bound<=30` 2、`missing-shipping-mode` 1。
- Ozon 调度 started 105、succeeded 59、普通规则 failed 46；CAPTCHA 0、soft-block 0、browser crash/disconnect 0。
- 单 SKU 失败均被记录并跳过，supervisor 未崩溃。
- 正式窗口结束并写入摘要后，launcher 和唯一 browser owner 均正常退出；进程核对无残留。

## PASS 条件核对

| 条件 | 结果 |
|---|---|
| 连续运行满 30 分钟 | PASS |
| 最终确认成功 >=15 | **FAIL：6** |
| 最终速度 >=30/小时 | **FAIL：12/小时** |
| 利润率全部严格 >30% | PASS，最低 36.2% |
| 重复 SKU 0 | PASS |
| Ozon CAPTCHA / 软拦截 / 崩溃均为 0 | PASS |
| 1688 不再成为主要淘汰原因 | **FAIL：无可靠匹配 15 次，为最大流水线淘汰类** |
| supervisor、worker、browser owner 正常退出 | PASS |

## 回归测试与交付物

- Node：436/436 PASS。
- Python：13/13 PASS。
- 最终摘要：`runs/flow_b/20260723_113000_ozon30m_v100/acceptance_summary.json`
- 每阶段证据：同一 run 下的 `stage_timings.jsonl`、`source_yield.jsonl`、`ozon_access_timeline.jsonl`、`1688/` 和 checkpoints。
- 成功 SKU CSV：`exports/20260723_113000_ozon30m_v100_confirmed/confirmed_all_stores.csv`，并包含五店独立 CSV 与 `summary.json`。

本轮没有修改 Ozon 访问节奏、风控修复、利润公式/P70 口径、五店轮换或最终确认逻辑。
