import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CONTROL_STATUS_INDEX_VERSION,
  controlStatusDateKey,
  loadControlStatusIndex,
} from "../scripts/control-status-index.mjs";
import { status } from "../scripts/ozon_24h_control.mjs";

const line = (row) => `${JSON.stringify(row)}\n`;

async function fixture() {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-control-status-index-"));
  const indexFile = path.join(runDir, "status-index.json");
  const files = {
    funnel: path.join(runDir, "direct_funnel.jsonl"),
    accepted: path.join(runDir, "erp_accepted.jsonl"),
    background: path.join(runDir, "background_status.jsonl"),
  };
  await Promise.all(Object.values(files).map((filename) => fs.writeFile(filename, "")));
  return { runDir, indexFile, files };
}

test("control status index preserves every legacy panel counting semantic", async () => {
  const { runDir, indexFile, files } = await fixture();
  await fs.writeFile(files.funnel, [
    { sku: "a", stage: "candidate_required_fields_passed" },
    { sku: "a", stage: "candidate_required_fields_passed" },
    { data: { sku: "nested" }, stage: "snapshot_category_passed" },
    { sku: "cost", stage: "cost_passed" },
    { sku: "live", stage: "live_price_confirmed" },
    { sku: "profit", stage: "profit_passed" },
    { sku: "ignored", stage: "another_stage" },
  ].map(line).join("") + "{invalid-json\n");
  await fs.writeFile(files.accepted, [
    { sku: "previous", store_id: 1, accepted_at: "2026-07-31T15:59:59.999Z" },
    { sku: "today-a", store_id: 2, accepted_at: "2026-07-31T16:00:00.000Z" },
    { sku: "today-a", store_id: 3, accepted_at: "2026-08-01T01:00:00.000Z" },
    { data: { sku: "today-b", store_id: 4 }, at: "2026-08-01T15:59:59.999Z" },
    { sku: "tomorrow", store_id: 5, accepted_at: "2026-08-01T16:00:00.000Z" },
    { store_id: 2, accepted_at: "2026-08-01T02:00:00.000Z" },
  ].map(line).join("") + "null\n");
  await fs.writeFile(files.background, [
    { sku: "online-a", online: true },
    { sku: "online-a", online: false },
    { data: { sku: "online-b" }, online: true },
    { sku: "not-online", online: 1 },
  ].map(line).join(""));

  const result = await loadControlStatusIndex(runDir, {
    indexFile,
    now: "2026-08-01T12:00:00.000Z",
    timeZone: "Asia/Shanghai",
  });

  assert.deepEqual(result.stage_counts, {
    candidate_required_fields_passed: 1,
    snapshot_category_passed: 1,
    cost_passed: 1,
    live_price_confirmed: 1,
    profit_passed: 1,
  });
  assert.equal(result.run_accepted, 4);
  assert.deepEqual(result.by_store_run, {
    "1": 1,
    "2": 2,
    "3": 1,
    "5": 1,
    unknown: 2,
  });
  assert.deepEqual(result.today, {
    date: "2026-08-01",
    accepted: 2,
    by_store: { "3": 1, "4": 1 },
  });
  assert.equal(result.online, 2);
  assert.equal(result.index.rebuilt, true);
  assert.equal(result.index.persisted, true);
  const persisted = JSON.parse(await fs.readFile(indexFile, "utf8"));
  assert.equal(persisted.version, CONTROL_STATUS_INDEX_VERSION);
});

