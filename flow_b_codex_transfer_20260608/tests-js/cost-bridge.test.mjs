import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { compactCostOutput, createCostBridge, parseCostOutput } from "../scripts/flow_b_playwright/cost-bridge.mjs";

async function withTempDir(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-cost-bridge-"));
  try {
    return await callback(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function returnedSameItemOutput({
  request,
  prices = [10, 11, 12],
  source = "search_first_page_cluster_p70_similarity_filtered",
  selectedCost = 12,
  title = null,
  balancedPassed = true,
  matchType = "strong_single",
  imageAvailable = true,
  offerIds = null,
  adaptiveMatch = null,
  selectedClusterPrices = null,
} = {}) {
  const normalizedRequest = {
    expect_category: String(request?.expect_category || "").toLocaleLowerCase("und").trim(),
    expect_model: String(request?.expect_model || "").toLocaleLowerCase("und").trim(),
    expect_title: String(request?.expect_title || "").toLocaleLowerCase("und").trim(),
    expect_price_cny: Number.isFinite(Number(request?.expect_price_cny))
      && Number(request?.expect_price_cny) > 0
      ? Number(request.expect_price_cny)
      : null,
  };
  const modelHit = normalizedRequest.expect_model || "";
  const titleHit = normalizedRequest.expect_title.split(/\s+/u).find((token) => token.length >= 4) || "product";
  const returnedTitle = String(title || `${modelHit} ${titleHit} same product`).toLocaleLowerCase("und").trim();
  const semanticHits = modelHit
    ? { category: [], model: [modelHit], title: [titleHit].filter((hit) => returnedTitle.includes(hit)) }
    : { category: [], model: [], title: [titleHit] };
  const rows = prices.map((price, index) => ({
    offer_id: String(offerIds?.[index] || `offer-${index + 1}`),
    supplier_id: `supplier-${index + 1}`,
    supplier: `supplier ${index + 1}`,
    image_url: `https://img.example/offer-${index + 1}.jpg`,
    image: { available: imageAvailable && index === 0, score: imageAvailable && index === 0 ? 0.95 : 0 },
    rank: index + 1,
    price,
    semantic_hits: semanticHits,
    semantic_hits_v3: { model: modelHit ? [modelHit] : [], high_information: [titleHit], feature: [] },
    semantic_strength: modelHit ? "exact_model" : "two_high_information_terms",
    specs: {},
    spec_conflicts: [],
    accessory_conflict: false,
    title: returnedTitle,
  }));
  const exactSelected = rows.find((row) => Number(row.price) === Number(selectedCost));
  const selectedOfferId = exactSelected?.offer_id || "missing-selected-offer";
  const selectedCluster = selectedClusterPrices === null
    ? rows
    : rows.filter((row) => selectedClusterPrices.includes(Number(row.price)));
  const evidence = JSON.stringify({
    contract: "1688-returned-same-item-v3",
    cost_source: source,
    request: normalizedRequest,
    rows,
    selected_cluster: selectedCluster
      .map(({ offer_id, supplier_id, price }) => ({ offer_id, supplier_id, price })),
    selected_cost: selectedCost,
    selected_offer_id: selectedOfferId,
    balanced_match: {
      passed: balancedPassed,
      match_type: balancedPassed ? matchType : "rejected",
      reason: balancedPassed ? "test match" : "test rejection",
      image_available: imageAvailable,
      supporting_offer_ids: balancedPassed
        ? (matchType === "strong_single"
            ? [rows[0]?.offer_id].filter(Boolean)
            : rows.slice(0, 2).map((row) => row.offer_id))
        : [],
      expected_specs: {},
    },
  });
  const key = crypto.createHash("sha256").update(evidence).digest("hex");
  return [
    `SAME_ITEM_EVIDENCE ${evidence}`,
    `MATCH_EVIDENCE_KEY ${key}`,
    `SELECTED_OFFER_ID ${selectedOfferId}`,
    ...(adaptiveMatch ? [`ADAPTIVE_MATCH_JSON ${JSON.stringify(adaptiveMatch)}`] : []),
    `COST_SOURCE ${source}`,
    `FILTERED_FIRST_PAGE_PRICES ${JSON.stringify(prices)}`,
    `P70_COST ${selectedCost}`,
  ].join("\n");
}

function cliMatchRequest(args) {
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : "";
  };
  return {
    expect_title: value("--expect-title"),
    expect_model: value("--expect-model"),
    expect_category: value("--expect-category"),
    expect_price_cny: Number(value("--expect-price-cny")) || null,
  };
}

function adaptiveV5({
  action = "ALLOW",
  decision = action === "REJECT" ? "REJECT" : "FAST",
  evidenceComplete = true,
  policyReasons = action === "REJECT" ? ["strict policy rejection"] : ["strict policy allow"],
  selectedOfferId = "offer-1",
  priceCny = 100,
  valuableApplies = false,
  valuableCategory = null,
} = {}) {
  return {
    version: "adaptive-v5-shadow",
    decision,
    score: action === "REJECT" ? 25 : 95,
    reason: policyReasons[0] || "adaptive v5 decision",
    hard_conflicts: action === "REJECT" ? ["strict-policy-conflict"] : [],
    missing_evidence: evidenceComplete ? [] : ["selected_offer_binding"],
    selected_offer_id: selectedOfferId,
    supporting_offer_ids: selectedOfferId ? [selectedOfferId] : [],
    action,
    policy_version: "adaptive-v5-policy-1",
    policy_reasons: policyReasons,
    evidence_complete: evidenceComplete,
    valuable_digital: {
      applies: valuableApplies,
      category: valuableCategory,
      price_cny: priceCny,
      threshold_cny: 300,
    },
  };
}

function genericFetchFailure(code, causeMessage = code) {
  const error = new TypeError("fetch failed");
  error.cause = Object.assign(new Error(causeMessage), { code });
  return error;
}

test("manual feedback can stop a blocked source before image download or 1688", async () => {
  await withTempDir(async (runDir) => {
    const feedbackFile = path.join(runDir, "错误货源.json");
    await fs.writeFile(feedbackFile, JSON.stringify({
      blocked_source_skus: [{ source_sku: "blocked-source" }],
    }));
    let downloads = 0;
    let processes = 0;
    const bridge = createCostBridge({
      feedbackFile,
      minimumSameItemMatches: 1,
      download: async () => { downloads += 1; },
      runProcess: async () => { processes += 1; return { code: 1, stdout: "", stderr: "" }; },
    });
    await bridge.refreshProfitFeedback();
    const result = await bridge.estimate({
      sku: "blocked-source",
      cover_image: "https://img.example/blocked.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(result.ok, false);
    assert.equal(result.feedback_blocked, true);
    assert.equal(downloads, 0);
    assert.equal(processes, 0);
    await bridge.close();
  });
});

test("new feedback invalidates an old good match and excludes the bad offer on retry", async () => {
  await withTempDir(async (runDir) => {
    const feedbackFile = path.join(runDir, "错误货源.json");
    await fs.writeFile(feedbackFile, "{}\n");
    let processes = 0;
    const bridge = createCostBridge({
      feedbackFile,
      minimumSameItemMatches: 1,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async ({ args }) => {
        processes += 1;
        const excludedIndex = args.indexOf("--exclude-offer-id");
        const excluded = excludedIndex >= 0 ? args[excludedIndex + 1] : null;
        const request = cliMatchRequest(args);
        return {
          code: 0,
          stdout: returnedSameItemOutput({
            request,
            prices: [18],
            selectedCost: 18,
            offerIds: [excluded === "offer-1" ? "offer-2" : "offer-1"],
          }),
          stderr: "",
        };
      },
    });
    await bridge.refreshProfitFeedback();
    const item = {
      sku: "feedback-retry",
      cover_image: "https://img.example/feedback-retry.jpg",
      sell_price: 100,
      expect_title: "same product lamp",
    };
    const first = await bridge.estimate(item, runDir);
    assert.deepEqual(first.selected_offer_ids, ["offer-1"]);

    await fs.writeFile(feedbackFile, JSON.stringify({
      errors: { blocked_offers: [{ selected_offer_id: "offer-1" }] },
    }));
    await bridge.refreshProfitFeedback();
    const second = await bridge.estimate(item, runDir);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.deepEqual(second.selected_offer_ids, ["offer-2"]);
    assert.equal(processes, 2);
    await bridge.close();
  });
});

test("manual offer blacklist overrides an enforced adaptive REJECT result", async () => {
  await withTempDir(async (runDir) => {
    const feedbackFile = path.join(runDir, "错误货源.json");
    await fs.writeFile(feedbackFile, JSON.stringify({
      errors: { blocked_offers: [{ selected_offer_id: "offer-1" }] },
    }));
    const bridge = createCostBridge({
      feedbackFile,
      feedbackRefreshMs: 0,
      adaptiveActionPolicy: "enforce",
      minimumSameItemMatches: 1,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async ({ args }) => ({
        code: 0,
        stdout: returnedSameItemOutput({
          request: cliMatchRequest(args),
          prices: [18],
          selectedCost: 18,
          offerIds: ["offer-1"],
          adaptiveMatch: adaptiveV5({ action: "REJECT", selectedOfferId: "offer-1" }),
        }),
        stderr: "",
      }),
    });
    await bridge.refreshProfitFeedback();
    const result = await bridge.estimate({
      sku: "manual-priority",
      cover_image: "https://img.example/manual-priority.jpg",
      sell_price: 100,
      expect_title: "same product lamp",
    }, runDir);
    assert.equal(result.ok, false);
    assert.equal(result.feedback_blocked, true);
    assert.equal(result.adaptive_action_rejected, true);
    assert.equal(result.reason, "manual-feedback-blocked-1688-offer");
    await bridge.close();
  });
});

test("recent normal feedback with exact verified offer and sane cost bypasses the image matcher", async () => {
  await withTempDir(async (runDir) => {
    const nowMs = Date.parse("2026-08-09T12:00:00.000Z");
    const request = { expect_title: "same product lamp" };
    const verifiedCost = parseCostOutput(returnedSameItemOutput({
      request,
      prices: [18],
      selectedCost: 18,
      offerIds: ["trusted-exact"],
    }), 100, {
      expectedMatchEvidence: request,
      requireSameItemEvidence: true,
      minimumSameItemMatches: 1,
    });
    const feedbackFile = path.join(runDir, "错误货源.json");
    await fs.writeFile(feedbackFile, JSON.stringify({
      trusted: {
        trusted: [{
          source_sku: "trusted-source",
          selected_offer_id: "trusted-exact",
          actual_cost: 20,
          updated_at: "2026-08-08T12:00:00.000Z",
          verified_cost: verifiedCost,
        }],
      },
    }));
    let downloads = 0;
    let processes = 0;
    const bridge = createCostBridge({
      feedbackFile,
      feedbackRefreshMs: 0,
      adaptiveActionPolicy: "enforce",
      minimumSameItemMatches: 1,
      now: () => nowMs,
      download: async () => { downloads += 1; },
      runProcess: async () => { processes += 1; return { code: 1, stdout: "", stderr: "unexpected" }; },
    });
    await bridge.refreshProfitFeedback();
    const result = await bridge.estimate({
      sku: "trusted-source",
      cover_image: "https://img.example/trusted.jpg",
      sell_price: 100,
      expect_title: "same product lamp",
    }, runDir);
    assert.equal(result.ok, true);
    assert.equal(result.cost, 20);
    assert.equal(result.selected_offer_id, "trusted-exact");
    assert.equal(result.manual_feedback_cache, true);
    assert.equal(result.adaptive_action_override, "ALLOW");
    assert.equal(result.adaptive_action_override_source, "trusted-verified-feedback");
    assert.equal(result.adaptive_action_policy_effective, "enforce");
    assert.equal(downloads, 0);
    assert.equal(processes, 0);
    await bridge.close();
  });
});

test("stale or invalid normal feedback falls back to the normal matcher", async () => {
  await withTempDir(async (runDir) => {
    const nowMs = Date.parse("2026-08-09T12:00:00.000Z");
    const request = { expect_title: "same product lamp" };
    const verifiedCost = parseCostOutput(returnedSameItemOutput({
      request,
      prices: [18],
      selectedCost: 18,
      offerIds: ["trusted-exact"],
    }), 100, {
      expectedMatchEvidence: request,
      requireSameItemEvidence: true,
      minimumSameItemMatches: 1,
    });
    const feedbackFile = path.join(runDir, "错误货源.json");
    await fs.writeFile(feedbackFile, JSON.stringify({
      trusted: {
        trusted: [
          {
            source_sku: "stale-source",
            selected_offer_id: "trusted-exact",
            actual_cost: 20,
            updated_at: "2026-05-01T00:00:00.000Z",
            verified_cost: verifiedCost,
          },
          {
            source_sku: "invalid-source",
            selected_offer_id: "replacement-not-selected",
            actual_cost: 20,
            updated_at: "2026-08-08T12:00:00.000Z",
            verified_cost: verifiedCost,
          },
        ],
      },
    }));
    let processes = 0;
    const bridge = createCostBridge({
      feedbackFile,
      feedbackRefreshMs: 0,
      minimumSameItemMatches: 1,
      now: () => nowMs,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async ({ args }) => {
        processes += 1;
        return {
          code: 0,
          stdout: returnedSameItemOutput({
            request: cliMatchRequest(args),
            prices: [18],
            selectedCost: 18,
            offerIds: [`fresh-${processes}`],
          }),
          stderr: "",
        };
      },
    });
    await bridge.refreshProfitFeedback();
    for (const source of ["stale-source", "invalid-source"]) {
      const result = await bridge.estimate({
        sku: source,
        cover_image: `https://img.example/${source}.jpg`,
        sell_price: 100,
        expect_title: "same product lamp",
      }, runDir);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.manual_feedback_cache, undefined);
    }
    assert.equal(processes, 2);
    await bridge.close();
  });
});

test("accepts a reliable filtered first-page P70 cost", () => {
  const text = [
    "VALID_COUNT 5",
    "P70_COST 21.3",
    "COST_SOURCE search_first_page_p70_similarity_filtered",
    "FILTERED_FIRST_PAGE_PRICES [17, 19.8, 21.3, 23.8]",
  ].join("\n");

  assert.deepEqual(parseCostOutput(text, 100), {
    ok: true,
    cost: 21.3,
    source: "search_first_page_p70_similarity_filtered",
    prices: [17, 19.8, 21.3, 23.8],
  });
});

test("verifies returned offer identities, semantics, prices, source and selected cost for strict proof", () => {
  const request = { expect_title: "same product lamp" };
  const output = returnedSameItemOutput({
    request,
    prices: [17, 19.8, 21.3, 23.8],
    selectedClusterPrices: [17, 19.8, 21.3],
    source: "search_first_page_p70_similarity_filtered",
    selectedCost: 21.3,
  });
  const result = parseCostOutput(output, 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.same_item_match, true);
  assert.equal(result.returned_evidence_verified, true);
  assert.equal(result.match_evidence_contract, "1688-returned-same-item-v3");
  assert.equal(result.matched_offer_count, 4);
  assert.deepEqual(result.selected_cluster_prices, [17, 19.8, 21.3]);
  assert.match(result.match_evidence_key, /^[a-f0-9]{64}$/u);
});

test("signed evidence cannot be reused when the expected sale price changes", () => {
  const signedRequest = { expect_title: "same product lamp", expect_price_cny: 100 };
  const output = returnedSameItemOutput({
    request: signedRequest,
    prices: [18],
    selectedCost: 18,
  });
  const result = parseCostOutput(output, 101, {
    expectedMatchEvidence: { ...signedRequest, expect_price_cny: 101 },
    requireSameItemEvidence: true,
    minimumSameItemMatches: 1,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /request (?:does not match|mismatch)/i);
});

test("direct publishing accepts one verified same-item offer", () => {
  const request = { expect_title: "same product lamp" };
  const output = returnedSameItemOutput({
    request,
    prices: [18],
    selectedCost: 18,
  });
  const result = parseCostOutput(output, 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    minimumSameItemMatches: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.cost, 18);
  assert.equal(result.matched_offer_count, 1);
  assert.equal(result.same_item_match, true);
});

test("fresh submission rejects legacy v2 evidence while historical verification remains compatible", () => {
  const request = { expect_title: "same product lamp" };
  const v3 = returnedSameItemOutput({ request, prices: [18], selectedCost: 18 });
  const encoded = JSON.parse(v3.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
  encoded.contract = "1688-returned-same-item-v2";
  delete encoded.balanced_match;
  const legacyEvidence = JSON.stringify(encoded);
  const legacy = v3
    .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${legacyEvidence}`)
    .replace(/^MATCH_EVIDENCE_KEY\s+.+$/mu, `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(legacyEvidence).digest("hex")}`);
  const compatible = parseCostOutput(legacy, 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    minimumSameItemMatches: 1,
  });
  const fresh = parseCostOutput(legacy, 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    minimumSameItemMatches: 1,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  });
  assert.equal(compatible.ok, true);
  assert.equal(fresh.ok, false);
  assert.match(fresh.reason, /requires 1688-returned-same-item-v3/i);
});

test("v3 evidence rejects a re-signed supplier binding tamper", () => {
  const request = { expect_title: "same product lamp" };
  const output = returnedSameItemOutput({ request, prices: [18], selectedCost: 18 });
  const evidence = JSON.parse(output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
  evidence.selected_cluster[0].supplier_id = "forged-supplier";
  const encoded = JSON.stringify(evidence);
  const resigned = output
    .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
    .replace(/^MATCH_EVIDENCE_KEY\s+.+$/mu, `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`);
  const result = parseCostOutput(resigned, 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    minimumSameItemMatches: 1,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /supplier is not bound/i);
});

test("rejects an emitted selected offer that differs from the matcher-signed exact identity", () => {
  const request = { expect_title: "same product lamp" };
  const output = returnedSameItemOutput({
    request,
    prices: [17, 19.8, 21.3],
    selectedCost: 21.3,
    offerIds: ["cluster-first", "cluster-middle", "exact-selected"],
  }).replace("SELECTED_OFFER_ID exact-selected", "SELECTED_OFFER_ID cluster-first");
  const result = parseCostOutput(output, 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match signed evidence/i);
});

test("shadow records legacy passes and automatically enforces balanced v3 after healthy samples", async () => {
  await withTempDir(async (runDir) => {
    let runs = 0;
    const bridge = createCostBridge({
      matchPolicy: "shadow",
      matchPolicySampleSize: 2,
      matchPolicyRetentionPercent: 75,
      matchPolicyImageAvailabilityPercent: 90,
      matchPolicyP95Ms: 15_000,
      minimumSameItemMatches: 1,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async ({ args }) => {
        runs += 1;
        const request = cliMatchRequest(args);
        return {
          code: 0,
          stdout: returnedSameItemOutput({
            request,
            prices: [18],
            selectedCost: 18,
            balancedPassed: runs <= 2,
          }),
          stderr: "",
        };
      },
    });
    const item = (sku) => ({
      sku,
      cover_image: `https://img.example/${sku}.jpg`,
      sell_price: 100,
      expect_title: "same product lamp",
    });
    const first = await bridge.estimate(item("shadow-1"), runDir);
    const second = await bridge.estimate(item("shadow-2"), runDir);
    const rejected = await bridge.estimate(item("balanced-3"), runDir);
    const state = JSON.parse(await fs.readFile(path.join(runDir, "1688_match_policy.json"), "utf8"));
    const logLines = (await fs.readFile(path.join(runDir, "1688_match_quality.jsonl"), "utf8")).trim().split("\n");

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.match_policy_promoted, true);
    assert.equal(state.effective_policy, "balanced");
    assert.equal(state.summary.sample_count, 2);
    assert.equal(state.summary.retention_percent, 100);
    assert.equal(state.summary.image_availability_percent, 100);
    assert.equal(logLines.length, 2);
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /balanced 1688 match rejected/i);
    await bridge.close();
  });
});

