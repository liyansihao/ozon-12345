export const VALIDATION_SUPPLY_ONLY_ENV = "FLOW_B_VALIDATION_SUPPLY_ONLY";

function scopeError(message) {
  return new Error(`${VALIDATION_SUPPLY_ONLY_ENV}=1 ${message}`);
}

export function validationSupplyOnlyFromEnv(env = {}) {
  const configured = String(env?.[VALIDATION_SUPPLY_ONLY_ENV] || "").trim();
  if (!configured || configured === "0") return false;
  if (configured !== "1") {
    throw new Error(`${VALIDATION_SUPPLY_ONLY_ENV} must be 0 or 1`);
  }
  if (env.FLOW_B_VALIDATION_ONLY !== "1") {
    throw scopeError("requires FLOW_B_VALIDATION_ONLY=1");
  }
  if (env.FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE !== "1") {
    throw scopeError("requires FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE=1");
  }
  if (!String(env.FLOW_B_VALIDATION_CANDIDATE_FILE || "").trim()) {
    throw scopeError("requires FLOW_B_VALIDATION_CANDIDATE_FILE");
  }
  const supplyGatePolicy = String(env.FLOW_B_SUPPLY_GATE_POLICY || "enforce")
    .trim()
    .toLowerCase();
  if (supplyGatePolicy !== "enforce") {
    throw scopeError("requires FLOW_B_SUPPLY_GATE_POLICY=enforce");
  }
  return true;
}
