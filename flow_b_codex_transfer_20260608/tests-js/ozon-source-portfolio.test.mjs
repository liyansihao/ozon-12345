import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateSourceEvidence,
  buildSourcePortfolio,
} from "../scripts/ozon_source_portfolio.mjs";

const good = "https://www.ozon.ru/seller/safe-toys/";
const rejected = "https://www.ozon.ru/seller/rejected-source/";
const prohibited = "https://www.ozon.ru/seller/underwear-source/";
const dry = "https://www.ozon.ru/seller/ambiguous-source/";

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