test("adaptive v4 REJECT remains telemetry-only in shadow and survives cache reuse", async () => {
  await withTempDir(async (runDir) => {
    let runs = 0;
    const adaptiveMatch = {
      version: "adaptive-v4-shadow",
      decision: "REJECT",
      score: 28.5,
      reason: "explicit model conflict",
      hard_conflicts: ["model:x200-fe!=x200s"],
      missing_evidence: [],
      selected_offer_id: "offer-1",
      supporting_offer_ids: ["offer-1"],
    };
    const bridge = createCostBridge({
      matchPolicy: "shadow",
      matchPolicySampleSize: 10,
      minimumSameItemMatches: 1,
      cacheFlushDebounceMs: 0,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async ({ args }) => {
        runs += 1;
        return {
          code: 0,
          stdout: returnedSameItemOutput({
            request: cliMatchRequest(args),
            prices: [18],
            selectedCost: 18,
            adaptiveMatch,
          }),
          stderr: "",
        };
      },
    });
    const item = {
      sku: "adaptive-reject-1",
      cover_image: "https://img.example/adaptive-reject.jpg",
      sell_price: 100,
      expect_title: "same product lamp",
    };
    const first = await bridge.estimate(item, runDir);
    const cached = await bridge.estimate({ ...item, sku: "adaptive-reject-2" }, runDir);
    await bridge.close();

    assert.equal(first.ok, true, "adaptive REJECT must not change production acceptance in shadow");
    assert.equal(first.match_policy_effective, "shadow");
    assert.deepEqual(first.adaptive_match, adaptiveMatch);
    assert.equal(cached.ok, true);
    assert.equal(cached.shared_cache, true);
    assert.deepEqual(cached.adaptive_match, adaptiveMatch);
    assert.equal(runs, 1);

    const quality = JSON.parse((await fs.readFile(path.join(runDir, "1688_match_quality.jsonl"), "utf8")).trim());
    const state = JSON.parse(await fs.readFile(path.join(runDir, "1688_match_policy.json"), "utf8"));
    assert.equal(quality.adaptive_decision, "REJECT");
    assert.equal(quality.adaptive_score, 28.5);
    assert.equal(state.summary.adaptive_sample_count, 1);
    assert.equal(state.summary.fast_count, 0);
    assert.equal(state.summary.fast_percent, 0);
    assert.equal(state.summary.review_count, 0);
    assert.equal(state.summary.review_percent, 0);
    assert.equal(state.summary.reject_count, 1);
    assert.equal(state.summary.reject_percent, 100);
  });
});

