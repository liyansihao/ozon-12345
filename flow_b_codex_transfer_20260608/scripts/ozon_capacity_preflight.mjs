#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import {
  ensureMaoziLogin,
  launchFlowContext,
  openMaoziPage,
  resolveBrowserOptions,
} from "./flow_b_playwright/browser-context.mjs";
import { buildCapacityPreflight } from "./flow_b_playwright/capacity-preflight.mjs";
import { createMaoziClient, createMaoziPageTransport } from "./flow_b_playwright/maozi-client.mjs";

function parseJsonEnv(name) {
  try {
    return JSON.parse(String(process.env[name] || ""));
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
}

async function writeJsonAtomic(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filename);
}

async function main() {
  const output = path.resolve(process.argv[2] || "");
  if (!process.argv[2]) throw new Error("capacity preflight output path is required");
  const configuredStores = parseJsonEnv("FLOW_B_CAPACITY_STORES");
  const options = resolveBrowserOptions(process.env);
  const context = await launchFlowContext(options);
  let page;
  try {
    page = await openMaoziPage(context, { forceNew: true, settleMs: 500 });
    await ensureMaoziLogin(page, {
      continueDeviceLogin: process.env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1",
      timeout: 60_000,
    });
    const client = createMaoziClient({
      transport: createMaoziPageTransport({ page, context }),
    });
    const [erpStores, profileStores] = await Promise.all([
      client.listShops(),
      client.listUserShops(),
    ]);
    const snapshot = buildCapacityPreflight({
      configuredStores,
      erpStores,
      profileStores,
      configuredDailyLimit: Number(process.env.FLOW_B_DAILY_STORE_LIMIT || 100),
      requiredCapacity: Number(process.env.FLOW_B_ACCEPTANCE_TARGET || 481),
    });
    await writeJsonAtomic(output, snapshot);
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  } finally {
    await page?.close().catch(() => {});
    if (!options.cdpEndpoint) await context.close().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: String(error?.message || error),
    })}\n`);
    process.exit(1);
  },
);
