import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createPublishState,
  reconcileRuntimeAuditOutputs,
} from "../scripts/flow_b_playwright/publish-state.mjs";
import { createRuntimeState } from "../scripts/flow_b_playwright/runtime-state.mjs";

async function withTempDir(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-publish-sqlite-"));
  try {
    return await callback(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function strictPublication(sku, overrides = {}) {
  return {
    sku,
    profit_rate: 31.5,
    purchase_price: 10,
    online_status: "selling",
    stock: 1,
    mode: "FBS",
    shipping_mode: "FBS",
    preflight_mode: "FBS",
    fbs_evidence: {
      verified: true,
      observations: [{ mode: "FBS" }, { mode: "FBS" }],
    },
    cost_verified: true,
    cost_source: "search_first_page_p70_similarity_filtered",
    cost: {
      ok: true,
      cost: 10,
      source: "search_first_page_p70_similarity_filtered",
      prices: [9, 10, 11],
      match_evidence_key: "b".repeat(64),
      same_item_match: true,
      returned_evidence_verified: true,
      match_evidence_contract: "1688-returned-same-item-v2",
      matched_offer_count: 3,
    },
    cost_evidence: {
      contract: "1688-same-item-v1",
      source: "search_first_page_p70_similarity_filtered",
      reliable_source: true,
      same_item_match: true,
      match_evidence_key: "b".repeat(64),
      filtered_price_count: 3,
      returned_evidence_verified: true,
      match_evidence_contract: "1688-returned-same-item-v2",
      matched_offer_count: 3,
    },
    quality_gate_passed: true,
    quality_checks: {
      pure_fbs: true,
      reliable_1688_cost: true,
      profit_gt_30: true,
      prohibited_category: true,
      title: true,
      image: true,
      category: true,
      historical_and_cross_store_duplicate: true,
    },
    ...overrides,
  };
}

function sqliteCount(dbPath, table) {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
  } finally {
    database.close();
  }
}

test("external SQLite is authoritative while legacy JSONL and CSV remain compatible audit outputs", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const publishedCsv = path.join(dir, "published.csv");
    const legacyState = path.join(dir, "legacy-state.jsonl");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(publishedCsv, [
      "product_link",
      "https://www.ozon.ru/product/historical",
      "",
    ].join("\n"));
    const legacyText = `${JSON.stringify({
      sku: "legacy-poison",
      status: "skipped",
      data: { reason: "prohibited-category" },
    })}\n`;
    await fs.writeFile(legacyState, legacyText);

    const state = createPublishState({
      runDir,
      publishedCsv,
      pendingStateFiles: [legacyState],
      runtimeStateDbPath: dbPath,
    });
    await state.load();
    assert.equal(state.hasPublished("historical"), true);
    assert.equal(state.statusOf("legacy-poison"), "skipped");
    assert.equal(await state.recordPublished(strictPublication("strict-one")), true);
    assert.equal(await state.recordPublished(strictPublication("strict-one")), false);
    await state.close();

    assert.equal(sqliteCount(dbPath, "strict_publications"), 1);
    assert.match(await fs.readFile(path.join(runDir, "published.jsonl"), "utf8"), /strict-one/);
    assert.match(await fs.readFile(publishedCsv, "utf8"), /strict-one/);
    assert.match(await fs.readFile(path.join(runDir, "runtime_state_audit.jsonl"), "utf8"), /strict-confirmed/);
    assert.equal(await fs.readFile(legacyState, "utf8"), legacyText);

    const eventCount = sqliteCount(dbPath, "events");
    const restored = createPublishState({
      runDir,
      publishedCsv,
      runtimeStateDbPath: dbPath,
    });
    await restored.load();
    assert.equal(restored.hasPublished("strict-one"), true);
    assert.equal(restored.runPublishedCount(), 1);
    assert.equal(await restored.recordPublished(strictPublication("strict-one")), false);
    await restored.close();
    assert.equal(sqliteCount(dbPath, "events"), eventCount);
  });
});

test("SQLite-backed publish state terminalizes deterministic failures and enforces two transient failures per Shanghai day", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const publishedCsv = path.join(dir, "published.csv");
    const state = createPublishState({
      runDir,
      publishedCsv,
      runtimeStateDbPath: dbPath,
    });

    assert.equal(await state.transition("poison", "failed", {
      reason: "fbs-evidence-missing",
      terminal: true,
    }), true);
    assert.equal(await state.transition("poison", "processing", { reason: "must-not-run" }), false);
    assert.equal(state.entryOf("poison").data.terminal, true);

    const eligible = new Date(Date.now() - 1_000).toISOString();
    assert.equal(await state.transition("retry", "failed", {
      reason: "ozon-detail-soft-block-deferred",
      retry_at: eligible,
    }), true);
    assert.equal(await state.transition("retry", "processing", { reason: "retry-two" }), true);
    assert.equal(await state.transition("retry", "failed", {
      reason: "ozon-detail-soft-block-deferred",
      retry_at: eligible,
    }), true);
    assert.equal(await state.transition("retry", "processing", { reason: "forbidden-third-retry" }), false);
    assert.equal(state.canAttempt("retry").allowed, false);
    assert.equal(state.canAttempt("retry").reason, "daily-transient-limit");
    assert.equal(state.entryOf("retry").data.terminal, true);
    assert.equal(state.entryOf("retry").data.transient_attempts, 2);

    const pendingAt = new Date(Date.now() - 1_000).toISOString();
    assert.equal(await state.transition("pending", "processing", {
      reason: "publish-final-status-timeout",
      submitted: true,
      next_reconcile_at: pendingAt,
    }), true);
    assert.equal(await state.transition("pending", "processing", {
      reason: "reconciliation-import-pending",
      submitted: true,
      next_reconcile_at: pendingAt,
    }), true);
    assert.equal(await state.transition("pending", "processing", {
      reason: "reconciliation-import-pending",
      submitted: true,
      next_reconcile_at: pendingAt,
    }), false);
    assert.equal(state.entryOf("pending").data.terminal, true);
    assert.equal(state.entryOf("pending").data.transient_attempts, 2);
    await state.close();

    const auditRows = (await fs.readFile(path.join(runDir, "sku_states.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(auditRows.some((row) => row.data?.reason === "must-not-run"), false);
    assert.equal(auditRows.some((row) => row.data?.reason === "forbidden-third-retry"), false);
  });
});

