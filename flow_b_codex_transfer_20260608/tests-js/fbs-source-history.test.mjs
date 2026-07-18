import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildFbsSourceHistory } from "../scripts/backfill_fbs_source_history.mjs";

test("FBS source history backfill keeps collection evidence and deduplicates repeated lines", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-fbs-backfill-"));
  const runRoot = path.join(dir, "runs");
  const outputFile = path.join(dir, "data", "fbs_source_history.jsonl");
  const runA = path.join(runRoot, "run-a");
  const runB = path.join(runRoot, "run-b");
  await fs.mkdir(runA, { recursive: true });
  await fs.mkdir(runB, { recursive: true });
  const favorited = {
    at: "2026-07-18T10:00:00.000Z",
    status: "favorited",
    sku: "1",
    source_url: "https://www.ozon.ru/seller/proven/",
    preflight_mode: "FBS",
  };
  await fs.writeFile(path.join(runA, "favorite_collection.jsonl"), [
    JSON.stringify(favorited),
    JSON.stringify(favorited),
    JSON.stringify({ status: "capacity_reached", sku: "2", source_url: favorited.source_url }),
    "",
  ].join("\n"));
  await fs.writeFile(path.join(runB, "favorite_collection.jsonl"), `${JSON.stringify({
    at: "2026-07-18T11:00:00.000Z",
    status: "rejected",
    reason: "non-pure-fbs",
    sku: "3",
    source_url: "https://www.ozon.ru/search/?text=dry",
  })}\n`);

  const result = await buildFbsSourceHistory({ runRoot, outputFile });
  const rows = (await fs.readFile(outputFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual({ files: result.files, rows: result.rows }, { files: 2, rows: 2 });
  assert.deepEqual(rows.map((row) => [row.run_id, row.status, row.sku]), [
    ["run-a", "favorited", "1"],
    ["run-b", "rejected", "3"],
  ]);
  await fs.rm(dir, { recursive: true, force: true });
});
