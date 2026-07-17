import fs from "node:fs/promises";
import path from "node:path";

const BAD_SKUS = new Set(["2815247918"]);
const candidateFactsCache = new Map();
const candidateFactsCompositeCache = new Map();

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function mergeCandidateFacts(favorite = {}, fact = {}) {
  const sku = String(favorite?.sku ?? favorite?.id ?? fact?.sku ?? "").trim();
  const favoriteSalePrice = positive(favorite?.sell_price ?? favorite?.sale_price ?? favorite?.price);
  const salePrice = favoriteSalePrice ?? positive(fact?.sale_price ?? fact?.sell_price);
  const title = String(favorite?.title || fact?.title || "").trim();
  const coverImage = String(favorite?.cover_image || favorite?.coverImage || fact?.cover_image || "").trim() || null;
  const mode = String(favorite?.mode || favorite?.shipping_mode || fact?.shipping_mode || fact?.mode || "").trim() || null;
  const sourceUrl = String(favorite?.source_url || fact?.source_url || "").trim() || null;
  const sellerUrl = String(favorite?.seller_url || fact?.seller_url || "").trim() || null;
  const productUrl = String(favorite?.link || favorite?.detail_url || fact?.source_url_product || fact?.link || "").trim() || null;
  const explicitFavoriteCurrency = String(favorite?.source_currency || "").trim().toUpperCase();
  const sourceCurrency = explicitFavoriteCurrency
    || (favoriteSalePrice ? "CNY" : String(fact?.source_currency || "").trim().toUpperCase())
    || null;
  return {
    ...favorite,
    sku,
    title,
    sell_price: salePrice,
    sale_price: salePrice,
    cover_image: coverImage,
    mode,
    shipping_mode: mode,
    source_currency: sourceCurrency,
    source_url: sourceUrl,
    seller_url: sellerUrl,
    link: productUrl,
  };
}

export function clearCandidateFactsCache() {
  candidateFactsCache.clear();
  candidateFactsCompositeCache.clear();
}

export function candidateFactsCacheStats(runDir) {
  const filename = path.resolve(runDir, "favorite_collection.jsonl");
  const cached = candidateFactsCache.get(filename);
  return {
    full_reads: Number(cached?.fullReads || 0),
    append_reads: Number(cached?.appendReads || 0),
    bytes_read: Number(cached?.bytesRead || 0),
  };
}

function applyCandidateHistoryLines(text, facts, preflightPureSkus) {
  const source = String(text || "");
  const complete = /\r?\n$/.test(source);
  const lines = source.split(/\r?\n/);
  if (complete) lines.pop();
  const tail = complete ? "" : (lines.pop() || "");
  const applyLine = (line) => {
    try {
      const row = JSON.parse(line);
      if (row?.status !== "favorited" || !row?.sku) return false;
      const sku = String(row.sku);
      facts.set(sku, mergeCandidateFacts({}, row));
      if (row?.preflight_mode === "FBS") preflightPureSkus.add(sku);
      return true;
    } catch {
      return false;
    }
  };
  for (const line of lines) applyLine(line);
  const tailParsed = tail ? applyLine(tail) : false;
  return { tail, tailParsed };
}

async function readFileSlice(filename, start, length) {
  const buffer = Buffer.allocUnsafe(length);
  const handle = await fs.open(filename, "r");
  let bytesRead = 0;
  try {
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (!(result.bytesRead > 0)) break;
      bytesRead += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return buffer.subarray(0, bytesRead);
}

async function loadCandidateHistoryFile(filename) {
  const absolute = path.resolve(filename);
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const missing = candidateFactsCache.get(absolute);
    if (missing?.missing) return missing;
    const value = {
      missing: true,
      facts: new Map(),
      preflightPureSkus: new Set(),
      fullReads: 0,
      appendReads: 0,
      bytesRead: 0,
    };
    candidateFactsCache.set(absolute, value);
    return value;
  }
  const cached = candidateFactsCache.get(absolute);
  if (cached
    && Number(cached.ino) === Number(stat.ino)
    && Number(cached.size) === Number(stat.size)
    && Number(cached.mtimeMs) === Number(stat.mtimeMs)) return cached;
  const sameFile = cached && !cached.missing && Number(cached.ino) === Number(stat.ino);
  if (sameFile && Number(stat.size) > Number(cached.size)) {
    const length = Number(stat.size) - Number(cached.size);
    const appended = await readFileSlice(absolute, Number(cached.size), length);
    const appendedText = appended.toString("utf8");
    // A parsed unterminated tail is safe to extend only when the append begins
    // with its record delimiter. Otherwise fall back to a correctness-first
    // full read because the previous JSON value may have been rewritten.
    if (!cached.tailParsed || /^\r?\n/.test(appendedText)) {
      const facts = new Map(cached.facts);
      const preflightPureSkus = new Set(cached.preflightPureSkus);
      const parseText = cached.tailParsed ? appendedText : `${cached.tail || ""}${appendedText}`;
      const parsed = applyCandidateHistoryLines(parseText, facts, preflightPureSkus);
      const value = {
        ino: stat.ino,
        size: Number(cached.size) + appended.length,
        mtimeMs: appended.length === length ? stat.mtimeMs : Number.NaN,
        facts,
        preflightPureSkus,
        tail: parsed.tail,
        tailParsed: parsed.tailParsed,
        fullReads: Number(cached.fullReads || 0),
        appendReads: Number(cached.appendReads || 0) + 1,
        bytesRead: Number(cached.bytesRead || 0) + appended.length,
      };
      candidateFactsCache.set(absolute, value);
      return value;
    }
  }
  const facts = new Map();
  const preflightPureSkus = new Set();
  const text = await fs.readFile(absolute, "utf8");
  const parsed = applyCandidateHistoryLines(text, facts, preflightPureSkus);
  candidateFactsCache.set(absolute, {
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    facts,
    preflightPureSkus,
    tail: parsed.tail,
    tailParsed: parsed.tailParsed,
    fullReads: Number(cached?.fullReads || 0) + 1,
    appendReads: Number(cached?.appendReads || 0),
    bytesRead: Number(cached?.bytesRead || 0) + Buffer.byteLength(text),
  });
  return candidateFactsCache.get(absolute);
}

