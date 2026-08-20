import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUDITED_ARTIFACT_SHA256,
  AUDITED_REPORT_PASSED,
  AUDITED_SOURCE_EVENT_SCOPE,
  auditedCandidateEligibility,
  auditedSourceRedirectEligibility,
  buildAuditedRuntimeBinding,
  buildAuditedValidationSourcePolicy,
  loadAuditedRuntimeBinding,
  loadAuditedSourceArtifact,
  validateAuditedSourceArtifact,
  verifyAuditedSourceReportFile,
} from "../scripts/flow_b_playwright/audited-source-portfolio.mjs";
import {
  auditedPublishPayloadIdentity,
  filterAuditedAutomaticPublishFavorites,
  loadAuditedFavoritedFacts,
  withAuditedAutomaticPublishFavorites,
} from "../scripts/flow_b_playwright/continuous-runtime.mjs";
import { createCandidateQueue } from "../scripts/flow_b_playwright/candidate-queue.mjs";
import {
  buildStrictSellerSourcePolicy,
  sellerRootUrl,
} from "../scripts/flow_b_playwright/source-policy.mjs";
import {
  bindAuditedScanResult,
  filterAuditedSourceCandidates,
  selectRuntimeSourceUrls,
  sourcePortfolioMode,
} from "../scripts/flow_b_playwright/source-scanner.mjs";
import { auditedRunResumeIdentityDecision } from "../scripts/ozon_24h_control.mjs";

const ARTIFACT_FILE = path.resolve(
  import.meta.dirname,
  "../config/ozon_audited_source_portfolio.json",
);
const NOW = "2026-08-18T16:00:00.000Z";
const PACKAGED_REPORT_FILE = path.resolve(
  import.meta.dirname,
  "../evidence/final_acceptance_complete_union_v23.json",
);

async function artifact() {
  return loadAuditedSourceArtifact(ARTIFACT_FILE);
}

test("audited artifact binds the corrected 144/34 report and keeps validation separate from publication", async () => {
  const value = await artifact();
  assert.equal(value.provenance.denominator, 144);
  assert.equal(value.artifact_sha256, AUDITED_ARTIFACT_SHA256);
  assert.equal(value.provenance.passed, AUDITED_REPORT_PASSED);
  assert.equal(value.passed_products.length, 34);
  assert.equal(new Set(value.passed_products.map((row) => row.sku)).size, 34);
  assert.equal(value.passed_products.filter((row) => row.seller_url).length, 28);
  assert.equal(value.passed_products.filter((row) => !row.seller_url).length, 6);
  assert.equal(value.provenance.validation_rows_are_publications, false);
  assert.equal(value.deployment_phase, "validation_only");
  assert.equal(value.automatic_publish_eligible, false);
  assert.equal(value.source_report_resolved_path, PACKAGED_REPORT_FILE);
  const verified = await verifyAuditedSourceReportFile(PACKAGED_REPORT_FILE, value);
  assert.equal(verified.passed, 34);
});

test("candidate release requires the packaged corrected report and fails when evidence is omitted", async (t) => {
  const candidateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "audited-candidate-release-"));
  t.after(() => fs.rm(candidateRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(candidateRoot, "config"), { recursive: true });
  await fs.mkdir(path.join(candidateRoot, "evidence"), { recursive: true });
  const candidateArtifact = path.join(candidateRoot, "config", path.basename(ARTIFACT_FILE));
  const candidateReport = path.join(candidateRoot, "evidence", path.basename(PACKAGED_REPORT_FILE));
  await fs.copyFile(ARTIFACT_FILE, candidateArtifact);
  await fs.copyFile(PACKAGED_REPORT_FILE, candidateReport);
  const loaded = await loadAuditedSourceArtifact(candidateArtifact, { packageRoot: candidateRoot });
  assert.equal(loaded.source_report_resolved_path, candidateReport);
  const alteredArtifact = JSON.parse(await fs.readFile(candidateArtifact, "utf8"));
  alteredArtifact.targets[0].seller_url = "https://www.ozon.ru/seller/forged-safe-looking-seller/";
  await fs.writeFile(candidateArtifact, `${JSON.stringify(alteredArtifact, null, 2)}\n`);
  await assert.rejects(
    loadAuditedSourceArtifact(candidateArtifact, { packageRoot: candidateRoot }),
    /file SHA256 does not match the audited validation artifact/u,
  );
  await fs.copyFile(ARTIFACT_FILE, candidateArtifact);
  await fs.rm(candidateReport);
  await assert.rejects(
    loadAuditedSourceArtifact(candidateArtifact, { packageRoot: candidateRoot }),
    /evidence\/final_acceptance_complete_union_v23\.json could not be loaded/u,
  );
});

