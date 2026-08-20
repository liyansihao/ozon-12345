import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySupplyFailure,
  latestPhysicalValidationEventsFromText,
} from "../scripts/postprocess_exact100_supply_only.mjs";

test("supply-only postprocess keeps the physical last validation event per exact SKU", () => {
  const text = [
    JSON.stringify({ sku: "1", status: "rejected", reason: "1688-supply-moq" }),
    JSON.stringify({ sku: "2", status: "deferred", reason: "1688-supply-timeout" }),
    JSON.stringify({ sku: "1", status: "deferred", reason: "1688-supply-moq" }),
    "",
  ].join("\n");
  const merged = latestPhysicalValidationEventsFromText(text, ["1", "2"]);
  assert.equal(merged.latest.size, 2);
  assert.equal(merged.latest.get("1").physical_line, 3);
  assert.equal(merged.latest.get("1").event.status, "deferred");
  assert.deepEqual(merged.unexpected, []);
  assert.deepEqual(merged.malformed, []);
});

test("supply-only postprocess reports unexpected and malformed physical rows", () => {
  const merged = latestPhysicalValidationEventsFromText([
    JSON.stringify({ sku: "outside", status: "deferred" }),
    "{broken",
    "",
  ].join("\n"), ["inside"]);
  assert.deepEqual(merged.unexpected, [{ sku: "outside", line: 1 }]);
  assert.equal(merged.malformed[0].line, 2);
});

test("supply-only failure classification separates deterministic and transient reasons", () => {
  assert.equal(classifySupplyFailure({ reason: "1688-supply-moq" }).classification, "deterministic");
  assert.equal(classifySupplyFailure({ reason: "1688-supply-no-strict-same-item" }).classification, "deterministic");
  assert.equal(classifySupplyFailure({ reason: "1688-supply-timeout" }).classification, "transient");
  assert.equal(classifySupplyFailure({ reason: "1688-supply-captcha" }).classification, "transient");
  assert.equal(classifySupplyFailure({ reason: "unknown-new-failure" }).classification, "transient");
  assert.equal(classifySupplyFailure({
    reason: "1688-supply-moq",
    failure_class: "transient",
  }).classification, "deterministic");
  assert.equal(classifySupplyFailure({
    reason: "new-reason",
    failure_class: "transient",
  }).classification, "transient");
});
