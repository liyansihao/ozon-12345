import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createJsonLineWorkerPool } from "../scripts/flow_b_playwright/json-line-worker-pool.mjs";

test("JSON-line worker pool reuses a bounded set of long-lived processes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-worker-pool-"));
  const workerScript = path.join(dir, "worker.mjs");
  await fs.writeFile(workerScript, `
    import readline from "node:readline";
    const input = readline.createInterface({ input: process.stdin });
    input.on("line", (line) => {
      const request = JSON.parse(line);
      setTimeout(() => process.stdout.write(JSON.stringify({
        id: request.id,
        code: 0,
        stdout: String(request.value),
        worker_pid: process.pid,
      }) + "\\n"), Number(request.delay || 0));
    });
  `);
  const pool = createJsonLineWorkerPool({
    command: process.execPath,
    args: [workerScript],
    size: 2,
  });
  try {
    const first = await Promise.all(Array.from({ length: 6 }, (_, index) => pool.run({
      value: index,
      delay: 5,
    }, 1000)));
    const firstPids = new Set(first.map((row) => row.worker_pid));
    assert.equal(firstPids.size, 2);
    assert.deepEqual(first.map((row) => Number(row.stdout)).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);

    const second = await Promise.all([pool.run({ value: 6 }, 1000), pool.run({ value: 7 }, 1000)]);
    assert.ok(second.every((row) => firstPids.has(row.worker_pid)));
    assert.equal(pool.stats().created, 2);
  } finally {
    await pool.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("JSON-line worker pool counts queue wait against the total deadline", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-worker-deadline-"));
  const workerScript = path.join(dir, "worker.mjs");
  await fs.writeFile(workerScript, `
    import readline from "node:readline";
    const input = readline.createInterface({ input: process.stdin });
    input.on("line", (line) => {
      const request = JSON.parse(line);
      setTimeout(() => process.stdout.write(JSON.stringify({
        id: request.id,
        code: 0,
        stdout: String(request.value),
      }) + "\\n"), Number(request.delay || 0));
    });
  `);
  const pool = createJsonLineWorkerPool({
    command: process.execPath,
    args: [workerScript],
    size: 1,
  });
  try {
    const slow = pool.run({ value: "slow", delay: 80 }, 500);
    const queued = pool.run({ value: "never-sent", delay: 0 }, 25);
    await assert.rejects(queued, (error) => error?.code === "worker-queue-timeout");
    assert.equal((await slow).stdout, "slow");
    assert.equal(pool.stats().timed_out, 1);
  } finally {
    await pool.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("JSON-line worker pool exposes busy and oldest queue wait telemetry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-worker-stats-"));
  const workerScript = path.join(dir, "worker.mjs");
  await fs.writeFile(workerScript, `
    import readline from "node:readline";
    const input = readline.createInterface({ input: process.stdin });
    input.on("line", (line) => {
      const request = JSON.parse(line);
      setTimeout(() => process.stdout.write(JSON.stringify({
        id: request.id,
        code: 0,
        stdout: "ok",
      }) + "\\n"), 40);
    });
  `);
  const pool = createJsonLineWorkerPool({
    command: process.execPath,
    args: [workerScript],
    size: 1,
  });
  try {
    const first = pool.run({ value: 1 }, 500);
    const second = pool.run({ value: 2 }, 500);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stats = pool.stats();
    assert.equal(stats.busy, 1);
    assert.equal(stats.queued, 1);
    assert.ok(stats.oldest_wait_ms >= 0);
    await Promise.all([first, second]);
    assert.equal(pool.stats().completed, 2);
  } finally {
    await pool.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("aborting one active request retires only its worker and the pool recovers", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-worker-abort-"));
  const workerScript = path.join(dir, "worker.mjs");
  await fs.writeFile(workerScript, `
    import readline from "node:readline";
    const input = readline.createInterface({ input: process.stdin });
    input.on("line", (line) => {
      const request = JSON.parse(line);
      setTimeout(() => process.stdout.write(JSON.stringify({
        id: request.id,
        code: 0,
        stdout: String(request.value),
        worker_pid: process.pid,
      }) + "\\n"), Number(request.delay || 0));
    });
  `);
  const pool = createJsonLineWorkerPool({
    command: process.execPath,
    args: [workerScript],
    size: 1,
  });
  try {
    const controller = new AbortController();
    const active = pool.run({ value: "slow", delay: 500 }, 1_000, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("test deadline")), 30);
    await assert.rejects(active, (error) => error?.code === "worker-aborted");

    const recovered = await pool.run({ value: "next", delay: 0 }, 1_000);
    assert.equal(recovered.stdout, "next");
    assert.equal(pool.stats().created, 2);
    assert.equal(pool.stats().active, 1);
  } finally {
    await pool.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
