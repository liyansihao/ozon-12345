# v155 10-minute global-seller batch-2 gate

- Run: `runs/flow_b/20260724_221000_ozon10m_v155`
- Frozen commit: `dd325329d440363562d068f49ce2d4f6337bc807`
- Window: 2026-07-24 22:11:04–22:21:04 CST
- Single variable: replace v154's exhausted/low-yield seller set with a second batch of previously unconsumed global China sellers
- Preserved controls: exact source allowlist, strict listing FBS evidence, zero retained replay, complete v130–v154 state/favorite/pending seeds, one browser owner, 15-second Ozon global interval

## Result

| Metric | v154 | v155 |
|---|---:|---:|
| Strict final successes | 1 carryover / 0 new | 3 new |
| Effective final rate | 6/hour | 18/hour |
| Detail and category | 9 | 12 |
| Reliable 1688 cost | 3 | 5 |
| Submitted | 0 new | 4 |
| `1688-no-reliable-match` | 4 | 7 |
| Profit rejection | 2 | 1 |
| Collection non-pure-FBS | 3 | 1 |
| Runtime failures | 0 | 0 |

The source change improved final output but did not meet the 5-final/10-minute gate. The current largest loss is reliable same-product sourcing: 7 of 12 cost queries ended as `1688-no-reliable-match`.

## Strict final products

| SKU | Profit rate | Store | Source |
|---|---:|---|---|
| 4359374785 | 38.13% | 丽丽二号 | `devushka-nadezhda` |
| 2892086691 | 30.29% | 丽丽二号 | `guanhe-predpochital-butik-univermag-dx-3-1778857` |
| 4359375244 | 66.79% | 丽丽二号 | `devushka-nadezhda` |

Minimum profit rate was 30.29%, strictly above 30%. Unique final SKU count was 3 and duplicates were 0. CAPTCHA, soft block, browser crash, worker failure, and supervisor failure were all 0.

## Decision

NOT PASS for the small-sample gate (3 < 5). Keep the proven `devushka-nadezhda` and `guanhe...` sources as evidence for a later expanded set, but do not start the formal 30-minute window yet. Continue the same controlled source-only experiment with the next unconsumed global-seller batch.
