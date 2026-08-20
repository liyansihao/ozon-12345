import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendAuditedLiveDetailEnrichment,
  auditedDiscoveryCampaignDirectory,
  assembleAuditedValidationCandidates,
  assertAuditedDiscoveryOnlyScope,
  buildAuditedValidationCandidatesFromCampaign,
  createAuditedLiveDetailAccessAdapter,
  createAuditedReadOnlySourceScanAdapter,
  createOrLoadAuditedDiscoveryCampaign,
  createPlaywrightAuditedLiveDetailFetcher,
  createPlaywrightAuditedSourceScanAdapter,
  enrichAuditedDiscoveryCampaign,
  enrichAuditedDiscoveryFacts,
  normalizeAuditedDiscoveryFact,
  normalizeAuditedLiveDetailObservation as normalizeAuditedLiveDetailObservationRuntime,
  runAuditedValidationDiscovery,
} from "../scripts/flow_b_playwright/audited-validation-discovery.mjs";
import {
  auditedSellerRoot,
  auditedSourceSetSha256,
  buildAuditedValidationSourcePolicy,
  loadAuditedSourceArtifact,
} from "../scripts/flow_b_playwright/audited-source-portfolio.mjs";
import {
  loadAuditedValidationCandidateFile,
  loadValidationCandidateFile,
} from "../scripts/flow_b_playwright/validation-candidate-file.mjs";
import {
  parseAuditedCandidateBuilderArgs,
  runAuditedCandidateBuilderCli,
} from "../scripts/audited_validation_candidate_builder.mjs";
import {
  AUDITED_BROWSER_EXECUTABLE,
  AUDITED_BROWSER_VERSION,
  AUDITED_BOOTSTRAP_HOST_RESOLVER_RULES,
  AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES,
  AUDITED_EXTENSION_OBSERVER_HEARTBEAT_INTERVAL_MS,
  AUDITED_EXTENSION_ID,
  AUDITED_EXTENSION_DIR,
  AUDITED_EXTENSION_TREE_SHA256,
  AUDITED_MUTATION_ENDPOINTS,
  AUDITED_MAOZI_API_ALLOWLIST,
  AUDITED_WEB_REQUEST_SMOKE_DRAIN_TIMEOUT_MS,
  AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG,
  AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG_SHA256,
  AUDITED_VALIDATION_DEBUG_PORT,
  AUDITED_VALIDATION_PROFILE,
  auditExtensionSafetyAndRate,
  auditedExtensionPreflightFailureEvidence,
  createAuditedExtensionObserverContinuityMonitor,
  auditExtensionFirewallPostflight,
  auditExtensionBootstrapLockdown,
  auditDedicatedProfileTree,
  auditedBootstrapLockdownDnrRule,
  auditedDynamicDnrRules,
  auditedRequestDecision,
  discoveryEnvironment,
  auditedExtensionTreeDigest,
  auditedBrowserRootFromProcessList,
  assertNoPreFirewallWebPages,
  assertAuditedNoSessionRestorePreferences,
  assertAuditedPathHasNoSymlinkOrHardlink,
  isolateAuditedProfileSessions,
  installAuditedMutationFirewall,
  closeAuditedOwnedContext,
  createAuditedExchangeRateProvider,
  readAuditedCurrentExchangeRate,
  prepareOwnedAccessStateFile,
  productionProcessViolations,
  waitForAuditedBrowserStopped,
  withAuditedValidationOwnedContext,
  parseAuditedValidationDiscoveryArgs,
  runAuditedValidationDiscoveryCli,
} from "../scripts/audited_validation_discovery.mjs";

const ARTIFACT_FILE = path.resolve(
  import.meta.dirname,
  "../config/ozon_audited_source_portfolio.json",
);
const RUN_ID = "20260819_000500_audited_discovery";
const EPOCH = "2026-08-19T00:05:00+08:00";
const NOW = "2026-08-18T16:05:00.000Z";
const LIVE_DETAIL_TEST_NOW = () => new Date("2026-08-18T16:20:00.000Z");
const PRICE_DOM_CONTRACT = "webPrice visible non-struck leaf current + excluded old/struck leaves + one same-page Maozi 跟卖最低价 RUB≈CNY line; parseOzonDetailText(fallback=null)-v2";
const SAFE_ENV = Object.freeze({
  FLOW_B_AUDITED_DISCOVERY_ONLY: "1",
  FLOW_B_AUDITED_SOURCE_PORTFOLIO: "1",
  FLOW_B_VALIDATION_ONLY: "1",
  FLOW_B_DIRECT_PUBLISH: "0",
  FLOW_B_MAOZI_AUTOFAVORITE: "0",
  FLOW_B_AUDITED_DISCOVERY_OWNED_CONTEXT: "1",
});

function normalizeAuditedLiveDetailObservation(options = {}) {
  return normalizeAuditedLiveDetailObservationRuntime({
    now: LIVE_DETAIL_TEST_NOW,
    ...options,
  });
}
const AMBIGUOUS_MAOZI_SMOKE_URLS = Object.freeze([
  "https://api.maozierp.com//api.product.favorite/toggle",
  "https://api.maozierp.com/%2Fapi.product.favorite%2Ftoggle",
  "https://api.maozierp.com/api%2Eproduct.favorite%2Ftoggle",
  "https://maozierp.com/api.product.favorite/toggle",
  "https://sidecar.maozierp.com/api.product.favorite/toggle",
  "http://sidecar.maozierp.com/api.product.favorite/toggle",
]);
const SAFE_DNR_RULE_9001 = Object.freeze({
  id: 9001,
  priority: 1,
  action: Object.freeze({
    type: "modifyHeaders",
    responseHeaders: Object.freeze([Object.freeze({
      header: "content-security-policy",
      operation: "remove",
    })]),
  }),
  condition: Object.freeze({
    regexFilter: "^https?://([^/]*\\.)?ozon\\.(ru|kz|by)/",
    resourceTypes: Object.freeze(["main_frame"]),
  }),
});

function validWebRequestSmokeDiagnostics(overrides = {}) {
  return {
    smokeProbeCatalogSha256: AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG_SHA256,
    smokeProbeExpectedCount: 38,
    smokeProbeObservedCount: 38,
    smokeProbeMissing: [],
    smokeProbeSchemeCounts: {
      requested_http: 17,
      requested_https: 21,
      observed_http: 17,
      observed_https: 21,
      http_to_https: 0,
    },
    smokeProbeDuplicateRequestCount: 0,
    smokeProbeDrainElapsedMs: 0,
    smokeProbeDrainTimedOut: false,
    ...overrides,
  };
}

function incompleteWebRequestSmokeDiagnostics(
  probeId = "p37",
  observedSchemes = [],
  overrides = {},
) {
  const descriptor = AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG
    .find((row) => row.probe_id === probeId);
  assert.ok(descriptor);
  const observedHttp = 17 - (descriptor.requested_scheme === "http" ? 1 : 0)
    + (observedSchemes.includes("http") ? 1 : 0);
  const observedHttps = 21 - (descriptor.requested_scheme === "https" ? 1 : 0)
    + (observedSchemes.includes("https") ? 1 : 0);
  return validWebRequestSmokeDiagnostics({
    smokeProbeObservedCount: 37,
    smokeProbeMissing: [{ probe_id: probeId, observed_schemes: observedSchemes }],
    smokeProbeSchemeCounts: {
      requested_http: 17,
      requested_https: 21,
      observed_http: observedHttp,
      observed_https: observedHttps,
      http_to_https: descriptor.requested_scheme === "http" && observedSchemes.includes("https") ? 1 : 0,
    },
    smokeProbeDrainElapsedMs: AUDITED_WEB_REQUEST_SMOKE_DRAIN_TIMEOUT_MS,
    smokeProbeDrainTimedOut: true,
    ...overrides,
  });
}

function safeIncompleteWebRequestSmokeEvidence(probeId = "p37", observedSchemes = []) {
  const descriptor = AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG
    .find((row) => row.probe_id === probeId);
  const diagnostics = incompleteWebRequestSmokeDiagnostics(probeId, observedSchemes);
  return {
    smoke_probe_catalog_sha256: diagnostics.smokeProbeCatalogSha256,
    smoke_probe_expected_count: diagnostics.smokeProbeExpectedCount,
    smoke_probe_observed_count: diagnostics.smokeProbeObservedCount,
    smoke_probe_missing: [{
      probe_id: probeId,
      kind: descriptor.expected_kind,
      requested_scheme: descriptor.requested_scheme,
      observed_schemes: observedSchemes,
    }],
    smoke_probe_scheme_counts: diagnostics.smokeProbeSchemeCounts,
    smoke_probe_duplicate_request_count: diagnostics.smokeProbeDuplicateRequestCount,
    smoke_probe_drain_elapsed_ms: diagnostics.smokeProbeDrainElapsedMs,
    smoke_probe_drain_timed_out: diagnostics.smokeProbeDrainTimedOut,
  };
}

function continuousWebRequestSnapshot(overrides = {}) {
  return {
    continuous: true,
    total: AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG.length,
    byKind: {},
    byMethodPath: {},
    byScopeKind: { service_worker: {}, page_or_frame: {} },
    ...overrides,
  };
}

function validExtensionPreflightAuditResult(overrides = {}) {
  return {
    installedRules: auditedDynamicDnrRules(),
    conflictingOverrideRules: [],
    unexpectedDynamicOrSessionRules: [],
    pinnedSafeRule9001Audited: true,
    sessionRulesAudited: true,
    protectedSmokeBlockedPaths: [...AUDITED_MUTATION_ENDPOINTS],
    httpProtectedSmokeBlockedPaths: [...AUDITED_MUTATION_ENDPOINTS],
    expectedAmbiguousSmokeUrls: [...AMBIGUOUS_MAOZI_SMOKE_URLS],
    ambiguousSmokeBlockedUrls: [...AMBIGUOUS_MAOZI_SMOKE_URLS],
    checkDataSmokeBlocked: true,
    webRequestSmokeObserved: true,
    webRequestBeforeSmoke: {
      continuous: true,
      total: 0,
      byKind: {},
      byMethodPath: {},
      byScopeKind: { service_worker: {}, page_or_frame: {} },
    },
    webRequestAfterSmoke: {
      continuous: true,
      total: AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG.length,
      byKind: {},
      byMethodPath: {},
      byScopeKind: { service_worker: {}, page_or_frame: {} },
    },
    webRequestOperationalBaseline: continuousWebRequestSnapshot(),
    webRequestSmokeDiagnostics: validWebRequestSmokeDiagnostics(),
    matchedAfterSmoke: { available: false, counts: null, reason: "not-granted" },
    rulesPresent: true,
    autoFavoriteValues: [0],
    rateStatus: 200,
    rateCode: 1,
    rubCny: 0.07929,
    sku3Status: 200,
    sku3Code: 1,
    ...overrides,
  };
}

function extensionPreflightContext(...results) {
  let index = 0;
  return {
    serviceWorkers: () => [{
      url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
      evaluate: async () => results[Math.min(index++, results.length - 1)],
    }],
  };
}

async function runWorkerSmokeHarness({
  mutateProbeEvent = (_descriptor, event) => [event],
  escapedProbeIds = new Set(),
  readPreflightPaths = [],
  mutateWorkerRequest = (request) => request,
} = {}) {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const auditGlobalKey = "__ozonAuditedValidationMutationAuditV1";
  const previousAudit = globalThis[auditGlobalKey];
  let dynamicRules = [SAFE_DNR_RULE_9001, auditedBootstrapLockdownDnrRule()];
  let listener = null;
  const listenerRegistrations = [];
  const smokeRequests = [];
  const workerRequests = [];
  let completeResult = null;
  try {
    delete globalThis[auditGlobalKey];
    globalThis.chrome = {
      declarativeNetRequest: {
        getDynamicRules: async () => dynamicRules,
        getSessionRules: async () => [],
        updateDynamicRules: async ({ removeRuleIds, addRules }) => {
          dynamicRules = dynamicRules.filter((rule) => !removeRuleIds.includes(Number(rule.id)));
          dynamicRules.push(...addRules);
        },
      },
      webRequest: {
        onBeforeRequest: {
          addListener: (handler, filter, extraInfoSpec) => {
            listener = handler;
            listenerRegistrations.push({ filter, extraInfoSpec });
          },
          removeListener: (handler) => { if (handler === listener) listener = null; },
          hasListener: (handler) => handler === listener,
        },
      },
      storage: {
        local: {
          get: async () => ({
            productSelectionRules: { auto_favorite: 0 },
            "maozierp-token": "secret-worker-harness-token",
          }),
        },
      },
      runtime: { getManifest: () => ({ version: "3.0.9" }) },
    };
    let readRequestId = 0;
    globalThis.fetch = async (input, options = {}) => {
      const requestedUrl = String(input);
      const parsed = new URL(requestedUrl);
      const probeId = parsed.searchParams.get("__ozon_audit_smoke_probe");
      if (probeId) {
        const descriptor = AUDITED_WEB_REQUEST_SMOKE_PROBE_CATALOG
          .find((row) => row.probe_id === probeId);
        assert.ok(descriptor);
        smokeRequests.push({ requestedUrl, options: { ...options } });
        const event = {
          url: requestedUrl,
          method: "OPTIONS",
          requestId: `request-${probeId}`,
          tabId: -1,
          initiator: `chrome-extension://${AUDITED_EXTENSION_ID}`,
          type: "xmlhttprequest",
        };
        const events = await mutateProbeEvent(descriptor, event, smokeRequests.length - 1);
        for (const row of Array.isArray(events) ? events : []) {
          const { delayMs = 0, ...details } = row;
          if (delayMs > 0) setTimeout(() => listener?.(details), delayMs);
          else listener?.(details);
        }
        if (escapedProbeIds.has(probeId)) {
          return { status: 204, json: async () => ({ code: 1, data: {} }) };
        }
        throw new TypeError("blocked by audited DNR");
      }
      if (readPreflightPaths.includes(parsed.pathname)) {
        listener?.({
          url: requestedUrl,
          method: "OPTIONS",
          requestId: `read-preflight-${readRequestId++}`,
          tabId: -1,
          initiator: `chrome-extension://${AUDITED_EXTENSION_ID}`,
          type: "xmlhttprequest",
        });
      }
      if (parsed.pathname === "/api.exchange_rate/index") {
        return {
          status: 200,
          json: async () => ({ code: 1, data: { RUBCNY: { value: 0.07929 } } }),
        };
      }
      if (parsed.pathname === "/api.chrome/sku3") {
        return { status: 200, json: async () => ({ code: 1, data: {} }) };
      }
      throw new Error("unexpected harness fetch");
    };
    const worker = {
      url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
      evaluate: async (pageFunction, originalRequest) => {
        const request = mutateWorkerRequest(originalRequest);
        workerRequests.push(request);
        const result = await pageFunction(request);
        if (request?.preflightStage === "complete") completeResult = result;
        return result;
      },
    };
    let safety = null;
    let error = null;
    try {
      safety = await auditExtensionSafetyAndRate({ serviceWorkers: () => [worker] });
    } catch (caught) {
      error = caught;
    }
    return {
      safety,
      error,
      completeResult,
      listenerRegistrations,
      smokeRequests,
      workerRequests,
    };
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
    if (previousAudit === undefined) delete globalThis[auditGlobalKey];
    else globalThis[auditGlobalKey] = previousAudit;
  }
}

