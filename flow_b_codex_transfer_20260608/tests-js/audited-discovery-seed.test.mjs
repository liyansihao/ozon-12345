import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUDITED_CARD_PRICE_EVIDENCE_SCOPE,
  AUDITED_DERIVED_CAPACITY_DETAIL_CHECKPOINT_CONTRACT,
  AUDITED_DERIVED_CAPACITY_MINIMUM,
  AUDITED_DISCOVERY_EXACT_SOURCE_COUNT,
  AUDITED_DISCOVERY_EXACT_URL_TEXT_SHA256,
  AUDITED_DISCOVERY_LOGICAL_SEED_COUNT,
  AUDITED_DISCOVERY_SEED_ARTIFACT_SHA256,
  AUDITED_DISCOVERY_SEED_CONTRACT,
  AUDITED_DISCOVERY_SEED_DETAIL_CHECKPOINT_CONTRACT,
  AUDITED_DISCOVERY_SEED_OBSERVATION_CONTRACT,
  AUDITED_DISCOVERY_SEED_SCOPE,
  AUDITED_DERIVED_CAPACITY_OBSERVATION_CONTRACT,
  AUDITED_DERIVED_CAPACITY_SCOPE,
  AUDITED_LIVE_BRAND_EVIDENCE_SOURCE,
  AUDITED_LIVE_PRICE_EVIDENCE_SCOPE,
  AUDITED_LIVE_SELLER_EVIDENCE_SOURCE,
  attestAuditedDerivedCapacity,
  auditedCardPriceEligibility,
  auditedDerivedArtifactSha256,
  auditedSeedObservationEligibility,
  auditedSeedTitleEligibility,
  buildAuditedDerivedCapacityBinding,
  buildAuditedSeedBinding,
  compileAuditedDerivedSellerPortfolio,
  createAuditedSeedReadOnlyAdapter,
  loadAuditedDerivedSellerArtifact,
  loadAuditedDiscoverySeedArtifact,
  promoteAuditedDerivedSellerPortfolio,
  runAuditedDerivedCapacityProbe,
  runAuditedSeedObservationDiscovery,
  validateAuditedDiscoverySeedArtifact,
} from "../scripts/flow_b_playwright/audited-discovery-seed.mjs";
import { loadAuditedSourceArtifact } from "../scripts/flow_b_playwright/audited-source-portfolio.mjs";
import { mergeAuditedListingCardLinkEvidence } from "../scripts/flow_b_playwright/source-scanner.mjs";
import {
  AUDITED_DERIVED_CAPACITY_ACTIVATION_CONTRACT,
  AuditedSeedPipelineNotReadyError,
  parseAuditedSeedPipelineArgs,
  runAuditedSeedPipelineCli,
} from "../scripts/audited_seed_pipeline.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SEED_FILE = path.join(PACKAGE_ROOT, "config", "ozon_audited_discovery_seeds.json");
const NOW = new Date("2026-08-19T06:00:00.000Z");
const SEED_ACTIVATED_AT = "2026-08-19T01:00:00.000Z";

let artifact;

function roleEvidence(attributes) {
  return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, {
    source: "ozon-live-detail-attribute-table",
    label: key,
    raw_value: String(value),
    normalized_value: String(value),
  }]));
}

function structuredEvidence(categoryKey) {
  return {
    category: {
      source: "ozon-live-detail-breadcrumb",
      raw_value: categoryKey,
      normalized_value: categoryKey,
    },
    item_count: {
      source: "ozon-live-detail-attribute-table",
      raw_value: "1 шт.",
      normalized_value: 1,
    },
    bundle: {
      source: "ozon-live-detail-attribute-table",
      raw_value: "один предмет; не набор",
      is_bundle: false,
      is_set: false,
    },
    compatibility: {
      source: "ozon-live-detail-attribute-table",
      raw_value: "универсальный",
      normalized_value: "generic",
    },
  };
}

function priceEvidence(observedAt = "2026-08-19T02:00:00.000Z", overrides = {}) {
  const cnyPerRub = 30.37 / 383;
  return {
    live_price_evidence_scope: AUDITED_LIVE_PRICE_EVIDENCE_SCOPE,
    live_price_evidence: {
      method: "ozon-detail-plugin-live",
      live: true,
      source_field: "web_price_plus_same_page_follow_pair",
      dom_contract: "webPrice.innerText + one same-page Maozi 跟卖最低价 RUB≈CNY line; parseOzonDetailText(fallback=null)-v1",
      raw_web_price_text: "344 ₽\n383 ₽",
      current_price_rub_text: "344 ₽",
      old_price_rub_texts: ["383 ₽"],
      raw_follow_price_line: "跟卖最低价: 383 ₽ ≈ ¥30.37",
      api_rate_reference: {
        source: "maozi-current-exchange-rate-api",
        cny_per_rub: cnyPerRub,
        observed_at: "2026-08-19T01:59:30.000Z",
      },
      observed_at: observedAt,
      ...overrides,
    },
  };
}

function cardPriceEvidence(currentRub = 344, oldRub = 383, overrides = {}) {
  return {
    scope: AUDITED_CARD_PRICE_EVIDENCE_SCOPE,
    current_candidate_count: 1,
    raw_card_text: `${currentRub} ₽\n${oldRub} ₽`,
    current_price_node: {
      evidence_source: "listing-card-visible-nonstruck-leaf-v1",
      raw_text: `${currentRub} ₽`,
      visible: true,
      line_through: false,
      installment: false,
    },
    excluded_price_nodes: [{
      evidence_source: "listing-card-visible-struck-leaf-v1",
      raw_text: `${oldRub} ₽`,
      visible: true,
      line_through: true,
      exclusion_reason: "line-through-old-price",
    }],
    ...overrides,
  };
}

function seedObservation(seed, binding, sku, sellerUrl, overrides = {}) {
  const observedAt = overrides.observed_at || "2026-08-19T02:00:00.000Z";
  const productUrl = `https://www.ozon.ru/product/${sku}/`;
  return {
    contract: AUDITED_DISCOVERY_SEED_OBSERVATION_CONTRACT,
    evidence_scope: AUDITED_DISCOVERY_SEED_SCOPE,
    status: "observed",
    run_id: binding.run_id,
    campaign_epoch: binding.campaign_epoch,
    activated_at: binding.activated_at,
    observed_at: observedAt,
    seed_artifact_sha256: binding.seed_artifact_sha256,
    seed_source_set_sha256: binding.seed_source_set_sha256,
    seed_id: seed.id,
    source_url: seed.source_urls[0],
    final_source_url: seed.source_urls[0],
    sku: String(sku),
    product_url: productUrl,
    final_product_url: productUrl,
    seller_url: sellerUrl,
    live_seller_evidence_source: AUDITED_LIVE_SELLER_EVIDENCE_SOURCE,
    live_seller_widget: "webCurrentSeller",
    live_title: seed.query_text,
    live_brand: "",
    live_brand_extraction_complete: true,
    live_brand_evidence_source: AUDITED_LIVE_BRAND_EVIDENCE_SOURCE,
    category_key: seed.category_key,
    accessory_role: seed.accessory_role,
    live_category_key: seed.category_key,
    live_item_count: 1,
    live_is_bundle: false,
    live_is_set: false,
    live_compatibility_scope: "generic",
    live_role_attributes: seed.required_role_attributes,
    live_role_attribute_evidence: roleEvidence(seed.required_role_attributes),
    live_structured_evidence: structuredEvidence(seed.category_key),
    ...priceEvidence(observedAt),
    ...overrides,
  };
}

function classificationFor(target) {
  return {
    category_key: target.category_key,
    item_count: 1,
    is_bundle: false,
    is_set: false,
    compatibility_scope: "generic",
    role_attributes: target.required_role_attributes,
    role_attribute_evidence: roleEvidence(target.required_role_attributes),
    structured_evidence: structuredEvidence(target.category_key),
  };
}

function detailFor(request, target, sellerUrl = "https://www.ozon.ru/seller/safe-seller-1/") {
  return {
    final_url: request.product_url,
    seller_url: sellerUrl,
    seller_evidence_source: AUDITED_LIVE_SELLER_EVIDENCE_SOURCE,
    seller_widget: "webCurrentSeller",
    title: target.query_text || target.seed_title || target.title || target.title_prefix_terms_any[0],
    brand: "",
    brand_extraction_complete: true,
    brand_evidence_source: AUDITED_LIVE_BRAND_EVIDENCE_SOURCE,
    observed_at: "2026-08-19T02:00:00.000Z",
    ...priceEvidence().live_price_evidence_scope && priceEvidence(),
  };
}

test.before(async () => {
  artifact = await loadAuditedDiscoverySeedArtifact(SEED_FILE, { now: NOW });
});

