#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prohibitedCategorySkipReason } from "./flow_b_playwright/publish-policy.mjs";
import {
  deriveSearchSourceUrls,
  sourceYieldKey,
} from "./flow_b_playwright/source-scanner.mjs";

const DEFAULT_SAFE_QUERIES = [
  "деревянный конструктор",
  "набор канцелярии",
  "плюшевая игрушка",
  "органайзер для дома",
  "щетка для уборки",
  "силиконовые кухонные принадлежности",
  "набор инструментов ручных",
  "развивающая игрушка",
];

function sourceUrl(row) {
  return String(row?.source_url || row?.seller_url || "").trim();
}

function skuOf(row, fallback) {
  return String(row?.sku || fallback || "").trim();
}

function sourceRecord(records, url) {
  if (!records.has(url)) records.set(url, { source_url: url, skus: new Map(), scans: [] });
  return records.get(url);
}

function skuRecord(source, sku) {
  if (!source.skus.has(sku)) {
    source.skus.set(sku, {
      sku,
      titles: new Set(),
      statuses: new Set(),
      reasons: new Set(),
      fbs_statuses: new Set(),
      exact_fbs: false,
    });
  }
  return source.skus.get(sku);
}

function reasonMatches(reasons, pattern) {
  return [...reasons].some((reason) => pattern.test(reason));
}

function reliableCostEvidence(sku) {
  const positive = sku.statuses.has("published")
    || sku.statuses.has("submitted")
    || sku.statuses.has("validated")
    || reasonMatches(sku.reasons, /profit(?:_rate|-upper-bound)<=30|online-product-rejected|publish-final-status-timeout/i);
  if (positive) return true;
  return !reasonMatches(sku.reasons, /1688-no-reliable-match|1688-health-deferred/i)
    && sku.statuses.size > 0;
}

function submittedEvidence(sku) {
  return sku.statuses.has("published")
    || sku.statuses.has("submitted")
    || reasonMatches(sku.reasons, /online-product-rejected|publish-final-status-timeout/i);
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : 0;
}

function noCandidateStreak(scans) {
  let streak = 0;
  for (let index = scans.length - 1; index >= 0; index -= 1) {
    const eligible = Number(scans[index]?.eligible_link_count_before_collection);
    if (Number.isFinite(eligible) && eligible === 0) streak += 1;
    else break;
  }
  return streak;
}

function disableReason(row) {
  if (row.source_url_prohibited
    || (row.prohibited_count >= 2 && ratio(row.prohibited_count, row.funnel.scanned) >= 0.3)) {
    return "prohibited-category-dominant";
  }
  if (row.funnel.submitted >= 4
    && ratio(row.failures.online_product_rejected, row.funnel.submitted) >= 0.4) {
    return "online-product-rejected-rate";
  }
  if (row.funnel.scanned >= 8
    && ratio(row.failures.no_reliable_1688_match, row.funnel.scanned) >= 0.75) {
    return "1688-identity-ambiguity";
  }
  if (row.fbs_checked >= 4 && ratio(row.funnel.pure_fbs, row.fbs_checked) < 0.2) {
    return "low-pure-fbs-rate";
  }
  if (row.no_new_candidate_streak >= 2) return "source-exhausted-no-new-candidates";
  return null;
}

function sourceScore(row) {
  const finalRate = ratio(row.funnel.final_confirmed, row.funnel.submitted);
  const fbsRate = ratio(row.funnel.pure_fbs, row.fbs_checked);
  const costRate = ratio(row.funnel.reliable_cost, row.funnel.scanned);
  const profitRate = ratio(row.funnel.profit_pass, row.funnel.reliable_cost);
  const rejectionRate = ratio(row.failures.online_product_rejected, row.funnel.submitted);
  return Math.round((
    row.funnel.final_confirmed * 100
    + row.funnel.submitted * 12
    + finalRate * 80
    + fbsRate * 35
    + costRate * 25
    + profitRate * 20
    - row.failures.online_product_rejected * 50
    - rejectionRate * 100
    - row.no_new_candidate_streak * 25
  ) * 100) / 100;
}

function prohibitedSourceUrl(value) {
  let decoded = String(value || "");
  try {
    decoded = decodeURIComponent(decoded.replaceAll("+", " "));
  } catch {}
  return Boolean(prohibitedCategorySkipReason(decoded));
}

