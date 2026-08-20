import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const VALIDATION_CANDIDATE_FILE_ENV = "FLOW_B_VALIDATION_CANDIDATE_FILE";
export const VALIDATION_SNAPSHOT_PRICE_ENV = "FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE";

const REQUIRED_FIELDS = Object.freeze([
  "cover_image",
  "sell_price",
  "sku",
  "title",
]);
const REQUIRED_FIELD_SET = new Set(REQUIRED_FIELDS);
const AUDITED_CANDIDATE_SET_CONTRACT = "ozon-audited-validation-candidate-set-v1";
const AUDITED_CANDIDATE_MINIMUM = 300;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validationOnlyRequired() {
  return new Error(`${VALIDATION_CANDIDATE_FILE_ENV} is allowed only when FLOW_B_VALIDATION_ONLY=1`);
}

function validationSnapshotPriceError(message) {
  return new Error(`${VALIDATION_SNAPSHOT_PRICE_ENV}=1 ${message}`);
}

function candidateError(sourcePath, index, message) {
  return new Error(`${VALIDATION_CANDIDATE_FILE_ENV} ${sourcePath} candidate ${index + 1}: ${message}`);
}

function normalizeCandidate(candidate, index, sourcePath) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw candidateError(sourcePath, index, "must be a JSON object");
  }

  const keys = Object.keys(candidate);
  const missing = REQUIRED_FIELDS.filter((field) => !Object.hasOwn(candidate, field));
  if (missing.length) {
    throw candidateError(sourcePath, index, `missing required field(s): ${missing.join(", ")}`);
  }
  const unknown = keys.filter((field) => !REQUIRED_FIELD_SET.has(field));
  if (unknown.length) {
    throw candidateError(sourcePath, index, `contains unsupported field(s): ${unknown.sort().join(", ")}`);
  }

  const rawSku = candidate.sku;
  if (
    ![
      "number",
      "string",
    ].includes(typeof rawSku)
    || (typeof rawSku === "number" && (!Number.isSafeInteger(rawSku) || rawSku <= 0))
  ) {
    throw candidateError(sourcePath, index, "sku must be a positive integer or decimal digit string");
  }
  const sku = String(rawSku).trim();
  if (!/^\d+$/u.test(sku) || /^0+$/u.test(sku)) {
    throw candidateError(sourcePath, index, "sku must be a positive integer or decimal digit string");
  }

  if (typeof candidate.title !== "string" || !candidate.title.trim()) {
    throw candidateError(sourcePath, index, "title must be a non-empty string");
  }
  const title = candidate.title.trim();

  if (typeof candidate.sell_price !== "number" || !Number.isFinite(candidate.sell_price) || candidate.sell_price <= 0) {
    throw candidateError(sourcePath, index, "sell_price must be a finite positive JSON number");
  }

  if (typeof candidate.cover_image !== "string" || !candidate.cover_image.trim()) {
    throw candidateError(sourcePath, index, "cover_image must be a non-empty HTTPS URL");
  }
  const coverImage = candidate.cover_image.trim();
  let parsedImageUrl;
  try {
    parsedImageUrl = new URL(coverImage);
  } catch {
    throw candidateError(sourcePath, index, "cover_image must be a valid HTTPS URL");
  }
  if (
    parsedImageUrl.protocol !== "https:"
    || !parsedImageUrl.hostname
    || parsedImageUrl.username
    || parsedImageUrl.password
  ) {
    throw candidateError(sourcePath, index, "cover_image must be a credential-free HTTPS URL");
  }

  return Object.freeze({
    sku,
    title,
    sell_price: candidate.sell_price,
    cover_image: parsedImageUrl.href,
  });
}

