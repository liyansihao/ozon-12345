#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { loadValidationCandidateFile } from "./flow_b_playwright/validation-candidate-file.mjs";
import {
  loadValidationCommissionSeedFromEnv,
  VALIDATION_COMMISSION_SEED_CONTRACT,
  VALIDATION_COMMISSION_SEED_ENV,
} from "./flow_b_playwright/validation-commission-seed.mjs";
import {
  loadValidationSignedEvidenceReplayFromEnv,
  validationCandidateSetSha256,
  VALIDATION_SIGNED_EVIDENCE_REPLAY_CONTRACT,
  VALIDATION_SIGNED_EVIDENCE_REPLAY_ENV,
} from "./flow_b_playwright/validation-signed-evidence-replay.mjs";
import { validateSupplyEvidence } from "./flow_b_playwright/publish-runner.mjs";

export const EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS = Object.freeze({
  candidateFile: "/Users/mac/Desktop/ozon/outputs/1688_supply_acceptance_20260816_moq1_preoutcome100/validation_candidates_moq1_preoutcome100_supportbackfill.json",
  runDir: "/Users/mac/Desktop/ozon/outputs/1688_supply_acceptance_20260816_exact100_supply_only_v21",
  originalReplayFile: "/Users/mac/Desktop/ozon/outputs/1688_supply_acceptance_20260816_moq1_preoutcome100/validation_signed_evidence_replay_exact100_min1_v12.json",
  selectionAuditFile: "/Users/mac/Desktop/ozon/outputs/1688_supply_acceptance_20260816_moq1_preoutcome100/selection_audit_moq1_preoutcome100_supportbackfill.json",
  outputDir: "/Users/mac/Desktop/ozon/outputs/1688_supply_acceptance_20260816_exact100_supply_only_v21_postprocess",
  expectedCount: 100,
  commissionTtlMs: 6 * 60 * 60 * 1000,
});

const REQUIRED_CANDIDATE_FIELDS = Object.freeze(["sku", "title", "sell_price", "cover_image"]);
const REQUIRED_CANDIDATE_FIELD_SET = new Set(REQUIRED_CANDIDATE_FIELDS);
const STRICT_MATCH_TYPES = new Set(["strong_single", "corroborated_multi"]);
const DIGEST_RE = /^[a-f0-9]{64}$/u;
const MAXIMUM_COMMISSION_TTL_MS = 24 * 60 * 60 * 1000;
const TRANSIENT_REASON_RE = /(?:auth(?:entication)?|login|logged[ -]?out|session|captcha|验证码|登录|timeout|timed[ -]?out|超时|network|transport|connection|econn|429|5\d\d|rate.?limit|soft.?block|health|temporar|unconfirmed|exception|unavailable)/iu;
const DETERMINISTIC_REASON_RE = /(?:moq|minimum|起订|起批|out.?of.?stock|sold.?out|缺货|无货|offline|removed|下架|not.?found|404|spec.?conflict|variant.?conflict|型号|颜色|尺寸|容量|规格|套装|no.?strict.?same.?item|same.?item|同款|quantity|unit.?price|price.?unconfirmed)/iu;

function compactText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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

function exactCandidateObject(raw, label = "candidate") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(raw);
  const missing = REQUIRED_CANDIDATE_FIELDS.filter((field) => !Object.hasOwn(raw, field));
  const extra = keys.filter((field) => !REQUIRED_CANDIDATE_FIELD_SET.has(field));
  if (missing.length || extra.length) {
    throw new Error(`${label} must contain exactly ${REQUIRED_CANDIDATE_FIELDS.join(", ")}`);
  }
  return Object.fromEntries(REQUIRED_CANDIDATE_FIELDS.map((field) => [field, raw[field]]));
}

function normalizedCandidateIdentity(candidate) {
  return {
    sku: compactText(candidate?.sku),
    title: compactText(candidate?.title),
    sell_price: Number(candidate?.sell_price),
    cover_image: canonicalUrl(candidate?.cover_image),
  };
}

function eventMatchesCandidate(event, candidate) {
  const identity = normalizedCandidateIdentity(candidate);
  return compactText(event?.sku) === identity.sku
    && compactText(event?.title) === identity.title
    && Number(event?.sale_price_snapshot) === identity.sell_price
    && canonicalUrl(event?.cover_image) === identity.cover_image;
}

