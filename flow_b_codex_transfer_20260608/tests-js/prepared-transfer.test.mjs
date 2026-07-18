import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPreparedTransferPayload,
  selectPreparedTransferCandidates,
  transferPreparedCandidates,
} from "../scripts/flow_b_playwright/prepared-transfer.mjs";

test("prepared transfer selects only the requested strict-profit safe SKUs", () => {
  const candidates = selectPreparedTransferCandidates([
    { sku: "1", profit_rate: 30.01, shipping_mode: "FBS", title: "one", cover_image: "1.jpg", link: "https://www.ozon.ru/product/one-1/", sell_price: 10, purchase_price: 1, cate_rate: 10, cate_fee: 1, id: 11 },
    { sku: "2", profit_rate: 30, shipping_mode: "FBS", title: "two", cover_image: "2.jpg", link: "https://www.ozon.ru/product/two-2/", sell_price: 10, purchase_price: 1, cate_rate: 10, cate_fee: 1, id: 12 },
    { sku: "3", profit_rate: 80, shipping_mode: "FBO", title: "three", cover_image: "3.jpg", link: "https://www.ozon.ru/product/three-3/", sell_price: 10, purchase_price: 1, cate_rate: 10, cate_fee: 1, id: 13 },
    { sku: "2815247918", profit_rate: 90, shipping_mode: "FBS", title: "excluded", cover_image: "4.jpg", link: "https://www.ozon.ru/product/excluded-2815247918/", sell_price: 10, purchase_price: 1, cate_rate: 10, cate_fee: 1, id: 14 },
  ], {
    requestedSkus: new Set(["1", "2", "3", "2815247918"]),
    threshold: 30,
    excludedSkus: new Set(["2815247918"]),
  });

  assert.deepEqual(candidates.accepted.map((row) => row.sku), ["1"]);
  assert.deepEqual(candidates.rejected.map((row) => [row.sku, row.reason]), [
    ["2", "profit_rate<=30"],
    ["3", "non-pure-fbs"],
    ["2815247918", "excluded-sku"],
  ]);
});

test("prepared transfer accepts durable preflight FBS evidence when the transient mode is missing", () => {
  const candidates = selectPreparedTransferCandidates([{
    sku: "1",
    profit_rate: 60,
    preflight_mode: "FBS",
    title: "one",
    cover_image: "1.jpg",
    link: "https://www.ozon.ru/product/one-1/",
    sell_price: 10,
    purchase_price: 1,
    cate_rate: 10,
    cate_fee: 1,
    id: 11,
  }]);

  assert.deepEqual(candidates.accepted.map((row) => row.sku), ["1"]);
  assert.deepEqual(candidates.rejected, []);
});

test("prepared transfer payload targets the verified second store and keeps the full SKU", () => {
  const payload = buildPreparedTransferPayload({
    id: 18464424,
    sku: "3946495101",
    title: "safe",
    cover_image: "https://example.test/image.jpg",
    link: "https://www.ozon.ru/product/safe-3946495101/",
    sell_price: 27.07,
  }, { storeId: 106637, watermarkId: 60822, offerId: "mz-150726-3946495101" });

  assert.deepEqual(payload.shop_ids, [106637]);
  assert.equal(payload.watermark_id, 60822);
  assert.equal(payload.rows[0].sku, "3946495101");
  assert.equal(payload.rows[0].offer_id, "mz-150726-3946495101");
});

test("prepared transfer does not resubmit an existing target import and continues after one SKU error", async () => {
  const published = [];
  const transitions = [];
  const publishCalls = [];
  const client = {
    resolvePublishTarget: async () => ({ store: { id: 106637, name: "丽丽二号" }, watermark: { id: 60822, name: "1号" } }),
    findOnlineProduct: async () => null,
    findImportLog: async ({ sku, offerId }) => String(sku) === "1"
      ? { sku, offer_id: offerId, import_status: "pending" }
      : null,
    publish: async (payload) => {
      publishCalls.push(payload.rows[0].sku);
      if (payload.rows[0].sku === "2") throw new Error("HTTP 0");
      return { ok: true, status: 200, response: { code: 1 } };
    },
    syncOnlineShops: async () => [],
  };
  const state = {
    transition: async (sku, status, data) => transitions.push({ sku: String(sku), status, data }),
    recordPublished: async (row) => published.push(row),
  };
  const base = (sku) => ({
    id: Number(sku), sku, title: `item-${sku}`, cover_image: `${sku}.jpg`,
    link: `https://www.ozon.ru/product/item-${sku}-${sku}/`, shipping_mode: "FBS",
    sell_price: 50, purchase_price: 5, profit_rate: 60, cate_rate: 10, cate_fee: 5,
    offer_id: `mz-150726-${sku}`,
  });

  const result = await transferPreparedCandidates({
    client,
    state,
    candidates: [base("1"), base("2"), base("3")],
    storeId: 106637,
    storeNeedle: "丽丽二号",
    watermarkId: 60822,
    watermarkNeedle: "lysh",
  });

  assert.deepEqual(publishCalls, ["2", "3"]);
  assert.equal(result.existing_pending, 1);
  assert.equal(result.submitted, 1);
  assert.equal(result.failed, 1);
  assert.ok(transitions.some((row) => row.sku === "1" && row.data.reason === "target-import-pending"));
  assert.ok(transitions.some((row) => row.sku === "2" && row.status === "failed"));
  assert.ok(transitions.some((row) => row.sku === "3" && row.data.reason === "target-submitted-pending"));
  assert.equal(published.length, 0);
});
