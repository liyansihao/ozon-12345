import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const CONTROL_STATUS_INDEX_VERSION = "control-status-index-v1";
let atomicWriteSequence = 0;

const FUNNEL_STAGES = Object.freeze([
  "candidate_required_fields_passed",
  "snapshot_category_passed",
  "cost_passed",
  "live_price_confirmed",
  "profit_passed",
]);

function skuOf(row) {
  return String(row?.sku ?? row?.data?.sku ?? "").trim();
}

export function controlStatusDateKey(value = new Date(), timeZone = "Asia/Shanghai") {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((entry) => [entry.type, entry.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function emptyAggregate() {
  return {
    funnel: new Map(FUNNEL_STAGES.map((stage) => [stage, new Set()])),
    acceptedSkus: new Set(),
    acceptedByStoreRun: new Map(),
    acceptedByDate: new Map(),
    onlineSkus: new Set(),
  };
}

function cloneAggregate(value) {
  return {
    funnel: new Map([...value.funnel].map(([stage, skus]) => [stage, new Set(skus)])),
    acceptedSkus: new Set(value.acceptedSkus),
    acceptedByStoreRun: new Map(value.acceptedByStoreRun),
    acceptedByDate: new Map(
      [...value.acceptedByDate].map(([date, rows]) => [date, new Map(rows)]),
    ),
    onlineSkus: new Set(value.onlineSkus),
  };
}

function funnelRow(aggregate, row) {
  const skus = aggregate.funnel.get(row?.stage);
  if (!skus) return;
  const sku = skuOf(row);
  if (sku) skus.add(sku);
}

function acceptedRow(aggregate, row, timeZone) {
  const sku = skuOf(row);
  if (sku) aggregate.acceptedSkus.add(sku);

  // Preserve the legacy status contract: this is a row count, and unlike the
  // daily count it intentionally does not fall back to data.store_id.
  const runStore = String(Number(row?.store_id) || "unknown");
  aggregate.acceptedByStoreRun.set(
    runStore,
    Number(aggregate.acceptedByStoreRun.get(runStore) || 0) + 1,
  );

  const acceptedAt = row?.accepted_at || row?.api_call_accepted_at || row?.at || row?.timestamp;
  const date = controlStatusDateKey(acceptedAt, timeZone);
  if (!sku || !date) return;
  const dailyRows = aggregate.acceptedByDate.get(date) || new Map();
  const dailyStore = String(Number(row?.store_id ?? row?.data?.store_id) || "unknown");
  // Later rows for one SKU win, matching dailyAcceptedSummary's Map behavior.
  dailyRows.set(sku, dailyStore);
  aggregate.acceptedByDate.set(date, dailyRows);
}

function backgroundRow(aggregate, row) {
  if (row?.online !== true) return;
  const sku = skuOf(row);
  if (sku) aggregate.onlineSkus.add(sku);
}

const SOURCE_HANDLERS = Object.freeze({
  funnel: funnelRow,
  accepted: acceptedRow,
  background: backgroundRow,
});

async function statSource(filename) {
  const absolute = path.resolve(filename);
  try {
    const stat = await fs.stat(absolute, { bigint: true });
    return {
      filename: absolute,
      missing: false,
      dev: String(stat.dev),
      ino: String(stat.ino),
      size: Number(stat.size),
      mtime_ns: String(stat.mtimeNs),
      ctime_ns: String(stat.ctimeNs),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        filename: absolute,
        missing: true,
        size: 0,
        mtime_ns: null,
        ctime_ns: null,
      };
    }
    throw error;
  }
}

function sameFile(left, right) {
  if (!left || !right || left.filename !== right.filename) return false;
  if (left.missing === true || right.missing === true) {
    return left.missing === true && right.missing === true;
  }
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function sameSnapshot(left, right) {
  return sameFile(left, right)
    && Number(left?.size || 0) === Number(right?.size || 0)
    && String(left?.mtime_ns ?? "") === String(right?.mtime_ns ?? "")
    && String(left?.ctime_ns ?? "") === String(right?.ctime_ns ?? "");
}

async function parseJsonlRange(filename, {
  start,
  end,
  onRow,
} = {}) {
  if (end < start) return { bytes: 0, tail: "" };
  let buffered = "";
  const stream = createReadStream(filename, {
    encoding: "utf8",
    start,
    end,
  });
  for await (const chunk of stream) {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line) {
        try { onRow(JSON.parse(line)); } catch {}
      }
      newline = buffered.indexOf("\n");
    }
  }
  // readFile(...).split(/\r?\n/) parses a valid final unterminated record.
  // Remember it as a tail too, so any later append rebuilds instead of
  // accidentally counting a partially joined record twice.
  if (buffered) {
    try { onRow(JSON.parse(buffered)); } catch {}
  }
  return {
    bytes: end - start + 1,
    tail: buffered,
  };
}

function serializeAggregate(aggregate) {
  return {
    funnel_skus: Object.fromEntries(FUNNEL_STAGES.map((stage) => [
      stage,
      [...(aggregate.funnel.get(stage) || [])].sort(),
    ])),
    accepted_skus: [...aggregate.acceptedSkus].sort(),
    accepted_by_store_run: Object.fromEntries(
      [...aggregate.acceptedByStoreRun].sort(([left], [right]) => left.localeCompare(right)),
    ),
    accepted_by_date: Object.fromEntries(
      [...aggregate.acceptedByDate]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, rows]) => [date, [...rows].sort(([left], [right]) => left.localeCompare(right))]),
    ),
    online_skus: [...aggregate.onlineSkus].sort(),
  };
}

