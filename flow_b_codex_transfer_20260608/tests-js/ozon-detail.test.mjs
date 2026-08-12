import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyOzonDetailAccessPayload,
  createOzonDetailProvider,
  parseOzonDetailText,
} from "../scripts/flow_b_playwright/ozon-detail.mjs";

test("detail parser extracts plugin mode, current price, and lowest follow price", () => {
  const detail = parseOzonDetailText([
    "商品标题",
    "¥ 100.50",
    "发货模式： FBS",
    "跟卖最低价： ¥ 88.20",
    "选品标签：测试",
  ].join("\n"), 95);
  assert.deepEqual(detail, {
    mode: "FBS",
    current_price: 100.5,
    current_price_rub: null,
    follow_min: 88.2,
    follow_min_rub: null,
    observed_cny_rub_rate: null,
    selected_price: 88.2,
    fallback_price: 95,
    current_price_rub_suspect: false,
  });
});

test("detail parser converts the current ruble price with the paired Maozi follow-price rate", () => {
  const detail = parseOzonDetailText([
    "商品标题",
    "发货模式： FBO",
    "黑标价：317.5 ₽",
    "跟卖最低价：₽107.00 ≈ ¥9.07",
    "选品标签：测试",
  ].join("\n"), 19.67, "233 ₽\n281 ₽ без Ozon Карты\n400 ₽ обычная цена");
  assert.equal(detail.current_price_rub, 233);
  assert.equal(detail.follow_min_rub, 107);
  assert.equal(detail.observed_cny_rub_rate, 11.797133);
  assert.equal(detail.current_price, 19.75);
  assert.equal(detail.follow_min, 9.07);
  assert.equal(detail.selected_price, 9.07);
  assert.equal(detail.current_price_rub_suspect, false);
});

test("detail parser exposes a live ruble price without guessing a stale conversion rate", () => {
  const detail = parseOzonDetailText(
    "商品标题\n发货模式： FBO\n黑标价：507.25 ₽",
    31.7,
    "374 ₽\nС Ozon Картой",
  );
  assert.equal(detail.current_price, null);
  assert.equal(detail.current_price_rub, 374);
  assert.equal(detail.observed_cny_rub_rate, null);
  assert.equal(detail.selected_price, 31.7);
});

test("detail parser converts a ruble-only current price from the same page sales conversion pair", () => {
  const detail = parseOzonDetailText([
    "商品标题",
    "发货模式： FBO",
    "月销售额：₽22.11万 ≈ ¥1.87万",
    "跟卖最低价：无",
  ].join("\n"), 14.47, "170 ₽\nС Ozon Картой");
  assert.equal(detail.current_price_rub, 170);
  assert.equal(detail.follow_min, null);
  assert.equal(detail.observed_cny_rub_rate, 11.823529);
  assert.equal(detail.current_price, 14.38);
  assert.equal(detail.selected_price, 14.38);
});

test("detail parser rejects an implausible paired conversion rate", () => {
  const detail = parseOzonDetailText(
    "发货模式： FBO\n月销售额：₽10 ≈ ¥100\n跟卖最低价：无",
    15,
    "180 ₽",
  );
  assert.equal(detail.observed_cny_rub_rate, null);
  assert.equal(detail.current_price, null);
  assert.equal(detail.selected_price, 15);
});

test("detail parser ignores a ruble-like current price and supports Russian follow text", () => {
  const detail = parseOzonDetailText([
    "¥ 5000",
    "发货模式： FBS",
    "Есть дешевле или быстрее",
    "от 79,90 ¥",
  ].join("\n"), 100);
  assert.equal(detail.current_price_rub_suspect, true);
  assert.equal(detail.follow_min, 79.9);
  assert.equal(detail.selected_price, 79.9);
});

test("visible Ozon price overrides ruble sales revenue stored as favorite fallback", () => {
  const detail = parseOzonDetailText([
    "月销售额：₽7283.02 ≈ ¥649.65",
    "发货模式： FBS",
    "跟卖最低价：¥8.76",
  ].join("\n"), 7283.02, "10,62 ¥\nС банками");
  assert.equal(detail.current_price, 10.62);
  assert.equal(detail.current_price_rub_suspect, true);
  assert.equal(detail.selected_price, 8.76);
});

