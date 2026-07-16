import test from "node:test";
import assert from "node:assert/strict";

import {
  canClaimFavorite,
  favoriteRetryDelay,
  favoriteModeSkipReason,
  listingModeSkipReason,
  effectiveFavoriteTotal,
  excludedSkusFromHistories,
  expandHighYieldSourceUrls,
  isFavoriteSessionAuthenticated,
  isFavoriteCapacityReached,
  isOzonSoftBlock,
  isProvenSellerSource,
  ozonRetryDelay,
  ozonDetailFailurePolicy,
  prioritizeFavoriteLinks,
  prioritizeSourceUrls,
  parseFavoriteProductSnapshot,
  parseListingFavoriteSnapshot,
  requiresFavoriteSession,
  retainedReplayLimit,
  scanSourceWithPage,
  classifyFreshSourceUrls,
  expandFreshSellerSourceUrls,
  retryMaoziPageFetch,
  retainedRowsForCollection,
  orderRowsBySourceYield,
  waitForMovingDeadline,
  shouldYieldAfterRetained,
  terminalSkusFromJsonl,
  limitLinksPerSource,
  cachedExactFbsFallbackLinks,
  fillRetainedFallbackLinks,
  productTitleFamily,
  productTitlePriority,
  observedTitleFamilyScores,
  createScannerLogger,
  favoriteFailureDisposition,
  favoritePriceSkipReason,
  favoriteTitleSkipReason,
  nextLowYieldBatchStreak,
  softBlockCooldownState,
  sourceBatchCooldownState,
  collectionRuntimeState,
  collectionDeadlineMs,
  isCollectionDeadlineReached,
  withTimeout,
  createFavoriteWorkerPage,
  readFavoriteSkusWithTimeout,
  readFavoriteCountWithTimeout,
  deriveSearchSourceUrls,
  verifiedSellerSourceUrls,
  verifiedPrioritySourceUrls,
  filterProductiveSourceVariants,
  expandPublishedSourcePages,
} from "../scripts/flow_b_playwright/source-scanner.mjs";

test("collection deadline stops an in-flight producer tranche", () => {
  const env = { FLOW_B_DEADLINE_AT: "2026-07-14T22:00:29.809Z" };
  assert.equal(collectionDeadlineMs(env), Date.parse(env.FLOW_B_DEADLINE_AT));
  assert.equal(isCollectionDeadlineReached(env, Date.parse("2026-07-14T22:00:29.808Z")), false);
  assert.equal(isCollectionDeadlineReached(env, Date.parse("2026-07-14T22:00:29.809Z")), true);
  assert.equal(collectionDeadlineMs({}), Number.POSITIVE_INFINITY);
});

test("one hung source page times out without blocking the batch", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 10, "source scan"),
    /source scan timed out after 10ms/,
  );
  assert.equal(await withTimeout(Promise.resolve("ok"), 100, "source scan"), "ok");
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

test("derived search budget uses the most recent strict publications first", () => {
  const urls = deriveSearchSourceUrls([
    { status: "published", title: "Старый товар источник" },
    { status: "published", title: "Новый успешный товар" },
  ], 1);
  assert.equal(new URL(urls[0]).searchParams.get("text"), "новый успешный товар");
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

test("full-funnel source yield promotes repeated pure-FBS favorites over rejected sources", () => {
  const rejected = "https://www.ozon.ru/seller/rejected/";
  const pureFbs = "https://www.ozon.ru/seller/pure-fbs/";
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ source_url: rejected, sku: `r-${i}`, status: "rejected" })),
    ...Array.from({ length: 5 }, (_, i) => ({ source_url: pureFbs, sku: `f-${i}`, status: "favorited" })),
  ];
  assert.deepEqual(prioritizeSourceUrls([rejected, pureFbs], { yieldRows: rows }), [pureFbs, rejected]);
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

