import crypto from "node:crypto";

export const RELIABLE_1688_COST_SOURCES = Object.freeze([
  "search_first_page_p70_similarity_filtered",
  "search_first_page_cluster_p70_similarity_filtered",
  "search_first_page_cluster_p80_similarity_filtered",
]);

const RELIABLE_SOURCE_SET = new Set(RELIABLE_1688_COST_SOURCES);
const MATCH_EVIDENCE_KEY_RE = /^[a-f0-9]{64}$/u;

export function isReliable1688CostSource(value) {
  return RELIABLE_SOURCE_SET.has(String(value || "").trim());
}

export function isValid1688MatchEvidenceKey(value) {
  return MATCH_EVIDENCE_KEY_RE.test(String(value || "").trim());
}

export function normalize1688MatchRequest(value = {}) {
  const normalize = (candidate) => String(candidate ?? "")
    .toLocaleLowerCase("und")
    .replace(/\s+/gu, " ")
    .trim();
  return {
    expect_category: normalize(value?.expect_category),
    expect_model: normalize(value?.expect_model),
    expect_title: normalize(value?.expect_title),
  };
}

function equalNumericMultiset(left, right) {
  if (left.length !== right.length) return false;
  const sortedLeft = left.map(Number).sort((a, b) => a - b);
  const sortedRight = right.map(Number).sort((a, b) => a - b);
  return sortedLeft.every((value, index) => Number.isFinite(value)
    && Number.isFinite(sortedRight[index])
    && value === sortedRight[index]);
}

