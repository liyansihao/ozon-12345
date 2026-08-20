import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  auditedCandidateEligibility,
  auditedSellerRoot,
  auditedSourceSetSha256,
  auditedSourceRedirectEligibility,
  buildAuditedValidationSourcePolicy,
  exactAuditedSourceUrl,
  loadAuditedSourceArtifact,
} from "./audited-source-portfolio.mjs";
import { createCandidateQueue } from "./candidate-queue.mjs";
import { parseOzonDetailText } from "./ozon-detail.mjs";

export const AUDITED_DISCOVERY_MANIFEST_CONTRACT = "ozon-audited-validation-discovery-campaign-v1";
export const AUDITED_DISCOVERY_FACT_CONTRACT = "ozon-audited-validation-discovery-fact-v1";
export const AUDITED_DISCOVERY_SCAN_CONTRACT = "ozon-audited-validation-discovery-scan-v1";
export const AUDITED_LIVE_DETAIL_CONTRACT = "ozon-audited-validation-live-detail-v1";
export const AUDITED_CANDIDATE_PROVENANCE_CONTRACT = "ozon-audited-validation-candidate-provenance-v1";
export const AUDITED_CANDIDATE_SET_CONTRACT = "ozon-audited-validation-candidate-set-v1";
export const AUDITED_CANDIDATE_PROVENANCE_SET_CONTRACT = "ozon-audited-validation-candidate-provenance-set-v1";
export const DEFAULT_AUDITED_DISCOVERY_TARGET = 360;
export const DEFAULT_AUDITED_CANDIDATE_MINIMUM = 300;
export const DEFAULT_AUDITED_DISCOVERY_SOURCE_COUNT = 60;

const DETAIL_METHOD = "ozon-detail-plugin-live";
const READ_ONLY_SCAN_ADAPTER_CONTRACT = "ozon-audited-read-only-source-scan-v1";
const LIVE_DETAIL_ACCESS_ADAPTER_CONTRACT = "ozon-audited-live-detail-access-v1";
const LIVE_DETAIL_FUTURE_SKEW_MS = 5 * 60_000;
const LIVE_DETAIL_RATE_MAX_AGE_MS = 5 * 60_000;
const LIVE_DETAIL_RATE_FUTURE_SKEW_MS = 30_000;
const LIVE_DETAIL_MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_AUDITED_DISCOVERY_CONCURRENCY = 4;
const MAX_API_RATE_RELATIVE_DRIFT = 0.01;
const PRICE_DOM_CONTRACT = "webPrice visible non-struck leaf current + excluded old/struck leaves + one same-page Maozi 跟卖最低价 RUB≈CNY line; parseOzonDetailText(fallback=null)-v2";

function discoveryError(message) {
  return new Error(`audited validation discovery: ${message}`);
}

export function isAuditedManualAttentionError(error) {
  return /captcha|капч|验证码|人机验证|authentication required|requires authentication|verification required|需要登录/iu
    .test(String(error?.message || error || ""));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isoNow(now = () => new Date()) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw discoveryError("clock returned an invalid timestamp");
  return date.toISOString();
}

function nonEmpty(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw discoveryError(`${label} must be non-empty`);
  return normalized;
}

function normalizeEpoch(value) {
  const epoch = nonEmpty(value, "campaign epoch");
  if (epoch.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u.test(epoch)) {
    throw discoveryError("campaign epoch must be a 1-128 character stable token");
  }
  return epoch;
}

function normalizeRunId(value) {
  const runId = nonEmpty(value, "run id");
  if (runId.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(runId)) {
    throw discoveryError("run id must be a 1-160 character stable token");
  }
  return runId;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw discoveryError(`${label} must be a positive integer`);
  return number;
}

function exactHttpsUrl(value, label) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw discoveryError(`${label} must be a valid HTTPS URL`); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.port) {
    throw discoveryError(`${label} must be a credential-free HTTPS URL`);
  }
  return url.href;
}