test("loads the externally pinned validation-only 30x2 RUB seed artifact", async () => {
  assert.equal(artifact.contract, AUDITED_DISCOVERY_SEED_CONTRACT);
  assert.equal(artifact.artifact_sha256, AUDITED_DISCOVERY_SEED_ARTIFACT_SHA256);
  assert.equal(artifact.source_set_sha256, AUDITED_DISCOVERY_EXACT_URL_TEXT_SHA256);
  assert.equal(artifact.seeds.length, AUDITED_DISCOVERY_LOGICAL_SEED_COUNT);
  assert.equal(artifact.seeds.flatMap((seed) => seed.source_urls).length, AUDITED_DISCOVERY_EXACT_SOURCE_COUNT);
  assert.equal(new Set(artifact.seeds.flatMap((seed) => seed.source_urls)).size, 60);
  assert.equal(artifact.compiler_policy.minimum_observations_per_seller_role, 3);
  assert.equal(artifact.capacity_policy.minimum_detail_strict_unique, 360);
  assert.equal(artifact.capacity_policy.forecast_counts_for_gate, false);
  assert.equal(artifact.price_evidence_publish_eligible, false);
  assert.equal(artifact.source_query_contract.identity_checkpoint_max_age_ms, 24 * 60 * 60 * 1_000);
  assert.equal(artifact.source_query_contract.current_price_max_age_ms, 15 * 60 * 1_000);
  assert.equal(artifact.source_query_contract.next_stage_requires_live_price_refetch, true);
  for (const seed of artifact.seeds) {
    assert.deepEqual(seed.source_urls.map((value) => Number(new URL(value).searchParams.get("page"))), [1, 2]);
    for (const sourceUrl of seed.source_urls) {
      const url = new URL(sourceUrl);
      assert.equal(url.searchParams.get("currency_price"), `${seed.seed_price_band_rub.min.toFixed(3)};${seed.seed_price_band_rub.max.toFixed(3)}`);
      assert.equal(url.searchParams.get("sorting"), "rating");
    }
  }
  await assert.rejects(
    loadAuditedSourceArtifact(SEED_FILE),
    /audited source portfolio/u,
    "the production seller-artifact loader must never accept the seed contract",
  );
  const defaultClockLoad = await loadAuditedDiscoverySeedArtifact(SEED_FILE);
  assert.equal(defaultClockLoad.artifact_sha256, AUDITED_DISCOVERY_SEED_ARTIFACT_SHA256);
  const verified = await runAuditedSeedPipelineCli(["verify-artifact", "--artifact", SEED_FILE]);
  const verifiedResult = JSON.parse(verified.text);
  assert.equal(verifiedResult.exact_source_count, 60);
  assert.equal(verifiedResult.price_evidence_publish_eligible, false);
  assert.equal(verifiedResult.next_stage_requires_live_price_refetch, true);
});

test("file pin, exact 30x2 pair, RUB declaration, and fixed URL set fail closed", async () => {
  const raw = JSON.parse(await fs.readFile(SEED_FILE, "utf8"));
  await assert.rejects(
    loadAuditedDiscoverySeedArtifact(SEED_FILE, { expectedSha256: "0".repeat(64), now: NOW }),
    /externally pinned/u,
  );
  assert.throws(() => validateAuditedDiscoverySeedArtifact({ ...raw, seeds: raw.seeds.slice(1) }, { now: NOW }), /exactly 30/u);
  assert.throws(() => validateAuditedDiscoverySeedArtifact({
    ...raw,
    source_query_contract: { ...raw.source_query_contract, price_band_currency: "CNY" },
  }, { now: NOW }), /RUB/u);
  assert.throws(() => validateAuditedDiscoverySeedArtifact({
    ...raw,
    price_evidence_publish_eligible: true,
  }, { now: NOW }), /validation-only/u);
  assert.throws(() => validateAuditedDiscoverySeedArtifact({
    ...raw,
    source_query_contract: { ...raw.source_query_contract, next_stage_requires_live_price_refetch: false },
  }, { now: NOW }), /source_query_contract/u);
  const page999 = structuredClone(raw);
  page999.seeds[0].source_urls[1] = page999.seeds[0].source_urls[1].replace("page=2", "page=999");
  assert.throws(() => validateAuditedDiscoverySeedArtifact(page999, { now: NOW }), /page 1 and page 2/u);
});

test("title guard enforces prefix, every group, risk regex, and unknown Latin without rejecting safe specs", () => {
  assert.equal(auditedSeedTitleEligibility("Линейный светильник T5 220V", artifact, "L08").eligible, true);
  assert.equal(auditedSeedTitleEligibility("Патч корд CAT6 RJ45 2 метра", artifact, "C02").eligible, true);
  assert.equal(auditedSeedTitleEligibility("Встраиваемый светильник GX53", artifact, "L01").eligible, true);
  assert.equal(auditedSeedTitleEligibility("Встраиваемый светильник", artifact, "L01").reason, "required-term-group-mismatch");
  assert.equal(auditedSeedTitleEligibility("Встраиваемый светильник Brandix GX53", artifact, "L01").reason, "unknown-latin-brand-token");
  assert.equal(auditedSeedTitleEligibility("Встраиваемый светильник GX53 3 шт", artifact, "L01").reason, "global-risk-pattern");
});

test("card price guard accepts one visible current plus struck old and rejects ambiguous non-struck prices", () => {
  const good = auditedCardPriceEligibility({
    current_price_rub: 344,
    card_price_evidence: cardPriceEvidence(344, 383),
  }, { min: 250, max: 5000 });
  assert.equal(good.eligible, true);
  assert.equal(good.current_price_rub, 344);
  assert.deepEqual(good.evidence.excluded_price_nodes.map((row) => row.raw_text), ["383 ₽"]);
  const ambiguous = auditedCardPriceEligibility({
    current_price_rub: 344,
    card_price_evidence: cardPriceEvidence(344, 383, {
      current_candidate_count: 2,
      current_price_node: null,
    }),
  }, { min: 250, max: 5000 });
  assert.equal(ambiguous.eligible, false);
  assert.equal(ambiguous.reason, "card-rub-price-evidence-invalid");
  const combinedNode = auditedCardPriceEligibility({
    current_price_rub: 344,
    card_price_evidence: cardPriceEvidence(344, 383, {
      current_price_node: {
        evidence_source: "listing-card-visible-nonstruck-leaf-v1",
        raw_text: "344 ₽ 383 ₽",
        visible: true,
        line_through: false,
        installment: false,
      },
    }),
  }, { min: 250, max: 5000 });
  assert.equal(combinedNode.eligible, false);
});

test("virtualized listing-card evidence survives later scroll steps after the card leaves the DOM", () => {
  const firstStep = mergeAuditedListingCardLinkEvidence({}, {
    text: "Встраиваемый светильник GX53",
    card_text: "Встраиваемый светильник GX53\n344 ₽\n383 ₽",
    card_price_evidence: cardPriceEvidence(344, 383),
  });
  const afterVirtualizedStep = mergeAuditedListingCardLinkEvidence(firstStep, {
    text: "",
    card_text: "",
    card_price_evidence: null,
  });
  assert.equal(afterVirtualizedStep.card_price_evidence.current_price_node.raw_text, "344 ₽");
  assert.deepEqual(afterVirtualizedStep.card_price_evidence.excluded_price_nodes.map((row) => row.raw_text), ["383 ₽"]);
});

test("observation requires complete brand, structured role proof, current/old RUB evidence, and a fresh API rate", () => {
  const binding = buildAuditedSeedBinding({
    artifact,
    runId: "seed-run-1",
    campaignEpoch: 1,
    activatedAt: SEED_ACTIVATED_AT,
    now: NOW,
  });
  const seed = artifact.seeds.find((entry) => entry.id === "L01");
  const good = seedObservation(seed, binding, "1001", "https://www.ozon.ru/seller/safe-seller-1/");
  const result = auditedSeedObservationEligibility(good, artifact, binding, { now: NOW });
  assert.equal(result.eligible, true);
  assert.equal(result.observation.live_price_evidence.parsed.current_price_rub, 344);
  assert.equal(result.observation.live_price_evidence.parsed.selected_price, 27.28);
  assert.deepEqual(result.observation.live_price_evidence.old_price_rub_texts, ["383 ₽"]);

  const missingBrand = { ...good };
  delete missingBrand.live_brand;
  assert.equal(auditedSeedObservationEligibility(missingBrand, artifact, binding, { now: NOW }).reason,
    "observation-live-brand-evidence-invalid-or-risk");
  const missingSellerWidget = { ...good };
  delete missingSellerWidget.live_seller_evidence_source;
  assert.equal(auditedSeedObservationEligibility(missingSellerWidget, artifact, binding, { now: NOW }).reason,
    "observation-current-seller-widget-evidence-required");
  assert.match(auditedSeedObservationEligibility({
    ...good,
    live_role_attribute_evidence: {},
  }, artifact, binding, { now: NOW }).reason, /role-attribute-evidence/u);
  assert.match(auditedSeedObservationEligibility({
    ...good,
    live_item_count: 2,
  }, artifact, binding, { now: NOW }).reason, /single-generic/u);
  const staleRate = structuredClone(good);
  staleRate.live_price_evidence.api_rate_reference.observed_at = "2026-08-19T01:50:00.000Z";
  assert.equal(auditedSeedObservationEligibility(staleRate, artifact, binding, { now: NOW }).reason,
    "observation-live-price-evidence-invalid");
  const wrongCurrent = structuredClone(good);
  wrongCurrent.live_price_evidence.current_price_rub_text = "383 ₽";
  assert.equal(auditedSeedObservationEligibility(wrongCurrent, artifact, binding, { now: NOW }).reason,
    "observation-live-price-evidence-invalid");
  const adapterSeed = artifact.seeds.find((entry) => entry.id === "A05");
  const wrongDirection = seedObservation(adapterSeed, binding, "1002", "https://www.ozon.ru/seller/safe-seller-2/");
  wrongDirection.live_role_attributes = {
    ...wrongDirection.live_role_attributes,
    direction: "vga-source-to-hdmi-display",
  };
  wrongDirection.live_role_attribute_evidence = roleEvidence(wrongDirection.live_role_attributes);
  assert.equal(auditedSeedObservationEligibility(wrongDirection, artifact, binding, { now: NOW }).reason,
    "observation-role-attributes-mismatch");
});

