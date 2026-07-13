import test from "node:test";
import assert from "node:assert/strict";

import { createPublishRunner } from "../scripts/flow_b_playwright/publish-runner.mjs";

function fakeState(initial = {}, initialRunPublished = 0) {
  const statuses = new Map(Object.entries(initial));
  const transitions = [];
  const records = [];
  return {
    transitions,
    records,
    load: async () => {},
    runPublishedCount: () => initialRunPublished + records.length,
    hasPublished: (sku) => statuses.get(String(sku)) === "published",
    statusOf: (sku) => statuses.get(String(sku)) || null,
    transition: async (sku, status, data) => {
      statuses.set(String(sku), status);
      transitions.push({ sku: String(sku), status, data });
      return true;
    },
    recordPublished: async (item) => {
      const sku = String(item.sku);
      if (statuses.get(sku) === "published") return false;
      statuses.set(sku, "published");
      records.push(item);
      return true;
    },
    summary: (target) => ({ published: [...statuses.values()].filter((x) => x === "published").length, remaining: target }),
  };
}

function economy(rate = 40, overrides = {}) {
  return {
    calc_result: [{
      name: "CEL",
      speed: "economy",
      title: "CEL Economy Small",
      price_list: {
        logistics_name: "CEL",
        logistics_speed: "economy",
        purchase_price: 20,
        sell_price: 90,
        cate_rate: 12,
        cate_fee: 8,
        profit_rate: rate,
        ...overrides,
      },
    }],
  };
}

function clientFor(items, overrides = {}) {
  return {
    resolvePublishTarget: async () => ({ store: { id: 7, name: "丽丽1号" }, watermark: { id: 8, name: "lysh" } }),
    listFavorites: async () => items,
    getProductDetail: async (sku) => ({ sku, mode: "FBS", title: "safe item", current_price: 100, follow_min: 90 }),
    getCategoryBySku: async () => ({ cate: [11, 22, "1,12.00"], product_info: { weight: 100, depth: 20, width: 10, height: 5 } }),
    calculateProfit: async () => economy(),
    publish: async () => ({ ok: true, response: { code: 1 } }),
    findPublishedSku: async () => null,
    ...overrides,
  };
}

test("runner records a failed SKU and continues until confirmed success target", async () => {
  const state = fakeState();
  const detailCalls = [];
  const items = [{ id: 1, sku: 1, cover_image: "one.jpg" }, { id: 2, sku: 2, cover_image: "two.jpg" }, { id: 3, sku: 3 }];
  const client = clientFor(items, {
    getProductDetail: async (sku) => {
      detailCalls.push(String(sku));
      return { sku, mode: "FBS", title: "safe", current_price: 100, follow_min: 90 };
    },
    publish: async (payload) => payload.rows[0].sku === "1" ? { ok: false, response: { code: 0 } } : { ok: true, response: { code: 1 } },
  });
  const runner = createPublishRunner({ client, costBridge: { estimate: async () => ({ ok: true, cost: 20 }) }, state, target: 1, threshold: 30, runDir: "/tmp/run" });
  const result = await runner.run();

  assert.equal(result.published, 1);
  assert.ok(state.transitions.some((event) => event.sku === "1" && event.status === "failed"));
  assert.equal(state.records[0].sku, "2");
  assert.deepEqual(detailCalls, ["1", "2"]);
});

test("runner rejects profit rate exactly 30 and never publishes it", async () => {
  const state = fakeState();
  let publishCalls = 0;
  const client = clientFor([{ id: 3, sku: 3 }], {
    calculateProfit: async () => economy(30),
    publish: async () => { publishCalls += 1; return { ok: true }; },
  });
  const runner = createPublishRunner({ client, costBridge: { estimate: async () => ({ ok: true, cost: 20 }) }, state, target: 1, threshold: 30, runDir: "/tmp/run" });
  const result = await runner.run();
  assert.equal(result.published, 0);
  assert.equal(publishCalls, 0);
  assert.ok(state.transitions.some((event) => event.status === "skipped" && event.data.reason === "profit_rate<=30"));
});

