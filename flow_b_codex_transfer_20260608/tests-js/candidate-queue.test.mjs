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
