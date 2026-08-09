import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  enrichErpOrderRow,
  readProfitProductIndex,
} from "../scripts/flow_b_playwright/profit-runtime-data.mjs";

test("maps an ERP store SKU back to the exact store and original source SKU", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "profit-runtime-data-"));
  const databaseFile = path.join(directory, "runtime.sqlite");
  try {
    const database = new DatabaseSync(databaseFile);
    database.exec("CREATE TABLE sku_state (sku TEXT PRIMARY KEY, updated_at TEXT, data_json TEXT)");
    const insert = database.prepare("INSERT INTO sku_state (sku, updated_at, data_json) VALUES (?, ?, ?)");
    insert.run("source-1", "2026-08-09T01:00:00Z", JSON.stringify({
      store_id: 101,
      store_sku: "900000000001",
      offer_id: "own-1",
      title: "Kitchen drawer organizer",
      content_quality_evidence: { category: { mapped: "Kitchen storage" } },
      cost: {
        match_evidence_key: "evidence-1",
        selected_offer_id: "1688-exact",
        selected_offer_ids: ["1688-cluster-first", "1688-exact"],
      },
    }));
    insert.run("source-2", "2026-08-09T02:00:00Z", JSON.stringify({
      store_id: 202,
      store_sku: "900000000002",
      offer_id: "own-2",
    }));
    database.close();

    const index = await readProfitProductIndex({ runtimeDbPath: databaseFile });
    const enriched = enrichErpOrderRow({
      store_id: 101,
      store_sku: "900000000001",
      status: "delivered",
    }, index);
    assert.equal(enriched.source_sku, "source-1");
    assert.equal(enriched.title, "Kitchen drawer organizer");
    assert.equal(enriched.category, "Kitchen storage");
    assert.equal(index.resolve({ store_id: 101, store_sku: "900000000001" }).selected_offer_id, "1688-exact");
    assert.deepEqual(index.resolve({ store_id: 101, store_sku: "900000000001" }).selected_offer_ids, ["1688-exact"]);
    assert.equal(index.resolve({ store_id: 202, store_sku: "900000000002" }).source_sku, "source-2");
    assert.equal(index.resolve({ store_id: 101, store_sku: "900000000002" }), null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