test("runner reconciles restored failed SKU without resubmitting", async () => {
  const state = fakeState({ 4: "failed" });
  let publishCalls = 0;
  const client = clientFor([{ id: 4, sku: 4 }], {
    findPublishedSku: async (sku) => ({ sku, title: "already imported" }),
    publish: async () => { publishCalls += 1; return { ok: true }; },
  });
  const runner = createPublishRunner({ client, costBridge: { estimate: async () => ({ ok: true, cost: 20 }) }, state, target: 1, threshold: 30, runDir: "/tmp/run" });
  const result = await runner.run();
  assert.equal(result.published, 1);
  assert.equal(publishCalls, 0);
  assert.equal(state.records[0].reconciled, true);
});

test("runner requires an explicit CEL Economy result and positive category fee", async () => {
  const state = fakeState();
  const items = [{ id: 5, sku: 5 }, { id: 6, sku: 6 }];
  const client = clientFor(items, {
    calculateProfit: async ({ sku }) => String(sku) === "5" ? { calc_result: [] } : economy(45, { cate_fee: 0 }),
  });
  const runner = createPublishRunner({ client, costBridge: { estimate: async () => ({ ok: true, cost: 20 }) }, state, target: 1, threshold: 30, runDir: "/tmp/run" });
  const result = await runner.run();
  assert.equal(result.published, 0);
  assert.ok(state.transitions.some((event) => event.sku === "5" && event.data.reason === "missing-cel-economy"));
  assert.ok(state.transitions.some((event) => event.sku === "6" && event.data.reason === "cate_fee<=0"));
});

test("runner builds the exact one-row payload and stops at target", async () => {
  const state = fakeState();
  const payloads = [];
  let calculatedCate;
  const items = [{ id: 71, sku: 700001, title: "source title", cover_image: "cover.jpg", link: "https://www.ozon.ru/product/700001" }, { id: 72, sku: 700002 }];
  const client = clientFor(items, {
    getCategoryBySku: async () => ({ cate: [11, 22, 999], product_info: { weight: 100 } }),
    listCategoryCommissions: async () => [{ cate_id: 11, children: [{ cate_id: 22, children: [{ label: "售价 ≤ 1500₽", value: "1,12.00" }] }] }],
    calculateProfit: async (input) => { calculatedCate = input.cate; return economy(); },
    publish: async (payload) => { payloads.push(payload); return { ok: true, response: { code: 1 } }; },
  });
  const runner = createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    threshold: 30,
    runDir: "/tmp/run",
    now: () => new Date("2026-07-13T00:00:00Z"),
  });
  const result = await runner.run();
  assert.equal(result.published, 1);
  assert.deepEqual(calculatedCate, [11, 22, "1,12.00"]);
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0], {
    scene: "erp",
    shop_ids: [7],
    brand: "none",
    image_order: "none",
    watermark_id: 8,
    floating_price: null,
    rows: [{
      id: 71,
      sku: "700001",
      title: "safe item",
      cover_image: "cover.jpg",
      link: "https://www.ozon.ru/product/700001",
      sell_price: 90,
      price: 90,
      old_price: 180,
      offer_id: "mz-130726-700001",
      brand: "",
      source: "favorite",
      source_currency: "CNY",
    }],
  });
});

test("historical duplicates do not consume target but resumed run successes do", async () => {
  const historicalState = fakeState({ 1: "published" }, 0);
  const client = clientFor([{ id: 1, sku: 1 }, { id: 2, sku: 2 }]);
  const first = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state: historicalState,
    target: 1,
  }).run();
  assert.equal(first.published, 1);
  assert.equal(historicalState.records[0].sku, "2");

  const resumedState = fakeState({ 9: "published" }, 1);
  let publishCalls = 0;
  const resumed = await createPublishRunner({
    client: clientFor([{ id: 10, sku: 10 }], { publish: async () => { publishCalls += 1; return { ok: true }; } }),
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state: resumedState,
    target: 1,
  }).run();
  assert.equal(resumed.published, 1);
  assert.equal(publishCalls, 0);
});
