# Flow B Playwright Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Flow B's AppleScript browser automation with one resumable Playwright pipeline that scans candidates and publishes 100 products with verified CEL Economy profit rate strictly greater than 30% to the first normalized-name match for 丽丽1号 / lysh.

**Architecture:** Keep browser and Maozi API orchestration in focused Node.js ES modules under `scripts/flow_b_playwright/`. Keep `1688_image_median.py` as the sourcing-cost engine and call it through a JSON/file bridge. Use injected transports in tests so automated verification never sends a real publish request.

**Tech Stack:** Node.js 22 ESM, Playwright 1.61, Node `node:test`, Python 3.11, existing `unittest` suite, JSON/JSONL checkpoints.

## Global Constraints

- The final profit threshold is strictly greater than 30%; a value of exactly 30 is rejected.
- A publishable result requires CEL Economy plus `cate_rate > 0` and `cate_fee > 0`.
- The publish target is 100 newly confirmed successes.
- The store match is normalized substring `丽丽1号`; the watermark match is normalized substring `lysh`; when multiple rows match, select the first API row.
- Individual SKU failures are recorded and processing continues.
- There is no dry-run or one-item canary in the production `publish` and `run` commands.
- Automated tests must not access the real publish endpoint.
- Historical run directories and data files must not be deleted.
- Existing unrelated dirty-worktree changes must be preserved.

---

## File Structure

Create:

- `flow_b_codex_transfer_20260608/scripts/flow_b_playwright/browser-context.mjs` — Chrome for Testing, profile, extension, pages, login checks.
- `flow_b_codex_transfer_20260608/scripts/flow_b_playwright/maozi-client.mjs` — authenticated Maozi API calls and response validation.
- `flow_b_codex_transfer_20260608/scripts/flow_b_playwright/publish-policy.mjs` — pure matching, filtering, price, FBS, and profit gates.
- `flow_b_codex_transfer_20260608/scripts/flow_b_playwright/publish-state.mjs` — JSONL checkpoints, dedupe, summary, recovery state.
- `flow_b_codex_transfer_20260608/scripts/flow_b_playwright/cost-bridge.mjs` — image download, Python process invocation, output parsing.
- `flow_b_codex_transfer_20260608/scripts/flow_b_playwright/publish-runner.mjs` — end-to-end per-SKU orchestration.
- `flow_b_codex_transfer_20260608/scripts/flow_b_playwright/source-scanner.mjs` — existing seller discovery and multi-page scanning behavior extracted from the CLI.
- `flow_b_codex_transfer_20260608/tests-js/*.test.mjs` — Node unit and integration-contract tests.

Modify:

- `flow_b_codex_transfer_20260608/scripts/flow_b_playwright.mjs` — thin CLI only.
- `flow_b_codex_transfer_20260608/scripts/flow_b_scan_high_yield_sources.py` — call the canonical Playwright commands.
- `flow_b_codex_transfer_20260608/config/flow_b.json` — threshold 30, target 100, store/watermark search names.
- `flow_b_codex_transfer_20260608/README_TRANSFER.md` — supported commands and recovery behavior.
- `package.json` — one setup/scan/publish/run command family and Node tests.

Retain:

- `flow_b_codex_transfer_20260608/scripts/1688_image_median.py`
- Python tests that cover 1688 price clusters and cost selection.
- Historical data and run artifacts.

Delete only after reference audit in Task 8:

- `flow_b_chrome_js.py`, `flow_b_chrome_js_tab.py`
- `flow_b_add_to_maozi_favorites.py`, `flow_b_check_gap_ready.py`
- `flow_b_continue_current_page_scan.py`, `flow_b_detail_extract.py`
- `flow_b_enrich_source_candidates.py`, `flow_b_find_seller_sources.py`
- `flow_b_playwright_gap_browser.mjs`, `flow_b_playwright_gap_scan.mjs`
- `flow_b_rescan_sources_deep.py`, `flow_b_rescan_sources_multitab.py`
- `flow_b_resume_gap_to_maozi.sh`, `flow_b_retry_publish_payloads.py`
- `flow_b_scroll_sources.py`, `flow_b_seed_favorites_from_scan.py`
- `flow_b_process_batch.py`, `run_flow_b.sh`

---