export function verifyReturnedSameItemEvidence({
  encodedEvidence,
  evidenceKey,
  expectedRequest,
  filteredPrices = [],
  costSource,
  selectedCost,
  minimumMatches = 3,
  requiredContract = null,
  requireBalancedMatch = false,
  allowLegacyV2 = true,
} = {}) {
  const requiredMatches = Math.max(1, Number(minimumMatches) || 1);
  const encoded = String(encodedEvidence || "").trim();
  const key = String(evidenceKey || "").trim();
  if (!encoded) return { ok: false, reason: "missing returned same-item evidence" };
  if (!isValid1688MatchEvidenceKey(key)) return { ok: false, reason: "missing or invalid returned evidence key" };
  const digest = crypto.createHash("sha256").update(encoded, "utf8").digest("hex");
  if (digest !== key) return { ok: false, reason: "returned same-item evidence digest mismatch" };

  let evidence;
  try {
    evidence = JSON.parse(encoded);
  } catch {
    return { ok: false, reason: "malformed returned same-item evidence" };
  }
  const contract = String(evidence?.contract || "");
  const supported = contract === "1688-returned-same-item-v3"
    || (allowLegacyV2 && contract === "1688-returned-same-item-v2");
  if (!supported) {
    return { ok: false, reason: "unsupported returned same-item evidence contract" };
  }
  if (requiredContract && contract !== requiredContract) {
    return { ok: false, reason: `fresh submission requires ${requiredContract}` };
  }
  if (String(evidence?.cost_source || "") !== String(costSource || "")) {
    return { ok: false, reason: "returned evidence cost source mismatch" };
  }
  if (!Number.isFinite(Number(selectedCost)) || Number(evidence?.selected_cost) !== Number(selectedCost)) {
    return { ok: false, reason: "returned evidence selected cost mismatch" };
  }

  const request = normalize1688MatchRequest(evidence?.request);
  const expected = normalize1688MatchRequest(expectedRequest);
  if (!Object.values(expected).some(Boolean)) {
    return { ok: false, reason: "missing request semantics for same-item verification" };
  }
  if (JSON.stringify(request) !== JSON.stringify(expected)) {
    return { ok: false, reason: "returned same-item evidence request mismatch" };
  }

  const rows = Array.isArray(evidence?.rows) ? evidence.rows : [];
  if (rows.length < requiredMatches) {
    return { ok: false, reason: `returned semantic matches insufficient ${rows.length}` };
  }
  const offerIds = new Set();
  const evidencePrices = [];
  for (const row of rows) {
    const offerId = String(row?.offer_id || "").trim();
    const title = String(row?.title || "").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
    const price = Number(row?.price);
    if (!offerId || offerIds.has(offerId)) {
      return { ok: false, reason: "returned same-item evidence has missing or duplicate offer identity" };
    }
    if (!title || !Number.isFinite(price) || price <= 0) {
      return { ok: false, reason: "returned same-item evidence has invalid title or price" };
    }
    const semanticHits = row?.semantic_hits && typeof row.semantic_hits === "object"
      ? row.semantic_hits
      : {};
    let explicitHitCount = 0;
    for (const kind of ["model", "title", "category"]) {
      const hits = Array.isArray(semanticHits[kind]) ? semanticHits[kind] : [];
      if (hits.length && !expected[`expect_${kind}`]) {
        return { ok: false, reason: `returned ${kind} hits lack matching request semantics` };
      }
      for (const hitValue of hits) {
        const hit = String(hitValue || "").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
        if (!hit || !title.includes(hit)) {
          return { ok: false, reason: "returned semantic hit is not present in returned title" };
        }
        if ((kind === "model" || kind === "title") && !expected[`expect_${kind}`].includes(hit)) {
          return { ok: false, reason: `returned ${kind} hit is not bound to request semantics` };
        }
        explicitHitCount += 1;
      }
    }
    if (!explicitHitCount) {
      return { ok: false, reason: "returned row has no explicit title/model/category semantic hit" };
    }
    if (expected.expect_model && !(Array.isArray(semanticHits.model) && semanticHits.model.length)) {
      return { ok: false, reason: "returned row does not match the required model token" };
    }
    if (!expected.expect_model && !(Array.isArray(semanticHits.title) && semanticHits.title.length)) {
      return { ok: false, reason: "returned row has only category evidence, not a strong title match" };
    }
    offerIds.add(offerId);
    evidencePrices.push(price);
  }
  const prices = Array.isArray(filteredPrices)
    ? filteredPrices.map(Number).filter(Number.isFinite)
    : [];
  if (!equalNumericMultiset(evidencePrices, prices)) {
    return { ok: false, reason: "returned evidence price set does not match filtered prices" };
  }
  const selectedCluster = Array.isArray(evidence?.selected_cluster) ? evidence.selected_cluster : [];
  if (selectedCluster.length < requiredMatches) {
    return { ok: false, reason: `selected returned cluster insufficient ${selectedCluster.length}` };
  }
  const selectedIds = new Set();
  for (const row of selectedCluster) {
    const offerId = String(row?.offer_id || "").trim();
    const price = Number(row?.price);
    if (!offerId || selectedIds.has(offerId) || !offerIds.has(offerId)) {
      return { ok: false, reason: "selected cluster identity is missing, duplicate, or outside filtered rows" };
    }
    const sourceRow = rows.find((candidate) => String(candidate?.offer_id || "").trim() === offerId);
    if (!Number.isFinite(price) || Number(sourceRow?.price) !== price) {
      return { ok: false, reason: "selected cluster price is not bound to its filtered offer" };
    }
    if (contract === "1688-returned-same-item-v3"
      && String(row?.supplier_id || "").trim() !== String(sourceRow?.supplier_id || "").trim()) {
      return { ok: false, reason: "selected cluster supplier is not bound to its filtered offer" };
    }
    selectedIds.add(offerId);
  }
  if (!selectedCluster.some((row) => Number(row?.price) === Number(selectedCost))) {
    return { ok: false, reason: "selected cost is not present in the selected returned cluster" };
  }
  let balancedMatch = null;
  if (contract === "1688-returned-same-item-v3") {
    const semanticStrengths = new Set([
      "exact_model",
      "two_high_information_terms",
      "one_high_information_term",
      "one_high_information_plus_product",
      "product_semantics",
      "feature_only",
      "weak_or_none",
    ]);
    for (const row of rows) {
      const image = row?.image && typeof row.image === "object" ? row.image : null;
      if (!Number.isInteger(Number(row?.rank)) || Number(row.rank) < 1
        || typeof row?.supplier_id !== "string"
        || !image
        || !semanticStrengths.has(String(row?.semantic_strength || ""))
        || !Array.isArray(row?.spec_conflicts)
        || typeof row?.accessory_conflict !== "boolean") {
        return { ok: false, reason: "v3 row is missing rank, supplier, image, semantics or specification bindings" };
      }
      if (image.available === true && !/^https?:\/\//iu.test(String(row?.image_url || ""))) {
        return { ok: false, reason: "v3 image score is not bound to a returned image URL" };
      }
      if (image.available === true
        && (!Number.isFinite(Number(image.score)) || Number(image.score) < 0 || Number(image.score) > 1)) {
        return { ok: false, reason: "v3 row has an invalid image similarity score" };
      }
    }
    balancedMatch = evidence?.balanced_match && typeof evidence.balanced_match === "object"
      ? evidence.balanced_match
      : null;
    if (!balancedMatch) return { ok: false, reason: "missing balanced v3 match decision" };
    if (balancedMatch.image_available !== rows.some((row) => row?.image?.available === true)) {
      return { ok: false, reason: "balanced image availability is not bound to returned rows" };
    }
    const matchType = String(balancedMatch?.match_type || "");
    if (!["strong_single", "corroborated_multi", "rejected"].includes(matchType)) {
      return { ok: false, reason: "invalid balanced v3 match type" };
    }
    const supportingIds = Array.isArray(balancedMatch?.supporting_offer_ids)
      ? balancedMatch.supporting_offer_ids.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    if (new Set(supportingIds).size !== supportingIds.length
      || supportingIds.some((offerId) => !offerIds.has(offerId))) {
      return { ok: false, reason: "balanced support identities are invalid or outside returned rows" };
    }
    const supportingRows = supportingIds.map((offerId) => rows.find((row) => String(row?.offer_id || "").trim() === offerId));
    const cleanRow = (row) => Array.isArray(row?.spec_conflicts)
      && row.spec_conflicts.length === 0
      && row?.accessory_conflict === false;
    const imageScore = (row) => Number(row?.image?.score);
    const highImage = (row, threshold = 0.78) => row?.image?.available === true
      && Number.isFinite(imageScore(row))
      && imageScore(row) >= threshold;
    if (balancedMatch?.passed === true && matchType === "strong_single") {
      const row = supportingRows[0];
      const semanticStrength = String(row?.semantic_strength || "");
      const requiredImageScore = semanticStrength === "exact_model" ? 0.68 : 0.78;
      const semanticOk = ["exact_model", "two_high_information_terms"].includes(semanticStrength)
        || (semanticStrength === "one_high_information_term" && imageScore(row) >= 0.90);
      if (supportingRows.length !== 1
        || !Number.isInteger(Number(row?.rank))
        || Number(row.rank) < 1
        || Number(row.rank) > 3
        || !highImage(row, requiredImageScore)
        || !cleanRow(row)
        || !semanticOk) {
        return { ok: false, reason: "strong-single v3 evidence does not satisfy rank, image, semantics and specifications" };
      }
    } else if (balancedMatch?.passed === true && matchType === "corroborated_multi") {
      const suppliers = supportingRows.map((row) => String(row?.supplier_id || "").trim());
      if (supportingRows.length < 2
        || suppliers.some((value) => !value)
        || new Set(suppliers).size !== suppliers.length
        || supportingRows.some((row) => !cleanRow(row))
        || supportingRows.some((row) => ![
          "exact_model",
          "two_high_information_terms",
          "one_high_information_term",
          "one_high_information_plus_product",
          "product_semantics",
        ].includes(String(row?.semantic_strength || "")))
        || !supportingRows.some((row) => highImage(row, 0.58))) {
        return { ok: false, reason: "multi-source v3 evidence lacks independent suppliers, semantics, image or specification agreement" };
      }
    } else if (balancedMatch?.passed !== false || matchType !== "rejected" || supportingIds.length) {
      return { ok: false, reason: "rejected v3 evidence has inconsistent decision fields" };
    }
    if (requireBalancedMatch && balancedMatch.passed !== true) {
      return { ok: false, reason: `balanced match rejected: ${String(balancedMatch.reason || "unknown")}` };
    }
  } else if (requireBalancedMatch) {
    return { ok: false, reason: "balanced matching requires v3 evidence" };
  }
  return {
    ok: true,
    contract: evidence.contract,
    key,
    matched_offer_count: rows.length,
    balanced_match: balancedMatch?.passed === true,
    balanced_match_type: balancedMatch?.match_type || null,
    balanced_match_reason: balancedMatch?.reason || null,
    image_check_available: balancedMatch?.image_available === true,
  };
}