test("Playwright detail provider reuses its page until the pool closes", async () => {
  let closed = false;
  const page = {
    goto: async () => {},
    evaluate: async () => ({
      url: "https://www.ozon.ru/product/test-123/",
      title: "Ozon item",
      text: "title\n¥ 99\n发货模式： FBS\n跟卖最低价： ¥ 80\n选品标签：x",
      sellerUrl: "https://www.ozon.ru/seller/high-yield-123/?miniapp=1",
    }),
    close: async () => { closed = true; },
  };
  const provider = createOzonDetailProvider({ context: { newPage: async () => page }, timeout: 5, pollInterval: 1 });
  const detail = await provider.getProductDetail("123", { sell_price: 90 });
  assert.equal(detail.mode, "FBS");
  assert.equal(detail.follow_min, 80);
  assert.equal(detail.detail_url, "https://www.ozon.ru/product/test-123/");
  assert.equal(detail.seller_url, "https://www.ozon.ru/seller/high-yield-123/?miniapp=1");
  assert.equal(closed, false);
  await provider.close();
  assert.equal(closed, true);
});

test("detail provider applies the configured timeout to product navigation", async () => {
  const navigations = [];
  const page = {
    goto: async (url, options) => { navigations.push({ url, options }); },
    evaluate: async () => ({
      url: "https://www.ozon.ru/product/timeout-contract/",
      title: "Ozon item",
      text: "title\n¥ 99\n发货模式： FBS",
    }),
    close: async () => {},
  };
  const provider = createOzonDetailProvider({
    context: { newPage: async () => page },
    timeout: 1_234,
    pollInterval: 1,
  });

  await provider.getProductDetail("timeout-contract", { sell_price: 90 });

  assert.deepEqual(navigations, [{
    url: "https://www.ozon.ru/product/timeout-contract",
    options: { waitUntil: "domcontentloaded", timeout: 1_234 },
  }]);
  await provider.close();
});

test("detail provider retries an exact navigation timeout once on a fresh page", async () => {
  const pages = [];
  const navigationTimeouts = [];
  let newPageCalls = 0;
  let accessControllerCalls = 0;
  const context = {
    newPage: async () => {
      newPageCalls += 1;
      const index = newPageCalls;
      let closed = false;
      const page = {
        isClosed: () => closed,
        goto: async (_url, options) => {
          navigationTimeouts.push(options.timeout);
          if (index === 1) throw new Error("page.goto: Timeout 1500ms exceeded");
        },
        evaluate: async () => ({
          url: "https://www.ozon.ru/product/fresh-page/",
          title: "Ozon item",
          text: "title\n¥ 99\n发货模式： FBS",
        }),
        close: async () => { closed = true; },
      };
      pages.push(page);
      return page;
    },
  };
  const provider = createOzonDetailProvider({
    context,
    accessController: {
      run: async (_request, operation) => {
        accessControllerCalls += 1;
        return operation();
      },
    },
    timeout: 1_500,
    pollInterval: 1,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });

  const detail = await provider.getProductDetail("poisoned-page", { sell_price: 90 });

  assert.equal(detail.mode, "FBS");
  assert.equal(pages[0].isClosed(), true);
  assert.equal(newPageCalls, 2);
  assert.equal(accessControllerCalls, 1);
  assert.deepEqual(navigationTimeouts, [1_500, 30_000]);
  assert.equal(pages[1].isClosed(), false);
  await provider.close();
  assert.equal(pages[1].isClosed(), true);
});

test("detail provider bounds a double navigation timeout to two fresh-page attempts", async () => {
  const pages = [];
  const navigationTimeouts = [];
  const context = {
    newPage: async () => {
      let closed = false;
      const page = {
        isClosed: () => closed,
        goto: async (_url, options) => {
          navigationTimeouts.push(options.timeout);
          throw new Error(`page.goto: Timeout ${options.timeout}ms exceeded.`);
        },
        evaluate: async () => assert.fail("a timed-out navigation must not be evaluated"),
        close: async () => { closed = true; },
      };
      pages.push(page);
      return page;
    },
  };
  const provider = createOzonDetailProvider({
    context,
    timeout: 12_000,
    pollInterval: 1,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });

  await assert.rejects(
    provider.getProductDetail("double-timeout", { sell_price: 90 }),
    /page\.goto: Timeout 30000ms exceeded/,
  );

  assert.equal(pages.length, 2);
  assert.deepEqual(navigationTimeouts, [12_000, 30_000]);
  assert.deepEqual(pages.map((page) => page.isClosed()), [true, true]);
  await provider.close();
});

