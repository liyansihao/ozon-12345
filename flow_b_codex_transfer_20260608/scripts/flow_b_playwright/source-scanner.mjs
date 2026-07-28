import fs from "node:fs/promises";
import path from "node:path";
import { ensureMaoziLogin, ensureMaoziPluginLogin, openMaoziPage } from "./browser-context.mjs";
import { createCandidateQueue } from "./candidate-queue.mjs";
import { AdaptiveConcurrency, isFatalBrowserError } from "./continuous-runtime.mjs";
import { isPureFbs, prohibitedCategorySkipReason } from "./publish-policy.mjs";
import { isOzonAccessStoppedError, isOzonCaptchaText, ozonAccessControllerFor } from "./ozon-access-controller.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_SOURCE_YIELD_HISTORY = path.resolve(import.meta.dirname, "../../data/flow_b/source_yield_history.jsonl");
const DEFAULT_FBS_SOURCE_HISTORY = path.resolve(import.meta.dirname, "../../data/flow_b/fbs_source_history.jsonl");
const collectionRuntimeStates = new Map();
const collectionRuntimeWriteChains = new Map();
const jsonLinesFileCache = new Map();
const jsonArrayFileCache = new Map();

export function candidateQueueTransitionForCollectionResult(result, {
  nowMs = Date.now(),
  deferMs = 10 * 60_000,
} = {}) {
  const status = String(result?.status || "");
  if (status === "favorited") return { status: "favorited", data: { reason: null } };
  if (status === "rejected") {
    return { status: "rejected", data: { reason: String(result?.reason || "rejected") } };
  }
  if (["failed", "deferred", "capacity_reached"].includes(status)) {
    const reason = String(result?.reason || result?.error?.message || result?.error || status);
    return {
      status: "deferred",
      data: {
        reason,
        retry_at: new Date(Number(nowMs) + Math.max(1_000, Number(deferMs) || 0)).toISOString(),
      },
    };
  }
  return null;
}

export function selectRecoveredCandidateTranche(rows = [], {
  limit = 48,
  lowYieldLimit = 4,
} = {}) {
  const maximum = Math.max(0, Math.floor(Number(limit) || 0));
  const maximumLowYield = Math.max(0, Math.floor(Number(lowYieldLimit) || 0));
  if (maximum === 0) return [];
  const selected = [];
  let lowYieldCount = 0;
  for (const row of rows || []) {
    const lowYieldDeferred = /source deferred after low pure-FBS yield/i.test(String(row?.reason || ""));
    if (lowYieldDeferred) {
      if (lowYieldCount >= maximumLowYield) continue;
      lowYieldCount += 1;
    }
    selected.push(row);
    if (selected.length >= maximum) break;
  }
  return selected;
}

function parseJsonLinesChunk(text) {
  const source = String(text || "");
  const complete = /\r?\n$/.test(source);
  const parts = source.split(/\r?\n/);
  if (complete) parts.pop();
  const tail = complete ? "" : (parts.pop() || "");
  const rows = [];
  for (const line of parts) {
    try { rows.push(JSON.parse(line)); } catch {}
  }
  let tailParsed = false;
  if (tail) {
    try {
      rows.push(JSON.parse(tail));
      tailParsed = true;
    } catch {}
  }
  return { rows, tail, tailParsed };
}

export function clearJsonLinesFileCache() {
  jsonLinesFileCache.clear();
}

export function jsonLinesFileCacheStats(filename) {
  const cached = jsonLinesFileCache.get(path.resolve(filename));
  return {
    full_reads: Number(cached?.fullReads || 0),
    append_reads: Number(cached?.appendReads || 0),
    bytes_read: Number(cached?.bytesRead || 0),
  };
}

export async function readJsonLinesIncremental(filename) {
  const absolute = path.resolve(filename);
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const cached = jsonLinesFileCache.get(absolute);
  const sameFile = cached && Number(cached.ino) === Number(stat.ino);
  if (sameFile
    && Number(cached.size) === Number(stat.size)
    && Number(cached.mtimeMs) === Number(stat.mtimeMs)) return cached.rows;

  if (sameFile && Number(stat.size) > Number(cached.size)) {
    const length = Number(stat.size) - Number(cached.size);
    const buffer = Buffer.allocUnsafe(length);
    const handle = await fs.open(absolute, "r");
    let bytesRead = 0;
    try {
      while (bytesRead < length) {
        const result = await handle.read(
          buffer,
          bytesRead,
          length - bytesRead,
          Number(cached.size) + bytesRead,
        );
        if (!(result.bytesRead > 0)) break;
        bytesRead += result.bytesRead;
      }
    } finally {
      await handle.close();
    }
    const parsed = parseJsonLinesChunk(`${cached.tail || ""}${buffer.subarray(0, bytesRead).toString("utf8")}`);
    const baseRows = cached.tailParsed ? cached.rows.slice(0, -1) : cached.rows;
    const value = {
      ino: stat.ino,
      size: Number(cached.size) + bytesRead,
      mtimeMs: bytesRead === length ? stat.mtimeMs : Number.NaN,
      rows: [...baseRows, ...parsed.rows],
      tail: parsed.tail,
      tailParsed: parsed.tailParsed,
      fullReads: Number(cached.fullReads || 0),
      appendReads: Number(cached.appendReads || 0) + 1,
      bytesRead: Number(cached.bytesRead || 0) + bytesRead,
    };
    jsonLinesFileCache.set(absolute, value);
    return value.rows;
  }

  const text = await fs.readFile(absolute, "utf8");
  const parsed = parseJsonLinesChunk(text);
  const value = {
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    rows: parsed.rows,
    tail: parsed.tail,
    tailParsed: parsed.tailParsed,
    fullReads: Number(cached?.fullReads || 0) + 1,
    appendReads: Number(cached?.appendReads || 0),
    bytesRead: Number(cached?.bytesRead || 0) + Buffer.byteLength(text),
  };
  jsonLinesFileCache.set(absolute, value);
  return value.rows;
}

export function clearJsonArrayFileCache() {
  jsonArrayFileCache.clear();
}

export function jsonArrayFileCacheStats(filename) {
  const cached = jsonArrayFileCache.get(path.resolve(filename));
  return {
    full_reads: Number(cached?.fullReads || 0),
    writes: Number(cached?.writes || 0),
    bytes_read: Number(cached?.bytesRead || 0),
  };
}

export async function readJsonArrayCached(filename) {
  const absolute = path.resolve(filename);
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const cached = jsonArrayFileCache.get(absolute);
  if (cached
    && Number(cached.ino) === Number(stat.ino)
    && Number(cached.size) === Number(stat.size)
    && Number(cached.mtimeMs) === Number(stat.mtimeMs)) return cached.rows;
  const text = await fs.readFile(absolute, "utf8");
  let rows = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) rows = parsed;
  } catch {}
  jsonArrayFileCache.set(absolute, {
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    rows,
    fullReads: Number(cached?.fullReads || 0) + 1,
    writes: Number(cached?.writes || 0),
    bytesRead: Number(cached?.bytesRead || 0) + Buffer.byteLength(text),
  });
  return rows;
}

export async function writeJsonArrayCached(filename, rows) {
  const absolute = path.resolve(filename);
  const temporary = `${absolute}.tmp`;
  const cached = jsonArrayFileCache.get(absolute);
  const text = JSON.stringify(Array.isArray(rows) ? rows : []);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fs.writeFile(temporary, text, "utf8");
    await fs.rename(temporary, absolute);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  const stat = await fs.stat(absolute);
  jsonArrayFileCache.set(absolute, {
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    rows,
    fullReads: Number(cached?.fullReads || 0),
    writes: Number(cached?.writes || 0) + 1,
    bytesRead: Number(cached?.bytesRead || 0),
  });
}

export function shouldWriteSourceCheckpoint(completedBatches, interval = 4) {
  const every = Math.max(1, Number(interval) || 1);
  return Number(completedBatches) > 0 && Number(completedBatches) % every === 0;
}

export function collectionRuntimeState(key) {
  const normalized = String(key || "default");
  if (!collectionRuntimeStates.has(normalized)) {
    collectionRuntimeStates.set(normalized, {
      nextApiAt: 0,
      nextDetailAt: 0,
      detailBlockedUntil: 0,
      detailSoftBlockStreak: 0,
      lastDetailSoftBlockAt: 0,
      sourceSoftBlockStreak: 0,
      lastSourceSoftBlockAt: 0,
    });
  }
  return collectionRuntimeStates.get(normalized);
}