export function classifySupplyFailure(event = {}) {
  const explicit = compactText(event?.failure_class).toLowerCase();
  const reason = compactText(event?.reason || event?.supply_gate_reason || event?.error || "unknown");
  const result = event?.supply_gate_result || event?.result || null;
  if (result?.deterministic === true
    || compactText(result?.classification) === "deterministic_failure") {
    return { classification: "deterministic", basis: "supply-gate-result", reason };
  }
  if (result?.transient === true
    || result?.retryable === true
    || compactText(result?.classification) === "transient_failure") {
    return { classification: "transient", basis: "supply-gate-result", reason };
  }
  if (TRANSIENT_REASON_RE.test(reason)) {
    return { classification: "transient", basis: "reason-transient-taxonomy", reason };
  }
  if (DETERMINISTIC_REASON_RE.test(reason)) {
    return { classification: "deterministic", basis: "reason-deterministic-taxonomy", reason };
  }
  if (explicit === "deterministic" || explicit === "transient") {
    return { classification: explicit, basis: "event.failure_class", reason };
  }
  return { classification: "transient", basis: "fail-closed-unknown-as-transient", reason };
}

export function latestPhysicalValidationEventsFromText(text, candidateSkus = null) {
  const allowed = candidateSkus ? new Set([...candidateSkus].map(compactText)) : null;
  const latest = new Map();
  const unexpected = [];
  const malformed = [];
  const lines = String(text || "").split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      malformed.push({ line: index + 1, error: error.message });
      continue;
    }
    const sku = compactText(event?.sku);
    if (!sku) continue;
    if (allowed && !allowed.has(sku)) {
      unexpected.push({ sku, line: index + 1 });
      continue;
    }
    latest.set(sku, Object.freeze({ event, physical_line: index + 1 }));
  }
  return { latest, unexpected, malformed };
}

export function validateSupplyOnlyPassedRow(row, candidate) {
  if (row?.status !== "supply_validated_pending_profit"
    || row?.reason !== "profit-validation-pending"
    || row?.supply_gate_passed !== true
    || row?.supply_evidence_type !== "SupplyEvidenceV1"
    || row?.profit_validation_pending !== true
    || row?.full_validation_passed !== false
    || row?.snapshot_price_used !== true
    || row?.validation_mode !== "supply-only") {
    return { ok: false, reason: "status-envelope" };
  }
  if (!eventMatchesCandidate(row, candidate)) return { ok: false, reason: "candidate-identity" };
  const cost = row?.cost;
  const evidence = row?.supply_evidence;
  const evidenceKey = compactText(evidence?.match_evidence_key).toLowerCase();
  if (row?.cost_verified !== true
    || cost?.ok !== true
    || cost?.same_item_match !== true
    || cost?.returned_evidence_verified !== true
    || cost?.match_evidence_contract !== "1688-returned-same-item-v3"
    || cost?.balanced_match !== true
    || !STRICT_MATCH_TYPES.has(compactText(cost?.balanced_match_type))
    || !DIGEST_RE.test(evidenceKey)
    || compactText(cost?.match_evidence_key).toLowerCase() !== evidenceKey) {
    return { ok: false, reason: "cost-evidence-binding" };
  }
  const checkedAtMs = Date.parse(String(evidence?.checked_at || ""));
  if (!Number.isFinite(checkedAtMs)) return { ok: false, reason: "evidence-checked-at" };
  const validity = validateSupplyEvidence(evidence, {
    at: new Date(checkedAtMs + 1),
    matchEvidenceKey: cost.match_evidence_key,
    candidates: row.supply_candidates,
    targetVariant: row.target_variant,
  });
  if (!validity.ok) return { ok: false, reason: `SupplyEvidenceV1:${validity.reason}` };
  const original = Number(row?.purchase_price_original_p70_p80);
  const live = Number(row?.purchase_price_live_one_piece);
  const effective = Number(row?.purchase_price);
  if (!(original > 0) || !(live > 0) || live !== Number(evidence.unit_price)
    || effective !== Math.max(original, live)) {
    return { ok: false, reason: "effective-purchase-price" };
  }
  return { ok: true, reason: null };
}