async function withTempDir(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audited-discovery-"));
  try { return await operation(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function liveObservation(fact, overrides = {}) {
  const { current_price_raw: currentPriceRaw, ...rest } = overrides;
  const currentRaw = String(currentPriceRaw || "¥ 88");
  const value = {
    live: true,
    method: "ozon-detail-plugin-live",
    price_field: "web_price_plus_same_page_follow_pair",
    price_dom_contract: PRICE_DOM_CONTRACT,
    web_price_text: currentRaw,
    current_price_node: {
      raw_text: currentRaw,
      selector: "[data-testid=audited-current-price]",
      evidence_source: "webPrice-visible-nonstruck-leaf-v1",
      visible: true,
      line_through: false,
      installment: false,
    },
    excluded_price_nodes: [],
    follow_price_lines: [],
    final_url: fact.href,
    seller_url: fact.seller_url,
    seller_evidence_source: "webCurrentSeller",
    title: fact.title,
    cover_image: `https://ir.ozone.ru/live-${fact.sku}.jpg`,
    brand_evidence: {
      complete: true,
      source: "visible-product-attributes.brand",
      raw_brand: "Нет бренда",
    },
    category_evidence: {
      complete: true,
      source: "visible-breadcrumbs",
      text: fact.title,
    },
    item_evidence: {
      single_item_guard_passed: true,
      source: "live-title-category-no-multipack-terms",
      item_count: null,
    },
    observed_at: "2026-08-18T16:10:00.000Z",
  };
  const merged = { ...value, ...rest };
  if (!String(merged.seller_url || "").trim()
    && !Object.hasOwn(rest, "seller_evidence_source")) merged.seller_evidence_source = null;
  return merged;
}

async function discoveryFixture(directory) {
  const artifact = await loadAuditedSourceArtifact(ARTIFACT_FILE);
  const policy = buildAuditedValidationSourcePolicy({
    artifact,
    slots: 60,
    now: artifact.generated_at,
  });
  const result = await runAuditedValidationDiscovery({
    baseDirectory: directory,
    artifact,
    activeUrls: policy.active_urls,
    campaignEpoch: EPOCH,
    runId: RUN_ID,
    discoveryTarget: 360,
    expectedSourceCount: 60,
    env: SAFE_ENV,
    concurrency: 4,
    now: () => new Date(NOW),
    scanAdapter: createAuditedReadOnlySourceScanAdapter(async ({ sourceUrl, sourceIndex }) => {
      const seller = auditedSellerRoot(sourceUrl);
      const target = artifact.targets.find((row) => row.seller_url === seller);
      assert.ok(target, `missing target for ${sourceUrl}`);
      return {
        blocked: false,
        final_url: sourceUrl,
        stop_reason: "link_target_reached",
        links: Array.from({ length: 6 }, (_, index) => {
          const sku = String(1_000_000_000 + sourceIndex * 10 + index + 1);
          return {
            href: `https://www.ozon.ru/product/safe-${sku}/`,
            text: `${target.allow_terms_any[0]} безопасный товар ${sku}`,
            image_url: `https://ir.ozone.ru/${sku}.jpg`,
            card_text: `Цена 999 ₽\n${target.allow_terms_any[0]}`,
          };
        }),
      };
    }),
  });
  const manifest = JSON.parse(await fs.readFile(result.manifest_file, "utf8"));
  const facts = (await fs.readFile(result.provenance_file, "utf8"))
    .trim().split(/\r?\n/u).map(JSON.parse);
  return { artifact, policy, result, manifest, facts };
}

test("discovery-only scope is fail-closed and cannot coexist with publication or favorite mutation", async () => {
  const artifact = await loadAuditedSourceArtifact(ARTIFACT_FILE);
  assert.equal(assertAuditedDiscoveryOnlyScope(SAFE_ENV, artifact), true);
  for (const env of [
    { ...SAFE_ENV, FLOW_B_AUDITED_DISCOVERY_ONLY: "0" },
    { ...SAFE_ENV, FLOW_B_AUDITED_SOURCE_PORTFOLIO: "0" },
    { ...SAFE_ENV, FLOW_B_VALIDATION_ONLY: "0" },
    { ...SAFE_ENV, FLOW_B_DIRECT_PUBLISH: "1" },
    { ...SAFE_ENV, FLOW_B_MAOZI_AUTOFAVORITE: "1" },
    { ...SAFE_ENV, FLOW_B_AUDITED_DISCOVERY_OWNED_CONTEXT: "0" },
  ]) {
    assert.throws(() => assertAuditedDiscoveryOnlyScope(env, artifact));
  }
});

test("read-only builder CLI requires explicit bound inputs and defaults to the 300-ready gate", async () => {
  assert.deepEqual(parseAuditedCandidateBuilderArgs(["--help"]), { help: true });
  assert.throws(() => parseAuditedCandidateBuilderArgs([]), /--manifest is required/u);
  assert.throws(() => parseAuditedCandidateBuilderArgs([
    "--manifest", "/Users/mac/.ozon-audited-validation/campaigns/campaign.json",
    "--artifact", "artifact.json",
    "--out-candidates", "/Users/mac/.ozon-audited-validation/campaigns/candidates.json",
    "--out-provenance", "/Users/mac/.ozon-audited-validation/campaigns/provenance.json",
    "--minimum", "299",
  ]), /integer >= 300/u);
  assert.throws(() => parseAuditedCandidateBuilderArgs([
    "--allow-incomplete",
  ]), /forbidden/u);
  assert.throws(() => parseAuditedCandidateBuilderArgs([
    "--manifest", "/Users/mac/.ozon-audited-validation/campaigns/campaign.json",
    "--artifact", "artifact.json",
    "--out-candidates", "/Users/mac/.ozon-audited-validation/campaigns/same.json",
    "--out-provenance", "/Users/mac/.ozon-audited-validation/campaigns/same.json",
  ]), /different paths/u);
  assert.throws(() => parseAuditedCandidateBuilderArgs([
    "--manifest", "/Users/mac/.ozon-audited-validation/campaigns/campaign.json",
    "--artifact", "artifact.json",
    "--out-candidates", "/Users/mac/.ozon-audited-validation/campaigns/campaign.json",
    "--out-provenance", "/Users/mac/.ozon-audited-validation/campaigns/provenance.json",
  ]), /must not overwrite/u);
  const help = await runAuditedCandidateBuilderCli(["--help"]);
  assert.equal(help.help, true);
  assert.match(help.text, /never opens a browser/u);
  assert.match(help.text, /300 fully bound candidates/u);
});

test("dedicated validation CLI pins the audited profile, port, extension digest, owner, and context lifetime", async () => {
  const extension = "/Users/mac/Downloads/maozi-plugin-3.0.9/maozi-plugin-3.0.9";
  const argv = [
    "discover",
    "--user-data-dir", AUDITED_VALIDATION_PROFILE,
    "--remote-debugging-port", String(AUDITED_VALIDATION_DEBUG_PORT),
    "--chromium-executable", AUDITED_BROWSER_EXECUTABLE,
    "--extension", extension,
    "--artifact", ARTIFACT_FILE,
    "--out-dir", "/Users/mac/.ozon-audited-validation/campaigns/test-output",
    "--campaign-epoch", EPOCH,
    "--run-id", RUN_ID,
    "--activated-at", NOW,
  ];
  const parsed = parseAuditedValidationDiscoveryArgs(argv);
  assert.equal(parsed.userDataDir, AUDITED_VALIDATION_PROFILE);
  assert.equal(parsed.remoteDebuggingPort, 9224);
  const productionPortArgv = [...argv];
  productionPortArgv[productionPortArgv.indexOf("--remote-debugging-port") + 1] = "9223";
  assert.throws(() => parseAuditedValidationDiscoveryArgs(productionPortArgv), /port 9224|production remote/u);
  assert.throws(() => parseAuditedValidationDiscoveryArgs([
    ...argv, "--cdp-endpoint", "http://127.0.0.1:9224",
  ]), /forbidden/u);
  assert.throws(() => parseAuditedValidationDiscoveryArgs([
    ...argv, "--target", "300",
  ]), /integer >= 360/u);
  assert.throws(() => parseAuditedValidationDiscoveryArgs([
    ...argv, "--concurrency", "5",
  ]), /between 1 and 4/u);
  const outsideRoot = [...argv];
  outsideRoot[outsideRoot.indexOf("--out-dir") + 1] = "/tmp/escape-audited-output";
  assert.throws(() => parseAuditedValidationDiscoveryArgs(outsideRoot), /must stay inside/u);
  const isolatedEnv = discoveryEnvironment(parsed, {
    PATH: "/usr/bin",
    FLOW_B_RUN_DIR: "/Users/mac/.ozon-24h-production/state/runs/live",
    FLOW_B_ERROR_SCREENSHOT_DIR: "/Users/mac/.ozon-24h-production/screens",
    OZON_24H_STATE_ROOT: "/Users/mac/.ozon-24h-production/state",
  });
  assert.equal(isolatedEnv.PATH, "/usr/bin");
  assert.equal(Object.values(isolatedEnv).includes("/Users/mac/.ozon-24h-production/state/runs/live"), false);
  assert.equal(Object.values(isolatedEnv).includes("/Users/mac/.ozon-24h-production/screens"), false);
  assert.equal(Object.hasOwn(isolatedEnv, "OZON_24H_STATE_ROOT"), false);
  const root = auditedBrowserRootFromProcessList(
    `101 1 ${AUDITED_BROWSER_EXECUTABLE} --user-data-dir=${AUDITED_VALIDATION_PROFILE} --remote-debugging-address=127.0.0.1 --remote-debugging-port=9224`,
    parsed,
  );
  assert.equal(root.pid, 101);
  assert.throws(() => auditedBrowserRootFromProcessList(
    `101 1 ${AUDITED_BROWSER_EXECUTABLE} --user-data-dir=${AUDITED_VALIDATION_PROFILE} --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223`,
    parsed,
  ), /dedicated profile and port/u);
  assert.equal(productionProcessViolations(
    "777 /usr/local/bin/node /Users/mac/Desktop/ozon/flow_b_codex_transfer_20260608/scripts/flow_b_playwright.mjs run",
  ).length, 1);
  assert.equal(productionProcessViolations(
    "778 /usr/local/bin/node /tmp/unrelated-worker.mjs run",
  ).length, 0);

  let closed = 0;
  let released = 0;
  let restored = 0;
  let verifiedStopped = 0;
  let lockUpdated = null;
  const launchArgs = [];
  const context = {
    close: async () => { closed += 1; },
    newPage: async () => ({}),
    pages: () => [{ url: () => "about:blank" }],
  };
  const output = await runAuditedValidationDiscoveryCli(argv, {
    assertIoContainment: async () => true,
    assertRuntimePaths: async () => true,
    assertProductionStopped: async () => true,
    assertProfile: async () => ({ realpath: AUDITED_VALIDATION_PROFILE, device: 1, inode: 2 }),
    assertProfileTree: async () => true,
    assertExtension: async () => ({ sha256: AUDITED_EXTENSION_TREE_SHA256 }),
    assertBrowser: async () => ({ version: AUDITED_BROWSER_VERSION }),
    assertPort: async () => {},
    ownerLock: async (_options, digest, version) => {
      assert.equal(digest, AUDITED_EXTENSION_TREE_SHA256);
      assert.equal(version, AUDITED_BROWSER_VERSION);
      return {
        token: "test-owner-token",
        update: async (value) => { lockUpdated = value; },
        release: async () => { released += 1; },
      };
    },
    isolateSessions: async () => ({
      quarantine: "/tmp/audited-session-quarantine",
      access_state_file: "/tmp/audited-session-quarantine/runtime/ozon-access-state.json",
      moved: ["Default/Sessions"],
      restore: async () => { restored += 1; },
    }),
    prepareAccessState: async (isolation) => isolation.access_state_file,
    browserOptions: () => ({
      args: ["--proxy-server=http://127.0.0.1:7890", "--proxy-bypass-list=<-loopback>"],
      cdpEndpoint: null,
    }),
    launchContext: async (options) => { launchArgs.push(options.args); return context; },
    browserRoot: async () => ({ pid: 202, command: "dedicated chrome root" }),
    assertPortOwner: async () => true,
    verifyStopped: async () => { verifiedStopped += 1; return true; },
    extensionBootstrap: async () => ({
      contract: "ozon-audited-validation-bootstrap-lockdown-v1",
      host_resolver_blocked_before_dnr: true,
      prior_audited_rules_cleared_before_probe: true,
      protected_read_probe_blocked_before_dnr: true,
      persisted_full_host_lockdown: true,
      session_rules_empty: true,
      pinned_safe_rule_9001_audited: true,
      lockdown_rule_sha256: "c".repeat(64),
    }),
    installFirewall: async (received) => {
      assert.equal(received, context);
      return { snapshot: () => ({
        observation_scope: "playwright-context-route-does-not-cover-service-worker",
        context_route_blocked_mutation_attempts: 0,
        context_route_blocked_by_mutation_kind: {},
        blocked_requests: 0,
        by_method_path: {},
      }) };
    },
    extensionPreflight: async () => ({
      exchange_rate_observed: 0.07929,
      exchange_rate_observed_at: NOW,
      dnr_rule_set_sha256: "a".repeat(64),
      dnr_rules_exact: true,
      dnr_persisted_lockdown_observed_before_operational_switch: true,
      dnr_no_conflicting_dynamic_or_session_overrides: true,
      dnr_check_data_network_smoke_blocked: true,
      dnr_all_protected_maozi_path_smokes_blocked: true,
      dnr_http_maozi_path_smokes_blocked: true,
      dnr_ambiguous_maozi_path_smokes_blocked: true,
      dnr_pinned_safe_rule_9001_audited: true,
      dnr_sku3_post_read_smoke_ok: true,
    }),
    observerMonitor: async () => ({
      stop: async () => ({ observer_continuous: true, successful_pings: 7 }),
    }),
    extensionPostflight: async () => ({
      dnr_rule_set_sha256: "a".repeat(64),
      dnr_rules_exact: true,
      dnr_no_conflicting_dynamic_or_session_overrides: true,
      dnr_check_data_network_smoke_blocked: true,
      dnr_all_protected_maozi_path_smokes_blocked: true,
      dnr_http_maozi_path_smokes_blocked: true,
      dnr_ambiguous_maozi_path_smokes_blocked: true,
      dnr_pinned_safe_rule_9001_audited: true,
      dnr_sku3_post_read_smoke_ok: true,
      dnr_match_telemetry_available: false,
      dnr_matched_rule_count_deltas: null,
      dnr_match_telemetry_unavailable_reason: "not-granted",
      web_request_audit_continuous: true,
      all_contexts_state_mutation_attempts_observed: 0,
      service_worker_state_mutation_attempts_observed: 0,
      protected_analytics_upload_attempts_observed: 1,
      all_contexts_protected_attempts_by_kind: { "analytics-upload": 1 },
    }),
    loadArtifact: async () => ({ fake: true }),
    buildPolicy: () => ({ active_urls: [] }),
    accessControllerFor: () => ({ run: (_request, operation) => operation() }),
    sourceScan: async () => ({ final_url: "", links: [] }),
    runDiscovery: async (request) => {
      assert.equal(request.env.FLOW_B_DIRECT_PUBLISH, "0");
      assert.equal(request.env.FLOW_B_MAOZI_AUTOFAVORITE, "0");
      return { manifest_file: "/tmp/campaign.json", favorite_mutations: 0, orchestrator_submission_calls: 0 };
    },
  });
  assert.equal(output.help, false);
  assert.equal(closed, 2);
  assert.equal(verifiedStopped, 2);
  assert.equal(released, 1);
  assert.equal(restored, 1);
  assert.equal(lockUpdated.browser_root_pid, 202);
  assert.equal(launchArgs.length, 2);
  assert.ok(launchArgs[0].includes("--no-proxy-server"));
  assert.ok(launchArgs[0].some((argument) => argument.includes("MAP * ~NOTFOUND")));
  assert.equal(launchArgs[0].some((argument) => argument.startsWith("--proxy-server=")), false);
  assert.equal(launchArgs[0].some((argument) => argument.startsWith("--proxy-bypass-list=")), false);
  assert.ok(launchArgs[1].includes("--proxy-server=http://127.0.0.1:7890"));
  const networkSafety = JSON.parse(output.text).network_safety;
  assert.equal(networkSafety.web_request_audit_continuous, true);
  assert.equal(networkSafety.bootstrap_persisted_full_host_lockdown, true);
  assert.equal(networkSafety.bootstrap_pre_observer_attempt_coverage,
    "offline-gate-only-no-attempt-observer");
  assert.equal(networkSafety.bootstrap_pre_observer_mutation_zero_proven, false);
  assert.equal(networkSafety.web_request_audit_scope, "operational-post-observer");
  assert.equal(networkSafety.operational_post_observer_web_request_audit_continuous, true);
  assert.equal(
    networkSafety.operational_post_observer_all_contexts_state_mutation_attempts_observed,
    0,
  );
  assert.equal(
    networkSafety.operational_post_observer_protected_analytics_upload_attempts_observed,
    1,
  );
});

test("bootstrap starts from an empty audited DNR state, clears stale IDs before its live resolver probe, then persists lockdown", async () => {
  assert.match(AUDITED_BOOTSTRAP_HOST_RESOLVER_RULES, /^MAP \* ~NOTFOUND/u);
  assert.match(AUDITED_BOOTSTRAP_HOST_RESOLVER_RULES, /EXCLUDE 127\.0\.0\.1/u);
  let dynamicRules = [SAFE_DNR_RULE_9001];
  const events = [];
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  try {
    globalThis.chrome = {
      declarativeNetRequest: {
        updateDynamicRules: async ({ removeRuleIds, addRules }) => {
          events.push(addRules.length ? "install-lockdown" : "clear-stale");
          dynamicRules = dynamicRules.filter((rule) => !removeRuleIds.includes(Number(rule.id)));
          dynamicRules.push(...addRules);
        },
        getDynamicRules: async () => dynamicRules,
        getSessionRules: async () => [],
      },
    };
    globalThis.fetch = async (url, options) => {
      events.push("resolver-probe");
      assert.equal(url, "https://api.maozierp.com/api.exchange_rate/index");
      assert.equal(options.method, "OPTIONS");
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.deepEqual(dynamicRules, [SAFE_DNR_RULE_9001]);
      throw new TypeError("host resolver blocked");
    };
    const result = await auditExtensionBootstrapLockdown({
      serviceWorkers: () => [{
        url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
        evaluate: async (pageFunction, request) => pageFunction(request),
      }],
    });
    assert.deepEqual(events, ["clear-stale", "resolver-probe", "install-lockdown"]);
    assert.equal(result.prior_audited_rules_cleared_before_probe, true);
    assert.equal(result.protected_read_probe_blocked_before_dnr, true);
    assert.deepEqual(dynamicRules.map((rule) => rule.id).sort((a, b) => a - b), [9001, auditedBootstrapLockdownDnrRule().id]);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test("audited extension preflight pins its tree/worker and installs method-aware default-deny API rules", async () => {
  const digest = await auditedExtensionTreeDigest("/Users/mac/Downloads/maozi-plugin-3.0.9/maozi-plugin-3.0.9");
  assert.equal(digest.file_count, 13);
  assert.equal(digest.sha256, AUDITED_EXTENSION_TREE_SHA256);
  assert.ok(AUDITED_MUTATION_ENDPOINTS.includes("/api.shop/set_cookies"));
  assert.ok(AUDITED_MUTATION_ENDPOINTS.includes("/api.chrome/check_data"));
  assert.equal(auditedRequestDecision("https://api.maozierp.com/api.chrome/sku3?sku=1", "POST").allowed, true);
  assert.equal(auditedRequestDecision("https://api.maozierp.com/api.chrome/sku3?sku=1", "GET").allowed, false);
  assert.equal(auditedRequestDecision("https://api.maozierp.com:444/api.chrome/sku3?sku=1", "POST").allowed, false);
  assert.equal(auditedRequestDecision("http://api.maozierp.com/api.chrome/sku3?sku=1", "POST").allowed, false);
  assert.equal(auditedRequestDecision("https://api.maozierp.com/api.chrome/check_data", "POST").allowed, false);
  assert.equal(auditedRequestDecision("https://api.maozierp.com/api.unknown/read", "POST").allowed, false);
  for (const url of [
    "https://api.maozierp.com//api.product.favorite/toggle",
    "https://api.maozierp.com/%2Fapi.product.favorite%2Ftoggle",
    "https://api.maozierp.com/api%2Echrome/sku3?sku=1",
    "https://sidecar.maozierp.com/api.chrome/sku3?sku=1",
    "http://sidecar.maozierp.com/api.product.favorite/toggle",
  ]) assert.equal(auditedRequestDecision(url, "POST").allowed, false, url);
  assert.equal(auditedRequestDecision(
    "https://seller.ozon.ru/api/site/seller-prototype/create-bundle-by-variant-id",
    "POST",
  ).allowed, false);
  let routeHandler;
  const firewall = await installAuditedMutationFirewall({
    route: async (_pattern, handler) => { routeHandler = handler; },
  });
  const routed = async (url, method) => {
    let action = null;
    await routeHandler({
      request: () => ({ url: () => url, method: () => method }),
      abort: async () => { action = "abort"; },
      continue: async () => { action = "continue"; },
    });
    return action;
  };
  assert.equal(await routed("https://api.maozierp.com/api.chrome/sku3?sku=1", "POST"), "continue");
  assert.equal(await routed("https://api.maozierp.com/api.chrome/check_data", "POST"), "abort");
  assert.equal(await routed("https://api.maozierp.com/api.chrome/wb_sales", "POST"), "abort");
  assert.equal(await routed("http://api.maozierp.com/api.product.favorite/toggle", "POST"), "abort");
  assert.equal(await routed("https://api.maozierp.com//api.product.favorite/toggle", "POST"), "abort");
  assert.equal(await routed("https://sidecar.maozierp.com/api.chrome/sku3", "POST"), "abort");
  assert.equal(await routed(
    "https://seller.ozon.ru/api/site/seller-prototype/create-bundle-by-variant-id",
    "POST",
  ), "abort");
  assert.equal(firewall.snapshot().context_route_blocked_mutation_attempts, 4);
  assert.equal(firewall.snapshot().context_route_blocked_protected_analytics_upload_attempts, 2);
  let wrongWorkerCalled = false;
  let pinnedWorkerCalled = false;
  const result = await auditExtensionSafetyAndRate({
    serviceWorkers: () => [{
      url: () => "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/background.js",
      evaluate: async () => { wrongWorkerCalled = true; },
    }, {
      url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
      evaluate: async (_pageFunction, request) => {
        pinnedWorkerCalled = true;
        assert.equal(request.bootstrapLockdownRule.id, auditedBootstrapLockdownDnrRule().id);
        assert.deepEqual(request.maoziReadAllowlist, AUDITED_MAOZI_API_ALLOWLIST);
        assert.ok(request.expectedRules.some((rule) => rule.action.type === "allow"
          && rule.condition.regexFilter.includes("sku3")));
        assert.ok(request.expectedRules.some((rule) => rule.action.type === "block"
          && rule.condition.requestDomains?.includes("maozierp.com")
          && !rule.condition.regexFilter));
        return {
          installedRules: auditedDynamicDnrRules(),
          conflictingOverrideRules: [],
          unexpectedDynamicOrSessionRules: [],
          pinnedSafeRule9001Audited: true,
          sessionRulesAudited: true,
          protectedSmokeBlockedPaths: [...AUDITED_MUTATION_ENDPOINTS],
          httpProtectedSmokeBlockedPaths: [...AUDITED_MUTATION_ENDPOINTS],
          expectedAmbiguousSmokeUrls: [...AMBIGUOUS_MAOZI_SMOKE_URLS],
          ambiguousSmokeBlockedUrls: [...AMBIGUOUS_MAOZI_SMOKE_URLS],
          checkDataSmokeBlocked: true,
          webRequestSmokeObserved: true,
          webRequestBeforeSmoke: {
            continuous: true,
            total: 0,
            byKind: {},
            byMethodPath: {},
            byScopeKind: { service_worker: {}, page_or_frame: {} },
          },
          webRequestAfterSmoke: {
            continuous: true,
            total: AUDITED_MUTATION_ENDPOINTS.length,
            byKind: { "analytics-upload": 2 },
            byMethodPath: {},
            byScopeKind: { service_worker: { "analytics-upload": 2 }, page_or_frame: {} },
          },
          webRequestOperationalBaseline: continuousWebRequestSnapshot({
            total: AUDITED_MUTATION_ENDPOINTS.length,
            byKind: { "analytics-upload": 2 },
            byScopeKind: { service_worker: { "analytics-upload": 2 }, page_or_frame: {} },
          }),
          webRequestSmokeDiagnostics: validWebRequestSmokeDiagnostics(),
          matchedAfterSmoke: { available: false, counts: null, reason: "not-granted" },
          rulesPresent: true,
          autoFavoriteValues: [0],
          rateStatus: 200,
          rateCode: 1,
          rubCny: 0.07929,
          sku3Status: 200,
          sku3Code: 1,
        };
      },
    }],
  });
  assert.equal(wrongWorkerCalled, false);
  assert.equal(pinnedWorkerCalled, true);
  assert.equal(result.current_exchange_rate_api_ok, true);
  assert.equal(result.dnr_all_protected_maozi_path_smokes_blocked, true);
  assert.equal(result.dnr_no_conflicting_dynamic_or_session_overrides, true);
  assert.equal(result.allowed_maozi_read_count, AUDITED_MAOZI_API_ALLOWLIST.length);
  assert.equal(Object.hasOwn(result, "token"), false);
  await assert.rejects(auditExtensionSafetyAndRate({
    serviceWorkers: () => [{
      url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
      evaluate: async () => ({
        installedRules: auditedDynamicDnrRules(),
        conflictingOverrideRules: [{ id: 99999, action: "allow", priority: 99_999 }],
        unexpectedDynamicOrSessionRules: [{ id: 99999, action: "allow", priority: 99_999 }],
        pinnedSafeRule9001Audited: true,
        sessionRulesAudited: true,
        protectedSmokeBlockedPaths: [...AUDITED_MUTATION_ENDPOINTS],
        httpProtectedSmokeBlockedPaths: [...AUDITED_MUTATION_ENDPOINTS],
        expectedAmbiguousSmokeUrls: [...AMBIGUOUS_MAOZI_SMOKE_URLS],
        ambiguousSmokeBlockedUrls: [...AMBIGUOUS_MAOZI_SMOKE_URLS],
        checkDataSmokeBlocked: true,
        webRequestSmokeObserved: true,
        webRequestBeforeSmoke: {
          continuous: true,
          total: 0,
          byKind: {},
          byMethodPath: {},
          byScopeKind: { service_worker: {}, page_or_frame: {} },
        },
        webRequestAfterSmoke: {
          continuous: true,
          total: AUDITED_MUTATION_ENDPOINTS.length,
          byKind: {},
          byMethodPath: {},
          byScopeKind: { service_worker: {}, page_or_frame: {} },
        },
        matchedAfterSmoke: { available: false, counts: null, reason: "not-granted" },
        rulesPresent: true,
        autoFavoriteValues: [0],
        rateStatus: 200,
        rateCode: 1,
        rubCny: 0.07929,
        sku3Status: 200,
        sku3Code: 1,
      }),
    }],
  }), /audited set|rule 9001/u);
});

test("extension preflight exposes one closed secret-safe code for every direct failure branch", async (t) => {
  const codes = AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES;
  const valid = () => validExtensionPreflightAuditResult();
  const cases = [
    ["bootstrap DNR state missing", codes.BOOTSTRAP_DNR_STATE_MISSING,
      [{ failure_code: codes.BOOTSTRAP_DNR_STATE_MISSING }]],
    ["product rules JSON invalid", codes.PRODUCT_RULES_JSON_INVALID,
      [valid(), { failure_code: codes.PRODUCT_RULES_JSON_INVALID }]],
    ["token missing", codes.TOKEN_MISSING,
      [valid(), { failure_code: codes.TOKEN_MISSING }]],
    ["exchange-rate transport failure", codes.READ_API_TRANSPORT_FAILURE,
      [valid(), { failure_code: codes.READ_API_TRANSPORT_FAILURE, preflight_step: "exchange_rate_transport" }],
      "exchange_rate_transport"],
    ["sku3 transport failure", codes.READ_API_TRANSPORT_FAILURE,
      [valid(), { failure_code: codes.READ_API_TRANSPORT_FAILURE, preflight_step: "sku3_transport" }],
      "sku3_transport"],
    ["DNR ruleset mismatch", codes.DNR_RULESET_MISMATCH,
      [valid(), validExtensionPreflightAuditResult({ installedRules: auditedDynamicDnrRules().slice(1) })]],
    ["DNR override conflict", codes.DNR_OVERRIDE_CONFLICT,
      [valid(), validExtensionPreflightAuditResult({
        conflictingOverrideRules: [{ id: 99999, action: "allow", priority: 99999 }],
        unexpectedDynamicOrSessionRules: [{ id: 99999, action: "allow", priority: 99999 }],
      })]],
    ["check_data smoke escape", codes.CHECK_DATA_SMOKE_ESCAPE,
      [valid(), validExtensionPreflightAuditResult({ checkDataSmokeBlocked: false })]],
    ["mutation smoke escape", codes.MUTATION_SMOKE_ESCAPE,
      [valid(), validExtensionPreflightAuditResult({ protectedSmokeBlockedPaths: AUDITED_MUTATION_ENDPOINTS.slice(1) })]],
    ["HTTP smoke escape", codes.HTTP_SMOKE_ESCAPE,
      [valid(), validExtensionPreflightAuditResult({ httpProtectedSmokeBlockedPaths: AUDITED_MUTATION_ENDPOINTS.slice(1) })]],
    ["ambiguous-path smoke escape", codes.AMBIGUOUS_PATH_SMOKE_ESCAPE,
      [valid(), validExtensionPreflightAuditResult({ ambiguousSmokeBlockedUrls: AMBIGUOUS_MAOZI_SMOKE_URLS.slice(1) })]],
    ["webRequest observer continuity lost", codes.WEB_REQUEST_OBSERVER_LOST,
      [valid(), validExtensionPreflightAuditResult({
        webRequestBeforeSmoke: { continuous: false },
        webRequestSmokeObserved: false,
      })]],
    ["webRequest smoke key incomplete", codes.WEB_REQUEST_SMOKE_INCOMPLETE,
      [valid(), validExtensionPreflightAuditResult({
        webRequestSmokeObserved: false,
        webRequestSmokeDiagnostics: incompleteWebRequestSmokeDiagnostics(),
      })]],
    ["sku3 read failure", codes.SKU3_READ_FAILURE,
      [valid(), validExtensionPreflightAuditResult({ sku3Status: 503, sku3Code: 0 })]],
    ["exchange-rate read failure", codes.EXCHANGE_RATE_READ_FAILURE,
      [valid(), validExtensionPreflightAuditResult({ rateStatus: 503, rateCode: 0, rubCny: 0 })]],
    ["auto-favorite enabled", codes.AUTO_FAVORITE_ENABLED,
      [valid(), validExtensionPreflightAuditResult({ autoFavoriteValues: [1] })]],
  ];
  for (const [name, expectedCode, results, expectedStep] of cases) {
    await t.test(name, async () => {
      await assert.rejects(auditExtensionSafetyAndRate(extensionPreflightContext(...results)), (error) => {
        assert.equal(error.failure_code, expectedCode);
        if (expectedStep) assert.equal(error.preflight_step, expectedStep);
        const expectedEvidence = {
          failure_code: expectedCode,
          preflight_step: error.preflight_step,
          audit_phase: "preflight",
        };
        if (expectedCode === codes.WEB_REQUEST_SMOKE_INCOMPLETE) {
          Object.assign(expectedEvidence, safeIncompleteWebRequestSmokeEvidence());
        }
        assert.deepEqual(auditedExtensionPreflightFailureEvidence(error), expectedEvidence);
        return true;
      });
    });
  }
});

test("extension preflight exposes the observer and exact DNR digest before either read API", async () => {
  let observerBound = false;
  let evaluations = 0;
  const context = {
    serviceWorkers: () => [{
      url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
      evaluate: async () => {
        evaluations += 1;
        if (evaluations === 2) assert.equal(observerBound, true);
        return validExtensionPreflightAuditResult();
      },
    }],
  };
  await auditExtensionSafetyAndRate(context, {
    onObserverBound: async (evidence) => {
      observerBound = true;
      assert.equal(evidence.observer_bound, true);
      assert.equal(evidence.dnr_rules_exact, true);
      assert.match(evidence.dnr_rule_set_sha256, /^[a-f0-9]{64}$/u);
    },
  });
  assert.equal(evaluations, 2);
});

test("unknown preflight failures collapse to the closed fallback without retaining raw error data", () => {
  const secret = "Bearer secret-sentinel header-body-token";
  const evidence = auditedExtensionPreflightFailureEvidence(Object.assign(new Error(secret), {
    failure_code: "attacker-controlled-code",
    token: secret,
    headers: { Authorization: secret },
    body: secret,
  }));
  assert.deepEqual(evidence, {
    failure_code: AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.UNKNOWN,
    preflight_step: "extension_preflight",
    audit_phase: "preflight",
  });
  assert.equal(JSON.stringify(evidence).includes(secret), false);
});

test("a fake 35-second operation stays continuous through seven no-network observer heartbeats and postflight", async () => {
  let intervalHandler = null;
  let fakeNowMs = 0;
  let heartbeatEvaluations = 0;
  const worker = {
    url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
    evaluate: async (_pageFunction, request) => {
      if (Object.keys(request || {}).length === 1 && Object.hasOwn(request, "nonce")) {
        heartbeatEvaluations += 1;
        return { nonce_matches: true, listener_present: true, listener_registered: true };
      }
      return validExtensionPreflightAuditResult();
    },
  };
  const context = { serviceWorkers: () => [worker] };
  const safety = await auditExtensionSafetyAndRate(context);
  const monitor = createAuditedExtensionObserverContinuityMonitor(context, safety, {
    setIntervalFn: (handler, intervalMs) => {
      assert.equal(intervalMs, AUDITED_EXTENSION_OBSERVER_HEARTBEAT_INTERVAL_MS);
      intervalHandler = handler;
      return 1;
    },
    clearIntervalFn: () => {},
  });
  for (let index = 0; index < 7; index += 1) {
    fakeNowMs += AUDITED_EXTENSION_OBSERVER_HEARTBEAT_INTERVAL_MS;
    await monitor.pingNow();
  }
  const heartbeat = await monitor.stop();
  assert.equal(fakeNowMs, 35_000);
  assert.equal(heartbeatEvaluations, 7);
  assert.deepEqual(heartbeat, {
    audit_phase: "postflight",
    observer_continuous: true,
    successful_pings: 7,
  });
  const postflight = await auditExtensionFirewallPostflight(context, safety);
  assert.equal(postflight.web_request_audit_continuous, true);
});

test("observer heartbeat reports a restarted worker at the occurrence and stop awaits the failed ping", async () => {
  const secret = "secret-heartbeat-worker-error";
  let intervalHandler = null;
  let currentWorker;
  const originalWorker = {
    url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
    evaluate: async () => ({ nonce_matches: true, listener_present: true, listener_registered: true }),
  };
  const restartedWorker = {
    url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
    evaluate: async () => { throw new Error(secret); },
  };
  currentWorker = originalWorker;
  const occurrences = [];
  const monitor = createAuditedExtensionObserverContinuityMonitor(
    { serviceWorkers: () => [currentWorker] },
    { web_request_audit_nonce: "a".repeat(32) },
    {
      setIntervalFn: (handler) => { intervalHandler = handler; return 1; },
      clearIntervalFn: () => {},
      onFailure: async (error) => {
        occurrences.push({
          sequence: occurrences.length + 1,
          failure_code: error.failure_code,
          preflight_step: error.preflight_step,
          audit_phase: error.audit_phase,
        });
      },
    },
  );
  currentWorker = restartedWorker;
  const inFlight = intervalHandler();
  const stopping = monitor.stop();
  await inFlight;
  await assert.rejects(stopping, (error) => {
    assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
    assert.equal(error.audit_phase, "postflight");
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.deepEqual(occurrences, [{
    sequence: 1,
    failure_code: AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
    preflight_step: "web_request_observer_continuity",
    audit_phase: "postflight",
  }]);
  assert.equal(JSON.stringify(occurrences).includes(secret), false);
});

test("observer heartbeat bounds a hung worker evaluate and stop still fails with the closed postflight code", async () => {
  const worker = {
    url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
    evaluate: async () => new Promise(() => {}),
  };
  const monitor = createAuditedExtensionObserverContinuityMonitor(
    { serviceWorkers: () => [worker] },
    { web_request_audit_nonce: "b".repeat(32) },
    {
      intervalMs: 20,
      heartbeatTimeoutMs: 10,
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    },
  );
  const startedAt = Date.now();
  void monitor.pingNow();
  await assert.rejects(monitor.stop(), (error) => {
    assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
    assert.equal(error.preflight_step, "web_request_observer_continuity");
    assert.equal(error.audit_phase, "postflight");
    return true;
  });
  assert.equal(Date.now() - startedAt < 250, true);
});

test("observer heartbeat rejects an event-loop gap beyond one interval plus its bounded probe deadline", async () => {
  let nowMs = 0;
  let evaluations = 0;
  const worker = {
    url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
    evaluate: async () => {
      evaluations += 1;
      return { nonce_matches: true, listener_present: true, listener_registered: true };
    },
  };
  const monitor = createAuditedExtensionObserverContinuityMonitor(
    { serviceWorkers: () => [worker] },
    { web_request_audit_nonce: "c".repeat(32) },
    {
      intervalMs: 5_000,
      heartbeatTimeoutMs: 5_000,
      monotonicNow: () => nowMs,
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    },
  );
  nowMs = 10_001;
  await monitor.pingNow();
  await assert.rejects(monitor.stop(), (error) => {
    assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
    assert.equal(error.audit_phase, "postflight");
    return true;
  });
  assert.equal(evaluations, 0);
});

test("postflight bounds a hung worker evaluation with the closed observer-loss code", async () => {
  const context = {
    serviceWorkers: () => [{
      url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
      evaluate: async () => new Promise(() => {}),
    }],
  };
  const startedAt = Date.now();
  await assert.rejects(auditExtensionFirewallPostflight(context, {
    web_request_audit_nonce: "d".repeat(32),
  }, { evaluationTimeoutMs: 10 }), (error) => {
    assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
    assert.equal(error.preflight_step, "web_request_observer_continuity");
    assert.equal(error.audit_phase, "postflight");
    return true;
  });
  assert.equal(Date.now() - startedAt < 250, true);
});

test("bootstrap, preflight cleanup, and rate refresh all bound a hung extension worker", async () => {
  const never = () => new Promise(() => {});
  const hungContext = {
    serviceWorkers: () => [{
      url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
      evaluate: never,
    }],
  };
  const startedAt = Date.now();
  await assert.rejects(
    auditExtensionBootstrapLockdown(hungContext, { evaluationTimeoutMs: 10 }),
    (error) => {
      assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.BOOTSTRAP_DNR_STATE_MISSING);
      assert.equal(error.preflight_step, "bootstrap_dnr_recheck");
      assert.equal(error.audit_phase, "preflight");
      return true;
    },
  );
  await assert.rejects(auditExtensionSafetyAndRate(hungContext, {
    evaluationTimeoutMs: 10,
    observerCleanupTimeoutMs: 10,
  }), (error) => {
    assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
    assert.equal(error.audit_phase, "preflight");
    return true;
  });
  await assert.rejects(readAuditedCurrentExchangeRate(
    hungContext,
    () => new Date(NOW),
    { evaluationTimeoutMs: 10 },
  ), (error) => {
    assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.EXCHANGE_RATE_READ_FAILURE);
    assert.equal(error.preflight_step, "exchange_rate_read");
    assert.equal(error.audit_phase, "preflight");
    return true;
  });

  const secret = "secret exchange-rate transport details";
  await assert.rejects(readAuditedCurrentExchangeRate({
    serviceWorkers: () => [{
      url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
      evaluate: async () => ({ error: secret }),
    }],
  }), (error) => {
    assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.EXCHANGE_RATE_READ_FAILURE);
    assert.equal(error.preflight_step, "exchange_rate_read");
    assert.equal(error.audit_phase, "preflight");
    assert.equal(error.message.includes(secret), false);
    return true;
  });

  const workerLookupFailures = [
    { serviceWorkers: () => [] },
    { serviceWorkers: () => { throw new Error(secret); } },
    {
      serviceWorkers: () => [{
        url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
        evaluate: () => { throw new Error(secret); },
      }],
    },
  ];
  for (const [failureIndex, failingContext] of workerLookupFailures.entries()) {
    await assert.rejects(auditExtensionBootstrapLockdown(failingContext, {
      evaluationTimeoutMs: 10,
    }), (error) => {
      assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.BOOTSTRAP_DNR_STATE_MISSING);
      assert.equal(error.preflight_step, "bootstrap_dnr_recheck");
      assert.equal(error.audit_phase, "preflight");
      assert.equal(error.message.includes(secret), false);
      return true;
    });
    await assert.rejects(readAuditedCurrentExchangeRate(
      failingContext,
      () => new Date(NOW),
      { evaluationTimeoutMs: 10 },
    ), (error) => {
      assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.EXCHANGE_RATE_READ_FAILURE);
      assert.equal(error.preflight_step, "exchange_rate_read");
      assert.equal(error.audit_phase, "preflight");
      assert.equal(error.message.includes(secret), false);
      return true;
    });
    await assert.rejects(auditExtensionFirewallPostflight(failingContext, {
      web_request_audit_nonce: "d".repeat(32),
    }, { evaluationTimeoutMs: 10 }), (error) => {
      assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
      assert.equal(error.preflight_step, "web_request_observer_continuity");
      assert.equal(error.audit_phase, "postflight");
      assert.equal(error.message.includes(secret), false);
      return true;
    });
    if (failureIndex < 2) {
      assert.throws(() => createAuditedExtensionObserverContinuityMonitor(failingContext, {
        web_request_audit_nonce: "d".repeat(32),
      }), (error) => {
        assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
        assert.equal(error.preflight_step, "web_request_observer_continuity");
        assert.equal(error.audit_phase, "postflight");
        assert.equal(error.message.includes(secret), false);
        return true;
      });
    }
  }

  let evaluations = 0;
  const cleanupHangContext = {
    serviceWorkers: () => [{
      url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
      evaluate: async () => {
        evaluations += 1;
        if (evaluations === 1) {
          return validExtensionPreflightAuditResult({
            webRequestAfterSmoke: { continuous: false },
          });
        }
        return never();
      },
    }],
  };
  await assert.rejects(auditExtensionSafetyAndRate(cleanupHangContext, {
    evaluationTimeoutMs: 10,
    observerCleanupTimeoutMs: 10,
  }), (error) => {
    assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
    assert.equal(error.audit_phase, "preflight");
    return true;
  });
  assert.equal(evaluations, 2);
  assert.equal(Date.now() - startedAt < 250, true);
});

test("postflight distinguishes observer loss from incomplete exact smoke-key coverage", async () => {
  const safety = await auditExtensionSafetyAndRate(extensionPreflightContext(
    validExtensionPreflightAuditResult(),
    validExtensionPreflightAuditResult(),
  ));
  const postflightFailure = async (overrides) => {
    const worker = {
      url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
      evaluate: async () => validExtensionPreflightAuditResult(overrides),
    };
    try {
      await auditExtensionFirewallPostflight({ serviceWorkers: () => [worker] }, safety);
      assert.fail("postflight should fail");
    } catch (error) {
      return error;
    }
  };
  const lost = await postflightFailure({
    webRequestBeforeSmoke: { continuous: false },
    webRequestSmokeObserved: false,
  });
  assert.equal(lost.failure_code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
  assert.equal(lost.audit_phase, "postflight");
  const incomplete = await postflightFailure({ webRequestSmokeObserved: false });
  assert.equal(incomplete.failure_code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_SMOKE_INCOMPLETE);
  assert.equal(incomplete.audit_phase, "postflight");
  assert.notEqual(lost.failure_code, incomplete.failure_code);
});

test("DNR postflight computes continuous service-worker/page attempts without counting its own smoke", async () => {
  const rules = auditedDynamicDnrRules();
  const baselineKinds = { "analytics-upload": 2 };
  const baselineScopes = { service_worker: { "analytics-upload": 2 }, page_or_frame: {} };
  const preflight = {
    dnr_rule_set_sha256: auditExtensionSafetyAndRate.lastDigest,
    dnr_rules_exact: true,
    dnr_match_telemetry_available: false,
    dnr_match_telemetry_unavailable_reason: "not-granted",
    web_request_audit_nonce: "test-audit-nonce",
    web_request_audit_continuous: true,
    web_request_mutation_attempts_baseline: AUDITED_MUTATION_ENDPOINTS.length,
    web_request_mutation_by_kind_baseline: baselineKinds,
    web_request_audit_snapshot_baseline: {
      total: AUDITED_MUTATION_ENDPOINTS.length,
      by_kind: baselineKinds,
      by_scope_kind: baselineScopes,
    },
  };
  // Obtain the real rule digest through a valid preflight fake, avoiding a test-only
  // reimplementation of the canonical DNR digest algorithm.
  const start = await auditExtensionSafetyAndRate({
    serviceWorkers: () => [{
      url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
      evaluate: async () => ({
        installedRules: rules,
        conflictingOverrideRules: [],
        unexpectedDynamicOrSessionRules: [],
        pinnedSafeRule9001Audited: true,
        sessionRulesAudited: true,
        protectedSmokeBlockedPaths: [...AUDITED_MUTATION_ENDPOINTS],
        httpProtectedSmokeBlockedPaths: [...AUDITED_MUTATION_ENDPOINTS],
        expectedAmbiguousSmokeUrls: [...AMBIGUOUS_MAOZI_SMOKE_URLS],
        ambiguousSmokeBlockedUrls: [...AMBIGUOUS_MAOZI_SMOKE_URLS],
        checkDataSmokeBlocked: true,
        webRequestSmokeObserved: true,
        webRequestBeforeSmoke: {
          continuous: true,
          total: AUDITED_MUTATION_ENDPOINTS.length,
          byKind: baselineKinds,
          byMethodPath: {},
          byScopeKind: baselineScopes,
        },
        webRequestOperationalBaseline: continuousWebRequestSnapshot({
          total: AUDITED_MUTATION_ENDPOINTS.length,
          byKind: baselineKinds,
          byScopeKind: baselineScopes,
        }),
        webRequestSmokeDiagnostics: validWebRequestSmokeDiagnostics(),
        webRequestAfterSmoke: {
          continuous: true,
          total: AUDITED_MUTATION_ENDPOINTS.length,
          byKind: baselineKinds,
          byMethodPath: {},
          byScopeKind: baselineScopes,
        },
        matchedAfterSmoke: { available: false, counts: null, reason: "not-granted" },
        rulesPresent: true,
        autoFavoriteValues: [0],
        rateStatus: 200,
        rateCode: 1,
        rubCny: 0.07929,
        sku3Status: 200,
        sku3Code: 1,
      }),
    }],
  });
  preflight.dnr_rule_set_sha256 = start.dnr_rule_set_sha256;
  const post = await auditExtensionFirewallPostflight({
    serviceWorkers: () => [{
      url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
      evaluate: async () => ({
        installedRules: rules,
        conflictingOverrideRules: [],
        unexpectedDynamicOrSessionRules: [],
        pinnedSafeRule9001Audited: true,
        sessionRulesAudited: true,
        protectedSmokeBlockedPaths: [...AUDITED_MUTATION_ENDPOINTS],
        httpProtectedSmokeBlockedPaths: [...AUDITED_MUTATION_ENDPOINTS],
        expectedAmbiguousSmokeUrls: [...AMBIGUOUS_MAOZI_SMOKE_URLS],
        ambiguousSmokeBlockedUrls: [...AMBIGUOUS_MAOZI_SMOKE_URLS],
        checkDataSmokeBlocked: true,
        webRequestSmokeObserved: true,
        webRequestBeforeSmoke: {
          continuous: true,
          total: AUDITED_MUTATION_ENDPOINTS.length + 4,
          byKind: { "analytics-upload": 5, favorite: 1 },
          byMethodPath: {},
          byScopeKind: {
            service_worker: { "analytics-upload": 5 },
            page_or_frame: { favorite: 1 },
          },
        },
        webRequestOperationalBaseline: continuousWebRequestSnapshot({
          total: AUDITED_MUTATION_ENDPOINTS.length + 4,
          byKind: { "analytics-upload": 5, favorite: 1 },
          byScopeKind: {
            service_worker: { "analytics-upload": 5 },
            page_or_frame: { favorite: 1 },
          },
        }),
        webRequestSmokeDiagnostics: validWebRequestSmokeDiagnostics(),
        webRequestAfterSmoke: {
          continuous: true,
          total: AUDITED_MUTATION_ENDPOINTS.length + 4,
          byKind: { "analytics-upload": 5, favorite: 1 },
          byMethodPath: {},
          byScopeKind: {
            service_worker: { "analytics-upload": 5 },
            page_or_frame: { favorite: 1 },
          },
        },
        matchedBeforeSmoke: { available: false, counts: null, reason: "not-granted" },
        rateStatus: 200,
        rateCode: 1,
        rubCny: 0.07929,
        sku3Status: 200,
        sku3Code: 1,
      }),
    }],
  }, preflight);
  assert.equal(post.web_request_audit_continuous, true);
  assert.equal(post.all_contexts_state_mutation_attempts_observed, 1);
  assert.equal(post.service_worker_state_mutation_attempts_observed, 0);
  assert.equal(post.protected_analytics_upload_attempts_observed, 3);
});

test("exchange-rate provider refreshes after 60 seconds instead of stretching the five-minute evidence limit", async () => {
  let nowMs = Date.parse("2026-08-18T16:09:00.000Z");
  let refreshes = 0;
  const context = {
    serviceWorkers: () => [{
      url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
      evaluate: async () => {
        refreshes += 1;
        return { status: 200, code: 1, value: 0.08 };
      },
    }],
  };
  const provider = createAuditedExchangeRateProvider(context, {
    initial: { cny_per_rub: 0.079, observed_at: new Date(nowMs).toISOString() },
    now: () => new Date(nowMs),
  });
  assert.equal((await provider()).cny_per_rub, 0.079);
  nowMs += 59_000;
  assert.equal((await provider()).cny_per_rub, 0.079);
  nowMs += 2_000;
  const refreshed = await provider();
  assert.equal(refreshed.cny_per_rub, 0.08);
  assert.equal(refreshes, 1);
});

test("dedicated profile session files are quarantined/restored and startup web pages fail before firewall", async () => {
  assert.equal(assertAuditedNoSessionRestorePreferences({
    profile: { exit_type: "Normal" },
    session: { restore_on_startup: 5, startup_urls: [] },
  }), true);
  assert.throws(() => assertAuditedNoSessionRestorePreferences({
    profile: { exit_type: "Normal" },
    session: { restore_on_startup: 1 },
  }), /must not restore/u);
  assert.throws(() => assertAuditedNoSessionRestorePreferences({
    profile: { exit_type: "Crashed" },
  }), /clean Normal exit/u);
  assert.throws(() => assertNoPreFirewallWebPages({
    pages: () => [{ url: () => "https://www.ozon.ru/product/old-1/" }],
  }), /before the audited firewall/u);
  await withTempDir(async (profile) => {
    await fs.mkdir(path.join(profile, "Default", "Sessions"), { recursive: true });
    await fs.writeFile(path.join(profile, "Default", "Sessions", "Session_1"), "old-session");
    const isolation = await isolateAuditedProfileSessions(
      { userDataDir: profile },
      `test-${process.pid}-${Date.now()}`,
    );
    assert.deepEqual(await fs.readdir(path.join(profile, "Default", "Sessions")), []);
    assert.equal(await fs.readFile(
      path.join(isolation.quarantine, "Default", "Sessions", "Session_1"),
      "utf8",
    ), "old-session");
    await fs.writeFile(path.join(profile, "Default", "Sessions", "Session_generated"), "generated");
    await isolation.restore();
    assert.equal(await fs.readFile(
      path.join(profile, "Default", "Sessions", "Session_1"),
      "utf8",
    ), "old-session");
    await assert.rejects(fs.access(path.join(profile, "Default", "Sessions", "Session_generated")));
  });
});

test("dedicated quarantine/access-state capabilities reject symlink and hardlink escapes and shutdown proof sees profile residue", async () => {
  await withTempDir(async (lexicalDirectory) => {
    const directory = await fs.realpath(lexicalDirectory);
    const outside = path.join(directory, "outside");
    const runtimeRoot = path.join(directory, "runtime-root");
    await fs.mkdir(outside);
    await fs.mkdir(runtimeRoot);
    await fs.symlink(outside, path.join(runtimeRoot, "session-quarantine"));
    await assert.rejects(assertAuditedPathHasNoSymlinkOrHardlink(
      runtimeRoot,
      path.join(runtimeRoot, "session-quarantine", "owner"),
    ), /symlink/u);

    const hardlinkSource = path.join(directory, "outside-state.json");
    const hardlinkTarget = path.join(runtimeRoot, "hardlink-state.json");
    await fs.writeFile(hardlinkSource, "sentinel\n");
    await fs.link(hardlinkSource, hardlinkTarget);
    await assert.rejects(assertAuditedPathHasNoSymlinkOrHardlink(runtimeRoot, hardlinkTarget), /hard-linked/u);

    const quarantine = path.join(directory, "owner-quarantine");
    await fs.mkdir(quarantine);
    const accessState = path.join(quarantine, "runtime", "ozon-access-state.json");
    await fs.mkdir(path.dirname(accessState));
    await fs.symlink(hardlinkSource, accessState);
    await assert.rejects(prepareOwnedAccessStateFile({
      quarantine,
      access_state_file: accessState,
    }), /EEXIST|exist/u);
    assert.equal(await fs.readFile(hardlinkSource, "utf8"), "sentinel\n");

    const auditedProfile = path.join(directory, "audited-profile-tree");
    await fs.mkdir(path.join(auditedProfile, "Default"), { recursive: true });
    await fs.symlink(outside, path.join(auditedProfile, "Default", "Local Storage"));
    await assert.rejects(auditDedicatedProfileTree(auditedProfile), /symlink/u);
    await fs.unlink(path.join(auditedProfile, "Default", "Local Storage"));
    await fs.mkdir(path.join(auditedProfile, "Default", "Local Storage"));
    await fs.link(hardlinkSource, path.join(auditedProfile, "Default", "Local Storage", "state.db"));
    await assert.rejects(auditDedicatedProfileTree(auditedProfile), /hard-linked/u);

    const profile = path.join(directory, "profile-residue");
    await fs.mkdir(profile);
    await fs.writeFile(path.join(profile, "SingletonLock"), "residue");
    await assert.rejects(
      waitForAuditedBrowserStopped(null, 0, 10, profile),
      /singleton_residue=1/u,
    );
  });
});

test("owned runner persists a secret-safe preflight failure at the failure sequence with partial evidence", async () => {
  const secret = "Bearer secret-sentinel header-body-token query=secret";
  const lifecycleRows = [];
  const ownerRows = [];
  let operationCalls = 0;
  const context = { pages: () => [] };
  const options = {
    userDataDir: AUDITED_VALIDATION_PROFILE,
    extension: AUDITED_EXTENSION_DIR,
    chromiumExecutable: AUDITED_BROWSER_EXECUTABLE,
    remoteDebuggingPort: AUDITED_VALIDATION_DEBUG_PORT,
  };
  await assert.rejects(withAuditedValidationOwnedContext(options, async () => {
    operationCalls += 1;
  }, {
    assertRuntimePaths: async () => true,
    assertProductionStopped: async () => true,
    assertProfile: async () => ({ realpath: AUDITED_VALIDATION_PROFILE, device: 1, inode: 2 }),
    assertProfileTree: async () => true,
    assertExtension: async () => ({ sha256: AUDITED_EXTENSION_TREE_SHA256 }),
    assertBrowser: async () => ({ version: AUDITED_BROWSER_VERSION }),
    assertPort: async () => true,
    ownerLock: async () => ({
      token: "preflight-failure-test",
      update: async (row) => { ownerRows.push(structuredClone(row)); },
      release: async () => true,
    }),
    isolateSessions: async () => ({
      quarantine: "/tmp/preflight-failure-test",
      access_state_file: "/tmp/preflight-failure-test/runtime/ozon-access-state.json",
      moved: [],
      restore: async () => true,
    }),
    prepareAccessState: async (isolation) => isolation.access_state_file,
    browserOptions: () => ({ args: [], cdpEndpoint: null }),
    launchContext: async () => context,
    assertNoPreFirewallPages: async () => true,
    browserRoot: async () => ({ pid: 123456789, command: "audited browser" }),
    assertPortOwner: async () => true,
    extensionBootstrap: async () => ({
      contract: "ozon-audited-validation-bootstrap-lockdown-v1",
      host_resolver_blocked_before_dnr: true,
      prior_audited_rules_cleared_before_probe: true,
      protected_read_probe_blocked_before_dnr: true,
      persisted_full_host_lockdown: true,
      session_rules_empty: true,
      pinned_safe_rule_9001_audited: true,
      lockdown_rule_sha256: "c".repeat(64),
    }),
    installFirewall: async () => ({ snapshot: () => ({ context_route_blocked_mutation_attempts: 0 }) }),
    extensionPreflight: async (_ownedContext, { onObserverBound }) => {
      await onObserverBound({
        observer_bound: true,
        dnr_rules_exact: true,
        dnr_rule_set_sha256: "d".repeat(64),
      });
      throw Object.assign(new Error(secret), {
        failure_code: AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
        preflight_step: "web_request_observer_continuity",
        audit_phase: "preflight",
        token: secret,
        headers: { Authorization: secret },
        body: secret,
      });
    },
    closeContext: async () => true,
    verifyStopped: async () => true,
    lifecycle: { emit: async (row) => { lifecycleRows.push(structuredClone(row)); } },
  }), (error) => {
    assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
    assert.equal(error.failure_code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
    assert.equal(error.preflight_step, "web_request_observer_continuity");
    assert.equal(error.audit_phase, "preflight");
    assert.deepEqual(error.preflight_evidence, {
      bootstrap_lockdown_proven: true,
      observer_was_bound: true,
      dnr_rules_exact: true,
      dnr_rule_set_sha256: "d".repeat(64),
    });
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(operationCalls, 0);
  const observerIndex = lifecycleRows.findIndex((row) => row.cause === "operational_observer_bound");
  const failedIndex = lifecycleRows.findIndex((row) => (
    row.state === "listening" && row.cause === "operational_preflight_failed"
  ));
  const cleanupIndex = lifecycleRows.findIndex((row) => row.state === "closing" && row.phase === "operational");
  assert.ok(observerIndex >= 0 && observerIndex < failedIndex);
  assert.ok(failedIndex >= 0 && failedIndex < cleanupIndex);
  assert.deepEqual({
    failure_code: lifecycleRows[failedIndex].failure_code,
    preflight_step: lifecycleRows[failedIndex].preflight_step,
    audit_phase: lifecycleRows[failedIndex].audit_phase,
    observer_coverage: lifecycleRows[failedIndex].observer_coverage,
    bootstrap_lockdown_proven: lifecycleRows[failedIndex].bootstrap_lockdown_proven,
    observer_was_bound: lifecycleRows[failedIndex].observer_was_bound,
    dnr_rules_exact: lifecycleRows[failedIndex].dnr_rules_exact,
  }, {
    failure_code: AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
    preflight_step: "web_request_observer_continuity",
    audit_phase: "preflight",
    observer_coverage: "observer_was_bound_pre_failure",
    bootstrap_lockdown_proven: true,
    observer_was_bound: true,
    dnr_rules_exact: true,
  });
  assert.equal(lifecycleRows.slice(failedIndex + 1).some((row) => Object.hasOwn(row, "failure_code")), false);
  const persisted = JSON.stringify({
    timeline: lifecycleRows,
    result: null,
    manifest: null,
    owner: ownerRows,
  });
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes("Authorization"), false);
});

test("a wedged preflight-failure lifecycle preserves the coded primary and cannot block owned cleanup", async () => {
  const options = {
    userDataDir: AUDITED_VALIDATION_PROFILE,
    extension: AUDITED_EXTENSION_DIR,
    chromiumExecutable: AUDITED_BROWSER_EXECUTABLE,
    remoteDebuggingPort: AUDITED_VALIDATION_DEBUG_PORT,
  };
  const context = { pages: () => [] };
  let serializedLifecycle = Promise.resolve();
  let failureEmitAttempts = 0;
  let closeCalls = 0;
  let verifyCalls = 0;
  let restores = 0;
  let releases = 0;
  await assert.rejects(withAuditedValidationOwnedContext(options, async () => {
    throw new Error("operation must not run after preflight failure");
  }, {
    assertRuntimePaths: async () => true,
    assertProductionStopped: async () => true,
    assertProfile: async () => ({ realpath: AUDITED_VALIDATION_PROFILE, device: 1, inode: 2 }),
    assertProfileTree: async () => true,
    assertExtension: async () => ({ sha256: AUDITED_EXTENSION_TREE_SHA256 }),
    assertBrowser: async () => ({ version: AUDITED_BROWSER_VERSION }),
    assertPort: async () => true,
    ownerLock: async () => ({
      token: "preflight-failure-lifecycle-timeout",
      update: async () => true,
      release: async () => { releases += 1; },
    }),
    isolateSessions: async () => ({
      quarantine: "/tmp/preflight-failure-lifecycle-timeout",
      access_state_file: "/tmp/preflight-failure-lifecycle-timeout/runtime/ozon-access-state.json",
      moved: [],
      restore: async () => { restores += 1; },
    }),
    prepareAccessState: async (isolation) => isolation.access_state_file,
    browserOptions: () => ({ args: [], cdpEndpoint: null }),
    launchContext: async () => context,
    assertNoPreFirewallPages: async () => true,
    browserRoot: async () => ({ pid: 123456789, command: "audited browser" }),
    assertPortOwner: async () => true,
    extensionBootstrap: async () => ({
      contract: "ozon-audited-validation-bootstrap-lockdown-v1",
      host_resolver_blocked_before_dnr: true,
      prior_audited_rules_cleared_before_probe: true,
      protected_read_probe_blocked_before_dnr: true,
      persisted_full_host_lockdown: true,
      session_rules_empty: true,
      pinned_safe_rule_9001_audited: true,
      lockdown_rule_sha256: "c".repeat(64),
    }),
    installFirewall: async () => ({ snapshot: () => ({ context_route_blocked_mutation_attempts: 0 }) }),
    extensionPreflight: async (_ownedContext, { onObserverBound }) => {
      await onObserverBound({
        observer_bound: true,
        dnr_rules_exact: true,
        dnr_rule_set_sha256: "d".repeat(64),
      });
      throw Object.assign(new Error("secret preflight detail"), {
        code: AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
        failure_code: AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
        preflight_step: "web_request_observer_continuity",
        audit_phase: "preflight",
      });
    },
    closeContext: async () => { closeCalls += 1; },
    verifyStopped: async () => { verifyCalls += 1; return true; },
    ownedLifecycleEmitTimeoutMs: 10,
    lifecycle: {
      emit: (row) => {
        serializedLifecycle = serializedLifecycle.then(async () => {
          if (row.cause === "operational_preflight_failed") {
            failureEmitAttempts += 1;
            return new Promise(() => {});
          }
        });
        return serializedLifecycle;
      },
    },
  }), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
    assert.equal(error.failure_code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
    assert.equal(error.preflight_step, "web_request_observer_continuity");
    assert.equal(error.audit_phase, "preflight");
    assert.deepEqual(error.preflight_evidence, {
      bootstrap_lockdown_proven: true,
      observer_was_bound: true,
      dnr_rules_exact: true,
      dnr_rule_set_sha256: "d".repeat(64),
    });
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  assert.equal(failureEmitAttempts, 1);
  assert.equal(closeCalls, 2);
  assert.equal(verifyCalls, 2);
  assert.equal(restores, 1);
  assert.equal(releases, 1);
});

test("heartbeat failure skips postflight and still proves both browser shutdowns before releasing ownership", async () => {
  const options = {
    userDataDir: AUDITED_VALIDATION_PROFILE,
    extension: AUDITED_EXTENSION_DIR,
    chromiumExecutable: AUDITED_BROWSER_EXECUTABLE,
    remoteDebuggingPort: AUDITED_VALIDATION_DEBUG_PORT,
  };
  const lifecycleRows = [];
  let operationCalls = 0;
  let postflightCalls = 0;
  let closeCalls = 0;
  let stoppedProofs = 0;
  let releases = 0;
  let restores = 0;
  let failureEmitAttempts = 0;
  let serializedLifecycle = Promise.resolve();
  const context = { pages: () => [] };
  await assert.rejects(withAuditedValidationOwnedContext(options, async () => {
    operationCalls += 1;
    return { ok: true };
  }, {
    assertRuntimePaths: async () => true,
    assertProductionStopped: async () => true,
    assertProfile: async () => ({ realpath: AUDITED_VALIDATION_PROFILE, device: 1, inode: 2 }),
    assertProfileTree: async () => true,
    assertExtension: async () => ({ sha256: AUDITED_EXTENSION_TREE_SHA256 }),
    assertBrowser: async () => ({ version: AUDITED_BROWSER_VERSION }),
    assertPort: async () => true,
    ownerLock: async () => ({
      token: "heartbeat-timeout-cleanup-test",
      update: async () => true,
      release: async () => { releases += 1; },
    }),
    isolateSessions: async () => ({
      quarantine: "/tmp/heartbeat-timeout-cleanup-test",
      access_state_file: "/tmp/heartbeat-timeout-cleanup-test/runtime/ozon-access-state.json",
      moved: [],
      restore: async () => { restores += 1; },
    }),
    prepareAccessState: async (isolation) => isolation.access_state_file,
    browserOptions: () => ({ args: [], cdpEndpoint: null }),
    launchContext: async () => context,
    assertNoPreFirewallPages: async () => true,
    browserRoot: async () => ({ pid: 123456789, command: "audited browser" }),
    assertPortOwner: async () => true,
    extensionBootstrap: async () => ({
      contract: "ozon-audited-validation-bootstrap-lockdown-v1",
      host_resolver_blocked_before_dnr: true,
      prior_audited_rules_cleared_before_probe: true,
      protected_read_probe_blocked_before_dnr: true,
      persisted_full_host_lockdown: true,
      session_rules_empty: true,
      pinned_safe_rule_9001_audited: true,
      lockdown_rule_sha256: "c".repeat(64),
    }),
    installFirewall: async () => ({ snapshot: () => ({ context_route_blocked_mutation_attempts: 0 }) }),
    extensionPreflight: async () => ({
      exchange_rate_observed: 0.08,
      exchange_rate_observed_at: NOW,
      dnr_rule_set_sha256: "d".repeat(64),
      dnr_rules_exact: true,
      dnr_persisted_lockdown_observed_before_operational_switch: true,
      dnr_no_conflicting_dynamic_or_session_overrides: true,
      dnr_check_data_network_smoke_blocked: true,
      dnr_all_protected_maozi_path_smokes_blocked: true,
      dnr_http_maozi_path_smokes_blocked: true,
      dnr_ambiguous_maozi_path_smokes_blocked: true,
      dnr_pinned_safe_rule_9001_audited: true,
      dnr_sku3_post_read_smoke_ok: true,
      web_request_audit_nonce: "e".repeat(32),
      web_request_audit_continuous: true,
    }),
    observerMonitor: async (_ownedContext, _safety, { onFailure }) => ({
      stop: async () => {
        const failure = Object.assign(new Error("secret hung worker detail"), {
          code: AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
          failure_code: AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST,
          preflight_step: "web_request_observer_continuity",
          audit_phase: "postflight",
        });
        void onFailure(failure);
        await Promise.resolve();
        throw failure;
      },
    }),
    extensionPostflight: async () => {
      postflightCalls += 1;
      throw new Error("postflight must not run after observer loss");
    },
    rateProvider: () => async () => ({ cny_per_rub: 0.08, observed_at: NOW }),
    accessControllerFor: () => ({ run: (_request, operation) => operation() }),
    closeContext: async () => { closeCalls += 1; },
    verifyStopped: async () => { stoppedProofs += 1; return true; },
    ownedLifecycleEmitTimeoutMs: 10,
    lifecycle: {
      emit: (row) => {
        serializedLifecycle = serializedLifecycle.then(async () => {
          if (row.cause === "operational_postflight_failed") {
            failureEmitAttempts += 1;
            return new Promise(() => {});
          }
          lifecycleRows.push(structuredClone(row));
        });
        return serializedLifecycle;
      },
    },
  }), (error) => {
    assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
    assert.equal(error.failure_code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
    assert.equal(error.preflight_step, "web_request_observer_continuity");
    assert.equal(error.audit_phase, "postflight");
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  assert.equal(operationCalls, 1);
  assert.equal(postflightCalls, 0);
  assert.equal(closeCalls, 2);
  assert.equal(stoppedProofs, 2);
  assert.equal(restores, 1);
  assert.equal(releases, 1);
  assert.equal(failureEmitAttempts, 1);
  assert.equal(lifecycleRows.some((row) => (
    row.phase === "operational" && row.state === "closing"
  )), false, "a wedged serialized lifecycle must be abandoned so browser cleanup can finish");
});

test("a short zero-heartbeat operation cannot hang postflight and still reaches owned cleanup", async () => {
  const options = {
    userDataDir: AUDITED_VALIDATION_PROFILE,
    extension: AUDITED_EXTENSION_DIR,
    chromiumExecutable: AUDITED_BROWSER_EXECUTABLE,
    remoteDebuggingPort: AUDITED_VALIDATION_DEBUG_PORT,
  };
  let postflightCalls = 0;
  let closeCalls = 0;
  let stoppedProofs = 0;
  let releases = 0;
  let restores = 0;
  const worker = {
    url: () => `chrome-extension://${AUDITED_EXTENSION_ID}/background.js`,
    evaluate: async () => new Promise(() => {}),
  };
  const context = { pages: () => [], serviceWorkers: () => [worker] };
  await assert.rejects(withAuditedValidationOwnedContext(options, async () => ({ ok: true }), {
    assertRuntimePaths: async () => true,
    assertProductionStopped: async () => true,
    assertProfile: async () => ({ realpath: AUDITED_VALIDATION_PROFILE, device: 1, inode: 2 }),
    assertProfileTree: async () => true,
    assertExtension: async () => ({ sha256: AUDITED_EXTENSION_TREE_SHA256 }),
    assertBrowser: async () => ({ version: AUDITED_BROWSER_VERSION }),
    assertPort: async () => true,
    ownerLock: async () => ({
      token: "short-operation-postflight-timeout-test",
      update: async () => true,
      release: async () => { releases += 1; },
    }),
    isolateSessions: async () => ({
      quarantine: "/tmp/short-operation-postflight-timeout-test",
      access_state_file: "/tmp/short-operation-postflight-timeout-test/runtime/ozon-access-state.json",
      moved: [],
      restore: async () => { restores += 1; },
    }),
    prepareAccessState: async (isolation) => isolation.access_state_file,
    browserOptions: () => ({ args: [], cdpEndpoint: null }),
    launchContext: async () => context,
    assertNoPreFirewallPages: async () => true,
    browserRoot: async () => ({ pid: 123456789, command: "audited browser" }),
    assertPortOwner: async () => true,
    extensionBootstrap: async () => ({
      contract: "ozon-audited-validation-bootstrap-lockdown-v1",
      host_resolver_blocked_before_dnr: true,
      prior_audited_rules_cleared_before_probe: true,
      protected_read_probe_blocked_before_dnr: true,
      persisted_full_host_lockdown: true,
      session_rules_empty: true,
      pinned_safe_rule_9001_audited: true,
      lockdown_rule_sha256: "c".repeat(64),
    }),
    installFirewall: async () => ({ snapshot: () => ({ context_route_blocked_mutation_attempts: 0 }) }),
    extensionPreflight: async () => ({
      exchange_rate_observed: 0.08,
      exchange_rate_observed_at: NOW,
      dnr_rule_set_sha256: "d".repeat(64),
      dnr_rules_exact: true,
      dnr_persisted_lockdown_observed_before_operational_switch: true,
      dnr_no_conflicting_dynamic_or_session_overrides: true,
      dnr_check_data_network_smoke_blocked: true,
      dnr_all_protected_maozi_path_smokes_blocked: true,
      dnr_http_maozi_path_smokes_blocked: true,
      dnr_ambiguous_maozi_path_smokes_blocked: true,
      dnr_pinned_safe_rule_9001_audited: true,
      dnr_sku3_post_read_smoke_ok: true,
      web_request_audit_nonce: "f".repeat(32),
      web_request_audit_continuous: true,
    }),
    observerMonitor: async () => ({
      stop: async () => ({ observer_continuous: true, successful_pings: 0 }),
    }),
    extensionPostflight: async (ownedContext, safety) => {
      postflightCalls += 1;
      return auditExtensionFirewallPostflight(ownedContext, safety, { evaluationTimeoutMs: 10 });
    },
    rateProvider: () => async () => ({ cny_per_rub: 0.08, observed_at: NOW }),
    accessControllerFor: () => ({ run: (_request, operation) => operation() }),
    closeContext: async () => { closeCalls += 1; },
    verifyStopped: async () => { stoppedProofs += 1; return true; },
  }), (error) => {
    assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_OBSERVER_LOST);
    assert.equal(error.audit_phase, "postflight");
    return true;
  });
  assert.equal(postflightCalls, 1);
  assert.equal(closeCalls, 2);
  assert.equal(stoppedProofs, 2);
  assert.equal(restores, 1);
  assert.equal(releases, 1);
});

test("owned-context cleanup retains the owner lock on close or shutdown-proof failures", async () => {
  await assert.rejects(closeAuditedOwnedContext({ close: () => new Promise(() => {}) }, 10), /timed out/u);
  const options = {
    userDataDir: AUDITED_VALIDATION_PROFILE,
    extension: AUDITED_EXTENSION_DIR,
    chromiumExecutable: AUDITED_BROWSER_EXECUTABLE,
    remoteDebuggingPort: AUDITED_VALIDATION_DEBUG_PORT,
  };
  for (const failure of ["close", "shutdown-proof", "owner-release"]) {
    let releaseAttempts = 0;
    let orphanStatus = null;
    let restored = 0;
    let closeCalls = 0;
    let verifyCalls = 0;
    const context = { pages: () => [], close: async () => {} };
    await assert.rejects(withAuditedValidationOwnedContext(options, async () => {
      throw Object.assign(new Error("secret coded primary"), {
        code: AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.DNR_RULESET_MISMATCH,
        failure_code: AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.DNR_RULESET_MISMATCH,
        preflight_step: "dnr_exact_recheck",
        audit_phase: "preflight",
      });
    }, {
      assertRuntimePaths: async () => true,
      assertProductionStopped: async () => true,
      assertProfile: async () => ({ realpath: AUDITED_VALIDATION_PROFILE, device: 1, inode: 2 }),
      assertProfileTree: async () => true,
      assertExtension: async () => ({ sha256: AUDITED_EXTENSION_TREE_SHA256 }),
      assertBrowser: async () => ({ version: AUDITED_BROWSER_VERSION }),
      assertPort: async () => true,
      ownerLock: async () => ({
        token: "cleanup-test",
        update: async (row) => { if (row.status) orphanStatus = row.status; },
        release: async () => {
          releaseAttempts += 1;
          if (failure === "owner-release") throw new Error("secret owner release failure");
        },
      }),
      isolateSessions: async () => ({
        quarantine: "/tmp/cleanup-test",
        access_state_file: "/tmp/cleanup-test/runtime/ozon-access-state.json",
        moved: [],
        restore: async () => { restored += 1; },
      }),
      prepareAccessState: async (isolation) => isolation.access_state_file,
      browserOptions: () => ({ args: [], cdpEndpoint: null }),
      launchContext: async () => context,
      assertNoPreFirewallPages: async () => true,
      installFirewall: async () => ({ snapshot: () => ({}) }),
      browserRoot: async () => ({ pid: 123456789, command: "audited browser" }),
      assertPortOwner: async () => true,
      extensionBootstrap: async () => ({
        contract: "ozon-audited-validation-bootstrap-lockdown-v1",
        host_resolver_blocked_before_dnr: true,
        prior_audited_rules_cleared_before_probe: true,
        protected_read_probe_blocked_before_dnr: true,
        persisted_full_host_lockdown: true,
        session_rules_empty: true,
        pinned_safe_rule_9001_audited: true,
        lockdown_rule_sha256: "c".repeat(64),
      }),
      extensionPreflight: async () => ({
        exchange_rate_observed: 0.08,
        exchange_rate_observed_at: NOW,
        dnr_rule_set_sha256: "b".repeat(64),
        dnr_rules_exact: true,
        dnr_persisted_lockdown_observed_before_operational_switch: true,
        dnr_no_conflicting_dynamic_or_session_overrides: true,
        dnr_check_data_network_smoke_blocked: true,
        dnr_all_protected_maozi_path_smokes_blocked: true,
        dnr_http_maozi_path_smokes_blocked: true,
        dnr_ambiguous_maozi_path_smokes_blocked: true,
        dnr_pinned_safe_rule_9001_audited: true,
        dnr_sku3_post_read_smoke_ok: true,
      }),
      observerMonitor: async () => ({
        stop: async () => ({ observer_continuous: true, successful_pings: 1 }),
      }),
      extensionPostflight: async () => ({
        dnr_rule_set_sha256: "b".repeat(64),
        dnr_rules_exact: true,
        dnr_no_conflicting_dynamic_or_session_overrides: true,
        dnr_check_data_network_smoke_blocked: true,
        dnr_all_protected_maozi_path_smokes_blocked: true,
        dnr_http_maozi_path_smokes_blocked: true,
        dnr_ambiguous_maozi_path_smokes_blocked: true,
        dnr_pinned_safe_rule_9001_audited: true,
        dnr_sku3_post_read_smoke_ok: true,
        dnr_match_telemetry_available: false,
        web_request_audit_continuous: true,
        all_contexts_state_mutation_attempts_observed: 0,
        service_worker_state_mutation_attempts_observed: 0,
        protected_analytics_upload_attempts_observed: 0,
        all_contexts_protected_attempts_by_kind: {},
      }),
      rateProvider: () => async () => ({ cny_per_rub: 0.08, observed_at: NOW }),
      accessControllerFor: () => ({ run: (_request, operation) => operation() }),
      closeContext: async () => {
        closeCalls += 1;
        if (failure === "close" && closeCalls === 2) throw new Error("close failed");
      },
      verifyStopped: async () => {
        verifyCalls += 1;
        if (failure === "shutdown-proof" && verifyCalls === 2) throw new Error("PID or port still active");
        return true;
      },
    }), (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.DNR_RULESET_MISMATCH);
      assert.equal(error.failure_code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.DNR_RULESET_MISMATCH);
      assert.equal(error.preflight_step, "dnr_exact_recheck");
      assert.equal(error.audit_phase, "preflight");
      assert.equal(error.message.includes("secret"), false);
      return true;
    });
    assert.equal(releaseAttempts, failure === "owner-release" ? 1 : 0);
    assert.equal(orphanStatus, "orphan_cleanup_required");
    assert.equal(restored, failure === "shutdown-proof" ? 0 : 1);
  }

  for (const stalledCause of ["owned_context_cleanup_armed", "owned_context_stopped"]) {
    let released = 0;
    let orphanStatus = null;
    let restored = 0;
    let closeCalls = 0;
    let verifyCalls = 0;
    let serializedLifecycle = Promise.resolve();
    const context = { pages: () => [], close: async () => {} };
    await assert.rejects(withAuditedValidationOwnedContext(options, async () => ({ ok: true }), {
      assertRuntimePaths: async () => true,
      assertProductionStopped: async () => true,
      assertProfile: async () => ({ realpath: AUDITED_VALIDATION_PROFILE, device: 1, inode: 2 }),
      assertProfileTree: async () => true,
      assertExtension: async () => ({ sha256: AUDITED_EXTENSION_TREE_SHA256 }),
      assertBrowser: async () => ({ version: AUDITED_BROWSER_VERSION }),
      assertPort: async () => true,
      ownerLock: async () => ({
        token: `cleanup-lifecycle-${stalledCause}`,
        update: async (row) => { if (row.status) orphanStatus = row.status; },
        release: async () => { released += 1; },
      }),
      isolateSessions: async () => ({
        quarantine: `/tmp/cleanup-lifecycle-${stalledCause}`,
        access_state_file: `/tmp/cleanup-lifecycle-${stalledCause}/runtime/ozon-access-state.json`,
        moved: [],
        restore: async () => { restored += 1; },
      }),
      prepareAccessState: async (isolation) => isolation.access_state_file,
      browserOptions: () => ({ args: [], cdpEndpoint: null }),
      launchContext: async () => context,
      assertNoPreFirewallPages: async () => true,
      installFirewall: async () => ({ snapshot: () => ({ context_route_blocked_mutation_attempts: 0 }) }),
      browserRoot: async () => ({ pid: 123456789, command: "audited browser" }),
      assertPortOwner: async () => true,
      extensionBootstrap: async () => ({
        contract: "ozon-audited-validation-bootstrap-lockdown-v1",
        host_resolver_blocked_before_dnr: true,
        prior_audited_rules_cleared_before_probe: true,
        protected_read_probe_blocked_before_dnr: true,
        persisted_full_host_lockdown: true,
        session_rules_empty: true,
        pinned_safe_rule_9001_audited: true,
        lockdown_rule_sha256: "c".repeat(64),
      }),
      extensionPreflight: async () => ({
        exchange_rate_observed: 0.08,
        exchange_rate_observed_at: NOW,
        dnr_rule_set_sha256: "b".repeat(64),
        dnr_rules_exact: true,
        dnr_persisted_lockdown_observed_before_operational_switch: true,
        dnr_no_conflicting_dynamic_or_session_overrides: true,
        dnr_check_data_network_smoke_blocked: true,
        dnr_all_protected_maozi_path_smokes_blocked: true,
        dnr_http_maozi_path_smokes_blocked: true,
        dnr_ambiguous_maozi_path_smokes_blocked: true,
        dnr_pinned_safe_rule_9001_audited: true,
        dnr_sku3_post_read_smoke_ok: true,
      }),
      observerMonitor: async () => ({
        stop: async () => ({ observer_continuous: true, successful_pings: 1 }),
      }),
      extensionPostflight: async () => ({
        dnr_rule_set_sha256: "b".repeat(64),
        dnr_rules_exact: true,
        dnr_no_conflicting_dynamic_or_session_overrides: true,
        dnr_check_data_network_smoke_blocked: true,
        dnr_all_protected_maozi_path_smokes_blocked: true,
        dnr_http_maozi_path_smokes_blocked: true,
        dnr_ambiguous_maozi_path_smokes_blocked: true,
        dnr_pinned_safe_rule_9001_audited: true,
        dnr_sku3_post_read_smoke_ok: true,
        dnr_match_telemetry_available: false,
        web_request_audit_continuous: true,
        all_contexts_state_mutation_attempts_observed: 0,
        service_worker_state_mutation_attempts_observed: 0,
        protected_analytics_upload_attempts_observed: 0,
        all_contexts_protected_attempts_by_kind: {},
      }),
      rateProvider: () => async () => ({ cny_per_rub: 0.08, observed_at: NOW }),
      accessControllerFor: () => ({ run: (_request, operation) => operation() }),
      closeContext: async () => { closeCalls += 1; },
      verifyStopped: async () => { verifyCalls += 1; return true; },
      ownedLifecycleEmitTimeoutMs: 10,
      lifecycle: {
        emit: (row) => {
          serializedLifecycle = serializedLifecycle.then(async () => {
            if (row.cause === stalledCause) return new Promise(() => {});
          });
          return serializedLifecycle;
        },
      },
    }), /lifecycle emission timed out/u);
    assert.equal(closeCalls, 2);
    assert.equal(verifyCalls, 2);
    assert.equal(restored, 1);
    assert.equal(released, 1);
    assert.equal(orphanStatus, null);
  }
});

test("operation and postflight Aggregate preserves the primary audit phase and emits safe postflight failure first", async () => {
  const options = {
    userDataDir: AUDITED_VALIDATION_PROFILE,
    extension: AUDITED_EXTENSION_DIR,
    chromiumExecutable: AUDITED_BROWSER_EXECUTABLE,
    remoteDebuggingPort: AUDITED_VALIDATION_DEBUG_PORT,
  };
  let postflights = 0;
  let closes = 0;
  let stoppedProofs = 0;
  let releases = 0;
  let restores = 0;
  const secret = "secret-operation-and-postflight-sentinel";
  const lifecycleRows = [];
  const ownerRows = [];
  const context = { pages: () => [] };
  await assert.rejects(withAuditedValidationOwnedContext(options, async () => {
    const codedPrimary = Object.assign(new Error(secret), {
      code: AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.DNR_RULESET_MISMATCH,
      failure_code: AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.DNR_RULESET_MISMATCH,
      preflight_step: "dnr_exact_recheck",
      audit_phase: "preflight",
    });
    const cyclicCause = new Error("cyclic wrapper without audit metadata");
    cyclicCause.cause = cyclicCause;
    throw new Error("wrapped owned operation failure", {
      cause: new AggregateError(
        [cyclicCause, codedPrimary, new Error(secret)],
        "nested owned operation failure",
      ),
    });
  }, {
    assertRuntimePaths: async () => true,
    assertProductionStopped: async () => true,
    assertProfile: async () => ({ realpath: AUDITED_VALIDATION_PROFILE, device: 1, inode: 2 }),
    assertProfileTree: async () => true,
    assertExtension: async () => ({ sha256: AUDITED_EXTENSION_TREE_SHA256 }),
    assertBrowser: async () => ({ version: AUDITED_BROWSER_VERSION }),
    assertPort: async () => true,
    ownerLock: async () => ({
      token: "operation-error-test",
      update: async (row) => { ownerRows.push(structuredClone(row)); },
      release: async () => { releases += 1; },
    }),
    isolateSessions: async () => ({
      quarantine: "/tmp/operation-error-test",
      access_state_file: "/tmp/operation-error-test/runtime/ozon-access-state.json",
      moved: [],
      restore: async () => { restores += 1; },
    }),
    prepareAccessState: async (isolation) => isolation.access_state_file,
    browserOptions: () => ({ args: [], cdpEndpoint: null }),
    launchContext: async () => context,
    assertNoPreFirewallPages: async () => true,
    browserRoot: async () => ({ pid: 123456789, command: "audited browser" }),
    assertPortOwner: async () => true,
    extensionBootstrap: async () => ({
      contract: "ozon-audited-validation-bootstrap-lockdown-v1",
      host_resolver_blocked_before_dnr: true,
      prior_audited_rules_cleared_before_probe: true,
      protected_read_probe_blocked_before_dnr: true,
      persisted_full_host_lockdown: true,
      session_rules_empty: true,
      pinned_safe_rule_9001_audited: true,
      lockdown_rule_sha256: "c".repeat(64),
    }),
    installFirewall: async () => ({ snapshot: () => ({ context_route_blocked_mutation_attempts: 0 }) }),
    extensionPreflight: async () => ({
      exchange_rate_observed: 0.08,
      exchange_rate_observed_at: NOW,
      dnr_rule_set_sha256: "d".repeat(64),
      dnr_rules_exact: true,
      dnr_persisted_lockdown_observed_before_operational_switch: true,
      dnr_no_conflicting_dynamic_or_session_overrides: true,
      dnr_check_data_network_smoke_blocked: true,
      dnr_all_protected_maozi_path_smokes_blocked: true,
      dnr_http_maozi_path_smokes_blocked: true,
      dnr_ambiguous_maozi_path_smokes_blocked: true,
      dnr_pinned_safe_rule_9001_audited: true,
      dnr_sku3_post_read_smoke_ok: true,
      web_request_audit_nonce: "a".repeat(32),
      web_request_audit_continuous: true,
    }),
    observerMonitor: async () => ({
      stop: async () => ({ observer_continuous: true, successful_pings: 1 }),
    }),
    extensionPostflight: async () => {
      postflights += 1;
      throw Object.assign(new Error(secret), {
        code: AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_SMOKE_INCOMPLETE,
        failure_code: AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_SMOKE_INCOMPLETE,
        preflight_step: "web_request_smoke_keys",
        audit_phase: "postflight",
      });
    },
    rateProvider: () => async () => ({ cny_per_rub: 0.08, observed_at: NOW }),
    accessControllerFor: () => ({ run: (_request, operation) => operation() }),
    closeContext: async () => { closes += 1; },
    verifyStopped: async () => { stoppedProofs += 1; return true; },
    lifecycle: { emit: async (row) => { lifecycleRows.push(structuredClone(row)); } },
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.DNR_RULESET_MISMATCH);
    assert.equal(error.failure_code, AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.DNR_RULESET_MISMATCH);
    assert.equal(error.audit_phase, "preflight");
    assert.equal(error.primary_audit_phase, "preflight");
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(postflights, 1);
  assert.equal(closes, 2);
  assert.equal(stoppedProofs, 2);
  assert.equal(restores, 1);
  assert.equal(releases, 1);
  const failureIndex = lifecycleRows.findIndex((row) => row.cause === "operational_postflight_failed");
  const cleanupIndex = lifecycleRows.findIndex((row) => row.phase === "operational" && row.state === "closing");
  assert.ok(failureIndex >= 0 && failureIndex < cleanupIndex);
  assert.deepEqual({
    state: lifecycleRows[failureIndex].state,
    failure_code: lifecycleRows[failureIndex].failure_code,
    preflight_step: lifecycleRows[failureIndex].preflight_step,
    audit_phase: lifecycleRows[failureIndex].audit_phase,
    observer_was_bound: lifecycleRows[failureIndex].observer_was_bound,
    dnr_rules_exact: lifecycleRows[failureIndex].dnr_rules_exact,
  }, {
    state: "listening",
    failure_code: AUDITED_EXTENSION_PREFLIGHT_FAILURE_CODES.WEB_REQUEST_SMOKE_INCOMPLETE,
    preflight_step: "web_request_smoke_keys",
    audit_phase: "postflight",
    observer_was_bound: true,
    dnr_rules_exact: true,
  });
  assert.equal(JSON.stringify({ lifecycleRows, ownerRows }).includes(secret), false);
});

test("Playwright source adapter exposes only read-only source scanning and rejects non-owned contexts", async () => {
  const context = { newPage: async () => ({}) };
  assert.throws(() => createPlaywrightAuditedSourceScanAdapter({
    context,
    ownedContext: false,
    scanSourceWithPage: async () => ({}),
    scanOptions: {},
  }), /ownedContext=true/u);
  let received;
  const adapter = createPlaywrightAuditedSourceScanAdapter({
    context,
    ownedContext: true,
    scanSourceWithPage: async (request) => {
      received = request;
      return { final_url: request.url, links: [] };
    },
    scanOptions: { steps: 1 },
  });
  assert.deepEqual(Object.keys(adapter).sort(), [
    "contract", "favorite_mutations_allowed", "scan", "submission_allowed",
  ]);
  const row = await adapter.scan({ sourceUrl: "https://www.ozon.ru/seller/test/", sourceIndex: 2 });
  assert.equal(row.links.length, 0);
  assert.equal(received.context, context);
  assert.equal(received.url, "https://www.ozon.ru/seller/test/");
  assert.equal(Object.hasOwn(received, "maozi"), false);
  assert.equal(Object.hasOwn(received, "client"), false);
});

test("campaign manifest binds one run, epoch, artifact, exact 60-URL source set, and target >= 360", async () => {
  await withTempDir(async (directory) => {
    const artifact = await loadAuditedSourceArtifact(ARTIFACT_FILE);
    const policy = buildAuditedValidationSourcePolicy({ artifact, slots: 60, now: artifact.generated_at });
    const campaign = await createOrLoadAuditedDiscoveryCampaign({
      baseDirectory: directory,
      artifact,
      activeUrls: policy.active_urls,
      campaignEpoch: EPOCH,
      runId: RUN_ID,
      activatedAt: NOW,
      discoveryTarget: 360,
      now: () => new Date(NOW),
    });
    assert.equal(campaign.manifest.run_id, RUN_ID);
    assert.equal(campaign.manifest.campaign_epoch, EPOCH);
    assert.equal(campaign.manifest.source_count, 60);
    assert.equal(campaign.manifest.discovery_target, 360);
    assert.equal(campaign.manifest.favorite_mutations_allowed, false);
    assert.equal(campaign.manifest.submission_allowed, false);
    await assert.rejects(createOrLoadAuditedDiscoveryCampaign({
      baseDirectory: directory,
      artifact,
      activeUrls: policy.active_urls,
      campaignEpoch: EPOCH,
      runId: "different-run",
      discoveryTarget: 360,
      now: () => new Date(NOW),
    }), /run id/u);
    await assert.rejects(createOrLoadAuditedDiscoveryCampaign({
      baseDirectory: directory,
      artifact,
      activeUrls: policy.active_urls,
      campaignEpoch: "second-epoch",
      runId: RUN_ID,
      discoveryTarget: 359,
      now: () => new Date(NOW),
    }), /at least 360/u);
  });
});

test("manifest cannot self-sign a subset, reorder, or extra source set against the artifact", async () => {
  await withTempDir(async (directory) => {
    const { artifact, manifest, facts } = await discoveryFixture(directory);
    const variants = [];
    const subset = manifest.active_urls.slice(0, 1);
    variants.push({
      ...manifest,
      active_urls: subset,
      source_count: subset.length,
      source_set_sha256: auditedSourceSetSha256(subset),
    });
    const reordered = [...manifest.active_urls].reverse();
    variants.push({
      ...manifest,
      active_urls: reordered,
      source_set_sha256: auditedSourceSetSha256(reordered),
    });
    const extra = [...manifest.active_urls, `${manifest.active_urls[0]}&forged=1`];
    variants.push({
      ...manifest,
      active_urls: extra,
      source_count: extra.length,
      source_set_sha256: auditedSourceSetSha256(extra),
    });
    for (const forged of variants) {
      assert.throws(() => assembleAuditedValidationCandidates({
        artifact,
        manifest: forged,
        facts,
        enrichments: [],
        minimumCandidates: 300,
        now: () => new Date("2026-08-18T16:20:00.000Z"),
      }), /source set|exact artifact-derived|exactly 60/u);
    }
  });
});

test("derived campaign directories and JSONL leaves reject symlink or hardlink escapes before any write", async () => {
  await withTempDir(async (directory) => {
    const artifact = await loadAuditedSourceArtifact(ARTIFACT_FILE);
    const policy = buildAuditedValidationSourcePolicy({ artifact, slots: 60, now: artifact.generated_at });
    const escapeDirectory = path.join(directory, "production-like-escape");
    await fs.mkdir(escapeDirectory);
    await fs.symlink(escapeDirectory, path.join(directory, "audited_validation_discovery"));
    await assert.rejects(createOrLoadAuditedDiscoveryCampaign({
      baseDirectory: directory,
      artifact,
      activeUrls: policy.active_urls,
      campaignEpoch: EPOCH,
      runId: RUN_ID,
      activatedAt: NOW,
      discoveryTarget: 360,
      now: () => new Date(NOW),
    }), /ancestry|real directory|symlink/u);
    assert.deepEqual(await fs.readdir(escapeDirectory), []);
  });

  await withTempDir(async (directory) => {
    const artifact = await loadAuditedSourceArtifact(ARTIFACT_FILE);
    const policy = buildAuditedValidationSourcePolicy({ artifact, slots: 60, now: artifact.generated_at });
    const campaign = await createOrLoadAuditedDiscoveryCampaign({
      baseDirectory: directory,
      artifact,
      activeUrls: policy.active_urls,
      campaignEpoch: EPOCH,
      runId: RUN_ID,
      activatedAt: NOW,
      discoveryTarget: 360,
      now: () => new Date(NOW),
    });
    assert.equal(campaign.directory, auditedDiscoveryCampaignDirectory(directory, EPOCH));
    const outside = path.join(directory, "outside-sentinel.jsonl");
    await fs.writeFile(outside, "sentinel\n");
    const provenance = path.join(campaign.directory, campaign.manifest.files.provenance);
    await fs.symlink(outside, provenance);
    await assert.rejects(runAuditedValidationDiscovery({
      baseDirectory: directory,
      artifact,
      activeUrls: policy.active_urls,
      campaignEpoch: EPOCH,
      runId: RUN_ID,
      activatedAt: NOW,
      discoveryTarget: 360,
      env: SAFE_ENV,
      scanAdapter: createAuditedReadOnlySourceScanAdapter(async ({ sourceUrl }) => ({
        final_url: sourceUrl,
        stop_reason: "verified_empty",
        links: [],
      })),
    }), /single-link regular file/u);
    assert.equal(await fs.readFile(outside, "utf8"), "sentinel\n");
    await fs.unlink(provenance);
    const sourceScans = path.join(campaign.directory, campaign.manifest.files.source_scans);
    await fs.link(outside, sourceScans);
    await assert.rejects(runAuditedValidationDiscovery({
      baseDirectory: directory,
      artifact,
      activeUrls: policy.active_urls,
      campaignEpoch: EPOCH,
      runId: RUN_ID,
      activatedAt: NOW,
      discoveryTarget: 360,
      env: SAFE_ENV,
      scanAdapter: createAuditedReadOnlySourceScanAdapter(async ({ sourceUrl }) => ({
        final_url: sourceUrl,
        stop_reason: "verified_empty",
        links: [],
      })),
    }), /single-link regular file/u);
    assert.equal(await fs.readFile(outside, "utf8"), "sentinel\n");
  });
});

test("discovery reaches its independent 360 target without reading favorite capacity or mutating favorites", async () => {
  await withTempDir(async (directory) => {
    const { result, facts } = await discoveryFixture(directory);
    assert.equal(result.mode, "audited-validation-discovery-only");
    assert.equal(result.target_reached, true);
    assert.equal(result.stop_reason, "discovery_target_reached");
    assert.ok(result.eligible_unique >= 360);
    assert.ok(result.sources_completed <= 60);
    assert.equal(result.favorite_mutations, 0);
    assert.equal(result.orchestrator_submission_calls, 0);
    assert.equal(result.network_submission_attempts_observed, null);
    assert.ok(facts.length >= 360);
    for (const row of facts) {
      assert.equal(row.run_id, RUN_ID);
      assert.equal(row.campaign_epoch, EPOCH);
      assert.equal(row.activated_at, NOW);
      assert.equal(row.discovered_at, NOW);
      assert.match(row.artifact_sha256, /^[a-f0-9]{64}$/u);
      assert.match(row.source_set_sha256, /^[a-f0-9]{64}$/u);
      assert.equal(row.requires_live_detail_enrichment, true);
      assert.equal(row.evidence_scope, "audited-validation-bootstrap");
      assert.equal(Object.hasOwn(row, "accessory_role"), true);
      assert.equal(row.card_price_observations[0].currency, "RUB");
      assert.equal(row.card_price_observations[0].candidate_price_eligible, false);
    }
    const queueText = await fs.readFile(result.candidate_queue_file, "utf8");
    assert.match(queueText, /"status":"discovered"/u);
  });
});

test("builder ignores candidate_queue contamination and refuses any consumable output below 300", async () => {
  await withTempDir(async (directory) => {
    const { artifact, result, manifest, facts } = await discoveryFixture(directory);
    const fact = facts[0];
    const enrichment = normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      observation: liveObservation(fact, {
        current_price_raw: "234.40 ¥",
        title: `${fact.title} 详情核验`,
      }),
    });
    await appendAuditedLiveDetailEnrichment({
      campaignDirectory: result.campaign_directory,
      rows: [enrichment],
    });
    await fs.appendFile(result.candidate_queue_file, `${JSON.stringify({
      at: NOW,
      status: "discovered",
      sku: "9999999999",
      href: "https://www.ozon.ru/product/legacy-9999999999/",
      source_url: null,
      sell_price: 1,
    })}\n`);
    const candidateFile = path.join(directory, "candidates.json");
    const provenanceFile = path.join(directory, "candidate-provenance.json");
    await assert.rejects(buildAuditedValidationCandidatesFromCampaign({
      manifestFile: result.manifest_file,
      artifactFile: ARTIFACT_FILE,
      candidateOutputFile: candidateFile,
      provenanceOutputFile: provenanceFile,
      minimumCandidates: 300,
      now: LIVE_DETAIL_TEST_NOW,
    }), /not ready: 1\/300/u);
    await assert.rejects(fs.access(candidateFile));
    const assembled = assembleAuditedValidationCandidates({
      artifact,
      manifest,
      facts,
      enrichments: [enrichment],
      minimumCandidates: 300,
      now: () => new Date("2026-08-18T16:20:00.000Z"),
    });
    assert.equal(assembled.candidate_count, 1);
    assert.equal(assembled.ready, false);
    assert.equal(assembled.listing_card_price_used, false);
    assert.equal(assembled.candidates[0].sell_price, 234.4);
    assert.deepEqual(Object.keys(assembled.candidates[0]).sort(), [
      "cover_image", "sell_price", "sku", "title",
    ]);
    assert.equal(assembled.candidates[0].sku, fact.sku);
    assert.notEqual(assembled.candidates[0].sku, "9999999999");
    const rawArray = path.join(directory, "raw-array.json");
    await fs.writeFile(rawArray, `${JSON.stringify(assembled.candidates)}\n`);
    await assert.rejects(loadAuditedValidationCandidateFile(rawArray), /audited candidate-set envelope/u);
  });
});

test("card prices never become candidates and live detail requires one explicit unambiguous CNY price", async () => {
  await withTempDir(async (directory) => {
    const { artifact, manifest, facts } = await discoveryFixture(directory);
    const fact = facts[0];
    const withoutDetail = assembleAuditedValidationCandidates({
      artifact,
      manifest,
      facts: [fact],
      enrichments: [],
      minimumCandidates: 300,
    });
    assert.equal(withoutDetail.candidate_count, 0);
    assert.equal(withoutDetail.gaps[0].reason, "missing-live-detail-cny-enrichment");
    const base = liveObservation(fact);
    assert.throws(() => normalizeAuditedLiveDetailObservation({
      fact, manifest, artifact, observation: liveObservation(fact, { current_price_raw: "999 ₽" }),
    }), /requires a same-page/u);
    assert.throws(() => normalizeAuditedLiveDetailObservation({
      fact, manifest, artifact, observation: liveObservation(fact, { current_price_raw: "200 ¥ 250 ¥" }),
    }), /unambiguous CNY or RUB|unambiguous CNY or RUB price/u);
  });
});

test("live CNY parser accepts prefix/suffix ¥ and full-width ￥ but rejects RUB-only and conflicting prices", async () => {
  await withTempDir(async (directory) => {
    const { artifact, manifest, facts } = await discoveryFixture(directory);
    const fact = facts[0];
    for (const [raw, expected] of [["¥ 100.50", 100.5], ["100.50 ¥", 100.5], ["￥100.50", 100.5]]) {
      const row = normalizeAuditedLiveDetailObservation({
        fact, manifest, artifact, observation: liveObservation(fact, { current_price_raw: raw }),
      });
      assert.equal(row.sell_price, expected);
      assert.equal(row.price_evidence.source_field, "web_price_plus_same_page_follow_pair");
      assert.equal(row.price_evidence.raw_web_price_text, raw);
      assert.equal(row.price_evidence.rate_basis, "not-required-explicit-cny-current");
    }
    for (const raw of ["100 ₽", "¥100 ￥120", "100 ¥ 120 ¥"]) {
      assert.throws(() => normalizeAuditedLiveDetailObservation({
        fact, manifest, artifact, observation: liveObservation(fact, { current_price_raw: raw }),
      }), /same-page|unambiguous/u);
    }
    for (const [raw, expected] of [["¥1299", 1299], ["1299.50 ￥", 1299.5]]) {
      const row = normalizeAuditedLiveDetailObservation({
        fact, manifest, artifact, observation: liveObservation(fact, { current_price_raw: raw }),
      });
      assert.equal(row.sell_price, expected);
    }
    for (const ambiguous of ["¥1,299", "1.299,50 ￥", "¥1,299.50"]) {
      assert.throws(() => normalizeAuditedLiveDetailObservation({
        fact,
        manifest,
        artifact,
        observation: liveObservation(fact, { current_price_raw: ambiguous }),
      }), /parser disagrees|unambiguous/u);
    }
  });
});

test("real RUB webPrice uses the same-page pair, current API rate, conservative minimum, and tamper-proof rebuild", async () => {
  await withTempDir(async (directory) => {
    const { artifact, manifest, facts } = await discoveryFixture(directory);
    const fact = facts[0];
    const apiRate = 40.28 / 508;
    const observation = liveObservation(fact, {
      current_price_raw: "344 ₽",
      web_price_text: "344 ₽\n383 ₽",
      excluded_price_nodes: [{
        raw_text: "383 ₽",
        selector: "[data-testid=old-price]",
        visible: true,
        line_through: true,
        exclusion_reason: "line-through-old-price",
      }],
      follow_price_lines: ["跟卖最低价：₽508.00 ≈ ¥40.28"],
      api_rate_reference: {
        source: "maozi-current-exchange-rate-api",
        cny_per_rub: apiRate,
        observed_at: "2026-08-18T16:09:00.000Z",
      },
    });
    const row = normalizeAuditedLiveDetailObservation({ fact, manifest, artifact, observation });
    assert.equal(row.sell_price, 27.28);
    assert.equal(row.price_evidence.parsed.current_price, 27.28);
    assert.equal(row.price_evidence.parsed.follow_min, 40.28);
    assert.deepEqual(row.price_evidence.widget_explicit_rub_values, [344, 383]);
    assert.equal(row.price_evidence.excluded_price_nodes[0].raw_text, "383 ₽");
    assert.equal(row.price_evidence.parsed.observed_cny_rub_rate, 12.611718);
    assert.equal(row.price_evidence.selection_basis, "minimum-of-live-current-and-follow");
    assert.match(row.price_evidence.rate_basis, /current-api/u);
    for (const followPriceLines of [
      ["跟卖最低价：₽508.00 ≈ ¥40.28", "跟卖最低价：₽508.00 ≈ ¥40.28"],
      ["跟卖最低价：₽508.00 ≈ ¥40.28 ¥40.28"],
      ["跟卖最低价：₽508.00 ₽508.00 ≈ ¥40.28"],
    ]) {
      assert.throws(() => normalizeAuditedLiveDetailObservation({
        fact,
        manifest,
        artifact,
        observation: { ...observation, follow_price_lines: followPriceLines },
      }), /multiple follow-price|one explicit RUB≈CNY pair/u);
    }
    const assembled = assembleAuditedValidationCandidates({
      artifact,
      manifest,
      facts: [fact],
      enrichments: [row],
      minimumCandidates: 300,
      now: () => new Date("2026-08-18T16:20:00.000Z"),
    });
    assert.equal(assembled.candidates[0].sell_price, 27.28);
    assert.throws(() => assembleAuditedValidationCandidates({
      artifact,
      manifest,
      facts: [fact],
      enrichments: [{
        ...row,
        sell_price: 1,
        price_evidence: {
          ...row.price_evidence,
          parsed: { ...row.price_evidence.parsed, selected_price: 1 },
        },
      }],
      minimumCandidates: 300,
      now: () => new Date("2026-08-18T16:20:00.000Z"),
    }), /does not reparse/u);
    assert.throws(() => normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      observation: {
        ...observation,
        api_rate_reference: { ...observation.api_rate_reference, cny_per_rub: apiRate * 1.02 },
      },
    }), /does not match the current Maozi exchange-rate API/u);
    assert.throws(() => normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      observation: { ...observation, api_rate_reference: null },
    }), /does not match the current Maozi exchange-rate API/u);
    assert.throws(() => normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      observation: {
        ...observation,
        api_rate_reference: {
          ...observation.api_rate_reference,
          observed_at: "2026-08-18T16:04:59.999Z",
        },
      },
    }), /outside the current campaign observation window/u);
    assert.throws(() => normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      observation: {
        ...observation,
        api_rate_reference: {
          ...observation.api_rate_reference,
          observed_at: "2026-08-18T16:10:30.001Z",
        },
      },
    }), /outside the current campaign observation window/u);
  });
});

test("a safe discovery card is rejected when the live title becomes branded or leaves its audited category", async () => {
  await withTempDir(async (directory) => {
    const { artifact, manifest, facts } = await discoveryFixture(directory);
    const fact = facts[0];
    const base = liveObservation(fact);
    assert.throws(() => normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      observation: { ...base, title: "LEGO Star Wars Apple iPhone branded product" },
    }), /title no longer matches/u);
    const valid = normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      observation: { ...base, title: fact.title },
    });
    assert.equal(valid.live_title_guard_passed, true);
    assert.throws(() => normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      observation: {
        ...base,
        brand_evidence: { complete: true, source: "json-ld-product.brand", raw_brand: "БрендЖ" },
      },
    }), /declares a brand/u);
    assert.throws(() => normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      observation: {
        ...base,
        brand_evidence: { complete: false, source: null, raw_brand: null },
      },
    }), /complete structured brand evidence/u);
    assert.throws(() => normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      observation: {
        ...base,
        category_evidence: { complete: true, source: "visible-breadcrumbs", text: "детские игрушки" },
      },
    }), /category evidence/u);
    assert.throws(() => normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      observation: {
        ...base,
        item_evidence: { single_item_guard_passed: false, source: "json-ld-product.numberOfItems", item_count: 2 },
      },
    }), /single-item/u);
  });
});

