export const AUDITED_STANDALONE_VALIDATION_ENV_PREFIXES = Object.freeze([
  "FLOW_B_AUDITED_DISCOVERY_",
  "FLOW_B_AUDITED_SEED_",
  "FLOW_B_AUDITED_DERIVED_",
  "FLOW_B_AUDITED_CAPACITY_",
]);

export function isAuditedStandaloneValidationEnvironmentName(name) {
  const normalized = String(name || "");
  return AUDITED_STANDALONE_VALIDATION_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function stripAuditedStandaloneValidationEnvironment(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("production worker environment must be an object");
  }
  for (const name of Object.keys(environment)) {
    if (isAuditedStandaloneValidationEnvironmentName(name)) delete environment[name];
  }
  return environment;
}

export function assertNoAuditedStandaloneValidationConfig(flowEnvironment) {
  if (!flowEnvironment || typeof flowEnvironment !== "object" || Array.isArray(flowEnvironment)) return;
  const forbidden = Object.keys(flowEnvironment)
    .filter(isAuditedStandaloneValidationEnvironmentName)
    .sort();
  if (forbidden.length > 0) {
    throw new Error(`production config cannot contain standalone audited validation keys: ${forbidden.join(",")}`);
  }
}