async function loadCandidateHistory(runDir, seedFiles = []) {
  const filenames = [...new Set([
    ...(Array.isArray(seedFiles) ? seedFiles : []),
    path.resolve(runDir, "favorite_collection.jsonl"),
  ].map((filename) => path.resolve(filename)))];
  const histories = await Promise.all(filenames.map(loadCandidateHistoryFile));
  const key = filenames.join("\0");
  const cached = candidateFactsCompositeCache.get(key);
  if (cached
    && cached.histories.length === histories.length
    && cached.histories.every((history, index) => history === histories[index])) return cached.value;
  const facts = new Map();
  const preflightPureSkus = new Set();
  for (const history of histories) {
    for (const [sku, fact] of history.facts) facts.set(sku, fact);
    for (const sku of history.preflightPureSkus) preflightPureSkus.add(sku);
  }
  const value = { facts, preflightPureSkus };
  candidateFactsCompositeCache.set(key, { histories, value });
  return value;
}

export async function loadCandidateFacts(runDir, seedFiles = []) {
  return (await loadCandidateHistory(runDir, seedFiles)).facts;
}

export async function loadPreflightPureSkus(runDir, seedFiles = []) {
  return (await loadCandidateHistory(runDir, seedFiles)).preflightPureSkus;
}

export function hasReusableCandidateFacts(item) {
  return Boolean(
    String(item?.title || "").trim()
      && /^https?:\/\//i.test(String(item?.cover_image || ""))
      && positive(item?.sale_price ?? item?.sell_price)
      && String(item?.source_currency || "").toUpperCase() === "CNY"
      && String(item?.shipping_mode ?? item?.mode ?? "").trim().toUpperCase() === "FBS",
  );
}

export class AdaptiveConcurrency {
  constructor({ initial = 8, max = 12, min = 2, stableWindow = 12 } = {}) {
    this.min = Math.max(1, Number(min));
    this.max = Math.max(this.min, Number(max));
    this.current = Math.max(this.min, Math.min(this.max, Number(initial)));
    this.stableWindow = Math.max(1, Number(stableWindow));
    this.stable = 0;
  }

  recordSuccess() {
    this.stable += 1;
    if (this.stable >= this.stableWindow && this.current < this.max) {
      this.current += 1;
      this.stable = 0;
    }
    return this.current;
  }

  recordFailure(error) {
    if (/429|too many requests|rate.?limit|soft block|access denied|captcha|timeout|failed to fetch|network|HTTP 0/i.test(String(error?.message || error || ""))) {
      this.current = Math.max(this.min, Math.floor(this.current / 2));
      this.stable = 0;
    }
    return this.current;
  }
}

export function rankSourcesByYield(rows) {
  return [...rows].map((row) => {
    const attempted = Math.max(0, Number(row?.attempted) || 0);
    const published = Math.max(0, Number(row?.published) || 0);
    const segment = String(row?.segment || row?.source_url || "");
    const priorityBoost = /global|中国|china/i.test(segment) ? 0.04 : 0;
    const familyBoost = /儿童|kids|配饰|accessor|服饰|apparel/i.test(segment) ? 0.02 : 0;
    return { ...row, success_rate: attempted ? published / attempted : 0, yield_score: (attempted ? published / attempted : 0) + priorityBoost + familyBoost };
  }).sort((left, right) => right.yield_score - left.yield_score || Number(right.published || 0) - Number(left.published || 0));
}

