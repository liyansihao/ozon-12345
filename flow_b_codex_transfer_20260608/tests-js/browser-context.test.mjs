import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertMaoziLogin,
  assertPluginLoaded,
  ensureMaoziLogin,
  ensureMaoziPluginLogin,
  launchFlowContext,
  openMaoziPage,
  pruneOrphanedFlowPages,
  resolveBrowserOptions,
} from "../scripts/flow_b_playwright/browser-context.mjs";

async function extensionFixture() {
  const extensionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-b-extension-"));
  await fsp.writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    name: "fixture",
    version: "1.0.0",
    action: { default_popup: "popup.html" },
  }));
  return extensionDir;
}

test("browser options require an unpacked extension and use Chrome for Testing", async () => {
  const extensionDir = await extensionFixture();
  const options = resolveBrowserOptions({
    FLOW_B_PW_PROFILE: "/tmp/profile",
    FLOW_B_EXTENSION_DIR: extensionDir,
  }, "/tmp/cft");

  assert.equal(options.executablePath, "/tmp/cft");
  assert.equal(options.profileDir, "/tmp/profile");
  assert.equal(options.extensionPopup, "popup.html");
  assert.deepEqual(options.args.slice(-2), [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ]);
  assert.deepEqual(options.ignoreDefaultArgs, ["--disable-extensions"]);
  assert.equal(options.headless, false);
  assert.equal(options.handleSIGINT, false);
  assert.equal(options.handleSIGTERM, false);
  assert.equal(options.handleSIGHUP, false);
  assert.ok(options.args.includes("--disk-cache-size=104857600"));
  assert.ok(options.args.includes("--media-cache-size=52428800"));
});

test("browser cache limits accept explicit positive byte overrides", async () => {
  const extensionDir = await extensionFixture();
  const options = resolveBrowserOptions({
    FLOW_B_PW_PROFILE: "/tmp/profile",
    FLOW_B_EXTENSION_DIR: extensionDir,
    FLOW_B_DISK_CACHE_SIZE_BYTES: "67108864",
    FLOW_B_MEDIA_CACHE_SIZE_BYTES: "33554432",
  }, "/tmp/cft");

  assert.ok(options.args.includes("--disk-cache-size=67108864"));
  assert.ok(options.args.includes("--media-cache-size=33554432"));
});

test("browser options can bypass a broken macOS system proxy explicitly", async () => {
  const extensionDir = await extensionFixture();
  const directOptions = resolveBrowserOptions({
    FLOW_B_PW_PROFILE: "/tmp/profile",
    FLOW_B_EXTENSION_DIR: extensionDir,
    FLOW_B_NO_PROXY_SERVER: "1",
  }, "/tmp/cft");
  const defaultOptions = resolveBrowserOptions({
    FLOW_B_PW_PROFILE: "/tmp/profile",
    FLOW_B_EXTENSION_DIR: extensionDir,
  }, "/tmp/cft");

  assert.ok(directOptions.args.includes("--no-proxy-server"));
  assert.equal(defaultOptions.args.includes("--no-proxy-server"), false);
});

test("direct worker startup prunes orphan pages while preserving security and extension pages", async () => {
  const closed = [];
  const page = (name, url, title = "") => ({
    url: () => url,
    title: async () => title,
    evaluate: async () => "",
    isClosed: () => false,
    close: async () => { closed.push(name); },
  });
  const pages = [
    page("blank", "about:blank"),
    page("old-erp", "https://ozon.maozierp.com/#/product/favorite", "毛子ERP"),
    page("old-ozon", "https://www.ozon.ru/product/123", "Ozon"),
    page("extension", "chrome-extension://fixture/popup.html", "插件"),
    page("captcha", "https://www.ozon.ru/product/456", "需要人机验证"),
  ];

  const result = await pruneOrphanedFlowPages({ pages: () => pages }, {
    preserveOrdinaryPages: 1,
    closeTimeoutMs: 100,
  });

  assert.deepEqual(closed.sort(), ["old-erp", "old-ozon"]);
  assert.deepEqual(result, {
    observed_pages: 5,
    closed_pages: 2,
    failed_pages: 0,
    preserved_pages: 3,
    protected_pages: 2,
  });
});

