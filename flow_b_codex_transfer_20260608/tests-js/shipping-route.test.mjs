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

test("weight routing sends up to 400g to postal and above 400g to Ural", () => {
  assert.deepEqual(route(399), {
    available: true,
    route: "postal",
    logistics: "CEL",
    warehouseId: 101,
    weightGrams: 399,
    thresholdGrams: 400,
    routeReason: "postal-default",
  });
  assert.equal(route(400).route, "postal");
  assert.equal(route(400).warehouseId, 101);
  assert.equal(route(400).logistics, "CEL");
  assert.equal(route(401).route, "ural");
  assert.equal(route(401).warehouseId, 202);
  assert.equal(route(401).logistics, "Ural");
  assert.equal(route(401).routeReason, "weight-threshold");
});

test("the 400g rule applies uniformly, including building-block categories", () => {
  assert.deepEqual(selectShippingRoute({
    weightGrams: 400,
    postalWarehouseId: 101,
    uralWarehouseId: 202,
    thresholdGrams: 400,
    weightRouting: true,
  }), {
    available: true,
    route: "postal",
    logistics: "CEL",
    warehouseId: 101,
    weightGrams: 400,
    thresholdGrams: 400,
    routeReason: "postal-default",
  });
});

test("product weight prefers ERP category specifications and missing Ural fails closed", () => {
  assert.equal(productWeightGrams({ weight: 605 }, { weight: 200 }), 605);
  assert.equal(productWeightGrams({}, { weight: 200 }), 200);
  assert.equal(productWeightGrams({}, {}), 0);
  assert.deepEqual(selectShippingRoute({
    weightGrams: 605,
    postalWarehouseId: 101,
    thresholdGrams: 400,
    weightRouting: true,
  }), {
    available: false,
    route: "ural",
    logistics: "Ural",
    warehouseId: null,
    weightGrams: 605,
    thresholdGrams: 400,
    routeReason: "weight-threshold",
  });
});
