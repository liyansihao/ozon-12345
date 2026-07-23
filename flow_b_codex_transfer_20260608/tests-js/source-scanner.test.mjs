import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  canClaimFavorite,
  favoriteRetryDelay,
  favoriteModeSkipReason,
  listingModeSkipReason,
  effectiveFavoriteTotal,
  excludedSkusFromHistories,
  excludedSkusFromEventHistories,
  favoritedSkusFromHistory,
  favoritedSkusFromEvents,
  expandHighYieldSourceUrls,
  isFavoriteSessionAuthenticated,
  isFavoriteCapacityReached,
  isOzonSoftBlock,
  isProvenSellerSource,
  ozonRetryDelay,
  ozonDetailFailurePolicy,
  prioritizeFavoriteLinks,
  prioritizeSourceUrls,
  interleaveStrictSuccessExploration,
  interleaveSourcePortfolio,
  appendFavoriteEvidence,
  parseFavoriteProductSnapshot,
  parseListingFavoriteSnapshot,
  reusableListingFavoriteSnapshot,
  pruneAttemptedSourceLinks,
  compactListingCardText,
  requiresFavoriteSession,
  retainedReplayLimit,
  scanSourceWithPage,
  closeReusablePages,
  closeRuntimeReusablePagePools,
  ensureReusablePageSlots,
  runtimeReusablePagePools,
  classifyFreshSourceUrls,
  expandFreshSellerSourceUrls,
  retryMaoziPageFetch,
  retainedRowsForCollection,
  orderRowsBySourceYield,
  waitForMovingDeadline,
  waitForListingEnrichment,
  shouldYieldAfterRetained,
  shouldYieldForSourceFeedback,
  terminalSkusFromJsonl,
  limitLinksPerSource,
  cachedExactFbsFallbackLinks,
  fillRetainedFallbackLinks,
  productTitleFamily,
  productTitlePriority,
  observedTitleFamilyScores,
  createScannerLogger,
  favoriteFailureDisposition,
  adaptiveNonFbsSampleLimit,
  shouldDeferSourceAfterNonFbsSample,
  nextSourceSampleStats,
  sourceSampleStatsFromEvents,
  sourceNonFbsSampleKey,
  favoritePriceSkipReason,
  favoriteTitleSkipReason,
  nextLowYieldBatchStreak,
  softBlockCooldownState,
  collectionDetailCooldownState,
  sourceBatchCooldownState,
  candidateQueueTransitionForCollectionResult,
  sourceCollectionBlockKey,
  collectionRuntimeState,
  persistCollectionRuntimeState,
  restoreCollectionRuntimeState,
  remainingCollectionCooldown,
  sourceAdaptiveConcurrency,
  sourceAdaptiveStableWindow,
  sourceScanLinkTarget,
  sourceScanLinkTargetForSource,
  boundedEvidenceSourceUrls,
  eligibleLinkCountsBySource,
  exhaustedScanFamilyKeys,
  nextDetailPacingState,
  favoriteDetailPacingOptions,
  sourceAfterScanWaitMs,
  collectionDeadlineMs,
  isCollectionDeadlineReached,
  withTimeout,
  createFavoriteWorkerPage,
  readFavoriteSkusWithTimeout,
  readFavoriteCountWithTimeout,
  deriveSearchSourceUrls,
  repeatedSubmittedSellerSourceVariants,
  repeatedSubmittedSellerSourceUrls,
  deepVerifiedSellerSourceVariants,
  verifiedSellerSourceUrls,
  pureFbsSellerSourceUrls,
  pureFbsSellerSourceVariants,
  verifiedSellerMinimumPublished,
  verifiedPrioritySourceUrls,
  qualifiedPrioritySourceUrls,
  filterProductiveSourceVariants,
  expandPublishedSourcePages,
  expandNextPublishedDiscoveryPages,
  expandRepeatedPublishedDiscoveryPageFour,
  fullFunnelSourceScores,
  filterSourceUrlsByAllowlist,
  filterSourceRowsByAllowlist,
  fatalSourceBatchError,
  completedSourceUrls,
  clearJsonLinesFileCache,
  jsonLinesFileCacheStats,
  readJsonLinesIncremental,
  clearJsonArrayFileCache,
  jsonArrayFileCacheStats,
  readJsonArrayCached,
  writeJsonArrayCached,
  shouldWriteSourceCheckpoint,
  sourceBatchPrefetchAllowed,
  sourceBatchCollectionMode,
  shouldScanSourcesDuringDetailCooldown,
} from "../scripts/flow_b_playwright/source-scanner.mjs";

test("source allowlist constrains derived seller variants to explicitly selected families", () => {
  const urls = [
    "https://www.ozon.ru/seller/nature-3460296/?currency_price=500.000%3B&sorting=rating&page=4",
    "https://www.ozon.ru/seller/nature-3460296/?page=4&sorting=rating&currency_price=500.000%3B",
    "https://www.ozon.ru/seller/upcloud-international/?page=2",
    "https://www.ozon.ru/seller/fluff-joy/?sorting=discount",
    "https://www.ozon.ru/search/?text=toys&page=2",
  ];
  const allowlist = [
    "https://www.ozon.ru/seller/nature-3460296/",
    "https://www.ozon.ru/seller/fluff-joy/",
  ];

  assert.deepEqual(filterSourceUrlsByAllowlist(urls, allowlist), [
    urls[0],
    urls[3],
  ]);
  assert.deepEqual(filterSourceUrlsByAllowlist(urls, [
    urls[0],
    urls[3],
  ], { match: "exact" }), [
    urls[0],
    urls[3],
  ]);
  assert.deepEqual(filterSourceUrlsByAllowlist(urls, [
    "https://www.ozon.ru/seller/nature-3460296/",
    "https://www.ozon.ru/seller/fluff-joy/",
  ], { match: "exact" }), []);
  assert.deepEqual(filterSourceUrlsByAllowlist(urls, []), urls);
  assert.deepEqual(filterSourceRowsByAllowlist(
    urls.map((source_url, index) => ({ source_url, index })),
    [urls[0], urls[2], urls[4]],
    { match: "exact" },
  ).map((row) => row.index), [0, 2, 4]);
});

test("verified seller promotion requires at least two strict publications", () => {
  assert.equal(verifiedSellerMinimumPublished({}), 2);
  assert.equal(verifiedSellerMinimumPublished({ FLOW_B_VERIFIED_SELLER_MIN_PUBLISHED: "1" }), 2);
  assert.equal(verifiedSellerMinimumPublished({ FLOW_B_VERIFIED_SELLER_MIN_PUBLISHED: "4" }), 4);
});

test("two pure-FBS favorites promote their seller into bounded source variants before publication", () => {
  const seller = "https://www.ozon.ru/seller/pure-fbs-seed/";
  const rows = [
    { at: "2026-07-18T10:00:00.000Z", status: "favorited", sku: "1", seller_url: seller },
    { at: "2026-07-18T10:01:00.000Z", status: "favorited", sku: "2", seller_url: seller },
    { at: "2026-07-18T10:02:00.000Z", status: "favorited", sku: "2", seller_url: seller },
  ];
  assert.deepEqual(pureFbsSellerSourceUrls(rows), [seller]);
  const variants = pureFbsSellerSourceVariants(rows);
  assert.ok(variants.includes(seller));
  assert.ok(variants.some((url) => url.startsWith(`${seller}?`) && url.includes("currency_price=500.000%3B")));
  assert.ok(variants.some((url) => url.includes("page=2")));
  assert.ok(variants.some((url) => url.includes("page=3")));
});

test("JSONL seed reads reuse unchanged files and only parse appended bytes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-jsonl-cache-"));
  const filename = path.join(dir, "seed.jsonl");
  clearJsonLinesFileCache();
  await fs.writeFile(filename, '{"sku":"1"}\n{"sku":"2"}\n');

  assert.deepEqual((await readJsonLinesIncremental(filename)).map((row) => row.sku), ["1", "2"]);
  assert.equal(jsonLinesFileCacheStats(filename).full_reads, 1);
  assert.equal(jsonLinesFileCacheStats(filename).append_reads, 0);

  assert.deepEqual((await readJsonLinesIncremental(filename)).map((row) => row.sku), ["1", "2"]);
  assert.equal(jsonLinesFileCacheStats(filename).full_reads, 1);

  await fs.appendFile(filename, '{"sku":"3"}\n');
  assert.deepEqual((await readJsonLinesIncremental(filename)).map((row) => row.sku), ["1", "2", "3"]);
  assert.equal(jsonLinesFileCacheStats(filename).full_reads, 1);
  assert.equal(jsonLinesFileCacheStats(filename).append_reads, 1);

  await fs.writeFile(filename, '{"sku":"4"}\n');
  assert.deepEqual((await readJsonLinesIncremental(filename)).map((row) => row.sku), ["4"]);
  assert.equal(jsonLinesFileCacheStats(filename).full_reads, 2);
  await fs.rm(dir, { recursive: true, force: true });
});

test("parsed exclusion histories preserve latest-state and retry semantics", () => {
  const excluded = excludedSkusFromEventHistories({
    stateEventGroups: [[
      { sku: "retry-later", status: "skipped" },
      { sku: "retry-later", status: "failed" },
      { sku: "published", status: "published" },
    ]],
    favoriteEventGroups: [[
      { sku: "deterministic", status: "rejected", reason: "non-pure-fbs" },
      { sku: "currency-recheck", status: "rejected", reason: "non-cny-sale-price" },
      { sku: "missing-mode", status: "failed", error: "missing-shipping-mode: timeout" },
      { sku: "transient", status: "failed", error: "page timeout" },
    ]],
  });
  assert.deepEqual([...excluded].sort(), ["deterministic", "missing-mode", "published"]);
  assert.deepEqual([...favoritedSkusFromEvents([
    { sku: "one", status: "favorited" },
    { sku: "two", status: "rejected" },
  ])], ["one"]);
});

test("source scan array checkpoints reuse memory and replace files atomically", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-array-cache-"));
  const filename = path.join(dir, "source_deep_scan.json");
  clearJsonArrayFileCache();
  await fs.writeFile(filename, JSON.stringify([{ source_url: "one" }]));

  assert.deepEqual(await readJsonArrayCached(filename), [{ source_url: "one" }]);
  assert.equal(jsonArrayFileCacheStats(filename).full_reads, 1);
  assert.deepEqual(await readJsonArrayCached(filename), [{ source_url: "one" }]);
  assert.equal(jsonArrayFileCacheStats(filename).full_reads, 1);

  await writeJsonArrayCached(filename, [{ source_url: "one" }, { source_url: "two" }]);
  assert.deepEqual(await readJsonArrayCached(filename), [{ source_url: "one" }, { source_url: "two" }]);
  assert.equal(jsonArrayFileCacheStats(filename).full_reads, 1);
  assert.equal(jsonArrayFileCacheStats(filename).writes, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), [{ source_url: "one" }, { source_url: "two" }]);
  await assert.rejects(fs.access(`${filename}.tmp`));
  await fs.rm(dir, { recursive: true, force: true });
});

test("large source checkpoints flush on a bounded completed-batch interval", () => {
  assert.equal(shouldWriteSourceCheckpoint(1, 4), false);
  assert.equal(shouldWriteSourceCheckpoint(3, 4), false);
  assert.equal(shouldWriteSourceCheckpoint(4, 4), true);
  assert.equal(shouldWriteSourceCheckpoint(8, 4), true);
  assert.equal(shouldWriteSourceCheckpoint(1, 1), true);
  assert.equal(shouldWriteSourceCheckpoint(4, 0), true);
});

test("a source is deferred only after a zero-yield non-pure-FBS sample", () => {
  assert.equal(shouldDeferSourceAfterNonFbsSample({ attempted: 5, nonPureFbs: 5, favorited: 0 }, 6), false);
  assert.equal(shouldDeferSourceAfterNonFbsSample({ attempted: 6, nonPureFbs: 6, favorited: 0 }, 6), true);
  assert.equal(shouldDeferSourceAfterNonFbsSample({ attempted: 10, nonPureFbs: 9, favorited: 0 }, 6), true);
  assert.equal(shouldDeferSourceAfterNonFbsSample({ attempted: 10, nonPureFbs: 7, favorited: 0 }, 6), false);
  assert.equal(shouldDeferSourceAfterNonFbsSample({ attempted: 7, nonPureFbs: 6, favorited: 1 }, 6), false);
  assert.equal(shouldDeferSourceAfterNonFbsSample({ attempted: 8, nonPureFbs: 7, favorited: 1 }, 6), true);
  assert.equal(shouldDeferSourceAfterNonFbsSample({ attempted: 12, nonPureFbs: 11, favorited: 1 }, 6), true);
  assert.equal(shouldDeferSourceAfterNonFbsSample({ attempted: 12, nonPureFbs: 10, favorited: 2 }, 6), false);
  assert.equal(shouldDeferSourceAfterNonFbsSample({ attempted: 20, nonPureFbs: 20, favorited: 0 }, 0), false);
});

test("unproven sources use one fewer FBS sample while proven sources receive a bounded deeper sample", () => {
  assert.equal(adaptiveNonFbsSampleLimit(4, false), 3);
  assert.equal(adaptiveNonFbsSampleLimit(4, true), 8);
  assert.equal(adaptiveNonFbsSampleLimit(3, false), 3);
  assert.equal(adaptiveNonFbsSampleLimit(3, true), 3);
  assert.equal(adaptiveNonFbsSampleLimit(8, true), 8);
  assert.equal(adaptiveNonFbsSampleLimit(0, false), 0);
});

test("source samples count completed outcomes but not deferred queued work", () => {
  let stats = nextSourceSampleStats(undefined, { status: "rejected", reason: "non-pure-fbs" });
  stats = nextSourceSampleStats(stats, { status: "failed", reason: "timeout" });
  stats = nextSourceSampleStats(stats, { status: "favorited" });
  assert.deepEqual(stats, { attempted: 3, nonPureFbs: 1, favorited: 1 });
  assert.deepEqual(nextSourceSampleStats(stats, { status: "deferred" }), stats);
});