test("audited artifact fails closed on provenance or page-depth drift", async () => {
  const loaded = await artifact();
  const badHash = structuredClone(loaded);
  badHash.provenance.source_report_sha256 = "0".repeat(64);
  assert.throws(() => validateAuditedSourceArtifact(badHash), /report SHA256/u);

  const deepPage = structuredClone(loaded);
  deepPage.targets[0].max_page = 3;
  assert.throws(() => validateAuditedSourceArtifact(deepPage), /max_page must be <= 2/u);

  const wrongCurrencyScale = structuredClone(loaded);
  wrongCurrencyScale.targets[0].price_bands = [{ min: 1_000, max: 5_000 }];
  assert.throws(
    () => validateAuditedSourceArtifact(wrongCurrencyScale),
    /50-200 CNY discovery range/u,
  );

  const fakePassedSku = structuredClone(loaded);
  fakePassedSku.passed_products[0].sku = "9999999999";
  assert.throws(
    () => validateAuditedSourceArtifact(fakePassedSku),
    /SKU\/title set does not match/u,
  );

  const future = structuredClone(loaded);
  future.generated_at = "2999-01-01T00:00:00.000Z";
  assert.throws(() => validateAuditedSourceArtifact(future), /not in the future/u);
});

test("audited policy yields 60 exact bounded pages and prioritizes qinghong lighting", async () => {
  const value = await artifact();
  const policy = buildAuditedValidationSourcePolicy({
    artifact: value,
    slots: 60,
    now: new Date(NOW),
  });
  assert.equal(policy.evidence_mode, "audited-validation-bootstrap");
  assert.equal(policy.active_urls.length, 60);
  assert.deepEqual(policy.allocation, { exploit: 40, explore: 20 });
  assert.equal(policy.active_urls.slice(0, 40).every(
    (url) => sellerRootUrl(url) === "https://www.ozon.ru/seller/qinghong01/",
  ), true);
  assert.equal(policy.active_urls.every((url) => {
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get("page") || 1);
    const [, maximum] = String(parsed.searchParams.get("currency_price") || "").split(";").map(Number);
    return page <= 2
      && parsed.searchParams.has("currency_price")
      && maximum <= 200;
  }), true);
  assert.equal(new Set(policy.active_urls).size, 60);
  assert.equal(policy.active_urls.some((url) => /ip-tumnikov|stereo-store|kxh-hw/iu.test(url)), false);
});

