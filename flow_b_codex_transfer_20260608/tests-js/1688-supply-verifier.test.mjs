import assert from "node:assert/strict";
import test from "node:test";

import {
  IMAGE_PRIMARY_MATCH_BASIS,
  QUANTITY_INPUT_SELECTORS,
  SUPPLY_EVIDENCE_CONTRACT,
  assessImagePrimaryCandidate,
  canonicalAlibabaImageAssetUrl,
  classify1688SupplySnapshot,
  create1688SupplyVerifier,
  isFreshSupplyEvidence,
  normalizeSupplySpecValue,
  normalizeTargetVariant,
  selectExactSpecOption,
} from "../scripts/flow_b_playwright/1688-supply-verifier.mjs";

const MATCH_KEY = "a".repeat(64);

function candidate(id, matchType = "strong_single") {
  return {
    offer_id: String(id),
    offer_url: `https://detail.1688.com/offer/${id}.html`,
    match_type: matchType,
    match_evidence_key: MATCH_KEY,
  };
}

function imageCandidate(id, {
  matchType = "strong_single",
  title = "X100 黑色四头 GU10 射灯",
  score = 0.78,
  colorScore = 0.96,
  dhashScore = 0.70,
  semanticStrength = "exact_model",
  specConflicts = [],
  accessoryConflict = false,
  identityConflicts,
  evidenceOfferId = String(id),
  corroboratingOfferIds = [],
} = {}) {
  return {
    ...candidate(id, matchType),
    image_match_evidence: {
      source_contract: "1688-returned-same-item-v3",
      offer_id: evidenceOfferId,
      title,
      image_url: `https://cbu01.alicdn.com/img/ibank/${id}.jpg`,
      image: {
        available: true,
        score,
        color_score: colorScore,
        dhash_score: dhashScore,
      },
      semantic_strength: semanticStrength,
      spec_conflicts: specConflicts,
      ...(identityConflicts === undefined ? {} : { identity_conflicts: identityConflicts }),
      accessory_conflict: accessoryConflict,
      corroborating_offer_ids: corroboratingOfferIds,
    },
  };
}

function orderableSnapshot({
  url = "https://detail.1688.com/offer/1.html",
  body = "现货 起批量 1件 ￥25.80",
  structured = {
    model: "X100",
    minOrderQuantity: 1,
    variants: [{ skuId: "sku-1", color: "黑色", size: "M", stock: 12, orderable: true, price: 25.8 }],
  },
  buttons = [{ text: "立即订购", disabled: false }],
  priceTexts = ["￥25.80"],
  specOptions = [
    { group: "颜色", value: "黑色", disabled: false, selected: true },
    { group: "尺寸", value: "M", disabled: false, selected: true },
  ],
  quantityInputs = [{
    value: "1",
    min: "1",
    disabled: false,
    variant_attributes: { model: "X100", color: "黑色", size: "M" },
  }],
  interaction = {
    specs: {
      color: { found: true, group_found: true, selected: true },
      size: { found: true, group_found: true, selected: true },
    },
    quantity: {
      found: true,
      set: true,
      value: 1,
      selection_method: "image_primary_best_target_overlap",
    },
  },
  httpStatus = 200,
} = {}) {
  return {
    url,
    title: "1688 商品详情",
    body,
    http_status: httpStatus,
    structured_data: [structured],
    dom_snapshot: {
      buttons,
      spec_options: specOptions,
      quantity_inputs: quantityInputs,
      price_texts: priceTexts,
    },
    interaction,
  };
}

function fakePage(snapshotOrFactory, { gotoError = null, status = 200 } = {}) {
  return {
    async goto(url) {
      if (gotoError) throw gotoError;
      this.currentUrl = url;
      return { status: () => status };
    },
    async evaluate(_callback, argument) {
      const snapshot = typeof snapshotOrFactory === "function"
        ? snapshotOrFactory(this.currentUrl)
        : snapshotOrFactory;
      if (argument?.operation === "select-spec") {
        const aliases = new Map([
          ["颜色", "color"], ["颜色分类", "color"], ["尺寸", "size"], ["尺码", "size"],
          ["型号", "model"], ["容量", "capacity"], ["电压", "voltage_v"], ["电流", "current_a"], ["功率", "power_w"], ["色温", "cct_k"], ["套装数量", "set_quantity"], ["灯头数", "head_count"], ["头数", "head_count"], ["形状", "shape"], ["外形", "shape"], ["接口", "interface"],
        ]);
        const rows = snapshot?.dom_snapshot?.spec_options || [];
        const grouped = rows.filter((row) => aliases.get(row.group) === argument.specName);
        const exact = grouped.find((row) => normalizeSupplySpecValue(row.value, argument.specName) === argument.expectedValue);
        return {
          found: Boolean(exact),
          group_found: grouped.length > 0,
          disabled: exact?.disabled === true,
          selected: exact?.selected === true,
          clicked: Boolean(exact && exact.selected !== true),
        };
      }
      if (argument?.operation === "set-quantity") {
        const rows = snapshot?.dom_snapshot?.quantity_inputs || [];
        if (!rows.length) return { found: false, set: false, value: null };
        const target = argument.targetVariant || {};
        const targetEntries = Object.entries(target);
        const explicitCapacityValues = (value) => {
          const normalized = normalizeSupplySpecValue(value);
          return new Set(normalized.match(/(?<![a-zа-яё0-9.])\d+(?:\.\d+)?(?:ml|l|gb|tb)(?![a-zа-яё0-9])/giu) || []);
        };
        const explicitMillimetreValues = (value) => {
          const normalized = normalizeSupplySpecValue(value);
          return new Set(normalized.match(/(?<![a-zа-яё0-9.])\d+(?:\.\d+)?mm(?![a-zа-яё0-9])/giu) || []);
        };
        const explicitElectricalValues = (value, name) => {
          const normalized = normalizeSupplySpecValue(value);
          const suffix = name === "voltage_v" ? "v" : name === "current_a" ? "a" : name === "power_w" ? "w" : null;
          if (!suffix) return new Set();
          return new Set(normalized.match(new RegExp(`(?:(?<![a-zа-яё0-9.])|(?<=[vaw]))\\d+(?:\\.\\d+)?${suffix}(?![a-zа-яё])`, "giu")) || []);
        };
        const explicitCctValues = (value) => {
          const normalized = normalizeSupplySpecValue(value);
          return new Set(normalized.match(/(?:(?<![a-zа-яё0-9.])|(?<=[vaw]))\d{4}k(?![a-zа-яё0-9])/giu) || []);
        };
        const isLightColourOnly = (value) => {
          const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
          if (!source.trim()) return false;
          return source
            .replace(/(?:(?<![a-zа-яё0-9.])|(?<=[vaw]))\d{4}k(?![a-zа-яё0-9])/giu, " ")
            .replace(/(?:^|[^\p{L}\p{N}])(?:warm|daylight|day[ -]?light|natural|neutral|cool|cold)\s+white(?:\s+(?:light|lighting))?(?=$|[^\p{L}\p{N}])/giu, " ")
            .replace(/(?:^|[^\p{L}\p{N}])(?:т[её]пл|дневн|нейтральн|естественн|холодн)\p{L}*\s+бел\p{L}*(?:\s+свет\p{L}*)?(?=$|[^\p{L}\p{N}])/giu, " ")
            .replace(/(?:暖白|日光白|自然白|中性白|冷白)(?:色)?(?:灯?光)?/gu, " ")
            .replace(/[\s+|,;:/_-]+/gu, "")
            .trim().length === 0;
        };
        const normalizedRowAttributes = (row) => {
          const result = Object.fromEntries(Object.entries(row?.variant_attributes || {})
            .map(([name, value]) => [name, normalizeSupplySpecValue(value, name)]));
          const rawSize = result.size;
          if (Object.hasOwn(target, "capacity") && rawSize) {
            const capacities = explicitCapacityValues(rawSize);
            delete result.size;
            if (capacities.size === 1) result.capacity = [...capacities][0];
            else if (capacities.size > 1) result.capacity = "__ambiguous__";
          }
          if (Object.hasOwn(target, "size")
            && explicitMillimetreValues(target.size).size === 1
            && rawSize) {
            const millimetres = explicitMillimetreValues(rawSize);
            if (millimetres.size === 1) result.size = [...millimetres][0];
            else if (millimetres.size > 1) result.size = "__ambiguous__";
            else delete result.size;
          }
          for (const name of ["voltage_v", "current_a", "power_w"]) {
            if (!Object.hasOwn(target, name) || !rawSize) continue;
            const values = explicitElectricalValues(rawSize, name);
            delete result.size;
            if (values.size === 1) result[name] = [...values][0];
            else if (values.size > 1) result[name] = "__ambiguous__";
          }
          if (Object.hasOwn(target, "cct_k")) {
            const rawColor = result.color;
            const values = explicitCctValues(`${rawSize || ""} ${rawColor || ""} ${row?.context_text || ""}`);
            if (rawSize && explicitCctValues(rawSize).size) delete result.size;
            if (!Object.hasOwn(target, "color")
              && (explicitCctValues(rawColor).size || isLightColourOnly(rawColor))) delete result.color;
            if (values.size === 1) result.cct_k = [...values][0];
            else if (values.size > 1) result.cct_k = "__ambiguous__";
          }
          if (new Set(["mini-hdmi", "micro-hdmi"]).has(target.interface) && rawSize) {
            const subtype = normalizeSupplySpecValue(rawSize, "interface");
            delete result.size;
            if (new Set(["mini-hdmi", "micro-hdmi", "__ambiguous__"]).has(subtype)) {
              result.interface = subtype;
            }
          }
          if (!result.head_count) {
            const counts = [...String(row?.context_text || "").matchAll(/(?:^|[^\p{L}\p{N}])(\d{1,2})\s*(?:头|燈頭|灯头|head(?:s)?|плафон(?:а|ов)?)(?=$|[^\p{L}\p{N}])/giu)]
              .map((match) => String(Number(match[1])));
            if (new Set(counts).size === 1) result.head_count = counts[0];
          }
          if (!result.shape) {
            const source = String(row?.context_text || "");
            const shapes = new Set();
            if (/方形|方型|正方形|(?:^|[^\p{L}\p{N}])(?:square|квадратн(?:ый|ая|ое|ые))(?=$|[^\p{L}\p{N}])/iu.test(source)) shapes.add("square");
            if (/圆形|圆型|圆款|(?:^|[^\p{L}\p{N}])(?:round|кругл(?:ый|ая|ое|ые))(?=$|[^\p{L}\p{N}])/iu.test(source)) shapes.add("round");
            if (shapes.size === 1) result.shape = [...shapes][0];
          }
          return result;
        };
        const allAttributes = rows.map(normalizedRowAttributes);
        if (argument.allowImagePrimary === true) {
          const candidateImageAsset = canonicalAlibabaImageAssetUrl(argument.candidateImageUrl);
          const exactThumbnailRows = rows.map((row, index) => ({ row, index }))
            .filter(({ row }) => Array.isArray(row?.sku_image_urls)
              && row.sku_image_urls.some((url) => (
                canonicalAlibabaImageAssetUrl(url) === candidateImageAsset
              )));
          const observedKeys = new Set(allAttributes.flatMap((attributes) => Object.keys(attributes)));
          const uncovered = [...observedKeys].filter((name) => {
            const values = new Set(allAttributes.map((attributes) => attributes[name] || "__missing__"));
            return values.size > 1 && !Object.hasOwn(target, name);
          });
          const audits = rows.map((row, index) => ({
            row,
            index,
            attributes: allAttributes[index],
            score: targetEntries.reduce((total, [name, expected]) => {
              if (allAttributes[index][name] === expected) return total + 3;
              const selected = argument.specSelections?.[name];
              return selected?.found === true && selected?.selected === true && selected?.disabled !== true
                ? total + 1
                : total;
            }, 0),
          })).filter(({ attributes }) => targetEntries.every(([name, expected]) => (
            !attributes[name] || attributes[name] === expected
          ))).sort((left, right) => right.score - left.score || left.index - right.index);
          const exactThumbnailChoice = exactThumbnailRows.length === 1
            ? audits.find(({ index }) => index === exactThumbnailRows[0].index)
            : null;
          if (exactThumbnailRows.length === 1 && !exactThumbnailChoice) {
            const conflictingIndex = exactThumbnailRows[0].index;
            const conflicting = rows[conflictingIndex];
            return {
              found: true,
              set: false,
              value: Number(conflicting.value),
              reason_code: "spec_mismatch",
              matched_rows: 0,
              row_key: conflicting.row_key || `index:${conflictingIndex}`,
              row_index: conflictingIndex,
              row_text: conflicting.context_text || "",
              variant_attributes: allAttributes[conflictingIndex],
              thumbnail_match_count: 1,
            };
          }
          if (uncovered.length && !exactThumbnailChoice) {
            return {
              found: true,
              set: false,
              value: null,
              reason_code: "variant_unbound",
              matched_rows: 0,
              uncovered_variant_dimensions: uncovered,
              thumbnail_match_count: exactThumbnailRows.length,
            };
          }
          const chosen = exactThumbnailChoice || audits[0];
          const bestScoreCount = chosen ? audits.filter((row) => row.score === chosen.score).length : 0;
          if (!chosen || (!exactThumbnailChoice && bestScoreCount !== 1)) {
            return {
              found: true,
              set: false,
              value: null,
              reason_code: "variant_unbound",
              matched_rows: bestScoreCount || audits.length,
            };
          }
          const input = chosen.row;
          if (Number(input.min) > 1 || (input.max !== null && input.max !== undefined && Number(input.max) < 1)) {
            return {
              found: true,
              set: false,
              value: Number(input.value),
              min: Number(input.min),
              row_key: input.row_key || `index:${chosen.index}`,
              row_index: chosen.index,
              variant_attributes: chosen.attributes,
            };
          }
          input.value = "1";
          input.row_key ||= `index:${chosen.index}`;
          input.row_index ??= chosen.index;
          return {
            found: true,
            set: true,
            value: 1,
            min: Number(input.min) || null,
            row_key: input.row_key,
            row_index: chosen.index,
            matched_rows: 1,
            sku_ids: input.sku_ids || [],
            row_text: input.context_text || "",
            observed_variant_attributes: chosen.attributes,
            variant_attributes: Object.fromEntries(targetEntries.filter(([name, expected]) => (
              chosen.attributes[name] === expected
            ))),
            selection_method: exactThumbnailChoice
              ? "image_primary_exact_thumbnail_url"
              : "image_primary_best_target_overlap",
            soft_tie: false,
            ...(exactThumbnailChoice ? {
              selected_sku_image_url: candidateImageAsset,
              thumbnail_match_count: exactThumbnailRows.length,
            } : {}),
          };
        }
        const observedKeys = new Set(allAttributes.flatMap((attributes) => Object.keys(attributes)));
        const uncovered = [...observedKeys].filter((name) => {
          const values = new Set(allAttributes.map((attributes) => attributes[name] || "__missing__"));
          return values.size > 1 && !Object.hasOwn(target, name);
        });
        if (uncovered.length) {
          return {
            found: true,
            set: false,
            value: null,
            reason_code: "variant_unbound",
            matched_rows: 0,
            uncovered_variant_dimensions: uncovered,
          };
        }
        const matches = targetEntries.length
          ? rows.map((row, index) => ({ row, index, attributes: normalizedRowAttributes(row) }))
            .filter(({ attributes }) => targetEntries.every(([name, expected]) => {
              if (attributes[name]) return attributes[name] === expected;
              const selected = argument.specSelections?.[name];
              if (selected?.found === true && selected?.selected === true && selected?.disabled !== true) return true;
              return false;
            }))
          : rows.length === 1 ? [{ row: rows[0], index: 0, attributes: normalizedRowAttributes(rows[0]) }] : [];
        if (matches.length !== 1) {
          return {
            found: true,
            set: false,
            value: null,
            reason_code: "variant_unbound",
            matched_rows: targetEntries.length ? matches.length : rows.length,
          };
        }
        const { row: input, index, attributes } = matches[0];
        if (Number(input.min) > 1 || (input.max !== null && input.max !== undefined && Number(input.max) < 1)) {
          return {
            found: true,
            set: false,
            value: Number(input.value),
            min: Number(input.min),
            row_key: input.row_key || `index:${index}`,
            row_index: index,
            variant_attributes: attributes,
          };
        }
        input.value = "1";
        input.row_key ||= `index:${index}`;
        input.row_index ??= index;
        return {
          found: true,
          set: true,
          value: 1,
          min: Number(input.min) || null,
          row_key: input.row_key,
          row_index: index,
          matched_rows: 1,
          variant_attributes: Object.fromEntries(targetEntries.flatMap(([name, expected]) => {
            if (attributes[name] === expected) return [[name, attributes[name]]];
            const selected = argument.specSelections?.[name];
            return selected?.found === true && selected?.selected === true && selected?.disabled !== true
              ? [[name, expected]]
              : [];
          })),
        };
      }
      return snapshot;
    },
    async waitForTimeout() {},
  };
}

