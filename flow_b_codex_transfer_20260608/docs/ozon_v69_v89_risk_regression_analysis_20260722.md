# Ozon v69–v89 风控回归离线分析

生成时间：2026-07-22（Asia/Shanghai）
分析范围：阶段 1–3；未启动浏览器、未访问 Ozon、未修改运行代码或配置。

## 结论

1. 当前 supervisor、自动浏览器、CDP owner 和自动重试均为 0；v89 现场文件保持原位且未覆盖。
2. 保存下来的 v69 不能作为“无风控”的访问行为基线。v69 在 `2026-07-22T00:42:43.420Z` 至 `01:12:05.699Z` 的 29 分钟内记录了 87 次 source 页面完成事件，其中 85 次为 `Похоже, нет соединения / blocked_or_empty`；29 个批次按 3 页并发执行，60 秒窗口峰值 6 次。它没有详情请求，是因为 source 阶段已经被拦截。
3. 因此，v70–v89 中不存在“首次引入整个问题”的提交。v70 前该行为已经存在。最早能用 Git 证明的危险行为是：
   - `119e63ff3e6d6a0418773a14a8b49c508d93ea80`（2026-07-17，`Keep source discovery active during detail cooldowns`）：把冷却期由等待改为继续扫描 source、只是不做详情收藏。
   - `d15eb1b9027255b0cd5037867f2f93f03a4b3570`（2026-07-17，`Quiet Ozon scans when candidate backlog is full`）：只有 backlog 已满或冷却仅剩 90 秒以内才静默；10 分钟冷却的大部分时间仍允许 source 扫描。
4. v75 是保存日志中首次出现详情页软拦截的版本，不是首次引入代码的版本。v75 在约 84 分钟内记录 174 次 source 页面完成事件和 246 次详情完成事件，合计 420 次，滚动 60 秒峰值 21 次；随后出现 5 次详情软拦截和 14 次 source 拦截。
5. v74 的 CDP attach 是放大器而非根因：它把此前 Playwright 启动浏览器立即出现 403 的状态，换成可正常读页面的外部 CFT 150 + CDP，使既有的 3 页 source 并发、3 页详情 worker 和 4 秒详情启动间隔真正产生高流量。v74 自身 14 次详情无拦截；v75 才在持续流量后出现详情拦截。
6. 第二个高可信放大器是“冷却状态按 run 保存”。`collection_pacing.json` 位于每个 run 目录，新建 vXX 会从空状态开始；跨 run 种子又明确允许软拦截这种 transient failure 再试。日志证明相同 SKU 被多个版本反复访问，例如 `4054003599` 出现在 v81、v82、v83、v89，`3288829441` 出现在 v75、v78、v81、v82。
7. v79/v80 将详情间隔提高到 15 秒后暂时无详情拦截；但 v81 以后短 run 重新从空冷却状态启动，风险再次快速显现。v85 将 favorite worker 降为 1、v86 关闭 source prefetch、v89 换新 profile 均未消除拦截，分别排除了“仅详情 worker 数”“仅 prefetch”“仅旧 profile”作为单一根因。

## 阶段 1：现场冻结

### 进程状态

- `ps` 审计：无 `run_acceptance_supervised`、`flow_b_playwright`、1688 worker、CDP browser 或 v89 profile owner。
- `launchctl` 审计：无 Ozon/Codex supervisor service。
- 未启动任何只读页面预检；当前账号/IP 不再被自动探测。

### v89 现场

