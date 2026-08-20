import fs from "node:fs/promises";
import path from "node:path";

const CONTROLLED_KEYS = [
  "FLOW_B_TAB_WORKERS",
  "FLOW_B_MAX_TAB_WORKERS",
  "FLOW_B_FAVORITE_WORKERS",
  "FLOW_B_FAVORITE_DETAIL_INTERVAL_MS",
  "FLOW_B_MIN_FAVORITE_DETAIL_INTERVAL_MS",
  "FLOW_B_STRICT_EXPLOIT_BURST",
  "FLOW_B_DERIVED_SEARCH_SOURCES",
  "FLOW_B_DERIVED_PRIORITY_SOURCES",
  "FLOW_B_PRIORITIZE_DERIVED_SEARCH",
  "FLOW_B_SOURCE_STRICT_WEIGHT",
  "FLOW_B_SOURCE_FBS_WEIGHT",
  "FLOW_B_SOURCE_EXPLORE_WEIGHT",
];

function safeBaseOverrides({ favoriteDetailIntervalMs = 4_000, favoriteDetailMinIntervalMs = 4_000 } = {}) {
  const detailIntervalFloor = Math.max(
    4_000,
    Number(favoriteDetailIntervalMs) || 0,
    Number(favoriteDetailMinIntervalMs) || 0,
  );
  return {
    FLOW_B_FAVORITE_DETAIL_INTERVAL_MS: String(detailIntervalFloor),
    FLOW_B_MIN_FAVORITE_DETAIL_INTERVAL_MS: String(detailIntervalFloor),
    FLOW_B_STRICT_EXPLOIT_BURST: "12",
  };
}

const SOURCE_PORTFOLIO_WINDOW_MS = 30 * 60_000;
const SOURCE_BIAS_MIN_DWELL_MS = 20 * 60_000;
const SOURCE_BIAS_PROFILES = new Set(["seller-fbs-bias", "search-strict-bias", "dry-search-veto"]);

