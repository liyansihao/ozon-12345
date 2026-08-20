#!/usr/bin/env node

import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  DEFAULT_AUDITED_CANDIDATE_MINIMUM,
  DEFAULT_AUDITED_DISCOVERY_TARGET,
  createAuditedLiveDetailAccessAdapter,
  createPlaywrightAuditedLiveDetailFetcher,
  createPlaywrightAuditedSourceScanAdapter,
  enrichAuditedDiscoveryCampaign,
  isAuditedManualAttentionError,
  runAuditedValidationDiscovery,
} from "./flow_b_playwright/audited-validation-discovery.mjs";
import {
  buildAuditedValidationSourcePolicy,
  loadAuditedSourceArtifact,
} from "./flow_b_playwright/audited-source-portfolio.mjs";
import { launchFlowContext, resolveBrowserOptions } from "./flow_b_playwright/browser-context.mjs";
import { ozonAccessControllerFor } from "./flow_b_playwright/ozon-access-controller.mjs";
import { scanSourceWithPage } from "./flow_b_playwright/source-scanner.mjs";

const execFileAsync = promisify(execFile);

export const AUDITED_VALIDATION_PROFILE = "/Users/mac/.ozon-audited-validation/state/profile-playwright-151-v1";
export const AUDITED_VALIDATION_ROOT = "/Users/mac/.ozon-audited-validation";
export const AUDITED_VALIDATION_CAMPAIGNS_ROOT = "/Users/mac/.ozon-audited-validation/campaigns";
export const AUDITED_VALIDATION_DEBUG_PORT = 9224;
export const PRODUCTION_PROFILE = "/Users/mac/.ozon-24h-production/state/profiles/production-playwright-151-v1";
export const PRODUCTION_DEBUG_PORT = 9223;
export const AUDITED_VALIDATION_OWNER_LOCK = "/Users/mac/.ozon-audited-validation/state/locks/browser-owner.json";
export const AUDITED_EXTENSION_DIR = "/Users/mac/Downloads/maozi-plugin-3.0.9/maozi-plugin-3.0.9";
export const AUDITED_EXTENSION_TREE_SHA256 = "d70848af6a2f78c03552cf4f2bfb5e6e1a90ae4dabadcdecb012b425da765e98";
export const AUDITED_EXTENSION_ID = "kifocjelffhjimimdnjohjldolickjaa";
export const AUDITED_BROWSER_EXECUTABLE = "/Users/mac/.ozon-24h-production/browser/playwright-1.62.0/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
export const AUDITED_BROWSER_VERSION = "Google Chrome for Testing 151.0.7922.34";
export const AUDITED_DNR_FIRST_RULE_ID = 19_300;
export const AUDITED_DNR_LOCKDOWN_RULE_ID = 19_299;
export const AUDITED_BOOTSTRAP_HOST_RESOLVER_RULES = "MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1";
export const AUDITED_SKU3_PROBE_SKU = "1279848485";

export const AUDITED_MUTATION_ENDPOINTS = Object.freeze([
  "/api.chrome/check_data",
  "/api.chrome/collect",
  "/api.chrome/wb_sales",
  "/api.product.favorite/toggle",
  "/api.product.online/batch_update_stock",
  "/api.product.online/sync_shop",
  "/api.selection.follow/edit",
  "/api.selection.follow/import",
  "/api.selection.plugin/add_rule",
  "/api.selection.plugin/delete_rule",
  "/api.selection.plugin/toggle_rule",
  "/api.shop/set_cookies",
  "/api.shop/sync_warehouse",
  "/api.source.ali1688/collect",
  "/api.wb.collect/direct_to_draft",
  "/api.wb.collect/publish_direct",
]);

const smokeProbe = (
  probeId,
  coverage,
  requestedScheme,
  hostname,
  pathname,
  expectedKind,
) => Object.freeze({
  probe_id: probeId,
  coverage,
  requested_scheme: requestedScheme,
  allow_http_to_https: false,
  hostname,
  pathname,
  expected_kind: expectedKind,
});

// This is a fixed, non-secret descriptor catalog.  Probe identity is carried in
// the query string at runtime, but neither that per-run nonce nor a rendered URL
// is ever returned as failure evidence.  Keep IDs explicit so a descriptor
// change is reviewable and changes the pinned SHA below.
export const AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG = Object.freeze([
  smokeProbe("p00", "mutation", "https", "api.maozierp.com", "/api.chrome/check_data", "analytics-upload"),
  smokeProbe("p01", "mutation", "https", "api.maozierp.com", "/api.chrome/collect", "collect"),
  smokeProbe("p02", "mutation", "https", "api.maozierp.com", "/api.chrome/wb_sales", "analytics-upload"),
  smokeProbe("p03", "mutation", "https", "api.maozierp.com", "/api.product.favorite/toggle", "favorite"),
  smokeProbe("p04", "mutation", "https", "api.maozierp.com", "/api.product.online/batch_update_stock", "publish"),
  smokeProbe("p05", "mutation", "https", "api.maozierp.com", "/api.product.online/sync_shop", "publish"),
  smokeProbe("p06", "mutation", "https", "api.maozierp.com", "/api.selection.follow/edit", "edit"),
  smokeProbe("p07", "mutation", "https", "api.maozierp.com", "/api.selection.follow/import", "import"),
  smokeProbe("p08", "mutation", "https", "api.maozierp.com", "/api.selection.plugin/add_rule", "edit"),
  smokeProbe("p09", "mutation", "https", "api.maozierp.com", "/api.selection.plugin/delete_rule", "edit"),
  smokeProbe("p10", "mutation", "https", "api.maozierp.com", "/api.selection.plugin/toggle_rule", "edit"),
  smokeProbe("p11", "mutation", "https", "api.maozierp.com", "/api.shop/set_cookies", "edit"),
  smokeProbe("p12", "mutation", "https", "api.maozierp.com", "/api.shop/sync_warehouse", "edit"),
  smokeProbe("p13", "mutation", "https", "api.maozierp.com", "/api.source.ali1688/collect", "collect"),
  smokeProbe("p14", "mutation", "https", "api.maozierp.com", "/api.wb.collect/direct_to_draft", "import"),
  smokeProbe("p15", "mutation", "https", "api.maozierp.com", "/api.wb.collect/publish_direct", "publish"),
  smokeProbe("p16", "mutation", "http", "api.maozierp.com", "/api.chrome/check_data", "analytics-upload"),
  smokeProbe("p17", "mutation", "http", "api.maozierp.com", "/api.chrome/collect", "collect"),
  smokeProbe("p18", "mutation", "http", "api.maozierp.com", "/api.chrome/wb_sales", "analytics-upload"),
  smokeProbe("p19", "mutation", "http", "api.maozierp.com", "/api.product.favorite/toggle", "favorite"),
  smokeProbe("p20", "mutation", "http", "api.maozierp.com", "/api.product.online/batch_update_stock", "publish"),
  smokeProbe("p21", "mutation", "http", "api.maozierp.com", "/api.product.online/sync_shop", "publish"),
  smokeProbe("p22", "mutation", "http", "api.maozierp.com", "/api.selection.follow/edit", "edit"),
  smokeProbe("p23", "mutation", "http", "api.maozierp.com", "/api.selection.follow/import", "import"),
  smokeProbe("p24", "mutation", "http", "api.maozierp.com", "/api.selection.plugin/add_rule", "edit"),
  smokeProbe("p25", "mutation", "http", "api.maozierp.com", "/api.selection.plugin/delete_rule", "edit"),
  smokeProbe("p26", "mutation", "http", "api.maozierp.com", "/api.selection.plugin/toggle_rule", "edit"),
  smokeProbe("p27", "mutation", "http", "api.maozierp.com", "/api.shop/set_cookies", "edit"),
  smokeProbe("p28", "mutation", "http", "api.maozierp.com", "/api.shop/sync_warehouse", "edit"),
  smokeProbe("p29", "mutation", "http", "api.maozierp.com", "/api.source.ali1688/collect", "collect"),
  smokeProbe("p30", "mutation", "http", "api.maozierp.com", "/api.wb.collect/direct_to_draft", "import"),
  smokeProbe("p31", "mutation", "http", "api.maozierp.com", "/api.wb.collect/publish_direct", "publish"),
  smokeProbe("p32", "ambiguous", "https", "api.maozierp.com", "//api.product.favorite/toggle", "unknown-maozi-api"),
  smokeProbe("p33", "ambiguous", "https", "api.maozierp.com", "/%2Fapi.product.favorite%2Ftoggle", "unknown-maozi-api"),
  smokeProbe("p34", "ambiguous", "https", "api.maozierp.com", "/api%2Eproduct.favorite%2Ftoggle", "unknown-maozi-api"),
  smokeProbe("p35", "ambiguous", "https", "maozierp.com", "/api.product.favorite/toggle", "unknown-maozi-host"),
  smokeProbe("p36", "ambiguous", "https", "sidecar.maozierp.com", "/api.product.favorite/toggle", "unknown-maozi-host"),
  smokeProbe("p37", "ambiguous", "http", "sidecar.maozierp.com", "/api.product.favorite/toggle", "unknown-maozi-host"),
]);

export const AUDITED_WEB_REQUEST_SMOKE_DRAIN_TIMEOUT_MS = 750;
export const AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG_SHA256 = "24350dfccfb073caa20bf61f73384e0f13b0458a51a27a8192b1c18267bd319e";
const computedSmokeProbeCatalogSha256 = crypto
  .createHash("sha256")
  .update(JSON.stringify(AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG))
  .digest("hex");
if (computedSmokeProbeCatalogSha256 !== AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG_SHA256) {
  throw new Error("audited webRequest smoke probe catalog descriptor digest mismatch");
}

export const AUDITED_MAOZI_API_ALLOWLIST = Object.freeze([
  Object.freeze({ path: "/api.chrome/check_login", methods: Object.freeze(["POST"]) }),
  Object.freeze({ path: "/api.chrome/check_update", methods: Object.freeze(["POST"]) }),
  Object.freeze({ path: "/api.chrome/sku3", methods: Object.freeze(["POST"]) }),
  Object.freeze({ path: "/api.exchange_rate/index", methods: Object.freeze(["POST"]) }),
]);

export const AUDITED_EXTERNAL_MUTATION_RULES = Object.freeze([
  Object.freeze({
    hostname: "seller.ozon.ru",
    path: "/api/site/seller-prototype/create-bundle-by-variant-id",
    methods: Object.freeze(["POST"]),
  }),
]);

export const AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES = Object.freeze({
  BOOTSTRAP_DNR_STATE_MISSING: "extension_preflight_bootstrap_dnr_state_missing",
  PRODUCT_RULES_JSON_INVALID: "extension_preflight_product_rules_json_invalid",
  TOKEN_MISSING: "extension_preflight_token_missing",
  READ_API_TRANSPORT_FAILURE: "extension_preflight_read_api_transport_failure",
  DNR_RULESET_MISMATCH: "extension_preflight_dnr_ruleset_mismatch",
  DNR_OVERRIDE_CONFLICT: "extension_preflight_dnr_override_conflict",
  CHECK_DATA_SMOKE_ESCAPE: "extension_preflight_check_data_smoke_escape",
  MUTATION_SMOKE_ESCAPE: "extension_preflight_mutation_smoke_escape",
  HTTP_SMOKE_ESCAPE: "extension_preflight_http_smoke_escape",
  AMBIGUOUS_PATH_SMOKE_ESCAPE: "extension_preflight_ambiguous_path_smoke_escape",
  WEB_REQUEST_OBSERVER_LOST: "extension_audit_web_request_observer_lost",
  WEB_REQUEST_SMOKE_INCOMPLETE: "extension_audit_web_request_smoke_incomplete",
  SKU3_READ_FAILURE: "extension_preflight_sku3_read_failure",
  EXCHANGE_RATE_READ_FAILURE: "extension_preflight_exchange_rate_read_failure",
  AUTO_FAVORITE_ENABLED: "extension_preflight_auto_favorite_enabled",
  UNKNOWN: "extension_preflight_unknown",
});

const AUDITED_EXTENSION_PREFLIGHT_FAILURE_METADATA = Object.freeze({
  [AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.BOOTSTRAP_DNR_STATE_MISSING]: Object.freeze({
    preflight_step: "bootstrap_dnr_recheck",
    message: "persisted bootstrap lockdown DNR state is missing or not exact",
  }),
  [AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.PRODUCT_RULES_JSON_INVALID]: Object.freeze({
    preflight_step: "extension_storage",
    message: "productSelectionRules is not valid JSON",
  }),
  [AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.TOKEN_MISSING]: Object.freeze({
    preflight_step: "extension_storage",
    message: "Maozi token is missing",
  }),
  [AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.READ_API_TRANSPORT_FAILURE]: Object.freeze({
    preflight_step: "read_api_transport",
    message: "audited read API transport failed",
  }),
  [AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.DNR_RULESET_MISMATCH]: Object.freeze({
    preflight_step: "dnr_exact_recheck",
    message: "Maozi default-deny DNR rule set is missing or changed",
  }),
  [AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.DNR_OVERRIDE_CONFLICT]: Object.freeze({
    preflight_step: "dnr_exact_recheck",
    message: "dynamic/session DNR rules are not exactly the audited set plus pinned safe rule 9001",
  }),
  [AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.CHECK_DATA_SMOKE_ESCAPE]: Object.freeze({
    preflight_step: "check_data_smoke",
    message: "exact check_data service-worker network smoke escaped DNR",
  }),
  [AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.MUTATION_SMOKE_ESCAPE]: Object.freeze({
    preflight_step: "mutation_smoke",
    message: "one or more protected Maozi mutation paths escaped DNR smoke coverage",
  }),
  [AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.HTTP_SMOKE_ESCAPE]: Object.freeze({
    preflight_step: "http_smoke",
    message: "HTTP Maozi mutation path escaped the full-host DNR default deny",
  }),
  [AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.AMBIGUOUS_PATH_SMOKE_ESCAPE]: Object.freeze({
    preflight_step: "ambiguous_path_smoke",
    message: "ambiguous Maozi path escaped the full-host DNR default deny",
  }),
  [AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST]: Object.freeze({
    preflight_step: "web_request_observer_continuity",
    message: "extension webRequest audit observer continuity was lost",
  }),
  [AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_SMOKE_INCOMPLETE]: Object.freeze({
    preflight_step: "web_request_smoke_keys",
    message: "extension webRequest audit did not observe every DNR-blocked smoke key",
  }),
  [AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.SKU3_READ_FAILURE]: Object.freeze({
    preflight_step: "sku3_read",
    message: "allowlisted sku3 POST read smoke did not succeed",
  }),
  [AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.EXCHANGE_RATE_READ_FAILURE]: Object.freeze({
    preflight_step: "exchange_rate_read",
    message: "current Maozi RUB/CNY exchange-rate API did not succeed",
  }),
  [AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.AUTO_FAVORITE_ENABLED]: Object.freeze({
    preflight_step: "auto_favorite_guard",
    message: "productSelectionRules enables auto_favorite",
  }),
  [AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.UNKNOWN]: Object.freeze({
    preflight_step: "extension_preflight",
    message: "extension preflight failed for an unclassified reason",
  }),
});

function cliError(message) {
  return new Error(`audited validation CLI: ${message}`);
}

function codedCliError(code, message) {
  const error = cliError(message);
  error.code = code;
  return error;
}

function sanitizedWebRequestSmokeEvidence(value) {
  const source = value?.webRequestSmokeDiagnostics
    || value?.web_request_smoke_evidence
    || value;
  if (!source || typeof source !== "object") return null;
  const catalogSha256 = String(
    source.smokeProbeCatalogSha256 ?? source.smoke_probe_catalog_sha256 ?? "",
  );
  const expectedCount = Number(
    source.smokeProbeExpectedCount ?? source.smoke_probe_expected_count,
  );
  const observedCount = Number(
    source.smokeProbeObservedCount ?? source.smoke_probe_observed_count,
  );
  const duplicateRequestCount = Number(
    source.smokeProbeDuplicateRequestCount ?? source.smoke_probe_duplicate_request_count,
  );
  const drainElapsedMs = Number(
    source.smokeProbeDrainElapsedMs ?? source.smoke_probe_drain_elapsed_ms,
  );
  const drainTimedOut = source.smokeProbeDrainTimedOut ?? source.smoke_probe_drain_timed_out;
  const missingSource = source.smokeProbeMissing ?? source.smoke_probe_missing;
  const schemeSource = source.smokeProbeSchemeCounts ?? source.smoke_probe_scheme_counts;
  const catalogById = new Map(AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG.map((row) => [row.probe_id, row]));
  if (catalogSha256 !== AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG_SHA256
    || expectedCount !== AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG.length
    || !Number.isInteger(observedCount) || observedCount < 0 || observedCount > expectedCount
    || !Number.isInteger(duplicateRequestCount) || duplicateRequestCount < 0
    || duplicateRequestCount > 1_000_000
    || !Number.isInteger(drainElapsedMs) || drainElapsedMs < 0 || drainElapsedMs > 1_000
    || typeof drainTimedOut !== "boolean"
    || !Array.isArray(missingSource)
    || missingSource.length !== expectedCount - observedCount
    || !schemeSource || typeof schemeSource !== "object") return null;
  const missing = [];
  const seenIds = new Set();
  for (const input of missingSource) {
    const probeId = String(input?.probe_id || "");
    const descriptor = catalogById.get(probeId);
    const observedSchemes = Array.isArray(input?.observed_schemes)
      ? [...new Set(input.observed_schemes.map(String))].sort()
      : null;
    if (!descriptor || seenIds.has(probeId) || !observedSchemes
      || observedSchemes.some((scheme) => scheme !== "http" && scheme !== "https")) return null;
    seenIds.add(probeId);
    missing.push(Object.freeze({
      probe_id: descriptor.probe_id,
      kind: descriptor.expected_kind,
      requested_scheme: descriptor.requested_scheme,
      observed_schemes: Object.freeze(observedSchemes),
    }));
  }
  const requestedHttp = Number(schemeSource.requested_http);
  const requestedHttps = Number(schemeSource.requested_https);
  const observedHttp = Number(schemeSource.observed_http);
  const observedHttps = Number(schemeSource.observed_https);
  const httpToHttps = Number(schemeSource.http_to_https);
  if (requestedHttp !== 17 || requestedHttps !== 21
    || !Number.isInteger(observedHttp) || observedHttp < 0 || observedHttp > expectedCount
    || !Number.isInteger(observedHttps) || observedHttps < 0 || observedHttps > expectedCount
    || !Number.isInteger(httpToHttps) || httpToHttps < 0 || httpToHttps > requestedHttp
    || (missing.length > 0) !== drainTimedOut) return null;
  return Object.freeze({
    smoke_probe_catalog_sha256: catalogSha256,
    smoke_probe_expected_count: expectedCount,
    smoke_probe_observed_count: observedCount,
    smoke_probe_missing: Object.freeze(missing),
    smoke_probe_scheme_counts: Object.freeze({
      requested_http: requestedHttp,
      requested_https: requestedHttps,
      observed_http: observedHttp,
      observed_https: observedHttps,
      http_to_https: httpToHttps,
    }),
    smoke_probe_duplicate_request_count: duplicateRequestCount,
    smoke_probe_drain_elapsed_ms: drainElapsedMs,
    smoke_probe_drain_timed_out: drainTimedOut,
  });
}

function extensionPreflightError(
  failureCode,
  requestedStep = null,
  auditPhase = "preflight",
  smokeEvidence = null,
) {
  const metadata = AUDITED_EXTENSION_PREFLIGHT_FAILURE_METADATA[failureCode]
    || AUDITED_EXTENSION_PREFLIGHT_FAILURE_METADATA[AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.UNKNOWN];
  const safeTransportSteps = new Set(["exchange_rate_transport", "sku3_transport"]);
  const error = cliError(metadata.message);
  const normalizedCode = Object.hasOwn(AUDITED_EXTENSION_PREFLIGHT_FAILURE_METADATA, failureCode)
    ? failureCode
    : AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.UNKNOWN;
  error.code = normalizedCode;
  error.failure_code = normalizedCode;
  error.audit_phase = auditPhase === "postflight" ? "postflight" : "preflight";
  error.preflight_step = normalizedCode === AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.READ_API_TRANSPORT_FAILURE
      && safeTransportSteps.has(requestedStep)
    ? requestedStep
    : metadata.preflight_step;
  const safeSmokeEvidence = sanitizedWebRequestSmokeEvidence(smokeEvidence);
  if (safeSmokeEvidence) Object.assign(error, safeSmokeEvidence);
  return error;
}