- run：`/Users/mac/.ozon-24h-acceptance-v70/flow_b_codex_transfer_20260608/runs/flow_b/20260722_230308_ozon10m_sample_v89`
- commit：`372932c8271b0c5461ab8cae521263cb101f7c37`
- launcher PID（历史）：`86311`
- launcher 启动：`2026-07-22T15:07:19.371Z`
- 验收窗口开始：`2026-07-22T15:07:24.728Z`
- profile：`playwright_profile_v2`
- CFT：`150.0.7871.129`
- CDP：`http://127.0.0.1:9223`
- worker：source `3`（最大 `4`），favorite `3`
- 详情间隔：`15000ms`；详情 retries：`0`；详情 timeout：`8000ms`
- checkpoint SHA-256：`89032ad6786b6922a9f3f70dedf9e455ad53c2e003e570d2e5ea2f9198b2e2b1`
- `favorite_collection.jsonl` SHA-256：`03ef8d98aa02bb298292ea580768105b3dad4cf9a7cd3e3f626c3f81c5039566`
- `collection_pacing.json` SHA-256：`974a0e5d162daad90373d929d1fb64cc474588be948d7a362bb8b93d93816d6c`
- `frozen_environment.json` SHA-256：`f03faec579c749b3671ac3e89587d5c56da60486aab19386bcd079a2999df3be`
- `launch.sh` SHA-256：`fad2411878b933f6f742f724a17cfb8bcfba1ab07083c8abc63e29da4c2473d7`

v89 详情时间线：

| UTC 时间 | SKU | 结果 | 与上条间隔 |
|---|---:|---|---:|
| 15:07:37.115 | 3965913672 | 正常返回，non-pure-FBS | — |
| 15:07:50.543 | 4465087058 | detail soft-block | 13.428s |
| 15:08:51.204 | 3088680423 | detail soft-block | 60.661s |
| 15:12:21.642 | 4054003599 | detail soft-block | 210.438s |

第一次拦截后代码没有详情重试，但后续 worker/队列在 60 秒、180 秒冷却到期后继续探测；第三次后写入 10 分钟冷却。用户停止后未再访问。

## 阶段 2：v69 与 v89 行为差异

### v69 证据限制

v69 精确 commit 为 `cb759b288f413fa2bc95d665a21cecdbc44d769b`，原 run 为 `20260722_083225_ozon24h_stability_v69`，现场因外部 worktree 清理而作废，幸存证据位于：

`/Users/mac/.codex/ozon-stability-archive/20260722_v69_interrupted`

v69 的 launcher、完整 frozen environment 和大部分 profile 已丢失，因此其精确浏览器版本、UA、完整 headers 不能从现场证明。v62 launcher 与 v70 launcher表明业务配置意图保持 3/4 source workers、3 favorite workers、4 秒详情间隔、0 详情重试；但报告不把这种继承关系冒充 v69 的完整环境证据。

### 行为表

