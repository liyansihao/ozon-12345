import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAOZI_FAVORITE_URL = "https://ozon.maozierp.com/#/product/favorite";
const failedMaoziNavigationPages = new WeakSet();

function requiredPath(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return path.resolve(normalized);
}

function readManifest(extensionDir) {
  const manifestPath = path.join(extensionDir, "manifest.json");
  let source;
  try {
    source = fs.readFileSync(manifestPath, "utf8");
  } catch {
    throw new Error(`Maozi extension manifest.json was not found: ${manifestPath}`);
  }
  try {
    const manifest = JSON.parse(source);
    if (!manifest || !manifest.manifest_version) throw new Error("missing manifest_version");
    return manifest;
  } catch (error) {
    throw new Error(`Maozi extension manifest.json must contain valid JSON: ${error.message}`);
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

async function navigateMaoziFavorite(page, timeoutMs) {
  const timeout = positiveInteger(timeoutMs, 15_000);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => page.goto(MAOZI_FAVORITE_URL, {
        waitUntil: "commit",
        timeout,
      })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(
            new Error(`Maozi page navigation timed out after ${timeout}ms`),
            { code: "MAOZI_PAGE_NAVIGATION_TIMEOUT" },
          ));
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function isMaoziPageNavigationTimeout(error) {
  return error?.code === "MAOZI_PAGE_NAVIGATION_TIMEOUT";
}

export function resolveBrowserOptions(env = process.env, defaultExecutable = chromium.executablePath()) {
  const profileDir = requiredPath(env.FLOW_B_PW_PROFILE, "FLOW_B_PW_PROFILE");
  const extensionDir = requiredPath(env.FLOW_B_EXTENSION_DIR, "FLOW_B_EXTENSION_DIR");
  const manifest = readManifest(extensionDir);

  const executablePath = String(env.FLOW_B_CHROMIUM_EXECUTABLE || defaultExecutable || "").trim();
  if (!executablePath) throw new Error("Chrome for Testing executable path is required");
  const cdpEndpoint = String(env.FLOW_B_CDP_ENDPOINT || "").trim();
  const diskCacheSize = positiveInteger(env.FLOW_B_DISK_CACHE_SIZE_BYTES, 100 * 1024 * 1024);
  const mediaCacheSize = positiveInteger(env.FLOW_B_MEDIA_CACHE_SIZE_BYTES, 50 * 1024 * 1024);
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    `--disk-cache-size=${diskCacheSize}`,
    `--media-cache-size=${mediaCacheSize}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ];
  if (String(env.FLOW_B_NO_PROXY_SERVER || "").trim() === "1") args.push("--no-proxy-server");

  return {
    profileDir,
    extensionDir,
    extensionPopup: String(manifest.action?.default_popup || "").trim() || null,
    executablePath,
    cdpEndpoint: cdpEndpoint || null,
    headless: false,
    viewport: null,
    // Playwright otherwise consumes process signals, closes Chromium, and
    // leaves the long-running producer/consumer timers alive. The external
    // supervisor owns restarts, so let Node terminate normally on signals.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args,
    ignoreDefaultArgs: ["--disable-extensions"],
    pluginTimeout: Number(env.FLOW_B_PLUGIN_TIMEOUT_MS) || 15000,
  };
}

function registeredExtensionId(profileDir, extensionDir) {
  const preferenceNames = ["Preferences", "Secure Preferences"];
  for (const preferenceName of preferenceNames) {
    try {
      const preferencesPath = path.join(profileDir, "Default", preferenceName);
      const preferences = JSON.parse(fs.readFileSync(preferencesPath, "utf8"));
      const settings = preferences?.extensions?.settings || {};
      const extensionId = Object.entries(settings).find(([, value]) => {
        const registeredPath = String(value?.path || "").trim();
        return registeredPath && path.resolve(registeredPath) === path.resolve(extensionDir);
      })?.[0];
      if (extensionId) return extensionId;
    } catch {
      // Chrome may keep unpacked-extension registration in either file.
    }
  }
  return null;
}

async function wakeRegisteredExtension(context, profileDir, extensionDir, extensionPopup) {
  const extensionId = registeredExtensionId(profileDir, extensionDir);
  if (!extensionId || !extensionPopup) return null;
  const extensionPrefix = `chrome-extension://${extensionId}/`;
  const existing = context.pages().find((candidate) => targetUrl(candidate).startsWith(extensionPrefix));
  if (existing) return existing;
  const page = await context.newPage();
  try {
    await page.goto(`${extensionPrefix}${extensionPopup.replace(/^\/+/, "")}`, {
      waitUntil: "commit",
      timeout: 10000,
    });
    const committedUrl = targetUrl(page);
    if (!committedUrl.startsWith(extensionPrefix)) {
      throw new Error(`Maozi extension popup committed to an unexpected URL: ${committedUrl || "unknown"}`);
    }
    return page;
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

function targetUrl(target) {
  if (!target) return "";
  try {
    return String(typeof target.url === "function" ? target.url() : target.url || "");
  } catch {
    return "";
  }
}

function pageNeedsManualAttention(url, title) {
  return /captcha|challenge|verification|required|\bmfa\b|(?:^|[/?#_-])(?:login|signin|auth)(?:[/?#_-]|$)|验证码|人机验证|身份验证|登录/iu
    .test(`${String(url || "")} ${String(title || "")}`);
}

async function closePageWithin(page, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => page.close()),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`orphan page close timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function pageTitleWithin(page, timeoutMs) {
  if (typeof page?.title !== "function") return "";
  let timer;
  try {
    return await Promise.race([
      page.title(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(""), timeoutMs);
      }),
    ]);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function pageSecurityTextWithin(page, timeoutMs) {
  if (typeof page?.evaluate !== "function") return "";
  let timer;
  try {
    return await Promise.race([
      page.evaluate(() => String(document.body?.innerText || "").slice(0, 2_000)),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(""), timeoutMs);
      }),
    ]);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

export async function pruneOrphanedFlowPages(context, {
  preserveOrdinaryPages = 1,
  closeTimeoutMs = 5_000,
} = {}) {
  if (!context || typeof context.pages !== "function") {
    return {
      observed_pages: 0,
      closed_pages: 0,
      failed_pages: 0,
      preserved_pages: 0,
      protected_pages: 0,
    };
  }
  const pages = context.pages().filter(
    (page) => typeof page?.isClosed !== "function" || !page.isClosed(),
  );
  const descriptors = await Promise.all(pages.map(async (page, index) => {
    const url = targetUrl(page);
    const inspectionTimeoutMs = Math.min(1_000, Math.max(1, Number(closeTimeoutMs) || 1));
    const [title, securityText] = await Promise.all([
      pageTitleWithin(page, inspectionTimeoutMs),
      /^https:\/\/(?:www\.ozon\.(?:ru|kz|by)|ozon\.maozierp\.com)\//iu.test(url)
        ? pageSecurityTextWithin(page, inspectionTimeoutMs)
        : "",
    ]);
    const protectedPage = url.startsWith("chrome-extension://")
      || (url.startsWith("chrome://") && url !== "about:blank")
      || pageNeedsManualAttention(url, `${title} ${securityText}`);
    const preference = url === "about:blank"
      ? 0
      : url.startsWith("https://ozon.maozierp.com/")
        ? 1
        : 2;
    return { page, index, url, title, protectedPage, preference };
  }));
  const protectedPages = descriptors.filter((entry) => entry.protectedPage);
  const ordinaryPages = descriptors
    .filter((entry) => !entry.protectedPage)
    .sort((left, right) => left.preference - right.preference || left.index - right.index);
  const preserveCount = Math.max(0, Math.floor(Number(preserveOrdinaryPages) || 0));
  const preservedOrdinary = new Set(ordinaryPages.slice(0, preserveCount).map((entry) => entry.page));
  const closing = ordinaryPages.filter((entry) => !preservedOrdinary.has(entry.page));
  const closed = await Promise.all(closing.map((entry) => closePageWithin(
    entry.page,
    Math.max(1, Number(closeTimeoutMs) || 1),
  )));
  const closedPages = closed.filter(Boolean).length;
  return {
    observed_pages: descriptors.length,
    closed_pages: closedPages,
    failed_pages: closing.length - closedPages,
    preserved_pages: descriptors.length - closing.length,
    protected_pages: protectedPages.length,
  };
}

export async function assertPluginLoaded(context, {
  timeout = 15000,
  interval = 100,
  extensionId = null,
} = {}) {
  const normalizedExtensionId = String(extensionId || "").trim();
  const extensionPrefix = normalizedExtensionId
    ? `chrome-extension://${normalizedExtensionId}/`
    : "chrome-extension://";
  const deadline = Date.now() + Math.max(0, timeout);
  do {
    const targets = [
      ...(typeof context.serviceWorkers === "function" ? context.serviceWorkers() : []),
      ...(typeof context.backgroundPages === "function" ? context.backgroundPages() : []),
      ...(typeof context.pages === "function" ? context.pages() : []),
    ];
    const extensionTarget = targets.find((target) => targetUrl(target).startsWith(extensionPrefix));
    if (extensionTarget) return extensionTarget;
    if (Date.now() >= deadline) break;
    await delay(Math.max(1, interval));
  } while (true);
  throw new Error("Maozi extension did not load in Chrome for Testing");
}

export async function launchFlowContext(options, browserType = chromium) {
  const {
    profileDir,
    extensionDir,
    extensionPopup,
    pluginTimeout = 15000,
    cdpEndpoint,
    ...launchOptions
  } = options;
  await fsp.mkdir(profileDir, { recursive: true });
  let context;
  let browser;
  try {
    if (cdpEndpoint) {
      browser = await browserType.connectOverCDP(cdpEndpoint);
      context = browser.contexts()[0];
      if (!context) throw new Error(`CDP browser has no default context: ${cdpEndpoint}`);
      Object.defineProperty(context, "close", {
        configurable: true,
        value: browser.close.bind(browser),
      });
    } else {
      context = await browserType.launchPersistentContext(profileDir, launchOptions);
    }
    const extensionId = registeredExtensionId(profileDir, extensionDir);
    if (cdpEndpoint && !extensionId) {
      throw new Error("Maozi extension did not load in Chrome for Testing: registered extension ID was not found in the CDP profile");
    }
    try {
      await assertPluginLoaded(context, {
        timeout: cdpEndpoint ? Math.min(pluginTimeout, 1000) : pluginTimeout,
        extensionId,
      });
    } catch (error) {
      if (!cdpEndpoint || !await wakeRegisteredExtension(context, profileDir, extensionDir, extensionPopup)) throw error;
      await assertPluginLoaded(context, { timeout: pluginTimeout, extensionId });
    }
    return context;
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    else await context?.close().catch(() => {});
    throw error;
  }
}

export async function openMaoziPage(context, {
  settleMs = 1000,
  forceNew = false,
  recoveryTimeoutMs = 5000,
  recoveryPollMs = 100,
  navigationTimeoutMs = 15_000,
  navigationCleanupTimeoutMs = 2_000,
  navigationRetryDelayMs = 2_000,
  navigationRetryTimeoutMs = 30_000,
} = {}) {
  const available = () => context.pages().filter((page) => (
    !failedMaoziNavigationPages.has(page)
    && (typeof page.isClosed !== "function" || !page.isClosed())
  ));
  const pagesBeforeOpen = new Set(available());
  let page = forceNew ? null : available().find((candidate) => targetUrl(candidate).startsWith("https://ozon.maozierp.com/"));
  if (!page) {
    const openOwnedPage = async (timeoutMs) => {
      const ownedPage = await context.newPage();
      try {
        await navigateMaoziFavorite(ownedPage, timeoutMs);
        return ownedPage;
      } catch (error) {
        failedMaoziNavigationPages.add(ownedPage);
        await closePageWithin(ownedPage, positiveInteger(navigationCleanupTimeoutMs, 2_000));
        throw error;
      }
    };
    try {
      page = await openOwnedPage(navigationTimeoutMs);
    } catch (error) {
      if (!isMaoziPageNavigationTimeout(error)) throw error;
      const retryDelay = Math.max(0, Number(navigationRetryDelayMs) || 0);
      if (retryDelay > 0) await delay(retryDelay);
      page = await openOwnedPage(positiveInteger(navigationRetryTimeoutMs, 30_000));
    }
  }
  if (settleMs > 0) await delay(settleMs);
  if (typeof page.isClosed === "function" && page.isClosed()) {
    const deadline = Date.now() + Math.max(0, Number(recoveryTimeoutMs) || 0);
    do {
      page = available().find((candidate) => (
        (!forceNew || !pagesBeforeOpen.has(candidate))
        && targetUrl(candidate).startsWith("https://ozon.maozierp.com/")
      ));
      if (page || Date.now() >= deadline) break;
      await delay(Math.max(1, Number(recoveryPollMs) || 1));
    } while (true);
  }
  if (!page) throw new Error("Maozi SSO page closed without leaving an authenticated ERP page");
  return page;
}

export async function assertMaoziLogin(page) {
  const token = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken || "";
    } catch {
      return "";
    }
  });
  const normalized = String(token || "").trim();
  if (!normalized) throw new Error("Maozi profile is not logged in: maozierp-core-access.accessToken is empty");
  return normalized;
}

export async function ensureMaoziLogin(page, { continueDeviceLogin = false, timeout = 30000 } = {}) {
  try {
    return await assertMaoziLogin(page);
  } catch (error) {
    if (!continueDeviceLogin) throw error;
    const button = page.getByRole("button", { name: "继续登录", exact: true });
    if (typeof button.waitFor === "function") {
      await button.waitFor({ state: "visible", timeout }).catch(() => {});
    }
    if (await button.count() !== 1) throw error;
    await button.click();
    await page.waitForFunction(() => {
      try {
        return Boolean(JSON.parse(localStorage.getItem("maozierp-core-access") || "{}").accessToken);
      } catch {
        return false;
      }
    }, null, { timeout });
    return assertMaoziLogin(page);
  }
}

async function hasMaoziPluginToken(context) {
  const targets = [
    ...(typeof context.serviceWorkers === "function" ? context.serviceWorkers() : []),
    ...(typeof context.backgroundPages === "function" ? context.backgroundPages() : []),
    ...(typeof context.pages === "function" ? context.pages() : []),
  ];
  const extensionTarget = targets.find((candidate) => targetUrl(candidate).startsWith("chrome-extension://"));
  if (!extensionTarget) return false;
  return Boolean(await extensionTarget.evaluate(async () => {
    const storage = globalThis.browser?.storage?.local || globalThis.chrome?.storage?.local;
    if (!storage) return false;
    try {
      const data = await storage.get("maozierp-token");
      return Boolean(data?.["maozierp-token"]);
    } catch {
      return false;
    }
  }).catch(() => false));
}

export async function ensureMaoziPluginLogin(context, { timeout = 60000, continueDeviceLogin = true } = {}) {
  const workerReadyDeadline = Date.now() + Math.min(Math.max(0, timeout), 5000);
  do {
    if (await hasMaoziPluginToken(context)) return true;
    if (Date.now() >= workerReadyDeadline) break;
    await delay(100);
  } while (true);
  const existing = context.pages().find((candidate) => /^https:\/\/www\.ozon\.(?:ru|kz|by)\//i.test(targetUrl(candidate)));
  const page = existing || await context.newPage();
  if (!existing) await page.goto("https://www.ozon.ru/", { waitUntil: "domcontentloaded", timeout });
  const login = page.getByRole("button", { name: "请登录", exact: true });
  if (typeof login.waitFor === "function") await login.waitFor({ state: "visible", timeout }).catch(() => {});
  if (await login.count() !== 1) throw new Error("Maozi extension token is empty and the plugin login button is unavailable");
  await login.click();

  const deadline = Date.now() + timeout;
  const continuedPages = new Set();
  while (Date.now() < deadline) {
    if (await hasMaoziPluginToken(context)) return true;
    if (continueDeviceLogin) {
      for (const candidate of context.pages()) {
        if (continuedPages.has(candidate)) continue;
        const button = candidate.getByRole("button", { name: "继续登录", exact: true });
        if (await button.count().catch(() => 0) === 1) {
          await button.click().catch(() => {});
          continuedPages.add(candidate);
        }
      }
    }
    await delay(500);
  }
  throw new Error("Maozi extension login did not produce a plugin token before timeout");
}