test("warm status reads no JSONL bytes and append replay updates exact counts", async () => {
  const { runDir, indexFile, files } = await fixture();
  await fs.writeFile(files.funnel, line({ sku: "a", stage: "profit_passed" }));
  await fs.writeFile(files.accepted, line({
    sku: "a",
    store_id: 10,
    accepted_at: "2026-08-12T00:00:00.000Z",
  }));
  await fs.writeFile(files.background, line({ sku: "a", online: true }));
  const options = {
    indexFile,
    now: "2026-08-12T12:00:00.000Z",
    timeZone: "Asia/Shanghai",
  };
  await loadControlStatusIndex(runDir, options);
  const warm = await loadControlStatusIndex(runDir, options);
  assert.equal(warm.index.rebuilt, false);
  assert.equal(warm.index.appended_bytes, 0);

  const funnelAppend = line({ sku: "b", stage: "profit_passed" });
  const acceptedAppend = line({
    sku: "b",
    store_id: 11,
    accepted_at: "2026-08-12T01:00:00.000Z",
  });
  const backgroundAppend = line({ sku: "b", online: true });
  await Promise.all([
    fs.appendFile(files.funnel, funnelAppend),
    fs.appendFile(files.accepted, acceptedAppend),
    fs.appendFile(files.background, backgroundAppend),
  ]);
  const appended = await loadControlStatusIndex(runDir, options);
  assert.equal(appended.index.rebuilt, false);
  assert.equal(
    appended.index.appended_bytes,
    Buffer.byteLength(funnelAppend + acceptedAppend + backgroundAppend),
  );
  assert.equal(appended.stage_counts.profit_passed, 2);
  assert.equal(appended.run_accepted, 2);
  assert.deepEqual(appended.by_store_run, { "10": 1, "11": 1 });
  assert.deepEqual(appended.today.by_store, { "10": 1, "11": 1 });
  assert.equal(appended.online, 2);
});

test("partial records, truncation, and rotation rebuild without loss or double counts", async () => {
  const { runDir, indexFile, files } = await fixture();
  await fs.writeFile(files.accepted, `${line({
    sku: "complete",
    store_id: 1,
    accepted_at: "2026-08-12T00:00:00.000Z",
  })}{"sku":"partial"`);
  const options = {
    indexFile,
    now: "2026-08-12T12:00:00.000Z",
    timeZone: "Asia/Shanghai",
  };
  const partial = await loadControlStatusIndex(runDir, options);
  assert.equal(partial.run_accepted, 1);
  assert.equal(partial.by_store_run["1"], 1);

  await fs.appendFile(files.accepted, "," + '"store_id":2,"accepted_at":"2026-08-12T01:00:00.000Z"}\n');
  const completed = await loadControlStatusIndex(runDir, options);
  assert.equal(completed.index.rebuilt, true);
  assert.equal(completed.run_accepted, 2);
  assert.deepEqual(completed.by_store_run, { "1": 1, "2": 1 });

  await fs.writeFile(files.accepted, line({
    sku: "truncated",
    store_id: 3,
    accepted_at: "2026-08-12T02:00:00.000Z",
  }));
  const truncated = await loadControlStatusIndex(runDir, options);
  assert.equal(truncated.index.rebuilt, true);
  assert.equal(truncated.run_accepted, 1);
  assert.deepEqual(truncated.by_store_run, { "3": 1 });

  await fs.rename(files.accepted, `${files.accepted}.old`);
  await fs.writeFile(files.accepted, line({
    sku: "rotated",
    store_id: 4,
    accepted_at: "2026-08-12T03:00:00.000Z",
  }));
  const rotated = await loadControlStatusIndex(runDir, options);
  assert.equal(rotated.index.rebuilt, true);
  assert.equal(rotated.run_accepted, 1);
  assert.deepEqual(rotated.by_store_run, { "4": 1 });
});

test("one index serves Shanghai midnight exactly and a timezone change invalidates it", async () => {
  const { runDir, indexFile, files } = await fixture();
  await fs.writeFile(files.accepted, [
    { sku: "day-one", store_id: 1, accepted_at: "2026-08-12T15:59:59.999Z" },
    { sku: "day-two", store_id: 2, accepted_at: "2026-08-12T16:00:00.000Z" },
  ].map(line).join(""));
  const dayOne = await loadControlStatusIndex(runDir, {
    indexFile,
    now: "2026-08-12T15:59:59.999Z",
    timeZone: "Asia/Shanghai",
  });
  assert.deepEqual(dayOne.today, {
    date: "2026-08-12",
    accepted: 1,
    by_store: { "1": 1 },
  });
  const dayTwo = await loadControlStatusIndex(runDir, {
    indexFile,
    now: "2026-08-12T16:00:00.000Z",
    timeZone: "Asia/Shanghai",
  });
  assert.equal(dayTwo.index.rebuilt, false);
  assert.deepEqual(dayTwo.today, {
    date: "2026-08-13",
    accepted: 1,
    by_store: { "2": 1 },
  });
  const utc = await loadControlStatusIndex(runDir, {
    indexFile,
    now: "2026-08-12T16:00:00.000Z",
    timeZone: "UTC",
  });
  assert.equal(utc.index.rebuilt, true);
  assert.deepEqual(utc.today, {
    date: "2026-08-12",
    accepted: 2,
    by_store: { "1": 1, "2": 1 },
  });
});

