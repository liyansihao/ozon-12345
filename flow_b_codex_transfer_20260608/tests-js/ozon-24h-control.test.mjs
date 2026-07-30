import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildIncidentDigest,
  compactProductionStatus,
  currentRunRetirementDecision,
  deploymentIdentityValid,
  refreshCurrentRunSources,
  resumeMode,
  shouldResumeCurrentRun,
  validateCandidateSourcePortfolio,
} from "../scripts/ozon_24h_control.mjs";

const current = {
  run_id: "20260727_223532_ozon_24h_production",
  run_dir: "/tmp/state/runs/20260727_223532_ozon_24h_production",
  urls_file: "/tmp/state/sources/active_urls.txt",
};

test("daily start resumes the same safely stopped pending or formal run", () => {
  assert.equal(shouldResumeCurrentRun({ status: "STOPPED" }, {
    ...current,
    formal_started: false,
  }), true);
  assert.equal(shouldResumeCurrentRun({ status: "STOPPED" }, {
    ...current,
    formal_started: true,
  }), true);
  assert.equal(shouldResumeCurrentRun({ status: "WAITING_FOR_QUOTA_RESET" }, current), true);
  assert.equal(shouldResumeCurrentRun({ status: "PREWARMING_CANDIDATES" }, current), true);
  assert.equal(shouldResumeCurrentRun({ status: "PREPARING_CANDIDATE_BUFFER" }, current), true);
  assert.equal(shouldResumeCurrentRun({
    status: "STOPPED",
    reason: "rolling-120-minute-strict-rate-below-threshold",
  }, {
    ...current,
    formal_started: true,
  }), false);
});

test("daily start never silently resumes fatal or completed state", () => {
  assert.equal(shouldResumeCurrentRun({ status: "FATAL_STOP" }, current), false);
  assert.equal(shouldResumeCurrentRun({ status: "WINDOW_COMPLETE" }, current), false);
  assert.equal(shouldResumeCurrentRun({ status: "TARGET_NOT_MET" }, current), false);
  assert.equal(shouldResumeCurrentRun({ status: "STOPPED" }, { run_id: "partial" }), false);
});

test("resume restarts the same checkpoint after an intentional safe stop", () => {
  assert.equal(resumeMode({ status: "STOPPED" }, current), "restart-current-run");
  assert.equal(resumeMode({ status: "WAITING_FOR_VERIFICATION" }, current), "verification");
  assert.equal(resumeMode({ status: "RUNNING" }, current), "wake-supervisor");
  assert.equal(resumeMode({ status: "STOPPED" }, { run_id: "partial" }), "wake-supervisor");
});

test("legacy production run can only be retired after a zero-owner safe stop", () => {
  assert.deepEqual(currentRunRetirementDecision({
    status: { status: "STOPPED", reason: "safe stop requested" },
    current: {
      ...current,
      formal_started: true,
      acceptance_target: 469,
      acceptance_target_policy: "erp_remaining_capacity",
    },
    owners: { supervisor: 0, worker: 0, profile: 0 },
  }), {
    action: "retire",
    reason: "superseded-by-fixed-500-v3",
  });
  assert.equal(currentRunRetirementDecision({
    status: { status: "RUNNING" },
    current,
    owners: { supervisor: 0, worker: 0, profile: 0 },
  }).action, "reject");
  assert.equal(currentRunRetirementDecision({
    status: { status: "STOPPED" },
    current,
    owners: { supervisor: 0, worker: 1, profile: 0 },
  }).action, "reject");
});

test("doctor release identity requires exact commit, config hash, source hash, and schema v3", () => {
  const configText = "{\"fixed\":true}\n";
  const valid = {
    source_commit: "a".repeat(40),
    config_sha256: crypto.createHash("sha256").update(configText).digest("hex"),
    source_set_sha256: "b".repeat(64),
    source_smoke_sha256: "c".repeat(64),
    state_schema_version: 3,
  };
  assert.equal(deploymentIdentityValid(valid, configText), true);
  assert.equal(deploymentIdentityValid({ ...valid, source_commit: "" }, configText), false);
  assert.equal(deploymentIdentityValid({ ...valid, config_sha256: "0".repeat(64) }, configText), false);
  assert.equal(deploymentIdentityValid({ ...valid, source_set_sha256: "" }, configText), false);
  assert.equal(deploymentIdentityValid({ ...valid, state_schema_version: 2 }, configText), false);
});

