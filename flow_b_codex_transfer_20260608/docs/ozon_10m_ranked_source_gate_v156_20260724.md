# v156 ranked-source 10-minute gate

- Run: `runs/flow_b/20260724_222500_ozon10m_v156`
- Frozen commit: `ec549c6e351bbc7346c9b5f5897074da22334b22`
- Window: 2026-07-24 22:24:33–22:34:33 CST
- Single variable: rank source pages by v155 strict-final yield, expanding the two winning sellers before the unscanned exploration tail
- Preserved controls: one browser owner, exact source allowlist, 15-second Ozon global interval, strict listing FBS evidence, original reliable 1688/P70 and profit rules, complete v130–v155 dedup/pending state

## Result

PASS for the 10-minute gate.

| Metric | v155 | v156 |
|---|---:|---:|
| Strict final successes | 3 | 6 |
| New submissions finalized in-window | 3 | 5 |
| Carryover finalized in-window | 0 | 1 |
| Effective final rate | 18/hour | 36/hour |
| Detail and category | 12 | 11 |
| Reliable 1688 cost | 5 | 9 |
| ERP submissions | 4 | 7 |
| `1688-no-reliable-match` | 7 | 2 |
| Profit rejection | 1 | 2 |
| Collection non-pure-FBS | 1 | 2 |

The new submissions alone produced five strict finals in ten minutes, exactly 30/hour. The full same-window count was six, or 36/hour.

## Strict final products

| SKU | Profit rate | Source | Provenance |
|---|---:|---|---|
| 1673574334 | 53.82% | `aaron250` | v155 pending, finalized in v156 |
| 2847144327 | 42.86% | `devushka-nadezhda?page=5` | v156 |
| 2588811565 | 72.83% | `guanhe...page=2` | v156 |
| 2895595921 | 69.04% | `guanhe...page=2` | v156 |
| 2104705111 | 55.31% | `guanhe...page=2` | v156 |
| 4244419572 | 73.22% | `guanhe...page=2` | v156 |

All six were unique; duplicate count was zero. Minimum profit rate was 42.86%, strictly above 30%. CAPTCHA, soft block, browser crash, worker failure, and supervisor runtime failure were all zero.

## Decision

The source-ranking hypothesis is accepted. Freeze this source policy, run the complete test suites, and then start a new continuous 30-minute formal acceptance window. The formal window must use adjacent, unconsumed pages from the same winning sellers plus a bounded exploration tail; it must not count this 10-minute window.
