import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  clearObservedPublishFeedbackCache,
  createConcurrencyGate,
  createPublishRunner,
  duplicateTitleKey,
  freshCnySnapshotSalePrice,
  loadObservedPublishFeedback,
  normalizeCostFailureReason,
  observedPublishFeedbackCacheStats,
  offerIdForSku,
  onlineSyncRetryAfterMs,
  preSubmitContentQuality,
  prioritizeProfitCandidates,
  prioritizePublishCandidates,
  restoredDailyStoreUsage,
  strictSourceYieldEvidence,
  verifiedWarehouseCandidates,
} from "../scripts/flow_b_playwright/publish-runner.mjs";
import { createPublishState } from "../scripts/flow_b_playwright/publish-state.mjs";
import {
  normalizeProfitPriority,
  normalizeSeasonPriority,
} from "../scripts/flow_b_playwright/profit-priority.mjs";

test("1688 concurrency gate waits for a real worker slot before starting queued work", async () => {
  const gate = createConcurrencyGate(1);
  let releaseFirst;
  let secondStarted = false;
  const first = gate.run(() => new Promise((resolve) => { releaseFirst = resolve; }));
  const second = gate.run(async () => {
    secondStarted = true;
    return "second";
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, false);
  assert.deepEqual(gate.stats(), { active: 1, queued: 1, limit: 1 });

  releaseFirst("first");
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(gate.stats(), { active: 0, queued: 0, limit: 1 });
});

test("fresh CNY snapshot fallback is bounded to fifteen minutes", () => {
  const item = {
    sell_price: 119.48,
    source_currency: "CNY",
    update_time: "2026-08-09 20:35:10",
  };
  assert.equal(freshCnySnapshotSalePrice(item, {
    now: new Date("2026-08-09T12:50:10.000Z"),
  }), 119.48);
  assert.equal(freshCnySnapshotSalePrice(item, {
    now: new Date("2026-08-09T12:50:11.000Z"),
  }), null);
  assert.equal(freshCnySnapshotSalePrice({ ...item, source_currency: "RUB" }, {
    now: new Date("2026-08-09T12:45:00.000Z"),
  }), null);
});

test("publisher applies seasonal priority softly after keeping profit mothers first", () => {
  const snapshot = {
    priority: normalizeProfitPriority({
      stores: [{
        store_id: 101,
        mother_products: [{
          source_sku: "mother",
          title_keywords: ["organizer"],
          sales_units: 3,
          real_profit_cny: 1,
        }],
      }],
    }),
    feedback: {},
    season: normalizeSeasonPriority({
      events: [{
        sales_start: "2026-09-01",
        sales_end: "2026-09-05",
        lead_days: 45,
        categories: [{ name: "Канцтовары", keywords: ["школьный пенал"], boost: 800 }],
      }],
    }),
  };
  const original = [
    { sku: "plain-a", title: "ordinary cable" },
    { sku: "season", title: "Школьный пенал" },
    { sku: "mother-like", title: "drawer organizer" },
    { sku: "plain-b", title: "ordinary lamp" },
  ];
  const ranked = prioritizeProfitCandidates(original, snapshot, 101, {
    now: "2026-08-09T00:00:00+08:00",
  });
  assert.deepEqual(ranked.map((row) => row.sku), ["mother-like", "season", "plain-a", "plain-b"]);
  assert.equal(ranked.length, original.length);
  assert.deepEqual(original.map((row) => row.sku), ["plain-a", "season", "mother-like", "plain-b"]);
});

test("pre-submit content quality requires title, HTTP image, category, and safe taxonomy", () => {
  const valid = {
    item: { title: "Детская настольная игра" },
    detail: { cover_image: "https://img.example/safe.jpg" },
    categoryData: { cate: [11, 22, "1,12.00"] },
    category: { mapped: [11, 22, "1,12.00"], labels: ["Игрушки", "Настольные игры"] },
    commissionTree: [{
      cate_id: 11,
      label: "Игрушки",
      children: [{
        cate_id: 22,
        label: "Настольные игры",
        children: [{ label: "售价 ≤ 1500₽", value: "1,12.00" }],
      }],
    }],
  };
  assert.deepEqual(preSubmitContentQuality(valid), {
    ok: true,
    reason: null,
    checks: {
      prohibited_category: true,
      title: true,
      image: true,
      category: true,
    },
    title: "Детская настольная игра",
    image: "https://img.example/safe.jpg",
    evidence: {
      title: {
        source: "favorite-snapshot",
        value: "Детская настольная игра",
      },
      image: {
        source: "ozon-detail",
        url: "https://img.example/safe.jpg",
      },
      category: {
        raw: [11, 22, "1,12.00"],
        mapped: [11, 22, "1,12.00"],
        labels: ["Игрушки", "Настольные игры"],
        commission_tree_match: true,
        commission_tier_match: true,
        hierarchy_labels: ["Игрушки", "Настольные игры"],
      },
    },
  });
  assert.equal(preSubmitContentQuality({
    ...valid,
    item: { title: " " },
  }).reason, "missing-title");
  assert.equal(preSubmitContentQuality({
    ...valid,
    detail: { cover_image: "cover.jpg" },
  }).reason, "invalid-cover-image-url");
  assert.equal(preSubmitContentQuality({
    ...valid,
    categoryData: { cate: [11] },
  }).reason, "category-data-missing");
  assert.equal(preSubmitContentQuality({
    ...valid,
    commissionTree: [{ cate_id: 99, children: [{ cate_id: 22 }] }],
  }).reason, "category-mapping-unavailable");
  assert.equal(preSubmitContentQuality({
    ...valid,
    commissionTree: [{
      cate_id: 11,
      label: "Одежда",
      children: [{
        cate_id: 22,
        label: "Платья",
        children: [{ label: "售价 ≤ 1500₽", value: "1,12.00" }],
      }],
    }],
  }).reason, "prohibited-category");

  const productionShape = preSubmitContentQuality({
    ...valid,
    item: {
      title: "Набор для настольной игры",
      cover_image: "https://ir-20.ozonstatic.cn/s3/multimedia/c600/example.jpg",
    },
    detail: {
      mode: "FBS",
      detail_title: "Ozon product document title",
      current_price: 100,
    },
  });
  assert.equal(productionShape.ok, true);
  assert.equal(productionShape.evidence.title.source, "favorite-snapshot");
  assert.equal(productionShape.evidence.image.source, "favorite-snapshot");
});

test("source-yield strict proof requires selling stock profit and pure FBS", () => {
  assert.deepEqual(strictSourceYieldEvidence({
    onlineProduct: { online_status: "selling", stock: 1 },
    profitRate: 30.01,
    shippingMode: "FBS",
    productUrl: "https://www.ozon.ru/product/strict-proof-1234567890/?sh=proof",
  }), {
    strict_confirmed: true,
    online_status: "selling",
    stock: 1,
    profit_rate: 30.01,
    shipping_mode: "FBS",
    product_url: "https://www.ozon.ru/product/strict-proof-1234567890/",
  });
  assert.deepEqual(strictSourceYieldEvidence({
    onlineProduct: { online_status: "selling", stock: 0 },
    profitRate: 31,
    shippingMode: "FBS",
  }), {});
  assert.deepEqual(strictSourceYieldEvidence({
    onlineProduct: { online_status: "selling", stock: 1 },
    profitRate: 30,
    shippingMode: "FBS",
  }), {});
  assert.deepEqual(strictSourceYieldEvidence({
    onlineProduct: { online_status: "selling", stock: 1 },
    profitRate: 31,
    shippingMode: "FBO",
  }), {});
});

test("duplicate title keys require a long exact normalized title", () => {
  assert.equal(duplicateTitleKey("Комплект трусов"), null);
  assert.equal(
    duplicateTitleKey("Плюшевый коврик-пазл из 10 частей!"),
    duplicateTitleKey(" плюшевый коврик пазл из 10 частей "),
  );
  assert.notEqual(
    duplicateTitleKey("Плюшевый коврик-пазл из 10 частей"),
    duplicateTitleKey("Плюшевый коврик-пазл из 12 частей"),
  );
});

test("publish feedback reuses an unchanged source-yield history and refreshes after append", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-publish-feedback-"));
  const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-publish-feedback-seed-"));
  const filename = path.join(runDir, "source_yield.jsonl");
  const seedFilename = path.join(seedDir, "source_yield.jsonl");
  clearObservedPublishFeedbackCache();
  await fs.writeFile(seedFilename, `${JSON.stringify({
    sku: "seeded",
    source_url: "https://www.ozon.ru/seller/seeded/",
    title: "Детские аксессуары",
    status: "published",
  })}\n`);
  await fs.writeFile(filename, `${JSON.stringify({
    sku: "one",
    source_url: "https://www.ozon.ru/seller/one/",
    title: "Детский аксессуар",
    status: "published",
  })}\n`);

  const first = await loadObservedPublishFeedback(runDir, [seedFilename]);
  assert.ok(Number(first.sourceScores.get("https://www.ozon.ru/seller/seeded/") || 0) > 0);
  assert.strictEqual(await loadObservedPublishFeedback(runDir, [seedFilename]), first);
  assert.equal(observedPublishFeedbackCacheStats(runDir).full_reads, 1);

  await fs.appendFile(filename, `${JSON.stringify({
    sku: "two",
    source_url: "https://www.ozon.ru/seller/two/",
    title: "Детская одежда",
    status: "published",
  })}\n`);
  assert.notStrictEqual(await loadObservedPublishFeedback(runDir, [seedFilename]), first);
  assert.equal(observedPublishFeedbackCacheStats(runDir).full_reads, 1);
  assert.equal(observedPublishFeedbackCacheStats(runDir).append_reads, 1);
  await fs.rm(runDir, { recursive: true, force: true });
  await fs.rm(seedDir, { recursive: true, force: true });
});

const VALID_FBS_EVIDENCE = Object.freeze({
  verified: true,
  rule: "test fixture with two independent live exact-FBS observations",
  observations: Object.freeze([
    Object.freeze({ mode: "FBS", detail_url: "https://www.ozon.ru/product/test?observation=1" }),
    Object.freeze({ mode: "FBS", detail_url: "https://www.ozon.ru/product/test?observation=2" }),
  ]),
});

const RELIABLE_COST_RESULT = Object.freeze({
  ok: true,
  cost: 20,
  source: "search_first_page_p70_similarity_filtered",
  prices: Object.freeze([18, 20, 22]),
  match_evidence_key: "e".repeat(64),
  same_item_match: true,
  returned_evidence_verified: true,
  match_evidence_contract: "1688-returned-same-item-v2",
  matched_offer_count: 3,
});

function fakeState(initial = {}, initialRunPublished = 0) {
  const statuses = new Map(Object.entries(initial).map(([sku, value]) => [sku,
    typeof value === "string" ? { status: value, data: {} } : {
      status: value.status,
      data: (() => {
        const data = { ...(value.data || {}) };
        if ((data.submitted === true || data.submission_pending === true)
          && !Object.hasOwn(data, "fbs_evidence")) {
          data.mode = "FBS";
          data.shipping_mode = "FBS";
          data.preflight_mode = "FBS";
          data.fbs_evidence = {
            ...VALID_FBS_EVIDENCE,
            observations: VALID_FBS_EVIDENCE.observations.map((row) => ({ ...row })),
          };
        }
        if ((data.submitted === true || data.submission_pending === true)
          && !Object.hasOwn(data, "cost_verified")
          && !Object.hasOwn(data, "cost")) {
          data.cost_verified = true;
          data.cost = {
            ok: true,
            cost: Number(data.purchase_price) > 0 ? Number(data.purchase_price) : 20,
            source: "test-reliable-1688-source",
          };
        }
        return data;
      })(),
    },
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
    entryOf: (sku) => {
      const value = statuses.get(String(sku));
      return value ? { sku: String(sku), status: value.status, data: { ...value.data } } : null;
    },
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

test("1688 failures use bounded summary reasons while retaining raw cost evidence separately", () => {
  assert.equal(normalizeCostFailureReason({
    reason: "extreme price spread without strong main cluster [3.2, 6.5, 36.4, 65.0]",
  }), "1688-no-reliable-match");
  assert.equal(normalizeCostFailureReason({ reason: "worker timed out after 120000ms" }), "1688-timeout");
  assert.equal(normalizeCostFailureReason({ error: { code: "IMAGE_DOWNLOAD_FAILED" } }), "1688-image-fetch-failed");
});

test("production cost contract rejects a positive number without reliable same-item evidence", async () => {
  const state = fakeState();
  let publishCalls = 0;
  const result = await createPublishRunner({
    client: clientFor([{ sku: "weak-cost" }], {
      publish: async () => {
        publishCalls += 1;
        return { ok: true };
      },
    }),
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    runDir: "/tmp/run",
    requireReliableCostContract: true,
  }).run();
  assert.equal(result.published, 0);
  assert.equal(publishCalls, 0);
  assert.ok(state.transitions.some((row) => (
    row.status === "skipped"
    && row.data.reason === "1688-same-item-evidence-missing"
  )));
});

test("validation-only stops after three fully gated candidates without submitting or mutating favorites", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-validation-only-"));
  try {
    let publishCalls = 0;
    let favoriteDeletes = 0;
    const state = fakeState();
    const client = clientFor([
      { sku: "gate-1", title: "Детский аксессуар один" },
      { sku: "gate-2", title: "Детский аксессуар два" },
      { sku: "gate-3", title: "Детский аксессуар три" },
      { sku: "gate-4", title: "Детский аксессуар четыре" },
    ], {
      publish: async () => { publishCalls += 1; return { ok: true }; },
      deleteFavorite: async () => { favoriteDeletes += 1; return true; },
    });
    const result = await createPublishRunner({
      client,
      costBridge: { estimate: async () => ({ ok: true, cost: 20, evidence: { reliable: true } }) },
      state,
      target: 500,
      runDir,
      validationOnly: true,
      validationTarget: 3,
    }).run();

    assert.equal(result.validated, 3);
    assert.equal(result.published, 0);
    assert.equal(publishCalls, 0);
    assert.equal(favoriteDeletes, 0);
    assert.equal(state.selections.length, 0);
    assert.equal(state.transitions.length, 0);
    const rows = (await fs.readFile(path.join(runDir, "validation_gate.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.status === "validated"
      && row.shipping_mode === "FBS"
      && row.profit_rate > 30));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("validation-only is read-only for imported, historical, restored, deferred, and error candidates", async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-validation-read-only-"));
  t.after(() => fs.rm(runDir, { recursive: true, force: true }));
  const state = fakeState({
    "sqlite-published": { status: "published", data: { title: "SQLite published item", store_id: 7 } },
    "restored-failed": { status: "failed", data: { reason: "exception" } },
    "restored-processing": { status: "processing", data: { reason: "processing-started" } },
    "skip-intent": { status: "processing", data: { skip_intent: true, reason: "policy-skipped" } },
    "submitted-intent": { status: "processing", data: { submission_intent: true, submitted: false } },
    "restored-skipped": { status: "skipped", data: { reason: "policy-skipped" } },
  });
  const originalHasPublished = state.hasPublished;
  state.hasPublished = (sku) => String(sku) === "history-published" || originalHasPublished(sku);
  let canAttemptCalls = 0;
  state.canAttempt = async () => {
    canAttemptCalls += 1;
    return { allowed: true };
  };
  let listAllFavoritesCalls = 0;
  let favoriteDeletes = 0;
  let publishCalls = 0;
  let reconciliationCalls = 0;
  const client = clientFor([
    { sku: "imported", is_imported: true },
    { sku: "history-published" },
    { sku: "sqlite-published" },
    { sku: "restored-failed" },
    { sku: "restored-processing" },
    { sku: "skip-intent" },
    { sku: "submitted-intent" },
    { sku: "restored-skipped" },
    { sku: "cost-deferred" },
    { sku: "soft-error" },
    { sku: "generic-error" },
  ], {
    listAllFavorites: async () => {
      listAllFavoritesCalls += 1;
      return [{ sku: "imported", is_imported: true }];
    },
    deleteFavorite: async () => {
      favoriteDeletes += 1;
      return true;
    },
    publish: async () => {
      publishCalls += 1;
      return { ok: true };
    },
    findImportLog: async () => {
      reconciliationCalls += 1;
      return null;
    },
    getProductDetail: async (sku) => {
      if (sku === "soft-error") throw new Error(`Ozon detail soft blocked for SKU ${sku}`);
      if (sku === "generic-error") throw new Error("validation detail failure");
      return {
        sku,
        mode: "FBS",
        title: `safe item ${sku}`,
        cover_image: "https://img.example/safe.jpg",
        current_price: 100,
        follow_min: 90,
      };
    },
  });
  const result = await createPublishRunner({
    client,
    costBridge: {
      estimate: async (item) => item.sku === "cost-deferred"
        ? { ok: false, deferred: true, terminal: false, retry_at: "2026-07-30T12:00:00.000Z" }
        : { ok: true, cost: 20 },
    },
    state,
    target: 500,
    runDir,
    validationOnly: true,
    validationTarget: 20,
    importedFavoriteCleanupLimit: 20,
    concurrency: 1,
  }).run();

  assert.equal(result.validated, 3);
  assert.equal(listAllFavoritesCalls, 0);
  assert.equal(favoriteDeletes, 0);
  assert.equal(publishCalls, 0);
  assert.equal(reconciliationCalls, 0);
  assert.equal(canAttemptCalls, 6);
  assert.equal(state.transitions.length, 0);
  assert.equal(state.selections.length, 0);
  assert.equal(state.records.length, 0);
});

test("normal mode retains imported and historical favorite cleanup", async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-normal-cleanup-"));
  t.after(() => fs.rm(runDir, { recursive: true, force: true }));
  const state = fakeState({
    "sqlite-published": { status: "published", data: { title: "SQLite published item", store_id: 7 } },
  });
  const originalHasPublished = state.hasPublished;
  state.hasPublished = (sku) => String(sku) === "history-published" || originalHasPublished(sku);
  let listAllFavoritesCalls = 0;
  const deleted = [];
  const client = clientFor([
    { sku: "history-published" },
    { sku: "sqlite-published" },
  ], {
    listAllFavorites: async () => {
      listAllFavoritesCalls += 1;
      return [{ sku: "imported", is_imported: true }];
    },
    deleteFavorite: async (item) => {
      deleted.push(String(item.sku));
      return true;
    },
  });
  await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    runDir,
    importedFavoriteCleanupLimit: 20,
    concurrency: 1,
  }).run();

  assert.equal(listAllFavoritesCalls, 1);
  assert.deepEqual(deleted.sort(), ["history-published", "imported", "sqlite-published"]);
});

test("validation-only fails closed without synchronizing a missing warehouse", async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-validation-warehouse-"));
  t.after(() => fs.rm(runDir, { recursive: true, force: true }));
  let syncWarehouseCalls = 0;
  let listFavoritesCalls = 0;
  const client = clientFor([{ sku: "candidate" }], {
    resolvePublishTarget: async () => ({
      store: { id: 7, name: "丽丽1号" },
      watermark: { id: 8, name: "lysh" },
    }),
    syncWarehouses: async () => {
      syncWarehouseCalls += 1;
    },
    listFavorites: async () => {
      listFavoritesCalls += 1;
      return [{ sku: "candidate" }];
    },
  });
  const runner = createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state: fakeState(),
    target: 500,
    runDir,
    validationOnly: true,
    storeTargets: [{
      id: 7,
      needle: "丽丽1号",
      warehouseId: null,
      requireWarehouse: true,
    }],
  });

  await assert.rejects(runner.run(), /verified FBS warehouse unavailable/u);
  assert.equal(syncWarehouseCalls, 0);
  assert.equal(listFavoritesCalls, 0);
});

