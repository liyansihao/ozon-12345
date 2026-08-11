import test from "node:test";
import assert from "node:assert/strict";

import { createMaoziClient, createMaoziPageTransport } from "../scripts/flow_b_playwright/maozi-client.mjs";

function makeTransport(fixtures) {
  const calls = [];
  const transport = async (path, request = {}) => {
    calls.push([path, request]);
    const key = `${path} ${request.method || "GET"} ${JSON.stringify(request.query || {})}`;
    const handler = fixtures[key] || fixtures[path] || fixtures.default;
    if (!handler) throw new Error(`unexpected request: ${key}`);
    return typeof handler === "function" ? handler(path, request, calls) : handler;
  };
  transport.calls = calls;
  return transport;
}

function createControlledClock() {
  let timestamp = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => timestamp,
    scheduleTimeout(callback, delayMs) {
      sequence += 1;
      timers.set(sequence, {
        at: timestamp + Math.max(0, Number(delayMs) || 0),
        callback,
      });
      return sequence;
    },
    cancelTimeout(timer) {
      timers.delete(timer);
    },
    pendingCount: () => timers.size,
    async runNext() {
      const next = [...timers.entries()]
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) throw new Error("controlled clock has no pending timer");
      const [timer, value] = next;
      timers.delete(timer);
      timestamp = value.at;
      value.callback();
      for (let index = 0; index < 100; index += 1) await Promise.resolve();
    },
  };
}

async function settleWithControlledClock(promise, clock, maximumTimers = 20) {
  let outcome = null;
  promise.then(
    (value) => { outcome = { value }; },
    (error) => { outcome = { error }; },
  );
  for (let index = 0; index <= maximumTimers && !outcome; index += 1) {
    for (let flush = 0; flush < 100 && !outcome; flush += 1) await Promise.resolve();
    if (outcome) break;
    if (clock.pendingCount() === 0) throw new Error("promise remained pending without a controlled timer");
    await clock.runNext();
  }
  if (!outcome) throw new Error(`promise did not settle after ${maximumTimers} controlled timers`);
  if (outcome.error) throw outcome.error;
  return outcome.value;
}

test("client paginates favorites and resolves the first normalized publish target", async () => {
  const transport = makeTransport({
    "/api.product.favorite/lists": (path, request, calls) => {
      const page = Number(request.query?.page || 1);
      if (page === 1) return { status: 200, json: { code: 1, data: { data: [{ sku: 1 }], last_page: 2 } } };
      if (page === 2) return { status: 200, json: { code: 1, data: { data: [{ sku: 2 }], last_page: 2 } } };
      throw new Error(`unexpected favorites page ${page}`);
    },
    "/api.shop/lists": { status: 200, json: { code: 1, data: [{ id: 7, name: "丽丽 1号 店铺" }, { id: 8, name: "丽丽1号备用店" }] } },
    "/api.watermark/templates": { status: 200, json: { code: 1, data: [{ id: 9, name: "LYSH 主水印" }, { id: 10, name: "lysh 备用" }] } },
  });

  const client = createMaoziClient({ transport });
  assert.deepEqual(await client.listFavorites(), [{ sku: 1 }, { sku: 2 }]);
  assert.deepEqual(
    await client.resolvePublishTarget({ storeNeedle: "丽丽1号", watermarkNeedle: "lysh" }),
    {
      store: { id: 7, name: "丽丽 1号 店铺" },
      watermark: { id: 9, name: "LYSH 主水印" },
    },
  );

  assert.deepEqual(
    transport.calls.map(([path, request]) => [path, request.query?.page, request.query?.page_size, request.query?.is_imported]),
    [
      ["/api.product.favorite/lists", 1, 50, 0],
      ["/api.product.favorite/lists", 2, 50, 0],
      ["/api.shop/lists", undefined, undefined, undefined],
      ["/api.watermark/templates", undefined, undefined, undefined],
    ],
  );
});

