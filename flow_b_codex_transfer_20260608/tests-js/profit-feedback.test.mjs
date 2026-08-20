import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFeedbackArtifacts,
  FEEDBACK_RESULTS,
  isFeedbackBlocked,
  isMatchBlocked,
  isOfferBlocked,
  mergeFeedbackArtifacts,
  mergeFeedbackRecords,
  normalizeFeedbackResult,
  parseFeedbackCsv,
  parseFeedbackRows,
} from "../scripts/flow_b_playwright/profit-feedback.mjs";

const IMPORTED_AT = "2026-08-09T12:30:00.000Z";

test("normalizes the five supported results and common Chinese and English aliases", () => {
  assert.equal(normalizeFeedbackResult("正常"), FEEDBACK_RESULTS.NORMAL);
  assert.equal(normalizeFeedbackResult("OK"), FEEDBACK_RESULTS.NORMAL);
  assert.equal(normalizeFeedbackResult("负利润"), FEEDBACK_RESULTS.LOSS);
  assert.equal(normalizeFeedbackResult("unprofitable"), FEEDBACK_RESULTS.LOSS);
  assert.equal(normalizeFeedbackResult("不能采购"), FEEDBACK_RESULTS.UNAVAILABLE);
  assert.equal(normalizeFeedbackResult("out of stock"), FEEDBACK_RESULTS.UNAVAILABLE);
  assert.equal(normalizeFeedbackResult("货不对版"), FEEDBACK_RESULTS.WRONG_ITEM);
  assert.equal(normalizeFeedbackResult("wrong item"), FEEDBACK_RESULTS.WRONG_ITEM);
  assert.equal(normalizeFeedbackResult("型号错误"), FEEDBACK_RESULTS.WRONG_SPEC);
  assert.equal(normalizeFeedbackResult("variant mismatch"), FEEDBACK_RESULTS.WRONG_SPEC);
  assert.equal(normalizeFeedbackResult("待确认"), null);
});

test("parses aliased CSV headers, quoted fields, text SKU and optional columns", () => {
  const csv = [
    "\uFEFF本店 Ozon SKU,核价结果,实际采购价格,正确 1688 链接,处理方式,备注,跟卖 SKU,1688商品ID,店铺 ID",
    '"001234567890",OK,"¥ 12.80",https://detail.1688.com/offer/987654.html,保留,"可靠, 可复用",2815247001,987654,104965',
  ].join("\r\n");
  const parsed = parseFeedbackCsv(csv, { updatedAt: IMPORTED_AT });

  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.records.length, 1);
  assert.deepEqual(parsed.records[0], {
    feedback_key: "feedback:v1:104965:001234567890",
    store_sku: "001234567890",
    store_id: "104965",
    result: "正常",
    result_code: "normal",
    actual_cost: 12.8,
    source_sku: "2815247001",
    selected_offer_id: "987654",
    selected_offer_url: null,
    correct_1688_url: "https://detail.1688.com/offer/987654.html",
    action: "保留",
    note: "可靠, 可复用",
    updated_at: IMPORTED_AT,
  });
});

test("requires only store SKU and a recognized result while reporting invalid rows", () => {
  const parsed = parseFeedbackRows([
    { "本店SKU": "100", "核对结果": "正常" },
    { "本店SKU": "", "核对结果": "正常" },
    { "本店SKU": "102", "核对结果": "待确认" },
    { "本店SKU": "103", "核对结果": "亏本", "实际采购价": "zero" },
  ], { updatedAt: IMPORTED_AT });

  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.errors.length, 3);
  assert.match(parsed.errors[0].reason, /store_sku/iu);
  assert.match(parsed.errors[1].reason, /unsupported feedback result/iu);
  assert.match(parsed.errors[2].reason, /positive number/iu);
});

test("builds trusted, cost-correction, unavailable-offer and wrong-match snapshots", () => {
  const parsed = parseFeedbackRows([
    {
      store_sku: "store-normal",
      result: "正常",
      source_sku: "source-normal",
      selected_offer_id: "offer-normal",
      actual_cost: "20",
    },
    {
      store_sku: "store-loss",
      result: "亏本",
      source_sku: "source-loss",
      selected_offer_id: "offer-loss",
      actual_cost: "42.5",
    },
    {
      store_sku: "store-loss-without-cost",
      result: "低利润",
      selected_offer_id: "offer-loss-no-cost",
    },
    {
      store_sku: "store-unavailable",
      result: "无法采购",
      selected_offer_url: "https://detail.1688.com/offer/300.html?spm=test",
    },
    {
      store_sku: "store-wrong-item",
      result: "错货",
      source_sku: "source-wrong-item",
      selected_offer_id: "400",
      correct_1688_url: "https://detail.1688.com/offer/401.html",
    },
    {
      store_sku: "store-wrong-spec",
      result: "错规格",
      source_sku: "source-wrong-spec",
      selected_offer_url: "https://detail.1688.com/offer/500.html",
    },
  ], { updatedAt: IMPORTED_AT });
  const artifacts = buildFeedbackArtifacts(parsed.records, { updatedAt: IMPORTED_AT });

  assert.equal(artifacts.trusted.contract, "ozon-profit-feedback-trusted-v1");
  assert.equal(artifacts.trusted.records.length, 3);
  assert.equal(artifacts.trusted.trusted.length, 1);
  assert.equal(artifacts.trusted.cost_corrections.length, 2);
  assert.equal(artifacts.trusted.cost_corrections[0].actual_cost, 42.5);
  assert.equal(artifacts.trusted.cost_corrections[1].actual_cost, null);
  assert.equal(artifacts.errors.records.length, 3);
  assert.equal(artifacts.errors.blocked_offers.length, 1);
  assert.equal(artifacts.errors.blocked_matches.length, 2);
  assert.equal(artifacts.errors.blocked_matches[0].correct_1688_url, "https://detail.1688.com/offer/401.html");

  assert.equal(isOfferBlocked(artifacts, { offer_id: "300" }), true);
  assert.equal(isFeedbackBlocked(artifacts, {
    source_sku: "any-source",
    offer_url: "https://detail.1688.com/offer/300.html?other=1",
  }), true);
  assert.equal(isMatchBlocked(artifacts, { source_sku: "source-wrong-item", offer_id: "400" }), true);
  assert.equal(isMatchBlocked(artifacts, { source_sku: "another-source", offer_id: "400" }), false);
  assert.equal(isFeedbackBlocked(artifacts, { source_sku: "source-wrong-item", offer_id: "401" }), false);
  assert.equal(isFeedbackBlocked(artifacts, { source_sku: "source-loss", offer_id: "offer-loss" }), false);
});