| 行为指标 | v69 | 首次变化版本 | v89 | 风控风险 |
|---|---:|---:|---:|---|
| 代码 commit | `cb759b288f` | v70 `13b2ecea64` 仅改持久去重历史 | `372932c827` | v70–v89 的普通业务提交不是首次根因 |
| 浏览器控制 | `launchPersistentContext`（由 commit 代码证明） | v74 `2b33ad38d5` 改为外部浏览器 + CDP attach | 外部 CFT + CDP | 所有权模式改变；能避开当时 Playwright 启动即 403，但使既有高流量实际跑起来 |
| 浏览器版本 / UA | 精确值已随现场丢失；未设置自定义 UA | v74 明确改 CFT `150.0.7871.129`；v87 短暂改系统 Chrome但鉴权失败 | CFT `150.0.7871.129`；无自定义 UA | 有正常版本变化证据，无 headers/UA 伪装证据；不能单独解释 v89 新 profile 仍拦截 |
| profile | 原 worktree `playwright_setup/playwright_profile`（历史会话证据） | v70 复制到 durable runtime；v89 改 `profile_v2` | fresh `profile_v2` | v89 仍 3/4 拦截，排除旧 profile 单因 |
| context 数 | 1 persistent context | v74 改为连接默认 CDP context | 1 默认 CDP context | context 数未增加 |
| Ozon 页面 owner | 单 browser owner，但 source/favorite/publish 可共享 context | v74 后 owner 外置；页面并发未收敛 | 单 browser owner，但非单 Ozon page owner | “一个进程 owner”不等于“一个 Ozon 请求 owner” |
| source 页面并发 | 实测每批 3 个同 timestamp；87 次中 85 次被拦 | v76 low-token 一度提高到 4；v85 favorite=1 不影响 source=3 | 配置 3、最大 4 | 软拦截时批量产生 3 个后续请求 |
| favorite 详情 worker | 配置意图 3 | v76 low-token 一度 4；v85 试为 1 | 3 | 详情 gate 只限制启动间隔，仍可有多页 in-flight |
| 详情启动间隔 | 配置意图 4s | v79 提到 15s，并由 `331d74e490` 防止 low-token 降回 4s | 15s | v79/v80 无详情拦截，说明降速有效；但不是全局限速 |
| 详情 retries | 0 | 无 | 0 | 单 SKU 不重试；但其他 worker、source 和后续 run 仍会请求 |
| soft-block 冷却 | 1m/3m/10m；v69 最终 streak=6、10m | v77 `7f67943548` 扩大 exact access-denied 的识别范围 | 1m/3m/10m | 识别改善，但不是全局 stop latch |
| 冷却期间 source | v69 实测继续：29 批、P50 批间隔 52.098s | 该行为实际由 v69 前 `119e63ff3e` 引入，`d15eb1b902` 仅部分静默 | 当前代码仍允许长冷却期间 source 扫描 | **最高风险：已知拦截后继续向 Ozon 发请求** |
| source prefetch | 默认开启；仅在当前 batch 被判 blocked 后禁止下一批 prefetch | v86 关闭，v87/当前又恢复默认 | 开启 | v86 仍 3/5 detail 拦截，非单一根因；但应纳入统一 owner |
| source 页面复用 | 复用 page pool | v74 仅改变 context 获取方式 | 复用 page pool | 少建页但会在同一页高频 goto；没有统一全局节奏 |
| publish Ozon detail pool | 与 producer 共用 context，理论初始 8/最大 12；有可复用 collection facts 时通常不导航 | v70–v89 无相关改动 | 同左 | 潜在并发旁路；阶段日志约 0.2s 表明 v75 多数复用了 facts，但当前没有统一 owner 保证 |
| 1688 worker | 独立 Python worker，不使用 Ozon Playwright page | 无 Ozon browser 争用变化 | 独立 | 不直接增加 Ozon 页面访问 |
| producer / consumer | 同时运行，共用 browser context | v70–v89 无结构变化 | 同左 | source 与 publish detail 可能合计突破各自局部限速 |
| pacing 状态范围 | `run/collection_pacing.json` | 每个 vXX 新 run 从新文件开始 | v89 新文件 | 跨 run 不继承账号/IP 冷却，短样会清零 streak |
| transient SKU 跨 run | soft-block 不计入终态排除，可再发现 | v70–v89 无修复 | 相同 SKU 多版本重复探测 | 不是上架重复，但会重复触发风控 |
| source 访问量 | 87/29.37min，85 blocked；峰值 6/60s | v74 恢复可读；v75 放大 | v89 未形成 source checkpoint | v69 已证明基线当时不健康 |
| detail 访问量 | 0（source 已被拦） | v74 14/47s 无 block；v75 246 次、5 block | 4 次、3 block | v75 是首个详情拦截证据，不是首次代码引入 |
| source+detail 峰值 | source 峰值 6/60s | v75 合计峰值 21/60s | 详情峰值 2/60s，账号已处高风险 | v75 的持续/突发量是明显放大事件 |

### 版本日志摘要

详情数为 `favorited`、`non-pure-fbs` 和明确 soft-block 的完成事件代理；它是完成时间而非网络请求开始时间。source 数来自 `source_deep_scan.json`。

