const POLICY_VERSION = 1;
const DEFAULT_FREEZE_MS = 2 * 60 * 60_000;
const EXCLUDED_SKUS = new Set(["2815247918"]);

function timestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function eventTimestamp(row = {}) {
  return timestamp(
    row.published_at
      || row.at
      || row.timestamp
      || row.data?.published_at
      || row.data?.at
      || row.data?.timestamp,
  );
}

function normalizedSku(row = {}) {
  return String(row.sku ?? row.id ?? row.data?.sku ?? row.data?.id ?? "").trim();
}

export function sellerRootUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || !/(?:^|\.)ozon\.ru$/iu.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/seller\/[^/]+\/?/iu);
    if (!match) return null;
    url.pathname = match[0].endsWith("/") ? match[0] : `${match[0]}/`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function rowSeller(row = {}) {
  const value = row?.data && typeof row.data === "object"
    ? { ...row, ...row.data }
    : row;
  return sellerRootUrl(
    value.seller_url
      || value.source_url
      || value.url
      || value.href,
  );
}

function inWindow(row, startedMs, endedMs) {
  const at = eventTimestamp(row);
  return at !== null && at >= startedMs && at <= endedMs;
}

function isStrictSellerPublication(row = {}) {
  const value = row?.data && typeof row.data === "object"
    ? { ...row, ...row.data }
    : row;
  const sku = normalizedSku(value);
  const shippingMode = String(
    value.shipping_mode || value.preflight_mode || value.mode || "",
  ).toUpperCase();
  const strictProof = value.strict_confirmed === true
    || (value.strict_confirmed === undefined && String(value.status || "") === "published");
  return Boolean(sku)
    && !EXCLUDED_SKUS.has(sku)
    && strictProof
    && String(value.online_status || "").toLowerCase() === "selling"
    && Number(value.stock) > 0
    && Number(value.profit_rate) > 30
    && shippingMode === "FBS"
    && value.fbs_evidence?.verified === true
    && value.cost_verified === true
    && value.cost?.ok === true
    && Number(value.cost?.cost) > 0
    && value.quality_gate_passed === true;
}

function isHistoricalStrictBootstrapPublication(row = {}) {
  const value = row?.data && typeof row.data === "object"
    ? { ...row, ...row.data }
    : row;
  const sku = normalizedSku(value);
  const shippingMode = String(
    value.shipping_mode || value.preflight_mode || value.mode || "",
  ).toUpperCase();
  return Boolean(sku)
    && !EXCLUDED_SKUS.has(sku)
    && String(value.status || "").toLowerCase() === "published"
    && value.strict_confirmed === true
    && String(value.online_status || "").toLowerCase() === "selling"
    && Number(value.stock) > 0
    && Number(value.profit_rate) > 30
    && shippingMode === "FBS";
}

function submissionInWindow(row, startedMs, endedMs) {
  const value = row?.data && typeof row.data === "object"
    ? { ...row, ...row.data }
    : row;
  const submittedAt = timestamp(value?.submitted_at || value?.created_at);
  return submittedAt !== null && submittedAt >= startedMs && submittedAt <= endedMs;
}

function sourcePage(root, page) {
  const url = new URL(root);
  if (page > 1) url.searchParams.set("page", String(page));
  return url.toString();
}

function safeRandom(rng) {
  const value = Number(rng());
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.999999999999, Math.max(0, value));
}

function weightedSeller(rows, rng) {
  const total = rows.reduce((sum, row) => sum + Number(row.score || 0), 0);
  if (!(total > 0)) return rows[0] || null;
  let cursor = safeRandom(rng) * total;
  for (const row of rows) {
    cursor -= Number(row.score || 0);
    if (cursor < 0) return row;
  }
  return rows.at(-1) || null;
}

function nextPageUrl(root, pageCounters) {
  const page = Number(pageCounters.get(root) || 0) + 1;
  pageCounters.set(root, page);
  return sourcePage(root, page);
}

function frozenDecision(previousDecision, nowMs, {
  historicalBootstrapHasStrict = false,
} = {}) {
  if (!previousDecision || Number(previousDecision.policy_version) !== POLICY_VERSION) return null;
  const previousUrls = [...(previousDecision.active_urls || [])];
  if (previousDecision.derived_search_enabled !== false
    || previousUrls.length === 0
    || previousUrls.some((url) => !sellerRootUrl(url))) {
    return null;
  }
  const frozenUntil = timestamp(previousDecision.frozen_until);
  if (!(frozenUntil !== null && nowMs < frozenUntil)) return null;
  const previousExploit = Math.max(0, Number(previousDecision?.allocation?.exploit) || 0);
  if (
    historicalBootstrapHasStrict
    && previousExploit === 0
  ) {
    return null;
  }
  return {
    ...previousDecision,
    active_urls: previousUrls,
    reason: previousDecision.evidence_mode === "historical-strict-bootstrap"
      ? "historical-strict-bootstrap-frozen-reused"
      : "frozen-policy-reused",
    evaluated_at: new Date(nowMs).toISOString(),
  };
}

