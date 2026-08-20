# Ozon candidate funnel v116 — 2026-07-23

## Result

- Status: NOT PASS
- Frozen commit: `6d1901d6ad`
- Run: `runs/flow_b/20260723_183010_ozon10m_v116`
- Continuous window: `2026-07-23 18:31:51–18:41:51 CST`
- Final confirmed publishes: 1 (`6/hour`)
- Final SKU: `3772401457`
- Profit rate: `81.25%`
- Final state / stock: `selling / 1`
- Duplicate SKU count: 0
- Ozon CAPTCHA / soft block / crash: `0 / 0 / 0`
- Runtime errors: 0

## Funnel

| Stage | v115b | v116 |
|---|---:|---:|
| Classified candidates | 24 | 19 |
| Pure FBS | 0 | 5 (26.3%) |
| non-pure-FBS | 23 (95.8%) | 13 (68.4%) |
| Other preflight rejects | 1 | 1 |
| Entered 1688 after upper-bound check | 0 | 4 |
| Reliable 1688 cost | 0 | 1 (25.0%) |
| Final confirmed | 0 | 1 |
| Effective speed | 0/hour | 6/hour |

The completed-family checkpoint change materially improved the funnel and is retained: each producer
tranche moved to new source families, pure-FBS candidates returned, and one item completed the
unchanged strict 1688/P70/profit/final-confirmation path.

## Latest largest losses

Five pure-FBS candidates produced:

- one `profit-upper-bound<=30`;
- three `1688-no-reliable-match`;
- one reliable cost, profit pass, submission, and final publication.

Therefore reliable same-product 1688 conversion was `1/4 = 25%`, below v100's `14/29 = 48.3%`.
No transport failure occurred: all four cost queries completed, and the three failures were strict
price-cluster/matching rejections.

The run also spent 14 globally gated Ozon operations on source discovery. This consumed about
3.5 minutes of the 10-minute budget before candidate detail work. The last checkpoint already
contains unresolved candidates from newly rotated source families. Historical v107 evidence showed
that restoring a valid source checkpoint can reach five final confirmations in 10 minutes by
starting candidate consumption earlier; its duplicate-submit defect is now protected by
`FLOW_B_PENDING_STATE_SEED_FILES`.

## Next controlled variable

Start the next 10-minute sample from v116's source checkpoint rather than an empty checkpoint, while
adding v116's latest state/favorite evidence to both normal and pending-state seeds. No source score,
Ozon interval, pure-FBS verification, 1688 rule, P70 rule, profit rule, store rotation, deduplication,
or final confirmation code changes. If checkpoint reuse does not improve final speed, it is rejected
and the next analysis returns to title/category reliable-match yield.
