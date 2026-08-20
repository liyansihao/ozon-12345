import test from "node:test";
import assert from "node:assert/strict";

import { main } from "../scripts/flow_b_playwright.mjs";
import {
  createPacedSupplyPageProvider,
  createSupplyPagePacer,
  installValidationSupplyMutationBlocker,
  shouldBlock1688SupplyMutation,
  supplyPageMinimumIntervalMs,
} from "../scripts/flow_b_playwright/supply-page-pacing.mjs";

test("supply detail pacing defaults off and is scoped to validation-only runs", () => {
  assert.equal(supplyPageMinimumIntervalMs({}), 0);
  assert.equal(supplyPageMinimumIntervalMs({
    FLOW_B_SUPPLY_PAGE_MIN_INTERVAL_MS: "0",
    FLOW_B_VALIDATION_ONLY: "0",
  }), 0);
  assert.equal(supplyPageMinimumIntervalMs({
    FLOW_B_SUPPLY_PAGE_MIN_INTERVAL_MS: " 1500 ",
    FLOW_B_VALIDATION_ONLY: "1",
  }), 1_500);
  assert.throws(
    () => supplyPageMinimumIntervalMs({
      FLOW_B_SUPPLY_PAGE_MIN_INTERVAL_MS: "1500",
      FLOW_B_VALIDATION_ONLY: "0",
    }),
    /allowed only when FLOW_B_VALIDATION_ONLY=1/u,
  );
  for (const invalid of ["-1", "1.5", "NaN", "9007199254740992"]) {
    assert.throws(
      () => supplyPageMinimumIntervalMs({
        FLOW_B_SUPPLY_PAGE_MIN_INTERVAL_MS: invalid,
        FLOW_B_VALIDATION_ONLY: "1",
      }),
      /must be a non-negative integer/u,
    );
  }
});

test("supply page pacer waits only for the unelapsed portion of the interval", async () => {
  let clock = 10_000;
  const sleeps = [];
  const pace = createSupplyPagePacer({
    minimumIntervalMs: 1_000,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });

  assert.equal(await pace(), 0);
  clock += 250;
  assert.equal(await pace(), 750);
  clock += 1_250;
  assert.equal(await pace(), 0);
  assert.deepEqual(sleeps, [750]);
});

test("paced page provider reuses its page and spaces every verifier lease", async () => {
  let clock = 1_000;
  const leaseTimes = [];
  const sleeps = [];
  const pages = [];
  const context = {
    async newPage() {
      const page = {
        closed: false,
        isClosed() { return this.closed; },
        async close() { this.closed = true; },
      };
      pages.push(page);
      return page;
    },
  };
  const session = createPacedSupplyPageProvider(context, {
    minimumIntervalMs: 1_000,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });

  const first = await session.pageProvider();
  leaseTimes.push(clock);
  clock += 200;
  const second = await session.pageProvider();
  leaseTimes.push(clock);
  assert.equal(second, first);

  first.closed = true;
  clock += 300;
  const third = await session.pageProvider();
  leaseTimes.push(clock);
  assert.notEqual(third, first);

  assert.deepEqual(leaseTimes, [1_000, 2_000, 3_000]);
  assert.deepEqual(sleeps, [800, 700]);
  assert.equal(pages.length, 2);
  await session.close();
  assert.equal(third.closed, true);
  assert.equal(session.page(), null);
});