test("validation-only ledger bounds poison retries and lets later candidates refill the buffer", async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-validation-ledger-"));
  t.after(() => fs.rm(runDir, { recursive: true, force: true }));
  let current = new Date("2026-07-30T02:00:00.000Z");
  const detailCalls = new Map();
  const state = fakeState();
  const client = clientFor([
    { sku: "deterministic-reject" },
    { sku: "transient-poison" },
    { sku: "later-safe-1" },
    { sku: "later-safe-2" },
    { sku: "later-safe-3" },
  ], {
    getProductDetail: async (sku) => {
      detailCalls.set(String(sku), Number(detailCalls.get(String(sku)) || 0) + 1);
      if (sku === "deterministic-reject") {
        return { sku, mode: "FBO", title: "not FBS", current_price: 100 };
      }
      if (sku === "transient-poison") throw new Error("temporary validation detail failure");
      return {
        sku,
        mode: "FBS",
        title: `safe item ${sku}`,
        cover_image: "https://img.example/safe.jpg",
        current_price: 100,
        follow_min: 90,
      };
    },
  });
  const runner = createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 500,
    runDir,
    validationOnly: true,
    validationTarget: 2,
    concurrency: 1,
    now: () => new Date(current),
  });

  const first = await runner.run({ validationOnly: true, validationTarget: 2, attemptLimit: 2 });
  assert.equal(first.validated, 0);
  assert.equal(detailCalls.get("deterministic-reject"), 1);
  assert.equal(detailCalls.get("transient-poison"), 1);

  const immediate = await runner.run({ validationOnly: true, validationTarget: 2, attemptLimit: 2 });
  assert.equal(immediate.validated, 2);
  assert.equal(detailCalls.get("deterministic-reject"), 1);
  assert.equal(detailCalls.get("transient-poison"), 1);

  current = new Date(current.getTime() + 31_000);
  const secondPoisonAttempt = await runner.run({
    validationOnly: true,
    validationTarget: 1,
    attemptLimit: 1,
  });
  assert.equal(secondPoisonAttempt.validated, 0);
  assert.equal(detailCalls.get("transient-poison"), 2);

  current = new Date(current.getTime() + 61_000);
  const afterLimit = await runner.run({ validationOnly: true, validationTarget: 1, attemptLimit: 1 });
  assert.equal(afterLimit.validated, 1);
  assert.equal(detailCalls.get("transient-poison"), 2);
  assert.equal(detailCalls.get("later-safe-3"), 2);

  current = new Date("2026-07-31T02:00:00.000Z");
  await runner.run({ validationOnly: true, validationTarget: 1, attemptLimit: 1 });
  assert.equal(detailCalls.get("transient-poison"), 3);
  assert.equal(state.transitions.length, 0);
  assert.equal(state.selections.length, 0);
  assert.equal(state.records.length, 0);

  const rows = (await fs.readFile(path.join(runDir, "validation_gate.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(rows.filter((row) => row.sku === "deterministic-reject" && row.status === "rejected").length, 1);
  assert.equal(rows.filter((row) => row.sku === "transient-poison" && row.status === "failed").length, 3);
  assert.equal(rows.filter((row) => row.status === "validated").length, 3);
});

test("one runner alternates a bounded publish tranche and gate-safe validation refill", async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-same-worker-refill-"));
  t.after(() => fs.rm(runDir, { recursive: true, force: true }));
  const gateFile = path.join(runDir, "staged_acceptance_gates.json");
  await fs.writeFile(gateFile, `${JSON.stringify({
    submission_gate: {
      phase: "three-sku",
      target_skus: ["gate-1", "gate-2", "gate-3"],
    },
  })}\n`);
  let publishCalls = 0;
  const state = fakeState();
  const runner = createPublishRunner({
    client: clientFor([
      { sku: "outside-1", title: "Безопасный товар один" },
      { sku: "outside-2", title: "Безопасный товар два" },
      { sku: "outside-3", title: "Безопасный товар три" },
      { sku: "outside-4", title: "Безопасный товар четыре" },
    ], {
      publish: async () => {
        publishCalls += 1;
        return { ok: true };
      },
    }),
    costBridge: { estimate: async () => ({ ok: true, cost: 20, evidence: { reliable: true } }) },
    state,
    target: 500,
    runDir,
    submissionGateFile: gateFile,
    concurrency: 4,
  });

  const refill = await runner.run({
    validationOnly: true,
    validationTarget: 8,
    attemptLimit: 2,
  });
  assert.equal(refill.validated, 2);
  assert.equal(refill.attempted, 2);
  assert.equal(publishCalls, 0);
  assert.equal(state.transitions.length, 0);
  assert.equal(state.selections.length, 0);
  const rows = (await fs.readFile(path.join(runDir, "validation_gate.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.ok(rows.every((row) => row.validation_mode === "buffer"));

  const blockedPublish = await runner.run({
    validationOnly: false,
    attemptLimit: 8,
  });
  assert.equal(blockedPublish.attempted, 0);
  assert.equal(publishCalls, 0);

  await fs.writeFile(gateFile, `${JSON.stringify({
    submission_gate: { phase: "failed", target_skus: ["gate-1", "gate-2", "gate-3"] },
  })}\n`);
  await assert.rejects(
    runner.run({ validationOnly: true, validationTarget: 1, attemptLimit: 1 }),
    /closed after a failed acceptance gate/u,
  );
});

test("fresh submission requires two consistent live exact-FBS observations", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-double-fbs-"));
  try {
    let detailCalls = 0;
    let publishCalls = 0;
    const state = fakeState();
    const client = clientFor([{ sku: "unstable-fbs" }], {
      getProductDetail: async (sku) => {
        detailCalls += 1;
        return {
          sku,
          mode: detailCalls === 1 ? "FBS" : null,
          title: "unstable shipping evidence",
          cover_image: "https://img.example/unstable.jpg",
          current_price: 100,
        };
      },
      publish: async () => { publishCalls += 1; return { ok: true }; },
    });
    const result = await createPublishRunner({
      client,
      costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
      state,
      target: 1,
      runDir,
    }).run();

    assert.equal(detailCalls, 2);
    assert.equal(publishCalls, 0);
    assert.equal(result.published, 0);
    assert.ok(state.transitions.some((row) => row.status === "skipped"
      && row.data.reason === "fbs-confirmation-inconsistent"));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("selected and published state persist both exact-FBS observations", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-fbs-evidence-"));
  try {
    let detailCalls = 0;
    const state = fakeState();
    const client = clientFor([{ sku: "stable-fbs" }], {
      getProductDetail: async (sku) => ({
        sku,
        mode: "FBS",
        title: "stable shipping evidence",
        cover_image: "https://img.example/stable.jpg",
        current_price: 100,
        detail_url: `https://www.ozon.ru/product/${sku}?observation=${++detailCalls}`,
      }),
    });
    const result = await createPublishRunner({
      client,
      costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
      state,
      target: 1,
      runDir,
    }).run();

    assert.equal(result.published, 1);
    assert.equal(detailCalls, 2);
    assert.equal(state.selections[0].shipping_mode, "FBS");
    assert.equal(state.selections[0].preflight_mode, "FBS");
    assert.equal(state.selections[0].fbs_evidence.verified, true);
    assert.equal(state.selections[0].fbs_evidence.observations.length, 2);
    assert.equal(state.selections[0].cost_verified, true);
    assert.deepEqual(state.selections[0].cost, { ok: true, cost: 20 });
    assert.equal(state.records[0].fbs_evidence.verified, true);
    assert.equal(state.records[0].cost_verified, true);
    assert.deepEqual(state.records[0].cost, { ok: true, cost: 20 });
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("restored submitted rows without durable FBS proof are quarantined without reconciliation", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-fbs-quarantine-"));
  try {
    let importChecks = 0;
    const state = fakeState({
      unsafe: {
        status: "processing",
        data: {
          sku: "unsafe",
          title: "missing proof",
          store_id: 104965,
          submitted: true,
          submission_pending: true,
          offer_id: "mz-unsafe",
          prepared_at: "2026-07-27T04:00:00.000Z",
          fbs_evidence: null,
        },
      },
    });
    const client = clientFor([{ sku: "unsafe", title: "missing proof" }], {
      findImportLog: async () => { importChecks += 1; return null; },
    });
    const runner = createPublishRunner({
      client,
      costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
      state,
      target: 1,
      runDir,
      now: () => new Date("2026-07-27T05:00:00.000Z"),
    });
    const result = await runner.run();

    assert.equal(importChecks, 0);
    assert.equal(result.published, 0);
    const quarantined = state.entries().find((row) => row.sku === "unsafe");
    assert.equal(quarantined.status, "failed");
    assert.equal(quarantined.data.reason, "fbs-evidence-missing");
    assert.equal(quarantined.data.submitted, true);
    assert.equal(quarantined.data.submission_pending, false);

    const repeated = await runner.run();
    assert.equal(repeated.failed, 0);
    const yieldRows = (await fs.readFile(path.join(runDir, "source_yield.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.equal(yieldRows.length, 1);
    assert.equal(yieldRows[0].reason, "fbs-evidence-missing");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("restored submitted rows without reliable 1688 cost proof are quarantined before reconciliation", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-cost-quarantine-"));
  try {
    let importChecks = 0;
    const state = fakeState({
      unsafe: {
        status: "processing",
        data: {
          sku: "unsafe",
          title: "missing cost proof",
          store_id: 104965,
          submitted: true,
          submission_pending: true,
          offer_id: "mz-unsafe-cost",
          prepared_at: "2026-07-27T04:00:00.000Z",
          cost_verified: false,
          cost: null,
        },
      },
    });
    const client = clientFor([{ sku: "unsafe", title: "missing cost proof" }], {
      findImportLog: async () => { importChecks += 1; return null; },
    });
    const runner = createPublishRunner({
      client,
      costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
      state,
      target: 1,
      runDir,
      now: () => new Date("2026-07-27T05:00:00.000Z"),
    });
    const result = await runner.run();

    assert.equal(importChecks, 0);
    assert.equal(result.published, 0);
    const quarantined = state.entries().find((row) => row.sku === "unsafe");
    assert.equal(quarantined.status, "failed");
    assert.equal(quarantined.data.reason, "1688-cost-evidence-missing");
    assert.equal(quarantined.data.terminal, true);
    assert.equal(quarantined.data.submission_pending, false);

    const repeated = await runner.run();
    assert.equal(repeated.failed, 0);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("1688 health collapse defers the favorite without consuming it and retries after recovery", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-health-defer-"));
  try {
    let current = new Date("2026-07-18T03:00:00.000Z");
    let costCalls = 0;
    let favoriteDeletes = 0;
    let importChecks = 0;
    const state = fakeState();
    const item = { id: 1688001, sku: "1688001" };
    const client = clientFor([item], {
      deleteFavorite: async () => { favoriteDeletes += 1; return true; },
      findImportLog: async (input) => {
        importChecks += 1;
        return { sku: input.sku, offer_id: input.offerId, import_status: "all_imported" };
      },
    });
    const runner = createPublishRunner({
      client,
      costBridge: {
        estimate: async () => {
          costCalls += 1;
          if (costCalls === 1) {
            return {
              ok: false,
              reason: "filtered first-page 1688 candidates fewer than 3",
              deferred: true,
              terminal: false,
              retry_at: "2026-07-18T03:05:00.000Z",
              health: { circuit: "open" },
            };
          }
          return { ok: true, cost: 20, health: { recovered: true } };
        },
      },
      state,
      target: 1,
      runDir,
      now: () => current,
      confirmationAttempts: 1,
      confirmationIntervalMs: 0,
    });

    const deferred = await runner.run();
    assert.equal(deferred.published, 0);
    assert.equal(favoriteDeletes, 0);
    assert.equal(state.entries()[0].status, "failed");
    assert.equal(state.entries()[0].data.reason, "1688-health-deferred");
    assert.equal(state.entries()[0].data.retry_at, "2026-07-18T03:05:00.000Z");

    current = new Date("2026-07-18T03:04:00.000Z");
    await runner.run();
    assert.equal(costCalls, 1);
    assert.equal(importChecks, 0);

    current = new Date("2026-07-18T03:06:00.000Z");
    const recovered = await runner.run();
    assert.equal(costCalls, 2);
    assert.equal(recovered.published, 1);
    assert.equal(favoriteDeletes, 0);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("Ozon detail soft blocks use durable 30-second backoff instead of retrying every consumer round", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-ozon-detail-defer-"));
  try {
    let current = new Date("2026-07-29T10:00:00.000Z");
    let detailCalls = 0;
    const state = fakeState();
    const client = clientFor([{ id: 3632757227, sku: "3632757227" }], {
      getProductDetail: async (sku) => {
        detailCalls += 1;
        if (detailCalls === 1) throw new Error(`Ozon detail soft blocked for SKU ${sku}`);
        return {
          sku,
          mode: "FBS",
          title: "standard safe product",
          cover_image: "https://img.example/safe.jpg",
          current_price: 100,
          follow_min: 90,
        };
      },
    });
    const runner = createPublishRunner({
      client,
      costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
      state,
      target: 1,
      runDir,
      now: () => current,
      confirmationAttempts: 1,
      confirmationIntervalMs: 0,
    });

    const deferred = await runner.run();
    assert.equal(deferred.published, 0);
    assert.equal(detailCalls, 1);
    assert.equal(state.entries()[0].status, "failed");
    assert.equal(state.entries()[0].data.reason, "ozon-detail-soft-block-deferred");
    assert.equal(state.entries()[0].data.retry_at, "2026-07-29T10:00:30.000Z");

    current = new Date("2026-07-29T10:00:20.000Z");
    await runner.run();
    assert.equal(detailCalls, 1);

    current = new Date("2026-07-29T10:00:31.000Z");
    const recovered = await runner.run();
    assert.equal(detailCalls, 3);
    assert.equal(recovered.published, 1);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("repeated Ozon detail soft blocks stop after two bounded daily retries", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-ozon-detail-backoff-"));
  try {
    let current = new Date("2026-07-29T10:00:00.000Z");
    let detailCalls = 0;
    const state = fakeState();
    const client = clientFor([{ id: 3632757227, sku: "3632757227" }], {
      getProductDetail: async (sku) => {
        detailCalls += 1;
        throw new Error(`Ozon detail soft blocked for SKU ${sku}`);
      },
    });
    const runner = createPublishRunner({
      client,
      costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
      state,
      target: 1,
      runDir,
      now: () => current,
    });

    await runner.run();
    assert.equal(state.entries()[0].data.retry_at, "2026-07-29T10:00:30.000Z");
    current = new Date("2026-07-29T10:00:31.000Z");
    await runner.run();
    assert.equal(state.entries()[0].data.retry_at, "2026-07-29T10:01:31.000Z");
    current = new Date("2026-07-29T10:01:32.000Z");
    await runner.run();
    assert.equal(state.entries()[0].data.retry_at, null);
    assert.equal(state.entries()[0].data.reason, "transient-retry-limit-exhausted");
    assert.equal(state.entries()[0].data.original_reason, "ozon-detail-soft-block-deferred");
    assert.equal(state.entries()[0].data.terminal, true);
    assert.equal(detailCalls, 3);
    current = new Date("2026-07-29T10:10:00.000Z");
    await runner.run();
    assert.equal(detailCalls, 3);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

function clientFor(items, overrides = {}) {
  return {
    resolvePublishTarget: async () => ({ store: { id: 7, name: "丽丽1号" }, watermark: { id: 8, name: "lysh" } }),
    listFavorites: async () => items,
    listAllFavorites: async () => [],
    getProductDetail: async (sku) => ({
      sku,
      mode: "FBS",
      title: "safe item",
      cover_image: "https://img.example/safe.jpg",
      current_price: 100,
      follow_min: 90,
    }),
    getCategoryBySku: async () => ({ cate: [11, 22, "1,12.00"], product_info: { weight: 100, depth: 20, width: 10, height: 5 } }),
    listCategoryCommissions: async () => [{
      cate_id: 11,
      label: "Игрушки",
      children: [{
        cate_id: 22,
        label: "Настольные игры",
        children: [{ label: "售价 ≤ 1500₽", value: "1,12.00" }],
      }],
    }],
    calculateProfit: async () => economy(),
    publish: async () => ({ ok: true, response: { code: 1 } }),
    findImportLog: async ({ sku }) => ({ sku, offer_id: `mz-test-${sku}`, import_status: "all_imported" }),
    findOnlineProduct: async ({ offerId }) => ({ sku: 900001, offer_id: offerId, online_status: "selling", stock: 1 }),
    deleteFavorite: async () => true,
    findPublishedSku: async () => null,
    ...overrides,
  };
}

test("runner rejects incomplete favorite content before 1688 or publish work", async () => {
  const state = fakeState();
  let costCalls = 0;
  let publishCalls = 0;
  const client = clientFor([
    { sku: "missing-title", cover_image: "https://ir-20.ozonstatic.cn/s3/multimedia/c600/title.jpg" },
    { sku: "missing-image", title: "Безопасный товар" },
  ], {
    getProductDetail: async (sku) => ({
      sku,
      mode: "FBS",
      detail_title: `Ozon ${sku}`,
      current_price: 100,
      follow_min: 90,
    }),
    publish: async () => {
      publishCalls += 1;
      return { ok: true };
    },
  });
  const result = await createPublishRunner({
    client,
    costBridge: {
      estimate: async () => {
        costCalls += 1;
        return { ok: true, cost: 20 };
      },
    },
    state,
    target: 1,
    runDir: "/tmp/run",
  }).run();

  assert.equal(result.published, 0);
  assert.equal(costCalls, 0);
  assert.equal(publishCalls, 0);
  assert.ok(state.transitions.some(
    (event) => event.sku === "missing-title" && event.data.reason === "missing-title",
  ));
  assert.ok(state.transitions.some(
    (event) => event.sku === "missing-image" && event.data.reason === "missing-cover-image",
  ));
});

test("category mapping deferral never enters submission reconciliation", async () => {
  let current = new Date("2026-07-30T04:00:00.000Z");
  const state = fakeState();
  let detailCalls = 0;
  let importLogCalls = 0;
  let costCalls = 0;
  let publishCalls = 0;
  let favoriteDeletes = 0;
  const client = clientFor([{
    sku: "category-drift",
    title: "Безопасная настольная игра",
    cover_image: "https://ir-20.ozonstatic.cn/s3/multimedia/c600/category.jpg",
  }], {
    getProductDetail: async (sku) => {
      detailCalls += 1;
      return { sku, mode: "FBS", current_price: 100, follow_min: 90 };
    },
    listCategoryCommissions: async () => [{
      cate_id: 99,
      label: "Несовпадающий раздел",
      children: [{
        cate_id: 22,
        label: "Настольные игры",
        children: [{ label: "售价 ≤ 1500₽", value: "1,12.00" }],
      }],
    }],
    findImportLog: async ({ sku }) => {
      importLogCalls += 1;
      return { sku, offer_id: `historical-${sku}`, import_status: "all_imported" };
    },
    deleteFavorite: async () => {
      favoriteDeletes += 1;
      return true;
    },
    publish: async () => {
      publishCalls += 1;
      return { ok: true };
    },
  });
  const runner = createPublishRunner({
    client,
    costBridge: {
      estimate: async () => {
        costCalls += 1;
        return { ok: true, cost: 20 };
      },
    },
    state,
    target: 1,
    runDir: "/tmp/run",
    now: () => new Date(current),
  });

  await runner.run();
  assert.equal(state.entryOf("category-drift").data.reason, "category-mapping-unavailable");
  await runner.run();
  assert.equal(detailCalls, 2);
  current = new Date(current.getTime() + 300_001);
  await runner.run();
  assert.equal(detailCalls, 4);
  current = new Date(current.getTime() + 300_001);
  await runner.run();
  assert.equal(state.entryOf("category-drift").data.reason, "transient-retry-limit-exhausted");
  const terminalDetailCalls = detailCalls;
  await runner.run();
  assert.equal(detailCalls, terminalDetailCalls);
  assert.equal(importLogCalls, 0);
  assert.equal(costCalls, 0);
  assert.equal(publishCalls, 0);
  assert.equal(favoriteDeletes, 0);
  assert.equal(state.records.length, 0);
});

test("runner skips an exact long-title duplicate before Ozon detail and 1688", async () => {
  const title = "Плюшевый коврик-пазл из десяти частей для малышей";
  const state = fakeState({
    existing: {
      status: "published",
      data: { sku: "existing", title, store_id: 8, published_at: "2026-07-17T00:00:00Z" },
    },
  });
  let detailCalls = 0;
  let costCalls = 0;
  const client = clientFor([{ sku: "duplicate", title }], {
    getProductDetail: async () => { detailCalls += 1; throw new Error("must not load detail"); },
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => { costCalls += 1; return { ok: true, cost: 20 }; } },
    state,
    target: 1,
    runDir: "/tmp/run",
  }).run();

  assert.equal(result.published, 0);
  assert.equal(detailCalls, 0);
  assert.equal(costCalls, 0);
  assert.ok(state.transitions.some((event) => event.sku === "duplicate"
    && event.status === "skipped"
    && event.data.reason === "duplicate-title"
    && event.data.duplicate_of_sku === "existing"));
});

test("same-store exact-title variants remain eligible", async () => {
  const title = "Плюшевый коврик-пазл из десяти частей для малышей";
  const state = fakeState();
  let publishCalls = 0;
  const client = clientFor([
    { sku: "first", title },
    { sku: "second", title },
  ], {
    getProductDetail: async (sku) => ({
      sku,
      mode: "FBS",
      title,
      cover_image: "https://img.example/safe.jpg",
      current_price: 100,
      follow_min: 90,
    }),
    publish: async () => { publishCalls += 1; return { ok: true, response: { code: 1 } }; },
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 2,
    concurrency: 2,
    runDir: "/tmp/run",
  }).run();

  assert.equal(result.published, 2);
  assert.equal(publishCalls, 2);
  assert.equal(state.selections.length, 2);
  assert.ok(!state.transitions.some((event) => event.status === "skipped"
    && event.data.reason === "duplicate-title"));
});

test("publish candidates demote prohibited title families independently of API order", () => {
  const items = [
    { sku: "ordinary-low", title: "Воздушные шары из фольги", sell_price: 10 },
    { sku: "ordinary-high", title: "Рюкзак", sell_price: 60 },
    { sku: "toy", title: "Детская игрушка" },
    { sku: "hat", title: "Панама для девочек" },
    { sku: "underwear", title: "Комплект трусов" },
  ];
  assert.deepEqual(prioritizePublishCandidates(items).map((item) => item.sku), [
    "ordinary-high",
    "ordinary-low",
    "toy",
    "hat",
    "underwear",
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

test("cross-window candidate facts retain cached economics but require two live exact-FBS observations", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-cross-window-facts-"));
  const seedFile = path.join(runDir, "previous-favorites.jsonl");
  await fs.writeFile(seedFile, `${JSON.stringify({
    status: "favorited",
    preflight_mode: "FBS",
    sku: "seeded-900",
    shipping_mode: "FBS",
    sale_price: 259,
    source_currency: "RUB",
    title: "Детский аксессуар",
    cover_image: "https://img.example/seeded-900.jpg",
    source_url: "https://www.ozon.ru/seller/proven/",
  })}\n`);
  let detailCalls = 0;
  let categoryCalls = 0;
  let costCalls = 0;
  let estimatedSalePrice = null;
  let estimatedMatchEvidence = null;
  const state = fakeState();
  const client = clientFor([{ sku: "seeded-900", sell_price: 22.64 }], {
    getProductDetail: async (sku) => {
      detailCalls += 1;
      return {
        sku,
        mode: "FBS",
        title: "Детский аксессуар",
        current_price: 22.64,
        cover_image: "https://img.example/seeded-900.jpg",
        detail_url: `https://www.ozon.ru/product/${sku}?observation=${detailCalls}`,
      };
    },
    getCategoryBySku: async () => {
      categoryCalls += 1;
      return { cate: [11, 22, "1,12.00"], product_info: { weight: 100, depth: 20, width: 10, height: 5, model: "KIDS-900" } };
    },
    listCategoryCommissions: async () => [{
      cate_id: 11,
      label: "Аксессуары",
      children: [{
        cate_id: 22,
        label: "Детские аксессуары",
        children: [{ label: "售价 ≤ 1500₽", value: "1,12.00" }],
      }],
    }],
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async (item) => {
      costCalls += 1;
      estimatedSalePrice = item.sell_price;
      estimatedMatchEvidence = {
        title: item.expect_title,
        model: item.expect_model,
        category: item.expect_category,
      };
      return { ok: true, cost: 5 };
    } },
    state,
    runDir,
    target: 1,
    candidateFactSeedFiles: [seedFile],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.equal(detailCalls, 2);
  assert.equal(categoryCalls, 1);
  assert.equal(costCalls, 1);
  assert.equal(estimatedSalePrice, 22.64);
  assert.deepEqual(estimatedMatchEvidence, {
    title: "Детский аксессуар",
    model: "KIDS-900",
    category: "Аксессуары Детские аксессуары",
  });
  await fs.rm(runDir, { recursive: true, force: true });
});

test("1688 cost matching skips blank product model fields and keeps later model metadata", async () => {
  for (const [modelFields, expectedModel] of [
    [{ model: "", model_name: "M4", article: "ARTICLE-IGNORED" }, "M4"],
    [{ model: "  ", model_name: "", article: "A7" }, "A7"],
  ]) {
    const state = fakeState();
    let estimatedModel = null;
    const client = clientFor([{ sku: `model-fallback-${expectedModel}` }], {
      getCategoryBySku: async () => ({
        cate: [11, 22, "1,12.00"],
        product_info: {
          weight: 100,
          depth: 20,
          width: 10,
          height: 5,
          ...modelFields,
        },
      }),
    });

    const result = await createPublishRunner({
      client,
      costBridge: {
        estimate: async (item) => {
          estimatedModel = item.expect_model;
          return { ok: true, cost: 20 };
        },
      },
      state,
      target: 1,
      runDir: "/tmp/run",
      confirmationAttempts: 1,
      confirmationIntervalMs: 0,
    }).run();

    assert.equal(result.published, 1);
    assert.equal(estimatedModel, expectedModel);
  }
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

test("runner retries one transient ERP 502 import result without resubmitting", async () => {
  const state = fakeState();
  let publishCalls = 0;
  let importChecks = 0;
  const client = clientFor([{ id: 92, sku: 3465406112 }], {
    publish: async () => {
      publishCalls += 1;
      return { ok: true, response: { code: 1 } };
    },
    findImportLog: async ({ sku, offerId }) => {
      importChecks += 1;
      if (importChecks === 1) {
        return {
          sku,
          offer_id: offerId,
          import_status: "all_failed",
          error_msg: { code: 0, msg: "502:API请求失败", data: null },
        };
      }
      return { sku, offer_id: offerId, import_status: "all_imported" };
    },
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    confirmationAttempts: 2,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 1);
  assert.equal(publishCalls, 1);
  assert.equal(importChecks, 2);
});

test("reconciliation keeps an ERP 502 all-failed log retryable without resubmitting", async () => {
  const state = fakeState({
    delayed: {
      status: "failed",
      data: {
        store_id: 7,
        submitted: true,
        submission_pending: true,
        offer_id: "mz-290726-delayed",
        profit_rate: 43.45,
        reconcile_attempts: 0,
        reason: "import-failed",
        import_log: {
          import_status: "all_failed",
          error_msg: { code: 0, msg: "502:API请求失败", data: null },
        },
      },
    },
  });
  let publishCalls = 0;
  const client = clientFor([], {
    publish: async () => {
      publishCalls += 1;
      return { ok: true, response: { code: 1 } };
    },
    findImportLog: async ({ sku, offerId }) => ({
      sku,
      offer_id: offerId,
      import_status: "all_failed",
      error_msg: { code: 0, msg: "502:API请求失败", data: null },
      skus: [{ offer_id: offerId, import_status: "failed", error_msg: "502:API请求失败" }],
    }),
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    now: () => new Date("2026-07-29T13:00:00.000Z"),
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(result.published, 0);
  assert.equal(publishCalls, 0);
  const retry = state.transitions.at(-1);
  assert.equal(retry.status, "processing");
  assert.equal(retry.data.reason, "import-transient-error");
  assert.equal(retry.data.reconcile_attempts, 1);
  assert.equal(retry.data.next_reconcile_at, "2026-07-29T13:00:15.000Z");
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

test("runner persists the current store even when no store switch occurs", async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-current-store-"));
  t.after(() => fs.rm(runDir, { recursive: true, force: true }));
  const state = fakeState();
  const client = clientFor([], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: "丽丽二号" },
      watermark: { id: 60822, name: "lysh" },
    }),
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    runDir,
    target: 1,
    storeTargets: [{ id: 106637, needle: "丽丽二号", warehouseId: 1020005023256510 }],
  }).run();

  assert.equal(result.active_store_id, 106637);
  const currentStore = JSON.parse(await fs.readFile(path.join(runDir, "current_store.json"), "utf8"));
  assert.match(currentStore.at, /^20\d\d-/u);
  assert.deepEqual({ ...currentStore, at: null }, {
    at: null,
    store_id: 106637,
    store_name: "丽丽二号",
    warehouse_id: 1020005023256510,
    reason: "active",
  });
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

test("next quota day backfills a store with 94 strict and 6 terminal accepted submissions", async () => {
  const initial = {};
  for (let index = 0; index < 94; index += 1) {
    initial[`strict-${index}`] = {
      status: "published",
      data: { store_id: 106637, published_at: "2026-07-17T03:00:00.000Z" },
    };
  }
  for (let index = 0; index < 6; index += 1) {
    initial[`terminal-${index}`] = {
      status: "failed",
      data: {
        store_id: 106637,
        submitted: true,
        reason: "import-failed",
        submitted_at: "2026-07-17T04:00:00.000Z",
      },
    };
  }
  const state = fakeState(initial);
  const shopIds = [];
  const items = Array.from({ length: 7 }, (_, index) => ({ id: 700 + index, sku: String(700 + index) }));
  const client = clientFor(items, {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: `store-${storeId}`, product_limit: { daily_create: { usage: 0, limit: 100 } } },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async (payload) => { shopIds.push(payload.shop_ids[0]); return { ok: true }; },
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 101,
    now: () => new Date("2026-07-18T03:00:00.000Z"),
    totalStoreUsageSeed: { 106637: 100 },
    totalStoreUsageSeedIncludesRestored: true,
    storeTargets: [
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
      { id: 106640, needle: "丽丽三号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.deepEqual(shopIds, [106637, 106637, 106637, 106637, 106637, 106637, 106640]);
  assert.deepEqual(result.store_total_usage, { "106637": 100, "106640": 1 });
});

test("100 accepted submissions remain a hard same-day cap even when 6 are terminal", async () => {
  const initial = {};
  for (let index = 0; index < 94; index += 1) {
    initial[`strict-${index}`] = {
      status: "published",
      data: { store_id: 106637, published_at: "2026-07-17T03:00:00.000Z" },
    };
  }
  for (let index = 0; index < 6; index += 1) {
    initial[`terminal-${index}`] = {
      status: "failed",
      data: { store_id: 106637, submitted: true, reason: "import-failed", submitted_at: "2026-07-17T04:00:00.000Z" },
    };
  }
  const state = fakeState(initial);
  const shopIds = [];
  const client = clientFor([{ id: 800, sku: 800 }], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: `store-${storeId}`, product_limit: { daily_create: { usage: 0, limit: 100 } } },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async (payload) => { shopIds.push(payload.shop_ids[0]); return { ok: true }; },
  });

  await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 95,
    now: () => new Date("2026-07-17T05:00:00.000Z"),
    storeTargets: [
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
      { id: 106640, needle: "丽丽三号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.deepEqual(shopIds, [106640]);
});

test("one long-lived runner resets daily quota and returns to an earlier strict gap", async () => {
  let current = new Date("2026-07-17T05:00:00.000Z");
  let favorites = [];
  const initial = {};
  for (let index = 0; index < 94; index += 1) {
    initial[`strict-${index}`] = { status: "published", data: { store_id: 106637, published_at: "2026-07-17T03:00:00.000Z" } };
  }
  for (let index = 0; index < 6; index += 1) {
    initial[`terminal-${index}`] = { status: "failed", data: { store_id: 106637, submitted: true, reason: "import-failed", submitted_at: "2026-07-17T04:00:00.000Z" } };
  }
  const state = fakeState(initial);
  const shopIds = [];
  const client = clientFor([], {
    listFavorites: async () => favorites,
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: `store-${storeId}`, product_limit: { daily_create: { usage: 0, limit: 100 } } },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async (payload) => { shopIds.push(payload.shop_ids[0]); return { ok: true }; },
  });
  const runner = createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 95,
    now: () => current,
    storeTargets: [
      { id: 106637, needle: "丽丽二号", requireWarehouse: false },
      { id: 106640, needle: "丽丽三号", requireWarehouse: false },
    ],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  });

  const first = await runner.run();
  assert.equal(first.active_store_id, 106640);
  current = new Date("2026-07-18T05:00:00.000Z");
  favorites = [{ id: 900, sku: 900 }];
  await runner.run();
  assert.deepEqual(shopIds, [106637]);
});

test("runner reconciles reserved submissions when every store total target is temporarily full", async () => {
  const state = fakeState({
    pending: {
      status: "processing",
      data: {
        sku: "pending",
        store_id: 106637,
        submitted: true,
        submission_pending: true,
        offer_id: "mz-pending",
        prepared_at: "2026-07-15T09:00:00.000Z",
      },
    },
  });
  let publishCalls = 0;
  const client = clientFor([], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: "丽丽二号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async () => { publishCalls += 1; return { ok: true }; },
    findImportLog: async ({ sku, offerId }) => ({
      sku,
      offer_id: offerId,
      import_status: "all_failed",
      skus: [{ error_msg: "invalid category" }],
    }),
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    totalStoreLimit: 1,
    storeTargets: [{ id: 106637, needle: "丽丽二号", requireWarehouse: false }],
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(publishCalls, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.fresh_submissions_paused, true);
  assert.deepEqual(result.store_total_usage, { "106637": 0 });
  assert.ok(state.transitions.some((entry) => entry.sku === "pending" && entry.status === "failed"));
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

test("an imported warehouse-status rejection backlog rotates fresh work to the next store", async () => {
  const rejected = (preparedAt) => ({
    status: "processing",
    data: {
      store_id: 106637,
      submitted: true,
      prepared_at: preparedAt,
      reason: "stock-activation-rejected",
      import_log: { import_status: "all_imported" },
      final_result: {
        stock_update: {
          result: [{
            errors: [{ code: "WAREHOUSE_WRONG_STATUS", message: "warehouse is archived" }],
          }],
        },
      },
    },
  });
  const state = fakeState({
    "warehouse-rejected-1": rejected("2026-07-15T09:00:00.000Z"),
    "warehouse-rejected-2": rejected("2026-07-15T09:01:00.000Z"),
  });
  const shopIds = [];
  const client = clientFor([{ id: 212, sku: 212 }], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: { id: Number(storeId), name: Number(storeId) === 106637 ? "丽丽二号" : "丽丽三号" },
      watermark: { id: 60822, name: "lysh" },
    }),
    publish: async (payload) => { shopIds.push(payload.shop_ids[0]); return { ok: true }; },
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "all_imported" }),
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

  assert.deepEqual(shopIds, [106640]);
  assert.ok(result.store_switches.some((event) => event.from_store_id === 106637
    && event.to_store_id === 106640
    && event.reason === "submission-stall"));
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
    {
      sku: "prepared-only",
      status: "processing",
      data: {
        store_id: 104965,
        submission_intent: true,
        submitted: false,
        submission_pending: false,
        prepared_at: "2026-07-15T03:00:00Z",
      },
    },
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
    && event.daily_usage === 0
    && event.daily_limit === 100
    && event.warehouse_source === "erp-discovered"));
  await fs.rm(runDir, { recursive: true, force: true });
});

test("warehouse discovery accepts one explicit ERP warehouse from supported shop list fields", () => {
  assert.deepEqual(verifiedWarehouseCandidates({
    warehouse: [],
    warehouses: [{ warehouse_id: 7001, name: "FBS 五店仓" }],
    warehouse_list: [{ warehouse_id: 7001, name: "duplicate" }],
  }), [{ warehouse_id: 7001, name: "FBS 五店仓" }]);
});

test("warehouse discovery accepts an explicit unique warehouse from nested ERP containers", () => {
  assert.deepEqual(verifiedWarehouseCandidates({
    settings: {
      fulfillment: {
        warehouse_list: {
          data: [{ warehouse_id: 7002, name: "丽丽五号 FBS 仓" }],
          audit: { rows: [{ id: 9999, name: "request log" }] },
        },
      },
    },
  }), [{ warehouse_id: 7002, name: "丽丽五号 FBS 仓" }]);
});

test("runner proactively verifies an inactive store warehouse without publishing to it", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-probe-inactive-store-"));
  const state = fakeState();
  const syncCalls = [];
  const targetReads = new Map();
  const client = clientFor([], {
    resolvePublishTarget: async ({ storeId }) => {
      const id = Number(storeId);
      targetReads.set(id, Number(targetReads.get(id) || 0) + 1);
      return {
        store: {
          id,
          name: id === 106637 ? "丽丽二号" : "丽丽五号",
          product_limit: { daily_create: { limit: 100, usage: 0 } },
          warehouse: id === 106646 && Number(targetReads.get(id)) >= 2
            ? [{ warehouse_id: 5020005022957960, name: "丽丽五号 FBS 仓" }]
            : [],
        },
        watermark: { id: 60822, name: "lysh" },
      };
    },
    syncWarehouses: async (ids) => { syncCalls.push(ids); return { queued: true }; },
  });

  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    runDir,
    target: 0,
    storeTargets: [
      { id: 106637, needle: "丽丽二号", warehouseId: 1020005023256510 },
      { id: 106646, needle: "丽丽五号" },
    ],
    probeInactiveStores: true,
    warehouseSyncAttempts: 1,
    warehouseSyncIntervalMs: 0,
    sleep: async () => {},
  }).run();

  assert.equal(result.published, 0);
  assert.deepEqual(syncCalls, [[106646]]);
  const targetEvents = (await fs.readFile(path.join(runDir, "store_targets.jsonl"), "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(targetEvents.some((event) => event.store_id === 106646
    && event.warehouse_id === 5020005022957960
    && event.warehouse_source === "erp-discovered"));
  await fs.rm(runDir, { recursive: true, force: true });
});

test("runner caches an unavailable store between consumer rounds instead of repeating warehouse sync", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-unavailable-store-"));
  const state = fakeState();
  let syncCalls = 0;
  const client = clientFor([{ id: 206, sku: 206 }], {
    resolvePublishTarget: async ({ storeId }) => ({
      store: {
        id: Number(storeId),
        name: Number(storeId) === 106637 ? "丽丽二号" : "丽丽1号",
        warehouse: Number(storeId) === 104965
          ? [{ warehouse_id: 1020005022957960, name: "丽丽1号仓库" }]
          : [
            { warehouse_id: 7001, name: "候选仓一" },
            { warehouse_id: 7002, name: "候选仓二" },
          ],
      },
      watermark: { id: 60822, name: "lysh" },
    }),
    syncWarehouses: async () => { syncCalls += 1; return []; },
  });
  const runner = createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    runDir,
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
  const targetEvents = (await fs.readFile(path.join(runDir, "store_targets.jsonl"), "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(targetEvents.some((event) => event.store_id === 106637
    && event.available === false
    && event.reason === "warehouse-not-uniquely-verified"
    && event.warehouse_count === 2
    && event.warehouse_candidates.map((row) => row.warehouse_id).join(",") === "7001,7002"));
  await fs.rm(runDir, { recursive: true, force: true });
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

test("runner backs off a transient stock rejection and does not retry a duplicated reconciliation immediately", async () => {
  const sku = "stock-transient";
  const state = fakeState({
    [sku]: {
      status: "processing",
      data: {
        sku,
        submitted: true,
        submission_pending: true,
        offer_id: `mz-${sku}`,
        store_id: 7,
        prepared_at: "2026-07-15T00:00:00.000Z",
      },
    },
  });
  let stockCalls = 0;
  const client = clientFor([{ id: 901, sku }], {
    findImportLog: async () => ({ sku, offer_id: `mz-${sku}`, import_status: "all_imported" }),
    findOnlineProduct: async () => ({
      id: 902,
      product_id: 903,
      sku: 904,
      offer_id: `mz-${sku}`,
      online_status: "ready_to_sell",
      stock: 0,
    }),
    updateProductStock: async () => {
      stockCalls += 1;
      return { result: [{ updated: false, errors: [{ code: "TOO_MANY_REQUESTS", message: "Stock is updated too frequently" }] }] };
    },
  });

  await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    now: () => new Date("2026-07-15T10:00:00.000Z"),
    warehouseId: 1020005022957960,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(stockCalls, 1);
  const latest = state.entries().find((entry) => entry.sku === sku);
  assert.equal(latest.status, "processing");
  assert.equal(latest.data.reason, "stock-activation-rejected");
  assert.ok(Date.parse(latest.data.next_reconcile_at) > Date.parse("2026-07-15T10:00:00.000Z"));
});

test("runner terminalizes an explicit FBP-only stock rejection without repeating it", async () => {
  const sku = "stock-fbp-only";
  const state = fakeState({
    [sku]: {
      status: "processing",
      data: {
        sku,
        submitted: true,
        submission_pending: true,
        offer_id: `mz-${sku}`,
        store_id: 7,
        prepared_at: "2026-07-15T00:00:00.000Z",
      },
    },
  });
  let stockCalls = 0;
  const client = clientFor([{ id: 911, sku }], {
    findImportLog: async () => ({ sku, offer_id: `mz-${sku}`, import_status: "all_imported" }),
    findOnlineProduct: async () => ({
      id: 912,
      product_id: 913,
      sku: 914,
      offer_id: `mz-${sku}`,
      online_status: "ready_to_sell",
      stock: 0,
    }),
    updateProductStock: async () => {
      stockCalls += 1;
      return { result: [{ updated: false, errors: [{ code: "CB_DELIVERY_ONLY_FBP", message: "tags validation failed" }] }] };
    },
  });

  await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    now: () => new Date("2026-07-15T10:00:00.000Z"),
    warehouseId: 1020005022957960,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.equal(stockCalls, 1);
  const latest = state.entries().find((entry) => entry.sku === sku);
  assert.equal(latest.status, "failed");
  assert.equal(latest.data.reason, "stock-activation-terminal-rejected");
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
      return {
        sku,
        mode: "FBS",
        title: "safe",
        cover_image: "https://img.example/safe.jpg",
        current_price: 100,
        follow_min: 90,
      };
    },
    publish: async (payload) => payload.rows[0].sku === "1" ? { ok: false, response: { code: 0 } } : { ok: true, response: { code: 1 } },
  });
  const runner = createPublishRunner({ client, costBridge: { estimate: async () => ({ ok: true, cost: 20 }) }, state, target: 1, threshold: 30, runDir: "/tmp/run" });
  const result = await runner.run();

  assert.equal(result.published, 1);
  assert.ok(state.transitions.some((event) => event.sku === "1" && event.status === "failed"));
  assert.equal(state.records[0].sku, "2");
  assert.deepEqual(detailCalls, ["1", "1", "2", "2"]);
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
  assert.ok(state.transitions.some((event) => event.status === "skipped" && event.data.reason === "profit-upper-bound<=30"));
});

test("runner keeps the absolute profit floor above 30 when configuration is relaxed", async () => {
  const state = fakeState();
  let publishCalls = 0;
  const client = clientFor([{ id: 31, sku: 31 }], {
    calculateProfit: async () => economy(25),
    publish: async () => { publishCalls += 1; return { ok: true }; },
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    threshold: 20,
    runDir: "/tmp/run",
  }).run();
  assert.equal(result.published, 0);
  assert.equal(publishCalls, 0);
  assert.ok(state.transitions.some(
    (event) => event.status === "skipped" && event.data.reason === "profit_rate<=30",
  ));
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

test("an empty startup sync does not suppress the first post-submission sync", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-empty-sync-cooldown-"));
  const now = () => new Date("2026-07-15T08:06:00.000Z");
  await fs.writeFile(path.join(runDir, "store_syncs.jsonl"), `${JSON.stringify({
    at: "2026-07-15T08:05:00.000Z",
    store_id: 7,
    kind: "online-products",
    ok: true,
    pending_count: 0,
  })}\n`);
  const syncCalls = [];
  const client = clientFor([{ id: "fresh-after-empty-sync", sku: "fresh-after-empty-sync" }], {
    syncOnlineShops: async (...args) => { syncCalls.push(args); return { msg: "queued" }; },
  });

  await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state: fakeState(),
    runDir,
    now,
    target: 1,
    onlineSyncIntervalMs: 600_000,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.deepEqual(syncCalls, [[[7], "all"]]);
  await fs.rm(runDir, { recursive: true, force: true });
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

test("urgent online sync never runs more often than once every 180 seconds", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-urgent-sync-floor-"));
  const now = () => new Date("2026-07-15T08:02:59.000Z");
  await fs.writeFile(path.join(runDir, "store_syncs.jsonl"), `${JSON.stringify({
    at: "2026-07-15T08:00:00.000Z",
    store_id: 104965,
    kind: "online-products",
    ok: true,
    pending_count: 2,
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
    urgentOnlineSyncIntervalMs: 60_000,
    urgentOnlineSyncPendingCount: 2,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.deepEqual(syncCalls, []);
  await fs.rm(runDir, { recursive: true, force: true });
});

test("online sync Retry-After accepts properties, headers, dates, and rate-limit messages", () => {
  const nowMs = Date.parse("2026-07-15T08:00:00.000Z");
  assert.equal(onlineSyncRetryAfterMs({ retryAfterMs: 600_000 }, { nowMs }), 600_000);
  assert.equal(onlineSyncRetryAfterMs({
    response: { headers: { "retry-after": "420" } },
  }, { nowMs }), 420_000);
  assert.equal(onlineSyncRetryAfterMs({
    headers: new Headers({ "Retry-After": "Wed, 15 Jul 2026 08:10:00 GMT" }),
  }, { nowMs }), 600_000);
  assert.equal(onlineSyncRetryAfterMs(
    new Error("Maozi online-product sync request failed: 请求过于频繁，请在3分钟后重试"),
    { nowMs },
  ), 180_000);
  assert.equal(onlineSyncRetryAfterMs(
    { retryAfterMs: 7 * 24 * 60 * 60 * 1000 },
    { nowMs },
  ), 24 * 60 * 60 * 1000);
  assert.equal(onlineSyncRetryAfterMs(new Error("ordinary network failure"), { nowMs }), null);
});

test("server Retry-After survives a runner restart and blocks sync beyond the local cooldown", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-sync-server-backoff-"));
  let current = new Date("2026-07-15T08:00:00.000Z");
  const state = fakeState({
    delayed: {
      status: "processing",
      data: { store_id: 7, submitted: true, offer_id: "mz-delayed", profit_rate: 45 },
    },
  });
  let syncAttempts = 0;
  const client = clientFor([], {
    syncOnlineShops: async () => {
      syncAttempts += 1;
      if (syncAttempts === 1) {
        const error = new Error("ERP rate limited");
        error.retryAfterMs = 600_000;
        throw error;
      }
      return { msg: "queued" };
    },
    findImportLog: async ({ sku, offerId }) => ({ sku, offer_id: offerId, import_status: "pending" }),
    findOnlineProduct: async () => null,
  });
  const runOnce = () => createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    runDir,
    now: () => current,
    target: 1,
    onlineSyncIntervalMs: 180_000,
    urgentOnlineSyncIntervalMs: 180_000,
    urgentOnlineSyncPendingCount: 1,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  await runOnce();
  assert.equal(syncAttempts, 1);
  const failedSync = JSON.parse((await fs.readFile(path.join(runDir, "store_syncs.jsonl"), "utf8")).trim());
  assert.equal(failedSync.retry_after_ms, 600_000);
  assert.equal(failedSync.blocked_until, "2026-07-15T08:10:00.000Z");

  current = new Date("2026-07-15T08:03:01.000Z");
  await runOnce();
  assert.equal(syncAttempts, 1);

  current = new Date("2026-07-15T08:10:00.000Z");
  await runOnce();
  assert.equal(syncAttempts, 2);
  await fs.rm(runDir, { recursive: true, force: true });
});

test("an outstanding online-sync backlog stays urgent after shrinking below the threshold", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-shrinking-urgent-sync-"));
  const now = () => new Date("2026-07-15T08:06:00.000Z");
  await fs.writeFile(path.join(runDir, "store_syncs.jsonl"), `${JSON.stringify({
    at: "2026-07-15T08:00:00.000Z",
    store_id: 104965,
    kind: "online-products",
    ok: true,
    pending_count: 3,
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
    urgentOnlineSyncPendingCount: 3,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
  }).run();

  assert.deepEqual(syncCalls, [[[104965], "all"]]);
  await fs.rm(runDir, { recursive: true, force: true });
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
  assert.ok(state.transitions.some((event) => event.sku === "5" && event.data.reason === "missing-supported-economy"));
  assert.ok(state.transitions.some((event) => event.sku === "6" && event.data.reason === "cate_fee<=0"));
});

test("runner prunes an impossible profit candidate before spending a 1688 lookup", async () => {
  const state = fakeState();
  let costCalls = 0;
  let profitCalls = 0;
  const client = clientFor([{ id: 61, sku: 61 }], {
    calculateProfit: async (input) => {
      profitCalls += 1;
      assert.equal(input.purchase_price, 0.01);
      return economy(30);
    },
  });
  const result = await createPublishRunner({
    client,
    costBridge: {
      estimate: async () => {
        costCalls += 1;
        return { ok: true, cost: 20 };
      },
    },
    state,
    target: 1,
    threshold: 30,
    runDir: "/tmp/run",
  }).run();

  assert.equal(result.published, 0);
  assert.equal(profitCalls, 1);
  assert.equal(costCalls, 0);
  assert.ok(state.transitions.some((event) => event.sku === "61"
    && event.status === "skipped"
    && event.data.reason === "profit-upper-bound<=30"
    && event.data.profit_upper_bound.profit_rate === 30));
});

test("runner falls back to the exact profit path when the optimistic precheck fails", async () => {
  const state = fakeState();
  let costCalls = 0;
  let profitCalls = 0;
  const client = clientFor([{ id: 62, sku: 62 }], {
    calculateProfit: async () => {
      profitCalls += 1;
      if (profitCalls === 1) throw new Error("temporary precheck outage");
      return economy(45);
    },
  });
  const result = await createPublishRunner({
    client,
    costBridge: {
      estimate: async () => {
        costCalls += 1;
        return { ok: true, cost: 20 };
      },
    },
    state,
    target: 1,
    threshold: 30,
    runDir: "/tmp/run",
  }).run();

  assert.equal(result.published, 1);
  assert.equal(profitCalls, 2);
  assert.equal(costCalls, 1);
});

test("runner terminally skips a deterministic missing-logistics profit error instead of retrying it every round", async () => {
  const state = fakeState();
  let profitCalls = 0;
  let costCalls = 0;
  let favoriteDeletes = 0;
  const client = clientFor([{ id: 63, sku: 63 }], {
    calculateProfit: async () => {
      profitCalls += 1;
      throw new Error("Maozi profit calculation request failed: 根据当前售价、重量和尺寸，暂时没有符合的物流方式");
    },
    deleteFavorite: async () => { favoriteDeletes += 1; return true; },
    findImportLog: async () => null,
  });
  const runner = createPublishRunner({
    client,
    costBridge: {
      estimate: async () => {
        costCalls += 1;
        return { ok: true, cost: 20 };
      },
    },
    state,
    target: 1,
    threshold: 30,
    runDir: "/tmp/run",
  });

  await runner.run();
  await runner.run();

  assert.equal(profitCalls, 2);
  assert.equal(costCalls, 1);
  assert.equal(favoriteDeletes, 2);
  assert.ok(state.transitions.some((event) => event.sku === "63"
    && event.status === "skipped"
    && event.data.reason === "missing-shipping-mode"));
});

test("runner builds the exact one-row payload and stops at target", async () => {
  const state = fakeState();
  const payloads = [];
  let calculatedCate;
  const items = [{ id: 71, sku: 700001, title: "source title", cover_image: "cover.jpg", link: "https://www.ozon.ru/product/700001" }, { id: 72, sku: 700002 }];
  const client = clientFor(items, {
    getCategoryBySku: async () => ({ cate: [11, 22, 999], product_info: { weight: 100 } }),
    listCategoryCommissions: async () => [{
      cate_id: 11,
      label: "Игрушки",
      children: [{
        cate_id: 22,
        label: "Настольные игры",
        children: [{ label: "售价 ≤ 1500₽", value: "1,12.00" }],
      }],
    }],
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
      cover_image: "https://img.example/safe.jpg",
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
  const deleted = [];
  const client = clientFor([{ id: 1, sku: 1 }, { id: 2, sku: 2 }], {
    deleteFavorite: async (item) => { deleted.push(String(item.sku)); return true; },
  });
  const first = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state: historicalState,
    target: 1,
  }).run();
  assert.equal(first.published, 1);
  assert.equal(historicalState.records[0].sku, "2");
  assert.deepEqual(deleted, ["1"]);

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

test("each publish round frees a bounded batch of already imported favorites", async () => {
  const deleted = [];
  const client = clientFor([{ id: 2, sku: 2 }], {
    listAllFavorites: async () => [
      { id: 101, sku: 101, is_imported: 1 },
      { id: 102, sku: 102, is_imported: true },
      { id: 103, sku: 103, is_imported: 1 },
      { id: 104, sku: 104, is_imported: 0 },
    ],
    deleteFavorite: async (item) => { deleted.push(String(item.sku)); return true; },
  });
  const state = fakeState();
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
    importedFavoriteCleanupLimit: 2,
  }).run();

  assert.equal(result.published, 1);
  assert.deepEqual(deleted, ["101", "102"]);
});

test("resumed skipped candidates are terminal and are not recalculated", async () => {
  const state = fakeState({ 20: "skipped" });
  let detailCalls = 0;
  const deleted = [];
  const client = clientFor([{ id: 20, sku: 20 }, { id: 21, sku: 21 }], {
    deleteFavorite: async (item) => { deleted.push(String(item.sku)); return true; },
    getProductDetail: async (sku) => {
      detailCalls += 1;
      return {
        sku,
        mode: "FBS",
        title: "safe",
        cover_image: "https://img.example/safe.jpg",
        current_price: 100,
        follow_min: 90,
      };
    },
  });
  const result = await createPublishRunner({
    client,
    costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
    state,
    target: 1,
  }).run();

  assert.equal(result.published, 1);
  assert.equal(detailCalls, 2);
  assert.equal(state.records[0].sku, "21");
  assert.ok(deleted.includes("20"));
});

test("rolling workers start the next candidate before an unrelated slow candidate settles", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-rolling-workers-"));
  try {
    let releaseSlow;
    let signalRefill;
    let slowSettled = false;
    const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
    const refillStarted = new Promise((resolve) => { signalRefill = resolve; });
    const starts = [];
    const items = [
      {
        sku: "rolling-slow",
        title: "Безопасный товар slow",
        cover_image: "https://img.example/rolling-slow.jpg",
        sell_price: 100,
      },
      {
        sku: "rolling-fast",
        title: "Безопасный товар fast",
        cover_image: "https://img.example/rolling-fast.jpg",
        sell_price: 100,
      },
      {
        sku: "rolling-refill",
        title: "Безопасный товар refill",
        cover_image: "https://img.example/rolling-refill.jpg",
        sell_price: 100,
      },
    ];
    const running = createPublishRunner({
      client: clientFor(items),
      costBridge: {
        estimate: async (input) => {
          starts.push(input.sku);
          if (input.sku === "rolling-slow") {
            await slowGate;
            slowSettled = true;
          }
          if (input.sku === "rolling-refill") signalRefill();
          return { ok: false, reason: "no reliable same-item match" };
        },
      },
      state: fakeState(),
      target: 10,
      runDir,
      directMode: true,
      concurrency: 2,
    }).run();

    await Promise.race([
      refillStarted,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("rolling worker did not refill before timeout")),
        500,
      )),
    ]);
    assert.equal(slowSettled, false);
    assert.deepEqual(starts.slice(0, 3), [
      "rolling-slow",
      "rolling-fast",
      "rolling-refill",
    ]);
    releaseSlow();
    await running;
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct rolling queue does not grow beyond its configured worker count", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-fixed-direct-workers-"));
  try {
    const items = Array.from({ length: 13 }, (_, index) => ({
      sku: `fixed-worker-${index + 1}`,
      title: `Безопасный товар fixed worker ${index + 1}`,
      cover_image: `https://img.example/fixed-worker-${index + 1}.jpg`,
      sell_price: 100,
    }));
    const result = await createPublishRunner({
      client: clientFor(items),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state: fakeState(),
      target: items.length,
      runDir,
      directMode: true,
      concurrency: 2,
      maxConcurrency: 12,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.equal(result.accepted, items.length);
    assert.equal(result.final_concurrency, 2);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("an external fatal stop cancels an in-flight direct candidate before ERP publish", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-external-fatal-stop-"));
  try {
    let releaseCost;
    let signalCostStarted;
    const costGate = new Promise((resolve) => { releaseCost = resolve; });
    const costStarted = new Promise((resolve) => { signalCostStarted = resolve; });
    const directRunControl = { cancelled: false, fatalError: null };
    let detailCalls = 0;
    let publishCalls = 0;
    const running = createPublishRunner({
      client: clientFor([{
        sku: "external-fatal-in-flight",
        title: "Безопасный товар при внешней остановке",
        cover_image: "https://img.example/external-fatal.jpg",
        sell_price: 100,
      }], {
        getProductDetail: async () => {
          detailCalls += 1;
          return { current_price: 100, follow_min: 90 };
        },
        publish: async () => {
          publishCalls += 1;
          return { ok: true };
        },
      }),
      costBridge: {
        estimate: async () => {
          signalCostStarted();
          await costGate;
          return { ...RELIABLE_COST_RESULT };
        },
      },
      state: fakeState(),
      target: 1,
      runDir,
      directMode: true,
      directRunControl,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    await costStarted;
    const fatal = new Error("Ozon access stopped after CAPTCHA");
    fatal.code = "FLOW_B_OZON_ACCESS_STOPPED";
    directRunControl.cancelled = true;
    directRunControl.fatalError = fatal;
    releaseCost();
    await assert.rejects(running, /CAPTCHA/);
    assert.equal(detailCalls, 0);
    assert.equal(publishCalls, 0);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("Maozi authentication loss is fatal and cancels queued direct ERP requests", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-maozi-auth-fatal-"));
  try {
    let publishCalls = 0;
    const items = [
      {
        sku: "maozi-auth-first",
        title: "Безопасный товар авторизация один",
        cover_image: "https://img.example/maozi-auth-first.jpg",
        sell_price: 100,
      },
      {
        sku: "maozi-auth-queued",
        title: "Безопасный товар авторизация два",
        cover_image: "https://img.example/maozi-auth-second.jpg",
        sell_price: 100,
      },
    ];
    const running = createPublishRunner({
      client: clientFor(items, {
        publish: async () => {
          publishCalls += 1;
          return {
            ok: false,
            status: 401,
            response: { message: "Unauthenticated" },
          };
        },
      }),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state: fakeState(),
      target: 2,
      runDir,
      directMode: true,
      concurrency: 2,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    await assert.rejects(running, /authentication|Unauthenticated|401/i);
    assert.equal(publishCalls, 1);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct mode treats category and profit ERP authentication loss as fatal", async (t) => {
  const item = {
    sku: "maozi-auth-stage",
    title: "Безопасный товар авторизация этап",
    cover_image: "https://img.example/maozi-auth-stage.jpg",
    sell_price: 100,
  };
  const authenticationError = (stage) => Object.assign(
    new Error(`Maozi ${stage} request failed: Unauthenticated.`),
    { status: 401, response: { msg: "Unauthenticated." } },
  );

  await t.test("category", async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-maozi-category-auth-"));
    try {
      let costCalls = 0;
      let detailCalls = 0;
      let publishCalls = 0;
      const running = createPublishRunner({
        client: clientFor([item], {
          getCategoryBySku: async () => { throw authenticationError("category"); },
          getProductDetail: async () => { detailCalls += 1; return {}; },
          publish: async () => { publishCalls += 1; return { ok: true }; },
        }),
        costBridge: {
          estimate: async () => {
            costCalls += 1;
            return { ...RELIABLE_COST_RESULT };
          },
        },
        state: fakeState(),
        target: 1,
        runDir,
        directMode: true,
        minimumSameItemMatches: 1,
        requireReliableCostContract: true,
      }).run();

      await assert.rejects(running, /Unauthenticated/i);
      assert.equal(costCalls, 0);
      assert.equal(detailCalls, 0);
      assert.equal(publishCalls, 0);
    } finally {
      await fs.rm(runDir, { recursive: true, force: true });
    }
  });

  await t.test("profit", async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-maozi-profit-auth-"));
    try {
      let detailCalls = 0;
      let publishCalls = 0;
      const running = createPublishRunner({
        client: clientFor([item], {
          calculateProfit: async () => { throw authenticationError("profit calculation"); },
          getProductDetail: async (sku) => {
            detailCalls += 1;
            return {
              sku,
              title: item.title,
              cover_image: item.cover_image,
              current_price: 100,
              follow_min: 90,
            };
          },
          publish: async () => { publishCalls += 1; return { ok: true }; },
        }),
        costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
        state: fakeState(),
        target: 1,
        runDir,
        directMode: true,
        minimumSameItemMatches: 1,
        requireReliableCostContract: true,
      }).run();

      await assert.rejects(running, /Unauthenticated/i);
      assert.equal(detailCalls, 1);
      assert.equal(publishCalls, 0);
    } finally {
      await fs.rm(runDir, { recursive: true, force: true });
    }
  });
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
      return {
        sku,
        mode: "FBS",
        title: "safe",
        cover_image: "https://img.example/safe.jpg",
        current_price: 100,
        follow_min: 90,
      };
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

test("SQLite submission intent is authoritative over the idempotent selected audit", async (t) => {
  await t.test("recordSelected false still proceeds after a fresh CAS reservation", async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-selected-cas-"));
    try {
      const state = fakeState();
      state.recordSelected = async () => false;
      let publishCalls = 0;
      const result = await createPublishRunner({
        client: clientFor([{ sku: "selected-cas" }], {
          publish: async () => {
            publishCalls += 1;
            return { ok: true };
          },
        }),
        costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
        state,
        target: 1,
        runDir,
      }).run();

      assert.equal(publishCalls, 1);
      assert.equal(result.published, 1);
      assert.ok(state.transitions.some((event) => event.data?.submitted === true));
    } finally {
      await fs.rm(runDir, { recursive: true, force: true });
    }
  });

  await t.test("submission intent transition false", async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-intent-cas-"));
    try {
      const state = fakeState();
      const transition = state.transition;
      state.transition = async (sku, status, data) => {
        if (data?.submission_intent === true) return false;
        return transition(sku, status, data);
      };
      let publishCalls = 0;
      const result = await createPublishRunner({
        client: clientFor([{ sku: "intent-cas" }], {
          publish: async () => {
            publishCalls += 1;
            return { ok: true };
          },
        }),
        costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
        state,
        target: 1,
        runDir,
      }).run();

      assert.equal(state.selections.length, 1);
      assert.equal(publishCalls, 0);
      assert.equal(result.published, 0);
    } finally {
      await fs.rm(runDir, { recursive: true, force: true });
    }
  });
});

test("fresh runner intent, accepted marker, and strict publication complete through SQLite state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-runner-sqlite-"));
  const runDir = path.join(root, "run");
  const state = createPublishState({
    runDir,
    publishedCsv: path.join(root, "published.csv"),
    runtimeStateDbPath: path.join(root, "runtime", "state.sqlite"),
  });
  try {
    let publishCalls = 0;
    const result = await createPublishRunner({
      client: clientFor([{ sku: "sqlite-fresh" }], {
        publish: async () => {
          publishCalls += 1;
          return { ok: true, response: { code: 1 } };
        },
      }),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 1,
      runDir,
      requireReliableCostContract: true,
      confirmationAttempts: 1,
      confirmationIntervalMs: 0,
    }).run();

    assert.equal(publishCalls, 1);
    assert.equal(result.published, 1);
    const published = state.entryOf("sqlite-fresh");
    assert.equal(published.status, "published");
    assert.equal(published.data.submission_intent, false);
    assert.equal(published.data.submitted, true);
    assert.equal(published.data.quality_gate_passed, true);
  } finally {
    await state.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ERP acceptance is durable before capacity, sync, or confirmation work", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-accepted-order-"));
  try {
    const state = fakeState();
    const transition = state.transition;
    let acceptedPersisted = false;
    state.transition = async (sku, status, data) => {
      const recorded = await transition(sku, status, data);
      if (recorded !== false && data?.submitted === true) acceptedPersisted = true;
      return recorded;
    };
    let confirmationChecks = 0;
    let syncChecks = 0;
    const client = clientFor([{ sku: "accepted-order" }], {
      publish: async () => {
        assert.equal(acceptedPersisted, false);
        return { ok: true, response: { code: 1 } };
      },
      syncOnlineShops: async () => {
        syncChecks += 1;
        assert.equal(acceptedPersisted, true);
        return { ok: true };
      },
      findImportLog: async ({ sku, offerId }) => {
        confirmationChecks += 1;
        assert.equal(acceptedPersisted, true);
        return { sku, offer_id: offerId, import_status: "all_imported" };
      },
    });

    const result = await createPublishRunner({
      client,
      costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
      state,
      target: 1,
      runDir,
      onlineSyncIntervalMs: 0,
      confirmationAttempts: 1,
      confirmationIntervalMs: 0,
    }).run();

    assert.equal(result.published, 1);
    assert.equal(confirmationChecks, 1);
    assert.equal(syncChecks, 1);
    const accepted = state.transitions.find((event) => event.data?.submitted === true);
    assert.equal(accepted.data.submission_intent, false);
    assert.equal(accepted.data.submission_pending, false);
    assert.ok(accepted.data.submitted_at);
    assert.equal(result.store_submitted_usage["7"], 1);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct mode counts ERP acceptance and does not wait for import or online confirmation", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-accepted-"));
  try {
    const state = fakeState();
    let confirmationChecks = 0;
    let publishCalls = 0;
    const client = clientFor([
      {
        sku: "direct-fbo-apparel",
        title: "Одежда для дома",
        cover_image: "https://img.example/direct.jpg",
        sell_price: 100,
      },
    ], {
      resolvePublishTarget: async () => ({
        store: {
          id: 7,
          name: "丽丽1号",
          product_limit: { daily_create: { usage: 100, limit: 100 } },
        },
        watermark: { id: 8, name: "lysh" },
      }),
      getProductDetail: async (sku) => ({
        sku,
        mode: "FBO",
        title: "Одежда для дома",
        cover_image: "https://img.example/direct.jpg",
        current_price: 100,
        follow_min: 90,
      }),
      publish: async () => {
        publishCalls += 1;
        return { ok: true, response: { code: 1 } };
      },
      findImportLog: async () => {
        confirmationChecks += 1;
        throw new Error("direct submission must not wait for import logs");
      },
      findOnlineProduct: async () => {
        confirmationChecks += 1;
        throw new Error("direct submission must not wait for online products");
      },
    });
    const result = await createPublishRunner({
      client,
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 1,
      runDir,
      directMode: true,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.equal(publishCalls, 1);
    assert.equal(confirmationChecks, 0);
    assert.equal(result.accepted, 1);
    assert.equal(result.remaining, 0);
    assert.equal(state.entryOf("direct-fbo-apparel").data.submitted, true);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct cost rejection skips live Ozon detail, profit, and ERP submission", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-cost-first-"));
  try {
    const state = fakeState();
    let detailCalls = 0;
    let profitCalls = 0;
    let publishCalls = 0;
    const result = await createPublishRunner({
      client: clientFor([{
        sku: "cost-rejected",
        title: "Надёжный снимок товара",
        cover_image: "https://img.example/cost-rejected.jpg",
        sell_price: 120,
        source_url: "https://www.ozon.ru/seller/cost-first/",
      }], {
        getProductDetail: async () => {
          detailCalls += 1;
          return {};
        },
        calculateProfit: async () => {
          profitCalls += 1;
          return economy(45);
        },
        publish: async () => {
          publishCalls += 1;
          return { ok: true };
        },
      }),
      costBridge: {
        estimate: async () => ({
          ok: false,
          deferred: true,
          terminal: false,
          reason: "worker timed out after 15000ms",
        }),
      },
      state,
      target: 1,
      runDir,
      directMode: true,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.equal(result.accepted, 0);
    assert.equal(detailCalls, 0);
    assert.equal(profitCalls, 0);
    assert.equal(publishCalls, 0);
    const rejected = state.entryOf("cost-rejected");
    assert.equal(rejected.status, "skipped");
    assert.equal(rejected.data.reason, "1688-timeout");
    assert.equal(rejected.data.outcome_status, "skipped_cost");
    const funnel = (await fs.readFile(path.join(runDir, "direct_funnel.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.deepEqual(funnel.map((row) => row.stage), [
      "candidate_required_fields_passed",
      "snapshot_category_passed",
    ]);
    assert.ok(funnel.every((row) => row.source_url === "https://www.ozon.ru/seller/cost-first/"));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct mode skips a missing economy quote instead of retrying an exception", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-missing-economy-"));
  try {
    const state = fakeState();
    let publishCalls = 0;
    const result = await createPublishRunner({
      client: clientFor([{
        sku: "missing-economy",
        title: "Безопасный товар без тарифа",
        cover_image: "https://img.example/missing-economy.jpg",
        sell_price: 120,
      }], {
        calculateProfit: async ({ purchase_price: purchasePrice }) => (
          Number(purchasePrice) === 0.01 ? economy(45) : { calc_result: [] }
        ),
        publish: async () => {
          publishCalls += 1;
          return { ok: true };
        },
      }),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 1,
      runDir,
      directMode: true,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.equal(result.accepted, 0);
    assert.equal(publishCalls, 0);
    const skipped = state.entryOf("missing-economy");
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.data.reason, "missing-supported-economy");
    assert.equal(skipped.data.outcome_status, "skipped_profit");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("a hung cost lookup times out without pinning the rolling publish queue", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-cost-watchdog-"));
  try {
    const state = fakeState();
    let detailCalls = 0;
    let publishCalls = 0;
    const started = Date.now();
    const result = await createPublishRunner({
      client: clientFor([
        {
          sku: "hung-cost-stage",
          title: "Безопасный зависший товар",
          cover_image: "https://img.example/hung-cost-stage.jpg",
          sell_price: 100,
        },
        {
          sku: "next-after-timeout",
          title: "Безопасный следующий товар",
          cover_image: "https://img.example/next-after-timeout.jpg",
          sell_price: 100,
        },
      ], {
        getProductDetail: async (sku) => {
          detailCalls += 1;
          return { sku, current_price: 100, follow_min: 90 };
        },
        publish: async () => {
          publishCalls += 1;
          return { ok: true, response: { code: 1 } };
        },
      }),
      costBridge: {
        estimate: async ({ sku }) => (
          sku === "hung-cost-stage"
            ? new Promise(() => {})
            : { ...RELIABLE_COST_RESULT }
        ),
      },
      state,
      target: 1,
      runDir,
      directMode: true,
      concurrency: 1,
      costEstimateTimeoutMs: 30,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.equal(result.accepted, 1);
    assert.equal(state.entryOf("hung-cost-stage").data.reason, "1688-timeout");
    assert.equal(state.entryOf("hung-cost-stage").data.outcome_status, "skipped_cost");
    assert.equal(detailCalls, 1);
    assert.equal(publishCalls, 1);
    assert.ok(Date.now() - started < 500);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct mode fetches one live detail after cost and remaps commission using the lower live price", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-live-price-"));
  try {
    const events = [];
    const profitInputs = [];
    let detailCalls = 0;
    const sourceUrl = "https://www.ozon.ru/seller/live-price/";
    const client = clientFor([{
      sku: "live-price-remap",
      title: "Игровой безопасный аксессуар",
      cover_image: "https://img.example/live-price.jpg",
      sell_price: 200,
      source_url: sourceUrl,
    }], {
      getCategoryBySku: async () => {
        events.push("category");
        return {
          cate: [11, 22, "high"],
          product_info: { weight: 100, depth: 20, width: 10, height: 5 },
        };
      },
      listCategoryCommissions: async () => [{
        cate_id: 11,
        label: "Игрушки",
        children: [{
          cate_id: 22,
          label: "Настольные игры",
          children: [
            { label: "售价 ≤ 1000₽", value: "low" },
            { label: "售价 > 1000₽", value: "high" },
          ],
        }],
      }],
      getProductDetail: async (sku) => {
        events.push("detail");
        detailCalls += 1;
        return {
          sku,
          mode: "FBO",
          current_price: 100,
          follow_min: 90,
        };
      },
      calculateProfit: async (input) => {
        events.push("profit");
        profitInputs.push(input);
        return economy(30.01);
      },
      publish: async () => {
        events.push("publish");
        return { ok: true, response: { code: 1 } };
      },
    });
    const result = await createPublishRunner({
      client,
      costBridge: {
        estimate: async (input) => {
          events.push("cost");
          assert.equal(input.sell_price, 200);
          return { ...RELIABLE_COST_RESULT };
        },
      },
      state: fakeState(),
      target: 1,
      threshold: 30,
      runDir,
      directMode: true,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.equal(result.accepted, 1);
    assert.equal(detailCalls, 1);
    assert.deepEqual(events, ["category", "cost", "detail", "profit", "publish"]);
    assert.equal(profitInputs.length, 1);
    assert.equal(profitInputs[0].sell_price, 90);
    assert.deepEqual(profitInputs[0].cate, [11, 22, "low"]);
    const funnel = (await fs.readFile(path.join(runDir, "direct_funnel.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.ok(funnel.some((row) => row.stage === "snapshot_category_passed"));
    assert.ok(funnel.some((row) => row.stage === "live_price_confirmed"
      && row.sale_price === 90
      && row.current_price === 100
      && row.follow_min === 90));
    assert.ok(funnel.every((row) => row.source_url === sourceUrl));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct mode uses the weight-selected warehouse and matching profit provider", async (t) => {
  for (const expected of [
    { weight: 500, logistics: "CEL", warehouseId: 101, route: "postal" },
    { weight: 501, logistics: "Ural", warehouseId: 202, route: "ural" },
  ]) {
    await t.test(`${expected.weight}g`, async () => {
      const runDir = await fs.mkdtemp(path.join(os.tmpdir(), `flow-b-weight-route-${expected.weight}-`));
      try {
        const state = fakeState();
        const profitInputs = [];
        const client = clientFor([{
          sku: `weight-${expected.weight}`,
          title: `Безопасный товар ${expected.weight}`,
          cover_image: `https://img.example/${expected.weight}.jpg`,
          sell_price: 100,
        }], {
          getCategoryBySku: async () => ({
            cate: [11, 22, "1,12.00"],
            product_info: { weight: expected.weight, depth: 20, width: 10, height: 5 },
          }),
          calculateProfit: async (input) => {
            profitInputs.push(input);
            return {
              calc_result: [{
                name: expected.logistics,
                speed: "economy",
                title: `${expected.logistics} Economy Small`,
                price_list: {
                  logistics_name: expected.logistics,
                  logistics_speed: "economy",
                  purchase_price: 20,
                  sell_price: 90,
                  cate_rate: 12,
                  cate_fee: 8,
                  profit_rate: 40,
                },
              }],
            };
          },
        });
        const result = await createPublishRunner({
          client,
          costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
          state,
          target: 1,
          runDir,
          directMode: true,
          minimumSameItemMatches: 1,
          requireReliableCostContract: true,
          storeTargets: [{
            id: 7,
            needle: "丽丽1号",
            warehouseId: 101,
            uralWarehouseId: 202,
            weightThresholdGrams: 500,
            weightRouting: true,
            requireWarehouse: true,
          }],
        }).run();

        assert.equal(result.accepted, 1);
        assert.equal(profitInputs.length, 1);
        assert.equal(profitInputs[0].logistics, expected.logistics);
        assert.equal(state.selections[0].warehouse_id, expected.warehouseId);
        assert.equal(state.selections[0].shipping_route, expected.route);
        assert.equal(state.selections[0].package_weight_grams, expected.weight);
      } finally {
        await fs.rm(runDir, { recursive: true, force: true });
      }
    });
  }
});

test("direct mode does not accept a snapshot fallback as a confirmed live Ozon price", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-live-price-required-"));
  try {
    let profitCalls = 0;
    let publishCalls = 0;
    const state = fakeState();
    const result = await createPublishRunner({
      client: clientFor([{
        sku: "snapshot-price-only",
        title: "Безопасный товар только со снимком",
        cover_image: "https://img.example/snapshot-price-only.jpg",
        sell_price: 100,
      }], {
        getProductDetail: async () => ({
          current_price: null,
          follow_min: null,
          selected_price: 80,
          fallback_price: 80,
        }),
        calculateProfit: async () => {
          profitCalls += 1;
          return economy(45);
        },
        publish: async () => {
          publishCalls += 1;
          return { ok: true };
        },
      }),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 1,
      runDir,
      directMode: true,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.equal(result.accepted, 0);
    assert.equal(profitCalls, 0);
    assert.equal(publishCalls, 0);
    assert.equal(state.entryOf("snapshot-price-only").data.reason, "missing-live-sale-price");
    assert.equal(state.entryOf("snapshot-price-only").data.outcome_status, "skipped_profit");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct mode can use a fresh converted CNY favorite when the exact live page omits price", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-fresh-snapshot-price-"));
  try {
    const state = fakeState();
    const profitInputs = [];
    const result = await createPublishRunner({
      client: clientFor([{
        sku: "fresh-cny-snapshot-price",
        title: "Безопасный товар со свежей ценой",
        cover_image: "https://img.example/fresh-cny-snapshot-price.jpg",
        sell_price: 119.48,
        sale_price: 119.48,
        source_currency: "CNY",
        create_time: "2026-08-09 20:35:10",
        update_time: "2026-08-09 20:35:10",
      }], {
        getProductDetail: async () => ({ current_price: null, follow_min: null }),
        calculateProfit: async (input) => {
          profitInputs.push(input);
          return economy(45);
        },
        publish: async () => ({ ok: true, response: { code: 1 } }),
      }),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 1,
      runDir,
      directMode: true,
      now: () => new Date("2026-08-09T12:45:00.000Z"),
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.equal(result.accepted, 1);
    assert.equal(profitInputs[0].sell_price, 119.48);
    const funnel = (await fs.readFile(path.join(runDir, "direct_funnel.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.ok(funnel.some((row) => row.stage === "fresh_snapshot_price_fallback"
      && row.sale_price === 119.48
      && row.snapshot_observed_at === "2026-08-09 20:35:10"));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct mode converts live ruble prices only from an observed page exchange rate", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-live-rub-price-"));
  try {
    const profitInputs = [];
    const client = clientFor([{
      sku: "live-rub-price",
      title: "Безопасный товар с живой ценой",
      cover_image: "https://img.example/live-rub-price.jpg",
      sell_price: 150,
    }], {
      getProductDetail: async () => ({
        current_price: null,
        current_price_rub: 1_200,
        follow_min: 90,
        follow_min_rub: 900,
        observed_cny_rub_rate: 10,
      }),
      calculateProfit: async (input) => {
        profitInputs.push(input);
        return economy(30.01);
      },
      publish: async () => ({ ok: true, response: { code: 1 } }),
    });
    const result = await createPublishRunner({
      client,
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state: fakeState(),
      target: 1,
      runDir,
      directMode: true,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.equal(result.accepted, 1);
    assert.equal(profitInputs.length, 1);
    assert.equal(profitInputs[0].sell_price, 90);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct mode does not convert a ruble-only live price from the stale default rate", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-unrated-rub-price-"));
  try {
    let profitCalls = 0;
    let publishCalls = 0;
    const state = fakeState();
    const result = await createPublishRunner({
      client: clientFor([{
        sku: "unrated-rub-price",
        title: "Безопасный товар без курса",
        cover_image: "https://img.example/unrated-rub-price.jpg",
        sell_price: 100,
      }], {
        getProductDetail: async () => ({
          current_price: null,
          current_price_rub: 1_000,
          follow_min: null,
          follow_min_rub: null,
          observed_cny_rub_rate: null,
        }),
        calculateProfit: async () => {
          profitCalls += 1;
          return economy(45);
        },
        publish: async () => {
          publishCalls += 1;
          return { ok: true };
        },
      }),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 1,
      runDir,
      directMode: true,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.equal(result.accepted, 0);
    assert.equal(profitCalls, 0);
    assert.equal(publishCalls, 0);
    assert.equal(state.entryOf("unrated-rub-price").data.reason, "missing-live-sale-price");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct mode never lets an implausible page or ERP rate contaminate the next ruble-only SKU", async (t) => {
  for (const scenario of [
    { name: "page rate", observedRate: 0.085, calculatedRate: null },
    { name: "ERP rate", observedRate: null, calculatedRate: 0.085 },
  ]) {
    await t.test(scenario.name, async () => {
      const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-invalid-rub-rate-"));
      try {
        let profitCalls = 0;
        let publishCalls = 0;
        const state = fakeState();
        const result = await createPublishRunner({
          client: clientFor([
            {
              sku: `rate-seed-${scenario.name}`,
              title: "Безопасный товар с ценой в юанях",
              cover_image: "https://img.example/rate-seed.jpg",
              sell_price: 100,
            },
            {
              sku: `rub-only-after-${scenario.name}`,
              title: "Безопасный товар только с рублевой ценой",
              cover_image: "https://img.example/rub-only.jpg",
              sell_price: 100,
            },
          ], {
            getProductDetail: async (sku) => String(sku).startsWith("rate-seed-")
              ? {
                current_price: 100,
                follow_min: null,
                observed_cny_rub_rate: scenario.observedRate,
              }
              : {
                current_price: null,
                current_price_rub: 1_000,
                follow_min: null,
                follow_min_rub: null,
                observed_cny_rub_rate: null,
              },
            calculateProfit: async () => {
              profitCalls += 1;
              return {
                ...economy(45),
                cnyrub_rate: scenario.calculatedRate,
              };
            },
            publish: async () => {
              publishCalls += 1;
              return { ok: true, response: { code: 1 } };
            },
          }),
          costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
          state,
          target: 2,
          runDir,
          directMode: true,
          concurrency: 1,
          minimumSameItemMatches: 1,
          requireReliableCostContract: true,
        }).run();

        assert.equal(result.accepted, 1);
        assert.equal(profitCalls, 1);
        assert.equal(publishCalls, 1);
        assert.equal(
          state.entryOf(`rub-only-after-${scenario.name}`).data.reason,
          "missing-live-sale-price",
        );
      } finally {
        await fs.rm(runDir, { recursive: true, force: true });
      }
    });
  }
});

test("direct mode rejects 30 percent and accepts 30.01 percent", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-profit-boundary-"));
  try {
    const state = fakeState();
    const publishedSkus = [];
    const client = clientFor([
      { sku: "profit-30", title: "Товар ровно тридцать", cover_image: "https://img.example/30.jpg", sell_price: 100 },
      { sku: "profit-30-01", title: "Товар выше тридцати", cover_image: "https://img.example/3001.jpg", sell_price: 100 },
    ], {
      getProductDetail: async (sku) => ({
        sku,
        mode: "FBO",
        title: sku === "profit-30" ? "Товар ровно тридцать" : "Товар выше тридцати",
        cover_image: `https://img.example/${sku}.jpg`,
        current_price: 100,
        follow_min: 90,
      }),
      calculateProfit: async ({ sku }) => economy(sku === "profit-30" ? 30 : 30.01),
      publish: async (payload) => {
        publishedSkus.push(payload.rows[0].sku);
        return { ok: true, response: { code: 1 } };
      },
    });
    const result = await createPublishRunner({
      client,
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 1,
      threshold: 30,
      runDir,
      directMode: true,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.deepEqual(publishedSkus, ["profit-30-01"]);
    assert.equal(result.accepted, 1);
    assert.equal(state.entryOf("profit-30").data.outcome_status, "skipped_profit");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct mode keeps an unknown prior API request in reconciliation without resubmitting", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-unknown-submit-"));
  try {
    const offerId = "mz-unknown-direct";
    const state = fakeState({
      "unknown-direct": {
        status: "processing",
        data: {
          sku: "unknown-direct",
          submission_intent: true,
          submitted: false,
          submission_pending: false,
          api_call_started_at: "2026-07-30T04:00:00.000Z",
          api_call_attempts_total: 1,
          api_call_attempts_day: 1,
          api_call_day: "2026-07-30",
          offer_id: offerId,
          store_id: 7,
          submission_payload: {
            rows: [{ sku: "unknown-direct", offer_id: offerId }],
          },
        },
      },
    });
    let publishCalls = 0;
    const result = await createPublishRunner({
      client: clientFor([{ sku: "unknown-direct" }], {
        findImportLog: async () => null,
        findOnlineProduct: async () => null,
        publish: async () => {
          publishCalls += 1;
          return { ok: true };
        },
      }),
      costBridge: {
        estimate: async () => {
          throw new Error("unknown submission must not repeat sourcing");
        },
      },
      state,
      target: 1,
      runDir,
      directMode: true,
      reconciliationOnly: true,
      confirmationAttempts: 1,
      confirmationIntervalMs: 0,
    }).run();

    assert.equal(result.accepted, 0);
    assert.equal(publishCalls, 0);
    const unknown = state.entryOf("unknown-direct");
    assert.equal(unknown.status, "processing");
    assert.equal(unknown.data.reason, "submission-api-status-unknown");
    assert.equal(unknown.data.submission_intent, true);
    assert.equal(unknown.data.reconcile_only, true);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct mode turns an unconfirmed ERP response into reconciliation-only state", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-new-unknown-"));
  try {
    const favorite = {
      sku: "new-unknown-direct",
      title: "Безопасный неизвестный ответ",
      cover_image: "https://img.example/new-unknown-direct.jpg",
      sell_price: 100,
    };
    const state = fakeState();
    let publishCalls = 0;
    const client = clientFor([favorite], {
      publish: async () => {
        publishCalls += 1;
        return { ok: false, reason: "gateway response was not confirmed" };
      },
      findImportLog: async () => null,
      findOnlineProduct: async () => null,
    });
    await createPublishRunner({
      client,
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 1,
      runDir,
      directMode: true,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.equal(publishCalls, 1);
    const uncertain = state.entryOf(favorite.sku);
    assert.equal(uncertain.status, "processing");
    assert.equal(uncertain.data.reason, "submission-api-status-unknown");
    assert.equal(uncertain.data.submission_intent, true);
    assert.equal(uncertain.data.reconcile_only, true);

    await createPublishRunner({
      client,
      costBridge: {
        estimate: async () => {
          throw new Error("uncertain request must not repeat sourcing");
        },
      },
      state,
      target: 1,
      runDir,
      directMode: true,
      reconciliationOnly: true,
      confirmationAttempts: 1,
      confirmationIntervalMs: 0,
    }).run();
    assert.equal(publishCalls, 1);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct store-limit cancellation leaves queued ERP work durably retryable", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-store-retry-"));
  try {
    const state = fakeState();
    let publishCalls = 0;
    const client = clientFor([
      {
        sku: "store-limit-first",
        title: "Первый безопасный товар",
        cover_image: "https://img.example/store-limit-first.jpg",
        sell_price: 100,
      },
      {
        sku: "store-limit-queued",
        title: "Второй безопасный товар",
        cover_image: "https://img.example/store-limit-queued.jpg",
        sell_price: 100,
      },
    ], {
      resolvePublishTarget: async ({ storeId }) => ({
        store: { id: Number(storeId), name: `store-${storeId}` },
        watermark: { id: 8, name: "lysh" },
      }),
      publish: async () => {
        publishCalls += 1;
        return {
          ok: false,
          response: { message: "вы исчерпали суточный лимит магазина" },
        };
      },
    });
    const result = await createPublishRunner({
      client,
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 10,
      runDir,
      directMode: true,
      concurrency: 2,
      storeTargets: [
        { id: 7, needle: "store-7", requireWarehouse: false },
        { id: 9, needle: "store-9", requireWarehouse: false },
      ],
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.equal(result.accepted, 0);
    assert.equal(publishCalls, 1);
    for (const sku of ["store-limit-first", "store-limit-queued"]) {
      const retryable = state.entryOf(sku);
      assert.equal(retryable.status, "failed");
      assert.equal(retryable.data.reason, "submission-not-sent-deferred");
      assert.equal(retryable.data.original_reason, "daily-product-limit");
      assert.equal(retryable.data.submission_intent, false);
      assert.equal(retryable.data.terminal, false);
      assert.ok(retryable.data.retry_at);
    }
    assert.ok(result.store_switches.some((row) => (
      row.from_store_id === 7
      && row.to_store_id === 9
      && row.reason === "daily-product-limit"
    )));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("a publish response after midnight keeps the store rejection on the request day", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-midnight-response-"));
  try {
    // Start one second before the configured 20:00 Shanghai cutoff. The mocked
    // ERP response is deliberately delayed across local midnight.
    let currentTime = new Date("2026-07-31T11:59:59.000Z");
    const directRunControl = {
      cancelled: false,
      fatalError: null,
      rejectedStoreIds: new Set(),
      rejectionReasons: new Map(),
    };
    const state = fakeState();
    const client = clientFor([{
      sku: "midnight-store-limit",
      title: "Безопасный товар на границе суток",
      cover_image: "https://img.example/midnight-store-limit.jpg",
      sell_price: 100,
    }], {
      resolvePublishTarget: async ({ storeId }) => ({
        store: { id: Number(storeId), name: `store-${storeId}` },
        watermark: { id: 8, name: "lysh" },
      }),
      publish: async () => {
        currentTime = new Date("2026-07-31T16:00:01.000Z");
        directRunControl.storeUsageDay = "2026-08-01";
        directRunControl.rejectedStoreIds.clear();
        directRunControl.rejectionReasons.clear();
        return {
          ok: false,
          response: { message: "вы исчерпали суточный лимит магазина" },
        };
      },
    });
    await createPublishRunner({
      client,
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 1,
      runDir,
      now: () => new Date(currentTime),
      directMode: true,
      directRunControl,
      concurrency: 1,
      storeTargets: [
        { id: 7, needle: "store-7", requireWarehouse: false },
        { id: 9, needle: "store-9", requireWarehouse: false },
      ],
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    const rejected = state.entryOf("midnight-store-limit");
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.data.store_rejection_day, "2026-07-31");
    assert.equal(directRunControl.rejectedStoreIds.has(7), false);
    const rejectionRows = (await fs.readFile(path.join(runDir, "store_rejections.jsonl"), "utf8"))
      .trim()
      .split(/\n/u)
      .map((line) => JSON.parse(line));
    assert.equal(rejectionRows[0].quota_day, "2026-07-31");

    const restartResult = await createPublishRunner({
      client: clientFor([], {
        resolvePublishTarget: async ({ storeId }) => ({
          store: { id: Number(storeId), name: `store-${storeId}` },
          watermark: { id: 8, name: "lysh" },
        }),
      }),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 1,
      runDir,
      now: () => new Date("2026-07-31T16:00:02.000Z"),
      directMode: true,
      reconciliationOnly: true,
      storeTargets: [
        { id: 7, needle: "store-7", requireWarehouse: false },
        { id: 9, needle: "store-9", requireWarehouse: false },
      ],
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();
    assert.equal(restartResult.active_store_id, 7);
    assert.deepEqual(restartResult.stores_exhausted, {
      rejected_store_ids: [],
      all: false,
    });
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("background daily-limit evidence freezes the foreground ERP queue and rotates stores", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-shared-store-freeze-"));
  let releaseFirstPublish;
  let foregroundRun;
  try {
    const directRunControl = {
      cancelled: false,
      fatalError: null,
      rejectedStoreIds: new Set(),
      rejectionReasons: new Map(),
    };
    const foregroundState = fakeState();
    let firstPublishStarted;
    const firstPublishReady = new Promise((resolve) => { firstPublishStarted = resolve; });
    const firstPublishRelease = new Promise((resolve) => { releaseFirstPublish = resolve; });
    const foregroundPublishStoreIds = [];
    const foreground = createPublishRunner({
      client: clientFor([
        {
          sku: "shared-freeze-inflight",
          title: "Первый безопасный товар общего лимита",
          cover_image: "https://img.example/shared-freeze-inflight.jpg",
          sell_price: 100,
        },
        {
          sku: "shared-freeze-queued",
          title: "Второй безопасный товар общего лимита",
          cover_image: "https://img.example/shared-freeze-queued.jpg",
          sell_price: 100,
        },
      ], {
        resolvePublishTarget: async ({ storeId }) => ({
          store: { id: Number(storeId), name: `store-${storeId}` },
          watermark: { id: 8, name: "lysh" },
        }),
        publish: async (payload) => {
          foregroundPublishStoreIds.push(Number(payload.shop_ids[0]));
          firstPublishStarted();
          await firstPublishRelease;
          return { ok: true, response: { code: 1 } };
        },
      }),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state: foregroundState,
      target: 10,
      runDir,
      directMode: true,
      directRunControl,
      concurrency: 2,
      storeTargets: [
        { id: 7, needle: "store-7", requireWarehouse: false },
        { id: 9, needle: "store-9", requireWarehouse: false },
      ],
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    });
    foregroundRun = foreground.run();
    await firstPublishReady;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (foregroundState.entryOf("shared-freeze-queued")?.data?.api_call_started_at) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.ok(foregroundState.entryOf("shared-freeze-queued")?.data?.api_call_started_at);

    const backgroundState = fakeState({
      "shared-limit-evidence": {
        status: "processing",
        data: {
          sku: "shared-limit-evidence",
          store_id: 7,
          submitted: true,
          reconcile_only: true,
          offer_id: "mz-shared-limit-evidence",
          profit_rate: 40,
          cost_verified: true,
          cost: { ...RELIABLE_COST_RESULT },
          cost_source: RELIABLE_COST_RESULT.source,
          cost_evidence: {
            contract: "1688-same-item-v1",
            source: RELIABLE_COST_RESULT.source,
            reliable_source: true,
            same_item_match: true,
            match_evidence_key: RELIABLE_COST_RESULT.match_evidence_key,
            filtered_price_count: RELIABLE_COST_RESULT.prices.length,
            match_evidence_contract: RELIABLE_COST_RESULT.match_evidence_contract,
            returned_evidence_verified: true,
            matched_offer_count: RELIABLE_COST_RESULT.matched_offer_count,
          },
        },
      },
    });
    const backgroundResult = await createPublishRunner({
      client: clientFor([], {
        resolvePublishTarget: async ({ storeId }) => ({
          store: { id: Number(storeId), name: `store-${storeId}` },
          watermark: { id: 8, name: "lysh" },
        }),
        findImportLog: async ({ sku, offerId }) => ({
          sku,
          offer_id: offerId,
          import_status: "all_failed",
          skus: [{ error_msg: "вы исчерпали суточный лимит магазина" }],
        }),
      }),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state: backgroundState,
      target: 10,
      runDir,
      directMode: true,
      directRunControl,
      reconciliationOnly: true,
      storeTargets: [
        { id: 7, needle: "store-7", requireWarehouse: false },
        { id: 9, needle: "store-9", requireWarehouse: false },
      ],
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
      confirmationAttempts: 1,
      confirmationIntervalMs: 0,
    }).run();

    assert.equal(directRunControl.cancelled, false);
    assert.equal(directRunControl.rejectedStoreIds.has(7), true, JSON.stringify({
      backgroundResult,
      backgroundEntries: backgroundState.entries(),
    }));
    releaseFirstPublish();
    const result = await foregroundRun;

    assert.deepEqual(foregroundPublishStoreIds, [7]);
    assert.equal(result.active_store_id, 9);
    assert.equal(directRunControl.activeStoreId, 9);
    const persistedStore = JSON.parse(
      await fs.readFile(path.join(runDir, "current_store.json"), "utf8"),
    );
    assert.equal(persistedStore.store_id, 9);
    assert.equal(foregroundState.entryOf("shared-freeze-inflight").data.submitted, true);
    const queued = foregroundState.entryOf("shared-freeze-queued");
    assert.equal(queued.status, "failed");
    assert.equal(queued.data.reason, "submission-not-sent-deferred");
    assert.equal(queued.data.original_reason, "daily-product-limit");
    assert.equal(queued.data.api_call_started_at, null);
  } finally {
    releaseFirstPublish?.();
    await foregroundRun?.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    await fs.rm(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  }
});

test("direct mode restores today's rejected store after a process restart", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-rejected-store-restore-"));
  try {
    const state = fakeState({
      "restored-store-limit": {
        status: "failed",
        data: {
          sku: "restored-store-limit",
          store_id: 7,
          reason: "daily-product-limit",
          submitted: true,
          reconciled_at: "2026-07-31T10:00:00.000Z",
        },
      },
    });
    const publishStoreIds = [];
    const result = await createPublishRunner({
      client: clientFor([{
        sku: "after-direct-restart",
        title: "Безопасный товар после перезапуска",
        cover_image: "https://img.example/after-direct-restart.jpg",
        sell_price: 100,
      }], {
        resolvePublishTarget: async ({ storeId }) => ({
          store: { id: Number(storeId), name: `store-${storeId}` },
          watermark: { id: 8, name: "lysh" },
        }),
        publish: async (payload) => {
          publishStoreIds.push(Number(payload.shop_ids[0]));
          return { ok: true, response: { code: 1 } };
        },
      }),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 10,
      runDir,
      now: () => new Date("2026-07-31T11:00:00.000Z"),
      directMode: true,
      storeTargets: [
        { id: 7, needle: "store-7", requireWarehouse: false },
        { id: 9, needle: "store-9", requireWarehouse: false },
      ],
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.deepEqual(publishStoreIds, [9]);
    assert.equal(result.active_store_id, 9);
    assert.deepEqual(result.stores_exhausted, {
      rejected_store_ids: [7],
      all: false,
    });
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct mode clears a rejected-store circuit on the next local day", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-rejected-store-reset-"));
  try {
    const state = fakeState({
      "yesterday-store-limit": {
        status: "failed",
        data: {
          sku: "yesterday-store-limit",
          store_id: 7,
          reason: "daily-product-limit",
          submitted: true,
          reconciled_at: "2026-07-31T10:00:00.000Z",
        },
      },
    });
    const publishStoreIds = [];
    const result = await createPublishRunner({
      client: clientFor([{
        sku: "after-local-day-reset",
        title: "Безопасный товар после сброса лимита",
        cover_image: "https://img.example/after-local-day-reset.jpg",
        sell_price: 100,
      }], {
        resolvePublishTarget: async ({ storeId }) => ({
          store: { id: Number(storeId), name: `store-${storeId}` },
          watermark: { id: 8, name: "lysh" },
        }),
        publish: async (payload) => {
          publishStoreIds.push(Number(payload.shop_ids[0]));
          return { ok: true, response: { code: 1 } };
        },
      }),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 10,
      runDir,
      now: () => new Date("2026-08-01T11:00:00.000Z"),
      directMode: true,
      storeTargets: [
        { id: 7, needle: "store-7", requireWarehouse: false },
        { id: 9, needle: "store-9", requireWarehouse: false },
      ],
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.deepEqual(publishStoreIds, [7]);
    assert.equal(result.active_store_id, 7);
    assert.deepEqual(result.stores_exhausted, {
      rejected_store_ids: [],
      all: false,
    });
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("late prior-day reconciliation does not freeze the new day or overwrite the foreground store", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-prior-day-limit-"));
  try {
    const directRunControl = {
      cancelled: false,
      fatalError: null,
      rejectedStoreIds: new Set(),
      rejectionReasons: new Map(),
    };
    const state = fakeState({
      "prior-day-limit": {
        status: "processing",
        data: {
          sku: "prior-day-limit",
          store_id: 7,
          submitted: true,
          reconcile_only: true,
          offer_id: "mz-prior-day-limit",
          submitted_at: "2026-07-31T15:59:50.000Z",
          api_call_completed_at: "2026-07-31T15:59:50.000Z",
          profit_rate: 40,
          cost_verified: true,
          cost: { ...RELIABLE_COST_RESULT },
          cost_source: RELIABLE_COST_RESULT.source,
          cost_evidence: {
            contract: "1688-same-item-v1",
            source: RELIABLE_COST_RESULT.source,
            reliable_source: true,
            same_item_match: true,
            match_evidence_key: RELIABLE_COST_RESULT.match_evidence_key,
            filtered_price_count: RELIABLE_COST_RESULT.prices.length,
            match_evidence_contract: RELIABLE_COST_RESULT.match_evidence_contract,
            returned_evidence_verified: true,
            matched_offer_count: RELIABLE_COST_RESULT.matched_offer_count,
          },
        },
      },
    });
    const result = await createPublishRunner({
      client: clientFor([], {
        resolvePublishTarget: async ({ storeId }) => ({
          store: { id: Number(storeId), name: `store-${storeId}` },
          watermark: { id: 8, name: "lysh" },
        }),
        findImportLog: async ({ sku, offerId }) => ({
          sku,
          offer_id: offerId,
          import_status: "all_failed",
          skus: [{ error_msg: "вы исчерпали суточный лимит магазина" }],
        }),
      }),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 10,
      runDir,
      now: () => new Date("2026-07-31T16:00:10.000Z"),
      directMode: true,
      directRunControl,
      reconciliationOnly: true,
      storeTargets: [
        { id: 7, needle: "store-7", requireWarehouse: false },
        { id: 9, needle: "store-9", requireWarehouse: false },
      ],
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
      confirmationAttempts: 1,
      confirmationIntervalMs: 0,
    }).run();

    assert.equal(directRunControl.rejectedStoreIds.has(7), false);
    assert.equal(result.active_store_id, 7);
    assert.equal(result.halt_reason, null);
    assert.equal(state.entryOf("prior-day-limit").status, "failed");
    assert.equal(state.entryOf("prior-day-limit").data.store_rejection_day, "2026-07-31");
    await assert.rejects(fs.access(path.join(runDir, "current_store.json")));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct mode stops after every configured store returns a real publish rejection", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-all-stores-rejected-"));
  try {
    const publishStoreIds = [];
    const storeTargets = Array.from({ length: 10 }, (_, index) => ({
      id: 101 + index,
      needle: `store-${101 + index}`,
      requireWarehouse: false,
    }));
    const items = Array.from({ length: 20 }, (_, index) => ({
      sku: `all-stores-rejected-${index}`,
      title: `Безопасный товар для отказа магазина ${index}`,
      cover_image: `https://img.example/all-stores-rejected-${index}.jpg`,
      sell_price: 100,
    }));
    const result = await createPublishRunner({
      client: clientFor(items, {
        resolvePublishTarget: async ({ storeId }) => ({
          store: { id: Number(storeId), name: `store-${storeId}` },
          watermark: { id: 8, name: "lysh" },
        }),
        publish: async (payload) => {
          publishStoreIds.push(Number(payload.shop_ids[0]));
          return {
            ok: false,
            response: { message: "вы исчерпали суточный лимит магазина" },
          };
        },
      }),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state: fakeState(),
      target: 10,
      runDir,
      directMode: true,
      concurrency: 1,
      storeTargets,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.deepEqual(publishStoreIds, storeTargets.map((row) => row.id), JSON.stringify(result));
    assert.equal(result.halt_reason, "daily-product-limit");
    assert.deepEqual(result.stores_exhausted, {
      rejected_store_ids: storeTargets.map((row) => row.id),
      all: true,
    });
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct background reconciliation records online state without changing ERP acceptance count", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-background-"));
  try {
    const state = fakeState({
      "direct-background": {
        status: "processing",
        data: {
          sku: "direct-background",
          submitted: true,
          reconcile_only: true,
          runtime_run_dir: runDir,
          store_id: 7,
          offer_id: "mz-direct-background",
          profit_rate: 40,
          cost_verified: true,
          cost: { ...RELIABLE_COST_RESULT },
          cost_source: RELIABLE_COST_RESULT.source,
          cost_evidence: {
            contract: "1688-same-item-v1",
            source: RELIABLE_COST_RESULT.source,
            reliable_source: true,
            same_item_match: true,
            match_evidence_key: RELIABLE_COST_RESULT.match_evidence_key,
            filtered_price_count: RELIABLE_COST_RESULT.prices.length,
            match_evidence_contract: RELIABLE_COST_RESULT.match_evidence_contract,
            returned_evidence_verified: true,
            matched_offer_count: RELIABLE_COST_RESULT.matched_offer_count,
          },
        },
      },
    });
    let publishCalls = 0;
    const result = await createPublishRunner({
      client: clientFor([], {
        publish: async () => {
          publishCalls += 1;
          return { ok: true };
        },
        findImportLog: async () => ({
          sku: "direct-background",
          offer_id: "mz-direct-background",
          import_status: "all_imported",
        }),
        findOnlineProduct: async () => ({
          sku: 900001,
          offer_id: "mz-direct-background",
          online_status: "selling",
          stock: 1,
        }),
      }),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 500,
      runDir,
      directMode: true,
      reconciliationOnly: true,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
      confirmationAttempts: 1,
      confirmationIntervalMs: 0,
    }).run();

    assert.equal(publishCalls, 0);
    assert.equal(result.accepted, 1);
    assert.equal(state.entryOf("direct-background").data.outcome_status, "online");
    assert.equal(state.entryOf("direct-background").data.background_status.online, true);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct mode target zero keeps accepting candidates without a global quantity cap", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-unlimited-"));
  try {
    let publishCalls = 0;
    const candidates = ["unlimited-a", "unlimited-b"].map((sku) => ({
      sku,
      title: `safe ${sku}`,
      cover_image: `https://img.example/${sku}.jpg`,
      sell_price: 100,
    }));
    const result = await createPublishRunner({
      client: clientFor(candidates, {
        getProductDetail: async (sku) => ({
          sku,
          mode: "FBO",
          title: `safe ${sku}`,
          cover_image: `https://img.example/${sku}.jpg`,
          current_price: 100,
          follow_min: 90,
        }),
        publish: async () => {
          publishCalls += 1;
          return { ok: true, response: { code: 1 } };
        },
      }),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state: fakeState(),
      target: 0,
      runDir,
      directMode: true,
      concurrency: 2,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.equal(publishCalls, 2);
    assert.equal(result.accepted, 2);
    assert.equal(result.unlimited, true);
    assert.equal(result.target, null);
    assert.equal(result.remaining, null);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct mode excludes historical ERP acceptances without current-run ownership", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-run-scope-"));
  try {
    const state = fakeState({
      historical: {
        status: "processing",
        data: {
          sku: "historical",
          submitted: true,
          store_id: 7,
        },
      },
      current: {
        status: "processing",
        data: {
          sku: "current",
          submitted: true,
          runtime_run_dir: runDir,
          store_id: 7,
        },
      },
    });
    const result = await createPublishRunner({
      client: clientFor([]),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 500,
      runDir,
      directMode: true,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.equal(result.accepted, 1);
    assert.equal(result.remaining, 499);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("direct mode permits a different SKU with a title already used by another store", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-direct-title-variant-"));
  try {
    const title = "Одинаковое название, но другой SKU товара";
    const state = fakeState({
      historical: {
        status: "published",
        data: {
          sku: "historical",
          title,
          store_id: 9,
        },
      },
    });
    let publishCalls = 0;
    const result = await createPublishRunner({
      client: clientFor([
        {
          sku: "new-sku",
          title,
          cover_image: "https://img.example/new-sku.jpg",
          sell_price: 100,
        },
      ], {
        getProductDetail: async (sku) => ({
          sku,
          mode: "FBO",
          title,
          cover_image: "https://img.example/new-sku.jpg",
          current_price: 100,
          follow_min: 90,
        }),
        publish: async () => {
          publishCalls += 1;
          return { ok: true, response: { code: 1 } };
        },
      }),
      costBridge: { estimate: async () => ({ ...RELIABLE_COST_RESULT }) },
      state,
      target: 1,
      runDir,
      directMode: true,
      minimumSameItemMatches: 1,
      requireReliableCostContract: true,
    }).run();

    assert.equal(publishCalls, 1);
    assert.equal(result.accepted, 1);
    assert.equal(state.entryOf("new-sku").data.submitted, true);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("accepted ERP response safely stops when submitted state cannot be persisted", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-accepted-cas-fail-"));
  try {
    const state = fakeState();
    const transition = state.transition;
    state.transition = async (sku, status, data) => {
      if (data?.submitted === true) return false;
      return transition(sku, status, data);
    };
    let publishCalls = 0;
    let confirmationCalls = 0;
    let syncCalls = 0;
    const runner = createPublishRunner({
      client: clientFor([{ sku: "accepted-cas-fail" }], {
        publish: async () => {
          publishCalls += 1;
          return { ok: true, response: { code: 1 } };
        },
        findImportLog: async () => {
          confirmationCalls += 1;
          return null;
        },
        syncOnlineShops: async () => {
          syncCalls += 1;
          return {};
        },
      }),
      costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
      state,
      target: 1,
      runDir,
      onlineSyncIntervalMs: 0,
    });

    await assert.rejects(runner.run(), /accepted submission state/i);
    assert.equal(publishCalls, 1);
    assert.equal(confirmationCalls, 0);
    assert.equal(syncCalls, 0);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("a fatal favorite deletion leaves a durable skip intent that restart closes without recalculation", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-skip-intent-"));
  try {
    const state = fakeState();
    let detailCalls = 0;
    let deleteCalls = 0;
    const favorite = { sku: "skip-intent", title: "not fbs" };
    const firstClient = clientFor([favorite], {
      getProductDetail: async (sku) => {
        detailCalls += 1;
        return { sku, mode: "FBO", title: "not fbs", current_price: 100 };
      },
      deleteFavorite: async () => {
        deleteCalls += 1;
        throw new Error("Target page, context or browser has been closed");
      },
    });
    await assert.rejects(createPublishRunner({
      client: firstClient,
      costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
      state,
      target: 1,
      runDir,
    }).run(), /context or browser has been closed/);

    const intent = state.entries().find((entry) => entry.sku === "skip-intent");
    assert.equal(intent.status, "processing");
    assert.equal(intent.data.skip_intent, true);
    assert.equal(intent.data.reason, "non-pure-fbs");
    const detailsBeforeRestart = detailCalls;

    const restarted = await createPublishRunner({
      client: clientFor([favorite], {
        getProductDetail: async () => {
          detailCalls += 1;
          throw new Error("skip intent must not recalculate");
        },
        deleteFavorite: async () => {
          deleteCalls += 1;
          return true;
        },
      }),
      costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
      state,
      target: 1,
      runDir,
    }).run();

    assert.equal(restarted.published, 0);
    assert.equal(detailCalls, detailsBeforeRestart);
    assert.equal(deleteCalls, 2);
    const closed = state.entries().find((entry) => entry.sku === "skip-intent");
    assert.equal(closed.status, "skipped");
    assert.equal(closed.data.reason, "non-pure-fbs");
    assert.equal(closed.data.skip_intent, false);
    assert.equal(closed.data.favorite_deleted, true);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("ambiguous publish crash is reconciled before one same-offer bounded resubmit", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-ambiguous-submit-"));
  try {
    const state = fakeState();
    const favorite = { sku: "ambiguous-submit", title: "safe item" };
    const payloads = [];
    await assert.rejects(createPublishRunner({
      client: clientFor([favorite], {
        publish: async (payload) => {
          payloads.push(structuredClone(payload));
          throw new Error("browserContext.newPage: Target page, context or browser has been closed");
        },
      }),
      costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
      state,
      target: 1,
      runDir,
      now: () => new Date("2026-07-30T04:00:00.000Z"),
    }).run(), /context or browser has been closed/);

    const uncertain = state.entries().find((entry) => entry.sku === "ambiguous-submit");
    assert.equal(uncertain.status, "processing");
    assert.equal(uncertain.data.submission_intent, true);
    assert.equal(uncertain.data.submitted, false);
    assert.equal(uncertain.data.api_call_attempts_total, 1);
    assert.equal(uncertain.data.submission_payload.rows[0].offer_id, payloads[0].rows[0].offer_id);

    let importChecks = 0;
    let onlineChecks = 0;
    const result = await createPublishRunner({
      client: clientFor([favorite], {
        publish: async (payload) => {
          payloads.push(structuredClone(payload));
          return { ok: true, response: { code: 1 } };
        },
        findImportLog: async ({ sku, offerId }) => {
          importChecks += 1;
          if (importChecks === 1) return null;
          return { sku, offer_id: offerId, import_status: "all_imported" };
        },
        findOnlineProduct: async ({ offerId }) => {
          onlineChecks += 1;
          if (onlineChecks === 1) return null;
          return { sku: 900001, offer_id: offerId, online_status: "selling", stock: 1 };
        },
      }),
      costBridge: { estimate: async () => {
        throw new Error("restored submission intent must not repeat 1688");
      } },
      state,
      target: 1,
      runDir,
      now: () => new Date("2026-07-30T04:01:00.000Z"),
      confirmationAttempts: 1,
      confirmationIntervalMs: 0,
    }).run();

    assert.equal(result.published, 1);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[1].rows[0].offer_id, payloads[0].rows[0].offer_id);
    assert.equal(state.records[0].api_call_attempts_total, 2);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("fatal batch waits for sibling settlement and cancels its pending ERP mutation", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-fatal-settled-"));
  try {
    let releaseSibling;
    let siblingStarted;
    const siblingGate = new Promise((resolve) => { releaseSibling = resolve; });
    const siblingWasStarted = new Promise((resolve) => { siblingStarted = resolve; });
    let publishCalls = 0;
    let runSettled = false;
    const detailSkus = [];
    const runner = createPublishRunner({
      client: clientFor([{ sku: "fatal" }, { sku: "sibling" }, { sku: "not-started" }], {
        getProductDetail: async (sku) => {
          detailSkus.push(String(sku));
          if (String(sku) === "fatal") {
            await siblingWasStarted;
            throw new Error("Target page, context or browser has been closed");
          }
          siblingStarted();
          await siblingGate;
          return { sku, mode: "FBS", title: "safe sibling", current_price: 100, follow_min: 90 };
        },
        publish: async () => {
          publishCalls += 1;
          return { ok: true };
        },
      }),
      costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
      state: fakeState(),
      target: 2,
      concurrency: 2,
      runDir,
    });
    const running = runner.run().finally(() => { runSettled = true; });
    await siblingWasStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runSettled, false);
    releaseSibling();
    await assert.rejects(running, /context or browser has been closed/);
    assert.equal(publishCalls, 0);
    assert.ok(!detailSkus.includes("not-started"));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("validation-only reload excludes latest validated SKUs and grows the buffer incrementally", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-validation-incremental-"));
  try {
    await fs.writeFile(path.join(runDir, "validation_gate.jsonl"), `${JSON.stringify({
      at: "2026-07-30T03:00:00.000Z",
      sku: "already-valid",
      status: "validated",
    })}\n`);
    const detailSkus = [];
    const state = fakeState();
    const first = await createPublishRunner({
      client: clientFor([
        { sku: "already-valid" },
        { sku: "new-valid-1" },
      ], {
        getProductDetail: async (sku) => {
          detailSkus.push(String(sku));
          return {
            sku,
            mode: "FBS",
            title: `safe ${sku}`,
            cover_image: "https://img.example/safe.jpg",
            current_price: 100,
            follow_min: 90,
          };
        },
      }),
      costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
      state,
      target: 500,
      validationOnly: true,
      validationTarget: 1,
      runDir,
    }).run();
    assert.equal(first.validated, 1);
    assert.ok(!detailSkus.includes("already-valid"));
    assert.ok(detailSkus.includes("new-valid-1"));

    const second = await createPublishRunner({
      client: clientFor([
        { sku: "already-valid" },
        { sku: "new-valid-1" },
        { sku: "new-valid-2" },
      ], {
        getProductDetail: async (sku) => {
          detailSkus.push(String(sku));
          return {
            sku,
            mode: "FBS",
            title: `safe ${sku}`,
            cover_image: "https://img.example/safe.jpg",
            current_price: 100,
            follow_min: 90,
          };
        },
      }),
      costBridge: { estimate: async () => ({ ok: true, cost: 20 }) },
      state,
      target: 500,
      validationOnly: true,
      validationTarget: 1,
      runDir,
    }).run();
    assert.equal(second.validated, 1);
    assert.equal(detailSkus.filter((sku) => sku === "new-valid-1").length, 2);
    assert.ok(detailSkus.includes("new-valid-2"));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("state eligibility blocks a third SKU attempt before detail, 1688, or publish work", async () => {
  const state = fakeState();
  state.canAttempt = () => ({ allowed: false, reason: "daily-transient-limit" });
  let detailCalls = 0;
  let costCalls = 0;
  let publishCalls = 0;
  const result = await createPublishRunner({
    client: clientFor([{ sku: "retry-blocked" }], {
      getProductDetail: async () => {
        detailCalls += 1;
        return {};
      },
      publish: async () => {
        publishCalls += 1;
        return { ok: true };
      },
    }),
    costBridge: { estimate: async () => {
      costCalls += 1;
      return { ok: true, cost: 20 };
    } },
    state,
    target: 1,
  }).run();

  assert.equal(result.published, 0);
  assert.equal(detailCalls, 0);
  assert.equal(costCalls, 0);
  assert.equal(publishCalls, 0);
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

test("unchanged store-target evidence is compacted to a bounded heartbeat", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-target-heartbeat-"));
  let current = new Date("2026-07-17T00:00:00.000Z");
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
    runDir,
    target: 1,
    targetConfigCache: {},
    targetRefreshIntervalMs: 0,
    targetMetricHeartbeatMs: 1_800_000,
    now: () => current,
  });

  await runner.run();
  current = new Date("2026-07-17T00:01:00.000Z");
  await runner.run();
  current = new Date("2026-07-17T00:31:00.000Z");
  await runner.run();

  assert.equal(targetCalls, 3);
  const rows = (await fs.readFile(path.join(runDir, "store_targets.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 2);
  await fs.rm(runDir, { recursive: true, force: true });
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
