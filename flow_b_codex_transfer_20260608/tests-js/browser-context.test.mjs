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
  resolveBrowserOptions,
} from "../scripts/flow_b_playwright/browser-context.mjs";

async function extensionFixture() {
  const extensionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-b-extension-"));
  await fsp.writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "fixture", version: "1.0.0" }));
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
