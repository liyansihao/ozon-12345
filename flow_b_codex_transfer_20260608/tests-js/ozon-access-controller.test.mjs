import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createOzonAccessController,
  isOzonAuthenticationText,
  isOzonCaptchaText,
  isOzonAccessStoppedError,
  ozonAccessControllerFor,
  resolveOzonAccessStateFile,
} from "../scripts/flow_b_playwright/ozon-access-controller.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("Ozon CAPTCHA text is classified separately from network soft blocks", () => {
  assert.equal(isOzonCaptchaText("CAPTCHA: confirm you are not a robot"), true);
  assert.equal(isOzonCaptchaText("Подтвердите, что вы не робот"), true);
  assert.equal(isOzonCaptchaText("请完成人机验证"), true);
  assert.equal(isOzonCaptchaText("Похоже, нет соединения"), false);
  assert.equal(isOzonAuthenticationText("Ozon login required; session expired"), true);
  assert.equal(isOzonAuthenticationText("Товар временно недоступен"), false);
});

test("dynamic pacing holds warmup until both safety gates pass and then uses the baseline", async () => {
  let clock = 0;
  const starts = [];
  const controller = createOzonAccessController({
    minIntervalMs: 400,
    baselineIntervalMs: 300,
    warmupIntervalMs: 400,
    maxIntervalMs: 800,
    warmupDurationMs: 1_000,
    warmupSuccessCount: 2,
    stableSuccessCount: 2,
    intervalStepMs: 50,
    softBlockStepMs: 150,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const run = () => controller.run({ kind: "publish-detail" }, async () => {
    starts.push(clock);
  });

  await run();
  await run();
  clock = 1_000;
  await run();
  await run();

  assert.deepEqual(starts, [0, 400, 1_000, 1_300]);
  assert.equal((await controller.snapshot()).warmup_complete, true);
  assert.equal((await controller.snapshot()).current_interval_ms, 300);
});

test("legacy access state enters the new safe warmup instead of skipping to baseline", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-ozon-legacy-state-"));
  const stateFile = path.join(dir, "ozon_access_state.json");
  await fs.writeFile(stateFile, `${JSON.stringify({
    version: 1,
    next_allowed_at_ms: 0,
    requires_manual_clear: false,
  })}\n`);
  const controller = createOzonAccessController({
    stateFile,
    minIntervalMs: 4_000,
    baselineIntervalMs: 3_000,
    warmupIntervalMs: 4_000,
    maxIntervalMs: 8_000,
    warmupDurationMs: 30 * 60_000,
    warmupSuccessCount: 20,
  });
  const state = await controller.snapshot();
  assert.equal(state.version, 2);
  assert.equal(state.warmup_complete, false);
  assert.equal(state.current_interval_ms, 4_000);
  await fs.rm(dir, { recursive: true, force: true });
});

test("soft blocks raise the persisted interval and configured success windows lower it toward baseline", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-ozon-dynamic-"));
  const stateFile = path.join(dir, "ozon_access_state.json");
  let clock = 0;
  const options = {
    stateFile,
    minIntervalMs: 400,
    baselineIntervalMs: 300,
    warmupIntervalMs: 400,
    maxIntervalMs: 800,
    warmupDurationMs: 0,
    warmupSuccessCount: 1,
    stableSuccessCount: 2,
    intervalStepMs: 50,
    softBlockStepMs: 150,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  const controller = createOzonAccessController(options);
  await controller.run({}, async () => {});
  await assert.rejects(
    controller.run({}, async () => { throw new Error("Ozon access denied"); }),
    /access denied/i,
  );
  assert.equal((await controller.snapshot()).current_interval_ms, 450);

  const resumed = createOzonAccessController(options);
  await resumed.run({}, async () => {});
  await resumed.run({}, async () => {});
  const saved = await resumed.snapshot();
  assert.equal(saved.current_interval_ms, 400);
  assert.equal(saved.stable_successes, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test("login loss and MFA errors persist the same immediate manual stop as CAPTCHA", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-ozon-auth-stop-"));
  const stateFile = path.join(dir, "ozon_access_state.json");
  const controller = createOzonAccessController({ stateFile, minIntervalMs: 0 });
  await assert.rejects(
    controller.run({}, async () => { throw new Error("Ozon MFA verification required"); }),
    isOzonAccessStoppedError,
  );
  const saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(saved.requires_manual_clear, true);
  assert.match(saved.reason, /MFA/i);
  await fs.rm(dir, { recursive: true, force: true });
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

test("publish detail jumps queued favorite and source work without preempting the running operation", async () => {
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const order = [];
  const controller = createOzonAccessController({ minIntervalMs: 0 });
  const run = (kind, label, wait = null) => controller.run({ kind }, async () => {
    order.push(label);
    if (wait) {
      firstStarted.resolve();
      await wait.promise;
    }
  });

  const running = run("source", "running-source", releaseFirst);
  await firstStarted.promise;
  const queuedSource = run("source", "queued-source");
  const queuedFavorite = run("favorite-detail", "favorite");
  const queuedPublish = run("publish-detail", "publish");
  releaseFirst.resolve();

  await Promise.all([running, queuedSource, queuedFavorite, queuedPublish]);
  assert.deepEqual(order, ["running-source", "publish", "favorite", "queued-source"]);
});

test("same-priority Ozon work remains FIFO and unknown kinds use medium priority", async () => {
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const order = [];
  const controller = createOzonAccessController({ minIntervalMs: 0 });
  const running = controller.run({ kind: "source" }, async () => {
    order.push("running-source");
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;
  const firstFavorite = controller.run({ kind: "favorite-detail" }, async () => { order.push("favorite-1"); });
  const unknown = controller.run({ kind: "other" }, async () => { order.push("unknown"); });
  const secondFavorite = controller.run({ kind: "favorite-detail" }, async () => { order.push("favorite-2"); });
  releaseFirst.resolve();

  await Promise.all([running, firstFavorite, unknown, secondFavorite]);
  assert.deepEqual(order, ["running-source", "favorite-1", "unknown", "favorite-2"]);
});

test("queued source work runs after at most eight consecutive non-source operations", async () => {
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const order = [];
  const controller = createOzonAccessController({ minIntervalMs: 0 });
  const runningSource = controller.run({ kind: "source" }, async () => {
    order.push("running-source");
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;
  const queuedSource = controller.run({ kind: "source" }, async () => { order.push("queued-source"); });
  const publishes = Array.from({ length: 10 }, (_, index) => controller.run(
    { kind: "publish-detail" },
    async () => { order.push(`publish-${index + 1}`); },
  ));
  releaseFirst.resolve();

  await Promise.all([runningSource, queuedSource, ...publishes]);
  assert.deepEqual(order, [
    "running-source",
    "publish-1",
    "publish-2",
    "publish-3",
    "publish-4",
    "publish-5",
    "publish-6",
    "publish-7",
    "publish-8",
    "queued-source",
    "publish-9",
    "publish-10",
  ]);
});

test("an errored operation preserves the quiet interval and the priority queue continues", async () => {
  const releaseFirst = deferred();
  const firstStarted = deferred();
  let clock = 1_000;
  const starts = [];
  const controller = createOzonAccessController({
    minIntervalMs: 250,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const failed = controller.run({ kind: "source" }, async () => {
    starts.push(["source", clock]);
    firstStarted.resolve();
    await releaseFirst.promise;
    clock += 10;
    throw new Error("test failure");
  });
  const failedAssertion = assert.rejects(failed, /test failure/);
  await firstStarted.promise;
  const favorite = controller.run({ kind: "favorite-detail" }, async () => {
    starts.push(["favorite", clock]);
    clock += 10;
  });
  const publish = controller.run({ kind: "publish-detail" }, async () => {
    starts.push(["publish", clock]);
    clock += 10;
  });
  releaseFirst.resolve();

  await Promise.all([failedAssertion, favorite, publish]);
  assert.deepEqual(starts, [
    ["source", 1_000],
    ["publish", 1_260],
    ["favorite", 1_520],
  ]);
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

test("context controllers expose the production 4s warmup, 3s baseline, and 8s ceiling defaults", () => {
  const controller = ozonAccessControllerFor({}, {});
  assert.deepEqual(controller.pacing, {
    baselineIntervalMs: 3_000,
    warmupIntervalMs: 4_000,
    maxIntervalMs: 8_000,
    warmupDurationMs: 30 * 60_000,
    warmupSuccessCount: 20,
    stableSuccessCount: 20,
    intervalStepMs: 500,
    softBlockStepMs: 1_500,
  });
});