test("audited candidate guard requires exact active attribution and the targeted safe category", async () => {
  const value = await artifact();
  const policy = buildAuditedValidationSourcePolicy({ artifact: value, slots: 60, now: NOW });
  const lightingSource = policy.active_urls.find(
    (url) => sellerRootUrl(url) === "https://www.ozon.ru/seller/qinghong01/",
  );
  const safe = {
    sku: "1",
    source_url: lightingSource,
    title: "GU10 светильник потолочный на 4 плафона",
  };
  assert.equal(auditedCandidateEligibility(safe, value, { activeUrls: policy.active_urls }).eligible, true);
  const groupedArtifact = {
    ...value,
    targets: value.targets.map((target) => target.id === "qinghong01-household-lighting"
      ? { ...target, required_term_groups_all: [["светильник"], ["gu10"]] }
      : target),
  };
  assert.equal(auditedCandidateEligibility({ ...safe, title: "Светильник потолочный" }, groupedArtifact, {
    activeUrls: policy.active_urls,
  }).reason, "audited-source-category-mismatch");
  assert.equal(auditedCandidateEligibility({ ...safe, source_url: null }, value, {
    activeUrls: policy.active_urls,
  }).reason, "audited-source-attribution-missing");
  assert.equal(auditedCandidateEligibility({ ...safe, title: "Star Wars Lego конструктор" }, value, {
    activeUrls: policy.active_urls,
  }).reason, "audited-source-global-risk-term");
  const forgedPage = "https://www.ozon.ru/seller/qinghong01/?page=999";
  assert.equal(auditedCandidateEligibility({ ...safe, source_url: forgedPage }, value, {
    activeUrls: [...policy.active_urls, forgedPage],
  }).reason, "audited-active-source-set-invalid");
  assert.equal(auditedSourceRedirectEligibility(
    lightingSource,
    "https://www.ozon.ru/search/?text=lighting",
    value,
    { activeUrls: policy.active_urls },
  ).reason, "audited-source-redirect-mismatch");
  const redirected = bindAuditedScanResult(lightingSource, {
    final_url: "https://www.ozon.ru/seller/other/",
    links: [{ href: "https://www.ozon.ru/product/fake-1/", text: safe.title }],
  }, value, policy.active_urls, null);
  assert.equal(redirected.links.length, 0);
  assert.equal(redirected.audited_source_rejected, true);
  assert.equal(filterAuditedSourceCandidates([
    safe,
    { ...safe, sku: "2", source_url: "https://www.ozon.ru/seller/ip-tumnikov/" },
  ], value, policy.active_urls).map((row) => row.sku).join(","), "1");
});

test("audited bootstrap supersedes historical accepted-like rows without creating strict publication credit", async () => {
  const value = await artifact();
  const historicalSeller = "https://www.ozon.ru/seller/legacy/";
  const policy = buildStrictSellerSourcePolicy({
    historicalBootstrapRows: [{
      at: "2026-08-01T00:00:00.000Z",
      status: "published",
      sku: "legacy",
      source_url: historicalSeller,
      strict_confirmed: true,
      online_status: "selling",
      stock: 1,
      profit_rate: 99,
      shipping_mode: "FBS",
    }],
    auditedValidationArtifact: value,
    now: NOW,
    slots: 60,
  });
  assert.equal(policy.evidence_mode, "audited-validation-bootstrap");
  assert.equal(policy.unique_strict, 0);
  assert.equal(policy.current_window.unique_strict, 0);
  assert.equal(policy.historical_bootstrap.unique_strict, 1);
  assert.equal(policy.historical_bootstrap.active, false);
  assert.equal(policy.audited_validation.publication_credit, 0);
});

test("current strict publications remain diagnostic and cannot switch an audited source epoch", async () => {
  const value = await artifact();
  const seller = "https://www.ozon.ru/seller/current-strict/";
  const policy = buildStrictSellerSourcePolicy({
    detailAttempts: [{
      at: "2026-08-18T15:00:00.000Z",
      stage: "ozon_detail_and_category",
      sku: "100",
      seller_url: seller,
    }],
    publications: [{
      sku: "100",
      source_url: seller,
      submitted_at: "2026-08-18T15:10:00.000Z",
      published_at: "2026-08-18T15:20:00.000Z",
      strict_confirmed: true,
      online_status: "selling",
      stock: 1,
      profit_rate: 31,
      shipping_mode: "FBS",
      fbs_evidence: { verified: true },
      cost_verified: true,
      cost: { ok: true, cost: 10 },
      quality_gate_passed: true,
    }],
    auditedValidationArtifact: value,
    windowStartedAt: "2026-08-18T14:00:00.000Z",
    now: NOW,
    slots: 10,
    rng: () => 0,
  });
  assert.equal(policy.evidence_mode, "audited-validation-bootstrap");
  assert.equal(policy.unique_strict, 1);
  assert.equal(policy.current_window.unique_strict, 1);
  assert.equal(policy.active_urls.every((url) => !url.includes("current-strict")), true);
});

