import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { validationCandidateSetSha256 } from "./validation-signed-evidence-replay.mjs";

export const VALIDATION_COMMISSION_SEED_ENV = "FLOW_B_VALIDATION_COMMISSION_SEED_FILE";
export const VALIDATION_COMMISSION_SEED_CONTRACT = "flow-b-validation-commission-seed-v1";

const DIGEST_RE = /^[a-f0-9]{64}$/u;
const MAXIMUM_SEED_FILE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_SOURCE_FILE_BYTES = 100 * 1024 * 1024;
const MAXIMUM_TTL_MS = 24 * 60 * 60 * 1000;
const MAXIMUM_FUTURE_SKEW_MS = 5 * 60 * 1000;
const ENTRY_KEYS = new Set(["sku", "top_category", "second_category", "tier"]);
const CATEGORY_KEYS = new Set(["cate_id", "label"]);
const TIER_KEYS = new Set(["value", "label"]);
const SOURCE_KEYS = new Set(["path", "sha256"]);

function compactText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function seedError(message) {
  return new Error(`${VALIDATION_COMMISSION_SEED_ENV} ${message}`);
}

function exactKeys(value, allowed, label) {
  const keys = Object.keys(value || {});
  const unsupported = keys.filter((key) => !allowed.has(key));
  if (unsupported.length) {
    throw seedError(`${label} contains unsupported field(s): ${unsupported.sort().join(", ")}`);
  }
  const missing = [...allowed].filter((key) => !Object.hasOwn(value || {}, key));
  if (missing.length) {
    throw seedError(`${label} is missing field(s): ${missing.join(", ")}`);
  }
}

function digest(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function readBoundFile(sourcePath, { maximumBytes, label }) {
  let stat;
  try {
    stat = await fs.stat(sourcePath);
  } catch (error) {
    throw seedError(`${label} is unavailable: ${error.message}`);
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > maximumBytes) {
    throw seedError(`${label} must be a non-empty file no larger than ${maximumBytes} bytes`);
  }
  return fs.readFile(sourcePath);
}

function validateCategory(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw seedError(`${label} must be an object`);
  }
  exactKeys(value, CATEGORY_KEYS, label);
  const cateId = Number(value.cate_id);
  const categoryLabel = compactText(value.label);
  if (!Number.isSafeInteger(cateId) || cateId <= 0) {
    throw seedError(`${label}.cate_id must be a positive safe integer`);
  }
  if (!categoryLabel) throw seedError(`${label}.label must be non-empty`);
  return Object.freeze({ cate_id: cateId, label: categoryLabel });
}

function validateTier(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw seedError(`${label} must be an object`);
  }
  exactKeys(value, TIER_KEYS, label);
  const tierValue = compactText(value.value);
  const tierLabel = compactText(value.label);
  const rate = Number(tierValue.match(/^[^,]+,([0-9]+(?:\.[0-9]+)?)$/u)?.[1]);
  if (!tierValue || !Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw seedError(`${label}.value must contain an explicit commission rate`);
  }
  if (!tierLabel || !/[0-9]\s*₽/u.test(tierLabel)) {
    throw seedError(`${label}.label must contain an explicit ruble price bound`);
  }
  return Object.freeze({ value: tierValue, label: tierLabel });
}

function validateEntry(rawEntry, candidate) {
  const sku = compactText(candidate?.sku);
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    throw seedError(`entry ${sku} must be an object`);
  }
  exactKeys(rawEntry, ENTRY_KEYS, `entry ${sku}`);
  if (compactText(rawEntry.sku) !== sku) {
    throw seedError(`entry ${sku} has a mismatched SKU`);
  }
  const top = validateCategory(rawEntry.top_category, `entry ${sku}.top_category`);
  const second = validateCategory(rawEntry.second_category, `entry ${sku}.second_category`);
  const tier = validateTier(rawEntry.tier, `entry ${sku}.tier`);
  return Object.freeze({
    sku,
    top_category: top,
    second_category: second,
    tier,
    expected_category_hierarchy: Object.freeze([top.cate_id, second.cate_id]),
  });
}

