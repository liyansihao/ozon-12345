# Ozon candidate-funnel v128 report (2026-07-24)

## Result

**NOT PASS, but the productive-seller frontier restored candidate supply.**
The continuous window ran from `2026-07-24T05:34:52.112Z` to
`2026-07-24T05:44:52.112Z` (13:34:52–13:44:52 CST).

| Metric | v127 | v128 |
|---|---:|---:|
| strict final confirmations | 0 | 0 |
| source records | 4 | 10 |
| exact listing-FBS candidates | 0 | 2 |
| real pure-FBS details | 0 | 2 |
| reliable 1688 cost completed | 0 | 1 |
| submitted / final | 0 / 0 | 0 / 0 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 | 0 / 0 / 0 |

The first completed candidate, SKU `4347922935`, obtained a reliable P70 cost
in 4.512 seconds. Its unchanged profit formula returned 25.71%, so it was
correctly rejected by the strict `>30%` rule. SKU `2898088652` passed real
pure-FBS detail and was favorited, but the acceptance deadline arrived before
its downstream cost work began; it was not counted as a submission or final.

## Single-variable result

v128 used the next previously unseen page for ten seller families with
historical full-funnel evidence. Fluff Joy page 4 and MDW page 5 each produced
one exact listing-FBS card; the other eight pages produced none. This is better
than title-derived search but only two candidates per ten source navigations,
which is insufficient for five finals in ten minutes.

The frontier portfolio is therefore useful evidence but is not retained as a
closed allowlist.

## Historical retained-supply audit

An offline inventory of every persisted `source_deep_scan.json` found exact
listing-FBS card evidence for **89 unique SKUs across 33 source records** that
have never appeared in any candidate queue, favorite log, source-yield event,
SKU state, selection, skip, or publication record.

This is a materially larger, already-observed candidate pool than blind new
page scanning. The evidence is not treated as final truth: every retained card
will still undergo the current real Ozon detail pure-FBS check, reliable 1688
match, P70 cost, strict profit, deduplication, submission, and final-state
confirmation.

## Next single variable

Seed the next run's source checkpoint with only those 89 untouched exact-FBS
cards. The checkpoint is rebuilt from immutable historical scan evidence and
current durable state at launch, globally deduplicated by SKU, and contains no
ambiguous or inferred shipping modes.

No production code, Ozon interval, 1688 rule, profit formula, store rotation,
state persistence, deduplication, inventory, submission, or final-confirmation
behavior changes.

## Runtime

- run: `runs/flow_b/20260724_133322_ozon10m_v128`
- commit: `365dc541fd5991b95e43fc7bf4fb4a2605a72c32`
- supervisor: exited normally
- browser owner: one
