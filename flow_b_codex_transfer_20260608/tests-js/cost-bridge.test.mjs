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
} = {}) {
  const normalizedRequest = {
    expect_category: String(request?.expect_category || "").toLocaleLowerCase("und").trim(),
    expect_model: String(request?.expect_model || "").toLocaleLowerCase("und").trim(),
    expect_title: String(request?.expect_title || "").toLocaleLowerCase("und").trim(),
  };
  const modelHit = normalizedRequest.expect_model || "";
  const titleHit = normalizedRequest.expect_title.split(/\s+/u).find((token) => token.length >= 4) || "product";
  const returnedTitle = String(title || `${modelHit} ${titleHit} same product`).toLocaleLowerCase("und").trim();
  const semanticHits = modelHit
    ? { category: [], model: [modelHit], title: [titleHit].filter((hit) => returnedTitle.includes(hit)) }
    : { category: [], model: [], title: [titleHit] };
  const rows = prices.map((price, index) => ({
    offer_id: `offer-${index + 1}`,
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
  const evidence = JSON.stringify({
    contract: "1688-returned-same-item-v3",
    cost_source: source,
    request: normalizedRequest,
    rows,
    selected_cluster: rows.map(({ offer_id, supplier_id, price }) => ({ offer_id, supplier_id, price })),
    selected_cost: selectedCost,
    balanced_match: {
      passed: balancedPassed,
      match_type: balancedPassed ? matchType : "rejected",
      reason: balancedPassed ? "test match" : "test rejection",
      image_available: imageAvailable,
      supporting_offer_ids: balancedPassed
        ? (matchType === "strong_single" ? ["offer-1"] : ["offer-1", "offer-2"])
        : [],
      expected_specs: {},
    },
  });
  const key = crypto.createHash("sha256").update(evidence).digest("hex");
  return [
    `SAME_ITEM_EVIDENCE ${evidence}`,
    `MATCH_EVIDENCE_KEY ${key}`,
    `COST_SOURCE ${source}`,
    `FILTERED_FIRST_PAGE_PRICES ${JSON.stringify(prices)}`,
    `P70_COST ${selectedCost}`,
  ].join("\n");
}

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
  assert.match(result.match_evidence_key, /^[a-f0-9]{64}$/u);
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
        const request = {
          expect_title: args[args.indexOf("--expect-title") + 1],
          expect_model: "",
          expect_category: "",
        };
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

test("deterministic image HTTP errors do not retry", async () => {
  await withTempDir(async (runDir) => {
    let downloads = 0;
    const bridge = createCostBridge({
      download: async () => {
        downloads += 1;
        throw new Error("image download HTTP 404");
      },
      sleep: async () => { throw new Error("404 must not back off"); },
      runProcess: async () => { throw new Error("1688 must not run without an image"); },
    });
    const result = await bridge.estimate({
      sku: "missing-image",
      cover_image: "https://img.example/missing.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(result.ok, false);
    assert.equal(downloads, 1);
    assert.match(result.error.message, /HTTP 404/);
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
    assert.ok(cacheWrites >= 2);
    const cache = JSON.parse(await fs.readFile(path.join(runDir, "1688_cache.json"), "utf8"));
    assert.equal(Object.keys(cache.entries).length, 12);
    await bridge.close();
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
          "--min-matches", "3",
        ]);
        return {
          code: 0,
          stdout: returnedSameItemOutput({
            request: {
              expect_title: "OMODA S5 уплотнитель",
              expect_model: "S5",
              expect_category: "Автомобильные аксессуары",
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
    assert.equal((await createCostBridge(options).estimate(item, firstRun)).ok, true);
    const reused = await createCostBridge({
      ...options,
      runProcess: async () => { throw new Error("shared cache should avoid a second process"); },
      download: async () => { throw new Error("shared cache should avoid a second download"); },
    }).estimate({ ...item, sku: "shared-2" }, secondRun);

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
