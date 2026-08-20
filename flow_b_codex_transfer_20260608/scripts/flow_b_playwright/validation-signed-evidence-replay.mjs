import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { compactCostOutput, parseCostOutput } from "./cost-bridge.mjs";
import { normalize1688MatchRequest } from "./cost-evidence.mjs";

export const VALIDATION_SIGNED_EVIDENCE_REPLAY_ENV = "FLOW_B_VALIDATION_SIGNED_EVIDENCE_REPLAY_FILE";
export const VALIDATION_SIGNED_EVIDENCE_REPLAY_CONTRACT = "flow-b-validation-signed-evidence-replay-v1";

const DIGEST_RE = /^[a-f0-9]{64}$/u;
const STRICT_MATCH_TYPES = new Set(["strong_single", "corroborated_multi"]);
const MAXIMUM_REPLAY_FILE_BYTES = 25 * 1024 * 1024;
const MAXIMUM_ENTRY_OUTPUT_BYTES = 512 * 1024;

function compactText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function canonicalUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" && url.hostname && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function signedRequest(output) {
  const encoded = String(output || "").match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1]?.trim() || "";
  if (!encoded) return null;
  try {
    const evidence = JSON.parse(encoded);
    return evidence?.request && typeof evidence.request === "object" && !Array.isArray(evidence.request)
      ? evidence.request
      : null;
  } catch {
    return null;
  }
}

function normalizedCandidate(candidate = {}) {
  return {
    sku: compactText(candidate.sku),
    title: compactText(candidate.title),
    sell_price: Number(candidate.sell_price),
    cover_image: canonicalUrl(candidate.cover_image),
  };
}

export function validationCandidateSetSha256(candidates = []) {
  const rows = (Array.isArray(candidates) ? candidates : []).map(normalizedCandidate);
  return crypto.createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex");
}

function runtimeRequest(item = {}) {
  const value = (candidate) => compactText(candidate);
  const sellPrice = Number(item?.sell_price);
  return {
    expect_title: value(item?.expect_title || item?.title),
    expect_model: value(item?.expect_model || item?.model || item?.model_name || item?.article),
    expect_category: value(item?.expect_category || item?.category_name || item?.cate_name),
    expect_price_cny: Number.isFinite(sellPrice) && sellPrice > 0 ? sellPrice : null,
  };
}

function sameIdentityRequest(current, signed) {
  const currentNormalized = normalize1688MatchRequest(current);
  const signedNormalized = normalize1688MatchRequest(signed);
  return ["expect_title", "expect_model", "expect_category"]
    .every((field) => currentNormalized[field] === signedNormalized[field]);
}

function strictReplayCost(cost = {}) {
  const supporting = Array.isArray(cost?.balanced_supporting_offer_ids)
    ? cost.balanced_supporting_offer_ids.map(compactText).filter(Boolean)
    : [];
  const minimumSupports = cost?.balanced_match_type === "strong_single" ? 1 : 2;
  return cost?.ok === true
    && cost?.returned_evidence_verified === true
    && cost?.same_item_match === true
    && cost?.match_evidence_contract === "1688-returned-same-item-v3"
    && cost?.balanced_match === true
    && STRICT_MATCH_TYPES.has(cost?.balanced_match_type)
    && supporting.length >= minimumSupports
    && new Set(supporting).size === supporting.length
    && supporting.every((offerId) => /^\d+$/u.test(offerId));
}

function replayScopeError(message) {
  return new Error(`${VALIDATION_SIGNED_EVIDENCE_REPLAY_ENV} ${message}`);
}

function validateReplayScope(env = {}) {
  if (env.FLOW_B_VALIDATION_ONLY !== "1") {
    throw replayScopeError("is allowed only when FLOW_B_VALIDATION_ONLY=1");
  }
  if (env.FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE !== "1") {
    throw replayScopeError("requires FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE=1");
  }
  if (!compactText(env.FLOW_B_VALIDATION_CANDIDATE_FILE)) {
    throw replayScopeError("requires FLOW_B_VALIDATION_CANDIDATE_FILE");
  }
}