| 版本 | commit / 关键配置 | detail（block） | source（block） | 结论 |
|---|---|---:|---:|---|
| v69 | `cb759b288f`；persistent | 0 (0) | 87 (85) | requested baseline 已处 source 网络拦截 |
| v70–v72 | `13b2ecea64`；persistent CFT149 | 0 | 无完整正式流量 | v70 独立预检已 HTTP 403 |
| v73 | `13b2ecea64`；persistent | 0 | 27 (27) | Playwright 启动路径继续全拦 |
| v74 | `2b33ad38d5`；CDP CFT150、4s、3 workers | 14 (0) | 0 | CDP 恢复可读，开始承载高频访问 |
| v75 | `6621382820`；CDP、4s、3 workers | 246 (5) | 174 (14) | **首个详情 soft-block 版本；420 次合计访问，峰值 21/60s** |
| v76 | `ecdf7a0550`；low-token 一度 4 workers | 62 (0) | 126 (0) | 持续加压但该窗口无 block |
| v77 | `7f67943548` | 1 (1) | 10 (0) | 首个商品即拦截，风险已抬高 |
| v78 | `7f67943548` | 10 (3) | 10 (0) | 再次进入 1m/3m/10m 模式 |
| v79 | `331d74e490`；15s | 44 (0) | 0 | 降速后暂时稳定 |
| v80 | `1e647ea61e`；15s | 15 (0) | 0 | 暂时稳定 |
| v81 | `2868727621`；15s | 4 (3) | 0 | 新 run 冷却清零后再次高频拦截 |
| v82 | 同 v81 | 4 (3) | 0 | 重复相同模式/SKU |
| v83 | 同 v81 | 7 (3) | 0 | 重复相同模式/SKU |
| v84 | 同 v81 | 5 (3) | 0 | 重复相同模式/SKU |
| v85 | favorite worker=1 | 2 (2) | 18 (15) | 单详情 worker 仍拦；随后 source 继续访问并大面积被拦 |
| v86 | `44002d3202`；source prefetch=0 | 5 (3) | 0 | 关闭 prefetch 仍拦，排除单因 |
| v87 | 系统 Chrome | 0 | 0 | 扩展鉴权失败，无风控判别价值 |
| v88 | CFT150、原 profile | 4 (2) | 0 | 仍拦 |
| v89 | CFT150、fresh profile | 4 (3) | 0 | profile 更换无效 |

## 阶段 3：Git bisect 式定位

### 最早回归范围

以保存日志为准，bad 边界必须向 v69 前移动：

- `119e63ff3e^`：详情冷却时会 `waitForMovingDeadline(...)` 并返回，不继续 source 扫描。
- `119e63ff3e`：删除等待/返回路径，改为 cooldown 期间继续 source discovery、collection queue-only。
- `d15eb1b902`：增加 `shouldScanSourcesDuringDetailCooldown`，但逻辑在 `remaining > quietWindow` 且 backlog 未满时返回 true；10 分钟冷却的大部分时间仍继续扫。
- v69 `cb759b288f` 包含上述两个提交；v69 日志 85/87 blocked 直接验证 bad 行为。

所以“首次引入继续探测”是 `119e63ff3e`，最小代码范围是 `source-scanner.mjs` 中：

- 冷却入口从等待并 return 改为 queue-only 后继续扫描；
- source 主循环在冷却期间调用 `shouldScanSourcesDuringDetailCooldown`；
- `shouldScanSourcesDuringDetailCooldown` 对长冷却返回 true。

当前对应代码位置：

- `scripts/flow_b_playwright/source-scanner.mjs:392-403`
- `scripts/flow_b_playwright/source-scanner.mjs:3247-3260`

### 高可信嫌疑改动

#### 1. `119e63ff3e`：冷却期间继续 source discovery（置信度：高）