test("a frozen persisted policy cannot smuggle non-artifact URLs into an audited epoch", async () => {
  const value = await artifact();
  const policy = buildStrictSellerSourcePolicy({
    auditedValidationArtifact: value,
    previousDecision: {
      policy_version: 2,
      evidence_mode: "audited-validation-bootstrap",
      audited_artifact_sha256: value.artifact_sha256,
      evaluated_at: "2026-08-18T15:00:00.000Z",
      frozen_until: "2026-08-18T18:00:00.000Z",
      active_urls: ["https://www.ozon.ru/seller/legacy-injected/?page=999"],
    },
    now: NOW,
    slots: 60,
  });
  assert.equal(policy.active_urls.length, 60);
  assert.equal(policy.active_urls.some((url) => url.includes("legacy-injected")), false);
});

test("direct audited mode selects configured exact URLs only and ignores fresh/derived/history expansion", async () => {
  const value = await artifact();
  const policy = buildAuditedValidationSourcePolicy({ artifact: value, slots: 60, now: NOW });
  const input = policy.active_urls;
  const env = {
    FLOW_B_DIRECT_PUBLISH: "1",
    FLOW_B_AUDITED_SOURCE_PORTFOLIO: "1",
    FLOW_B_STRICT_SOURCE_PORTFOLIO: "1",
  };
  assert.equal(sourcePortfolioMode(env), "audited-validation");
  const selected = selectRuntimeSourceUrls({
    mode: sourcePortfolioMode(env),
    inputUrls: input,
    expandedUrls: [
      ...input,
      "https://www.ozon.ru/search/?text=fresh",
      "https://www.ozon.ru/seller/legacy-history/",
      "https://www.ozon.ru/seller/derived/?page=9",
    ],
    allowlistUrls: input,
    directMode: true,
    allowlistMatch: "exact",
    auditedArtifact: value,
  });
  assert.deepEqual(selected, input);
});

