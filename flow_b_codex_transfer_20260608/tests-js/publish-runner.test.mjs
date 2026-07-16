import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPublishRunner, offerIdForSku, prioritizePublishCandidates, restoredDailyStoreUsage } from "../scripts/flow_b_playwright/publish-runner.mjs";

function fakeState(initial = {}, initialRunPublished = 0) {
  const statuses = new Map(Object.entries(initial).map(([sku, value]) => [sku,
    typeof value === "string" ? { status: value, data: {} } : { status: value.status, data: { ...(value.data || {}) } },
  ]));
  const transitions = [];
  const records = [];
  const selections = [];
  return {
    transitions,
    records,
    selections,
    load: async () => {},
    runPublishedCount: () => initialRunPublished + records.length,
    hasPublished: (sku) => statuses.get(String(sku))?.status === "published",
    statusOf: (sku) => statuses.get(String(sku))?.status || null,
    entries: () => [...statuses].map(([sku, value]) => ({ sku, status: value.status, data: { ...value.data } })),
    transition: async (sku, status, data) => {
      statuses.set(String(sku), { status, data: { ...(data || {}) } });
      transitions.push({ sku: String(sku), status, data });
      return true;
    },
    recordPublished: async (item) => {
      const sku = String(item.sku);
      if (statuses.get(sku)?.status === "published") return false;
      statuses.set(sku, { status: "published", data: { ...item } });
      records.push(item);
      return true;
    },
    recordSelected: async (item) => { selections.push({ ...item }); return true; },
    summary: (target) => ({ published: [...statuses.values()].filter((x) => x.status === "published").length, remaining: target }),
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
    findImportLog: async ({ sku }) => ({ sku, offer_id: `mz-test-${sku}`, import_status: "all_imported" }),
    findOnlineProduct: async ({ offerId }) => ({ sku: 900001, offer_id: offerId, online_status: "selling", stock: 1 }),
    deleteFavorite: async () => true,
    findPublishedSku: async () => null,
    ...overrides,
  };
}

test("publish candidates prioritize observed strict-yield titles independently of API order", () => {
  const items = [
    { sku: "ordinary-low", title: "Воздушные шары из фольги", sell_price: 10 },
    { sku: "ordinary-high", title: "Рюкзак", sell_price: 60 },
    { sku: "toy", title: "Детская игрушка" },
    { sku: "hat", title: "Панама для девочек" },
    { sku: "underwear", title: "Комплект трусов" },
  ];
  assert.deepEqual(prioritizePublishCandidates(items).map((item) => item.sku), [
    "underwear",
    "hat",
    "ordinary-high",
    "ordinary-low",
    "toy",
  ]);
});

test("publish candidates use current strict title-family feedback before static priority", () => {
  const scores = { toy: 950, socks: 0 };
  assert.deepEqual(prioritizePublishCandidates([
    { sku: "socks", title: "Носки для девочек" },
    { sku: "toy", title: "Детская игрушка погремушка" },
  ], new Set(), scores).map((item) => item.sku), ["toy", "socks"]);
});

test("publish candidates prefer a productive source over a stronger static title guess", () => {
  const strongSource = "https://www.ozon.ru/search/?text=productive&currency_price=150.000%3B";
  const weakSource = "https://www.ozon.ru/search/?text=dry&currency_price=150.000%3B";
  const sourceScores = new Map([
    [strongSource, 50_000],
    [weakSource, 0],
  ]);
  assert.deepEqual(prioritizePublishCandidates([
    { sku: "static-underwear", title: "Комплект трусов", source_url: weakSource },
    { sku: "productive-toy", title: "Детская игрушка", source_url: strongSource },
  ], new Set(), {}, sourceScores).map((item) => item.sku), ["productive-toy", "static-underwear"]);
});

test("fresh favorites are scheduled before a large restored reconciliation backlog", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-fresh-fairness-"));
  const restored = {};
  for (let index = 0; index < 16; index += 1) {
    restored[`old-${index}`] = {
      status: "processing",
      data: {
        sku: `old-${index}`,
        title: "Комплект трусов",
        store_id: 104965,
        submitted: true,
        submission_pending: true,
        offer_id: `mz-old-${index}`,
        prepared_at: "2026-07-15T08:00:00.000Z",
        next_reconcile_at: "2026-07-15T09:00:00.000Z",
      },
    };
  }
  const state = fakeState(restored);
  const events = [];
  const client = clientFor([{ id: 900, sku: "fresh-900", title: "ordinary safe item" }], {
    findImportLog: async ({ sku, offerId }) => {
      events.push(`reconcile:${sku}`);
      return { sku, offer_id: offerId, import_status: "pending" };
    },
    publish: async () => {
      events.push("publish:fresh-900");
      return { ok: true, response: { code: 1 } };
    },
  });

  await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    runDir,
    now: () => new Date("2026-07-15T10:00:00.000Z"),
    pendingStoreStallCount: 99,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(events[0], "publish:fresh-900");
});

test("offer IDs retain the complete SKU and cannot collide on a six-digit suffix", () => {
  const now = new Date("2026-07-15T00:00:00Z");
  assert.equal(offerIdForSku("4799637133", now), "mz-150726-4799637133");
  assert.notEqual(offerIdForSku("4799637133", now), offerIdForSku("1234637133", now));
});

