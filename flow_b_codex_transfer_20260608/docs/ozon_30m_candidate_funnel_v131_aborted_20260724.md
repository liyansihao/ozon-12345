# Ozon formal v131 aborted launch (2026-07-24)

v131 was stopped at preflight runtime validation and is **not an acceptance
window**.

- configured continuous window: 14:16:16–14:46:16 CST
- stopped: approximately 14:19 CST
- `acceptance_target`: 15
- inherited consumer `publish_target`: 5
- cause: `FLOW_B_TARGET_PUBLISH_COUNT` remained 5 while
  `FLOW_B_ACCEPTANCE_TARGET` was correctly set to 15
- supervisor and child processes: terminated and reaped
- evidence directory preserved:
  `runs/flow_b/20260724_141457_ozon30m_v131`

The mismatch would stop candidate supply after five publications, so the run
could not possibly validate a 15-final target. Per the continuous-window rule,
the partial interval is discarded and a new complete 30-minute window will be
started with both targets set to 15.

No production code or business rule changed.
