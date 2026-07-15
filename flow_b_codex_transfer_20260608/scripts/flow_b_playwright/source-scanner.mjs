import fs from "node:fs/promises";
import path from "node:path";
import { ensureMaoziLogin, ensureMaoziPluginLogin, openMaoziPage } from "./browser-context.mjs";
import { AdaptiveConcurrency } from "./continuous-runtime.mjs";
import { isPureFbs } from "./publish-policy.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_SOURCE_YIELD_HISTORY = path.resolve(import.meta.dirname, "../../data/flow_b/source_yield_history.jsonl");
const collectionRuntimeStates = new Map();

export function collectionRuntimeState(key) {
  const normalized = String(key || "default");
  if (!collectionRuntimeStates.has(normalized)) {
    collectionRuntimeStates.set(normalized, {
      nextApiAt: 0,
      nextDetailAt: 0,
      detailBlockedUntil: 0,
      detailSoftBlockStreak: 0,
      lastDetailSoftBlockAt: 0,
    });
  }
  return collectionRuntimeStates.get(normalized);
}

export function collectionDeadlineMs(env = process.env) {
  const value = Date.parse(String(env.FLOW_B_DEADLINE_AT || ""));
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

export function isCollectionDeadlineReached(env = process.env, now = Date.now()) {
  return Number(now) >= collectionDeadlineMs(env);
}

export async function withTimeout(operation, timeoutMs, label = "operation") {
  const timeout = Math.max(1, Number(timeoutMs) || 1);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForMovingDeadline({ getDeadline, now = () => Date.now(), sleep: wait = sleep }) {
  while (true) {
    const remaining = Number(getDeadline()) - Number(now());
    if (!(remaining > 0)) return;
    await wait(remaining);
  }
}

function envNumber(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export function retainedReplayLimit(env = process.env) {
  return Math.max(0, Math.floor(envNumber(env, "FLOW_B_MAX_RETAINED_LINKS", 12)));
}

async function waitForContent(page, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      ready: document.readyState,
      bodyLength: document.body?.innerText?.length || 0,
      products: document.querySelectorAll('a[href*="/product/"]').length,
    })).catch(() => ({}));
    if (state.ready === "complete" && (state.bodyLength > 1000 || state.products > 0)) return state;
    await sleep(700);
  }
  return null;
}

export function isFavoriteSessionAuthenticated({ hasToken, httpOk, code, pageText }) {
  return Boolean(hasToken)
    && Boolean(httpOk)
    && Number(code) === 1
    && !/登录|手机号|验证码|密码|login/i.test(String(pageText || ""));
}

export function requiresFavoriteSession(env = process.env) {
  return env.FLOW_B_MAOZI_AUTOFAVORITE !== "0";
}

export function canClaimFavorite({ total, inFlight, target }) {
  return Number(total) + Number(inFlight) < Number(target);
}

export function favoriteRetryDelay(error, attempt) {
  const message = String(error?.message || error || "");
  if (/HTTP 429|too many requests|rate.?limit/i.test(message)) {
    return Math.min(60_000, 15_000 * (2 ** Math.max(0, attempt)));
  }
  if (/failed to fetch|network|ECONN|ETIMEDOUT|timeout/i.test(message)) {
    return Math.min(15_000, 2_000 * (2 ** Math.max(0, attempt)));
  }
  return null;
}

export async function retryMaoziPageFetch(operation, {
  attempts = 5,
  sleep: wait = sleep,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < Math.max(1, Number(attempts) || 1); attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const delay = favoriteRetryDelay(error, attempt);
      if (delay === null || attempt + 1 >= attempts) throw error;
      await wait(delay);
    }
  }
  throw lastError;
}

export function isFavoriteCapacityReached(error) {
  return /收藏数量已达上限|favorite.*(?:limit|capacity)/i.test(String(error?.message || error || ""));
}

export function favoriteFailureDisposition(error) {
  const message = String(error?.message || error || "");
  if (/^non-pure-fbs:/i.test(message)) return { status: "rejected", reason: "non-pure-fbs" };
  if (/^missing-shipping-mode:/i.test(message)) return { status: "rejected", reason: "missing-shipping-mode" };
  if (/^source-price-above-limit:/i.test(message)) return { status: "rejected", reason: "source-price-above-limit" };
  if (/^oversized-low-yield-title:/i.test(message)) return { status: "rejected", reason: "oversized-low-yield-title" };
  return { status: "failed", reason: null };
}

export function favoritePriceSkipReason(productInfo, maxPrice = 1000) {
  const currency = String(productInfo?.price_info?.currency || "").toUpperCase();
  if (currency === "CNY" && Number(productInfo?.price_info?.sell_price) > Math.max(0, Number(maxPrice) || 0)) {
    return "source-price-above-limit";
  }
  return null;
}

export function favoriteTitleSkipReason(value) {
  const title = String(value || "");
  if (/зеркал|ванн(?:а|ы|ой|ую|е|у)|раковин|пианино|спортивн\w*\s+площад|турник.*брусь|(?:wall|bathroom)\s+mirror|bath\s*tub|digital\s+piano/i.test(title)) {
    return "oversized-low-yield-title";
  }
  return null;
}

export function effectiveFavoriteTotal({ claimedTotal, observedTotal, target }) {
  if (Number(claimedTotal) >= Number(target)) return Number(target);
  if (observedTotal === null || observedTotal === undefined || !Number.isFinite(Number(observedTotal))) {
    return Number(claimedTotal) || 0;
  }
  return Number(observedTotal);
}

export function favoriteModeSkipReason(mode) {
  if (!String(mode || "").trim()) return "missing-shipping-mode";
  return isPureFbs(mode) ? null : "non-pure-fbs";
}

export function isOzonSoftBlock(value) {
  return /похоже, нет(?:\s|\u00a0)+соединения|выключите VPN|incident:\s*[a-z0-9_]+/i.test(String(value || ""));
}

export function ozonRetryDelay(attempt) {
  return [600_000, 900_000, 1_800_000][Math.min(2, Math.max(0, Number(attempt) || 0))];
}

export function softBlockCooldownState({ streak = 0, lastBlockedAt = 0, now = Date.now(), coalesceWindowMs = 30_000 } = {}) {
  const sameIncident = Number(lastBlockedAt) > 0 && Number(now) - Number(lastBlockedAt) <= Number(coalesceWindowMs);
  const nextStreak = sameIncident ? Math.max(1, Number(streak) || 0) : Math.max(1, Number(streak) + 1);
  return {
    streak: nextStreak,
    lastBlockedAt: Number(now),
    delay: ozonRetryDelay(nextStreak - 1),
  };
}

