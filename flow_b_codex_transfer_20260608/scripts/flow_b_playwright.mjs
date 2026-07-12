#!/usr/bin/env node
/**
 * Flow B browser automation.
 *
 * This is the canonical browser entry point for Flow B.  It uses one
 * persistent Playwright context for both Ozon and Maozi, so cookies,
 * localStorage and an optional Maozi extension are shared by every page.
 * Login/CAPTCHA is intentionally left to the user.
 *
 * Examples:
 *   node scripts/flow_b_playwright.mjs setup RUN_DIR
 *   node scripts/flow_b_playwright.mjs find-sellers --highlight-url URL --resume RUN_DIR
 *   node scripts/flow_b_playwright.mjs scan-sellers URLS.txt OUT.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  assertMaoziLogin,
  launchFlowContext,
  resolveBrowserOptions,
} from "./flow_b_playwright/browser-context.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function flag(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function required(value, name) {
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

function profileDir(runDir) {
  return process.env.FLOW_B_PW_PROFILE || path.join(runDir, "playwright_profile");
}

async function openContext(runDir) {
  const profile = profileDir(runDir);
  const options = resolveBrowserOptions({ ...process.env, FLOW_B_PW_PROFILE: profile });
  const context = await launchFlowContext(options);
  return { context, profile };
}

async function pageFor(context, url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  return page;
}

async function waitForContent(page, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      ready: document.readyState,
      title: document.title,
      bodyLength: document.body?.innerText?.length || 0,
      products: document.querySelectorAll('a[href*="/product/"]').length,
    })).catch(() => ({}));
    if (state.ready === "complete" && (state.bodyLength > 1000 || state.products > 0)) return state;
    await sleep(700);
  }
  return page.evaluate(() => ({ ready: document.readyState, title: document.title, bodyLength: document.body?.innerText?.length || 0, products: document.querySelectorAll('a[href*="/product/"]').length })).catch(() => ({}));
}

function parsePrice(text) {
  const normalized = String(text || "").replace(/[\u00a0\u202f\u2009]/g, " ");
  const match = normalized.match(/([0-9][0-9\s]*)(?:,(\d{1,2}))?\s*¥/);
  if (!match) return null;
  const value = Number(`${match[1].replace(/\s/g, "")}.${(match[2] || "0").padEnd(2, "0")}`);
  return Number.isFinite(value) ? value : null;
}

function normalizeSellerUrl(value, minPrice) {
  const url = new URL(value, "https://www.ozon.ru");
  if (!/\.ozon\.ru$/i.test(url.hostname) || !url.pathname.match(/^\/seller\/[^/]+/)) return null;
  const seller = url.pathname.split("/").filter(Boolean)[1];
  return `https://www.ozon.ru/seller/${seller}/?currency_price=${Number(minPrice).toFixed(3)}%3B`;
}

async function collectProducts(page, minPrice) {
  return page.evaluate(() => {
    const seen = new Set();
    const rows = [];
    for (const anchor of document.querySelectorAll('a[href*="/product/"]')) {
      const href = String(anchor.href || "").split("?")[0];
      if (!href.includes("/product/") || seen.has(href)) continue;
      let card = anchor.closest('div[class*="tile-root"]') || anchor;
      for (let i = 0; i < 5 && card.parentElement && !String(card.innerText || "").includes("¥"); i += 1) card = card.parentElement;
      rows.push({ href, text: String(card.innerText || anchor.innerText || "").trim().slice(0, 1200) });
      seen.add(href);
    }
    return rows;
  }).then((rows) => rows.map((row) => ({ ...row, price: parsePrice(row.text) })).filter((row) => row.price !== null && row.price >= minPrice));
}

async function scrollAndCollectProducts(page, minPrice, limit, maxSteps) {
  const products = new Map();
  let unchanged = 0;
  for (let step = 0; step < maxSteps && products.size < limit; step += 1) {
    const previousCount = products.size;
    const state = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return { title: document.title, text: text.slice(0, 900), y: scrollY, height: document.body?.scrollHeight || 0, viewport: innerHeight };
    });
    if (/доступ ограничен|access denied|captcha|похоже, нет/i.test(`${state.title} ${state.text}`)) throw new Error(`Ozon page blocked or empty: ${state.title}`);
    for (const product of await collectProducts(page, minPrice)) products.set(product.href, product);
    const moved = await page.evaluate(() => { const old = scrollY; window.scrollBy(0, Math.max(500, Math.floor(innerHeight * 0.85))); return { old, next: scrollY, height: document.body?.scrollHeight || 0, viewport: innerHeight }; });
    unchanged = previousCount === products.size && moved.next + moved.viewport >= moved.height - 120 ? unchanged + 1 : 0;
    if (step % 10 === 0) console.log(`highlight step=${step} products=${products.size} y=${moved.next} h=${moved.height}`);
    if (unchanged >= 8) break;
    await sleep(envNumber("FLOW_B_PW_SCROLL_DELAY", 0.9) * 1000);
  }
  return [...products.values()];
}

async function createRun(runDir, config) {
  await fs.mkdir(runDir, { recursive: true });
  const start = path.join(runDir, "start_time.txt");
  try { await fs.access(start); } catch { await fs.writeFile(start, new Date().toISOString()); }
  await fs.writeFile(path.join(runDir, "source_config.json"), JSON.stringify(config, null, 2));
}

async function findSellers(args) {
  const runDir = path.resolve(flag(args, "--resume", path.join(ROOT, "runs/flow_b/playwright_find")));
  const highlightUrl = flag(args, "--highlight-url", "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/");
  const minPrice = Number(flag(args, "--min-price", 50));
  const limit = Number(flag(args, "--limit", 120));
  const maxSteps = Number(flag(args, "--max-scroll-steps", 180));
  await createRun(runDir, { mode: "find-sellers", highlight_url: highlightUrl, min_price: minPrice, limit, max_scroll_steps: maxSteps, browser: "playwright" });
  const { context, profile } = await openContext(runDir);
  try {
    const page = await pageFor(context, `${highlightUrl}${highlightUrl.includes("?") ? "&" : "?"}currency_price=${minPrice.toFixed(3)}%3B`);
    await waitForContent(page);
    const products = await scrollAndCollectProducts(page, minPrice, limit * 8, maxSteps);
    const sellers = new Map();
    for (const [index, product] of products.slice(0, limit * 8).entries()) {
      const detail = await context.newPage();
      try {
        await detail.goto(product.href, { waitUntil: "domcontentloaded", timeout: 60000 });
        await waitForContent(detail, 15000);
        const candidates = await detail.locator('a[href*="/seller/"]').evaluateAll((links) => links.map((link) => ({ href: link.href, text: (link.innerText || link.title || "").trim() }))).catch(() => []);
        for (const candidate of candidates) {
          const seller = normalizeSellerUrl(candidate.href, minPrice);
          if (seller && !sellers.has(seller)) sellers.set(seller, { seller_url: seller, product_url: product.href, product_price: product.price, seller_text: candidate.text });
        }
      } finally { await detail.close().catch(() => {}); }
      if ((index + 1) % 10 === 0) console.log(`seller details=${index + 1} unique_sellers=${sellers.size}`);
      if (sellers.size >= limit) break;
    }
    const rows = [...sellers.values()];
    await fs.writeFile(path.join(runDir, "seller_sources.json"), JSON.stringify(rows, null, 2));
    await fs.writeFile(path.join(runDir, "highlight_products.json"), JSON.stringify(products, null, 2));
    await fs.writeFile(path.join(runDir, "source_urls.txt"), rows.map((row) => row.seller_url).join("\n") + (rows.length ? "\n" : ""));
    console.log(JSON.stringify({ ok: true, profile, runDir, sellers: rows.length, products: products.length }, null, 2));
  } finally { await context.close(); }
}

async function favoriteCount(page) {
  return page.evaluate(async () => {
    const token = JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken;
    const headers = { "Accept-Language": "zh-CN", Client: "pc" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch("https://api.maozierp.com/api.product.favorite/lists?page=1&page_size=1", { headers });
    const body = await response.json();
    const text = document.body?.innerText || "";
    return { total: Number(body?.data?.total || 0), authenticated: Boolean(token) && !/登录|手机号|验证码|密码|login/i.test(text) };
  }).catch(() => null);
}

async function scanOne(page, url, steps, ratio, delay, initialWait) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForContent(page, 20000);
  await sleep(initialWait);
  await page.evaluate(() => window.scrollTo(0, 0));
  const links = new Map(); let stable = 0; let noNew = 0; let lastHeight = 0; let lastY = -1; let lastLinkCount = 0;
  let title = ""; let finalUrl = url; let blocked = false; let stopReason = "max_steps";
  const start = Date.now();
  for (let step = 0; step < steps; step += 1) {
    const state = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return { url: location.href, title: document.title, y: Math.round(scrollY), height: document.body?.scrollHeight || 0, viewport: innerHeight, text: text.slice(0, 900), links: [...document.querySelectorAll('a[href*="/product/"]')].map((a) => ({ href: String(a.href || "").split("?")[0], text: String(a.innerText || a.title || "").trim().slice(0, 120) })) };
    });
    title = state.title; finalUrl = state.url; blocked = /доступ ограничен|access denied|captcha|похоже, нет/i.test(`${title} ${state.text}`);
    for (const link of state.links) if (link.href.includes("/product/")) links.set(link.href, link.text || links.get(link.href) || "");
    if (blocked) { stopReason = "blocked_or_empty"; break; }
    const nearBottom = state.y + state.viewport >= state.height - 100;
    stable = links.size === lastLinkCount && nearBottom && Math.abs(state.y - lastY) < 20 && Math.abs(state.height - lastHeight) < 20 ? stable + 1 : 0;
    noNew = links.size === lastLinkCount ? noNew + 1 : 0;
    lastLinkCount = links.size;
    lastY = state.y; lastHeight = state.height;
    if (stable >= 8) { stopReason = "stable_bottom"; break; }
    if (noNew >= envNumber("FLOW_B_MAX_NO_NEW_LINK_STEPS", 45) && nearBottom) { stopReason = "no_new_links_near_bottom"; break; }
    await page.evaluate((scrollRatio) => window.scrollBy(0, Math.max(350, Math.floor(innerHeight * scrollRatio))), ratio);
    await sleep(delay);
  }
  return { final_url: finalUrl, title, blocked, stop_reason: stopReason, seconds: Math.round((Date.now() - start) / 100) / 10, cumulative_product_link_count: links.size, links: [...links].sort().map(([href, text]) => ({ href, text })) };
}

async function scanSellers(args) {
  const urlsFile = path.resolve(required(args[0], "URLS.txt"));
  const outFile = path.resolve(required(args[1], "OUT.json"));
  const runDir = path.dirname(outFile);
  const urls = [...new Set((await fs.readFile(urlsFile, "utf8")).split(/\r?\n/).map((x) => x.trim()).filter(Boolean))];
  let records = []; try { records = JSON.parse(await fs.readFile(outFile, "utf8")); } catch {}
  const done = new Set(records.map((row) => row.source_url).filter(Boolean));
  const pending = urls.filter((url) => !done.has(url));
  const workers = Math.max(1, envNumber("FLOW_B_TAB_WORKERS", 4));
  const steps = envNumber("FLOW_B_MAX_SCROLL_STEPS", 24); const ratio = envNumber("FLOW_B_SCROLL_RATIO", 0.82); const delay = envNumber("FLOW_B_SCROLL_DELAY", 0.65) * 1000;
  const initialWait = envNumber("FLOW_B_MAOZI_INITIAL_WAIT", process.env.FLOW_B_MAOZI_AUTOFAVORITE === "0" ? 8 : 25) * 1000;
  const lowDeltaThreshold = envNumber("FLOW_B_LOW_DELTA_THRESHOLD", 1);
  const lowDeltaBatchLimit = envNumber("FLOW_B_LOW_DELTA_BATCH_LIMIT", 2);
  let lowDeltaBatches = 0;
  const { context, profile } = await openContext(runDir);
  const maozi = await pageFor(context, "https://ozon.maozierp.com/#/product/favorite");
  await waitForContent(maozi, 15000);
  await assertMaoziLogin(maozi);
  let favoriteState = await favoriteCount(maozi);
  if (process.env.FLOW_B_MAOZI_AUTOFAVORITE !== "0" && (!favoriteState || !favoriteState.authenticated)) {
    throw new Error("Maozi favorite count is unavailable or the Playwright profile is not logged in; run setup and log in first.");
  }
  let favoriteBefore = favoriteState?.total ?? null;
  try {
    for (let start = 0; start < pending.length; start += workers) {
      const batch = pending.slice(start, start + workers); console.log(`batch ${start + 1}-${start + batch.length} / ${pending.length}`);
      const pages = await Promise.all(batch.map(() => context.newPage()));
      const batchRows = await Promise.all(pages.map((page, index) => scanOne(page, batch[index], steps, ratio, delay, initialWait).catch((error) => ({ source_url: batch[index], blocked: false, stop_reason: `error: ${error.message}`, links: [], cumulative_product_link_count: 0 }))));
      await Promise.all(pages.map((page) => page.close().catch(() => {})));
      const afterWait = envNumber("FLOW_B_MAOZI_AFTER_SCAN_WAIT", 10) * 1000; if (afterWait) await sleep(afterWait);
      favoriteState = await favoriteCount(maozi); const favoriteAfter = favoriteState?.total ?? null; const delta = favoriteBefore !== null && favoriteAfter !== null ? favoriteAfter - favoriteBefore : null;
      records.push(...batchRows.map((row, index) => ({ source_url: batch[index], ...row, favorite_count_before: favoriteBefore, favorite_count_after: favoriteAfter, favorite_count_delta: delta })));
      await fs.mkdir(path.dirname(outFile), { recursive: true }); await fs.writeFile(outFile, JSON.stringify(records, null, 2));
      console.log(`favorite ${favoriteBefore} -> ${favoriteAfter} delta=${delta}`); favoriteBefore = favoriteAfter;
      if (favoriteAfter !== null && favoriteAfter >= envNumber("FLOW_B_TARGET_FAVORITES", 1000)) break;
      if (lowDeltaBatchLimit > 0) {
        lowDeltaBatches = delta === null || delta < lowDeltaThreshold ? lowDeltaBatches + 1 : 0;
        if (lowDeltaBatches >= lowDeltaBatchLimit) {
          console.log(`stop low-yield batches: ${lowDeltaBatches} batches below ${lowDeltaThreshold}`);
          break;
        }
      }
    }
    console.log(JSON.stringify({ ok: true, profile, outFile, records: records.length }, null, 2));
  } finally { await context.close(); }
}

async function setup(runDir) {
  const { context, profile } = await openContext(runDir);
  const maozi = context.pages()[0] || await context.newPage(); await maozi.goto("https://ozon.maozierp.com/#/product/favorite", { waitUntil: "domcontentloaded" });
  const ozon = await context.newPage(); await ozon.goto("https://www.ozon.ru/", { waitUntil: "domcontentloaded" });
  console.log(JSON.stringify({ ok: true, profile, message: "请在打开的 Playwright 浏览器中完成 Ozon/Maozi 登录；不要绕过验证码。登录完成后按 Ctrl+C 结束 setup。" }, null, 2));
  await new Promise(() => {});
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "setup") await setup(path.resolve(args[0] || path.join(ROOT, "runs/flow_b/playwright_setup")));
  else if (command === "find-sellers") await findSellers(args);
  else if (command === "scan-sellers") await scanSellers(args);
  else if (command === "--help" || command === "-h" || !command) {
    console.log("Usage: flow_b_playwright.mjs <setup|find-sellers|scan-sellers> ...");
    console.log("  setup RUN_DIR");
    console.log("  find-sellers --highlight-url URL --min-price 50 --limit 120 --resume RUN_DIR");
    console.log("  scan-sellers URLS.txt OUT.json");
  } else throw new Error("Usage: flow_b_playwright.mjs <setup|find-sellers|scan-sellers> ...");
} catch (error) {
  console.error(error.stack || error.message || error); process.exitCode = 1;
}