function verifierInput(candidates, overrides = {}) {
  return {
    candidates,
    targetVariant: {
      required: true,
      attributes: { model: "X100", color: "黑色", size: "M" },
    },
    itemLevelMatch: false,
    matchEvidenceKey: MATCH_KEY,
    balancedMatch: {
      passed: true,
      match_type: candidates[0]?.match_type || "strong_single",
      supporting_offer_ids: candidates.map((row) => row.offer_id),
    },
    ...overrides,
  };
}

test("normalizes target identity, physical, electrical and interface dimensions", () => {
  assert.deepEqual(normalizeTargetVariant({
    required: true,
    attributes: {
      model_name: " X100 ",
      colour: "黑色",
      size: " 10 × 20 CM ",
      volume: "500 мл",
      voltage: "24 В",
      current: "1,5 A",
      power: "150 Вт",
      color_temperature: "3000 К",
      pack_count: "2件套",
      head_count: "4灯头",
      form: "квадратный",
      connector: " USB Type C ",
      wireless_protocol: "Zigbee 3.0",
    },
  }), {
    model: "x100",
    color: "black",
    size: "10x20cm",
    capacity: "500ml",
    voltage_v: "24v",
    current_a: "1.5a",
    power_w: "150w",
    cct_k: "3000k",
    set_quantity: "2",
    head_count: "4",
    shape: "square",
    interface: "type-c",
    wireless_protocol: "zigbee",
  });
});

test("normalizes only one explicit wireless transport", () => {
  assert.equal(normalizeSupplySpecValue("Wi-Fi", "wireless_protocol"), "wifi");
  assert.equal(normalizeSupplySpecValue("Zigbee 3.0", "wireless_protocol"), "zigbee");
  assert.equal(normalizeSupplySpecValue("Zigbee / Wi-Fi", "wireless_protocol"), "__ambiguous__");
});

test("normalizes only one explicit Kelvin value and does not turn light color into casing white", () => {
  assert.equal(normalizeSupplySpecValue("3000 K", "cct_k"), "3000k");
  assert.equal(normalizeSupplySpecValue("4500К", "cct_k"), "4500k");
  assert.equal(normalizeSupplySpecValue("7W3000K", "cct_k"), "3000k");
  assert.equal(normalizeSupplySpecValue("3000K暖白", "cct_k"), "3000k");
  assert.equal(normalizeSupplySpecValue("3000K/4500K", "cct_k"), "3000k/4500k");
  assert.equal(normalizeSupplySpecValue("теплый белый свет", "color"), "теплый белый свет");
  assert.equal(normalizeSupplySpecValue("daylight white light", "color"), "daylight white light");
  assert.equal(normalizeSupplySpecValue("black housing + warm white light", "color"), "black");
});

test("a compound colour-temperature option normalizes to its one explicit Kelvin value", async () => {
  const page = fakePage(orderableSnapshot({
    specOptions: [{ group: "色温", value: "3000K暖白", disabled: false, selected: true }],
  }));
  const result = await selectExactSpecOption(page, "cct_k", "3000k");
  assert.equal(result.found, true);
  assert.equal(result.selected, true);
});

test("normalizes only explicit mini-HDMI and micro-HDMI subtypes", () => {
  assert.equal(normalizeSupplySpecValue("mini HDMI", "interface"), "mini-hdmi");
  assert.equal(normalizeSupplySpecValue("HDMI-micro", "interface"), "micro-hdmi");
  assert.equal(normalizeSupplySpecValue("C型mini HDMI(M)", "interface"), "mini-hdmi");
  assert.equal(normalizeSupplySpecValue("D型micro HDMI(M)", "interface"), "micro-hdmi");
  assert.equal(normalizeSupplySpecValue("mini HDMI / micro HDMI", "interface"), "__ambiguous__");
  assert.equal(normalizeSupplySpecValue("HDMI", "interface"), "hdmi");
  assert.equal(normalizeSupplySpecValue("Type C", "interface"), "type-c");
});

test("normalizes Chinese, English and Russian gold color aliases without accepting a compound color", () => {
  for (const value of ["金色", "gold", "Golden", "золотой", "золотистый"]) {
    assert.equal(normalizeSupplySpecValue(value, "color"), "gold", value);
  }
  for (const value of ["玫瑰金", "rose gold", "Rose-Gold", "розовое золото"]) {
    assert.equal(normalizeSupplySpecValue(value, "color"), "rose_gold", value);
  }
  assert.equal(normalizeSupplySpecValue("gold-black", "color"), "__ambiguous__");
  assert.equal(normalizeSupplySpecValue("rose gold blue", "color"), "__ambiguous__");
});

test("the real browser spec-selection callback binds rose gold in Chinese, English and Russian", async () => {
  const runBrowserCallback = async (rowText) => {
    let selected = false;
    const node = {
      className: "sku-option",
      innerText: rowText,
      textContent: rowText,
      parentElement: null,
      getAttribute(name) {
        if (name === "data-prop-name") return "颜色";
        if (name === "data-value-name") return rowText;
        if (name === "aria-selected") return selected ? "true" : "false";
        return null;
      },
      getBoundingClientRect: () => ({ width: 20, height: 20 }),
      matches: () => false,
      closest: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      click() { selected = true; },
    };
    const page = {
      async evaluate(callback, argument) {
        const previousDocument = globalThis.document;
        const previousGetComputedStyle = globalThis.getComputedStyle;
        globalThis.document = { querySelectorAll: () => [node] };
        globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", backgroundImage: "none" });
        try {
          return callback(argument);
        } finally {
          globalThis.document = previousDocument;
          globalThis.getComputedStyle = previousGetComputedStyle;
        }
      },
    };
    return selectExactSpecOption(page, "color", "rose_gold");
  };

  for (const rowText of ["玫瑰金", "rose gold", "розовое золото"]) {
    const result = await runBrowserCallback(rowText);
    assert.deepEqual(result, {
      found: true,
      group_found: true,
      disabled: false,
      clicked: true,
      selected: true,
    }, rowText);
  }

  const ambiguous = await runBrowserCallback("rose gold blue");
  assert.deepEqual(ambiguous, { found: false, group_found: true, selected: false });
});

test("normalizes one explicit color from a live 1688 compound SKU label and rejects multi-color labels", () => {
  assert.equal(
    normalizeSupplySpecValue("白色-棱镜ARGB同步5V3针PWM温控", "color"),
    "white",
  );
  assert.equal(normalizeSupplySpecValue("白色-黑色-棱镜ARGB控制器", "color"), "__ambiguous__");
});

function multiSkuSnapshot(attributes, { targetPrice = 26.5 } = {}) {
  const variants = attributes.map((variantAttributes, index) => ({
    skuId: `sku-${index + 1}`,
    ...variantAttributes,
    stock: 10,
    orderable: true,
    price: index === attributes.length - 1 ? targetPrice : 20 + index,
  }));
  return orderableSnapshot({
    body: "现货 1件起批",
    structured: { minOrderQuantity: 1, variants },
    specOptions: [],
    priceTexts: [],
    quantityInputs: variants.map((variant, index) => ({
      value: "0",
      min: "1",
      disabled: false,
      row_key: `sku:${variant.skuId}`,
      row_index: index,
      context_text: `${Object.values(attributes[index]).join(" ")} ￥${variant.price}`,
      variant_attributes: attributes[index],
    })),
  });
}

function imagePrimaryUnboundSnapshot({
  quantityInputs = [
    {
      value: "0",
      min: "1",
      disabled: false,
      context_text: "X100 黑色 四头 GU10 射灯 ￥25.80 库存20件",
      variant_attributes: { model: "X100", color: "黑色" },
    },
    {
      value: "0",
      min: "1",
      disabled: false,
      context_text: "X100 白色 四头 GU10 射灯 ￥26.80 库存20件",
      variant_attributes: { model: "X100", color: "白色" },
    },
  ],
  specOptions = [
    { group: "颜色", value: "黑色", disabled: false, selected: true },
    { group: "颜色", value: "白色", disabled: false, selected: false },
  ],
  price = 25.8,
} = {}) {
  return orderableSnapshot({
    body: `现货 1件起批 ￥${price.toFixed(2)}`,
    structured: { minOrderQuantity: 1, stock: 20, orderable: true, price },
    specOptions,
    priceTexts: [`￥${price.toFixed(2)}`],
    quantityInputs,
  });
}

test("binds one explicit target among twelve OD SKU rows and changes only that row to quantity one", async () => {
  const rows = Array.from({ length: 11 }, (_, index) => ({
    model: `X${index + 1}`,
    color: index % 2 ? "黑色" : "白色",
    capacity: `${128 + index} GB`,
    set_quantity: `${index + 1}件套`,
    interface: index % 2 ? "Lightning" : "Micro USB",
  }));
  rows.push({ model: "G500", color: "金色", capacity: "500 GB", set_quantity: "2件套", interface: "Type-C" });
  const snapshot = multiSkuSnapshot(rows);
  const operations = [];
  const base = fakePage(snapshot);
  const page = {
    ...base,
    async evaluate(callback, argument) {
      operations.push(argument?.operation || "snapshot");
      return base.evaluate(callback, argument);
    },
  };
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => page,
    now: () => Date.parse("2026-08-15T10:00:00Z"),
  });
  const target = {
    model: "g500",
    color: "gold",
    capacity: "500gb",
    set_quantity: "2",
    interface: "type-c",
  };
  const result = await verifier.verify(verifierInput([candidate("1")], {
    targetVariant: { required: true, attributes: target },
  }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), [
    ...Array(11).fill("0"), "1",
  ]);
  assert.deepEqual(result.evidence.variant_attributes, target);
  assert.equal(snapshot.dom_snapshot.buttons.some((button) => button.clicked === true), false);
  assert.equal(operations.some((operation) => /buy|order|cart|购买|订购|下单/iu.test(operation)), false);
});

test("fails closed without changing any OD row when target row matching yields zero or two candidates", async () => {
  const cases = [
    multiSkuSnapshot([
      { model: "X1", color: "黑色", interface: "Type-C" },
      { model: "X2", color: "白色", interface: "Type-C" },
    ]),
    multiSkuSnapshot([
      { model: "X1", color: "金色", interface: "Type-C" },
      { model: "X1", color: "金色", interface: "Type-C" },
    ]),
  ];
  for (const snapshot of cases) {
    const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
    const result = await verifier.verify(verifierInput([candidate("1")], {
      targetVariant: {
        required: true,
        attributes: { model: "X1", color: "gold", interface: "type-c" },
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.candidate_failures[0].reason_code, "variant_unbound", JSON.stringify(result));
    assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), Array(snapshot.dom_snapshot.quantity_inputs.length).fill("0"));
  }
});

test("does not match black to black-red and never modifies the wrong first OD SKU row", async () => {
  const snapshot = multiSkuSnapshot([
    { model: "X1", color: "黑红色", interface: "Type-C" },
    { model: "X1", color: "白色", interface: "Type-C" },
  ]);
  snapshot.dom_snapshot.quantity_inputs[0].variant_attributes.color = "black-red";
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([candidate("1")], {
    targetVariant: { required: true, attributes: { model: "X1", color: "black", interface: "type-c" } },
  }));

  assert.equal(result.ok, false);
  assert.equal(result.candidate_failures[0].reason_code, "variant_unbound");
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "0"]);
});

test("blocks a uniquely colored row when the target omits another varying SKU dimension", async () => {
  const snapshot = multiSkuSnapshot([
    { color: "黑色", interface: "Type-C", model: "标准版" },
    { color: "白色", interface: "Type-C", model: "温控版" },
  ]);
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([candidate("1")], {
    targetVariant: { required: true, attributes: { color: "black", interface: "type-c" } },
  }));

  assert.equal(result.ok, false);
  assert.equal(result.candidate_failures[0].reason_code, "variant_unbound");
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "0"]);
});

test("image-primary binds an otherwise uncovered multi-SKU dimension only by one exact signed thumbnail URL", async () => {
  const source = imageCandidate("1", { title: "白色风扇控制器 标准版 温控版" });
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [
      {
        value: "0", min: "1", disabled: false,
        row_key: "sku:standard", sku_ids: ["standard"],
        context_text: "白色 标准版 风扇控制器 ￥25.80 库存20件",
        variant_attributes: { color: "白色", model: "标准版" },
        sku_image_urls: ["https://cbu01.alicdn.com/img/ibank/other.jpg"],
      },
      {
        value: "0", min: "1", disabled: false,
        row_key: "sku:thermal", sku_ids: ["thermal"],
        context_text: "白色 温控版 风扇控制器 ￥26.80 库存20件",
        variant_attributes: { color: "白色", model: "温控版" },
        sku_image_urls: [source.image_match_evidence.image_url],
      },
    ],
    specOptions: [{ group: "颜色", value: "白色", disabled: false, selected: true }],
  });
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => fakePage(snapshot),
    now: () => Date.parse("2026-08-15T10:00:00Z"),
  });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "白色风扇控制器",
    targetVariant: { required: true, attributes: { color: "white" } },
  }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.selected_variant.selection_method, "image_primary_exact_thumbnail_url");
  assert.equal(result.evidence.selected_variant.selected_sku_image_url, source.image_match_evidence.image_url);
  assert.equal(result.evidence.selected_variant.row_key, "sku:thermal");
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "1"]);
});

test("image-primary binds one Alibaba _sum.jpg thumbnail to its exact signed base asset", async () => {
  const source = imageCandidate("799725305870", { title: "白色风扇控制器 标准版 温控版" });
  const signedUrl = source.image_match_evidence.image_url;
  const snapshot = imagePrimaryUnboundSnapshot({
    url: source.offer_url,
    quantityInputs: [
      {
        value: "0", min: "1", disabled: false,
        row_key: "sku:other", sku_ids: ["other"],
        context_text: "白色 标准版 风扇控制器 ￥25.80 库存20件",
        variant_attributes: { color: "白色", model: "标准版" },
        sku_image_urls: ["https://cbu01.alicdn.com/img/ibank/unrelated.jpg_sum.jpg"],
      },
      {
        value: "0", min: "1", disabled: false,
        row_key: "sku:exact", sku_ids: ["exact"],
        context_text: "白色-棱镜ARGB同步5V3针PWM温控 ￥26.80 库存20件",
        variant_attributes: { color: "白色-棱镜ARGB同步5V3针PWM温控", model: "温控版" },
        sku_image_urls: [`${signedUrl}_sum.jpg?resize=64#sku`],
      },
    ],
    specOptions: [{ group: "颜色", value: "白色", disabled: false, selected: true }],
  });
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => fakePage(snapshot),
    now: () => Date.parse("2026-08-15T10:00:00Z"),
  });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "白色风扇控制器",
    targetVariant: { required: true, attributes: { color: "white" } },
  }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.selected_variant.selection_method, "image_primary_exact_thumbnail_url");
  assert.equal(result.evidence.selected_variant.selected_sku_image_url, signedUrl);
  assert.equal(result.evidence.selected_variant.row_key, "sku:exact");
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "1"]);
});

test("image-primary exact-thumbnail binding fails closed when the signed URL is absent or appears on two SKU rows", async () => {
  for (const mode of ["absent", "duplicate"]) {
    const source = imageCandidate("1", { title: "白色风扇控制器 标准版 温控版" });
    const signedUrl = source.image_match_evidence.image_url;
    const snapshot = imagePrimaryUnboundSnapshot({
      quantityInputs: [
        {
          value: "0", min: "1", disabled: false,
          context_text: "白色 标准版 风扇控制器 ￥25.80 库存20件",
          variant_attributes: { color: "白色", model: "标准版" },
          sku_image_urls: [mode === "duplicate" ? signedUrl : "https://cbu01.alicdn.com/img/ibank/a.jpg"],
        },
        {
          value: "0", min: "1", disabled: false,
          context_text: "白色 温控版 风扇控制器 ￥26.80 库存20件",
          variant_attributes: { color: "白色", model: "温控版" },
          sku_image_urls: [mode === "duplicate" ? `${signedUrl}_sum.jpg` : "https://cbu01.alicdn.com/img/ibank/b.jpg"],
        },
      ],
      specOptions: [{ group: "颜色", value: "白色", disabled: false, selected: true }],
    });
    const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
    const result = await verifier.verify(verifierInput([source], {
      targetTitle: "白色风扇控制器",
      targetVariant: { required: true, attributes: { color: "white" } },
    }));

    assert.equal(result.ok, false, `${mode}: ${JSON.stringify(result)}`);
    assert.equal(result.candidate_failures[0].reason_code, "variant_unbound", mode);
    assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "0"], mode);
  }
});

test("classifier rejects forged exact-thumbnail interaction evidence that is not unique in the captured SKU rows", () => {
  const source = imageCandidate("1");
  const signedUrl = source.image_match_evidence.image_url;
  const snapshot = orderableSnapshot({
    structured: { minOrderQuantity: 1, stock: 20, orderable: true, price: 25.8 },
    quantityInputs: [
      {
        value: "1", min: "1", disabled: false, row_key: "sku:a",
        context_text: "X100 黑色 M 库存20件", variant_attributes: { model: "X100", color: "黑色", size: "M" },
        sku_image_urls: [signedUrl],
      },
      {
        value: "0", min: "1", disabled: false, row_key: "sku:b",
        context_text: "X100 黑色 L 库存20件", variant_attributes: { model: "X100", color: "黑色", size: "L" },
        sku_image_urls: [signedUrl],
      },
    ],
    interaction: {
      specs: { color: { found: true }, size: { found: true } },
      quantity: {
        found: true, set: true, value: 1, matched_rows: 1, row_key: "sku:a",
        selection_method: "image_primary_exact_thumbnail_url", soft_tie: false,
        selected_sku_image_url: signedUrl, thumbnail_match_count: 1,
      },
    },
  });
  const result = classify1688SupplySnapshot(snapshot, {
    candidate: source,
    targetVariant: { required: true, attributes: { model: "X100", color: "black", size: "M" } },
    targetTitle: "X100 黑色 M",
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });

  assert.equal(result.reason_code, "variant_unbound", JSON.stringify(result));
});

