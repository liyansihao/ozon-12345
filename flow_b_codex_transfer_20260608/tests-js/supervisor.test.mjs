import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const SOURCE = path.resolve(import.meta.dirname, "../scripts/run_acceptance_supervised.sh");

async function waitForFile(filename, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await fs.readFile(filename, "utf8"); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${filename}`);
}

test("acceptance supervisor terminates and reaps its active Node child", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-supervisor-"));
  const scripts = path.join(root, "scripts");
  const runDir = path.join(root, "run");
  const childPidFile = path.join(root, "child.pid");
  await fs.mkdir(scripts, { recursive: true });
  await fs.mkdir(runDir, { recursive: true });
  await fs.copyFile(SOURCE, path.join(scripts, "run_acceptance_supervised.sh"));
  await fs.writeFile(path.join(scripts, "flow_b_playwright.mjs"), `
    import fs from "node:fs";
    fs.writeFileSync(process.env.CHILD_PID_FILE, String(process.pid));
    setInterval(() => {}, 1000);
  `);

  const supervisor = spawn("/bin/zsh", [
    path.join(scripts, "run_acceptance_supervised.sh"),
    runDir,
    path.join(root, "urls.txt"),
  ], {
    env: { ...process.env, CHILD_PID_FILE: childPidFile },
    stdio: "ignore",
  });
  const childPid = Number(await waitForFile(childPidFile));
  try {
    supervisor.kill("SIGTERM");
    await new Promise((resolve) => supervisor.once("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  } finally {
    try { process.kill(childPid, "SIGKILL"); } catch {}
    try { supervisor.kill("SIGKILL"); } catch {}
  }
});
