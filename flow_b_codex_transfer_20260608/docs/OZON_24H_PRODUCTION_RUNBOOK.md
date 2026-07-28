# Ozon 五店 24 小时生产系统

## 每天启动

安装完成后，每天只运行：

```sh
~/.ozon-24h-production/app/scripts/ozon_24h_production.sh start
```

`start` 先创建 pending run，不会立即打开正式计时窗口。Supervisor 会只读核验五店 ERP 仓库和上海自然日剩余额度；五店映射全部严格匹配、额度均可验证且总剩余额度大于 0 后，把此刻 ERP 实时总剩余额度冻结为当天唯一目标，写入 `current_run.json`、`acceptance_window.json` 和 `frozen_manifest.json`，随后开始连续 24 小时生产。例如开窗时总剩余额度为 469，当天目标就是 469；系统不会等待固定的 481，也不会在窗口内因后续额度变化修改目标。总剩余额度为 0 时才进入 `WAITING_FOR_QUOTA_RESET`，到 ERP 提供的下一个重置点自动复查。

重复执行 `start` 会恢复当前 run，不会创建第二个 worker、Chrome profile 或重复窗口。

## 查看状态

```sh
~/.ozon-24h-production/app/scripts/ozon_24h_production.sh status
```

持久状态位于 `~/.ozon-24h-production/state/`：

- `current_run.json`：当前 pending/formal run；
- `operational_status.json`：运行、恢复、等待验证或等待额度状态；
- `process_owners.json`：唯一 supervisor、worker、Chrome profile owner；
- `capacity_preflight.json`：五店 ERP 仓库和当日剩余额度；
- `acceptance_window.json` / `frozen_manifest.json`：正式窗口和开窗时冻结的 ERP 容量目标；
- `sources/`：当前来源组合、来源漏斗和停用来源；
- `dedupe/published_links.csv`：跨历史窗口去重集合；
- `recovery.jsonl`：自动恢复记录；
- `runs/<run_id>/compact_checkpoint.json`：确定性 compact checkpoint；
- `exports/<run_id>/`：五店 CSV、汇总和 24 小时报告。

普通网络、429、页面失败、ERP 延迟、worker 退出和 CDP 短暂断开由 supervisor 按 30/60/120 秒退避恢复。每两小时自动刷新 compact checkpoint。

## 安全停止与恢复

安全停止：

```sh
~/.ozon-24h-production/app/scripts/ozon_24h_production.sh stop
```

恢复同一 checkpoint 和同一正式窗口：

```sh
~/.ozon-24h-production/app/scripts/ozon_24h_production.sh start
```

不要手工复制 run、清除 lock、启动第二个 Chrome profile，或删除 pending/去重状态。Stale supervisor lock 会由 supervisor 在确认原 PID 已不存在后自行清理。

## CAPTCHA、滑块、MFA 或登录安全检查

系统会保留 Chrome 和 checkpoint，并把状态改为 `WAITING_FOR_VERIFICATION`。在系统保留的 Chrome 窗口中手工完成验证；不得使用任何绕过方式。完成后运行：

```sh
~/.ozon-24h-production/app/scripts/ozon_24h_production.sh resume
```

系统从原 run 恢复，不重新提交已处理 SKU。

## 导出五店严格成功 SKU

窗口结束时会自动导出。也可随时手工刷新：

```sh
~/.ozon-24h-production/app/scripts/ozon_24h_production.sh export
```

输出目录为 `~/.ozon-24h-production/state/exports/<run_id>/`，包含五个 `confirmed_store_<store_id>.csv`、`confirmed_all_stores.csv`、`summary.json`，以及窗口结束后的 `24h_report.json`。只导出当前 run 内 `profit_rate > 30`、ERP/Ozon `online_status=selling` 且 `stock>0` 的唯一 SKU。

## 发布候选与回滚

日常生产只使用 stable：

```sh
~/.ozon-24h-production/app/scripts/ozon_24h_production.sh doctor
```

维护时先安装并诊断 candidate，再提升：

```sh
scripts/ozon_24h_production.sh install-candidate
~/.ozon-24h-production/releases/candidate/scripts/ozon_24h_production.sh doctor-candidate
scripts/ozon_24h_production.sh promote
```

提升时只保留 `stable`、`candidate` 和 `rollback` 三个运行版本。
