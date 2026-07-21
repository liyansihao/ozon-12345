import { selectNamedResource } from "./publish-policy.mjs";

const ENDPOINTS = Object.freeze({
  favorites: "/api.product.favorite/lists",
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
    throw new Error(`Maozi ${label} request failed: ${message}`);
  }
  return response.json.data;
}

function listRows(data, label) {
  const rows = Array.isArray(data) ? data : data?.data;
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
    listShops,
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
  baseUrl = "https://api.maozierp.com",
  maxGetAttempts = 6,
  retrySleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  recoverUnauthorized = null,
}) {
  if (!page || typeof page.evaluate !== "function") throw new TypeError("A Playwright Maozi page is required");
  const evaluate = (activePage, request) => activePage.evaluate(async (input) => {
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
      return { status: 0, json: { error: String(error?.message || error) } };
    }
  }, request);
  const contextRequest = async (activePage, request) => {
    if (!context?.request || typeof context.request.fetch !== "function") return null;
    const identity = await activePage.evaluate(() => {
      try {
        return {
          token: JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || "",
          userAgent: navigator.userAgent || "",
        };
      } catch {
        return { token: "", userAgent: "" };
      }
    });
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
    const options = { method: request.method, headers, failOnStatusCode: false };
    if (request.body !== undefined && request.body !== null && request.method !== "GET") {
      headers["Content-Type"] = "application/json";
      options.data = request.body;
    }
    const response = await context.request.fetch(url.toString(), options);
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: typeof response.status === "function" ? response.status() : Number(response.status), json };
  };
  let httpZeroRecovery = null;
  const recoverStalePage = async (failedPage) => {
    if (page !== failedPage) return page;
    if (typeof failedPage?.reload !== "function") return null;
    if (!httpZeroRecovery) {
      httpZeroRecovery = (async () => {
        await failedPage.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
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
  return async (endpoint, { method = "GET", query, body } = {}) => {
    const request = {
      baseUrl,
      endpoint,
      method: String(method || "GET").toUpperCase(),
      query: query || {},
      body,
      headers: {},
    };
    let lastError;
    let unauthorizedRetried = false;
    const attempts = request.method === "GET" ? Math.max(1, Number(maxGetAttempts) || 1) : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        let result = await evaluate(page, { ...request, headers: {} });
        if (!unauthorizedRetried
          && (Number(result?.status) === 401 || Number(result?.status) === 403)
          && typeof recoverUnauthorized === "function") {
          unauthorizedRetried = true;
          const recoveredPage = await recoverUnauthorized(page, {
            endpoint: request.endpoint,
            method: request.method,
            status: Number(result.status),
          });
          if (recoveredPage) page = recoveredPage;
          result = await evaluate(page, { ...request, headers: {} });
        }
        const transientGet = request.method === "GET" && (
          Number(result?.status) === 0
          || /请求过于频繁|too many requests|rate.?limit|failed to fetch/i.test(String(result?.json?.msg || result?.json?.message || result?.json?.error || ""))
        );
        if (!transientGet || attempt + 1 >= attempts) {
          if (Number(result?.status) === 0) {
            const failedPage = page;
            const recovered = request.method === "GET"
              ? await recoverStalePage(failedPage).catch(() => null)
              : null;
            if (recovered) {
              const retry = await evaluate(page, { ...request, headers: {} });
              if (Number(retry?.status) !== 0) return retry;
            }
            const fallback = await contextRequest(page, request).catch(() => null);
            if (fallback) return fallback;
          }
          return result;
        }
        await retrySleep(Math.min(5_000, 750 * (2 ** attempt)));
      } catch (error) {
        lastError = error;
        if (!context || !/target page|context or browser has been closed/i.test(String(error?.message || error))) throw error;
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
          if (!replacement) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!replacement) {
          replacement = await context.newPage();
          await replacement.goto("https://ozon.maozierp.com/#/dashboard", { waitUntil: "domcontentloaded", timeout: 60000 });
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        page = replacement;
      }
    }
    throw lastError;
  };
}
