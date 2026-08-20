# v136 10-minute exact-page continuation gate

## Result

- Run: `runs/flow_b/20260724_161100_ozon10m_v136`
- Window: 2026-07-24 16:11:39–16:21:39 CST
- Frozen commit: `db3fa7c5b7209e03d3beed835a737e22540c5bda`
- Strict final confirmations: 3/5
- Effective rate: 18/hour
- Result: **NOT PASS**
- Exact source checkpoint rows: 10
- New ERP submissions: 4
- Duplicate successes: 0
- CAPTCHA / soft block / browser crash / runtime error: 0 / 0 / 0 / 0

## Strict successes

| SKU | Store | Profit rate | Status | Stock |
|---|---:|---:|---|---:|
| 4466345816 | 106637 | 42.49% | selling | 1 |
| 2374932575 | 106637 | 87.13% | selling | 1 |
| 2374932836 | 106646 | 112.51% | selling | 1 |

Two carried submissions were rejected by the final platform duplicate rule and
were not counted.  The candidate producer scanned all ten exact page-8/page-9
URLs and remained stable, but only three final confirmations landed inside
the window.  The formal-entry gate therefore remains NOT PASS.
