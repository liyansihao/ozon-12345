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

function hasUsableProductDetail(payload = {}) {
  const text = String(payload?.text || "");
  return (
    /\u53d1\u8d27\u6a21\u5f0f\uff1a/u.test(text)
    || Boolean(String(payload?.webPriceText || "").trim())
    || Boolean(String(payload?.sellerUrl || "").trim())
  );
}

export function classifyOzonDetailAccessPayload(payload = {}) {
  const url = String(payload?.url || "");
  const title = String(payload?.title || "");
  const text = String(payload?.text || "");
  const urlAndTitle = `${url} ${title}`;
  const bodyHead = text.slice(0, 1_000);
  const productReady = hasUsableProductDetail(payload);
  const captcha = isOzonCaptchaText(urlAndTitle)
    || (isOzonCaptchaText(bodyHead) && !productReady);
  const authentication = isOzonAuthenticationText(urlAndTitle)
    || (isOzonAuthenticationText(bodyHead) && !productReady);
  return {
    captcha,
    authentication,
    productReady,
  };
}

export function createOzonDetailProvider({
  context,
  accessController = null,
  timeout = 20000,
  pollInterval = 750,
  captchaConfirmations = 2,
  captchaConfirmationDelayMs = 750,
  initialConcurrency = 8,
  maxConcurrency = 12,
} = {}) {
  if (!context || typeof context.newPage !== "function") throw new TypeError("Playwright context is required for Ozon detail extraction");
  const adaptive = new AdaptiveConcurrency({ initial: initialConcurrency, max: maxConcurrency, min: 1 });
  const available = [];
  const waiters = [];
  const allPages = new Set();
  const pageCreations = new Set();
  let created = 0;
  let closing = false;
  let closePromise = null;

  function providerClosedError() {
    const error = new Error("Ozon detail page provider is closed");
    error.code = "FLOW_B_OZON_DETAIL_PROVIDER_CLOSED";
    return error;
  }

  async function createPage() {
    if (closing) throw providerClosedError();
    created += 1;
    let retained = false;
    const creation = (async () => {
      const page = await context.newPage();
      if (closing) {
        await page.close().catch(() => {});
        return null;
      }
      allPages.add(page);
      retained = true;
      return page;
    })();
    pageCreations.add(creation);
    try {
      const page = await creation;
      if (!page) throw providerClosedError();
      return page;
    } finally {
      pageCreations.delete(creation);
      if (!retained) created = Math.max(0, created - 1);
    }
  }

  async function discardPage(page) {
    if (allPages.delete(page)) created = Math.max(0, created - 1);
    await page?.close?.().catch(() => {});
  }

  function nextWaiter() {
    return waiters.shift() || null;
  }

  async function acquirePage() {
    if (closing) throw providerClosedError();
    while (available.length) {
      const page = available.pop();
      if (allPages.has(page) && (typeof page?.isClosed !== "function" || !page.isClosed())) return page;
      if (allPages.delete(page)) created = Math.max(0, created - 1);
    }
    if (created < adaptive.current) {
      return createPage();
    }
    return new Promise((resolve, reject) => {
      if (closing) reject(providerClosedError());
      else waiters.push({ resolve, reject });
    });
  }

  async function releasePage(page, reusable = true) {
    if (closing) {
      await discardPage(page);
      return;
    }
    if (!reusable || (typeof page?.isClosed === "function" && page.isClosed())) {
      await discardPage(page);
      const next = nextWaiter();
      if (next) {
        createPage().then(next.resolve, next.reject);
      }
      return;
    }
    const next = nextWaiter();
    if (next) next.resolve(page);
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
          const requiredCaptchaConfirmations = Math.max(
            1,
            Math.floor(Number(captchaConfirmations) || 2),
          );
          let consecutiveCaptchaObservations = 0;
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
            const access = classifyOzonDetailAccessPayload(payload);
            if (access.captcha) {
              consecutiveCaptchaObservations += 1;
              if (consecutiveCaptchaObservations < requiredCaptchaConfirmations) {
                await delay(Math.max(1, Number(captchaConfirmationDelayMs) || 750));
                continue;
              }
              throw new Error(
                `Ozon CAPTCHA required for SKU ${sku} after ${consecutiveCaptchaObservations} confirmations`,
              );
            }
            consecutiveCaptchaObservations = 0;
            if (access.authentication) {
              throw new Error(`Ozon authentication or MFA required for SKU ${sku}`);
            }
            const diagnostic = [
              payload?.url,
              payload?.title,
              payload?.text?.slice(0, 1000),
            ].filter(Boolean).join(" ");
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
      if (closePromise) return closePromise;
      closing = true;
      const closeError = providerClosedError();
      for (const waiter of waiters.splice(0)) waiter.reject(closeError);
      available.splice(0);
      closePromise = (async () => {
        await Promise.allSettled([...pageCreations]);
        const pages = [...allPages];
        allPages.clear();
        created = 0;
        await Promise.all(pages.map((page) => page.close().catch(() => {})));
      })();
      return closePromise;
    },
  };
}