export function sourceBatchCooldownState(rows, state, now = Date.now()) {
  const blocked = (rows || []).some((row) => row?.blocked || isOzonSoftBlock(`${row?.title || ""} ${row?.stop_reason || ""}`));
  if (!blocked) {
    state.detailSoftBlockStreak = 0;
    state.lastDetailSoftBlockAt = 0;
    return { blocked: false, delay: 0 };
  }
  const cooldown = softBlockCooldownState({
    streak: state.detailSoftBlockStreak,
    lastBlockedAt: state.lastDetailSoftBlockAt,
    now,
  });
  state.detailSoftBlockStreak = cooldown.streak;
  state.lastDetailSoftBlockAt = cooldown.lastBlockedAt;
  state.detailBlockedUntil = Math.max(Number(state.detailBlockedUntil) || 0, Number(now) + cooldown.delay);
  return { blocked: true, delay: cooldown.delay };
}

export function ozonDetailFailurePolicy(error, attempt, retries) {
  const message = String(error?.message || error || "");
  const softBlocked = /Ozon detail soft blocked|net::ERR_(?:FAILED|CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT).*ozon\.ru/i.test(message);
  return {
    softBlocked,
    retry: softBlocked && Number(attempt) < Number(retries),
    delay: softBlocked ? ozonRetryDelay(attempt) : 0,
  };
}

export function productTitleFamily(value) {
  const text = String(value || "");
  if (/для\s+(?:кош(?:ек|ки)?|собак(?:и)?|питомц)|домашн\w*\s+(?:животн|питомц)|pet\s+(?:hat|cap)/i.test(text)) return "pet";
  if (/водн\w*\s+(?:игров\w*\s+)?стол|стол\w*.*(?:игр\w*\s+)?с\s+вод|стол\w*.*водн/i.test(text)) return "bulky_kids";
  if (/(?:plants?\s*vs\.?\s*zombie|растени[яй]\s+против\s+зомби|зомби\s+против\s+растени|pvz).*(?:transform|трансформ)|(?:transform|трансформ).*(?:plants?\s*vs\.?\s*zombie|растени[яй]\s+против\s+зомби|pvz)/i.test(text)) return "pvz_transformer";
  if (/чехол|ремеш(?:ок|к)?/i.test(text)) return "case_strap";
  if (/человек[- ]?паук|spider[- ]?man|супергер|мстител|marvel/i.test(text)) return "superhero";
  if (/трус|нижн(?:ее|его|ем)?\s+бель|бюст|лифчик/i.test(text)) return "underwear";
  if (/мягк(?:ая|ие|ой)?\s+(?:плюшев|игруш)|плюшев|спрунк|sprunki/i.test(text)) return "plush";
  if (/аккумулятор|батаре[яй]|электроинструмент|power\s*tool/i.test(text)) return "electronics";
  if (/конструктор|building\s*blocks?|блочн(?:ая|ый)|moc\b/i.test(text)) return "building";
  if (/носк/i.test(text)) return "socks";
  if (/фигурк|funko|статуэт/i.test(text)) return "figure";
  if (/браслет|кулон|колье|подвеск|брош|pandora/i.test(text)) return "jewelry";
  if (/шляп|панам|кепк|козыр|докер|косынк|головн.*убор/i.test(text)) return "headwear";
  if (/перчат|заколк|резинк|брелок|наклейк|ободок|ключниц/i.test(text)) return "accessory";
  if (/кукл|игруш/i.test(text)) return "toy";
  return "other";
}

export function productTitlePriority(value) {
  return {
    socks: 700,
    underwear: 650,
    headwear: 575,
    building: 525,
    other: 400,
    plush: 350,
    case_strap: 340,
    figure: 325,
    accessory: 300,
    toy: 250,
    electronics: 100,
    bulky_kids: 75,
    pet: 50,
    superhero: 0,
    pvz_transformer: 0,
    jewelry: 0,
  }[productTitleFamily(value)] ?? 0;
}

export function createScannerLogger(log = console.log, level = "summary") {
  if (String(level).toLowerCase() === "verbose") return log;
  return (message) => {
    const text = String(message || "").split(/\r?\n/, 1)[0].slice(0, 300);
    if (/^favorite\s+0\s+->\s+0\s+delta=0$/i.test(text)) return;
    if (/^(?:favorite exclusions loaded:|favorite count telemetry unavailable|favorite SKU telemetry unavailable|collecting favorites from|batch \d|source soft block cooldown|favorite collection summary|favorite capacity reached|favorite \S+ ->)/i.test(text)) log(text);
  };
}

function favoriteLinkPriority(link) {
  const provenSeller = isProvenSellerSource(link?.source_url);
  const cardText = String(link?.card_text || "");
  const pluginPureFbs = /(?:^|\n)\s*发货模式\s*[：:]\s*FBS\s*(?:\n|$)/i.test(cardText);
  const explicitGlobal = /доставка\s+из\s+(?:китая|за\s+рубежа)|cross.?border|ozon\s+global/i.test(cardText);
  const cardPriceMatch = cardText.match(/(\d+(?:[.,]\d+)?)\s*¥/);
  const cardPrice = Number(String(cardPriceMatch?.[1] || "").replace(",", "."));
  const pricePriority = Number.isFinite(cardPrice) && cardPrice > 0
    ? (cardPrice < 15 ? -700 : cardPrice < 20 ? -400 : cardPrice >= 25 ? 75 : 0)
    : 0;
  return (pluginPureFbs ? 2000 : 0) + (provenSeller ? 1000 : 0) + (explicitGlobal ? 800 : 0) + productTitlePriority(link?.text) + pricePriority;
}

export function isProvenSellerSource(value) {
  return /\/seller\/(?:nuanniu|miaowu|yishao|alisa-3673390|vash-vybor-3332584|xiangyu01|kshunby|xzx-a02|fabrika-ulichnogo-stilya|linkworld-2709304|dretd)(?:[/?]|$)/i.test(String(value || ""));
}

function sourceUrlPriority(value) {
  const raw = String(value || "");
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch {}
  const proven = isProvenSellerSource(raw) ? 1000 : 0;
  const global = /(?:ozon-global|tovary-iz-kitaya|tovary-so-vsego-mira|is_global=true)/i.test(decoded) ? 500 : 0;
  const targetFamily = /(?:детск|detsk|ребен|odezhd|aksess|accessor|одежд|обув|трус|кепк|панам|носк|заколк|брелок|ремешок|бижутер)/i.test(decoded) ? 250 : 0;
  return proven + global + targetFamily;
}

function sourceUrlKey(value) {
  try {
    const url = new URL(String(value));
    url.searchParams.delete("sorting");
    url.searchParams.delete("currency_price");
    return url.toString();
  } catch {
    return String(value || "")
      .replace(/([?&])(?:sorting|currency_price)=[^&]*&?/gi, "$1")
      .replace(/[?&]$/, "");
  }
}

