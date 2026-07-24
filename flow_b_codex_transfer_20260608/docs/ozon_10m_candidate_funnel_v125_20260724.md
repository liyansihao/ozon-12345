# Ozon candidate-funnel v125 report (2026-07-24)

## Result

**NOT PASS; the single variable was rejected and reverted.** The continuous
window ran from `2026-07-24T04:54:27.924Z` to
`2026-07-24T05:04:27.924Z` (12:54:27–13:04:27 CST).

- strict final confirmations: 0
- effective rate: 0/hour
- source scan records: 26
- admissible listing-FBS cards: 1
- detail-stage candidates: 0
- CAPTCHA / soft block / crash: 0 / 0 / 0
- duplicate SKU count: 0

The only admitted card was eliminated as a prohibited category before Ozon
detail, so no 1688, profit, submission, or final-confirmation work occurred.

## Single-variable result

v125 removed the special high tier retained by `boundedDeep` variants after a
seller accumulated two zero-FBS scan variants.

The change behaved as intended: after the already-prefetched tranche drained,
the scanner moved from Miaowu and Pervyy Transport to a Global search and
other seller families. It did not improve the business metric because those
new sources were also dry.

Across all 26 source records there was only one admissible FBS card. The
observed seller-family totals were:

| Family | Records | Admissible cards |
|---|---:|---:|
| Kids Wheels | 4 | 0 |
| Miaowu | 4 | 1 |
| Pervyy Transport | 3 | 0 |
| Mamaduduqi | 2 | 0 |
| Fluff Joy | 3 | 0 |
| Nature | 2 | 0 |
| MDW | 4 | 0 |
| other new sources | 4 | 0 |

Because final speed fell from v124b's 12/hour to 0/hour, the variable was
reverted under the single-variable rule.

## New bottleneck and next variable

The current source inventory is exhausted. The cross-run launcher did not add
v124b's `source_yield.jsonl` to `FLOW_B_SOURCE_YIELD_SEED_FILES`, so v125 could
not derive fresh searches from the two most recent strict winners:

- `Шорты SYJWY Море в твоем кармане`
- `Детский Mercedes-Benz SL63 полный привод`

An offline call to the existing unchanged `deriveSearchSourceUrls` function
shows that this missing feedback would add 24 new bounded Global search
variants under the existing source budget.

The next single variable is configuration-only: append the most recent
successful run's source-yield file to the source-yield seed list. No source
checkpoint will be reused, and no Ozon, FBS, 1688, profit, store, deduplication,
or final-confirmation rule changes.

## Runtime

- run: `runs/flow_b/20260724_125355_ozon10m_v125`
- commit: `faff67ed07027acf4a84e725d59ba66f1652e8dc`
- supervisor: exited normally
- browser owner: one
