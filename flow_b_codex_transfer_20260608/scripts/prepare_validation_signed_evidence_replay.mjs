#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import { pathToFileURL } from "node:url";

import { compactCostOutput, parseCostOutput } from "./flow_b_playwright/cost-bridge.mjs";
import { normalize1688MatchRequest } from "./flow_b_playwright/cost-evidence.mjs";
import { loadValidationCandidateFile } from "./flow_b_playwright/validation-candidate-file.mjs";
import {
  VALIDATION_SIGNED_EVIDENCE_REPLAY_CONTRACT,
  validationCandidateSetSha256,
} from "./flow_b_playwright/validation-signed-evidence-replay.mjs";

const DIGEST_RE = /^[a-f0-9]{64}$/u;
const STRICT_MATCH_TYPES = new Set(["strong_single", "corroborated_multi"]);

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

function signedRequest(output) {
  const encoded = String(output || "").match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1]?.trim() || "";
  if (!encoded) return null;
  try {
    return JSON.parse(encoded)?.request || null;
  } catch {
    return null;
  }
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function sourceCacheKeyPayload({ candidate, request, category, minimumSameItemMatches, cacheKey }) {
  const semantics = {
    expect_title: candidate.title,
    expect_model: compactText(request?.expect_model),
    expect_category: category,
  };
  const base = {
    image_url: candidate.cover_image,
  };
  const price = Number(request?.expect_price_cny);
  const attempts = [];
  for (const sourceMinimum of [...new Set([minimumSameItemMatches, 1, 2, 3])]) {
    if (Number.isFinite(price) && price > 0) {
      attempts.push({
        version: 7,
        ...base,
        minimum_same_item_matches: sourceMinimum,
        excluded_offer_ids: [],
        ...semantics,
        expect_price_cny: price,
      });
    }
    attempts.push({
      version: 6,
      ...base,
      minimum_same_item_matches: sourceMinimum,
      excluded_offer_ids: [],
      ...semantics,
    });
    for (const version of [5, 4]) {
      attempts.push({
        version,
        ...base,
        minimum_same_item_matches: sourceMinimum,
        ...semantics,
      });
    }
  }
  return attempts.find((payload) => sha256Json(payload) === cacheKey) || null;
}

function strictParsedCost(cost = {}) {
  const supporting = Array.isArray(cost?.balanced_supporting_offer_ids)
    ? cost.balanced_supporting_offer_ids.map(compactText).filter(Boolean)
    : [];
  return cost?.ok === true
    && cost?.same_item_match === true
    && cost?.returned_evidence_verified === true
    && cost?.match_evidence_contract === "1688-returned-same-item-v3"
    && cost?.balanced_match === true
    && STRICT_MATCH_TYPES.has(cost?.balanced_match_type)
    && supporting.length >= (cost.balanced_match_type === "strong_single" ? 1 : 2);
}

function sourceRowMatchesCandidate(row, candidate) {
  return row?.status === "validated"
    && row?.quality_gate_passed === true
    && row?.cost_verified === true
    && compactText(row?.sku) === candidate.sku
    && compactText(row?.title) === candidate.title
    && Number(row?.sale_price) === candidate.sell_price
    && canonicalUrl(row?.quality_evidence?.image?.url) === candidate.cover_image
    && row?.cost?.returned_evidence_verified === true
    && row?.cost?.match_evidence_contract === "1688-returned-same-item-v3"
    && row?.cost?.balanced_match === true
    && STRICT_MATCH_TYPES.has(row?.cost?.balanced_match_type)
    && DIGEST_RE.test(compactText(row?.cost?.cache_key));
}

async function latestSourceRows(validationGateFile, candidates) {
  const candidateBySku = new Map(candidates.map((candidate) => [candidate.sku, candidate]));
  const rows = new Map();
  const input = createReadStream(validationGateFile, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const candidate = candidateBySku.get(compactText(row?.sku));
    if (candidate && sourceRowMatchesCandidate(row, candidate)) rows.set(candidate.sku, row);
  }
  return rows;
}

