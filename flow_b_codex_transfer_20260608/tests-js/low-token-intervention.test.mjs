import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chooseLowTokenIntervention, createLowTokenInterventionController } from "../scripts/flow_b_playwright/low-token-intervention.mjs";

test("low token intervention protects an Ozon soft-block recovery window", () => {
  assert.deepEqual(chooseLowTokenIntervention({
    collectionAttempts: 80,
    favorites: 12,
    softBlocks: 2,
    strictPerHour: 8,
  }), {
    profile: "cooldown",
    reason: "recent-ozon-soft-blocks",
    overrides: {
      FLOW_B_TAB_WORKERS: "3",
      FLOW_B_MAX_TAB_WORKERS: "4",
      FLOW_B_FAVORITE_WORKERS: "3",
      FLOW_B_FAVORITE_DETAIL_INTERVAL_MS: "4000",
      FLOW_B_MIN_FAVORITE_DETAIL_INTERVAL_MS: "4000",
      FLOW_B_STRICT_EXPLOIT_BURST: "12",
    },
  });
});

test("low token intervention exploits strict sources when pure-FBS yield is poor", () => {
  const result = chooseLowTokenIntervention({
    collectionAttempts: 60,
    favorites: 5,
    softBlocks: 0,
    strictPerHour: 10,
  });
  assert.equal(result.profile, "exploit");
  assert.equal(result.reason, "low-pure-fbs-yield");
  assert.equal(result.overrides.FLOW_B_STRICT_EXPLOIT_BURST, "12");
  assert.equal(result.overrides.FLOW_B_DERIVED_SEARCH_SOURCES, "100");
  assert.equal(result.overrides.FLOW_B_TAB_WORKERS, "3");
  assert.equal(result.overrides.FLOW_B_FAVORITE_DETAIL_INTERVAL_MS, "4000");
});

test("low token intervention uses safe four-page collection only with healthy FBS yield", () => {
  const result = chooseLowTokenIntervention({
    collectionAttempts: 60,
    favorites: 15,
    softBlocks: 0,
    strictPerHour: 18,
  });
  assert.equal(result.profile, "balanced");
  assert.equal(result.overrides.FLOW_B_TAB_WORKERS, "4");
  assert.equal(result.overrides.FLOW_B_FAVORITE_DETAIL_INTERVAL_MS, "4000");
  assert.equal(result.overrides.FLOW_B_MIN_FAVORITE_DETAIL_INTERVAL_MS, "4000");
});

test("low token intervention stops spending derived-search quota when sellers beat a dry search portfolio", () => {
  const result = chooseLowTokenIntervention({
    collectionAttempts: 100,
    favorites: 25,
    softBlocks: 0,
    strictPerHour: 10,
    sourceTypes: {
      seller: { attempts: 50, favorites: 18 },
      highlight: { attempts: 10, favorites: 3 },
      search: { attempts: 40, favorites: 4 },
    },
  });

  assert.equal(result.profile, "seller-fbs-bias");
  assert.equal(result.reason, "search-fbs-yield-below-source-mix");
  assert.equal(result.overrides.FLOW_B_DERIVED_SEARCH_SOURCES, "0");
  assert.equal(result.overrides.FLOW_B_DERIVED_PRIORITY_SOURCES, "0");
  assert.equal(result.overrides.FLOW_B_PRIORITIZE_DERIVED_SEARCH, "0");
  assert.equal(result.overrides.FLOW_B_SOURCE_FBS_WEIGHT, "3");
  assert.equal(result.overrides.FLOW_B_SOURCE_EXPLORE_WEIGHT, "1");
});

test("low token intervention follows downstream strict yield when it contradicts FBS yield", () => {
  const result = chooseLowTokenIntervention({
    collectionAttempts: 282,
    favorites: 67,
    softBlocks: 0,
    strictPerHour: 25,
    sourceTypes: {
      seller: { attempts: 198, favorites: 48, strict: 2 },
      highlight: { attempts: 0, favorites: 0, strict: 0 },
      search: { attempts: 84, favorites: 19, strict: 5 },
    },
  });

  assert.equal(result.profile, "search-strict-bias");
  assert.equal(result.reason, "search-strict-yield-above-source-mix");
  assert.equal(result.overrides.FLOW_B_DERIVED_SEARCH_SOURCES, "100");
  assert.equal(result.overrides.FLOW_B_DERIVED_PRIORITY_SOURCES, "24");
  assert.equal(result.overrides.FLOW_B_PRIORITIZE_DERIVED_SEARCH, "1");
  assert.equal(result.overrides.FLOW_B_SOURCE_STRICT_WEIGHT, "7");
  assert.equal(result.overrides.FLOW_B_SOURCE_FBS_WEIGHT, "2");
  assert.equal(result.overrides.FLOW_B_SOURCE_EXPLORE_WEIGHT, "1");
});

