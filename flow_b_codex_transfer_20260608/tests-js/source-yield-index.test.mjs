import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  fullFunnelSourceScores,
  normalizeRuntimeSourceYieldRows,
  observedTitleFamilyScores,
  sourceProductivityStats,
  sourceSampleStatsFromEvents,
} from "../scripts/flow_b_playwright/source-scanner.mjs";
import {
  clearRuntimeSourceYieldIndexCache,
  compactRuntimeSourceYieldRow,
  createStrictSourceFeedbackWatcher,
  loadRuntimeSourceYieldIndex,
  SOURCE_YIELD_INDEX_VERSION,
} from "../scripts/flow_b_playwright/source-yield-index.mjs";

const line = (row) => `${JSON.stringify(row)}\n`;

async function legacyRows(files) {
  const rows = [];
  for (const filename of files) {
    const text = await fs.readFile(filename, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return "";
      throw error;
    });
    for (const value of text.split(/\r?\n/)) {
      if (!value.trim()) continue;
      try { rows.push(JSON.parse(value)); } catch {}
    }
  }
  return normalizeRuntimeSourceYieldRows(rows);
}

function mapValues(map) {
  return [...map].sort(([left], [right]) => String(left).localeCompare(String(right)));
}

test("runtime yield index preserves scanner decisions while compacting mirrored source history", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-yield-index-oracle-"));
  const current = path.join(dir, "source_yield.jsonl");
  const funnel = path.join(dir, "direct_funnel.jsonl");
  const favorites = path.join(dir, "favorite_collection.jsonl");
  const history = path.join(dir, "source_yield_history.jsonl");
  const fbsHistory = path.join(dir, "fbs_source_history.jsonl");
  const indexFile = path.join(dir, "runtime-index.json");
  const source = "https://www.ozon.ru/seller/stable/";
  const mirrored = {
    at: "2026-08-12T01:00:00.000Z",
    sku: "100",
    source_url: source,
    seller_url: source,
    title: "building toy",
    title_family: "building",
    status: "submitted",
    reason: null,
  };
  const strict = {
    at: "2026-08-12T01:01:00.000Z",
    sku: "200",
    source_url: source,
    seller_url: source,
    title: "building toy strict",
    status: "published",
    strict_confirmed: true,
    online_status: "selling",
    stock: 1,
    profit_rate: 31,
    shipping_mode: "FBS",
  };
  const directRows = [
    { at: "2026-08-12T01:00:01.000Z", sku: "100", source_url: source, stage: "candidate" },
    { at: "2026-08-12T01:00:02.000Z", sku: "100", source_url: source, stage: "cost_passed" },
  ];
  const favoriteRows = [
    { at: "2026-08-12T00:59:00.000Z", sku: "old", source_url: source, status: "rejected", reason: "timeout" },
    { at: "2026-08-12T01:00:00.000Z", sku: "100", source_url: source, status: "favorited" },
    { at: "2026-08-12T01:02:00.000Z", sku: "new", source_url: source, status: "rejected", reason: "timeout" },
  ];
  await fs.writeFile(current, line(mirrored));
  await fs.writeFile(funnel, directRows.map(line).join(""));
  await fs.writeFile(favorites, favoriteRows.map(line).join(""));
  await fs.writeFile(history, `${line(mirrored)}${line(strict)}`);
  await fs.writeFile(fbsHistory, favoriteRows.map(line).join(""));

  const files = [current, funnel, favorites, history, fbsHistory];
  const legacy = await legacyRows(files);
  const indexed = await loadRuntimeSourceYieldIndex(files, { indexFile });

  assert.equal(indexed.rebuilt, true);
  assert.equal(indexed.rows.length, legacy.length - 1, "only the mirrored source row is compacted");
  assert.deepEqual(
    indexed.files.get(path.resolve(funnel)).rows,
    normalizeRuntimeSourceYieldRows(directRows.map(compactRuntimeSourceYieldRow)),
    "direct funnel order must remain complete",
  );
  assert.deepEqual(observedTitleFamilyScores(indexed.rows), observedTitleFamilyScores(legacy));
  assert.deepEqual(mapValues(fullFunnelSourceScores(indexed.rows)), mapValues(fullFunnelSourceScores(legacy)));
  assert.deepEqual(mapValues(sourceProductivityStats(indexed.rows)), mapValues(sourceProductivityStats(legacy)));
  assert.deepEqual(mapValues(sourceSampleStatsFromEvents(indexed.rows)), mapValues(sourceSampleStatsFromEvents(legacy)));
  assert.equal((await fs.readFile(indexFile, "utf8")).includes(SOURCE_YIELD_INDEX_VERSION), true);
  await assert.rejects(fs.access(`${indexFile}.tmp`));

  const warm = await loadRuntimeSourceYieldIndex(files, { indexFile });
  assert.equal(warm.rebuilt, false);
  assert.equal(warm.appended_bytes, 0);
  assert.deepEqual(warm.rows, indexed.rows);
});