test("classifier rejects a forged selected thumbnail even when one captured row has the real canonical asset", () => {
  const source = imageCandidate("1");
  const signedUrl = source.image_match_evidence.image_url;
  const snapshot = orderableSnapshot({
    structured: { minOrderQuantity: 1, stock: 20, orderable: true, price: 25.8 },
    quantityInputs: [{
      value: "1", min: "1", disabled: false, row_key: "sku:a",
      context_text: "X100 黑色 M 库存20件",
      variant_attributes: { model: "X100", color: "黑色", size: "M" },
      sku_image_urls: [`${signedUrl}_sum.jpg`],
    }],
    interaction: {
      specs: { color: { found: true }, size: { found: true } },
      quantity: {
        found: true, set: true, value: 1, matched_rows: 1, row_key: "sku:a",
        selection_method: "image_primary_exact_thumbnail_url", soft_tie: false,
        selected_sku_image_url: "https://cbu01.alicdn.com/img/ibank/forged.jpg",
        thumbnail_match_count: 1,
      },
    },
  });
  const result = classify1688SupplySnapshot(snapshot, {
    candidate: source,
    targetVariant: { required: true, attributes: { model: "X100", color: "black", size: "M" } },
    targetTitle: "X100 黑色 M",
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });

  assert.equal(result.reason_code, "variant_unbound", JSON.stringify(result));
});

test("fails closed for a single quantity row when an explicit target attribute is not actually observed", async () => {
  const snapshot = multiSkuSnapshot([{ model: "X1", color: "黑色", interface: "Type-C" }]);
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([candidate("1")], {
    targetVariant: {
      required: true,
      attributes: { model: "X1", color: "black", interface: "type-c", capacity: "1 TB" },
    },
  }));

  assert.equal(result.ok, false);
  assert.equal(result.candidate_failures[0].reason_code, "variant_unbound");
  assert.equal(snapshot.dom_snapshot.quantity_inputs[0].value, "0");
  assert.equal(result.evidence, undefined);
});

test("trusted strong visual evidence falls back after exact variant_unbound and selects one compatible orderable row", async () => {
  const snapshot = imagePrimaryUnboundSnapshot();
  const operations = [];
  const base = fakePage(snapshot);
  const page = {
    ...base,
    async evaluate(callback, argument) {
      operations.push(argument?.operation || "snapshot");
      return base.evaluate(callback, argument);
    },
  };
  const source = imageCandidate("1");
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => page,
    now: () => Date.parse("2026-08-15T10:00:00Z"),
  });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "X100 黑色四头 GU10 射灯",
  }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.reason_code, "supply_verified_image_primary");
  assert.equal(result.evidence.variant_match_mode, "image_primary");
  assert.equal(result.evidence.match_basis, IMAGE_PRIMARY_MATCH_BASIS);
  assert.equal(result.evidence.image_match_evidence.lane, "strong_visual");
  assert.equal(result.evidence.variant_selection_required, true);
  assert.deepEqual(result.evidence.variant_attributes, { model: "x100", color: "black" });
  assert.deepEqual(result.evidence.variant_differences, [
    { name: "size", expected: "m", observed: null, kind: "unbound_soft" },
  ]);
  assert.equal(result.evidence.selected_variant.selection_method, "image_primary_best_target_overlap");
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["1", "0"]);
  assert.equal(snapshot.dom_snapshot.buttons.some((button) => button.clicked === true), false);
  assert.equal(operations.some((operation) => /buy|order|cart|购买|订购|下单/iu.test(operation)), false);
});

test("image-primary never resolves an uncovered head-count dimension or a soft tie by DOM order", async () => {
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [
      {
        value: "0", min: "1", disabled: false,
        context_text: "黑色 2头 GU10 射灯 ￥25.80 库存20件",
        variant_attributes: { color: "黑色" },
      },
      {
        value: "0", min: "1", disabled: false,
        context_text: "黑色 4头 GU10 射灯 ￥26.80 库存20件",
        variant_attributes: { color: "黑色" },
      },
    ],
    specOptions: [{ group: "颜色", value: "黑色", disabled: false, selected: true }],
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([
    imageCandidate("1", { title: "黑色 2头 3头 4头 GU10 射灯" }),
  ], {
    targetTitle: "黑色 GU10 射灯",
    targetVariant: { required: true, attributes: { color: "black" } },
  }));

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.candidate_failures[0].reason_code, "variant_unbound");
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "0"]);
});

test("head_count is independent from bundle quantity and uniquely binds the four-head SKU row", async () => {
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [
      {
        value: "0", min: "1", disabled: false,
        context_text: "黑色 2头 GU10 射灯 ￥25.80 库存20件",
        variant_attributes: { color: "黑色" },
      },
      {
        value: "0", min: "1", disabled: false,
        context_text: "黑色 4头 GU10 射灯 ￥26.80 库存20件",
        variant_attributes: { color: "黑色" },
      },
    ],
    specOptions: [{ group: "颜色", value: "黑色", disabled: false, selected: true }],
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([
    imageCandidate("1", { title: "黑色 2头 3头 4头 GU10 射灯" }),
  ], {
    targetTitle: "黑色 4头 GU10 射灯",
    targetVariant: { required: true, attributes: { color: "black", head_count: "4" } },
  }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.target_variant.head_count, "4");
  assert.equal(result.evidence.target_variant.set_quantity, undefined);
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "1"]);
});

test("shape aliases uniquely bind square versus round GX53 rows", async () => {
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [
      {
        value: "0", min: "1", disabled: false,
        context_text: "GX53 圆形黑色明装灯具 ￥15 库存100件",
        variant_attributes: { color: "黑色" },
      },
      {
        value: "0", min: "1", disabled: false,
        context_text: "GX53 квадратный 黑色明装灯具 ￥16 库存100件",
        variant_attributes: { color: "黑色" },
      },
    ],
    specOptions: [{ group: "颜色", value: "黑色", disabled: false, selected: true }],
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([imageCandidate("1", {
    title: "GX53 圆形方形黑色明装灯具",
  })], {
    targetTitle: "GX53 方形黑色明装灯具",
    targetVariant: { required: true, attributes: { color: "black", shape: "square" } },
  }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.target_variant.shape, "square");
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "1"]);
});

test("corroborated visual lane permits a lower per-image score only with two bound supporting offers", async () => {
  const source = imageCandidate("1", {
    matchType: "corroborated_multi",
    score: 0.63,
    colorScore: 0.90,
    dhashScore: 0.50,
    corroboratingOfferIds: ["1", "2"],
  });
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => fakePage(imagePrimaryUnboundSnapshot()),
    now: () => Date.parse("2026-08-15T10:00:00Z"),
  });
  const result = await verifier.verify(verifierInput([
    source,
    imageCandidate("2", {
      matchType: "corroborated_multi",
      corroboratingOfferIds: ["1", "2"],
    }),
  ], {
    targetTitle: "X100 黑色四头 GU10 射灯",
  }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.offer_id, "1");
  assert.equal(result.evidence.match_type, "corroborated_multi");
  assert.equal(result.evidence.image_match_evidence.lane, "corroborated_visual");
  assert.deepEqual(result.evidence.image_match_evidence.corroborating_offer_ids, ["1", "2"]);
});

test("corroborated V315 and V500 supports fail before any 1688 navigation", async () => {
  let pageCalls = 0;
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => {
      pageCalls += 1;
      throw new Error("pageProvider must not run for a signed identity conflict");
    },
  });
  const result = await verifier.verify(verifierInput([
    imageCandidate("1", {
      matchType: "corroborated_multi",
      title: "OBD2 汽车扫描仪 V315 发动机故障代码读取器",
      corroboratingOfferIds: ["1", "2"],
    }),
    imageCandidate("2", {
      matchType: "corroborated_multi",
      title: "汽车 OBD2 诊断检测仪 V500 读码扫描仪",
      corroboratingOfferIds: ["1", "2"],
    }),
  ], {
    targetTitle: "Grommie Сканер для диагностики автомобилей OBD2",
    targetVariant: { required: false, attributes: {} },
    itemLevelMatch: true,
  }));

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.reason_code, "supporting_model_conflict");
  assert.match(result.reason, /explicit_supporting_model_conflict:V315!=V500/u);
  assert.equal(pageCalls, 0);
});

test("branded Samsung core watch clone is rejected before pageProvider", async () => {
  let pageCalls = 0;
  const source = imageCandidate("1047972314839", {
    title: "跨境热销galaxy ultra watch8方智能手表开机logo手表smartwatch",
    score: 0.748175,
    colorScore: 0.999124,
    dhashScore: 0.640625,
    semanticStrength: "two_high_information_terms",
    identityConflicts: [],
  });
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => {
      pageCalls += 1;
      throw new Error("pageProvider must not run for a branded digital identity failure");
    },
  });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "Samsung Смарт-часы Galaxy Watch 8 (SM-L330 Bluetooth Версия), 44mm, Silver",
    targetVariant: { required: true, attributes: { model: "l330" } },
  }));

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.reason_code, "all_candidates_failed");
  assert.equal(result.attempts, 0);
  assert.equal(result.candidate_failures[0].reason_code, "image_identity_conflict");
  assert.match(result.candidate_failures[0].reason, /branded_core_digital_clone_cue/u);
  assert.match(result.candidate_failures[0].reason, /branded_core_digital_brand_missing:samsung/u);
  assert.match(result.candidate_failures[0].reason, /branded_core_digital_model_conflict:L330!=WATCH8/u);
  assert.equal(pageCalls, 0);
});

test("Apple Watch targets reject vivo-IQOO and Huawei watch identities before pageProvider", async () => {
  const cases = [
    {
      targetTitle: "Apple Watch 40/41/42mm, CAWEON DSJ-13-38-GR gray",
      targetModel: "DSJ-13-38-GR",
      offerTitle: "vivo Watch GT2 / IQOO Watch GT2",
      expectedBrand: "vivo",
    },
    {
      targetTitle: "Apple Watch，CAWEON DSJ-26-38-WTPK pink/white",
      targetModel: "DSJ-26-38-WTPK",
      offerTitle: "HUAWEI Watch Fit 3",
      expectedBrand: "huawei",
    },
  ];
  for (const [index, current] of cases.entries()) {
    let pageCalls = 0;
    const source = imageCandidate(String(index + 2), { title: current.offerTitle });
    const verifier = create1688SupplyVerifier({
      pageProvider: async () => {
        pageCalls += 1;
        throw new Error("pageProvider must not run for a branded digital brand conflict");
      },
    });
    const result = await verifier.verify(verifierInput([source], {
      targetTitle: current.targetTitle,
      targetVariant: { required: true, attributes: { model: current.targetModel } },
    }));

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.attempts, 0, current.offerTitle);
    assert.equal(result.candidate_failures[0].reason_code, "image_identity_conflict");
    assert.match(
      result.candidate_failures[0].reason,
      new RegExp(`branded_core_digital_brand_conflict:apple!=${current.expectedBrand}`, "u"),
    );
    assert.equal(pageCalls, 0, current.offerTitle);
  }
});

test("image-primary branded core watch requires exact model identity on the selected SKU row", async () => {
  const source = imageCandidate("4", {
    title: "Samsung Galaxy Watch8 SM-L330 智能手表",
    identityConflicts: [],
  });
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [{
      value: "0",
      min: "1",
      disabled: false,
      context_text: "银色 44mm 海外版原封 ￥138 库存983个",
      variant_attributes: { color: "银色" },
      sku_image_urls: [source.image_match_evidence.image_url],
    }],
    specOptions: [],
    price: 138,
  });
  let pageCalls = 0;
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => {
      pageCalls += 1;
      return fakePage(snapshot);
    },
  });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "Samsung Смарт-часы Galaxy Watch 8 (SM-L330 Bluetooth Версия), 44mm, Silver",
    targetVariant: { required: true, attributes: { model: "l330" } },
  }));

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.candidate_failures[0].reason_code, "spec_mismatch");
  assert.match(result.candidate_failures[0].reason, /branded_core_digital_selected_model_missing:L330/u);
  assert.equal(pageCalls, 1);
});

test("missing brand remains soft before navigation for a low-risk generic product", async () => {
  let pageCalls = 0;
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => {
      pageCalls += 1;
      return fakePage(orderableSnapshot());
    },
  });
  const result = await verifier.verify(verifierInput([
    imageCandidate("5", { title: "X100 黑色 M 台灯" }),
  ], {
    targetTitle: "Grommie Настольная лампа X100",
  }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(pageCalls, 1);
});

test("low-score, accessory, signed spec-conflict and tampered-offer visual proofs never unlock fallback", async () => {
  const insecureImage = imageCandidate("1");
  insecureImage.image_match_evidence.image_url = "http://cbu01.alicdn.com/img/ibank/1.jpg";
  const cases = [
    [imageCandidate("1", { score: 0.67 }), "image-threshold"],
    [imageCandidate("1", { accessoryConflict: true }), "image-accessory-conflict"],
    [imageCandidate("1", { specConflicts: [{ name: "color", expected: "black", observed: "white" }] }), "image-spec-conflict"],
    [imageCandidate("1", { evidenceOfferId: "999" }), "image-offer-binding"],
    [insecureImage, "image-url"],
  ];
  for (const [source, expectedReason] of cases) {
    assert.deepEqual(assessImagePrimaryCandidate(source), { ok: false, reason: expectedReason });
    const snapshot = imagePrimaryUnboundSnapshot();
    const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
    const result = await verifier.verify(verifierInput([source], {
      targetTitle: "X100 黑色四头 GU10 射灯",
    }));
    assert.equal(result.ok, false, expectedReason);
    assert.equal(result.candidate_failures[0].reason_code, "variant_unbound", expectedReason);
    assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "0"], expectedReason);
  }
});

test("strong visual lane requires at least 0.90 color similarity", () => {
  assert.deepEqual(assessImagePrimaryCandidate(imageCandidate("1", { colorScore: 0.899 })), {
    ok: false,
    reason: "image-threshold",
  });
  assert.equal(assessImagePrimaryCandidate(imageCandidate("1", { colorScore: 0.90 })).ok, true);
});

test("image-backed text-soft evidence uses a dedicated 0.90/0.82/0.90 lane", () => {
  const accepted = assessImagePrimaryCandidate(imageCandidate("1", {
    semanticStrength: "image_backed",
    identityConflicts: [],
    score: 0.90,
    colorScore: 0.90,
    dhashScore: 0.82,
  }));
  assert.equal(accepted.ok, true);
  assert.equal(accepted.lane, "strong_visual_text_soft");
  assert.equal(accepted.evidence.lane, "strong_visual_text_soft");

  for (const [name, overrides] of [
    ["score", { score: 0.899 }],
    ["dhash", { dhashScore: 0.819 }],
    ["color", { colorScore: 0.899 }],
  ]) {
    assert.deepEqual(assessImagePrimaryCandidate(imageCandidate("1", {
      semanticStrength: "image_backed",
      identityConflicts: [],
      score: 0.90,
      colorScore: 0.90,
      dhashScore: 0.82,
      ...overrides,
    })), { ok: false, reason: "image-threshold" }, name);
  }
  assert.deepEqual(assessImagePrimaryCandidate(imageCandidate("1", {
    semanticStrength: "image_backed",
    score: 0.95,
    colorScore: 0.95,
    dhashScore: 0.90,
  })), { ok: false, reason: "image-threshold" });
  assert.deepEqual(assessImagePrimaryCandidate(imageCandidate("1", {
    semanticStrength: "image_backed",
    identityConflicts: ["explicit_model_conflict:X100!=Y200"],
    score: 0.95,
    colorScore: 0.95,
    dhashScore: 0.90,
  })), { ok: false, reason: "image-identity-conflict" });
});

test("quantity text-input fallbacks stay scoped to explicit number-picker containers", () => {
  assert.equal(QUANTITY_INPUT_SELECTORS.includes('input[type="text"]'), false);
  assert.equal(QUANTITY_INPUT_SELECTORS.some((selector) => /number-picker/iu.test(selector)), true);
  assert.equal(QUANTITY_INPUT_SELECTORS.some((selector) => /counter/iu.test(selector)), true);
  assert.equal(QUANTITY_INPUT_SELECTORS.some((selector) => /data-testid.*quantity/iu.test(selector)), true);
  assert.equal(
    QUANTITY_INPUT_SELECTORS.filter((selector) => /input:not\(\[type="hidden"\]\)/u.test(selector))
      .every((selector) => selector.trim().startsWith("[")),
    true,
  );
});

