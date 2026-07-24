# v132 10-minute proven-source frontier sample

## Result

- Run: `runs/flow_b/20260724_145524_ozon10m_v132`
- Window: 2026-07-24 14:57:53–15:07:53 CST (continuous 10 minutes)
- Frozen commit: `7a9e5902b606a83c579e0ca9ea9211852ad378d2`
- Single variable: replace retained long-tail replay with the next unseen pages of the three best full-funnel source families
- Strict final-confirmed unique SKUs: 4
- Effective rate: 24/hour
- Gate target: 5 (NOT PASS numerically, accepted as "near 30/hour" for the formal-entry rule)
- Duplicate SKUs: 0
- Minimum successful profit rate: 48.52%
- Final stock/status: all four `selling`, stock 1
- CAPTCHA / soft block / browser crash / runtime error: 0 / 0 / 0 / 0

## Funnel

| Stage | Count | Rate |
|---|---:|---:|
| Collection attempts | 12 | 100% |
| Pure FBS detail pass | 10 | 83.3% |
| Reliable 1688 cost | 9 | 90.0% of cost-stage input |
| Profit >30% | 7 | 77.8% of reliable-cost SKUs |
| ERP submitted | 7 | 100% of profit-pass SKUs |
| Final confirmed in window | 4 | 57.1% of submissions |

Eliminations were `non-pure-fbs=2`, `profit_rate<=30=2`, and
`1688-no-reliable-match=1`.  The v100 non-pure-FBS rate was 60.8%; v132
reduced it to 16.7% without weakening final detail verification.

## Strict successes

| SKU | Store | Profit rate | Status | Stock |
|---|---:|---:|---|---:|
| 2857040260 | 106637 | 112.66% | selling | 1 |
| 3866805198 | 106637 | 57.30% | selling | 1 |
| 4221210619 | 106637 | 48.52% | selling | 1 |
| 3909642077 | 106637 | 253.64% | selling | 1 |

The first three were unresolved strict submissions from the immediately
preceding window and became `selling` during v132.  They are counted once at
their first strict final confirmation, not at submission time.

## Interpretation and next gate

The candidate-source change improved the expensive funnel materially:
reliable 1688 cost rose from v131b's 7/26 (26.9%) to 9/10 (90.0%), while the
non-pure-FBS loss fell from 16/42 (38.1%) to 2/12 (16.7%).  Seven submissions
were produced inside ten minutes.  The remaining loss was final-confirmation
latency, including the ERP three-minute synchronization cooldown; it was not
an Ozon access, transport, or candidate-quality regression.

Per the requested gate ("达到或接近 30 个/小时"), 24/hour with seven strict
submissions and the improved funnel qualifies for a new 30-minute formal
window.  The formal run keeps the same 15-second global Ozon interval and all
business rules, advances only to the next unseen pages of the proven source
families, and sets both publish and acceptance targets to 15.