export function aggregateSourceEvidence({
  yieldRows = [],
  fbsRows = [],
  scanRows = [],
} = {}) {
  const records = new Map();
  for (const [index, row] of yieldRows.entries()) {
    const url = sourceUrl(row);
    if (!url) continue;
    const source = sourceRecord(records, url);
    const sku = skuRecord(source, skuOf(row, `yield-${index}`));
    if (row?.title) sku.titles.add(String(row.title));
    if (row?.status) sku.statuses.add(String(row.status));
    if (row?.reason) sku.reasons.add(String(row.reason));
  }
  for (const [index, row] of fbsRows.entries()) {
    const url = sourceUrl(row);
    if (!url) continue;
    const source = sourceRecord(records, url);
    const sku = skuRecord(source, skuOf(row, `fbs-${index}`));
    if (row?.title) sku.titles.add(String(row.title));
    if (row?.status) sku.fbs_statuses.add(String(row.status));
    if (row?.reason) sku.reasons.add(String(row.reason));
    if (row?.status === "favorited"
      && String(row?.shipping_mode || row?.preflight_mode || "").toUpperCase() === "FBS") {
      sku.exact_fbs = true;
    }
  }
  for (const row of scanRows) {
    const url = sourceUrl(row);
    if (url) sourceRecord(records, url).scans.push(row);
  }

  const rows = [...records.values()].map((source) => {
    const skus = [...source.skus.values()];
    const reliable = skus.filter(reliableCostEvidence);
    const identity = reliable.filter((sku) => !reasonMatches(sku.reasons, /identity|spec|model|quantity|same-item/i));
    const submitted = skus.filter(submittedEvidence);
    const profit = submitted.filter((sku) => (
      sku.statuses.has("published")
      || sku.statuses.has("submitted")
      || reasonMatches(sku.reasons, /online-product-rejected|publish-final-status-timeout/i)
    ));
    const finalConfirmed = skus.filter((sku) => sku.statuses.has("published"));
    const onlineRejected = skus.filter((sku) => reasonMatches(sku.reasons, /online-product-rejected/i));
    const noMatch = skus.filter((sku) => reasonMatches(sku.reasons, /1688-no-reliable-match/i));
    const prohibitedCount = skus.filter((sku) => (
      [...sku.titles].some((title) => prohibitedCategorySkipReason(title))
    )).length;
    const row = {
      source_url: source.source_url,
      funnel: {
        scanned: skus.length,
        pure_fbs: skus.filter((sku) => sku.exact_fbs).length,
        reliable_cost: reliable.length,
        identity_spec_pass: identity.length,
        profit_pass: profit.length,
        submitted: submitted.length,
        final_confirmed: finalConfirmed.length,
      },
      rates: {},
      failures: {
        online_product_rejected: onlineRejected.length,
        no_reliable_1688_match: noMatch.length,
      },
      fbs_checked: skus.filter((sku) => sku.fbs_statuses.size > 0).length,
      prohibited_count: prohibitedCount,
      source_url_prohibited: prohibitedSourceUrl(source.source_url),
      no_new_candidate_streak: noCandidateStreak(source.scans),
    };
    row.rates = {
      pure_fbs: ratio(row.funnel.pure_fbs, row.fbs_checked),
      reliable_cost: ratio(row.funnel.reliable_cost, row.funnel.scanned),
      identity_spec_pass: ratio(row.funnel.identity_spec_pass, row.funnel.reliable_cost),
      profit_pass: ratio(row.funnel.profit_pass, row.funnel.reliable_cost),
      submit: ratio(row.funnel.submitted, row.funnel.scanned),
      final_confirmed: ratio(row.funnel.final_confirmed, row.funnel.submitted),
      online_product_rejected: ratio(row.failures.online_product_rejected, row.funnel.submitted),
    };
    row.disabled_reason = disableReason(row);
    row.score = sourceScore(row);
    return row;
  });
  const families = new Map();
  for (const row of rows) {
    const family = sellerRoot(row.source_url);
    if (!family) continue;
    const aggregate = families.get(family) || {
      source_url: family,
      funnel: Object.fromEntries(Object.keys(row.funnel).map((key) => [key, 0])),
      failures: Object.fromEntries(Object.keys(row.failures).map((key) => [key, 0])),
      fbs_checked: 0,
      prohibited_count: 0,
      source_url_prohibited: false,
      no_new_candidate_streak: 0,
    };
    for (const [key, value] of Object.entries(row.funnel)) aggregate.funnel[key] += Number(value) || 0;
    for (const [key, value] of Object.entries(row.failures)) aggregate.failures[key] += Number(value) || 0;
    aggregate.fbs_checked += Number(row.fbs_checked) || 0;
    aggregate.prohibited_count += Number(row.prohibited_count) || 0;
    aggregate.source_url_prohibited ||= row.source_url_prohibited;
    aggregate.no_new_candidate_streak = Math.max(
      aggregate.no_new_candidate_streak,
      Number(row.no_new_candidate_streak) || 0,
    );
    families.set(family, aggregate);
  }
  for (const row of rows) {
    const family = sellerRoot(row.source_url);
    const familyReason = family ? disableReason(families.get(family)) : null;
    if (!row.disabled_reason && familyReason) row.disabled_reason = `seller-family-${familyReason}`;
  }
  return rows.sort((left, right) => right.score - left.score || left.source_url.localeCompare(right.source_url));
}

