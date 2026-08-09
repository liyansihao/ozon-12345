#!/usr/bin/env node

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  FEEDBACK_RESULTS,
  mergeFeedbackArtifacts,
  normalizeFeedbackHeader,
  normalizeFeedbackRow,
  offerIdFromUrl,
  parseFeedbackRows,
  parseCsvMatrix,
} from "./flow_b_playwright/profit-feedback.mjs";
import { readProfitProductIndex } from "./flow_b_playwright/profit-runtime-data.mjs";

const SUPPORTED_EXTENSIONS = new Set([".csv", ".tsv", ".xlsx"]);

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

async function writeJsonAtomic(filename, value) {
  const absolute = path.resolve(filename);
  const temporary = `${absolute}.tmp-${process.pid}`;
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, absolute);
}

async function readJson(filename, fallback = {}, { malformedAsFallback = false } = {}) {
  try { return JSON.parse(await fs.readFile(path.resolve(filename), "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError && malformedAsFallback) return fallback;
    throw error;
  }
}

function loadArtifactTool({ runtimeRoot, nodeModules } = {}) {
  const root = path.resolve(runtimeRoot || path.join(import.meta.dirname, "../.profit-feedback-runtime"));
  const modules = path.resolve(nodeModules || "");
  if (!modules || !fsSync.existsSync(modules)) {
    throw new Error("bundled @oai/artifact-tool node_modules path is unavailable");
  }
  fsSync.mkdirSync(root, { recursive: true });
  const link = path.join(root, "node_modules");
  try {
    const existing = fsSync.readlinkSync(link);
    if (path.resolve(root, existing) !== modules) fsSync.unlinkSync(link);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!fsSync.existsSync(link)) fsSync.symlinkSync(modules, link, "dir");
  return createRequire(path.join(root, "artifact-entry.cjs"))("@oai/artifact-tool");
}

export function findFeedbackTable(matrix = []) {
  for (let index = 0; index < Math.min(30, matrix.length); index += 1) {
    const headers = (matrix[index] || []).map(normalizeFeedbackHeader);
    if (headers.includes("store_sku") && headers.includes("result")) {
      const body = matrix.slice(index + 1).filter((row) => row.some((value) => text(value)));
      return { headers: matrix[index], rows: body, header_index: index };
    }
  }
  return null;
}

async function xlsxMatrices(filename, artifactOptions) {
  const { FileBlob, SpreadsheetFile } = loadArtifactTool(artifactOptions);
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(filename));
  const matrices = [];
  for (const sheet of workbook.worksheets.items || []) {
    const used = sheet.getUsedRange(true);
    const values = used?.values;
    if (Array.isArray(values) && values.length > 0) matrices.push({ sheet: sheet.name, values });
  }
  return matrices;
}

async function fileMatrices(filename, artifactOptions) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".xlsx") return xlsxMatrices(filename, artifactOptions);
  const source = await fs.readFile(filename, "utf8");
  return [{
    sheet: path.basename(filename),
    values: parseCsvMatrix(source, { delimiter: extension === ".tsv" ? "\t" : null }),
  }];
}

