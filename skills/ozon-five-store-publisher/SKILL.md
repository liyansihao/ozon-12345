---
name: ozon-five-store-publisher
description: Operate, diagnose, optimize, test, hand off, and report the Playwright Ozon-to-Maozi ERP five-store publishing pipeline in this repository. Use for 24-hour acceptance runs, strict-profit SKU publication, store rotation, Ozon/FBS/1688 bottleneck work, persistent browser-session recovery, per-store SKU CSV export, or compact live status reporting.
---

# Ozon Five Store Publisher

Keep one live-run owner. Let other agents inspect code, analyze artifacts, write tests, or prepare patches, but never let two processes use the same Playwright persistent profile.

## Start every task

1. Locate the project root and latest active run; do not assume a stale run name.
2. Read `references/runtime-contract.md` completely before changing runtime behavior or reporting acceptance.
3. Inspect `git status --short --branch`; preserve unrelated and runtime-generated changes.
4. Capture a compact status snapshot before editing or restarting anything.
5. Determine whether the request is read-only, diagnostic, implementation, or live operation. Do not mutate a live store for a review-only request.

## Choose the role

- **Observer/reviewer:** Read status, JSONL tails, timings, source yield, and tests. Do not launch or control the browser.
- **Code worker:** Write a failing regression first, implement the smallest measured optimization, run targeted then full tests, and do not restart the live process.
- **Live-run owner:** Verify there is exactly one supervisor/browser owner before any launch, reload, login recovery, or store action. Preserve the acceptance window and persisted state during safe reloads.

If ownership is unclear, stay read-only and report the process evidence. Never compete for the persistent profile.

## Diagnose with compact evidence

Run from `flow_b_codex_transfer_20260608`:

```bash
node scripts/flow_b_status_snapshot.mjs RUN_DIR --compact
```

Prefer bounded queries such as `tail`, `rg`, compact JSON, and stage aggregates. Do not paste whole JSONL or console logs into context. Compare at least:

- strict confirmations over 15/30/60/120 minutes;
- selected, submitted-pending, strict, terminal, and runtime-error counts;
- Ozon source/detail soft blocks and adaptive pacing;
- pure-FBS favorite yield, 1688 reliability, exact-profit pass rate, publication latency;
- per-source attempted → favorite → selected → strict yield;
- per-store selected, strict, daily usage, lifetime usage, and switch events.

Identify the constrained stage before changing concurrency. Never relax FBS, title/image/category, reliable-same-item, or strict-profit gates to improve throughput.

## Implement safely

1. Add or update a regression test before the code change.
2. Keep failures append-logged and continue to the next SKU.
3. Preserve durable queue/cache/state compatibility and duplicate prevention.
4. Treat Ozon soft blocks as backpressure; lower concurrency or preserve a quiet recovery window.
5. Keep 1688 workers long-lived and cached; normalize summary reasons while retaining raw evidence in SKU state.
6. Run the relevant targeted tests, then all Node and Python tests.
7. Load code only at a safe batch boundary with no reasonless/unsubmitted critical state. Avoid speculative restarts because they reset adaptive pacing and add shutdown noise.

## Operate the live browser

- Use the existing persistent Playwright profile and extension login state.
- If ERP reports a full device limit, follow the authorized device takeover flow and remove/replace the oldest session when necessary.
- Never bypass CAPTCHA, slider verification, MFA, or another security check. Pause the run and let the user complete the check in the same profile, then verify authentication and resume.
- If a store lacks a uniquely verified warehouse ID, keep its 5-minute sync/reprobe loop and skip it temporarily. Never infer an adjacent ID.
- Do not stop the full run after an isolated SKU, timeout, no-match, soft block, or moderation failure.

## Export and report

Generate selected and strict-confirmed CSVs into independent output directories; never point an exporter at the live run directory. Use the exact CLI ordering in the runtime contract.

Report only current-window unique strict confirmations as acceptance results. Include count, effective rate/hour, stage timing, elimination reasons, error rate, per-store strict counts, CSV paths, and whether the stated threshold passed. Say plainly when 35/hour or 5×100 has not been sustained.

## Hand off

Provide the next agent with:

- repository path, branch, latest task-only commit, and dirty files to preserve;
- active run directory, acceptance window, supervisor/child identity, and ownership status;
- compact strict/selected/pending/error figures plus rolling rates;
- active cooldown/pacing, unresolved login or warehouse evidence, and next safe action;
- current-run selected and confirmed CSV paths.

Do not hand off a claim based on selected or pending rows as if they were strict publications.
