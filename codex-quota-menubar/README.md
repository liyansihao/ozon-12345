# Codex Quota

原生 macOS 菜单栏额度仪表盘，显示本机 Codex 的 5 小时与每周额度。

## 构建与运行

要求 macOS 13+ 和 Xcode Command Line Tools。

```bash
./scripts/build-app.sh
open "dist/Codex Quota.app"
```

## 数据与隐私

应用只在本机读取 `~/.codex/sessions/**/*.jsonl` 中的 `rate_limits` 字段，不调用模型、不消耗 Token、不请求网络，也不读取认证令牌。

## 没有数据显示

先在 Codex 中完成一次任务，等待任务生成新的额度记录，然后点击仪表盘中的“刷新”。
