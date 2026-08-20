import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  strict1688SupplyCandidates,
  supplyTargetVariant,
  validateSupplyEvidence,
} from "./publish-runner.mjs";

function text(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/\s+/gu, " ").trim();
  return normalized || null;
}

function auditKey(row = {}) {
  return `${text(row.shop_id) || "unknown"}:${text(row.offer_id) || text(row.sku) || text(row.id) || "unknown"}`;
}

function csvCell(value) {
  const normalized = value && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  return /[",\r\n]/u.test(normalized) ? `"${normalized.replace(/"/gu, '""')}"` : normalized;
}

async function readJsonLines(filename) {
  let content = "";
  try {
    content = await fs.readFile(filename, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const latest = new Map();
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.audit_key) latest.set(String(row.audit_key), row);
    } catch {}
  }
  return latest;
}

export function loadStrictPublicationsReadOnly(runtimeStateDbPath) {
  const filename = path.resolve(String(runtimeStateDbPath || ""));
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const strictRows = db.prepare(`
      SELECT sku, published_at, data_json
      FROM strict_publications
      ORDER BY published_at DESC, sku ASC
    `).all().map((row) => {
      let data = {};
      try { data = JSON.parse(String(row.data_json || "{}")); } catch {}
      return {
        sku: String(row.sku),
        published_at: row.published_at,
        data,
      };
    });
    const known = new Set(strictRows.map((row) => String(row.sku)));
    const directRows = db.prepare(`
      SELECT sku, updated_at AS published_at, data_json
      FROM sku_state
      WHERE strict = 0 AND (
        stage IN ('submitted', 'online', 'stock_updated')
        OR json_type(data_json, '$.submitted') = 'true'
        OR json_extract(data_json, '$.outcome_status') IN ('submitted', 'imported', 'online', 'stock_updated')
      )
      ORDER BY updated_at DESC, sku ASC
    `).all().flatMap((row) => {
      if (known.has(String(row.sku))) return [];
      let data = {};
      try { data = JSON.parse(String(row.data_json || "{}")); } catch {}
      if (!text(data.offer_id) && !text(data?.submission_payload?.rows?.[0]?.offer_id)) return [];
      known.add(String(row.sku));
      return [{
        sku: String(row.sku),
        published_at: row.published_at,
        data: {
          ...data,
          offer_id: data.offer_id || data?.submission_payload?.rows?.[0]?.offer_id,
        },
      }];
    });
    return [...strictRows, ...directRows];
  } finally {
    db.close();
  }
}

function runtimeIndexes(strictRows = []) {
  const byOfferId = new Map();
  const bySourceSku = new Map();
  const byStoreOfferId = new Map();
  const byStoreSourceSku = new Map();
  for (const row of strictRows) {
    const offerId = text(row?.data?.offer_id);
    const storeId = text(row?.data?.store_id ?? row?.shop_id);
    if (offerId && !byOfferId.has(offerId)) byOfferId.set(offerId, row);
    if (text(row?.sku) && !bySourceSku.has(String(row.sku))) bySourceSku.set(String(row.sku), row);
    if (storeId && offerId && !byStoreOfferId.has(`${storeId}:${offerId}`)) {
      byStoreOfferId.set(`${storeId}:${offerId}`, row);
    }
    if (storeId && text(row?.sku) && !byStoreSourceSku.has(`${storeId}:${row.sku}`)) {
      byStoreSourceSku.set(`${storeId}:${row.sku}`, row);
    }
  }
  return { byOfferId, bySourceSku, byStoreOfferId, byStoreSourceSku };
}

function sourceSkuFromOfferId(value) {
  const match = String(value || "").match(/^mz-\d{6}-(.+)$/u);
  return text(match?.[1]);
}

function matchRuntimeRow(online, indexes) {
  const offerId = text(online?.offer_id);
  const storeId = text(online?.shop_id ?? online?.store_id ?? online?.shop?.id);
  const sourceSku = sourceSkuFromOfferId(offerId) || text(online?.source_sku);
  return (storeId && offerId ? indexes.byStoreOfferId.get(`${storeId}:${offerId}`) : null)
    || (storeId && sourceSku ? indexes.byStoreSourceSku.get(`${storeId}:${sourceSku}`) : null)
    || indexes.byOfferId.get(offerId)
    || indexes.bySourceSku.get(sourceSku)
    || null;
}

function failureCategory(result = {}) {
  const candidateReasons = Array.isArray(result?.candidate_failures)
    ? result.candidate_failures.map((row) => `${row?.reason_code || ""} ${row?.reason || ""}`).join(" ")
    : "";
  const reason = `${result?.reason_code || ""} ${result?.reason || ""} ${result?.error || ""} ${candidateReasons}`;
  if (
    result?.global_gate_closed === true
    || result?.retryable === true
    || result?.transient === true
    || result?.status === "deferred"
    || /auth|login|captcha|timeout|navigation|network|验证码|超时|页面异常|会话失效/iu.test(reason)
  ) return "pending_recheck";
  if (/moq|minimum|起订|起批/iu.test(reason)) return "moq_gt_one";
  if (/spec|variant|model|color|size|capacity|型号|颜色|尺寸|容量|规格|套装/iu.test(reason)) return "wrong_spec";
  if (/stock|sold.?out|offline|removed|unavailable|404|缺货|无货|下架|失效/iu.test(reason)) return "out_of_stock_or_offline";
  if (/expired|timestamp|validity|contract|evidence|过期/iu.test(reason)) return "pending_recheck";
  return "no_same_item";
}

function recommendationFor(category) {
  if (category === "verified_orderable") return { action: "keep", priority: "none" };
  if (category === "pending_recheck") return { action: "recheck_after_login_or_page_recovery", priority: "medium" };
  if (category === "out_of_stock_or_offline") return { action: "review_stock_or_delist", priority: "critical" };
  return { action: "review_stock_or_delist", priority: "high" };
}

function auditSource(online, runtime) {
  const data = runtime?.data || {};
  const payloadRow = data?.submission_payload?.rows?.[0] || {};
  return {
    ...data,
    sku: runtime?.sku || sourceSkuFromOfferId(online?.offer_id) || online?.source_sku || online?.sku,
    title: data.title || online?.name || online?.title,
    cover_image: data.cover_image || data.image || payloadRow.cover_image || payloadRow.image || online?.primary_image,
    sell_price: Number(online?.price || data.sell_price || payloadRow.sell_price) || null,
    model: data.model || online?.model || null,
  };
}

export function summarizeOnlineSupplyAudit(rows = []) {
  const byStatus = {};
  const byPriority = {};
  for (const row of rows) {
    const status = String(row?.category || "unknown");
    const priority = String(row?.recommendation_priority || "unknown");
    byStatus[status] = (byStatus[status] || 0) + 1;
    byPriority[priority] = (byPriority[priority] || 0) + 1;
  }
  return {
    total: rows.length,
    by_status: byStatus,
    by_priority: byPriority,
    verified_orderable: Number(byStatus.verified_orderable || 0),
    review_recommended: rows.filter((row) => ["high", "critical"].includes(row?.recommendation_priority)).length,
    pending_recheck: Number(byStatus.pending_recheck || 0),
  };
}

export function createOnlineSupplyAuditor({
  costBridge,
  supplyVerifier,
  now = () => new Date(),
  runDir = process.cwd(),
  checkpointFile = path.join(runDir, "online_supply_audit_checkpoint.jsonl"),
  maximumOffers = 3,
  failureCacheMs = 5 * 60 * 1000,
} = {}) {
  if (!costBridge || typeof costBridge.estimate !== "function") throw new TypeError("costBridge.estimate is required");
  if (!supplyVerifier || typeof supplyVerifier.verify !== "function") throw new TypeError("supplyVerifier.verify is required");

  function reusableCheckpoint(row) {
    if (!row || typeof row !== "object") return false;
    if (row.category === "verified_orderable") {
      return validateSupplyEvidence(row?.details?.supply_evidence || {
        contract: "1688-orderable-v1",
        passed: true,
        platform: "1688",
        offer_id: row.supply_offer_id,
        offer_url: row.supply_offer_url,
        item_level_match: row?.details?.supply_evidence?.item_level_match,
        target_variant: row.target_variant,
        variant_attributes: row.variant_attributes,
        moq: row.moq,
        orderable_quantity: row.orderable_quantity,
        unit_price: row.unit_price,
        stock_state: row?.details?.supply_evidence?.stock_state,
        orderable: row?.details?.supply_evidence?.orderable,
        match_evidence_key: row?.details?.supply_evidence?.match_evidence_key,
        checked_at: row.checked_at,
        valid_until: row.valid_until,
      }, { at: now() }).ok;
    }
    const auditedAt = Date.parse(String(row.audited_at || ""));
    return Number.isFinite(auditedAt)
      && now().getTime() - auditedAt < Math.max(0, Number(failureCacheMs) || 0);
  }

  async function inspect(online, runtime) {
    const auditSourceRow = auditSource(online, runtime);
    const targetVariant = runtime?.data?.target_variant
      || supplyTargetVariant({ item: auditSourceRow, detail: runtime?.data || {}, productInfo: runtime?.data?.product_info || {} });
    if (!runtime) {
      const category = "pending_recheck";
      const recommendation = recommendationFor(category);
      return {
        category,
        reason: "runtime-source-mapping-missing",
        target_variant: targetVariant,
        ...recommendation,
      };
    }
    let cost = runtime?.data?.cost;
    if (!strict1688SupplyCandidates(cost, { maximum: maximumOffers }).length) {
      if (!auditSourceRow.cover_image) {
        const category = "pending_recheck";
        return {
          category,
          reason: "source-image-missing",
          target_variant: targetVariant,
          ...recommendationFor(category),
        };
      }
      try {
        cost = await costBridge.estimate({
          ...auditSourceRow,
          expect_title: auditSourceRow.title || "",
          expect_model: auditSourceRow.model || "",
          expect_category: runtime?.data?.category_labels?.slice?.(0, 2)?.join?.(" ") || "",
        }, runDir);
      } catch (error) {
        const category = "pending_recheck";
        return {
          category,
          reason: "cost-lookup-error",
          error: String(error?.message || error),
          target_variant: targetVariant,
          ...recommendationFor(category),
        };
      }
    }
    let candidates = strict1688SupplyCandidates(cost, { maximum: maximumOffers });
    if (!candidates.length) {
      const transientCost = cost?.deferred === true || cost?.terminal === false
        || /timeout|timed out|network|fetch|image|temporar|验证码|登录/iu.test(String(cost?.reason || cost?.error?.message || ""));
      const category = transientCost ? "pending_recheck" : "no_same_item";
      return {
        category,
        reason: transientCost ? "cost-lookup-deferred" : "no-v3-strict-same-item",
        cost,
        target_variant: targetVariant,
        ...recommendationFor(category),
      };
    }
    const verifyCandidates = async (candidateCost, candidateRows) => {
      try {
        return await supplyVerifier.verify({
          candidates: candidateRows,
          targetVariant,
          targetTitle: auditSourceRow.title || runtime?.data?.title || null,
          itemLevelMatch: targetVariant?.required !== true,
          matchEvidenceKey: candidateCost.match_evidence_key,
          balancedMatch: {
            passed: candidateCost.balanced_match === true,
            match_type: candidateCost.balanced_match_type,
            supporting_offer_ids: candidateCost.balanced_supporting_offer_ids || [],
          },
        });
      } catch (error) {
        return { ok: false, status: "deferred", reason: String(error?.message || error), retryable: true, transient: true };
      }
    };
    let result = await verifyCandidates(cost, candidates);
    if (
      result?.ok === false
      && result?.deterministic === true
      && result?.global_gate_closed !== true
      && auditSourceRow.cover_image
    ) {
      try {
        const excludedOfferIds = candidates.map((row) => row.offer_id);
        const replacementCost = await costBridge.estimate({
          ...auditSourceRow,
          excluded_1688_offer_ids: excludedOfferIds,
          expect_title: auditSourceRow.title || "",
          expect_model: auditSourceRow.model || "",
          expect_category: runtime?.data?.category_labels?.slice?.(0, 2)?.join?.(" ") || "",
        }, runDir);
        const replacementCandidates = strict1688SupplyCandidates(replacementCost, { maximum: maximumOffers })
          .filter((row) => !excludedOfferIds.includes(row.offer_id));
        if (replacementCandidates.length) {
          cost = replacementCost;
          candidates = replacementCandidates;
          result = await verifyCandidates(cost, candidates);
        }
      } catch (error) {
        result = {
          ok: false,
          status: "deferred",
          reason: `replacement sourcing failed: ${String(error?.message || error)}`,
          retryable: true,
          transient: true,
        };
      }
    }
    const evidence = result?.evidence || result;
    const validity = validateSupplyEvidence(evidence, {
      at: now(),
      matchEvidenceKey: cost.match_evidence_key,
      candidates,
      targetVariant,
      envelope: result,
    });
    const category = validity.ok
      ? "verified_orderable"
      : failureCategory(result?.ok === false ? result : { ...result, reason: validity.reason });
    const recommendation = recommendationFor(category);
    return {
      category,
      reason: validity.ok ? "supply-verified" : text(result?.reason_code || result?.reason) || validity.reason,
      cost,
      supply_evidence: validity.ok ? evidence : null,
      supply_result: validity.ok ? null : result,
      target_variant: targetVariant,
      candidates,
      ...recommendation,
    };
  }

  async function run({ onlineProducts = [], strictPublications = [], limit = 0, force = false } = {}) {
    await fs.mkdir(path.dirname(checkpointFile), { recursive: true });
    const previous = force ? new Map() : await readJsonLines(checkpointFile);
    const indexes = runtimeIndexes(strictPublications);
    const selected = Number(limit) > 0 ? onlineProducts.slice(0, Number(limit)) : onlineProducts;
    const rows = [];
    let globalGateClosed = null;
    for (const online of selected) {
      const key = auditKey(online);
      if (reusableCheckpoint(previous.get(key))) {
        rows.push(previous.get(key));
        continue;
      }
      const runtime = matchRuntimeRow(online, indexes);
      const result = globalGateClosed
        ? {
          category: "pending_recheck",
          reason: "1688-global-gate-closed",
          supply_result: globalGateClosed,
          target_variant: runtime?.data?.target_variant || null,
          ...recommendationFor("pending_recheck"),
        }
        : await inspect(online, runtime);
      if (result?.supply_result?.global_gate_closed === true) {
        globalGateClosed = result.supply_result;
      }
      const row = {
        audit_key: key,
        audited_at: now().toISOString(),
        shop_id: online?.shop_id ?? null,
        shop_name: online?.shop_name ?? online?.shop?.name ?? null,
        offer_id: online?.offer_id ?? null,
        product_id: online?.product_id ?? online?.id ?? null,
        source_sku: runtime?.sku ?? sourceSkuFromOfferId(online?.offer_id),
        ozon_title: online?.name ?? online?.title ?? runtime?.data?.title ?? null,
        online_status: online?.online_status ?? online?.status ?? null,
        current_stock: online?.stock ?? null,
        category: result.category,
        reason: result.reason,
        recommendation_action: result.action,
        recommendation_priority: result.priority,
        supply_offer_id: result?.supply_evidence?.offer_id ?? null,
        supply_offer_url: result?.supply_evidence?.offer_url ?? null,
        target_variant: result?.supply_evidence?.target_variant ?? result.target_variant ?? null,
        variant_attributes: result?.supply_evidence?.variant_attributes ?? null,
        moq: result?.supply_evidence?.moq ?? null,
        orderable_quantity: result?.supply_evidence?.orderable_quantity ?? null,
        unit_price: result?.supply_evidence?.unit_price ?? null,
        checked_at: result?.supply_evidence?.checked_at ?? null,
        valid_until: result?.supply_evidence?.valid_until ?? null,
        details: result,
      };
      await fs.appendFile(checkpointFile, `${JSON.stringify(row)}\n`, "utf8");
      rows.push(row);
    }
    return { rows, summary: summarizeOnlineSupplyAudit(rows) };
  }

  return { run, inspect };
}

export async function writeOnlineSupplyAudit({ rows, summary }, outputDir) {
  const destination = path.resolve(outputDir);
  await fs.mkdir(destination, { recursive: true });
  const jsonFile = path.join(destination, "online_supply_audit.json");
  const csvFile = path.join(destination, "online_supply_audit.csv");
  const summaryFile = path.join(destination, "online_supply_audit_summary.json");
  await fs.writeFile(jsonFile, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  await fs.writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const headers = [
    "audit_key", "audited_at", "shop_id", "shop_name", "offer_id", "product_id", "source_sku",
    "ozon_title", "online_status", "current_stock", "category", "reason", "recommendation_action",
    "recommendation_priority", "supply_offer_id", "supply_offer_url", "target_variant",
    "variant_attributes", "moq", "orderable_quantity", "unit_price", "checked_at", "valid_until",
  ];
  const lines = [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row?.[header])).join(","))];
  await fs.writeFile(csvFile, `${lines.join("\n")}\n`, "utf8");
  return { output_dir: destination, json_file: jsonFile, csv_file: csvFile, summary_file: summaryFile, summary };
}
