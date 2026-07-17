import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AdaptiveConcurrency,
  acceptanceSummary,
  collectionErrorSummary,
  operationalErrorSummary,
  mergeCandidateFacts,
  isFatalBrowserError,
  rankSourcesByYield,
  runProducerLoop,
  summarizeConsumerRound,
  clearCandidateFactsCache,
  candidateFactsCacheStats,
  loadCandidateFacts,
  loadPreflightPureSkus,
} from "../scripts/flow_b_playwright/continuous-runtime.mjs";

test("candidate facts reuse an unchanged favorite history and refresh after append", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-candidate-facts-"));
  const filename = path.join(runDir, "favorite_collection.jsonl");
  clearCandidateFactsCache();
  await fs.writeFile(filename, `${JSON.stringify({
    sku: "one",
    status: "favorited",
    title: "first",
    sell_price: 88,
    preflight_mode: "FBS",
  })}\n`);

  assert.equal((await loadCandidateFacts(runDir)).get("one")?.title, "first");
  assert.equal((await loadCandidateFacts(runDir)).get("one")?.title, "first");
  assert.deepEqual([...(await loadPreflightPureSkus(runDir))], ["one"]);
  assert.equal(candidateFactsCacheStats(runDir).full_reads, 1);

  await fs.appendFile(filename, `${JSON.stringify({
    sku: "two",
    status: "favorited",
    title: "second",
    sell_price: 99,
  })}\n`);
  const refreshed = await loadCandidateFacts(runDir);
  assert.equal(refreshed.get("two")?.title, "second");
  assert.equal(candidateFactsCacheStats(runDir).full_reads, 2);
  await fs.rm(runDir, { recursive: true, force: true });
});

test("collection error rate reports failed preflight requests separately", () => {
  assert.deepEqual(collectionErrorSummary([
    { status: "favorited" },
    { status: "rejected" },
    { status: "failed" },
    { status: "capacity_reached" },
  ]), {
    collection_attempt_count: 3,
    collection_failed_count: 1,
    collection_error_rate: 0.3333,
  });
});

test("collection facts retain publish-critical fields and override incomplete favorite rows", () => {
  const favorite = { sku: 42, title: "", sell_price: null, cover_image: null };
  const fact = {
    sku: "42",
    title: "儿童发饰",
    sale_price: 88,
    cover_image: "https://img.example/42.jpg",
    shipping_mode: "FBS",
    source_currency: "CNY",
    source_url: "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/",
    source_url_product: "https://www.ozon.ru/product/42/",
    seller_url: "https://www.ozon.ru/seller/proven/",
  };
  assert.deepEqual(mergeCandidateFacts(favorite, fact), {
    sku: "42",
    title: "儿童发饰",
    sell_price: 88,
    sale_price: 88,
    cover_image: "https://img.example/42.jpg",
    mode: "FBS",
    shipping_mode: "FBS",
    source_currency: "CNY",
    source_url: "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/",
    link: "https://www.ozon.ru/product/42/",
    seller_url: "https://www.ozon.ru/seller/proven/",
  });
});

test("operational error rate includes runtime crashes without hiding SKU failures", () => {
  assert.deepEqual(operationalErrorSummary({
    successCount: 9,
    skippedCount: 35,
    failedCount: 1,
    runtimeErrorCount: 2,
  }), {
    error_rate: 0.0638,
    sku_error_rate: 0.0222,
    runtime_error_count: 2,
  });
});

test("adaptive concurrency starts at 8, ramps to 12, and backs off on rate limits", () => {
  const adaptive = new AdaptiveConcurrency({ initial: 8, max: 12, min: 2, stableWindow: 3 });
  adaptive.recordSuccess();
  adaptive.recordSuccess();
  assert.equal(adaptive.current, 8);
  adaptive.recordSuccess();
  assert.equal(adaptive.current, 9);
  for (let index = 0; index < 9; index += 1) adaptive.recordSuccess();
  assert.equal(adaptive.current, 12);
  adaptive.recordFailure(new Error("HTTP 429 too many requests"));
  assert.equal(adaptive.current, 6);
  adaptive.recordFailure(new Error("TypeError: Failed to fetch"));
  assert.equal(adaptive.current, 3);
  adaptive.recordFailure(new Error("ordinary product mismatch"));
  assert.equal(adaptive.current, 3);
});

test("source yield ranks China/high-yield segments ahead of unproven sources", () => {
  const rows = [
    { source_url: "generic", attempted: 100, published: 3 },
    { source_url: "china-kids", attempted: 20, published: 5, segment: "Global 中国商品 儿童" },
    { source_url: "china-apparel", attempted: 30, published: 6, segment: "Global 中国商品 服饰 配饰" },
  ];
  assert.deepEqual(rankSourcesByYield(rows).map((row) => row.source_url), ["china-kids", "china-apparel", "generic"]);
});

