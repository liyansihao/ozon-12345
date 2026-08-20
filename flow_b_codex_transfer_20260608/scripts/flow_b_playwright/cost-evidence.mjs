import crypto from "node:crypto";

export const RELIABLE_1688_COST_SOURCES = Object.freeze([
  "search_first_page_p70_similarity_filtered",
  "search_first_page_cluster_p70_similarity_filtered",
  "search_first_page_cluster_p80_similarity_filtered",
]);

const RELIABLE_SOURCE_SET = new Set(RELIABLE_1688_COST_SOURCES);
const MATCH_EVIDENCE_KEY_RE = /^[a-f0-9]{64}$/u;

// This is deliberately a derived policy decision, not a replacement for the
// signed v3 payload.  The selected row still has to come from the payload
// covered by MATCH_EVIDENCE_KEY and is propagated through the existing
// cost/candidate/SupplyEvidence canonical binding.
export const SIGNED_IMAGE_PRIMARY_STRONG_SINGLE_POLICY = "signed-image-primary-strong-single-v1";
export const SIGNED_CORROBORATED_SUPPORT_REBIND_POLICY = "signed-corroborated-support-rebind-v1";

const IMAGE_TEXT_SOFT_SCORE = 0.90;
const IMAGE_TEXT_SOFT_COLOR_SCORE = 0.90;
const IMAGE_TEXT_SOFT_DHASH_SCORE = 0.82;
const VALUABLE_DIGITAL_IMAGE_ONLY_PRICE_CNY = 300;
const OUTDOOR_FROSTPROOF_FAUCET_ROLE = "outdoor_frostproof_faucet";

const CONSUMABLE_PRODUCT_RE = /(?:\bcartridges?\b|\btoners?\b|\bink\s*(?:cartridges?|bottles?)\b|картридж|тонер|чернил|墨盒|硒鼓|碳粉|粉盒)/iu;
const PRINTER_PRODUCT_RE = /(?:\bprinters?\b|принтер|打印机)/iu;
const ACCESSORY_PRODUCT_RE = /(?:\bstraps?\b|\bbands?\b|\bcases?\b|\bcovers?\b|\bchargers?\b|\bcharging\s+cables?\b|\bdata\s+cables?\b|ремеш|браслет|чехол|заряд|кабел|表带|腕带|保护壳|手机壳|充电线|数据线|充电器)/iu;
const MAIN_PRODUCT_PATTERNS = Object.freeze([
  /(?:\bwatches?\b|смарт[ -]?час|\bчасы\b|智能手表)/iu,
  /(?:\bphones?\b|смартфон|телефон|手机)/iu,
  PRINTER_PRODUCT_RE,
  /(?:\bcameras?\b|фотоаппарат|камера|相机)/iu,
]);

// A stylus sleeve can share every broad token (iPad, pencil, stylus) and even
// a similar silhouette with the pen itself. Keep this role detector narrow:
// only explicit sleeve/case/holder phrases become accessories. A real stylus
// that merely ships "with a sleeve" therefore remains a core product.
const STYLUS_CORE_RE = /(?:\bstylus(?:\s+pen)?\b|\bdigital\s+pen\b|\bcapacitive\s+pen\b|\bapple\s+pencil\b|стилус\p{L}*|触控笔|电容笔|手写笔)/iu;
const STYLUS_BUNDLED_ACCESSORY_RE = /(?:(?:stylus(?:\s+pen)?|digital\s+pen|capacitive\s+pen|apple\s+pencil)(?:(?!\b(?:sleeve|case|cover|holder|pouch)\b).){0,20}\bwith\s+(?:an?\s+)?(?:protective\s+|silicone\s+|storage\s+)?(?:sleeve|case|cover|holder|pouch)|стилус\p{L}*(?:(?!(?:чехол|футляр|держатель|пенал|карман)\p{L}*).){0,30}(?:\bс\s+чехл\p{L}*|в\s+комплекте.{0,12}чехл\p{L}*)|(?:触控笔|电容笔|手写笔)(?:(?!(?:笔套|收纳套|保护套|皮套|笔袋|笔盒|收纳盒|支架)).){0,12}(?:赠送?|附赠|带有?|包含?|含有?|配有?|随附).{0,8}(?:笔套|收纳套|保护套|皮套|笔袋|笔盒|收纳盒|支架))/iu;
const STYLUS_ACCESSORY_RE = /(?:(?:stylus(?:\s+pen)?|digital\s+pen|capacitive\s+pen|apple\s+pencil)(?:\s+(?:protective|silicone|elastic|portable|storage|carrying|dedicated|pencil)){0,4}\s+(?:sleeve|case|cover|holder|pouch)|(?:sleeve|case|cover|holder|pouch)(?:\s+(?:protective|silicone|elastic|portable|storage|carrying|dedicated)){0,4}\s+(?:for|compatible\s+with)\s+(?:a\s+)?(?:stylus(?:\s+pen)?|digital\s+pen|capacitive\s+pen|apple\s+pencil)|(?:чехол|футляр|держатель|пенал|карман)\p{L}*(?:\s+\p{L}+){0,4}\s+для\s+(?:стилус\p{L}*|apple\s+pencil)|(?:стилус\p{L}*|apple\s+pencil)(?:\s+(?:защитн\p{L}*|силиконов\p{L}*|портативн\p{L}*|специальн\p{L}*)){0,4}\s+(?:чехол|футляр|держатель|пенал|карман)\p{L}*|(?:apple\s+pencil|触控笔|电容笔|手写笔)\s*(?:(?:专用|硅胶|便携|弹力|莱卡|保护|收纳|的)\s*){0,4}(?:笔套|收纳套|保护套|皮套|笔袋|笔盒|收纳盒|支架)|(?:笔套|收纳套|保护套|皮套|笔袋|笔盒|收纳盒|支架)\s*(?:(?:专用|硅胶|便携|弹力|莱卡|保护|收纳|适用于?|用于|的)\s*){0,4}(?:apple\s+pencil|触控笔|电容笔|手写笔))/iu;

export function stylusProductAccessoryRole(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  if (!STYLUS_CORE_RE.test(source)) return null;
  if (STYLUS_BUNDLED_ACCESSORY_RE.test(source)) return "stylus_core";
  return STYLUS_ACCESSORY_RE.test(source) ? "stylus_accessory" : "stylus_core";
}
const COLOR_PATTERNS = Object.freeze([
  ["black", /(?:\bblack\b|черн\p{L}*|黑色?|雅黑)/iu],
  ["white", /(?:\bwhite\b|бел\p{L}*|白色?|象牙白)/iu],
  ["gray", /(?:\bgr[ae]y\b|сер\p{L}*|灰色?|银灰)/iu],
  ["red", /(?:\bred\b|красн\p{L}*|红色?)/iu],
  ["blue", /(?:\bblue\b|син\p{L}*|голуб\p{L}*|蓝色?)/iu],
  ["green", /(?:\bgreen\b|зел[её]н\p{L}*|салатн\p{L}*|绿色?)/iu],
  ["purple", /(?:\bpurple\b|violet|фиолет\p{L}*|пурпурн\p{L}*|紫色?)/iu],
  ["pink", /(?:\bpink\b|розов\p{L}*|粉色?)/iu],
  ["yellow", /(?:\byellow\b|ж[её]лт\p{L}*|黄色?)/iu],
  ["orange", /(?:\borange\b|оранжев\p{L}*|橙色?)/iu],
  ["brown", /(?:\bbrown\b|коричнев\p{L}*|棕色?|咖啡色)/iu],
]);

export function isReliable1688CostSource(value) {
  return RELIABLE_SOURCE_SET.has(String(value || "").trim());
}

export function isValid1688MatchEvidenceKey(value) {
  return MATCH_EVIDENCE_KEY_RE.test(String(value || "").trim());
}

export function normalize1688MatchRequest(value = {}) {
  const normalize = (candidate) => String(candidate ?? "")
    .toLocaleLowerCase("und")
    .replace(/\s+/gu, " ")
    .trim();
  const price = Number(value?.expect_price_cny);
  return {
    expect_category: normalize(value?.expect_category),
    expect_model: normalize(value?.expect_model),
    expect_title: normalize(value?.expect_title),
    expect_price_cny: Number.isFinite(price) && price > 0 ? price : null,
  };
}

function canonicalExplicitModelToken(value) {
  const token = String(value || "")
    .normalize("NFKC")
    .toLocaleUpperCase("und")
    .replace(/[-_\s]/gu, "");
  if (!token
    || token.length > 32
    || !/[A-Z\p{Script=Cyrillic}]/u.test(token)
    || !/\d/u.test(token)) return null;
  // Protocol/category terms and technical ratings are not product models.
  // OBD2 was previously sufficient to label unrelated scanners exact_model.
  if (/^(?:(?:OBD|EOBD|JOBD)\d*[A-Z0-9]*|ОБД\d*[A-Z0-9]*)$/u.test(token)) return null;
  if (/^(?:IP|ARGB|RGB|PWM|USB|HDMI|WIFI|ZIGBEE|BT|BLE|LORA|MP|LED|COB|ISO|PCS|NO)\d+[A-Z0-9]*$/u.test(token)) return null;
  if (/^(?:GU10|GX53|E14|E27|E40|G4|G9|B22|R7S|2G11)$/u.test(token)) return null;
  if (/^\d+(?:\.\d+)?(?:V|W|A|MAH|MM|CM|ML|L|KG|G|GB|TB|PCS?)$/u.test(token)) return null;
  if (/^(?:NEW|YEAR|MODEL|VER|VERSION|V)?20\d{2}$/u.test(token)) return null;
  return token;
}

