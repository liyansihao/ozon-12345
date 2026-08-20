import fs from "node:fs/promises";

const BAD_SKUS = new Set(["2815247918"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function selectSellerUrl(links) {
  const candidates = (links || []).filter((link) => /\/seller\//i.test(String(link?.href || "")));
  const selected = candidates.find((link) => link.current) || candidates[0];
  if (!selected) return null;
  try {
    const url = new URL(selected.href);
    const match = url.pathname.match(/^(\/seller\/[^/]+\/)/i);
    return match ? `${url.origin}${match[1]}` : null;
  } catch {
    return null;
  }
}

export function publishedProductUrls(rows) {
  const seenSkus = new Set();
  const urls = [];
  for (const row of rows || []) {
    const sku = String(row?.sku || row?.data?.sku || "").trim();
    const url = String(row?.link || row?.data?.link || "").trim();
    if (!sku || seenSkus.has(sku) || BAD_SKUS.has(sku)) continue;
    if (row?.status !== "published" || !(Number(row?.data?.profit_rate) > 30) || !/^https?:\/\//i.test(url)) continue;
    seenSkus.add(sku);
    urls.push(url);
  }
  return urls;
}

export function sellerDiscoveryFailureState({ consecutiveBlocked = 0, batchSize = 0, failed = 0 } = {}) {
  const next = Number(batchSize) > 0 && Number(failed) >= Number(batchSize) ? Number(consecutiveBlocked) + 1 : 0;
  return { consecutiveBlocked: next, stop: next >= 2 };
}

async function discoverOne(page, productUrl, timeout) {
  await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout });
  await sleep(1500);
  const snapshot = await page.evaluate(() => {
    const text = `${document.title} ${document.body?.innerText?.slice(0, 1000) || ""}`;
    const currentRoot = document.querySelector('[data-widget="webCurrentSeller"], [data-widget*="CurrentSeller"], [data-widget="webSeller"]');
    const current = [...(currentRoot?.querySelectorAll('a[href*="/seller/"]') || [])]
      .map((anchor) => ({ href: anchor.href, current: true }));
    const all = [...document.querySelectorAll('a[href*="/seller/"]')]
      .map((anchor) => ({ href: anchor.href, current: false }));
    return { text, links: [...current, ...all] };
  });
  if (/доступ ограничен|access denied|captcha|похоже, нет соединения/i.test(snapshot.text)) {
    throw new Error("Ozon seller discovery soft blocked");
  }
  return selectSellerUrl(snapshot.links);
}

export async function discoverSellerSources({
  context,
  productUrls,
  outFile,
  workers = 4,
  timeout = 30_000,
  log = console.log,
} = {}) {
  const existing = new Set();
  try {
    for (const line of (await fs.readFile(outFile, "utf8")).split(/\r?\n/)) if (line.trim()) existing.add(line.trim());
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let attempted = 0;
  let failed = 0;
  let consecutiveBlocked = 0;
  for (let start = 0; start < productUrls.length; start += workers) {
    const batch = productUrls.slice(start, start + workers);
    const failedBefore = failed;
    const pages = await Promise.all(batch.map(() => context.newPage()));
    const results = await Promise.all(pages.map((page, index) => discoverOne(page, batch[index], timeout)
      .catch(() => { failed += 1; return null; })));
    await Promise.all(pages.map((page) => page.close().catch(() => {})));
    attempted += batch.length;
    for (const seller of results) if (seller) existing.add(seller);
    log(`seller discovery summary attempted=${attempted} sellers=${existing.size} failed=${failed}`);
    await fs.writeFile(outFile, `${[...existing].join("\n")}\n`);
    const failureState = sellerDiscoveryFailureState({
      consecutiveBlocked,
      batchSize: batch.length,
      failed: failed - failedBefore,
    });
    consecutiveBlocked = failureState.consecutiveBlocked;
    if (failureState.stop) break;
    await sleep(1000);
  }
  return { attempted, sellers: existing.size, failed, out_file: outFile };
}