test("SQLite-backed strict publication rejects weakened quality evidence before writing compatibility files", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const publishedCsv = path.join(dir, "published.csv");
    const state = createPublishState({
      runDir,
      publishedCsv,
      runtimeStateDbPath: dbPath,
    });

    await assert.rejects(
      state.recordPublished(strictPublication("bad-fbs", {
        mode: "FBO",
        shipping_mode: "FBO",
        fbs_evidence: { verified: false },
      })),
      /pure FBS/,
    );
    await assert.rejects(
      state.recordPublished(strictPublication("bad-profit", { profit_rate: 30 })),
      /profit_rate > 30/,
    );
    await assert.rejects(
      state.recordPublished(strictPublication("bad-cost", { purchase_price: 0 })),
      /reliable 1688 cost/,
    );
    await state.close();

    assert.equal(sqliteCount(dbPath, "strict_publications"), 0);
    await assert.rejects(fs.access(path.join(runDir, "published.jsonl")));
  });
});

test("load and close idempotently repair missing strict JSONL and CSV audit outputs from SQLite", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const publishedCsv = path.join(dir, "published.csv");
    const runtime = createRuntimeState({
      dbPath,
      now: () => new Date("2026-07-29T01:00:00.000Z"),
    });
    runtime.recordStrictPublication("repair-strict", {
      reason: "strict-confirmed",
      data: {
        ...strictPublication("repair-strict", {
          store_id: 106637,
          store_name: "丽丽二号",
          published_at: "2026-07-29T01:00:00.000Z",
        }),
        runtime_run_dir: path.resolve(runDir),
      },
    });
    runtime.close();

    const standalone = await reconcileRuntimeAuditOutputs({
      runDir,
      publishedCsv,
      runtimeStateDbPath: dbPath,
    });
    assert.equal(standalone.strict, 1);
    assert.equal(standalone.published_jsonl_added, 1);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = createPublishState({
        runDir,
        publishedCsv,
        runtimeStateDbPath: dbPath,
      });
      await state.load();
      assert.equal(state.runPublishedCount(), 1);
      await state.reconcileStrictAuditOutputs();
      await state.close();
    }

    const publishedRows = (await fs.readFile(path.join(runDir, "published.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    const stateRows = (await fs.readFile(path.join(runDir, "sku_states.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    const globalCsvRows = (await fs.readFile(publishedCsv, "utf8")).trim().split(/\r?\n/u);
    const storeCsvRows = (await fs.readFile(path.join(runDir, "published_store_106637.csv"), "utf8"))
      .trim().split(/\r?\n/u);
    assert.equal(publishedRows.filter((row) => row.sku === "repair-strict").length, 1);
    assert.equal(stateRows.filter((row) => row.sku === "repair-strict" && row.status === "published").length, 1);
    assert.equal(globalCsvRows.filter((row) => row.includes("/repair-strict")).length, 1);
    assert.equal(storeCsvRows.filter((row) => row.includes(",repair-strict,")).length, 1);
  });
});

test("close waits for ordinary active transitions and rejects operations started after closing", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "run");
    const dbPath = path.join(dir, "external-state", "runtime.sqlite");
    const state = createPublishState({
      runDir,
      publishedCsv: path.join(dir, "published.csv"),
      runtimeStateDbPath: dbPath,
    });
    await state.load();

    const inFlight = state.transition("in-flight", "processing", {
      reason: "processing-started",
    });
    const closing = state.close();
    await assert.rejects(
      state.transition("too-late", "processing", { reason: "must-not-start" }),
      /publish state is closing/,
    );
    assert.equal(await inFlight, true);
    await closing;
    await state.close();

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(
        database.prepare("SELECT count(*) AS count FROM sku_state WHERE sku = 'in-flight'").get().count,
        1,
      );
      assert.equal(
        database.prepare("SELECT count(*) AS count FROM sku_state WHERE sku = 'too-late'").get().count,
        0,
      );
    } finally {
      database.close();
    }
    assert.match(await fs.readFile(path.join(runDir, "sku_states.jsonl"), "utf8"), /in-flight/);
  });
});
