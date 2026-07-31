import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { refreshSourcePortfolio } from "../scripts/ozon_source_portfolio.mjs";
import {
  buildStrictSellerSourcePolicy,
  sellerRootUrl,
} from "../scripts/flow_b_playwright/source-policy.mjs";

const NOW = "2026-07-29T12:00:00.000Z";
const WINDOW_START = "2026-07-29T10:00:00.000Z";
const sellerA = "https://www.ozon.ru/seller/alpha/";
const sellerB = "https://www.ozon.ru/seller/beta/";
const sellerNew = "https://www.ozon.ru/seller/new-seller/";

function detail(sku, sellerUrl, at = "2026-07-29T10:30:00.000Z") {
  return {
    at,
    sku,
    stage: "ozon_detail_and_category",
    seller_url: sellerUrl,
  };
}

function strict(sku, sellerUrl, overrides = {}) {
  return {
    published_at: "2026-07-29T11:00:00.000Z",
    submitted_at: "2026-07-29T10:45:00.000Z",
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
    ...overrides,
  };
}

function historicalYield(sku, sellerUrl, overrides = {}) {
  return {
    at: "2026-07-28T09:00:00.000Z",
    sku,
    source_url: sellerUrl,
    seller_url: sellerUrl,
    status: "skipped",
    reason: "historical-detail-attempt",
    ...overrides,
  };
}

function historicalStrict(sku, sellerUrl, overrides = {}) {
  return historicalYield(sku, sellerUrl, {
    status: "published",
    reason: null,
    strict_confirmed: true,
    online_status: "selling",
    stock: 1,
    profit_rate: 31,
    shipping_mode: "FBS",
    ...overrides,
  });
}

async function portfolioFixture(t) {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strict-seller-policy-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const runDir = path.join(stateRoot, "runs", "window");
  const seedFile = path.join(stateRoot, "seed.txt");
  await fs.mkdir(path.join(stateRoot, "history"), { recursive: true });
  await fs.mkdir(runDir, { recursive: true });
  return { stateRoot, runDir, seedFile };
}

test("seller root normalization rejects search, highlight, and product URLs", () => {
  assert.equal(sellerRootUrl(`${sellerA}?page=12`), sellerA);
  assert.equal(sellerRootUrl("https://www.ozon.ru/search/?text=toy"), null);
  assert.equal(sellerRootUrl("https://www.ozon.ru/highlight/toys/"), null);
  assert.equal(sellerRootUrl("https://www.ozon.ru/product/item-123/"), null);
});

test("policy score is unique strict divided by unique detail attempts", () => {
  const policy = buildStrictSellerSourcePolicy({
    detailAttempts: [
      detail("a", sellerA),
      detail("a", `${sellerA}?page=2`),
      detail("b", sellerA),
      detail("c", sellerA),
    ],
    publications: [
      strict("a", sellerA),
      strict("a", `${sellerA}?page=2`),
    ],
    explorationSellerUrls: [sellerNew],
    windowStartedAt: WINDOW_START,
    now: NOW,
    rng: () => 0,
  });

  const score = policy.sellers.find((row) => row.seller_url === sellerA);
  assert.equal(score.unique_detail_attempts, 3);
  assert.equal(score.unique_strict, 1);
  assert.equal(score.score, 1 / 3);
});

test("strict publication without a same-window seller detail attempt cannot inflate source score", () => {
  const policy = buildStrictSellerSourcePolicy({
    detailAttempts: [detail("attempted", sellerA)],
    publications: [strict("different-sku", sellerA)],
    explorationSellerUrls: [sellerNew],
    windowStartedAt: WINDOW_START,
    now: NOW,
    rng: () => 0,
  });
  const score = policy.sellers.find((row) => row.seller_url === sellerA);
  assert.equal(score.unique_detail_attempts, 1);
  assert.equal(score.unique_strict, 0);
  assert.equal(score.score, 0);
});

