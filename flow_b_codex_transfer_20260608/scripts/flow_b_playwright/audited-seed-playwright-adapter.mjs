import {
  AUDITED_LIVE_BRAND_EVIDENCE_SOURCE,
  AUDITED_LIVE_PRICE_EVIDENCE_SCOPE,
  AUDITED_LIVE_SELLER_EVIDENCE_SOURCE,
  AUDITED_PRICE_DOM_CONTRACT,
  auditedSeedTitleEligibility,
  createAuditedSeedReadOnlyAdapter,
} from "./audited-discovery-seed.mjs";
import { createPlaywrightAuditedLiveDetailFetcher } from "./audited-validation-discovery.mjs";
import { scanSourceWithPage } from "./source-scanner.mjs";

const SUCCESSFUL_SCAN_REASONS = new Set(["link_target_reached", "stable_bottom", "no_new_links_near_bottom", "verified_empty"]);
const CARD_RUB_PATTERN = /(?:^|\s)(\d{1,3}(?:[\s\u00a0]\d{3})*|\d+)(?:[.,]\d{1,2})?\s*(?:₽|руб\.?|rub)(?=\s|$)/giu;
const BLOCK_TEXT = /captcha|капч|验证码|验证您|доступ ограничен|access denied|войти|登录|手机号|парол/iu;
const DEVICE_COMPATIBILITY = /\b(?:для|совместим)\s+(?:iphone|ipad|samsung|xiaomi|redmi|huawei|honor|nikon|canon|epson|bambu|anycubic|honda|toyota|bmw|mercedes|lexus|ford|audi|volkswagen|volvo|mazda|nissan|kia|hyundai|renault|lada|haval|chery|geely|tesla|yamaha|suzuki|ktm)\b/iu;

