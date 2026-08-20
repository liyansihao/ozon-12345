#!/usr/bin/env node

import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUDITED_DISCOVERY_SEED_CONTRACT,
  AUDITED_DISCOVERY_SEED_ARTIFACT_SHA256,
  AUDITED_DISCOVERY_SEED_SCHEMA_VERSION,
  validateAuditedDiscoverySeedArtifact,
} from "./flow_b_playwright/audited-discovery-seed.mjs";
import { auditedSourceSetSha256 } from "./flow_b_playwright/audited-source-portfolio.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputFile = path.join(packageRoot, "config", "ozon_audited_discovery_seeds.json");

const GLOBAL_DENY = [
  "духи", "парфюм", "туалетная вода", "космет", "сыворот", "крем для лица", "шампун", "масло",
  "гель", "спрей", "жидкост", "еда", "напиток", "футболк", "плать", "одежд", "обув", "сумк",
  "игруш", "кукл", "конструкт", "lego", "лего", "star wars", "marvel", "disney", "minecraft",
  "pokemon", "hot wheels", "barbie", "hello kitty", "sanrio", "labubu", "lps", "авто", "автомоб",
  "мото", "obd", "elm327", "совместим", "набор", "комплект", "упаковк", "лот", "пара", "dewalt",
  "makita", "bosch", "philips", "osram", "ecola", "navigator", "tuya", "aqara", "yeelight",
  "gauss", "voltme", "dled", "ceoniya", "ugreen", "baseus", "anker", "hoco", "defender", "abb",
  "iek", "wago", "xq",
];

const GLOBAL_DENY_REGEX = [
  "(?:^|\\s)(?:[2-9]|\\d{2,})\\s*(?:шт\\.?|штук|предмет|пар[ыа]?)",
  "(?:две|три|четыре|пять|шесть|семь|восемь|девять|десять)\\s+(?:штуки|штук|предмета|пары)",
  "(?:^|\\s)\\d+\\s*[- ]?[вxх]\\s*[- ]?1(?:\\s|,|$)",
  "для\\s+(?:honda|toyota|bmw|mercedes|lexus|ford|audi|volkswagen|volvo|mazda|nissan|kia|hyundai|renault|lada|haval|chery|geely|tesla|yamaha|suzuki|ktm|iphone|ipad|samsung|xiaomi|redmi|huawei|honor|nikon|canon|epson|bambu|anycubic)",
];

const GLOBAL_LATIN_ALLOWLIST = [
  "usb", "type", "micro", "mini", "hdmi", "displayport", "vga", "dvi", "rj", "ethernet",
  "aux", "jack", "dc", "sd", "tf", "otg", "led", "gu", "gx", "ip", "rgb", "uv", "awg",
  "pd", "qc", "pps", "gan", "hub", "card", "reader", "fast", "charge", "black", "white",
  "female", "male", "cat",
];

const GUARD_PROFILES = {
  L: ["лампочка", "лампа в комплекте", "кольцев", "фото", "софтбокс", "штатив", "маникюр", "ногт", "для растений", "фитоламп", "умн", "датчик", "сенсор", "rgb", "автомоб", "мото"],
  E: ["умн", "wifi", "wi-fi", "zigbee", "bluetooth", "сенсор", "дистанцион", "пульт", "таймер"],
  A: ["зарядное устройство", "блок питания", "sim", "антенн", "объектив", "байонет", "пылесос", "аккумулятор", "для iphone", "для samsung", "для xiaomi"],
  C: ["lightning", "mfi", "для iphone", "для samsung", "для xiaomi"],
  T: ["аккумулятор", "электрическ", "ударн", "насадк", "сменн", "запасн"],
};

function guarded(profile, specific = []) {
  return [...new Set([...GUARD_PROFILES[profile], ...specific])]
    .filter((term) => !GLOBAL_DENY.includes(term));
}