test("favorite evidence is mirrored to durable cross-run history with one timestamp", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-fbs-history-"));
  const runLog = path.join(dir, "run", "favorite_collection.jsonl");
  const historyLog = path.join(dir, "data", "fbs_source_history.jsonl");
  const event = await appendFavoriteEvidence({
    logFile: runLog,
    historyFile: historyLog,
    row: {
      status: "favorited",
      sku: "42",
      source_url: "https://www.ozon.ru/seller/proven/",
      preflight_mode: "FBS",
    },
    now: () => new Date("2026-07-18T12:00:00.000Z"),
  });

  assert.equal(event.at, "2026-07-18T12:00:00.000Z");
  assert.equal(event.run_id, "run");
  assert.deepEqual(
    JSON.parse((await fs.readFile(runLog, "utf8")).trim()),
    JSON.parse((await fs.readFile(historyLog, "utf8")).trim()),
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("source portfolio schedules strict, pure-FBS, and exploration sources at 70/20/10", () => {
  const strict = Array.from({ length: 9 }, (_, index) => `https://www.ozon.ru/seller/strict-${index}/`);
  const pureFbs = Array.from({ length: 4 }, (_, index) => `https://www.ozon.ru/seller/fbs-${index}/`);
  const explore = Array.from({ length: 3 }, (_, index) => `https://www.ozon.ru/search/?text=explore-${index}`);
  const rows = [
    ...strict.map((source_url, index) => ({ source_url, sku: `strict-${index}`, status: "published" })),
    ...pureFbs.flatMap((source_url, sourceIndex) => Array.from({ length: 4 }, (_, index) => ({
      source_url,
      sku: `fbs-${sourceIndex}-${index}`,
      status: index < 2 ? "favorited" : "rejected",
      reason: index < 2 ? null : "non-pure-fbs",
    }))),
  ];

  const ordered = interleaveSourcePortfolio([...strict, ...pureFbs, ...explore], rows);
  assert.deepEqual(ordered.slice(0, 10), [
    ...strict.slice(0, 7),
    ...pureFbs.slice(0, 2),
    explore[0],
  ]);
  assert.deepEqual(new Set(ordered), new Set([...strict, ...pureFbs, ...explore]));
});

test("source sample history restores only the dry tail after the latest favorite", () => {
  const sourceA = "https://www.ozon.ru/search/?text=a";
  const sourceB = "https://www.ozon.ru/search/?text=b";
  const stats = sourceSampleStatsFromEvents([
    { source_url: sourceA, status: "rejected", reason: "non-pure-fbs" },
    { source_url: sourceA, status: "rejected", reason: "non-pure-fbs" },
    { source_url: sourceA, status: "favorited" },
    { source_url: sourceA, status: "rejected", reason: "non-pure-fbs" },
    { source_url: sourceA, status: "failed" },
    { source_url: sourceB, status: "rejected", reason: "non-pure-fbs" },
    { source_url: sourceB, status: "rejected", reason: "non-pure-fbs" },
    { source_url: sourceB, status: "rejected", reason: "non-pure-fbs" },
  ]);
  assert.deepEqual(stats.get(sourceNonFbsSampleKey(sourceA)), {
    attempted: 2,
    nonPureFbs: 1,
    favorited: 0,
  });
  assert.deepEqual(stats.get(sourceNonFbsSampleKey(sourceB)), {
    attempted: 3,
    nonPureFbs: 3,
    favorited: 0,
  });
});

test("non-pure-FBS sampling isolates seller page and sorting variants", () => {
  const base = "https://www.ozon.ru/seller/shi-dada/?currency_price=150.000%3B";
  assert.notEqual(sourceNonFbsSampleKey(base), sourceNonFbsSampleKey(`${base}&sorting=rating`));
  assert.notEqual(sourceNonFbsSampleKey(base), sourceNonFbsSampleKey(`${base}&page=2`));
  assert.equal(sourceNonFbsSampleKey(`${base}#products`), sourceNonFbsSampleKey(base));
});

test("non-pure-FBS sampling shares one failure streak across search pages and sorting variants", () => {
  const base = "https://www.ozon.ru/search/?text=metal+model&is_global=true&currency_price=150.000%3B";
  assert.equal(
    sourceNonFbsSampleKey(`${base}&sorting=discount&page=2`),
    sourceNonFbsSampleKey(`${base}&sorting=rating&page=4`),
  );
  assert.notEqual(
    sourceNonFbsSampleKey(`${base}&page=2`),
    sourceNonFbsSampleKey("https://www.ozon.ru/search/?text=metal+model&is_global=true&currency_price=500.000%3B&page=2"),
  );
});

test("collection deadline stops an in-flight producer tranche", () => {
  const env = { FLOW_B_DEADLINE_AT: "2026-07-14T22:00:29.809Z" };
  assert.equal(collectionDeadlineMs(env), Date.parse(env.FLOW_B_DEADLINE_AT));
  assert.equal(isCollectionDeadlineReached(env, Date.parse("2026-07-14T22:00:29.808Z")), false);
  assert.equal(isCollectionDeadlineReached(env, Date.parse("2026-07-14T22:00:29.809Z")), true);
  assert.equal(collectionDeadlineMs({}), Number.POSITIVE_INFINITY);
});

test("candidate queue keeps transient collection work retryable and terminal outcomes final", () => {
  assert.deepEqual(candidateQueueTransitionForCollectionResult({ status: "favorited", sku: "1" }), {
    status: "favorited",
    data: { reason: null },
  });
  assert.deepEqual(candidateQueueTransitionForCollectionResult({ status: "rejected", sku: "2", reason: "non-pure-fbs" }), {
    status: "rejected",
    data: { reason: "non-pure-fbs" },
  });
  assert.deepEqual(candidateQueueTransitionForCollectionResult({ status: "failed", sku: "3", error: new Error("soft blocked") }, {
    nowMs: Date.parse("2026-07-17T12:00:00.000Z"),
    deferMs: 60_000,
  }), {
    status: "deferred",
    data: { reason: "soft blocked", retry_at: "2026-07-17T12:01:00.000Z" },
  });
  assert.equal(candidateQueueTransitionForCollectionResult({ status: "ignored", sku: "4" }), null);
});

test("listing enrichment wait exits early once enough product cards are ready", async () => {
  let evaluations = 0;
  const page = {
    evaluate: async () => {
      evaluations += 1;
      return { products: 24, richCards: 18, modeCards: 0 };
    },
  };
  const result = await waitForListingEnrichment(page, {
    maxWaitMs: 8000,
    minWaitMs: 0,
    pollMs: 250,
    minProducts: 12,
  });
  assert.equal(result.ready, true);
  assert.equal(evaluations, 1);
});

test("listing enrichment wait remains bounded when cards are incomplete", async () => {
  let clock = 0;
  const page = { evaluate: async () => ({ products: 1, richCards: 0, modeCards: 0 }) };
  const result = await waitForListingEnrichment(page, {
    maxWaitMs: 1000,
    minWaitMs: 0,
    pollMs: 250,
    minProducts: 12,
    now: () => clock,
    wait: async (ms) => { clock += ms; },
  });
  assert.equal(result.ready, false);
  assert.equal(clock, 1000);
});

test("collection cooldown exposes only its remaining bounded wait", () => {
  assert.equal(remainingCollectionCooldown({ detailBlockedUntil: 10_000 }, 4_000), 6_000);
  assert.equal(remainingCollectionCooldown({ detailBlockedUntil: 10_000 }, 10_000), 0);
  assert.equal(remainingCollectionCooldown({}, 10_000), 0);
});

test("detail cooldown keeps source discovery running in queue-only mode", () => {
  assert.equal(sourceBatchCollectionMode({
    favoriteTotal: 10,
    target: 1000,
    cooldownRemainingMs: 60_000,
    sourceBlocked: false,
  }), "queue-only");
  assert.equal(sourceBatchCollectionMode({
    favoriteTotal: 10,
    target: 1000,
    cooldownRemainingMs: 0,
    sourceBlocked: true,
  }), "queue-only");
  assert.equal(sourceBatchCollectionMode({
    favoriteTotal: 10,
    target: 1000,
    cooldownRemainingMs: 0,
    sourceBlocked: false,
  }), "collect");
  assert.equal(sourceBatchCollectionMode({
    favoriteTotal: 1000,
    target: 1000,
    cooldownRemainingMs: 0,
    sourceBlocked: false,
  }), "done");
});

test("detail cooldown stops every source scan until the cooldown is cleared", () => {
  assert.equal(shouldScanSourcesDuringDetailCooldown({
    cooldownRemainingMs: 600_000,
    readyCandidateCount: 48,
    backlogTarget: 48,
    quietWindowMs: 90_000,
  }), false);
  assert.equal(shouldScanSourcesDuringDetailCooldown({
    cooldownRemainingMs: 60_000,
    readyCandidateCount: 10,
    backlogTarget: 48,
    quietWindowMs: 90_000,
  }), false);
  assert.equal(shouldScanSourcesDuringDetailCooldown({
    cooldownRemainingMs: 600_000,
    readyCandidateCount: 10,
    backlogTarget: 48,
    quietWindowMs: 90_000,
  }), false);
  assert.equal(shouldScanSourcesDuringDetailCooldown({
    cooldownRemainingMs: 0,
    readyCandidateCount: 48,
    backlogTarget: 48,
    quietWindowMs: 90_000,
  }), true);
});

test("one hung source page times out without blocking the batch", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 10, "source scan"),
    /source scan timed out after 10ms/,
  );
  assert.equal(await withTimeout(Promise.resolve("ok"), 100, "source scan"), "ok");
});

test("a closed browser source batch is fatal instead of being persisted as completed supply", () => {
  const fatal = fatalSourceBatchError([
    { source_url: "https://www.ozon.ru/seller/a/", stop_reason: "error: browserContext.newPage: Target page, context or browser has been closed" },
    { source_url: "https://www.ozon.ru/seller/b/", stop_reason: "error: page.goto: Timeout 12000ms exceeded" },
  ]);
  assert.match(fatal.message, /context or browser has been closed/i);
  assert.equal(fatalSourceBatchError([
    { source_url: "https://www.ozon.ru/seller/b/", stop_reason: "error: page.goto: Timeout 12000ms exceeded" },
  ]), null);
});

test("source page creation is included in the lifecycle timeout", async () => {
  const context = { newPage: async () => new Promise(() => {}) };
  await assert.rejects(
    scanSourceWithPage({
      context,
      url: "https://www.ozon.ru/search/?text=test",
      options: {},
      timeoutMs: 10,
      closeTimeoutMs: 5,
      scan: async () => ({ links: [] }),
    }),
    /source page lifecycle .* timed out after 10ms/,
  );
});

test("source page slots are reused across tranche batches and invalidated after failure", async () => {
  let created = 0;
  let closed = 0;
  const context = {
    newPage: async () => {
      created += 1;
      let isClosed = false;
      return {
        id: created,
        isClosed: () => isClosed,
        close: async () => { if (!isClosed) closed += 1; isClosed = true; },
      };
    },
  };
  const pagePool = [];
  const first = await scanSourceWithPage({
    context,
    url: "https://www.ozon.ru/search/?text=one",
    options: {},
    timeoutMs: 100,
    closeTimeoutMs: 5,
    pagePool,
    pageIndex: 0,
    scan: async (page) => ({ page_id: page.id }),
  });
  const second = await scanSourceWithPage({
    context,
    url: "https://www.ozon.ru/search/?text=two",
    options: {},
    timeoutMs: 100,
    closeTimeoutMs: 5,
    pagePool,
    pageIndex: 0,
    scan: async (page) => ({ page_id: page.id }),
  });
  assert.equal(first.page_id, 1);
  assert.equal(second.page_id, 1);
  assert.equal(created, 1);
  assert.equal(closed, 0);

  await assert.rejects(scanSourceWithPage({
    context,
    url: "https://www.ozon.ru/search/?text=broken",
    options: {},
    timeoutMs: 100,
    closeTimeoutMs: 5,
    pagePool,
    pageIndex: 0,
    scan: async () => { throw new Error("broken source page"); },
  }), /broken source page/);
  assert.equal(closed, 1);
  assert.equal(pagePool[0], null);

  await ensureReusablePageSlots(context, pagePool, 1, 100);
  assert.equal(created, 2);
  await closeReusablePages(pagePool, 5);
  assert.equal(closed, 2);
  assert.equal(pagePool.length, 0);
});

test("runtime page pools survive producer tranches but close when the browser context changes", async () => {
  let closed = 0;
  const firstContext = {};
  const secondContext = {};
  const runtime = {};
  const first = await runtimeReusablePagePools(runtime, firstContext, 10);
  first.sourcePages.push({ isClosed: () => false, close: async () => { closed += 1; } });
  first.favoritePages.push({ isClosed: () => false, close: async () => { closed += 1; } });

  const same = await runtimeReusablePagePools(runtime, firstContext, 10);
  assert.equal(same.sourcePages, first.sourcePages);
  assert.equal(same.favoritePages, first.favoritePages);
  assert.equal(closed, 0);

  const replacement = await runtimeReusablePagePools(runtime, secondContext, 10);
  assert.equal(closed, 2);
  assert.notEqual(replacement.sourcePages, first.sourcePages);
  assert.notEqual(replacement.favoritePages, first.favoritePages);
  assert.equal(replacement.sourcePages.length, 0);
  assert.equal(replacement.favoritePages.length, 0);

  replacement.sourcePages.push({ isClosed: () => false, close: async () => { closed += 1; } });
  await closeRuntimeReusablePagePools(runtime, 10);
  assert.equal(closed, 3);
  assert.equal(runtime.pagePoolContext, null);
});

test("favorite worker page creation has a bounded lifecycle", async () => {
  await assert.rejects(
    createFavoriteWorkerPage({ newPage: () => new Promise(() => {}) }, 5),
    /favorite worker page creation timed out after 5ms/,
  );
});

test("favorite SKU telemetry has a bounded lifecycle", async () => {
  await assert.rejects(
    readFavoriteSkusWithTimeout(() => new Promise(() => {}), 5),
    /favorite SKU telemetry timed out after 5ms/,
  );
});

test("favorite count telemetry has a bounded lifecycle", async () => {
  await assert.rejects(
    readFavoriteCountWithTimeout(() => new Promise(() => {}), 5),
    /favorite count telemetry timed out after 5ms/,
  );
});

test("source scan prioritizes proven sellers, Global China, and target families stably", () => {
  const ordinary = "https://www.ozon.ru/seller/ordinary/";
  const apparel = "https://www.ozon.ru/highlight/odezhda-obuv-i-aksessuary-iz-za-rubezha-1698511/";
  const global = "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/";
  const proven = "https://www.ozon.ru/seller/nuanniu/";
  assert.deepEqual(prioritizeSourceUrls([ordinary, apparel, global, proven]), [proven, global, apparel, ordinary]);
});

test("fresh seller files are verified discovery while keyword files remain exploration", () => {
  const seller = "https://www.ozon.ru/seller/new-store/";
  const search = "https://www.ozon.ru/search/?text=kids&is_global=true";
  assert.deepEqual(classifyFreshSourceUrls([search, seller]), {
    verifiedSellerUrls: [seller],
    explorationUrls: [search],
  });
});

test("repeated submitted sellers outrank ordinary exploration without becoming verified", () => {
  const strictSeller = "https://www.ozon.ru/seller/strict/";
  const submittedSeller = "https://www.ozon.ru/seller/submitted/";
  const search = "https://www.ozon.ru/search/?text=kids&is_global=true";
  assert.deepEqual(prioritizeSourceUrls([search, submittedSeller, strictSeller], {
    freshSourceUrls: [search],
    qualifiedFreshSourceUrls: [submittedSeller],
    verifiedFreshSourceUrls: [strictSeller],
  }), [strictSeller, submittedSeller, search]);
});

test("recent repeated submissions override an old dry-family penalty for bounded seller exploration", () => {
  const submittedSeller = "https://www.ozon.ru/seller/recovered/";
  const promotedSearch = "https://www.ozon.ru/search/?text=promoted&is_global=true";
  const oldDryRows = Array.from({ length: 24 }, (_, index) => ({
    at: new Date(Date.parse("2026-07-15T07:00:00.000Z") + index * 1000).toISOString(),
    source_url: submittedSeller,
    sku: `old-dry-${index}`,
    status: "rejected",
  }));
  const recentSubmittedRows = ["recovered-1", "recovered-2"].map((sku, index) => ({
    at: new Date(Date.parse("2026-07-16T07:00:00.000Z") + index * 1000).toISOString(),
    source_url: submittedSeller,
    sku,
    status: "submitted",
  }));
  assert.deepEqual(prioritizeSourceUrls([promotedSearch, submittedSeller], {
    yieldRows: [...oldDryRows, ...recentSubmittedRows],
    qualifiedFreshSourceUrls: [submittedSeller],
    verifiedFreshSourceUrls: [promotedSearch],
  }), [submittedSeller, promotedSearch]);
});

test("a qualified seller with a newer dry tail loses its historical fixed tier", () => {
  const staleSubmittedSeller = "https://www.ozon.ru/seller/stale-qualified/";
  const productiveSearch = "https://www.ozon.ru/search/?text=productive&is_global=true";
  const rows = [
    ...["old-submitted-1", "old-submitted-2"].map((sku, index) => ({
      at: new Date(Date.parse("2026-07-16T06:00:00.000Z") + index * 1000).toISOString(),
      source_url: staleSubmittedSeller,
      sku,
      status: "submitted",
    })),
    ...Array.from({ length: 12 }, (_, index) => ({
      at: new Date(Date.parse("2026-07-16T08:00:00.000Z") + index * 1000).toISOString(),
      source_url: `${staleSubmittedSeller}?page=${2 + Math.floor(index / 4)}&sorting=rating`,
      sku: `recent-non-fbs-${index}`,
      status: "rejected",
      reason: "non-pure-fbs",
    })),
    { at: "2026-07-16T08:30:00.000Z", source_url: productiveSearch, sku: "search-win", status: "published" },
  ];
  assert.deepEqual(prioritizeSourceUrls([staleSubmittedSeller, productiveSearch], {
    yieldRows: rows,
    qualifiedFreshSourceUrls: [staleSubmittedSeller],
    verifiedFreshSourceUrls: [productiveSearch],
  }), [productiveSearch, staleSubmittedSeller]);
});

test("fresh sellers expand into bounded price and sorting variants", () => {
  const seller = "https://www.ozon.ru/seller/new-store/";
  const expanded = expandFreshSellerSourceUrls([seller]);
  assert.equal(expanded[0], seller);
  assert.equal(expanded.length, 7);
  assert.equal(new Set(expanded).size, expanded.length);
  assert.equal(new URL(expanded[1]).searchParams.get("currency_price"), "500.000;");
  assert.ok(expanded.some((url) => new URL(url).searchParams.get("currency_price") === "500.000;"
    && new URL(url).searchParams.get("sorting") === "discount"));
  assert.ok(expanded.every((url) => new URL(url).searchParams.get("sorting") !== "price"));
  assert.ok(expanded.every((url) => new URL(url).searchParams.get("currency_price") !== "120.000;"));
});

test("published sources expand into prioritized sorting variants without duplicates", () => {
  const successful = "https://www.ozon.ru/seller/example/?currency_price=50.000%3B";
  const ordinary = "https://www.ozon.ru/seller/ordinary/";
  const rows = [{ source_url: successful, status: "published" }];
  const expanded = expandHighYieldSourceUrls([ordinary, successful], rows);
  const prioritized = prioritizeSourceUrls(expanded, { highYieldSources: [successful] });
  assert.equal(prioritized[0], successful);
  assert.equal(new URL(expanded[2]).searchParams.get("currency_price"), "500.000;");
  assert.ok(prioritized.some((value) => new URL(value).searchParams.get("currency_price") === "500.000;"
    && new URL(value).searchParams.get("sorting") === "discount"));
  assert.ok(expanded.every((value) => new URL(value).searchParams.get("sorting") !== "price"));
  assert.ok(expanded.every((value) => new URL(value).searchParams.get("currency_price") !== "120.000;"));
  assert.equal(new Set(prioritized).size, prioritized.length);
});

test("legacy low-price variants require exact-band publication evidence", () => {
  const proven50 = "https://www.ozon.ru/seller/proven/?currency_price=50.000%3B";
  const provenPrice = `${proven50}&sorting=price`;
  const urls = [
    proven50,
    `${proven50}&sorting=rating`,
    provenPrice,
    "https://www.ozon.ru/seller/unproven/?currency_price=50.000%3B",
    "https://www.ozon.ru/seller/unproven/?currency_price=120.000%3B",
    "https://www.ozon.ru/seller/unproven/?currency_price=150.000%3B",
    "https://www.ozon.ru/seller/unproven/?currency_price=500.000%3B",
  ];
  assert.deepEqual(filterProductiveSourceVariants(urls, [
    { source_url: proven50, sku: "winner", status: "published" },
    { source_url: provenPrice, sku: "price-winner", status: "published" },
  ]), [
    proven50,
    `${proven50}&sorting=rating`,
    provenPrice,
    "https://www.ozon.ru/seller/unproven/?currency_price=150.000%3B",
    "https://www.ozon.ru/seller/unproven/?currency_price=500.000%3B",
  ]);
});

