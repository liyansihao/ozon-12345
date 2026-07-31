import { canonicalProductUrl } from "./publish-state.mjs";
import { AdaptiveConcurrency } from "./continuous-runtime.mjs";
import {
  isOzonAuthenticationText,
  isOzonCaptchaText,
} from "./ozon-access-controller.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function money(value) {
  const normalized = String(value || "")
    .replace(/[\u00a0\u2009\u202f\s]/g, "")
    .replace(",", ".");
  const match = normalized.match(/([0-9]+(?:\.[0-9]+)?)/);
  const number = Number(match?.[1]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function rounded(value) {
  return value === null ? null : Math.round(value * 100) / 100;
}

function roundedRate(value) {
  return value === null ? null : Math.round(value * 1_000_000) / 1_000_000;
}

function currencyMoney(value, symbolPattern) {
  const source = String(value || "");
  const horizontalSpace = "[\\t\\u00a0\\u2009\\u202f ]*";
  const numberPattern = "([0-9][0-9.,\\t\\u00a0\\u2009\\u202f ]*)";
  const matches = [
    source.match(new RegExp(`${symbolPattern}${horizontalSpace}${numberPattern}`, "iu")),
    source.match(new RegExp(`${numberPattern}${horizontalSpace}${symbolPattern}`, "iu")),
  ].filter(Boolean).sort((left, right) => Number(left.index) - Number(right.index));
  return money(matches[0]?.[1]);
}

function scaledMoney(value, unit) {
  const amount = money(value);
  if (amount === null) return null;
  const multiplier = /万/u.test(String(unit || ""))
    ? 10_000
    : /^(?:千|k)$/iu.test(String(unit || "").trim())
      ? 1_000
      : /^m$/iu.test(String(unit || "").trim())
        ? 1_000_000
        : 1;
  return amount * multiplier;
}

function plausibleCnyRubRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 5 && rate <= 30 ? rate : null;
}

export function parseOzonDetailText(text, fallbackPrice, webPriceText = "") {
  const source = String(text || "");
  const mode = source.match(/发货模式：\s*([^\n]+)/)?.[1]?.trim() || null;

  const modernFollow = source.match(
    /跟卖最低价[：:]\s*₽?\s*([0-9][0-9.,\u00a0\u2009\u202f ]*)\s*₽?\s*(?:≈|~|=)\s*[¥￥]\s*([0-9][0-9.,\u00a0\u2009\u202f ]*)/iu,
  );
  const followLine = source.match(/跟卖最低价[：:][^\n]*/u)?.[0] || "";
  const followRub = money(modernFollow?.[1]) ?? currencyMoney(followLine, "₽");
  let followMin = money(modernFollow?.[2]) ?? currencyMoney(followLine, "[¥￥]");
  if (followMin === null) {
    followMin = money(source.match(/Есть дешевле или быстрее\s*\nот\s*([0-9.,\s\u00a0\u2009\u202f]+)\s*¥/i)?.[1]);
  }
  const anyPairedConversion = source.match(
    /₽\s*([0-9][0-9.,\u00a0\u2009\u202f ]*)\s*(万|千|[km])?\s*(?:≈|~|=)\s*[¥￥]\s*([0-9][0-9.,\u00a0\u2009\u202f ]*)\s*(万|千|[km])?/iu,
  );
  const pairedRub = scaledMoney(anyPairedConversion?.[1], anyPairedConversion?.[2]);
  const pairedCny = scaledMoney(anyPairedConversion?.[3], anyPairedConversion?.[4]);
  const observedCnyRubRate = plausibleCnyRubRate(
    followRub !== null && followMin !== null
      ? followRub / followMin
      : pairedRub !== null && pairedCny !== null
        ? pairedRub / pairedCny
        : null,
  );

  const head = source.split("选品标签：", 1)[0];
  const visiblePrice = currencyMoney(webPriceText, "[¥￥]");
  const currentPriceRub = currencyMoney(webPriceText, "₽");
  const currentPrice = visiblePrice
    ?? (currentPriceRub !== null && observedCnyRubRate !== null
      ? currentPriceRub / observedCnyRubRate
      : null)
    ?? head.split(/\r?\n/)
      .filter((line) => /[¥￥]/u.test(line) && !line.includes("₽"))
      .map((line) => currencyMoney(line, "[¥￥]"))
      .find((value) => value !== null)
    ?? null;
  const fallback = money(fallbackPrice);
  const rubSuspect = currentPrice !== null && fallback !== null
    && (currentPrice > fallback * 3 || fallback > currentPrice * 3);
  const selectedBasis = [fallback, currentPrice, followMin];
  const selectedValues = selectedBasis.filter((value) => value !== null);

  return {
    mode,
    current_price: rounded(currentPrice),
    current_price_rub: rounded(currentPriceRub),
    follow_min: rounded(followMin),
    follow_min_rub: rounded(followRub),
    observed_cny_rub_rate: roundedRate(observedCnyRubRate),
    selected_price: selectedValues.length ? rounded(Math.min(...selectedValues)) : null,
    fallback_price: rounded(fallback),
    current_price_rub_suspect: rubSuspect,
  };
}