function seed(id, categoryKey, accessoryRole, queryText, priceMin, priceMax, prefix, groups, {
  priority,
  attributes,
  deny = [],
  latin = [],
} = {}) {
  const sourceUrls = [1, 2].map((page) => {
    const url = new URL("https://www.ozon.ru/search/");
    url.searchParams.set("currency_price", `${priceMin.toFixed(3)};${priceMax.toFixed(3)}`);
    url.searchParams.set("is_global", "true");
    url.searchParams.set("page", String(page));
    url.searchParams.set("sorting", "rating");
    url.searchParams.set("text", queryText);
    url.searchParams.sort();
    return url.toString();
  });
  return {
    id,
    selection_priority: priority,
    source_type: "search",
    source_urls: sourceUrls,
    query_text: queryText,
    category_key: categoryKey,
    accessory_role: accessoryRole,
    required_role_attributes: attributes,
    title_prefix_terms_any: prefix,
    required_term_groups_all: groups,
    deny_terms_any: deny,
    allowed_latin_tokens: latin,
    deny_unknown_latin_tokens: true,
    seed_price_band_rub: { min: priceMin, max: priceMax },
    seller_price_band_rub: { min: priceMin, max: priceMax },
  };
}

const seeds = [
  seed("L01", "lighting-recessed-gx53", "fixture-recessed-gx53", "встраиваемый светильник GX53", 250, 5000,
    ["встраиваемый", "светильник"], [["светильник"], ["встраиваем"], ["gx53"]],
    { priority: 5, attributes: { fixture_type: "recessed", socket: "gx53" }, deny: guarded("L"), latin: ["gx53"] }),
  seed("L02", "lighting-surface-gx53", "fixture-surface-gx53", "накладной светильник GX53", 250, 5000,
    ["накладной", "светильник"], [["светильник"], ["накладн"], ["gx53"]],
    { priority: 6, attributes: { fixture_type: "surface", socket: "gx53" }, deny: guarded("L"), latin: ["gx53"] }),
  seed("L03", "lighting-track-gu10", "fixture-track-gu10", "трековый светильник GU10", 250, 5000,
    ["трековый", "светильник", "спот"], [["светильник", "спот"], ["треков"], ["gu10"]],
    { priority: 7, attributes: { fixture_type: "track", socket: "gu10" }, deny: guarded("L"), latin: ["gu10"] }),
  seed("L04", "lighting-wall-ceiling-gu10", "fixture-wall-ceiling-gu10", "настенно потолочный спот GU10", 250, 5000,
    ["настенно", "светильник", "спот"], [["светильник", "спот"], ["настенно-потолочн", "настенно потолочн", "поворотн"], ["gu10"]],
    { priority: 8, attributes: { fixture_type: "wall-ceiling-adjustable", socket: "gu10" }, deny: guarded("L"), latin: ["gu10"] }),
  seed("L05", "lighting-outdoor-e27-ip65", "fixture-outdoor-wall-e27-ip65", "уличный настенный светильник E27 IP65", 250, 5000,
    ["уличный", "светильник"], [["светильник"], ["уличн", "фасадн"], ["e27"], ["ip65", "ip66"]],
    { priority: 1, attributes: { fixture_type: "outdoor-wall", ingress_rating: "ip65-or-ip66", socket: "e27" }, deny: guarded("L"), latin: ["e27", "ip65", "ip66"] }),
  seed("L06", "lighting-sauna-ip65", "fixture-sauna-ip65", "светильник для бани IP65", 250, 5000,
    ["светильник"], [["светильник"], ["баня", "бани", "сауна", "парная"], ["ip65", "ip66"]],
    { priority: 2, attributes: { environment: "sauna", fixture_type: "sealed", ingress_rating: "ip65-or-ip66" }, deny: guarded("L"), latin: ["ip65", "ip66"] }),
  seed("L07", "lighting-furniture-recessed", "fixture-furniture-recessed-220v", "мебельный встраиваемый светильник 220V", 250, 5000,
    ["мебельный", "светильник"], [["светильник"], ["мебельн"], ["встраиваем"], ["220v", "220в", "220 в"]],
    { priority: 3, attributes: { fixture_type: "furniture-recessed", voltage: "220v" }, deny: guarded("L"), latin: ["v"] }),
  seed("L08", "lighting-linear-t5", "fixture-linear-t5-220v", "линейный светильник T5 220V", 250, 5000,
    ["линейный", "светильник"], [["светильник"], ["линейн"], ["t5"], ["220v", "220в", "220 в"]],
    { priority: 4, attributes: { fixture_type: "linear", form_factor: "t5", voltage: "220v" }, deny: guarded("L"), latin: ["t5", "v"] }),

  seed("E01", "electrical-outdoor-socket", "socket-surface-grounded-ip44", "розетка накладная с заземлением IP44", 125, 2500,
    ["розетка"], [["розетка"], ["накладн", "наружн"], ["заземл"], ["ip44", "ip54", "ip55", "ip65", "ip66"]],
    { priority: 9, attributes: { grounding: "yes", ingress_rating: "ip44-or-higher", mount: "surface", product_type: "socket" }, deny: guarded("E"), latin: ["ip44", "ip54", "ip55", "ip65", "ip66"] }),
  seed("E02", "electrical-flush-socket", "socket-double-flush-grounded", "розетка двойная скрытой установки с заземлением", 125, 2500,
    ["розетка"], [["розетка"], ["двойн"], ["скрыт", "встраиваем"], ["заземл"]],
    { priority: 10, attributes: { grounding: "yes", mount: "flush", outlets: "2", product_type: "socket" }, deny: guarded("E") }),
  seed("E03", "electrical-outdoor-switch", "switch-surface-ip44", "выключатель накладной IP44", 125, 2500,
    ["выключатель"], [["выключатель"], ["накладн", "наружн"], ["ip44", "ip54", "ip55", "ip65", "ip66"]],
    { priority: 11, attributes: { ingress_rating: "ip44-or-higher", mount: "surface", product_type: "switch" }, deny: guarded("E"), latin: ["ip44", "ip54", "ip55", "ip65", "ip66"] }),
  seed("E04", "electrical-plug-splitter", "socket-splitter-16a", "тройник для розетки 16А", 125, 2500,
    ["тройник", "разветвитель"], [["тройник", "разветвитель"], ["розетк"], ["16а", "16a"]],
    { priority: 12, attributes: { current: "16a", product_type: "socket-splitter" }, deny: guarded("E", ["латун", "резьба", "водо", "душ", "смесител", "труб"]), latin: ["a"] }),
  seed("E05", "electrical-extension", "extension-3socket-2m", "удлинитель сетевой 3 розетки 2 метра", 250, 2500,
    ["удлинитель"], [["удлинитель"], ["сетев"], ["3 розет"], ["2м", "2 м", "2 метр"]],
    { priority: 13, attributes: { cable_length: "2m", outlets: "3", product_type: "extension" }, deny: guarded("E"), latin: ["m"] }),
  seed("E06", "low-voltage-power-12v2a", "power-supply-12v2a-dc5521", "блок питания 12V 2A 5.5x2.1", 250, 2500,
    ["блок питания", "адаптер питания"], [["блок питания", "адаптер питания"], ["12v", "12в", "12 в"], ["2a", "2а", "2 а"], ["5.5x2.1", "5,5x2,1", "5.5х2.1", "5,5х2,1"]],
    { priority: 14, attributes: { connector: "dc-5.5x2.1", current: "2a", output_voltage: "12v", product_type: "fixed-power-supply" }, deny: guarded("E", ["универсальн", "регулируем", "для роутер", "для камеры", "для ноутбук"]), latin: ["v", "a", "dc", "x2.1"] }),
  seed("E07", "electrical-lamp-holder", "lamp-holder-ceramic-e27", "патрон керамический E27", 125, 1500,
    ["патрон"], [["патрон"], ["керамич"], ["e27"]],
    { priority: 15, attributes: { material: "ceramic", product_type: "lamp-holder", socket: "e27" }, deny: guarded("E", ["дрель", "шуруповерт", "перфоратор"]), latin: ["e27"] }),
  seed("E08", "electrical-angle-plug", "plug-angle-grounded-16a", "вилка электрическая угловая 16А с заземлением", 125, 1500,
    ["вилка"], [["вилка"], ["электрическ"], ["углов"], ["16а", "16a"], ["заземл"]],
    { priority: 16, attributes: { current: "16a", grounding: "yes", orientation: "angle", product_type: "electrical-plug" }, deny: guarded("E", ["столов", "салат", "барбекю"]), latin: ["a"] }),

  seed("A01", "adapter-usb-typec", "adapter-usb3-typec-otg", "переходник USB 3.0 Type-C OTG", 125, 2500,
    ["переходник", "адаптер"], [["переходник", "адаптер"], ["usb 3.0", "usb3"], ["type-c", "type c"], ["otg"]],
    { priority: 21, attributes: { connector_a: "usb-c-male", connector_b: "usb-a-female", direction: "usb-c-host-to-usb-a-device", protocol: "otg" }, deny: guarded("A"), latin: ["usb", "usb3", "type-c", "type", "otg"] }),
  seed("A02", "adapter-typec-microusb", "adapter-typec-microusb", "переходник Type-C Micro USB", 125, 2500,
    ["переходник", "адаптер"], [["переходник", "адаптер"], ["type-c", "type c"], ["micro usb", "microusb"]],
    { priority: 22, attributes: { connector_a: "usb-c-female", connector_b: "micro-usb-male", direction: "usb-c-cable-to-micro-usb-device" }, deny: guarded("A"), latin: ["usb", "type-c", "type", "micro", "microusb"] }),
  seed("A03", "adapter-hdmi-coupler", "adapter-hdmi-female-female", "переходник HDMI мама-мама", 125, 1500,
    ["переходник", "адаптер"], [["переходник", "адаптер"], ["hdmi"], ["мама-мама", "мама мама", "female female"]],
    { priority: 23, attributes: { connector_a: "hdmi-female", connector_b: "hdmi-female", direction: "bidirectional" }, deny: guarded("A"), latin: ["hdmi", "female"] }),
  seed("A04", "adapter-hdmi-mini", "adapter-hdmi-mini-angle", "переходник HDMI Mini HDMI угловой", 125, 2500,
    ["переходник", "адаптер"], [["переходник", "адаптер"], ["hdmi"], ["mini hdmi"], ["углов", "90"]],
    { priority: 17, attributes: { connector_a: "hdmi-female", connector_b: "mini-hdmi-male", direction: "bidirectional", orientation: "angle-90" }, deny: guarded("A", ["кабель"]), latin: ["hdmi", "mini"] }),
  seed("A05", "adapter-hdmi-vga", "adapter-hdmi-vga-no-cable", "переходник HDMI VGA без кабеля", 125, 2500,
    ["переходник", "адаптер"], [["переходник", "адаптер"], ["hdmi"], ["vga"], ["без кабел"]],
    { priority: 18, attributes: { cable: "none", connector_a: "hdmi-male", connector_b: "vga-female", direction: "hdmi-source-to-vga-display" }, deny: guarded("A", ["кабель в комплекте"]), latin: ["hdmi", "vga"] }),
  seed("A06", "adapter-displayport-hdmi", "adapter-displayport-hdmi", "переходник DisplayPort HDMI", 125, 2500,
    ["переходник", "адаптер"], [["переходник", "адаптер"], ["displayport", "display port", "dp"], ["hdmi"]],
    { priority: 19, attributes: { connector_a: "displayport-male", connector_b: "hdmi-female", direction: "displayport-source-to-hdmi-display" }, deny: guarded("A", ["кабель"]), latin: ["displayport", "dp", "hdmi"] }),
  seed("A07", "card-reader-typec", "card-reader-typec-sd-tf", "картридер Type-C SD TF", 125, 2500,
    ["картридер", "card reader"], [["картридер", "card reader"], ["type-c", "type c"], ["sd"], ["tf", "microsd", "micro sd"]],
    { priority: 20, attributes: { connector: "usb-c", product_type: "card-reader", slots: "sd-and-tf" }, deny: guarded("A"), latin: ["card", "reader", "type-c", "type", "sd", "tf", "microsd", "micro"] }),
  seed("A08", "usb-hub-4port", "hub-usb3-4port", "USB хаб 4 порта USB 3.0", 250, 2500,
    ["usb хаб", "хаб", "usb hub"], [["хаб", "hub", "разветвитель"], ["usb 3.0", "usb3"], ["4 порт"]],
    { priority: 24, attributes: { downstream_ports: "4", product_type: "usb-hub", protocol: "usb3" }, deny: guarded("A"), latin: ["usb", "usb3", "hub"] }),

  seed("C01", "cable-hdmi", "cable-hdmi-male-male-2m", "кабель HDMI HDMI 2 метра", 250, 2500,
    ["кабель"], [["кабель"], ["hdmi"], ["2м", "2 м", "2 метр"]],
    { priority: 25, attributes: { cable_length: "2m", connector_a: "hdmi-male", connector_b: "hdmi-male", direction: "bidirectional" }, deny: guarded("C"), latin: ["hdmi", "m"] }),
  seed("C02", "cable-ethernet-cat6", "cable-cat6-rj45-2m", "патч корд CAT6 RJ45 2 метра", 125, 1500,
    ["патч корд", "патч-корд", "кабель"], [["патч корд", "патч-корд", "кабель"], ["cat6", "cat 6"], ["rj45", "rj-45"], ["2м", "2 м", "2 метр"]],
    { priority: 26, attributes: { cable_category: "cat6", cable_length: "2m", connector_a: "rj45-male", connector_b: "rj45-male" }, deny: guarded("C"), latin: ["cat6", "cat", "rj45", "rj", "m"] }),

  seed("T01", "tool-caliper", "tool-digital-caliper-150mm", "штангенциркуль электронный 150 мм металлический", 250, 2500,
    ["штангенциркуль"], [["штангенциркуль"], ["электронн", "цифров"], ["150мм", "150 мм"], ["металл"]],
    { priority: 27, attributes: { material: "metal", measurement_range: "150mm", product_type: "digital-caliper" }, deny: guarded("T"), latin: ["mm"] }),
  seed("T02", "tool-wire-stripper", "tool-wire-stripper-0.2-6mm", "стриппер для снятия изоляции 0.2-6 мм", 250, 2500,
    ["стриппер"], [["стриппер"], ["изоляц"], ["0.2", "0,2"], ["6мм", "6 мм"]],
    { priority: 28, attributes: { product_type: "manual-wire-stripper", wire_range: "0.2-6mm" }, deny: guarded("T", ["набор"]), latin: ["mm"] }),
  seed("T03", "tool-step-drill", "tool-step-drill-4-20mm", "сверло ступенчатое по металлу 4-20 мм", 250, 2500,
    ["сверло"], [["сверло"], ["ступенчат"], ["металл"], ["4-20", "4–20"]],
    { priority: 29, attributes: { material_target: "metal", product_type: "step-drill", size_range: "4-20mm" }, deny: guarded("T", ["набор"]), latin: ["mm"] }),
  seed("T04", "tool-socket-head", "tool-socket-head-10mm-half-inch", "торцевая головка 10 мм 1/2", 250, 2500,
    ["торцевая головка", "головка"], [["торцев"], ["головк"], ["10мм", "10 мм"], ["1/2"]],
    { priority: 30, attributes: { drive: "1/2-inch", product_type: "single-socket-head", size: "10mm" }, deny: guarded("T", ["набор"]), latin: ["mm"] }),
];

