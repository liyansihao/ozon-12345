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

function dayKey(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function buildStatusSnapshot({
  config = {},
  published = [],
  selected = [],
  skuStateEvents = [],
  storeTargetEvents = [],
  storeDailyUsageEvents = [],
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
  const configuredPerStoreTarget = Number(config.per_store_target);
  const requirePerStore = Number.isInteger(configuredPerStoreTarget) && configuredPerStoreTarget > 0;
  const perStoreTarget = requirePerStore ? configuredPerStoreTarget : null;
  const totalTarget = Math.max(
    1,
    Number(config.acceptance_target || config.publish_target)
      || (requirePerStore ? perStoreTarget * storeIds.length : 481),
  );
  const strict = strictRows(published, startedMs, anchorMs);
  const strictChronological = [...strict].sort((left, right) => (
    Date.parse(left.published_at || left.timestamp || "") - Date.parse(right.published_at || right.timestamp || "")
  ));
  const strictByStore = countByStore(strict, storeIds);
  const strictKeys = new Set(strict.map((row) => `${Number(row?.store_id || 0)}:${String(row?.sku || "").trim()}`));
  const remainingByStore = requirePerStore
    ? Object.fromEntries(storeIds.map((id) => [
      String(id),
      Math.max(0, perStoreTarget - Number(strictByStore[String(id)] || 0)),
    ]))
    : {};
  const selectedUnique = new Map();
  for (const event of selected || []) {
    const row = { ...(event?.data || {}), ...event };
    const sku = String(row?.sku || "").trim();
    const storeId = Number(row?.store_id || 0);
    if (sku && storeId > 0 && !EXCLUDED_SKUS.has(sku) && Number(row?.profit_rate) > 30) {
      selectedUnique.set(`${storeId}:${sku}`, row);
    }
  }
  const latestSkuStates = new Map();
  for (const event of skuStateEvents || []) {
    const sku = String(event?.sku ?? event?.data?.sku ?? "").trim();
    if (sku) latestSkuStates.set(sku, event);
  }
  const pendingConfirmationByStore = Object.fromEntries(storeIds.map((id) => [String(id), 0]));
  const selectedTerminalByStore = Object.fromEntries(storeIds.map((id) => [String(id), 0]));
  for (const row of selectedUnique.values()) {
    const sku = String(row?.sku || "").trim();
    const storeId = Number(row?.store_id || 0);
    const key = String(storeId);
    const state = latestSkuStates.get(sku);
    if (!(key in pendingConfirmationByStore) || strictKeys.has(`${storeId}:${sku}`)) continue;
    if (state?.status === "processing") pendingConfirmationByStore[key] += 1;
    else if (["failed", "skipped"].includes(String(state?.status || ""))) selectedTerminalByStore[key] += 1;
  }
  const latestStoreTargets = new Map();
  for (const event of storeTargetEvents || []) {
    const storeId = Number(event?.store_id || 0);
    const at = Date.parse(event?.at || event?.timestamp || "");
    if (!(storeId > 0) || (Number.isFinite(at) && at > anchorMs)) continue;
    const key = String(storeId);
    const previous = latestStoreTargets.get(key);
    const previousAt = Date.parse(previous?.at || previous?.timestamp || "");
    if (!previous || !Number.isFinite(at) || !Number.isFinite(previousAt) || at >= previousAt) {
      latestStoreTargets.set(key, event);
    }
  }
  const dailyTimeZone = String(config.daily_store_timezone || "UTC");
  const observedDay = dayKey(anchorMs, dailyTimeZone);
  const latestDailyUsage = new Map();
  for (const event of storeDailyUsageEvents || []) {
    const storeId = Number(event?.store_id || 0);
    const at = Date.parse(event?.at || event?.timestamp || "");
    if (!(storeId > 0)
      || !Number.isFinite(at)
      || at > anchorMs
      || dayKey(at, dailyTimeZone) !== observedDay) continue;
    const key = String(storeId);
    const previous = latestDailyUsage.get(key);
    if (!previous || at >= previous.at) latestDailyUsage.set(key, { ...event, at });
  }
  const quotaByStore = Object.fromEntries(storeIds.map((id) => {
    const event = latestStoreTargets.get(String(id));
    const usageEvent = latestDailyUsage.get(String(id));
    const eventAt = Date.parse(event?.at || event?.timestamp || "");
    const eventMatchesObservedDay = !Number.isFinite(eventAt) || dayKey(eventAt, dailyTimeZone) === observedDay;
    const verifiedUsage = eventMatchesObservedDay ? Number(event?.daily_usage) : Number.NaN;
    const submittedUsage = Number(usageEvent?.usage);
    const dailyUsage = Math.max(
      Number.isFinite(verifiedUsage) ? verifiedUsage : 0,
      Number.isFinite(submittedUsage) ? submittedUsage : 0,
    );
    const verifiedLimit = Number(event?.daily_limit);
    const submittedLimit = Number(usageEvent?.limit);
    const dailyLimit = verifiedLimit > 0 ? verifiedLimit : submittedLimit;
    return [String(id), {
      daily_usage: Number.isFinite(verifiedUsage) || Number.isFinite(submittedUsage) ? dailyUsage : null,
      daily_limit: dailyLimit > 0 ? dailyLimit : null,
      daily_remaining: dailyLimit > 0 && Number.isFinite(dailyUsage) ? Math.max(0, dailyLimit - dailyUsage) : null,
      erp_daily_usage: Number.isFinite(verifiedUsage) ? verifiedUsage : null,
      run_submitted_today: Number.isFinite(submittedUsage) ? submittedUsage : 0,
      strict_gap: Number(remainingByStore[String(id)] || 0),
      selected_terminal: Number(selectedTerminalByStore[String(id)] || 0),
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
      : Math.max(
        0,
        Number(remainingByStore[key] || 0)
          - Number(pendingConfirmationByStore[key] || 0)
          - dailyRemaining,
      )];
  }));
  for (const id of storeIds) {
    quotaByStore[String(id)].capacity_shortfall_until_reset = Number(quotaShortfallByStore[String(id)] || 0);
  }
  const nextQuotaResetAt = config.daily_store_timezone === "UTC"
    ? new Date(Date.UTC(
      new Date(anchorMs).getUTCFullYear(),
      new Date(anchorMs).getUTCMonth(),
      new Date(anchorMs).getUTCDate() + 1,
    )).toISOString()
    : config.daily_store_timezone === "Asia/Shanghai"
      ? (() => {
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Shanghai",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(new Date(anchorMs)).map((part) => [part.type, part.value]));
        return new Date(Date.UTC(
          Number(parts.year),
          Number(parts.month) - 1,
          Number(parts.day) + 1,
          -8,
        )).toISOString();
      })()
      : null;
  const rolling = {};
  for (const minutes of [15, 30, 60, 120]) {
    const windowMs = minutes * 60_000;
    const count = strict.filter((row) => Date.parse(row.published_at || row.timestamp || "") >= anchorMs - windowMs).length;
    const denominatorHours = Math.min(windowMs, Math.max(1, anchorMs - startedMs)) / 3_600_000;
    rolling[minutes] = { count, per_hour: rounded(count / denominatorHours) };
  }
  const complete = observedMs >= endedMs;
  const storesPassed = !requirePerStore || Object.values(remainingByStore).every((remaining) => remaining === 0);
  const paceDeadlineMs = startedMs + (totalTarget / 35) * 3_600_000;
  const paceCounts = Object.fromEntries(storeIds.map((id) => [String(id), 0]));
  let targetReachedMs = null;
  let totalPaceCount = 0;
  for (const row of strictChronological) {
    const key = String(Number(row.store_id || 0));
    if (!(key in paceCounts)) continue;
    paceCounts[key] += 1;
    totalPaceCount += 1;
    if ((requirePerStore && Object.values(paceCounts).every((count) => count >= perStoreTarget))
      || (!requirePerStore && totalPaceCount >= totalTarget)) {
      targetReachedMs = Date.parse(row.published_at || row.timestamp || "");
      break;
    }
  }
  const hoursToTarget = targetReachedMs === null ? null : Math.max(0, targetReachedMs - startedMs) / 3_600_000;
  const remainingForPace = requirePerStore
    ? Object.values(remainingByStore).reduce((sum, value) => sum + Number(value || 0), 0)
    : Math.max(0, totalTarget - strict.length);
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
      passed: complete
        && strict.length >= totalTarget
        && storesPassed
        && strict.length / Math.max(elapsedHours, Number.EPSILON) > 20,
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
      pending_confirmation_by_store: pendingConfirmationByStore,
      selected_terminal_by_store: selectedTerminalByStore,
      capacity_shortfall_until_reset_by_store: quotaShortfallByStore,
      shortfall_by_store: quotaShortfallByStore,
      constrained_stores: storeIds.map(String).filter((storeId) => (
        Number(quotaShortfallByStore[storeId] || 0) > 0
          || quotaByStore[storeId]?.available === false
      )),
      next_reset_at: nextQuotaResetAt,
    },
    rolling,
    runtime_errors: {
      total: runtimeErrors.length,
      last_at: runtimeErrors.at(-1)?.at || null,
    },
  };
}

export function compactStatusSnapshot(snapshot = {}) {
  const quotaByStore = snapshot?.quota?.by_store || {};
  const unavailable = Object.fromEntries(Object.entries(quotaByStore)
    .filter(([, value]) => value?.available === false)
    .map(([storeId, value]) => [storeId, String(value?.reason || "unavailable")]));
  return {
    at: snapshot?.observed_at || null,
    elapsed_h: snapshot?.window?.elapsed_hours ?? null,
    remaining_s: snapshot?.window?.remaining_seconds ?? null,
    strict: Number(snapshot?.strict?.total || 0),
    target: Number(snapshot?.strict?.target || 0),
    rate_h: Number(snapshot?.strict?.per_hour || 0),
    by_store: snapshot?.strict?.by_store || {},
    selected: Number(snapshot?.selected?.total || 0),
    pending: snapshot?.quota?.pending_confirmation_by_store || {},
    rolling_h: Object.fromEntries(Object.entries(snapshot?.rolling || {})
      .map(([minutes, value]) => [minutes, Number(value?.per_hour || 0)])),
    constrained: snapshot?.quota?.constrained_stores || [],
    capacity_shortfall_until_reset: snapshot?.quota?.capacity_shortfall_until_reset_by_store
      || snapshot?.quota?.shortfall_by_store
      || {},
    shortfall: snapshot?.quota?.shortfall_by_store || {},
    unavailable,
    next_reset_at: snapshot?.quota?.next_reset_at || null,
    errors: Number(snapshot?.runtime_errors?.total || 0),
    pace35: snapshot?.pace_35?.passed === true,
    required_h: snapshot?.pace_35?.required_remaining_per_hour ?? null,
    complete: snapshot?.window?.complete === true,
    passed: snapshot?.strict?.passed === true,
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
    skuStateEvents: await readJsonLines(path.join(root, "sku_states.jsonl")),
    storeTargetEvents: await readJsonLines(path.join(root, "store_targets.jsonl")),
    storeDailyUsageEvents: await readJsonLines(path.join(root, "store_daily_usage.jsonl")),
    runtimeErrors: await readJsonLines(path.join(root, "runtime_errors.jsonl")),
    observedAt,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("usage: node scripts/flow_b_status_snapshot.mjs RUN_DIR [--compact]");
    process.exitCode = 2;
  } else {
    const snapshot = await snapshotRun(runDir);
    console.log(JSON.stringify(process.argv.includes("--compact") ? compactStatusSnapshot(snapshot) : snapshot));
  }
}
