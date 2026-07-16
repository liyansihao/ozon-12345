import test from "node:test";
import assert from "node:assert/strict";

import {
  canClaimFavorite,
  favoriteRetryDelay,
  favoriteModeSkipReason,
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
  productTitleFamily,
  productTitlePriority,
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
  assert.equal(expanded.length, 9);
  assert.equal(new Set(expanded).size, expanded.length);
  assert.ok(expanded.some((url) => new URL(url).searchParams.get("currency_price") === "500.000;"
    && new URL(url).searchParams.get("sorting") === "discount"));
});

test("published sources expand into prioritized sorting variants without duplicates", () => {
  const successful = "https://www.ozon.ru/seller/example/?currency_price=50.000%3B";
  const ordinary = "https://www.ozon.ru/seller/ordinary/";
  const rows = [{ source_url: successful, status: "published" }];
  const expanded = expandHighYieldSourceUrls([ordinary, successful], rows);
  const prioritized = prioritizeSourceUrls(expanded, { highYieldSources: [successful] });
  assert.equal(prioritized[0], successful);
  assert.equal(new URL(prioritized[1]).searchParams.get("sorting"), "rating");
  assert.equal(prioritized[2], ordinary);
  assert.ok(prioritized.some((value) => new URL(value).searchParams.get("currency_price") === "500.000;"
    && new URL(value).searchParams.get("sorting") === "discount"));
  assert.equal(new Set(prioritized).size, prioritized.length);
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
  }), [derived, seller]);
});

test("verified source variants finish their tier before ordinary sources", () => {
  const verified = "https://www.ozon.ru/search/?text=winner&is_global=true";
  const verifiedVariant = `${verified}&sorting=rating`;
  const ordinary = "https://www.ozon.ru/seller/ordinary/";
  assert.deepEqual(prioritizeSourceUrls([verified, verifiedVariant, ordinary], {
    verifiedFreshSourceUrls: [verified],
  }), [verified, verifiedVariant, ordinary]);
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
  assert.deepEqual(verifiedSellerSourceUrls([
    { status: "favorited", seller_url: "https://www.ozon.ru/seller/b/?miniapp=1" },
    { status: "published", sku: "a-1", seller_url: "https://www.ozon.ru/seller/a/" },
    { status: "published", sku: "a-2", seller_url: "https://www.ozon.ru/seller/a/?miniapp=1" },
    { status: "published", sku: "b-1", seller_url: "https://www.ozon.ru/seller/b/" },
    { status: "published", sku: "d-1", source_url: "https://www.ozon.ru/seller/d/?currency_price=50.000%3B" },
    { status: "published", sku: "d-2", source_url: "https://www.ozon.ru/seller/d/" },
    { status: "rejected", seller_url: "https://www.ozon.ru/seller/c/" },
  ]), ["https://www.ozon.ru/seller/a/", "https://www.ozon.ru/seller/d/"]);
});

test("favorite preflight accepts only an explicit pure FBS mode", () => {
  assert.equal(favoriteModeSkipReason("FBS"), null);
  assert.equal(favoriteModeSkipReason("FBS, RFBS"), "non-pure-fbs");
  assert.equal(favoriteModeSkipReason(null), "missing-shipping-mode");
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

test("one blocked source batch creates one shared cooldown incident", () => {
  const state = { detailSoftBlockStreak: 0, lastDetailSoftBlockAt: 0, detailBlockedUntil: 0 };
  const result = sourceBatchCooldownState([
    { blocked: true, stop_reason: "blocked_or_empty" },
    { blocked: true, stop_reason: "blocked_or_empty" },
    { blocked: true, stop_reason: "blocked_or_empty" },
  ], state, 10_000);
  assert.equal(result.blocked, true);
  assert.equal(state.detailSoftBlockStreak, 1);
  assert.equal(state.detailBlockedUntil, 610_000);
  sourceBatchCooldownState([{ blocked: false, stop_reason: "max_steps" }], state, 80_000);
  assert.equal(state.detailSoftBlockStreak, 0);
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
