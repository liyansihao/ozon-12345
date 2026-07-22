import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });
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

export async function assertPluginLoaded(context, { timeout = 15000, interval = 100 } = {}) {
  const deadline = Date.now() + Math.max(0, timeout);
  do {
    const targets = [
      ...(typeof context.serviceWorkers === "function" ? context.serviceWorkers() : []),
      ...(typeof context.backgroundPages === "function" ? context.backgroundPages() : []),
      ...(typeof context.pages === "function" ? context.pages() : []),
    ];
    const extensionTarget = targets.find((target) => targetUrl(target).startsWith("chrome-extension://"));
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
    try {
      await assertPluginLoaded(context, { timeout: cdpEndpoint ? Math.min(pluginTimeout, 1000) : pluginTimeout });
    } catch (error) {
      if (!cdpEndpoint || !await wakeRegisteredExtension(context, profileDir, extensionDir, extensionPopup)) throw error;
      await assertPluginLoaded(context, { timeout: pluginTimeout });
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
} = {}) {
  const available = () => context.pages().filter((page) => typeof page.isClosed !== "function" || !page.isClosed());
  const navigable = () => available().filter((page) => !targetUrl(page).startsWith("chrome-extension://"));
  let page = forceNew ? null : available().find((candidate) => targetUrl(candidate).startsWith("https://ozon.maozierp.com/"));
  if (!page) {
    page = forceNew ? await context.newPage() : navigable()[0] || await context.newPage();
    await page.goto("https://ozon.maozierp.com/#/product/favorite", { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  if (settleMs > 0) await delay(settleMs);
  if (typeof page.isClosed === "function" && page.isClosed()) {
    const deadline = Date.now() + Math.max(0, Number(recoveryTimeoutMs) || 0);
    do {
      page = available().find((candidate) => targetUrl(candidate).startsWith("https://ozon.maozierp.com/"));
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
