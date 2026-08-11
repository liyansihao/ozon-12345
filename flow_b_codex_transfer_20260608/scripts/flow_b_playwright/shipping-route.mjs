export const URAL_WEIGHT_THRESHOLD_GRAMS = 500;

const BUILDING_BLOCK_CATEGORY_PATTERN = /积木|拼装积木|building\s*blocks?|construction\s*sets?|конструктор/iu;

export function isBuildingBlockCategory(labels = []) {
  return (Array.isArray(labels) ? labels : [labels])
    .some((label) => BUILDING_BLOCK_CATEGORY_PATTERN.test(String(label || "").trim()));
}

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
  forceUral = false,
} = {}) {
  const weight = Number(weightGrams);
  const threshold = Number(thresholdGrams);
  const postalId = Number(postalWarehouseId);
  const uralId = Number(uralWarehouseId);
  if (!Number.isFinite(weight) || weight < 0) throw new TypeError("product weight must be a non-negative number");
  if (!(Number.isFinite(threshold) && threshold > 0)) throw new TypeError("weight threshold must be positive");
  if (!(postalId > 0)) throw new TypeError("postal warehouse ID must be positive");

  const forced = Boolean(forceUral);
  const heavy = Boolean(weightRouting) && weight > threshold;
  const useUral = forced || heavy;
  const routeReason = forced
    ? "building-block-category"
    : (heavy ? "weight-threshold" : "postal-default");
  if (useUral && !(uralId > 0)) {
    return {
      available: false,
      route: "ural",
      logistics: "Ural",
      warehouseId: null,
      weightGrams: weight,
      thresholdGrams: threshold,
      routeReason,
    };
  }
  return {
    available: true,
    route: useUral ? "ural" : "postal",
    logistics: useUral ? "Ural" : "CEL",
    warehouseId: useUral ? uralId : postalId,
    weightGrams: weight,
    thresholdGrams: threshold,
    routeReason,
  };
}