test("adaptive v5 shadow collects complete action samples without auto-enforcing at the target", async () => {
  await withTempDir(async (runDir) => {
    const adaptiveMatches = [
      adaptiveV5({ action: "REJECT", evidenceComplete: false }),
      {
        version: "adaptive-v4-shadow",
        decision: "REVIEW",
        score: 60,
        reason: "legacy review",
        hard_conflicts: [],
        missing_evidence: ["material"],
        selected_offer_id: "offer-1",
        supporting_offer_ids: ["offer-1"],
      },
      adaptiveV5({ action: "REJECT" }),
      adaptiveV5({ action: "ALLOW" }),
      adaptiveV5({ action: "REJECT" }),
    ];
    let runs = 0;
    const bridge = createCostBridge({
      adaptiveActionPolicy: "shadow",
      adaptiveActionSampleTarget: 2,
      matchPolicy: "shadow",
      matchPolicySampleSize: 100,
      minimumSameItemMatches: 1,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async ({ args }) => {
        const adaptiveMatch = adaptiveMatches[runs++];
        return {
          code: 0,
          stdout: returnedSameItemOutput({
            request: cliMatchRequest(args),
            prices: [18],
            selectedCost: 18,
            adaptiveMatch,
          }),
          stderr: "",
        };
      },
    });
    const estimate = (index) => bridge.estimate({
      sku: `v5-shadow-${index}`,
      cover_image: `https://img.example/v5-shadow-${index}.jpg`,
      sell_price: 100,
      expect_title: "same product lamp",
    }, runDir);
    const incomplete = await estimate(1);
    const legacy = await estimate(2);
    const firstComplete = await estimate(3);
    const targetComplete = await estimate(4);
    const afterTarget = await estimate(5);
    await bridge.close();

    assert.equal(incomplete.ok, true);
    assert.equal(legacy.ok, true);
    assert.equal(firstComplete.ok, true);
    assert.equal(firstComplete.adaptive_action_policy_effective, "shadow");
    assert.equal(targetComplete.ok, true);
    assert.equal(afterTarget.ok, true, "finishing collection must not auto-switch action enforcement");
    const state = JSON.parse(await fs.readFile(path.join(runDir, "1688_match_policy.json"), "utf8"));
    assert.equal(state.adaptive_action_policy, "shadow");
    assert.equal(state.action_samples.length, 2);
    assert.deepEqual(state.action_samples.map((row) => row.adaptive_action), ["REJECT", "ALLOW"]);
    assert.equal(state.summary.complete_action_samples, 2);
    assert.equal(state.summary.sample_target, 2);
    assert.equal(state.summary.collection_status, "complete");
    assert.equal(state.summary.action_allow_count, 1);
    assert.equal(state.summary.action_reject_count, 1);
    assert.equal(state.summary.adaptive_sample_count, 5, "legacy three-state summary remains available");
  });
});

test("adaptive v5 enforce blocks only a complete REJECT and bypasses the legacy balanced gate", async () => {
  await withTempDir(async (runDir) => {
    const outputs = [
      { adaptiveMatch: adaptiveV5({ action: "ALLOW" }), balancedPassed: false },
      { adaptiveMatch: adaptiveV5({ action: "REJECT" }), balancedPassed: true },
      { adaptiveMatch: adaptiveV5({ action: "REJECT", evidenceComplete: false }), balancedPassed: false },
      {
        adaptiveMatch: {
          version: "adaptive-v4-shadow",
          decision: "REVIEW",
          score: 60,
          reason: "legacy review",
          hard_conflicts: [],
          missing_evidence: ["material"],
          selected_offer_id: "offer-1",
          supporting_offer_ids: ["offer-1"],
        },
        balancedPassed: false,
      },
      { adaptiveMatch: adaptiveV5({ action: "REJECT", priceCny: 99 }), balancedPassed: false },
      {
        adaptiveMatch: adaptiveV5({
          action: "REJECT",
          valuableApplies: true,
          valuableCategory: "   ",
        }),
        balancedPassed: false,
      },
    ];
    let runs = 0;
    const bridge = createCostBridge({
      adaptiveActionPolicy: "enforce",
      adaptiveActionSampleTarget: 10,
      matchPolicy: "balanced",
      minimumSameItemMatches: 1,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async ({ args }) => {
        const current = outputs[runs++];
        return {
          code: 0,
          stdout: returnedSameItemOutput({
            request: cliMatchRequest(args),
            prices: [18],
            selectedCost: 18,
            adaptiveMatch: current.adaptiveMatch,
            balancedPassed: current.balancedPassed,
          }),
          stderr: "",
        };
      },
    });
    const estimate = (index) => bridge.estimate({
      sku: `v5-enforce-${index}`,
      cover_image: `https://img.example/v5-enforce-${index}.jpg`,
      sell_price: 100,
      expect_title: "same product lamp",
    }, runDir);
    const allowed = await estimate(1);
    const rejected = await estimate(2);
    const incomplete = await estimate(3);
    const legacy = await estimate(4);
    const priceMismatch = await estimate(5);
    const blankValuableCategory = await estimate(6);
    await bridge.close();

    assert.equal(allowed.ok, true, "v5 ALLOW must survive an old balanced rejection");
    assert.equal(allowed.balanced_match, false);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.terminal, true);
    assert.equal(rejected.adaptive_action_rejected, true);
    assert.match(rejected.reason, /adaptive 1688 action rejected/i);
    assert.equal(incomplete.ok, true, "incomplete v5 action must not enforce");
    assert.equal(incomplete.adaptive_action_complete, false);
    assert.equal(legacy.ok, true, "v4 telemetry must remain compatible and must not invoke the action gate");
    assert.equal(priceMismatch.ok, true, "an action detached from the requested price must not enforce");
    assert.equal(blankValuableCategory.ok, true, "a valuable-digital action with a blank category must not enforce");
    assert.equal(blankValuableCategory.adaptive_action_complete, false);
    const state = JSON.parse(await fs.readFile(path.join(runDir, "1688_match_policy.json"), "utf8"));
    assert.equal(state.samples.length, 0, "balanced legacy sampling stays independent");
    assert.equal(state.action_samples.length, 2);
    assert.equal(state.summary.complete_action_samples, 2);
    assert.equal(state.summary.collection_status, "collecting");
  });
});

test("a request hash plus prices can no longer self-prove a same-item match", () => {
  const request = { expect_title: "детская кепка миньон" };
  const result = parseCostOutput([
    `MATCH_EVIDENCE_KEY ${"f".repeat(64)}`,
    "P70_COST 12",
    "COST_SOURCE search_first_page_cluster_p70_similarity_filtered",
    "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
  ].join("\n"), 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing returned same-item evidence/i);
});