test("runner does not count an accepted task that later hits the daily product limit", async () => {
  const state = fakeState();
  let publishCalls = 0;
  const client = clientFor([{ id: 91, sku: 3761127274 }], {
    publish: async () => { publishCalls += 1; return { ok: true, response: { code: 1 } }; },
    findImportLog: async () => ({
      sku: 3761127274,
      offer_id: "mz-140726-127274",
      import_status: "all_failed",
      skus: [{ error_msg: "Не получится загрузить товары: вы исчерпали суточный лимит" }],
    }),
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(publishCalls, 1);
  assert.equal(result.published, 0);
  assert.equal(result.halt_reason, "daily-product-limit");
  assert.equal(state.records.length, 0);
  assert.ok(state.transitions.some((event) => event.status === "failed" && event.data.reason === "daily-product-limit"));
});

test("runner rotates to the next verified store after a daily creation limit", async () => {
  const state = fakeState();
  const shopIds = [];
  const client = clientFor([{ id: 201, sku: 201 }, { id: 202, sku: 202 }], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: Number(storeId) === 104965 ? "丽丽1号" : "丽丽二号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async (payload) => {
      shopIds.push(payload.shop_ids[0]);
      return { ok: true, response: { code: 1 } };
    },
    findImportLog: async ({ shopId, sku, offerId }) => Number(shopId) === 104965 ? ({
      sku,
      offer_id: offerId,
      import_status: "all_failed",
      skus: [{ error_msg: "вы исчерпали суточный лимит" }],
    }) : ({ sku, offer_id: offerId, import_status: "all_imported" }),
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    storeTargets: [
      { id: 104965, needle: "丽丽1号", warehouseId: 1020005022957960 },
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.deepEqual(shopIds, [104965, 106637]);
  assert.equal(state.records[0].store_id, 106637);
  assert.equal(result.halt_reason, null);
  assert.deepEqual(result.store_switches, [{ from_store_id: 104965, to_store_id: 106637, reason: "daily-product-limit" }]);
});

test("runner skips a store whose daily creation quota is already exhausted", async () => {
  const state = fakeState();
  const shopIds = [];
  const client = clientFor([{ id: 203, sku: 203 }], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: {
        id: Number(storeId),
        name: Number(storeId) === 104965 ? "丽丽1号" : "丽丽二号",
        product_limit: {
          daily_create: Number(storeId) === 104965
            ? { limit: 100, usage: 100 }
            : { limit: 100, usage: 0 },
        },
      },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async (payload) => {
      shopIds.push(payload.shop_ids[0]);
      return { ok: true, response: { code: 1 } };
    },
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    storeTargets: [
      { id: 104965, needle: "丽丽1号", warehouseId: 1020005022957960 },
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.deepEqual(shopIds, [106637]);
  assert.equal(result.active_store_id, 106637);
  assert.deepEqual(result.store_switches, [{ from_store_id: 104965, to_store_id: 106637, reason: "daily-product-limit" }]);
});

test("date-scoped prior-run usage rotates after the combined store total reaches its cap", async () => {
  const state = fakeState();
  const shopIds = [];
  const client = clientFor([{ id: 207, sku: 207 }, { id: 208, sku: 208 }], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: Number(storeId) === 106637 ? "丽丽二号" : "丽丽三号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async (payload) => { shopIds.push(payload.shop_ids[0]); return { ok: true }; },
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 2,
    now: () => new Date("2026-07-15T10:00:00.000Z"),
    dailyStoreLimit: 2,
    dailyStoreUsageSeed: { date: "2026-07-15", usage: { 106637: 1 } },
    storeTargets: [
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
      { id: 106640, needle: "丽丽三号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();
  assert.equal(result.published, 2);
  assert.deepEqual(shopIds, [106637, 106640]);
});

test("verified lifetime store target rotates independently of the daily quota", async () => {
  const state = fakeState();
  const shopIds = [];
  const client = clientFor([{ id: 211, sku: 211 }, { id: 212, sku: 212 }], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: Number(storeId) === 106637 ? "丽丽二号" : "丽丽三号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async (payload) => { shopIds.push(payload.shop_ids[0]); return { ok: true }; },
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 2,
    dailyStoreLimit: 100,
    totalStoreLimit: 100,
    totalStoreUsageSeed: { 106637: 99, 106640: 0 },
    storeTargets: [
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
      { id: 106640, needle: "丽丽三号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();
  assert.equal(result.published, 2);
  assert.deepEqual(shopIds, [106637, 106640]);
  assert.deepEqual(result.store_total_usage, { "106637": 100, "106640": 1 });
  assert.deepEqual(result.store_switches, [{ from_store_id: 106637, to_store_id: 106640, reason: "store-total-limit" }]);
});

test("a stalled pending-import backlog keeps reconciliation but routes fresh work to the next store", async () => {
  const state = fakeState({
    "old-1": { status: "processing", data: { store_id: 106637, submitted: true, prepared_at: "2026-07-15T09:00:00.000Z" } },
    "old-2": { status: "processing", data: { store_id: 106637, submission_pending: true, prepared_at: "2026-07-15T09:01:00.000Z" } },
  });
  const shopIds = [];
  const client = clientFor([{ id: 209, sku: 209 }], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: Number(storeId) === 106637 ? "丽丽二号" : "丽丽三号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async (payload) => { shopIds.push(payload.shop_ids[0]); return { ok: true }; },
    findImportLog: async ({ sku, offerId }) => String(sku).startsWith("old-")
      ? ({ sku, offer_id: offerId, import_status: "pending" })
      : ({ sku, offer_id: offerId, import_status: "all_imported" }),
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    now: () => new Date("2026-07-15T10:00:00.000Z"),
    pendingStoreStallMs: 60_000,
    pendingStoreStallCount: 2,
    storeTargets: [
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
      { id: 106640, needle: "丽丽三号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();
  assert.equal(result.published, 1);
  assert.deepEqual(shopIds, [106640]);
  assert.ok(result.store_switches.some((event) => event.from_store_id === 106637 && event.to_store_id === 106640 && event.reason === "submission-stall"));
});

test("an imported Ozon moderation backlog does not falsely stall fresh store submissions", async () => {
  const state = fakeState({
    "moderating-1": {
      status: "processing",
      data: {
        store_id: 106637,
        submitted: true,
        prepared_at: "2026-07-15T09:00:00.000Z",
        reason: "online-product-not-selling",
        import_log: { import_status: "all_imported" },
      },
    },
    "moderating-2": {
      status: "processing",
      data: {
        store_id: 106637,
        submitted: true,
        prepared_at: "2026-07-15T09:01:00.000Z",
        reason: "online-product-not-selling",
        import_log: { import_status: "all_imported" },
      },
    },
  });
  const shopIds = [];
  const client = clientFor([{ id: 211, sku: 211 }], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: Number(storeId) === 106637 ? "丽丽二号" : "丽丽三号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async (payload) => { shopIds.push(payload.shop_ids[0]); return { ok: true }; },
    findImportLog: async ({ sku, offerId }) => String(sku).startsWith("moderating-")
      ? ({ sku, offer_id: offerId, import_status: "all_imported" })
      : ({ sku, offer_id: offerId, import_status: "all_imported" }),
    findOnlineProduct: async ({ offerId }) => String(offerId).includes("moderating-")
      ? ({ sku: 0, offer_id: offerId, online_status: "unknown", stock: 0 })
      : ({ sku: 900001, offer_id: offerId, online_status: "selling", stock: 1 }),
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    now: () => new Date("2026-07-15T10:00:00.000Z"),
    pendingStoreStallMs: 60_000,
    pendingStoreStallCount: 2,
    storeTargets: [
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
      { id: 106640, needle: "丽丽三号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.deepEqual(shopIds, [106637]);
  assert.equal(result.store_switches.some((event) => event.reason === "submission-stall"), false);
});

test("runner rechecks a newly stalled import backlog between fresh publish batches", async () => {
  let current = new Date("2026-07-15T10:00:00.000Z");
  const state = fakeState();
  const shopIds = [];
  const client = clientFor([
    { id: 301, sku: 301 },
    { id: 302, sku: 302 },
    { id: 303, sku: 303 },
  ], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: Number(storeId) === 106637 ? "丽丽二号" : "丽丽三号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async (payload) => {
      shopIds.push(payload.shop_ids[0]);
      if (shopIds.length === 2) current = new Date("2026-07-15T10:10:00.000Z");
      return { ok: true, response: { code: 1 } };
    },
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "all_imported" }),
    findOnlineProduct: async () => null,
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    now: () => current,
    concurrency: 1,
    maxConcurrency: 1,
    pendingStoreStallMs: 60_000,
    pendingStoreStallCount: 2,
    storeTargets: [
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
      { id: 106640, needle: "丽丽三号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.deepEqual(shopIds, [106637, 106637, 106640]);
  assert.ok(result.store_switches.some((event) => event.from_store_id === 106637
    && event.to_store_id === 106640
    && event.reason === "submission-stall"));
});

test("runner pauses fresh submissions when the last available store import queue is stalled", async () => {
  const state = fakeState({
    "old-1": { status: "processing", data: { store_id: 106637, submitted: true, prepared_at: "2026-07-15T09:00:00.000Z" } },
    "old-2": { status: "processing", data: { store_id: 106637, submission_pending: true, prepared_at: "2026-07-15T09:01:00.000Z" } },
  });
  let publishCalls = 0;
  const client = clientFor([{ id: 209, sku: 209 }], {
    resolvePublishTarget: async () => ({
      store: { id: 106637, name: "丽丽二号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async () => { publishCalls += 1; return { ok: true }; },
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "pending" }),
    findOnlineProduct: async () => null,
  });
  const runner = createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    now: () => new Date("2026-07-15T10:00:00.000Z"),
    pendingStoreStallMs: 60_000,
    pendingStoreStallCount: 2,
    storeTargets: [{ id: 106637, needle: "丽丽二号", requireWarehouse: false }],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  });
  const result = await runner.run();
  assert.equal(publishCalls, 0);
  assert.equal(result.fresh_submissions_paused, true);
  assert.ok(state.transitions.some((entry) => entry.sku === "old-1" && entry.data.reason === "reconciliation-import-pending"));
  const nextRound = await runner.run();
  assert.equal(nextRound.fresh_submissions_paused, true);
  assert.equal(publishCalls, 0);
  assert.equal(nextRound.store_switches.filter((entry) => entry.reason === "all-store-imports-stalled").length, 1);
});

test("runner rechecks store health after rotating and pauses when every configured store is stalled", async () => {
  const state = fakeState({
    "store-2-old-1": { status: "processing", data: { store_id: 106637, submitted: true, prepared_at: "2026-07-15T09:00:00.000Z" } },
    "store-2-old-2": { status: "processing", data: { store_id: 106637, submitted: true, prepared_at: "2026-07-15T09:01:00.000Z" } },
    "store-1-old-1": { status: "processing", data: { store_id: 104965, submitted: true, prepared_at: "2026-07-15T09:02:00.000Z" } },
    "store-1-old-2": { status: "processing", data: { store_id: 104965, submitted: true, prepared_at: "2026-07-15T09:03:00.000Z" } },
  });
  let publishCalls = 0;
  const client = clientFor([{ id: 210, sku: 210 }], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: Number(storeId) === 106637 ? "丽丽二号" : "丽丽1号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async () => { publishCalls += 1; return { ok: true }; },
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "pending" }),
    findOnlineProduct: async () => null,
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    now: () => new Date("2026-07-15T10:00:00.000Z"),
    pendingStoreStallMs: 60_000,
    pendingStoreStallCount: 2,
    storeTargets: [
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
      { id: 104965, needle: "丽丽1号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();
  assert.equal(publishCalls, 0);
  assert.equal(result.fresh_submissions_paused, true);
  assert.deepEqual(result.store_switches.map((entry) => entry.reason), ["submission-stall", "all-store-imports-stalled"]);
});

test("runner rate-limits repeated unavailable store-switch diagnostics during a stalled rotation", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-store-switch-throttle-"));
  const state = fakeState({
    "store-3-old-1": { status: "processing", data: { store_id: 106640, submitted: true, prepared_at: "2026-07-15T09:00:00.000Z" } },
    "store-3-old-2": { status: "processing", data: { store_id: 106640, submitted: true, prepared_at: "2026-07-15T09:01:00.000Z" } },
    "store-4-old-1": { status: "processing", data: { store_id: 106644, submitted: true, prepared_at: "2026-07-15T09:02:00.000Z" } },
    "store-4-old-2": { status: "processing", data: { store_id: 106644, submitted: true, prepared_at: "2026-07-15T09:03:00.000Z" } },
  });
  const client = clientFor([{ id: 210, sku: 210 }], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: `store-${storeId}` },
      watermark: { id: 60822, name: "lysh" },
    }),
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "pending" }),
    findOnlineProduct: async () => null,
  });
  const runner = createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    runDir,
    target: 1,
    now: () => new Date("2026-07-15T10:00:00.000Z"),
    totalStoreUsageSeed: { 106637: 100 },
    pendingStoreStallMs: 60_000,
    pendingStoreStallCount: 2,
    pendingStoreRetryMs: 300_000,
    storeTargets: [
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
      { id: 106640, needle: "丽丽三号", requireWarehouse: false },
      { id: 106644, needle: "丽丽四号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  });

  await runner.run();
  await runner.run();
  await runner.run();

  const events = (await fs.readFile(path.join(runDir, "store_switches.jsonl"), "utf8"))
    .trim().split(/\n+/).map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.from_store_id === 106644
    && event.to_store_id === 106637
    && event.reason === "store-total-limit").length, 1);
});

test("persistent rotation wraps from the last stalled store to an earlier recovered store", async () => {
  let current = new Date("2026-07-15T10:00:00.000Z");
  let favorites = [{ id: 501, sku: 501 }];
  const state = fakeState({
    "store-a-old": {
      status: "processing",
      data: { store_id: 106637, submitted: true, prepared_at: "2026-07-15T09:00:00.000Z" },
    },
  });
  const shopIds = [];
  const client = clientFor([], {
    listFavorites: async () => favorites,
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: Number(storeId) === 106637 ? "丽丽二号" : "丽丽三号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async (payload) => {
      shopIds.push(payload.shop_ids[0]);
      return { ok: true, response: { code: 1 } };
    },
    findImportLog: async ({ sku, offerId }) => ["store-a-old", "501"].includes(String(sku))
      ? ({ sku, offer_id: offerId, import_status: "pending" })
      : ({ sku, offer_id: offerId, import_status: "all_imported" }),
    findOnlineProduct: async ({ offerId }) => String(offerId).includes("501")
      ? null
      : ({ sku: 900001, offer_id: offerId, online_status: "selling", stock: 1 }),
  });
  const runner = createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    now: () => current,
    pendingStoreStallMs: 60_000,
    pendingStoreStallCount: 1,
    storeTargets: [
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
      { id: 106640, needle: "丽丽三号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  });

  await runner.run();
  await state.transition("store-a-old", "skipped", { reason: "released-for-test" });
  current = new Date("2026-07-15T10:06:00.000Z");
  favorites = [{ id: 502, sku: 502 }];
  const second = await runner.run();

  assert.deepEqual(shopIds, [106640, 106637]);
  assert.equal(second.published, 1);
  assert.ok(second.store_switches.some((event) => event.from_store_id === 106640
    && event.to_store_id === 106637
    && event.reason === "submission-stall"));
});

test("restored daily store usage counts unique submitted or published SKUs in the configured timezone", () => {
  const entries = [
    { sku: "1", status: "processing", data: { store_id: 104965, submitted: true, submitted_at: "2026-07-15T00:01:00Z" } },
    { sku: "1", status: "failed", data: { store_id: 104965, submitted: true, submitted_at: "2026-07-15T00:01:00Z" } },
    { sku: "2", status: "published", data: { store_id: 104965, published_at: "2026-07-15T15:59:59Z" } },
    { sku: "3", status: "processing", data: { store_id: 104965, submission_pending: true, prepared_at: "2026-07-14T15:59:59Z" } },
    { sku: "4", status: "published", data: { store_id: 106637, published_at: "2026-07-15T03:00:00Z" } },
  ];
  assert.equal(restoredDailyStoreUsage(entries, 104965, new Date("2026-07-15T10:00:00Z"), "Asia/Shanghai"), 2);
  assert.equal(restoredDailyStoreUsage(entries, 106637, new Date("2026-07-15T10:00:00Z"), "Asia/Shanghai"), 1);
});

test("runner rotates at the local per-store daily cap without submitting an oversized concurrent batch", async () => {
  const existing = {};
  for (let index = 0; index < 99; index += 1) {
    existing[`old-${index}`] = {
      status: "published",
      data: { store_id: 104965, published_at: "2026-07-15T01:00:00Z" },
    };
  }
  const state = fakeState(existing);
  const shopIds = [];
  const items = Array.from({ length: 6 }, (_, index) => ({ id: 300 + index, sku: String(300 + index) }));
  const client = clientFor(items, {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: Number(storeId) === 104965 ? "丽丽1号" : "丽丽二号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async (payload) => {
      shopIds.push(payload.shop_ids[0]);
      return { ok: true, response: { code: 1 } };
    },
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 6,
    concurrency: 8,
    dailyStoreLimit: 100,
    now: () => new Date("2026-07-15T10:00:00Z"),
    storeTargets: [
      { id: 104965, needle: "丽丽1号", requireWarehouse: false },
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 6);
  assert.deepEqual(shopIds, [104965, 106637, 106637, 106637, 106637, 106637]);
  assert.deepEqual(result.store_submitted_usage, { "104965": 100, "106637": 5 });
  assert.deepEqual(result.store_confirmed_count, { "104965": 100, "106637": 5 });
  assert.deepEqual(result.store_switches, [{ from_store_id: 104965, to_store_id: 106637, reason: "daily-product-limit" }]);
});

test("runner syncs and verifies a missing warehouse before rotating into a store", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-store-target-"));
  const state = fakeState();
  const shopIds = [];
  const syncCalls = [];
  let storeTwoReads = 0;
  const client = clientFor([{ id: 204, sku: 204 }], {
    resolvePublishTarget: async ({ storeId }) => {
      if (Number(storeId) === 106637) storeTwoReads += 1;
      return {
        store: {
          id: Number(storeId),
          name: Number(storeId) === 104965 ? "丽丽1号" : "丽丽二号",
          product_limit: {
            daily_create: Number(storeId) === 104965
              ? { limit: 100, usage: 100 }
              : { limit: 100, usage: 0 },
          },
          warehouse: Number(storeId) === 106637 && storeTwoReads >= 2
            ? [{ warehouse_id: 2020005022957960, name: "丽丽二号仓库" }]
            : [],
        },
        watermark: { id: 60822, name: "lysh" },
      };
    },
    syncWarehouses: async (ids) => {
      syncCalls.push(ids);
      return { queued: true };
    },
    publish: async (payload) => {
      shopIds.push(payload.shop_ids[0]);
      return { ok: true, response: { code: 1 } };
    },
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    runDir,
    target: 1,
    storeTargets: [
      { id: 104965, needle: "丽丽1号", warehouseId: 1020005022957960 },
      { id: 106637, needle: "丽丽二号" },
    ],
    sleep: async () => {},
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.deepEqual(syncCalls, [[106637]]);
  assert.deepEqual(shopIds, [106637]);
  assert.equal(state.records[0].store_id, 106637);
  const targetEvents = (await fs.readFile(path.join(runDir, "store_targets.jsonl"), "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(targetEvents.some((event) => event.store_id === 106637
    && event.warehouse_id === 2020005022957960
    && event.watermark_id === 60822
    && event.warehouse_source === "erp-discovered"));
  await fs.rm(runDir, { recursive: true, force: true });
});

test("runner caches an unavailable store between consumer rounds instead of repeating warehouse sync", async () => {
  const state = fakeState();
  let syncCalls = 0;
  const client = clientFor([{ id: 206, sku: 206 }], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: {
        id: Number(storeId),
        name: Number(storeId) === 106637 ? "丽丽二号" : "丽丽1号",
        warehouse: Number(storeId) === 104965
          ? [{ warehouse_id: 1020005022957960, name: "丽丽1号仓库" }]
          : [],
      },
      watermark: { id: 60822, name: "lysh" },
    }),
    syncWarehouses: async () => { syncCalls += 1; return []; },
  });
  const runner = createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    storeTargets: [
      { id: 106637, needle: "丽丽二号" },
      { id: 104965, needle: "丽丽1号", warehouseId: 1020005022957960 },
    ],
    warehouseSyncAttempts: 1,
    warehouseSyncIntervalMs: 0,
    unavailableStoreRetryMs: 1_800_000,
    sleep: async () => {},
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  });

  await runner.run();
  await runner.run();
  assert.equal(syncCalls, 1);
});

test("runner restarts the store rotation from 丽丽二号 after the local day changes", async () => {
  let current = new Date("2026-07-15T10:00:00.000Z");
  let round = 1;
  const state = fakeState();
  const shopIds = [];
  const client = clientFor([], {
    listFavorites: async () => round === 1 ? [{ id: 211, sku: 211 }] : [{ id: 212, sku: 212 }],
    resolvePublishTarget: async ({ storeId }) => ({
      store: {
        id: Number(storeId),
        name: Number(storeId) === 106637 ? "丽丽二号" : "丽丽1号",
        product_limit: {
          daily_create: Number(storeId) === 106637 && round === 1
            ? { limit: 100, usage: 100 }
            : { limit: 100, usage: 0 },
        },
        warehouse: Number(storeId) === 106637
          ? [{ warehouse_id: 2020005022957960, name: "丽丽二号仓库" }]
          : [{ warehouse_id: 1020005022957960, name: "丽丽1号仓库" }],
      },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async (payload) => { shopIds.push(payload.shop_ids[0]); return { ok: true }; },
  });
  const runner = createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 2,
    now: () => current,
    storeTargets: [
      { id: 106637, needle: "丽丽二号" },
      { id: 104965, needle: "丽丽1号", warehouseId: 1020005022957960 },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  });

  await runner.run();
  round = 2;
  current = new Date("2026-07-16T10:00:00.000Z");
  await runner.run();
  assert.deepEqual(shopIds, [104965, 106637]);
});

test("runner queues a bounded online-product sync after a successful submission", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-online-sync-"));
  const state = fakeState();
  const syncCalls = [];
  const client = clientFor([{ id: 205, sku: 205 }], {
    syncOnlineShops: async (ids, type) => {
      syncCalls.push({ ids, type });
      return { msg: "queued" };
    },
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    runDir,
    target: 1,
    onlineSyncIntervalMs: 180_000,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.deepEqual(syncCalls, [{ ids: [7], type: "all" }]);
});

test("runner keeps a ready-to-sell zero-stock SKU retryable and continues to the next candidate", async () => {
  const state = fakeState();
  const client = clientFor([{ id: 92, sku: 3301105092 }, { id: 93, sku: 3301105093 }], {
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "all_imported" }),
    findOnlineProduct: async ({ offerId }) => String(offerId).endsWith("3301105092") ? ({
      id: 1271192336, sku: 5069587484, offer_id: offerId, online_status: "ready_to_sell", stock: 0,
    }) : ({
      id: 1271192337, sku: 5069587485, offer_id: offerId, online_status: "selling", stock: 1,
    }),
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.submitted_pending, 1);
  assert.equal(result.halt_reason, null);
  assert.equal(state.records[0].sku, "3301105093");
  assert.ok(state.transitions.some((event) => event.status === "processing" && event.data.reason === "online-product-not-selling"));
});

test("runner activates a ready-to-sell product in the verified FBS warehouse before counting it", async () => {
  const state = fakeState();
  const stockUpdates = [];
  let onlineChecks = 0;
  const client = clientFor([{ id: 92, sku: 3301105092 }], {
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "all_imported" }),
    findOnlineProduct: async ({ offerId }) => {
      onlineChecks += 1;
      return {
        id: 1271192336,
        product_id: 5489750001,
        sku: 5069587484,
        offer_id: offerId,
        online_status: onlineChecks === 1 ? "ready_to_sell" : "selling",
        stock: onlineChecks === 1 ? 0 : 1,
      };
    },
    updateProductStock: async (input) => {
      stockUpdates.push(input);
      return { updated_count: 1, result: [{ updated: true, errors: [] }] };
    },
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    now: () => new Date("2026-07-15T00:00:00Z"),
    warehouseId: 1020005022957960,
    initialStock: 1,
    confirmationAttempts: 2,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.equal(state.records[0].online_status, "selling");
  assert.equal(state.records[0].stock, 1);
  assert.deepEqual(stockUpdates, [{
    shopId: 7,
    product: {
      id: 1271192336,
      product_id: 5489750001,
      sku: 5069587484,
      offer_id: "mz-150726-3301105092",
      online_status: "ready_to_sell",
      stock: 0,
    },
    warehouseId: 1020005022957960,
    stock: 1,
  }]);
});

test("runner counts only a final imported task that is selling with positive stock", async () => {
  const state = fakeState();
  const client = clientFor([{ id: 92, sku: 3301105092 }], {
    findImportLog: async () => ({ sku: 3301105092, offer_id: "mz-140726-105092", import_status: "all_imported" }),
    findOnlineProduct: async () => ({
      id: 1271192336,
      sku: 5069587484,
      offer_id: "mz-140726-105092",
      online_status: "selling",
      stock: 1,
    }),
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.equal(state.records[0].store_sku, 5069587484);
  assert.equal(state.records[0].online_status, "selling");
  assert.equal(state.records[0].offer_id, "mz-140726-105092");
});

test("publish candidates put collection-preflight FBS SKUs first", () => {
  const items = [
    { sku: "hat", title: "Панама", sell_price: 50 },
    { sku: "pure", title: "Обычный товар", sell_price: 20 },
  ];
  assert.deepEqual(
    prioritizePublishCandidates(items, new Set(["pure"])).map((item) => item.sku),
    ["pure", "hat"],
  );
});

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

test("accepted imports that are still pending stay retryable without blocking the next SKU", async () => {
  const state = fakeState();
  const client = clientFor([{ id: 901, sku: 901 }, { id: 902, sku: 902 }], {
    findImportLog: async ({ sku, offerId }) => String(sku) === "901"
      ? { sku, offer_id: offerId, import_status: "pending" }
      : { sku, offer_id: offerId, import_status: "all_imported" },
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    concurrency: 1,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.equal(result.submitted_pending, 1);
  assert.equal(result.failed, 0);
  assert.equal(state.statusOf("901"), "processing");
  assert.equal(state.entries().find((entry) => entry.sku === "901").data.submitted, true);
  assert.equal(state.statusOf("902"), "published");
});

test("fatal browser closure escapes the SKU failure path for supervisor recovery", async () => {
  const state = fakeState();
  const client = clientFor([{ id: 1, sku: 1 }], {
    getProductDetail: async () => { throw new Error("browserContext.newPage: Target page, context or browser has been closed"); },
  });
  const runner = createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
  });
  await assert.rejects(runner.run(), /context or browser has been closed/);
  assert.equal(state.transitions.some((event) => event.status === "failed"), false);
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

test("runner proactively reconciles a submitted SKU that disappeared from favorites", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-reconcile-sync-"));
  const state = fakeState({
    4854106078: {
      status: "failed",
      data: {
        reason: "publish-final-status-timeout",
        submitted: true,
        offer_id: "mz-150726-4854106078",
        title: "delayed imported item",
        sell_price: 99,
        purchase_price: 20,
        profit_rate: 45,
        cate_rate: 12,
        cate_fee: 8,
        store_id: 104965,
        watermark_id: 60822,
      },
    },
  });
  let publishCalls = 0;
  const syncCalls = [];
  const client = clientFor([], {
    publish: async () => { publishCalls += 1; return { ok: true }; },
    syncOnlineShops: async (ids, type) => { syncCalls.push({ ids, type }); return { msg: "queued" }; },
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "all_imported" }),
    findOnlineProduct: async ({ offerId }) => ({
      id: 77,
      product_id: 88,
      sku: 99,
      offer_id: offerId,
      online_status: "selling",
      stock: 1,
    }),
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    runDir,
    target: 1,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.equal(publishCalls, 0);
  assert.deepEqual(syncCalls, [{ ids: [104965], type: "all" }]);
  assert.equal(state.records[0].sku, "4854106078");
  assert.equal(state.records[0].profit_rate, 45);
  assert.equal(state.records[0].reconciled, true);
  assert.match(state.records[0].published_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("runner reconciles a delayed submission against its original store after rotation", async () => {
  const state = fakeState({
    delayed: {
      status: "processing",
      data: {
        store_id: 106637,
        submitted: true,
        offer_id: "mz-150726-delayed",
        profit_rate: 45,
      },
    },
  });
  const checkedShopIds = [];
  const client = clientFor([], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: Number(storeId) === 104965 ? "丽丽1号" : "丽丽二号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    findImportLog: async ({ shopId, sku, offerId }) => {
      checkedShopIds.push(Number(shopId));
      return { sku, offer_id: offerId, import_status: "all_imported" };
    },
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    storeTargets: [
      { id: 104965, needle: "丽丽1号", requireWarehouse: false },
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.deepEqual(checkedShopIds, [106637, 106637]);
  assert.equal(state.records[0].store_id, 106637);
});

test("a delayed SKU hitting another store's daily limit does not halt the active store", async () => {
  const state = fakeState({
    delayed: {
      status: "processing",
      data: {
        store_id: 104965,
        submitted: true,
        offer_id: "mz-150726-delayed-limit",
        profit_rate: 45,
      },
    },
  });
  const shopIds = [];
  const client = clientFor([{ id: 301, sku: 301 }], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: Number(storeId) === 104965 ? "丽丽1号" : "丽丽二号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    findImportLog: async ({ shopId, sku, offerId }) => Number(shopId) === 104965 ? ({
      sku,
      offer_id: offerId,
      import_status: "all_failed",
      skus: [{ error_msg: "вы исчерпали суточный лимит" }],
    }) : ({ sku, offer_id: offerId, import_status: "all_imported" }),
    publish: async (payload) => {
      shopIds.push(payload.shop_ids[0]);
      return { ok: true, response: { code: 1 } };
    },
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    storeTargets: [
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
      { id: 104965, needle: "丽丽1号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.deepEqual(shopIds, [106637]);
  assert.equal(result.active_store_id, 106637);
  assert.equal(result.halt_reason, null);
  assert.ok(state.transitions.some((entry) => entry.sku === "delayed" && entry.data.reason === "daily-product-limit"));
});

test("runner restores a shop-name-only daily limit signal after restart", async () => {
  const state = fakeState({
    exhausted: {
      status: "failed",
      data: {
        reason: "daily-product-limit",
        reconciled_at: "2026-07-15T10:00:00.000Z",
        import_log: { shop_name: "丽丽1号" },
      },
    },
  });
  const shopIds = [];
  const client = clientFor([{ id: 302, sku: 302 }], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: Number(storeId) === 104965 ? "丽丽1号" : "丽丽二号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async (payload) => {
      shopIds.push(payload.shop_ids[0]);
      return { ok: true, response: { code: 1 } };
    },
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    now: () => new Date("2026-07-15T11:00:00.000Z"),
    storeTargets: [
      { id: 104965, needle: "丽丽1号", requireWarehouse: false },
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.deepEqual(shopIds, [106637]);
  assert.equal(result.active_store_id, 106637);
  assert.deepEqual(result.store_switches, [{ from_store_id: 104965, to_store_id: 106637, reason: "daily-product-limit" }]);
});

test("runner resolves one original store only once while reconciling many delayed SKUs", async () => {
  const state = fakeState({
    delayed1: { status: "processing", data: { store_id: 106637, submitted: true, offer_id: "mz-delayed-1", profit_rate: 45 } },
    delayed2: { status: "processing", data: { store_id: 106637, submitted: true, offer_id: "mz-delayed-2", profit_rate: 46 } },
  });
  const targetCalls = new Map();
  const client = clientFor([], {
    resolvePublishTarget: async ({ storeId }) => {
      const id = Number(storeId);
      targetCalls.set(id, Number(targetCalls.get(id) || 0) + 1);
      return { store: { id, name: id === 104965 ? "丽丽1号" : "丽丽二号" }, watermark: { id: 60822, name: "lysh" } };
    },
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "all_imported" }),
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 2,
    storeTargets: [
      { id: 104965, needle: "丽丽1号", requireWarehouse: false },
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 2);
  assert.equal(targetCalls.get(104965), 1);
  assert.equal(targetCalls.get(106637), 1);
});

test("runner classifies an explicit Ozon moderation decline as a terminal online rejection", async () => {
  const state = fakeState({
    rejected: { status: "processing", data: { store_id: 106637, submitted: true, offer_id: "mz-rejected", profit_rate: 45 } },
  });
  const client = clientFor([], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: "丽丽二号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "all_imported" }),
    findOnlineProduct: async ({ offerId }) => ({
      sku: 0,
      offer_id: offerId,
      online_status: "unknown",
      stock: 0,
      errors: [{ code: "DESCRIPTION_DECLINE", level: "ERROR_LEVEL_ERROR", state: "declined" }],
    }),
  });

  await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    storeTargets: [{ id: 106637, needle: "丽丽二号", requireWarehouse: false }],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.ok(state.transitions.some((event) => event.status === "failed" && event.data.reason === "online-product-rejected"));
});

test("runner does not retry or stall on restored terminal Ozon moderation rejections", async () => {
  const terminal = (index) => ({
    status: "failed",
    data: {
      store_id: 106637,
      submitted: true,
      offer_id: `mz-terminal-${index}`,
      profit_rate: 45,
      reason: "online-product-not-selling",
      final_result: {
        online_product: {
          sku: 0,
          online_status: "unknown",
          errors: [{ code: "DESCRIPTION_DECLINE", level: "ERROR_LEVEL_ERROR", state: "declined" }],
        },
      },
    },
  });
  const state = fakeState({ terminal1: terminal(1), terminal2: terminal(2), terminal3: terminal(3) });
  const shopIds = [];
  let importChecks = 0;
  const client = clientFor([{ id: 909, sku: 909 }], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: Number(storeId) === 106637 ? "丽丽二号" : "丽丽1号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    findImportLog: async ({ sku }) => {
      importChecks += 1;
      return { sku, offer_id: `mz-test-${sku}`, import_status: "all_imported" };
    },
    publish: async (payload) => { shopIds.push(payload.shop_ids[0]); return { ok: true }; },
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    storeTargets: [
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
      { id: 104965, needle: "丽丽1号", requireWarehouse: false },
    ],
    pendingStoreStallCount: 3,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.deepEqual(shopIds, [106637]);
  assert.equal(importChecks, 1);
});

test("runner rechecks a restored rejection whose moderation evidence belongs to another store", async () => {
  const state = fakeState({
    3995562725: {
      status: "failed",
      data: {
        sku: "3995562725",
        store_id: 106637,
        submitted: true,
        offer_id: "mz-150726-3995562725",
        profit_rate: 43.98,
        reason: "online-product-rejected",
        final_result: {
          online_product: {
            shop_id: 104965,
            sku: 0,
            online_status: "unknown",
            stock: 0,
            errors: [{ code: "SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT", level: "ERROR_LEVEL_ERROR", state: "moderated" }],
          },
        },
      },
    },
  });
  const client = clientFor([], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: "丽丽二号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "all_imported" }),
    findOnlineProduct: async ({ shopId, offerId }) => ({
      id: 912,
      product_id: 913,
      shop_id: Number(shopId),
      sku: 914,
      offer_id: offerId,
      online_status: "selling",
      stock: 5,
    }),
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    storeTargets: [{ id: 106637, needle: "丽丽二号", requireWarehouse: false }],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.equal(state.records[0].sku, "3995562725");
  assert.equal(state.records[0].store_id, 106637);
  assert.equal(state.records[0].online_status, "selling");
});

test("runner syncs every original store represented by delayed submissions", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-multi-store-sync-"));
  const state = fakeState({
    "store-2-pending": {
      status: "processing",
      data: { store_id: 106637, submitted: true, offer_id: "mz-store-2", profit_rate: 45 },
    },
    "store-1-pending": {
      status: "processing",
      data: { store_id: 104965, submitted: true, offer_id: "mz-store-1", profit_rate: 45 },
    },
  });
  const syncedStoreIds = [];
  const client = clientFor([], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: Number(storeId) === 106637 ? "丽丽二号" : "丽丽1号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    syncOnlineShops: async (storeIds) => { syncedStoreIds.push(...storeIds.map(Number)); return { msg: "queued" }; },
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "pending" }),
    findOnlineProduct: async () => null,
  });
  await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    runDir,
    target: 1,
    storeTargets: [
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
      { id: 104965, needle: "丽丽1号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();
  assert.deepEqual(syncedStoreIds.sort((left, right) => left - right), [104965, 106637]);
});

test("runner restores the persisted online-sync cooldown after a supervisor restart", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-sync-cooldown-"));
  const now = () => new Date("2026-07-15T08:06:00.000Z");
  await fs.writeFile(path.join(runDir, "store_syncs.jsonl"), `${JSON.stringify({
    at: "2026-07-15T08:05:00.000Z",
    store_id: 7,
    kind: "online-products",
    ok: true,
  })}\n`);
  const state = fakeState({
    delayed: { status: "failed", data: { submitted: true, offer_id: "mz-delayed", profit_rate: 45 } },
  });
  const syncCalls = [];
  const client = clientFor([], {
    syncOnlineShops: async (...args) => { syncCalls.push(args); return { msg: "queued" }; },
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "all_imported" }),
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    runDir,
    now,
    target: 1,
    onlineSyncIntervalMs: 600_000,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.deepEqual(syncCalls, []);
});

test("runner shortens the online-sync cooldown only for a large delayed backlog", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-urgent-sync-"));
  const now = () => new Date("2026-07-15T08:06:00.000Z");
  await fs.writeFile(path.join(runDir, "store_syncs.jsonl"), `${JSON.stringify({
    at: "2026-07-15T08:00:00.000Z",
    store_id: 104965,
    kind: "online-products",
    ok: true,
  })}\n`);
  const state = fakeState({
    delayed1: {
      status: "processing",
      data: { store_id: 104965, submitted: true, offer_id: "mz-delayed-1", profit_rate: 45 },
    },
    delayed2: {
      status: "processing",
      data: { store_id: 104965, submitted: true, offer_id: "mz-delayed-2", profit_rate: 46 },
    },
  });
  const syncCalls = [];
  const client = clientFor([], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: "丽丽1号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    syncOnlineShops: async (...args) => { syncCalls.push(args); return { msg: "queued" }; },
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "pending" }),
    findOnlineProduct: async () => null,
  });

  await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    runDir,
    now,
    target: 1,
    storeTargets: [{ id: 104965, needle: "丽丽1号", requireWarehouse: false }],
    onlineSyncIntervalMs: 1_800_000,
    urgentOnlineSyncIntervalMs: 300_000,
    urgentOnlineSyncPendingCount: 2,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.deepEqual(syncCalls, [[[104965], "all"]]);
});

test("reconciliation HTTP 0 errors reduce adaptive publish concurrency", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-reconcile-http0-"));
  const state = fakeState({
    delayed: { status: "processing", data: { submitted: true, offer_id: "mz-delayed", profit_rate: 45 } },
  });
  const client = clientFor([], {
    findImportLog: async () => { throw new Error("Maozi import logs lookup request failed: HTTP 0"); },
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    runDir,
    target: 1,
    concurrency: 8,
    maxConcurrency: 12,
  }).run();

  assert.equal(result.failed, 1);
  assert.equal(result.final_concurrency, 4);
  assert.equal(state.entries()[0].data.submitted, true);
  assert.equal(state.entries()[0].data.offer_id, "mz-delayed");
});

test("reconciliation-only mode never submits a fresh favorite", async () => {
  const state = fakeState({
    delayed: { status: "failed", data: { submitted: true, offer_id: "mz-150726-delayed", profit_rate: 45 } },
  });
  let publishCalls = 0;
  const client = clientFor([{ id: "delayed", sku: "delayed" }, { id: "fresh", sku: "fresh" }], {
    publish: async () => { publishCalls += 1; return { ok: true }; },
    findImportLog: async ({ sku, offerId }) => String(sku) === "delayed"
      ? { sku, offer_id: offerId, import_status: "all_imported" }
      : null,
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 10,
    reconciliationOnly: true,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.equal(publishCalls, 0);
  assert.equal(state.statusOf("fresh"), null);
});

test("runner backs off a delayed reconciliation until its persisted retry time", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-reconcile-backoff-"));
  const state = fakeState({
    delayed: {
      status: "processing",
      data: {
        submitted: true,
        submission_pending: true,
        offer_id: "mz-150726-delayed",
        next_reconcile_at: "2026-07-15T07:00:15.000Z",
      },
    },
  });
  let importChecks = 0;
  const client = clientFor([], {
    findImportLog: async () => { importChecks += 1; return null; },
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    runDir,
    target: 1,
    now: () => new Date("2026-07-15T07:00:00.000Z"),
  }).run();

  assert.equal(result.published, 0);
  assert.equal(importChecks, 0);
  await assert.rejects(fs.access(path.join(runDir, "source_yield.jsonl")));
  await fs.rm(runDir, { recursive: true, force: true });
});

test("runner persists backoff after an imported product is still not selling", async () => {
  const state = fakeState({
    delayed: {
      status: "failed",
      data: {
        store_id: 104965,
        submitted: true,
        submission_pending: true,
        offer_id: "mz-150726-delayed",
        profit_rate: 55,
        reconcile_attempts: 3,
        reason: "online-product-not-selling",
      },
    },
  });
  const client = clientFor([], {
    resolvePublishTarget: async () => ({
      store: { id: 104965, name: "丽丽1号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "all_imported" }),
    findOnlineProduct: async ({ offerId }) => ({
      id: 177,
      sku: 0,
      offer_id: offerId,
      online_status: "unknown",
      stock: 0,
      errors: [],
    }),
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    now: () => new Date("2026-07-15T07:00:00.000Z"),
    storeTargets: [{ id: 104965, needle: "丽丽1号", warehouseId: 1020005022957960 }],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 0);
  const retry = state.transitions.at(-1);
  assert.equal(retry.status, "processing");
  assert.equal(retry.data.reason, "online-product-not-selling");
  assert.equal(retry.data.reconcile_attempts, 4);
  assert.equal(retry.data.next_reconcile_at, "2026-07-15T07:00:30.000Z");
});

test("restored imported reconciliation performs one exact online check per scheduled attempt", async () => {
  const state = fakeState({
    delayed: {
      status: "processing",
      data: {
        store_id: 104965,
        submitted: true,
        submission_pending: true,
        offer_id: "mz-150726-single-check",
        profit_rate: 55,
        reconcile_attempts: 4,
        reason: "online-product-not-selling",
      },
    },
  });
  let onlineChecks = 0;
  const client = clientFor([], {
    resolvePublishTarget: async () => ({
      store: { id: 104965, name: "丽丽1号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "all_imported" }),
    findOnlineProduct: async ({ offerId }) => {
      onlineChecks += 1;
      return { id: 179, sku: 0, offer_id: offerId, online_status: "unknown", stock: 0, errors: [] };
    },
  });

  await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    storeTargets: [{ id: 104965, needle: "丽丽1号", warehouseId: 1020005022957960 }],
    confirmationAttempts: 6,
    confirmationIntervalMs: 2000,
    sleep: async () => {},
  }).run();

  assert.equal(onlineChecks, 1);
});

test("long-running unchanged reconciliation aligns its backoff with ERP sync cadence", async () => {
  const state = fakeState({
    delayed: {
      status: "processing",
      data: {
        store_id: 104965,
        submitted: true,
        submission_pending: true,
        offer_id: "mz-150726-long-delay",
        profit_rate: 55,
        reconcile_attempts: 11,
        reason: "online-product-not-selling",
      },
    },
  });
  const client = clientFor([], {
    resolvePublishTarget: async () => ({
      store: { id: 104965, name: "丽丽1号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "all_imported" }),
    findOnlineProduct: async ({ offerId }) => ({
      id: 178,
      sku: 0,
      offer_id: offerId,
      online_status: "unknown",
      stock: 0,
      errors: [],
    }),
  });

  await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    now: () => new Date("2026-07-15T07:00:00.000Z"),
    storeTargets: [{ id: 104965, needle: "丽丽1号", warehouseId: 1020005022957960 }],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  const retry = state.transitions.at(-1);
  assert.equal(retry.data.reconcile_attempts, 12);
  assert.equal(retry.data.next_reconcile_at, "2026-07-15T07:02:00.000Z");
});

test("runner confirms an exact selling online offer even while its import log is stale pending", async () => {
  const state = fakeState({
    4854106079: {
      status: "processing",
      data: {
        submitted: true,
        offer_id: "mz-150726-4854106079",
        profit_rate: 55,
      },
    },
  });
  const client = clientFor([], {
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "pending" }),
    findOnlineProduct: async ({ offerId }) => ({
      id: 177,
      product_id: 188,
      sku: 199,
      offer_id: offerId,
      online_status: "selling",
      stock: 1,
    }),
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.equal(state.records[0].offer_id, "mz-150726-4854106079");
  assert.equal(state.records[0].online_status, "selling");
  assert.equal(state.records[0].import_status, "pending");
  assert.equal(state.records[0].confirmation_source, "exact-online-offer");
});

test("runner recognizes nested imported status when the parent import status is unknown", async () => {
  const state = fakeState({
    nested: {
      status: "processing",
      data: { submitted: true, offer_id: "mz-150726-nested", profit_rate: 55 },
    },
  });
  let onlineChecks = 0;
  const stockUpdates = [];
  const client = clientFor([], {
    findImportLog: async ({ sku, offerId }) => ({
      sku,
      offer_id: offerId,
      import_status: "unknown",
      skus: [{ offer_id: offerId, import_status: "imported" }],
    }),
    findOnlineProduct: async ({ offerId }) => {
      onlineChecks += 1;
      return {
        id: 277,
        product_id: 288,
        sku: 299,
        offer_id: offerId,
        online_status: onlineChecks === 1 ? "ready_to_sell" : "selling",
        stock: onlineChecks === 1 ? 0 : 1,
      };
    },
    updateProductStock: async (input) => {
      stockUpdates.push(input);
      return { result: [{ updated: true, errors: [] }] };
    },
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    warehouseId: 1020005022957960,
    confirmationAttempts: 2,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.equal(state.records[0].import_status, "nested_imported");
  assert.equal(state.records[0].online_status, "selling");
  assert.equal(stockUpdates.length, 1);
});

test("fresh confirmation recognizes nested imported status without waiting for a timeout", async () => {
  const state = fakeState();
  let onlineChecks = 0;
  const client = clientFor([{ id: 777, sku: 777 }], {
    findImportLog: async ({ sku, offerId }) => ({
      sku,
      offer_id: offerId,
      import_status: "unknown",
      skus: [{ offer_id: offerId, import_status: "imported" }],
    }),
    findOnlineProduct: async ({ offerId }) => {
      onlineChecks += 1;
      return { id: 77, product_id: 78, sku: 79, offer_id: offerId, online_status: "selling", stock: 1 };
    },
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.equal(result.submitted_pending, 0);
  assert.equal(onlineChecks, 1);
  assert.equal(state.records[0].import_status, "nested_imported");
});

test("runner never promotes a restored daily-limit failure from the imported favorites flag", async () => {
  const state = fakeState({ 44: "failed" });
  let publishCalls = 0;
  const client = clientFor([{ id: 44, sku: 44 }], {
    findPublishedSku: async () => ({ sku: 44, title: "favorite was marked imported" }),
    findImportLog: async () => ({
      sku: 44,
      offer_id: "mz-140726-000044",
      import_status: "all_failed",
      skus: [{ error_msg: "вы исчерпали суточный лимит" }],
    }),
    publish: async () => { publishCalls += 1; return { ok: true }; },
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 0);
  assert.equal(result.halt_reason, "daily-product-limit");
  assert.equal(publishCalls, 0);
  assert.equal(state.records.length, 0);
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
  assert.equal(state.selections.length, 1);
  assert.equal(state.selections[0].sku, "700001");
  assert.equal(state.selections[0].profit_rate, 40);
  assert.equal(state.selections[0].store_name, "丽丽1号");
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

test("resumed skipped candidates are terminal and are not recalculated", async () => {
  const state = fakeState({ 20: "skipped" });
  let detailCalls = 0;
  const deleted = [];
  const client = clientFor([{ id: 20, sku: 20 }, { id: 21, sku: 21 }], {
    deleteFavorite: async (item) => { deleted.push(String(item.sku)); return true; },
    getProductDetail: async (sku) => {
      detailCalls += 1;
      return { sku, mode: "FBS", title: "safe", current_price: 100, follow_min: 90 };
    },
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
  }).run();

  assert.equal(result.published, 1);
  assert.equal(detailCalls, 1);
  assert.equal(state.records[0].sku, "21");
  assert.ok(deleted.includes("20"));
});

test("parallel preflight serializes publishing and never exceeds the exact target", async () => {
  const state = fakeState();
  let activePublishes = 0;
  let maxActivePublishes = 0;
  let activeDetails = 0;
  let maxActiveDetails = 0;
  let publishCalls = 0;
  let activeConfirmations = 0;
  let maxActiveConfirmations = 0;
  const items = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, sku: index + 1 }));
  const client = clientFor(items, {
    getProductDetail: async (sku) => {
      activeDetails += 1;
      maxActiveDetails = Math.max(maxActiveDetails, activeDetails);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeDetails -= 1;
      return { sku, mode: "FBS", title: "safe", current_price: 100, follow_min: 90 };
    },
    publish: async () => {
      activePublishes += 1;
      maxActivePublishes = Math.max(maxActivePublishes, activePublishes);
      publishCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      activePublishes -= 1;
      return { ok: true, response: { code: 1 } };
    },
    findImportLog: async ({ sku }) => {
      activeConfirmations += 1;
      maxActiveConfirmations = Math.max(maxActiveConfirmations, activeConfirmations);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeConfirmations -= 1;
      return { sku, offer_id: `mz-test-${sku}`, import_status: "all_imported" };
    },
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 5,
    concurrency: 4,
  }).run();

  assert.equal(result.published, 5);
  assert.equal(publishCalls, 5);
  assert.equal(maxActivePublishes, 1);
  assert.ok(maxActiveConfirmations > 1);
  assert.ok(maxActiveDetails > 1);
});

test("runner ends a dry candidate tail at the configured limit", async () => {
  const state = fakeState();
  const items = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, sku: index + 1 }));
  const client = clientFor(items, {
    getProductDetail: async (sku) => ({ sku, mode: "FBO", title: "dry item", current_price: 100 }),
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    concurrency: 1,
    dryCandidateLimit: 2,
  }).run();

  assert.equal(result.published, 0);
  assert.equal(result.attempted, 2);
  assert.equal(result.dry_candidates, 2);
});

test("repeated consumer rounds refresh store quota but reuse commission configuration", async () => {
  const cache = {};
  let targetCalls = 0;
  let commissionCalls = 0;
  const client = clientFor([], {
    resolvePublishTarget: async () => {
      targetCalls += 1;
      return { store: { id: 104965, name: "丽丽1号" }, watermark: { id: 60822, name: "lysh" } };
    },
    listCategoryCommissions: async () => { commissionCalls += 1; return []; },
  });
  for (let round = 0; round < 2; round += 1) {
    await createPublishRunner({
      client,
      costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
      state: fakeState(),
      target: 1,
      targetConfigCache: cache,
    }).run();
  }
  assert.equal(targetCalls, 2);
  assert.equal(commissionCalls, 1);
});

test("one persistent publisher session reuses a freshly verified target for sixty seconds", async () => {
  const cache = {};
  let targetCalls = 0;
  const client = clientFor([], {
    resolvePublishTarget: async () => {
      targetCalls += 1;
      return {
        store: { id: 104965, name: "丽丽1号", product_limit: { daily_create: { usage: 0, limit: 100 } } },
        watermark: { id: 60822, name: "lysh" },
      };
    },
  });
  const runner = createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state: fakeState(),
    target: 1,
    targetConfigCache: cache,
  });

  await runner.run();
  await runner.run();

  assert.equal(targetCalls, 1);
});

test("source outcomes persist to the cross-run yield history", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-yield-run-"));
  const historyDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-yield-history-"));
  const historyPath = path.join(historyDir, "source_yield_history.jsonl");
  try {
    const sourceUrl = "https://www.ozon.ru/seller/proven/?currency_price=50.000%3B";
    const runner = createPublishRunner({
      client: clientFor([{ id: 50, sku: 50, title: "Комплект трусов", source_url: sourceUrl }]),
      costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
      state: fakeState(),
      target: 1,
      runDir,
      sourceYieldHistoryPath: historyPath,
    });
    await runner.run();
    const rows = (await fs.readFile(historyPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "published");
    assert.equal(rows[0].source_url, sourceUrl);
    assert.equal(rows[0].title, "Комплект трусов");
    assert.equal(rows[0].title_family, "underwear");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
    await fs.rm(historyDir, { recursive: true, force: true });
  }
});