test("detail provider does not retry a closed browser navigation failure", async () => {
  const pages = [];
  let newPageCalls = 0;
  const context = {
    newPage: async () => {
      newPageCalls += 1;
      let closed = false;
      const page = {
        isClosed: () => closed,
        goto: async () => {
          throw new Error("page.goto: Target page, context or browser has been closed");
        },
        evaluate: async () => assert.fail("a closed browser must not be evaluated"),
        close: async () => { closed = true; },
      };
      pages.push(page);
      return page;
    },
  };
  const provider = createOzonDetailProvider({
    context,
    timeout: 12_000,
    pollInterval: 1,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });

  await assert.rejects(
    provider.getProductDetail("closed-browser", { sell_price: 90 }),
    /browser has been closed/i,
  );

  assert.equal(newPageCalls, 1);
  assert.equal(pages[0].isClosed(), true);
  await provider.close();
});

test("detail provider does not retry an unstructured timeout lookalike", async () => {
  let newPageCalls = 0;
  let closed = false;
  const provider = createOzonDetailProvider({
    context: {
      newPage: async () => {
        newPageCalls += 1;
        return {
          isClosed: () => closed,
          goto: async () => {
            throw new Error("Ozon request Timeout 12000ms exceeded");
          },
          evaluate: async () => assert.fail("a failed navigation must not be evaluated"),
          close: async () => { closed = true; },
        };
      },
    },
    timeout: 12_000,
    pollInterval: 1,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });

  await assert.rejects(
    provider.getProductDetail("timeout-lookalike", { sell_price: 90 }),
    /Ozon request Timeout 12000ms exceeded/,
  );

  assert.equal(newPageCalls, 1);
  assert.equal(closed, true);
  await provider.close();
});

test("detail provider close reclaims a leased page and rejects queued waiters", async () => {
  let closed = false;
  let closeCalls = 0;
  let newPageCalls = 0;
  let rejectNavigation;
  let markNavigationStarted;
  const navigationStarted = new Promise((resolve) => { markNavigationStarted = resolve; });
  const page = {
    isClosed: () => closed,
    goto: async () => {
      markNavigationStarted();
      return new Promise((_, reject) => { rejectNavigation = reject; });
    },
    evaluate: async () => null,
    close: async () => {
      if (closed) return;
      closed = true;
      closeCalls += 1;
      rejectNavigation?.(new Error("Target page has been closed"));
    },
  };
  const provider = createOzonDetailProvider({
    context: {
      newPage: async () => {
        newPageCalls += 1;
        return page;
      },
    },
    timeout: 5,
    pollInterval: 1,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });

  const first = provider.getProductDetail("leased", { sell_price: 90 });
  await navigationStarted;
  const firstRejected = assert.rejects(first, /target page has been closed/i);
  const second = provider.getProductDetail("waiting", { sell_price: 90 });
  const secondRejected = assert.rejects(second, /provider is closed/i);
  await Promise.resolve();

  await provider.close();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(closeCalls, 1);
  assert.equal(newPageCalls, 1);
  await assert.rejects(
    provider.getProductDetail("after-close", { sell_price: 90 }),
    /provider is closed/i,
  );
});

test("detail provider waits for Maozi mode instead of accepting a long bare Ozon body", async () => {
  let calls = 0;
  const page = {
    goto: async () => {},
    evaluate: async () => {
      calls += 1;
      return calls === 1
        ? { url: "https://www.ozon.ru/product/321/", title: "loading", text: "x".repeat(5000), webPriceText: "10 ¥" }
        : { url: "https://www.ozon.ru/product/321/", title: "ready", text: "发货模式： FBS", webPriceText: "10 ¥" };
    },
    close: async () => {},
  };
  const provider = createOzonDetailProvider({ context: { newPage: async () => page }, timeout: 50, pollInterval: 1 });
  const detail = await provider.getProductDetail("321", { sell_price: 7283 });
  assert.equal(calls, 2);
  assert.equal(detail.mode, "FBS");
  assert.equal(detail.selected_price, 10);
});

