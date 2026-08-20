import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const AUDITED_SOURCE_CONTRACT = "ozon-audited-validation-source-portfolio-v1";
export const AUDITED_SOURCE_SCHEMA_VERSION = 1;
export const AUDITED_ARTIFACT_SHA256 = "fca8840d3dba5a2f08cf48567ad11317d20da123421225cec3a6514ed5840b6d";
export const AUDITED_REPORT_SHA256 = "061da1d952a8642e9920914af2d0f6d55e628d036b347fde0f6d9f52801a5f98";
export const AUDITED_REPORT_DENOMINATOR = 144;
export const AUDITED_REPORT_PASSED = 34;
export const AUDITED_DEPLOYMENT_PHASE = "validation_only";
export const AUDITED_REPORT_RELATIVE_PATH = "outputs/1688_supply_acceptance_20260816_final/final_acceptance_complete_union_v23.json";
export const AUDITED_REPORT_PASSED_ROWS_SHA256 = "ff07c37d382bf0d1996c9687c75f274318f3213530822b1f3c08ade00ddff477";
export const AUDITED_PASSED_PRODUCTS_SHA256 = "6ec57f5bc4cb3225530d002e20c9cd4b20b3568eb3739bf53a1104ce37b881f7";
export const AUDITED_RUNTIME_IDENTITY_CONTRACT = "ozon-audited-source-runtime-identity-v1";
export const AUDITED_SOURCE_EVENT_SCOPE = "audited-validation-bootstrap";

const ALLOWED_TIERS = new Set(["P1", "P2"]);
const ALLOWED_ROLES = new Set(["exploit", "explore"]);
const ALLOWED_SORTING = new Set(["", "rating"]);
const ALLOWED_EVIDENCE = new Set(["audited-validation", "historical-safe-proxy"]);
const DISALLOWED_CATEGORY = /(?:beauty|cosmetic|food|fashion|toy|collectible|vehicle-compatibility)/iu;
const allowedSourceIndexCache = new WeakMap();

function fail(message) {
  throw new Error(`audited source portfolio: ${message}`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalPassedRows(rows, { includeAttribution = false } = {}) {
  return [...rows].map((row) => ({
    sku: String(row.sku),
    title: String(row.title),
    ...(includeAttribution ? { seller_url: row.seller_url ?? null } : {}),
  })).sort((left, right) => left.sku.localeCompare(right.sku));
}

function passedRowsSha256(rows, options = {}) {
  return sha256(JSON.stringify(canonicalPassedRows(rows, options)));
}

function nonEmptyString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) fail(`${label} must be a non-empty string`);
  return normalized;
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) fail(`${label} must be a positive integer`);
  return normalized;
}

function exactNonNegativeInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) fail(`${label} must be a non-negative integer`);
  return normalized;
}

export function auditedSellerRoot(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || !/(?:^|\.)ozon\.ru$/iu.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/seller\/[^/]+\/?$/iu);
    if (!match) return null;
    url.pathname = match[0].endsWith("/") ? match[0] : `${match[0]}/`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function exactAuditedSourceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    url.searchParams.sort();
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeTerms(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  const terms = [...new Set(value.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean))];
  if (terms.length === 0) fail(`${label} must contain a non-empty term`);
  return terms;
}

function normalizeRequiredTermGroups(value, fallbackTerms, label) {
  const groupsValue = value === undefined || value === null
    ? [fallbackTerms]
    : value;
  if (!Array.isArray(groupsValue) || groupsValue.length === 0) {
    fail(`${label} must be a non-empty array of non-empty term arrays`);
  }
  const groups = groupsValue.map((group, index) => Object.freeze(
    normalizeTerms(group, `${label}[${index}]`),
  ));
  const canonical = new Set();
  for (const group of groups) {
    const key = JSON.stringify(group);
    if (canonical.has(key)) fail(`${label} must not contain duplicate groups`);
    canonical.add(key);
  }
  return Object.freeze(groups);
}

function normalizePriceBands(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  const bands = value.map((band, index) => {
    const minimum = Number(band?.min);
    const maximum = Number(band?.max);
    if (!(Number.isFinite(minimum) && Number.isFinite(maximum) && minimum >= 0 && maximum > minimum)) {
      fail(`${label}[${index}] must have finite 0 <= min < max`);
    }
    return { min: minimum, max: maximum };
  }).sort((left, right) => left.min - right.min || left.max - right.max);
  for (let index = 1; index < bands.length; index += 1) {
    if (bands[index].min < bands[index - 1].max) fail(`${label} must not contain overlapping ranges`);
  }
  return bands;
}

