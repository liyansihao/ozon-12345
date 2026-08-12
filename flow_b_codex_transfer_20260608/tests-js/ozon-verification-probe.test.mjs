import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyOzonVerificationSnapshot,
  probeOzonVerification,
} from "../scripts/flow_b_playwright/ozon-verification-probe.mjs";

test("verification probe requires real Ozon product or listing structure", () => {
  assert.equal(classifyOzonVerificationSnapshot({
    url: "https://www.ozon.ru/seller/example/",
    title: "Example — интернет-магазин на OZON",
    text: "Обычная страница товара ".repeat(40),
    http_status: 200,
    product_link_count: 3,
  }).classification, "READY");

  assert.equal(classifyOzonVerificationSnapshot({
    url: "https://www.ozon.ru/product/example-123/",
    title: "Example купить на OZON",
    text: "Цена 1000 ₽",
    http_status: 200,
    product_evidence: true,
  }).classification, "READY");

  assert.equal(classifyOzonVerificationSnapshot({
    url: "https://www.ozon.ru/seller/example/",
    title: "OZON",
    text: "Пустая страница",
    http_status: 200,
  }).classification, "INDETERMINATE");
});

test("verification probe never clears CAPTCHA, authentication, soft blocks, or technical uncertainty", () => {
  for (const [snapshot, expected, reason] of [
    [{
      url: "https://www.ozon.ru/seller/example/",
      title: "Подтвердите, что вы не робот — CAPTCHA",
      text: "Проверка",
      http_status: 200,
    }, "BLOCKED", "captcha-present"],
    [{
      url: "https://www.ozon.ru/login/",
      title: "Ozon ID — войти",
      text: "Авторизуйтесь",
      http_status: 200,
    }, "BLOCKED", "authentication-present"],
    [{
      url: "https://www.ozon.ru/seller/example/",
      title: "OZON",
      text: "Доступ ограничен",
      http_status: 200,
    }, "BLOCKED", "soft-block-present"],
    [{
      url: "https://www.ozon.ru/seller/example/",
      error: "net::ERR_NAME_NOT_RESOLVED",
    }, "INDETERMINATE", "probe-technical-error"],
  ]) {
    const result = classifyOzonVerificationSnapshot(snapshot);
    assert.equal(result.classification, expected);
    assert.equal(result.reason, reason);
  }
});

test("valid product structure wins over incidental login help text", () => {
  const result = classifyOzonVerificationSnapshot({
    url: "https://www.ozon.ru/product/example-123/",
    title: "Example купить на OZON",
    text: "Цена 1000 ₽. Помощь: как войти в аккаунт.",
    http_status: 200,
    product_evidence: true,
  });
  assert.equal(result.classification, "READY");
  assert.equal(result.authentication, false);
});

test("verification probe requires a 2xx response and blocks a visible login dialog", () => {
  for (const httpStatus of [undefined, null, 302]) {
    assert.equal(classifyOzonVerificationSnapshot({
      url: "https://www.ozon.ru/seller/example/",
      title: "Example — OZON",
      text: "Товары",
      http_status: httpStatus,
      product_link_count: 3,
    }).classification, "INDETERMINATE");
  }
  assert.equal(classifyOzonVerificationSnapshot({
    url: "https://www.ozon.ru/seller/example/",
    title: "Example — OZON",
    text: "Товары",
    security_text: "Войдите в аккаунт Ozon ID",
    http_status: 200,
    product_link_count: 3,
  }).classification, "BLOCKED");
});

test("verification probe closes only its own page and never closes the shared browser", async () => {
  let pageCloseCalls = 0;
  let browserCloseCalls = 0;
  const page = {
    goto: async () => ({ status: () => 200 }),
    evaluate: async () => ({
      url: "https://www.ozon.ru/seller/example/",
      title: "Example — OZON",
      text: "Товары",
      security_text: "",
      product_link_count: 3,
      product_evidence: false,
    }),
    close: async () => { pageCloseCalls += 1; },
  };
  const browserType = {
    connectOverCDP: async () => ({
      contexts: () => [{ newPage: async () => page }],
      close: async () => { browserCloseCalls += 1; },
    }),
  };
  const result = await probeOzonVerification({
    cdpEndpoint: "http://127.0.0.1:9223",
    url: "https://www.ozon.ru/seller/example/",
    timeoutMs: 5_000,
    settleMs: 100,
    browserType,
  });
  assert.equal(result.classification, "READY");
  assert.equal(pageCloseCalls, 1);
  assert.equal(browserCloseCalls, 0);
});

test("verification probe enforces its deadline when page inspection and cleanup hang", async () => {
  let pageCloseCalls = 0;
  let browserCloseCalls = 0;
  const page = {
    url: () => "https://www.ozon.ru/seller/example/",
    goto: async () => ({ status: () => 200 }),
    evaluate: async () => new Promise(() => {}),
    close: async () => {
      pageCloseCalls += 1;
      return new Promise(() => {});
    },
  };
  const browserType = {
    connectOverCDP: async () => ({
      contexts: () => [{ newPage: async () => page }],
      close: async () => { browserCloseCalls += 1; },
    }),
  };
  const startedAt = Date.now();
  const result = await probeOzonVerification({
    cdpEndpoint: "http://127.0.0.1:9223",
    url: "https://www.ozon.ru/seller/example/",
    timeoutMs: 250,
    settleMs: 10,
    browserType,
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.classification, "INDETERMINATE");
  assert.equal(result.reason, "probe-technical-error");
  assert.match(result.error, /page inspection timed out/iu);
  assert.ok(elapsedMs < 1_000, `probe exceeded its deadline: ${elapsedMs}ms`);
  assert.equal(pageCloseCalls, 1);
  assert.equal(browserCloseCalls, 0);
});

test("a hanging own-page close cannot suppress a conclusive probe result", async () => {
  let pageCloseCalls = 0;
  const page = {
    goto: async () => ({ status: () => 200 }),
    evaluate: async () => ({
      url: "https://www.ozon.ru/seller/example/",
      title: "Example — OZON",
      text: "Товары",
      security_text: "",
      product_link_count: 3,
      product_evidence: false,
    }),
    close: async () => {
      pageCloseCalls += 1;
      return new Promise(() => {});
    },
  };
  const startedAt = Date.now();
  const result = await probeOzonVerification({
    cdpEndpoint: "http://127.0.0.1:9223",
    url: "https://www.ozon.ru/seller/example/",
    timeoutMs: 250,
    settleMs: 10,
    browserType: {
      connectOverCDP: async () => ({
        contexts: () => [{ newPage: async () => page }],
      }),
    },
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.classification, "READY");
  assert.ok(elapsedMs < 1_000, `cleanup suppressed the result: ${elapsedMs}ms`);
  assert.equal(pageCloseCalls, 1);
});