test("carry-in submission confirmed in the score window cannot inflate seller yield", () => {
  const policy = buildStrictSellerSourcePolicy({
    detailAttempts: [detail("carry-in", sellerA)],
    publications: [strict("carry-in", sellerA, {
      submitted_at: "2026-07-29T09:59:59.000Z",
    })],
    explorationSellerUrls: [sellerNew],
    windowStartedAt: WINDOW_START,
    now: NOW,
    rng: () => 0,
  });
  const score = policy.sellers.find((row) => row.seller_url === sellerA);
  assert.equal(score.unique_detail_attempts, 1);
  assert.equal(score.unique_strict, 0);
  assert.equal(score.score, 0);
});

test("strict evidence never counts relaxed quality or the excluded SKU", () => {
  const invalid = [
    strict("profit-equal", sellerA, { profit_rate: 30 }),
    strict("zero-stock", sellerA, { stock: 0 }),
    strict("not-selling", sellerA, { online_status: "ready_to_sell" }),
    strict("not-fbs", sellerA, { shipping_mode: "FBP" }),
    strict("not-confirmed", sellerA, { strict_confirmed: false }),
    strict("fbs-unverified", sellerA, { fbs_evidence: { verified: false } }),
    strict("cost-unverified", sellerA, { cost_verified: false }),
    strict("cost-missing", sellerA, { cost: { ok: false, cost: 0 } }),
    strict("quality-gate-missing", sellerA, { quality_gate_passed: false }),
    strict("2815247918", sellerA),
  ];
  const policy = buildStrictSellerSourcePolicy({
    detailAttempts: invalid.map((row) => detail(row.sku, sellerA)),
    publications: invalid,
    explorationSellerUrls: [sellerNew],
    windowStartedAt: WINDOW_START,
    now: NOW,
    rng: () => 0,
  });

  assert.equal(policy.sellers.find((row) => row.seller_url === sellerA)?.unique_strict, 0);
  assert.equal(policy.derived_search_enabled, false);
});

test("ten source slots are nine verified seller exploitation and one new seller exploration", () => {
  const policy = buildStrictSellerSourcePolicy({
    detailAttempts: [
      detail("a", sellerA),
      detail("b", sellerB),
    ],
    publications: [
      strict("a", sellerA),
      strict("b", sellerB),
    ],
    explorationSellerUrls: [
      sellerNew,
      "https://www.ozon.ru/search/?text=must-not-return",
    ],
    windowStartedAt: WINDOW_START,
    now: NOW,
    slots: 10,
    rng: () => 0,
  });

  assert.equal(policy.allocation.exploit, 9);
  assert.equal(policy.allocation.explore, 1);
  assert.equal(policy.active_urls.length, 10);
  assert.ok(policy.active_urls.every((url) => sellerRootUrl(url)));
  assert.equal(policy.active_urls.filter((url) => sellerRootUrl(url) === sellerNew).length, 1);
  assert.equal(policy.active_urls.some((url) => url.includes("/search/")), false);
});

test("exploration sellers are sampled without replacement while candidates remain", () => {
  const sellerOther = "https://www.ozon.ru/seller/other-new-seller/";
  const policy = buildStrictSellerSourcePolicy({
    detailAttempts: [detail("a", sellerA)],
    publications: [strict("a", sellerA)],
    explorationSellerUrls: [sellerNew, sellerOther],
    windowStartedAt: WINDOW_START,
    now: NOW,
    slots: 20,
    rng: () => 0,
  });
  const explorationRoots = policy.active_urls.slice(-2).map(sellerRootUrl);

  assert.deepEqual(policy.allocation, { exploit: 18, explore: 2 });
  assert.equal(new Set(explorationRoots).size, 2);
});

test("source decision is deterministic with an injected random sequence", () => {
  const input = {
    detailAttempts: [detail("a", sellerA), detail("b", sellerB)],
    publications: [strict("a", sellerA), strict("b", sellerB)],
    explorationSellerUrls: [sellerNew],
    windowStartedAt: WINDOW_START,
    now: NOW,
    slots: 10,
  };
  const sequence = [0.9, 0.1, 0.7, 0.2, 0.8, 0.3, 0.6, 0.4, 0.5, 0];
  const createRng = () => {
    let index = 0;
    return () => sequence[index++ % sequence.length];
  };

  assert.deepEqual(
    buildStrictSellerSourcePolicy({ ...input, rng: createRng() }).active_urls,
    buildStrictSellerSourcePolicy({ ...input, rng: createRng() }).active_urls,
  );
});