test("client paginates the lightweight order and refund history endpoints", async () => {
  const transport = makeTransport({
    "/api.order.ozon/lists": (_path, request) => ({
      status: 200,
      json: {
        code: 1,
        data: {
          data: [{ order_id: `order-${request.query.page}` }],
          last_page: 2,
        },
      },
    }),
    "/api.order.refund/list": {
      status: 200,
      json: { code: 1, data: { list: [{ order_id: "refund-1" }] } },
    },
  });
  const client = createMaoziClient({ transport });
  assert.deepEqual(await client.listOrders({
    pageSize: 1,
    query: { start_date: "2026-07-10", end_date: "2026-08-09" },
  }), [{ order_id: "order-1" }, { order_id: "order-2" }]);
  assert.deepEqual(await client.listRefunds({ pageSize: 100 }), [{ order_id: "refund-1" }]);
  assert.deepEqual(transport.calls.map(([endpoint, request]) => [endpoint, request.query]), [
    ["/api.order.ozon/lists", { start_date: "2026-07-10", end_date: "2026-08-09", page: 1, page_size: 1 }],
    ["/api.order.ozon/lists", { start_date: "2026-07-10", end_date: "2026-08-09", page: 2, page_size: 1 }],
    ["/api.order.refund/list", { page: 1, page_size: 100 }],
  ]);
});

test("publish target rejects empty store or watermark needles", async () => {
  const client = createMaoziClient({ transport: async () => { throw new Error("must not request resources"); } });
  await assert.rejects(
    () => client.resolvePublishTarget({ storeNeedle: "", watermarkNeedle: "lysh" }),
    /store.*required/i,
  );
  await assert.rejects(
    () => client.resolvePublishTarget({ storeNeedle: "丽丽1号", watermarkNeedle: "  " }),
    /watermark.*required/i,
  );
});

test("publish target pins the verified store and watermark IDs", async () => {
  const transport = makeTransport({
    "/api.shop/lists": { status: 200, json: { code: 1, data: [{ id: 1, name: "丽丽1号 old" }, { id: 104965, name: "丽丽1号" }] } },
    "/api.watermark/templates": { status: 200, json: { code: 1, data: [{ id: 2, name: "lysh old" }, { id: 60822, name: "lysh" }] } },
  });
  const client = createMaoziClient({ transport });
  assert.deepEqual(await client.resolvePublishTarget({
    storeNeedle: "丽丽1号",
    watermarkNeedle: "lysh",
    storeId: 104965,
    watermarkId: 60822,
  }), {
    store: { id: 104965, name: "丽丽1号" },
    watermark: { id: 60822, name: "lysh" },
  });
});

test("publish target can merge the ERP user-profile warehouse for the same verified store", async () => {
  const transport = makeTransport({
    "/api.shop/lists": { status: 200, json: { code: 1, data: [{ id: 106646, name: "丽丽五号", warehouse: [] }] } },
    "/api.watermark/templates": { status: 200, json: { code: 1, data: [{ id: 60822, name: "lysh" }] } },
    "/api.user/info": {
      status: 200,
      json: { code: 1, data: { shop: [{ id: 106646, name: "丽丽五号", warehouse: [{ warehouse_id: 7005, name: "五号 FBS 仓" }] }] } },
    },
  });
  const client = createMaoziClient({ transport });

  assert.deepEqual(await client.resolvePublishTarget({
    storeNeedle: "丽丽五号",
    watermarkNeedle: "lysh",
    storeId: 106646,
    watermarkId: 60822,
    includeUserProfile: true,
  }), {
    store: {
      id: 106646,
      name: "丽丽五号",
      warehouse: [],
      user_profile: { id: 106646, name: "丽丽五号", warehouse: [{ warehouse_id: 7005, name: "五号 FBS 仓" }] },
    },
    watermark: { id: 60822, name: "lysh" },
  });
});

