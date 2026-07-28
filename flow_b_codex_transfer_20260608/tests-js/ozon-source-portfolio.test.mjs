import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  aggregateSourceEvidence,
  buildSourcePortfolio,
  refreshSourcePortfolio,
  sourceScanCheckpointPath,
} from "../scripts/ozon_source_portfolio.mjs";

const good = "https://www.ozon.ru/seller/safe-toys/";
const rejected = "https://www.ozon.ru/seller/rejected-source/";
const prohibited = "https://www.ozon.ru/seller/underwear-source/";
const dry = "https://www.ozon.ru/seller/ambiguous-source/";

test("production seeds include explicit China highlight sources for standardized safe goods", async () => {
  const seedText = await fs.readFile(
    path.resolve(import.meta.dirname, "../config/ozon_source_seed.txt"),
    "utf8",
  );
  const seedUrls = seedText.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  const chinaCategoryIds = new Set(seedUrls.flatMap((value) => {
    const url = new URL(value);
    if (!url.pathname.includes("/highlight/tovary-iz-kitaya-")) return [];
    return [url.searchParams.get("category")];
  }));

  assert.deepEqual(
    [...chinaCategoryIds].sort(),
    ["13506", "13517", "13523", "13812"],
  );
  assert.ok(seedUrls
    .filter((value) => new URL(value).pathname.includes("/highlight/tovary-iz-kitaya-"))
    .every((value) => !["50.000;", "120.000;"].includes(new URL(value).searchParams.get("currency_price"))));
});

test("portfolio reads the run-authoritative configured scan checkpoint", () => {
  const runDir = "/state/runs/daily-run";

  assert.equal(
    sourceScanCheckpointPath(runDir, {
      scan_output: "/state/runs/daily-run/source_deep_scan_detail_verified.json",
    }),
    "/state/runs/daily-run/source_deep_scan_detail_verified.json",
  );
  assert.equal(
    sourceScanCheckpointPath(runDir, {
      scan_output: "/state/another-run/foreign.json",
    }),
    "/state/runs/daily-run/source_deep_scan.json",
  );
});

test("portfolio refresh consumes configured scan exhaustion evidence", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-source-portfolio-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const runDir = path.join(stateRoot, "runs", "daily-run");
  const historyDir = path.join(stateRoot, "history");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(historyDir, { recursive: true });
  const scanOutput = path.join(runDir, "source_deep_scan_detail_verified.json");
  await fs.writeFile(path.join(runDir, "source_config.json"), JSON.stringify({ scan_output: scanOutput }));
  await fs.writeFile(scanOutput, JSON.stringify([
    { source_url: dry, eligible_link_count_before_collection: 0 },
    { source_url: dry, eligible_link_count_before_collection: 0 },
  ]));
  const seedFile = path.join(stateRoot, "seed.txt");
  await fs.writeFile(seedFile, `${good}\n`);

  const portfolio = await refreshSourcePortfolio({
    stateRoot,
    runDir,
    seedFile,
    minimumActiveSources: 1,
  });

  assert.equal(
    portfolio.disabled.find((row) => row.source_url === dry)?.disabled_reason,
    "source-exhausted-no-new-candidates",
  );
});

test("portfolio refresh disables candidate sources with repeated low pure-FBS outcomes", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-source-low-fbs-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const runDir = path.join(stateRoot, "runs", "daily-run");
  await fs.mkdir(path.join(stateRoot, "history"), { recursive: true });
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "candidate_queue.jsonl"), [
    "low-fbs-1",
    "low-fbs-2",
    "low-fbs-3",
    "low-fbs-4",
  ].map((sku) => JSON.stringify({
    sku,
    source_url: dry,
    status: "deferred",
    reason: `source deferred after low pure-FBS yield: ${dry}`,
  })).join("\n"));
  const seedFile = path.join(stateRoot, "seed.txt");
  await fs.writeFile(seedFile, `${good}\n`);

  const portfolio = await refreshSourcePortfolio({
    stateRoot,
    runDir,
    seedFile,
    minimumActiveSources: 1,
  });

  assert.equal(
    portfolio.disabled.find((row) => row.source_url === dry)?.disabled_reason,
    "low-pure-fbs-rate",
  );
  assert.equal(portfolio.active_urls.includes(dry), false);
});