async function stableFileSnapshot(sourceFile) {
  const sourcePath = path.resolve(sourceFile);
  const before = await fs.stat(sourcePath);
  if (!before.isFile() || before.size <= 0) throw new Error(`${sourcePath} must be a non-empty file`);
  const bytes = await fs.readFile(sourcePath);
  const after = await fs.stat(sourcePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`${sourcePath} changed while it was read; wait for the run to finish`);
  }
  return { sourcePath, bytes, sha256: sha256(bytes), stat: after };
}

function jsonlPrefix(bytes, lineCount) {
  if (!Number.isSafeInteger(lineCount) || lineCount <= 0) {
    throw new Error("selection audit source line count must be a positive safe integer");
  }
  let seen = 0;
  let end = -1;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    seen += 1;
    if (seen === lineCount) {
      end = index + 1;
      break;
    }
  }
  if (end < 0) throw new Error(`historical validation source has fewer than ${lineCount} physical lines`);
  return bytes.subarray(0, end);
}

function extractCommissionCategory(row, candidate, replayEntry) {
  const category = row?.quality_evidence?.category;
  const raw = Array.isArray(category?.raw) ? category.raw : [];
  const mapped = Array.isArray(category?.mapped) ? category.mapped : [];
  const labels = Array.isArray(category?.labels) ? category.labels.map(compactText) : [];
  const candidateIdentity = normalizedCandidateIdentity(candidate);
  if (row?.status !== "validated"
    || row?.quality_gate_passed !== true
    || row?.cost_verified !== true
    || compactText(row?.sku) !== candidateIdentity.sku
    || compactText(row?.title) !== candidateIdentity.title
    || Number(row?.sale_price) !== candidateIdentity.sell_price
    || canonicalUrl(row?.quality_evidence?.image?.url) !== candidateIdentity.cover_image
    || compactText(row?.cost?.match_evidence_key) !== compactText(replayEntry?.match_evidence_key)
    || compactText(row?.validated_at || row?.at) !== compactText(replayEntry?.source_validation_at)
    || category?.commission_tree_match !== true
    || category?.commission_tier_match !== true
    || !Number.isSafeInteger(Number(raw[0]))
    || !Number.isSafeInteger(Number(raw[1]))
    || Number(raw[0]) <= 0
    || Number(raw[1]) <= 0
    || Number(mapped[0]) !== Number(raw[0])
    || Number(mapped[1]) !== Number(raw[1])
    || labels.length < 3
    || compactText(replayEntry?.expect_category) !== compactText(`${labels[0]} ${labels[1]}`)) {
    throw new Error(`SKU ${candidateIdentity.sku} has no exact category/commission source binding`);
  }
  return {
    sku: candidateIdentity.sku,
    top_category: { cate_id: Number(raw[0]), label: labels[0] },
    second_category: { cate_id: Number(raw[1]), label: labels[1] },
    tier: { value: compactText(mapped.at(-1)), label: labels.at(-1) },
  };
}

export async function commissionEntriesFromSelectionSnapshot({
  selectionAuditFile,
  candidates,
  replayManifest,
}) {
  const selectionAuditSnapshot = await stableFileSnapshot(selectionAuditFile);
  const audit = JSON.parse(selectionAuditSnapshot.bytes.toString("utf8"));
  const historicalPath = path.resolve(compactText(audit?.source?.validation_gate_file));
  const lineLimit = Number(audit?.source?.validation_gate_line_count_at_read);
  if (!historicalPath || !Number.isSafeInteger(lineLimit) || lineLimit <= 0) {
    throw new Error("selection audit lacks its historical validation_gate prefix binding");
  }
  const historicalSnapshot = await stableFileSnapshot(historicalPath);
  const prefix = jsonlPrefix(historicalSnapshot.bytes, lineLimit);
  const candidateSkus = new Set(candidates.map((candidate) => compactText(candidate.sku)));
  const latest = new Map();
  for (const [index, line] of prefix.toString("utf8").split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`historical validation_gate line ${index + 1} is malformed: ${error.message}`);
    }
    const sku = compactText(row?.sku);
    if (candidateSkus.has(sku)) latest.set(sku, { row, line: index + 1, raw: line });
  }

  const entries = {};
  const provenanceRows = [];
  for (const candidate of candidates) {
    const sku = compactText(candidate.sku);
    const selected = latest.get(sku);
    if (!selected) throw new Error(`SKU ${sku} is absent from the bound historical validation prefix`);
    const replayEntry = replayManifest?.entries?.[sku];
    if (!replayEntry) throw new Error(`SKU ${sku} is absent from the original signed replay manifest`);
    entries[sku] = extractCommissionCategory(selected.row, candidate, replayEntry);
    provenanceRows.push({
      sku,
      source_path: historicalPath,
      source_prefix_line_count: lineLimit,
      source_prefix_sha256: sha256(prefix),
      source_physical_line: selected.line,
      source_event_sha256: sha256(Buffer.from(selected.raw, "utf8")),
      source_validated_at: replayEntry.source_validation_at,
      replay_match_evidence_key: replayEntry.match_evidence_key,
      ...entries[sku],
    });
  }
  return {
    entries,
    provenanceRows,
    source: {
      selection_audit_path: selectionAuditSnapshot.sourcePath,
      selection_audit_sha256: selectionAuditSnapshot.sha256,
      historical_validation_gate_path: historicalPath,
      historical_validation_gate_prefix_line_count: lineLimit,
      historical_validation_gate_prefix_sha256: sha256(prefix),
      historical_validation_gate_full_sha256_at_read: historicalSnapshot.sha256,
    },
  };
}