const artifact = {
  contract: AUDITED_DISCOVERY_SEED_CONTRACT,
  schema_version: AUDITED_DISCOVERY_SEED_SCHEMA_VERSION,
  deployment_phase: "validation_only",
  automatic_publish_eligible: false,
  price_evidence_publish_eligible: false,
  favorite_mutations_allowed: false,
  submission_allowed: false,
  generated_at: "2026-08-18T00:00:00.000Z",
  source_query_contract: {
    price_parameter: "currency_price",
    price_band_currency: "RUB",
    effective_cny_evidence: "live-same-page-rate-only",
    sorting: "rating",
    max_page: 2,
    require_card_price_within_rub_band: true,
    require_detail_current_rub_within_band: true,
    identity_checkpoint_max_age_ms: 24 * 60 * 60 * 1_000,
    current_price_max_age_ms: 15 * 60 * 1_000,
    next_stage_requires_live_price_refetch: true,
  },
  global_guard: {
    live_brand_policy: "empty-or-no-name-only",
    deny_terms_any: GLOBAL_DENY,
    deny_regex: GLOBAL_DENY_REGEX,
    unknown_latin_token_policy: {
      action: "reject",
      min_alpha_length: 3,
      allowlist: GLOBAL_LATIN_ALLOWLIST,
    },
  },
  compiler_policy: {
    minimum_observations_per_seller_role: 3,
    minimum_distinct_sellers: 20,
    maximum_distinct_sellers: 120,
  },
  assignment_policy: {
    global_dedup_key: "sku",
    rule: ["highest_required_group_count", "priority_order", "seed_id"],
    priority_order: [
      "L05", "L06", "L07", "L08", "L01", "L02", "L03", "L04",
      "E01", "E02", "E03", "E04", "E05", "E06", "E07", "E08",
      "A04", "A05", "A06", "A07", "A01", "A02", "A03", "A08",
      "C01", "C02", "T01", "T02", "T03", "T04",
    ],
  },
  capacity_policy: {
    minimum_detail_strict_unique: 360,
    minimum_current_sellers: 20,
    maximum_unique_per_seller: 18,
    forecast_counts_for_gate: false,
    historical_proxy_counts_for_gate: false,
  },
  excluded_seller_urls: [
    "https://www.ozon.ru/seller/wan-le-fu/",
    "https://www.ozon.ru/seller/radjab-carpet-ofitsialnyy-magazin/",
    "https://www.ozon.ru/seller/ganagoho-mototsikl/",
    "https://www.ozon.ru/seller/tinyworld/",
    "https://www.ozon.ru/seller/jicha-3396280/",
    "https://www.ozon.ru/seller/li-01-3837508/",
    "https://www.ozon.ru/seller/youzi-5074541/",
    "https://www.ozon.ru/seller/han-2001709/",
    "https://www.ozon.ru/seller/univermag-2688595/",
    "https://www.ozon.ru/seller/upcloud-international/",
  ],
  seeds,
};

artifact.source_set_sha256 = auditedSourceSetSha256(seeds.flatMap((entry) => entry.source_urls));
validateAuditedDiscoverySeedArtifact(artifact, { sourcePath: outputFile, now: new Date("2026-08-19T23:59:59Z") });
await fs.mkdir(path.dirname(outputFile), { recursive: true });
const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
const fileSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
if (fileSha256 !== AUDITED_DISCOVERY_SEED_ARTIFACT_SHA256) {
  throw new Error(`generated artifact SHA256 ${fileSha256} does not match the external code pin`);
}
await fs.writeFile(outputFile, bytes, "utf8");
process.stdout.write(`${outputFile}\n${artifact.source_set_sha256}\n`);