function parseJsonCandidates(text, sourcePath, { requireAuditedEnvelope = false } = {}) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${VALIDATION_CANDIDATE_FILE_ENV} ${sourcePath} is not valid JSON: ${error.message}`);
  }
  if (value?.contract === AUDITED_CANDIDATE_SET_CONTRACT) {
    if (Number(value.schema_version) !== 1
      || !Array.isArray(value.candidates)
      || Number(value.candidate_count) !== value.candidates.length
      || !Array.isArray(value.provenance)
      || value.provenance.length !== value.candidates.length
      || Number(value.minimum_candidates) < AUDITED_CANDIDATE_MINIMUM
      || value.candidates.length < Number(value.minimum_candidates)
      || sha256(canonicalJson(value.candidates)) !== value.candidate_set_sha256
      || sha256(canonicalJson(value.provenance)) !== value.provenance_set_sha256
      || !/^[a-f0-9]{64}$/u.test(String(value.provenance_set_sha256 || ""))
      || !/^[a-f0-9]{64}$/u.test(String(value.manifest_sha256 || ""))) {
      throw new Error(`${VALIDATION_CANDIDATE_FILE_ENV} ${sourcePath} audited candidate envelope is invalid or incomplete`);
    }
    return value.candidates;
  }
  if (requireAuditedEnvelope) {
    throw new Error(`${VALIDATION_CANDIDATE_FILE_ENV} ${sourcePath} must contain an audited candidate-set envelope`);
  }
  if (!Array.isArray(value)) {
    throw new Error(`${VALIDATION_CANDIDATE_FILE_ENV} ${sourcePath} must contain a JSON array or audited candidate-set envelope`);
  }
  return value;
}

function parseJsonLinesCandidates(text, sourcePath) {
  const candidates = [];
  for (const [lineIndex, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${VALIDATION_CANDIDATE_FILE_ENV} ${sourcePath} line ${lineIndex + 1} is not valid JSON: ${error.message}`,
      );
    }
    candidates.push(value);
  }
  return candidates;
}

export async function loadValidationCandidateFile(sourceFile, {
  validationOnly = false,
  requireAuditedEnvelope = false,
} = {}) {
  if (validationOnly !== true) throw validationOnlyRequired();
  const sourcePath = path.resolve(String(sourceFile || "").trim());
  const extension = path.extname(sourcePath).toLowerCase();
  if (![".json", ".jsonl"].includes(extension)) {
    throw new Error(`${VALIDATION_CANDIDATE_FILE_ENV} must point to a .json or .jsonl file`);
  }

  const text = await fs.readFile(sourcePath, "utf8");
  const rawCandidates = extension === ".json"
    ? parseJsonCandidates(text, sourcePath, { requireAuditedEnvelope })
    : parseJsonLinesCandidates(text, sourcePath);
  if (requireAuditedEnvelope && extension !== ".json") {
    throw new Error(`${VALIDATION_CANDIDATE_FILE_ENV} audited candidate input must be a JSON envelope`);
  }
  if (!rawCandidates.length) {
    throw new Error(`${VALIDATION_CANDIDATE_FILE_ENV} ${sourcePath} contains no candidates`);
  }

  const candidates = rawCandidates.map((candidate, index) => normalizeCandidate(candidate, index, sourcePath));
  const seenSkus = new Set();
  for (const [index, candidate] of candidates.entries()) {
    if (seenSkus.has(candidate.sku)) {
      throw candidateError(sourcePath, index, `duplicates sku ${candidate.sku}`);
    }
    seenSkus.add(candidate.sku);
  }
  return Object.freeze(candidates);
}

export async function loadAuditedValidationCandidateFile(sourceFile, options = {}) {
  return loadValidationCandidateFile(sourceFile, {
    ...options,
    validationOnly: true,
    requireAuditedEnvelope: true,
  });
}

export async function loadValidationCandidatesFromEnv(env = {}) {
  const sourceFile = String(env?.[VALIDATION_CANDIDATE_FILE_ENV] || "").trim();
  const validationOnly = env?.FLOW_B_VALIDATION_ONLY === "1";
  const snapshotPriceRequested = env?.[VALIDATION_SNAPSHOT_PRICE_ENV] === "1";
  if (snapshotPriceRequested && !validationOnly) {
    throw validationSnapshotPriceError("is allowed only when FLOW_B_VALIDATION_ONLY=1");
  }
  if (snapshotPriceRequested && !sourceFile) {
    throw validationSnapshotPriceError(`requires a loaded ${VALIDATION_CANDIDATE_FILE_ENV}`);
  }
  if (!sourceFile) return null;
  if (!validationOnly) throw validationOnlyRequired();
  return loadValidationCandidateFile(sourceFile, { validationOnly });
}

export function withValidationCandidateFavorites(client, candidates, { validationOnly = false } = {}) {
  if (validationOnly !== true) throw validationOnlyRequired();
  if (!client || typeof client !== "object" || typeof client.listFavorites !== "function") {
    throw new TypeError("a Maozi client with listFavorites() is required");
  }
  if (!Array.isArray(candidates) || !candidates.length) {
    throw new TypeError("validated candidate rows are required");
  }

  const descriptors = Object.getOwnPropertyDescriptors(client);
  delete descriptors.listFavorites;
  const validationClient = Object.create(Object.getPrototypeOf(client), descriptors);
  Object.defineProperty(validationClient, "listFavorites", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: async () => candidates.map((candidate) => ({ ...candidate })),
  });
  return validationClient;
}