test("orphan pruning reports a bounded close failure without closing protected login pages", async () => {
  let loginClosed = false;
  const result = await pruneOrphanedFlowPages({
    pages: () => [
      {
        url: () => "about:blank",
        title: async () => "",
        isClosed: () => false,
        close: async () => { throw new Error("target already gone"); },
      },
      {
        url: () => "https://ozon.maozierp.com/#/login",
        title: async () => "登录",
        evaluate: async () => "",
        isClosed: () => false,
        close: async () => { loginClosed = true; },
      },
    ],
  }, {
    preserveOrdinaryPages: 0,
    closeTimeoutMs: 100,
  });

  assert.equal(loginClosed, false);
  assert.equal(result.failed_pages, 1);
  assert.equal(result.protected_pages, 1);
  assert.equal(result.preserved_pages, 1);
});

test("orphan pruning reads the page body before preserving an Ozon verification tab", async () => {
  let closed = false;
  const result = await pruneOrphanedFlowPages({
    pages: () => [{
      url: () => "https://www.ozon.ru/product/123",
      title: async () => "Ozon",
      evaluate: async () => "请完成验证码后继续",
      isClosed: () => false,
      close: async () => { closed = true; },
    }],
  }, { preserveOrdinaryPages: 0, closeTimeoutMs: 100 });

  assert.equal(closed, false);
  assert.equal(result.protected_pages, 1);
  assert.equal(result.preserved_pages, 1);
});

test("browser context can attach to a normally launched CDP browser and owns its shutdown", async () => {
  const extensionDir = await extensionFixture();
  let endpoint = null;
  let persistentLaunches = 0;
  let browserCloses = 0;
  let contextCloses = 0;
  const context = {
    serviceWorkers: () => [{ url: () => "chrome-extension://fixture/background.js" }],
    backgroundPages: () => [],
    pages: () => [],
    close: async () => { contextCloses += 1; },
  };
  const browserType = {
    connectOverCDP: async (value) => {
      endpoint = value;
      return {
        contexts: () => [context],
        close: async () => { browserCloses += 1; },
      };
    },
    launchPersistentContext: async () => { persistentLaunches += 1; },
  };
  const options = resolveBrowserOptions({
    FLOW_B_PW_PROFILE: "/tmp/profile",
    FLOW_B_EXTENSION_DIR: extensionDir,
    FLOW_B_CDP_ENDPOINT: "http://127.0.0.1:9223",
  }, "/tmp/cft");

  const attached = await launchFlowContext(options, browserType);
  assert.equal(attached, context);
  assert.equal(endpoint, "http://127.0.0.1:9223");
  assert.equal(persistentLaunches, 0);
  await attached.close();
  assert.equal(browserCloses, 1);
  assert.equal(contextCloses, 0);
});

test("CDP attachment wakes an idle registered extension through its popup", async () => {
  const extensionDir = await extensionFixture();
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-b-profile-"));
  await fsp.mkdir(path.join(profileDir, "Default"), { recursive: true });
  await fsp.writeFile(path.join(profileDir, "Default", "Preferences"), JSON.stringify({
    extensions: { settings: { abcdefghijklmnop: { path: extensionDir } } },
  }));
  let currentUrl = "about:blank";
  const popup = {
    url: () => currentUrl,
    goto: async (url) => { currentUrl = url; },
    close: async () => {},
  };
  const pages = [];
  const context = {
    serviceWorkers: () => [],
    backgroundPages: () => [],
    pages: () => pages,
    newPage: async () => {
      pages.push(popup);
      return popup;
    },
  };
  const browserType = {
    connectOverCDP: async () => ({
      contexts: () => [context],
      close: async () => {},
    }),
  };
  const options = resolveBrowserOptions({
    FLOW_B_PW_PROFILE: profileDir,
    FLOW_B_EXTENSION_DIR: extensionDir,
    FLOW_B_CDP_ENDPOINT: "http://127.0.0.1:9223",
    FLOW_B_PLUGIN_TIMEOUT_MS: "5",
  }, "/tmp/cft");

  assert.equal(await launchFlowContext(options, browserType), context);
  assert.equal(currentUrl, "chrome-extension://abcdefghijklmnop/popup.html");
});

