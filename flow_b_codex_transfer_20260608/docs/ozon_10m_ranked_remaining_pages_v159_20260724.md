# v159 score-ranked remaining-page gate

- Run: `runs/flow_b/20260724_233000_ozon10m_v159`
- Frozen commit: `b908ffa6c4b0ee27f836046367e4740e5b26bdee`
- Window: 2026-07-24 23:27:37–23:37:37 CST
- Single variable: replace unproven global sellers with unscanned adjacent pages from historically proven seller families

## Result

NOT PASS: two strict finals, 12/hour.

Both strict finals came from fresh `nature-3460296` pages:

| SKU | Source | Profit | Store |
|---|---|---:|---|
| 4435054651 | page 16 | 87.90% | 丽丽五号 |
| 4128302914 | page 18 | 70.00% | 丽丽五号 |

Nine details yielded six reliable costs, two submissions, and two strict finals. Elimination was three `1688-no-reliable-match`, four `profit_rate<=30`, and one duplicate title. Duplicate final SKU, CAPTCHA, soft block, browser crash, and runtime failures were all zero.

The variable improved on v158 but did not reach five finals. Eighteen source pages were scanned; only four pages produced eligible links. The unfiltered deep-page portfolio is still too sparse.

## Timeline audit

The Ozon access timeline often has two rows with the same source URL. Code inspection confirmed these are the controller's `started` and `succeeded` records around one operation, not two navigations. No duplicate-navigation optimization is warranted.

## Next single variable

Historical exact-query grouping found higher-density unscanned adjacent pages:

| Exact source variant | Historical finals | Eligible/scan | Scanned pages |
|---|---:|---:|---|
| `nature + currency_price=500 + rating` | 3 | 5.43 | 1–9 |
| `kids-wheels + currency_price=500 + discount` | 2 | 3.87 | 1–3 |
| `fluff-joy + currency_price=500 + rating` | 1 | 3.63 | 1–3 |
| `pervyy-transport + currency_price=500 + rating` | 1 | 3.33 | 1 |
| `fluff-joy + currency_price=1000 + rating` | 1 | 3.00 | 1 |

Test only the next unscanned pages of these exact variants. Preserve the 15-second controller interval and all strict business rules.
