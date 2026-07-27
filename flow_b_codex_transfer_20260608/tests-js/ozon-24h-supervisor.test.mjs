import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildLaunchdPlist,
  capacityPreflightDecision,
  classifyWorkerFailure,
  currentRunDisposition,
  nextRestartDelaySeconds,
  resolveProductionLayout,
  runFinalArtifacts,
} from "../scripts/ozon_24h_supervisor.mjs";

test("production layout is installed outside a disposable git worktree", () => {
  const layout = resolveProductionLayout({
    sourceRoot: "/Users/mac/.codex/worktrees/3d05/ozon",
    installRoot: "/Users/mac/.ozon-24h-production",
  });

  assert.equal(layout.installRoot, "/Users/mac/.ozon-24h-production");
  assert.equal(layout.appRoot, "/Users/mac/.ozon-24h-production/app");
  assert.equal(layout.stateRoot, "/Users/mac/.ozon-24h-production/state");
  assert.equal(layout.entryScript, "/Users/mac/.ozon-24h-production/app/scripts/ozon_24h_production.sh");
  assert.equal(layout.entryScript.includes(".codex/worktrees"), false);
});

test("capacity preflight waits for reset and never opens an under-capacity window", () => {
  assert.deepEqual(capacityPreflightDecision({
    all_stores_found: true,
    all_warehouses_verified: true,
    all_quotas_verified: true,
    total_remaining_capacity: 469,
    next_reset_at: "2026-07-27T16:00:00.000Z",
  }), {
    action: "wait-for-quota-reset",
    reason: "insufficient-current-day-capacity",
    next_reset_at: "2026-07-27T16:00:00.000Z",
  });
  assert.equal(capacityPreflightDecision({
    all_stores_found: true,
    all_warehouses_verified: true,
    all_quotas_verified: true,
    total_remaining_capacity: 481,
  }).action, "start-formal-window");
  assert.equal(capacityPreflightDecision({
    all_stores_found: true,
    all_warehouses_verified: false,
    all_quotas_verified: true,
    total_remaining_capacity: 500,
  }).action, "fatal-stop");
});

test("launchd restarts abnormal exits without busy-looping a completed window", () => {
  const plist = buildLaunchdPlist({
    label: "com.codex.ozon.24h-production",
    entryScript: "/Users/mac/.ozon-24h-production/app/scripts/ozon_24h_production.sh",
    stateRoot: "/Users/mac/.ozon-24h-production/state",
  });

  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.match(
    plist,
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/u,
  );
  assert.match(plist, /<string>supervise<\/string>/u);
  assert.doesNotMatch(plist, /\.codex\/worktrees|gitdir|git rev-parse/u);
});

test("launchd supervisor exits successfully when no daily run is active", () => {
  assert.equal(currentRunDisposition(null), "idle");
  assert.equal(currentRunDisposition({}), "idle");
  assert.equal(currentRunDisposition({ run_id: "partial" }), "invalid");
  assert.equal(currentRunDisposition({
    run_id: "20260728_ozon_24h",
    run_dir: "/tmp/run",
    urls_file: "/tmp/sources.txt",
  }), "active");
});

test("browser and CDP failures recover the same run with bounded backoff", () => {
  for (const message of [
    "connect ECONNREFUSED 127.0.0.1:9223",
    "browserContext.newPage: Target page, context or browser has been closed",
    "page.goto: net::ERR_CONNECTION_RESET",
  ]) {
    assert.deepEqual(classifyWorkerFailure({ message, profileOwnerCount: 0 }), {
      action: "restart-browser-and-worker",
      reason: "browser-or-network-recoverable",
    });
  }

  assert.deepEqual(
    [0, 1, 2, 3, 20].map((attempt) => nextRestartDelaySeconds(attempt)),
    [30, 60, 120, 120, 120],
  );
});

test("security checks wait in-place and duplicate profile owners hard-stop", () => {
  assert.deepEqual(classifyWorkerFailure({
    message: "Ozon CAPTCHA slider verification required",
    profileOwnerCount: 1,
  }), {
    action: "wait-for-verification",
    reason: "security-verification-required",
  });

  assert.deepEqual(classifyWorkerFailure({
    message: "ordinary worker exit",
    profileOwnerCount: 2,
  }), {
    action: "fatal-stop",
    reason: "duplicate-profile-owner-risk",
  });
});

test("window finalization reconstructs a missing report before exporting five-store CSVs", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-final-state-"));
  const runDir = path.join(stateRoot, "runs", "formal");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "acceptance_window.json"), JSON.stringify({
    started_at: "2026-07-27T00:00:00.000Z",
    ended_at: "2026-07-28T00:00:00.000Z",
  }));
  await fs.writeFile(path.join(runDir, "source_config.json"), JSON.stringify({
    acceptance_target: 481,
    per_store_target: null,
    store_targets: [{ id: 104965, needle: "丽丽1号" }],
  }));
  await fs.writeFile(path.join(runDir, "published.jsonl"), `${JSON.stringify({
    status: "published",
    sku: "123456",
    data: {
      store_id: 104965,
      store_name: "丽丽1号",
      profit_rate: 31,
      online_status: "selling",
      stock: 1,
      published_at: "2026-07-27T01:00:00.000Z",
    },
  })}\n`);
  const result = await runFinalArtifacts(
    path.resolve(import.meta.dirname, ".."),
    stateRoot,
    { run_id: "formal" },
    runDir,
  );
  assert.equal(result.output, path.join(stateRoot, "exports", "formal"));
  assert.equal(result.report.success_count, 1);
  assert.equal(result.report.passed, false);
  await fs.access(path.join(result.output, "24h_report.json"));
  await fs.access(path.join(result.output, "confirmed_all_stores.csv"));
  await fs.access(path.join(result.output, "confirmed_store_104965.csv"));
  await fs.rm(stateRoot, { recursive: true, force: true });
});
