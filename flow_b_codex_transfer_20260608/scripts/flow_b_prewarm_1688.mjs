#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { createCostBridge } from "./flow_b_playwright/cost-bridge.mjs";
import { isPureFbs } from "./flow_b_playwright/publish-policy.mjs";

const BAD_SKUS = new Set(["2815247918"]);
const FACT_FIELDS = ["title", "cover_image", "shipping_mode", "mode", "sale_price", "sell_price", "source_url"];

async function readJsonLines(filename) {
  let text = "";
  try { text = await fs.readFile(path.resolve(filename), "utf8"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const rows = [];
  for (const line of text.split(/\r?\n/u)) {
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row);
    } catch {}
  }
  return rows;
}

function eventPayload(event) {
  return event?.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? { ...event, ...event.data }
    : event || {};
}

export function selectPrewarmCandidates({ favoriteEvents = [], stateEvents = [], excludedSkus = BAD_SKUS } = {}) {
  const latestFavorite = new Map();
  const latestState = new Map();
  const facts = new Map();
  for (const event of favoriteEvents) {
    const sku = String(event?.sku ?? event?.data?.sku ?? "").trim();
    if (!sku) continue;
    latestFavorite.set(sku, event);
    const payload = eventPayload(event);
    const merged = { ...(facts.get(sku) || {}) };
    for (const field of FACT_FIELDS) {
      if (payload[field] !== null && payload[field] !== undefined && payload[field] !== "") merged[field] = payload[field];
    }
    facts.set(sku, merged);
  }
  for (const event of stateEvents) {
    const sku = String(event?.sku ?? event?.data?.sku ?? "").trim();
    if (sku) latestState.set(sku, event);
  }
  const candidates = [];
  for (const [sku, event] of latestFavorite) {
    if (event?.status !== "favorited" || excludedSkus.has(sku)) continue;
    if (["published", "skipped"].includes(String(latestState.get(sku)?.status || ""))) continue;
    const fact = facts.get(sku) || {};
    const sellPrice = Number(fact.sale_price ?? fact.sell_price);
    if (!fact.title || !/^https?:\/\//iu.test(String(fact.cover_image || ""))
      || !isPureFbs(fact.shipping_mode ?? fact.mode) || !(sellPrice > 0) || !fact.source_url) continue;
    candidates.push({
      sku,
      title: fact.title,
      cover_image: fact.cover_image,
      shipping_mode: fact.shipping_mode ?? fact.mode,
      sale_price: sellPrice,
      sell_price: sellPrice,
      source_url: fact.source_url,
    });
  }
  return candidates;
}

export async function prewarmCandidateCosts({ candidates = [], bridge, runDir, concurrency = 4, onProgress = () => {} } = {}) {
  if (!bridge || typeof bridge.estimate !== "function") throw new TypeError("bridge.estimate is required");
  const queue = [...candidates];
  const summary = {
    candidates: queue.length,
    completed: 0,
    cache_hits: 0,
    cache_misses: 0,
    reliable: 0,
    rejected: 0,
    errors: 0,
  };
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      try {
        const result = await bridge.estimate(item, runDir);
        if (result?.cached) summary.cache_hits += 1;
        else summary.cache_misses += 1;
        if (result?.ok) summary.reliable += 1;
        else if (result?.reason) summary.rejected += 1;
        else summary.errors += 1;
      } catch {
        summary.cache_misses += 1;
        summary.errors += 1;
      } finally {
        summary.completed += 1;
        onProgress({ ...summary });
      }
    }
  }
  const workerCount = Math.min(queue.length || 1, Math.max(1, Number(concurrency) || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return summary;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      favorites: { type: "string" },
      states: { type: "string" },
      "run-dir": { type: "string" },
      "shared-cache": { type: "string" },
      workers: { type: "string", default: env.FLOW_B_1688_WORKERS || "4" },
      limit: { type: "string", default: "0" },
    },
    strict: true,
  });
  for (const name of ["favorites", "states", "run-dir", "shared-cache"]) {
    if (!values[name]) throw new Error(`--${name} is required`);
  }
  const favoriteEvents = await readJsonLines(values.favorites);
  const stateEvents = await readJsonLines(values.states);
  let candidates = selectPrewarmCandidates({ favoriteEvents, stateEvents });
  const limit = Math.max(0, Number(values.limit) || 0);
  if (limit > 0) candidates = candidates.slice(0, limit);
  const bridge = createCostBridge({
    python: env.FLOW_B_PYTHON || "python3",
    sharedCachePath: path.resolve(values["shared-cache"]),
    workerCount: Math.max(1, Number(values.workers) || 4),
  });
  let lastReported = 0;
  try {
    const summary = await prewarmCandidateCosts({
      candidates,
      bridge,
      runDir: path.resolve(values["run-dir"]),
      concurrency: Math.max(1, Number(values.workers) || 4),
      onProgress(progress) {
        if (progress.completed === progress.candidates || progress.completed - lastReported >= 20) {
          lastReported = progress.completed;
          process.stderr.write(`prewarm ${progress.completed}/${progress.candidates}\n`);
        }
      },
    });
    const report = { generated_at: new Date().toISOString(), ...summary };
    await fs.mkdir(path.resolve(values["run-dir"]), { recursive: true });
    await fs.writeFile(path.join(path.resolve(values["run-dir"]), "prewarm_1688_summary.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report;
  } finally {
    await bridge.close();
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
    process.exitCode = 1;
  });
}