test("policy is reused for two hours and recalculated only after freeze expiry", () => {
  const first = buildStrictSellerSourcePolicy({
    detailAttempts: [detail("a", sellerA)],
    publications: [strict("a", sellerA)],
    explorationSellerUrls: [sellerNew],
    windowStartedAt: WINDOW_START,
    now: NOW,
    rng: () => 0,
  });
  const reused = buildStrictSellerSourcePolicy({
    detailAttempts: [detail("b", sellerB, "2026-07-29T12:30:00.000Z")],
    publications: [strict("b", sellerB, { published_at: "2026-07-29T12:31:00.000Z" })],
    explorationSellerUrls: [sellerNew],
    previousDecision: first,
    windowStartedAt: WINDOW_START,
    now: "2026-07-29T13:59:59.999Z",
    rng: () => 0.99,
  });
  const refreshed = buildStrictSellerSourcePolicy({
    detailAttempts: [detail("b", sellerB, "2026-07-29T12:30:00.000Z")],
    publications: [strict("b", sellerB, { published_at: "2026-07-29T12:31:00.000Z" })],
    explorationSellerUrls: [sellerNew],
    previousDecision: first,
    windowStartedAt: WINDOW_START,
    now: "2026-07-29T14:00:00.001Z",
    rng: () => 0,
  });

  assert.equal(reused.reason, "frozen-policy-reused");
  assert.deepEqual(reused.active_urls, first.active_urls);
  assert.equal(refreshed.reason, "strict-seller-policy-refreshed");
  assert.ok(refreshed.active_urls.some((url) => sellerRootUrl(url) === sellerB));
});

test("a frozen legacy decision containing derived search is discarded immediately", () => {
  const policy = buildStrictSellerSourcePolicy({
    detailAttempts: [detail("a", sellerA)],
    publications: [strict("a", sellerA)],
    explorationSellerUrls: [sellerNew],
    previousDecision: {
      policy_version: 1,
      frozen_until: "2026-07-29T14:00:00.000Z",
      derived_search_enabled: true,
      active_urls: ["https://www.ozon.ru/search/?text=legacy"],
    },
    windowStartedAt: WINDOW_START,
    now: NOW,
    rng: () => 0,
  });
  assert.equal(policy.reason, "strict-seller-policy-refreshed");
  assert.equal(policy.derived_search_enabled, false);
  assert.ok(policy.active_urls.every((url) => sellerRootUrl(url)));
});

test("without a verified seller every slot explores seller URLs only", () => {
  const policy = buildStrictSellerSourcePolicy({
    detailAttempts: [detail("a", sellerA)],
    publications: [],
    explorationSellerUrls: [sellerA, sellerNew, "https://www.ozon.ru/search/?text=no"],
    windowStartedAt: WINDOW_START,
    now: NOW,
    slots: 10,
    rng: () => 0,
  });

  assert.deepEqual(policy.allocation, { exploit: 0, explore: 10 });
  assert.equal(policy.active_urls.length, 10);
  assert.ok(policy.active_urls.every((url) => sellerRootUrl(url)));
});