export function sameItemCostEvidence(cost = {}, { minimumMatches = 3 } = {}) {
  const requiredMatches = Math.max(1, Number(minimumMatches) || 1);
  const source = String(cost?.source || "").trim();
  const matchEvidenceKey = String(cost?.match_evidence_key || "").trim();
  const prices = Array.isArray(cost?.prices)
    ? cost.prices.map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  const verified = cost?.ok === true
    && Number(cost?.cost) > 0
    && isReliable1688CostSource(source)
    && isValid1688MatchEvidenceKey(matchEvidenceKey)
    && cost?.same_item_match === true
    && cost?.returned_evidence_verified === true
    && ["1688-returned-same-item-v2", "1688-returned-same-item-v3"].includes(cost?.match_evidence_contract)
    && Number(cost?.matched_offer_count) >= requiredMatches
    && prices.length >= requiredMatches;
  return {
    contract: "1688-same-item-v1",
    source,
    reliable_source: isReliable1688CostSource(source),
    same_item_match: verified,
    match_evidence_key: matchEvidenceKey || null,
    filtered_price_count: prices.length,
    match_evidence_contract: verified ? cost.match_evidence_contract : null,
    returned_evidence_verified: verified,
    matched_offer_count: verified ? Number(cost.matched_offer_count) : 0,
  };
}