### Task 1: Pure Publish Policy

**Files:**
- Create: `flow_b_codex_transfer_20260608/scripts/flow_b_playwright/publish-policy.mjs`
- Create: `flow_b_codex_transfer_20260608/tests-js/publish-policy.test.mjs`

**Interfaces:**
- Produces: `normalizeName(value)`, `selectNamedResource(rows, needle, label)`, `selectSalePrice(detail)`, `isPureFbs(mode)`, `preflightSkipReason(item)`, `profitSkipReason(calc, threshold)`.
- Consumes: plain JSON values only.

- [ ] **Step 1: Write failing policy tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeName,
  selectNamedResource,
  selectSalePrice,
  isPureFbs,
  profitSkipReason,
} from "../scripts/flow_b_playwright/publish-policy.mjs";

test("normalized substring matching selects the first resource", () => {
  const rows = [{ id: 1, name: "其他" }, { id: 2, name: "丽丽 1号 店铺" }, { id: 3, name: "丽丽1号备用" }];
  assert.equal(normalizeName("丽丽 1号-店铺"), "丽丽1号店铺");
  assert.deepEqual(selectNamedResource(rows, "丽丽1号", "store"), rows[1]);
});

test("missing resource throws a global configuration error", () => {
  assert.throws(() => selectNamedResource([{ id: 1, name: "其他" }], "lysh", "watermark"), /watermark not found/);
});

test("sale price is the lower positive Ozon and follow price", () => {
  assert.equal(selectSalePrice({ current_price: 120, follow_min: 99 }), 99);
  assert.equal(selectSalePrice({ current_price: 120, follow_min: 0 }), 120);
});

test("only pure FBS mode is accepted", () => {
  assert.equal(isPureFbs("FBS"), true);
  assert.equal(isPureFbs("FBO,FBS"), false);
  assert.equal(isPureFbs(undefined), false);
});