test("multi-seller detail keeps exact source-seller provenance when Ozon defaults SKU 1279848485 to another seller", async () => {
  await withTempDir(async (directory) => {
    const { artifact, manifest, facts } = await discoveryFixture(directory);
    const sourceFact = facts.find((row) => !row.seller_url.includes("gadget-geek")) || facts[0];
    const fact = {
      ...sourceFact,
      sku: "1279848485",
      href: "https://www.ozon.ru/product/real-multi-seller-1279848485/",
    };
    const base = liveObservation(fact);
    const differentSeller = normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      observation: { ...base, seller_url: "https://www.ozon.ru/seller/gadget-geek/" },
    });
    assert.equal(differentSeller.seller_url, fact.seller_url);
    assert.equal(differentSeller.source_url, fact.source_url);
    assert.equal(differentSeller.observed_current_seller_url, "https://www.ozon.ru/seller/gadget-geek/");
    assert.throws(() => normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      observation: {
        ...base,
        seller_url: "https://www.ozon.ru/seller/gadget-geek/",
        seller_evidence_source: "arbitrary-anchor",
      },
    }), /explicit current-seller widget/u);
    const missingSeller = normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      observation: { ...base, seller_url: "", seller_evidence_source: null },
    });
    assert.equal(missingSeller.seller_url, fact.seller_url);
    assert.equal(missingSeller.observed_current_seller_url, null);
    const assembled = assembleAuditedValidationCandidates({
      artifact,
      manifest,
      facts: [fact],
      enrichments: [differentSeller],
      minimumCandidates: 300,
      now: () => new Date("2026-08-18T16:20:00.000Z"),
    });
    assert.equal(assembled.candidates.length, 1);
    assert.equal(assembled.provenance[0].seller_url, fact.seller_url);
  });
});