- 改动：移除冷却时等待并退出，改为继续 source 页面扫描，只把详情收藏改成 queue-only。
- 风险：Ozon 对 source 页和详情页看到的是同一账号/IP/browser 的请求；详情冷却并未真正停止 Ozon 流量。
- 日志：v69 进入 10 分钟 cooldown 后仍完成 29 个三页批次，85/87 source blocked；v85 两个详情 block 后又记录 18 个 source，其中 15 个 blocked。
- 单独关闭方式：任何 `remainingCollectionCooldown > 0` 都禁止 source/page navigation；仅允许无 Ozon 网络的 ERP/1688/本地队列工作。

#### 2. run-local pacing + transient soft-block 跨 run 可重试（置信度：高）

- 改动：`bb6b748572` 把 pacing 持久化到 `path.dirname(outputPath)/collection_pacing.json`，只保证同一 run 重启恢复；`ad0fdbcdce` 的跨 run 排除规则明确保留 transient soft-block 为可重试。
- 风险：每次创建 vXX 都清零 block streak/blocked-until；同一失败 SKU 被再次发现并访问。
- 日志：`4054003599` 在 v81/v82/v83/v89，`3288829441` 在 v75/v78/v81/v82，`4798408844` 在 v83/v84/v85 重复触发。
- 单独关闭方式：把 Ozon 风控冷却/停止 latch 放到 profile/account 级持久状态，不随 run 新建而清空；soft-block SKU 在人工解除前不得跨 run 再试。

#### 3. v74 `2b33ad38d5` + v75 `6621382820`：CDP/CFT 页面生命周期改变（置信度：中，放大器）

- 改动：v74 从 `launchPersistentContext` 改成连接外部正常启动的 CFT 默认 context；v75 增加扩展 popup 唤醒与 CDP 恢复。
- 风险：浏览器从“启动即 403”变为可正常读页，既有的 3-page source、3-page detail 和 4 秒 detail gate 才能持续执行；外部 context 中页面生命周期也不再由单个 Playwright child 独占。
- 日志：v73 source 27/27 blocked；v74 只读 probe HTTP 200、14 个 detail 无 block；v75 累计 420 次后首次 detail block。
- 单独回退方式：不需整仓回退 CDP；保留已验证登录方式，只在统一 Ozon scheduler 下给 context 一个页面 owner。CDP 本身没有被证实为首因。

#### 4. 3/4 worker + 4 秒局部 gate + producer/consumer 共 context（置信度：中，负载放大器）

- 改动：worker 设计早于 v69；v76 low-token 可把 source/favorite 提到 4。详情 gate 只串行“预约启动时间”，会创建 3 个 worker pages；publish detail provider 另有 8/12 page pool，producer 与 consumer 同时运行。
- 风险：多个局部模块各自“安全”，合计并不受一个全局 owner/速率限制。一个 block 被某页面识别前，其他 in-flight 页面可能已导航。
- 日志：v75 合计峰值 21/60s；v76 low-token 明确写入 4 workers。v85 favorite=1 仍 block，说明它不是当前风险状态的单一原因。
- 单独关闭方式：所有 `www.ozon.ru` navigation 进入同一 scheduler，in-flight=1；source/favorite/publish detail 不再各自拥有页面并发。

### 被证据降低优先级的假设

- 旧 profile 单独损坏：v89 fresh profile 仍 3/4 block。
- source prefetch 单独导致：v86 prefetch=0 仍 3/5 block。
- favorite worker 数单独导致：v85 favorite=1 仍连续 block，且 source 随后继续大面积 blocked。
- v81 seller demotion commit 单独导致：只改变 source 排序，不改变限速；同一 SKU 跨多个版本重复 block 更符合持久风险 + run reset。
- UA/headers 伪装变化：未发现自定义 UA、额外 Ozon headers 或指纹伪装代码。v69 精确 UA 因现场丢失无法证明，不能据此下结论。

## 阶段 4：最小修复（2026-07-23）

