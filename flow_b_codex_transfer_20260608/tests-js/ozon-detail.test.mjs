import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyOzonDetailAccessPayload,
  createOzonDetailProvider,
  parseOzonDetailText,
} from "../scripts/flow_b_playwright/ozon-detail.mjs";
import { createOzonAccessController } from "../scripts/flow_b_playwright/ozon-access-controller.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
    options: { waitUntil: "commit", timeout: 1_234 },
  }]);
  await provider.close();
});

test("detail provider reads a committed product without waiting for DOMContentLoaded", async () => {
  const navigations = [];
  const page = {
    goto: async (url, options) => {
      navigations.push({ url, options });
      if (options.waitUntil !== "commit") return new Promise(() => {});
      return { status: () => 200 };
    },
    evaluate: async () => ({
      url: "https://www.ozon.ru/product/commit-ready-123/",
      title: "Ozon item",
      text: "title\n¥ 99\n发货模式： FBS",
    }),
    close: async () => {},
  };
  const provider = createOzonDetailProvider({
    context: { newPage: async () => page },
    timeout: 20,
    pollInterval: 1,
    operationBudgetMs: 40,
  });

  const detail = await provider.getProductDetail("commit-ready-123", { sell_price: 90 });

  assert.equal(detail.mode, "FBS");
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].url, "https://www.ozon.ru/product/commit-ready-123");
  assert.equal(navigations[0].options.waitUntil, "commit");
  assert.ok(navigations[0].options.timeout > 0 && navigations[0].options.timeout <= 40);
  await provider.close();
});

test("detail provider polls a committed empty document to its product-ready deadline and discards it", async () => {
  let evaluations = 0;
  let newPageCalls = 0;
  const closedPages = [];
  const provider = createOzonDetailProvider({
    context: {
      newPage: async () => {
        newPageCalls += 1;
        const pageNumber = newPageCalls;
        let closed = false;
        return {
          isClosed: () => closed,
          goto: async (_url, options) => {
            assert.equal(options.waitUntil, "commit");
            return { status: () => 200 };
          },
          evaluate: async () => {
            evaluations += 1;
            return {
              url: "https://www.ozon.ru/product/empty-after-commit/",
              title: "",
              text: "",
              webPriceText: "",
              sellerUrl: "",
            };
          },
          close: async () => {
            if (closed) return;
            closed = true;
            closedPages.push(pageNumber);
          },
        };
      },
    },
    timeout: 8,
    pollInterval: 1,
    operationBudgetMs: 50,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });

  await assert.rejects(
    provider.getProductDetail("empty-after-commit", { sell_price: 90 }),
    (error) => error?.code === "OZON_DETAIL_DEADLINE" && error?.phase === "product-ready",
  );
  assert.ok(evaluations >= 2);
  assert.equal(newPageCalls, 2);
  assert.deepEqual(closedPages, [1, 2]);
  await provider.close();
});

test("detail provider retries one fresh page when the first committed document never becomes ready", async () => {
  const pages = [];
  let newPageCalls = 0;
  const provider = createOzonDetailProvider({
    context: {
      newPage: async () => {
        newPageCalls += 1;
        const pageNumber = newPageCalls;
        let closed = false;
        const page = {
          isClosed: () => closed,
          goto: async (_url, options) => {
            assert.equal(options.waitUntil, "commit");
            return { status: () => 200 };
          },
          evaluate: async () => pageNumber === 1
            ? {
              url: "https://www.ozon.ru/product/fresh-after-empty/",
              title: "",
              text: "",
            }
            : {
              url: "https://www.ozon.ru/product/fresh-after-empty/",
              title: "ready",
              text: "发货模式： FBS",
            },
          close: async () => { closed = true; },
        };
        pages.push(page);
        return page;
      },
    },
    timeout: 6,
    pollInterval: 1,
    operationBudgetMs: 50,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });

  const detail = await provider.getProductDetail("fresh-after-empty", { sell_price: 90 });

  assert.equal(detail.mode, "FBS");
  assert.equal(newPageCalls, 2);
  assert.equal(pages[0].isClosed(), true);
  assert.equal(pages[1].isClosed(), false);
  await provider.close();
  assert.equal(pages[1].isClosed(), true);
});