function exactOzonProductUrl(value, label) {
  const parsed = new URL(exactHttpsUrl(value, label));
  if (!["ozon.ru", "www.ozon.ru"].includes(parsed.hostname.toLowerCase())) {
    throw discoveryError(`${label} must use the canonical Ozon product host`);
  }
  if (!/^\/product\/(?:[^/?#]*-)?\d+\/?$/u.test(parsed.pathname)) {
    throw discoveryError(`${label} must use a canonical Ozon /product/<sku> path`);
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

function exactOzonSellerRoot(value, label) {
  const parsed = new URL(exactHttpsUrl(value, label));
  if (!["ozon.ru", "www.ozon.ru"].includes(parsed.hostname.toLowerCase())
    || !/^\/seller\/[a-z0-9][a-z0-9-]*\/?$/iu.test(parsed.pathname)
    || parsed.search || parsed.hash) {
    throw discoveryError(`${label} must be a canonical Ozon seller root`);
  }
  return auditedSellerRoot(parsed.href);
}

function trustedOzonImageUrl(value, label) {
  const parsed = new URL(exactHttpsUrl(value, label));
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "ozone.ru" && !hostname.endsWith(".ozone.ru")) {
    throw discoveryError(`${label} must use an Ozon-controlled image host`);
  }
  return parsed.href;
}

function parseLocalizedPriceNumber(value) {
  const compact = String(value || "").trim().replace(/[\u00a0\u2009\u202f]/gu, " ");
  if (!compact || !/^\d[\d., ]*\d$|^\d$/u.test(compact)) return null;
  const whitespaceGroups = compact.split(/ +/u);
  if (whitespaceGroups.length > 1
    && whitespaceGroups.slice(1).some((group) => !/^\d{3}(?:[.,]\d{1,2})?$/u.test(group))) {
    return null;
  }
  const joined = compact.replace(/ /gu, "");
  const commaCount = (joined.match(/,/gu) || []).length;
  const dotCount = (joined.match(/\./gu) || []).length;
  let normalized;
  if (commaCount > 0 && dotCount > 0) {
    const lastComma = joined.lastIndexOf(",");
    const lastDot = joined.lastIndexOf(".");
    const decimal = lastComma > lastDot ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    const pieces = joined.split(decimal);
    if (pieces.length !== 2 || !/^\d{1,2}$/u.test(pieces[1])) return null;
    const groups = pieces[0].split(thousands);
    if (!/^\d{1,3}$/u.test(groups[0]) || groups.slice(1).some((group) => !/^\d{3}$/u.test(group))) return null;
    normalized = `${groups.join("")}.${pieces[1]}`;
  } else if (commaCount > 0 || dotCount > 0) {
    const separator = commaCount > 0 ? "," : ".";
    const groups = joined.split(separator);
    if (groups.some((group) => !/^\d+$/u.test(group))) return null;
    if (groups.length > 2) {
      if (!/^\d{1,3}$/u.test(groups[0]) || groups.slice(1).some((group) => !/^\d{3}$/u.test(group))) return null;
      normalized = groups.join("");
    } else if (groups[1].length <= 2) {
      normalized = `${groups[0]}.${groups[1]}`;
    } else if (groups[1].length === 3 && /^\d{1,3}$/u.test(groups[0])) {
      normalized = groups.join("");
    } else {
      return null;
    }
  } else {
    normalized = joined;
  }
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function skuFromProductUrl(value) {
  return String(value || "").match(/\/product\/(?:[^/?#]*-)?(\d+)(?:[/?#]|$)/u)?.[1] || "";
}

function normalizeSku(value, label = "sku") {
  const sku = String(value || "").trim();
  if (!/^\d+$/u.test(sku) || /^0+$/u.test(sku)) {
    throw discoveryError(`${label} must be a positive decimal digit string`);
  }
  return sku;
}

function artifactSha256(artifact) {
  const digest = String(artifact?.artifact_sha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw discoveryError("loaded artifact must carry its verified artifact_sha256");
  }
  return digest;
}

function assertValidationOnlyArtifact(artifact) {
  if (artifact?.deployment_phase !== "validation_only"
    || artifact?.automatic_publish_eligible !== false) {
    throw discoveryError("artifact must be validation_only and automatic_publish_eligible=false");
  }
}

export function auditedDiscoveryOnlyEnabled(env = {}) {
  return String(env.FLOW_B_AUDITED_DISCOVERY_ONLY || "") === "1";
}

export function assertAuditedDiscoveryOnlyScope(env = {}, artifact) {
  if (!auditedDiscoveryOnlyEnabled(env)) {
    throw discoveryError("FLOW_B_AUDITED_DISCOVERY_ONLY=1 is required");
  }
  if (String(env.FLOW_B_AUDITED_SOURCE_PORTFOLIO || "") !== "1") {
    throw discoveryError("FLOW_B_AUDITED_SOURCE_PORTFOLIO=1 is required");
  }
  if (String(env.FLOW_B_VALIDATION_ONLY || "") !== "1") {
    throw discoveryError("FLOW_B_VALIDATION_ONLY=1 is required");
  }
  if (String(env.FLOW_B_DIRECT_PUBLISH || "") === "1") {
    throw discoveryError("FLOW_B_DIRECT_PUBLISH must not be enabled");
  }
  if (String(env.FLOW_B_MAOZI_AUTOFAVORITE ?? "0") !== "0") {
    throw discoveryError("FLOW_B_MAOZI_AUTOFAVORITE=0 is required");
  }
  if (String(env.FLOW_B_AUDITED_DISCOVERY_OWNED_CONTEXT || "") !== "1") {
    throw discoveryError("FLOW_B_AUDITED_DISCOVERY_OWNED_CONTEXT=1 is required");
  }
  assertValidationOnlyArtifact(artifact);
  return true;
}

export function auditedDiscoveryTarget(value = DEFAULT_AUDITED_DISCOVERY_TARGET) {
  const target = positiveInteger(value, "discovery target");
  if (target < DEFAULT_AUDITED_DISCOVERY_TARGET) {
    throw discoveryError(`discovery target must be at least ${DEFAULT_AUDITED_DISCOVERY_TARGET}`);
  }
  return target;
}

export function auditedCandidateMinimum(value = DEFAULT_AUDITED_CANDIDATE_MINIMUM) {
  const minimum = positiveInteger(value, "candidate minimum");
  if (minimum < DEFAULT_AUDITED_CANDIDATE_MINIMUM) {
    throw discoveryError(`candidate minimum must be at least ${DEFAULT_AUDITED_CANDIDATE_MINIMUM}`);
  }
  return minimum;
}

function auditedConcurrency(value, label) {
  const concurrency = positiveInteger(value, label);
  if (concurrency > MAX_AUDITED_DISCOVERY_CONCURRENCY) {
    throw discoveryError(`${label} must be between 1 and ${MAX_AUDITED_DISCOVERY_CONCURRENCY}`);
  }
  return concurrency;
}

export function createAuditedReadOnlySourceScanAdapter(readSource) {
  if (typeof readSource !== "function") throw discoveryError("read-only source scan callback is required");
  return Object.freeze({
    contract: READ_ONLY_SCAN_ADAPTER_CONTRACT,
    favorite_mutations_allowed: false,
    submission_allowed: false,
    scan: (request) => readSource(Object.freeze({
      sourceUrl: request.sourceUrl,
      sourceIndex: request.sourceIndex,
    })),
  });
}

export function createPlaywrightAuditedSourceScanAdapter({
  context,
  scanSourceWithPage,
  scanOptions,
  timeoutMs = 90_000,
  closeTimeoutMs = 5_000,
  accessController = null,
  ownedContext = false,
  ...unsupported
} = {}) {
  if (Object.keys(unsupported).length > 0) {
    throw discoveryError(`unsupported read-only scan adapter field(s): ${Object.keys(unsupported).sort().join(", ")}`);
  }
  if (!context || typeof context.newPage !== "function") {
    throw discoveryError("an owned Playwright browser context is required");
  }
  if (ownedContext !== true) {
    throw discoveryError("ownedContext=true is required for audited discovery");
  }
  if (typeof scanSourceWithPage !== "function") {
    throw discoveryError("scanSourceWithPage read-only hook is required");
  }
  if (!scanOptions || typeof scanOptions !== "object" || Array.isArray(scanOptions)) {
    throw discoveryError("read-only source scan options are required");
  }
  return createAuditedReadOnlySourceScanAdapter(({ sourceUrl, sourceIndex }) => scanSourceWithPage({
    context,
    url: sourceUrl,
    options: { ...scanOptions },
    timeoutMs,
    closeTimeoutMs,
    pageIndex: sourceIndex,
    accessController,
  }));
}

export function createPlaywrightAuditedLiveDetailFetcher({
  context,
  ownedContext = false,
  apiCnyPerRub = null,
  apiRateObservedAt = null,
  apiRateProvider = null,
  navigationTimeoutMs = 30_000,
  observationTimeoutMs = 15_000,
  pollMs = 500,
  now = () => new Date(),
  ...unsupported
} = {}) {
  if (Object.keys(unsupported).length > 0) {
    throw discoveryError(`unsupported live detail fetcher field(s): ${Object.keys(unsupported).sort().join(", ")}`);
  }
  if (!context || typeof context.newPage !== "function") {
    throw discoveryError("an owned Playwright browser context is required for live detail");
  }
  if (ownedContext !== true) {
    throw discoveryError("ownedContext=true is required for live detail enrichment");
  }
  if (apiRateProvider !== null && typeof apiRateProvider !== "function") {
    throw discoveryError("live detail apiRateProvider must be a function");
  }
  const navigationTimeout = Math.max(10_000, Number(navigationTimeoutMs) || 30_000);
  const observationTimeout = Math.max(50, Number(observationTimeoutMs) || 15_000);
  const interval = Math.max(10, Number(pollMs) || 500);
  return async (fact) => {
    const providedRate = apiRateProvider
      ? await apiRateProvider()
      : apiCnyPerRub === null || apiCnyPerRub === undefined
        ? null
        : { cny_per_rub: Number(apiCnyPerRub), observed_at: apiRateObservedAt };
    const page = await context.newPage();
    let operationError = null;
    try {
      const response = await page.goto(fact.href, { waitUntil: "commit", timeout: navigationTimeout });
      const httpStatus = typeof response?.status === "function" ? Number(response.status()) : null;
      if (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 400)) {
        throw discoveryError(`live detail ${fact.sku} navigation returned HTTP ${httpStatus}`);
      }
      const deadline = Date.now() + observationTimeout;
      let snapshot = null;
      let evidenceReady = false;
      do {
        snapshot = await page.evaluate(() => {
          const bodyText = document.body?.innerText || "";
          const widget = document.querySelector('div[data-widget="webPrice"]');
          const hasMoney = (text) => /(?:[¥￥₽]|\bRUB\b)/u.test(String(text || ""));
          const selectorFor = (element) => {
            const testId = element.getAttribute?.("data-testid");
            if (testId) return `[data-testid=${JSON.stringify(testId)}]`;
            const itemProp = element.getAttribute?.("itemprop");
            if (itemProp) return `${element.tagName.toLowerCase()}[itemprop=${JSON.stringify(itemProp)}]`;
            return `${element.tagName.toLowerCase()}.webPrice-leaf`;
          };
          const leaves = widget ? [...widget.querySelectorAll("*")].flatMap((element) => {
            const rawText = String(element.innerText || "").trim();
            if (!rawText || !hasMoney(rawText)
              || [...element.children].some((child) => hasMoney(child.innerText))) return [];
            const style = getComputedStyle(element);
            const visible = style.display !== "none"
              && style.visibility !== "hidden"
              && Number(style.opacity || 1) > 0
              && element.getClientRects().length > 0;
            const lineThrough = String(style.textDecorationLine || style.textDecoration || "").includes("line-through");
            const installment = /(?:рассроч|в месяц|\/мес)/iu.test(rawText);
            return [{
              element,
              raw_text: rawText,
              selector: selectorFor(element),
              visible,
              line_through: lineThrough,
              installment,
            }];
          }) : [];
          const currentLeaves = leaves.filter((row) => row.visible && !row.line_through && !row.installment);
          const currentLeaf = currentLeaves.length === 1 ? currentLeaves[0] : null;
          const excludedLeaves = leaves.filter((row) => row.visible && row !== currentLeaf
            && (row.line_through || row.installment));
          const parseLd = () => {
            const values = [];
            for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
              try {
                const parsed = JSON.parse(script.textContent || "null");
                values.push(...(Array.isArray(parsed) ? parsed : [parsed]));
              } catch {}
            }
            return values.flatMap((value) => Array.isArray(value?.["@graph"]) ? value["@graph"] : [value]);
          };
          const ld = parseLd();
          const product = ld.find((value) => {
            const type = value?.["@type"];
            return type === "Product" || (Array.isArray(type) && type.includes("Product"));
          }) || null;
          const breadcrumb = ld.find((value) => {
            const type = value?.["@type"];
            return type === "BreadcrumbList" || (Array.isArray(type) && type.includes("BreadcrumbList"));
          }) || null;
          const bodyLines = bodyText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
          const brandIndex = bodyLines.findIndex((line) => /^(?:бренд|brand)$/iu.test(line));
          const productBrandIsString = typeof product?.brand === "string";
          const productBrandHasName = product?.brand
            && typeof product.brand === "object"
            && !Array.isArray(product.brand)
            && Object.hasOwn(product.brand, "name")
            && typeof product.brand.name === "string";
          const productBrand = productBrandIsString
            ? product.brand
            : productBrandHasName ? product.brand.name : null;
          const brandEvidence = productBrandIsString || productBrandHasName
            ? { complete: true, source: "json-ld-product.brand", raw_brand: productBrand }
            : brandIndex >= 0 && bodyLines[brandIndex + 1]
              ? { complete: true, source: "visible-product-attributes.brand", raw_brand: bodyLines[brandIndex + 1] }
              : { complete: false, source: null, raw_brand: null };
          const breadcrumbText = (breadcrumb?.itemListElement || [])
            .map((row) => row?.item?.name || row?.name || "").filter(Boolean).join(" > ");
          const visibleBreadcrumbText = [...document.querySelectorAll('nav a, [data-widget*="bread" i] a')]
            .map((element) => String(element.textContent || "").trim()).filter(Boolean).join(" > ");
          const categoryEvidence = String(product?.category || "").trim()
            ? { complete: true, source: "json-ld-product.category", text: String(product.category).trim() }
            : breadcrumbText
              ? { complete: true, source: "json-ld-breadcrumb-list", text: breadcrumbText }
              : visibleBreadcrumbText
                ? { complete: true, source: "visible-breadcrumbs", text: visibleBreadcrumbText }
                : { complete: false, source: null, text: null };
          const title = document.querySelector('meta[property="og:title"]')?.content || "";
          const explicitItemCount = Number(product?.numberOfItems);
          const hasExplicitItemCount = Number.isInteger(explicitItemCount) && explicitItemCount > 0;
          const multiItem = /(?:\b(?:комплект|набор|упаковк)\b|\b\d+\s*(?:шт\.?|pcs?|pieces?)\b)/iu
            .test(`${title}\n${categoryEvidence.text || ""}`);
          const sellerSelectors = [
            ["webCurrentSeller", '[data-widget="webCurrentSeller"] a[href*="/seller/"]'],
            ["current-seller-widget", '[data-widget*="CurrentSeller"] a[href*="/seller/"]'],
            ["webSeller", '[data-widget="webSeller"] a[href*="/seller/"]'],
          ];
          let currentSeller = null;
          for (const [source, selector] of sellerSelectors) {
            const anchor = document.querySelector(selector);
            if (anchor?.href) {
              currentSeller = { url: anchor.href, source };
              break;
            }
          }
          const diagnosticSellerUrls = [...document.querySelectorAll('a[href*="/seller/"]')]
            .map((anchor) => anchor.href).filter(Boolean).slice(0, 10);
          return {
            final_url: location.href,
            document_title: document.title,
            title,
            cover_image: document.querySelector('meta[property="og:image"]')?.content || "",
            seller_url: currentSeller?.url || "",
            seller_evidence_source: currentSeller?.source || null,
            diagnostic_seller_urls: diagnosticSellerUrls,
            web_price_text: widget?.innerText || "",
            current_price_node: currentLeaf ? {
              raw_text: currentLeaf.raw_text,
              selector: currentLeaf.selector,
              evidence_source: "webPrice-visible-nonstruck-leaf-v1",
              visible: true,
              line_through: false,
              installment: false,
            } : null,
            excluded_price_nodes: excludedLeaves.map((row) => ({
              raw_text: row.raw_text,
              selector: row.selector,
              visible: true,
              line_through: row.line_through,
              exclusion_reason: row.line_through ? "line-through-old-price" : "installment",
            })),
            follow_price_lines: bodyText.split(/\r?\n/u)
              .map((line) => line.trim())
              .filter((line) => /跟卖最低价[：:]/u.test(line)),
            brand_evidence: brandEvidence,
            category_evidence: categoryEvidence,
            item_evidence: {
              single_item_guard_passed: hasExplicitItemCount ? explicitItemCount === 1 : !multiItem,
              source: hasExplicitItemCount
                ? "json-ld-product.numberOfItems"
                : "live-title-category-no-multipack-terms",
              item_count: hasExplicitItemCount ? explicitItemCount : null,
            },
            diagnostic: bodyText.slice(0, 1500),
          };
        }).catch((error) => {
          if (/(?:execution context was destroyed|cannot find context|frame was detached|navigation)/iu
            .test(String(error?.message || error || ""))) return null;
          throw error;
        });
        const diagnostic = `${snapshot?.document_title || ""} ${snapshot?.diagnostic || ""}`;
        if (/captcha|капч|验证码|验证您/i.test(diagnostic)) throw discoveryError(`live detail ${fact.sku} requires CAPTCHA`);
        if (/войти|登录|手机号|парол/i.test(diagnostic)) throw discoveryError(`live detail ${fact.sku} requires authentication`);
        if (/доступ ограничен|access denied|похоже, нет(?:\s|\u00a0)+соединения|выключите VPN|нет подключения|no connection/i.test(diagnostic)) {
          throw discoveryError(`live detail ${fact.sku} is access-blocked`);
        }
        if (snapshot?.title && snapshot?.cover_image
          && String(snapshot?.web_price_text || "").trim()
          && snapshot?.current_price_node
          && snapshot?.brand_evidence?.complete === true
          && snapshot?.category_evidence?.complete === true
          && snapshot?.item_evidence?.single_item_guard_passed === true) {
          try {
            conservativeLivePriceEvidence({
              webPriceText: snapshot.web_price_text,
              currentPriceNode: snapshot.current_price_node,
              excludedPriceNodes: snapshot.excluded_price_nodes,
              followPriceLines: snapshot.follow_price_lines,
              apiCnyPerRub: providedRate?.cny_per_rub,
            });
            evidenceReady = true;
          } catch {
            evidenceReady = false;
          }
          if (evidenceReady) break;
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))));
      } while (Date.now() < deadline);
      if (!snapshot?.title || !snapshot?.cover_image
        || !String(snapshot?.web_price_text || "").trim()
        || !snapshot?.current_price_node
        || snapshot?.brand_evidence?.complete !== true
        || snapshot?.category_evidence?.complete !== true
        || snapshot?.item_evidence?.single_item_guard_passed !== true
        || !evidenceReady) {
        throw discoveryError(`live detail ${fact.sku} did not expose complete read-only detail evidence`);
      }
      return {
        live: true,
        method: DETAIL_METHOD,
        final_url: snapshot.final_url,
        seller_url: snapshot.seller_url,
        seller_evidence_source: snapshot.seller_evidence_source,
        diagnostic_seller_urls: snapshot.diagnostic_seller_urls,
        title: snapshot.title,
        cover_image: snapshot.cover_image,
        price_field: "web_price_plus_same_page_follow_pair",
        web_price_text: snapshot.web_price_text,
        current_price_node: snapshot.current_price_node,
        excluded_price_nodes: snapshot.excluded_price_nodes,
        follow_price_lines: snapshot.follow_price_lines,
        api_rate_reference: providedRate === null ? null : {
          source: "maozi-current-exchange-rate-api",
          cny_per_rub: Number(providedRate.cny_per_rub),
          observed_at: nonEmpty(providedRate.observed_at, "live detail API rate observed_at"),
        },
        brand_evidence: snapshot.brand_evidence,
        category_evidence: snapshot.category_evidence,
        item_evidence: snapshot.item_evidence,
        price_dom_contract: PRICE_DOM_CONTRACT,
        observed_at: isoNow(now),
      };
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try { await page.close(); }
      catch (closeError) {
        if (operationError) {
          throw new AggregateError(
            [operationError, closeError],
            `${operationError.message}; owned live-detail page close failed: ${closeError?.message || closeError}`,
          );
        }
        throw discoveryError(`owned live-detail page close failed: ${closeError?.message || closeError}`);
      }
    }
  };
}

export function createAuditedLiveDetailAccessAdapter(runWithAccessControl) {
  if (typeof runWithAccessControl !== "function") {
    throw discoveryError("live detail access-control callback is required");
  }
  return Object.freeze({
    contract: LIVE_DETAIL_ACCESS_ADAPTER_CONTRACT,
    run: (request, operation) => runWithAccessControl(Object.freeze({
      kind: "audited-live-detail",
      sku: request.sku,
      url: request.url,
    }), operation),
  });
}

function validateLiveDetailAccessAdapter(adapter) {
  if (adapter?.contract !== LIVE_DETAIL_ACCESS_ADAPTER_CONTRACT || typeof adapter?.run !== "function") {
    throw discoveryError("a live detail access-control adapter is required");
  }
  return adapter;
}

function validateReadOnlyScanAdapter(adapter) {
  if (adapter?.contract !== READ_ONLY_SCAN_ADAPTER_CONTRACT
    || adapter?.favorite_mutations_allowed !== false
    || adapter?.submission_allowed !== false
    || typeof adapter?.scan !== "function") {
    throw discoveryError("a capability-limited read-only source scan adapter is required");
  }
  return adapter;
}

function sourceSetForArtifact(artifact, activeUrls, expectedSourceCount) {
  const expectedCount = positiveInteger(expectedSourceCount, "expected source count");
  const normalized = (activeUrls || []).map(exactAuditedSourceUrl).filter(Boolean);
  if (normalized.length !== expectedCount || new Set(normalized).size !== expectedCount) {
    throw discoveryError(`source set must contain exactly ${expectedCount} distinct exact URLs`);
  }
  const expected = buildAuditedValidationSourcePolicy({
    artifact,
    slots: expectedCount,
    now: artifact.generated_at,
  }).active_urls.map(exactAuditedSourceUrl);
  if (expected.length !== normalized.length
    || expected.some((url, index) => url !== normalized[index])) {
    throw discoveryError("source set does not exactly match the audited artifact policy and order");
  }
  return normalized;
}

export function auditedDiscoveryCampaignDirectory(baseDirectory, campaignEpoch) {
  const base = path.resolve(nonEmpty(baseDirectory, "campaign base directory"));
  const epoch = normalizeEpoch(campaignEpoch);
  return path.join(base, "audited_validation_discovery", `campaign-${sha256(epoch).slice(0, 20)}`);
}

function pathWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

async function auditedFilesystemRoot(rootDirectory) {
  const root = path.resolve(nonEmpty(rootDirectory, "campaign filesystem root"));
  const stat = await fs.lstat(root).catch((error) => {
    throw discoveryError(`campaign filesystem root is unavailable: ${error.message}`);
  });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw discoveryError("campaign filesystem root must be an existing non-symlink directory");
  }
  const real = await fs.realpath(root);
  return Object.freeze({ root, real });
}

async function ensureAuditedDirectory(rootDirectory, directory) {
  const audit = await auditedFilesystemRoot(rootDirectory);
  const target = path.resolve(directory);
  if (!pathWithin(audit.root, target)) throw discoveryError("campaign directory escapes its filesystem root");
  const relative = path.relative(audit.root, target);
  let cursor = audit.root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try { await fs.mkdir(cursor, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw discoveryError(`campaign directory ancestry is not a real directory: ${cursor}`);
    }
    const real = await fs.realpath(cursor);
    if (!pathWithin(audit.real, real)) throw discoveryError("campaign directory realpath escapes its filesystem root");
  }
  return target;
}

async function auditAuditedLeaf(rootDirectory, filename, { required = false } = {}) {
  const audit = await auditedFilesystemRoot(rootDirectory);
  const absolute = path.resolve(filename);
  if (!pathWithin(audit.root, absolute)) throw discoveryError("campaign file escapes its filesystem root");
  await ensureAuditedDirectory(audit.root, path.dirname(absolute));
  try {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw discoveryError(`campaign file must be a single-link regular file: ${absolute}`);
    }
    const real = await fs.realpath(absolute);
    if (!pathWithin(audit.real, real)) throw discoveryError("campaign file realpath escapes its filesystem root");
    return Object.freeze({ exists: true, absolute, stat });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (required) throw discoveryError(`required campaign file is missing: ${absolute}`);
    return Object.freeze({ exists: false, absolute, stat: null });
  }
}