export function createOzonDetailProvider({
  context,
  accessController = null,
  timeout = 20000,
  pollInterval = 750,
  initialConcurrency = 8,
  maxConcurrency = 12,
} = {}) {
  if (!context || typeof context.newPage !== "function") throw new TypeError("Playwright context is required for Ozon detail extraction");
  const adaptive = new AdaptiveConcurrency({ initial: initialConcurrency, max: maxConcurrency });
  const available = [];
  const waiters = [];
  let created = 0;

  async function acquirePage() {
    if (available.length) return available.pop();
    if (created < adaptive.current) {
      created += 1;
      try {
        return await context.newPage();
      } catch (error) {
        created -= 1;
        throw error;
      }
    }
    return new Promise((resolve) => waiters.push(resolve));
  }

  async function releasePage(page, reusable = true) {
    if (!reusable || (typeof page?.isClosed === "function" && page.isClosed())) {
      created = Math.max(0, created - 1);
      await page?.close?.().catch(() => {});
      const next = waiters.shift();
      if (next) {
        created += 1;
        context.newPage().then(next, () => { created = Math.max(0, created - 1); next(null); });
      }
      return;
    }
    const next = waiters.shift();
    if (next) next(page);
    else available.push(page);
  }

  return {
    adaptive,
    async getProductDetail(skuValue, item = {}) {
      const sku = String(skuValue || "").trim();
      if (!sku) throw new Error("Ozon detail SKU is required");
      const page = await acquirePage();
      if (!page) throw new Error("Ozon detail page pool could not allocate a page");
      let reusable = true;
      try {
        const url = item.link || item.detail_url || canonicalProductUrl(sku);
        const readDetail = async () => {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
          const deadline = Date.now() + Math.max(0, timeout);
          let payload = null;
          do {
            payload = await page.evaluate(() => ({
              url: location.href,
              title: document.title,
              text: document.body?.innerText || "",
              webPriceText: document.querySelector('div[data-widget="webPrice"]')?.innerText || "",
              sellerUrl: document.querySelector('[data-widget="webCurrentSeller"] a[href*="/seller/"], [data-widget*="CurrentSeller"] a[href*="/seller/"], [data-widget="webSeller"] a[href*="/seller/"]')?.href
                || document.querySelector('a[href*="/seller/"]')?.href || "",
            })).catch(() => null);
            const diagnostic = [
              payload?.url,
              payload?.title,
              payload?.text?.slice(0, 1000),
            ].filter(Boolean).join(" ");
            if (isOzonCaptchaText(diagnostic)) {
              throw new Error(`Ozon CAPTCHA required for SKU ${sku}`);
            }
            if (isOzonAuthenticationText(diagnostic)) {
              throw new Error(`Ozon authentication or MFA required for SKU ${sku}`);
            }
            if (/доступ ограничен|access denied|похоже, нет(?:\s|\u00a0)+соединения/i.test(diagnostic)) {
              throw new Error(`Ozon detail soft blocked for SKU ${sku}`);
            }
            if (payload?.text && /发货模式：/.test(payload.text)) break;
            if (Date.now() >= deadline) break;
            await delay(Math.max(1, pollInterval));
          } while (true);
          return payload;
        };
        const payload = accessController
          ? await accessController.run({ kind: "publish-detail", url }, readDetail)
          : await readDetail();
        if (!payload?.text) throw new Error(`Ozon detail text unavailable for SKU ${sku}`);
        const fallback = String(item.source_currency || "").toUpperCase() === "CNY"
          ? (item.sell_price ?? item.current_price ?? item.price)
          : null;
        const result = {
          ...parseOzonDetailText(payload.text, fallback, payload.webPriceText),
          detail_url: payload.url,
          detail_title: payload.title,
          seller_url: String(payload.sellerUrl || "").trim() || null,
        };
        adaptive.recordSuccess();
        return result;
      } catch (error) {
        adaptive.recordFailure(error);
        reusable = !/target page|context or browser has been closed|frame was detached/i.test(String(error?.message || error));
        throw error;
      } finally {
        await releasePage(page, reusable);
      }
    },
    async close() {
      await Promise.all(available.splice(0).map((page) => page.close().catch(() => {})));
      created = 0;
    },
  };
}