test("verified source variants finish their tier before ordinary sources", () => {
  const verified = "https://www.ozon.ru/search/?text=winner&is_global=true";
  const verifiedVariant = `${verified}&sorting=rating`;
  const verifiedPage = `${verified}&page=2`;
  const ordinary = "https://www.ozon.ru/seller/ordinary/";
  assert.deepEqual(prioritizeSourceUrls([ordinary, verifiedPage, verified, verifiedVariant], {
    verifiedFreshSourceUrls: [verified],
  }), [verifiedPage, verified, verifiedVariant, ordinary]);
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

test("blocked source batches probe with short backoff before escalating", () => {
  const state = { detailSoftBlockStreak: 0, lastDetailSoftBlockAt: 0, detailBlockedUntil: 0 };
  const rows = [
    { blocked: true, stop_reason: "blocked_or_empty" },
    { blocked: true, stop_reason: "blocked_or_empty" },
    { blocked: true, stop_reason: "blocked_or_empty" },
  ];
  const result = sourceBatchCooldownState(rows, state, 10_000);
  assert.equal(result.blocked, true);
  assert.equal(result.delay, 60_000);
  assert.equal(state.detailSoftBlockStreak, 1);
  assert.equal(state.detailBlockedUntil, 70_000);
  const repeated = sourceBatchCooldownState(rows, state, 80_000);
  assert.equal(repeated.delay, 180_000);
  assert.equal(state.detailSoftBlockStreak, 2);
  assert.equal(state.detailBlockedUntil, 260_000);
  sourceBatchCooldownState([{ blocked: false, stop_reason: "max_steps" }], state, 270_000);
  assert.equal(state.detailSoftBlockStreak, 0);
});

test("one isolated blocked source only lowers concurrency without pausing the producer", () => {
  const state = { detailSoftBlockStreak: 0, lastDetailSoftBlockAt: 0, detailBlockedUntil: 0 };
  const result = sourceBatchCooldownState([
    { blocked: true, stop_reason: "blocked_or_empty" },
    { blocked: false, stop_reason: "max_steps" },
    { blocked: false, stop_reason: "stable_bottom" },
    { blocked: false, stop_reason: "max_steps" },
    { blocked: false, stop_reason: "stable_bottom" },
  ], state, 10_000);
  assert.deepEqual(result, { blocked: false, delay: 0 });
  assert.equal(state.detailSoftBlockStreak, 0);
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
  assert.ok(productTitlePriority("Носки для девочек") > productTitlePriority("Плюшевая игрушка Sprunki"));
  assert.ok(productTitlePriority("Большая картина") > productTitlePriority("Фигурка героя"));
  assert.ok(productTitlePriority("Плюшевая игрушка Sprunki") > productTitlePriority("Браслет с кулоном"));
  assert.ok(productTitlePriority("Плюшевая игрушка Sprunki") > productTitlePriority("Летняя кепка для кошек"));
  assert.ok(productTitlePriority("Большая картина") > productTitlePriority("Детский игровой столик для игр с водой"));
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

test("low-yield feedback uses actual batch favorites instead of the concurrently drained queue total", () => {
  assert.equal(nextLowYieldBatchStreak({ current: 0, favorited: 1, threshold: 2 }), 1);
  assert.equal(nextLowYieldBatchStreak({ current: 1, favorited: 1, threshold: 2 }), 2);
  assert.equal(nextLowYieldBatchStreak({ current: 2, favorited: 4, threshold: 2 }), 0);
});

test("summary scanner logging suppresses per-SKU noise but retains batch evidence", () => {
  const messages = [];
  const log = createScannerLogger((message) => messages.push(message), "summary");
  log("favorite rejected SKU 1: non-pure-fbs");
  log("favorite failed SKU 2: Ozon detail soft blocked");
  log("favorite 0 -> 0 delta=0");
  log("favorite 8 -> 10 delta=2");
  log("batch 1-8 / 120 concurrency=8");
  log("favorite collection summary attempted=24 favorited=6 rejected=12 failed=6");
  assert.deepEqual(messages, [
    "favorite 8 -> 10 delta=2",
    "batch 1-8 / 120 concurrency=8",
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
