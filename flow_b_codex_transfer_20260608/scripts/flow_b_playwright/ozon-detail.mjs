import { canonicalProductUrl } from "./publish-state.mjs";
import { AdaptiveConcurrency } from "./continuous-runtime.mjs";
import {
  isOzonAuthenticationText,
  isOzonCaptchaText,
} from "./ozon-access-controller.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRY_NAVIGATION_TIMEOUT_MS = 30_000;
const RETRY_OPERATION_GRACE_MS = 3_000;
const PAGE_CLEANUP_TIMEOUT_MS = 2_000;
const MAX_DETAIL_OPERATION_TIMEOUT_MS = 45_000;

function detailDeadlineError(phase, timeoutMs = null) {
  const hasTimeout = timeoutMs !== null && timeoutMs !== undefined
    && Number.isFinite(Number(timeoutMs));
  const suffix = hasTimeout ? ` after ${Math.max(1, Math.floor(Number(timeoutMs)))}ms` : "";
  const error = new Error(`Ozon detail ${phase} timed out${suffix}`);
  error.code = "OZON_DETAIL_DEADLINE";
  error.phase = phase;
  return error;
}

function remainingDeadlineMs(deadlineAt) {
  return Math.max(0, Math.floor(deadlineAt - Date.now()));
}

async function withinDeadline(operation, deadlineAt, phase, timeoutMs = null) {
  const remainingMs = remainingDeadlineMs(deadlineAt);
  const boundedMs = timeoutMs !== null && timeoutMs !== undefined && Number.isFinite(Number(timeoutMs))
    ? Math.min(remainingMs, Math.max(1, Math.floor(Number(timeoutMs))))
    : remainingMs;
  if (boundedMs <= 0) throw detailDeadlineError(phase, timeoutMs);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(detailDeadlineError(phase, boundedMs)), boundedMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function delayBeforeDeadline(delayMs, deadlineAt, phase) {
  const requestedMs = Math.max(0, Math.floor(Number(delayMs) || 0));
  if (remainingDeadlineMs(deadlineAt) <= requestedMs) throw detailDeadlineError(phase);
  await delay(requestedMs);
}

function isRetryablePageGotoFailure(error) {
  if (error?.code === "OZON_DETAIL_DEADLINE" && error?.phase === "navigation-primary") return true;
  const message = String(error?.message || error || "");
  if (/target page|context or browser has been closed|frame was detached/i.test(message)) return false;
  return /^page\.goto: (?:Timeout [0-9]+ms exceeded\.?|net::ERR_(?:FAILED|CONNECTION_(?:CLOSED|RESET)) at https:\/\/www\.ozon\.ru\/product\/[^\s]+)(?:\r?\n|$)/.test(message);
}

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
  retryNavigationTimeoutMs = RETRY_NAVIGATION_TIMEOUT_MS,
  operationGraceMs = RETRY_OPERATION_GRACE_MS,
  pageCleanupTimeoutMs = PAGE_CLEANUP_TIMEOUT_MS,
  operationBudgetMs = null,
} = {}) {
  if (!context || typeof context.newPage !== "function") throw new TypeError("Playwright context is required for Ozon detail extraction");
  const adaptive = new AdaptiveConcurrency({ initial: initialConcurrency, max: maxConcurrency, min: 1 });
  const available = [];
  const waiters = [];
  const allPages = new Set();
  const pageCreations = new Set();
  const pageCloseOperations = new WeakMap();
  const activeRetryNavigationTimeoutMs = Math.max(
    1,
    Math.floor(Number.isFinite(Number(retryNavigationTimeoutMs))
      ? Number(retryNavigationTimeoutMs)
      : RETRY_NAVIGATION_TIMEOUT_MS),
  );
  const activeOperationGraceMs = Math.max(
    1,
    Math.floor(Number.isFinite(Number(operationGraceMs))
      ? Number(operationGraceMs)
      : RETRY_OPERATION_GRACE_MS),
  );
  const activePageCleanupTimeoutMs = Math.max(
    1,
    Math.floor(Number.isFinite(Number(pageCleanupTimeoutMs))
      ? Number(pageCleanupTimeoutMs)
      : PAGE_CLEANUP_TIMEOUT_MS),
  );
  let created = 0;
  let closing = false;
  let closePromise = null;

  function providerClosedError() {
    const error = new Error("Ozon detail page provider is closed");
    error.code = "FLOW_B_OZON_DETAIL_PROVIDER_CLOSED";
    return error;
  }

  async function closeOwnedPageWithin(page, timeoutMs) {
    if (!page?.close) return;
    let closeOperation = pageCloseOperations.get(page);
    if (!closeOperation) {
      closeOperation = Promise.resolve()
        .then(() => page.close({ runBeforeUnload: false }))
        .catch(() => {});
      pageCloseOperations.set(page, closeOperation);
    }
    let timer;
    try {
      await Promise.race([
        closeOperation,
        new Promise((resolve) => {
          timer = setTimeout(resolve, Math.max(1, Math.floor(Number(timeoutMs) || 1)));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function createPage(deadlineAt = Number.POSITIVE_INFINITY) {
    if (closing) throw providerClosedError();
    if (Number.isFinite(deadlineAt) && remainingDeadlineMs(deadlineAt) <= 0) {
      throw detailDeadlineError("page-create");
    }
    created += 1;
    const reservation = { abandoned: false, retained: false, counted: true };
    const releaseReservation = () => {
      if (!reservation.counted) return;
      reservation.counted = false;
      created = Math.max(0, created - 1);
      if (!closing) {
        const next = nextWaiter();
        if (next) createPage(next.deadlineAt).then(next.resolve, next.reject);
      }
    };
    const creation = Promise.resolve().then(async () => {
      const page = await context.newPage();
      if (closing || reservation.abandoned) {
        await closeOwnedPageWithin(page, Math.min(
          activePageCleanupTimeoutMs,
          Math.max(1, remainingDeadlineMs(deadlineAt)),
        ));
        return null;
      }
      allPages.add(page);
      reservation.retained = true;
      return page;
    });
    pageCreations.add(creation);
    creation.finally(() => {
      pageCreations.delete(creation);
      if (!reservation.retained) releaseReservation();
    }).catch(() => {});
    let timer;
    try {
      let page;
      if (Number.isFinite(deadlineAt)) {
        const remainingMs = remainingDeadlineMs(deadlineAt);
        if (remainingMs <= 0) {
          reservation.abandoned = true;
          throw detailDeadlineError("page-create");
        }
        page = await Promise.race([
          creation,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reservation.abandoned = true;
              pageCreations.delete(creation);
              releaseReservation();
              reject(detailDeadlineError("page-create"));
            }, remainingMs);
          }),
        ]);
      } else {
        page = await creation;
      }
      if (!page) throw providerClosedError();
      return page;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function discardPage(page, deadlineAt = Number.POSITIVE_INFINITY) {
    if (allPages.delete(page)) created = Math.max(0, created - 1);
    const timeoutMs = Number.isFinite(deadlineAt)
      ? Math.min(activePageCleanupTimeoutMs, Math.max(1, remainingDeadlineMs(deadlineAt)))
      : activePageCleanupTimeoutMs;
    await closeOwnedPageWithin(page, timeoutMs);
  }

  function nextWaiter() {
    let waiter = waiters.shift() || null;
    while (waiter?.cancelled) waiter = waiters.shift() || null;
    return waiter;
  }

  async function acquirePage(deadlineAt) {
    if (closing) throw providerClosedError();
    while (available.length) {
      const page = available.pop();
      if (allPages.has(page) && (typeof page?.isClosed !== "function" || !page.isClosed())) return page;
      if (allPages.delete(page)) created = Math.max(0, created - 1);
    }
    if (created < adaptive.current) {
      return createPage(deadlineAt);
    }
    return new Promise((resolve, reject) => {
      const remainingMs = remainingDeadlineMs(deadlineAt);
      const waiter = {
        cancelled: false,
        deadlineAt,
        timer: null,
        resolve(page) {
          if (waiter.cancelled) {
            releasePage(page).catch(() => {});
            return;
          }
          waiter.cancelled = true;
          if (waiter.timer) clearTimeout(waiter.timer);
          resolve(page);
        },
        reject(error) {
          if (waiter.cancelled) return;
          waiter.cancelled = true;
          if (waiter.timer) clearTimeout(waiter.timer);
          reject(error);
        },
      };
      if (closing) {
        waiter.reject(providerClosedError());
        return;
      }
      if (remainingMs <= 0) {
        waiter.reject(detailDeadlineError("page-acquire"));
        return;
      }
      waiter.timer = setTimeout(() => {
        waiter.reject(detailDeadlineError("page-acquire"));
      }, remainingMs);
      waiters.push(waiter);
    });
  }

  async function releasePage(page, reusable = true, deadlineAt = Number.POSITIVE_INFINITY) {
    if (closing) {
      await discardPage(page, deadlineAt);
      return;
    }
    if (!reusable || (typeof page?.isClosed === "function" && page.isClosed())) {
      await discardPage(page, deadlineAt);
      const next = nextWaiter();
      if (next) {
        createPage(next.deadlineAt).then(next.resolve, next.reject);
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
      const configuredPrimaryTimeoutMs = Number.isFinite(Number(timeout))
        ? Math.max(1, Math.floor(Number(timeout)))
        : 20_000;
      const primaryNavigationTimeoutMs = Math.max(1_000, configuredPrimaryTimeoutMs);
      const configuredOperationBudgetValue = typeof operationBudgetMs === "function"
        ? operationBudgetMs(sku, item)
        : operationBudgetMs;
      const configuredOperationBudgetMs = Number(configuredOperationBudgetValue);
      const activeOperationBudgetMs = Math.min(
        MAX_DETAIL_OPERATION_TIMEOUT_MS,
        Number.isFinite(configuredOperationBudgetMs) && configuredOperationBudgetMs > 0
          ? Math.max(1, Math.floor(configuredOperationBudgetMs))
          : primaryNavigationTimeoutMs + activeRetryNavigationTimeoutMs + activeOperationGraceMs,
      );
      let operationDeadline = Number.POSITIVE_INFINITY;
      let page = null;
      let reusable = true;
      let navigationFailed = false;
      try {
        const url = item.link || item.detail_url || canonicalProductUrl(sku);
        const readDetail = async () => {
          // The access controller may intentionally serialize this operation
          // behind other Ozon traffic. Queue time is pacing, not execution
          // time, so establish the hard deadline only when work really starts.
          operationDeadline = Date.now() + activeOperationBudgetMs;
          page = await acquirePage(operationDeadline);
          if (!page) throw new Error("Ozon detail page pool could not allocate a page");
          let navigationAttempt = 0;
          while (true) {
            const configuredNavigationTimeoutMs = navigationAttempt === 0
              ? primaryNavigationTimeoutMs
              : activeRetryNavigationTimeoutMs;
            const navigationTimeoutMs = Math.min(
              configuredNavigationTimeoutMs,
              remainingDeadlineMs(operationDeadline),
            );
            if (navigationTimeoutMs <= 0) throw detailDeadlineError("navigation");
            try {
              await withinDeadline(
                () => page.goto(url, {
                  waitUntil: "domcontentloaded",
                  timeout: navigationTimeoutMs,
                }),
                operationDeadline,
                navigationAttempt === 0 ? "navigation-primary" : "navigation-retry",
                navigationTimeoutMs,
              );
              navigationFailed = false;
              break;
            } catch (error) {
              navigationFailed = true;
              if (navigationAttempt !== 0 || !isRetryablePageGotoFailure(error)) throw error;

              const poisonedPage = page;
              page = null;
              reusable = false;
              await discardPage(poisonedPage, operationDeadline);
              if (remainingDeadlineMs(operationDeadline) <= 0) {
                throw detailDeadlineError("retry-page-create");
              }
              page = await createPage(operationDeadline);
              reusable = true;
              navigationFailed = false;
              navigationAttempt += 1;
            }
          }
          const deadline = Math.min(
            Date.now() + Math.max(0, timeout),
            operationDeadline,
          );
          const requiredCaptchaConfirmations = Math.max(
            1,
            Math.floor(Number(captchaConfirmations) || 2),
          );
          let consecutiveCaptchaObservations = 0;
          let payload = null;
          do {
            payload = await withinDeadline(() => page.evaluate(() => ({
              url: location.href,
              title: document.title,
              text: document.body?.innerText || "",
              webPriceText: document.querySelector('div[data-widget="webPrice"]')?.innerText || "",
              sellerUrl: document.querySelector('[data-widget="webCurrentSeller"] a[href*="/seller/"], [data-widget*="CurrentSeller"] a[href*="/seller/"], [data-widget="webSeller"] a[href*="/seller/"]')?.href
                || document.querySelector('a[href*="/seller/"]')?.href || "",
            })), operationDeadline, "page-inspection").catch((error) => {
              if (error?.code === "OZON_DETAIL_DEADLINE") {
                navigationFailed = true;
                throw error;
              }
              return null;
            });
            const access = classifyOzonDetailAccessPayload(payload);
            if (access.captcha) {
              consecutiveCaptchaObservations += 1;
              if (consecutiveCaptchaObservations < requiredCaptchaConfirmations) {
                await delayBeforeDeadline(
                  Math.max(1, Number(captchaConfirmationDelayMs) || 750),
                  operationDeadline,
                  "captcha-confirmation",
                );
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
            await delayBeforeDeadline(
              Math.max(1, pollInterval),
              operationDeadline,
              "detail-poll",
            );
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
        if (error?.code === "OZON_DETAIL_DEADLINE") navigationFailed = true;
        reusable = !navigationFailed
          && !/target page|context or browser has been closed|frame was detached/i.test(String(error?.message || error));
        throw error;
      } finally {
        if (page) {
          if (remainingDeadlineMs(operationDeadline) > 0) {
            await releasePage(page, reusable, operationDeadline);
          } else if (!reusable || navigationFailed) {
            discardPage(page, operationDeadline).catch(() => {});
          } else {
            await releasePage(page, reusable, operationDeadline);
          }
        }
      }
    },
    async close() {
      if (closePromise) return closePromise;
      closing = true;
      const closeError = providerClosedError();
      for (const waiter of waiters.splice(0)) waiter.reject(closeError);
      available.splice(0);
      pageCreations.clear();
      closePromise = (async () => {
        const pages = [...allPages];
        allPages.clear();
        created = 0;
        await Promise.all(pages.map((page) => closeOwnedPageWithin(page, activePageCleanupTimeoutMs)));
      })();
      return closePromise;
    },
  };
}
