import fs from "node:fs/promises";
import path from "node:path";

const PENDING_STATUSES = new Set(["discovered", "deferred"]);

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

export function createCandidateQueue(filename, { now = () => new Date() } = {}) {
  const absolute = path.resolve(filename);
  const latest = new Map();
  let loaded = false;
  let writeChain = Promise.resolve();

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

    async load() {
      await writeChain;
      latest.clear();
      let text = "";
      try { text = await fs.readFile(absolute, "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          const sku = String(row?.sku || "").trim();
          if (sku && row?.status) latest.set(sku, row);
        } catch {}
      }
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