test("seed runner filters card title/price before detail and resumes only six-dimension-bound checkpoints", async () => {
  const binding = buildAuditedSeedBinding({
    artifact,
    runId: "seed-run-checkpoint",
    campaignEpoch: 7,
    activatedAt: SEED_ACTIVATED_AT,
    now: NOW,
  });
  let scans = 0;
  let details = 0;
  const checkpoints = [];
  const adapter = createAuditedSeedReadOnlyAdapter({
    ownedContext: true,
    mutationFirewallInstalled: true,
    scanSource: async (request) => {
      scans += 1;
      const seed = artifact.seeds.find((entry) => entry.id === request.seed_id);
      const sku = String(200000 + scans);
      return {
        status: "completed",
        complete: true,
        stop_reason: "completed",
        final_url: request.source_url,
        links: [
          { sku, href: `https://www.ozon.ru/product/item-${sku}/?sh=ok`, title: seed.query_text, current_price_rub: 344, card_price_evidence: cardPriceEvidence() },
          { sku: `${sku}9`, href: `https://www.ozon.ru/product/${sku}9/`, title: "", current_price_rub: 344, card_price_evidence: cardPriceEvidence() },
          { sku: `${sku}8`, href: `https://www.ozon.ru/product/${sku}8/`, title: seed.query_text, current_price_rub: 99_999, card_price_evidence: cardPriceEvidence(99_999, 100_000) },
        ],
      };
    },
    fetchProductDetail: async (request) => {
      details += 1;
      const seedId = request.seed_ids[0];
      const seed = artifact.seeds.find((entry) => entry.id === seedId);
      return detailFor(request, seed, `https://www.ozon.ru/seller/seller-${seed.id.toLowerCase()}-${request.sku}/`);
    },
    classifyProduct: async ({ seed }) => classificationFor(seed),
  });
  const first = await runAuditedSeedObservationDiscovery({
    seedArtifact: artifact,
    seedBinding: binding,
    adapter,
    now: () => new Date("2026-08-19T02:01:00.000Z"),
    onCheckpoint: async (row) => checkpoints.push(row),
  });
  assert.equal(scans, 60);
  assert.equal(details, 60);
  assert.equal(first.accepted_observations.length, 60);
  assert.equal(first.stage1_rejected_links.length, 120);
  const sourceCheckpoints = checkpoints.filter((row) => row.stage === "seed-source-scan");
  const detailCheckpoints = checkpoints.filter((row) => row.contract === AUDITED_DISCOVERY_SEED_DETAIL_CHECKPOINT_CONTRACT);
  assert.equal(sourceCheckpoints.length, 60);
  assert.equal(detailCheckpoints.length, 60);
  assert.equal(sourceCheckpoints[0].seed_artifact_sha256, artifact.artifact_sha256);

  const noCallAdapter = createAuditedSeedReadOnlyAdapter({
    ownedContext: true,
    mutationFirewallInstalled: true,
    scanSource: async () => { throw new Error("scan must resume"); },
    fetchProductDetail: async () => { throw new Error("detail must resume"); },
    classifyProduct: async () => { throw new Error("classify must resume"); },
  });
  const resumed = await runAuditedSeedObservationDiscovery({
    seedArtifact: artifact,
    seedBinding: binding,
    adapter: noCallAdapter,
    resumeScans: sourceCheckpoints,
    resumeObservations: first.accepted_observations,
    resumeDetails: detailCheckpoints,
    now: () => new Date("2026-08-19T02:02:00.000Z"),
  });
  assert.equal(resumed.accepted_observations.length, 60);
  await assert.rejects(runAuditedSeedObservationDiscovery({
    seedArtifact: artifact,
    seedBinding: binding,
    adapter: noCallAdapter,
    resumeScans: [{ ...sourceCheckpoints[0], campaign_epoch: 8 }],
    now: () => new Date("2026-08-19T02:02:00.000Z"),
  }), /campaign identity/u);
  await assert.rejects(runAuditedSeedObservationDiscovery({
    seedArtifact: artifact,
    seedBinding: binding,
    adapter: noCallAdapter,
    resumeScans: [{ ...sourceCheckpoints[0], seed_artifact_sha256: "0".repeat(64) }],
    now: () => new Date("2026-08-19T02:02:00.000Z"),
  }), /campaign identity/u);
  await assert.rejects(runAuditedSeedObservationDiscovery({
    seedArtifact: artifact,
    seedBinding: binding,
    adapter: noCallAdapter,
    resumeScans: [{ ...sourceCheckpoints[0], observed_at: "2026-08-19T00:59:59.000Z" }],
    now: () => new Date("2026-08-19T02:02:00.000Z"),
  }), /predates campaign activation/u);
  await assert.rejects(runAuditedSeedObservationDiscovery({
    seedArtifact: artifact,
    seedBinding: binding,
    adapter: noCallAdapter,
    resumeScans: [sourceCheckpoints[0]],
    now: () => new Date("2026-08-20T02:01:00.001Z"),
  }), /older than the 24-hour/u);
  await assert.rejects(runAuditedSeedObservationDiscovery({
    seedArtifact: artifact,
    seedBinding: binding,
    adapter: noCallAdapter,
    resumeScans: sourceCheckpoints.map((row) => ({ ...row, observed_at: "2026-08-20T02:01:00.000Z" })),
    resumeObservations: first.accepted_observations,
    resumeDetails: detailCheckpoints,
    now: () => new Date("2026-08-20T02:01:00.001Z"),
  }), /seed resume detail checkpoint.*older than the 24-hour/u);
  await assert.rejects(runAuditedSeedObservationDiscovery({
    seedArtifact: artifact,
    seedBinding: binding,
    adapter: noCallAdapter,
    resumeScans: [{ ...sourceCheckpoints[0], links: [] }],
    now: () => new Date("2026-08-19T02:02:00.000Z"),
  }), /at least one link/u);
});

