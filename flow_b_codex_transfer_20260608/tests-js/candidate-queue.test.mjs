import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCandidateQueue } from "../scripts/flow_b_playwright/candidate-queue.mjs";

function card(sku, source = "https://www.ozon.ru/search/?text=kids&is_global=true") {
  return {
    href: `https://www.ozon.ru/product/sample-${sku}/`,
    source_url: source,
    text: `candidate ${sku}`,
    card_text: "199 ₽\n发货模式：FBS",
    image_url: `https://ir.ozone.ru/${sku}.jpg`,
  };
}

test("durable candidate queue restores complete discoveries without duplicating a SKU", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-candidate-queue-"));
  const filename = path.join(dir, "candidate_queue.jsonl");
  const queue = createCandidateQueue(filename, { now: () => new Date("2026-07-17T12:00:00.000Z") });
  await queue.load();
  assert.equal(await queue.discover([card("100"), card("100"), card("200")]), 2);

  const restored = createCandidateQueue(filename);
  await restored.load();
  assert.deepEqual(restored.pending().map((row) => row.sku), ["100", "200"]);
  assert.deepEqual(restored.pending()[0], {
    at: "2026-07-17T12:00:00.000Z",
    status: "discovered",
    sku: "100",
    href: "https://www.ozon.ru/product/sample-100/",
    source_url: "https://www.ozon.ru/search/?text=kids&is_global=true",
    text: "candidate 100",
    card_text: "199 ₽\n发货模式：FBS",
    image_url: "https://ir.ozone.ru/100.jpg",
  });
});

test("terminal outcomes leave the queue while deferred work survives restart", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-candidate-queue-state-"));
  const filename = path.join(dir, "candidate_queue.jsonl");
  const queue = createCandidateQueue(filename);
  await queue.load();
  await queue.discover([card("100"), card("200"), card("300")]);
  await queue.transition("100", "favorited", { reason: null });
  await queue.transition("200", "rejected", { reason: "non-pure-fbs" });
  await queue.transition("300", "deferred", { reason: "ozon-soft-block" });

  const restored = createCandidateQueue(filename);
  await restored.load();
  assert.deepEqual(restored.pending().map((row) => [row.sku, row.status]), [["300", "deferred"]]);
  assert.deepEqual(restored.stats(), {
    total: 3,
    pending: 1,
    by_status: { favorited: 1, rejected: 1, deferred: 1 },
  });
});

test("queue skips attempted work and tolerates an incomplete trailing record", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-candidate-queue-tail-"));
  const filename = path.join(dir, "candidate_queue.jsonl");
  const queue = createCandidateQueue(filename);
  await queue.load();
  await queue.discover([card("100"), card("200")]);
  await fs.appendFile(filename, "{\"broken\":");

  const restored = createCandidateQueue(filename);
  await restored.load();
  assert.deepEqual(restored.pending({ attempted: new Set(["100"]), limit: 1 }).map((row) => row.sku), ["200"]);
});

test("deferred candidates respect retry_at without becoming terminal", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-candidate-queue-retry-"));
  const filename = path.join(dir, "candidate_queue.jsonl");
  const queue = createCandidateQueue(filename);
  await queue.load();
  await queue.discover([card("100")]);
  await queue.transition("100", "deferred", { retry_at: "2026-07-17T12:10:00.000Z" });
  assert.deepEqual(queue.pending({ nowMs: Date.parse("2026-07-17T12:09:59.999Z") }), []);
  assert.deepEqual(queue.pending({ nowMs: Date.parse("2026-07-17T12:10:00.000Z") }).map((row) => row.sku), ["100"]);
});

test("queue exposes a deferred retry cooldown to retained replay", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-candidate-queue-cooldown-"));
  const queue = createCandidateQueue(path.join(dir, "candidate_queue.jsonl"));
  await queue.load();
  await queue.discover([card("100")]);
  await queue.transition("100", "deferred", { retry_at: "2026-07-17T12:10:00.000Z" });

  assert.equal(queue.inCooldown("100", { nowMs: Date.parse("2026-07-17T12:09:59.999Z") }), true);
  assert.equal(queue.inCooldown("100", { nowMs: Date.parse("2026-07-17T12:10:00.000Z") }), false);
  assert.equal(queue.inCooldown("missing", { nowMs: Date.parse("2026-07-17T12:09:59.999Z") }), false);
});