function enrichFeedbackRecord(record, productIndex) {
  const product = productIndex.resolve({
    store_id: record.store_id,
    store_sku: record.store_sku,
    source_sku: record.source_sku,
  });
  const correctOfferId = offerIdFromUrl(record.correct_1688_url);
  const productOfferId = text(product?.selected_offer_id) || null;
  const negative = record.result === FEEDBACK_RESULTS.UNAVAILABLE
    || record.result === FEEDBACK_RESULTS.WRONG_ITEM
    || record.result === FEEDBACK_RESULTS.WRONG_SPEC;
  // Runtime state contains the exact offer selected by the matcher. Prefer it
  // over spreadsheet cells, which are easy to confuse with the replacement
  // (correct_1688_url). Never infer a negative identity from a candidate
  // cluster or from the replacement URL.
  const selectedOfferId = productOfferId
    || record.selected_offer_id
    || offerIdFromUrl(record.selected_offer_url)
    || (!negative ? correctOfferId : null);
  if (negative && !selectedOfferId) {
    throw new TypeError("无法确定当前实际选中的1688货源；已跳过，未写入错误名单");
  }
  if (negative && correctOfferId && selectedOfferId === correctOfferId) {
    throw new TypeError("正确1688链接与当前错误货源相同；已跳过，避免屏蔽正确链接");
  }
  if ((record.result === FEEDBACK_RESULTS.WRONG_ITEM || record.result === FEEDBACK_RESULTS.WRONG_SPEC)
    && !text(record.source_sku || product?.source_sku)) {
    throw new TypeError("错货/错规格缺少原始跟卖SKU，无法安全屏蔽匹配关系");
  }
  const selectedOfferUrl = record.selected_offer_url
    || (selectedOfferId
      ? `https://detail.1688.com/offer/${selectedOfferId}.html`
      : null);
  const purchasePrice = Number(product?.purchase_price);
  const actualCost = record.actual_cost
    || (record.result === FEEDBACK_RESULTS.NORMAL && Number.isFinite(purchasePrice) && purchasePrice > 0
      ? purchasePrice
      : null);
  const persistedCost = product?.data?.cost && typeof product.data.cost === "object"
    ? product.data.cost
    : {};
  const verifiedCost = product && selectedOfferId === productOfferId ? {
    source: text(product?.data?.cost_source || persistedCost.source),
    prices: Array.isArray(persistedCost.prices) ? persistedCost.prices : [],
    match_evidence_key: text(persistedCost.match_evidence_key || product.match_evidence_key),
    same_item_match: persistedCost.same_item_match === true,
    returned_evidence_verified: persistedCost.returned_evidence_verified === true,
    match_evidence_contract: text(persistedCost.match_evidence_contract),
    matched_offer_count: Number(persistedCost.matched_offer_count) || 0,
    selected_offer_id: selectedOfferId,
    selected_offer_ids: [selectedOfferId],
    balanced_match: persistedCost.balanced_match === true,
    balanced_match_type: text(persistedCost.balanced_match_type) || null,
    balanced_match_reason: text(persistedCost.balanced_match_reason) || null,
    image_check_available: persistedCost.image_check_available === true,
  } : null;
  const normalized = normalizeFeedbackRow({
    ...record,
    store_id: record.store_id || product?.store_id,
    source_sku: record.source_sku || product?.source_sku,
    selected_offer_id: selectedOfferId,
    selected_offer_url: selectedOfferUrl,
    actual_cost: actualCost,
  }, { updatedAt: record.updated_at });
  return {
    ...normalized,
    _learning_title: product?.title || null,
    _learning_category: product?.category || null,
    _match_evidence_key: product?.match_evidence_key || null,
    _verified_cost: verifiedCost,
  };
}

function attachLearningMetadata(artifacts, records, existing = {}) {
  const previous = [
    ...(existing?.trusted?.trusted || []),
    ...(existing?.trusted?.cost_corrections || []),
    ...(existing?.errors?.blocked_offers || []),
    ...(existing?.errors?.blocked_matches || []),
  ];
  const byKey = new Map();
  for (const row of [...previous, ...records]) {
    const current = byKey.get(row.feedback_key);
    if (!current || Date.parse(row.updated_at || "") >= Date.parse(current.updated_at || "")) {
      byKey.set(row.feedback_key, row);
    }
  }
  const extend = (row) => {
    const source = byKey.get(row.feedback_key);
    return source ? {
      ...row,
      title: source._learning_title ?? source.title ?? row.title ?? null,
      category: source._learning_category ?? source.category ?? row.category ?? null,
      match_evidence_key: source._match_evidence_key ?? source.match_evidence_key ?? row.match_evidence_key ?? null,
      verified_cost: source._verified_cost ?? source.verified_cost ?? row.verified_cost ?? null,
    } : row;
  };
  const trusted = (artifacts.trusted?.trusted || []).map(extend);
  const bySourceSku = {};
  for (const row of trusted) {
    if (text(row.source_sku)) bySourceSku[text(row.source_sku)] = row;
  }
  return {
    trusted: {
      ...artifacts.trusted,
      trusted,
      by_source_sku: bySourceSku,
      cost_corrections: (artifacts.trusted?.cost_corrections || []).map(extend),
    },
    errors: {
      ...artifacts.errors,
      blocked_offers: (artifacts.errors?.blocked_offers || []).map(extend),
      blocked_matches: (artifacts.errors?.blocked_matches || []).map(extend),
    },
  };
}

export async function feedbackDirectoryRevision(feedbackDir) {
  const directory = path.resolve(feedbackDir);
  await fs.mkdir(directory, { recursive: true });
  const entries = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    if (name.startsWith(".") || name.startsWith("~$")) continue;
    if (!SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
    const filename = path.join(directory, name);
    const stat = await fs.stat(filename);
    if (stat.isFile()) entries.push({ name, size: stat.size, mtime_ms: Math.trunc(stat.mtimeMs) });
  }
  return { directory, entries, fingerprint: JSON.stringify(entries) };
}

