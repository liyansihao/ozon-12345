import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  isReliable1688CostSource,
  verifyReturnedSameItemEvidence,
} from "./cost-evidence.mjs";
import { createJsonLineWorkerPool } from "./json-line-worker-pool.mjs";

function lineValue(text, label) {
  const match = String(text || "").match(new RegExp(`^${label}\\s+(.+)$`, "m"));
  return match?.[1]?.trim() || "";
}

export function compactCostOutput(text) {
  return ["SAME_ITEM_EVIDENCE", "MATCH_EVIDENCE_KEY", "COST_SOURCE", "REASON", "FILTERED_FIRST_PAGE_PRICES", "P70_COST"]
    .map((label) => [label, lineValue(text, label)])
    .filter(([, value]) => value !== "")
    .map(([label, value]) => `${label} ${value}`)
    .join("\n");
}

function compactTerminalCostOutput(text, reason) {
  const compact = compactCostOutput(text);
  if (compact) return compact;
  const safeReason = String(reason || "cached terminal 1688 failure")
    .replace(/\s+/g, " ")
    .trim();
  return `REASON ${safeReason || "cached terminal 1688 failure"}\nP70_COST None`;
}

function parsePrices(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    const match = String(value || "").match(/^\[([^\]]*)\]$/);
    if (!match) return [];
    const parts = match[1].split(",").map((part) => part.trim()).filter(Boolean);
    const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
    if (!parts.length || parts.some((part) => !numeric.test(part))) return [];
    const prices = parts.map(Number);
    return prices.every(Number.isFinite) ? prices : [];
  }
}

export function parseCostOutput(text, sellPrice, {
  expectedMatchEvidence = null,
  requireSameItemEvidence = false,
} = {}) {
  const cost = Number(lineValue(text, "P70_COST"));
  const source = lineValue(text, "COST_SOURCE");
  const matchEvidenceKey = lineValue(text, "MATCH_EVIDENCE_KEY");
  const encodedSameItemEvidence = lineValue(text, "SAME_ITEM_EVIDENCE");
  const prices = parsePrices(lineValue(text, "FILTERED_FIRST_PAGE_PRICES"));
  const sale = Number(sellPrice);
  const explicitReason = lineValue(text, "REASON");

  if (!Number.isFinite(cost) || cost <= 0) return { ok: false, reason: explicitReason || "missing or invalid P70 cost" };
  if (!isReliable1688CostSource(source)) return { ok: false, reason: `unreliable cost source: ${source || "missing"}` };
  if (prices.length < 3) return { ok: false, reason: `filtered first-page insufficient ${prices.length}` };
  if (prices.some((price) => !Number.isFinite(price) || price <= 0)) return { ok: false, reason: "invalid filtered first-page prices" };
  if (source === "search_first_page_p70_similarity_filtered" && Math.max(...prices) / Math.min(...prices) > 5) {
    return { ok: false, reason: "filtered first-page price spread greater than five" };
  }
  if (!Number.isFinite(sale) || sale <= 0) return { ok: false, reason: "invalid sale price" };
  if (cost < sale * 0.02) return { ok: false, reason: "1688 cost below 2% of sale price is not reliable" };
  if (cost >= sale * 0.85) return { ok: false, reason: "1688 cost is at least 85% of sale price" };
  const sameItemProof = verifyReturnedSameItemEvidence({
    encodedEvidence: encodedSameItemEvidence,
    evidenceKey: matchEvidenceKey,
    expectedRequest: expectedMatchEvidence,
    filteredPrices: prices,
    costSource: source,
    selectedCost: cost,
  });
  if (requireSameItemEvidence && !sameItemProof.ok) {
    return { ok: false, reason: `same-item evidence rejected: ${sameItemProof.reason}` };
  }
  return {
    ok: true,
    cost,
    source,
    prices,
    ...(sameItemProof.ok ? {
      match_evidence_key: matchEvidenceKey,
      same_item_match: true,
      returned_evidence_verified: true,
      match_evidence_contract: sameItemProof.contract,
      matched_offer_count: sameItemProof.matched_offer_count,
    } : {}),
  };
}

function safeSku(value) {
  const sku = String(value ?? "").trim();
  if (!sku || sku.length > 128 || sku === "." || sku === ".." || !/^[A-Za-z0-9._-]+$/.test(sku)) {
    throw Object.assign(new Error("unsafe SKU; path traversal is not allowed"), { code: "invalid-sku" });
  }
  return sku;
}

