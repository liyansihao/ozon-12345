import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createProfitFilesReader,
  feedbackExcludedOfferIds,
  manualFeedbackDecision,
  normalizeProfitPriority,
  prioritizeProfitRows,
  profitPriorityScore,
} from "../scripts/flow_b_playwright/profit-priority.mjs";

const priority = {
  version: 1,
  stores: [
    {
      store_id: "101",
      mother_products: [{
        source_sku: "mother-101",
        category: "Kitchen storage",
        title_keywords: ["kitchen", "organizer"],
        order_count: 5,
        contribution_profit_cny: 200,
      }],
    },
    {
      store_id: "202",
      mother_products: [{
        source_sku: "mother-202",
        category: "Pet supplies",
        title_keywords: ["pet", "brush"],
        order_count: 4,
        contribution_profit_cny: 100,
      }],
    },
  ],
};

test("stable per-store priority advances only that store's similar products", () => {
  const snapshot = { priority: normalizeProfitPriority(priority), feedback: {} };
  const original = [
    { sku: "plain", title: "phone cable" },
    { sku: "pet", title: "soft pet grooming brush" },
    { sku: "kitchen", title: "kitchen drawer organizer" },
    { sku: "plain-2", title: "phone charger" },
  ];

  assert.deepEqual(
    prioritizeProfitRows(original, snapshot, { storeId: 101 }).map((row) => row.sku),
    ["kitchen", "plain", "pet", "plain-2"],
  );
  assert.deepEqual(
    prioritizeProfitRows(original, snapshot, { storeId: 202 }).map((row) => row.sku),
    ["pet", "plain", "kitchen", "plain-2"],
  );
  assert.deepEqual(
    prioritizeProfitRows(original, snapshot, { storeId: 999 }).map((row) => row.sku),
    original.map((row) => row.sku),
  );
  assert.ok(profitPriorityScore(snapshot, original[2]) > 0, "scanner union should see every store mother");
  assert.deepEqual(original.map((row) => row.sku), ["plain", "pet", "kitchen", "plain-2"]);
});

test("manual feedback blocks global offers and only the specified wrong relation", () => {
  const feedback = {
    errors: {
      blocked_offers: [{ selected_offer_id: "bad-global" }],
      blocked_matches: [{ source_sku: "source-a", selected_offer_id: "bad-relation" }],
    },
    trusted: {
      cost_corrections: [{ source_sku: "source-loss", actual_cost: 42.5 }],
      trusted: [{ selected_offer_id: "trusted-offer" }],
    },
  };

  assert.equal(manualFeedbackDecision(feedback, { sourceSku: "any", offerIds: ["bad-global"] }).blocked, true);
  assert.equal(manualFeedbackDecision(feedback, { sourceSku: "source-a", offerIds: ["bad-relation"] }).blocked, true);
  assert.equal(manualFeedbackDecision(feedback, { sourceSku: "source-b", offerIds: ["bad-relation"] }).blocked, false);
  assert.equal(manualFeedbackDecision(feedback, { sourceSku: "source-loss" }).cost_override, 42.5);
  assert.equal(manualFeedbackDecision(feedback, { offerIds: ["trusted-offer"] }).trusted, true);
  assert.deepEqual(feedbackExcludedOfferIds(feedback, "source-a"), ["bad-global", "bad-relation"]);
  assert.deepEqual(feedbackExcludedOfferIds(feedback, "source-b"), ["bad-global"]);
});

test("missing or temporarily malformed sidecar files keep the original empty model", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "profit-priority-"));
  try {
    const priorityFile = path.join(directory, "优先母款.json");
    const feedbackFile = path.join(directory, "错误货源.json");
    const reader = createProfitFilesReader({ priorityFile, feedbackFile, refreshMs: 0 });
    assert.deepEqual((await reader.snapshot()).priority.stores, {});

    await fs.writeFile(priorityFile, "not-json", "utf8");
    await fs.writeFile(feedbackFile, "not-json", "utf8");
    const malformed = await reader.snapshot({ force: true });
    assert.deepEqual(malformed.priority.stores, {});
    assert.equal(manualFeedbackDecision(malformed.feedback, { sourceSku: "safe" }).blocked, false);

    await fs.rm(priorityFile);
    await fs.mkdir(priorityFile);
    const unreadable = await reader.snapshot({ force: true });
    assert.deepEqual(unreadable.priority.stores, {});
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("keeps independent last-known-good priority and error snapshots", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "profit-priority-lkg-"));
  try {
    const priorityFile = path.join(directory, "优先母款.json");
    const feedbackFile = path.join(directory, "错误货源.json");
    await fs.writeFile(priorityFile, `${JSON.stringify(priority)}\n`, "utf8");
    await fs.writeFile(feedbackFile, `${JSON.stringify({
      errors: { blocked_offers: [{ selected_offer_id: "never-reenable" }] },
    })}\n`, "utf8");
    const reader = createProfitFilesReader({ priorityFile, feedbackFile, refreshMs: 0 });
    const initial = await reader.snapshot();
    assert.ok(profitPriorityScore(initial, { title: "kitchen organizer" }) > 0);
    assert.equal(manualFeedbackDecision(initial.feedback, { offerIds: ["never-reenable"] }).blocked, true);

    await fs.writeFile(feedbackFile, "{broken", "utf8");
    await fs.writeFile(priorityFile, `${JSON.stringify({
      stores: [{ store_id: 101, mother_products: [{ title_keywords: ["updated-priority"] }] }],
    })}\n`, "utf8");
    const independentlyRefreshed = await reader.snapshot({ force: true });
    assert.ok(profitPriorityScore(independentlyRefreshed, { title: "updated-priority" }) > 0);
    assert.equal(
      manualFeedbackDecision(independentlyRefreshed.feedback, { offerIds: ["never-reenable"] }).blocked,
      true,
    );

    await fs.rm(priorityFile);
    await fs.rm(feedbackFile);
    const deleted = await reader.snapshot({ force: true });
    assert.ok(profitPriorityScore(deleted, { title: "updated-priority" }) > 0);
    assert.equal(manualFeedbackDecision(deleted.feedback, { offerIds: ["never-reenable"] }).blocked, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
