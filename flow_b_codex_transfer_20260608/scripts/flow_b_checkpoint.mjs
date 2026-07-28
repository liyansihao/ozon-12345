#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { snapshotRun, compactStatusSnapshot } from "./flow_b_status_snapshot.mjs";

const execFileAsync = promisify(execFile);

async function readJson(filename, fallback = null) {
  try { return JSON.parse(await fs.readFile(filename, "utf8")); } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

async function readJsonLines(filename) {
  try {
    return (await fs.readFile(filename, "utf8")).split(/\r?\n/u).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function eventAt(row) {
  return Date.parse(row?.published_at || row?.timestamp || row?.at || row?.data?.published_at || row?.data?.timestamp || row?.data?.selected_at || "");
}

function skuOf(row) {
  return String(row?.sku || row?.data?.sku || "").trim();
}

function inInterval(row, startedMs, endedMs) {
  const at = eventAt(row);
  return Number.isFinite(at) && at > startedMs && at <= endedMs;
}

function uniqueSkuCount(rows) {
  return new Set(rows.map(skuOf).filter(Boolean)).size;
}

function classify(rows) {
  const counts = {};
  for (const row of rows) {
    const key = String(row?.reason || row?.stage || row?.data?.reason || row?.data?.cost?.reason || "unknown");
    counts[key] = Number(counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function stageStats(rows) {
  const byStage = new Map();
  for (const row of rows) {
    const stage = String(row?.stage || "unknown");
    const duration = Number(row?.duration_ms);
    if (!Number.isFinite(duration)) continue;
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage).push(duration);
  }
  return Object.fromEntries([...byStage.entries()].map(([stage, values]) => [stage, {
    count: values.length,
    p50_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
  }]));
}

function strictPublished(rows, startedMs, endedMs) {
  const seen = new Map();
  for (const event of rows) {
    const row = { ...(event?.data || {}), ...event };
    const sku = skuOf(row);
    const at = Date.parse(row?.published_at || row?.timestamp || "");
    if (!sku || sku === "2815247918" || !(at > startedMs && at <= endedMs)
      || !(Number(row?.profit_rate) > 30) || row?.online_status !== "selling" || !(Number(row?.stock) > 0)) continue;
    seen.set(sku, row);
  }
  return [...seen.values()];
}

export function matchesRunCommand(line, runDir) {
  const absolute = path.resolve(runDir);
  const relative = path.relative(process.cwd(), absolute);
  const basename = path.basename(absolute);
  return [absolute, relative, basename].filter(Boolean).some((value) => String(line || "").includes(value));
}

export function checkpointProfileDir({
  env = process.env,
  productionConfig = {},
  cwd = process.cwd(),
} = {}) {
  const home = String(env?.HOME || "").trim();
  const configured = String(
    env?.FLOW_B_PW_PROFILE
      || productionConfig?.browser?.profile_dir
      || "runs/flow_b/playwright_setup/playwright_profile",
  ).trim();
  const expanded = configured
    .replaceAll("${HOME}", home)
    .replace(/^\$HOME(?=\/|$)/u, home)
    .replace(/^~(?=\/|$)/u, home);
  return path.resolve(cwd, expanded);
}

async function processHealth(runDir, profileDir) {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="]);
    const lines = stdout.split(/\r?\n/u).filter(Boolean);
    const supervised = lines.filter((line) => (
      (line.includes("run_acceptance_supervised.sh") && matchesRunCommand(line, runDir))
      || line.includes("ozon_24h_supervisor.mjs supervise")
    ));
    const workers = lines.filter((line) => line.includes("flow_b_playwright.mjs accept") && matchesRunCommand(line, runDir));
    const browsers = lines.filter((line) => profileDir && line.includes(`--user-data-dir=${profileDir}`));
    return {
      supervisor_alive: supervised.length === 1,
      supervisor_owner_count: supervised.length,
      worker_owner_count: workers.length,
      browser_alive: browsers.length > 0,
      browser_profile_owner_count: browsers.filter((line) => !line.includes(" --type=")).length,
      supervisor_processes: supervised,
      worker_processes: workers,
      browser_owner_processes: browsers.filter((line) => !line.includes(" --type=")),
    };
  } catch (error) {
    return { supervisor_alive: null, browser_alive: null, error: String(error?.message || error) };
  }
}

export async function buildCheckpoint(runDir, observedAt = new Date().toISOString()) {
  const root = path.resolve(runDir);
  const window = await readJson(path.join(root, "acceptance_window.json"), {});
  const observedMs = Date.parse(observedAt);
  const startedMs = Date.parse(window?.started_at || "");
  if (!Number.isFinite(startedMs) || !Number.isFinite(observedMs)) throw new TypeError("acceptance window and observed time are required");
  const checkpointDir = path.join(root, "checkpoints");
  const prior = (await fs.readdir(checkpointDir).catch(() => []))
    .filter((name) => /^checkpoint_.*\.json$/u.test(name))
    .sort()
    .reverse();
  let intervalStartedMs = startedMs - 1;
  for (const name of prior) {
    const value = await readJson(path.join(checkpointDir, name));
    const at = Date.parse(value?.observed_at || "");
    if (Number.isFinite(at) && at < observedMs) { intervalStartedMs = at; break; }
  }
  const [
    snapshot,
    candidates,
    timings,
    selected,
    published,
    failed,
    skipped,
    runtimeErrors,
    config,
    productionConfig,
  ] = await Promise.all([
    snapshotRun(root, observedAt),
    readJsonLines(path.join(root, "candidate_queue.jsonl")),
    readJsonLines(path.join(root, "stage_timings.jsonl")),
    readJsonLines(path.join(root, "selected.jsonl")),
    readJsonLines(path.join(root, "published.jsonl")),
    readJsonLines(path.join(root, "failed.jsonl")),
    readJsonLines(path.join(root, "skipped.jsonl")),
    readJsonLines(path.join(root, "runtime_errors.jsonl")),
    readJson(path.join(root, "source_config.json"), {}),
    readJson(path.resolve(import.meta.dirname, "../config/ozon_24h_production.json"), {}),
  ]);
  const cumulativeFailures = [...failed, ...skipped, ...runtimeErrors];
  const intervalFailures = cumulativeFailures.filter((row) => inInterval(row, intervalStartedMs, observedMs));
  const intervalTimings = timings.filter((row) => inInterval(row, intervalStartedMs, observedMs));
  const cumulativeStrict = strictPublished(published, startedMs - 1, observedMs);
  const intervalStrict = strictPublished(published, intervalStartedMs, observedMs);
  const cumulativeStages = {
    candidate: uniqueSkuCount(candidates.filter((row) => eventAt(row) <= observedMs)),
    cost_1688: uniqueSkuCount(timings.filter((row) => row?.stage === "1688_cost" && row?.ok !== false && eventAt(row) <= observedMs)),
    profit: uniqueSkuCount(timings.filter((row) => row?.stage === "profit_calculation" && row?.ok !== false && eventAt(row) <= observedMs)),
    submitted: uniqueSkuCount(selected.filter((row) => eventAt(row) <= observedMs)),
    final_confirmed: cumulativeStrict.length,
  };
  const intervalStages = {
    candidate: uniqueSkuCount(candidates.filter((row) => inInterval(row, intervalStartedMs, observedMs))),
    cost_1688: uniqueSkuCount(intervalTimings.filter((row) => row?.stage === "1688_cost" && row?.ok !== false)),
    profit: uniqueSkuCount(intervalTimings.filter((row) => row?.stage === "profit_calculation" && row?.ok !== false)),
    submitted: uniqueSkuCount(selected.filter((row) => inInterval(row, intervalStartedMs, observedMs))),
    final_confirmed: intervalStrict.length,
  };
  const profileDir = checkpointProfileDir({ productionConfig });
  return {
    observed_at: new Date(observedMs).toISOString(),
    interval: {
      started_at: new Date(intervalStartedMs + 1).toISOString(),
      ended_at: new Date(observedMs).toISOString(),
      strict_successes: intervalStrict.length,
      funnel: intervalStages,
      failures: classify(intervalFailures),
      stage_timings: stageStats(intervalTimings),
    },
    cumulative: {
      strict_successes: cumulativeStrict.length,
      average_per_hour: snapshot.strict.per_hour,
      by_store: snapshot.strict.by_store,
      remaining_by_store: snapshot.strict.remaining_by_store,
      quota: snapshot.quota,
      funnel: cumulativeStages,
      failures: classify(cumulativeFailures.filter((row) => eventAt(row) <= observedMs)),
      stage_timings: stageStats(timings.filter((row) => eventAt(row) <= observedMs)),
      duplicate_skus: Math.max(0, published.filter((row) => strictPublished([row], startedMs - 1, observedMs).length).length - cumulativeStrict.length),
      minimum_profit_rate: cumulativeStrict.length ? Math.min(...cumulativeStrict.map((row) => Number(row.profit_rate))) : null,
    },
    compact: compactStatusSnapshot(snapshot),
    liveness: await processHealth(root, profileDir),
    frozen: {
      git_commit: process.env.FLOW_B_FROZEN_COMMIT || null,
      config_sha256: process.env.FLOW_B_FROZEN_CONFIG_HASH || null,
      profit_rule: "profit_rate > 30",
      watermark_id: config?.watermark_id ?? 60822,
      store_targets: config?.store_targets || [],
    },
  };
}

export async function writeCheckpoint(runDir, observedAt = new Date().toISOString(), label = null) {
  const value = await buildCheckpoint(runDir, observedAt);
  const root = path.resolve(runDir);
  const checkpointDir = path.join(root, "checkpoints");
  await fs.mkdir(checkpointDir, { recursive: true });
  const stamp = value.observed_at.replace(/[-:.]/gu, "");
  const filename = path.join(checkpointDir, `checkpoint_${label || stamp}.json`);
  const temp = `${filename}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temp, filename);
  const compactFilename = path.join(root, "compact_checkpoint.json");
  const compactTemp = `${compactFilename}.${process.pid}.tmp`;
  await fs.writeFile(compactTemp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(compactTemp, compactFilename);
  return { filename, value };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("usage: node scripts/flow_b_checkpoint.mjs RUN_DIR [LABEL]");
    process.exitCode = 2;
  } else {
    const result = await writeCheckpoint(runDir, new Date().toISOString(), process.argv[3] || null);
    console.log(JSON.stringify({ ok: true, checkpoint: result.filename, compact: result.value.compact }));
  }
}