export function buildStrictSellerSourcePolicy({
  detailAttempts = [],
  publications = [],
  historicalBootstrapRows = [],
  explorationSellerUrls = [],
  previousDecision = null,
  windowStartedAt = null,
  now = new Date(),
  freezeMs = DEFAULT_FREEZE_MS,
  slots = 10,
  exploitRatio = 0.9,
  rng = Math.random,
} = {}) {
  const nowMs = timestamp(now);
  if (nowMs === null) throw new TypeError("source policy now must be a valid timestamp");
  const configuredWindowStart = timestamp(windowStartedAt);
  const startedMs = configuredWindowStart ?? Math.max(0, nowMs - DEFAULT_FREEZE_MS);
  const maximumSlots = Math.max(1, Math.floor(Number(slots) || 10));
  const sellerEvidence = new Map();
  const evidenceFor = (root) => {
    const evidence = sellerEvidence.get(root) || {
      seller_url: root,
      attempt_skus: new Set(),
      strict_skus: new Set(),
    };
    sellerEvidence.set(root, evidence);
    return evidence;
  };

  for (const row of detailAttempts || []) {
    if (!inWindow(row, startedMs, nowMs)) continue;
    const stage = String(row?.stage || row?.data?.stage || "");
    if (stage && stage !== "ozon_detail_and_category") continue;
    const sku = normalizedSku(row);
    const root = rowSeller(row);
    if (sku && root && !EXCLUDED_SKUS.has(sku)) evidenceFor(root).attempt_skus.add(sku);
  }
  for (const row of publications || []) {
    if (
      !inWindow(row, startedMs, nowMs)
      || !submissionInWindow(row, startedMs, nowMs)
      || !isStrictSellerPublication(row)
    ) continue;
    const sku = normalizedSku(row);
    const root = rowSeller(row);
    if (root) evidenceFor(root).strict_skus.add(sku);
  }

  const historicalSellerEvidence = new Map();
  const historicalEvidenceFor = (root) => {
    const evidence = historicalSellerEvidence.get(root) || {
      seller_url: root,
      attempt_skus: new Set(),
      strict_skus: new Set(),
    };
    historicalSellerEvidence.set(root, evidence);
    return evidence;
  };
  const historicalSellerBySku = new Map();
  for (const row of historicalBootstrapRows || []) {
    const sku = normalizedSku(row);
    const root = rowSeller(row);
    if (sku && root && !EXCLUDED_SKUS.has(sku)) historicalSellerBySku.set(sku, root);
  }
  for (const row of historicalBootstrapRows || []) {
    const sku = normalizedSku(row);
    const root = rowSeller(row);
    if (
      !sku
      || !root
      || EXCLUDED_SKUS.has(sku)
      || historicalSellerBySku.get(sku) !== root
    ) {
      continue;
    }
    historicalEvidenceFor(root).attempt_skus.add(sku);
    if (isHistoricalStrictBootstrapPublication(row)) {
      historicalEvidenceFor(root).strict_skus.add(sku);
    }
  }

  const sellersFor = (evidenceBySeller, evidenceScope) => (
    [...evidenceBySeller.values()].map((evidence) => {
      const attempts = evidence.attempt_skus.size;
      const strict = [...evidence.strict_skus]
        .filter((sku) => evidence.attempt_skus.has(sku))
        .length;
      return {
        seller_url: evidence.seller_url,
        unique_detail_attempts: attempts,
        unique_strict: strict,
        score: attempts > 0 ? strict / attempts : 0,
        evidence_scope: evidenceScope,
      };
    }).sort((left, right) => (
      right.score - left.score
        || right.unique_strict - left.unique_strict
        || left.seller_url.localeCompare(right.seller_url)
    ))
  );
  const summarize = (sellers, evidenceBySeller) => ({
    unique_detail_attempts: new Set(sellers.flatMap((row) => (
      [...(evidenceBySeller.get(row.seller_url)?.attempt_skus || [])]
    ))).size,
    unique_strict: new Set(sellers.flatMap((row) => (
      [...(evidenceBySeller.get(row.seller_url)?.strict_skus || [])]
        .filter((sku) => evidenceBySeller.get(row.seller_url)?.attempt_skus.has(sku))
    ))).size,
    verified_sellers: sellers.filter((row) => row.unique_strict > 0 && row.score > 0).length,
  });
  const currentWindowSellers = sellersFor(sellerEvidence, "current-window");
  const historicalBootstrapSellers = sellersFor(
    historicalSellerEvidence,
    "historical-strict-bootstrap",
  );
  const currentWindowVerified = currentWindowSellers.filter(
    (row) => row.unique_strict > 0 && row.score > 0,
  );
  const historicalBootstrapVerified = historicalBootstrapSellers.filter(
    (row) => row.unique_strict > 0 && row.score > 0,
  );
  const currentWindowSummary = summarize(currentWindowSellers, sellerEvidence);
  const historicalBootstrapSummary = summarize(
    historicalBootstrapSellers,
    historicalSellerEvidence,
  );
  const reused = frozenDecision(previousDecision, nowMs, {
    historicalBootstrapHasStrict: historicalBootstrapVerified.length > 0,
  });
  if (reused) return reused;

  const useHistoricalBootstrap = (
    currentWindowVerified.length === 0
    && historicalBootstrapVerified.length > 0
  );
  const evidenceMode = useHistoricalBootstrap
    ? "historical-strict-bootstrap"
    : "current-window";
  const effectiveEvidence = useHistoricalBootstrap
    ? historicalSellerEvidence
    : sellerEvidence;
  const sellers = useHistoricalBootstrap
    ? historicalBootstrapSellers
    : currentWindowSellers;
  const verified = useHistoricalBootstrap
    ? historicalBootstrapVerified
    : currentWindowVerified;
  /*
   * Historical rows rank sellers only. They are never copied into publications,
   * current-window counters, or per-SKU quality evidence.
   */
  const historicalBootstrap = {
    source: "history/source_yield_history.jsonl",
    evidence_window: "all-persisted-history",
    eligibility:
      "status=published,strict_confirmed=true,online_status=selling,stock>0,"
      + "profit_rate>30,shipping_mode=FBS",
    ...historicalBootstrapSummary,
  };

  const verifiedRoots = new Set(verified.map((row) => row.seller_url));
  const exploration = [...new Set([
    ...explorationSellerUrls,
    ...sellers.filter((row) => row.unique_strict === 0).map((row) => row.seller_url),
    ...currentWindowSellers
      .filter((row) => row.unique_strict === 0)
      .map((row) => row.seller_url),
  ].map(sellerRootUrl).filter((root) => root && !verifiedRoots.has(root)))].sort();

  const intendedExploit = verified.length > 0
    ? Math.min(maximumSlots, Math.floor(maximumSlots * Math.min(1, Math.max(0, Number(exploitRatio)))))
    : 0;
  const intendedExplore = maximumSlots - intendedExploit;
  const activeUrls = [];
  const pageCounters = new Map();
  for (let index = 0; index < intendedExploit; index += 1) {
    const selected = weightedSeller(verified, rng);
    if (!selected) break;
    activeUrls.push(nextPageUrl(selected.seller_url, pageCounters));
  }
  let remainingExploration = [...exploration];
  for (let index = 0; index < intendedExplore && exploration.length > 0; index += 1) {
    if (remainingExploration.length === 0) remainingExploration = [...exploration];
    const selectedIndex = Math.floor(safeRandom(rng) * remainingExploration.length);
    const [selected] = remainingExploration.splice(selectedIndex, 1);
    activeUrls.push(nextPageUrl(selected, pageCounters));
  }

  return {
    policy_version: POLICY_VERSION,
    generated_at: new Date(nowMs).toISOString(),
    evaluated_at: new Date(nowMs).toISOString(),
    frozen_until: new Date(nowMs + Math.max(DEFAULT_FREEZE_MS, Number(freezeMs) || 0)).toISOString(),
    evidence_window: {
      started_at: new Date(startedMs).toISOString(),
      ended_at: new Date(nowMs).toISOString(),
    },
    evidence_mode: evidenceMode,
    reason: useHistoricalBootstrap
      ? "historical-strict-bootstrap-refreshed"
      : "strict-seller-policy-refreshed",
    derived_search_enabled: false,
    allocation: {
      exploit: activeUrls.slice(0, intendedExploit).length,
      explore: Math.max(0, activeUrls.length - intendedExploit),
    },
    unique_detail_attempts: new Set(sellers.flatMap((row) => (
      [...(effectiveEvidence.get(row.seller_url)?.attempt_skus || [])]
    ))).size,
    unique_strict: new Set(sellers.flatMap((row) => (
      [...(effectiveEvidence.get(row.seller_url)?.strict_skus || [])]
        .filter((sku) => effectiveEvidence.get(row.seller_url)?.attempt_skus.has(sku))
    ))).size,
    current_window: currentWindowSummary,
    historical_bootstrap: historicalBootstrap,
    sellers,
    active_urls: activeUrls,
  };
}