export async function persistCollectionRuntimeState(filename, state = {}) {
  const absolute = path.resolve(filename);
  const payload = {
    version: 1,
    updated_at: new Date().toISOString(),
    detail_interval_ms: Number(state.detailIntervalMs) || 0,
    detail_stable_successes: Math.max(0, Math.floor(Number(state.detailStableSuccesses) || 0)),
    detail_soft_block_streak: Math.max(0, Math.floor(Number(state.detailSoftBlockStreak) || 0)),
    last_detail_soft_block_at: Math.max(0, Number(state.lastDetailSoftBlockAt) || 0),
    source_soft_block_streak: Math.max(0, Math.floor(Number(state.sourceSoftBlockStreak) || 0)),
    last_source_soft_block_at: Math.max(0, Number(state.lastSourceSoftBlockAt) || 0),
    detail_blocked_until: Math.max(0, Number(state.detailBlockedUntil) || 0),
  };
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(payload)}\n`, "utf8");
    await fs.rename(temporary, absolute);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export function queueCollectionRuntimeStatePersist(filename, state) {
  const absolute = path.resolve(filename);
  const previous = collectionRuntimeWriteChains.get(absolute) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => persistCollectionRuntimeState(absolute, state));
  collectionRuntimeWriteChains.set(absolute, next);
  return next.finally(() => {
    if (collectionRuntimeWriteChains.get(absolute) === next) collectionRuntimeWriteChains.delete(absolute);
  });
}

export async function restoreCollectionRuntimeState(key, filename, {
  now = Date.now(),
  minIntervalMs = 0,
  maxIntervalMs = 6000,
} = {}) {
  const runtime = collectionRuntimeState(key);
  let saved;
  try { saved = JSON.parse(await fs.readFile(path.resolve(filename), "utf8")); }
  catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return runtime;
  }
  const minimum = Math.max(0, Number(minIntervalMs) || 0);
  const maximum = Math.max(minimum, Number(maxIntervalMs) || minimum);
  runtime.detailIntervalMs = Math.max(minimum, Math.min(maximum, Number(saved.detail_interval_ms) || minimum));
  runtime.detailStableSuccesses = Math.max(0, Math.floor(Number(saved.detail_stable_successes) || 0));
  runtime.detailSoftBlockStreak = Math.max(0, Math.floor(Number(saved.detail_soft_block_streak) || 0));
  runtime.lastDetailSoftBlockAt = Math.max(0, Number(saved.last_detail_soft_block_at) || 0);
  runtime.sourceSoftBlockStreak = Math.max(0, Math.floor(Number(saved.source_soft_block_streak) || 0));
  runtime.lastSourceSoftBlockAt = Math.max(0, Number(saved.last_source_soft_block_at) || 0);
  const blockedUntil = Math.max(0, Number(saved.detail_blocked_until) || 0);
  runtime.detailBlockedUntil = blockedUntil > Number(now) ? blockedUntil : 0;
  return runtime;
}

export function sourceAdaptiveConcurrency(key, options = {}) {
  const runtime = collectionRuntimeState(key);
  const min = Math.max(1, Number(options.min ?? 2));
  const max = Math.max(min, Number(options.max ?? 12));
  const stableWindow = Math.max(1, Number(options.stableWindow ?? 12));
  const existing = runtime.sourceAdaptiveConcurrency;
  if (existing
    && existing.min === min
    && existing.max === max
    && existing.stableWindow === stableWindow) return existing;
  runtime.sourceAdaptiveConcurrency = new AdaptiveConcurrency({ ...options, min, max, stableWindow });
  return runtime.sourceAdaptiveConcurrency;
}

export function sourceAdaptiveStableWindow(env = {}) {
  const configured = Number(env.FLOW_B_SOURCE_STABLE_WINDOW);
  return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 12;
}

export function nextDetailPacingState({
  intervalMs,
  stableSuccesses = 0,
  baseIntervalMs = 3000,
  minIntervalMs = 2000,
  maxIntervalMs = 6000,
  stepMs = 500,
  softBlockStepMs = 1000,
  stableWindow = 12,
  event = "success",
} = {}) {
  const base = Math.max(0, Number(baseIntervalMs) || 0);
  const minimum = Math.min(base, Math.max(0, Number(minIntervalMs) || 0));
  const maximum = Math.max(base, Number(maxIntervalMs) || base * 2);
  const step = Math.max(1, Number(stepMs) || 1);
  const softBlockStep = Math.max(step, Number(softBlockStepMs) || 1000);
  const window = Math.max(1, Number(stableWindow) || 1);
  const current = Math.max(minimum, Math.min(maximum, Number(intervalMs) || base));
  if (event === "soft-block") {
    return {
      intervalMs: Math.min(maximum, Math.max(base, current) + softBlockStep),
      stableSuccesses: 0,
    };
  }
  if (event !== "success") return { intervalMs: current, stableSuccesses: 0 };
  const stable = Math.max(0, Number(stableSuccesses) || 0) + 1;
  if (stable < window || current <= minimum) return { intervalMs: current, stableSuccesses: stable };
  return { intervalMs: Math.max(minimum, current - step), stableSuccesses: 0 };
}

export function favoriteDetailPacingOptions(env = {}) {
  const baseIntervalMs = Math.max(0, envNumber(env, "FLOW_B_FAVORITE_DETAIL_INTERVAL_MS", 1500));
  return {
    baseIntervalMs,
    minIntervalMs: Math.min(
      baseIntervalMs,
      Math.max(0, envNumber(env, "FLOW_B_MIN_FAVORITE_DETAIL_INTERVAL_MS", baseIntervalMs)),
    ),
    maxIntervalMs: Math.max(
      baseIntervalMs,
      envNumber(env, "FLOW_B_MAX_FAVORITE_DETAIL_INTERVAL_MS", baseIntervalMs * 2),
    ),
    stepMs: Math.max(1, envNumber(env, "FLOW_B_FAVORITE_DETAIL_INTERVAL_STEP_MS", 500)),
    softBlockStepMs: Math.max(1, envNumber(env, "FLOW_B_FAVORITE_DETAIL_SOFT_BLOCK_STEP_MS", 1000)),
    stableWindow: Math.max(1, envNumber(env, "FLOW_B_FAVORITE_DETAIL_STABLE_WINDOW", 12)),
  };
}

export function sourceAfterScanWaitMs(env = {}, runtime = {}, remainingMs = Number.POSITIVE_INFINITY) {
  const configuredMs = Math.max(0, envNumber(env, "FLOW_B_MAOZI_AFTER_SCAN_WAIT", 10) * 1000);
  const detailIntervalMs = Math.max(
    0,
    Number(runtime?.detailIntervalMs) || favoriteDetailPacingOptions(env).baseIntervalMs,
  );
  const adaptiveMs = Math.max(3000, detailIntervalMs * 2);
  return Math.max(0, Math.min(configuredMs, adaptiveMs, Number(remainingMs)));
}

export function collectionDeadlineMs(env = process.env) {
  const value = Date.parse(String(env.FLOW_B_DEADLINE_AT || ""));
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

export function isCollectionDeadlineReached(env = process.env, now = Date.now()) {
  return Number(now) >= collectionDeadlineMs(env);
}

export function remainingCollectionCooldown(state = {}, now = Date.now()) {
  return Math.max(0, (Number(state?.detailBlockedUntil) || 0) - Number(now));
}

export function sourceBatchCollectionMode({
  favoriteTotal,
  target,
  cooldownRemainingMs,
  sourceBlocked,
}) {
  if (favoriteTotal !== null && favoriteTotal !== undefined && Number(favoriteTotal) >= Number(target)) return "done";
  if (sourceBlocked || Number(cooldownRemainingMs) > 0 || favoriteTotal === null || favoriteTotal === undefined) {
    return "queue-only";
  }
  return "collect";
}

export function shouldScanSourcesDuringDetailCooldown({
  cooldownRemainingMs,
}) {
  const remaining = Math.max(0, Number(cooldownRemainingMs) || 0);
  return remaining === 0;
}

export async function withTimeout(operation, timeoutMs, label = "operation") {
  const timeout = Math.max(1, Number(timeoutMs) || 1);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createFavoriteWorkerPage(context, timeoutMs = 10_000) {
  let expired = false;
  const operation = Promise.resolve().then(() => context.newPage()).then(async (page) => {
    if (expired) {
      await page.close().catch(() => {});
      throw new Error("favorite worker page creation completed after timeout");
    }
    return page;
  });
  try {
    return await withTimeout(operation, timeoutMs, "favorite worker page creation");
  } finally {
    expired = true;
  }
}

function isReusablePageOpen(page) {
  return Boolean(page) && (typeof page.isClosed !== "function" || !page.isClosed());
}

export async function ensureReusablePageSlots(context, pages, count, timeoutMs = 10_000) {
  const target = Math.max(0, Number(count) || 0);
  await Promise.all(Array.from({ length: target }, async (_, index) => {
    if (isReusablePageOpen(pages[index])) return;
    pages[index] = await createFavoriteWorkerPage(context, timeoutMs);
  }));
  return pages.slice(0, target);
}

export async function closeReusablePages(pages, timeoutMs = 5_000) {
  const closing = pages.splice(0, pages.length);
  await Promise.all(closing.map((page) => isReusablePageOpen(page)
    ? withTimeout(page.close(), timeoutMs, "reusable page close").catch(() => {})
    : Promise.resolve()));
}

export async function closeRuntimeReusablePagePools(runtime, timeoutMs = 5_000) {
  await Promise.all([
    closeReusablePages(runtime.sourcePagePool || [], timeoutMs),
    closeReusablePages(runtime.favoriteWorkerPagePool || [], timeoutMs),
  ]);
  runtime.sourcePagePool = [];
  runtime.favoriteWorkerPagePool = [];
  runtime.pagePoolContext = null;
}

export async function runtimeReusablePagePools(runtime, context, timeoutMs = 5_000) {
  if (runtime.pagePoolContext && runtime.pagePoolContext !== context) {
    await closeRuntimeReusablePagePools(runtime, timeoutMs);
  }
  runtime.pagePoolContext = context;
  runtime.sourcePagePool ||= [];
  runtime.favoriteWorkerPagePool ||= [];
  return {
    sourcePages: runtime.sourcePagePool,
    favoritePages: runtime.favoriteWorkerPagePool,
  };
}

export function readFavoriteSkusWithTimeout(operation, timeoutMs = 10_000) {
  return withTimeout(
    Promise.resolve().then(operation),
    timeoutMs,
    "favorite SKU telemetry",
  );
}

export function readFavoriteCountWithTimeout(operation, timeoutMs = 10_000) {
  return withTimeout(
    Promise.resolve().then(operation),
    timeoutMs,
    "favorite count telemetry",
  );
}

export async function waitForMovingDeadline({ getDeadline, now = () => Date.now(), sleep: wait = sleep }) {
  while (true) {
    const remaining = Number(getDeadline()) - Number(now());
    if (!(remaining > 0)) return;
    await wait(remaining);
  }
}

function envNumber(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export function verifiedSellerMinimumPublished(env = process.env) {
  return Math.max(2, Math.floor(envNumber(env, "FLOW_B_VERIFIED_SELLER_MIN_PUBLISHED", 2)));
}

export function retainedReplayLimit(env = process.env) {
  return Math.max(0, Math.floor(envNumber(env, "FLOW_B_MAX_RETAINED_LINKS", 12)));
}

async function waitForContent(page, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      ready: document.readyState,
      bodyLength: document.body?.innerText?.length || 0,
      products: document.querySelectorAll('a[href*="/product/"]').length,
    })).catch(() => ({}));
    if (state.ready === "complete" && (state.bodyLength > 1000 || state.products > 0)) return state;
    await sleep(700);
  }
  return null;
}

export async function waitForListingEnrichment(page, {
  maxWaitMs = 8000,
  minWaitMs = 1500,
  pollMs = 500,
  minProducts = 12,
  now = Date.now,
  wait = sleep,
} = {}) {
  const maximum = Math.max(0, Number(maxWaitMs) || 0);
  const minimum = Math.min(maximum, Math.max(0, Number(minWaitMs) || 0));
  const interval = Math.max(1, Number(pollMs) || 1);
  const productTarget = Math.max(1, Number(minProducts) || 1);
  const startedAt = Number(now());
  const deadline = startedAt + maximum;
  let state = {};
  while (true) {
    state = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('a[href*="/product/"]')];
      const cards = [...new Set(anchors.map((anchor) => anchor.closest("div[data-index]")).filter(Boolean))];
      return {
        products: anchors.length,
        richCards: cards.filter((card) => String(card.innerText || "").trim().length >= 30
          && card.querySelector("img[src]")).length,
        modeCards: cards.filter((card) => /发货模式\s*[：:]/i.test(String(card.innerText || ""))).length,
      };
    }).catch(() => ({}));
    const currentTime = Number(now());
    const elapsed = currentTime - startedAt;
    const ready = elapsed >= minimum && (
      Number(state.modeCards) > 0
      || (Number(state.products) >= productTarget && Number(state.richCards) >= Math.min(4, productTarget))
    );
    if (ready) return { ...state, ready: true, elapsedMs: elapsed };
    if (currentTime >= deadline) return { ...state, ready: false, elapsedMs: elapsed };
    await wait(Math.min(interval, deadline - currentTime));
  }
}

export function isFavoriteSessionAuthenticated({ hasToken, httpOk, code, pageText }) {
  return Boolean(hasToken)
    && Boolean(httpOk)
    && Number(code) === 1
    && !/登录|手机号|验证码|密码|login/i.test(String(pageText || ""));
}

export function requiresFavoriteSession(env = process.env) {
  return env.FLOW_B_MAOZI_AUTOFAVORITE !== "0";
}

export function canClaimFavorite({ total, inFlight, target }) {
  return Number(total) + Number(inFlight) < Number(target);
}

export function favoriteRetryDelay(error, attempt) {
  const message = String(error?.message || error || "");
  if (/HTTP 429|too many requests|rate.?limit/i.test(message)) {
    return Math.min(60_000, 15_000 * (2 ** Math.max(0, attempt)));
  }
  if (/failed to fetch|network|ECONN|ETIMEDOUT|timeout/i.test(message)) {
    return Math.min(15_000, 2_000 * (2 ** Math.max(0, attempt)));
  }
  return null;
}

export async function retryMaoziPageFetch(operation, {
  attempts = 5,
  sleep: wait = sleep,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < Math.max(1, Number(attempts) || 1); attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const delay = favoriteRetryDelay(error, attempt);
      if (delay === null || attempt + 1 >= attempts) throw error;
      await wait(delay);
    }
  }
  throw lastError;
}

export function isFavoriteCapacityReached(error) {
  return /收藏数量已达上限|favorite.*(?:limit|capacity)/i.test(String(error?.message || error || ""));
}

export async function appendFavoriteEvidence({
  logFile,
  historyFile = null,
  row,
  now = () => new Date(),
}) {
  const runLog = path.resolve(logFile);
  const durableLog = historyFile ? path.resolve(historyFile) : null;
  const event = {
    at: now().toISOString(),
    run_id: path.basename(path.dirname(runLog)),
    ...row,
  };
  const targets = [...new Set([
    runLog,
    event.source_url ? durableLog : null,
  ].filter(Boolean))];
  await Promise.all(targets.map(async (filename) => {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.appendFile(filename, `${JSON.stringify(event)}\n`);
  }));
  return event;
}

export function favoriteFailureDisposition(error) {
  const message = String(error?.message || error || "");
  if (/^non-pure-fbs:/i.test(message)) return { status: "rejected", reason: "non-pure-fbs" };
  if (/^missing-shipping-mode:/i.test(message)) return { status: "rejected", reason: "missing-shipping-mode" };
  if (/^source-price-above-limit:/i.test(message)) return { status: "rejected", reason: "source-price-above-limit" };
  if (/^oversized-low-yield-title:/i.test(message)) return { status: "rejected", reason: "oversized-low-yield-title" };
  if (/^prohibited-category:/i.test(message)) return { status: "rejected", reason: "prohibited-category" };
  return { status: "failed", reason: null };
}

export function shouldDeferSourceAfterNonFbsSample(stats = {}, limit = 6) {
  const threshold = Math.max(0, Math.floor(Number(limit) || 0));
  if (threshold === 0) return false;
  const attempted = Math.max(0, Number(stats.attempted) || 0);
  const nonPureFbs = Math.max(0, Number(stats.nonPureFbs) || 0);
  const favorited = Math.max(0, Number(stats.favorited) || 0);
  const overwhelminglyNonFbs = nonPureFbs / attempted >= 0.8;
  return overwhelminglyNonFbs && (
    (nonPureFbs >= threshold && attempted >= threshold && favorited === 0)
    || (attempted >= threshold + 2 && favorited <= 1)
  );
}

export function adaptiveNonFbsSampleLimit(limit, productive = false) {
  const configured = Math.max(0, Math.floor(Number(limit) || 0));
  if (productive && configured >= 4) return Math.max(configured, 8);
  if (configured <= 3) return configured;
  return configured - 1;
}

export function nextSourceSampleStats(stats = {}, outcome = {}) {
  const next = {
    attempted: Math.max(0, Number(stats?.attempted) || 0),
    nonPureFbs: Math.max(0, Number(stats?.nonPureFbs) || 0),
    favorited: Math.max(0, Number(stats?.favorited) || 0),
  };
  if (!["favorited", "rejected", "failed"].includes(String(outcome?.status || ""))) return next;
  next.attempted += 1;
  if (outcome.status === "favorited") next.favorited += 1;
  if (outcome.reason === "non-pure-fbs") next.nonPureFbs += 1;
  return next;
}

export function sourceSampleStatsFromEvents(events = []) {
  const stats = new Map();
  for (const event of events || []) {
    const key = sourceNonFbsSampleKey(event?.source_url);
    if (!key) continue;
    if (String(event?.status || "") === "favorited") {
      stats.set(key, { attempted: 0, nonPureFbs: 0, favorited: 0 });
      continue;
    }
    stats.set(key, nextSourceSampleStats(stats.get(key), event));
  }
  return stats;
}

export function favoritePriceSkipReason(productInfo, maxPrice = 1000) {
  const currency = String(productInfo?.price_info?.currency || "").toUpperCase();
  if (currency === "CNY" && Number(productInfo?.price_info?.sell_price) > Math.max(0, Number(maxPrice) || 0)) {
    return "source-price-above-limit";
  }
  return null;
}

export function favoriteTitleSkipReason(value) {
  const title = String(value || "");
  const prohibitedReason = prohibitedCategorySkipReason(title);
  if (prohibitedReason) return prohibitedReason;
  if (/зеркал|ванн(?:а|ы|ой|ую|е|у)|раковин|пианино|спортивн\w*\s+площад|турник.*брусь|(?:wall|bathroom)\s+mirror|bath\s*tub|digital\s+piano/i.test(title)) {
    return "oversized-low-yield-title";
  }
  return null;
}

export function effectiveFavoriteTotal({ claimedTotal, observedTotal, target }) {
  if (Number(claimedTotal) >= Number(target)) return Number(target);
  if (observedTotal === null || observedTotal === undefined || !Number.isFinite(Number(observedTotal))) {
    return Number(claimedTotal) || 0;
  }
  return Number(observedTotal);
}

export function favoriteModeSkipReason(mode) {
  if (!String(mode || "").trim()) return "missing-shipping-mode";
  return isPureFbs(mode) ? null : "non-pure-fbs";
}

export function listingModeSkipReason(cardText) {
  const mode = String(cardText || "")
    .match(/(?:^|\n)\s*发货模式\s*[：:]\s*([^\n]+)/i)?.[1]?.trim() || "";
  if (!mode || /^(?:暂无数据|--|-|unknown)$/i.test(mode)) return null;
  return isPureFbs(mode) ? null : "non-pure-fbs";
}

export function hasListingPluginFbsEvidence(cardText) {
  return /(?:^|\n)\s*发货模式\s*[：:]\s*FBS\s*(?:\n|$)/i.test(String(cardText || ""));
}

export function filterListingFbsEvidenceLinks(links, required = false) {
  if (!required) return [...(links || [])];
  return (links || []).filter((link) => (
    typeof link === "object" && hasListingPluginFbsEvidence(link?.card_text)
  ));
}

export function isOzonSoftBlock(value) {
  return /похоже, нет(?:\s|\u00a0)+соединения|выключите VPN|incident:\s*[a-z0-9_]+/i.test(String(value || ""));
}

export function ozonRetryDelay(attempt) {
  return [600_000, 900_000, 1_800_000][Math.min(2, Math.max(0, Number(attempt) || 0))];
}

export function softBlockCooldownState({ streak = 0, lastBlockedAt = 0, now = Date.now(), coalesceWindowMs = 30_000 } = {}) {
  const sameIncident = Number(lastBlockedAt) > 0 && Number(now) - Number(lastBlockedAt) <= Number(coalesceWindowMs);
  const nextStreak = sameIncident ? Math.max(1, Number(streak) || 0) : Math.max(1, Number(streak) + 1);
  return {
    streak: nextStreak,
    lastBlockedAt: Number(now),
    delay: ozonRetryDelay(nextStreak - 1),
  };
}

export function collectionDetailCooldownState(options = {}) {
  const state = softBlockCooldownState(options);
  return {
    ...state,
    delay: [60_000, 180_000, 600_000][Math.min(2, Math.max(0, state.streak - 1))],
  };
}

export function sourceBatchCooldownState(rows, state, now = Date.now()) {
  const batch = rows || [];
  const blockedCount = batch.filter((row) => row?.blocked || isOzonSoftBlock(`${row?.title || ""} ${row?.stop_reason || ""}`)).length;
  const blocked = blockedCount >= Math.floor(batch.length / 2) + 1;
  if (!blocked) {
    state.sourceSoftBlockStreak = 0;
    state.lastSourceSoftBlockAt = 0;
    return { blocked: false, delay: 0 };
  }
  const cooldown = softBlockCooldownState({
    streak: state.sourceSoftBlockStreak,
    lastBlockedAt: state.lastSourceSoftBlockAt,
    now,
  });
  cooldown.delay = [60_000, 180_000, 600_000][Math.min(2, Math.max(0, cooldown.streak - 1))];
  state.sourceSoftBlockStreak = cooldown.streak;
  state.lastSourceSoftBlockAt = cooldown.lastBlockedAt;
  state.detailBlockedUntil = Math.max(Number(state.detailBlockedUntil) || 0, Number(now) + cooldown.delay);
  return { blocked: true, delay: cooldown.delay };
}

export function ozonDetailFailurePolicy(error, attempt, retries) {
  const message = String(error?.message || error || "");
  const softBlocked = /Ozon detail (?:soft blocked|is blocked)|net::ERR_(?:FAILED|CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT).*ozon\.ru/i.test(message);
  return {
    softBlocked,
    retry: softBlocked && Number(attempt) < Number(retries),
    delay: softBlocked ? ozonRetryDelay(attempt) : 0,
  };
}

export function productTitleFamily(value) {
  const text = String(value || "");
  if (/для\s+(?:кош(?:ек|ки)?|собак(?:и)?|питомц)|домашн\w*\s+(?:животн|питомц)|pet\s+(?:hat|cap)/i.test(text)) return "pet";
  if (/водн\w*\s+(?:игров\w*\s+)?стол|стол\w*.*(?:игр\w*\s+)?с\s+вод|стол\w*.*водн/i.test(text)) return "bulky_kids";
  if (/(?:plants?\s*vs\.?\s*zombie|растени[яй]\s+против\s+зомби|зомби\s+против\s+растени|pvz).*(?:transform|трансформ)|(?:transform|трансформ).*(?:plants?\s*vs\.?\s*zombie|растени[яй]\s+против\s+зомби|pvz)/i.test(text)) return "pvz_transformer";
  if (/чехол|ремеш(?:ок|к)?/i.test(text)) return "case_strap";
  if (/человек[- ]?паук|spider[- ]?man|супергер|мстител|marvel/i.test(text)) return "superhero";
  if (/трус|нижн(?:ее|его|ем)?\s+бель|бюст|лифчик/i.test(text)) return "underwear";
  if (/сквиш|антистресс|squish/i.test(text)) return "squish";
  if (/мягк(?:ая|ие|ой)?\s+(?:плюшев|игруш)|плюшев|спрунк|sprunki/i.test(text)) return "plush";
  if (/аккумулятор|батаре[яй]|электроинструмент|power\s*tool/i.test(text)) return "electronics";
  if (/конструктор|building\s*blocks?|блочн(?:ая|ый)|moc\b/i.test(text)) return "building";
  if (/носк/i.test(text)) return "socks";
  if (/фигурк|funko|статуэт/i.test(text)) return "figure";
  if (/браслет|кулон|колье|подвеск|брош|pandora/i.test(text)) return "jewelry";
  if (/шляп|панам|кепк|козыр|докер|косынк|головн.*убор/i.test(text)) return "headwear";
  if (/перчат|заколк|резинк|брелок|наклейк|ободок|ключниц/i.test(text)) return "accessory";
  if (/кукл|игруш/i.test(text)) return "toy";
  return "other";
}

export function productTitlePriority(value) {
  return {
    socks: -1000,
    underwear: -1000,
    squish: 625,
    headwear: -1000,
    building: 525,
    other: 400,
    plush: 350,
    case_strap: 340,
    figure: 325,
    accessory: 300,
    toy: 250,
    electronics: 100,
    bulky_kids: 75,
    pet: 50,
    superhero: 0,
    pvz_transformer: 0,
    jewelry: 0,
  }[productTitleFamily(value)] ?? 0;
}

export function observedTitleFamilyScores(rows, recentLimit = 500) {
  const latest = new Map();
  for (let index = (rows || []).length - 1; index >= 0 && latest.size < Math.max(1, Number(recentLimit) || 500); index -= 1) {
    const row = rows[index] || {};
    const sku = String(row.sku || "").trim();
    if (!sku || latest.has(sku)) continue;
    latest.set(sku, row);
  }
  const totals = new Map();
  for (const row of latest.values()) {
    const family = String(row.title_family || productTitleFamily(row.title || ""));
    const value = totals.get(family) || { attempted: 0, published: 0 };
    if (!["ignored", "favorited"].includes(String(row.status || ""))) value.attempted += 1;
    if (row.status === "published") value.published += 1;
    totals.set(family, value);
  }
  return Object.fromEntries([...totals].map(([family, value]) => {
    if (!(value.published > 0)) return [family, 0];
    const conversion = value.published / Math.max(1, value.attempted);
    return [family, Math.min(1200, value.published * 300 + conversion * 700)];
  }));
}

export function createScannerLogger(log = console.log, level = "summary") {
  if (String(level).toLowerCase() === "verbose") return log;
  return (message) => {
    const text = String(message || "").split(/\r?\n/, 1)[0].slice(0, 300);
    if (/^favorite collection summary attempted=0 favorited=0 rejected=0 failed=0$/iu.test(text)) return;
    if (/^(?:favorite count telemetry unavailable|favorite SKU telemetry unavailable|Ozon detail pacing interval=|source soft block cooldown|yielding source tranche|favorite collection summary|favorite capacity reached)/i.test(text)) log(text);
  };
}

function favoriteLinkPriority(link, familyScores = {}) {
  const provenSeller = isProvenSellerSource(link?.source_url);
  const cardText = String(link?.card_text || "");
  const pluginPureFbs = hasListingPluginFbsEvidence(cardText);
  const explicitGlobal = /доставка\s+из\s+(?:китая|за\s+рубежа)|cross.?border|ozon\s+global/i.test(cardText);
  const cardPriceMatch = cardText.match(/(\d+(?:[.,]\d+)?)\s*¥/);
  const cardPrice = Number(String(cardPriceMatch?.[1] || "").replace(",", "."));
  const pricePriority = Number.isFinite(cardPrice) && cardPrice > 0
    ? (cardPrice < 15 ? -700 : cardPrice < 20 ? -400 : cardPrice >= 25 ? 75 : 0)
    : 0;
  const observedPriority = Number(familyScores[productTitleFamily(link?.text)] || 0);
  return (pluginPureFbs ? 2000 : 0) + (provenSeller ? 1000 : 0) + (explicitGlobal ? 800 : 0)
    + observedPriority + productTitlePriority(link?.text) + pricePriority;
}

export function isProvenSellerSource(value) {
  return /\/seller\/(?:nuanniu|miaowu|yishao|alisa-3673390|vash-vybor-3332584|xiangyu01|kshunby|xzx-a02|fabrika-ulichnogo-stilya|linkworld-2709304|dretd)(?:[/?]|$)/i.test(String(value || ""));
}

function isExplicitChinaCollectionSource(value) {
  return /\/highlight\/tovary-iz-kitaya-[^/?]+/i.test(String(value || ""));
}

function sourceUrlPriority(value) {
  const raw = String(value || "");
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch {}
  const proven = isProvenSellerSource(raw) ? 1000 : 0;
  const global = /(?:ozon-global|tovary-iz-kitaya|tovary-so-vsego-mira|is_global=true)/i.test(decoded) ? 500 : 0;
  const explicitChinaCollection = isExplicitChinaCollectionSource(decoded) ? 400 : 0;
  const targetFamily = /(?:детск|detsk|ребен|odezhd|aksess|accessor|одежд|обув|трус|кепк|панам|носк|заколк|брелок|ремешок|бижутер)/i.test(decoded) ? 250 : 0;
  return proven + global + explicitChinaCollection + targetFamily;
}

function observedSearchFamilyPriority(value, familyScores = {}) {
  try {
    const query = new URL(String(value || "")).searchParams.get("text");
    if (!query) return 0;
    return Number(familyScores[productTitleFamily(query)] || 0) * 100;
  } catch {
    return 0;
  }
}

function sourceUrlKey(value) {
  try {
    const url = new URL(String(value));
    url.searchParams.delete("sorting");
    url.searchParams.delete("currency_price");
    url.searchParams.delete("page");
    return url.toString();
  } catch {
    return String(value || "")
      .replace(/([?&])(?:sorting|currency_price|page)=[^&]*&?/gi, "$1")
      .replace(/[?&]$/, "");
  }
}

function exactSourceUrlKey(value) {
  try {
    const url = new URL(String(value));
    url.hash = "";
    url.searchParams.sort();
    return url.toString();
  } catch {
    return String(value || "");
  }
}

export function filterSourceUrlsByAllowlist(urls = [], allowlistUrls = [], { match = "family" } = {}) {
  if (!allowlistUrls.length) return [...urls];
  const key = match === "exact" ? exactSourceUrlKey : sourceUrlKey;
  const allowedKeys = new Set(allowlistUrls.map(key).filter(Boolean));
  const seen = new Set();
  return urls.filter((url) => {
    if (!allowedKeys.has(key(url))) return false;
    const exactKey = exactSourceUrlKey(url);
    if (seen.has(exactKey)) return false;
    seen.add(exactKey);
    return true;
  });
}

export function filterSourceRowsByAllowlist(rows = [], allowlistUrls = [], options = {}) {
  if (!allowlistUrls.length) return [...rows];
  const seen = new Set();
  return rows.filter((row) => {
    if (!filterSourceUrlsByAllowlist([row?.source_url], allowlistUrls, options).length) return false;
    const exactKey = exactSourceUrlKey(row?.source_url);
    if (seen.has(exactKey)) return false;
    seen.add(exactKey);
    return true;
  });
}

function isSearchSource(value) {
  try {
    return /^\/search\/?$/i.test(new URL(String(value || "")).pathname);
  } catch {
    return false;
  }
}

function isHighlightSource(value) {
  try {
    return /^\/highlight\//i.test(new URL(String(value || "")).pathname);
  } catch {
    return false;
  }
}

function isPriceBandedSource(value) {
  return isSearchSource(value) || isHighlightSource(value);
}

export function sourceYieldKey(value) {
  try {
    const url = new URL(String(value));
    url.searchParams.delete("sorting");
    url.searchParams.delete("page");
    return url.toString();
  } catch {
    return String(value || "")
      .replace(/([?&])(?:sorting|page)=[^&]*&?/gi, "$1")
      .replace(/[?&]$/, "");
  }
}

export function sourceCollectionBlockKey(value) {
  return value ? sourceYieldKey(value) : null;
}

export function sourceNonFbsSampleKey(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    url.hash = "";
    if (/^\/search\/?$/i.test(url.pathname)) {
      url.searchParams.delete("page");
      url.searchParams.delete("sorting");
      url.searchParams.sort();
    }
    return url.toString();
  } catch {
    return String(value);
  }
}

export function deduplicateSearchSourceVariants(urls = []) {
  const seenSearchFamilies = new Set();
  return (urls || []).filter((value) => {
    if (!isSearchSource(value)) return true;
    const key = sourceNonFbsSampleKey(value);
    if (!key || seenSearchFamilies.has(key)) return false;
    seenSearchFamilies.add(key);
    return true;
  });
}

export function sourceDispatchFamilyKey(value, { match = "family" } = {}) {
  return match === "exact" ? exactSourceUrlKey(value) : sourceYieldKey(value);
}

export function deduplicateSourceDispatchFamilies(urls = [], options = {}) {
  const seen = new Set();
  return (urls || []).filter((value) => {
    const key = sourceDispatchFamilyKey(value, options);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function excludeCompletedSourceFamilies(urls = [], completedUrls = [], options = {}) {
  const completedFamilies = new Set(
    [...(completedUrls || [])].map((value) => sourceDispatchFamilyKey(value, options)).filter(Boolean),
  );
  return (urls || []).filter((value) => !completedFamilies.has(sourceDispatchFamilyKey(value, options)));
}

function sourceEvidenceKey(value, { keepSorting = false } = {}) {
  try {
    const url = new URL(String(value));
    url.searchParams.delete("page");
    if (!keepSorting) url.searchParams.delete("sorting");
    return url.toString();
  } catch {
    return String(value || "");
  }
}

export function filterProductiveSourceVariants(urls, yieldRows = []) {
  const publishedBands = new Set((yieldRows || [])
    .filter((row) => row?.status === "published")
    .map((row) => sourceEvidenceKey(row?.source_url))
    .filter(Boolean));
  const publishedStrategies = new Set((yieldRows || [])
    .filter((row) => row?.status === "published")
    .map((row) => sourceEvidenceKey(row?.source_url, { keepSorting: true }))
    .filter(Boolean));
  return (urls || []).filter((value) => {
    let parsed;
    try { parsed = new URL(String(value)); } catch { return true; }
    if (parsed.searchParams.get("sorting") === "price"
      && !publishedStrategies.has(sourceEvidenceKey(value, { keepSorting: true }))) return false;
    const band = parsed.searchParams.get("currency_price");
    if (!["50.000;", "120.000;"].includes(band)) return true;
    return publishedBands.has(sourceEvidenceKey(value));
  });
}

export function expandPublishedSourcePages(urls, yieldRows = [], resultPages = []) {
  const expanded = [...(urls || [])];
  const seen = new Set(expanded);
  const pages = [...new Set((resultPages || []).map(Number)
    .filter((value) => Number.isInteger(value) && value > 1))];
  const published = [...new Set((yieldRows || [])
    .filter((row) => row?.status === "published" && /^https?:\/\//i.test(String(row?.source_url || "")))
    .map((row) => String(row.source_url)))];
  for (const source of published) {
    if (!seen.has(source)) {
      seen.add(source);
      expanded.push(source);
    }
    for (const page of pages) {
      let url;
      try { url = new URL(source); } catch { continue; }
      url.searchParams.set("page", String(page));
      const value = url.toString();
      if (seen.has(value)) continue;
      seen.add(value);
      expanded.push(value);
    }
  }
  return expanded;
}

export function expandNextPublishedDiscoveryPages(yieldRows = []) {
  const maximumEvidencePage = 8;
  const expanded = [];
  const seen = new Set();
  for (const row of yieldRows || []) {
    if (String(row?.status || "") !== "published") continue;
    let url;
    try { url = new URL(String(row?.source_url || "")); } catch { continue; }
    if (!isSearchSource(url) && !isHighlightSource(url)) continue;
    const currentPage = Number(url.searchParams.get("page") || 1);
    if (!Number.isInteger(currentPage) || currentPage < 1 || currentPage >= maximumEvidencePage) continue;
    url.hash = "";
    url.searchParams.delete("miniapp");
    url.searchParams.set("page", String(currentPage + 1));
    const value = url.toString();
    if (seen.has(value)) continue;
    seen.add(value);
    expanded.push(value);
  }
  return expanded;
}

export function expandRepeatedPublishedDiscoveryPageFour(yieldRows = [], minimumPublishedSkus = 2) {
  const minimum = Math.max(2, Number(minimumPublishedSkus) || 2);
  const publishedSkusByBand = new Map();
  for (const row of yieldRows || []) {
    if (String(row?.status || "") !== "published") continue;
    const sku = String(row?.sku || "").trim();
    let url;
    try { url = new URL(String(row?.source_url || "")); } catch { continue; }
    if (!sku || (!isSearchSource(url) && !isHighlightSource(url))) continue;
    url.searchParams.delete("miniapp");
    const key = sourceYieldKey(url);
    const skus = publishedSkusByBand.get(key) || new Set();
    skus.add(sku);
    publishedSkusByBand.set(key, skus);
  }
  const expanded = [];
  const seen = new Set();
  for (const row of yieldRows || []) {
    if (String(row?.status || "") !== "published") continue;
    let url;
    try { url = new URL(String(row?.source_url || "")); } catch { continue; }
    if (!isSearchSource(url) && !isHighlightSource(url)) continue;
    url.hash = "";
    url.searchParams.delete("miniapp");
    if ((publishedSkusByBand.get(sourceYieldKey(url))?.size || 0) < minimum) continue;
    url.searchParams.set("page", "4");
    const canonicalKey = `${url.origin}${url.pathname}?${[...url.searchParams.entries()]
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
      .map(([key, value]) => `${key}=${value}`).join("&")}`;
    if (seen.has(canonicalKey)) continue;
    seen.add(canonicalKey);
    expanded.push(url.toString());
  }
  return expanded;
}

export function expandHighYieldSourceUrls(urls, yieldRows = []) {
  const expanded = [...urls];
  const seen = new Set(expanded);
  const successful = [...new Set(yieldRows
    .filter((row) => row?.status === "published" && /^https?:\/\//i.test(String(row?.source_url || "")))
    .map((row) => String(row.source_url)))];
  for (const source of successful) {
    let parsed;
    try { parsed = new URL(source); } catch { continue; }
    const existingBand = parsed.searchParams.get("currency_price");
    const bands = [...new Set(["500.000;", "150.000;", "1000.000;", existingBand].filter(Boolean))];
    for (const band of bands) {
      for (const sorting of [null, "rating", "discount"]) {
        const url = new URL(source);
        url.searchParams.set("currency_price", band);
        if (sorting) url.searchParams.set("sorting", sorting);
        else url.searchParams.delete("sorting");
        const value = url.toString();
        if (seen.has(value)) continue;
        seen.add(value);
        expanded.push(value);
      }
    }
  }
  return expanded;
}

export function classifyFreshSourceUrls(urls = []) {
  const verifiedSellerUrls = [];
  const explorationUrls = [];
  for (const url of urls) {
    if (canonicalSellerUrl(url)) verifiedSellerUrls.push(url);
    else explorationUrls.push(url);
  }
  return { verifiedSellerUrls, explorationUrls };
}

export function expandFreshSellerSourceUrls(urls = []) {
  const expanded = [...urls];
  const seen = new Set(expanded);
  for (const source of urls) {
    if (!canonicalSellerUrl(source)) continue;
    for (const band of ["500.000;", "150.000;", "1000.000;"]) {
      for (const sorting of ["rating", "discount"]) {
        const url = new URL(source);
        url.searchParams.set("currency_price", band);
        url.searchParams.set("sorting", sorting);
        const value = url.toString();
        if (seen.has(value)) continue;
        seen.add(value);
        expanded.push(value);
      }
    }
  }
  return expanded;
}

export function deriveSearchSourceUrls(yieldRows, limit = 200, priceBands = ["150.000;"], resultPages = [1]) {
  const stopWords = new Set([
    "для", "или", "при", "это", "этот", "эта", "эти", "шт", "штук", "цвет", "размер",
    "женский", "женская", "женские", "мужской", "мужская", "детский", "детская", "детские",
  ]);
  const queries = [];
  const seen = new Set();
  const queryGroups = [];
  const bands = [...new Set((priceBands || []).map((value) => String(value || "").trim()).filter(Boolean))];
  const pages = [...new Set((resultPages || []).map(Number).filter((value) => Number.isInteger(value) && value > 0))];
  const maximum = Math.max(0, Number(limit) || 0);
  if (maximum === 0 || bands.length === 0 || pages.length === 0) return queries;
  const isGenericQueryWord = (word) => /^(?:набор[а-яё]*|детск[а-яё]*|девоч[а-яё]*|мальчик[а-яё]*|женск[а-яё]*|мужск[а-яё]*)$/i.test(String(word || ""));
  const isLowInformationQuery = (candidate) => {
    const concreteCount = candidate.filter((word) => !isGenericQueryWord(word)).length;
    return concreteCount === 0 || (candidate.length >= 3 && concreteCount < 2);
  };
  const queryGroupForRow = (row) => {
    const words = String(row?.title || "").toLowerCase().match(/[а-яё]{4,}/gi) || [];
    const terms = words.filter((word) => !stopWords.has(word)).slice(0, 6);
    if (terms.length < 2) return null;
    let observedQuery = null;
    try {
      const queryWords = String(new URL(String(row?.source_url || "")).searchParams.get("text") || "")
        .toLowerCase().match(/[а-яё]{4,}/gi) || [];
      const queryTerms = queryWords.filter((word) => !stopWords.has(word)).slice(0, 5);
      if (queryTerms.length >= 2) observedQuery = queryTerms.join(" ");
    } catch {}
    const concreteTerms = terms.filter((word) => !isGenericQueryWord(word));
    const observedTerms = observedQuery ? observedQuery.split(" ") : null;
    const replaceGenericObservedQuery = observedTerms?.length >= 2 && isLowInformationQuery(observedTerms);
    const candidates = [
      replaceGenericObservedQuery ? concreteTerms.slice(0, 3) : null,
      observedTerms,
      terms.slice(0, 3),
      terms.slice(0, 2),
      terms.slice(1, 3),
      terms.slice(0, 4),
      terms.slice(1, 4),
      replaceGenericObservedQuery ? null : concreteTerms.slice(0, 3),
    ].filter((candidate) => candidate?.length >= 2 && !isLowInformationQuery(candidate))
      .map((candidate) => candidate.join(" "));
    return candidates.length > 0 ? [...new Set(candidates)] : null;
  };
  const submittedSkusBySource = new Map();
  for (const row of yieldRows || []) {
    if (row?.status !== "submitted") continue;
    const key = sourceYieldKey(row?.source_url);
    const sku = String(row?.sku || "").trim();
    if (!key || !sku) continue;
    const skus = submittedSkusBySource.get(key) || new Set();
    skus.add(sku);
    submittedSkusBySource.set(key, skus);
  }
  const repeatedSubmittedSources = new Set([...submittedSkusBySource]
    .filter(([, skus]) => skus.size >= 2)
    .map(([key]) => key));
  const publishedGroups = [];
  const submittedGroups = [];
  const sourceScores = fullFunnelSourceScores(yieldRows);
  const scoredRows = [...(yieldRows || [])]
    .map((row, order) => ({
      row,
      order,
      time: Date.parse(row?.at || row?.timestamp || "") || 0,
      sourceScore: Number(sourceScores.get(sourceYieldKey(row?.source_url)) || 0),
    }));
  const recencyOrderedRows = [...scoredRows]
    .sort((left, right) => right.sourceScore - left.sourceScore
      || right.time - left.time
      || right.order - left.order)
    .map(({ row }) => row);
  const newestOrderedRows = [...scoredRows]
    .sort((left, right) => right.time - left.time || right.order - left.order)
    .map(({ row }) => row);
  const seenEvidence = new Set();
  const seenPublishedGroups = new Set();
  const seenSubmittedGroups = new Set();
  for (const row of recencyOrderedRows) {
    const group = queryGroupForRow(row);
    if (!group) continue;
    const status = String(row?.status || "");
    const evidenceId = String(row?.sku || "").trim()
      || String(row?.title || "").trim().toLowerCase();
    const evidenceKey = `${status}\0${evidenceId}`;
    if (!evidenceId || seenEvidence.has(evidenceKey)) continue;
    if (status === "published") {
      seenEvidence.add(evidenceKey);
      const groupKey = group.join("\0");
      if (!seenPublishedGroups.has(groupKey)) {
        seenPublishedGroups.add(groupKey);
        publishedGroups.push(group);
      }
    } else if (status === "submitted" && repeatedSubmittedSources.has(sourceYieldKey(row?.source_url))) {
      seenEvidence.add(evidenceKey);
      const groupKey = group.join("\0");
      if (!seenSubmittedGroups.has(groupKey)) {
        seenSubmittedGroups.add(groupKey);
        submittedGroups.push(group);
      }
    }
  }
  const newestPublishedGroups = [];
  const newestGroupKeys = new Set();
  for (const row of newestOrderedRows) {
    if (String(row?.status || "") !== "published") continue;
    const sourceScore = Number(sourceScores.get(sourceYieldKey(row?.source_url)) || 0);
    if (sourceScore < 0) continue;
    const group = queryGroupForRow(row);
    if (!group) continue;
    const groupKey = group.join("\0");
    if (newestGroupKeys.has(groupKey)) continue;
    newestGroupKeys.add(groupKey);
    newestPublishedGroups.push(group);
  }
  const recentGroupLimit = Math.max(2, Math.ceil(maximum / (bands.length * pages.length * 2)));
  const leadingSubmittedLimit = Math.max(1, Math.floor(recentGroupLimit / 4));
  let submittedSlots = Math.min(submittedGroups.length, leadingSubmittedLimit);
  let publishedSlots = Math.min(publishedGroups.length, recentGroupLimit - submittedSlots);
  let remainingSlots = recentGroupLimit - publishedSlots - submittedSlots;
  const extraPublished = Math.min(remainingSlots, publishedGroups.length - publishedSlots);
  publishedSlots += extraPublished;
  remainingSlots -= extraPublished;
  submittedSlots += Math.min(remainingSlots, submittedGroups.length - submittedSlots);
  const selectedPublishedGroups = [];
  const selectedPublishedKeys = new Set();
  const addPublishedGroups = (groups, count) => {
    let added = 0;
    for (const group of groups) {
      if (added >= count || selectedPublishedGroups.length >= publishedSlots) break;
      const key = group.join("\0");
      if (selectedPublishedKeys.has(key)) continue;
      selectedPublishedKeys.add(key);
      selectedPublishedGroups.push(group);
      added += 1;
    }
  };
  const newestReserve = publishedSlots >= 2 ? Math.max(1, Math.floor(publishedSlots / 4)) : 0;
  if (newestReserve > 0) {
    addPublishedGroups(publishedGroups, 1);
    addPublishedGroups(newestPublishedGroups, newestReserve);
  }
  addPublishedGroups(publishedGroups, publishedSlots);
  queryGroups.push(...selectedPublishedGroups, ...submittedGroups.slice(0, submittedSlots));
  const rounds = Math.max(0, ...queryGroups.map((group) => group.length));
  for (let round = 0; round < rounds; round += 1) {
    for (const group of queryGroups) {
      const query = group[round];
      if (!query) continue;
      for (const band of bands) {
        for (const page of pages) {
          const key = `${query}\0${band}\0${page}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const url = new URL("https://www.ozon.ru/search/");
          url.searchParams.set("text", query);
          url.searchParams.set("is_global", "true");
          url.searchParams.set("currency_price", band);
          if (page > 1) url.searchParams.set("page", String(page));
          queries.push(url.toString());
          if (queries.length >= maximum) return queries;
        }
      }
    }
  }
  return queries;
}

function canonicalSellerUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const match = url.pathname.match(/^(\/seller\/[^/]+\/)/i);
    return match ? `${url.origin}${match[1]}` : null;
  } catch {
    return null;
  }
}

export function verifiedSellerSourceUrls(yieldRows, minimumPublishedSkus = 2) {
  const minimum = Math.max(1, Number(minimumPublishedSkus) || 2);
  const observedSellerBySku = new Map();
  for (const row of yieldRows || []) {
    const sku = String(row?.sku || "").trim();
    const url = canonicalSellerUrl(row?.seller_url);
    if (sku && url) observedSellerBySku.set(sku, url);
  }
  const sellers = new Map();
  for (const row of yieldRows || []) {
    if (String(row?.status || "") !== "published") continue;
    const sku = String(row?.sku || "").trim();
    const url = canonicalSellerUrl(row?.seller_url)
      || canonicalSellerUrl(row?.source_url)
      || observedSellerBySku.get(sku);
    if (!url || !sku) continue;
    const skus = sellers.get(url) || new Set();
    skus.add(sku);
    sellers.set(url, skus);
  }
  return [...sellers].filter(([, skus]) => skus.size >= minimum).map(([url]) => url);
}

export function pureFbsSellerSourceUrls(yieldRows, minimumFavoritedSkus = 2, limit = 50) {
  const minimum = Math.max(2, Number(minimumFavoritedSkus) || 2);
  const maximum = Math.max(0, Number(limit) || 0);
  if (maximum === 0) return [];
  const sellers = new Map();
  (yieldRows || []).forEach((row, order) => {
    if (String(row?.status || "") !== "favorited") return;
    const seller = canonicalSellerUrl(row?.seller_url) || canonicalSellerUrl(row?.source_url);
    const sku = String(row?.sku || "").trim();
    if (!seller || !sku) return;
    const value = sellers.get(seller) || { skus: new Set(), time: 0, order: -1 };
    value.skus.add(sku);
    value.time = Math.max(value.time, Date.parse(row?.at || row?.timestamp || "") || 0);
    value.order = Math.max(value.order, order);
    sellers.set(seller, value);
  });
  return [...sellers]
    .filter(([, value]) => value.skus.size >= minimum)
    .sort(([, left], [, right]) => right.time - left.time || right.order - left.order)
    .slice(0, maximum)
    .map(([seller]) => seller);
}

export function pureFbsSellerSourceVariants(yieldRows, minimumFavoritedSkus = 2, limit = 50) {
  const firstPages = expandFreshSellerSourceUrls(
    pureFbsSellerSourceUrls(yieldRows, minimumFavoritedSkus, limit),
  );
  const expanded = [...firstPages];
  for (const source of firstPages) {
    for (const page of [2, 3]) {
      const url = new URL(source);
      url.searchParams.set("page", String(page));
      expanded.push(url.toString());
    }
  }
  return [...new Set(expanded)];
}

export function repeatedSubmittedSellerSourceUrls(yieldRows, minimumSubmittedSkus = 2, limit = 50) {
  const minimum = Math.max(2, Number(minimumSubmittedSkus) || 2);
  const maximum = Math.max(0, Number(limit) || 0);
  if (maximum === 0) return [];
  const observedSellerBySku = new Map();
  for (const row of yieldRows || []) {
    const sku = String(row?.sku || "").trim();
    const url = canonicalSellerUrl(row?.seller_url);
    if (sku && url) observedSellerBySku.set(sku, url);
  }
  const sellers = new Map();
  for (const row of [...(yieldRows || [])].reverse()) {
    if (String(row?.status || "") !== "submitted") continue;
    const sku = String(row?.sku || "").trim();
    const url = canonicalSellerUrl(row?.seller_url)
      || canonicalSellerUrl(row?.source_url)
      || observedSellerBySku.get(sku);
    if (!url || !sku) continue;
    const skus = sellers.get(url) || new Set();
    skus.add(sku);
    sellers.set(url, skus);
  }
  return [...sellers]
    .filter(([, skus]) => skus.size >= minimum)
    .slice(0, maximum)
    .map(([url]) => url);
}