export function explicitModelIdentityTokens(value) {
  const source = String(value || "").normalize("NFKC").toLocaleUpperCase("und");
  const result = new Set();
  for (const match of source.matchAll(/(?:^|[^A-Z0-9])([A-Z0-9][A-Z0-9_-]{1,31})(?=$|[^A-Z0-9])/gu)) {
    const token = canonicalExplicitModelToken(match[1]);
    if (token) result.add(token);
  }
  return [...result];
}

function compatibleExplicitModelIdentity(left, right) {
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return longer.startsWith(shorter)
    && longer.length - shorter.length <= 1
    && /[A-Z]$/u.test(longer);
}

/**
 * A missing model or a multi-model compatibility title remains soft. Two
 * corroborating rows that each explicitly name one incompatible model cannot
 * prove one same item, even when their category and images are similar.
 */
export function corroboratedSupportingModelConflict(rows = []) {
  const explicit = (Array.isArray(rows) ? rows : []).map((row) => ({
    offerId: String(row?.offer_id || row?.offerId || "").trim(),
    models: explicitModelIdentityTokens(row?.title),
  }));
  for (let leftIndex = 0; leftIndex < explicit.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < explicit.length; rightIndex += 1) {
      const left = explicit[leftIndex];
      const right = explicit[rightIndex];
      if (left.models.length !== 1 || right.models.length !== 1) continue;
      if (compatibleExplicitModelIdentity(left.models[0], right.models[0])) continue;
      return {
        conflict: true,
        reason: `explicit_supporting_model_conflict:${left.models[0]}!=${right.models[0]}`,
        offer_ids: [left.offerId, right.offerId].filter(Boolean),
        models: [left.models[0], right.models[0]],
      };
    }
  }
  return { conflict: false, reason: null, offer_ids: [], models: [] };
}