async function ensureNewOutputDirectory(outputDir) {
  const destination = path.resolve(outputDir);
  try {
    await fs.stat(destination);
    throw new Error(`output directory already exists: ${destination}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.mkdir(destination);
  return destination;
}

async function writeJsonExclusive(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.writeFile(file, bytes, { flag: "wx" });
  return { bytes, sha256: sha256(bytes) };
}

async function writeJsonlExclusive(file, values) {
  const bytes = Buffer.from(`${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
  await fs.writeFile(file, bytes, { flag: "wx" });
  return { bytes, sha256: sha256(bytes) };
}

async function verifyReplayLoader({ candidateFile, replayFile, candidates, minimumSameItemMatches }) {
  const replay = await loadValidationSignedEvidenceReplayFromEnv({
    FLOW_B_VALIDATION_ONLY: "1",
    FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE: "1",
    FLOW_B_VALIDATION_CANDIDATE_FILE: candidateFile,
    [VALIDATION_SIGNED_EVIDENCE_REPLAY_ENV]: replayFile,
  }, { candidates, minimumSameItemMatches });
  if (!replay || replay.entry_count !== candidates.length
    || candidates.some((candidate) => !replay.requestFor(candidate))) {
    throw new Error("signed replay loader did not bind every exact candidate");
  }
  return replay;
}

export async function postprocessExact100SupplyOnly({
  candidateFile = EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.candidateFile,
  runDir = EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.runDir,
  originalReplayFile = EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.originalReplayFile,
  selectionAuditFile = EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.selectionAuditFile,
  outputDir = EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.outputDir,
  expectedCount = EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.expectedCount,
  commissionTtlMs = EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.commissionTtlMs,
  now = new Date(),
} = {}) {
  const createdAt = now instanceof Date ? new Date(now) : new Date(now);
  if (!Number.isFinite(createdAt.getTime())) throw new TypeError("now must be a valid date");
  if (!Number.isSafeInteger(Number(expectedCount)) || Number(expectedCount) <= 0) {
    throw new TypeError("expectedCount must be a positive safe integer");
  }
  if (!Number.isSafeInteger(Number(commissionTtlMs))
    || Number(commissionTtlMs) <= 0
    || Number(commissionTtlMs) > MAXIMUM_COMMISSION_TTL_MS) {
    throw new TypeError(`commissionTtlMs must be 1..${MAXIMUM_COMMISSION_TTL_MS}`);
  }

  const rawCandidateSnapshot = await stableFileSnapshot(candidateFile);
  const rawCandidates = JSON.parse(rawCandidateSnapshot.bytes.toString("utf8"));
  if (!Array.isArray(rawCandidates)) throw new Error("exact candidate file must contain a JSON array");
  const preservedCandidates = rawCandidates.map((candidate, index) => exactCandidateObject(candidate, `candidate ${index + 1}`));
  const candidates = await loadValidationCandidateFile(candidateFile, { validationOnly: true });
  if (candidates.length !== Number(expectedCount) || preservedCandidates.length !== Number(expectedCount)) {
    throw new Error(`exact acceptance requires ${expectedCount} candidates, found ${candidates.length}`);
  }

  const originalReplaySnapshot = await stableFileSnapshot(originalReplayFile);
  const originalReplay = JSON.parse(originalReplaySnapshot.bytes.toString("utf8"));
  if (originalReplay?.contract !== VALIDATION_SIGNED_EVIDENCE_REPLAY_CONTRACT
    || originalReplay?.candidate_count !== candidates.length
    || originalReplay?.entry_count !== candidates.length) {
    throw new Error("original exact100 signed replay manifest is not complete");
  }
  await verifyReplayLoader({
    candidateFile: rawCandidateSnapshot.sourcePath,
    replayFile: originalReplaySnapshot.sourcePath,
    candidates,
    minimumSameItemMatches: Number(originalReplay.minimum_same_item_matches),
  });

  const gateSnapshot = await stableFileSnapshot(path.join(path.resolve(runDir), "validation_gate.jsonl"));
  const candidateSkus = candidates.map((candidate) => candidate.sku);
  const merged = latestPhysicalValidationEventsFromText(gateSnapshot.bytes.toString("utf8"), candidateSkus);
  if (merged.malformed.length) {
    throw new Error(`validation_gate contains malformed physical line ${merged.malformed[0].line}`);
  }
  if (merged.unexpected.length) {
    throw new Error(`validation_gate contains SKU ${merged.unexpected[0].sku} outside the exact candidate set`);
  }
  const missingSkus = candidateSkus.filter((sku) => !merged.latest.has(sku));
  if (missingSkus.length || merged.latest.size !== candidates.length) {
    throw new Error(`run is incomplete: ${merged.latest.size}/${candidates.length} candidates have a physical last event; missing=${missingSkus.join(",")}`);
  }

  const passed = [];
  const deterministic = [];
  const transient = [];
  for (const [index, candidate] of candidates.entries()) {
    const latest = merged.latest.get(candidate.sku);
    const row = latest.event;
    if (row?.status === "supply_validated_pending_profit") {
      const validation = validateSupplyOnlyPassedRow(row, candidate);
      if (!validation.ok) {
        throw new Error(`SKU ${candidate.sku} has a malformed passed event: ${validation.reason}`);
      }
      const originalEntry = originalReplay.entries[candidate.sku];
      passed.push({
        order: index + 1,
        sku: candidate.sku,
        candidate: preservedCandidates[index],
        physical_last_event_line: latest.physical_line,
        supply_validated_at: row.supply_validated_at,
        purchase_price_effective: row.purchase_price,
        purchase_price_original_p70_p80: row.purchase_price_original_p70_p80,
        purchase_price_live_one_piece: row.purchase_price_live_one_piece,
        replay_match_evidence_key_matches_supply: compactText(originalEntry?.match_evidence_key)
          === compactText(row?.supply_evidence?.match_evidence_key),
        supply_evidence_type: "SupplyEvidenceV1",
        supply_evidence: row.supply_evidence,
        validation_event: row,
      });
      continue;
    }
    const classified = classifySupplyFailure(row);
    const outcome = {
      order: index + 1,
      sku: candidate.sku,
      candidate: preservedCandidates[index],
      physical_last_event_line: latest.physical_line,
      status: compactText(row?.status) || "unknown",
      reason: classified.reason,
      classification: classified.classification,
      classification_basis: classified.basis,
      retry_at: row?.retry_at || null,
      validation_event: row,
    };
    (classified.classification === "deterministic" ? deterministic : transient).push(outcome);
  }
  if (!passed.length) throw new Error("no SupplyEvidenceV1 pass is available for the full-profit subset");

  const passedSkus = new Set(passed.map((row) => row.sku));
  const subsetRawCandidates = preservedCandidates.filter((candidate) => passedSkus.has(compactText(candidate.sku)));
  const destination = await ensureNewOutputDirectory(outputDir);
  const files = {
    report: path.join(destination, "supply_only_postprocess_report.json"),
    candidates: path.join(destination, "validation_candidates_full_profit.json"),
    replay: path.join(destination, "validation_signed_evidence_replay_full_profit.json"),
    commissionProvenance: path.join(destination, "commission_category_provenance.jsonl"),
    commissionSeed: path.join(destination, "validation_commission_seed_full_profit.json"),
    integrity: path.join(destination, "postprocess_integrity_manifest.json"),
  };

  const candidateWrite = await writeJsonExclusive(files.candidates, subsetRawCandidates);
  const subsetCandidates = await loadValidationCandidateFile(files.candidates, { validationOnly: true });
  const subsetReplayEntries = Object.fromEntries(subsetCandidates.map((candidate) => {
    const entry = originalReplay.entries[candidate.sku];
    if (!entry) throw new Error(`original replay is missing passed SKU ${candidate.sku}`);
    return [candidate.sku, entry];
  }));
  const subsetReplay = {
    contract: VALIDATION_SIGNED_EVIDENCE_REPLAY_CONTRACT,
    created_at: createdAt.toISOString(),
    purpose: "formal validation-only full-profit replay for the exact supply-passed subset; current 1688 detail is rechecked",
    source_manifest: {
      path: originalReplaySnapshot.sourcePath,
      sha256: originalReplaySnapshot.sha256,
    },
    candidate_file_sha256: candidateWrite.sha256,
    candidate_set_sha256: validationCandidateSetSha256(subsetCandidates),
    candidate_count: subsetCandidates.length,
    minimum_same_item_matches: Number(originalReplay.minimum_same_item_matches),
    entry_count: Object.keys(subsetReplayEntries).length,
    entries: subsetReplayEntries,
    rejected: [],
  };
  const replayWrite = await writeJsonExclusive(files.replay, subsetReplay);
  const verifiedReplay = await verifyReplayLoader({
    candidateFile: files.candidates,
    replayFile: files.replay,
    candidates: subsetCandidates,
    minimumSameItemMatches: subsetReplay.minimum_same_item_matches,
  });

  const commission = await commissionEntriesFromSelectionSnapshot({
    selectionAuditFile,
    candidates: subsetCandidates,
    replayManifest: subsetReplay,
  });
  const provenanceHeader = {
    contract: "flow-b-validation-commission-category-provenance-v1",
    created_at: createdAt.toISOString(),
    candidate_file_sha256: candidateWrite.sha256,
    candidate_set_sha256: validationCandidateSetSha256(subsetCandidates),
    entry_count: commission.provenanceRows.length,
    source: commission.source,
  };
  const provenanceWrite = await writeJsonlExclusive(
    files.commissionProvenance,
    [provenanceHeader, ...commission.provenanceRows],
  );
  const seedSourcePaths = [
    files.commissionProvenance,
    originalReplaySnapshot.sourcePath,
    path.resolve(selectionAuditFile),
  ];
  const seedSourceFiles = [];
  for (const sourcePath of seedSourcePaths) {
    const bytes = await fs.readFile(sourcePath);
    seedSourceFiles.push({ path: sourcePath, sha256: sha256(bytes) });
  }
  const commissionSeed = {
    contract: VALIDATION_COMMISSION_SEED_CONTRACT,
    created_at: createdAt.toISOString(),
    ttl_ms: Number(commissionTtlMs),
    candidate_file_sha256: candidateWrite.sha256,
    candidate_set_sha256: validationCandidateSetSha256(subsetCandidates),
    candidate_count: subsetCandidates.length,
    source_files: seedSourceFiles,
    entry_count: subsetCandidates.length,
    entries: commission.entries,
  };
  const commissionSeedWrite = await writeJsonExclusive(files.commissionSeed, commissionSeed);
  const verifiedSeed = await loadValidationCommissionSeedFromEnv({
    FLOW_B_VALIDATION_ONLY: "1",
    FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE: "1",
    FLOW_B_VALIDATION_CANDIDATE_FILE: files.candidates,
    [VALIDATION_COMMISSION_SEED_ENV]: files.commissionSeed,
  }, { candidates: subsetCandidates, now: new Date(createdAt.getTime() + 1) });
  if (!verifiedSeed || verifiedSeed.entry_count !== subsetCandidates.length
    || subsetCandidates.some((candidate) => !verifiedSeed.categoryForSku(candidate.sku))) {
    throw new Error("commission seed loader did not bind every exact candidate");
  }

  const report = {
    contract: "flow-b-exact100-supply-only-postprocess-v1",
    created_at: createdAt.toISOString(),
    validation_only: true,
    no_browser_started: true,
    no_publish_cart_or_order: true,
    physical_last_event_policy: true,
    sources: {
      candidate_file: rawCandidateSnapshot.sourcePath,
      candidate_file_sha256: rawCandidateSnapshot.sha256,
      run_dir: path.resolve(runDir),
      validation_gate_file: gateSnapshot.sourcePath,
      validation_gate_sha256: gateSnapshot.sha256,
      original_replay_file: originalReplaySnapshot.sourcePath,
      original_replay_sha256: originalReplaySnapshot.sha256,
      selection_audit_file: path.resolve(selectionAuditFile),
      commission_category_source: commission.source,
    },
    counts: {
      candidate_count: candidates.length,
      physical_last_event_count: merged.latest.size,
      supply_passed_count: passed.length,
      deterministic_failure_count: deterministic.length,
      transient_failure_count: transient.length,
    },
    supply_passed_skus: passed.map((row) => row.sku),
    deterministic_failure_skus: deterministic.map((row) => row.sku),
    transient_failure_skus: transient.map((row) => row.sku),
    signed_replay_loader_verification: {
      verified: true,
      entry_count: verifiedReplay.entry_count,
      candidate_set_sha256: verifiedReplay.candidate_set_sha256,
    },
    commission_seed_loader_verification: {
      verified: true,
      entry_count: verifiedSeed.entry_count,
      candidate_set_sha256: verifiedSeed.candidate_set_sha256,
      created_at: verifiedSeed.created_at,
      expires_at: verifiedSeed.expires_at,
      ttl_ms: verifiedSeed.ttl_ms,
    },
    passed,
    deterministic_failures: deterministic,
    transient_failures: transient,
  };
  const reportWrite = await writeJsonExclusive(files.report, report);
  const integrity = {
    contract: "flow-b-exact100-supply-only-postprocess-integrity-v1",
    created_at: createdAt.toISOString(),
    source_files: {
      candidate_file: { path: rawCandidateSnapshot.sourcePath, sha256: rawCandidateSnapshot.sha256 },
      validation_gate: { path: gateSnapshot.sourcePath, sha256: gateSnapshot.sha256 },
      original_replay: { path: originalReplaySnapshot.sourcePath, sha256: originalReplaySnapshot.sha256 },
    },
    output_files: {
      report: { path: files.report, sha256: reportWrite.sha256 },
      candidates: { path: files.candidates, sha256: candidateWrite.sha256 },
      replay: { path: files.replay, sha256: replayWrite.sha256 },
      commission_provenance: { path: files.commissionProvenance, sha256: provenanceWrite.sha256 },
      commission_seed: { path: files.commissionSeed, sha256: commissionSeedWrite.sha256 },
    },
  };
  await writeJsonExclusive(files.integrity, integrity);

  return Object.freeze({
    outputDir: destination,
    files: Object.freeze({ ...files }),
    counts: Object.freeze({ ...report.counts }),
    report,
  });
}

function cliArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (!flag?.startsWith("--")) throw new Error(`invalid argument ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    values[flag.slice(2)] = value;
    index += 1;
  }
  return values;
}

function usage() {
  return [
    "Usage: node scripts/postprocess_exact100_supply_only.mjs [options]",
    "",
    "Reads a completed validation-only supply run. It never starts a browser and never publishes, carts, or orders.",
    "",
    `  --candidate-file PATH      default: ${EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.candidateFile}`,
    `  --run-dir PATH             default: ${EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.runDir}`,
    `  --original-replay PATH     default: ${EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.originalReplayFile}`,
    `  --selection-audit PATH     default: ${EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.selectionAuditFile}`,
    `  --output-dir PATH          default: ${EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.outputDir}`,
    "  --expected-count N         default: 100",
    "  --commission-ttl-ms N      default: 21600000 (6 hours; maximum 24 hours)",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const args = cliArguments(argv);
  if (args.help) {
    console.log(usage());
    return null;
  }
  const result = await postprocessExact100SupplyOnly({
    candidateFile: args["candidate-file"] || EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.candidateFile,
    runDir: args["run-dir"] || EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.runDir,
    originalReplayFile: args["original-replay"] || EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.originalReplayFile,
    selectionAuditFile: args["selection-audit"] || EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.selectionAuditFile,
    outputDir: args["output-dir"] || EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.outputDir,
    expectedCount: Number(args["expected-count"] || EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.expectedCount),
    commissionTtlMs: Number(args["commission-ttl-ms"] || EXACT100_SUPPLY_ONLY_POSTPROCESS_DEFAULTS.commissionTtlMs),
  });
  console.log(JSON.stringify({ ok: true, output_dir: result.outputDir, ...result.counts }, null, 2));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