function normalizedPassedProducts(value) {
  if (!Array.isArray(value) || value.length !== AUDITED_REPORT_PASSED) {
    fail(`passed_products must contain exactly ${AUDITED_REPORT_PASSED} rows`);
  }
  const seen = new Set();
  const products = value.map((row, index) => {
    const sku = nonEmptyString(row?.sku, `passed_products[${index}].sku`);
    if (!/^\d+$/u.test(sku)) fail(`passed_products[${index}].sku must contain decimal digits only`);
    if (seen.has(sku)) fail(`passed_products contains duplicate sku ${sku}`);
    seen.add(sku);
    const sellerUrl = row?.seller_url === null ? null : auditedSellerRoot(row?.seller_url);
    if (row?.seller_url !== null && !sellerUrl) fail(`passed_products[${index}].seller_url is invalid`);
    return Object.freeze({
      sku,
      seller_url: sellerUrl,
      title: nonEmptyString(row?.title, `passed_products[${index}].title`),
    });
  });
  if (passedRowsSha256(products) !== AUDITED_REPORT_PASSED_ROWS_SHA256) {
    fail("passed_products SKU/title set does not match the corrected report");
  }
  if (passedRowsSha256(products, { includeAttribution: true }) !== AUDITED_PASSED_PRODUCTS_SHA256) {
    fail("passed_products seller attribution does not match the audited mapping");
  }
  return products;
}

function normalizedTarget(row, index, passedBySku) {
  const label = `targets[${index}]`;
  const id = nonEmptyString(row?.id, `${label}.id`);
  const sellerUrl = auditedSellerRoot(row?.seller_url);
  if (!sellerUrl) fail(`${label}.seller_url must be an Ozon seller root URL`);
  const tier = nonEmptyString(row?.tier, `${label}.tier`).toUpperCase();
  if (!ALLOWED_TIERS.has(tier)) fail(`${label}.tier must be P1 or P2`);
  const role = nonEmptyString(row?.role, `${label}.role`).toLowerCase();
  if (!ALLOWED_ROLES.has(role)) fail(`${label}.role must be exploit or explore`);
  const evidenceBasis = nonEmptyString(row?.evidence_basis, `${label}.evidence_basis`);
  if (!ALLOWED_EVIDENCE.has(evidenceBasis)) fail(`${label}.evidence_basis is unsupported`);
  const categoryKey = nonEmptyString(row?.category_key, `${label}.category_key`);
  if (DISALLOWED_CATEGORY.test(categoryKey)) fail(`${label}.category_key is a prohibited high-risk category`);
  const auditedPassSkus = [...new Set((row?.audited_pass_skus || []).map(String))];
  if (evidenceBasis === "audited-validation" && auditedPassSkus.length === 0) {
    fail(`${label} audited-validation evidence requires at least one passed SKU`);
  }
  for (const sku of auditedPassSkus) {
    const product = passedBySku.get(sku);
    if (!product) fail(`${label} references unknown passed SKU ${sku}`);
    if (product.seller_url !== sellerUrl) fail(`${label} seller does not match passed SKU ${sku}`);
  }
  const sellerAudit = row?.seller_audit === null ? null : {
    denominator: positiveInteger(row?.seller_audit?.denominator, `${label}.seller_audit.denominator`),
    passed: exactNonNegativeInteger(row?.seller_audit?.passed, `${label}.seller_audit.passed`),
    manual_recheck: exactNonNegativeInteger(
      row?.seller_audit?.manual_recheck || 0,
      `${label}.seller_audit.manual_recheck`,
    ),
  };
  if (sellerAudit && sellerAudit.passed > sellerAudit.denominator) {
    fail(`${label}.seller_audit passed exceeds denominator`);
  }
  const maxPage = positiveInteger(row?.max_page, `${label}.max_page`);
  if (maxPage > 2) fail(`${label}.max_page must be <= 2`);
  const priceBands = normalizePriceBands(row?.price_bands, `${label}.price_bands`);
  if (priceBands.some((band) => band.min < 50 || band.max > 200)) {
    fail(`${label}.price_bands must stay within the audited 50-200 CNY discovery range`);
  }
  const sorting = [...new Set((row?.sorting || []).map((entry) => String(entry || "").trim()))];
  if (sorting.length === 0 || sorting.some((entry) => !ALLOWED_SORTING.has(entry))) {
    fail(`${label}.sorting may contain only an empty default or rating`);
  }
  const allowTerms = normalizeTerms(row?.allow_terms_any, `${label}.allow_terms_any`);
  const requiredTermGroups = normalizeRequiredTermGroups(
    row?.required_term_groups_all,
    allowTerms,
    `${label}.required_term_groups_all`,
  );
  return Object.freeze({
    id,
    seller_url: sellerUrl,
    tier,
    role,
    evidence_basis: evidenceBasis,
    category_key: categoryKey,
    category_label: nonEmptyString(row?.category_label, `${label}.category_label`),
    audited_pass_skus: Object.freeze(auditedPassSkus),
    seller_audit: sellerAudit ? Object.freeze(sellerAudit) : null,
    allow_terms_any: Object.freeze(allowTerms),
    required_term_groups_all: requiredTermGroups,
    deny_terms_any: Object.freeze(
      Array.isArray(row?.deny_terms_any) && row.deny_terms_any.length > 0
        ? normalizeTerms(row.deny_terms_any, `${label}.deny_terms_any`)
        : [],
    ),
    price_bands: Object.freeze(priceBands),
    sorting: Object.freeze(sorting),
    max_page: maxPage,
    production_ozon_category_ids: Object.freeze(
      [...new Set((row?.production_ozon_category_ids || []).map((value) => String(value || "").trim()).filter(Boolean))],
    ),
  });
}

