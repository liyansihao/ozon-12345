import assert from "node:assert/strict";
import test from "node:test";

import { resumeMode, shouldResumeCurrentRun } from "../scripts/ozon_24h_control.mjs";

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
