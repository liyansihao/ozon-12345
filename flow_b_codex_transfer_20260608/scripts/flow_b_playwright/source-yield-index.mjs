import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {
  isStrictProductiveSourceOutcome,
  sourceFeedbackSku,
} from "./source-feedback.mjs";

export const SOURCE_YIELD_INDEX_VERSION = "source-yield-runtime-index-v2";
const runtimeIndexCache = new Map();
const RUNTIME_INDEX_CACHE_LIMIT = 4;
const RUNTIME_INDEX_PERSIST_BYTES = 8 * 1024 * 1024;

const RUNTIME_ROW_KEYS = [
  "at",
  "timestamp",
  "sku",
  "source_url",
  "seller_url",
  "title",
  "title_family",
  "status",
  "reason",
  "strict_confirmed",
  "online_status",
  "stock",
  "profit_rate",
  "shipping_mode",
  "preflight_mode",
  "mode",
  "evidence_quality",
  "original_status",
  "stage",
  "funnel_stage",
  "erp_accepted",
  "cost_passed",
  "outcome_status",
  "source_feedback_invalidated",
  "policy_eligible",
];

function sourceIdentity(filename, stat) {
  return {
    filename: path.resolve(filename),
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    mtime_ms: Number(stat.mtimeMs),
  };
}

function sameIdentity(left, right) {
  return left?.filename === right?.filename
    && String(left?.dev) === String(right?.dev)
    && String(left?.ino) === String(right?.ino);
}

function projectNestedError(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const error = {};
  if (value.code !== undefined) error.code = value.code;
  if (value.message !== undefined) error.message = value.message;
  return Object.keys(error).length > 0 ? error : undefined;
}

export function compactRuntimeSourceYieldRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const compact = {};
  for (const key of RUNTIME_ROW_KEYS) {
    if (row[key] !== undefined) compact[key] = row[key];
  }
  const error = projectNestedError(row.error);
  if (error !== undefined) compact.error = error;
  if (row.data && typeof row.data === "object" && !Array.isArray(row.data)) {
    const data = {};
    for (const key of RUNTIME_ROW_KEYS) {
      if (row.data[key] !== undefined) data[key] = row.data[key];
    }
    const dataError = projectNestedError(row.data.error);
    if (dataError !== undefined) data.error = dataError;
    if (Object.keys(data).length > 0) compact.data = data;
  }
  return compact;
}

function normalizeRuntimeRow(row) {
  if (String(row?.status || "") !== "published" || isStrictProductiveSourceOutcome(row)) return row;
  return {
    ...row,
    status: "submitted",
    original_status: "published",
    evidence_quality: "legacy-unverified-final",
  };
}

function strictFeedbackKey(row) {
  const normalized = normalizeRuntimeRow(row);
  return isStrictProductiveSourceOutcome(normalized)
    ? `${sourceFeedbackSku(normalized)}\0${String(normalized.source_url).trim()}`
    : null;
}

function dedupeGroup(filename) {
  const basename = path.basename(filename);
  if (basename === "source_yield.jsonl" || basename === "source_yield_history.jsonl") return "source-yield";
  return null;
}

function runtimeRowKey(row) {
  if (!row || row.__runtime_repeat_count === undefined) return JSON.stringify(row);
  const { __runtime_repeat_count: _repeatCount, ...value } = row;
  return JSON.stringify(value);
}

