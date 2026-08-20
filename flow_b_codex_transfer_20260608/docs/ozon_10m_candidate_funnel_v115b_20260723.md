# Ozon candidate funnel v115b — 2026-07-23

## Result

- Status: NOT PASS
- Frozen commit: `6657bd89cb`
- Run: `runs/flow_b/20260723_181610_ozon10m_v115b`
- Continuous window: `2026-07-23 18:17:25–18:27:25 CST`
- Final confirmed publishes: 0 (`0/hour`)
- Ozon CAPTCHA / soft block / crash: `0 / 0 / 0`
- Runtime errors: 0

The preceding v115 process emitted no Ozon request: it stopped on the persisted v114 safety lock.
The lock evidence was copied into the v115 run, the full ten-minute cooldown was honored, and the
lock was cleared only after the user's explicit confirmation that Ozon was normal. v115b is the
new, independently timed real window.

## Funnel

| Stage | Count | Rate |
|---|---:|---:|
| Source-page requests | 10 | — |
| Candidate discoveries | 36 | — |
| Classified candidates | 24 | — |
| Pure-FBS passes | 0 new | 0% |
| non-pure-FBS | 23 | 95.8% |
| Prohibited category | 1 | 4.2% |
| Reliable 1688 costs | 0 | — |
| Final publishes | 0 | 0/hour |

Two queue rows were marked `favorited` because their SKUs already existed in the durable favorite
state; neither was a newly verified candidate or a new final publication and neither is counted.

## Single-variable comparison

The v115 dispatch deduplication worked inside each producer tranche: the first three source requests
covered one search family and a seller family instead of three equivalent search variants. However,
the next producer tranche rebuilt `pending` from an exact-URL checkpoint. It then selected the next
page/sorting URL for the same family.

Across the full window, ten source requests represented only:

1. the same `металлическая модель коллекции`, `150.000;` search family;
2. `fluff-joy` seller variants;
3. `upcloud-international` seller variants.

The first search family appeared in three tranches. `fluff-joy` occupied five requests across
price/page/sorting variants despite producing no new pure-FBS candidate. Therefore the current
largest loss is not the 15-second interval or detail execution; it is exact-URL completion state
allowing the same dry source family to be consumed again after every tranche.

## Next controlled variable

Use the existing source-yield family key (same source and price band, ignoring page and sorting) for
both dispatch deduplication and completed-checkpoint exclusion. Distinct search text, price bands,
and sellers remain separate. The final detail verification, 15-second Ozon gate, 1688 matching,
P70 cost, profit threshold, store rotation, persistence, deduplication, and final confirmation are
unchanged.
