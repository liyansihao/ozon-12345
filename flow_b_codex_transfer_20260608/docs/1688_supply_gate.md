# 1688 上架前可采购硬门槛

## 上架许可

新商品只有同时满足以下条件才可以进入 ERP 提交：

1. 1688 图片召回返回已签名的 v3 同款证据，且匹配类型为 `strong_single` 或 `corroborated_multi`。证据可以走“精确规格”或 `image_primary_v1` 图片同款通道。
2. 最多检查三个与该同款证据绑定的 1688 offer。
3. 详情页在线。图片通道以“主体是否为同一件商品”为主证据；规格缺失、轻微尺寸/功率/材质/包装差异只记录，不单独拒绝。明确的错颜色、错型号/接口/灯头数、主件与配件颠倒、商品类型不同仍是硬冲突。
4. 多 SKU 页面必须把数量 1、价格和库存绑定到同一个已选行；不允许默认第一行、用其他颜色的库存兜底，或把库存数字拼进价格。暂不支持多件套装的自动采购倍数换算。
5. `MOQ <= 1`、已选 SKU 有货、数量 1 可购买且购买控件有效。验证过程不会加购、下单或支付。
6. 采购成本取 `max(P70/P80 估算成本, 详情页一件实时价)`，按该成本计算后的利润率必须严格大于 30%。
7. `SupplyEvidenceV1` 在 ERP POST 前仍未过期。证据有效期最长 30 分钟；过期会复检，价格变化会在同一次提交前按新价重算利润和提交价格，利润不再严格大于 30% 时禁止 POST；无法安全重算则延后，不能沿用旧利润。

登录失效会抛出 `SUPPLY_GATE_AUTH_REQUIRED` 并安全关闭整条新增上架通道。验证码、导航错误和超时按 1 分钟、10 分钟间隔重试；仍无法确认时只延后该候选，不删除收藏，也不永久封禁整个 Ozon SKU。

## 首次登录

使用生产将采用的 Playwright profile：

```bash
npm run flow:b:setup
```

在打开的窗口中完成 Ozon、Maozi 和 1688 登录，并确认任意 1688 商品详情页可以正常打开。脚本不会自动填写账号、验证码或执行采购动作。

## 100 个候选的 validation-only 验收

```bash
npm run flow:b:validate-supply -- /absolute/path/to/validation-run
```

该命令至少验证 100 个候选，不调用 ERP 发布、不删除收藏，也不使用生产运行数据库。结果在运行目录的 `validation_gate.jsonl` 和 `supply_gate.jsonl`。正式启用前需人工抽查通过项，要求同款准确率不低于 95%，且抽查时全部能按目标规格购买 1 件。

## 现有在线商品只读审计

```bash
npm run flow:b:audit-supply -- /absolute/path/to/audit-output
```

审计只读取 Maozi 在线商品、运行库历史和 1688 页面，不写 Ozon、不改库存、不下架，也不扩大黑名单。它会生成：

- `online_supply_audit.csv`
- `online_supply_audit.json`
- `online_supply_audit_summary.json`
- `online_supply_audit_checkpoint.jsonl`

检查点支持中断恢复；通过证据过期或失败短缓存到期后会重新验证。结果类别为 `verified_orderable`、`no_same_item`、`wrong_spec`、`out_of_stock_or_offline`、`moq_gt_one` 和 `pending_recheck`，并给出建议复核优先级。

## 生产配置

冻结配置必须使用：

```text
FLOW_B_1688_MATCH_POLICY=balanced
FLOW_B_1688_ADAPTIVE_ACTION_POLICY=shadow
FLOW_B_SUPPLY_GATE_POLICY=enforce
FLOW_B_SUPPLY_GATE_MAX_OFFERS=3
FLOW_B_SUPPLY_EVIDENCE_TTL_MS=1800000
FLOW_B_SUPPLY_RETRY_DELAYS_MS=60000,600000
FLOW_B_RUNTIME_STATE_SCHEMA_VERSION=4
```

schema v4 首次打开旧库前会创建备份，并记录不可修改的 `supply_gate_cutover_at`。切换时间之前的严格发布保持兼容，不会伪造采购证据；切换后的新提交缺少有效 `SupplyEvidenceV1` 会被 JavaScript 校验和 SQLite trigger 同时拒绝。
