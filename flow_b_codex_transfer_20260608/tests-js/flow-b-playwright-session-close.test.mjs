import test from "node:test";
import assert from "node:assert/strict";

import {
  closePublishingSession,
  directWorkerCleanupError,
  directWorkerSignalStopError,
} from "../scripts/flow_b_playwright.mjs";

function closable(name, events, close = async () => {}) {
  return {
    async close() {
      events.push(`${name}:start`);
      await close();
      events.push(`${name}:done`);
    },
  };
}

test("publishing session close awaits the cost bridge final flush", async () => {
  const events = [];
  let releaseCostFlush;
  const costFlushReleased = new Promise((resolve) => { releaseCostFlush = resolve; });
  const session = {
    supplyVerifier: closable("supply", events),
    detailProvider: closable("detail", events),
    costBridge: closable("cost", events, async () => costFlushReleased),
    state: closable("state", events),
    maoziPage: closable("maozi", events),
  };

  let settled = false;
  const closing = closePublishingSession(session).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  for (const expected of [
    "supply:done",
    "detail:done",
    "cost:start",
    "state:done",
    "maozi:done",
  ]) assert.ok(events.includes(expected), expected);
  assert.equal(events.includes("cost:done"), false);

  releaseCostFlush();
  await closing;
  assert.equal(settled, true);
  assert.ok(events.includes("cost:done"));
});

test("publishing session close reports cache flush failure after closing every resource", async () => {
  const events = [];
  const session = {
    supplyVerifier: closable("supply", events),
    detailProvider: closable("detail", events),
    costBridge: closable("cost", events, async () => {
      throw new Error("1688 cache flush failed");
    }),
    state: closable("state", events),
    maoziPage: closable("maozi", events),
  };

  await assert.rejects(closePublishingSession(session), /1688 cache flush failed/u);
  assert.ok(events.includes("state:done"));
  assert.ok(events.includes("maozi:done"));
});

test("a hanging cache flush is bounded and cannot block state or page cleanup", async (t) => {
  const events = [];
  const session = {
    supplyVerifier: closable("supply", events),
    detailProvider: closable("detail", events),
    costBridge: closable("cost", events, async () => new Promise(() => {})),
    state: closable("state", events),
    maoziPage: closable("maozi", events),
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const closing = closePublishingSession(session, { timeoutMs: 100 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.includes("cost:start"));
  assert.ok(events.includes("state:done"));
  assert.ok(events.includes("maozi:done"));
  t.mock.timers.tick(100);
  await assert.rejects(
    closing,
    (error) => error?.code === "FLOW_B_CLEANUP_TIMEOUT"
      && error?.cleanup_label === "1688 cost bridge",
  );
});

test("direct worker signals retain controlled nonzero exit semantics", () => {
  const sigterm = directWorkerSignalStopError("SIGTERM");
  assert.equal(sigterm.code, "FLOW_B_DIRECT_WORKER_SIGNAL_STOP");
  assert.equal(sigterm.signal, "SIGTERM");
  assert.equal(sigterm.exitCode, 143);

  const sigint = directWorkerSignalStopError("SIGINT");
  assert.equal(sigint.signal, "SIGINT");
  assert.equal(sigint.exitCode, 130);

  const hungCleanup = Object.assign(new Error("cache flush timed out"), {
    code: "FLOW_B_CLEANUP_TIMEOUT",
  });
  const stoppedAfterTimeout = directWorkerCleanupError({
    signal: "SIGTERM",
    cleanupError: hungCleanup,
  });
  assert.equal(stoppedAfterTimeout.code, "FLOW_B_DIRECT_WORKER_SIGNAL_STOP");
  assert.equal(stoppedAfterTimeout.exitCode, 143, "cleanup failure cannot turn SIGTERM into exit 0");
  assert.equal(stoppedAfterTimeout.cause, hungCleanup);
});
