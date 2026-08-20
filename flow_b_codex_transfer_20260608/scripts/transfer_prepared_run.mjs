#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import { ensureMaoziLogin, launchFlowContext, openMaoziPage, resolveBrowserOptions } from "./flow_b_playwright/browser-context.mjs";
import { createMaoziClient, createMaoziPageTransport } from "./flow_b_playwright/maozi-client.mjs";
import { selectPreparedTransferCandidates, transferPreparedCandidates } from "./flow_b_playwright/prepared-transfer.mjs";
import { createPublishState } from "./flow_b_playwright/publish-state.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

async function jsonLines(filename) {
  const rows = [];
  for (const line of (await fs.readFile(filename, "utf8")).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

async function requestedSkus(filename) {
  const result = new Set();
  const lines = (await fs.readFile(filename, "utf8")).split(/\r?\n/).slice(1);
  for (const line of lines) {
    const match = line.match(/^"([^"]+)"/);
    if (match?.[1]) result.add(match[1]);
  }
  return result;
}

function csvEscape(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

async function writePreparedCsv(filename, rows) {
  const headers = ["sku", "title", "product_link", "profit_rate", "sell_price", "purchase_price", "store_id", "watermark_id", "offer_id", "state", "reason"];
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push([
      row.sku, row.data?.title, row.data?.link, row.data?.profit_rate, row.data?.sell_price,
      row.data?.purchase_price, row.data?.store_id, row.data?.watermark_id, row.data?.offer_id,
      row.status, row.data?.reason,
    ].map(csvEscape).join(","));
  }
  await fs.writeFile(filename, `${lines.join("\n")}\n`);
}

const [sourceRunArg, requestedCsvArg, targetRunArg] = process.argv.slice(2);
if (!sourceRunArg || !requestedCsvArg || !targetRunArg) {
  throw new Error("usage: transfer_prepared_run.mjs SOURCE_RUN REQUESTED.csv TARGET_RUN");
}
const sourceRun = path.resolve(sourceRunArg);
const requestedCsv = path.resolve(requestedCsvArg);
const targetRun = path.resolve(targetRunArg);
const storeId = Number(process.env.FLOW_B_STORE_ID || 106637);
const storeNeedle = String(process.env.FLOW_B_STORE_NEEDLE || "丽丽二号");
const watermarkId = Number(process.env.FLOW_B_WATERMARK_ID || 60822);
const watermarkNeedle = String(process.env.FLOW_B_WATERMARK_NEEDLE || "lysh");
if (!(storeId > 0) || !storeNeedle.trim() || !(watermarkId > 0) || !watermarkNeedle.trim()) {
  throw new Error("verified destination store and watermark configuration is required");
}
await fs.mkdir(targetRun, { recursive: true });

const requested = await requestedSkus(requestedCsv);
const selected = selectPreparedTransferCandidates(await jsonLines(path.join(sourceRun, "sku_states.jsonl")), {
  requestedSkus: requested,
  threshold: Number(process.env.FLOW_B_PROFIT_THRESHOLD || 30),
  excludedSkus: new Set(String(process.env.FLOW_B_EXCLUDED_SKUS || "2815247918").split(",").map((value) => value.trim()).filter(Boolean)),
});
const acceptedSkus = new Set(selected.accepted.map((row) => String(row.sku)));
const missing = [...requested].filter((sku) => !acceptedSkus.has(sku) && !selected.rejected.some((row) => row.sku === sku));
await fs.writeFile(path.join(targetRun, "transfer_selection.json"), `${JSON.stringify({
  source_run: sourceRun,
  requested_csv: requestedCsv,
  target_store_id: storeId,
  target_store_name: storeNeedle,
  watermark_id: watermarkId,
  requested_count: requested.size,
  accepted_count: selected.accepted.length,
  rejected: selected.rejected.map(({ sku, reason }) => ({ sku, reason })),
  missing,
}, null, 2)}\n`);
if (missing.length > 0 || selected.rejected.length > 0 || selected.accepted.length !== requested.size) {
  throw new Error(`prepared transfer selection mismatch: requested=${requested.size}, accepted=${selected.accepted.length}, rejected=${selected.rejected.length}, missing=${missing.length}`);
}

const profileDir = process.env.FLOW_B_PW_PROFILE || path.join(ROOT, "runs/flow_b/playwright_setup/playwright_profile");
const context = await launchFlowContext(resolveBrowserOptions({ ...process.env, FLOW_B_PW_PROFILE: profileDir }));
try {
  const page = await openMaoziPage(context, { forceNew: true });
  const accessToken = await ensureMaoziLogin(page, { continueDeviceLogin: true, timeout: 60000 });
  const client = createMaoziClient({
    transport: createMaoziPageTransport({ page, context, initialAccessToken: accessToken }),
  });
  // A transfer is de-duplicated against the destination shop's exact import/offer records.
  // Keep its CSV store-scoped so a source-shop publication cannot hide a destination success.
  const state = createPublishState({ runDir: targetRun, publishedCsv: path.join(targetRun, "published_links.csv") });
  await state.load();
  state.summary(selected.accepted.length);
  const result = await transferPreparedCandidates({
    client,
    state,
    candidates: selected.accepted,
    storeId,
    storeNeedle,
    watermarkId,
    watermarkNeedle,
  });
  const entries = state.entries().filter((entry) => requested.has(String(entry.sku)));
  await writePreparedCsv(path.join(targetRun, "submitted_pending.csv"), entries.filter((entry) => entry.status !== "published"));
  await writePreparedCsv(path.join(targetRun, "published.csv"), entries.filter((entry) => entry.status === "published"));
  const summary = { ...result, run_dir: targetRun, store_id: storeId, store_name: storeNeedle, watermark_id: watermarkId, warehouse_id: null };
  await fs.writeFile(path.join(targetRun, "transfer_summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  await page.close().catch(() => {});
} finally {
  await context.close().catch(() => {});
}