function sellerRoot(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^(\/seller\/[^/]+\/)/u);
    return match ? `${url.origin}${match[1]}` : null;
  } catch {
    return null;
  }
}

function nextSellerVariants(row) {
  const root = sellerRoot(row.source_url);
  if (!root) return [];
  let page = 1;
  try {
    page = Math.max(1, Number(new URL(row.source_url).searchParams.get("page")) || 1);
  } catch {}
  return [
    root,
    `${root}?page=${Math.min(40, page + 1)}`,
    `${root}?currency_price=500.000%3B&sorting=rating`,
    `${root}?currency_price=500.000%3B&sorting=discount`,
  ];
}

function safeQueryUrls() {
  return DEFAULT_SAFE_QUERIES.flatMap((query) => [500, 1000].map((ceiling) => (
    `https://www.ozon.ru/search/?text=${encodeURIComponent(query)}&is_global=true&currency_price=${ceiling}.000%3B&sorting=rating`
  )));
}

function addUnique(target, seen, value, limit) {
  const normalized = String(value || "").trim();
  const family = sourceYieldKey(normalized);
  if (!normalized || !family || seen.has(family) || target.length >= limit) return false;
  seen.add(family);
  target.push(normalized);
  return true;
}

export function buildSourcePortfolio({
  yieldRows = [],
  fbsRows = [],
  scanRows = [],
  seedUrls = [],
  minimumActiveSources = 60,
  maximumActiveSources = 120,
} = {}) {
  const evidence = aggregateSourceEvidence({ yieldRows, fbsRows, scanRows });
  const enabled = evidence.filter((row) => !row.disabled_reason);
  const disabled = evidence.filter((row) => row.disabled_reason);
  const strict = enabled.filter((row) => row.funnel.final_confirmed > 0);
  const fbs = enabled.filter((row) => row.funnel.pure_fbs > 0 && row.funnel.final_confirmed === 0);
  const desired = Math.max(1, Number(minimumActiveSources) || 60);
  const limit = Math.max(desired, Number(maximumActiveSources) || 120);
  const derivedQueries = deriveSearchSourceUrls(
    yieldRows,
    Math.max(desired * 4, 60),
    ["150.000;", "500.000;"],
    [1],
  );
  const active = [];
  const seen = new Set();
  const strictBudget = Math.max(1, Math.ceil(desired * 0.7));
  const fbsBudget = Math.max(1, Math.ceil(desired * 0.2));
  const explorationBudget = Math.max(1, desired - strictBudget - fbsBudget);
  for (const row of strict.slice(0, strictBudget)) addUnique(active, seen, row.source_url, limit);
  for (const row of fbs.slice(0, fbsBudget)) addUnique(active, seen, row.source_url, limit);
  const disabledUrls = new Set(disabled.map((row) => sourceYieldKey(row.source_url)));
  const evidenceUrls = new Set(evidence.map((row) => sourceYieldKey(row.source_url)));
  let explorationAdded = 0;
  for (const url of [...seedUrls, ...derivedQueries, ...safeQueryUrls()]) {
    const family = sourceYieldKey(url);
    if (!disabledUrls.has(family)
      && !prohibitedSourceUrl(url)
      && !evidenceUrls.has(family)
      && addUnique(active, seen, url, limit)) explorationAdded += 1;
    if (explorationAdded >= explorationBudget) break;
  }
  for (const row of strict) {
    for (const variant of nextSellerVariants(row)) {
      if (!prohibitedSourceUrl(variant)) addUnique(active, seen, variant, limit);
    }
    if (active.length >= desired) break;
  }
  for (const row of enabled) {
    if (!prohibitedSourceUrl(row.source_url)) addUnique(active, seen, row.source_url, limit);
    if (active.length >= desired) break;
  }
  if (active.length < desired) {
    for (const url of [...seedUrls, ...derivedQueries, ...safeQueryUrls()]) {
      const family = sourceYieldKey(url);
      if (!disabledUrls.has(family)
        && !prohibitedSourceUrl(url)
        && !evidenceUrls.has(family)) {
        addUnique(active, seen, url, limit);
      }
      if (active.length >= desired) break;
    }
  }
  return {
    generated_at: new Date().toISOString(),
    active_urls: active,
    metrics: evidence,
    disabled,
    counts: {
      evidence_sources: evidence.length,
      active_sources: active.length,
      disabled_sources: disabled.length,
      strict_sources: strict.length,
      pure_fbs_sources: fbs.length,
      exploration_sources: active.filter((url) => !evidence.some((row) => row.source_url === url)).length,
    },
  };
}