function campaignBaseFromDirectory(directory) {
  const campaign = path.resolve(directory);
  if (!/^campaign-[a-f0-9]{20}$/u.test(path.basename(campaign))
    || path.basename(path.dirname(campaign)) !== "audited_validation_discovery") {
    throw discoveryError("campaign directory does not use the audited derived layout");
  }
  return path.dirname(path.dirname(campaign));
}

async function auditCampaignFiles(baseDirectory, directory, manifest, { manifestRequired = true } = {}) {
  await ensureAuditedDirectory(baseDirectory, directory);
  await auditAuditedLeaf(baseDirectory, path.join(directory, "campaign.json"), { required: manifestRequired });
  for (const key of ["candidate_queue", "provenance", "source_scans", "live_detail_enrichment"]) {
    await auditAuditedLeaf(baseDirectory, path.join(directory, manifest.files[key]));
  }
  await auditAuditedLeaf(baseDirectory, `${path.join(directory, manifest.files.candidate_queue)}.candidate-queue-index-v1.json`);
}

function manifestDocument({ artifact, activeUrls, campaignEpoch, runId, discoveryTarget, createdAt, activatedAt }) {
  const sourceSetSha256 = auditedSourceSetSha256(activeUrls);
  return {
    contract: AUDITED_DISCOVERY_MANIFEST_CONTRACT,
    schema_version: 1,
    run_id: runId,
    campaign_epoch: campaignEpoch,
    created_at: createdAt,
    activated_at: activatedAt,
    deployment_phase: "validation_only",
    automatic_publish_eligible: false,
    favorite_mutations_allowed: false,
    submission_allowed: false,
    artifact_sha256: artifactSha256(artifact),
    artifact_source_path: path.resolve(nonEmpty(artifact.source_path, "artifact source path")),
    source_set_sha256: sourceSetSha256,
    source_count: activeUrls.length,
    active_urls: activeUrls,
    discovery_target: discoveryTarget,
    files: {
      candidate_queue: "candidate_queue.jsonl",
      provenance: "discovery_provenance.jsonl",
      source_scans: "source_scans.jsonl",
      live_detail_enrichment: "live_detail_enrichment.jsonl",
    },
  };
}

function validateManifest(value, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw discoveryError("campaign manifest must be a JSON object");
  }
  if (value.contract !== AUDITED_DISCOVERY_MANIFEST_CONTRACT || Number(value.schema_version) !== 1) {
    throw discoveryError("campaign manifest contract is unsupported");
  }
  if (value.deployment_phase !== "validation_only"
    || value.automatic_publish_eligible !== false
    || value.favorite_mutations_allowed !== false
    || value.submission_allowed !== false) {
    throw discoveryError("campaign manifest mutation/publication guards are invalid");
  }
  const epoch = normalizeEpoch(value.campaign_epoch);
  const runId = normalizeRunId(value.run_id);
  const activatedAt = new Date(nonEmpty(value.activated_at, "manifest activated_at"));
  if (!Number.isFinite(activatedAt.getTime())) throw discoveryError("manifest activated_at is invalid");
  const artifactDigest = nonEmpty(value.artifact_sha256, "manifest artifact SHA256").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(artifactDigest)) throw discoveryError("manifest artifact SHA256 is invalid");
  const activeUrls = (value.active_urls || []).map(exactAuditedSourceUrl).filter(Boolean);
  if (activeUrls.length !== positiveInteger(value.source_count, "manifest source count")
    || new Set(activeUrls).size !== activeUrls.length) {
    throw discoveryError("manifest source set is malformed");
  }
  const sourceSetSha256 = auditedSourceSetSha256(activeUrls);
  if (sourceSetSha256 !== value.source_set_sha256) {
    throw discoveryError("manifest source set SHA256 does not match active_urls");
  }
  if (expected.artifact) {
    const artifactSources = sourceSetForArtifact(
      expected.artifact,
      activeUrls,
      DEFAULT_AUDITED_DISCOVERY_SOURCE_COUNT,
    );
    if (artifactSources.length !== activeUrls.length
      || artifactSources.some((url, index) => url !== activeUrls[index])) {
      throw discoveryError("manifest source set is not the exact artifact-derived ordered 60-URL set");
    }
  }
  const target = auditedDiscoveryTarget(value.discovery_target);
  for (const key of ["candidate_queue", "provenance", "source_scans", "live_detail_enrichment"]) {
    const basename = nonEmpty(value.files?.[key], `manifest files.${key}`);
    if (path.basename(basename) !== basename) throw discoveryError(`manifest files.${key} must be a basename`);
  }
  if (expected.campaignEpoch !== undefined && epoch !== expected.campaignEpoch) {
    throw discoveryError("campaign epoch does not match the requested epoch");
  }
  if (expected.runId !== undefined && runId !== expected.runId) {
    throw discoveryError("campaign run id does not match the requested run");
  }
  if (expected.activatedAt !== undefined && activatedAt.toISOString() !== expected.activatedAt) {
    throw discoveryError("campaign activated_at does not match the requested source-set activation");
  }
  if (expected.artifactSha256 !== undefined && artifactDigest !== expected.artifactSha256) {
    throw discoveryError("campaign artifact SHA256 does not match the loaded artifact");
  }
  if (expected.sourceSetSha256 !== undefined && sourceSetSha256 !== expected.sourceSetSha256) {
    throw discoveryError("campaign source set does not match the requested source set");
  }
  if (expected.discoveryTarget !== undefined && target !== expected.discoveryTarget) {
    throw discoveryError("campaign discovery target cannot change within an epoch");
  }
  return Object.freeze({
    ...value,
    run_id: runId,
    campaign_epoch: epoch,
    activated_at: activatedAt.toISOString(),
    artifact_sha256: artifactDigest,
    active_urls: Object.freeze(activeUrls),
    source_set_sha256: sourceSetSha256,
    discovery_target: target,
    files: Object.freeze({ ...value.files }),
  });
}