修复只改 Ozon 访问控制，没有回退利润、五店轮换、发布状态、最终确认或浏览器恢复：

1. 新增 `ozon-access-controller.mjs`，source、favorite detail、publish detail 共用一个串行 scheduler，默认全局启动间隔为 15 秒，in-flight 上限为 1。
2. 任一操作检测到 soft-block、captcha、access denied、incident 或 `Похоже, нет соединения`，立即写入 profile 父目录的 `ozon_access_state.json`；`requires_manual_clear=true` 后，当前排队任务和后续 run 都拒绝导航。
3. `remainingCollectionCooldown > 0` 时 source scanner 停止所有 source 扫描，不再以 backlog 不足为理由继续访问。
4. source 页排队等待不再计入页面执行 timeout，避免调用方超时返回后，队列中的旧请求仍然继续导航。
5. 可通过 `FLOW_B_OZON_ACCESS_LOG` 写出逐操作 JSONL 时间线，记录 started/succeeded/failed/stopped，供受控验证核验间隔和停止边界。
6. `FLOW_B_OZON_ACCESS_STOPPED` 被 supervisor 视为致命安全停止，不能按普通单 SKU 失败继续运行或自动重启探测。

离线验证：

- Ozon 访问控制相关针对性测试：204/204 通过。
- 完整 Node 测试：428/428 通过。
- Python 测试：8/8 通过。
- `git diff --check`：通过。

本节完成时尚未启动浏览器；3 商品、10 分钟和 30 分钟验证结果需以新的 run 证据追加，不能由离线测试推断。

## 阶段 5：第一次受控验证失败与新增根因（2026-07-23）

用户授权继续后，以 commit `d7e3392de577c67afc6931213aba3f5c2770d2f0` 启动 3 商品只读验证。结果严格判定失败，未进入 10 分钟和 30 分钟阶段：

- 首页只读预检正常。
- SKU `3088016074` 正常，明确读到 FBS。
- SKU `1907037527` 在前一受控操作开始后 15.002 秒启动，309ms 内返回 `Похоже, нет соединения`；统一控制器立即写入 `requires_manual_clear=true` 并停止。
- 第 3 个 SKU 从未执行；进程复核为 0。

随后对已关闭浏览器的 History、Preferences 和 Sessions 进行离线取证，发现该窗口并非纯粹的 15 秒单流量：

1. CFT 在 `00:14:32Z` 启动后自动恢复上一会话的 13 个标签页；Preferences 的 `sessions.event_log` 明确记录 `restore_browser=true, tab_count=13`。
2. 在统一控制器第一次操作 `00:14:54.414Z` 前，History 已记录至少 6 个 Ozon 页面在 `00:14:33Z`–`00:14:40Z` 被自动重载，包括 3 个旧软拦截商品、2 个 seller/search 页面和 1 个 `captchaDone=true` 商品页。
3. 这些恢复导航的 History transition 为 `805306376`，与后续受控 `page.goto` 的 transition 不同，证明它们来自浏览器会话恢复而非 v90 脚本队列。
4. 因此，阶段 4 的 scheduler 已正确约束脚本主动导航，但 CDP 浏览器启动前的 session restore 是一个旁路；它在 scheduler 接管前制造突发访问，足以污染随后第 2 个商品的判别。

这使 v74 `2b33ad38d5` 的角色从“中等置信放大器”提升为“已实测的启动旁路”：外置 CDP profile 会保存并在下次启动恢复旧 Ozon tabs，而旧 launcher 没有在浏览器启动前隔离 Sessions。

第二个最小修复采用可恢复归档，不删除登录态：