test("image-primary rejects a non-auditable selected-row method", () => {
  const snapshot = orderableSnapshot();
  snapshot.interaction.quantity.selection_method = "image_primary_orderable_row";
  const result = classify1688SupplySnapshot(snapshot, {
    candidate: imageCandidate("1"),
    targetTitle: "X100 黑色四头 GU10 射灯",
    targetVariant: { required: true, attributes: { color: "black", size: "m" } },
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });
  assert.equal(result.reason_code, "variant_unbound", JSON.stringify(result));
});

test("image-primary blocks explicit color, model and cosmetic product-type conflicts", async () => {
  const cases = [
    {
      label: "color",
      targetTitle: "X100 黑色四头 GU10 射灯",
      targetVariant: { required: true, attributes: { color: "black", size: "M" } },
      sourceTitle: "X100 白色四头 GU10 射灯",
    },
    {
      label: "model",
      targetTitle: "W1106A 黑色激光硒鼓",
      targetVariant: { required: true, attributes: { model: "W1106A", capacity: "1 L" } },
      sourceTitle: "W1680A 黑色激光硒鼓",
    },
    {
      label: "cosmetic type",
      targetTitle: "Celimax Pore Sunscreen 防晒霜 50 ml",
      targetVariant: { required: true, attributes: { capacity: "50 ml" } },
      sourceTitle: "Celimax Noni Serum 精华 50 ml",
    },
  ];
  for (const current of cases) {
    const snapshot = imagePrimaryUnboundSnapshot({
      quantityInputs: [{
        value: "0",
        min: "1",
        disabled: false,
        context_text: "单一可购规格 ￥25.80 库存20件",
        variant_attributes: {},
      }],
      specOptions: [],
    });
    const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
    const result = await verifier.verify(verifierInput([
      imageCandidate("1", { title: current.sourceTitle }),
    ], {
      targetTitle: current.targetTitle,
      targetVariant: current.targetVariant,
    }));
    assert.equal(result.ok, false, `${current.label}: ${JSON.stringify(result)}`);
    assert.equal(result.candidate_failures[0].reason_code, "image_identity_conflict", current.label);
    assert.equal(snapshot.dom_snapshot.buttons.some((button) => button.clicked === true), false, current.label);
  }
});

test("image-primary detects naked Chinese color words and core-product versus watch-accessory conflicts", () => {
  const colorConflict = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "PETG 紫高韧 1kg 3D打印耗材" }),
    targetTitle: "PETG 荧光绿 1kg 3D打印耗材",
    targetVariant: { required: true, attributes: { color: "green" } },
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });
  assert.equal(colorConflict.reason_code, "image_identity_conflict", JSON.stringify(colorConflict));
  assert.match(colorConflict.reason, /explicit_color_conflict/u);

  for (const title of ["PETG пурпурный 1kg", "PETG фиолетовый 1kg"]) {
    const russianPurple = classify1688SupplySnapshot(orderableSnapshot(), {
      candidate: imageCandidate("1", { title }),
      targetTitle: "PETG флуоресцентный зелёный 1kg",
      targetVariant: { required: true, attributes: { color: "green" } },
      matchEvidenceKey: MATCH_KEY,
      variantMatchMode: "image_primary",
    });
    assert.equal(russianPurple.reason_code, "image_identity_conflict", `${title}: ${JSON.stringify(russianPurple)}`);
  }
  const russianGreen = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "PETG салатный 1kg" }),
    targetTitle: "PETG пурпурный 1kg",
    targetVariant: { required: true, attributes: { color: "purple" } },
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });
  assert.equal(russianGreen.reason_code, "image_identity_conflict", JSON.stringify(russianGreen));

  const accessoryConflict = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "Redmi Watch 5 Active 硅胶保护套软壳" }),
    targetTitle: "Redmi Watch 5 Active 智能手表",
    targetVariant: { required: true, attributes: { color: "black" } },
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });
  assert.equal(accessoryConflict.reason_code, "image_identity_conflict", JSON.stringify(accessoryConflict));
  assert.match(accessoryConflict.reason, /core_accessory_conflict/u);
});

test("rejects explicit perfume-name conflicts in candidate titles and selected SKU rows while missing names stay soft", () => {
  const targetTitle = "Парфюмерная вода Lattafa Oud for Glory 100 мл";
  const candidateConflict = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "Lattafa Yara 女士香水 100ml" }),
    targetTitle,
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(candidateConflict.reason_code, "image_identity_conflict", JSON.stringify(candidateConflict));
  assert.match(candidateConflict.reason, /explicit_perfume_identity_conflict:glory\|lattafa\|oud!=lattafa\|yara/u);

  const selectedRowConflict = classify1688SupplySnapshot(orderableSnapshot({
    structured: { minOrderQuantity: 1 },
    specOptions: [],
    quantityInputs: [{
      value: "1", min: "1", disabled: false,
      context_text: "Yara 粉色 100ml ￥25.80 库存20件",
      variant_attributes: {},
    }],
  }), {
    candidate: imageCandidate("1", { title: "Lattafa Yara Oud for Glory 多香型香水可选" }),
    targetTitle,
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });
  assert.equal(selectedRowConflict.reason_code, "spec_mismatch", JSON.stringify(selectedRowConflict));
  assert.match(selectedRowConflict.reason, /explicit_perfume_identity_conflict:glory\|lattafa\|oud!=yara/u);

  const missingOfferName = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "女士香水 100ml 现货" }),
    targetTitle,
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(missingOfferName.ok, true, JSON.stringify(missingOfferName));

  const expandedSameName = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "Badee Al Oud for Glory Eau de Parfum 100ml" }),
    targetTitle,
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(expandedSameName.ok, true, JSON.stringify(expandedSameName));
});

test("rejects explicit female/female versus female/male thread-end conflicts in titles and selected rows while missing endpoints stay soft", () => {
  const targetTitle = "DN25 1寸 内丝/内丝 黄铜球阀";
  const candidateConflict = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "DN25 1寸 内外丝 黄铜球阀" }),
    targetTitle,
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(candidateConflict.reason_code, "image_identity_conflict", JSON.stringify(candidateConflict));
  assert.match(candidateConflict.reason, /explicit_thread_end_conflict:female!=female-male/u);

  const selectedRowConflict = classify1688SupplySnapshot(orderableSnapshot({
    structured: { minOrderQuantity: 1 },
    specOptions: [],
    quantityInputs: [{
      value: "1", min: "1", disabled: false,
      context_text: "DN25 1寸 内外丝 ￥25.80 库存20件",
      variant_attributes: {},
    }],
  }), {
    candidate: imageCandidate("1", { title: "DN25 黄铜球阀 内丝 内外丝 多规格可选" }),
    targetTitle,
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });
  assert.equal(selectedRowConflict.reason_code, "spec_mismatch", JSON.stringify(selectedRowConflict));
  assert.match(selectedRowConflict.reason, /explicit_thread_end_conflict:female!=female-male/u);

  const missingEndpoint = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "DN25 1寸 黄铜球阀" }),
    targetTitle,
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(missingEndpoint.ok, true, JSON.stringify(missingEndpoint));
});

test("rejects disjoint explicit alphanumeric model sets in candidate titles and selected SKU rows", () => {
  const candidateConflict = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "OBD 汽车检测仪故障诊断仪 V519 电瓶检测 OBD2" }),
    targetTitle: "Автосканер ELM327 Aolon F180 OBD2, модель 2026 года",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(candidateConflict.reason_code, "image_identity_conflict", JSON.stringify(candidateConflict));
  assert.match(candidateConflict.reason, /explicit_model_conflict:ELM327\|F180!=V519/u);

  const selectedRowConflict = classify1688SupplySnapshot(orderableSnapshot({
    structured: { minOrderQuantity: 1 },
    specOptions: [],
    quantityInputs: [{
      value: "1", min: "1", disabled: false,
      context_text: "黑红 V539 ￥65 库存9991台",
      variant_attributes: { size: "黑红 V539" },
    }],
    interaction: {
      specs: {},
      quantity: { found: true, set: true, value: 1, selection_method: "image_primary_best_target_overlap" },
    },
  }), {
    candidate: imageCandidate("1", { title: "汽车读码器 OBD2 多功能故障码清除扫描仪" }),
    targetTitle: "Диагностический сканер AT500 OBD2 (не ELM3)",
    targetVariant: { required: true, attributes: { model: "AT500" } },
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });
  assert.equal(selectedRowConflict.reason_code, "spec_mismatch", JSON.stringify(selectedRowConflict));
  assert.match(selectedRowConflict.reason, /explicit_model_conflict:AT500!=V539/u);
});

test("explicit leading brands conflict while an omitted 1688 brand remains soft", () => {
  const targetTitle = "Grommie Сканер для диагностики автомобилей OBD2";
  const differentBrand = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "Bosch 汽车 OBD2 诊断扫描仪" }),
    targetTitle,
    targetVariant: { required: false, attributes: {} },
    itemLevelMatch: true,
    matchEvidenceKey: MATCH_KEY,
  });
  const missingBrand = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "汽车 OBD2 诊断扫描仪" }),
    targetTitle,
    targetVariant: { required: false, attributes: {} },
    itemLevelMatch: true,
    matchEvidenceKey: MATCH_KEY,
  });

  assert.equal(differentBrand.reason_code, "image_identity_conflict", JSON.stringify(differentBrand));
  assert.match(differentBrand.reason, /explicit_brand_conflict:grommie!=bosch/u);
  assert.equal(missingBrand.ok, true, JSON.stringify(missingBrand));
});

test("rejects the real DOBE and HiFlo generic-supplier identity gaps before navigation", async () => {
  const fixtures = [
    {
      targetTitle: "Беспроводной геймпад DOBE для PS4 / Джойстик Dualshock PS4, пурпурно-синий",
      targetVariant: { required: true, attributes: { color: "blue" } },
      offerTitle: "p4手柄p4无线蓝牙震动游戏手柄ps4主机游戏手柄ps4盒装游戏手柄",
      reason: /declared_brand_missing:dobe.*declared_model_missing:dualshock/iu,
    },
    {
      targetTitle: "Фильтр воздушный HiFlo HFA3612 Suzuki SV650\/SV1000 03-10",
      targetVariant: { required: false, attributes: {} },
      offerTitle: "适用于铃木sv650 sfv650 sv1000摩托车空滤 空气格滤芯空气滤清器",
      reason: /declared_brand_missing:hiflo.*declared_model_missing:HFA3612/iu,
    },
  ];
  for (const [index, fixture] of fixtures.entries()) {
    let pageRequests = 0;
    const verifier = create1688SupplyVerifier({
      pageProvider: async () => {
        pageRequests += 1;
        return fakePage(orderableSnapshot());
      },
    });
    const result = await verifier.verify(verifierInput([
      imageCandidate(String(index + 1), { title: fixture.offerTitle }),
    ], fixture));
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.candidate_failures[0].reason_code, "image_identity_conflict");
    assert.match(result.candidate_failures[0].reason, fixture.reason);
    assert.equal(pageRequests, 0, "declared identity must fail before opening 1688");
  }
});

test("rose-gold selected SKUs conflict with blue in three languages and never hide an extra colour", () => {
  for (const rowText of ["玫瑰金 ¥29 库存9328个", "rose gold", "розовое золото", "rose gold blue"]) {
    const snapshot = imagePrimaryUnboundSnapshot({
      quantityInputs: [{
        value: "1",
        min: "1",
        disabled: false,
        context_text: rowText,
        variant_attributes: {},
      }],
      specOptions: [],
      price: 29,
    });
    const result = classify1688SupplySnapshot(snapshot, {
      candidate: imageCandidate("1", { title: "DOBE DualShock PS4 游戏手柄" }),
      targetTitle: "Беспроводной геймпад DOBE для PS4 / Джойстик Dualshock PS4, пурпурно-синий",
      targetVariant: { required: true, attributes: { color: "blue" } },
      matchEvidenceKey: MATCH_KEY,
      variantMatchMode: "image_primary",
    });
    assert.equal(result.ok, false, `${rowText}: ${JSON.stringify(result)}`);
    assert.equal(result.reason_code, "spec_mismatch");
    assert.match(result.reason, /explicit_color_conflict:blue!=/iu);
  }
});

test("rose-gold target and selected SKU remain equal in Chinese, English and Russian", () => {
  for (const rowText of ["玫瑰金", "rose gold", "розовое золото"]) {
    const snapshot = imagePrimaryUnboundSnapshot({
      quantityInputs: [{ value: "1", min: "1", disabled: false, context_text: `${rowText} 库存20件`, variant_attributes: {} }],
      specOptions: [],
      price: 29,
    });
    const result = classify1688SupplySnapshot(snapshot, {
      candidate: imageCandidate("1", { title: "DOBE DualShock PS4 rose gold gamepad" }),
      targetTitle: "DOBE DualShock PS4 rose gold gamepad",
      targetVariant: { required: true, attributes: { color: "rose_gold" } },
      matchEvidenceKey: MATCH_KEY,
      variantMatchMode: "image_primary",
    });
    assert.equal(result.ok, true, `${rowText}: ${JSON.stringify(result)}`);
  }
});

test("compatibility-only generic target keeps missing brand and model text soft", () => {
  const result = classify1688SupplySnapshot(orderableSnapshot({
    structured: { minOrderQuantity: 1, stock: 20, orderable: true, price: 25.8 },
    specOptions: [],
    quantityInputs: [{ value: "1", min: "1", disabled: false, variant_attributes: {} }],
  }), {
    candidate: imageCandidate("1", { title: "适用于铃木sv650摩托车空气滤清器" }),
    targetTitle: "Generic motorcycle air filter for Suzuki SV650",
    targetVariant: { required: false, attributes: {} },
    itemLevelMatch: true,
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("model identity ignores ratings, dimensions, years and known protocol noise, while shared models remain compatible", () => {
  const noiseOnly = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "LED work lamp 12V 60W 100mm OBD2 WiFi6 BT5 2025" }),
    targetTitle: "LED 工作灯 12V 60W 100mm OBD2 WiFi6 BT5 2026年",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(noiseOnly.ok, true, JSON.stringify(noiseOnly));

  const sharedModel = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "HB69 镜头罩 compatible D3300 D5500" }),
    targetTitle: "HB-69 lens hood for Nikon D3200 D3300",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(sharedModel.ok, true, JSON.stringify(sharedModel));

  const shortExplicitModel = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "TIV3 tornado interception vehicle model" }),
    targetTitle: "TIV2 tornado interception vehicle model",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(shortExplicitModel.reason_code, "image_identity_conflict", JSON.stringify(shortExplicitModel));
  assert.match(shortExplicitModel.reason, /explicit_model_conflict:TIV2!=TIV3/u);
});

test("rejects explicit model-scale conflicts without treating a missing scale as a conflict", () => {
  const conflict = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "RASTAR Mercedes F1 W15E 1:18 遥控赛车模型" }),
    targetTitle: "RASTAR Mercedes F1 W15E Масштаб 1:12",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(conflict.reason_code, "image_identity_conflict", JSON.stringify(conflict));
  assert.match(conflict.reason, /explicit_scale_conflict:1:12!=1:18/u);

  const missingScale = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "RASTAR Mercedes F1 W15E 遥控赛车模型" }),
    targetTitle: "RASTAR Mercedes F1 W15E Масштаб 1:12",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(missingScale.ok, true, JSON.stringify(missingScale));
});

test("rejects explicit assembly-kit versus finished-metal-model role conflicts and keeps unstated roles soft", () => {
  const conflict = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "20cm 麦道 MD-11 静态合金成品模型 带轮航模摆件" }),
    targetTitle: "Сборная пластиковая модель авиалайнера MD-11 1:144",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(conflict.reason_code, "image_identity_conflict", JSON.stringify(conflict));
  assert.match(conflict.reason, /explicit_model_build_role_conflict:assembly_model_kit!=finished_metal_model/u);

  const unstatedTargetRole = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "20cm 麦道 MD-11 静态合金成品模型" }),
    targetTitle: "Восточный Экспресс Авиалайнер MD-11 1:144",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(unstatedTargetRole.ok, true, JSON.stringify(unstatedTargetRole));
});

test("rejects explicit rear-seat/body parts matched to complete toy vehicles", () => {
  const result = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "Welly 威利 1:12 雅马哈 MT-10 SP 仿真合金摩托车成品模型玩具" }),
    targetTitle: "Пиллион Соло заднее сиденье Крышка для Yamaha FZ-10 MT-10 2016-2020",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(result.reason_code, "image_identity_conflict", JSON.stringify(result));
  assert.match(result.reason, /explicit_toy_vehicle_role_conflict:toy_vehicle_body_part!=complete_toy_vehicle/u);
});

test("rejects a differentiated play set matched to an explicit single collectible", () => {
  const result = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "TIV2 龙卷风拦截车模型 3D打印摆件 场景模拟车轮可动" }),
    targetTitle: "Игровой набор Storm Chasers: модель TIV2, спортивная машинка, фигуры торнадо и цунами",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(result.reason_code, "image_identity_conflict", JSON.stringify(result));
  assert.match(result.reason, /explicit_differentiated_bundle_conflict/u);

  const replicableIdenticalPack = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "single TIV2 vehicle model" }),
    targetTitle: "3-piece set of identical TIV2 vehicle models",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(replicableIdenticalPack.ok, true, JSON.stringify(replicableIdenticalPack));
});