test("seed terminal detail rejection checkpoints survive a crash and prevent refetch on resume", async () => {
  const binding = buildAuditedSeedBinding({
    artifact,
    runId: "seed-terminal-reject",
    campaignEpoch: 17,
    activatedAt: SEED_ACTIVATED_AT,
    now: NOW,
  });
  const checkpoints = [];
  let detailCalls = 0;
  const sku = "2718281";
  const adapter = createAuditedSeedReadOnlyAdapter({
    ownedContext: true,
    mutationFirewallInstalled: true,
    scanSource: async (request) => {
      const seed = artifact.seeds.find((entry) => entry.id === request.seed_id);
      return {
        status: "completed",
        complete: true,
        stop_reason: "completed",
        final_url: request.source_url,
        links: [{
          sku,
          href: `https://www.ozon.ru/product/${sku}/`,
          title: seed.query_text,
          current_price_rub: 344,
          card_price_evidence: cardPriceEvidence(),
        }],
      };
    },
    fetchProductDetail: async (request) => {
      detailCalls += 1;
      return { ...detailFor(request, artifact.seeds[0]), title: "неподходящий товар" };
    },
    classifyProduct: async () => { throw new Error("title rejection must precede classification"); },
  });
  const first = await runAuditedSeedObservationDiscovery({
    seedArtifact: artifact,
    seedBinding: binding,
    adapter,
    now: () => new Date("2026-08-19T02:10:00.000Z"),
    onCheckpoint: async (row) => checkpoints.push(row),
  });
  assert.equal(detailCalls, 1);
  assert.equal(first.accepted_observations.length, 0);
  assert.equal(first.rejected_observations.length, 1);
  const scanCheckpoints = checkpoints.filter((row) => row.contract === "ozon-audited-validation-seed-scan-checkpoint-v1");
  const detailCheckpoints = checkpoints.filter((row) => row.contract === AUDITED_DISCOVERY_SEED_DETAIL_CHECKPOINT_CONTRACT);
  assert.equal(scanCheckpoints.length, 60);
  assert.equal(detailCheckpoints.length, 1);
  assert.equal(detailCheckpoints[0].status, "terminal-rejected");

  const noCallAdapter = createAuditedSeedReadOnlyAdapter({
    ownedContext: true,
    mutationFirewallInstalled: true,
    scanSource: async () => { throw new Error("scan must resume"); },
    fetchProductDetail: async () => { throw new Error("terminal rejection must not refetch"); },
    classifyProduct: async () => { throw new Error("terminal rejection must not reclassify"); },
  });
  const resumed = await runAuditedSeedObservationDiscovery({
    seedArtifact: artifact,
    seedBinding: binding,
    adapter: noCallAdapter,
    resumeScans: scanCheckpoints,
    resumeDetails: detailCheckpoints,
    now: () => new Date("2026-08-19T02:11:00.000Z"),
  });
  assert.equal(resumed.rejected_observations.length, 1);
  assert.equal(resumed.rejected_observations[0].resumed, true);
  await assert.rejects(runAuditedSeedObservationDiscovery({
    seedArtifact: artifact,
    seedBinding: binding,
    adapter: noCallAdapter,
    resumeScans: scanCheckpoints,
    resumeDetails: [{ ...detailCheckpoints[0], campaign_epoch: binding.campaign_epoch + 1 }],
    now: () => new Date("2026-08-19T02:11:00.000Z"),
  }), /detail checkpoint campaign identity/u);
});

test("blocked, max-steps, redirected, and empty scans stay retryable", async () => {
  const binding = buildAuditedSeedBinding({ artifact, runId: "scan-fail", campaignEpoch: 2, activatedAt: SEED_ACTIVATED_AT, now: NOW });
  for (const result of [
    { status: "failed", complete: false, stop_reason: "blocked", links: [] },
    { status: "completed", complete: true, stop_reason: "max_steps", links: [{ href: "https://www.ozon.ru/product/1/" }] },
    { status: "completed", complete: true, stop_reason: "completed", links: [] },
  ]) {
    const adapter = createAuditedSeedReadOnlyAdapter({
      ownedContext: true,
      mutationFirewallInstalled: true,
      scanSource: async ({ source_url }) => ({ ...result, final_url: source_url }),
      fetchProductDetail: async () => { throw new Error("unreachable"); },
      classifyProduct: async () => { throw new Error("unreachable"); },
    });
    await assert.rejects(runAuditedSeedObservationDiscovery({ seedArtifact: artifact, seedBinding: binding, adapter }),
      /incomplete|at least one link/u);
  }
  const redirected = createAuditedSeedReadOnlyAdapter({
    ownedContext: true,
    mutationFirewallInstalled: true,
    scanSource: async () => ({
      status: "completed",
      complete: true,
      stop_reason: "completed",
      final_url: "https://www.ozon.ru/search/?text=other",
      links: [{ sku: "1", href: "https://www.ozon.ru/product/1/", title: "x", current_price_rub: 344 }],
    }),
    fetchProductDetail: async () => { throw new Error("unreachable"); },
    classifyProduct: async () => { throw new Error("unreachable"); },
  });
  await assert.rejects(runAuditedSeedObservationDiscovery({ seedArtifact: artifact, seedBinding: binding, adapter: redirected }),
    /redirected away/u);
});

function buildTwentySellerDraft(binding) {
  const seed = artifact.seeds.find((entry) => entry.id === "L01");
  const observations = [];
  for (let sellerIndex = 1; sellerIndex <= 20; sellerIndex += 1) {
    const seller = `https://www.ozon.ru/seller/capacity-seller-${sellerIndex}/`;
    for (let item = 1; item <= 3; item += 1) {
      observations.push(seedObservation(seed, binding, String(300000 + sellerIndex * 10 + item), seller));
    }
  }
  return compileAuditedDerivedSellerPortfolio({
    seedArtifact: artifact,
    seedBinding: binding,
    observations,
    generatedAt: new Date("2026-08-19T03:00:00.000Z"),
  });
}

function capacityObservation(target, binding, sku, overrides = {}) {
  const observedAt = overrides.observed_at || "2026-08-19T03:00:00.000Z";
  const rateObservedAt = new Date(Date.parse(observedAt)).toISOString();
  const productUrl = `https://www.ozon.ru/product/${sku}/`;
  return {
    contract: AUDITED_DERIVED_CAPACITY_OBSERVATION_CONTRACT,
    evidence_scope: AUDITED_DERIVED_CAPACITY_SCOPE,
    status: "observed",
    run_id: binding.run_id,
    campaign_epoch: binding.campaign_epoch,
    activated_at: binding.activated_at,
    observed_at: observedAt,
    derived_artifact_sha256: binding.derived_artifact_sha256,
    source_set_sha256: binding.source_set_sha256,
    source_url: overrides.source_url || target.source_url,
    final_source_url: overrides.source_url || target.source_url,
    target_id: target.id,
    seller_url: target.seller_url,
    observed_current_seller_url: overrides.observed_current_seller_url || null,
    category_key: target.category_key,
    accessory_role: target.accessory_role,
    sku: String(sku),
    product_url: productUrl,
    final_product_url: productUrl,
    live_title: overrides.live_title || "Встраиваемый светильник GX53",
    live_brand: "",
    live_brand_extraction_complete: true,
    live_brand_evidence_source: AUDITED_LIVE_BRAND_EVIDENCE_SOURCE,
    live_category_key: target.category_key,
    live_item_count: 1,
    live_is_bundle: false,
    live_is_set: false,
    live_compatibility_scope: "generic",
    live_role_attributes: target.required_role_attributes,
    live_role_attribute_evidence: roleEvidence(target.required_role_attributes),
    live_structured_evidence: structuredEvidence(target.category_key),
    ...priceEvidence(observedAt, {
      api_rate_reference: {
        source: "maozi-current-exchange-rate-api",
        cny_per_rub: 30.37 / 383,
        observed_at: rateObservedAt,
      },
    }),
    ...overrides,
  };
}

test("compiler globally deduplicates overlap by group-count/priority and fails identity conflicts", () => {
  const binding = buildAuditedSeedBinding({ artifact, runId: "compile-overlap", campaignEpoch: 3, activatedAt: SEED_ACTIVATED_AT, now: NOW });
  const a04 = artifact.seeds.find((entry) => entry.id === "A04");
  const a06 = artifact.seeds.find((entry) => entry.id === "A06");
  const title = "переходник DisplayPort HDMI Mini HDMI угловой";
  const rows = [];
  for (let index = 1; index <= 3; index += 1) {
    const sku = String(4000 + index);
    rows.push(seedObservation(a04, binding, sku, "https://www.ozon.ru/seller/overlap-safe/", { live_title: title }));
    rows.push(seedObservation(a06, binding, sku, "https://www.ozon.ru/seller/overlap-safe/", { live_title: title }));
  }
  const compiled = compileAuditedDerivedSellerPortfolio({ seedArtifact: artifact, seedBinding: binding, observations: rows, generatedAt: NOW });
  assert.equal(compiled.accepted_observation_count, 3);
  assert.equal(compiled.artifact.targets[0].originating_seed_id, "A04");
  assert.equal(compiled.artifact.provenance.mutually_exclusive_dedup_count, 3);
  const conflict = structuredClone(rows);
  conflict[1].seller_url = "https://www.ozon.ru/seller/conflict/";
  assert.throws(() => compileAuditedDerivedSellerPortfolio({ seedArtifact: artifact, seedBinding: binding, observations: conflict, generatedAt: NOW }), /conflicting seller/u);
});

