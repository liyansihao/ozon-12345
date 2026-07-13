import test from "node:test";
import assert from "node:assert/strict";

import { createOzonDetailProvider, parseOzonDetailText } from "../scripts/flow_b_playwright/ozon-detail.mjs";

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
    follow_min: 88.2,
    selected_price: 88.2,
    fallback_price: 95,
    current_price_rub_suspect: false,
  });
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

test("Playwright detail provider closes its page and returns parsed facts", async () => {
  let closed = false;
  const page = {
    goto: async () => {},
    evaluate: async () => ({
      url: "https://www.ozon.ru/product/test-123/",
      title: "Ozon item",
      text: "title\n¥ 99\n发货模式： FBS\n跟卖最低价： ¥ 80\n选品标签：x",
    }),
    close: async () => { closed = true; },
  };
  const provider = createOzonDetailProvider({ context: { newPage: async () => page }, timeout: 5, pollInterval: 1 });
  const detail = await provider.getProductDetail("123", { sell_price: 90 });
  assert.equal(detail.mode, "FBS");
  assert.equal(detail.follow_min, 80);
  assert.equal(detail.detail_url, "https://www.ozon.ru/product/test-123/");
  assert.equal(closed, true);
});
