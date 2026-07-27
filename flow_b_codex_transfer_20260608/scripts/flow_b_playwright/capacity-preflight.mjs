import { verifiedWarehouseCandidates } from "./publish-runner.mjs";

function localDayParts(value, timeZone = "Asia/Shanghai") {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("capacity preflight timestamp is invalid");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((entry) => [entry.type, entry.value]));
}

export function nextShanghaiQuotaReset(value = new Date()) {
  const parts = localDayParts(value);
  return new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day) + 1,
    -8,
  )).toISOString();
}

function normalizedResetAt(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function nextCapacityReset(rows, checkedAt) {
  const checkedMs = checkedAt.getTime();
  const erpReset = rows
    .filter((row) => Number(row.erp_daily_usage) > 0)
    .map((row) => row.erp_daily_reset_at)
    .filter((value) => value && Date.parse(value) > checkedMs)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  if (erpReset) {
    return {
      at: erpReset,
      source: "erp-daily-create",
    };
  }
  return {
    at: nextShanghaiQuotaReset(checkedAt),
    source: "shanghai-midnight-fallback",
  };
}

export function buildCapacityPreflight({
  configuredStores,
  erpStores,
  profileStores = [],
  checkedAt = new Date(),
  configuredDailyLimit = 100,
  requiredCapacity = 481,
} = {}) {
  if (!Array.isArray(configuredStores) || configuredStores.length !== 5) {
    throw new Error("capacity preflight requires exactly five configured stores");
  }
  if (!Array.isArray(erpStores)) throw new Error("ERP store list is required");
  const checked = checkedAt instanceof Date ? checkedAt : new Date(checkedAt);
  const day = localDayParts(checked);
  const rows = configuredStores.map((configured) => {
    const storeId = Number(configured?.id);
    const warehouseId = Number(configured?.warehouse_id ?? configured?.warehouseId);
    const erp = erpStores.find((row) => Number(row?.id) === storeId) || null;
    const profile = profileStores.find((row) => Number(row?.id) === storeId) || null;
    const merged = erp ? { ...erp, ...(profile ? { user_profile: profile } : {}) } : {};
    const warehouseCandidates = verifiedWarehouseCandidates(merged)
      .map((row) => ({
        warehouse_id: Number(row?.warehouse_id),
        name: String(row?.name ?? row?.title ?? "").trim() || null,
        type: String(row?.type ?? row?.warehouse_type ?? "").trim() || null,
        status: String(row?.status ?? row?.state ?? "").trim() || null,
      }))
      .filter((row) => Number.isSafeInteger(row.warehouse_id) && row.warehouse_id > 0);
    const candidates = warehouseCandidates.map((row) => row.warehouse_id);
    const warehouseVerified = Number.isSafeInteger(warehouseId)
      && warehouseId > 0
      && candidates.includes(warehouseId);
    const dailyCreate = erp?.product_limit?.daily_create ?? profile?.product_limit?.daily_create;
    const erpLimit = Number(dailyCreate?.limit);
    const erpUsage = Number(dailyCreate?.usage);
    const erpResetAt = normalizedResetAt(dailyCreate?.reset_at ?? dailyCreate?.resetAt);
    const quotaVerified = Number.isInteger(erpLimit)
      && erpLimit > 0
      && Number.isInteger(erpUsage)
      && erpUsage >= 0;
    const effectiveLimit = quotaVerified
      ? Math.min(Number(configuredDailyLimit), erpLimit)
      : null;
    const remaining = quotaVerified ? Math.max(0, effectiveLimit - erpUsage) : 0;
    return {
      store_id: storeId,
      store_name: String(erp?.name ?? erp?.title ?? configured?.name ?? ""),
      warehouse_id: warehouseId || null,
      warehouse_candidates: candidates,
      warehouse_candidate_details: warehouseCandidates,
      warehouse_verified: warehouseVerified,
      erp_daily_limit: quotaVerified ? erpLimit : null,
      erp_daily_usage: quotaVerified ? erpUsage : null,
      erp_daily_reset_at: erpResetAt,
      effective_daily_limit: effectiveLimit,
      remaining_capacity: remaining,
      quota_verified: quotaVerified,
      available: Boolean(erp && warehouseVerified && quotaVerified && remaining > 0),
    };
  });
  const totalRemainingCapacity = rows.reduce((sum, row) => sum + row.remaining_capacity, 0);
  const nextReset = nextCapacityReset(rows, checked);
  return {
    checked_at: checked.toISOString(),
    timezone: "Asia/Shanghai",
    quota_day: `${day.year}-${day.month}-${day.day}`,
    next_reset_at: nextReset.at,
    next_reset_source: nextReset.source,
    required_capacity: Number(requiredCapacity),
    total_remaining_capacity: totalRemainingCapacity,
    all_stores_found: rows.every((row) => row.store_name),
    all_warehouses_verified: rows.every((row) => row.warehouse_verified),
    all_quotas_verified: rows.every((row) => row.quota_verified),
    capacity_sufficient: totalRemainingCapacity >= Number(requiredCapacity),
    stores: rows,
  };
}