test("low token intervention leaves the baseline unchanged before enough evidence", () => {
  assert.deepEqual(chooseLowTokenIntervention({
    collectionAttempts: 12,
    favorites: 0,
    softBlocks: 0,
    strictPerHour: 0,
  }), { profile: "observe", reason: "insufficient-evidence", overrides: {} });
});

test("controller changes the runtime environment and logs only profile transitions", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-low-token-"));
  const now = Date.parse("2026-07-18T03:30:00.000Z");
  await fs.writeFile(path.join(runDir, "acceptance_window.json"), JSON.stringify({ started_at: "2026-07-18T03:00:00.000Z" }));
  await fs.writeFile(path.join(runDir, "favorite_collection.jsonl"), Array.from({ length: 40 }, (_, index) => JSON.stringify({
    at: new Date(now - index * 1000).toISOString(),
    status: index < 4 ? "favorited" : "rejected",
    reason: index < 4 ? undefined : "non-pure-fbs",
  })).join("\n"));
  const env = { FLOW_B_LOW_TOKEN_INTERVENTION: "1", FLOW_B_TAB_WORKERS: "8" };
  const controller = createLowTokenInterventionController({ runDir, env, now: () => now });
  assert.equal((await controller.refresh()).profile, "exploit");
  assert.equal(env.FLOW_B_TAB_WORKERS, "3");
  await controller.refresh();
  const logs = (await fs.readFile(path.join(runDir, "low_token_interventions.jsonl"), "utf8")).trim().split(/\n/);
  assert.equal(logs.length, 1);
  await fs.rm(runDir, { recursive: true, force: true });
});

test("controller lets a source bias finish one downstream cycle before returning to balanced", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-source-dwell-"));
  const startedAt = Date.parse("2026-07-18T03:00:00.000Z");
  let currentTime = startedAt;
  await fs.writeFile(path.join(runDir, "acceptance_window.json"), JSON.stringify({
    started_at: new Date(startedAt).toISOString(),
  }));
  const writePortfolio = async (searchFavorites) => {
    const rows = [
      ...Array.from({ length: 40 }, (_, index) => ({
        at: new Date(currentTime - index * 1000).toISOString(),
        status: index < 12 ? "favorited" : "rejected",
        source_url: `https://www.ozon.ru/seller/dwell-${index}`,
      })),
      ...Array.from({ length: 40 }, (_, index) => ({
        at: new Date(currentTime - (index + 50) * 1000).toISOString(),
        status: index < searchFavorites ? "favorited" : "rejected",
        source_url: `https://www.ozon.ru/search/dwell-${index}`,
      })),
    ];
    await fs.writeFile(path.join(runDir, "favorite_collection.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"));
  };
  await writePortfolio(4);
  const env = {
    FLOW_B_LOW_TOKEN_INTERVENTION: "1",
    FLOW_B_DERIVED_SEARCH_SOURCES: "24",
    FLOW_B_DERIVED_PRIORITY_SOURCES: "8",
    FLOW_B_PRIORITIZE_DERIVED_SEARCH: "1",
  };
  const controller = createLowTokenInterventionController({ runDir, env, now: () => currentTime });
  assert.equal((await controller.refresh()).profile, "seller-fbs-bias");
  assert.equal(env.FLOW_B_DERIVED_SEARCH_SOURCES, "0");

  currentTime += 5 * 60_000;
  await writePortfolio(8);
  assert.equal((await controller.refresh()).profile, "seller-fbs-bias");
  assert.equal(env.FLOW_B_DERIVED_SEARCH_SOURCES, "0");

  currentTime = startedAt + 21 * 60_000;
  await writePortfolio(8);
  assert.equal((await controller.refresh()).profile, "balanced");
  assert.equal(env.FLOW_B_DERIVED_SEARCH_SOURCES, "24");
  const logs = (await fs.readFile(path.join(runDir, "low_token_interventions.jsonl"), "utf8")).trim().split(/\n/);
  assert.equal(logs.length, 2);
  await fs.rm(runDir, { recursive: true, force: true });
});

