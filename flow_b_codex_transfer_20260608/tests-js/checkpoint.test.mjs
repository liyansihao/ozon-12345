import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCheckpoint, matchesRunCommand } from "../scripts/flow_b_checkpoint.mjs";

test("checkpoint liveness matches relative and absolute run directory command lines", () => {
  const absolute = "/workspace/project/runs/flow_b/20260721_v63";
  assert.equal(matchesRunCommand("run_acceptance_supervised.sh runs/flow_b/20260721_v63 urls.txt", absolute), true);
  assert.equal(matchesRunCommand(`flow_b_playwright.mjs accept ${absolute} urls.txt`, absolute), true);
  assert.equal(matchesRunCommand("run_acceptance_supervised.sh runs/flow_b/another-run urls.txt", absolute), false);
});

test("checkpoint reports interval/cumulative strict truth, funnel, failures, and profit floor", async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-checkpoint-"));
  t.after(() => fs.rm(runDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(runDir, "acceptance_window.json"), JSON.stringify({
    started_at: "2026-07-21T00:00:00.000Z",
    ended_at: "2026-07-22T00:00:00.000Z",
  }));
  await fs.writeFile(path.join(runDir, "source_config.json"), JSON.stringify({
    store_targets: [{ id: 1, needle: "one" }], per_store_target: 100, watermark_id: 60822,
  }));
  await fs.writeFile(path.join(runDir, "candidate_queue.jsonl"), [
    { at: "2026-07-21T00:01:00.000Z", status: "discovered", sku: "a" },
    { at: "2026-07-21T00:02:00.000Z", status: "discovered", sku: "b" },
  ].map(JSON.stringify).join("\n"));
  await fs.writeFile(path.join(runDir, "stage_timings.jsonl"), [
    { at: "2026-07-21T00:03:00.000Z", sku: "a", stage: "1688_cost", duration_ms: 100, ok: true },
    { at: "2026-07-21T00:04:00.000Z", sku: "a", stage: "profit_calculation", duration_ms: 20, ok: true },
  ].map(JSON.stringify).join("\n"));
  await fs.writeFile(path.join(runDir, "selected.jsonl"), `${JSON.stringify({ sku: "a", timestamp: "2026-07-21T00:05:00.000Z", data: { store_id: 1, profit_rate: 31 } })}\n`);
  await fs.writeFile(path.join(runDir, "published.jsonl"), [
    { sku: "a", timestamp: "2026-07-21T00:06:00.000Z", published_at: "2026-07-21T00:06:00.000Z", store_id: 1, profit_rate: 31, online_status: "selling", stock: 1 },
    { sku: "a", timestamp: "2026-07-21T00:07:00.000Z", published_at: "2026-07-21T00:07:00.000Z", store_id: 1, profit_rate: 31, online_status: "selling", stock: 1 },
    { sku: "b", timestamp: "2026-07-21T00:08:00.000Z", published_at: "2026-07-21T00:08:00.000Z", store_id: 1, profit_rate: 30, online_status: "selling", stock: 1 },
  ].map(JSON.stringify).join("\n"));
  await fs.writeFile(path.join(runDir, "failed.jsonl"), `${JSON.stringify({ at: "2026-07-21T00:09:00.000Z", reason: "worker-timeout", sku: "c" })}\n`);

  const checkpoint = await buildCheckpoint(runDir, "2026-07-21T02:00:00.000Z");
  assert.equal(checkpoint.cumulative.strict_successes, 1);
  assert.equal(checkpoint.cumulative.duplicate_skus, 1);
  assert.equal(checkpoint.cumulative.minimum_profit_rate, 31);
  assert.deepEqual(checkpoint.cumulative.funnel, { candidate: 2, cost_1688: 1, profit: 1, submitted: 1, final_confirmed: 1 });
  assert.equal(checkpoint.cumulative.failures["worker-timeout"], 1);
  assert.equal(checkpoint.interval.stage_timings["1688_cost"].p95_ms, 100);
});