export async function importProfitFeedback({
  feedbackDir,
  outputFile,
  stateFile,
  runtimeDbPath,
  sharedCachePath = null,
  runtimeRoot,
  nodeModules,
  now = new Date(),
} = {}) {
  if (!feedbackDir || !outputFile || !stateFile || !runtimeDbPath) {
    throw new TypeError("feedbackDir, outputFile, stateFile and runtimeDbPath are required");
  }
  const revision = await feedbackDirectoryRevision(feedbackDir);
  const priorState = await readJson(stateFile, {}, { malformedAsFallback: true });
  let existing;
  try {
    existing = await readJson(outputFile, {});
  } catch (error) {
    const failedAt = new Date(now).toISOString();
    await writeJsonAtomic(stateFile, {
      schema_version: 1,
      status: "error",
      reason: "existing-feedback-artifact-invalid",
      fingerprint: revision.fingerprint,
      output: path.resolve(outputFile),
      error: String(error?.message || error),
      failed_at: failedAt,
    });
    throw error;
  }
  if (priorState.status === "completed" && priorState.fingerprint === revision.fingerprint && fsSync.existsSync(outputFile)) {
    return { ...priorState, unchanged: true };
  }
  const productIndex = await readProfitProductIndex({ runtimeDbPath, sharedCachePath });
  const incoming = [];
  const errors = [];
  for (const entry of revision.entries) {
    const filename = path.join(revision.directory, entry.name);
    try {
      const matrices = await fileMatrices(filename, { runtimeRoot, nodeModules });
      let found = false;
      for (const matrix of matrices) {
        const table = findFeedbackTable(matrix.values);
        if (!table) continue;
        found = true;
        const parsed = parseFeedbackRows(table.rows, {
          headers: table.headers,
          updatedAt: new Date(entry.mtime_ms),
        });
        for (const record of parsed.records) {
          try {
            incoming.push(enrichFeedbackRecord(record, productIndex));
          } catch (error) {
            errors.push({
              file: entry.name,
              sheet: matrix.sheet,
              store_sku: record.store_sku,
              reason: String(error?.message || error),
            });
          }
        }
        errors.push(...parsed.errors.map((error) => ({ file: entry.name, sheet: matrix.sheet, ...error })));
      }
      if (!found) errors.push({ file: entry.name, reason: "未找到‘本店Ozon SKU’和‘核对结果’表头" });
    } catch (error) {
      errors.push({ file: entry.name, reason: String(error?.message || error) });
    }
  }
  const merged = mergeFeedbackArtifacts(existing, incoming, { updatedAt: now });
  const artifact = {
    schema_version: 1,
    updated_at: new Date(now).toISOString(),
    ...attachLearningMetadata(merged, incoming, existing),
    import: {
      feedback_dir: revision.directory,
      source_files: revision.entries,
      row_errors: errors,
    },
  };
  await writeJsonAtomic(outputFile, artifact);
  const state = {
    schema_version: 1,
    status: "completed",
    fingerprint: revision.fingerprint,
    imported_file_count: revision.entries.length,
    imported_record_count: incoming.length,
    row_error_count: errors.length,
    output: path.resolve(outputFile),
    completed_at: new Date(now).toISOString(),
  };
  await writeJsonAtomic(stateFile, state);
  return state;
}

function parseArgs(argv) {
  const args = [...argv];
  const valueAfter = (flag, fallback = "") => {
    const index = args.indexOf(flag);
    return index >= 0 ? text(args[index + 1]) : text(fallback);
  };
  return {
    feedbackDir: valueAfter("--feedback-dir", process.env.FLOW_B_PROFIT_FEEDBACK_DIR),
    outputFile: valueAfter("--output", process.env.FLOW_B_PROFIT_FEEDBACK_FILE),
    stateFile: valueAfter("--state", process.env.FLOW_B_PROFIT_FEEDBACK_STATE),
    runtimeDbPath: valueAfter("--runtime-db", process.env.FLOW_B_RUNTIME_STATE_DB),
    sharedCachePath: valueAfter("--shared-cache", process.env.FLOW_B_1688_SHARED_CACHE),
    runtimeRoot: valueAfter("--runtime-root", process.env.FLOW_B_PROFIT_RUNTIME_ROOT),
    nodeModules: valueAfter("--node-modules", process.env.FLOW_B_PROFIT_NODE_MODULES),
  };
}

async function invokedAsMain(argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return await fs.realpath(path.resolve(argv1)) === await fs.realpath(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(argv1) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (await invokedAsMain()) {
  try {
    const result = await importProfitFeedback(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error), stack: error?.stack }, null, 2));
    process.exitCode = 1;
  }
}
