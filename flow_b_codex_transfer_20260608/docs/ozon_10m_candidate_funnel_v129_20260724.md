# Ozon candidate-funnel v129 report (2026-07-24)

## Result

**NOT PASS; the intended checkpoint variable was not exercised.** The
continuous window ran from `2026-07-24T05:48:43.002Z` to
`2026-07-24T05:58:43.002Z` (13:48:43–13:58:43 CST).

- strict final confirmations: 0
- effective rate: 0/hour
- collection attempts: 4
- real pure-FBS details: 3
- reliable 1688 costs: 1 / 3
- submitted / final: 0 / 0
- CAPTCHA / soft block / crash: 0 / 0 / 0
- duplicate SKU count: 0

Eliminations were one prohibited category, one unchanged
`profit_rate<=30` result (7.41%), one `1688-no-reliable-match`, and one
bounded `1688-health-deferred` outcome.

## Single-variable result

The launcher correctly built a checkpoint containing 89 untouched exact-FBS
SKUs across 33 source records. Runtime inspection then showed:

```text
FLOW_B_MAX_RETAINED_LINKS=0
FLOW_B_CACHED_FBS_FALLBACK_LINKS=0
```

The existing scanner only enters its retained-card collection loop when one of
those bounded replay limits is positive. Consequently, the checkpoint records
were used to mark source completion but their retained links were not replayed.
The four observed candidates came from fresh source scans, not from the
89-SKU checkpoint.

This round therefore does not measure the intended retained-supply hypothesis.

## Next single variable

Keep the evidence-only checkpoint and set the existing
`FLOW_B_MAX_RETAINED_LINKS` limit from 0 to 12. Twelve is the scanner's tested
default retained budget and remains below the 24-link cached-FBS fallback
budget.

Only exact `发货模式：FBS` cards are present in the rebuilt checkpoint, and all
links are globally deduplicated against current durable state before launch.
Real detail pure-FBS verification, Ozon 15-second pacing, 1688 reliability,
P70 cost, profit, state persistence, stores, inventory, submission, and final
confirmation remain unchanged.

## Runtime

- run: `runs/flow_b/20260724_134656_ozon10m_v129`
- commit: `f8c49e7bab204128769be7cbf5f3c9448fdb2fde`
- supervisor: exited normally
- browser owner: one
