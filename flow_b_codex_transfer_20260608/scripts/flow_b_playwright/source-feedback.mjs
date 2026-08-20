export const INVALIDATED_SOURCE_FEEDBACK_SKUS = Object.freeze([
  "2815247918",
  "2747636284",
  "1076490713",
  "1218765294",
  "2995060039",
]);

const invalidatedSkuSet = new Set(INVALIDATED_SOURCE_FEEDBACK_SKUS);

export function sourceFeedbackValue(row = {}) {
  return row?.data && typeof row.data === "object" && !Array.isArray(row.data)
    ? { ...row.data, ...row }
    : row;
}

export function sourceFeedbackSku(row = {}) {
  const value = sourceFeedbackValue(row);
  return String(value?.sku || value?.id || "").trim();
}

export function isInvalidatedSourceFeedbackRow(row = {}) {
  const value = sourceFeedbackValue(row);
  const sku = sourceFeedbackSku(value);
  return invalidatedSkuSet.has(sku)
    || value?.source_feedback_invalidated === true
    || value?.policy_eligible === false;
}

export function isStrictProductiveSourceOutcome(row = {}) {
  const value = sourceFeedbackValue(row);
  const sourceUrl = String(value?.source_url || "").trim();
  const shippingMode = String(
    value?.shipping_mode || value?.preflight_mode || value?.mode || "",
  ).toUpperCase();
  return Boolean(sourceUrl)
    && Boolean(sourceFeedbackSku(value))
    && !isInvalidatedSourceFeedbackRow(value)
    && String(value?.status || "").toLowerCase() === "published"
    && value?.strict_confirmed === true
    && String(value?.online_status || "").toLowerCase() === "selling"
    && Number(value?.stock) > 0
    && Number(value?.profit_rate) > 30
    && shippingMode === "FBS";
}

export function isRawSourceAcceptance(row = {}) {
  const value = sourceFeedbackValue(row);
  const status = String(value?.status || "").toLowerCase();
  const stage = String(value?.stage || value?.funnel_stage || "").toLowerCase();
  return ["submitted", "published"].includes(status)
    || stage === "erp_accepted"
    || value?.erp_accepted === true;
}
