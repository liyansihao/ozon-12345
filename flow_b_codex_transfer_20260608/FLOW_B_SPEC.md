# Ozon Flow B Specification

## Purpose

This document defines the boundary between the existing Ozon one-click listing flow and the new Flow B.

Flow B is a separate Ozon one-click listing workflow. It must not modify, overwrite, or depend on Flow A runtime state unless the user explicitly asks for that.

## Names

- Flow A: the existing Ozon one-click listing workflow that was previously debugged.
- Flow B: the new Ozon one-click listing workflow to be designed in this workspace.
- Shared 1688 cost module: reusable scripts or functions for 1688 image search, first-page/Top10 evidence capture, filtered first-page 70th percentile cost calculation, and cost reliability checks.

## Isolation Rules

Flow B must use independent files for:

- Entry script
- Configuration file
- Runtime log directory
- Published product record
- Candidate processing record
- Temporary run state
- Any retry, checkpoint, queue, or progress files

Flow B must not read or write Flow A state files, logs, published records, queues, or checkpoints unless the user explicitly says to do so.

Flow A must remain unchanged unless the user explicitly says "modify Flow A" or gives an equivalent direct instruction.

## Allowed Shared Capability

Flow B may reuse the 1688 cost calculation capability:

- Product image search on 1688
- Saving full Top10 search evidence
- Filtered first-page similarity-order 70th percentile cost basis
- Mixed-family or abnormal-spread reliability checks
- Image format conversion needed for reliable 1688 search

Shared 1688 logic should stay behaviorally compatible with Flow A unless the user explicitly asks to fork or change it for Flow B.

## Default Implementation Rule

When implementing or debugging Flow B:

- Treat all changes as Flow B-only by default.
- Create new Flow B files instead of editing Flow A files.
- If a needed helper is currently embedded inside Flow A, extract or wrap only the reusable 1688 cost part without changing Flow A behavior.
- Keep Flow B logs and records clearly named with `flow_b`.

## Pending Flow B Details

The user provided the first Flow B business process on 2026-05-20. Flow B must follow the workflow below and must not infer listing behavior from Flow A except for the explicitly shared 1688 cost calculation capability.

## Flow B Workflow

Flow B starts from MaoziERP favorites, not from Flow A's batch card scanning workflow.

1. Open the target Ozon seller store page and scroll to the bottom until no more products load. This confirms the store page is fully loaded before working through MaoziERP favorites.
2. Open MaoziERP, click the left sidebar `商品`, then click `收藏夹`.
3. In `收藏夹`, collect each product from the table. The `商品标题` field is the product link source. Open each product link one by one.
4. On the Ozon product detail page, open the MaoziERP floating panel action `计算利润`.
5. In the profit calculator, set `售价` to the lower value between:
   - the Ozon detail page current sale price
   - the Maozi follow-sell lowest price
6. Use the shared 1688 cost module to verify sourcing cost from the product image. Fill `采购成本` with the validated 1688 cost.
7. Confirm `跨境物流商` is `CEL`, then click `开始计算`.
8. Scroll inside the calculator panel until the logistics options are visible. Select `Economy (陆运)` under CEL and let the calculator recalculate final profit.
9. If final profit rate is greater than `15%`, continue to listing. If final profit rate is less than or equal to `15%`, skip the item and return to the next favorites product.
10. For a qualified item, open the MaoziERP floating panel action `一键上架`.
11. In the listing modal, set `显示所有SKU` to `否` before editing the listing fields.
12. Confirm listing settings:
    - `选择店铺`: `JM-001` by default.
    - `水印`: `鹿呦呦` by default.
    - These are configurable because the user may switch shops later.
13. Set `我的售价` to the same selected lower sale price used in the calculator.
14. Click `一键上架至OZON`.
15. After successful listing, write the product link to Flow B's independent published record.
16. Return to the favorites list and continue until every favorites product has been calculated and either listed or skipped.

## Flow B Decision Rules

- Profit threshold: publish only when final profit rate is greater than `15%`.
- Profit rate less than or equal to `15%`: skip.
- Final profit must include Ozon/Maozi category commission. If a calculator/API result shows `cate_rate` or `cate_fee` as `0` while the product card/detail exposes an rFBS commission rate, the result is invalid and must not be used for publishing.
- When using any machine-readable calculator response, cross-check the visible calculator `计算明细` or independently subtract the applicable rFBS category commission before deciding. Do not publish from a logistics-only profit result.
- Selected sale price: lower of current Ozon detail sale price and Maozi follow-sell lowest price.
- Store: default `JM-001`, configurable.
- Watermark: default `鹿呦呦`, configurable.
- Currency: RMB/CNY.
- Logistics provider: `CEL`.
- Required logistics service after calculation: `Economy (陆运)`.
- Required listing modal SKU setting: `显示所有SKU = 否`.

## Flow B Low Compute Policy

- Prefer DOM/table extraction from MaoziERP favorites over screenshots.
- Cache favorites rows before processing so the script does not re-read the same table repeatedly.
- Save one JSON note per SKU/product link with selected sale price, 1688 cost, logistics choice, profit, decision, and reason.
- Reuse saved 1688 evidence for the same canonical product link or SKU during retries.
- Use screenshots only when DOM extraction fails, a modal cannot be located, or visual confirmation is needed.
- The script must be resumable: already listed, skipped, or blocked products should not be recalculated unless the user requests a retry.