test("concurrent index writers leave an atomic parseable cache and converge", async () => {
  const { runDir, indexFile, files } = await fixture();
  await fs.writeFile(files.funnel, Array.from({ length: 1_000 }, (_, index) => line({
    sku: String(index),
    stage: "candidate_required_fields_passed",
  })).join(""));
  const options = { indexFile, now: "2026-08-12T12:00:00.000Z" };
  const results = await Promise.all(Array.from({ length: 4 }, () => (
    loadControlStatusIndex(runDir, options)
  )));
  assert.equal(results.every((result) => result.stage_counts.candidate_required_fields_passed === 1_000), true);
  assert.equal(JSON.parse(await fs.readFile(indexFile, "utf8")).version, CONTROL_STATUS_INDEX_VERSION);
  const converged = await loadControlStatusIndex(runDir, options);
  assert.equal(converged.stage_counts.candidate_required_fields_passed, 1_000);
  assert.equal(converged.index.appended_bytes, 0);
});

test("direct control status uses the incremental index without changing its output contract", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-control-status-wiring-"));
  const stateRoot = path.join(root, "state");
  const runDir = path.join(stateRoot, "runs", "fixture");
  await fs.mkdir(runDir, { recursive: true });
  const acceptedAt = new Date().toISOString();
  const date = controlStatusDateKey(acceptedAt);
  await Promise.all([
    fs.writeFile(path.join(stateRoot, "current_run.json"), `${JSON.stringify({
      run_id: "fixture",
      run_dir: runDir,
      formal_started: true,
      state_schema_version: 4,
    })}\n`),
    fs.writeFile(path.join(stateRoot, "operational_status.json"), `${JSON.stringify({
      status: "RUNNING",
      observed_at: acceptedAt,
    })}\n`),
    fs.writeFile(path.join(stateRoot, "process_owners.json"), "{}\n"),
    fs.writeFile(path.join(runDir, "direct_funnel.jsonl"), line({
      sku: "wired",
      stage: "profit_passed",
    })),
    fs.writeFile(path.join(runDir, "erp_accepted.jsonl"), line({
      sku: "wired",
      store_id: 123,
      accepted_at: acceptedAt,
    })),
    fs.writeFile(path.join(runDir, "background_status.jsonl"), line({
      sku: "wired",
      online: true,
    })),
  ]);
  const config = {
    install_root: path.join(root, "app"),
    state_root: stateRoot,
    runtime_mode: "direct",
    browser: {
      profile_dir: path.join(root, "unused-profile"),
      executable: path.join(root, "unused-chrome"),
    },
    flow_env: { FLOW_B_DAILY_STORE_TIMEZONE: "Asia/Shanghai" },
    daily_pricing_report: {
      time_zone: "Asia/Shanghai",
      cutoff: "20:00",
      report_after: "20:30",
      output_dir: path.join(root, "reports"),
    },
    stores: [{ id: 123, name: "fixture store" }],
  };

  const snapshot = await status(config);
  assert.equal(snapshot.target_metric, "daily_erp_accepted_unique_skus");
  assert.equal(snapshot.count_date, date);
  assert.equal(snapshot.run_accepted, 1);
  assert.equal(snapshot.funnel.profit_passed, 1);
  assert.equal(snapshot.funnel.erp_accepted, 1);
  assert.equal(snapshot.funnel.online, 1);
  assert.deepEqual(snapshot.by_store, { "123": 1 });
  assert.deepEqual(snapshot.by_store_run, { "123": 1 });
  assert.deepEqual(snapshot.daily_by_store["123"], {
    store_id: 123,
    store_name: "fixture store",
    target: 100,
    accepted: 1,
    remaining: 99,
  });
  const indexFile = path.join(stateRoot, "control_status_index_v1.json");
  assert.equal(JSON.parse(await fs.readFile(indexFile, "utf8")).version, CONTROL_STATUS_INDEX_VERSION);

  await fs.appendFile(path.join(runDir, "erp_accepted.jsonl"), line({
    sku: "wired-append",
    store_id: 123,
    accepted_at: acceptedAt,
  }));
  const appended = await status(config);
  assert.equal(appended.run_accepted, 2);
  assert.equal(appended.funnel.erp_accepted, 2);
  assert.deepEqual(appended.by_store, { "123": 2 });
});
