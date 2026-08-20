import assert from "node:assert/strict";
import test from "node:test";

import { validationSupplyOnlyFromEnv } from "../scripts/flow_b_playwright/validation-supply-only.mjs";

const valid = Object.freeze({
  FLOW_B_VALIDATION_SUPPLY_ONLY: "1",
  FLOW_B_VALIDATION_ONLY: "1",
  FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE: "1",
  FLOW_B_VALIDATION_CANDIDATE_FILE: "/tmp/candidates.json",
  FLOW_B_SUPPLY_GATE_POLICY: "enforce",
});

test("validation supply-only accepts only the strict snapshot candidate scope", () => {
  assert.equal(validationSupplyOnlyFromEnv(valid), true);
  assert.equal(validationSupplyOnlyFromEnv({}), false);
  assert.equal(validationSupplyOnlyFromEnv({ FLOW_B_VALIDATION_SUPPLY_ONLY: "0" }), false);
  assert.throws(
    () => validationSupplyOnlyFromEnv({ ...valid, FLOW_B_VALIDATION_ONLY: "0" }),
    /requires FLOW_B_VALIDATION_ONLY=1/u,
  );
  assert.throws(
    () => validationSupplyOnlyFromEnv({ ...valid, FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE: "0" }),
    /requires FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE=1/u,
  );
  assert.throws(
    () => validationSupplyOnlyFromEnv({ ...valid, FLOW_B_VALIDATION_CANDIDATE_FILE: "" }),
    /requires FLOW_B_VALIDATION_CANDIDATE_FILE/u,
  );
  assert.throws(
    () => validationSupplyOnlyFromEnv({ ...valid, FLOW_B_SUPPLY_GATE_POLICY: "shadow" }),
    /requires FLOW_B_SUPPLY_GATE_POLICY=enforce/u,
  );
  assert.throws(
    () => validationSupplyOnlyFromEnv({ ...valid, FLOW_B_VALIDATION_SUPPLY_ONLY: "true" }),
    /must be 0 or 1/u,
  );
});
