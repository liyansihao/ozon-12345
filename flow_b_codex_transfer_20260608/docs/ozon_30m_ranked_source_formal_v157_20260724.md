# v157 ranked-source formal 30-minute acceptance

## Result

NOT PASS. The window ran continuously for the full 30 minutes but produced only six ERP/Ozon strict final confirmations, or 12/hour, below the required 15 and 30/hour.

## Frozen baseline

- Commit: `c043c8c255c7ad756cf0d07af2f1442786105673`
- Run: `runs/flow_b/20260724_224000_ozon30m_v157`
- Window: 2026-07-24 22:39:42–23:09:42 CST
- Preflight tests: Node 443/443, Python 13/13
- Source policy: v156 winner-seller deep/adjacent pages first, then rating/discount variants and an unconsumed global-seller exploration tail
- Preserved controls: one browser owner, 15-second Ozon global interval, strict listing FBS evidence, reliable 1688/P70, profit strictly above 30%, complete dedup and final confirmation

## Strict outcome

| Metric | Result |
|---|---:|
| Strict final unique SKU | 6 |
| Effective final rate | 12/hour |
| Duplicate SKU | 0 |
| Minimum profit rate | 44.26% |
| CAPTCHA / soft block / browser crash | 0 / 0 / 0 |
| Supervisor runtime failures | 0 |
| Store 106637 / 106646 finals | 5 / 1 |

Strict final products:

| SKU | Profit | Store | Source |
|---|---:|---|---|
| 2895627334 | 48.60% | 丽丽二号 | v156 page-3 pending, finalized in-window |
| 2335126777 | 61.13% | 丽丽二号 | v156 page-4 pending, finalized in-window |
| 3864743650 | 44.26% | 丽丽二号 | queued candidate |
| 4359375629 | 121.85% | 丽丽二号 | `devushka-nadezhda?page=7` |
| 2895594077 | 51.68% | 丽丽二号 | `guanhe...page=12` |
| 3057041567 | 45.42% | 丽丽五号 | `guanhe...page=13` |

## Funnel and failure evidence

| Stage | Count |
|---|---:|
| Source pages recorded | 34 |
| Source-page eligible links | 66 |
| Detail/category checks | 37 |
| 1688 cost checks | 36 |
| Profit calculations | 12 |
| ERP submissions | 7 |
| Strict final confirmations | 6 |

Collection elimination was 11 non-pure-FBS and three prohibited categories. Post-detail elimination was 19 `1688-no-reliable-match`, five `profit_rate<=30`, and one `profit-upper-bound<=30`. Five recoverable 1688 candidate-collapse events were deferred; there were no SSL transport regressions.

The winning seller's page-2 conversion in v156 did not persist through pages 7–20 or its sorting variants. Eleven of 34 scanned source pages produced zero eligible listing links, and reliable same-product matching became the dominant loss.

## Store recovery

ERP reported the real daily-product limit on store 106637. The supervisor preserved run state and automatically rotated:

1. 106637 → 106640 (`daily-product-limit`)
2. 106640 → 106644 (`submission-stall`)
3. 106644 → 106646 (`submission-stall`)

Store 106646 then produced a strict final success. No duplicate submission was observed.

## Next single variable

Reject the deep-page expansion as a sustained source policy. Keep all stable modules unchanged and test a fresh third batch of previously unconsumed global sellers, ordered for standardized products that are more likely to have a reliable 1688 same-product cluster. Do not start another formal window until a new 10-minute gate reaches at least five strict finals.