function deserializeAggregate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const aggregate = emptyAggregate();
  for (const stage of FUNNEL_STAGES) {
    const skus = value?.funnel_skus?.[stage];
    if (!Array.isArray(skus)) return null;
    aggregate.funnel.set(stage, new Set(skus.map(String)));
  }
  if (!Array.isArray(value.accepted_skus) || !Array.isArray(value.online_skus)) return null;
  aggregate.acceptedSkus = new Set(value.accepted_skus.map(String));
  aggregate.onlineSkus = new Set(value.online_skus.map(String));
  if (!value.accepted_by_store_run || typeof value.accepted_by_store_run !== "object") return null;
  aggregate.acceptedByStoreRun = new Map(Object.entries(value.accepted_by_store_run).map(
    ([store, count]) => [store, Number(count) || 0],
  ));
  if (!value.accepted_by_date || typeof value.accepted_by_date !== "object") return null;
  aggregate.acceptedByDate = new Map();
  for (const [date, rows] of Object.entries(value.accepted_by_date)) {
    if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row) || row.length !== 2)) return null;
    aggregate.acceptedByDate.set(date, new Map(rows.map(([sku, store]) => [String(sku), String(store)])));
  }
  return aggregate;
}

async function readIndex(indexFile, sourceFiles, timeZone) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(indexFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
  if (value?.version !== CONTROL_STATUS_INDEX_VERSION || value?.time_zone !== timeZone) return null;
  const aggregate = deserializeAggregate(value.aggregate);
  if (!aggregate) return null;
  const sources = value.sources;
  if (!sources || typeof sources !== "object") return null;
  for (const [name, filename] of Object.entries(sourceFiles)) {
    if (sources?.[name]?.filename !== path.resolve(filename)) return null;
  }
  return {
    aggregate,
    sources,
    generatedAt: value.generated_at || null,
  };
}

