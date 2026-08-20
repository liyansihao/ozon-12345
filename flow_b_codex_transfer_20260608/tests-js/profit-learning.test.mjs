import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateRecentOrderLines,
  buildPriorityMotherProducts,
  calculateContributionProfit,
  expandMaoziOrderRows,
  normalizeErpOrderLine,
  normalizeErpProfitList,
} from "../scripts/flow_b_playwright/profit-learning.mjs";

const GENERATED_AT = "2026-08-09T12:00:00.000Z";

function profit(overrides = {}) {
  return {
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

function order(sourceSku, sequence, overrides = {}) {
  return {
    store_id: 104965,
    store_sku: `9000${sourceSku}${sequence}`,
    offer_id: `offer-${sourceSku}`,
    source_sku: sourceSku,
    order_id: `${sourceSku}-order-${sequence}`,
    status: "delivered",
    order_time: `2026-08-0${Math.min(sequence, 8)}T10:00:00.000Z`,
    title: `Kitchen storage ${sourceSku}`,
    category: "Home storage",
    ...profit(),
    ...overrides,
  };
}

test("normalizes ERP identifiers, status, time, source mapping and profit_list labels", () => {
  const row = normalizeErpOrderLine({
    shop_id: 104965,
    sku: 900000000001,
    vendor_code: "OWN-001",
    posting_number: "POST-001",
    posting_status: "已妥投",
    created_at: "2026-08-08T12:30:00Z",
    quantity: "4",
    profit_list: JSON.stringify([
      { name: "订单金额", value: "¥100.00" },
      { name: "采购成本", value: -40 },
      { name: "Ozon佣金", value: -10 },
      { name: "国际物流", value: 15 },
      { name: "尾程派送", value: 5 },
      { name: "其他费用", value: 0 },
      { name: "退款损失", value: 0 },
      { name: "ERP利润", value: 31 },
    ]),
  }, {
    sourceSkuByOfferId: { "104965:OWN-001": "SOURCE-001" },
  });

  assert.equal(row.store_id, "104965");
  assert.equal(row.store_sku, "900000000001");
  assert.equal(row.offer_id, "OWN-001");
  assert.equal(row.source_sku, "SOURCE-001");
  assert.equal(row.product_key, "source_sku:SOURCE-001");
  assert.equal(row.status, "delivered");
  assert.equal(row.order_time, "2026-08-08T12:30:00.000Z");
  assert.equal(row.quantity, 4);
  assert.equal(normalizeErpOrderLine({ quantity: 0 }).quantity, 1);
  assert.equal(normalizeErpOrderLine({ quantity: "invalid" }).quantity, 1);
  assert.deepEqual(row.profit_list, profit());
  assert.equal(row.contribution_profit_cny, 30);
  assert.equal(row.erp_profit_cny, 31);
  assert.equal(row.profit_difference_cny, -1);
  assert.equal(row.profit_data_complete, true);
});

test("recomputes contribution profit and never substitutes an ERP profit for missing components", () => {
  const complete = calculateContributionProfit({
    ...profit(),
    amount_cny: "not available",
    order_amount_cny: 100,
    profit_cny: 999,
  });
  assert.equal(complete.contribution_profit_cny, 30);
  assert.equal(complete.erp_profit_cny, 999);
  assert.equal(complete.profit_difference_cny, -969);

  const incomplete = calculateContributionProfit({
    amount_cny: 100,
    purchase_cost_cny: 40,
    commission_cny: 10,
    profit_cny: 50,
  });
  assert.equal(incomplete.data_complete, false);
  assert.equal(incomplete.contribution_profit_cny, null);
  assert.equal(incomplete.erp_profit_cny, 50);
  assert.deepEqual(incomplete.missing_fields, [
    "international_logistics_cny",
    "last_mile_cny",
    "other_cost_cny",
    "refund_cny",
  ]);
});

test("normalizes map-style profit lists and treats negative expense ledger values as costs", () => {
  assert.deepEqual(normalizeErpProfitList({
    order_amount_cny: "1,000.50",
    purchase_cost_cny: -400,
    commission_fee_cny: -100,
    international_shipping_cny: -150,
    last_mile_cny: -50,
    service_fee_cny: 0,
    refund_amount_cny: -10,
    profit_cny: 290.5,
  }), {
    amount_cny: 1000.5,
    purchase_cost_cny: 400,
    commission_cny: 100,
    international_logistics_cny: 150,
    last_mile_cny: 50,
    other_cost_cny: 0,
    refund_cny: 10,
    erp_profit_cny: 290.5,
  });
});

test("expands the verified Maozi products shape and allocates order profit by price times quantity", () => {
  const lines = expandMaoziOrderRows([{
    order_id: "MAOZI-ORDER-1",
    shop_id: 104965,
    status: "delivered",
    in_process_at: "2026-08-08T10:00:00.000Z",
    update_time: "2026-08-08T12:00:00.000Z",
    products: [
      { name: "Small organizer", offer_id: "OWN-A", sku: "OZON-A", price: 100, quantity: 1, barcode: "A-1" },
      { name: "Large organizer", offer_id: "OWN-B", sku: "OZON-B", price: 100, quantity: 2, barcode: "B-2" },
    ],
    profit_list: {
      total_amount_cny: 300,
      total_cost: 90,
      sale_commission_cny: 30,
      processing_and_delivery_cny: 45,
      services_amount_cny: 15,
      others_amount_cny: 0,
      profit_cny: 120,
    },
  }]);

  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => ({
    order_id: line.order_id,
    status: line.status,
    order_time: line.order_time,
    updated_at: line.updated_at,
    sku: line.sku,
    offer_id: line.offer_id,
    name: line.name,
    price: line.price,
    quantity: line.quantity,
    barcode: line.barcode,
    amount_cny: line.amount_cny,
    purchase_cost_cny: line.purchase_cost_cny,
    commission_cny: line.commission_cny,
    international_logistics_cny: line.international_logistics_cny,
    last_mile_cny: line.last_mile_cny,
    other_cost_cny: line.other_cost_cny,
    refund_cny: line.refund_cny,
    erp_profit_cny: line.erp_profit_cny,
  })), [
    {
      order_id: "MAOZI-ORDER-1",
      status: "delivered",
      order_time: "2026-08-08T10:00:00.000Z",
      updated_at: "2026-08-08T12:00:00.000Z",
      sku: "OZON-A",
      offer_id: "OWN-A",
      name: "Small organizer",
      price: 100,
      quantity: 1,
      barcode: "A-1",
      amount_cny: 100,
      purchase_cost_cny: 30,
      commission_cny: 10,
      international_logistics_cny: 15,
      last_mile_cny: 5,
      other_cost_cny: 0,
      refund_cny: 0,
      erp_profit_cny: 40,
    },
    {
      order_id: "MAOZI-ORDER-1",
      status: "delivered",
      order_time: "2026-08-08T10:00:00.000Z",
      updated_at: "2026-08-08T12:00:00.000Z",
      sku: "OZON-B",
      offer_id: "OWN-B",
      name: "Large organizer",
      price: 100,
      quantity: 2,
      barcode: "B-2",
      amount_cny: 200,
      purchase_cost_cny: 60,
      commission_cny: 20,
      international_logistics_cny: 30,
      last_mile_cny: 10,
      other_cost_cny: 0,
      refund_cny: 0,
      erp_profit_cny: 80,
    },
  ]);
  assert.deepEqual(lines.map((line) => normalizeErpOrderLine(line).contribution_profit_cny), [40, 80]);
});