function validateManifestEntry(entry, candidate, { minimumSameItemMatches }) {
  const sku = compactText(candidate?.sku);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw replayScopeError(`entry ${sku} must be an object`);
  }
  if (compactText(entry.sku) !== sku) throw replayScopeError(`entry ${sku} has a mismatched SKU`);
  if (compactText(entry.title) !== compactText(candidate.title)) {
    throw replayScopeError(`entry ${sku} has a mismatched title`);
  }
  if (Number(entry.sell_price) !== Number(candidate.sell_price)) {
    throw replayScopeError(`entry ${sku} has a mismatched validation snapshot price`);
  }
  if (canonicalUrl(entry.cover_image) !== canonicalUrl(candidate.cover_image)) {
    throw replayScopeError(`entry ${sku} has a mismatched Ozon image`);
  }
  if (!DIGEST_RE.test(compactText(entry.source_cache_key))) {
    throw replayScopeError(`entry ${sku} has an invalid source cache key`);
  }
  const cachePayload = entry.source_cache_key_payload;
  if (!cachePayload || typeof cachePayload !== "object" || Array.isArray(cachePayload)) {
    throw replayScopeError(`entry ${sku} has no source cache key payload`);
  }
  const cachePayloadKey = crypto.createHash("sha256")
    .update(JSON.stringify(cachePayload), "utf8")
    .digest("hex");
  if (cachePayloadKey !== compactText(entry.source_cache_key)) {
    throw replayScopeError(`entry ${sku} source cache key payload digest mismatch`);
  }
  const sourceCacheVersion = Number(cachePayload.version);
  const sourceMinimumMatches = Number(cachePayload.minimum_same_item_matches);
  const exclusionsValid = sourceCacheVersion >= 6
    ? Array.isArray(cachePayload.excluded_offer_ids) && cachePayload.excluded_offer_ids.length === 0
    : !Object.hasOwn(cachePayload, "excluded_offer_ids");
  if (![4, 5, 6, 7].includes(sourceCacheVersion)
    || !Number.isInteger(sourceMinimumMatches)
    || sourceMinimumMatches < 1
    || sourceMinimumMatches > 3
    || !exclusionsValid
    || canonicalUrl(cachePayload.image_url) !== canonicalUrl(candidate.cover_image)
    || compactText(cachePayload.expect_title) !== compactText(candidate.title)) {
    throw replayScopeError(`entry ${sku} source cache key is not bound to this candidate image and title`);
  }
  const output = String(entry.output || "");
  if (!output || Buffer.byteLength(output, "utf8") > MAXIMUM_ENTRY_OUTPUT_BYTES) {
    throw replayScopeError(`entry ${sku} has missing or oversized signed output`);
  }
  const sourceOutput = String(entry.source_output || "");
  if (!sourceOutput || Buffer.byteLength(sourceOutput, "utf8") > MAXIMUM_ENTRY_OUTPUT_BYTES) {
    throw replayScopeError(`entry ${sku} has missing or oversized original signed output`);
  }
  if (!DIGEST_RE.test(compactText(entry.source_output_sha256))
    || sha256Text(sourceOutput) !== compactText(entry.source_output_sha256)) {
    throw replayScopeError(`entry ${sku} original signed output digest mismatch`);
  }
  if (!DIGEST_RE.test(compactText(entry.compact_output_sha256))
    || sha256Text(output) !== compactText(entry.compact_output_sha256)) {
    throw replayScopeError(`entry ${sku} compact signed output digest mismatch`);
  }
  if (compactCostOutput(sourceOutput) !== output) {
    throw replayScopeError(`entry ${sku} compact signed output differs from its original output`);
  }
  const request = signedRequest(output);
  if (!request) throw replayScopeError(`entry ${sku} has no signed request`);
  const expectedIdentity = normalize1688MatchRequest({
    expect_title: candidate.title,
    expect_model: entry.expect_model,
    expect_category: entry.expect_category,
    expect_price_cny: request.expect_price_cny,
  });
  const signedIdentity = normalize1688MatchRequest(request);
  if (JSON.stringify(expectedIdentity) !== JSON.stringify(signedIdentity)) {
    throw replayScopeError(`entry ${sku} signed title, model, category, or source price is not bound to its manifest row`);
  }
  const cacheIdentity = normalize1688MatchRequest(cachePayload);
  if (cacheIdentity.expect_title !== signedIdentity.expect_title
    || cacheIdentity.expect_model !== signedIdentity.expect_model
    || cacheIdentity.expect_category !== signedIdentity.expect_category
    || (sourceCacheVersion >= 7
      && cacheIdentity.expect_price_cny !== signedIdentity.expect_price_cny)) {
    throw replayScopeError(`entry ${sku} source cache key semantics differ from the signed request`);
  }
  const parsed = parseCostOutput(output, candidate.sell_price, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    minimumSameItemMatches,
    requiredEvidenceContract: "1688-returned-same-item-v3",
    requireBalancedMatch: true,
    allowSignedSelectedOfferDerivation: true,
  });
  if (!strictReplayCost(parsed)) {
    throw replayScopeError(`entry ${sku} is not strict signed v3 same-item evidence: ${parsed?.reason || "unknown"}`);
  }
  if (compactText(parsed.match_evidence_key) !== compactText(entry.match_evidence_key)) {
    throw replayScopeError(`entry ${sku} match evidence key differs from the signed output`);
  }
  const parsedSelectedOfferId = compactText(parsed.selected_offer_id);
  if (compactText(entry.selected_offer_id) !== parsedSelectedOfferId) {
    throw replayScopeError(`entry ${sku} selected offer ID differs from the signed output`);
  }
  const selectedOfferIdOrigin = compactText(parsed.selected_offer_id_origin)
    || "signed-selected-offer-id-v1";
  if (entry.selected_offer_id_origin !== undefined
    && compactText(entry.selected_offer_id_origin) !== selectedOfferIdOrigin) {
    throw replayScopeError(`entry ${sku} selected offer ID origin differs from the signed output`);
  }
  return Object.freeze({
    ...entry,
    sku,
    title: compactText(entry.title),
    sell_price: Number(entry.sell_price),
    cover_image: canonicalUrl(entry.cover_image),
    expect_model: compactText(entry.expect_model),
    expect_category: compactText(entry.expect_category),
    selected_offer_id: parsedSelectedOfferId,
    selected_offer_id_origin: selectedOfferIdOrigin,
    output: compactCostOutput(output),
    request: Object.freeze({ ...request }),
  });
}