async function readJsonLines(filename) {
  try {
    const text = await fsp.readFile(filename, "utf8");
    return text.split(/\r?\n/).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readJsonArray(filename) {
  try {
    const value = JSON.parse(await fsp.readFile(filename, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
}

async function readJsonObject(filename) {
  try {
    const value = JSON.parse(await fsp.readFile(filename, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

export function sourceScanCheckpointPath(runDir, sourceConfig = {}) {
  const root = path.resolve(runDir);
  const fallback = path.join(root, "source_deep_scan.json");
  const configured = String(sourceConfig?.scan_output || "").trim();
  if (!configured) return fallback;
  const candidate = path.resolve(root, configured);
  return path.dirname(candidate) === root && path.extname(candidate) === ".json"
    ? candidate
    : fallback;
}

async function readUrls(filename) {
  try {
    return (await fsp.readFile(filename, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^https:\/\//u.test(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeAtomic(filename, content) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, content, "utf8");
  await fsp.rename(temporary, filename);
}

export async function refreshSourcePortfolio({
  stateRoot,
  runDir = null,
  seedFile,
  minimumActiveSources = 60,
} = {}) {
  const historyDir = path.join(stateRoot, "history");
  const candidateFbsRows = runDir
    ? (await readJsonLines(path.join(runDir, "candidate_queue.jsonl"))).filter((row) => (
      /source deferred after low pure-FBS yield/i.test(String(row?.reason || ""))
    ))
    : [];
  const yieldRows = [
    ...await readJsonLines(path.join(historyDir, "source_yield_history.jsonl")),
    ...(runDir ? await readJsonLines(path.join(runDir, "source_yield.jsonl")) : []),
  ];
  const fbsRows = [
    ...await readJsonLines(path.join(historyDir, "fbs_source_history.jsonl")),
    ...(runDir ? await readJsonLines(path.join(runDir, "favorite_collection.jsonl")) : []),
    ...candidateFbsRows,
  ];
  const sourceConfig = runDir
    ? await readJsonObject(path.join(runDir, "source_config.json"))
    : {};
  const scanRows = runDir
    ? await readJsonArray(sourceScanCheckpointPath(runDir, sourceConfig))
    : [];
  const seedUrls = await readUrls(seedFile);
  const portfolio = buildSourcePortfolio({
    yieldRows,
    fbsRows,
    scanRows,
    seedUrls,
    minimumActiveSources,
  });
  const sourceDir = path.join(stateRoot, "sources");
  await Promise.all([
    writeAtomic(path.join(sourceDir, "active_urls.txt"), `${portfolio.active_urls.join("\n")}\n`),
    writeAtomic(path.join(sourceDir, "source_portfolio.json"), `${JSON.stringify(portfolio, null, 2)}\n`),
    writeAtomic(path.join(sourceDir, "source_funnel.jsonl"), `${portfolio.metrics.map((row) => JSON.stringify(row)).join("\n")}\n`),
    writeAtomic(path.join(sourceDir, "source_disabled.jsonl"), `${portfolio.disabled.map((row) => JSON.stringify(row)).join("\n")}\n`),
  ]);
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

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
    process.exitCode = 1;
  });
}
