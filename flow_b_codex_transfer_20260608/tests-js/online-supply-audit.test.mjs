import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createOnlineSupplyAuditor,
  loadStrictPublicationsReadOnly,
  summarizeOnlineSupplyAudit,
  writeOnlineSupplyAudit,
} from "../scripts/flow_b_playwright/online-supply-audit.mjs";

const MATCH_KEY = "a".repeat(64);
const STRICT_COST = Object.freeze({
  ok: true,
  cost: 20,
  source: "search_first_page_p70_similarity_filtered",
  prices: [18, 20, 22],
  match_evidence_key: MATCH_KEY,
  same_item_match: true,
  returned_evidence_verified: true,
  match_evidence_contract: "1688-returned-same-item-v3",
  matched_offer_count: 3,
  selected_offer_id: "1688001",
  selected_cluster_offer_ids: ["1688001", "1688002"],
  balanced_supporting_offer_ids: ["1688001", "1688002"],
  balanced_match: true,
  balanced_match_type: "corroborated_multi",
});

function evidence(overrides = {}) {
  return {
    contract: "1688-orderable-v1",
    passed: true,
    platform: "1688",
    offer_id: "1688001",
    offer_url: "https://detail.1688.com/offer/1688001.html",
    target_variant: null,
    item_level_match: true,
    variant_attributes: {},
    moq: 1,
    orderable_quantity: 1,
    stock_state: "in_stock",
    orderable: true,
    unit_price: 21,
    match_evidence_key: MATCH_KEY,
    checked_at: "2026-08-15T11:59:00.000Z",
    valid_until: "2026-08-15T12:29:00.000Z",
    ...overrides,
  };
}

function supplyPass(overrides = {}) {
  return {
    ok: true,
    passed: true,
    supply_gate_passed: true,
    status: "passed",
    retryable: false,
    evidence: evidence(overrides),
  };
}

test("online supply audit is read-only, resumable, and emits procurement links", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "online-supply-audit-"));
  try {
    let verifyCalls = 0;
    let costCalls = 0;
    const auditor = createOnlineSupplyAuditor({
      costBridge: { estimate: async () => { costCalls += 1; return { ...STRICT_COST }; } },
      supplyVerifier: { verify: async () => { verifyCalls += 1; return supplyPass(); } },
      now: () => new Date("2026-08-15T12:00:00.000Z"),
      runDir,
      checkpointFile: path.join(runDir, "checkpoint.jsonl"),
    });
    const onlineProducts = [{
      shop_id: 7,
      offer_id: "mz-150826-source-1",
      id: 99,
      name: "Online item",
      stock: 1,
      online_status: "selling",
    }];
    const strictPublications = [{
      sku: "source-1",
      data: {
        offer_id: "mz-150826-source-1",
        title: "Source item",
        cover_image: "https://img.example/item.jpg",
        cost: { ...STRICT_COST },
      },
    }];

    const first = await auditor.run({ onlineProducts, strictPublications });
    assert.equal(first.summary.verified_orderable, 1);
    assert.equal(first.rows[0].supply_offer_url, "https://detail.1688.com/offer/1688001.html");
    assert.equal(first.rows[0].recommendation_action, "keep");
    assert.equal(costCalls, 0);
    assert.equal(verifyCalls, 1);

    const resumed = await auditor.run({ onlineProducts, strictPublications });
    assert.deepEqual(resumed.rows, first.rows);
    assert.equal(verifyCalls, 1);

    const written = await writeOnlineSupplyAudit(first, path.join(runDir, "report"));
    assert.match(await fs.readFile(written.csv_file, "utf8"), /https:\/\/detail\.1688\.com\/offer\/1688001\.html/u);
    assert.equal(JSON.parse(await fs.readFile(written.summary_file, "utf8")).total, 1);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("read-only audit loader includes direct online sku_state rows", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "online-supply-direct-loader-"));
  const dbFile = path.join(root, "runtime.sqlite");
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`
      CREATE TABLE strict_publications (sku TEXT, published_at TEXT, data_json TEXT);
      CREATE TABLE sku_state (
        sku TEXT PRIMARY KEY,
        updated_at TEXT,
        data_json TEXT,
        strict INTEGER,
        stage TEXT
      );
    `);
    db.prepare("INSERT INTO sku_state (sku, updated_at, data_json, strict, stage) VALUES (?, ?, ?, 0, 'online')")
      .run("direct-source", "2026-08-15T12:00:00.000Z", JSON.stringify({
        store_id: 7,
        offer_id: "mz-150826-direct-source",
        outcome_status: "online",
        title: "Direct item",
      }));
  } finally {
    db.close();
  }
  try {
    const rows = loadStrictPublicationsReadOnly(dbFile);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sku, "direct-source");
    assert.equal(rows[0].data.offer_id, "mz-150826-direct-source");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("audit treats transient cost failures as pending instead of no-same-item", async () => {
  const auditor = createOnlineSupplyAuditor({
    costBridge: { estimate: async () => ({
      ok: false,
      deferred: true,
      terminal: false,
      reason: "worker timed out",
    }) },
    supplyVerifier: { verify: async () => { throw new Error("must not verify without candidates"); } },
    now: () => new Date("2026-08-15T12:00:00.000Z"),
    runDir: "/tmp",
    checkpointFile: "/tmp/unused-online-supply-audit-checkpoint.jsonl",
  });
  const result = await auditor.inspect({ offer_id: "mz-150826-transient" }, {
    sku: "transient",
    data: { title: "Transient", cover_image: "https://img.example/transient.jpg" },
  });
  assert.equal(result.category, "pending_recheck");
  assert.equal(result.recommendation_priority, undefined);
  assert.equal(result.priority, "medium");
});