test("same-run resume refreshes the active source pool from the promoted release", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-24h-resume-sources-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const runDir = path.join(stateRoot, "runs", current.run_id);
  const urlsFile = path.join(stateRoot, "sources", "active_urls.txt");
  const seedFile = path.join(root, "candidate-seed.txt");
  const promotedSource = "https://www.ozon.ru/seller/verified-seller-12345/";
  const existing = {
    ...current,
    run_dir: runDir,
    urls_file: urlsFile,
    source_sha256: "old-source-hash",
  };
  await fs.mkdir(path.join(stateRoot, "history"), { recursive: true });
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(path.dirname(urlsFile), { recursive: true });
  await fs.writeFile(urlsFile, "https://www.ozon.ru/seller/old-source/\n");
  await fs.writeFile(seedFile, `${promotedSource}\n`);
  await fs.writeFile(path.join(stateRoot, "current_run.json"), `${JSON.stringify(existing)}\n`);

  const refreshed = await refreshCurrentRunSources({
    appRoot: path.resolve(import.meta.dirname, ".."),
    stateRoot,
    current: existing,
    seedFile,
  });

  assert.match(await fs.readFile(urlsFile, "utf8"), /seller\/verified-seller-12345/);
  assert.match(refreshed.source_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(refreshed.source_set_sha256, refreshed.source_sha256);
  assert.notEqual(refreshed.source_sha256, existing.source_sha256);
  assert.ok(Date.parse(refreshed.source_refreshed_at) > 0);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(stateRoot, "current_run.json"), "utf8")),
    refreshed,
  );
});

test("candidate source smoke check is isolated from production state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-candidate-source-smoke-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const releasesRoot = path.join(root, "releases");
  const productionState = path.join(root, "production-state");
  const productionSources = path.join(productionState, "sources", "active_urls.txt");
  const seedFile = path.join(root, "candidate-seed.txt");
  const sentinel = "https://www.ozon.ru/seller/current-production-source/\n";
  await fs.mkdir(path.dirname(productionSources), { recursive: true });
  await fs.writeFile(productionSources, sentinel);
  await fs.writeFile(seedFile, "https://www.ozon.ru/seller/candidate-source/\n");

  const result = await validateCandidateSourcePortfolio({
    appRoot: path.resolve(import.meta.dirname, ".."),
    releasesRoot,
    seedFile,
  });

  assert.equal(await fs.readFile(productionSources, "utf8"), sentinel);
  assert.match(result.sourceText, /seller\/candidate-source/);
  assert.match(result.sourceSetSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.activeSourceCount > 0, true);
  assert.deepEqual(
    (await fs.readdir(releasesRoot)).filter((name) => name.startsWith(".candidate-source-smoke-")),
    [],
  );
});

test("normal production status is bounded below two kilobytes", () => {
  const compact = compactProductionStatus({
    current: {
      run_id: "run-1",
      formal_started: true,
      config_sha256: "c".repeat(64),
      source_set_sha256: "s".repeat(64),
      state_schema_version: 3,
    },
    operational: {
      observed_at: "2026-07-29T00:00:00.000Z",
      status: "RUNNING",
      reason: "x".repeat(20_000),
      capacity_preflight: { giant: "not included".repeat(10_000) },
    },
    owners: { counts: { supervisor: 1, worker: 1, profile_owner: 1 } },
    checkpoint: {
      compact: {
        strict: 70,
        target: 500,
        rate_h: 35,
        rolling_h: { 120: 35 },
        by_store: { "1": 14, "2": 14, "3": 14, "4": 14, "5": 14 },
      },
    },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 2048);
  assert.equal(compact.reason.endsWith("…"), true);
  assert.equal(compact.owners.worker, 1);
});

test("incident digest groups repeated errors before bounded diagnosis", () => {
  const digest = buildIncidentDigest({
    failed: [
      { sku: "1", reason: "ERP 429 retry after 180 seconds" },
      { sku: "2", reason: "ERP 429 retry after 300 seconds" },
    ],
    skipped: [{ sku: "3", reason: "duplicate-title" }],
    runtimeErrors: [{ error: "browser closed" }],
    candidates: [{ sku: "1" }, { sku: "1" }, { sku: "2" }],
    selected: [{ sku: "1" }],
    published: [{ sku: "1" }],
    recoveries: Array.from({ length: 8 }, (_, index) => ({
      at: `2026-07-29T00:00:0${index}.000Z`,
      action: "restart-worker",
    })),
  });
  assert.equal(digest.unique_skus.failed, 2);
  assert.deepEqual(digest.funnel, { candidate: 2, selected: 1, strict_published: 1 });
  assert.equal(digest.error_fingerprints[0].count, 2);
  assert.equal(digest.recent_recoveries.length, 5);
});
