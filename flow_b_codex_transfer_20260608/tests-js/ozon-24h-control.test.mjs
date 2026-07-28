import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  refreshCurrentRunSources,
  resumeMode,
  shouldResumeCurrentRun,
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

test("same-run resume refreshes the active source pool from the promoted release", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-24h-resume-sources-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const runDir = path.join(stateRoot, "runs", current.run_id);
  const urlsFile = path.join(stateRoot, "sources", "active_urls.txt");
  const seedFile = path.join(root, "candidate-seed.txt");
  const promotedSource = "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?category=13523&currency_price=1000.000%3B";
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

  assert.match(await fs.readFile(urlsFile, "utf8"), /category=13523&currency_price=1000\.000/);
  assert.match(refreshed.source_sha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(refreshed.source_sha256, existing.source_sha256);
  assert.ok(Date.parse(refreshed.source_refreshed_at) > 0);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(stateRoot, "current_run.json"), "utf8")),
    refreshed,
  );
});
