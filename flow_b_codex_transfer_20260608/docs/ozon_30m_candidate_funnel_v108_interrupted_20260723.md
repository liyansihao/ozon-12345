# v108 正式 30 分钟窗口中断（2026-07-23）

## 结论

`NOT PASS / INTERRUPTED`。窗口从北京时间 14:56:57 开始，15:18:20 出现一次 Ozon soft-block，未连续运行满 30 分钟。统一访问 controller 在首次检测时立即写入 manual-stop 并终止 supervisor，没有继续探测。

本次中断不否定 v107 的 source checkpoint 性能结论，也不改变已经通过的 1688 SSL 修复；按用户指示充分冷却后，将保留现场并从新的完整 30 分钟窗口重新计算。

## 冻结信息

- commit：`eeeddf2083`
- run：`runs/flow_b/20260723_145500_ozon30m_v108`
- 原定窗口：`2026-07-23T06:56:57.684Z`—`2026-07-23T07:26:57.684Z`
- 中断：`2026-07-23T07:18:20.665Z`
- 连续运行：约 21 分 23 秒
- Ozon 全局间隔：15,000ms
- browser owner PID：26870
- 测试：Node 436/436、Python 13/13

## 中断前结果

- ERP/Ozon 最终严格确认：10 个唯一 SKU；
- 新鲜严格提交：4 个；
- source checkpoint 继续推进到新的 seller/page；
- Ozon CAPTCHA / 页面崩溃：0 / 0；
- soft-block：1；
- 1688 transport/SSL 致命错误：0；
- supervisor 和 browser owner 均已退出。

`FLOW_B_PENDING_STATE_SEED_FILES` 正常生效：前 10 个最终确认来自历史已提交状态的原单对账，v108 没有为这些 SKU 再写 `selected.jsonl`；因此 v107 发现的跨 run 重复提交问题已经被配置层恢复入口消除。

## 软拦截时间线

触发前所有操作均由单 owner 串行执行，仍保持 15 秒全局间隔：

1. 15:17:47 打开 SKU `2571585478`，15:17:49 成功；
2. 15:18:04 打开 SKU `3639887741`，15:18:05 成功；
3. 15:18:20 打开 SKU `4465087058`；
4. 15:18:20.665 检测 soft-block 并停止。

manual-stop 现场：

```json
{
  "requires_manual_clear": true,
  "updated_at": "2026-07-23T07:18:20.664Z",
  "last_kind": "favorite-detail",
  "last_url": "https://www.ozon.ru/product/retro-avtomobil-1-34-otkryvayushchiesya-dveri-4465087058/",
  "reason": "Ozon detail soft blocked: https://www.ozon.ru/product/retro-avtomobil-1-34-otkryvayushchiesya-dveri-4465087058/"
}
```

## 恢复动作

- 不更换 profile、IP 或代理；
- 不重复验证码；
- 不修改已验证的 Ozon 15 秒节奏；
- 冷却至少 10 分钟；
- 冷却结束后清除 manual-stop 审计位，启动新的 v108b 完整 30 分钟窗口；
- v108 的 `sku_states.jsonl` 进入 pending-state seed，4 个已提交 SKU 仅做原单对账；
- v108 的 `source_deep_scan.json` 作为下一窗口 checkpoint，避免重复扫描。