test("strictly published sources expand into deeper result pages", () => {
  const published = "https://www.ozon.ru/seller/proven/?currency_price=50.000%3B&sorting=price";
  assert.deepEqual(expandPublishedSourcePages([], [
    { source_url: published, sku: "winner", status: "published" },
    { source_url: "https://www.ozon.ru/seller/rejected/", sku: "nope", status: "rejected" },
  ], [2, 3]), [
    published,
    `${published}&page=2`,
    `${published}&page=3`,
  ]);
});

test("strict discovery sources probe only their exact next page through page eight", () => {
  const highlight = "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?currency_price=150.000%3B&sorting=rating";
  const pageTwoSearch = "https://www.ozon.ru/search/?text=%D0%BA%D0%B5%D0%BF%D0%BA%D0%B0&is_global=true&currency_price=150.000%3B&page=2";
  const pageThreeSearch = "https://www.ozon.ru/search/?text=%D0%BD%D0%BE%D1%81%D0%BA%D0%B8&is_global=true&currency_price=500.000%3B&page=3";
  const pageFiveSearch = pageThreeSearch.replace("page=3", "page=5");
  const pageEightSearch = pageThreeSearch.replace("page=3", "page=8");
  assert.deepEqual(expandNextPublishedDiscoveryPages([
    { source_url: highlight, sku: "highlight-win", status: "published" },
    { source_url: `${highlight}&miniapp=1`, sku: "highlight-win-2", status: "published" },
    { source_url: pageTwoSearch, sku: "search-page-two-win", status: "published" },
    { source_url: pageThreeSearch, sku: "search-page-three-win", status: "published" },
    { source_url: `${pageThreeSearch.replace("page=3", "page=4")}`, sku: "search-page-four-win", status: "published" },
    { source_url: pageFiveSearch, sku: "search-page-five-win", status: "published" },
    { source_url: pageEightSearch, sku: "search-page-eight-win", status: "published" },
    { source_url: "https://www.ozon.ru/seller/proven/?page=3", sku: "seller-win", status: "published" },
    { source_url: "https://www.ozon.ru/highlight/rejected/?page=3", sku: "nope", status: "rejected" },
  ]), [
    "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?currency_price=150.000%3B&sorting=rating&page=2",
    "https://www.ozon.ru/search/?text=%D0%BA%D0%B5%D0%BF%D0%BA%D0%B0&is_global=true&currency_price=150.000%3B&page=3",
    "https://www.ozon.ru/search/?text=%D0%BD%D0%BE%D1%81%D0%BA%D0%B8&is_global=true&currency_price=500.000%3B&page=4",
    "https://www.ozon.ru/search/?text=%D0%BD%D0%BE%D1%81%D0%BA%D0%B8&is_global=true&currency_price=500.000%3B&page=5",
    "https://www.ozon.ru/search/?text=%D0%BD%D0%BE%D1%81%D0%BA%D0%B8&is_global=true&currency_price=500.000%3B&page=6",
  ]);
});

test("repeated strict discovery bands probe exact page four strategies", () => {
  const base = "https://www.ozon.ru/search/?text=%D0%BD%D0%BE%D1%81%D0%BA%D0%B8&is_global=true&currency_price=500.000%3B";
  const rating = `${base}&sorting=rating&page=2`;
  const singleton = "https://www.ozon.ru/highlight/single/?currency_price=150.000%3B";
  assert.deepEqual(expandRepeatedPublishedDiscoveryPageFour([
    { source_url: base, sku: "win-1", status: "published" },
    { source_url: rating, sku: "win-2", status: "published" },
    { source_url: `${base}&miniapp=1`, sku: "win-1", status: "published" },
    { source_url: singleton, sku: "single", status: "published" },
    { source_url: singleton, sku: "nope", status: "rejected" },
    { source_url: "https://www.ozon.ru/seller/not-discovery/?page=2", sku: "seller-win", status: "published" },
  ]), [
    `${base}&page=4`,
    `${base}&sorting=rating&page=4`,
  ]);
});

test("strict publications derive fresh Global search sources from useful title terms", () => {
  const urls = deriveSearchSourceUrls([
    { status: "published", title: "Носки для девочек, 5 пар" },
    { status: "published", title: "Конструктор Двенадцать знаков зодиака Лошадь" },
    { status: "skipped", title: "Бесполезный источник" },
  ]);
  assert.ok(urls.length >= 4);
  assert.ok(urls.some((url) => new URL(url).searchParams.get("text") === "носки девочек"));
  assert.ok(urls.every((url) => new URL(url).searchParams.get("is_global") === "true"));
  assert.ok(urls.some((url) => new URL(url).searchParams.get("text") === "конструктор двенадцать"));
  assert.ok(urls.some((url) => new URL(url).searchParams.get("text") === "двенадцать знаков"));
  assert.ok(urls.every((url) => !decodeURIComponent(url).includes("бесполезный")));
});

test("repeated strict submissions receive a bounded derived-search leading slot", () => {
  const repeated = "https://www.ozon.ru/search/?text=winner&currency_price=500.000%3B";
  const singleton = "https://www.ozon.ru/search/?text=singleton&currency_price=500.000%3B";
  const urls = deriveSearchSourceUrls([
    { status: "submitted", sku: "repeat-1", source_url: repeated, title: "Комплект трусов хлопковые мягкие" },
    { status: "submitted", sku: "repeat-2", source_url: `${repeated}&page=2`, title: "Трусы слипы хлопковые набор" },
    { status: "submitted", sku: "single-1", source_url: singleton, title: "Одиночный случай источник" },
  ], 4, ["500.000;"], [1]);
  const texts = urls.map((url) => new URL(url).searchParams.get("text"));
  assert.ok(texts.some((text) => text.includes("трус")));
  assert.ok(texts.every((text) => !text.includes("одиночный")));
});

test("derived search budget uses the most recent strict publications first", () => {
  const urls = deriveSearchSourceUrls([
    { status: "published", title: "Старый товар источник" },
    { status: "published", title: "Новый успешный товар" },
  ], 1);
  assert.equal(new URL(urls[0]).searchParams.get("text"), "новый успешный товар");
});

test("derived search recency follows event time across concatenated run files", () => {
  const urls = deriveSearchSourceUrls([
    { at: "2026-07-16T15:30:00.000Z", status: "published", title: "Комплект трусов бикини" },
    { at: "2026-07-15T09:00:00.000Z", status: "published", title: "Уховарка нержавеющая сталь" },
  ], 1);
  assert.equal(new URL(urls[0]).searchParams.get("text"), "комплект трусов бикини");
});

test("derived searches prefer a repeatable full-funnel source over a newer one-off success", () => {
  const repeatable = "https://www.ozon.ru/search/?text=repeatable&is_global=true&currency_price=500.000%3B";
  const oneOff = "https://www.ozon.ru/seller/one-off/";
  const urls = deriveSearchSourceUrls([
    ...Array.from({ length: 3 }, (_, index) => ({
      at: new Date(Date.parse("2026-07-16T15:00:00.000Z") + index * 1000).toISOString(),
      status: "published",
      sku: `repeat-${index}`,
      source_url: repeatable,
      title: `Комплект трусов бикини ${index + 1}`,
    })),
    {
      at: "2026-07-16T15:30:00.000Z",
      status: "published",
      sku: "one-off",
      source_url: oneOff,
      title: "Кресло детское мягкое",
    },
  ], 1);
  assert.equal(new URL(urls[0]).searchParams.get("text"), "комплект трусов бикини");
});

test("derived searches reserve a bounded slot for the newest strict evidence", () => {
  const durable = "https://www.ozon.ru/search/?text=durable&is_global=true&currency_price=500.000%3B";
  const older = "https://www.ozon.ru/search/?text=older&is_global=true&currency_price=500.000%3B";
  const recent = "https://www.ozon.ru/seller/recent-current-run/";
  const urls = deriveSearchSourceUrls([
    ...Array.from({ length: 4 }, (_, index) => ({
      at: new Date(Date.parse("2026-07-15T10:00:00.000Z") + index * 1000).toISOString(),
      status: "published",
      sku: `durable-${index}`,
      source_url: durable,
      title: `Комплект трусов бикини ${index + 1}`,
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      at: new Date(Date.parse("2026-07-15T11:00:00.000Z") + index * 1000).toISOString(),
      status: "published",
      sku: `older-${index}`,
      source_url: older,
      title: `Заколка для волос жемчужная ${index + 1}`,
    })),
    {
      at: "2026-07-17T05:20:00.000Z",
      status: "published",
      sku: "recent-current",
      source_url: recent,
      title: "Чехол для дивана эластичный",
    },
  ], 2, ["500.000;"], [1]);
  assert.deepEqual(urls.map((url) => new URL(url).searchParams.get("text")), [
    "комплект трусов бикини",
    "чехол дивана эластичный",
  ]);
});

test("newest reserved evidence runs immediately after the top full-funnel group", () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({
    at: new Date(Date.parse("2026-07-15T10:00:00.000Z") + index * 1000).toISOString(),
    status: "published",
    sku: `history-${index}`,
    source_url: "https://www.ozon.ru/seller/durable-history/",
    title: `Исторический товар победитель${"а".repeat(index + 4)}`,
  }));
  rows.push({
    at: "2026-07-17T05:20:00.000Z",
    status: "published",
    sku: "recent-sofa-cover",
    source_url: "https://www.ozon.ru/seller/recent-sofa-cover/",
    title: "Чехол для мебели дивана",
  });
  const urls = deriveSearchSourceUrls(rows, 48, ["150.000;", "500.000;"], [1, 2]);
  assert.equal(new URL(urls[0]).searchParams.get("text"), `исторический товар победитель${"а".repeat(11)}`);
  assert.equal(new URL(urls[4]).searchParams.get("text"), "чехол мебели дивана");
});

test("newest reserved evidence skips a source after its full-funnel yield turns negative", () => {
  const durable = "https://www.ozon.ru/seller/durable-profit/";
  const healthy = "https://www.ozon.ru/seller/healthy-recent/";
  const exhausted = "https://www.ozon.ru/search/?text=exhausted&is_global=true";
  const urls = deriveSearchSourceUrls([
    ...Array.from({ length: 4 }, (_, index) => ({
      at: new Date(Date.parse("2026-07-15T10:00:00.000Z") + index * 1000).toISOString(),
      status: "published",
      sku: `durable-${index}`,
      source_url: durable,
      title: `Комплект трусов бикини ${index + 1}`,
    })),
    {
      at: "2026-07-17T05:20:00.000Z",
      status: "published",
      sku: "healthy",
      source_url: healthy,
      title: "Чехол мебели дивана",
    },
    {
      at: "2026-07-17T05:30:00.000Z",
      status: "published",
      sku: "exhausted-win",
      source_url: exhausted,
      title: "Куклы милые плюшевые",
    },
    ...Array.from({ length: 20 }, (_, index) => ({
      at: new Date(Date.parse("2026-07-17T05:31:00.000Z") + index * 1000).toISOString(),
      status: "skipped",
      sku: `exhausted-loss-${index}`,
      source_url: exhausted,
      title: `Брелок кукла ${index + 1}`,
      reason: "profit_rate<=30",
    })),
  ], 2, ["500.000;"], [1]);
  assert.deepEqual(urls.map((url) => new URL(url).searchParams.get("text")), [
    "комплект трусов бикини",
    "чехол мебели дивана",
  ]);
});

test("derived searches replay the exact productive search phrase before title siblings", () => {
  const source = "https://www.ozon.ru/search/?text=%D1%82%D1%80%D1%83%D1%81%D0%BE%D0%B2+%D0%B1%D1%80%D0%B8%D1%84%D1%8B&is_global=true&currency_price=150.000%3B";
  const urls = deriveSearchSourceUrls([
    { status: "published", sku: "winner-1", source_url: source, title: "Комплект трусов бикини, 7 шт" },
    { status: "published", sku: "winner-2", source_url: `${source}&page=2`, title: "Нижнее белье хлопковое, 3 шт" },
  ], 1);
  assert.equal(new URL(urls[0]).searchParams.get("text"), "трусов брифы");
});

test("derived searches prefer concrete product terms over demographic-only phrases", () => {
  const source = "https://www.ozon.ru/search/?text=%D0%BD%D0%B0%D0%B1%D0%BE%D1%80+%D0%B4%D0%B5%D0%B2%D0%BE%D1%87%D0%B5%D0%BA+%D0%B4%D0%B5%D1%82%D1%81%D0%BA%D0%BE%D0%B9&is_global=true";
  const urls = deriveSearchSourceUrls([{
    status: "published",
    sku: "cosmetics-winner",
    source_url: source,
    title: "Набор для девочек детской декоративной косметики чемоданчик",
  }], 10);
  assert.equal(new URL(urls[0]).searchParams.get("text"), "декоративной косметики чемоданчик");
  assert.ok(urls.every((url) => ![
    "набор девочек детской",
    "девочек детской",
    "набор девочек детской декоративной",
    "девочек детской декоративной",
  ].includes(new URL(url).searchParams.get("text"))));
});

test("duplicate strict evidence from run and history does not crowd out another winner", () => {
  const recent = { at: "2026-07-16T15:30:00.000Z", status: "published", sku: "recent", title: "Комплект трусов бикини" };
  const urls = deriveSearchSourceUrls([
    recent,
    { ...recent },
    { at: "2026-07-16T15:20:00.000Z", status: "published", sku: "older", title: "Заколка для волос" },
  ], 2);
  assert.deepEqual(urls.map((url) => new URL(url).searchParams.get("text")), [
    "комплект трусов бикини",
    "заколка волос",
  ]);
});

test("derived search group budget rounds up before allocating sibling query variants", () => {
  const rows = Array.from({ length: 3 }, (_, index) => ({
    at: new Date(Date.parse("2026-07-16T15:00:00.000Z") + index * 1000).toISOString(),
    status: "published",
    sku: `winner-${index}`,
    title: `Товар победитель ${"а".repeat(index + 4)}`,
  }));
  const urls = deriveSearchSourceUrls(rows, 5);
  assert.ok(urls.slice(0, 3).some((url) => new URL(url).searchParams.get("text") === `товар победитель ${"а".repeat(4)}`));
});

test("derived search discovery round-robins successful titles before using a second query variant", () => {
  const urls = deriveSearchSourceUrls([
    { status: "published", title: "Носки девочек хлопковые мягкие" },
    { status: "published", title: "Самолет радиоуправляемый детский красный" },
  ], 2);
  assert.deepEqual(urls.map((url) => new URL(url).searchParams.get("text")), [
    "самолет радиоуправляемый красный",
    "носки девочек хлопковые",
  ]);
});

test("derived search can probe multiple price bands without merging their yield", () => {
  const urls = deriveSearchSourceUrls([
    { status: "published", title: "Носки девочек хлопковые мягкие" },
    { status: "published", title: "Самолет радиоуправляемый детский красный" },
  ], 4, ["150.000;", "500.000;"]);
  assert.deepEqual(urls.map((url) => ({
    text: new URL(url).searchParams.get("text"),
    band: new URL(url).searchParams.get("currency_price"),
  })), [
    { text: "самолет радиоуправляемый красный", band: "150.000;" },
    { text: "самолет радиоуправляемый красный", band: "500.000;" },
    { text: "носки девочек хлопковые", band: "150.000;" },
    { text: "носки девочек хлопковые", band: "500.000;" },
  ]);
});

test("derived search budget reserves room for sibling queries from recent winners", () => {
  const rows = Array.from({ length: 42 }, (_, index) => ({
    status: "published",
    title: `Товар победитель ${"а".repeat(index + 4)} коллекция`,
  }));
  const urls = deriveSearchSourceUrls(rows, 80, ["150.000;", "500.000;"]);
  const texts = urls.map((url) => new URL(url).searchParams.get("text"));
  assert.equal(urls.length, 80);
  assert.ok(texts.includes(`товар победитель ${"а".repeat(45)}`));
  assert.ok(texts.includes("товар победитель"));
  assert.ok(!texts.includes(`товар победитель ${"а".repeat(4)}`));
});

test("derived search can explore deeper result pages as distinct sources", () => {
  const urls = deriveSearchSourceUrls([
    { status: "published", title: "Комплект трусов слипы хлопковые" },
  ], 4, ["500.000;"], [1, 2]);
  assert.deepEqual(urls.map((url) => ({
    text: new URL(url).searchParams.get("text"),
    page: new URL(url).searchParams.get("page"),
  })), [
    { text: "комплект трусов слипы", page: null },
    { text: "комплект трусов слипы", page: "2" },
    { text: "комплект трусов", page: null },
    { text: "комплект трусов", page: "2" },
  ]);
});

test("derived search discovery can be disabled with a zero budget", () => {
  assert.deepEqual(deriveSearchSourceUrls([{ status: "published", title: "Новый успешный товар" }], 0), []);
});

test("repeated publication yield outranks a merely proven seller", () => {
  const proven = "https://www.ozon.ru/seller/nuanniu/";
  const productive = "https://www.ozon.ru/seller/chestnost-2336398/";
  assert.deepEqual(prioritizeSourceUrls([proven, productive], {
    highYieldSources: [proven, productive, productive, productive],
  }), [productive, proven]);
});