test("runtime yield index rebuilds a metadata-matching v1 sidecar and recomputes strict feedback", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-yield-index-v1-migration-"));
  const sourceFile = path.join(dir, "source_yield.jsonl");
  const indexFile = path.join(dir, "runtime-index.json");
  const rawPublished = {
    at: "2026-08-18T12:00:00.000Z",
    sku: "legacy-raw-published",
    source_url: "https://www.ozon.ru/seller/legacy-raw/",
    status: "published",
  };
  await fs.writeFile(sourceFile, line(rawPublished));
  await loadRuntimeSourceYieldIndex([sourceFile], { indexFile });

  const v1 = JSON.parse(await fs.readFile(indexFile, "utf8"));
  const sourceStat = await fs.stat(sourceFile);
  assert.equal(String(v1.sources[0].dev), String(sourceStat.dev));
  assert.equal(String(v1.sources[0].ino), String(sourceStat.ino));
  assert.equal(v1.sources[0].size, sourceStat.size);
  assert.equal(v1.sources[0].mtime_ms, sourceStat.mtimeMs);
  v1.version = "source-yield-runtime-index-v1";
  v1.sections = [[rawPublished]];
  v1.sources[0].strict_feedback_keys = [
    `${rawPublished.sku}\0${rawPublished.source_url}`,
  ];
  await fs.writeFile(indexFile, `${JSON.stringify(v1)}\n`);
  clearRuntimeSourceYieldIndexCache();

  const migrated = await loadRuntimeSourceYieldIndex([sourceFile], { indexFile });
  assert.equal(migrated.rebuilt, true);
  assert.equal(migrated.rows[0].status, "submitted");
  assert.equal(migrated.rows[0].original_status, "published");
  assert.deepEqual(
    [...migrated.files.get(path.resolve(sourceFile)).strictFeedbackKeys],
    [],
  );
  const persisted = JSON.parse(await fs.readFile(indexFile, "utf8"));
  assert.equal(persisted.version, SOURCE_YIELD_INDEX_VERSION);
  assert.equal(persisted.sections[0][0].status, "submitted");
  assert.deepEqual(persisted.sources[0].strict_feedback_keys, []);
});