test("live detail enrichment is bounded, access-controlled, and isolates per-item failures", async () => {
  await withTempDir(async (directory) => {
    const { artifact, manifest, facts } = await discoveryFixture(directory);
    const selected = facts.slice(0, 12);
    let active = 0;
    let maximumActive = 0;
    const accessRequests = [];
    const accessAdapter = createAuditedLiveDetailAccessAdapter(async (request, operation) => {
      accessRequests.push(request);
      return operation();
    });
    const output = await enrichAuditedDiscoveryFacts({
      facts: selected,
      manifest,
      artifact,
      accessAdapter,
      concurrency: 3,
      now: LIVE_DETAIL_TEST_NOW,
      fetchLiveDetail: async (fact) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        if (fact.sku === selected[4].sku) throw new Error("isolated read failure");
        return liveObservation(fact, { seller_url: "" });
      },
    });
    assert.ok(maximumActive <= 3);
    assert.equal(accessRequests.length, selected.length);
    assert.equal(accessRequests.every((row) => row.kind === "audited-live-detail"), true);
    assert.equal(output.enrichment.length, selected.length - 1);
    assert.equal(output.gaps.length, 1);
    assert.equal(output.gaps[0].sku, selected[4].sku);
    await assert.rejects(enrichAuditedDiscoveryFacts({
      facts: selected,
      manifest,
      artifact,
      accessAdapter,
      concurrency: 5,
      fetchLiveDetail: async (fact) => liveObservation(fact),
    }), /between 1 and 4/u);
  });
});

