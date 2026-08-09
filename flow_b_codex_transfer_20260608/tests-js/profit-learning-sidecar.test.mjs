import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createProfitLearningSidecar,
  profitLearningPaths,
  runProfitLearningOnce,
} from "../scripts/flow_b_playwright/profit-learning-sidecar.mjs";

const NOW = new Date("2026-08-09T13:00:00.000Z");

async function fixture(t, report = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "profit-learning-sidecar-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const runtimeRoot = path.join(stateRoot, "profit_learning");
  const outputPath = path.join(root, "daily", "优先母款.json");
  await fs.mkdir(stateRoot, { recursive: true });
  if (report) {
    await fs.writeFile(
      path.join(stateRoot, "daily_pricing_report_status.json"),
      `${JSON.stringify(report)}\n`,
    );
  }
  return { root, stateRoot, runtimeRoot, outputPath };
}

function completeOrder(sequence, overrides = {}) {
  return {
    shop_id: 104965,
    sku: "OWN-SKU-1",
    vendor_code: "OWN-OFFER-1",
    order_id: `order-${sequence}`,
    status: "delivered",
    created_at: `2026-08-0${sequence}T10:00:00.000Z`,
    amount_cny: 100,
    purchase_cost_cny: 40,
    commission_cny: 10,
    international_logistics_cny: 15,
    last_mile_cny: 5,
    other_cost_cny: 0,
    refund_cny: 0,
    ...overrides,
  };
}

function liveMaoziOrder(sequence, overrides = {}) {
  return {
    order_id: `order-${sequence}`,
    shop_id: 104965,
    status: "delivered",
    in_process_at: `2026-08-0${sequence}T10:00:00.000Z`,
    update_time: `2026-08-0${sequence}T12:00:00.000Z`,
    products: [{
      name: "Kitchen organizer",
      offer_id: "OWN-OFFER-1",
      sku: "OWN-SKU-1",
      price: 100,
      quantity: 1,
    }],
    profit_list: {
      total_amount_cny: 100,
      total_cost: 40,
      sale_commission_cny: 10,
      processing_and_delivery_cny: 15,
      services_amount_cny: 5,
      others_amount_cny: 0,
      profit_cny: 30,
    },
    ...overrides,
  };
}

function productIndex() {
  const product = {
    source_sku: "SOURCE-1",
    store_id: 104965,
    store_sku: "OWN-SKU-1",
    offer_id: "OWN-OFFER-1",
    title: "Kitchen organizer",
    category: "Kitchen",
  };
  return {
    rows: [product],
    sourceSkuByStoreSku: new Map([
      ["104965:OWN-SKU-1", "SOURCE-1"],
      ["OWN-SKU-1", "SOURCE-1"],
    ]),
    sourceSkuByOfferId: new Map([
      ["104965:OWN-OFFER-1", "SOURCE-1"],
      ["OWN-OFFER-1", "SOURCE-1"],
    ]),
    resolve({ store_id: storeId, store_sku: storeSku, offer_id: offerId }) {
      return String(storeId) === "104965"
        && (storeSku === "OWN-SKU-1" || offerId === "OWN-OFFER-1")
        ? product
        : null;
    },
  };
}

test("waits on the fixed daily report status without calling Maozi", async (t) => {
  const value = await fixture(t, {
    status: "waiting",
    date: "2026-08-09",
  });
  let calls = 0;
  const result = await runProfitLearningOnce({
    ...value,
    now: () => NOW,
    maoziClient: {
      listOrders: async () => { calls += 1; return []; },
      listRefunds: async () => { calls += 1; return []; },
    },
  });

  assert.equal(result.status, "waiting");
  assert.equal(result.reason, "daily-report-not-delivered");
  assert.equal(calls, 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(value.runtimeRoot, "2026-08-09.json"), "utf8")).status, "waiting");
  assert.equal(JSON.parse(await fs.readFile(path.join(value.runtimeRoot, "status.json"), "utf8")).status, "waiting");
});

