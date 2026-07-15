#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { launchFlowContext, resolveBrowserOptions } from "./flow_b_playwright/browser-context.mjs";
import { discoverSellerSources, publishedProductUrls } from "./flow_b_playwright/seller-discovery.mjs";

const [outFileValue, ...inputFiles] = process.argv.slice(2);
if (!outFileValue || !inputFiles.length) throw new Error("Usage: flow_b_discover_sellers.mjs OUT.txt PUBLISHED.jsonl...");
const rows = [];
for (const inputFile of inputFiles) {
  const text = await fs.readFile(path.resolve(inputFile), "utf8");
  for (const line of text.split(/\r?\n/)) {
    try { rows.push(JSON.parse(line)); } catch {}
  }
}
const productUrls = publishedProductUrls(rows).slice(-Math.max(1, Number(process.env.FLOW_B_SELLER_DISCOVERY_LIMIT) || 200)).reverse();
const context = await launchFlowContext(resolveBrowserOptions({
  ...process.env,
  FLOW_B_PW_PROFILE: process.env.FLOW_B_PW_PROFILE || path.resolve(import.meta.dirname, "../runs/flow_b/playwright_setup/playwright_profile"),
}));
try {
  const result = await discoverSellerSources({
    context,
    productUrls,
    outFile: path.resolve(outFileValue),
    workers: Math.max(1, Number(process.env.FLOW_B_SELLER_DISCOVERY_WORKERS) || 4),
  });
  console.log(JSON.stringify(result));
} finally {
  await context.close().catch(() => {});
}
