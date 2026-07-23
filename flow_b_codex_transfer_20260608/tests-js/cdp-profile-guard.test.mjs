import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { archiveRestorableProfileSessions } from "../scripts/prepare_cdp_profile.mjs";

test("CDP profile guard archives restorable tabs without touching login state or unrelated files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-cdp-profile-"));
  const profileDir = path.join(root, "profile");
  const runDir = path.join(root, "run");
  const sessionsDir = path.join(profileDir, "Default", "Sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(path.join(sessionsDir, "Session_123"), "session-state");
  await fs.writeFile(path.join(sessionsDir, "Tabs_456"), "tab-state");
  await fs.writeFile(path.join(sessionsDir, "unrelated.txt"), "keep");
  await fs.writeFile(path.join(profileDir, "Default", "Cookies"), "login-cookie-state");

  const result = await archiveRestorableProfileSessions({
    profileDir,
    runDir,
    archiveId: "controlled-test",
  });

  assert.equal(result.archived_count, 2);
  assert.deepEqual(result.archived_files.map((row) => row.name), ["Session_123", "Tabs_456"]);
  await assert.rejects(fs.access(path.join(sessionsDir, "Session_123")));
  await assert.rejects(fs.access(path.join(sessionsDir, "Tabs_456")));
  assert.equal(await fs.readFile(path.join(sessionsDir, "unrelated.txt"), "utf8"), "keep");
  assert.equal(await fs.readFile(path.join(profileDir, "Default", "Cookies"), "utf8"), "login-cookie-state");
  assert.equal(await fs.readFile(path.join(result.archive_dir, "Session_123"), "utf8"), "session-state");
  assert.equal(await fs.readFile(path.join(result.archive_dir, "Tabs_456"), "utf8"), "tab-state");
  await fs.rm(root, { recursive: true, force: true });
});
