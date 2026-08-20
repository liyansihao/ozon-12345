import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  compactCostOutput,
  createCostBridge,
  DEFAULT_1688_CACHE_FLUSH_DEBOUNCE_MS,
  MAX_1688_CACHE_FLUSH_DEBOUNCE_MS,
  normalize1688CacheFlushDebounceMs,
  parseCostOutput,
} from "../scripts/flow_b_playwright/cost-bridge.mjs";
import {
  declaredTargetIdentityBindingConflicts,
  explicitModelIdentityTokens,
  requiredSameItemMatchCount,
  stylusProductAccessoryRole,
} from "../scripts/flow_b_playwright/cost-evidence.mjs";

const CURRENT_MATCH_POLICY_VERSION = "image-text-soft-v2";

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
    image: {
      available: imageAvailable && index === 0,
      score: imageAvailable && index === 0 ? 0.95 : 0,
      color_score: imageAvailable && index === 0 ? 0.92 : 0,
      dhash_score: imageAvailable && index === 0 ? 0.97 : 0,
    },
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

function signedOutdoorFrostproofFaucetOutput({
  titles = [
    "全铜户外水龙头防冻一进二出庭院洗衣机双出室外带锁龙头双控钥匙",
    "户外一进二出水龙头专用庭院室外花园别墅多功能双出水洗衣机水嘴",
  ],
  accessoryConflicts = [false, false],
} = {}) {
  const request = {
    expect_category: "建筑和装修 水暖器材和配件",
    expect_model: "",
    expect_title: "наружный морозостойкий кран, незамерзающий готовый к зиме водопроводный простой в использовании для садового двора",
    expect_price_cny: 32.16,
  };
  const fixtures = [
    {
      offer_id: "1026754645067",
      supplier_id: "福建泉州牧纯厨卫有限公司",
      price: 14,
      rank: 2,
      image: { available: true, score: 0.885569, color_score: 0.94669, dhash_score: 0.859375 },
    },
    {
      offer_id: "1033809533807",
      supplier_id: "南安摩德曼家居有限公司",
      price: 18.6,
      rank: 3,
      image: { available: true, score: 0.885071, color_score: 0.945028, dhash_score: 0.859375 },
    },
  ];
  const rows = fixtures.map((fixture, index) => ({
    ...fixture,
    supplier: fixture.supplier_id,
    image_url: `https://img.example/${fixture.offer_id}.jpg`,
    semantic_hits: { category: [], model: [], title: [] },
    semantic_hits_v3: {
      model: [],
      high_information: [],
      feature: [],
      product: ["outdoor_frostproof_faucet"],
    },
    semantic_strength: "product_semantics",
    specs: {},
    spec_conflicts: [],
    identity_conflicts: [],
    accessory_conflict: accessoryConflicts[index] === true,
    title: titles[index],
  }));
  const evidence = JSON.stringify({
    contract: "1688-returned-same-item-v3",
    cost_source: "search_first_page_cluster_p70_similarity_filtered",
    request,
    rows,
    selected_cluster: rows.map(({ offer_id, supplier_id, price }) => ({ offer_id, supplier_id, price })),
    selected_cost: 18.6,
    selected_offer_id: "1033809533807",
    balanced_match: {
      passed: true,
      match_type: "corroborated_multi",
      reason: "two independent outdoor frost-proof faucet suppliers",
      image_available: true,
      supporting_offer_ids: rows.map((row) => row.offer_id),
      expected_specs: {},
    },
  });
  const key = crypto.createHash("sha256").update(evidence).digest("hex");
  return {
    request,
    output: [
      `SAME_ITEM_EVIDENCE ${evidence}`,
      `MATCH_EVIDENCE_KEY ${key}`,
      "SELECTED_OFFER_ID 1033809533807",
      "COST_SOURCE search_first_page_cluster_p70_similarity_filtered",
      "FILTERED_FIRST_PAGE_PRICES [14,18.6]",
      "P70_COST 18.6",
    ].join("\n"),
  };
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

function v7CostCacheKey(item, minimumSameItemMatches = 3) {
  const value = (candidate) => String(candidate ?? "").replace(/\s+/g, " ").trim();
  const sellPrice = Number(item?.sell_price);
  const evidence = {
    expect_title: value(item?.expect_title || item?.title),
    expect_model: value(item?.expect_model || item?.model || item?.model_name || item?.article),
    expect_category: value(item?.expect_category || item?.category_name || item?.cate_name),
    expect_price_cny: Number.isFinite(sellPrice) && sellPrice > 0 ? sellPrice : null,
  };
  return crypto.createHash("sha256").update(JSON.stringify({
    version: 7,
    image_url: String(item?.cover_image || "").trim(),
    minimum_same_item_matches: Math.max(1, Number(minimumSameItemMatches) || 1),
    excluded_offer_ids: [...new Set((item?.excluded_1688_offer_ids || []).map(String))].sort(),
    ...evidence,
  })).digest("hex");
}

test("declared brand and primary model stay bound while compatibility-only generic targets remain soft", () => {
  assert.deepEqual(declaredTargetIdentityBindingConflicts({
    expect_title: "беспроводной геймпад dobe для ps4 / джойстик dualshock ps4, пурпурно-синий",
  }, "p4手柄p4无线蓝牙震动游戏手柄ps4主机游戏手柄"), [
    "declared_brand_missing:dobe",
    "declared_model_missing:dualshock",
  ]);
  assert.deepEqual(declaredTargetIdentityBindingConflicts({
    expect_title: "фильтр воздушный hiflo hfa3612 suzuki sv650/sv1000 03-10",
  }, "适用于铃木sv650 sfv650 sv1000摩托车空气滤清器"), [
    "declared_brand_missing:hiflo",
    "declared_model_missing:HFA3612",
  ]);
  assert.deepEqual(declaredTargetIdentityBindingConflicts({
    expect_title: "generic motorcycle air filter for suzuki sv650",
  }, "适用于铃木sv650摩托车空气滤清器"), []);
  for (const title of [
    "Wireless gamepad for PS4",
    "Controller stand for PS4 / charging station PS4",
    "Protective cover for Samsung S24",
    "Suzuki SV650 motorcycle air filter",
    "Wireless controller for PS5 DualSense PS5",
    "brand for PS4 wireless gamepad",
    "premium for PS4 wireless gamepad",
    "Подходит для адаптера зарядного устройства Xiaomi Type-C65w/ Mi NoteBook Pro/ADC6501TM/ADC6502/Xiaomi Air12.5",
    "10 шт. Ecola GX53 15W 2800K Regular gx53_lamp",
  ]) {
    assert.deepEqual(declaredTargetIdentityBindingConflicts({
      expect_title: title,
      expect_model: "PS4",
    }, "通用 compatible accessory"), [], title);
  }
  assert.deepEqual(declaredTargetIdentityBindingConflicts({
    expect_title: "HiFlo HFA3612 Suzuki SV650 air filter",
    expect_model: "SV650",
  }, "HiFlo SV650 compatible filter"), [
    "declared_model_missing:HFA3612",
  ]);
  assert.deepEqual(declaredTargetIdentityBindingConflicts({
    expect_title: "ACME X100 cover for Samsung S24",
    expect_model: "S24",
  }, "Samsung S24 protective cover"), [
    "declared_brand_missing:acme",
    "declared_model_missing:X100",
  ]);
  assert.deepEqual(declaredTargetIdentityBindingConflicts({
    expect_title: "HiFlo HFA3612 Suzuki SV650 air filter",
  }, "HiFlo HFA3612 motorcycle air filter"), []);
  for (const returned of [
    "Replacement motorcycle air filter for HiFlo HFA3612 Suzuki SV650",
    "Compatible with HiFlo model HFA3612 for Suzuki SV650",
  ]) {
    assert.deepEqual(declaredTargetIdentityBindingConflicts({
      expect_title: "HiFlo HFA3612 Suzuki SV650 air filter",
    }, returned), [
      "declared_brand_missing:hiflo",
      "declared_model_missing:HFA3612",
    ], returned);
  }
  assert.deepEqual(declaredTargetIdentityBindingConflicts({
    expect_title: "DOBE for PS4 wireless DualShock PS4 controller",
  }, "DOBE DualShock PS4 wireless controller"), []);
  for (const returned of [
    "High performance DOBE DualShock PS4 controller",
    "Comfort grip DOBE DualShock PS4 controller",
    "Pro-form DOBE DualShock PS4 controller",
  ]) {
    assert.deepEqual(declaredTargetIdentityBindingConflicts({
      expect_title: "DOBE for PS4 wireless DualShock PS4 controller",
    }, returned), [], returned);
  }
  for (const returned of [
    "Wireless controller compatible with DOBE DualShock PS4",
    "Replacement shell for DOBE DualShock PS4",
  ]) {
    assert.deepEqual(declaredTargetIdentityBindingConflicts({
      expect_title: "DOBE for PS4 wireless DualShock PS4 controller",
    }, returned), [
      "declared_brand_missing:dobe",
      "declared_model_missing:dualshock",
    ], returned);
  }
  for (const returned of [
    "DOBE wireless controller compatible with DualShock PS4",
    "DOBE accessory / replacement for DualShock PS4",
    "DOBE controller for PS4 / compatible DualShock PS4",
    "DOBE DualShock PS5 controller",
    "DOBE DualShock Xbox One controller",
    "DOBE DualShock controller",
  ]) {
    assert.deepEqual(declaredTargetIdentityBindingConflicts({
      expect_title: "DOBE for PS4 wireless DualShock PS4 controller",
    }, returned), [
      "declared_model_missing:dualshock",
    ], returned);
  }
});

test("signed same-item evidence cannot treat a stylus sleeve as the stylus body", () => {
  assert.equal(stylusProductAccessoryRole("iPad stylus pen with tilt support"), "stylus_core");
  assert.equal(stylusProductAccessoryRole("iPad stylus pen with a sleeve"), "stylus_core");
  assert.equal(stylusProductAccessoryRole("触控笔附赠便携笔套"), "stylus_core");
  assert.equal(stylusProductAccessoryRole("触控笔 主动式防误触 赠送笔套"), "stylus_core");
  assert.equal(stylusProductAccessoryRole("触控笔套装2支"), "stylus_core");
  assert.equal(stylusProductAccessoryRole("莱卡弹力触控笔笔套 iPad 手写笔便携收纳笔套"), "stylus_accessory");
  assert.equal(stylusProductAccessoryRole("stylus protective sleeve"), "stylus_accessory");
  assert.equal(stylusProductAccessoryRole("触控笔专用笔套"), "stylus_accessory");
  assert.equal(stylusProductAccessoryRole("Apple Pencil 硅胶保护套"), "stylus_accessory");
  assert.equal(stylusProductAccessoryRole("适用于 Apple Pencil 的收纳笔套"), "stylus_accessory");
  assert.equal(stylusProductAccessoryRole("Чехол для стилуса iPad"), "stylus_accessory");
  assert.equal(stylusProductAccessoryRole("触控笔笔套 带支架"), "stylus_accessory");
  assert.equal(stylusProductAccessoryRole("触控笔专用笔套 赠送收纳盒"), "stylus_accessory");
  assert.equal(stylusProductAccessoryRole("stylus case with holder"), "stylus_accessory");
  assert.equal(stylusProductAccessoryRole("protective sleeve for a ballpoint pen"), null);

  const options = {
    expectedMatchEvidence: { expect_title: "iPad stylus pen with tilt line width" },
    requireSameItemEvidence: true,
    requireBalancedMatch: true,
    minimumSameItemMatches: 3,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  };
  const sleeve = parseCostOutput(returnedSameItemOutput({
    request: options.expectedMatchEvidence,
    title: "iPad stylus sleeve 莱卡弹力触控笔笔套 便携收纳笔套",
  }), 100, options);
  assert.equal(sleeve.ok, false, JSON.stringify(sleeve));
  assert.match(sleeve.reason, /stylus core\/accessory conflict: stylus_core!=stylus_accessory/iu);

  const actualStylus = parseCostOutput(returnedSameItemOutput({
    request: options.expectedMatchEvidence,
    title: "iPad stylus pen active capacitive pen with tilt support",
  }), 100, options);
  assert.equal(actualStylus.ok, true, JSON.stringify(actualStylus));

  const coreWithUnselectedSleeve = returnedSameItemOutput({
    request: options.expectedMatchEvidence,
    prices: [10, 11, 12, 13],
    selectedCost: 11,
    selectedClusterPrices: [10, 11, 12],
    title: "iPad active stylus pen with tilt support",
  });
  const mixedEvidence = JSON.parse(coreWithUnselectedSleeve.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
  mixedEvidence.rows[3].title = "iPad stylus protective sleeve";
  const mixedEncoded = JSON.stringify(mixedEvidence);
  const mixedSigned = coreWithUnselectedSleeve
    .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${mixedEncoded}`)
    .replace(
      /^MATCH_EVIDENCE_KEY\s+.+$/mu,
      `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(mixedEncoded).digest("hex")}`,
    );
  const selectedCore = parseCostOutput(mixedSigned, 100, options);
  assert.equal(selectedCore.ok, true, JSON.stringify(selectedCore));

  const accessoryRequest = { expect_title: "iPad stylus sleeve protective case" };
  const accessory = parseCostOutput(returnedSameItemOutput({
    request: accessoryRequest,
    title: "iPad stylus sleeve protective case holder",
  }), 100, { ...options, expectedMatchEvidence: accessoryRequest });
  assert.equal(accessory.ok, true, JSON.stringify(accessory));

  const accessoryToCore = parseCostOutput(returnedSameItemOutput({
    request: accessoryRequest,
    title: "iPad active stylus pen with tilt support",
  }), 100, { ...options, expectedMatchEvidence: accessoryRequest });
  assert.equal(accessoryToCore.ok, false, JSON.stringify(accessoryToCore));
  assert.match(accessoryToCore.reason, /stylus_accessory!=stylus_core/iu);
});

test("signed same-item evidence cannot use platform compatibility to replace a declared product identity", () => {
  const cases = [
    {
      request: {
        expect_title: "беспроводной геймпад dobe для ps4 / джойстик dualshock ps4, пурпурно-синий",
        expect_category: "电子产品 手动输入设备",
        expect_price_cny: 195.56,
      },
      title: "p4手柄p4无线蓝牙震动游戏手柄ps4主机游戏手柄",
      hit: "ps4",
      reason: /declared_brand_missing:dobe.*declared_model_missing:dualshock/iu,
    },
    {
      request: {
        expect_title: "фильтр воздушный hiflo hfa3612 suzuki sv650\/sv1000 03-10",
        expect_category: "汽车用品 摩托车零件",
        expect_price_cny: 186.91,
      },
      title: "适用于铃木sv650 sfv650 sv1000摩托车空滤空气滤清器",
      hit: "sv650",
      reason: /declared_brand_missing:hiflo.*declared_model_missing:HFA3612/iu,
    },
  ];
  for (const [index, fixture] of cases.entries()) {
    const base = returnedSameItemOutput({
      request: fixture.request,
      prices: [48],
      selectedCost: 48,
      offerIds: [String(9200 + index)],
    });
    const evidence = JSON.parse(base.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
    evidence.rows[0] = {
      ...evidence.rows[0],
      title: fixture.title,
      semantic_hits: { category: [], model: [], title: [fixture.hit] },
      semantic_hits_v3: { model: [fixture.hit], high_information: [fixture.hit], feature: [], product: [] },
      semantic_strength: "exact_model",
      identity_conflicts: [],
    };
    const encoded = JSON.stringify(evidence);
    const signed = base
      .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
      .replace(
        /^MATCH_EVIDENCE_KEY\s+.+$/mu,
        `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`,
      );
    const result = parseCostOutput(signed, 500, {
      expectedMatchEvidence: fixture.request,
      requireSameItemEvidence: true,
      requireBalancedMatch: true,
      minimumSameItemMatches: 1,
      requiredEvidenceContract: "1688-returned-same-item-v3",
    });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.reason, fixture.reason);
  }
});

function imageTextSoftOutput({
  request,
  candidateTitle = "通用配件",
  image = { available: true, score: 0.90, color_score: 0.90, dhash_score: 0.82 },
  identityConflicts = [],
  includeIdentityConflicts = true,
  specConflicts = [],
  accessoryConflict = false,
  selectedCost = 10,
} = {}) {
  const output = returnedSameItemOutput({
    request,
    prices: [selectedCost],
    selectedCost,
    balancedPassed: false,
    offerIds: ["4101"],
  });
  const evidence = JSON.parse(output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
  evidence.rows[0] = {
    ...evidence.rows[0],
    title: candidateTitle,
    semantic_hits: { category: [], model: [], title: [] },
    semantic_hits_v3: { model: [], high_information: [], feature: [], product: [] },
    semantic_strength: "image_backed",
    spec_conflicts: specConflicts,
    ...(includeIdentityConflicts ? { identity_conflicts: identityConflicts } : {}),
    accessory_conflict: accessoryConflict,
    image,
  };
  evidence.balanced_match = {
    ...evidence.balanced_match,
    passed: false,
    match_type: "rejected",
    reason: "fewer than two independent suppliers",
    supporting_offer_ids: [],
  };
  const encoded = JSON.stringify(evidence);
  return output
    .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
    .replace(
      /^MATCH_EVIDENCE_KEY\s+.+$/mu,
      `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`,
    );
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

test("human-review title rules stop risky products before image download or 1688", async () => {
  await withTempDir(async (runDir) => {
    const feedbackFile = path.join(runDir, "错误货源.json");
    await fs.writeFile(feedbackFile, JSON.stringify({
      blocked_title_rules: [{ keywords: ["парфюмерная вода"], reason: "manual-category-filter" }],
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
      sku: "new-perfume",
      title: "Женская парфюмерная вода 100 мл",
      cover_image: "https://img.example/perfume.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(result.feedback_blocked, true);
    assert.equal(result.reason, "manual-feedback-blocked-title-rule");
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

test("validation signed replay cannot be bypassed by trusted feedback or a lower manual cost override", async () => {
  await withTempDir(async (runDir) => {
    const request = { expect_title: "same product lamp" };
    const replayCost = parseCostOutput(returnedSameItemOutput({
      request,
      prices: [18],
      selectedCost: 18,
      offerIds: ["111"],
    }), 100, {
      expectedMatchEvidence: request,
      requireSameItemEvidence: true,
      minimumSameItemMatches: 1,
    });
    const trustedCost = parseCostOutput(returnedSameItemOutput({
      request,
      prices: [20],
      selectedCost: 20,
      offerIds: ["222"],
    }), 100, {
      expectedMatchEvidence: request,
      requireSameItemEvidence: true,
      minimumSameItemMatches: 1,
    });
    const feedbackFile = path.join(runDir, "错误货源.json");
    await fs.writeFile(feedbackFile, JSON.stringify({
      cost_overrides: [{ source_sku: "replay-source", actual_cost: 4 }],
      trusted: {
        trusted: [{
          source_sku: "replay-source",
          selected_offer_id: "222",
          actual_cost: 5,
          updated_at: new Date().toISOString(),
          verified_cost: trustedCost,
        }],
      },
    }));
    let replayCalls = 0;
    const bridge = createCostBridge({
      feedbackFile,
      feedbackRefreshMs: 0,
      minimumSameItemMatches: 1,
      validationSignedEvidenceReplay: {
        estimate: async () => {
          replayCalls += 1;
          return {
            used: true,
            result: { ...replayCost, validation_signed_evidence_replay: true },
          };
        },
      },
      download: async () => assert.fail("replay must not download a new image"),
      runProcess: async () => assert.fail("replay must not run a new matcher"),
    });
    await bridge.refreshProfitFeedback();
    const result = await bridge.estimate({
      sku: "replay-source",
      title: "same product lamp",
      cover_image: "https://img.example/replay.jpg",
      sell_price: 100,
      expect_title: "same product lamp",
    }, runDir);

    assert.equal(replayCalls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.selected_offer_id, "111");
    assert.equal(result.estimated_cost, 18);
    assert.equal(result.cost, 18);
    assert.equal(result.validation_signed_evidence_cost_override_requested, 4);
    assert.equal(result.validation_signed_evidence_original_cost_floor, 18);
    assert.equal(result.validation_signed_evidence_cost_floor_preserved, true);
    assert.equal(result.manual_feedback_cache, undefined);
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
  assert.deepEqual(result.balanced_supporting_offer_evidence, [{
    offer_id: "offer-1",
    title: "same same product",
    supplier_id: "supplier-1",
    image_url: "https://img.example/offer-1.jpg",
    image: {
      available: true,
      score: 0.95,
      color_score: 0.92,
      dhash_score: 0.97,
    },
    semantic_strength: "two_high_information_terms",
    semantic_hits_v3: {
      model: [],
      high_information: ["same"],
      feature: [],
    },
    spec_conflicts: [],
    identity_conflicts: [],
    accessory_conflict: false,
  }]);

  const cached = parseCostOutput(compactCostOutput(output), 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
  });
  assert.deepEqual(
    cached.balanced_supporting_offer_evidence,
    result.balanced_supporting_offer_evidence,
    "compacted cache output must reconstruct the same trusted image evidence",
  );
});

test("normalizes trusted supporting titles and semantic hits through compact cache roundtrips", () => {
  const request = { expect_title: "same product lamp" };
  const output = returnedSameItemOutput({ request, prices: [18], selectedCost: 18 });
  const evidence = JSON.parse(output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
  evidence.rows[0].title = "  same\t\n same   product  ";
  evidence.rows[0].semantic_hits_v3 = {
    model: [],
    high_information: ["  same  ", "same"],
    feature: ["  W1106\tgreen  "],
    product: [],
  };
  const encoded = JSON.stringify(evidence);
  const resigned = output
    .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
    .replace(
      /^MATCH_EVIDENCE_KEY\s+.+$/mu,
      `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`,
    );
  const options = {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    minimumSameItemMatches: 1,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  };
  const direct = parseCostOutput(resigned, 100, options);
  const cached = parseCostOutput(compactCostOutput(resigned), 100, options);

  assert.equal(direct.ok, true);
  assert.equal(direct.balanced_supporting_offer_evidence[0].title, "same same product");
  assert.deepEqual(direct.balanced_supporting_offer_evidence[0].semantic_hits_v3, {
    model: [],
    high_information: ["same"],
    feature: ["W1106 green"],
    product: [],
  });
  assert.deepEqual(cached.balanced_supporting_offer_evidence, direct.balanced_supporting_offer_evidence);
});

test("keeps an unavailable signed supporting row without scores and preserves another row's image evidence", () => {
  const request = { expect_title: "same product lamp" };
  const output = returnedSameItemOutput({
    request,
    prices: [18, 19],
    selectedCost: 19,
    matchType: "corroborated_multi",
  });
  const evidence = JSON.parse(output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
  evidence.rows[1].image = { available: false, reason: "image-timeout" };
  const encoded = JSON.stringify(evidence);
  const resigned = output
    .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
    .replace(
      /^MATCH_EVIDENCE_KEY\s+.+$/mu,
      `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`,
    );
  const options = {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    minimumSameItemMatches: 2,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  };
  const direct = parseCostOutput(resigned, 100, options);
  const cached = parseCostOutput(compactCostOutput(resigned), 100, options);

  assert.equal(direct.ok, true);
  assert.equal(direct.balanced_match_type, "corroborated_multi");
  assert.deepEqual(direct.balanced_supporting_offer_evidence.map((row) => row.offer_id), [
    "offer-1",
    "offer-2",
  ]);
  assert.deepEqual(direct.balanced_supporting_offer_evidence[0].image, {
    available: true,
    score: 0.95,
    color_score: 0.92,
    dhash_score: 0.97,
  });
  assert.deepEqual(direct.balanced_supporting_offer_evidence[1].image, { available: false });
  assert.deepEqual(cached.balanced_supporting_offer_evidence, direct.balanced_supporting_offer_evidence);
});

test("rebinds legacy corroborated supports to a late high-image row covered by the same signed evidence", () => {
  const request = { expect_title: "same product lamp" };
  const output = returnedSameItemOutput({
    request,
    prices: [18, 19, 20],
    selectedCost: 20,
    matchType: "corroborated_multi",
  });
  const parsed = JSON.parse(output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
  parsed.rows[0].image = {
    available: true,
    score: 0.20,
    color_score: 0.40,
    dhash_score: 0.25,
  };
  parsed.rows[1].image = {
    available: true,
    score: 0.30,
    color_score: 0.45,
    dhash_score: 0.30,
  };
  parsed.rows[2].image = {
    available: true,
    score: 0.82,
    color_score: 0.91,
    dhash_score: 0.72,
  };
  parsed.balanced_match.supporting_offer_ids = ["offer-3", "offer-1"];
  const signedOutput = (evidence) => {
    const encoded = JSON.stringify(evidence);
    return output
      .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
      .replace(
        /^MATCH_EVIDENCE_KEY\s+.+$/mu,
        `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`,
      );
  };
  const options = {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    requireBalancedMatch: true,
    minimumSameItemMatches: 3,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  };

  const accepted = parseCostOutput(signedOutput(parsed), 100, options);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.balanced_supporting_offer_ids, ["offer-3", "offer-1"]);
  assert.deepEqual(
    accepted.balanced_supporting_offer_evidence.map((row) => row.offer_id),
    ["offer-3", "offer-1"],
  );

  const missingTrigger = structuredClone(parsed);
  missingTrigger.balanced_match.supporting_offer_ids = ["offer-1", "offer-2"];
  const rebound = parseCostOutput(signedOutput(missingTrigger), 100, options);
  assert.equal(rebound.ok, true);
  assert.equal(rebound.balanced_match_origin, "signed-corroborated-support-rebind-v1");
  assert.deepEqual(rebound.balanced_supporting_offer_ids, ["offer-3", "offer-1"]);
  assert.deepEqual(
    rebound.balanced_supporting_offer_evidence.map((row) => row.offer_id),
    ["offer-3", "offer-1"],
  );
});

test("rejects the real Grommie OBD2 replay when protocol noise forged exact-model semantics", () => {
  const request = {
    expect_title: "Grommie Сканер для диагностики автомобилей OBD2, ОБД2 сканер",
    expect_category: "汽车用品 车库和汽车服务用品",
  };
  const output = returnedSameItemOutput({
    request,
    prices: [29.5, 34.92],
    selectedCost: 34.92,
    matchType: "corroborated_multi",
    offerIds: ["1058662878044", "920057203881"],
  });
  const evidence = JSON.parse(output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
  evidence.rows[0] = {
    ...evidence.rows[0],
    title: "obd2 汽车扫描仪 v315 发动机故障代码读取器和诊断工具",
    semantic_hits: { category: [], model: [], title: ["obd2"] },
    semantic_hits_v3: { model: ["obd2"], high_information: ["obd2"], feature: [], product: [] },
    semantic_strength: "exact_model",
    image: { available: true, score: 0.682938, color_score: 0.96396, dhash_score: 0.5625 },
  };
  evidence.rows[1] = {
    ...evidence.rows[1],
    title: "汽车obd2诊断检测仪v500读码卡检测扫描仪外贸跨境专供",
    semantic_hits: { category: [], model: [], title: ["obd2"] },
    semantic_hits_v3: { model: ["obd2"], high_information: ["obd2"], feature: [], product: [] },
    semantic_strength: "exact_model",
    image: { available: true, score: 0.635662, color_score: 0.952206, dhash_score: 0.5 },
  };
  const encoded = JSON.stringify(evidence);
  const signed = output
    .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
    .replace(
      /^MATCH_EVIDENCE_KEY\s+.+$/mu,
      `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`,
    );
  const result = parseCostOutput(signed, 251.28, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    requireBalancedMatch: true,
    minimumSameItemMatches: 2,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /exact-model semantics rely only on a protocol/u);
  assert.deepEqual(explicitModelIdentityTokens("OBD2 V315 12V WiFi6 2026"), ["V315"]);
});

test("corroborated rows reject V315 versus V500 but keep equal or missing model soft", () => {
  const request = { expect_title: "Grommie scanner OBD2" };
  const base = returnedSameItemOutput({
    request,
    prices: [29.5, 34.92],
    selectedCost: 34.92,
    matchType: "corroborated_multi",
    offerIds: ["1058662878044", "920057203881"],
  });
  const parsed = JSON.parse(base.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
  const signedOutput = (secondTitle) => {
    const evidence = structuredClone(parsed);
    for (const [index, title] of [
      "OBD2 automotive scanner V315",
      secondTitle,
    ].entries()) {
      evidence.rows[index].title = title;
      evidence.rows[index].semantic_hits = { category: [], model: [], title: ["obd2"] };
      evidence.rows[index].semantic_hits_v3 = { model: [], high_information: ["obd2"], feature: [], product: [] };
      evidence.rows[index].semantic_strength = "one_high_information_term";
    }
    const encoded = JSON.stringify(evidence);
    return base
      .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
      .replace(
        /^MATCH_EVIDENCE_KEY\s+.+$/mu,
        `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`,
      );
  };
  const options = {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    requireBalancedMatch: true,
    minimumSameItemMatches: 2,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  };

  const conflict = parseCostOutput(signedOutput("OBD2 automotive scanner V500"), 251.28, options);
  const same = parseCostOutput(signedOutput("OBD2 automotive scanner V315"), 251.28, options);
  const missing = parseCostOutput(signedOutput("OBD2 generic automotive scanner"), 251.28, options);
  assert.equal(conflict.ok, false);
  assert.match(conflict.reason, /explicit_supporting_model_conflict:V315!=V500/u);
  assert.equal(same.ok, true, JSON.stringify(same));
  assert.equal(missing.ok, true, JSON.stringify(missing));
});

test("derives one signed same-product image row as strong_single without a second supplier", () => {
  const request = { expect_title: "shokz charging data cable" };
  const output = returnedSameItemOutput({
    request,
    prices: [10],
    selectedCost: 10,
    balancedPassed: false,
    offerIds: ["1001"],
  });
  const evidence = JSON.parse(output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
  evidence.rows[0] = {
    ...evidence.rows[0],
    title: "shokz magnetic charging data cable",
    semantic_strength: "one_high_information_plus_product",
    semantic_hits: { category: [], model: [], title: ["shokz"] },
    semantic_hits_v3: {
      model: [],
      high_information: ["shokz"],
      feature: [],
      product: ["data_cable"],
    },
    image: { available: true, score: 0.74, color_score: 0.94, dhash_score: 0.64 },
  };
  const encoded = JSON.stringify(evidence);
  const signed = output
    .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
    .replace(
      /^MATCH_EVIDENCE_KEY\s+.+$/mu,
      `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`,
    );
  const options = {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    requireBalancedMatch: true,
    minimumSameItemMatches: 3,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  };
  const direct = parseCostOutput(signed, 100, options);
  const cached = parseCostOutput(compactCostOutput(signed), 100, options);

  assert.equal(direct.ok, true);
  assert.equal(direct.balanced_match, true);
  assert.equal(direct.balanced_match_type, "strong_single");
  assert.equal(direct.balanced_match_origin, "signed-image-primary-strong-single-v1");
  assert.deepEqual(direct.balanced_supporting_offer_ids, ["1001"]);
  assert.equal(direct.balanced_supporting_offer_evidence[0].offer_id, "1001");
  assert.deepEqual(cached.balanced_supporting_offer_evidence, direct.balanced_supporting_offer_evidence);
  assert.equal(cached.balanced_match_origin, direct.balanced_match_origin);
});

test("recovers a text-missing signed row only at strict visual thresholds and without explicit identity conflicts", () => {
  const request = {
    expect_title: "Apple charging cable X100 black Type-C 1 pcs",
    expect_model: "X100",
    expect_price_cny: 100,
  };
  const signedTextSoftOutput = ({
    candidateTitle = "通用配件",
    image = { available: true, score: 0.90, color_score: 0.90, dhash_score: 0.82 },
    identityConflicts = [],
    includeIdentityConflicts = true,
    requestOverrides = {},
  } = {}) => {
    const effectiveRequest = { ...request, ...requestOverrides };
    const output = returnedSameItemOutput({
      request: effectiveRequest,
      prices: [10],
      selectedCost: 10,
      balancedPassed: false,
      offerIds: ["4101"],
    });
    const evidence = JSON.parse(output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
    evidence.rows[0] = {
      ...evidence.rows[0],
      title: candidateTitle,
      semantic_hits: { category: [], model: [], title: [] },
      semantic_hits_v3: { model: [], high_information: [], feature: [], product: [] },
      semantic_strength: "image_backed",
      spec_conflicts: [],
      ...(includeIdentityConflicts ? { identity_conflicts: identityConflicts } : {}),
      accessory_conflict: false,
      image,
    };
    const encoded = JSON.stringify(evidence);
    return {
      request: effectiveRequest,
      output: output
        .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
        .replace(
          /^MATCH_EVIDENCE_KEY\s+.+$/mu,
          `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`,
        ),
    };
  };
  const parse = (fixture) => parseCostOutput(fixture.output, 100, {
    expectedMatchEvidence: fixture.request,
    requireSameItemEvidence: true,
    requireBalancedMatch: true,
    minimumSameItemMatches: 3,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  });

  const accepted = parse(signedTextSoftOutput());
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.balanced_match_type, "strong_single");
  assert.equal(accepted.balanced_match_origin, "signed-image-primary-strong-single-v1");
  assert.equal(accepted.balanced_supporting_offer_evidence[0].semantic_strength, "image_backed");
  assert.deepEqual(accepted.balanced_supporting_offer_evidence[0].identity_conflicts, []);

  const unsafeFixtures = [
    ["score", signedTextSoftOutput({ image: { available: true, score: 0.899, color_score: 0.90, dhash_score: 0.82 } })],
    ["color", signedTextSoftOutput({ image: { available: true, score: 0.90, color_score: 0.899, dhash_score: 0.82 } })],
    ["dhash", signedTextSoftOutput({ image: { available: true, score: 0.90, color_score: 0.90, dhash_score: 0.819 } })],
    ["model", signedTextSoftOutput({ candidateTitle: "通用配件 Y200" })],
    ["brand", signedTextSoftOutput({ candidateTitle: "Samsung 通用配件" })],
    ["color conflict", signedTextSoftOutput({ candidateTitle: "白色 通用配件" })],
    ["interface", signedTextSoftOutput({ candidateTitle: "Micro-USB 通用配件" })],
    ["bundle", signedTextSoftOutput({ candidateTitle: "2 pcs 通用配件" })],
    ["product role", signedTextSoftOutput({ candidateTitle: "智能手表" })],
    ["missing signed identity binding", signedTextSoftOutput({ includeIdentityConflicts: false })],
    ["signed conflict", signedTextSoftOutput({ identityConflicts: ["explicit_model_conflict:X100!=Y200"] })],
    ["high-value digital", signedTextSoftOutput({
      requestOverrides: {
        expect_title: "Apple smartphone X100 black Type-C 1 pcs",
        expect_price_cny: 500,
      },
    })],
  ];
  for (const [label, fixture] of unsafeFixtures) {
    const rejected = parse(fixture);
    assert.equal(rejected.ok, false, `${label}: ${JSON.stringify(rejected)}`);
  }
});

test("does not lower the one-row minimum for a generic signed rejection", () => {
  const request = { expect_title: "generic product lamp" };
  const output = returnedSameItemOutput({
    request,
    prices: [10],
    selectedCost: 10,
    balancedPassed: false,
    offerIds: ["1101"],
  });
  const result = parseCostOutput(output, 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    requireBalancedMatch: true,
    minimumSameItemMatches: 3,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /balanced match rejected/iu);
});

test("accepts exactly two independent signed corroborated suppliers while generic evidence still needs three", () => {
  const request = { expect_title: "same product lamp" };
  const output = returnedSameItemOutput({
    request,
    prices: [10, 11],
    selectedCost: 11,
    balancedPassed: true,
    matchType: "corroborated_multi",
    offerIds: ["1201", "1202"],
  });
  const result = parseCostOutput(output, 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    requireBalancedMatch: true,
    minimumSameItemMatches: 3,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  });

  assert.equal(result.ok, true);
  assert.equal(result.balanced_match_type, "corroborated_multi");
  assert.deepEqual(result.balanced_supporting_offer_ids, ["1201", "1202"]);
  assert.equal(result.matched_offer_count, 2);
  assert.equal(requiredSameItemMatchCount(result, 1), 2, "configuration cannot reduce corroboration below two suppliers");
});

test("accepts the real 3603926157 outdoor frostproof faucet replay through signed product-role semantics", () => {
  const fixture = signedOutdoorFrostproofFaucetOutput();
  const result = parseCostOutput(fixture.output, 32.16, {
    expectedMatchEvidence: fixture.request,
    requireSameItemEvidence: true,
    requireBalancedMatch: true,
    minimumSameItemMatches: 3,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.balanced_match_type, "corroborated_multi");
  assert.deepEqual(result.balanced_supporting_offer_ids, ["1026754645067", "1033809533807"]);
  assert.deepEqual(
    result.balanced_supporting_offer_evidence.map((row) => row.semantic_hits_v3.product),
    [["outdoor_frostproof_faucet"], ["outdoor_frostproof_faucet"]],
  );
});

test("signed outdoor-faucet role cannot disguise faucet accessories, valves, or plain fittings", () => {
  const cases = {
    "faucet accessories": ["户外水龙头延长接头配件", "庭院水嘴转接器配件"],
    valves: ["户外防冻水龙头球阀阀门", "庭院室外水嘴止回阀"],
    "plain fittings": ["户外花园水管接头", "室外防冻管件弯头"],
  };
  for (const [label, titles] of Object.entries(cases)) {
    const fixture = signedOutdoorFrostproofFaucetOutput({ titles });
    const result = parseCostOutput(fixture.output, 32.16, {
      expectedMatchEvidence: fixture.request,
      requireSameItemEvidence: true,
      requireBalancedMatch: true,
      minimumSameItemMatches: 3,
      requiredEvidenceContract: "1688-returned-same-item-v3",
    });
    assert.equal(result.ok, false, `${label}: ${JSON.stringify(result)}`);
    assert.match(result.reason, /no explicit title\/model\/category semantic hit/iu, label);
  }
});

test("the signed single-image fallback still blocks wrong consumable models, printer consumables, and color conflicts", () => {
  const cases = [
    {
      request: { expect_title: "картридж T0921 Epson Stylus black" },
      returnedTitle: "картридж Epson Stylus 墨盒 T0341 black",
      product: "cartridge",
    },
    {
      request: { expect_title: "printer HP LaserJet 4003dw black white" },
      returnedTitle: "printer HP LaserJet toner cartridge black",
      product: "printer",
    },
    {
      request: { expect_title: "shokz black charging data cable" },
      returnedTitle: "shokz white charging data cable",
      product: "data_cable",
    },
  ];
  for (const [index, fixture] of cases.entries()) {
    const output = returnedSameItemOutput({
      request: fixture.request,
      balancedPassed: false,
      offerIds: [String(2001 + index * 10), String(2002 + index * 10), String(2003 + index * 10)],
    });
    const evidence = JSON.parse(output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
    const legacyTitleHit = Object.values(evidence.rows[0].semantic_hits).flat().find(Boolean);
    evidence.rows[0] = {
      ...evidence.rows[0],
      title: `${legacyTitleHit} ${fixture.returnedTitle}`,
      semantic_strength: "one_high_information_plus_product",
      semantic_hits_v3: {
        model: [],
        high_information: [String(legacyTitleHit)],
        feature: [],
        product: [fixture.product],
      },
      image: { available: true, score: 0.91, color_score: 0.97, dhash_score: 0.82 },
    };
    const encoded = JSON.stringify(evidence);
    const signed = output
      .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
      .replace(
        /^MATCH_EVIDENCE_KEY\s+.+$/mu,
        `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`,
      );
    const result = parseCostOutput(signed, 100, {
      expectedMatchEvidence: fixture.request,
      requireSameItemEvidence: true,
      requireBalancedMatch: true,
      minimumSameItemMatches: 3,
      requiredEvidenceContract: "1688-returned-same-item-v3",
    });
    assert.equal(result.ok, false, `unsafe fixture ${index + 1} must remain rejected`);
    assert.match(result.reason, /balanced match rejected/iu);
  }
});

test("an exact requested consumable model may use the signed strong-single image lane", () => {
  const request = {
    expect_title: "картридж W1106A HP Laser 107",
    expect_model: "W1106A",
  };
  const output = returnedSameItemOutput({
    request,
    balancedPassed: false,
    offerIds: ["3001", "3002", "3003"],
  });
  const result = parseCostOutput(output, 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    requireBalancedMatch: true,
    minimumSameItemMatches: 3,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  });

  assert.equal(result.ok, true);
  assert.equal(result.balanced_match_type, "strong_single");
  assert.equal(result.balanced_match_origin, "signed-image-primary-strong-single-v1");
  assert.deepEqual(result.balanced_supporting_offer_ids, ["3001"]);
});

test("accepts Python image_backed semantics for corroborated multi-source evidence only with existing safeguards", () => {
  const request = { expect_title: "same product lamp" };
  const output = returnedSameItemOutput({
    request,
    prices: [18, 19],
    selectedCost: 19,
    matchType: "corroborated_multi",
  });
  const parsed = JSON.parse(output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
  parsed.rows[0].semantic_strength = "image_backed";
  parsed.rows[1].image = { available: false };
  const signedOutput = (evidence) => {
    const encoded = JSON.stringify(evidence);
    return output
      .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
      .replace(
        /^MATCH_EVIDENCE_KEY\s+.+$/mu,
        `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`,
      );
  };
  const options = {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    minimumSameItemMatches: 2,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  };
  const accepted = parseCostOutput(signedOutput(parsed), 100, options);

  assert.equal(accepted.ok, true);
  assert.deepEqual(
    accepted.balanced_supporting_offer_evidence.map((row) => row.semantic_strength),
    ["image_backed", "two_high_information_terms"],
  );

  const forgedImageBacked = structuredClone(parsed);
  forgedImageBacked.rows[1].semantic_strength = "image_backed";
  const unbound = parseCostOutput(signedOutput(forgedImageBacked), 100, options);
  assert.equal(unbound.ok, false);
  assert.match(unbound.reason, /image-backed semantics lack the required bound image score/i);

  const conflicted = structuredClone(parsed);
  conflicted.rows[1].accessory_conflict = true;
  const rejected = parseCostOutput(signedOutput(conflicted), 100, options);
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /multi-source v3 evidence lacks independent suppliers, semantics, image or specification agreement/i);
});

test("does not expose overlong trusted titles or supplier identities", () => {
  const request = { expect_title: "same product lamp" };
  const output = returnedSameItemOutput({ request, prices: [18], selectedCost: 18 });
  const evidence = JSON.parse(output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
  evidence.rows[0].title = `same product lamp ${"x".repeat(1_001)}`;
  evidence.rows[0].supplier_id = `supplier-${"x".repeat(512)}`;
  evidence.selected_cluster[0].supplier_id = evidence.rows[0].supplier_id;
  const encoded = JSON.stringify(evidence);
  const resigned = output
    .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
    .replace(
      /^MATCH_EVIDENCE_KEY\s+.+$/mu,
      `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`,
    );
  const result = parseCostOutput(resigned, 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    minimumSameItemMatches: 1,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  });

  assert.equal(result.ok, true);
  assert.equal(result.balanced_match, true);
  assert.equal("balanced_supporting_offer_evidence" in result, false);
});

test("omits malformed optional semantic hits without dropping trusted core image evidence", () => {
  const request = { expect_title: "same product lamp" };
  const output = returnedSameItemOutput({ request, prices: [18], selectedCost: 18 });
  const evidence = JSON.parse(output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
  evidence.rows[0].semantic_hits_v3 = { model: [], feature: [42] };
  const encoded = JSON.stringify(evidence);
  const resigned = output
    .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
    .replace(
      /^MATCH_EVIDENCE_KEY\s+.+$/mu,
      `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`,
    );
  const result = parseCostOutput(resigned, 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    minimumSameItemMatches: 1,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  });

  assert.equal(result.ok, true);
  assert.equal(result.balanced_supporting_offer_evidence.length, 1);
  assert.equal("semantic_hits_v3" in result.balanced_supporting_offer_evidence[0], false);
});

test("rejects malformed signed supporting-image component metrics", () => {
  const request = { expect_title: "same product lamp" };
  const output = returnedSameItemOutput({ request, prices: [18], selectedCost: 18 });
  const evidence = JSON.parse(output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
  evidence.rows[0].image.color_score = 1.01;
  evidence.rows[0].image.dhash_score = "0.97";
  const encoded = JSON.stringify(evidence);
  const resigned = output
    .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
    .replace(
      /^MATCH_EVIDENCE_KEY\s+.+$/mu,
      `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`,
    );
  const result = parseCostOutput(resigned, 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    minimumSameItemMatches: 1,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /invalid image similarity components/iu);
});

test("does not expose a re-signed balanced support identity outside verified rows", () => {
  const request = { expect_title: "same product lamp" };
  const output = returnedSameItemOutput({ request, prices: [18], selectedCost: 18 });
  const evidence = JSON.parse(output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
  evidence.balanced_match.supporting_offer_ids = ["forged-offer"];
  const encoded = JSON.stringify(evidence);
  const resigned = output
    .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
    .replace(
      /^MATCH_EVIDENCE_KEY\s+.+$/mu,
      `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`,
    );
  const result = parseCostOutput(resigned, 100, {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    minimumSameItemMatches: 1,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /support identities are invalid or outside returned rows/i);
  assert.equal("balanced_supporting_offer_evidence" in result, false);
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

test("validation replay may derive one legacy v3 selected offer only from a unique signed selected-cost row", () => {
  const request = { expect_title: "same product lamp", expect_price_cny: 100 };
  const current = returnedSameItemOutput({
    request,
    prices: [18, 21],
    selectedCost: 18,
  });
  const evidence = JSON.parse(current.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
  delete evidence.selected_offer_id;
  const encoded = JSON.stringify(evidence);
  const legacy = current
    .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encoded}`)
    .replace(/^MATCH_EVIDENCE_KEY\s+.+$/mu, `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encoded).digest("hex")}`)
    .replace(/^SELECTED_OFFER_ID\s+.+\n?/mu, "");
  const options = {
    expectedMatchEvidence: request,
    requireSameItemEvidence: true,
    minimumSameItemMatches: 1,
    requiredEvidenceContract: "1688-returned-same-item-v3",
  };

  const defaultResult = parseCostOutput(legacy, 100, options);
  const replayResult = parseCostOutput(legacy, 100, {
    ...options,
    allowSignedSelectedOfferDerivation: true,
  });

  assert.equal(defaultResult.ok, false);
  assert.match(defaultResult.reason, /missing exact selected 1688 offer identity/i);
  assert.equal(replayResult.ok, true);
  assert.equal(replayResult.selected_offer_id, "offer-1");
  assert.equal(replayResult.selected_offer_id_origin, "signed-selected-cost-unique-row-v1");

  const ambiguousCurrent = returnedSameItemOutput({
    request,
    prices: [18, 18],
    selectedCost: 18,
  });
  const ambiguousEvidence = JSON.parse(
    ambiguousCurrent.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}",
  );
  delete ambiguousEvidence.selected_offer_id;
  const ambiguousEncoded = JSON.stringify(ambiguousEvidence);
  const ambiguousLegacy = ambiguousCurrent
    .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${ambiguousEncoded}`)
    .replace(/^MATCH_EVIDENCE_KEY\s+.+$/mu, `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(ambiguousEncoded).digest("hex")}`)
    .replace(/^SELECTED_OFFER_ID\s+.+\n?/mu, "");
  const ambiguousResult = parseCostOutput(ambiguousLegacy, 100, {
    ...options,
    allowSignedSelectedOfferDerivation: true,
  });
  assert.equal(ambiguousResult.ok, false);
  assert.match(ambiguousResult.reason, /missing exact selected 1688 offer identity/i);
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
    assert.equal(result.match_policy_version, CURRENT_MATCH_POLICY_VERSION);

    const cached = await bridge.estimate({
      sku: "review-2",
      cover_image: "https://example.invalid/cover.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(cached.ok, false);
    assert.equal(cached.reason, result.reason);
    assert.equal(cached.match_policy_version, CURRENT_MATCH_POLICY_VERSION);
    assert.equal(cached.shared_cache, true);
    assert.equal(runs, 1);
  });
});

test("an unversioned local output is revalidated in JavaScript without being relabeled as a live current-policy search", async () => {
  await withTempDir(async (runDir) => {
    const item = {
      sku: "local-output-no-policy-laundering",
      cover_image: "https://img.example/local-output.jpg",
      sell_price: 100,
      expect_title: "same product lamp",
    };
    const outputPath = path.join(runDir, "1688", `${item.sku}.out`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, returnedSameItemOutput({
      request: { expect_title: item.expect_title, expect_price_cny: item.sell_price },
    }));
    let runs = 0;
    const bridge = createCostBridge({
      cacheFlushDebounceMs: 0,
      runProcess: async () => { runs += 1; throw new Error("local output must avoid the worker"); },
      download: async () => { throw new Error("local output must avoid image download"); },
    });

    const result = await bridge.estimate(item, runDir);
    await bridge.close();

    assert.equal(result.ok, true);
    assert.equal(result.cached, true);
    assert.equal(result.match_policy_version, undefined);
    assert.equal(result.search_executed_live, false);
    assert.equal(runs, 0);
    const persisted = JSON.parse(await fs.readFile(path.join(runDir, "1688_cache.json"), "utf8"));
    const entry = persisted.entries[v7CostCacheKey(item)];
    assert.ok(entry);
    assert.equal(Object.hasOwn(entry, "match_policy_version"), false);
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

test("cache flush debounce defaults to 60 seconds and rejects unsafe ranges", () => {
  assert.equal(DEFAULT_1688_CACHE_FLUSH_DEBOUNCE_MS, 60_000);
  assert.equal(normalize1688CacheFlushDebounceMs(), 60_000);
  assert.equal(normalize1688CacheFlushDebounceMs("60000"), 60_000);
  assert.equal(normalize1688CacheFlushDebounceMs(0), 0, "tests and explicit immediate flush remain supported");
  for (const invalid of [-1, 1.5, Number.NaN, MAX_1688_CACHE_FLUSH_DEBOUNCE_MS + 1]) {
    assert.throws(
      () => normalize1688CacheFlushDebounceMs(invalid),
      /must be an integer between 0 and 300000/u,
    );
  }
});

test("a 60-second burst is one generation, one serialization, and byte-identical run/shared writes", async (t) => {
  await withTempDir(async (root) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const runDir = path.join(root, "run");
    const sharedCachePath = path.join(root, "shared", "1688_cache.json");
    let serializations = 0;
    const writes = [];
    const bridge = createCostBridge({
      sharedCachePath,
      totalBudgetMs: 10_000,
      workerPool: {
        run: async () => ({
          code: 2,
          stdout: [
            "REASON no explicit title/model/category semantic same-item matches",
            "P70_COST None",
          ].join("\n"),
          stderr: "",
        }),
        close: async () => {},
      },
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      serializeCache: (cache) => {
        serializations += 1;
        return `${JSON.stringify(cache)}\n`;
      },
      writeCache: async (filename, _cache, serializedPayload) => {
        writes.push(path.resolve(filename));
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, serializedPayload, "utf8");
      },
    });

    await Promise.all(Array.from({ length: 6 }, (_, index) => bridge.estimate({
      sku: `debounced-burst-${index}`,
      cover_image: `https://img.example/debounced-burst-${index}.jpg`,
      sell_price: 100,
    }, runDir)));
    assert.equal(writes.length, 0);
    t.mock.timers.tick(DEFAULT_1688_CACHE_FLUSH_DEBOUNCE_MS - 1);
    await Promise.resolve();
    assert.equal(writes.length, 0);
    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    await bridge.close();

    assert.equal(serializations, 1);
    assert.deepEqual(new Set(writes), new Set([
      path.resolve(runDir, "1688_cache.json"),
      path.resolve(sharedCachePath),
    ]));
    assert.equal(writes.length, 2, "one generation writes exactly the two configured targets");
    const [runBytes, sharedBytes] = await Promise.all([
      fs.readFile(path.join(runDir, "1688_cache.json")),
      fs.readFile(sharedCachePath),
    ]);
    assert.equal(Buffer.compare(runBytes, sharedBytes), 0);
    assert.equal(Object.keys(JSON.parse(runBytes).entries).length, 6);
  });
});

