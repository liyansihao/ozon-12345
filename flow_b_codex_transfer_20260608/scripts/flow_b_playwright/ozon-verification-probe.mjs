#!/usr/bin/env node

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  isOzonAuthenticationText,
  isOzonCaptchaText,
  isOzonSoftBlockError,
} from "./ozon-access-controller.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ozonHost(value) {
  try {
    const hostname = new URL(String(value || "")).hostname.toLowerCase();
    return hostname === "ozon.ru" || hostname.endsWith(".ozon.ru");
  } catch {
    return false;
  }
}

export function classifyOzonVerificationSnapshot(snapshot = {}) {
  const url = String(snapshot.url || "");
  const title = String(snapshot.title || "");
  const text = String(snapshot.text || "");
  const securityText = String(snapshot.security_text || "");
  const rawStatus = snapshot.http_status;
  const status = rawStatus === null || rawStatus === undefined || rawStatus === ""
    ? Number.NaN
    : Number(rawStatus);
  const productLinks = Math.max(0, Math.floor(Number(snapshot.product_link_count) || 0));
  const productEvidence = snapshot.product_evidence === true;
  const usableStructure = productEvidence || productLinks >= 3;
  const urlAndTitle = `${url} ${title}`;
  const bodyHead = text.slice(0, 12_000);
  const captcha = isOzonCaptchaText(`${urlAndTitle} ${securityText} ${bodyHead}`);
  const authentication = isOzonAuthenticationText(
    usableStructure
      ? `${urlAndTitle} ${securityText}`
      : `${urlAndTitle} ${securityText} ${bodyHead}`,
  );
  const softBlock = isOzonSoftBlockError(`${urlAndTitle} ${securityText} ${bodyHead}`);
  const technicalError = String(snapshot.error || "").trim();
  let classification = "INDETERMINATE";
  let reason = "page-structure-not-ready";
  if (technicalError) {
    reason = "probe-technical-error";
  } else if (!ozonHost(url)) {
    reason = "non-ozon-final-url";
  } else if (captcha) {
    classification = "BLOCKED";
    reason = "captcha-present";
  } else if (authentication) {
    classification = "BLOCKED";
    reason = "authentication-present";
  } else if (softBlock) {
    classification = "BLOCKED";
    reason = "soft-block-present";
  } else if (!Number.isFinite(status) || status < 200 || status >= 300) {
    reason = "http-status-not-ready";
  } else if (usableStructure) {
    classification = "READY";
    reason = productEvidence ? "product-structure-ready" : "listing-structure-ready";
  }
  return {
    version: "ozon-verification-probe-v1",
    classification,
    reason,
    final_url: url || null,
    title: title.slice(0, 240) || null,
    http_status: Number.isFinite(status) ? status : null,
    product_link_count: productLinks,
    product_evidence: productEvidence,
    captcha,
    authentication,
    soft_block: softBlock,
    error: technicalError.slice(0, 500) || null,
    text_sha256: crypto.createHash("sha256").update(text).digest("hex"),
  };
}

export async function probeOzonVerification({
  cdpEndpoint,
  url,
  timeoutMs = 45_000,
  settleMs = 2_000,
  browserType = chromium,
} = {}) {
  const endpoint = String(cdpEndpoint || "").trim();
  if (!/^https?:\/\//iu.test(endpoint)) throw new TypeError("valid CDP endpoint is required");
  if (!ozonHost(url)) throw new TypeError("verification probe URL must be an Ozon URL");
  const timeout = Math.max(5_000, Number(timeoutMs) || 45_000);
  const startedAt = Date.now();
  const deadlineAt = startedAt + timeout;
  let page;
  try {
    const browser = await browserType.connectOverCDP(endpoint, { timeout });
    const context = browser.contexts()[0];
    if (!context) throw new Error("CDP browser has no default context");
    page = await context.newPage();
    const navigationTimeout = deadlineAt - Date.now();
    if (navigationTimeout <= 0) throw new Error("verification probe deadline expired before navigation");
    const response = await page.goto(String(url), {
      waitUntil: "domcontentloaded",
      timeout: navigationTimeout,
    });
    const httpStatus = response?.status?.() ?? null;
    const pollMs = Math.min(2_000, Math.max(100, Number(settleMs) || 2_000));
    let lastResult;
    do {
      const snapshot = await page.evaluate(() => {
        const bodyText = String(document.body?.innerText || "").slice(0, 20_000);
        const isVisible = (entry) => {
          const style = getComputedStyle(entry);
          const box = entry.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden"
            && box.width > 0 && box.height > 0;
        };
        const productLinks = new Set([...document.querySelectorAll('a[href*="/product/"]')]
          .filter(isVisible)
          .map((entry) => String(entry.href || entry.getAttribute("href") || ""))
          .filter((entry) => entry.includes("/product/")));
        const securityUiPattern = /^(?:войти(?:\s+или\s+зарегистрироваться)?|войдите(?:\s+в\s+аккаунт)?|авторизуйтесь|sign in|log in|login|ozon id(?:\s+.*)?|mfa(?:\s+.*)?|2fa(?:\s+.*)?|verification required(?:\s+.*)?|(?:登录|重新登录|请登录|登录已失效|身份验证|验证码|人机验证)(?:\s+.*)?)$/iu;
        const visibleDialogs = [...document.querySelectorAll(
          '[role="dialog"], [aria-modal="true"], form, button, a, h1, h2, [data-widget*="login" i], [data-widget*="auth" i]',
        )]
          .filter(isVisible)
          .map((entry) => String(entry.innerText || ""))
          .map((value) => value.trim())
          .filter((value) => value && securityUiPattern.test(value) && value.length <= 500)
          .join("\n")
          .slice(0, 4_000);
        const pathName = String(location.pathname || "");
        const productEvidence = pathName.includes("/product/")
          && Boolean(document.querySelector('meta[property="og:image"]')?.content)
          && Boolean([...document.querySelectorAll("h1")].some(isVisible))
          && /(?:₽|руб|price)/iu.test(bodyText);
        return {
          url: String(location.href || ""),
          title: String(document.title || ""),
          text: bodyText,
          security_text: visibleDialogs,
          product_link_count: productLinks.size,
          product_evidence: productEvidence,
        };
      });
      lastResult = classifyOzonVerificationSnapshot({
        ...snapshot,
        http_status: httpStatus,
      });
      if (lastResult.classification !== "INDETERMINATE") return lastResult;
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) break;
      await delay(Math.min(pollMs, remainingMs));
    } while (Date.now() < deadlineAt);
    return lastResult;
  } catch (error) {
    return classifyOzonVerificationSnapshot({
      url: page?.url?.() || String(url || ""),
      error: String(error?.message || error),
    });
  } finally {
    await page?.close?.().catch(() => {});
    // This command always runs in a dedicated subprocess. Exiting that process
    // disconnects CDP without sending a close command to the shared browser.
  }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) continue;
    values[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return values;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const result = await probeOzonVerification({
    cdpEndpoint: options.endpoint,
    url: options.url,
    timeoutMs: Number(options["timeout-ms"]) || 45_000,
    settleMs: Number(options["settle-ms"]) || 2_000,
  });
  await new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      process.stderr.write(`${error?.stack || String(error)}\n`, () => process.exit(1));
    });
}
