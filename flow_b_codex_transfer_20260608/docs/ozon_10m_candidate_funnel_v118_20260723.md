# Ozon candidate-funnel v118 report (2026-07-23)

## Result

**NOT PASS.** The continuous window ran from
`2026-07-23T11:15:27.031Z` to `2026-07-23T11:25:27.031Z`
(19:15:27–19:25:27 CST).

| Metric | v116 | v118 |
|---|---:|---:|
| final confirmed unique SKU | 1 | 1 |
| effective final rate | 6/hour | 6/hour |
| collection attempts | 19 | 18 |
| pure-FBS favorites | 5 (26.3%) | 4 (22.2%) |
| non-pure-FBS | 13 (68.4%) | 12 (66.7%) |
| missing shipping mode | 0 | 2 (11.1%) |
| 1688 evaluated | 4 | 2 |
| reliable 1688 cost | 1 (25.0%) | 1 (50.0%) |
| CAPTCHA / soft block / crash | 0 / 0 / 0 | 0 / 0 / 0 |
| duplicate final SKU | 0 | 0 |

The final SKU was `1768149307`, profit rate `39.11%`, online state
`selling`, stock `1`, store `106637`. It is the only final success counted.

## Duplicate-risk regression

The previously submitted pending SKU `2872650725` produced zero v118 candidate
queue events and zero favorite events. This confirms the v117 fix prevents a
submitted/reconcile-only seed from re-entering source discovery. There was no
duplicate ERP submission or duplicate final publication.

## Source funnel

| Source | Attempts | pure FBS | non-pure FBS | missing mode | final |
|---|---:|---:|---:|---:|---:|
| Fluff Joy, unfiltered | 2 | 2 | 0 | 0 | 0 |
| Miaowu, ¥1000 discount page 2 | 1 | 1 | 0 | 0 | 0 |
| Fluff Joy, ¥1000 rating | 5 | 1 | 3 | 1 | 1 |
| Fluff Joy, ¥150 discount | 4 | 0 | 3 | 1 | 0 |
| Okday, ¥500 rating | 6 | 0 | 6 | 0 | 0 |

The largest avoidable burst was Okday ¥500 rating: six consecutive candidates
were consumed from one source and all six were non-pure FBS. The configured
candidate queue per-source drain was six, so the downstream queue spent six
expensive detail slots before source feedback could rerank the portfolio.

## Variable decision

Reusing v116's 14-record source checkpoint did not improve final throughput or
pure-FBS conversion, so that runtime variable is rejected and will not be
carried forward.

The next single variable is the candidate queue per-source drain, reduced from
six to two. This does not classify any item as FBS without detail verification;
it only rotates sources after two candidates so one dry source cannot consume a
six-item burst. Ozon's 15-second global interval and all 1688, P70, profit,
store, stock, deduplication, and final-confirmation rules remain unchanged.

## Tests and runtime integrity

- code commit: `5b8a22baafd6cd0f58b3b166915e64b464d79133`
- complete Node tests: 440/440 passed
- complete Python tests: 13/13 passed
- supervisor exited normally after producing its strict report
- one browser owner remained; no supervisor or acceptance child remained