test("close bypasses the 60-second timer and immediately flushes exactly once", async (t) => {
  await withTempDir(async (root) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const runDir = path.join(root, "run");
    const sharedCachePath = path.join(root, "shared", "1688_cache.json");
    let serializations = 0;
    let writes = 0;
    const bridge = createCostBridge({
      sharedCachePath,
      workerPool: {
        run: async () => ({ code: 2, stdout: "REASON no match\nP70_COST None", stderr: "" }),
        close: async () => {},
      },
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      serializeCache: (cache) => {
        serializations += 1;
        return `${JSON.stringify(cache)}\n`;
      },
      writeCache: async (filename, _cache, serializedPayload) => {
        writes += 1;
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, serializedPayload, "utf8");
      },
    });

    await bridge.estimate({
      sku: "shutdown-flush",
      cover_image: "https://img.example/shutdown-flush.jpg",
      sell_price: 100,
    }, runDir);
    assert.equal(writes, 0);
    await bridge.close();
    assert.equal(serializations, 1);
    assert.equal(writes, 2);
    t.mock.timers.runAll();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes, 2, "the cancelled debounce timer cannot emit a second generation");
  });
});

test("close waits for an active estimate before taking the final cache snapshot", async () => {
  await withTempDir(async (runDir) => {
    let markWorkerStarted;
    let releaseWorker;
    const workerStarted = new Promise((resolve) => { markWorkerStarted = resolve; });
    const workerReleased = new Promise((resolve) => { releaseWorker = resolve; });
    const bridge = createCostBridge({
      workerPool: {
        run: async () => {
          markWorkerStarted();
          await workerReleased;
          return { code: 2, stdout: "REASON no match\nP70_COST None", stderr: "" };
        },
        close: async () => {},
      },
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
    });

    const estimate = bridge.estimate({
      sku: "active-at-shutdown",
      cover_image: "https://img.example/active-at-shutdown.jpg",
      sell_price: 100,
    }, runDir);
    await workerStarted;
    let closed = false;
    const closing = bridge.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);

    releaseWorker();
    await Promise.all([estimate, closing]);
    assert.equal(closed, true);
    const persisted = JSON.parse(await fs.readFile(path.join(runDir, "1688_cache.json"), "utf8"));
    assert.equal(Object.keys(persisted.entries).length, 1);
    await assert.rejects(
      bridge.estimate({
        sku: "after-shutdown",
        cover_image: "https://img.example/after-shutdown.jpg",
        sell_price: 100,
      }, runDir),
      (error) => error?.code === "FLOW_B_1688_COST_BRIDGE_CLOSING",
    );
  });
});

