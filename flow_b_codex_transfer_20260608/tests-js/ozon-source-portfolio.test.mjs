import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  aggregateSourceEvidence,
  buildSourcePortfolio,
  enrichCurrentRunStrictSourceYieldRows,
  refreshSourcePortfolio,
  sourceScanCheckpointPath,
  sourcePortfolioDerivedQueryLimit,
} from "../scripts/ozon_source_portfolio.mjs";

const good = "https://www.ozon.ru/seller/safe-toys/";
const rejected = "https://www.ozon.ru/seller/rejected-source/";
const prohibited = "https://www.ozon.ru/seller/underwear-source/";
const dry = "https://www.ozon.ru/seller/ambiguous-source/";
const execFileAsync = promisify(execFile);

test("current authoritative publication upgrades only its matching source-yield row", () => {
  const source = "https://www.ozon.ru/seller/current-strict/";
  const rows = enrichCurrentRunStrictSourceYieldRows([
    { sku: "strict-current", source_url: source, status: "published" },
    { sku: "legacy-other", source_url: source, status: "published" },
  ], [{
    sku: "strict-current",
    online_status: "selling",
    stock: 1,
    profit_rate: 31,
    shipping_mode: "FBS",
  }]);

  assert.equal(rows[0].strict_confirmed, true);
  assert.equal(rows[0].online_status, "selling");
  assert.equal(rows[0].profit_rate, 31);
  assert.equal(rows[1].strict_confirmed, undefined);
});

test("source funnel counts only strict-proof publications as final confirmations", () => {
  const source = "https://www.ozon.ru/seller/strict-proof/";
  const [row] = aggregateSourceEvidence({
    yieldRows: [{
      sku: "strict-proof",
      source_url: source,
      status: "published",
      strict_confirmed: true,
      online_status: "selling",
      stock: 1,
      profit_rate: 31,
      shipping_mode: "FBS",
    }],
  });

  assert.equal(row.funnel.final_confirmed, 1);
  assert.equal(row.funnel.pure_fbs, 1);
  assert.equal(row.rates.final_confirmed, 1);
  assert.equal(row.rates.pure_fbs, 1);
});

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

