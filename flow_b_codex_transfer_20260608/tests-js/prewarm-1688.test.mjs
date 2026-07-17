import assert from "node:assert/strict";
import test from "node:test";

import { prewarmCandidateCosts, selectPrewarmCandidates } from "../scripts/flow_b_prewarm_1688.mjs";

test("prewarm selection keeps only latest complete unprocessed favorites", () => {
  const favoriteEvents = [
    { sku: "ready", status: "favorited", title: "old", cover_image: "https://img/ready", shipping_mode: "FBS", sale_price: 90, source_url: "https://source/1" },
    { sku: "ready", status: "favorited", title: "new", cover_image: "https://img/ready", shipping_mode: "FBS", sale_price: 100, source_url: "https://source/1" },
    { sku: "published", status: "favorited", title: "done", cover_image: "https://img/done", shipping_mode: "FBS", sale_price: 100, source_url: "https://source/2" },
    { sku: "incomplete", status: "favorited", title: "missing image", shipping_mode: "FBS", sale_price: 100, source_url: "https://source/3" },
    { sku: "submitted", status: "favorited", title: "pending", cover_image: "https://img/submitted", shipping_mode: "FBS", sale_price: 100, source_url: "https://source/6" },
    { sku: "removed", status: "favorited", title: "removed", cover_image: "https://img/removed", shipping_mode: "FBS", sale_price: 100, source_url: "https://source/4" },
    { sku: "removed", status: "rejected", reason: "non-pure-fbs" },
    { sku: "2815247918", status: "favorited", title: "bad", cover_image: "https://img/bad", shipping_mode: "FBS", sale_price: 100, source_url: "https://source/5" },
  ];
  const stateEvents = [
    { sku: "published", status: "published", data: { profit_rate: 50 } },
    { sku: "submitted", status: "processing", data: { submitted: true, offer_id: "mz-submitted" } },
  ];

  assert.deepEqual(selectPrewarmCandidates({ favoriteEvents, stateEvents }), [{
    sku: "ready",
    title: "new",
    cover_image: "https://img/ready",
    shipping_mode: "FBS",
    sale_price: 100,
    sell_price: 100,
    source_url: "https://source/1",
  }]);
});

test("prewarm runs bounded workers and distinguishes seed-price acceptance from rule rejection", async () => {
  let active = 0;
  let peak = 0;
  const bridge = {
    async estimate(item) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (item.sku === "cached") return { ok: true, cached: true };
      if (item.sku === "reliable") return { ok: true, cached: false };
      if (item.sku === "rejected") return { ok: false, reason: "no reliable match", cached: false };
      return { ok: false, error: { code: "image-download", message: "HTTP 404" }, cached: false };
    },
  };
  const outcomes = [];
  const summary = await prewarmCandidateCosts({
    candidates: ["cached", "reliable", "rejected", "error"].map((sku) => ({ sku, cover_image: `https://img/${sku}`, sell_price: 100 })),
    bridge,
    runDir: "/tmp/prewarm-test",
    concurrency: 2,
    onResult: (outcome) => outcomes.push(outcome),
  });

  assert.equal(peak, 2);
  assert.deepEqual(summary, {
    candidates: 4,
    completed: 4,
    cache_hits: 1,
    cache_misses: 3,
    seed_price_accepted: 2,
    rule_rejected: 1,
    errors: 1,
  });
  assert.equal(outcomes.length, 4);
  assert.deepEqual(outcomes.find((row) => row.item.sku === "error")?.result?.error, {
    code: "image-download",
    message: "HTTP 404",
  });
});
