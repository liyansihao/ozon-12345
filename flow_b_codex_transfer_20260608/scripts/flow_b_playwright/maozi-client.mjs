import { selectNamedResource } from "./publish-policy.mjs";

export const MAOZI_FAVORITES_ENDPOINT = "/api.product.favorite/lists";

const ENDPOINTS = Object.freeze({
  favorites: MAOZI_FAVORITES_ENDPOINT,
  favoriteToggle: "/api.product.favorite/toggle",
  shops: "/api.shop/lists",
  watermarks: "/api.watermark/templates",
  category: "/api.tool/get_category_by_sku",
  profit: "/api.tool/calc_profit",
  publish: "/api.selection.follow/import",
  commissions: "/api.config/get_ozon_cate_commission",
  importLogs: "/api.product.import_logs/index",
  onlineProducts: "/api.product.online/lists",
  batchUpdateStock: "/api.product.online/batch_update_stock",
  syncWarehouses: "/api.shop/sync_warehouse",
  syncOnlineShops: "/api.product.online/sync_shop",
  userInfo: "/api.user/info",
  orders: "/api.order.ozon/lists",
  refunds: "/api.order.refund/list",
});

function successResponse(response) {
  return Boolean(
    response
      && Number(response.status) >= 200
      && Number(response.status) < 300
      && response.json
      && typeof response.json === "object"
      && !Array.isArray(response.json)
      && Number(response.json.code) === 1,
  );
}

function requireSuccess(response, label) {
  if (!successResponse(response)) {
    const message = response?.json?.msg || response?.json?.message || `HTTP ${response?.status ?? "unknown"}`;
    const error = new Error(`Maozi ${label} request failed: ${message}`);
    error.status = response?.status;
    error.response = response?.json ?? null;
    throw error;
  }
  return response.json.data;
}

function listRows(data, label) {
  const rows = Array.isArray(data) ? data : data?.data ?? data?.list ?? data?.rows ?? data?.items;
  if (!Array.isArray(rows)) throw new Error(`Maozi ${label} response does not contain a valid list`);
  return rows;
}

function stringQuery(input) {
  const query = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined || value === null) continue;
    if (key === "cate" && Array.isArray(value)) query["cate[]"] = value.map(String);
    else query[key] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return query;
}

function isTransientNavigationContextError(error) {
  return /execution context was destroyed|cannot find context with specified id|most likely because of a navigation|frame was detached/iu
    .test(String(error?.message || error || ""));
}

function isAuthenticationFailure(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  return [401, 403].includes(status)
    || /unauthenticated|unauthori[sz]ed|forbidden|login required|access\s*token/iu
      .test(String(error?.message || error || ""));
}

export const MAOZI_REQUEST_TIMEOUT_CODE = "MAOZI_REQUEST_TIMEOUT";
export const DEFAULT_MAOZI_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_MAOZI_GET_TOTAL_BUDGET_MS = 120_000;

function positiveMilliseconds(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : fallback;
}

function maoziRequestTimeoutError({
  endpoint,
  method,
  phase,
  timeoutMs,
  scope = "attempt",
  totalBudgetMs = null,
}) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const normalizedTimeoutMs = Math.max(1, Math.ceil(Number(timeoutMs) || 1));
  const error = new Error(
    `Maozi ${normalizedMethod} ${endpoint} timed out during ${phase} after ${normalizedTimeoutMs}ms`,
  );
  error.name = "MaoziRequestTimeoutError";
  error.code = MAOZI_REQUEST_TIMEOUT_CODE;
  error.endpoint = String(endpoint || "");
  error.method = normalizedMethod;
  error.phase = String(phase || "request");
  error.timeout_ms = normalizedTimeoutMs;
  error.timeout_scope = scope;
  if (totalBudgetMs !== null) error.total_budget_ms = Number(totalBudgetMs);
  return error;
}

function isMaoziRequestTimeoutError(error) {
  return error?.code === MAOZI_REQUEST_TIMEOUT_CODE;
}

