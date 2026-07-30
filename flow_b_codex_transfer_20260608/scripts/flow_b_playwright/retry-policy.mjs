const DETERMINISTIC_PATTERNS = [
  /^fbs-evidence-missing$/iu,
  /^fbs-confirmation-inconsistent$/iu,
  /^non-pure-fbs$/iu,
  /^missing-shipping-mode/iu,
  /^1688-no-reliable-match$/iu,
  /^profit(?:_rate|-upper-bound).*<=\s*30/iu,
  /^duplicate-(?:title|sku|offer|account)/iu,
  /^prohibited-(?:category|title)/iu,
  /^excluded-sku$/iu,
  /^missing-(?:title|image|sale-price)$/iu,
];

const TRANSIENT_PATTERNS = [
  /(?:soft-block|rate-limit|429|timeout|timed out|network|temporar)/iu,
  /^1688-health-deferred$/iu,
  /^ozon-detail-soft-block-deferred$/iu,
  /^import-transient-error$/iu,
  /^reconciliation-online-product-missing$/iu,
  /^online-product-not-selling$/iu,
  /^stock-activation-(?:failed|rejected)$/iu,
];

export function shanghaiDayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("retry timestamp is invalid");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function classifySkuFailure(reason) {
  const normalized = String(reason || "").trim();
  if (DETERMINISTIC_PATTERNS.some((pattern) => pattern.test(normalized))) return "deterministic";
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(normalized))) return "transient";
  return "unknown";
}

export function boundedTransientFailure({
  reason,
  now = new Date(),
  previousAttempts = 0,
  previousDay = null,
  maxRetries = 2,
  backoffMs = 30_000,
  retryAt = null,
} = {}) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError("retry timestamp is invalid");
  const retryDay = shanghaiDayKey(date);
  const used = previousDay === retryDay
    ? Math.max(0, Math.floor(Number(previousAttempts) || 0))
    : 0;
  const nextAttempt = used + 1;
  const maximum = Math.max(0, Math.floor(Number(maxRetries) || 0));
  if (nextAttempt > maximum) {
    return {
      reason: "transient-retry-limit-exhausted",
      original_reason: String(reason || "transient-failure"),
      terminal: true,
      retry_at: null,
      retry_day: retryDay,
      transient_attempts: nextAttempt,
      retries_used: maximum,
    };
  }
  const configuredRetryAt = Date.parse(String(retryAt || ""));
  const nextRetryMs = Number.isFinite(configuredRetryAt) && configuredRetryAt > date.getTime()
    ? configuredRetryAt
    : date.getTime() + Math.max(1_000, Number(backoffMs) || 0);
  return {
    reason: String(reason || "transient-failure"),
    original_reason: null,
    terminal: false,
    retry_at: new Date(nextRetryMs).toISOString(),
    retry_day: retryDay,
    transient_attempts: nextAttempt,
    retries_used: nextAttempt,
  };
}
