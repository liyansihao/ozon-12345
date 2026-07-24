# Ozon candidate-funnel v126 report (2026-07-24)

## Result

**NOT PASS; the configuration variable was rejected.** The continuous window
ran from `2026-07-24T05:10:28.445Z` to `2026-07-24T05:20:28.445Z`
(13:10:28–13:20:28 CST).

- strict final confirmations: 0
- effective rate: 0/hour
- source scan records: 22
- admissible listing-FBS cards: 0
- detail / 1688 / submit / final: 0 / 0 / 0 / 0
- CAPTCHA / soft block / crash: 0 / 0 / 0
- duplicate SKU count: 0

## Single-variable result

v126 appended v124b's `source_yield.jsonl` to
`FLOW_B_SOURCE_YIELD_SEED_FILES`. The existing source scorer consumed the
evidence, but still scheduled verified historical seller variants before the
new title-derived searches.

The first eleven completed source records were exhausted variants from Kids
Wheels, Pervyy Transport, and Miaowu. The first Global title-derived search
was not reached until minute five and was an older historical phrase
(`металлическая модель коллекции`), not either of the latest v124b winners.
All 22 completed source records yielded zero unattempted cards with exact
listing-FBS evidence.

Because strict speed remained 0/hour, simply adding the latest yield file did
not improve the business metric and will not be carried as the active
variable.

## New bottleneck and next variable

The verified-source tier is stale after cross-run SKU deduplication. Its
historical success score does not represent the remaining unprocessed supply,
so it consumes the entire short window before fresh searches can be tested.

The next single variable remains configuration-only: use an exact allowlist
containing the twelve first-order Global searches derived from the two latest
strict v124b winners, across the existing `150`/`500` price bands and result
pages 1–3. Final FBS verification remains mandatory; the allowlist is only a
source-priority experiment.

No Ozon interval, FBS test, 1688 match rule, P70 cost, profit threshold,
store rotation, state persistence, deduplication, inventory, submission, or
final-confirmation behavior changes.

## Runtime

- run: `runs/flow_b/20260724_130924_ozon10m_v126`
- commit: `7448422a08689855b00b6fd33fbabf02bd72832c`
- supervisor: exited normally
- browser owner: one