test("automatic publish guard isolates source-null and legacy favorites; validation-only can still audit", async () => {
  const loaded = await artifact();
  const discoveryPolicy = buildAuditedValidationSourcePolicy({ artifact: loaded, slots: 60, now: NOW });
  const source = discoveryPolicy.active_urls[0];
  const runtimeBinding = buildAuditedRuntimeBinding({
    runId: "current-run",
    artifact: loaded,
    activeUrls: discoveryPolicy.active_urls,
    sourceSetEpoch: 2,
    sourceSetActivatedAt: "2026-08-18T15:30:00.000Z",
  });
  const favorites = [
    { sku: "good", title: "GU10 светильник потолочный" },
    { sku: "discovered-only", title: "GU10 светильник потолочный" },
    { sku: "old-favorite", title: "GU10 светильник потолочный" },
    { sku: "missing-fact", source_url: source, title: "GU10 светильник" },
    { sku: "source-null", title: "GU10 светильник" },
    { sku: "legacy", title: "GU10 светильник" },
  ];
  const currentFact = {
    evidence_scope: AUDITED_SOURCE_EVENT_SCOPE,
    status: "favorited",
    run_id: runtimeBinding.run_id,
    audited_artifact_sha256: runtimeBinding.audited_artifact_sha256,
    source_set_sha256: runtimeBinding.source_set_sha256,
    source_set_epoch: runtimeBinding.source_set_epoch,
    source_set_activated_at: runtimeBinding.source_set_activated_at,
    source_url: source,
    title: "GU10 светильник потолочный",
    ozon_category_id: "lighting-category",
  };
  const facts = new Map([
    ["good", {
      ...currentFact,
      sku: "good",
      at: "2026-08-18T15:40:00.000Z",
      favorited_at: "2026-08-18T15:40:00.000Z",
    }],
    ["discovered-only", {
      ...currentFact,
      status: "discovered",
      sku: "discovered-only",
      at: "2026-08-18T15:45:00.000Z",
    }],
    ["old-favorite", {
      ...currentFact,
      sku: "old-favorite",
      at: "2026-08-18T15:20:00.000Z",
      favorited_at: "2026-08-18T15:20:00.000Z",
    }],
    ["source-null", {
      ...currentFact,
      sku: "source-null",
      source_url: null,
      at: "2026-08-18T15:40:00.000Z",
    }],
    ["legacy", {
      ...currentFact,
      sku: "legacy",
      source_url: "https://www.ozon.ru/seller/legacy-history/",
      title: "GU10 светильник",
      at: "2026-08-18T15:40:00.000Z",
    }],
  ]);

  assert.deepEqual(filterAuditedAutomaticPublishFavorites(
    favorites,
    facts,
    loaded,
    { activeUrls: discoveryPolicy.active_urls, runtimeBinding },
  ), []);

  const futureProductionArtifact = {
    ...loaded,
    deployment_phase: "production_eligible",
    automatic_publish_eligible: true,
    targets: loaded.targets.map((target, index) => ({
      ...target,
      production_ozon_category_ids: index === 0 ? ["lighting-category"] : [],
    })),
  };
  assert.deepEqual(filterAuditedAutomaticPublishFavorites(
    favorites,
    facts,
    futureProductionArtifact,
    { activeUrls: discoveryPolicy.active_urls, runtimeBinding },
  ).map((row) => row.sku), ["good"]);
  assert.equal(filterAuditedAutomaticPublishFavorites(
    favorites,
    facts,
    loaded,
    { activeUrls: discoveryPolicy.active_urls, validationOnly: true },
  ).length, favorites.length);

  let publishCalls = 0;
  const wrapped = withAuditedAutomaticPublishFavorites({
    listFavorites: async () => favorites,
    publish: async () => { publishCalls += 1; },
  }, {
    runDir: path.dirname(ARTIFACT_FILE),
    artifact: loaded,
    activeUrlsFile: ARTIFACT_FILE,
    validationOnly: true,
  });
  await assert.rejects(
    wrapped.publish({ sku: "good" }),
    (error) => error?.code === "AUDITED_ARTIFACT_NOT_PRODUCTION_ELIGIBLE",
  );
  assert.equal(publishCalls, 0);
});

