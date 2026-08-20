const VERSION = "profit-safety-v1-shadow";
const GATE_VERSION = "profit-safety-gate-v1";
const GATE_POLICIES = new Set(["shadow", "enforce"]);

export const DEFAULT_PROFIT_SAFETY_POLICY = Object.freeze({
  purchase_buffer_rate: 0.05,
  logistics_buffer_rate: 0.05,
  minimum_logistics_buffer: 0.5,
  domestic_fee_floor: 1.5,
  packaging_fee_floor: 0.5,
  ad_reserve_rate: 0.01,
  return_reserve_rate: 0.02,
  fx_reserve_rate: 0.02,
  safe_profit_floor: 3,
  safe_margin_rate: 0.05,
});

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function nonNegative(value) {
  const numeric = finiteNumber(value);
  return numeric !== null && numeric >= 0 ? numeric : null;
}

function positive(value) {
  const numeric = finiteNumber(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function rounded(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function cnyCents(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const cents = Math.round(rounded(value, 2) * 100);
  return Object.is(cents, -0) ? 0 : cents;
}

/**
 * Pure action contract for the zero-line profit gate. The action describes
 * what complete evidence says; `enforced` separately controls production
 * behavior so shadow collection can never block a submission.
 */
export function assessProfitSafetyGate({
  profitSafety = {},
  cost = {},
  policy = "shadow",
  directMode = false,
} = {}) {
  const normalizedGatePolicy = String(policy).trim().toLowerCase();
  if (!GATE_POLICIES.has(normalizedGatePolicy)) {
    throw new TypeError("profit safety gate policy must be shadow or enforce");
  }

  const incompleteReasons = [];
  if (directMode !== true) {
    incompleteReasons.push("direct_mode_required");
  }
  if (profitSafety?.version !== VERSION) {
    incompleteReasons.push("profit_safety_version_invalid");
  }
  if (!Array.isArray(profitSafety?.missing_evidence)
    || profitSafety.missing_evidence.length !== 0) {
    incompleteReasons.push("profit_safety_evidence_incomplete");
  }

  const stressedProfitCents = cnyCents(profitSafety?.stressed_profit);
  if (stressedProfitCents === null) {
    incompleteReasons.push("stressed_profit_invalid");
  }

  const verifiedV3Cost = cost?.ok === true
    && cost?.same_item_match === true
    && cost?.returned_evidence_verified === true
    && cost?.match_evidence_contract === "1688-returned-same-item-v3"
    && /^[a-f0-9]{64}$/u.test(String(cost?.match_evidence_key || ""))
    && Boolean(String(cost?.selected_offer_id || "").trim());
  if (!verifiedV3Cost) incompleteReasons.push("cost_evidence_not_verified_v3");

  const selectedClusterPrices = cost?.selected_cluster_prices;
  const validSelectedCluster = Array.isArray(selectedClusterPrices)
    && selectedClusterPrices.length > 0
    && selectedClusterPrices.every((value) => (
      typeof value === "number" && Number.isFinite(value) && value > 0
    ));
  if (!validSelectedCluster) incompleteReasons.push("selected_cluster_prices_invalid");

  const selectedCostCents = cnyCents(cost?.cost);
  const positiveSelectedCost = selectedCostCents !== null && Number(cost.cost) > 0;
  if (!positiveSelectedCost) {
    incompleteReasons.push("selected_cost_invalid");
  } else if (validSelectedCluster && !selectedClusterPrices.some(
    (value) => cnyCents(value) === selectedCostCents,
  )) {
    incompleteReasons.push("selected_cost_not_in_cluster");
  }

  const evidenceComplete = incompleteReasons.length === 0;
  const action = evidenceComplete
    ? (stressedProfitCents <= 0 ? "REJECT" : "ALLOW")
    : null;
  const reasons = evidenceComplete
    ? [action === "REJECT" ? "nonpositive_stressed_profit" : "positive_stressed_profit"]
    : incompleteReasons;

  return {
    version: GATE_VERSION,
    policy: normalizedGatePolicy,
    action,
    evidence_complete: evidenceComplete,
    stressed_profit_cny: stressedProfitCents === null ? null : stressedProfitCents / 100,
    threshold_cny: 0,
    enforced: directMode === true && normalizedGatePolicy === "enforce" && action === "REJECT",
    reasons,
  };
}

function normalizedPolicy(overrides = {}) {
  const policy = { ...DEFAULT_PROFIT_SAFETY_POLICY };
  for (const key of Object.keys(policy)) {
    const value = nonNegative(overrides?.[key]);
    if (value !== null) policy[key] = value;
  }
  return policy;
}

function percentile(values, quantile) {
  const rows = values
    .map(positive)
    .filter((value) => value !== null)
    .sort((left, right) => left - right);
  if (rows.length === 0) return null;
  const index = Math.min(rows.length - 1, Math.max(0, Math.ceil(rows.length * quantile) - 1));
  return rows[index];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function materiallyDifferent(left, right, sellPrice = null) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const tolerance = Math.max(0.05, Number.isFinite(sellPrice) ? sellPrice * 0.002 : 0);
  return Math.abs(left - right) > tolerance;
}

function packageEvidenceMissing(packageEvidence = {}) {
  const missing = [];
  if (positive(packageEvidence.weight) === null) missing.push("package_weight");
  if (positive(packageEvidence.length) === null) missing.push("package_length");
  if (positive(packageEvidence.width) === null) missing.push("package_width");
  if (positive(packageEvidence.height) === null) missing.push("package_height");
  return missing;
}

function safetyScore(stressedMarginRate, missingCount, riskCount) {
  let score;
  if (stressedMarginRate === null) score = 45;
  else if (stressedMarginRate < 0) score = 20;
  else if (stressedMarginRate < 0.05) score = 55;
  else if (stressedMarginRate < 0.08) score = 70;
  else if (stressedMarginRate < 0.15) score = 82;
  else score = 92;
  return Math.max(0, Math.min(100, score - Math.min(24, missingCount * 6) - Math.min(12, riskCount * 3)));
}

/**
 * Conservative, local-only profit pressure test. It is intentionally advisory:
 * missing evidence routes to REVIEW, and this module never changes publish state.
 */
export function assessProfitSafety({
  profit = {},
  cost = {},
  packageEvidence = {},
  policy: policyOverrides = {},
} = {}) {
  const policy = normalizedPolicy(policyOverrides);
  const missingEvidence = packageEvidenceMissing(packageEvidence);
  const riskFlags = [];

  const sellPrice = positive(profit.sell_price);
  const purchasePrice = positive(profit.purchase_price ?? cost.cost);
  const chinaFee = nonNegative(profit.china_fee);
  const logisticsFee = nonNegative(profit.logi_fee);
  const categoryFee = nonNegative(profit.cate_fee);
  const adFee = nonNegative(profit.ad_fee);
  const otherFee = nonNegative(profit.other_fee);
  const wcFee = nonNegative(profit.wc_fee);

  if (sellPrice === null) missingEvidence.push("sell_price");
  if (purchasePrice === null) missingEvidence.push("purchase_price");
  if (logisticsFee === null) missingEvidence.push("logistics_fee");
  if (categoryFee === null) missingEvidence.push("category_fee");
  if (chinaFee === null) missingEvidence.push("china_fee");
  if (adFee === null) missingEvidence.push("ad_fee");
  if (otherFee === null) missingEvidence.push("other_fee");
  if (wcFee === null) missingEvidence.push("wc_fee");

  const componentValues = [purchasePrice, chinaFee, logisticsFee, categoryFee, adFee, otherFee, wcFee];
  const componentTotal = componentValues.every((value) => value !== null)
    ? componentValues.reduce((total, value) => total + value, 0)
    : null;
  const statedTotal = positive(profit.total_cost);
  if (statedTotal !== null && componentTotal !== null
    && materiallyDifferent(statedTotal, componentTotal, sellPrice)) {
    riskFlags.push("profit_component_inconsistent");
  }
  // Never let a stale or malformed stated total hide a larger sum of the
  // supplied components.  The shadow estimate deliberately takes the more
  // conservative complete value.
  const totalCost = statedTotal !== null && componentTotal !== null
    ? Math.max(statedTotal, componentTotal)
    : statedTotal ?? componentTotal;
  if (totalCost === null) missingEvidence.push("total_cost");

  const statedProfit = finiteNumber(profit.profit);
  const computedProfit = sellPrice !== null && totalCost !== null ? sellPrice - totalCost : null;
  if (statedProfit !== null && computedProfit !== null
    && materiallyDifferent(statedProfit, computedProfit, sellPrice)) {
    riskFlags.push("profit_total_inconsistent");
  }
  const baselineProfit = statedProfit !== null && computedProfit !== null
    ? Math.min(statedProfit, computedProfit)
    : statedProfit ?? computedProfit;
  if (baselineProfit === null) missingEvidence.push("profit");

  const selectedClusterPrices = Array.isArray(cost.selected_cluster_prices)
    ? cost.selected_cluster_prices.map(positive).filter((value) => value !== null)
    : [];
  const supplierPrices = selectedClusterPrices.length > 0
    ? selectedClusterPrices
    : (Array.isArray(cost.prices) ? cost.prices : []);
  const supplierP80 = percentile(supplierPrices, 0.8);
  if (supplierP80 === null) missingEvidence.push("supplier_price_range");
  const referencePurchase = purchasePrice === null
    ? supplierP80
    : Math.max(purchasePrice, supplierP80 ?? purchasePrice);
  if (purchasePrice !== null && supplierP80 !== null && supplierP80 > purchasePrice * 1.5) {
    riskFlags.push("supplier_price_dispersion");
  }
  if (chinaFee === 0) riskFlags.push("domestic_freight_not_priced");
  if (adFee === 0) riskFlags.push("ad_cost_not_priced");

  const reserves = {
    supplier_price_gap: referencePurchase !== null && purchasePrice !== null
      ? Math.max(0, referencePurchase - purchasePrice)
      : 0,
    purchase_buffer: referencePurchase !== null ? referencePurchase * policy.purchase_buffer_rate : 0,
    logistics_buffer: logisticsFee !== null
      ? Math.max(policy.minimum_logistics_buffer, logisticsFee * policy.logistics_buffer_rate)
      : 0,
    domestic_freight: chinaFee !== null ? Math.max(0, policy.domestic_fee_floor - chinaFee) : 0,
    packaging: policy.packaging_fee_floor,
    ad: sellPrice !== null && adFee !== null ? Math.max(0, sellPrice * policy.ad_reserve_rate - adFee) : 0,
    returns: sellPrice !== null ? sellPrice * policy.return_reserve_rate : 0,
    fx: sellPrice !== null ? sellPrice * policy.fx_reserve_rate : 0,
  };
  const reserveTotal = Object.values(reserves).reduce((total, value) => total + value, 0);
  const stressedProfit = baselineProfit === null ? null : baselineProfit - reserveTotal;
  const stressedMarginRate = stressedProfit !== null && sellPrice !== null
    ? stressedProfit / sellPrice
    : null;

  const missing = unique(missingEvidence);
  const risks = unique(riskFlags);
  const inconsistentProfit = risks.some((flag) => [
    "profit_component_inconsistent",
    "profit_total_inconsistent",
  ].includes(flag));
  let decision = "REVIEW";
  let reason = "missing-evidence";
  if (baselineProfit !== null && baselineProfit <= 0) {
    decision = "UNSAFE";
    reason = "baseline-loss";
  } else if (missing.length > 0) {
    decision = "REVIEW";
    reason = stressedProfit !== null && stressedProfit < 0
      ? "stress-loss-with-missing-evidence"
      : "missing-evidence";
  } else if (stressedProfit !== null && stressedProfit < 0) {
    decision = "UNSAFE";
    reason = "stress-loss";
  } else if (inconsistentProfit) {
    decision = "REVIEW";
    reason = "inconsistent-profit-components";
  } else if (stressedProfit !== null
    && sellPrice !== null
    && stressedProfit >= policy.safe_profit_floor
    && stressedMarginRate >= policy.safe_margin_rate) {
    decision = "SAFE";
    reason = "stress-margin-safe";
  } else {
    decision = "REVIEW";
    reason = "thin-stress-margin";
  }

  return {
    version: VERSION,
    mode: "shadow",
    decision,
    score: safetyScore(stressedMarginRate, missing.length, risks.length),
    reason,
    missing_evidence: missing,
    risk_flags: risks,
    baseline: {
      sell_price: rounded(sellPrice),
      purchase_price: rounded(purchasePrice),
      total_cost: rounded(totalCost),
      profit: rounded(baselineProfit),
      profit_rate: rounded(finiteNumber(profit.profit_rate)),
    },
    reserves: Object.fromEntries(Object.entries(reserves).map(([key, value]) => [key, rounded(value)])),
    reserve_total: rounded(reserveTotal),
    stressed_profit: rounded(stressedProfit),
    stressed_margin_rate: rounded(stressedMarginRate, 4),
    policy,
  };
}