test("strict-success scheduling reserves one bounded exploration slot per six exploit sources", () => {
  const exploits = Array.from({ length: 8 }, (_, index) => `https://www.ozon.ru/search/?text=winner-${index}&is_global=true`);
  const exploration = [
    "https://www.ozon.ru/search/?text=new-one&is_global=true",
    "https://www.ozon.ru/search/?text=new-two&is_global=true",
  ];
  const yieldRows = exploits.map((source_url, index) => ({
    status: "published",
    sku: `strict-${index}`,
    source_url,
  }));
  assert.deepEqual(interleaveStrictSuccessExploration([...exploits, ...exploration], yieldRows, 6), [
    ...exploits.slice(0, 6),
    exploration[0],
    ...exploits.slice(6),
    exploration[1],
  ]);
});

test("full-funnel source yield penalizes exhausted high-volume sources", () => {
  const fresh = "https://www.ozon.ru/seller/fresh/";
  const exhausted = "https://www.ozon.ru/seller/exhausted/";
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => ({ source_url: fresh, sku: `f-${i}`, status: "published" })),
    ...Array.from({ length: 10 }, (_, i) => ({ source_url: exhausted, sku: `e-p-${i}`, status: "published" })),
    ...Array.from({ length: 90 }, (_, i) => ({ source_url: exhausted, sku: `e-r-${i}`, status: "rejected" })),
  ];
  assert.deepEqual(prioritizeSourceUrls([exhausted, fresh], { yieldRows: rows }), [fresh, exhausted]);
});

test("a recovered hot source is ranked by its recent unique outcomes instead of stale lifetime failures", () => {
  const recovered = "https://www.ozon.ru/search/?text=underwear&is_global=true&currency_price=1000.000%3B";
  const merelyStable = "https://www.ozon.ru/search/?text=accessories&is_global=true&currency_price=500.000%3B";
  const oldFailures = Array.from({ length: 60 }, (_, index) => ({
    at: new Date(Date.parse("2026-07-14T00:00:00.000Z") + index * 1000).toISOString(),
    source_url: recovered,
    sku: `old-failure-${index}`,
    status: "rejected",
  }));
  const stableRows = Array.from({ length: 6 }, (_, index) => ({
    at: new Date(Date.parse("2026-07-15T00:00:00.000Z") + index * 1000).toISOString(),
    source_url: merelyStable,
    sku: `stable-${index}`,
    status: index < 3 ? "published" : "rejected",
  }));
  const recentRecovery = Array.from({ length: 4 }, (_, index) => ({
    at: new Date(Date.parse("2026-07-16T15:00:00.000Z") + index * 1000).toISOString(),
    source_url: `${recovered}&page=${index + 4}`,
    sku: `recent-win-${index}`,
    status: "published",
  }));

  assert.deepEqual(prioritizeSourceUrls([merelyStable, recovered], {
    yieldRows: [...oldFailures, ...stableRows, ...recentRecovery],
    verifiedFreshSourceUrls: [merelyStable, recovered],
  }), [recovered, merelyStable]);
});

test("full-funnel source yield promotes repeated pure-FBS favorites over rejected sources", () => {
  const rejected = "https://www.ozon.ru/seller/rejected/";
  const pureFbs = "https://www.ozon.ru/seller/pure-fbs/";
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ source_url: rejected, sku: `r-${i}`, status: "rejected" })),
    ...Array.from({ length: 5 }, (_, i) => ({ source_url: pureFbs, sku: `f-${i}`, status: "favorited" })),
  ];
  assert.deepEqual(prioritizeSourceUrls([rejected, pureFbs], { yieldRows: rows }), [pureFbs, rejected]);
});

test("full-funnel scores put a fully dry explored source below untried supply", () => {
  const dry = "https://www.ozon.ru/search/?text=dry-consumer&currency_price=150.000%3B";
  const scores = fullFunnelSourceScores(Array.from({ length: 8 }, (_, index) => ({
    source_url: dry,
    sku: `dry-consumer-${index}`,
    status: "skipped",
    reason: "non-pure-fbs",
  })));
  assert.ok(scores.get(dry) < 0);
});

test("strict submissions are a stronger leading source signal than favorites", () => {
  const favoriteOnly = "https://www.ozon.ru/seller/favorite-only/";
  const submitted = "https://www.ozon.ru/seller/submitted/";
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => ({ source_url: favoriteOnly, sku: `f-${i}`, status: "favorited" })),
    ...Array.from({ length: 3 }, (_, i) => ({ source_url: submitted, sku: `s-${i}`, status: "submitted" })),
  ];
  assert.deepEqual(prioritizeSourceUrls([favoriteOnly, submitted], { yieldRows: rows }), [submitted, favoriteOnly]);
});

test("recent strict submissions keep a verified seller out of the dry-tail penalty", () => {
  const productive = "https://www.ozon.ru/seller/recent-submitted/";
  const untried = "https://www.ozon.ru/seller/untried/";
  const rows = [
    ...Array.from({ length: 12 }, (_, index) => ({
      at: `2026-07-16T00:${String(index).padStart(2, "0")}:00Z`,
      source_url: `${productive}?page=${index + 2}`,
      sku: `reject-${index}`,
      status: "rejected",
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      at: `2026-07-16T00:${12 + index}:00Z`,
      source_url: productive,
      sku: `submitted-${index}`,
      status: "submitted",
    })),
  ];
  assert.deepEqual(prioritizeSourceUrls([productive, untried], {
    yieldRows: rows,
    verifiedFreshSourceUrls: [productive, untried],
  }), [productive, untried]);
});

test("an exhausted one-hit seller yields to an untried verified seller family", () => {
  const exhausted = "https://www.ozon.ru/seller/one-hit/?currency_price=50.000%3B";
  const untried = "https://www.ozon.ru/seller/untried/";
  const rows = [
    { source_url: exhausted, sku: "only-win", status: "published" },
    ...Array.from({ length: 20 }, (_, index) => ({
      source_url: `${exhausted}&page=${index + 2}`,
      sku: `rejected-${index}`,
      status: "rejected",
    })),
  ];
  assert.deepEqual(prioritizeSourceUrls([exhausted, untried], {
    yieldRows: rows,
    verifiedFreshSourceUrls: [exhausted, untried],
  }), [untried, exhausted]);
});

test("a recent twelve-SKU dry tail overrides older seller wins", () => {
  const staleWinner = "https://www.ozon.ru/seller/stale-winner/";
  const untried = "https://www.ozon.ru/seller/untried/";
  const rows = [
    ...Array.from({ length: 16 }, (_, index) => ({
      at: `2026-07-15T00:${String(index).padStart(2, "0")}:00Z`,
      source_url: staleWinner,
      sku: `old-win-${index}`,
      status: "published",
    })),
    ...Array.from({ length: 12 }, (_, index) => ({
      at: `2026-07-16T00:${String(index).padStart(2, "0")}:00Z`,
      source_url: `${staleWinner}?page=${index + 2}`,
      sku: `recent-reject-${index}`,
      status: "rejected",
    })),
  ];
  assert.deepEqual(prioritizeSourceUrls([staleWinner, untried], {
    yieldRows: rows,
    verifiedFreshSourceUrls: [staleWinner, untried],
  }), [untried, staleWinner]);
});

test("a seller below thirty percent recent full-funnel yield gives way to untried supply", () => {
  const overcommitted = "https://www.ozon.ru/seller/overcommitted/";
  const untried = "https://www.ozon.ru/seller/untried/";
  const rows = [
    ...Array.from({ length: 8 }, (_, index) => ({
      at: `2026-07-15T00:0${index}:00Z`,
      source_url: overcommitted,
      sku: `old-published-${index}`,
      status: "published",
    })),
    ...Array.from({ length: 12 }, (_, index) => ({
      at: `2026-07-16T00:${String(index).padStart(2, "0")}:00Z`,
      source_url: overcommitted,
      sku: `recent-${index}`,
      status: index < 2 ? "favorited" : index === 2 ? "submitted" : "rejected",
      reason: index > 2 ? "non-pure-fbs" : null,
    })),
  ];

  assert.deepEqual(prioritizeSourceUrls([overcommitted, untried], {
    yieldRows: rows,
    verifiedFreshSourceUrls: [overcommitted, untried],
  }), [untried, overcommitted]);
});

test("a dry verified seller yields its fixed tier to productive Global discovery", () => {
  const staleSeller = "https://www.ozon.ru/seller/stale-verified/";
  const toySearch = "https://www.ozon.ru/search/?text=%D0%B4%D0%B5%D1%82%D1%81%D0%BA%D0%B0%D1%8F+%D0%B8%D0%B3%D1%80%D1%83%D1%88%D0%BA%D0%B0&is_global=true";
  const rows = [
    { source_url: staleSeller, sku: "old-win", status: "published", at: "2026-07-15T00:00:00Z" },
    ...Array.from({ length: 12 }, (_, index) => ({
      source_url: `${staleSeller}?page=${index + 2}`,
      sku: `dry-${index}`,
      status: "rejected",
      at: `2026-07-16T00:${String(index).padStart(2, "0")}:00Z`,
    })),
    { source_url: toySearch, sku: "toy-win", title_family: "toy", status: "published" },
  ];
  assert.deepEqual(prioritizeSourceUrls([staleSeller, toySearch], {
    yieldRows: rows,
    freshSourceUrls: [toySearch],
    verifiedFreshSourceUrls: [staleSeller, toySearch],
  }), [toySearch, staleSeller]);
});

test("a dry seller family cannot revive itself through an unseen bounded deep variant", () => {
  const seller = "https://www.ozon.ru/seller/deep-winner/";
  const pageTwo = `${seller}?page=2`;
  const pageFour = `${seller}?page=4`;
  const search = "https://www.ozon.ru/search/?text=productive&is_global=true";
  const rows = [
    { source_url: seller, sku: "old-win-1", status: "published", at: "2026-07-15T00:00:00Z" },
    { source_url: seller, sku: "old-win-2", status: "published", at: "2026-07-15T00:01:00Z" },
    ...Array.from({ length: 12 }, (_, index) => ({
      source_url: `${seller}?page=${index % 2 + 2}`,
      sku: `dry-${index}`,
      status: "rejected",
      at: `2026-07-16T00:${String(index).padStart(2, "0")}:00Z`,
    })),
    { source_url: search, sku: "search-win", status: "published" },
  ];
  assert.deepEqual(prioritizeSourceUrls([pageTwo, search, pageFour], {
    yieldRows: rows,
    freshSourceUrls: [search],
    verifiedFreshSourceUrls: [seller, search],
    boundedDeepFreshSourceUrls: [pageFour],
  }), [search, pageTwo, pageFour]);
});

test("seller-family dry tails span price sorting and page variants", () => {
  const seller = "https://www.ozon.ru/seller/variant-dry/";
  const dryDeepVariant = `${seller}?sorting=rating&currency_price=500.000%3B&page=9`;
  const productiveSearch = "https://www.ozon.ru/search/?text=kids+accessories&is_global=true";
  const variants = [
    seller,
    `${seller}?sorting=price&page=2`,
    `${seller}?currency_price=50.000%3B&page=4`,
    `${seller}?sorting=rating&currency_price=500.000%3B&page=8`,
  ];
  const rows = [
    { source_url: seller, sku: "old-win", status: "published", at: "2026-07-15T00:00:00Z" },
    ...Array.from({ length: 12 }, (_, index) => ({
      source_url: variants[index % variants.length],
      sku: `variant-dry-${index}`,
      status: "rejected",
      reason: "non-pure-fbs",
      at: `2026-07-16T00:${String(index).padStart(2, "0")}:00Z`,
    })),
    { source_url: productiveSearch, sku: "search-win", status: "published", at: "2026-07-16T01:00:00Z" },
  ];
  assert.deepEqual(prioritizeSourceUrls([dryDeepVariant, productiveSearch], {
    yieldRows: rows,
    freshSourceUrls: [productiveSearch],
    verifiedFreshSourceUrls: [seller, productiveSearch],
    boundedDeepFreshSourceUrls: [dryDeepVariant],
  }), [productiveSearch, dryDeepVariant]);
});

test("deeper pages inherit source yield within the same price band", () => {
  const winner = "https://www.ozon.ru/seller/winner/?currency_price=500.000%3B";
  const pageTwo = `${winner}&page=2`;
  const unproven = "https://www.ozon.ru/seller/unproven/?currency_price=500.000%3B";
  assert.deepEqual(prioritizeSourceUrls([unproven, pageTwo], {
    yieldRows: [
      { source_url: winner, sku: "winner-1", status: "published" },
      { source_url: winner, sku: "winner-2", status: "published" },
    ],
  }), [pageTwo, unproven]);
});

test("derived search discovery is explored before exhausted historical sources", () => {
  const known = "https://www.ozon.ru/seller/known/";
  const fresh = "https://www.ozon.ru/search/?text=fresh&is_global=true";
  const yieldRows = Array.from({ length: 8 }, (_, i) => ({ source_url: known, sku: `k-${i}`, status: i < 3 ? "published" : "rejected" }));
  assert.deepEqual(prioritizeSourceUrls([known, fresh], { yieldRows, freshSourceUrls: [fresh] }), [fresh, known]);
});

test("verified fresh sellers outrank derived keyword exploration", () => {
  const seller = "https://www.ozon.ru/seller/fresh-store/";
  const search = "https://www.ozon.ru/search/?text=fresh&is_global=true";
  assert.deepEqual(prioritizeSourceUrls([search, seller], {
    freshSourceUrls: [search],
    verifiedFreshSourceUrls: [seller],
  }), [seller, search]);
});

test("explicitly promoted strict-derived searches join the verified priority tier", () => {
  const seller = "https://www.ozon.ru/seller/fresh-store/";
  const derived = "https://www.ozon.ru/search/?text=winning&is_global=true";
  assert.deepEqual(verifiedPrioritySourceUrls({
    verifiedFreshUrls: [seller],
    verifiedHistoricalUrls: [],
    derivedSearchUrls: [derived],
    prioritizeDerived: true,
  }), [seller, derived]);
  assert.deepEqual(prioritizeSourceUrls([seller, derived], {
    freshSourceUrls: [derived],
    verifiedFreshSourceUrls: [seller, derived],
  }), [seller, derived]);
});

test("explicit strict-derived searches join qualified rotation without promotion when disabled", () => {
  const submittedSeller = "https://www.ozon.ru/seller/submitted/";
  const derived = "https://www.ozon.ru/search/?text=комплект+трусов+бикини&is_global=true";
  assert.deepEqual(qualifiedPrioritySourceUrls({
    submittedSellerUrls: [submittedSeller],
    derivedSearchUrls: [derived],
    prioritizeDerived: true,
  }), [submittedSeller, derived]);
  assert.deepEqual(qualifiedPrioritySourceUrls({
    submittedSellerUrls: [submittedSeller],
    derivedSearchUrls: [derived],
    prioritizeDerived: false,
  }), [submittedSeller]);
});

test("strict-derived priority is bounded while the remaining exploration sources stay available", () => {
  const seller = "https://www.ozon.ru/seller/submitted/";
  const derived = [1, 2, 3].map((index) => `https://www.ozon.ru/search/?text=winner-${index}&is_global=true`);
  assert.deepEqual(qualifiedPrioritySourceUrls({
    submittedSellerUrls: [seller],
    derivedSearchUrls: derived,
    prioritizeDerived: true,
    derivedPriorityLimit: 2,
  }), [seller, derived[0], derived[1]]);
  assert.deepEqual(verifiedPrioritySourceUrls({
    verifiedFreshUrls: [seller],
    derivedSearchUrls: derived,
    prioritizeDerived: true,
    derivedPriorityLimit: 2,
  }), [seller, derived[0], derived[1]]);
});

test("verified strict-success sellers outrank a higher-yield verified search page", () => {
  const seller = "https://www.ozon.ru/seller/strict-winner/";
  const search = "https://www.ozon.ru/search/?text=historical&is_global=true";
  assert.deepEqual(prioritizeSourceUrls([search, seller], {
    yieldRows: Array.from({ length: 5 }, (_, index) => ({
      source_url: search,
      sku: `winner-${index}`,
      status: "published",
    })),
    verifiedFreshSourceUrls: [search, seller],
  }), [seller, search]);
});

test("repeated strict-success Global searches rotate with verified sellers", () => {
  const firstSeller = "https://www.ozon.ru/seller/strict-first/";
  const secondSeller = "https://www.ozon.ru/seller/strict-second/";
  const search = "https://www.ozon.ru/search/?text=briefs&is_global=true&currency_price=1000.000%3B";
  const yieldRows = [
    { source_url: search, sku: "search-win-1", status: "published" },
    { source_url: `${search}&page=3`, sku: "search-win-2", status: "published" },
  ];
  assert.deepEqual(prioritizeSourceUrls([firstSeller, secondSeller, search], {
    yieldRows,
    verifiedFreshSourceUrls: [firstSeller, secondSeller, search],
  }), [firstSeller, search, secondSeller]);
});

test("one lucky Global success remains below verified seller rotation", () => {
  const firstSeller = "https://www.ozon.ru/seller/strict-first/";
  const secondSeller = "https://www.ozon.ru/seller/strict-second/";
  const search = "https://www.ozon.ru/search/?text=lucky&is_global=true&currency_price=1000.000%3B";
  assert.deepEqual(prioritizeSourceUrls([firstSeller, secondSeller, search], {
    yieldRows: [{ source_url: search, sku: "one-win", status: "published" }],
    verifiedFreshSourceUrls: [firstSeller, secondSeller, search],
  }), [firstSeller, secondSeller, search]);
});