test("successful live detail is checkpointed before a later CAPTCHA and resume never refetches it", async () => {
  await withTempDir(async (directory) => {
    const { result, facts } = await discoveryFixture(directory);
    const accessAdapter = createAuditedLiveDetailAccessAdapter((_request, operation) => operation());
    let calls = 0;
    await assert.rejects(enrichAuditedDiscoveryCampaign({
      manifestFile: result.manifest_file,
      artifactFile: ARTIFACT_FILE,
      accessAdapter,
      concurrency: 1,
      minimumCandidates: 300,
      now: () => new Date("2026-08-18T16:20:00.000Z"),
      fetchLiveDetail: async (fact) => {
        calls += 1;
        if (calls === 2) throw new Error("CAPTCHA verification required");
        return liveObservation(fact);
      },
    }), /CAPTCHA/u);
    assert.equal(calls, 2);
    const checkpointFile = path.join(result.campaign_directory, "live_detail_enrichment.jsonl");
    const checkpointed = (await fs.readFile(checkpointFile, "utf8")).trim().split(/\r?\n/u).map(JSON.parse);
    assert.equal(checkpointed.length, 1);
    assert.equal(checkpointed[0].sku, facts[0].sku);
    let resumedFact = null;
    await assert.rejects(enrichAuditedDiscoveryCampaign({
      manifestFile: result.manifest_file,
      artifactFile: ARTIFACT_FILE,
      accessAdapter,
      concurrency: 1,
      minimumCandidates: 300,
      now: () => new Date("2026-08-18T16:20:00.000Z"),
      fetchLiveDetail: async (fact) => {
        resumedFact = fact;
        throw new Error("CAPTCHA still requires manual attention");
      },
    }), /CAPTCHA/u);
    assert.ok(resumedFact);
    assert.notEqual(resumedFact.sku, facts[0].sku);
    assert.equal((await fs.readFile(checkpointFile, "utf8")).trim().split(/\r?\n/u).length, 1);
  });
});