test("controller lets a soft block interrupt source-bias dwell immediately", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-source-dwell-safety-"));
  let currentTime = Date.parse("2026-07-18T03:00:00.000Z");
  await fs.writeFile(path.join(runDir, "acceptance_window.json"), JSON.stringify({
    started_at: new Date(currentTime).toISOString(),
  }));
  const rows = [
    ...Array.from({ length: 40 }, (_, index) => ({
      at: new Date(currentTime - index * 1000).toISOString(),
      status: index < 12 ? "favorited" : "rejected",
      source_url: `https://www.ozon.ru/seller/safety-${index}`,
    })),
    ...Array.from({ length: 40 }, (_, index) => ({
      at: new Date(currentTime - (index + 50) * 1000).toISOString(),
      status: index < 4 ? "favorited" : "rejected",
      source_url: `https://www.ozon.ru/search/safety-${index}`,
    })),
  ];
  await fs.writeFile(path.join(runDir, "favorite_collection.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"));
  const env = { FLOW_B_LOW_TOKEN_INTERVENTION: "1" };
  const controller = createLowTokenInterventionController({ runDir, env, now: () => currentTime });
  assert.equal((await controller.refresh()).profile, "seller-fbs-bias");

  currentTime += 5 * 60_000;
  rows.push({
    at: new Date(currentTime).toISOString(),
    status: "failed",
    reason: "ozon-soft-block",
    source_url: "https://www.ozon.ru/search/blocked",
  });
  await fs.writeFile(path.join(runDir, "favorite_collection.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"));
  assert.equal((await controller.refresh()).profile, "cooldown");
  await fs.rm(runDir, { recursive: true, force: true });
});

test("controller scores recent strict publications by source and ignores stale wins", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-strict-source-"));
  const now = Date.parse("2026-07-18T04:00:00.000Z");
  await fs.writeFile(path.join(runDir, "acceptance_window.json"), JSON.stringify({ started_at: "2026-07-18T02:00:00.000Z" }));

  const collection = [
    ...Array.from({ length: 40 }, (_, index) => ({
      at: new Date(now - index * 1000).toISOString(),
      status: index < 12 ? "favorited" : "rejected",
      source_url: `https://www.ozon.ru/seller/current-${index}`,
    })),
    ...Array.from({ length: 40 }, (_, index) => ({
      at: new Date(now - (index + 50) * 1000).toISOString(),
      status: index < 8 ? "favorited" : "rejected",
      source_url: `https://www.ozon.ru/search/current-${index}`,
    })),
  ];
  await fs.writeFile(path.join(runDir, "favorite_collection.jsonl"), collection.map((row) => JSON.stringify(row)).join("\n"));

  const publication = (minutesAgo, sourceUrl, sku) => JSON.stringify({
    timestamp: new Date(now - minutesAgo * 60_000).toISOString(),
    sku,
    data: {
      sku,
      source_url: sourceUrl,
      profit_rate: 35,
      online_status: "selling",
      stock: 10,
    },
  });
  await fs.writeFile(path.join(runDir, "published.jsonl"), [
    publication(5, "https://www.ozon.ru/search/recent-1", "search-1"),
    publication(5, "https://www.ozon.ru/search/recent-1", "search-1"),
    publication(6, "https://www.ozon.ru/search/recent-2", "search-2"),
    publication(7, "https://www.ozon.ru/search/recent-3", "search-3"),
    publication(8, "https://www.ozon.ru/search/recent-4", "search-4"),
    publication(9, "https://www.ozon.ru/search/recent-5", "search-5"),
    publication(10, "https://www.ozon.ru/seller/recent-1", "seller-1"),
    publication(45, "https://www.ozon.ru/seller/stale-1", "seller-stale-1"),
    publication(46, "https://www.ozon.ru/seller/stale-2", "seller-stale-2"),
    publication(47, "https://www.ozon.ru/seller/stale-3", "seller-stale-3"),
    publication(48, "https://www.ozon.ru/seller/stale-4", "seller-stale-4"),
    publication(49, "https://www.ozon.ru/seller/stale-5", "seller-stale-5"),
  ].join("\n"));

  const env = { FLOW_B_LOW_TOKEN_INTERVENTION: "1" };
  const controller = createLowTokenInterventionController({ runDir, env, now: () => now });
  const decision = await controller.refresh();

  assert.equal(decision.profile, "search-strict-bias");
  assert.equal(decision.metrics.sourceTypes.search.strict, 5);
  assert.equal(decision.metrics.sourceTypes.seller.strict, 1);
  await fs.rm(runDir, { recursive: true, force: true });
});