export async function buildValidationSignedEvidenceReplay({
  candidateFile,
  validationGateFile,
  cacheFile,
  outputFile,
  minimumSameItemMatches = 1,
} = {}) {
  const candidates = await loadValidationCandidateFile(candidateFile, { validationOnly: true });
  const minimumMatches = Math.max(1, Number(minimumSameItemMatches) || 1);
  const sourceRows = await latestSourceRows(path.resolve(validationGateFile), candidates);
  const sourceCache = JSON.parse(await fs.readFile(path.resolve(cacheFile), "utf8"));
  if (!sourceCache?.entries || typeof sourceCache.entries !== "object") {
    throw new Error("source 1688 cache has no entries object");
  }

  const entries = {};
  const rejected = [];
  for (const candidate of candidates) {
    const row = sourceRows.get(candidate.sku);
    if (!row) {
      rejected.push({ sku: candidate.sku, reason: "no exact validated source row" });
      continue;
    }
    const cacheKey = compactText(row.cost.cache_key);
    const cacheEntry = sourceCache.entries[cacheKey];
    const output = String(cacheEntry?.output || "");
    if (!output || cacheEntry?.deferred === true || Number(cacheEntry?.process_code) !== 0) {
      rejected.push({ sku: candidate.sku, reason: "source cache entry is missing or not successful" });
      continue;
    }
    const request = signedRequest(output);
    const category = (Array.isArray(row?.quality_evidence?.category?.labels)
      ? row.quality_evidence.category.labels
      : []).slice(0, 2).map(compactText).filter(Boolean).join(" ");
    if (!request || !category) {
      rejected.push({ sku: candidate.sku, reason: "signed request or exact category is missing" });
      continue;
    }
    const currentIdentity = normalize1688MatchRequest({
      expect_title: candidate.title,
      expect_model: request.expect_model,
      expect_category: category,
      expect_price_cny: request.expect_price_cny,
    });
    if (JSON.stringify(currentIdentity) !== JSON.stringify(normalize1688MatchRequest(request))) {
      rejected.push({ sku: candidate.sku, reason: "signed request identity differs from the candidate" });
      continue;
    }
    const cacheKeyPayload = sourceCacheKeyPayload({
      candidate,
      request,
      category,
      minimumSameItemMatches: minimumMatches,
      cacheKey,
    });
    if (!cacheKeyPayload) {
      rejected.push({ sku: candidate.sku, reason: "source cache key cannot be rebound to the exact candidate image" });
      continue;
    }
    const parsed = parseCostOutput(output, candidate.sell_price, {
      expectedMatchEvidence: request,
      requireSameItemEvidence: true,
      minimumSameItemMatches: minimumMatches,
      requiredEvidenceContract: "1688-returned-same-item-v3",
      requireBalancedMatch: true,
      allowSignedSelectedOfferDerivation: true,
    });
    if (!strictParsedCost(parsed)) {
      rejected.push({ sku: candidate.sku, reason: parsed?.reason || "signed evidence is not strict" });
      continue;
    }
    const sourceSelectedOfferId = compactText(row.cost.selected_offer_id);
    if (compactText(parsed.match_evidence_key) !== compactText(row.cost.match_evidence_key)
      || Number(parsed.cost) !== Number(row.cost.cost)
      || (sourceSelectedOfferId
        ? compactText(parsed.selected_offer_id) !== sourceSelectedOfferId
        : parsed.selected_offer_id_origin !== "signed-selected-cost-unique-row-v1")) {
      rejected.push({ sku: candidate.sku, reason: "signed output differs from the validated source row" });
      continue;
    }
    const compactOutput = compactCostOutput(output);
    entries[candidate.sku] = {
      sku: candidate.sku,
      title: candidate.title,
      sell_price: candidate.sell_price,
      cover_image: candidate.cover_image,
      expect_model: compactText(request.expect_model),
      expect_category: category,
      source_validation_at: row.validated_at || row.at || null,
      source_cache_key: cacheKey,
      source_cache_key_payload: cacheKeyPayload,
      match_evidence_key: parsed.match_evidence_key,
      selected_offer_id: parsed.selected_offer_id,
      selected_offer_id_origin: parsed.selected_offer_id_origin || "signed-selected-offer-id-v1",
      source_output_sha256: sha256Text(output),
      compact_output_sha256: sha256Text(compactOutput),
      source_output: output,
      output: compactOutput,
    };
  }

  const manifest = {
    contract: VALIDATION_SIGNED_EVIDENCE_REPLAY_CONTRACT,
    created_at: new Date().toISOString(),
    purpose: "validation-only; signed same-item recall followed by current 1688 quantity-one detail and profit checks",
    candidate_file_sha256: crypto.createHash("sha256")
      .update(await fs.readFile(path.resolve(candidateFile)))
      .digest("hex"),
    candidate_set_sha256: validationCandidateSetSha256(candidates),
    candidate_count: candidates.length,
    minimum_same_item_matches: minimumMatches,
    entry_count: Object.keys(entries).length,
    entries,
    rejected,
  };
  const destination = path.resolve(outputFile);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return { destination, manifest };
}

function cliArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${flag || "end"}`);
    values[flag.slice(2)] = value;
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = cliArguments(argv);
  for (const required of ["candidate-file", "validation-gate", "cache-file", "output"]) {
    if (!compactText(args[required])) throw new Error(`--${required} is required`);
  }
  const result = await buildValidationSignedEvidenceReplay({
    candidateFile: args["candidate-file"],
    validationGateFile: args["validation-gate"],
    cacheFile: args["cache-file"],
    outputFile: args.output,
    minimumSameItemMatches: Number(args["minimum-matches"] || 1),
  });
  console.log(JSON.stringify({
    ok: true,
    output: result.destination,
    candidate_count: result.manifest.candidate_count,
    replay_entry_count: result.manifest.entry_count,
    rejected_count: result.manifest.rejected.length,
  }, null, 2));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
