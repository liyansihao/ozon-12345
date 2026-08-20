import {
  corroboratedSupportingModelConflict,
  declaredTargetIdentityBindingConflicts,
  explicitLeadingBrandToken,
  stylusProductAccessoryRole,
} from "./cost-evidence.mjs";

const STRICT_MATCH_TYPES = new Set(["strong_single", "corroborated_multi"]);
const IMAGE_PRIMARY_SEMANTIC_STRENGTHS = new Set([
  "exact_model",
  "two_high_information_terms",
  "one_high_information_term",
  "one_high_information_plus_product",
  "product_semantics",
  "image_backed",
]);

export const IMAGE_PRIMARY_MATCH_BASIS = "image_primary_v1";
export const IMAGE_PRIMARY_EXACT_THUMBNAIL_SELECTION_METHOD = "image_primary_exact_thumbnail_url";

// The current 1688 detail page also renders quantity as a text input nested in
// Fusion/OD number-picker controls.  Keep the fallback scoped to explicit
// quantity/amount/counter containers; a generic text input must never become
// procurement quantity evidence.
export const QUANTITY_INPUT_SELECTORS = Object.freeze([
  'input[type="number"]',
  'input[class*="amount" i]',
  'input[class*="quantity" i]',
  'input[class*="count" i]',
  'input[data-testid*="quantity" i]',
  'input[aria-label*="数量"]',
  'input[placeholder*="数量"]',
  'input[name*="quantity" i]',
  'input[name*="amount" i]',
  'input[role="spinbutton"]',
  'input[class*="input-number" i]',
  '[class*="number-picker" i] input:not([type="hidden"])',
  '[class*="numberpicker" i] input:not([type="hidden"])',
  '[class*="quantity" i] input:not([type="hidden"])',
  '[class*="amount" i] input:not([type="hidden"])',
  '[class*="counter" i] input:not([type="hidden"])',
  '[class*="stepper" i] input:not([type="hidden"])',
  '[data-testid*="quantity" i] input:not([type="hidden"])',
]);

export const SUPPLY_EVIDENCE_CONTRACT = "1688-orderable-v1";
export const SUPPLY_EVIDENCE_TTL_MS = 30 * 60 * 1000;
export const SUPPLY_RETRY_DELAYS_MS = Object.freeze([60_000, 600_000]);

