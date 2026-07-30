#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildStrictSellerSourcePolicy,
  sellerRootUrl,
} from "./flow_b_playwright/source-policy.mjs";

const POLICY_WINDOW_MS = 2 * 60 * 60_000;

async function readJsonLines(filename) {
  try {
    return (await fs.readFile(filename, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readJsonObject(filename) {
  try {
    const value = JSON.parse(await fs.readFile(filename, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function readUrls(filename) {
  try {
    return (await fs.readFile(filename, "utf8"))
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeAtomic(filename, content) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, filename);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function mergedEvent(event = {}) {
  return event?.data && typeof event.data === "object"
    ? { ...event, ...event.data }
    : event;
}

function skuOf(event = {}) {
  const row = mergedEvent(event);
  return String(row?.sku ?? row?.id ?? "").trim();
}

function sellerOf(event = {}) {
  const row = mergedEvent(event);
  return sellerRootUrl(
    row?.seller_url
      || row?.source_url
      || row?.url
      || row?.href,
  );
}

function sourceSellerIndex(events = []) {
  const result = new Map();
  for (const event of events) {
    const sku = skuOf(event);
    const seller = sellerOf(event);
    if (sku && seller) result.set(sku, seller);
  }
  return result;
}

function evidenceWindowStart(acceptanceWindow, now) {
  const nowMs = now.getTime();
  const acceptanceStartMs = Date.parse(String(acceptanceWindow?.started_at || ""));
  const rollingStartMs = nowMs - POLICY_WINDOW_MS;
  return new Date(
    Number.isFinite(acceptanceStartMs)
      ? Math.max(acceptanceStartMs, rollingStartMs)
      : rollingStartMs,
  ).toISOString();
}

export async function refreshSourcePortfolio({
  stateRoot,
  runDir = null,
  seedFile,
  minimumActiveSources = 60,
  now = new Date(),
  rng = Math.random,
} = {}) {
  const resolvedStateRoot = path.resolve(stateRoot);
  const historyDir = path.join(resolvedStateRoot, "history");
  const sourceDir = path.join(resolvedStateRoot, "sources");
  await fs.mkdir(historyDir, { recursive: true });
  const [
    historicalYield,
    historicalFbs,
    runYield,
    runFbs,
    stageTimings,
    publications,
    acceptanceWindow,
    previousPortfolio,
    policyHistory,
    seedUrls,
  ] = await Promise.all([
    readJsonLines(path.join(historyDir, "source_yield_history.jsonl")),
    readJsonLines(path.join(historyDir, "fbs_source_history.jsonl")),
    runDir ? readJsonLines(path.join(runDir, "source_yield.jsonl")) : [],
    runDir ? readJsonLines(path.join(runDir, "favorite_collection.jsonl")) : [],
    runDir ? readJsonLines(path.join(runDir, "stage_timings.jsonl")) : [],
    runDir ? readJsonLines(path.join(runDir, "published.jsonl")) : [],
    runDir ? readJsonObject(path.join(runDir, "acceptance_window.json")) : {},
    readJsonObject(path.join(sourceDir, "source_portfolio.json")),
    readJsonLines(path.join(historyDir, "source_policy_decisions.jsonl")),
    readUrls(seedFile),
  ]);

  const attributionRows = [
    ...historicalYield,
    ...historicalFbs,
    ...runYield,
    ...runFbs,
    ...publications,
  ];
  const sellerBySku = sourceSellerIndex(attributionRows);
  const attributedDetails = stageTimings
    .filter((row) => String(row?.stage || row?.data?.stage || "") === "ozon_detail_and_category")
    .map((row) => ({
      ...row,
      seller_url: sellerOf(row) || sellerBySku.get(skuOf(row)) || null,
    }));
  const attributedPublications = publications.map((event) => {
    const row = mergedEvent(event);
    return {
      ...row,
      seller_url: sellerOf(row) || sellerBySku.get(skuOf(row)) || null,
    };
  });
  const explorationSellerUrls = [
    ...seedUrls,
    ...attributionRows.flatMap((row) => [
      mergedEvent(row)?.seller_url,
      mergedEvent(row)?.source_url,
    ]),
  ].map(sellerRootUrl).filter(Boolean);

  const policy = buildStrictSellerSourcePolicy({
    detailAttempts: attributedDetails,
    publications: attributedPublications,
    explorationSellerUrls,
    previousDecision: previousPortfolio?.policy || null,
    windowStartedAt: evidenceWindowStart(acceptanceWindow, now),
    now,
    slots: Math.max(10, Math.floor(Number(minimumActiveSources) || 60)),
    exploitRatio: 0.9,
    rng,
  });
  if (policy.active_urls.length === 0) {
    throw new Error("seller-only source policy produced no usable Ozon seller URLs");
  }
  const activeSourceText = `${policy.active_urls.join("\n")}\n`;
  const sourceSetSha256 = sha256(activeSourceText);

  const portfolio = {
    schema_version: 2,
    generated_at: policy.generated_at,
    strategy: "current-2h-unique-strict-per-unique-detail-attempt",
    derived_search_enabled: false,
    active_urls: policy.active_urls,
    source_set_sha256: sourceSetSha256,
    policy,
    metrics: policy.sellers,
    disabled: [],
    counts: {
      active_sources: policy.active_urls.length,
      strict_policy_sellers: policy.sellers.filter((row) => row.unique_strict > 0).length,
      exploration_sources: policy.allocation.explore,
      unique_detail_attempts: policy.unique_detail_attempts,
      unique_strict: policy.unique_strict,
      derived_sources: 0,
    },
  };
  const lastRecordedDecision = policyHistory.at(-1) || {};
  const decisionChanged = (
    String(lastRecordedDecision?.generated_at || "") !== String(policy.generated_at || "")
    || String(lastRecordedDecision?.source_set_sha256 || "") !== sourceSetSha256
  );
  await Promise.all([
    writeAtomic(path.join(sourceDir, "active_urls.txt"), activeSourceText),
    writeAtomic(path.join(sourceDir, "source_portfolio.json"), `${JSON.stringify(portfolio, null, 2)}\n`),
    writeAtomic(
      path.join(sourceDir, "source_funnel.jsonl"),
      `${portfolio.metrics.map((row) => JSON.stringify(row)).join("\n")}\n`,
    ),
    writeAtomic(path.join(sourceDir, "source_disabled.jsonl"), ""),
  ]);
  if (decisionChanged) {
    await fs.appendFile(
      path.join(historyDir, "source_policy_decisions.jsonl"),
      `${JSON.stringify({
        recorded_at: new Date(now).toISOString(),
        policy_version: policy.policy_version,
        generated_at: policy.generated_at,
        frozen_until: policy.frozen_until,
        strategy: portfolio.strategy,
        source_set_sha256: sourceSetSha256,
        allocation: policy.allocation,
        unique_detail_attempts: policy.unique_detail_attempts,
        unique_strict: policy.unique_strict,
        active_urls: policy.active_urls,
      })}\n`,
      "utf8",
    );
  }
  return portfolio;
}

async function main(argv = process.argv.slice(2)) {
  const [command, stateRoot, runDirArg, seedFileArg] = argv;
  if (command !== "refresh" || !stateRoot) {
    throw new Error("usage: ozon_source_portfolio.mjs refresh STATE_ROOT [RUN_DIR|-] [SEED_FILE]");
  }
  const runDir = runDirArg && runDirArg !== "-" ? path.resolve(runDirArg) : null;
  const seedFile = seedFileArg || path.resolve(import.meta.dirname, "../config/ozon_source_seed.txt");
  const portfolio = await refreshSourcePortfolio({
    stateRoot: path.resolve(stateRoot),
    runDir,
    seedFile,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, counts: portfolio.counts })}\n`);
}

async function invokedAsMain(argv1 = process.argv[1]) {
  if (!argv1) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return await fs.realpath(path.resolve(argv1)) === await fs.realpath(modulePath);
  } catch {
    return path.resolve(argv1) === path.resolve(modulePath);
  }
}

if (await invokedAsMain()) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
    process.exitCode = 1;
  });
}
