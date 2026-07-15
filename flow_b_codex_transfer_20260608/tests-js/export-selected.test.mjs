import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { exportSelectedStoreSkus } from "../scripts/export_selected_store_skus.mjs";

test("selected export deduplicates assignments and always writes all five store files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-selected-export-"));
  const runA = path.join(root, "a");
  const runB = path.join(root, "b");
  const out = path.join(root, "out");
  await fs.mkdir(runA);
  await fs.mkdir(runB);
  await fs.writeFile(path.join(runA, "selected.jsonl"), [
    JSON.stringify({ sku: "101", data: { sku: "101", store_id: 106637, profit_rate: 31, selected_at: "2026-07-15T01:00:00Z" } }),
    JSON.stringify({ sku: "2815247918", data: { sku: "2815247918", store_id: 106637, profit_rate: 99 } }),
  ].join("\n"));
  await fs.writeFile(path.join(runB, "selected.jsonl"), JSON.stringify({
    sku: "101", data: { sku: "101", store_id: 106637, profit_rate: 35, selected_at: "2026-07-15T02:00:00Z" },
  }));

  const summary = await exportSelectedStoreSkus({ runDirs: [runA, runB], outputDir: out });
  assert.equal(summary.stores["106637"].selected, 1);
  assert.equal(summary.stores["106640"].selected, 0);
  const storeTwo = await fs.readFile(path.join(out, "selected_store_106637.csv"), "utf8");
  assert.match(storeTwo, /106637,丽丽二号,101/);
  assert.doesNotMatch(storeTwo, /2815247918/);
  assert.equal((await fs.readFile(path.join(out, "selected_store_106646.csv"), "utf8")).trim().split("\n").length, 1);
});
