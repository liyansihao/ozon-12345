#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXCLUDED_SKUS = new Set(["2815247918"]);

function rounded(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function strictRows(rows, startedMs, endedMs) {
  const unique = new Map();
  for (const event of rows || []) {
    const row = { ...(event?.data || {}), ...event };
    const sku = String(row?.sku || "").trim();
    const at = Date.parse(row?.published_at || row?.timestamp || "");
    if (!sku
      || EXCLUDED_SKUS.has(sku)
      || !(Number(row?.profit_rate) > 30)
      || String(row?.online_status || "") !== "selling"
      || !(Number(row?.stock) > 0)
      || !(at >= startedMs && at <= endedMs)) continue;
    unique.set(sku, row);
  }
  return [...unique.values()];
}

function countByStore(rows, storeIds) {
  const counts = Object.fromEntries(storeIds.map((id) => [String(id), 0]));
  for (const row of rows || []) {
    const key = String(Number(row?.store_id || 0));
    if (key in counts) counts[key] += 1;
  }
  return counts;
}

export function buildStatusSnapshot({
  config = {},
  published = [],
  selected = [],
  runtimeErrors = [],
  observedAt = new Date().toISOString(),
} = {}) {
  const startedAt = config.window_started_at || config.started_at;
  const endedAt = config.window_ended_at || config.ended_at;
  const startedMs = Date.parse(startedAt || "");
  const endedMs = Date.parse(endedAt || "");
  const observedMs = Date.parse(observedAt);
  if (![startedMs, endedMs, observedMs].every(Number.isFinite) || endedMs <= startedMs) {
    throw new TypeError("valid window start, end, and observed time are required");
  }
  const anchorMs = Math.min(Math.max(observedMs, startedMs), endedMs);
  const elapsedHours = Math.max(0, anchorMs - startedMs) / 3_600_000;
  const storeTargets = Array.isArray(config.store_targets) ? config.store_targets : [];
  const storeIds = [...new Set(storeTargets.map((row) => Number(row?.id)).filter((id) => id > 0))];
  const storeNames = Object.fromEntries(storeTargets.map((row) => [String(Number(row.id)), String(row.needle || row.name || "")]));
  const perStoreTarget = Math.max(1, Number(config.per_store_target || config.store_acceptance_target || 100));
  const strict = strictRows(published, startedMs, anchorMs);
  const strictByStore = countByStore(strict, storeIds);
  const remainingByStore = Object.fromEntries(storeIds.map((id) => [
    String(id),
    Math.max(0, perStoreTarget - Number(strictByStore[String(id)] || 0)),
  ]));
  const selectedUnique = new Map();
  for (const event of selected || []) {
    const row = { ...(event?.data || {}), ...event };
    const sku = String(row?.sku || "").trim();
    const storeId = Number(row?.store_id || 0);
    if (sku && storeId > 0 && !EXCLUDED_SKUS.has(sku) && Number(row?.profit_rate) > 30) {
      selectedUnique.set(`${storeId}:${sku}`, row);
    }
  }
  const rolling = {};
  for (const minutes of [15, 30, 60, 120]) {
    const windowMs = minutes * 60_000;
    const count = strict.filter((row) => Date.parse(row.published_at || row.timestamp || "") >= anchorMs - windowMs).length;
    const denominatorHours = Math.min(windowMs, Math.max(1, anchorMs - startedMs)) / 3_600_000;
    rolling[minutes] = { count, per_hour: rounded(count / denominatorHours) };
  }
  const complete = observedMs >= endedMs;
  const storesPassed = Object.values(remainingByStore).every((remaining) => remaining === 0);
  return {
    observed_at: new Date(observedMs).toISOString(),
    window: {
      started_at: new Date(startedMs).toISOString(),
      ended_at: new Date(endedMs).toISOString(),
      elapsed_hours: rounded(elapsedHours),
      remaining_seconds: Math.max(0, Math.ceil((endedMs - observedMs) / 1000)),
      complete,
    },
    stores: storeNames,
    strict: {
      total: strict.length,
      target: perStoreTarget * storeIds.length,
      per_hour: elapsedHours > 0 ? rounded(strict.length / elapsedHours) : 0,
      by_store: strictByStore,
      remaining_by_store: remainingByStore,
      passed: complete && storesPassed,
    },
    selected: { total: selectedUnique.size, by_store: countByStore([...selectedUnique.values()], storeIds) },
    rolling,
    runtime_errors: {
      total: runtimeErrors.length,
      last_at: runtimeErrors.at(-1)?.at || null,
    },
  };
}

async function readJson(filename, fallback = {}) {
  try { return JSON.parse(await fs.readFile(filename, "utf8")); } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

async function readJsonLines(filename) {
  try {
    const text = await fs.readFile(filename, "utf8");
    return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function snapshotRun(runDir, observedAt = new Date().toISOString()) {
  const root = path.resolve(runDir);
  const config = await readJson(path.join(root, "source_config.json"));
  const window = await readJson(path.join(root, "acceptance_window.json"));
  return buildStatusSnapshot({
    config: {
      ...config,
      window_started_at: window.started_at || config.window_started_at,
      window_ended_at: window.ended_at || config.window_ended_at,
    },
    published: await readJsonLines(path.join(root, "published.jsonl")),
    selected: await readJsonLines(path.join(root, "selected.jsonl")),
    runtimeErrors: await readJsonLines(path.join(root, "runtime_errors.jsonl")),
    observedAt,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("usage: node scripts/flow_b_status_snapshot.mjs RUN_DIR");
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(await snapshotRun(runDir)));
  }
}
