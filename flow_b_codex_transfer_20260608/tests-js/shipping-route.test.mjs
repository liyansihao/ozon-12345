import test from "node:test";
import assert from "node:assert/strict";

import {
  productWeightGrams,
  selectShippingRoute,
  URAL_WEIGHT_THRESHOLD_GRAMS,
} from "../scripts/flow_b_playwright/shipping-route.mjs";

const route = (weightGrams) => selectShippingRoute({
  weightGrams,
  postalWarehouseId: 101,
  uralWarehouseId: 202,
  thresholdGrams: URAL_WEIGHT_THRESHOLD_GRAMS,
  weightRouting: true,
});

test("weight routing sends up to 500g to postal and above 500g to Ural", () => {
  assert.deepEqual(route(499), {
    available: true,
    route: "postal",
    logistics: "CEL",
    warehouseId: 101,
    weightGrams: 499,
    thresholdGrams: 500,
  });
  assert.equal(route(500).route, "postal");
  assert.equal(route(500).warehouseId, 101);
  assert.equal(route(500).logistics, "CEL");
  assert.equal(route(501).route, "ural");
  assert.equal(route(501).warehouseId, 202);
  assert.equal(route(501).logistics, "Ural");
});

test("product weight prefers ERP category specifications and missing Ural fails closed", () => {
  assert.equal(productWeightGrams({ weight: 605 }, { weight: 200 }), 605);
  assert.equal(productWeightGrams({}, { weight: 200 }), 200);
  assert.equal(productWeightGrams({}, {}), 0);
  assert.deepEqual(selectShippingRoute({
    weightGrams: 605,
    postalWarehouseId: 101,
    thresholdGrams: 500,
    weightRouting: true,
  }), {
    available: false,
    route: "ural",
    logistics: "Ural",
    warehouseId: null,
    weightGrams: 605,
    thresholdGrams: 500,
  });
});
