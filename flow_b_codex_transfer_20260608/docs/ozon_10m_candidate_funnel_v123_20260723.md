# Ozon candidate-funnel v123 report (2026-07-23)

## Result

**NOT PASS and the single variable regressed supply.** The continuous window
ran from `2026-07-23T12:37:16.722Z` to `2026-07-23T12:47:16.722Z`
(20:37:16–20:47:16 CST).

| Metric | v121 | v122 | v123 |
|---|---:|---:|---:|
| strict final confirmations | 1 | 3 prior-run | 0 |
| effective final rate | 6/hour | 18/hour | 0/hour |
| new collection attempts | 14 | 4 | 3 |
| pure-FBS detail results | 12 | 4 | 3 |
| new submissions | 4 | 0 | 1 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |

The three new candidates were all real pure FBS. One had no reliable 1688
match, one failed the unchanged strict profit threshold, and one was submitted
too late to reach strict final state inside the window.

## Single-variable effect

v123 removed v122 checkpoint reuse and changed only source ranking: unseen URL
variants inherited 75% of their seller-family full-funnel score.

The ranking behaved as implemented and opened Kids Wheels, Miaowu, Pervyy
Transport, Fluff Joy, and Nature first. Those historically productive seller
families were already depleted after cross-run SKU exclusions. The scanner
opened 26 source pages but found no new card-FBS candidate until approximately
minute eight, and only three in the full window.

The seller-family inheritance variable is rejected and removed. Exact variant
scores remain the source of truth.

## Root cause exposed

The scanner already persists
`eligible_link_count_before_collection` and demotes a source family after two
variants return zero eligible links. However that count currently includes all
unattempted cards, including cards without plugin FBS evidence. With the v121
FBS gate enabled, those cards can never enter the detail queue, but they still
make a source page appear non-empty to the exhaustion detector.

This mismatch explains why v123 repeatedly scanned dry seller variants while
collecting zero candidates.

## Next single variable

When `FLOW_B_REQUIRE_LISTING_FBS_EVIDENCE=1`, compute the persisted eligible
count from plugin-FBS-qualified cards only. Apply the same filter to queue-only
and lookahead discovery so ambiguous cards cannot keep a source artificially
alive. After two zero-evidence variants, the existing exhaustion policy can
demote that exact source family.

This changes only pre-detail candidate accounting. Every admitted candidate
still receives real detail verification and all unchanged downstream checks.

## Verification

- tested commit: `2488ac3e150724639232cbba2e045463bfc63271`
- seller-family inheritance: rejected and removed
- Ozon access incidents: 0
- supervisor exited normally
