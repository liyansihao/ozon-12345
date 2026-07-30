import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { refreshSourcePortfolio } from "../scripts/ozon_source_portfolio.mjs";
import { sellerRootUrl } from "../scripts/flow_b_playwright/source-policy.mjs";

const execFileAsync = promisify(execFile);
const sellerA = "https://www.ozon.ru/seller/safe-toys/";
const sellerB = "https://www.ozon.ru/seller/new-seller/";

async function fixture(t) {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-seller-portfolio-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const runDir = path.join(stateRoot, "runs", "daily");
  const seedFile = path.join(stateRoot, "seed.txt");
  await fs.mkdir(path.join(stateRoot, "history"), { recursive: true });
  await fs.mkdir(runDir, { recursive: true });
  return { stateRoot, runDir, seedFile };
}

function strictPublication(sku, sellerUrl, publishedAt) {
  return {
    status: "published",
    sku,
    data: {
      sku,
      source_url: sellerUrl,
      strict_confirmed: true,
      online_status: "selling",
      stock: 1,
      profit_rate: 31,
      shipping_mode: "FBS",
      fbs_evidence: { verified: true },
      cost_verified: true,
      cost: { ok: true, cost: 10, source: "1688-live-match" },
      quality_gate_passed: true,
      submitted_at: "2026-07-29T10:45:00.000Z",
      published_at: publishedAt,
    },
  };
}