export function repeatedSubmittedSellerSourceVariants(yieldRows, minimumSubmittedSkus = 2, limit = 50) {
  const firstPages = expandFreshSellerSourceUrls(
    repeatedSubmittedSellerSourceUrls(yieldRows, minimumSubmittedSkus, limit),
  );
  const expanded = [...firstPages];
  for (const source of firstPages) {
    for (const page of [2, 3]) {
      const url = new URL(source);
      url.searchParams.set("page", String(page));
      expanded.push(url.toString());
    }
  }
  return [...new Set(expanded)];
}

export function deepVerifiedSellerSourceVariants(
  yieldRows,
  minimumPublishedSkus = 2,
  limit = 50,
  resultPages = [2, 3, 4, 5, 6, 7, 8, 9, 10],
) {
  const maximum = Math.max(0, Number(limit) || 0);
  if (maximum === 0) return [];
  const verified = new Set(verifiedSellerSourceUrls(yieldRows, minimumPublishedSkus));
  const recentVerified = [];
  const seen = new Set();
  for (const row of [...(yieldRows || [])].reverse()) {
    if (String(row?.status || "") !== "published") continue;
    const seller = canonicalSellerUrl(row?.seller_url) || canonicalSellerUrl(row?.source_url);
    if (!seller || !verified.has(seller) || seen.has(seller)) continue;
    seen.add(seller);
    recentVerified.push(seller);
    if (recentVerified.length >= maximum) break;
  }
  const deepestPublishedPage = new Map();
  for (const row of yieldRows || []) {
    if (String(row?.status || "") !== "published") continue;
    const seller = canonicalSellerUrl(row?.seller_url) || canonicalSellerUrl(row?.source_url);
    if (!seller) continue;
    let page = 1;
    try { page = Number(new URL(String(row?.source_url || "")).searchParams.get("page")) || 1; }
    catch {}
    deepestPublishedPage.set(seller, Math.max(deepestPublishedPage.get(seller) || 1, page));
  }
  const firstPages = expandFreshSellerSourceUrls(recentVerified);
  const expanded = [...firstPages];
  const pages = [...new Set((resultPages || []).map(Number)
    .filter((page) => Number.isInteger(page) && page > 1 && page <= 10))];
  for (const source of firstPages) {
    for (const page of pages) {
      const seller = canonicalSellerUrl(source);
      const maximumPage = Math.min(10, Math.max(3, (deepestPublishedPage.get(seller) || 1) + 1));
      if (page > maximumPage) continue;
      const url = new URL(source);
      const priceBand = url.searchParams.get("currency_price");
      if (page >= 4 && priceBand && priceBand !== "500.000;") continue;
      url.searchParams.set("page", String(page));
      expanded.push(url.toString());
    }
  }
  return [...new Set(expanded)];
}

export function verifiedPrioritySourceUrls({
  verifiedFreshUrls = [],
  verifiedHistoricalUrls = [],
  derivedSearchUrls = [],
  prioritizeDerived = false,
  derivedPriorityLimit = Number.POSITIVE_INFINITY,
} = {}) {
  const maximumDerived = Number.isFinite(Number(derivedPriorityLimit))
    ? Math.max(0, Math.floor(Number(derivedPriorityLimit)))
    : derivedSearchUrls.length;
  return [...new Set([
    ...verifiedFreshUrls,
    ...verifiedHistoricalUrls,
    ...(prioritizeDerived ? derivedSearchUrls.slice(0, maximumDerived) : []),
  ])];
}

export function qualifiedPrioritySourceUrls({
  submittedSellerUrls = [],
  derivedSearchUrls = [],
  prioritizeDerived = false,
  derivedPriorityLimit = Number.POSITIVE_INFINITY,
} = {}) {
  const maximumDerived = Number.isFinite(Number(derivedPriorityLimit))
    ? Math.max(0, Math.floor(Number(derivedPriorityLimit)))
    : derivedSearchUrls.length;
  return [...new Set([
    ...submittedSellerUrls,
    ...(prioritizeDerived ? derivedSearchUrls.slice(0, maximumDerived) : []),
  ])];
}

function latestSourceSkuOutcomes(rows, acceptedStatuses) {
  const sources = new Map();
  (rows || []).forEach((row, order) => {
    const key = sourceYieldKey(row?.source_url);
    const status = String(row?.status || "");
    if (!key || !acceptedStatuses.has(status)) return;
    const sku = String(row?.sku || "").trim() || `__event:${order}`;
    const outcomes = sources.get(key) || new Map();
    const previous = outcomes.get(sku);
    const time = Date.parse(row?.at || row?.timestamp || "") || 0;
    if (!previous || time > previous.time || (time === previous.time && order > previous.order)) {
      outcomes.set(sku, { row, status, time, order });
    }
    sources.set(key, outcomes);
  });
  return sources;
}

export function fullFunnelSourceScores(rows) {
  const outcomeRank = { favorited: 1, rejected: 2, skipped: 2, submitted: 3, published: 4 };
  const sources = latestSourceSkuOutcomes(rows, new Set(Object.keys(outcomeRank)));
  const scoreOutcomes = (key, values) => {
    const attempted = values.length;
    const published = values.filter(({ status }) => status === "published").length;
    const submitted = values.filter(({ status }) => status === "submitted").length;
    const pureFbs = values.filter(({ status }) => status === "favorited").length;
    const qualifiedYield = published + submitted * 0.65 + pureFbs * 0.35;
    const targetYield = isPriceBandedSource(key) ? 0.2 : 0.1;
    return ((qualifiedYield - attempted * targetYield) / (attempted + 5)) * 100_000
      + Math.log1p(published) * 1000
      + Math.log1p(submitted) * 500
      + Math.log1p(pureFbs) * 100;
  };
  return new Map([...sources].map(([key, outcomes]) => {
    const values = [...outcomes.values()];
    const lifetimeScore = scoreOutcomes(key, values);
    const recent = [...values]
      .sort((left, right) => right.time - left.time || right.order - left.order)
      .slice(0, 6);
    const recentScore = recent.length >= 4 ? scoreOutcomes(key, recent) : Number.NEGATIVE_INFINITY;
    return [key, Math.max(lifetimeScore, recentScore)];
  }));
}

export function interleaveStrictSuccessExploration(urls, yieldRows, exploitBurst = 6) {
  const ordered = [...new Set((urls || []).filter(Boolean))];
  const burst = Math.floor(Number(exploitBurst) || 0);
  if (burst <= 0 || ordered.length < 2) return ordered;
  const strictKeys = new Set((yieldRows || [])
    .filter((row) => String(row?.status || "") === "published" && String(row?.sku || "").trim())
    .map((row) => sourceYieldKey(row?.source_url))
    .filter(Boolean));
  const exploit = ordered.filter((url) => strictKeys.has(sourceYieldKey(url)));
  const explore = ordered.filter((url) => !strictKeys.has(sourceYieldKey(url)));
  if (!exploit.length || !explore.length) return ordered;
  const result = [];
  let exploitIndex = 0;
  let exploreIndex = 0;
  while (exploitIndex < exploit.length || exploreIndex < explore.length) {
    for (let offset = 0; offset < burst && exploitIndex < exploit.length; offset += 1) {
      result.push(exploit[exploitIndex++]);
    }
    if (exploreIndex < explore.length) result.push(explore[exploreIndex++]);
  }
  return result;
}

function sourcePortfolioKeys(row) {
  return [...new Set([
    sourceYieldKey(row?.source_url),
    canonicalSellerUrl(row?.source_url),
    canonicalSellerUrl(row?.seller_url),
  ].filter(Boolean))];
}

function sourcePortfolioIndex(rows = []) {
  const collectionByKey = new Map();
  const strictSkusByKey = new Map();
  (rows || []).forEach((row, order) => {
    const sku = String(row?.sku || "").trim();
    const status = String(row?.status || "");
    if (!sku) return;
    for (const key of sourcePortfolioKeys(row)) {
      if (status === "published") {
        const strictSkus = strictSkusByKey.get(key) || new Set();
        strictSkus.add(sku);
        strictSkusByKey.set(key, strictSkus);
      }
      if (!["favorited", "rejected", "failed"].includes(status)) continue;
      const collection = collectionByKey.get(key) || new Map();
      const time = Date.parse(row?.at || row?.timestamp || "") || 0;
      const previous = collection.get(sku);
      if (!previous || time > previous.time || (time === previous.time && order > previous.order)) {
        collection.set(sku, { status, time, order });
      }
      collectionByKey.set(key, collection);
    }
  });
  return { collectionByKey, strictSkusByKey };
}

function sourcePortfolioTierFromIndex(url, index, exhaustedScanFamilies = new Set()) {
  const key = canonicalSellerUrl(url) || sourceYieldKey(url);
  const scanFamilyKey = isPriceBandedSource(url) ? sourceYieldKey(url) : sourceUrlKey(url);
  if (exhaustedScanFamilies.has(scanFamilyKey)) return "explore";
  if ((index.strictSkusByKey.get(key)?.size || 0) > 0) return "strict";
  const collection = index.collectionByKey.get(key) || new Map();
  const attempted = collection.size;
  const pureFbs = [...collection.values()].filter((event) => event.status === "favorited").length;
  if (canonicalSellerUrl(url) && pureFbs >= 2) return "fbs";
  if (attempted >= 4 && pureFbs >= 2 && pureFbs / attempted >= 0.3) return "fbs";
  return "explore";
}

export function sourcePortfolioTier(url, rows = [], { scanRows = [] } = {}) {
  return sourcePortfolioTierFromIndex(
    url,
    sourcePortfolioIndex(rows),
    exhaustedScanFamilyKeys(scanRows),
  );
}

export function sourcePortfolioTiers(urls, rows = [], { scanRows = [] } = {}) {
  const index = sourcePortfolioIndex(rows);
  const exhaustedScanFamilies = exhaustedScanFamilyKeys(scanRows);
  return new Map([...new Set((urls || []).filter(Boolean))]
    .map((url) => [
      url,
      sourcePortfolioTierFromIndex(url, index, exhaustedScanFamilies),
    ]));
}