test("derived round-trip hashes exclude runtime metadata; source seller stays authoritative", async () => {
  const seedBinding = buildAuditedSeedBinding({ artifact, runId: "derive-roundtrip", campaignEpoch: 4, activatedAt: SEED_ACTIVATED_AT, now: NOW });
  const compiled = buildTwentySellerDraft(seedBinding);
  assert.equal(compiled.selected_target_count, 20);
  assert.equal(compiled.target_minimum_met, true);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "audited-derived-"));
  const filename = path.join(temporary, "derived.json");
  const bytes = `${JSON.stringify(compiled.artifact, null, 2)}\n`;
  await fs.writeFile(filename, bytes, "utf8");
  const fileSha = crypto.createHash("sha256").update(bytes).digest("hex");
  const loaded = await loadAuditedDerivedSellerArtifact(filename, {
    expectedFileSha256: fileSha,
    expectedArtifactSha256: compiled.artifact_sha256,
    now: NOW,
  });
  assert.equal(auditedDerivedArtifactSha256(loaded), compiled.artifact_sha256);
  const capacityBinding = buildAuditedDerivedCapacityBinding({
    derivedArtifact: loaded,
    derivedArtifactSha256: compiled.artifact_sha256,
    runId: "capacity-roundtrip",
    campaignEpoch: 5,
    activatedAt: "2026-08-19T02:00:00.000Z",
    now: NOW,
  });
  let serial = 500000;
  let detailSerial = 0;
  const adapter = createAuditedSeedReadOnlyAdapter({
    ownedContext: true,
    mutationFirewallInstalled: true,
    scanSource: async (request) => {
      assert.equal(request.originating_seed_id, "L01");
      serial += 1;
      return {
        status: "completed",
        complete: true,
        stop_reason: "completed",
        final_url: request.source_url,
        links: [{ sku: String(serial), href: `https://www.ozon.ru/product/${serial}/`, title: "Встраиваемый светильник GX53", current_price_rub: 344, card_price_evidence: cardPriceEvidence() }],
      };
    },
    fetchProductDetail: async (request) => ({
      ...detailFor(
        request,
        { query_text: "Встраиваемый светильник GX53", title_prefix_terms_any: ["встраиваемый"] },
        (detailSerial += 1) % 2 === 1 ? "https://www.ozon.ru/seller/default-other-offer/" : null,
      ),
      observed_at: "2026-08-19T03:00:00.000Z",
      ...priceEvidence("2026-08-19T03:00:00.000Z", {
        api_rate_reference: { source: "maozi-current-exchange-rate-api", cny_per_rub: 30.37 / 383, observed_at: "2026-08-19T02:59:30.000Z" },
      }),
    }),
    classifyProduct: async ({ target }) => classificationFor(target),
  });
  const checkpoints = [];
  const probe = await runAuditedDerivedCapacityProbe({
    derivedArtifact: loaded,
    derivedArtifactSha256: compiled.artifact_sha256,
    capacityBinding,
    adapter,
    onCheckpoint: async (row) => checkpoints.push(row),
    now: () => new Date("2026-08-19T03:01:00.000Z"),
  });
  assert.equal(probe.accepted_observations.length, 40);
  assert.equal(probe.accepted_observations[0].seller_url, loaded.targets[0].seller_url);
  assert.equal(probe.accepted_observations[0].observed_current_seller_url, "https://www.ozon.ru/seller/default-other-offer/");
  assert.ok(probe.accepted_observations.some((row) => row.observed_current_seller_url === null));
  const scanCheckpoints = checkpoints.filter((row) => row.stage === "capacity-source-scan");
  const detailCheckpoints = checkpoints.filter((row) => row.contract === AUDITED_DERIVED_CAPACITY_DETAIL_CHECKPOINT_CONTRACT);
  assert.equal(scanCheckpoints.length, 40);
  assert.equal(detailCheckpoints.length, 40);
  const resumeAdapter = createAuditedSeedReadOnlyAdapter({
    ownedContext: true,
    mutationFirewallInstalled: true,
    scanSource: async () => { throw new Error("scan must resume"); },
    fetchProductDetail: async () => { throw new Error("detail must resume"); },
    classifyProduct: async () => { throw new Error("classify must resume"); },
  });
  const resumed = await runAuditedDerivedCapacityProbe({
    derivedArtifact: loaded,
    derivedArtifactSha256: compiled.artifact_sha256,
    capacityBinding,
    adapter: resumeAdapter,
    resumeScans: scanCheckpoints,
    resumeObservations: probe.accepted_observations,
    resumeDetails: detailCheckpoints,
    now: () => new Date("2026-08-19T03:02:00.000Z"),
  });
  assert.equal(resumed.accepted_observations.length, 40);
  await assert.rejects(runAuditedDerivedCapacityProbe({
    derivedArtifact: loaded,
    derivedArtifactSha256: compiled.artifact_sha256,
    capacityBinding,
    adapter: resumeAdapter,
    resumeScans: [{ ...scanCheckpoints[0], campaign_epoch: capacityBinding.campaign_epoch + 1 }],
    now: () => new Date("2026-08-19T03:02:00.000Z"),
  }), /campaign identity/u);
  await assert.rejects(runAuditedDerivedCapacityProbe({
    derivedArtifact: loaded,
    derivedArtifactSha256: compiled.artifact_sha256,
    capacityBinding,
    adapter: resumeAdapter,
    resumeScans: [scanCheckpoints[0]],
    now: () => new Date("2026-08-20T03:01:00.001Z"),
  }), /older than the 24-hour/u);
  await assert.rejects(runAuditedDerivedCapacityProbe({
    derivedArtifact: loaded,
    derivedArtifactSha256: compiled.artifact_sha256,
    capacityBinding,
    adapter: resumeAdapter,
    resumeScans: scanCheckpoints.map((row) => ({ ...row, observed_at: "2026-08-20T03:01:00.000Z" })),
    resumeObservations: probe.accepted_observations,
    resumeDetails: detailCheckpoints,
    now: () => new Date("2026-08-20T03:01:00.001Z"),
  }), /capacity resume detail checkpoint.*older than the 24-hour/u);
});

test("capacity terminal detail rejection checkpoints resume without rescanning or refetching", async () => {
  const seedBinding = buildAuditedSeedBinding({
    artifact,
    runId: "capacity-terminal-seed",
    campaignEpoch: 18,
    activatedAt: SEED_ACTIVATED_AT,
    now: NOW,
  });
  const compiled = buildTwentySellerDraft(seedBinding);
  const capacityBinding = buildAuditedDerivedCapacityBinding({
    derivedArtifact: compiled.artifact,
    derivedArtifactSha256: compiled.artifact_sha256,
    runId: "capacity-terminal",
    campaignEpoch: 19,
    activatedAt: "2026-08-19T02:00:00.000Z",
    now: NOW,
  });
  const targetById = new Map(compiled.artifact.targets.map((target) => [target.id, target]));
  const checkpoints = [];
  const sku = "3141592";
  let detailCalls = 0;
  const adapter = createAuditedSeedReadOnlyAdapter({
    ownedContext: true,
    mutationFirewallInstalled: true,
    scanSource: async (request) => {
      const target = targetById.get(request.target_id);
      return {
        status: "completed",
        complete: true,
        stop_reason: "completed",
        final_url: request.source_url,
        links: [{
          sku,
          href: `https://www.ozon.ru/product/${sku}/`,
          title: "Встраиваемый светильник GX53",
          current_price_rub: 344,
          card_price_evidence: cardPriceEvidence(),
          target_id: target.id,
        }],
      };
    },
    fetchProductDetail: async (request) => {
      detailCalls += 1;
      return { ...detailFor(request, compiled.artifact.targets[0]), title: "неподходящий товар" };
    },
    classifyProduct: async () => { throw new Error("title rejection must precede classification"); },
  });
  const first = await runAuditedDerivedCapacityProbe({
    derivedArtifact: compiled.artifact,
    derivedArtifactSha256: compiled.artifact_sha256,
    capacityBinding,
    adapter,
    now: () => new Date("2026-08-19T03:10:00.000Z"),
    onCheckpoint: async (row) => checkpoints.push(row),
  });
  assert.equal(detailCalls, 1);
  assert.equal(first.rejected_observations.length, 1);
  const scanCheckpoints = checkpoints.filter((row) => row.contract === "ozon-audited-derived-capacity-scan-checkpoint-v1");
  const detailCheckpoints = checkpoints.filter((row) => row.contract === AUDITED_DERIVED_CAPACITY_DETAIL_CHECKPOINT_CONTRACT);
  assert.equal(scanCheckpoints.length, 40);
  assert.equal(detailCheckpoints.length, 1);
  assert.equal(detailCheckpoints[0].status, "terminal-rejected");
  const noCallAdapter = createAuditedSeedReadOnlyAdapter({
    ownedContext: true,
    mutationFirewallInstalled: true,
    scanSource: async () => { throw new Error("capacity scan must resume"); },
    fetchProductDetail: async () => { throw new Error("capacity terminal rejection must not refetch"); },
    classifyProduct: async () => { throw new Error("capacity terminal rejection must not reclassify"); },
  });
  const resumed = await runAuditedDerivedCapacityProbe({
    derivedArtifact: compiled.artifact,
    derivedArtifactSha256: compiled.artifact_sha256,
    capacityBinding,
    adapter: noCallAdapter,
    resumeScans: scanCheckpoints,
    resumeDetails: detailCheckpoints,
    now: () => new Date("2026-08-19T03:11:00.000Z"),
  });
  assert.equal(resumed.rejected_observations.length, 1);
  assert.equal(resumed.rejected_observations[0].resumed, true);
});