- 新增 `prepare_cdp_profile.mjs`，只把 automation profile 的 `Default/Sessions/Session_*` 和 `Tabs_*` 移到当前 run 的 `profile_session_archive/`，保留 Cookies、Local Storage、扩展配置、History 和所有业务状态。
- 每个归档文件记录大小和 SHA-256，并写入 `profile_session_archive.json`。
- 新 launcher 必须在启动 CFT 前执行该 guard；旧 Sessions 有备份，可人工还原。
- 离线测试证明 restorable tabs 被归档，Cookies 和无关文件保持字节不变。
- 修复后完整 Node 测试 429/429、Python 测试 8/8 通过，`git diff --check` 通过。

本轮已经出现一次软拦截，所以持久停机锁不在离线修复中清除，也不自动再次验证。只有人工确认 Ozon 已恢复后，才可在归档旧 Sessions 的前提下重新开始首页 → 3 商品完整阶段。

## 阶段 6：干净启动通过、10 分钟小样失败与第二次最小修复（2026-07-23）

用户完成人工验证后，以 commit `3e686e5039aa9de3a1ea64eecf1a5e8b5f879a79` 重新验证。启动前归档 4 个 Session/Tab 文件；CFT 启动时只有 `about:blank`，History 中没有 scheduler 接管前的 Ozon 访问，证明阶段 5 的 session restore 旁路已消除。

### 3 商品受控验证：PASS

run：`runs/flow_b/20260723_083111_ozon3item_v91`

- 首页只读预检正常。
- SKU `3088016074`、`1907037527`、`3773926959` 均成功读取为 FBS。
- 四次受控操作（首页 + 3 个详情）的启动间隔分别为 15.002、15.003、15.001 秒。
- 全程无验证码、软拦截和强制验证，统一停机锁保持 `requires_manual_clear=false`。

### 10 分钟真实小样：NOT PASS

run：`runs/flow_b/20260723_083500_ozon10m_v92`

- 前 6 次 source 操作成功；第 7 次 favorite detail（SKU `3740125372`）成功并确认 FBS。
- 第 8 次 Ozon 操作、第二个 favorite detail（SKU `3094196585`）在 `2026-07-23T00:38:43.867Z` 触发软拦截。
- 控制器在该操作开始后 313ms 内写入 `requires_manual_clear=true`，没有继续发起 Ozon 请求。
- 本轮仅产生 1 个 favorite，ERP/Ozon 最终严格确认数为 0；因此没有启动 30 分钟验收，不能据此计算达标速度。

时间线暴露出统一调度器的第二个精确缺陷：它原先只保证“相邻开始时间”至少 15 秒，而不保证“页面完成后”有完整静默间隔。第三次 source 操作从 `00:37:20.916Z` 持续到 `00:37:43.545Z`，下一次 source 在 `00:37:43.552Z` 启动，完成到下一次开始仅 7ms。虽然 in-flight 始终为 1，长页面操作仍会把后续请求贴在完成边界，形成浏览器侧连续导航。

软拦截后主流程正确判定致命停止，但 producer 的长生命周期任务和发布 session 没有在 fatal 路径统一收尾，导致 Node/browser 进程需要人工终止。这不造成额外 Ozon 导航，但违反自动安全停机要求。

第二次最小修复仅针对这两个已复现问题：

1. `ozon-access-controller.mjs` 在每次成功或普通失败操作完成后持久化 `last_completed_at`，并把 `next_allowed_at_ms` 推迟到“完成时间 + 15 秒”；soft-block 仍立即锁停，不再等待。
2. `continuous-runtime.mjs` 增加统一 `finally` 收尾器；acceptance 无论正常返回还是 fatal，都等待 producer 结束并关闭长生命周期发布 session。
3. 新测试先复现 completion quiet gap 和 fatal cleanup，修改后针对性测试 197/197、完整 Node 测试 430/430、Python 测试 8/8 全部通过，`git diff --check` 通过。

按受控验证规则，本轮一旦出现 soft-block 即判定失败。新修复没有在当前风险状态下自动重测；profile 级停机锁继续保留，等待下一次人工验证后从 3 商品阶段重新开始。