test("product-ready retry spends the original operation deadline instead of resetting it", async () => {
  const navigationTimeouts = [];
  let newPageCalls = 0;
  const provider = createOzonDetailProvider({
    context: {
      newPage: async () => {
        newPageCalls += 1;
        const pageNumber = newPageCalls;
        return {
          isClosed: () => false,
          goto: async (_url, options) => {
            navigationTimeouts.push(options.timeout);
            return { status: () => 200 };
          },
          evaluate: async () => pageNumber === 1
            ? {
              url: "https://www.ozon.ru/product/shared-deadline/",
              title: "",
              text: "",
            }
            : {
              url: "https://www.ozon.ru/product/shared-deadline/",
              title: "ready",
              text: "发货模式： FBS",
            },
          close: async () => {},
        };
      },
    },
    timeout: 10,
    retryNavigationTimeoutMs: 100,
    pollInterval: 1,
    operationBudgetMs: 30,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });

  assert.equal((await provider.getProductDetail("shared-deadline", { sell_price: 90 })).mode, "FBS");
  assert.equal(newPageCalls, 2);
  assert.equal(navigationTimeouts.length, 2);
  assert.ok(navigationTimeouts[0] > 20 && navigationTimeouts[0] <= 30);
  assert.ok(navigationTimeouts[1] > 0 && navigationTimeouts[1] <= 20);
  await provider.close();
});

test("detail provider rejects committed wrong-origin, login, and CAPTCHA documents and discards them", async () => {
  const cases = [
    {
      sku: "wrong-origin",
      payload: {
        url: "https://example.com/product/wrong-origin/",
        title: "lookalike",
        text: "发货模式： FBS",
      },
      message: /unexpected product location/i,
    },
    {
      sku: "login-after-commit",
      payload: {
        url: "https://www.ozon.ru/login/",
        title: "Ozon ID",
        text: "Войти в аккаунт",
      },
      message: /authentication or MFA required/i,
    },
    {
      sku: "captcha-after-commit",
      payload: {
        url: "https://www.ozon.ru/product/captcha-after-commit/",
        title: "Checking",
        text: "请完成人机验证",
      },
      message: /CAPTCHA required/i,
    },
  ];

  for (const entry of cases) {
    let closed = false;
    let newPageCalls = 0;
    const provider = createOzonDetailProvider({
      context: {
        newPage: async () => {
          newPageCalls += 1;
          return {
            isClosed: () => closed,
            goto: async (_url, options) => {
              assert.equal(options.waitUntil, "commit");
              return { status: () => 200 };
            },
            evaluate: async () => entry.payload,
            close: async () => { closed = true; },
          };
        },
      },
      timeout: 10,
      pollInterval: 1,
      captchaConfirmations: 1,
      operationBudgetMs: 50,
      initialConcurrency: 1,
      maxConcurrency: 1,
    });

    await assert.rejects(
      provider.getProductDetail(entry.sku, { sell_price: 90 }),
      entry.message,
    );
    assert.equal(newPageCalls, 1, `${entry.sku} must not retry`);
    assert.equal(closed, true, `${entry.sku} page should be discarded`);
    await provider.close();
  }
});

