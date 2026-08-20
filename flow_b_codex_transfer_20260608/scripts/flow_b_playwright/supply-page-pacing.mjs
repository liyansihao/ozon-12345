const SUPPLY_PAGE_MIN_INTERVAL_ENV = "FLOW_B_SUPPLY_PAGE_MIN_INTERVAL_MS";
const PURCHASE_HOST_RE = /(?:^|\.)(?:cart|checkout|order|buyertrade|tradeorder|buy)\.(?:1688|alibaba)\.com$/iu;
const PURCHASE_PATH_SEGMENT_RE = /(?:^|\/)(?:cart(?:service)?|shoppingcart|checkout|orders?|buy(?:now|offer)?)(?:\/|$)/iu;
const PURCHASE_ACTION_RE = /(?:^|[\/._?&=-])(?:(?:add[\/._-]?to|add)[\/._-]?cart|cart[\/._-]?add|(?:create|submit|place|confirm)[\/._-]?order|order[\/._-]?(?:create|submit|place|confirm)|buy[\/._-]?now)(?:$|[\/._?&=-])/iu;

function nonNegativeSafeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

export function supplyPageMinimumIntervalMs(env = {}) {
  const raw = String(env?.[SUPPLY_PAGE_MIN_INTERVAL_ENV] ?? "").trim();
  if (!raw) return 0;
  const minimumIntervalMs = nonNegativeSafeInteger(raw, SUPPLY_PAGE_MIN_INTERVAL_ENV);
  if (minimumIntervalMs > 0 && env?.FLOW_B_VALIDATION_ONLY !== "1") {
    throw new Error(`${SUPPLY_PAGE_MIN_INTERVAL_ENV} is allowed only when FLOW_B_VALIDATION_ONLY=1`);
  }
  return minimumIntervalMs;
}

export function createSupplyPagePacer({
  minimumIntervalMs = 0,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const intervalMs = nonNegativeSafeInteger(
    minimumIntervalMs,
    "minimumIntervalMs",
  );
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof sleep !== "function") throw new TypeError("sleep must be a function");
  if (intervalMs === 0) return async () => 0;

  let lastLeaseAt = null;
  return async () => {
    const observedAt = Number(now());
    if (!Number.isFinite(observedAt)) throw new TypeError("now must return a finite timestamp");
    const waitMs = lastLeaseAt === null
      ? 0
      : Math.max(0, (lastLeaseAt + intervalMs) - observedAt);
    if (waitMs > 0) await sleep(waitMs);
    const leasedAt = Number(now());
    if (!Number.isFinite(leasedAt)) throw new TypeError("now must return a finite timestamp");
    lastLeaseAt = leasedAt;
    return waitMs;
  };
}

function decodedUrlPart(value) {
  try { return decodeURIComponent(String(value || "")); } catch { return String(value || ""); }
}

export function shouldBlock1688SupplyMutation({ method, url } = {}) {
  // Purchase endpoints have historically accepted state-changing GET requests
  // as well as conventional mutation methods. URL semantics therefore take
  // precedence over the verb; the method is deliberately not a safety bypass.
  void method;
  let parsed;
  try { parsed = new URL(String(url || "")); } catch { return false; }
  const hostname = parsed.hostname.toLowerCase();
  const is1688 = hostname === "1688.com" || hostname.endsWith(".1688.com");
  const isAlibaba = hostname === "alibaba.com" || hostname.endsWith(".alibaba.com");
  if (!is1688 && !isAlibaba) return false;
  if (PURCHASE_HOST_RE.test(hostname)) return true;
  const pathname = decodedUrlPart(parsed.pathname).toLowerCase();
  const actionSurface = decodedUrlPart(`${parsed.pathname}${parsed.search}`).toLowerCase();
  return PURCHASE_PATH_SEGMENT_RE.test(pathname) || PURCHASE_ACTION_RE.test(actionSurface);
}

export async function installValidationSupplyMutationBlocker(page) {
  if (!page || typeof page.route !== "function") {
    throw new TypeError("page.route is required for validation-only supply mutation blocking");
  }
  // The caller installs this only on the dedicated validation supply page.
  // Read-only detail and SKU traffic falls through unchanged. Recognized
  // cart/order/buy endpoints are blocked even when they use GET or HEAD.
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (shouldBlock1688SupplyMutation({
      method: request.method(),
      url: request.url(),
    })) {
      await route.abort("blockedbyclient");
      return;
    }
    if (typeof route.fallback === "function") await route.fallback();
    else await route.continue();
  });
}

export function createPacedSupplyPageProvider(context, {
  minimumIntervalMs = 0,
  blockMutatingPurchaseRequests = false,
  now = Date.now,
  sleep,
} = {}) {
  if (!context || typeof context.newPage !== "function") {
    throw new TypeError("context.newPage is required");
  }
  const pace = createSupplyPagePacer({ minimumIntervalMs, now, sleep });
  let page = null;
  return {
    pageProvider: async () => {
      if (!page || page.isClosed()) {
        page = await context.newPage();
        if (blockMutatingPurchaseRequests) {
          try {
            await installValidationSupplyMutationBlocker(page);
          } catch (error) {
            await page.close?.().catch(() => {});
            page = null;
            throw error;
          }
        }
      }
      await pace();
      return page;
    },
    page: () => page,
    close: async () => {
      await page?.close?.().catch(() => {});
      page = null;
    },
  };
}