test("CDP attachment reads unpacked extension registration from Secure Preferences", async () => {
  const extensionDir = await extensionFixture();
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-b-secure-profile-"));
  await fsp.mkdir(path.join(profileDir, "Default"), { recursive: true });
  await fsp.writeFile(path.join(profileDir, "Default", "Secure Preferences"), JSON.stringify({
    extensions: { settings: { ponmlkjihgfedcba: { path: extensionDir } } },
  }));
  let currentUrl = "about:blank";
  const popup = {
    url: () => currentUrl,
    goto: async (url) => { currentUrl = url; },
    close: async () => {},
  };
  const pages = [];
  const context = {
    serviceWorkers: () => [],
    backgroundPages: () => [],
    pages: () => pages,
    newPage: async () => {
      pages.push(popup);
      return popup;
    },
  };
  const browserType = {
    connectOverCDP: async () => ({ contexts: () => [context], close: async () => {} }),
  };
  const options = resolveBrowserOptions({
    FLOW_B_PW_PROFILE: profileDir,
    FLOW_B_EXTENSION_DIR: extensionDir,
    FLOW_B_CDP_ENDPOINT: "http://127.0.0.1:9223",
    FLOW_B_PLUGIN_TIMEOUT_MS: "5",
  }, "/tmp/cft");

  assert.equal(await launchFlowContext(options, browserType), context);
  assert.equal(currentUrl, "chrome-extension://ponmlkjihgfedcba/popup.html");
});

test("empty extension token is repaired through the plugin's own login button", async () => {
  let authenticated = false;
  let clicked = false;
  const worker = {
    url: () => "chrome-extension://abc/background.js",
    evaluate: async () => authenticated,
  };
  const button = {
    waitFor: async () => {},
    count: async () => 1,
    click: async () => { clicked = true; authenticated = true; },
  };
  const page = {
    url: () => "about:blank",
    isClosed: () => false,
    goto: async () => {},
    getByRole: () => button,
    close: async () => {},
  };
  const context = {
    serviceWorkers: () => [worker],
    pages: () => [page],
    newPage: async () => page,
  };
  assert.equal(await ensureMaoziPluginLogin(context, { timeout: 100 }), true);
  assert.equal(clicked, true);
});

test("extension token check tolerates worker API warm-up without reopening login", async () => {
  let checks = 0;
  let clicked = false;
  const worker = {
    url: () => "chrome-extension://abc/background.js",
    evaluate: async () => {
      checks += 1;
      return checks >= 3;
    },
  };
  const context = {
    serviceWorkers: () => [worker],
    pages: () => [{
      url: () => "https://www.ozon.ru/",
      getByRole: () => ({
        count: async () => 1,
        click: async () => { clicked = true; },
      }),
    }],
  };

  assert.equal(await ensureMaoziPluginLogin(context, { timeout: 500 }), true);
  assert.equal(checks, 3);
  assert.equal(clicked, false);
});

test("device-full continuation only clicks when explicitly enabled", async () => {
  let token = "";
  let clicked = false;
  const page = {
    evaluate: async () => token,
    getByRole: () => ({ count: async () => 1, click: async () => { clicked = true; token = "new-token"; } }),
    waitForFunction: async () => {},
  };
  await assert.rejects(() => ensureMaoziLogin(page), /not logged in/i);
  assert.equal(clicked, false);
  assert.equal(await ensureMaoziLogin(page, { continueDeviceLogin: true }), "new-token");
  assert.equal(clicked, true);
});