export function hasReliableSameItemCostEvidence(data = {}, { minimumMatches = 3 } = {}) {
  const requiredMatches = Math.max(1, Number(minimumMatches) || 1);
  const cost = data?.cost || {};
  const evidence = data?.cost_evidence || {};
  const source = String(data?.cost_source || cost?.source || "").trim();
  const prices = Array.isArray(cost?.prices)
    ? cost.prices.map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  return data?.cost_verified === true
    && cost?.ok === true
    && Number(cost?.cost) > 0
    && evidence?.contract === "1688-same-item-v1"
    && evidence?.reliable_source === true
    && evidence?.same_item_match === true
    && evidence?.returned_evidence_verified === true
    && ["1688-returned-same-item-v2", "1688-returned-same-item-v3"].includes(evidence?.match_evidence_contract)
    && Number(evidence?.matched_offer_count) >= requiredMatches
    && isReliable1688CostSource(source)
    && String(evidence?.source || "") === source
    && isValid1688MatchEvidenceKey(evidence?.match_evidence_key)
    && String(evidence.match_evidence_key) === String(cost?.match_evidence_key || "")
    && cost?.same_item_match === true
    && cost?.returned_evidence_verified === true
    && cost?.match_evidence_contract === evidence.match_evidence_contract
    && Number(cost?.matched_offer_count) === Number(evidence?.matched_offer_count)
    && Number(evidence?.filtered_price_count) >= requiredMatches
    && prices.length >= requiredMatches;
}