test("aggregates only the last 30 days, deduplicates updated ERP snapshots and uses fallback mapping keys", () => {
  const rows = [
    {
      ...order("ignored", 1),
      source_sku: "",
      store_sku: "900-map",
      offer_id: "OWN-MAP",
      order_id: "mapped-order",
      order_line_id: "line-1",
      status: "processing",
      updated_at: "2026-08-08T11:00:00.000Z",
    },
    {
      ...order("ignored", 1),
      source_sku: "",
      store_sku: "900-map",
      offer_id: "OWN-MAP",
      order_id: "mapped-order",
      order_line_id: "line-1",
      status: "delivered",
      updated_at: "2026-08-08T12:00:00.000Z",
    },
    order("OLD", 1, { order_time: "2026-07-10T11:59:59.999Z" }),
    order("FUTURE", 1, { order_time: "2026-08-09T12:00:00.001Z" }),
  ];
  const aggregation = aggregateRecentOrderLines(rows, {
    generatedAt: GENERATED_AT,
    sourceSkuByOfferId: { "104965:OWN-MAP": "MAPPED-SOURCE" },
  });

  assert.equal(aggregation.groups.length, 1);
  assert.deepEqual(aggregation.groups[0], {
    store_id: "104965",
    source_sku: "MAPPED-SOURCE",
    product_key: "source_sku:MAPPED-SOURCE",
    store_skus: ["900-map"],
    offer_ids: ["OWN-MAP"],
    category: "Home storage",
    title_keywords: ["ignored", "kitchen", "storage"],
    observed_order_count: 1,
    completed_order_count: 1,
    completed_sales_units: 1,
    refund_cancel_count: 0,
    refund_cancel_units: 0,
    refund_cancel_rate: 0,
    contribution_profit_cny: 30,
    erp_profit_cny: null,
    real_profit_cny: 30,
    incomplete_profit_order_count: 0,
    profit_data_complete: true,
    negative_feedback: false,
    eligible: false,
  });
});