async function writeIndexAtomic(indexFile, value) {
  const absolute = path.resolve(indexFile);
  atomicWriteSequence += 1;
  const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}-${atomicWriteSequence}`;
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  let handle;
  try {
    handle = await fs.open(temporary, "wx");
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, absolute);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function summaryFromAggregate(aggregate, { now, timeZone }) {
  const date = controlStatusDateKey(now, timeZone);
  const dailyRows = aggregate.acceptedByDate.get(date) || new Map();
  const byStore = {};
  for (const store of dailyRows.values()) {
    byStore[store] = Number(byStore[store] || 0) + 1;
  }
  return {
    stage_counts: Object.fromEntries(FUNNEL_STAGES.map((stage) => [
      stage,
      aggregate.funnel.get(stage)?.size || 0,
    ])),
    run_accepted: aggregate.acceptedSkus.size,
    by_store_run: Object.fromEntries(aggregate.acceptedByStoreRun),
    today: {
      date,
      accepted: dailyRows.size,
      by_store: byStore,
    },
    online: aggregate.onlineSkus.size,
  };
}

function sourceFilesForRun(runDir) {
  return {
    funnel: path.join(runDir, "direct_funnel.jsonl"),
    accepted: path.join(runDir, "erp_accepted.jsonl"),
    background: path.join(runDir, "background_status.jsonl"),
  };
}

async function loadOnce(sourceFiles, cached, timeZone) {
  const before = Object.fromEntries(await Promise.all(Object.entries(sourceFiles).map(
    async ([name, filename]) => [name, await statSource(filename)],
  )));
  let rebuild = !cached;
  if (cached) {
    for (const name of Object.keys(sourceFiles)) {
      const prior = cached.sources?.[name];
      const current = before[name];
      if (!sameFile(prior, current)
        || Number(current.size) < Number(prior.size)
        || (Number(current.size) === Number(prior.size) && !sameSnapshot(prior, current))
        || (Number(current.size) > Number(prior.size) && String(prior.tail || "") !== "")) {
        rebuild = true;
        break;
      }
    }
  }

  const hasAppend = !rebuild && Object.keys(sourceFiles).some(
    (name) => Number(before[name].size) > Number(cached.sources[name].size),
  );
  const aggregate = rebuild
    ? emptyAggregate()
    : hasAppend
      ? cloneAggregate(cached.aggregate)
      : cached.aggregate;
  const sources = {};
  let appendedBytes = 0;
  for (const [name, filename] of Object.entries(sourceFiles)) {
    const identity = before[name];
    const priorSize = rebuild ? 0 : Number(cached.sources[name].size || 0);
    const start = identity.missing ? 0 : priorSize;
    const end = identity.missing ? -1 : identity.size - 1;
    let range = { bytes: 0, tail: "" };
    if (end >= start) {
      const handler = SOURCE_HANDLERS[name];
      range = await parseJsonlRange(filename, {
        start,
        end,
        onRow: (row) => handler(aggregate, row, timeZone),
      });
      if (!rebuild) appendedBytes += range.bytes;
    } else if (!rebuild) {
      range.tail = String(cached.sources[name].tail || "");
    }
    sources[name] = {
      ...identity,
      tail: range.tail,
    };
  }

  const after = Object.fromEntries(await Promise.all(Object.entries(sourceFiles).map(
    async ([name, filename]) => [name, await statSource(filename)],
  )));
  for (const name of Object.keys(sourceFiles)) {
    if (!sameFile(before[name], after[name]) || Number(after[name].size) < Number(before[name].size)) {
      const error = new Error(`control status source changed while indexing: ${name}`);
      error.code = "CONTROL_STATUS_SOURCE_CHANGED";
      throw error;
    }
    if (Number(after[name].size) === Number(before[name].size) && !sameSnapshot(before[name], after[name])) {
      const error = new Error(`control status source was rewritten while indexing: ${name}`);
      error.code = "CONTROL_STATUS_SOURCE_CHANGED";
      throw error;
    }
  }
  return { aggregate, sources, rebuilt: rebuild, appendedBytes };
}

export async function loadControlStatusIndex(runDir, {
  indexFile = path.join(runDir, ".control-status-index-v1.json"),
  now = new Date(),
  timeZone = "Asia/Shanghai",
  persistIntervalMs = 5 * 60 * 1_000,
  persistByteThreshold = 4 * 1024 * 1024,
} = {}) {
  const sourceFiles = sourceFilesForRun(path.resolve(runDir));
  const absoluteIndex = path.resolve(indexFile);
  let cached = await readIndex(absoluteIndex, sourceFiles, timeZone);
  let loaded;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      loaded = await loadOnce(sourceFiles, cached, timeZone);
      break;
    } catch (error) {
      if (error?.code !== "CONTROL_STATUS_SOURCE_CHANGED" || attempt === 2) throw error;
      cached = null;
    }
  }

  const changed = loaded.rebuilt || loaded.appendedBytes > 0;
  let persisted = !changed;
  const cacheAgeMs = Date.now() - new Date(cached?.generatedAt || 0).getTime();
  const shouldPersist = loaded.rebuilt
    || loaded.appendedBytes >= Math.max(1, Number(persistByteThreshold) || 1)
    || !Number.isFinite(cacheAgeMs)
    || cacheAgeMs >= Math.max(0, Number(persistIntervalMs) || 0);
  if (changed && shouldPersist) {
    try {
      await writeIndexAtomic(absoluteIndex, {
        version: CONTROL_STATUS_INDEX_VERSION,
        time_zone: timeZone,
        generated_at: new Date().toISOString(),
        sources: loaded.sources,
        aggregate: serializeAggregate(loaded.aggregate),
      });
      persisted = true;
    } catch {
      // The raw JSONL files remain authoritative. A cache write failure must not
      // make the read-only status command fail or trigger a second full read.
      persisted = false;
    }
  }
  return {
    ...summaryFromAggregate(loaded.aggregate, { now, timeZone }),
    index: {
      file: absoluteIndex,
      rebuilt: loaded.rebuilt,
      appended_bytes: loaded.appendedBytes,
      persisted,
    },
  };
}