export function acceptanceSummary({ rows, startedAt, endedAt, target = 50, storeIds = [], perStoreTarget = null }) {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  const durationHours = Math.max(0, end - start) / 3_600_000;
  const unique = new Map();
  for (const row of rows || []) {
    const sku = String(row?.sku || "").trim();
    const at = Date.parse(row?.published_at || row?.timestamp || "");
    if (!sku
      || BAD_SKUS.has(sku)
      || !(Number(row?.profit_rate) > 30)
      || String(row?.online_status || "") !== "selling"
      || !(Number(row?.stock) > 0)
      || !(at >= start && at <= end)) continue;
    unique.set(sku, row);
  }
  const successCount = unique.size;
  const normalizedStoreIds = [...new Set((storeIds || []).map(Number).filter((id) => id > 0))];
  const successByStore = Object.fromEntries(normalizedStoreIds.map((id) => [String(id), 0]));
  for (const row of unique.values()) {
    const storeId = Number(row?.store_id);
    if (!(storeId > 0)) continue;
    const key = String(storeId);
    successByStore[key] = Number(successByStore[key] || 0) + 1;
  }
  const normalizedPerStoreTarget = Number(perStoreTarget);
  const requirePerStore = normalizedStoreIds.length > 0
    && Number.isInteger(normalizedPerStoreTarget)
    && normalizedPerStoreTarget > 0;
  const remainingByStore = requirePerStore
    ? Object.fromEntries(normalizedStoreIds.map((id) => [
      String(id),
      Math.max(0, normalizedPerStoreTarget - Number(successByStore[String(id)] || 0)),
    ]))
    : {};
  const storesPassed = !requirePerStore || Object.values(remainingByStore).every((remaining) => remaining === 0);
  return {
    window_started_at: new Date(start).toISOString(),
    window_ended_at: new Date(end).toISOString(),
    duration_hours: Math.round(durationHours * 1000) / 1000,
    success_count: successCount,
    effective_per_hour: durationHours ? Math.round((successCount / durationHours) * 100) / 100 : 0,
    target: Number(target),
    per_store_target: requirePerStore ? normalizedPerStoreTarget : null,
    success_by_store: successByStore,
    remaining_by_store: remainingByStore,
    passed: successCount >= Number(target) && storesPassed,
    excluded_skus: [...BAD_SKUS],
    skus: [...unique.keys()],
  };
}

export function operationalErrorSummary({ successCount = 0, skippedCount = 0, failedCount = 0, runtimeErrorCount = 0 } = {}) {
  const skuAttempts = Math.max(0, Number(successCount)) + Math.max(0, Number(skippedCount)) + Math.max(0, Number(failedCount));
  const runtimeErrors = Math.max(0, Number(runtimeErrorCount));
  const operationalAttempts = skuAttempts + runtimeErrors;
  const roundRate = (numerator, denominator) => denominator ? Math.round((numerator / denominator) * 10000) / 10000 : 0;
  return {
    error_rate: roundRate(Math.max(0, Number(failedCount)) + runtimeErrors, operationalAttempts),
    sku_error_rate: roundRate(Math.max(0, Number(failedCount)), skuAttempts),
    runtime_error_count: runtimeErrors,
  };
}

export function collectionErrorSummary(rows = []) {
  const attempts = rows.filter((row) => ["favorited", "rejected", "failed"].includes(String(row?.status || "")));
  const failed = attempts.filter((row) => row?.status === "failed").length;
  return {
    collection_attempt_count: attempts.length,
    collection_failed_count: failed,
    collection_error_rate: attempts.length ? Math.round((failed / attempts.length) * 10000) / 10000 : 0,
  };
}

export function summarizeConsumerRound(previous, round = {}) {
  const totals = previous?.totals || { published: 0, attempted: 0, skipped: 0, failed: 0 };
  const number = (value) => Math.max(0, Number(value) || 0);
  return {
    round_count: number(previous?.round_count) + 1,
    totals: {
      published: totals.published + number(round.published),
      attempted: totals.attempted + number(round.attempted),
      skipped: totals.skipped + number(round.skipped),
      failed: totals.failed + number(round.failed),
    },
    last: {
      published: number(round.published),
      attempted: number(round.attempted),
      skipped: number(round.skipped),
      failed: number(round.failed),
      dry_candidates: number(round.dry_candidates),
      final_concurrency: number(round.final_concurrency),
      deadline_reached: Boolean(round.deadline_reached),
    },
  };
}

export async function runProducerLoop({
  scan,
  deadlineMs,
  intervalMs = 10_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onError = async () => {},
  shouldStop = () => false,
} = {}) {
  if (typeof scan !== "function") throw new TypeError("scan is required");
  const deadline = Number(deadlineMs);
  if (!Number.isFinite(deadline)) throw new TypeError("deadlineMs must be finite");
  let lastResult = null;
  while (now() < deadline && !shouldStop()) {
    try {
      lastResult = await scan();
    } catch (error) {
      await onError(error);
    }
    if (shouldStop()) break;
    const wait = Math.min(Math.max(1, Number(intervalMs) || 1), deadline - now());
    if (wait > 0) await sleep(wait);
  }
  return lastResult || { deadline_reached: true };
}

export function isFatalBrowserError(error) {
  return /target (?:page, )?context or browser has been closed|browsercontext\.(?:newpage|close).*target page has been closed|browser has been closed/i
    .test(String(error?.message || error || ""));
}