test("rejects returned car-seat evidence for a Russian cap request", () => {
  const request = { expect_title: "детская кепка миньон" };
  const unsigned = returnedSameItemOutput({
    request,
    title: "автомобильный чехол для сиденья",
  }).replace(/"title":\["детская"\]/gu, "\"title\":[\"автомобильный\"]");
  const evidence = unsigned.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "";
  const output = unsigned.replace(
    /^MATCH_EVIDENCE_KEY\s+.+$/mu,
    `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(evidence).digest("hex")}`,
  );
  const result = parseCostOutput(output, 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not bound to request semantics/i);
});

test("rejects category-only returned rows and a selected cost/source not bound by evidence", () => {
  const request = { expect_title: "детская кепка миньон", expect_category: "汽车" };
  const output = returnedSameItemOutput({ request, title: "汽车通用精品" });
  const evidenceText = output.replace(
    /"semantic_hits":\{[^}]+\}/gu,
    "\"semantic_hits\":{\"category\":[\"汽车\"],\"model\":[],\"title\":[]}",
  );
  const evidence = evidenceText.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "";
  const resigned = evidenceText.replace(
    /^MATCH_EVIDENCE_KEY\s+.+$/mu,
    `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(evidence).digest("hex")}`,
  );
  const result = parseCostOutput(resigned, 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /only category evidence/i);
});

test("rejects a parsed cost or source that differs from the signed returned evidence", () => {
  const request = { expect_title: "same product lamp" };
  const output = returnedSameItemOutput({ request, selectedCost: 12 });
  const changedCost = parseCostOutput(output.replace("P70_COST 12", "P70_COST 11"), 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
  });
  assert.equal(changedCost.ok, false);
  assert.match(changedCost.reason, /selected cost mismatch/i);

  const changedSource = parseCostOutput(
    output.replace(
      "COST_SOURCE search_first_page_cluster_p70_similarity_filtered",
      "COST_SOURCE search_first_page_cluster_p80_similarity_filtered",
    ),
    100,
    {
      expectedMatchEvidence: request,
      requireSameItemEvidence: true,
    },
  );
  assert.equal(changedSource.ok, false);
  assert.match(changedSource.reason, /cost source mismatch/i);
});

test("rejects insufficient evidence and cost near sale price", () => {
  const result = parseCostOutput(
    [
      "P70_COST 90",
      "COST_SOURCE search_first_page_p70_similarity_filtered",
      "FILTERED_FIRST_PAGE_PRICES [80, 90]",
    ].join("\n"),
    100,
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /insufficient|spread|sale price|85%/i);
});

test("cluster-filtered sources retain the existing spread behavior", () => {
  const result = parseCostOutput([
    "P70_COST 12",
    "COST_SOURCE search_first_page_cluster_p70_similarity_filtered",
    "FILTERED_FIRST_PAGE_PRICES [1, 6, 12]",
    "SELECTED_PRICE_CLUSTER {\"count\":3,\"strong_count\":1,\"score_sum\":3,\"rows\":[{\"level\":\"strong\",\"score\":3}]}",
  ].join("\n"), 100);
  assert.equal(result.ok, true);
});

test("rejects an implausibly low clustered cost that indicates an accessory mismatch", () => {
  const result = parseCostOutput([
    "P70_COST 14",
    "COST_SOURCE search_first_page_cluster_p70_similarity_filtered",
    "FILTERED_FIRST_PAGE_PRICES [10, 12.99, 14, 16.5]",
    "SELECTED_PRICE_CLUSTER {\"count\":4,\"strong_count\":0,\"score_sum\":0,\"avg_score\":0,\"rows\":[{\"title\":\"iPad保护套\",\"level\":\"none\",\"score\":0}]}",
  ].join("\n"), 3687.17);

  assert.equal(result.ok, false);
  assert.match(result.reason, /below 2% of sale price/i);
});

test("malformed bare price tokens invalidate the evidence", () => {
  const result = parseCostOutput([
    "P70_COST 12",
    "COST_SOURCE search_first_page_p70_similarity_filtered",
    "FILTERED_FIRST_PAGE_PRICES [10, foo, 12, 14]",
  ].join("\n"), 100);
  assert.equal(result.ok, false);
  assert.match(result.reason, /insufficient|invalid/i);
});

test("compact cost evidence preserves reliability parsing without verbose diagnostics", () => {
  const verbose = [
    "VALID_COUNT 50",
    "COST_SOURCE search_first_page_cluster_p70_similarity_filtered",
    "REASON filtered first-page similarity clustered cost",
    "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
    `TOP_ROWS ${"verbose ".repeat(200)}`,
    "P70_COST 11",
  ].join("\n");
  const compact = compactCostOutput(verbose);
  assert.equal(compact.includes("TOP_ROWS"), false);
  assert.equal(compact.length < verbose.length / 2, true);
  assert.deepEqual(parseCostOutput(compact, 100), parseCostOutput(verbose, 100));
});

test("adaptive match JSON is compacted and parsed without weakening its contract", () => {
  const adaptiveMatch = {
    version: "adaptive-v4-shadow",
    decision: "REVIEW",
    score: 67,
    reason: "pack quantity is not confirmed",
    hard_conflicts: [],
    missing_evidence: ["pack_quantity"],
    selected_offer_id: null,
    supporting_offer_ids: ["offer-1"],
  };
  const verbose = [
    `ADAPTIVE_MATCH_JSON ${JSON.stringify(adaptiveMatch)}`,
    "COST_SOURCE search_first_page_cluster_p70_similarity_filtered",
    "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
    "P70_COST 11",
    "TOP_ROWS verbose diagnostics",
  ].join("\n");
  const compact = compactCostOutput(verbose);
  assert.match(compact, /^ADAPTIVE_MATCH_JSON /mu);
  assert.deepEqual(parseCostOutput(compact, 100).adaptive_match, adaptiveMatch);

  const malformed = compact.replace('"score":67', '"score":101');
  const parsedMalformed = parseCostOutput(malformed, 100);
  assert.equal(parsedMalformed.ok, true);
  assert.equal("adaptive_match" in parsedMalformed, false);
});

test("adaptive v5 action fields are validated while legacy v4 remains compatible", () => {
  const adaptiveMatch = adaptiveV5({ action: "ALLOW", priceCny: 420 });
  const output = [
    `ADAPTIVE_MATCH_JSON ${JSON.stringify(adaptiveMatch)}`,
    "COST_SOURCE search_first_page_cluster_p70_similarity_filtered",
    "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
    "P70_COST 11",
  ].join("\n");
  assert.deepEqual(parseCostOutput(output, 100).adaptive_match, adaptiveMatch);

  const malformed = {
    ...adaptiveMatch,
    valuable_digital: { ...adaptiveMatch.valuable_digital, threshold_cny: 301 },
  };
  const malformedOutput = output.replace(
    JSON.stringify(adaptiveMatch),
    JSON.stringify(malformed),
  );
  const parsedMalformed = parseCostOutput(malformedOutput, 100);
  assert.equal(parsedMalformed.ok, true);
  assert.equal("adaptive_match" in parsedMalformed, false);

  const legacyV4 = {
    version: "adaptive-v4-shadow",
    decision: "REVIEW",
    score: 70,
    reason: "legacy telemetry",
    hard_conflicts: [],
    missing_evidence: ["material"],
    selected_offer_id: null,
    supporting_offer_ids: ["offer-1"],
  };
  const legacyOutput = output.replace(JSON.stringify(adaptiveMatch), JSON.stringify(legacyV4));
  assert.deepEqual(parseCostOutput(legacyOutput, 100).adaptive_match, legacyV4);
});

