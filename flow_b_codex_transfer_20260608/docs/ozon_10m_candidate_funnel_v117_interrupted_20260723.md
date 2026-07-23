# Ozon candidate-funnel v117 interruption report (2026-07-23)

## Result

v117 is **INVALID / INTERRUPTED**, not a completed 10-minute sample. Its planned
window was `2026-07-23T10:48:05.247Z` through `2026-07-23T10:58:05.247Z`
(18:48:05–18:58:05 CST), but automation was stopped at approximately 18:50 after
a duplicate-candidate risk was observed. The next sample must start a new,
continuous window.

No second ERP submission was made. The interruption was preventive: a SKU that
had already been submitted in an earlier run was finally reconciled as published
by v117's consumer, then rediscovered and opened by v117's source producer.

## Evidence timeline

SKU `2872650725`:

| Time (CST) | Evidence |
|---|---|
| before v117 | v116 seed state was `processing` with `submitted=true`, `submission_pending=true`, and `reconcile_only=true` |
| 18:48:20.041 | consumer appended `published`; `online_status=selling`, `stock=1`, `profit_rate=102.51` |
| 18:48:57.123 | producer appended a new `discovered` candidate event from the Fluff Joy ¥1000 source |
| 18:49:13.553 | producer opened the Ozon detail and appended `favorited` |
| immediately after detection | supervisor/browser automation stopped; no later submit event exists for this SKU |

The single strict final confirmation cannot be used as v117 throughput evidence
because the acceptance window was interrupted.

## Root cause

`loadExcludedSkus()` used the state seeds only to exclude the latest
`published` or `skipped` statuses. It did not exclude an already submitted SKU
whose latest seed status was still `processing` pending final reconciliation.
The consumer correctly restored that SKU as reconcile-only, but the producer
independently treated it as eligible source supply.

This is a state-ownership gap, not an Ozon access, 1688 transport, profit,
store-rotation, or final-confirmation regression.

## Minimal correction

The source exclusion set now also includes a latest state carrying any of:

- `submitted=true`
- `submission_pending=true`
- `reconcile_only=true`

Ordinary unsubmitted failures remain retryable. Submitted work continues to be
owned exclusively by pending-state reconciliation and cannot re-enter source
discovery.

## Regression result

- source-scanner targeted Node tests: 178/178 passed
- complete Node tests: 440/440 passed
- complete Python tests: 13/13 passed
- no Ozon pace, 1688 reliability, profit, FBS, store, inventory, or final
  confirmation setting changed