test("client validates endpoint request shapes for category and profit lookups", async () => {
  const transport = makeTransport({
    "/api.tool/get_category_by_sku": { status: 200, json: { code: 1, data: { cate: [1, 2, 3], product_info: { weight: 12 } } } },
    "/api.tool/calc_profit": { status: 200, json: { code: 1, data: { calc_result: [], cnyrub_rate: 10.5 } } },
  });

  const client = createMaoziClient({ transport });
  assert.deepEqual(await client.getCategoryBySku("305"), { cate: [1, 2, 3], product_info: { weight: 12 } });
  assert.deepEqual(
    await client.calculateProfit({
      sell_price: 99,
      purchase_price: 20,
      package_weight: 1,
      package_length: 20,
      package_width: 10,
      package_height: 5,
      china_fee: 0,
      ad_rate: 0,
      other_rate: 1,
      logistics: "CEL",
      profit_value: 30,
      profit_type: "percentage",
      cate: [11, 22, 33],
    }),
    { calc_result: [], cnyrub_rate: 10.5 },
  );

  assert.deepEqual(
    transport.calls,
    [
      ["/api.tool/get_category_by_sku", { method: "GET", query: { keyword: "305" } }],
      ["/api.tool/calc_profit", {
        method: "GET",
        query: {
          sell_price: "99",
          purchase_price: "20",
          package_weight: "1",
          package_length: "20",
          package_width: "10",
          package_height: "5",
          china_fee: "0",
          ad_rate: "0",
          other_rate: "1",
          logistics: "CEL",
          profit_value: "30",
          profit_type: "percentage",
          "cate[]": ["11", "22", "33"],
        },
      }],
    ],
  );
});

test("client preserves HTTP authentication status on failed ERP requests", async () => {
  const client = createMaoziClient({
    transport: makeTransport({
      "/api.tool/get_category_by_sku": {
        status: 401,
        json: { msg: "Unauthenticated." },
      },
    }),
  });
  await assert.rejects(
    client.getCategoryBySku("401"),
    (error) => error?.status === 401
      && error?.response?.msg === "Unauthenticated."
      && /category request failed/i.test(error.message),
  );
});

test("client updates one imported product in the verified FBS warehouse", async () => {
  const transport = makeTransport({
    "/api.product.online/batch_update_stock": {
      status: 200,
      json: { code: 1, data: { updated_count: 1, result: [{ updated: true, errors: [] }] } },
    },
  });
  const client = createMaoziClient({ transport });

  assert.deepEqual(await client.updateProductStock({
    shopId: 104965,
    product: { id: 1270954452, offer_id: "mz-140726-091839" },
    warehouseId: 1020005022957960,
    stock: 1,
  }), { updated_count: 1, result: [{ updated: true, errors: [] }] });
  assert.deepEqual(transport.calls, [[
    "/api.product.online/batch_update_stock",
    {
      method: "POST",
      body: {
        shop_id: 104965,
        products: [{
          id: 1270954452,
          offer_id: "mz-140726-091839",
          warehouses: [{ warehouse_id: 1020005022957960, stock: 1 }],
        }],
      },
    },
  ]]);
});

test("client requests the ERP native warehouse sync for verified stores", async () => {
  const transport = makeTransport({
    "/api.shop/sync_warehouse": {
      status: 200,
      json: { code: 1, data: { queued: true } },
    },
  });
  const client = createMaoziClient({ transport });

  assert.deepEqual(await client.syncWarehouses([106637, 106640]), { queued: true });
  assert.deepEqual(transport.calls, [[
    "/api.shop/sync_warehouse",
    { method: "POST", body: { ids: [106637, 106640] } },
  ]]);
});

test("client requests the ERP native online-product sync for verified stores", async () => {
  const transport = makeTransport({
    "/api.product.online/sync_shop": {
      status: 200,
      json: { code: 1, data: { msg: "queued" } },
    },
  });
  const client = createMaoziClient({ transport });

  assert.deepEqual(await client.syncOnlineShops([104965], "all"), { msg: "queued" });
  assert.deepEqual(transport.calls, [[
    "/api.product.online/sync_shop",
    { method: "POST", body: { ids: [104965], type: "all" } },
  ]]);
});