test("rejects an explicit Hot Wheels named style matched to the T-Rex style in candidate titles and selected rows", () => {
  const candidateConflict = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "风火轮 Hot Wheels FYJ44 大脚车 霸王龙 T-Rex" }),
    targetTitle: "Hot Wheels Monster Truck FYJ44 WILL TRASH IT ALL",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(candidateConflict.reason_code, "image_identity_conflict", JSON.stringify(candidateConflict));
  assert.match(candidateConflict.reason, /explicit_collectible_style_conflict:will_trash_it_all!=rageasaur_trex/u);

  const selectedRowConflict = classify1688SupplySnapshot(orderableSnapshot({
    structured: { minOrderQuantity: 1 },
    specOptions: [],
    quantityInputs: [{
      value: "1", min: "1", disabled: false,
      context_text: "风火轮大脚车-霸王龙【3m】 ¥28.9 库存2辆",
      variant_attributes: { color: "风火轮大脚车-霸王龙【3m】" },
    }],
    interaction: {
      specs: {},
      quantity: { found: true, set: true, value: 1, selection_method: "image_primary_best_target_overlap" },
    },
  }), {
    candidate: imageCandidate("1", { title: "风火轮合金车 FYJ44 狂野怪物大脚车模型" }),
    targetTitle: "Машинка Hot Wheels Монстр-трак FYJ44 WILL TRASH IT ALL",
    targetVariant: { required: true, attributes: { model: "fyj44" } },
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });
  assert.equal(selectedRowConflict.reason_code, "spec_mismatch", JSON.stringify(selectedRowConflict));
  assert.match(selectedRowConflict.reason, /explicit_collectible_style_conflict:will_trash_it_all!=rageasaur_trex/u);

  const rageasaurAlias = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "风火轮 Hot Wheels FYJ44 大脚车 霸王龙" }),
    targetTitle: "Hot Wheels Monster Trucks FYJ44 Rageasaur",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(rageasaurAlias.ok, true, JSON.stringify(rageasaurAlias));

  const missingStyle = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "风火轮 Hot Wheels FYJ44 大脚车" }),
    targetTitle: "Hot Wheels Monster Truck FYJ44 WILL TRASH IT ALL",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(missingStyle.ok, true, JSON.stringify(missingStyle));
});

test("rejects with-neutral versus no-neutral relay wiring in both directions and keeps missing topology soft", () => {
  for (const [targetTitle, offerTitle, expected] of [
    [
      "Умное реле 1-канальное с нейтралью 10А Zigbee",
      "Zigbee 通断器智能开关模块 单火开关",
      "with_neutral!=no_neutral",
    ],
    [
      "Zigbee smart relay without neutral single live wire",
      "Zigbee 零火开关模块 需要零线",
      "no_neutral!=with_neutral",
    ],
  ]) {
    const result = classify1688SupplySnapshot(orderableSnapshot(), {
      candidate: imageCandidate("1", { title: offerTitle }),
      targetTitle,
      targetVariant: { required: false, attributes: {} },
      matchEvidenceKey: MATCH_KEY,
    });
    assert.equal(result.reason_code, "image_identity_conflict", JSON.stringify(result));
    assert.match(result.reason, new RegExp(`explicit_wiring_topology_conflict:${expected}`, "u"));
  }

  const selectedRowConflict = classify1688SupplySnapshot(orderableSnapshot({
    structured: { minOrderQuantity: 1 },
    specOptions: [],
    quantityInputs: [{
      value: "1", min: "1", disabled: false,
      context_text: "一路单火模块 一开单控 白色 ¥36 库存458件",
      variant_attributes: {},
    }],
    interaction: {
      specs: {},
      quantity: { found: true, set: true, value: 1, selection_method: "image_primary_best_target_overlap" },
    },
  }), {
    candidate: imageCandidate("1", { title: "Zigbee 涂鸦智能家居开关迷你通断器" }),
    targetTitle: "Умное реле в подрозетник с нейтралью 10А Zigbee",
    targetVariant: { required: true, attributes: { current_a: "10a" } },
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });
  assert.equal(selectedRowConflict.reason_code, "spec_mismatch", JSON.stringify(selectedRowConflict));
  assert.match(selectedRowConflict.reason, /explicit_wiring_topology_conflict:with_neutral!=no_neutral/u);

  const missingTopology = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "Zigbee smart relay switch module" }),
    targetTitle: "Умное реле с нейтралью Zigbee",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(missingTopology.ok, true, JSON.stringify(missingTopology));
});

test("rejects explicit Bluetooth 5.0 versus 5.1 despite an equal ELM327 model and keeps generic Bluetooth soft", () => {
  for (const [targetVersion, offerVersion] of [["5.0", "5.1"], ["5.1", "5.0"]]) {
    const result = classify1688SupplySnapshot(orderableSnapshot(), {
      candidate: imageCandidate("1", {
        title: `批发 mini ELM327 v2.1 bluetooth 蓝牙${offerVersion} iOS 双模`,
      }),
      targetTitle: `Автомобильный сканер ELM327 OBD2 с Bluetooth ${targetVersion}`,
      targetVariant: { required: false, attributes: {} },
      matchEvidenceKey: MATCH_KEY,
    });
    assert.equal(result.reason_code, "image_identity_conflict", JSON.stringify(result));
    assert.match(result.reason, new RegExp(`explicit_bluetooth_version_conflict:${targetVersion.replace(".", "\\.")}!=${offerVersion.replace(".", "\\.")}`, "u"));
  }

  const selectedRowConflict = classify1688SupplySnapshot(orderableSnapshot({
    structured: { minOrderQuantity: 1 },
    specOptions: [],
    quantityInputs: [{
      value: "1", min: "1", disabled: false,
      context_text: "ELM327 蓝牙5.1 iOS安卓双模 ¥4.4 库存294455件",
      variant_attributes: {},
    }],
    interaction: {
      specs: {},
      quantity: { found: true, set: true, value: 1, selection_method: "image_primary_best_target_overlap" },
    },
  }), {
    candidate: imageCandidate("1", { title: "mini ELM327 Bluetooth OBD2 scanner" }),
    targetTitle: "Автомобильный сканер ELM327 OBD2 с Bluetooth 5.0",
    targetVariant: { required: true, attributes: { model: "elm327" } },
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });
  assert.equal(selectedRowConflict.reason_code, "spec_mismatch", JSON.stringify(selectedRowConflict));
  assert.match(selectedRowConflict.reason, /explicit_bluetooth_version_conflict:5\.0!=5\.1/u);

  for (const [targetTitle, offerTitle] of [
    ["ELM327 OBD2 Bluetooth 5.0 scanner", "ELM327 OBD2 Bluetooth scanner"],
    ["ELM327 OBD2 Bluetooth scanner", "ELM327 OBD2 Bluetooth 5.1 scanner"],
    ["ELM327 OBD2 Bluetooth 5.0 scanner", "ELM327 OBD2 Bluetooth 5.0 scanner"],
  ]) {
    const result = classify1688SupplySnapshot(orderableSnapshot(), {
      candidate: imageCandidate("1", { title: offerTitle }),
      targetTitle,
      targetVariant: { required: false, attributes: {} },
      matchEvidenceKey: MATCH_KEY,
    });
    assert.equal(result.ok, true, `${targetTitle} / ${offerTitle}: ${JSON.stringify(result)}`);
  }
});

test("rejects PS4/DualShock charging docks matched to controller bodies and continues to the next strict offer", async () => {
  const targetTitle = "PS4 DualShock charging dock black";
  const snapshot = orderableSnapshot({
    quantityInputs: [{
      value: "1", min: "1", disabled: false,
      context_text: "PS4 DualShock charging dock black ￥25.80 库存20件",
      variant_attributes: { color: "黑色" },
    }],
    structured: {
      minOrderQuantity: 1,
      variants: [{ skuId: "dock-black", color: "黑色", stock: 20, orderable: true, price: 25.8 }],
    },
    specOptions: [{ group: "颜色", value: "黑色", disabled: false, selected: true }],
  });
  const controller = imageCandidate("1", { title: "PS4 DualShock wireless gamepad controller black" });
  const dock = imageCandidate("2", { title: "PS4 DualShock charging dock black" });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([controller, dock], {
    targetTitle,
    targetVariant: { required: true, attributes: { color: "black" } },
  }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.offer_id, "2");
  assert.equal(result.candidate_failures.length, 1);
  assert.equal(result.candidate_failures[0].reason_code, "image_identity_conflict");
  assert.match(result.candidate_failures[0].reason, /core_accessory_conflict/u);
});

test("image-primary rejects Xbox console bodies matched to cooling fans or multifunction stands", () => {
  const targetTitle = "Игровая приставка Xbox Series S";
  for (const offerTitle of [
    "series s顶部散热风扇",
    "多合一散热支架 无线手柄充电器底座 主机支架",
  ]) {
    const result = classify1688SupplySnapshot(orderableSnapshot(), {
      candidate: imageCandidate("1", { title: offerTitle }),
      targetTitle,
      targetVariant: { required: false, attributes: {} },
      matchEvidenceKey: MATCH_KEY,
      variantMatchMode: "image_primary",
    });
    assert.equal(result.ok, false, `${offerTitle}: ${JSON.stringify(result)}`);
    assert.equal(result.reason_code, "image_identity_conflict", offerTitle);
    assert.match(result.reason, /core_accessory_conflict/u, offerTitle);
  }
});

test("game-console accessory targets may match accessories and missing accessory-role text stays soft", () => {
  const accessoryTarget = "Вентилятор охлаждения для Xbox Series S";
  const accessoryMatch = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "Xbox Series S 顶部散热风扇" }),
    targetTitle: accessoryTarget,
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(accessoryMatch.ok, true, JSON.stringify(accessoryMatch));

  const missingRole = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "Series S compatible product" }),
    targetTitle: "Игровая приставка Xbox Series S",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(missingRole.ok, true, JSON.stringify(missingRole));
});

test("rejects the real stylus-to-sleeve mismatch before opening 1688", async () => {
  const targetTitle = "Стилус универсальный для iPad с поддержкой наклона и изменением толщины линии";
  let pageRequests = 0;
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => {
      pageRequests += 1;
      return fakePage(orderableSnapshot());
    },
  });
  const result = await verifier.verify(verifierInput([
    imageCandidate("1057425518888", {
      title: "莱卡弹力触控笔笔套 iPad 手写笔苹果笔便携收纳笔套",
    }),
  ], {
    targetTitle,
    targetVariant: { required: false, attributes: {} },
  }));

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.candidate_failures[0].reason_code, "image_identity_conflict");
  assert.match(result.candidate_failures[0].reason, /core_accessory_conflict/u);
  assert.equal(pageRequests, 0, "stylus sleeves must fail before opening the supplier page");
});

test("allows real stylus bodies and stylus-accessory targets to match their own roles", () => {
  for (const [targetTitle, offerTitle] of [
    ["iPad stylus pen with tilt support", "iPad active stylus pen with tilt support"],
    ["Protective case for Apple Pencil stylus", "Apple Pencil stylus case holder"],
  ]) {
    const result = classify1688SupplySnapshot(orderableSnapshot(), {
      candidate: imageCandidate("1", { title: offerTitle }),
      targetTitle,
      targetVariant: { required: false, attributes: {} },
      matchEvidenceKey: MATCH_KEY,
    });
    assert.equal(result.ok, true, `${targetTitle} / ${offerTitle}: ${JSON.stringify(result)}`);
  }
});

test("rejects a stylus sleeve disclosed only by the selected 1688 SKU row", () => {
  const snapshot = orderableSnapshot({
    structured: { minOrderQuantity: 1 },
    specOptions: [],
    quantityInputs: [{
      value: "1",
      min: "1",
      disabled: false,
      context_text: "触控笔专用笔套 灰色 ¥2.38 库存9999件",
      variant_attributes: { color: "gray" },
    }],
  });
  const result = classify1688SupplySnapshot(snapshot, {
    candidate: imageCandidate("1", { title: "iPad compatible product" }),
    targetTitle: "iPad stylus pen with tilt support",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.reason_code, "spec_mismatch");
  assert.match(result.reason, /core_accessory_conflict/u);
});

test("rejects explicit Zigbee/Wi-Fi conflicts in both candidate identity and the bound SKU row", () => {
  for (const [targetProtocol, offerProtocol] of [["Zigbee", "Wi-Fi"], ["Wi-Fi", "Zigbee"]]) {
    const candidateConflict = classify1688SupplySnapshot(orderableSnapshot(), {
      candidate: imageCandidate("1", { title: `${offerProtocol} smart switch S1` }),
      targetTitle: `${targetProtocol} smart switch S1`,
      targetVariant: { required: true, attributes: { color: "black" } },
      matchEvidenceKey: MATCH_KEY,
    });
    assert.equal(candidateConflict.reason_code, "image_identity_conflict", JSON.stringify(candidateConflict));
    assert.match(candidateConflict.reason, /explicit_wireless_protocol_conflict/u);

    const rowConflict = classify1688SupplySnapshot(orderableSnapshot({
      quantityInputs: [{
        value: "1", min: "1", disabled: false,
        context_text: `${offerProtocol} version black ￥25.80 库存20件`,
        variant_attributes: { color: "黑色" },
      }],
      structured: {
        minOrderQuantity: 1,
        variants: [{ skuId: "s1-black", color: "黑色", stock: 20, orderable: true, price: 25.8 }],
      },
    }), {
      candidate: imageCandidate("1", { title: `${targetProtocol} smart switch S1` }),
      targetTitle: `${targetProtocol} smart switch S1`,
      targetVariant: { required: true, attributes: { color: "black" } },
      matchEvidenceKey: MATCH_KEY,
    });
    assert.equal(rowConflict.reason_code, "spec_mismatch", JSON.stringify(rowConflict));
    assert.match(rowConflict.reason, new RegExp(`explicit_wireless_protocol_conflict:${targetProtocol.toLowerCase().replace("-", "")}!=${offerProtocol.toLowerCase().replace("-", "")}`, "u"));
  }
});

test("rejects explicit cross-title ecosystem, role, OE, AirPods generation, electrical and transparent-case conflicts", () => {
  const cases = [
    {
      label: "Tuya garage controller versus Cozylife generic switch",
      targetTitle: "WIFI Умное реле, Контроллер гаражных ворот Tuya",
      offerTitle: "cozylife wifi 开关智能开关 app 远程控制 Alexa",
      reason: /explicit_smart_ecosystem_conflict|explicit_product_role_conflict/u,
    },
    {
      label: "Ford OE part numbers",
      targetTitle: "Бачок ГУР Ford Focus II (1420238 30665849)",
      offerTitle: "适用福特 Ford 2012-17 福克斯助力泵油壶 EV613R700A1A 1892564",
      reason: /explicit_automotive_part_number_conflict/u,
    },
    {
      label: "AirPods generations",
      targetTitle: "Белые держатели для AirPods 1-2",
      offerTitle: "适用于苹果 AirPods Pro3代运动耳挂 4代硅胶耳机挂钩",
      reason: /explicit_airpods_generation_conflict/u,
    },
    {
      label: "controller current",
      targetTitle: "Контроллер Kugoo M4 48V 21A",
      offerTitle: "Kugoo M4 48VTF100 48V20A 控制器",
      reason: /explicit_current_conflict:21a!=20a/u,
    },
    {
      label: "Steam Deck replacement rear versus porcelain-white protective case",
      targetTitle: "Прозрачная задняя панель для Steam Deck OLED/LCD",
      offerTitle: "颜色：瓷白 材质：PC 适用于 Steam Deck 保护套一体硬壳带支架",
      reason: /explicit_product_role_conflict|explicit_color_conflict/u,
    },
  ];

  for (const current of cases) {
    const result = classify1688SupplySnapshot(orderableSnapshot(), {
      candidate: imageCandidate("1", { title: current.offerTitle }),
      targetTitle: current.targetTitle,
      targetVariant: { required: false, attributes: {} },
      matchEvidenceKey: MATCH_KEY,
    });
    assert.equal(result.ok, false, `${current.label}: ${JSON.stringify(result)}`);
    assert.equal(result.reason_code, "image_identity_conflict", current.label);
    assert.match(result.reason, current.reason, current.label);
  }
});

test("rejects reversed Type-C/USB direction in candidate titles and selected rows, while missing direction remains soft", () => {
  const targetTitle = "Переходник Type C на USB 3.1 Baseus OTG";
  const reversedTitle = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "Baseus USB公头转Type-C母座 USB3.1 OTG转接头" }),
    targetTitle,
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(reversedTitle.reason_code, "image_identity_conflict", JSON.stringify(reversedTitle));
  assert.match(reversedTitle.reason, /explicit_connector_direction_conflict:type-c>usb-a!=usb-a>type-c/u);

  const reversedRow = classify1688SupplySnapshot(orderableSnapshot({
    quantityInputs: [{
      value: "1", min: "1", disabled: false,
      context_text: "蓝色 USB公头转Type-C母座 支持USB3.1 ￥25.80 库存20件",
      variant_attributes: {},
    }],
  }), {
    candidate: imageCandidate("1", { title: targetTitle }),
    targetTitle,
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });
  assert.equal(reversedRow.reason_code, "spec_mismatch", JSON.stringify(reversedRow));
  assert.match(reversedRow.reason, /explicit_connector_direction_conflict:type-c>usb-a!=usb-a>type-c/u);

  const missingDirection = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "Baseus USB Type-C OTG 转接头" }),
    targetTitle,
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(missingDirection.ok, true, JSON.stringify(missingDirection));
});