export function validateAuditedSourceArtifact(value, {
  sourcePath = "<memory>",
  now = new Date(),
} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${sourcePath} must contain a JSON object`);
  if (value.contract !== AUDITED_SOURCE_CONTRACT) fail(`${sourcePath} has an unsupported contract`);
  if (Number(value.schema_version) !== AUDITED_SOURCE_SCHEMA_VERSION) fail(`${sourcePath} has an unsupported schema_version`);
  if (value.deployment_phase !== AUDITED_DEPLOYMENT_PHASE) {
    fail(`${sourcePath} deployment_phase must be ${AUDITED_DEPLOYMENT_PHASE}`);
  }
  if (value.automatic_publish_eligible !== false) fail(`${sourcePath} must not be automatic-publish eligible`);
  if (Number(value.production_promotion_gate?.minimum_forward_validated_candidates) !== 300
    || value.production_promotion_gate?.requires_separate_artifact !== true
    || value.production_promotion_gate?.requires_ozon_category_id_binding !== true) {
    fail(`${sourcePath} must require 300 forward validations, a separate artifact, and Ozon category binding`);
  }
  const generatedAt = Date.parse(String(value.generated_at || ""));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  if (!Number.isFinite(generatedAt) || !Number.isFinite(nowMs) || generatedAt > nowMs) {
    fail(`${sourcePath} generated_at must be a valid timestamp that is not in the future`);
  }
  const provenance = value.provenance || {};
  if (provenance.source_report_path !== AUDITED_REPORT_RELATIVE_PATH) {
    fail(`${sourcePath} report path does not match the corrected audit`);
  }
  if (provenance.source_report_sha256 !== AUDITED_REPORT_SHA256) fail(`${sourcePath} report SHA256 does not match the corrected audit`);
  if (provenance.passed_report_rows_sha256 !== AUDITED_REPORT_PASSED_ROWS_SHA256) {
    fail(`${sourcePath} passed report rows SHA256 does not match the corrected audit`);
  }
  if (provenance.passed_products_with_attribution_sha256 !== AUDITED_PASSED_PRODUCTS_SHA256) {
    fail(`${sourcePath} passed product attribution SHA256 does not match the audited mapping`);
  }
  if (Number(provenance.denominator) !== AUDITED_REPORT_DENOMINATOR) fail(`${sourcePath} denominator must equal 144`);
  if (Number(provenance.passed) !== AUDITED_REPORT_PASSED) fail(`${sourcePath} passed must equal 34`);
  if (provenance.validation_rows_are_publications !== false) {
    fail(`${sourcePath} must state that validation rows are not publications`);
  }
  const passedProducts = normalizedPassedProducts(value.passed_products);
  const passedBySku = new Map(passedProducts.map((row) => [row.sku, row]));
  const attributed = passedProducts.filter((row) => row.seller_url).length;
  const unattributed = passedProducts.length - attributed;
  if (Number(provenance.attributed_passed) !== attributed
    || Number(provenance.unattributed_passed) !== unattributed) {
    fail(`${sourcePath} attributed/unattributed counts do not match passed_products`);
  }
  const globalDenyTerms = normalizeTerms(value.global_guard?.deny_terms_any, "global_guard.deny_terms_any");
  if (!Array.isArray(value.targets) || value.targets.length === 0) fail(`${sourcePath} targets must be non-empty`);
  const targets = value.targets.map((row, index) => normalizedTarget(row, index, passedBySku));
  const targetIds = new Set();
  const targetSellerCategories = new Set();
  for (const target of targets) {
    if (targetIds.has(target.id)) fail(`${sourcePath} contains duplicate target id ${target.id}`);
    targetIds.add(target.id);
    const sellerCategory = `${target.seller_url}\0${target.category_key}`;
    if (targetSellerCategories.has(sellerCategory)) fail(`${sourcePath} repeats seller/category ${target.id}`);
    targetSellerCategories.add(sellerCategory);
  }
  if (!targets.some((target) => target.id === "qinghong01-household-lighting"
    && target.tier === "P1" && target.role === "exploit")) {
    fail(`${sourcePath} must contain the P1 qinghong01 household-lighting exploit target`);
  }
  const excluded = Array.isArray(value.excluded_seller_categories)
    ? value.excluded_seller_categories.map((row, index) => {
      const sellerUrl = row?.seller_url === null ? null : auditedSellerRoot(row?.seller_url);
      if (row?.seller_url !== null && !sellerUrl) {
        fail(`excluded_seller_categories[${index}].seller_url is invalid`);
      }
      return Object.freeze({
        seller_url: sellerUrl,
        category_key: nonEmptyString(row?.category_key, `excluded_seller_categories[${index}].category_key`),
        reason_codes: Object.freeze(normalizeTerms(
          row?.reason_codes,
          `excluded_seller_categories[${index}].reason_codes`,
        )),
      });
    })
    : [];
  const excludedSellerUrls = new Set(excluded.map((row) => row.seller_url).filter(Boolean));
  for (const target of targets) {
    if (excludedSellerUrls.has(target.seller_url)) {
      fail(`${sourcePath} target ${target.id} uses an explicitly excluded seller`);
    }
  }
  const expandedTargetUrls = targets.flatMap(targetUrls);
  if (new Set(expandedTargetUrls).size !== expandedTargetUrls.length) {
    fail(`${sourcePath} target URL expansion must be globally unique`);
  }
  return Object.freeze({
    contract: AUDITED_SOURCE_CONTRACT,
    schema_version: AUDITED_SOURCE_SCHEMA_VERSION,
    deployment_phase: AUDITED_DEPLOYMENT_PHASE,
    automatic_publish_eligible: false,
    production_promotion_gate: Object.freeze({ ...value.production_promotion_gate }),
    generated_at: new Date(generatedAt).toISOString(),
    provenance: Object.freeze({ ...provenance }),
    global_guard: Object.freeze({ deny_terms_any: Object.freeze(globalDenyTerms) }),
    targets: Object.freeze(targets),
    excluded_seller_categories: Object.freeze(excluded),
    passed_products: Object.freeze(passedProducts),
  });
}

export async function loadAuditedSourceArtifact(filename, { packageRoot = null } = {}) {
  const sourcePath = path.resolve(String(filename || ""));
  let value;
  let artifactText;
  try {
    artifactText = await fs.readFile(sourcePath, "utf8");
    value = JSON.parse(artifactText);
  } catch (error) {
    fail(`${sourcePath} could not be loaded: ${error.message}`);
  }
  const artifactSha256 = sha256(artifactText);
  if (artifactSha256 !== AUDITED_ARTIFACT_SHA256) {
    fail(`${sourcePath} file SHA256 does not match the audited validation artifact`);
  }
  const artifact = validateAuditedSourceArtifact(value, { sourcePath });
  const resolvedPackageRoot = packageRoot
    ? path.resolve(String(packageRoot))
    : path.resolve(import.meta.dirname, "../..");
  const reportPath = path.resolve(
    resolvedPackageRoot,
    "evidence",
    path.basename(AUDITED_REPORT_RELATIVE_PATH),
  );
  // Audited runtime provenance is a deployable input, not a development-only
  // workspace convenience.  Candidate/stable releases must carry the original
  // corrected report bytes and fail closed when rsync/package assembly omits it.
  await verifyAuditedSourceReportFile(reportPath, artifact);
  return Object.freeze({
    ...artifact,
    source_path: sourcePath,
    source_report_resolved_path: reportPath,
    artifact_sha256: artifactSha256,
  });
}

export async function verifyAuditedSourceReportFile(filename, artifact) {
  const reportPath = path.resolve(String(filename || ""));
  let reportText;
  try {
    reportText = await fs.readFile(reportPath, "utf8");
  } catch (error) {
    fail(`${reportPath} could not be loaded: ${error.message}`);
  }
  if (sha256(reportText) !== AUDITED_REPORT_SHA256) {
    fail(`${reportPath} file SHA256 does not match the corrected audit`);
  }
  let report;
  try {
    report = JSON.parse(reportText);
  } catch (error) {
    fail(`${reportPath} is not valid JSON: ${error.message}`);
  }
  if (Number(report?.denominator) !== AUDITED_REPORT_DENOMINATOR
    || !Array.isArray(report?.rows)
    || report.rows.length !== AUDITED_REPORT_DENOMINATOR
    || Number(report?.summary?.passed) !== AUDITED_REPORT_PASSED) {
    fail(`${reportPath} does not contain the corrected 144/34 audit population`);
  }
  const reportPassedRows = report.rows.filter((row) => row?.passed === true).map((row, index) => ({
    sku: nonEmptyString(row?.sku, `corrected report passed row ${index}.sku`),
    title: nonEmptyString(row?.title, `corrected report passed row ${index}.title`),
  }));
  if (reportPassedRows.length !== AUDITED_REPORT_PASSED
    || passedRowsSha256(reportPassedRows) !== AUDITED_REPORT_PASSED_ROWS_SHA256
    || passedRowsSha256(artifact?.passed_products || []) !== AUDITED_REPORT_PASSED_ROWS_SHA256) {
    fail(`${reportPath} passed SKU/title population does not match the audited artifact`);
  }
  return Object.freeze({
    source_report_path: reportPath,
    source_report_sha256: AUDITED_REPORT_SHA256,
    passed_report_rows_sha256: AUDITED_REPORT_PASSED_ROWS_SHA256,
    denominator: AUDITED_REPORT_DENOMINATOR,
    passed: AUDITED_REPORT_PASSED,
  });
}

function sourceUrlFor(target, band, sorting, page) {
  const url = new URL(target.seller_url);
  url.searchParams.set("currency_price", `${band.min.toFixed(3)};${band.max.toFixed(3)}`);
  if (sorting) url.searchParams.set("sorting", sorting);
  if (page > 1) url.searchParams.set("page", String(page));
  url.searchParams.sort();
  return url.toString();
}

function targetUrls(target) {
  const urls = [];
  for (const band of target.price_bands) {
    for (const sorting of target.sorting) {
      for (let page = 1; page <= target.max_page; page += 1) {
        urls.push(sourceUrlFor(target, band, sorting, page));
      }
    }
  }
  return urls;
}

function explorationRoundRobin(targets) {
  const queues = targets.map((target) => ({ target, urls: targetUrls(target), index: 0 }));
  const rows = [];
  while (queues.some((queue) => queue.index < queue.urls.length)) {
    for (const queue of queues) {
      if (queue.index >= queue.urls.length) continue;
      rows.push({ target: queue.target, url: queue.urls[queue.index] });
      queue.index += 1;
    }
  }
  return rows;
}

function selectedSourceRows(artifact, slots) {
  const maximumSlots = Math.max(1, Math.floor(Number(slots) || 60));
  const exploitTargets = artifact.targets.filter((target) => target.role === "exploit");
  const exploreTargets = artifact.targets.filter((target) => target.role === "explore");
  const exploitRows = exploitTargets.flatMap((target) => targetUrls(target).map((url) => ({ target, url })));
  const exploreRows = explorationRoundRobin(exploreTargets);
  const allUrls = [...exploitRows, ...exploreRows].map((row) => row.url);
  if (new Set(allUrls).size !== allUrls.length) {
    fail("artifact target URL expansion contains duplicates");
  }
  const intendedExploit = Math.min(exploitRows.length, Math.ceil(maximumSlots * (2 / 3)));
  const intendedExplore = Math.min(exploreRows.length, maximumSlots - intendedExploit);
  const rows = [
    ...exploitRows.slice(0, intendedExploit),
    ...exploreRows.slice(0, intendedExplore),
  ];
  if (rows.length < maximumSlots) {
    const selected = new Set(rows.map((row) => row.url));
    rows.push(...[...exploitRows, ...exploreRows]
      .filter((row) => !selected.has(row.url))
      .slice(0, maximumSlots - rows.length));
  }
  if (new Set(rows.map((row) => row.url)).size !== rows.length) {
    fail("active audited source URL selection contains duplicates");
  }
  return rows;
}

export function auditedSourceSetText(urls = []) {
  const normalized = (urls || []).map(exactAuditedSourceUrl);
  if (normalized.some((url) => !url) || new Set(normalized).size !== normalized.length) {
    fail("active source set must contain unique valid exact URLs");
  }
  return `${normalized.join("\n")}\n`;
}

export function auditedSourceSetSha256(urls = []) {
  return sha256(auditedSourceSetText(urls));
}

export function buildAuditedValidationSourcePolicy({
  artifact,
  slots = 60,
  now = new Date(),
  freezeMs = 2 * 60 * 60_000,
  currentWindow = {},
  historicalBootstrap = {},
} = {}) {
  const maximumSlots = Math.max(1, Math.floor(Number(slots) || 60));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  if (!Number.isFinite(nowMs)) fail("policy now must be a valid timestamp");
  const normalized = artifact?.contract === AUDITED_SOURCE_CONTRACT
    ? artifact
    : validateAuditedSourceArtifact(artifact || {});
  const rows = selectedSourceRows(normalized, maximumSlots);
  const activeUrls = rows.map((row) => row.url);
  if (activeUrls.length < Math.min(40, maximumSlots)) {
    fail(`artifact produced only ${activeUrls.length} exact URLs; at least ${Math.min(40, maximumSlots)} are required`);
  }
  const metrics = normalized.targets.map((target) => ({
    seller_url: target.seller_url,
    target_id: target.id,
    category_key: target.category_key,
    tier: target.tier,
    role: target.role,
    evidence_scope: "audited-validation-bootstrap",
    audited_validation_passed: target.audited_pass_skus.length,
    audited_validation_denominator: Number(target.seller_audit?.denominator) || 0,
    unique_detail_attempts: 0,
    unique_strict: 0,
    score: 0,
  }));
  const generatedAt = new Date(nowMs).toISOString();
  const selectedExploit = rows.filter((row) => row.target.role === "exploit").length;
  return {
    policy_version: 2,
    generated_at: generatedAt,
    evaluated_at: generatedAt,
    frozen_until: new Date(nowMs + Math.max(2 * 60 * 60_000, Number(freezeMs) || 0)).toISOString(),
    evidence_window: null,
    evidence_mode: "audited-validation-bootstrap",
    reason: "audited-validation-bootstrap-refreshed",
    deployment_phase: normalized.deployment_phase,
    automatic_publish_eligible: false,
    derived_search_enabled: false,
    audited_artifact_sha256: normalized.artifact_sha256 || null,
    source_set_sha256: auditedSourceSetSha256(activeUrls),
    audited_provenance: {
      source_report_sha256: normalized.provenance.source_report_sha256,
      denominator: normalized.provenance.denominator,
      passed: normalized.provenance.passed,
      attributed_passed: normalized.provenance.attributed_passed,
      unattributed_passed: normalized.provenance.unattributed_passed,
      validation_rows_are_publications: false,
    },
    allocation: {
      exploit: selectedExploit,
      explore: Math.max(0, rows.length - selectedExploit),
    },
    unique_detail_attempts: Number(currentWindow?.unique_detail_attempts) || 0,
    unique_strict: Number(currentWindow?.unique_strict) || 0,
    current_window: {
      unique_detail_attempts: Number(currentWindow?.unique_detail_attempts) || 0,
      unique_strict: Number(currentWindow?.unique_strict) || 0,
      verified_sellers: Number(currentWindow?.verified_sellers) || 0,
    },
    historical_bootstrap: {
      ...historicalBootstrap,
      active: false,
    },
    audited_validation: {
      source: normalized.provenance.source_report_path,
      source_report_sha256: normalized.provenance.source_report_sha256,
      denominator: normalized.provenance.denominator,
      passed: normalized.provenance.passed,
      attributed_passed: normalized.provenance.attributed_passed,
      unattributed_passed: normalized.provenance.unattributed_passed,
      target_count: normalized.targets.length,
      active_url_count: activeUrls.length,
      deployment_phase: normalized.deployment_phase,
      publication_credit: 0,
      minimum_forward_validated_candidates:
        normalized.production_promotion_gate.minimum_forward_validated_candidates,
      requires_separate_artifact: true,
      requires_ozon_category_id_binding: true,
    },
    sellers: metrics,
    active_urls: activeUrls,
    active_source_bindings: rows.map((row) => ({
      source_url: row.url,
      target_id: row.target.id,
      seller_url: row.target.seller_url,
      category_key: row.target.category_key,
    })),
  };
}

function candidateText(row = {}) {
  return [row?.title, row?.text, row?.card_text]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}

export function auditedAllowedSourceIndex(artifact, { slots = 60 } = {}) {
  const cacheable = Object.isFrozen(artifact) && Object.isFrozen(artifact?.targets);
  if (cacheable) {
    const cachedBySlots = allowedSourceIndexCache.get(artifact);
    if (cachedBySlots?.has(Number(slots))) return cachedBySlots.get(Number(slots));
  }
  const policy = buildAuditedValidationSourcePolicy({
    artifact,
    slots,
    now: new Date(Math.max(Date.now(), Date.parse(String(artifact?.generated_at || "")))),
  });
  const index = new Map(policy.active_source_bindings.map((binding) => [
    exactAuditedSourceUrl(binding.source_url),
    (artifact.targets || []).find((target) => target.id === binding.target_id),
  ]));
  if (cacheable) {
    const cachedBySlots = allowedSourceIndexCache.get(artifact) || new Map();
    cachedBySlots.set(Number(slots), index);
    allowedSourceIndexCache.set(artifact, cachedBySlots);
  }
  return index;
}

export function validateAuditedActiveUrls(activeUrls, artifact, {
  slots = 60,
  requireExact = false,
} = {}) {
  const values = (activeUrls || []).map(exactAuditedSourceUrl);
  if (values.length === 0 || values.some((url) => !url) || new Set(values).size !== values.length) {
    fail("active_urls must contain unique valid exact URLs");
  }
  const allowed = auditedAllowedSourceIndex(artifact, { slots });
  for (const url of values) {
    if (!allowed.has(url)) fail(`active URL is outside the deterministic artifact set: ${url}`);
  }
  const deterministicUrls = [...allowed.keys()];
  if (requireExact && (
    values.length !== deterministicUrls.length
    || values.some((url, index) => url !== deterministicUrls[index])
  )) {
    fail("active_urls must exactly equal the deterministic artifact source set");
  }
  return Object.freeze({
    active_urls: Object.freeze(values),
    source_set_sha256: auditedSourceSetSha256(values),
    allowed_source_index: allowed,
  });
}

export function auditedSourceRedirectEligibility(requestedUrl, finalUrl, artifact, {
  activeUrls,
  slots = 60,
} = {}) {
  const requested = exactAuditedSourceUrl(requestedUrl);
  const final = exactAuditedSourceUrl(finalUrl);
  if (!requested || !final) return { eligible: false, reason: "audited-source-redirect-invalid" };
  let active;
  try {
    active = validateAuditedActiveUrls(activeUrls, artifact, { slots });
  } catch {
    return { eligible: false, reason: "audited-active-source-set-invalid" };
  }
  if (!active.allowed_source_index.has(requested) || !active.active_urls.includes(requested)) {
    return { eligible: false, reason: "audited-source-request-not-active" };
  }
  if (final !== requested) {
    return { eligible: false, reason: "audited-source-redirect-mismatch" };
  }
  return { eligible: true, reason: null, source_url: final };
}

export function auditedCandidateEligibility(row, artifact, {
  activeUrls = null,
  slots = 60,
} = {}) {
  const sourceUrl = exactAuditedSourceUrl(row?.source_url);
  if (!sourceUrl) return { eligible: false, reason: "audited-source-attribution-missing", target: null };
  let allowed;
  try {
    const validated = validateAuditedActiveUrls(
      activeUrls instanceof Set ? [...activeUrls] : activeUrls,
      artifact,
      { slots },
    );
    if (!validated.active_urls.includes(sourceUrl)) {
      return { eligible: false, reason: "audited-source-not-active", target: null };
    }
    allowed = validated.allowed_source_index;
  } catch {
    return { eligible: false, reason: "audited-active-source-set-invalid", target: null };
  }
  const target = allowed.get(sourceUrl);
  if (!target) return { eligible: false, reason: "audited-source-not-in-artifact", target: null };
  const excludedSellers = new Set((artifact?.excluded_seller_categories || [])
    .map((rowValue) => rowValue?.seller_url)
    .filter(Boolean));
  if (excludedSellers.has(target.seller_url)) {
    return { eligible: false, reason: "audited-source-seller-excluded", target: null };
  }
  const text = candidateText(row);
  if (!text) return { eligible: false, reason: "audited-source-category-text-missing", target: null };
  if ((artifact?.global_guard?.deny_terms_any || []).some((term) => text.includes(term))) {
    return { eligible: false, reason: "audited-source-global-risk-term", target: null };
  }
  if (target.deny_terms_any.some((term) => text.includes(term))) {
    return { eligible: false, reason: "audited-source-category-risk-term", target: null };
  }
  if (target.required_term_groups_all.every(
    (group) => group.some((term) => text.includes(term)),
  )) {
    return { eligible: true, reason: null, target };
  }
  return { eligible: false, reason: "audited-source-category-mismatch", target: null };
}

export function auditedAutomaticPublishEligibility(row, artifact, options = {}) {
  if (options.validationOnly === true) return { eligible: true, reason: null, target: null };
  if (artifact?.deployment_phase !== "production_eligible"
    || artifact?.automatic_publish_eligible !== true) {
    return { eligible: false, reason: "audited-artifact-validation-only", target: null };
  }
  const candidate = auditedCandidateEligibility(row, artifact, options);
  if (!candidate.eligible) return candidate;
  const categoryId = String(row?.ozon_category_id || row?.category_id || "").trim();
  if (!categoryId || !candidate.target.production_ozon_category_ids.includes(categoryId)) {
    return { eligible: false, reason: "audited-production-category-unbound", target: candidate.target };
  }
  return candidate;
}

export function validateAuditedRuntimeBinding(binding, artifact, activeUrls) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    fail("runtime identity is missing");
  }
  if (binding.contract !== AUDITED_RUNTIME_IDENTITY_CONTRACT) {
    fail("runtime identity contract is invalid");
  }
  const artifactSha256 = String(binding.audited_artifact_sha256 || "").trim();
  if (!/^[a-f0-9]{64}$/u.test(artifactSha256)
    || artifactSha256 !== String(artifact?.artifact_sha256 || "")) {
    fail("runtime identity artifact SHA256 does not match the loaded artifact");
  }
  const sourceSlots = Number(binding.source_slots);
  if (!Number.isInteger(sourceSlots) || sourceSlots !== 60) {
    fail("runtime identity source_slots must equal the deterministic 60-URL campaign");
  }
  const active = validateAuditedActiveUrls(activeUrls, artifact, {
    slots: sourceSlots,
    requireExact: true,
  });
  if (String(binding.source_set_sha256 || "") !== active.source_set_sha256) {
    fail("runtime identity source-set SHA256 does not match active_urls");
  }
  const sourceEpoch = Number(binding.source_set_epoch);
  if (!Number.isInteger(sourceEpoch) || sourceEpoch < 0) fail("runtime identity source_set_epoch is invalid");
  const activatedAtMs = Date.parse(String(binding.source_set_activated_at || ""));
  if (!Number.isFinite(activatedAtMs) || activatedAtMs > Date.now()) {
    fail("runtime identity source_set_activated_at is invalid or in the future");
  }
  const runId = nonEmptyString(binding.run_id, "runtime identity run_id");
  return Object.freeze({
    contract: AUDITED_RUNTIME_IDENTITY_CONTRACT,
    run_id: runId,
    audited_artifact_sha256: artifactSha256,
    source_set_sha256: active.source_set_sha256,
    source_set_epoch: sourceEpoch,
    source_set_activated_at: new Date(activatedAtMs).toISOString(),
    source_slots: sourceSlots,
  });
}

export function buildAuditedRuntimeBinding({
  runId,
  artifact,
  activeUrls,
  sourceSetEpoch = 0,
  sourceSetActivatedAt = new Date(),
  sourceSlots = 60,
} = {}) {
  return validateAuditedRuntimeBinding({
    contract: AUDITED_RUNTIME_IDENTITY_CONTRACT,
    run_id: runId,
    audited_artifact_sha256: artifact?.artifact_sha256,
    source_set_sha256: auditedSourceSetSha256(activeUrls),
    source_set_epoch: sourceSetEpoch,
    source_set_activated_at: sourceSetActivatedAt instanceof Date
      ? sourceSetActivatedAt.toISOString()
      : String(sourceSetActivatedAt || ""),
    source_slots: sourceSlots,
  }, artifact, activeUrls);
}

export async function loadAuditedRuntimeBinding(runDir, artifact, activeUrls) {
  const resolvedRunDir = path.resolve(String(runDir || ""));
  const identityPath = path.join(resolvedRunDir, "audited_source_identity.json");
  const expectedSourceSetSha256 = auditedSourceSetSha256(activeUrls);
  let identity;
  try {
    identity = JSON.parse(await fs.readFile(identityPath, "utf8"));
  } catch (error) {
    fail(`${identityPath} could not be loaded: ${error.message}`);
  }
  let lastEpoch = null;
  try {
    const epochText = await fs.readFile(path.join(resolvedRunDir, "source_set_epochs.jsonl"), "utf8");
    for (const line of epochText.split(/\r?\n/u).filter(Boolean)) {
      let row;
      try {
        row = JSON.parse(line);
      } catch (error) {
        fail(`runtime source epoch log contains invalid JSON: ${error.message}`);
      }
      const epoch = Number(row?.epoch);
      const activatedAt = Date.parse(String(row?.at || ""));
      if (row?.type !== "source-set-epoch"
        || !Number.isInteger(epoch)
        || epoch < 0
        || !Number.isFinite(activatedAt)
        || String(row?.run_id || "") !== String(identity?.run_id || "")
        || String(row?.audited_artifact_sha256 || "")
          !== String(identity?.audited_artifact_sha256 || "")
        || String(row?.source_set_sha256 || "") !== expectedSourceSetSha256) {
        fail("runtime source epoch log is not bound to the audited campaign identity");
      }
      if ((!lastEpoch && epoch !== Number(identity?.source_set_epoch))
        || (lastEpoch && epoch !== Number(lastEpoch.epoch) + 1)
        || (lastEpoch && activatedAt < Date.parse(String(lastEpoch.at || "")))) {
        fail("runtime source epoch log is not a monotonic campaign sequence");
      }
      const expectedPrevious = lastEpoch?.source_set_sha256 || null;
      if ((row?.previous_source_set_sha256 ?? null) !== expectedPrevious) {
        fail("runtime source epoch previous source-set SHA256 is invalid");
      }
      lastEpoch = row;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const effective = lastEpoch ? {
    ...identity,
    source_set_sha256: lastEpoch.source_set_sha256,
    source_set_epoch: Number(lastEpoch.epoch),
    source_set_activated_at: lastEpoch.at,
  } : identity;
  return validateAuditedRuntimeBinding(effective, artifact, activeUrls);
}

export function auditedFactRuntimeEligibility(fact, binding, { requireStatus = null } = {}) {
  if (!fact || !binding) return { eligible: false, reason: "audited-current-run-fact-missing" };
  if (String(fact.evidence_scope || "") !== AUDITED_SOURCE_EVENT_SCOPE) {
    return { eligible: false, reason: "audited-current-run-fact-provenance-missing" };
  }
  const status = String(fact.status || "");
  if (!["discovered", "favorited"].includes(status)) {
    return { eligible: false, reason: "audited-current-run-fact-status-invalid" };
  }
  if (requireStatus && status !== requireStatus) {
    return { eligible: false, reason: "audited-current-run-fact-status-insufficient" };
  }
  if (String(fact.run_id || "") !== String(binding.run_id || "")) {
    return { eligible: false, reason: "audited-current-run-fact-run-mismatch" };
  }
  if (String(fact.audited_artifact_sha256 || "") !== String(binding.audited_artifact_sha256 || "")) {
    return { eligible: false, reason: "audited-current-run-fact-artifact-mismatch" };
  }
  if (String(fact.source_set_sha256 || "") !== String(binding.source_set_sha256 || "")
    || Number(fact.source_set_epoch) !== Number(binding.source_set_epoch)) {
    return { eligible: false, reason: "audited-current-run-fact-source-epoch-mismatch" };
  }
  const factAt = Date.parse(String(
    status === "favorited"
      ? fact.favorited_at || fact.at
      : fact.discovered_at || fact.at,
  ));
  const activatedAt = Date.parse(String(binding.source_set_activated_at || ""));
  if (!Number.isFinite(factAt) || !Number.isFinite(activatedAt) || factAt < activatedAt) {
    return { eligible: false, reason: "audited-current-run-fact-predates-source-epoch" };
  }
  return { eligible: true, reason: null };
}