test("client only treats explicit Maozi publish success as success", async () => {
  const ok = createMaoziClient({ transport: async () => ({ status: 200, json: { code: 1, msg: "success" } }) });
  const badCode = createMaoziClient({ transport: async () => ({ status: 200, json: { code: 0, msg: "failed" } }) });
  const badShape = createMaoziClient({ transport: async () => ({ status: 200, json: "not-json" }) });

  assert.equal((await ok.publish({ rows: [] })).ok, true);
  assert.equal((await badCode.publish({ rows: [] })).ok, false);
  assert.equal((await badShape.publish({ rows: [] })).ok, false);
});

test("client verifies the final ERP import log and exact online offer", async () => {
  const transport = makeTransport({
    "/api.product.import_logs/index": (path, request) => {
      assert.deepEqual(request.query, { page: 1, page_size: 100, shop_id: 104965, sku: "3301105092" });
      return { status: 200, json: { code: 1, data: { data: [
        { sku: 3301105092, offer_id: "mz-140726-105092", import_status: "all_imported" },
      ] } } };
    },
    "/api.product.online/lists": (path, request) => {
      assert.deepEqual(request.query, { page: 1, page_size: 100, shop_id: 104965, offer_id: "mz-140726-105092" });
      return { status: 200, json: { code: 1, data: { data: [
        { shop_id: 106637, sku: 9999999999, offer_id: "mz-140726-105092", online_status: "selling", stock: 5 },
        { shop_id: 104965, sku: 5069587484, offer_id: "mz-140726-105092", online_status: "ready_to_sell", stock: 0 },
      ] } } };
    },
  });
  const client = createMaoziClient({ transport });
  assert.deepEqual(await client.findImportLog({ shopId: 104965, sku: "3301105092" }), {
    sku: 3301105092, offer_id: "mz-140726-105092", import_status: "all_imported",
  });
  assert.deepEqual(await client.findOnlineProduct({ shopId: 104965, offerId: "mz-140726-105092" }), {
    shop_id: 104965, sku: 5069587484, offer_id: "mz-140726-105092", online_status: "ready_to_sell", stock: 0,
  });
});

test("exact ERP lookups keep matches beyond the old ten-row response window", async () => {
  const importMatch = { sku: 3301105092, offer_id: "mz-wide-import", import_status: "all_imported" };
  const onlineMatch = {
    shop_id: 104965,
    sku: 5069587484,
    offer_id: "mz-wide-online",
    online_status: "selling",
    stock: 1,
  };
  const transport = makeTransport({
    "/api.product.import_logs/index": (path, request) => ({
      status: 200,
      json: {
        code: 1,
        data: {
          data: request.query.page_size >= 100
            ? [...Array.from({ length: 24 }, (_, index) => ({ sku: `other-${index}` })), importMatch]
            : Array.from({ length: 10 }, (_, index) => ({ sku: `other-${index}` })),
        },
      },
    }),
    "/api.product.online/lists": (path, request) => ({
      status: 200,
      json: {
        code: 1,
        data: {
          data: request.query.page_size >= 100
            ? [...Array.from({ length: 24 }, (_, index) => ({ offer_id: `other-${index}` })), onlineMatch]
            : Array.from({ length: 10 }, (_, index) => ({ offer_id: `other-${index}` })),
        },
      },
    }),
  });
  const client = createMaoziClient({ transport });

  assert.deepEqual(await client.findImportLog({ shopId: 104965, sku: "3301105092" }), importMatch);
  assert.deepEqual(await client.findOnlineProduct({ shopId: 104965, offerId: "mz-wide-online" }), onlineMatch);
});

test("client ignores a same-offer online record explicitly owned by another store", async () => {
  const client = createMaoziClient({ transport: async () => ({
    status: 200,
    json: { code: 1, data: { data: [
      { shop_id: 104965, sku: 123, offer_id: "shared-offer", online_status: "unknown", stock: 0 },
    ] } },
  }) });

  assert.equal(await client.findOnlineProduct({ shopId: 106637, offerId: "shared-offer" }), null);
});

