# Ozon 十店直接上架生产手册

磁盘阈值、校验归档、临时文件治理、恢复演练与数据库禁止在线裁剪的契约见 [OZON_STORAGE_RETENTION_RUNBOOK.md](./OZON_STORAGE_RETENTION_RUNBOOK.md)。

## 桌面控制面板（推荐）

桌面上的 `Ozon上品控制.app` 是现有生产控制脚本的原生 macOS 中文面板。双击即可查看和控制，不需要打开 Codex 或终端。它不会修改选品、1688 同款判断、利润率、店铺轮换、SKU 去重或生产状态数据库。

面板每 5 秒自动刷新，显示：

- 当前生产状态；
- 上海自然日当天 ERP 已接受数和当前 run 累计数；
- 后台已在线数；
- 当前店铺；
- supervisor、worker、browser/profile owner 数量；
- Chrome 页面标签数量（CDP 暂时不可用时显示 `—`）；
- 最后状态错误或说明。

四个按钮的含义：

- `启动/继续`：仅在状态为 `STOPPED` 且 supervisor、worker 都为 0 时启用。browser/profile owner 可以保留为 1，以复用登录状态；启动仍会执行全局 worker 去重检查，不会创建第二个 worker。
- `安全暂停`：确认后调用生产 `stop` 入口，并持续等待到状态变成 `STOPPED` 且 supervisor、worker 都为 0，才提示暂停完成。生产浏览器默认保留，不会因为暂停被关闭。
- `刷新状态`：只读刷新；操作执行期间点击会排队，不会并发启动第二条控制命令。
- `验证后恢复`：仅在 `WAITING_FOR_VERIFICATION` 时启用。必须先在系统保留的 Chrome 中手工完成验证码、MFA 或登录检查。

无限 direct 模式不再产生数量型 `TARGET_COMPLETE`。`FATAL_STOP` 不允许面板自动重启；验证码、安全检查和登录失效也不会被自动绕过。

## 安装或重装面板

在项目目录运行：

```sh
flow_b_codex_transfer_20260608/scripts/install_ozon_control_panel.sh
```

安装器使用系统 Swift 编译器生成原生 Apple Silicon 应用，进行本机临时签名并安装到：

```text
~/Desktop/Ozon上品控制.app
```

安装可重复执行。面板固定调用稳定部署软链接：

```text
~/.ozon-24h-production/app/scripts/ozon_24h_production.sh
```

因此只升级 stable 上架程序时不需要重新安装面板；若面板界面或状态字段本身升级，则重新运行安装器。面板不会设置开机自动上架，也不会监听任何公网或局域网端口。

## 终端备用命令

控制面板不可用时，CLI 始终保留：

```sh
~/.ozon-24h-production/app/scripts/ozon_24h_production.sh status
~/.ozon-24h-production/app/scripts/ozon_24h_production.sh start
~/.ozon-24h-production/app/scripts/ozon_24h_production.sh stop
~/.ozon-24h-production/app/scripts/ozon_24h_production.sh resume
```

命令说明：

- `status`：只读输出当前生产 JSON。
- `start`：安全恢复当前 `STOPPED` run；生产脚本会检查全局 worker，发现已有 worker 时拒绝重复启动。
- `stop`：写入持久停止请求，由 supervisor 在状态机边界停止 worker、保存状态并退出；browser owner 保留以复用登录状态。
- `resume`：只用于手工完成验证后恢复同一 run。

不要手工删除 `stop.request`、锁文件、run 目录、SQLite 幂等状态或浏览器 profile，也不要直接再开一个 Flow-B worker。

## 当前直接上架口径

生产不设置全局上架数量目标，会持续寻找并提交符合条件的不同 SKU，直到用户安全暂停、需要人工验证、登录失效，或十个店铺都被真实接口拒绝。ERP 接受后立即计入当天数量；`imported`、`online` 和 `stock_updated` 属于后台异步结果，不阻塞主链路。

面板主数字按 `Asia/Shanghai` 自然日统计 `erp_accepted.jsonl` 中的唯一 SKU。每天 00:00 自动从 0 重新计数，但历史记录和当前 run 累计数不会清空，也不会因此重启 worker。

系统保留以下关键条件：

- 至少 1 个标题、图片、规格和有效 SKU 价格可信的 1688 同款；
- 使用 Ozon 当前价与跟卖最低价中的较低值；
- 毛子 ERP 精确利润率必须严格大于 30%；
- SKU 级持久幂等，崩溃恢复后不重复提交已接受或请求状态不明的 SKU；
- 当前店铺上满或 ERP 真实返回店铺限额/不可用后，按已配置的十店顺序切换。

主要状态文件位于 `~/.ozon-24h-production/state/`：

- `current_run.json`：当前 run 指针；
- `operational_status.json`：运行、停止、恢复或等待验证状态；
- `process_owners.json`：唯一 supervisor、worker 和 browser/profile owner；
- `runs/<run_id>/current_store.json`：当前真实店铺；
- `runs/<run_id>/erp_accepted.jsonl`：ERP 已接受证据；
- `runs/<run_id>/background_status.jsonl`：导入、在线和补库存后台状态；
- 生产 SQLite：SKU 幂等和请求状态。

## CAPTCHA、MFA 和登录安全检查

当状态变为 `WAITING_FOR_VERIFICATION`：

1. 不要关闭系统保留的 Chrome。
2. 在该 Chrome 中手工完成验证码、滑块、MFA 或重新登录。
3. 完成后点击面板的 `验证后恢复`，或执行 CLI 的 `resume`。

系统不会实现任何验证绕过。若状态为 `FATAL_STOP`，先检查面板显示的错误，不要直接反复启动。

## 发布候选与稳定部署

日常生产和控制面板都只引用 stable。维护时使用：

```sh
scripts/ozon_24h_production.sh install-candidate
~/.ozon-24h-production/releases/candidate/scripts/ozon_24h_production.sh doctor-candidate
scripts/ozon_24h_production.sh promote
~/.ozon-24h-production/app/scripts/ozon_24h_production.sh doctor
```

提升 stable 不会改变当前生产状态根，也不会要求重装控制面板。

## 另一台电脑使用

当前面板只控制这台 Apple Silicon Mac，本机登录 profile 和完整生产状态仍留在这里。

- 另一台电脑只需控制当前 Mac：后续应通过私有 SSH/VPN 增加远程控制，不开放公网控制端口。
- 另一台 Mac 要独立运行：需要单独的迁移安装器，搬运浏览器、插件、登录 profile 和完整生产状态。
- 迁移前必须确认旧电脑的 supervisor、worker、profile owner 全部为 0；两台电脑禁止同时运行同一生产状态。
