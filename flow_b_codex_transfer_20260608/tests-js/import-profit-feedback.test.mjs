import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  findFeedbackTable,
  importProfitFeedback,
} from "../scripts/import_profit_feedback.mjs";

const FIRST_IMPORT = new Date("2026-08-09T12:30:00.000Z");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-profit-feedback-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const feedbackDir = path.join(root, "核价反馈");
  const outputFile = path.join(root, "利润学习", "反馈.json");
  const stateFile = path.join(root, "利润学习", "反馈状态.json");
  const runtimeDbPath = path.join(root, "runtime.sqlite");
  await fs.mkdir(feedbackDir, { recursive: true });

  const database = new DatabaseSync(runtimeDbPath);
  database.exec("CREATE TABLE sku_state (sku TEXT PRIMARY KEY, updated_at TEXT, data_json TEXT)");
  const insert = database.prepare("INSERT INTO sku_state (sku, updated_at, data_json) VALUES (?, ?, ?)");
  for (const row of [
    ["source-normal", "store-normal", "111", "灯具", "家居照明"],
    ["source-loss", "store-loss", "222", "收纳盒", "家居收纳"],
    ["source-unavailable", "store-unavailable", "333", "夹子", "五金"],
    ["source-wrong-item", "store-wrong-item", "444", "杯架", "汽车用品"],
    ["source-wrong-spec", "store-wrong-spec", "555", "桌垫", "办公用品"],
  ]) {
    const [sourceSku, storeSku, selectedOfferId, title, category] = row;
    insert.run(sourceSku, "2026-08-09T08:00:00.000Z", JSON.stringify({
      store_id: 104965,
      store_sku: storeSku,
      offer_id: `own-${storeSku}`,
      title,
      category_name: category,
      purchase_price: 21.25,
      cost: {
        match_evidence_key: `evidence-${sourceSku}`,
        selected_offer_id: selectedOfferId,
        selected_offer_ids: [selectedOfferId, `cluster-peer-${selectedOfferId}`],
        matched_offer_ids: [selectedOfferId, `cluster-peer-${selectedOfferId}`],
      },
    }));
  }
  database.close();
  return { root, feedbackDir, outputFile, stateFile, runtimeDbPath };
}

async function writeFeedback(filename, contents, timestamp = FIRST_IMPORT) {
  await fs.writeFile(filename, contents, "utf8");
  await fs.utimes(filename, timestamp, timestamp);
}

function importerOptions(value, now = FIRST_IMPORT) {
  return {
    feedbackDir: value.feedbackDir,
    outputFile: value.outputFile,
    stateFile: value.stateFile,
    runtimeDbPath: value.runtimeDbPath,
    now,
  };
}

test("finds the minimum two-column feedback table after title rows", () => {
  const table = findFeedbackTable([
    ["Ozon每日人工核价"],
    ["生成时间", "2026-08-09"],
    ["本店 Ozon SKU", "核对结果"],
    ["001234567890", "正常"],
  ]);

  assert.deepEqual(table, {
    headers: ["本店 Ozon SKU", "核对结果"],
    rows: [["001234567890", "正常"]],
    header_index: 2,
  });
});

test("imports all five decisions, optional corrections and replacement URLs without blocking the replacement", async (t) => {
  const value = await fixture(t);
  const mainCsv = [
    "本店Ozon SKU,核对结果,实际采购价,正确1688链接,1688货源ID,处理动作,备注",
    "store-normal,正常,,,,保留,可信货源",
    "store-loss,亏本,42.80,https://detail.1688.com/offer/222.html,,人工下架,成本过高",
    "store-unavailable,无法采购,,,,人工下架,链接失效",
    "store-wrong-item,错货,,https://detail.1688.com/offer/999.html,cluster-peer-444,人工下架,正确货源是999",
    "store-wrong-spec,错规格,,https://detail.1688.com/offer/998.html,cluster-peer-555,人工下架,规格不符",
  ].join("\n");
  const minimumCsv = [
    "本店SKU,结果",
    "minimal-only,OK",
  ].join("\n");
  const duplicateCsv = [
    "store_sku,review_result",
    "minimal-only,normal",
  ].join("\n");
  await writeFeedback(path.join(value.feedbackDir, "01-main.csv"), mainCsv);
  await writeFeedback(path.join(value.feedbackDir, "02-minimum.csv"), minimumCsv);
  await writeFeedback(path.join(value.feedbackDir, "03-duplicate.csv"), duplicateCsv);

  const first = await importProfitFeedback(importerOptions(value));
  assert.equal(first.unchanged, undefined);
  assert.equal(first.imported_file_count, 3);
  assert.equal(first.imported_record_count, 7);
  assert.equal(first.row_error_count, 0);

  const artifact = JSON.parse(await fs.readFile(value.outputFile, "utf8"));
  assert.equal(artifact.trusted.records.length, 3);
  assert.equal(artifact.trusted.trusted.length, 2);
  assert.equal(artifact.trusted.trusted.find((row) => row.source_sku === "source-normal").actual_cost, 21.25);
  assert.equal(artifact.trusted.by_source_sku["source-normal"].selected_offer_id, "111");
  assert.equal(artifact.trusted.cost_corrections.length, 1);
  assert.equal(artifact.trusted.cost_corrections[0].actual_cost, 42.8);
  assert.equal(artifact.trusted.cost_corrections[0].title, "收纳盒");
  assert.equal(artifact.trusted.cost_corrections[0].category, "家居收纳");
  assert.equal(artifact.errors.records.length, 3);
  assert.equal(artifact.errors.blocked_offers.length, 1);
  assert.equal(artifact.errors.blocked_offers[0].selected_offer_id, "333");
  assert.equal(artifact.errors.blocked_matches.length, 2);

  const wrongItem = artifact.errors.blocked_matches.find((row) => row.source_sku === "source-wrong-item");
  const wrongSpec = artifact.errors.blocked_matches.find((row) => row.source_sku === "source-wrong-spec");
  assert.equal(wrongItem.selected_offer_id, "444");
  assert.equal(wrongItem.correct_1688_url, "https://detail.1688.com/offer/999.html");
  assert.equal(wrongSpec.selected_offer_id, "555");
  assert.equal(wrongSpec.correct_1688_url, "https://detail.1688.com/offer/998.html");
  assert.notEqual(wrongItem.selected_offer_id, "999");
  assert.notEqual(wrongSpec.selected_offer_id, "998");
  assert.equal(artifact.import.row_errors.length, 0);

  const firstOutput = await fs.readFile(value.outputFile, "utf8");
  const second = await importProfitFeedback(importerOptions(value, new Date("2026-08-09T13:00:00.000Z")));
  assert.equal(second.unchanged, true);
  assert.equal(await fs.readFile(value.outputFile, "utf8"), firstOutput);
  assert.deepEqual((await fs.readdir(path.dirname(value.outputFile))).filter((name) => name.includes(".tmp-")), []);
});