export function explicitLeadingBrandToken(value) {
  const source = String(value || "").normalize("NFKC").trim();
  const labeled = source.match(/(?:^|[^\p{L}\p{N}])(?:brand|бренд|品牌)\s*[:：-]?\s*([A-Za-z][A-Za-z'-]{2,23})(?=$|[^A-Za-z])/iu)?.[1];
  const leading = source.match(/^([A-Za-z][A-Za-z'-]{2,23})\s+(?=[\p{Script=Cyrillic}\u3400-\u9fff])/u)?.[1];
  const token = String(labeled || leading || "").toLocaleLowerCase("und");
  if (!token || new Set([
    "authentic", "automotive", "bluetooth", "diagnostic", "original", "scanner",
    "smart", "universal", "wireless",
  ]).has(token)) return null;
  return token;
}

// A supplier may legitimately omit incidental wording, but it cannot prove
// the same item by image/platform compatibility alone when the target title
// explicitly declares a brand together with that brand's product model.  Keep
// this detector deliberately structural: it recognizes a brand immediately
// bound to an alphanumeric model (HiFlo HFA3612), or a brand immediately
// followed by a compatibility preposition plus a separately named product
// family (DOBE for PS4 ... DualShock PS4). Ordinary generic titles do not
// enter this fail-closed lane.
const DECLARED_IDENTITY_GENERIC_WORDS = new Set([
  "adapter", "air", "automotive", "bluetooth", "cable", "case", "charger",
  "amd", "cartridge", "charging", "celeron", "compatible", "controller", "core", "cover", "digital", "dock", "dualsense", "dualshock", "element", "filter", "for", "galaxy", "gamepad",
  "gaming", "generic", "headset", "identical", "intel", "lamp", "light", "model",
  "models", "monster", "motorcycle", "new", "original", "phone", "piece",
  "insert", "joycon", "nova", "part", "pixma", "product", "protective", "regular", "ryzen", "scanner", "set", "single", "smart", "stand", "station", "toy", "truck", "trucks",
  "universal", "vehicle", "vehicles", "wheels", "wireless",
]);

const DECLARED_IDENTITY_KNOWN_BRANDS = new Set(["dobe", "hiflo"]);

const COMPATIBILITY_PLATFORM_BRANDS = new Set([
  "apple", "bmw", "ford", "honda", "huawei", "kawasaki", "microsoft", "nintendo",
  "samsung", "sony", "suzuki", "toyota", "vivo", "xiaomi", "yamaha",
]);

function pairNamesCompatibilityPlatform(source, brand) {
  if (!COMPATIBILITY_PLATFORM_BRANDS.has(brand)) return false;
  return /(?:air\s+filter|filter|cover|case|protector|holder|mount|stand|charger|charging\s+(?:dock|station)|cable|adapter|replacement|accessor(?:y|ies)|адаптер\p{L}*|зарядн\p{L}*\s+устройств\p{L}*|滤芯|空滤|保护(?:壳|套)|手机壳|支架|充电(?:器|座)|转接(?:器|头)|适配器)/iu.test(source);
}

function normalizedDeclaredIdentityWord(value, { allowGeneric = false, requireBrandCase = false } = {}) {
  const raw = String(value || "").normalize("NFKC").replace(/[^A-Za-z'-]/gu, "");
  const token = raw.toLocaleLowerCase("und")
    .replace(/[^a-z0-9'-]/gu, "");
  if (token.length < 3 || token.length > 24
    || (!allowGeneric && DECLARED_IDENTITY_GENERIC_WORDS.has(token))) return null;
  if (requireBrandCase && !DECLARED_IDENTITY_KNOWN_BRANDS.has(token)) {
    const letters = raw.replace(/[^A-Za-z]/gu, "");
    const credibleCase = /^[A-Z]{2,24}$/u.test(letters)
      || /^[A-Z][a-z]{2,23}$/u.test(letters)
      || /^[A-Z][a-z]+(?:[A-Z][A-Za-z]*)+$/u.test(letters);
    if (!credibleCase) return null;
  }
  return token;
}

function declaredBrandModelPair(value) {
  const source = String(value || "").normalize("NFKC");
  for (const match of source.matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z'-]{2,23})\s+([A-Za-z][A-Za-z0-9_-]{1,31}\d[A-Za-z0-9_-]*)(?=$|[^A-Za-z0-9])/gu)) {
    const pairOffset = Number(match.index) + String(match[0]).indexOf(match[1]);
    const clauseStart = Math.max(
      source.lastIndexOf("/", pairOffset - 1),
      source.lastIndexOf(",", pairOffset - 1),
      source.lastIndexOf(";", pairOffset - 1),
      source.lastIndexOf("|", pairOffset - 1),
      source.lastIndexOf("(", pairOffset - 1),
    );
    const prefix = source.slice(clauseStart + 1, pairOffset);
    if (/(?:^|[^A-Za-zА-Яа-яЁё])(?:for|для|compatible(?:\s+with)?|fits?|suitable\s+for|подходит\s+для)(?=$|[^A-Za-zА-Яа-яЁё])/iu.test(prefix)
      || /(?:适用于?|兼容|适配)/u.test(prefix)
      || /(?:^|[^A-Za-z])(?:generic|universal|compatible|replacement)\s*$/iu.test(prefix)) continue;
    const brand = normalizedDeclaredIdentityWord(match[1], { requireBrandCase: true });
    const model = canonicalExplicitModelToken(match[2]);
    if (brand && model && !pairNamesCompatibilityPlatform(source, brand)) return { brand, model };
  }
  return null;
}

function declaredBrandBeforeCompatibility(value) {
  const source = String(value || "").normalize("NFKC");
  for (const match of source.matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z'-]{2,23})\s+(?:for|для)\s+(?=[A-Za-z0-9])/giu)) {
    const brand = normalizedDeclaredIdentityWord(match[1], { requireBrandCase: true });
    if (brand) return brand;
  }
  return null;
}

function declaredNamedModelFamily(value, brand) {
  const source = String(value || "").normalize("NFKC");
  for (const match of source.matchAll(/(?:^|[^A-Za-z0-9])(dual[\s-]*shock|dualsense|joy[\s-]*con)\s+((?:PS|P)\s*[345]|XBOX(?:\s+ONE)?|SWITCH)(?=$|[^A-Za-z0-9])/giu)) {
    const family = normalizedDeclaredIdentityWord(
      String(match[1] || "").replace(/[\s-]+/gu, ""),
      { allowGeneric: true },
    );
    const rawPlatform = String(match[2] || "").toLocaleUpperCase("und").replace(/[\s_-]+/gu, "");
    const platform = /^P[345]$/u.test(rawPlatform) ? `PS${rawPlatform.slice(1)}` : rawPlatform;
    if (family && family !== brand && platform) return { family, platform };
  }
  return null;
}

function declaredTargetIdentity(expectedRequest = {}) {
  const title = String(expectedRequest?.expect_title || "");
  // A product's adjacent Brand + Model pair is primary identity. Never let a
  // compatibility model supplied by another parser (for example SV650) replace
  // the declared product model (HFA3612).
  const pair = declaredBrandModelPair(title);
  if (pair) {
    return {
      kind: "brand_model_pair",
      brand: pair.brand,
      models: [pair.model],
      named_family: null,
    };
  }
  const compatibilityBrand = declaredBrandBeforeCompatibility(title);
  if (compatibilityBrand) {
    const familyBinding = declaredNamedModelFamily(title, compatibilityBrand);
    if (familyBinding) {
      return {
        kind: "brand_family",
        brand: compatibilityBrand,
        models: [],
        named_family: familyBinding.family,
        named_platform: familyBinding.platform,
      };
    }
  }
  return null;
}

function returnedBrandFamilyBinding(value, brand, family, platform) {
  const source = String(value || "").normalize("NFKC");
  const escapedBrand = String(brand || "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const brandPattern = new RegExp(`(?:^|[^A-Za-z0-9])${escapedBrand}(?![A-Za-z0-9])`, "giu");
  let brandBound = false;
  for (const match of source.matchAll(brandPattern)) {
    const brandOffset = Number(match.index) + String(match[0]).toLocaleLowerCase("und").lastIndexOf(brand);
    const clauseStart = Math.max(
      source.lastIndexOf("/", brandOffset - 1),
      source.lastIndexOf(",", brandOffset - 1),
      source.lastIndexOf(";", brandOffset - 1),
      source.lastIndexOf("|", brandOffset - 1),
      source.lastIndexOf("(", brandOffset - 1),
    );
    const prefix = source.slice(clauseStart + 1, brandOffset);
    if (/(?:^|[^A-Za-zА-Яа-яЁё])(?:compatible(?:\s+with)?|replacement|suitable\s+for|fits?|for|для|подходит\s+для)(?=$|[^A-Za-zА-Яа-яЁё])/iu.test(prefix)
      || /(?:适用于?|兼容|适配|替换)/u.test(prefix)) continue;
    brandBound = true;
    const afterBrand = source.slice(brandOffset + brand.length);
    const familyPattern = family === "dualshock" ? /(?:^|[^A-Za-z0-9])(dual[\s-]*shock)\s+((?:PS|P)\s*[345]|XBOX(?:\s+ONE)?|SWITCH)(?=$|[^A-Za-z0-9])/giu
      : family === "dualsense" ? /(?:^|[^A-Za-z0-9])(dualsense)\s+((?:PS|P)\s*[345]|XBOX(?:\s+ONE)?|SWITCH)(?=$|[^A-Za-z0-9])/giu
        : family === "joycon" ? /(?:^|[^A-Za-z0-9])(joy[\s-]*con)\s+((?:PS|P)\s*[345]|XBOX(?:\s+ONE)?|SWITCH)(?=$|[^A-Za-z0-9])/giu
          : null;
    if (!familyPattern) continue;
    for (const familyMatch of afterBrand.matchAll(familyPattern)) {
      const familyOffset = Number(familyMatch.index) + String(familyMatch[0]).indexOf(familyMatch[1]);
      const beforeFamily = afterBrand.slice(0, familyOffset);
      const allowedForPlatform = /^PS[345]$/u.test(platform)
        ? new RegExp(`(?:^|[^A-Za-z0-9])for\\s+(?:PS|P)\\s*${platform.slice(2)}(?=$|[^A-Za-z0-9])`, "giu")
        : null;
      const compatibilityScope = allowedForPlatform
        ? beforeFamily.replace(allowedForPlatform, " ")
        : beforeFamily;
      if (/(?:^|[^A-Za-zА-Яа-яЁё])(?:compatible(?:\s+with)?|replacement|suitable\s+for|fits?|for|для|подходит\s+для)(?=$|[^A-Za-zА-Яа-яЁё])/iu.test(compatibilityScope)
        || /(?:适用于?|兼容|适配|替换)/u.test(compatibilityScope)) continue;
      const rawPlatform = String(familyMatch[2] || "").toLocaleUpperCase("und").replace(/[\s_-]+/gu, "");
      const returnedPlatform = /^P[345]$/u.test(rawPlatform) ? `PS${rawPlatform.slice(1)}` : rawPlatform;
      if (returnedPlatform === platform) return { brand: true, family: true };
    }
  }
  return { brand: brandBound, family: false };
}

/**
 * Return only proven missing bindings for an explicitly declared brand/model
 * pair. With no such pair, or with a genuinely generic target, this remains
 * soft and returns no conflicts. Image scores are intentionally irrelevant.
 */
export function declaredTargetIdentityBindingConflicts(expectedRequest = {}, returnedTitle = "") {
  const identity = declaredTargetIdentity(expectedRequest);
  if (!identity) return [];
  const conflicts = [];
  if (identity.kind === "brand_model_pair") {
    const returnedPair = declaredBrandModelPair(returnedTitle);
    const brandBound = returnedPair?.brand === identity.brand;
    const modelBound = Boolean(returnedPair && identity.models.some((left) => (
      compatibleExplicitModelIdentity(left, returnedPair.model)
    )));
    if (!brandBound) conflicts.push(`declared_brand_missing:${identity.brand}`);
    if (!modelBound) conflicts.push(`declared_model_missing:${identity.models.join("|")}`);
  } else if (identity.kind === "brand_family") {
    const binding = returnedBrandFamilyBinding(
      returnedTitle,
      identity.brand,
      identity.named_family,
      identity.named_platform,
    );
    if (!binding.brand) conflicts.push(`declared_brand_missing:${identity.brand}`);
    if (!binding.family) conflicts.push(`declared_model_missing:${identity.named_family}`);
  }
  return conflicts;
}

const EXPLICIT_BRAND_PATTERNS = Object.freeze([
  ["apple", /(?:^|[^\p{L}\p{N}])(?:apple|iphone|ipad|airpods)(?=$|[^\p{L}\p{N}])|苹果/iu],
  ["samsung", /(?:^|[^\p{L}\p{N}])(?:samsung|galaxy)(?=$|[^\p{L}\p{N}])|三星/iu],
  ["xiaomi", /(?:^|[^\p{L}\p{N}])(?:xiaomi|redmi|poco)(?=$|[^\p{L}\p{N}])|小米|红米/iu],
  ["huawei", /(?:^|[^\p{L}\p{N}])huawei(?=$|[^\p{L}\p{N}])|华为/iu],
  ["honor", /(?:^|[^\p{L}\p{N}])honor(?=$|[^\p{L}\p{N}])|荣耀/iu],
  ["oppo", /(?:^|[^\p{L}\p{N}])oppo(?=$|[^\p{L}\p{N}])|欧珀/iu],
  ["vivo", /(?:^|[^\p{L}\p{N}])(?:vivo|iqoo)(?=$|[^\p{L}\p{N}])|维沃/iu],
  ["realme", /(?:^|[^\p{L}\p{N}])realme(?=$|[^\p{L}\p{N}])|真我/iu],
  ["oneplus", /(?:^|[^\p{L}\p{N}])oneplus(?=$|[^\p{L}\p{N}])|一加/iu],
  ["sony", /(?:^|[^\p{L}\p{N}])(?:sony|playstation)(?=$|[^\p{L}\p{N}])|索尼/iu],
  ["microsoft", /(?:^|[^\p{L}\p{N}])(?:microsoft|xbox|surface)(?=$|[^\p{L}\p{N}])|微软/iu],
  ["nintendo", /(?:^|[^\p{L}\p{N}])nintendo(?=$|[^\p{L}\p{N}])|任天堂/iu],
  ["google", /(?:^|[^\p{L}\p{N}])(?:google|pixel)(?=$|[^\p{L}\p{N}])|谷歌/iu],
  ["garmin", /(?:^|[^\p{L}\p{N}])garmin(?=$|[^\p{L}\p{N}])|佳明/iu],
  ["dji", /(?:^|[^\p{L}\p{N}])dji(?=$|[^\p{L}\p{N}])|大疆/iu],
]);

function explicitBrandFamilies(value) {
  const source = String(value || "");
  const result = new Set(EXPLICIT_BRAND_PATTERNS.flatMap(([name, pattern]) => pattern.test(source) ? [name] : []));
  const leading = explicitLeadingBrandToken(source);
  if (leading) result.add(leading);
  return result;
}

function detectedInterfaces(value) {
  const source = String(value || "").normalize("NFKC");
  return new Set([
    ["type-c", /(?:^|[^a-z0-9])(?:type[\s_-]*c|usb[\s_-]*c)(?=$|[^a-z0-9])|类型\s*c/iu],
    ["micro-usb", /(?:^|[^a-z0-9])micro[\s_-]*usb(?=$|[^a-z0-9])/iu],
    ["lightning", /(?:^|[^a-z0-9])lightning(?=$|[^a-z0-9])|苹果接口/iu],
    ["usb-a", /(?:^|[^a-z0-9])usb[\s_-]*a(?=$|[^a-z0-9])/iu],
    ["mini-hdmi", /(?:^|[^a-z0-9])mini[\s_-]*hdmi(?=$|[^a-z0-9])|c型\s*mini/iu],
    ["micro-hdmi", /(?:^|[^a-z0-9])micro[\s_-]*hdmi(?=$|[^a-z0-9])|d型\s*micro/iu],
    ["displayport", /(?:^|[^a-z0-9])(?:display[\s_-]*port|displayport|dp)(?=$|[^a-z0-9])/iu],
    ["rj45", /(?:^|[^a-z0-9])rj[\s_-]*45(?=$|[^a-z0-9])/iu],
  ].flatMap(([name, pattern]) => pattern.test(source) ? [name] : []));
}

function detectedSetQuantities(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  const result = new Set();
  for (const pattern of [
    /(?:套装|件数|pack(?:age)?|set|комплект|количество)\s*[:：]?\s*(\d+(?:\.\d+)?)/giu,
    /(\d+(?:\.\d+)?)\s*(?:件|个|只|pcs?|pack|шт(?:ук)?)\s*(?:套|装|pack|set)?/giu,
  ]) {
    for (const match of source.matchAll(pattern)) result.add(String(Number(match[1])));
  }
  return result;
}

function signedImageIdentityConflicts(expectedRequest, returnedTitle, row = {}) {
  const expected = normalize1688MatchRequest(expectedRequest);
  const expectedText = `${expected.expect_title} ${expected.expect_model}`;
  const returned = String(returnedTitle || "");
  const conflicts = Array.isArray(row?.identity_conflicts)
    ? row.identity_conflicts.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const expectedModels = explicitModelIdentityTokens(expectedText);
  const returnedModels = explicitModelIdentityTokens(returned);
  if (expectedModels.length && returnedModels.length && !expectedModels.some((left) => (
    returnedModels.some((right) => compatibleExplicitModelIdentity(left, right))
  ))) conflicts.push(`explicit_model_conflict:${expectedModels.join("|")}!=${returnedModels.join("|")}`);
  const expectedBrands = explicitBrandFamilies(expectedText);
  const returnedBrands = explicitBrandFamilies(returned);
  if (expectedBrands.size && returnedBrands.size
    && ![...expectedBrands].some((brand) => returnedBrands.has(brand))) {
    conflicts.push(`explicit_brand_conflict:${[...expectedBrands].join("|")}!=${[...returnedBrands].join("|")}`);
  }
  if (hasExplicitColorConflict(expectedText, returned)) conflicts.push("explicit_color_conflict");
  const expectedInterfaces = detectedInterfaces(expectedText);
  const returnedInterfaces = detectedInterfaces(returned);
  if (expectedInterfaces.size && returnedInterfaces.size
    && ![...expectedInterfaces].some((value) => returnedInterfaces.has(value))) {
    conflicts.push(`explicit_interface_conflict:${[...expectedInterfaces].join("|")}!=${[...returnedInterfaces].join("|")}`);
  }
  const expectedSets = detectedSetQuantities(expectedText);
  const returnedSets = detectedSetQuantities(returned);
  if (expectedSets.size && returnedSets.size
    && ![...expectedSets].some((value) => returnedSets.has(value))) {
    conflicts.push(`explicit_bundle_conflict:${[...expectedSets].join("|")}!=${[...returnedSets].join("|")}`);
  }
  if (hasMainProductAccessoryConflict(expectedText, returned)) conflicts.push("explicit_product_role_conflict");
  return [...new Set(conflicts)];
}

function highValueDigitalImageOnlyTarget(expectedRequest) {
  const expected = normalize1688MatchRequest(expectedRequest);
  if (!(Number(expected.expect_price_cny) >= VALUABLE_DIGITAL_IMAGE_ONLY_PRICE_CNY)) return false;
  const source = expected.expect_title;
  if (ACCESSORY_PRODUCT_RE.test(source)) return false;
  return /(?:\b(?:smart\s*)?phones?\b|\btablets?\b|\blaptops?\b|\bcomputers?\b|\bmonitors?\b|\bcameras?\b|\bdrones?\b|\b(?:smart\s*)?watches?\b|\bearbuds?\b|智能手机|手机|平板电脑|笔记本电脑|显示器|数码相机|无人机|智能手表|耳机|смартфон|планшет|ноутбук|монитор|фотоаппарат|дрон|смарт[ -]?часы|наушник)/iu.test(source);
}

function hasImageTextSoftShape(row, expectedRequest) {
  const image = row?.image;
  const title = String(row?.title || "").trim();
  return String(row?.semantic_strength || "") === "image_backed"
    && title
    && image?.available === true
    && Number(image.score) >= IMAGE_TEXT_SOFT_SCORE
    && Number(image.color_score) >= IMAGE_TEXT_SOFT_COLOR_SCORE
    && Number(image.dhash_score) >= IMAGE_TEXT_SOFT_DHASH_SCORE
    && Array.isArray(row?.spec_conflicts)
    && row.spec_conflicts.length === 0
    && row?.accessory_conflict === false
    && !highValueDigitalImageOnlyTarget(expectedRequest)
    && signedImageIdentityConflicts(expectedRequest, title, row).length === 0;
}

function hasStaleSemanticPolicyRefreshShape(row, expectedRequest) {
  const image = row?.image;
  const title = String(row?.title || "").trim();
  return Array.isArray(row?.semantic_hits_v3?.product)
    && row.semantic_hits_v3.product.length === 0
    && title
    && image?.available === true
    && Number(image.score) >= 0.68
    && Number(image.color_score) >= 0.90
    && Number(image.dhash_score) >= 0.55
    && Array.isArray(row?.spec_conflicts)
    && row.spec_conflicts.length === 0
    && row?.accessory_conflict === false
    && !highValueDigitalImageOnlyTarget(expectedRequest)
    && signedImageIdentityConflicts(expectedRequest, title, row).length === 0;
}

function isSignedImageTextSoftRow(row, expectedRequest) {
  return Object.hasOwn(row || {}, "identity_conflicts")
    && Array.isArray(row.identity_conflicts)
    && row.identity_conflicts.length === 0
    && hasImageTextSoftShape(row, expectedRequest);
}

/**
 * Identifies only the narrow legacy-v3 gap addressed by the image/text-soft
 * policy. By default the missing identity_conflicts field remains required.
 * A caller with an explicit stale producer version may also admit a signed,
 * explicitly empty list solely to trigger a fresh search. Neither shape is
 * acceptance evidence.
 */
export function isLegacySignedImageTextSoftRefreshCandidate(row, expectedRequest = {}, {
  allowExplicitEmptyIdentityConflicts = false,
} = {}) {
  const rank = Number(row?.rank);
  const offerId = String(row?.offer_id || "").trim();
  const hasIdentityConflicts = Object.hasOwn(row || {}, "identity_conflicts");
  const allowedIdentityShape = !hasIdentityConflicts
    || (allowExplicitEmptyIdentityConflicts === true
      && Array.isArray(row.identity_conflicts)
      && row.identity_conflicts.length === 0);
  const refreshShape = hasImageTextSoftShape(row, expectedRequest)
    || (allowExplicitEmptyIdentityConflicts === true
      && hasStaleSemanticPolicyRefreshShape(row, expectedRequest));
  if (!allowedIdentityShape
    || !Number.isInteger(rank)
    || rank < 1
    || rank > 3
    || !/^\d+$/u.test(offerId)
    || !refreshShape) return false;
  try {
    const imageUrl = new URL(String(row?.image_url || ""));
    return imageUrl.protocol === "https:" && Boolean(imageUrl.hostname);
  } catch {
    return false;
  }
}

function detectedColors(value) {
  const source = String(value || "");
  return new Set(COLOR_PATTERNS.flatMap(([name, pattern]) => pattern.test(source) ? [name] : []));
}

function hasExplicitColorConflict(expectedTitle, returnedTitle) {
  const expected = detectedColors(expectedTitle);
  const returned = detectedColors(returnedTitle);
  return expected.size > 0
    && returned.size > 0
    && ![...expected].some((color) => returned.has(color));
}

function hasMainProductAccessoryConflict(expectedTitle, returnedTitle) {
  const expected = String(expectedTitle || "");
  const returned = String(returnedTitle || "");
  const expectedStylusRole = stylusProductAccessoryRole(expected);
  const returnedStylusRole = stylusProductAccessoryRole(returned);
  if (expectedStylusRole && returnedStylusRole && expectedStylusRole !== returnedStylusRole) return true;
  if (PRINTER_PRODUCT_RE.test(expected) && CONSUMABLE_PRODUCT_RE.test(returned)) return true;
  const role = (value) => {
    if (ACCESSORY_PRODUCT_RE.test(value)) return "accessory";
    return MAIN_PRODUCT_PATTERNS.some((pattern) => pattern.test(value)) ? "core" : null;
  };
  const expectedRole = role(expected);
  const returnedRole = role(returned);
  return Boolean(expectedRole && returnedRole && expectedRole !== returnedRole);
}

function signedV3HitList(row, name) {
  const hits = row?.semantic_hits_v3?.[name];
  return Array.isArray(hits)
    ? hits.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
}

function hasOutdoorFrostproofFaucetRole(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  const faucetSubject = /(?:(?<![a-z])(?:faucet|spigot|water[\s_-]+tap|garden[\s_-]+tap)(?![a-z])|(?<![\p{Script=Cyrillic}])(?:водопроводн\p{L}*[\s_-]+)?кран\p{L}*(?![\p{Script=Cyrillic}])|水龙头|水嘴)/iu.test(source);
  const outdoorOrFrostproof = /(?:(?<![a-z])(?:outdoor|exterior|garden|yard|frost[\s_-]*(?:free|proof)|freezeless)(?![a-z])|(?<![\p{Script=Cyrillic}])(?:наружн|уличн|садов|двор|морозостойк|незамерзающ)\p{L}*(?![\p{Script=Cyrillic}])|户外|室外|庭院|花园|防冻|防冻结|防寒)/iu.test(source);
  return faucetSubject && outdoorOrFrostproof;
}

function hasExplicitFaucetAccessoryRole(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  if (!hasOutdoorFrostproofFaucetRole(source)) return false;
  return /(?:(?<![a-z])(?:faucet|tap|spigot)[\s_-]+(?:accessor|adapter|extender|aerator|cartridge)[a-z-]*(?![a-z])|(?<![\p{Script=Cyrillic}])(?:насадк|переходник|удлинител|аэратор|картридж)\p{L}*[\s_-]+(?:для[\s_-]+)?кран\p{L}*(?![\p{Script=Cyrillic}])|水龙头.{0,12}(?:配件|延长|加长|转接|接头|阀芯|起泡器|软管)|水嘴.{0,12}(?:配件|延长|加长|转接|接头|阀芯|起泡器|软管))/iu.test(source);
}

function hasExplicitPlumbingComponentRole(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und");
  return /(?:(?<![a-z])(?:valve|pipe[\s_-]+fitting|hose[\s_-]+fitting|pipe[\s_-]+connector|elbow[\s_-]+fitting|tee[\s_-]+fitting)(?![a-z])|(?<![\p{Script=Cyrillic}])(?:клапан|вентил|фитинг|муфт|штуцер|тройник|колен)\p{L}*(?![\p{Script=Cyrillic}])|阀门|止回阀|球阀|角阀|阀芯|管件|管道接头|水管接头|软管接头|弯头|三通)/iu.test(source);
}

function hasSignedOutdoorFrostproofFaucetRole(row, expectedRequest, returnedTitle) {
  return signedV3HitList(row, "product").includes(OUTDOOR_FROSTPROOF_FAUCET_ROLE)
    && hasOutdoorFrostproofFaucetRole([
      expectedRequest?.expect_title,
      expectedRequest?.expect_model,
      expectedRequest?.expect_category,
    ].filter(Boolean).join(" "))
    && hasOutdoorFrostproofFaucetRole(returnedTitle)
    && !hasExplicitFaucetAccessoryRole(returnedTitle)
    && !hasExplicitPlumbingComponentRole(returnedTitle);
}

function hasTrustedSignedExactModel(row, expectedRequest) {
  const expected = normalize1688MatchRequest(expectedRequest);
  const expectedText = `${expected.expect_model} ${expected.expect_title}`;
  const returnedTitle = String(row?.title || "").toLocaleLowerCase("und");
  return signedV3HitList(row, "model").some((hit) => {
    const normalizedHit = String(hit || "").normalize("NFKC").toLocaleLowerCase("und").trim();
    return Boolean(canonicalExplicitModelToken(normalizedHit))
      && expectedText.includes(normalizedHit)
      && returnedTitle.includes(normalizedHit);
  });
}

/**
 * Derives the original-plan strong_single lane from one already-signed v3
 * row.  It intentionally excludes generic keyword-only and image-only rows:
 * the row must bind an exact requested model, or bind both a distinctive
 * title term and the same product role.  Model-bearing consumables require
 * the exact-model branch.
 */
export function deriveSignedImagePrimaryStrongSingle(rows, expectedRequest = {}) {
  const expected = normalize1688MatchRequest(expectedRequest);
  const ranked = (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const rank = Number(row?.rank);
    const image = row?.image;
    const score = Number(image?.score);
    const colorScore = Number(image?.color_score);
    const dhashScore = Number(image?.dhash_score);
    const title = String(row?.title || "").trim();
    const offerId = String(row?.offer_id || "").trim();
    if (
      !Number.isInteger(rank)
      || rank < 1
      || rank > 3
      || !/^\d+$/u.test(offerId)
      || !title
      || image?.available !== true
      || !Number.isFinite(score)
      || !Number.isFinite(colorScore)
      || !Number.isFinite(dhashScore)
      || score < 0.68
      || colorScore < 0.90
      || dhashScore < 0.55
      || !Array.isArray(row?.spec_conflicts)
      || row.spec_conflicts.length > 0
      || row?.accessory_conflict !== false
      || hasExplicitColorConflict(expected.expect_title, title)
      || hasMainProductAccessoryConflict(expected.expect_title, title)
      || signedImageIdentityConflicts(expected, title, row).length > 0
    ) return [];
    try {
      const imageUrl = new URL(String(row?.image_url || ""));
      if (imageUrl.protocol !== "https:" || !imageUrl.hostname) return [];
    } catch {
      return [];
    }

    const semanticStrength = String(row?.semantic_strength || "");
    const modelHits = signedV3HitList(row, "model");
    const informationHits = signedV3HitList(row, "high_information");
    const productHits = signedV3HitList(row, "product");
    const exactModel = semanticStrength === "exact_model"
      && Boolean(expected.expect_model)
      && modelHits.length > 0
      && hasTrustedSignedExactModel(row, expected);
    const consumableRequiresModel = CONSUMABLE_PRODUCT_RE.test(expected.expect_title);
    const sameProductType = !consumableRequiresModel
      && productHits.length > 0
      && (
        (["two_high_information_terms", "one_high_information_plus_product"].includes(semanticStrength)
          && informationHits.length > 0
          && score >= 0.72
          && dhashScore >= 0.60)
        || (semanticStrength === "product_semantics"
          && score >= 0.82
          && colorScore >= 0.92
          && dhashScore >= 0.68)
      );
    const imageTextSoft = !consumableRequiresModel && isSignedImageTextSoftRow(row, expected);
    if (!exactModel && !sameProductType && !imageTextSoft) return [];
    return [{ row, rank, score, dhashScore }];
  });
  ranked.sort((left, right) => (
    right.score - left.score
    || right.dhashScore - left.dhashScore
    || left.rank - right.rank
  ));
  return ranked[0]?.row || null;
}

function equalNumericMultiset(left, right) {
  if (left.length !== right.length) return false;
  const sortedLeft = left.map(Number).sort((a, b) => a - b);
  const sortedRight = right.map(Number).sort((a, b) => a - b);
  return sortedLeft.every((value, index) => Number.isFinite(value)
    && Number.isFinite(sortedRight[index])
    && value === sortedRight[index]);
}

function sanitizedHttpUrl(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 4_096) return null;
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return null;
    return text;
  } catch {
    return null;
  }
}

function sanitizedUnitScore(value) {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= 1
    ? value
    : null;
}

function normalizedBoundedText(value, maximumLength) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  return text && text.length <= maximumLength ? text : null;
}

function sanitizedSemanticHitsV3(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowedKeys = new Set(["model", "high_information", "feature", "product"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
  const result = {};
  for (const key of allowedKeys) {
    if (!Object.hasOwn(value, key)) continue;
    const hits = value[key];
    if (!Array.isArray(hits) || hits.length > 32) return null;
    const normalized = hits.map((hit) => normalizedBoundedText(hit, 256));
    if (normalized.some((hit) => hit === null)) return null;
    result[key] = [...new Set(normalized)];
  }
  return result;
}

function sanitizedBalancedSupportingOfferEvidence(row, verifiedOfferIds) {
  const offerId = typeof row?.offer_id === "string" ? row.offer_id.trim() : "";
  const title = normalizedBoundedText(row?.title, 1_000);
  const supplierId = normalizedBoundedText(row?.supplier_id, 512);
  const imageUrl = sanitizedHttpUrl(row?.image_url);
  const image = row?.image && typeof row.image === "object" && !Array.isArray(row.image)
    ? row.image
    : null;
  const score = sanitizedUnitScore(image?.score);
  const colorScore = sanitizedUnitScore(image?.color_score);
  const dhashScore = sanitizedUnitScore(image?.dhash_score);
  const sanitizedImage = image?.available === true
    ? (score !== null && colorScore !== null && dhashScore !== null
        ? {
            available: true,
            score,
            color_score: colorScore,
            dhash_score: dhashScore,
          }
        : null)
    : (image?.available === false ? { available: false } : null);
  const semanticStrength = typeof row?.semantic_strength === "string"
    ? row.semantic_strength.trim()
    : "";
  const semanticHitsV3 = Object.hasOwn(row || {}, "semantic_hits_v3")
    ? sanitizedSemanticHitsV3(row.semantic_hits_v3)
    : undefined;
  const specConflicts = Array.isArray(row?.spec_conflicts)
    && row.spec_conflicts.every((value) => typeof value === "string" && value.trim())
    ? row.spec_conflicts.map((value) => value.trim())
    : null;
  const hasIdentityConflicts = Object.hasOwn(row || {}, "identity_conflicts");
  const identityConflicts = hasIdentityConflicts
    && Array.isArray(row.identity_conflicts)
    && row.identity_conflicts.every((value) => typeof value === "string" && value.trim())
    ? row.identity_conflicts.map((value) => value.trim())
    : (hasIdentityConflicts ? null : []);
  if (!offerId
    || !verifiedOfferIds.has(offerId)
    || !title
    || !supplierId
    || !imageUrl
    || !sanitizedImage
    || !semanticStrength
    || specConflicts === null
    || identityConflicts === null
    || typeof row?.accessory_conflict !== "boolean") {
    return null;
  }
  return {
    offer_id: offerId,
    title,
    supplier_id: supplierId,
    image_url: imageUrl,
    image: sanitizedImage,
    semantic_strength: semanticStrength,
    ...(semanticHitsV3 ? { semantic_hits_v3: semanticHitsV3 } : {}),
    spec_conflicts: specConflicts,
    identity_conflicts: identityConflicts,
    accessory_conflict: row.accessory_conflict,
  };
}

export function verifyReturnedSameItemEvidence({
  encodedEvidence,
  evidenceKey,
  expectedRequest,
  filteredPrices = [],
  costSource,
  selectedCost,
  selectedOfferId,
  minimumMatches = 3,
  requiredContract = null,
  requireBalancedMatch = false,
  allowLegacyV2 = true,
  allowSignedSelectedOfferDerivation = false,
} = {}) {
  const requiredMatches = Math.max(1, Number(minimumMatches) || 1);
  const encoded = String(encodedEvidence || "").trim();
  const key = String(evidenceKey || "").trim();
  if (!encoded) return { ok: false, reason: "missing returned same-item evidence" };
  if (!isValid1688MatchEvidenceKey(key)) return { ok: false, reason: "missing or invalid returned evidence key" };
  const digest = crypto.createHash("sha256").update(encoded, "utf8").digest("hex");
  if (digest !== key) return { ok: false, reason: "returned same-item evidence digest mismatch" };

  let evidence;
  try {
    evidence = JSON.parse(encoded);
  } catch {
    return { ok: false, reason: "malformed returned same-item evidence" };
  }
  const contract = String(evidence?.contract || "");
  const supported = contract === "1688-returned-same-item-v3"
    || (allowLegacyV2 && contract === "1688-returned-same-item-v2");
  if (!supported) {
    return { ok: false, reason: "unsupported returned same-item evidence contract" };
  }
  if (requiredContract && contract !== requiredContract) {
    return { ok: false, reason: `fresh submission requires ${requiredContract}` };
  }
  if (String(evidence?.cost_source || "") !== String(costSource || "")) {
    return { ok: false, reason: "returned evidence cost source mismatch" };
  }
  if (!Number.isFinite(Number(selectedCost)) || Number(evidence?.selected_cost) !== Number(selectedCost)) {
    return { ok: false, reason: "returned evidence selected cost mismatch" };
  }

  const request = normalize1688MatchRequest(evidence?.request);
  const expected = normalize1688MatchRequest(expectedRequest);
  if (!Object.values(expected).some(Boolean)) {
    return { ok: false, reason: "missing request semantics for same-item verification" };
  }
  if (JSON.stringify(request) !== JSON.stringify(expected)) {
    return { ok: false, reason: "returned same-item evidence request mismatch" };
  }

  const rows = Array.isArray(evidence?.rows) ? evidence.rows : [];
  if (rows.length < requiredMatches) {
    return { ok: false, reason: `returned semantic matches insufficient ${rows.length}` };
  }
  const offerIds = new Set();
  const evidencePrices = [];
  for (const row of rows) {
    const offerId = String(row?.offer_id || "").trim();
    const rawTitle = String(row?.title || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
    const title = rawTitle.toLocaleLowerCase("und");
    const price = Number(row?.price);
    if (!offerId || offerIds.has(offerId)) {
      return { ok: false, reason: "returned same-item evidence has missing or duplicate offer identity" };
    }
    if (!title || !Number.isFinite(price) || price <= 0) {
      return { ok: false, reason: "returned same-item evidence has invalid title or price" };
    }
    const declaredIdentityConflicts = declaredTargetIdentityBindingConflicts(expectedRequest, rawTitle);
    if (declaredIdentityConflicts.length) {
      return {
        ok: false,
        reason: `returned row does not bind declared target identity: ${declaredIdentityConflicts.join(", ")}`,
      };
    }
    const semanticHits = row?.semantic_hits && typeof row.semantic_hits === "object"
      ? row.semantic_hits
      : {};
    let explicitHitCount = 0;
    for (const kind of ["model", "title", "category"]) {
      const hits = Array.isArray(semanticHits[kind]) ? semanticHits[kind] : [];
      if (hits.length && !expected[`expect_${kind}`]) {
        return { ok: false, reason: `returned ${kind} hits lack matching request semantics` };
      }
      for (const hitValue of hits) {
        const hit = String(hitValue || "").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
        if (!hit || !title.includes(hit)) {
          return { ok: false, reason: "returned semantic hit is not present in returned title" };
        }
        if ((kind === "model" || kind === "title") && !expected[`expect_${kind}`].includes(hit)) {
          return { ok: false, reason: `returned ${kind} hit is not bound to request semantics` };
        }
        explicitHitCount += 1;
      }
    }
    const signedOutdoorFrostproofFaucet = contract === "1688-returned-same-item-v3"
      && hasSignedOutdoorFrostproofFaucetRole(row, expected, rawTitle);
    if (signedOutdoorFrostproofFaucet) explicitHitCount += 1;
    const signedImageTextSoft = contract === "1688-returned-same-item-v3"
      && isSignedImageTextSoftRow(row, expected);
    if (!explicitHitCount && !signedImageTextSoft) {
      return { ok: false, reason: "returned row has no explicit title/model/category semantic hit" };
    }
    if (expected.expect_model
      && !(Array.isArray(semanticHits.model) && semanticHits.model.length)
      && !signedImageTextSoft) {
      return { ok: false, reason: "returned row does not match the required model token" };
    }
    if (!expected.expect_model
      && !(Array.isArray(semanticHits.title) && semanticHits.title.length)
      && !signedOutdoorFrostproofFaucet
      && !signedImageTextSoft) {
      return { ok: false, reason: "returned row has only category evidence, not a strong title match" };
    }
    offerIds.add(offerId);
    evidencePrices.push(price);
  }
  const prices = Array.isArray(filteredPrices)
    ? filteredPrices.map(Number).filter(Number.isFinite)
    : [];
  if (!equalNumericMultiset(evidencePrices, prices)) {
    return { ok: false, reason: "returned evidence price set does not match filtered prices" };
  }
  const selectedCluster = Array.isArray(evidence?.selected_cluster) ? evidence.selected_cluster : [];
  if (selectedCluster.length < requiredMatches) {
    return { ok: false, reason: `selected returned cluster insufficient ${selectedCluster.length}` };
  }
  const selectedIds = new Set();
  for (const row of selectedCluster) {
    const offerId = String(row?.offer_id || "").trim();
    const price = Number(row?.price);
    if (!offerId || selectedIds.has(offerId) || !offerIds.has(offerId)) {
      return { ok: false, reason: "selected cluster identity is missing, duplicate, or outside filtered rows" };
    }
    const sourceRow = rows.find((candidate) => String(candidate?.offer_id || "").trim() === offerId);
    if (!Number.isFinite(price) || Number(sourceRow?.price) !== price) {
      return { ok: false, reason: "selected cluster price is not bound to its filtered offer" };
    }
    if (contract === "1688-returned-same-item-v3"
      && String(row?.supplier_id || "").trim() !== String(sourceRow?.supplier_id || "").trim()) {
      return { ok: false, reason: "selected cluster supplier is not bound to its filtered offer" };
    }
    selectedIds.add(offerId);
  }
  if (!selectedCluster.some((row) => Number(row?.price) === Number(selectedCost))) {
    return { ok: false, reason: "selected cost is not present in the selected returned cluster" };
  }
  let emittedSelectedOfferId = String(selectedOfferId || "").trim();
  let evidenceSelectedOfferId = String(evidence?.selected_offer_id || "").trim();
  let selectedOfferIdOrigin = null;
  if (allowSignedSelectedOfferDerivation === true
    && contract === "1688-returned-same-item-v3"
    && !emittedSelectedOfferId
    && !evidenceSelectedOfferId) {
    // Early v3 workers signed the complete selected cluster and exact cost but
    // did not emit the redundant selected_offer_id field. Replay may recover
    // an identity only when the signed cluster has exactly one row at the
    // signed selected cost; ambiguity remains fail-closed.
    const derived = selectedCluster.filter((row) => Number(row?.price) === Number(selectedCost));
    if (derived.length === 1) {
      emittedSelectedOfferId = String(derived[0]?.offer_id || "").trim();
      evidenceSelectedOfferId = emittedSelectedOfferId;
      selectedOfferIdOrigin = "signed-selected-cost-unique-row-v1";
    }
  }
  if (!emittedSelectedOfferId || !evidenceSelectedOfferId) {
    return { ok: false, reason: "missing exact selected 1688 offer identity" };
  }
  if (emittedSelectedOfferId !== evidenceSelectedOfferId) {
    return { ok: false, reason: "selected 1688 offer identity does not match signed evidence" };
  }
  if (!selectedIds.has(emittedSelectedOfferId)) {
    return { ok: false, reason: "selected 1688 offer identity is outside the selected cluster" };
  }
  const exactSelectedRow = selectedCluster.find((row) => String(row?.offer_id || "").trim() === emittedSelectedOfferId);
  if (Number(exactSelectedRow?.price) !== Number(selectedCost)) {
    return { ok: false, reason: "selected 1688 offer identity is not bound to the selected cost" };
  }
  const signedExactSelectedRow = rows.find((row) => String(row?.offer_id || "").trim() === emittedSelectedOfferId);
  const expectedStylusRole = stylusProductAccessoryRole(expectedRequest?.expect_title);
  const exactSelectedStylusRole = stylusProductAccessoryRole(signedExactSelectedRow?.title);
  if (expectedStylusRole && exactSelectedStylusRole && expectedStylusRole !== exactSelectedStylusRole) {
    return {
      ok: false,
      reason: `exact selected row has explicit stylus core/accessory conflict: ${expectedStylusRole}!=${exactSelectedStylusRole}`,
    };
  }
  let balancedMatch = null;
  let balancedMatchOrigin = null;
  let supportingIds = [];
  let supportingOfferEvidence;
  if (contract === "1688-returned-same-item-v3") {
    const semanticStrengths = new Set([
      "exact_model",
      "two_high_information_terms",
      "one_high_information_term",
      "one_high_information_plus_product",
      "product_semantics",
      "feature_only",
      "image_backed",
      "weak_or_none",
    ]);
    for (const row of rows) {
      const image = row?.image && typeof row.image === "object" ? row.image : null;
      if (!Number.isInteger(Number(row?.rank)) || Number(row.rank) < 1
        || typeof row?.supplier_id !== "string"
        || !image
        || !semanticStrengths.has(String(row?.semantic_strength || ""))
        || !Array.isArray(row?.spec_conflicts)
        || (Object.hasOwn(row || {}, "identity_conflicts")
          && (!Array.isArray(row.identity_conflicts)
            || row.identity_conflicts.some((value) => typeof value !== "string" || !value.trim())))
        || typeof row?.accessory_conflict !== "boolean") {
        return { ok: false, reason: "v3 row is missing rank, supplier, image, semantics or specification bindings" };
      }
      if (image.available === true && !/^https?:\/\//iu.test(String(row?.image_url || ""))) {
        return { ok: false, reason: "v3 image score is not bound to a returned image URL" };
      }
      if (image.available === true
        && (!Number.isFinite(Number(image.score)) || Number(image.score) < 0 || Number(image.score) > 1)) {
        return { ok: false, reason: "v3 row has an invalid image similarity score" };
      }
      if (image.available === true && (
        !Number.isFinite(Number(image.color_score))
        || Number(image.color_score) < 0
        || Number(image.color_score) > 1
        || !Number.isFinite(Number(image.dhash_score))
        || Number(image.dhash_score) < 0
        || Number(image.dhash_score) > 1
      )) {
        return { ok: false, reason: "v3 row has invalid image similarity components" };
      }
      if (String(row?.semantic_strength || "") === "image_backed"
        && !(image.available === true && Number(image.score) >= 0.86)) {
        return { ok: false, reason: "v3 image-backed semantics lack the required bound image score" };
      }
      if (String(row?.semantic_strength || "") === "exact_model"
        && !hasTrustedSignedExactModel(row, expected)) {
        return {
          ok: false,
          reason: "v3 exact-model semantics rely only on a protocol, rating, or unbound token",
        };
      }
    }
    balancedMatch = evidence?.balanced_match && typeof evidence.balanced_match === "object"
      ? evidence.balanced_match
      : null;
    if (!balancedMatch) return { ok: false, reason: "missing balanced v3 match decision" };
    if (balancedMatch.image_available !== rows.some((row) => row?.image?.available === true)) {
      return { ok: false, reason: "balanced image availability is not bound to returned rows" };
    }
    const matchType = String(balancedMatch?.match_type || "");
    if (!["strong_single", "corroborated_multi", "rejected"].includes(matchType)) {
      return { ok: false, reason: "invalid balanced v3 match type" };
    }
    supportingIds = Array.isArray(balancedMatch?.supporting_offer_ids)
      ? balancedMatch.supporting_offer_ids.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    if (new Set(supportingIds).size !== supportingIds.length
      || supportingIds.some((offerId) => !offerIds.has(offerId))) {
      return { ok: false, reason: "balanced support identities are invalid or outside returned rows" };
    }
    let supportingRows = supportingIds.map((offerId) => rows.find((row) => String(row?.offer_id || "").trim() === offerId));
    const cleanRow = (row) => Array.isArray(row?.spec_conflicts)
      && row.spec_conflicts.length === 0
      && row?.accessory_conflict === false;
    const imageScore = (row) => Number(row?.image?.score);
    const highImage = (row, threshold = 0.78) => row?.image?.available === true
      && Number.isFinite(imageScore(row))
      && imageScore(row) >= threshold;
    const corroboratedImage = (row) => row?.image?.available === true
      && Number(row.image.score) >= 0.60
      && Number(row.image.color_score) >= 0.82
      && Number(row.image.dhash_score) >= 0.46;
    if (balancedMatch?.passed === true && matchType === "strong_single") {
      const row = supportingRows[0];
      const semanticStrength = String(row?.semantic_strength || "");
      const requiredImageScore = semanticStrength === "exact_model" ? 0.68 : 0.78;
      const semanticOk = ["exact_model", "two_high_information_terms"].includes(semanticStrength)
        || (semanticStrength === "one_high_information_term" && imageScore(row) >= 0.90)
        || isSignedImageTextSoftRow(row, expected);
      if (supportingRows.length !== 1
        || !Number.isInteger(Number(row?.rank))
        || Number(row.rank) < 1
        || Number(row.rank) > 3
        || !selectedIds.has(String(row?.offer_id || "").trim())
        || !highImage(row, requiredImageScore)
        || !cleanRow(row)
        || !semanticOk) {
        return { ok: false, reason: "strong-single v3 evidence does not satisfy rank, image, semantics and specifications" };
      }
    } else if (balancedMatch?.passed === true && matchType === "corroborated_multi") {
      const suppliers = supportingRows.map((row) => String(row?.supplier_id || "").trim());
      if (supportingRows.length < 2
        || supportingIds.some((offerId) => !selectedIds.has(offerId))
        || suppliers.some((value) => !value)
        || new Set(suppliers).size !== suppliers.length
        || supportingRows.some((row) => !cleanRow(row))
        || supportingRows.some((row) => ![
          "exact_model",
          "two_high_information_terms",
          "one_high_information_term",
          "one_high_information_plus_product",
          "product_semantics",
          "image_backed",
        ].includes(String(row?.semantic_strength || "")))
      ) {
        return { ok: false, reason: "multi-source v3 evidence lacks independent suppliers, semantics, image or specification agreement" };
      }
      if (!supportingRows.some(corroboratedImage)) {
        // Older workers could sign a valid corroborated decision while putting
        // the high-image row later in `rows` instead of in supporting IDs.  The
        // complete row set is covered by the same digest, so rebind only the
        // effective supports; never invent or fetch a replacement row.
        const acceptableSemantics = new Set([
          "exact_model",
          "two_high_information_terms",
          "one_high_information_term",
          "one_high_information_plus_product",
          "product_semantics",
          "image_backed",
        ]);
        const credibleRows = rows.filter((row) => (
          cleanRow(row)
          && selectedIds.has(String(row?.offer_id || "").trim())
          && String(row?.supplier_id || "").trim()
          && acceptableSemantics.has(String(row?.semantic_strength || ""))
        ));
        const highRow = credibleRows
          .filter(corroboratedImage)
          .sort((left, right) => imageScore(right) - imageScore(left))[0];
        const companion = highRow && credibleRows.find((row) => (
          String(row?.offer_id || "").trim() !== String(highRow?.offer_id || "").trim()
          && String(row?.supplier_id || "").trim() !== String(highRow?.supplier_id || "").trim()
        ));
        if (!highRow || !companion) {
          return { ok: false, reason: "multi-source v3 evidence lacks independent suppliers, semantics, image or specification agreement" };
        }
        supportingRows = [highRow, companion];
        supportingIds = supportingRows.map((row) => String(row.offer_id).trim());
        balancedMatch = {
          ...balancedMatch,
          supporting_offer_ids: [...supportingIds],
          reason: "signed corroborated support rows rebound to the available high-image supplier",
        };
        balancedMatchOrigin = SIGNED_CORROBORATED_SUPPORT_REBIND_POLICY;
      }
    } else if (balancedMatch?.passed !== false || matchType !== "rejected" || supportingIds.length) {
      return { ok: false, reason: "rejected v3 evidence has inconsistent decision fields" };
    }
    if (balancedMatch?.passed === true && matchType === "corroborated_multi") {
      const modelConflict = corroboratedSupportingModelConflict(supportingRows);
      if (modelConflict.conflict) {
        return {
          ok: false,
          reason: `multi-source v3 evidence has ${modelConflict.reason}`,
        };
      }
    }
    if (balancedMatch?.passed === false) {
      const derivedStrongSingle = deriveSignedImagePrimaryStrongSingle(
        rows.filter((row) => selectedIds.has(String(row?.offer_id || "").trim())),
        expected,
      );
      if (derivedStrongSingle) {
        supportingRows = [derivedStrongSingle];
        supportingIds = [String(derivedStrongSingle.offer_id).trim()];
        balancedMatch = {
          ...balancedMatch,
          passed: true,
          match_type: "strong_single",
          reason: "one signed top-three offer passed the image-primary strong-single policy",
          supporting_offer_ids: [...supportingIds],
        };
        balancedMatchOrigin = SIGNED_IMAGE_PRIMARY_STRONG_SINGLE_POLICY;
      }
    }
    if (requireBalancedMatch && balancedMatch.passed !== true) {
      return { ok: false, reason: `balanced match rejected: ${String(balancedMatch.reason || "unknown")}` };
    }
    if (balancedMatch.passed === true && expectedStylusRole) {
      for (const row of supportingRows) {
        const supportingRole = stylusProductAccessoryRole(row?.title);
        if (supportingRole && supportingRole !== expectedStylusRole) {
          return {
            ok: false,
            reason: `balanced supporting row has explicit stylus core/accessory conflict: ${expectedStylusRole}!=${supportingRole}`,
          };
        }
      }
    }
    if (balancedMatch.passed === true) {
      const sanitized = supportingRows
        .map((row) => sanitizedBalancedSupportingOfferEvidence(row, offerIds))
        .filter(Boolean);
      if (sanitized.length) supportingOfferEvidence = sanitized;
    } else {
      supportingOfferEvidence = [];
    }
  } else if (requireBalancedMatch) {
    return { ok: false, reason: "balanced matching requires v3 evidence" };
  }
  return {
    ok: true,
    contract: evidence.contract,
    key,
    offer_ids: [...offerIds],
    selected_offer_id: emittedSelectedOfferId,
    ...(selectedOfferIdOrigin ? { selected_offer_id_origin: selectedOfferIdOrigin } : {}),
    selected_offer_ids: [emittedSelectedOfferId],
    selected_cluster_offer_ids: [...selectedIds],
    selected_cluster_prices: selectedCluster.map((row) => Number(row.price)),
    matched_offer_count: rows.length,
    balanced_match: balancedMatch?.passed === true,
    balanced_match_type: balancedMatch?.match_type || null,
    balanced_match_reason: balancedMatch?.reason || null,
    ...(balancedMatchOrigin ? { balanced_match_origin: balancedMatchOrigin } : {}),
    balanced_supporting_offer_ids: balancedMatch?.passed === true
      ? [...supportingIds]
      : [],
    ...(Array.isArray(supportingOfferEvidence) ? {
      balanced_supporting_offer_evidence: supportingOfferEvidence,
    } : {}),
    image_check_available: balancedMatch?.image_available === true,
  };
}

function hasBoundSignedStrongSingle(cost = {}) {
  const ids = Array.isArray(cost?.balanced_supporting_offer_ids)
    ? cost.balanced_supporting_offer_ids.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const rows = Array.isArray(cost?.balanced_supporting_offer_evidence)
    ? cost.balanced_supporting_offer_evidence
    : [];
  return cost?.balanced_match === true
    && cost?.balanced_match_type === "strong_single"
    && ids.length === 1
    && rows.length === 1
    && String(rows[0]?.offer_id || "").trim() === ids[0];
}

function hasBoundSignedCorroboratedPair(cost = {}) {
  const ids = Array.isArray(cost?.balanced_supporting_offer_ids)
    ? cost.balanced_supporting_offer_ids.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const rows = Array.isArray(cost?.balanced_supporting_offer_evidence)
    ? cost.balanced_supporting_offer_evidence
    : [];
  const rowIds = rows.map((row) => String(row?.offer_id || "").trim());
  const suppliers = rows.map((row) => String(row?.supplier_id || "").trim());
  return cost?.balanced_match === true
    && cost?.balanced_match_type === "corroborated_multi"
    && ids.length === 2
    && new Set(ids).size === 2
    && rows.length === 2
    && rowIds.every((offerId, index) => offerId === ids[index])
    && suppliers.every(Boolean)
    && new Set(suppliers).size === 2;
}

export function requiredSameItemMatchCount(cost = {}, minimumMatches = 3) {
  const configured = Math.max(1, Number(minimumMatches) || 1);
  if (hasBoundSignedStrongSingle(cost)) return 1;
  if (hasBoundSignedCorroboratedPair(cost)) return 2;
  return configured;
}

export function sameItemCostEvidence(cost = {}, { minimumMatches = 3 } = {}) {
  const requiredMatches = Math.max(1, Number(minimumMatches) || 1);
  const source = String(cost?.source || "").trim();
  const matchEvidenceKey = String(cost?.match_evidence_key || "").trim();
  const selectedOfferId = String(cost?.selected_offer_id || "").trim();
  const evidenceContract = String(cost?.match_evidence_contract || "");
  const prices = Array.isArray(cost?.prices)
    ? cost.prices.map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  const requiredEvidenceCount = requiredSameItemMatchCount(cost, requiredMatches);
  const verified = cost?.ok === true
    && Number(cost?.cost) > 0
    && isReliable1688CostSource(source)
    && isValid1688MatchEvidenceKey(matchEvidenceKey)
    && cost?.same_item_match === true
    && cost?.returned_evidence_verified === true
    && (evidenceContract === "1688-returned-same-item-v2" || Boolean(selectedOfferId))
    && ["1688-returned-same-item-v2", "1688-returned-same-item-v3"].includes(evidenceContract)
    && Number(cost?.matched_offer_count) >= requiredEvidenceCount
    && prices.length >= requiredEvidenceCount;
  return {
    contract: "1688-same-item-v1",
    source,
    reliable_source: isReliable1688CostSource(source),
    same_item_match: verified,
    match_evidence_key: matchEvidenceKey || null,
    filtered_price_count: prices.length,
    match_evidence_contract: verified ? evidenceContract : null,
    returned_evidence_verified: verified,
    matched_offer_count: verified ? Number(cost.matched_offer_count) : 0,
    selected_offer_id: verified ? selectedOfferId : null,
  };
}

export function hasReliableSameItemCostEvidence(data = {}, { minimumMatches = 3 } = {}) {
  const requiredMatches = Math.max(1, Number(minimumMatches) || 1);
  const cost = data?.cost || {};
  const evidence = data?.cost_evidence || {};
  const source = String(data?.cost_source || cost?.source || "").trim();
  const prices = Array.isArray(cost?.prices)
    ? cost.prices.map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  const requiredEvidenceCount = requiredSameItemMatchCount(cost, requiredMatches);
  return data?.cost_verified === true
    && cost?.ok === true
    && Number(cost?.cost) > 0
    && evidence?.contract === "1688-same-item-v1"
    && evidence?.reliable_source === true
    && evidence?.same_item_match === true
    && evidence?.returned_evidence_verified === true
    && ["1688-returned-same-item-v2", "1688-returned-same-item-v3"].includes(evidence?.match_evidence_contract)
    && Number(evidence?.matched_offer_count) >= requiredEvidenceCount
    && isReliable1688CostSource(source)
    && String(evidence?.source || "") === source
    && isValid1688MatchEvidenceKey(evidence?.match_evidence_key)
    && String(evidence.match_evidence_key) === String(cost?.match_evidence_key || "")
    && (evidence?.match_evidence_contract === "1688-returned-same-item-v2" || (
      Boolean(String(cost?.selected_offer_id || "").trim())
      && String(evidence?.selected_offer_id || "") === String(cost?.selected_offer_id || "")
    ))
    && cost?.same_item_match === true
    && cost?.returned_evidence_verified === true
    && cost?.match_evidence_contract === evidence.match_evidence_contract
    && Number(cost?.matched_offer_count) === Number(evidence?.matched_offer_count)
    && Number(evidence?.filtered_price_count) >= requiredEvidenceCount
    && prices.length >= requiredEvidenceCount;
}