test("close drains a raw worker that outlives the public deadline and includes its final cache write", async () => {
  await withTempDir(async (runDir) => {
    let markWorkerStarted;
    let releaseWorker;
    const workerStarted = new Promise((resolve) => { markWorkerStarted = resolve; });
    const workerReleased = new Promise((resolve) => { releaseWorker = resolve; });
    let writes = 0;
    const bridge = createCostBridge({
      totalBudgetMs: 25,
      shutdownDrainTimeoutMs: 500,
      cacheFlushDebounceMs: 60_000,
      workerPool: {
        run: async () => {
          markWorkerStarted();
          await workerReleased;
          return { code: 2, stdout: "REASON no match\nP70_COST None", stderr: "" };
        },
        close: async () => {},
      },
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      writeCache: async (filename, _cache, serializedPayload) => {
        writes += 1;
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, serializedPayload, "utf8");
      },
    });

    const estimate = bridge.estimate({
      sku: "raw-after-public-timeout",
      cover_image: "https://img.example/raw-after-public-timeout.jpg",
      sell_price: 100,
    }, runDir);
    await workerStarted;
    const publicResult = await estimate;
    assert.equal(publicResult.error?.code, "1688-total-timeout");
    assert.equal(writes, 0);

    let closed = false;
    const closing = bridge.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false, "close must still track the underlying raw operation");
    assert.equal(writes, 0);

    releaseWorker();
    await closing;
    assert.equal(writes, 1, "close performs the final write without a second explicit flush");
    const persisted = JSON.parse(await fs.readFile(path.join(runDir, "1688_cache.json"), "utf8"));
    assert.equal(Object.keys(persisted.entries).length, 1);
  });
});

