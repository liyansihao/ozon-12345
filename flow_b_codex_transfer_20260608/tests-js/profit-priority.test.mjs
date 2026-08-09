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
  normalizeSeasonPriority,
  prioritizeProfitRows,
  profitPriorityScore,
  seasonDateKey,
  seasonPriorityScore,
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

const seasonCalendar = {
  schema_version: 1,
  time_zone: "Asia/Shanghai",
  events: [{
    id: "school-2026",
    sales_start: "2026-09-01",
    sales_end: "2026-09-05",
    lead_days: 45,
    categories: [{
      name: "Школьные принадлежности",
      keywords: ["канцтовары", "школьный пенал"],
      boost: 600,
    }],
  }],
};

test("seasonal calendar activates 45 days early on Shanghai date boundaries", () => {
  const season = normalizeSeasonPriority(seasonCalendar);
  const candidate = { title: "Школьный пенал для ученика" };
  assert.equal(season.events[0].active_from, "2026-07-18");
  assert.equal(seasonDateKey("2026-07-17T16:00:00.000Z"), "2026-07-18");
  assert.equal(seasonPriorityScore(season, candidate, { now: "2026-07-17T15:59:59.999Z" }), 0);
  assert.equal(seasonPriorityScore(season, candidate, { now: "2026-07-17T16:00:00.000Z" }), 600);
  assert.equal(seasonPriorityScore(season, candidate, { now: "2026-09-05T15:59:59.999Z" }), 600);
  assert.equal(seasonPriorityScore(season, candidate, { now: "2026-09-05T16:00:00.000Z" }), 0);
  assert.equal(normalizeSeasonPriority({
    events: [{
      sales_start: "2026-09-01",
      sales_end: "2026-09-05",
      categories: [{ name: "Канцтовары" }],
    }],
  }).events[0].lead_days, 45);
  assert.throws(() => normalizeSeasonPriority({
    events: [{
      sales_start: "2026-09-01",
      sales_end: "2026-09-05",
      lead_days: 30,
      categories: [{ name: "Канцтовары" }],
    }],
  }), /lead_days must equal 45/);
});

test("seasonal boosts are capped, use the maximum match, and remain a stable soft sort", () => {
  const season = normalizeSeasonPriority({
    time_zone: "Asia/Shanghai",
    events: [{
      sales_start: "2026-08-20",
      sales_end: "2026-09-10",
      lead_days: 45,
      categories: [
        { name: "Канцтовары", boost: 999 },
        { name: "Школьные товары", keywords: ["пенал"], boost: 700 },
      ],
    }],
  });
  const snapshot = { priority: normalizeProfitPriority({}), feedback: {}, season };
  const rows = [
    { sku: "plain-a", title: "Обычный кабель" },
    { sku: "season", title: "Канцтовары и пенал", category: "Канцтовары" },
    { sku: "plain-b", title: "Обычная лампа" },
  ];
  assert.equal(seasonPriorityScore(snapshot, rows[1], { now: "2026-08-09T00:00:00+08:00" }), 800);
  assert.deepEqual(
    prioritizeProfitRows(rows, snapshot, { now: "2026-08-09T00:00:00+08:00" }).map((row) => row.sku),
    ["season", "plain-a", "plain-b"],
  );
  const noActiveSeason = { ...snapshot, season: normalizeSeasonPriority({ events: [] }) };
  assert.deepEqual(
    prioritizeProfitRows(rows, noActiveSeason, { now: "2026-08-09T00:00:00+08:00" }).map((row) => row.sku),
    rows.map((row) => row.sku),
  );
  assert.equal(rows.length, 3);
  const broadSingle = normalizeSeasonPriority({
    events: [{
      sales_start: "2026-08-20",
      sales_end: "2026-09-10",
      lead_days: 45,
      categories: [{ name: "文具", keywords: ["набор"], boost: 800 }],
    }],
  });
  assert.equal(
    seasonPriorityScore(broadSingle, { title: "Большой набор игрушек" }, { now: "2026-08-09T00:00:00+08:00" }),
    0,
  );
});

test("profit mothers stay ahead of seasonal-only rows and use sales units with refund downweighting", () => {
  const mother = (fields) => ({
    stores: [{
      store_id: 101,
      mother_products: [{
        source_sku: "mother",
        title_keywords: ["organizer"],
        real_profit_cny: 1,
        ...fields,
      }],
    }],
  });
  const season = normalizeSeasonPriority({
    events: [{
      sales_start: "2026-08-20",
      sales_end: "2026-09-10",
      lead_days: 45,
      categories: [{ name: "Канцтовары", boost: 800 }],
    }],
  });
  const snapshot = {
    priority: normalizeProfitPriority(mother({ sales_units: 8, order_count: 1 })),
    feedback: {},
    season,
  };
  const ranked = prioritizeProfitRows([
    { sku: "season", title: "Канцтовары", category: "Канцтовары" },
    { sku: "profit", title: "drawer organizer" },
  ], snapshot, { storeId: 101, now: "2026-08-09T00:00:00+08:00" });
  assert.deepEqual(ranked.map((row) => row.sku), ["profit", "season"]);

  const exact = { sku: "mother", title: "organizer" };
  const scoreFor = (fields) => profitPriorityScore({
    priority: normalizeProfitPriority(mother(fields)),
    feedback: {},
    season: normalizeSeasonPriority({ events: [] }),
  }, exact, { storeId: 101 });
  assert.ok(scoreFor({ sales_units: 8, order_count: 1 }) > scoreFor({ order_count: 1 }));
  assert.ok(scoreFor({ completed_units: 8, refund_cancel_rate: 0.5 }) < scoreFor({ completed_units: 8 }));
});

