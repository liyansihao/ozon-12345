# v134 10-minute exact-page dispatch sample

## Result

- Run: `runs/flow_b/20260724_154500_ozon10m_v134`
- Window: 2026-07-24 15:45:45–15:55:45 CST
- Frozen commit: `1a51a6fe650d21db608f01e91628c151346433b8`
- Strict final confirmations: 0/5 (NOT PASS)
- Exact source URLs configured/scanned: 10/10
- Detail/cost attempts: 10
- ERP submissions: 6
- CAPTCHA / soft block / browser crash / runtime error: 0 / 0 / 0 / 0

## Dispatch regression result

The exact-page regression is fixed in production behavior:

- both page 4 and page 5 were scanned in the same supervisor window;
- all ten exact allowlisted URLs have a checkpoint row;
- the producer crossed multiple three-source tranches instead of stopping
  after the first page of each family;
- global Ozon access remained serialized at the unchanged 15-second minimum.

This directly reverses v133, where 15 configured URLs produced only five
checkpoint rows and no page after page 3 was visited.

## Funnel

| Stage | Count |
|---|---:|
| Collection attempts | 11 |
| Pure-FBS detail passes | 10 |
| Reliable 1688 cost | 7 |
| Profit >30% / ERP submissions | 6 |
| Final confirmed in window | 0 |

Eliminations were `non-pure-fbs=1`, `1688-no-reliable-match=2`,
`profit_rate<=30=1`, plus one recoverable `1688-health-deferred`.

All six submissions remained in `reconciliation-import-pending` at the
deadline.  The source-dispatch modification therefore passed its intended
behavioral test, but the user-facing small-sample gate did not pass because
strict final confirmation was zero.  The next run must remain a fresh
10-minute gate, carry these pending states forward, and continue the same
exact-page strategy without another code or policy change.