test("capacity gate caps each seller at 18 and requires 360 across at least 20 actual sellers", () => {
  const seedBinding = buildAuditedSeedBinding({ artifact, runId: "capacity-gate-seed", campaignEpoch: 8, activatedAt: SEED_ACTIVATED_AT, now: NOW });
  const compiled = buildTwentySellerDraft(seedBinding);
  const capacityBinding = buildAuditedDerivedCapacityBinding({
    derivedArtifact: compiled.artifact,
    derivedArtifactSha256: compiled.artifact_sha256,
    runId: "capacity-gate",
    campaignEpoch: 9,
    activatedAt: "2026-08-19T02:00:00.000Z",
    now: NOW,
  });
  const observations = [];
  for (let targetIndex = 0; targetIndex < 20; targetIndex += 1) {
    const target = { ...compiled.artifact.targets[targetIndex], source_url: compiled.artifact.active_source_bindings[targetIndex * 2].source_url };
    for (let item = 1; item <= 18; item += 1) {
      observations.push(capacityObservation(target, capacityBinding, String(600000 + targetIndex * 100 + item), {
        observed_current_seller_url: targetIndex === 0 ? "https://www.ozon.ru/seller/default-other-offer/" : null,
      }));
    }
  }
  const ready = attestAuditedDerivedCapacity({
    derivedArtifact: compiled.artifact,
    derivedArtifactSha256: compiled.artifact_sha256,
    capacityBinding,
    observations,
    generatedAt: new Date("2026-08-19T04:00:00.000Z"),
  });
  assert.equal(ready.attestation.brand_safe_unique_skus, AUDITED_DERIVED_CAPACITY_MINIMUM);
  assert.equal(ready.attestation.current_sellers, 20);
  assert.equal(ready.attestation.ready, true);
  assert.equal(ready.attestation.price_evidence_publish_eligible, false);
  assert.equal(ready.attestation.next_stage_requires_live_price_refetch, true);
  assert.equal(ready.attestation.current_price_observation_count, 0);
  assert.equal(ready.attestation.identity_capacity_only_observation_count, 360);
  const atCurrentPriceBoundary = attestAuditedDerivedCapacity({
    derivedArtifact: compiled.artifact,
    derivedArtifactSha256: compiled.artifact_sha256,
    capacityBinding,
    observations,
    generatedAt: new Date("2026-08-19T03:15:00.000Z"),
  });
  assert.equal(atCurrentPriceBoundary.attestation.current_price_observation_count, 360);
  assert.equal(atCurrentPriceBoundary.attestation.identity_capacity_only_observation_count, 0);
  const beyondCurrentPriceBoundary = attestAuditedDerivedCapacity({
    derivedArtifact: compiled.artifact,
    derivedArtifactSha256: compiled.artifact_sha256,
    capacityBinding,
    observations,
    generatedAt: new Date("2026-08-19T03:15:01.000Z"),
  });
  assert.equal(beyondCurrentPriceBoundary.attestation.current_price_observation_count, 0);
  assert.equal(beyondCurrentPriceBoundary.attestation.identity_capacity_only_observation_count, 360);
  assert.doesNotThrow(() => promoteAuditedDerivedSellerPortfolio({
    draftArtifact: compiled.artifact,
    draftArtifactSha256: compiled.artifact_sha256,
    capacityAttestation: ready.attestation,
    capacityAttestationSha256: ready.attestation_sha256,
    generatedAt: new Date("2026-08-19T04:01:00.000Z"),
  }));

  const firstTarget = { ...compiled.artifact.targets[0], source_url: compiled.artifact.active_source_bindings[0].source_url };
  const oneSeller = Array.from({ length: 360 }, (_, index) => capacityObservation(
    firstTarget,
    capacityBinding,
    String(700000 + index),
  ));
  const capped = attestAuditedDerivedCapacity({
    derivedArtifact: compiled.artifact,
    derivedArtifactSha256: compiled.artifact_sha256,
    capacityBinding,
    observations: oneSeller,
    generatedAt: new Date("2026-08-19T04:00:00.000Z"),
  });
  assert.equal(capped.attestation.uncapped_brand_safe_unique_skus, 360);
  assert.equal(capped.attestation.brand_safe_unique_skus, 18);
  assert.equal(capped.attestation.current_sellers, 1);
  assert.equal(capped.attestation.ready, false);
  assert.throws(() => promoteAuditedDerivedSellerPortfolio({
    draftArtifact: compiled.artifact,
    draftArtifactSha256: compiled.artifact_sha256,
    capacityAttestation: capped.attestation,
    capacityAttestationSha256: capped.attestation_sha256,
    generatedAt: new Date("2026-08-19T04:01:00.000Z"),
  }), /not a ready/u);
});

function zeroAdapterSnapshot() {
  return {
    source_scan_requests: 60,
    live_detail_requests: 420,
    classification_requests: 420,
    favorite_mutation_attempts: 0,
    submission_attempts: 0,
    closed: false,
  };
}

function zeroFirewallSnapshot() {
  return {
    observation_scope: "playwright-context-route-does-not-cover-service-worker",
    allowed_explicit_reads: 1,
    blocked_requests: 0,
    context_route_blocked_mutation_attempts: 0,
    context_route_blocked_by_mutation_kind: {},
    service_worker_mutation_attempts_observed: 0,
    all_contexts_mutation_attempts_observed: 0,
    all_contexts_protected_attempts_by_kind: {},
    protected_analytics_upload_attempts_observed: 0,
    by_method_path: {},
  };
}

function zeroNetworkSafety() {
  return {
    contract: "ozon-audited-validation-network-safety-v1",
    bootstrap_contract: "ozon-audited-validation-bootstrap-lockdown-v1",
    bootstrap_host_resolver_blocked_before_dnr: true,
    bootstrap_prior_audited_rules_cleared_before_probe: true,
    bootstrap_protected_read_probe_blocked_before_dnr: true,
    bootstrap_proxy_disabled: true,
    bootstrap_persisted_full_host_lockdown: true,
    bootstrap_browser_fully_stopped_before_operational_launch: true,
    bootstrap_lockdown_rule_sha256: "b".repeat(64),
    operational_preflight_observed_persisted_lockdown: true,
    dnr_rule_set_sha256: "a".repeat(64),
    dnr_rules_exact_at_start_and_end: true,
    dnr_no_conflicting_dynamic_or_session_overrides_at_start_and_end: true,
    check_data_service_worker_smoke_blocked_at_start_and_end: true,
    dnr_all_protected_maozi_path_smokes_blocked_at_start_and_end: true,
    dnr_http_maozi_path_smokes_blocked_at_start_and_end: true,
    dnr_ambiguous_maozi_path_smokes_blocked_at_start_and_end: true,
    dnr_pinned_safe_rule_9001_audited_at_start_and_end: true,
    sku3_post_read_smoke_ok_at_start_and_end: true,
    dnr_match_telemetry_available: false,
    dnr_matched_rule_count_deltas: null,
    dnr_match_telemetry_unavailable_reason: "declarativeNetRequestFeedback-not-granted",
    web_request_audit_continuous: true,
    observer_heartbeat_interval_ms: 5_000,
    observer_heartbeat_successful_pings: 1,
    observer_heartbeat_continuous: true,
    observer_heartbeat_network_requests: 0,
    all_contexts_state_mutation_attempts_observed: 0,
    service_worker_state_mutation_attempts_observed: 0,
    all_contexts_protected_attempts_by_kind: {},
    protected_analytics_upload_attempts_observed: 0,
    protected_mutation_requests_allowed_outbound: false,
  };
}

function ownedRuntime() {
  return {
    context: Object.freeze({}),
    env: {
      FLOW_B_VALIDATION_ONLY: "1",
      FLOW_B_AUDITED_DISCOVERY_ONLY: "1",
      FLOW_B_AUDITED_DISCOVERY_OWNED_CONTEXT: "1",
      FLOW_B_DIRECT_PUBLISH: "0",
      FLOW_B_MAOZI_AUTOFAVORITE: "0",
      FLOW_B_CDP_ENDPOINT: "",
    },
    safety: Object.freeze({}),
    rateProvider: async () => ({ cny_per_rub: 30.37 / 383, observed_at: "2026-08-19T02:29:30.000Z" }),
    firewall: Object.freeze({}),
    accessController: Object.freeze({ run: (_request, operation) => operation() }),
  };
}