test("detail provider fails closed on a committed HTTP error before inspecting the page", async () => {
  let evaluations = 0;
  let closed = false;
  let newPageCalls = 0;
  const provider = createOzonDetailProvider({
    context: {
      newPage: async () => {
        newPageCalls += 1;
        return {
          isClosed: () => closed,
          goto: async (_url, options) => {
            assert.equal(options.waitUntil, "commit");
            return { status: () => 503 };
          },
          evaluate: async () => { evaluations += 1; },
          close: async () => { closed = true; },
        };
      },
    },
    timeout: 10,
    operationBudgetMs: 50,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });

  await assert.rejects(
    provider.getProductDetail("http-error", { sell_price: 90 }),
    /HTTP 503/i,
  );
  assert.equal(newPageCalls, 1);
  assert.equal(evaluations, 0);
  assert.equal(closed, true);
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

test("access-controller queue wait does not consume each detail execution budget", async () => {
  let gotoCalls = 0;
  let evaluateCalls = 0;
  let closeCalls = 0;
  const page = {
    isClosed: () => false,
    goto: async () => { gotoCalls += 1; },
    evaluate: async () => {
      evaluateCalls += 1;
      return {
        url: `https://www.ozon.ru/product/queued-${evaluateCalls}/`,
        title: "Ozon item",
        text: "发货模式： FBS",
      };
    },
    close: async () => { closeCalls += 1; },
  };
  const accessController = createOzonAccessController({ minIntervalMs: 10 });
  const provider = createOzonDetailProvider({
    context: { newPage: async () => page },
    accessController,
    timeout: 1,
    retryNavigationTimeoutMs: 5,
    operationGraceMs: 2,
    operationBudgetMs: 15,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });

  const details = await Promise.all(Array.from({ length: 8 }, (_, index) => (
    provider.getProductDetail(`queued-${index + 1}`, { sell_price: 90 })
  )));

  assert.deepEqual(details.map((detail) => detail.mode), Array(8).fill("FBS"));
  assert.equal(gotoCalls, 8);
  assert.equal(evaluateCalls, 8);
  await provider.close();
  assert.equal(closeCalls, 1);
});

test("an expired access-controller detail never opens a page and later detail work proceeds", async () => {
  const releaseBlocker = deferred();
  const blockerStarted = deferred();
  let newPageCalls = 0;
  let evaluateCalls = 0;
  const accessController = createOzonAccessController({ minIntervalMs: 0 });
  const blocker = accessController.run({ kind: "source" }, async () => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
  });
  await blockerStarted.promise;
  const provider = createOzonDetailProvider({
    context: {
      newPage: async () => {
        newPageCalls += 1;
        return {
          isClosed: () => false,
          goto: async () => {},
          evaluate: async () => {
            evaluateCalls += 1;
            return {
              url: "https://www.ozon.ru/product/after-expired/",
              title: "Ozon item",
              text: "发货模式： FBS",
            };
          },
          close: async () => {},
        };
      },
    },
    accessController,
    queueWaitBudgetMs: 10,
    operationBudgetMs: 50,
    timeout: 1,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });

  const expired = provider.getProductDetail("expired-before-access", { sell_price: 90 });
  await assert.rejects(
    expired,
    (error) => error?.code === "OZON_DETAIL_DEADLINE" && error?.phase === "access-queue",
  );
  assert.equal(newPageCalls, 0);
  assert.equal(evaluateCalls, 0);

  releaseBlocker.resolve();
  await blocker;
  assert.equal((await provider.getProductDetail("after-expired", { sell_price: 90 })).mode, "FBS");
  assert.equal(newPageCalls, 1);
  assert.equal(evaluateCalls, 1);
  await provider.close();
});

test("provider close cancels queued access exactly once without opening or stealing a page", async () => {
  const releaseBlocker = deferred();
  const blockerStarted = deferred();
  let newPageCalls = 0;
  let afterCalls = 0;
  const accessController = createOzonAccessController({ minIntervalMs: 0 });
  const blocker = accessController.run({ kind: "source" }, async () => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
  });
  await blockerStarted.promise;
  const provider = createOzonDetailProvider({
    context: {
      newPage: async () => {
        newPageCalls += 1;
        return {
          isClosed: () => false,
          goto: async () => {},
          evaluate: async () => ({
            url: "https://www.ozon.ru/product/should-not-open/",
            title: "Ozon item",
            text: "发货模式： FBS",
          }),
          close: async () => {},
        };
      },
    },
    accessController,
    queueWaitBudgetMs: 10,
    operationBudgetMs: 50,
    timeout: 1,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });

  const queued = Array.from({ length: 12 }, (_, index) => (
    provider.getProductDetail(`close-cancel-race-${index + 1}`, { sell_price: 90 })
  ));
  const queuedAssertions = queued.map((operation) => assert.rejects(operation, /provider is closed/i));
  await provider.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseBlocker.resolve();
  await Promise.all([...queuedAssertions, blocker]);

  assert.equal(newPageCalls, 0);
  await accessController.run({ kind: "publish-detail" }, async () => { afterCalls += 1; });
  assert.equal(afterCalls, 1);
});