export function interleaveSourcePortfolio(urls, yieldRows = [], {
  strictWeight = 7,
  fbsWeight = 2,
  exploreWeight = 1,
  scanRows = [],
} = {}) {
  const queues = { strict: [], fbs: [], explore: [] };
  for (const [url, tier] of sourcePortfolioTiers(urls, yieldRows, { scanRows })) {
    queues[tier].push(url);
  }
  const weights = {
    strict: Math.max(0, Math.floor(Number(strictWeight) || 0)),
    fbs: Math.max(0, Math.floor(Number(fbsWeight) || 0)),
    explore: Math.max(0, Math.floor(Number(exploreWeight) || 0)),
  };
  if (Object.values(weights).every((value) => value === 0)) return [...queues.strict, ...queues.fbs, ...queues.explore];
  const cursors = { strict: 0, fbs: 0, explore: 0 };
  const result = [];
  while (Object.keys(queues).some((tier) => cursors[tier] < queues[tier].length)) {
    let progressed = false;
    for (const tier of ["strict", "fbs", "explore"]) {
      for (let offset = 0; offset < weights[tier] && cursors[tier] < queues[tier].length; offset += 1) {
        result.push(queues[tier][cursors[tier]++]);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  for (const tier of ["strict", "fbs", "explore"]) {
    result.push(...queues[tier].slice(cursors[tier]));
  }
  return result;
}

function exhaustedSourceFamilyPenalties(rows) {
  const families = new Map();
  (rows || []).forEach((row, order) => {
    const familyKey = sourceUrlKey(row?.source_url);
    const priceBanded = isPriceBandedSource(row?.source_url);
    const key = priceBanded ? sourceYieldKey(row?.source_url) : familyKey;
    const sku = String(row?.sku || "").trim();
    const status = String(row?.status || "");
    if ((!canonicalSellerUrl(familyKey) && !priceBanded)
      || !sku
      || !["favorited", "submitted", "published", "rejected", "skipped"].includes(status)) return;
    const family = families.get(key) || { outcomes: new Map(), priceBanded: false };
    family.priceBanded ||= priceBanded;
    const productive = status === "favorited" || status === "submitted" || status === "published";
    const event = {
      sku,
      status,
      productive,
      explicitNonPureFbs: /non-pure-fbs/i.test(String(row?.reason || "")),
      explicit1688NoMatch: /1688-no-reliable-match/i.test(String(row?.reason || "")),
      time: Date.parse(row?.at || row?.timestamp || "") || 0,
      order,
    };
    const previous = family.outcomes.get(sku);
    if (!previous || event.time > previous.time || (event.time === previous.time && order > previous.order)) {
      family.outcomes.set(sku, event);
    }
    families.set(key, family);
  });
  return new Map([...families].flatMap(([key, family]) => {
    const dryThreshold = family.priceBanded ? 8 : 12;
    const minimumYield = family.priceBanded ? 0.2 : 0.1;
    const attempted = family.outcomes.size;
    const productive = [...family.outcomes.values()].filter((event) => event.productive).length;
    const recent = [...family.outcomes.values()]
      .sort((left, right) => right.time - left.time || right.order - left.order)
      .slice(0, dryThreshold);
    const recentProductive = recent.filter((event) => event.productive).length;
    if (recent.length >= 4
      && recent.slice(0, 4).every((event) => event.explicit1688NoMatch)
      && recent.slice(0, 4).every((event) => !["submitted", "published"].includes(event.status))) {
      return [[key, -500_000]];
    }
    if (family.priceBanded
      && recent.length >= 4
      && recent.slice(0, 4).every((event) => event.explicitNonPureFbs)) return [[key, -500_000]];
    if (recent.length >= dryThreshold && recentProductive / recent.length < minimumYield) return [[key, -500_000]];
    if (recent.length >= 4 && recentProductive / recent.length >= minimumYield) return [];
    return attempted >= dryThreshold && productive / attempted < minimumYield ? [[key, -250_000]] : [];
  }));
}

function recentSellerFamilyPenalties(rows) {
  const sellers = new Map();
  (rows || []).forEach((row, order) => {
    const key = canonicalSellerUrl(row?.source_url) || canonicalSellerUrl(row?.seller_url);
    const sku = String(row?.sku || "").trim();
    const status = String(row?.status || "");
    if (!key || !sku || !["favorited", "submitted", "published", "rejected", "skipped"].includes(status)) return;
    const outcomes = sellers.get(key) || new Map();
    const previous = outcomes.get(sku);
    const time = Date.parse(row?.at || row?.timestamp || "") || 0;
    if (!previous || time > previous.time || (time === previous.time && order > previous.order)) {
      outcomes.set(sku, {
        productive: status === "favorited" || status === "submitted" || status === "published",
        strict: status === "submitted" || status === "published",
        time,
        order,
      });
    }
    sellers.set(key, outcomes);
  });
  return new Map([...sellers].flatMap(([key, outcomes]) => {
    const recent = [...outcomes.values()]
      .sort((left, right) => right.time - left.time || right.order - left.order)
      .slice(0, 12);
    if (recent.length < 12) return [];
    if (recent.filter((outcome) => outcome.strict).length >= 2) return [];
    const productiveRate = recent.filter((outcome) => outcome.productive).length / recent.length;
    if (productiveRate === 0) return [[key, -600_000]];
    return productiveRate < 0.3 ? [[key, -300_000]] : [];
  }));
}

export function prioritizeSourceUrls(urls, {
  highYieldSources = [],
  yieldRows = [],
  scanRows = [],
  freshSourceUrls = [],
  qualifiedFreshSourceUrls = [],
  verifiedFreshSourceUrls = [],
  boundedDeepFreshSourceUrls = [],
} = {}) {
  const successfulCounts = new Map();
  for (const source of highYieldSources) {
    const key = sourceYieldKey(source);
    successfulCounts.set(key, (successfulCounts.get(key) || 0) + 1);
  }
  const strictSuccessSkusBySource = new Map();
  for (const row of yieldRows) {
    if (String(row?.status || "") !== "published") continue;
    const key = sourceYieldKey(row?.source_url);
    const sku = String(row?.sku || "").trim();
    if (!key || !sku) continue;
    const skus = strictSuccessSkusBySource.get(key) || new Set();
    skus.add(sku);
    strictSuccessSkusBySource.set(key, skus);
  }
  const funnelScores = fullFunnelSourceScores(yieldRows);
  const familyScores = observedTitleFamilyScores(yieldRows);
  const familyPenalties = exhaustedSourceFamilyPenalties(yieldRows);
  const sellerFamilyPenalties = recentSellerFamilyPenalties(yieldRows);
  const exhaustedScanFamilies = exhaustedScanFamilyKeys(scanRows);
  const freshKeys = new Set(freshSourceUrls.map(sourceUrlKey));
  const qualifiedFreshKeys = new Set(qualifiedFreshSourceUrls.map(sourceUrlKey));
  const verifiedFreshKeys = new Set(verifiedFreshSourceUrls.map(sourceUrlKey));
  const boundedDeepFreshKeys = new Set(boundedDeepFreshSourceUrls.map(sourceNonFbsSampleKey).filter(Boolean));
  const verifiedSellerKeys = new Set(verifiedFreshSourceUrls
    .filter((url) => canonicalSellerUrl(url))
    .map(sourceUrlKey));
  const groups = new Map();
  [...urls].forEach((url, index) => {
    const familyKey = sourceUrlKey(url);
    const yieldKey = sourceYieldKey(url);
    const scanFamilyKey = isPriceBandedSource(url) ? yieldKey : familyKey;
    const boundedDeep = boundedDeepFreshKeys.has(sourceNonFbsSampleKey(url));
    const boundedDeepProtected = boundedDeep
      && !exhaustedScanFamilies.has(scanFamilyKey);
    const key = isPriceBandedSource(url)
      ? yieldKey
      : boundedDeepProtected ? `bounded-deep:${familyKey}` : familyKey;
    const yieldPriority = funnelScores.has(yieldKey) ? funnelScores.get(yieldKey) : (successfulCounts.get(yieldKey) || 0) * 2000;
    const curatedExploration = yieldPriority <= 0
      && (isProvenSellerSource(url) || isExplicitChinaCollectionSource(url));
    const familyPenalty = familyPenalties.get(isPriceBandedSource(url) ? yieldKey : familyKey) || 0;
    const sellerFamilyPenalty = sellerFamilyPenalties.get(canonicalSellerUrl(url)) || 0;
    const effectiveFamilyPenalty = Math.min(familyPenalty, sellerFamilyPenalty);
    const scanPenalty = exhaustedScanFamilies.has(scanFamilyKey) ? -600_000 : 0;
    const repeatedStrictGlobal = /(?:[?&]is_global=true(?:&|$)|ozon-global|tovary-iz-kitaya)/i.test(String(url))
      && (strictSuccessSkusBySource.get(yieldKey)?.size || 0) >= 2
      && yieldPriority > 0
      && effectiveFamilyPenalty >= 0
      && scanPenalty >= 0;
    const baseTier = verifiedSellerKeys.has(familyKey)
      ? 4
      : repeatedStrictGlobal ? 3
      : qualifiedFreshKeys.has(familyKey)
        ? 3
        : verifiedFreshKeys.has(familyKey) ? 2 : (freshKeys.has(familyKey) || curatedExploration) ? 1 : 0;
    let tier = sellerFamilyPenalty < 0
      ? 0
      : familyPenalty < 0
      ? boundedDeepProtected ? 3 : (canonicalSellerUrl(url) ? Math.min(baseTier, 1) : 0)
      : baseTier;
    if (scanPenalty < 0 && !boundedDeepProtected) tier = 0;
    const priority = sourceUrlPriority(url) + observedSearchFamilyPriority(url, familyScores) + yieldPriority
      + (freshKeys.has(familyKey) || curatedExploration ? 200_000 : 0)
      + (qualifiedFreshKeys.has(familyKey) ? 300_000 : 0)
      + (verifiedFreshKeys.has(familyKey) ? 400_000 : 0)
      + effectiveFamilyPenalty
      + scanPenalty;
    const group = groups.get(key) || { index, priority, tier, urls: [] };
    group.priority = Math.max(group.priority, priority);
    group.tier = Math.max(group.tier, tier);
    group.urls.push(url);
    groups.set(key, group);
  });
  const ordered = [];
  // Strict-success and repeated-submission sellers are both evidence-backed.
  // Rotate those two tiers together so one seller cannot fill an entire source
  // batch merely because its variants sit one tier above the next seller.
  for (const tiers of [[4, 3], [2], [1], [0]]) {
    const rankedByTier = tiers.map((tier) => [...groups.values()]
      .filter((group) => group.tier === tier)
      .sort((left, right) => right.priority - left.priority || left.index - right.index));
    const ranked = [];
    const tierRounds = Math.max(0, ...rankedByTier.map((values) => values.length));
    for (let index = 0; index < tierRounds; index += 1) {
      for (const values of rankedByTier) {
        if (values[index]) ranked.push(values[index]);
      }
    }
    const rounds = Math.max(0, ...ranked.map((group) => group.urls.length));
    const burst = 2;
    for (let round = 0; round < rounds; round += burst) {
      for (const group of ranked) {
        for (let offset = 0; offset < burst; offset += 1) {
          if (group.urls[round + offset]) ordered.push(group.urls[round + offset]);
        }
      }
    }
  }
  return ordered;
}

export function retainedRowsForCollection(records, {
  skipRetained = false,
  provenOnly = false,
  highYieldSources = [],
  yieldRows = [],
} = {}) {
  const successfulKeys = new Set(highYieldSources.map(sourceYieldKey));
  const exhaustedFamilies = exhaustedSourceFamilyPenalties(yieldRows);
  return (records || []).filter((row) => {
    if (provenOnly && !isProvenSellerSource(row?.source_url)) return false;
    if (skipRetained && !successfulKeys.has(sourceYieldKey(row?.source_url))) return false;
    const familyKey = isPriceBandedSource(row?.source_url)
      ? sourceYieldKey(row?.source_url)
      : sourceUrlKey(row?.source_url);
    if (skipRetained && (exhaustedFamilies.get(familyKey) || 0) < 0) return false;
    return true;
  });
}

export function orderRowsBySourceYield(rows, yieldRows = []) {
  const stats = new Map();
  const outcomes = latestSourceSkuOutcomes(yieldRows, new Set(["favorited", "submitted", "published", "rejected", "skipped"]));
  for (const [key, skuOutcomes] of outcomes) {
    const value = stats.get(key) || { attempted: 0, published: 0, submitted: 0, outcomeWeight: 0 };
    for (const { status } of skuOutcomes.values()) {
      value.attempted += 1;
      if (status === "published") {
        value.published += 1;
        value.outcomeWeight += 3;
      } else if (status === "submitted") {
        value.submitted += 1;
        value.outcomeWeight += 1.5;
      } else if (status === "favorited") {
        value.outcomeWeight += 0.5;
      }
    }
    stats.set(key, value);
  }
  return [...(rows || [])].map((row, index) => {
    const value = stats.get(sourceYieldKey(row?.source_url)) || { attempted: 0, published: 0, submitted: 0, outcomeWeight: 0 };
    return {
      row,
      index,
      published: value.published,
      submitted: value.submitted,
      score: (value.outcomeWeight + 0.5) / (value.attempted + 2),
      priceFloor: (() => {
        try { return Number.parseFloat(new URL(row?.source_url).searchParams.get("currency_price")) || 0; }
        catch { return 0; }
      })(),
    };
  }).sort((left, right) => right.score - left.score
    || right.published - left.published
    || right.submitted - left.submitted
    || right.priceFloor - left.priceFloor
    || left.index - right.index)
    .map(({ row }) => row);
}

export function shouldYieldAfterRetained({
  retainedLinks,
  retainedAttempted = retainedLinks,
  retainedFavorited = 0,
  pendingSources,
}) {
  return Number(retainedLinks) > 0
    && Number(retainedAttempted) > 0
    && Number(retainedFavorited) > 0
    && Number(pendingSources) > 0;
}

export function shouldYieldForSourceFeedback({ completedBatches, maximumBatches, pendingSources }) {
  const maximum = Math.max(0, Number(maximumBatches) || 0);
  return maximum > 0
    && Number(completedBatches) >= maximum
    && Number(pendingSources) > 0;
}

export function sourceBatchPrefetchAllowed({
  sourceBlocked,
  deadlineReached,
  completedBatches,
  maximumBatches,
  remainingSources,
}) {
  if (sourceBlocked || deadlineReached || !(Number(remainingSources) > 0)) return false;
  return !(Number(maximumBatches) > 0 && Number(completedBatches) >= Number(maximumBatches));
}

export function nextLowYieldBatchStreak({ current = 0, favorited = 0, threshold = 1 }) {
  return Number(favorited) < Number(threshold) ? Number(current) + 1 : 0;
}

export function prioritizeFavoriteLinks(links, familyScores = {}) {
  return [...links]
    .map((link, index) => ({ link, index, priority: favoriteLinkPriority(link, familyScores) }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
    .map(({ link }) => link);
}

function deduplicateTitleVariants(links) {
  const seen = new Set();
  return (links || []).filter((link) => {
    const signature = String(link?.text || "").toLowerCase()
      .replace(/[^a-zа-яё]+/gi, " ")
      .trim()
      .split(/\s+/)
      .filter((word) => word.length >= 3)
      .slice(0, 12)
      .join(" ") || String(link?.href || "");
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

export function limitLinksPerSource(rows, limit = 24, familyScores = {}) {
  const maximum = Math.max(1, Number(limit) || 24);
  const perSource = rows.map((row) => deduplicateTitleVariants(prioritizeFavoriteLinks((row?.links || []).map((link) => ({
    ...link,
    source_url: row.source_url,
  })), familyScores)).slice(0, maximum));
  const combined = [];
  for (let index = 0; index < maximum; index += 1) {
    const sourceRound = [];
    for (const links of perSource) if (links[index]) sourceRound.push(links[index]);
    combined.push(...prioritizeFavoriteLinks(sourceRound, familyScores));
  }
  return combined;
}

export function eligibleLinkCountsBySource(links, attempted = new Set(), {
  requireListingFbsEvidence = false,
} = {}) {
  const seen = new Map();
  const counts = new Map();
  for (const link of links || []) {
    if (requireListingFbsEvidence && !hasListingPluginFbsEvidence(link?.card_text)) continue;
    const source = sourceNonFbsSampleKey(link?.source_url);
    const sku = skuFromProductUrl(link?.href);
    if (!source || !sku || attempted.has(sku)) continue;
    const sourceSeen = seen.get(source) || new Set();
    if (sourceSeen.has(sku)) continue;
    sourceSeen.add(sku);
    seen.set(source, sourceSeen);
    counts.set(source, (counts.get(source) || 0) + 1);
  }
  return counts;
}

export function exhaustedScanFamilyKeys(records, consecutive = 2) {
  const minimum = Math.max(1, Number(consecutive) || 2);
  const groups = new Map();
  for (const row of records || []) {
    if (typeof row?.eligible_link_count_before_collection !== "number") continue;
    const eligible = Number(row?.eligible_link_count_before_collection);
    const linkCount = Number(row?.cumulative_product_link_count) || Number(row?.links?.length) || 0;
    if (!Number.isFinite(eligible) || linkCount < 12) continue;
    const family = isPriceBandedSource(row?.source_url)
      ? sourceYieldKey(row?.source_url)
      : sourceUrlKey(row?.source_url);
    const variant = sourceNonFbsSampleKey(row?.source_url);
    if (!family || !variant) continue;
    const events = groups.get(family) || [];
    events.push({ variant, eligible });
    groups.set(family, events);
  }
  const exhausted = new Set();
  for (const [family, events] of groups) {
    const recent = [];
    const seen = new Set();
    for (const event of [...events].reverse()) {
      if (seen.has(event.variant)) continue;
      seen.add(event.variant);
      recent.push(event);
      if (recent.length >= minimum) break;
    }
    if (recent.length >= minimum && recent.every((event) => event.eligible === 0)) exhausted.add(family);
  }
  return exhausted;
}

export function cachedExactFbsFallbackLinks(records, {
  attempted = new Set(),
  limit = 24,
  familyScores = {},
  yieldRows = [],
  requireReusableFacts = false,
} = {}) {
  const maximum = Math.max(0, Number(limit) || 0);
  if (maximum === 0) return [];
  const result = [];
  const seen = new Set();
  const eligibleRows = orderRowsBySourceYield((records || []).map((row) => ({
    ...row,
    links: (row?.links || []).map((link) => ({ ...link, source_url: row.source_url }))
      .filter((link) => {
        const sku = skuFromProductUrl(link?.href);
        const snapshot = parseListingFavoriteSnapshot(link);
        return sku && !attempted.has(sku) && !favoriteTitleSkipReason(link?.text)
          && Boolean(snapshot)
          && (!requireReusableFacts || snapshot.price_info?.currency === "CNY");
      }),
  })).filter((row) => row.links.length > 0), yieldRows);
  for (const link of limitLinksPerSource(eligibleRows, maximum, familyScores)) {
    const sku = skuFromProductUrl(link?.href);
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    result.push(link);
    if (result.length >= maximum) break;
  }
  return result;
}

export function fillRetainedFallbackLinks(retained, fallback, limit = 24) {
  const maximum = Math.max(0, Number(limit) || 0);
  const result = [];
  const seen = new Set();
  for (const link of [...(retained || []), ...(fallback || [])]) {
    const key = skuFromProductUrl(link?.href) || String(link?.href || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(link);
    if (result.length >= maximum) break;
  }
  return result;
}

export function terminalSkusFromJsonl(text) {
  return terminalSkusFromEvents(parseJsonLinesChunk(text).rows);
}

export function terminalSkusFromEvents(events = []) {
  const latest = new Map();
  for (const event of events || []) {
    const sku = String(event?.sku ?? "").trim();
    if (sku) latest.set(sku, String(event?.status || ""));
  }
  return new Set([...latest].filter(([, status]) => status === "skipped" || status === "published").map(([sku]) => sku));
}

export function sourceExcludedSkusFromStateEvents(events = []) {
  const latest = new Map();
  for (const event of events || []) {
    const sku = String(event?.sku ?? "").trim();
    if (sku) latest.set(sku, event);
  }
  return new Set([...latest].filter(([, event]) => {
    const status = String(event?.status || "");
    const data = event?.data || {};
    return status === "skipped"
      || status === "published"
      || data.submitted === true
      || data.submission_pending === true
      || data.reconcile_only === true;
  }).map(([sku]) => sku));
}

export function excludedSkusFromHistories({ stateTexts = [], favoriteTexts = [] } = {}) {
  return excludedSkusFromEventHistories({
    stateEventGroups: stateTexts.map((text) => parseJsonLinesChunk(text).rows),
    favoriteEventGroups: favoriteTexts.map((text) => parseJsonLinesChunk(text).rows),
  });
}

export function excludedSkusFromEventHistories({ stateEventGroups = [], favoriteEventGroups = [] } = {}) {
  const excluded = new Set();
  for (const events of stateEventGroups) {
    for (const sku of sourceExcludedSkusFromStateEvents(events)) excluded.add(sku);
  }
  for (const events of favoriteEventGroups) {
    for (const event of events || []) {
      const deterministicMissingMode = event?.status === "failed" && /^missing-shipping-mode:/i.test(String(event?.error || ""));
      const needsCurrencyRecheck = event?.status === "rejected" && event?.reason === "non-cny-sale-price";
      if (((event?.status === "rejected" && !needsCurrencyRecheck) || deterministicMissingMode) && event?.sku) {
        excluded.add(String(event.sku));
      }
    }
  }
  return excluded;
}

export function favoritedSkusFromHistory(text) {
  return favoritedSkusFromEvents(parseJsonLinesChunk(text).rows);
}

export function favoritedSkusFromEvents(events = []) {
  const skus = new Set();
  for (const event of events || []) {
    if (event?.status === "favorited" && event?.sku) skus.add(String(event.sku));
  }
  return skus;
}

async function loadExcludedSkus(outputPath, env) {
  const stateFiles = [
    path.join(path.dirname(outputPath), "sku_states.jsonl"),
    ...String(env.FLOW_B_STATE_SEED_FILES || "").split(path.delimiter).filter(Boolean),
  ];
  const favoriteFiles = [
    path.join(path.dirname(outputPath), "favorite_collection.jsonl"),
    ...String(env.FLOW_B_FAVORITE_SEED_FILES || "").split(path.delimiter).filter(Boolean),
  ];
  const readHistories = async (filenames) => {
    const eventGroups = [];
    for (const filename of [...new Set(filenames.map((value) => path.resolve(value)))]) {
      eventGroups.push(await readJsonLinesIncremental(filename));
    }
    return eventGroups;
  };
  const stateEventGroups = await readHistories(stateFiles);
  const favoriteEventGroups = await readHistories(favoriteFiles);
  const excluded = excludedSkusFromEventHistories({ stateEventGroups, favoriteEventGroups });
  for (const sku of favoritedSkusFromEvents(favoriteEventGroups[0] || [])) excluded.add(sku);
  if (env.FLOW_B_EXCLUDED_SKUS) {
    for (const sku of String(env.FLOW_B_EXCLUDED_SKUS).split(/[,\s]+/).filter(Boolean)) excluded.add(sku);
  }
  const publishedCsv = path.resolve(env.FLOW_B_PUBLISHED_CSV || path.join(import.meta.dirname, "../../data/flow_b/published_links.csv"));
  try {
    const csvText = await fs.readFile(publishedCsv, "utf8");
    for (const line of csvText.split(/\r?\n/)) {
      const sku = skuFromProductUrl(line);
      if (sku) excluded.add(sku);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return excluded;
}

function skuFromProductUrl(value) {
  return String(value || "").match(/\/product\/(?:[^/?#]*-)?(\d+)(?:[/?#]|$)/)?.[1] || "";
}

export function filterCandidateCooldownLinks(rows = [], candidateQueue, { nowMs = Date.now() } = {}) {
  return (rows || []).filter((row) => {
    const sku = String(row?.sku || "").trim() || skuFromProductUrl(row?.href);
    return !sku || !candidateQueue?.inCooldown?.(sku, { nowMs });
  });
}

export function compactListingCardText(value) {
  const evidence = [];
  let hasMode = false;
  let hasPrice = false;
  let hasGlobal = false;
  for (const rawLine of String(value || "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    let useful = false;
    if (!hasMode && /发货模式\s*[：:]/i.test(line)) {
      hasMode = true;
      useful = true;
    }
    if (!hasPrice && /[¥₽₸]/.test(line)) {
      hasPrice = true;
      useful = true;
    }
    if (!hasGlobal && /доставка\s+из\s+(?:китая|за\s+рубежа)|cross.?border|ozon\s+global/i.test(line)) {
      hasGlobal = true;
      useful = true;
    }
    if (useful) evidence.push(line.slice(0, 120));
    if (hasMode && hasPrice && hasGlobal) break;
  }
  return evidence.join("\n").slice(0, 300);
}

export function pruneAttemptedSourceLinks(records, attempted = new Set()) {
  const excluded = attempted instanceof Set ? attempted : new Set();
  return (records || []).map((row) => ({
    ...row,
    links: (row?.links || [])
      .filter((link) => {
        const sku = skuFromProductUrl(link?.href);
        return !sku || !excluded.has(sku);
      })
      .map((link) => ({
        ...link,
        card_text: compactListingCardText(link?.card_text),
      })),
  }));
}

export function parseFavoriteProductSnapshot({ url, title, ogTitle, ogImage, priceText, sellerUrl }) {
  const sku = skuFromProductUrl(url);
  if (!sku) throw new Error("Ozon product SKU is missing");
  const coverImage = String(ogImage || "").trim();
  if (!coverImage) throw new Error(`Ozon cover image is missing for SKU ${sku}`);
  const source = String(priceText || "");
  const rawPrice = source.match(/[0-9][0-9\s\u00a0\u2009\u202f]*(?:[,.][0-9]+)?/)?.[0] || "";
  const sellPrice = Number(rawPrice.replace(/[\s\u00a0\u2009\u202f]/g, "").replace(",", "."));
  if (!Number.isFinite(sellPrice) || sellPrice <= 0) throw new Error(`Ozon sell price is missing for SKU ${sku}`);
  const currency = source.includes("¥") ? "CNY" : source.includes("₸") ? "KZT" : "RUB";
  const productTitle = String(ogTitle || title || "")
    .replace(/\s+купить на OZON.*$/i, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .trim();
  if (!productTitle) throw new Error(`Ozon title is missing for SKU ${sku}`);
  return {
    sku,
    coverImage,
    price_info: { sell_price: sellPrice, currency },
    title: productTitle,
    seller_url: canonicalSellerUrl(sellerUrl),
  };
}

export function parseListingFavoriteSnapshot(link) {
  const cardText = String(link?.card_text || "");
  const mode = cardText.match(/(?:^|\n)\s*发货模式\s*[：:]\s*([^\n]+)/i)?.[1]?.trim() || "";
  if (!isPureFbs(mode)) return null;
  const sku = skuFromProductUrl(link?.href);
  const coverImage = String(link?.image_url || "").trim();
  const title = String(link?.text || "").trim();
  const priceMatch = cardText.match(/([0-9][0-9\s\u00a0\u2009\u202f]*(?:[,.][0-9]+)?)\s*([¥₽₸])/);
  const sellPrice = Number(String(priceMatch?.[1] || "")
    .replace(/[\s\u00a0\u2009\u202f]/g, "")
    .replace(",", "."));
  if (!sku || !coverImage || !title || !(sellPrice > 0)) return null;
  return {
    sku,
    coverImage,
    price_info: {
      sell_price: sellPrice,
      currency: priceMatch[2] === "¥" ? "CNY" : priceMatch[2] === "₸" ? "KZT" : "RUB",
    },
    title,
    seller_url: canonicalSellerUrl(link?.source_url),
  };
}

export function reusableListingFavoriteSnapshot(link, { verifyDetail = false } = {}) {
  return verifyDetail ? null : parseListingFavoriteSnapshot(link);
}

async function favoriteCount(page) {
  const result = await retryMaoziPageFetch(() => page.evaluate(async () => {
    let token = "";
    try { token = JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || ""; } catch {}
    const headers = { "Accept-Language": "zh-CN", Client: "pc" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch("https://api.maozierp.com/api.product.favorite/lists?page=1&page_size=1&is_imported=0", { headers });
    const body = await response.json();
    return {
      total: Number(body?.data?.total || 0),
      hasToken: Boolean(token),
      httpOk: response.ok,
      code: body?.code,
      pageText: (document.body?.innerText || "").slice(0, 1000),
    };
  }));
  return { total: result.total, authenticated: isFavoriteSessionAuthenticated(result) };
}

async function favoriteSkus(page) {
  return retryMaoziPageFetch(() => page.evaluate(async () => {
    let token = "";
    try { token = JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || ""; } catch {}
    const headers = { "Accept-Language": "zh-CN", Client: "pc" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch("https://api.maozierp.com/api.product.favorite/skus", { headers });
    const body = await response.json();
    if (!response.ok || Number(body?.code) !== 1 || !Array.isArray(body?.data)) {
      throw new Error(body?.msg || "Unable to load Maozi favorite SKUs");
    }
    return body.data.map(String);
  }));
}

async function favoriteProduct(page, productInfo) {
  return page.evaluate(async (payload) => {
    let token = "";
    try { token = JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || ""; } catch {}
    const headers = { "Accept-Language": "zh-CN", Client: "pc", "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch("https://api.maozierp.com/api.product.favorite/toggle", {
      method: "POST",
      headers,
      body: JSON.stringify({ productInfo: payload, status: true }),
    });
    const body = await response.json();
    if (!response.ok || Number(body?.code) !== 1) throw new Error(body?.msg || `HTTP ${response.status}`);
    return body;
  }, productInfo);
}

async function extractFavoriteProduct(page, url, timeout) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(10_000, Math.min(30_000, timeout * 2)) });
  const deadline = Date.now() + timeout;
  let snapshot;
  do {
    snapshot = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      ogTitle: document.querySelector('meta[property="og:title"]')?.content || "",
      ogImage: document.querySelector('meta[property="og:image"]')?.content || "",
      priceText: document.querySelector('div[data-widget="webPrice"]')?.innerText || "",
      sellerUrl: document.querySelector('[data-widget="webCurrentSeller"] a[href*="/seller/"], [data-widget*="CurrentSeller"] a[href*="/seller/"], [data-widget="webSeller"] a[href*="/seller/"]')?.href
        || document.querySelector('a[href*="/seller/"]')?.href || "",
      mode: (document.body?.innerText || "").match(/发货模式：\s*([^\n]+)/)?.[1]?.trim() || "",
      pageText: (document.body?.innerText || "").slice(0, 1000),
    })).catch(() => null);
    const diagnostic = `${snapshot?.title || ""} ${snapshot?.pageText || ""}`;
    if (isOzonCaptchaText(diagnostic)) {
      throw new Error(`Ozon CAPTCHA required: ${url}`);
    }
    if (isOzonSoftBlock(diagnostic)) {
      throw new Error(`Ozon detail soft blocked: ${url}`);
    }
    if (/доступ ограничен|access denied/i.test(diagnostic)) {
      throw new Error(`Ozon detail is blocked: ${url}`);
    }
    if (snapshot?.ogImage && snapshot?.priceText && snapshot?.mode) break;
    if (Date.now() >= deadline) break;
    await sleep(500);
  } while (true);
  const modeReason = favoriteModeSkipReason(snapshot?.mode);
  if (modeReason) throw new Error(`${modeReason}: SKU ${skuFromProductUrl(snapshot?.url || url)}`);
  return parseFavoriteProductSnapshot(snapshot || { url });
}

async function collectFavorites({ context, maozi, links, target, currentTotal, env, attempted, logFile, log, familyScores = {}, productiveSourceSampleKeys = new Set(), onResult = () => {}, workerPagePool = null, accessController = null }) {
  if (currentTotal >= target || !links.length || isCollectionDeadlineReached(env)) return currentTotal;
  let existing = new Set();
  try {
    existing = new Set(await readFavoriteSkusWithTimeout(
      () => favoriteSkus(maozi),
      envNumber(env, "FLOW_B_FAVORITE_TELEMETRY_TIMEOUT_MS", 10_000),
    ));
  } catch (error) {
    onResult({ status: "failed", error });
    log(`favorite SKU telemetry unavailable; continuing with run-local deduplication: ${error?.message || error}`);
  }
  const queue = [];
  const eligibleLinks = filterListingFbsEvidenceLinks(
    links,
    env.FLOW_B_REQUIRE_LISTING_FBS_EVIDENCE === "1",
  );
  for (const link of prioritizeFavoriteLinks(eligibleLinks, familyScores)) {
    const href = typeof link === "string" ? link : link?.href;
    const sku = skuFromProductUrl(href);
    if (!sku) continue;
    if (attempted.has(sku)) continue;
    if (existing.has(sku)) {
      onResult({ status: "favorited", sku, existing: true });
      continue;
    }
    attempted.add(sku);
    queue.push({
      sku,
      href,
      source_url: typeof link === "object" ? link?.source_url : null,
      text: typeof link === "object" ? link?.text : "",
      card_text: typeof link === "object" ? link?.card_text : "",
      image_url: typeof link === "object" ? link?.image_url : "",
    });
  }
  if (!queue.length) return currentTotal;
  const workerCount = Math.max(1, envNumber(env, "FLOW_B_FAVORITE_WORKERS", envNumber(env, "FLOW_B_TAB_WORKERS", 4)));
  const timeout = envNumber(env, "FLOW_B_FAVORITE_DETAIL_TIMEOUT", 15000);
  let cursor = 0;
  let total = currentTotal;
  const collection = { attempted: 0, favorited: 0, rejected: 0, failed: 0 };
  let inFlight = 0;
  const runtime = collectionRuntimeState(path.resolve(logFile));
  const collectionPacingFile = runtime.collectionPacingFile
    || path.join(path.dirname(path.resolve(logFile)), "collection_pacing.json");
  const acceptanceDeadline = collectionDeadlineMs(env);
  let apiChain = Promise.resolve();
  let detailGate = Promise.resolve();
  const softBlockedSources = new Set();
  const nonFbsDeferredSources = new Set();
  const sourceOutcomeStats = sourceSampleStatsFromEvents(await readJsonLinesIncremental(logFile));
  const nonFbsSampleLimit = Math.max(0, envNumber(env, "FLOW_B_SOURCE_NON_FBS_SAMPLE_LIMIT", 6));
  for (const [sourceSampleKey, stats] of sourceOutcomeStats) {
    const sourceSampleLimit = adaptiveNonFbsSampleLimit(
      nonFbsSampleLimit,
      productiveSourceSampleKeys.has(sourceSampleKey),
    );
    if (shouldDeferSourceAfterNonFbsSample(stats, sourceSampleLimit)) {
      nonFbsDeferredSources.add(sourceSampleKey);
    }
  }
  const recordSourceOutcome = (sourceSampleKey, outcome) => {
    if (!sourceSampleKey) return null;
    const next = nextSourceSampleStats(sourceOutcomeStats.get(sourceSampleKey), outcome);
    sourceOutcomeStats.set(sourceSampleKey, next);
    return next;
  };
  const apiInterval = Math.max(0, envNumber(env, "FLOW_B_FAVORITE_API_INTERVAL_MS", 750));
  const maxRetries = Math.max(0, envNumber(env, "FLOW_B_FAVORITE_API_RETRIES", 5));
  const detailPacing = favoriteDetailPacingOptions(env);
  const detailBaseInterval = detailPacing.baseIntervalMs;
  const detailMinInterval = detailPacing.minIntervalMs;
  const detailIntervalStep = detailPacing.stepMs;
  const detailSoftBlockIntervalStep = detailPacing.softBlockStepMs;
  const detailMaxInterval = detailPacing.maxIntervalMs;
  const detailStableWindow = detailPacing.stableWindow;
  if (!Number.isFinite(Number(runtime.detailIntervalMs))) runtime.detailIntervalMs = detailBaseInterval;
  if (!Number.isFinite(Number(runtime.detailStableSuccesses))) runtime.detailStableSuccesses = 0;
  const updateDetailPacing = (event) => {
    const previous = runtime.detailIntervalMs;
    const next = nextDetailPacingState({
      intervalMs: runtime.detailIntervalMs,
      stableSuccesses: runtime.detailStableSuccesses,
      baseIntervalMs: detailBaseInterval,
      minIntervalMs: detailMinInterval,
      maxIntervalMs: detailMaxInterval,
      stepMs: detailIntervalStep,
      softBlockStepMs: detailSoftBlockIntervalStep,
      stableWindow: detailStableWindow,
      event,
    });
    runtime.detailIntervalMs = next.intervalMs;
    runtime.detailStableSuccesses = next.stableSuccesses;
    if (next.intervalMs !== previous) log(`Ozon detail pacing interval=${next.intervalMs}ms event=${event}`);
    return next.intervalMs !== previous;
  };
  const detailRetries = Math.max(0, envNumber(env, "FLOW_B_FAVORITE_DETAIL_RETRIES", 3));
  const reserveDetailSlot = () => {
    const operation = detailGate.then(async () => {
      await waitForMovingDeadline({ getDeadline: () => Math.min(Math.max(runtime.nextDetailAt, runtime.detailBlockedUntil), acceptanceDeadline) });
      if (isCollectionDeadlineReached(env)) {
        const error = new Error("collection deadline reached");
        error.code = "FLOW_B_DEADLINE_REACHED";
        throw error;
      }
      runtime.nextDetailAt = Date.now() + runtime.detailIntervalMs;
    });
    detailGate = operation.catch(() => {});
    return operation;
  };
  const loadProduct = async (page, item) => {
    for (let attempt = 0; ; attempt += 1) {
      const sourceBlockKey = sourceCollectionBlockKey(item.source_url);
      const nonFbsSampleKey = sourceNonFbsSampleKey(item.source_url);
      if (sourceBlockKey && softBlockedSources.has(sourceBlockKey)) {
        const error = new Error(`source deferred after Ozon detail soft block: ${sourceBlockKey}`);
        error.code = "FLOW_B_SOURCE_SOFT_BLOCKED";
        throw error;
      }
      if (nonFbsSampleKey && nonFbsDeferredSources.has(nonFbsSampleKey)) {
        const error = new Error(`source deferred after low pure-FBS yield: ${nonFbsSampleKey}`);
        error.code = "FLOW_B_SOURCE_LOW_FBS_YIELD";
        throw error;
      }
      await reserveDetailSlot();
      if (sourceBlockKey && softBlockedSources.has(sourceBlockKey)) {
        const error = new Error(`source deferred after Ozon detail soft block: ${sourceBlockKey}`);
        error.code = "FLOW_B_SOURCE_SOFT_BLOCKED";
        throw error;
      }
      if (nonFbsSampleKey && nonFbsDeferredSources.has(nonFbsSampleKey)) {
        const error = new Error(`source deferred after low pure-FBS yield: ${nonFbsSampleKey}`);
        error.code = "FLOW_B_SOURCE_LOW_FBS_YIELD";
        throw error;
      }
      try {
        const result = accessController
          ? await accessController.run(
            { kind: "favorite-detail", url: item.href },
            () => extractFavoriteProduct(page, item.href, timeout),
          )
          : await extractFavoriteProduct(page, item.href, timeout);
        if (updateDetailPacing("success")) {
          await queueCollectionRuntimeStatePersist(collectionPacingFile, runtime);
        }
        runtime.detailSoftBlockStreak = 0;
        runtime.lastDetailSoftBlockAt = 0;
        return result;
      } catch (error) {
        if (isOzonAccessStoppedError(error)) throw error;
        const policy = ozonDetailFailurePolicy(error, attempt, detailRetries);
        if (!policy.softBlocked) {
          updateDetailPacing(/^non-pure-fbs:/i.test(String(error?.message || error)) ? "success" : "failure");
          throw error;
        }
        updateDetailPacing("soft-block");
        if (sourceBlockKey) softBlockedSources.add(sourceBlockKey);
        const cooldownState = collectionDetailCooldownState({
          streak: runtime.detailSoftBlockStreak,
          lastBlockedAt: runtime.lastDetailSoftBlockAt,
        });
        const cooldown = cooldownState.delay;
        runtime.detailSoftBlockStreak = cooldownState.streak;
        runtime.lastDetailSoftBlockAt = cooldownState.lastBlockedAt;
        runtime.detailBlockedUntil = Math.max(runtime.detailBlockedUntil, Date.now() + cooldown);
        await queueCollectionRuntimeStatePersist(collectionPacingFile, runtime);
        if (!policy.retry) throw error;
        log(`Ozon detail retry SKU ${item.sku} attempt=${attempt + 1} wait=${cooldown}ms`);
      }
    }
  };
  const callFavorite = (productInfo) => {
    const operation = apiChain.then(async () => {
      for (let attempt = 0; ; attempt += 1) {
        if (isCollectionDeadlineReached(env)) {
          const error = new Error("collection deadline reached");
          error.code = "FLOW_B_DEADLINE_REACHED";
          throw error;
        }
        const gateWait = Math.max(0, runtime.nextApiAt - Date.now());
        if (gateWait) await sleep(Math.min(gateWait, Math.max(0, acceptanceDeadline - Date.now())));
        try {
          const result = await favoriteProduct(maozi, productInfo);
          runtime.nextApiAt = Date.now() + apiInterval;
          return result;
        } catch (error) {
          runtime.nextApiAt = Date.now() + apiInterval;
          const retryDelay = favoriteRetryDelay(error, attempt);
          if (retryDelay === null || attempt >= maxRetries) throw error;
          log(`favorite API retry SKU ${productInfo.sku} attempt=${attempt + 1} wait=${retryDelay}ms: ${error?.message || error}`);
          await sleep(Math.min(retryDelay, Math.max(0, acceptanceDeadline - Date.now())));
        }
      }
    });
    apiChain = operation.catch(() => {});
    return operation;
  };
  const historyFile = path.resolve(env.FLOW_B_FBS_SOURCE_HISTORY || DEFAULT_FBS_SOURCE_HISTORY);
  let writeChain = Promise.resolve();
  const record = (row) => {
    writeChain = writeChain.then(() => appendFavoriteEvidence({ logFile, historyFile, row }));
    return writeChain;
  };
  const desiredWorkers = Math.min(workerCount, queue.length);
  const ownsWorkerPages = !Array.isArray(workerPagePool);
  const workerPages = ownsWorkerPages
    ? await Promise.all(Array.from({ length: desiredWorkers }, () => createFavoriteWorkerPage(
      context,
      envNumber(env, "FLOW_B_FAVORITE_PAGE_CREATE_TIMEOUT_MS", 10_000),
    )))
    : await ensureReusablePageSlots(
      context,
      workerPagePool,
      desiredWorkers,
      envNumber(env, "FLOW_B_FAVORITE_PAGE_CREATE_TIMEOUT_MS", 10_000),
    );
  const workers = workerPages.map(async (page) => {
    try {
      while (canClaimFavorite({ total, inFlight, target }) && !isCollectionDeadlineReached(env)) {
        const item = queue[cursor++];
        if (!item) break;
        const sourceBlockKey = sourceCollectionBlockKey(item.source_url);
        const nonFbsSampleKey = sourceNonFbsSampleKey(item.source_url);
        if ((sourceBlockKey && softBlockedSources.has(sourceBlockKey))
          || (nonFbsSampleKey && nonFbsDeferredSources.has(nonFbsSampleKey))) {
          attempted.delete(item.sku);
          onResult({
            status: "deferred",
            sku: item.sku,
            reason: sourceBlockKey && softBlockedSources.has(sourceBlockKey)
              ? `source deferred after Ozon detail soft block: ${sourceBlockKey}`
              : `source deferred after low pure-FBS yield: ${nonFbsSampleKey}`,
          });
          continue;
        }
        collection.attempted += 1;
        inFlight += 1;
        try {
          const listingModeReason = listingModeSkipReason(item.card_text);
          if (listingModeReason) throw new Error(`${listingModeReason}: SKU ${item.sku}`);
          const titleReason = favoriteTitleSkipReason(item.text);
          if (titleReason) throw new Error(`${titleReason}: SKU ${item.sku}`);
          const productInfo = reusableListingFavoriteSnapshot(item, {
            verifyDetail: env.FLOW_B_VERIFY_LISTING_FBS_DETAIL === "1",
          }) || await loadProduct(page, item);
          const detailTitleReason = favoriteTitleSkipReason(productInfo.title);
          if (detailTitleReason) throw new Error(`${detailTitleReason}: SKU ${item.sku}`);
          const priceReason = favoritePriceSkipReason(productInfo, envNumber(env, "FLOW_B_MAX_SOURCE_PRICE_CNY", 1000));
          if (priceReason) throw new Error(`${priceReason}: SKU ${item.sku}`);
          const favoritePayload = { ...productInfo };
          delete favoritePayload.seller_url;
          await callFavorite(favoritePayload);
          existing.add(productInfo.sku);
          total += 1;
          const observedTotal = total;
          await record({
            status: "favorited",
            preflight_mode: "FBS",
            shipping_mode: "FBS",
            sku: productInfo.sku,
            url: item.href,
            source_url_product: item.href,
            source_url: item.source_url || null,
            seller_url: productInfo.seller_url || null,
            sale_price: productInfo.price_info?.sell_price ?? null,
            source_currency: productInfo.price_info?.currency ?? null,
            title: productInfo.title,
            cover_image: productInfo.coverImage,
            total: observedTotal,
          });
          onResult({ status: "favorited", sku: productInfo.sku });
          recordSourceOutcome(nonFbsSampleKey, { status: "favorited" });
          collection.favorited += 1;
          log(`favorite SKU ${productInfo.sku} total=${observedTotal}/${target}`);
        } catch (error) {
          if (isOzonAccessStoppedError(error)) throw error;
          if (error?.code === "FLOW_B_DEADLINE_REACHED") {
            break;
          } else if (["FLOW_B_SOURCE_SOFT_BLOCKED", "FLOW_B_SOURCE_LOW_FBS_YIELD"].includes(error?.code)) {
            attempted.delete(item.sku);
            collection.attempted -= 1;
            onResult({ status: "deferred", sku: item.sku, reason: String(error?.message || error), error });
            continue;
          } else if (isFavoriteCapacityReached(error)) {
            total = target;
            await record({ status: "capacity_reached", sku: item.sku, url: item.href, source_url: item.source_url || null, message: String(error?.message || error) });
            onResult({ status: "capacity_reached", sku: item.sku });
            log(`favorite capacity reached; ending collection at configured target ${target}`);
          } else if (favoriteFailureDisposition(error).status === "rejected") {
            const { reason } = favoriteFailureDisposition(error);
            const sourceStats = recordSourceOutcome(nonFbsSampleKey, { status: "rejected", reason });
            if (sourceStats && reason === "non-pure-fbs") {
              const sourceSampleLimit = adaptiveNonFbsSampleLimit(
                nonFbsSampleLimit,
                productiveSourceSampleKeys.has(nonFbsSampleKey),
              );
              if (!nonFbsDeferredSources.has(nonFbsSampleKey)
                && shouldDeferSourceAfterNonFbsSample(sourceStats, sourceSampleLimit)) {
                nonFbsDeferredSources.add(nonFbsSampleKey);
                log(`source non-pure-FBS sample deferred after ${sourceStats.attempted} checks: ${nonFbsSampleKey}`);
              }
            }
            await record({ status: "rejected", reason, sku: item.sku, url: item.href, source_url: item.source_url || null });
            onResult({ status: "rejected", reason, sku: item.sku });
            collection.rejected += 1;
            log(`favorite rejected SKU ${item.sku}: ${reason}`);
          } else {
            recordSourceOutcome(nonFbsSampleKey, { status: "failed" });
            await record({ status: "failed", sku: item.sku, url: item.href, source_url: item.source_url || null, error: String(error?.message || error) });
            onResult({ status: "failed", sku: item.sku, error });
            collection.failed += 1;
            log(`favorite failed SKU ${item.sku}: ${error?.message || error}`);
          }
        } finally {
          inFlight -= 1;
        }
      }
    } finally {
      if (ownsWorkerPages) await page.close().catch(() => {});
    }
  });
  await Promise.all(workers);
  await writeChain;
  if (Object.values(collection).some((value) => value > 0)) {
    log(`favorite collection summary attempted=${collection.attempted} favorited=${collection.favorited} rejected=${collection.rejected} failed=${collection.failed}`);
  }
  return total;
}

export function sourceScanLinkTarget(perSourceLimit, multiplier = 2) {
  const limit = Math.max(1, Number(perSourceLimit) || 24);
  const headroom = Math.max(1, Number(multiplier) || 2);
  return Math.max(12, Math.ceil(limit * headroom));
}

export function boundedEvidenceSourceUrls({
  deepUrls = [],
  publishedPages = [],
  nextPublishedPages = [],
} = {}) {
  return [...new Set([
    ...(deepUrls || []),
    ...(publishedPages || []),
    ...(nextPublishedPages || []),
  ].filter(Boolean))];
}

export function sourceScanLinkTargetForSource(url, {
  perSourceLimit = 24,
  boundedDeepUrls = [],
} = {}) {
  const key = sourceNonFbsSampleKey(url);
  const bounded = boundedDeepUrls instanceof Set
    ? boundedDeepUrls.has(key) || boundedDeepUrls.has(String(url))
    : (boundedDeepUrls || []).some((value) => sourceNonFbsSampleKey(value) === key);
  return sourceScanLinkTarget(perSourceLimit, bounded ? 1.5 : 2);
}

async function scanOne(page, url, { steps, ratio, delay, initialWait, maxNoNewSteps, linkTarget }) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForContent(page, 20000);
  await waitForListingEnrichment(page, {
    maxWaitMs: initialWait,
    minWaitMs: Math.min(1500, Math.max(0, Number(initialWait) || 0)),
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  const links = new Map();
  let stable = 0;
  let noNew = 0;
  let lastHeight = 0;
  let lastY = -1;
  let lastLinkCount = 0;
  let title = "";
  let finalUrl = url;
  let blocked = false;
  let blockKind = null;
  let stopReason = "max_steps";
  const started = Date.now();

  for (let step = 0; step < steps; step += 1) {
    const state = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return {
        url: location.href,
        title: document.title,
        y: Math.round(scrollY),
        height: document.body?.scrollHeight || 0,
        viewport: innerHeight,
        text: text.slice(0, 900),
        links: [...document.querySelectorAll('a[href*="/product/"]')].map((anchor) => {
          const card = anchor.closest('div[data-index]');
          const image = card?.querySelector('img[src]');
          return {
            href: String(anchor.href || "").split("?")[0],
            text: String(anchor.innerText || anchor.title || "").trim().slice(0, 120),
            card_text: String(card?.innerText || "").trim().slice(0, 500),
            image_url: String(image?.currentSrc || image?.src || ""),
          };
        }),
      };
    });
    title = state.title;
    finalUrl = state.url;
    const diagnostic = `${title} ${state.text}`;
    blockKind = isOzonCaptchaText(diagnostic)
      ? "captcha"
      : /доступ ограничен|access denied|похоже, нет/i.test(diagnostic) ? "soft-block" : null;
    blocked = Boolean(blockKind);
    for (const link of state.links) {
      if (!link.href.includes("/product/")) continue;
      const prior = links.get(link.href) || {};
      links.set(link.href, {
        text: link.text || prior.text || "",
        card_text: compactListingCardText(link.card_text || prior.card_text || ""),
        image_url: link.image_url || prior.image_url || "",
      });
    }
    if (blocked) { stopReason = "blocked_or_empty"; break; }
    if (Number(linkTarget) > 0 && links.size >= Number(linkTarget)) {
      stopReason = "link_target_reached";
      break;
    }
    const nearBottom = state.y + state.viewport >= state.height - 100;
    stable = links.size === lastLinkCount && nearBottom && Math.abs(state.y - lastY) < 20 && Math.abs(state.height - lastHeight) < 20 ? stable + 1 : 0;
    noNew = links.size === lastLinkCount ? noNew + 1 : 0;
    lastLinkCount = links.size;
    lastY = state.y;
    lastHeight = state.height;
    if (stable >= 8) { stopReason = "stable_bottom"; break; }
    if (noNew >= maxNoNewSteps && nearBottom) { stopReason = "no_new_links_near_bottom"; break; }
    await page.evaluate((scrollRatio) => window.scrollBy(0, Math.max(350, Math.floor(innerHeight * scrollRatio))), ratio);
    await sleep(delay);
  }
  return {
    final_url: finalUrl,
    title,
    blocked,
    block_kind: blockKind,
    stop_reason: stopReason,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    cumulative_product_link_count: links.size,
    links: [...links].sort(([left], [right]) => left.localeCompare(right)).map(([href, meta]) => ({ href, ...meta })),
  };
}

export async function scanSourceWithPage({
  context,
  url,
  options,
  timeoutMs = 90_000,
  closeTimeoutMs = 5_000,
  scan = scanOne,
  pagePool = null,
  pageIndex = 0,
  accessController = null,
}) {
  const label = `source page lifecycle ${url}`;
  const reusable = Array.isArray(pagePool);
  const slot = Math.max(0, Number(pageIndex) || 0);
  let page = reusable && isReusablePageOpen(pagePool[slot]) ? pagePool[slot] : null;
  if (reusable && !page) pagePool[slot] = null;
  let expired = false;
  const pagePromise = page ? Promise.resolve(page) : Promise.resolve().then(() => context.newPage()).then(async (createdPage) => {
    if (expired) {
      await withTimeout(createdPage.close(), closeTimeoutMs, "expired source page close").catch(() => {});
      throw new Error(`${label} expired before page creation completed`);
    }
    page = createdPage;
    if (reusable) pagePool[slot] = createdPage;
    return createdPage;
  });
  try {
    const execute = async (createdPage) => {
      const result = await scan(createdPage, url, options);
      if (result?.blocked) {
        if (result?.block_kind === "captcha") throw new Error(`Ozon CAPTCHA required: ${url}`);
        throw new Error(`Ozon source soft blocked: ${url}`);
      }
      return result;
    };
    const createdPage = await withTimeout(pagePromise, timeoutMs, label);
    return accessController
      ? await accessController.run(
        { kind: "source", url },
        () => withTimeout(execute(createdPage), timeoutMs, label),
      )
      : await withTimeout(execute(createdPage), timeoutMs, label);
  } catch (error) {
    if (reusable && page) {
      pagePool[slot] = null;
      await withTimeout(page.close(), closeTimeoutMs, "failed reusable source page close").catch(() => {});
    }
    throw error;
  } finally {
    expired = true;
    if (!reusable && page) {
      await withTimeout(page.close(), closeTimeoutMs, "source page close").catch(() => {});
    }
  }
}

export function fatalSourceBatchError(rows = []) {
  const fatal = rows.find((row) => isFatalBrowserError(new Error(String(row?.stop_reason || ""))));
  if (!fatal) return null;
  return new Error(String(fatal.stop_reason || "fatal browser source error").replace(/^error:\s*/i, ""));
}

export function completedSourceUrls(records = [], {
  now = Date.now(),
  transientRetryMs = 10 * 60_000,
} = {}) {
  const retryDelay = Math.max(0, Number(transientRetryMs) || 0);
  return new Set((records || []).filter((row) => {
    if (!row?.source_url) return false;
    const transient = Boolean(row?.blocked)
      || /timed?\s*out|timeout|soft block|access denied|captcha|no connection|network|HTTP\s*0/i
        .test(String(row?.stop_reason || ""));
    if (!transient) return true;
    const scannedAt = Date.parse(row?.scanned_at || "");
    return Number.isFinite(scannedAt) && Number(now) - scannedAt < retryDelay;
  }).map((row) => row.source_url));
}

export async function scanSources({ context, urlsFile, outFile, env = process.env, log = console.log }) {
  const emit = createScannerLogger(log, env.FLOW_B_LOG_LEVEL || "verbose");
  const inputPath = path.resolve(urlsFile);
  const outputPath = path.resolve(outFile);
  const freshSourceFiles = String(env.FLOW_B_FRESH_SOURCE_FILES || "").split(path.delimiter).filter(Boolean);
  const freshInputUrls = [];
  for (const sourceFile of freshSourceFiles) {
    try {
      freshInputUrls.push(...(await fs.readFile(path.resolve(sourceFile), "utf8")).split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const expandedFreshInputUrls = expandFreshSellerSourceUrls(freshInputUrls);
  const classifiedFreshUrls = classifyFreshSourceUrls(expandedFreshInputUrls);
  const inputUrls = [...new Set([
    ...(await fs.readFile(inputPath, "utf8")).split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    ...expandedFreshInputUrls,
  ])];
  const allowlistFile = String(env.FLOW_B_SOURCE_ALLOWLIST_FILE || "").trim();
  const allowlistUrls = allowlistFile
    ? (await fs.readFile(path.resolve(allowlistFile), "utf8"))
      .split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    : [];
  const yieldFiles = [...new Set([
    path.join(path.dirname(outputPath), "source_yield.jsonl"),
    path.join(path.dirname(outputPath), "favorite_collection.jsonl"),
    env.FLOW_B_SOURCE_YIELD_HISTORY || DEFAULT_SOURCE_YIELD_HISTORY,
    env.FLOW_B_FBS_SOURCE_HISTORY || DEFAULT_FBS_SOURCE_HISTORY,
    ...String(env.FLOW_B_SOURCE_YIELD_SEED_FILES || "").split(path.delimiter).filter(Boolean),
    ...String(env.FLOW_B_FAVORITE_SEED_FILES || "").split(path.delimiter).filter(Boolean),
  ].map((value) => path.resolve(value)))];
  const yieldRows = [];
  for (const yieldFile of yieldFiles) {
    yieldRows.push(...await readJsonLinesIncremental(yieldFile));
  }
  const productiveSourceSampleKeys = new Set(yieldRows
    .filter((row) => ["favorited", "submitted", "published"].includes(String(row?.status || "")))
    .map((row) => sourceNonFbsSampleKey(row?.source_url))
    .filter(Boolean));
  const titleFamilyScores = observedTitleFamilyScores(yieldRows);
  const candidateSourceScores = fullFunnelSourceScores(yieldRows);
  const derivedPriceBands = String(env.FLOW_B_DERIVED_SEARCH_PRICE_BANDS || "150.000;")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const derivedResultPages = String(env.FLOW_B_DERIVED_SEARCH_PAGES || "1")
    .split(",").map(Number).filter((value) => Number.isInteger(value) && value > 0);
  const derivedSearchUrls = deriveSearchSourceUrls(
    yieldRows,
    envNumber(env, "FLOW_B_DERIVED_SEARCH_SOURCES", 200),
    derivedPriceBands,
    derivedResultPages,
  );
  const derivedPriorityLimit = Math.max(0, envNumber(env, "FLOW_B_DERIVED_PRIORITY_SOURCES", 80));
  const verifiedSellerUrls = verifiedSellerSourceUrls(
    yieldRows,
    verifiedSellerMinimumPublished(env),
  );
  const pureFbsSellerVariants = pureFbsSellerSourceVariants(
    yieldRows,
    envNumber(env, "FLOW_B_PURE_FBS_SELLER_MIN_FAVORITES", 2),
    envNumber(env, "FLOW_B_PURE_FBS_SELLERS", 50),
  );
  const verifiedSellerSet = new Set(verifiedSellerUrls);
  const deepVerifiedSellerVariants = deepVerifiedSellerSourceVariants(
    yieldRows,
    envNumber(env, "FLOW_B_DEEP_VERIFIED_SELLER_MIN_PUBLISHED", 2),
    envNumber(env, "FLOW_B_DEEP_VERIFIED_SELLERS", 50),
    String(env.FLOW_B_DEEP_VERIFIED_SELLER_PAGES || "2,3,4,5,6,7,8,9,10")
      .split(",").map(Number).filter((value) => Number.isInteger(value) && value > 1),
  );
  const boundedDeepFreshSourceUrls = deepVerifiedSellerVariants.filter((url) => {
    try { return Number(new URL(url).searchParams.get("page")) >= 4; }
    catch { return false; }
  });
  const submittedSellerUrls = repeatedSubmittedSellerSourceUrls(
    yieldRows,
    envNumber(env, "FLOW_B_SUBMITTED_SELLER_MIN_SKUS", 2),
    envNumber(env, "FLOW_B_SUBMITTED_SELLER_SOURCES", 50),
  ).filter((url) => !verifiedSellerSet.has(url));
  const submittedSellerSourceVariants = expandFreshSellerSourceUrls(submittedSellerUrls);
  const publishedSourcePages = expandPublishedSourcePages(
    [],
    yieldRows,
    String(env.FLOW_B_PUBLISHED_SOURCE_PAGES || "")
      .split(",").map(Number).filter((value) => Number.isInteger(value) && value > 1),
  );
  const nextPublishedDiscoveryPages = expandNextPublishedDiscoveryPages(yieldRows);
  const repeatedPublishedDiscoveryPageFour = expandRepeatedPublishedDiscoveryPageFour(
    yieldRows,
    envNumber(env, "FLOW_B_REPEATED_DISCOVERY_MIN_PUBLISHED", 2),
  );
  const boundedEvidenceSources = boundedEvidenceSourceUrls({
    deepUrls: boundedDeepFreshSourceUrls,
    publishedPages: publishedSourcePages,
    nextPublishedPages: [
      ...nextPublishedDiscoveryPages,
      ...repeatedPublishedDiscoveryPageFour,
    ],
  });
  const boundedEvidenceSourceKeys = new Set(
    boundedEvidenceSources.map(sourceNonFbsSampleKey).filter(Boolean),
  );
  const urls = filterSourceUrlsByAllowlist(filterProductiveSourceVariants(
    [...new Set([
      ...publishedSourcePages,
      ...nextPublishedDiscoveryPages,
      ...repeatedPublishedDiscoveryPageFour,
      ...expandHighYieldSourceUrls([
        ...inputUrls,
        ...verifiedSellerUrls,
        ...deepVerifiedSellerVariants,
        ...submittedSellerSourceVariants,
        ...pureFbsSellerVariants,
        ...derivedSearchUrls,
      ], yieldRows),
    ])],
    yieldRows,
  ), allowlistUrls, {
    match: String(env.FLOW_B_SOURCE_ALLOWLIST_MATCH || "family").toLowerCase(),
  });
  const allowlistOptions = {
    match: String(env.FLOW_B_SOURCE_ALLOWLIST_MATCH || "family").toLowerCase(),
  };
  let records = filterSourceRowsByAllowlist(
    await readJsonArrayCached(outputPath),
    allowlistUrls,
    allowlistOptions,
  );
  const done = completedSourceUrls(records, {
    transientRetryMs: envNumber(env, "FLOW_B_SOURCE_RETRY_DELAY_MS", 10 * 60_000),
  });
  const highYieldSources = yieldRows.filter((row) => row?.status === "published").map((row) => row.source_url);
  const prioritizedPending = prioritizeSourceUrls(excludeCompletedSourceFamilies(
    urls,
    done,
    allowlistOptions,
  ), {
    highYieldSources,
    yieldRows,
    scanRows: records,
    freshSourceUrls: [
      ...classifiedFreshUrls.explorationUrls,
      ...derivedSearchUrls,
    ],
    qualifiedFreshSourceUrls: qualifiedPrioritySourceUrls({
      submittedSellerUrls: [...submittedSellerSourceVariants, ...pureFbsSellerVariants],
      derivedSearchUrls,
      prioritizeDerived: env.FLOW_B_PRIORITIZE_DERIVED_SEARCH === "1",
      derivedPriorityLimit,
    }),
    boundedDeepFreshSourceUrls: boundedEvidenceSources,
    verifiedFreshSourceUrls: verifiedPrioritySourceUrls({
      verifiedFreshUrls: [
        ...classifiedFreshUrls.verifiedSellerUrls,
        ...deepVerifiedSellerVariants,
        ...publishedSourcePages,
        ...nextPublishedDiscoveryPages,
        ...repeatedPublishedDiscoveryPageFour,
      ],
      verifiedHistoricalUrls: verifiedSellerUrls,
      derivedSearchUrls,
      prioritizeDerived: env.FLOW_B_PRIORITIZE_DERIVED_SEARCH === "1",
      derivedPriorityLimit,
    }),
  });
  const pending = interleaveSourcePortfolio(deduplicateSourceDispatchFamilies(
    prioritizedPending,
    allowlistOptions,
  ), yieldRows, {
    strictWeight: envNumber(env, "FLOW_B_SOURCE_STRICT_WEIGHT", 7),
    fbsWeight: envNumber(env, "FLOW_B_SOURCE_FBS_WEIGHT", 2),
    exploreWeight: envNumber(env, "FLOW_B_SOURCE_EXPLORE_WEIGHT", 1),
    scanRows: records,
  });
  const favoriteLog = path.join(path.dirname(outputPath), "favorite_collection.jsonl");
  const workers = Math.max(1, envNumber(env, "FLOW_B_TAB_WORKERS", 4));
  const adaptiveWorkers = sourceAdaptiveConcurrency(favoriteLog, {
    initial: workers,
    max: Math.max(workers, envNumber(env, "FLOW_B_MAX_TAB_WORKERS", 12)),
    stableWindow: sourceAdaptiveStableWindow(env),
  });
  const perSourceLinkLimit = envNumber(env, "FLOW_B_MAX_LINKS_PER_SOURCE", 24);
  const options = {
    steps: envNumber(env, "FLOW_B_MAX_SCROLL_STEPS", 24),
    ratio: envNumber(env, "FLOW_B_SCROLL_RATIO", 0.82),
    delay: envNumber(env, "FLOW_B_SCROLL_DELAY", 0.65) * 1000,
    initialWait: envNumber(env, "FLOW_B_MAOZI_INITIAL_WAIT", 8) * 1000,
    maxNoNewSteps: envNumber(env, "FLOW_B_MAX_NO_NEW_LINK_STEPS", 45),
    linkTarget: envNumber(env, "FLOW_B_SOURCE_LINK_TARGET", sourceScanLinkTarget(perSourceLinkLimit)),
  };
  const lowDeltaThreshold = envNumber(env, "FLOW_B_LOW_DELTA_THRESHOLD", 1);
  const lowDeltaBatchLimit = envNumber(env, "FLOW_B_LOW_DELTA_BATCH_LIMIT", 2);
  let lowDeltaBatches = 0;
  const maximumSourceBatches = Math.max(0, envNumber(env, "FLOW_B_MAX_SOURCE_BATCHES_PER_TRANCHE", 8));
  let completedSourceBatches = 0;
  const targetFavorites = envNumber(env, "FLOW_B_TARGET_FAVORITES", 1000);
  const attempted = await loadExcludedSkus(outputPath, env);
  records = pruneAttemptedSourceLinks(records, attempted);
  const candidateQueue = createCandidateQueue(path.join(path.dirname(outputPath), "candidate_queue.jsonl"));
  await candidateQueue.load();
  let scanActivityCount = 0;
  const candidateDrainLimit = Math.max(1, envNumber(env, "FLOW_B_CANDIDATE_QUEUE_DRAIN_LIMIT", 48));
  const candidatePerSourceDrain = Math.max(1, envNumber(env, "FLOW_B_CANDIDATE_QUEUE_PER_SOURCE_DRAIN", 6));
  const candidateBacklogTarget = Math.max(1, Math.min(
    candidateDrainLimit,
    envNumber(env, "FLOW_B_CANDIDATE_QUEUE_BACKLOG_TARGET", candidateDrainLimit),
  ));
  const pendingCandidateOptions = {
    attempted,
    perSourceLimit: candidatePerSourceDrain,
    sourceKey: (row) => sourceCollectionBlockKey(row?.source_url) || row?.source_url,
    priority: (row) => favoriteLinkPriority(row, titleFamilyScores)
      + Number(candidateSourceScores.get(sourceYieldKey(row?.source_url)) || 0),
    priorityTier: (row) => Number(candidateSourceScores.get(sourceYieldKey(row?.source_url)) || 0),
  };
  const recoveredCandidates = filterListingFbsEvidenceLinks(selectRecoveredCandidateTranche(
    candidateQueue.pending({
      ...pendingCandidateOptions,
    }),
    {
      limit: candidateDrainLimit,
      lowYieldLimit: envNumber(env, "FLOW_B_LOW_YIELD_DEFERRED_DRAIN_LIMIT", 4),
    },
  ), env.FLOW_B_REQUIRE_LISTING_FBS_EVIDENCE === "1");
  if (!pending.length && !recoveredCandidates.length) {
    return { outFile: outputPath, records: records.length, pending: 0, activity_count: 0 };
  }
  const runtime = collectionRuntimeState(favoriteLog);
  const accessController = ozonAccessControllerFor(context, env);
  const collectionPacingFile = path.join(path.dirname(outputPath), "collection_pacing.json");
  if (runtime.collectionPacingFile !== collectionPacingFile) {
    const detailPacing = favoriteDetailPacingOptions(env);
    await restoreCollectionRuntimeState(favoriteLog, collectionPacingFile, {
      minIntervalMs: detailPacing.minIntervalMs,
      maxIntervalMs: detailPacing.maxIntervalMs,
    });
    runtime.collectionPacingFile = collectionPacingFile;
  }
  emit(`favorite exclusions loaded: ${attempted.size}`);
  const maozi = await openMaoziPage(context, { forceNew: true });
  const reusablePools = await runtimeReusablePagePools(
    runtime,
    context,
    envNumber(env, "FLOW_B_PAGE_CLOSE_TIMEOUT_MS", 5_000),
  );
  const sourcePagePool = reusablePools.sourcePages;
  const favoriteWorkerPagePool = reusablePools.favoritePages;
  const collectWithCandidateQueue = async ({ links, onResult = () => {}, ...args }) => {
    const eligibleLinks = filterListingFbsEvidenceLinks(
      links,
      env.FLOW_B_REQUIRE_LISTING_FBS_EVIDENCE === "1",
    );
    const discoveries = eligibleLinks.filter((link) => {
      const href = typeof link === "string" ? link : link?.href;
      const sku = skuFromProductUrl(href);
      return sku && !attempted.has(sku);
    });
    scanActivityCount += await candidateQueue.discover(discoveries);
    const transitions = [];
    let total;
    try {
      total = await collectFavorites({
        ...args,
        links: eligibleLinks,
        attempted,
        onResult: (result) => {
          if (["favorited", "rejected", "failed"].includes(String(result?.status || ""))) {
            scanActivityCount += 1;
          }
          onResult(result);
          const transition = candidateQueueTransitionForCollectionResult(result, {
            deferMs: envNumber(env, "FLOW_B_CANDIDATE_DEFER_MS", 10 * 60_000),
          });
          if (result?.sku && transition) {
            transitions.push(candidateQueue.transition(result.sku, transition.status, transition.data));
          }
        },
        accessController,
      });
    } finally {
      await Promise.allSettled(transitions);
    }
    return total;
  };
  let keepReusablePages = true;
  let sourceCheckpointDirty = false;
  const sourceCheckpointBatchInterval = envNumber(env, "FLOW_B_SOURCE_CHECKPOINT_BATCH_INTERVAL", 4);
  try {
    await waitForContent(maozi, 15000);
    if (requiresFavoriteSession(env)) {
      await ensureMaoziLogin(maozi, { continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1" });
      await ensureMaoziPluginLogin(context, { continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1" });
    }
    let favoriteState;
    try {
      favoriteState = await readFavoriteCountWithTimeout(
        () => favoriteCount(maozi),
        envNumber(env, "FLOW_B_FAVORITE_TELEMETRY_TIMEOUT_MS", 10_000),
      );
    } catch (error) {
      emit(`favorite count telemetry unavailable at scan start; relying on authenticated token and capacity response: ${error?.message || error}`);
      favoriteState = { total: 0, authenticated: true };
    }
    if (requiresFavoriteSession(env) && !favoriteState.authenticated) throw new Error("Maozi profile token is stale or the session is not logged in");
    let favoriteBefore = favoriteState.authenticated ? favoriteState.total : null;

    const cooldownRemaining = remainingCollectionCooldown(runtime);
    if (cooldownRemaining > 0 && favoriteBefore !== null && favoriteBefore < targetFavorites) {
      const cooldownFallbackLinks = cachedExactFbsFallbackLinks(records, {
        attempted,
        limit: envNumber(env, "FLOW_B_COOLDOWN_FBS_FALLBACK_LINKS", 24),
        familyScores: titleFamilyScores,
        yieldRows,
        requireReusableFacts: true,
      });
      if (cooldownFallbackLinks.length > 0) {
        const queued = await candidateQueue.discover(cooldownFallbackLinks.filter((link) => {
          const sku = skuFromProductUrl(link?.href);
          return sku && !attempted.has(sku);
        }));
        scanActivityCount += queued;
        emit(`Ozon detail cooldown queue-only cached=${queued} remaining=${cooldownRemaining}ms`);
      }
      const readyCandidateCount = candidateQueue.pending({
        ...pendingCandidateOptions,
        limit: candidateBacklogTarget,
      }).length;
      if (!shouldScanSourcesDuringDetailCooldown({
        cooldownRemainingMs: cooldownRemaining,
        readyCandidateCount,
        backlogTarget: candidateBacklogTarget,
        quietWindowMs: envNumber(env, "FLOW_B_DETAIL_COOLDOWN_SOURCE_QUIET_MS", 90_000),
      })) {
        emit(`Ozon cooldown source quiet ready=${readyCandidateCount} remaining=${cooldownRemaining}ms`);
        return {
          outFile: outputPath,
          records: records.length,
          pending: pending.length,
          candidate_backlog: readyCandidateCount,
          cooldown_remaining_ms: cooldownRemaining,
          activity_count: scanActivityCount,
        };
      }
    }

    if (remainingCollectionCooldown(runtime) === 0
      && favoriteBefore !== null && favoriteBefore < targetFavorites && recoveredCandidates.length) {
      emit(`resuming ${recoveredCandidates.length} persisted product candidates`);
      favoriteBefore = await collectWithCandidateQueue({
        context,
        maozi,
        links: recoveredCandidates,
        target: targetFavorites,
        currentTotal: favoriteBefore,
        env,
        logFile: favoriteLog,
        log: emit,
        familyScores: titleFamilyScores,
        productiveSourceSampleKeys,
        workerPagePool: favoriteWorkerPagePool,
      });
    }

    if (remainingCollectionCooldown(runtime) === 0
      && favoriteBefore !== null && favoriteBefore < targetFavorites && records.length) {
      const baseLinkLimit = perSourceLinkLimit;
      const retainedRows = orderRowsBySourceYield(retainedRowsForCollection(records, {
        skipRetained: env.FLOW_B_SKIP_RETAINED === "1",
        provenOnly: env.FLOW_B_RETAINED_PROVEN_ONLY === "1",
        highYieldSources,
        yieldRows,
      }), yieldRows);
      const retainedCandidates = limitLinksPerSource(
        retainedRows,
        envNumber(env, "FLOW_B_RETAINED_LINKS_PER_SOURCE", baseLinkLimit * 4),
        titleFamilyScores,
      );
      const retainedLinks = [];
      const retainedSkus = new Set();
      const retainedLimit = retainedReplayLimit(env);
      if (retainedLimit > 0) {
        for (const link of retainedCandidates) {
          const sku = skuFromProductUrl(link?.href);
          if (!sku || attempted.has(sku) || retainedSkus.has(sku)) continue;
          retainedSkus.add(sku);
          retainedLinks.push(link);
          if (retainedLinks.length >= retainedLimit) break;
        }
      }
      const fallbackLimit = envNumber(env, "FLOW_B_CACHED_FBS_FALLBACK_LINKS", 24);
      if (retainedLinks.length < fallbackLimit) {
        const filled = fillRetainedFallbackLinks(retainedLinks, cachedExactFbsFallbackLinks(records, {
          attempted,
          limit: fallbackLimit,
          familyScores: titleFamilyScores,
          yieldRows,
        }), fallbackLimit);
        retainedLinks.splice(0, retainedLinks.length, ...filled);
      }
      retainedLinks.splice(
        0,
        retainedLinks.length,
        ...filterCandidateCooldownLinks(retainedLinks, candidateQueue),
      );
      emit(`collecting favorites from ${retainedLinks.length} retained product links`);
      let retainedAttempted = 0;
      let retainedFavorited = 0;
      favoriteBefore = await collectWithCandidateQueue({
        context,
        maozi,
        links: retainedLinks,
        target: targetFavorites,
        currentTotal: favoriteBefore,
        env,
        attempted,
        logFile: favoriteLog,
        log: emit,
        familyScores: titleFamilyScores,
        productiveSourceSampleKeys,
        workerPagePool: favoriteWorkerPagePool,
        onResult: (result) => {
          if (result.sku) retainedAttempted += 1;
          if (result.status === "favorited") retainedFavorited += 1;
        },
      });
      if (shouldYieldAfterRetained({
        retainedLinks: retainedLinks.length,
        retainedAttempted,
        retainedFavorited,
        pendingSources: pending.length,
      })) {
        return {
          outFile: outputPath,
          records: records.length,
          pending: pending.length,
          retained_attempted: retainedLinks.length,
          retained_favorited: retainedFavorited,
          activity_count: scanActivityCount,
        };
      }
    }

    const sourceScanTimeout = envNumber(env, "FLOW_B_SOURCE_SCAN_TIMEOUT_MS", 90_000);
    const pageCloseTimeout = envNumber(env, "FLOW_B_PAGE_CLOSE_TIMEOUT_MS", 5_000);
    const startSourceBatch = (start, concurrency = adaptiveWorkers.current) => {
      const batch = pending.slice(start, start + Math.max(1, Number(concurrency) || 1));
      const nextStart = start + batch.length;
      emit(`batch ${start + 1}-${nextStart} / ${pending.length} concurrency=${batch.length}`);
      const rowsPromise = Promise.all(batch.map((url, index) => scanSourceWithPage({
        context,
        url,
        options: {
          ...options,
          linkTarget: String(env.FLOW_B_SOURCE_LINK_TARGET || "").trim()
            ? options.linkTarget
            : sourceScanLinkTargetForSource(url, {
              perSourceLimit: perSourceLinkLimit,
              boundedDeepUrls: boundedEvidenceSourceKeys,
            }),
        },
        timeoutMs: sourceScanTimeout,
        closeTimeoutMs: pageCloseTimeout,
        pagePool: sourcePagePool,
        pageIndex: index,
        accessController,
      }).catch((error) => {
        if (isOzonAccessStoppedError(error)) throw error;
        return {
          source_url: url,
          blocked: false,
          stop_reason: `error: ${error.message}`,
          links: [],
          cumulative_product_link_count: 0,
        };
      })));
      return { batch, nextStart, rowsPromise };
    };
    let prefetchedBatch = null;
    for (let start = 0; prefetchedBatch || start < pending.length;) {
      if (isCollectionDeadlineReached(env)) break;
      if (favoriteBefore !== null && favoriteBefore >= targetFavorites) break;
      const loopCooldownRemaining = remainingCollectionCooldown(runtime);
      if (loopCooldownRemaining > 0) {
        const readyCandidateCount = candidateQueue.pending({
          ...pendingCandidateOptions,
          limit: candidateBacklogTarget,
        }).length;
        if (!shouldScanSourcesDuringDetailCooldown({
          cooldownRemainingMs: loopCooldownRemaining,
          readyCandidateCount,
          backlogTarget: candidateBacklogTarget,
          quietWindowMs: envNumber(env, "FLOW_B_DETAIL_COOLDOWN_SOURCE_QUIET_MS", 90_000),
        })) break;
      }
      const batchWork = prefetchedBatch || startSourceBatch(start);
      prefetchedBatch = null;
      const batch = batchWork.batch;
      start = batchWork.nextStart;
      const batchFavoriteBefore = favoriteBefore;
      const batchRows = await batchWork.rowsPromise;
      const fatalBatchError = fatalSourceBatchError(batchRows);
      if (fatalBatchError) throw fatalBatchError;
      completedSourceBatches += 1;
      const previousSourceCooldownState = [
        runtime.sourceSoftBlockStreak,
        runtime.lastSourceSoftBlockAt,
        runtime.detailBlockedUntil,
      ];
      const sourceCooldown = sourceBatchCooldownState(batchRows, runtime);
      const currentSourceCooldownState = [
        runtime.sourceSoftBlockStreak,
        runtime.lastSourceSoftBlockAt,
        runtime.detailBlockedUntil,
      ];
      if (previousSourceCooldownState.some((value, index) => value !== currentSourceCooldownState[index])) {
        await queueCollectionRuntimeStatePersist(collectionPacingFile, runtime);
      }
      if (sourceCooldown.blocked && !isCollectionDeadlineReached(env)) {
        emit(`source soft block cooldown defer=${sourceCooldown.delay}ms`);
      }
      for (const row of batchRows) {
        if (row.blocked || /soft block|access denied|captcha|timeout|error:/i.test(String(row.stop_reason || ""))) {
          adaptiveWorkers.recordFailure(new Error(row.stop_reason || "soft block"));
        } else {
          adaptiveWorkers.recordSuccess();
        }
      }
      if (sourceBatchPrefetchAllowed({
        sourceBlocked: sourceCooldown.blocked,
        deadlineReached: isCollectionDeadlineReached(env),
        completedBatches: completedSourceBatches,
        maximumBatches: maximumSourceBatches,
        remainingSources: pending.length - start,
      })) {
        prefetchedBatch = startSourceBatch(start);
        start = prefetchedBatch.nextStart;
      }
      const collectionLinks = limitLinksPerSource(
        batchRows.map((row, index) => ({ ...row, source_url: batch[index] })),
        perSourceLinkLimit,
        titleFamilyScores,
      );
      const requireListingFbsEvidence = env.FLOW_B_REQUIRE_LISTING_FBS_EVIDENCE === "1";
      const eligibleCollectionLinks = filterListingFbsEvidenceLinks(
        collectionLinks,
        requireListingFbsEvidence,
      );
      const eligibleCounts = eligibleLinkCountsBySource(collectionLinks, attempted, {
        requireListingFbsEvidence,
      });
      const collectionMode = sourceBatchCollectionMode({
        favoriteTotal: favoriteBefore,
        target: targetFavorites,
        cooldownRemainingMs: remainingCollectionCooldown(runtime),
        sourceBlocked: sourceCooldown.blocked,
      });
      if (collectionMode === "queue-only") {
        const queued = await candidateQueue.discover(eligibleCollectionLinks.filter((link) => {
          const sku = skuFromProductUrl(link?.href);
          return sku && !attempted.has(sku);
        }));
        scanActivityCount += queued;
        if (queued > 0) emit(`queued ${queued} source candidates without detail during cooldown`);
      } else if (collectionMode === "collect") {
        let collectionSoftBlocked = false;
        let batchFavorited = 0;
        favoriteBefore = await collectWithCandidateQueue({
          context,
          maozi,
          links: collectionLinks,
          target: targetFavorites,
          currentTotal: favoriteBefore,
          env,
          attempted,
          logFile: favoriteLog,
          log: emit,
          familyScores: titleFamilyScores,
          productiveSourceSampleKeys,
          workerPagePool: favoriteWorkerPagePool,
          onResult: (result) => {
            if (result.status === "favorited") batchFavorited += 1;
            if (result.status === "failed" && /soft blocked|access denied|captcha|timeout|failed to fetch|network|HTTP 0/i.test(String(result.error?.message || result.error || ""))) {
              collectionSoftBlocked = true;
            }
          },
        });
        if (collectionSoftBlocked) adaptiveWorkers.recordFailure(new Error("Ozon collection soft blocked"));
        if (lowDeltaBatchLimit > 0) {
          lowDeltaBatches = nextLowYieldBatchStreak({
            current: lowDeltaBatches,
            favorited: batchFavorited,
            threshold: lowDeltaThreshold,
          });
        }
      }
      const afterWait = sourceCooldown.blocked ? 0 : sourceAfterScanWaitMs(
        env,
        runtime,
        Math.max(0, collectionDeadlineMs(env) - Date.now()),
      );
      if (afterWait) await sleep(afterWait);
      let observedFavoriteAfter = favoriteBefore;
      try {
        favoriteState = await readFavoriteCountWithTimeout(
          () => favoriteCount(maozi),
          envNumber(env, "FLOW_B_FAVORITE_TELEMETRY_TIMEOUT_MS", 10_000),
        );
        observedFavoriteAfter = favoriteState.authenticated ? favoriteState.total : null;
      } catch (error) {
        emit(`favorite count telemetry unavailable; retaining claimed total ${favoriteBefore}: ${error?.message || error}`);
      }
      const favoriteAfter = effectiveFavoriteTotal({
        claimedTotal: favoriteBefore,
        observedTotal: observedFavoriteAfter,
        target: targetFavorites,
      });
      const delta = batchFavoriteBefore !== null && favoriteAfter !== null ? favoriteAfter - batchFavoriteBefore : null;
      const scannedAt = new Date().toISOString();
      records.push(...batchRows.map((row, index) => ({
        source_url: batch[index],
        ...row,
        scanned_at: scannedAt,
        eligible_link_count_before_collection: eligibleCounts
          ? (eligibleCounts.get(sourceNonFbsSampleKey(batch[index])) || 0)
          : null,
        favorite_count_before: batchFavoriteBefore,
        favorite_count_after: favoriteAfter,
        favorite_count_delta: delta,
      })));
      sourceCheckpointDirty = true;
      if (shouldWriteSourceCheckpoint(completedSourceBatches, sourceCheckpointBatchInterval)) {
        await writeJsonArrayCached(outputPath, records);
        sourceCheckpointDirty = false;
      }
      emit(`favorite ${batchFavoriteBefore} -> ${favoriteAfter} delta=${delta}`);
      favoriteBefore = favoriteAfter;
      if (sourceCooldown.blocked) break;
      if (favoriteAfter !== null && favoriteAfter >= targetFavorites) break;
      if (lowDeltaBatchLimit > 0 && lowDeltaBatches >= lowDeltaBatchLimit) break;
      if (shouldYieldForSourceFeedback({
        completedBatches: completedSourceBatches,
        maximumBatches: maximumSourceBatches,
        pendingSources: pending.length - start,
      })) {
        emit(`yielding source tranche after ${completedSourceBatches} batches for fresh publish feedback`);
        break;
      }
    }
    if (prefetchedBatch) {
      const prefetchedRows = await prefetchedBatch.rowsPromise;
      const fatalPrefetchError = fatalSourceBatchError(prefetchedRows);
      if (fatalPrefetchError) throw fatalPrefetchError;
      const prefetchedLinks = limitLinksPerSource(
        prefetchedRows.map((row, index) => ({ ...row, source_url: prefetchedBatch.batch[index] })),
        perSourceLinkLimit,
        titleFamilyScores,
      );
      const requireListingFbsEvidence = env.FLOW_B_REQUIRE_LISTING_FBS_EVIDENCE === "1";
      const eligiblePrefetchedLinks = filterListingFbsEvidenceLinks(
        prefetchedLinks,
        requireListingFbsEvidence,
      );
      const queued = await candidateQueue.discover(eligiblePrefetchedLinks.filter((link) => {
        const sku = skuFromProductUrl(link?.href);
        return sku && !attempted.has(sku);
      }));
      scanActivityCount += queued;
      const eligibleCounts = eligibleLinkCountsBySource(prefetchedLinks, attempted, {
        requireListingFbsEvidence,
      });
      const scannedAt = new Date().toISOString();
      records.push(...prefetchedRows.map((row, index) => ({
        source_url: prefetchedBatch.batch[index],
        ...row,
        scanned_at: scannedAt,
        eligible_link_count_before_collection: eligibleCounts.get(
          sourceNonFbsSampleKey(prefetchedBatch.batch[index]),
        ) || 0,
        favorite_count_before: favoriteBefore,
        favorite_count_after: favoriteBefore,
        favorite_count_delta: 0,
        collection_deferred_to_candidate_queue: true,
      })));
      completedSourceBatches += 1;
      sourceCheckpointDirty = true;
      emit(`persisted lookahead batch candidates=${queued} for the next consumer tranche`);
    }
    return {
      outFile: outputPath,
      records: records.length,
      pending: pending.length,
      activity_count: scanActivityCount,
    };
  } catch (error) {
    keepReusablePages = false;
    throw error;
  } finally {
    try {
      if (sourceCheckpointDirty) await writeJsonArrayCached(outputPath, records);
    } finally {
      if (!keepReusablePages || isCollectionDeadlineReached(env)) {
        await closeRuntimeReusablePagePools(
          runtime,
          envNumber(env, "FLOW_B_PAGE_CLOSE_TIMEOUT_MS", 5_000),
        );
      }
      await maozi.close().catch(() => {});
    }
  }
}
