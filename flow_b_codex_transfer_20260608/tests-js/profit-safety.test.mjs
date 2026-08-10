import test from "node:test";
import assert from "node:assert/strict";

import { assessProfitSafety } from "../scripts/flow_b_playwright/profit-safety.mjs";

const completePackage = Object.freeze({ weight: 500, length: 20, width: 15, height: 10 });

test("healthy margin remains SAFE under mild cost, return, and FX stress", () => {
  const result = assessProfitSafety({
    profit: {
      sell_price: 100,
      purchase_price: 20,
      china_fee: 0,
      logi_fee: 20,
      cate_fee: 12,
      ad_fee: 0,
      other_fee: 1,
      wc_fee: 2,
      total_cost: 55,
      profit: 45,
      profit_rate: 81.82,
    },
    cost: { cost: 20, prices: [18, 19, 20, 20] },
    packageEvidence: completePackage,
  });

  assert.equal(result.decision, "SAFE");
  assert.equal(result.reason, "stress-margin-safe");
  assert.ok(result.stressed_profit > 0);
  assert.deepEqual(result.missing_evidence, []);
  assert.equal(result.mode, "shadow");
});

test("complete evidence with negative stressed profit is UNSAFE", () => {
  const result = assessProfitSafety({
    profit: {
      sell_price: 30,
      purchase_price: 10,
      china_fee: 0,
      logi_fee: 8,
      cate_fee: 5,
      ad_fee: 0,
      other_fee: 1,
      wc_fee: 2,
      total_cost: 29,
      profit: 1,
      profit_rate: 3.45,
    },
    cost: { cost: 10, prices: [10, 10, 10] },
    packageEvidence: completePackage,
  });

  assert.equal(result.decision, "UNSAFE");
  assert.equal(result.reason, "stress-loss");
  assert.ok(result.stressed_profit < 0);
});

test("supplier pressure uses only the verified selected price cluster", () => {
  const input = {
    profit: {
      sell_price: 69.76,
      purchase_price: 28,
      china_fee: 0,
      logi_fee: 8,
      cate_fee: 8.37,
      ad_fee: 0,
      other_fee: 0.7,
      wc_fee: 2.65,
      total_cost: 47.72,
      profit: 22.04,
      profit_rate: 46.19,
    },
    packageEvidence: completePackage,
  };
  const unscoped = assessProfitSafety({
    ...input,
    cost: { cost: 28, prices: [28, 54.7] },
  });
  const selectedCluster = assessProfitSafety({
    ...input,
    cost: {
      cost: 28,
      prices: [28, 54.7],
      selected_cluster_prices: [28],
    },
  });

  assert.equal(unscoped.decision, "UNSAFE");
  assert.equal(selectedCluster.decision, "SAFE");
  assert.equal(selectedCluster.reserves.supplier_price_gap, 0);
  assert.ok(!selectedCluster.risk_flags.includes("supplier_price_dispersion"));
  assert.ok(selectedCluster.stressed_profit > 0);
});

test("missing package evidence routes a possible stress loss to REVIEW, not rejection", () => {
  const result = assessProfitSafety({
    profit: {
      sell_price: 30,
      purchase_price: 10,
      china_fee: 0,
      logi_fee: 8,
      cate_fee: 5,
      ad_fee: 0,
      other_fee: 1,
      wc_fee: 2,
      total_cost: 29,
      profit: 1,
    },
    cost: { cost: 10, prices: [10, 10] },
    packageEvidence: { weight: 500 },
  });

  assert.equal(result.decision, "REVIEW");
  assert.equal(result.reason, "stress-loss-with-missing-evidence");
  assert.deepEqual(result.missing_evidence, ["package_length", "package_width", "package_height"]);
});

test("incomplete prices stay REVIEW even when the apparent margin is high", () => {
  const result = assessProfitSafety({
    profit: { sell_price: 100, purchase_price: 20 },
    packageEvidence: completePackage,
  });

  assert.equal(result.decision, "REVIEW");
  assert.ok(result.missing_evidence.includes("logistics_fee"));
  assert.ok(result.missing_evidence.includes("supplier_price_range"));
});

test("a stale stated total cannot hide a loss in the supplied components", () => {
  const result = assessProfitSafety({
    profit: {
      sell_price: 100,
      purchase_price: 70,
      china_fee: 5,
      logi_fee: 20,
      cate_fee: 10,
      ad_fee: 0,
      other_fee: 1,
      wc_fee: 2,
      total_cost: 30,
      profit: 70,
    },
    cost: { cost: 70, prices: [68, 70, 72] },
    packageEvidence: completePackage,
  });

  assert.equal(result.decision, "UNSAFE");
  assert.equal(result.reason, "baseline-loss");
  assert.equal(result.baseline.total_cost, 108);
  assert.equal(result.baseline.profit, -8);
  assert.ok(result.risk_flags.includes("profit_component_inconsistent"));
  assert.ok(result.risk_flags.includes("profit_total_inconsistent"));
});