export function createMaoziClient({ transport }) {
  if (typeof transport !== "function") throw new TypeError("Maozi transport must be a function");

  async function getFavoritePage({ page = 1, pageSize = 50, isImported = 0 } = {}) {
    const response = await transport(ENDPOINTS.favorites, {
      method: "GET",
      query: { page, page_size: pageSize, is_imported: isImported },
    });
    const data = requireSuccess(response, "favorites");
    const rows = listRows(data, "favorites");
    return {
      rows,
      total: Number(data?.total ?? rows.length),
      page: Number(page),
      lastPage: Number(data?.last_page ?? data?.last ?? data?.pages ?? 1),
    };
  }

  async function listFavorites({ pageSize = 50, query = {} } = {}) {
    const rows = [];
    const seenPages = new Set();
    for (let page = 1; page <= 1000; page += 1) {
      if (seenPages.has(page)) throw new Error("Maozi favorites pagination repeated a page");
      seenPages.add(page);
      const response = await transport(ENDPOINTS.favorites, {
        method: "GET",
        query: { is_imported: 0, ...query, page, page_size: pageSize },
      });
      const data = requireSuccess(response, "favorites");
      const batch = listRows(data, "favorites");
      rows.push(...batch);

      const lastPage = Number(data?.last_page ?? data?.last ?? data?.pages);
      if (Number.isFinite(lastPage) && lastPage > 0) {
        if (page >= lastPage) return rows;
      } else if (batch.length < pageSize) {
        return rows;
      }
    }
    throw new Error("Maozi favorites pagination exceeded 1000 pages");
  }

  async function listImportedFavorites({ pageSize = 50, query = {} } = {}) {
    return listFavorites({ pageSize, query: { ...query, is_imported: 1 } });
  }

  async function listAllFavorites({ pageSize = 50, query = {} } = {}) {
    const rows = [];
    const seenPages = new Set();
    for (let page = 1; page <= 1000; page += 1) {
      if (seenPages.has(page)) throw new Error("Maozi favorites pagination repeated a page");
      seenPages.add(page);
      const response = await transport(ENDPOINTS.favorites, {
        method: "GET",
        query: { ...query, page, page_size: pageSize },
      });
      const data = requireSuccess(response, "favorites");
      const batch = listRows(data, "favorites");
      rows.push(...batch);
      const lastPage = Number(data?.last_page ?? data?.last ?? data?.pages);
      if (Number.isFinite(lastPage) && lastPage > 0) {
        if (page >= lastPage) return rows;
      } else if (batch.length < pageSize) {
        return rows;
      }
    }
    throw new Error("Maozi favorites pagination exceeded 1000 pages");
  }

  async function listPaged(endpoint, label, {
    pageSize = 100,
    query = {},
    maxPages = 100,
  } = {}) {
    const size = Math.max(1, Math.floor(Number(pageSize) || 100));
    const maximum = Math.max(1, Math.floor(Number(maxPages) || 100));
    const rows = [];
    for (let page = 1; page <= maximum; page += 1) {
      const response = await transport(endpoint, {
        method: "GET",
        query: { ...query, page, page_size: size },
      });
      const data = requireSuccess(response, label);
      const batch = listRows(data, label);
      rows.push(...batch);
      const lastPage = Number(data?.last_page ?? data?.last ?? data?.pages ?? data?.pagination?.last_page);
      if (Number.isFinite(lastPage) && lastPage > 0) {
        if (page >= lastPage) return rows;
      } else if (batch.length < size) {
        return rows;
      }
    }
    return rows;
  }

  async function listOrders(options = {}) {
    return listPaged(ENDPOINTS.orders, "Ozon orders", options);
  }

  async function listRefunds(options = {}) {
    return listPaged(ENDPOINTS.refunds, "order refunds", options);
  }

  async function listShops() {
    const data = requireSuccess(await transport(ENDPOINTS.shops, { method: "GET" }), "shops");
    return listRows(data, "shops");
  }

  async function listWatermarks() {
    const data = requireSuccess(await transport(ENDPOINTS.watermarks, { method: "GET" }), "watermarks");
    return listRows(data, "watermarks");
  }

  async function listUserShops() {
    const data = requireSuccess(await transport(ENDPOINTS.userInfo, { method: "GET" }), "user profile");
    const rows = data?.shop ?? data?.user?.shop;
    return Array.isArray(rows) ? rows : [];
  }

  return {
    getFavoritePage,
    listFavorites,
    listImportedFavorites,
    listAllFavorites,
    listOrders,
    listRefunds,
    listShops,
    listUserShops,
    listWatermarks,

    async listCategoryCommissions() {
      const data = requireSuccess(await transport(ENDPOINTS.commissions, { method: "GET" }), "category commissions");
      if (!Array.isArray(data)) throw new Error("Maozi category commissions response does not contain a valid list");
      return data;
    },

    async resolvePublishTarget({ storeNeedle, watermarkNeedle, storeId, watermarkId, includeUserProfile = false }) {
      if (!String(storeNeedle || "").trim()) throw new Error("store needle is required");
      if (!String(watermarkNeedle || "").trim()) throw new Error("watermark needle is required");
      const [shops, watermarks] = await Promise.all([listShops(), listWatermarks()]);
      const namedStore = selectNamedResource(shops, storeNeedle, "store");
      const namedWatermark = selectNamedResource(watermarks, watermarkNeedle, "watermark");
      const store = storeId === undefined ? namedStore : shops.find((row) => String(row?.id) === String(storeId));
      const watermark = watermarkId === undefined ? namedWatermark : watermarks.find((row) => String(row?.id) === String(watermarkId));
      if (!store) throw new Error(`verified store ID not found: ${storeId}`);
      if (!watermark) throw new Error(`verified watermark ID not found: ${watermarkId}`);
      let profileStore = null;
      if (includeUserProfile) {
        const profileShops = await listUserShops().catch(() => []);
        profileStore = profileShops.find((row) => String(row?.id) === String(store.id)) || null;
      }
      return {
        store: profileStore ? { ...store, user_profile: profileStore } : store,
        watermark,
      };
    },

    async getCategoryBySku(sku) {
      return requireSuccess(await transport(ENDPOINTS.category, {
        method: "GET",
        query: { keyword: String(sku) },
      }), "category");
    },

    async calculateProfit(input) {
      return requireSuccess(await transport(ENDPOINTS.profit, {
        method: "GET",
        query: stringQuery(input),
      }), "profit calculation");
    },

    async publish(payload) {
      const response = await transport(ENDPOINTS.publish, { method: "POST", body: payload });
      return {
        ok: successResponse(response),
        status: response?.status ?? 0,
        response: response?.json ?? null,
      };
    },

    async findImportLog({ shopId, sku, offerId } = {}) {
      const response = await transport(ENDPOINTS.importLogs, {
        method: "GET",
        query: { page: 1, page_size: 100, shop_id: shopId, sku: String(sku ?? "") },
      });
      const data = requireSuccess(response, "import logs lookup");
      const rows = listRows(data, "import logs lookup");
      return rows.find((row) => String(row?.sku) === String(sku)
        && (!offerId || String(row?.offer_id) === String(offerId))) || null;
    },

    async findOnlineProduct({ shopId, offerId } = {}) {
      const response = await transport(ENDPOINTS.onlineProducts, {
        method: "GET",
        query: { page: 1, page_size: 100, shop_id: shopId, offer_id: String(offerId ?? "") },
      });
      const data = requireSuccess(response, "online product lookup");
      const rows = listRows(data, "online product lookup");
      const offerRows = rows.filter((row) => String(row?.offer_id) === String(offerId));
      const targetShopId = Number(shopId);
      const exactStoreRow = offerRows.find((row) => Number(row?.shop_id) === targetShopId);
      if (exactStoreRow) return exactStoreRow;
      return offerRows.find((row) => !(Number(row?.shop_id) > 0)) || null;
    },

    async updateProductStock({ shopId, product, warehouseId, stock = 1 } = {}) {
      const productId = Number(product?.id);
      const normalizedWarehouseId = Number(warehouseId);
      const normalizedStock = Number(stock);
      if (!(productId > 0)) throw new Error("online product record ID is required for stock update");
      if (!(normalizedWarehouseId > 0)) throw new Error("verified warehouse ID is required for stock update");
      if (!Number.isInteger(normalizedStock) || normalizedStock < 0) throw new Error("stock must be a non-negative integer");
      return requireSuccess(await transport(ENDPOINTS.batchUpdateStock, {
        method: "POST",
        body: {
          shop_id: Number(shopId),
          products: [{
            id: productId,
            offer_id: String(product?.offer_id || ""),
            warehouses: [{ warehouse_id: normalizedWarehouseId, stock: normalizedStock }],
          }],
        },
      }), "stock update");
    },

    async syncWarehouses(storeIds = []) {
      const ids = [...new Set(storeIds.map(Number).filter((id) => id > 0))];
      if (ids.length === 0) throw new Error("at least one verified store ID is required for warehouse sync");
      return requireSuccess(await transport(ENDPOINTS.syncWarehouses, {
        method: "POST",
        body: { ids },
      }), "warehouse sync");
    },

    async syncOnlineShops(storeIds = [], type = "all") {
      const ids = [...new Set(storeIds.map(Number).filter((id) => id > 0))];
      if (ids.length === 0) throw new Error("at least one verified store ID is required for online-product sync");
      return requireSuccess(await transport(ENDPOINTS.syncOnlineShops, {
        method: "POST",
        body: { ids, type: String(type || "all") },
      }), "online-product sync");
    },

    async deleteFavorite(item) {
      const productInfo = {
        sku: String(item?.sku ?? item?.id ?? ""),
        coverImage: item?.cover_image ?? item?.coverImage ?? null,
        price_info: {
          sell_price: Number(item?.sell_price ?? item?.price ?? 0),
          currency: String(item?.currency ?? "CNY"),
        },
        title: String(item?.title ?? ""),
      };
      requireSuccess(await transport(ENDPOINTS.favoriteToggle, {
        method: "POST",
        body: { productInfo, status: false },
        transportMode: "context",
        timeoutMs: 10_000,
      }), "favorite deletion");
      return true;
    },

    async findPublishedSku(sku) {
      const response = await transport(ENDPOINTS.favorites, {
        method: "GET",
        query: { page: 1, page_size: 10, is_imported: 1, sku: String(sku) },
      });
      const data = requireSuccess(response, "favorites lookup");
      const rows = listRows(data, "favorites lookup");
      return rows.find((row) => String(row?.sku) === String(sku)) || null;
    },
  };
}