const ROLE_VALUE_PATTERNS = Object.freeze({
  "0.2-6mm": /(?:0[.,]2)\s*[-–]\s*6\s*мм/iu,
  "1/2-inch": /(?:1\s*\/\s*2|12[.,]7\s*мм)/iu,
  "10mm": /10\s*мм/iu,
  "12v": /12\s*(?:v|в|вольт)/iu,
  "150mm": /150\s*мм/iu,
  "16a": /16\s*(?:a|а|ампер)/iu,
  "2": /(?:^|\D)2(?:\D|$)/u,
  "220v": /220\s*(?:v|в|вольт)/iu,
  "2a": /2\s*(?:a|а|ампер)/iu,
  "2m": /2\s*(?:м|метр)/iu,
  "3": /(?:^|\D)3(?:\D|$)/u,
  "4": /(?:^|\D)4(?:\D|$)/u,
  "4-20mm": /4\s*[-–]\s*20\s*мм/iu,
  angle: /углов|под углом|angle/iu,
  "angle-90": /(?:углов|90\s*°|90\s*град)/iu,
  bidirectional: /двунаправ|bidirectional|мама\s*[-–]?\s*мама|hdmi[\s\S]{0,80}hdmi/iu,
  "card-reader": /картридер|card\s*reader/iu,
  cat6: /cat\s*6/iu,
  ceramic: /керамич/iu,
  "dc-5.5x2.1": /5[.,]5\s*[xх×]\s*2[.,]1/iu,
  "digital-caliper": /штангенциркул[\s\S]{0,80}(?:цифров|электрон)/iu,
  "displayport-male": /display\s*port[\s\S]{0,60}(?:male|папа|штекер)/iu,
  "displayport-source-to-hdmi-display": /display\s*port[\s\S]{0,120}hdmi/iu,
  e27: /e\s*27/iu,
  "electrical-plug": /электрическ[\s\S]{0,50}вилк|вилк[\s\S]{0,50}электрическ/iu,
  extension: /удлинител/iu,
  "fixed-power-supply": /блок\s*питания|адаптер\s*питания/iu,
  flush: /скрыт|встраиваем/iu,
  "furniture-recessed": /мебельн[\s\S]{0,80}встраиваем|встраиваем[\s\S]{0,80}мебельн/iu,
  gu10: /gu\s*10/iu,
  gx53: /gx\s*53/iu,
  "hdmi-female": /hdmi[\s\S]{0,60}(?:female|мама|гнездо)/iu,
  "hdmi-male": /hdmi[\s\S]{0,60}(?:male|папа|штекер)/iu,
  "hdmi-source-to-vga-display": /hdmi[\s\S]{0,120}vga/iu,
  "ip44-or-higher": /ip\s*(?:44|54|55|65|66|67|68)/iu,
  "ip65-or-ip66": /ip\s*(?:65|66)/iu,
  "lamp-holder": /патрон[\s\S]{0,80}(?:ламп|e\s*27)/iu,
  linear: /линейн/iu,
  "manual-wire-stripper": /стриппер|сняти[ея]\s*изоляц/iu,
  metal: /металл/iu,
  "micro-usb-male": /micro\s*usb[\s\S]{0,60}(?:male|папа|штекер)/iu,
  "mini-hdmi-male": /mini\s*hdmi[\s\S]{0,60}(?:male|папа|штекер)/iu,
  none: /без\s*кабел|кабель\s*отсутств|не\s*входит/iu,
  otg: /\botg\b/iu,
  "outdoor-wall": /уличн[\s\S]{0,80}(?:настенн|фасад)|(?:настенн|фасад)[\s\S]{0,80}уличн/iu,
  recessed: /встраиваем/iu,
  "rj45-male": /rj\s*[- ]?45[\s\S]{0,60}(?:male|папа|штекер|коннектор)/iu,
  sauna: /баня|бани|сауна|парная/iu,
  "sd-and-tf": /\bsd\b[\s\S]{0,80}(?:\btf\b|micro\s*sd)|(?:\btf\b|micro\s*sd)[\s\S]{0,80}\bsd\b/iu,
  sealed: /герметич|влагозащ|пылевлагозащ|ip\s*(?:65|66)/iu,
  "single-socket-head": /торцев[\s\S]{0,60}головк/iu,
  socket: /розетк/iu,
  "socket-splitter": /тройник|разветвител/iu,
  "step-drill": /ступенчат[\s\S]{0,60}сверл|сверл[\s\S]{0,60}ступенчат/iu,
  surface: /накладн|наружн/iu,
  switch: /выключател/iu,
  t5: /\bt\s*5\b/iu,
  track: /треков/iu,
  "usb-a-female": /usb(?:\s*[- ]?a)?[\s\S]{0,60}(?:female|мама|гнездо)/iu,
  "usb-c": /(?:usb\s*[- ]?c|type\s*[- ]?c)/iu,
  "usb-c-cable-to-micro-usb-device": /(?:usb\s*[- ]?c|type\s*[- ]?c)[\s\S]{0,140}micro\s*usb/iu,
  "usb-c-female": /(?:usb\s*[- ]?c|type\s*[- ]?c)[\s\S]{0,60}(?:female|мама|гнездо)/iu,
  "usb-c-host-to-usb-a-device": /(?:usb\s*[- ]?c|type\s*[- ]?c)[\s\S]{0,160}usb(?:\s*[- ]?a)?[\s\S]{0,80}\botg\b/iu,
  "usb-c-male": /(?:usb\s*[- ]?c|type\s*[- ]?c)[\s\S]{0,60}(?:male|папа|штекер)/iu,
  "usb-hub": /usb\s*(?:hub|хаб)|(?:hub|хаб)[\s\S]{0,40}usb/iu,
  usb3: /usb\s*3(?:[.,]0)?/iu,
  "vga-female": /vga[\s\S]{0,60}(?:female|мама|гнездо)/iu,
  "wall-ceiling-adjustable": /настенно[ -]?потолочн|поворотн/iu,
  yes: /(?:есть|да|с\s+заземлен|заземлени[ея])/iu,
});

function adapterError(message) {
  return new Error(`audited seed Playwright adapter: ${message}`);
}