test("audit rejects a blocked envelope carrying stale success evidence", async () => {
  const auditor = createOnlineSupplyAuditor({
    costBridge: { estimate: async () => { throw new Error("cached strict cost should be used"); } },
    supplyVerifier: { verify: async () => ({
      ok: false,
      supply_gate_passed: false,
      status: "blocked",
      deterministic: true,
      reason_code: "out_of_stock",
      reason: "target SKU is out of stock",
      evidence: evidence(),
    }) },
    now: () => new Date("2026-08-15T12:00:00.000Z"),
    runDir: "/tmp",
    checkpointFile: "/tmp/unused-online-supply-audit-checkpoint-2.jsonl",
  });
  const result = await auditor.inspect({ offer_id: "mz-150826-blocked" }, {
    sku: "blocked",
    data: { title: "Blocked", cost: { ...STRICT_COST } },
  });
  assert.equal(result.category, "out_of_stock_or_offline");
  assert.equal(result.supply_evidence, null);
});

test("audit searches replacement offers after deterministic failures", async () => {
  let costCalls = 0;
  let verifyCalls = 0;
  const replacementCost = {
    ...STRICT_COST,
    selected_offer_id: "1688003",
    selected_cluster_offer_ids: ["1688003"],
    balanced_supporting_offer_ids: ["1688003"],
  };
  const auditor = createOnlineSupplyAuditor({
    costBridge: { estimate: async (item) => {
      costCalls += 1;
      assert.deepEqual(item.excluded_1688_offer_ids, ["1688001", "1688002"]);
      return replacementCost;
    } },
    supplyVerifier: { verify: async ({ candidates }) => {
      verifyCalls += 1;
      if (verifyCalls === 1) return {
        ok: false,
        supply_gate_passed: false,
        status: "blocked",
        deterministic: true,
        reason_code: "all_candidates_failed",
        candidate_failures: candidates.map((row) => ({ ...row, reason_code: "offer_offline", deterministic: true })),
      };
      return supplyPass({
        offer_id: "1688003",
        offer_url: "https://detail.1688.com/offer/1688003.html",
      });
    } },
    now: () => new Date("2026-08-15T12:00:00.000Z"),
    runDir: "/tmp",
    checkpointFile: "/tmp/unused-online-supply-audit-checkpoint-3.jsonl",
  });
  const result = await auditor.inspect({ offer_id: "mz-150826-replacement" }, {
    sku: "replacement",
    data: { title: "Replacement", cover_image: "https://img.example/replacement.jpg", cost: { ...STRICT_COST } },
  });
  assert.equal(result.category, "verified_orderable");
  assert.equal(result.supply_evidence.offer_id, "1688003");
  assert.equal(costCalls, 1);
  assert.equal(verifyCalls, 2);
});

test("global login closure stops further 1688 checks and marks remaining rows pending", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "online-supply-global-close-"));
  try {
    let verifyCalls = 0;
    const auditor = createOnlineSupplyAuditor({
      costBridge: { estimate: async () => { throw new Error("strict costs are present"); } },
      supplyVerifier: { verify: async () => {
        verifyCalls += 1;
        return {
          ok: false,
          supply_gate_passed: false,
          status: "deferred",
          retryable: true,
          transient: true,
          global_gate_closed: true,
          alert_required: true,
          reason_code: "authentication_required",
        };
      } },
      now: () => new Date("2026-08-15T12:00:00.000Z"),
      runDir,
      checkpointFile: path.join(runDir, "checkpoint.jsonl"),
    });
    const onlineProducts = ["one", "two"].map((sku, index) => ({
      shop_id: 7,
      offer_id: `mz-150826-${sku}`,
      id: index + 1,
    }));
    const strictPublications = ["one", "two"].map((sku) => ({
      sku,
      data: { store_id: 7, offer_id: `mz-150826-${sku}`, cost: { ...STRICT_COST } },
    }));
    const result = await auditor.run({ onlineProducts, strictPublications });
    assert.equal(verifyCalls, 1);
    assert.deepEqual(result.rows.map((row) => row.category), ["pending_recheck", "pending_recheck"]);
    assert.equal(result.rows[1].reason, "1688-global-gate-closed");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("online audit separates spec, MOQ, stock and transient page failures", async () => {
  const rows = [
    { category: "wrong_spec", recommendation_priority: "high" },
    { category: "moq_gt_one", recommendation_priority: "high" },
    { category: "out_of_stock_or_offline", recommendation_priority: "critical" },
    { category: "pending_recheck", recommendation_priority: "medium" },
  ];
  assert.deepEqual(summarizeOnlineSupplyAudit(rows), {
    total: 4,
    by_status: {
      wrong_spec: 1,
      moq_gt_one: 1,
      out_of_stock_or_offline: 1,
      pending_recheck: 1,
    },
    by_priority: { high: 2, critical: 1, medium: 1 },
    verified_orderable: 0,
    review_recommended: 3,
    pending_recheck: 1,
  });
});