async function writeJsonAtomic(filename, value, containmentRoot = null) {
  const absolute = path.resolve(filename);
  const temporary = `${absolute}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  if (containmentRoot) {
    await auditAuditedLeaf(containmentRoot, absolute);
    await auditAuditedLeaf(containmentRoot, temporary);
  } else {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const existing = await fs.lstat(absolute).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)) {
      throw discoveryError(`output must be a single-link regular file: ${absolute}`);
    }
  }
  let handle;
  try {
    handle = await fs.open(temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    const written = await handle.stat();
    if (!written.isFile() || written.nlink !== 1) throw discoveryError("atomic output temporary is not a single-link regular file");
    await handle.close();
    handle = null;
    await fs.rename(temporary, absolute);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function appendJsonLines(filename, rows, containmentRoot = null) {
  if (!rows.length) return;
  const absolute = path.resolve(filename);
  if (containmentRoot) await auditAuditedLeaf(containmentRoot, absolute);
  else await fs.mkdir(path.dirname(absolute), { recursive: true });
  const handle = await fs.open(absolute,
    fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw discoveryError("append target is not a single-link regular file");
    await handle.writeFile(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

async function readJsonLinesStrict(filename, label) {
  let text;
  try { text = await fs.readFile(filename, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const rows = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch (error) {
      throw discoveryError(`${label} line ${index + 1} is invalid JSON: ${error.message}`);
    }
  }
  return rows;
}

export async function createOrLoadAuditedDiscoveryCampaign({
  baseDirectory,
  artifact,
  activeUrls,
  campaignEpoch,
  runId,
  discoveryTarget = DEFAULT_AUDITED_DISCOVERY_TARGET,
  expectedSourceCount = DEFAULT_AUDITED_DISCOVERY_SOURCE_COUNT,
  activatedAt = null,
  now = () => new Date(),
} = {}) {
  assertValidationOnlyArtifact(artifact);
  const epoch = normalizeEpoch(campaignEpoch);
  const normalizedRunId = normalizeRunId(runId);
  const target = auditedDiscoveryTarget(discoveryTarget);
  const sources = sourceSetForArtifact(artifact, activeUrls, expectedSourceCount);
  const campaignRoot = path.resolve(nonEmpty(baseDirectory, "campaign base directory"));
  await auditedFilesystemRoot(campaignRoot);
  const directory = auditedDiscoveryCampaignDirectory(baseDirectory, epoch);
  const manifestFile = path.join(directory, "campaign.json");
  const createdAt = isoNow(now);
  const normalizedActivatedAt = activatedAt === null || activatedAt === undefined
    ? createdAt
    : new Date(nonEmpty(activatedAt, "campaign activated_at")).toISOString();
  if (Date.parse(normalizedActivatedAt) > Date.parse(createdAt) + LIVE_DETAIL_FUTURE_SKEW_MS) {
    throw discoveryError("campaign activated_at is implausibly after manifest creation");
  }
  const requested = manifestDocument({
    artifact,
    activeUrls: sources,
    campaignEpoch: epoch,
    runId: normalizedRunId,
    discoveryTarget: target,
    createdAt,
    activatedAt: normalizedActivatedAt,
  });
  await ensureAuditedDirectory(campaignRoot, directory);
  const existingManifest = await auditAuditedLeaf(campaignRoot, manifestFile);
  try {
    if (!existingManifest.exists) {
      const handle = await fs.open(manifestFile,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600);
      try {
        await handle.writeFile(`${JSON.stringify(requested, null, 2)}\n`, "utf8");
        const written = await handle.stat();
        if (!written.isFile() || written.nlink !== 1) throw discoveryError("campaign manifest is not a single-link regular file");
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await auditAuditedLeaf(campaignRoot, manifestFile, { required: true });
  let loaded;
  try { loaded = JSON.parse(await fs.readFile(manifestFile, "utf8")); }
  catch (error) { throw discoveryError(`campaign manifest could not be loaded: ${error.message}`); }
  const manifest = validateManifest(loaded, {
    artifact,
    campaignEpoch: epoch,
    runId: normalizedRunId,
    activatedAt: normalizedActivatedAt,
    artifactSha256: requested.artifact_sha256,
    sourceSetSha256: requested.source_set_sha256,
    discoveryTarget: target,
  });
  if (path.resolve(manifest.artifact_source_path) !== requested.artifact_source_path) {
    throw discoveryError("campaign artifact source path cannot change within an epoch");
  }
  await auditCampaignFiles(campaignRoot, directory, manifest);
  return Object.freeze({ baseDirectory: campaignRoot, directory, manifestFile, manifest });
}

function fileFor(campaign, key) {
  return path.join(campaign.directory, campaign.manifest.files[key]);
}

function factBinding(row) {
  return [row.seller_url, row.category_key, row.target_id, row.accessory_role || ""].join("\0");
}

function validateFact(row, manifest, artifact, {
  nowMs = Date.now(),
  futureSkewMs = LIVE_DETAIL_FUTURE_SKEW_MS,
} = {}) {
  if (row?.contract !== AUDITED_DISCOVERY_FACT_CONTRACT
    || row.evidence_scope !== "audited-validation-bootstrap") {
    throw discoveryError("provenance fact contract or evidence scope is invalid");
  }
  if (row.campaign_epoch !== manifest.campaign_epoch
    || row.run_id !== manifest.run_id
    || row.artifact_sha256 !== manifest.artifact_sha256
    || row.source_set_sha256 !== manifest.source_set_sha256
    || row.activated_at !== manifest.activated_at) {
    throw discoveryError(`provenance fact ${row?.sku || "<unknown>"} is outside the current campaign binding`);
  }
  const discoveredAt = new Date(nonEmpty(row.discovered_at, "provenance fact discovered_at"));
  if (!Number.isFinite(discoveredAt.getTime())) throw discoveryError("provenance fact discovered_at is invalid");
  if (discoveredAt.getTime() < Date.parse(manifest.activated_at)) {
    throw discoveryError("provenance fact discovered_at predates campaign activation");
  }
  if (discoveredAt.getTime() > Number(nowMs) + Math.max(0, Number(futureSkewMs) || 0)) {
    throw discoveryError("provenance fact discovered_at is implausibly in the future");
  }
  const sku = normalizeSku(row.sku, "provenance fact sku");
  const href = exactOzonProductUrl(row.href, `provenance fact ${sku} href`);
  if (skuFromProductUrl(href) !== sku) throw discoveryError(`provenance fact ${sku} href/SKU mismatch`);
  const sourceUrl = exactAuditedSourceUrl(row.source_url);
  if (!manifest.active_urls.includes(sourceUrl)) throw discoveryError(`provenance fact ${sku} source is not in the campaign source set`);
  const eligibility = auditedCandidateEligibility(row, artifact, { activeUrls: manifest.active_urls });
  if (!eligibility.eligible) throw discoveryError(`provenance fact ${sku} is no longer eligible: ${eligibility.reason}`);
  if (row.target_id !== eligibility.target.id
    || row.category_key !== eligibility.target.category_key
    || row.seller_url !== eligibility.target.seller_url
    || (row.accessory_role ?? null) !== (eligibility.target.accessory_role ?? null)) {
    throw discoveryError(`provenance fact ${sku} seller/category/accessory-role binding does not match the artifact`);
  }
  return Object.freeze({
    ...row,
    discovered_at: discoveredAt.toISOString(),
    sku,
    href,
    source_url: sourceUrl,
    seller_url: eligibility.target.seller_url,
    target_id: eligibility.target.id,
    category_key: eligibility.target.category_key,
  });
}

function cardPriceObservations(value) {
  const text = String(value || "");
  const observations = [];
  const expression = /(?:([¥￥₽₸])\s*([0-9](?:[0-9\s\u00a0\u2009\u202f.,]*[0-9])?)|([0-9](?:[0-9\s\u00a0\u2009\u202f.,]*[0-9])?)\s*([¥￥₽₸]))/gu;
  for (const match of text.matchAll(expression)) {
    const symbol = match[1] || match[4];
    const rawAmount = match[2] || match[3];
    const amount = parseLocalizedPriceNumber(rawAmount);
    if (!(amount > 0)) continue;
    observations.push({
      amount,
      currency: ["¥", "￥"].includes(symbol) ? "CNY" : symbol === "₸" ? "KZT" : "RUB",
      raw: match[0],
      candidate_price_eligible: false,
      reason: "listing-card-price-is-not-live-detail-evidence",
    });
  }
  return observations;
}

export function normalizeAuditedDiscoveryFact({
  link,
  sourceUrl,
  artifact,
  manifest,
  at = new Date().toISOString(),
} = {}) {
  const source = exactAuditedSourceUrl(sourceUrl);
  if (!manifest.active_urls.includes(source)) throw discoveryError("scan source is outside the campaign source set");
  const href = exactOzonProductUrl(typeof link === "string" ? link : link?.href, "discovered product href");
  const sku = normalizeSku((typeof link === "object" && link?.sku) || skuFromProductUrl(href), "discovered sku");
  if (skuFromProductUrl(href) !== sku) throw discoveryError(`discovered SKU ${sku} does not match its href`);
  const title = nonEmpty(
    typeof link === "object" ? (link?.title || link?.text) : "",
    `discovered SKU ${sku} title`,
  );
  const cardText = String(typeof link === "object" ? link?.card_text || "" : "");
  const eligibilityInput = { sku, source_url: source, title, text: title, card_text: cardText };
  const eligibility = auditedCandidateEligibility(eligibilityInput, artifact, { activeUrls: manifest.active_urls });
  if (!eligibility.eligible) return { eligible: false, reason: eligibility.reason, fact: null };
  let imageUrl = null;
  if (typeof link === "object" && String(link?.image_url || "").trim()) {
    try { imageUrl = trustedOzonImageUrl(link.image_url, `discovered SKU ${sku} card image`); }
    catch { imageUrl = null; }
  }
  const observedAt = new Date(at).toISOString();
  return {
    eligible: true,
    reason: null,
    fact: Object.freeze({
      contract: AUDITED_DISCOVERY_FACT_CONTRACT,
      at: observedAt,
      discovered_at: observedAt,
      activated_at: manifest.activated_at,
      run_id: manifest.run_id,
      campaign_epoch: manifest.campaign_epoch,
      artifact_sha256: manifest.artifact_sha256,
      source_set_sha256: manifest.source_set_sha256,
      sku,
      href,
      source_url: source,
      source_set_position: manifest.active_urls.indexOf(source),
      seller_url: eligibility.target.seller_url,
      target_id: eligibility.target.id,
      category_key: eligibility.target.category_key,
      accessory_role: eligibility.target.accessory_role ?? null,
      tier: eligibility.target.tier,
      role: eligibility.target.role,
      evidence_scope: "audited-validation-bootstrap",
      title,
      card_image_url: imageUrl,
      card_text: cardText.slice(0, 1000),
      card_price_observations: cardPriceObservations(cardText),
      requires_live_detail_enrichment: true,
    }),
  };
}

function factsBySku(rows, manifest, artifact, options = {}) {
  const grouped = new Map();
  for (const row of rows || []) {
    const fact = validateFact(row, manifest, artifact, options);
    const values = grouped.get(fact.sku) || [];
    values.push(fact);
    grouped.set(fact.sku, values);
  }
  return grouped;
}

function unambiguousDiscoveryCount(grouped) {
  let count = 0;
  for (const rows of grouped.values()) {
    if (new Set(rows.map(factBinding)).size === 1) count += 1;
  }
  return count;
}

function validateScan(row, manifest) {
  if (row?.contract !== AUDITED_DISCOVERY_SCAN_CONTRACT
    || row.run_id !== manifest.run_id
    || row.campaign_epoch !== manifest.campaign_epoch
    || row.artifact_sha256 !== manifest.artifact_sha256
    || row.source_set_sha256 !== manifest.source_set_sha256) {
    throw discoveryError("source scan event is outside the current campaign binding");
  }
  const sourceUrl = exactAuditedSourceUrl(row.source_url);
  if (!manifest.active_urls.includes(sourceUrl)) throw discoveryError("source scan event URL is outside the source set");
  if (!["completed", "failed"].includes(row.status)) throw discoveryError("source scan event status is invalid");
  return { ...row, source_url: sourceUrl };
}

function completedSourceSet(rows, manifest) {
  const latest = new Map();
  for (const row of rows || []) {
    const event = validateScan(row, manifest);
    latest.set(event.source_url, event);
  }
  return new Set([...latest].filter(([, row]) => row.status === "completed").map(([url]) => url));
}

function queueLinkForFact(fact) {
  return {
    sku: fact.sku,
    href: fact.href,
    source_url: fact.source_url,
    text: fact.title,
    title: fact.title,
    image_url: fact.card_image_url,
    card_text: fact.card_text,
    run_id: fact.run_id,
    audited_artifact_sha256: fact.artifact_sha256,
    source_set_sha256: fact.source_set_sha256,
    source_set_epoch: /^\d+$/u.test(fact.campaign_epoch)
      ? Number(fact.campaign_epoch)
      : fact.campaign_epoch,
    source_set_activated_at: fact.activated_at,
    discovered_at: fact.discovered_at,
    evidence_scope: fact.evidence_scope,
    accessory_role: fact.accessory_role,
  };
}

export async function runAuditedValidationDiscovery({
  baseDirectory,
  artifact,
  activeUrls,
  campaignEpoch,
  runId,
  discoveryTarget = DEFAULT_AUDITED_DISCOVERY_TARGET,
  expectedSourceCount = DEFAULT_AUDITED_DISCOVERY_SOURCE_COUNT,
  activatedAt = null,
  env = {},
  scanAdapter,
  concurrency = 4,
  now = () => new Date(),
  onProgress = () => {},
} = {}) {
  assertAuditedDiscoveryOnlyScope(env, artifact);
  const readOnlyScanner = validateReadOnlyScanAdapter(scanAdapter);
  const campaign = await createOrLoadAuditedDiscoveryCampaign({
    baseDirectory,
    artifact,
    activeUrls,
    campaignEpoch,
    runId,
    discoveryTarget,
    expectedSourceCount,
    activatedAt,
    now,
  });
  const provenanceFile = fileFor(campaign, "provenance");
  const scansFile = fileFor(campaign, "source_scans");
  const queueFile = fileFor(campaign, "candidate_queue");
  const queueIndexFile = `${queueFile}.candidate-queue-index-v1.json`;
  await auditCampaignFiles(campaign.baseDirectory, campaign.directory, campaign.manifest);
  const queue = createCandidateQueue(queueFile, { now, indexFile: queueIndexFile });
  await queue.load();
  await auditAuditedLeaf(campaign.baseDirectory, queueFile);
  await auditAuditedLeaf(campaign.baseDirectory, queueIndexFile);
  const existingFacts = await readJsonLinesStrict(provenanceFile, "discovery provenance");
  const grouped = factsBySku(existingFacts, campaign.manifest, artifact);
  const existingScans = await readJsonLinesStrict(scansFile, "source scans");
  const completed = completedSourceSet(existingScans, campaign.manifest);
  const pending = campaign.manifest.active_urls.filter((url) => !completed.has(url));
  const workerCount = auditedConcurrency(concurrency, "discovery concurrency");
  let eligibleUnique = unambiguousDiscoveryCount(grouped);
  let scannedThisRun = 0;
  let discoveredThisRun = 0;
  for (let start = 0; start < pending.length && eligibleUnique < campaign.manifest.discovery_target; start += workerCount) {
    const batch = pending.slice(start, start + workerCount);
    const results = await Promise.all(batch.map(async (sourceUrl, index) => {
      try {
        const result = await readOnlyScanner.scan({ sourceUrl, sourceIndex: start + index });
        return { sourceUrl, result, error: null };
      } catch (error) {
        return { sourceUrl, result: null, error };
      }
    }));
    for (const entry of results) {
      const at = isoNow(now);
      const redirect = entry.result ? auditedSourceRedirectEligibility(
        entry.sourceUrl,
        entry.result?.final_url,
        artifact,
        { activeUrls: campaign.manifest.active_urls, slots: campaign.manifest.source_count },
      ) : { eligible: false, reason: "audited-source-result-missing" };
      const blocked = Boolean(entry.result?.blocked);
      const stopReason = String(entry.result?.stop_reason || "");
      const rawLinkCount = Array.isArray(entry.result?.links) ? entry.result.links.length : 0;
      const retryableEmpty = rawLinkCount === 0
        && !/^(?:terminal-zero|verified-empty)$/iu.test(stopReason);
      const failed = Boolean(entry.error) || blocked || !redirect.eligible || retryableEmpty
        || /^(?:error:|timeout\b)|soft block|access denied|captcha|authentication required/iu.test(stopReason);
      const normalizedFacts = [];
      if (!failed) {
        for (const link of entry.result?.links || []) {
          let normalized;
          try {
            normalized = normalizeAuditedDiscoveryFact({
              link,
              sourceUrl: redirect.source_url,
              artifact,
              manifest: campaign.manifest,
              at,
            });
          } catch {
            continue;
          }
          if (normalized.eligible) normalizedFacts.push(normalized.fact);
        }
      }
      const uniqueFacts = [...new Map(normalizedFacts.map((fact) => [
        `${fact.sku}\0${factBinding(fact)}\0${fact.source_url}`,
        fact,
      ])).values()];
      if (uniqueFacts.length) {
        await appendJsonLines(provenanceFile, uniqueFacts, campaign.baseDirectory);
        await auditAuditedLeaf(campaign.baseDirectory, queueFile);
        await auditAuditedLeaf(campaign.baseDirectory, queueIndexFile);
        await queue.discover(uniqueFacts.map(queueLinkForFact));
        await auditAuditedLeaf(campaign.baseDirectory, queueFile, { required: true });
        await auditAuditedLeaf(campaign.baseDirectory, queueIndexFile, { required: true });
        for (const fact of uniqueFacts) {
          const rows = grouped.get(fact.sku) || [];
          rows.push(fact);
          grouped.set(fact.sku, rows);
        }
        discoveredThisRun += uniqueFacts.length;
      }
      const scanEvent = {
        contract: AUDITED_DISCOVERY_SCAN_CONTRACT,
        at,
        run_id: campaign.manifest.run_id,
        campaign_epoch: campaign.manifest.campaign_epoch,
        artifact_sha256: campaign.manifest.artifact_sha256,
        source_set_sha256: campaign.manifest.source_set_sha256,
        source_url: entry.sourceUrl,
        status: failed ? "failed" : "completed",
        stop_reason: String(
          entry.error?.message
          || (!redirect.eligible ? `audited-source-rejected:${redirect.reason}` : "")
          || stopReason,
        ).slice(0, 500) || null,
        raw_link_count: rawLinkCount,
        eligible_fact_count: uniqueFacts.length,
        favorite_mutations: 0,
        orchestrator_submission_calls: 0,
        network_submission_attempts_observed: null,
      };
      await appendJsonLines(scansFile, [scanEvent], campaign.baseDirectory);
      scannedThisRun += 1;
      if (!failed) completed.add(entry.sourceUrl);
      eligibleUnique = unambiguousDiscoveryCount(grouped);
      try {
        onProgress({
          phase: "audited-discovery-source-completed",
          source_url: entry.sourceUrl,
          status: scanEvent.status,
          eligible_unique: eligibleUnique,
          target: campaign.manifest.discovery_target,
        });
      } catch {}
      if (entry.error && isAuditedManualAttentionError(entry.error)) throw entry.error;
    }
  }
  const allSourcesCompleted = completed.size === campaign.manifest.active_urls.length;
  const targetReached = eligibleUnique >= campaign.manifest.discovery_target;
  return Object.freeze({
    mode: "audited-validation-discovery-only",
    campaign_directory: campaign.directory,
    manifest_file: campaign.manifestFile,
    candidate_queue_file: fileFor(campaign, "candidate_queue"),
    provenance_file: provenanceFile,
    source_scans_file: scansFile,
    campaign_epoch: campaign.manifest.campaign_epoch,
    run_id: campaign.manifest.run_id,
    artifact_sha256: campaign.manifest.artifact_sha256,
    source_set_sha256: campaign.manifest.source_set_sha256,
    discovery_target: campaign.manifest.discovery_target,
    eligible_unique: eligibleUnique,
    sources_completed: completed.size,
    source_count: campaign.manifest.active_urls.length,
    scanned_this_run: scannedThisRun,
    discovered_this_run: discoveredThisRun,
    target_reached: targetReached,
    all_sources_completed: allSourcesCompleted,
    stop_reason: targetReached ? "discovery_target_reached" : allSourcesCompleted ? "all_sources_completed" : "retryable_source_failures_remain",
    favorite_mutations: 0,
    orchestrator_submission_calls: 0,
    network_submission_attempts_observed: null,
  });
}

function explicitCurrencyPrices(priceText, symbols) {
  const rawText = String(priceText || "").trim();
  const values = [];
  const symbolPattern = symbols === "RUB" ? "₽" : "¥￥";
  const expression = new RegExp(
    `(?:([${symbolPattern}])\\s*([0-9](?:[0-9\\s\\u00a0\\u2009\\u202f.,]*[0-9])?)|([0-9](?:[0-9\\s\\u00a0\\u2009\\u202f.,]*[0-9])?)\\s*([${symbolPattern}]))`,
    "gu",
  );
  for (const match of rawText.matchAll(expression)) {
    const rawAmount = match[2] || match[3];
    const value = parseLocalizedPriceNumber(rawAmount);
    if (value > 0) values.push(value);
  }
  const distinct = [...new Set(values.map((value) => value.toFixed(6)))].map(Number);
  return Object.freeze({
    amounts: Object.freeze(distinct),
    occurrence_count: values.length,
    raw_price_text: rawText,
    parse_rule: `all-distinct-explicit-${symbols.toLowerCase()}-locale-v4`,
    numeric_rule: "1-2 trailing digits are decimals; a lone 3-digit separator group is thousands; mixed separators use the last separator as decimal",
  });
}

function explicitCurrencyPrice(priceText, symbols) {
  const parsed = explicitCurrencyPrices(priceText, symbols);
  if (parsed.amounts.length !== 1 || parsed.occurrence_count !== 1) return null;
  return {
    amount: parsed.amounts[0],
    raw_price_text: parsed.raw_price_text,
    parse_rule: `single-distinct-explicit-${symbols.toLowerCase()}-locale-v3`,
    numeric_rule: parsed.numeric_rule,
    occurrence_count: parsed.occurrence_count,
  };
}

function nearlyEqual(left, right, tolerance = 0.011) {
  return Number.isFinite(Number(left))
    && Number.isFinite(Number(right))
    && Math.abs(Number(left) - Number(right)) <= tolerance;
}

function normalizeCurrentPriceNode(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.evidence_source !== "webPrice-visible-nonstruck-leaf-v1"
    || value.visible !== true
    || value.line_through !== false
    || value.installment !== false) {
    throw discoveryError("live detail current price must be one visible, non-struck, non-installment webPrice leaf");
  }
  return Object.freeze({
    raw_text: nonEmpty(value.raw_text, "live detail current price raw_text"),
    selector: nonEmpty(value.selector, "live detail current price selector"),
    evidence_source: value.evidence_source,
    visible: true,
    line_through: false,
    installment: false,
  });
}

function normalizeExcludedPriceNodes(values = []) {
  if (!Array.isArray(values)) throw discoveryError("live detail excluded price nodes must be an array");
  return Object.freeze(values.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || value.visible !== true
      || (value.line_through !== true && value.exclusion_reason !== "installment")) {
      throw discoveryError(`live detail excluded price node ${index + 1} is not proven old/struck or installment`);
    }
    return Object.freeze({
      raw_text: nonEmpty(value.raw_text, `live detail excluded price node ${index + 1} raw_text`),
      selector: nonEmpty(value.selector, `live detail excluded price node ${index + 1} selector`),
      visible: true,
      line_through: value.line_through === true,
      exclusion_reason: value.line_through === true ? "line-through-old-price" : "installment",
    });
  }));
}

function conservativeLivePriceEvidence({
  webPriceText,
  currentPriceNode,
  excludedPriceNodes = [],
  followPriceLines,
  apiCnyPerRub = null,
}) {
  const rawWebPriceText = nonEmpty(webPriceText, "live detail webPriceText");
  const currentNode = normalizeCurrentPriceNode(currentPriceNode);
  const excludedNodes = normalizeExcludedPriceNodes(excludedPriceNodes);
  if (!rawWebPriceText.includes(currentNode.raw_text)
    || excludedNodes.some((node) => !rawWebPriceText.includes(node.raw_text))) {
    throw discoveryError("live detail structured price nodes are not present in raw webPrice text");
  }
  const lines = (followPriceLines || []).map((line) => String(line || "").trim()).filter(Boolean);
  if (lines.length > 1) throw discoveryError("live detail has multiple follow-price conversion lines");
  const followLine = lines[0] || "";
  if (followLine && !/跟卖最低价[：:]/u.test(followLine)) {
    throw discoveryError("live detail follow-price evidence is not the exact Maozi 跟卖最低价 line");
  }
  const currentCny = explicitCurrencyPrice(currentNode.raw_text, "CNY");
  const currentRub = explicitCurrencyPrice(currentNode.raw_text, "RUB");
  if (Boolean(currentCny) === Boolean(currentRub)) {
    throw discoveryError("live detail structured current node must contain one unambiguous CNY or RUB price");
  }
  const widgetRub = explicitCurrencyPrices(rawWebPriceText, "RUB");
  const widgetCny = explicitCurrencyPrices(rawWebPriceText, "CNY");
  const followCny = followLine ? explicitCurrencyPrice(followLine, "CNY") : null;
  const followRub = followLine ? explicitCurrencyPrice(followLine, "RUB") : null;
  if (followLine && (!followCny || !followRub || !/(?:≈|~|=)/u.test(followLine))) {
    throw discoveryError("live detail follow-price line must contain one explicit RUB≈CNY pair");
  }
  if (currentRub && !followLine) {
    throw discoveryError("RUB webPriceText requires a same-page explicit Maozi RUB≈CNY pair");
  }
  // Production pricing is intentionally fed only the DOM-proven current leaf.
  // Old/struck/installment leaves are retained as evidence but never priced.
  const parsed = parseOzonDetailText(followLine, null, currentNode.raw_text);
  if (!(parsed.selected_price > 0)) throw discoveryError("production Ozon price parser produced no conservative selected price");
  if (currentCny && !nearlyEqual(parsed.current_price, currentCny.amount)) {
    throw discoveryError("production Ozon price parser disagrees with the explicit webPrice CNY value");
  }
  if (currentRub && !nearlyEqual(parsed.current_price_rub, currentRub.amount)) {
    throw discoveryError("production Ozon price parser disagrees with the explicit webPrice RUB value");
  }
  if (followLine && (
    !nearlyEqual(parsed.follow_min, followCny.amount)
    || !nearlyEqual(parsed.follow_min_rub, followRub.amount)
  )) {
    throw discoveryError("production Ozon price parser disagrees with the exact follow-price pair");
  }
  if (followLine) {
    const currentApiRate = Number(apiCnyPerRub);
    const observedPairRate = followCny.amount / followRub.amount;
    const relativeDrift = Math.abs(observedPairRate - currentApiRate) / currentApiRate;
    if (!(currentApiRate >= 0.03 && currentApiRate <= 0.2)
      || !Number.isFinite(relativeDrift)
      || relativeDrift > MAX_API_RATE_RELATIVE_DRIFT) {
      throw discoveryError("same-page RUB≈CNY pair does not match the current Maozi exchange-rate API");
    }
  }
  if (currentRub) {
    const recomputedRate = followRub.amount / followCny.amount;
    if (!(recomputedRate >= 5 && recomputedRate <= 30)
      || !nearlyEqual(parsed.observed_cny_rub_rate, recomputedRate, 0.000002)
      || !nearlyEqual(parsed.current_price, currentRub.amount / recomputedRate)) {
      throw discoveryError("same-page RUB≈CNY rate is missing, implausible, or inconsistent");
    }
  }
  const conservativeValues = [parsed.current_price, parsed.follow_min].filter((value) => Number(value) > 0);
  const recomputedSelected = Math.round(Math.min(...conservativeValues) * 100) / 100;
  if (!nearlyEqual(parsed.selected_price, recomputedSelected)) {
    throw discoveryError("production Ozon selected price is not the conservative current/follow minimum");
  }
  return Object.freeze({
    raw_web_price_text: rawWebPriceText,
    current_price_node: currentNode,
    excluded_price_nodes: excludedNodes,
    widget_explicit_rub_values: widgetRub.amounts,
    widget_explicit_cny_values: widgetCny.amounts,
    raw_follow_price_line: followLine || null,
    parsed: Object.freeze({
      current_price: parsed.current_price,
      current_price_rub: parsed.current_price_rub,
      follow_min: parsed.follow_min,
      follow_min_rub: parsed.follow_min_rub,
      observed_cny_rub_rate: parsed.observed_cny_rub_rate,
      selected_price: parsed.selected_price,
    }),
    selection_basis: parsed.follow_min !== null
      ? "minimum-of-live-current-and-follow"
      : "live-current-only",
    rate_basis: followLine
      ? "same-page-maozi-follow-pair-checked-against-current-api"
      : "not-required-explicit-cny-current",
  });
}

const NO_BRAND_PATTERN = /^(?:нет бренда|без бренда|no\s*brand|unbranded|generic|oem|не указан(?:о)?|not specified)$/iu;
const MULTI_ITEM_PATTERN = /(?:\b(?:комплект|набор|упаковк)\b|\b\d+\s*(?:шт\.?|pcs?|pieces?)\b)/iu;

function normalizeLiveIdentityEvidence(observation, title, fact, manifest, artifact) {
  const brand = observation?.brand_evidence;
  if (!brand || typeof brand !== "object" || Array.isArray(brand)
    || brand.complete !== true
    || !["json-ld-product.brand", "visible-product-attributes.brand"].includes(brand.source)) {
    throw discoveryError(`live detail ${fact.sku} lacks complete structured brand evidence`);
  }
  const rawBrand = String(brand.raw_brand ?? "").trim();
  if (rawBrand && !NO_BRAND_PATTERN.test(rawBrand)) {
    throw discoveryError(`live detail ${fact.sku} declares a brand and is not eligible for unbranded validation`);
  }
  const category = observation?.category_evidence;
  if (!category || typeof category !== "object" || Array.isArray(category)
    || category.complete !== true
    || !["json-ld-product.category", "json-ld-breadcrumb-list", "visible-breadcrumbs"].includes(category.source)) {
    throw discoveryError(`live detail ${fact.sku} lacks complete structured category evidence`);
  }
  const categoryText = nonEmpty(category.text, `live detail ${fact.sku} category evidence text`);
  const categoryEligibility = auditedCandidateEligibility({
    sku: fact.sku,
    source_url: fact.source_url,
    title: categoryText,
  }, artifact, { activeUrls: manifest.active_urls });
  if (!categoryEligibility.eligible
    || categoryEligibility.target.id !== fact.target_id
    || categoryEligibility.target.category_key !== fact.category_key
    || categoryEligibility.target.seller_url !== fact.seller_url) {
    throw discoveryError(`live detail ${fact.sku} category evidence does not bind the audited target`);
  }
  const item = observation?.item_evidence;
  if (!item || typeof item !== "object" || Array.isArray(item)
    || item.single_item_guard_passed !== true
    || !["json-ld-product.numberOfItems", "live-title-category-no-multipack-terms"].includes(item.source)) {
    throw discoveryError(`live detail ${fact.sku} lacks a passing single-item evidence guard`);
  }
  const itemCount = item.item_count === null || item.item_count === undefined
    ? null
    : Number(item.item_count);
  if ((itemCount !== null && itemCount !== 1) || MULTI_ITEM_PATTERN.test(`${title}\n${categoryText}`)) {
    throw discoveryError(`live detail ${fact.sku} appears to be a bundle or multi-item offer`);
  }
  return Object.freeze({
    brand: Object.freeze({ complete: true, source: brand.source, raw_brand: rawBrand || null }),
    category: Object.freeze({ complete: true, source: category.source, text: categoryText }),
    item: Object.freeze({ single_item_guard_passed: true, source: item.source, item_count: itemCount }),
  });
}

export function normalizeAuditedLiveDetailObservation({
  fact,
  observation,
  manifest,
  artifact,
  now = () => new Date(),
  futureSkewMs = LIVE_DETAIL_FUTURE_SKEW_MS,
} = {}) {
  const validatedFact = validateFact(fact, manifest, artifact);
  if (observation?.live !== true || observation?.method !== DETAIL_METHOD) {
    throw discoveryError(`live detail ${validatedFact.sku} must use ${DETAIL_METHOD}`);
  }
  const finalUrl = exactOzonProductUrl(observation.final_url, `live detail ${validatedFact.sku} final_url`);
  if (skuFromProductUrl(finalUrl) !== validatedFact.sku) {
    throw discoveryError(`live detail ${validatedFact.sku} final URL does not match the SKU`);
  }
  const observedCurrentSellerUrl = String(observation.seller_url || "").trim()
    ? exactOzonSellerRoot(observation.seller_url, `live detail ${validatedFact.sku} observed seller`)
    : null;
  const observedCurrentSellerEvidenceSource = observedCurrentSellerUrl
    ? nonEmpty(observation.seller_evidence_source, `live detail ${validatedFact.sku} observed seller evidence source`)
    : null;
  if (observedCurrentSellerEvidenceSource !== null
    && !["webCurrentSeller", "current-seller-widget", "webSeller"].includes(observedCurrentSellerEvidenceSource)) {
    throw discoveryError(`live detail ${validatedFact.sku} observed seller is not from an explicit current-seller widget`);
  }
  if (!observedCurrentSellerUrl && observation.seller_evidence_source !== null
    && observation.seller_evidence_source !== undefined
    && String(observation.seller_evidence_source).trim() !== "") {
    throw discoveryError(`live detail ${validatedFact.sku} seller evidence source has no canonical seller URL`);
  }
  if (observation.price_field !== "web_price_plus_same_page_follow_pair") {
    throw discoveryError(`live detail ${validatedFact.sku} must use live webPrice plus same-page follow-pair evidence`);
  }
  if (observation.price_dom_contract !== PRICE_DOM_CONTRACT) {
    throw discoveryError(`live detail ${validatedFact.sku} must carry the audited current-price DOM contract`);
  }
  const rateReference = observation.api_rate_reference === null
    || observation.api_rate_reference === undefined
    ? null
    : {
      source: nonEmpty(observation.api_rate_reference.source, "live detail API rate source"),
      cny_per_rub: Number(observation.api_rate_reference.cny_per_rub),
      observed_at: new Date(nonEmpty(
        observation.api_rate_reference.observed_at,
        "live detail API rate observed_at",
      )),
    };
  if (rateReference && (rateReference.source !== "maozi-current-exchange-rate-api"
    || !(rateReference.cny_per_rub >= 0.03 && rateReference.cny_per_rub <= 0.2)
    || !Number.isFinite(rateReference.observed_at.getTime()))) {
    throw discoveryError(`live detail ${validatedFact.sku} API rate reference is invalid`);
  }
  const priceEvidence = conservativeLivePriceEvidence({
    webPriceText: observation.web_price_text,
    currentPriceNode: observation.current_price_node,
    excludedPriceNodes: observation.excluded_price_nodes,
    followPriceLines: observation.follow_price_lines,
    apiCnyPerRub: rateReference?.cny_per_rub,
  });
  const title = nonEmpty(observation.title, `live detail ${validatedFact.sku} title`);
  const identityEvidence = normalizeLiveIdentityEvidence(
    observation,
    title,
    validatedFact,
    manifest,
    artifact,
  );
  const liveTitleEligibility = auditedCandidateEligibility({
    sku: validatedFact.sku,
    source_url: validatedFact.source_url,
    title,
  }, artifact, { activeUrls: manifest.active_urls });
  if (!liveTitleEligibility.eligible
    || liveTitleEligibility.target.id !== validatedFact.target_id
    || liveTitleEligibility.target.category_key !== validatedFact.category_key
    || (liveTitleEligibility.target.accessory_role ?? null) !== (validatedFact.accessory_role ?? null)
    || liveTitleEligibility.target.seller_url !== validatedFact.seller_url) {
    throw discoveryError(`live detail ${validatedFact.sku} title no longer matches the exact audited target: ${liveTitleEligibility.reason || "target-mismatch"}`);
  }
  const coverImage = trustedOzonImageUrl(observation.cover_image, `live detail ${validatedFact.sku} cover image`);
  const observedAt = new Date(nonEmpty(observation.observed_at, `live detail ${validatedFact.sku} observed_at`));
  if (!Number.isFinite(observedAt.getTime())) throw discoveryError(`live detail ${validatedFact.sku} observed_at is invalid`);
  const current = now();
  const currentMs = current instanceof Date ? current.getTime() : new Date(current).getTime();
  if (!Number.isFinite(currentMs)) throw discoveryError("live detail clock is invalid");
  if (observedAt.getTime() < Date.parse(validatedFact.discovered_at)) {
    throw discoveryError(`live detail ${validatedFact.sku} predates its discovery fact`);
  }
  if (observedAt.getTime() > currentMs + Math.max(0, Number(futureSkewMs) || 0)) {
    throw discoveryError(`live detail ${validatedFact.sku} observed_at is implausibly in the future`);
  }
  if (currentMs - observedAt.getTime() > LIVE_DETAIL_MAX_AGE_MS) {
    throw discoveryError(`live detail ${validatedFact.sku} is too old for current validation`);
  }
  if (rateReference && (rateReference.observed_at.getTime() < Date.parse(manifest.activated_at)
    || rateReference.observed_at.getTime() > observedAt.getTime() + LIVE_DETAIL_RATE_FUTURE_SKEW_MS
    || observedAt.getTime() - rateReference.observed_at.getTime() > LIVE_DETAIL_RATE_MAX_AGE_MS)) {
    throw discoveryError(`live detail ${validatedFact.sku} API rate reference is outside the current campaign observation window`);
  }
  return Object.freeze({
    contract: AUDITED_LIVE_DETAIL_CONTRACT,
    at: observedAt.toISOString(),
    activated_at: manifest.activated_at,
    discovered_at: validatedFact.discovered_at,
    run_id: manifest.run_id,
    campaign_epoch: manifest.campaign_epoch,
    artifact_sha256: manifest.artifact_sha256,
    source_set_sha256: manifest.source_set_sha256,
    sku: validatedFact.sku,
    href: validatedFact.href,
    final_url: finalUrl,
    source_url: validatedFact.source_url,
    // The exact seller page that produced the card is authoritative campaign
    // provenance. Ozon's product page can default to another offer/seller.
    seller_url: validatedFact.seller_url,
    observed_current_seller_url: observedCurrentSellerUrl,
    observed_current_seller_evidence_source: observedCurrentSellerEvidenceSource,
    target_id: validatedFact.target_id,
    category_key: validatedFact.category_key,
    accessory_role: validatedFact.accessory_role,
    title,
    live_title_guard_passed: true,
    brand_evidence: identityEvidence.brand,
    category_evidence: identityEvidence.category,
    item_evidence: identityEvidence.item,
    cover_image: coverImage,
    sell_price: priceEvidence.parsed.selected_price,
    currency: "CNY",
    price_evidence: {
      method: DETAIL_METHOD,
      live: true,
      source_field: "web_price_plus_same_page_follow_pair",
      dom_contract: PRICE_DOM_CONTRACT,
      raw_web_price_text: priceEvidence.raw_web_price_text,
      current_price_node: priceEvidence.current_price_node,
      excluded_price_nodes: priceEvidence.excluded_price_nodes,
      widget_explicit_rub_values: priceEvidence.widget_explicit_rub_values,
      widget_explicit_cny_values: priceEvidence.widget_explicit_cny_values,
      raw_follow_price_line: priceEvidence.raw_follow_price_line,
      parsed: priceEvidence.parsed,
      selection_basis: priceEvidence.selection_basis,
      rate_basis: priceEvidence.rate_basis,
      api_rate_reference: rateReference ? {
        source: rateReference.source,
        cny_per_rub: rateReference.cny_per_rub,
        observed_at: rateReference.observed_at.toISOString(),
        maximum_relative_drift: MAX_API_RATE_RELATIVE_DRIFT,
      } : null,
      observed_at: observedAt.toISOString(),
    },
  });
}

export async function enrichAuditedDiscoveryFacts({
  facts = [],
  manifest,
  artifact,
  fetchLiveDetail,
  accessAdapter,
  concurrency = 4,
  onEnrichment = null,
  onProgress = () => {},
  now = () => new Date(),
  futureSkewMs = LIVE_DETAIL_FUTURE_SKEW_MS,
} = {}) {
  if (typeof fetchLiveDetail !== "function") throw discoveryError("fetchLiveDetail callback is required");
  if (onEnrichment !== null && typeof onEnrichment !== "function") {
    throw discoveryError("onEnrichment checkpoint callback must be a function");
  }
  const access = validateLiveDetailAccessAdapter(accessAdapter);
  const maximumConcurrency = auditedConcurrency(concurrency, "live detail concurrency");
  const current = now();
  const currentMs = current instanceof Date ? current.getTime() : new Date(current).getTime();
  if (!Number.isFinite(currentMs)) throw discoveryError("live detail enrichment clock is invalid");
  const validated = [...new Map((facts || []).map((row) => {
    const fact = validateFact(row, manifest, artifact, { nowMs: currentMs, futureSkewMs });
    return [`${fact.sku}\0${fact.source_url}`, fact];
  })).values()];
  const outcomes = new Array(validated.length);
  let cursor = 0;
  let manualAttentionError = null;
  let fatalCheckpointError = null;
  let checkpointTail = Promise.resolve();
  const checkpoint = async (row) => {
    if (!onEnrichment) return;
    const current = checkpointTail.then(() => onEnrichment(row));
    checkpointTail = current.catch(() => {});
    await current;
  };
  const worker = async () => {
    while (true) {
      if (manualAttentionError || fatalCheckpointError) return;
      const index = cursor;
      cursor += 1;
      if (index >= validated.length) return;
      const fact = validated[index];
      let enrichment;
      try {
        const observation = await access.run(
          { sku: fact.sku, url: fact.href },
          () => fetchLiveDetail(fact),
        );
        enrichment = normalizeAuditedLiveDetailObservation({
          fact,
          observation,
          manifest,
          artifact,
          now,
          futureSkewMs,
        });
      } catch (error) {
        if (isAuditedManualAttentionError(error)) {
          manualAttentionError ||= error;
          return;
        }
        outcomes[index] = {
          enrichment: null,
          gap: {
            sku: fact.sku,
            source_url: fact.source_url,
            reason: "live-detail-enrichment-failed",
            detail: String(error?.message || error),
          },
        };
      }
      if (enrichment) {
        try {
          // Every successful detail is durably appended in this single ordered
          // checkpoint lane before the worker can report it complete.
          await checkpoint(enrichment);
          outcomes[index] = { enrichment, gap: null };
        } catch (error) {
          fatalCheckpointError ||= discoveryError(`live detail checkpoint failed for ${fact.sku}: ${error?.message || error}`);
          return;
        }
      }
      try {
        onProgress({
          phase: "audited-live-detail-completed",
          sku: fact.sku,
          ok: Boolean(outcomes[index].enrichment),
          completed: outcomes.filter(Boolean).length,
          total: validated.length,
        });
      } catch {}
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(maximumConcurrency, Math.max(1, validated.length)) },
    () => worker(),
  ));
  await checkpointTail;
  if (fatalCheckpointError) throw fatalCheckpointError;
  if (manualAttentionError) throw manualAttentionError;
  return Object.freeze({
    enrichment: Object.freeze(outcomes.flatMap((row) => row?.enrichment ? [row.enrichment] : [])),
    gaps: Object.freeze(outcomes.flatMap((row) => row?.gap ? [row.gap] : [])),
  });
}

export async function enrichAuditedDiscoveryCampaign({
  manifestFile,
  artifactFile,
  fetchLiveDetail,
  accessAdapter,
  concurrency = 4,
  minimumCandidates = DEFAULT_AUDITED_CANDIDATE_MINIMUM,
  now = () => new Date(),
  futureSkewMs = LIVE_DETAIL_FUTURE_SKEW_MS,
  onProgress = () => {},
} = {}) {
  const artifact = await loadAuditedSourceArtifact(artifactFile);
  const manifestPath = path.resolve(nonEmpty(manifestFile, "manifest file"));
  const directory = path.dirname(manifestPath);
  const campaignRoot = campaignBaseFromDirectory(directory);
  await ensureAuditedDirectory(campaignRoot, directory);
  await auditAuditedLeaf(campaignRoot, manifestPath, { required: true });
  let rawManifest;
  try { rawManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); }
  catch (error) { throw discoveryError(`campaign manifest could not be read: ${error.message}`); }
  const manifest = validateManifest(rawManifest, {
    artifact,
    artifactSha256: artifactSha256(artifact),
  });
  if (path.resolve(manifest.artifact_source_path) !== path.resolve(artifactFile)) {
    throw discoveryError("enrichment artifact path does not match the campaign manifest");
  }
  await auditCampaignFiles(campaignRoot, directory, manifest);
  const facts = await readJsonLinesStrict(path.join(directory, manifest.files.provenance), "discovery provenance");
  const current = now();
  const currentMs = current instanceof Date ? current.getTime() : new Date(current).getTime();
  if (!Number.isFinite(currentMs)) throw discoveryError("campaign enrichment clock is invalid");
  const grouped = factsBySku(facts, manifest, artifact, { nowMs: currentMs, futureSkewMs });
  const existing = await readJsonLinesStrict(
    path.join(directory, manifest.files.live_detail_enrichment),
    "live detail enrichment",
  );
  const completed = new Set();
  for (const row of existing) {
    const skuFacts = grouped.get(String(row?.sku || "")) || [];
    const fact = skuFacts.find((candidateFact) => candidateFact.source_url === exactAuditedSourceUrl(row?.source_url));
    if (!fact) throw discoveryError(`existing live detail ${row?.sku || "<unknown>"} has no exact current-campaign fact`);
    validateEnrichment(row, manifest, fact, artifact, { nowMs: currentMs, futureSkewMs });
    completed.add(`${fact.sku}\0${fact.source_url}`);
  }
  const pending = [...grouped.values()].flatMap((rows) => rows).filter((fact, index, all) => {
    const key = `${fact.sku}\0${fact.source_url}`;
    return !completed.has(key)
      && all.findIndex((candidate) => `${candidate.sku}\0${candidate.source_url}` === key) === index;
  });
  const batch = await enrichAuditedDiscoveryFacts({
    facts: pending,
    manifest,
    artifact,
    fetchLiveDetail,
    accessAdapter,
    concurrency,
    onEnrichment: (row) => appendJsonLines(
      path.join(directory, manifest.files.live_detail_enrichment),
      [row],
      campaignRoot,
    ),
    onProgress,
    now,
    futureSkewMs,
  });
  const assembled = assembleAuditedValidationCandidates({
    artifact,
    manifest,
    facts,
    enrichments: [...existing, ...batch.enrichment],
    minimumCandidates,
    now,
    futureSkewMs,
  });
  return Object.freeze({
    campaign_epoch: manifest.campaign_epoch,
    run_id: manifest.run_id,
    pending_before: pending.length,
    enriched_this_run: batch.enrichment.length,
    enrichment_gaps: batch.gaps,
    enriched_total: existing.length + batch.enrichment.length,
    candidate_count: assembled.candidate_count,
    minimum_candidates: assembled.minimum_candidates,
    ready: assembled.ready,
  });
}

function validateEnrichment(row, manifest, fact, artifact, {
  nowMs = Date.now(),
  futureSkewMs = LIVE_DETAIL_FUTURE_SKEW_MS,
} = {}) {
  if (row?.contract !== AUDITED_LIVE_DETAIL_CONTRACT
    || row.run_id !== manifest.run_id
    || row.campaign_epoch !== manifest.campaign_epoch
    || row.artifact_sha256 !== manifest.artifact_sha256
    || row.source_set_sha256 !== manifest.source_set_sha256
    || row.activated_at !== manifest.activated_at
    || row.discovered_at !== fact.discovered_at) {
    throw discoveryError(`live detail ${row?.sku || "<unknown>"} is outside the current campaign binding`);
  }
  const sku = normalizeSku(row.sku, "live detail sku");
  if (sku !== fact.sku
    || row.source_url !== fact.source_url
    || row.seller_url !== fact.seller_url
    || row.target_id !== fact.target_id
    || row.category_key !== fact.category_key
    || (row.accessory_role ?? null) !== (fact.accessory_role ?? null)) {
    throw discoveryError(`live detail ${sku} does not match its exact seller/category/accessory-role/source provenance`);
  }
  const observedCurrentSellerUrl = row.observed_current_seller_url === null
    || row.observed_current_seller_url === undefined
    || String(row.observed_current_seller_url).trim() === ""
    ? null
    : exactOzonSellerRoot(row.observed_current_seller_url, `live detail ${sku} observed current seller`);
  if (observedCurrentSellerUrl !== (row.observed_current_seller_url || null)) {
    throw discoveryError(`live detail ${sku} observed current seller diagnostic is not canonical`);
  }
  const observedCurrentSellerEvidenceSource = observedCurrentSellerUrl
    ? nonEmpty(row.observed_current_seller_evidence_source, `live detail ${sku} observed seller evidence source`)
    : null;
  if (observedCurrentSellerEvidenceSource !== null
    && !["webCurrentSeller", "current-seller-widget", "webSeller"].includes(observedCurrentSellerEvidenceSource)) {
    throw discoveryError(`live detail ${sku} observed current seller evidence is not authoritative`);
  }
  if (!observedCurrentSellerUrl && row.observed_current_seller_evidence_source !== null
    && row.observed_current_seller_evidence_source !== undefined
    && String(row.observed_current_seller_evidence_source).trim() !== "") {
    throw discoveryError(`live detail ${sku} observed current seller source has no seller URL`);
  }
  if (row.currency !== "CNY"
    || row.price_evidence?.method !== DETAIL_METHOD
    || row.price_evidence?.live !== true
    || row.price_evidence?.source_field !== "web_price_plus_same_page_follow_pair"
    || row.price_evidence?.dom_contract !== PRICE_DOM_CONTRACT
    || !String(row.price_evidence?.raw_web_price_text || "").trim()
    || (row.price_evidence?.raw_follow_price_line !== null
      && typeof row.price_evidence?.raw_follow_price_line !== "string")) {
    throw discoveryError(`live detail ${sku} lacks strict live CNY evidence`);
  }
  const sellPrice = Number(row.sell_price);
  if (!(Number.isFinite(sellPrice) && sellPrice > 0)) throw discoveryError(`live detail ${sku} price is invalid`);
  const reparsed = conservativeLivePriceEvidence({
    webPriceText: row.price_evidence.raw_web_price_text,
    currentPriceNode: row.price_evidence.current_price_node,
    excludedPriceNodes: row.price_evidence.excluded_price_nodes,
    followPriceLines: row.price_evidence.raw_follow_price_line
      ? [row.price_evidence.raw_follow_price_line]
      : [],
    apiCnyPerRub: row.price_evidence.api_rate_reference?.cny_per_rub,
  });
  if (!nearlyEqual(reparsed.parsed.selected_price, sellPrice, 0.000001)
    || canonicalJson(reparsed.parsed) !== canonicalJson(row.price_evidence.parsed)
    || canonicalJson(reparsed.current_price_node) !== canonicalJson(row.price_evidence.current_price_node)
    || canonicalJson(reparsed.excluded_price_nodes) !== canonicalJson(row.price_evidence.excluded_price_nodes)
    || canonicalJson(reparsed.widget_explicit_rub_values) !== canonicalJson(row.price_evidence.widget_explicit_rub_values)
    || canonicalJson(reparsed.widget_explicit_cny_values) !== canonicalJson(row.price_evidence.widget_explicit_cny_values)
    || reparsed.selection_basis !== row.price_evidence.selection_basis
    || reparsed.rate_basis !== row.price_evidence.rate_basis) {
    throw discoveryError(`live detail ${sku} price evidence does not reparse to its selected CNY price`);
  }
  const observedAt = Date.parse(String(row.at || ""));
  if (row.price_evidence.raw_follow_price_line) {
    const referenceAt = Date.parse(String(row.price_evidence.api_rate_reference?.observed_at || ""));
    if (row.price_evidence.api_rate_reference?.source !== "maozi-current-exchange-rate-api"
      || Number(row.price_evidence.api_rate_reference?.maximum_relative_drift) !== MAX_API_RATE_RELATIVE_DRIFT
      || !Number.isFinite(referenceAt)
      || referenceAt < Date.parse(manifest.activated_at)
      || referenceAt > observedAt + LIVE_DETAIL_RATE_FUTURE_SKEW_MS
      || observedAt - referenceAt > LIVE_DETAIL_RATE_MAX_AGE_MS) {
      throw discoveryError(`live detail ${sku} current API rate reference is invalid`);
    }
  }
  if (!Number.isFinite(observedAt)
    || String(row.price_evidence.observed_at || "") !== new Date(observedAt).toISOString()
    || observedAt < Date.parse(fact.discovered_at)
    || observedAt > Number(nowMs) + Math.max(0, Number(futureSkewMs) || 0)
    || Number(nowMs) - observedAt > LIVE_DETAIL_MAX_AGE_MS) {
    throw discoveryError(`live detail ${sku} has an invalid campaign-relative observation time`);
  }
  const title = nonEmpty(row.title, `live detail ${sku} title`);
  const identityEvidence = normalizeLiveIdentityEvidence(row, title, fact, manifest, artifact);
  if (canonicalJson(identityEvidence.brand) !== canonicalJson(row.brand_evidence)
    || canonicalJson(identityEvidence.category) !== canonicalJson(row.category_evidence)
    || canonicalJson(identityEvidence.item) !== canonicalJson(row.item_evidence)) {
    throw discoveryError(`live detail ${sku} structured identity evidence is not canonical`);
  }
  const liveTitleEligibility = auditedCandidateEligibility({
    sku,
    source_url: fact.source_url,
    title,
  }, artifact, { activeUrls: manifest.active_urls });
  if (row.live_title_guard_passed !== true
    || !liveTitleEligibility.eligible
    || liveTitleEligibility.target.id !== fact.target_id
    || liveTitleEligibility.target.category_key !== fact.category_key
    || (liveTitleEligibility.target.accessory_role ?? null) !== (fact.accessory_role ?? null)
    || liveTitleEligibility.target.seller_url !== fact.seller_url) {
    throw discoveryError(`live detail ${sku} title no longer matches its exact audited target`);
  }
  const coverImage = trustedOzonImageUrl(row.cover_image, `live detail ${sku} cover image`);
  const finalUrl = exactOzonProductUrl(row.final_url, `live detail ${sku} final URL`);
  if (skuFromProductUrl(finalUrl) !== sku) throw discoveryError(`live detail ${sku} final URL/SKU mismatch`);
  if (exactOzonProductUrl(row.href, `live detail ${sku} href`) !== fact.href) {
    throw discoveryError(`live detail ${sku} href does not match its discovery fact`);
  }
  return {
    ...row,
    sku,
    title,
    cover_image: coverImage,
    final_url: finalUrl,
    sell_price: sellPrice,
    observed_current_seller_url: observedCurrentSellerUrl,
    observed_current_seller_evidence_source: observedCurrentSellerEvidenceSource,
  };
}

export function assembleAuditedValidationCandidates({
  artifact,
  manifest,
  facts = [],
  enrichments = [],
  minimumCandidates = DEFAULT_AUDITED_CANDIDATE_MINIMUM,
  now = () => new Date(),
  futureSkewMs = LIVE_DETAIL_FUTURE_SKEW_MS,
} = {}) {
  assertValidationOnlyArtifact(artifact);
  const normalizedManifest = validateManifest(manifest, {
    artifact,
    artifactSha256: artifactSha256(artifact),
  });
  const current = now();
  const currentMs = current instanceof Date ? current.getTime() : new Date(current).getTime();
  if (!Number.isFinite(currentMs)) throw discoveryError("candidate builder clock is invalid");
  const groupedFacts = factsBySku(facts, normalizedManifest, artifact, { nowMs: currentMs, futureSkewMs });
  const enrichmentBySku = new Map();
  for (const row of enrichments || []) {
    const sku = normalizeSku(row?.sku, "live detail sku");
    const candidateFacts = groupedFacts.get(sku) || [];
    if (candidateFacts.length === 0) throw discoveryError(`live detail ${sku} has no current-campaign discovery fact`);
    const bindings = new Map(candidateFacts.map((fact) => [factBinding(fact), fact]));
    if (bindings.size !== 1) throw discoveryError(`live detail ${sku} cannot bind an ambiguous discovery`);
    const sourceUrl = exactAuditedSourceUrl(row.source_url);
    const fact = candidateFacts.find((candidateFact) => candidateFact.source_url === sourceUrl);
    if (!fact) throw discoveryError(`live detail ${sku} source URL has no exact current-campaign discovery fact`);
    const normalized = validateEnrichment(row, normalizedManifest, fact, artifact, { nowMs: currentMs, futureSkewMs });
    const values = enrichmentBySku.get(sku) || [];
    values.push(normalized);
    enrichmentBySku.set(sku, values);
  }
  const candidates = [];
  const provenance = [];
  const gaps = [];
  const ordered = [...groupedFacts].sort((left, right) => {
    const leftAt = String(left[1][0]?.at || "");
    const rightAt = String(right[1][0]?.at || "");
    return leftAt.localeCompare(rightAt) || left[0].localeCompare(right[0]);
  });
  for (const [sku, skuFacts] of ordered) {
    const bindings = new Map(skuFacts.map((fact) => [factBinding(fact), fact]));
    if (bindings.size !== 1) {
      gaps.push({ sku, reason: "ambiguous-seller-category-binding" });
      continue;
    }
    const details = enrichmentBySku.get(sku) || [];
    if (details.length === 0) {
      gaps.push({ sku, reason: "missing-live-detail-cny-enrichment" });
      continue;
    }
    const signatures = new Set(details.map((row) => canonicalJson({
      title: row.title,
      cover_image: row.cover_image,
      sell_price: row.sell_price,
    })));
    if (signatures.size !== 1) {
      gaps.push({ sku, reason: "conflicting-live-detail-enrichment" });
      continue;
    }
    const detail = details.sort((left, right) => String(right.at).localeCompare(String(left.at)))[0];
    const fact = skuFacts.find((candidateFact) => candidateFact.source_url === detail.source_url);
    if (!fact) throw discoveryError(`live detail ${sku} lost its exact discovery source binding`);
    const candidate = {
      sku,
      title: detail.title,
      sell_price: detail.sell_price,
      cover_image: detail.cover_image,
    };
    candidates.push(Object.freeze(candidate));
    provenance.push(Object.freeze({
      contract: AUDITED_CANDIDATE_PROVENANCE_CONTRACT,
      run_id: normalizedManifest.run_id,
      campaign_epoch: normalizedManifest.campaign_epoch,
      activated_at: normalizedManifest.activated_at,
      discovered_at: fact.discovered_at,
      artifact_sha256: normalizedManifest.artifact_sha256,
      source_set_sha256: normalizedManifest.source_set_sha256,
      sku,
      href: fact.href,
      source_url: fact.source_url,
      seller_url: fact.seller_url,
      target_id: fact.target_id,
      category_key: fact.category_key,
      accessory_role: fact.accessory_role,
      live_detail_observed_at: detail.at,
      candidate_sha256: sha256(canonicalJson(candidate)),
    }));
  }
  const required = auditedCandidateMinimum(minimumCandidates);
  return Object.freeze({
    candidates: Object.freeze(candidates),
    provenance: Object.freeze(provenance),
    gaps: Object.freeze(gaps),
    discovered_unique: groupedFacts.size,
    candidate_count: candidates.length,
    minimum_candidates: required,
    ready: candidates.length >= required,
    price_source: "live-ozon-detail-conservative-same-page-cny",
    listing_card_price_used: false,
  });
}

export async function buildAuditedValidationCandidatesFromCampaign({
  manifestFile,
  artifactFile,
  enrichmentFile = null,
  candidateOutputFile = null,
  provenanceOutputFile = null,
  minimumCandidates = DEFAULT_AUDITED_CANDIDATE_MINIMUM,
  requireReady = true,
  now = () => new Date(),
} = {}) {
  if (requireReady !== true) {
    throw discoveryError("audited candidate output cannot bypass the 300-candidate readiness gate");
  }
  const artifact = await loadAuditedSourceArtifact(artifactFile);
  const manifestPath = path.resolve(nonEmpty(manifestFile, "manifest file"));
  const directory = path.dirname(manifestPath);
  const campaignRoot = campaignBaseFromDirectory(directory);
  await ensureAuditedDirectory(campaignRoot, directory);
  await auditAuditedLeaf(campaignRoot, manifestPath, { required: true });
  let rawManifest;
  try { rawManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); }
  catch (error) { throw discoveryError(`campaign manifest could not be read: ${error.message}`); }
  const manifest = validateManifest(rawManifest, {
    artifact,
    artifactSha256: artifactSha256(artifact),
  });
  await auditCampaignFiles(campaignRoot, directory, manifest);
  if (path.resolve(manifest.artifact_source_path) !== path.resolve(artifactFile)) {
    throw discoveryError("builder artifact path does not match the campaign manifest");
  }
  const facts = await readJsonLinesStrict(path.join(directory, manifest.files.provenance), "discovery provenance");
  const liveDetails = await readJsonLinesStrict(
    enrichmentFile ? path.resolve(enrichmentFile) : path.join(directory, manifest.files.live_detail_enrichment),
    "live detail enrichment",
  );
  const assembled = assembleAuditedValidationCandidates({
    artifact,
    manifest,
    facts,
    enrichments: liveDetails,
    minimumCandidates,
    now,
  });
  if (!assembled.ready) {
    throw discoveryError(`candidate set is not ready: ${assembled.candidate_count}/${assembled.minimum_candidates} have strict live CNY detail`);
  }
  if (candidateOutputFile && provenanceOutputFile
    && path.resolve(candidateOutputFile) === path.resolve(provenanceOutputFile)) {
    throw discoveryError("candidate and provenance output files must be different paths");
  }
  const manifestSha256 = sha256(canonicalJson(manifest));
  const candidateSetSha256 = sha256(canonicalJson(assembled.candidates));
  const provenanceSetSha256 = sha256(canonicalJson(assembled.provenance));
  const candidateEnvelope = Object.freeze({
    contract: AUDITED_CANDIDATE_SET_CONTRACT,
    schema_version: 1,
    run_id: manifest.run_id,
    campaign_epoch: manifest.campaign_epoch,
    artifact_sha256: manifest.artifact_sha256,
    source_set_sha256: manifest.source_set_sha256,
    manifest_sha256: manifestSha256,
    candidate_count: assembled.candidate_count,
    minimum_candidates: assembled.minimum_candidates,
    candidate_set_sha256: candidateSetSha256,
    provenance_set_sha256: provenanceSetSha256,
    candidates: assembled.candidates,
    provenance: assembled.provenance,
  });
  const provenanceEnvelope = Object.freeze({
    contract: AUDITED_CANDIDATE_PROVENANCE_SET_CONTRACT,
    schema_version: 1,
    run_id: manifest.run_id,
    campaign_epoch: manifest.campaign_epoch,
    artifact_sha256: manifest.artifact_sha256,
    source_set_sha256: manifest.source_set_sha256,
    manifest_sha256: manifestSha256,
    candidate_count: assembled.candidate_count,
    candidate_set_sha256: candidateSetSha256,
    provenance_set_sha256: provenanceSetSha256,
    provenance: assembled.provenance,
  });
  if (provenanceOutputFile) await writeJsonAtomic(path.resolve(provenanceOutputFile), provenanceEnvelope);
  // Candidate output is the consumable artifact, so publish it last. A failed
  // provenance write can never leave a new candidate file without its audit.
  if (candidateOutputFile) await writeJsonAtomic(path.resolve(candidateOutputFile), candidateEnvelope);
  return Object.freeze({ ...assembled, candidate_envelope: candidateEnvelope, provenance_envelope: provenanceEnvelope });
}

export async function appendAuditedLiveDetailEnrichment({ campaignDirectory, rows = [] } = {}) {
  const directory = path.resolve(nonEmpty(campaignDirectory, "campaign directory"));
  const campaignRoot = campaignBaseFromDirectory(directory);
  await ensureAuditedDirectory(campaignRoot, directory);
  await auditAuditedLeaf(campaignRoot, path.join(directory, "campaign.json"), { required: true });
  let rawManifest;
  try { rawManifest = JSON.parse(await fs.readFile(path.join(directory, "campaign.json"), "utf8")); }
  catch (error) { throw discoveryError(`campaign manifest could not be read: ${error.message}`); }
  const artifact = await loadAuditedSourceArtifact(rawManifest?.artifact_source_path);
  const manifest = validateManifest(rawManifest, {
    artifact,
    artifactSha256: artifactSha256(artifact),
  });
  await auditCampaignFiles(campaignRoot, directory, manifest);
  for (const row of rows) {
    if (row?.contract !== AUDITED_LIVE_DETAIL_CONTRACT
      || row.run_id !== manifest.run_id
      || row.campaign_epoch !== manifest.campaign_epoch
      || row.artifact_sha256 !== manifest.artifact_sha256
      || row.source_set_sha256 !== manifest.source_set_sha256
      || row.activated_at !== manifest.activated_at
      || !String(row.discovered_at || "").trim()) {
      throw discoveryError("refusing to append live detail outside the current campaign binding");
    }
  }
  await appendJsonLines(path.join(directory, manifest.files.live_detail_enrichment), rows, campaignRoot);
  return rows.length;
}