test("missing candidate identity fields stay soft even when the target title has an explicit electrical rating", () => {
  const result = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: imageCandidate("1", { title: "Kugoo M4 控制器" }),
    targetTitle: "Контроллер Kugoo M4 48V 21A",
    targetVariant: { required: false, attributes: {} },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("image-primary allows missing textual specifications but still blocks unpriced multi-piece targets", async () => {
  const missingSnapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [{
      value: "0",
      min: "1",
      disabled: false,
      context_text: "四头 GU10 射灯 ￥25.80 库存20件",
      variant_attributes: {},
    }],
    specOptions: [],
  });
  const source = imageCandidate("1");
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => fakePage(missingSnapshot),
    now: () => Date.parse("2026-08-15T10:00:00Z"),
  });
  const accepted = await verifier.verify(verifierInput([source], {
    targetTitle: "X100 黑色四头 GU10 射灯",
  }));
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.deepEqual(accepted.evidence.variant_attributes, {});
  assert.deepEqual(accepted.evidence.variant_differences.map((row) => row.name), ["model", "color", "size"]);

  const bundleSnapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [{
      value: "0",
      min: "1",
      disabled: false,
      context_text: "白色 ARGB 风扇 ￥25.80 库存20件",
      variant_attributes: { color: "白色" },
    }],
    specOptions: [],
  });
  const bundleVerifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(bundleSnapshot) });
  const blocked = await bundleVerifier.verify(verifierInput([
    imageCandidate("1", { title: "白色 ARGB 风扇" }),
  ], {
    targetTitle: "白色 ARGB 风扇 3件套",
    targetVariant: { required: true, attributes: { color: "white", set_quantity: "3" } },
  }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.candidate_failures[0].reason_code, "variant_unbound");
  assert.equal(bundleSnapshot.dom_snapshot.quantity_inputs[0].value, "0");

  const direct = classify1688SupplySnapshot(orderableSnapshot(), {
    candidate: source,
    targetTitle: "X100 黑色射灯 3件套",
    targetVariant: { required: true, attributes: { set_quantity: "3" } },
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });
  assert.equal(direct.reason_code, "image_primary_bundle_unpriced");
});

test("image-primary rejects a selected SKU row that explicitly says 5L/random colors for a green 20L target", async () => {
  const source = imageCandidate("1", {
    title: "加厚汽油桶10l20l30l40升铁油桶汽车越野摩托车备用汽油专用油桶",
  });
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [{
      value: "0",
      min: "1",
      disabled: false,
      context_text: "美式5升油桶(绿红黑随机发货) ¥36.21 库存99632个",
      variant_attributes: { size: "美式5升油桶(绿红黑随机发货)" },
      sku_image_urls: [source.image_match_evidence.image_url],
    }],
    specOptions: [],
    price: 36.21,
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "Канистра Naturehike Outdoor Pe Water Bucket 20L Army Green",
    targetVariant: { required: true, attributes: { color: "green", capacity: "20l" } },
  }));

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.candidate_failures[0].reason_code, "spec_mismatch");
  assert.match(result.candidate_failures[0].reason, /explicit_capacity_conflict:20000ml!=5000ml/u);
  assert.match(result.candidate_failures[0].reason, /explicit_random_color_conflict:green/u);
  assert.equal(result.evidence, undefined);
});

test("explicit 20L capacity binds one compound 1688 size row while conflicting capacity rows stay untouched", async () => {
  const source = imageCandidate("1", {
    title: "美式金属油桶5升10L20L防漏密封车载备用油箱",
  });
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [
      {
        value: "0", min: "1", disabled: false,
        context_text: "美式5升油桶军绿色 ¥36.21 库存99632个",
        variant_attributes: { size: "美式5升油桶军绿色" },
      },
      {
        value: "0", min: "1", disabled: false,
        context_text: "美式20L油桶军绿色 ¥67.00 库存99632个",
        variant_attributes: { size: "美式20L油桶军绿色" },
      },
    ],
    specOptions: [],
    price: 67,
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "Канистра Naturehike Outdoor Pe Water Bucket 20L Army Green",
    targetVariant: { required: true, attributes: { color: "green", capacity: "20l" } },
  }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.target_variant.capacity, "20l");
  assert.equal(result.evidence.variant_attributes.capacity, "20l");
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "1"]);
});

test("explicit 0.4mm nozzle diameter binds one compound 1688 size row and rejects 0.6mm", async () => {
  const source = imageCandidate("1", { title: "Bambu P2S高流量硬化钢喷嘴热端" });
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [
      {
        value: "0", min: "1", disabled: false,
        context_text: "P2S高流量款一体式硬化钢热端0.6mm ¥39.9 库存9988件",
        variant_attributes: { size: "P2S高流量款一体式硬化钢热端0.6mm" },
      },
      {
        value: "0", min: "1", disabled: false,
        context_text: "P2S高流量款一体式硬化钢热端0.4毫米 ¥39.9 库存9988件",
        variant_attributes: { size: "P2S高流量款一体式硬化钢热端0.4毫米" },
      },
    ],
    specOptions: [],
    price: 39.9,
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "Bambu Lab P2S High Flow hardened steel nozzle 0.4 mm",
    targetVariant: { required: true, attributes: { size: "0.4mm" } },
  }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.target_variant.size, "0.4mm");
  assert.equal(result.evidence.variant_attributes.size, "0.4mm");
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "1"]);
});

for (const scenario of [
  {
    sku: "3832280177",
    title: "Блок питания 24V 150W",
    target: { voltage_v: "24v", power_w: "150w" },
    rows: ["超薄电源12V100W", "超薄电源24V150W"],
  },
  {
    sku: "3832171441",
    title: "Блок питания 24V 100W",
    target: { voltage_v: "24v", power_w: "100w" },
    rows: ["超薄电源24V60W", "超薄电源24V100W"],
  },
  {
    sku: "3651845184",
    title: "Зарядное устройство 120W",
    target: { power_w: "120w" },
    rows: ["67W欧规充电器", "120W欧规充电器"],
  },
  {
    sku: "3276330433",
    title: "Блок питания 12V 1A",
    target: { voltage_v: "12v", current_a: "1a" },
    rows: ["12V2A电源适配器", "12V1A电源适配器"],
  },
]) {
  test(`${scenario.sku} binds only the exact explicit electrical compound SKU row`, async () => {
    const source = imageCandidate("1", { title: scenario.title });
    const snapshot = imagePrimaryUnboundSnapshot({
      quantityInputs: scenario.rows.map((label) => ({
        value: "0",
        min: "1",
        disabled: false,
        context_text: `${label} ¥25.80 库存9999件`,
        variant_attributes: { size: label },
      })),
      specOptions: [],
      price: 25.8,
    });
    const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
    const result = await verifier.verify(verifierInput([source], {
      targetTitle: scenario.title,
      targetVariant: { required: true, attributes: scenario.target },
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.evidence.target_variant, scenario.target);
    for (const [name, expected] of Object.entries(scenario.target)) {
      assert.equal(result.evidence.variant_attributes[name], expected);
    }
    assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "1"]);
  });
}

test("explicit electrical conflict on the signed thumbnail row rejects instead of switching to a missing-spec row", async () => {
  const source = imageCandidate("1", { title: "120W 充电器" });
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [
      {
        value: "0", min: "1", disabled: false,
        context_text: "67W欧规充电器 ¥13.1 库存9999件",
        variant_attributes: { size: "67W欧规充电器" },
        sku_image_urls: [source.image_match_evidence.image_url],
      },
      {
        value: "0", min: "1", disabled: false,
        context_text: "快充头 ¥13.1 库存9999件",
        variant_attributes: { size: "快充头" },
      },
    ],
    specOptions: [],
    price: 13.1,
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "Зарядное устройство 120W",
    targetVariant: { required: true, attributes: { power_w: "120w" } },
  }));

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.candidate_failures[0].reason_code, "spec_mismatch");
  assert.match(result.candidate_failures[0].reason, /explicit_power_conflict:120w!=67w/u);
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "0"]);
});

test("an explicit four-digit CCT binds only the equal compound SKU row", async () => {
  const source = imageCandidate("1", { title: "GU10 MR16 7W 2800K LED lamp" });
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: ["GU10 7W 3000K暖白", "GU10 7W 2800K暖白"].map((label) => ({
      value: "0", min: "1", disabled: false,
      context_text: `${label} ¥4.30 库存9999件`,
      variant_attributes: { size: label },
    })),
    specOptions: [],
    price: 4.3,
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "Лампа GU10 MR16 7W 2800К",
    targetVariant: { required: true, attributes: { power_w: "7w", cct_k: "2800k" } },
  }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.evidence.target_variant, { power_w: "7w", cct_k: "2800k" });
  assert.equal(result.evidence.variant_attributes.cct_k, "2800k");
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "1"]);
});

test("CCT in a light-color attribute is rebound without becoming a casing-color dimension", async () => {
  const source = imageCandidate("1", { title: "E14 5W 4500K LED lamp" });
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: ["3000K暖白光", "4500K日光白"].map((label) => ({
      value: "0", min: "1", disabled: false,
      context_text: `${label} E14 5W ¥3.20 库存9999件`,
      variant_attributes: { color: label },
    })),
    specOptions: [],
    price: 3.2,
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "Лампочка E14 5W дневной белый 4500К",
    targetVariant: { required: true, attributes: { power_w: "5w", cct_k: "4500k" } },
  }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.variant_attributes.cct_k, "4500k");
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "1"]);
});

test("equal CCT does not erase a differing black or white casing dimension", async () => {
  const source = imageCandidate("1", { title: "E27 9W 3000K LED lamp" });
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: ["黑色外壳 3000K暖白光", "白色外壳 3000K暖白光"].map((label, index) => ({
      value: "0", min: "1", disabled: false,
      context_text: `${label} E27 9W ¥3.20 库存9999件`,
      variant_attributes: { color: index === 0 ? "黑色" : "白色", size: "E27 9W 3000K" },
    })),
    specOptions: [],
    price: 3.2,
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "E27 9W 3000K LED lamp",
    targetVariant: { required: true, attributes: { power_w: "9w", cct_k: "3000k" } },
  }));

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.candidate_failures[0].reason_code, "variant_unbound");
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "0"]);
});

test("explicit CCT conflict on the signed thumbnail row rejects instead of switching rows", async () => {
  const source = imageCandidate("1", { title: "E27 ST64 LED lamp" });
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [
      {
        value: "0", min: "1", disabled: false,
        context_text: "E27 ST64 9W 4500K日光白 ¥3.10 库存9999件",
        variant_attributes: { size: "E27 ST64 9W 4500K日光白" },
        sku_image_urls: [source.image_match_evidence.image_url],
      },
      {
        value: "0", min: "1", disabled: false,
        context_text: "E27 ST64 9W 暖白光 ¥3.10 库存9999件",
        variant_attributes: { size: "E27 ST64 9W 暖白光" },
      },
    ],
    specOptions: [],
    price: 3.1,
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "E27 ST64 9W 3000K теплый белый свет",
    targetVariant: { required: true, attributes: { cct_k: "3000k" } },
  }));

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.candidate_failures[0].reason_code, "spec_mismatch");
  assert.match(result.candidate_failures[0].reason, /explicit_cct_conflict:3000k!=4500k/u);
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "0"]);
});

test("a signed row with no explicit CCT keeps the Kelvin target soft", async () => {
  const source = imageCandidate("1", { title: "E27 ST64 LED lamp" });
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [{
      value: "0", min: "1", disabled: false,
      context_text: "E27 ST64 9W 暖白光 ¥3.10 库存9999件",
      variant_attributes: { size: "E27 ST64 9W 暖白光" },
      sku_image_urls: [source.image_match_evidence.image_url],
    }],
    specOptions: [],
    price: 3.1,
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "E27 ST64 9W 3000K теплый белый свет",
    targetVariant: { required: true, attributes: { cct_k: "3000k" } },
  }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.evidence.variant_differences, [
    { name: "cct_k", expected: "3000k", observed: null, kind: "unbound_soft" },
  ]);
});

for (const scenario of [
  { expected: "mini-hdmi", selected: 0 },
  { expected: "micro-hdmi", selected: 1 },
]) {
  test(`explicit ${scenario.expected} target binds only its compound connector row`, async () => {
    const source = imageCandidate("1", { title: "8K HDMI 转接头" });
    const snapshot = imagePrimaryUnboundSnapshot({
      quantityInputs: [
        {
          value: "0", min: "1", disabled: false,
          context_text: "C型mini HDMI公转HDMI母 8K60Hz ¥4.06 库存9999件",
          variant_attributes: { size: "C型mini HDMI(M)" },
        },
        {
          value: "0", min: "1", disabled: false,
          context_text: "D型micro HDMI公转HDMI母 8K60Hz ¥4.06 库存9999件",
          variant_attributes: { size: "D型micro HDMI(M)" },
        },
      ],
      specOptions: [],
      price: 4.06,
    });
    const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
    const result = await verifier.verify(verifierInput([source], {
      targetTitle: scenario.expected === "mini-hdmi"
        ? "Переходник HDMI(F) - mini HDMI(M) 2.1 8K/60Hz"
        : "Переходник HDMI(F) - micro HDMI(M) 2.1 8K/60Hz",
      targetVariant: { required: true, attributes: { interface: scenario.expected } },
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.evidence.target_variant.interface, scenario.expected);
    assert.equal(result.evidence.variant_attributes.interface, scenario.expected);
    assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value),
      scenario.selected === 0 ? ["1", "0"] : ["0", "1"]);
  });
}

test("duplicate explicit mini-HDMI rows remain ambiguous and are not mutated", async () => {
  const source = imageCandidate("1", { title: "mini HDMI 转接头" });
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: ["C型mini HDMI直头", "C型mini HDMI弯头"].map((label) => ({
      value: "0", min: "1", disabled: false, context_text: `${label} ¥4.06 库存9999件`, variant_attributes: { size: label },
    })),
    specOptions: [],
    price: 4.06,
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "HDMI(F)-mini HDMI(M)",
    targetVariant: { required: true, attributes: { interface: "mini-hdmi" } },
  }));
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.candidate_failures[0].reason_code, "variant_unbound");
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "0"]);
});

test("signed micro-HDMI thumbnail conflicts with a mini-HDMI target and never switches rows", async () => {
  const source = imageCandidate("1", { title: "HDMI 转接头" });
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [
      {
        value: "0", min: "1", disabled: false,
        context_text: "D型micro HDMI公转HDMI母 ¥4.06 库存9999件",
        variant_attributes: { size: "D型micro HDMI(M)" },
        sku_image_urls: [source.image_match_evidence.image_url],
      },
      {
        value: "0", min: "1", disabled: false,
        context_text: "通用8K转接头 ¥4.06 库存9999件",
        variant_attributes: { size: "通用8K转接头" },
      },
    ],
    specOptions: [],
    price: 4.06,
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "HDMI(F)-mini HDMI(M)",
    targetVariant: { required: true, attributes: { interface: "mini-hdmi" } },
  }));
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.candidate_failures[0].reason_code, "spec_mismatch");
  assert.match(result.candidate_failures[0].reason, /explicit_interface_conflict:mini-hdmi!=micro-hdmi/u);
  assert.deepEqual(snapshot.dom_snapshot.quantity_inputs.map((row) => row.value), ["0", "0"]);
});

test("a signed row with no HDMI subtype keeps the explicit target soft", async () => {
  const source = imageCandidate("1", { title: "8K HDMI 转接头" });
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [{
      value: "0", min: "1", disabled: false,
      context_text: "8K超清转接头 ¥4.06 库存9999件",
      variant_attributes: { size: "8K超清转接头" },
      sku_image_urls: [source.image_match_evidence.image_url],
    }],
    specOptions: [],
    price: 4.06,
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "HDMI(F)-mini HDMI(M)",
    targetVariant: { required: true, attributes: { interface: "mini-hdmi" } },
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.evidence.variant_differences, [
    { name: "interface", expected: "mini-hdmi", observed: null, kind: "unbound_soft" },
  ]);
});