test("a bounded raw drain fences a late result from mutating or scheduling cache after close", async () => {
  await withTempDir(async (runDir) => {
    let markWorkerStarted;
    let releaseWorker;
    const workerStarted = new Promise((resolve) => { markWorkerStarted = resolve; });
    const workerReleased = new Promise((resolve) => { releaseWorker = resolve; });
    let writes = 0;
    let workerCloses = 0;
    const bridge = createCostBridge({
      totalBudgetMs: 20,
      shutdownDrainTimeoutMs: 30,
      shutdownFlushTimeoutMs: 100,
      cacheFlushDebounceMs: 60_000,
      workerPool: {
        run: async () => {
          markWorkerStarted();
          await workerReleased;
          return { code: 2, stdout: "REASON no match\nP70_COST None", stderr: "" };
        },
        close: async () => { workerCloses += 1; },
      },
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      writeCache: async () => { writes += 1; },
    });

    const estimate = bridge.estimate({
      sku: "raw-fenced-after-close",
      cover_image: "https://img.example/raw-fenced-after-close.jpg",
      sell_price: 100,
    }, runDir);
    await workerStarted;
    assert.equal((await estimate).error?.code, "1688-total-timeout");
    await assert.rejects(
      bridge.close(),
      (error) => error?.code === "FLOW_B_1688_SHUTDOWN_DRAIN_TIMEOUT",
    );
    assert.equal(workerCloses, 1, "worker cleanup still runs after a drain timeout");
    assert.equal(writes, 0);

    releaseWorker();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(writes, 0, "the late raw result is explicitly non-reusable after the fence");
    await assert.rejects(
      fs.readFile(path.join(runDir, "1688_cache.json")),
      (error) => error?.code === "ENOENT",
    );
  });
});