test("Playwright live-detail fetcher uses owned pages only, reads the dedicated price widget, and always closes", async () => {
  await withTempDir(async (directory) => {
    const { facts } = await discoveryFixture(directory);
    const fact = facts[0];
    let closed = 0;
    let navigated = null;
    let evaluations = 0;
    const page = {
      goto: async (url, options) => {
        navigated = { url, options };
        return { status: () => 200 };
      },
      evaluate: async () => {
        evaluations += 1;
        if (evaluations === 1) throw new Error("Execution context was destroyed during navigation");
        return {
          ...liveObservation(fact, {
            current_price_raw: "344 ₽",
            web_price_text: "344 ₽\n383 ₽",
            excluded_price_nodes: [{
              raw_text: "383 ₽",
              selector: "[data-testid=old-price]",
              visible: true,
              line_through: true,
              exclusion_reason: "line-through-old-price",
            }],
            follow_price_lines: ["跟卖最低价：₽508.00 ≈ ¥40.28"],
            seller_url: "",
          }),
          document_title: fact.title,
          diagnostic: "商品详情",
        };
      },
      close: async () => { closed += 1; },
    };
    const context = { newPage: async () => page };
    assert.throws(() => createPlaywrightAuditedLiveDetailFetcher({ context }), /ownedContext=true/u);
    const fetchLiveDetail = createPlaywrightAuditedLiveDetailFetcher({
      context,
      ownedContext: true,
      apiCnyPerRub: 40.28 / 508,
      apiRateObservedAt: "2026-08-18T16:09:00.000Z",
      pollMs: 10,
      now: () => new Date("2026-08-18T16:10:00.000Z"),
    });
    const observation = await fetchLiveDetail(fact);
    assert.equal(navigated.url, fact.href);
    assert.equal(navigated.options.waitUntil, "commit");
    assert.equal(observation.price_field, "web_price_plus_same_page_follow_pair");
    assert.equal(observation.web_price_text, "344 ₽\n383 ₽");
    assert.equal(observation.current_price_node.raw_text, "344 ₽");
    assert.deepEqual(observation.follow_price_lines, ["跟卖最低价：₽508.00 ≈ ¥40.28"]);
    assert.equal(observation.seller_url, "");
    assert.equal(evaluations, 2);
    assert.equal(observation.price_dom_contract, PRICE_DOM_CONTRACT);
    assert.equal(closed, 1);
    assert.equal(Object.hasOwn(observation, "maozi"), false);
  });
});

