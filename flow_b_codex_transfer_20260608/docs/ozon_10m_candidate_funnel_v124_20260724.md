# Ozon candidate-funnel v124 report (2026-07-24)

## Result

**NOT PASS / blocked by repeated CAPTCHA.** The formal window ran continuously
from `2026-07-24T03:47:44.809Z` to `2026-07-24T03:57:44.809Z`
(11:47:44–11:57:44 CST).

The run used commit `2488ac3e150724639232cbba2e045463bfc63271`
plus working-tree diff SHA-256
`24f1dfd401e723cbb243288b77de195984d8b8df7b4394f6cf5bf647ac7a7d3e`.
The single variable was to count only listing cards with exact plugin FBS
evidence when deciding whether a source is exhausted. There was no source
checkpoint seed and the global Ozon interval remained 15 seconds.

| Metric | v121 | v123 | v124 |
|---|---:|---:|---:|
| new candidate cards | 14 | 3 | 3 |
| listing cards admitted without exact FBS evidence | 0 | 0 | 0 |
| real detail results | 14 | 3 | 0 |
| new submissions | 4 | 1 | 0 |
| new strict final confirmations | 1 | 0 | 0 |
| CAPTCHA / soft block / crash | 0 / 0 / 0 | 0 / 0 / 0 | 1 / 0 / 0 |

One strict publication appeared in the run summary, SKU `4328869415` at
43.64% profit. It was a v123 cross-run pending submission and is excluded from
v124 new throughput.

## Access timeline

The source scanner completed three rate-limited source operations:

1. Kids Wheels
2. Miaowu page 3
3. Pervyy Transport

It admitted exactly three card-FBS candidates: `3218448508`, `2099895316`,
and `2794103740`. The first detail operation for `3218448508` started at
11:49:06 and detected CAPTCHA at 11:49:19.

The unified controller then issued no Ozon requests for ten minutes. It
reopened the same operation once at 11:59:19; CAPTCHA remained, so the
controller persisted `requires_manual_clear=true` and stopped at 11:59:20.
There was no repeated automatic retry, profile switch, or second browser
owner.

## Interpretation

This window cannot measure the effect of FBS-qualified source exhaustion:
CAPTCHA stopped the funnel before the first real detail result and before any
1688 lookup. The variable is therefore neither accepted nor rejected from
v124.

The three admitted rows all had exact card evidence `发货模式：FBS`, so the
entry gate behaved as designed. Real detail verification remains mandatory and
was not bypassed.

## Runtime state

- run directory: `runs/flow_b/20260723_205540_ozon10m_v124`
- launcher PID during the window: `72130`
- unique browser owner PID: `13078`
- duplicate SKU count: `0`
- new reliable 1688 costs: `0`
- new strict final confirmations: `0`
- new final rate: `0/hour`
- supervisor: exited after the bounded reopen failed
- browser owner: retained for manual CAPTCHA completion

## Next action

Complete the visible Ozon CAPTCHA manually. After confirmation, clear only the
persisted manual-stop flag, retain all deduplication and pending-submission
state, and start a new full 10-minute window with the same code and settings.
No performance variable should change before that controlled rerun.