test("a transient second-target failure is visible and close retries to byte-identical convergence", async () => {
  await withTempDir(async (root) => {
    const runDir = path.join(root, "run");
    const sharedCachePath = path.join(root, "shared", "1688_cache.json");
    const attempts = [];
    let serializations = 0;
    let failSharedOnce = true;
    const bridge = createCostBridge({
      sharedCachePath,
      cacheFlushDebounceMs: 60_000,
      workerPool: {
        run: async () => ({ code: 2, stdout: "REASON no match\nP70_COST None", stderr: "" }),
        close: async () => {},
      },
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      serializeCache: (cache) => {
        serializations += 1;
        return `${JSON.stringify(cache)}\n`;
      },
      writeCache: async (filename, _cache, serializedPayload) => {
        attempts.push(path.resolve(filename));
        if (path.resolve(filename) === path.resolve(sharedCachePath) && failSharedOnce) {
          failSharedOnce = false;
          throw new Error("shared cache unavailable once");
        }
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, serializedPayload, "utf8");
      },
    });

    await bridge.estimate({
      sku: "partial-target-retry",
      cover_image: "https://img.example/partial-target-retry.jpg",
      sell_price: 100,
    }, runDir);
    await assert.rejects(bridge.close(), /shared cache unavailable once/u);

    assert.equal(serializations, 1, "the retried generation reuses its frozen serialized bytes");
    assert.equal(attempts.filter((filename) => filename === path.resolve(runDir, "1688_cache.json")).length, 1);
    assert.equal(attempts.filter((filename) => filename === path.resolve(sharedCachePath)).length, 2);
    const [runBytes, sharedBytes] = await Promise.all([
      fs.readFile(path.join(runDir, "1688_cache.json")),
      fs.readFile(sharedCachePath),
    ]);
    assert.equal(Buffer.compare(runBytes, sharedBytes), 0);
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
    let workerCloses = 0;
    const bridge = createCostBridge({
      totalBudgetMs: 80,
      cacheFlushDebounceMs: 0,
      workerPool: {
        run: async () => ({
          code: 2,
          stdout: "REASON no match\nP70_COST None",
          stderr: "",
        }),
        close: async () => { workerCloses += 1; },
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
    await assert.rejects(bridge.close(), /cache disk unavailable/);
    assert.equal(workerCloses, 1, "a repeated close preserves the first failure without closing twice");
  });
});

test("a hanging cache write times out visibly while worker cleanup still completes", async () => {
  await withTempDir(async (runDir) => {
    let markWriteStarted;
    const writeStarted = new Promise((resolve) => { markWriteStarted = resolve; });
    let workerCloses = 0;
    const bridge = createCostBridge({
      shutdownFlushTimeoutMs: 30,
      cacheFlushDebounceMs: 0,
      workerPool: {
        run: async () => ({ code: 2, stdout: "REASON no match\nP70_COST None", stderr: "" }),
        close: async () => { workerCloses += 1; },
      },
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      writeCache: async () => {
        markWriteStarted();
        return new Promise(() => {});
      },
    });

    await bridge.estimate({
      sku: "hanging-final-cache-write",
      cover_image: "https://img.example/hanging-final-cache-write.jpg",
      sell_price: 100,
    }, runDir);
    await writeStarted;
    await assert.rejects(
      bridge.close(),
      (error) => error?.code === "FLOW_B_1688_CACHE_FLUSH_TIMEOUT",
    );
    assert.equal(workerCloses, 1);
  });
});

test("the public 1688 deadline releases a hung request and permits the next SKU", async () => {
  await withTempDir(async (runDir) => {
    const bridge = createCostBridge({
      totalBudgetMs: 40,
      shutdownDrainTimeoutMs: 30,
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
    await assert.rejects(
      bridge.close(),
      (error) => error?.code === "FLOW_B_1688_SHUTDOWN_DRAIN_TIMEOUT",
    );
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

test("an explicit v1 code2 semantic miss is refreshed live once and only the live result gains v2 provenance", async () => {
  await withTempDir(async (root) => {
    const runDir = path.join(root, "run");
    const sharedCachePath = path.join(root, "shared", "1688_cache.json");
    const item = {
      sku: "stale-v1-semantic-miss-1",
      cover_image: "https://img.example/stale-v1-semantic-miss.jpg",
      sell_price: 100,
      expect_title: "same product lamp",
    };
    const reason = "no explicit title/model/category semantic same-item matches";
    const key = v7CostCacheKey(item);
    await fs.mkdir(path.dirname(sharedCachePath), { recursive: true });
    await fs.writeFile(sharedCachePath, JSON.stringify({ version: 1, entries: {
      [key]: {
        output: `REASON ${reason}\nP70_COST None`,
        terminal: true,
        deferred: false,
        process_code: 2,
        reason,
        match_policy_version: "image-text-soft-v1",
      },
    } }));
    let runs = 0;
    const bridge = createCostBridge({
      sharedCachePath,
      cacheFlushDebounceMs: 0,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async ({ args }) => {
        runs += 1;
        return {
          code: 0,
          stdout: returnedSameItemOutput({ request: cliMatchRequest(args) }),
          stderr: "",
        };
      },
    });

    const refreshed = await bridge.estimate(item, runDir);
    const reused = await bridge.estimate({ ...item, sku: "stale-v1-semantic-miss-2" }, runDir);
    await bridge.close();

    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.match_policy_version, CURRENT_MATCH_POLICY_VERSION);
    assert.equal(refreshed.search_executed_live, true);
    assert.equal(reused.ok, true);
    assert.equal(reused.match_policy_version, CURRENT_MATCH_POLICY_VERSION);
    assert.equal(reused.search_executed_live, false);
    assert.equal(runs, 1);
    const persisted = JSON.parse(await fs.readFile(sharedCachePath, "utf8"));
    assert.equal(persisted.entries[key].match_policy_version, CURRENT_MATCH_POLICY_VERSION);
    assert.equal(Object.hasOwn(persisted.entries[key], "search_executed_live"), false);
  });
});

test("real SKU 3603926157 v1 soft rejection with an explicit empty identity list refreshes live exactly once", async () => {
  await withTempDir(async (root) => {
    const runDir = path.join(root, "run");
    const sharedCachePath = path.join(root, "shared", "1688_cache.json");
    const currentFixture = signedOutdoorFrostproofFaucetOutput();
    const oldEvidence = JSON.parse(
      currentFixture.output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}",
    );
    for (const row of oldEvidence.rows) {
      row.semantic_hits_v3 = { model: [], high_information: [], feature: [], product: [] };
      row.semantic_strength = "image_backed";
      row.identity_conflicts = [];
    }
    const encodedOldEvidence = JSON.stringify(oldEvidence);
    const oldOutput = currentFixture.output
      .replace(/^SAME_ITEM_EVIDENCE\s+.+$/mu, `SAME_ITEM_EVIDENCE ${encodedOldEvidence}`)
      .replace(
        /^MATCH_EVIDENCE_KEY\s+.+$/mu,
        `MATCH_EVIDENCE_KEY ${crypto.createHash("sha256").update(encodedOldEvidence).digest("hex")}`,
      );
    const item = {
      sku: "3603926157",
      cover_image: "https://img.example/3603926157.jpg",
      sell_price: 32.16,
      expect_title: currentFixture.request.expect_title,
      expect_category: currentFixture.request.expect_category,
    };
    const key = v7CostCacheKey(item);
    const reason = "same-item evidence rejected: returned row has no explicit title/model/category semantic hit";
    assert.equal(oldEvidence.balanced_match.passed, true);
    assert.equal(oldEvidence.balanced_match.match_type, "corroborated_multi");
    assert.ok(oldEvidence.rows.every((row) => (
      Array.isArray(row.identity_conflicts)
      && row.identity_conflicts.length === 0
      && row.semantic_hits_v3.product.length === 0
    )));
    await fs.mkdir(path.dirname(sharedCachePath), { recursive: true });
    await fs.writeFile(sharedCachePath, JSON.stringify({ version: 1, entries: {
      [key]: {
        output: oldOutput,
        terminal: true,
        deferred: false,
        process_code: 0,
        reason,
        match_policy_version: "image-text-soft-v1",
      },
    } }));

    let runs = 0;
    const bridge = createCostBridge({
      sharedCachePath,
      matchPolicy: "balanced",
      cacheFlushDebounceMs: 0,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        runs += 1;
        return { code: 0, stdout: currentFixture.output, stderr: "" };
      },
    });
    const refreshed = await bridge.estimate(item, runDir);
    const reused = await bridge.estimate({ ...item, sku: "3603926157-reused" }, runDir);
    await bridge.close();

    assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
    assert.equal(refreshed.match_policy_version, CURRENT_MATCH_POLICY_VERSION);
    assert.equal(refreshed.search_executed_live, true);
    assert.equal(reused.ok, true);
    assert.equal(reused.match_policy_version, CURRENT_MATCH_POLICY_VERSION);
    assert.equal(reused.search_executed_live, false);
    assert.equal(runs, 1);
    const persisted = JSON.parse(await fs.readFile(sharedCachePath, "utf8"));
    assert.equal(persisted.entries[key].match_policy_version, CURRENT_MATCH_POLICY_VERSION);
  });
});

test("explicit v1 soft refresh still rejects a bad digest, request mismatch, or non-soft reason", async () => {
  await withTempDir(async (root) => {
    const runDir = path.join(root, "run");
    const sharedCachePath = path.join(root, "shared", "1688_cache.json");
    const signedRequest = {
      expect_title: "same product lamp",
      expect_price_cny: 100,
    };
    const validOutput = imageTextSoftOutput({ request: signedRequest, identityConflicts: [] });
    const softReason = "same-item evidence rejected: returned row has no explicit title/model/category semantic hit";
    const cases = [
      {
        sku: "stale-soft-bad-digest",
        expect_title: signedRequest.expect_title,
        output: validOutput.replace(
          /^MATCH_EVIDENCE_KEY\s+.+$/mu,
          `MATCH_EVIDENCE_KEY ${"0".repeat(64)}`,
        ),
        reason: softReason,
      },
      {
        sku: "stale-soft-request-mismatch",
        expect_title: "different product lamp",
        output: validOutput,
        reason: softReason,
      },
      {
        sku: "stale-soft-nonsoft-reason",
        expect_title: signedRequest.expect_title,
        output: validOutput,
        reason: "same-item evidence rejected: explicit hard identity mismatch",
      },
    ].map((fixture) => ({
      ...fixture,
      cover_image: `https://img.example/${fixture.sku}.jpg`,
      sell_price: 100,
    }));
    const entries = Object.fromEntries(cases.map((item) => [v7CostCacheKey(item), {
      output: item.output,
      terminal: true,
      deferred: false,
      process_code: 0,
      reason: item.reason,
      match_policy_version: "image-text-soft-v1",
    }]));
    await fs.mkdir(path.dirname(sharedCachePath), { recursive: true });
    await fs.writeFile(sharedCachePath, JSON.stringify({ version: 1, entries }));

    let runs = 0;
    const bridge = createCostBridge({
      sharedCachePath,
      matchPolicy: "balanced",
      download: async () => { throw new Error("invalid stale evidence must remain cached"); },
      runProcess: async () => { runs += 1; throw new Error("invalid stale evidence must not run"); },
    });
    const results = [];
    for (const item of cases) results.push(await bridge.estimate(item, runDir));
    await bridge.close();

    assert.equal(runs, 0);
    assert.ok(results.every((result) => result.search_executed_live === false));
    assert.ok(results.every((result) => result.match_policy_version === "image-text-soft-v1"));
  });
});

test("a current semantic-miss cache is reused before eligibility and searched live after expiry", async () => {
  await withTempDir(async (root) => {
    const runDir = path.join(root, "run");
    const sharedCachePath = path.join(root, "shared", "1688_cache.json");
    let clock = Date.parse("2026-08-18T06:00:00.000Z");
    const item = {
      sku: "current-semantic-miss-ttl-1",
      cover_image: "https://img.example/current-semantic-miss-ttl.jpg",
      sell_price: 100,
      expect_title: "same product lamp",
    };
    const reason = "no explicit title/model/category semantic same-item matches";
    let runs = 0;
    const common = {
      sharedCachePath,
      cacheFlushDebounceMs: 0,
      semanticMissCacheTtlMs: 1_000,
      now: () => clock,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
    };
    const firstBridge = createCostBridge({
      ...common,
      runProcess: async () => {
        runs += 1;
        return { code: 2, stdout: `REASON ${reason}\nP70_COST None`, stderr: "" };
      },
    });
    const first = await firstBridge.estimate(item, runDir);
    await firstBridge.close();
    assert.equal(first.ok, false);
    assert.equal(first.search_executed_live, true);
    assert.equal(first.match_policy_version, CURRENT_MATCH_POLICY_VERSION);

    clock += 999;
    const cachedBridge = createCostBridge({
      ...common,
      runProcess: async () => { throw new Error("unexpired cache must avoid the worker"); },
    });
    const cached = await cachedBridge.estimate({ ...item, sku: "current-semantic-miss-ttl-2" }, runDir);
    await cachedBridge.close();
    assert.equal(cached.ok, false);
    assert.equal(cached.search_executed_live, false);
    assert.equal(cached.match_policy_version, CURRENT_MATCH_POLICY_VERSION);
    assert.equal(runs, 1);

    clock += 2;
    const recoveryBridge = createCostBridge({
      ...common,
      runProcess: async ({ args }) => {
        runs += 1;
        return {
          code: 0,
          stdout: returnedSameItemOutput({ request: cliMatchRequest(args) }),
          stderr: "",
        };
      },
    });
    const recovered = await recoveryBridge.estimate({ ...item, sku: "current-semantic-miss-ttl-3" }, runDir);
    await recoveryBridge.close();
    assert.equal(recovered.ok, true);
    assert.equal(recovered.search_executed_live, true);
    assert.equal(recovered.match_policy_version, CURRENT_MATCH_POLICY_VERSION);
    assert.equal(runs, 2);
  });
});

test("a legacy v7 image/text-soft rejection is searched live once and gains signed identity evidence", async () => {
  await withTempDir(async (root) => {
    const runDir = path.join(root, "run");
    const sharedCachePath = path.join(root, "shared", "1688_cache.json");
    const item = {
      sku: "legacy-soft-success-1",
      cover_image: "https://img.example/legacy-soft-success.jpg",
      sell_price: 100,
      expect_title: "Apple charging cable X100 black Type-C 1 pcs",
      expect_model: "X100",
    };
    const request = {
      expect_title: item.expect_title,
      expect_model: item.expect_model,
      expect_price_cny: item.sell_price,
    };
    const key = v7CostCacheKey(item);
    const legacyOutput = imageTextSoftOutput({ request, includeIdentityConflicts: false });
    const legacyEvidence = JSON.parse(legacyOutput.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}");
    assert.equal(Object.hasOwn(legacyEvidence.rows[0], "identity_conflicts"), false);
    await fs.mkdir(path.dirname(sharedCachePath), { recursive: true });
    await fs.writeFile(sharedCachePath, JSON.stringify({ version: 1, entries: {
      [key]: {
        output: legacyOutput,
        terminal: true,
        deferred: false,
        process_code: 0,
        reason: "same-item evidence rejected: returned row has no explicit title/model/category semantic hit",
      },
    } }));

    let runs = 0;
    const bridge = createCostBridge({
      sharedCachePath,
      matchPolicy: "balanced",
      cacheFlushDebounceMs: 0,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async ({ args }) => {
        runs += 1;
        return {
          code: 0,
          stdout: imageTextSoftOutput({ request: cliMatchRequest(args), identityConflicts: [] }),
          stderr: "",
        };
      },
    });
    const refreshed = await bridge.estimate(item, runDir);
    const reused = await bridge.estimate({ ...item, sku: "legacy-soft-success-2" }, runDir);
    await bridge.close();

    assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
    assert.equal(refreshed.balanced_match_origin, "signed-image-primary-strong-single-v1");
    assert.deepEqual(refreshed.balanced_supporting_offer_evidence[0].identity_conflicts, []);
    assert.equal(reused.ok, true);
    assert.equal(reused.shared_cache, true);
    assert.equal(runs, 1, "the old key is allowed exactly one live policy refresh");
    const persisted = JSON.parse(await fs.readFile(sharedCachePath, "utf8"));
    assert.equal(persisted.entries[key].match_policy_version, CURRENT_MATCH_POLICY_VERSION);
    const refreshedEvidence = JSON.parse(
      persisted.entries[key].output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}",
    );
    assert.deepEqual(refreshedEvidence.rows[0].identity_conflicts, []);
  });
});

test("concurrent callers coalesce one legacy refresh and reuse its fresh terminal rejection", async () => {
  await withTempDir(async (root) => {
    const runDir = path.join(root, "run");
    const sharedCachePath = path.join(root, "shared", "1688_cache.json");
    const item = {
      sku: "legacy-soft-reject-1",
      cover_image: "https://img.example/legacy-soft-reject.jpg",
      sell_price: 100,
      expect_title: "Apple charging cable X100 black Type-C 1 pcs",
      expect_model: "X100",
    };
    const request = {
      expect_title: item.expect_title,
      expect_model: item.expect_model,
      expect_price_cny: item.sell_price,
    };
    const key = v7CostCacheKey(item);
    await fs.mkdir(path.dirname(sharedCachePath), { recursive: true });
    await fs.writeFile(sharedCachePath, JSON.stringify({ version: 1, entries: {
      [key]: {
        output: imageTextSoftOutput({ request, includeIdentityConflicts: false }),
        terminal: true,
        deferred: false,
        process_code: 0,
        reason: "same-item evidence rejected: returned row has no explicit title/model/category semantic hit",
      },
    } }));

    let runs = 0;
    let releaseSearch;
    let markSearchStarted;
    const searchGate = new Promise((resolve) => { releaseSearch = resolve; });
    const searchStarted = new Promise((resolve) => { markSearchStarted = resolve; });
    const bridge = createCostBridge({
      sharedCachePath,
      matchPolicy: "balanced",
      cacheFlushDebounceMs: 0,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async ({ args }) => {
        runs += 1;
        markSearchStarted();
        await searchGate;
        return {
          code: 0,
          stdout: imageTextSoftOutput({
            request: cliMatchRequest(args),
            identityConflicts: [],
            image: { available: true, score: 0.899, color_score: 0.90, dhash_score: 0.82 },
          }),
          stderr: "",
        };
      },
    });
    const firstPromise = bridge.estimate(item, runDir);
    await searchStarted;
    const concurrentPromise = bridge.estimate({ ...item, sku: "legacy-soft-reject-2" }, runDir);
    releaseSearch();
    const [first, concurrent] = await Promise.all([firstPromise, concurrentPromise]);
    const reused = await bridge.estimate({ ...item, sku: "legacy-soft-reject-3" }, runDir);
    await bridge.close();

    assert.equal(first.ok, false);
    assert.equal(concurrent.ok, false);
    assert.equal(concurrent.shared_cache, true);
    assert.equal(reused.ok, false);
    assert.equal(reused.shared_cache, true);
    assert.equal(runs, 1, "concurrent and later calls must reuse the fresh rejection");
    const persisted = JSON.parse(await fs.readFile(sharedCachePath, "utf8"));
    assert.equal(persisted.entries[key].match_policy_version, CURRENT_MATCH_POLICY_VERSION);
  });
});

test("a failed legacy refresh keeps the signed rejection, backs off, and retries after its bounded TTL", async () => {
  await withTempDir(async (root) => {
    const runDir = path.join(root, "run");
    const sharedCachePath = path.join(root, "shared", "1688_cache.json");
    let clock = Date.parse("2026-08-18T04:00:00.000Z");
    const item = {
      sku: "legacy-soft-exception-1",
      cover_image: "https://img.example/legacy-soft-exception.jpg",
      sell_price: 100,
      expect_title: "Apple charging cable X100 black Type-C 1 pcs",
      expect_model: "X100",
    };
    const request = {
      expect_title: item.expect_title,
      expect_model: item.expect_model,
      expect_price_cny: item.sell_price,
    };
    const key = v7CostCacheKey(item);
    const legacyOutput = imageTextSoftOutput({ request, includeIdentityConflicts: false });
    await fs.mkdir(path.dirname(sharedCachePath), { recursive: true });
    await fs.writeFile(sharedCachePath, JSON.stringify({ version: 1, entries: {
      [key]: {
        output: legacyOutput,
        terminal: true,
        deferred: false,
        process_code: 0,
        reason: "same-item evidence rejected: returned row has no explicit title/model/category semantic hit",
      },
    } }));

    let downloads = 0;
    let runs = 0;
    const bridgeOptions = {
      sharedCachePath,
      matchPolicy: "balanced",
      matchPolicyRefreshBackoffMs: 1_000,
      cacheFlushDebounceMs: 0,
      now: () => clock,
    };
    const failingBridge = createCostBridge({
      ...bridgeOptions,
      download: async (_url, destinationPath) => {
        downloads += 1;
        throw Object.assign(new Error("image host unavailable"), { code: "image-offline" });
      },
      runProcess: async () => { throw new Error("download failure must precede the worker"); },
    });
    const failed = await failingBridge.estimate(item, runDir);
    await failingBridge.close();

    assert.equal(failed.ok, false);
    assert.equal(failed.error?.code, "image-offline");
    assert.equal(downloads, 1);
    assert.equal(runs, 0);
    let persisted = JSON.parse(await fs.readFile(sharedCachePath, "utf8"));
    assert.equal(persisted.entries[key].match_policy_refresh_failure_code, "image-offline");
    assert.equal(persisted.entries[key].match_policy_refresh_retry_at, "2026-08-18T04:00:01.000Z");
    assert.equal(Object.hasOwn(persisted.entries[key], "match_policy_version"), false);
    assert.equal(persisted.entries[key].output, compactCostOutput(legacyOutput));
    const retainedEvidence = JSON.parse(
      persisted.entries[key].output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}",
    );
    assert.equal(Object.hasOwn(retainedEvidence.rows[0], "identity_conflicts"), false);

    const backedOffBridge = createCostBridge({
      ...bridgeOptions,
      download: async () => { throw new Error("persisted backoff must avoid downloads"); },
      runProcess: async () => { throw new Error("persisted backoff must avoid the worker"); },
    });
    const backedOff = await backedOffBridge.estimate({ ...item, sku: "legacy-soft-exception-2" }, runDir);
    await backedOffBridge.close();
    assert.equal(backedOff.ok, false);
    assert.equal(backedOff.shared_cache, true);
    assert.equal(downloads, 1);
    assert.equal(runs, 0);

    clock += 1_001;
    const recoveryBridge = createCostBridge({
      ...bridgeOptions,
      download: async (_url, destinationPath) => {
        downloads += 1;
        await fs.writeFile(destinationPath, "image");
      },
      runProcess: async ({ args }) => {
        runs += 1;
        return {
          code: 0,
          stdout: imageTextSoftOutput({ request: cliMatchRequest(args), identityConflicts: [] }),
          stderr: "",
        };
      },
    });
    const recovered = await recoveryBridge.estimate({ ...item, sku: "legacy-soft-exception-3" }, runDir);
    await recoveryBridge.close();
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(downloads, 2);
    assert.equal(runs, 1);
    persisted = JSON.parse(await fs.readFile(sharedCachePath, "utf8"));
    assert.equal(persisted.entries[key].match_policy_version, CURRENT_MATCH_POLICY_VERSION);
  });
});

test("a timed-out legacy refresh is coalesced and its short-term backoff prevents another live request", async () => {
  await withTempDir(async (root) => {
    const runDir = path.join(root, "run");
    const sharedCachePath = path.join(root, "shared", "1688_cache.json");
    const clock = Date.parse("2026-08-18T05:00:00.000Z");
    const item = {
      sku: "legacy-soft-timeout-1",
      cover_image: "https://img.example/legacy-soft-timeout.jpg",
      sell_price: 100,
      expect_title: "Apple charging cable X100 black Type-C 1 pcs",
      expect_model: "X100",
    };
    const request = {
      expect_title: item.expect_title,
      expect_model: item.expect_model,
      expect_price_cny: item.sell_price,
    };
    const key = v7CostCacheKey(item);
    const legacyOutput = imageTextSoftOutput({ request, includeIdentityConflicts: false });
    await fs.mkdir(path.dirname(sharedCachePath), { recursive: true });
    await fs.writeFile(sharedCachePath, JSON.stringify({ version: 1, entries: {
      [key]: {
        output: legacyOutput,
        terminal: true,
        deferred: false,
        process_code: 0,
        reason: "same-item evidence rejected: returned row has no explicit title/model/category semantic hit",
      },
    } }));

    let runs = 0;
    let markSearchStarted;
    const searchStarted = new Promise((resolve) => { markSearchStarted = resolve; });
    const bridge = createCostBridge({
      sharedCachePath,
      matchPolicy: "balanced",
      matchPolicyRefreshBackoffMs: 1_000,
      totalBudgetMs: 40,
      shutdownDrainTimeoutMs: 30,
      cacheFlushDebounceMs: 0,
      now: () => clock,
      download: async (_url, destinationPath) => fs.writeFile(destinationPath, "image"),
      runProcess: async () => {
        runs += 1;
        markSearchStarted();
        return new Promise(() => {});
      },
    });
    const firstPromise = bridge.estimate(item, runDir);
    await searchStarted;
    const concurrentPromise = bridge.estimate({ ...item, sku: "legacy-soft-timeout-2" }, runDir);
    const [first, concurrent] = await Promise.all([firstPromise, concurrentPromise]);
    const backedOff = await bridge.estimate({ ...item, sku: "legacy-soft-timeout-3" }, runDir);
    await assert.rejects(
      bridge.close(),
      (error) => error?.code === "FLOW_B_1688_SHUTDOWN_DRAIN_TIMEOUT",
    );

    assert.equal(first.error?.code, "1688-total-timeout");
    assert.equal(concurrent.error?.code, "1688-total-timeout");
    assert.equal(concurrent.shared_cache, true);
    assert.equal(backedOff.ok, false);
    assert.equal(backedOff.shared_cache, true);
    assert.equal(runs, 1);
    const persisted = JSON.parse(await fs.readFile(sharedCachePath, "utf8"));
    assert.equal(persisted.entries[key].match_policy_refresh_failure_code, "1688-total-timeout");
    assert.equal(persisted.entries[key].match_policy_refresh_retry_at, "2026-08-18T05:00:01.000Z");
    assert.equal(Object.hasOwn(persisted.entries[key], "match_policy_version"), false);
    const retainedEvidence = JSON.parse(
      persisted.entries[key].output.match(/^SAME_ITEM_EVIDENCE\s+(.+)$/mu)?.[1] || "{}",
    );
    assert.equal(Object.hasOwn(retainedEvidence.rows[0], "identity_conflicts"), false);
  });
});

test("legacy hard conflicts, price-ratio rejects, and successful cache entries are never policy-refreshed", async () => {
  await withTempDir(async (root) => {
    const runDir = path.join(root, "run");
    const sharedCachePath = path.join(root, "shared", "1688_cache.json");
    const base = {
      sell_price: 100,
      expect_title: "Apple charging cable X100 black Type-C 1 pcs",
      expect_model: "X100",
    };
    const entries = {};
    const cases = [
      {
        name: "spec",
        output: imageTextSoftOutput({
          request: { expect_title: base.expect_title, expect_model: base.expect_model, expect_price_cny: 100 },
          includeIdentityConflicts: false,
          specConflicts: ["power"],
        }),
        reason: "same-item evidence rejected: returned row has no explicit title/model/category semantic hit",
      },
      {
        name: "brand",
        output: imageTextSoftOutput({
          request: { expect_title: base.expect_title, expect_model: base.expect_model, expect_price_cny: 100 },
          includeIdentityConflicts: false,
          candidateTitle: "Samsung 通用配件",
        }),
        reason: "same-item evidence rejected: returned row has no explicit title/model/category semantic hit",
      },
      {
        name: "model",
        output: imageTextSoftOutput({
          request: { expect_title: base.expect_title, expect_model: base.expect_model, expect_price_cny: 100 },
          includeIdentityConflicts: false,
          candidateTitle: "通用配件 Y200",
        }),
        reason: "same-item evidence rejected: returned row has no explicit title/model/category semantic hit",
      },
      {
        name: "accessory",
        output: imageTextSoftOutput({
          request: { expect_title: base.expect_title, expect_model: base.expect_model, expect_price_cny: 100 },
          includeIdentityConflicts: false,
          accessoryConflict: true,
        }),
        reason: "same-item evidence rejected: returned row has no explicit title/model/category semantic hit",
      },
      {
        name: "price-ratio",
        output: imageTextSoftOutput({
          request: { expect_title: base.expect_title, expect_model: base.expect_model, expect_price_cny: 100 },
          includeIdentityConflicts: false,
          selectedCost: 1,
        }),
        reason: "1688 cost below 2% of sale price is not reliable",
      },
      {
        name: "success",
        output: returnedSameItemOutput({
          request: { expect_title: base.expect_title, expect_model: base.expect_model, expect_price_cny: 100 },
          prices: [10],
          selectedCost: 10,
          offerIds: ["4201"],
        }),
        reason: null,
      },
    ];
    const items = cases.map((fixture) => ({
      ...base,
      sku: `legacy-hard-${fixture.name}`,
      cover_image: `https://img.example/legacy-hard-${fixture.name}.jpg`,
    }));
    for (const [index, item] of items.entries()) {
      entries[v7CostCacheKey(item)] = {
        output: cases[index].output,
        terminal: true,
        deferred: false,
        process_code: 0,
        match_policy_version: "image-text-soft-v1",
        ...(cases[index].reason ? { reason: cases[index].reason } : {}),
      };
    }
    await fs.mkdir(path.dirname(sharedCachePath), { recursive: true });
    await fs.writeFile(sharedCachePath, JSON.stringify({ version: 1, entries }));

    let runs = 0;
    const bridge = createCostBridge({
      sharedCachePath,
      matchPolicy: "balanced",
      download: async () => { throw new Error("cache reuse must avoid downloads"); },
      runProcess: async () => { runs += 1; throw new Error("hard and successful cache entries must be reused"); },
    });
    const results = [];
    for (const item of items) results.push(await bridge.estimate(item, runDir));
    await bridge.close();

    assert.deepEqual(results.map((row) => row.ok), [false, false, false, false, false, true]);
    assert.ok(results.every((row) => row.shared_cache === true));
    assert.equal(runs, 0);
    const persisted = JSON.parse(await fs.readFile(sharedCachePath, "utf8"));
    assert.ok(Object.values(persisted.entries).every((entry) => (
      entry.match_policy_version === "image-text-soft-v1"
    )));
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