test("profit gate is strict and requires category commission", () => {
  assert.match(profitSkipReason({ profit_rate: 30, cate_rate: 12, cate_fee: 9, purchase_price: 10, sell_price: 100 }, 30), /profit_rate/);
  assert.match(profitSkipReason({ profit_rate: 30.01, cate_rate: 0, cate_fee: 9, purchase_price: 10, sell_price: 100 }, 30), /cate_rate/);
  assert.equal(profitSkipReason({ profit_rate: 30.01, cate_rate: 12, cate_fee: 9, purchase_price: 10, sell_price: 100 }, 30), null);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test flow_b_codex_transfer_20260608/tests-js/publish-policy.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `publish-policy.mjs`.

- [ ] **Step 3: Add the minimal pure policy implementation**

```js
const PROHIBITED = [/еда|пищ|корм|food/i, /одеж|плать|fashion|服装/i, /телефон|смартфон|ноутбук|3c/i, /жидк|спрей|порош|клей|масло|лекар|витамин/i, /манекен|anatomical|人体模型/i];

export function normalizeName(value) {
  return String(value ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function selectNamedResource(rows, needle, label) {
  const normalized = normalizeName(needle);
  const found = rows.find((row) => normalizeName(row.name ?? row.title).includes(normalized));
  if (!found) throw new Error(`${label} not found: ${needle}`);
  return found;
}

export function selectSalePrice({ current_price, follow_min }) {
  const values = [current_price, follow_min].map(Number).filter((value) => value > 0);
  return values.length ? Math.min(...values) : null;
}

export function isPureFbs(mode) {
  const parts = String(mode ?? "").split(",").map((part) => part.trim().toUpperCase()).filter(Boolean);
  return parts.length === 1 && parts[0] === "FBS";
}

export function preflightSkipReason(item) {
  const text = `${item.title ?? ""} ${item.category ?? ""}`;
  if (!isPureFbs(item.mode)) return "non-pure-fbs";
  return PROHIBITED.find((pattern) => pattern.test(text)) ? "prohibited-category" : null;
}

export function profitSkipReason(calc, threshold = 30) {
  if (!(Number(calc.purchase_price) > 0)) return "purchase_price<=0";
  if (!(Number(calc.sell_price) > 0)) return "sell_price<=0";
  if (!(Number(calc.cate_rate) > 0)) return "cate_rate<=0";
  if (!(Number(calc.cate_fee) > 0)) return "cate_fee<=0";
  if (!(Number(calc.profit_rate) > threshold)) return `profit_rate<=${threshold}`;
  return null;
}
```

- [ ] **Step 4: Run policy tests and verify GREEN**

Run: `node --test flow_b_codex_transfer_20260608/tests-js/publish-policy.test.mjs`

Expected: 5 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add flow_b_codex_transfer_20260608/scripts/flow_b_playwright/publish-policy.mjs flow_b_codex_transfer_20260608/tests-js/publish-policy.test.mjs
git commit -m "feat: add Flow B publish policy"
```

### Task 2: Resumable Publish State

**Files:**
- Create: `flow_b_codex_transfer_20260608/scripts/flow_b_playwright/publish-state.mjs`
- Create: `flow_b_codex_transfer_20260608/tests-js/publish-state.test.mjs`

**Interfaces:**
- Produces: `createPublishState({ runDir, publishedCsv })` returning `load()`, `transition(sku, status, data)`, `hasPublished(sku)`, `summary(target)`, `recordPublished(item)`.
- Consumes: filesystem paths and plain JSON events.

- [ ] **Step 1: Write failing state tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPublishState } from "../scripts/flow_b_playwright/publish-state.mjs";

test("state restores the latest event and never republishes success", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-state-"));
  const state = createPublishState({ runDir: dir, publishedCsv: path.join(dir, "published.csv") });
  await state.transition("123", "processing", { attempt: 1 });
  await state.transition("123", "published", { link: "https://www.ozon.ru/product/123" });
  const restored = createPublishState({ runDir: dir, publishedCsv: path.join(dir, "published.csv") });
  await restored.load();
  assert.equal(restored.hasPublished("123"), true);
  assert.deepEqual(restored.summary(100), { published: 1, failed: 0, skipped: 0, remaining: 99 });
});

test("failed state remains retryable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-state-"));
  const state = createPublishState({ runDir: dir, publishedCsv: path.join(dir, "published.csv") });
  await state.transition("9", "failed", { error: "timeout" });
  assert.equal(state.hasPublished("9"), false);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test flow_b_codex_transfer_20260608/tests-js/publish-state.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement append-only JSONL state and atomic summary writes**

Implement `createPublishState` with an in-memory `Map`, append events to `sku_states.jsonl`, append terminal events to `published.jsonl`, `failed.jsonl`, or `skipped.jsonl`, update `summary.json` through `summary.json.tmp` plus `rename`, and read the existing CSV to seed published SKUs. `recordPublished` must append only one canonical Ozon URL per SKU.

```js
export function canonicalProductUrl(sku) {
  return `https://www.ozon.ru/product/${String(sku)}`;
}
```

- [ ] **Step 4: Run state tests and verify GREEN**

Run: `node --test flow_b_codex_transfer_20260608/tests-js/publish-state.test.mjs`

Expected: 2 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add flow_b_codex_transfer_20260608/scripts/flow_b_playwright/publish-state.mjs flow_b_codex_transfer_20260608/tests-js/publish-state.test.mjs
git commit -m "feat: add resumable Flow B publish state"
```

### Task 3: Playwright Browser Context

**Files:**
- Create: `flow_b_codex_transfer_20260608/scripts/flow_b_playwright/browser-context.mjs`
- Create: `flow_b_codex_transfer_20260608/tests-js/browser-context.test.mjs`
- Modify: `flow_b_codex_transfer_20260608/scripts/flow_b_playwright.mjs`

**Interfaces:**
- Produces: `resolveBrowserOptions(env)`, `launchFlowContext(options)`, `assertMaoziLogin(page)`, `assertPluginLoaded(context)`.
- Consumes: Playwright `chromium`, profile path, extension path, optional executable override.

- [ ] **Step 1: Write failing option-resolution tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { resolveBrowserOptions } from "../scripts/flow_b_playwright/browser-context.mjs";

test("browser options require an unpacked extension and use Chrome for Testing", () => {
  const options = resolveBrowserOptions({ FLOW_B_PW_PROFILE: "/tmp/profile", FLOW_B_EXTENSION_DIR: "/tmp/extension" }, "/tmp/cft");
  assert.equal(options.executablePath, "/tmp/cft");
  assert.deepEqual(options.args.slice(-2), ["--disable-extensions-except=/tmp/extension", "--load-extension=/tmp/extension"]);
  assert.deepEqual(options.ignoreDefaultArgs, ["--disable-extensions"]);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test flow_b_codex_transfer_20260608/tests-js/browser-context.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Extract browser launch code from the monolithic CLI**

`resolveBrowserOptions` must validate `manifest.json`, use `chromium.executablePath()` by default, launch headed persistent context, and include the extension flags. `assertMaoziLogin` must require a non-empty `maozierp-core-access.accessToken`. `assertPluginLoaded` must wait for an extension service worker or a `chrome-extension://` background target and throw if none appears.

- [ ] **Step 4: Run the unit test and a read-only browser smoke check**

Run:

```bash
node --test flow_b_codex_transfer_20260608/tests-js/browser-context.test.mjs
FLOW_B_EXTENSION_DIR=/Users/mac/Downloads/maozi-plugin-3.0.9/maozi-plugin-3.0.9 npm run flow:b:playwright:setup
```

Expected: unit test passes; headed Chrome for Testing opens with the extension. Stop setup with `Ctrl+C` after observing the startup message.

- [ ] **Step 5: Commit**

```bash
git add flow_b_codex_transfer_20260608/scripts/flow_b_playwright/browser-context.mjs flow_b_codex_transfer_20260608/scripts/flow_b_playwright.mjs flow_b_codex_transfer_20260608/tests-js/browser-context.test.mjs
git commit -m "refactor: centralize Flow B Playwright context"
```

### Task 4: Maozi API Client and Resource Resolution

**Files:**
- Create: `flow_b_codex_transfer_20260608/scripts/flow_b_playwright/maozi-client.mjs`
- Create: `flow_b_codex_transfer_20260608/tests-js/maozi-client.test.mjs`

**Interfaces:**
- Produces: `createMaoziClient({ transport })` with `listFavorites()`, `listShops()`, `listWatermarks()`, `resolvePublishTarget()`, `getCategoryBySku(sku)`, `calculateProfit(input)`, `publish(payload)`, `findPublishedSku(sku)`.
- Transport signature: `transport(path, { method = "GET", query, body }) -> Promise<{ status, json }>`.

- [ ] **Step 1: Write failing client contract tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createMaoziClient } from "../scripts/flow_b_playwright/maozi-client.mjs";

test("client paginates favorites and resolves first fuzzy target", async () => {
  const calls = [];
  const transport = async (path, request) => {
    calls.push([path, request]);
    if (path === "/api.product.favorite/lists") return { status: 200, json: { code: 1, data: { data: [{ sku: 1 }], last_page: 1 } } };
    if (path === "/api.shop/lists") return { status: 200, json: { code: 1, data: [{ id: 7, name: "丽丽 1号 店铺" }] } };
    if (path === "/api.watermark/templates") return { status: 200, json: { code: 1, data: [{ id: 8, name: "LYSH 主水印" }] } };
    throw new Error(path);
  };
  const client = createMaoziClient({ transport });
  assert.deepEqual(await client.listFavorites(), [{ sku: 1 }]);
  assert.deepEqual(await client.resolvePublishTarget({ storeNeedle: "丽丽1号", watermarkNeedle: "lysh" }), { store: { id: 7, name: "丽丽 1号 店铺" }, watermark: { id: 8, name: "LYSH 主水印" } });
});

test("publish accepts only explicit Maozi success", async () => {
  const ok = createMaoziClient({ transport: async () => ({ status: 200, json: { code: 1, msg: "success" } }) });
  const bad = createMaoziClient({ transport: async () => ({ status: 200, json: { code: 0, msg: "failed" } }) });
  assert.equal((await ok.publish({ rows: [] })).ok, true);
  assert.equal((await bad.publish({ rows: [] })).ok, false);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test flow_b_codex_transfer_20260608/tests-js/maozi-client.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement endpoints and browser-page transport**

Use these verified plugin endpoints:

- `/api.product.favorite/lists`
- `/api.shop/lists`
- `/api.watermark/templates`
- `/api.tool/get_category_by_sku`
- `/api.tool/calc_profit`
- `/api.selection.follow/import`

The production transport runs `fetch` inside the authenticated Maozi page, sets `Accept-Language: zh-CN`, `Client: pc`, and bearer token, and returns parsed status plus JSON. `resolvePublishTarget` delegates to `selectNamedResource` from Task 1.

- [ ] **Step 4: Run client and policy tests**

Run: `node --test flow_b_codex_transfer_20260608/tests-js/maozi-client.test.mjs flow_b_codex_transfer_20260608/tests-js/publish-policy.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add flow_b_codex_transfer_20260608/scripts/flow_b_playwright/maozi-client.mjs flow_b_codex_transfer_20260608/tests-js/maozi-client.test.mjs
git commit -m "feat: add authenticated Maozi client"
```

### Task 5: 1688 Cost Bridge and Cost Reliability

**Files:**
- Create: `flow_b_codex_transfer_20260608/scripts/flow_b_playwright/cost-bridge.mjs`
- Create: `flow_b_codex_transfer_20260608/tests-js/cost-bridge.test.mjs`
- Retain: `flow_b_codex_transfer_20260608/scripts/1688_image_median.py`

**Interfaces:**
- Produces: `parseCostOutput(text, sellPrice)`, `createCostBridge({ python, scriptPath, runProcess, download })`, `estimate(item, runDir)`.
- Consumes: candidate `{ sku, cover_image, sell_price, title, category, model }`.

- [ ] **Step 1: Write failing parser tests using real output labels**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { parseCostOutput } from "../scripts/flow_b_playwright/cost-bridge.mjs";

test("accepts a reliable filtered first-page P70 cost", () => {
  const text = [
    "VALID_COUNT 5",
    "P70_COST 21.3",
    "COST_SOURCE search_first_page_p70_similarity_filtered",
    "FILTERED_FIRST_PAGE_PRICES [17, 19.8, 21.3, 23.8]",
  ].join("\n");
  assert.deepEqual(parseCostOutput(text, 100), { ok: true, cost: 21.3, source: "search_first_page_p70_similarity_filtered", prices: [17, 19.8, 21.3, 23.8] });
});

test("rejects insufficient evidence and cost near sale price", () => {
  assert.match(parseCostOutput("P70_COST 90\nCOST_SOURCE search_first_page_p70_similarity_filtered\nFILTERED_FIRST_PAGE_PRICES [80,90]", 100).reason, /insufficient/);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test flow_b_codex_transfer_20260608/tests-js/cost-bridge.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the bridge**

Port only `parse_costs` output interpretation from `flow_b_process_batch.py`. Download the cover image to `runDir/images/<sku>.jpg`, invoke `python3 scripts/1688_image_median.py <image>`, save stdout/stderr to `runDir/1688/<sku>.out`, reuse a cached output containing `P70_COST`, and return a structured result. Reject fewer than three filtered prices, non-positive prices, spread greater than five, or cost at least 85% of sale price.

- [ ] **Step 4: Run Node parser tests and existing Python cost tests**

Run:

```bash
node --test flow_b_codex_transfer_20260608/tests-js/cost-bridge.test.mjs
python3 -m unittest flow_b_codex_transfer_20260608/tests/test_1688_price_clusters.py tests/test_1688_p70_cost.py
```

Expected: Node tests pass; existing Python tests pass or any pre-existing failure is documented before changing cost behavior.

- [ ] **Step 5: Commit**

```bash
git add flow_b_codex_transfer_20260608/scripts/flow_b_playwright/cost-bridge.mjs flow_b_codex_transfer_20260608/tests-js/cost-bridge.test.mjs
git commit -m "feat: bridge Playwright flow to 1688 costs"
```

### Task 6: Publish Runner, Failure Continuation, and Target Count

**Files:**
- Create: `flow_b_codex_transfer_20260608/scripts/flow_b_playwright/publish-runner.mjs`
- Create: `flow_b_codex_transfer_20260608/tests-js/publish-runner.test.mjs`

**Interfaces:**
- Produces: `createPublishRunner({ client, costBridge, state, policy, target, threshold, now })` with `run()` and `processItem(item, targetConfig)`.
- Consumes: interfaces from Tasks 1, 2, 4, and 5.

- [ ] **Step 1: Write failing orchestration tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createPublishRunner } from "../scripts/flow_b_playwright/publish-runner.mjs";

test("runner records a failed SKU and continues until confirmed success target", async () => {
  const transitions = [];
  const published = new Set();
  const state = {
    hasPublished: (sku) => published.has(String(sku)),
    transition: async (sku, status, data) => transitions.push({ sku: String(sku), status, data }),
    recordPublished: async (item) => published.add(String(item.sku)),
    summary: () => ({ published: published.size }),
  };
  const client = {
    resolvePublishTarget: async () => ({ store: { id: 7, name: "丽丽1号" }, watermark: { id: 8, name: "lysh" } }),
    listFavorites: async () => [{ sku: 1, mode: "FBS", title: "safe", current_price: 100 }, { sku: 2, mode: "FBS", title: "safe", current_price: 100 }],
    getProductDetail: async (sku) => ({ sku, mode: "FBS", title: "safe", current_price: 100, follow_min: 90 }),
    calculateProfit: async ({ sku }) => ({ sku, profit_rate: 40, cate_rate: 12, cate_fee: 8, purchase_price: 20, sell_price: 90 }),
    publish: async (payload) => payload.rows[0].sku === "1" ? { ok: false, error: "timeout" } : { ok: true, response: { code: 1 } },
    findPublishedSku: async () => false,
  };
  const costBridge = { estimate: async () => ({ ok: true, cost: 20 }) };
  const runner = createPublishRunner({ client, costBridge, state, target: 1, threshold: 30, now: () => new Date("2026-07-12T00:00:00Z") });
  const result = await runner.run();
  assert.equal(result.published, 1);
  assert.ok(transitions.some((event) => event.sku === "1" && event.status === "failed"));
  assert.equal(published.has("2"), true);
});

test("runner does not submit profit rate exactly 30", async () => {
  let publishCalls = 0;
  const transitions = [];
  const state = {
    hasPublished: () => false,
    transition: async (sku, status, data) => transitions.push({ sku: String(sku), status, data }),
    recordPublished: async () => { throw new Error("must not publish"); },
    summary: () => ({ published: 0 }),
  };
  const client = {
    resolvePublishTarget: async () => ({ store: { id: 7, name: "丽丽1号" }, watermark: { id: 8, name: "lysh" } }),
    listFavorites: async () => [{ sku: 3, mode: "FBS", title: "safe", current_price: 100 }],
    getProductDetail: async () => ({ sku: 3, mode: "FBS", title: "safe", current_price: 100, follow_min: 90 }),
    calculateProfit: async () => ({ profit_rate: 30, cate_rate: 12, cate_fee: 8, purchase_price: 20, sell_price: 90 }),
    publish: async () => { publishCalls += 1; return { ok: true }; },
    findPublishedSku: async () => false,
  };
  const runner = createPublishRunner({ client, costBridge: { estimate: async () => ({ ok: true, cost: 20 }) }, state, target: 1, threshold: 30, now: () => new Date("2026-07-12T00:00:00Z") });
  await runner.run();
  assert.equal(publishCalls, 0);
  assert.ok(transitions.some((event) => event.status === "skipped" && event.data.reason === "profit_rate<=30"));
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test flow_b_codex_transfer_20260608/tests-js/publish-runner.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement runner behavior**

For each candidate: dedupe, mark `processing`, fetch detail, apply preflight rules, select price, estimate cost, calculate CEL Economy profit, apply strict profit gate, build one-row publish payload, call publish, and count only `{ ok: true }`. Catch per-item errors, write `failed`, and continue. Before retrying a restored `processing` or `failed` SKU, call `findPublishedSku`; if found, record success without resubmitting. Stop requesting candidates as soon as this run reaches `target` confirmed successes.

The payload must contain:

```js
{
  scene: "erp",
  shop_ids: [target.store.id],
  brand: "none",
  image_order: "none",
  watermark_id: target.watermark.id,
  floating_price: null,
  rows: [{ id, sku, title, cover_image, link, sell_price, price, old_price, offer_id, brand: "", source: "favorite", source_currency: "CNY" }],
}
```

- [ ] **Step 4: Run all Node tests**

Run: `node --test flow_b_codex_transfer_20260608/tests-js/*.test.mjs`

Expected: all Node tests pass and no real network requests occur.

- [ ] **Step 5: Commit**

```bash
git add flow_b_codex_transfer_20260608/scripts/flow_b_playwright/publish-runner.mjs flow_b_codex_transfer_20260608/tests-js/publish-runner.test.mjs
git commit -m "feat: orchestrate resumable Flow B publishing"
```

### Task 7: Canonical CLI and Configuration

**Files:**
- Modify: `flow_b_codex_transfer_20260608/scripts/flow_b_playwright.mjs`
- Modify: `flow_b_codex_transfer_20260608/config/flow_b.json`
- Modify: `package.json`
- Create: `flow_b_codex_transfer_20260608/tests-js/cli.test.mjs`

**Interfaces:**
- CLI: `setup [RUN_DIR]`, `scan URLS.txt OUT.json`, `publish RUN_DIR`, `run RUN_DIR URLS.txt`.
- Environment: `FLOW_B_PW_PROFILE`, `FLOW_B_EXTENSION_DIR`, `FLOW_B_PROFIT_THRESHOLD=30`, `FLOW_B_TARGET_PUBLISH_COUNT=100`.

- [ ] **Step 1: Write a failing CLI parse test**

Extract and test `parseCli(argv, env)` so it returns numeric threshold 30, numeric target 100, store needle `丽丽1号`, and watermark needle `lysh`. Verify invalid commands and missing paths throw without launching a browser.

- [ ] **Step 2: Run and verify RED**

Run: `node --test flow_b_codex_transfer_20260608/tests-js/cli.test.mjs`

Expected: FAIL because `parseCli` and the new commands do not exist.

- [ ] **Step 3: Make the entry file thin**

Move `findSellers`, `scanSellers`, `scrollAndCollectProducts`, and `scanOne` into `scripts/flow_b_playwright/source-scanner.mjs`. Import that scanner, the Task 3 context, and Task 6 runner; keep only argument parsing, dependency construction, command dispatch, structured error output, and context cleanup in `flow_b_playwright.mjs`.

Set `config/flow_b.json` to:

```json
{
  "flow": "B",
  "profit": {
    "profit_rate_threshold_percent": 30,
    "publish_when_profit_rate_is_strictly_greater_than_threshold": true
  },
  "target": { "published_count": 100 },
  "publish_target": { "store_name_contains": "丽丽1号", "watermark_name_contains": "lysh" }
}
```

Preserve unrelated existing config fields while replacing contradictory threshold values.

Update npm scripts to only expose `flow:b:setup`, `flow:b:scan`, `flow:b:publish`, `flow:b:run`, and `test:flow-b`.

- [ ] **Step 4: Run CLI and syntax verification**

Run:

```bash
node --check flow_b_codex_transfer_20260608/scripts/flow_b_playwright.mjs
npm run flow:b:run -- --help
npm run test:flow-b
```

Expected: syntax exit 0, help exits 0 without a browser, all Node tests pass.

- [ ] **Step 5: Commit**

```bash
git add package.json flow_b_codex_transfer_20260608/config/flow_b.json flow_b_codex_transfer_20260608/scripts/flow_b_playwright.mjs flow_b_codex_transfer_20260608/tests-js/cli.test.mjs
git commit -m "feat: expose canonical Flow B Playwright CLI"
```

### Task 8: Delete Superseded Code and Update Consumers

**Files:**
- Delete: the legacy file list in the File Structure section.
- Modify: `flow_b_codex_transfer_20260608/scripts/flow_b_scan_high_yield_sources.py`
- Modify: `flow_b_codex_transfer_20260608/README_TRANSFER.md`
- Modify or delete: Python tests whose target files are removed.

**Interfaces:**
- Consumes: canonical CLI from Task 7.
- Produces: no supported path to `osascript`, AppleScript, or duplicate Playwright launchers.

- [ ] **Step 1: Capture the reference audit before deletion**

Run:

```bash
rg -n "flow_b_chrome_js|osascript|flow_b_playwright_gap|flow_b_rescan_sources|flow_b_process_batch|run_flow_b" flow_b_codex_transfer_20260608 package.json tests --glob '!runs/**'
```

Expected: every source reference is assigned either to a replacement edit in this task or to a test that will be migrated/deleted.

- [ ] **Step 2: Update active consumers and documentation**

Change `flow_b_scan_high_yield_sources.py` to invoke `node scripts/flow_b_playwright.mjs scan ...`. Rewrite README examples to use `npm run flow:b:setup`, `scan`, `publish`, and `run`; document direct real publishing, strict `>30%`, failure continuation, target 100, and the required extension path.

- [ ] **Step 3: Delete superseded files with `apply_patch`**

Delete every legacy file listed in the File Structure section. Remove Python tests that test only deleted AppleScript wrappers. Migrate still-relevant pure URL and filtering assertions into Node policy tests before deleting their Python targets.

- [ ] **Step 4: Prove no supported AppleScript references remain**

Run:

```bash
rg -n "osascript|tell application \"Google Chrome\"|flow_b_chrome_js|flow_b_playwright_gap" flow_b_codex_transfer_20260608/scripts package.json
```

Expected: no matches.

- [ ] **Step 5: Run full regression suite**

Run:

```bash
npm run test:flow-b
python3 -m unittest discover -s tests -p 'test_*.py'
python3 -m unittest discover -s flow_b_codex_transfer_20260608/tests -p 'test_*.py'
git diff --check
```

Expected: all retained tests pass, no whitespace errors. If a pre-existing test fails, verify it fails on the pre-task baseline and document it rather than weakening the new behavior.

- [ ] **Step 6: Commit**

```bash
git add -A flow_b_codex_transfer_20260608 package.json tests
git commit -m "refactor: remove legacy Flow B browser automation"
```

### Task 9: Read-Only Live Verification

**Files:**
- Modify only if verification exposes a defect: modules created in Tasks 3-7 and their tests.
- Create runtime artifacts only under: `output/playwright/` and a new `runs/flow_b/<timestamp>_playwright_publish/` directory.

**Interfaces:**
- Consumes: logged-in Playwright profile and Maozi 3.0.9 extension.
- Produces: verification evidence without calling `/api.selection.follow/import`.

- [ ] **Step 1: Stop any setup process that holds the profile**

Send `Ctrl+C` to the active setup session and confirm no process uses the profile path.

- [ ] **Step 2: Run read-only login, extension, favorites, store, and watermark checks**

Add a `verify` command that launches the same dependencies as `publish` but stops after: login check, extension check, one favorites page, `/api.shop/lists`, `/api.watermark/templates`, and resource resolution. It must print the selected store and watermark IDs and must never construct or send a publish payload.

Run:

```bash
FLOW_B_PW_PROFILE="$PWD/flow_b_codex_transfer_20260608/runs/flow_b/playwright_setup/playwright_profile" \
FLOW_B_EXTENSION_DIR=/Users/mac/Downloads/maozi-plugin-3.0.9/maozi-plugin-3.0.9 \
node flow_b_codex_transfer_20260608/scripts/flow_b_playwright.mjs verify
```

Expected: exit 0; output contains authenticated status, extension version, favorite count, selected store name/ID, selected watermark name/ID.

- [ ] **Step 3: Run final automated verification**

Run:

```bash
npm run test:flow-b
python3 -m unittest discover -s tests -p 'test_*.py'
python3 -m unittest discover -s flow_b_codex_transfer_20260608/tests -p 'test_*.py'
node --check flow_b_codex_transfer_20260608/scripts/flow_b_playwright.mjs
rg -n "osascript|tell application \"Google Chrome\"" flow_b_codex_transfer_20260608/scripts package.json
git diff --check
```

Expected: all tests and syntax checks pass, `rg` returns no matches, and diff check exits 0.

- [ ] **Step 4: Commit any verification-only fixes**

If Step 2 or Step 3 required a code correction, add a failing regression test first, verify RED, apply the smallest fix, verify GREEN, and commit with `fix: correct Playwright publish verification`. If no correction was required, do not create an empty commit.

---

## Plan Self-Review Results

- Every design requirement maps to Tasks 1-9.
- Browser launch, API access, business policy, cost bridge, state, orchestration, CLI, cleanup, and live verification have separate testable boundaries.
- Production publish behavior is exercised only through injected transports in automated tests.
- The only live verification is read-only and cannot call the import endpoint.
- Exact function names and payload fields are consistent across tasks.
- No historical data deletion is included.
