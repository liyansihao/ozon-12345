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