function finiteUnitScore(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function safeHttpImageUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Returns the exact Alibaba CDN asset identity used for SKU-thumbnail binding.
 * Alibaba appends `_sum.jpg` to a source image path for its small thumbnail;
 * that one documented transform (plus non-identity query/fragment data) is the
 * only non-exact form accepted here. Other hosts and other filename variants
 * retain their full URL, so this cannot degrade into fuzzy path matching.
 */
export function canonicalAlibabaImageAssetUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (parsed.protocol !== "https:" || !parsed.hostname) return null;
    const hostname = parsed.hostname.toLocaleLowerCase("und");
    const alibabaCdn = hostname === "alicdn.com" || hostname.endsWith(".alicdn.com");
    if (alibabaCdn) {
      parsed.search = "";
      parsed.hash = "";
      if (parsed.pathname.endsWith("_sum.jpg")) {
        parsed.pathname = parsed.pathname.slice(0, -"_sum.jpg".length);
      }
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Validates the signed, per-offer visual proof before it can relax exact SKU
 * text binding. This never turns a plain match_type into image evidence.
 */
export function assessImagePrimaryCandidate(candidate = {}) {
  const evidence = candidate?.image_match_evidence;
  const image = evidence?.image;
  const offerId = String(candidate?.offer_id || "").trim();
  const corroboratingOfferIds = Array.isArray(evidence?.corroborating_offer_ids)
    ? [...new Set(evidence.corroborating_offer_ids.map((value) => String(value || "").trim()).filter((value) => /^\d+$/u.test(value)))]
    : [];
  const score = finiteUnitScore(image?.score);
  const colorScore = finiteUnitScore(image?.color_score);
  const dhashScore = finiteUnitScore(image?.dhash_score);
  let reason = null;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) reason = "missing-image-evidence";
  else if (evidence.source_contract !== "1688-returned-same-item-v3") reason = "image-contract";
  else if (!offerId || String(evidence.offer_id || "").trim() !== offerId) reason = "image-offer-binding";
  else if (!safeHttpImageUrl(evidence.image_url)) reason = "image-url";
  else if (image?.available !== true || score === null || colorScore === null || dhashScore === null) reason = "image-scores";
  else if (!IMAGE_PRIMARY_SEMANTIC_STRENGTHS.has(String(evidence.semantic_strength || ""))) reason = "image-semantics";
  else if (!Array.isArray(evidence.spec_conflicts) || evidence.spec_conflicts.length > 0) reason = "image-spec-conflict";
  else if (Object.hasOwn(evidence, "identity_conflicts")
    && (!Array.isArray(evidence.identity_conflicts) || evidence.identity_conflicts.length > 0)) reason = "image-identity-conflict";
  else if (evidence.accessory_conflict !== false) reason = "image-accessory-conflict";
  if (reason) return { ok: false, reason };

  let lane = null;
  const imageTextSoft = String(evidence.semantic_strength || "") === "image_backed";
  if (imageTextSoft
    && Object.hasOwn(evidence, "identity_conflicts")
    && Array.isArray(evidence.identity_conflicts)
    && evidence.identity_conflicts.length === 0
    && score >= 0.90
    && dhashScore >= 0.82
    && colorScore >= 0.90) {
    lane = "strong_visual_text_soft";
  } else if (!imageTextSoft && score >= 0.68 && dhashScore >= 0.55 && colorScore >= 0.90) {
    lane = "strong_visual";
  } else if (
    candidate?.match_type === "corroborated_multi"
    && corroboratingOfferIds.length >= 2
    && corroboratingOfferIds.includes(offerId)
    && score >= 0.60
    && dhashScore >= 0.46
    && colorScore >= 0.82
  ) {
    lane = "corroborated_visual";
  }
  if (!lane) return { ok: false, reason: "image-threshold" };
  return {
    ok: true,
    lane,
    evidence: {
      ...evidence,
      lane,
      corroborating_offer_ids: corroboratingOfferIds,
      image: { available: true, score, color_score: colorScore, dhash_score: dhashScore },
    },
  };
}

const SPEC_ALIASES = Object.freeze({
  model: /^(?:model|model_name|модель|型号|款号)$/iu,
  article: /^(?:article|articul|артикул|货号|商品编号)$/iu,
  color: /^(?:colou?r|цвет|颜色|色号|颜色分类)$/iu,
  size: /^(?:size|размер|尺寸|尺码|规格)$/iu,
  capacity: /^(?:capacity|volume|объ[её]м|емкость|容量|容积|内存)$/iu,
  voltage_v: /^(?:voltage|voltage_v|напряжение|电压)$/iu,
  current_a: /^(?:current|current_a|amperage|ток|сила_тока|电流)$/iu,
  power_w: /^(?:power|power_w|wattage|мощность|功率)$/iu,
  wireless_protocol: /^(?:wireless_?protocol|protocol|wireless|communication_?protocol|连接方式|通信协议|无线协议|协议)$/iu,
  cct_k: /^(?:cct|cct_k|colou?r_?temperature|цветовая_?температура|температура_?света|色温)$/iu,
  set_quantity: /^(?:set_?quantity|set_?count|pack_?count|package_?quantity|quantity|count|количество|комплект|套装数量|件数|数量)$/iu,
  head_count: /^(?:head_?count|heads?|lamp_?heads?|light_?heads?|shade_?count|plafond_?count|количество_?плафонов|灯头数量|灯头数|头数|灯数|罩数)$/iu,
  shape: /^(?:shape|form|форма|形状|外形)$/iu,
  interface: /^(?:interface|connector|port|интерфейс|разъ[её]м|接口)$/iu,
});

const TRANSIENT_CODES = new Set([
  "ABORT_ERR", "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
  "ENETUNREACH", "ENOTFOUND", "EPIPE", "ETIMEDOUT", "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
]);

const PRICE_KEYS = new Set([
  "price", "saleprice", "offerprice", "unitprice", "skuprice", "discountprice",
  "currentprice", "pricevalue",
]);
const MOQ_KEYS = new Set([
  "moq", "minorder", "minorderquantity", "minimumorderquantity", "minpurchasequantity",
  "minquantity",
]);
const STOCK_KEYS = new Set([
  "stock", "stockcount", "inventory", "inventorycount", "canbookcount", "amountonsale",
  "availablequantity", "sellablestock",
]);
const ORDERABLE_KEYS = new Set(["orderable", "buyable", "canbuy", "canorder", "purchasable"]);
const VARIANT_CONTAINER_KEYS = new Set([
  "variants", "skus", "skulist", "skus", "skudata", "productskus", "skuinfos",
  "productskuinfos", "skuitems", "skumap",
]);

function text(value) {
  if (value === null || value === undefined) return "";
  return String(value).normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function keyText(value) {
  return text(value).toLocaleLowerCase("und").replace(/[\s_.:\-/]+/gu, "");
}

function canonicalSpecName(value) {
  const normalized = text(value).toLocaleLowerCase("und").replace(/[\s-]+/gu, "_");
  if (!normalized) return null;
  return Object.entries(SPEC_ALIASES).find(([, pattern]) => pattern.test(normalized))?.[0] || null;
}

const ROSE_GOLD_COLOR_PATTERN = /玫瑰金|(?:^|[^\p{L}\p{N}])rose[\s-]*gold(?=$|[^\p{L}\p{N}])|розов\p{L}*[\s-]+золот\p{L}*/iu;

const SUPPLY_COLOR_PATTERNS = Object.freeze([
  ["black", /黑色|(?:^|[^\p{L}\p{N}])(?:black|черн(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
  ["white", /(?:白色|瓷白)|(?:^|[^\p{L}\p{N}])(?:white|бел(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
  ["gray", /灰色|(?:^|[^\p{L}\p{N}])(?:gr[ae]y|сер(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
  ["red", /红色|(?:^|[^\p{L}\p{N}])(?:red|красн(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
  ["blue", /蓝色|(?:^|[^\p{L}\p{N}])(?:blue|син(?:ий|яя|ее|ие|его|юю|ем))(?=$|[^\p{L}\p{N}])/iu],
  ["green", /(?:荧光绿|绿色|绿(?=高韧|PETG|PLA|TPU|ABS|耗材|线材|款|版|壳|套|$))|(?:^|[^\p{L}\p{N}])(?:(?:флуоресцентн(?:ый|ая|ое|ые|ого|ую|ом)\s+)?зел[её]н(?:ый|ая|ое|ые|ого|ую|ом)|салатн(?:ый|ая|ое|ые|ого|ую|ом)|green)(?=$|[^\p{L}\p{N}])/iu],
  ["yellow", /黄色|(?:^|[^\p{L}\p{N}])(?:yellow|ж[её]лт(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
  ["pink", /粉色|(?:^|[^\p{L}\p{N}])(?:pink|розов(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
  ["rose_gold", ROSE_GOLD_COLOR_PATTERN],
  ["purple", /(?:紫色|紫(?=高韧|PETG|PLA|TPU|ABS|耗材|线材|款|版|壳|套|$))|(?:^|[^\p{L}\p{N}])(?:purple|violet|фиолетов(?:ый|ая|ое|ые|ого|ую|ом)|пурпурн(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
  ["gold", /金色|(?:^|[^\p{L}\p{N}])(?:gold(?:en)?|золот(?:ой|ая|ое|ые|ого|ую|ом)|золотист(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
  ["transparent", /透明|(?:^|[^\p{L}\p{N}])(?:transparent|прозрачн(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
]);

function withoutLightColorPhrases(value) {
  return String(value || "").normalize("NFKC")
    .replace(/(?:^|[^\p{L}\p{N}])(?:warm|daylight|day[ -]?light|natural|neutral|cool|cold)\s+white(?:\s+(?:light|lighting))?(?=$|[^\p{L}\p{N}])/giu, " ")
    .replace(/(?:^|[^\p{L}\p{N}])(?:т[её]пл|дневн|нейтральн|естественн|холодн)\p{L}*\s+бел\p{L}*(?:\s+свет\p{L}*)?(?=$|[^\p{L}\p{N}])/giu, " ")
    .replace(/(?:暖白|日光白|自然白|中性白|冷白)(?:光|灯光)?/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function colorValue(value) {
  const casingText = withoutLightColorPhrases(value);
  const colors = new Map([
    ["黑色", "black"], ["black", "black"], ["черный", "black"], ["чёрный", "black"],
    ["白色", "white"], ["white", "white"], ["белый", "white"],
    ["红色", "red"], ["red", "red"], ["красный", "red"],
    ["蓝色", "blue"], ["blue", "blue"], ["синий", "blue"],
    ["绿色", "green"], ["绿", "green"], ["荧光绿", "green"], ["green", "green"], ["зеленый", "green"], ["зелёный", "green"], ["салатный", "green"], ["флуоресцентный зелёный", "green"],
    ["黄色", "yellow"], ["yellow", "yellow"], ["желтый", "yellow"], ["жёлтый", "yellow"],
    ["粉色", "pink"], ["pink", "pink"], ["розовый", "pink"],
    ["玫瑰金", "rose_gold"], ["rose gold", "rose_gold"], ["rose-gold", "rose_gold"], ["rose_gold", "rose_gold"],
    ["灰色", "gray"], ["grey", "gray"], ["gray", "gray"], ["серый", "gray"],
    ["金色", "gold"], ["gold", "gold"], ["golden", "gold"],
    ["золотой", "gold"], ["золотая", "gold"], ["золотое", "gold"],
    ["золотистый", "gold"], ["золотистая", "gold"], ["золотистое", "gold"],
    ["透明", "transparent"], ["transparent", "transparent"],
    ["紫色", "purple"], ["紫", "purple"], ["purple", "purple"], ["violet", "purple"], ["фиолетовый", "purple"], ["пурпурный", "purple"],
  ]);
  const exact = colors.get(casingText);
  if (exact) return exact;
  const explicit = supplyColorsInText(casingText);
  if (explicit.size === 1) return [...explicit][0];
  if (explicit.size > 1) return "__ambiguous__";
  return value;
}

function shapeValue(value) {
  if (/^(?:square|方形|方型|正方形|квадратн(?:ый|ая|ое|ые))$/iu.test(value)) return "square";
  if (/^(?:round|圆形|圆型|圆款|кругл(?:ый|ая|ое|ые))$/iu.test(value)) return "round";
  return value;
}

function hdmiSubtypeValues(value) {
  const source = text(value).toLocaleLowerCase("und");
  const values = new Set();
  if (/(?:mini[\s_-]*hdmi|hdmi[\s_-]*mini|c\s*型\s*mini(?:[\s_-]*hdmi)?)/iu.test(source)) values.add("mini-hdmi");
  if (/(?:micro[\s_-]*hdmi|hdmi[\s_-]*micro|d\s*型\s*micro(?:[\s_-]*hdmi)?)/iu.test(source)) values.add("micro-hdmi");
  return values;
}

function interfaceValue(value) {
  const hdmi = hdmiSubtypeValues(value);
  if (hdmi.size === 1) return [...hdmi][0];
  if (hdmi.size > 1) return "__ambiguous__";
  if (/^(?:usb[\s-]*)?(?:type-c|usb-c)$/iu.test(value)) return "type-c";
  return value;
}

/**
 * Only normalize protocols whose names are mutually exclusive on the same
 * product.  A missing protocol remains soft; a label that explicitly mentions
 * both transports deliberately stays ambiguous rather than choosing one.
 */
function wirelessProtocolValue(value) {
  const source = text(value).toLocaleLowerCase("und");
  const protocols = new Set();
  if (/(?:^|[^\p{L}\p{N}])zigbee(?:\s*3(?:\.0)?)?(?=$|[^\p{L}\p{N}])/iu.test(source)) protocols.add("zigbee");
  if (/(?:^|[^\p{L}\p{N}])wi[\s-]?fi(?=$|[^\p{L}\p{N}])|无线\s*wifi/iu.test(source)) protocols.add("wifi");
  if (protocols.size === 1) return [...protocols][0];
  if (protocols.size > 1) return "__ambiguous__";
  return value;
}

export function normalizeSupplySpecValue(value, name = null) {
  let normalized = text(value)
    .toLocaleLowerCase("und")
    .replace(/[×*]/gu, "x")
    .replace(/\s*([x:,;+])\s*/gu, "$1")
    .replace(/(\d)\s*(?:毫升|мл|ml)(?![a-zа-яё0-9])/giu, "$1ml")
    .replace(/(\d)\s*(?:升|литр(?:а|ов)?|l)(?![a-zа-яё0-9])/giu, "$1l")
    .replace(/(\d)\s*(?:gb|гб)(?![\p{L}\p{N}])/giu, "$1gb")
    .replace(/(\d)\s*(?:tb|тб)(?![\p{L}\p{N}])/giu, "$1tb")
    .replace(/(\d)\s*(?:mm|мм|毫米)(?![a-zа-яё0-9])/giu, "$1mm")
    .replace(/(\d)\s*(?:вольт(?:а|ов)?|伏特?)(?![a-zа-яё])/giu, "$1v")
    .replace(/(\d)\s*(?:amps?|ампер(?:а|ов)?|安培?)(?![a-zа-яё])/giu, "$1a")
    .replace(/(\d)\s*(?:watts?|ватт(?:а|ов)?|瓦)(?![a-zа-яё])/giu, "$1w")
    .replace(/(\d)\s*(?:v|в)(?![a-zа-яё])/giu, "$1v")
    .replace(/(\d)\s*(?:a|а)(?![a-zа-яё])/giu, "$1a")
    .replace(/(\d)\s*(?:w|вт)(?![a-zа-яё])/giu, "$1w")
    .replace(/(\d{4})\s*(?:k|к)(?![a-zа-яё0-9])/giu, "$1k")
    .replace(/(\d)\s*(?:cm|см)(?![\p{L}\p{N}])/giu, "$1cm")
    .replace(/type[\s_-]*c/giu, "type-c")
    .replace(/micro[\s_-]*usb/giu, "micro-usb")
    .trim();
  if (name === "set_quantity" || name === "head_count") {
    const count = normalized.match(/\d+(?:\.\d+)?/u)?.[0];
    if (count) normalized = String(Number(count));
  }
  if (name === "size") normalized = normalized.replace(/^([a-z0-9.]+)码$/iu, "$1");
  if (name === "voltage_v" || name === "current_a" || name === "power_w" || name === "cct_k") {
    const suffix = name === "voltage_v" ? "v" : name === "current_a" ? "a" : name === "power_w" ? "w" : "k";
    const metric = explicitMetricValues(normalized, name);
    if (metric.size === 1) normalized = `${[...metric][0]}${suffix}`;
  }
  if (name === "interface") normalized = interfaceValue(normalized);
  if (name === "wireless_protocol") normalized = wirelessProtocolValue(normalized);
  if (name === "color") normalized = colorValue(normalized);
  if (name === "shape") normalized = shapeValue(normalized);
  return normalized;
}

function putAttribute(target, rawName, rawValue) {
  const name = canonicalSpecName(rawName);
  const value = normalizeSupplySpecValue(rawValue, name);
  if (name && value && !target[name]) target[name] = value;
}

function attributesFrom(value) {
  const result = {};
  if (!value || typeof value !== "object") return result;
  if (!Array.isArray(value)) {
    putAttribute(
      result,
      value.name ?? value.label ?? value.key ?? value.attribute_name ?? value.prop_name,
      value.value ?? value.text ?? value.attribute_value ?? value.value_name ?? value.values?.[0],
    );
  }
  const sources = [value];
  for (const key of ["attributes", "variant_attributes", "specs", "properties"]) {
    if (value[key] && typeof value[key] === "object") sources.push(value[key]);
  }
  for (const source of sources) {
    if (Array.isArray(source)) {
      for (const row of source) {
        if (!row || typeof row !== "object") continue;
        putAttribute(
          result,
          row.name ?? row.label ?? row.key ?? row.attribute_name ?? row.prop_name,
          row.value ?? row.text ?? row.attribute_value ?? row.value_name ?? row.values?.[0],
        );
      }
    } else {
      for (const [name, entry] of Object.entries(source)) {
        if (["required", "sources", "label"].includes(name)) continue;
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          putAttribute(result, entry.name ?? entry.label ?? name, entry.value ?? entry.text ?? entry.value_name);
        } else {
          putAttribute(result, name, entry);
        }
      }
    }
  }
  return result;
}

export function normalizeTargetVariant(targetVariant) {
  if (!targetVariant || typeof targetVariant !== "object") return {};
  return attributesFrom(targetVariant.attributes && typeof targetVariant.attributes === "object"
    ? { ...targetVariant.attributes, attributes: targetVariant.variant_attributes }
    : targetVariant);
}

const IDENTITY_COLOR_PATTERNS = Object.freeze(
  SUPPLY_COLOR_PATTERNS.filter(([color]) => color !== "transparent"),
);

function supplyColorsInText(value, patterns = SUPPLY_COLOR_PATTERNS) {
  const source = withoutLightColorPhrases(value);
  const hasRoseGold = ROSE_GOLD_COLOR_PATTERN.test(source);
  const remaining = hasRoseGold
    ? source.replace(/玫瑰金|(?:^|[^\p{L}\p{N}])rose[\s-]*gold(?=$|[^\p{L}\p{N}])|розов\p{L}*[\s-]+золот\p{L}*/giu, " ")
    : source;
  const colors = new Set(patterns
    .filter(([color, pattern]) => color !== "rose_gold" && pattern.test(remaining))
    .map(([color]) => color));
  if (hasRoseGold) colors.add("rose_gold");
  return colors;
}

function colorsInText(value) {
  return supplyColorsInText(value, IDENTITY_COLOR_PATTERNS);
}

function identityModelTokens(value) {
  const source = String(value || "").normalize("NFKC").toLocaleUpperCase("und");
  const pattern = /(?:^|[^A-Z0-9])([A-Z]{1,7}(?:[-_]?\d{2,9}[A-Z0-9-]*|\d[-_]\d{1,9}[A-Z0-9-]*)|[A-Z]{2,7}\d[A-Z]*)(?=$|[^A-Z0-9])/gu;
  const result = new Set();
  for (const match of source.matchAll(pattern)) {
    const raw = String(match[1] || "");
    const prefix = source.slice(Math.max(0, Number(match.index) - 12), Number(match.index) + String(match[0]).indexOf(raw));
    // A negated compatibility/model mention is not positive identity evidence
    // (`не ELM3`, `not X200`, `非 X200`).
    if (/(?:^|[^A-Z0-9])(?:NOT|НЕ|非|不是|不含)\s*[:：-]?\s*$/u.test(prefix)) continue;
    const token = raw.replace(/[-_]/gu, "");
    // Keep actual alphanumeric model numbers while excluding common ratings,
    // protocols, pack counts and marketing years. Numeric-first measurements
    // such as 12V/60W/100MM never enter this extractor in the first place.
    if (/^(?:IP|ARGB|RGB|PWM|USB|OBD|HDMI|WIFI|ZIGBEE|BT|BLE|LORA|MP|LED|COB|ISO|PCS|NO)\d+[A-Z0-9]*$/u.test(token)) continue;
    // Voltage is overwhelmingly written numeric-first (`12V`). Keep V539-like
    // tokens because those are common product models; V2026 remains filtered
    // as a marketing year below.
    if (/^(?:W|A|K|MM|CM|ML|L|KG|G|GB|TB)\d+$/u.test(token)) continue;
    if (/^(?:NEW|YEAR|MODEL|VER|VERSION|V)20\d{2}$/u.test(token)) continue;
    result.add(token);
  }
  return [...result];
}

function compatibleIdentityModel(left, right) {
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return longer.startsWith(shorter) && longer.length - shorter.length <= 1 && /[A-Z]$/u.test(longer);
}

function explicitScaleRatios(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  const result = new Set();
  for (const match of source.matchAll(/(?:^|[^\d])1\s*[:：/]\s*(\d{1,4})(?=$|[^\d])/gu)) {
    const denominator = Number(match[1]);
    // Ratios below 1:4 are commonly splitter/count notation. Model scales are
    // positive and the upper bound excludes timestamps/IDs accidentally joined
    // by punctuation.
    if (Number.isInteger(denominator) && denominator >= 4 && denominator <= 2_000) {
      result.add(`1:${denominator}`);
    }
  }
  return result;
}

function explicitModelBuildRole(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  const assemblyKit = /(?:model\s*(?:building|assembly)?\s*kit|plastic\s*(?:model\s*)?kit|kit\s+for\s+assembly|сборн\p{L}*\s+(?:пластиков\p{L}*\s+)?модел\p{L}*|модел\p{L}*\s+для\s+сборк\p{L}*|模型(?:拼装|组装)?套件|拼装模型|组装模型|塑料套件|拼装件)/iu.test(source);
  const finishedMetal = /(?:die[ -]?cast(?:\s+(?:model|toy))?|finished\s+(?:metal|alloy)\s+(?:model|toy)|ready[ -]?made\s+(?:metal|alloy)\s+(?:model|toy)|готов\p{L}*\s+(?:металлическ\p{L}*\s+)?модел\p{L}*|лит\p{L}*\s+металлическ\p{L}*\s+модел\p{L}*|(?:静态)?合金(?:成品)?(?:模型|玩具)|合金(?:模型|玩具).{0,8}成品|金属成品模型)/iu.test(source);
  if (assemblyKit && !finishedMetal) return "assembly_model_kit";
  if (finishedMetal && !assemblyKit) return "finished_metal_model";
  return null;
}

function explicitToyVehicleRole(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  const rearBodyPart = /(?:rear|pillion)\s+(?:solo\s+)?(?:seat\s+)?(?:cowl|cover|fairing|panel)|(?:cowl|cover|fairing|panel)\s+for\s+(?:the\s+)?rear\s+seat|(?:задн\p{L}*\s+сиден\p{L}*.{0,18}крышк\p{L}*|крышк\p{L}*.{0,18}задн\p{L}*\s+сиден\p{L}*)|(?:摩托车)?(?:后座|单座|尾座)(?:盖|罩|壳)|车身(?:替换)?配件|替换车壳/iu.test(source);
  const completeToy = /(?:complete|finished|ready[ -]?made|die[ -]?cast|radio[ -]?controlled|\brc\b).{0,24}(?:car|motorcycle|bike).{0,24}(?:model|toy)|(?:car|motorcycle|bike).{0,24}(?:finished|ready[ -]?made|die[ -]?cast|radio[ -]?controlled|\brc\b).{0,16}(?:model|toy)|радиоуправляем\p{L}*\s+модел\p{L}*.{0,24}(?:автомобил\p{L}*|машин\p{L}*|мотоцикл\p{L}*)|готов\p{L}*\s+модел\p{L}*.{0,24}(?:автомобил\p{L}*|машин\p{L}*|мотоцикл\p{L}*)|整车.{0,12}(?:模型|玩具)|(?:仿真|遥控|合金).{0,12}(?:汽车|赛车|摩托车).{0,12}(?:成品|模型|玩具)|(?:汽车|赛车|摩托车).{0,12}(?:仿真|遥控|合金).{0,12}(?:成品|模型|玩具)/iu.test(source);
  if (rearBodyPart && !completeToy) return "toy_vehicle_body_part";
  if (completeToy && !rearBodyPart) return "complete_toy_vehicle";
  return null;
}

function explicitDifferentiatedBundleConflict(targetTitle, offerTitle) {
  const targetSource = String(targetTitle || "").normalize("NFKC").toLocaleLowerCase("und");
  const offerSource = String(offerTitle || "").normalize("NFKC").toLocaleLowerCase("und");
  const bundleMarker = /(?:play\s*set|playset|gift\s*set|игров\p{L}*\s+набор\p{L}*|套装|组合套装)/iu;
  const explicitSingleMarker = /(?:^|[^\p{L}\p{N}])(?:single|one[ -]?piece|один|одна|одно|单个|单只|单件)(?=$|[^\p{L}\p{N}])|摆件/iu;
  if (!bundleMarker.test(targetSource) || bundleMarker.test(offerSource) || !explicitSingleMarker.test(offerSource)) return false;
  const componentRoles = (source) => new Set([
    /(?:car|vehicle|машин\p{L}*|автомобил\p{L}*|машинка|汽车|赛车|拦截车|车辆)/iu.test(source) ? "vehicle" : null,
    /(?:figur(?:e|ine)s?|character\s+figure|фигур\p{L}*|персонаж\p{L}*|人偶|人物模型|公仔)/iu.test(source) ? "figure" : null,
    /(?:building|structure|здани\p{L}*|сооружени\p{L}*|建筑|场景建筑)/iu.test(source) ? "structure" : null,
  ].filter(Boolean));
  const targetRoles = componentRoles(targetSource);
  const offerRoles = componentRoles(offerSource);
  return targetRoles.size >= 2 && [...targetRoles].some((role) => !offerRoles.has(role));
}

function explicitCollectibleVehicleStyle(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  if (/will\s+trash\s+it\s+all/iu.test(source)) return "will_trash_it_all";
  // Rageasaur is the named Hot Wheels dinosaur truck; Chinese listings often
  // identify that same style only as T-Rex/霸王龙.
  if (/rageasaur|t[ -]?rex|tyrannosaurus|霸王龙|暴龙/iu.test(source)) return "rageasaur_trex";
  return null;
}

function explicitWiringTopology(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  const noNeutral = /(?:no|without)[ -]?neutral|neutral[ -]?free|single[ -]?(?:live|fire)(?:\s+wire)?|без\s+(?:нейтрал\p{L}*|нулев\p{L}*\s+провод\p{L}*)|(?:一路)?单火(?:模块|开关)?|免零线|无零线|不带零线/iu.test(source);
  const withNeutral = /with\s+(?:a\s+)?neutral(?:\s+wire)?|neutral\s+(?:wire\s+)?required|с\s+(?:нейтрал\p{L}*|нулев\p{L}*\s+провод\p{L}*)|(?:一路)?零火(?:模块|开关)?|有零线|需零线|需要零线|带零线/iu.test(source);
  if (noNeutral && !withNeutral) return "no_neutral";
  if (withNeutral && !noNeutral) return "with_neutral";
  return null;
}

function explicitBluetoothVersions(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  const result = new Set();
  for (const pattern of [
    /(?:bluetooth|blue[ -]?tooth|блютуз|蓝牙)\s*(?:(?:version|ver(?:sion)?\.?|v|верси\p{L}*|版本)\s*)?([2-9])\s*[.．]\s*(\d)(?!\d)/giu,
    /(?:^|[^\p{L}\p{N}])(?:bt|ble)\s*v?\s*([2-9])\s*[.．]\s*(\d)(?!\d)/giu,
  ]) {
    for (const match of source.matchAll(pattern)) result.add(`${Number(match[1])}.${Number(match[2])}`);
  }
  return result;
}

function headCounts(value) {
  const result = new Set();
  const source = String(value || "");
  for (const pattern of [
    /(?:^|[^\p{L}\p{N}])(\d{1,2})\s*(?:头|燈頭|灯头|head(?:s)?|плафон(?:а|ов)?)(?=$|[^\p{L}\p{N}])/giu,
    /(?:四|4)头/gu,
  ]) {
    for (const match of source.matchAll(pattern)) result.add(Number(match[1] || 4));
  }
  return result;
}

function productIdentityKind(value) {
  const source = String(value || "").toLocaleLowerCase("und");
  if (/sunscreen|sun[ -]?screen|солнцезащит|防晒/iu.test(source)) return "sunscreen";
  if (/eye\s*cream|крем\s+(?:для|вокруг)\s+глаз|眼霜|眼部.*霜/iu.test(source)) return "eye_cream";
  if (/serum|сыворот|精华/iu.test(source)) return "serum";
  return null;
}

const PERFUME_NAME_STOP_WORDS = new Set([
  "and", "arabian", "arabic", "authentic", "black", "blue", "bottle", "box", "cologne",
  "de", "eau", "edp", "edt", "el", "for", "fragrance", "gift", "gold", "golden", "green",
  "hot", "lasting", "long", "men", "new", "original", "parfum", "perfume", "pink", "pour",
  "purple", "red", "sale", "silver", "spray", "the", "unisex", "water", "white", "wholesale",
  "with", "woman", "women",
]);

function explicitlyPerfume(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  return /(?:perfume|parfum|fragrance|eau\s+de|(?:^|[^a-z])(?:edp|edt)(?=$|[^a-z])|(?:^|[^a-z])oud(?=$|[^a-z])|парфюм|духи|туалетн\p{L}*\s+вод|香水|香氛|女香|男香)/iu.test(source);
}

function perfumeNameTokens(value) {
  const source = String(value || "").normalize("NFKC");
  const tokens = source.match(/[A-Za-z][A-Za-z'\-’]{2,}/gu) || [];
  return new Set(tokens
    .map((token) => token.toLocaleLowerCase("und").replace(/’/gu, "'"))
    .filter((token) => !PERFUME_NAME_STOP_WORDS.has(token)));
}

function explicitPerfumeIdentityConflict(targetTitle, offerTitle) {
  if (!explicitlyPerfume(targetTitle)) return null;
  const targetTokens = perfumeNameTokens(targetTitle);
  const offerTokens = perfumeNameTokens(offerTitle);
  if (!targetTokens.size || !offerTokens.size) return null;
  const targetContained = [...targetTokens].every((token) => offerTokens.has(token));
  const offerContained = [...offerTokens].every((token) => targetTokens.has(token));
  if (targetContained || offerContained) return null;
  const commonTokens = [...targetTokens].filter((token) => offerTokens.has(token));
  // Two shared non-generic name words are strong enough to keep shorthand and
  // expanded perfume names compatible (for example `Oud for Glory` versus
  // `Badee Al Oud for Glory`). One shared brand word alone is not sufficient.
  if (commonTokens.length >= 2) return null;
  const targetName = [...targetTokens].sort().join("|");
  const offerName = [...offerTokens].sort().join("|");
  return `explicit_perfume_identity_conflict:${targetName}!=${offerName}`;
}

function explicitThreadEndStyle(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  if (!source) return null;
  // A generic offer title may enumerate multiple selectable thread variants.
  // Keep that soft and let the selected row provide the auditable endpoint.
  if (/(?:可选|可选择|多规格|任选|自选|options?|optional|selectable|на\s+выбор)/iu.test(source)
    && /(?:内丝|外丝|female|male|внутренн\p{L}*\s+резьб|наружн\p{L}*\s+резьб)/iu.test(source)) return null;
  const mixed = /(?:内外丝|内丝\s*(?:[/／+-→转]|to)\s*外丝|外丝\s*(?:[/／+-→转]|to)\s*内丝|female\s*(?:[/+-→]|to)\s*male|male\s*(?:[/+-→]|to)\s*female|внутренн\p{L}*\s*(?:[/+-→]|на)\s*наружн\p{L}*|наружн\p{L}*\s*(?:[/+-→]|на)\s*внутренн\p{L}*)/iu.test(source);
  if (mixed) return "female-male";
  const female = /(?:双内丝|内内丝|内丝\s*[/／+-]\s*内丝|内丝|female(?:\s+thread)?|внутренн\p{L}*\s+резьб)/iu.test(source);
  const male = /(?:双外丝|外外丝|外丝\s*[/／+-]\s*外丝|外丝|male(?:\s+thread)?|наружн\p{L}*\s+резьб)/iu.test(source);
  if (female && !male) return "female";
  if (male && !female) return "male";
  return null;
}

function productAccessoryRole(value) {
  const source = String(value || "").toLocaleLowerCase("und");
  const stylusRole = stylusProductAccessoryRole(source);
  if (stylusRole) return stylusRole;
  const watch = /(?:\bwatch\b|smartwatch|手表|腕表|表带|腕带|часы|ремешок)/iu.test(source);
  if (watch) {
    const accessory = /(?:protective\s*(?:case|cover)|silicone\s*(?:case|cover)|watch\s*(?:case|cover|strap|band)|保护套|保护壳|硅胶套|手表套|表壳|表带|腕带|贴膜|чехол|ремешок)/iu.test(source);
    return accessory ? "smart_watch_accessory" : "smart_watch_core";
  }
  // A visually matching fan, cooling stand, charging base or dust cover is
  // still not the game console body.  Keep generic `Series S` text soft unless
  // it is paired with an explicit console accessory role; an explicit Xbox,
  // PlayStation, Nintendo Switch or game-console noun is sufficient for the
  // body role. Controller bodies/docks remain handled by the narrower rule
  // below so controller-versus-controller-dock detection keeps its semantics.
  const gameController = /(?:dualshock|dualsense|gamepad|game\s*controller|游戏手柄|游戏控制器|手柄|геймпад|игров(?:ой|ого)\s+контроллер|контроллер)/iu.test(source);
  const consoleFamily = /(?:xbox(?:\s+(?:series\s*[sx]|one))?|playstation|nintendo\s+switch|游戏主机|游戏机|игров\p{L}*\s+приставк\p{L}*|игров\p{L}*\s+консол\p{L}*)/iu.test(source);
  const consoleAccessory = /(?:top|верхн\p{L}*|顶部)?\s*(?:cooling|cooler|heat\s*dissipation|охлажд\p{L}*|散热|冷却)\s*(?:fan|stand|base|dock|вентилятор|подставк\p{L}*|风扇|支架|底座)|(?:fan|вентилятор|风扇).{0,12}(?:cooling|охлажд\p{L}*|散热|冷却)|(?:multi[ -]?function|all[ -]?in[ -]?one|многофункциональн\p{L}*|多合一|多功能).{0,20}(?:stand|base|dock|charger|подставк\p{L}*|станц\p{L}*|支架|底座|充电器)|(?:console|主机|游戏机)\s*(?:stand|base|dock|cover|dust\s*cover|подставк\p{L}*|支架|底座|防尘(?:罩|套))|(?:charging|charger|зарядн\p{L}*|充电器?)\s*(?:stand|base|dock|station|подставк\p{L}*|баз\p{L}*|станц\p{L}*|支架|底座|座)|(?:dust|пылезащитн\p{L}*|防尘)\s*(?:cover|case|чехол|罩|套)/iu.test(source);
  const seriesSAccessory = /(?:^|[^\p{L}\p{N}])series\s*s(?=$|[^\p{L}\p{N}]|顶部|散热|冷却|风扇)/iu.test(source) && consoleAccessory;
  const explicitConsoleAccessoryOnly = /(?:多合一|多功能|multi[ -]?function|all[ -]?in[ -]?one).{0,40}(?:主机\s*支架|console\s*stand|充电器?\s*底座|charging\s*dock)/iu.test(source);
  if (!gameController && (consoleFamily || seriesSAccessory || explicitConsoleAccessoryOnly)) {
    return consoleAccessory ? "game_console_accessory" : "game_console_core";
  }
  // A controller charging dock is an accessory, not a controller. Require a
  // controller-family marker as well so generic charging stands are untouched.
  const controllerFamily = /(?:\bps[345]\b|dualshock|dualsense|gamepad|game\s*controller|游戏手柄|游戏控制器|手柄|геймпад|игров(?:ой|ого)\s+контроллер|контроллер)/iu.test(source);
  if (!controllerFamily) return null;
  const dock = /(?:charging\s*(?:dock|station|stand|base)|(?:dock|station|stand)\s*(?:for\s*)?(?:charging|charge)|充电(?:座|底座|站|支架)|充电\s*坞|充电站|зарядн\p{L}*\s*(?:док(?:-?станц\p{L}*)?|станц\p{L}*|подставк\p{L}*))/iu.test(source);
  return dock ? "game_controller_accessory" : "game_controller_core";
}

// Manufacturer names are deliberately narrower than product-family aliases.
// A clone calling itself `Galaxy` or `Watch8` is not auditable Samsung brand
// evidence; the actual manufacturer name (or its localized spelling) must be
// present for a branded core device.
const BRANDED_CORE_DIGITAL_MANUFACTURERS = Object.freeze([
  ["apple", /(?:^|[^\p{L}\p{N}])apple(?=$|[^\p{L}\p{N}])|苹果/iu],
  ["samsung", /(?:^|[^\p{L}\p{N}])samsung(?=$|[^\p{L}\p{N}])|三星/iu],
  ["huawei", /(?:^|[^\p{L}\p{N}])huawei(?=$|[^\p{L}\p{N}])|华为/iu],
  ["honor", /(?:^|[^\p{L}\p{N}])honor(?=$|[^\p{L}\p{N}])|荣耀/iu],
  ["xiaomi", /(?:^|[^\p{L}\p{N}])xiaomi(?=$|[^\p{L}\p{N}])|小米/iu],
  ["oppo", /(?:^|[^\p{L}\p{N}])oppo(?=$|[^\p{L}\p{N}])|欧珀/iu],
  ["vivo", /(?:^|[^\p{L}\p{N}])(?:vivo|iqoo)(?=$|[^\p{L}\p{N}])|维沃/iu],
  ["realme", /(?:^|[^\p{L}\p{N}])realme(?=$|[^\p{L}\p{N}])|真我/iu],
  ["oneplus", /(?:^|[^\p{L}\p{N}])oneplus(?=$|[^\p{L}\p{N}])|一加/iu],
  ["sony", /(?:^|[^\p{L}\p{N}])sony(?=$|[^\p{L}\p{N}])|索尼/iu],
  ["microsoft", /(?:^|[^\p{L}\p{N}])microsoft(?=$|[^\p{L}\p{N}])|微软/iu],
  ["nintendo", /(?:^|[^\p{L}\p{N}])nintendo(?=$|[^\p{L}\p{N}])|任天堂/iu],
  ["google", /(?:^|[^\p{L}\p{N}])google(?=$|[^\p{L}\p{N}])|谷歌/iu],
  ["garmin", /(?:^|[^\p{L}\p{N}])garmin(?=$|[^\p{L}\p{N}])|佳明/iu],
  ["dji", /(?:^|[^\p{L}\p{N}])dji(?=$|[^\p{L}\p{N}])|大疆/iu],
]);

function brandedCoreDigitalManufacturers(value) {
  const source = String(value || "");
  return new Set(BRANDED_CORE_DIGITAL_MANUFACTURERS
    .filter(([, pattern]) => pattern.test(source))
    .map(([manufacturer]) => manufacturer));
}

function brandedCoreDigitalKind(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  const existingRole = productAccessoryRole(source);
  if (existingRole === "smart_watch_core") return "smartwatch";
  if (existingRole === "game_console_core") return "game_console";
  if (existingRole?.endsWith("_accessory")) return null;

  const accessory = /(?:case|cover|shell|strap|band|film|screen\s*protector|tempered\s*glass|charger|charging|cable|adapter|mount|holder|replacement|чехол|ремешок|пленк\p{L}*|стекл\p{L}*|заряд\p{L}*|保护(?:套|壳|膜)|手机壳|钢化膜|表带|腕带|贴膜|充电|数据线|支架)/iu.test(source);
  if (accessory) return null;
  if (/(?:smart\s*phone|smartphone|mobile\s*phone|cell\s*phone|смартфон|мобильн\p{L}*\s+телефон|智能手机|手机)/iu.test(source)) return "smartphone";
  if (/(?:tablet(?:\s+computer)?|планшет|平板电脑)/iu.test(source)) return "tablet";
  if (/(?:laptop|notebook\s+computer|ноутбук|笔记本电脑)/iu.test(source)) return "laptop";
  if (/(?:headphones?|earbuds?|earphones?|наушник|耳机)/iu.test(source)) return "headphones";
  if (/(?:digital\s+camera|mirrorless\s+camera|action\s+camera|цифров\p{L}*\s+камер|数码相机|运动相机)/iu.test(source)) return "camera";
  if (/(?:camera\s+drone|quadcopter|квадрокоптер|航拍无人机)/iu.test(source)) return "drone";
  return null;
}

function normalizedBrandedDigitalModel(value) {
  const compact = String(value || "").normalize("NFKC").toLocaleUpperCase("und")
    .replace(/[^A-Z0-9]/gu, "");
  if (compact.length < 2 || compact.length > 40 || !/[A-Z]/u.test(compact) || !/\d/u.test(compact)) return null;
  return compact;
}

function brandedDigitalModelTokens(value, { declaredModel = false } = {}) {
  const source = String(value || "").normalize("NFKC").toLocaleUpperCase("und");
  const result = new Set(identityModelTokens(source));
  // `SM-L330` used to degrade to `L330`, which the generic extractor then
  // discarded as litre-like noise. In a declared model field for a branded
  // device, L330 is identity, not a measurement.
  if (declaredModel) {
    const direct = normalizedBrandedDigitalModel(source);
    if (direct) result.add(direct);
  }
  for (const match of source.matchAll(/(?:^|[^A-Z0-9])([A-Z]{1,8}(?:[-_][A-Z0-9]{1,12}){1,4})(?=$|[^A-Z0-9])/gu)) {
    const raw = String(match[1] || "");
    if (!/\d/u.test(raw)) continue;
    const whole = normalizedBrandedDigitalModel(raw);
    if (whole) result.add(whole);
    for (const segment of raw.split(/[-_]/gu)) {
      const token = normalizedBrandedDigitalModel(segment);
      if (token) result.add(token);
    }
  }
  return result;
}

function brandedCoreDigitalTargetIdentity(targetTitle, target = {}) {
  const kind = brandedCoreDigitalKind(targetTitle);
  const manufacturers = brandedCoreDigitalManufacturers(targetTitle);
  let models = brandedDigitalModelTokens(target?.model, { declaredModel: true });
  if (!models.size) models = brandedDigitalModelTokens(targetTitle);
  return {
    applies: Boolean(kind && manufacturers.size && models.size),
    kind,
    manufacturers,
    models,
  };
}

function brandedDigitalModelsCompatible(expected, observed) {
  return [...expected].some((left) => [...observed].some((right) => {
    if (compatibleIdentityModel(left, right)) return true;
    const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
    // Samsung commonly publishes `L330` and `SML330` interchangeably. Limit
    // that suffix tolerance to one short manufacturer prefix so unrelated
    // models sharing a numeric tail cannot pass.
    return shorter.length >= 3
      && longer.length - shorter.length <= 2
      && longer.endsWith(shorter)
      && /^[A-Z]{1,2}$/u.test(longer.slice(0, longer.length - shorter.length));
  }));
}

function brandedCoreDigitalCloneCue(value) {
  const source = String(value || "").normalize("NFKC");
  return /开机\s*logo|带标|可(?:打|印|定制)\s*(?:标|logo)|打\s*logo|logo\s*(?:版|款|开机)|高仿|精仿|复刻|仿版|一比一|1\s*[:：]\s*1\s*(?:copy|复刻|仿)/iu.test(source);
}

function brandedCoreDigitalCandidateConflicts({ targetTitle, offerTitle, target }) {
  const identity = brandedCoreDigitalTargetIdentity(targetTitle, target);
  if (!identity.applies) return [];
  const conflicts = [];
  if (brandedCoreDigitalCloneCue(offerTitle)) conflicts.push("branded_core_digital_clone_cue");
  const offerManufacturers = brandedCoreDigitalManufacturers(offerTitle);
  if (!offerManufacturers.size) {
    conflicts.push(`branded_core_digital_brand_missing:${[...identity.manufacturers].join("|")}`);
  } else if (![...identity.manufacturers].some((brand) => offerManufacturers.has(brand))) {
    conflicts.push(`branded_core_digital_brand_conflict:${[...identity.manufacturers].join("|")}!=${[...offerManufacturers].join("|")}`);
  }
  const offerModels = brandedDigitalModelTokens(offerTitle);
  if (!offerModels.size) {
    conflicts.push(`branded_core_digital_model_missing:${[...identity.models].join("|")}`);
  } else if (!brandedDigitalModelsCompatible(identity.models, offerModels)) {
    conflicts.push(`branded_core_digital_model_conflict:${[...identity.models].join("|")}!=${[...offerModels].join("|")}`);
  }
  return conflicts;
}

function brandedCoreDigitalSelectedRowConflicts({ targetTitle, target, rowText, rowModel = null }) {
  const identity = brandedCoreDigitalTargetIdentity(targetTitle, target);
  if (!identity.applies) return [];
  const conflicts = [];
  if (brandedCoreDigitalCloneCue(rowText)) conflicts.push("branded_core_digital_clone_cue");
  const rowModels = brandedDigitalModelTokens(rowText);
  for (const model of brandedDigitalModelTokens(rowModel, { declaredModel: true })) rowModels.add(model);
  if (!rowModels.size) {
    conflicts.push(`branded_core_digital_selected_model_missing:${[...identity.models].join("|")}`);
  } else if (!brandedDigitalModelsCompatible(identity.models, rowModels)) {
    conflicts.push(`branded_core_digital_selected_model_conflict:${[...identity.models].join("|")}!=${[...rowModels].join("|")}`);
  }
  return conflicts;
}

function wirelessProtocolsInText(value) {
  const normalized = wirelessProtocolValue(value);
  return new Set(["zigbee", "wifi"].includes(normalized) ? [normalized] : []);
}

function smartEcosystemsInText(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  const result = new Set();
  if (/(?:^|[^\p{L}\p{N}])tuya(?=$|[^\p{L}\p{N}])|涂鸦(?:智能|app)?/iu.test(source)) result.add("tuya");
  if (/(?:^|[^\p{L}\p{N}])cozy[\s-]?life(?=$|[^\p{L}\p{N}])/iu.test(source)) result.add("cozylife");
  return result;
}

function explicitProductRole(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  const garage = /garage[ -]?(?:door|gate)|гаражн\p{L}*\s+(?:ворот|двер)|车库门|卷闸门|卷帘门/iu.test(source);
  if (garage && /(?:controller|relay|switch|opener|контроллер|реле|выключател|控制器|继电器|开关|通断器|模块)/iu.test(source)) {
    return "garage_door_controller";
  }
  const smartSwitch = /(?:smart|wifi|wi[ -]?fi|tuya|cozy[\s-]?life|умн\p{L}*)/iu.test(source)
    && /(?:switch|relay|breaker|выключател|реле|开关|通断器|断路器)/iu.test(source);
  if (smartSwitch && !garage) return "generic_smart_switch";

  const steamDeck = /steam\s*deck/iu.test(source);
  if (steamDeck) {
    const replacementRear = /(?:replacement|replaceable)\s+(?:rear|back)\s+(?:panel|plate|cover|shell)|(?:rear|back)\s+(?:panel|plate)|задн\p{L}*\s+панел|后盖|后壳|背板|替换壳/iu.test(source);
    const protectiveCase = /protective\s+(?:case|cover|shell)|hard\s+(?:case|shell)|чехол|保护套|保护壳|一体硬壳|防摔壳/iu.test(source);
    if (replacementRear && !protectiveCase) return "steam_deck_rear_replacement";
    if (protectiveCase && !replacementRear) return "steam_deck_protective_case";
  }
  return null;
}

function connectorType(raw) {
  const value = String(raw || "").normalize("NFKC").toLocaleLowerCase("und");
  if (/type[\s_-]*c|usb[\s_-]*c|тайп\s*си/iu.test(value)) return "type-c";
  if (/micro[\s_-]*usb/iu.test(value)) return "micro-usb";
  if (/mini[\s_-]*usb/iu.test(value)) return "mini-usb";
  if (/lightning|лайтнинг/iu.test(value)) return "lightning";
  if (/usb(?:\s*3(?:\.\d)?|\s*2(?:\.\d)?)?|юсб/iu.test(value)) return "usb-a";
  if (/mini[\s_-]*hdmi/iu.test(value)) return "mini-hdmi";
  if (/micro[\s_-]*hdmi/iu.test(value)) return "micro-hdmi";
  if (/hdmi/iu.test(value)) return "hdmi";
  return null;
}

function connectorDirectionsInText(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  const endpoint = "(?:type[\\s_-]*c|usb[\\s_-]*c|тайп\\s*си|micro[\\s_-]*usb|mini[\\s_-]*usb|lightning|лайтнинг|usb(?:\\s*3(?:\\.\\d)?|\\s*2(?:\\.\\d)?)?|юсб|mini[\\s_-]*hdmi|micro[\\s_-]*hdmi|hdmi)(?:\\s*(?:公头|母头|公座|母座|male|female))?";
  const result = new Set();
  for (const pattern of [
    new RegExp(`(${endpoint})\\s*(?:转|转换成|to|into|на)\\s*(${endpoint})`, "giu"),
    new RegExp(`(${endpoint})\\s*(?:→|->|➜)\\s*(${endpoint})`, "giu"),
  ]) {
    for (const match of source.matchAll(pattern)) {
      const from = connectorType(match[1]);
      const to = connectorType(match[2]);
      if (from && to && from !== to) result.add(`${from}>${to}`);
    }
  }
  return result;
}

function airpodsGenerationsInText(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  if (!/air\s*pods/iu.test(source)) return new Set();
  const result = new Set();
  for (const match of source.matchAll(/air\s*pods(?:\s*pro)?[^,;/]{0,24}?(\d)\s*[-–~至到]\s*(\d)/giu)) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start > 0 && end >= start && end - start <= 4) {
      for (let generation = start; generation <= end; generation += 1) result.add(String(generation));
    }
  }
  for (const pattern of [
    /air\s*pods(?:\s*pro)?\s*(\d)\s*(?:代|th|nd|rd|gen(?:eration)?\.?)/giu,
    /air\s*pods(?:\s*pro)?[^,;/]{0,24}?(?:第\s*)?(\d)\s*代/giu,
    /air\s*pods(?:\s*pro)?\s*(?:一|二|三|四)代/giu,
  ]) {
    for (const match of source.matchAll(pattern)) {
      const chinese = match[0].match(/([一二三四])代/u)?.[1];
      const generation = chinese ? ({ 一: "1", 二: "2", 三: "3", 四: "4" })[chinese] : match[1];
      if (generation) result.add(String(Number(generation)));
    }
  }
  return result;
}

function automotivePartNumberTokens(value) {
  const source = String(value || "").normalize("NFKC").toLocaleUpperCase("und");
  if (!/(?:FORD|FOCUS|C-MAX|ФОРД|ФОКУС|ГУР|POWER\s*STEERING|福特|福克斯|助力|转向)/iu.test(source)) return new Set();
  const tokens = source.match(/(?:^|[^A-Z0-9])([A-Z0-9]{6,14})(?=$|[^A-Z0-9])/gu) || [];
  return new Set(tokens
    .map((token) => token.replace(/^[^A-Z0-9]+/gu, ""))
    .filter((token) => /\d/u.test(token) && !/^20\d{4,}$/u.test(token)));
}

function explicitTitleIdentityConflicts({ targetTitle, offerTitle, target }) {
  if (!offerTitle) return [];
  const conflicts = [];

  const targetBrand = explicitLeadingBrandToken(targetTitle);
  const offerBrand = explicitLeadingBrandToken(offerTitle);
  // Missing brand text is deliberately soft; only two explicit, disjoint
  // identifiers create a contradiction.
  if (targetBrand && offerBrand && targetBrand !== offerBrand) {
    conflicts.push(`explicit_brand_conflict:${targetBrand}!=${offerBrand}`);
  }

  const perfumeConflict = explicitPerfumeIdentityConflict(targetTitle, offerTitle);
  if (perfumeConflict) conflicts.push(perfumeConflict);

  const targetThreadEnds = explicitThreadEndStyle(targetTitle);
  const offerThreadEnds = explicitThreadEndStyle(offerTitle);
  if (targetThreadEnds && offerThreadEnds && targetThreadEnds !== offerThreadEnds) {
    conflicts.push(`explicit_thread_end_conflict:${targetThreadEnds}!=${offerThreadEnds}`);
  }

  const targetModels = new Set([
    ...identityModelTokens(targetTitle),
    ...identityModelTokens(target?.model),
  ]);
  const offerModels = new Set(identityModelTokens(offerTitle));
  if (targetModels.size && offerModels.size && ![...targetModels].some((left) => (
    [...offerModels].some((right) => compatibleIdentityModel(left, right))
  ))) {
    conflicts.push(`explicit_model_conflict:${[...targetModels].join("|")}!=${[...offerModels].join("|")}`);
  }

  const targetScales = explicitScaleRatios(targetTitle);
  const offerScales = explicitScaleRatios(offerTitle);
  if (targetScales.size === 1 && offerScales.size === 1
    && [...targetScales][0] !== [...offerScales][0]) {
    conflicts.push(`explicit_scale_conflict:${[...targetScales][0]}!=${[...offerScales][0]}`);
  }

  const targetBuildRole = explicitModelBuildRole(targetTitle);
  const offerBuildRole = explicitModelBuildRole(offerTitle);
  if (targetBuildRole && offerBuildRole && targetBuildRole !== offerBuildRole) {
    conflicts.push(`explicit_model_build_role_conflict:${targetBuildRole}!=${offerBuildRole}`);
  }

  const targetVehicleRole = explicitToyVehicleRole(targetTitle);
  const offerVehicleRole = explicitToyVehicleRole(offerTitle);
  if (targetVehicleRole && offerVehicleRole && targetVehicleRole !== offerVehicleRole) {
    conflicts.push(`explicit_toy_vehicle_role_conflict:${targetVehicleRole}!=${offerVehicleRole}`);
  }

  if (explicitDifferentiatedBundleConflict(targetTitle, offerTitle)) {
    conflicts.push("explicit_differentiated_bundle_conflict");
  }

  const targetCollectibleStyle = explicitCollectibleVehicleStyle(targetTitle);
  const offerCollectibleStyle = explicitCollectibleVehicleStyle(offerTitle);
  if (targetCollectibleStyle && offerCollectibleStyle && targetCollectibleStyle !== offerCollectibleStyle) {
    conflicts.push(`explicit_collectible_style_conflict:${targetCollectibleStyle}!=${offerCollectibleStyle}`);
  }

  const targetWiringTopology = explicitWiringTopology(targetTitle);
  const offerWiringTopology = explicitWiringTopology(offerTitle);
  if (targetWiringTopology && offerWiringTopology && targetWiringTopology !== offerWiringTopology) {
    conflicts.push(`explicit_wiring_topology_conflict:${targetWiringTopology}!=${offerWiringTopology}`);
  }

  const targetBluetoothVersions = explicitBluetoothVersions(targetTitle);
  const offerBluetoothVersions = explicitBluetoothVersions(offerTitle);
  if (targetBluetoothVersions.size === 1 && offerBluetoothVersions.size === 1
    && [...targetBluetoothVersions][0] !== [...offerBluetoothVersions][0]) {
    conflicts.push(`explicit_bluetooth_version_conflict:${[...targetBluetoothVersions][0]}!=${[...offerBluetoothVersions][0]}`);
  }

  const targetEcosystems = smartEcosystemsInText(targetTitle);
  const offerEcosystems = smartEcosystemsInText(offerTitle);
  if (targetEcosystems.size === 1 && offerEcosystems.size === 1
    && [...targetEcosystems][0] !== [...offerEcosystems][0]) {
    conflicts.push(`explicit_smart_ecosystem_conflict:${[...targetEcosystems][0]}!=${[...offerEcosystems][0]}`);
  }

  const targetRole = explicitProductRole(targetTitle);
  const offerRole = explicitProductRole(offerTitle);
  if (targetRole && offerRole && targetRole !== offerRole) {
    conflicts.push(`explicit_product_role_conflict:${targetRole}!=${offerRole}`);
  }

  for (const [name, suffix, label] of [
    ["voltage_v", "v", "voltage"],
    ["current_a", "a", "current"],
    ["power_w", "w", "power"],
  ]) {
    const expected = oneExplicitValue(new Set([
      ...explicitMetricValues(targetTitle, name),
      ...explicitMetricValues(target?.[name], name),
    ]));
    const observed = explicitMetricValues(offerTitle, name);
    if (expected && observed.size && !(observed.size === 1 && observed.has(expected))) {
      conflicts.push(`explicit_${label}_conflict:${expected}${suffix}!=${[...observed].map((item) => `${item}${suffix}`).join("|")}`);
    }
  }

  const targetDirections = connectorDirectionsInText(targetTitle);
  const offerDirections = connectorDirectionsInText(offerTitle);
  if (targetDirections.size === 1 && offerDirections.size === 1
    && [...targetDirections][0] !== [...offerDirections][0]) {
    conflicts.push(`explicit_connector_direction_conflict:${[...targetDirections][0]}!=${[...offerDirections][0]}`);
  }

  const targetAirpods = airpodsGenerationsInText(targetTitle);
  const offerAirpods = airpodsGenerationsInText(offerTitle);
  if (targetAirpods.size && offerAirpods.size
    && ![...targetAirpods].some((generation) => offerAirpods.has(generation))) {
    conflicts.push(`explicit_airpods_generation_conflict:${[...targetAirpods].join("|")}!=${[...offerAirpods].join("|")}`);
  }

  const targetPartNumbers = automotivePartNumberTokens(targetTitle);
  const offerPartNumbers = automotivePartNumberTokens(offerTitle);
  if (targetPartNumbers.size && offerPartNumbers.size
    && ![...targetPartNumbers].some((partNumber) => offerPartNumbers.has(partNumber))) {
    conflicts.push(`explicit_automotive_part_number_conflict:${[...targetPartNumbers].join("|")}!=${[...offerPartNumbers].join("|")}`);
  }

  const targetColors = supplyColorsInText(targetTitle);
  const offerColors = supplyColorsInText(offerTitle);
  if (targetColors.size === 1 && offerColors.size === 1
    && [...targetColors][0] !== [...offerColors][0]) {
    conflicts.push(`explicit_color_conflict:${[...targetColors][0]}!=${[...offerColors][0]}`);
  }
  return conflicts;
}

// These two identity facts are safe to enforce before variant matching as
// well: neither turns missing text into a failure, and both are mutually
// exclusive when they are explicitly present on the two product titles.
function explicitRoleAndProtocolConflicts({ targetTitle, candidate, target }) {
  const offerTitle = String(candidate?.image_match_evidence?.title || "");
  const conflicts = brandedCoreDigitalCandidateConflicts({ targetTitle, offerTitle, target });
  if (!offerTitle) return conflicts;
  conflicts.push(...declaredTargetIdentityBindingConflicts({
    expect_title: targetTitle,
    expect_model: target?.model,
  }, offerTitle));
  conflicts.push(...explicitTitleIdentityConflicts({ targetTitle, offerTitle, target }));
  const targetRole = productAccessoryRole(targetTitle);
  const offerRole = productAccessoryRole(offerTitle);
  if (targetRole && offerRole && targetRole !== offerRole) conflicts.push("core_accessory_conflict");
  const targetProtocol = wirelessProtocolsInText(`${targetTitle || ""} ${target?.wireless_protocol || ""}`);
  const offerProtocol = wirelessProtocolsInText(offerTitle);
  if (targetProtocol.size === 1 && offerProtocol.size === 1
    && [...targetProtocol][0] !== [...offerProtocol][0]) conflicts.push("explicit_wireless_protocol_conflict");
  return conflicts;
}

function imagePrimaryIdentityConflicts({ targetTitle, candidate, target }) {
  const offerTitle = String(candidate?.image_match_evidence?.title || "");
  const conflicts = [];
  if (!offerTitle) return ["missing_offer_identity_title"];
  const expectedColor = target?.color;
  const offerColors = colorsInText(offerTitle);
  if (expectedColor && offerColors.size && !offerColors.has(expectedColor)) conflicts.push("explicit_color_conflict");
  const targetKind = productIdentityKind(targetTitle);
  const offerKind = productIdentityKind(offerTitle);
  if (targetKind && offerKind && targetKind !== offerKind) conflicts.push("wrong_product_type");
  conflicts.push(...explicitRoleAndProtocolConflicts({ targetTitle, candidate, target }));
  const targetHeads = headCounts(targetTitle);
  const offerHeads = headCounts(offerTitle);
  const expectedHeadCount = Number(target?.head_count) || (targetHeads.size === 1 ? [...targetHeads][0] : null);
  if (expectedHeadCount && offerHeads.size && !offerHeads.has(expectedHeadCount)) {
    conflicts.push("explicit_head_count_conflict");
  }
  return conflicts;
}

function explicitMetricValues(value, metric) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  const patterns = {
    capacity_ml: /(?<![\d.])(\d+(?:[.,]\d+)?)\s*(毫升|ml|мл|升|l|л|литр(?:а|ов)?)(?![a-zа-яё0-9])/giu,
    length_mm: /(?<![\d.])(\d+(?:[.,]\d+)?)\s*(毫米|mm|мм)(?![a-zа-яё0-9])/giu,
    voltage_v: /(?:(?<![a-zа-яё0-9.])|(?<=[vawв]))(\d+(?:[.,]\d+)?)\s*(v|в|вольт(?:а|ов)?|伏特?)(?![a-zа-яё])/giu,
    current_a: /(?:(?<![a-zа-яё0-9.])|(?<=[vawв]))(\d+(?:[.,]\d+)?)\s*(a|а|amps?|ампер(?:а|ов)?|安培?)(?![a-zа-яё])/giu,
    power_w: /(?:(?<![a-zа-яё0-9.])|(?<=[vawв]))(\d+(?:[.,]\d+)?)\s*(w|вт|watts?|ватт(?:а|ов)?|瓦)(?![a-zа-яё])/giu,
    // A Kelvin suffix may be followed directly by a Chinese light-colour
    // label (for example `3000K暖白`).  Keep Latin/Cyrillic word boundaries
    // strict, while allowing that common compound 1688 label.
    cct_k: /(?:(?<![\p{L}\p{N}.])|(?<=[vawk]))(\d{4})\s*(k|к)(?![a-zа-яё0-9])/giu,
  };
  const pattern = patterns[metric];
  if (!pattern) return new Set();
  const result = new Set();
  for (const match of source.matchAll(pattern)) {
    const numeric = Number(String(match[1]).replace(",", "."));
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    const unit = String(match[2] || "").toLocaleLowerCase("und");
    const scaled = metric === "capacity_ml" && /^(?:升|l|л|литр)/iu.test(unit)
      ? numeric * 1_000
      : numeric;
    result.add(String(Math.round(scaled * 1_000_000) / 1_000_000));
  }
  return result;
}

function oneExplicitValue(values) {
  return values.size === 1 ? [...values][0] : null;
}

function explicitMetricBinding(name, expected, attributes = {}) {
  const metric = name === "capacity" ? "capacity_ml"
    : name === "size" ? "length_mm"
      : new Set(["voltage_v", "current_a", "power_w", "cct_k"]).has(name) ? name : null;
  if (!metric) return null;
  const expectedValue = oneExplicitValue(explicitMetricValues(expected, metric));
  if (!expectedValue) return null;
  const sources = name === "capacity"
    ? [attributes.capacity, attributes.size]
    : name === "size" ? [attributes.size] : [attributes[name], attributes.size];
  const observed = new Set(sources.flatMap((value) => [...explicitMetricValues(value, metric)]));
  if (!observed.size) return { observed: false, matches: false, expected_value: expectedValue };
  return {
    observed: true,
    matches: observed.size === 1 && observed.has(expectedValue),
    expected_value: expectedValue,
    observed_values: [...observed],
  };
}

/**
 * Image similarity may choose one auditable SKU thumbnail while the selected
 * row label still names a different explicit variant. Missing text remains a
 * soft difference; only visible contradictions fail closed here.
 */
function imagePrimarySelectedRowConflicts({
  targetTitle,
  target,
  rowText,
  rowModel = null,
  enforceBrandedDigitalModel = false,
}) {
  const conflicts = explicitTitleIdentityConflicts({ targetTitle, offerTitle: rowText, target });
  if (enforceBrandedDigitalModel) {
    conflicts.push(...brandedCoreDigitalSelectedRowConflicts({ targetTitle, target, rowText, rowModel }));
  }
  const targetCapacity = oneExplicitValue(new Set([
    ...explicitMetricValues(targetTitle, "capacity_ml"),
    ...explicitMetricValues(target?.capacity, "capacity_ml"),
  ]));
  const rowCapacity = oneExplicitValue(explicitMetricValues(rowText, "capacity_ml"));
  if (targetCapacity && rowCapacity && targetCapacity !== rowCapacity) {
    conflicts.push(`explicit_capacity_conflict:${targetCapacity}ml!=${rowCapacity}ml`);
  }

  const targetMillimetres = oneExplicitValue(new Set([
    ...explicitMetricValues(targetTitle, "length_mm"),
    ...explicitMetricValues(target?.size, "length_mm"),
  ]));
  const rowMillimetres = oneExplicitValue(explicitMetricValues(rowText, "length_mm"));
  if (targetMillimetres && rowMillimetres && targetMillimetres !== rowMillimetres) {
    conflicts.push(`explicit_mm_conflict:${targetMillimetres}mm!=${rowMillimetres}mm`);
  }

  for (const [name, suffix, label] of [
    ["voltage_v", "v", "voltage"],
    ["current_a", "a", "current"],
    ["power_w", "w", "power"],
    ["cct_k", "k", "cct"],
  ]) {
    const expected = oneExplicitValue(new Set([
      ...explicitMetricValues(targetTitle, name),
      ...explicitMetricValues(target?.[name], name),
    ]));
    const observed = explicitMetricValues(rowText, name);
    if (expected && observed.size && !(observed.size === 1 && observed.has(expected))) {
      conflicts.push(`explicit_${label}_conflict:${expected}${suffix}!=${[...observed].map((value) => `${value}${suffix}`).join("|")}`);
    }
  }

  const targetHdmi = new Set([
    ...hdmiSubtypeValues(targetTitle),
    ...hdmiSubtypeValues(target?.interface),
  ]);
  const rowHdmi = hdmiSubtypeValues(rowText);
  if (targetHdmi.size === 1 && rowHdmi.size
    && !(rowHdmi.size === 1 && rowHdmi.has([...targetHdmi][0]))) {
    conflicts.push(`explicit_interface_conflict:${[...targetHdmi][0]}!=${[...rowHdmi].join("|")}`);
  }

  const targetProtocol = wirelessProtocolsInText(`${targetTitle || ""} ${target?.wireless_protocol || ""}`);
  const rowProtocol = wirelessProtocolsInText(rowText);
  if (targetProtocol.size === 1 && rowProtocol.size === 1
    && [...targetProtocol][0] !== [...rowProtocol][0]) {
    conflicts.push(`explicit_wireless_protocol_conflict:${[...targetProtocol][0]}!=${[...rowProtocol][0]}`);
  }

  const targetRole = productAccessoryRole(targetTitle);
  const rowRole = productAccessoryRole(rowText);
  if (targetRole && rowRole && targetRole !== rowRole) conflicts.push("core_accessory_conflict");

  const titleColors = colorsInText(targetTitle);
  const expectedColor = target?.color || (titleColors.size === 1 ? [...titleColors][0] : null);
  if (expectedColor && /随机(?:发货)?|random(?:ly|\s+colou?r)?|assorted(?:\s+colou?rs?)?|случайн/iu.test(rowText)) {
    conflicts.push(`explicit_random_color_conflict:${expectedColor}`);
  } else if (expectedColor) {
    const rowColors = colorsInText(rowText);
    if (rowColors.size && !(rowColors.size === 1 && rowColors.has(expectedColor))) {
      conflicts.push(`explicit_color_conflict:${expectedColor}!=${[...rowColors].join("|")}`);
    }
  }
  return conflicts;
}

function epoch(value) {
  const raw = typeof value === "function" ? value() : value;
  if (raw instanceof Date) return raw.getTime();
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;
  return Date.parse(String(raw));
}

export function isFreshSupplyEvidence(evidence, { now = Date.now } = {}) {
  const current = epoch(now);
  const checkedAt = Date.parse(String(evidence?.checked_at || ""));
  const validUntil = Date.parse(String(evidence?.valid_until || ""));
  return evidence?.contract === SUPPLY_EVIDENCE_CONTRACT
    && evidence?.passed === true
    && evidence?.platform === "1688"
    && Number.isFinite(current)
    && Number.isFinite(checkedAt)
    && Number.isFinite(validUntil)
    && validUntil > checkedAt
    && validUntil - checkedAt <= SUPPLY_EVIDENCE_TTL_MS
    && checkedAt <= current
    && current < validUntil;
}

function offerIdFrom(value) {
  const explicit = text(value?.offer_id ?? value?.offerId ?? value?.id);
  if (explicit) return explicit;
  try {
    return decodeURIComponent(new URL(String(value?.offer_url ?? value?.offerUrl ?? value?.url ?? ""))
      .pathname.match(/\/offer\/([^/]+?)\.html/iu)?.[1] || "");
  } catch {
    return "";
  }
}

function normalizeCandidate(value, fallbackMatchType, matchEvidenceKey) {
  const offerId = offerIdFrom(value);
  if (!offerId || !/^\d+$/u.test(offerId)) return null;
  const matchType = text(value?.match_type ?? value?.matchType ?? value?.balanced_match_type ?? fallbackMatchType);
  return {
    ...value,
    offer_id: offerId,
    offer_url: `https://detail.1688.com/offer/${encodeURIComponent(offerId)}.html`,
    match_type: matchType,
    match_evidence_key: text(value?.match_evidence_key ?? matchEvidenceKey),
  };
}

function strictCandidates(input, balancedMatch, matchEvidenceKey, maximum) {
  if (balancedMatch && balancedMatch.passed !== true) return [];
  const rows = Array.isArray(input) ? input : Array.isArray(input?.rows) ? input.rows : [];
  const fallbackType = text(balancedMatch?.match_type ?? input?.balanced_match_type);
  const supporting = new Set((balancedMatch?.supporting_offer_ids || []).map(text).filter(Boolean));
  const seen = new Set();
  return rows.flatMap((row) => {
    const candidate = normalizeCandidate(row, fallbackType, matchEvidenceKey);
    if (!candidate || seen.has(candidate.offer_id) || !STRICT_MATCH_TYPES.has(candidate.match_type)) return [];
    if (supporting.size && !supporting.has(candidate.offer_id)) return [];
    seen.add(candidate.offer_id);
    return [candidate];
  }).slice(0, Math.min(3, Math.max(1, Number(maximum) || 3)));
}

function parseJson(value) {
  if (value && typeof value === "object") return value;
  const source = String(value || "").trim();
  try { return JSON.parse(source); } catch {}
  const firstObject = source.indexOf("{");
  const lastObject = source.lastIndexOf("}");
  const firstArray = source.indexOf("[");
  const lastArray = source.lastIndexOf("]");
  const candidates = [
    firstObject >= 0 && lastObject > firstObject ? source.slice(firstObject, lastObject + 1) : "",
    firstArray >= 0 && lastArray > firstArray ? source.slice(firstArray, lastArray + 1) : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

function walkStructured(values, visit) {
  const queue = (Array.isArray(values) ? values : [values]).map(parseJson).filter(Boolean);
  const seen = new Set();
  let count = 0;
  while (queue.length && count < 10_000) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    count += 1;
    visit(current);
    if (Array.isArray(current)) queue.push(...current);
    else queue.push(...Object.values(current).filter((entry) => entry && typeof entry === "object"));
  }
}

function finiteNumber(value) {
  if (value && typeof value === "object") value = value.value ?? value.price ?? value.amount;
  const match = text(value).replace(/,/gu, "").match(/\d+(?:\.\d+)?/u);
  const number = Number(match?.[0]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function currencyPrices(value) {
  const result = [];
  const source = text(value).replace(/(\d)\s*([.,])\s*(\d)/gu, "$1$2$3");
  const pattern = /(?:¥|￥|CNY|RMB)\s*(\d+(?:[.,]\d+)?)(?:\s*[-~至]\s*(?:¥|￥)?\s*(\d+(?:[.,]\d+)?))?|(?<!\d)(\d+(?:[.,]\d+)?)\s*元/giu;
  for (const match of source.matchAll(pattern)) {
    for (const raw of [match[1], match[2], match[3]]) {
      const parsed = Number(String(raw || "").replace(",", "."));
      if (Number.isFinite(parsed) && parsed > 0) result.push(parsed);
    }
  }
  return result;
}

function sanePrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 && price <= 100_000 ? price : null;
}

function moqsFromText(value) {
  const result = [];
  const source = text(value);
  const patterns = [
    /(?:起批量|起订量|最小起订量|MOQ|minimum order)\s*[:：]?\s*[≥>=]?\s*(\d+(?:\.\d+)?)/giu,
    /(\d+(?:\.\d+)?)\s*(?:件|个|套|盒|pcs?)\s*起批/giu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > 0) result.push(parsed);
    }
  }
  return result;
}

function boolValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  const normalized = text(value).toLocaleLowerCase("und");
  if (/^(?:true|yes|1|instock|in_stock|available|有货|可购买)$/iu.test(normalized)) return true;
  if (/^(?:false|no|0|outofstock|out_of_stock|soldout|unavailable|缺货|无货)$/iu.test(normalized)) return false;
  return null;
}

function structuredSkuIds(object) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return [];
  return [...new Set(Object.entries(object).flatMap(([name, value]) => {
    if (!/(?:sku|variant)(?:id|key)$/iu.test(keyText(name))) return [];
    const id = text(value).toLocaleLowerCase("und");
    return id ? [id] : [];
  }))];
}

function inspectStructured(structuredData, target) {
  const prices = [];
  const offerPrices = [];
  const moqs = [];
  const stocks = [];
  const orderable = [];
  const attributes = {};
  const variants = [];
  let variantCount = 0;
  for (const rawRoot of Array.isArray(structuredData) ? structuredData : [structuredData]) {
    const root = parseJson(rawRoot);
    if (!root || typeof root !== "object" || Array.isArray(root)) continue;
    for (const key of ["beginAmount", "startQuantity"]) {
      const parsed = finiteNumber(root[key]);
      if (parsed) moqs.push(parsed);
    }
  }
  walkStructured(structuredData, (object) => {
    if (Array.isArray(object)) return;
    const localAttrs = attributesFrom(object);
    Object.assign(attributes, localAttrs);
    const normalizedKeys = Object.entries(object).map(([name, value]) => [keyText(name), value]);
    const tradeModel = object.tradeModel ?? object.trade_model;
    if (tradeModel && typeof tradeModel === "object") {
      for (const key of ["beginAmount", "startQuantity"]) {
        const parsed = finiteNumber(tradeModel[key]);
        if (parsed) moqs.push(parsed);
      }
    }
    const looksLikeTradeModel = Object.hasOwn(object, "canBookedAmount")
      || Object.hasOwn(object, "canBookCount")
      || Object.hasOwn(object, "offerPriceModel");
    if (looksLikeTradeModel) {
      for (const key of ["beginAmount", "startQuantity"]) {
        const parsed = finiteNumber(object[key]);
        if (parsed) moqs.push(parsed);
      }
    }
    for (const [rawName, value] of Object.entries(object)) {
      if (keyText(rawName) !== "currentprices" || !Array.isArray(value)) continue;
      const firstTier = value
        .map((row) => finiteNumber(row?.beginAmount ?? row?.startQuantity))
        .filter(Boolean);
      if (firstTier.length) moqs.push(Math.min(...firstTier));
      for (const row of value) {
        const parsed = finiteNumber(row?.price ?? row?.offerPrice ?? row?.salePrice ?? row?.unitPrice);
        if (parsed) offerPrices.push(parsed);
      }
    }
    for (const [name, value] of normalizedKeys) {
      if (PRICE_KEYS.has(name)) {
        const parsed = finiteNumber(value);
        if (parsed) prices.push(parsed);
      }
      if (MOQ_KEYS.has(name)) {
        const parsed = finiteNumber(value);
        if (parsed) moqs.push(parsed);
      }
      if (STOCK_KEYS.has(name)) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) stocks.push(parsed > 0);
      }
      if (name === "availability") {
        const parsed = boolValue(String(value).split("/").pop());
        if (parsed !== null) stocks.push(parsed);
      }
      if (ORDERABLE_KEYS.has(name)) {
        const parsed = boolValue(value);
        if (parsed !== null) orderable.push(parsed);
      }
    }
    const isVariant = Object.keys(object).some((name) => VARIANT_CONTAINER_KEYS.has(keyText(name)))
      || ((object.skuId || object.sku_id || object.variantId || object.variant_id) && Object.keys(localAttrs).length);
    if (isVariant) {
      for (const [name, rows] of Object.entries(object)) {
        if (!VARIANT_CONTAINER_KEYS.has(keyText(name)) || !Array.isArray(rows)) continue;
        variantCount = Math.max(variantCount, rows.length);
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const attrs = attributesFrom(row);
          const skuIds = structuredSkuIds(row);
          if (!Object.keys(attrs).length && !skuIds.length) continue;
          const rowPrices = Object.entries(row)
            .filter(([key]) => PRICE_KEYS.has(keyText(key))).map(([, value]) => finiteNumber(value)).filter(Boolean);
          const stockEntry = Object.entries(row).find(([key]) => STOCK_KEYS.has(keyText(key)) || keyText(key) === "availability");
          const orderEntry = Object.entries(row).find(([key]) => ORDERABLE_KEYS.has(keyText(key)));
          variants.push({
            sku_ids: skuIds,
            attributes: attrs,
            price: rowPrices.length ? Math.max(...rowPrices) : null,
            stock: stockEntry ? (keyText(stockEntry[0]) === "availability"
              ? boolValue(String(stockEntry[1]).split("/").pop()) : Number(stockEntry[1]) > 0) : null,
            orderable: orderEntry ? boolValue(orderEntry[1]) : null,
          });
        }
      }
    }
  });
  const targetKeys = Object.keys(target);
  const variantKeys = new Set(variants.flatMap((variant) => Object.keys(variant.attributes)));
  const relevant = targetKeys.filter((key) => variantKeys.has(key));
  const matchingVariants = relevant.length
    ? variants.filter((variant) => relevant.every((key) => variant.attributes[key] === target[key]))
    : [];
  const selectedVariant = matchingVariants.length === 1 ? matchingVariants[0] : null;
  return {
    prices, offerPrices, moqs, stocks, orderable, attributes, variants, variantCount, relevant,
    matchingVariants, selectedVariant,
  };
}

function quantityRowAttributes(row) {
  if (!row || typeof row !== "object") return {};
  return attributesFrom({
    ...(row.variant_attributes && typeof row.variant_attributes === "object" ? row.variant_attributes : {}),
    ...(row.structured_variant_attributes && typeof row.structured_variant_attributes === "object"
      ? row.structured_variant_attributes : {}),
    attributes: row.specifications,
  });
}

function quantityRowSkuIds(row, interaction = null) {
  const values = [
    ...(Array.isArray(row?.sku_ids) ? row.sku_ids : []),
    ...(Array.isArray(row?.skuIds) ? row.skuIds : []),
    ...(Array.isArray(interaction?.sku_ids) ? interaction.sku_ids : []),
    ...(Array.isArray(interaction?.skuIds) ? interaction.skuIds : []),
  ];
  return [...new Set(values.map((value) => text(value).toLocaleLowerCase("und")).filter(Boolean))];
}

function quantityRowImageUrls(row) {
  const values = [
    ...(Array.isArray(row?.sku_image_urls) ? row.sku_image_urls : []),
    ...(Array.isArray(row?.skuImageUrls) ? row.skuImageUrls : []),
    row?.sku_image_url,
    row?.skuImageUrl,
    row?.thumbnail_url,
    row?.thumbnailUrl,
  ];
  return [...new Set(values.map(canonicalAlibabaImageAssetUrl).filter(Boolean))];
}

function conservativeBoolean(values) {
  const known = values.filter((value) => value === true || value === false);
  if (known.includes(false)) return false;
  return known.includes(true) ? true : null;
}

function selectedRowStockSignal(row) {
  const stockCountRaw = row?.stock_count ?? row?.stockCount;
  if (stockCountRaw !== null && stockCountRaw !== undefined && String(stockCountRaw).trim() !== "") {
    const stockCount = Number(stockCountRaw);
    if (Number.isFinite(stockCount) && stockCount >= 0) return stockCount > 0;
  }
  const explicit = boolValue(row?.stock ?? row?.in_stock ?? row?.inStock ?? row?.available);
  if (explicit !== null) return explicit;
  const source = text(row?.context_text ?? row?.contextText ?? row?.row_text ?? row?.rowText);
  if (/库存不足|已售罄|售罄|缺货|无货|out of stock|sold out/iu.test(source)) return false;
  const count = source.match(/(?:库存|可售|可订)数?量?\s*[:：]?\s*(\d+(?:\.\d+)?)/iu)?.[1];
  if (count !== undefined) return Number(count) > 0;
  if (/现货|有货|in stock|available/iu.test(source)) return true;
  return null;
}

function selectedRowOrderableSignal(row) {
  return boolValue(row?.orderable ?? row?.buyable ?? row?.can_buy ?? row?.canBuy);
}

function domRows(snapshot, snake, camel) {
  const dom = snapshot?.dom_snapshot ?? snapshot?.dom ?? {};
  const value = dom?.[snake] ?? dom?.[camel] ?? snapshot?.[snake] ?? snapshot?.[camel];
  return Array.isArray(value) ? value : [];
}

function failure(reasonCode, reason, { transient = false, authentication = false } = {}) {
  return {
    ok: false,
    passed: false,
    supply_gate_passed: false,
    status: transient ? "deferred" : "blocked",
    classification: transient ? "transient_failure" : "deterministic_failure",
    reason,
    reason_code: reasonCode,
    retryable: transient,
    transient,
    deterministic: !transient,
    ...(authentication ? { global_gate_closed: true, alert_required: true } : {}),
  };
}

function valid1688Url(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" && (parsed.hostname === "1688.com" || parsed.hostname.endsWith(".1688.com"));
  } catch { return false; }
}

export function classify1688SupplySnapshot(snapshot = {}, {
  candidate,
  targetVariant = null,
  targetTitle = null,
  itemLevelMatch = false,
  matchEvidenceKey = null,
  variantMatchMode = "exact",
  now = Date.now,
  evidenceTtlMs = SUPPLY_EVIDENCE_TTL_MS,
} = {}) {
  const url = text(snapshot.url || candidate?.offer_url);
  const title = text(snapshot.title);
  const body = text(snapshot.body ?? snapshot.text);
  const security = text(snapshot.security_text);
  const allText = `${url}\n${title}\n${security}\n${body}`;
  const status = Number(snapshot.http_status ?? snapshot.httpStatus);
  if (/login\.(?:1688|taobao)\.com|passport\.(?:1688|taobao)\.com|请先登录|登录后(?:才能)?查看|重新登录|登录已失效|会话失效|会员登录/iu.test(allText)) {
    return failure("authentication_required", "1688 authentication is required or expired", { transient: true, authentication: true });
  }
  if (/captcha|验证码|滑块验证|安全验证|访问过于频繁|机器人验证|人机验证/iu.test(allText)) {
    return failure("captcha", "1688 captcha or anti-bot verification is present", { transient: true });
  }
  if (Number.isFinite(status) && (status === 429 || status >= 500)) {
    return failure("http_transient", `1688 returned transient HTTP ${status}`, { transient: true });
  }
  if (Number.isFinite(status) && [404, 410].includes(status)) {
    return failure("offer_offline", `1688 offer returned HTTP ${status}`);
  }
  if (!valid1688Url(url)) return failure("unexpected_final_url", "1688 offer redirected to a non-1688 page", { transient: true });
  if (/商品(?:已经|已)?(?:下架|删除|失效)|商品不存在|页面不存在|找不到该商品|offer (?:offline|removed|not found)/iu.test(allText)) {
    return failure("offer_offline", "1688 offer is offline, removed, or unavailable");
  }

  const target = normalizeTargetVariant(targetVariant);
  const required = targetVariant?.required === true || Object.keys(target).length > 0;
  const imagePrimary = variantMatchMode === "image_primary";
  const explicitCandidateConflicts = explicitRoleAndProtocolConflicts({ targetTitle, candidate, target });
  if (explicitCandidateConflicts.length) {
    return failure(
      "image_identity_conflict",
      `1688 candidate has an explicit identity conflict: ${explicitCandidateConflicts.join(", ")}`,
    );
  }
  const imageAssessment = imagePrimary ? assessImagePrimaryCandidate(candidate) : null;
  if (imagePrimary && !imageAssessment?.ok) {
    return failure("image_evidence_invalid", `trusted image-primary evidence is not sufficient: ${imageAssessment?.reason || "missing"}`);
  }
  if (imagePrimary && Number(target.set_quantity) > 1) {
    return failure("image_primary_bundle_unpriced", "image-primary matching cannot yet price a multi-piece Ozon bundle safely");
  }
  if (imagePrimary) {
    const identityConflicts = imagePrimaryIdentityConflicts({ targetTitle, candidate, target });
    if (identityConflicts.length) {
      return failure("image_identity_conflict", `image-primary candidate has an explicit identity conflict: ${identityConflicts.join(", ")}`);
    }
  }
  if (required && !Object.keys(target).length) return failure("variant_unbound", "target variant has no bindable specification attributes");
  const structured = inspectStructured(
    snapshot.structured_data ?? snapshot.structuredData ?? snapshot.json ?? [], target,
  );
  const interaction = snapshot.interaction && typeof snapshot.interaction === "object"
    ? snapshot.interaction
    : {};
  const interactionSpecs = interaction.specs && typeof interaction.specs === "object"
    ? interaction.specs
    : {};
  const quantityInputs = domRows(snapshot, "quantity_inputs", "quantityInputs");
  const quantityInteraction = interaction.quantity && typeof interaction.quantity === "object"
    ? interaction.quantity
    : null;
  if (quantityInteraction?.found === false || !quantityInputs.length) {
    return failure("quantity_unconfirmed", "quantity input could not be found for the target 1688 SKU row");
  }
  if (quantityInteraction?.reason_code === "variant_unbound") {
    return failure("variant_unbound", "target specification did not bind to exactly one 1688 SKU quantity row");
  }
  if (quantityInteraction?.reason_code === "spec_mismatch") {
    const interactionRowAttributes = attributesFrom({
      ...(quantityInteraction?.observed_variant_attributes || {}),
      ...(quantityInteraction?.variant_attributes || {}),
    });
    const selectedRowConflicts = imagePrimarySelectedRowConflicts({
      targetTitle,
      target,
      rowText: text(quantityInteraction?.row_text),
      rowModel: interactionRowAttributes.model,
      enforceBrandedDigitalModel: imagePrimary,
    });
    return failure(
      "spec_mismatch",
      selectedRowConflicts.length
        ? `selected 1688 SKU row explicitly conflicts with the target: ${selectedRowConflicts.join(", ")}`
        : "the exact signed 1688 SKU thumbnail row explicitly conflicts with the target specification",
    );
  }
  if (imagePrimary && quantityInteraction?.soft_tie === true) {
    return failure("variant_unbound", "image-primary target is tied across multiple 1688 SKU rows");
  }
  const imageSelectionMethod = text(quantityInteraction?.selection_method);
  if (imagePrimary && !new Set([
    "image_primary_best_target_overlap",
    IMAGE_PRIMARY_EXACT_THUMBNAIL_SELECTION_METHOD,
  ]).has(imageSelectionMethod)) {
    return failure("variant_unbound", "image-primary target does not have one auditable selected SKU row");
  }
  let boundQuantityRow = null;
  if (quantityInteraction?.row_key) {
    boundQuantityRow = quantityInputs.find((row) => text(row?.row_key ?? row?.rowKey) === text(quantityInteraction.row_key)) || null;
  }
  if (!boundQuantityRow && Number.isInteger(quantityInteraction?.row_index) && quantityInteraction.row_index >= 0) {
    boundQuantityRow = quantityInputs[quantityInteraction.row_index] || null;
  }
  if (!boundQuantityRow && quantityInputs.length === 1) {
    boundQuantityRow = quantityInputs[0];
  }
  if (required && quantityInputs.length > 1 && !boundQuantityRow) {
    return failure("variant_unbound", "the selected 1688 SKU quantity row was not uniquely identified after interaction");
  }
  let selectedSkuImageUrl = null;
  if (imagePrimary && imageSelectionMethod === IMAGE_PRIMARY_EXACT_THUMBNAIL_SELECTION_METHOD) {
    selectedSkuImageUrl = canonicalAlibabaImageAssetUrl(quantityInteraction?.selected_sku_image_url);
    const signedOfferImageUrl = canonicalAlibabaImageAssetUrl(imageAssessment?.evidence?.image_url);
    const rowsMatchingSignedImage = quantityInputs.filter((row) => (
      quantityRowImageUrls(row).includes(signedOfferImageUrl)
    ));
    if (
      !selectedSkuImageUrl
      || selectedSkuImageUrl !== signedOfferImageUrl
      || Number(quantityInteraction?.thumbnail_match_count) !== 1
      || rowsMatchingSignedImage.length !== 1
      || rowsMatchingSignedImage[0] !== boundQuantityRow
      || !quantityRowImageUrls(boundQuantityRow).includes(selectedSkuImageUrl)
    ) {
      return failure("variant_unbound", "image-primary thumbnail evidence does not uniquely bind the selected 1688 SKU row");
    }
  }
  if (boundQuantityRow) {
    const selectedRowText = text(
      quantityInteraction?.row_text
      ?? boundQuantityRow?.context_text
      ?? boundQuantityRow?.contextText
      ?? boundQuantityRow?.row_text
      ?? boundQuantityRow?.rowText,
    );
    const selectedRowAttributes = attributesFrom({
      ...(quantityInteraction?.observed_variant_attributes || {}),
      ...(quantityInteraction?.variant_attributes || {}),
      ...quantityRowAttributes(boundQuantityRow),
    });
    const selectedRowConflicts = imagePrimarySelectedRowConflicts({
      targetTitle,
      target,
      rowText: selectedRowText,
      rowModel: selectedRowAttributes.model,
      enforceBrandedDigitalModel: imagePrimary,
    });
    if (selectedRowConflicts.length) {
      return failure(
        "spec_mismatch",
        `selected 1688 SKU row explicitly conflicts with the target: ${selectedRowConflicts.join(", ")}`,
      );
    }
  }
  const rowAttributes = {
    ...(boundQuantityRow && quantityInteraction?.observed_variant_attributes
      ? attributesFrom(quantityInteraction.observed_variant_attributes) : {}),
    ...(boundQuantityRow && quantityInteraction?.variant_attributes
      ? attributesFrom(quantityInteraction.variant_attributes) : {}),
    ...quantityRowAttributes(boundQuantityRow),
  };
  const selectedSkuIds = quantityRowSkuIds(boundQuantityRow, quantityInteraction);
  const boundStructuredVariants = selectedSkuIds.length
    ? structured.variants.filter((variant) => variant.sku_ids.some((id) => selectedSkuIds.includes(id)))
    : [];
  const boundStructuredStock = conservativeBoolean(boundStructuredVariants.map((variant) => variant.stock));
  const boundStructuredOrderable = conservativeBoolean(boundStructuredVariants.map((variant) => variant.orderable));
  const options = domRows(snapshot, "spec_options", "specOptions").map((row) => ({
    name: canonicalSpecName(row?.group ?? row?.name ?? row?.property ?? row?.prop_name),
    value: normalizeSupplySpecValue(row?.value ?? row?.label ?? row?.text, canonicalSpecName(row?.group ?? row?.name ?? row?.property ?? row?.prop_name)),
    disabled: row?.disabled === true || row?.available === false || Number(row?.stock) === 0
      || /disabled|sold.?out|缺货|无货/iu.test(text(row?.className ?? row?.class_name)),
    selected: row?.selected === true || row?.checked === true || row?.aria_selected === true
      || row?.ariaSelected === true || row?.data_selected === true
      || /(?:^|[\s_-])(?:selected|active|current)(?:$|[\s_-])/iu.test(text(row?.className ?? row?.class_name)),
  })).filter((row) => row.name && row.value);
  const boundAttributes = {};
  const variantDifferences = [];
  for (const [name, expected] of Object.entries(target)) {
    const grouped = options.filter((row) => row.name === name);
    const exactOption = grouped.find((row) => row.value === expected
      || explicitMetricBinding(name, expected, { [name]: row.value })?.matches === true);
    const selection = interactionSpecs[name] && typeof interactionSpecs[name] === "object"
      ? interactionSpecs[name]
      : null;
    if (selection?.disabled === true) return failure("variant_unavailable", `target ${name} option is unavailable`);
    if (exactOption?.disabled) return failure("variant_unavailable", `target ${name} option is unavailable`);
    const metricBinding = explicitMetricBinding(name, expected, rowAttributes);
    const rowValue = metricBinding
      ? metricBinding.observed ? metricBinding.matches ? expected : "__explicit_metric_conflict__" : null
      : rowAttributes[name];
    if (metricBinding?.matches) rowAttributes[name] = expected;
    if (rowValue && rowValue !== expected) {
      return failure("spec_mismatch", `target ${name} does not match the uniquely bound 1688 SKU row`);
    }
    if (imagePrimary) {
      if (grouped.length && !exactOption) {
        return failure("spec_mismatch", `target ${name} explicitly conflicts with selectable 1688 options`);
      }
      if (rowValue === expected) boundAttributes[name] = expected;
      else if (exactOption && selection?.found === true && exactOption.selected === true) boundAttributes[name] = exactOption.value;
      else variantDifferences.push({ name, expected, observed: null, kind: "unbound_soft" });
      continue;
    }
    if (exactOption) {
      if (selection?.found !== true || exactOption.selected !== true) {
        return failure("variant_unbound", `target ${name} selection was not confirmed after interaction`);
      }
      boundAttributes[name] = exactOption.value;
    } else if (rowValue === expected) {
      boundAttributes[name] = expected;
    } else if (structured.selectedVariant?.attributes?.[name] === expected) {
      boundAttributes[name] = structured.selectedVariant.attributes[name];
    } else if (structured.attributes[name] === expected) {
      if (selection?.found === true) {
        return failure("variant_unbound", `target ${name} option disappeared before its selected state was confirmed`);
      }
      if (selection?.group_found === true) {
        return failure("spec_mismatch", `target ${name} does not match a selectable 1688 option`);
      }
      if (structured.relevant.includes(name)) {
        return failure("variant_unbound", `target ${name} is a SKU dimension but no selectable option was confirmed`);
      }
      return failure("variant_unbound", `target ${name} was only observed at offer level, not on the final SKU row or a confirmed option`);
    }
    else if (grouped.length || structured.attributes[name]) return failure("spec_mismatch", `target ${name} does not match the 1688 offer`);
    else return failure("variant_unbound", `target ${name} cannot be bound to a 1688 SKU or option`);
  }
  if (!imagePrimary && structured.relevant.length && !structured.selectedVariant) {
    return failure("spec_mismatch", "target specification combination does not match a 1688 SKU");
  }
  if (!imagePrimary && (boundStructuredStock === false || boundStructuredOrderable === false
    || structured.selectedVariant?.stock === false || structured.selectedVariant?.orderable === false)) {
    return failure("variant_unavailable", "target 1688 SKU is out of stock or not orderable");
  }
  if (imagePrimary && (boundStructuredStock === false || boundStructuredOrderable === false
    || selectedRowOrderableSignal(boundQuantityRow) === false)) {
    return failure("variant_unavailable", "selected 1688 SKU row is out of stock or not orderable");
  }

  if (!imagePrimary && !required && (quantityInputs.length > 1 || structured.variantCount > 1)) {
    return failure("variant_unbound", "1688 offer has multiple SKU quantity rows but the Ozon target variant is not bound");
  }
  const quantityMinimums = (boundQuantityRow ? [boundQuantityRow] : quantityInputs)
    .map((row) => finiteNumber(row?.min ?? row?.minimum))
    .filter(Boolean);
  const moqTexts = [body, ...domRows(snapshot, "moq_texts", "moqTexts").map((row) => text(row?.text ?? row))];
  const moqs = [...structured.moqs, ...moqTexts.flatMap(moqsFromText), ...quantityMinimums];
  const moq = moqs.length ? Math.max(...moqs) : null;
  if (!(moq > 0)) return failure("moq_unconfirmed", "1688 minimum order quantity is not confirmed");
  if (moq > 1) return failure("moq_above_one", `1688 minimum order quantity is ${moq}, not one`);
  const confirmedQuantity = boundQuantityRow && Number(boundQuantityRow?.value) === 1
    && boundQuantityRow?.disabled !== true && boundQuantityRow?.read_only !== true && boundQuantityRow?.readOnly !== true
    ? boundQuantityRow
    : null;
  if (quantityInteraction?.found !== true
    || quantityInteraction?.set !== true
    || Number(quantityInteraction?.value) !== 1
    || (quantityInteraction?.matched_rows !== undefined && Number(quantityInteraction.matched_rows) !== 1)
    || !confirmedQuantity) {
    return failure("quantity_unconfirmed", "quantity input could not be set to and confirmed at one");
  }

  const buttons = domRows(snapshot, "buttons", "buttons");
  const purchaseButtons = buttons.filter((row) => /立即订购|立即购买|一键下单|加入进货单|下单|buy now|order now/iu.test(text(row?.text ?? row?.label ?? row)));
  const activePurchase = purchaseButtons.some((row) => row?.disabled !== true && row?.aria_disabled !== true
    && row?.ariaDisabled !== true && !/disabled/iu.test(text(row?.className ?? row?.class_name)));
  const explicitOrderable = imagePrimary
    ? boundStructuredOrderable
    : structured.selectedVariant?.orderable ?? (structured.orderable.includes(true) ? true : null);
  if ((purchaseButtons.length && !activePurchase)
    || (imagePrimary && !activePurchase)
    || (!imagePrimary && !purchaseButtons.length && explicitOrderable !== true)) {
    return failure(purchaseButtons.length ? "not_orderable" : "orderability_unconfirmed", "a valid one-piece purchase button is not available");
  }
  const outOfStockText = /库存不足|已售罄|售罄|缺货|无货|out of stock|sold out/iu.test(allText);
  const explicitStock = imagePrimary
    ? boundStructuredStock
    : structured.selectedVariant?.stock ?? (structured.stocks.includes(true) ? true
      : structured.stocks.includes(false) ? false : null);
  const selectedRowStock = selectedRowStockSignal(confirmedQuantity);
  if (explicitStock === false || selectedRowStock === false || (!imagePrimary && explicitStock !== true && outOfStockText)) {
    return failure("out_of_stock", "target 1688 offer or SKU is out of stock");
  }
  if (imagePrimary && explicitStock !== true && selectedRowStock !== true) {
    return failure("stock_unconfirmed", "stock for the selected 1688 SKU row is not confirmed");
  }

  const mainPriceTexts = [
    ...domRows(snapshot, "main_price_texts", "mainPriceTexts"),
    ...domRows(snapshot, "price_texts", "priceTexts"),
  ].map((row) => text(row?.text ?? row));
  const mainPrices = mainPriceTexts.flatMap(currencyPrices).map(sanePrice).filter(Boolean);
  const explicitRowPrices = [
    confirmedQuantity?.unit_price,
    confirmedQuantity?.unitPrice,
    ...currencyPrices(confirmedQuantity?.row_price_text ?? confirmedQuantity?.rowPriceText
      ?? confirmedQuantity?.price_text ?? confirmedQuantity?.priceText),
  ].map(sanePrice).filter(Boolean);
  const contextPrices = currencyPrices(confirmedQuantity?.context_text ?? confirmedQuantity?.contextText)
    .map(sanePrice).filter(Boolean);
  const anchoredMaximum = [
    ...mainPrices,
    ...boundStructuredVariants.map((variant) => sanePrice(variant.price)).filter(Boolean),
    sanePrice(structured.selectedVariant?.price),
    ...structured.offerPrices.map(sanePrice).filter(Boolean),
  ].filter(Boolean);
  const trustedContextPrices = contextPrices.filter((price) => (
    !anchoredMaximum.length || price <= Math.max(...anchoredMaximum) * 100
  ));
  const structuredSelectedPrice = boundStructuredVariants
    .map((variant) => sanePrice(variant.price)).filter(Boolean);
  const unitPrice = explicitRowPrices.length ? Math.max(...explicitRowPrices)
    : trustedContextPrices.length ? Math.max(...trustedContextPrices)
      : structuredSelectedPrice.length ? Math.max(...structuredSelectedPrice)
        : sanePrice(structured.selectedVariant?.price)
          || (mainPrices.length ? Math.max(...mainPrices) : null)
          || (structured.offerPrices.length
            ? Math.max(...structured.offerPrices.map(sanePrice).filter(Boolean))
            : null);
  if (!(unitPrice > 0)) return failure("price_unconfirmed", "one-piece CNY price is not confirmed");

  const checkedAtMs = epoch(now);
  if (!Number.isFinite(checkedAtMs)) throw new TypeError("now must return a valid date or epoch timestamp");
  const ttl = Math.min(SUPPLY_EVIDENCE_TTL_MS, Math.max(1, Number(evidenceTtlMs) || SUPPLY_EVIDENCE_TTL_MS));
  const checkedAt = new Date(checkedAtMs).toISOString();
  const validUntil = new Date(checkedAtMs + ttl).toISOString();
  const evidence = {
    contract: SUPPLY_EVIDENCE_CONTRACT,
    passed: true,
    platform: "1688",
    offer_id: candidate.offer_id,
    offer_url: candidate.offer_url,
    target_variant: required ? target : null,
    item_level_match: imagePrimary ? false : required ? false : true,
    variant_attributes: imagePrimary ? rowAttributes : required ? boundAttributes : {},
    ...(imagePrimary ? {
      variant_match_mode: "image_primary",
      match_basis: IMAGE_PRIMARY_MATCH_BASIS,
      image_match_evidence: imageAssessment.evidence,
      variant_selection_required: true,
      variant_differences: variantDifferences,
      selected_variant: {
        row_key: text(quantityInteraction?.row_key ?? boundQuantityRow?.row_key) || null,
        sku_ids: selectedSkuIds,
        label: text(quantityInteraction?.row_text ?? confirmedQuantity?.context_text) || null,
        selection_method: imageSelectionMethod,
        soft_tie: quantityInteraction?.soft_tie === true,
        ...(imageSelectionMethod === IMAGE_PRIMARY_EXACT_THUMBNAIL_SELECTION_METHOD
          ? { selected_sku_image_url: selectedSkuImageUrl }
          : {}),
      },
    } : {}),
    moq,
    orderable_quantity: 1,
    unit_price: unitPrice,
    orderable: true,
    stock_state: "in_stock",
    match_evidence_key: text(matchEvidenceKey ?? candidate.match_evidence_key),
    match_type: candidate.match_type,
    status: "verified",
    checked_at: checkedAt,
    valid_until: validUntil,
  };
  return {
    ok: true,
    passed: true,
    supply_gate_passed: true,
    status: "passed",
    classification: "verified",
    reason: imagePrimary ? "supply-verified-image-primary" : "supply-verified",
    reason_code: imagePrimary ? "supply_verified_image_primary" : "supply_verified",
    retryable: false,
    transient: false,
    deterministic: false,
    evidence,
  };
}

export async function selectExactSpecOption(page, name, expected) {
  return page.evaluate(({ operation, specName, expectedValue }) => {
    if (operation !== "select-spec") throw new Error("invalid supply verifier DOM operation");
    const compact = (value) => String(value ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase("und")
      .replace(/\s+/gu, " ")
      .trim();
    const canonicalName = (value) => {
      const normalized = compact(value).replace(/[\s-]+/gu, "_");
      const aliases = [
        ["model", /^(?:model|model_name|модель|型号|款号)$/iu],
        ["article", /^(?:article|articul|артикул|货号|商品编号)$/iu],
        ["color", /^(?:colou?r|цвет|颜色|色号|颜色分类)$/iu],
        ["size", /^(?:size|размер|尺寸|尺码|规格)$/iu],
        ["capacity", /^(?:capacity|volume|объ[её]м|емкость|容量|容积|内存)$/iu],
        ["voltage_v", /^(?:voltage|voltage_v|напряжение|电压)$/iu],
        ["current_a", /^(?:current|current_a|amperage|ток|сила_тока|电流)$/iu],
        ["power_w", /^(?:power|power_w|wattage|мощность|功率)$/iu],
        ["wireless_protocol", /^(?:wireless_?protocol|protocol|wireless|communication_?protocol|连接方式|通信协议|无线协议|协议)$/iu],
        ["cct_k", /^(?:cct|cct_k|colou?r_?temperature|цветовая_?температура|температура_?света|色温)$/iu],
        ["set_quantity", /^(?:set_?quantity|set_?count|pack_?count|package_?quantity|quantity|count|количество|комплект|套装数量|件数|数量)$/iu],
        ["head_count", /^(?:head_?count|heads?|lamp_?heads?|light_?heads?|shade_?count|plafond_?count|количество_?плафонов|灯头数量|灯头数|头数|灯数|罩数)$/iu],
        ["shape", /^(?:shape|form|форма|形状|外形)$/iu],
        ["interface", /^(?:interface|connector|port|интерфейс|разъ[её]м|接口)$/iu],
      ];
      return aliases.find(([, pattern]) => pattern.test(normalized))?.[0] || null;
    };
    const normalizeValue = (value, canonical) => {
      let normalized = compact(value)
        .replace(/[×*]/gu, "x")
        .replace(/\s*([x:,;+])\s*/gu, "$1")
        .replace(/(\d)\s*(?:毫升|мл|ml)(?![a-zа-яё0-9])/giu, "$1ml")
        .replace(/(\d)\s*(?:升|литр(?:а|ов)?|l)(?![a-zа-яё0-9])/giu, "$1l")
        .replace(/(\d)\s*(?:gb|гб)(?![\p{L}\p{N}])/giu, "$1gb")
        .replace(/(\d)\s*(?:tb|тб)(?![\p{L}\p{N}])/giu, "$1tb")
        .replace(/(\d)\s*(?:mm|мм|毫米)(?![a-zа-яё0-9])/giu, "$1mm")
        .replace(/(\d)\s*(?:вольт(?:а|ов)?|伏特?)(?![a-zа-яё])/giu, "$1v")
        .replace(/(\d)\s*(?:amps?|ампер(?:а|ов)?|安培?)(?![a-zа-яё])/giu, "$1a")
        .replace(/(\d)\s*(?:watts?|ватт(?:а|ов)?|瓦)(?![a-zа-яё])/giu, "$1w")
        .replace(/(\d)\s*(?:v|в)(?![a-zа-яё])/giu, "$1v")
        .replace(/(\d)\s*(?:a|а)(?![a-zа-яё])/giu, "$1a")
        .replace(/(\d)\s*(?:w|вт)(?![a-zа-яё])/giu, "$1w")
        .replace(/(\d{4})\s*(?:k|к)(?![a-zа-яё0-9])/giu, "$1k")
        .replace(/(\d)\s*(?:cm|см)(?![\p{L}\p{N}])/giu, "$1cm")
        .replace(/type[\s_-]*c/giu, "type-c")
        .replace(/micro[\s_-]*usb/giu, "micro-usb")
        .trim();
      if (canonical === "set_quantity" || canonical === "head_count") {
        const count = normalized.match(/\d+(?:\.\d+)?/u)?.[0];
        if (count) normalized = String(Number(count));
      }
      if (canonical === "cct_k") {
        const values = new Set(normalized.match(/(?:(?<![a-zа-яё0-9.])|(?<=[vaw]))\d{4}k(?![a-zа-яё0-9])/giu) || []);
        if (values.size === 1) normalized = [...values][0];
      }
      if (canonical === "size") normalized = normalized.replace(/^([a-z0-9.]+)码$/iu, "$1");
      if (canonical === "interface") {
        const hdmi = new Set();
        if (/(?:mini[\s_-]*hdmi|hdmi[\s_-]*mini|c\s*型\s*mini(?:[\s_-]*hdmi)?)/iu.test(normalized)) hdmi.add("mini-hdmi");
        if (/(?:micro[\s_-]*hdmi|hdmi[\s_-]*micro|d\s*型\s*micro(?:[\s_-]*hdmi)?)/iu.test(normalized)) hdmi.add("micro-hdmi");
        if (hdmi.size === 1) normalized = [...hdmi][0];
        else if (hdmi.size > 1) normalized = "__ambiguous__";
        else if (/^(?:usb[\s-]*)?(?:type-c|usb-c)$/iu.test(normalized)) normalized = "type-c";
      }
      if (canonical === "wireless_protocol") {
        const protocols = new Set();
        if (/(?:^|[^\p{L}\p{N}])zigbee(?:\s*3(?:\.0)?)?(?=$|[^\p{L}\p{N}])/iu.test(normalized)) protocols.add("zigbee");
        if (/(?:^|[^\p{L}\p{N}])wi[\s-]?fi(?=$|[^\p{L}\p{N}])|无线\s*wifi/iu.test(normalized)) protocols.add("wifi");
        if (protocols.size === 1) normalized = [...protocols][0];
        else if (protocols.size > 1) normalized = "__ambiguous__";
      }
      if (canonical === "shape") {
        if (/^(?:square|方形|方型|正方形|квадратн(?:ый|ая|ое|ые))$/iu.test(normalized)) normalized = "square";
        else if (/^(?:round|圆形|圆型|圆款|кругл(?:ый|ая|ое|ые))$/iu.test(normalized)) normalized = "round";
      }
      if (canonical === "color") {
        const casingOnly = normalized
          .replace(/(?:^|[^\p{L}\p{N}])(?:warm|daylight|day[ -]?light|natural|neutral|cool|cold)\s+white(?:\s+(?:light|lighting))?(?=$|[^\p{L}\p{N}])/giu, " ")
          .replace(/(?:^|[^\p{L}\p{N}])(?:т[её]пл|дневн|нейтральн|естественн|холодн)\p{L}*\s+бел\p{L}*(?:\s+свет\p{L}*)?(?=$|[^\p{L}\p{N}])/giu, " ")
          .replace(/(?:暖白|日光白|自然白|中性白|冷白)(?:色)?(?:灯?光)?/gu, " ")
          .replace(/\s+/gu, " ")
          .trim();
        if (casingOnly) normalized = casingOnly;
        else if (casingOnly !== normalized) return normalized;
        const colors = new Map([
          ["黑色", "black"], ["black", "black"], ["черный", "black"], ["чёрный", "black"],
          ["白色", "white"], ["white", "white"], ["белый", "white"],
          ["红色", "red"], ["red", "red"], ["красный", "red"],
          ["蓝色", "blue"], ["blue", "blue"], ["синий", "blue"],
          ["绿色", "green"], ["绿", "green"], ["荧光绿", "green"], ["green", "green"], ["зеленый", "green"], ["зелёный", "green"],
          ["黄色", "yellow"], ["yellow", "yellow"], ["желтый", "yellow"], ["жёлтый", "yellow"],
          ["粉色", "pink"], ["pink", "pink"], ["розовый", "pink"],
          ["灰色", "gray"], ["grey", "gray"], ["gray", "gray"], ["серый", "gray"],
          ["玫瑰金", "rose_gold"], ["rose gold", "rose_gold"], ["rose-gold", "rose_gold"],
          ["透明", "transparent"], ["transparent", "transparent"],
          ["紫色", "purple"], ["紫", "purple"], ["purple", "purple"], ["violet", "purple"],
        ]);
        const exactColor = colors.get(normalized);
        if (exactColor) normalized = exactColor;
        else {
          const hasRoseGold = /玫瑰金|(?:^|[^\p{L}\p{N}])rose[\s-]*gold(?=$|[^\p{L}\p{N}])|розов\p{L}*[\s-]+золот\p{L}*/iu.test(normalized);
          const colorRemainder = hasRoseGold
            ? normalized.replace(/玫瑰金|(?:^|[^\p{L}\p{N}])rose[\s-]*gold(?=$|[^\p{L}\p{N}])|розов\p{L}*[\s-]+золот\p{L}*/giu, " ")
            : normalized;
          const explicitColors = new Set([
            ["black", /黑色|(?:^|[^\p{L}\p{N}])(?:black|черн(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["white", /白色|(?:^|[^\p{L}\p{N}])(?:white|бел(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["gray", /灰色|(?:^|[^\p{L}\p{N}])(?:gr[ae]y|сер(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["red", /红色|(?:^|[^\p{L}\p{N}])(?:red|красн(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["blue", /蓝色|(?:^|[^\p{L}\p{N}])(?:blue|син(?:ий|яя|ее|ие|его|юю|ем))(?=$|[^\p{L}\p{N}])/iu],
            ["green", /(?:荧光绿|绿色|绿(?=高韧|PETG|PLA|TPU|ABS|耗材|线材|款|版|壳|套|$))|(?:^|[^\p{L}\p{N}])(?:green|зел[её]н(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["yellow", /黄色|(?:^|[^\p{L}\p{N}])(?:yellow|ж[её]лт(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["pink", /粉色|(?:^|[^\p{L}\p{N}])(?:pink|розов(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["purple", /紫色|(?:^|[^\p{L}\p{N}])(?:purple|violet|фиолетов(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["rose_gold", /玫瑰金|(?:^|[^\p{L}\p{N}])rose[\s-]*gold(?=$|[^\p{L}\p{N}])|розов\p{L}*[\s-]+золот\p{L}*/iu],
            ["gold", /金色|(?:^|[^\p{L}\p{N}])(?:gold(?:en)?|золот(?:ой|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["transparent", /透明|(?:^|[^\p{L}\p{N}])transparent(?=$|[^\p{L}\p{N}])/iu],
          ].filter(([color, pattern]) => color !== "rose_gold" && pattern.test(colorRemainder)).map(([color]) => color));
          if (hasRoseGold) explicitColors.add("rose_gold");
          if (explicitColors.size === 1) normalized = [...explicitColors][0];
          else if (explicitColors.size > 1) normalized = "__ambiguous__";
        }
      }
      return normalized;
    };
    const visible = (node) => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const selected = (node) => node.getAttribute("aria-selected") === "true"
      || node.getAttribute("data-selected") === "true"
      || node.matches(":checked")
      || Boolean(node.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked'))
      || /(?:^|[\s_-])(?:selected|active|current)(?:$|[\s_-])/iu.test(String(node.className || ""));
    const unsafe = (node) => {
      const controlSelector = 'a[href], button, input[type="submit" i], input[type="image" i], [role="button"]';
      const control = node.matches(controlSelector)
        ? node
        : node.closest(controlSelector) || node.querySelector(controlSelector);
      const anchor = node.matches("a[href]")
        ? node
        : node.closest("a[href]") || node.querySelector("a[href]");
      const form = control?.form || control?.closest("form") || null;
      const value = `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`;
      const purchaseUrl = (raw) => {
        let surface = String(raw || "");
        try { surface = decodeURIComponent(surface); } catch {}
        return /(?:^|[\/?&._=-])(?:cart(?:service)?|shoppingcart|checkout|orders?|buy(?:now|offer)?)(?:$|[\/?&#._=-])/iu.test(surface)
          || /(?:^|[\/?&._=-])(?:(?:add[\/._-]?to|add)[\/._-]?cart|cart[\/._-]?add|(?:create|submit|place|confirm)[\/._-]?order|order[\/._-]?(?:create|submit|place|confirm)|buy[\/._-]?now)(?:$|[\/?&#._=-])/iu.test(surface);
      };
      const explicitSubmit = Boolean(control?.matches(
        'button:not([type]), button[type="submit" i], input[type="submit" i], input[type="image" i], [formaction]',
      ));
      const formOwnedButton = Boolean(form && control?.matches('button, [role="button"]'));
      return /购买|订购|下单|进货单|购物车|立即拿样|buy|order|cart|checkout|submit/iu.test(value)
        || purchaseUrl(anchor?.getAttribute("href"))
        || purchaseUrl(control?.getAttribute("formaction"))
        || purchaseUrl(form?.getAttribute("action"))
        || explicitSubmit
        || formOwnedButton
        || Boolean(node.closest('[class*="checkout" i], #submitOrder, [data-module="od_submit_order"]'));
    };
    const candidateSelector = [
      "[data-sku-id]", "[data-value-name]", "[data-prop-value]", "[data-property-value]",
      '[role="option"]', '[class*="sku" i] li', '[class*="sku" i] button',
      '[class*="prop" i] li', '[class*="prop" i] button', '[class*="spec" i] li',
      '.module-od-sku-selection .expand-view-item',
    ].join(",");
    const groupOf = (node) => {
      const attributes = ["data-prop-name", "data-property-name", "data-sku-prop-name", "data-spec-name"];
      for (const attribute of attributes) {
        const direct = canonicalName(node.getAttribute(attribute));
        if (direct) return direct;
        const owner = node.closest(`[${attribute}]`);
        const inherited = canonicalName(owner?.getAttribute(attribute));
        if (inherited) return inherited;
      }
      let parent = node.parentElement;
      for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
        const labels = [...parent.querySelectorAll(":scope > label, :scope > legend, :scope > dt, :scope > h3, :scope > h4, :scope > span")]
          .slice(0, 12);
        const inferred = labels.map((entry) => canonicalName(entry.textContent)).find(Boolean);
        if (inferred) return inferred;
      }
      const featureHeading = node.closest(".feature-item")?.querySelector(".feature-item-label h3");
      if (canonicalName(featureHeading?.textContent)) return canonicalName(featureHeading.textContent);
      return null;
    };
    const valueOf = (node, canonical) => {
      const raw = node.getAttribute("data-value-name")
        || node.getAttribute("data-prop-value")
        || node.getAttribute("data-property-value")
        || node.getAttribute("title")
        || node.getAttribute("aria-label")
        || node.querySelector(".item-label[title]")?.getAttribute("title")
        || node.querySelector(".item-label")?.textContent
        || node.innerText
        || node.textContent
        || "";
      return normalizeValue(raw, canonical);
    };
    const rows = [...new Set([...document.querySelectorAll(candidateSelector)])]
      .filter((node) => visible(node) && !unsafe(node))
      .map((node) => ({ node, group: groupOf(node) }))
      .filter((row) => row.group === specName);
    if (!rows.length) return { found: false, group_found: false, selected: false };
    const exact = rows.find(({ node }) => valueOf(node, specName) === expectedValue);
    if (!exact) return { found: false, group_found: true, selected: false };
    const disabled = exact.node.matches(":disabled")
      || exact.node.getAttribute("aria-disabled") === "true"
      || /disabled|sold.?out|缺货|无货/iu.test(String(exact.node.className || ""));
    if (disabled) return { found: true, group_found: true, disabled: true, selected: false };
    const alreadySelected = selected(exact.node);
    if (!alreadySelected) exact.node.click();
    return {
      found: true,
      group_found: true,
      disabled: false,
      clicked: !alreadySelected,
      selected: selected(exact.node),
    };
  }, { operation: "select-spec", specName: name, expectedValue: expected });
}

async function setOrderQuantityToOne(page, target, selectedSpecs, {
  imagePrimary = false,
  signedOfferImageUrl = null,
} = {}) {
  return page.evaluate(({ operation, targetVariant, specSelections, allowImagePrimary, candidateImageUrl, quantitySelectors }) => {
    if (operation !== "set-quantity") throw new Error("invalid supply verifier DOM operation");
    const compact = (value) => String(value ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase("und")
      .replace(/\s+/gu, " ")
      .trim();
    const canonicalName = (value) => {
      const normalized = compact(value)
        .replace(/^data[\s_.:-]*/u, "")
        .replace(/[\s.:-]+/gu, "_")
        .replace(/_(?:name|value|label|text)$/u, "");
      const aliases = [
        ["model", /^(?:model|model_name|модель|型号|款号)$/iu],
        ["article", /^(?:article|articul|артикул|货号|商品编号)$/iu],
        ["color", /^(?:colou?r|цвет|颜色|色号|颜色分类)$/iu],
        ["size", /^(?:size|размер|尺寸|尺码|规格)$/iu],
        ["capacity", /^(?:capacity|volume|объ[её]м|емкость|容量|容积|内存)$/iu],
        ["voltage_v", /^(?:voltage|voltage_v|напряжение|电压)$/iu],
        ["current_a", /^(?:current|current_a|amperage|ток|сила_тока|电流)$/iu],
        ["power_w", /^(?:power|power_w|wattage|мощность|功率)$/iu],
        ["cct_k", /^(?:cct|cct_k|colou?r_?temperature|цветовая_?температура|температура_?света|色温)$/iu],
        ["set_quantity", /^(?:set_?quantity|set_?count|pack_?count|package_?quantity|quantity|count|количество|комплект|套装数量|件数|数量)$/iu],
        ["head_count", /^(?:head_?count|heads?|lamp_?heads?|light_?heads?|shade_?count|plafond_?count|количество_?плафонов|灯头数量|灯头数|头数|灯数|罩数)$/iu],
        ["shape", /^(?:shape|form|форма|形状|外形)$/iu],
        ["interface", /^(?:interface|connector|port|интерфейс|разъ[её]м|接口)$/iu],
      ];
      return aliases.find(([, pattern]) => pattern.test(normalized))?.[0] || null;
    };
    const normalizeValue = (value, canonical) => {
      let normalized = compact(value)
        .replace(/[×*]/gu, "x")
        .replace(/\s*([x:,;+])\s*/gu, "$1")
        .replace(/(\d)\s*(?:毫升|мл|ml)(?![a-zа-яё0-9])/giu, "$1ml")
        .replace(/(\d)\s*(?:升|литр(?:а|ов)?|l)(?![a-zа-яё0-9])/giu, "$1l")
        .replace(/(\d)\s*(?:gb|гб)(?![\p{L}\p{N}])/giu, "$1gb")
        .replace(/(\d)\s*(?:tb|тб)(?![\p{L}\p{N}])/giu, "$1tb")
        .replace(/(\d)\s*(?:mm|мм|毫米)(?![a-zа-яё0-9])/giu, "$1mm")
        .replace(/(\d)\s*(?:вольт(?:а|ов)?|伏特?)(?![a-zа-яё])/giu, "$1v")
        .replace(/(\d)\s*(?:amps?|ампер(?:а|ов)?|安培?)(?![a-zа-яё])/giu, "$1a")
        .replace(/(\d)\s*(?:watts?|ватт(?:а|ов)?|瓦)(?![a-zа-яё])/giu, "$1w")
        .replace(/(\d)\s*(?:v|в)(?![a-zа-яё])/giu, "$1v")
        .replace(/(\d)\s*(?:a|а)(?![a-zа-яё])/giu, "$1a")
        .replace(/(\d)\s*(?:w|вт)(?![a-zа-яё])/giu, "$1w")
        .replace(/(\d{4})\s*(?:k|к)(?![a-zа-яё0-9])/giu, "$1k")
        .replace(/(\d)\s*(?:cm|см)(?![\p{L}\p{N}])/giu, "$1cm")
        .replace(/type[\s_-]*c/giu, "type-c")
        .replace(/micro[\s_-]*usb/giu, "micro-usb")
        .trim();
      if (canonical === "set_quantity" || canonical === "head_count") {
        const count = normalized.match(/\d+(?:\.\d+)?/u)?.[0];
        if (count) normalized = String(Number(count));
      }
      if (canonical === "cct_k") {
        const values = new Set(normalized.match(/(?:(?<![a-zа-яё0-9.])|(?<=[vaw]))\d{4}k(?![a-zа-яё0-9])/giu) || []);
        if (values.size === 1) normalized = [...values][0];
      }
      if (canonical === "size") normalized = normalized.replace(/^([a-z0-9.]+)码$/iu, "$1");
      if (canonical === "interface") {
        const hdmi = new Set();
        if (/(?:mini[\s_-]*hdmi|hdmi[\s_-]*mini|c\s*型\s*mini(?:[\s_-]*hdmi)?)/iu.test(normalized)) hdmi.add("mini-hdmi");
        if (/(?:micro[\s_-]*hdmi|hdmi[\s_-]*micro|d\s*型\s*micro(?:[\s_-]*hdmi)?)/iu.test(normalized)) hdmi.add("micro-hdmi");
        if (hdmi.size === 1) normalized = [...hdmi][0];
        else if (hdmi.size > 1) normalized = "__ambiguous__";
        else if (/^(?:usb[\s-]*)?(?:type-c|usb-c)$/iu.test(normalized)) normalized = "type-c";
      }
      if (canonical === "shape") {
        if (/^(?:square|方形|方型|正方形|квадратн(?:ый|ая|ое|ые))$/iu.test(normalized)) normalized = "square";
        else if (/^(?:round|圆形|圆型|圆款|кругл(?:ый|ая|ое|ые))$/iu.test(normalized)) normalized = "round";
      }
      if (canonical === "color") {
        const casingOnly = normalized
          .replace(/(?:^|[^\p{L}\p{N}])(?:warm|daylight|day[ -]?light|natural|neutral|cool|cold)\s+white(?:\s+(?:light|lighting))?(?=$|[^\p{L}\p{N}])/giu, " ")
          .replace(/(?:^|[^\p{L}\p{N}])(?:т[её]пл|дневн|нейтральн|естественн|холодн)\p{L}*\s+бел\p{L}*(?:\s+свет\p{L}*)?(?=$|[^\p{L}\p{N}])/giu, " ")
          .replace(/(?:暖白|日光白|自然白|中性白|冷白)(?:色)?(?:灯?光)?/gu, " ")
          .replace(/\s+/gu, " ")
          .trim();
        if (casingOnly) normalized = casingOnly;
        else if (casingOnly !== normalized) return normalized;
        const colors = new Map([
          ["黑色", "black"], ["black", "black"], ["черный", "black"], ["чёрный", "black"],
          ["白色", "white"], ["white", "white"], ["белый", "white"],
          ["红色", "red"], ["red", "red"], ["красный", "red"],
          ["蓝色", "blue"], ["blue", "blue"], ["синий", "blue"],
          ["绿色", "green"], ["绿", "green"], ["荧光绿", "green"], ["green", "green"], ["зеленый", "green"], ["зелёный", "green"],
          ["黄色", "yellow"], ["yellow", "yellow"], ["желтый", "yellow"], ["жёлтый", "yellow"],
          ["粉色", "pink"], ["pink", "pink"], ["розовый", "pink"],
          ["灰色", "gray"], ["grey", "gray"], ["gray", "gray"], ["серый", "gray"],
          ["玫瑰金", "rose_gold"], ["rose gold", "rose_gold"], ["rose-gold", "rose_gold"],
          ["金色", "gold"], ["gold", "gold"], ["golden", "gold"],
          ["золотой", "gold"], ["золотая", "gold"], ["золотое", "gold"],
          ["золотистый", "gold"], ["золотистая", "gold"], ["золотистое", "gold"],
          ["透明", "transparent"], ["transparent", "transparent"],
          ["紫色", "purple"], ["紫", "purple"], ["purple", "purple"], ["violet", "purple"],
        ]);
        const exactColor = colors.get(normalized);
        if (exactColor) normalized = exactColor;
        else {
          const hasRoseGold = /玫瑰金|(?:^|[^\p{L}\p{N}])rose[\s-]*gold(?=$|[^\p{L}\p{N}])|розов\p{L}*[\s-]+золот\p{L}*/iu.test(normalized);
          const colorRemainder = hasRoseGold
            ? normalized.replace(/玫瑰金|(?:^|[^\p{L}\p{N}])rose[\s-]*gold(?=$|[^\p{L}\p{N}])|розов\p{L}*[\s-]+золот\p{L}*/giu, " ")
            : normalized;
          const explicitColors = new Set([
            ["black", /黑色|(?:^|[^\p{L}\p{N}])(?:black|черн(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["white", /白色|(?:^|[^\p{L}\p{N}])(?:white|бел(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["gray", /灰色|(?:^|[^\p{L}\p{N}])(?:gr[ae]y|сер(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["red", /红色|(?:^|[^\p{L}\p{N}])(?:red|красн(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["blue", /蓝色|(?:^|[^\p{L}\p{N}])(?:blue|син(?:ий|яя|ее|ие|его|юю|ем))(?=$|[^\p{L}\p{N}])/iu],
            ["green", /(?:荧光绿|绿色|绿(?=高韧|PETG|PLA|TPU|ABS|耗材|线材|款|版|壳|套|$))|(?:^|[^\p{L}\p{N}])(?:green|зел[её]н(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["yellow", /黄色|(?:^|[^\p{L}\p{N}])(?:yellow|ж[её]лт(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["pink", /粉色|(?:^|[^\p{L}\p{N}])(?:pink|розов(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["purple", /紫色|(?:^|[^\p{L}\p{N}])(?:purple|violet|фиолетов(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["rose_gold", /玫瑰金|(?:^|[^\p{L}\p{N}])rose[\s-]*gold(?=$|[^\p{L}\p{N}])|розов\p{L}*[\s-]+золот\p{L}*/iu],
            ["gold", /金色|(?:^|[^\p{L}\p{N}])(?:gold(?:en)?|золот(?:ой|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["transparent", /透明|(?:^|[^\p{L}\p{N}])transparent(?=$|[^\p{L}\p{N}])/iu],
          ].filter(([color, pattern]) => color !== "rose_gold" && pattern.test(colorRemainder)).map(([color]) => color));
          if (hasRoseGold) explicitColors.add("rose_gold");
          if (explicitColors.size === 1) normalized = [...explicitColors][0];
          else if (explicitColors.size > 1) normalized = "__ambiguous__";
        }
      }
      return normalized;
    };
    const visible = (node) => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const canonicalImageAssetUrl = (value) => {
      try {
        const parsed = new URL(String(value || "").trim(), document.baseURI);
        if (parsed.protocol !== "https:" || !parsed.hostname) return null;
        const hostname = parsed.hostname.toLocaleLowerCase("und");
        if (hostname === "alicdn.com" || hostname.endsWith(".alicdn.com")) {
          parsed.search = "";
          parsed.hash = "";
          if (parsed.pathname.endsWith("_sum.jpg")) {
            parsed.pathname = parsed.pathname.slice(0, -"_sum.jpg".length);
          }
        }
        return parsed.href;
      } catch {
        return null;
      }
    };
    const imageUrlsFrom = (root) => {
      const imageNodes = [root, ...root.querySelectorAll([
        "img", "source", "[data-image-url]", "[data-img]", "[data-src]",
        "[data-lazy-src]", "[data-original]", "[data-lazyload]",
      ].join(","))].slice(0, 200);
      const raw = [];
      for (const imageNode of imageNodes) {
        for (const attribute of [
          "src", "data-src", "data-image-url", "data-img", "data-lazy-src", "data-original", "data-lazyload",
        ]) raw.push(imageNode.getAttribute?.(attribute));
        raw.push(imageNode.currentSrc);
        const background = String(getComputedStyle(imageNode).backgroundImage || "");
        for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/giu)) raw.push(match[1]);
      }
      return [...new Set(raw.map(canonicalImageAssetUrl).filter(Boolean))];
    };
    const selector = quantitySelectors.join(",");
    const inputNodes = [...new Set([...document.querySelectorAll(selector)])]
      .filter((node) => visible(node)
        && !node.disabled
        && !node.readOnly
        && !node.closest('header, nav, [role="search"], [class*="search" i], [class*="checkout" i], #submitOrder, [data-module="od_submit_order"]'));
    if (!inputNodes.length) return { found: false, set: false, value: null };

    const put = (targetAttributes, rawName, rawValue) => {
      const name = canonicalName(rawName);
      const value = normalizeValue(rawValue, name);
      if (name && value && !targetAttributes[name]) targetAttributes[name] = value;
    };
    const attributesFromObject = (object) => {
      const result = {};
      if (!object || typeof object !== "object") return result;
      if (!Array.isArray(object)) {
        put(result, object.name ?? object.label ?? object.key ?? object.attribute_name ?? object.prop_name,
          object.value ?? object.text ?? object.attribute_value ?? object.value_name ?? object.values?.[0]);
      }
      const sources = [object, object.attributes, object.variant_attributes, object.specs, object.properties]
        .filter((source) => source && typeof source === "object");
      for (const source of sources) {
        if (Array.isArray(source)) {
          for (const row of source) {
            if (!row || typeof row !== "object") continue;
            put(result, row.name ?? row.label ?? row.key ?? row.attribute_name ?? row.prop_name,
              row.value ?? row.text ?? row.attribute_value ?? row.value_name ?? row.values?.[0]);
          }
        } else {
          for (const [name, value] of Object.entries(source)) {
            if (["required", "sources", "label"].includes(name)) continue;
            if (value && typeof value === "object" && !Array.isArray(value)) {
              put(result, value.name ?? value.label ?? name, value.value ?? value.text ?? value.value_name);
            } else {
              put(result, name, value);
            }
          }
        }
      }
      return result;
    };
    const skuIdsFromObject = (object) => {
      if (!object || typeof object !== "object") return [];
      return Object.entries(object).flatMap(([name, value]) => {
        const key = compact(name).replace(/[\s_.:\-/]+/gu, "");
        if (!/(?:sku|variant)(?:id|key)$/iu.test(key)) return [];
        const id = compact(value);
        return id ? [id] : [];
      });
    };
    const structuredVariants = [];
    const structuredQueue = window.context && typeof window.context === "object" ? [window.context] : [];
    const structuredSeen = new Set();
    for (let visits = 0; structuredQueue.length && visits < 10_000; visits += 1) {
      const current = structuredQueue.shift();
      if (!current || typeof current !== "object" || structuredSeen.has(current)) continue;
      structuredSeen.add(current);
      const skuIds = skuIdsFromObject(current);
      if (skuIds.length) {
        let sourceText = "";
        try { sourceText = JSON.stringify(current).slice(0, 20_000); } catch {}
        structuredVariants.push({ sku_ids: skuIds, attributes: attributesFromObject(current), text: sourceText });
      }
      if (Array.isArray(current)) structuredQueue.push(...current.filter((value) => value && typeof value === "object"));
      else structuredQueue.push(...Object.values(current).filter((value) => value && typeof value === "object"));
    }

    const rowRoot = (input) => input.closest([
      ".gyp-pro-table-row", "[class*='gyp-pro-table-row']", ".expand-view-item", "[data-sku-id]", "[data-offer-sku-id]", "[data-variant-id]",
      "[data-sku-item]", "[role='option']", "tr", "li",
    ].join(",")) || input.parentElement || input;
    const auditRow = (input, index) => {
      const root = rowRoot(input);
      const variantAttributes = {};
      const dataAttributes = {};
      const nodes = [root, ...root.querySelectorAll("[data-prop-name], [data-property-name], [data-sku-prop-name], [data-spec-name], [data-value-name], [data-prop-value], [data-property-value], [title]")].slice(0, 200);
      for (const node of nodes) {
        for (const attribute of [...node.attributes]) {
          if (attribute.name.startsWith("data-")) dataAttributes[attribute.name] = attribute.value;
          put(variantAttributes, attribute.name, attribute.value);
        }
        const group = node.getAttribute("data-prop-name") || node.getAttribute("data-property-name")
          || node.getAttribute("data-sku-prop-name") || node.getAttribute("data-spec-name");
        const value = node.getAttribute("data-value-name") || node.getAttribute("data-prop-value")
          || node.getAttribute("data-property-value") || node.getAttribute("title")
          || node.querySelector?.(".item-label[title]")?.getAttribute("title")
          || node.querySelector?.(".item-label")?.textContent;
        put(variantAttributes, group, value);
      }
      const featureHeading = root.closest(".feature-item")?.querySelector(".feature-item-label h3");
      put(variantAttributes, featureHeading?.textContent,
        root.querySelector(".item-label[title]")?.getAttribute("title")
          || root.querySelector(".item-label")?.textContent);
      const skuIds = [...new Set(nodes.flatMap((node) => [...node.attributes].flatMap((attribute) => {
        const key = compact(attribute.name).replace(/[\s_.:\-/]+/gu, "");
        return /(?:sku|variant)(?:id|key)$/iu.test(key) && compact(attribute.value) ? [compact(attribute.value)] : [];
      })))];
      const matchingStructured = structuredVariants.filter((variant) => variant.sku_ids.some((id) => skuIds.includes(id))
        || (inputNodes.length === 1 && structuredVariants.length === 1));
      const structuredAttributes = {};
      for (const variant of matchingStructured) {
        for (const [name, value] of Object.entries(variant.attributes)) {
          if (!structuredAttributes[name]) structuredAttributes[name] = value;
          else if (structuredAttributes[name] !== value) structuredAttributes[name] = "__ambiguous__";
        }
      }
      const rowText = compact(root.innerText || root.textContent || "");
      const skuImageUrls = imageUrlsFrom(root);
      const structuredText = matchingStructured.map((variant) => variant.text).join(" ");
      if (!variantAttributes.head_count) {
        const counts = [...`${rowText} ${structuredText}`.matchAll(/(?:^|[^\p{L}\p{N}])(\d{1,2})\s*(?:头|燈頭|灯头|head(?:s)?|плафон(?:а|ов)?)(?=$|[^\p{L}\p{N}])/giu)]
          .map((match) => String(Number(match[1])));
        if (new Set(counts).size === 1) variantAttributes.head_count = counts[0];
      }
      if (!variantAttributes.shape) {
        const source = `${rowText} ${structuredText}`;
        const shapes = new Set();
        if (/方形|方型|正方形|(?:^|[^\p{L}\p{N}])(?:square|квадратн(?:ый|ая|ое|ые))(?=$|[^\p{L}\p{N}])/iu.test(source)) shapes.add("square");
        if (/圆形|圆型|圆款|(?:^|[^\p{L}\p{N}])(?:round|кругл(?:ый|ая|ое|ые))(?=$|[^\p{L}\p{N}])/iu.test(source)) shapes.add("round");
        if (shapes.size === 1) variantAttributes.shape = [...shapes][0];
      }
      const rowKey = skuIds.length ? `sku:${skuIds.join("|")}` : `index:${index}`;
      return {
        node: input,
        index,
        row_key: rowKey,
        sku_ids: skuIds,
        row_text: rowText,
        structured_text: structuredText,
        data_attributes: dataAttributes,
        variant_attributes: { ...structuredAttributes, ...variantAttributes },
        sku_image_urls: skuImageUrls,
      };
    };
    const audits = inputNodes.map(auditRow);
    const normalizedTarget = Object.fromEntries(Object.entries(targetVariant || {})
      .flatMap(([name, value]) => {
        const canonical = canonicalName(name) || name;
        const normalized = normalizeValue(value, canonical);
        return canonical && normalized ? [[canonical, normalized]] : [];
      }));
    const explicitCapacityValues = (value) => {
      const normalized = normalizeValue(value, null);
      return new Set(normalized.match(/(?<![a-zа-яё0-9.])\d+(?:\.\d+)?(?:ml|l|gb|tb)(?![a-zа-яё0-9])/giu) || []);
    };
    const explicitMillimetreValues = (value) => {
      const normalized = normalizeValue(value, null);
      return new Set(normalized.match(/(?<![a-zа-яё0-9.])\d+(?:\.\d+)?mm(?![a-zа-яё0-9])/giu) || []);
    };
    const explicitElectricalValues = (value, name) => {
      const normalized = normalizeValue(value, null);
      const suffix = name === "voltage_v" ? "v" : name === "current_a" ? "a" : name === "power_w" ? "w" : null;
      if (!suffix) return new Set();
      return new Set(normalized.match(new RegExp(`(?:(?<![a-zа-яё0-9.])|(?<=[vaw]))\\d+(?:\\.\\d+)?${suffix}(?![a-zа-яё])`, "giu")) || []);
    };
    const explicitCctValues = (value) => {
      const normalized = normalizeValue(value, null);
      return new Set(normalized.match(/(?:(?<![a-zа-яё0-9.])|(?<=[vaw]))\d{4}k(?![a-zа-яё0-9])/giu) || []);
    };
    const isLightColourOnly = (value) => {
      const source = compact(value);
      if (!source) return false;
      const withoutLight = source
        .replace(/(?:(?<![a-zа-яё0-9.])|(?<=[vaw]))\d{4}k(?![a-zа-яё0-9])/giu, " ")
        .replace(/(?:^|[^\p{L}\p{N}])(?:warm|daylight|day[ -]?light|natural|neutral|cool|cold)\s+white(?:\s+(?:light|lighting))?(?=$|[^\p{L}\p{N}])/giu, " ")
        .replace(/(?:^|[^\p{L}\p{N}])(?:т[её]пл|дневн|нейтральн|естественн|холодн)\p{L}*\s+бел\p{L}*(?:\s+свет\p{L}*)?(?=$|[^\p{L}\p{N}])/giu, " ")
        .replace(/(?:暖白|日光白|自然白|中性白|冷白)(?:色)?(?:灯?光)?/gu, " ")
        .replace(/[\s+|,;:/_-]+/gu, "")
        .trim();
      return withoutLight.length === 0;
    };
    // 1688 often places capacity or nozzle diameter inside a generic “规格”
    // value. Rebind only an explicit, single numeric value. Missing numeric
    // text stays soft; multiple/conflicting values remain non-matching.
    for (const audit of audits) {
      const rawSize = audit.variant_attributes.size;
      if (Object.hasOwn(normalizedTarget, "capacity") && rawSize) {
        const capacities = explicitCapacityValues(rawSize);
        delete audit.variant_attributes.size;
        if (capacities.size === 1) audit.variant_attributes.capacity = [...capacities][0];
        else if (capacities.size > 1) audit.variant_attributes.capacity = "__ambiguous__";
      }
      if (Object.hasOwn(normalizedTarget, "size")
        && explicitMillimetreValues(normalizedTarget.size).size === 1
        && rawSize) {
        const millimetres = explicitMillimetreValues(rawSize);
        if (millimetres.size === 1) audit.variant_attributes.size = [...millimetres][0];
        else if (millimetres.size > 1) audit.variant_attributes.size = "__ambiguous__";
        else delete audit.variant_attributes.size;
      }
      for (const name of ["voltage_v", "current_a", "power_w"]) {
        if (!Object.hasOwn(normalizedTarget, name) || !rawSize) continue;
        const values = explicitElectricalValues(rawSize, name);
        delete audit.variant_attributes.size;
        if (values.size === 1) audit.variant_attributes[name] = [...values][0];
        else if (values.size > 1) audit.variant_attributes[name] = "__ambiguous__";
      }
      if (Object.hasOwn(normalizedTarget, "cct_k")) {
        const rawColor = audit.variant_attributes.color;
        const cctSources = [rawSize, rawColor, audit.row_text, audit.structured_text]
          .filter(Boolean).join(" ");
        const values = explicitCctValues(cctSources);
        if (rawSize && explicitCctValues(rawSize).size) delete audit.variant_attributes.size;
        // Do not erase a real casing-colour dimension merely because the row
        // also contains a Kelvin value.  Only a colour attribute that itself
        // carries an explicit Kelvin value can be safely rebound here.
        if (!Object.hasOwn(normalizedTarget, "color")
          && (explicitCctValues(rawColor).size || isLightColourOnly(rawColor))) {
          delete audit.variant_attributes.color;
        }
        if (values.size === 1) audit.variant_attributes.cct_k = [...values][0];
        else if (values.size > 1) audit.variant_attributes.cct_k = "__ambiguous__";
      }
      if (new Set(["mini-hdmi", "micro-hdmi"]).has(normalizedTarget.interface) && rawSize) {
        const subtype = normalizeValue(rawSize, "interface");
        delete audit.variant_attributes.size;
        if (new Set(["mini-hdmi", "micro-hdmi", "__ambiguous__"]).has(subtype)) {
          audit.variant_attributes.interface = subtype;
        }
      }
    }
    const colorPatterns = [
      ["black", /黑色|(?<![\p{L}\p{N}])(?:black|черный|чёрный)(?![\p{L}\p{N}])/iu],
      ["white", /白色|(?<![\p{L}\p{N}])(?:white|белый)(?![\p{L}\p{N}])/iu],
      ["red", /红色|(?<![\p{L}\p{N}])(?:red|красный)(?![\p{L}\p{N}])/iu],
      ["blue", /蓝色|(?<![\p{L}\p{N}])(?:blue|синий)(?![\p{L}\p{N}])/iu],
      ["green", /(?:荧光绿|绿色|绿(?=高韧|PETG|PLA|TPU|ABS|耗材|线材|款|版|壳|套|$))|(?<![\p{L}\p{N}])(?:green|зеленый|зелёный)(?![\p{L}\p{N}])/iu],
      ["yellow", /黄色|(?<![\p{L}\p{N}])(?:yellow|желтый|жёлтый)(?![\p{L}\p{N}])/iu],
      ["pink", /粉色|(?<![\p{L}\p{N}])(?:pink|розовый)(?![\p{L}\p{N}])/iu],
      ["gray", /灰色|(?<![\p{L}\p{N}])(?:gr[ae]y|серый)(?![\p{L}\p{N}])/iu],
      ["rose_gold", /玫瑰金|(?:^|[^\p{L}\p{N}])rose[\s-]*gold(?=$|[^\p{L}\p{N}])|розов\p{L}*[\s-]+золот\p{L}*/iu],
      ["gold", /金色|(?<![\p{L}\p{N}])(?:gold|golden|золот(?:ой|ая|ое)|золотист(?:ый|ая|ое))(?![\p{L}\p{N}])/iu],
      ["transparent", /透明|(?<![\p{L}\p{N}])transparent(?![\p{L}\p{N}])/iu],
      ["purple", /(?:紫色|紫(?=高韧|PETG|PLA|TPU|ABS|耗材|线材|款|版|壳|套|$))|(?<![\p{L}\p{N}])(?:purple|violet)(?![\p{L}\p{N}])/iu],
    ];
    const observeText = (source, name, expected) => {
      const normalized = normalizeValue(source, null);
      if (name === "color") {
        const hasRoseGold = /玫瑰金|(?:^|[^\p{L}\p{N}])rose[\s-]*gold(?=$|[^\p{L}\p{N}])|розов\p{L}*[\s-]+золот\p{L}*/iu.test(source);
        const colorRemainder = hasRoseGold
          ? String(source || "").replace(/玫瑰金|(?:^|[^\p{L}\p{N}])rose[\s-]*gold(?=$|[^\p{L}\p{N}])|розов\p{L}*[\s-]+золот\p{L}*/giu, " ")
          : source;
        const seen = new Set(colorPatterns
          .filter(([color, pattern]) => color !== "rose_gold" && pattern.test(colorRemainder))
          .map(([color]) => color));
        if (hasRoseGold) seen.add("rose_gold");
        return { observed: seen.size > 0, matches: seen.size === 1 && seen.has(expected) };
      }
      if (name === "capacity") {
        const seen = explicitCapacityValues(source);
        return { observed: seen.size > 0, matches: seen.size === 1 && seen.has(expected) };
      }
      if (name === "voltage_v" || name === "current_a" || name === "power_w") {
        const seen = explicitElectricalValues(source, name);
        return { observed: seen.size > 0, matches: seen.size === 1 && seen.has(expected) };
      }
      if (name === "cct_k") {
        const seen = explicitCctValues(source);
        return { observed: seen.size > 0, matches: seen.size === 1 && seen.has(expected) };
      }
      if (name === "interface") {
        if (expected === "mini-hdmi" || expected === "micro-hdmi") {
          const subtype = normalizeValue(source, "interface");
          const observed = subtype === "mini-hdmi" || subtype === "micro-hdmi" || subtype === "__ambiguous__";
          return { observed, matches: observed && subtype === expected };
        }
        const seen = new Set();
        if (/(?<![\p{L}\p{N}])(?:type-c|usb-c)(?![\p{L}\p{N}])/iu.test(normalized)) seen.add("type-c");
        if (/(?<![\p{L}\p{N}])micro-usb(?![\p{L}\p{N}])/iu.test(normalized)) seen.add("micro-usb");
        for (const value of ["lightning", "usb-a", "hdmi", "displayport", "rj45"]) {
          if (normalized.split(/[\s,;|/、，；：:()[\]{}]+/u).includes(value)) seen.add(value);
        }
        return { observed: seen.size > 0, matches: seen.size === 1 && seen.has(expected) };
      }
      if (name === "set_quantity") {
        const seen = new Set();
        for (const pattern of [
          /(?:套装|件数|pack(?:age)?|set|комплект|количество)\s*[:：]?\s*(\d+(?:\.\d+)?)/giu,
          /(\d+(?:\.\d+)?)\s*(?:件|个|只|pcs?)\s*(?:套|装|pack|set)/giu,
        ]) {
          for (const match of normalized.matchAll(pattern)) seen.add(String(Number(match[1])));
        }
        return { observed: seen.size > 0, matches: seen.size === 1 && seen.has(expected) };
      }
      if (name === "head_count") {
        const seen = new Set();
        for (const match of normalized.matchAll(/(?:^|[^\p{L}\p{N}])(\d{1,2})\s*(?:头|燈頭|灯头|head(?:s)?|плафон(?:а|ов)?)(?=$|[^\p{L}\p{N}])/giu)) {
          seen.add(String(Number(match[1])));
        }
        return { observed: seen.size > 0, matches: seen.size === 1 && seen.has(expected) };
      }
      if (name === "shape") {
        const seen = new Set();
        if (/方形|方型|正方形|(?:^|[^\p{L}\p{N}])(?:square|квадратн(?:ый|ая|ое|ые))(?=$|[^\p{L}\p{N}])/iu.test(source)) seen.add("square");
        if (/圆形|圆型|圆款|(?:^|[^\p{L}\p{N}])(?:round|кругл(?:ый|ая|ое|ые))(?=$|[^\p{L}\p{N}])/iu.test(source)) seen.add("round");
        return { observed: seen.size > 0, matches: seen.size === 1 && seen.has(expected) };
      }
      const tokens = new Set(normalized.split(/[\s,;|/、，；：:()[\]{}]+/u).filter(Boolean));
      return { observed: tokens.has(expected), matches: tokens.has(expected) };
    };
    const varyingKeys = new Set();
    const observedKeys = new Set(audits.flatMap((audit) => Object.keys(audit.variant_attributes)));
    for (const name of observedKeys) {
      const values = new Set(audits.map((audit) => audit.variant_attributes[name] || "__missing__"));
      if (values.size > 1) varyingKeys.add(name);
    }
    const uncoveredVariantDimensions = [...varyingKeys]
      .filter((name) => !Object.hasOwn(normalizedTarget, name));
    const matchingAudits = audits.filter((audit) => Object.entries(normalizedTarget).every(([name, expected]) => {
      if (audit.variant_attributes[name]) return audit.variant_attributes[name] === expected;
      if (audits.length === 1) {
        const observation = observeText(`${audit.row_text} ${audit.structured_text}`, name, expected);
        if (observation.observed) return observation.matches;
      }
      const selected = specSelections?.[name];
      if (selected?.found === true && selected?.selected === true && selected?.disabled !== true) return true;
      return false;
    }));
    const compatibleAudits = audits.filter((audit) => Object.entries(normalizedTarget).every(([name, expected]) => {
      if (audit.variant_attributes[name]) return audit.variant_attributes[name] === expected;
      const observation = observeText(`${audit.row_text} ${audit.structured_text}`, name, expected);
      return !observation.observed || observation.matches;
    }));
    const normalizedCandidateImageUrl = canonicalImageAssetUrl(candidateImageUrl);
    const exactThumbnailRows = allowImagePrimary && normalizedCandidateImageUrl
      ? audits.filter((audit) => audit.sku_image_urls.includes(normalizedCandidateImageUrl))
      : [];
    const exactThumbnailChoice = exactThumbnailRows.length === 1
      && compatibleAudits.includes(exactThumbnailRows[0])
      ? exactThumbnailRows[0]
      : null;
    if (exactThumbnailRows.length === 1 && !exactThumbnailChoice) {
      const conflicting = exactThumbnailRows[0];
      return {
        found: true,
        set: false,
        value: Number(conflicting.node.value),
        reason_code: "spec_mismatch",
        matched_rows: 0,
        row_key: conflicting.row_key,
        row_index: conflicting.index,
        row_text: conflicting.row_text,
        variant_attributes: conflicting.variant_attributes,
        thumbnail_match_count: 1,
      };
    }
    if (uncoveredVariantDimensions.length && !exactThumbnailChoice) {
      return {
        found: true,
        set: false,
        value: null,
        reason_code: "variant_unbound",
        matched_rows: 0,
        uncovered_variant_dimensions: uncoveredVariantDimensions,
        thumbnail_match_count: exactThumbnailRows.length,
      };
    }
    const imagePrimaryChoices = compatibleAudits.map((audit) => ({
      audit,
      score: Object.entries(normalizedTarget).reduce((total, [name, expected]) => {
        if (audit.variant_attributes[name] === expected) return total + 3;
        const observation = observeText(`${audit.row_text} ${audit.structured_text}`, name, expected);
        if (observation.matches) return total + 2;
        const selected = specSelections?.[name];
        if (selected?.found === true && selected?.selected === true && selected?.disabled !== true) return total + 1;
        return total;
      }, 0),
    })).sort((left, right) => right.score - left.score || left.audit.index - right.audit.index);
    const imagePrimaryChoice = imagePrimaryChoices[0] || null;
    const imagePrimaryTopChoices = imagePrimaryChoice
      ? imagePrimaryChoices.filter((choice) => choice.score === imagePrimaryChoice.score)
      : [];
    if ((!allowImagePrimary && !Object.keys(normalizedTarget).length && audits.length !== 1)
      || (!allowImagePrimary && Object.keys(normalizedTarget).length && matchingAudits.length !== 1)
      || (allowImagePrimary && !exactThumbnailChoice
        && (!imagePrimaryChoice || imagePrimaryTopChoices.length !== 1))) {
      return {
        found: true,
        set: false,
        value: null,
        reason_code: "variant_unbound",
        matched_rows: allowImagePrimary
          ? imagePrimaryTopChoices.length || compatibleAudits.length
          : Object.keys(normalizedTarget).length ? matchingAudits.length : audits.length,
      };
    }
    const chosen = allowImagePrimary
      ? exactThumbnailChoice || imagePrimaryChoice.audit
      : Object.keys(normalizedTarget).length ? matchingAudits[0] : audits[0];
    const imagePrimarySelectionMethod = exactThumbnailChoice
      ? "image_primary_exact_thumbnail_url"
      : "image_primary_best_target_overlap";
    const input = chosen.node;
    const optionalBoundary = (value) => {
      if (value === null || value === undefined || String(value).trim() === "") return Number.NaN;
      return Number(value);
    };
    const minimum = optionalBoundary(input.min || input.getAttribute("min"));
    const maximum = optionalBoundary(input.max || input.getAttribute("max"));
    if ((Number.isFinite(minimum) && minimum > 1) || (Number.isFinite(maximum) && maximum < 1)) {
      return {
        found: true, set: false, value: Number(input.value),
        min: Number.isFinite(minimum) ? minimum : null,
        max: Number.isFinite(maximum) ? maximum : null,
        row_key: chosen.row_key,
        row_index: chosen.index,
        variant_attributes: chosen.variant_attributes,
      };
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, "1");
    else input.value = "1";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "1" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
    const confirmedVariantAttributes = {};
    for (const [name, expected] of Object.entries(normalizedTarget)) {
      if (chosen.variant_attributes[name] === expected) {
        confirmedVariantAttributes[name] = chosen.variant_attributes[name];
        continue;
      }
      const observation = observeText(`${chosen.row_text} ${chosen.structured_text}`, name, expected);
      if (observation.observed && observation.matches) {
        confirmedVariantAttributes[name] = expected;
        continue;
      }
      const selected = specSelections?.[name];
      if (selected?.found === true && selected?.selected === true && selected?.disabled !== true) {
        confirmedVariantAttributes[name] = expected;
      }
    }
    return {
      found: true,
      set: Number(input.value) === 1,
      value: Number(input.value),
      min: Number.isFinite(minimum) ? minimum : null,
      max: Number.isFinite(maximum) ? maximum : null,
      row_key: chosen.row_key,
      row_index: chosen.index,
      matched_rows: 1,
      sku_ids: chosen.sku_ids,
      row_text: chosen.row_text,
      data_attributes: chosen.data_attributes,
      variant_attributes: confirmedVariantAttributes,
      observed_variant_attributes: chosen.variant_attributes,
      selection_method: allowImagePrimary
        ? imagePrimarySelectionMethod
        : "exact_variant",
      soft_tie: false,
      ...(allowImagePrimary && imagePrimarySelectionMethod === "image_primary_exact_thumbnail_url"
        ? {
          selected_sku_image_url: normalizedCandidateImageUrl,
          thumbnail_match_count: exactThumbnailRows.length,
        }
        : {}),
    };
  }, {
    operation: "set-quantity",
    targetVariant: target,
    specSelections: selectedSpecs,
    allowImagePrimary: imagePrimary,
    candidateImageUrl: signedOfferImageUrl,
    quantitySelectors: QUANTITY_INPUT_SELECTORS,
  });
}

async function interactWithTargetSupply(page, target, wait, interactionSettleMs, {
  imagePrimary = false,
  signedOfferImageUrl = null,
} = {}) {
  const specs = {};
  for (const [name, expected] of Object.entries(target)) {
    specs[name] = await selectExactSpecOption(page, name, expected);
    if (specs[name]?.found === true && interactionSettleMs > 0) await wait(interactionSettleMs);
  }
  const quantity = await setOrderQuantityToOne(page, target, specs, { imagePrimary, signedOfferImageUrl });
  if (quantity?.set === true && interactionSettleMs > 0) await wait(interactionSettleMs);
  return { specs, quantity };
}

async function captureSnapshot(page, responseStatus) {
  const snapshot = await page.evaluate((quantitySelectors) => {
    const visible = (node) => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const canonicalImageAssetUrl = (value) => {
      try {
        const parsed = new URL(String(value || "").trim(), document.baseURI);
        if (parsed.protocol !== "https:" || !parsed.hostname) return null;
        const hostname = parsed.hostname.toLocaleLowerCase("und");
        if (hostname === "alicdn.com" || hostname.endsWith(".alicdn.com")) {
          parsed.search = "";
          parsed.hash = "";
          if (parsed.pathname.endsWith("_sum.jpg")) {
            parsed.pathname = parsed.pathname.slice(0, -"_sum.jpg".length);
          }
        }
        return parsed.href;
      } catch {
        return null;
      }
    };
    const imageUrlsFrom = (root) => {
      const imageNodes = [root, ...root.querySelectorAll([
        "img", "source", "[data-image-url]", "[data-img]", "[data-src]",
        "[data-lazy-src]", "[data-original]", "[data-lazyload]",
      ].join(","))].slice(0, 200);
      const raw = [];
      for (const imageNode of imageNodes) {
        for (const attribute of [
          "src", "data-src", "data-image-url", "data-img", "data-lazy-src", "data-original", "data-lazyload",
        ]) raw.push(imageNode.getAttribute?.(attribute));
        raw.push(imageNode.currentSrc);
        const background = String(getComputedStyle(imageNode).backgroundImage || "");
        for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/giu)) raw.push(match[1]);
      }
      return [...new Set(raw.map(canonicalImageAssetUrl).filter(Boolean))];
    };
    const rows = (selector) => [...document.querySelectorAll(selector)].filter(visible);
    const attributes = (node) => Object.fromEntries([...node.attributes].map((entry) => [entry.name, entry.value]));
    const canonicalSpecName = (value) => {
      const normalized = String(value ?? "")
        .normalize("NFKC")
        .toLocaleLowerCase("und")
        .replace(/\s+/gu, "_")
        .replace(/-+/gu, "_")
        .replace(/^data_/u, "")
        .replace(/_(?:name|value|label|text)$/u, "")
        .trim();
      const aliases = [
        ["model", /^(?:model|model_name|модель|型号|款号)$/iu],
        ["article", /^(?:article|articul|артикул|货号|商品编号)$/iu],
        ["color", /^(?:colou?r|цвет|颜色|色号|颜色分类)$/iu],
        ["size", /^(?:size|размер|尺寸|尺码|规格)$/iu],
        ["capacity", /^(?:capacity|volume|объ[её]м|емкость|容量|容积|内存)$/iu],
        ["voltage_v", /^(?:voltage|voltage_v|напряжение|电压)$/iu],
        ["current_a", /^(?:current|current_a|amperage|ток|сила_тока|电流)$/iu],
        ["power_w", /^(?:power|power_w|wattage|мощность|功率)$/iu],
        ["cct_k", /^(?:cct|cct_k|colou?r_?temperature|цветовая_?температура|температура_?света|色温)$/iu],
        ["set_quantity", /^(?:set_?quantity|set_?count|pack_?count|package_?quantity|quantity|count|количество|комплект|套装数量|件数|数量)$/iu],
        ["head_count", /^(?:head_?count|heads?|lamp_?heads?|light_?heads?|shade_?count|plafond_?count|количество_?плафонов|灯头数量|灯头数|头数|灯数|罩数)$/iu],
        ["shape", /^(?:shape|form|форма|形状|外形)$/iu],
        ["interface", /^(?:interface|connector|port|интерфейс|разъ[её]м|接口)$/iu],
      ];
      return aliases.find(([, pattern]) => pattern.test(normalized))?.[0] || null;
    };
    const normalizeSpecValue = (value, canonical) => {
      let normalized = String(value ?? "")
        .normalize("NFKC")
        .toLocaleLowerCase("und")
        .replace(/\s+/gu, " ")
        .replace(/[×*]/gu, "x")
        .replace(/\s*([x:,;+])\s*/gu, "$1")
        .replace(/(\d)\s*(?:毫升|мл|ml)(?![a-zа-яё0-9])/giu, "$1ml")
        .replace(/(\d)\s*(?:升|литр(?:а|ов)?|l)(?![a-zа-яё0-9])/giu, "$1l")
        .replace(/(\d)\s*(?:gb|гб)(?![\p{L}\p{N}])/giu, "$1gb")
        .replace(/(\d)\s*(?:tb|тб)(?![\p{L}\p{N}])/giu, "$1tb")
        .replace(/(\d)\s*(?:mm|мм|毫米)(?![a-zа-яё0-9])/giu, "$1mm")
        .replace(/(\d)\s*(?:вольт(?:а|ов)?|伏特?)(?![a-zа-яё])/giu, "$1v")
        .replace(/(\d)\s*(?:amps?|ампер(?:а|ов)?|安培?)(?![a-zа-яё])/giu, "$1a")
        .replace(/(\d)\s*(?:watts?|ватт(?:а|ов)?|瓦)(?![a-zа-яё])/giu, "$1w")
        .replace(/(\d)\s*(?:v|в)(?![a-zа-яё])/giu, "$1v")
        .replace(/(\d)\s*(?:a|а)(?![a-zа-яё])/giu, "$1a")
        .replace(/(\d)\s*(?:w|вт)(?![a-zа-яё])/giu, "$1w")
        .replace(/(\d{4})\s*(?:k|к)(?![a-zа-яё0-9])/giu, "$1k")
        .replace(/type[\s_-]*c/giu, "type-c")
        .replace(/micro[\s_-]*usb/giu, "micro-usb")
        .trim();
      if (canonical === "set_quantity" || canonical === "head_count") {
        const count = normalized.match(/\d+(?:\.\d+)?/u)?.[0];
        if (count) normalized = String(Number(count));
      }
      if (canonical === "cct_k") {
        const values = new Set(normalized.match(/(?:(?<![a-zа-яё0-9.])|(?<=[vaw]))\d{4}k(?![a-zа-яё0-9])/giu) || []);
        if (values.size === 1) normalized = [...values][0];
      }
      if (canonical === "interface") {
        const hdmi = new Set();
        if (/(?:mini[\s_-]*hdmi|hdmi[\s_-]*mini|c\s*型\s*mini(?:[\s_-]*hdmi)?)/iu.test(normalized)) hdmi.add("mini-hdmi");
        if (/(?:micro[\s_-]*hdmi|hdmi[\s_-]*micro|d\s*型\s*micro(?:[\s_-]*hdmi)?)/iu.test(normalized)) hdmi.add("micro-hdmi");
        if (hdmi.size === 1) normalized = [...hdmi][0];
        else if (hdmi.size > 1) normalized = "__ambiguous__";
        else if (/^(?:usb[\s-]*)?(?:type-c|usb-c)$/iu.test(normalized)) normalized = "type-c";
      }
      if (canonical === "shape") {
        if (/^(?:square|方形|方型|正方形|квадратн(?:ый|ая|ое|ые))$/iu.test(normalized)) normalized = "square";
        else if (/^(?:round|圆形|圆型|圆款|кругл(?:ый|ая|ое|ые))$/iu.test(normalized)) normalized = "round";
      }
      if (canonical === "color") {
        const casingOnly = normalized
          .replace(/(?:^|[^\p{L}\p{N}])(?:warm|daylight|day[ -]?light|natural|neutral|cool|cold)\s+white(?:\s+(?:light|lighting))?(?=$|[^\p{L}\p{N}])/giu, " ")
          .replace(/(?:^|[^\p{L}\p{N}])(?:т[её]пл|дневн|нейтральн|естественн|холодн)\p{L}*\s+бел\p{L}*(?:\s+свет\p{L}*)?(?=$|[^\p{L}\p{N}])/giu, " ")
          .replace(/(?:暖白|日光白|自然白|中性白|冷白)(?:色)?(?:灯?光)?/gu, " ")
          .replace(/\s+/gu, " ")
          .trim();
        if (casingOnly) normalized = casingOnly;
        else if (casingOnly !== normalized) return normalized;
        const colors = new Map([
          ["黑色", "black"], ["black", "black"], ["черный", "black"], ["чёрный", "black"],
          ["白色", "white"], ["white", "white"], ["белый", "white"],
          ["红色", "red"], ["red", "red"], ["красный", "red"],
          ["蓝色", "blue"], ["blue", "blue"], ["синий", "blue"],
          ["绿色", "green"], ["绿", "green"], ["荧光绿", "green"], ["green", "green"], ["зеленый", "green"], ["зелёный", "green"],
          ["黄色", "yellow"], ["yellow", "yellow"], ["желтый", "yellow"], ["жёлтый", "yellow"],
          ["粉色", "pink"], ["pink", "pink"], ["розовый", "pink"],
          ["灰色", "gray"], ["grey", "gray"], ["gray", "gray"], ["серый", "gray"],
          ["玫瑰金", "rose_gold"], ["rose gold", "rose_gold"], ["rose-gold", "rose_gold"],
          ["金色", "gold"], ["gold", "gold"], ["golden", "gold"],
          ["золотой", "gold"], ["золотая", "gold"], ["золотое", "gold"],
          ["золотистый", "gold"], ["золотистая", "gold"], ["золотистое", "gold"],
          ["透明", "transparent"], ["transparent", "transparent"],
          ["紫色", "purple"], ["紫", "purple"], ["purple", "purple"], ["violet", "purple"],
        ]);
        const exactColor = colors.get(normalized);
        if (exactColor) normalized = exactColor;
        else {
          const hasRoseGold = /玫瑰金|(?:^|[^\p{L}\p{N}])rose[\s-]*gold(?=$|[^\p{L}\p{N}])|розов\p{L}*[\s-]+золот\p{L}*/iu.test(normalized);
          const colorRemainder = hasRoseGold
            ? normalized.replace(/玫瑰金|(?:^|[^\p{L}\p{N}])rose[\s-]*gold(?=$|[^\p{L}\p{N}])|розов\p{L}*[\s-]+золот\p{L}*/giu, " ")
            : normalized;
          const explicitColors = new Set([
            ["black", /黑色|(?:^|[^\p{L}\p{N}])(?:black|черн(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["white", /白色|(?:^|[^\p{L}\p{N}])(?:white|бел(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["gray", /灰色|(?:^|[^\p{L}\p{N}])(?:gr[ae]y|сер(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["red", /红色|(?:^|[^\p{L}\p{N}])(?:red|красн(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["blue", /蓝色|(?:^|[^\p{L}\p{N}])(?:blue|син(?:ий|яя|ее|ие|его|юю|ем))(?=$|[^\p{L}\p{N}])/iu],
            ["green", /(?:荧光绿|绿色|绿(?=高韧|PETG|PLA|TPU|ABS|耗材|线材|款|版|壳|套|$))|(?:^|[^\p{L}\p{N}])(?:green|зел[её]н(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["yellow", /黄色|(?:^|[^\p{L}\p{N}])(?:yellow|ж[её]лт(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["pink", /粉色|(?:^|[^\p{L}\p{N}])(?:pink|розов(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["purple", /紫色|(?:^|[^\p{L}\p{N}])(?:purple|violet|фиолетов(?:ый|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["rose_gold", /玫瑰金|(?:^|[^\p{L}\p{N}])rose[\s-]*gold(?=$|[^\p{L}\p{N}])|розов\p{L}*[\s-]+золот\p{L}*/iu],
            ["gold", /金色|(?:^|[^\p{L}\p{N}])(?:gold(?:en)?|золот(?:ой|ая|ое|ые|ого|ую|ом))(?=$|[^\p{L}\p{N}])/iu],
            ["transparent", /透明|(?:^|[^\p{L}\p{N}])transparent(?=$|[^\p{L}\p{N}])/iu],
          ].filter(([color, pattern]) => color !== "rose_gold" && pattern.test(colorRemainder)).map(([color]) => color));
          if (hasRoseGold) explicitColors.add("rose_gold");
          if (explicitColors.size === 1) normalized = [...explicitColors][0];
          else if (explicitColors.size > 1) normalized = "__ambiguous__";
        }
      }
      return normalized;
    };
    const explicitCapacityValues = (value) => {
      const normalized = normalizeSpecValue(value, null);
      return new Set(normalized.match(/(?<![a-zа-яё0-9.])\d+(?:\.\d+)?(?:ml|l|gb|tb)(?![a-zа-яё0-9])/giu) || []);
    };
    const explicitMillimetreValues = (value) => {
      const normalized = normalizeSpecValue(value, null);
      return new Set(normalized.match(/(?<![a-zа-яё0-9.])\d+(?:\.\d+)?mm(?![a-zа-яё0-9])/giu) || []);
    };
    const explicitElectricalValues = (value, name) => {
      const normalized = normalizeSpecValue(value, null);
      const suffix = name === "voltage_v" ? "v" : name === "current_a" ? "a" : name === "power_w" ? "w" : null;
      if (!suffix) return new Set();
      return new Set(normalized.match(new RegExp(`(?:(?<![a-zа-яё0-9.])|(?<=[vaw]))\\d+(?:\\.\\d+)?${suffix}(?![a-zа-яё])`, "giu")) || []);
    };
    const explicitCctValues = (value) => {
      const normalized = normalizeSpecValue(value, null);
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
    const putSpec = (target, rawName, rawValue) => {
      const name = canonicalSpecName(rawName);
      const value = normalizeSpecValue(rawValue, name);
      if (name && value && !target[name]) target[name] = value;
    };
    const objectSpecs = (object) => {
      const result = {};
      if (!object || typeof object !== "object") return result;
      const sources = [object, object.attributes, object.variant_attributes, object.specs, object.properties]
        .filter((source) => source && typeof source === "object");
      for (const source of sources) {
        if (Array.isArray(source)) {
          for (const row of source) {
            if (!row || typeof row !== "object") continue;
            putSpec(result, row.name ?? row.label ?? row.key ?? row.attribute_name ?? row.prop_name,
              row.value ?? row.text ?? row.attribute_value ?? row.value_name ?? row.values?.[0]);
          }
        } else {
          for (const [name, value] of Object.entries(source)) {
            if (value && typeof value === "object" && !Array.isArray(value)) {
              putSpec(result, value.name ?? value.label ?? name, value.value ?? value.text ?? value.value_name);
            } else putSpec(result, name, value);
          }
        }
      }
      return result;
    };
    const objectSkuIds = (object) => Object.entries(object || {}).flatMap(([name, value]) => {
      const key = String(name).toLocaleLowerCase("und").replace(/[\s_.:\-/]+/gu, "");
      if (!/(?:sku|variant)(?:id|key)$/iu.test(key)) return [];
      const id = String(value ?? "").trim().toLocaleLowerCase("und");
      return id ? [id] : [];
    });
    const specGroup = (node) => {
      const names = ["data-prop-name", "data-property-name", "data-sku-prop-name", "data-spec-name"];
      for (const name of names) {
        if (canonicalSpecName(node.getAttribute(name))) return node.getAttribute(name);
        const owner = node.closest(`[${name}]`);
        if (canonicalSpecName(owner?.getAttribute(name))) return owner.getAttribute(name);
      }
      let parent = node.parentElement;
      for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
        const label = [...parent.querySelectorAll(":scope > label, :scope > legend, :scope > dt, :scope > h3, :scope > h4, :scope > span")]
          .slice(0, 12)
          .find((entry) => canonicalSpecName(entry.textContent));
        if (label) return String(label.textContent || "").trim();
      }
      return "";
    };
    const buttons = rows('button, [role="button"], a[class*="order" i], a[class*="buy" i]')
      .slice(0, 200).map((node) => ({
        text: String(node.innerText || node.textContent || "").trim(),
        disabled: Boolean(node.disabled),
        aria_disabled: node.getAttribute("aria-disabled") === "true",
        class_name: String(node.className || ""),
      }));
    const specOptions = rows([
      "[data-sku-id]", "[data-value-name]", "[data-prop-value]", "[data-property-value]",
      '[role="option"]', '[class*="sku" i] li', '[class*="sku" i] button',
      '[class*="prop" i] li', '[class*="prop" i] button', '[class*="spec" i] li',
      '.module-od-sku-selection .expand-view-item',
    ].join(","))
      .slice(0, 500).map((node) => ({
        group: specGroup(node),
        value: node.getAttribute("data-value-name")
          || node.getAttribute("data-prop-value")
          || node.getAttribute("data-property-value")
          || node.getAttribute("title")
          || node.getAttribute("aria-label")
          || node.querySelector(".item-label[title]")?.getAttribute("title")
          || node.querySelector(".item-label")?.textContent
          || String(node.innerText || node.textContent || "").trim(),
        disabled: Boolean(node.disabled) || node.getAttribute("aria-disabled") === "true",
        selected: node.getAttribute("aria-selected") === "true"
          || node.getAttribute("data-selected") === "true"
          || node.matches(":checked")
          || Boolean(node.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked'))
          || /(?:^|[\s_-])(?:selected|active|current)(?:$|[\s_-])/iu.test(String(node.className || "")),
        class_name: String(node.className || ""),
        attributes: attributes(node),
      }));
    let livePageContext = null;
    try {
      const serializedContext = JSON.stringify(window.context);
      if (serializedContext && serializedContext.length <= 2_000_000) {
        livePageContext = JSON.parse(serializedContext);
      }
    } catch {
      // A malformed or cyclic page global is not trusted as procurement evidence.
    }
    const structuredVariants = [];
    const structuredQueue = livePageContext && typeof livePageContext === "object" ? [livePageContext] : [];
    const structuredSeen = new Set();
    for (let visits = 0; structuredQueue.length && visits < 10_000; visits += 1) {
      const current = structuredQueue.shift();
      if (!current || typeof current !== "object" || structuredSeen.has(current)) continue;
      structuredSeen.add(current);
      const skuIds = objectSkuIds(current);
      if (skuIds.length) structuredVariants.push({ sku_ids: skuIds, attributes: objectSpecs(current) });
      if (Array.isArray(current)) structuredQueue.push(...current.filter((value) => value && typeof value === "object"));
      else structuredQueue.push(...Object.values(current).filter((value) => value && typeof value === "object"));
    }
    const quantityInputs = rows(quantitySelectors.join(","))
      .filter((node) => !node.closest('header, nav, [role="search"], [class*="search" i], [class*="checkout" i], #submitOrder, [data-module="od_submit_order"]'))
      .slice(0, 50).map((node, index) => {
        const root = node.closest([
          ".gyp-pro-table-row", "[class*='gyp-pro-table-row']", ".expand-view-item", "[data-sku-id]", "[data-offer-sku-id]", "[data-variant-id]",
          "[data-sku-item]", "[role='option']", "tr", "li",
        ].join(",")) || node.parentElement || node;
        const variantAttributes = {};
        const dataAttributes = {};
        const auditNodes = [root, ...root.querySelectorAll("[data-prop-name], [data-property-name], [data-sku-prop-name], [data-spec-name], [data-value-name], [data-prop-value], [data-property-value], [title]")].slice(0, 200);
        for (const auditNode of auditNodes) {
          for (const attribute of [...auditNode.attributes]) {
            if (attribute.name.startsWith("data-")) dataAttributes[attribute.name] = attribute.value;
            putSpec(variantAttributes, attribute.name, attribute.value);
          }
          const group = auditNode.getAttribute("data-prop-name") || auditNode.getAttribute("data-property-name")
            || auditNode.getAttribute("data-sku-prop-name") || auditNode.getAttribute("data-spec-name");
          const value = auditNode.getAttribute("data-value-name") || auditNode.getAttribute("data-prop-value")
            || auditNode.getAttribute("data-property-value") || auditNode.getAttribute("title")
            || auditNode.querySelector?.(".item-label[title]")?.getAttribute("title")
            || auditNode.querySelector?.(".item-label")?.textContent;
          putSpec(variantAttributes, group, value);
        }
        const heading = root.closest(".feature-item")?.querySelector(".feature-item-label h3");
        putSpec(variantAttributes, heading?.textContent,
          root.querySelector(".item-label[title]")?.getAttribute("title")
            || root.querySelector(".item-label")?.textContent);
        const skuIds = [...new Set(auditNodes.flatMap((auditNode) => [...auditNode.attributes].flatMap((attribute) => {
          const key = String(attribute.name).toLocaleLowerCase("und").replace(/[\s_.:\-/]+/gu, "");
          const id = String(attribute.value || "").trim().toLocaleLowerCase("und");
          return /(?:sku|variant)(?:id|key)$/iu.test(key) && id ? [id] : [];
        })))];
        const structuredAttributes = {};
        for (const variant of structuredVariants.filter((entry) => entry.sku_ids.some((id) => skuIds.includes(id)))) {
          for (const [name, value] of Object.entries(variant.attributes)) {
            if (!structuredAttributes[name]) structuredAttributes[name] = value;
            else if (structuredAttributes[name] !== value) structuredAttributes[name] = "__ambiguous__";
          }
        }
        const rowText = String(root.innerText || root.textContent || "").trim();
        const rowPriceContainer = root.querySelector(":scope .gyp-pro-table-price");
        const rowPriceNode = rowPriceContainer?.querySelector(":scope > span")
          || rowPriceContainer?.firstElementChild
          || null;
        const rowStockNode = rowPriceContainer?.querySelector(":scope > span:nth-child(2)") || null;
        const rowPriceText = String(rowPriceNode?.innerText || rowPriceNode?.textContent || "").trim();
        const rowStockText = String(rowStockNode?.innerText || rowStockNode?.textContent || "").trim();
        const stockCount = /^\d+(?:\.\d+)?$/u.test(rowStockText) ? Number(rowStockText) : null;
        const skuImageUrls = imageUrlsFrom(root);
        const resolvedVariantAttributes = { ...structuredAttributes, ...variantAttributes };
        const rawSize = resolvedVariantAttributes.size;
        const capacities = explicitCapacityValues(rawSize);
        if (!resolvedVariantAttributes.capacity && capacities.size === 1) {
          resolvedVariantAttributes.capacity = [...capacities][0];
        }
        const millimetres = explicitMillimetreValues(rawSize);
        if (millimetres.size === 1) resolvedVariantAttributes.size = [...millimetres][0];
        for (const name of ["voltage_v", "current_a", "power_w"]) {
          const values = explicitElectricalValues(rawSize, name);
          if (!resolvedVariantAttributes[name] && values.size === 1) {
            resolvedVariantAttributes[name] = [...values][0];
          } else if (!resolvedVariantAttributes[name] && values.size > 1) {
            resolvedVariantAttributes[name] = "__ambiguous__";
          }
        }
        const rawColor = resolvedVariantAttributes.color;
        const cctValues = explicitCctValues(`${rawSize || ""} ${rawColor || ""} ${rowText}`);
        if (!resolvedVariantAttributes.cct_k && cctValues.size === 1) {
          resolvedVariantAttributes.cct_k = [...cctValues][0];
        } else if (!resolvedVariantAttributes.cct_k && cctValues.size > 1) {
          resolvedVariantAttributes.cct_k = "__ambiguous__";
        }
        if (cctValues.size && (explicitCctValues(rawColor).size || isLightColourOnly(rawColor))) {
          delete resolvedVariantAttributes.color;
        }
        if (!resolvedVariantAttributes.interface && rawSize) {
          const subtype = normalizeSpecValue(rawSize, "interface");
          if (new Set(["mini-hdmi", "micro-hdmi", "__ambiguous__"]).has(subtype)) {
            resolvedVariantAttributes.interface = subtype;
          }
        }
        return {
          value: String(node.value || ""),
          min: node.min || node.getAttribute("min") || null,
          max: node.max || node.getAttribute("max") || null,
          disabled: Boolean(node.disabled),
          read_only: Boolean(node.readOnly),
          class_name: String(node.className || ""),
          row_key: skuIds.length ? `sku:${skuIds.join("|")}` : `index:${index}`,
          row_index: index,
          sku_ids: skuIds,
          row_text: rowText,
          context_text: rowText,
          row_price_text: rowPriceText || null,
          row_price_source: rowPriceText ? "gyp-pro-table-price:first-span" : null,
          stock_count: Number.isFinite(stockCount) && stockCount >= 0 ? stockCount : null,
          stock_source: Number.isFinite(stockCount) && stockCount >= 0
            ? "gyp-pro-table-price:second-span"
            : null,
          data_attributes: dataAttributes,
          variant_attributes: resolvedVariantAttributes,
          structured_variant_attributes: structuredAttributes,
          sku_image_urls: skuImageUrls,
        };
      });
    const structuredData = [
      ...(livePageContext ? [livePageContext] : []),
      ...[...document.querySelectorAll("script")]
      .filter((node) => {
        const type = String(node.type || "").toLowerCase();
        const source = String(node.textContent || "").trim();
        return type === "application/ld+json" || type === "application/json"
          || ((source.startsWith("{") || source.startsWith("[") || source.includes("window.__") || source.includes("window.context"))
            && /(?:sku|price|offer|inventory|stock|minOrder)/iu.test(source));
      })
      .slice(0, 100).map((node) => String(node.textContent || "").slice(0, 500_000)),
    ];
    const mainPriceTexts = rows([
      ".module-od-main-price", "[data-module='od_main_price']", "[data-module='od-main-price']",
      ".od-price-container", "[class*='main-price' i]", "[data-testid*='main-price' i]",
    ].join(","))
      .slice(0, 30).map((node) => String(node.innerText || node.textContent || "").trim());
    return {
      url: String(location.href || ""),
      title: String(document.title || ""),
      body: String(document.body?.innerText || "").slice(0, 100_000),
      security_text: rows('[class*="captcha" i], [class*="login" i], [class*="verify" i], [role="dialog"]')
        .slice(0, 50).map((node) => String(node.innerText || node.textContent || "").trim()).join("\n").slice(0, 10_000),
      structured_data: structuredData,
      dom_snapshot: {
        buttons,
        spec_options: specOptions,
        quantity_inputs: quantityInputs,
        main_price_texts: mainPriceTexts,
        price_texts: mainPriceTexts,
      },
    };
  }, QUANTITY_INPUT_SELECTORS);
  return { ...snapshot, http_status: responseStatus ?? snapshot.http_status ?? null };
}

function transientError(error) {
  const chain = [];
  let current = error;
  for (let index = 0; current && index < 8; index += 1) {
    chain.push(current);
    current = current?.cause;
  }
  const message = chain.map((entry) => text(entry?.message ?? entry)).join(" ");
  const code = chain.map((entry) => text(entry?.code)).find(Boolean) || "";
  if (/captcha|验证码|滑块验证|安全验证|人机验证/iu.test(`${code} ${message}`)) {
    return failure("captcha", message || "1688 captcha is present", { transient: true });
  }
  if (/auth(?:entication)?|login|logged[ -]?out|session[ -]?expired|登录|会话失效/iu.test(`${code} ${message}`)) {
    return failure("authentication_required", message || "1688 authentication is required", {
      transient: true,
      authentication: true,
    });
  }
  const timeout = TRANSIENT_CODES.has(code) || /timeout|timed out|net::ERR_|target closed|browser.*closed/iu.test(message);
  return failure(timeout ? "timeout" : "navigation_error", message || "1688 page inspection failed", { transient: true });
}

function candidateFailure(result, candidate, attempt, cached = false) {
  return {
    offer_id: candidate.offer_id,
    offer_url: candidate.offer_url,
    attempt,
    status: result.status,
    reason: result.reason,
    reason_code: result.reason_code,
    retryable: result.retryable,
    transient: result.transient,
    deterministic: result.deterministic,
    cached,
  };
}

export function create1688SupplyVerifier({
  pageProvider,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  retryDelaysMs = SUPPLY_RETRY_DELAYS_MS,
  maxCandidates = 3,
  evidenceTtlMs = SUPPLY_EVIDENCE_TTL_MS,
  failureCacheMs = 60_000,
  navigationTimeoutMs = 45_000,
  settleMs = 1_000,
  interactionSettleMs = 250,
} = {}) {
  if (typeof pageProvider !== "function") throw new TypeError("pageProvider must be a function");
  if (typeof sleep !== "function") throw new TypeError("sleep must be a function");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const successCache = new Map();
  const failureCache = new Map();
  const cacheKey = (candidate, target, key, targetTitle) => [
    candidate.offer_id,
    JSON.stringify(target),
    key,
    text(targetTitle),
    JSON.stringify(candidate.image_match_evidence || null),
  ].join("\n");

  async function inspect(candidate, input, attempt) {
    let lease;
    try {
      lease = await pageProvider({ candidate, attempt });
      const page = lease?.page || lease;
      if (!page || typeof page.goto !== "function" || typeof page.evaluate !== "function") {
        throw new TypeError("pageProvider must return a Playwright Page or { page, release }");
      }
      const response = await page.goto(candidate.offer_url, {
        waitUntil: "domcontentloaded",
        timeout: Math.max(1, Number(navigationTimeoutMs) || 45_000),
      });
      const pageWait = async (ms) => {
        if (!(ms > 0)) return;
        if (typeof page.waitForTimeout === "function") await page.waitForTimeout(ms);
        else await sleep(ms);
      };
      await pageWait(settleMs);
      const interaction = await interactWithTargetSupply(
        page,
        normalizeTargetVariant(input.targetVariant),
        pageWait,
        Math.max(0, Number(interactionSettleMs) || 0),
      );
      const snapshot = await captureSnapshot(page, response?.status?.() ?? null);
      snapshot.interaction = interaction;
      const exactResult = classify1688SupplySnapshot(snapshot, {
        candidate,
        targetVariant: input.targetVariant,
        targetTitle: input.targetTitle,
        itemLevelMatch: input.itemLevelMatch,
        matchEvidenceKey: input.matchEvidenceKey || candidate.match_evidence_key,
        now,
        evidenceTtlMs,
      });
      const imageAssessment = assessImagePrimaryCandidate(candidate);
      const target = normalizeTargetVariant(input.targetVariant);
      if (exactResult.ok
        || !imageAssessment.ok
        || Number(target.set_quantity) > 1
        || !["variant_unbound", "spec_mismatch"].includes(exactResult.reason_code)) {
        return exactResult;
      }
      const imageInteraction = await interactWithTargetSupply(
        page,
        target,
        pageWait,
        Math.max(0, Number(interactionSettleMs) || 0),
        {
          imagePrimary: true,
          signedOfferImageUrl: imageAssessment.evidence.image_url,
        },
      );
      const imageSnapshot = await captureSnapshot(page, response?.status?.() ?? null);
      imageSnapshot.interaction = imageInteraction;
      return classify1688SupplySnapshot(imageSnapshot, {
        candidate,
        targetVariant: input.targetVariant,
        targetTitle: input.targetTitle,
        itemLevelMatch: false,
        matchEvidenceKey: input.matchEvidenceKey || candidate.match_evidence_key,
        variantMatchMode: "image_primary",
        now,
        evidenceTtlMs,
      });
    } catch (error) {
      return transientError(error);
    } finally {
      if (lease?.page && typeof lease.release === "function") {
        await Promise.resolve().then(() => lease.release()).catch(() => {});
      }
    }
  }

  async function verify(input = {}) {
    if (String(input?.balancedMatch?.match_type || "") === "corroborated_multi") {
      const supporting = new Set(
        (input?.balancedMatch?.supporting_offer_ids || []).map(text).filter(Boolean),
      );
      const signedRows = (Array.isArray(input.candidates) ? input.candidates : [])
        .filter((candidate) => !supporting.size || supporting.has(offerIdFrom(candidate)))
        .map((candidate) => candidate?.image_match_evidence || candidate);
      const supportingModelConflict = corroboratedSupportingModelConflict(signedRows);
      if (supportingModelConflict.conflict) {
        return failure(
          "supporting_model_conflict",
          `corroborated 1688 offers disagree on explicit model: ${supportingModelConflict.reason}`,
        );
      }
    }
    const candidates = strictCandidates(
      input.candidates, input.balancedMatch, input.matchEvidenceKey, maxCandidates,
    );
    const target = normalizeTargetVariant(input.targetVariant);
    const itemLevelMatch = input.itemLevelMatch === true || (!Object.keys(target).length && input.targetVariant?.required !== true);
    if (!candidates.length) return failure("strict_match_required", "no strong_single or corroborated_multi 1688 candidate is available");
    const evidenceKey = text(input.matchEvidenceKey || candidates[0]?.match_evidence_key);
    if (!/^[a-f0-9]{64}$/iu.test(evidenceKey)) return failure("missing_match_evidence", "valid signed 1688 match evidence key is required");
    const candidateFailures = [];
    let attemptCount = 0;
    for (const candidate of candidates) {
      // This check intentionally precedes both caches and pageProvider. A
      // previously cached image success must not keep a branded device clone
      // alive after its signed title proves that brand/model identity is
      // absent or contradictory.
      const preNavigationConflicts = explicitRoleAndProtocolConflicts({
        targetTitle: input.targetTitle,
        candidate,
        target,
      });
      if (preNavigationConflicts.length) {
        const result = failure(
          "image_identity_conflict",
          `1688 candidate has an explicit identity conflict: ${preNavigationConflicts.join(", ")}`,
        );
        candidateFailures.push(candidateFailure(result, candidate, 0));
        continue;
      }
      const key = cacheKey(candidate, target, evidenceKey, input.targetTitle);
      if (input.force !== true) {
        const cached = successCache.get(key);
        if (cached && isFreshSupplyEvidence(cached.evidence, { now })) {
          return { ...cached, cached: true, attempts: 0, candidate_failures: candidateFailures };
        }
        successCache.delete(key);
        const failed = failureCache.get(key);
        if (failed && epoch(now) < failed.expiresAt) {
          candidateFailures.push(candidateFailure(failed.result, candidate, 0, true));
          continue;
        }
        failureCache.delete(key);
      }
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (attempt > 1) await sleep(Math.max(0, Number(retryDelaysMs[attempt - 2]) || 0));
        attemptCount += 1;
        const result = await inspect(candidate, { ...input, itemLevelMatch, matchEvidenceKey: evidenceKey }, attempt);
        if (result.ok) {
          const complete = { ...result, cached: false, attempts: attemptCount, candidate_failures: candidateFailures };
          successCache.set(key, complete);
          return complete;
        }
        candidateFailures.push(candidateFailure(result, candidate, attempt));
        if (result.deterministic) {
          if (failureCacheMs > 0) failureCache.set(key, { result, expiresAt: epoch(now) + failureCacheMs });
          break;
        }
        if (attempt === 3) return { ...result, attempts: attemptCount, candidate_failures: candidateFailures };
      }
    }
    return {
      ...failure("all_candidates_failed", "all strict 1688 candidates failed deterministic orderability checks"),
      attempts: attemptCount,
      candidate_failures: candidateFailures,
    };
  }

  return {
    verify,
    close: async () => { successCache.clear(); failureCache.clear(); },
    clearCache: () => { successCache.clear(); failureCache.clear(); },
  };
}

export async function verify1688SupplyCandidates(options = {}) {
  const verifier = create1688SupplyVerifier(options);
  try { return await verifier.verify(options); } finally { await verifier.close(); }
}