test("source portfolio CLI refresh runs through the production app symlink", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-source-portfolio-symlink-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const seedFile = path.join(root, "seed.txt");
  const linkedScript = path.join(root, "ozon_source_portfolio.mjs");
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(seedFile, `${good}\n`);
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

test("portfolio excludes an encoded Russian underwear search before scanning", () => {
  const prohibitedSearch = "https://www.ozon.ru/search/?text=%D0%9A%D0%BE%D0%BC%D0%BF%D0%BB%D0%B5%D0%BA%D1%82+%D0%BD%D0%B8%D0%B6%D0%BD%D0%B5%D0%B3%D0%BE+%D0%B1%D0%B5%D0%BB%D1%8C%D1%8F+SYJWY&is_global=true";
  const portfolio = buildSourcePortfolio({
    seedUrls: [prohibitedSearch, good],
    minimumActiveSources: 1,
    maximumActiveSources: 1,
  });

  assert.equal(portfolio.active_urls.includes(prohibitedSearch), false);
  assert.ok(portfolio.active_urls.includes(good));
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

test("portfolio keeps a strictly confirmed source active despite a low pure-FBS sample rate", () => {
  const strictLowFbs = "https://www.ozon.ru/seller/strict-low-fbs/";
  const portfolio = buildSourcePortfolio({
    yieldRows: [{
      sku: "strict-success",
      source_url: strictLowFbs,
      status: "published",
      strict_confirmed: true,
      online_status: "selling",
      stock: 1,
      profit_rate: 31,
      shipping_mode: "FBS",
    }],
    fbsRows: [
      {
        sku: "strict-success",
        source_url: strictLowFbs,
        status: "favorited",
        shipping_mode: "FBS",
      },
      ...Array.from({ length: 7 }, (_, index) => ({
        sku: `non-fbs-${index}`,
        source_url: strictLowFbs,
        status: "rejected",
        reason: "non-pure-fbs",
      })),
    ],
    minimumActiveSources: 1,
  });

  assert.equal(
    portfolio.metrics.find((row) => row.source_url === strictLowFbs)?.funnel.final_confirmed,
    1,
  );
  assert.equal(
    portfolio.disabled.find((row) => row.source_url === strictLowFbs)?.disabled_reason,
    undefined,
  );
  assert.equal(portfolio.active_urls[0], strictLowFbs);
});

test("portfolio disables legacy high-submit evidence when the strict pure-FBS sample rate is low", () => {
  const productiveLowFbs = "https://www.ozon.ru/seller/productive-low-fbs/";
  const fbsRows = Array.from({ length: 10 }, (_, index) => ({
    sku: `candidate-${index}`,
    source_url: productiveLowFbs,
    status: index === 0 ? "favorited" : "rejected",
    shipping_mode: index === 0 ? "FBS" : undefined,
    reason: index === 0 ? undefined : "non-pure-fbs",
  }));
  const portfolio = buildSourcePortfolio({
    yieldRows: [0, 1].map((index) => ({
      sku: `candidate-${index}`,
      source_url: productiveLowFbs,
      status: "submitted",
      reason: "publish-final-status-timeout",
      profit_rate: 40,
      shipping_mode: "FBS",
    })),
    fbsRows,
    minimumActiveSources: 1,
  });

  const metric = portfolio.metrics.find((row) => row.source_url === productiveLowFbs);
  assert.equal(metric?.funnel.final_confirmed, 0);
  assert.equal(metric?.rates.pure_fbs, 0.1);
  assert.equal(metric?.rates.submit, 0.2);
  assert.equal(metric?.failures.online_product_rejected, 0);
  assert.equal(metric?.prohibited_count, 0);
  assert.equal(metric?.disabled_reason, "low-pure-fbs-rate");
  assert.equal(
    portfolio.disabled.find((row) => row.source_url === productiveLowFbs)?.disabled_reason,
    "low-pure-fbs-rate",
  );
  assert.equal(portfolio.active_urls.includes(productiveLowFbs), false);
});

test("portfolio disables every seller variant when the family has low strict pure-FBS yield", () => {
  const productiveBand = "https://www.ozon.ru/seller/productive-family/?currency_price=150.000%3B&sorting=rating";
  const dryBand = "https://www.ozon.ru/seller/productive-family/?currency_price=500.000%3B&sorting=rating";
  const productiveRows = Array.from({ length: 8 }, (_, index) => ({
    sku: `productive-family-${index}`,
    source_url: productiveBand,
    status: index === 0 ? "favorited" : "rejected",
    shipping_mode: index === 0 ? "FBS" : undefined,
    reason: index === 0 ? undefined : "non-pure-fbs",
  }));
  const dryRows = Array.from({ length: 8 }, (_, index) => ({
    sku: `dry-family-${index}`,
    source_url: dryBand,
    status: "rejected",
    reason: "non-pure-fbs",
  }));
  const portfolio = buildSourcePortfolio({
    yieldRows: [{
      sku: "productive-family-0",
      source_url: productiveBand,
      status: "submitted",
      reason: "publish-final-status-timeout",
      profit_rate: 40,
      shipping_mode: "FBS",
    }],
    fbsRows: [...productiveRows, ...dryRows],
    seedUrls: [good],
    minimumActiveSources: 1,
  });

  const productive = portfolio.metrics.find((row) => row.source_url === productiveBand);
  const dry = portfolio.metrics.find((row) => row.source_url === dryBand);
  assert.equal(productive?.rates.pure_fbs, 0.125);
  assert.equal(productive?.rates.submit, 0.125);
  assert.equal(productive?.family_disabled_reason, "low-pure-fbs-rate");
  assert.equal(productive?.disabled_reason, "low-pure-fbs-rate");
  assert.equal(dry?.family_disabled_reason, "low-pure-fbs-rate");
  assert.equal(dry?.disabled_reason, "low-pure-fbs-rate");
  assert.equal(portfolio.active_urls.includes(productiveBand), false);
  assert.equal(portfolio.active_urls.includes(dryBand), false);
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
    strict_confirmed: true,
    online_status: "selling",
    stock: 1,
    profit_rate: 31,
    shipping_mode: "FBS",
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

test("portfolio does not expand a strict seller into variants with known low pure-FBS evidence", () => {
  const strictBand = "https://www.ozon.ru/seller/strict-with-dry-variants/?currency_price=150.000%3B&sorting=rating";
  const dryRoot = "https://www.ozon.ru/seller/strict-with-dry-variants/";
  const dryBand = "https://www.ozon.ru/seller/strict-with-dry-variants/?currency_price=500.000%3B&sorting=rating";
  const portfolio = buildSourcePortfolio({
    yieldRows: [{
      sku: "strict-seller-band",
      source_url: strictBand,
      title: "Деревянный конструктор",
      status: "published",
      strict_confirmed: true,
      online_status: "selling",
      stock: 1,
      profit_rate: 31,
      shipping_mode: "FBS",
    }],
    fbsRows: [
      {
        sku: "strict-seller-band",
        source_url: strictBand,
        status: "favorited",
        shipping_mode: "FBS",
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        sku: `dry-root-${index}`,
        source_url: dryRoot,
        status: "rejected",
        reason: "non-pure-fbs",
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        sku: `dry-band-${index}`,
        source_url: dryBand,
        status: "rejected",
        reason: "non-pure-fbs",
      })),
    ],
    minimumActiveSources: 5,
    maximumActiveSources: 120,
  });

  assert.ok(portfolio.active_urls.includes(strictBand));
  assert.equal(portfolio.active_urls.includes(dryRoot), false);
  assert.equal(portfolio.active_urls.includes(dryBand), false);
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
    {
      sku: "1",
      source_url: good,
      title: "Деревянный конструктор",
      status: "published",
      strict_confirmed: true,
      online_status: "selling",
      stock: 1,
      profit_rate: 31,
      shipping_mode: "FBS",
    },
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
    strict_confirmed: true,
    online_status: "selling",
    stock: 1,
    profit_rate: 31,
    shipping_mode: "FBS",
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

test("portfolio explores a recent pure-FBS seller before arbitrary fresh searches", () => {
  const observedSearch = "https://www.ozon.ru/search/?text=observed-fbs-product&is_global=true";
  const provenSeller = "https://www.ozon.ru/seller/one-pure-fbs-proof/";
  const portfolio = buildSourcePortfolio({
    fbsRows: [{
      at: "2026-07-28T10:00:00.000Z",
      sku: "one-pure-fbs-proof",
      source_url: observedSearch,
      seller_url: provenSeller,
      status: "favorited",
      shipping_mode: "FBS",
    }],
    minimumActiveSources: 3,
    maximumActiveSources: 3,
  });

  assert.ok(portfolio.active_urls.includes(provenSeller));
  const firstUnobservedSearchIndex = portfolio.active_urls.findIndex((value) => (
    new URL(value).pathname === "/search/" && value !== observedSearch
  ));
  assert.ok(firstUnobservedSearchIndex > portfolio.active_urls.indexOf(provenSeller));
});

test("portfolio rotates exhausted pure-FBS seller families to the next recent proof", () => {
  const exhaustedSeller = "https://www.ozon.ru/seller/exhausted-one-proof/";
  const freshSeller = "https://www.ozon.ru/seller/fresh-one-proof/";
  const portfolio = buildSourcePortfolio({
    fbsRows: [
      {
        at: "2026-07-28T09:00:00.000Z",
        sku: "exhausted-one-proof",
        source_url: "https://www.ozon.ru/search/?text=old-proof&is_global=true",
        seller_url: exhaustedSeller,
        status: "favorited",
        shipping_mode: "FBS",
      },
      {
        at: "2026-07-28T10:00:00.000Z",
        sku: "fresh-one-proof",
        source_url: "https://www.ozon.ru/search/?text=fresh-proof&is_global=true",
        seller_url: freshSeller,
        status: "favorited",
        shipping_mode: "FBS",
      },
    ],
    scanRows: [
      { source_url: exhaustedSeller, eligible_link_count_before_collection: 0 },
      { source_url: exhaustedSeller, eligible_link_count_before_collection: 0 },
    ],
    minimumActiveSources: 4,
    maximumActiveSources: 4,
  });

  assert.ok(portfolio.active_urls.includes(freshSeller));
  assert.equal(portfolio.active_urls.includes(exhaustedSeller), false);
});

test("portfolio reserves new exploration slots when configured seeds already have evidence", () => {
  const strictRows = Array.from({ length: 2 }, (_, index) => ({
    sku: `strict-reserve-${index}`,
    source_url: `https://www.ozon.ru/seller/strict-reserve-${index}/`,
    title: `Строгий товар ${index}`,
    status: "published",
    strict_confirmed: true,
    online_status: "selling",
    stock: 1,
    profit_rate: 31,
    shipping_mode: "FBS",
  }));
  const seedUrls = Array.from({ length: 8 }, (_, index) => (
    `https://www.ozon.ru/search/?text=historical-seed-${index}&is_global=true&currency_price=500.000%3B`
  ));
  const historicalSeedRows = seedUrls.map((source_url, index) => ({
    sku: `historical-seed-${index}`,
    source_url,
    status: "skipped",
    reason: "profit_rate<=30",
  }));

  const portfolio = buildSourcePortfolio({
    yieldRows: [...strictRows, ...historicalSeedRows],
    seedUrls,
    minimumActiveSources: 10,
    maximumActiveSources: 10,
  });

  assert.equal(portfolio.counts.strict_sources, 2);
  assert.equal(portfolio.counts.exploration_sources, 8);
  assert.equal(seedUrls.some((url) => portfolio.active_urls.includes(url)), false);
});

test("portfolio derives a deep enough query pool to replace exhausted production sources", () => {
  assert.equal(sourcePortfolioDerivedQueryLimit(10), 600);
  assert.equal(sourcePortfolioDerivedQueryLimit(60), 600);
  assert.equal(sourcePortfolioDerivedQueryLimit(120), 1200);
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

test("portfolio derives fresh search families from repeated pure-FBS product evidence after curated sources are exhausted", () => {
  const curated = buildSourcePortfolio({
    minimumActiveSources: 1_000,
    maximumActiveSources: 1_000,
  }).active_urls;
  const observedFbsSource = "https://www.ozon.ru/highlight/repeated-pure-fbs-proof-123/";
  const exhausted = [...curated, observedFbsSource].flatMap((source_url) => [
    { source_url, eligible_link_count_before_collection: 0 },
    { source_url, eligible_link_count_before_collection: 0 },
  ]);

  const portfolio = buildSourcePortfolio({
    fbsRows: [
      {
        at: "2026-07-28T10:00:00.000Z",
        sku: "pure-fbs-query-proof-1",
        source_url: observedFbsSource,
        title: "Зажимы для пакетов пластиковые 12 штук",
        status: "favorited",
        shipping_mode: "FBS",
      },
      {
        at: "2026-07-28T10:01:00.000Z",
        sku: "pure-fbs-query-proof-2",
        source_url: observedFbsSource,
        title: "Контейнер для мелочей пластиковый 6 секций",
        status: "favorited",
        shipping_mode: "FBS",
      },
      {
        at: "2026-07-28T10:02:00.000Z",
        sku: "pure-fbs-query-proof-3",
        source_url: observedFbsSource,
        title: "Крючки самоклеящиеся прозрачные 20 штук",
        status: "favorited",
        shipping_mode: "FBS",
      },
    ],
    scanRows: exhausted,
    minimumActiveSources: 10,
    maximumActiveSources: 10,
  });
  const searchTexts = portfolio.active_urls.flatMap((value) => {
    const url = new URL(value);
    return url.pathname === "/search/" ? [url.searchParams.get("text")] : [];
  });

  assert.equal(portfolio.active_urls.length, 10);
  assert.equal(portfolio.counts.exploration_sources, 10);
  assert.ok(searchTexts.some((text) => /зажимы пакетов пластиковые/u.test(String(text))));
  assert.ok(searchTexts.some((text) => /контейнер мелочей пластиковый/u.test(String(text))));
});