test("Playwright live-detail fetcher rejects HTTP errors and hydration timeouts and still closes each owned page", async () => {
  await withTempDir(async (directory) => {
    const { facts } = await discoveryFixture(directory);
    const fact = facts[0];
    let httpClosed = 0;
    const httpFetcher = createPlaywrightAuditedLiveDetailFetcher({
      context: {
        newPage: async () => ({
          goto: async () => ({ status: () => 503 }),
          close: async () => { httpClosed += 1; },
        }),
      },
      ownedContext: true,
    });
    await assert.rejects(httpFetcher(fact), /HTTP 503/u);
    assert.equal(httpClosed, 1);

    let timeoutClosed = 0;
    const timeoutFetcher = createPlaywrightAuditedLiveDetailFetcher({
      context: {
        newPage: async () => ({
          goto: async () => ({ status: () => 200 }),
          evaluate: async () => ({
            final_url: fact.href,
            document_title: fact.title,
            title: "",
            cover_image: "",
            seller_url: "",
            web_price_text: "344 ₽",
            follow_price_lines: [],
            diagnostic: "hydrating",
          }),
          close: async () => { timeoutClosed += 1; },
        }),
      },
      ownedContext: true,
      observationTimeoutMs: 50,
      pollMs: 10,
    });
    await assert.rejects(timeoutFetcher(fact), /did not expose complete/u);
    assert.equal(timeoutClosed, 1);
  });
});

