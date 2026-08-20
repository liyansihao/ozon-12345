# Ozon candidate-funnel v120 report (2026-07-23)

## Result

**NOT PASS.** The continuous window ran from
`2026-07-23T11:44:04.000Z` to `2026-07-23T11:54:04.000Z`
(19:44:04–19:54:04 CST).

| Metric | v119 | v120 |
|---|---:|---:|
| final confirmed unique SKU | 2 | 2 |
| effective final rate | 12/hour | 12/hour |
| new collection attempts | 23 | 16 |
| pure-FBS favorites | 13 (56.5%) | 1 (6.3%) |
| non-pure-FBS | 8 (34.8%) | 14 (87.5%) |
| oversized title | 0 | 1 (6.3%) |
| new submissions | 4 | 0 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 | 0 / 0 / 0 |
| duplicate final SKU | 0 | 0 |

The two strict finals were:

| SKU | Profit | State | Stock |
|---|---:|---|---:|
| `1792072712` | 34.08% | selling | 1 |
| `3798551387` | 57.58% | selling | 1 |

Both SKUs were submitted during v119 and reached strict final confirmation
during the v120 window. They are valid in-window final confirmations, but they
are not evidence that the v120 source selection produced new publishable
candidates. v120 made no new submission.

## Single-variable effect

v120 retained the improved per-source queue drain of two from v119 and changed
only the source selection to an exact allowlist of the three v119 sources that
had produced submissions.

The allowlist exhausted a weak tail of those exact source variants: only one of
16 newly evaluated candidates was pure FBS, 14 were non-pure-FBS, and one was
rejected by the existing oversized-title rule. Source scanning had no pending
candidate after 19:49:40 CST. The exact allowlist therefore overfit a small
v119 sample and is rejected. Dynamic source rotation is restored; the
per-source drain of two remains retained.

## Cross-run listing evidence

Candidate-card telemetry from v100–v120 was joined by SKU to its real favorite
detail outcome:

| Listing-card evidence | Candidates | Real pure FBS | Pure-FBS rate | Submitted | Final |
|---|---:|---:|---:|---:|---:|
| plugin says `发货模式：FBS` | 204 | 165 | 80.9% | 50 | 23 |
| no plugin FBS evidence | 402 | 24 | 6.0% | 6 | 5 |

In v119, all 13 real pure-FBS candidates had listing-card FBS evidence. Only
one of the eight real non-pure-FBS candidates was a listing false positive.
In v120, all 14 non-pure-FBS candidates lacked listing-card FBS evidence.

This signal is used only as a pre-detail scheduling gate. It does not mark a
candidate as pure FBS: every admitted SKU must still pass the real detail-page
shipping-mode check, reliable 1688 matching, P70 cost, strict profit,
submission, and final-state checks.

## Next single variable

Require listing-card plugin FBS evidence before a candidate enters the detail
queue. Ambiguous cards are not written as failures and remain eligible if the
gate is later disabled. This avoids spending the global 15-second Ozon detail
budget on the historical 6.0%-yield group while preserving strict detail
verification.

## Verification

- commit: `6cd21c8736cb09a1afb8509d5aece9236addc742`
- prior complete Node tests: 440/440 passed
- prior complete Python tests: 13/13 passed
- Ozon access incidents: 0
- supervisor exited normally
