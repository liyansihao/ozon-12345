#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const EXPECTED_STORE_IDS = Object.freeze([106637, 106640, 106644, 106646, 104965]);
const VERIFIED_WAREHOUSES = Object.freeze({
  104965: 1020005022957960,
  106637: 1020005023256510,
  106640: 1020005023295220,
  106644: 1020005023295540,
});

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
    if (id === 106646) {
      if (target.warehouseId !== null && target.warehouseId !== undefined) {
        throw new Error("store 106646 warehouseId must remain unset until ERP uniquely verifies it");
      }
      continue;
    }
    if (Number(target.warehouseId) !== VERIFIED_WAREHOUSES[id]) {
      throw new Error(`store ${id} warehouseId does not match the verified configuration`);
    }
  }
  return ids;
}

export function validate24hAcceptanceEnv(env = process.env) {
  requireNumber(env, "FLOW_B_ACCEPTANCE_SECONDS", 86400);
  requireNumber(env, "FLOW_B_ACCEPTANCE_TARGET", 500);
  requireNumber(env, "FLOW_B_STORE_ACCEPTANCE_TARGET", 100);
  requireNumber(env, "FLOW_B_TARGET_PUBLISH_COUNT", 500);
  requireNumber(env, "FLOW_B_DAILY_STORE_LIMIT", 100);
  requireNumber(env, "FLOW_B_STORE_TOTAL_LIMIT", 100);
  requireNumber(env, "FLOW_B_PROFIT_THRESHOLD", 30);
  requireNumber(env, "FLOW_B_WATERMARK_ID", 60822);
  if (String(env.FLOW_B_WATERMARK_NEEDLE || "").trim() !== "lysh") {
    throw new Error("FLOW_B_WATERMARK_NEEDLE must equal lysh");
  }
  const excluded = new Set(String(env.FLOW_B_EXCLUDED_SKUS || "").split(/[,\s]+/u).filter(Boolean));
  if (!excluded.has("2815247918")) throw new Error("FLOW_B_EXCLUDED_SKUS must include 2815247918");
  requireFlag(env, "FLOW_B_VERIFY_LISTING_FBS_DETAIL");
  requireFlag(env, "FLOW_B_1688_PERSISTENT_POOL");
  const initialPublishWorkers = Number(env.FLOW_B_PUBLISH_WORKERS);
  const maxPublishWorkers = Number(env.FLOW_B_MAX_PUBLISH_WORKERS);
  if (initialPublishWorkers !== 8 || maxPublishWorkers !== 12) {
    throw new Error("publish concurrency must be 8..12");
  }
  const initialTabs = Number(env.FLOW_B_TAB_WORKERS);
  const maxTabs = Number(env.FLOW_B_MAX_TAB_WORKERS);
  if (initialTabs !== 3 || maxTabs !== 4) throw new Error("producer concurrency must be 3..4");
  if (Number(env.FLOW_B_1688_WORKERS) !== 4) throw new Error("FLOW_B_1688_WORKERS must equal 4");
  const storeIds = parseTargets(env);
  return {
    ok: true,
    duration_seconds: 86400,
    target: 500,
    per_store_target: 100,
    store_ids: storeIds,
    strict_profit_rule: "profit_rate > 30",
    watermark_id: 60822,
    excluded_skus: [...excluded],
    concurrency: { publish: [8, 12], producer: [3, 4], sourcing_1688: 4 },
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
