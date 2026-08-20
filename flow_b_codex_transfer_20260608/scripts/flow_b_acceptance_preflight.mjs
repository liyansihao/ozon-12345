#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { RUNTIME_STATE_SCHEMA_VERSION } from "./flow_b_playwright/runtime-state.mjs";

const EXPECTED_STORE_IDS = Object.freeze([106637, 106640, 106644, 106646, 104965]);

function requireNumber(env, name, expected) {
  const value = Number(env[name]);
  if (value !== expected) throw new Error(`${name} must equal ${expected}`);
  return value;
}

function requireFlag(env, name) {
  if (String(env[name] || "") !== "1") throw new Error(`${name} must equal 1`);
}

function parseTargets(env) {
  let targets;
  try {
    targets = JSON.parse(String(env.FLOW_B_STORE_TARGETS || ""));
  } catch {
    throw new Error("FLOW_B_STORE_TARGETS must be valid JSON");
  }
  if (!Array.isArray(targets) || targets.length !== EXPECTED_STORE_IDS.length) {
    throw new Error("FLOW_B_STORE_TARGETS must contain exactly five stores");
  }
  const ids = targets.map((row) => Number(row?.id));
  if (ids.join(",") !== EXPECTED_STORE_IDS.join(",")) {
    throw new Error(`store order must be ${EXPECTED_STORE_IDS.join(",")}`);
  }
  for (const target of targets) {
    const id = Number(target.id);
    if (target.requireWarehouse !== true) throw new Error(`store ${id} must require a verified warehouse`);
    if (!Number.isSafeInteger(Number(target.warehouseId)) || Number(target.warehouseId) <= 0) {
      throw new Error(`store ${id} must configure a positive warehouseId for live ERP uniqueness verification`);
    }
  }
  if (new Set(targets.map((target) => String(target.warehouseId))).size !== targets.length) {
    throw new Error("warehouse mappings must be unique across all five stores");
  }
  return ids;
}