test("negative feedback without an exact current offer becomes a row error and never blocks the correct URL", async (t) => {
  const value = await fixture(t);
  await writeFeedback(path.join(value.feedbackDir, "unsafe.csv"), [
    "本店Ozon SKU,核对结果,正确1688链接",
    "unknown-unavailable,无法采购,https://detail.1688.com/offer/777.html",
    "unknown-wrong,错货,https://detail.1688.com/offer/888.html",
  ].join("\n"));

  const result = await importProfitFeedback(importerOptions(value));
  const artifact = JSON.parse(await fs.readFile(value.outputFile, "utf8"));
  assert.equal(result.row_error_count, 2);
  assert.equal(artifact.errors.blocked_offers.length, 0);
  assert.equal(artifact.errors.blocked_matches.length, 0);
  assert.equal(artifact.errors.records.length, 0);
  assert.match(artifact.import.row_errors[0].reason, /无法确定当前实际选中|缺少原始跟卖SKU/u);
  assert.equal(JSON.stringify(artifact).includes('"selected_offer_id": "777"'), false);
  assert.equal(JSON.stringify(artifact).includes('"selected_offer_id": "888"'), false);
});

test("a newer conflicting review replaces the prior decision while preserving old learning metadata", async (t) => {
  const value = await fixture(t);
  const filename = path.join(value.feedbackDir, "feedback.csv");
  await writeFeedback(filename, [
    "本店Ozon SKU,核对结果",
    "store-normal,正常",
  ].join("\n"), new Date("2026-08-09T10:00:00.000Z"));
  await importProfitFeedback(importerOptions(value, new Date("2026-08-09T10:01:00.000Z")));

  await writeFeedback(filename, [
    "本店Ozon SKU,核对结果,实际采购价",
    "store-normal,亏本,88",
  ].join("\n"), new Date("2026-08-09T11:00:00.000Z"));
  await importProfitFeedback(importerOptions(value, new Date("2026-08-09T11:01:00.000Z")));

  const artifact = JSON.parse(await fs.readFile(value.outputFile, "utf8"));
  assert.equal(artifact.trusted.trusted.length, 0);
  assert.equal(artifact.trusted.cost_corrections.length, 1);
  assert.equal(artifact.trusted.cost_corrections[0].actual_cost, 88);
  assert.equal(artifact.trusted.cost_corrections[0].title, "灯具");
  assert.equal(artifact.trusted.cost_corrections[0].category, "家居照明");
  assert.equal(artifact.trusted.cost_corrections[0].updated_at, "2026-08-09T11:00:00.000Z");
});

test("keeps a malformed existing error artifact untouched and records an import error", async (t) => {
  const value = await fixture(t);
  const malformed = "{ definitely-not-valid-json\n";
  await fs.mkdir(path.dirname(value.outputFile), { recursive: true });
  await fs.writeFile(value.outputFile, malformed, "utf8");
  await writeFeedback(path.join(value.feedbackDir, "feedback.csv"), [
    "本店Ozon SKU,核对结果",
    "store-normal,正常",
  ].join("\n"));

  await assert.rejects(
    importProfitFeedback(importerOptions(value)),
    /JSON|Unexpected|property name/u,
  );
  assert.equal(await fs.readFile(value.outputFile, "utf8"), malformed);
  const state = JSON.parse(await fs.readFile(value.stateFile, "utf8"));
  assert.equal(state.status, "error");
  assert.equal(state.reason, "existing-feedback-artifact-invalid");
  assert.equal(state.output, path.resolve(value.outputFile));
});
