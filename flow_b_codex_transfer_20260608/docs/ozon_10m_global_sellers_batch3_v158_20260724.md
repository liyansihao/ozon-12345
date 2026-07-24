# v158 10-minute global-seller batch-3 gate

- Run: `runs/flow_b/20260724_231300_ozon10m_v158`
- Frozen commit: `097352abcd561782edc2bbd00c43dca950b09e7b`
- Window: 2026-07-24 23:13:43–23:23:43 CST
- Single variable: replace exhausted winner deep pages with 26 previously unconsumed global sellers
- Continued state: store 106637's confirmed real daily limit was restored, so the run started from the next available store instead of producing another known failed submission

## Result

NOT PASS.

| Metric | Result |
|---|---:|
| Strict finals | 1 carryover / 0 new |
| Effective final rate | 6/hour |
| Detail/category checks | 11 |
| 1688 cost checks | 10 |
| Profit calculations | 2 |
| New submissions | 1 |
| `1688-no-reliable-match` | 6 |
| Non-pure-FBS / missing mode | 3 / 1 |
| Runtime failures | 0 |

The only strict final was v157 pending SKU 2165584505 (39.61%, 丽丽五号). The batch's one new submission, SKU 4894286573 (30.65%, 丽丽三号), did not reach strict final status inside the window.

CAPTCHA, soft block, browser crash, duplicate SKU, and supervisor runtime error were all zero. The source variable produced no new strict final and is rejected.

## Next analysis

A joint v100–v158 history scan shows that several proven seller families still have adjacent pages that were never scanned:

- `nature-3460296`: 18 historical strict finals, 4.73 eligible listing links per scan; pages 15+ unscanned and page 14 has a final.
- `fluff-joy`: eight strict finals, 3.57 eligible links per scan; pages 20+ unscanned.
- `okday-magazin-igrushek`: one strict final, 3.39 eligible links per scan; only pages 1–3 scanned.
- `aaron250`: one strict final from its only scanned page, three eligible links; pages 2+ unscanned.
- `upcloud-international`: one strict final, 2.05 eligible links per scan; pages 5+ unscanned.

The next single variable is a score-ranked mix of these remaining adjacent pages. It does not reuse the failed batch-3 seller set.