test("production seed contains seller URLs only", async () => {
  const seedText = await fs.readFile(
    path.resolve(import.meta.dirname, "../config/ozon_source_seed.txt"),
    "utf8",
  );
  const urls = seedText.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  assert.ok(urls.length > 0);
  assert.ok(urls.every((url) => sellerRootUrl(url)));
  assert.equal(urls.some((url) => /\/(?:search|highlight)\//u.test(url)), false);
});

test("portfolio emits seller-only pages and persists no derived or disabled source", async (t) => {
  const { stateRoot, runDir, seedFile } = await fixture(t);
  await fs.writeFile(seedFile, [
    sellerA,
    sellerB,
    "https://www.ozon.ru/search/?text=must-never-run",
  ].join("\n"));
  const portfolio = await refreshSourcePortfolio({
    stateRoot,
    runDir,
    seedFile,
    minimumActiveSources: 10,
    now: new Date("2026-07-29T12:00:00.000Z"),
    rng: () => 0,
  });

  assert.equal(portfolio.schema_version, 2);
  assert.equal(portfolio.strategy, "current-2h-unique-strict-per-unique-detail-attempt");
  assert.equal(portfolio.derived_search_enabled, false);
  assert.equal(portfolio.counts.derived_sources, 0);
  assert.equal(portfolio.active_urls.length, 10);
  assert.ok(portfolio.active_urls.every((url) => sellerRootUrl(url)));
  assert.equal(
    await fs.readFile(path.join(stateRoot, "sources", "source_disabled.jsonl"), "utf8"),
    "",
  );
});

test("seller score uses only matched unique attempts and full-quality strict in the latest two hours", async (t) => {
  const { stateRoot, runDir, seedFile } = await fixture(t);
  await fs.writeFile(seedFile, `${sellerA}\n${sellerB}\n`);
  await fs.writeFile(path.join(runDir, "acceptance_window.json"), JSON.stringify({
    started_at: "2026-07-29T08:00:00.000Z",
    ended_at: "2026-07-30T08:00:00.000Z",
  }));
  await fs.writeFile(path.join(runDir, "stage_timings.jsonl"), [
    {
      at: "2026-07-29T09:59:59.000Z",
      stage: "ozon_detail_and_category",
      sku: "old",
      seller_url: sellerA,
    },
    {
      at: "2026-07-29T10:30:00.000Z",
      stage: "ozon_detail_and_category",
      sku: "strict",
      seller_url: sellerA,
    },
    {
      at: "2026-07-29T10:31:00.000Z",
      stage: "ozon_detail_and_category",
      sku: "attempt-only",
      seller_url: sellerA,
    },
  ].map(JSON.stringify).join("\n"));
  await fs.writeFile(
    path.join(runDir, "published.jsonl"),
    `${JSON.stringify(strictPublication("strict", sellerA, "2026-07-29T11:00:00.000Z"))}\n`,
  );

  const portfolio = await refreshSourcePortfolio({
    stateRoot,
    runDir,
    seedFile,
    minimumActiveSources: 10,
    now: new Date("2026-07-29T12:00:00.000Z"),
    rng: () => 0,
  });
  const seller = portfolio.policy.sellers.find((row) => row.seller_url === sellerA);
  assert.equal(seller.unique_detail_attempts, 2);
  assert.equal(seller.unique_strict, 1);
  assert.equal(seller.score, 0.5);
  assert.deepEqual(portfolio.policy.allocation, { exploit: 9, explore: 1 });
});

test("a persisted derived-search decision is invalidated instead of frozen for two hours", async (t) => {
  const { stateRoot, runDir, seedFile } = await fixture(t);
  await fs.writeFile(seedFile, `${sellerA}\n`);
  await fs.mkdir(path.join(stateRoot, "sources"), { recursive: true });
  await fs.writeFile(path.join(stateRoot, "sources", "source_portfolio.json"), JSON.stringify({
    policy: {
      policy_version: 1,
      frozen_until: "2026-07-29T14:00:00.000Z",
      derived_search_enabled: true,
      active_urls: ["https://www.ozon.ru/search/?text=legacy"],
    },
  }));
  const portfolio = await refreshSourcePortfolio({
    stateRoot,
    runDir,
    seedFile,
    minimumActiveSources: 10,
    now: new Date("2026-07-29T12:00:00.000Z"),
    rng: () => 0,
  });
  assert.equal(portfolio.policy.reason, "strict-seller-policy-refreshed");
  assert.ok(portfolio.active_urls.every((url) => sellerRootUrl(url)));
});

test("source-set decisions are audit logged once per two-hour policy generation", async (t) => {
  const { stateRoot, runDir, seedFile } = await fixture(t);
  await fs.writeFile(seedFile, `${sellerA}\n${sellerB}\n`);
  const first = await refreshSourcePortfolio({
    stateRoot,
    runDir,
    seedFile,
    minimumActiveSources: 10,
    now: new Date("2026-07-29T12:00:00.000Z"),
    rng: () => 0,
  });
  const frozen = await refreshSourcePortfolio({
    stateRoot,
    runDir,
    seedFile,
    minimumActiveSources: 10,
    now: new Date("2026-07-29T13:00:00.000Z"),
    rng: () => 0.5,
  });
  const refreshed = await refreshSourcePortfolio({
    stateRoot,
    runDir,
    seedFile,
    minimumActiveSources: 10,
    now: new Date("2026-07-29T14:00:00.000Z"),
    rng: () => 0,
  });
  const decisions = (await fs.readFile(
    path.join(stateRoot, "history", "source_policy_decisions.jsonl"),
    "utf8",
  )).trim().split(/\r?\n/u).map(JSON.parse);

  assert.equal(frozen.source_set_sha256, first.source_set_sha256);
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].source_set_sha256, first.source_set_sha256);
  assert.equal(decisions[1].source_set_sha256, refreshed.source_set_sha256);
  assert.equal(decisions.every((row) => row.active_urls.every((url) => sellerRootUrl(url))), true);
});

test("portfolio CLI refresh works through the installed app symlink", async (t) => {
  const { stateRoot, seedFile } = await fixture(t);
  const linkedScript = path.join(stateRoot, "ozon_source_portfolio.mjs");
  await fs.writeFile(seedFile, `${sellerA}\n`);
  await fs.symlink(
    path.resolve(import.meta.dirname, "../scripts/ozon_source_portfolio.mjs"),
    linkedScript,
  );
  const result = await execFileAsync(process.execPath, [
    linkedScript,
    "refresh",
    stateRoot,
    "-",
    seedFile,
  ]);
  assert.match(result.stdout, /"ok":true/u);
  assert.match(
    await fs.readFile(path.join(stateRoot, "sources", "active_urls.txt"), "utf8"),
    /safe-toys/u,
  );
});