test("publish submit boundary requires one current favorited SKU with an epoch-bound offer", async (t) => {
  const loaded = await artifact();
  const discoveryPolicy = buildAuditedValidationSourcePolicy({ artifact: loaded, slots: 60, now: NOW });
  const activeUrls = discoveryPolicy.active_urls;
  const source = activeUrls[0];
  const productionArtifact = {
    ...loaded,
    deployment_phase: "production_eligible",
    automatic_publish_eligible: true,
    targets: loaded.targets.map((target, index) => ({
      ...target,
      production_ozon_category_ids: index === 0 ? ["lighting-category"] : [],
    })),
  };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audited-publish-boundary-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const activeUrlsFile = path.join(directory, "active_urls.txt");
  await fs.writeFile(activeUrlsFile, `${activeUrls.join("\n")}\n`);
  const binding = buildAuditedRuntimeBinding({
    runId: path.basename(directory),
    artifact: productionArtifact,
    activeUrls,
    sourceSetEpoch: 3,
    sourceSetActivatedAt: "2026-08-18T15:30:00.000Z",
  });
  await fs.writeFile(
    path.join(directory, "audited_source_identity.json"),
    `${JSON.stringify(binding)}\n`,
  );
  const fact = {
    evidence_scope: AUDITED_SOURCE_EVENT_SCOPE,
    status: "favorited",
    sku: "1234567890",
    title: "GU10 светильник потолочный",
    source_url: source,
    source_url_product: "https://www.ozon.ru/product/audited-1234567890/",
    ozon_category_id: "lighting-category",
    favorited_at: "2026-08-18T15:40:00.000Z",
    at: "2026-08-18T15:40:00.000Z",
    run_id: binding.run_id,
    audited_artifact_sha256: binding.audited_artifact_sha256,
    source_set_sha256: binding.source_set_sha256,
    source_set_epoch: binding.source_set_epoch,
    source_set_activated_at: binding.source_set_activated_at,
  };
  await fs.writeFile(path.join(directory, "favorite_collection.jsonl"), [
    JSON.stringify(fact),
    JSON.stringify({
      ...fact,
      status: "discovered",
      sku: "2234567890",
      favorited_at: undefined,
      discovered_at: "2026-08-18T15:45:00.000Z",
      at: "2026-08-18T15:45:00.000Z",
    }),
    "",
  ].join("\n"));

  const payload = {
    rows: [{
      id: 7001,
      sku: fact.sku,
      offer_id: `mz-180826-${fact.sku}`,
      link: `https://www.ozon.ru/product/audited-${fact.sku}/?sh=RfdA4TGV_proof-1`,
    }],
  };
  assert.deepEqual(auditedPublishPayloadIdentity(payload, binding), {
    eligible: true,
    reason: null,
    sku: fact.sku,
    favorite_id: "7001",
    canonical_link: `https://www.ozon.ru/product/audited-${fact.sku}/`,
    row: payload.rows[0],
  });
  let publishCalls = 0;
  let lastSubmittedPayload = null;
  let liveFavoriteId = 7001;
  const client = {
    listFavorites: async () => [{ id: liveFavoriteId, sku: fact.sku }],
    publish: async (submitted) => {
      publishCalls += 1;
      lastSubmittedPayload = submitted;
      return { ok: true, submitted };
    },
  };
  const wrapped = withAuditedAutomaticPublishFavorites(client, {
    runDir: directory,
    artifact: productionArtifact,
    activeUrlsFile,
  });
  await assert.rejects(
    wrapped.publish(payload),
    (error) => error?.reason === "audited-current-run-favorite-id-missing",
  );
  assert.deepEqual((await wrapped.listFavorites()).map((row) => row.sku), [fact.sku]);
  assert.equal((await wrapped.publish(payload)).ok, true);
  assert.equal(publishCalls, 1);
  assert.equal(
    lastSubmittedPayload.rows[0].link,
    `https://www.ozon.ru/product/audited-${fact.sku}/`,
    "the live Ozon sh query is accepted but stripped before ERP submission",
  );

  await assert.rejects(
    wrapped.publish({ rows: [{ ...payload.rows[0], offer_id: `mz-170826-${fact.sku}` }] }),
    (error) => error?.code === "AUDITED_PUBLISH_PAYLOAD_NOT_CURRENT"
      && error?.reason === "audited-publish-payload-predates-source-epoch",
  );
  await assert.rejects(
    wrapped.publish({ rows: [{ ...payload.rows[0], offer_id: "mz-180826-9999999999" }] }),
    (error) => error?.reason === "audited-publish-payload-sku-offer-mismatch",
  );
  await assert.rejects(
    wrapped.publish({ rows: [payload.rows[0], payload.rows[0]] }),
    (error) => error?.reason === "audited-publish-payload-row-count",
  );
  await assert.rejects(
    wrapped.publish({ rows: [{ ...payload.rows[0], id: 7000 }] }),
    (error) => error?.reason === "audited-current-run-favorite-id-mismatch",
  );
  for (const [link, reason] of [
    [undefined, "audited-publish-payload-link-invalid"],
    [`https://evil.example/product/audited-${fact.sku}/`, "audited-publish-payload-link-invalid"],
    ["https://www.ozon.ru/search/?text=audited", "audited-publish-payload-link-invalid"],
    [`https://www.ozon.ru/product/audited-${fact.sku}/?utm_source=legacy`, "audited-publish-payload-link-invalid"],
    [`https://www.ozon.ru/product/audited-${fact.sku}/?redirect=https%3A%2F%2Fevil.example`, "audited-publish-payload-link-invalid"],
    [`https://www.ozon.ru/product/audited-${fact.sku}/?url=https%3A%2F%2Fevil.example`, "audited-publish-payload-link-invalid"],
    [`https://www.ozon.ru/product/audited-${fact.sku}/?sh=proof&utm_source=legacy`, "audited-publish-payload-link-invalid"],
    [`https://www.ozon.ru/product/audited-${fact.sku}/?sh=proof#legacy`, "audited-publish-payload-link-invalid"],
    ["https://www.ozon.ru/product/audited-9999999999/", "audited-publish-payload-link-sku-mismatch"],
  ]) {
    await assert.rejects(
      wrapped.publish({ rows: [{ ...payload.rows[0], link }] }),
      (error) => error?.reason === reason,
    );
  }
  liveFavoriteId = 7002;
  assert.deepEqual((await wrapped.listFavorites()).map((row) => row.id), [7002]);
  await assert.rejects(
    wrapped.publish(payload),
    (error) => error?.reason === "audited-current-run-favorite-id-mismatch",
  );
  await assert.rejects(
    wrapped.publish({
      rows: [{
        id: 8001,
        sku: "2234567890",
        offer_id: "mz-180826-2234567890",
        link: "https://www.ozon.ru/product/2234567890",
      }],
    }),
    (error) => error?.reason === "audited-current-run-fact-missing",
  );
  assert.equal(publishCalls, 1, "old delayed/discovery-only payloads must never reach ERP publish");
});