export function chooseLowTokenIntervention({
  collectionAttempts = 0,
  favorites = 0,
  softBlocks = 0,
  strictPerHour = 0,
  sourceTypes = {},
  lifetimeSourceTypes = {},
} = {}, safety = {}) {
  const safeBase = safeBaseOverrides(safety);
  const attempts = Math.max(0, Number(collectionAttempts) || 0);
  const pureFbsYield = attempts > 0 ? Math.max(0, Number(favorites) || 0) / attempts : 0;
  if (Number(softBlocks) > 0) {
    return {
      profile: "cooldown",
      reason: "recent-ozon-soft-blocks",
      overrides: {
        FLOW_B_TAB_WORKERS: "3",
        FLOW_B_MAX_TAB_WORKERS: "4",
        FLOW_B_FAVORITE_WORKERS: "3",
        ...safeBase,
      },
    };
  }
  if (attempts < 30) return { profile: "observe", reason: "insufficient-evidence", overrides: {} };
  if (Number(strictPerHour) >= 35) return { profile: "stable", reason: "strict-pace-sustained", overrides: {} };
  const typeStatsFrom = (portfolio, type) => {
    const value = portfolio?.[type] || {};
    const typeAttempts = Math.max(0, Number(value.attempts) || 0);
    const typeFavorites = Math.max(0, Number(value.favorites) || 0);
    const typeStrict = Math.max(0, Number(value.strict) || 0);
    return {
      attempts: typeAttempts,
      favorites: typeFavorites,
      strict: typeStrict,
      yield: typeAttempts > 0 ? typeFavorites / typeAttempts : 0,
      strictYield: typeAttempts > 0 ? typeStrict / typeAttempts : 0,
    };
  };
  const typeStats = (type) => typeStatsFrom(sourceTypes, type);
  const search = typeStats("search");
  const seller = typeStats("seller");
  const highlight = typeStats("highlight");
  const nonSearchAttempts = seller.attempts + highlight.attempts;
  const nonSearchFavorites = seller.favorites + highlight.favorites;
  const nonSearchStrict = seller.strict + highlight.strict;
  const nonSearchYield = nonSearchAttempts > 0 ? nonSearchFavorites / nonSearchAttempts : 0;
  const nonSearchStrictYield = nonSearchAttempts > 0 ? nonSearchStrict / nonSearchAttempts : 0;
  const sourceStrictEvidence = search.strict + nonSearchStrict;
  if (search.attempts >= 30 && nonSearchAttempts >= 30 && sourceStrictEvidence >= 5
    && search.strictYield - nonSearchStrictYield >= 0.015
    && search.strictYield >= nonSearchStrictYield * 1.5) {
    return {
      profile: "search-strict-bias",
      reason: "search-strict-yield-above-source-mix",
      overrides: {
        FLOW_B_TAB_WORKERS: "4",
        FLOW_B_MAX_TAB_WORKERS: "4",
        FLOW_B_FAVORITE_WORKERS: "4",
        ...safeBase,
        FLOW_B_DERIVED_SEARCH_SOURCES: "100",
        FLOW_B_DERIVED_PRIORITY_SOURCES: "24",
        FLOW_B_PRIORITIZE_DERIVED_SEARCH: "1",
        FLOW_B_SOURCE_STRICT_WEIGHT: "7",
        FLOW_B_SOURCE_FBS_WEIGHT: "2",
        FLOW_B_SOURCE_EXPLORE_WEIGHT: "1",
      },
    };
  }
  if (search.attempts >= 30 && search.yield < 0.15
    && nonSearchAttempts >= 30 && nonSearchYield >= 0.2) {
    return {
      profile: "seller-fbs-bias",
      reason: "search-fbs-yield-below-source-mix",
      overrides: {
        FLOW_B_TAB_WORKERS: "4",
        FLOW_B_MAX_TAB_WORKERS: "4",
        FLOW_B_FAVORITE_WORKERS: "4",
        ...safeBase,
        FLOW_B_DERIVED_SEARCH_SOURCES: "0",
        FLOW_B_DERIVED_PRIORITY_SOURCES: "0",
        FLOW_B_PRIORITIZE_DERIVED_SEARCH: "0",
        FLOW_B_SOURCE_STRICT_WEIGHT: "6",
        FLOW_B_SOURCE_FBS_WEIGHT: "3",
        FLOW_B_SOURCE_EXPLORE_WEIGHT: "1",
      },
    };
  }
  const lifetimeSearch = typeStatsFrom(lifetimeSourceTypes, "search");
  const lifetimeNonSearch = ["seller", "highlight", "other"]
    .map((type) => typeStatsFrom(lifetimeSourceTypes, type))
    .reduce((total, stats) => ({
      attempts: total.attempts + stats.attempts,
      favorites: total.favorites + stats.favorites,
      strict: total.strict + stats.strict,
    }), { attempts: 0, favorites: 0, strict: 0 });
  const lifetimeSearchDry = lifetimeSearch.attempts >= 30
    && lifetimeSearch.yield < 0.02
    && lifetimeSearch.strict === 0
    && lifetimeNonSearch.favorites >= 5;
  if (pureFbsYield < 0.15 && lifetimeSearchDry) {
    return {
      profile: "dry-search-veto",
      reason: "lifetime-search-zero-yield",
      overrides: {
        FLOW_B_TAB_WORKERS: "3",
        FLOW_B_MAX_TAB_WORKERS: "4",
        FLOW_B_FAVORITE_WORKERS: "3",
        ...safeBase,
        FLOW_B_DERIVED_SEARCH_SOURCES: "0",
        FLOW_B_DERIVED_PRIORITY_SOURCES: "0",
        FLOW_B_PRIORITIZE_DERIVED_SEARCH: "0",
        FLOW_B_SOURCE_STRICT_WEIGHT: "6",
        FLOW_B_SOURCE_FBS_WEIGHT: "3",
        FLOW_B_SOURCE_EXPLORE_WEIGHT: "1",
      },
    };
  }
  if (pureFbsYield < 0.15) {
    return {
      profile: "exploit",
      reason: "low-pure-fbs-yield",
      overrides: {
        FLOW_B_TAB_WORKERS: "3",
        FLOW_B_MAX_TAB_WORKERS: "4",
        FLOW_B_FAVORITE_WORKERS: "3",
        ...safeBase,
        FLOW_B_DERIVED_SEARCH_SOURCES: "100",
      },
    };
  }
  return {
    profile: "balanced",
    reason: "healthy-fbs-yield-below-strict-pace",
    overrides: {
      FLOW_B_TAB_WORKERS: "4",
      FLOW_B_MAX_TAB_WORKERS: "4",
      FLOW_B_FAVORITE_WORKERS: "4",
        ...safeBase,
    },
  };
}

