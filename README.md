# Ozon production automation

这是 Ozon 自动上品流水线的精简稳定仓库。`main` 只保留经过完整回归、可部署的生产版本；运行状态、浏览器配置、登录信息、日志、导出结果和依赖目录均不进入 Git。

稳定线以 2026-08-20 的生产快照 `733c191f9899d6720ad47717f1881b399ee2658d` 为基础，并合入了原工作区中已经配套测试的恢复、页面隔离、队列、1688 证据和审计加固。生产配置仍保持当前安全策略：10 个店铺、400g 路由、利润率严格大于 30%、POST 单次提交，实验性的审计货源自动发布默认关闭。

## 目录

- `flow_b_codex_transfer_20260608/scripts/`：运行、监督、恢复和维护脚本
- `flow_b_codex_transfer_20260608/config/`：可提交的生产配置模板
- `flow_b_codex_transfer_20260608/tests-js/`：Node.js 回归测试
- `flow_b_codex_transfer_20260608/tests/`：Python 回归测试
- `flow_b_codex_transfer_20260608/docs/`：运行手册和设计记录

## 验证

```bash
npm ci
npm run test:flow-b
npm run test:python
npm run test:control-panel
```

本次稳定封板通过 1,434 个 Node 测试、113 个 Python 测试和 7 个 Swift 控制面板测试。仓库不包含任何运行数据库、JSONL 日志、浏览器 Profile、历史导出或部署清单。

## 发布原则

1. 功能开发使用短生命周期分支。
2. 只有完整测试通过的提交才能进入 `main`。
3. 生产状态和凭据只保存在 `~/.ozon-24h-production/state`，不得提交。
4. 部署必须使用 `ozon_24h_production.sh` 的 candidate、doctor、promote 流程。
5. `config/ozon_24h_production.json` 是可审计配置，不包含登录凭据；真实凭据和状态始终留在本机生产状态目录。