function readyCliDependencies(campaignRoot, hooks = {}) {
  return {
    campaignRoot,
    now: () => new Date(hooks.now || "2026-08-19T02:30:00.000Z"),
    withOwnedContext: async (_options, operation) => ({
      value: await operation(ownedRuntime()),
      request_firewall: zeroFirewallSnapshot(),
      network_safety: zeroNetworkSafety(),
    }),
    createPinnedAdapter: async () => ({
      adapter: Object.freeze({}),
      snapshot: () => zeroAdapterSnapshot(),
      close: async () => ({ closed: true }),
    }),
    runSeedDiscovery: async ({ seedArtifact, seedBinding, resumeObservations, resumeDetails, onObservation, onCheckpoint }) => {
      if (resumeObservations.length > 0) {
        hooks.seedResumeCount = resumeObservations.length;
        hooks.seedDetailResumeCount = resumeDetails.length;
        return { accepted_observations: resumeObservations };
      }
      const seed = seedArtifact.seeds.find((entry) => entry.id === "L01");
      const rows = [];
      for (let sellerIndex = 1; sellerIndex <= 20; sellerIndex += 1) {
        for (let item = 1; item <= 3; item += 1) {
          rows.push(seedObservation(
            seed,
            seedBinding,
            String(800000 + sellerIndex * 10 + item),
            `https://www.ozon.ru/seller/cli-seller-${sellerIndex}/`,
          ));
        }
      }
      for (const row of rows) await onObservation(row);
      await onCheckpoint({ contract: "ozon-audited-validation-seed-scan-checkpoint-v1", stage: "seed-source-scan" });
      for (const row of rows) {
        await onCheckpoint({
          contract: AUDITED_DISCOVERY_SEED_DETAIL_CHECKPOINT_CONTRACT,
          stage: "seed-product-detail",
          status: "accepted",
          sku: row.sku,
        });
      }
      return { accepted_observations: rows };
    },
    runCapacityProbe: async ({ derivedArtifact, capacityBinding, resumeObservations, resumeDetails, onObservation, onCheckpoint }) => {
      if (resumeObservations.length > 0) {
        hooks.capacityResumeCount = resumeObservations.length;
        hooks.capacityDetailResumeCount = resumeDetails.length;
        return { accepted_observations: resumeObservations };
      }
      const rows = [];
      for (let targetIndex = 0; targetIndex < 20; targetIndex += 1) {
        const target = {
          ...derivedArtifact.targets[targetIndex],
          source_url: derivedArtifact.active_source_bindings[targetIndex * 2].source_url,
        };
        for (let item = 1; item <= 18; item += 1) {
          rows.push(capacityObservation(
            target,
            capacityBinding,
            String(900000 + targetIndex * 100 + item),
            { observed_at: "2026-08-19T02:30:00.000Z" },
          ));
        }
      }
      for (const row of rows) await onObservation(row);
      await onCheckpoint({ contract: "ozon-audited-derived-capacity-scan-checkpoint-v1", stage: "capacity-source-scan" });
      for (const row of rows) {
        await onCheckpoint({
          contract: AUDITED_DERIVED_CAPACITY_DETAIL_CHECKPOINT_CONTRACT,
          stage: "capacity-product-detail",
          status: "accepted",
          sku: row.sku,
        });
      }
      return { accepted_observations: rows };
    },
  };
}

test("standalone CLI is pinned, resumable, and wires seed through capacity validation-only promotion", async () => {
  const campaignRoot = await fs.mkdtemp(path.join(os.tmpdir(), "audited-seed-cli-"));
  const args = [
    "all",
    "--run-id", "cli-chain",
    "--seed-epoch", "11",
    "--capacity-epoch", "12",
    "--activated-at", SEED_ACTIVATED_AT,
    "--artifact", SEED_FILE,
  ];
  assert.equal(parseAuditedSeedPipelineArgs(args).mode, "all");
  assert.throws(() => parseAuditedSeedPipelineArgs([...args, "--adapter-module", "/tmp/evil.mjs"]), /not supported/u);
  assert.throws(() => parseAuditedSeedPipelineArgs([...args, "--out-dir", "/Users/mac/.ozon-24h-production"]), /not supported/u);
  const hooks = {};
  const dependencies = readyCliDependencies(campaignRoot, hooks);
  const result = await runAuditedSeedPipelineCli(args, dependencies);
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.status, "ready_for_validation_discovery");
  assert.equal(parsed.validation_only, true);
  assert.equal(parsed.automatic_publish_eligible, false);
  assert.equal(parsed.price_evidence_publish_eligible, false);
  assert.equal(parsed.next_stage_requires_live_price_refetch, true);
  assert.equal(parsed.brand_safe_unique_skus, 360);
  assert.equal(parsed.current_price_observation_count, 360);
  assert.equal(parsed.identity_capacity_only_observation_count, 0);
  assert.equal(parsed.current_sellers, 20);
  assert.equal(parsed.publication_attempts, 0);
  assert.equal(parsed.favorite_mutations, 0);
  assert.equal(parsed.blocked_mutation_attempts, 0);
  const outDir = path.join(campaignRoot, "cli-chain");
  const activation = JSON.parse(await fs.readFile(path.join(outDir, "capacity_activation.json"), "utf8"));
  assert.equal(activation.contract, AUDITED_DERIVED_CAPACITY_ACTIVATION_CONTRACT);
  assert.equal(activation.activated_at, "2026-08-19T02:30:00.000Z");
  assert.notEqual(activation.activated_at, SEED_ACTIVATED_AT);
  const promoted = JSON.parse(await fs.readFile(path.join(outDir, "derived_validation_ready.json"), "utf8"));
  assert.equal(promoted.deployment_phase, "validation_only");
  assert.equal(promoted.automatic_publish_eligible, false);
  assert.equal(promoted.price_evidence_publish_eligible, false);
  assert.equal(promoted.readiness.next_stage_requires_live_price_refetch, true);
  const seedScans = (await fs.readFile(path.join(outDir, "seed_source_checkpoints.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const capacityScans = (await fs.readFile(path.join(outDir, "capacity_source_checkpoints.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const seedDetails = (await fs.readFile(path.join(outDir, "seed_detail_checkpoints.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const capacityDetails = (await fs.readFile(path.join(outDir, "capacity_detail_checkpoints.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(seedScans.map((row) => row.contract), ["ozon-audited-validation-seed-scan-checkpoint-v1"]);
  assert.deepEqual(capacityScans.map((row) => row.contract), ["ozon-audited-derived-capacity-scan-checkpoint-v1"]);
  assert.equal(seedDetails.length, 60);
  assert.equal(capacityDetails.length, 360);
  assert.ok(seedDetails.every((row) => row.contract === AUDITED_DISCOVERY_SEED_DETAIL_CHECKPOINT_CONTRACT));
  assert.ok(capacityDetails.every((row) => row.contract === AUDITED_DERIVED_CAPACITY_DETAIL_CHECKPOINT_CONTRACT));
  const resumed = await runAuditedSeedPipelineCli(args, dependencies);
  assert.equal(JSON.parse(resumed.text).promoted_artifact_sha256, parsed.promoted_artifact_sha256);
  assert.equal(hooks.seedResumeCount, 60);
  assert.equal(hooks.capacityResumeCount, 360);
  assert.equal(hooks.seedDetailResumeCount, 60);
  assert.equal(hooks.capacityDetailResumeCount, 360);
  hooks.now = "2026-08-19T22:30:00.000Z";
  const agedResume = JSON.parse((await runAuditedSeedPipelineCli(args, dependencies)).text);
  assert.equal(agedResume.brand_safe_unique_skus, 360);
  assert.equal(agedResume.current_price_observation_count, 0);
  assert.equal(agedResume.identity_capacity_only_observation_count, 360);
  assert.equal(agedResume.price_evidence_publish_eligible, false);
});

test("standalone CLI fails nonzero below readiness and rejects polluted logs and symlink roots", async () => {
  const campaignRoot = await fs.mkdtemp(path.join(os.tmpdir(), "audited-seed-not-ready-"));
  const args = [
    "all", "--run-id", "not-ready", "--seed-epoch", "21", "--capacity-epoch", "22",
    "--activated-at", SEED_ACTIVATED_AT, "--artifact", SEED_FILE,
  ];
  const dependencies = readyCliDependencies(campaignRoot);
  dependencies.runSeedDiscovery = async ({ seedArtifact, seedBinding }) => {
    const seed = seedArtifact.seeds.find((entry) => entry.id === "L01");
    return {
      accepted_observations: Array.from({ length: 3 }, (_unused, index) => seedObservation(
        seed,
        seedBinding,
        String(990001 + index),
        "https://www.ozon.ru/seller/only-one-seller/",
      )),
    };
  };
  await assert.rejects(
    runAuditedSeedPipelineCli(args, dependencies),
    (error) => error instanceof AuditedSeedPipelineNotReadyError
      && error.code === "AUDITED_SEED_PIPELINE_NOT_READY"
      && error.result.status === "not_ready_insufficient_current_sellers",
  );
  const outDir = path.join(campaignRoot, "not-ready");
  const result = JSON.parse(await fs.readFile(path.join(outDir, "pipeline_result.json"), "utf8"));
  assert.equal(result.status, "not_ready_insufficient_current_sellers");
  await assert.rejects(fs.access(path.join(outDir, "derived_validation_ready.json")));

  const pollutedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "audited-seed-polluted-"));
  const pollutedDir = path.join(pollutedRoot, "polluted");
  await fs.mkdir(pollutedDir);
  await fs.writeFile(path.join(pollutedDir, "seed_source_checkpoints.jsonl"), `${JSON.stringify({ contract: "foreign-contract" })}\n`);
  const pollutedArgs = [
    "all", "--run-id", "polluted", "--seed-epoch", "31", "--capacity-epoch", "32",
    "--activated-at", SEED_ACTIVATED_AT, "--artifact", SEED_FILE,
  ];
  await assert.rejects(runAuditedSeedPipelineCli(pollutedArgs, readyCliDependencies(pollutedRoot)), /foreign or missing contract/u);

  const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), "audited-seed-real-root-"));
  const symlinkRoot = `${realRoot}-link`;
  await fs.symlink(realRoot, symlinkRoot, "dir");
  await assert.rejects(runAuditedSeedPipelineCli([
    "all", "--run-id", "symlink", "--seed-epoch", "41", "--capacity-epoch", "42",
    "--activated-at", SEED_ACTIVATED_AT, "--artifact", SEED_FILE,
  ], readyCliDependencies(symlinkRoot)), /real directory/u);
});