function buildCommissionTree(entries) {
  const tops = new Map();
  for (const entry of entries.values()) {
    const topKey = String(entry.top_category.cate_id);
    let top = tops.get(topKey);
    if (!top) {
      top = { ...entry.top_category, children: [], secondById: new Map() };
      tops.set(topKey, top);
    } else if (top.label !== entry.top_category.label) {
      throw seedError(`category ${topKey} has conflicting labels`);
    }
    const secondKey = String(entry.second_category.cate_id);
    let second = top.secondById.get(secondKey);
    if (!second) {
      second = { ...entry.second_category, children: [], tierByValue: new Map() };
      top.secondById.set(secondKey, second);
      top.children.push(second);
    } else if (second.label !== entry.second_category.label) {
      throw seedError(`category ${topKey}/${secondKey} has conflicting labels`);
    }
    const tierKey = entry.tier.value;
    const existingTier = second.tierByValue.get(tierKey);
    if (existingTier && existingTier.label !== entry.tier.label) {
      throw seedError(`category ${topKey}/${secondKey} tier ${tierKey} has conflicting labels`);
    }
    if (!existingTier) {
      second.tierByValue.set(tierKey, entry.tier);
      second.children.push({ ...entry.tier });
    }
  }
  return Object.freeze([...tops.values()].map((top) => Object.freeze({
    cate_id: top.cate_id,
    label: top.label,
    children: Object.freeze(top.children.map((second) => Object.freeze({
      cate_id: second.cate_id,
      label: second.label,
      children: Object.freeze(second.children.map((tier) => Object.freeze({ ...tier }))),
    }))),
  })));
}

function validateScope(env = {}) {
  if (env.FLOW_B_VALIDATION_ONLY !== "1") {
    throw seedError("is allowed only when FLOW_B_VALIDATION_ONLY=1");
  }
  if (env.FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE !== "1") {
    throw seedError("requires FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE=1");
  }
  if (!compactText(env.FLOW_B_VALIDATION_CANDIDATE_FILE)) {
    throw seedError("requires FLOW_B_VALIDATION_CANDIDATE_FILE");
  }
}

