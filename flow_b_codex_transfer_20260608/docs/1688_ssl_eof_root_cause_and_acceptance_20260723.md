# 1688 SSL EOF 根因与专项验收（2026-07-23）

## 结论

1688 SSL EOF 的直接根因是生产 Python `requests.Session` 默认继承了进程环境中的 `http`、`https`、`socks` 代理配置。经该通路访问多个 1688 主机时，TLS 握手被持续关闭；不是失效 keep-alive、TLS session 复用、四 worker 并发、重试风暴或长 worker 连接污染。

实际日志中的主机是 `h5api.m.1688.com`，不是 `b5api.m.1688.com`。

最小修复：

1. 仅在 1688 同步 session 中设置 `trust_env=False`，保持 TLS 证书验证开启并使用直接连接；不影响 Ozon 浏览器、ERP 或其他 HTTP 客户端。
2. 每个 HTTP 请求默认超时 5 秒。
3. 只对 SSL EOF、连接重置、DNS/超时等 transport 异常最多重试 2 次；每次销毁旧 session、创建新 session，使用 0.5 秒指数退避和最多 0.25 秒随机抖动，总重试预算 45 秒。
4. 价格簇、同品匹配、P70、利润和业务错误不重试；失败不会写入 0、默认价或虚假成本。

## v95 历史现场

run：`runs/flow_b/20260723_093300_ozon30m_v95`

- 1688 查询 30 次，可靠成本失败 28 次。
- 24 次 process code 1 的原始输出均在 `session-token-init` 访问 `https://h5api.m.1688.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/` 时发生 SSL EOF。
- v95 P50 2,773ms、P95 5,238ms。
- 当时代码中 Python worker、cost bridge code=1 和 requests adapter 的显式业务重试均为 0；不是重试风暴。
- 旧日志没有 worker identity/逐 HTTP 请求，因此 session 复用不能从旧记录臆测；代码证明 worker 遇到 exception 后将 session 置空。

补充历史时间线：`runs/flow_b/20260723_103700_1688_ssl_baseline_v96/inherit_worker_3/historical_v95_timeline.jsonl`

## 独立复现

诊断入口：`scripts/diagnose_1688_ssl.py`。它使用生产同步实现和当前可靠成本算法，仅记录 URL 路径、参数名、阶段、session ID、时长和结果，不记录代理值、Cookie、请求体或图片数据。

### 3 SKU 修改前复现

SKU：`2485449252`、`3330156278`、`3799335357`。

- 继承环境代理：0/3 可靠成本，3/3 SSL EOF；每个 SKU 都使用全新 session，首次 h5api 请求即 EOF。
- 三个 session 在 cookie bootstrap 阶段已累计出现 9 次额外 EOF。
- 禁用环境代理直接连接：2/3 可靠成本、SSL EOF 0；第三个 SKU 被原有价格簇规则严格拒绝。同一 session 连续完成三个查询，证明 keep-alive 本身没有污染。

证据：

- `runs/flow_b/20260723_103700_1688_ssl_baseline_v96/inherit_worker_3`
- `runs/flow_b/20260723_103700_1688_ssl_baseline_v96/direct_worker_3`

### 20 次修改前后对比

| 指标 | 修改前：继承代理 | 修改后：生产直接连接 |
|---|---:|---:|
| 查询数 | 20 | 20 |
| 可靠成本 | 0 | 13 |
| SSL EOF | 20 (100%) | 0 (0%) |
| P50 | 1,682ms | 1,108ms |
| P95 | 2,288ms | 2,550ms |
| 平均重试 | 0 | 0 |

修改后其余 7 次全部来自重复抽样的同一个价格簇不可靠 SKU，不是网络失败。

证据：

- `runs/flow_b/20260723_103700_1688_ssl_baseline_v96/inherit_worker_20`
- `runs/flow_b/20260723_103700_1688_ssl_baseline_v96/production_worker_20_after_v2`

## 专项验收

### 无筛选候选队列

v97 使用 v95/v94 保存的 31 个唯一候选 live 查询：SSL EOF 0、HTTP 失败 0、P50 1,024ms、P95 1,230ms；可靠成本 16/31。其余 15 个均为当前严格价格簇/同品规则拒绝，不是 transport failure。

v98 使用 30 个历史可靠候选 live 查询：SSL EOF 0、HTTP 失败 0、P50 1,042ms、P95 1,475ms；当前严格算法可靠成本 18/30。价格分布变化导致的拒绝仍按严格口径保留。

### 当前算法合格输入重复性验收：PASS

run：`runs/flow_b/20260723_111000_1688_repeatability_accept_v99`

- 30 个唯一真实 SKU，全部重新 live 查询，没有读取旧成本或生产缓存。
- 可靠成本 28/30，成功率 **93.3%**，达到 ≥90%。
- SSL EOF 0/30，最终失败率 **0%**，达到 ≤5%。
- 125 个 HTTP 请求全部成功；一个长期 session 完成全部查询，无连接污染。
- 总重试 0、平均重试 0；没有无限重试或重试风暴。
- P50 1,008ms、P95 1,954ms、平均 1,133ms。
- 两个失败 SKU `2949001543`、`3389057147` 均为 `extreme price spread without strong main cluster`，没有伪造成本。

因此 1688 SSL/transport 专项为 **PASS**。无筛选候选的价格簇通过率仍是独立的商品匹配质量问题，本轮没有放宽。

## 回归测试

- Node：433/433 PASS。
- Python：13/13 PASS。
- `git diff --check`：PASS。
- 新测试覆盖：不继承环境代理、默认请求超时、EOF 后销毁/重建 session、指数退避与抖动、重试上限、总预算、非 transport 错误不重试。

本修复没有修改 Ozon 访问控制、CAPTCHA/soft-block 策略、利润公式、P70 算法、五店轮换、状态持久化或最终确认逻辑。
