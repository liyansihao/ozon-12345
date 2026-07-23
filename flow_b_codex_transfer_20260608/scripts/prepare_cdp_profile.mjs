#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function requiredPath(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return path.resolve(normalized);
}

function safeArchiveId(value) {
  const normalized = String(value || new Date().toISOString()).replace(/[^0-9A-Za-z._-]+/g, "_");
  if (!normalized || normalized === "." || normalized === "..") throw new Error("archiveId is invalid");
  return normalized;
}

async function moveRecoverably(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    await fs.unlink(source);
  }
}

export async function archiveRestorableProfileSessions({
  profileDir,
  runDir,
  archiveId,
} = {}) {
  const profile = requiredPath(profileDir, "profileDir");
  const run = requiredPath(runDir, "runDir");
  const sessionsDir = path.join(profile, "Default", "Sessions");
  const archiveDir = path.join(run, "profile_session_archive", safeArchiveId(archiveId));
  let entries = [];
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const restorable = entries
    .filter((entry) => entry.isFile() && /^(?:Session|Tabs)_/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const archivedFiles = [];
  if (restorable.length > 0) await fs.mkdir(archiveDir, { recursive: true });
  for (const entry of restorable) {
    const source = path.join(sessionsDir, entry.name);
    const destination = path.join(archiveDir, entry.name);
    const content = await fs.readFile(source);
    await moveRecoverably(source, destination);
    archivedFiles.push({
      name: entry.name,
      bytes: content.byteLength,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    });
  }
  const result = {
    prepared_at: new Date().toISOString(),
    profile_dir: profile,
    sessions_dir: sessionsDir,
    archive_dir: archiveDir,
    archived_count: archivedFiles.length,
    archived_files: archivedFiles,
    preserved_login_state: true,
  };
  await fs.mkdir(run, { recursive: true });
  await fs.writeFile(path.join(run, "profile_session_archive.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const result = await archiveRestorableProfileSessions({
      profileDir: process.argv[2] || process.env.FLOW_B_PW_PROFILE,
      runDir: process.argv[3] || process.env.FLOW_B_RUN_DIR,
      archiveId: process.argv[4],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
    process.exitCode = 1;
  }
}
