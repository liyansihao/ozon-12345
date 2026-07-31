import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createOzonAccessController,
  isOzonCaptchaText,
  isOzonAccessStoppedError,
  resolveOzonAccessStateFile,
} from "../scripts/flow_b_playwright/ozon-access-controller.mjs";

test("Ozon CAPTCHA text is classified separately from network soft blocks", () => {
  assert.equal(isOzonCaptchaText("CAPTCHA: confirm you are not a robot"), true);
  assert.equal(isOzonCaptchaText("Подтвердите, что вы не робот"), true);
  assert.equal(isOzonCaptchaText("请完成人机验证"), true);
  assert.equal(isOzonCaptchaText("Похоже, нет соединения"), false);
});

test("global Ozon controller serializes callers and preserves a quiet interval after completion", async () => {
  let clock = 1_000;
  let active = 0;
  let peak = 0;
  const starts = [];
  const controller = createOzonAccessController({
    minIntervalMs: 250,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const operation = async () => {
    starts.push(clock);
    active += 1;
    peak = Math.max(peak, active);
    clock += 10;
    active -= 1;
  };
  await Promise.all([
    controller.run({ kind: "source", url: "https://www.ozon.ru/search/one" }, operation),
    controller.run({ kind: "favorite-detail", url: "https://www.ozon.ru/product/two" }, operation),
    controller.run({ kind: "publish-detail", url: "https://www.ozon.ru/product/three" }, operation),
  ]);
  assert.equal(peak, 1);
  assert.deepEqual(starts, [1_000, 1_260, 1_520]);
});

test("ordinary Ozon soft blocks remain retryable and do not require manual clearance", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-ozon-access-"));
  const stateFile = path.join(dir, "ozon_access_state.json");
  const logFile = path.join(dir, "ozon_access_timeline.jsonl");
  let secondRan = false;
  const controller = createOzonAccessController({ stateFile, logFile, minIntervalMs: 0 });
  const first = controller.run({ kind: "source", url: "https://www.ozon.ru/search/blocked" }, async () => {
    throw new Error("Ozon detail soft blocked: test");
  });
  const second = controller.run({ kind: "favorite-detail", url: "https://www.ozon.ru/product/never" }, async () => {
    secondRan = true;
  });
  await assert.rejects(first, /soft blocked/i);
  await second;
  assert.equal(secondRan, true);

  const saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(saved.requires_manual_clear, false);
  const timeline = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(timeline.map((row) => row.event), ["started", "soft_block", "started", "succeeded"]);
  assert.equal(timeline[0].kind, "source");
  assert.equal(timeline[0].url, "https://www.ozon.ru/search/blocked");

  const nextRun = createOzonAccessController({ stateFile, minIntervalMs: 0 });
  await nextRun.run({ kind: "source", url: "https://www.ozon.ru/search/new-run" }, async () => {});
  await fs.rm(dir, { recursive: true, force: true });
});

test("a stale manual stop caused only by access denied is automatically recovered", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-ozon-stale-soft-block-"));
  const stateFile = path.join(dir, "ozon_access_state.json");
  await fs.writeFile(stateFile, `${JSON.stringify({
    version: 1,
    requires_manual_clear: true,
    reason: "Ozon source access denied",
    next_allowed_at_ms: 0,
  })}\n`);
  let ran = false;
  const controller = createOzonAccessController({ stateFile, minIntervalMs: 0 });
  await controller.run({}, async () => { ran = true; });
  assert.equal(ran, true);
  assert.equal((await controller.snapshot()).requires_manual_clear, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test("one CAPTCHA immediately persists a manual stop without an automated retry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-ozon-captcha-"));
  const stateFile = path.join(dir, "ozon_access_state.json");
  const logFile = path.join(dir, "ozon_access_timeline.jsonl");
  let clock = 1_000;
  let calls = 0;
  const sleeps = [];
  const controller = createOzonAccessController({
    stateFile,
    logFile,
    minIntervalMs: 250,
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  await assert.rejects(controller.run(
    { kind: "favorite-detail", url: "https://www.ozon.ru/product/captcha" },
    async () => {
      calls += 1;
      throw new Error("Ozon CAPTCHA required");
    },
  ), isOzonAccessStoppedError);
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
  const saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(saved.requires_manual_clear, true);
  assert.equal(saved.captcha_retry_pending, false);
  assert.equal(saved.captcha_retry_count, 1);
  const timeline = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(timeline.map((row) => row.event), ["started", "stopped"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("a persisted CAPTCHA stop rejects later operations without touching Ozon", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-ozon-captcha-persisted-"));
  const stateFile = path.join(dir, "ozon_access_state.json");
  await fs.writeFile(stateFile, `${JSON.stringify({
    version: 1,
    requires_manual_clear: true,
    reason: "Ozon CAPTCHA required",
    next_allowed_at_ms: 0,
  })}\n`);
  let calls = 0;
  const controller = createOzonAccessController({
    stateFile,
    minIntervalMs: 0,
  });
  await assert.rejects(controller.run(
    { kind: "source", url: "https://www.ozon.ru/search/captcha" },
    async () => {
      calls += 1;
    },
  ), isOzonAccessStoppedError);
  assert.equal(calls, 0);
  const saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(saved.requires_manual_clear, true);
  assert.match(saved.reason, /CAPTCHA/i);
  await fs.rm(dir, { recursive: true, force: true });
});

test("profile siblings share one account-level Ozon access state file", () => {
  const root = path.resolve("/tmp/flow-b-profile-parent");
  assert.equal(resolveOzonAccessStateFile({ FLOW_B_PW_PROFILE: path.join(root, "playwright_profile") }), path.join(root, "ozon_access_state.json"));
  assert.equal(resolveOzonAccessStateFile({ FLOW_B_PW_PROFILE: path.join(root, "playwright_profile_v2") }), path.join(root, "ozon_access_state.json"));
});