test("client preserves final import failure evidence", async () => {
  const failure = {
    sku: 3761127274,
    offer_id: "mz-140726-127274",
    import_status: "all_failed",
    skus: [{ error_msg: "Не получится загрузить товары: вы исчерпали суточный лимит" }],
  };
  const client = createMaoziClient({ transport: async () => ({
    status: 200,
    json: { code: 1, data: { data: [failure] } },
  }) });
  assert.deepEqual(await client.findImportLog({ shopId: 104965, sku: "3761127274" }), failure);
});

test("client deletes a favorite through the plugin toggle contract", async () => {
  const transport = makeTransport({
    "/api.product.favorite/toggle": (path, request) => {
      assert.deepEqual(request, {
        method: "POST",
        body: {
          productInfo: {
            sku: "123",
            coverImage: "cover.jpg",
            price_info: { sell_price: 19.9, currency: "CNY" },
            title: "sample",
          },
          status: false,
        },
      });
      return { status: 200, json: { code: 1, msg: "取消收藏成功", data: [] } };
    },
  });
  const client = createMaoziClient({ transport });
  assert.equal(await client.deleteFavorite({ sku: 123, cover_image: "cover.jpg", sell_price: 19.9, title: "sample" }), true);
});

test("client finds published SKUs through the favorites endpoint", async () => {
  const transport = makeTransport({
    "/api.product.favorite/lists": (path, request) => {
      assert.equal(request.query.page, 1);
      assert.equal(request.query.page_size, 10);
      assert.equal(request.query.is_imported, 1);
      assert.equal(request.query.sku, "123");
      return { status: 200, json: { code: 1, data: { data: [{ sku: 123, title: "done" }], last_page: 1 } } };
    },
  });
  const client = createMaoziClient({ transport });
  assert.deepEqual(await client.findPublishedSku("123"), { sku: 123, title: "done" });
});

test("client reads exactly one favorite page for verification", async () => {
  const transport = makeTransport({
    "/api.product.favorite/lists": (path, request) => {
      assert.deepEqual(request.query, { page: 2, page_size: 3, is_imported: 0 });
      return { status: 200, json: { code: 1, data: { data: [{ sku: 9 }], total: 21, last_page: 7 } } };
    },
  });
  const client = createMaoziClient({ transport });
  assert.deepEqual(await client.getFavoritePage({ page: 2, pageSize: 3, isImported: 0 }), {
    rows: [{ sku: 9 }], total: 21, page: 2, lastPage: 7,
  });
});

test("client reads the Ozon category commission tree", async () => {
  const client = createMaoziClient({ transport: async (endpoint, request) => {
    assert.equal(endpoint, "/api.config/get_ozon_cate_commission");
    assert.deepEqual(request, { method: "GET" });
    return { status: 200, json: { code: 1, data: [{ cate_id: 10 }] } };
  } });
  assert.deepEqual(await client.listCategoryCommissions(), [{ cate_id: 10 }]);
});

test("client rejects malformed list responses before continuing", async () => {
  const client = createMaoziClient({
    transport: async () => ({ status: 200, json: { code: 1, data: { data: "oops" } } }),
  });
  await assert.rejects(() => client.listFavorites(), /favorites/i);
});