test("acceptance only counts unique in-window profit>30 selling publications with positive stock", () => {
  const startedAt = "2026-07-14T00:00:00.000Z";
  const endedAt = "2026-07-14T02:00:00.000Z";
  const rows = [
    { sku: "ok-1", profit_rate: 30.01, online_status: "selling", stock: 1, published_at: "2026-07-14T00:01:00.000Z" },
    { sku: "ok-1", profit_rate: 90, online_status: "selling", stock: 2, published_at: "2026-07-14T00:02:00.000Z" },
    { sku: "equal", profit_rate: 30, online_status: "selling", stock: 1, published_at: "2026-07-14T00:03:00.000Z" },
    { sku: "2815247918", profit_rate: 80, online_status: "selling", stock: 1, published_at: "2026-07-14T00:04:00.000Z" },
    { sku: "not-selling", profit_rate: 80, online_status: "ready_to_sell", stock: 1, published_at: "2026-07-14T00:05:00.000Z" },
    { sku: "zero-stock", profit_rate: 80, online_status: "selling", stock: 0, published_at: "2026-07-14T00:06:00.000Z" },
    { sku: "late", profit_rate: 80, online_status: "selling", stock: 1, published_at: "2026-07-14T02:00:00.001Z" },
  ];
  const summary = acceptanceSummary({ rows, startedAt, endedAt, target: 1 });
  assert.equal(summary.success_count, 1);
  assert.equal(summary.effective_per_hour, 0.5);
  assert.equal(summary.passed, true);
  assert.deepEqual(summary.skus, ["ok-1"]);
});

test("five-store acceptance requires 100 strict publications in every configured store", () => {
  const startedAt = "2026-07-14T00:00:00.000Z";
  const endedAt = "2026-07-15T00:00:00.000Z";
  const storeIds = [1, 2, 3, 4, 5];
  const rows = storeIds.flatMap((storeId) => Array.from({ length: storeId === 5 ? 99 : 100 }, (_, index) => ({
    sku: `${storeId}-${index}`,
    store_id: storeId,
    profit_rate: 30.01,
    online_status: "selling",
    stock: 1,
    published_at: "2026-07-14T12:00:00.000Z",
  })));
  const summary = acceptanceSummary({ rows, startedAt, endedAt, target: 500, storeIds, perStoreTarget: 100 });
  assert.equal(summary.success_count, 499);
  assert.deepEqual(summary.success_by_store, { "1": 100, "2": 100, "3": 100, "4": 100, "5": 99 });
  assert.deepEqual(summary.remaining_by_store, { "1": 0, "2": 0, "3": 0, "4": 0, "5": 1 });
  assert.equal(summary.passed, false);
});

test("producer loop keeps rescanning after success and survives one failed scan", async () => {
  let now = 0;
  let calls = 0;
  const errors = [];
  const result = await runProducerLoop({
    deadlineMs: 350,
    intervalMs: 100,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    scan: async () => {
      calls += 1;
      if (calls === 2) throw new Error("transient producer failure");
      return { round: calls };
    },
    onError: async (error) => { errors.push(error.message); },
  });
  assert.equal(calls, 4);
  assert.deepEqual(errors, ["transient producer failure"]);
  assert.deepEqual(result, { round: 4 });
});

test("closed Playwright contexts are fatal while individual page timeouts are recoverable", () => {
  assert.equal(isFatalBrowserError(new Error("Target page, context or browser has been closed")), true);
  assert.equal(isFatalBrowserError(new Error("browserContext.newPage: Target page has been closed")), true);
  assert.equal(isFatalBrowserError(new Error("page.goto: Timeout 12000ms exceeded")), false);
});

test("consumer round summaries stay bounded during 24 hour polling", () => {
  let summary;
  for (let index = 0; index < 10_000; index += 1) {
    summary = summarizeConsumerRound(summary, {
      published: index % 3 === 0 ? 1 : 0,
      attempted: 4,
      skipped: 2,
      failed: 1,
      dry_candidates: 2,
      final_concurrency: 8 + (index % 5),
      state_summary: { deliberately_large: "x".repeat(10_000) },
    });
  }
  assert.equal(summary.round_count, 10_000);
  assert.equal(summary.totals.attempted, 40_000);
  assert.equal(summary.totals.failed, 10_000);
  assert.equal(summary.last.final_concurrency, 12);
  assert.equal("state_summary" in summary.last, false);
  assert.ok(JSON.stringify(summary).length < 500);
});