test("validation transport guard blocks recognized 1688 purchase endpoints regardless of HTTP method", () => {
  for (const request of [
    { method: "POST", url: "https://cart.1688.com/cart/add" },
    { method: "POST", url: "https://cart.1688.com/addItem.do" },
    { method: "PUT", url: "https://trade.1688.com/order/submit" },
    { method: "PATCH", url: "https://detail.1688.com/offer/createOrder" },
    { method: "DELETE", url: "https://buyer.alibaba.com/checkout/session" },
    { method: "POST", url: "https://detail.1688.com/api?operation=addToCart" },
    { method: "GET", url: "https://cart.1688.com/cart/add" },
    { method: "GET", url: "https://trade.1688.com/order/create" },
    { method: "HEAD", url: "https://detail.1688.com/api?operation=buyNow" },
  ]) {
    assert.equal(shouldBlock1688SupplyMutation(request), true, JSON.stringify(request));
  }
  for (const request of [
    { method: "POST", url: "https://detail.1688.com/offer/123456789.html" },
    { method: "POST", url: "https://detail.1688.com/offer/sku/stock" },
    { method: "POST", url: "https://detail.1688.com/offer/orderable/quantity" },
    { method: "POST", url: "https://example.com/cart/add" },
  ]) {
    assert.equal(shouldBlock1688SupplyMutation(request), false, JSON.stringify(request));
  }
});

test("validation transport guard aborts mutations and falls through for detail APIs", async () => {
  let handler = null;
  const page = {
    async route(pattern, callback) {
      assert.equal(pattern, "**/*");
      handler = callback;
    },
  };
  await installValidationSupplyMutationBlocker(page);
  const actions = [];
  const fakeRoute = (method, url) => ({
    request: () => ({ method: () => method, url: () => url }),
    abort: async (reason) => { actions.push(["abort", reason]); },
    fallback: async () => { actions.push(["fallback"]); },
  });

  await handler(fakeRoute("POST", "https://trade.1688.com/order/create"));
  await handler(fakeRoute("GET", "https://cart.1688.com/cart/add"));
  await handler(fakeRoute("POST", "https://detail.1688.com/offer/sku/stock"));
  assert.deepEqual(actions, [
    ["abort", "blockedbyclient"],
    ["abort", "blockedbyclient"],
    ["fallback"],
  ]);
});

test("paced provider installs the mutation guard only when explicitly requested", async () => {
  const routeCounts = [];
  const context = {
    async newPage() {
      const page = {
        isClosed: () => false,
        close: async () => {},
        route: async () => { routeCounts.push(1); },
      };
      return page;
    },
  };
  const guarded = createPacedSupplyPageProvider(context, {
    blockMutatingPurchaseRequests: true,
  });
  await guarded.pageProvider();
  await guarded.pageProvider();
  assert.equal(routeCounts.length, 1);
  await guarded.close();

  const unguarded = createPacedSupplyPageProvider(context);
  await unguarded.pageProvider();
  assert.equal(routeCounts.length, 1);
  await unguarded.close();
});

test("validation provider fails closed when its request guard cannot be installed", async () => {
  let closed = 0;
  const context = {
    async newPage() {
      return {
        isClosed: () => false,
        close: async () => { closed += 1; },
      };
    },
  };
  const session = createPacedSupplyPageProvider(context, {
    blockMutatingPurchaseRequests: true,
  });
  await assert.rejects(
    session.pageProvider(),
    /page\.route is required for validation-only supply mutation blocking/u,
  );
  assert.equal(closed, 1);
  assert.equal(session.page(), null);
});

test("nonzero supply pacing fails before publish can launch a browser", async () => {
  await assert.rejects(
    main(["publish", "/tmp/flow-b-pacing-scope"], {
      FLOW_B_SUPPLY_PAGE_MIN_INTERVAL_MS: "250",
      FLOW_B_VALIDATION_ONLY: "0",
    }),
    /FLOW_B_SUPPLY_PAGE_MIN_INTERVAL_MS is allowed only when FLOW_B_VALIDATION_ONLY=1/u,
  );
  await assert.rejects(
    main(["validate-supply", "/tmp/flow-b-pacing-invalid"], {
      FLOW_B_SUPPLY_PAGE_MIN_INTERVAL_MS: "1.5",
    }),
    /FLOW_B_SUPPLY_PAGE_MIN_INTERVAL_MS must be a non-negative integer/u,
  );
});