test("seasonal boosts never offset confirmed loss similarity", () => {
  const snapshot = {
    priority: normalizeProfitPriority({}),
    feedback: {
      loss_sources: [{
        store_id: 101,
        title_keywords: ["winter", "boots"],
        real_profit_cny: -20,
      }],
    },
    season: normalizeSeasonPriority({
      events: [{
        sales_start: "2026-08-20",
        sales_end: "2026-09-10",
        lead_days: 45,
        categories: [{ name: "Зимняя обувь", keywords: ["winter boots"], boost: 800 }],
      }],
    }),
  };
  const loss = { sku: "loss", title: "winter boots" };
  assert.ok(profitPriorityScore(snapshot, loss, {
    storeId: 101,
    now: "2026-08-09T00:00:00+08:00",
  }) < 0);
  assert.deepEqual(prioritizeProfitRows([
    loss,
    { sku: "plain", title: "ordinary cable" },
  ], snapshot, {
    storeId: 101,
    now: "2026-08-09T00:00:00+08:00",
  }).map((row) => row.sku), ["plain", "loss"]);
});

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

test("duplicate mothers retain the highest sales units before orders or profit", () => {
  const normalized = normalizeProfitPriority({
    stores: [{
      store_id: 101,
      mother_products: [
        {
          source_sku: "duplicate",
          title_keywords: ["high volume"],
          sales_units: 100,
          order_count: 3,
          refund_cancel_rate: 0.1,
          real_profit_cny: 10,
        },
        {
          source_sku: "duplicate",
          title_keywords: ["more orders"],
          sales_units: 4,
          order_count: 4,
          refund_cancel_rate: 0,
          real_profit_cny: 1_000,
        },
      ],
    }],
  });

  assert.equal(normalized.stores[101].mothers.length, 1);
  assert.equal(normalized.stores[101].mothers[0].sales_units, 100);
  assert.deepEqual(normalized.stores[101].mothers[0].keywords, ["high volume"]);
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

test("keeps seasonal last-known-good by absolute path across reader instances", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "season-priority-lkg-"));
  try {
    const priorityFile = path.join(directory, "优先母款.json");
    const feedbackFile = path.join(directory, "错误货源.json");
    const seasonFile = path.join(directory, "季节优先类目.json");
    await fs.writeFile(priorityFile, `${JSON.stringify(priority)}\n`, "utf8");
    await fs.writeFile(feedbackFile, `${JSON.stringify({
      errors: { blocked_offers: [{ selected_offer_id: "still-blocked" }] },
    })}\n`, "utf8");
    await fs.writeFile(seasonFile, `${JSON.stringify(seasonCalendar)}\n`, "utf8");
    const initial = await createProfitFilesReader({
      priorityFile,
      feedbackFile,
      seasonFile,
      refreshMs: 0,
    }).snapshot();
    assert.equal(
      seasonPriorityScore(initial, { title: "Школьный пенал" }, { now: "2026-08-09T00:00:00+08:00" }),
      600,
    );

    await fs.writeFile(seasonFile, `${JSON.stringify({
      events: [{
        sales_start: "broken",
        sales_end: "2026-09-05",
        categories: [{ name: "Канцтовары" }],
      }],
    })}\n`, "utf8");
    await fs.writeFile(priorityFile, `${JSON.stringify({
      stores: [{ store_id: 101, mother_products: [{ title_keywords: ["fresh-priority"] }] }],
    })}\n`, "utf8");
    await fs.writeFile(feedbackFile, "{broken", "utf8");
    const recovered = await createProfitFilesReader({
      priorityFile,
      feedbackFile,
      seasonFile,
      refreshMs: 0,
    }).snapshot();
    assert.equal(
      seasonPriorityScore(recovered, { title: "Школьный пенал" }, { now: "2026-08-09T00:00:00+08:00" }),
      600,
    );
    assert.ok(profitPriorityScore(recovered, { title: "fresh-priority" }) > 0);
    assert.equal(manualFeedbackDecision(recovered.feedback, { offerIds: ["still-blocked"] }).blocked, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a first invalid seasonal file fails open without disturbing source order", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "season-priority-invalid-"));
  try {
    const seasonFile = path.join(directory, "季节优先类目.json");
    await fs.writeFile(seasonFile, `${JSON.stringify({
      events: [{
        sales_start: "2026-09-01",
        sales_end: "2026-09-05",
        lead_days: 45,
        categories: [{ name: "文具" }],
      }],
    })}\n`, "utf8");
    const snapshot = await createProfitFilesReader({ seasonFile, refreshMs: 0 }).snapshot();
    const rows = [{ sku: "a", title: "first" }, { sku: "b", title: "second" }];
    assert.deepEqual(
      prioritizeProfitRows(rows, snapshot, { now: "2026-08-09T00:00:00+08:00" }).map((row) => row.sku),
      ["a", "b"],
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
