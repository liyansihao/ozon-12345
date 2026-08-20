# Ozon candidate-funnel v121 report (2026-07-23)

## Result

**NOT PASS, but the listing FBS evidence gate materially improved the candidate
funnel.** The continuous window ran from `2026-07-23T12:05:12.883Z` to
`2026-07-23T12:15:12.883Z` (20:05:12–20:15:12 CST).

| Metric | v120 | v121 |
|---|---:|---:|
| final confirmed unique SKU | 2 (both prior-run submissions) | 1 |
| effective final rate | 12/hour | 6/hour |
| collection attempts | 16 | 14 |
| pure-FBS detail results | 1 (6.3%) | 12 (85.7%) |
| non-pure-FBS | 14 (87.5%) | 2 (14.3%) |
| entered 1688 | 1 | 10 |
| reliable 1688 cost | 0 | 6 (60.0%) |
| new submissions | 0 | 4 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 | 0 / 0 / 0 |
| duplicate final SKU | 0 | 0 |

The strict final was SKU `1804842849`, with 38.35% profit, state `selling`,
and stock 1 in store 106637.

## Single-variable effect

v121 removed v120's rejected exact source allowlist, retained dynamic source
rotation and the per-source drain of two, and enabled only
`FLOW_B_REQUIRE_LISTING_FBS_EVIDENCE=1`.

The gate admits a card to the expensive detail queue only when the Maozi plugin
card telemetry says exact `FBS`. It does not infer the final shipping mode.
All 14 admitted candidates still underwent the real detail check; two card
false positives were rejected there.

The v100–v120 baseline predicted that this gate would move pure-FBS conversion
from 6.0% without card evidence to approximately 80.9% with evidence. v121
observed 85.7%, while non-pure-FBS fell from v120's 87.5% to 14.3%. The gate is
therefore retained even though the strict final speed did not yet pass.

## Latest downstream loss

Ten real pure-FBS candidates entered the cost stage:

- reliable 1688 cost: 6
- 1688 no reliable match: 4
- missing shipping/logistics mode during profit calculation: 2 additional
  pure-FBS candidates before the cost-qualified funnel
- submitted: 4
- strict final within the window: 1
- still pending final confirmation at window end: 3

The exact-source results were:

| Source | Attempts | pure FBS | Submitted | Final |
|---|---:|---:|---:|---:|
| Miaowu page 3 | 4 | 4 | 2 | 1 |
| Kids Wheels | 1 | 1 | 1 | 0 |
| Nature | 2 | 1 | 1 | 0 |
| Pervyy Transport, all variants | 4 | 3 | 0 | 0 |
| Other sources | 3 | 3 | 0 | 0 |

The run made 32 globally paced Ozon operations: 18 source pages and 14 detail
pages. The scanner's `pending=160` value is the unscanned source-URL portfolio,
not a candidate count. The durable candidate queue itself contained 14 unique
SKUs and all 14 had reached terminal collection outcomes. The 18 persisted
source-page records still retain unattempted listing-card evidence.

## Next single variable

Seed the next run's source checkpoint from v121 so unattempted cards in the 18
already scanned source pages can pass through the new listing-FBS gate before
more source pages are opened. v118 showed that checkpoint reuse without this
gate was ineffective; v122 tests the checkpoint only after ambiguous cards have
been excluded. Attempted and submitted SKUs remain excluded by the existing
state seeds. This does not trust cached FBS as final truth, does not change the
15-second global interval, and does not change any 1688, P70, profit, store,
inventory, deduplication, or final-confirmation rule.

## Verification

- commit: `c4d2943262b60f531b910c265669a8aa938a9c46`
- complete Node tests: 441/441 passed
- complete Python tests: 13/13 passed
- Ozon access incidents: 0
- supervisor exited normally
