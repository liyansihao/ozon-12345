# Ozon formal 30-minute v131b report (2026-07-24)

## Final result

**NOT PASS.** The corrected formal window ran continuously from
`2026-07-24T06:22:39.611Z` to `2026-07-24T06:52:39.611Z`
(14:22:39–14:52:39 CST).

| Metric | Required | Actual |
|---|---:|---:|
| continuous duration | 30 min | 30 min |
| ERP/Ozon strict final unique SKU | >=15 | 6 |
| effective final rate | >=30/hour | 12/hour |
| minimum successful profit | >30% | 52.90% |
| duplicate SKU | 0 | 0 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 | 0 / 0 / 0 |
| runtime errors | 0 | 0 |

Four finals went to store 106637 and two to store 106646. All six were counted
only after strict ERP/Ozon final confirmation.

## Funnel

- collection attempts: 42
- real detail/category checks: 26
- non-pure FBS: 16
- prohibited category: 2
- missing shipping mode: 1
- entered 1688: 26
- reliable cost / profit calculation: 7
- 1688 no reliable match: 15
- bounded 1688 health deferrals: 4
- profit `<=30%`: 1
- strict submissions in the window: 6
- strict finals in the window: 6

The formal failure was candidate quality, not transport or supervisor
stability. Reliable-cost conversion fell from v130's 13/16 (81.3%) to 7/26
(26.9%) after the high-quality retained head was consumed.

## Latest source evidence

The productive sources in this window were concentrated:

| Source | Detail cards | Real FBS | Submitted | Final |
|---|---:|---:|---:|---:|
| Jicha ¥500 rating | 4 | 3 | 3 | 1 in-window |
| Jicha base | 4 | 2 | 1 | 1 in-window |
| Vse v dome base | 8 | 2 | 1 | 1 in-window |
| Magazin Puhovikov | 1 | 1 | 1 | pending at deadline |

Jicha produced four submissions from eight detail cards, while the long tail
produced most of the 15 no-match outcomes. The next single variable is therefore
an exact source portfolio limited to the next unseen pages of these proven
full-funnel families. It does not infer FBS or cost; every SKU still passes the
unchanged real checks.

## Runtime

- run: `runs/flow_b/20260724_142017_ozon30m_v131b`
- commit: `342696bb67e083ee76770ee60ea49062a6b05c9a`
- publish target: 15
- acceptance target: 15
- supervisor/browser owner: exited normally / one owner