test("uses ERP profit as authoritative real profit and only falls back to complete recomputation", () => {
  const erpLoss = aggregateRecentOrderLines([1, 2, 3].map((sequence) => order("ERP-LOSS", sequence, {
    profit_cny: -1,
  })), { generatedAt: GENERATED_AT }).groups[0];
  assert.equal(erpLoss.contribution_profit_cny, 90);
  assert.equal(erpLoss.erp_profit_cny, -3);
  assert.equal(erpLoss.real_profit_cny, -3);
  assert.equal(erpLoss.profit_data_complete, true);
  assert.equal(erpLoss.eligible, false);

  const erpCompleteDespiteMissingComponents = aggregateRecentOrderLines(
    [1, 2, 3].map((sequence) => order("ERP-WINS", sequence, {
      other_cost_cny: undefined,
      profit_cny: 5,
    })),
    { generatedAt: GENERATED_AT },
  ).groups[0];
  assert.equal(erpCompleteDespiteMissingComponents.contribution_profit_cny, 0);
  assert.equal(erpCompleteDespiteMissingComponents.real_profit_cny, 15);
  assert.equal(erpCompleteDespiteMissingComponents.incomplete_profit_order_count, 0);
  assert.equal(erpCompleteDespiteMissingComponents.profit_data_complete, true);
  assert.equal(erpCompleteDespiteMissingComponents.eligible, true);
});

test("joins order/refund aliases and applies each refund exactly once", () => {
  const base = order("REFUND-JOIN", 1, {
    order_id: undefined,
    posting_number: "POSTING-REFUND-1",
    store_sku: "STORE-REFUND-1",
    updated_at: "2026-08-01T11:00:00.000Z",
    refund_cny: 10,
    profit_cny: 20,
  });
  const separateRefund = {
    store_id: 104965,
    store_sku: "STORE-REFUND-1",
    offer_id: "offer-REFUND-JOIN",
    source_sku: "REFUND-JOIN",
    order_id: "POSTING-REFUND-1",
    status: "refunded",
    order_time: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T12:00:00.000Z",
    refund_cny: 10,
  };
  const embedded = aggregateRecentOrderLines([base, separateRefund], {
    generatedAt: GENERATED_AT,
  }).groups[0];
  assert.equal(embedded.observed_order_count, 1);
  assert.equal(embedded.completed_order_count, 1);
  assert.equal(embedded.refund_cancel_count, 1);
  assert.equal(embedded.contribution_profit_cny, 20);
  assert.equal(embedded.erp_profit_cny, 20);
  assert.equal(embedded.real_profit_cny, 20);

  const withoutEmbeddedRefund = {
    ...base,
    refund_cny: 0,
    profit_cny: 30,
  };
  const separateOnly = aggregateRecentOrderLines([
    withoutEmbeddedRefund,
    { ...separateRefund, refund_cny: 20 },
  ], { generatedAt: GENERATED_AT }).groups[0];
  assert.equal(separateOnly.contribution_profit_cny, 10);
  assert.equal(separateOnly.erp_profit_cny, 10);
  assert.equal(separateOnly.real_profit_cny, 10);

  const authoritativeRefund = aggregateRecentOrderLines([
    withoutEmbeddedRefund,
    { ...separateRefund, refund_cny: 20, erp_profit_cny: 5 },
  ], { generatedAt: GENERATED_AT }).groups[0];
  assert.equal(authoritativeRefund.contribution_profit_cny, 10);
  assert.equal(authoritativeRefund.erp_profit_cny, 5);
  assert.equal(authoritativeRefund.real_profit_cny, 5);

  const refundWithoutOrder = aggregateRecentOrderLines([
    { ...separateRefund, order_id: "REFUND-ONLY", refund_cny: 20 },
  ], { generatedAt: GENERATED_AT }).groups[0];
  assert.equal(refundWithoutOrder.completed_order_count, 0);
  assert.equal(refundWithoutOrder.real_profit_cny, -20);
});