test("standalone CLI rejects hard-linked leaves, symlink leaves, and campaign parent replacement", async () => {
  const sentinelRoot = await fs.mkdtemp(path.join(os.tmpdir(), "audited-seed-sentinels-"));
  const sentinel = path.join(sentinelRoot, "production-sentinel.jsonl");
  const sentinelBytes = "PRODUCTION_SENTINEL\n";
  await fs.writeFile(sentinel, sentinelBytes, { mode: 0o600 });

  const hardlinkRoot = await fs.mkdtemp(path.join(os.tmpdir(), "audited-seed-hardlink-"));
  const hardlinkCampaign = path.join(hardlinkRoot, "hardlink");
  await fs.mkdir(hardlinkCampaign, { mode: 0o700 });
  await fs.link(sentinel, path.join(hardlinkCampaign, "seed_source_checkpoints.jsonl"));
  await assert.rejects(runAuditedSeedPipelineCli([
    "all", "--run-id", "hardlink", "--seed-epoch", "51", "--capacity-epoch", "52",
    "--activated-at", SEED_ACTIVATED_AT, "--artifact", SEED_FILE,
  ], readyCliDependencies(hardlinkRoot)), /exactly one hard link/u);
  assert.equal(await fs.readFile(sentinel, "utf8"), sentinelBytes);

  const symlinkLeafRoot = await fs.mkdtemp(path.join(os.tmpdir(), "audited-seed-symlink-leaf-"));
  const symlinkLeafCampaign = path.join(symlinkLeafRoot, "symlink-leaf");
  await fs.mkdir(symlinkLeafCampaign, { mode: 0o700 });
  await fs.symlink(sentinel, path.join(symlinkLeafCampaign, "seed_source_checkpoints.jsonl"));
  await assert.rejects(runAuditedSeedPipelineCli([
    "all", "--run-id", "symlink-leaf", "--seed-epoch", "53", "--capacity-epoch", "54",
    "--activated-at", SEED_ACTIVATED_AT, "--artifact", SEED_FILE,
  ], readyCliDependencies(symlinkLeafRoot)), /regular non-symlink/u);
  assert.equal(await fs.readFile(sentinel, "utf8"), sentinelBytes);

  const swappedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "audited-seed-parent-swap-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "audited-seed-parent-swap-outside-"));
  const swappedDependencies = readyCliDependencies(swappedRoot);
  swappedDependencies.withOwnedContext = async (_options, operation) => {
    const campaign = path.join(swappedRoot, "parent-swap");
    await fs.rename(campaign, `${campaign}-original`);
    await fs.symlink(outside, campaign, "dir");
    return {
      value: await operation(ownedRuntime()),
      request_firewall: zeroFirewallSnapshot(),
      network_safety: zeroNetworkSafety(),
    };
  };
  await assert.rejects(runAuditedSeedPipelineCli([
    "all", "--run-id", "parent-swap", "--seed-epoch", "55", "--capacity-epoch", "56",
    "--activated-at", SEED_ACTIVATED_AT, "--artifact", SEED_FILE,
  ], swappedDependencies), /campaign directory identity changed/u);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(await fs.readFile(sentinel, "utf8"), sentinelBytes);
});

test("standalone CLI requires finalized all-context network safety and rejects any mutation attempt", async () => {
  const argsFor = (runId, seedEpoch) => [
    "all", "--run-id", runId, "--seed-epoch", String(seedEpoch),
    "--capacity-epoch", String(seedEpoch + 1), "--activated-at", SEED_ACTIVATED_AT,
    "--artifact", SEED_FILE,
  ];
  const minimalSeedResult = async ({ seedArtifact, seedBinding }) => {
    const seed = seedArtifact.seeds.find((entry) => entry.id === "L01");
    return {
      accepted_observations: Array.from({ length: 3 }, (_unused, index) => seedObservation(
        seed,
        seedBinding,
        String(992001 + index),
        "https://www.ozon.ru/seller/network-safety-seller/",
      )),
    };
  };

  const missingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "audited-seed-network-missing-"));
  const missing = readyCliDependencies(missingRoot);
  missing.runSeedDiscovery = minimalSeedResult;
  missing.withOwnedContext = async (_options, operation) => ({
    value: await operation(ownedRuntime()),
    request_firewall: zeroFirewallSnapshot(),
  });
  await assert.rejects(
    runAuditedSeedPipelineCli(argsFor("network-missing", 61), missing),
    /complete DNR and all-context network safety evidence/u,
  );

  const bootstrapRoot = await fs.mkdtemp(path.join(os.tmpdir(), "audited-seed-bootstrap-missing-"));
  const bootstrap = readyCliDependencies(bootstrapRoot);
  bootstrap.runSeedDiscovery = minimalSeedResult;
  bootstrap.withOwnedContext = async (_options, operation) => ({
    value: await operation(ownedRuntime()),
    request_firewall: zeroFirewallSnapshot(),
    network_safety: {
      ...zeroNetworkSafety(),
      bootstrap_browser_fully_stopped_before_operational_launch: false,
    },
  });
  await assert.rejects(
    runAuditedSeedPipelineCli(argsFor("bootstrap-missing", 62), bootstrap),
    /complete DNR and all-context network safety evidence/u,
  );

  const heartbeatCases = [
    ["missing", (network) => {
      delete network.observer_heartbeat_interval_ms;
      delete network.observer_heartbeat_successful_pings;
      delete network.observer_heartbeat_continuous;
      delete network.observer_heartbeat_network_requests;
    }],
    ["not-continuous", (network) => { network.observer_heartbeat_continuous = false; }],
    ["interval-too-large", (network) => { network.observer_heartbeat_interval_ms = 5_001; }],
    ["negative-pings", (network) => { network.observer_heartbeat_successful_pings = -1; }],
    ["made-network-request", (network) => { network.observer_heartbeat_network_requests = 1; }],
  ];
  for (const [index, [label, mutate]] of heartbeatCases.entries()) {
    const heartbeatRoot = await fs.mkdtemp(path.join(os.tmpdir(), `audited-seed-heartbeat-${label}-`));
    const heartbeat = readyCliDependencies(heartbeatRoot);
    heartbeat.runSeedDiscovery = minimalSeedResult;
    heartbeat.withOwnedContext = async (_options, operation) => {
      const network = zeroNetworkSafety();
      mutate(network);
      return {
        value: await operation(ownedRuntime()),
        request_firewall: zeroFirewallSnapshot(),
        network_safety: network,
      };
    };
    await assert.rejects(
      runAuditedSeedPipelineCli(argsFor(`heartbeat-${label}`, 70 + index * 2), heartbeat),
      /complete DNR and all-context network safety evidence/u,
    );
  }

  const mutationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "audited-seed-network-mutation-"));
  const mutation = readyCliDependencies(mutationRoot);
  mutation.runSeedDiscovery = minimalSeedResult;
  mutation.withOwnedContext = async (_options, operation) => {
    const route = {
      ...zeroFirewallSnapshot(),
      service_worker_mutation_attempts_observed: 1,
      all_contexts_mutation_attempts_observed: 1,
      all_contexts_protected_attempts_by_kind: { favorite: 1 },
    };
    const network = {
      ...zeroNetworkSafety(),
      all_contexts_state_mutation_attempts_observed: 1,
      service_worker_state_mutation_attempts_observed: 1,
      all_contexts_protected_attempts_by_kind: { favorite: 1 },
    };
    return { value: await operation(ownedRuntime()), request_firewall: route, network_safety: network };
  };
  await assert.rejects(
    runAuditedSeedPipelineCli(argsFor("network-mutation", 63), mutation),
    /mutation, favorite, or submission attempt/u,
  );
});
