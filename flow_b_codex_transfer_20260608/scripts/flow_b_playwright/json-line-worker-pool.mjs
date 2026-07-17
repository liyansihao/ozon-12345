import { spawn } from "node:child_process";

export function createJsonLineWorkerPool({
  command,
  args = [],
  size = 4,
  spawnProcess = spawn,
} = {}) {
  if (!command) throw new TypeError("worker command is required");
  const maximum = Math.max(1, Number(size) || 1);
  const workers = new Set();
  const queue = [];
  let closing = false;
  let sequence = 0;
  let created = 0;

  function diagnosticError(message, worker, code = "worker-failed") {
    return Object.assign(new Error(message), {
      code,
      stdout: String(worker?.diagnostics || ""),
      stderr: String(worker?.stderr || ""),
    });
  }

  function pump() {
    if (closing) return;
    while (queue.length > 0) {
      let worker = [...workers].find((candidate) => !candidate.busy && !candidate.retired);
      if (!worker && workers.size < maximum) worker = startWorker();
      if (!worker) return;
      const job = queue.shift();
      worker.busy = true;
      worker.current = job;
      const id = String(++sequence);
      job.id = id;
      job.timer = setTimeout(() => {
        retireWorker(worker, diagnosticError(
          `persistent worker timed out after ${job.timeout}ms`,
          worker,
          "worker-timeout",
        ));
      }, job.timeout);
      worker.child.stdin.write(`${JSON.stringify({ ...job.payload, id })}\n`, (error) => {
        if (error && worker.current === job) {
          retireWorker(worker, diagnosticError(error.message, worker, "worker-stdin-failed"));
        }
      });
    }
  }

  function finishJob(worker, response) {
    const job = worker.current;
    if (!job || String(response?.id || "") !== job.id) return;
    clearTimeout(job.timer);
    worker.current = null;
    worker.busy = false;
    job.resolve(response);
    pump();
  }

  function retireWorker(worker, error) {
    if (!worker || worker.retired) return;
    worker.retired = true;
    workers.delete(worker);
    const job = worker.current;
    worker.current = null;
    worker.busy = false;
    if (job) {
      clearTimeout(job.timer);
      job.reject(error || diagnosticError("persistent worker exited", worker));
    }
    if (worker.child.exitCode === null && !worker.child.killed) worker.child.kill("SIGTERM");
    pump();
  }

  function startWorker() {
    const child = spawnProcess(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const worker = {
      child,
      busy: false,
      current: null,
      retired: false,
      buffer: "",
      diagnostics: "",
      stderr: "",
    };
    created += 1;
    workers.add(worker);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      worker.buffer += chunk;
      const lines = worker.buffer.split(/\r?\n/);
      worker.buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          finishJob(worker, JSON.parse(line));
        } catch {
          worker.diagnostics = `${worker.diagnostics}${line}\n`.slice(-8192);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      worker.stderr = `${worker.stderr}${chunk}`.slice(-8192);
    });
    child.once("error", (error) => retireWorker(worker, diagnosticError(error.message, worker)));
    child.once("close", (code) => retireWorker(worker, diagnosticError(`persistent worker exited ${code ?? -1}`, worker)));
    return worker;
  }

  function run(payload, timeout = 90_000) {
    if (closing) return Promise.reject(Object.assign(new Error("worker pool is closed"), { code: "worker-pool-closed" }));
    return new Promise((resolve, reject) => {
      queue.push({
        payload: payload && typeof payload === "object" ? payload : {},
        timeout: Math.max(1, Number(timeout) || 1),
        resolve,
        reject,
      });
      pump();
    });
  }

  async function close() {
    if (closing) return;
    closing = true;
    const error = Object.assign(new Error("worker pool closed"), { code: "worker-pool-closed" });
    for (const job of queue.splice(0)) job.reject(error);
    const active = [...workers];
    for (const worker of active) {
      const job = worker.current;
      if (job) {
        clearTimeout(job.timer);
        job.reject(error);
        worker.current = null;
      }
      worker.retired = true;
      workers.delete(worker);
      if (worker.child.exitCode === null && !worker.child.killed) worker.child.kill("SIGTERM");
    }
    await Promise.all(active.map((worker) => new Promise((resolve) => {
      if (worker.child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        if (worker.child.exitCode === null) worker.child.kill("SIGKILL");
        resolve();
      }, 1000);
      worker.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    })));
  }

  return {
    run,
    close,
    stats: () => ({ created, active: workers.size, queued: queue.length }),
  };
}