export async function loadValidationSignedEvidenceReplayFromEnv(env = {}, {
  candidates,
  minimumSameItemMatches = 3,
} = {}) {
  const sourceFile = compactText(env?.[VALIDATION_SIGNED_EVIDENCE_REPLAY_ENV]);
  if (!sourceFile) return null;
  validateReplayScope(env);
  if (!Array.isArray(candidates) || !candidates.length) {
    throw replayScopeError("requires already validated candidate rows");
  }
  const sourcePath = path.resolve(sourceFile);
  const stat = await fs.stat(sourcePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAXIMUM_REPLAY_FILE_BYTES) {
    throw replayScopeError(`must be a non-empty file no larger than ${MAXIMUM_REPLAY_FILE_BYTES} bytes`);
  }
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  } catch (error) {
    throw replayScopeError(`is not valid JSON: ${error.message}`);
  }
  if (manifest?.contract !== VALIDATION_SIGNED_EVIDENCE_REPLAY_CONTRACT) {
    throw replayScopeError(`requires contract ${VALIDATION_SIGNED_EVIDENCE_REPLAY_CONTRACT}`);
  }
  const candidateDigest = validationCandidateSetSha256(candidates);
  if (manifest?.candidate_set_sha256 !== candidateDigest) {
    throw replayScopeError("candidate set digest does not match FLOW_B_VALIDATION_CANDIDATE_FILE");
  }
  const rawCandidateFile = await fs.readFile(path.resolve(env.FLOW_B_VALIDATION_CANDIDATE_FILE));
  const candidateFileDigest = crypto.createHash("sha256").update(rawCandidateFile).digest("hex");
  if (manifest?.candidate_file_sha256 !== candidateFileDigest) {
    throw replayScopeError("raw candidate file digest does not match FLOW_B_VALIDATION_CANDIDATE_FILE");
  }
  if (!Number.isSafeInteger(manifest?.candidate_count)
    || manifest.candidate_count !== candidates.length) {
    throw replayScopeError("candidate_count metadata does not match the exact validation candidate set");
  }
  const configuredMinimum = Math.max(1, Number(minimumSameItemMatches) || 1);
  if (Number(manifest?.minimum_same_item_matches) !== configuredMinimum) {
    throw replayScopeError("minimum same-item match count differs from the current runtime");
  }
  if (!manifest?.entries || typeof manifest.entries !== "object" || Array.isArray(manifest.entries)) {
    throw replayScopeError("entries must be an object keyed by SKU");
  }
  const manifestEntryCount = Object.keys(manifest.entries).length;
  if (!Number.isSafeInteger(manifest?.entry_count)
    || manifest.entry_count !== manifestEntryCount) {
    throw replayScopeError("entry_count metadata does not match the signed replay entries");
  }
  const candidateBySku = new Map(candidates.map((candidate) => [compactText(candidate.sku), candidate]));
  const entries = new Map();
  for (const [sku, rawEntry] of Object.entries(manifest.entries)) {
    const candidate = candidateBySku.get(compactText(sku));
    if (!candidate) throw replayScopeError(`contains SKU ${sku} outside the exact validation candidate set`);
    entries.set(compactText(sku), validateManifestEntry(rawEntry, candidate, {
      minimumSameItemMatches: configuredMinimum,
    }));
  }

  return Object.freeze({
    sourcePath,
    candidate_set_sha256: candidateDigest,
    entry_count: entries.size,
    requestFor(item = {}) {
      const sku = compactText(item?.sku);
      const entry = entries.get(sku);
      if (!entry) return null;
      if (compactText(item?.title) !== entry.title
        || Number(item?.sell_price) !== entry.sell_price
        || canonicalUrl(item?.cover_image) !== entry.cover_image) {
        return null;
      }
      return Object.freeze({ ...entry.request });
    },
    async estimate(item = {}) {
      const sku = compactText(item?.sku);
      const entry = entries.get(sku);
      if (!entry) return { used: false, reason: "no replay evidence for SKU" };
      if (Array.isArray(item?.excluded_1688_offer_ids) && item.excluded_1688_offer_ids.length) {
        return { used: false, reason: "manual offer exclusions require a fresh search" };
      }
      if (compactText(item?.title) !== entry.title
        || Number(item?.sell_price) !== entry.sell_price
        || canonicalUrl(item?.cover_image) !== entry.cover_image) {
        return { used: false, reason: "runtime candidate identity differs from the replay manifest" };
      }
      const currentRequest = runtimeRequest(item);
      if (!sameIdentityRequest(currentRequest, entry.request)) {
        return { used: false, reason: "current title, model, or category differs from the signed request" };
      }
      const parsed = parseCostOutput(entry.output, currentRequest.expect_price_cny, {
        // Only the non-identity Ozon sale price may drift. The parser still
        // verifies the complete original signed request and re-applies the
        // current 2%-85% cost bounds using the current validation snapshot.
        expectedMatchEvidence: entry.request,
        requireSameItemEvidence: true,
        minimumSameItemMatches: configuredMinimum,
        requiredEvidenceContract: "1688-returned-same-item-v3",
        requireBalancedMatch: true,
        allowSignedSelectedOfferDerivation: true,
      });
      if (!strictReplayCost(parsed)) {
        return { used: false, reason: parsed?.reason || "replayed evidence is not strict" };
      }
      return {
        used: true,
        result: {
          ...parsed,
          cached: true,
          shared_cache: false,
          cross_run_cache: true,
          cache_key: entry.source_cache_key,
          validation_signed_evidence_replay: true,
          validation_signed_evidence_replay_file: sourcePath,
          validation_signed_evidence_source_at: entry.source_validation_at || null,
          selected_offer_id_origin: entry.selected_offer_id_origin,
          validation_signed_evidence_price_binding: {
            signed_request_price: Number(entry.request.expect_price_cny) || null,
            current_snapshot_price: Number(currentRequest.expect_price_cny) || null,
            current_cost_bounds_rechecked: true,
          },
        },
      };
    },
  });
}