test("verified source variants finish their tier before ordinary sources", () => {
  const verified = "https://www.ozon.ru/search/?text=winner&is_global=true";
  const verifiedVariant = `${verified}&sorting=rating`;
  const verifiedPage = `${verified}&page=2`;
  const ordinary = "https://www.ozon.ru/seller/ordinary/";
  assert.deepEqual(prioritizeSourceUrls([ordinary, verifiedPage, verified, verifiedVariant], {
    verifiedFreshSourceUrls: [verified],
  }), [verifiedPage, verified, verifiedVariant, ordinary]);
});

test("two exhausted scan variants demote an overlapping verified family", () => {
  const seller = "https://www.ozon.ru/seller/overlap/";
  const untried = "https://www.ozon.ru/search/?text=untried&is_global=true";
  const scanRows = [
    { source_url: `${seller}?page=2`, cumulative_product_link_count: 36, eligible_link_count_before_collection: 0 },
    { source_url: `${seller}?page=3`, cumulative_product_link_count: 36, eligible_link_count_before_collection: 0 },
  ];
  assert.deepEqual(prioritizeSourceUrls([seller, untried], {
    verifiedFreshSourceUrls: [seller],
    freshSourceUrls: [untried],
    scanRows,
  }), [untried, seller]);
  const evidenceBackedPageFour = `${seller}?page=4`;
  assert.deepEqual(prioritizeSourceUrls([untried, evidenceBackedPageFour], {
    verifiedFreshSourceUrls: [seller],
    boundedDeepFreshSourceUrls: [evidenceBackedPageFour],
    freshSourceUrls: [untried],
    scanRows,
  }), [evidenceBackedPageFour, untried]);
  assert.deepEqual([...exhaustedScanFamilyKeys(scanRows)], [seller]);
  assert.deepEqual([...exhaustedScanFamilyKeys([
    scanRows[0],
    { ...scanRows[1], eligible_link_count_before_collection: null },
  ])], []);
  assert.deepEqual(prioritizeSourceUrls([seller, untried], {
    verifiedFreshSourceUrls: [seller],
    freshSourceUrls: [untried],
    scanRows: [...scanRows, {
      source_url: `${seller}?sorting=discount`,
      cumulative_product_link_count: 36,
      eligible_link_count_before_collection: 4,
    }],
  }), [seller, untried]);
});

test("bounded deep pages rotate seller families before taking another same-seller page", () => {
  const sellerA = "https://www.ozon.ru/seller/deep-a/";
  const sellerB = "https://www.ozon.ru/seller/deep-b/";
  const urls = [
    `${sellerA}?page=4`,
    `${sellerA}?page=4&sorting=rating`,
    `${sellerA}?page=5`,
    `${sellerA}?page=5&sorting=rating`,
    `${sellerB}?page=4`,
  ];
  assert.deepEqual(prioritizeSourceUrls(urls, {
    verifiedFreshSourceUrls: [sellerA, sellerB],
    boundedDeepFreshSourceUrls: urls,
  }).slice(0, 3), [urls[0], urls[1], urls[4]]);
});

test("verified and qualified sellers share a bounded family rotation", () => {
  const sellerA = "https://www.ozon.ru/seller/price-a/";
  const sellerB = "https://www.ozon.ru/seller/price-b/";
  const urls = [
    `${sellerA}?currency_price=500.000%3B&sorting=discount&page=2`,
    `${sellerA}?currency_price=500.000%3B&sorting=discount&page=3`,
    `${sellerA}?currency_price=1000.000%3B&sorting=rating&page=2`,
    `${sellerB}?currency_price=500.000%3B&sorting=discount&page=2`,
  ];
  assert.deepEqual(prioritizeSourceUrls(urls, {
    verifiedFreshSourceUrls: [sellerA],
    qualifiedFreshSourceUrls: [sellerB],
  }).slice(0, 3), [urls[0], urls[1], urls[3]]);
});

test("multiple verified families cannot postpone a qualified strict-derived family until the end of the tier", () => {
  const sellerA = "https://www.ozon.ru/seller/verified-a/";
  const sellerB = "https://www.ozon.ru/seller/verified-b/";
  const derived = "https://www.ozon.ru/search/?text=комплект+трусов+бикини&is_global=true";
  const urls = [
    sellerA,
    `${sellerA}?page=2`,
    sellerB,
    `${sellerB}?page=2`,
    derived,
  ];
  assert.deepEqual(prioritizeSourceUrls(urls, {
    verifiedFreshSourceUrls: [sellerA, sellerB, derived],
    qualifiedFreshSourceUrls: [derived],
  }).slice(0, 3), [urls[0], urls[1], derived]);
});

test("a fresh search family with twelve recent dry candidates yields to an untried source", () => {
  const drySearch = "https://www.ozon.ru/search/?text=dry-family&is_global=true&sorting=rating";
  const untriedSeller = "https://www.ozon.ru/seller/untried-family/";
  assert.deepEqual(prioritizeSourceUrls([drySearch, untriedSeller], {
    freshSourceUrls: [drySearch],
    yieldRows: Array.from({ length: 12 }, (_, index) => ({
      at: new Date(Date.parse("2026-07-16T07:00:00.000Z") + index * 1000).toISOString(),
      source_url: drySearch,
      sku: `dry-${index}`,
      status: "rejected",
    })),
  }), [untriedSeller, drySearch]);
});

test("a Global search price band yields after eight recent dry publish outcomes", () => {
  const drySearch = "https://www.ozon.ru/search/?text=eight-dry&is_global=true&currency_price=500.000%3B";
  const untriedSeller = "https://www.ozon.ru/seller/untried-after-eight/";
  assert.deepEqual(prioritizeSourceUrls([drySearch, untriedSeller], {
    freshSourceUrls: [drySearch],
    yieldRows: Array.from({ length: 8 }, (_, index) => ({
      at: new Date(Date.parse("2026-07-16T07:00:00.000Z") + index * 1000).toISOString(),
      source_url: drySearch,
      sku: `eight-dry-${index}`,
      status: "skipped",
      reason: "non-pure-fbs",
    })),
  }), [untriedSeller, drySearch]);
});

test("four consecutive explicit non-pure FBS cards demote only that search price band", () => {
  const drySearch = "https://www.ozon.ru/search/?text=fbo-only&is_global=true&currency_price=500.000%3B";
  const genericDrySearch = "https://www.ozon.ru/search/?text=generic-dry&is_global=true&currency_price=500.000%3B";
  const untriedSeller = "https://www.ozon.ru/seller/untried-after-fbo/";
  assert.deepEqual(prioritizeSourceUrls([drySearch, untriedSeller], {
    freshSourceUrls: [drySearch],
    yieldRows: Array.from({ length: 4 }, (_, index) => ({
      at: new Date(Date.parse("2026-07-16T07:00:00.000Z") + index * 1000).toISOString(),
      source_url: drySearch,
      sku: `fbo-only-${index}`,
      status: "skipped",
      reason: "non-pure-fbs",
    })),
  }), [untriedSeller, drySearch]);
  assert.deepEqual(prioritizeSourceUrls([genericDrySearch, untriedSeller], {
    freshSourceUrls: [genericDrySearch],
    yieldRows: Array.from({ length: 4 }, (_, index) => ({
      source_url: genericDrySearch,
      sku: `generic-dry-${index}`,
      status: "rejected",
      reason: "1688-no-reliable-match",
    })),
  }), [untriedSeller, genericDrySearch]);
});

test("four recent 1688 no-match outcomes override earlier favorites and fast-demote the source", () => {
  const drySearch = "https://www.ozon.ru/search/?text=no-match&is_global=true&currency_price=500.000%3B";
  const untriedSeller = "https://www.ozon.ru/seller/untried-after-no-match/";
  const rows = Array.from({ length: 4 }, (_, index) => [
    {
      at: new Date(Date.parse("2026-07-18T01:00:00.000Z") + index * 2000).toISOString(),
      source_url: drySearch,
      sku: `no-match-${index}`,
      status: "favorited",
    },
    {
      at: new Date(Date.parse("2026-07-18T01:00:01.000Z") + index * 2000).toISOString(),
      source_url: drySearch,
      sku: `no-match-${index}`,
      status: "skipped",
      reason: "1688-no-reliable-match",
    },
  ]).flat();

  assert.deepEqual(prioritizeSourceUrls([drySearch, untriedSeller], {
    freshSourceUrls: [drySearch],
    yieldRows: rows,
  }), [untriedSeller, drySearch]);
  assert.deepEqual(orderRowsBySourceYield([
    { source_url: drySearch },
    { source_url: untriedSeller },
  ], rows).map((row) => row.source_url), [untriedSeller, drySearch]);
});

test("a dry search price band cannot demote a productive sibling price band", () => {
  const productive = "https://www.ozon.ru/search/?text=banded-family&is_global=true&currency_price=150.000%3B";
  const dry = "https://www.ozon.ru/search/?text=banded-family&is_global=true&currency_price=1000.000%3B";
  const untriedSeller = "https://www.ozon.ru/seller/untried-after-band/";
  assert.deepEqual(prioritizeSourceUrls([dry, untriedSeller, productive], {
    freshSourceUrls: [productive, dry],
    yieldRows: [
      { at: "2026-07-16T06:00:00.000Z", source_url: productive, sku: "winner", status: "published" },
      ...Array.from({ length: 12 }, (_, index) => ({
        at: new Date(Date.parse("2026-07-16T07:00:00.000Z") + index * 1000).toISOString(),
        source_url: dry,
        sku: `dry-band-${index}`,
        status: "rejected",
      })),
    ],
  }), [productive, untriedSeller, dry]);
});

test("four explicit non-pure outcomes demote only the affected highlight price band", () => {
  const productive = "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?currency_price=150.000%3B";
  const dry = "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?currency_price=500.000%3B";
  const untriedSeller = "https://www.ozon.ru/seller/untried-after-highlight/";
  assert.deepEqual(prioritizeSourceUrls([dry, untriedSeller, productive], {
    freshSourceUrls: [productive, dry],
    yieldRows: [
      { at: "2026-07-16T06:00:00.000Z", source_url: productive, sku: "winner", status: "submitted" },
      ...Array.from({ length: 4 }, (_, index) => ({
        at: new Date(Date.parse("2026-07-16T07:00:00.000Z") + index * 1000).toISOString(),
        source_url: dry,
        sku: `highlight-fbo-${index}`,
        status: "skipped",
        reason: "non-pure-fbs",
      })),
    ],
  }), [productive, untriedSeller, dry]);
});

test("a highlight band below twenty percent recent yield gives way to untried supply", () => {
  const weak = "https://www.ozon.ru/highlight/tovary-so-vsego-mira-155600/?currency_price=500.000%3B";
  const untriedSeller = "https://www.ozon.ru/seller/untried-after-weak-highlight/";
  assert.deepEqual(prioritizeSourceUrls([weak, untriedSeller], {
    freshSourceUrls: [weak],
    yieldRows: Array.from({ length: 8 }, (_, index) => ({
      at: new Date(Date.parse("2026-07-16T07:00:00.000Z") + index * 1000).toISOString(),
      source_url: weak,
      sku: `weak-highlight-${index}`,
      status: index === 7 ? "submitted" : "skipped",
      reason: index === 7 ? undefined : "non-pure-fbs",
    })),
  }), [untriedSeller, weak]);
});

test("source variants use a bounded two-item burst before rotating families", () => {
  const urls = [
    "https://www.ozon.ru/seller/a/",
    "https://www.ozon.ru/seller/a/?sorting=rating",
    "https://www.ozon.ru/seller/b/",
    "https://www.ozon.ru/seller/b/?sorting=rating",
  ];
  assert.deepEqual(prioritizeSourceUrls(urls, {
    highYieldSources: [urls[0], urls[0], urls[0], urls[2], urls[2]],
  }), [urls[0], urls[1], urls[2], urls[3]]);
});

test("source fairness caps and round-robins sources before combining batches", () => {
  const rows = [
    { source_url: "a", links: Array.from({ length: 5 }, (_, index) => ({ href: `a-${index}`, text: "" })) },
    { source_url: "b", links: Array.from({ length: 5 }, (_, index) => ({ href: `b-${index}`, text: "" })) },
  ];
  assert.deepEqual(limitLinksPerSource(rows, 2).map((row) => row.href), ["a-0", "b-0", "a-1", "b-1"]);
});

test("cached fallback uses only unattempted cards with complete exact-FBS evidence", () => {
  const exact = {
    href: "https://www.ozon.ru/product/exact-1001/",
    text: "Детская игрушка погремушка",
    image_url: "https://ir.ozone.ru/exact.jpg",
    card_text: "999 ₽\n发货模式：FBS\n库存",
  };
  const ambiguous = {
    href: "https://www.ozon.ru/product/ambiguous-1002/",
    text: "Детская игрушка",
    image_url: "https://ir.ozone.ru/ambiguous.jpg",
    card_text: "999 ₽\n发货模式：暂无数据",
  };
  const alreadyAttempted = { ...exact, href: "https://www.ozon.ru/product/old-1003/" };
  assert.deepEqual(cachedExactFbsFallbackLinks([
    { source_url: "https://www.ozon.ru/seller/a/", links: [ambiguous, alreadyAttempted] },
    { source_url: "https://www.ozon.ru/seller/b/", links: [exact] },
  ], { attempted: new Set(["1003"]), limit: 12 }).map((row) => row.href), [exact.href]);
});

test("cooldown fallback keeps only CNY cards whose facts can bypass Ozon detail", () => {
  const card = (sku, currency) => ({
    href: `https://www.ozon.ru/product/item-${sku}/`,
    text: `Носки ${sku}`,
    image_url: `https://ir.ozone.ru/${sku}.jpg`,
    card_text: `99 ${currency}\n发货模式：FBS\n库存`,
  });
  assert.deepEqual(cachedExactFbsFallbackLinks([
    { source_url: "https://www.ozon.ru/seller/a/", links: [card("1101", "₽"), card("1102", "¥")] },
  ], { limit: 12, requireReusableFacts: true }).map((row) => row.href), [
    "https://www.ozon.ru/product/item-1102/",
  ]);
});

test("cached fallback filters attempted cards before applying its per-source cap", () => {
  const card = (sku) => ({
    href: `https://www.ozon.ru/product/item-${sku}/`,
    text: `Детская игрушка ${sku}`,
    image_url: `https://ir.ozone.ru/${sku}.jpg`,
    card_text: "999 ₽\n发货模式：FBS\n库存",
  });
  const survivor = card("2003");
  assert.deepEqual(cachedExactFbsFallbackLinks([
    { source_url: "https://www.ozon.ru/seller/a/", links: [card("2001"), card("2002"), survivor] },
  ], { attempted: new Set(["2001", "2002"]), limit: 2 }).map((row) => row.href), [survivor.href]);
});

test("cached fallback prioritizes sources with verified publication yield", () => {
  const card = (sku) => ({
    href: `https://www.ozon.ru/product/item-${sku}/`,
    text: `Аксессуар ${sku}`,
    image_url: `https://ir.ozone.ru/${sku}.jpg`,
    card_text: "999 ₽\n发货模式：FBS\n库存",
  });
  const weak = "https://www.ozon.ru/seller/weak/";
  const strong = "https://www.ozon.ru/seller/strong/";
  assert.deepEqual(cachedExactFbsFallbackLinks([
    { source_url: weak, links: [card("3001")] },
    { source_url: strong, links: [card("3002")] },
  ], {
    limit: 2,
    yieldRows: [
      { source_url: weak, status: "skipped", reason: "non-pure-fbs" },
      { source_url: strong, status: "published" },
    ],
  }).map((row) => row.href), [
    "https://www.ozon.ru/product/item-3002/",
    "https://www.ozon.ru/product/item-3001/",
  ]);
});

test("cached fallback fills a short retained tranche without duplicating its SKU", () => {
  const retained = [{ href: "https://www.ozon.ru/product/retained-1001/" }];
  const fallback = [
    { href: "https://www.ozon.ru/product/duplicate-1001/" },
    { href: "https://www.ozon.ru/product/fallback-1002/" },
    { href: "https://www.ozon.ru/product/overflow-1003/" },
  ];
  assert.deepEqual(fillRetainedFallbackLinks(retained, fallback, 2).map((row) => row.href), [
    retained[0].href,
    fallback[1].href,
  ]);
});

test("one source does not enqueue numeric variants of the same title family", () => {
  const rows = [{
    source_url: "a",
    links: [
      { href: "a-1", text: "Минифигурка рыцарь модель 1" },
      { href: "a-2", text: "Минифигурка рыцарь модель 2" },
      { href: "a-3", text: "Носки для девочек" },
    ],
  }];
  assert.deepEqual(limitLinksPerSource(rows, 3).map((row) => row.href), ["a-3", "a-1"]);
});

test("title dedup retains the variant with plugin-confirmed FBS telemetry", () => {
  const rows = [{
    source_url: "a",
    links: [
      { href: "ambiguous", text: "Бейсболка", card_text: "发货模式：--" },
      { href: "pure-fbs", text: "Бейсболка", card_text: "发货模式：FBS" },
    ],
  }];
  assert.deepEqual(limitLinksPerSource(rows, 2).map((row) => row.href), ["pure-fbs"]);
});

test("title dedup retains the higher-priced pure-FBS variant", () => {
  const rows = [{
    source_url: "a",
    links: [
      { href: "low-price", text: "Бейсболка", card_text: "7,38 ¥\n发货模式：FBS" },
      { href: "viable-price", text: "Бейсболка", card_text: "31,17 ¥\n发货模式：FBS" },
    ],
  }];
  assert.deepEqual(limitLinksPerSource(rows, 2).map((row) => row.href), ["viable-price"]);
});