test("a running detail hang remains bounded and releases the access-controller queue without ghost work", async () => {
  let newPageCalls = 0;
  let firstCloseCalls = 0;
  let firstEvaluateCalls = 0;
  let secondEvaluateCalls = 0;
  const accessController = createOzonAccessController({ minIntervalMs: 0 });
  const provider = createOzonDetailProvider({
    context: {
      newPage: async () => {
        newPageCalls += 1;
        const index = newPageCalls;
        return {
          isClosed: () => false,
          goto: async () => {},
          evaluate: async () => {
            if (index === 1) {
              firstEvaluateCalls += 1;
              return new Promise(() => {});
            }
            secondEvaluateCalls += 1;
            return {
              url: "https://www.ozon.ru/product/after-hang/",
              title: "Ozon item",
              text: "发货模式： FBS",
            };
          },
          close: async () => { if (index === 1) firstCloseCalls += 1; },
        };
      },
    },
    accessController,
    timeout: 1,
    retryNavigationTimeoutMs: 5,
    operationGraceMs: 2,
    operationBudgetMs: 15,
    pageCleanupTimeoutMs: 2,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });
  const startedAt = Date.now();
  const hung = provider.getProductDetail("hung-controller-detail", { sell_price: 90 });
  const after = provider.getProductDetail("after-hang", { sell_price: 90 });

  await assert.rejects(
    hung,
    (error) => error?.code === "OZON_DETAIL_DEADLINE" && error?.phase === "page-inspection",
  );
  assert.ok(Date.now() - startedAt < 250);
  assert.equal((await after).mode, "FBS");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(firstEvaluateCalls, 1);
  assert.equal(secondEvaluateCalls, 1);
  assert.equal(firstCloseCalls, 1);
  assert.equal(newPageCalls, 2);
  await provider.close();
});