export function validate24hAcceptanceEnv(env = process.env) {
  requireNumber(env, "FLOW_B_ACCEPTANCE_SECONDS", 86400);
  const targetPolicy = String(env.FLOW_B_ACCEPTANCE_TARGET_POLICY || "fixed");
  if (targetPolicy !== "fixed") throw new Error("FLOW_B_ACCEPTANCE_TARGET_POLICY must equal fixed");
  const target = requireNumber(env, "FLOW_B_ACCEPTANCE_TARGET", 500);
  requireNumber(env, "FLOW_B_TARGET_PUBLISH_COUNT", 500);
  requireNumber(env, "FLOW_B_STORE_ACCEPTANCE_TARGET", 100);
  requireFlag(env, "FLOW_B_REQUIRE_PER_STORE_ACCEPTANCE");
  requireNumber(env, "FLOW_B_MINIMUM_AVERAGE_PER_HOUR_EXCLUSIVE", 35);
  requireNumber(env, "FLOW_B_DAILY_STORE_LIMIT", 100);
  requireNumber(env, "FLOW_B_STORE_TOTAL_LIMIT", 100);
  if (String(env.FLOW_B_DAILY_STORE_TIMEZONE || "") !== "Asia/Shanghai") {
    throw new Error("FLOW_B_DAILY_STORE_TIMEZONE must equal Asia/Shanghai");
  }
  requireNumber(env, "FLOW_B_PROFIT_THRESHOLD", 30);
  requireNumber(env, "FLOW_B_WATERMARK_ID", 60822);
  if (String(env.FLOW_B_WATERMARK_NEEDLE || "").trim() !== "lysh") {
    throw new Error("FLOW_B_WATERMARK_NEEDLE must equal lysh");
  }
  const excluded = new Set(String(env.FLOW_B_EXCLUDED_SKUS || "").split(/[,\s]+/u).filter(Boolean));
  if (!excluded.has("2815247918")) throw new Error("FLOW_B_EXCLUDED_SKUS must include 2815247918");
  requireFlag(env, "FLOW_B_VERIFY_LISTING_FBS_DETAIL");
  requireFlag(env, "FLOW_B_1688_PERSISTENT_POOL");
  requireFlag(env, "FLOW_B_PROBE_INACTIVE_STORES");
  if (Number(env.FLOW_B_VERIFIED_SELLER_MIN_PUBLISHED) < 2) {
    throw new Error("FLOW_B_VERIFIED_SELLER_MIN_PUBLISHED must be at least 2");
  }
  const initialPublishWorkers = Number(env.FLOW_B_PUBLISH_WORKERS);
  const maxPublishWorkers = Number(env.FLOW_B_MAX_PUBLISH_WORKERS);
  if (initialPublishWorkers !== 8 || maxPublishWorkers !== 12) {
    throw new Error("publish concurrency must be 8..12");
  }
  const initialTabs = Number(env.FLOW_B_TAB_WORKERS);
  const maxTabs = Number(env.FLOW_B_MAX_TAB_WORKERS);
  if (initialTabs !== 3 || maxTabs !== 4) throw new Error("producer concurrency must be 3..4");
  const favoriteDetailIntervalMs = Number(env.FLOW_B_FAVORITE_DETAIL_INTERVAL_MS);
  if (!(favoriteDetailIntervalMs >= 4_000)) {
    throw new Error("favorite detail interval must be at least 4000ms");
  }
  if (Number(env.FLOW_B_CONFIRMATION_ATTEMPTS) !== 1) {
    throw new Error("confirmation attempts must equal 1");
  }
  if (Number(env.FLOW_B_CONFIRMATION_INTERVAL_MS) !== 0) {
    throw new Error("confirmation interval must equal 0ms");
  }
  if (Number(env.FLOW_B_1688_WORKERS) !== 4) throw new Error("FLOW_B_1688_WORKERS must equal 4");
  const unavailableRetryMs = Number(env.FLOW_B_UNAVAILABLE_STORE_RETRY_MS);
  if (!(unavailableRetryMs > 0) || unavailableRetryMs > 300_000) {
    throw new Error("unavailable store retry must be at most 300000ms");
  }
  const urgentOnlineSyncIntervalMs = Number(env.FLOW_B_URGENT_ONLINE_SYNC_INTERVAL_MS);
  if (!(urgentOnlineSyncIntervalMs >= 180_000)) {
    throw new Error("urgent online sync interval must be at least 180000ms");
  }
  for (const name of [
    "FLOW_B_DERIVED_SEARCH_SOURCES",
    "FLOW_B_DERIVED_PRIORITY_SOURCES",
    "FLOW_B_PRIORITIZE_DERIVED_SEARCH",
    "FLOW_B_LOW_TOKEN_INTERVENTION",
  ]) {
    if (String(env[name] || "") !== "0") throw new Error(`${name} must equal 0`);
  }
  requireFlag(env, "FLOW_B_STRICT_SOURCE_PORTFOLIO");
  if (String(env.FLOW_B_SOURCE_ALLOWLIST_MATCH || "") !== "exact") {
    throw new Error("FLOW_B_SOURCE_ALLOWLIST_MATCH must equal exact");
  }
  const sourceWeights = [
    Number(env.FLOW_B_SOURCE_STRICT_WEIGHT),
    Number(env.FLOW_B_SOURCE_FBS_WEIGHT),
    Number(env.FLOW_B_SOURCE_EXPLORE_WEIGHT),
  ];
  if (sourceWeights.join(",") !== "6,3,1") {
    throw new Error("source weights must freeze verified/exploration at 90/10");
  }
  if (!String(env.FLOW_B_RUNTIME_STATE_DB || "").trim().endsWith(".sqlite")) {
    throw new Error("FLOW_B_RUNTIME_STATE_DB must identify the external SQLite state");
  }
  requireNumber(env, "FLOW_B_RUNTIME_STATE_SCHEMA_VERSION", RUNTIME_STATE_SCHEMA_VERSION);
  const storeIds = parseTargets(env);
  return {
    ok: true,
    duration_seconds: 86400,
    target,
    target_policy: targetPolicy,
    minimum_average_per_hour: 35,
    minimum_average_per_hour_exclusive: 35,
    per_store_target: 100,
    store_ids: storeIds,
    strict_profit_rule: "profit_rate > 30",
    watermark_id: 60822,
    excluded_skus: [...excluded],
    concurrency: {
      publish: [8, 12],
      producer: [3, 4],
      sourcing_1688: 4,
      favorite_detail_interval_ms: favoriteDetailIntervalMs,
      confirmation_attempts: 1,
      urgent_online_sync_interval_ms: urgentOnlineSyncIntervalMs,
    },
  };
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    process.stdout.write(`${JSON.stringify(validate24hAcceptanceEnv())}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
    process.exitCode = 1;
  }
}