test("portfolio disables a low pure-FBS search family across unobserved price bands", () => {
  const search150 = "https://www.ozon.ru/search/?text=плюшевая+игрушка&is_global=true&currency_price=150.000%3B";
  const search500 = "https://www.ozon.ru/search/?text=плюшевая+игрушка&is_global=true&currency_price=500.000%3B&sorting=rating";
  const search1000 = "https://www.ozon.ru/search/?text=плюшевая+игрушка&is_global=true&currency_price=1000.000%3B&sorting=rating";
  const fbsRows = [
    { sku: "low-search-1", source_url: search150, status: "deferred", reason: "source deferred after low pure-FBS yield" },
    { sku: "low-search-2", source_url: search150, status: "deferred", reason: "source deferred after low pure-FBS yield" },
    { sku: "low-search-3", source_url: search500, status: "deferred", reason: "source deferred after low pure-FBS yield" },
    { sku: "low-search-4", source_url: search500, status: "deferred", reason: "source deferred after low pure-FBS yield" },
  ];

  const portfolio = buildSourcePortfolio({
    fbsRows,
    seedUrls: [search1000, good],
    minimumActiveSources: 1,
  });

  assert.ok(portfolio.disabled.some((row) => row.disabled_reason === "search-family-low-pure-fbs-rate"));
  assert.equal(portfolio.active_urls.some((value) => (
    new URL(value).searchParams.get("text") === "плюшевая игрушка"
  )), false);
});

test("portfolio keeps a promoted seed price band when an older enabled band has evidence", () => {
  const oldBand = "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?category=13523&currency_price=500.000%3B";
  const promotedBand = "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?category=13523&currency_price=1000.000%3B";
  const portfolio = buildSourcePortfolio({
    yieldRows: [{
      sku: "old-band-profit-fail",
      source_url: oldBand,
      status: "skipped",
      reason: "profit-upper-bound<=30",
    }],
    fbsRows: [{
      sku: "old-band-profit-fail",
      source_url: oldBand,
      status: "favorited",
      shipping_mode: "FBS",
    }],
    seedUrls: [promotedBand],
    minimumActiveSources: 10,
    maximumActiveSources: 10,
  });

  assert.ok(portfolio.active_urls.includes(promotedBand));
});

test("portfolio preserves a strict-confirmed search variant while disabling its dry price band", () => {
  const strict150 = "https://www.ozon.ru/search/?text=силиконовая+подставка&is_global=true&currency_price=150.000%3B";
  const dry500 = "https://www.ozon.ru/search/?text=силиконовая+подставка&is_global=true&currency_price=500.000%3B&sorting=rating";
  const yieldRows = [{
    sku: "strict-search-1",
    source_url: strict150,
    status: "published",
    title: "Силиконовая подставка",
  }];
  const fbsRows = Array.from({ length: 4 }, (_, index) => ({
    sku: `dry-search-${index}`,
    source_url: dry500,
    status: "deferred",
    reason: "source deferred after low pure-FBS yield",
  }));

  const portfolio = buildSourcePortfolio({
    yieldRows,
    fbsRows,
    seedUrls: [good],
    minimumActiveSources: 1,
  });

  assert.ok(portfolio.active_urls.includes(strict150));
  assert.equal(
    portfolio.disabled.find((row) => row.source_url === dry500)?.disabled_reason,
    "low-pure-fbs-rate",
  );
  assert.equal(
    portfolio.metrics.find((row) => row.source_url === strict150)?.family_disabled_reason,
    null,
  );
});