test("nonzero review decisions preserve the 1688 reliability reason", async () => {
  await withTempDir(async (runDir) => {
    let runs = 0;
    const bridge = createCostBridge({
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        runs += 1;
        return {
          code: 2,
          stdout: [
            "DECISION REVIEW",
            "REASON extreme price spread without strong main cluster",
            "COST_SOURCE search_first_page_p70_similarity_filtered",
            "P70_COST None",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    const result = await bridge.estimate({
      sku: "review-1",
      cover_image: "https://example.invalid/cover.jpg",
      sell_price: 100,
    }, runDir);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "extreme price spread without strong main cluster");
    assert.equal(result.process_code, 2);

    const cached = await bridge.estimate({
      sku: "review-2",
      cover_image: "https://example.invalid/cover.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(cached.ok, false);
    assert.equal(cached.reason, result.reason);
    assert.equal(cached.shared_cache, true);
    assert.equal(runs, 1);
  });
});

test("opaque terminal 1688 failures remain cached after evidence compaction", async () => {
  await withTempDir(async (runDir) => {
    let runs = 0;
    const bridge = createCostBridge({
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        runs += 1;
        return { code: 2, stdout: "opaque terminal failure", stderr: "" };
      },
    });
    const item = {
      sku: "opaque-terminal-1",
      cover_image: "https://img.example/opaque-terminal.jpg",
      sell_price: 100,
    };
    assert.equal((await bridge.estimate(item, runDir)).ok, false);
    const cached = await bridge.estimate({ ...item, sku: "opaque-terminal-2" }, runDir);
    assert.equal(cached.ok, false);
    assert.equal(cached.shared_cache, true);
    assert.equal(runs, 1);
  });
});

test("SSL EOF worker failures are deferred and never become terminal cache entries", async () => {
  await withTempDir(async (runDir) => {
    let clock = Date.parse("2026-07-23T00:00:00.000Z");
    let runs = 0;
    const bridge = createCostBridge({
      healthDeferredTtlMs: 1_000,
      now: () => clock,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        runs += 1;
        if (runs === 1) return {
          code: 1,
          stdout: "",
          stderr: "SSLError: SSL: UNEXPECTED_EOF_WHILE_READING",
        };
        return {
          code: 0,
          stdout: [
            "COST_SOURCE search_first_page_p70_similarity_filtered",
            "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
            "P70_COST 11",
          ].join("\n"),
          stderr: "",
        };
      },
    });
    const item = { sku: "ssl-eof", cover_image: "https://img.example/ssl-eof.jpg", sell_price: 100 };

    const failed = await bridge.estimate(item, runDir);
    assert.equal(failed.ok, false);
    assert.equal(failed.deferred, true);
    assert.equal(failed.terminal, false);
    assert.equal(failed.transport_error, true);
    assert.match(failed.reason, /transient transport/i);

    const backedOff = await bridge.estimate(item, runDir);
    assert.equal(backedOff.deferred, true);
    assert.equal(backedOff.cached, true);
    assert.equal(runs, 1);

    clock += 1_001;
    const recovered = await bridge.estimate(item, runDir);
    assert.equal(recovered.ok, true);
    assert.equal(runs, 2);
  });
});

test("legacy process-code-one terminal cache is ignored and re-queried", async () => {
  await withTempDir(async (root) => {
    const runDir = path.join(root, "run");
    const sharedCachePath = path.join(root, "shared", "1688_cache.json");
    const image = "https://img.example/legacy-transport.jpg";
    const key = crypto.createHash("sha256").update(image).digest("hex");
    await fs.mkdir(path.dirname(sharedCachePath), { recursive: true });
    await fs.writeFile(sharedCachePath, JSON.stringify({ entries: {
      [key]: {
        output: "REASON missing or invalid P70 cost\nP70_COST None",
        terminal: true,
        process_code: 1,
        updated_at: "2026-07-23T00:00:00.000Z",
      },
    } }));
    let runs = 0;
    const result = await createCostBridge({
      sharedCachePath,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        runs += 1;
        return {
          code: 0,
          stdout: [
            "COST_SOURCE search_first_page_p70_similarity_filtered",
            "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
            "P70_COST 11",
          ].join("\n"),
          stderr: "",
        };
      },
    }).estimate({ sku: "legacy-transport", cover_image: image, sell_price: 100 }, runDir);

    assert.equal(result.ok, true);
    assert.equal(result.shared_cache, false);
    assert.equal(runs, 1);
  });
});

test("repeated transport failures open one global circuit instead of amplifying retries", async () => {
  await withTempDir(async (runDir) => {
    let runs = 0;
    const bridge = createCostBridge({
      healthFailureThreshold: 2,
      healthProbeBackoffMs: 10_000,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        runs += 1;
        return {
          code: 1,
          stdout: "",
          stderr: "ConnectionError: Connection reset by peer",
        };
      },
    });

    const first = await bridge.estimate({ sku: "transport-1", cover_image: "https://img.example/transport-1.jpg", sell_price: 100 }, runDir);
    const second = await bridge.estimate({ sku: "transport-2", cover_image: "https://img.example/transport-2.jpg", sell_price: 100 }, runDir);
    const blocked = await bridge.estimate({ sku: "transport-3", cover_image: "https://img.example/transport-3.jpg", sell_price: 100 }, runDir);

    assert.equal(first.deferred, true);
    assert.equal(second.health?.circuit, "open");
    assert.equal(second.health?.reason, "1688-transient-transport-failure");
    assert.equal(blocked.deferred, true);
    assert.equal(blocked.health?.probe_blocked, true);
    assert.equal(runs, 2);
  });
});

test("estimate reuses parseable cached output without redownloading or rerunning", async () => {
  await withTempDir(async (runDir) => {
    const imagesDir = path.join(runDir, "images");
    const costsDir = path.join(runDir, "1688");
    await fs.mkdir(imagesDir, { recursive: true });
    await fs.mkdir(costsDir, { recursive: true });
    await fs.writeFile(
      path.join(costsDir, "sku-123.out"),
      [
        "VALID_COUNT 10",
        "DECISION LIGHT_ACCEPT",
        "COST_SOURCE search_first_page_p70_similarity_filtered",
        "FILTERED_FIRST_PAGE_PRICES [10, 12, 14, 16]",
        "P70_COST 14",
      ].join("\n"),
      "utf8",
    );

    const downloadCalls = [];
    const runCalls = [];
    const bridge = createCostBridge({
      download: async (...args) => {
        downloadCalls.push(args);
        throw new Error("download should not be called for parseable cache");
      },
      runProcess: async (...args) => {
        runCalls.push(args);
        throw new Error("runProcess should not be called for parseable cache");
      },
    });

    const result = await bridge.estimate(
      {
        sku: "sku-123",
        cover_image: "https://example.invalid/cover.jpg",
        sell_price: 100,
      },
      runDir,
    );

    assert.equal(result.ok, true);
    assert.equal(result.cost, 14);
    assert.equal(result.source, "search_first_page_p70_similarity_filtered");
    assert.equal(downloadCalls.length, 0);
    assert.equal(runCalls.length, 0);
  });
});

test("estimate downloads safely, runs python, and saves combined stdout and stderr", async () => {
  await withTempDir(async (runDir) => {
    const bridge = createCostBridge({
      download: async (url, destinationPath) => {
        assert.equal(url, "https://example.invalid/cover.jpg");
        await fs.writeFile(destinationPath, Buffer.from("jpeg-data"));
      },
      runProcess: async ({ command, args, cwd }) => {
        assert.equal(command, "python3");
        assert.match(args[0], /flow_b_codex_transfer_20260608\/scripts\/1688_image_median\.py$/);
        assert.match(args[1], /images\/sku-456\.jpg$/);
        assert.equal(cwd, path.resolve(process.cwd()));
        return {
          code: 0,
          stdout: [
            "VALID_COUNT 6",
            "COST_SOURCE search_first_page_p70_similarity_filtered",
            "FILTERED_FIRST_PAGE_PRICES [11, 12, 13]",
            "P70_COST 12",
          ].join("\n"),
          stderr: "warning: recovered from cache miss",
        };
      },
    });

    const result = await bridge.estimate(
      {
        sku: "sku-456",
        cover_image: "https://example.invalid/cover.jpg",
        sell_price: 100,
      },
      runDir,
    );

    const outPath = path.join(runDir, "1688", "sku-456.out");
    const outText = await fs.readFile(outPath, "utf8");

    assert.equal(result.ok, true);
    assert.equal(result.cost, 12);
    assert.match(outText, /VALID_COUNT 6/);
    assert.match(outText, /STDERR:/);
    assert.match(outText, /warning: recovered from cache miss/);
  });
});

test("estimate rejects path traversal attempts structurally", async () => {
  await withTempDir(async (runDir) => {
    const bridge = createCostBridge({
      download: async () => {
        throw new Error("download should not be called");
      },
      runProcess: async () => {
        throw new Error("runProcess should not be called");
      },
    });

    const result = await bridge.estimate(
      {
        sku: "../escape",
        cover_image: "https://example.invalid/cover.jpg",
        sell_price: 100,
      },
      runDir,
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "invalid-sku");
    assert.match(result.error?.message || "", /path traversal|unsafe/i);
  });
});

test("transient image downloads retry at most once before running 1688", async () => {
  await withTempDir(async (runDir) => {
    let downloads = 0;
    let runs = 0;
    const delays = [];
    const bridge = createCostBridge({
      download: async (_url, destinationPath) => {
        downloads += 1;
        if (downloads < 2) throw new Error("image download HTTP 503");
        await fs.writeFile(destinationPath, "image");
      },
      sleep: async (ms) => { delays.push(ms); },
      runProcess: async () => {
        runs += 1;
        return {
          code: 0,
          stdout: [
            "COST_SOURCE search_first_page_p70_similarity_filtered",
            "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
            "P70_COST 11",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    const result = await bridge.estimate({
      sku: "retry-download",
      cover_image: "https://img.example/retry.jpg",
      sell_price: 100,
    }, runDir);

    assert.equal(result.ok, true);
    assert.equal(downloads, 2);
    assert.equal(runs, 1);
    assert.deepEqual(delays, [500]);
  });
});

test("generic fetch failures retry audited UND_ERR, ECONN, timeout, and DNS causes", async () => {
  await withTempDir(async (runDir) => {
    const causes = [
      ["UND_ERR_SOCKET", "other side closed"],
      ["ECONNRESET", "connection reset by peer"],
      ["ETIMEDOUT", "connect timed out"],
      ["EAI_AGAIN", "temporary DNS lookup failure"],
    ];
    const attempts = new Map();
    const delays = [];
    const bridge = createCostBridge({
      download: async (url, destinationPath) => {
        const code = String(url).split("/").at(-1).replace(/\.jpg$/, "");
        const count = (attempts.get(code) || 0) + 1;
        attempts.set(code, count);
        if (count === 1) {
          const cause = causes.find(([candidate]) => candidate === code)?.[1];
          throw genericFetchFailure(code, cause);
        }
        await fs.writeFile(destinationPath, "image");
      },
      sleep: async (ms) => { delays.push(ms); },
      runProcess: async () => ({
        code: 0,
        stdout: [
          "COST_SOURCE search_first_page_p70_similarity_filtered",
          "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
          "P70_COST 11",
        ].join("\n"),
        stderr: "",
      }),
    });

    for (const [code] of causes) {
      const result = await bridge.estimate({
        sku: `retry-${code.toLowerCase().replaceAll("_", "-")}`,
        cover_image: `https://img.example/${code}.jpg`,
        sell_price: 100,
      }, runDir);
      assert.equal(result.ok, true, `${code}: ${JSON.stringify(result)}`);
      assert.equal(attempts.get(code), 2);
    }
    assert.deepEqual(delays, [500, 500, 500, 500]);
    await bridge.close();
  });
});

test("persistent generic fetch failures stop at the two-attempt ceiling", async () => {
  await withTempDir(async (runDir) => {
    let downloads = 0;
    let runs = 0;
    const delays = [];
    const bridge = createCostBridge({
      downloadAttempts: 99,
      download: async () => {
        downloads += 1;
        throw genericFetchFailure("UND_ERR_CONNECT_TIMEOUT", "connection timed out");
      },
      sleep: async (ms) => { delays.push(ms); },
      runProcess: async () => { runs += 1; return { code: 0, stdout: "", stderr: "" }; },
    });
    const result = await bridge.estimate({
      sku: "persistent-fetch-failure",
      cover_image: "https://img.example/persistent.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(result.ok, false);
    assert.equal(result.error?.message, "fetch failed");
    assert.equal(downloads, 2);
    assert.equal(runs, 0);
    assert.deepEqual(delays, [500]);
    await bridge.close();
  });
});

test("generic fetch failures with non-transient causes do not retry", async () => {
  await withTempDir(async (runDir) => {
    let downloads = 0;
    const bridge = createCostBridge({
      download: async () => {
        downloads += 1;
        throw genericFetchFailure("UND_ERR_REQ_CONTENT_LENGTH_MISMATCH", "response body is invalid");
      },
      sleep: async () => { throw new Error("non-transient errors must not back off"); },
      runProcess: async () => { throw new Error("1688 must not run without a valid image"); },
    });
    const result = await bridge.estimate({
      sku: "invalid-fetch-content",
      cover_image: "https://img.example/invalid-content.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(result.ok, false);
    assert.equal(downloads, 1);
    assert.equal(result.error?.message, "fetch failed");
    await bridge.close();
  });
});

test("bare TypeError fetch failures retry once and can recover", async () => {
  await withTempDir(async (runDir) => {
    let downloads = 0;
    let runs = 0;
    const delays = [];
    const bridge = createCostBridge({
      download: async (_url, destinationPath) => {
        downloads += 1;
        if (downloads === 1) throw new TypeError("fetch failed");
        await fs.writeFile(destinationPath, "image");
      },
      sleep: async (ms) => { delays.push(ms); },
      runProcess: async () => {
        runs += 1;
        return {
          code: 0,
          stdout: [
            "COST_SOURCE search_first_page_p70_similarity_filtered",
            "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
            "P70_COST 11",
          ].join("\n"),
          stderr: "",
        };
      },
    });
    const result = await bridge.estimate({
      sku: "bare-fetch-recovery",
      cover_image: "https://img.example/bare-fetch-recovery.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(result.ok, true);
    assert.equal(downloads, 2);
    assert.equal(runs, 1);
    assert.deepEqual(delays, [500]);
    await bridge.close();
  });
});

test("persistent bare TypeError fetch failures stop after two attempts", async () => {
  await withTempDir(async (runDir) => {
    let downloads = 0;
    const delays = [];
    const bridge = createCostBridge({
      downloadAttempts: 99,
      download: async () => {
        downloads += 1;
        throw new TypeError("fetch failed");
      },
      sleep: async (ms) => { delays.push(ms); },
      runProcess: async () => { throw new Error("1688 must not run without a valid image"); },
    });
    const result = await bridge.estimate({
      sku: "persistent-bare-fetch-failure",
      cover_image: "https://img.example/persistent-bare-fetch-failure.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(result.ok, false);
    assert.equal(result.error?.message, "fetch failed");
    assert.equal(downloads, 2);
    assert.deepEqual(delays, [500]);
    await bridge.close();
  });
});

test("arbitrary TypeError image failures do not retry", async () => {
  await withTempDir(async (runDir) => {
    let downloads = 0;
    const bridge = createCostBridge({
      download: async () => {
        downloads += 1;
        throw new TypeError("invalid image transform input");
      },
      sleep: async () => { throw new Error("arbitrary TypeErrors must not back off"); },
      runProcess: async () => { throw new Error("1688 must not run without a valid image"); },
    });
    const result = await bridge.estimate({
      sku: "arbitrary-type-error",
      cover_image: "https://img.example/arbitrary-type-error.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(result.ok, false);
    assert.equal(result.error?.message, "invalid image transform input");
    assert.equal(downloads, 1);
    await bridge.close();
  });
});

test("transient image retry does not extend the end-to-end budget", async () => {
  await withTempDir(async (runDir) => {
    let downloads = 0;
    const bridge = createCostBridge({
      totalBudgetMs: 400,
      download: async () => {
        downloads += 1;
        throw new TypeError("fetch failed");
      },
      sleep: async () => { throw new Error("retry delay must not start beyond the budget"); },
      runProcess: async () => { throw new Error("1688 must not run without an image"); },
    });
    const result = await bridge.estimate({
      sku: "retry-budget-bound",
      cover_image: "https://img.example/retry-budget-bound.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "1688-total-timeout");
    assert.equal(downloads, 1);
    await bridge.close();
  });
});

test("HTTP 4xx and invalid image content do not retry", async () => {
  await withTempDir(async (runDir) => {
    const cases = ["400", "404", "408", "425", "429", "empty"];
    const downloads = new Map();
    const bridge = createCostBridge({
      download: async (url) => {
        const kind = String(url).split("/").at(-1).replace(/\.jpg$/, "");
        downloads.set(kind, (downloads.get(kind) || 0) + 1);
        if (kind === "empty") throw new Error("downloaded image is empty");
        throw new Error(`image download HTTP ${kind}`);
      },
      sleep: async () => { throw new Error("deterministic image failures must not back off"); },
      runProcess: async () => { throw new Error("1688 must not run without an image"); },
    });
    for (const kind of cases) {
      const result = await bridge.estimate({
        sku: `invalid-image-${kind}`,
        cover_image: `https://img.example/${kind}.jpg`,
        sell_price: 100,
      }, runDir);
      assert.equal(result.ok, false);
      assert.equal(downloads.get(kind), 1);
      assert.match(result.error.message, kind === "empty" ? /empty/ : new RegExp(`HTTP ${kind}`));
    }
    await bridge.close();
  });
});

test("estimate persists partial process evidence on timeout", async () => {
  await withTempDir(async (runDir) => {
    const bridge = createCostBridge({
      download: async (url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        throw Object.assign(new Error("timed out"), {
          code: "process-timeout",
          stdout: "PARTIAL STDOUT",
          stderr: "PARTIAL STDERR",
        });
      },
    });
    const result = await bridge.estimate({
      sku: "timeout-1",
      cover_image: "https://example.invalid/cover.jpg",
      sell_price: 100,
    }, runDir);
    const evidence = await fs.readFile(path.join(runDir, "1688", "timeout-1.out"), "utf8");
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "process-timeout");
    assert.match(evidence, /PARTIAL STDOUT/);
    assert.match(evidence, /PARTIAL STDERR/);
    assert.match(evidence, /timed out/);
  });
});

test("same cover image shares one in-flight 1688 query and persists reusable cache", async () => {
  await withTempDir(async (runDir) => {
    let runs = 0;
    const bridge = createCostBridge({
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          code: 0,
          stdout: [
            "COST_SOURCE search_first_page_p70_similarity_filtered",
            "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
            "P70_COST 11",
          ].join("\n"),
          stderr: "",
        };
      },
    });
    const first = { sku: "same-1", cover_image: "https://img.example/same.jpg", sell_price: 100 };
    const second = { sku: "same-2", cover_image: "https://img.example/same.jpg", sell_price: 100 };
    const results = await Promise.all([bridge.estimate(first, runDir), bridge.estimate(second, runDir)]);
    assert.equal(runs, 1);
    assert.ok(results.every((row) => row.ok));
    assert.ok(results.some((row) => row.shared_cache === true));
    await bridge.close();
    const cache = JSON.parse(await fs.readFile(path.join(runDir, "1688_cache.json"), "utf8"));
    assert.equal(Object.keys(cache.entries).length, 1);
  });
});

test("uncached 1688 estimates use and close an injected long-lived worker pool", async () => {
  await withTempDir(async (runDir) => {
    let workerRuns = 0;
    let closes = 0;
    const bridge = createCostBridge({
      workerPool: {
        run: async ({ image }) => {
          workerRuns += 1;
          assert.match(image, /pool-1\.jpg$/);
          return {
            code: 0,
            stdout: [
              "COST_SOURCE search_first_page_p70_similarity_filtered",
              "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
              "P70_COST 11",
            ].join("\n"),
            stderr: "",
          };
        },
        close: async () => { closes += 1; },
      },
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => { throw new Error("one-shot process should not run"); },
    });
    const result = await bridge.estimate({
      sku: "pool-1",
      cover_image: "https://img.example/pool.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(result.ok, true);
    assert.equal(workerRuns, 1);
    await bridge.close();
    assert.equal(closes, 1);
  });
});

test("1688 total budget includes image download and worker queue time", async () => {
  await withTempDir(async (runDir) => {
    let downloadTimeout = 0;
    let workerTimeout = 0;
    const bridge = createCostBridge({
      totalBudgetMs: 120,
      cacheFlushDebounceMs: 0,
      workerPool: {
        run: async (_request, timeout) => {
          workerTimeout = timeout;
          return {
            code: 0,
            stdout: [
              "COST_SOURCE search_first_page_p70_similarity_filtered",
              "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
              "P70_COST 11",
            ].join("\n"),
            stderr: "",
          };
        },
        close: async () => {},
      },
      download: async (_url, destinationPath, options) => {
        downloadTimeout = options.timeout;
        await new Promise((resolve) => setTimeout(resolve, 35));
        await fs.writeFile(destinationPath, "image");
      },
    });
    const result = await bridge.estimate({
      sku: "budget-1",
      cover_image: "https://img.example/budget.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(result.ok, true);
    assert.ok(downloadTimeout <= 120);
    assert.ok(workerTimeout > 0);
    assert.ok(workerTimeout < downloadTimeout);
    await bridge.close();
  });
});

test("overlapping debounced cache generations all settle without losing a resolver", async () => {
  await withTempDir(async (runDir) => {
    let cacheWrites = 0;
    const bridge = createCostBridge({
      totalBudgetMs: 1_000,
      cacheFlushDebounceMs: 2,
      workerPool: {
        run: async ({ image }) => {
          const index = Number(String(image).match(/generation-(\d+)\.jpg$/)?.[1] || 0);
          await new Promise((resolve) => setTimeout(resolve, index * 4));
          return {
            code: 2,
            stdout: [
              "COST_SOURCE search_first_page_p70_similarity_filtered",
              "REASON no explicit title/model/category semantic same-item matches",
              "FILTERED_FIRST_PAGE_PRICES []",
              "P70_COST None",
            ].join("\n"),
            stderr: "",
          };
        },
        close: async () => {},
      },
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      writeCache: async (filename, cache) => {
        cacheWrites += 1;
        await new Promise((resolve) => setTimeout(resolve, 18));
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, `${JSON.stringify(cache)}\n`, "utf8");
      },
    });
    const estimates = Array.from({ length: 12 }, (_, index) => bridge.estimate({
      sku: `generation-${index}`,
      cover_image: `https://img.example/generation-${index}.jpg`,
      sell_price: 100,
    }, runDir));
    const results = await Promise.race([
      Promise.all(estimates),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("cache generations did not settle")),
        1_500,
      )),
    ]);

    assert.equal(results.length, 12);
    assert.ok(results.every((result) => result.ok === false));
    await bridge.close();
    assert.ok(cacheWrites >= 2);
    const cache = JSON.parse(await fs.readFile(path.join(runDir, "1688_cache.json"), "utf8"));
    assert.equal(Object.keys(cache.entries).length, 12);
  });
});

test("cache persistence stays outside the public 1688 deadline and close waits for durability", async () => {
  await withTempDir(async (runDir) => {
    let releaseWrite;
    let markWriteStarted;
    const writeStarted = new Promise((resolve) => { markWriteStarted = resolve; });
    const writeReleased = new Promise((resolve) => { releaseWrite = resolve; });
    const bridge = createCostBridge({
      totalBudgetMs: 80,
      cacheFlushDebounceMs: 0,
      workerPool: {
        run: async () => ({
          code: 2,
          stdout: [
            "COST_SOURCE search_first_page_p70_similarity_filtered",
            "REASON no explicit title/model/category semantic same-item matches",
            "FILTERED_FIRST_PAGE_PRICES []",
            "P70_COST None",
          ].join("\n"),
          stderr: "",
        }),
        close: async () => {},
      },
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      writeCache: async (filename, cache) => {
        markWriteStarted();
        await writeReleased;
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, `${JSON.stringify(cache)}\n`, "utf8");
      },
    });

    const result = await Promise.race([
      bridge.estimate({
        sku: "nonblocking-cache",
        cover_image: "https://img.example/nonblocking-cache.jpg",
        sell_price: 100,
      }, runDir),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("estimate waited for cache persistence")),
        50,
      )),
    ]);
    assert.equal(result.ok, false);
    await writeStarted;

    let closed = false;
    const closing = bridge.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(closed, false);
    releaseWrite();
    await closing;
    assert.equal(closed, true);

    const cache = JSON.parse(await fs.readFile(path.join(runDir, "1688_cache.json"), "utf8"));
    assert.equal(Object.keys(cache.entries).length, 1);
  });
});

test("background cache write failures are reported when the bridge closes", async () => {
  await withTempDir(async (runDir) => {
    const bridge = createCostBridge({
      totalBudgetMs: 80,
      cacheFlushDebounceMs: 0,
      workerPool: {
        run: async () => ({
          code: 2,
          stdout: "REASON no match\nP70_COST None",
          stderr: "",
        }),
        close: async () => {},
      },
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      writeCache: async () => {
        throw new Error("cache disk unavailable");
      },
    });

    const result = await bridge.estimate({
      sku: "failed-cache-write",
      cover_image: "https://img.example/failed-cache-write.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(result.ok, false);
    await assert.rejects(bridge.close(), /cache disk unavailable/);
  });
});

test("the public 1688 deadline releases a hung request and permits the next SKU", async () => {
  await withTempDir(async (runDir) => {
    const bridge = createCostBridge({
      totalBudgetMs: 40,
      cacheFlushDebounceMs: 0,
      workerPool: {
        run: async ({ image }) => {
          if (/hung-cost\.jpg$/.test(String(image))) return new Promise(() => {});
          return {
            code: 0,
            stdout: [
              "COST_SOURCE search_first_page_p70_similarity_filtered",
              "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
              "P70_COST 11",
            ].join("\n"),
            stderr: "",
          };
        },
        close: async () => {},
      },
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
    });
    const started = Date.now();
    const timedOut = await bridge.estimate({
      sku: "hung-cost",
      cover_image: "https://img.example/hung-cost.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.error?.code, "1688-total-timeout");
    assert.ok(Date.now() - started < 250);

    const next = await bridge.estimate({
      sku: "next-cost",
      cover_image: "https://img.example/next-cost.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(next.ok, true);
    await bridge.close();
  });
});

test("cache v7 invalidates v6 entries and isolates otherwise identical requests by sale price", async () => {
  await withTempDir(async (root) => {
    const runDir = path.join(root, "run");
    const sharedCachePath = path.join(root, "shared", "1688_cache.json");
    const imageUrl = "https://img.example/price-key.jpg";
    const title = "same product lamp";
    const legacyOutput = returnedSameItemOutput({
      request: { expect_title: title, expect_price_cny: 100 },
      prices: [17],
      selectedCost: 17,
    });
    const legacyV6Payload = JSON.stringify({
      version: 6,
      image_url: imageUrl,
      minimum_same_item_matches: 1,
      excluded_offer_ids: [],
      expect_title: title,
      expect_model: "",
      expect_category: "",
    });
    const legacyKey = crypto.createHash("sha256").update(legacyV6Payload).digest("hex");
    await fs.mkdir(path.dirname(sharedCachePath), { recursive: true });
    await fs.writeFile(sharedCachePath, JSON.stringify({
      version: 1,
      entries: {
        [legacyKey]: { output: legacyOutput, terminal: true },
      },
    }));

    const seenPrices = [];
    let runs = 0;
    const bridge = createCostBridge({
      sharedCachePath,
      cacheFlushDebounceMs: 0,
      minimumSameItemMatches: 1,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async ({ args }) => {
        runs += 1;
        const request = cliMatchRequest(args);
        seenPrices.push(request.expect_price_cny);
        return {
          code: 0,
          stdout: returnedSameItemOutput({
            request,
            prices: [18],
            selectedCost: 18,
          }),
          stderr: "",
        };
      },
    });
    const first = await bridge.estimate({
      sku: "price-key-100",
      cover_image: imageUrl,
      sell_price: 100,
      expect_title: title,
    }, runDir);
    const second = await bridge.estimate({
      sku: "price-key-200",
      cover_image: imageUrl,
      sell_price: 200,
      expect_title: title,
    }, runDir);
    await bridge.close();

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.cost, 18, "the legacy v6 entry must not be reused");
    assert.equal(runs, 2, "different prices must have independent v7 cache keys");
    assert.deepEqual(seenPrices, [100, 200]);
    assert.notEqual(first.cache_key, second.cache_key);
  });
});

test("semantic match evidence reaches the worker and isolates shared image cache entries", async () => {
  await withTempDir(async (runDir) => {
    const requests = [];
    const bridge = createCostBridge({
      workerPool: {
        run: async (request) => {
          requests.push(request);
          return {
            code: 0,
            stdout: returnedSameItemOutput({
              request,
              source: "search_first_page_p70_similarity_filtered",
              selectedCost: 11,
            }),
            stderr: "",
          };
        },
        close: async () => {},
      },
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
    });
    const shared = {
      cover_image: "https://img.example/semantic.jpg",
      sell_price: 100,
      expect_model: "S5",
      expect_category: "Автомобильные аксессуары",
    };

    assert.equal((await bridge.estimate({ ...shared, sku: "semantic-1", expect_title: "OMODA S5 уплотнитель" }, runDir)).ok, true);
    assert.equal((await bridge.estimate({ ...shared, sku: "semantic-2", expect_title: "OMODA S5 уплотнитель" }, runDir)).ok, true);
    assert.equal((await bridge.estimate({ ...shared, sku: "semantic-3", expect_title: "OMODA S5 накладка" }, runDir)).ok, true);

    assert.equal(requests.length, 2);
    assert.equal(requests[0].expect_title, "OMODA S5 уплотнитель");
    assert.equal(requests[0].expect_model, "S5");
    assert.equal(requests[0].expect_category, "Автомобильные аксессуары");
    assert.equal(requests[0].expect_price_cny, 100);
    assert.notEqual(requests[0].image, undefined);
    await bridge.close();
  });
});

test("persistent worker infrastructure failure falls back to the one-shot process", async () => {
  await withTempDir(async (runDir) => {
    let fallbackRuns = 0;
    const bridge = createCostBridge({
      workerPool: {
        run: async () => { throw Object.assign(new Error("worker unavailable"), { code: "worker-failed" }); },
        close: async () => {},
      },
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async ({ args }) => {
        fallbackRuns += 1;
        assert.deepEqual(args.slice(2), [
          "--expect-title", "OMODA S5 уплотнитель",
          "--expect-model", "S5",
          "--expect-category", "Автомобильные аксессуары",
          "--expect-price-cny", "100",
          "--min-matches", "3",
        ]);
        return {
          code: 0,
          stdout: returnedSameItemOutput({
            request: {
              expect_title: "OMODA S5 уплотнитель",
              expect_model: "S5",
              expect_category: "Автомобильные аксессуары",
              expect_price_cny: 100,
            },
            source: "search_first_page_p70_similarity_filtered",
            selectedCost: 11,
          }),
          stderr: "",
        };
      },
    });
    const result = await bridge.estimate({
      sku: "fallback-1",
      cover_image: "https://img.example/fallback.jpg",
      sell_price: 100,
      expect_title: "OMODA S5 уплотнитель",
      expect_model: "S5",
      expect_category: "Автомобильные аксессуары",
    }, runDir);
    assert.equal(result.ok, true);
    assert.equal(fallbackRuns, 1);
  });
});

test("shared cache reuses a reliable 1688 result across independent run directories", async () => {
  await withTempDir(async (root) => {
    const firstRun = path.join(root, "run-1");
    const secondRun = path.join(root, "run-2");
    const sharedCachePath = path.join(root, "shared", "1688_cache.json");
    let runs = 0;
    const options = {
      sharedCachePath,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        runs += 1;
        return {
          code: 0,
          stdout: [
            "COST_SOURCE search_first_page_p70_similarity_filtered",
            "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
            "P70_COST 11",
          ].join("\n"),
          stderr: "",
        };
      },
    };
    const item = { sku: "shared-1", cover_image: "https://img.example/shared.jpg", sell_price: 100 };
    const firstBridge = createCostBridge(options);
    assert.equal((await firstBridge.estimate(item, firstRun)).ok, true);
    await firstBridge.close();
    const secondBridge = createCostBridge({
      ...options,
      runProcess: async () => { throw new Error("shared cache should avoid a second process"); },
      download: async () => { throw new Error("shared cache should avoid a second download"); },
    });
    const reused = await secondBridge.estimate({ ...item, sku: "shared-2" }, secondRun);
    await secondBridge.close();

    assert.equal(reused.ok, true);
    assert.equal(reused.shared_cache, true);
    assert.equal(reused.cross_run_cache, true);
    assert.equal(runs, 1);
  });
});

test("repeated fewer-than-three first-page results trip health circuit and remain retryable", async () => {
  await withTempDir(async (runDir) => {
    let now = Date.parse("2026-07-18T00:00:00.000Z");
    let runs = 0;
    const bridge = createCostBridge({
      healthFailureThreshold: 3,
      healthDeferredTtlMs: 1_000,
      now: () => now,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        runs += 1;
        return {
          code: 2,
          stdout: "REASON filtered first-page 1688 candidates fewer than 3\nP70_COST None",
          stderr: "",
        };
      },
    });

    const rows = [];
    for (let index = 1; index <= 3; index += 1) {
      rows.push(await bridge.estimate({
        sku: `health-${index}`,
        cover_image: `https://img.example/health-${index}.jpg`,
        sell_price: 100,
      }, runDir));
    }

    assert.equal(rows[0].deferred, true);
    assert.equal(rows[0].terminal, false);
    assert.equal(rows[2].health?.circuit, "open");
    assert.equal(rows[2].health?.consecutive_failures, 3);
    assert.equal(rows[2].health?.reason, "1688-first-page-candidate-collapse");

    const cached = await bridge.estimate({
      sku: "health-cached",
      cover_image: "https://img.example/health-1.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(cached.deferred, true);
    assert.equal(cached.shared_cache, true);
    assert.equal(runs, 3);

    now += 1_001;
    const stillBackedOff = await bridge.estimate({
      sku: "health-retry",
      cover_image: "https://img.example/health-1.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(stillBackedOff.deferred, true);
    assert.equal(stillBackedOff.health?.probe_blocked, true);
    assert.equal(runs, 3);
  });
});

test("legacy terminal candidate-collapse cache is retried instead of poisoning a new run", async () => {
  await withTempDir(async (root) => {
    const runDir = path.join(root, "run");
    const sharedCachePath = path.join(root, "shared", "1688_cache.json");
    const image = "https://img.example/legacy-collapse.jpg";
    const key = crypto.createHash("sha256").update(image).digest("hex");
    await fs.mkdir(path.dirname(sharedCachePath), { recursive: true });
    await fs.writeFile(sharedCachePath, JSON.stringify({ entries: {
      [key]: {
        output: "REASON filtered first-page 1688 candidates fewer than 3\nP70_COST None",
        terminal: true,
        updated_at: "2026-07-18T00:00:00.000Z",
      },
    } }));
    let runs = 0;
    const result = await createCostBridge({
      sharedCachePath,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        runs += 1;
        return {
          code: 0,
          stdout: [
            "COST_SOURCE search_first_page_p70_similarity_filtered",
            "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
            "P70_COST 11",
          ].join("\n"),
          stderr: "",
        };
      },
    }).estimate({ sku: "legacy", cover_image: image, sell_price: 100 }, runDir);

    assert.equal(result.ok, true);
    assert.equal(result.shared_cache, false);
    assert.equal(runs, 1);
  });
});

test("health circuit rebuilds an owned worker pool and marks a successful recovery probe", async () => {
  await withTempDir(async (runDir) => {
    let poolsCreated = 0;
    let poolsClosed = 0;
    const createWorkerPool = () => {
      poolsCreated += 1;
      const generation = poolsCreated;
      return {
        run: async () => generation === 1
          ? {
              code: 2,
              stdout: "REASON filtered first-page 1688 candidates fewer than 3\nP70_COST None",
              stderr: "",
            }
          : {
              code: 0,
              stdout: [
                "COST_SOURCE search_first_page_p70_similarity_filtered",
                "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
                "P70_COST 11",
              ].join("\n"),
              stderr: "",
            },
        close: async () => { poolsClosed += 1; },
      };
    };
    const bridge = createCostBridge({
      createWorkerPool,
      healthFailureThreshold: 2,
      healthDeferredTtlMs: 1,
      healthProbeBackoffMs: 0,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => { throw new Error("owned pool must handle the probe"); },
    });

    for (let index = 1; index <= 2; index += 1) {
      const result = await bridge.estimate({
        sku: `trip-${index}`,
        cover_image: `https://img.example/trip-${index}.jpg`,
        sell_price: 100,
      }, runDir);
      assert.equal(result.deferred, true);
    }
    assert.equal(poolsCreated, 1);
    assert.equal(poolsClosed, 1);

    const recovered = await bridge.estimate({
      sku: "recovery-probe",
      cover_image: "https://img.example/recovery-probe.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.health_probe, true);
    assert.equal(recovered.health?.circuit, "closed");
    assert.equal(recovered.health?.recovered, true);
    assert.equal(poolsCreated, 2);
    await bridge.close();
  });
});

test("open health circuit globally backs off and permits only one concurrent probe", async () => {
  await withTempDir(async (runDir) => {
    let clock = Date.parse("2026-07-18T00:00:00.000Z");
    let runs = 0;
    let releaseProbe;
    let markProbeStarted;
    const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
    const probeStarted = new Promise((resolve) => { markProbeStarted = resolve; });
    const bridge = createCostBridge({
      healthFailureThreshold: 1,
      healthDeferredTtlMs: 1_000,
      healthProbeBackoffMs: 10_000,
      now: () => clock,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        runs += 1;
        if (runs === 1) return {
          code: 2,
          stdout: "REASON filtered first-page 1688 candidates fewer than 3\nP70_COST None",
          stderr: "",
        };
        markProbeStarted();
        await probeGate;
        return {
          code: 0,
          stdout: [
            "COST_SOURCE search_first_page_p70_similarity_filtered",
            "FILTERED_FIRST_PAGE_PRICES [10, 11, 12]",
            "P70_COST 11",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    await bridge.estimate({ sku: "trip", cover_image: "https://img.example/trip.jpg", sell_price: 100 }, runDir);
    const backedOff = await bridge.estimate({ sku: "blocked", cover_image: "https://img.example/blocked.jpg", sell_price: 100 }, runDir);
    assert.equal(backedOff.deferred, true);
    assert.equal(backedOff.health?.probe_blocked, true);
    assert.equal(runs, 1);

    clock += 10_001;
    const probe = bridge.estimate({ sku: "probe", cover_image: "https://img.example/probe.jpg", sell_price: 100 }, runDir);
    await probeStarted;
    const concurrent = await bridge.estimate({ sku: "concurrent", cover_image: "https://img.example/concurrent.jpg", sell_price: 100 }, runDir);
    assert.equal(concurrent.deferred, true);
    assert.equal(concurrent.health?.probe_in_flight, true);
    assert.equal(runs, 2);
    releaseProbe();
    assert.equal((await probe).ok, true);
    assert.equal(runs, 2);
  });
});

test("an isolated fewer-than-three result becomes terminal after one health retry", async () => {
  await withTempDir(async (runDir) => {
    let clock = Date.parse("2026-07-18T00:00:00.000Z");
    let runs = 0;
    const bridge = createCostBridge({
      healthFailureThreshold: 5,
      healthDeferredTtlMs: 1_000,
      healthSkuRetryLimit: 1,
      now: () => clock,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        runs += 1;
        return {
          code: 2,
          stdout: "REASON filtered first-page 1688 candidates fewer than 3\nP70_COST None",
          stderr: "",
        };
      },
    });
    const item = { sku: "isolated", cover_image: "https://img.example/isolated.jpg", sell_price: 100 };
    const first = await bridge.estimate(item, runDir);
    assert.equal(first.deferred, true);
    clock += 1_001;
    const second = await bridge.estimate(item, runDir);
    assert.equal(second.deferred, undefined);
    assert.equal(second.terminal, true);
    assert.equal(second.reason, "filtered first-page 1688 candidates fewer than 3");
    assert.equal(runs, 2);
  });
});
