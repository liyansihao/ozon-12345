# v135 10-minute exact-page continuation gate

## Result

- Run: `runs/flow_b/20260724_155700_ozon10m_v135`
- Window: 2026-07-24 15:58:14–16:08:14 CST
- Frozen commit: `6f783fc20d9144bfaa5a3263b2439f96d8f6d95a`
- Strict final confirmations: 0/5 (NOT PASS)
- Exact source checkpoint rows: 10
- Collection attempts: 15
- Detail/cost attempts: 12
- New ERP submissions: 6
- CAPTCHA / soft block / browser crash / runtime error: 0 / 0 / 0 / 0

The exact-page producer continued normally through pages 6 and 7.  Funnel
losses were `non-pure-fbs=3`, `oversized-low-yield-title=1`,
`1688-no-reliable-match=5`, and `profit_rate<=30=1`.

The six v134 submissions still produced no in-window strict final success:
one reached a terminal duplicate-platform rejection, two reached
`all_imported` but not yet selling, and three remained in the ERP import
queue.  v135 added six more strict submissions.  No submission or pending
state was counted as success.

The source-dispatch regression remains fixed and the source funnel continues
to produce at the required rate, but the formal-entry gate remains NOT PASS
until a new continuous ten-minute window records at least five strict final
confirmations.