test("each source round is globally ordered by observed title-family yield", () => {
  const rows = [
    { source_url: "a", links: [{ href: "a-other", text: "Кухонная посуда" }, { href: "a-case", text: "Чехол для телефона" }] },
    { source_url: "b", links: [{ href: "b-underwear", text: "Комплект трусов" }] },
  ];
  assert.deepEqual(limitLinksPerSource(rows, 2).map((row) => row.href), [
    "b-underwear",
    "a-other",
    "a-case",
  ]);
});

test("skip-retained still resumes persisted high-yield sources", () => {
  const successful = "https://www.ozon.ru/seller/winner/?currency_price=50.000%3B";
  const records = [
    { source_url: `${successful}&sorting=rating`, links: [{ href: "winner" }] },
    { source_url: "https://www.ozon.ru/seller/ordinary/", links: [{ href: "ordinary" }] },
  ];
  assert.deepEqual(retainedRowsForCollection(records, {
    skipRetained: true,
    highYieldSources: [successful],
  }).map((row) => row.links[0].href), ["winner"]);
});

test("skip-retained removes a historically successful seller after a recent dry tail", () => {
  const source = "https://www.ozon.ru/seller/stale-retained/";
  const records = [{ source_url: source, links: [{ href: "stale" }] }];
  const yieldRows = [
    { source_url: source, sku: "old-win", status: "published", at: "2026-07-15T00:00:00Z" },
    ...Array.from({ length: 12 }, (_, index) => ({
      source_url: `${source}?page=${index + 2}`,
      sku: `dry-${index}`,
      status: "rejected",
      at: `2026-07-16T00:${String(index).padStart(2, "0")}:00Z`,
    })),
  ];
  assert.deepEqual(retainedRowsForCollection(records, {
    skipRetained: true,
    highYieldSources: [source],
    yieldRows,
  }), []);
});

test("skip-retained removes a seller whose recent preflight yield falls below ten percent", () => {
  const source = "https://www.ozon.ru/seller/weak-retained/";
  const yieldRows = [
    ...Array.from({ length: 8 }, (_, index) => ({
      source_url: source,
      sku: `old-win-${index}`,
      status: "published",
      at: `2026-07-15T00:${String(index).padStart(2, "0")}:00Z`,
    })),
    { source_url: source, sku: "recent-one", status: "favorited", at: "2026-07-16T00:00:00Z" },
    ...Array.from({ length: 11 }, (_, index) => ({
      source_url: `${source}?page=2`,
      sku: `recent-reject-${index}`,
      status: "rejected",
      at: `2026-07-16T00:${String(index + 1).padStart(2, "0")}:00Z`,
    })),
  ];
  assert.deepEqual(retainedRowsForCollection([{ source_url: source, links: [{ href: "weak" }] }], {
    skipRetained: true,
    highYieldSources: [source],
    yieldRows,
  }), []);
});

test("retained high-yield matching keeps successful and rejected price bands separate", () => {
  const fifty = "https://www.ozon.ru/seller/winner/?currency_price=50.000%3B";
  const fiveHundred = "https://www.ozon.ru/seller/winner/?currency_price=500.000%3B";
  const records = [
    { source_url: `${fifty}&sorting=rating`, links: [{ href: "winner-50" }] },
    { source_url: `${fiveHundred}&sorting=rating`, links: [{ href: "winner-500" }] },
  ];
  assert.deepEqual(retainedRowsForCollection(records, {
    skipRetained: true,
    highYieldSources: [fifty],
  }).map((row) => row.links[0].href), ["winner-50"]);
});

test("retained yield ordering does not let a rejected high price band borrow another band's success", () => {
  const fifty = { source_url: "https://www.ozon.ru/seller/example/?currency_price=50.000%3B" };
  const fiveHundred = { source_url: "https://www.ozon.ru/seller/example/?currency_price=500.000%3B" };
  const yieldRows = [
    { source_url: fifty.source_url, sku: "good", status: "published" },
    ...Array.from({ length: 8 }, (_, index) => ({ source_url: fiveHundred.source_url, sku: `bad-${index}`, status: "rejected" })),
  ];
  assert.deepEqual(orderRowsBySourceYield([fiveHundred, fifty], yieldRows), [fifty, fiveHundred]);
});

test("retained source rows prefer observed publications over file order", () => {
  const rows = [
    { source_url: "https://www.ozon.ru/seller/dry/?sorting=rating" },
    { source_url: "https://www.ozon.ru/seller/winner/?currency_price=500.000%3B" },
  ];
  const yieldRows = [
    { source_url: "https://www.ozon.ru/seller/dry/", status: "skipped" },
    { source_url: "https://www.ozon.ru/seller/winner/?sorting=price", status: "published" },
    { source_url: "https://www.ozon.ru/seller/winner/?sorting=discount", status: "published" },
  ];
  assert.deepEqual(orderRowsBySourceYield(rows, yieldRows).map((row) => row.source_url), [
    rows[1].source_url,
    rows[0].source_url,
  ]);
});

test("retained source rows also use verified pure-FBS collection evidence", () => {
  const rows = [
    { source_url: "https://www.ozon.ru/seller/unknown/" },
    { source_url: "https://www.ozon.ru/seller/fbs-winner/" },
  ];
  assert.deepEqual(orderRowsBySourceYield(rows, [
    { source_url: rows[1].source_url, status: "favorited" },
  ]).map((row) => row.source_url), [rows[1].source_url, rows[0].source_url]);
});

test("final publications outweigh FBS-only source evidence", () => {
  const published = { source_url: "https://www.ozon.ru/seller/final-winner/" };
  const fbsOnly = { source_url: "https://www.ozon.ru/seller/fbs-only/" };
  assert.deepEqual(orderRowsBySourceYield([fbsOnly, published], [
    ...Array.from({ length: 5 }, () => ({ source_url: fbsOnly.source_url, status: "favorited" })),
    { source_url: published.source_url, status: "published" },
  ]).map((row) => row.source_url), [published.source_url, fbsOnly.source_url]);
});

test("strict submitted source evidence is useful but ranks below final publications", () => {
  const fbsOnly = { source_url: "https://www.ozon.ru/seller/fbs-only/" };
  const submitted = { source_url: "https://www.ozon.ru/seller/submitted/" };
  const published = { source_url: "https://www.ozon.ru/seller/published/" };
  assert.deepEqual(orderRowsBySourceYield([fbsOnly, submitted, published], [
    ...Array.from({ length: 5 }, (_, index) => ({ source_url: fbsOnly.source_url, sku: `fbs-${index}`, status: "favorited" })),
    { source_url: submitted.source_url, sku: "submitted-1", status: "submitted" },
    { source_url: published.source_url, sku: "published-1", status: "published" },
  ]).map((row) => row.source_url), [published.source_url, submitted.source_url, fbsOnly.source_url]);
});

test("equal-yield retained variants prefer the higher price floor", () => {
  const low = { source_url: "https://www.ozon.ru/seller/example/?currency_price=50.000%3B" };
  const high = { source_url: "https://www.ozon.ru/seller/example/?currency_price=500.000%3B" };
  assert.deepEqual(orderRowsBySourceYield([low, high], []).map((row) => row.source_url), [high.source_url, low.source_url]);
});

test("retained collection yields to the producer loop for fresh source feedback", () => {
  assert.equal(shouldYieldAfterRetained({ retainedLinks: 60, retainedAttempted: 60, pendingSources: 400 }), true);
  assert.equal(shouldYieldAfterRetained({ retainedLinks: 3, retainedAttempted: 0, pendingSources: 400 }), false);
  assert.equal(shouldYieldAfterRetained({ retainedLinks: 0, retainedAttempted: 0, pendingSources: 400 }), false);
});

test("retained replay uses a small bounded tranche by default", () => {
  assert.equal(retainedReplayLimit({}), 12);
  assert.equal(retainedReplayLimit({ FLOW_B_MAX_RETAINED_LINKS: "6" }), 6);
  assert.equal(retainedReplayLimit({ FLOW_B_MAX_RETAINED_LINKS: "0" }), 0);
});

test("proven seller source recognition is explicit", () => {
  assert.equal(isProvenSellerSource("https://www.ozon.ru/seller/xiangyu01/?currency_price=150"), true);
  assert.equal(isProvenSellerSource("https://www.ozon.ru/seller/dm/?currency_price=150"), false);
});

test("favorite session rejects stale tokens and login-page state", () => {
  assert.equal(isFavoriteSessionAuthenticated({ hasToken: true, httpOk: true, code: 1, pageText: "收藏商品" }), true);
  assert.equal(isFavoriteSessionAuthenticated({ hasToken: true, httpOk: false, code: 0, pageText: "收藏商品" }), false);
  assert.equal(isFavoriteSessionAuthenticated({ hasToken: true, httpOk: true, code: 1, pageText: "手机号 登录 验证码" }), false);
  assert.equal(isFavoriteSessionAuthenticated({ hasToken: false, httpOk: true, code: 1, pageText: "收藏商品" }), false);
});

test("explicitly disabling Maozi autofavorite preserves unauthenticated scan mode", () => {
  assert.equal(requiresFavoriteSession({ FLOW_B_MAOZI_AUTOFAVORITE: "0" }), false);
  assert.equal(requiresFavoriteSession({}), true);
});

test("Ozon detail metadata becomes a complete Maozi favorite payload", () => {
  assert.deepEqual(parseFavoriteProductSnapshot({
    url: "https://www.ozon.ru/product/light-pan-1467551655/?from=seller",
    title: "Light pan купить на OZON (1467551655)",
    ogTitle: "Light pan ",
    ogImage: "https://ir.ozone.ru/image.jpg",
    priceText: "151,10\u2009¥\nС банками\n158,97\u2009¥",
    sellerUrl: "https://www.ozon.ru/seller/light-store/?miniapp=1",
  }), {
    sku: "1467551655",
    coverImage: "https://ir.ozone.ru/image.jpg",
    price_info: { sell_price: 151.1, currency: "CNY" },
    title: "Light pan",
    seller_url: "https://www.ozon.ru/seller/light-store/",
  });
});

test("verified FBS seller feedback becomes a unique next-round source", () => {
  const rows = [
    { status: "favorited", seller_url: "https://www.ozon.ru/seller/b/?miniapp=1" },
    { status: "published", sku: "a-1", seller_url: "https://www.ozon.ru/seller/a/" },
    { status: "published", sku: "a-2", seller_url: "https://www.ozon.ru/seller/a/?miniapp=1" },
    { status: "published", sku: "b-1", seller_url: "https://www.ozon.ru/seller/b/" },
    { status: "published", sku: "d-1", source_url: "https://www.ozon.ru/seller/d/?currency_price=50.000%3B" },
    { status: "published", sku: "d-2", source_url: "https://www.ozon.ru/seller/d/" },
    { status: "favorited", sku: "e-1", seller_url: "https://www.ozon.ru/seller/e/?miniapp=1" },
    { status: "published", sku: "e-1", source_url: "https://www.ozon.ru/search/?text=e" },
    { status: "rejected", seller_url: "https://www.ozon.ru/seller/c/" },
  ];
  assert.deepEqual(verifiedSellerSourceUrls(rows), ["https://www.ozon.ru/seller/a/", "https://www.ozon.ru/seller/d/"]);
  assert.deepEqual(verifiedSellerSourceUrls(rows, 1), [
    "https://www.ozon.ru/seller/a/",
    "https://www.ozon.ru/seller/b/",
    "https://www.ozon.ru/seller/d/",
    "https://www.ozon.ru/seller/e/",
  ]);
});

test("repeated submitted seller feedback becomes bounded exploration only", () => {
  const rows = [
    { status: "favorited", sku: "a-1", seller_url: "https://www.ozon.ru/seller/a/?miniapp=1" },
    { status: "submitted", sku: "a-1", source_url: "https://www.ozon.ru/search/?text=a" },
    { status: "submitted", sku: "a-2", seller_url: "https://www.ozon.ru/seller/a/" },
    { status: "submitted", sku: "b-1", seller_url: "https://www.ozon.ru/seller/b/" },
    { status: "published", sku: "c-1", seller_url: "https://www.ozon.ru/seller/c/" },
    { status: "published", sku: "c-2", seller_url: "https://www.ozon.ru/seller/c/" },
  ];
  assert.deepEqual(repeatedSubmittedSellerSourceUrls(rows), ["https://www.ozon.ru/seller/a/"]);
  const variants = repeatedSubmittedSellerSourceVariants(rows);
  assert.equal(variants.length, 21);
  assert.equal(variants[0], "https://www.ozon.ru/seller/a/");
  assert.ok(variants.some((url) => url.includes("currency_price=500.000%3B") && url.includes("sorting=rating")));
  assert.ok(variants.some((url) => url.includes("currency_price=500.000%3B")
    && url.includes("sorting=rating")
    && url.includes("page=3")));
  assert.deepEqual(verifiedSellerSourceUrls(rows), ["https://www.ozon.ru/seller/c/"]);
});

test("repeated strict-success sellers explore only one page beyond their deepest strict result", () => {
  const rows = [
    { status: "published", sku: "a-1", seller_url: "https://www.ozon.ru/seller/a/", source_url: "https://www.ozon.ru/seller/a/?page=5" },
    { status: "published", sku: "a-2", seller_url: "https://www.ozon.ru/seller/a/?miniapp=1" },
    { status: "published", sku: "b-1", seller_url: "https://www.ozon.ru/seller/b/" },
    { status: "published", sku: "b-2", seller_url: "https://www.ozon.ru/seller/b/" },
    { status: "published", sku: "c-1", seller_url: "https://www.ozon.ru/seller/c/", source_url: "https://www.ozon.ru/seller/c/?page=3" },
    { status: "published", sku: "c-2", seller_url: "https://www.ozon.ru/seller/c/" },
  ];
  const variants = deepVerifiedSellerSourceVariants(rows);
  assert.equal(variants.length, 75);
  assert.ok(variants.some((url) => url.includes("currency_price=500.000%3B")
    && url.includes("sorting=discount")
    && url.includes("page=6")));
  assert.ok(variants.some((url) => url.includes("/seller/b/") && url.includes("page=3")));
  assert.ok(variants.every((url) => !url.includes("/seller/b/") || Number(new URL(url).searchParams.get("page") || 1) <= 3));
  assert.ok(variants.some((url) => url.includes("/seller/c/") && url.includes("page=4")));
  assert.ok(variants.every((url) => !url.includes("/seller/c/") || Number(new URL(url).searchParams.get("page") || 1) <= 4));
  assert.ok(variants.every((url) => {
    const parsed = new URL(url);
    return Number(parsed.searchParams.get("page") || 1) < 4
      || !parsed.searchParams.has("currency_price")
      || parsed.searchParams.get("currency_price") === "500.000;";
  }));
  assert.ok(variants.every((url) => Number(new URL(url).searchParams.get("page") || 1) <= 6));
});

test("deep verified sellers can advance beyond page six while staying one page ahead", () => {
  const rows = [
    { status: "published", sku: "deep-1", seller_url: "https://www.ozon.ru/seller/deep/", source_url: "https://www.ozon.ru/seller/deep/?page=6" },
    { status: "published", sku: "deep-2", seller_url: "https://www.ozon.ru/seller/deep/", source_url: "https://www.ozon.ru/seller/deep/?page=5" },
  ];
  const variants = deepVerifiedSellerSourceVariants(rows, 2, 20, [7, 8, 9, 10]);
  assert.ok(variants.some((url) => Number(new URL(url).searchParams.get("page") || 1) === 7));
  assert.ok(variants.every((url) => Number(new URL(url).searchParams.get("page") || 1) <= 7));
  assert.ok(variants.every((url) => {
    const parsed = new URL(url);
    return Number(parsed.searchParams.get("page") || 1) < 4
      || !parsed.searchParams.has("currency_price")
      || parsed.searchParams.get("currency_price") === "500.000;";
  }));
});

test("deep verified exploration keeps the full bounded pool of proven sellers", () => {
  const rows = [];
  for (let index = 1; index <= 21; index += 1) {
    rows.push(
      { status: "published", sku: `seller-${index}-a`, seller_url: `https://www.ozon.ru/seller/seller-${index}/` },
      { status: "published", sku: `seller-${index}-b`, seller_url: `https://www.ozon.ru/seller/seller-${index}/` },
    );
  }
  const variants = deepVerifiedSellerSourceVariants(rows);
  assert.ok(variants.some((url) => url.includes("/seller/seller-1/")));
  assert.ok(variants.some((url) => url.includes("/seller/seller-21/")));
});

test("favorite preflight accepts only an explicit pure FBS mode", () => {
  assert.equal(favoriteModeSkipReason("FBS"), null);
  assert.equal(favoriteModeSkipReason("FBS, RFBS"), "non-pure-fbs");
  assert.equal(favoriteModeSkipReason(null), "missing-shipping-mode");
});

test("listing cards reject only explicit non-pure modes before opening product details", () => {
  assert.equal(listingModeSkipReason("商品\n发货模式：FBS\n库存"), null);
  assert.equal(listingModeSkipReason("商品\n发货模式：FBO\n库存"), "non-pure-fbs");
  assert.equal(listingModeSkipReason("商品\n发货模式：FBO,FBS\n库存"), "non-pure-fbs");
  assert.equal(listingModeSkipReason("商品\n发货模式：暂无数据\n库存"), null);
  assert.equal(listingModeSkipReason("商品\n发货模式：--\n库存"), null);
  assert.equal(listingModeSkipReason("card without plugin telemetry"), null);
});