export function auditedExtensionPreflightFailureEvidence(error, fallbackPhase = "preflight") {
  const requested = String(error?.failure_code || "");
  const failureCode = Object.hasOwn(AUDITED_EXTENSION_PREFLIGHT_FAILURE_METADATA, requested)
    ? requested
    : AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.UNKNOWN;
  const safeTransportSteps = new Set(["exchange_rate_transport", "sku3_transport"]);
  const base = {
    failure_code: failureCode,
    preflight_step: failureCode === AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.READ_API_TRANSPORT_FAILURE
        && safeTransportSteps.has(error?.preflight_step)
      ? error.preflight_step
      : AUDITED_EXTENSION_PREFLIGHT_FAILURE_METADATA[failureCode].preflight_step,
    audit_phase: error?.audit_phase === "postflight"
      ? "postflight"
      : (fallbackPhase === "postflight" ? "postflight" : "preflight"),
  };
  const safeSmokeEvidence = sanitizedWebRequestSmokeEvidence(error);
  return Object.freeze(safeSmokeEvidence ? { ...base, ...safeSmokeEvidence } : base);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/audited_validation_discovery.mjs <discover|enrich|all> \\",
    `    --user-data-dir ${AUDITED_VALIDATION_PROFILE} \\`,
    `    --remote-debugging-port ${AUDITED_VALIDATION_DEBUG_PORT} \\`,
    `    --chromium-executable "${AUDITED_BROWSER_EXECUTABLE}" \\`,
    "    --extension <unpacked-maozi-extension> --artifact <audited-artifact.json> \\",
    `    [--out-dir ${AUDITED_VALIDATION_CAMPAIGNS_ROOT}/<campaign> --campaign-epoch <token> --run-id <token> \\`,
    "     --activated-at <ISO timestamp>] [--manifest <campaign.json>] \\",
    "    [--target 360] [--minimum 300] [--concurrency 4]",
    "",
    "This command owns one dedicated persistent context and always closes it.",
    "It never connects to CDP, never uses production profile/port 9223, never copies",
    "a profile, and blocks Maozi favorite/publish/edit mutation endpoints before scanning.",
  ].join("\n");
}

function requiredValue(argv, index, flag) {
  const value = String(argv[index + 1] || "").trim();
  if (!value || value.startsWith("--")) throw cliError(`${flag} requires a value`);
  return value;
}

function integer(value, flag, minimum = 1) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) {
    throw cliError(`${flag} must be an integer >= ${minimum}`);
  }
  return number;
}

function pathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertDedicatedLexicalPath(filename, flag) {
  if (!pathInside(AUDITED_VALIDATION_CAMPAIGNS_ROOT, filename)
    || pathInside(PRODUCTION_PROFILE, filename)) {
    throw cliError(`${flag} must stay inside ${AUDITED_VALIDATION_CAMPAIGNS_ROOT} and outside runtime/profile state`);
  }
}

