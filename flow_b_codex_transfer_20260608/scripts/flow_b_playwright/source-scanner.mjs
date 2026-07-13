import fs from "node:fs/promises";
import path from "node:path";
import { assertMaoziLogin } from "./browser-context.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envNumber(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}

async function waitForContent(page, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      ready: document.readyState,
      bodyLength: document.body?.innerText?.length || 0,
      products: document.querySelectorAll('a[href*="/product/"]').length,
    })).catch(() => ({}));
    if (state.ready === "complete" && (state.bodyLength > 1000 || state.products > 0)) return state;
    await sleep(700);
  }
  return null;
}

async function favoriteCount(page) {
  return page.evaluate(async () => {
    let token = "";
    try { token = JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || ""; } catch {}
    const headers = { "Accept-Language": "zh-CN", Client: "pc" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch("https://api.maozierp.com/api.product.favorite/lists?page=1&page_size=1&is_imported=0", { headers });
    const body = await response.json();
    return { total: Number(body?.data?.total || 0), authenticated: Boolean(token) };
  });
}

async function scanOne(page, url, { steps, ratio, delay, initialWait, maxNoNewSteps }) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForContent(page, 20000);
  await sleep(initialWait);
  await page.evaluate(() => window.scrollTo(0, 0));
  const links = new Map();
  let stable = 0;
  let noNew = 0;
  let lastHeight = 0;
  let lastY = -1;
  let lastLinkCount = 0;
  let title = "";
  let finalUrl = url;
  let blocked = false;
  let stopReason = "max_steps";
  const started = Date.now();

  for (let step = 0; step < steps; step += 1) {
    const state = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return {
        url: location.href,
        title: document.title,
        y: Math.round(scrollY),
        height: document.body?.scrollHeight || 0,
        viewport: innerHeight,
        text: text.slice(0, 900),
        links: [...document.querySelectorAll('a[href*="/product/"]')].map((anchor) => ({
          href: String(anchor.href || "").split("?")[0],
          text: String(anchor.innerText || anchor.title || "").trim().slice(0, 120),
        })),
      };
    });
    title = state.title;
    finalUrl = state.url;
    blocked = /доступ ограничен|access denied|captcha|похоже, нет/i.test(`${title} ${state.text}`);
    for (const link of state.links) if (link.href.includes("/product/")) links.set(link.href, link.text || links.get(link.href) || "");
    if (blocked) { stopReason = "blocked_or_empty"; break; }
    const nearBottom = state.y + state.viewport >= state.height - 100;
    stable = links.size === lastLinkCount && nearBottom && Math.abs(state.y - lastY) < 20 && Math.abs(state.height - lastHeight) < 20 ? stable + 1 : 0;
    noNew = links.size === lastLinkCount ? noNew + 1 : 0;
    lastLinkCount = links.size;
    lastY = state.y;
    lastHeight = state.height;
    if (stable >= 8) { stopReason = "stable_bottom"; break; }
    if (noNew >= maxNoNewSteps && nearBottom) { stopReason = "no_new_links_near_bottom"; break; }
    await page.evaluate((scrollRatio) => window.scrollBy(0, Math.max(350, Math.floor(innerHeight * scrollRatio))), ratio);
    await sleep(delay);
  }
  return {
    final_url: finalUrl,
    title,
    blocked,
    stop_reason: stopReason,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    cumulative_product_link_count: links.size,
    links: [...links].sort().map(([href, text]) => ({ href, text })),
  };
}

export async function scanSources({ context, urlsFile, outFile, env = process.env, log = console.log }) {
  const inputPath = path.resolve(urlsFile);
  const outputPath = path.resolve(outFile);
  const urls = [...new Set((await fs.readFile(inputPath, "utf8")).split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
  let records = [];
  try {
    const parsed = JSON.parse(await fs.readFile(outputPath, "utf8"));
    if (Array.isArray(parsed)) records = parsed;
  } catch {}
  const done = new Set(records.map((row) => row.source_url).filter(Boolean));
  const pending = urls.filter((url) => !done.has(url));
  const workers = Math.max(1, envNumber(env, "FLOW_B_TAB_WORKERS", 4));
  const options = {
    steps: envNumber(env, "FLOW_B_MAX_SCROLL_STEPS", 24),
    ratio: envNumber(env, "FLOW_B_SCROLL_RATIO", 0.82),
    delay: envNumber(env, "FLOW_B_SCROLL_DELAY", 0.65) * 1000,
    initialWait: envNumber(env, "FLOW_B_MAOZI_INITIAL_WAIT", env.FLOW_B_MAOZI_AUTOFAVORITE === "0" ? 8 : 25) * 1000,
    maxNoNewSteps: envNumber(env, "FLOW_B_MAX_NO_NEW_LINK_STEPS", 45),
  };
  const lowDeltaThreshold = envNumber(env, "FLOW_B_LOW_DELTA_THRESHOLD", 1);
  const lowDeltaBatchLimit = envNumber(env, "FLOW_B_LOW_DELTA_BATCH_LIMIT", 2);
  let lowDeltaBatches = 0;
  const maozi = await context.newPage();
  try {
    await maozi.goto("https://ozon.maozierp.com/#/product/favorite", { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForContent(maozi, 15000);
    await assertMaoziLogin(maozi);
    let favoriteState = await favoriteCount(maozi);
    if (env.FLOW_B_MAOZI_AUTOFAVORITE !== "0" && !favoriteState.authenticated) throw new Error("Maozi profile is not logged in");
    let favoriteBefore = favoriteState.total;

    for (let start = 0; start < pending.length; start += workers) {
      const batch = pending.slice(start, start + workers);
      log(`batch ${start + 1}-${start + batch.length} / ${pending.length}`);
      const pages = await Promise.all(batch.map(() => context.newPage()));
      const batchRows = await Promise.all(pages.map((page, index) => scanOne(page, batch[index], options)
        .catch((error) => ({ source_url: batch[index], blocked: false, stop_reason: `error: ${error.message}`, links: [], cumulative_product_link_count: 0 }))));
      await Promise.all(pages.map((page) => page.close().catch(() => {})));
      const afterWait = envNumber(env, "FLOW_B_MAOZI_AFTER_SCAN_WAIT", 10) * 1000;
      if (afterWait) await sleep(afterWait);
      favoriteState = await favoriteCount(maozi);
      const favoriteAfter = favoriteState.total;
      const delta = favoriteAfter - favoriteBefore;
      records.push(...batchRows.map((row, index) => ({
        source_url: batch[index],
        ...row,
        favorite_count_before: favoriteBefore,
        favorite_count_after: favoriteAfter,
        favorite_count_delta: delta,
      })));
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, JSON.stringify(records, null, 2));
      log(`favorite ${favoriteBefore} -> ${favoriteAfter} delta=${delta}`);
      favoriteBefore = favoriteAfter;
      if (favoriteAfter >= envNumber(env, "FLOW_B_TARGET_FAVORITES", 1000)) break;
      if (lowDeltaBatchLimit > 0) {
        lowDeltaBatches = delta < lowDeltaThreshold ? lowDeltaBatches + 1 : 0;
        if (lowDeltaBatches >= lowDeltaBatchLimit) break;
      }
    }
    return { outFile: outputPath, records: records.length, pending: pending.length };
  } finally {
    await maozi.close().catch(() => {});
  }
}