test("a complete exact-FBS listing card becomes a cheap favorite snapshot", () => {
  assert.deepEqual(parseListingFavoriteSnapshot({
    href: "https://www.ozon.ru/product/sample-3423207591/",
    text: "Детский набор аксессуаров",
    image_url: "https://ir.ozone.ru/s3/image.jpg",
    source_url: "https://www.ozon.ru/seller/miaowu/?page=2",
    card_text: "1099 ₽\nДетский набор аксессуаров\n发货模式：FBS\n库存",
  }), {
    sku: "3423207591",
    coverImage: "https://ir.ozone.ru/s3/image.jpg",
    price_info: { sell_price: 1099, currency: "RUB" },
    title: "Детский набор аксессуаров",
    seller_url: "https://www.ozon.ru/seller/miaowu/",
  });
  assert.equal(parseListingFavoriteSnapshot({
    href: "https://www.ozon.ru/product/sample-1/",
    text: "Unknown",
    image_url: "https://ir.ozone.ru/s3/image.jpg",
    card_text: "100 ₽\n发货模式：暂无数据",
  }), null);
});

test("production collection can require a detail recheck instead of trusting listing FBS telemetry", () => {
  const link = {
    href: "https://www.ozon.ru/product/sample-3423207591/",
    text: "Детский набор аксессуаров",
    image_url: "https://ir.ozone.ru/s3/image.jpg",
    source_url: "https://www.ozon.ru/seller/miaowu/",
    card_text: "1099 ₽\n发货模式：FBS\n库存",
  };
  assert.equal(reusableListingFavoriteSnapshot(link, { verifyDetail: true }), null);
  assert.equal(reusableListingFavoriteSnapshot(link, { verifyDetail: false })?.sku, "3423207591");
});

test("source scan checkpoints discard attempted links while retaining scan completion evidence", () => {
  const rows = [{
    source_url: "https://www.ozon.ru/seller/sample/",
    stop_reason: "link_target_reached",
    cumulative_product_link_count: 48,
    links: [
      { href: "https://www.ozon.ru/product/old-101/", card_text: "large" },
      { href: "https://www.ozon.ru/product/new-102/", card_text: "small" },
    ],
  }];
  assert.deepEqual(pruneAttemptedSourceLinks(rows, new Set(["101"])), [{
    ...rows[0],
    links: [{ ...rows[0].links[1], card_text: "" }],
  }]);
});

test("source checkpoints retain only shipping, price, and Global card evidence", () => {
  const verbose = [
    "月销量：8",
    "Доставка из Китая",
    "999 ₽",
    "发货模式：FBS",
    "库存：1000",
    "退货取消率：1.2%",
  ].join("\n");
  assert.equal(compactListingCardText(verbose), "Доставка из Китая\n999 ₽\n发货模式：FBS");
  const compacted = compactListingCardText(verbose);
  assert.equal(listingModeSkipReason(compacted), null);
  assert.equal(parseListingFavoriteSnapshot({
    href: "https://www.ozon.ru/product/sample-3423207591/",
    text: "Детский набор аксессуаров",
    image_url: "https://ir.ozone.ru/s3/image.jpg",
    card_text: compacted,
  })?.price_info?.sell_price, 999);
});

test("missing shipping mode is a deterministic rejection, not an infinite retry", () => {
  assert.deepEqual(favoriteFailureDisposition(new Error("missing-shipping-mode: SKU 42")), {
    status: "rejected",
    reason: "missing-shipping-mode",
  });
  assert.deepEqual(favoriteFailureDisposition(new Error("Ozon detail soft blocked")), {
    status: "failed",
    reason: null,
  });
});

test("collection rechecks RUB rows in detail and rejects only explicit expensive CNY rows", () => {
  assert.equal(favoritePriceSkipReason({ price_info: { currency: "CNY", sell_price: 88 } }, 1000), null);
  assert.equal(favoritePriceSkipReason({ price_info: { currency: "RUB", sell_price: 19114 } }, 1000), null);
  assert.equal(favoritePriceSkipReason({ price_info: { sell_price: 19114 } }, 1000), null);
  assert.equal(favoritePriceSkipReason({ price_info: { currency: "CNY", sell_price: 1200 } }, 1000), "source-price-above-limit");
});

test("favorite payload parser rejects incomplete Ozon details", () => {
  assert.throws(() => parseFavoriteProductSnapshot({
    url: "https://www.ozon.ru/product/1467551655/",
    title: "Missing image",
    priceText: "100 ₽",
  }), /cover image/i);
});

test("favorite workers reserve capacity without exceeding the target", () => {
  assert.equal(canClaimFavorite({ total: 4, inFlight: 0, target: 5 }), true);
  assert.equal(canClaimFavorite({ total: 4, inFlight: 1, target: 5 }), false);
  assert.equal(canClaimFavorite({ total: 5, inFlight: 0, target: 5 }), false);
});

test("Maozi rate limits and transient network failures use bounded backoff", () => {
  assert.equal(favoriteRetryDelay(new Error("HTTP 429"), 0), 15_000);
  assert.equal(favoriteRetryDelay(new Error("HTTP 429"), 3), 60_000);
  assert.equal(favoriteRetryDelay(new Error("Failed to fetch"), 0), 2_000);
  assert.equal(favoriteRetryDelay(new Error("validation failed"), 0), null);
});

test("Maozi page fetch telemetry survives a short browser network outage", async () => {
  let calls = 0;
  const delays = [];
  const result = await retryMaoziPageFetch(async () => {
    calls += 1;
    if (calls < 3) throw new Error("Failed to fetch");
    return { total: 17 };
  }, {
    attempts: 4,
    sleep: async (ms) => delays.push(ms),
  });
  assert.deepEqual(result, { total: 17 });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [2_000, 4_000]);
});

test("detail gate rechecks a cooldown deadline extended while waiting", async () => {
  let now = 0;
  let deadline = 10;
  const waits = [];
  await waitForMovingDeadline({
    getDeadline: () => deadline,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
      if (waits.length === 1) deadline = 25;
    },
  });
  assert.deepEqual(waits, [10, 15]);
});

test("Ozon no-connection incident pages are retried with a longer cooldown", () => {
  assert.equal(isOzonSoftBlock("Похоже, нет соединения Выключите VPN"), true);
  assert.equal(isOzonSoftBlock("ordinary product page"), false);
  assert.equal(ozonRetryDelay(0), 600_000);
  assert.equal(ozonRetryDelay(2), 1_800_000);
  assert.deepEqual(ozonDetailFailurePolicy(new Error("Ozon detail soft blocked"), 0, 0), {
    softBlocked: true,
    retry: false,
    delay: 600_000,
  });
  assert.deepEqual(ozonDetailFailurePolicy(new Error("page.goto: net::ERR_FAILED at https://www.ozon.ru/product/42"), 0, 0), {
    softBlocked: true,
    retry: false,
    delay: 600_000,
  });
  assert.deepEqual(ozonDetailFailurePolicy(new Error("Ozon detail is blocked: https://www.ozon.ru/product/42"), 0, 0), {
    softBlocked: true,
    retry: false,
    delay: 600_000,
  });
});

test("concurrent pages coalesce one Ozon incident instead of escalating to 180 seconds", () => {
  const first = softBlockCooldownState({ streak: 0, lastBlockedAt: 0, now: 100_000 });
  const concurrent = softBlockCooldownState({ streak: first.streak, lastBlockedAt: first.lastBlockedAt, now: 102_000 });
  const laterIncident = softBlockCooldownState({ streak: concurrent.streak, lastBlockedAt: concurrent.lastBlockedAt, now: 165_000 });
  assert.deepEqual(first, { streak: 1, lastBlockedAt: 100_000, delay: 600_000 });
  assert.deepEqual(concurrent, { streak: 1, lastBlockedAt: 102_000, delay: 600_000 });
  assert.deepEqual(laterIncident, { streak: 2, lastBlockedAt: 165_000, delay: 900_000 });
  assert.equal(ozonRetryDelay(3), 1_800_000);
});

test("collection detail cooldown probes before using the ten-minute safety ceiling", () => {
  const first = collectionDetailCooldownState({ streak: 0, lastBlockedAt: 0, now: 100_000 });
  const concurrent = collectionDetailCooldownState({ streak: first.streak, lastBlockedAt: first.lastBlockedAt, now: 102_000 });
  const laterIncident = collectionDetailCooldownState({ streak: concurrent.streak, lastBlockedAt: concurrent.lastBlockedAt, now: 165_000 });
  const persistentIncident = collectionDetailCooldownState({ streak: laterIncident.streak, lastBlockedAt: laterIncident.lastBlockedAt, now: 400_000 });
  assert.deepEqual(first, { streak: 1, lastBlockedAt: 100_000, delay: 60_000 });
  assert.deepEqual(concurrent, { streak: 1, lastBlockedAt: 102_000, delay: 60_000 });
  assert.deepEqual(laterIncident, { streak: 2, lastBlockedAt: 165_000, delay: 180_000 });
  assert.deepEqual(persistentIncident, { streak: 3, lastBlockedAt: 400_000, delay: 600_000 });
});

test("collection soft blocks quarantine only the affected source price band", () => {
  const pageTwo = "https://www.ozon.ru/seller/example/?currency_price=500.000%3B&page=2";
  const pageThree = "https://www.ozon.ru/seller/example/?currency_price=500.000%3B&page=3";
  const siblingBand = "https://www.ozon.ru/seller/example/?currency_price=150.000%3B&page=2";
  assert.equal(sourceCollectionBlockKey(pageTwo), sourceCollectionBlockKey(pageThree));
  assert.notEqual(sourceCollectionBlockKey(pageTwo), sourceCollectionBlockKey(siblingBand));
});

test("blocked source batches probe with short backoff before escalating", () => {
  const state = { sourceSoftBlockStreak: 0, lastSourceSoftBlockAt: 0, detailBlockedUntil: 0 };
  const rows = [
    { blocked: true, stop_reason: "blocked_or_empty" },
    { blocked: true, stop_reason: "blocked_or_empty" },
    { blocked: true, stop_reason: "blocked_or_empty" },
  ];
  const result = sourceBatchCooldownState(rows, state, 10_000);
  assert.equal(result.blocked, true);
  assert.equal(result.delay, 60_000);
  assert.equal(state.sourceSoftBlockStreak, 1);
  assert.equal(state.detailBlockedUntil, 70_000);
  const repeated = sourceBatchCooldownState(rows, state, 80_000);
  assert.equal(repeated.delay, 180_000);
  assert.equal(state.sourceSoftBlockStreak, 2);
  assert.equal(state.detailBlockedUntil, 260_000);
  sourceBatchCooldownState([{ blocked: false, stop_reason: "max_steps" }], state, 270_000);
  assert.equal(state.sourceSoftBlockStreak, 0);
});

test("a first source-page block cannot escalate an existing detail streak to ten minutes", () => {
  const state = {
    detailSoftBlockStreak: 2,
    lastDetailSoftBlockAt: 79_000,
    sourceSoftBlockStreak: 0,
    lastSourceSoftBlockAt: 0,
    detailBlockedUntil: 260_000,
  };
  const result = sourceBatchCooldownState([
    { blocked: true, stop_reason: "blocked_or_empty" },
    { blocked: true, stop_reason: "blocked_or_empty" },
    { blocked: true, stop_reason: "blocked_or_empty" },
  ], state, 80_000);
  assert.equal(result.delay, 60_000);
  assert.equal(state.detailSoftBlockStreak, 2);
  assert.equal(state.sourceSoftBlockStreak, 1);
  assert.equal(state.detailBlockedUntil, 260_000);
});

test("one isolated blocked source only lowers concurrency without pausing the producer", () => {
  const state = { sourceSoftBlockStreak: 0, lastSourceSoftBlockAt: 0, detailBlockedUntil: 0 };
  const result = sourceBatchCooldownState([
    { blocked: true, stop_reason: "blocked_or_empty" },
    { blocked: false, stop_reason: "max_steps" },
    { blocked: false, stop_reason: "stable_bottom" },
    { blocked: false, stop_reason: "max_steps" },
    { blocked: false, stop_reason: "stable_bottom" },
  ], state, 10_000);
  assert.deepEqual(result, { blocked: false, delay: 0 });
  assert.equal(state.sourceSoftBlockStreak, 0);
  assert.equal(state.detailBlockedUntil, 0);
});

test("collection pacing and cooldown state persists across producer tranches", () => {
  const key = `run-${Date.now()}-${Math.random()}`;
  const first = collectionRuntimeState(key);
  first.detailSoftBlockStreak = 3;
  first.detailBlockedUntil = 12345;
  const resumed = collectionRuntimeState(key);
  assert.equal(resumed, first);
  assert.equal(resumed.detailSoftBlockStreak, 3);
  assert.equal(resumed.detailBlockedUntil, 12345);
  assert.notEqual(collectionRuntimeState(`${key}-other`), first);
});

test("collection pacing and cooldown state survives a supervised process restart", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-pacing-"));
  const filename = path.join(directory, "collection_pacing.json");
  const now = Date.parse("2026-07-17T05:30:00.000Z");
  await persistCollectionRuntimeState(filename, {
    detailIntervalMs: 5000,
    detailStableSuccesses: 2,
    detailSoftBlockStreak: 3,
    lastDetailSoftBlockAt: now - 1000,
    sourceSoftBlockStreak: 2,
    lastSourceSoftBlockAt: now - 2000,
    detailBlockedUntil: now + 60_000,
    nextApiAt: now + 99_000,
  });
  const restored = await restoreCollectionRuntimeState(`restart-${Math.random()}`, filename, {
    now,
    minIntervalMs: 2000,
    maxIntervalMs: 6000,
  });
  assert.deepEqual({
    detailIntervalMs: restored.detailIntervalMs,
    detailStableSuccesses: restored.detailStableSuccesses,
    detailSoftBlockStreak: restored.detailSoftBlockStreak,
    lastDetailSoftBlockAt: restored.lastDetailSoftBlockAt,
    sourceSoftBlockStreak: restored.sourceSoftBlockStreak,
    lastSourceSoftBlockAt: restored.lastSourceSoftBlockAt,
    detailBlockedUntil: restored.detailBlockedUntil,
    nextApiAt: restored.nextApiAt,
  }, {
    detailIntervalMs: 5000,
    detailStableSuccesses: 2,
    detailSoftBlockStreak: 3,
    lastDetailSoftBlockAt: now - 1000,
    sourceSoftBlockStreak: 2,
    lastSourceSoftBlockAt: now - 2000,
    detailBlockedUntil: now + 60_000,
    nextApiAt: 0,
  });
});

test("source adaptive concurrency keeps stable progress across producer tranches", () => {
  const key = `adaptive-${Date.now()}-${Math.random()}`;
  const first = sourceAdaptiveConcurrency(key, { initial: 3, max: 6, stableWindow: 2 });
  first.recordSuccess();
  first.recordSuccess();
  assert.equal(first.current, 4);
  const resumed = sourceAdaptiveConcurrency(key, { initial: 3, max: 6, stableWindow: 2 });
  assert.equal(resumed, first);
  assert.equal(resumed.current, 4);
});

test("source adaptive ramp window is configurable but never below one", () => {
  assert.equal(sourceAdaptiveStableWindow({}), 12);
  assert.equal(sourceAdaptiveStableWindow({ FLOW_B_SOURCE_STABLE_WINDOW: "6" }), 6);
  assert.equal(sourceAdaptiveStableWindow({ FLOW_B_SOURCE_STABLE_WINDOW: "0" }), 1);
});

test("detail pacing ramps down after stability and above baseline after repeated soft blocks", () => {
  const options = {
    baseIntervalMs: 3000,
    minIntervalMs: 2000,
    maxIntervalMs: 6000,
    stepMs: 500,
    softBlockStepMs: 1000,
    stableWindow: 3,
  };
  let state = { intervalMs: 3000, stableSuccesses: 0 };
  state = nextDetailPacingState({ ...state, ...options, event: "success" });
  state = nextDetailPacingState({ ...state, ...options, event: "success" });
  assert.deepEqual(state, { intervalMs: 3000, stableSuccesses: 2 });
  state = nextDetailPacingState({ ...state, ...options, event: "success" });
  assert.deepEqual(state, { intervalMs: 2500, stableSuccesses: 0 });
  for (let index = 0; index < 3; index += 1) {
    state = nextDetailPacingState({ ...state, ...options, event: "success" });
  }
  assert.deepEqual(state, { intervalMs: 2000, stableSuccesses: 0 });
  state = nextDetailPacingState({ ...state, ...options, event: "soft-block" });
  assert.deepEqual(state, { intervalMs: 4000, stableSuccesses: 0 });
  state = nextDetailPacingState({ ...state, ...options, event: "soft-block" });
  assert.deepEqual(state, { intervalMs: 5000, stableSuccesses: 0 });
  for (let index = 0; index < 3; index += 1) {
    state = nextDetailPacingState({ ...state, ...options, event: "success" });
  }
  assert.deepEqual(state, { intervalMs: 4500, stableSuccesses: 0 });
});

test("production detail pacing does not ramp below its baseline unless explicitly configured", () => {
  assert.deepEqual(favoriteDetailPacingOptions({
    FLOW_B_FAVORITE_DETAIL_INTERVAL_MS: "3000",
    FLOW_B_MAX_FAVORITE_DETAIL_INTERVAL_MS: "6000",
  }), {
    baseIntervalMs: 3000,
    minIntervalMs: 3000,
    maxIntervalMs: 6000,
    stepMs: 500,
    softBlockStepMs: 1000,
    stableWindow: 12,
  });
  assert.equal(favoriteDetailPacingOptions({
    FLOW_B_FAVORITE_DETAIL_INTERVAL_MS: "3000",
    FLOW_B_MIN_FAVORITE_DETAIL_INTERVAL_MS: "2500",
  }).minIntervalMs, 2500);
});