## 阶段 7：验证码等待后单次重开策略（2026-07-23）

根据操作员的新规则，将明确验证码从网络软拦截和访问限制中独立分类：

1. 检测到 CAPTCHA、俄文人机确认或中文人机验证后，统一调度器立即冻结全部 Ozon 队列，默认等待 10 分钟。
2. 冷却结束后只重新打开同一 URL 一次，不自动点击、填写或绕过验证码。
3. 单次重开成功则恢复流水线；再次出现验证码、访问限制或其他软拦截时，写入 profile 级人工锁并停止，不循环重试。
4. 冷却期间持久化 `requires_manual_clear=true` 和 `captcha_retry_pending=true`；若进程崩溃或重启，不会由另一个 owner 越过等待状态。
5. 等待和重开记录为 `captcha_wait`、`captcha_reopened` 时间线事件；等待时长可由 `FLOW_B_OZON_CAPTCHA_REOPEN_DELAY_MS` 显式配置，生产默认值为 600000ms。

回归结果：验证码分类、单次重开、重复验证码人工锁停、source/favorite/publish 三条详情路径的相关定向测试 186/186 通过；完整 Node 测试 433/433、Python 测试 8/8、`git diff --check` 全部通过。当前 v92 停机原因是 `Похоже, нет соединения` 网络软拦截，不是验证码，所以本次代码变更没有清除现有锁或启动真实 Ozon 请求。

## 证据路径

- v69 现场：`/Users/mac/.codex/ozon-stability-archive/20260722_v69_interrupted`
- v69 source：`/Users/mac/.codex/ozon-stability-archive/20260722_v69_interrupted/source_deep_scan.json`
- v69 pacing：`/Users/mac/.codex/ozon-stability-archive/20260722_v69_interrupted/collection_pacing.json`
- v74 baseline：`/Users/mac/.ozon-24h-acceptance-v70/flow_b_codex_transfer_20260608/runs/flow_b/20260722_132400_ozon24h_stability_v74/frozen_baseline.json`
- v75 run：`/Users/mac/.ozon-24h-acceptance-v70/flow_b_codex_transfer_20260608/runs/flow_b/20260722_135200_ozon24h_stability_v75`
- v85 run：`/Users/mac/.ozon-24h-acceptance-v70/flow_b_codex_transfer_20260608/runs/flow_b/20260722_215500_ozon10m_sample_v85`
- v89 run：`/Users/mac/.ozon-24h-acceptance-v70/flow_b_codex_transfer_20260608/runs/flow_b/20260722_230308_ozon10m_sample_v89`
- v90 3 商品失败证据：`runs/flow_b/20260723_081240_ozon3item_v90`
- v90 Ozon 时间线：`runs/flow_b/20260723_081240_ozon3item_v90/ozon_access_timeline.jsonl`
- v90 结果：`runs/flow_b/20260723_081240_ozon3item_v90/three_item_result.json`
- v91 3 商品 PASS：`runs/flow_b/20260723_083111_ozon3item_v91/three_item_result.json`
- v91 Ozon 时间线：`runs/flow_b/20260723_083111_ozon3item_v91/ozon_access_timeline.jsonl`
- v92 10 分钟失败现场：`runs/flow_b/20260723_083500_ozon10m_v92`
- v92 Ozon 时间线：`runs/flow_b/20260723_083500_ozon10m_v92/ozon_access_timeline.jsonl`
- v92 fatal 日志：`runs/flow_b/20260723_083500_ozon10m_v92/runtime_errors.jsonl`
- 当前 cooldown 分支：`flow_b_codex_transfer_20260608/scripts/flow_b_playwright/source-scanner.mjs`
- CDP 分支：`flow_b_codex_transfer_20260608/scripts/flow_b_playwright/browser-context.mjs`
- 跨 run transient retry 测试：`flow_b_codex_transfer_20260608/tests-js/source-scanner.test.mjs`