test("Maozi navigation reuses an existing authenticated page", async () => {
  let newPageCalls = 0;
  const existing = {
    url: () => "https://ozon.maozierp.com/#/dashboard",
    isClosed: () => false,
    goto: async () => {},
  };
  const context = { pages: () => [existing], newPage: async () => { newPageCalls += 1; return null; } };
  assert.equal(await openMaoziPage(context, { settleMs: 0 }), existing);
  assert.equal(newPageCalls, 0);
});

test("Maozi navigation closes a page it created when goto fails", async () => {
  let closed = 0;
  const opened = {
    url: () => "about:blank",
    isClosed: () => false,
    goto: async () => { throw new Error("navigation failed"); },
    close: async () => { closed += 1; },
  };
  const context = {
    pages: () => [],
    newPage: async () => opened,
  };

  await assert.rejects(
    openMaoziPage(context, { forceNew: true, settleMs: 0 }),
    /navigation failed/,
  );
  assert.equal(closed, 1);
});

test("force-new Maozi navigation waits for a delayed authenticated replacement after SSO closes", async () => {
  let pageChecks = 0;
  let openedClosed = false;
  const replacement = {
    url: () => "https://ozon.maozierp.com/#/product/favorite",
    isClosed: () => false,
  };
  const opened = {
    url: () => "https://sso.maozierp.com/login",
    isClosed: () => openedClosed,
    goto: async () => { openedClosed = true; },
  };
  const context = {
    pages: () => {
      pageChecks += 1;
      return pageChecks >= 3 ? [replacement] : [];
    },
    newPage: async () => opened,
  };
  assert.equal(await openMaoziPage(context, {
    forceNew: true,
    settleMs: 0,
    recoveryTimeoutMs: 50,
    recoveryPollMs: 1,
  }), replacement);
});

test("force-new Maozi navigation never borrows another session's existing page after SSO closes", async () => {
  const existing = {
    url: () => "https://ozon.maozierp.com/#/product/favorite",
    isClosed: () => false,
  };
  let openedClosed = false;
  const opened = {
    url: () => "https://sso.maozierp.com/login",
    isClosed: () => openedClosed,
    goto: async () => { openedClosed = true; },
  };
  const context = {
    pages: () => [existing],
    newPage: async () => opened,
  };

  await assert.rejects(
    openMaoziPage(context, {
      forceNew: true,
      settleMs: 0,
      recoveryTimeoutMs: 5,
      recoveryPollMs: 1,
    }),
    /SSO page closed/i,
  );
});

test("browser options reject a missing or invalid extension manifest", async () => {
  const extensionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-b-extension-"));
  assert.throws(() => resolveBrowserOptions({ FLOW_B_PW_PROFILE: "/tmp/profile" }, "/tmp/cft"), /FLOW_B_EXTENSION_DIR/);
  assert.throws(() => resolveBrowserOptions({ FLOW_B_PW_PROFILE: "/tmp/profile", FLOW_B_EXTENSION_DIR: extensionDir }, "/tmp/cft"), /manifest\.json/);
  fs.writeFileSync(path.join(extensionDir, "manifest.json"), "not-json");
  assert.throws(() => resolveBrowserOptions({ FLOW_B_PW_PROFILE: "/tmp/profile", FLOW_B_EXTENSION_DIR: extensionDir }, "/tmp/cft"), /valid JSON/);
});

test("Maozi login requires a non-empty access token", async () => {
  const page = { evaluate: async () => " token " };
  assert.equal(await assertMaoziLogin(page), "token");
  await assert.rejects(() => assertMaoziLogin({ evaluate: async () => "" }), /not logged in/i);
});

test("plugin assertion accepts service workers and rejects a missing target", async () => {
  const worker = { url: () => "chrome-extension://abc/background.js" };
  assert.equal(await assertPluginLoaded({ serviceWorkers: () => [worker], pages: () => [] }, { timeout: 20, interval: 1 }), worker);
  await assert.rejects(
    () => assertPluginLoaded({ serviceWorkers: () => [], pages: () => [] }, { timeout: 5, interval: 1 }),
    /Maozi extension/i,
  );
});