test("requires three completed orders, positive complete profit and no negative feedback", () => {
  const rows = [
    ...[1, 2, 3].map((sequence) => order("GOOD", sequence)),
    ...[1, 2].map((sequence) => order("TWO", sequence)),
    ...[1, 2, 3].map((sequence) => order("LOSS", sequence, { amount_cny: 50 })),
    ...[1, 2, 3].map((sequence) => order("INCOMPLETE", sequence, { other_cost_cny: undefined })),
    ...[1, 2, 3].map((sequence) => order("NEGATIVE", sequence, { negative_feedback: sequence === 1 })),
    ...[1, 2, 3].map((sequence) => order("CANCELLED", sequence)),
    order("CANCELLED", 4, { status: "cancelled" }),
    order("GOOD", 4, { status: "processing", amount_cny: 10_000 }),
  ];
  const aggregation = aggregateRecentOrderLines(rows, { generatedAt: GENERATED_AT });
  const bySku = new Map(aggregation.groups.map((group) => [group.source_sku, group]));

  assert.equal(bySku.get("GOOD").eligible, true);
  assert.equal(bySku.get("GOOD").completed_order_count, 3);
  assert.equal(bySku.get("GOOD").contribution_profit_cny, 90);
  assert.equal(bySku.get("TWO").eligible, false);
  assert.equal(bySku.get("LOSS").eligible, false);
  assert.equal(bySku.get("INCOMPLETE").profit_data_complete, false);
  assert.equal(bySku.get("INCOMPLETE").eligible, false);
  assert.equal(bySku.get("NEGATIVE").negative_feedback, true);
  assert.equal(bySku.get("NEGATIVE").eligible, false);
  assert.equal(bySku.get("CANCELLED").refund_cancel_rate, 0.25);
  assert.equal(bySku.get("CANCELLED").eligible, true);

  const capped = aggregateRecentOrderLines(rows, {
    generatedAt: GENERATED_AT,
    maximumRefundCancelRate: 0.1,
  });
  assert.equal(capped.groups.find((group) => group.source_sku === "CANCELLED").eligible, false);
});

test("ranks profitable mothers by completed sales units before profit or order count", () => {
  const rows = [
    ...[1, 2, 3].map((sequence) => order("TWELVE-UNITS", sequence, {
      quantity: 4,
      profit_cny: 1,
    })),
    ...[1, 2, 3, 4, 5, 6].map((sequence) => order("SIX-UNITS", sequence, {
      quantity: 1,
      profit_cny: 100,
    })),
  ];
  const output = buildPriorityMotherProducts(rows, {
    generatedAt: GENERATED_AT,
    storeIds: [104965],
  });

  assert.deepEqual(
    output.stores[0].mother_products.map((mother) => mother.source_sku),
    ["TWELVE-UNITS", "SIX-UNITS"],
  );
  assert.deepEqual(
    output.stores[0].mother_products.map((mother) => ({
      source_sku: mother.source_sku,
      order_count: mother.order_count,
      sales_units: mother.sales_units,
      real_profit_cny: mother.real_profit_cny,
    })),
    [
      { source_sku: "TWELVE-UNITS", order_count: 3, sales_units: 12, real_profit_cny: 3 },
      { source_sku: "SIX-UNITS", order_count: 6, sales_units: 6, real_profit_cny: 600 },
    ],
  );
});

test("uses lower refund rate before real profit when completed sales units tie", () => {
  const rows = [
    ...[1, 2, 3].map((sequence) => order("CLEAN-HIGH", sequence, {
      quantity: 2,
      profit_cny: 10,
    })),
    ...[1, 2, 3].map((sequence) => order("CLEAN-LOW", sequence, {
      quantity: 2,
      profit_cny: 1,
    })),
    ...[1, 2, 3].map((sequence) => order("REFUND-HIGH", sequence, {
      quantity: 2,
      profit_cny: 100,
    })),
    order("REFUND-HIGH", 4, {
      quantity: 2,
      status: "refunded",
      refund_cny: 1,
      profit_cny: -1,
    }),
  ];
  const mothers = buildPriorityMotherProducts(rows, {
    generatedAt: GENERATED_AT,
    storeIds: [104965],
  }).stores[0].mother_products;

  assert.deepEqual(mothers.map((mother) => mother.source_sku), [
    "CLEAN-HIGH",
    "CLEAN-LOW",
    "REFUND-HIGH",
  ]);
  assert.deepEqual(mothers.map((mother) => mother.sales_units), [6, 6, 6]);
  assert.deepEqual(mothers.map((mother) => mother.refund_cancel_rate), [0, 0, 0.25]);
  assert.ok(mothers[2].real_profit_cny > mothers[0].real_profit_cny);
});