export async function loadValidationCommissionSeedFromEnv(env = {}, {
  candidates,
  now = new Date(),
} = {}) {
  const configuredFile = compactText(env?.[VALIDATION_COMMISSION_SEED_ENV]);
  if (!configuredFile) return null;
  validateScope(env);
  if (!Array.isArray(candidates) || !candidates.length) {
    throw seedError("requires already validated candidate rows");
  }

  const sourcePath = path.resolve(configuredFile);
  const seedBytes = await readBoundFile(sourcePath, {
    maximumBytes: MAXIMUM_SEED_FILE_BYTES,
    label: "seed file",
  });
  let manifest;
  try {
    manifest = JSON.parse(seedBytes.toString("utf8"));
  } catch (error) {
    throw seedError(`is not valid JSON: ${error.message}`);
  }
  if (manifest?.contract !== VALIDATION_COMMISSION_SEED_CONTRACT) {
    throw seedError(`requires contract ${VALIDATION_COMMISSION_SEED_CONTRACT}`);
  }

  const createdAtMs = Date.parse(String(manifest?.created_at || ""));
  const ttlMs = Number(manifest?.ttl_ms);
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (!Number.isFinite(createdAtMs)) throw seedError("created_at must be a valid timestamp");
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAXIMUM_TTL_MS) {
    throw seedError(`ttl_ms must be a positive integer no greater than ${MAXIMUM_TTL_MS}`);
  }
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid date");
  if (createdAtMs > nowMs + MAXIMUM_FUTURE_SKEW_MS) {
    throw seedError("created_at is unacceptably far in the future");
  }
  if (nowMs >= createdAtMs + ttlMs) throw seedError("has expired");

  const candidatePath = path.resolve(compactText(env.FLOW_B_VALIDATION_CANDIDATE_FILE));
  const candidateBytes = await readBoundFile(candidatePath, {
    maximumBytes: MAXIMUM_SOURCE_FILE_BYTES,
    label: "candidate file",
  });
  if (!DIGEST_RE.test(compactText(manifest?.candidate_file_sha256))
    || manifest.candidate_file_sha256 !== digest(candidateBytes)) {
    throw seedError("raw candidate file digest does not match FLOW_B_VALIDATION_CANDIDATE_FILE");
  }
  const candidateSetDigest = validationCandidateSetSha256(candidates);
  if (!DIGEST_RE.test(compactText(manifest?.candidate_set_sha256))
    || manifest.candidate_set_sha256 !== candidateSetDigest) {
    throw seedError("candidate set digest does not match FLOW_B_VALIDATION_CANDIDATE_FILE");
  }
  if (!Number.isSafeInteger(manifest?.candidate_count)
    || manifest.candidate_count !== candidates.length) {
    throw seedError("candidate_count metadata does not match the exact validation candidate set");
  }

  if (!Array.isArray(manifest?.source_files) || !manifest.source_files.length) {
    throw seedError("source_files must contain at least one provenance file");
  }
  const sourceFiles = [];
  const seenSourcePaths = new Set();
  for (const [index, rawSource] of manifest.source_files.entries()) {
    if (!rawSource || typeof rawSource !== "object" || Array.isArray(rawSource)) {
      throw seedError(`source_files[${index}] must be an object`);
    }
    exactKeys(rawSource, SOURCE_KEYS, `source_files[${index}]`);
    const boundPathText = compactText(rawSource.path);
    if (!path.isAbsolute(boundPathText)) {
      throw seedError(`source_files[${index}].path must be absolute`);
    }
    const boundPath = path.resolve(boundPathText);
    if (seenSourcePaths.has(boundPath)) throw seedError(`source_files contains duplicate path ${boundPath}`);
    seenSourcePaths.add(boundPath);
    const expectedDigest = compactText(rawSource.sha256);
    if (!DIGEST_RE.test(expectedDigest)) {
      throw seedError(`source_files[${index}].sha256 must be a SHA-256 digest`);
    }
    const sourceBytes = await readBoundFile(boundPath, {
      maximumBytes: MAXIMUM_SOURCE_FILE_BYTES,
      label: `source_files[${index}]`,
    });
    if (digest(sourceBytes) !== expectedDigest) {
      throw seedError(`source_files[${index}] digest mismatch`);
    }
    sourceFiles.push(Object.freeze({ path: boundPath, sha256: expectedDigest }));
  }

  if (!manifest?.entries || typeof manifest.entries !== "object" || Array.isArray(manifest.entries)) {
    throw seedError("entries must be an object keyed by SKU");
  }
  const manifestSkus = Object.keys(manifest.entries).map(compactText);
  if (!Number.isSafeInteger(manifest?.entry_count)
    || manifest.entry_count !== manifestSkus.length
    || manifest.entry_count !== candidates.length) {
    throw seedError("entry_count must equal the exact validation candidate count");
  }
  const candidateBySku = new Map(candidates.map((candidate) => [compactText(candidate.sku), candidate]));
  const entries = new Map();
  for (const [rawSku, rawEntry] of Object.entries(manifest.entries)) {
    const sku = compactText(rawSku);
    const candidate = candidateBySku.get(sku);
    if (!candidate) throw seedError(`contains SKU ${rawSku} outside the exact validation candidate set`);
    entries.set(sku, validateEntry(rawEntry, candidate));
  }
  for (const sku of candidateBySku.keys()) {
    if (!entries.has(sku)) throw seedError(`is missing candidate SKU ${sku}`);
  }

  const commissionTree = buildCommissionTree(entries);
  return Object.freeze({
    sourcePath,
    created_at: new Date(createdAtMs).toISOString(),
    expires_at: new Date(createdAtMs + ttlMs).toISOString(),
    ttl_ms: ttlMs,
    candidate_file_sha256: manifest.candidate_file_sha256,
    candidate_set_sha256: candidateSetDigest,
    source_files: Object.freeze(sourceFiles),
    entry_count: entries.size,
    commissionTree,
    categoryForSku(sku) {
      return entries.get(compactText(sku)) || null;
    },
  });
}