export function expandHighYieldSourceUrls(urls, yieldRows = []) {
  const expanded = [...urls];
  const seen = new Set(expanded);
  const successful = [...new Set(yieldRows
    .filter((row) => row?.status === "published" && /^https?:\/\//i.test(String(row?.source_url || "")))
    .map((row) => String(row.source_url)))];
  for (const source of successful) {
    let parsed;
    try { parsed = new URL(source); } catch { continue; }
    const existingBand = parsed.searchParams.get("currency_price");
    const bands = [...new Set([existingBand, "50.000;", "120.000;", "150.000;", "500.000;"].filter(Boolean))];
    for (const band of bands) {
      for (const sorting of [null, "rating", "price", "discount"]) {
        const url = new URL(source);
        url.searchParams.set("currency_price", band);
        if (sorting) url.searchParams.set("sorting", sorting);
        else url.searchParams.delete("sorting");
        const value = url.toString();
        if (seen.has(value)) continue;
        seen.add(value);
        expanded.push(value);
      }
    }
  }
  return expanded;
}

export function classifyFreshSourceUrls(urls = []) {
  const verifiedSellerUrls = [];
  const explorationUrls = [];
  for (const url of urls) {
    if (canonicalSellerUrl(url)) verifiedSellerUrls.push(url);
    else explorationUrls.push(url);
  }
  return { verifiedSellerUrls, explorationUrls };
}

export function expandFreshSellerSourceUrls(urls = []) {
  const expanded = [...urls];
  const seen = new Set(expanded);
  for (const source of urls) {
    if (!canonicalSellerUrl(source)) continue;
    for (const band of ["50.000;", "120.000;", "150.000;", "500.000;"]) {
      for (const sorting of ["rating", "discount"]) {
        const url = new URL(source);
        url.searchParams.set("currency_price", band);
        url.searchParams.set("sorting", sorting);
        const value = url.toString();
        if (seen.has(value)) continue;
        seen.add(value);
        expanded.push(value);
      }
    }
  }
  return expanded;
}

export function deriveSearchSourceUrls(yieldRows, limit = 200) {
  const stopWords = new Set([
    "для", "или", "при", "это", "этот", "эта", "эти", "шт", "штук", "цвет", "размер",
    "женский", "женская", "женские", "мужской", "мужская", "детский", "детская", "детские",
  ]);
  const queries = [];
  const seen = new Set();
  const maximum = Math.max(0, Number(limit) || 0);
  if (maximum === 0) return queries;
  for (const row of [...(yieldRows || [])].reverse()) {
    if (row?.status !== "published") continue;
    const words = String(row?.title || "").toLowerCase().match(/[а-яё]{4,}/gi) || [];
    const terms = words.filter((word) => !stopWords.has(word)).slice(0, 5);
    if (terms.length < 2) continue;
    const candidates = [
      terms.slice(0, 3),
      terms.slice(0, 2),
      terms.slice(1, 3),
      terms.slice(0, 4),
      terms.slice(1, 4),
    ];
    for (const candidate of candidates) {
      if (candidate.length < 2) continue;
      const query = candidate.join(" ");
      if (seen.has(query)) continue;
      seen.add(query);
      const url = new URL("https://www.ozon.ru/search/");
      url.searchParams.set("text", query);
      url.searchParams.set("is_global", "true");
      url.searchParams.set("currency_price", "150.000;");
      queries.push(url.toString());
      if (queries.length >= maximum) return queries;
    }
  }
  return queries;
}

function canonicalSellerUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const match = url.pathname.match(/^(\/seller\/[^/]+\/)/i);
    return match ? `${url.origin}${match[1]}` : null;
  } catch {
    return null;
  }
}

export function verifiedSellerSourceUrls(yieldRows) {
  const sellers = new Map();
  for (const row of yieldRows || []) {
    if (String(row?.status || "") !== "published") continue;
    const url = canonicalSellerUrl(row?.seller_url) || canonicalSellerUrl(row?.source_url);
    const sku = String(row?.sku || "").trim();
    if (!url || !sku) continue;
    const skus = sellers.get(url) || new Set();
    skus.add(sku);
    sellers.set(url, skus);
  }
  return [...sellers].filter(([, skus]) => skus.size >= 2).map(([url]) => url);
}

function fullFunnelSourceScores(rows) {
  const sources = new Map();
  const outcomeRank = { favorited: 1, rejected: 2, skipped: 2, published: 3 };
  for (const row of rows || []) {
    const key = sourceUrlKey(row?.source_url);
    const sku = String(row?.sku || "").trim();
    const rank = outcomeRank[row?.status] || 0;
    if (!key || !sku || !rank) continue;
    const outcomes = sources.get(key) || new Map();
    outcomes.set(sku, Math.max(outcomes.get(sku) || 0, rank));
    sources.set(key, outcomes);
  }
  return new Map([...sources].map(([key, outcomes]) => {
    const attempted = outcomes.size;
    const published = [...outcomes.values()].filter((rank) => rank === outcomeRank.published).length;
    const pureFbs = [...outcomes.values()].filter((rank) => rank === outcomeRank.favorited).length;
    const qualifiedYield = published + pureFbs * 0.35;
    const score = ((qualifiedYield + 0.5) / (attempted + 5)) * 100_000
      + Math.log1p(published) * 1000
      + Math.log1p(pureFbs) * 100;
    return [key, score];
  }));
}

export function prioritizeSourceUrls(urls, {
  highYieldSources = [],
  yieldRows = [],
  freshSourceUrls = [],
  verifiedFreshSourceUrls = [],
} = {}) {
  const successfulCounts = new Map();
  for (const source of highYieldSources) {
    const key = sourceUrlKey(source);
    successfulCounts.set(key, (successfulCounts.get(key) || 0) + 1);
  }
  const funnelScores = fullFunnelSourceScores(yieldRows);
  const freshKeys = new Set(freshSourceUrls.map(sourceUrlKey));
  const verifiedFreshKeys = new Set(verifiedFreshSourceUrls.map(sourceUrlKey));
  const groups = new Map();
  [...urls].forEach((url, index) => {
    const key = sourceUrlKey(url);
    const yieldPriority = funnelScores.has(key) ? funnelScores.get(key) : (successfulCounts.get(key) || 0) * 2000;
    const tier = verifiedFreshKeys.has(key) ? 2 : freshKeys.has(key) ? 1 : 0;
    const priority = sourceUrlPriority(url) + yieldPriority
      + (freshKeys.has(key) ? 200_000 : 0)
      + (verifiedFreshKeys.has(key) ? 400_000 : 0);
    const group = groups.get(key) || { index, priority, tier, urls: [] };
    group.priority = Math.max(group.priority, priority);
    group.tier = Math.max(group.tier, tier);
    group.urls.push(url);
    groups.set(key, group);
  });
  const ordered = [];
  for (const tier of [2, 1, 0]) {
    const ranked = [...groups.values()]
      .filter((group) => group.tier === tier)
      .sort((left, right) => right.priority - left.priority || left.index - right.index);
    const rounds = Math.max(0, ...ranked.map((group) => group.urls.length));
    const burst = 2;
    for (let round = 0; round < rounds; round += burst) {
      for (const group of ranked) {
        for (let offset = 0; offset < burst; offset += 1) {
          if (group.urls[round + offset]) ordered.push(group.urls[round + offset]);
        }
      }
    }
  }
  return ordered;
}