test("campaign enrichment entry resumes current facts concurrently and reaches the independent 300-candidate gate", async () => {
  await withTempDir(async (directory) => {
    const { result } = await discoveryFixture(directory);
    const accessAdapter = createAuditedLiveDetailAccessAdapter((_request, operation) => operation());
    const enriched = await enrichAuditedDiscoveryCampaign({
      manifestFile: result.manifest_file,
      artifactFile: ARTIFACT_FILE,
      accessAdapter,
      concurrency: 4,
      minimumCandidates: 300,
      now: () => new Date("2026-08-18T16:20:00.000Z"),
      fetchLiveDetail: async (fact) => liveObservation(fact),
    });
    assert.ok(enriched.enriched_this_run >= 300);
    assert.ok(enriched.candidate_count >= 300);
    assert.equal(enriched.ready, true);
    assert.equal(enriched.enrichment_gaps.length, 0);
    const candidateFile = path.join(directory, "audited-candidates.json");
    const provenanceFile = path.join(directory, "audited-candidate-provenance.json");
    const built = await buildAuditedValidationCandidatesFromCampaign({
      manifestFile: result.manifest_file,
      artifactFile: ARTIFACT_FILE,
      candidateOutputFile: candidateFile,
      provenanceOutputFile: provenanceFile,
      minimumCandidates: 300,
      now: () => new Date("2026-08-18T16:20:00.000Z"),
    });
    assert.equal(built.ready, true);
    const loaded = await loadAuditedValidationCandidateFile(candidateFile);
    assert.equal(loaded.length, 360);
    const envelope = JSON.parse(await fs.readFile(candidateFile, "utf8"));
    assert.equal(envelope.contract, "ozon-audited-validation-candidate-set-v1");
    assert.equal(envelope.candidate_count, 360);
    const resumed = await enrichAuditedDiscoveryCampaign({
      manifestFile: result.manifest_file,
      artifactFile: ARTIFACT_FILE,
      accessAdapter,
      concurrency: 4,
      minimumCandidates: 300,
      now: () => new Date("2026-08-18T16:20:00.000Z"),
      fetchLiveDetail: async () => { throw new Error("must not refetch completed facts"); },
    });
    assert.equal(resumed.pending_before, 0);
    assert.equal(resumed.enriched_this_run, 0);
    assert.equal(resumed.ready, true);
  });
});

test("a redirected audited source rejects the entire scan and persists no candidate facts", async () => {
  await withTempDir(async (directory) => {
    const artifact = await loadAuditedSourceArtifact(ARTIFACT_FILE);
    const policy = buildAuditedValidationSourcePolicy({ artifact, slots: 60, now: artifact.generated_at });
    const result = await runAuditedValidationDiscovery({
      baseDirectory: directory,
      artifact,
      activeUrls: policy.active_urls,
      campaignEpoch: EPOCH,
      runId: RUN_ID,
      discoveryTarget: 360,
      env: SAFE_ENV,
      concurrency: 4,
      now: () => new Date(NOW),
      scanAdapter: createAuditedReadOnlySourceScanAdapter(async ({ sourceUrl, sourceIndex }) => ({
        final_url: sourceIndex === 0 ? "https://www.ozon.ru/search/?text=redirected" : sourceUrl,
        links: sourceIndex === 0 ? [{
          href: "https://www.ozon.ru/product/forged-7777777777/",
          text: "светильник безопасный товар",
        }] : [],
      })),
    });
    assert.equal(result.eligible_unique, 0);
    const facts = await fs.readFile(result.provenance_file, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return "";
      throw error;
    });
    assert.equal(facts, "");
    const scans = (await fs.readFile(result.source_scans_file, "utf8")).trim().split(/\r?\n/u).map(JSON.parse);
    const rejected = scans.find((row) => row.source_url === policy.active_urls[0]);
    assert.equal(rejected.status, "failed");
    assert.match(rejected.stop_reason, /redirect-mismatch/u);
  });
});

test("zero-link max_steps scans remain retryable and are scanned again on resume", async () => {
  await withTempDir(async (directory) => {
    const artifact = await loadAuditedSourceArtifact(ARTIFACT_FILE);
    const policy = buildAuditedValidationSourcePolicy({ artifact, slots: 60, now: artifact.generated_at });
    let calls = 0;
    const request = {
      baseDirectory: directory,
      artifact,
      activeUrls: policy.active_urls,
      campaignEpoch: EPOCH,
      runId: RUN_ID,
      discoveryTarget: 360,
      env: SAFE_ENV,
      concurrency: 4,
      now: () => new Date(NOW),
      scanAdapter: createAuditedReadOnlySourceScanAdapter(async ({ sourceUrl }) => {
        calls += 1;
        return { final_url: sourceUrl, links: [], stop_reason: "max_steps", blocked: false };
      }),
    };
    const first = await runAuditedValidationDiscovery(request);
    assert.equal(first.sources_completed, 0);
    assert.equal(first.all_sources_completed, false);
    assert.equal(first.stop_reason, "retryable_source_failures_remain");
    assert.equal(calls, 60);
    const second = await runAuditedValidationDiscovery(request);
    assert.equal(second.sources_completed, 0);
    assert.equal(second.scanned_this_run, 60);
    assert.equal(calls, 120);
  });
});

test("old or incomplete provenance rows fail closed instead of leaking into the builder", async () => {
  await withTempDir(async (directory) => {
    const { artifact, manifest, facts } = await discoveryFixture(directory);
    const cases = [
      { ...facts[0], run_id: "old-run" },
      { ...facts[0], campaign_epoch: "old-epoch" },
      { ...facts[0], artifact_sha256: "0".repeat(64) },
      { ...facts[0], source_set_sha256: "0".repeat(64) },
      { ...facts[0], activated_at: undefined },
      { ...facts[0], discovered_at: undefined },
      { ...facts[0], source_url: null },
      { ...facts[0], accessory_role: "forged-main-product" },
    ];
    for (const row of cases) {
      assert.throws(() => assembleAuditedValidationCandidates({
        artifact,
        manifest,
        facts: [row],
        enrichments: [],
        minimumCandidates: 300,
      }), /audited validation discovery/u);
    }
  });
});

test("normalizer binds discovery to the requested exact source, never to a link-supplied legacy source", async () => {
  await withTempDir(async (directory) => {
    const artifact = await loadAuditedSourceArtifact(ARTIFACT_FILE);
    const policy = buildAuditedValidationSourcePolicy({ artifact, slots: 60, now: artifact.generated_at });
    const campaign = await createOrLoadAuditedDiscoveryCampaign({
      baseDirectory: directory,
      artifact,
      activeUrls: policy.active_urls,
      campaignEpoch: EPOCH,
      runId: RUN_ID,
      discoveryTarget: 360,
      now: () => new Date(NOW),
    });
    const sourceUrl = policy.active_urls[0];
    const target = artifact.targets.find((row) => row.seller_url === auditedSellerRoot(sourceUrl));
    const normalized = normalizeAuditedDiscoveryFact({
      sourceUrl,
      artifact,
      manifest: campaign.manifest,
      at: NOW,
      link: {
        href: "https://www.ozon.ru/product/exact-1234567890/",
        source_url: "https://www.ozon.ru/seller/legacy-history/",
        seller_url: "https://www.ozon.ru/seller/gadget-geek/",
        text: `${target.allow_terms_any[0]} безопасный товар`,
        card_text: "100 ₽",
      },
    });
    assert.equal(normalized.eligible, true);
    assert.equal(normalized.fact.source_url, sourceUrl);
    assert.equal(normalized.fact.seller_url, target.seller_url);
    assert.notEqual(normalized.fact.source_url, "https://www.ozon.ru/seller/legacy-history/");
  });
});

test("product and final URLs must remain canonical Ozon URLs and images must use Ozon-controlled hosts", async () => {
  await withTempDir(async (directory) => {
    const { artifact, manifest, facts } = await discoveryFixture(directory);
    const fact = facts[0];
    assert.throws(() => normalizeAuditedDiscoveryFact({
      sourceUrl: fact.source_url,
      artifact,
      manifest,
      at: NOW,
      link: {
        href: `https://evil.example/product/forged-${fact.sku}/`,
        text: fact.title,
      },
    }), /canonical Ozon product host/u);
    const base = liveObservation(fact, { current_price_raw: "¥ 100" });
    assert.throws(() => normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      observation: { ...base, final_url: `https://evil.example/product/fake-${fact.sku}/` },
    }), /canonical Ozon product host/u);
    assert.throws(() => normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      observation: { ...base, cover_image: "https://evil.example/fake.jpg" },
    }), /Ozon-controlled image host/u);
  });
});

test("campaign time ordering is revalidated for facts and live detail, including future skew", async () => {
  await withTempDir(async (directory) => {
    const { artifact, manifest, facts } = await discoveryFixture(directory);
    const fact = facts[0];
    assert.throws(() => assembleAuditedValidationCandidates({
      artifact,
      manifest,
      facts: [{ ...fact, discovered_at: "2026-08-18T16:04:59.999Z" }],
      minimumCandidates: 300,
      now: () => new Date("2026-08-18T16:20:00.000Z"),
    }), /predates campaign activation/u);
    assert.throws(() => assembleAuditedValidationCandidates({
      artifact,
      manifest,
      facts: [{ ...fact, discovered_at: "2099-01-01T00:00:00.000Z" }],
      minimumCandidates: 300,
      now: () => new Date("2026-08-18T16:20:00.000Z"),
    }), /future/u);
    const base = liveObservation(fact, { current_price_raw: "¥ 100" });
    assert.throws(() => normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      now: () => new Date("2026-08-18T16:20:00.000Z"),
      observation: { ...base, observed_at: "2026-08-18T16:04:59.999Z" },
    }), /predates its discovery/u);
    assert.throws(() => normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      now: () => new Date("2026-08-18T16:20:00.000Z"),
      observation: { ...base, observed_at: "2099-01-01T00:00:00.000Z" },
    }), /future/u);
    const valid = normalizeAuditedLiveDetailObservation({
      fact,
      manifest,
      artifact,
      now: () => new Date("2026-08-18T16:20:00.000Z"),
      observation: { ...base, observed_at: "2026-08-18T16:10:00.000Z" },
    });
    assert.throws(() => assembleAuditedValidationCandidates({
      artifact,
      manifest,
      facts: [fact],
      enrichments: [{
        ...valid,
        at: "2026-08-18T16:04:00.000Z",
        price_evidence: { ...valid.price_evidence, observed_at: "2026-08-18T16:04:00.000Z" },
      }],
      minimumCandidates: 300,
      now: () => new Date("2026-08-18T16:20:00.000Z"),
    }), /campaign-relative observation time/u);
  });
});