async function readJsonLines(filename) {
  try {
    return (await fs.readFile(filename, "utf8")).split(/\n+/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function recentMetrics(runDir, nowMs) {
  const collection = await readJsonLines(path.join(runDir, "favorite_collection.jsonl"));
  const published = await readJsonLines(path.join(runDir, "published.jsonl"));
  let acceptanceWindowStart = nowMs - 24 * 60 * 60_000;
  try {
    const window = JSON.parse(await fs.readFile(path.join(runDir, "acceptance_window.json"), "utf8"));
    const parsed = Date.parse(window?.started_at || "");
    if (Number.isFinite(parsed)) acceptanceWindowStart = parsed;
  } catch {}
  const inRecentWindow = (value, durationMs) => {
    const at = Date.parse(value || "");
    return Number.isFinite(at) && at >= nowMs - durationMs && at <= nowMs;
  };
  const inAcceptanceWindow = (value) => {
    const at = Date.parse(value || "");
    return Number.isFinite(at) && at >= acceptanceWindowStart && at <= nowMs;
  };
  const recentCollection = collection.filter((row) => inRecentWindow(row?.at, SOURCE_PORTFOLIO_WINDOW_MS));
  const recentSoftBlocks = collection.filter((row) => inRecentWindow(row?.at, SOURCE_PORTFOLIO_WINDOW_MS)
    && (/ozon-soft-block/i.test(String(row?.reason || ""))
      || /soft block|access denied/i.test(String(row?.error || row?.message || ""))));
  const sourceType = (value) => {
    const url = String(value || "");
    if (/\/seller\//i.test(url)) return "seller";
    if (/\/highlight\//i.test(url)) return "highlight";
    if (/\/search\//i.test(url)) return "search";
    return "other";
  };
  const sourceTypes = {};
  const lifetimeSourceTypes = {};
  const addCollectionEvidence = (portfolio, row) => {
    const type = sourceType(row?.source_url);
    const stats = portfolio[type] || { attempts: 0, favorites: 0, strict: 0 };
    stats.attempts += 1;
    if (row?.status === "favorited") stats.favorites += 1;
    portfolio[type] = stats;
  };
  for (const row of collection) {
    if (!inAcceptanceWindow(row?.at)
      || !["favorited", "rejected", "failed"].includes(String(row?.status))) continue;
    addCollectionEvidence(lifetimeSourceTypes, row);
  }
  for (const row of recentCollection) {
    if (!["favorited", "rejected", "failed"].includes(String(row?.status))) continue;
    addCollectionEvidence(sourceTypes, row);
  }
  const publicationSku = (row) => String(row?.sku || row?.data?.sku || "").trim();
  const isStrictPublication = (row) => publicationSku(row)
    && publicationSku(row) !== "2815247918"
    && Number(row?.data?.profit_rate) > 30
    && String(row?.data?.online_status || "").toLowerCase() === "selling"
      && Number(row?.data?.stock) > 0;
  const recentStrictSkus = new Set();
  const lifetimeStrictSkus = new Set();
  for (const row of published) {
    const publishedAt = row?.data?.published_at || row?.timestamp;
    if (!isStrictPublication(row)) continue;
    const sku = publicationSku(row);
    const type = sourceType(row?.data?.source_url || row?.source_url);
    if (inAcceptanceWindow(publishedAt) && !lifetimeStrictSkus.has(sku)) {
      lifetimeStrictSkus.add(sku);
      const lifetimeStats = lifetimeSourceTypes[type] || { attempts: 0, favorites: 0, strict: 0 };
      lifetimeStats.strict += 1;
      lifetimeSourceTypes[type] = lifetimeStats;
    }
    if (inRecentWindow(publishedAt, SOURCE_PORTFOLIO_WINDOW_MS) && !recentStrictSkus.has(sku)) {
      recentStrictSkus.add(sku);
      const stats = sourceTypes[type] || { attempts: 0, favorites: 0, strict: 0 };
      stats.strict += 1;
      sourceTypes[type] = stats;
    }
  }
  const windowStart = Math.max(nowMs - 60 * 60_000, acceptanceWindowStart);
  const observedHours = Math.max(1 / 60, Math.min(1, (nowMs - windowStart) / 3_600_000));
  const strictSkus = new Set(published.flatMap((row) => {
    const at = Date.parse(row?.data?.published_at || row?.timestamp || "");
    return at >= windowStart && at <= nowMs && isStrictPublication(row) ? [publicationSku(row)] : [];
  }));
  return {
    collectionAttempts: recentCollection.filter((row) => ["favorited", "rejected", "failed"].includes(String(row?.status))).length,
    favorites: recentCollection.filter((row) => row?.status === "favorited").length,
    softBlocks: recentSoftBlocks.length,
    strictPerHour: Number((strictSkus.size / observedHours).toFixed(2)),
    sourceTypes,
    lifetimeSourceTypes,
  };
}

export function createLowTokenInterventionController({
  runDir,
  env,
  now = () => Date.now(),
  sourceBiasMinDwellMs = SOURCE_BIAS_MIN_DWELL_MS,
}) {
  const root = path.resolve(runDir);
  const baseline = Object.fromEntries(CONTROLLED_KEYS.map((key) => [key, env[key]]));
  let lastProfile = null;
  let lastDecision = null;
  let lastProfileChangedAt = null;
  return {
    async refresh() {
      if (env.FLOW_B_LOW_TOKEN_INTERVENTION !== "1") return { profile: "disabled", reason: "not-enabled", overrides: {} };
      const currentTime = now();
      const metrics = await recentMetrics(root, currentTime);
      const measuredDecision = chooseLowTokenIntervention(metrics, {
        favoriteDetailIntervalMs: baseline.FLOW_B_FAVORITE_DETAIL_INTERVAL_MS,
        favoriteDetailMinIntervalMs: baseline.FLOW_B_MIN_FAVORITE_DETAIL_INTERVAL_MS,
      });
      const sourceBiasDwellRemaining = lastDecision
        && SOURCE_BIAS_PROFILES.has(lastDecision.profile)
        && measuredDecision.profile !== lastDecision.profile
        && !["cooldown", "stable"].includes(measuredDecision.profile)
        && Number.isFinite(lastProfileChangedAt)
        && currentTime - lastProfileChangedAt < Math.max(0, Number(sourceBiasMinDwellMs) || 0);
      const decision = sourceBiasDwellRemaining ? lastDecision : measuredDecision;
      for (const key of CONTROLLED_KEYS) {
        if (baseline[key] === undefined) delete env[key];
        else env[key] = baseline[key];
      }
      Object.assign(env, decision.overrides);
      if (decision.profile !== lastProfile) {
        await fs.appendFile(path.join(root, "low_token_interventions.jsonl"), `${JSON.stringify({
          at: new Date(currentTime).toISOString(),
          ...decision,
          metrics,
        })}\n`);
        lastProfile = decision.profile;
        lastProfileChangedAt = currentTime;
      }
      if (!sourceBiasDwellRemaining || !lastDecision) lastDecision = decision;
      return { ...decision, metrics };
    },
  };
}
