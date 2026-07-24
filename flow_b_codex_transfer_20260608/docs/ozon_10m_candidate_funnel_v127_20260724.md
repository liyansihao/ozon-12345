# Ozon candidate-funnel v127 report (2026-07-24)

## Result

**NOT PASS; the exact title-derived search portfolio was rejected.** The
continuous window ran from `2026-07-24T05:22:34.869Z` to
`2026-07-24T05:32:34.869Z` (13:22:34–13:32:34 CST).

- strict final confirmations: 0
- effective rate: 0/hour
- exact allowlist entries: 12
- distinct dispatched source families: 4
- admissible listing-FBS cards: 0
- detail / 1688 / submit / final: 0 / 0 / 0 / 0
- CAPTCHA / soft block / crash: 0 / 0 / 0
- duplicate SKU count: 0

## Single-variable result

v127 replaced the exhausted dynamic portfolio with an exact allowlist generated
from the two latest strict v124b winner titles. Existing dispatch deduplication
correctly collapsed page variants to one representative per query and price
band, leaving four distinct searches.

The search evidence showed that title derivation did not preserve product
identity:

- `полный привод` returned eight local automotive mats, brake pads, and drive
  components, rather than the successful Mercedes-Benz toy.
- `шорты море твоем` returned eight visually related shorts, but every card
  reported shipping mode `暂无数据`; none had exact listing-FBS evidence.

All four source pages therefore had
`eligible_link_count_before_collection=0`. The source portfolio did not
improve the final metric and will not be retained.

## New bottleneck and next variable

Russian-word-only title extraction dropped the winner's Latin brand/model
tokens and produced a semantically broad query. More importantly, the current
seller front pages and previously used variants have been exhausted by durable
SKU deduplication.

The next single variable is source selection only: exact next-unseen result
pages for seller families with historical full-funnel success. The frontier is
derived from all persisted source-scan records, for example Pervyy Transport
page 2, Miaowu page 4, Kids Wheels page 4, Wizzal page 6, Nature page 6, and
equivalent next pages for other historically productive sellers.

No production code, Ozon interval, pure-FBS verification, 1688 reliability,
P70 cost, profit threshold, store rotation, state persistence, deduplication,
inventory, submission, or final-confirmation rule changes.

## Runtime

- run: `runs/flow_b/20260724_132143_ozon10m_v127`
- commit: `9ee9548a656d0295076b0841e1886ba9c7e39532`
- supervisor: exited normally
- browser owner: one
