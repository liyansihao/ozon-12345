# v137 10-minute formal-entry gate

## Result

- Run: `runs/flow_b/20260724_162230_ozon10m_v137`
- Window: 2026-07-24 16:23:09–16:33:09 CST
- Frozen commit: `b57fb922b337edf339e400476e7e40cb621c5d9e`
- Strict final confirmations: 4/5
- Effective rate: 24/hour
- Numeric result: **NOT PASS**
- Exact source checkpoint rows: 10
- Duplicate successes: 0
- CAPTCHA / soft block / browser crash / runtime error: 0 / 0 / 0 / 0

## Strict successes

| SKU | Store | Profit rate | Status | Stock |
|---|---:|---:|---|---:|
| 2889051697 | 106646 | 111.27% | selling | 1 |
| 4276393238 | 106646 | 104.60% | selling | 1 |
| 2400563521 | 106646 | 89.92% | selling | 1 |
| 3662818954 | 106646 | 127.54% | selling | 1 |

One carried submission was finally rejected by the platform duplicate rule and
was not counted.  Collection also recorded one non-pure-FBS rejection and two
page timeouts without a supervisor failure.

The gate missed five strict finals by one, but 24/hour is the same
"near 30/hour" threshold used to enter v131b after v130/v132.  Exact multi-page
dispatch has now remained effective across v134–v137 without changing the
15-second Ozon interval or any quality rule.  A new continuous 30-minute
formal window may therefore start with both targets explicitly set to 15.
