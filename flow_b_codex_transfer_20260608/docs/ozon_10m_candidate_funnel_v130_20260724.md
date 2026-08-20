# Ozon candidate-funnel v130 report (2026-07-24)

## Result

**Formal-entry gate PASS; 10-minute final target narrowly NOT PASS.** The
continuous window ran from `2026-07-24T06:01:56.992Z` to
`2026-07-24T06:11:56.992Z` (14:01:56–14:11:56 CST).

| Metric | v100 | v130 |
|---|---:|---:|
| strict finals | 6 / 30 min | 4 / 10 min |
| effective final rate | 12/hour | 24/hour |
| collection attempts | 79 | 20 |
| non-pure FBS | 48 (60.8%) | 3 (15.0%) |
| entered 1688 | 29 | 16 |
| reliable 1688 cost | 14 / 29 (48.3%) | 13 / 16 (81.3%) |
| strict submissions | 10 / 30 min | 9 / 10 min |
| CAPTCHA / soft block / crash | 0 / 0 / 0 | 0 / 0 / 0 |

The four ERP/Ozon strict finals were unique, all in store 106637, with minimum
profit 39.69%. Duplicate count was zero.

The run missed the five-final strict 10-minute target by one, but its 24/hour
observed final rate is close to the requested 30/hour entry threshold and its
submission rate was 54/hour. It therefore satisfies the user's explicit
"达到或接近 30 个/小时" condition for entering a full 30-minute window.

## Single-variable effect

v130 changed only `FLOW_B_MAX_RETAINED_LINKS` from 0 to the existing bounded
default of 12. The evidence-only checkpoint contained 99 globally untouched
exact-FBS cards at launch.

The retained replay immediately changed the funnel:

- 17 real Ozon detail/category checks completed;
- 16 entered 1688;
- 13 obtained reliable costs;
- 9 passed strict profit and were submitted;
- 4 reached strict final state inside the window.

No source-frequency, detail-frequency, FBS, 1688, P70, profit, store, inventory,
deduplication, submission, or final-confirmation rule changed.

## Remaining timing loss

ERP store synchronization repeatedly returned the explicit platform message
`所选店铺同步过于频繁，请3分钟后再试`. New strict submissions were available by
minute 4:24, but the first effective store-106637 sync occurred late in the
window. Four finals arrived between minute 7:34 and minute 9:15; the remaining
qualified submissions were still pending when the strict window closed.

The formal run will start only after a three-minute quiet interval, honoring
the platform's stated cooldown. This is a run precondition, not a code or
business-rule change.

## Verification

- tested commit: `196394012d68c2a3317e1d70f8af5411307c2be7`
- prior complete Node tests after the retained-scanner code: 442 / 442
- prior complete Python tests: 13 / 13
- run: `runs/flow_b/20260724_140042_ozon10m_v130`
- supervisor: exited normally
- browser owner: one