test("detail provider never treats an untyped favorite fallback as CNY revenue", async () => {
  const page = {
    goto: async () => {},
    evaluate: async () => ({
      url: "https://www.ozon.ru/product/999/",
      title: "local product",
      text: "发货模式： FBS\n19 114 ₽",
      webPriceText: "19 114 ₽",
    }),
    close: async () => {},
  };
  const provider = createOzonDetailProvider({ context: { newPage: async () => page }, timeout: 1, pollInterval: 1 });
  const detail = await provider.getProductDetail("999", { sell_price: 19114 });
  assert.equal(detail.selected_price, null);
  await provider.close();
});

test("detail provider rejects an Ozon login page before using the favorite price fallback", async () => {
  const page = {
    goto: async () => {},
    evaluate: async () => ({
      url: "https://www.ozon.ru/login/",
      title: "Ozon ID",
      text: "Войти в аккаунт",
      webPriceText: "",
    }),
    close: async () => {},
  };
  const provider = createOzonDetailProvider({
    context: { newPage: async () => page },
    timeout: 1,
    pollInterval: 1,
  });
  await assert.rejects(
    provider.getProductDetail("login-page", {
      source_currency: "CNY",
      sell_price: 99,
    }),
    /authentication or MFA required/i,
  );
  await provider.close();
});

test("valid product evidence prevents a sidebar verification hint from becoming a CAPTCHA stop", async () => {
  assert.deepEqual(classifyOzonDetailAccessPayload({
    url: "https://www.ozon.ru/product/valid-123/",
    title: "Valid product",
    text: "\u767b\u5f55\u9a8c\u8bc1\u7801\u5e2e\u52a9\n\u53d1\u8d27\u6a21\u5f0f\uff1a FBS\n\u8ddf\u5356\u6700\u4f4e\u4ef7\uff1a \u00a5 80",
    webPriceText: "\u00a5 90",
  }), {
    captcha: false,
    authentication: false,
    productReady: true,
  });
});

test("detail provider requires persistent CAPTCHA evidence before stopping", async () => {
  let calls = 0;
  const page = {
    goto: async () => {},
    evaluate: async () => {
      calls += 1;
      return calls === 1
        ? {
          url: "https://www.ozon.ru/product/transient-123/",
          title: "Checking",
          text: "\u8bf7\u5b8c\u6210\u4eba\u673a\u9a8c\u8bc1",
          webPriceText: "",
        }
        : {
          url: "https://www.ozon.ru/product/transient-123/",
          title: "Ready",
          text: "\u53d1\u8d27\u6a21\u5f0f\uff1a FBS\n\u8ddf\u5356\u6700\u4f4e\u4ef7\uff1a \u00a5 80",
          webPriceText: "\u00a5 90",
        };
    },
    close: async () => {},
  };
  const provider = createOzonDetailProvider({
    context: { newPage: async () => page },
    timeout: 10,
    pollInterval: 1,
    captchaConfirmationDelayMs: 1,
  });
  const detail = await provider.getProductDetail("transient-123", { sell_price: 90 });
  assert.equal(detail.mode, "FBS");
  assert.equal(calls, 2);
  await provider.close();
});

test("detail provider still stops on two consecutive blocking CAPTCHA pages", async () => {
  let calls = 0;
  const page = {
    goto: async () => {},
    evaluate: async () => {
      calls += 1;
      return {
        url: "https://www.ozon.ru/product/blocked-123/",
        title: "Checking",
        text: "\u8bf7\u5b8c\u6210\u4eba\u673a\u9a8c\u8bc1",
        webPriceText: "",
      };
    },
    close: async () => {},
  };
  const provider = createOzonDetailProvider({
    context: { newPage: async () => page },
    timeout: 10,
    pollInterval: 1,
    captchaConfirmationDelayMs: 1,
  });
  await assert.rejects(
    provider.getProductDetail("blocked-123", { sell_price: 90 }),
    /after 2 confirmations/i,
  );
  assert.equal(calls, 2);
  await provider.close();
});