test("browser page transport includes Maozi headers and safely parses non-JSON errors", async () => {
  const requests = [];
  const page = {
    evaluate: async (fn, request) => {
      requests.push(request);
      const savedFetch = globalThis.fetch;
      const savedLocalStorage = globalThis.localStorage;
      globalThis.fetch = async (_url, init) => {
        assert.equal(init.signal instanceof AbortSignal, true);
        return {
          status: 502,
          text: async () => "<html>Bad Gateway</html>",
        };
      };
      globalThis.localStorage = {
        getItem: () => JSON.stringify({ accessToken: "abc123" }),
      };
      try {
        return await fn(request);
      } finally {
        globalThis.fetch = savedFetch;
        globalThis.localStorage = savedLocalStorage;
      }
    },
  };
  const transport = createMaoziPageTransport({ page });
  const response = await transport("/api.shop/lists", {
    method: "POST",
    query: { page: 1, page_size: 10 },
    body: { hello: "world" },
  });

  assert.equal(response.status, 502);
  assert.deepEqual(response.json, { raw: "<html>Bad Gateway</html>" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers["Accept-Language"], "zh-CN");
  assert.equal(requests[0].headers.Client, "pc");
  assert.equal(requests[0].headers.Authorization, "Bearer abc123");
  assert.equal(requests[0].timeout_ms, 30_000);
});

test("browser transport hard-times out one POST without replaying it", async () => {
  const clock = createControlledClock();
  let calls = 0;
  const page = {
    evaluate: async () => {
      calls += 1;
      return new Promise(() => {});
    },
  };
  const transport = createMaoziPageTransport({
    page,
    requestTimeoutMs: 30_000,
    scheduleTimeout: clock.scheduleTimeout,
    cancelTimeout: clock.cancelTimeout,
    now: clock.now,
  });

  await assert.rejects(
    settleWithControlledClock(
      transport("/api.selection.follow/import", { method: "POST", body: { rows: [] } }),
      clock,
    ),
    (error) => error?.code === "MAOZI_REQUEST_TIMEOUT"
      && error?.method === "POST"
      && error?.phase === "page-fetch"
      && error?.timeout_ms === 30_000,
  );
  assert.equal(calls, 1);
  assert.equal(clock.now(), 30_000);
  assert.equal(clock.pendingCount(), 0);
});

test("browser transport never falls back through context request for a POST HTTP 0", async () => {
  let pageCalls = 0;
  let contextCalls = 0;
  const page = {
    evaluate: async () => {
      pageCalls += 1;
      return { status: 0, json: { error: "Failed to fetch" } };
    },
  };
  const context = {
    request: {
      fetch: async () => {
        contextCalls += 1;
        throw new Error("POST fallback must not run");
      },
    },
  };
  const transport = createMaoziPageTransport({ page, context });

  assert.deepEqual(
    await transport("/api.selection.follow/import", { method: "POST", body: { rows: [] } }),
    { status: 0, json: { error: "Failed to fetch" } },
  );
  assert.equal(pageCalls, 1);
  assert.equal(contextCalls, 0);
});

test("browser transport never replays an unauthorized POST during session recovery", async () => {
  let calls = 0;
  let recoveryCalls = 0;
  const page = {
    evaluate: async () => {
      calls += 1;
      return { status: 403, json: { message: "Unauthenticated" } };
    },
  };
  const transport = createMaoziPageTransport({
    page,
    recoverUnauthorized: async () => { recoveryCalls += 1; },
  });

  assert.deepEqual(
    await transport("/api.selection.follow/import", { method: "POST", body: { rows: [] } }),
    { status: 403, json: { message: "Unauthenticated" } },
  );
  assert.equal(calls, 1);
  assert.equal(recoveryCalls, 0);
});

test("browser transport caps all GET page attempts at the 120 second total budget", async () => {
  const clock = createControlledClock();
  let calls = 0;
  const page = {
    evaluate: async () => {
      calls += 1;
      return new Promise(() => {});
    },
  };
  const transport = createMaoziPageTransport({
    page,
    maxGetAttempts: 10,
    retrySleep: async () => {},
    scheduleTimeout: clock.scheduleTimeout,
    cancelTimeout: clock.cancelTimeout,
    now: clock.now,
  });

  await assert.rejects(
    settleWithControlledClock(transport("/api.shop/lists"), clock),
    (error) => error?.code === "MAOZI_REQUEST_TIMEOUT"
      && error?.method === "GET"
      && error?.timeout_scope === "get-total-budget"
      && error?.total_budget_ms === 120_000,
  );
  assert.equal(calls, 4);
  assert.equal(clock.now(), 120_000);
  assert.equal(clock.pendingCount(), 0);
});

test("browser transport hard-times out the authenticated context request", async () => {
  const clock = createControlledClock();
  const fetchOptions = [];
  const page = {
    evaluate: async (_fn, request) => request
      ? ({ status: 0, json: { error: "Failed to fetch" } })
      : ({ token: "token-from-page", userAgent: "Chrome Test Agent" }),
  };
  const context = {
    request: {
      fetch: async (_url, options) => {
        fetchOptions.push(options);
        return new Promise(() => {});
      },
    },
  };
  const transport = createMaoziPageTransport({
    page,
    context,
    maxGetAttempts: 1,
    scheduleTimeout: clock.scheduleTimeout,
    cancelTimeout: clock.cancelTimeout,
    now: clock.now,
  });

  await assert.rejects(
    settleWithControlledClock(transport("/api.shop/lists"), clock),
    (error) => error?.code === "MAOZI_REQUEST_TIMEOUT"
      && error?.method === "GET"
      && error?.phase === "context-fetch",
  );
  assert.equal(fetchOptions.length, 1);
  assert.equal(fetchOptions[0].timeout, 30_000);
  assert.equal(clock.now(), 30_000);
  assert.equal(clock.pendingCount(), 0);
});

test("browser transport also bounds a stalled context response body", async () => {
  const clock = createControlledClock();
  let fetchCalls = 0;
  const page = {
    evaluate: async (_fn, request) => request
      ? ({ status: 0, json: { error: "Failed to fetch" } })
      : ({ token: "token-from-page", userAgent: "Chrome Test Agent" }),
  };
  const context = {
    request: {
      fetch: async () => {
        fetchCalls += 1;
        return {
          status: () => 200,
          text: async () => new Promise(() => {}),
        };
      },
    },
  };
  const transport = createMaoziPageTransport({
    page,
    context,
    maxGetAttempts: 1,
    scheduleTimeout: clock.scheduleTimeout,
    cancelTimeout: clock.cancelTimeout,
    now: clock.now,
  });

  await assert.rejects(
    settleWithControlledClock(transport("/api.shop/lists"), clock),
    (error) => error?.code === "MAOZI_REQUEST_TIMEOUT"
      && error?.phase === "context-response-body",
  );
  assert.equal(fetchCalls, 1);
  assert.equal(clock.now(), 30_000);
  assert.equal(clock.pendingCount(), 0);
});

test("browser transport retries on the replacement Maozi page after SSO closes", async () => {
  const first = { evaluate: async () => { throw new Error("Target page, context or browser has been closed"); }, isClosed: () => true, url: () => "about:blank" };
  const second = { evaluate: async () => ({ status: 200, json: { code: 1 } }), isClosed: () => false, url: () => "https://ozon.maozierp.com/#/dashboard" };
  const context = { pages: () => [first, second] };
  const transport = createMaoziPageTransport({ page: first, context });
  assert.deepEqual(await transport("/api.shop/lists"), { status: 200, json: { code: 1 } });
});

test("browser transport refreshes one expired Maozi API session before returning 403", async () => {
  let authenticated = false;
  let recoveryCalls = 0;
  const page = {
    evaluate: async () => authenticated
      ? ({ status: 200, json: { code: 1, data: [{ id: 106637 }] } })
      : ({ status: 403, json: { message: "Unauthenticated" } }),
  };
  const transport = createMaoziPageTransport({
    page,
    recoverUnauthorized: async (activePage) => {
      recoveryCalls += 1;
      assert.equal(activePage, page);
      authenticated = true;
    },
  });

  assert.deepEqual(await transport("/api.shop/lists"), {
    status: 200,
    json: { code: 1, data: [{ id: 106637 }] },
  });
  assert.equal(recoveryCalls, 1);
});

test("browser transport retries GET requests through a short HTTP 0 outage", async () => {
  let calls = 0;
  const delays = [];
  const page = {
    evaluate: async () => {
      calls += 1;
      return calls < 5
        ? { status: 0, json: { error: "Failed to fetch" } }
        : { status: 200, json: { code: 1, data: [] } };
    },
  };
  const transport = createMaoziPageTransport({
    page,
    maxGetAttempts: 6,
    retrySleep: async (ms) => delays.push(ms),
  });
  assert.deepEqual(await transport("/api.shop/lists"), { status: 200, json: { code: 1, data: [] } });
  assert.equal(calls, 5);
  assert.deepEqual(delays, [750, 1_500, 3_000, 5_000]);
});

test("browser transport retries a GET after ERP navigation replaces the execution context", async () => {
  let calls = 0;
  const delays = [];
  const page = {
    evaluate: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("Execution context was destroyed, most likely because of a navigation");
      }
      return { status: 200, json: { code: 1, data: [] } };
    },
  };
  const transport = createMaoziPageTransport({
    page,
    maxGetAttempts: 3,
    retrySleep: async (ms) => delays.push(ms),
  });

  assert.deepEqual(await transport("/api.shop/lists"), {
    status: 200,
    json: { code: 1, data: [] },
  });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [250]);
});

