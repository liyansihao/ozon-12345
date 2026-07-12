import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

const TERMINAL_STATUSES = new Set(["published", "failed", "skipped"]);
const VALID_STATUSES = new Set(["processing", ...TERMINAL_STATUSES]);
const PRODUCT_URL_PATTERN = /https?:\/\/(?:www\.)?ozon\.ru\/product\/([^/?#,'"\s]+)/iu;

function normalizeSku(value) {
  if (value === null || value === undefined) return null;
  const sku = String(value).trim();
  return sku || null;
}

function eventData(data) {
  if (data && typeof data === "object" && !Array.isArray(data)) return { ...data };
  return data === undefined ? {} : { value: data };
}

function canonicalSkuFromUrl(value) {
  const match = String(value ?? "").match(PRODUCT_URL_PATTERN);
  return normalizeSku(match?.[1]);
}

async function readTextIfPresent(filename) {
  try {
    return await fs.readFile(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function parseJsonLines(text) {
  const events = [];
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === "object" && !Array.isArray(value)) events.push(value);
    } catch {
      // A truncated or malformed history line must not make a resumable run unusable.
    }
  }
  return events;
}

function eventFromHistory(value) {
  const sku = normalizeSku(value.sku ?? value.id);
  const status = String(value.status ?? "");
  if (!sku || !VALID_STATUSES.has(status)) return null;
  const data = value.data && typeof value.data === "object" && !Array.isArray(value.data)
    ? { ...value.data }
    : Object.fromEntries(Object.entries(value).filter(([key]) => !["sku", "id", "status", "timestamp"].includes(key)));
  return { sku, status, data };
}

function csvPublishedSkus(text) {
  const skus = new Set();
  for (const match of String(text ?? "").matchAll(/https?:\/\/(?:www\.)?ozon\.ru\/product\/([^/?#,'"\s]+)/giu)) {
    const sku = normalizeSku(match[1]);
    if (sku) skus.add(sku);
  }
  return skus;
}

export function canonicalProductUrl(sku) {
  return `https://www.ozon.ru/product/${String(sku)}`;
}

export function createPublishState({ runDir, publishedCsv }) {
  if (!runDir) throw new TypeError("runDir is required");
  if (!publishedCsv) throw new TypeError("publishedCsv is required");

  const statePath = path.join(runDir, "sku_states.jsonl");
  const publishedPath = path.join(runDir, "published.jsonl");
  const failedPath = path.join(runDir, "failed.jsonl");
  const skippedPath = path.join(runDir, "skipped.jsonl");
  const summaryPath = path.join(runDir, "summary.json");
  const states = new Map();
  const publishedSkus = new Set();
  let loaded = false;
  let loading = null;
  let summaryTarget = 0;
  let writeChain = Promise.resolve();

  function queueWrite(task) {
    const queued = writeChain.then(task);
    writeChain = queued.catch(() => {});
    return queued;
  }

  async function appendJsonl(filename, event) {
    await queueWrite(async () => {
      await fs.mkdir(runDir, { recursive: true });
      await fs.appendFile(filename, `${JSON.stringify(event)}\n`, "utf8");
    });
  }

  async function appendPublishedCsv(sku) {
    await queueWrite(async () => {
      await fs.mkdir(path.dirname(publishedCsv), { recursive: true });
      let existing = "";
      try {
        existing = await fs.readFile(publishedCsv, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!existing.trim()) {
        existing = "product_link\n";
        await fs.writeFile(publishedCsv, existing, "utf8");
      }
      const separator = existing.endsWith("\n") || existing.endsWith("\r") ? "" : "\n";
      await fs.appendFile(publishedCsv, `${separator}${canonicalProductUrl(sku)}\n`, "utf8");
    });
  }

  function calculateSummary(target) {
    const numericTarget = Number.isFinite(Number(target)) ? Math.max(0, Number(target)) : 0;
    let failed = 0;
    let skipped = 0;
    for (const [sku, value] of states) {
      if (publishedSkus.has(sku)) continue;
      if (value.status === "failed") failed += 1;
      if (value.status === "skipped") skipped += 1;
    }
    return {
      published: publishedSkus.size,
      failed,
      skipped,
      remaining: Math.max(0, numericTarget - publishedSkus.size),
    };
  }

  function writeSummary(target) {
    summaryTarget = target;
    const summary = calculateSummary(target);
    const tempPath = `${summaryPath}.tmp`;
    fsSync.mkdirSync(runDir, { recursive: true });
    try {
      fsSync.writeFileSync(tempPath, `${JSON.stringify(summary)}\n`, "utf8");
      fsSync.renameSync(tempPath, summaryPath);
    } finally {
      try {
        fsSync.unlinkSync(tempPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return summary;
  }

  function applyLoadedEvent(event, { fallback = false } = {}) {
    const parsed = eventFromHistory(event);
    if (!parsed) return;
    const { sku, status, data } = parsed;
    if (status === "published") {
      publishedSkus.add(sku);
      states.set(sku, { status, data: { ...data, link: canonicalProductUrl(sku) } });
      return;
    }
    if (publishedSkus.has(sku)) return;
    if (fallback && states.has(sku)) return;
    states.set(sku, { status, data });
  }

  async function load() {
    if (loaded) return api;
    if (loading) return loading;
    loading = (async () => {
      await fs.mkdir(runDir, { recursive: true });
      const stateEvents = parseJsonLines(await readTextIfPresent(statePath));
      for (const event of stateEvents) applyLoadedEvent(event);

      for (const event of parseJsonLines(await readTextIfPresent(publishedPath))) {
        applyLoadedEvent(event, { fallback: true });
      }
      for (const filename of [failedPath, skippedPath]) {
        for (const event of parseJsonLines(await readTextIfPresent(filename))) {
          applyLoadedEvent(event, { fallback: true });
        }
      }

      for (const sku of csvPublishedSkus(await readTextIfPresent(publishedCsv))) {
        publishedSkus.add(sku);
        states.set(sku, { status: "published", data: { link: canonicalProductUrl(sku), source: "csv" } });
      }
      loaded = true;
      writeSummary(summaryTarget);
      return api;
    })();
    try {
      return await loading;
    } finally {
      loading = null;
    }
  }

  async function transition(skuValue, status, data = {}) {
    const sku = normalizeSku(skuValue);
    if (!sku) throw new TypeError("sku is required");
    if (!VALID_STATUSES.has(status)) throw new TypeError(`unsupported status: ${status}`);
    await load();

    if (publishedSkus.has(sku)) return false;

    const nextData = eventData(data);
    if (status === "published") nextData.link = canonicalProductUrl(sku);
    const event = {
      sku,
      status,
      data: nextData,
      timestamp: new Date().toISOString(),
    };
    states.set(sku, { status, data: nextData });
    await appendJsonl(statePath, event);

    if (status === "published") {
      publishedSkus.add(sku);
      await appendJsonl(publishedPath, { ...event, link: canonicalProductUrl(sku) });
      await appendPublishedCsv(sku);
    } else if (status === "failed") {
      await appendJsonl(failedPath, event);
    } else if (status === "skipped") {
      await appendJsonl(skippedPath, event);
    }
    writeSummary(summaryTarget);
    return true;
  }

  function hasPublished(skuValue) {
    const sku = normalizeSku(skuValue);
    return sku !== null && publishedSkus.has(sku);
  }

  function summary(target) {
    return writeSummary(target);
  }

  async function recordPublished(item) {
    const sku = normalizeSku(item?.sku ?? item?.id);
    if (!sku) throw new TypeError("published item sku is required");
    if (hasPublished(sku)) {
      await load();
      return false;
    }
    return transition(sku, "published", { ...(item ?? {}), link: canonicalProductUrl(sku) });
  }

  const api = { load, transition, hasPublished, summary, recordPublished };
  return api;
}