export function retainedRowsForCollection(records, {
  skipRetained = false,
  provenOnly = false,
  highYieldSources = [],
} = {}) {
  const successfulKeys = new Set(highYieldSources.map(sourceUrlKey));
  return (records || []).filter((row) => {
    if (provenOnly && !isProvenSellerSource(row?.source_url)) return false;
    if (skipRetained && !successfulKeys.has(sourceUrlKey(row?.source_url))) return false;
    return true;
  });
}

export function orderRowsBySourceYield(rows, yieldRows = []) {
  const stats = new Map();
  for (const row of yieldRows) {
    const key = sourceUrlKey(row?.source_url);
    if (!key || row?.status === "ignored") continue;
    const value = stats.get(key) || { attempted: 0, published: 0, outcomeWeight: 0 };
    value.attempted += 1;
    if (row?.status === "published") {
      value.published += 1;
      value.outcomeWeight += 3;
    } else if (row?.status === "favorited") {
      value.outcomeWeight += 0.5;
    }
    stats.set(key, value);
  }
  return [...(rows || [])].map((row, index) => {
    const value = stats.get(sourceUrlKey(row?.source_url)) || { attempted: 0, published: 0, outcomeWeight: 0 };
    return {
      row,
      index,
      published: value.published,
      score: (value.outcomeWeight + 0.5) / (value.attempted + 2),
      priceFloor: (() => {
        try { return Number.parseFloat(new URL(row?.source_url).searchParams.get("currency_price")) || 0; }
        catch { return 0; }
      })(),
    };
  }).sort((left, right) => right.score - left.score
    || right.published - left.published
    || right.priceFloor - left.priceFloor
    || left.index - right.index)
    .map(({ row }) => row);
}

export function shouldYieldAfterRetained({ retainedLinks, pendingSources }) {
  return Number(retainedLinks) > 0 && Number(pendingSources) > 0;
}

