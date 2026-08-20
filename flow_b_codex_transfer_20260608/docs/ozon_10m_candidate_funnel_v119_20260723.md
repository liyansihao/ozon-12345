# Ozon candidate-funnel v119 report (2026-07-23)

## Result

**NOT PASS, but the single variable improved the candidate funnel.** The
continuous window ran from `2026-07-23T11:29:56.576Z` to
`2026-07-23T11:39:56.576Z` (19:29:56–19:39:56 CST).

| Metric | v118 | v119 |
|---|---:|---:|
| final confirmed unique SKU | 1 | 2 |
| effective final rate | 6/hour | 12/hour |
| collection attempts | 18 | 23 |
| pure-FBS favorites | 4 (22.2%) | 13 (56.5%) |
| non-pure-FBS | 12 (66.7%) | 8 (34.8%) |
| detail page timeout | 0 | 2 (8.7%) |
| entered 1688 | 2 | 12 |
| submitted | 1 | 4 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 | 0 / 0 / 0 |
| duplicate final SKU | 0 | 0 |

The two strict finals were:

| SKU | Profit | State | Stock | Store |
|---|---:|---|---:|---|
| `2856756022` | 79.15% | selling | 1 | 106637 |
| `2402205791` | 42.20% | selling | 1 | 106637 |

## Single-variable effect

v119 retained all v118 business and access settings and changed only
`FLOW_B_CANDIDATE_QUEUE_PER_SOURCE_DRAIN` from `6` to `2`. The v118 source
checkpoint reuse was removed because it had already been rejected as
ineffective.

The smaller candidate burst forced earlier source rotation. Pure-FBS conversion
increased from 22.2% to 56.5%, non-pure-FBS fell from 66.7% to 34.8%, and strict
finals increased from one to two. The variable is therefore retained.

## Latest downstream loss

Thirteen candidates were pure FBS. Twelve entered the cost stage, but only four
were submitted:

- 1688 no reliable match: 3
- 1688 health deferred: 2
- profit `<=30%`: 2
- missing shipping mode downstream: 1
- submitted: 4

No 1688 transport/TLS change is proposed. The next candidate-selection variable
uses full-funnel source evidence to avoid low-yield source variants before
detail and 1688 work.

| Exact source | Attempts | pure FBS | Submitted | Final |
|---|---:|---:|---:|---:|
| Pervyy Transport, unfiltered | 7 | 7 | 2 | 1 |
| Fluff Joy, ¥500 discount | 3 | 2 | 1 | 1 |
| Pervyy Transport, ¥500 rating | 6 | 3 | 1 | 0 in-window |
| Fluff Joy, ¥150 rating | 3 | 0 | 0 | 0 |
| Fluff Joy, ¥1000 discount | 3 | 0 | 0 | 0 |

All four v119 submissions came from the first three exact sources. The next
single variable is an exact source allowlist containing those three sources.
It does not infer FBS or cost reliability; every SKU still undergoes real
detail, 1688, P70, profit, submission, and final-state checks.

## Verification

- commit: `656034c1f217b8049303aafd74429f94532ed617`
- candidate queue rotation tests: 9/9 passed
- prior complete Node tests: 440/440 passed
- prior complete Python tests: 13/13 passed
- Ozon access incidents: 0
- supervisor exited normally
