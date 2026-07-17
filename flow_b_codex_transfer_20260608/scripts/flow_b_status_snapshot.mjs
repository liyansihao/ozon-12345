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
  storeTargetEvents = [],
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
  const strictChronological = [...strict].sort((left, right) => (
    Date.parse(left.published_at || left.timestamp || "") - Date.parse(right.published_at || right.timestamp || "")
  ));
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
  const latestStoreTargets = new Map();
  for (const event of storeTargetEvents || []) {
    const storeId = Number(event?.store_id || 0);
    if (storeId > 0) latestStoreTargets.set(String(storeId), event);
  }
  const quotaByStore = Object.fromEntries(storeIds.map((id) => {
    const event = latestStoreTargets.get(String(id));
    const dailyUsage = Number(event?.daily_usage);
    const dailyLimit = Number(event?.daily_limit);
    return [String(id), {
      daily_usage: Number.isFinite(dailyUsage) ? dailyUsage : null,
      daily_limit: dailyLimit > 0 ? dailyLimit : null,
      daily_remaining: dailyLimit > 0 && Number.isFinite(dailyUsage) ? Math.max(0, dailyLimit - dailyUsage) : null,
      available: event ? event.available !== false : null,
      warehouse_id: Number(event?.warehouse_id) > 0 ? Number(event.warehouse_id) : null,
      reason: event?.reason ? String(event.reason) : null,
    }];
  }));
  const quotaShortfallByStore = Object.fromEntries(storeIds.map((id) => {
    const key = String(id);
    const dailyRemaining = quotaByStore[key].daily_remaining;
    return [key, dailyRemaining === null
      ? 0
      : Math.max(0, Number(remainingByStore[key] || 0) - dailyRemaining)];
  }));
  const nextQuotaResetAt = config.daily_store_timezone === "UTC"
    ? new Date(Date.UTC(
      new Date(anchorMs).getUTCFullYear(),
      new Date(anchorMs).getUTCMonth(),
      new Date(anchorMs).getUTCDate() + 1,
    )).toISOString()
    : null;
  const rolling = {};
  for (const minutes of [15, 30, 60, 120]) {
    const windowMs = minutes * 60_000;
    const count = strict.filter((row) => Date.parse(row.published_at || row.timestamp || "") >= anchorMs - windowMs).length;
    const denominatorHours = Math.min(windowMs, Math.max(1, anchorMs - startedMs)) / 3_600_000;
    rolling[minutes] = { count, per_hour: rounded(count / denominatorHours) };
  }
  const complete = observedMs >= endedMs;
  const storesPassed = Object.values(remainingByStore).every((remaining) => remaining === 0);
  const totalTarget = perStoreTarget * storeIds.length;
  const paceDeadlineMs = startedMs + (totalTarget / 35) * 3_600_000;
  const paceCounts = Object.fromEntries(storeIds.map((id) => [String(id), 0]));
  let targetReachedMs = null;
  for (const row of strictChronological) {
    const key = String(Number(row.store_id || 0));
    if (!(key in paceCounts)) continue;
    paceCounts[key] += 1;
    if (Object.values(paceCounts).every((count) => count >= perStoreTarget)) {
      targetReachedMs = Date.parse(row.published_at || row.timestamp || "");
      break;
    }
  }
  const hoursToTarget = targetReachedMs === null ? null : Math.max(0, targetReachedMs - startedMs) / 3_600_000;
  const remainingForPace = Object.values(remainingByStore).reduce((sum, value) => sum + Number(value || 0), 0);
  const remainingPaceHours = Math.max(0, paceDeadlineMs - anchorMs) / 3_600_000;
  const activePerHour = hoursToTarget && hoursToTarget > 0
    ? rounded(totalTarget / hoursToTarget)
    : targetReachedMs === startedMs ? null : rounded(strict.length / Math.max(elapsedHours, Number.EPSILON));
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
      target: totalTarget,
      per_hour: elapsedHours > 0 ? rounded(strict.length / elapsedHours) : 0,
      by_store: strictByStore,
      remaining_by_store: remainingByStore,
      passed: complete && storesPassed,
    },
    pace_35: {
      deadline_at: new Date(paceDeadlineMs).toISOString(),
      target_reached_at: targetReachedMs === null ? null : new Date(targetReachedMs).toISOString(),
      hours_to_target: hoursToTarget === null ? null : rounded(hoursToTarget),
      active_per_hour: activePerHour,
      required_remaining_per_hour: targetReachedMs !== null || !(remainingPaceHours > 0)
        ? null
        : rounded(remainingForPace / remainingPaceHours),
      passed: targetReachedMs !== null && Number(activePerHour) >= 35,
    },
    selected: { total: selectedUnique.size, by_store: countByStore([...selectedUnique.values()], storeIds) },
    quota: {
      by_store: quotaByStore,
      shortfall_by_store: quotaShortfallByStore,
      constrained_stores: Object.entries(quotaShortfallByStore)
        .filter(([, shortfall]) => shortfall > 0).map(([storeId]) => storeId),
      next_reset_at: nextQuotaResetAt,
    },
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
    storeTargetEvents: await readJsonLines(path.join(root, "store_targets.jsonl")),
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