export function prioritizeFavoriteLinks(links) {
  return [...links]
    .map((link, index) => ({ link, index, priority: favoriteLinkPriority(link) }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
    .map(({ link }) => link);
}

function deduplicateTitleVariants(links) {
  const seen = new Set();
  return (links || []).filter((link) => {
    const signature = String(link?.text || "").toLowerCase()
      .replace(/[^a-zа-яё]+/gi, " ")
      .trim()
      .split(/\s+/)
      .filter((word) => word.length >= 3)
      .slice(0, 12)
      .join(" ") || String(link?.href || "");
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

export function limitLinksPerSource(rows, limit = 24) {
  const maximum = Math.max(1, Number(limit) || 24);
  const perSource = rows.map((row) => deduplicateTitleVariants(prioritizeFavoriteLinks((row?.links || []).map((link) => ({
    ...link,
    source_url: row.source_url,
  })))).slice(0, maximum));
  const combined = [];
  for (let index = 0; index < maximum; index += 1) {
    const sourceRound = [];
    for (const links of perSource) if (links[index]) sourceRound.push(links[index]);
    combined.push(...prioritizeFavoriteLinks(sourceRound));
  }
  return combined;
}

export function terminalSkusFromJsonl(text) {
  const latest = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      const sku = String(event?.sku ?? "").trim();
      if (sku) latest.set(sku, String(event?.status || ""));
    } catch {}
  }
  return new Set([...latest].filter(([, status]) => status === "skipped" || status === "published").map(([sku]) => sku));
}

export function excludedSkusFromHistories({ stateTexts = [], favoriteTexts = [] } = {}) {
  const excluded = new Set();
  for (const text of stateTexts) {
    for (const sku of terminalSkusFromJsonl(text)) excluded.add(sku);
  }
  for (const text of favoriteTexts) {
    for (const line of String(text || "").split(/\r?\n/)) {
      try {
        const event = JSON.parse(line);
        const deterministicMissingMode = event?.status === "failed" && /^missing-shipping-mode:/i.test(String(event?.error || ""));
        const needsCurrencyRecheck = event?.status === "rejected" && event?.reason === "non-cny-sale-price";
        if (((event?.status === "rejected" && !needsCurrencyRecheck) || deterministicMissingMode) && event?.sku) {
          excluded.add(String(event.sku));
        }
      } catch {}
    }
  }
  return excluded;
}

async function loadExcludedSkus(outputPath, env) {
  const stateFiles = [
    path.join(path.dirname(outputPath), "sku_states.jsonl"),
    ...String(env.FLOW_B_STATE_SEED_FILES || "").split(path.delimiter).filter(Boolean),
  ];
  const favoriteFiles = [
    path.join(path.dirname(outputPath), "favorite_collection.jsonl"),
    ...String(env.FLOW_B_FAVORITE_SEED_FILES || "").split(path.delimiter).filter(Boolean),
  ];
  const readHistories = async (filenames) => {
    const texts = [];
    for (const filename of [...new Set(filenames.map((value) => path.resolve(value)))]) {
      try { texts.push(await fs.readFile(filename, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return texts;
  };
  const excluded = excludedSkusFromHistories({
    stateTexts: await readHistories(stateFiles),
    favoriteTexts: await readHistories(favoriteFiles),
  });
  if (env.FLOW_B_EXCLUDED_SKUS) {
    for (const sku of String(env.FLOW_B_EXCLUDED_SKUS).split(/[,\s]+/).filter(Boolean)) excluded.add(sku);
  }
  const publishedCsv = path.resolve(env.FLOW_B_PUBLISHED_CSV || path.join(import.meta.dirname, "../../data/flow_b/published_links.csv"));
  try {
    const csvText = await fs.readFile(publishedCsv, "utf8");
    for (const line of csvText.split(/\r?\n/)) {
      const sku = skuFromProductUrl(line);
      if (sku) excluded.add(sku);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return excluded;
}

function skuFromProductUrl(value) {
  return String(value || "").match(/\/product\/(?:[^/?#]*-)?(\d+)(?:[/?#]|$)/)?.[1] || "";
}

export function parseFavoriteProductSnapshot({ url, title, ogTitle, ogImage, priceText, sellerUrl }) {
  const sku = skuFromProductUrl(url);
  if (!sku) throw new Error("Ozon product SKU is missing");
  const coverImage = String(ogImage || "").trim();
  if (!coverImage) throw new Error(`Ozon cover image is missing for SKU ${sku}`);
  const source = String(priceText || "");
  const rawPrice = source.match(/[0-9][0-9\s\u00a0\u2009\u202f]*(?:[,.][0-9]+)?/)?.[0] || "";
  const sellPrice = Number(rawPrice.replace(/[\s\u00a0\u2009\u202f]/g, "").replace(",", "."));
  if (!Number.isFinite(sellPrice) || sellPrice <= 0) throw new Error(`Ozon sell price is missing for SKU ${sku}`);
  const currency = source.includes("¥") ? "CNY" : source.includes("₸") ? "KZT" : "RUB";
  const productTitle = String(ogTitle || title || "")
    .replace(/\s+купить на OZON.*$/i, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .trim();
  if (!productTitle) throw new Error(`Ozon title is missing for SKU ${sku}`);
  return {
    sku,
    coverImage,
    price_info: { sell_price: sellPrice, currency },
    title: productTitle,
    seller_url: canonicalSellerUrl(sellerUrl),
  };
}

async function favoriteCount(page) {
  const result = await retryMaoziPageFetch(() => page.evaluate(async () => {
    let token = "";
    try { token = JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || ""; } catch {}
    const headers = { "Accept-Language": "zh-CN", Client: "pc" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch("https://api.maozierp.com/api.product.favorite/lists?page=1&page_size=1&is_imported=0", { headers });
    const body = await response.json();
    return {
      total: Number(body?.data?.total || 0),
      hasToken: Boolean(token),
      httpOk: response.ok,
      code: body?.code,
      pageText: (document.body?.innerText || "").slice(0, 1000),
    };
  }));
  return { total: result.total, authenticated: isFavoriteSessionAuthenticated(result) };
}

async function favoriteSkus(page) {
  return retryMaoziPageFetch(() => page.evaluate(async () => {
    let token = "";
    try { token = JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || ""; } catch {}
    const headers = { "Accept-Language": "zh-CN", Client: "pc" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch("https://api.maozierp.com/api.product.favorite/skus", { headers });
    const body = await response.json();
    if (!response.ok || Number(body?.code) !== 1 || !Array.isArray(body?.data)) {
      throw new Error(body?.msg || "Unable to load Maozi favorite SKUs");
    }
    return body.data.map(String);
  }));
}

async function favoriteProduct(page, productInfo) {
  return page.evaluate(async (payload) => {
    let token = "";
    try { token = JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || ""; } catch {}
    const headers = { "Accept-Language": "zh-CN", Client: "pc", "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch("https://api.maozierp.com/api.product.favorite/toggle", {
      method: "POST",
      headers,
      body: JSON.stringify({ productInfo: payload, status: true }),
    });
    const body = await response.json();
    if (!response.ok || Number(body?.code) !== 1) throw new Error(body?.msg || `HTTP ${response.status}`);
    return body;
  }, productInfo);
}

async function extractFavoriteProduct(page, url, timeout) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(10_000, Math.min(30_000, timeout * 2)) });
  const deadline = Date.now() + timeout;
  let snapshot;
  do {
    snapshot = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      ogTitle: document.querySelector('meta[property="og:title"]')?.content || "",
      ogImage: document.querySelector('meta[property="og:image"]')?.content || "",
      priceText: document.querySelector('div[data-widget="webPrice"]')?.innerText || "",
      sellerUrl: document.querySelector('[data-widget="webCurrentSeller"] a[href*="/seller/"], [data-widget*="CurrentSeller"] a[href*="/seller/"], [data-widget="webSeller"] a[href*="/seller/"]')?.href
        || document.querySelector('a[href*="/seller/"]')?.href || "",
      mode: (document.body?.innerText || "").match(/发货模式：\s*([^\n]+)/)?.[1]?.trim() || "",
      pageText: (document.body?.innerText || "").slice(0, 1000),
    })).catch(() => null);
    if (isOzonSoftBlock(`${snapshot?.title || ""} ${snapshot?.pageText || ""}`)) {
      throw new Error(`Ozon detail soft blocked: ${url}`);
    }
    if (/доступ ограничен|access denied|captcha/i.test(`${snapshot?.title || ""} ${snapshot?.pageText || ""}`)) {
      throw new Error(`Ozon detail is blocked: ${url}`);
    }
    if (snapshot?.ogImage && snapshot?.priceText && snapshot?.mode) break;
    if (Date.now() >= deadline) break;
    await sleep(500);
  } while (true);
  const modeReason = favoriteModeSkipReason(snapshot?.mode);
  if (modeReason) throw new Error(`${modeReason}: SKU ${skuFromProductUrl(snapshot?.url || url)}`);
  return parseFavoriteProductSnapshot(snapshot || { url });
}

async function collectFavorites({ context, maozi, links, target, currentTotal, env, attempted, logFile, log, onResult = () => {} }) {
  if (currentTotal >= target || !links.length || isCollectionDeadlineReached(env)) return currentTotal;
  let existing = new Set();
  try {
    existing = new Set(await favoriteSkus(maozi));
  } catch (error) {
    onResult({ status: "failed", error });
    log(`favorite SKU telemetry unavailable; continuing with run-local deduplication: ${error?.message || error}`);
  }
  const queue = [];
  for (const link of prioritizeFavoriteLinks(links)) {
    const href = typeof link === "string" ? link : link?.href;
    const sku = skuFromProductUrl(href);
    if (!sku || existing.has(sku) || attempted.has(sku)) continue;
    attempted.add(sku);
    queue.push({ sku, href, source_url: typeof link === "object" ? link?.source_url : null });
  }
  const workerCount = Math.max(1, envNumber(env, "FLOW_B_FAVORITE_WORKERS", envNumber(env, "FLOW_B_TAB_WORKERS", 4)));
  const timeout = envNumber(env, "FLOW_B_FAVORITE_DETAIL_TIMEOUT", 15000);
  let cursor = 0;
  let total = currentTotal;
  const collection = { attempted: 0, favorited: 0, rejected: 0, failed: 0 };
  let inFlight = 0;
  const runtime = collectionRuntimeState(path.resolve(logFile));
  const acceptanceDeadline = collectionDeadlineMs(env);
  let apiChain = Promise.resolve();
  let detailGate = Promise.resolve();
  const apiInterval = Math.max(0, envNumber(env, "FLOW_B_FAVORITE_API_INTERVAL_MS", 750));
  const maxRetries = Math.max(0, envNumber(env, "FLOW_B_FAVORITE_API_RETRIES", 5));
  const detailInterval = Math.max(0, envNumber(env, "FLOW_B_FAVORITE_DETAIL_INTERVAL_MS", 1500));
  const detailRetries = Math.max(0, envNumber(env, "FLOW_B_FAVORITE_DETAIL_RETRIES", 3));
  const reserveDetailSlot = () => {
    const operation = detailGate.then(async () => {
      await waitForMovingDeadline({ getDeadline: () => Math.min(Math.max(runtime.nextDetailAt, runtime.detailBlockedUntil), acceptanceDeadline) });
      if (isCollectionDeadlineReached(env)) {
        const error = new Error("collection deadline reached");
        error.code = "FLOW_B_DEADLINE_REACHED";
        throw error;
      }
      runtime.nextDetailAt = Date.now() + detailInterval;
    });
    detailGate = operation.catch(() => {});
    return operation;
  };
  const loadProduct = async (page, item) => {
    for (let attempt = 0; ; attempt += 1) {
      await reserveDetailSlot();
      try {
        const result = await extractFavoriteProduct(page, item.href, timeout);
        runtime.detailSoftBlockStreak = 0;
        runtime.lastDetailSoftBlockAt = 0;
        return result;
      } catch (error) {
        const policy = ozonDetailFailurePolicy(error, attempt, detailRetries);
        if (!policy.softBlocked) throw error;
        const cooldownState = softBlockCooldownState({
          streak: runtime.detailSoftBlockStreak,
          lastBlockedAt: runtime.lastDetailSoftBlockAt,
        });
        const cooldown = cooldownState.delay;
        runtime.detailSoftBlockStreak = cooldownState.streak;
        runtime.lastDetailSoftBlockAt = cooldownState.lastBlockedAt;
        runtime.detailBlockedUntil = Math.max(runtime.detailBlockedUntil, Date.now() + cooldown);
        if (!policy.retry) throw error;
        log(`Ozon detail retry SKU ${item.sku} attempt=${attempt + 1} wait=${cooldown}ms`);
      }
    }
  };
  const callFavorite = (productInfo) => {
    const operation = apiChain.then(async () => {
      for (let attempt = 0; ; attempt += 1) {
        if (isCollectionDeadlineReached(env)) {
          const error = new Error("collection deadline reached");
          error.code = "FLOW_B_DEADLINE_REACHED";
          throw error;
        }
        const gateWait = Math.max(0, runtime.nextApiAt - Date.now());
        if (gateWait) await sleep(Math.min(gateWait, Math.max(0, acceptanceDeadline - Date.now())));
        try {
          const result = await favoriteProduct(maozi, productInfo);
          runtime.nextApiAt = Date.now() + apiInterval;
          return result;
        } catch (error) {
          runtime.nextApiAt = Date.now() + apiInterval;
          const retryDelay = favoriteRetryDelay(error, attempt);
          if (retryDelay === null || attempt >= maxRetries) throw error;
          log(`favorite API retry SKU ${productInfo.sku} attempt=${attempt + 1} wait=${retryDelay}ms: ${error?.message || error}`);
          await sleep(Math.min(retryDelay, Math.max(0, acceptanceDeadline - Date.now())));
        }
      }
    });
    apiChain = operation.catch(() => {});
    return operation;
  };
  let writeChain = Promise.resolve();
  const record = (row) => {
    writeChain = writeChain.then(() => fs.appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`));
    return writeChain;
  };
  const workers = Array.from({ length: Math.min(workerCount, queue.length) }, async () => {
    const page = await context.newPage();
    try {
      while (canClaimFavorite({ total, inFlight, target }) && !isCollectionDeadlineReached(env)) {
        const item = queue[cursor++];
        if (!item) break;
        collection.attempted += 1;
        inFlight += 1;
        try {
          const titleReason = favoriteTitleSkipReason(item.text);
          if (titleReason) throw new Error(`${titleReason}: SKU ${item.sku}`);
          const productInfo = await loadProduct(page, item);
          const detailTitleReason = favoriteTitleSkipReason(productInfo.title);
          if (detailTitleReason) throw new Error(`${detailTitleReason}: SKU ${item.sku}`);
          const priceReason = favoritePriceSkipReason(productInfo, envNumber(env, "FLOW_B_MAX_SOURCE_PRICE_CNY", 1000));
          if (priceReason) throw new Error(`${priceReason}: SKU ${item.sku}`);
          const favoritePayload = { ...productInfo };
          delete favoritePayload.seller_url;
          await callFavorite(favoritePayload);
          existing.add(productInfo.sku);
          total += 1;
          const observedTotal = total;
          await record({
            status: "favorited",
            preflight_mode: "FBS",
            shipping_mode: "FBS",
            sku: productInfo.sku,
            url: item.href,
            source_url_product: item.href,
            source_url: item.source_url || null,
            seller_url: productInfo.seller_url || null,
            sale_price: productInfo.price_info?.sell_price ?? null,
            source_currency: productInfo.price_info?.currency ?? null,
            title: productInfo.title,
            cover_image: productInfo.coverImage,
            total: observedTotal,
          });
          onResult({ status: "favorited", sku: productInfo.sku });
          collection.favorited += 1;
          log(`favorite SKU ${productInfo.sku} total=${observedTotal}/${target}`);
        } catch (error) {
          if (error?.code === "FLOW_B_DEADLINE_REACHED") {
            break;
          } else if (isFavoriteCapacityReached(error)) {
            total = target;
            await record({ status: "capacity_reached", sku: item.sku, url: item.href, source_url: item.source_url || null, message: String(error?.message || error) });
            onResult({ status: "capacity_reached", sku: item.sku });
            log(`favorite capacity reached; ending collection at configured target ${target}`);
          } else if (favoriteFailureDisposition(error).status === "rejected") {
            const { reason } = favoriteFailureDisposition(error);
            await record({ status: "rejected", reason, sku: item.sku, url: item.href, source_url: item.source_url || null });
            onResult({ status: "rejected", reason, sku: item.sku });
            collection.rejected += 1;
            log(`favorite rejected SKU ${item.sku}: ${reason}`);
          } else {
            await record({ status: "failed", sku: item.sku, url: item.href, source_url: item.source_url || null, error: String(error?.message || error) });
            onResult({ status: "failed", sku: item.sku, error });
            collection.failed += 1;
            log(`favorite failed SKU ${item.sku}: ${error?.message || error}`);
          }
        } finally {
          inFlight -= 1;
        }
      }
    } finally {
      await page.close().catch(() => {});
    }
  });
  await Promise.all(workers);
  await writeChain;
  log(`favorite collection summary attempted=${collection.attempted} favorited=${collection.favorited} rejected=${collection.rejected} failed=${collection.failed}`);
  return total;
}

async function scanOne(page, url, { steps, ratio, delay, initialWait, maxNoNewSteps }) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForContent(page, 20000);
  await sleep(initialWait);
  await page.evaluate(() => window.scrollTo(0, 0));
  const links = new Map();
  let stable = 0;
  let noNew = 0;
  let lastHeight = 0;
  let lastY = -1;
  let lastLinkCount = 0;
  let title = "";
  let finalUrl = url;
  let blocked = false;
  let stopReason = "max_steps";
  const started = Date.now();

  for (let step = 0; step < steps; step += 1) {
    const state = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return {
        url: location.href,
        title: document.title,
        y: Math.round(scrollY),
        height: document.body?.scrollHeight || 0,
        viewport: innerHeight,
        text: text.slice(0, 900),
        links: [...document.querySelectorAll('a[href*="/product/"]')].map((anchor) => ({
          href: String(anchor.href || "").split("?")[0],
          text: String(anchor.innerText || anchor.title || "").trim().slice(0, 120),
          card_text: String(anchor.closest('div[data-index]')?.innerText || "").trim().slice(0, 500),
        })),
      };
    });
    title = state.title;
    finalUrl = state.url;
    blocked = /доступ ограничен|access denied|captcha|похоже, нет/i.test(`${title} ${state.text}`);
    for (const link of state.links) {
      if (!link.href.includes("/product/")) continue;
      const prior = links.get(link.href) || {};
      links.set(link.href, {
        text: link.text || prior.text || "",
        card_text: link.card_text || prior.card_text || "",
      });
    }
    if (blocked) { stopReason = "blocked_or_empty"; break; }
    const nearBottom = state.y + state.viewport >= state.height - 100;
    stable = links.size === lastLinkCount && nearBottom && Math.abs(state.y - lastY) < 20 && Math.abs(state.height - lastHeight) < 20 ? stable + 1 : 0;
    noNew = links.size === lastLinkCount ? noNew + 1 : 0;
    lastLinkCount = links.size;
    lastY = state.y;
    lastHeight = state.height;
    if (stable >= 8) { stopReason = "stable_bottom"; break; }
    if (noNew >= maxNoNewSteps && nearBottom) { stopReason = "no_new_links_near_bottom"; break; }
    await page.evaluate((scrollRatio) => window.scrollBy(0, Math.max(350, Math.floor(innerHeight * scrollRatio))), ratio);
    await sleep(delay);
  }
  return {
    final_url: finalUrl,
    title,
    blocked,
    stop_reason: stopReason,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    cumulative_product_link_count: links.size,
    links: [...links].sort(([left], [right]) => left.localeCompare(right)).map(([href, meta]) => ({ href, ...meta })),
  };
}

export async function scanSourceWithPage({
  context,
  url,
  options,
  timeoutMs = 90_000,
  closeTimeoutMs = 5_000,
  scan = scanOne,
}) {
  const label = `source page lifecycle ${url}`;
  let page = null;
  let expired = false;
  const pagePromise = Promise.resolve().then(() => context.newPage()).then(async (createdPage) => {
    if (expired) {
      await withTimeout(createdPage.close(), closeTimeoutMs, "expired source page close").catch(() => {});
      throw new Error(`${label} expired before page creation completed`);
    }
    page = createdPage;
    return createdPage;
  });
  try {
    return await withTimeout(pagePromise.then((createdPage) => scan(createdPage, url, options)), timeoutMs, label);
  } finally {
    expired = true;
    if (page) {
      await withTimeout(page.close(), closeTimeoutMs, "source page close").catch(() => {});
    }
  }
}

export async function scanSources({ context, urlsFile, outFile, env = process.env, log = console.log }) {
  const emit = createScannerLogger(log, env.FLOW_B_LOG_LEVEL || "verbose");
  const inputPath = path.resolve(urlsFile);
  const outputPath = path.resolve(outFile);
  const freshSourceFiles = String(env.FLOW_B_FRESH_SOURCE_FILES || "").split(path.delimiter).filter(Boolean);
  const freshInputUrls = [];
  for (const sourceFile of freshSourceFiles) {
    try {
      freshInputUrls.push(...(await fs.readFile(path.resolve(sourceFile), "utf8")).split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const expandedFreshInputUrls = expandFreshSellerSourceUrls(freshInputUrls);
  const classifiedFreshUrls = classifyFreshSourceUrls(expandedFreshInputUrls);
  const inputUrls = [...new Set([
    ...(await fs.readFile(inputPath, "utf8")).split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    ...expandedFreshInputUrls,
  ])];
  const yieldFiles = [...new Set([
    path.join(path.dirname(outputPath), "source_yield.jsonl"),
    path.join(path.dirname(outputPath), "favorite_collection.jsonl"),
    env.FLOW_B_SOURCE_YIELD_HISTORY || DEFAULT_SOURCE_YIELD_HISTORY,
    ...String(env.FLOW_B_SOURCE_YIELD_SEED_FILES || "").split(path.delimiter).filter(Boolean),
    ...String(env.FLOW_B_FAVORITE_SEED_FILES || "").split(path.delimiter).filter(Boolean),
  ].map((value) => path.resolve(value)))];
  const yieldRows = [];
  for (const yieldFile of yieldFiles) {
    try {
      const text = await fs.readFile(yieldFile, "utf8");
      yieldRows.push(...text.split(/\r?\n/).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      }));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const derivedSearchUrls = deriveSearchSourceUrls(yieldRows, envNumber(env, "FLOW_B_DERIVED_SEARCH_SOURCES", 200));
  const verifiedSellerUrls = verifiedSellerSourceUrls(yieldRows);
  const urls = [...new Set(expandHighYieldSourceUrls([...inputUrls, ...verifiedSellerUrls, ...derivedSearchUrls], yieldRows))];
  let records = [];
  try {
    const parsed = JSON.parse(await fs.readFile(outputPath, "utf8"));
    if (Array.isArray(parsed)) records = parsed;
  } catch {}
  const done = new Set(records.map((row) => row.source_url).filter(Boolean));
  const highYieldSources = yieldRows.filter((row) => row?.status === "published").map((row) => row.source_url);
  const pending = prioritizeSourceUrls(urls.filter((url) => !done.has(url)), {
    highYieldSources,
    yieldRows,
    freshSourceUrls: [...classifiedFreshUrls.explorationUrls, ...derivedSearchUrls],
    verifiedFreshSourceUrls: [...classifiedFreshUrls.verifiedSellerUrls, ...verifiedSellerUrls],
  });
  if (!pending.length) return { outFile: outputPath, records: records.length, pending: 0 };
  const workers = Math.max(1, envNumber(env, "FLOW_B_TAB_WORKERS", 4));
  const adaptiveWorkers = new AdaptiveConcurrency({
    initial: workers,
    max: Math.max(workers, envNumber(env, "FLOW_B_MAX_TAB_WORKERS", 12)),
  });
  const options = {
    steps: envNumber(env, "FLOW_B_MAX_SCROLL_STEPS", 24),
    ratio: envNumber(env, "FLOW_B_SCROLL_RATIO", 0.82),
    delay: envNumber(env, "FLOW_B_SCROLL_DELAY", 0.65) * 1000,
    initialWait: envNumber(env, "FLOW_B_MAOZI_INITIAL_WAIT", 8) * 1000,
    maxNoNewSteps: envNumber(env, "FLOW_B_MAX_NO_NEW_LINK_STEPS", 45),
  };
  const lowDeltaThreshold = envNumber(env, "FLOW_B_LOW_DELTA_THRESHOLD", 1);
  const lowDeltaBatchLimit = envNumber(env, "FLOW_B_LOW_DELTA_BATCH_LIMIT", 2);
  let lowDeltaBatches = 0;
  const targetFavorites = envNumber(env, "FLOW_B_TARGET_FAVORITES", 1000);
  const attempted = await loadExcludedSkus(outputPath, env);
  emit(`favorite exclusions loaded: ${attempted.size}`);
  const favoriteLog = path.join(path.dirname(outputPath), "favorite_collection.jsonl");
  const maozi = await openMaoziPage(context, { forceNew: true });
  try {
    await waitForContent(maozi, 15000);
    if (requiresFavoriteSession(env)) {
      await ensureMaoziLogin(maozi, { continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1" });
      await ensureMaoziPluginLogin(context, { continueDeviceLogin: env.FLOW_B_MAOZI_CONTINUE_LOGIN === "1" });
    }
    let favoriteState;
    try {
      favoriteState = await favoriteCount(maozi);
    } catch (error) {
      emit(`favorite count telemetry unavailable at scan start; relying on authenticated token and capacity response: ${error?.message || error}`);
      favoriteState = { total: 0, authenticated: true };
    }
    if (requiresFavoriteSession(env) && !favoriteState.authenticated) throw new Error("Maozi profile token is stale or the session is not logged in");
    let favoriteBefore = favoriteState.authenticated ? favoriteState.total : null;

    if (favoriteBefore !== null && favoriteBefore < targetFavorites && records.length) {
      const baseLinkLimit = envNumber(env, "FLOW_B_MAX_LINKS_PER_SOURCE", 24);
      const retainedRows = orderRowsBySourceYield(retainedRowsForCollection(records, {
        skipRetained: env.FLOW_B_SKIP_RETAINED === "1",
        provenOnly: env.FLOW_B_RETAINED_PROVEN_ONLY === "1",
        highYieldSources,
      }), yieldRows);
      const retainedCandidates = limitLinksPerSource(
        retainedRows,
        envNumber(env, "FLOW_B_RETAINED_LINKS_PER_SOURCE", baseLinkLimit * 4),
      );
      const retainedLinks = [];
      const retainedSkus = new Set();
      const retainedLimit = retainedReplayLimit(env);
      if (retainedLimit > 0) {
        for (const link of retainedCandidates) {
          const sku = skuFromProductUrl(link?.href);
          if (!sku || attempted.has(sku) || retainedSkus.has(sku)) continue;
          retainedSkus.add(sku);
          retainedLinks.push(link);
          if (retainedLinks.length >= retainedLimit) break;
        }
      }
      emit(`collecting favorites from ${retainedLinks.length} retained product links`);
      favoriteBefore = await collectFavorites({
        context,
        maozi,
        links: retainedLinks,
        target: targetFavorites,
        currentTotal: favoriteBefore,
        env,
        attempted,
        logFile: favoriteLog,
        log: emit,
      });
      if (shouldYieldAfterRetained({ retainedLinks: retainedLinks.length, pendingSources: pending.length })) {
        return {
          outFile: outputPath,
          records: records.length,
          pending: pending.length,
          retained_attempted: retainedLinks.length,
        };
      }
    }

    for (let start = 0; start < pending.length;) {
      if (isCollectionDeadlineReached(env)) break;
      if (favoriteBefore !== null && favoriteBefore >= targetFavorites) break;
      const batch = pending.slice(start, start + adaptiveWorkers.current);
      start += batch.length;
      const batchFavoriteBefore = favoriteBefore;
      emit(`batch ${start - batch.length + 1}-${start} / ${pending.length} concurrency=${adaptiveWorkers.current}`);
      const sourceScanTimeout = envNumber(env, "FLOW_B_SOURCE_SCAN_TIMEOUT_MS", 90_000);
      const pageCloseTimeout = envNumber(env, "FLOW_B_PAGE_CLOSE_TIMEOUT_MS", 5_000);
      const batchRows = await Promise.all(batch.map((url) => scanSourceWithPage({
        context,
        url,
        options,
        timeoutMs: sourceScanTimeout,
        closeTimeoutMs: pageCloseTimeout,
      })
        .catch((error) => ({ source_url: url, blocked: false, stop_reason: `error: ${error.message}`, links: [], cumulative_product_link_count: 0 }))));
      const sourceCooldown = sourceBatchCooldownState(batchRows, collectionRuntimeState(favoriteLog));
      if (sourceCooldown.blocked && !isCollectionDeadlineReached(env)) {
        emit(`source soft block cooldown wait=${sourceCooldown.delay}ms`);
        await waitForMovingDeadline({ getDeadline: () => Math.min(collectionRuntimeState(favoriteLog).detailBlockedUntil, collectionDeadlineMs(env)) });
      }
      for (const row of batchRows) {
        if (row.blocked || /soft block|access denied|captcha|timeout|error:/i.test(String(row.stop_reason || ""))) {
          adaptiveWorkers.recordFailure(new Error(row.stop_reason || "soft block"));
        } else {
          adaptiveWorkers.recordSuccess();
        }
      }
      if (favoriteBefore !== null) {
        let collectionSoftBlocked = false;
        favoriteBefore = await collectFavorites({
          context,
          maozi,
          links: limitLinksPerSource(batchRows.map((row, index) => ({ ...row, source_url: batch[index] })), envNumber(env, "FLOW_B_MAX_LINKS_PER_SOURCE", 24)),
          target: targetFavorites,
          currentTotal: favoriteBefore,
          env,
          attempted,
          logFile: favoriteLog,
          log: emit,
          onResult: (result) => {
            if (result.status === "failed" && /soft blocked|access denied|captcha|timeout|failed to fetch|network|HTTP 0/i.test(String(result.error?.message || result.error || ""))) {
              collectionSoftBlocked = true;
            }
          },
        });
        if (collectionSoftBlocked) adaptiveWorkers.recordFailure(new Error("Ozon collection soft blocked"));
      }
      const afterWait = Math.min(
        envNumber(env, "FLOW_B_MAOZI_AFTER_SCAN_WAIT", 10) * 1000,
        Math.max(0, collectionDeadlineMs(env) - Date.now()),
      );
      if (afterWait) await sleep(afterWait);
      let observedFavoriteAfter = favoriteBefore;
      try {
        favoriteState = await favoriteCount(maozi);
        observedFavoriteAfter = favoriteState.authenticated ? favoriteState.total : null;
      } catch (error) {
        emit(`favorite count telemetry unavailable; retaining claimed total ${favoriteBefore}: ${error?.message || error}`);
      }
      const favoriteAfter = effectiveFavoriteTotal({
        claimedTotal: favoriteBefore,
        observedTotal: observedFavoriteAfter,
        target: targetFavorites,
      });
      const delta = batchFavoriteBefore !== null && favoriteAfter !== null ? favoriteAfter - batchFavoriteBefore : null;
      records.push(...batchRows.map((row, index) => ({
        source_url: batch[index],
        ...row,
        favorite_count_before: batchFavoriteBefore,
        favorite_count_after: favoriteAfter,
        favorite_count_delta: delta,
      })));
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, JSON.stringify(records, null, 2));
      emit(`favorite ${batchFavoriteBefore} -> ${favoriteAfter} delta=${delta}`);
      favoriteBefore = favoriteAfter;
      if (favoriteAfter !== null && favoriteAfter >= targetFavorites) break;
      if (lowDeltaBatchLimit > 0) {
        lowDeltaBatches = delta === null || delta < lowDeltaThreshold ? lowDeltaBatches + 1 : 0;
        if (lowDeltaBatches >= lowDeltaBatchLimit) break;
      }
    }
    return { outFile: outputPath, records: records.length, pending: pending.length };
  } finally {
    await maozi.close().catch(() => {});
  }
}