test("pending candidates round-robin sources and cap one source per consumer tranche", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-candidate-queue-fair-"));
  const queue = createCandidateQueue(path.join(dir, "candidate_queue.jsonl"));
  await queue.load();
  await queue.discover([
    card("101", "source-a"),
    card("102", "source-a"),
    card("103", "source-a"),
    card("201", "source-b"),
    card("202", "source-b"),
    card("301", "source-c"),
  ]);

  assert.deepEqual(queue.pending({ limit: 6, perSourceLimit: 2 }).map((row) => row.sku), [
    "101", "201", "301", "102", "202",
  ]);
});

test("pending source caps can group page variants into one source family", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-candidate-queue-family-"));
  const queue = createCandidateQueue(path.join(dir, "candidate_queue.jsonl"));
  await queue.load();
  await queue.discover([
    card("101", "source-a?page=4"),
    card("102", "source-a?page=5"),
    card("103", "source-a?page=6"),
    card("201", "source-b?page=2"),
  ]);

  assert.deepEqual(queue.pending({
    limit: 4,
    perSourceLimit: 2,
    sourceKey: (row) => String(row.source_url).split("?")[0],
  }).map((row) => row.sku), ["101", "201", "102"]);
});

test("pending priority is applied before the global limit without bypassing source caps", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-candidate-queue-priority-"));
  const queue = createCandidateQueue(path.join(dir, "candidate_queue.jsonl"));
  await queue.load();
  await queue.discover([
    { ...card("101", "source-a"), score: 1 },
    { ...card("102", "source-a"), score: 100 },
    { ...card("201", "source-b"), score: 50 },
    { ...card("301", "source-c"), score: 75 },
  ]);

  assert.deepEqual(queue.pending({
    limit: 3,
    perSourceLimit: 2,
    priority: (row) => ({ "101": 1, "102": 100, "201": 50, "301": 75 }[row.sku]),
  }).map((row) => row.sku), ["102", "301", "201"]);
});

test("pending drains every higher-priority source tranche before a lower-priority tier", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-candidate-queue-priority-tier-"));
  const queue = createCandidateQueue(path.join(dir, "candidate_queue.jsonl"));
  await queue.load();
  await queue.discover([
    ...Array.from({ length: 6 }, (_, index) => card(`10${index + 1}`, "source-high")),
    card("201", "source-low"),
  ]);

  assert.deepEqual(queue.pending({
    limit: 7,
    perSourceLimit: 6,
    priority: (row) => row.source_url === "source-high" ? 500_000 : 0,
  }).map((row) => row.sku), ["101", "102", "103", "104", "105", "106", "201"]);
});

test("discover enriches an existing pending SKU without clearing its retry window", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-candidate-queue-upsert-"));
  const filename = path.join(dir, "candidate_queue.jsonl");
  const queue = createCandidateQueue(filename, { now: () => new Date("2026-07-18T01:00:00.000Z") });
  await queue.load();
  await queue.discover([{ href: "https://www.ozon.ru/product/item-100/", source_url: "source-a" }]);
  await queue.transition("100", "deferred", {
    retry_at: "2026-07-18T01:10:00.000Z",
    reason: "ozon-soft-block",
  });

  assert.equal(await queue.discover([{
    ...card("100", "source-b"),
    sale_price: 799,
    title: "Rich title",
    cover_image: "https://ir.ozone.ru/rich.jpg",
    shipping_mode: "FBS",
  }]), 1);
  assert.deepEqual(queue.pending({ nowMs: Date.parse("2026-07-18T01:10:00.000Z") })[0], {
    at: "2026-07-18T01:00:00.000Z",
    status: "deferred",
    sku: "100",
    href: "https://www.ozon.ru/product/sample-100/",
    source_url: "source-b",
    text: "candidate 100",
    card_text: "199 ₽\n发货模式：FBS",
    image_url: "https://ir.ozone.ru/100.jpg",
    sale_price: 799,
    title: "Rich title",
    cover_image: "https://ir.ozone.ru/rich.jpg",
    shipping_mode: "FBS",
    retry_at: "2026-07-18T01:10:00.000Z",
    reason: "ozon-soft-block",
  });
});