test("fetches the 30-day order/refund window, enriches mappings and atomically publishes priority mothers", async (t) => {
  const value = await fixture(t, {
    status: "delivered",
    date: "2026-08-09",
    delivered_at: "2026-08-09T12:45:00.000Z",
    output: "/tmp/Ozon人工核价_2026-08-09.xlsx",
  });
  const calls = [];
  const result = await runProfitLearningOnce({
    ...value,
    now: () => NOW,
    runtimeDbPath: "/unused/runtime.sqlite",
    sharedCachePath: "/unused/cache.json",
    maoziClient: {
      async listOrders(options) {
        calls.push(["orders", options]);
        return [liveMaoziOrder(1), liveMaoziOrder(2), liveMaoziOrder(3)];
      },
      async listRefunds(options) {
        calls.push(["refunds", options]);
        return [{
          shop_id: 104965,
          sku: "OTHER-SKU",
          vendor_code: "OTHER-OFFER",
          order_id: "other-refund",
          refunded_at: "2026-08-07T10:00:00.000Z",
          amount_cny: 20,
        }];
      },
    },
  }, {
    readProductIndex: async (options) => {
      assert.deepEqual(options, {
        runtimeDbPath: "/unused/runtime.sqlite",
        sharedCachePath: "/unused/cache.json",
      });
      return productIndex();
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.orders_fetched, 3);
  assert.equal(result.order_lines_fetched, 3);
  assert.equal(result.refunds_fetched, 1);
  assert.equal(result.mother_products_written, 1);
  assert.deepEqual(calls, [
    ["orders", { pageSize: 100, query: { in_process_at_start: "2026-07-10", in_process_at_end: "2026-08-09" } }],
    ["refunds", { pageSize: 100, query: { in_process_at_start: "2026-07-10", in_process_at_end: "2026-08-09" } }],
  ]);
  const output = JSON.parse(await fs.readFile(value.outputPath, "utf8"));
  assert.equal(output.report_date, "2026-08-09");
  assert.equal(output.stores[0].store_id, "104965");
  assert.equal(output.stores[0].mother_products[0].source_sku, "SOURCE-1");
  assert.equal(output.stores[0].mother_products[0].order_count, 3);
  assert.equal(output.stores[0].mother_products[0].real_profit_cny, 90);
  assert.equal(output.stores[0].mother_products[0].contribution_profit_cny, 90);
  assert.deepEqual((await fs.readdir(path.dirname(value.outputPath))).filter((name) => name.includes(".tmp-")), []);
});

test("completed date state makes retries idempotent while the output still exists", async (t) => {
  const report = {
    status: "delivered",
    date: "2026-08-09",
    delivered_at: "2026-08-09T12:45:00.000Z",
    output: "/tmp/Ozon人工核价_2026-08-09.xlsx",
  };
  const value = await fixture(t, report);
  await fs.mkdir(value.runtimeRoot, { recursive: true });
  await fs.mkdir(path.dirname(value.outputPath), { recursive: true });
  await fs.writeFile(value.outputPath, "{}\n");
  await fs.writeFile(path.join(value.runtimeRoot, "2026-08-09.json"), `${JSON.stringify({
    status: "completed",
    attempt: 1,
    output: value.outputPath,
    report_fingerprint: "2026-08-09|2026-08-09T12:45:00.000Z|/tmp/Ozon人工核价_2026-08-09.xlsx",
  })}\n`);
  let calls = 0;

  const result = await runProfitLearningOnce({
    ...value,
    now: () => NOW,
    maoziClient: {
      listOrders: async () => { calls += 1; return []; },
      listRefunds: async () => { calls += 1; return []; },
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.reason, "already-completed");
  assert.equal(result.reused, true);
  assert.equal(result.attempt, 1);
  assert.equal(calls, 0);
});

test("Maozi failures resolve as sidecar errors and only update sidecar state", async (t) => {
  const value = await fixture(t, {
    status: "delivered",
    date: "2026-08-09",
    delivered_at: "2026-08-09T12:45:00.000Z",
  });
  const result = await runProfitLearningOnce({
    ...value,
    now: () => NOW,
    maoziClient: {
      listOrders: async () => { throw new Error("ERP temporarily unavailable"); },
      listRefunds: async () => [],
    },
  });

  assert.equal(result.status, "error");
  assert.equal(result.reason, "profit-learning-run-failed");
  assert.match(result.error, /ERP temporarily unavailable/u);
  await assert.rejects(fs.access(value.outputPath));
  const status = JSON.parse(await fs.readFile(path.join(value.runtimeRoot, "status.json"), "utf8"));
  assert.equal(status.status, "error");
  assert.match(status.error, /ERP temporarily unavailable/u);
});

test("new manual feedback changes the fingerprint and removes a losing mother on the next poll", async (t) => {
  const value = await fixture(t, {
    status: "delivered",
    date: "2026-08-09",
    delivered_at: "2026-08-09T12:45:00.000Z",
    output: "/tmp/Ozon人工核价_2026-08-09.xlsx",
  });
  const feedbackDir = path.join(value.root, "核价反馈");
  const feedbackFile = path.join(value.root, "daily", "错误货源.json");
  const feedbackStateFile = path.join(value.runtimeRoot, "feedback_status.json");
  let revision = "feedback-a";
  let feedbackArtifact = {};
  let orderCalls = 0;
  const options = {
    ...value,
    feedbackDir,
    feedbackFile,
    feedbackStateFile,
    runtimeDbPath: "/unused/runtime.sqlite",
    now: () => NOW,
    maoziClientProvider: async () => ({
      async listOrders() {
        orderCalls += 1;
        return [completeOrder(1), completeOrder(2), completeOrder(3)];
      },
      async listRefunds() { return []; },
    }),
  };
  const dependencies = {
    async importFeedback(input) {
      await fs.mkdir(path.dirname(input.outputFile), { recursive: true });
      await fs.writeFile(input.outputFile, `${JSON.stringify(feedbackArtifact)}\n`);
      return { status: "completed", fingerprint: revision };
    },
    readProductIndex: async () => productIndex(),
  };

  const first = await runProfitLearningOnce(options, dependencies);
  assert.equal(first.mother_products_written, 1);
  assert.equal(orderCalls, 1);

  revision = "feedback-b";
  feedbackArtifact = {
    trusted: {
      cost_corrections: [{ store_id: 104965, source_sku: "SOURCE-1", result: "亏本" }],
    },
  };
  const second = await runProfitLearningOnce(options, dependencies);
  assert.equal(second.reused, undefined);
  assert.equal(second.mother_products_written, 0);
  assert.equal(second.feedback_fingerprint, "feedback-b");
  assert.equal(orderCalls, 2);
});

test("explicit report-date mismatch remains waiting and does not overwrite another date", async (t) => {
  const value = await fixture(t, {
    status: "delivered",
    date: "2026-08-08",
    delivered_at: "2026-08-08T12:45:00.000Z",
  });
  const result = await runProfitLearningOnce({
    ...value,
    dateKey: "2026-08-09",
    now: () => NOW,
    maoziClient: { listOrders: async () => [], listRefunds: async () => [] },
  });
  assert.equal(result.status, "waiting");
  assert.equal(result.reason, "daily-report-date-mismatch");
  assert.equal(result.report_date, "2026-08-08");
  assert.equal((await fs.readdir(value.runtimeRoot)).includes("2026-08-08.json"), false);
  assert.equal((await fs.readdir(value.runtimeRoot)).includes("2026-08-09.json"), true);
});

test("environment status path is honored without requiring another sidecar env", () => {
  const paths = profitLearningPaths({
    stateRoot: "/tmp/ozon-state",
    env: {
      FLOW_B_PROFIT_LEARNING_STATUS: "/tmp/custom-profit/status.json",
    },
  });
  assert.equal(paths.runtime_root, "/tmp/custom-profit");
  assert.equal(paths.status, "/tmp/custom-profit/status.json");
  assert.equal(paths.report_status, "/tmp/ozon-state/daily_pricing_report_status.json");
});

test("start and stop schedule polling without awaiting network work", () => {
  const scheduled = [];
  const cleared = [];
  const sidecar = createProfitLearningSidecar({ intervalMs: 50 }, {
    setTimeout(callback, delay) {
      const handle = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout(handle) { cleared.push(handle); },
  });

  assert.deepEqual(sidecar.status(), {
    running: false,
    scheduled: false,
    in_flight: false,
    last_result: null,
  });
  assert.deepEqual(sidecar.start(), { running: true, scheduled: true, in_flight: false });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 0);
  assert.equal(scheduled[0].unrefCalled, true);
  assert.deepEqual(sidecar.start(), { running: true, scheduled: true, in_flight: false });
  assert.equal(scheduled.length, 1);
  assert.deepEqual(sidecar.stop(), { running: false, scheduled: false, in_flight: false });
  assert.deepEqual(cleared, [scheduled[0]]);
});
