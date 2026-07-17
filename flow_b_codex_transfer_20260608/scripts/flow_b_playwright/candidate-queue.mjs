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
  return {
    at,
    status: "discovered",
    sku,
    href,
    source_url: String(typeof link === "object" ? link?.source_url || "" : "").trim() || null,
    text: String(typeof link === "object" ? link?.text || "" : "").trim(),
    card_text: String(typeof link === "object" ? link?.card_text || "" : ""),
    image_url: String(typeof link === "object" ? link?.image_url || "" : "").trim(),
  };
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
        if (!row || seen.has(row.sku) || latest.has(row.sku)) continue;
        seen.add(row.sku);
        latest.set(row.sku, row);
        rows.push(row);
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
        try { score = Number(priority(row)) || 0; } catch {}
        return { row, index, score };
      }).sort((left, right) => right.score - left.score || left.index - right.index)
        .map(({ row }) => row);
      if (!Number.isFinite(sourceMaximum)) return ranked.slice(0, maximum);
      const groups = new Map();
      for (const row of ranked) {
        let source = "";
        try { source = String(sourceKey(row) || "").trim(); } catch {}
        source ||= `sku:${row.sku}`;
        const values = groups.get(source) || [];
        if (values.length < sourceMaximum) values.push(row);
        groups.set(source, values);
      }
      const rows = [];
      for (let round = 0; rows.length < maximum; round += 1) {
        let added = false;
        for (const values of groups.values()) {
          if (values[round]) {
            rows.push(values[round]);
            added = true;
            if (rows.length >= maximum) break;
          }
        }
        if (!added) break;
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