test("image-primary rejects an explicit 0.6mm selected nozzle row for a 0.4mm target title", async () => {
  const source = imageCandidate("1", { title: "Bambu P2S高流量硬化钢喷嘴热端" });
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [
      {
        value: "0",
        min: "1",
        disabled: false,
        context_text: "P2S高流量款一体式硬化钢热端0.6mm(含硅胶套) ¥39.9 库存9988件",
        variant_attributes: { size: "P2S高流量款一体式硬化钢热端0.6mm(含硅胶套)" },
        sku_image_urls: [source.image_match_evidence.image_url],
      },
      {
        value: "0",
        min: "1",
        disabled: false,
        context_text: "P2S普通热端 ¥25.9 库存9988件",
        variant_attributes: { size: "P2S普通热端" },
        sku_image_urls: ["https://cbu01.alicdn.com/img/ibank/other-nozzle.jpg"],
      },
    ],
    specOptions: [],
    price: 39.9,
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "Bambu Lab P2S High Flow hardened steel nozzle 0.4 mm",
    targetVariant: { required: true, attributes: { size: "0.4mm" } },
  }));

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.candidate_failures[0].reason_code, "spec_mismatch");
  assert.match(result.candidate_failures[0].reason, /explicit_mm_conflict:0\.4mm!=0\.6mm/u);
});

test("image-primary keeps an explicit title measurement soft when the selected row has no measurement", async () => {
  const source = imageCandidate("1", { title: "Bambu P2S高流量硬化钢喷嘴热端" });
  const snapshot = imagePrimaryUnboundSnapshot({
    quantityInputs: [
      {
        value: "0",
        min: "1",
        disabled: false,
        context_text: "P2S高流量硬化钢热端 ¥39.9 库存9988件",
        variant_attributes: { size: "P2S高流量硬化钢热端" },
        sku_image_urls: [source.image_match_evidence.image_url],
      },
      {
        value: "0",
        min: "1",
        disabled: false,
        context_text: "P2S普通热端 ¥25.9 库存9988件",
        variant_attributes: { size: "P2S普通热端" },
        sku_image_urls: ["https://cbu01.alicdn.com/img/ibank/other-soft-nozzle.jpg"],
      },
    ],
    specOptions: [],
    price: 39.9,
  });
  const verifier = create1688SupplyVerifier({ pageProvider: async () => fakePage(snapshot) });
  const result = await verifier.verify(verifierInput([source], {
    targetTitle: "Bambu Lab P2S High Flow hardened steel nozzle 0.4 mm",
    targetVariant: { required: true, attributes: { size: "0.4mm" } },
  }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.variant_match_mode, "image_primary");
  assert.equal(result.evidence.selected_variant.selection_method, "image_primary_exact_thumbnail_url");
  assert.deepEqual(result.evidence.variant_differences, [
    { name: "size", expected: "0.4mm", observed: null, kind: "unbound_soft" },
  ]);
});

test("creates a canonical SupplyEvidenceV1 for an exact orderable target SKU", async () => {
  const checkedAt = Date.parse("2026-08-15T10:00:00.000Z");
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => fakePage(orderableSnapshot()),
    now: () => checkedAt,
    sleep: async () => {},
  });
  const result = await verifier.verify(verifierInput([candidate("1")]));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.supply_gate_passed, true);
  assert.deepEqual(result.evidence, {
    contract: SUPPLY_EVIDENCE_CONTRACT,
    passed: true,
    platform: "1688",
    offer_id: "1",
    offer_url: "https://detail.1688.com/offer/1.html",
    target_variant: { model: "x100", color: "black", size: "m" },
    item_level_match: false,
    variant_attributes: { model: "x100", color: "black", size: "m" },
    moq: 1,
    orderable_quantity: 1,
    unit_price: 25.8,
    orderable: true,
    stock_state: "in_stock",
    match_evidence_key: MATCH_KEY,
    match_type: "strong_single",
    status: "verified",
    checked_at: "2026-08-15T10:00:00.000Z",
    valid_until: "2026-08-15T10:30:00.000Z",
  });
});

test("accepts MOQ one from the live 1688 window.context data shape", () => {
  const result = classify1688SupplySnapshot(orderableSnapshot({
    body: "现货",
    structured: {
      result: {
        global: {
          globalData: {
            model: {
              tradeModel: {
                beginAmount: 1,
                canBookedAmount: 611315,
                offerPriceModel: {
                  currentPrices: [{ beginAmount: 1, price: "4.40" }],
                },
              },
            },
          },
        },
      },
    },
    priceTexts: [],
    specOptions: [],
  }), {
    candidate: candidate("1"),
    targetVariant: { required: false, attributes: {} },
    itemLevelMatch: true,
    matchEvidenceKey: MATCH_KEY,
    now: () => Date.parse("2026-08-15T10:00:00Z"),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.moq, 1);
  assert.equal(result.evidence.unit_price, 4.4);
});

test("treats the Taobao login redirect as global 1688 authentication loss", () => {
  const result = classify1688SupplySnapshot(orderableSnapshot({
    url: "https://login.taobao.com/?redirect_url=https%3A%2F%2Fdetail.1688.com%2Foffer%2F1.html",
    body: "密码登录 短信登录",
    structured: {},
    buttons: [],
    quantityInputs: [],
  }), {
    candidate: candidate("1"),
    itemLevelMatch: true,
    matchEvidenceKey: MATCH_KEY,
  });

  assert.equal(result.reason_code, "authentication_required");
  assert.equal(result.global_gate_closed, true);
  assert.equal(result.alert_required, true);
});

test("supports a reusable raw Page and an explicit per-attempt release lease", async () => {
  let rawCloseCalls = 0;
  const rawPage = {
    ...fakePage(orderableSnapshot()),
    close: async () => { rawCloseCalls += 1; },
  };
  const reusable = create1688SupplyVerifier({
    pageProvider: async () => rawPage,
    now: () => Date.parse("2026-08-15T10:00:00Z"),
  });
  assert.equal((await reusable.verify(verifierInput([candidate("1")]))).ok, true);
  await reusable.close();
  assert.equal(rawCloseCalls, 0);

  let releases = 0;
  const leased = create1688SupplyVerifier({
    pageProvider: async () => ({
      page: fakePage(orderableSnapshot()),
      release: () => { releases += 1; },
    }),
    now: () => Date.parse("2026-08-15T10:00:00Z"),
  });
  assert.equal((await leased.verify(verifierInput([candidate("1")]))).ok, true);
  assert.equal(releases, 1);
});

test("selects exact target options, sets quantity one, and builds evidence from the post-interaction snapshot", async () => {
  const operations = [];
  const selected = { color: false, size: false };
  let quantity = "4";
  const page = {
    async goto() { return { status: () => 200 }; },
    async waitForTimeout() {},
    async evaluate(_callback, argument) {
      if (argument?.operation === "select-spec") {
        operations.push(`spec:${argument.specName}:${argument.expectedValue}`);
        if (argument.specName === "color" && argument.expectedValue === "black") selected.color = true;
        if (argument.specName === "size" && argument.expectedValue === "m") selected.size = true;
        return ["color", "size"].includes(argument.specName)
          ? { found: true, group_found: true, clicked: true, selected: true }
          : { found: false, group_found: false, selected: false };
      }
      if (argument?.operation === "set-quantity") {
        operations.push("quantity:1");
        quantity = "1";
        return { found: true, set: true, value: 1, min: 1 };
      }
      return orderableSnapshot({
        structured: {
          model: "X100",
          minOrderQuantity: 1,
          variants: [{
            skuId: "sku-1",
            color: "黑色",
            size: "M",
            stock: selected.color && selected.size ? 8 : 0,
            orderable: selected.color && selected.size,
            price: selected.color && selected.size ? 33.5 : 9.9,
          }],
        },
        specOptions: [
          { group: "颜色", value: "黑色", selected: selected.color },
          { group: "尺寸", value: "M", selected: selected.size },
        ],
        quantityInputs: [{
          value: quantity,
          min: "1",
          disabled: false,
          variant_attributes: { model: "X100", color: "黑色", size: "M" },
        }],
      });
    },
  };
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => page,
    now: () => Date.parse("2026-08-15T10:00:00Z"),
  });
  const result = await verifier.verify(verifierInput([candidate("1")]));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.unit_price, 33.5);
  assert.equal(result.evidence.orderable_quantity, 1);
  assert.deepEqual(operations, ["spec:model:x100", "spec:color:black", "spec:size:m", "quantity:1"]);
  assert.equal(operations.some((entry) => /buy|order|cart|购买|订购|下单/iu.test(entry)), false);
});

test("spec selection never clicks purchase hrefs or form-owned buttons", async () => {
  const run = async ({ tag = "div", href = null, form = null } = {}) => {
    let selected = false;
    let clicks = 0;
    const attributes = new Map([
      ["data-prop-name", "颜色"],
      ["data-value-name", "黑色"],
      ...(href ? [["href", href]] : []),
      ...(tag === "button" ? [["type", "button"]] : []),
    ]);
    const node = {
      className: "sku-option",
      form,
      innerText: "黑色",
      textContent: "黑色",
      parentElement: null,
      getAttribute: (name) => attributes.get(name) ?? null,
      getBoundingClientRect: () => ({ width: 20, height: 20 }),
      matches(selector) {
        if (selector === ":checked" || selector === ":disabled") return false;
        if (selector === "a[href]") return tag === "a" && Boolean(href);
        if (selector === 'button, [role="button"]') return tag === "button";
        if (selector.startsWith('button:not([type])')) return false;
        if (selector.includes("a[href]") && selector.includes("button")) {
          return (tag === "a" && Boolean(href)) || tag === "button";
        }
        return false;
      },
      closest(selector) {
        if (selector === "a[href]") return tag === "a" && href ? node : null;
        if (selector === "form") return form;
        if (selector.includes("a[href]") && selector.includes("button")) {
          return (tag === "a" && href) || tag === "button" ? node : null;
        }
        return null;
      },
      querySelector: () => null,
      click() {
        clicks += 1;
        selected = true;
      },
    };
    node.matches = new Proxy(node.matches, {
      apply(target, thisArg, args) {
        if (args[0] === ":checked") return selected;
        return Reflect.apply(target, thisArg, args);
      },
    });
    const page = {
      async evaluate(callback, argument) {
        const previousDocument = globalThis.document;
        const previousGetComputedStyle = globalThis.getComputedStyle;
        globalThis.document = { querySelectorAll: () => [node] };
        globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
        try {
          return callback(argument);
        } finally {
          if (previousDocument === undefined) delete globalThis.document;
          else globalThis.document = previousDocument;
          if (previousGetComputedStyle === undefined) delete globalThis.getComputedStyle;
          else globalThis.getComputedStyle = previousGetComputedStyle;
        }
      },
    };
    return { result: await selectExactSpecOption(page, "color", "black"), clicks };
  };

  const purchaseLink = await run({ tag: "a", href: "https://cart.1688.com/cart/add" });
  const formOwner = { getAttribute: () => "/offer/sku/select" };
  const formButton = await run({ tag: "button", form: formOwner });
  const ordinaryOption = await run();

  assert.equal(purchaseLink.result.found, false);
  assert.equal(purchaseLink.clicks, 0);
  assert.equal(formButton.result.found, false);
  assert.equal(formButton.clicks, 0);
  assert.equal(ordinaryOption.result.found, true);
  assert.equal(ordinaryOption.result.selected, true);
  assert.equal(ordinaryOption.clicks, 1);
});

test("fails closed when a clicked target option is not selected in the post-interaction snapshot", async () => {
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => fakePage(orderableSnapshot({
      specOptions: [
        { group: "颜色", value: "黑色", selected: false },
        { group: "尺寸", value: "M", selected: true },
      ],
    })),
  });
  const result = await verifier.verify(verifierInput([candidate("1")]));
  assert.equal(result.ok, false);
  assert.equal(result.candidate_failures[0].reason_code, "variant_unbound");
});

test("fails closed when quantity one cannot be written and read back", async () => {
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => fakePage(orderableSnapshot({ quantityInputs: [] })),
  });
  const result = await verifier.verify(verifierInput([candidate("1")]));
  assert.equal(result.ok, false);
  assert.equal(result.candidate_failures[0].reason_code, "quantity_unconfirmed");
});