test("detail provider retries a transient Ozon product navigation failure once on a fresh page", async () => {
  const pages = [];
  let newPageCalls = 0;
  const context = {
    newPage: async () => {
      newPageCalls += 1;
      const index = newPageCalls;
      let closed = false;
      const page = {
        isClosed: () => closed,
        goto: async () => {
          if (index === 1) {
            throw new Error([
              "page.goto: net::ERR_FAILED at https://www.ozon.ru/product/transient-product-123/",
              "Call log:",
            ].join("\n"));
          }
        },
        evaluate: async () => ({
          url: "https://www.ozon.ru/product/transient-product-123/",
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
    timeout: 12_000,
    pollInterval: 1,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });

  const detail = await provider.getProductDetail("transient-product-123", { sell_price: 90 });

  assert.equal(detail.mode, "FBS");
  assert.equal(newPageCalls, 2);
  assert.equal(pages[0].isClosed(), true);
  assert.equal(pages[1].isClosed(), false);
  await provider.close();
  assert.equal(pages[1].isClosed(), true);
});

test("detail provider does not retry a non-product or persistent navigation error", async () => {
  for (const message of [
    "page.goto: net::ERR_FAILED at https://www.ozon.ru/seller/example/",
    "page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.ozon.ru/product/example-123/",
  ]) {
    let newPageCalls = 0;
    let closed = false;
    const provider = createOzonDetailProvider({
      context: {
        newPage: async () => {
          newPageCalls += 1;
          return {
            isClosed: () => closed,
            goto: async () => { throw new Error(message); },
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

    await assert.rejects(provider.getProductDetail("example-123", { sell_price: 90 }), /net::ERR_/);
    assert.equal(newPageCalls, 1);
    assert.equal(closed, true);
    await provider.close();
  }
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
  const waitUntilValues = [];
  let newPageCalls = 0;
  const context = {
    newPage: async () => {
      newPageCalls += 1;
      let closed = false;
      const page = {
        isClosed: () => closed,
        goto: async (_url, options) => {
          waitUntilValues.push(options.waitUntil);
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
  assert.deepEqual(waitUntilValues, ["commit"]);
  assert.equal(pages[0].isClosed(), true);
  await provider.close();
});

test("detail provider does not retry a browser closure after document commit", async () => {
  let newPageCalls = 0;
  let evaluateCalls = 0;
  let closeCalls = 0;
  const provider = createOzonDetailProvider({
    context: {
      newPage: async () => {
        newPageCalls += 1;
        return {
          isClosed: () => false,
          goto: async (_url, options) => {
            assert.equal(options.waitUntil, "commit");
            return { status: () => 200 };
          },
          evaluate: async () => {
            evaluateCalls += 1;
            throw new Error("page.evaluate: Session closed. Most likely the page has been closed.");
          },
          close: async () => { closeCalls += 1; },
        };
      },
    },
    timeout: 10,
    pollInterval: 1,
    operationBudgetMs: 50,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });

  await assert.rejects(
    provider.getProductDetail("closed-after-commit", { sell_price: 90 }),
    /page has been closed/i,
  );
  assert.equal(newPageCalls, 1);
  assert.equal(evaluateCalls, 1);
  assert.equal(closeCalls, 1);
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
  const provider = createOzonDetailProvider({
    context: { newPage: async () => page },
    timeout: 50,
    pollInterval: 1,
    operationBudgetMs: 200,
  });
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
    operationBudgetMs: 200,
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
    operationBudgetMs: 200,
  });
  await assert.rejects(
    provider.getProductDetail("blocked-123", { sell_price: 90 }),
    /after 2 confirmations/i,
  );
  assert.equal(calls, 2);
  await provider.close();
});

test("detail provider bounds an initial page creation that never settles and close stays bounded", async () => {
  const provider = createOzonDetailProvider({
    context: { newPage: async () => new Promise(() => {}) },
    timeout: 1,
    retryNavigationTimeoutMs: 5,
    operationGraceMs: 2,
    operationBudgetMs: 8,
    pageCleanupTimeoutMs: 2,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });
  const startedAt = Date.now();
  await assert.rejects(
    provider.getProductDetail("hung-create", { sell_price: 90 }),
    (error) => error?.code === "OZON_DETAIL_DEADLINE" && error?.phase === "page-create",
  );
  assert.ok(Date.now() - startedAt < 250);
  const closeStartedAt = Date.now();
  await provider.close();
  assert.ok(Date.now() - closeStartedAt < 250);
});

test("a timed-out queued detail waiter cannot steal the released page", async () => {
  let releaseFirst;
  let firstNavigationStarted;
  const firstStarted = new Promise((resolve) => { firstNavigationStarted = resolve; });
  let firstEvaluation = true;
  let newPageCalls = 0;
  let evaluateCalls = 0;
  const page = {
    isClosed: () => false,
    goto: async () => {},
    evaluate: async () => {
      if (firstEvaluation) {
        firstEvaluation = false;
        firstNavigationStarted();
        await new Promise((resolve) => { releaseFirst = resolve; });
      }
      evaluateCalls += 1;
      return {
        url: "https://www.ozon.ru/product/queue/",
        title: "Ozon item",
        text: "发货模式： FBS",
      };
    },
    close: async () => {},
  };
  const provider = createOzonDetailProvider({
    context: { newPage: async () => { newPageCalls += 1; return page; } },
    timeout: 1,
    retryNavigationTimeoutMs: 15,
    operationGraceMs: 2,
    operationBudgetMs: (sku) => sku === "queue-timeout" ? 10 : 50,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });
  const first = provider.getProductDetail("queue-first", { sell_price: 90 });
  first.catch(() => {});
  await firstStarted;
  const queued = provider.getProductDetail("queue-timeout", { sell_price: 90 });
  queued.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 15));
  await assert.rejects(
    queued,
    (error) => error?.code === "OZON_DETAIL_DEADLINE",
  );
  releaseFirst();
  await first;
  await provider.getProductDetail("queue-third", { sell_price: 90 });
  assert.equal(newPageCalls, 1);
  assert.equal(evaluateCalls, 2);
  await provider.close();
});

test("retry cleanup is bounded when the poisoned page close hangs", async () => {
  let calls = 0;
  const provider = createOzonDetailProvider({
    context: {
      newPage: async () => {
        calls += 1;
        const index = calls;
        return {
          isClosed: () => false,
          goto: async (_url, options) => {
            if (index === 1) throw new Error(`page.goto: Timeout ${options.timeout}ms exceeded.`);
          },
          evaluate: async () => ({
            url: "https://www.ozon.ru/product/retry-close/",
            title: "Ozon item",
            text: "发货模式： FBS",
          }),
          close: async () => index === 1 ? new Promise(() => {}) : undefined,
        };
      },
    },
    timeout: 1,
    retryNavigationTimeoutMs: 20,
    operationGraceMs: 5,
    pageCleanupTimeoutMs: 2,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });
  assert.equal((await provider.getProductDetail("retry-close", { sell_price: 90 })).mode, "FBS");
  assert.equal(calls, 2);
  await provider.close();
});

test("a late retry page is closed once after its creation deadline", async () => {
  let newPageCalls = 0;
  let lateCloseCalls = 0;
  const latePage = {
    isClosed: () => false,
    goto: async () => {},
    evaluate: async () => assert.fail("an abandoned late page must not be evaluated"),
    close: async () => { lateCloseCalls += 1; },
  };
  const provider = createOzonDetailProvider({
    context: {
      newPage: async () => {
        newPageCalls += 1;
        if (newPageCalls === 2) {
          return new Promise((resolve) => setTimeout(() => resolve(latePage), 15));
        }
        return {
          isClosed: () => false,
          goto: async (_url, options) => { throw new Error(`page.goto: Timeout ${options.timeout}ms exceeded.`); },
          evaluate: async () => null,
          close: async () => {},
        };
      },
    },
    timeout: 1,
    retryNavigationTimeoutMs: 5,
    operationGraceMs: 2,
    operationBudgetMs: 8,
    pageCleanupTimeoutMs: 2,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });
  await assert.rejects(
    provider.getProductDetail("late-retry", { sell_price: 90 }),
    (error) => error?.code === "OZON_DETAIL_DEADLINE",
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(lateCloseCalls, 1);
  await provider.close();
  assert.equal(lateCloseCalls, 1);
});

test("a timed-out page inspection poisons and closes the page", async () => {
  let newPageCalls = 0;
  let closeCalls = 0;
  const provider = createOzonDetailProvider({
    context: {
      newPage: async () => {
        newPageCalls += 1;
        return {
          isClosed: () => false,
          goto: async () => {},
          evaluate: async () => new Promise(() => {}),
          close: async () => { closeCalls += 1; },
        };
      },
    },
    timeout: 1,
    retryNavigationTimeoutMs: 5,
    operationGraceMs: 2,
    operationBudgetMs: 8,
    pageCleanupTimeoutMs: 2,
    initialConcurrency: 1,
    maxConcurrency: 1,
  });
  await assert.rejects(
    provider.getProductDetail("hung-inspection", { sell_price: 90 }),
    (error) => error?.code === "OZON_DETAIL_DEADLINE" && error?.phase === "page-inspection",
  );
  assert.equal(newPageCalls, 1);
  assert.equal(closeCalls, 1);
  await provider.close();
});