test("source batches replace the fixed ten-second idle with bounded adaptive pacing", () => {
  assert.equal(sourceAfterScanWaitMs({}, { detailIntervalMs: 3000 }, 60_000), 6000);
  assert.equal(sourceAfterScanWaitMs({}, { detailIntervalMs: 4000 }, 60_000), 8000);
  assert.equal(sourceAfterScanWaitMs({}, { detailIntervalMs: 5000 }, 60_000), 10_000);
  assert.equal(sourceAfterScanWaitMs({ FLOW_B_MAOZI_AFTER_SCAN_WAIT: "2" }, { detailIntervalMs: 5000 }, 60_000), 2000);
  assert.equal(sourceAfterScanWaitMs({}, { detailIntervalMs: 3000 }, 2500), 2500);
});

test("favorite collection prioritizes observed profitable title families stably", () => {
  const links = [
    { href: "ordinary", text: "Большая картина" },
    { href: "proven-seller", text: "Обычный товар", source_url: "https://www.ozon.ru/seller/xiangyu01/" },
    { href: "toy", text: "Детская игрушка" },
    { href: "underwear", text: "Комплект трусов" },
    { href: "hat", text: "Панама шляпа для девочек" },
    { href: "strap", text: "Ремешок для часов" },
    { href: "ordinary-2", text: "Кухонная посуда" },
  ];
  assert.deepEqual(prioritizeFavoriteLinks(links).map((link) => link.href), [
    "proven-seller",
    "underwear",
    "hat",
    "ordinary",
    "ordinary-2",
    "strap",
    "toy",
  ]);
});

test("listing cards with explicit cross-border delivery outrank ambiguous titles", () => {
  const links = [
    { href: "underwear", text: "Комплект трусов", card_text: "Доставка завтра" },
    { href: "global", text: "Обычный товар", card_text: "Доставка из Китая" },
  ];
  assert.deepEqual(prioritizeFavoriteLinks(links).map((link) => link.href), ["global", "underwear"]);
});

test("listing plugin pure-FBS telemetry receives first detail-page quota", () => {
  const links = [
    { href: "proven", text: "Обычный товар", source_url: "https://www.ozon.ru/seller/xiangyu01/", card_text: "发货模式：--" },
    { href: "underwear", text: "Комплект трусов", card_text: "发货模式：rFBS" },
    { href: "pure-fbs", text: "Обычный товар", card_text: "月销量：8\n发货模式：FBS\n退货取消率：1.2%" },
  ];
  assert.deepEqual(prioritizeFavoriteLinks(links).map((link) => link.href), ["pure-fbs", "proven", "underwear"]);
});

test("title family priority follows observed strict-publication conversion", () => {
  assert.equal(productTitleFamily("Трансформер Оптимус из игры PVZ"), "pvz_transformer");
  assert.equal(productTitleFamily("Плюшевая игрушка Sprunki"), "plush");
  assert.equal(productTitleFamily("Фигурка героя"), "figure");
  assert.equal(productTitleFamily("Летняя кепка для кошек"), "pet");
  assert.equal(productTitleFamily("Детский игровой столик для игр с водой"), "bulky_kids");
  assert.equal(productTitleFamily("Сквиш лапка антистресс"), "squish");
  assert.ok(productTitlePriority("Носки для девочек") > productTitlePriority("Плюшевая игрушка Sprunki"));
  assert.ok(productTitlePriority("Большая картина") > productTitlePriority("Фигурка героя"));
  assert.ok(productTitlePriority("Плюшевая игрушка Sprunki") > productTitlePriority("Браслет с кулоном"));
  assert.ok(productTitlePriority("Плюшевая игрушка Sprunki") > productTitlePriority("Летняя кепка для кошек"));
  assert.ok(productTitlePriority("Большая картина") > productTitlePriority("Детский игровой столик для игр с водой"));
  assert.ok(productTitlePriority("Сквиш лапка антистресс") > productTitlePriority("Большая картина"));
});

test("strict squish conversion promotes squish listings without borrowing broad other-family yield", () => {
  const scores = observedTitleFamilyScores([
    { sku: "squish-1", status: "published", title: "Сквиш лапка антистресс" },
    { sku: "squish-2", status: "published", title: "Сквиш Стич коллекционный" },
    { sku: "other-1", status: "skipped", title: "Форма для котлет" },
  ]);
  assert.ok(scores.squish > scores.other);
  assert.deepEqual(prioritizeFavoriteLinks([
    { href: "ordinary", text: "Обычный товар для дома" },
    { href: "squish", text: "Сквиш лапка антистресс" },
  ], scores).map((link) => link.href), ["squish", "ordinary"]);
});

test("recent strict publications promote productive title families ahead of static guesses", () => {
  const scores = observedTitleFamilyScores([
    { sku: "toy-1", status: "published", title_family: "toy" },
    { sku: "toy-2", status: "published", title_family: "toy" },
    { sku: "socks-1", status: "skipped", title_family: "socks" },
    { sku: "socks-2", status: "failed", title_family: "socks" },
  ]);
  assert.ok(scores.toy > scores.socks);
  assert.deepEqual(prioritizeFavoriteLinks([
    { href: "socks", text: "Носки для девочек" },
    { href: "toy", text: "Детская игрушка погремушка" },
  ], scores).map((link) => link.href), ["toy", "socks"]);
});

test("strict title-family feedback promotes matching Global search sources", () => {
  const socks = "https://www.ozon.ru/search/?text=%D0%BD%D0%BE%D1%81%D0%BA%D0%B8+%D0%B4%D0%BB%D1%8F+%D0%B4%D0%B5%D0%B2%D0%BE%D1%87%D0%B5%D0%BA&is_global=true";
  const toy = "https://www.ozon.ru/search/?text=%D0%B4%D0%B5%D1%82%D1%81%D0%BA%D0%B0%D1%8F+%D0%B8%D0%B3%D1%80%D1%83%D1%88%D0%BA%D0%B0+%D0%BF%D0%BE%D0%B3%D1%80%D0%B5%D0%BC%D1%83%D1%88%D0%BA%D0%B0&is_global=true";
  assert.deepEqual(prioritizeSourceUrls([socks, toy], {
    yieldRows: [
      { sku: "toy-1", status: "published", title_family: "toy" },
      { sku: "toy-2", status: "published", title_family: "toy" },
      { sku: "socks-1", status: "skipped", title_family: "socks" },
    ],
  }), [toy, socks]);
});

test("favorite title preflight rejects proven low-yield oversized categories", () => {
  assert.equal(favoriteTitleSkipReason("Зеркало настенное круглое 80 см в ванную"), "oversized-low-yield-title");
  assert.equal(favoriteTitleSkipReason("Ванна акриловая 160х70 см"), "oversized-low-yield-title");
  assert.equal(favoriteTitleSkipReason("Цифровое пианино 88 клавиш"), "oversized-low-yield-title");
  assert.equal(favoriteTitleSkipReason("Носки для девочек"), null);
  assert.deepEqual(favoriteFailureDisposition(new Error("oversized-low-yield-title: SKU 1")), {
    status: "rejected",
    reason: "oversized-low-yield-title",
  });
});

test("favorite title preflight moves deterministic prohibited categories before Ozon detail", () => {
  assert.equal(favoriteTitleSkipReason("5-HTP 100 мг витамины для сна"), "prohibited-category");
  assert.equal(favoriteTitleSkipReason("Сухой корм для кошек"), "prohibited-category");
  assert.equal(favoriteTitleSkipReason("Чехол для смартфона"), "prohibited-category");
  assert.equal(favoriteTitleSkipReason("Игрушка антистресс для детей"), null);
  assert.deepEqual(favoriteFailureDisposition(new Error("prohibited-category: SKU 1")), {
    status: "rejected",
    reason: "prohibited-category",
  });
});

test("low-yield feedback uses actual batch favorites instead of the concurrently drained queue total", () => {
  assert.equal(nextLowYieldBatchStreak({ current: 0, favorited: 1, threshold: 2 }), 1);
  assert.equal(nextLowYieldBatchStreak({ current: 1, favorited: 1, threshold: 2 }), 2);
  assert.equal(nextLowYieldBatchStreak({ current: 2, favorited: 4, threshold: 2 }), 0);
});

test("source scanning yields after a bounded tranche so new publish feedback can rerank it", () => {
  assert.equal(shouldYieldForSourceFeedback({ completedBatches: 7, maximumBatches: 8, pendingSources: 100 }), false);
  assert.equal(shouldYieldForSourceFeedback({ completedBatches: 8, maximumBatches: 8, pendingSources: 100 }), true);
  assert.equal(shouldYieldForSourceFeedback({ completedBatches: 8, maximumBatches: 8, pendingSources: 0 }), false);
  assert.equal(shouldYieldForSourceFeedback({ completedBatches: 80, maximumBatches: 0, pendingSources: 100 }), false);
});

test("source lookahead stays one batch ahead only while the tranche can continue", () => {
  assert.equal(sourceBatchPrefetchAllowed({
    sourceBlocked: false,
    deadlineReached: false,
    completedBatches: 1,
    maximumBatches: 8,
    remainingSources: 12,
  }), true);
  assert.equal(sourceBatchPrefetchAllowed({
    sourceBlocked: true,
    deadlineReached: false,
    completedBatches: 1,
    maximumBatches: 8,
    remainingSources: 12,
  }), false);
  assert.equal(sourceBatchPrefetchAllowed({
    sourceBlocked: false,
    deadlineReached: false,
    completedBatches: 8,
    maximumBatches: 8,
    remainingSources: 12,
  }), false);
  assert.equal(sourceBatchPrefetchAllowed({
    sourceBlocked: false,
    deadlineReached: true,
    completedBatches: 1,
    maximumBatches: 8,
    remainingSources: 12,
  }), false);
  assert.equal(sourceBatchPrefetchAllowed({
    sourceBlocked: false,
    deadlineReached: false,
    completedBatches: 1,
    maximumBatches: 0,
    remainingSources: 0,
  }), false);
});

test("source scrolling keeps bounded dedup headroom above the per-source consumer limit", () => {
  assert.equal(sourceScanLinkTarget(24), 48);
  assert.equal(sourceScanLinkTarget(1), 12);
  assert.equal(sourceScanLinkTarget(24, 3), 72);
});

test("unseen proven deep pages stop at 1.5x headroom while ordinary sources keep 2x", () => {
  const deep = "https://www.ozon.ru/seller/proven/?page=4";
  assert.equal(sourceScanLinkTargetForSource(deep, {
    perSourceLimit: 24,
    boundedDeepUrls: [deep],
  }), 36);
  assert.equal(sourceScanLinkTargetForSource("https://www.ozon.ru/search/?text=ordinary", {
    perSourceLimit: 24,
    boundedDeepUrls: [deep],
  }), 48);
});

test("strict discovery pages share bounded scan headroom with proven deep pages", () => {
  const deep = "https://www.ozon.ru/seller/proven/?page=4";
  const strictPage = "https://www.ozon.ru/search/?text=strict&is_global=true&page=3";
  const nextStrictPage = "https://www.ozon.ru/search/?text=strict&is_global=true&page=4";
  const bounded = boundedEvidenceSourceUrls({
    deepUrls: [deep],
    publishedPages: [strictPage],
    nextPublishedPages: [nextStrictPage, strictPage],
  });
  assert.deepEqual(bounded, [deep, strictPage, nextStrictPage]);
  assert.equal(sourceScanLinkTargetForSource(strictPage, {
    perSourceLimit: 24,
    boundedDeepUrls: bounded,
  }), 36);
});

test("source scan persistence counts only unique unattempted limited links", () => {
  const sourceA = "https://www.ozon.ru/search/?text=a";
  const sourceB = "https://www.ozon.ru/search/?text=b";
  const counts = eligibleLinkCountsBySource([
    { href: "https://www.ozon.ru/product/a-101/", source_url: sourceA },
    { href: "https://www.ozon.ru/product/a-copy-101/", source_url: sourceA },
    { href: "https://www.ozon.ru/product/a-102/", source_url: sourceA },
    { href: "https://www.ozon.ru/product/b-201/", source_url: sourceB },
  ], new Set(["102"]));
  assert.deepEqual(Object.fromEntries(counts), { [sourceA]: 1, [sourceB]: 1 });
});

test("transient source timeouts and soft blocks remain retryable after their evidence is persisted", () => {
  const completed = "https://www.ozon.ru/seller/completed/";
  const timedOut = "https://www.ozon.ru/seller/timed-out/";
  const blocked = "https://www.ozon.ru/seller/blocked/";
  assert.deepEqual([...completedSourceUrls([
    { source_url: completed, stop_reason: "link_target_reached", cumulative_product_link_count: 48 },
    { source_url: timedOut, stop_reason: `error: source page lifecycle ${timedOut} timed out after 60000ms` },
    { source_url: blocked, blocked: true, stop_reason: "blocked_or_empty" },
  ])], [completed]);
});

test("fresh transient source failures cool down before becoming retryable again", () => {
  const recent = "https://www.ozon.ru/seller/recent-timeout/";
  const expired = "https://www.ozon.ru/seller/expired-timeout/";
  const now = Date.parse("2026-07-16T16:00:00.000Z");
  assert.deepEqual([...completedSourceUrls([
    {
      source_url: recent,
      scanned_at: "2026-07-16T15:55:00.000Z",
      stop_reason: "error: source page lifecycle timed out after 60000ms",
    },
    {
      source_url: expired,
      scanned_at: "2026-07-16T15:40:00.000Z",
      stop_reason: "error: source page lifecycle timed out after 60000ms",
    },
  ], { now, transientRetryMs: 10 * 60_000 })], [recent]);
});

test("summary scanner logging suppresses repetitive batch telemetry but retains actionable evidence", () => {
  const messages = [];
  const log = createScannerLogger((message) => messages.push(message), "summary");
  log("favorite rejected SKU 1: non-pure-fbs");
  log("favorite failed SKU 2: Ozon detail soft blocked");
  log("favorite 0 -> 0 delta=0");
  log("favorite 8 -> 10 delta=2");
  log("batch 1-8 / 120 concurrency=8");
  log("Ozon detail pacing interval=4000ms event=soft-block");
  log("source non-pure-FBS sample deferred after 7 checks: https://www.ozon.ru/seller/dry/?sorting=rating");
  log("favorite collection summary attempted=24 favorited=6 rejected=12 failed=6");
  assert.deepEqual(messages, [
    "Ozon detail pacing interval=4000ms event=soft-block",
    "favorite collection summary attempted=24 favorited=6 rejected=12 failed=6",
  ]);
});

test("summary scanner logging truncates stack traces and oversized telemetry", () => {
  const messages = [];
  const log = createScannerLogger((message) => messages.push(message), "summary");
  log(`favorite count telemetry unavailable: Failed to fetch\n${"stack".repeat(200)}`);
  assert.deepEqual(messages, ["favorite count telemetry unavailable: Failed to fetch"]);
});

test("Maozi favorite capacity is a batch terminal condition", () => {
  assert.equal(isFavoriteCapacityReached(new Error("收藏数量已达上限（1000个），请先删除部分收藏")), true);
  assert.equal(isFavoriteCapacityReached(new Error("商品信息不完整")), false);
  assert.equal(effectiveFavoriteTotal({ claimedTotal: 1000, observedTotal: 962, target: 1000 }), 1000);
  assert.equal(effectiveFavoriteTotal({ claimedTotal: 900, observedTotal: 905, target: 1000 }), 905);
  assert.equal(effectiveFavoriteTotal({ claimedTotal: 37, observedTotal: null, target: 1000 }), 37);
});

test("rolling collection excludes only latest terminal skipped or published SKUs", () => {
  const text = [
    JSON.stringify({ sku: "1", status: "skipped" }),
    JSON.stringify({ sku: "2", status: "failed" }),
    JSON.stringify({ sku: "2", status: "published" }),
    JSON.stringify({ sku: "3", status: "skipped" }),
    JSON.stringify({ sku: "3", status: "processing" }),
    "malformed",
  ].join("\n");
  assert.deepEqual([...terminalSkusFromJsonl(text)].sort(), ["1", "2"]);
});

test("cross-run seeds skip deterministic outcomes but retry transient favorite failures", () => {
  const excluded = excludedSkusFromHistories({
    stateTexts: [[
      JSON.stringify({ sku: "published", status: "published" }),
      JSON.stringify({ sku: "unprofitable", status: "skipped" }),
      JSON.stringify({ sku: "retry-state", status: "failed" }),
    ].join("\n")],
    favoriteTexts: [[
      JSON.stringify({ sku: "non-fbs", status: "rejected", reason: "non-pure-fbs" }),
      JSON.stringify({ sku: "currency-recheck", status: "rejected", reason: "non-cny-sale-price" }),
      JSON.stringify({ sku: "missing-mode", status: "failed", error: "missing-shipping-mode: SKU missing-mode" }),
      JSON.stringify({ sku: "soft-block", status: "failed", error: "Ozon detail soft blocked" }),
    ].join("\n")],
  });
  assert.deepEqual([...excluded].sort(), ["missing-mode", "non-fbs", "published", "unprofitable"]);
});

test("same-run cooldown fallback advances past successfully favorited SKUs", () => {
  const text = [
    JSON.stringify({ sku: "accepted", status: "favorited" }),
    JSON.stringify({ sku: "retry-soft-block", status: "failed", error: "Ozon detail soft blocked" }),
    JSON.stringify({ sku: "rejected", status: "rejected", reason: "non-pure-fbs" }),
  ].join("\n");
  assert.deepEqual([...favoritedSkusFromHistory(text)], ["accepted"]);
});