test("does not create broad blocks when wrong-match identity is incomplete", () => {
  const parsed = parseFeedbackRows([{
    store_sku: "store-incomplete",
    result: "错货",
    source_sku: "source-only",
    correct_1688_url: "https://detail.1688.com/offer/700.html",
  }], { updatedAt: IMPORTED_AT });
  const artifacts = buildFeedbackArtifacts(parsed.records, { updatedAt: IMPORTED_AT });

  assert.equal(artifacts.errors.records.length, 1);
  assert.equal(artifacts.errors.blocked_matches.length, 0);
  assert.equal(isFeedbackBlocked(artifacts, { source_sku: "source-only", offer_id: "anything" }), false);
});

test("a correct 1688 URL is never emitted as a negative block", () => {
  const parsed = parseFeedbackRows([
    {
      store_sku: "store-unavailable-correct",
      result: "无法采购",
      selected_offer_id: "800",
      selected_offer_url: "https://detail.1688.com/offer/800.html",
      correct_1688_url: "https://detail.1688.com/offer/800.html",
    },
    {
      store_sku: "store-wrong-correct",
      result: "错货",
      source_sku: "source-wrong-correct",
      selected_offer_id: "801",
      selected_offer_url: "https://detail.1688.com/offer/801.html",
      correct_1688_url: "https://detail.1688.com/offer/801.html",
    },
  ], { updatedAt: IMPORTED_AT });
  const artifacts = buildFeedbackArtifacts(parsed.records, { updatedAt: IMPORTED_AT });
  assert.equal(artifacts.errors.blocked_offers.length, 0);
  assert.equal(artifacts.errors.blocked_matches.length, 0);
  assert.equal(isFeedbackBlocked(artifacts, { source_sku: "source-wrong-correct", offer_id: "801" }), false);
  assert.equal(isFeedbackBlocked(artifacts, { offer_id: "800" }), false);
});

test("stable feedback keys make duplicate imports idempotent and newer conflicts win", () => {
  const original = parseFeedbackRows([{
    store_sku: "900",
    store_id: "shop-a",
    result: "正常",
    note: "first",
    updated_at: "2026-08-09T10:00:00.000Z",
  }], { updatedAt: IMPORTED_AT }).records;
  const duplicate = mergeFeedbackRecords(original, original, { updatedAt: IMPORTED_AT });
  assert.deepEqual(duplicate, original);

  const olderConflict = parseFeedbackRows([{
    store_sku: "900",
    store_id: "shop-a",
    result: "错货",
    updated_at: "2026-08-09T09:59:59.000Z",
  }], { updatedAt: IMPORTED_AT }).records;
  assert.equal(mergeFeedbackRecords(original, olderConflict)[0].result, "正常");

  const newerConflict = parseFeedbackRows([{
    store_sku: "900",
    store_id: "shop-a",
    result: "亏本",
    actual_cost: "77",
    updated_at: "2026-08-09T10:00:01.000Z",
  }], { updatedAt: IMPORTED_AT }).records;
  const merged = mergeFeedbackRecords(original, newerConflict);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].result, "亏本");
  assert.equal(merged[0].updated_at, "2026-08-09T10:00:01.000Z");
});

test("artifact merge removes an older trusted decision after a newer blocking correction", () => {
  const first = buildFeedbackArtifacts(parseFeedbackRows([{
    store_sku: "901",
    store_id: "shop-a",
    result: "正常",
    source_sku: "source-901",
    selected_offer_id: "offer-901",
    updated_at: "2026-08-09T10:00:00.000Z",
  }], { updatedAt: IMPORTED_AT }).records);
  const correction = parseFeedbackRows([{
    store_sku: "901",
    store_id: "shop-a",
    result: "错规格",
    source_sku: "source-901",
    selected_offer_id: "offer-901",
    updated_at: "2026-08-09T11:00:00.000Z",
  }], { updatedAt: IMPORTED_AT }).records;
  const merged = mergeFeedbackArtifacts(first, correction);

  assert.equal(merged.trusted.records.length, 0);
  assert.equal(merged.errors.records.length, 1);
  assert.equal(merged.errors.blocked_matches.length, 1);
  assert.equal(isMatchBlocked(merged, { source_sku: "source-901", offer_id: "offer-901" }), true);
});
