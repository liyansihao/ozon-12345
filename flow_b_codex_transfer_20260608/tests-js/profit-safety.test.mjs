import test from "node:test";
import assert from "node:assert/strict";

import {
  assessProfitSafety,
  assessProfitSafetyGate,
} from "../scripts/flow_b_playwright/profit-safety.mjs";

const completePackage = Object.freeze({ weight: 500, length: 20, width: 15, height: 10 });

function completeProfitSafety(stressedProfit) {
  return {
    version: "profit-safety-v1-shadow",
    missing_evidence: [],
    stressed_profit: stressedProfit,
  };
}

function verifiedSelectedClusterCost(overrides = {}) {
  return {
    ok: true,
    cost: 28,
    same_item_match: true,
    returned_evidence_verified: true,
    match_evidence_contract: "1688-returned-same-item-v3",
    match_evidence_key: "e".repeat(64),
    selected_offer_id: "verified-offer",
    selected_cluster_prices: [28],
    ...overrides,
  };
}

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

test("zero-line gate compares stressed profit at CNY cent precision", () => {
  const cases = [
    { stressedProfit: -0.01, action: "REJECT", reason: "nonpositive_stressed_profit" },
    { stressedProfit: 0, action: "REJECT", reason: "nonpositive_stressed_profit" },
    { stressedProfit: 0.01, action: "ALLOW", reason: "positive_stressed_profit" },
  ];

  for (const expected of cases) {
    const gate = assessProfitSafetyGate({
      profitSafety: completeProfitSafety(expected.stressedProfit),
      cost: verifiedSelectedClusterCost(),
      policy: "shadow",
      directMode: true,
    });
    assert.deepEqual(gate, {
      version: "profit-safety-gate-v1",
      policy: "shadow",
      action: expected.action,
      evidence_complete: true,
      stressed_profit_cny: expected.stressedProfit,
      threshold_cny: 0,
      enforced: false,
      reasons: [expected.reason],
    });
  }
});

test("zero-line gate enforces only a direct enforce REJECT", () => {
  const input = {
    profitSafety: completeProfitSafety(-0.01),
    cost: verifiedSelectedClusterCost(),
  };

  assert.equal(assessProfitSafetyGate({ ...input, policy: "shadow", directMode: true }).enforced, false);
  const nonDirect = assessProfitSafetyGate({ ...input, policy: "enforce", directMode: false });
  assert.equal(nonDirect.action, null);
  assert.equal(nonDirect.evidence_complete, false);
  assert.equal(nonDirect.enforced, false);
  assert.equal(assessProfitSafetyGate({ ...input, policy: "enforce", directMode: true }).enforced, true);
  assert.equal(assessProfitSafetyGate({
    profitSafety: completeProfitSafety(0.01),
    cost: input.cost,
    policy: "enforce",
    directMode: true,
  }).enforced, false);
});

test("selected cost only needs to match its verified cluster at CNY cent precision", () => {
  const gate = assessProfitSafetyGate({
    profitSafety: completeProfitSafety(0.01),
    cost: verifiedSelectedClusterCost({
      cost: 28.004,
      selected_cluster_prices: [28.003],
    }),
    policy: "enforce",
    directMode: true,
  });

  assert.equal(gate.evidence_complete, true);
  assert.equal(gate.action, "ALLOW");
});

test("zero-line gate rejects invalid policies", () => {
  assert.throws(
    () => assessProfitSafetyGate({ policy: "balanced" }),
    { name: "TypeError", message: "profit safety gate policy must be shadow or enforce" },
  );
});

test("zero-line gate keeps incomplete or malformed evidence non-actionable", () => {
  const validProfitSafety = completeProfitSafety(-10);
  const validCost = verifiedSelectedClusterCost();
  const cases = [
    { profitSafety: { ...validProfitSafety, version: "profit-safety-v0" }, cost: validCost },
    { profitSafety: { ...validProfitSafety, missing_evidence: ["package_width"] }, cost: validCost },
    { profitSafety: { ...validProfitSafety, missing_evidence: undefined }, cost: validCost },
    { profitSafety: { ...validProfitSafety, stressed_profit: "-10" }, cost: validCost },
    { profitSafety: { ...validProfitSafety, stressed_profit: Number.NaN }, cost: validCost },
    { profitSafety: validProfitSafety, cost: { ...validCost, returned_evidence_verified: false } },
    { profitSafety: validProfitSafety, cost: { ...validCost, match_evidence_contract: "1688-returned-same-item-v2" } },
    { profitSafety: validProfitSafety, cost: { ...validCost, match_evidence_key: "invalid" } },
    { profitSafety: validProfitSafety, cost: { ...validCost, selected_offer_id: "" } },
    { profitSafety: validProfitSafety, cost: { ...validCost, selected_cluster_prices: [] } },
    { profitSafety: validProfitSafety, cost: { ...validCost, selected_cluster_prices: ["28"] } },
    { profitSafety: validProfitSafety, cost: { ...validCost, selected_cluster_prices: [0] } },
    { profitSafety: validProfitSafety, cost: { ...validCost, cost: 28.02, selected_cluster_prices: [28.01] } },
  ];

  for (const input of cases) {
    const gate = assessProfitSafetyGate({
      ...input,
      policy: "enforce",
      directMode: true,
    });
    assert.equal(gate.action, null);
    assert.equal(gate.evidence_complete, false);
    assert.equal(gate.enforced, false);
    assert.ok(gate.reasons.length > 0);
  }
});

test("zero-line gate never reads the unscoped cost price list", () => {
  const cost = verifiedSelectedClusterCost();
  Object.defineProperty(cost, "prices", {
    enumerable: true,
    get() { throw new Error("unscoped prices must not be read"); },
  });

  const gate = assessProfitSafetyGate({
    profitSafety: completeProfitSafety(-0.01),
    cost,
    policy: "shadow",
    directMode: true,
  });
  assert.equal(gate.action, "REJECT");
});

test("corrected selected cluster keeps the 2816413335-style outlier outside the gate", () => {
  const cost = verifiedSelectedClusterCost({
    cost: 28,
    selected_cluster_prices: [28],
    prices: [28, 54.7],
  });
  const profitSafety = assessProfitSafety({
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
    cost,
    packageEvidence: completePackage,
  });
  const gate = assessProfitSafetyGate({ profitSafety, cost, policy: "enforce", directMode: true });

  assert.ok(profitSafety.stressed_profit > 0);
  assert.equal(gate.action, "ALLOW");
  assert.equal(gate.enforced, false);
});

test("628351188-style zero-cent stress margin is a complete REJECT", () => {
  const cost = verifiedSelectedClusterCost({
    cost: 0.99,
    selected_cluster_prices: [0.89, 0.99],
    prices: [0.89, 0.99, 1.99],
  });
  const profitSafety = assessProfitSafety({
    profit: {
      sell_price: 11.95,
      purchase_price: 0.99,
      china_fee: 0,
      logi_fee: 5,
      cate_fee: 1.43,
      ad_fee: 0,
      other_fee: 0.12,
      wc_fee: 1.26,
      total_cost: 8.8,
      profit: 3.15,
      profit_rate: 35.8,
    },
    cost,
    packageEvidence: completePackage,
  });
  const gate = assessProfitSafetyGate({ profitSafety, cost, policy: "enforce", directMode: true });

  assert.equal(profitSafety.stressed_profit, 0);
  assert.equal(profitSafety.decision, "REVIEW");
  assert.equal(gate.action, "REJECT");
  assert.equal(gate.evidence_complete, true);
  assert.equal(gate.enforced, true);
});
