import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createOzonAccessController,
  isOzonCaptchaText,
  isOzonAccessStoppedError,
  ozonAccessControllerFor,
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

test("bounded Ozon access concurrency does not hold the global start gate for a full page load", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStarted;
  const firstReady = new Promise((resolve) => { firstStarted = resolve; });
  let secondStarted = false;
  let active = 0;
  let peak = 0;
  const controller = createOzonAccessController({
    minIntervalMs: 0,
    maxConcurrent: 2,
  });
  const first = controller.run({ kind: "publish-detail", url: "https://www.ozon.ru/product/one" }, async () => {
    active += 1;
    peak = Math.max(peak, active);
    firstStarted();
    await firstGate;
    active -= 1;
  });
  await firstReady;
  const second = controller.run({ kind: "publish-detail", url: "https://www.ozon.ru/product/two" }, async () => {
    secondStarted = true;
    active += 1;
    peak = Math.max(peak, active);
    active -= 1;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const overlapped = secondStarted;
  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(overlapped, true);
  assert.equal(peak, 2);
});

test("bounded Ozon access concurrency preserves the global interval between starts", async () => {
  let clock = 1_000;
  const starts = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStarted;
  const firstReady = new Promise((resolve) => { firstStarted = resolve; });
  let secondStarted;
  const secondReady = new Promise((resolve) => { secondStarted = resolve; });
  const controller = createOzonAccessController({
    minIntervalMs: 250,
    maxConcurrent: 2,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const first = controller.run({}, async () => {
    starts.push(clock);
    firstStarted();
    await firstGate;
  });
  await firstReady;
  const second = controller.run({}, async () => {
    starts.push(clock);
    secondStarted();
  });
  await secondReady;
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(starts, [1_000, 1_250]);
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

test("one CAPTCHA waits globally and reopens the same operation once", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-ozon-captcha-"));
  const stateFile = path.join(dir, "ozon_access_state.json");
  const logFile = path.join(dir, "ozon_access_timeline.jsonl");
  let clock = 1_000;
  let calls = 0;
  const controller = createOzonAccessController({
    stateFile,
    logFile,
    minIntervalMs: 250,
    captchaReopenDelayMs: 600,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const result = await controller.run(
    { kind: "favorite-detail", url: "https://www.ozon.ru/product/captcha" },
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("Ozon CAPTCHA required");
      clock += 10;
      return "reopened";
    },
  );
  assert.equal(result, "reopened");
  assert.equal(calls, 2);
  assert.equal(clock, 1_610);
  const saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(saved.requires_manual_clear, false);
  assert.equal(saved.captcha_retry_pending, false);
  assert.equal(saved.captcha_retry_count, 1);
  const timeline = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(timeline.map((row) => row.event), ["started", "captcha_wait", "captcha_reopened", "succeeded"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("bounded Ozon access concurrency pauses new starts during CAPTCHA reopening", async () => {
  let clock = 1_000;
  let releaseCaptchaWait;
  const captchaWaitGate = new Promise((resolve) => { releaseCaptchaWait = resolve; });
  let captchaWaitStarted;
  const captchaWaitReady = new Promise((resolve) => { captchaWaitStarted = resolve; });
  let firstCalls = 0;
  let secondStarted = false;
  const controller = createOzonAccessController({
    minIntervalMs: 0,
    maxConcurrent: 2,
    captchaReopenDelayMs: 600,
    now: () => clock,
    sleep: async (ms) => {
      if (ms === 600) {
        captchaWaitStarted();
        await captchaWaitGate;
      }
      clock += ms;
    },
  });
  const first = controller.run({}, async () => {
    firstCalls += 1;
    if (firstCalls === 1) throw new Error("Ozon CAPTCHA required");
  });
  await captchaWaitReady;
  const second = controller.run({}, async () => {
    secondStarted = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, false);
  releaseCaptchaWait();
  await Promise.all([first, second]);

  assert.equal(firstCalls, 2);
  assert.equal(secondStarted, true);
});

test("a CAPTCHA repeated after reopening becomes a persistent manual stop", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-ozon-captcha-repeat-"));
  const stateFile = path.join(dir, "ozon_access_state.json");
  let clock = 1_000;
  let calls = 0;
  const controller = createOzonAccessController({
    stateFile,
    minIntervalMs: 0,
    captchaReopenDelayMs: 600,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  await assert.rejects(controller.run(
    { kind: "source", url: "https://www.ozon.ru/search/captcha" },
    async () => {
      calls += 1;
      throw new Error("Ozon CAPTCHA required");
    },
  ), isOzonAccessStoppedError);
  assert.equal(calls, 2);
  const saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(saved.requires_manual_clear, true);
  assert.equal(saved.captcha_retry_pending, false);
  assert.match(saved.reason, /CAPTCHA/i);
  await fs.rm(dir, { recursive: true, force: true });
});

test("profile siblings share one account-level Ozon access state file", () => {
  const root = path.resolve("/tmp/flow-b-profile-parent");
  assert.equal(resolveOzonAccessStateFile({ FLOW_B_PW_PROFILE: path.join(root, "playwright_profile") }), path.join(root, "ozon_access_state.json"));
  assert.equal(resolveOzonAccessStateFile({ FLOW_B_PW_PROFILE: path.join(root, "playwright_profile_v2") }), path.join(root, "ozon_access_state.json"));
});

test("production Ozon access concurrency is wired from the frozen environment", () => {
  const controller = ozonAccessControllerFor({}, {
    FLOW_B_FAVORITE_DETAIL_INTERVAL_MS: "4000",
    FLOW_B_TAB_WORKERS: "3",
  });
  assert.equal(controller.minIntervalMs, 4000);
  assert.equal(controller.maxConcurrent, 3);
});
