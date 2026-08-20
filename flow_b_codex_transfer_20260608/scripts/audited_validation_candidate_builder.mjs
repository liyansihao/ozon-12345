#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_AUDITED_CANDIDATE_MINIMUM,
  buildAuditedValidationCandidatesFromCampaign,
} from "./flow_b_playwright/audited-validation-discovery.mjs";

const AUDITED_VALIDATION_ROOT = "/Users/mac/.ozon-audited-validation";
const AUDITED_VALIDATION_CAMPAIGNS_ROOT = "/Users/mac/.ozon-audited-validation/campaigns";

function insideDedicatedRoot(filename) {
  const relative = path.relative(AUDITED_VALIDATION_ROOT, path.resolve(filename));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertDedicatedPath(filename, flag) {
  const relative = path.relative(AUDITED_VALIDATION_CAMPAIGNS_ROOT, path.resolve(filename));
  const insideCampaigns = relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  if (!insideCampaigns) throw new Error(`${flag} must stay inside ${AUDITED_VALIDATION_CAMPAIGNS_ROOT}`);
}

async function assertFixedValidationRoot() {
  const stat = await fs.lstat(AUDITED_VALIDATION_ROOT);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${AUDITED_VALIDATION_ROOT} must be a fixed non-symlink directory`);
  }
  const actual = await fs.realpath(AUDITED_VALIDATION_ROOT);
  if (actual !== path.resolve(AUDITED_VALIDATION_ROOT)) {
    throw new Error(`${AUDITED_VALIDATION_ROOT} realpath must equal its pinned path`);
  }
  const production = await fs.realpath("/Users/mac/.ozon-24h-production")
    .catch(() => path.resolve("/Users/mac/.ozon-24h-production"));
  if (actual === production || insideDedicatedRoot(production)) {
    throw new Error("audited validation root overlaps production state");
  }
  return actual;
}

async function assertRealpathContained(filename, flag) {
  const root = await assertFixedValidationRoot();
  let cursor = path.resolve(filename);
  while (true) {
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`${flag} path ancestry must not contain symlinks`);
      const actual = await fs.realpath(cursor);
      const relative = path.relative(root, actual);
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
        throw new Error(`${flag} escapes ${AUDITED_VALIDATION_ROOT}`);
      }
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

function usage() {
  return [
    "Usage:",
    "  node scripts/audited_validation_candidate_builder.mjs \\",
    `    --manifest ${AUDITED_VALIDATION_CAMPAIGNS_ROOT}/<campaign>/campaign.json \\`,
    "    --artifact <ozon_audited_source_portfolio.json> \\",
    "    --out-candidates <candidates.json> \\",
    "    --out-provenance <candidate-provenance.json> \\",
    "    [--enrichment <live_detail_enrichment.jsonl>] \\",
    "    [--minimum 300]",
    "",
    "The builder is local-file only. It never opens a browser, reads Maozi favorites,",
    "changes favorites, or submits products. By default it refuses to emit fewer than",
    `${DEFAULT_AUDITED_CANDIDATE_MINIMUM} fully bound candidates with conservative same-page CNY detail.`,
  ].join("\n");
}

export function parseAuditedCandidateBuilderArgs(argv = []) {
  const result = { minimum: DEFAULT_AUDITED_CANDIDATE_MINIMUM };
  const names = new Map([
    ["--manifest", "manifest"],
    ["--artifact", "artifact"],
    ["--enrichment", "enrichment"],
    ["--out-candidates", "outCandidates"],
    ["--out-provenance", "outProvenance"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--allow-incomplete") throw new Error("--allow-incomplete is forbidden for audited candidate output");
    if (argument === "--minimum") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < DEFAULT_AUDITED_CANDIDATE_MINIMUM) {
        throw new Error(`--minimum must be an integer >= ${DEFAULT_AUDITED_CANDIDATE_MINIMUM}`);
      }
      result.minimum = value;
      continue;
    }
    const key = names.get(argument);
    if (!key) throw new Error(`unsupported argument: ${argument}`);
    const value = String(argv[++index] || "").trim();
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path`);
    result[key] = path.resolve(value);
  }
  for (const [key, flag] of [
    ["manifest", "--manifest"],
    ["artifact", "--artifact"],
    ["outCandidates", "--out-candidates"],
    ["outProvenance", "--out-provenance"],
  ]) {
    if (!result[key]) throw new Error(`${flag} is required`);
  }
  if (result.outCandidates === result.outProvenance) {
    throw new Error("--out-candidates and --out-provenance must be different paths");
  }
  for (const [key, flag] of [
    ["manifest", "--manifest"],
    ["enrichment", "--enrichment"],
    ["outCandidates", "--out-candidates"],
    ["outProvenance", "--out-provenance"],
  ]) {
    if (result[key]) assertDedicatedPath(result[key], flag);
  }
  const inputs = new Set([result.manifest, result.artifact, result.enrichment].filter(Boolean));
  if (inputs.has(result.outCandidates) || inputs.has(result.outProvenance)) {
    throw new Error("candidate/provenance outputs must not overwrite any input path");
  }
  return result;
}

export async function runAuditedCandidateBuilderCli(argv = process.argv.slice(2)) {
  const options = parseAuditedCandidateBuilderArgs(argv);
  if (options.help) return { help: true, text: usage() };
  await Promise.all([
    [options.manifest, "--manifest"],
    [options.enrichment, "--enrichment"],
    [options.outCandidates, "--out-candidates"],
    [options.outProvenance, "--out-provenance"],
  ].filter(([filename]) => filename).map(([filename, flag]) => assertRealpathContained(filename, flag)));
  const assembled = await buildAuditedValidationCandidatesFromCampaign({
    manifestFile: options.manifest,
    artifactFile: options.artifact,
    enrichmentFile: options.enrichment || null,
    candidateOutputFile: options.outCandidates,
    provenanceOutputFile: options.outProvenance,
    minimumCandidates: options.minimum,
    requireReady: true,
  });
  return {
    help: false,
    text: JSON.stringify({
      candidate_file: options.outCandidates,
      provenance_file: options.outProvenance,
      discovered_unique: assembled.discovered_unique,
      candidate_count: assembled.candidate_count,
      minimum_candidates: assembled.minimum_candidates,
      ready: assembled.ready,
      gap_count: assembled.gaps.length,
      listing_card_price_used: assembled.listing_card_price_used,
      price_source: assembled.price_source,
    }, null, 2),
  };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  runAuditedCandidateBuilderCli().then(({ text }) => {
    process.stdout.write(`${text}\n`);
  }).catch((error) => {
    process.stderr.write(`${error?.message || error}\n\n${usage()}\n`);
    process.exitCode = 1;
  });
}