export function parseAuditedValidationDiscoveryArgs(argv = []) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const mode = String(argv[0] || "").trim();
  if (!new Set(["discover", "enrich", "all"]).has(mode)) {
    throw cliError("first argument must be discover, enrich, or all");
  }
  const result = {
    mode,
    target: DEFAULT_AUDITED_DISCOVERY_TARGET,
    minimum: DEFAULT_AUDITED_CANDIDATE_MINIMUM,
    concurrency: 4,
    navigationTimeoutMs: 30_000,
    observationTimeoutMs: 15_000,
    remoteDebuggingPort: null,
  };
  const pathFlags = new Map([
    ["--user-data-dir", "userDataDir"],
    ["--extension", "extension"],
    ["--artifact", "artifact"],
    ["--out-dir", "outDir"],
    ["--manifest", "manifest"],
    ["--chromium-executable", "chromiumExecutable"],
  ]);
  const textFlags = new Map([
    ["--campaign-epoch", "campaignEpoch"],
    ["--run-id", "runId"],
    ["--activated-at", "activatedAt"],
  ]);
  const integerFlags = new Map([
    ["--target", ["target", DEFAULT_AUDITED_DISCOVERY_TARGET]],
    ["--minimum", ["minimum", DEFAULT_AUDITED_CANDIDATE_MINIMUM]],
    ["--concurrency", ["concurrency", 1]],
    ["--remote-debugging-port", ["remoteDebuggingPort", 1]],
    ["--navigation-timeout-ms", ["navigationTimeoutMs", 1_000]],
    ["--observation-timeout-ms", ["observationTimeoutMs", 1_000]],
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cdp-endpoint" || argument === "--production-profile") {
      throw cliError(`${argument} is forbidden; this CLI launches only its owned validation context`);
    }
    if (pathFlags.has(argument)) {
      result[pathFlags.get(argument)] = path.resolve(requiredValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (textFlags.has(argument)) {
      result[textFlags.get(argument)] = requiredValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (integerFlags.has(argument)) {
      const [key, minimum] = integerFlags.get(argument);
      result[key] = integer(requiredValue(argv, index, argument), argument, minimum);
      index += 1;
      continue;
    }
    throw cliError(`unsupported argument: ${argument}`);
  }
  for (const [key, flag] of [
    ["userDataDir", "--user-data-dir"],
    ["extension", "--extension"],
    ["artifact", "--artifact"],
    ["chromiumExecutable", "--chromium-executable"],
    ["remoteDebuggingPort", "--remote-debugging-port"],
  ]) {
    if (!result[key]) throw cliError(`${flag} is required`);
  }
  if (result.userDataDir !== path.resolve(AUDITED_VALIDATION_PROFILE)) {
    throw cliError(`--user-data-dir must be the dedicated audited clone ${AUDITED_VALIDATION_PROFILE}`);
  }
  if (result.extension !== path.resolve(AUDITED_EXTENSION_DIR)) {
    throw cliError(`--extension must be the audited unpacked tree ${AUDITED_EXTENSION_DIR}`);
  }
  if (result.chromiumExecutable !== path.resolve(AUDITED_BROWSER_EXECUTABLE)) {
    throw cliError(`--chromium-executable must be the audited Chrome 151 binary ${AUDITED_BROWSER_EXECUTABLE}`);
  }
  if (result.userDataDir === path.resolve(PRODUCTION_PROFILE)) {
    throw cliError("production user-data-dir is forbidden");
  }
  if (result.remoteDebuggingPort !== AUDITED_VALIDATION_DEBUG_PORT) {
    throw cliError(`only dedicated remote debugging port ${AUDITED_VALIDATION_DEBUG_PORT} is allowed`);
  }
  if (result.remoteDebuggingPort === PRODUCTION_DEBUG_PORT) {
    throw cliError(`production remote debugging port ${PRODUCTION_DEBUG_PORT} is forbidden`);
  }
  if (result.concurrency > 4) {
    throw cliError("--concurrency must be between 1 and 4");
  }
  if (result.target < result.minimum) {
    throw cliError("--target must be greater than or equal to --minimum");
  }
  if (mode === "discover" || mode === "all") {
    for (const [key, flag] of [
      ["outDir", "--out-dir"],
      ["campaignEpoch", "--campaign-epoch"],
      ["runId", "--run-id"],
      ["activatedAt", "--activated-at"],
    ]) {
      if (!result[key]) throw cliError(`${flag} is required for ${mode}`);
    }
  }
  if (mode === "enrich" && !result.manifest) {
    throw cliError("--manifest is required for enrich");
  }
  if (result.outDir) assertDedicatedLexicalPath(result.outDir, "--out-dir");
  if (result.manifest) assertDedicatedLexicalPath(result.manifest, "--manifest");
  return Object.freeze(result);
}

export function assertAuditedNoSessionRestorePreferences(preferences) {
  const restoreMode = preferences?.session?.restore_on_startup;
  const startupUrls = preferences?.session?.startup_urls;
  if ((restoreMode !== undefined && restoreMode !== null && Number(restoreMode) !== 5)
    || (Array.isArray(startupUrls) && startupUrls.some((value) => String(value || "").trim()))) {
    throw cliError("dedicated profile must not restore a prior session or startup URLs");
  }
  if (preferences?.profile?.exit_type !== "Normal") {
    throw cliError("dedicated profile must have a clean Normal exit before audited launch");
  }
  return true;
}

async function nearestExistingPath(filename) {
  let cursor = path.resolve(filename);
  while (true) {
    try { return { path: cursor, stat: await fs.lstat(cursor) }; }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

async function fixedDirectoryAudit(directory, label) {
  const lexical = path.resolve(directory);
  const linkStat = await fs.lstat(lexical).catch((error) => {
    throw cliError(`${label} is unavailable: ${error.message}`);
  });
  if (linkStat.isSymbolicLink()) throw cliError(`${label} must not be a symlink`);
  if (!linkStat.isDirectory()) throw cliError(`${label} must be a directory`);
  const real = await fs.realpath(lexical);
  if (real !== lexical) throw cliError(`${label} realpath must equal its pinned path`);
  return Object.freeze({ path: lexical, realpath: real, device: linkStat.dev, inode: linkStat.ino });
}

async function directoryCapability(directory, label) {
  const lexical = path.resolve(directory);
  const stat = await fs.lstat(lexical).catch((error) => {
    throw cliError(`${label} is unavailable: ${error.message}`);
  });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw cliError(`${label} must be a non-symlink directory`);
  }
  return Object.freeze({
    path: lexical,
    realpath: await fs.realpath(lexical),
    device: stat.dev,
    inode: stat.ino,
  });
}

async function assertNoSymlinkOrHardlinkBelow(rootDirectory, target) {
  const root = path.resolve(rootDirectory);
  const absolute = path.resolve(target);
  if (!pathInside(root, absolute)) throw cliError("dedicated runtime path escapes validation state");
  let cursor = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw cliError(`dedicated runtime path must not contain a symlink: ${cursor}`);
      if (stat.isFile() && stat.nlink !== 1) throw cliError(`dedicated runtime file must not be hard-linked: ${cursor}`);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
}

async function ensureRealDirectoryBelow(rootDirectory, target, { create = true } = {}) {
  const rootAudit = await fixedDirectoryAudit(rootDirectory, "dedicated directory capability root");
  const absolute = path.resolve(target);
  if (!pathInside(rootAudit.realpath, absolute)) throw cliError("dedicated directory escapes its capability root");
  let cursor = rootAudit.realpath;
  for (const segment of path.relative(rootAudit.realpath, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (create) {
      try { await fs.mkdir(cursor, { mode: 0o700 }); }
      catch (error) { if (error?.code !== "EEXIST") throw error; }
    }
    const stat = await fs.lstat(cursor).catch((error) => {
      throw cliError(`dedicated directory capability is unavailable: ${error.message}`);
    });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw cliError(`dedicated directory capability must not contain a symlink or file: ${cursor}`);
    }
    const real = await fs.realpath(cursor);
    if (!pathInside(rootAudit.realpath, real)) throw cliError("dedicated directory capability escaped its root");
  }
  const finalStat = await fs.lstat(absolute);
  return Object.freeze({
    path: absolute,
    realpath: await fs.realpath(absolute),
    device: finalStat.dev,
    inode: finalStat.ino,
  });
}

async function assertDirectoryCapabilityUnchanged(capability) {
  const stat = await fs.lstat(capability.path);
  if (stat.isSymbolicLink() || !stat.isDirectory()
    || stat.dev !== capability.device || stat.ino !== capability.inode
    || await fs.realpath(capability.path) !== capability.realpath) {
    throw cliError(`dedicated directory capability changed during execution: ${capability.path}`);
  }
}

export async function assertAuditedPathHasNoSymlinkOrHardlink(rootDirectory, target) {
  await assertNoSymlinkOrHardlinkBelow(rootDirectory, target);
  return true;
}

export async function assertAuditedValidationRuntimePaths(options = {}) {
  const root = await fixedDirectoryAudit(AUDITED_VALIDATION_ROOT, "dedicated validation root");
  const state = await fixedDirectoryAudit(path.join(AUDITED_VALIDATION_ROOT, "state"), "dedicated validation state root");
  const locks = await fixedDirectoryAudit(path.dirname(AUDITED_VALIDATION_OWNER_LOCK), "dedicated validation lock root");
  const productionRealpath = await fs.realpath("/Users/mac/.ozon-24h-production")
    .catch(() => path.resolve("/Users/mac/.ozon-24h-production"));
  for (const auditedPath of [root.realpath, state.realpath, locks.realpath]) {
    if (auditedPath === productionRealpath
      || pathInside(productionRealpath, auditedPath)
      || pathInside(auditedPath, productionRealpath)) {
      throw cliError("dedicated validation runtime paths overlap production state");
    }
  }
  await assertNoSymlinkOrHardlinkBelow(locks.realpath, path.join(locks.realpath, "session-quarantine"));
  const env = discoveryEnvironment({
    userDataDir: options.userDataDir || AUDITED_VALIDATION_PROFILE,
    extension: options.extension || AUDITED_EXTENSION_DIR,
    chromiumExecutable: options.chromiumExecutable || AUDITED_BROWSER_EXECUTABLE,
  }, {});
  for (const key of [
    "FLOW_B_OZON_ACCESS_STATE",
    "FLOW_B_RUN_DIR",
    "FLOW_B_RUNTIME_STATE_DB",
    "FLOW_B_SOURCE_SCAN_STATE_FILE",
    "FLOW_B_DAILY_REPORT_DIR",
    "FLOW_B_PROFIT_FEEDBACK_DIR",
    "FLOW_B_PROFIT_FEEDBACK_STATE",
    "FLOW_B_PROFIT_RUNTIME_ROOT",
    "FLOW_B_REPORT_RUNTIME_ROOT",
    "FLOW_B_REPORT_RUN_DIR",
    "FLOW_B_SUBMISSION_GATE_RUN_DIR",
    "FLOW_B_SUPPLY_AUDIT_DIR",
  ]) {
    if (env[key]) await assertNoSymlinkOrHardlinkBelow(state.realpath, env[key]);
  }
  return Object.freeze({ root, state, locks });
}

export async function assertAuditedIoContainment(options) {
  await assertAuditedValidationRuntimePaths();
  const root = path.resolve(AUDITED_VALIDATION_ROOT);
  for (const [key, flag] of [["outDir", "--out-dir"], ["manifest", "--manifest"]]) {
    const filename = options?.[key];
    if (!filename) continue;
    assertDedicatedLexicalPath(filename, flag);
    const existing = await nearestExistingPath(filename);
    if (existing.stat.isSymbolicLink()) throw cliError(`${flag} path ancestry must not contain symlinks`);
    const realExisting = await fs.realpath(existing.path);
    if (!pathInside(root, realExisting)) throw cliError(`${flag} escapes the dedicated validation root`);
    const relative = path.relative(existing.path, path.resolve(filename));
    let cursor = existing.path;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      try {
        const stat = await fs.lstat(cursor);
        if (stat.isSymbolicLink()) throw cliError(`${flag} path ancestry must not contain symlinks`);
      } catch (error) {
        if (error?.code === "ENOENT") break;
        throw error;
      }
    }
  }
  return true;
}

export async function assertDedicatedProfile(options) {
  const profile = path.resolve(options.userDataDir);
  const linkStat = await fs.lstat(profile).catch((error) => {
    throw cliError(`dedicated validation profile is unavailable: ${error.message}`);
  });
  if (linkStat.isSymbolicLink()) throw cliError("dedicated validation profile must not be a symlink");
  const stat = await fs.stat(profile);
  if (!stat.isDirectory()) throw cliError("dedicated validation profile is not a directory");
  if ((stat.mode & 0o077) !== 0) throw cliError("dedicated validation profile must have mode 0700");
  const realProfile = await fs.realpath(profile);
  if (realProfile !== path.resolve(AUDITED_VALIDATION_PROFILE)) {
    throw cliError("dedicated validation profile realpath does not match the audited clone");
  }
  const productionRealpath = await fs.realpath(PRODUCTION_PROFILE).catch(() => path.resolve(PRODUCTION_PROFILE));
  if (realProfile === productionRealpath) throw cliError("production profile realpath is forbidden");
  for (const name of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) {
    try {
      await fs.lstat(path.join(profile, name));
      throw cliError(`dedicated validation profile is already owned (${name} exists)`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  let preferences;
  try { preferences = JSON.parse(await fs.readFile(path.join(profile, "Default", "Preferences"), "utf8")); }
  catch (error) { throw cliError(`dedicated profile Preferences is unreadable: ${error.message}`); }
  assertAuditedNoSessionRestorePreferences(preferences);
  await auditDedicatedProfileTree(realProfile);
  return Object.freeze({ profile, realpath: realProfile, device: stat.dev, inode: stat.ino });
}

export async function auditDedicatedProfileTree(profileDirectory) {
  const root = await fs.realpath(path.resolve(profileDirectory));
  let auditedEntries = 0;
  const visit = async (directory) => {
    const directoryStat = await fs.lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw cliError(`dedicated profile tree contains a non-directory ancestry entry: ${directory}`);
    }
    if (!pathInside(root, await fs.realpath(directory))) {
      throw cliError("dedicated profile tree realpath escapes the profile root");
    }
    for (const name of await fs.readdir(directory)) {
      const filename = path.join(directory, name);
      const stat = await fs.lstat(filename);
      auditedEntries += 1;
      if (auditedEntries > 100_000) throw cliError("dedicated profile tree exceeds the audited entry limit");
      if (stat.isSymbolicLink()) throw cliError(`dedicated profile tree contains a symlink: ${filename}`);
      const real = await fs.realpath(filename);
      if (!pathInside(root, real)) throw cliError("dedicated profile tree realpath escapes the profile root");
      if (stat.isDirectory()) await visit(filename);
      else if (!stat.isFile() || stat.nlink !== 1) {
        throw cliError(`dedicated profile tree contains a non-regular or hard-linked leaf: ${filename}`);
      }
    }
  };
  await visit(root);
  return Object.freeze({ root, audited_entries: auditedEntries });
}

const SESSION_RELATIVE_PATHS = Object.freeze([
  "Default/Sessions",
  "Default/Current Session",
  "Default/Current Tabs",
  "Default/Last Session",
  "Default/Last Tabs",
]);

export async function isolateAuditedProfileSessions(options, token = crypto.randomBytes(16).toString("hex")) {
  const requestedProfile = path.resolve(options.userDataDir);
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(String(token || ""))) throw cliError("session quarantine token is invalid");
  const profileAudit = await directoryCapability(requestedProfile, "dedicated profile quarantine root");
  const profile = profileAudit.realpath;
  await ensureRealDirectoryBelow(profileAudit.realpath, path.join(profileAudit.realpath, "Default"), { create: false });
  const lockRoot = path.dirname(AUDITED_VALIDATION_OWNER_LOCK);
  const quarantineParent = await ensureRealDirectoryBelow(lockRoot, path.join(lockRoot, "session-quarantine"));
  await assertDirectoryCapabilityUnchanged(quarantineParent);
  const quarantine = path.join(quarantineParent.realpath, token);
  try { await fs.mkdir(quarantine, { mode: 0o700 }); }
  catch (error) {
    if (error?.code === "EEXIST") throw cliError("session quarantine token directory already exists");
    throw error;
  }
  const quarantineCapability = await ensureRealDirectoryBelow(quarantineParent.realpath, quarantine, { create: false });
  const moved = [];
  const rollbackIsolation = async () => {
    const rollbackErrors = [];
    try {
      await assertDirectoryCapabilityUnchanged(quarantineParent);
      await assertDirectoryCapabilityUnchanged(quarantineCapability);
    } catch (rollback) {
      return [rollback];
    }
    await fs.rm(path.join(profile, "Default", "Sessions"), { recursive: true, force: true })
      .catch((rollback) => rollbackErrors.push(rollback));
    for (const relative of [...moved].reverse()) {
      await ensureRealDirectoryBelow(profileAudit.realpath, path.dirname(path.join(profile, relative)))
        .then(() => fs.rename(path.join(quarantine, relative), path.join(profile, relative)))
        .catch((rollback) => rollbackErrors.push(rollback));
    }
    await fs.rm(quarantine, { recursive: true, force: true }).catch((rollback) => rollbackErrors.push(rollback));
    return rollbackErrors;
  };
  try {
    for (const relative of SESSION_RELATIVE_PATHS) {
      await assertDirectoryCapabilityUnchanged(quarantineParent);
      await assertDirectoryCapabilityUnchanged(quarantineCapability);
      const source = path.join(profile, relative);
      const target = path.join(quarantine, relative);
      try {
        const stat = await fs.lstat(source);
        if (stat.isSymbolicLink()) throw cliError(`profile session path must not be a symlink: ${relative}`);
        await ensureRealDirectoryBelow(quarantineCapability.realpath, path.dirname(target));
        await fs.rename(source, target);
        moved.push(relative);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await ensureRealDirectoryBelow(profileAudit.realpath, path.join(profile, "Default", "Sessions"));
  } catch (error) {
    const rollbackErrors = await rollbackIsolation();
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "session quarantine failed and rollback was incomplete");
    throw error;
  }
  const record = {
    contract: "ozon-audited-validation-session-quarantine-v1",
    profile,
    quarantine,
    access_state_file: path.join(quarantine, "runtime", "ozon-access-state.json"),
    moved,
    isolated_at: new Date().toISOString(),
  };
  try {
    await fs.writeFile(path.join(quarantine, "quarantine.json"), `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    const rollbackErrors = await rollbackIsolation();
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "session quarantine manifest failed and rollback was incomplete");
    throw error;
  }
  return Object.freeze({
    ...record,
    async restore() {
      await assertDirectoryCapabilityUnchanged(quarantineParent);
      await assertDirectoryCapabilityUnchanged(quarantineCapability);
      const generated = path.join(quarantine, "generated-after-audited-run");
      await ensureRealDirectoryBelow(quarantineCapability.realpath, generated);
      for (const relative of SESSION_RELATIVE_PATHS) {
        const destination = path.join(profile, relative);
        const original = path.join(quarantine, relative);
        try {
          await fs.lstat(destination);
          const generatedTarget = path.join(generated, relative);
          await ensureRealDirectoryBelow(quarantineCapability.realpath, path.dirname(generatedTarget));
          await fs.rename(destination, generatedTarget);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        if (moved.includes(relative)) {
          await ensureRealDirectoryBelow(profileAudit.realpath, path.dirname(destination));
          await fs.rename(original, destination);
        }
      }
      await fs.rm(generated, { recursive: true, force: true });
      await fs.rm(path.join(quarantine, "runtime"), { recursive: true, force: true });
      await fs.rm(path.join(quarantine, "quarantine.json"), { force: true });
      await fs.rm(path.join(quarantine, "Default"), { recursive: true, force: true });
      await fs.rmdir(quarantine);
    },
  });
}

export async function prepareOwnedAccessStateFile(isolation) {
  const quarantine = path.resolve(String(isolation?.quarantine || ""));
  const filename = path.resolve(String(isolation?.access_state_file || ""));
  if (!quarantine || !filename || !pathInside(quarantine, filename)
    || path.basename(filename) !== "ozon-access-state.json") {
    throw cliError("owned access-state path is not bound to the session quarantine");
  }
  const runtimeDirectory = path.dirname(filename);
  const runtimeCapability = await ensureRealDirectoryBelow(quarantine, runtimeDirectory);
  await assertDirectoryCapabilityUnchanged(runtimeCapability);
  let handle;
  try {
    handle = await fs.open(filename,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600);
    await assertDirectoryCapabilityUnchanged(runtimeCapability);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw cliError("owned access-state leaf is not a single-link regular file");
    await handle.writeFile("{}\n", "utf8");
    await assertDirectoryCapabilityUnchanged(runtimeCapability);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  return filename;
}

async function regularFilesBelow(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...await regularFilesBelow(absolute));
    else if (entry.isFile()) rows.push(absolute);
  }
  return rows;
}

export async function auditedExtensionTreeDigest(directory) {
  const root = path.resolve(directory);
  const files = (await regularFilesBelow(root)).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (files.length === 0) throw cliError("audited extension tree contains no regular files");
  const manifest = [];
  for (const filename of files) {
    const digest = crypto.createHash("sha256").update(await fs.readFile(filename)).digest("hex");
    manifest.push(`${digest}  ${filename}\n`);
  }
  return Object.freeze({
    directory: root,
    file_count: files.length,
    sha256: crypto.createHash("sha256").update(manifest.join("")).digest("hex"),
  });
}

async function assertAuditedExtension(directory) {
  const audit = await auditedExtensionTreeDigest(directory);
  if (audit.directory !== path.resolve(AUDITED_EXTENSION_DIR)
    || audit.file_count !== 13
    || audit.sha256 !== AUDITED_EXTENSION_TREE_SHA256) {
    throw cliError("unpacked extension tree digest does not match the audited 13-file build");
  }
  return audit;
}

async function assertAuditedBrowserExecutable(filename) {
  const executable = path.resolve(filename);
  const stat = await fs.stat(executable).catch((error) => {
    throw cliError(`audited Chrome executable is unavailable: ${error.message}`);
  });
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw cliError("audited Chrome executable is not an executable regular file");
  }
  const { stdout } = await execFileAsync(executable, ["--version"]);
  const version = String(stdout || "").trim();
  if (version !== AUDITED_BROWSER_VERSION) {
    throw cliError(`audited Chrome version mismatch: ${version || "missing version"}`);
  }
  return Object.freeze({ executable, version });
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => reject(cliError(`dedicated port ${port} is unavailable: ${error.message}`)));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

async function acquireOwnerLock(options, extensionDigest, browserVersion) {
  const filename = path.resolve(AUDITED_VALIDATION_OWNER_LOCK);
  const lockRootCapability = await fixedDirectoryAudit(path.dirname(filename), "dedicated validation lock root");
  await assertDirectoryCapabilityUnchanged(lockRootCapability);
  const token = crypto.randomBytes(16).toString("hex");
  const document = {
    contract: "ozon-audited-validation-browser-owner-v1",
    owner_pid: process.pid,
    browser_root_pid: null,
    profile_dir: options.userDataDir,
    extension_dir: options.extension,
    extension_tree_sha256: extensionDigest,
    browser_executable: options.chromiumExecutable,
    browser_version: browserVersion,
    remote_debugging_port: options.remoteDebuggingPort,
    acquired_at: new Date().toISOString(),
    token,
  };
  let handle;
  try {
    handle = await fs.open(filename,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600);
    await assertDirectoryCapabilityUnchanged(lockRootCapability);
  } catch (error) {
    if (error?.code === "EEXIST") throw cliError(`owner lock already exists: ${filename}`);
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await assertDirectoryCapabilityUnchanged(lockRootCapability);
  } catch (error) {
    await fs.unlink(filename).catch(() => {});
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
  return Object.freeze({
    filename,
    token,
    async update(patch) {
      await assertDirectoryCapabilityUnchanged(lockRootCapability);
      const updateHandle = await fs.open(filename, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
      try {
        await assertDirectoryCapabilityUnchanged(lockRootCapability);
        const stat = await updateHandle.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw cliError("owner lock is not a single-link regular file");
        const current = JSON.parse(await updateHandle.readFile("utf8"));
        if (current.token !== token) throw cliError("owner lock token changed during execution");
        const bytes = Buffer.from(`${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
        await updateHandle.truncate(0);
        await updateHandle.write(bytes, 0, bytes.length, 0);
        await updateHandle.sync();
        await assertDirectoryCapabilityUnchanged(lockRootCapability);
      } finally {
        await updateHandle.close().catch(() => {});
      }
    },
    async release() {
      let releaseHandle;
      try {
        await assertDirectoryCapabilityUnchanged(lockRootCapability);
        releaseHandle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        await assertDirectoryCapabilityUnchanged(lockRootCapability);
        const stat = await releaseHandle.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw cliError("owner lock is not a single-link regular file");
        const current = JSON.parse(await releaseHandle.readFile("utf8"));
        if (current.token !== token) throw cliError("refusing to remove an owner lock held by another process");
        const currentPathStat = await fs.lstat(filename);
        if (currentPathStat.dev !== stat.dev || currentPathStat.ino !== stat.ino) {
          throw cliError("owner lock path changed before release");
        }
        await fs.unlink(filename);
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      } finally {
        if (releaseHandle) await releaseHandle.close().catch(() => {});
      }
    },
  });
}

function commandHasExactArgument(command, name, value) {
  const expected = `${name}=${value}`;
  return command.split(/\s+/u).some((token) => token.replace(/^['"]|['"]$/gu, "") === expected);
}

function commandExactArgumentOnce(command, name, value) {
  const prefix = `${name}=`;
  const values = String(command || "").split(/\s+/u)
    .map((token) => token.replace(/^['"]|['"]$/gu, ""))
    .filter((token) => token.startsWith(prefix));
  return values.length === 1 && values[0] === `${name}=${value}`;
}

export function auditedBrowserRootFromProcessList(text, options) {
  const roots = String(text || "").split(/\r?\n/u).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    if (!match) return [];
    const command = match[3];
    if (!commandHasExactArgument(command, "--user-data-dir", options.userDataDir)
      || /(?:^|\s)--type=/u.test(command)) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), command }];
  });
  if (roots.length !== 1) {
    throw cliError(`expected exactly one browser root for the dedicated profile; found ${roots.length}`);
  }
  const root = roots[0];
  if (!root.command.startsWith(`${options.chromiumExecutable} `)
    || !/Chrome(?: for Testing)?|Chromium/iu.test(root.command)
    || !commandExactArgumentOnce(root.command, "--user-data-dir", options.userDataDir)
    || !commandExactArgumentOnce(root.command, "--remote-debugging-port", String(options.remoteDebuggingPort))
    || !commandExactArgumentOnce(root.command, "--remote-debugging-address", "127.0.0.1")
    || root.command.includes(`--remote-debugging-port=${PRODUCTION_DEBUG_PORT}`)) {
    throw cliError("browser root command line is not bound to the dedicated profile and port");
  }
  return Object.freeze(root);
}

export function auditedProcessRows(text) {
  return Object.freeze(String(text || "").split(/\r?\n/u).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    return match ? [Object.freeze({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
    })] : [];
  }));
}

export function auditedPidDescendsFrom(pid, ancestorPid, processRows) {
  const child = Number(pid);
  const ancestor = Number(ancestorPid);
  if (!Number.isInteger(child) || child <= 0
    || !Number.isInteger(ancestor) || ancestor <= 0) return false;
  const parentByPid = new Map((processRows || []).map((row) => [Number(row.pid), Number(row.ppid)]));
  let cursor = child;
  const seen = new Set();
  while (cursor > 0 && !seen.has(cursor)) {
    if (cursor === ancestor) return true;
    seen.add(cursor);
    cursor = parentByPid.get(cursor) || 0;
  }
  return false;
}

async function waitForAuditedBrowserRoot(options, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="]);
    try {
      const root = auditedBrowserRootFromProcessList(stdout, options);
      if (!auditedPidDescendsFrom(root.pid, process.pid, auditedProcessRows(stdout))) {
        throw codedCliError(
          "AUDITED_BROWSER_ROOT_ORCHESTRATOR_ANCESTRY_INVALID",
          "dedicated browser root is not a descendant of the live owned-context orchestrator",
        );
      }
      return root;
    }
    catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw lastError || cliError("dedicated browser root did not appear");
}

async function listenerAuditForPort(port) {
  const result = await execFileAsync("lsof", [
    "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn",
  ]).catch((error) => {
    if (Number(error?.code) === 1) return { stdout: error?.stdout || "" };
    throw codedCliError(
      "AUDITED_PORT_LISTENER_AUDIT_FAILED",
      `could not audit dedicated port ${port} ownership: ${error.message}`,
    );
  });
  const pids = [];
  const bindings = {};
  let currentPid = null;
  for (const line of String(result?.stdout || "").split(/\r?\n/u)) {
    if (/^p\d+$/u.test(line)) {
      currentPid = Number(line.slice(1));
      if (!pids.includes(currentPid)) pids.push(currentPid);
    } else if (line.startsWith("n") && currentPid) {
      bindings[currentPid] ||= [];
      bindings[currentPid].push(line.slice(1));
    }
  }
  return Object.freeze({
    pids: Object.freeze(pids),
    bindings: Object.freeze(Object.fromEntries(Object.entries(bindings)
      .map(([pid, rows]) => [pid, Object.freeze([...rows])]))),
  });
}

async function listenerPidsForPort(port) {
  return (await listenerAuditForPort(port)).pids;
}

export async function waitForAuditedPortOwnedByBrowserRoot(
  root,
  port,
  options,
  timeoutMs = 5_000,
  dependencies = {},
) {
  const now = dependencies.now || Date.now;
  const delay = dependencies.delay || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const processList = dependencies.processList || (async () => (
    await execFileAsync("ps", ["-axo", "pid=,ppid=,command="])
  ).stdout);
  const listenerPids = dependencies.listenerPids || listenerPidsForPort;
  const listenerAudit = dependencies.listenerAudit || (dependencies.listenerPids
    ? null
    : listenerAuditForPort);
  const orchestratorPid = Number(dependencies.orchestratorPid || process.pid);
  const deadline = now() + timeoutMs;
  do {
    const processText = await processList();
    const rows = auditedProcessRows(processText);
    let currentRoot;
    try { currentRoot = auditedBrowserRootFromProcessList(processText, options); }
    catch (error) {
      throw codedCliError(
        "AUDITED_BROWSER_ROOT_CHANGED_DURING_PORT_WAIT",
        `dedicated browser root changed while waiting for port ${port}: ${error.message}`,
      );
    }
    if (Number(currentRoot.pid) !== Number(root?.pid)) {
      throw codedCliError(
        "AUDITED_BROWSER_ROOT_CHANGED_DURING_PORT_WAIT",
        `dedicated browser root PID changed while waiting for port ${port}`,
      );
    }
    if (!auditedPidDescendsFrom(currentRoot.pid, orchestratorPid, rows)) {
      throw codedCliError(
        "AUDITED_BROWSER_ROOT_ORCHESTRATOR_ANCESTRY_INVALID",
        "dedicated browser root lost its owned-context orchestrator ancestry during port startup",
      );
    }
    const auditedListeners = listenerAudit ? await listenerAudit(port) : null;
    const listeners = auditedListeners?.pids || await listenerPids(port);
    if (listeners.length > 1) {
      throw codedCliError(
        "AUDITED_PORT_LISTENER_COUNT_INVALID",
        `expected at most one listener while dedicated port ${port} starts; found ${listeners.length}`,
      );
    }
    if (listeners.length === 1) {
      const bindings = auditedListeners?.bindings?.[listeners[0]];
      if (auditedListeners && (!Array.isArray(bindings) || bindings.length !== 1
        || !new RegExp(`^127\\.0\\.0\\.1:${port}(?:\\s|$)`, "u")
          .test(String(bindings[0] || "")))) {
        throw codedCliError(
          "AUDITED_PORT_LISTENER_BIND_ADDRESS_INVALID",
          `dedicated port ${port} listener is not bound to exact loopback`,
        );
      }
      if (!auditedPidDescendsFrom(listeners[0], currentRoot.pid, rows)) {
        throw codedCliError(
          "AUDITED_PORT_LISTENER_ROGUE",
          `dedicated port ${port} listener is not owned by the audited browser root tree`,
        );
      }
      return true;
    }
    if (now() >= deadline) break;
    await delay(100);
  } while (now() <= deadline);
  throw codedCliError(
    "AUDITED_PORT_LISTENER_START_TIMEOUT",
    `dedicated port ${port} did not acquire one owned listener within ${timeoutMs}ms`,
  );
}

export async function assertDedicatedPortOwnedByBrowserRoot(
  root,
  port,
  options = Object.freeze({
    userDataDir: AUDITED_VALIDATION_PROFILE,
    chromiumExecutable: AUDITED_BROWSER_EXECUTABLE,
    remoteDebuggingPort: AUDITED_VALIDATION_DEBUG_PORT,
  }),
  timeoutMs = 5_000,
  dependencies = {},
) {
  return waitForAuditedPortOwnedByBrowserRoot(root, port, options, timeoutMs, dependencies);
}

export async function closeAuditedOwnedContext(context, timeoutMs = 10_000) {
  if (!context) return;
  if (typeof context.close !== "function") throw cliError("owned browser context has no close method");
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => context.close()),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(cliError("owned browser context close timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function pidExists(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

export async function waitForAuditedBrowserStopped(
  root,
  port,
  timeoutMs = 10_000,
  profile = AUDITED_VALIDATION_PROFILE,
) {
  const deadline = Date.now() + timeoutMs;
  let lastPortError = null;
  let lastResidue = null;
  do {
    const rootAlive = root?.pid ? pidExists(root.pid) : false;
    let portFree = false;
    try { await assertPortAvailable(port); portFree = true; }
    catch (error) { lastPortError = error; }
    let psAuditError = null;
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="])
      .catch((error) => { psAuditError = error; return { stdout: "" }; });
    const profileProcesses = String(stdout || "").split(/\r?\n/u).filter((line) => {
      const match = line.match(/^\s*\d+\s+(.+)$/u);
      return match && commandHasExactArgument(match[1], "--user-data-dir", path.resolve(profile));
    });
    const singletonPaths = [];
    for (const name of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) {
      try { await fs.lstat(path.join(profile, name)); singletonPaths.push(name); }
      catch (error) { if (error?.code !== "ENOENT") singletonPaths.push(`${name}:audit-error`); }
    }
    lastResidue = { profileProcesses: profileProcesses.length, singletonPaths, psAuditError };
    if (!rootAlive && portFree && !psAuditError
      && profileProcesses.length === 0 && singletonPaths.length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw cliError(`owned browser did not fully stop; root_alive=${root?.pid ? pidExists(root.pid) : false}, profile_processes=${lastResidue?.profileProcesses ?? "unknown"}, singleton_residue=${lastResidue?.singletonPaths?.length ?? "unknown"}${lastResidue?.psAuditError ? `, process_audit_error=${lastResidue.psAuditError.message}` : ""}${lastPortError ? `, port_error=${lastPortError.message}` : ""}`);
}

function normalizedRequestPath(parsed) {
  // URL.pathname deliberately remains byte-for-byte canonical here.  Trimming,
  // decoding, or collapsing slashes would turn ambiguous paths into allowlisted
  // ones even though a reverse proxy may normalize them differently.
  return parsed.pathname || "/";
}

function auditedMutationKind(hostname, requestPath) {
  if (hostname === "seller.ozon.ru"
    && requestPath === "/api/site/seller-prototype/create-bundle-by-variant-id") return "external-create-bundle";
  if (["/api.product.favorite/toggle"].includes(requestPath)) return "favorite";
  if (["/api.chrome/collect", "/api.source.ali1688/collect"].includes(requestPath)) return "collect";
  if (["/api.selection.follow/import", "/api.wb.collect/direct_to_draft"].includes(requestPath)) return "import";
  if (["/api.wb.collect/publish_direct", "/api.product.online/batch_update_stock", "/api.product.online/sync_shop"].includes(requestPath)) return "publish";
  if ([
    "/api.selection.follow/edit",
    "/api.selection.plugin/add_rule",
    "/api.selection.plugin/delete_rule",
    "/api.selection.plugin/toggle_rule",
    "/api.shop/set_cookies",
    "/api.shop/sync_warehouse",
  ].includes(requestPath)) return "edit";
  if (["/api.chrome/check_data", "/api.chrome/wb_sales"].includes(requestPath)) return "analytics-upload";
  return null;
}

export function auditedRequestDecision(url, method = "GET") {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const maoziHost = hostname === "maozierp.com" || hostname.endsWith(".maozierp.com");
    const requestMethod = String(method || "GET").toUpperCase();
    const requestPath = normalizedRequestPath(parsed);
    if ((maoziHost || hostname === "seller.ozon.ru")
      && (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port)) {
      const kind = auditedMutationKind(hostname, requestPath);
      return Object.freeze({
        allowed: false,
        reason: "protected-host-noncanonical-authority",
        hostname,
        method: requestMethod,
        path: requestPath,
        mutation_kind: kind || (maoziHost ? "unknown-maozi-host" : "external-protected"),
        mutation_attempt: kind !== "analytics-upload",
        protected_attempt: true,
      });
    }
    if (maoziHost) {
      const allowed = hostname === "api.maozierp.com"
        && AUDITED_MAOZI_API_ALLOWLIST.some((rule) => rule.path === requestPath
        && rule.methods.includes(requestMethod));
      const kind = hostname === "api.maozierp.com"
        ? auditedMutationKind(hostname, requestPath) || "unknown-maozi-api"
        : "unknown-maozi-host";
      return Object.freeze({
        allowed,
        reason: allowed ? "explicit-maozi-read-allowlist" : "maozi-api-default-deny",
        hostname,
        method: requestMethod,
        path: requestPath,
        mutation_kind: allowed ? null : kind,
        mutation_attempt: !allowed && kind !== "analytics-upload",
        protected_attempt: !allowed,
      });
    }
    const protectedSellerHost = hostname === "seller.ozon.ru";
    const externalMutation = protectedSellerHost && AUDITED_EXTERNAL_MUTATION_RULES.some((rule) => (
      rule.hostname === hostname
      && rule.path === requestPath
      && rule.methods.includes(requestMethod)
    ));
    return Object.freeze({
      allowed: !protectedSellerHost,
      reason: protectedSellerHost
        ? (externalMutation ? "explicit-external-mutation-deny" : "protected-seller-host-default-deny")
        : "non-maozi-api-request",
      hostname,
      method: requestMethod,
      path: requestPath,
      mutation_kind: protectedSellerHost
        ? auditedMutationKind(hostname, requestPath) || "external-protected"
        : null,
      mutation_attempt: protectedSellerHost,
      protected_attempt: protectedSellerHost,
    });
  } catch {
    return Object.freeze({
      allowed: false,
      reason: "invalid-request-url",
      hostname: null,
      method: String(method || "GET").toUpperCase(),
      path: null,
      mutation_kind: null,
      mutation_attempt: false,
      protected_attempt: false,
    });
  }
}

export async function installAuditedMutationFirewall(context) {
  if (typeof context?.route !== "function") throw cliError("browser context routing is unavailable");
  const counters = {
    allowed_explicit_reads: 0,
    blocked_requests: 0,
    blocked_mutation_attempts: 0,
    blocked_protected_analytics_upload_attempts: 0,
    blocked_by_mutation_kind: {},
    by_method_path: {},
  };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const decision = auditedRequestDecision(request.url(), request.method?.() || "GET");
    if (!decision.allowed) {
      counters.blocked_requests += 1;
      if (decision.mutation_attempt) {
        counters.blocked_mutation_attempts += 1;
        const kind = decision.mutation_kind || "unknown";
        counters.blocked_by_mutation_kind[kind] = (counters.blocked_by_mutation_kind[kind] || 0) + 1;
      }
      if (decision.protected_attempt && decision.mutation_kind === "analytics-upload") {
        counters.blocked_protected_analytics_upload_attempts += 1;
      }
      const key = `${decision.method} ${decision.path || "<invalid>"}`;
      counters.by_method_path[key] = (counters.by_method_path[key] || 0) + 1;
      await route.abort("blockedbyclient");
      return;
    }
    if (decision.reason === "explicit-maozi-read-allowlist") counters.allowed_explicit_reads += 1;
    await route.continue();
  });
  return Object.freeze({
    snapshot() {
      return Object.freeze({
        observation_scope: "playwright-context-route-does-not-cover-service-worker",
        allowed_explicit_reads: counters.allowed_explicit_reads,
        blocked_requests: counters.blocked_requests,
        context_route_blocked_mutation_attempts: counters.blocked_mutation_attempts,
        context_route_blocked_by_mutation_kind: Object.freeze({ ...counters.blocked_by_mutation_kind }),
        context_route_blocked_protected_analytics_upload_attempts:
          counters.blocked_protected_analytics_upload_attempts,
        service_worker_mutation_attempts_observed: null,
        all_contexts_mutation_attempts_observed: null,
        by_method_path: Object.freeze({ ...counters.by_method_path }),
      });
    },
  });
}

function escapeDnrRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function auditedDynamicDnrRules() {
  return Object.freeze([Object.freeze({
    id: AUDITED_DNR_FIRST_RULE_ID,
    priority: 10_000,
    action: Object.freeze({ type: "block" }),
    condition: Object.freeze({
      requestDomains: Object.freeze(["maozierp.com"]),
      resourceTypes: Object.freeze(["xmlhttprequest", "other"]),
    }),
  }), ...AUDITED_MAOZI_API_ALLOWLIST.map((rule, index) => Object.freeze({
    id: AUDITED_DNR_FIRST_RULE_ID + 1 + index,
    priority: 20_000,
    action: Object.freeze({ type: "allow" }),
    condition: Object.freeze({
      regexFilter: `^https://api\\.maozierp\\.com${escapeDnrRegex(rule.path)}(?:\\?|$)`,
      requestDomains: Object.freeze(["api.maozierp.com"]),
      requestMethods: Object.freeze(rule.methods.map((method) => method.toLowerCase())),
      resourceTypes: Object.freeze(["xmlhttprequest", "other"]),
    }),
  })), Object.freeze({
    id: AUDITED_DNR_FIRST_RULE_ID + 1 + AUDITED_MAOZI_API_ALLOWLIST.length,
    priority: 30_000,
    action: Object.freeze({ type: "block" }),
    condition: Object.freeze({
      requestDomains: Object.freeze(["seller.ozon.ru"]),
      resourceTypes: Object.freeze(["xmlhttprequest", "other"]),
    }),
  })]);
}

export function auditedBootstrapLockdownDnrRule() {
  return Object.freeze({
    id: AUDITED_DNR_LOCKDOWN_RULE_ID,
    priority: 30_000,
    action: Object.freeze({ type: "block" }),
    condition: Object.freeze({
      requestDomains: Object.freeze(["maozierp.com", "seller.ozon.ru"]),
      resourceTypes: Object.freeze(["xmlhttprequest", "other"]),
    }),
  });
}

function normalizedDnrRule(rule) {
  return {
    id: Number(rule?.id),
    priority: Number(rule?.priority),
    action: { type: String(rule?.action?.type || "") },
    condition: {
      regexFilter: String(rule?.condition?.regexFilter || ""),
      requestDomains: [...(rule?.condition?.requestDomains || [])].map(String).sort(),
      requestMethods: rule?.condition?.requestMethods
        ? [...rule.condition.requestMethods].map(String).sort()
        : null,
      resourceTypes: [...(rule?.condition?.resourceTypes || [])].map(String).sort(),
    },
  };
}

function auditedDnrRuleSetDigest(rules) {
  const normalized = [...(rules || [])].map(normalizedDnrRule).sort((left, right) => left.id - right.id);
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function isPinnedSafeDynamicRule9001(rule) {
  return Number(rule?.id) === 9001
    && Number(rule?.priority) === 1
    && String(rule?.action?.type || "") === "modifyHeaders"
    && Array.isArray(rule?.action?.responseHeaders)
    && rule.action.responseHeaders.length === 1
    && String(rule.action.responseHeaders[0]?.header || "").toLowerCase() === "content-security-policy"
    && String(rule.action.responseHeaders[0]?.operation || "") === "remove"
    && String(rule?.condition?.regexFilter || "") === "^https?://([^/]*\\.)?ozon\\.(ru|kz|by)/"
    && Array.isArray(rule?.condition?.resourceTypes)
    && rule.condition.resourceTypes.length === 1
    && rule.condition.resourceTypes[0] === "main_frame";
}

async function auditedExtensionBootstrapDnrWorkerAudit({ lockdownRule, staleRuleIds }) {
  let initialDynamicRules = [];
  let initialSessionRules = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    initialDynamicRules = await chrome.declarativeNetRequest.getDynamicRules();
    initialSessionRules = typeof chrome.declarativeNetRequest.getSessionRules === "function"
      ? await chrome.declarativeNetRequest.getSessionRules()
      : null;
    if (initialDynamicRules.some((rule) => Number(rule?.id) === 9001)
      && Array.isArray(initialSessionRules)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const unexpectedInitialRules = initialDynamicRules.filter((rule) => (
    Number(rule?.id) !== 9001 && !staleRuleIds.includes(Number(rule?.id))
  ));
  if (!Array.isArray(initialSessionRules) || initialSessionRules.length !== 0
    || unexpectedInitialRules.length !== 0) {
    return { error: "bootstrap initial DNR state contains an unknown dynamic/session rule" };
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: staleRuleIds,
    addRules: [],
  });
  const preProbeDynamicRules = await chrome.declarativeNetRequest.getDynamicRules();
  const preProbeSessionRules = typeof chrome.declarativeNetRequest.getSessionRules === "function"
    ? await chrome.declarativeNetRequest.getSessionRules()
    : null;
  if (preProbeDynamicRules.length !== 1 || Number(preProbeDynamicRules[0]?.id) !== 9001
    || !Array.isArray(preProbeSessionRules) || preProbeSessionRules.length !== 0) {
    return { error: "bootstrap could not clear every prior audited rule before the resolver probe" };
  }
  let protectedReadProbeBlocked = false;
  try {
    await fetch("https://api.maozierp.com/api.exchange_rate/index", {
      method: "OPTIONS",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    protectedReadProbeBlocked = true;
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [lockdownRule.id],
    addRules: [lockdownRule],
  });
  let dynamicRules = [];
  let sessionRules = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    dynamicRules = await chrome.declarativeNetRequest.getDynamicRules();
    sessionRules = typeof chrome.declarativeNetRequest.getSessionRules === "function"
      ? await chrome.declarativeNetRequest.getSessionRules()
      : null;
    if (dynamicRules.some((rule) => Number(rule?.id) === 9001)
      && dynamicRules.some((rule) => Number(rule?.id) === Number(lockdownRule.id))
      && Array.isArray(sessionRules)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    dynamicRules,
    sessionRules,
    preProbeSafeRule: preProbeDynamicRules[0],
    auditedRulesClearedBeforeProbe: true,
    protectedReadProbeBlocked,
  };
}

export async function auditExtensionBootstrapLockdown(context, options = {}) {
  const lockdownRule = auditedBootstrapLockdownDnrRule();
  const evaluationTimeoutMs = Number(options.evaluationTimeoutMs
    ?? AUDITED_EXTENSION_POSTFLIGHT_EVALUATION_TIMEOUT_MS);
  if (!Number.isInteger(evaluationTimeoutMs) || evaluationTimeoutMs < 1
    || evaluationTimeoutMs > AUDITED_EXTENSION_POSTFLIGHT_EVALUATION_TIMEOUT_MS) {
    throw cliError(`extension bootstrap evaluation timeout must be 1-${AUDITED_EXTENSION_POSTFLIGHT_EVALUATION_TIMEOUT_MS}ms`);
  }
  let result;
  try {
    const worker = auditedExtensionWorker(context);
    const evaluation = worker.evaluate(auditedExtensionBootstrapDnrWorkerAudit, {
      lockdownRule,
      staleRuleIds: [
        AUDITED_DNR_LOCKDOWN_RULE_ID,
        ...Array.from({ length: 100 }, (_unused, index) => AUDITED_DNR_FIRST_RULE_ID + index),
      ],
    });
    result = await boundedAuditedOperation(
      evaluation,
      evaluationTimeoutMs,
      () => cliError("extension bootstrap worker audit timed out"),
      options.setTimeoutFn || setTimeout,
      options.clearTimeoutFn || clearTimeout,
    );
  } catch {
    throw extensionPreflightError(
      AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.BOOTSTRAP_DNR_STATE_MISSING,
      null,
      "preflight",
    );
  }
  const dynamicRules = result?.dynamicRules || [];
  const sessionRules = result?.sessionRules;
  const lockdownRows = dynamicRules.filter((rule) => Number(rule?.id) === AUDITED_DNR_LOCKDOWN_RULE_ID);
  const safeRows = dynamicRules.filter((rule) => Number(rule?.id) === 9001);
  if (!Array.isArray(sessionRules) || sessionRules.length !== 0
    || result?.auditedRulesClearedBeforeProbe !== true
    || result?.protectedReadProbeBlocked !== true
    || dynamicRules.length !== 2
    || lockdownRows.length !== 1
    || auditedDnrRuleSetDigest(lockdownRows) !== auditedDnrRuleSetDigest([lockdownRule])
    || safeRows.length !== 1
    || !isPinnedSafeDynamicRule9001(safeRows[0])
    || !isPinnedSafeDynamicRule9001(result?.preProbeSafeRule)) {
    throw extensionPreflightError(
      AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.BOOTSTRAP_DNR_STATE_MISSING,
      null,
      "preflight",
    );
  }
  return Object.freeze({
    contract: "ozon-audited-validation-bootstrap-lockdown-v1",
    host_resolver_blocked_before_dnr: true,
    prior_audited_rules_cleared_before_probe: true,
    protected_read_probe_blocked_before_dnr: true,
    persisted_full_host_lockdown: true,
    session_rules_empty: true,
    pinned_safe_rule_9001_audited: true,
    lockdown_rule_sha256: auditedDnrRuleSetDigest([lockdownRule]),
  });
}

async function auditedExtensionDnrWorkerAudit({
  expectedRules,
  bootstrapLockdownRule,
  staleRuleIds,
  install,
  sku3ProbeSku,
  mutationPathKinds,
  maoziReadAllowlist,
  externalMutationRules,
  smokeProbeCatalog,
  smokeProbeCatalogSha256,
  smokeDrainTimeoutMs,
  auditNonce,
  preflightStage,
  retainNetworkAudit,
}) {
  const ruleIds = expectedRules.map((rule) => rule.id);
  const potentiallyOverlapsProtectedHosts = (rule) => {
    const action = String(rule?.action?.type || "");
    if (!["allow", "allowAllRequests", "redirect", "upgradeScheme"].includes(action)) return false;
    const domains = rule?.condition?.requestDomains || rule?.condition?.domains || null;
    if (Array.isArray(domains) && domains.length > 0) {
      return domains.some((domain) => {
        const normalized = String(domain || "").replace(/^\*\./u, "").toLowerCase();
        return normalized === "maozierp.com"
          || normalized.endsWith(".maozierp.com")
          || normalized === "seller.ozon.ru";
      });
    }
    // With no positive domain restriction, URL filters can be broad or omit the
    // hostname entirely. Fail closed instead of attempting a partial regex proof.
    return true;
  };
  const isPinnedSafeRule9001 = (rule) => Number(rule?.id) === 9001
    && Number(rule?.priority) === 1
    && String(rule?.action?.type || "") === "modifyHeaders"
    && Array.isArray(rule?.action?.responseHeaders)
    && rule.action.responseHeaders.length === 1
    && String(rule.action.responseHeaders[0]?.header || "").toLowerCase() === "content-security-policy"
    && String(rule.action.responseHeaders[0]?.operation || "") === "remove"
    && String(rule?.condition?.regexFilter || "") === "^https?://([^/]*\\.)?ozon\\.(ru|kz|by)/"
    && Array.isArray(rule?.condition?.resourceTypes)
    && rule.condition.resourceTypes.length === 1
    && rule.condition.resourceTypes[0] === "main_frame";
  const isBootstrapLockdownRule = (rule) => Number(rule?.id) === Number(bootstrapLockdownRule?.id)
    && Number(rule?.priority) === Number(bootstrapLockdownRule?.priority)
    && String(rule?.action?.type || "") === "block"
    && JSON.stringify([...(rule?.condition?.requestDomains || [])].map(String).sort())
      === JSON.stringify([...(bootstrapLockdownRule?.condition?.requestDomains || [])].map(String).sort())
    && JSON.stringify([...(rule?.condition?.resourceTypes || [])].map(String).sort())
      === JSON.stringify([...(bootstrapLockdownRule?.condition?.resourceTypes || [])].map(String).sort())
    && !rule?.condition?.regexFilter
    && !rule?.condition?.requestMethods;
  let initialDynamicRules = await chrome.declarativeNetRequest.getDynamicRules();
  let initialSessionRules = typeof chrome.declarativeNetRequest.getSessionRules === "function"
    ? await chrome.declarativeNetRequest.getSessionRules()
    : null;
  if (install) {
    // The bootstrap run persists a full-host lockdown before any unrestricted
    // browser launch.  Wait briefly for the extension's known-safe 9001 rule,
    // then require that exact two-rule state before installing the observer and
    // atomically switching to the operational deny+read-allow rules.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const safeRules = initialDynamicRules.filter((rule) => Number(rule?.id) === 9001);
      const lockdownRules = initialDynamicRules.filter((rule) => Number(rule?.id) === Number(bootstrapLockdownRule?.id));
      if (safeRules.length === 1 && isPinnedSafeRule9001(safeRules[0])
        && lockdownRules.length === 1
        && isBootstrapLockdownRule(lockdownRules[0])
        && initialDynamicRules.length === 2
        && Array.isArray(initialSessionRules) && initialSessionRules.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      initialDynamicRules = await chrome.declarativeNetRequest.getDynamicRules();
      initialSessionRules = typeof chrome.declarativeNetRequest.getSessionRules === "function"
        ? await chrome.declarativeNetRequest.getSessionRules()
        : null;
    }
    const safeRules = initialDynamicRules.filter((rule) => Number(rule?.id) === 9001);
    const lockdownRules = initialDynamicRules.filter((rule) => Number(rule?.id) === Number(bootstrapLockdownRule?.id));
    if (safeRules.length !== 1 || !isPinnedSafeRule9001(safeRules[0])
      || lockdownRules.length !== 1
      || !isBootstrapLockdownRule(lockdownRules[0])
      || initialDynamicRules.length !== 2
      || !Array.isArray(initialSessionRules) || initialSessionRules.length !== 0) {
      return { failure_code: "extension_preflight_bootstrap_dnr_state_missing" };
    }
  }
  const networkAuditKey = "__ozonAuditedValidationMutationAuditV1";
  let networkAudit = globalThis[networkAuditKey] || null;
  const removeNetworkAudit = () => {
    if (networkAudit?.listener) {
      try { chrome.webRequest.onBeforeRequest.removeListener(networkAudit.listener); } catch {}
    }
    if (globalThis[networkAuditKey]?.nonce === auditNonce) delete globalThis[networkAuditKey];
  };
  if (install) {
    if (networkAudit?.listener) {
      try { chrome.webRequest.onBeforeRequest.removeListener(networkAudit.listener); } catch {}
    }
    const state = {
      nonce: auditNonce,
      total: 0,
      byKind: {},
      byMethodPath: {},
      byScopeKind: { service_worker: {}, page_or_frame: {} },
      activeSmoke: null,
    };
    const listener = (details) => {
      try {
        const parsed = new URL(details.url);
        const hostname = parsed.hostname.toLowerCase();
        const requestPath = parsed.pathname || "/";
        const method = String(details.method || "GET").toUpperCase();
        const maoziHost = hostname === "maozierp.com" || hostname.endsWith(".maozierp.com");
        const canonicalMaoziAuthority = hostname === "api.maozierp.com"
          && parsed.protocol === "https:"
          && !parsed.username
          && !parsed.password
          && !parsed.port;
        const canonicalMaoziRead = hostname === "api.maozierp.com"
          && canonicalMaoziAuthority
          && maoziReadAllowlist.some((rule) => rule.path === requestPath
            && rule.methods.includes(method));
        let kind = maoziHost && !canonicalMaoziRead
          ? (hostname === "api.maozierp.com"
            ? mutationPathKinds[requestPath] || "unknown-maozi-api"
            : "unknown-maozi-host")
          : null;
        if (!kind && hostname === "seller.ozon.ru") {
          const external = externalMutationRules.find((rule) => rule.hostname === parsed.hostname
            && rule.path === requestPath
            && rule.methods.includes(method));
          kind = external ? "external-create-bundle" : "external-protected";
        }
        const scope = Number(details.tabId) < 0
          || String(details.initiator || "").startsWith("chrome-extension://")
          ? "service_worker"
          : "page_or_frame";
        const smoke = state.activeSmoke;
        if (smoke) {
          const nonceValues = parsed.searchParams.getAll(smoke.nonceParam);
          const probeIdValues = parsed.searchParams.getAll(smoke.probeIdParam);
          if (nonceValues.length === 1 && nonceValues[0] === smoke.nonce
            && probeIdValues.length === 1) {
            const probeId = probeIdValues[0];
            const descriptor = smoke.catalogById[probeId];
            const resourceType = String(details.type || "").toLowerCase();
            if (descriptor && method === "OPTIONS"
              && scope === "service_worker"
              && ["xmlhttprequest", "other"].includes(resourceType)
              && !parsed.username && !parsed.password && !parsed.port) {
              const observedScheme = parsed.protocol === "http:"
                ? "http"
                : (parsed.protocol === "https:" ? "https" : null);
              if (observedScheme) {
                const observedSchemes = smoke.observedSchemesByProbe[probeId]
                  || (smoke.observedSchemesByProbe[probeId] = new Set());
                observedSchemes.add(observedScheme);
                // An HTTP request upgraded by HSTS or another rule is useful
                // diagnosis, but not proof of the requested HTTP probe.
                if (observedScheme === descriptor.requested_scheme
                  && hostname === descriptor.hostname
                  && requestPath === descriptor.pathname
                  && kind === descriptor.expected_kind) {
                  const requestId = String(details.requestId ?? "");
                  if (requestId) {
                    const pair = `${probeId}\u0000${requestId}`;
                    if (smoke.seenProbeRequestPairs.has(pair)) {
                      smoke.duplicateRequestCount += 1;
                    } else {
                      smoke.seenProbeRequestPairs.add(pair);
                      smoke.observedProbeIds.add(probeId);
                    }
                  }
                }
              }
            }
          }
        }
        if (!kind) return;
        const key = `${method} ${parsed.protocol}//${hostname}${requestPath}`;
        state.total += 1;
        state.byKind[kind] = (state.byKind[kind] || 0) + 1;
        state.byMethodPath[key] = (state.byMethodPath[key] || 0) + 1;
        state.byScopeKind[scope][kind] = (state.byScopeKind[scope][kind] || 0) + 1;
      } catch {}
    };
    chrome.webRequest.onBeforeRequest.addListener(listener, {
      urls: ["*://maozierp.com/*", "*://*.maozierp.com/*", "*://seller.ozon.ru/*"],
    }, ["extraHeaders"]);
    networkAudit = { nonce: auditNonce, state, listener };
    globalThis[networkAuditKey] = networkAudit;
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: staleRuleIds,
        addRules: expectedRules,
      });
    } catch {
      removeNetworkAudit();
      return { failure_code: "extension_preflight_dnr_ruleset_mismatch" };
    }
  }
  const allDynamicRules = await chrome.declarativeNetRequest.getDynamicRules();
  const allSessionRules = typeof chrome.declarativeNetRequest.getSessionRules === "function"
    ? await chrome.declarativeNetRequest.getSessionRules()
    : null;
  const installedRules = allDynamicRules.filter((rule) => ruleIds.includes(rule.id));
  const safeExistingRules = allDynamicRules.filter((rule) => Number(rule?.id) === 9001);
  const unexpectedDynamicOrSessionRules = [
    ...allDynamicRules.filter((rule) => !ruleIds.includes(rule.id) && !isPinnedSafeRule9001(rule)),
    ...(allSessionRules || []),
  ];
  const conflictingOverrideRules = unexpectedDynamicOrSessionRules
    .filter(potentiallyOverlapsProtectedHosts).map((rule) => ({
      id: Number(rule.id),
      action: String(rule?.action?.type || ""),
      priority: Number(rule?.priority),
    }));
  const networkSnapshot = () => {
    if (!networkAudit || networkAudit.nonce !== auditNonce || networkAudit.state?.nonce !== auditNonce) {
      return { continuous: false, total: null, byKind: null, byMethodPath: null, byScopeKind: null };
    }
    return {
      continuous: true,
      total: Number(networkAudit.state.total),
      byKind: { ...networkAudit.state.byKind },
      byMethodPath: { ...networkAudit.state.byMethodPath },
      byScopeKind: {
        service_worker: { ...networkAudit.state.byScopeKind.service_worker },
        page_or_frame: { ...networkAudit.state.byScopeKind.page_or_frame },
      },
    };
  };
  const dnrState = {
    installedRules,
    conflictingOverrideRules,
    unexpectedDynamicOrSessionRules: unexpectedDynamicOrSessionRules.map((rule) => ({
      id: Number(rule?.id),
      action: String(rule?.action?.type || ""),
      priority: Number(rule?.priority),
    })),
    pinnedSafeRule9001Audited: safeExistingRules.length === 1 && isPinnedSafeRule9001(safeExistingRules[0]),
    sessionRulesAudited: Array.isArray(allSessionRules),
  };
  if (preflightStage === "observer-bound") {
    return {
      ...dnrState,
      webRequestAfterSmoke: networkSnapshot(),
    };
  }
  const matchedSnapshot = async () => {
    if (typeof chrome.declarativeNetRequest.getMatchedRules !== "function") {
      return { available: false, counts: null, reason: "api-unavailable" };
    }
    try {
      const matched = await chrome.declarativeNetRequest.getMatchedRules();
      const counts = Object.fromEntries(ruleIds.map((id) => [String(id), 0]));
      for (const row of matched?.rulesMatchedInfo || []) {
        const id = Number(row?.rule?.ruleId);
        if (ruleIds.includes(id)) counts[String(id)] += 1;
      }
      return { available: true, counts, reason: null };
    } catch {
      return { available: false, counts: null, reason: "declarativeNetRequestFeedback-not-granted" };
    }
  };
  const matchedBeforeSmoke = await matchedSnapshot();
  const webRequestBeforeSmoke = networkSnapshot();
  const requestedSchemeCounts = (smokeProbeCatalog || []).reduce((counts, descriptor) => {
    const scheme = String(descriptor?.requested_scheme || "");
    if (scheme === "http" || scheme === "https") counts[scheme] += 1;
    return counts;
  }, { http: 0, https: 0 });
  const catalogIds = new Set((smokeProbeCatalog || []).map((descriptor) => descriptor?.probe_id));
  const smokeCatalogValid = Array.isArray(smokeProbeCatalog)
    && smokeProbeCatalog.length === 38
    && catalogIds.size === smokeProbeCatalog.length
    && requestedSchemeCounts.http === 17
    && requestedSchemeCounts.https === 21
    && (smokeProbeCatalog || []).every((descriptor) => (
      descriptor && typeof descriptor === "object"
      && /^[a-z0-9-]+$/u.test(String(descriptor.probe_id || ""))
      && ["mutation", "ambiguous"].includes(descriptor.coverage)
      && ["http", "https"].includes(descriptor.requested_scheme)
      && descriptor.allow_http_to_https === false
      && ["api.maozierp.com", "maozierp.com", "sidecar.maozierp.com"].includes(descriptor.hostname)
      && String(descriptor.pathname || "").startsWith("/")
      && typeof descriptor.expected_kind === "string"
      && descriptor.expected_kind.length > 0
    ))
    && typeof smokeProbeCatalogSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(smokeProbeCatalogSha256)
    && Number.isInteger(smokeDrainTimeoutMs)
    && smokeDrainTimeoutMs >= 500
    && smokeDrainTimeoutMs <= 1_000;
  if (!smokeCatalogValid) {
    return { failure_code: "extension_audit_web_request_smoke_incomplete" };
  }
  let workerCatalogSha256 = null;
  try {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(smokeProbeCatalog)),
    );
    workerCatalogSha256 = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    return { failure_code: "extension_audit_web_request_smoke_incomplete" };
  }
  if (workerCatalogSha256 !== smokeProbeCatalogSha256) {
    return { failure_code: "extension_audit_web_request_smoke_incomplete" };
  }
  const randomBytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    return { failure_code: "extension_audit_web_request_smoke_incomplete" };
  }
  globalThis.crypto.getRandomValues(randomBytes);
  const smokeNonce = [...randomBytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  const smokeNonceParam = "__ozon_audit_smoke_nonce";
  const smokeProbeIdParam = "__ozon_audit_smoke_probe";
  const activeSmoke = {
    nonce: smokeNonce,
    nonceParam: smokeNonceParam,
    probeIdParam: smokeProbeIdParam,
    catalogById: Object.fromEntries(smokeProbeCatalog.map((descriptor) => [descriptor.probe_id, descriptor])),
    seenProbeRequestPairs: new Set(),
    observedProbeIds: new Set(),
    observedSchemesByProbe: {},
    duplicateRequestCount: 0,
  };
  networkAudit.state.activeSmoke = activeSmoke;
  const smokeUrlFor = (descriptor) => {
    const parsed = new URL(`${descriptor.requested_scheme}://${descriptor.hostname}${descriptor.pathname}`);
    parsed.searchParams.set(smokeNonceParam, smokeNonce);
    parsed.searchParams.set(smokeProbeIdParam, descriptor.probe_id);
    return parsed.toString();
  };
  const runBlockedSmoke = async (descriptor) => {
    let blocked = false;
    try {
      // OPTIONS carries no ERP payload or credentials. A network response means
      // this protected URL escaped the service-worker DNR full-host default deny.
      await fetch(smokeUrlFor(descriptor), {
        method: "OPTIONS",
        credentials: "omit",
        cache: "no-store",
        redirect: "manual",
      });
    } catch {
      blocked = true;
    }
    return blocked;
  };
  const smokeFetchResults = await Promise.all(smokeProbeCatalog.map(async (descriptor) => ({
    probe_id: descriptor.probe_id,
    blocked: await runBlockedSmoke(descriptor),
  })));
  const blockedProbeIds = new Set(smokeFetchResults
    .filter((row) => row.blocked === true).map((row) => row.probe_id));
  const mutationPaths = Object.keys(mutationPathKinds).sort();
  const protectedSmokeBlockedPaths = smokeProbeCatalog.filter((descriptor) => (
    descriptor.coverage === "mutation"
    && descriptor.requested_scheme === "https"
    && blockedProbeIds.has(descriptor.probe_id)
  )).map((descriptor) => descriptor.pathname).sort();
  const httpProtectedSmokeBlockedPaths = smokeProbeCatalog.filter((descriptor) => (
    descriptor.coverage === "mutation"
    && descriptor.requested_scheme === "http"
    && blockedProbeIds.has(descriptor.probe_id)
  )).map((descriptor) => descriptor.pathname).sort();
  const ambiguousDescriptors = smokeProbeCatalog.filter((descriptor) => descriptor.coverage === "ambiguous");
  const ambiguousSmokeUrls = ambiguousDescriptors.map((descriptor) => (
    `${descriptor.requested_scheme}://${descriptor.hostname}${descriptor.pathname}`
  ));
  const ambiguousSmokeBlockedUrls = ambiguousDescriptors
    .filter((descriptor) => blockedProbeIds.has(descriptor.probe_id))
    .map((descriptor) => `${descriptor.requested_scheme}://${descriptor.hostname}${descriptor.pathname}`);
  const checkDataSmokeBlocked = protectedSmokeBlockedPaths.includes("/api.chrome/check_data");
  const drainStartedAt = Date.now();
  while (activeSmoke.observedProbeIds.size < smokeProbeCatalog.length
    && Date.now() - drainStartedAt < smokeDrainTimeoutMs) {
    const remainingMs = smokeDrainTimeoutMs - (Date.now() - drainStartedAt);
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, remainingMs))));
  }
  const drainElapsedMs = Math.min(1_000, Math.max(0, Date.now() - drainStartedAt));
  const missingSmokeProbes = smokeProbeCatalog.filter((descriptor) => (
    !activeSmoke.observedProbeIds.has(descriptor.probe_id)
  )).map((descriptor) => ({
    probe_id: descriptor.probe_id,
    observed_schemes: [...(activeSmoke.observedSchemesByProbe[descriptor.probe_id] || [])].sort(),
  }));
  const observedSchemeCounts = smokeProbeCatalog.reduce((counts, descriptor) => {
    const schemes = activeSmoke.observedSchemesByProbe[descriptor.probe_id] || new Set();
    if (schemes.has("http")) counts.http += 1;
    if (schemes.has("https")) counts.https += 1;
    if (descriptor.requested_scheme === "http" && schemes.has("https")) counts.httpToHttps += 1;
    return counts;
  }, { http: 0, https: 0, httpToHttps: 0 });
  const webRequestSmokeDiagnostics = {
    smokeProbeCatalogSha256,
    smokeProbeExpectedCount: smokeProbeCatalog.length,
    smokeProbeObservedCount: activeSmoke.observedProbeIds.size,
    smokeProbeMissing: missingSmokeProbes,
    smokeProbeSchemeCounts: {
      requested_http: requestedSchemeCounts.http,
      requested_https: requestedSchemeCounts.https,
      observed_http: observedSchemeCounts.http,
      observed_https: observedSchemeCounts.https,
      http_to_https: observedSchemeCounts.httpToHttps,
    },
    smokeProbeDuplicateRequestCount: activeSmoke.duplicateRequestCount,
    smokeProbeDrainElapsedMs: drainElapsedMs,
    smokeProbeDrainTimedOut: missingSmokeProbes.length > 0,
  };
  networkAudit.state.activeSmoke = null;
  const webRequestAfterSmoke = networkSnapshot();
  const storage = await chrome.storage.local.get(["productSelectionRules", "maozierp-token"]);
  let selectionRules = storage.productSelectionRules ?? null;
  if (typeof selectionRules === "string" && selectionRules.trim()) {
    try { selectionRules = JSON.parse(selectionRules); }
    catch {
      removeNetworkAudit();
      return { failure_code: "extension_preflight_product_rules_json_invalid" };
    }
  }
  const autoFavoriteValues = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Object.hasOwn(value, "auto_favorite")) autoFavoriteValues.push(value.auto_favorite);
    for (const child of Object.values(value)) visit(child);
  };
  visit(selectionRules);
  const token = String(storage["maozierp-token"] || "").trim();
  if (!token) {
    removeNetworkAudit();
    return { failure_code: "extension_preflight_token_missing" };
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Client: "plugin",
    "Plugin-Version": chrome.runtime.getManifest().version,
  };
  let rateStatus = null;
  let rateJson = null;
  let sku3Status = null;
  let sku3Json = null;
  try {
    const rateResponse = await fetch("https://api.maozierp.com/api.exchange_rate/index", {
      method: "POST",
      headers,
      body: JSON.stringify({ currency_from: "RUB" }),
      redirect: "error",
    });
    rateStatus = rateResponse.status;
    rateJson = await rateResponse.json();
  } catch {
    removeNetworkAudit();
    return {
      failure_code: "extension_preflight_read_api_transport_failure",
      preflight_step: "exchange_rate_transport",
    };
  }
  try {
    const sku3Response = await fetch(`https://api.maozierp.com/api.chrome/sku3?sku=${encodeURIComponent(sku3ProbeSku)}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sku: sku3ProbeSku }),
      redirect: "error",
    });
    sku3Status = sku3Response.status;
    sku3Json = await sku3Response.json();
  } catch {
    removeNetworkAudit();
    return {
      failure_code: "extension_preflight_read_api_transport_failure",
      preflight_step: "sku3_transport",
    };
  }
  // The smoke snapshots remain dedicated to observer completeness.  The
  // operational baseline is taken only after the allowlisted reads (and any
  // browser-visible CORS OPTIONS they may generate), so those setup requests
  // cannot become false operation-time mutation deltas.
  const webRequestOperationalBaseline = networkSnapshot();
  const matchedAfterSmoke = await matchedSnapshot();
  if (!install && retainNetworkAudit !== true) removeNetworkAudit();
  return {
    ...dnrState,
    rulesPresent: selectionRules !== null,
    autoFavoriteValues,
    checkDataSmokeBlocked,
    protectedSmokeBlockedPaths,
    httpProtectedSmokeBlockedPaths,
    ambiguousSmokeBlockedUrls,
    expectedAmbiguousSmokeUrls: ambiguousSmokeUrls,
    matchedBeforeSmoke,
    matchedAfterSmoke,
    webRequestBeforeSmoke,
    webRequestAfterSmoke,
    webRequestOperationalBaseline,
    webRequestSmokeObserved: missingSmokeProbes.length === 0,
    webRequestSmokeDiagnostics,
    rateStatus,
    rateCode: Number(rateJson?.code),
    rubCny: Number(rateJson?.data?.RUBCNY?.value ?? rateJson?.data?.CNY?.value),
    sku3Status,
    sku3Code: Number(sku3Json?.code),
  };
}

function validateExtensionDnrStateAudit(result, expectedRules, auditPhase) {
  if (result?.failure_code) {
    throw extensionPreflightError(result.failure_code, result.preflight_step, auditPhase, result);
  }
  if (result?.error) {
    throw extensionPreflightError(AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.UNKNOWN, null, auditPhase);
  }
  const expectedDigest = auditedDnrRuleSetDigest(expectedRules);
  const installedDigest = auditedDnrRuleSetDigest(result?.installedRules || []);
  if ((result?.installedRules || []).length !== expectedRules.length || installedDigest !== expectedDigest) {
    throw extensionPreflightError(AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.DNR_RULESET_MISMATCH, null, auditPhase);
  }
  if (result.sessionRulesAudited !== true
    || result.pinnedSafeRule9001Audited !== true
    || (result.unexpectedDynamicOrSessionRules || []).length !== 0
    || (result.conflictingOverrideRules || []).length !== 0) {
    throw extensionPreflightError(AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.DNR_OVERRIDE_CONFLICT, null, auditPhase);
  }
  return Object.freeze({ expectedDigest, installedDigest });
}

function validateExtensionDnrAudit(result, expectedRules, auditPhase) {
  const digest = validateExtensionDnrStateAudit(result, expectedRules, auditPhase);
  if (result.checkDataSmokeBlocked !== true) {
    throw extensionPreflightError(AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.CHECK_DATA_SMOKE_ESCAPE, null, auditPhase);
  }
  if ((result.protectedSmokeBlockedPaths || []).length !== AUDITED_MUTATION_ENDPOINTS.length
    || AUDITED_MUTATION_ENDPOINTS.some((requestPath) => !result.protectedSmokeBlockedPaths.includes(requestPath))) {
    throw extensionPreflightError(AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.MUTATION_SMOKE_ESCAPE, null, auditPhase);
  }
  if ((result.httpProtectedSmokeBlockedPaths || []).length !== AUDITED_MUTATION_ENDPOINTS.length
    || AUDITED_MUTATION_ENDPOINTS.some((requestPath) => !result.httpProtectedSmokeBlockedPaths.includes(requestPath))) {
    throw extensionPreflightError(AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.HTTP_SMOKE_ESCAPE, null, auditPhase);
  }
  if ((result.expectedAmbiguousSmokeUrls || []).length < 3
    || result.ambiguousSmokeBlockedUrls?.length !== result.expectedAmbiguousSmokeUrls.length
    || result.expectedAmbiguousSmokeUrls.some((url) => !result.ambiguousSmokeBlockedUrls.includes(url))) {
    throw extensionPreflightError(AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.AMBIGUOUS_PATH_SMOKE_ESCAPE, null, auditPhase);
  }
  if (result.webRequestBeforeSmoke?.continuous !== true
    || result.webRequestAfterSmoke?.continuous !== true
    || result.webRequestOperationalBaseline?.continuous !== true) {
    throw extensionPreflightError(
      AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
      null,
      auditPhase,
    );
  }
  const smokeEvidence = sanitizedWebRequestSmokeEvidence(result);
  if (result.webRequestSmokeObserved !== true
    || !smokeEvidence
    || smokeEvidence.smoke_probe_observed_count !== smokeEvidence.smoke_probe_expected_count
    || smokeEvidence.smoke_probe_missing.length !== 0
    || smokeEvidence.smoke_probe_drain_timed_out !== false) {
    throw extensionPreflightError(
      AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_SMOKE_INCOMPLETE,
      null,
      auditPhase,
      result,
    );
  }
  if (!(Number(result.sku3Status) >= 200 && Number(result.sku3Status) < 300
    && Number(result.sku3Code) === 1)) {
    throw extensionPreflightError(AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.SKU3_READ_FAILURE, null, auditPhase);
  }
  if (!(Number(result.rateStatus) >= 200 && Number(result.rateStatus) < 300
    && Number(result.rateCode) === 1 && Number(result.rubCny) > 0)) {
    throw extensionPreflightError(AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.EXCHANGE_RATE_READ_FAILURE, null, auditPhase);
  }
  return digest;
}

async function runExtensionDnrAudit(context, {
  install,
  auditNonce,
  preflightStage = "complete",
  retainNetworkAudit = false,
  stateOnly = false,
  auditPhase = "preflight",
  evaluationTimeoutMs = AUDITED_EXTENSION_POSTFLIGHT_EVALUATION_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  const expectedRules = auditedDynamicDnrRules();
  if (!Number.isInteger(evaluationTimeoutMs) || evaluationTimeoutMs < 1
    || evaluationTimeoutMs > AUDITED_EXTENSION_POSTFLIGHT_EVALUATION_TIMEOUT_MS) {
    throw cliError(`extension worker evaluation timeout must be 1-${AUDITED_EXTENSION_POSTFLIGHT_EVALUATION_TIMEOUT_MS}ms`);
  }
  let result;
  try {
    const worker = auditedExtensionWorker(context);
    const evaluation = worker.evaluate(auditedExtensionDnrWorkerAudit, {
      expectedRules,
      bootstrapLockdownRule: auditedBootstrapLockdownDnrRule(),
      staleRuleIds: [
        AUDITED_DNR_LOCKDOWN_RULE_ID,
        ...Array.from({ length: 100 }, (_unused, index) => AUDITED_DNR_FIRST_RULE_ID + index),
      ],
      install,
      sku3ProbeSku: AUDITED_SKU3_PROBE_SKU,
      mutationPathKinds: Object.fromEntries(AUDITED_MUTATION_ENDPOINTS.map((requestPath) => [
        requestPath,
        auditedMutationKind("api.maozierp.com", requestPath),
      ])),
      maoziReadAllowlist: AUDITED_MAOZI_API_ALLOWLIST,
      externalMutationRules: AUDITED_EXTERNAL_MUTATION_RULES,
      smokeProbeCatalog: AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG,
      smokeProbeCatalogSha256: AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG_SHA256,
      smokeDrainTimeoutMs: AUDITED_WEB_REQUEST_SMOKE_DRAIN_TIMEOUT_MS,
      auditNonce,
      preflightStage,
      retainNetworkAudit,
    });
    result = await boundedAuditedOperation(
      evaluation,
      evaluationTimeoutMs,
      () => extensionPreflightError(
        AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
        null,
        auditPhase,
      ),
      setTimeoutFn,
      clearTimeoutFn,
    );
  } catch {
    throw extensionPreflightError(
      AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
      null,
      auditPhase,
    );
  }
  const digest = stateOnly
    ? validateExtensionDnrStateAudit(result, expectedRules, auditPhase)
    : validateExtensionDnrAudit(result, expectedRules, auditPhase);
  return { result, expectedRules, digest };
}

async function removeAuditedExtensionPreflightObserver(context, auditNonce, options = {}) {
  try {
    const worker = auditedExtensionWorker(context);
    const evaluation = worker.evaluate(({ nonce }) => {
      const key = "__ozonAuditedValidationMutationAuditV1";
      const audit = globalThis[key];
      if (audit?.nonce !== nonce) return false;
      if (audit.listener) {
        try { chrome.webRequest.onBeforeRequest.removeListener(audit.listener); } catch {}
      }
      delete globalThis[key];
      return true;
    }, { nonce: auditNonce });
    await boundedAuditedOperation(
      evaluation,
      Number(options.evaluationTimeoutMs ?? 2_000),
      () => cliError("extension observer cleanup timed out"),
      options.setTimeoutFn || setTimeout,
      options.clearTimeoutFn || clearTimeout,
    );
  } catch {}
}

export async function auditExtensionSafetyAndRate(context, {
  onObserverBound = null,
  evaluationTimeoutMs = AUDITED_EXTENSION_POSTFLIGHT_EVALUATION_TIMEOUT_MS,
  observerCleanupTimeoutMs = 2_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const auditNonce = crypto.randomBytes(16).toString("hex");
  try {
    const observer = await runExtensionDnrAudit(context, {
    install: true,
    auditNonce,
    preflightStage: "observer-bound",
      retainNetworkAudit: true,
      stateOnly: true,
      evaluationTimeoutMs,
      setTimeoutFn,
      clearTimeoutFn,
  });
  if (observer.result.webRequestAfterSmoke?.continuous !== true) {
    throw extensionPreflightError(AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
  }
  if (typeof onObserverBound === "function") {
    await onObserverBound(Object.freeze({
      observer_bound: observer.result.webRequestAfterSmoke?.continuous === true,
      dnr_rules_exact: true,
      dnr_rule_set_sha256: observer.digest.installedDigest,
    }));
  }
  const { result, expectedRules, digest } = await runExtensionDnrAudit(context, {
    install: false,
    auditNonce,
    retainNetworkAudit: true,
    evaluationTimeoutMs,
    setTimeoutFn,
    clearTimeoutFn,
  });
  if ((result.autoFavoriteValues || []).some((value) => value === 1
    || value === true
    || value === "1"
    || String(value).toLowerCase() === "true")) {
    throw extensionPreflightError(AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.AUTO_FAVORITE_ENABLED);
  }
    return Object.freeze({
    maozi_api_policy: "explicit-path-method-read-allowlist-default-deny",
    allowed_maozi_read_count: AUDITED_MAOZI_API_ALLOWLIST.length,
    explicit_mutation_inventory_count: AUDITED_MUTATION_ENDPOINTS.length,
    external_mutation_rule_count: AUDITED_EXTERNAL_MUTATION_RULES.length,
    product_selection_rules_present: result.rulesPresent,
    auto_favorite_enabled: false,
    current_exchange_rate_api_ok: true,
    exchange_rate_observed: Number(result.rubCny),
    exchange_rate_observed_at: new Date().toISOString(),
    exchange_rate_used_for_candidates: false,
    dnr_rule_set_sha256: digest.installedDigest,
    dnr_protected_rule_ids: Object.freeze(expectedRules.map((rule) => rule.id)),
    dnr_block_rule_ids: Object.freeze(expectedRules.filter((rule) => rule.action.type === "block").map((rule) => rule.id)),
    dnr_rules_exact: true,
    dnr_persisted_lockdown_observed_before_operational_switch: true,
    dnr_no_conflicting_dynamic_or_session_overrides: true,
    dnr_check_data_network_smoke_blocked: true,
    dnr_all_protected_maozi_path_smokes_blocked: true,
    dnr_http_maozi_path_smokes_blocked: true,
    dnr_ambiguous_maozi_path_smokes_blocked: true,
    dnr_pinned_safe_rule_9001_audited: true,
    dnr_sku3_post_read_smoke_ok: true,
    dnr_match_telemetry_available: result.matchedAfterSmoke?.available === true,
    dnr_matched_rule_counts_baseline: result.matchedAfterSmoke?.available === true
      ? Object.freeze({ ...result.matchedAfterSmoke.counts })
      : null,
    dnr_match_telemetry_unavailable_reason: result.matchedAfterSmoke?.available === true
      ? null
      : result.matchedAfterSmoke?.reason || "unavailable",
    web_request_audit_nonce: auditNonce,
    web_request_audit_continuous: result.webRequestOperationalBaseline?.continuous === true,
    web_request_mutation_attempts_baseline: result.webRequestOperationalBaseline?.continuous === true
      ? Number(result.webRequestOperationalBaseline.total)
      : null,
    web_request_mutation_by_kind_baseline: result.webRequestOperationalBaseline?.continuous === true
      ? Object.freeze({ ...result.webRequestOperationalBaseline.byKind })
      : null,
    web_request_audit_snapshot_baseline: result.webRequestOperationalBaseline?.continuous === true
      ? Object.freeze({
        total: Number(result.webRequestOperationalBaseline.total),
        by_kind: Object.freeze({ ...result.webRequestOperationalBaseline.byKind }),
        by_scope_kind: Object.freeze({
          service_worker: Object.freeze({ ...result.webRequestOperationalBaseline.byScopeKind?.service_worker }),
          page_or_frame: Object.freeze({ ...result.webRequestOperationalBaseline.byScopeKind?.page_or_frame }),
        }),
      })
      : null,
    });
  } catch (error) {
    await removeAuditedExtensionPreflightObserver(context, auditNonce, {
      evaluationTimeoutMs: observerCleanupTimeoutMs,
      setTimeoutFn,
      clearTimeoutFn,
    });
    const failure = auditedExtensionPreflightFailureEvidence(error, "preflight");
    throw extensionPreflightError(
      failure.failure_code,
      failure.preflight_step,
      failure.audit_phase,
      failure,
    );
  }
}

export async function auditExtensionFirewallPostflight(context, preflight, options = {}) {
  const evaluationTimeoutMs = Number(options.evaluationTimeoutMs
    ?? AUDITED_EXTENSION_POSTFLIGHT_EVALUATION_TIMEOUT_MS);
  if (!Number.isInteger(evaluationTimeoutMs) || evaluationTimeoutMs < 1
    || evaluationTimeoutMs > AUDITED_EXTENSION_POSTFLIGHT_EVALUATION_TIMEOUT_MS) {
    throw cliError(`extension postflight evaluation timeout must be 1-${AUDITED_EXTENSION_POSTFLIGHT_EVALUATION_TIMEOUT_MS}ms`);
  }
  const { result, expectedRules, digest } = await runExtensionDnrAudit(context, {
    install: false,
    auditNonce: preflight?.web_request_audit_nonce,
    auditPhase: "postflight",
    evaluationTimeoutMs,
    setTimeoutFn: options.setTimeoutFn || setTimeout,
    clearTimeoutFn: options.clearTimeoutFn || clearTimeout,
  });
  if (preflight?.dnr_rules_exact !== true
    || digest.installedDigest !== preflight.dnr_rule_set_sha256) {
    throw extensionPreflightError(
      AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.DNR_RULESET_MISMATCH,
      null,
      "postflight",
    );
  }
  const feedbackAvailable = preflight.dnr_match_telemetry_available === true
    && result.matchedBeforeSmoke?.available === true;
  const deltas = feedbackAvailable
    ? Object.fromEntries(expectedRules.map((rule) => {
      const key = String(rule.id);
      return [key, Math.max(0,
        Number(result.matchedBeforeSmoke.counts?.[key] || 0)
        - Number(preflight.dnr_matched_rule_counts_baseline?.[key] || 0))];
    }))
    : null;
  const webRequestContinuous = preflight?.web_request_audit_continuous === true
    && result.webRequestBeforeSmoke?.continuous === true;
  const mutationKindDeltas = webRequestContinuous
    ? Object.fromEntries([...new Set([
      ...Object.keys(preflight.web_request_mutation_by_kind_baseline || {}),
      ...Object.keys(result.webRequestBeforeSmoke.byKind || {}),
    ])].map((kind) => [kind, Math.max(0,
      Number(result.webRequestBeforeSmoke.byKind?.[kind] || 0)
      - Number(preflight.web_request_mutation_by_kind_baseline?.[kind] || 0))]))
    : null;
  const scopeKindDeltas = webRequestContinuous
    ? Object.fromEntries(["service_worker", "page_or_frame"].map((scope) => [
      scope,
      Object.fromEntries([...new Set([
        ...Object.keys(preflight.web_request_audit_snapshot_baseline?.by_scope_kind?.[scope] || {}),
        ...Object.keys(result.webRequestBeforeSmoke.byScopeKind?.[scope] || {}),
      ])].map((kind) => [kind, Math.max(0,
        Number(result.webRequestBeforeSmoke.byScopeKind?.[scope]?.[kind] || 0)
        - Number(preflight.web_request_audit_snapshot_baseline?.by_scope_kind?.[scope]?.[kind] || 0))])),
    ]))
    : null;
  const stateMutationKinds = mutationKindDeltas
    ? Object.keys(mutationKindDeltas).filter((kind) => kind !== "analytics-upload")
    : [];
  const attemptedMutations = mutationKindDeltas
    ? stateMutationKinds.reduce((sum, kind) => sum + Number(mutationKindDeltas[kind] || 0), 0)
    : null;
  const serviceWorkerMutationAttempts = scopeKindDeltas
    ? stateMutationKinds.reduce((sum, kind) => sum + Number(scopeKindDeltas.service_worker?.[kind] || 0), 0)
    : null;
  const analyticsUploadAttempts = mutationKindDeltas
    ? Number(mutationKindDeltas["analytics-upload"] || 0)
    : null;
  return Object.freeze({
    dnr_rule_set_sha256: digest.installedDigest,
    dnr_rules_exact: true,
    dnr_no_conflicting_dynamic_or_session_overrides: true,
    dnr_check_data_network_smoke_blocked: true,
    dnr_all_protected_maozi_path_smokes_blocked: true,
    dnr_http_maozi_path_smokes_blocked: true,
    dnr_ambiguous_maozi_path_smokes_blocked: true,
    dnr_pinned_safe_rule_9001_audited: true,
    dnr_sku3_post_read_smoke_ok: true,
    dnr_match_telemetry_available: feedbackAvailable,
    dnr_matched_rule_count_deltas: deltas ? Object.freeze(deltas) : null,
    dnr_match_telemetry_unavailable_reason: feedbackAvailable
      ? null
      : result.matchedBeforeSmoke?.reason || preflight?.dnr_match_telemetry_unavailable_reason || "unavailable",
    web_request_audit_continuous: webRequestContinuous,
    all_contexts_state_mutation_attempts_observed: attemptedMutations,
    service_worker_state_mutation_attempts_observed: serviceWorkerMutationAttempts,
    protected_analytics_upload_attempts_observed: analyticsUploadAttempts,
    all_contexts_protected_attempts_by_kind: mutationKindDeltas
      ? Object.freeze(mutationKindDeltas)
      : null,
    all_contexts_protected_attempts_by_scope_kind: scopeKindDeltas
      ? Object.freeze({
        service_worker: Object.freeze(scopeKindDeltas.service_worker),
        page_or_frame: Object.freeze(scopeKindDeltas.page_or_frame),
      })
      : null,
  });
}

function auditedExtensionWorker(context) {
  const worker = (typeof context?.serviceWorkers === "function" ? context.serviceWorkers() : [])
    .find((candidate) => {
      try { return new URL(String(candidate?.url?.() || "")).hostname === AUDITED_EXTENSION_ID; }
      catch { return false; }
    });
  if (!worker || typeof worker.evaluate !== "function") {
    throw cliError("pinned Maozi extension service worker is unavailable");
  }
  return worker;
}

export const AUDITED_EXTENSION_OBSERVER_HEARTBEAT_INTERVAL_MS = 5_000;
export const AUDITED_EXTENSION_POSTFLIGHT_EVALUATION_TIMEOUT_MS = 10_000;
const AUDITED_OWNED_LIFECYCLE_EMIT_TIMEOUT_MS = 5_000;

function boundedAuditedOperation(
  operation,
  timeoutMs,
  timeoutErrorFactory,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
) {
  let timer = null;
  return new Promise((resolve, reject) => {
    timer = setTimeoutFn(() => reject(timeoutErrorFactory()), timeoutMs);
    Promise.resolve(operation).then(resolve, reject).finally(() => {
      if (timer !== null) clearTimeoutFn(timer);
    });
  });
}

function boundedObserverHeartbeatOperation(
  operation,
  timeoutMs,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
) {
  return boundedAuditedOperation(
    operation,
    timeoutMs,
    () => extensionPreflightError(
      AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
      null,
      "postflight",
    ),
    setTimeoutFn,
    clearTimeoutFn,
  );
}

async function auditExtensionObserverHeartbeat(context, expectedWorker, auditNonce, options = {}) {
  let worker;
  try { worker = auditedExtensionWorker(context); }
  catch {
    throw extensionPreflightError(
      AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
      null,
      "postflight",
    );
  }
  if (worker !== expectedWorker) {
    throw extensionPreflightError(
      AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
      null,
      "postflight",
    );
  }
  let evidence;
  try {
    const evaluation = worker.evaluate(({ nonce }) => {
      const audit = globalThis.__ozonAuditedValidationMutationAuditV1;
      const listenerRegistered = Boolean(audit?.listener)
        && typeof chrome.webRequest.onBeforeRequest.hasListener === "function"
        && chrome.webRequest.onBeforeRequest.hasListener(audit.listener) === true;
      return {
        nonce_matches: audit?.nonce === nonce && audit?.state?.nonce === nonce,
        listener_present: Boolean(audit?.listener),
        listener_registered: listenerRegistered,
      };
    }, { nonce: auditNonce });
    evidence = await boundedObserverHeartbeatOperation(
      evaluation,
      options.timeoutMs,
      options.setTimeoutFn,
      options.clearTimeoutFn,
    );
  } catch {
    throw extensionPreflightError(
      AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
      null,
      "postflight",
    );
  }
  if (evidence?.nonce_matches !== true
    || evidence?.listener_present !== true
    || evidence?.listener_registered !== true) {
    throw extensionPreflightError(
      AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
      null,
      "postflight",
    );
  }
  return Object.freeze({
    audit_phase: "postflight",
    observer_continuous: true,
    worker_identity_matches: true,
    audit_nonce_matches: true,
    listener_registered: true,
  });
}

export function createAuditedExtensionObserverContinuityMonitor(context, safety, options = {}) {
  const intervalMs = Number(options.intervalMs ?? AUDITED_EXTENSION_OBSERVER_HEARTBEAT_INTERVAL_MS);
  if (!Number.isInteger(intervalMs) || intervalMs < 1
    || intervalMs > AUDITED_EXTENSION_OBSERVER_HEARTBEAT_INTERVAL_MS) {
    throw cliError(`observer heartbeat interval must be 1-${AUDITED_EXTENSION_OBSERVER_HEARTBEAT_INTERVAL_MS}ms`);
  }
  const auditNonce = String(safety?.web_request_audit_nonce || "");
  if (!/^[a-f0-9]{32}$/u.test(auditNonce)) {
    throw extensionPreflightError(
      AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
      null,
      "postflight",
    );
  }
  let expectedWorker;
  try { expectedWorker = auditedExtensionWorker(context); }
  catch {
    throw extensionPreflightError(
      AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
      null,
      "postflight",
    );
  }
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const heartbeatTimeoutMs = Number(options.heartbeatTimeoutMs ?? intervalMs);
  if (!Number.isInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs < 1
    || heartbeatTimeoutMs > AUDITED_EXTENSION_OBSERVER_HEARTBEAT_INTERVAL_MS) {
    throw cliError(`observer heartbeat timeout must be 1-${AUDITED_EXTENSION_OBSERVER_HEARTBEAT_INTERVAL_MS}ms`);
  }
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const monotonicNow = options.monotonicNow || (() => performance.now());
  const onFailure = typeof options.onFailure === "function" ? options.onFailure : async () => {};
  let stopped = false;
  let pingRunning = false;
  let inFlight = Promise.resolve();
  let failure = null;
  let successfulPings = 0;
  let timer = null;
  let lastContinuityAtMs = Number(monotonicNow());
  const maximumGapMs = intervalMs + heartbeatTimeoutMs;
  const ping = () => {
    if (stopped || failure) return inFlight;
    if (pingRunning) return inFlight;
    pingRunning = true;
    inFlight = (async () => {
      try {
        const pingStartedAtMs = Number(monotonicNow());
        if (!Number.isFinite(pingStartedAtMs)
          || pingStartedAtMs < lastContinuityAtMs
          || pingStartedAtMs - lastContinuityAtMs > maximumGapMs) {
          throw extensionPreflightError(
            AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
            null,
            "postflight",
          );
        }
        await auditExtensionObserverHeartbeat(context, expectedWorker, auditNonce, {
          timeoutMs: heartbeatTimeoutMs,
          setTimeoutFn,
          clearTimeoutFn,
        });
        const continuityAtMs = Number(monotonicNow());
        if (!Number.isFinite(continuityAtMs)
          || continuityAtMs < lastContinuityAtMs
          || continuityAtMs - lastContinuityAtMs > maximumGapMs) {
          throw extensionPreflightError(
            AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
            null,
            "postflight",
          );
        }
        successfulPings += 1;
        lastContinuityAtMs = continuityAtMs;
      } catch {
        failure = extensionPreflightError(
          AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
          null,
          "postflight",
        );
        if (timer !== null) clearIntervalFn(timer);
        try { await onFailure(failure); } catch {}
      } finally {
        pingRunning = false;
      }
    })();
    return inFlight;
  };
  timer = setIntervalFn(() => { void ping(); }, intervalMs);
  return Object.freeze({
    interval_ms: intervalMs,
    pingNow: ping,
    async stop() {
      stopped = true;
      if (timer !== null) clearIntervalFn(timer);
      try {
        await boundedObserverHeartbeatOperation(
          inFlight,
          heartbeatTimeoutMs,
          setTimeoutFn,
          clearTimeoutFn,
        );
      } catch {
        failure ||= extensionPreflightError(
          AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
          null,
          "postflight",
        );
      }
      if (Number(monotonicNow()) - lastContinuityAtMs > maximumGapMs) {
        failure ||= extensionPreflightError(
          AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
          null,
          "postflight",
        );
      }
      if (failure) throw failure;
      return Object.freeze({
        audit_phase: "postflight",
        observer_continuous: true,
        successful_pings: successfulPings,
      });
    },
  });
}

export async function readAuditedCurrentExchangeRate(context, now = () => new Date(), options = {}) {
  const evaluationTimeoutMs = Number(options.evaluationTimeoutMs
    ?? AUDITED_EXTENSION_POSTFLIGHT_EVALUATION_TIMEOUT_MS);
  if (!Number.isInteger(evaluationTimeoutMs) || evaluationTimeoutMs < 1
    || evaluationTimeoutMs > AUDITED_EXTENSION_POSTFLIGHT_EVALUATION_TIMEOUT_MS) {
    throw cliError(`exchange-rate evaluation timeout must be 1-${AUDITED_EXTENSION_POSTFLIGHT_EVALUATION_TIMEOUT_MS}ms`);
  }
  let result;
  try {
    const worker = auditedExtensionWorker(context);
    const evaluation = worker.evaluate(async () => {
      const storage = await chrome.storage.local.get(["maozierp-token"]);
      const token = String(storage["maozierp-token"] || "").trim();
      if (!token) return { error: "Maozi token is missing" };
      try {
        const response = await fetch("https://api.maozierp.com/api.exchange_rate/index", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Client: "plugin",
            "Plugin-Version": chrome.runtime.getManifest().version,
          },
          body: JSON.stringify({ currency_from: "RUB" }),
          redirect: "error",
        });
        const json = await response.json();
        return {
          status: response.status,
          code: Number(json?.code),
          value: Number(json?.data?.RUBCNY?.value ?? json?.data?.CNY?.value),
        };
      } catch (error) {
        return { error: String(error?.message || error) };
      }
    });
    result = await boundedAuditedOperation(
      evaluation,
      evaluationTimeoutMs,
      () => cliError("current Maozi exchange-rate refresh timed out"),
      options.setTimeoutFn || setTimeout,
      options.clearTimeoutFn || clearTimeout,
    );
  } catch {
    throw extensionPreflightError(
      AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.EXCHANGE_RATE_READ_FAILURE,
      null,
      "preflight",
    );
  }
  if (result?.error
    || !(Number(result?.status) >= 200 && Number(result?.status) < 300)
    || Number(result?.code) !== 1
    || !(Number(result?.value) >= 0.03 && Number(result?.value) <= 0.2)) {
    throw extensionPreflightError(
      AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.EXCHANGE_RATE_READ_FAILURE,
      null,
      "preflight",
    );
  }
  const observed = now();
  const observedAt = observed instanceof Date ? observed : new Date(observed);
  if (!Number.isFinite(observedAt.getTime())) throw cliError("exchange-rate refresh clock is invalid");
  return Object.freeze({
    cny_per_rub: Number(result.value),
    observed_at: observedAt.toISOString(),
  });
}

export function createAuditedExchangeRateProvider(context, {
  initial = null,
  maxAgeMs = 60_000,
  now = () => new Date(),
} = {}) {
  let cached = initial?.cny_per_rub > 0 && Date.parse(initial?.observed_at)
    ? Object.freeze({ cny_per_rub: Number(initial.cny_per_rub), observed_at: new Date(initial.observed_at).toISOString() })
    : null;
  let inFlight = null;
  return async () => {
    const current = now();
    const nowMs = current instanceof Date ? current.getTime() : new Date(current).getTime();
    if (!Number.isFinite(nowMs)) throw cliError("exchange-rate provider clock is invalid");
    if (cached && nowMs - Date.parse(cached.observed_at) >= 0
      && nowMs - Date.parse(cached.observed_at) <= Math.max(1_000, Number(maxAgeMs) || 0)) return cached;
    inFlight ||= readAuditedCurrentExchangeRate(context, now).finally(() => { inFlight = null; });
    cached = await inFlight;
    return cached;
  };
}

export function assertNoPreFirewallWebPages(context) {
  const pages = typeof context?.pages === "function" ? context.pages() : [];
  for (const page of pages || []) {
    const value = String(page?.url?.() || "");
    if (/^https?:/iu.test(value)) {
      throw cliError(`unexpected web page loaded before the audited firewall: ${new URL(value).hostname}`);
    }
  }
  return true;
}

export function productionProcessViolations(processListText) {
  return String(processListText || "").split(/\r?\n/u).filter((line) => {
    const command = line.replace(/^\s*\d+\s+/u, "").trim();
    return line.includes(`--user-data-dir=${PRODUCTION_PROFILE}`)
      || /^(?:\S*\/)?node\s+\S*ozon_24h_supervisor\.mjs\s+supervise\b/u.test(command)
      || /^(?:\S*\/)?node\s+\S*flow_b_playwright\.mjs\s+(?:accept|run|publish)\b/u.test(command);
  });
}

export async function assertProductionBrowserStopped() {
  let operational;
  let owners;
  try {
    [operational, owners] = await Promise.all([
      fs.readFile("/Users/mac/.ozon-24h-production/state/operational_status.json", "utf8").then(JSON.parse),
      fs.readFile("/Users/mac/.ozon-24h-production/state/process_owners.json", "utf8").then(JSON.parse),
    ]);
  } catch (error) {
    throw cliError(`production STOPPED evidence is unreadable: ${error.message}`);
  }
  if (operational?.status !== "STOPPED") {
    throw cliError(`production operational status must be STOPPED, got ${operational?.status || "missing"}`);
  }
  for (const field of ["supervisor_pid", "worker_pid", "profile_owner_pid"]) {
    const pid = Number(owners?.[field]);
    if (Number.isInteger(pid) && pid > 0 && pidExists(pid)) {
      throw cliError(`production process owner ${field}=${pid} is still alive`);
    }
  }
  await assertPortAvailable(PRODUCTION_DEBUG_PORT).catch((error) => {
    throw cliError(`production must be STOPPED and port ${PRODUCTION_DEBUG_PORT} free: ${error.message}`);
  });
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
  const activeProduction = productionProcessViolations(stdout);
  if (activeProduction.length > 0) {
    throw cliError("production supervisor, worker, or browser profile is active; audited validation requires production STOPPED");
  }
  return true;
}

export function discoveryEnvironment(options, ambientEnv = process.env) {
  const dedicatedState = "/Users/mac/.ozon-audited-validation/state";
  const cleanAmbient = Object.fromEntries(Object.entries(ambientEnv || {}).filter(([key]) => (
    !key.startsWith("FLOW_B_") && !key.startsWith("OZON_24H_")
  )));
  return {
    ...cleanAmbient,
    FLOW_B_PW_PROFILE: options.userDataDir,
    FLOW_B_EXTENSION_DIR: options.extension,
    FLOW_B_CHROMIUM_EXECUTABLE: options.chromiumExecutable,
    FLOW_B_CDP_ENDPOINT: "",
    FLOW_B_AUDITED_DISCOVERY_ONLY: "1",
    FLOW_B_AUDITED_DISCOVERY_OWNED_CONTEXT: "1",
    FLOW_B_AUDITED_SOURCE_PORTFOLIO: "1",
    FLOW_B_VALIDATION_ONLY: "1",
    FLOW_B_DIRECT_PUBLISH: "0",
    FLOW_B_MAOZI_AUTOFAVORITE: "0",
    // The owned runner replaces this with an O_NOFOLLOW-created leaf inside its
    // per-owner quarantine after the owner lock is acquired.
    FLOW_B_OZON_ACCESS_STATE: "",
    // The shared access controller appends its optional timeline by pathname.
    // Disable that optional sink here; campaign checkpoints use audited O_NOFOLLOW
    // handles, and no standalone run may inherit or follow a production log leaf.
    FLOW_B_OZON_ACCESS_LOG: "",
    FLOW_B_RUN_DIR: path.join(dedicatedState, "runs"),
    FLOW_B_RUNTIME_STATE_DB: path.join(dedicatedState, "runtime-state.sqlite"),
    FLOW_B_SOURCE_SCAN_STATE_FILE: path.join(dedicatedState, "source-scan-state.json"),
    FLOW_B_DAILY_REPORT_DIR: path.join(dedicatedState, "reports"),
    FLOW_B_PROFIT_FEEDBACK_DIR: path.join(dedicatedState, "profit-feedback"),
    FLOW_B_PROFIT_FEEDBACK_STATE: path.join(dedicatedState, "profit-feedback-state.json"),
    FLOW_B_PROFIT_RUNTIME_ROOT: path.join(dedicatedState, "profit-runtime"),
    FLOW_B_REPORT_RUNTIME_ROOT: path.join(dedicatedState, "report-runtime"),
    FLOW_B_REPORT_RUN_DIR: path.join(dedicatedState, "report-runs"),
    FLOW_B_SUBMISSION_GATE_RUN_DIR: path.join(dedicatedState, "submission-gate-runs"),
    FLOW_B_SUPPLY_AUDIT_DIR: path.join(dedicatedState, "supply-audit"),
  };
}

function assertPinnedOwnedContextOptions(options) {
  if (path.resolve(String(options?.userDataDir || "")) !== path.resolve(AUDITED_VALIDATION_PROFILE)
    || path.resolve(String(options?.extension || "")) !== path.resolve(AUDITED_EXTENSION_DIR)
    || path.resolve(String(options?.chromiumExecutable || "")) !== path.resolve(AUDITED_BROWSER_EXECUTABLE)
    || Number(options?.remoteDebuggingPort) !== AUDITED_VALIDATION_DEBUG_PORT) {
    throw cliError("owned-context runner requires the pinned audited profile, extension, Chrome, and port 9224");
  }
}

async function emitOwnedContextLifecycle(lifecycle, phase, state, evidence = {}) {
  if (!lifecycle) return;
  if (typeof lifecycle.emit !== "function") {
    throw cliError("owned-context lifecycle observer must expose an emit function");
  }
  await lifecycle.emit(Object.freeze({
    contract: "ozon-audited-owned-context-lifecycle-v1",
    phase,
    state,
    ...evidence,
  }));
}

async function emitOwnedContextLifecycleWithin(lifecycle, phase, state, evidence, timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1
    || timeoutMs > AUDITED_OWNED_LIFECYCLE_EMIT_TIMEOUT_MS) {
    throw cliError(`owned-context lifecycle timeout must be 1-${AUDITED_OWNED_LIFECYCLE_EMIT_TIMEOUT_MS}ms`);
  }
  let timer = null;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(cliError("owned-context lifecycle emission timed out")), timeoutMs);
      Promise.resolve(emitOwnedContextLifecycle(lifecycle, phase, state, evidence))
        .then(resolve, () => reject(cliError("owned-context lifecycle emission failed")));
    });
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function findAuditedOwnedFailure(error, seen = new Set()) {
  if (!error || (typeof error !== "object" && typeof error !== "function") || seen.has(error)) {
    return null;
  }
  seen.add(error);
  if (error.failure_code) {
    return Object.freeze({
      evidence: auditedExtensionPreflightFailureEvidence(error, error.audit_phase),
      source: error,
    });
  }
  let nested = [];
  try { nested = Array.isArray(error.errors) ? error.errors : []; }
  catch { nested = []; }
  for (const child of nested) {
    const found = findAuditedOwnedFailure(child, seen);
    if (found) return found;
  }
  let cause = null;
  try { cause = error.cause || null; }
  catch { cause = null; }
  if (cause) return findAuditedOwnedFailure(cause, seen);
  return null;
}

function aggregateAuditedOwnedErrorList(errors, message) {
  const normalizedErrors = errors.filter(Boolean);
  const primaryFailure = normalizedErrors.length > 0
    ? findAuditedOwnedFailure(normalizedErrors[0])
    : null;
  let selectedFailure = primaryFailure;
  if (!selectedFailure) {
    for (const error of normalizedErrors.slice(1)) {
      selectedFailure = findAuditedOwnedFailure(error);
      if (selectedFailure) break;
    }
  }
  const aggregate = new AggregateError(normalizedErrors, message);
  if (selectedFailure) {
    const { evidence: selected, source: selectedError } = selectedFailure;
    aggregate.code = selected.failure_code;
    aggregate.failure_code = selected.failure_code;
    aggregate.preflight_step = selected.preflight_step;
    aggregate.audit_phase = selected.audit_phase;
    const partial = selectedError?.preflight_evidence;
    const safeSmokeEvidence = sanitizedWebRequestSmokeEvidence(partial)
      || sanitizedWebRequestSmokeEvidence(selectedError);
    if ((partial && typeof partial === "object") || safeSmokeEvidence) {
      aggregate.preflight_evidence = Object.freeze({
        bootstrap_lockdown_proven: partial?.bootstrap_lockdown_proven === true,
        observer_was_bound: partial?.observer_was_bound === true,
        dnr_rules_exact: partial?.dnr_rules_exact === true,
        dnr_rule_set_sha256: /^[a-f0-9]{64}$/u.test(String(partial?.dnr_rule_set_sha256 || ""))
          ? String(partial.dnr_rule_set_sha256)
          : null,
        ...(safeSmokeEvidence || {}),
      });
    }
  }
  aggregate.primary_audit_phase = primaryFailure?.evidence?.audit_phase || null;
  return aggregate;
}

function aggregateAuditedOwnedErrors(primaryError, secondaryError, message) {
  return aggregateAuditedOwnedErrorList([primaryError, secondaryError], message);
}

export async function withAuditedValidationOwnedContext(options, operation, dependencies = {}) {
  if (typeof operation !== "function") throw cliError("owned-context operation callback is required");
  assertPinnedOwnedContextOptions(options);
  const deps = {
    assertRuntimePaths: assertAuditedValidationRuntimePaths,
    assertProductionStopped: assertProductionBrowserStopped,
    assertProfile: assertDedicatedProfile,
    assertProfileTree: auditDedicatedProfileTree,
    assertExtension: assertAuditedExtension,
    assertBrowser: assertAuditedBrowserExecutable,
    assertPort: assertPortAvailable,
    ownerLock: acquireOwnerLock,
    isolateSessions: isolateAuditedProfileSessions,
    prepareAccessState: prepareOwnedAccessStateFile,
    launchContext: launchFlowContext,
    browserOptions: resolveBrowserOptions,
    assertNoPreFirewallPages: assertNoPreFirewallWebPages,
    browserRoot: waitForAuditedBrowserRoot,
    assertPortOwner: (root, port) => waitForAuditedPortOwnedByBrowserRoot(root, port, options),
    extensionBootstrap: auditExtensionBootstrapLockdown,
    installFirewall: installAuditedMutationFirewall,
    extensionPreflight: auditExtensionSafetyAndRate,
    extensionPostflight: auditExtensionFirewallPostflight,
    observerMonitor: createAuditedExtensionObserverContinuityMonitor,
    observerHeartbeatIntervalMs: AUDITED_EXTENSION_OBSERVER_HEARTBEAT_INTERVAL_MS,
    ownedLifecycleEmitTimeoutMs: AUDITED_OWNED_LIFECYCLE_EMIT_TIMEOUT_MS,
    rateProvider: createAuditedExchangeRateProvider,
    accessControllerFor: ozonAccessControllerFor,
    closeContext: closeAuditedOwnedContext,
    verifyStopped: waitForAuditedBrowserStopped,
    lifecycle: null,
    ...dependencies,
  };
  await deps.assertRuntimePaths(options);
  await deps.assertProductionStopped();
  const profileAudit = await deps.assertProfile(options);
  const extensionAudit = await deps.assertExtension(options.extension);
  const browserAudit = await deps.assertBrowser(options.chromiumExecutable);
  await deps.assertPort(options.remoteDebuggingPort);
  const owner = await deps.ownerLock(options, extensionAudit.sha256, browserAudit.version);
  let context = null;
  let browserRoot = null;
  let isolation = null;
  let firewall = null;
  let bootstrapSafety = null;
  let safety = null;
  let postflightSafety = null;
  let value;
  let routeSafetySnapshot = null;
  let primaryError = null;
  let lifecyclePhase = null;
  let lifecycleState = "before_launch";
  let operationalObserverBoundEmitted = false;
  let lifecycleEmissionUnavailable = false;
  let observerMonitor = null;
  let observerHeartbeatSafety = null;
  let observerHeartbeatFailed = false;
  let emitOperationalPostflightFailure = null;
  let operationalPreflightEvidence = Object.freeze({
    observer_bound: false,
    dnr_rules_exact: false,
    dnr_rule_set_sha256: null,
  });
  const emitLifecycle = async (phase, state, evidence = {}) => {
    if (lifecycleEmissionUnavailable) return false;
    try {
      await emitOwnedContextLifecycleWithin(
        deps.lifecycle,
        phase,
        state,
        evidence,
        deps.ownedLifecycleEmitTimeoutMs,
      );
      return true;
    } catch (error) {
      lifecycleEmissionUnavailable = true;
      throw error;
    }
  };
  try {
    isolation = await deps.isolateSessions(options, owner.token);
    await owner.update({
      profile_realpath: profileAudit?.realpath || options.userDataDir,
      profile_device: profileAudit?.device ?? null,
      profile_inode: profileAudit?.inode ?? null,
      session_quarantine: isolation.quarantine,
      session_paths_moved: isolation.moved,
    });
    const env = discoveryEnvironment(options);
    env.FLOW_B_OZON_ACCESS_STATE = await deps.prepareAccessState(isolation);
    await deps.assertProfileTree(options.userDataDir);
    const launchOptions = deps.browserOptions(env);
    if (launchOptions.cdpEndpoint) throw cliError("CDP connection is forbidden for audited validation");
    const baseLaunchArgs = [
      ...launchOptions.args.filter((argument) => !/^--remote-debugging-(?:address|port)=/u.test(argument)
        && !/^--host-resolver-rules=/u.test(argument)
        && argument !== "--restore-last-session"),
      "--disable-session-crashed-bubble",
      "--no-first-run",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${options.remoteDebuggingPort}`,
    ];
    // Phase 1 has an OS/browser-level network gate active before the extension
    // service worker can run.  It persists a full-host DNR lockdown, then the
    // entire browser must stop before any unrestricted launch is attempted.
    const bootstrapLaunchArgs = baseLaunchArgs.filter((argument) => (
      !/^--(?:proxy|no-proxy-server|use-system-proxy)/u.test(argument)
    ));
    lifecyclePhase = "bootstrap";
    lifecycleState = "starting";
    await emitLifecycle(lifecyclePhase, lifecycleState, {
      cause: "bootstrap_launch_armed",
      network_gate: "host_resolver_offline",
      observer_coverage: "not_available_before_dnr",
      mutation_zero_proven: false,
    });
    context = await deps.launchContext({
      ...launchOptions,
      args: [
        ...bootstrapLaunchArgs,
        "--no-proxy-server",
        `--host-resolver-rules=${AUDITED_BOOTSTRAP_HOST_RESOLVER_RULES}`,
      ],
    });
    await deps.assertNoPreFirewallPages(context);
    browserRoot = await deps.browserRoot(options);
    await owner.update({
      phase: "bootstrap-lockdown",
      browser_root_pid: browserRoot.pid,
      browser_root_command: browserRoot.command,
    });
    await deps.assertPortOwner(browserRoot, options.remoteDebuggingPort);
    lifecycleState = "listening";
    await emitLifecycle(lifecyclePhase, lifecycleState, {
      cause: "bootstrap_listener_owned",
      network_gate: "host_resolver_offline",
      observer_coverage: "not_available_before_dnr",
      mutation_zero_proven: false,
    });
    bootstrapSafety = await deps.extensionBootstrap(context);
    if (bootstrapSafety?.host_resolver_blocked_before_dnr !== true
      || bootstrapSafety?.prior_audited_rules_cleared_before_probe !== true
      || bootstrapSafety?.protected_read_probe_blocked_before_dnr !== true
      || bootstrapSafety?.persisted_full_host_lockdown !== true
      || bootstrapSafety?.session_rules_empty !== true
      || bootstrapSafety?.pinned_safe_rule_9001_audited !== true) {
      throw cliError("bootstrap launch did not prove a persisted full-host DNR lockdown");
    }
    lifecycleState = "closing";
    await emitLifecycle(lifecyclePhase, lifecycleState, {
      cause: "bootstrap_close_armed",
      network_gate: "host_resolver_offline",
      observer_coverage: "not_available_before_dnr",
      mutation_zero_proven: false,
    });
    await deps.closeContext(context);
    context = null;
    await deps.verifyStopped(browserRoot, options.remoteDebuggingPort, 10_000, options.userDataDir);
    lifecycleState = "stopped";
    await emitLifecycle(lifecyclePhase, lifecycleState, {
      cause: "bootstrap_stopped",
      network_gate: "persisted_dnr_lockdown",
      observer_coverage: "not_available_before_dnr",
      mutation_zero_proven: false,
    });
    browserRoot = null;
    await owner.update({
      phase: "operational-launch",
      bootstrap_lockdown_sha256: bootstrapSafety.lockdown_rule_sha256 || null,
      bootstrap_browser_stopped_at: new Date().toISOString(),
      browser_root_pid: null,
      browser_root_command: null,
    });
    await deps.assertProfileTree(options.userDataDir);

    // Phase 2 starts with the persisted lockdown already active.  Page routing is
    // installed, then preflight registers the all-context observer while still
    // locked down and atomically replaces it with the operational rule set.
    lifecyclePhase = "operational";
    lifecycleState = "starting";
    await emitLifecycle(lifecyclePhase, lifecycleState, {
      cause: "operational_launch_armed",
      network_gate: "persisted_dnr_lockdown",
      observer_coverage: "not_available_before_dnr",
      mutation_zero_proven: false,
    });
    context = await deps.launchContext({ ...launchOptions, args: baseLaunchArgs });
    await deps.assertNoPreFirewallPages(context);
    firewall = await deps.installFirewall(context);
    browserRoot = await deps.browserRoot(options);
    await owner.update({ browser_root_pid: browserRoot.pid, browser_root_command: browserRoot.command });
    await deps.assertPortOwner(browserRoot, options.remoteDebuggingPort);
    lifecycleState = "listening";
    await emitLifecycle(lifecyclePhase, lifecycleState, {
      cause: "operational_listener_owned_before_preflight",
      network_gate: "persisted_dnr_lockdown",
      observer_coverage: "not_available_before_dnr",
      mutation_zero_proven: false,
    });
    const emitOperationalObserverBound = async (evidence) => {
      operationalPreflightEvidence = Object.freeze({
        observer_bound: evidence?.observer_bound === true,
        dnr_rules_exact: evidence?.dnr_rules_exact === true,
        dnr_rule_set_sha256: /^[a-f0-9]{64}$/u.test(String(evidence?.dnr_rule_set_sha256 || ""))
          ? String(evidence.dnr_rule_set_sha256)
          : null,
      });
      await emitLifecycle(lifecyclePhase, lifecycleState, {
        cause: "operational_observer_bound",
        preflight_step: "dnr_exact_recheck",
        network_gate: "dnr_default_deny_and_context_route",
        observer_coverage: operationalPreflightEvidence.observer_bound
          ? "all_contexts_continuous"
          : "incomplete",
        dnr_rules_exact: operationalPreflightEvidence.dnr_rules_exact,
        dnr_rule_set_sha256: operationalPreflightEvidence.dnr_rule_set_sha256,
        mutation_zero_proven: false,
      });
      operationalObserverBoundEmitted = true;
    };
    try {
      safety = await deps.extensionPreflight(context, {
        onObserverBound: emitOperationalObserverBound,
      });
      if (!operationalObserverBoundEmitted) {
        await emitOperationalObserverBound({
          observer_bound: safety.web_request_audit_continuous === true,
          dnr_rules_exact: safety.dnr_rules_exact === true,
          dnr_rule_set_sha256: safety.dnr_rule_set_sha256,
        });
      }
    } catch (error) {
      const failure = auditedExtensionPreflightFailureEvidence(error, "preflight");
      const safeSmokeEvidence = sanitizedWebRequestSmokeEvidence(failure);
      const partialEvidence = Object.freeze({
        bootstrap_lockdown_proven: bootstrapSafety?.persisted_full_host_lockdown === true,
        observer_was_bound: operationalPreflightEvidence.observer_bound,
        dnr_rules_exact: operationalPreflightEvidence.dnr_rules_exact,
        dnr_rule_set_sha256: operationalPreflightEvidence.dnr_rule_set_sha256,
        ...(safeSmokeEvidence || {}),
      });
      const safeError = extensionPreflightError(
        failure.failure_code,
        failure.preflight_step,
        failure.audit_phase,
        failure,
      );
      safeError.preflight_evidence = partialEvidence;
      try {
        await emitLifecycle(lifecyclePhase, lifecycleState, {
          cause: "operational_preflight_failed",
          failure_code: failure.failure_code,
          preflight_step: failure.preflight_step,
          audit_phase: failure.audit_phase,
          network_gate: operationalPreflightEvidence.dnr_rules_exact
            ? "dnr_default_deny_and_context_route"
            : "persisted_dnr_lockdown",
          observer_coverage: partialEvidence.observer_was_bound
            ? "observer_was_bound_pre_failure"
            : "not_confirmed",
          ...partialEvidence,
          mutation_zero_proven: false,
        });
      } catch (lifecycleError) {
        throw aggregateAuditedOwnedErrors(
          safeError,
          lifecycleError,
          "extension preflight and lifecycle telemetry both failed",
        );
      }
      throw safeError;
    }
    const accessController = deps.accessControllerFor(context, env);
    const rateProvider = deps.rateProvider(context, {
      initial: {
        cny_per_rub: safety.exchange_rate_observed,
        observed_at: safety.exchange_rate_observed_at,
      },
    });
    const partialPreflightEvidence = Object.freeze({
      bootstrap_lockdown_proven: bootstrapSafety?.persisted_full_host_lockdown === true,
      observer_was_bound: operationalPreflightEvidence.observer_bound,
      dnr_rules_exact: operationalPreflightEvidence.dnr_rules_exact,
      dnr_rule_set_sha256: operationalPreflightEvidence.dnr_rule_set_sha256,
    });
    const createOperationalPostflightFailure = (error) => {
      const failure = auditedExtensionPreflightFailureEvidence(error, "postflight");
      const safeSmokeEvidence = sanitizedWebRequestSmokeEvidence(failure);
      const safeError = extensionPreflightError(
        failure.failure_code,
        failure.preflight_step,
        "postflight",
        failure,
      );
      safeError.preflight_evidence = Object.freeze({
        ...partialPreflightEvidence,
        ...(safeSmokeEvidence || {}),
      });
      return safeError;
    };
    const persistOperationalPostflightFailure = async (safeError, occurrence) => {
      const failure = auditedExtensionPreflightFailureEvidence(safeError, "postflight");
      try {
        await emitLifecycle(lifecyclePhase, "listening", {
          cause: "operational_postflight_failed",
          failure_code: failure.failure_code,
          preflight_step: failure.preflight_step,
          audit_phase: "postflight",
          failure_occurrence: occurrence,
          network_gate: "dnr_default_deny_and_context_route",
          observer_coverage: failure.failure_code
            === AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST
            ? "observer_continuity_lost"
            : "observer_was_bound_pre_failure",
          ...safeError.preflight_evidence,
          mutation_zero_proven: false,
        });
      } catch {}
      return safeError;
    };
    emitOperationalPostflightFailure = async (error, occurrence) => (
      persistOperationalPostflightFailure(createOperationalPostflightFailure(error), occurrence)
    );
    let monitorOccurrenceError = null;
    let monitorOccurrencePersistencePromise = null;
    try {
      observerMonitor = await deps.observerMonitor(context, safety, {
        intervalMs: deps.observerHeartbeatIntervalMs,
        onFailure: async (error) => {
          observerHeartbeatFailed = true;
          monitorOccurrenceError = createOperationalPostflightFailure(error);
          monitorOccurrencePersistencePromise = persistOperationalPostflightFailure(
            monitorOccurrenceError,
            "heartbeat",
          );
          await monitorOccurrencePersistencePromise;
        },
      });
    } catch (error) {
      observerHeartbeatFailed = true;
      throw await emitOperationalPostflightFailure(error, "heartbeat_start");
    }
    let operationError = null;
    try {
      value = await operation(Object.freeze({
        context,
        env,
        safety,
        rateProvider,
        firewall,
        accessController,
      }));
    } catch (error) {
      operationError = error;
    }
    let monitorError = null;
    try {
      observerHeartbeatSafety = await observerMonitor.stop();
    } catch (error) {
      observerHeartbeatFailed = true;
      if (monitorOccurrencePersistencePromise) {
        await monitorOccurrencePersistencePromise.catch(() => {});
      }
      monitorError = monitorOccurrenceError
        || await emitOperationalPostflightFailure(error, "heartbeat_stop");
    } finally {
      observerMonitor = null;
    }
    if (operationError && monitorError) {
      throw aggregateAuditedOwnedErrors(
        operationError,
        monitorError,
        "owned operation and extension observer heartbeat both failed",
      );
    }
    if (operationError) throw operationError;
    if (monitorError) throw monitorError;
  } catch (error) {
    primaryError = error;
  }
  if (context && safety && !observerHeartbeatFailed) {
    try {
      postflightSafety = await deps.extensionPostflight(context, safety);
      if (postflightSafety?.dnr_rules_exact !== true) {
        throw extensionPreflightError(
          AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.DNR_RULESET_MISMATCH,
          null,
          "postflight",
        );
      }
      if (postflightSafety?.dnr_no_conflicting_dynamic_or_session_overrides !== true
        || postflightSafety?.dnr_pinned_safe_rule_9001_audited !== true) {
        throw extensionPreflightError(
          AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.DNR_OVERRIDE_CONFLICT,
          null,
          "postflight",
        );
      }
      if (postflightSafety?.dnr_check_data_network_smoke_blocked !== true) {
        throw extensionPreflightError(
          AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.CHECK_DATA_SMOKE_ESCAPE,
          null,
          "postflight",
        );
      }
      if (postflightSafety?.dnr_all_protected_maozi_path_smokes_blocked !== true) {
        throw extensionPreflightError(
          AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.MUTATION_SMOKE_ESCAPE,
          null,
          "postflight",
        );
      }
      if (postflightSafety?.dnr_http_maozi_path_smokes_blocked !== true) {
        throw extensionPreflightError(
          AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.HTTP_SMOKE_ESCAPE,
          null,
          "postflight",
        );
      }
      if (postflightSafety?.dnr_ambiguous_maozi_path_smokes_blocked !== true) {
        throw extensionPreflightError(
          AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.AMBIGUOUS_PATH_SMOKE_ESCAPE,
          null,
          "postflight",
        );
      }
      if (postflightSafety?.dnr_sku3_post_read_smoke_ok !== true) {
        throw extensionPreflightError(
          AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.SKU3_READ_FAILURE,
          null,
          "postflight",
        );
      }
      if (postflightSafety?.web_request_audit_continuous !== true
        || !Number.isInteger(postflightSafety?.all_contexts_state_mutation_attempts_observed)
        || postflightSafety.all_contexts_state_mutation_attempts_observed < 0
        || !Number.isInteger(postflightSafety?.service_worker_state_mutation_attempts_observed)
        || postflightSafety.service_worker_state_mutation_attempts_observed < 0) {
        throw extensionPreflightError(
          AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
          null,
          "postflight",
        );
      }
      routeSafetySnapshot = firewall?.snapshot?.() || null;
      if (postflightSafety.all_contexts_state_mutation_attempts_observed > 0
        || Number(routeSafetySnapshot?.context_route_blocked_mutation_attempts || 0) > 0) {
        throw cliError("a favorite, import, publish, edit, or external mutation was attempted during audited validation");
      }
      await emitLifecycle(lifecyclePhase, lifecycleState, {
        cause: "operational_postflight_complete",
        audit_phase: "postflight",
        network_gate: "dnr_default_deny_and_context_route",
        observer_coverage: "all_contexts_continuous",
        observer_heartbeat_continuous: observerHeartbeatSafety?.observer_continuous === true,
        observer_heartbeat_successful_pings: Number(observerHeartbeatSafety?.successful_pings || 0),
        observer_heartbeat_interval_ms: Number(deps.observerHeartbeatIntervalMs),
        mutation_zero_proven: postflightSafety.all_contexts_state_mutation_attempts_observed === 0
          && Number(routeSafetySnapshot?.context_route_blocked_mutation_attempts || 0) === 0,
        mutation_attempts_observed: Math.max(
          Number(postflightSafety.all_contexts_state_mutation_attempts_observed || 0),
          Number(routeSafetySnapshot?.context_route_blocked_mutation_attempts || 0),
        ),
      });
    } catch (error) {
      const safeError = emitOperationalPostflightFailure
        ? await emitOperationalPostflightFailure(error, "postflight")
        : (() => {
          const failure = auditedExtensionPreflightFailureEvidence(error, "postflight");
          return extensionPreflightError(
            failure.failure_code,
            failure.preflight_step,
            "postflight",
            failure,
          );
        })();
      primaryError = primaryError
        ? aggregateAuditedOwnedErrors(
          primaryError,
          safeError,
          "owned operation or observer monitor and extension postflight both failed",
        )
        : safeError;
    }
  }
  const cleanupErrors = [];
  const lifecycleErrors = [];
  if (lifecyclePhase && lifecycleState !== "closing" && lifecycleState !== "stopped") {
    try {
      lifecycleState = "closing";
      await emitLifecycle(lifecyclePhase, lifecycleState, {
        cause: "owned_context_cleanup_armed",
      });
    } catch (error) { lifecycleErrors.push(error); }
  }
  try { await deps.closeContext(context); }
  catch (error) { cleanupErrors.push(error); }
  let stopped = false;
  try {
    await deps.verifyStopped(browserRoot, options.remoteDebuggingPort, 10_000, options.userDataDir);
    stopped = true;
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (stopped && lifecyclePhase && lifecycleState !== "stopped") {
    try {
      lifecycleState = "stopped";
      await emitLifecycle(lifecyclePhase, lifecycleState, {
        cause: "owned_context_stopped",
      });
    } catch (error) {
      lifecycleErrors.push(error);
    }
  }
  if (stopped && isolation) {
    try { await isolation.restore(); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length > 0) {
    await owner.update({
      status: "orphan_cleanup_required",
      cleanup_error_count: cleanupErrors.length,
      cleanup_errors: cleanupErrors.map((error) => String(error?.message || error).slice(0, 500)),
      cleanup_failed_at: new Date().toISOString(),
    }).catch(() => {});
    throw aggregateAuditedOwnedErrorList(
      primaryError
        ? [primaryError, ...lifecycleErrors, ...cleanupErrors]
        : [...lifecycleErrors, ...cleanupErrors],
      "audited validation CLI failed to prove browser cleanup; owner lock retained",
    );
  }
  try {
    await owner.release();
  } catch (releaseError) {
    await owner.update({
      status: "orphan_cleanup_required",
      cleanup_error_count: 1,
      cleanup_errors: ["owner_release_failed"],
      cleanup_failed_at: new Date().toISOString(),
    }).catch(() => {});
    throw aggregateAuditedOwnedErrorList(
      primaryError
        ? [primaryError, ...lifecycleErrors, releaseError]
        : [...lifecycleErrors, releaseError],
      "audited validation CLI failed to release the owner lock; lock retention requires audit",
    );
  }
  for (const lifecycleError of lifecycleErrors) {
    primaryError = primaryError
      ? aggregateAuditedOwnedErrors(
        primaryError,
        lifecycleError,
        "audited validation operation and lifecycle telemetry both failed",
      )
      : lifecycleError;
  }
  if (primaryError) throw primaryError;
  routeSafetySnapshot ||= firewall?.snapshot?.() || null;
  const serviceWorkerMutationAttempts = postflightSafety.service_worker_state_mutation_attempts_observed;
  const allContextsMutationAttempts = Math.max(
    postflightSafety.all_contexts_state_mutation_attempts_observed,
    Number(routeSafetySnapshot?.context_route_blocked_mutation_attempts || 0) + serviceWorkerMutationAttempts,
  );
  return Object.freeze({
    value,
    request_firewall: Object.freeze({
      ...routeSafetySnapshot,
      service_worker_mutation_attempts_observed: serviceWorkerMutationAttempts,
      all_contexts_mutation_attempts_observed: allContextsMutationAttempts,
      all_contexts_protected_attempts_by_kind:
        postflightSafety.all_contexts_protected_attempts_by_kind,
      protected_analytics_upload_attempts_observed:
        postflightSafety.protected_analytics_upload_attempts_observed,
    }),
    network_safety: Object.freeze({
      contract: "ozon-audited-validation-network-safety-v1",
      bootstrap_contract: bootstrapSafety.contract,
      bootstrap_host_resolver_blocked_before_dnr: true,
      bootstrap_prior_audited_rules_cleared_before_probe: true,
      bootstrap_protected_read_probe_blocked_before_dnr: true,
      bootstrap_proxy_disabled: true,
      bootstrap_persisted_full_host_lockdown: true,
      bootstrap_browser_fully_stopped_before_operational_launch: true,
      bootstrap_lockdown_rule_sha256: bootstrapSafety.lockdown_rule_sha256,
      operational_preflight_observed_persisted_lockdown:
        safety.dnr_persisted_lockdown_observed_before_operational_switch === true,
      observer_heartbeat_interval_ms: Number(deps.observerHeartbeatIntervalMs),
      observer_heartbeat_successful_pings: Number(observerHeartbeatSafety?.successful_pings || 0),
      observer_heartbeat_continuous: observerHeartbeatSafety?.observer_continuous === true,
      observer_heartbeat_network_requests: 0,
      dnr_rule_set_sha256: postflightSafety.dnr_rule_set_sha256,
      dnr_rules_exact_at_start_and_end: safety.dnr_rules_exact === true
        && postflightSafety.dnr_rules_exact === true
        && safety.dnr_rule_set_sha256 === postflightSafety.dnr_rule_set_sha256,
      dnr_no_conflicting_dynamic_or_session_overrides_at_start_and_end:
        safety.dnr_no_conflicting_dynamic_or_session_overrides === true
        && postflightSafety.dnr_no_conflicting_dynamic_or_session_overrides === true,
      dnr_all_protected_maozi_path_smokes_blocked_at_start_and_end:
        safety.dnr_all_protected_maozi_path_smokes_blocked === true
        && postflightSafety.dnr_all_protected_maozi_path_smokes_blocked === true,
      dnr_http_maozi_path_smokes_blocked_at_start_and_end:
        safety.dnr_http_maozi_path_smokes_blocked === true
        && postflightSafety.dnr_http_maozi_path_smokes_blocked === true,
      dnr_ambiguous_maozi_path_smokes_blocked_at_start_and_end:
        safety.dnr_ambiguous_maozi_path_smokes_blocked === true
        && postflightSafety.dnr_ambiguous_maozi_path_smokes_blocked === true,
      dnr_pinned_safe_rule_9001_audited_at_start_and_end:
        safety.dnr_pinned_safe_rule_9001_audited === true
        && postflightSafety.dnr_pinned_safe_rule_9001_audited === true,
      check_data_service_worker_smoke_blocked_at_start_and_end:
        safety.dnr_check_data_network_smoke_blocked === true
        && postflightSafety.dnr_check_data_network_smoke_blocked === true,
      sku3_post_read_smoke_ok_at_start_and_end:
        safety.dnr_sku3_post_read_smoke_ok === true
        && postflightSafety.dnr_sku3_post_read_smoke_ok === true,
      dnr_match_telemetry_available: postflightSafety.dnr_match_telemetry_available === true,
      dnr_matched_rule_count_deltas: postflightSafety.dnr_matched_rule_count_deltas,
      dnr_match_telemetry_unavailable_reason: postflightSafety.dnr_match_telemetry_unavailable_reason,
      bootstrap_pre_observer_attempt_coverage: "offline-gate-only-no-attempt-observer",
      bootstrap_pre_observer_mutation_zero_proven: false,
      web_request_audit_scope: "operational-post-observer",
      operational_post_observer_web_request_audit_continuous: true,
      operational_post_observer_all_contexts_state_mutation_attempts_observed:
        allContextsMutationAttempts,
      operational_post_observer_service_worker_state_mutation_attempts_observed:
        serviceWorkerMutationAttempts,
      operational_post_observer_protected_analytics_upload_attempts_observed:
        postflightSafety.protected_analytics_upload_attempts_observed,
      web_request_audit_continuous: true,
      all_contexts_state_mutation_attempts_observed: allContextsMutationAttempts,
      service_worker_state_mutation_attempts_observed: serviceWorkerMutationAttempts,
      all_contexts_protected_attempts_by_kind:
        postflightSafety.all_contexts_protected_attempts_by_kind,
      protected_analytics_upload_attempts_observed:
        postflightSafety.protected_analytics_upload_attempts_observed,
      protected_mutation_requests_allowed_outbound: false,
    }),
  });
}

export async function runAuditedValidationDiscoveryCli(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseAuditedValidationDiscoveryArgs(argv);
  if (options.help) return { help: true, text: usage() };
  const app = {
    assertIoContainment: assertAuditedIoContainment,
    loadArtifact: loadAuditedSourceArtifact,
    buildPolicy: buildAuditedValidationSourcePolicy,
    sourceScan: scanSourceWithPage,
    accessControllerFor: ozonAccessControllerFor,
    runDiscovery: runAuditedValidationDiscovery,
    runEnrichment: enrichAuditedDiscoveryCampaign,
    ...dependencies,
  };
  await app.assertIoContainment(options);
  try {
    const owned = await withAuditedValidationOwnedContext(options, async ({
      context,
      env,
      safety,
      rateProvider,
      accessController,
    }) => {
      const artifact = await app.loadArtifact(options.artifact);
      let discovery = null;
      if (options.mode === "discover" || options.mode === "all") {
        const policy = app.buildPolicy({ artifact, slots: 60, now: new Date() });
        discovery = await app.runDiscovery({
          baseDirectory: options.outDir,
          artifact,
          activeUrls: policy.active_urls,
          campaignEpoch: options.campaignEpoch,
          runId: options.runId,
          activatedAt: options.activatedAt,
          discoveryTarget: options.target,
          expectedSourceCount: 60,
          env,
          concurrency: options.concurrency,
          scanAdapter: createPlaywrightAuditedSourceScanAdapter({
            context,
            ownedContext: true,
            scanSourceWithPage: app.sourceScan,
            scanOptions: {
              steps: 24,
              ratio: 0.82,
              delay: 650,
              initialWait: 8_000,
              maxNoNewSteps: 45,
              linkTarget: 24,
            },
            timeoutMs: 90_000,
            closeTimeoutMs: 5_000,
            accessController,
          }),
        });
      }
      let enrichment = null;
      if (options.mode === "enrich" || options.mode === "all") {
        const manifestFile = options.manifest || discovery?.manifest_file;
        const fetchLiveDetail = createPlaywrightAuditedLiveDetailFetcher({
          context,
          ownedContext: true,
          apiRateProvider: rateProvider,
          navigationTimeoutMs: options.navigationTimeoutMs,
          observationTimeoutMs: options.observationTimeoutMs,
        });
        enrichment = await app.runEnrichment({
          manifestFile,
          artifactFile: options.artifact,
          fetchLiveDetail,
          accessAdapter: createAuditedLiveDetailAccessAdapter(
            (request, operation) => accessController.run(request, operation),
          ),
          concurrency: options.concurrency,
          minimumCandidates: options.minimum,
        });
        if (!enrichment.ready) {
          throw cliError(`candidate set is not ready: ${enrichment.candidate_count}/${enrichment.minimum_candidates}`);
        }
      }
      return { safety, discovery, enrichment };
    }, dependencies);
    const {
      web_request_audit_nonce: _auditNonce,
      web_request_audit_snapshot_baseline: _auditBaseline,
      web_request_mutation_attempts_baseline: _attemptBaseline,
      web_request_mutation_by_kind_baseline: _kindBaseline,
      ...publicExtensionSafety
    } = owned.value.safety;
    return {
      help: false,
      text: JSON.stringify({
        mode: options.mode,
        browser_isolation: {
          profile_dir: options.userDataDir,
          remote_debugging_port: options.remoteDebuggingPort,
          production_profile_used: false,
          production_port_used: false,
          cdp_connected: false,
        },
        extension_safety: publicExtensionSafety,
        request_firewall: owned.request_firewall,
        network_safety: owned.network_safety,
        discovery: owned.value.discovery,
        enrichment: owned.value.enrichment,
      }, null, 2),
    };
  } catch (error) {
    if (isAuditedManualAttentionError(error)) {
      error.message = `${error.message}; manual CAPTCHA/authentication attention is required before rerun`;
    }
    throw error;
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  runAuditedValidationDiscoveryCli().then(({ text }) => {
    process.stdout.write(`${text}\n`);
  }).catch((error) => {
    process.stderr.write(`${error?.message || error}\n\n${usage()}\n`);
    process.exitCode = 1;
  });
}
