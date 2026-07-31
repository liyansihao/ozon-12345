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
  const preflightMode = String(favorite?.preflight_mode || fact?.preflight_mode || "").trim().toUpperCase() || null;
  const mode = String(favorite?.mode || favorite?.shipping_mode || fact?.shipping_mode || fact?.mode || (preflightMode === "FBS" ? "FBS" : "")).trim() || null;
  const sourceUrl = String(favorite?.source_url || fact?.source_url || "").trim() || null;
  const sellerUrl = String(favorite?.seller_url || fact?.seller_url || "").trim() || null;
  const productUrl = String(favorite?.link || favorite?.detail_url || fact?.source_url_product || fact?.link || "").trim() || null;
  const explicitFavoriteCurrency = String(favorite?.source_currency || "").trim().toUpperCase();
  const sourceCurrency = explicitFavoriteCurrency
    || (favoriteSalePrice ? "CNY" : String(fact?.source_currency || "").trim().toUpperCase())
    || null;
  return {
    ...favorite,
    ...(preflightMode ? { preflight_mode: preflightMode } : {}),
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
      if (!["discovered", "favorited"].includes(String(row?.status || "")) || !row?.sku) return false;
      const sku = String(row.sku);
      facts.set(sku, mergeCandidateFacts({}, {
        ...row,
        title: row?.title || row?.text,
        cover_image: row?.cover_image || row?.image_url,
        link: row?.link || row?.href,
      }));
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
    path.resolve(runDir, "candidate_queue.jsonl"),
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

export function acceptanceSummary({
  rows,
  startedAt,
  endedAt,
  target = 50,
  storeIds = [],
  perStoreTarget = null,
  minimumAveragePerHourExclusive = null,
  requireZeroDuplicates = false,
  requireQualityEvidence = false,
  requireCurrentWindowSubmission = false,
  requireExactTarget = false,
  requireExactPerStore = false,
}) {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  const durationHours = Math.max(0, end - start) / 3_600_000;
  const unique = new Map();
  const qualifyingRows = [];
  for (const row of rows || []) {
    const sku = String(row?.sku || "").trim();
    const at = Date.parse(row?.published_at || row?.timestamp || "");
    const submittedAt = Date.parse(row?.submitted_at || row?.created_at || "");
    const qualityEvidencePassed = (
      String(row?.shipping_mode || row?.mode || "").toUpperCase() === "FBS"
      && row?.fbs_evidence?.verified === true
      && row?.cost_verified === true
      && row?.cost?.ok === true
      && Number(row?.cost?.cost) > 0
      && row?.quality_gate_passed === true
    );
    if (!sku
      || BAD_SKUS.has(sku)
      || !(Number(row?.profit_rate) > 30)
      || String(row?.online_status || "") !== "selling"
      || !(Number(row?.stock) > 0)
      || (requireQualityEvidence && !qualityEvidencePassed)
      || (requireCurrentWindowSubmission
        && !(submittedAt >= start && submittedAt <= end))
      || !(at >= start && at <= end)) continue;
    qualifyingRows.push(row);
  }
  qualifyingRows.sort((left, right) => (
    Date.parse(left?.published_at || left?.timestamp || "")
    - Date.parse(right?.published_at || right?.timestamp || "")
  ));
  for (const row of qualifyingRows) {
    const sku = String(row?.sku || "").trim();
    if (!unique.has(sku)) unique.set(sku, row);
  }
  const successCount = unique.size;
  const strictEventCount = qualifyingRows.length;
  const duplicateSkus = Math.max(0, strictEventCount - successCount);
  const qualityViolationCount = requireQualityEvidence
    ? (rows || []).filter((row) => {
      const sku = String(row?.sku || "").trim();
      const at = Date.parse(row?.published_at || row?.timestamp || "");
      const submittedAt = Date.parse(row?.submitted_at || row?.created_at || "");
      const finalStatusEligible = sku
        && !BAD_SKUS.has(sku)
        && Number(row?.profit_rate) > 30
        && String(row?.online_status || "") === "selling"
        && Number(row?.stock) > 0
        && (!requireCurrentWindowSubmission
          || (submittedAt >= start && submittedAt <= end))
        && at >= start
        && at <= end;
      return finalStatusEligible && !(
        String(row?.shipping_mode || row?.mode || "").toUpperCase() === "FBS"
        && row?.fbs_evidence?.verified === true
        && row?.cost_verified === true
        && row?.cost?.ok === true
        && Number(row?.cost?.cost) > 0
        && row?.quality_gate_passed === true
      );
    }).length
    : 0;
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
  const storesPassed = !requirePerStore || normalizedStoreIds.every((id) => {
    const count = Number(successByStore[String(id)] || 0);
    return requireExactPerStore
      ? count === normalizedPerStoreTarget
      : count >= normalizedPerStoreTarget;
  });
  const completionStoreCounts = Object.fromEntries(normalizedStoreIds.map((id) => [String(id), 0]));
  const completionSkus = new Set();
  let targetReachedAt = null;
  for (const row of qualifyingRows) {
    const sku = String(row?.sku || "").trim();
    if (completionSkus.has(sku)) continue;
    completionSkus.add(sku);
    const storeKey = String(Number(row?.store_id || 0));
    if (storeKey in completionStoreCounts) completionStoreCounts[storeKey] += 1;
    const totalReached = completionSkus.size >= Number(target);
    const perStoreReached = !requirePerStore
      || Object.values(completionStoreCounts).every((count) => count >= normalizedPerStoreTarget);
    if (totalReached && perStoreReached) {
      targetReachedAt = Date.parse(row?.published_at || row?.timestamp || "");
      break;
    }
  }
  const hoursToTarget = targetReachedAt === null
    ? null
    : Math.max(Number.EPSILON, targetReachedAt - start) / 3_600_000;
  const effectiveDurationHours = hoursToTarget ?? durationHours;
  const effectiveNumerator = targetReachedAt === null ? successCount : Number(target);
  const effectivePerHour = effectiveDurationHours
    ? Math.round((effectiveNumerator / effectiveDurationHours) * 100) / 100
    : 0;
  const hasSpeedThreshold = minimumAveragePerHourExclusive !== null
    && minimumAveragePerHourExclusive !== undefined
    && Number.isFinite(Number(minimumAveragePerHourExclusive));
  const speedThreshold = hasSpeedThreshold ? Number(minimumAveragePerHourExclusive) : null;
  const speedPassed = !hasSpeedThreshold || effectivePerHour >= speedThreshold;
  return {
    window_started_at: new Date(start).toISOString(),
    window_ended_at: new Date(end).toISOString(),
    duration_hours: Math.round(durationHours * 1000) / 1000,
    success_count: successCount,
    effective_per_hour: effectivePerHour,
    target_reached_at: targetReachedAt === null ? null : new Date(targetReachedAt).toISOString(),
    hours_to_target: hoursToTarget === null
      ? null
      : Math.round(hoursToTarget * 1000) / 1000,
    minimum_average_per_hour_exclusive: speedThreshold,
    duplicate_skus: duplicateSkus,
    quality_evidence_violations: qualityViolationCount,
    target: Number(target),
    per_store_target: requirePerStore ? normalizedPerStoreTarget : null,
    success_by_store: successByStore,
    remaining_by_store: remainingByStore,
    passed: (requireExactTarget
      ? successCount === Number(target)
      : successCount >= Number(target))
      && storesPassed
      && speedPassed
      && qualityViolationCount === 0
      && (!requireZeroDuplicates || duplicateSkus === 0),
    excluded_skus: [...BAD_SKUS],
    skus: [...unique.keys()],
  };
}

export function perStoreAcceptanceTarget(env = {}) {
  if (String(env.FLOW_B_REQUIRE_PER_STORE_ACCEPTANCE ?? "1") === "0") return null;
  return Math.max(
    1,
    Number(env.FLOW_B_STORE_ACCEPTANCE_TARGET)
      || Number(env.FLOW_B_STORE_TOTAL_LIMIT)
      || 100,
  );
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

export function runtimeEmptyBackoffIntervals(env = {}) {
  const values = String(env.FLOW_B_RUNTIME_EMPTY_BACKOFF_MS || "1000,3000,10000")
    .split(",")
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length > 0 ? values : [1_000, 3_000, 10_000];
}

export function runtimeRoundHasActivity(result = {}) {
  return [
    "activity_count",
    "published",
    "submitted_pending",
    "validated",
    "attempted",
  ].some((key) => Number(result?.[key] || 0) > 0);
}

export function runtimeIdleDelay(idleStreak, intervals = [1_000, 3_000, 10_000]) {
  const values = (intervals || []).map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return 0;
  const streak = Math.max(1, Math.floor(Number(idleStreak) || 1));
  return values[Math.min(streak - 1, values.length - 1)];
}

export function createRuntimeWakeSignal({
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let pending = false;
  const waiters = new Set();
  return {
    wake() {
      if (waiters.size === 0) {
        pending = true;
        return;
      }
      for (const waiter of [...waiters]) waiter(true);
    },
    wait(timeoutMs) {
      if (pending) {
        pending = false;
        return Promise.resolve(true);
      }
      const delay = Math.max(0, Number(timeoutMs) || 0);
      if (delay === 0) return Promise.resolve(false);
      return new Promise((resolve) => {
        let timer = null;
        const finish = (woken) => {
          if (!waiters.delete(finish)) return;
          if (timer !== null) clearTimer(timer);
          resolve(woken);
        };
        waiters.add(finish);
        timer = setTimer(() => finish(false), delay);
      });
    },
  };
}

export async function runProducerLoop({
  scan,
  deadlineMs,
  intervalMs = 10_000,
  idleIntervalsMs = [1_000, 3_000, 10_000],
  isIdleResult = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onActivity = async () => {},
  onError = async () => {},
  shouldStop = () => false,
} = {}) {
  if (typeof scan !== "function") throw new TypeError("scan is required");
  const requestedDeadline = Number(deadlineMs);
  const deadline = requestedDeadline === Number.POSITIVE_INFINITY
    ? Number.MAX_SAFE_INTEGER
    : requestedDeadline;
  if (!Number.isFinite(deadline)) throw new TypeError("deadlineMs must be finite or positive infinity");
  let lastResult = null;
  let idleStreak = 0;
  while (now() < deadline && !shouldStop()) {
    let failed = false;
    let idle = false;
    try {
      lastResult = await scan();
      idle = typeof isIdleResult === "function" && isIdleResult(lastResult);
      idleStreak = idle ? idleStreak + 1 : 0;
      if (typeof isIdleResult === "function" && !idle) await onActivity(lastResult);
    } catch (error) {
      await onError(error);
      failed = true;
      idleStreak = 0;
    }
    if (shouldStop()) break;
    const idleDelays = (idleIntervalsMs || []).map(Number).filter((value) => Number.isFinite(value) && value > 0);
    const requestedWait = failed || typeof isIdleResult !== "function"
      ? Math.max(1, Number(intervalMs) || 1)
      : idle
        ? runtimeIdleDelay(idleStreak, idleDelays)
        : 0;
    const wait = Math.min(requestedWait, deadline - now());
    if (wait > 0) await sleep(wait);
  }
  return lastResult || { deadline_reached: true };
}

export async function withRuntimeCleanup(operation, {
  backgroundTask = null,
  cleanup = async () => {},
} = {}) {
  if (typeof operation !== "function") throw new TypeError("operation is required");
  if (typeof cleanup !== "function") throw new TypeError("cleanup must be a function");
  try {
    return await operation();
  } finally {
    if (backgroundTask) await Promise.resolve(backgroundTask).catch(() => {});
    await cleanup();
  }
}

export function isFatalBrowserError(error) {
  if (error?.code === "FLOW_B_OZON_ACCESS_STOPPED") return true;
  return /target (?:page, )?context or browser has been closed|browsercontext\.(?:newpage|close).*target page has been closed|browser has been closed|favorite worker page creation timed out/i
    .test(String(error?.message || error || ""));
}