test("portfolio uses verified historical strict yield as a zero-current 90/10 bootstrap", async (t) => {
  const { stateRoot, runDir, seedFile } = await portfolioFixture(t);
  await fs.writeFile(seedFile, `${sellerNew}\n`);
  await fs.writeFile(path.join(stateRoot, "history", "source_yield_history.jsonl"), [
    historicalStrict("history-strict", sellerA),
    historicalStrict("history-strict", sellerA),
    historicalYield("history-attempt-only", sellerA),
    historicalYield("exploration-attempt", sellerNew),
  ].map(JSON.stringify).join("\n"));
  await fs.writeFile(
    path.join(runDir, "stage_timings.jsonl"),
    `${JSON.stringify(detail("current-attempt", sellerNew))}\n`,
  );

  const portfolio = await refreshSourcePortfolio({
    stateRoot,
    runDir,
    seedFile,
    minimumActiveSources: 10,
    now: new Date(NOW),
    rng: () => 0,
  });
  const historicalSeller = portfolio.policy.sellers.find(
    (row) => row.seller_url === sellerA,
  );

  assert.equal(portfolio.policy.reason, "historical-strict-bootstrap-refreshed");
  assert.equal(portfolio.policy.evidence_mode, "historical-strict-bootstrap");
  assert.deepEqual(portfolio.policy.allocation, { exploit: 9, explore: 1 });
  assert.equal(portfolio.policy.current_window.unique_strict, 0);
  assert.equal(portfolio.policy.historical_bootstrap.unique_strict, 1);
  assert.equal(historicalSeller.unique_detail_attempts, 2);
  assert.equal(historicalSeller.unique_strict, 1);
  assert.equal(historicalSeller.score, 0.5);
  assert.equal(portfolio.counts.current_window_unique_strict, 0);
  assert.equal(portfolio.counts.historical_bootstrap_unique_strict, 1);
  assert.equal(
    portfolio.active_urls.slice(0, 9).every((url) => sellerRootUrl(url) === sellerA),
    true,
  );
  assert.equal(sellerRootUrl(portfolio.active_urls.at(-1)), sellerNew);

  await fs.writeFile(
    path.join(runDir, "stage_timings.jsonl"),
    `${JSON.stringify(detail(
      "new-current-strict",
      sellerB,
      "2026-07-29T12:30:00.000Z",
    ))}\n`,
  );
  await fs.writeFile(
    path.join(runDir, "published.jsonl"),
    `${JSON.stringify(strict("new-current-strict", sellerB, {
      submitted_at: "2026-07-29T12:31:00.000Z",
      published_at: "2026-07-29T12:32:00.000Z",
    }))}\n`,
  );
  const frozen = await refreshSourcePortfolio({
    stateRoot,
    runDir,
    seedFile,
    minimumActiveSources: 10,
    now: new Date("2026-07-29T13:00:00.000Z"),
    rng: () => 0.99,
  });
  assert.equal(frozen.policy.reason, "historical-strict-bootstrap-frozen-reused");
  assert.deepEqual(frozen.active_urls, portfolio.active_urls);
});

test("historical published rows without explicit strict confirmation never bootstrap exploitation", async (t) => {
  const { stateRoot, runDir, seedFile } = await portfolioFixture(t);
  await fs.writeFile(seedFile, `${sellerNew}\n`);
  await fs.writeFile(
    path.join(stateRoot, "history", "source_yield_history.jsonl"),
    `${JSON.stringify(historicalStrict("legacy-published", sellerA, {
      strict_confirmed: undefined,
    }))}\n`,
  );

  const portfolio = await refreshSourcePortfolio({
    stateRoot,
    runDir,
    seedFile,
    minimumActiveSources: 10,
    now: new Date(NOW),
    rng: () => 0,
  });

  assert.equal(portfolio.policy.evidence_mode, "current-window");
  assert.equal(portfolio.policy.historical_bootstrap.unique_strict, 0);
  assert.deepEqual(portfolio.policy.allocation, { exploit: 0, explore: 10 });
});

test("current-window strict evidence takes sole precedence over historical bootstrap sellers", async (t) => {
  const { stateRoot, runDir, seedFile } = await portfolioFixture(t);
  await fs.writeFile(seedFile, `${sellerNew}\n`);
  await fs.writeFile(
    path.join(stateRoot, "history", "source_yield_history.jsonl"),
    `${JSON.stringify(historicalStrict("history-strict", sellerA))}\n`,
  );
  await fs.writeFile(
    path.join(runDir, "stage_timings.jsonl"),
    `${JSON.stringify(detail("current-strict", sellerB))}\n`,
  );
  await fs.writeFile(
    path.join(runDir, "published.jsonl"),
    `${JSON.stringify(strict("current-strict", sellerB))}\n`,
  );

  const portfolio = await refreshSourcePortfolio({
    stateRoot,
    runDir,
    seedFile,
    minimumActiveSources: 10,
    now: new Date(NOW),
    rng: () => 0,
  });

  assert.equal(portfolio.policy.reason, "strict-seller-policy-refreshed");
  assert.equal(portfolio.policy.evidence_mode, "current-window");
  assert.equal(portfolio.policy.current_window.unique_strict, 1);
  assert.equal(portfolio.policy.historical_bootstrap.unique_strict, 1);
  assert.equal(portfolio.policy.sellers.some((row) => row.seller_url === sellerA), false);
  assert.equal(
    portfolio.active_urls.slice(0, 9).every((url) => sellerRootUrl(url) === sellerB),
    true,
  );
});

