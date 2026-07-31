import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { exportSelectedStoreSkus } from "../scripts/export_selected_store_skus.mjs";
import { exportConfirmedStoreSkus } from "../scripts/export_confirmed_store_skus.mjs";

const execFileAsync = promisify(execFile);

test("selected export deduplicates assignments and always writes all ten store files", async () => {
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
  assert.equal((await fs.readFile(path.join(out, "selected_store_113156.csv"), "utf8")).trim().split("\n").length, 1);
  assert.equal(Object.keys(summary.stores).length, 10);
});

test("selected export refuses to overwrite a live run directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-selected-export-guard-"));
  const run = path.join(root, "run");
  await fs.mkdir(run);
  await fs.writeFile(path.join(run, "selected.jsonl"), `${JSON.stringify({
    sku: "102",
    data: { sku: "102", store_id: 106640, profit_rate: 31 },
  })}\n`);

  await assert.rejects(
    exportSelectedStoreSkus({ runDirs: [run], outputDir: run }),
    /output directory must not be a source run directory/u,
  );
  await assert.rejects(fs.access(path.join(run, "selected_all_stores.csv")));
});

test("SKU exporters reject a missing source without overwriting prior output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-export-missing-source-"));
  const missing = path.join(root, "missing-run");
  const selectedOut = path.join(root, "selected-out");
  const confirmedOut = path.join(root, "confirmed-out");
  await fs.mkdir(selectedOut);
  await fs.mkdir(confirmedOut);
  await fs.writeFile(path.join(selectedOut, "selected_all_stores.csv"), "keep-selected\n");
  await fs.writeFile(path.join(confirmedOut, "confirmed_all_stores.csv"), "keep-confirmed\n");

  await assert.rejects(
    exportSelectedStoreSkus({ runDirs: [missing], outputDir: selectedOut }),
    /selected source run is unavailable/u,
  );
  await assert.rejects(
    exportConfirmedStoreSkus({ runsRoot: missing, outputDir: confirmedOut }),
    /confirmed source root is unavailable/u,
  );
  assert.equal(await fs.readFile(path.join(selectedOut, "selected_all_stores.csv"), "utf8"), "keep-selected\n");
  assert.equal(await fs.readFile(path.join(confirmedOut, "confirmed_all_stores.csv"), "utf8"), "keep-confirmed\n");
});

test("confirmed exporter CLI runs when invoked through the production app symlink", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-confirmed-export-symlink-"));
  const run = path.join(root, "run");
  const out = path.join(root, "out");
  const linkedScript = path.join(root, "export_confirmed_store_skus.mjs");
  await fs.mkdir(run);
  await fs.writeFile(path.join(run, "published.jsonl"), `${JSON.stringify({
    status: "published",
    sku: "103",
    data: {
      store_id: 106637,
      profit_rate: 31,
      online_status: "selling",
      stock: 1,
      published_at: "2026-07-28T01:00:00.000Z",
    },
  })}\n`);
  await fs.symlink(
    path.resolve(import.meta.dirname, "../scripts/export_confirmed_store_skus.mjs"),
    linkedScript,
  );

  await execFileAsync(process.execPath, [linkedScript, run, out]);

  const aggregate = await fs.readFile(path.join(out, "confirmed_all_stores.csv"), "utf8");
  assert.match(aggregate, /106637,丽丽二号,103/u);
  await fs.rm(root, { recursive: true, force: true });
});