async function statOrMissing(filename) {
  try { return await fs.stat(filename); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonlRange(filename, { start = 0, end = Number.POSITIVE_INFINITY } = {}) {
  const rows = [];
  const keys = new Set();
  let tail = "";
  const stat = await fs.stat(filename);
  const firstByte = Math.max(0, Number(start) || 0);
  const lastByte = Number.isFinite(Number(end))
    ? Math.min(stat.size - 1, Math.max(-1, Number(end)))
    : stat.size - 1;
  if (lastByte < firstByte) return { rows, strictFeedbackKeys: [], tail };
  const stream = createReadStream(filename, {
    encoding: "utf8",
    start: firstByte,
    end: lastByte,
  });
  const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of input) {
    // readline cannot distinguish a final unterminated line. The caller replaces
    // it below after checking the byte at EOF.
    if (!line.trim()) continue;
    try {
      const row = compactRuntimeSourceYieldRow(JSON.parse(line));
      if (!row) continue;
      rows.push(normalizeRuntimeRow(row));
      const key = strictFeedbackKey(row);
      if (key) keys.add(key);
    } catch {}
  }
  if (lastByte >= 0) {
    const handle = await fs.open(filename, "r");
    try {
      const last = Buffer.allocUnsafe(1);
      await handle.read(last, 0, 1, lastByte);
      if (last[0] !== 0x0a && last[0] !== 0x0d) {
        const suffixLength = Math.min(lastByte - firstByte + 1, 1024 * 1024);
        const suffix = Buffer.allocUnsafe(suffixLength);
        await handle.read(suffix, 0, suffixLength, lastByte - suffixLength + 1);
        const text = suffix.toString("utf8");
        // readline already emitted a valid unterminated record. Remember its
        // bytes so a later append rebuilds instead of joining an ambiguous tail.
        tail = text.slice(Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1);
      }
    } finally {
      await handle.close();
    }
  }
  return { rows, strictFeedbackKeys: [...keys], tail };
}

function dedupeSections(sections, filenames) {
  const retainedByGroup = new Map();
  const output = Array.from({ length: sections.length }, () => []);
  for (let fileIndex = sections.length - 1; fileIndex >= 0; fileIndex -= 1) {
    const group = dedupeGroup(filenames[fileIndex]);
    if (!group) {
      output[fileIndex] = sections[fileIndex];
      continue;
    }
    const retainedByKey = retainedByGroup.get(group) || new Map();
    const local = new Map();
    const retained = [];
    for (let index = sections[fileIndex].length - 1; index >= 0; index -= 1) {
      const row = sections[fileIndex][index];
      const key = runtimeRowKey(row);
      const repeats = Math.max(1, Math.floor(Number(row?.__runtime_repeat_count) || 1));
      const previous = retainedByKey.get(key) || local.get(key);
      if (previous) {
        previous.__runtime_repeat_count = Math.max(
          1,
          Math.floor(Number(previous.__runtime_repeat_count) || 1),
        ) + repeats;
        continue;
      }
      const value = { ...row };
      if (repeats > 1) value.__runtime_repeat_count = repeats;
      else delete value.__runtime_repeat_count;
      local.set(key, value);
      retained.push(value);
    }
    retained.reverse();
    for (const [key, row] of local) retainedByKey.set(key, row);
    retainedByGroup.set(group, retainedByKey);
    output[fileIndex] = retained;
  }
  return output;
}

async function writeIndexAtomic(indexFile, header, sections) {
  const absolute = path.resolve(indexFile);
  const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const handle = await fs.open(temporary, "w");
  try {
    const serializedHeader = JSON.stringify(header);
    await handle.write(`${serializedHeader.slice(0, -1)},"sections":[`);
    for (let file = 0; file < sections.length; file += 1) {
      if (file > 0) await handle.write(",");
      await handle.write("[");
      let payload = "";
      for (let index = 0; index < sections[file].length; index += 1) {
        payload += `${index > 0 ? "," : ""}${JSON.stringify(sections[file][index])}`;
        if (payload.length >= 1024 * 1024) {
          await handle.write(payload);
          payload = "";
        }
      }
      if (payload) await handle.write(payload);
      await handle.write("]");
    }
    await handle.write("]}\n");
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, absolute);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function readIndex(indexFile, expectedFiles) {
  const document = JSON.parse(await fs.readFile(indexFile, "utf8"));
  if (document?.version !== SOURCE_YIELD_INDEX_VERSION
    || !Array.isArray(document.sources)
    || !Array.isArray(document.sections)
    || document.sources.length !== expectedFiles.length
    || document.sections.length !== expectedFiles.length
    || document.sources.some((source, index) => source?.filename !== expectedFiles[index])
    || document.sections.some((section) => !Array.isArray(section))) {
    throw new Error("source yield index source set mismatch");
  }
  const { sections, ...header } = document;
  return { header, sections };
}

async function snapshotSources(filenames) {
  return Promise.all(filenames.map(async (filename) => {
    const stat = await statOrMissing(filename);
    return stat ? sourceIdentity(filename, stat) : {
      filename,
      dev: null,
      ino: null,
      size: 0,
      mtime_ms: 0,
    };
  }));
}

async function rebuildIndex(filenames, indexFile) {
  const rawSections = [];
  const sourceMetadata = [];
  for (const filename of filenames) {
    const before = await statOrMissing(filename);
    if (!before) {
      rawSections.push([]);
      sourceMetadata.push({ filename, dev: null, ino: null, size: 0, mtime_ms: 0, tail: "", strict_feedback_keys: [] });
      continue;
    }
    const parsed = await readJsonlRange(filename, { end: before.size - 1 });
    const after = await fs.stat(filename);
    if (String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino) || after.size < before.size) {
      throw new Error(`source yield changed while rebuilding index: ${filename}`);
    }
    rawSections.push(parsed.rows);
    sourceMetadata.push({
      ...sourceIdentity(filename, before),
      tail: parsed.tail,
      strict_feedback_keys: parsed.strictFeedbackKeys,
    });
  }
  const sections = dedupeSections(rawSections, filenames);
  const header = {
    version: SOURCE_YIELD_INDEX_VERSION,
    created_at: new Date().toISOString(),
    sources: sourceMetadata,
  };
  await writeIndexAtomic(indexFile, header, sections);
  return { header, sections, rebuilt: true, appended_bytes: 0 };
}

function cacheRuntimeIndex(key, value) {
  runtimeIndexCache.delete(key);
  runtimeIndexCache.set(key, value);
  while (runtimeIndexCache.size > RUNTIME_INDEX_CACHE_LIMIT) {
    runtimeIndexCache.delete(runtimeIndexCache.keys().next().value);
  }
}

export function clearRuntimeSourceYieldIndexCache() {
  runtimeIndexCache.clear();
}

export async function loadRuntimeSourceYieldIndex(filenames = [], {
  indexFile,
  maxRebuildAttempts = 2,
} = {}) {
  const sources = [...new Set((filenames || []).map((filename) => path.resolve(filename)))];
  if (sources.length === 0) return { rows: [], files: new Map(), rebuilt: false, appended_bytes: 0 };
  const sidecar = path.resolve(indexFile || `${sources[0]}.${SOURCE_YIELD_INDEX_VERSION}.json`);
  const cacheKey = `${sidecar}\0${sources.join("\0")}`;
  const cached = runtimeIndexCache.get(cacheKey);
  let indexed = cached ? { ...cached, from_memory: true } : null;
  if (!indexed) {
    try { indexed = await readIndex(sidecar, sources); } catch {}
  }
  const current = await snapshotSources(sources);
  let reusable = Boolean(indexed);
  let hasAppend = false;
  if (indexed) {
    for (let index = 0; index < sources.length; index += 1) {
      const previous = indexed.header.sources[index];
      const next = current[index];
      const wasMissing = previous?.ino === null;
      const isMissing = next?.ino === null;
      if (wasMissing || isMissing) {
        if (wasMissing !== isMissing) reusable = false;
        continue;
      }
      if (!sameIdentity(previous, next) || Number(next.size) < Number(previous.size)) {
        reusable = false;
        continue;
      }
      if (Number(next.size) === Number(previous.size)) {
        if (Number(next.mtime_ms) !== Number(previous.mtime_ms)) reusable = false;
      } else {
        if (String(previous.tail || "")) reusable = false;
        else hasAppend = true;
      }
    }
  }
  if (!reusable) {
    let lastError;
    for (let attempt = 0; attempt < Math.max(1, Number(maxRebuildAttempts) || 1); attempt += 1) {
      try { indexed = await rebuildIndex(sources, sidecar); lastError = null; break; }
      catch (error) { lastError = error; }
    }
    if (lastError) throw lastError;
  } else if (hasAppend) {
    let appendedBytes = 0;
    let appendSnapshotChanged = false;
    const rawSections = indexed.sections.map((rows) => [...rows]);
    const metadata = indexed.header.sources.map((source) => ({ ...source }));
    for (let index = 0; index < sources.length; index += 1) {
      const previous = metadata[index];
      const next = current[index];
      if (next.ino === null || Number(next.size) <= Number(previous.size)) continue;
      const parsed = await readJsonlRange(sources[index], {
        start: Number(previous.size),
        end: Number(next.size) - 1,
      });
      const after = await statOrMissing(sources[index]);
      const afterIdentity = after ? sourceIdentity(sources[index], after) : null;
      if (!afterIdentity || !sameIdentity(next, afterIdentity) || afterIdentity.size < next.size) {
        appendSnapshotChanged = true;
        break;
      }
      rawSections[index].push(...parsed.rows);
      appendedBytes += Number(next.size) - Number(previous.size);
      metadata[index] = {
        ...next,
        tail: parsed.tail,
        strict_feedback_keys: [...new Set([
          ...(previous.strict_feedback_keys || []),
          ...parsed.strictFeedbackKeys,
        ])],
      };
    }
    if (appendSnapshotChanged) {
      let lastError;
      for (let attempt = 0; attempt < Math.max(1, Number(maxRebuildAttempts) || 1); attempt += 1) {
        try { indexed = await rebuildIndex(sources, sidecar); lastError = null; break; }
        catch (error) { lastError = error; }
      }
      if (lastError) throw lastError;
    } else {
      const sections = dedupeSections(rawSections, sources);
      const header = {
        version: SOURCE_YIELD_INDEX_VERSION,
        created_at: new Date().toISOString(),
        sources: metadata,
      };
      const dirtyBytes = Number(indexed.dirty_bytes || 0) + appendedBytes;
      const persist = !indexed.from_memory || dirtyBytes >= RUNTIME_INDEX_PERSIST_BYTES;
      if (persist) await writeIndexAtomic(sidecar, header, sections);
      indexed = {
        header,
        sections,
        rebuilt: false,
        appended_bytes: appendedBytes,
        dirty_bytes: persist ? 0 : dirtyBytes,
      };
    }
  }
  cacheRuntimeIndex(cacheKey, {
    header: indexed.header,
    sections: indexed.sections,
    rebuilt: false,
    appended_bytes: 0,
    dirty_bytes: Number(indexed.dirty_bytes || 0),
  });
  const files = new Map(indexed.header.sources.map((source, index) => [source.filename, {
    ...source,
    rows: indexed.sections[index],
    strictFeedbackKeys: new Set(source.strict_feedback_keys || []),
  }]));
  return {
    rows: indexed.sections.flat(),
    files,
    rebuilt: Boolean(indexed.rebuilt),
    appended_bytes: Number(indexed.appended_bytes || 0),
    index_file: sidecar,
  };
}

export function createStrictSourceFeedbackWatcher(filename, indexedFile = {}) {
  const absolute = path.resolve(filename);
  const baseline = new Set(indexedFile.strictFeedbackKeys || indexedFile.strict_feedback_keys || []);
  let cursor = {
    filename: absolute,
    dev: indexedFile.dev ?? null,
    ino: indexedFile.ino ?? null,
    size: Number(indexedFile.size || 0),
    mtime_ms: Number(indexedFile.mtime_ms || 0),
    tail: String(indexedFile.tail || ""),
  };
  let changed = false;
  return {
    baseline,
    async hasChanged() {
      if (changed) return true;
      const stat = await statOrMissing(absolute);
      if (!stat) return false;
      const next = sourceIdentity(absolute, stat);
      let parsed;
      if (sameIdentity(cursor, next) && next.size === cursor.size && next.mtime_ms === cursor.mtime_ms) return false;
      if (sameIdentity(cursor, next) && next.size > cursor.size && !cursor.tail) {
        parsed = await readJsonlRange(absolute, { start: cursor.size, end: next.size - 1 });
      } else {
        parsed = await readJsonlRange(absolute, { end: next.size - 1 });
      }
      changed = parsed.strictFeedbackKeys.some((key) => !baseline.has(key));
      cursor = { ...next, tail: parsed.tail };
      return changed;
    },
  };
}
