# v133 30-minute formal candidate-frontier acceptance

## Result

- Run: `runs/flow_b/20260724_151030_ozon30m_v133`
- Window: 2026-07-24 15:10:56–15:40:56 CST (continuous 30 minutes)
- Frozen commit: `cc296cb8192e81032655d4c667d485d3268e70e7`
- Strict final-confirmed unique SKUs: 6
- Effective rate: 12/hour
- Target: 15
- Result: **NOT PASS**
- Duplicate successes: 0
- Minimum successful profit rate: 55.11%
- All successes: `selling`, stock 1
- CAPTCHA / soft block / browser crash / runtime error: 0 / 0 / 0 / 0

## Strict successes

| SKU | Store | Profit rate | Status | Stock |
|---|---:|---:|---|---:|
| 4872152839 | 106637 | 55.11% | selling | 1 |
| 2420289098 | 106637 | 72.58% | selling | 1 |
| 2265375481 | 106637 | 115.50% | selling | 1 |
| 3474443743 | 106637 | 139.76% | selling | 1 |
| 1829225163 | 106637 | 126.97% | selling | 1 |
| 1829223845 | 106637 | 121.62% | selling | 1 |

## Funnel

- Collection attempts: 12
- Detail/cost attempts: 9
- Reliable 1688 cost: 4
- Profit pass / ERP submissions: 3
- Final confirmations among new submissions: 1
- Collection eliminations:
  - missing shipping mode: 1
  - oversized low-yield title: 1
  - non-pure FBS: 2
- Pipeline eliminations:
  - 1688 no reliable match: 4
  - profit <=30%: 1
- Recoverable 1688 health deferral: 1
- Final platform rejections: 2

The two final rejections were
`SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT`.  The products were correctly not
counted as successes and were not resubmitted.

## Root cause

The launcher explicitly supplied 15 exact URLs: five proven source variants
for each of pages 3, 4, and 5.  Only the five page-3 URLs were scanned.

`sourceDispatchFamilyKey()` delegates to `sourceYieldKey()`, which removes the
`page` and `sorting` parameters.  Both dispatch de-duplication and completed
checkpoint exclusion therefore treated pages 3, 4, and 5 as the same family.
After page 3 completed, pages 4 and 5 were removed before dispatch.  Evidence:

- configured exact allowlist count: 15
- `source_deep_scan.json` record count: 5
- all five records have `page=3`
- last Ozon operation: 15:16:26 CST, while the supervisor remained alive
  through 15:40:56 CST
- runtime errors: 0

This is not an Ozon rate-limit, 1688 transport, or supervisor-stability
failure.  It is a mismatch between exact allowlist semantics and the older
family-level safety de-duplication.

## Next single-variable change

When and only when `FLOW_B_SOURCE_ALLOWLIST_MATCH=exact`, dispatch and
checkpoint completion must use the existing canonical exact URL key, keeping
explicit `page` and `sorting` values.  Default/family mode remains unchanged,
so broad source discovery still scans one representative per family.  Tests
must prove both behaviors before another real sample.
