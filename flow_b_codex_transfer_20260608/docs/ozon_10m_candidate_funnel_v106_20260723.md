# v106 cross-run terminal seed 小样中断（2026-07-23）

## 结论

`NOT PASS / INTERRUPTED`。v106 在北京时间 14:09:07 开始，14:11:40 出现一次 Ozon soft-block；统一访问控制立即写入 manual-stop，supervisor 和唯一 browser owner 随后退出。窗口未连续运行满 10 分钟，最终成功 0，不能用于速度判定。

## 冻结信息

- commit：`81aa22075c`
- run：`runs/flow_b/20260723_140700_ozon10m_v106`
- 原定窗口：`2026-07-23T06:09:07.765Z`—`2026-07-23T06:19:07.765Z`
- 实际中断：`2026-07-23T06:11:40.657Z`
- browser owner PID：`15115`
- Ozon 全局间隔：15,000ms
- 测试：Node 436/436、Python 13/13、`git diff --check` PASS

## 单变量

只在运行配置中把 v100–v105 的 `sku_states.jsonl` 和 `favorite_collection.jsonl` 加入现有 state seed：

- terminal `skipped/published` 和确定性 favorite rejection 被排除；
- `non-cny-sale-price` 与可恢复 page/network failure 仍可重试；
- 不复用历史价格或 pure-FBS 结论；
- v103 的单 tranche 配置保留，v104/v105 的无效变量均已撤销。

## 中断前证据

- 第一批三个 source 页面产生 0 个可处理候选，说明已知 SKU 被正确排除。
- 第二批产生 2 个唯一新候选：1 个 pure-FBS、1 个 non-pure-FBS。
- 与 v103/v104/v105 候选重叠为 0。
- 无提交、无最终成功；失败窗口不能判断本变量对最终速度的效果。
- CAPTCHA / 页面崩溃：0 / 0；soft-block：1。

触发前操作全部由统一 owner 串行执行：

1. 六个 source 页面分别成功；
2. 14:11:06 打开 SKU `3163626638`，成功；
3. 14:11:23 打开 SKU `3624946166`，业务判定 non-pure-FBS；
4. 两次完成之间间隔 16.677 秒；
5. 14:11:39 打开 SKU `4302531486`；
6. 14:11:40 检测 soft-block 并停止。

manual-stop 状态：

```json
{
  "requires_manual_clear": true,
  "stopped_at": "2026-07-23T06:11:40.657Z",
  "reason": "Ozon detail soft blocked: https://www.ozon.ru/product/pandora-sharm-gipoallergennyy-splav-4302531486/"
}
```

## 恢复条件

不自动清除 stop 状态、不自动重开 Ozon、不更换 profile/IP。人工确认同一 Ozon 账号正常且没有验证页后，才能清除 manual-stop 并重新开启一个完整的 10 分钟 v106b 窗口。