test("candidate queue preserves audited discovery identity and rejects unbound legacy rows", async (t) => {
  const loaded = await artifact();
  const policy = buildAuditedValidationSourcePolicy({ artifact: loaded, slots: 60, now: NOW });
  const binding = buildAuditedRuntimeBinding({
    runId: "queue-run",
    artifact: loaded,
    activeUrls: policy.active_urls,
    sourceSetEpoch: 1,
    sourceSetActivatedAt: "2026-08-18T15:30:00.000Z",
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audited-candidate-queue-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const queue = createCandidateQueue(path.join(directory, "candidate_queue.jsonl"), {
    now: () => new Date("2026-08-18T15:40:00.000Z"),
  });
  await queue.load();
  await queue.discover([{
    href: "https://www.ozon.ru/product/audited-123/",
    source_url: policy.active_urls[0],
    text: "GU10 светильник",
    evidence_scope: AUDITED_SOURCE_EVENT_SCOPE,
    run_id: binding.run_id,
    audited_artifact_sha256: binding.audited_artifact_sha256,
    source_set_sha256: binding.source_set_sha256,
    source_set_epoch: binding.source_set_epoch,
    source_set_activated_at: binding.source_set_activated_at,
    discovered_at: "2026-08-18T15:40:00.000Z",
  }]);
  const [persisted] = queue.pending();
  for (const key of [
    "evidence_scope",
    "run_id",
    "audited_artifact_sha256",
    "source_set_sha256",
    "source_set_epoch",
    "source_set_activated_at",
    "discovered_at",
  ]) assert.notEqual(persisted[key], undefined, key);
  assert.equal(filterAuditedSourceCandidates(
    [persisted],
    loaded,
    policy.active_urls,
    binding,
  ).length, 1);
  const legacy = structuredClone(persisted);
  delete legacy.audited_artifact_sha256;
  delete legacy.source_set_sha256;
  delete legacy.source_set_epoch;
  assert.equal(filterAuditedSourceCandidates(
    [legacy],
    loaded,
    policy.active_urls,
    binding,
  ).length, 0);
  const unmarked = structuredClone(persisted);
  delete unmarked.evidence_scope;
  assert.equal(filterAuditedSourceCandidates(
    [unmarked],
    loaded,
    policy.active_urls,
    binding,
  ).length, 0);
  await fs.writeFile(path.join(directory, "favorite_collection.jsonl"), `${JSON.stringify({
    ...persisted,
    sku: "999",
    status: "favorited",
    favorited_at: "2026-08-18T15:41:00.000Z",
    at: "2026-08-18T15:41:00.000Z",
  })}\n`);
  const publishFacts = await loadAuditedFavoritedFacts(directory);
  assert.deepEqual([...publishFacts.keys()], ["999"]);
});

test("formal direct resume fails closed when artifact or active source identity is stale", async () => {
  const loaded = await artifact();
  const policy = buildAuditedValidationSourcePolicy({ artifact: loaded, slots: 60, now: NOW });
  const binding = buildAuditedRuntimeBinding({
    runId: "new-run",
    artifact: loaded,
    activeUrls: policy.active_urls,
    sourceSetActivatedAt: "2026-08-18T15:30:00.000Z",
  });
  const base = {
    current: {
      run_id: "new-run",
      formal_started: true,
      runtime_mode: "direct",
      audited_artifact_sha256: binding.audited_artifact_sha256,
      active_source_set_sha256: binding.source_set_sha256,
      source_set_epoch: 0,
      source_set_activated_at: binding.source_set_activated_at,
    },
    directManifest: {
      run_id: "new-run",
      audited_artifact_sha256: binding.audited_artifact_sha256,
      source_set_sha256: binding.source_set_sha256,
      source_set_activated_at: binding.source_set_activated_at,
    },
    sourcePortfolio: {
      audited_artifact_sha256: binding.audited_artifact_sha256,
      source_set_sha256: binding.source_set_sha256,
    },
    runtimeBinding: binding,
    auditedArtifactSha256: binding.audited_artifact_sha256,
    activeSourceSetSha256: binding.source_set_sha256,
  };
  assert.equal(auditedRunResumeIdentityDecision(base).action, "resume-current-run");
  assert.equal(auditedRunResumeIdentityDecision({
    ...base,
    current: { ...base.current, audited_artifact_sha256: "0".repeat(64) },
  }).action, "retire-and-create-new-run");
  assert.equal(auditedRunResumeIdentityDecision({
    ...base,
    activeSourceSetSha256: "f".repeat(64),
  }).action, "retire-and-create-new-run");
});

test("runtime epoch history cannot be replaced by an old campaign row", async (t) => {
  const loaded = await artifact();
  const policy = buildAuditedValidationSourcePolicy({ artifact: loaded, slots: 60, now: NOW });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audited-epoch-binding-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binding = buildAuditedRuntimeBinding({
    runId: "current-audited-campaign",
    artifact: loaded,
    activeUrls: policy.active_urls,
    sourceSetEpoch: 0,
    sourceSetActivatedAt: "2026-08-18T15:30:00.000Z",
  });
  await fs.writeFile(
    path.join(directory, "audited_source_identity.json"),
    `${JSON.stringify(binding)}\n`,
  );
  const initialEpoch = {
    type: "source-set-epoch",
    run_id: binding.run_id,
    at: binding.source_set_activated_at,
    epoch: 0,
    source_set_sha256: binding.source_set_sha256,
    previous_source_set_sha256: null,
    audited_artifact_sha256: binding.audited_artifact_sha256,
  };
  await fs.writeFile(
    path.join(directory, "source_set_epochs.jsonl"),
    `${JSON.stringify(initialEpoch)}\n`,
  );
  assert.equal(
    (await loadAuditedRuntimeBinding(directory, loaded, policy.active_urls)).run_id,
    binding.run_id,
  );
  await fs.appendFile(path.join(directory, "source_set_epochs.jsonl"), `${JSON.stringify({
    ...initialEpoch,
    run_id: "retired-campaign",
    epoch: 1,
    at: "2026-08-18T16:00:00.000Z",
    previous_source_set_sha256: binding.source_set_sha256,
  })}\n`);
  await assert.rejects(
    loadAuditedRuntimeBinding(directory, loaded, policy.active_urls),
    /not bound to the audited campaign identity/u,
  );
});