async function defaultDownload(url, destinationPath, { timeout = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeout) || 15_000));
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`image download HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error("downloaded image is empty");
    await fs.writeFile(destinationPath, bytes);
  } finally {
    clearTimeout(timer);
  }
}

function isTransientDownloadError(error) {
  const message = String(error?.message || error || "");
  const status = Number(message.match(/HTTP\s+(\d{3})/i)?.[1]);
  if (status > 0) return [408, 425, 429].includes(status) || status >= 500;
  return /aborted|aborterror|timed?\s*out|timeout|econnreset|econnrefused|enotfound|eai_again|network|socket/i.test(message)
    || ["ABORT_ERR", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(String(error?.code || "").toUpperCase());
}

function isTransient1688TransportFailure(result, combinedOutput) {
  if (Number(result?.code) !== 1) return false;
  const text = `${String(combinedOutput || "")}\n${String(result?.stderr || "")}`;
  return /unexpected_eof_while_reading|eof occurred in violation of protocol|sslerror|connection(?:error| reset)|remote end closed|failed to resolve|name or service not known|timed?\s*out|timeout/i.test(text);
}

function defaultRunProcess({ command, args, cwd, timeout = 90000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Object.assign(new Error(`1688 process timed out after ${timeout}ms`), {
        code: "process-timeout",
        stdout,
        stderr,
      }));
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(Object.assign(error, { stdout, stderr }));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function readableFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export function createCostBridge({
  python = "python3",
  scriptPath = path.resolve(import.meta.dirname, "../1688_image_median.py"),
  runProcess = defaultRunProcess,
  download = defaultDownload,
  sharedCachePath = null,
  seedCacheFiles = [],
  workerPool = null,
  workerScriptPath = path.resolve(import.meta.dirname, "../flow_b_1688_worker.py"),
  workerCount = Number(process.env.FLOW_B_1688_WORKERS || 4),
  createWorkerPool = createJsonLineWorkerPool,
  healthFailureThreshold = Number(process.env.FLOW_B_1688_HEALTH_FAILURE_THRESHOLD || 5),
  healthDeferredTtlMs = Number(process.env.FLOW_B_1688_HEALTH_DEFERRED_TTL_MS || 300_000),
  healthProbeBackoffMs = Number(process.env.FLOW_B_1688_HEALTH_PROBE_BACKOFF_MS || 30_000),
  healthSkuRetryLimit = Number(process.env.FLOW_B_1688_HEALTH_SKU_RETRY_LIMIT || 1),
  now = () => Date.now(),
  downloadAttempts = 3,
  downloadTimeoutMs = 15_000,
  sleep: wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const inFlight = new Map();
  const cacheByRun = new Map();
  const crossRunKeysByRun = new Map();
  let cacheWriteChain = Promise.resolve();
  let ownedWorkerPool = null;
  let persistentWorkersDisabled = process.env.FLOW_B_1688_PERSISTENT_POOL === "0";
  const health = {
    circuit: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    nextProbeAt: 0,
    probeInFlight: false,
    reason: null,
  };

  function matchEvidence(item) {
    const value = (candidate) => String(candidate ?? "").replace(/\s+/g, " ").trim();
    return {
      expect_title: value(item?.expect_title || item?.title),
      expect_model: value(item?.expect_model || item?.model || item?.model_name || item?.article),
      expect_category: value(item?.expect_category || item?.category_name || item?.cate_name),
    };
  }

  function parseOptions(item) {
    const expectedMatchEvidence = matchEvidence(item);
    return {
      expectedMatchEvidence,
      requireSameItemEvidence: Object.values(expectedMatchEvidence).some(Boolean),
    };
  }

  function isCandidateCollapse(result) {
    const reason = String(result?.reason || result?.error?.message || "");
    return /filtered[ -]first[ -]page(?:\s+1688)?\s+candidates?\s+fewer\s+than\s+3/i.test(reason);
  }

  function healthMetadata(extra = {}) {
    return {
      circuit: health.circuit,
      consecutive_failures: health.consecutiveFailures,
      reason: health.reason || "1688-first-page-candidate-collapse",
      opened_at: health.openedAt,
      next_probe_at: health.nextProbeAt > 0 ? new Date(health.nextProbeAt).toISOString() : null,
      ...extra,
    };
  }

  async function rebuildOwnedWorkerPool() {
    if (!ownedWorkerPool) return;
    const stale = ownedWorkerPool;
    ownedWorkerPool = null;
    await stale.close().catch(() => {});
  }

  async function downloadImage(url, destinationPath) {
    const attempts = Math.max(1, Number(downloadAttempts) || 1);
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await download(url, destinationPath, { timeout: Math.max(1_000, Number(downloadTimeoutMs) || 15_000) });
        return;
      } catch (error) {
        lastError = error;
        if (!isTransientDownloadError(error) || attempt + 1 >= attempts) throw error;
        await wait(500 * (attempt + 1));
      }
    }
    throw lastError;
  }

  function activeWorkerPool() {
    if (persistentWorkersDisabled) return null;
    if (workerPool) return workerPool;
    if (runProcess !== defaultRunProcess && createWorkerPool === createJsonLineWorkerPool) return null;
    if (!ownedWorkerPool) {
      ownedWorkerPool = createWorkerPool({
        command: python,
        args: ["-u", path.resolve(workerScriptPath), "--script", path.resolve(scriptPath)],
        size: Math.max(1, Number(workerCount) || 1),
      });
    }
    return ownedWorkerPool;
  }

  async function run1688Process(imagePath, timeout, item) {
    const healthProbe = health.circuit === "open";
    const evidence = matchEvidence(item);
    const pool = activeWorkerPool();
    if (pool) {
      try {
        const result = await pool.run({ image: String(imagePath), ...evidence }, timeout);
        return { ...result, health_probe: healthProbe };
      } catch (error) {
        if (error?.code === "worker-timeout") throw error;
        persistentWorkersDisabled = true;
        if (ownedWorkerPool) {
          await ownedWorkerPool.close().catch(() => {});
          ownedWorkerPool = null;
        }
      }
    }
    const evidenceArgs = [];
    for (const [flag, key] of [
      ["--expect-title", "expect_title"],
      ["--expect-model", "expect_model"],
      ["--expect-category", "expect_category"],
    ]) {
      if (evidence[key]) evidenceArgs.push(flag, evidence[key]);
    }
    const result = await runProcess({
      command: python,
      args: [path.resolve(scriptPath), imagePath, ...evidenceArgs],
      cwd: path.resolve(process.cwd()),
      timeout,
    });
    return { ...result, health_probe: healthProbe };
  }

  function cacheKey(item) {
    const imageUrl = String(item?.cover_image || "").trim();
    if (!imageUrl) return null;
    const evidence = matchEvidence(item);
    const hasEvidence = Object.values(evidence).some(Boolean);
    const payload = hasEvidence ? JSON.stringify({ version: 3, image_url: imageUrl, ...evidence }) : imageUrl;
    return crypto.createHash("sha256").update(payload).digest("hex");
  }

  async function loadCache(runDir) {
    const root = path.resolve(runDir);
    if (cacheByRun.has(root)) return cacheByRun.get(root);
    async function readEntries(filename) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.resolve(filename), "utf8"));
        if (!parsed?.entries || typeof parsed.entries !== "object") return {};
        return Object.fromEntries(Object.entries(parsed.entries).map(([key, entry]) => [key, {
          ...entry,
          output: entry?.terminal
            ? compactTerminalCostOutput(entry?.output)
            : compactCostOutput(entry?.output),
        }]));
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        return {};
      }
    }
    const runEntries = await readEntries(path.join(root, "1688_cache.json"));
    const crossRunEntries = {};
    for (const filename of [sharedCachePath, ...seedCacheFiles].filter(Boolean)) {
      Object.assign(crossRunEntries, await readEntries(filename));
    }
    const cache = { version: 1, entries: { ...crossRunEntries, ...runEntries } };
    crossRunKeysByRun.set(root, new Set(Object.keys(crossRunEntries).filter((key) => !(key in runEntries))));
    cacheByRun.set(root, cache);
    return cache;
  }

  function saveCache(runDir, cache) {
    const operation = cacheWriteChain.then(async () => {
      const filenames = [path.join(path.resolve(runDir), "1688_cache.json"), sharedCachePath]
        .filter(Boolean)
        .map((filename) => path.resolve(filename));
      for (const filename of new Set(filenames)) {
        const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(temporary, `${JSON.stringify(cache)}\n`, "utf8");
        await fs.rename(temporary, filename);
      }
    });
    cacheWriteChain = operation.catch(() => {});
    return operation;
  }

  async function estimateUncached(item, runDir) {
      let sku;
      try {
        sku = safeSku(item?.sku);
      } catch (error) {
        return { ok: false, error: { code: error.code || "invalid-sku", message: error.message } };
      }

      const root = path.resolve(runDir);
      const imageDir = path.join(root, "images");
      const outputDir = path.join(root, "1688");
      const imagePath = path.join(imageDir, `${sku}.jpg`);
      const outputPath = path.join(outputDir, `${sku}.out`);
      let processStarted = false;

      try {
        await fs.mkdir(imageDir, { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });

        if (await readableFile(outputPath)) {
          const cachedText = await fs.readFile(outputPath, "utf8");
          if (/^P70_COST\s+/m.test(cachedText)) {
            const cached = parseCostOutput(cachedText, item?.sell_price, parseOptions(item));
            if (cached.ok) return { ...cached, cached: true, outputPath };
          }
        }

        if (!(await readableFile(imagePath))) {
          const imageUrl = String(item?.cover_image || "").trim();
          if (!/^https?:\/\//i.test(imageUrl)) throw Object.assign(new Error("valid cover image URL is required"), { code: "invalid-cover-image" });
          await downloadImage(imageUrl, imagePath);
          if (!(await readableFile(imagePath))) throw Object.assign(new Error("cover image download produced no file"), { code: "empty-image" });
        }

        processStarted = true;
        const result = await run1688Process(
          imagePath,
          Number(process.env.FLOW_B_1688_ITEM_TIMEOUT || 90) * 1000,
          item,
        );
        const stdout = String(result?.stdout || "");
        const stderr = String(result?.stderr || "");
        const combined = `${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`;
        await fs.writeFile(outputPath, combined, "utf8");
        if (Number(result?.code) !== 0) {
          const parsed = parseCostOutput(combined, item?.sell_price, parseOptions(item));
          const transportError = isTransient1688TransportFailure(result, combined);
          return {
            ok: false,
            reason: transportError
              ? "1688 transient transport failure"
              : lineValue(combined, "REASON") || parsed.reason || `1688 process exited ${result?.code}`,
            process_code: Number(result?.code),
            transport_error: transportError,
            retry_count: Number(result?.retry_count) || Number(lineValue(combined, "TRANSIENT_RETRY_COUNT")) || 0,
            outputPath,
            health_probe: result?.health_probe === true,
          };
        }
        return {
          ...parseCostOutput(combined, item?.sell_price, parseOptions(item)),
          process_code: 0,
          cached: false,
          outputPath,
          health_probe: result?.health_probe === true,
        };
      } catch (error) {
        if (processStarted) {
          const evidence = [
            String(error?.stdout || ""),
            "STDERR:",
            String(error?.stderr || ""),
            "ERROR:",
            String(error?.message || error),
          ].join("\n");
          await fs.writeFile(outputPath, evidence, "utf8").catch(() => {});
        }
        return {
          ok: false,
          error: { code: error?.code || "cost-estimate-failed", message: String(error?.message || error) },
          outputPath,
        };
      }
  }

  async function estimate(item, runDir) {
    const key = cacheKey(item);
    if (!key) return estimateUncached(item, runDir);
    const root = path.resolve(runDir);
    const compositeKey = `${root}:${key}`;
    const cache = await loadCache(root);
    const cached = cache.entries[key];
    const cachedHealthRetryCount = Math.max(0, Number(cached?.health_retry_count) || 0);
    if (cached?.output) {
      const parsed = parseCostOutput(cached.output, item?.sell_price, parseOptions(item));
      const legacyCandidateCollapse = cached.terminal === true
        && cached.deferred !== true
        && isCandidateCollapse({ ...parsed, reason: cached.reason || parsed.reason });
      const legacyTransportFailure = cached.terminal === true && Number(cached.process_code) === 1;
      const expiresAt = Date.parse(String(cached.expires_at || ""));
      if (!legacyCandidateCollapse && !legacyTransportFailure && cached.deferred && Number.isFinite(expiresAt) && expiresAt > now()) {
        return {
          ...parsed,
          reason: cached.reason || parsed.reason,
          deferred: true,
          terminal: false,
          retry_at: cached.expires_at,
          health: cached.health || healthMetadata(),
          process_code: Number.isFinite(Number(cached.process_code)) ? Number(cached.process_code) : undefined,
          transport_error: cached.transport_error === true,
          retry_count: Number(cached.retry_count) || 0,
          cached: true,
          shared_cache: true,
          cross_run_cache: crossRunKeysByRun.get(root)?.has(key) === true,
          cache_key: key,
        };
      }
      if (!legacyCandidateCollapse && !legacyTransportFailure && (parsed.ok || cached.terminal)) {
        return {
          ...parsed,
          process_code: Number.isFinite(Number(cached.process_code)) ? Number(cached.process_code) : undefined,
          cached: true,
          shared_cache: true,
          cross_run_cache: crossRunKeysByRun.get(root)?.has(key) === true,
          cache_key: key,
        };
      }
    }
    if (inFlight.has(compositeKey)) {
      const result = await inFlight.get(compositeKey);
      return { ...result, shared_cache: true, cache_key: key };
    }
    let isHealthProbe = false;
    if (health.circuit === "open") {
      const probeBackoff = Math.max(0, Number(healthProbeBackoffMs) || 0);
      if (health.probeInFlight || now() < health.nextProbeAt) {
        const retryAtMs = Math.max(health.nextProbeAt, now() + probeBackoff, now() + 1);
        return {
          ok: false,
          reason: "1688 health circuit backoff",
          deferred: true,
          terminal: false,
          retry_at: new Date(retryAtMs).toISOString(),
          health: healthMetadata({
            probe_blocked: !health.probeInFlight,
            probe_in_flight: health.probeInFlight,
          }),
          shared_cache: false,
          cache_key: key,
        };
      }
      health.probeInFlight = true;
      isHealthProbe = true;
    }
    const operation = (async () => {
      let result;
      let healthRetryCount = cachedHealthRetryCount;
      try {
        result = await estimateUncached(item, root);
        if (isCandidateCollapse(result) || result?.transport_error === true) {
          const transportFailure = result?.transport_error === true;
          health.reason = transportFailure
            ? "1688-transient-transport-failure"
            : "1688-first-page-candidate-collapse";
          healthRetryCount += 1;
          health.consecutiveFailures += 1;
          const thresholdReached = health.consecutiveFailures >= Math.max(1, Number(healthFailureThreshold) || 1);
          if (thresholdReached || isHealthProbe) {
            const wasOpen = health.circuit === "open";
            health.circuit = "open";
            health.openedAt ||= new Date(now()).toISOString();
            health.nextProbeAt = now() + Math.max(0, Number(healthProbeBackoffMs) || 0);
            if (!wasOpen || isHealthProbe) await rebuildOwnedWorkerPool();
          }
          const isolatedRetryExhausted = !transportFailure
            && health.circuit !== "open"
            && healthRetryCount > Math.max(0, Number(healthSkuRetryLimit) || 0);
          if (isolatedRetryExhausted) {
            result = { ...result, terminal: true, health_retry_count: healthRetryCount, health: healthMetadata() };
          } else {
            const delay = health.circuit === "open"
              ? Math.max(health.nextProbeAt - now(), 1)
              : Math.max(1, Number(healthDeferredTtlMs) || 1);
            result = {
              ...result,
              deferred: true,
              terminal: false,
              retry_at: new Date(now() + delay).toISOString(),
              health_retry_count: healthRetryCount,
              health: healthMetadata(),
            };
          }
        } else if (result?.ok) {
          const recovered = isHealthProbe && health.circuit === "open";
          health.circuit = "closed";
          health.consecutiveFailures = 0;
          health.openedAt = null;
          health.nextProbeAt = 0;
          health.reason = null;
          result = {
            ...result,
            health_retry_count: 0,
            health: healthMetadata(recovered ? { recovered: true } : {}),
          };
        } else if (isHealthProbe) {
          health.nextProbeAt = now() + Math.max(0, Number(healthProbeBackoffMs) || 0);
          await rebuildOwnedWorkerPool();
          result = {
            ...result,
            deferred: true,
            terminal: false,
            retry_at: new Date(Math.max(health.nextProbeAt, now() + 1)).toISOString(),
            health_retry_count: healthRetryCount,
            health: healthMetadata(),
          };
        } else {
          health.consecutiveFailures = 0;
          health.reason = null;
        }
      } finally {
        if (isHealthProbe) health.probeInFlight = false;
      }
      if (result?.outputPath && (result?.ok || result?.reason)) {
        const output = await fs.readFile(result.outputPath, "utf8");
        cache.entries[key] = {
          output: compactTerminalCostOutput(output, result.reason),
          terminal: result.deferred !== true,
          deferred: result.deferred === true,
          expires_at: result.retry_at,
          reason: result.reason,
          health: result.health,
          health_retry_count: result.health_retry_count,
          process_code: result.process_code,
          transport_error: result.transport_error === true,
          retry_count: Number(result.retry_count) || 0,
          source_image: String(item.cover_image),
          updated_at: new Date().toISOString(),
        };
        crossRunKeysByRun.get(root)?.delete(key);
        await saveCache(root, cache);
      }
      return { ...result, shared_cache: false, cache_key: key };
    })();
    inFlight.set(compositeKey, operation);
    try {
      return await operation;
    } finally {
      inFlight.delete(compositeKey);
    }
  }

  return {
    estimate,
    async close() {
      await workerPool?.close?.().catch(() => {});
      await ownedWorkerPool?.close?.().catch(() => {});
      ownedWorkerPool = null;
    },
  };
}
