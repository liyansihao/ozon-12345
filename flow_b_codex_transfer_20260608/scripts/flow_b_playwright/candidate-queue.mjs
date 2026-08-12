import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const PENDING_STATUSES = new Set(["discovered", "deferred"]);
export const CANDIDATE_QUEUE_INDEX_VERSION = "candidate-queue-index-v1";

function candidateSku(value) {
  return String(value || "").match(/\/product\/(?:[^/?#]*-)?(\d+)(?:[/?#]|$)/)?.[1] || "";
}

function compactDiscovery(link, at) {
  const href = String(typeof link === "string" ? link : link?.href || "").trim();
  const sku = String(typeof link === "object" ? link?.sku || "" : "").trim() || candidateSku(href);
  if (!sku || !href) return null;
  const row = {
    at,
    status: "discovered",
    sku,
    href,
    source_url: String(typeof link === "object" ? link?.source_url || "" : "").trim() || null,
    text: String(typeof link === "object" ? link?.text || "" : "").trim(),
    card_text: String(typeof link === "object" ? link?.card_text || "" : ""),
    image_url: String(typeof link === "object" ? link?.image_url || "" : "").trim(),
  };
  if (typeof link === "object") {
    for (const key of ["sale_price", "title", "cover_image", "shipping_mode"]) {
      const value = link?.[key];
      if (value !== undefined && value !== null && value !== "") row[key] = value;
    }
  }
  return row;
}

function mergePendingDiscovery(previous, discovery) {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(discovery)) {
    if (["at", "status", "sku"].includes(key)) continue;
    if (value !== undefined && value !== null && value !== "") merged[key] = value;
  }
  return { ...merged, at: discovery.at, status: previous.status, sku: previous.sku };
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function queueSourceIdentity(filename, stat) {
  return {
    filename: path.resolve(filename),
    dev: stat ? String(stat.dev) : null,
    ino: stat ? String(stat.ino) : null,
    size: Number(stat?.size || 0),
    mtime_ms: Number(stat?.mtimeMs || 0),
  };
}

async function queueStat(filename) {
  try { return await fs.stat(filename); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function queueIdentityMatches(previous, current) {
  return previous?.filename === current?.filename
    && String(previous?.dev) === String(current?.dev)
    && String(previous?.ino) === String(current?.ino);
}

function indexedCandidateRow(row) {
  const sku = String(row?.sku || "").trim();
  const status = String(row?.status || "").trim();
  if (!sku || !status) return null;
  return PENDING_STATUSES.has(status) ? row : { sku, status };
}

async function queueTail(filename, size) {
  if (!(size > 0)) return "";
  const handle = await fs.open(filename, "r");
  try {
    const last = Buffer.allocUnsafe(1);
    await handle.read(last, 0, 1, size - 1);
    if (last[0] === 0x0a || last[0] === 0x0d) return "";
    const length = Math.min(size, 1024 * 1024);
    const suffix = Buffer.allocUnsafe(length);
    await handle.read(suffix, 0, length, size - length);
    const text = suffix.toString("utf8");
    return text.slice(Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1);
  } finally {
    await handle.close();
  }
}

async function replayCandidateRows(filename, target, orders, {
  start = 0,
  end = Number.POSITIVE_INFINITY,
  nextOrder = 0,
} = {}) {
  const stat = await queueStat(filename);
  if (!stat || Number(start) >= stat.size) {
    return { nextOrder, tail: stat ? await queueTail(filename, stat.size) : "" };
  }
  const stream = createReadStream(filename, {
    encoding: "utf8",
    start: Math.max(0, Number(start) || 0),
    ...(Number.isFinite(Number(end)) ? { end: Math.max(0, Number(end)) } : {}),
  });
  const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const indexed = indexedCandidateRow(row);
      if (!indexed) continue;
      if (!orders.has(indexed.sku)) orders.set(indexed.sku, nextOrder++);
      target.set(indexed.sku, indexed);
    } catch {}
  }
  const indexedSize = Number.isFinite(Number(end))
    ? Math.min(stat.size, Math.max(0, Number(end) + 1))
    : stat.size;
  return { nextOrder, tail: await queueTail(filename, indexedSize) };
}

async function writeCandidateIndex(indexFile, source, target, orders, nextOrder, tail) {
  const absolute = path.resolve(indexFile);
  const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  const entries = [...target].map(([sku, row]) => ({
    order: Number(orders.get(sku) || 0),
    row,
  })).sort((left, right) => left.order - right.order);
  const document = {
    version: CANDIDATE_QUEUE_INDEX_VERSION,
    source: { ...source, tail },
    next_order: nextOrder,
    entries,
  };
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(document)}\n`, "utf8");
    await fs.rename(temporary, absolute);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function loadCandidateIndex(filename, indexFile) {
  const currentStat = await queueStat(filename);
  const current = queueSourceIdentity(filename, currentStat);
  let document = null;
  try {
    document = JSON.parse(await fs.readFile(indexFile, "utf8"));
    if (document?.version !== CANDIDATE_QUEUE_INDEX_VERSION
      || !Array.isArray(document?.entries)
      || document?.source?.filename !== current.filename) document = null;
  } catch {}
  const target = new Map();
  const orders = new Map();
  let nextOrder = 0;
  let reusable = Boolean(document);
  let appended = false;
  if (document) {
    const previous = document.source;
    const previousMissing = previous.ino === null;
    const currentMissing = current.ino === null;
    reusable = previousMissing === currentMissing;
    if (reusable && !currentMissing) {
      reusable = queueIdentityMatches(previous, current) && current.size >= Number(previous.size);
      if (reusable && current.size === Number(previous.size)) {
        reusable = current.mtime_ms === Number(previous.mtime_ms);
      } else if (reusable) {
        reusable = !String(previous.tail || "");
        appended = reusable;
      }
    }
    if (reusable) {
      for (const entry of document.entries) {
        const indexed = indexedCandidateRow(entry?.row);
        const order = Number(entry?.order);
        if (!indexed || !Number.isInteger(order) || order < 0 || orders.has(indexed.sku)) {
          reusable = false;
          break;
        }
        target.set(indexed.sku, indexed);
        orders.set(indexed.sku, order);
        nextOrder = Math.max(nextOrder, order + 1);
      }
    }
  }
  if (!reusable) {
    target.clear();
    orders.clear();
    const replayed = currentStat
      ? await replayCandidateRows(filename, target, orders, { end: current.size - 1, nextOrder: 0 })
      : { nextOrder: 0, tail: "" };
    nextOrder = replayed.nextOrder;
    await writeCandidateIndex(indexFile, current, target, orders, nextOrder, replayed.tail);
    return { target, rebuilt: true, appended_bytes: 0 };
  }
  if (appended) {
    const previousSize = Number(document.source.size);
    const replayed = await replayCandidateRows(filename, target, orders, {
      start: previousSize,
      end: current.size - 1,
      nextOrder,
    });
    nextOrder = replayed.nextOrder;
    await writeCandidateIndex(indexFile, current, target, orders, nextOrder, replayed.tail);
    return { target, rebuilt: false, appended_bytes: current.size - previousSize };
  }
  return { target, rebuilt: false, appended_bytes: 0 };
}

export function createCandidateQueue(filename, {
  now = () => new Date(),
  indexFile: configuredIndexFile,
} = {}) {
  const absolute = path.resolve(filename);
  const indexFile = path.resolve(configuredIndexFile || `${absolute}.${CANDIDATE_QUEUE_INDEX_VERSION}.json`);
  const latest = new Map();
  let loaded = false;
  let writeChain = Promise.resolve();
  let loadMetrics = { rebuilt: false, appended_bytes: 0 };

  const appendRows = async (rows) => {
    if (rows.length === 0) return;
    const payload = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    writeChain = writeChain.then(async () => {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.appendFile(absolute, payload);
    });
    await writeChain;
  };

  return {
    filename: absolute,
    indexFilename: indexFile,

    indexStats() {
      return { ...loadMetrics };
    },

    async load() {
      await writeChain;
      latest.clear();
      const indexed = await loadCandidateIndex(absolute, indexFile);
      for (const [sku, row] of indexed.target) latest.set(sku, row);
      loadMetrics = { rebuilt: indexed.rebuilt, appended_bytes: indexed.appended_bytes };
      loaded = true;
      return this.stats();
    },

    async discover(links = []) {
      if (!loaded) await this.load();
      const rows = [];
      const seen = new Set();
      const at = isoNow(now);
      for (const link of links || []) {
        const row = compactDiscovery(link, at);
        if (!row || seen.has(row.sku)) continue;
        seen.add(row.sku);
        const previous = latest.get(row.sku);
        if (previous && !PENDING_STATUSES.has(String(previous.status || ""))) continue;
        const next = previous ? mergePendingDiscovery(previous, row) : row;
        const changed = !previous || Object.keys(next).some((key) => key !== "at" && next[key] !== previous[key]);
        if (!changed) continue;
        latest.set(row.sku, next);
        rows.push(next);
      }
      await appendRows(rows);
      return rows.length;
    },

    async transition(sku, status, data = {}) {
      if (!loaded) await this.load();
      const key = String(sku || "").trim();
      const normalizedStatus = String(status || "").trim();
      if (!key || !normalizedStatus) throw new TypeError("candidate queue transition requires sku and status");
      const row = {
        ...(latest.get(key) || { sku: key }),
        ...data,
        at: isoNow(now),
        status: normalizedStatus,
        sku: key,
      };
      latest.set(key, row);
      await appendRows([row]);
      return row;
    },

    inCooldown(sku, { nowMs = Date.now() } = {}) {
      const row = latest.get(String(sku || "").trim());
      if (!row || !PENDING_STATUSES.has(String(row.status || ""))) return false;
      const retryAt = Date.parse(row.retry_at || "");
      return Number.isFinite(retryAt) && retryAt > Number(nowMs);
    },

    pending({
      attempted = new Set(),
      limit = Number.POSITIVE_INFINITY,
      perSourceLimit = Number.POSITIVE_INFINITY,
      sourceKey = (row) => row?.source_url,
      priority = () => 0,
      priorityTier = priority,
      nowMs = Date.now(),
    } = {}) {
      const maximum = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : Number.POSITIVE_INFINITY;
      if (maximum === 0) return [];
      const sourceMaximum = Number.isFinite(Number(perSourceLimit))
        ? Math.max(0, Math.floor(Number(perSourceLimit)))
        : Number.POSITIVE_INFINITY;
      if (sourceMaximum === 0) return [];
      const eligible = [];
      for (const row of latest.values()) {
        if (!PENDING_STATUSES.has(String(row?.status || "")) || attempted.has(String(row.sku))) continue;
        const retryAt = Date.parse(row?.retry_at || "");
        if (Number.isFinite(retryAt) && retryAt > Number(nowMs)) continue;
        eligible.push({ ...row });
      }
      const ranked = eligible.map((row, index) => {
        let score = 0;
        let tier = 0;
        try { score = Number(priority(row)) || 0; } catch {}
        try { tier = Number(priorityTier(row)) || 0; } catch {}
        return { row, index, score, tier };
      }).sort((left, right) => right.tier - left.tier || right.score - left.score || left.index - right.index);
      if (!Number.isFinite(sourceMaximum)) return ranked.slice(0, maximum).map(({ row }) => row);
      const tiers = new Map();
      for (const entry of ranked) {
        const { row, tier: tierScore } = entry;
        let source = "";
        try { source = String(sourceKey(row) || "").trim(); } catch {}
        source ||= `sku:${row.sku}`;
        const tier = tiers.get(tierScore) || new Map();
        const values = tier.get(source) || [];
        values.push(row);
        tier.set(source, values);
        tiers.set(tierScore, tier);
      }
      const rows = [];
      const sourceCounts = new Map();
      for (const groups of tiers.values()) {
        for (let round = 0; rows.length < maximum; round += 1) {
          let added = false;
          for (const [source, values] of groups) {
            if (Number(sourceCounts.get(source) || 0) >= sourceMaximum) continue;
            if (values[round]) {
              rows.push(values[round]);
              sourceCounts.set(source, Number(sourceCounts.get(source) || 0) + 1);
              added = true;
              if (rows.length >= maximum) break;
            }
          }
          if (!added) break;
        }
        if (rows.length >= maximum) break;
      }
      return rows;
    },

    stats() {
      const byStatus = {};
      let pending = 0;
      for (const row of latest.values()) {
        const status = String(row?.status || "unknown");
        byStatus[status] = Number(byStatus[status] || 0) + 1;
        if (PENDING_STATUSES.has(status)) pending += 1;
      }
      return { total: latest.size, pending, by_status: byStatus };
    },
  };
}