test("candidate queue sidecar preserves pending order and terminal dedup across warm starts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-candidate-queue-index-"));
  const filename = path.join(dir, "candidate_queue.jsonl");
  const indexFile = path.join(dir, "candidate-index.json");
  const seeded = createCandidateQueue(filename, { indexFile });
  await seeded.load();
  await seeded.discover([card("100"), card("200"), card("300")]);
  await seeded.transition("100", "favorited", { oversized_debug_payload: "x".repeat(100_000) });
  await seeded.transition("200", "rejected", { reason: "non-pure-fbs" });
  await seeded.transition("300", "deferred", { retry_at: "2026-07-17T12:10:00.000Z" });

  const rebuilt = createCandidateQueue(filename, { indexFile });
  await rebuilt.load();
  assert.equal(rebuilt.indexStats().rebuilt, true);
  assert.deepEqual(rebuilt.pending({ nowMs: Date.parse("2026-07-17T12:10:00.000Z") }).map((row) => row.sku), ["300"]);
  assert.equal(await rebuilt.discover([card("100"), card("200")]), 0, "terminal SKUs remain final");
  const sidecar = JSON.parse(await fs.readFile(indexFile, "utf8"));
  assert.equal(sidecar.version, "candidate-queue-index-v1");
  assert.deepEqual(sidecar.entries.map((entry) => entry.row.sku), ["100", "200", "300"]);
  assert.equal(sidecar.entries.find((entry) => entry.row.sku === "100").row.oversized_debug_payload, undefined);

  const warm = createCandidateQueue(filename, { indexFile });
  await warm.load();
  assert.deepEqual(warm.indexStats(), { rebuilt: false, appended_bytes: 0 });
  assert.deepEqual(warm.stats(), rebuilt.stats());
});

test("candidate queue sidecar replays append bytes and safely rebuilds after a half-line or truncate", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-candidate-queue-index-recovery-"));
  const filename = path.join(dir, "candidate_queue.jsonl");
  const indexFile = path.join(dir, "candidate-index.json");
  const queue = createCandidateQueue(filename, { indexFile });
  await queue.load();
  await queue.discover([card("100")]);

  const first = createCandidateQueue(filename, { indexFile });
  await first.load();
  assert.equal(first.indexStats().rebuilt, true);
  const appendedRow = { ...card("200"), at: "2026-07-17T12:00:00.000Z", status: "discovered", sku: "200" };
  const payload = `${JSON.stringify(appendedRow)}\n`;
  await fs.appendFile(filename, payload);
  const appended = createCandidateQueue(filename, { indexFile });
  await appended.load();
  assert.deepEqual(appended.indexStats(), { rebuilt: false, appended_bytes: Buffer.byteLength(payload) });
  assert.deepEqual(appended.pending().map((row) => row.sku), ["100", "200"]);

  await fs.appendFile(filename, '{"sku":"300"');
  const halfLine = createCandidateQueue(filename, { indexFile });
  await halfLine.load();
  assert.equal(halfLine.indexStats().rebuilt, false);
  assert.deepEqual(halfLine.pending().map((row) => row.sku), ["100", "200"]);
  await fs.appendFile(filename, ',"status":"discovered","href":"https://www.ozon.ru/product/sample-300/"}\n');
  const completed = createCandidateQueue(filename, { indexFile });
  await completed.load();
  assert.equal(completed.indexStats().rebuilt, true);
  assert.deepEqual(completed.pending().map((row) => row.sku), ["100", "200", "300"]);

  await fs.writeFile(filename, `${JSON.stringify(appendedRow)}\n`);
  const truncated = createCandidateQueue(filename, { indexFile });
  await truncated.load();
  assert.equal(truncated.indexStats().rebuilt, true);
  assert.deepEqual(truncated.pending().map((row) => row.sku), ["200"]);
});