function parseSingleCardRub(text) {
  const values = [];
  for (const match of String(text || "").matchAll(CARD_RUB_PATTERN)) {
    const value = Number(String(match[1]).replace(/[\s\u00a0]/gu, ""));
    if (Number.isFinite(value) && value > 0) values.push(value);
  }
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : null;
}

function cardTitle(link, artifact, seedId) {
  const candidates = [link?.text, ...String(link?.card_text || "").split(/\r?\n/u)]
    .map((value) => String(value || "").trim()).filter(Boolean)
    .filter((value) => !/(?:₽|руб\.?|\bRUB\b|доставк|отзыв|скидк|остал(?:ось|ся)|завтра|сегодня)/iu.test(value));
  return candidates.find((value) => auditedSeedTitleEligibility(value, artifact, seedId).eligible)?.slice(0, 500) || "";
}

function normalizedScanResult(request, result, artifact) {
  const successful = result?.blocked !== true && SUCCESSFUL_SCAN_REASONS.has(String(result?.stop_reason || ""));
  const seedId = request.seed_id || request.originating_seed_id;
  if (!seedId) throw adapterError("source scan request is missing an explicit originating seed id");
  const links = (result?.links || []).flatMap((link) => {
    const title = cardTitle(link, artifact, seedId);
    const href = String(link?.href || "").split(/[?#]/u)[0];
    const cardPriceEvidence = link?.card_price_evidence;
    const currentPriceRub = cardPriceEvidence?.current_candidate_count === 1
      ? parseSingleCardRub(cardPriceEvidence.current_price_node?.raw_text)
      : null;
    const sku = href.match(/^https:\/\/(?:www\.)?ozon\.ru\/product\/(?:[^/?#]*-)?(\d+)\/?$/iu)?.[1] || "";
    return sku && title && currentPriceRub ? [{
      sku,
      href,
      title,
      current_price_rub: currentPriceRub,
      card_price_evidence: cardPriceEvidence,
    }] : [];
  });
  return Object.freeze({
    status: successful && links.length > 0 ? "completed" : "failed",
    complete: successful && links.length > 0,
    stop_reason: successful && links.length > 0 ? "completed" : String(result?.stop_reason || "incomplete"),
    final_url: result?.final_url,
    links: Object.freeze(links),
  });
}

function priceEvidenceFromDetail(detail) {
  const followLines = [...new Set(detail?.follow_price_lines || [])];
  if (followLines.length !== 1) throw adapterError("live detail must expose exactly one same-page Maozi follow-price line");
  return {
    live_price_evidence_scope: AUDITED_LIVE_PRICE_EVIDENCE_SCOPE,
    live_price_evidence: {
      method: "ozon-detail-plugin-live",
      live: true,
      source_field: "web_price_plus_same_page_follow_pair",
      dom_contract: AUDITED_PRICE_DOM_CONTRACT,
      raw_web_price_text: detail.web_price_text,
      current_price_rub_text: detail.current_price_node?.raw_text,
      old_price_rub_texts: (detail.excluded_price_nodes || [])
        .filter((row) => row.exclusion_reason === "line-through-old-price")
        .map((row) => row.raw_text),
      raw_follow_price_line: followLines[0],
      api_rate_reference: detail.api_rate_reference,
      observed_at: detail.observed_at,
    },
  };
}

function categoryPattern(categoryKey) {
  if (categoryKey.startsWith("lighting-")) return /свет|освещ|люстр|спот/iu;
  if (categoryKey.startsWith("electrical-") || categoryKey.startsWith("low-voltage-")) {
    return /электр|розет|выключ|удлин|вилк|патрон|блок\s*питания/iu;
  }
  if (categoryKey.startsWith("adapter-") || categoryKey === "card-reader-typec" || categoryKey === "usb-hub-4port") {
    return /переход|адаптер|картридер|card\s*reader|usb|разъем|коннектор/iu;
  }
  if (categoryKey.startsWith("cable-")) return /кабел|патч|шнур/iu;
  if (categoryKey.startsWith("tool-")) return /инструмент|штанген|стриппер|сверл|головк/iu;
  return /$a/u;
}

function rowText(row) {
  return `${String(row?.label || "").trim()}: ${String(row?.value || "").trim()}`.trim();
}

function classifySnapshot(snapshot, target) {
  if (!snapshot || BLOCK_TEXT.test(`${snapshot.document_title || ""}\n${snapshot.body_sample || ""}`)) {
    throw adapterError("attribute inspection is blocked or incomplete");
  }
  const breadcrumb = String(snapshot.breadcrumb || "").trim();
  if (!breadcrumb || !categoryPattern(target.category_key).test(breadcrumb)) {
    throw adapterError(`breadcrumb does not prove category ${target.category_key}`);
  }
  const rows = (snapshot.attribute_rows || []).filter((row) => row?.label && row?.value);
  if (rows.length === 0) throw adapterError("live attribute table is missing");
  const tableText = rows.map(rowText).join("\n");
  if (DEVICE_COMPATIBILITY.test(`${snapshot.title || ""}\n${tableText}`)) {
    throw adapterError("live attribute table contains device or vehicle compatibility");
  }
  const roleAttributes = {};
  const roleAttributeEvidence = {};
  for (const [key, value] of Object.entries(target.required_role_attributes || {})) {
    const pattern = ROLE_VALUE_PATTERNS[value];
    if (!pattern) throw adapterError(`no pinned role matcher exists for ${key}=${value}`);
    const matching = rows.filter((row) => pattern.test(rowText(row)));
    if (matching.length === 0 && !pattern.test(tableText)) {
      throw adapterError(`attribute table does not prove ${key}=${value}`);
    }
    const raw = matching.length > 0 ? rowText(matching[0]) : tableText;
    roleAttributes[key] = value;
    roleAttributeEvidence[key] = {
      source: "ozon-live-detail-attribute-table",
      label: matching[0]?.label || key,
      raw_value: raw,
      normalized_value: value,
    };
  }
  const bundleRisk = /набор|комплект|упаковк|лот|пара|(?:^|\s)(?:[2-9]|\d{2,})\s*(?:шт|штук|предмет)/iu
    .test(`${snapshot.title || ""}\n${tableText}`);
  if (bundleRisk) throw adapterError("attribute table or title indicates bundle/set risk");
  const itemRow = rows.find((row) => /количеств[оа]?\s*(?:предмет|товар|единиц|штук|шт)|число\s*предмет/iu.test(rowText(row))
    && /(?:^|\D)1(?:\D|$)/u.test(String(row.value)));
  const negativeCueRaw = `title=${snapshot.title || ""}; category=${breadcrumb}; attributes=${tableText}`;
  const itemEvidence = itemRow ? {
    source: "ozon-live-detail-attribute-table",
    raw_value: rowText(itemRow),
    normalized_value: 1,
  } : {
    source: "ozon-live-detail-negative-bundle-cue-audit",
    raw_value: negativeCueRaw,
    normalized_value: 1,
    title_checked: true,
    category_checked: true,
    attributes_checked: true,
    bundle_cue_count: 0,
  };
  return Object.freeze({
    category_key: target.category_key,
    item_count: 1,
    is_bundle: false,
    is_set: false,
    compatibility_scope: "generic",
    role_attributes: Object.freeze(roleAttributes),
    role_attribute_evidence: Object.freeze(roleAttributeEvidence),
    structured_evidence: Object.freeze({
      category: Object.freeze({
        source: "ozon-live-detail-breadcrumb",
        raw_value: breadcrumb,
        normalized_value: target.category_key,
      }),
      item_count: Object.freeze(itemEvidence),
      bundle: Object.freeze({
        source: itemEvidence.source,
        raw_value: itemEvidence.raw_value,
        is_bundle: false,
        is_set: false,
      }),
      compatibility: Object.freeze({
        source: "ozon-live-detail-attribute-table",
        raw_value: tableText,
        normalized_value: "generic",
      }),
    }),
  });
}

async function inspectLiveAttributeTable({ context, accessController, productUrl, activePages }) {
  const page = await context.newPage();
  activePages.add(page);
  let primaryError = null;
  try {
    return await accessController.run({ kind: "audited-seed-attribute-detail", url: productUrl }, async () => {
      const response = await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const status = typeof response?.status === "function" ? Number(response.status()) : null;
      if (status !== null && (status < 200 || status >= 400)) throw adapterError(`attribute detail returned HTTP ${status}`);
      const deadline = Date.now() + 15_000;
      let snapshot = null;
      do {
        snapshot = await page.evaluate(() => {
          const compact = (value) => String(value || "").replace(/\s+/gu, " ").trim();
          const pairs = [];
          const add = (label, value) => {
            const left = compact(label);
            const right = compact(value);
            if (left && right && left !== right && left.length <= 160 && right.length <= 500) {
              pairs.push({ label: left, value: right });
            }
          };
          for (const dt of document.querySelectorAll("dt")) add(dt.textContent, dt.nextElementSibling?.textContent);
          for (const row of document.querySelectorAll("tr")) {
            const cells = [...row.querySelectorAll(":scope > th, :scope > td")];
            if (cells.length >= 2) add(cells[0].textContent, cells.slice(1).map((cell) => cell.textContent).join(" "));
          }
          const roots = document.querySelectorAll('[data-widget*="character" i], [data-widget*="attribute" i], [data-widget*="spec" i]');
          for (const root of roots) {
            for (const row of root.querySelectorAll("li, div")) {
              const children = [...row.children].filter((child) => compact(child.textContent));
              if (children.length === 2 && children.every((child) => child.children.length <= 3)) {
                add(children[0].textContent, children[1].textContent);
              }
            }
          }
          const breadcrumb = [...document.querySelectorAll('nav a, [data-widget*="bread" i] a')]
            .map((element) => compact(element.textContent)).filter(Boolean).join(" > ");
          return {
            final_url: location.href,
            document_title: document.title,
            title: document.querySelector('meta[property="og:title"]')?.content || "",
            breadcrumb,
            attribute_rows: [...new Map(pairs.map((row) => [`${row.label}\0${row.value}`, row])).values()],
            body_sample: String(document.body?.innerText || "").slice(0, 1200),
          };
        });
        if (snapshot?.attribute_rows?.length > 0 && snapshot?.breadcrumb) break;
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      } while (Date.now() < deadline);
      if (snapshot?.final_url?.split(/[?#]/u)[0] !== productUrl.split(/[?#]/u)[0]) {
        throw adapterError("attribute detail redirected away from the exact product");
      }
      if (!snapshot?.attribute_rows?.length || !snapshot.breadcrumb) {
        throw adapterError("attribute detail did not expose breadcrumbs and a structured attribute table");
      }
      return snapshot;
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try { await page.close(); }
    catch (closeError) {
      if (primaryError) throw new AggregateError([primaryError, closeError], "attribute inspection and page cleanup both failed");
      throw closeError;
    } finally {
      activePages.delete(page);
    }
  }
}

export function createPinnedAuditedSeedPlaywrightAdapter({
  context,
  rateProvider,
  accessController,
  artifact,
  ...unsupported
} = {}) {
  if (Object.keys(unsupported).length > 0) {
    throw adapterError(`unsupported pinned adapter field(s): ${Object.keys(unsupported).sort().join(", ")}`);
  }
  if (!context || typeof context.newPage !== "function"
    || typeof rateProvider !== "function" || typeof accessController?.run !== "function"
    || !Array.isArray(artifact?.seeds)) {
    throw adapterError("owned context, live rate provider, access controller, and seed artifact are required");
  }
  const counters = {
    source_scan_requests: 0,
    live_detail_requests: 0,
    classification_requests: 0,
    favorite_mutation_attempts: 0,
    submission_attempts: 0,
  };
  const sourcePagePool = [];
  const activePages = new Set();
  const classificationCache = new Map();
  let closed = false;
  const liveDetail = createPlaywrightAuditedLiveDetailFetcher({
    context,
    ownedContext: true,
    apiRateProvider: rateProvider,
    navigationTimeoutMs: 30_000,
    observationTimeoutMs: 15_000,
  });
  const adapter = createAuditedSeedReadOnlyAdapter({
    ownedContext: true,
    mutationFirewallInstalled: true,
    scanSource: async (request) => {
      if (closed) throw adapterError("adapter is closed");
      counters.source_scan_requests += 1;
      const result = await scanSourceWithPage({
        context,
        url: request.source_url,
        options: {
          steps: 24,
          ratio: 0.82,
          delay: 650,
          initialWait: 8_000,
          maxNoNewSteps: 45,
          linkTarget: 72,
        },
        timeoutMs: 90_000,
        closeTimeoutMs: 5_000,
        pagePool: sourcePagePool,
        pageIndex: 0,
        accessController,
      });
      return normalizedScanResult(request, result, artifact);
    },
    fetchProductDetail: async (request) => {
      if (closed) throw adapterError("adapter is closed");
      counters.live_detail_requests += 1;
      const detail = await accessController.run(
        { kind: "audited-seed-live-detail", url: request.product_url },
        () => liveDetail({ sku: request.sku, href: request.product_url }),
      );
      const explicitCurrentSeller = ["webCurrentSeller", "current-seller-widget", "webSeller"]
        .includes(detail.seller_evidence_source);
      const seedStage = Array.isArray(request.seed_ids);
      const capacityStage = Array.isArray(request.target_ids);
      if (seedStage === capacityStage) {
        throw adapterError("live detail request must identify exactly one seed or capacity stage");
      }
      if (seedStage && !explicitCurrentSeller) {
        throw adapterError("live detail lacks an explicit current-seller widget binding");
      }
      if (capacityStage && detail.seller_url && !explicitCurrentSeller) {
        throw adapterError("capacity live detail seller is not bound to an explicit current-seller widget");
      }
      return Object.freeze({
        final_url: detail.final_url,
        seller_url: explicitCurrentSeller ? detail.seller_url : null,
        seller_evidence_source: explicitCurrentSeller ? AUDITED_LIVE_SELLER_EVIDENCE_SOURCE : null,
        seller_widget: explicitCurrentSeller ? detail.seller_evidence_source : null,
        title: detail.title,
        brand: detail.brand_evidence?.raw_brand,
        brand_extraction_complete: detail.brand_evidence?.complete === true,
        brand_evidence_source: AUDITED_LIVE_BRAND_EVIDENCE_SOURCE,
        observed_at: detail.observed_at,
        ...priceEvidenceFromDetail(detail),
      });
    },
    classifyProduct: async (request) => {
      if (closed) throw adapterError("adapter is closed");
      counters.classification_requests += 1;
      const target = request.seed || request.target;
      if (!target?.id) throw adapterError("classification target is missing");
      let pending = classificationCache.get(request.sku);
      if (!pending) {
        pending = inspectLiveAttributeTable({
          context,
          accessController,
          productUrl: request.product_url,
          activePages,
        });
        classificationCache.set(request.sku, pending);
      }
      return classifySnapshot(await pending, target);
    },
  });
  return Object.freeze({
    adapter,
    snapshot() { return Object.freeze({ ...counters, closed }); },
    async close() {
      if (closed) return Object.freeze({ closed: true, already_closed: true });
      const pages = [...new Set([...sourcePagePool, ...activePages].filter(Boolean))];
      const failures = [];
      for (const page of pages) {
        try { await page.close(); }
        catch (error) { failures.push(error); }
      }
      if (failures.length > 0) throw new AggregateError(failures, "pinned seed adapter page cleanup failed");
      sourcePagePool.length = 0;
      activePages.clear();
      classificationCache.clear();
      closed = true;
      return Object.freeze({ closed: true, page_count: pages.length });
    },
  });
}
