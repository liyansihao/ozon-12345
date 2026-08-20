# Ozon candidate-funnel v124b report (2026-07-24)

## Result

**NOT PASS, but both pre-detail conversion metrics improved.** The continuous
window ran from `2026-07-24T04:39:35.404Z` to
`2026-07-24T04:49:35.404Z` (12:39:35–12:49:35 CST).

| Metric | v100 | v124b |
|---|---:|---:|
| strict final confirmations | 6 / 30 min | 2 / 10 min |
| strict final rate | 12/hour | 12/hour |
| collection attempts | 79 | 6 |
| real pure-FBS details | 31 | 5 |
| non-pure-FBS eliminations | 48 (60.8%) | 0 (0%) |
| reliable 1688 costs | 14 / 29 (48.3%) | 4 / 5 (80%) |
| new submissions | 6 | 2 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 | 0 / 0 / 0 |

Strict final SKUs:

| SKU | Store | Profit rate |
|---|---:|---:|
| `3261990938` | 106637 | 37.56% |
| `1792071518` | 106637 | 99.92% |

Both were ERP/Ozon-final, selling, and stock-positive. Duplicate count was
zero.

## Funnel

- candidate cards admitted: 6
- prohibited category before detail: 1
- real pure-FBS details: 5 / 5
- reliable 1688 cost: 4 / 5
- strict profit above 30%: 2 / 4
- submitted: 2
- final confirmed: 2

Eliminations were two unchanged `profit_rate<=30` decisions and one unchanged
`1688-no-reliable-match` decision. No downstream rule was relaxed.

## New bottleneck

The scanner persisted 22 source records. The first three source operations
produced six admissible FBS cards. The following 19 source records all had
`eligible_link_count_before_collection=0`.

The FBS-qualified exhaustion calculation correctly marked Miaowu, Pervyy
Transport, Mamaduduqi, Fluff Joy, and Nature as exhausted. Static inspection
showed that `prioritizeSourceUrls` nevertheless retained `boundedDeep` variants
in their evidence-backed tier:

```text
if (scanPenalty < 0 && !boundedDeep) tier = 0
```

That exemption explains why already dry seller price/page variants continued
to consume the rest of the window.

## Next single variable

Apply the existing scan-exhaustion penalty to every unverified variant of an
exhausted seller, including `boundedDeep` variants. A real FBS-positive scan
still resets the two-variant exhaustion condition; no seller is permanently
blocked.

This is a one-line production change plus a regression expectation. It does
not change the 15-second Ozon interval, pure-FBS verification, 1688 matching,
profit calculation, store rotation, deduplication, or final confirmation.

## Verification

- run: `runs/flow_b/20260724_123826_ozon10m_v124b`
- tested commit: `0b00ad60ca6fd678fdde7e1637971d10f88dd1e5`
- focused source tests after the next-variable patch: 180 / 180
- complete Node tests after the next-variable patch: 442 / 442
- Python unittest suite: 13 / 13
- browser owner: one
- supervisor: exited normally