test("current strict FBS failure overrides stale listing-FBS source evidence", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-source-fbs-override-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const runDir = path.join(stateRoot, "runs", "daily-run");
  await fs.mkdir(path.join(stateRoot, "history"), { recursive: true });
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "favorite_collection.jsonl"), JSON.stringify({
    at: "2026-07-27T15:00:00.000Z",
    sku: "stale-fbs-1",
    source_url: good,
    status: "favorited",
    shipping_mode: "FBS",
  }));
  await fs.writeFile(path.join(runDir, "source_yield.jsonl"), JSON.stringify({
    at: "2026-07-28T01:00:00.000Z",
    sku: "stale-fbs-1",
    source_url: good,
    status: "skipped",
    reason: "fbs-confirmation-inconsistent",
  }));
  const seedFile = path.join(stateRoot, "seed.txt");
  await fs.writeFile(seedFile, `${good}\n`);

  const portfolio = await refreshSourcePortfolio({
    stateRoot,
    runDir,
    seedFile,
    minimumActiveSources: 1,
  });
  const metric = portfolio.metrics.find((row) => row.source_url === good);

  assert.equal(metric.funnel.pure_fbs, 0);
  assert.equal(metric.fbs_checked, 1);
  assert.equal(portfolio.counts.pure_fbs_sources, 0);
});

test("source evidence records the complete candidate-to-final funnel per source", () => {
  const yieldRows = [
    { sku: "1", source_url: good, title: "Деревянный конструктор", status: "published" },
    { sku: "2", source_url: good, title: "Набор кубиков", status: "submitted", reason: "publish-final-status-timeout" },
    { sku: "3", source_url: good, title: "Игрушечная машинка", status: "skipped", reason: "profit_rate<=30" },
    { sku: "4", source_url: good, title: "Плюшевый щенок", status: "skipped", reason: "1688-no-reliable-match" },
  ];
  const fbsRows = [
    { sku: "1", source_url: good, title: "Деревянный конструктор", status: "favorited", shipping_mode: "FBS" },
    { sku: "2", source_url: good, title: "Набор кубиков", status: "favorited", shipping_mode: "FBS" },
    { sku: "4", source_url: good, title: "Плюшевый щенок", status: "rejected", reason: "non-pure-fbs" },
  ];

  const [row] = aggregateSourceEvidence({ yieldRows, fbsRows });
  assert.equal(row.source_url, good);
  assert.deepEqual(row.funnel, {
    scanned: 4,
    pure_fbs: 2,
    reliable_cost: 3,
    identity_spec_pass: 3,
    profit_pass: 2,
    submitted: 2,
    final_confirmed: 1,
  });
  assert.equal(row.failures.online_product_rejected, 0);
  assert.equal(row.failures.no_reliable_1688_match, 1);
});

test("portfolio disables prohibited, rejected, and ambiguous dry sources without relaxing gates", () => {
  const yieldRows = [
    ...Array.from({ length: 6 }, (_, index) => ({
      sku: `good-${index}`,
      source_url: good,
      title: `Деревянный конструктор ${index}`,
      status: index < 3 ? "published" : "submitted",
      reason: index < 3 ? null : "publish-final-status-timeout",
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      sku: `reject-${index}`,
      source_url: rejected,
      title: `Игрушка ${index}`,
      status: "failed",
      reason: "online-product-rejected",
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      sku: `underwear-${index}`,
      source_url: prohibited,
      title: `Комплект трусов ${index}`,
      status: "published",
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      sku: `dry-${index}`,
      source_url: dry,
      title: `Неоднозначный товар ${index}`,
      status: "skipped",
      reason: "1688-no-reliable-match",
    })),
  ];
  const fbsRows = Array.from({ length: 6 }, (_, index) => ({
    sku: `good-${index}`,
    source_url: good,
    title: `Деревянный конструктор ${index}`,
    status: "favorited",
    shipping_mode: "FBS",
  }));

  const portfolio = buildSourcePortfolio({
    yieldRows,
    fbsRows,
    seedUrls: ["https://www.ozon.ru/search/?text=набор+канцелярии&is_global=true"],
    minimumActiveSources: 4,
  });

  assert.ok(portfolio.active_urls.includes(good));
  assert.ok(portfolio.active_urls.some((url) => url.includes("набор+канцелярии")));
  assert.equal(portfolio.disabled.find((row) => row.source_url === prohibited)?.disabled_reason, "prohibited-category-dominant");
  assert.equal(portfolio.disabled.find((row) => row.source_url === rejected)?.disabled_reason, "online-product-rejected-rate");
  assert.equal(portfolio.disabled.find((row) => row.source_url === dry)?.disabled_reason, "1688-identity-ambiguity");
  assert.equal(portfolio.active_urls.includes(prohibited), false);
  assert.equal(portfolio.active_urls.includes(rejected), false);
  assert.equal(portfolio.active_urls.includes(dry), false);
});