test("verified bootstrap evidence invalidates a frozen all-exploration decision", async (t) => {
  const { stateRoot, runDir, seedFile } = await portfolioFixture(t);
  await fs.writeFile(seedFile, `${sellerNew}\n`);
  await fs.writeFile(
    path.join(stateRoot, "history", "source_yield_history.jsonl"),
    `${JSON.stringify(historicalStrict("history-strict", sellerA))}\n`,
  );
  await fs.mkdir(path.join(stateRoot, "sources"), { recursive: true });
  await fs.writeFile(path.join(stateRoot, "sources", "source_portfolio.json"), JSON.stringify({
    policy: {
      policy_version: 1,
      generated_at: NOW,
      frozen_until: "2026-07-29T14:00:00.000Z",
      derived_search_enabled: false,
      allocation: { exploit: 0, explore: 10 },
      active_urls: Array.from({ length: 10 }, (_, index) => (
        `${sellerNew}?page=${index + 1}`
      )),
    },
  }));

  const portfolio = await refreshSourcePortfolio({
    stateRoot,
    runDir,
    seedFile,
    minimumActiveSources: 10,
    now: new Date("2026-07-29T12:30:00.000Z"),
    rng: () => 0,
  });

  assert.equal(portfolio.policy.reason, "historical-strict-bootstrap-refreshed");
  assert.deepEqual(portfolio.policy.allocation, { exploit: 9, explore: 1 });
  assert.equal(portfolio.policy.historical_bootstrap.unique_strict, 1);
});

test("portfolio refresh persists the frozen seller-only policy and never emits search", async (t) => {
  const { stateRoot, runDir, seedFile } = await portfolioFixture(t);
  await fs.writeFile(seedFile, [
    sellerA,
    sellerNew,
    "https://www.ozon.ru/search/?text=must-stay-disabled",
  ].join("\n"));
  await fs.writeFile(path.join(runDir, "acceptance_window.json"), JSON.stringify({
    started_at: "2026-07-29T00:00:00.000Z",
  }));
  await fs.writeFile(path.join(runDir, "stage_timings.jsonl"), [
    detail("a", null, "2026-07-29T10:30:00.000Z"),
    detail("b", null, "2026-07-29T10:31:00.000Z"),
  ].map(JSON.stringify).join("\n"));
  await fs.writeFile(path.join(runDir, "source_yield.jsonl"), [
    { at: "2026-07-29T10:30:01.000Z", sku: "a", source_url: sellerA, status: "published" },
    { at: "2026-07-29T10:31:01.000Z", sku: "b", source_url: sellerA, status: "skipped" },
  ].map(JSON.stringify).join("\n"));
  await fs.writeFile(path.join(runDir, "published.jsonl"), `${JSON.stringify({
    ...strict("a", sellerA),
    status: "published",
  })}\n`);

  const portfolio = await refreshSourcePortfolio({
    stateRoot,
    runDir,
    seedFile,
    minimumActiveSources: 10,
    now: new Date(NOW),
    rng: () => 0,
  });
  const persisted = JSON.parse(
    await fs.readFile(path.join(stateRoot, "sources", "source_portfolio.json"), "utf8"),
  );

  assert.equal(portfolio.policy.derived_search_enabled, false);
  assert.equal(portfolio.policy.allocation.exploit, 9);
  assert.equal(portfolio.policy.allocation.explore, 1);
  assert.equal(persisted.policy.policy_version, 1);
  assert.ok(portfolio.active_urls.every((url) => sellerRootUrl(url)));
  assert.doesNotMatch(
    await fs.readFile(path.join(stateRoot, "sources", "active_urls.txt"), "utf8"),
    /\/search\//u,
  );
});