export function createMaoziPageTransport({
  page,
  context,
  initialAccessToken = "",
  baseUrl = "https://api.maozierp.com",
  maxGetAttempts = 6,
  requestTimeoutMs = DEFAULT_MAOZI_REQUEST_TIMEOUT_MS,
  getTotalBudgetMs = MAX_MAOZI_GET_TOTAL_BUDGET_MS,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
  now = Date.now,
  retrySleep = (ms) => new Promise((resolve) => scheduleTimeout(resolve, ms)),
  recoverUnauthorized = null,
}) {
  if (!page || typeof page.evaluate !== "function") throw new TypeError("A Playwright Maozi page is required");
  if (typeof scheduleTimeout !== "function") throw new TypeError("scheduleTimeout must be a function");
  if (typeof cancelTimeout !== "function") throw new TypeError("cancelTimeout must be a function");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const invalidAccessTokens = new Set();
  const knownAccessTokens = new Set();
  const normalizeAccessToken = (value) => String(value || "").trim();
  let cachedIdentity = null;
  let identityVersion = 0;
  const cacheIdentity = ({ token, userAgent = "" } = {}, { rejectInvalid = true } = {}) => {
    const normalizedToken = normalizeAccessToken(token);
    if (!normalizedToken || (rejectInvalid && invalidAccessTokens.has(normalizedToken))) return null;
    knownAccessTokens.add(normalizedToken);
    cachedIdentity = {
      token: normalizedToken,
      userAgent: String(userAgent || ""),
    };
    identityVersion += 1;
    return cachedIdentity;
  };
  cacheIdentity({ token: initialAccessToken });
  const redactKnownSecrets = (value) => {
    let safe = String(value?.message || value || "");
    for (const token of knownAccessTokens) {
      if (token) safe = safe.split(token).join("[redacted]");
    }
    return safe.replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]");
  };
  const sanitizeError = (error) => {
    const message = redactKnownSecrets(error);
    const safe = new Error(message || "Maozi transport failed");
    for (const field of [
      "name",
      "code",
      "status",
      "statusCode",
      "endpoint",
      "method",
      "phase",
      "timeout_ms",
      "timeout_scope",
      "total_budget_ms",
    ]) {
      if (error?.[field] !== undefined) safe[field] = error[field];
    }
    return safe;
  };
  const responseIdentities = new WeakMap();
  const identitySnapshot = () => ({
    token: cachedIdentity?.token || "",
    version: identityVersion,
  });
  const invalidateIdentity = ({ token, version } = {}) => {
    const normalizedToken = normalizeAccessToken(token);
    if (normalizedToken) {
      knownAccessTokens.add(normalizedToken);
      invalidAccessTokens.add(normalizedToken);
    }
    const matchesCurrent = normalizedToken
      ? cachedIdentity?.token === normalizedToken
      : Number(version) === identityVersion;
    if (matchesCurrent) {
      cachedIdentity = null;
      identityVersion += 1;
    }
  };
  const configuredRequestTimeoutMs = positiveMilliseconds(
    requestTimeoutMs,
    DEFAULT_MAOZI_REQUEST_TIMEOUT_MS,
  );
  const configuredGetTotalBudgetMs = Math.min(
    MAX_MAOZI_GET_TOTAL_BUDGET_MS,
    positiveMilliseconds(getTotalBudgetMs, MAX_MAOZI_GET_TOTAL_BUDGET_MS),
  );
  const currentTimeMs = () => {
    const observed = now();
    const timestamp = observed instanceof Date ? observed.getTime() : Number(observed);
    if (!Number.isFinite(timestamp)) throw new TypeError("now must return a finite timestamp");
    return timestamp;
  };
  const withHardTimeout = (operation, timeoutMs, details) => {
    const boundedTimeoutMs = Math.max(1, Math.ceil(Number(timeoutMs) || 1));
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = scheduleTimeout(() => {
        if (settled) return;
        settled = true;
        reject(maoziRequestTimeoutError({ ...details, timeoutMs: boundedTimeoutMs }));
      }, boundedTimeoutMs);
      Promise.resolve()
        .then(operation)
        .then(
          (value) => {
            if (settled) return;
            settled = true;
            cancelTimeout(timer);
            resolve(value);
          },
          (error) => {
            if (settled) return;
            settled = true;
            cancelTimeout(timer);
            reject(error);
          },
        );
    });
  };
  const readIdentityFromPage = async (activePage, timeoutMs, runWithTimeout) => {
    try {
      return await runWithTimeout(() => activePage.evaluate(() => {
        try {
          return {
            token: JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || "",
            userAgent: navigator.userAgent || "",
          };
        } catch {
          return { token: "", userAgent: "" };
        }
      }), timeoutMs, "context-identity");
    } catch (error) {
      throw sanitizeError(error);
    }
  };
  const evaluate = async (activePage, request, timeoutMs, runWithTimeout) => {
    const result = await runWithTimeout(() => activePage.evaluate(async (input) => {
    let token = "";
    try {
      token = JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || "";
    } catch {}
    input.headers["Accept-Language"] = "zh-CN";
    input.headers.Client = "pc";
    if (token) input.headers.Authorization = `Bearer ${token}`;

    const url = new URL(input.endpoint, input.baseUrl);
    for (const [key, value] of Object.entries(input.query || {})) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (entry !== undefined && entry !== null) url.searchParams.append(key, String(entry));
      }
    }
    const init = { method: input.method, headers: input.headers };
    if (input.body !== undefined && input.body !== null && input.method !== "GET") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(input.body);
    }

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let requestTimedOut = false;
    const timeout = setTimeout(() => {
      requestTimedOut = true;
      controller?.abort();
    }, input.timeout_ms);
    if (controller) init.signal = controller.signal;
    try {
      const response = await fetch(url.toString(), init);
      const text = await response.text();
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }
      return { status: response.status, json };
    } catch (error) {
      return {
        status: 0,
        json: { error: String(error?.message || error) },
        request_timed_out: requestTimedOut || controller?.signal?.aborted === true,
      };
    } finally {
      clearTimeout(timeout);
    }
    }, { ...request, timeout_ms: timeoutMs }), timeoutMs, "page-fetch");
    if (result?.request_timed_out === true) {
      throw maoziRequestTimeoutError({
        endpoint: request.endpoint,
        method: request.method,
        phase: "page-fetch",
        timeoutMs,
      });
    }
    return result;
  };
  let httpZeroRecovery = null;
  const recoverStalePage = async (failedPage, timeoutMs) => {
    if (page !== failedPage) return page;
    if (typeof failedPage?.reload !== "function") return null;
    if (!httpZeroRecovery) {
      httpZeroRecovery = (async () => {
        await failedPage.reload({
          waitUntil: "domcontentloaded",
          timeout: Math.max(1, Math.min(60_000, Number(timeoutMs) || 1)),
        });
        return failedPage;
      })();
    }
    try {
      const recovered = await httpZeroRecovery;
      if (recovered) page = recovered;
      return recovered;
    } finally {
      httpZeroRecovery = null;
    }
  };
  let unauthorizedRecovery = null;
  return async (endpoint, {
    method = "GET",
    query,
    body,
    transportMode = "page",
    timeoutMs = configuredRequestTimeoutMs,
  } = {}) => {
    if (!["page", "context"].includes(String(transportMode))) {
      throw new TypeError("transportMode must be page or context");
    }
    const activeRequestTimeoutMs = Math.min(
      configuredRequestTimeoutMs,
      positiveMilliseconds(timeoutMs, configuredRequestTimeoutMs),
    );
    const request = {
      baseUrl,
      endpoint,
      method: String(method || "GET").toUpperCase(),
      query: query || {},
      body,
      headers: {},
    };
    const isGet = request.method === "GET";
    const requestDeadlineAt = currentTimeMs() + (
      isGet ? configuredGetTotalBudgetMs : activeRequestTimeoutMs
    );
    const remainingGetBudgetMs = () => (
      isGet ? Math.max(0, Math.ceil(requestDeadlineAt - currentTimeMs())) : null
    );
    const getBudgetTimeout = (phase) => maoziRequestTimeoutError({
      endpoint: request.endpoint,
      method: request.method,
      phase,
      timeoutMs: configuredGetTotalBudgetMs,
      scope: "get-total-budget",
      totalBudgetMs: configuredGetTotalBudgetMs,
    });
    const timeoutForPhase = (phase) => {
      const remaining = Math.max(0, Math.ceil(requestDeadlineAt - currentTimeMs()));
      if (!isGet) {
        if (!(remaining > 0)) {
          throw maoziRequestTimeoutError({
            endpoint: request.endpoint,
            method: request.method,
            phase,
            timeoutMs: activeRequestTimeoutMs,
            scope: "request-total-budget",
            totalBudgetMs: activeRequestTimeoutMs,
          });
        }
        return Math.max(1, Math.min(activeRequestTimeoutMs, remaining));
      }
      if (!(remaining > 0)) throw getBudgetTimeout(phase);
      return Math.max(1, Math.min(configuredRequestTimeoutMs, remaining));
    };
    const runWithTimeout = (operation, timeoutMs, phase, scope = "attempt") => withHardTimeout(
      operation,
      timeoutMs,
      {
        endpoint: request.endpoint,
        method: request.method,
        phase,
        scope,
        totalBudgetMs: isGet ? configuredGetTotalBudgetMs : null,
      },
    );
    const evaluateRequest = (activePage, phase = "page-fetch") => {
      const timeoutMs = timeoutForPhase(phase);
      return evaluate(
        activePage,
        request,
        timeoutMs,
        (operation, boundedTimeoutMs) => runWithTimeout(
          operation,
          boundedTimeoutMs,
          phase,
        ),
      );
    };
    const sleepWithinGetBudget = async (delayMs, phase) => {
      const remaining = remainingGetBudgetMs();
      if (!(remaining > 0)) throw getBudgetTimeout(phase);
      const boundedDelay = Math.max(0, Math.min(Number(delayMs) || 0, remaining - 1));
      if (!(boundedDelay > 0)) throw getBudgetTimeout(phase);
      await runWithTimeout(
        () => retrySleep(boundedDelay),
        remaining,
        phase,
        "get-total-budget",
      );
    };
    const contextRequest = async (activePage) => {
      if (!context?.request || typeof context.request.fetch !== "function") return null;
      let identity = cachedIdentity;
      if (!identity && isGet && unauthorizedRecovery) {
        const recoveryWaitTimeoutMs = timeoutForPhase("unauthorized-recovery-wait");
        await runWithTimeout(
          () => unauthorizedRecovery,
          recoveryWaitTimeoutMs,
          "unauthorized-recovery-wait",
        ).catch((error) => { throw sanitizeError(error); });
        identity = cachedIdentity;
      }
      if (!identity) {
        const identityTimeoutMs = timeoutForPhase("context-identity");
        identity = cacheIdentity(await readIdentityFromPage(
          activePage,
          identityTimeoutMs,
          (operation, boundedTimeoutMs, phase) => runWithTimeout(
            operation,
            boundedTimeoutMs,
            phase,
          ),
        ));
      }
      if (!identity?.token && !isGet) {
        throw new Error(`authenticated context token unavailable for ${request.method} ${request.endpoint}`);
      }
      const attemptedIdentity = identitySnapshot();
      const url = new URL(request.endpoint, request.baseUrl);
      for (const [key, value] of Object.entries(request.query || {})) {
        for (const entry of Array.isArray(value) ? value : [value]) {
          if (entry !== undefined && entry !== null) url.searchParams.append(key, String(entry));
        }
      }
      const headers = {
        "Accept-Language": "zh-CN",
        Client: "pc",
        Origin: "https://ozon.maozierp.com",
        Referer: "https://ozon.maozierp.com/",
      };
      if (identity?.token) headers.Authorization = `Bearer ${identity.token}`;
      if (identity?.userAgent) headers["User-Agent"] = identity.userAgent;
      const fetchTimeoutMs = timeoutForPhase("context-fetch");
      const options = {
        method: request.method,
        headers,
        failOnStatusCode: false,
        timeout: fetchTimeoutMs,
      };
      if (request.body !== undefined && request.body !== null && request.method !== "GET") {
        headers["Content-Type"] = "application/json";
        options.data = request.body;
      }
      let response;
      try {
        response = await runWithTimeout(
          () => context.request.fetch(url.toString(), options),
          fetchTimeoutMs,
          "context-fetch",
        );
      } catch (error) {
        if (isMaoziRequestTimeoutError(error)) throw sanitizeError(error);
        if (/timeout.*exceeded|timed?\s*out/iu.test(String(error?.message || error))) {
          throw maoziRequestTimeoutError({
            endpoint: request.endpoint,
            method: request.method,
            phase: "context-fetch",
            timeoutMs: fetchTimeoutMs,
            totalBudgetMs: isGet ? configuredGetTotalBudgetMs : null,
          });
        }
        throw sanitizeError(error);
      }
      const bodyTimeoutMs = timeoutForPhase("context-response-body");
      let text;
      try {
        text = await runWithTimeout(
          () => response.text(),
          bodyTimeoutMs,
          "context-response-body",
        );
      } catch (error) {
        throw sanitizeError(error);
      }
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }
      const parsed = {
        status: typeof response.status === "function" ? response.status() : Number(response.status),
        json,
      };
      responseIdentities.set(parsed, attemptedIdentity);
      if (isGet && (Number(parsed.status) === 401 || Number(parsed.status) === 403)) {
        invalidateIdentity(attemptedIdentity);
      }
      return parsed;
    };
    const recoverGetUnauthorized = async (result, requestIdentity = null) => {
      const observedIdentity = requestIdentity || responseIdentities.get(result) || identitySnapshot();
      invalidateIdentity(observedIdentity);
      if (typeof recoverUnauthorized !== "function") return { recovered: false, result };
      if (cachedIdentity && cachedIdentity.token !== observedIdentity.token) {
        return { recovered: true };
      }
      if (!unauthorizedRecovery) {
        const recoveryPage = page;
        unauthorizedRecovery = (async () => {
          const recoveryTimeoutMs = timeoutForPhase("unauthorized-recovery");
          const recovered = await runWithTimeout(
            () => recoverUnauthorized(recoveryPage, {
              endpoint: request.endpoint,
              method: request.method,
              status: Number(result.status),
            }),
            recoveryTimeoutMs,
            "unauthorized-recovery",
          );
          const recoveredPage = recovered?.page || recovered;
          const explicitTokenResult = Boolean(
            recovered
              && typeof recovered === "object"
              && Object.prototype.hasOwnProperty.call(recovered, "accessToken"),
          );
          let recoveredIdentity = {
            token: normalizeAccessToken(recovered?.accessToken),
            userAgent: "",
          };
          if (recoveredPage && (page === recoveryPage || !page)) page = recoveredPage;
          if (!recoveredIdentity.token && !explicitTokenResult && recoveredPage?.evaluate) {
            const identityTimeoutMs = timeoutForPhase("unauthorized-recovery-identity");
            try {
              recoveredIdentity = await readIdentityFromPage(
                recoveredPage,
                identityTimeoutMs,
                (operation, boundedTimeoutMs, phase) => runWithTimeout(
                  operation,
                  boundedTimeoutMs,
                  phase,
                ),
              );
            } catch (error) {
              if (isMaoziRequestTimeoutError(error)) throw error;
              recoveredIdentity = { token: "", userAgent: "" };
            }
          }
          const recoveredAccessToken = normalizeAccessToken(recoveredIdentity?.token);
          if (!recoveredAccessToken) {
            throw Object.assign(new Error("Maozi authentication recovery returned no access token"), {
              status: Number(result.status),
            });
          }
          if (!cacheIdentity({
            token: recoveredAccessToken,
            userAgent: recoveredIdentity?.userAgent,
          })
            || cachedIdentity?.token !== recoveredAccessToken) {
            throw Object.assign(new Error("Maozi authentication recovery returned an invalid access token"), {
              status: Number(result.status),
            });
          }
          return true;
        })().catch((error) => {
          if (!cachedIdentity) invalidateIdentity(identitySnapshot());
          throw sanitizeError(error);
        }).finally(() => {
          unauthorizedRecovery = null;
        });
      }
      const recoveryWaitTimeoutMs = timeoutForPhase("unauthorized-recovery-wait");
      await runWithTimeout(
        () => unauthorizedRecovery,
        recoveryWaitTimeoutMs,
        "unauthorized-recovery-wait",
      ).catch((error) => { throw sanitizeError(error); });
      return { recovered: true };
    };
    const completeContextGet = async (result) => {
      if (!isGet || ![401, 403].includes(Number(result?.status))) return result;
      if (typeof recoverUnauthorized !== "function") return result;
      await recoverGetUnauthorized(result);
      return contextRequest(page);
    };
    if (transportMode === "context") {
      let result = await contextRequest(page);
      if (!result) {
        throw new Error(`authenticated context transport unavailable for ${request.method} ${request.endpoint}`);
      }
      if (isGet
        && (Number(result?.status) === 401 || Number(result?.status) === 403)
        && typeof recoverUnauthorized === "function") {
        result = await completeContextGet(result);
      }
      return result;
    }
    let lastError;
    let unauthorizedRetried = false;
    const attempts = isGet ? Math.max(1, Math.floor(Number(maxGetAttempts) || 1)) : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const attemptedIdentity = identitySnapshot();
        let result = await evaluateRequest(page);
        if (isGet
          && !unauthorizedRetried
          && (Number(result?.status) === 401 || Number(result?.status) === 403)
          && typeof recoverUnauthorized === "function") {
          unauthorizedRetried = true;
          await recoverGetUnauthorized(result, attemptedIdentity);
          result = await evaluateRequest(page);
        }
        const transientGet = isGet && (
          Number(result?.status) === 0
          || /请求过于频繁|too many requests|rate.?limit|failed to fetch/i.test(String(result?.json?.msg || result?.json?.message || result?.json?.error || ""))
        );
        if (!transientGet || attempt + 1 >= attempts) {
          if (Number(result?.status) === 0) {
            const failedPage = page;
            let timeoutFailure = null;
            let recovered = null;
            if (isGet) {
              try {
                const recoveryTimeoutMs = timeoutForPhase("page-recovery");
                recovered = await runWithTimeout(
                  () => recoverStalePage(failedPage, recoveryTimeoutMs),
                  recoveryTimeoutMs,
                  "page-recovery",
                );
              } catch (error) {
                if (isMaoziRequestTimeoutError(error)) timeoutFailure = error;
              }
            }
            if (recovered) {
              try {
                const retry = await evaluateRequest(page, "page-recovery-fetch");
                if (Number(retry?.status) !== 0) return retry;
              } catch (error) {
                if (isMaoziRequestTimeoutError(error)) timeoutFailure = error;
              }
            }
            if (isGet) {
              try {
                const fallback = await contextRequest(page);
                if (fallback) return completeContextGet(fallback);
              } catch (error) {
                if (isMaoziRequestTimeoutError(error)) timeoutFailure = error;
              }
            }
            if (timeoutFailure) throw timeoutFailure;
          }
          return result;
        }
        await sleepWithinGetBudget(Math.min(5_000, 750 * (2 ** attempt)), "get-retry-backoff");
      } catch (error) {
        lastError = error;
        if (isGet && isMaoziRequestTimeoutError(error)) {
          if (remainingGetBudgetMs() > 0
            && ["page-fetch", "page-recovery-fetch"].includes(String(error?.phase || ""))) {
            // A hanging in-page fetch does not establish that Chrome or the
            // authenticated Maozi session is unhealthy. Try the independent,
            // read-only APIRequestContext once immediately; waiting for every
            // page retry would otherwise consume the whole GET budget. POSTs
            // never enter this branch and remain strictly single-shot.
            try {
              const fallback = await contextRequest(page);
              if (fallback) return completeContextGet(fallback);
            } catch (fallbackError) {
              if (isTransientNavigationContextError(fallbackError)
                && remainingGetBudgetMs() > 0
                && attempt + 1 < attempts) {
                lastError = fallbackError;
                await sleepWithinGetBudget(
                  Math.min(2_000, 250 * (attempt + 1)),
                  "context-navigation-retry-backoff",
                );
                continue;
              }
              if (isMaoziRequestTimeoutError(fallbackError)
                || /target (?:page, )?context or browser has been closed|browser has been closed/iu
                  .test(String(fallbackError?.message || fallbackError || ""))
                || isAuthenticationFailure(fallbackError)) {
                // Preserve structured timeout, browser, and authentication
                // evidence. The foreground loop retries only the first case;
                // the other two retain their existing fail-closed behavior.
                throw fallbackError;
              }
              // A context-side network failure alone does not prove that the
              // browser is unhealthy. Keep retrying the idempotent page GET;
              // if it remains hung, throw the original structured page timeout
              // so the foreground loop replaces only this Maozi session.
              error.context_fallback_error = String(fallbackError?.message || fallbackError);
            }
          }
          if (remainingGetBudgetMs() > 0 && attempt + 1 < attempts) {
            await sleepWithinGetBudget(
              Math.min(5_000, 750 * (2 ** attempt)),
              "get-timeout-retry-backoff",
            );
            continue;
          }
          if (!(remainingGetBudgetMs() > 0)) throw getBudgetTimeout("get-total-budget");
          throw lastError;
        }
        if (isGet
          && isTransientNavigationContextError(error)
          && attempt + 1 < attempts) {
          // ERP route changes can replace the page execution context while a
          // read-only request is being prepared. Retrying the GET on the new
          // context is safe; POST requests remain single-shot and are never
          // replayed because their server-side status could be unknown.
          await sleepWithinGetBudget(
            Math.min(2_000, 250 * (attempt + 1)),
            "navigation-retry-backoff",
          );
          continue;
        }
        if (!isGet
          || !context
          || !/target page|context or browser has been closed/i.test(String(error?.message || error))) {
          throw error;
        }
        const previous = page;
        let replacement = null;
        for (let poll = 0; poll < 20 && !replacement; poll += 1) {
          replacement = context.pages().find((candidate) => {
            try {
              return candidate !== previous
                && (!candidate.isClosed || !candidate.isClosed())
                && String(candidate.url()).startsWith("https://ozon.maozierp.com/");
            } catch {
              return false;
            }
          });
          if (!replacement) await sleepWithinGetBudget(100, "replacement-page-poll");
        }
        if (!replacement) {
          const newPageTimeoutMs = timeoutForPhase("replacement-page-create");
          replacement = await runWithTimeout(
            () => context.newPage(),
            newPageTimeoutMs,
            "replacement-page-create",
          );
          const navigationTimeoutMs = timeoutForPhase("replacement-page-navigation");
          await runWithTimeout(
            () => replacement.goto("https://ozon.maozierp.com/#/dashboard", {
              waitUntil: "domcontentloaded",
              timeout: navigationTimeoutMs,
            }),
            navigationTimeoutMs,
            "replacement-page-navigation",
          );
          await sleepWithinGetBudget(500, "replacement-page-settle");
        }
        page = replacement;
      }
    }
    throw lastError;
  };
}