test("runtime yield index replays only append bytes and rebuilds after half-lines or truncation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-yield-index-recovery-"));
  const current = path.join(dir, "source_yield.jsonl");
  const history = path.join(dir, "source_yield_history.jsonl");
  const indexFile = path.join(dir, "runtime-index.json");
  const first = { sku: "100", status: "submitted", source_url: "source-a" };
  const second = { sku: "200", status: "submitted", source_url: "source-b" };
  await fs.writeFile(current, line(first));
  await fs.writeFile(history, "");
  const files = [current, history];

  await loadRuntimeSourceYieldIndex(files, { indexFile });
  const payload = line(second);
  await fs.appendFile(current, payload);
  const appended = await loadRuntimeSourceYieldIndex(files, { indexFile });
  assert.equal(appended.rebuilt, false);
  assert.equal(appended.appended_bytes, Buffer.byteLength(payload));
  assert.deepEqual(appended.rows.map((row) => row.sku), ["100", "200"]);

  await fs.appendFile(current, '{"sku":"300"');
  const halfLine = await loadRuntimeSourceYieldIndex(files, { indexFile });
  assert.equal(halfLine.rebuilt, false);
  assert.deepEqual(halfLine.rows.map((row) => row.sku), ["100", "200"]);
  await fs.appendFile(current, ',"status":"submitted","source_url":"source-c"}\n');
  const completed = await loadRuntimeSourceYieldIndex(files, { indexFile });
  assert.equal(completed.rebuilt, true, "an append after an indexed half-line is rebuilt safely");
  assert.deepEqual(completed.rows.map((row) => row.sku), ["100", "200", "300"]);

  await fs.writeFile(current, line({ sku: "400", status: "submitted", source_url: "source-d" }));
  const truncated = await loadRuntimeSourceYieldIndex(files, { indexFile });
  assert.equal(truncated.rebuilt, true);
  assert.deepEqual(truncated.rows.map((row) => row.sku), ["400"]);
});

test("strict feedback watcher detects appended proof without rereading unchanged history", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-yield-feedback-index-"));
  const current = path.join(dir, "source_yield.jsonl");
  const indexFile = path.join(dir, "runtime-index.json");
  await fs.writeFile(current, line({ sku: "100", status: "submitted", source_url: "source-a" }));
  const indexed = await loadRuntimeSourceYieldIndex([current], { indexFile });
  const watcher = createStrictSourceFeedbackWatcher(current, indexed.files.get(path.resolve(current)));
  assert.equal(await watcher.hasChanged(), false);

  await fs.appendFile(current, line({ sku: "200", status: "submitted", source_url: "source-b" }));
  assert.equal(await watcher.hasChanged(), false);
  await fs.appendFile(current, line({ sku: "raw-published", status: "published", source_url: "source-raw" }));
  assert.equal(await watcher.hasChanged(), false);
  for (const sku of ["2747636284", "1076490713", "1218765294", "2995060039"]) {
    await fs.appendFile(current, line({
      sku,
      status: "published",
      source_url: `source-invalid-${sku}`,
      strict_confirmed: true,
      online_status: "selling",
      stock: 1,
      profit_rate: 31,
      shipping_mode: "FBS",
    }));
    assert.equal(await watcher.hasChanged(), false);
  }
  await fs.appendFile(current, line({
    sku: "source-null",
    status: "published",
    source_url: null,
    strict_confirmed: true,
    online_status: "selling",
    stock: 1,
    profit_rate: 31,
    shipping_mode: "FBS",
  }));
  assert.equal(await watcher.hasChanged(), false);
  await fs.appendFile(current, line({
    sku: "300",
    status: "published",
    source_url: "source-c",
    strict_confirmed: true,
    online_status: "selling",
    stock: 1,
    profit_rate: 31,
    shipping_mode: "FBS",
  }));
  assert.equal(await watcher.hasChanged(), true);
  assert.equal(await watcher.hasChanged(), true);
});

test("runtime yield sidecar drops irrelevant payload bytes without changing indexed evidence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-yield-index-size-"));
  const funnel = path.join(dir, "direct_funnel.jsonl");
  const indexFile = path.join(dir, "runtime-index.json");
  const rows = Array.from({ length: 2_000 }, (_, index) => ({
    at: "2026-08-12T00:00:00.000Z",
    sku: String(index),
    source_url: `source-${index % 10}`,
    stage: "candidate",
    oversized_debug_payload: "x".repeat(4_096),
  }));
  await fs.writeFile(funnel, rows.map(line).join(""));
  const indexed = await loadRuntimeSourceYieldIndex([funnel], { indexFile });
  const [rawStat, indexStat] = await Promise.all([fs.stat(funnel), fs.stat(indexFile)]);
  assert.equal(indexed.rows.length, rows.length);
  assert.equal(indexed.rows.every((row) => row.oversized_debug_payload === undefined), true);
  assert.ok(indexStat.size < rawStat.size / 10, `${indexStat.size} must be far below ${rawStat.size}`);
});
