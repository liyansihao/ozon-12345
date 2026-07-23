# Ozon candidate-funnel v122 report (2026-07-23)

## Result

**NOT PASS.** The continuous window ran from
`2026-07-23T12:21:14.818Z` to `2026-07-23T12:31:14.818Z`
(20:21:14–20:31:14 CST).

| Metric | v121 | v122 |
|---|---:|---:|
| strict final confirmations | 1 | 3 |
| effective final rate | 6/hour | 18/hour |
| finals submitted in the same window | 1 | 0 |
| new collection attempts | 14 | 4 |
| pure-FBS detail results | 12 (85.7%) | 4 (100%) |
| non-pure-FBS | 2 | 0 |
| new submissions | 4 | 0 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 | 0 / 0 / 0 |

All three v122 finals were v121 submissions whose final Ozon state and stock
became confirmable during v122:

| SKU | Profit | v121 prepared at | v122 final at |
|---|---:|---|---|
| `2137679651` | 46.91% | 20:11:16 | 20:22:15 |
| `4030727444` | 50.91% | 20:14:54 | 20:22:16 |
| `3261790200` | 42.62% | 20:10:29 | 20:22:25 |

They are valid strict in-window finals, but they are not v122 candidate
productivity.

## Single-variable effect

v122 retained the listing FBS evidence gate and changed only one variable:
it seeded `source_deep_scan.json` with the 18 v121 source-page records.

The checkpoint did not reduce source work. The scanner opened 21 additional
source pages, obtained only four new real pure-FBS candidates, and made no new
submission. One source page consumed the full 60-second lifecycle timeout.
The checkpoint also treated the best already scanned source families as
completed, so productive v121 exact pages did not lead the new window.

The checkpoint variable is rejected and will not be carried into the next run.
The FBS evidence gate remains retained because all four admitted v122
candidates were real pure FBS.

## New maximum bottleneck

The scheduler scores exact URL variants. A seller's successful base page or
page 3 does not give an unseen rating/price variant a full-funnel score. v122
therefore spent the global 15-second budget on unproven variants of
Mamaduduqi, Okday, MDW, Wizzal Kids, and others, while v121's productive
Miaowu, Nature, and Kids Wheels evidence was attached to different exact URLs.

The four v122 candidates ended as:

- 1688 no reliable match: 2
- profit `<=30%`: 1
- 1688 health deferred at the window boundary: 1
- submitted: 0

## Next single variable

For an exact URL with no own outcome sample, inherit a confidence-limited
seller-family full-funnel score. An exact variant with its own negative sample
continues to use that exact score and cannot borrow another variant's success.
The score remains final-publication-centric and uses existing real
favorite/submitted/published/skipped evidence; it does not infer FBS or cost
reliability for an individual SKU.

## Verification

- commit: `fb5226a1b452e33129df1015bfbc8ed323de865d`
- prior complete Node tests: 441/441 passed
- prior complete Python tests: 13/13 passed
- Ozon access incidents: 0
- supervisor exited normally