test("browser transport never replays a POST after navigation destroys its context", async () => {
  let calls = 0;
  const page = {
    evaluate: async () => {
      calls += 1;
      throw new Error("Execution context was destroyed, most likely because of a navigation");
    },
  };
  const transport = createMaoziPageTransport({ page, maxGetAttempts: 3 });

  await assert.rejects(
    () => transport("/api.selection.follow/import", { method: "POST", body: { rows: [] } }),
    /execution context was destroyed/i,
  );
  assert.equal(calls, 1);
});

test("browser transport falls back to the authenticated context request after persistent HTTP 0", async () => {
  const calls = [];
  const page = {
    evaluate: async (_fn, request) => request
      ? ({ status: 0, json: { error: "Failed to fetch" } })
      : ({ token: "token-from-page", userAgent: "Chrome Test Agent" }),
  };
  const context = {
    request: {
      fetch: async (url, options) => {
        calls.push({ url, options });
        return {
          status: () => 200,
          text: async () => JSON.stringify({ code: 1, data: [{ id: 106637 }] }),
        };
      },
    },
  };
  const transport = createMaoziPageTransport({
    page,
    context,
    maxGetAttempts: 2,
    retrySleep: async () => {},
  });

  assert.deepEqual(await transport("/api.shop/lists", { query: { page: 2 } }), {
    status: 200,
    json: { code: 1, data: [{ id: 106637 }] },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.shop\/lists\?page=2$/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer token-from-page");
  assert.equal(calls[0].options.headers.Client, "pc");
  assert.equal(calls[0].options.headers.Origin, "https://ozon.maozierp.com");
  assert.equal(calls[0].options.headers.Referer, "https://ozon.maozierp.com/");
  assert.equal(calls[0].options.headers["User-Agent"], "Chrome Test Agent");
});

test("browser transport reloads one stale ERP page before using the HTTP 0 fallback", async () => {
  let healthy = false;
  let reloads = 0;
  let fallbackCalls = 0;
  const page = {
    evaluate: async (_fn, request) => request
      ? (healthy
        ? { status: 200, json: { code: 1, data: [{ id: 106637 }] } }
        : { status: 0, json: { error: "Failed to fetch" } })
      : ({ token: "token-from-page", userAgent: "Chrome Test Agent" }),
    reload: async () => {
      reloads += 1;
      healthy = true;
    },
  };
  const context = {
    request: {
      fetch: async () => {
        fallbackCalls += 1;
        throw new Error("fallback should not run after page recovery");
      },
    },
  };
  const transport = createMaoziPageTransport({
    page,
    context,
    maxGetAttempts: 2,
    retrySleep: async () => {},
  });

  assert.deepEqual(await transport("/api.shop/lists"), {
    status: 200,
    json: { code: 1, data: [{ id: 106637 }] },
  });
  assert.equal(reloads, 1);
  assert.equal(fallbackCalls, 0);
});