test("refunds, cancellations and repeated snapshots do not inflate completed sales units", () => {
  const firstSnapshot = order("UNIT-REFUND", 1, {
    quantity: 4,
    updated_at: "2026-08-01T10:30:00.000Z",
  });
  const latestSnapshot = {
    ...firstSnapshot,
    updated_at: "2026-08-01T11:00:00.000Z",
  };
  const refundSnapshot = {
    ...firstSnapshot,
    status: "refunded",
    updated_at: "2026-08-01T12:00:00.000Z",
    refund_cny: 40,
  };
  const aggregation = aggregateRecentOrderLines([
    firstSnapshot,
    latestSnapshot,
    refundSnapshot,
    order("UNIT-REFUND", 2, { quantity: 4 }),
    order("UNIT-REFUND", 3, { quantity: 4 }),
    order("UNIT-REFUND", 4, { quantity: 5, status: "cancelled" }),
  ], { generatedAt: GENERATED_AT });

  assert.equal(aggregation.groups.length, 1);
  assert.equal(aggregation.groups[0].observed_order_count, 4);
  assert.equal(aggregation.groups[0].completed_order_count, 3);
  assert.equal(aggregation.groups[0].completed_sales_units, 8);
  assert.equal(aggregation.groups[0].refund_cancel_count, 2);
  assert.equal(aggregation.groups[0].refund_cancel_units, 9);
  assert.equal(aggregation.groups[0].refund_cancel_rate, 0.5);
  assert.equal(aggregation.groups[0].eligible, true);
});

test("accepts a 10 percent refund boundary and emits a lightweight, stable per-store priority structure", () => {
  const rows = [
    ...[1, 2, 3].map((sequence) => order("LOWER", sequence)),
    ...Array.from({ length: 9 }, (_, index) => order("HIGHER", index + 1, {
      store_id: 106637,
      amount_cny: 120,
      title_keywords: ["Organizer", "Kitchen"],
      category: "Kitchen",
    })),
    order("HIGHER", 10, {
      store_id: 106637,
      status: "refunded",
      amount_cny: 120,
      refund_cny: 120,
      title_keywords: ["Organizer", "Kitchen"],
      category: "Kitchen",
    }),
  ];
  const output = buildPriorityMotherProducts(rows, {
    generatedAt: GENERATED_AT,
    storeIds: [104965, 106637, 113151],
  });

  assert.deepEqual(Object.keys(output), ["version", "generated_at", "window", "stores"]);
  assert.equal(output.version, 1);
  assert.equal(output.generated_at, GENERATED_AT);
  assert.deepEqual(output.stores.map((store) => store.store_id), ["104965", "106637", "113151"]);
  assert.equal(output.stores[0].mother_products[0].source_sku, "LOWER");
  assert.deepEqual(output.stores[1].mother_products[0], {
    source_sku: "HIGHER",
    product_key: "source_sku:HIGHER",
    store_skus: [
      "9000HIGHER1", "9000HIGHER2", "9000HIGHER3", "9000HIGHER4", "9000HIGHER5",
      "9000HIGHER6", "9000HIGHER7", "9000HIGHER8", "9000HIGHER9", "9000HIGHER10",
    ],
    offer_ids: ["offer-HIGHER"],
    category: "Kitchen",
    title_keywords: ["higher", "kitchen", "organizer", "storage"],
    order_count: 9,
    sales_units: 9,
    real_profit_cny: 330,
    contribution_profit_cny: 330,
    refund_cancel_units: 1,
    refund_cancel_rate: 0.1,
  });
  assert.deepEqual(output.stores[2].mother_products, []);
  assert.deepEqual(
    buildPriorityMotherProducts([...rows].reverse(), {
      generatedAt: GENERATED_AT,
      storeIds: [104965, 106637, 113151],
    }),
    output,
  );
});

test("external negative feedback blocks a previously profitable mother without changing its totals", () => {
  const rows = [1, 2, 3].map((sequence) => order("BLOCKED", sequence));
  const aggregation = aggregateRecentOrderLines(rows, {
    generatedAt: GENERATED_AT,
    negativeFeedback: [{ store_id: 104965, source_sku: "BLOCKED" }],
  });
  assert.equal(aggregation.groups[0].contribution_profit_cny, 90);
  assert.equal(aggregation.groups[0].negative_feedback, true);
  assert.equal(aggregation.groups[0].eligible, false);
});
