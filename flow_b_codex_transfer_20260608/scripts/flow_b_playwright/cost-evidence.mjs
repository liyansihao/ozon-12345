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
} = {}) {
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
  if (evidence?.contract !== "1688-returned-same-item-v2") {
    return { ok: false, reason: "unsupported returned same-item evidence contract" };
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
  if (rows.length < 3) return { ok: false, reason: `returned semantic matches insufficient ${rows.length}` };
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
  if (selectedCluster.length < 3) {
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
    selectedIds.add(offerId);
  }
  if (!selectedCluster.some((row) => Number(row?.price) === Number(selectedCost))) {
    return { ok: false, reason: "selected cost is not present in the selected returned cluster" };
  }
  return {
    ok: true,
    contract: evidence.contract,
    key,
    matched_offer_count: rows.length,
  };
}

export function sameItemCostEvidence(cost = {}) {
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
    && cost?.match_evidence_contract === "1688-returned-same-item-v2"
    && Number(cost?.matched_offer_count) >= 3
    && prices.length >= 3;
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

export function hasReliableSameItemCostEvidence(data = {}) {
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
    && evidence?.match_evidence_contract === "1688-returned-same-item-v2"
    && Number(evidence?.matched_offer_count) >= 3
    && isReliable1688CostSource(source)
    && String(evidence?.source || "") === source
    && isValid1688MatchEvidenceKey(evidence?.match_evidence_key)
    && String(evidence.match_evidence_key) === String(cost?.match_evidence_key || "")
    && cost?.same_item_match === true
    && cost?.returned_evidence_verified === true
    && cost?.match_evidence_contract === evidence.match_evidence_contract
    && Number(cost?.matched_offer_count) === Number(evidence?.matched_offer_count)
    && Number(evidence?.filtered_price_count) >= 3
    && prices.length >= 3;
}
