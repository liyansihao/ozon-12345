import test from "node:test";
import assert from "node:assert/strict";

import { publishedProductUrls, selectSellerUrl, sellerDiscoveryFailureState } from "../scripts/flow_b_playwright/seller-discovery.mjs";

test("seller discovery prefers the current-seller widget and canonicalizes its URL", () => {
  assert.equal(selectSellerUrl([
    { href: "https://www.ozon.ru/seller/recommended/?sorting=rating", current: false },
    { href: "https://www.ozon.ru/seller/current-store/?miniapp=seller_123", current: true },
  ]), "https://www.ozon.ru/seller/current-store/");
});

test("seller discovery only reads strict valid unique publications", () => {
  const rows = [
    { sku: "1", status: "published", link: "https://www.ozon.ru/product/1", data: { profit_rate: 31 } },
    { sku: "1", status: "published", link: "https://www.ozon.ru/product/1-copy", data: { profit_rate: 80 } },
    { sku: "2", status: "published", link: "https://www.ozon.ru/product/2", data: { profit_rate: 30 } },
    { sku: "2815247918", status: "published", link: "https://www.ozon.ru/product/2815247918", data: { profit_rate: 90 } },
  ];
  assert.deepEqual(publishedProductUrls(rows), ["https://www.ozon.ru/product/1"]);
});

test("seller discovery stops after two fully blocked batches", () => {
  const first = sellerDiscoveryFailureState({ consecutiveBlocked: 0, batchSize: 2, failed: 2 });
  const second = sellerDiscoveryFailureState({ consecutiveBlocked: first.consecutiveBlocked, batchSize: 2, failed: 2 });
  assert.deepEqual(first, { consecutiveBlocked: 1, stop: false });
  assert.deepEqual(second, { consecutiveBlocked: 2, stop: true });
  assert.deepEqual(sellerDiscoveryFailureState({ consecutiveBlocked: 2, batchSize: 2, failed: 1 }), { consecutiveBlocked: 0, stop: false });
});
