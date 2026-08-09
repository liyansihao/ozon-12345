export const URAL_WEIGHT_THRESHOLD_GRAMS = 500;

export function productWeightGrams(productInfo = {}, detail = {}) {
  const value = productInfo?.weight ?? detail?.weight ?? 0;
  const weight = Number(value);
  return Number.isFinite(weight) && weight >= 0 ? weight : 0;
}

export function selectShippingRoute({
  weightGrams,
  postalWarehouseId,
  uralWarehouseId = null,
  thresholdGrams = URAL_WEIGHT_THRESHOLD_GRAMS,
  weightRouting = false,
} = {}) {
  const weight = Number(weightGrams);
  const threshold = Number(thresholdGrams);
  const postalId = Number(postalWarehouseId);
  const uralId = Number(uralWarehouseId);
  if (!Number.isFinite(weight) || weight < 0) throw new TypeError("product weight must be a non-negative number");
  if (!(Number.isFinite(threshold) && threshold > 0)) throw new TypeError("weight threshold must be positive");
  if (!(postalId > 0)) throw new TypeError("postal warehouse ID must be positive");

  const heavy = Boolean(weightRouting) && weight > threshold;
  if (heavy && !(uralId > 0)) {
    return {
      available: false,
      route: "ural",
      logistics: "Ural",
      warehouseId: null,
      weightGrams: weight,
      thresholdGrams: threshold,
    };
  }
  return {
    available: true,
    route: heavy ? "ural" : "postal",
    logistics: heavy ? "Ural" : "CEL",
    warehouseId: heavy ? uralId : postalId,
    weightGrams: weight,
    thresholdGrams: threshold,
  };
}