test("portfolio fills dispatch families with fresh strict-title searches instead of page and sorting duplicates", () => {
  const strictSeller = "https://www.ozon.ru/seller/verified-toys/";
  const yieldRows = Array.from({ length: 6 }, (_, index) => ({
    sku: `strict-${index}`,
    source_url: index % 2
      ? `${strictSeller}?page=${index + 1}`
      : `${strictSeller}?sorting=rating&page=${index + 1}`,
    seller_url: strictSeller,
    title: `Деревянный конструктор космическая станция ${index}`,
    status: "published",
  }));
  const portfolio = buildSourcePortfolio({
    yieldRows,
    seedUrls: [
      "https://www.ozon.ru/search/?text=статический+источник&is_global=true&sorting=rating",
      "https://www.ozon.ru/search/?text=статический+источник&is_global=true&sorting=discount&page=2",
    ],
    minimumActiveSources: 8,
  });
  const dispatchFamily = (value) => {
    const url = new URL(value);
    url.searchParams.delete("sorting");
    url.searchParams.delete("page");
    return url.toString();
  };
  const families = portfolio.active_urls.map(dispatchFamily);

  assert.equal(new Set(families).size, families.length);
  assert.ok(portfolio.active_urls.some((value) => (
    new URL(value).searchParams.get("text")?.includes("деревянный конструктор")
  )));
});

test("portfolio reallocates an empty FBS budget to distinct new exploration families", () => {
  const yieldRows = Array.from({ length: 7 }, (_, index) => ({
    sku: `strict-budget-${index}`,
    source_url: `https://www.ozon.ru/seller/strict-budget-${index}/`,
    title: `Строгий товар ${index}`,
    status: "published",
  }));
  const seedUrls = [
    "https://www.ozon.ru/search/?text=новый+источник+один&is_global=true&currency_price=500.000%3B",
    "https://www.ozon.ru/search/?text=новый+источник+два&is_global=true&currency_price=500.000%3B",
    "https://www.ozon.ru/search/?text=новый+источник+три&is_global=true&currency_price=500.000%3B",
  ];

  const portfolio = buildSourcePortfolio({
    yieldRows,
    seedUrls,
    minimumActiveSources: 10,
    maximumActiveSources: 10,
  });

  assert.deepEqual(
    seedUrls.filter((url) => portfolio.active_urls.includes(url)),
    seedUrls,
  );
  assert.equal(portfolio.counts.exploration_sources, 3);
});

test("portfolio explores curated safe queries before arbitrary historical title derivations", () => {
  const historicalTitle = "Редкий исторический прибор ультра";
  const portfolio = buildSourcePortfolio({
    yieldRows: [{
      sku: "strict-curated-order",
      source_url: "https://www.ozon.ru/seller/strict-curated-order/",
      title: historicalTitle,
      status: "published",
    }],
    minimumActiveSources: 2,
    maximumActiveSources: 2,
  });
  const searchTexts = portfolio.active_urls.flatMap((value) => {
    const url = new URL(value);
    return url.pathname === "/search/" ? [url.searchParams.get("text")] : [];
  });

  assert.ok(searchTexts.includes("деревянный конструктор"));
  assert.equal(searchTexts.includes(historicalTitle.toLowerCase()), false);
});

test("portfolio shares additional exploration slots with proven non-prohibited title queries", () => {
  const yieldRows = Array.from({ length: 7 }, (_, index) => ({
    sku: `strict-mix-${index}`,
    source_url: `https://www.ozon.ru/seller/strict-mix-${index}/`,
    title: "Проверенный органайзер настольный модель",
    status: "published",
  }));
  const portfolio = buildSourcePortfolio({
    yieldRows,
    minimumActiveSources: 10,
    maximumActiveSources: 10,
  });
  const searchTexts = portfolio.active_urls.flatMap((value) => {
    const url = new URL(value);
    return url.pathname === "/search/" ? [url.searchParams.get("text")] : [];
  });

  assert.equal(searchTexts[0], "деревянный конструктор");
  assert.match(searchTexts[1], /проверенный органайзер настольный/u);
});