test("uses the conservative maximum when explicit MOQ evidence conflicts", () => {
  const result = classify1688SupplySnapshot(orderableSnapshot({
    body: "1件起批 ￥25.80",
    structured: {
      model: "X100",
      minOrderQuantity: 2,
      variants: [{ skuId: "sku-1", color: "黑色", size: "M", stock: 4, orderable: true, price: 25.8 }],
    },
    quantityInputs: [{
      value: "1",
      min: "1",
      disabled: false,
      variant_attributes: { model: "X100", color: "黑色", size: "M" },
    }],
  }), {
    candidate: candidate("1"),
    targetVariant: { required: true, attributes: { model: "X100", color: "黑色", size: "M" } },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(result.reason_code, "moq_above_one");
});

test("price-tier beginAmount values use only the first tier as MOQ, not the maximum tier", () => {
  const result = classify1688SupplySnapshot(orderableSnapshot({
    body: "现货",
    structured: {
      tradeModel: {
        beginAmount: 1,
        canBookedAmount: 999,
        offerPriceModel: {
          currentPrices: [
            { beginAmount: 1, price: "20.99" },
            { beginAmount: 10, price: "18.00" },
            { beginAmount: 100, price: "15.00" },
          ],
        },
      },
    },
    priceTexts: [],
    specOptions: [],
  }), {
    candidate: candidate("1"),
    targetVariant: { required: false, attributes: {} },
    itemLevelMatch: true,
    matchEvidenceKey: MATCH_KEY,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.moq, 1);
  assert.equal(result.evidence.unit_price, 20.99);
});

test("image-primary inventory and orderability are bound to the selected row SKU, never another in-stock variant", () => {
  const snapshot = orderableSnapshot({
    structured: {
      minOrderQuantity: 1,
      variants: [
        { skuId: "sku-black", color: "黑色", stock: 0, orderable: false, price: 15 },
        { skuId: "sku-white", color: "白色", stock: 88, orderable: true, price: 16 },
      ],
    },
    specOptions: [{ group: "颜色", value: "黑色", selected: true }],
    quantityInputs: [{
      value: "1",
      min: "1",
      disabled: false,
      row_key: "sku:sku-black",
      sku_ids: ["sku-black"],
      row_price_text: "￥15",
      variant_attributes: { color: "黑色" },
    }],
    interaction: {
      specs: { color: { found: true, group_found: true, selected: true } },
      quantity: {
        found: true, set: true, value: 1, matched_rows: 1,
        row_key: "sku:sku-black", sku_ids: ["sku-black"],
        variant_attributes: { color: "black" },
        selection_method: "image_primary_best_target_overlap",
      },
    },
  });
  const result = classify1688SupplySnapshot(snapshot, {
    candidate: imageCandidate("1"),
    targetTitle: "X100 黑色射灯",
    targetVariant: { required: true, attributes: { color: "black" } },
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });

  assert.equal(result.reason_code, "variant_unavailable", JSON.stringify(result));
});

test("image-primary uses the selected OD row second price span as row-bound stock", () => {
  const classifyStock = (stockCount) => classify1688SupplySnapshot(orderableSnapshot({
    structured: { minOrderQuantity: 1 },
    specOptions: [{ group: "颜色", value: "黑色", selected: true }],
    priceTexts: ["￥15.00", "￥20.99"],
    quantityInputs: [{
      value: "1",
      min: "1",
      disabled: false,
      row_key: "sku:unmapped-black",
      sku_ids: ["unmapped-black"],
      context_text: `黑色 ￥15${stockCount}`,
      row_price_text: "￥15",
      stock_count: stockCount,
      variant_attributes: { color: "黑色" },
    }],
    interaction: {
      specs: { color: { found: true, group_found: true, selected: true } },
      quantity: {
        found: true, set: true, value: 1, matched_rows: 1,
        row_key: "sku:unmapped-black", sku_ids: ["unmapped-black"],
        variant_attributes: { color: "black" },
        selection_method: "image_primary_best_target_overlap",
      },
    },
  }), {
    candidate: imageCandidate("1"),
    targetTitle: "X100 黑色射灯",
    targetVariant: { required: true, attributes: { color: "black" } },
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });

  const inStock = classifyStock(83_998);
  assert.equal(inStock.ok, true, JSON.stringify(inStock));
  assert.equal(inStock.evidence.unit_price, 15);
  const empty = classifyStock(0);
  assert.equal(empty.reason_code, "out_of_stock", JSON.stringify(empty));
});

test("image-primary fails closed when selected-row stock cannot be bound or read", () => {
  const result = classify1688SupplySnapshot(orderableSnapshot({
    structured: {
      minOrderQuantity: 1,
      variants: [{ skuId: "different-sku", color: "白色", stock: 99, orderable: true, price: 16 }],
    },
    specOptions: [{ group: "颜色", value: "黑色", selected: true }],
    quantityInputs: [{
      value: "1", min: "1", disabled: false,
      row_key: "sku:selected-black", sku_ids: ["selected-black"],
      row_price_text: "￥15", context_text: "黑色",
      variant_attributes: { color: "黑色" },
    }],
    interaction: {
      specs: { color: { found: true, group_found: true, selected: true } },
      quantity: {
        found: true, set: true, value: 1, matched_rows: 1,
        row_key: "sku:selected-black", sku_ids: ["selected-black"],
        variant_attributes: { color: "black" },
        selection_method: "image_primary_best_target_overlap",
      },
    },
  }), {
    candidate: imageCandidate("1"),
    targetTitle: "X100 黑色射灯",
    targetVariant: { required: true, attributes: { color: "black" } },
    matchEvidenceKey: MATCH_KEY,
    variantMatchMode: "image_primary",
  });

  assert.equal(result.reason_code, "stock_unconfirmed", JSON.stringify(result));
});

test("uses item-level binding only when there is no explicit target specification", async () => {
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => fakePage(orderableSnapshot({
      structured: { minOrderQuantity: 1, stock: 9, orderable: true, price: 8.5 },
      specOptions: [],
    })),
    now: () => Date.parse("2026-08-15T10:00:00Z"),
  });
  const result = await verifier.verify(verifierInput([candidate("1")], {
    targetVariant: { required: false, attributes: {} },
    itemLevelMatch: true,
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.item_level_match, true);
  assert.equal(result.evidence.target_variant, null);
  assert.deepEqual(result.evidence.variant_attributes, {});
});

test("blocks item-level evidence when the live offer exposes multiple unbound SKU rows", () => {
  const result = classify1688SupplySnapshot(orderableSnapshot({
    structured: { minOrderQuantity: 1 },
    specOptions: [],
    quantityInputs: [
      { value: "1", min: "1", disabled: false, context_text: "黑色 ￥15.30 库存10个" },
      { value: "0", min: "1", disabled: false, context_text: "白色 ￥15.30 库存10个" },
    ],
  }), {
    candidate: candidate("1"),
    targetVariant: { required: false, attributes: {} },
    itemLevelMatch: true,
    matchEvidenceKey: MATCH_KEY,
  });

  assert.equal(result.reason_code, "variant_unbound");
});

test("blocks item-level evidence when window.context has multiple SKU variants behind one visible row", () => {
  const result = classify1688SupplySnapshot(orderableSnapshot({
    structured: {
      minOrderQuantity: 1,
      skuMap: [
        { skuId: 1, specAttrs: "A款-18W", price: 18, canBookCount: 10 },
        { skuId: 2, specAttrs: "B款-12W", price: 12, canBookCount: 10 },
      ],
    },
    specOptions: [],
    quantityInputs: [{ value: "1", disabled: false, context_text: "暖光 ￥18 库存10只" }],
  }), {
    candidate: candidate("1"),
    targetVariant: { required: false, attributes: {} },
    itemLevelMatch: true,
    matchEvidenceKey: MATCH_KEY,
  });

  assert.equal(result.reason_code, "variant_unbound");
});

test("uses the confirmed SKU row price instead of unrelated higher page prices", () => {
  const result = classify1688SupplySnapshot(orderableSnapshot({
    body: "现货 起批量 1件 ￥999.00",
    structured: { minOrderQuantity: 1 },
    specOptions: [],
    priceTexts: ["￥999.00"],
    quantityInputs: [{
      value: "1",
      min: "1",
      disabled: false,
      context_text: "单一规格 ￥15.30 库存10个",
    }],
  }), {
    candidate: candidate("1"),
    targetVariant: { required: false, attributes: {} },
    itemLevelMatch: true,
    matchEvidenceKey: MATCH_KEY,
    now: () => Date.parse("2026-08-15T10:00:00Z"),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.unit_price, 15.3);
});

test("reads the real OD first price span and never concatenates the second inventory span", () => {
  const result = classify1688SupplySnapshot(orderableSnapshot({
    body: "现货 1件起批",
    structured: { minOrderQuantity: 1 },
    specOptions: [],
    priceTexts: ["￥ 15 .00", "￥ 20 .99"],
    quantityInputs: [{
      value: "1",
      min: "1",
      disabled: false,
      context_text: "银灰色 ￥1583998",
      row_price_text: "￥15",
      row_price_source: "gyp-pro-table-price:first-span",
      stock_count: 83_998,
    }],
  }), {
    candidate: candidate("1"),
    targetVariant: { required: false, attributes: {} },
    itemLevelMatch: true,
    matchEvidenceKey: MATCH_KEY,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.unit_price, 15);
  assert.notEqual(result.evidence.unit_price, 1_583_998);
});

test("malformed concatenated OD row price falls back to scoped main price and otherwise fails closed", () => {
  const base = {
    body: "现货 1件起批",
    structured: { minOrderQuantity: 1 },
    specOptions: [],
    quantityInputs: [{
      value: "1",
      min: "1",
      disabled: false,
      context_text: "银灰色 ￥1688820",
      stock_count: 88_820,
    }],
  };
  const withMain = classify1688SupplySnapshot(orderableSnapshot({
    ...base,
    priceTexts: ["￥ 15 .00", "￥ 20 .99"],
  }), {
    candidate: candidate("1"),
    targetVariant: { required: false, attributes: {} },
    itemLevelMatch: true,
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(withMain.ok, true, JSON.stringify(withMain));
  assert.equal(withMain.evidence.unit_price, 20.99);

  const withoutMain = classify1688SupplySnapshot(orderableSnapshot({
    ...base,
    priceTexts: [],
  }), {
    candidate: candidate("1"),
    targetVariant: { required: false, attributes: {} },
    itemLevelMatch: true,
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(withoutMain.reason_code, "price_unconfirmed", JSON.stringify(withoutMain));
});

test("a deterministic specification mismatch immediately tries the next strict offer", async () => {
  const opened = [];
  const candidates = [candidate("1", "corroborated_multi"), candidate("2", "corroborated_multi")];
  const verifier = create1688SupplyVerifier({
    pageProvider: async ({ candidate: current }) => {
      opened.push(current.offer_id);
      const color = current.offer_id === "1" ? "白色" : "黑色";
      return fakePage(orderableSnapshot({
        url: current.offer_url,
        structured: {
          model: "X100",
          minOrderQuantity: 1,
          variants: [{ skuId: `sku-${current.offer_id}`, color, size: "M", stock: 2, orderable: true, price: 20 }],
        },
        specOptions: [
          { group: "颜色", value: color, selected: true },
          { group: "尺寸", value: "M", selected: true },
        ],
      }));
    },
    now: () => Date.parse("2026-08-15T10:00:00Z"),
    sleep: async () => { throw new Error("deterministic failure must not sleep"); },
  });
  const result = await verifier.verify(verifierInput(candidates));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.offer_id, "2");
  assert.deepEqual(opened, ["1", "2"]);
  assert.equal(result.candidate_failures[0].reason_code, "spec_mismatch");
});

test("blocks an explicit variant that cannot be bound to any 1688 SKU or option", () => {
  const result = classify1688SupplySnapshot(orderableSnapshot({
    structured: { minOrderQuantity: 1, stock: 10, orderable: true, price: 12 },
    specOptions: [],
  }), {
    candidate: candidate("1"),
    targetVariant: { required: true, attributes: { capacity: "1 TB" } },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, "variant_unbound");
  assert.equal(result.deterministic, true);
});

test("rejects model, color, size, capacity, set-count and interface conflicts", () => {
  const observed = {
    model: "X100",
    color: "黑色",
    size: "M",
    capacity: "500 ml",
    set_quantity: "2件套",
    interface: "Type-C",
    minOrderQuantity: 1,
    stock: 5,
    orderable: true,
    price: 20,
  };
  const conflicts = {
    model: "X200",
    color: "白色",
    size: "L",
    capacity: "1 L",
    set_quantity: "3件套",
    interface: "Lightning",
  };
  for (const [name, value] of Object.entries(conflicts)) {
    const result = classify1688SupplySnapshot(orderableSnapshot({
      structured: observed,
      specOptions: [],
    }), {
      candidate: candidate("1"),
      targetVariant: { required: true, attributes: { [name]: value } },
      matchEvidenceKey: MATCH_KEY,
    });
    assert.equal(result.reason_code, "spec_mismatch", `${name}: ${JSON.stringify(result)}`);
  }
});

test("classifies disabled target options, MOQ above one, stock-out and offline offers", () => {
  const cases = [
    [orderableSnapshot({
      specOptions: [
        { group: "颜色", value: "黑色", disabled: true },
        { group: "尺寸", value: "M" },
      ],
    }), "variant_unavailable"],
    [orderableSnapshot({ body: "起批量 2件 ￥25.80", structured: { minOrderQuantity: 2, price: 25.8, stock: 5, orderable: true } }), "moq_above_one"],
    [orderableSnapshot({
      body: "库存不足 起批量 1件 ￥25.80",
      structured: {
        model: "X100",
        minOrderQuantity: 1,
        variants: [{ skuId: "sku-1", color: "黑色", size: "M", stock: 0, orderable: false, price: 25.8 }],
      },
    }), "variant_unavailable"],
    [{
      url: "https://detail.1688.com/offer/1.html",
      title: "商品已下架",
      body: "商品不存在",
      http_status: 404,
    }, "offer_offline"],
  ];
  for (const [snapshot, reasonCode] of cases) {
    const result = classify1688SupplySnapshot(snapshot, {
      candidate: candidate("1"),
      targetVariant: { required: true, attributes: { model: "X100", color: "黑色", size: "M" } },
      matchEvidenceKey: MATCH_KEY,
    });
    assert.equal(result.reason_code, reasonCode, JSON.stringify(result));
  }

  const moq = classify1688SupplySnapshot(orderableSnapshot({
    body: "起批量 2件 ￥25.80",
    structured: {
      model: "X100",
      minOrderQuantity: 2,
      variants: [{ skuId: "sku-1", color: "黑色", size: "M", stock: 3, orderable: true, price: 25.8 }],
    },
  }), {
    candidate: candidate("1"),
    targetVariant: { required: true, attributes: { model: "X100", color: "黑色", size: "M" } },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(moq.reason_code, "moq_above_one");
});

test("requires a positive one-piece price and an active purchase signal", () => {
  const noPrice = classify1688SupplySnapshot(orderableSnapshot({
    body: "现货 起批量 1件",
    priceTexts: [],
    structured: {
      model: "X100",
      minOrderQuantity: 1,
      variants: [{ skuId: "sku-1", color: "黑色", size: "M", stock: 3, orderable: true }],
    },
  }), {
    candidate: candidate("1"),
    targetVariant: { required: true, attributes: { model: "X100", color: "黑色", size: "M" } },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(noPrice.reason_code, "price_unconfirmed");

  const disabled = classify1688SupplySnapshot(orderableSnapshot({
    buttons: [{ text: "立即订购", disabled: true }],
    structured: {
      model: "X100",
      minOrderQuantity: 1,
      variants: [{ skuId: "sku-1", color: "黑色", size: "M", stock: 3, price: 25.8 }],
    },
  }), {
    candidate: candidate("1"),
    targetVariant: { required: true, attributes: { model: "X100", color: "黑色", size: "M" } },
    matchEvidenceKey: MATCH_KEY,
  });
  assert.equal(disabled.reason_code, "not_orderable");
});

test("CAPTCHA retries the same offer three times at one-minute and ten-minute intervals", async () => {
  let attempts = 0;
  const waits = [];
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => {
      attempts += 1;
      return fakePage({
        url: "https://detail.1688.com/offer/1.html",
        title: "安全验证",
        body: "请拖动滑块完成验证码",
        http_status: 200,
      });
    },
    sleep: async (ms) => { waits.push(ms); },
  });
  const result = await verifier.verify(verifierInput([candidate("1")]));
  assert.equal(result.ok, false);
  assert.equal(result.status, "deferred");
  assert.equal(result.reason_code, "captcha");
  assert.equal(result.retryable, true);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [60_000, 600_000]);
});

test("expired login safely closes the global supply gate after bounded retries", async () => {
  let attempts = 0;
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => {
      attempts += 1;
      return fakePage({
        url: "https://login.1688.com/member/signin.htm",
        title: "会员登录",
        body: "登录已失效，请重新登录",
        http_status: 200,
      });
    },
    sleep: async () => {},
  });
  const result = await verifier.verify(verifierInput([candidate("1")]));
  assert.equal(attempts, 3);
  assert.equal(result.reason_code, "authentication_required");
  assert.equal(result.global_gate_closed, true);
  assert.equal(result.alert_required, true);
});

test("navigation timeouts are transient and retry three times", async () => {
  let attempts = 0;
  const waits = [];
  const timeout = Object.assign(new Error("page.goto timed out after 45000ms"), { code: "ETIMEDOUT" });
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => {
      attempts += 1;
      return fakePage(null, { gotoError: timeout });
    },
    sleep: async (ms) => { waits.push(ms); },
  });
  const result = await verifier.verify(verifierInput([candidate("1")]));
  assert.equal(result.reason_code, "timeout");
  assert.equal(result.retryable, true);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [60_000, 600_000]);
});

test("success cache is reused before 30 minutes and rechecked at expiry", async () => {
  let current = Date.parse("2026-08-15T10:00:00Z");
  let pages = 0;
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => {
      pages += 1;
      return fakePage(orderableSnapshot());
    },
    now: () => current,
  });
  const input = verifierInput([candidate("1")]);
  const first = await verifier.verify(input);
  assert.equal(first.cached, false);
  current += 29 * 60 * 1000;
  const cached = await verifier.verify(input);
  assert.equal(cached.cached, true);
  assert.equal(pages, 1);
  current += 60 * 1000;
  const refreshed = await verifier.verify(input);
  assert.equal(refreshed.cached, false);
  assert.equal(pages, 2);
  assert.equal(refreshed.evidence.checked_at, "2026-08-15T10:30:00.000Z");
});

test("forced submission recheck bypasses the success cache and captures a changed live price", async () => {
  let pages = 0;
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => {
      pages += 1;
      return fakePage(orderableSnapshot({
        structured: {
          model: "X100",
          minOrderQuantity: 1,
          variants: [{
            skuId: "sku-1",
            color: "黑色",
            size: "M",
            stock: 3,
            orderable: true,
            price: pages === 1 ? 25.8 : 31.5,
          }],
        },
      }));
    },
    now: () => Date.parse("2026-08-15T10:00:00Z"),
  });
  const input = verifierInput([candidate("1")]);
  assert.equal((await verifier.verify(input)).evidence.unit_price, 25.8);
  assert.equal((await verifier.verify({ ...input, force: true })).evidence.unit_price, 31.5);
  assert.equal(pages, 2);
});

test("deterministic failures are cached only briefly and never permanently block an offer", async () => {
  let current = Date.parse("2026-08-15T10:00:00Z");
  let pages = 0;
  const verifier = create1688SupplyVerifier({
    pageProvider: async () => {
      pages += 1;
      return fakePage(pages === 1 ? {
        url: "https://detail.1688.com/offer/1.html",
        title: "商品已下架",
        body: "商品不存在",
        http_status: 404,
      } : orderableSnapshot());
    },
    now: () => current,
    failureCacheMs: 60_000,
  });
  const input = verifierInput([candidate("1")]);
  assert.equal((await verifier.verify(input)).reason_code, "all_candidates_failed");
  current += 30_000;
  assert.equal((await verifier.verify(input)).reason_code, "all_candidates_failed");
  assert.equal(pages, 1);
  current += 30_001;
  assert.equal((await verifier.verify(input)).ok, true);
  assert.equal(pages, 2);
});

test("freshness uses a strict 30-minute validity window", () => {
  const evidence = {
    contract: SUPPLY_EVIDENCE_CONTRACT,
    passed: true,
    platform: "1688",
    checked_at: "2026-08-15T10:00:00.000Z",
    valid_until: "2026-08-15T10:30:00.000Z",
  };
  assert.equal(isFreshSupplyEvidence(evidence, { now: () => Date.parse("2026-08-15T10:29:59.999Z") }), true);
  assert.equal(isFreshSupplyEvidence(evidence, { now: () => Date.parse("2026-08-15T10:30:00.000Z") }), false);
  assert.equal(isFreshSupplyEvidence({
    ...evidence,
    valid_until: "2026-08-15T10:30:00.001Z",
  }, { now: () => Date.parse("2026-08-15T10:01:00Z") }), false);
});

test("only strict matches are inspected and no more than three offers are opened", async () => {
  let opened = 0;
  const verifier = create1688SupplyVerifier({
    pageProvider: async ({ candidate: current }) => {
      opened += 1;
      return fakePage({
        url: current.offer_url,
        title: "商品已下架",
        body: "商品不存在",
        http_status: 404,
      });
    },
    failureCacheMs: 0,
  });
  const candidates = [1, 2, 3, 4].map((id) => candidate(id, "corroborated_multi"));
  const result = await verifier.verify(verifierInput(candidates));
  assert.equal(result.reason_code, "all_candidates_failed");
  assert.equal(opened, 3);

  let shadowOpened = 0;
  const shadow = create1688SupplyVerifier({
    pageProvider: async () => { shadowOpened += 1; return fakePage(orderableSnapshot()); },
  });
  const rejected = await shadow.verify(verifierInput([{ ...candidate("1"), match_type: "shadow" }], {
    balancedMatch: { passed: true, match_type: "shadow", supporting_offer_ids: ["1"] },
  }));
  assert.equal(rejected.reason_code, "strict_match_required");
  assert.equal(shadowOpened, 0);

  const invalidOffer = await shadow.verify(verifierInput([candidate("not-a-1688-id")], {
    balancedMatch: {
      passed: true,
      match_type: "strong_single",
      supporting_offer_ids: ["not-a-1688-id"],
    },
  }));
  assert.equal(invalidOffer.reason_code, "strict_match_required");
  assert.equal(shadowOpened, 0);
});
