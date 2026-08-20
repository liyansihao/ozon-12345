# Ozon candidate funnel v114 — 2026-07-23

## Result

- Status: NOT PASS (window stopped on the first Ozon soft block)
- Frozen commit: `7ae70b1991`
- Run: `runs/flow_b/20260723_175610_ozon10m_v114`
- Planned window: `2026-07-23 17:57:55–18:07:55 CST`
- Actual automated access: `2026-07-23 17:57:59–18:02:02 CST`
- Final confirmed publishes: 0
- Ozon CAPTCHA / soft block / crash: 0 / 1 / 0

## Funnel before the stop

| Stage | Count | Rate |
|---|---:|---:|
| Distinct source-page scans | 6 | — |
| Candidate discoveries | 9 | — |
| Pure-FBS candidates | 0 | 0% |
| non-pure-FBS rejections | 7 | 100% of classified candidates |
| Reliable 1688 costs | 0 | — |
| Final publishes | 0 | 0/hour |

The soft block was detected at `18:02:02 CST` on SKU `1710665972`. The controller stopped the
window immediately; the browser was then closed and a process check confirmed that no supervisor
or port-9223 browser owner remained.

## Single-variable finding

The v113 change correctly made the detail-stage non-FBS budget common to search pages and sorting
variants, but it did not remove equivalent variants from the source-scan schedule. Before the stop,
all six source requests still targeted the same query and `150.000;` price band:

- `sorting=discount&page=3`
- `sorting=discount&page=2`
- base
- `page=2`
- `page=3`
- `sorting=discount`

Thus the detail gate stopped further expensive classification after the low-yield evidence, but
source scanning continued to spend the global Ozon slots on the same exhausted search family.
This is the current source-discovery bottleneck and also adds avoidable Ozon traffic.

## Next controlled variable

Deduplicate search page/sorting variants at the dispatch boundary while preserving distinct search
text and price bands. Seller-page variants, final pure-FBS verification, 15-second global Ozon
interval, 1688 reliability rules, profit rules, store rotation, persistence, and final confirmation
remain unchanged. A new real sample starts only after the soft-block cooldown.
