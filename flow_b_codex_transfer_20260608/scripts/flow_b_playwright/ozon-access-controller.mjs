import fs from "node:fs/promises";
import path from "node:path";

const controllersByContext = new WeakMap();
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_NON_SOURCE_BURST = 8;

function interval(value, fallback = 15_000) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveInteger(value, fallback) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function queuePriority(kind) {
  if (kind === "publish-detail") return "high";
  if (kind === "source") return "low";
  return "medium";
}

export function resolveOzonAccessStateFile(env = process.env) {
  const configured = String(env.FLOW_B_OZON_ACCESS_STATE || "").trim();
  if (configured) return path.resolve(configured);
  const profile = String(env.FLOW_B_PW_PROFILE || "").trim();
  return profile ? path.join(path.dirname(path.resolve(profile)), "ozon_access_state.json") : null;
}

export function isOzonCaptchaText(value) {
  return /captcha|капч|(?:подтвердите|провер\w*)[^\n]{0,80}(?:человек|не робот)|验证码|人机验证/i
    .test(String(value || ""));
}

export function isOzonCaptchaError(error) {
  return isOzonCaptchaText(error?.message || error);
}

export function isOzonAuthenticationText(value) {
  return /(?:https?:\/\/(?:www\.)?ozon\.ru\/(?:[^/?#]+\/)*(?:login|signin|auth)(?:[/?#]|$)|\bmfa\b|multi[- ]factor|two[- ]factor|2fa|verification required|authentication required|login required|session (?:has )?expired|\b(?:sign|log) in\b|\bozon id\b|\bвойти\b|войдите|авторизуйтесь|登录(?:已失效|过期|异常|后继续)|重新登录|身份验证)/i
    .test(String(value || ""));
}

export function isOzonHardStopError(error) {
  return isOzonCaptchaError(error) || isOzonAuthenticationText(error?.message || error);
}

export function isOzonSoftBlockError(error) {
  return /soft block|soft-block|access denied|captcha|доступ ограничен|похоже, нет(?:\s|\u00a0)+соединения|no connection|incident:\s*[a-z0-9_]+/i
    .test(String(error?.message || error || ""));
}

export function isOzonAccessStoppedError(error) {
  return error?.code === "FLOW_B_OZON_ACCESS_STOPPED";
}

export function isOzonAccessQueueExpiredError(error) {
  return error?.code === "FLOW_B_OZON_ACCESS_QUEUE_EXPIRED";
}

function queueExpiredError(metadata = {}, deadlineAt = null) {
  const kind = String(metadata.kind || "operation");
  const error = new Error(`Ozon access ${kind} expired before operation start`);
  error.code = "FLOW_B_OZON_ACCESS_QUEUE_EXPIRED";
  error.phase = "queue-wait";
  error.deadline_at_ms = Number.isFinite(Number(deadlineAt)) ? Number(deadlineAt) : null;
  return error;
}

function queueCancelledError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const reason = signal?.reason === undefined
    ? "caller cancelled queued Ozon work"
    : String(signal.reason);
  const error = new Error(reason);
  error.code = "FLOW_B_OZON_ACCESS_QUEUE_CANCELLED";
  error.phase = "queue-wait";
  return error;
}

function stoppedError(reason, state = {}) {
  const error = new Error(`Ozon access stopped; manual clearance required: ${reason || state.reason || "soft block"}`);
  error.code = "FLOW_B_OZON_ACCESS_STOPPED";
  error.ozon_access_state = state;
  return error;
}

async function readState(filename) {
  if (!filename) return {};
  try {
    const value = JSON.parse(await fs.readFile(filename, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function writeState(filename, state) {
  if (!filename) return;
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function readOzonAccessState(filename, { strict = false } = {}) {
  const resolved = filename ? path.resolve(filename) : null;
  if (!strict) return readState(resolved);
  if (!resolved) return {};
  try {
    const value = JSON.parse(await fs.readFile(resolved, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Ozon access state must be a JSON object");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

export async function clearOzonVerificationLockForAutomaticRecovery({
  stateFile,
  expectedUpdatedAt,
  expectedReason,
  expectedLastUrl,
  evidence = {},
  now = new Date(),
  warmupIntervalMs = 8_000,
} = {}) {
  const filename = stateFile ? path.resolve(stateFile) : null;
  if (!filename) return { cleared: false, reason: "access-state-path-unavailable" };
  const prior = await readOzonAccessState(filename, { strict: true });
  if (prior?.requires_manual_clear !== true) {
    return { cleared: false, reason: "verification-lock-not-set", filename };
  }
  if (String(prior.updated_at || "") !== String(expectedUpdatedAt || "")
    || String(prior.reason || "") !== String(expectedReason || "")
    || String(prior.last_url || "") !== String(expectedLastUrl || "")) {
    return { cleared: false, reason: "verification-lock-changed", filename };
  }
  const observed = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(observed.getTime())) throw new TypeError("now must be a valid date");
  const recoveredAt = observed.toISOString();
  const intervalMs = Math.max(1_000, Number(warmupIntervalMs) || 8_000);
  const recoveryEvidence = {
    recovered_at: recoveredAt,
    source: "supervisor-automatic-verification-recovery",
    prior_reason: String(prior.reason || "verification required"),
    prior_url: String(prior.last_url || "") || null,
    ...evidence,
  };
  const next = {
    ...prior,
    updated_at: recoveredAt,
    requires_manual_clear: false,
    captcha_retry_pending: false,
    captcha_retry_at: null,
    reason: null,
    current_interval_ms: Math.max(Number(prior.current_interval_ms) || 0, intervalMs),
    warmup_started_at_ms: observed.getTime(),
    warmup_successes: 0,
    warmup_complete: false,
    stable_successes: 0,
    next_allowed_at_ms: observed.getTime() + intervalMs,
    verification_retry_pending: false,
    verification_auto_recovered_at: recoveredAt,
    verification_auto_recovery_evidence: recoveryEvidence,
  };
  await writeState(filename, next);
  return { cleared: true, filename, evidence: recoveryEvidence, state: next };
}

export function createOzonAccessController({
  stateFile = null,
  logFile = null,
  minIntervalMs = 15_000,
  baselineIntervalMs = null,
  warmupIntervalMs = null,
  maxIntervalMs = null,
  warmupDurationMs = null,
  warmupSuccessCount = null,
  stableSuccessCount = null,
  intervalStepMs = null,
  softBlockStepMs = null,
  now = () => Date.now(),
  sleep = defaultSleep,
} = {}) {
  const filename = stateFile ? path.resolve(stateFile) : null;
  const timelineFilename = logFile ? path.resolve(logFile) : null;
  const minimumInterval = interval(minIntervalMs);
  const dynamicPacing = [
    baselineIntervalMs,
    warmupIntervalMs,
    maxIntervalMs,
    warmupDurationMs,
    warmupSuccessCount,
    stableSuccessCount,
    intervalStepMs,
    softBlockStepMs,
  ].some((value) => value !== null && value !== undefined);
  const baselineInterval = interval(baselineIntervalMs, minimumInterval);
  const warmupInterval = Math.max(
    baselineInterval,
    interval(warmupIntervalMs, minimumInterval),
  );
  const maximumInterval = Math.max(
    warmupInterval,
    interval(maxIntervalMs, warmupInterval),
  );
  const warmupDuration = positiveInteger(
    warmupDurationMs,
    dynamicPacing ? 30 * 60_000 : 0,
  );
  const warmupSuccessTarget = positiveInteger(
    warmupSuccessCount,
    dynamicPacing ? 20 : 0,
  );
  const stableSuccessTarget = Math.max(1, positiveInteger(
    stableSuccessCount,
    dynamicPacing ? 20 : 1,
  ));
  const intervalStep = Math.max(1, positiveInteger(
    intervalStepMs,
    dynamicPacing ? 500 : 1,
  ));
  const softBlockStep = Math.max(1, positiveInteger(
    softBlockStepMs,
    dynamicPacing ? 1_500 : 1,
  ));
  let state = null;
  let draining = false;
  let consecutiveNonSource = 0;
  const queues = {
    high: [],
    medium: [],
    low: [],
  };
  const skippedTask = Symbol("skipped Ozon access task");

  const load = async () => {
    if (state) return state;
    state = await readState(filename);
    if (state.requires_manual_clear
      && isOzonSoftBlockError(state.reason)
      && !isOzonHardStopError(state.reason)) {
      state = {
        ...state,
        updated_at: new Date(now()).toISOString(),
        requires_manual_clear: false,
        auto_recovered_soft_block_at: new Date(now()).toISOString(),
        reason: null,
      };
      await writeState(filename, state);
    }
    const loadedAt = now();
    const persistedInterval = Number(state.current_interval_ms);
    const persistedWarmupStartedAt = Number(state.warmup_started_at_ms);
    const warmupComplete = state.warmup_complete === true
      || (!dynamicPacing && state.warmup_complete !== false);
    state = {
      ...state,
      version: 2,
      current_interval_ms: Math.max(
        baselineInterval,
        Math.min(
          maximumInterval,
          Number.isFinite(persistedInterval)
            ? persistedInterval
            : warmupComplete ? baselineInterval : warmupInterval,
        ),
      ),
      warmup_started_at_ms: Number.isFinite(persistedWarmupStartedAt)
        ? persistedWarmupStartedAt
        : loadedAt,
      warmup_successes: Math.max(0, Math.floor(Number(state.warmup_successes) || 0)),
      warmup_complete: warmupComplete,
      stable_successes: Math.max(0, Math.floor(Number(state.stable_successes) || 0)),
    };
    return state;
  };
  const persist = async () => writeState(filename, state || {});
  const currentInterval = () => {
    const value = Number(state?.current_interval_ms);
    return Number.isFinite(value) && value >= 0 ? value : warmupInterval;
  };
  const recordSuccess = (completedAt) => {
    if (state.verification_retry_pending || Number(state.verification_consecutive_failures) > 0) {
      state.verification_retry_pending = false;
      state.verification_retry_at = null;
      state.verification_consecutive_failures = 0;
      state.verification_last_recovered_at = new Date(completedAt).toISOString();
    }
    if (!state.warmup_complete) {
      state.warmup_successes = Math.max(0, Number(state.warmup_successes) || 0) + 1;
      state.stable_successes = Math.max(0, Number(state.stable_successes) || 0) + 1;
      if (state.stable_successes >= stableSuccessTarget) {
        state.current_interval_ms = Math.max(
          warmupInterval,
          Number(state.current_interval_ms) - intervalStep,
        );
        state.stable_successes = 0;
      }
      if (
        completedAt - Number(state.warmup_started_at_ms) >= warmupDuration
        && state.warmup_successes >= warmupSuccessTarget
      ) {
        state.warmup_complete = true;
        state.warmup_completed_at = new Date(completedAt).toISOString();
        state.current_interval_ms = baselineInterval;
        state.stable_successes = 0;
      }
      return;
    }
    state.stable_successes = Math.max(0, Number(state.stable_successes) || 0) + 1;
    if (state.stable_successes >= stableSuccessTarget) {
      state.current_interval_ms = Math.max(
        baselineInterval,
        Number(state.current_interval_ms) - intervalStep,
      );
      state.stable_successes = 0;
    }
  };
  const recordSoftBlock = (blockedAt) => {
    state.current_interval_ms = Math.min(
      maximumInterval,
      Math.max(baselineInterval, currentInterval())
        + softBlockStep,
    );
    state.stable_successes = 0;
    state.last_soft_block_at = new Date(blockedAt).toISOString();
    state.soft_block_count = Math.max(0, Number(state.soft_block_count) || 0) + 1;
    if (!state.warmup_complete) {
      state.warmup_started_at_ms = blockedAt;
      state.warmup_successes = 0;
    }
  };
  const settle = async () => {
    const settledAt = now();
    state = {
      ...state,
      updated_at: new Date(settledAt).toISOString(),
      last_completed_at: new Date(settledAt).toISOString(),
      next_allowed_at_ms: Math.max(
        Number(state?.next_allowed_at_ms) || 0,
        settledAt + currentInterval(),
      ),
    };
    await persist();
  };
  const record = async (event, metadata = {}, details = {}) => {
    if (!timelineFilename) return;
    await fs.mkdir(path.dirname(timelineFilename), { recursive: true });
    await fs.appendFile(timelineFilename, `${JSON.stringify({
      at: new Date(now()).toISOString(),
      event,
      kind: metadata.kind || null,
      url: metadata.url || null,
      ...details,
    })}\n`, "utf8");
  };
  const stop = async (reason, metadata = {}) => {
    await load();
    const at = new Date(now()).toISOString();
    state = {
      ...state,
      version: 2,
      updated_at: at,
      stopped_at: state.stopped_at || at,
      requires_manual_clear: true,
      reason: String(reason || "Ozon soft block"),
      last_kind: metadata.kind || state.last_kind || null,
      last_url: metadata.url || state.last_url || null,
    };
    await persist();
    await record("stopped", metadata, { reason: state.reason });
    return stoppedError(state.reason, state);
  };
  const discardUnavailableHeads = (queue) => {
    while (queue.length > 0 && !queue[0].refresh()) queue.shift();
  };
  const dequeue = () => {
    discardUnavailableHeads(queues.high);
    discardUnavailableHeads(queues.medium);
    discardUnavailableHeads(queues.low);
    if (queues.low.length > 0 && consecutiveNonSource >= MAX_NON_SOURCE_BURST) {
      return queues.low.shift();
    }
    if (queues.high.length > 0) {
      return queues.high.shift();
    }
    if (queues.medium.length > 0) {
      return queues.medium.shift();
    }
    if (queues.low.length > 0) {
      return queues.low.shift();
    }
    return null;
  };
  const beginTask = (task) => {
    if (!task.begin()) return false;
    if (task.metadata.kind === "source") consecutiveNonSource = 0;
    else consecutiveNonSource += 1;
    return true;
  };
  const execute = async (task) => {
    const { metadata, operation } = task;
    await load();
    if (state.requires_manual_clear) {
      if (!beginTask(task)) return skippedTask;
      throw stoppedError(state.reason, state);
    }
    const waitMs = Math.max(0, Number(state.next_allowed_at_ms) - now());
    if (waitMs > 0) await sleep(waitMs);
    if (!beginTask(task)) return skippedTask;
    if (state.requires_manual_clear) throw stoppedError(state.reason, state);
    const startedAt = now();
    state = {
      ...state,
      version: 2,
      updated_at: new Date(startedAt).toISOString(),
      last_started_at: new Date(startedAt).toISOString(),
      next_allowed_at_ms: Math.max(Number(state.next_allowed_at_ms) || 0, startedAt),
      last_kind: metadata.kind || null,
      last_url: metadata.url || null,
      requires_manual_clear: false,
    };
    await persist();
    await record("started", metadata, { next_allowed_at_ms: state.next_allowed_at_ms });
    try {
      const result = await operation();
      recordSuccess(now());
      await settle();
      await record("succeeded", metadata, {
        interval_ms: state.current_interval_ms,
        warmup_complete: state.warmup_complete,
      });
      return result;
    } catch (error) {
      let failure = error;
      if (isOzonHardStopError(failure)) {
        const detectedAt = now();
        state = {
          ...state,
          version: 2,
          updated_at: new Date(detectedAt).toISOString(),
          requires_manual_clear: true,
          captcha_retry_pending: false,
          captcha_retry_at: null,
          captcha_retry_count: isOzonCaptchaError(failure)
            ? Math.max(0, Number(state?.captcha_retry_count) || 0) + 1
            : Math.max(0, Number(state?.captcha_retry_count) || 0),
          verification_retry_pending: true,
          verification_retry_at: null,
          verification_consecutive_failures:
            Math.max(0, Number(state?.verification_consecutive_failures) || 0) + 1,
          verification_last_detected_at: new Date(detectedAt).toISOString(),
          reason: String(failure?.message || failure),
        };
        await persist();
        throw await stop(failure?.message || failure, metadata);
      }
      if (isOzonAccessStoppedError(failure)) {
        await record("rejected_stopped", metadata, { reason: String(failure?.message || failure) });
        throw failure;
      }
      if (isOzonSoftBlockError(failure)) {
        recordSoftBlock(now());
        await settle();
        await record("soft_block", metadata, {
          reason: String(failure?.message || failure),
          interval_ms: state.current_interval_ms,
        });
        throw failure;
      }
      await settle();
      await record("failed", metadata, { reason: String(failure?.message || failure) });
      throw failure;
    }
  };
  const drain = async () => {
    while (true) {
      const task = dequeue();
      if (!task) {
        draining = false;
        return;
      }
      try {
        const result = await execute(task);
        if (result !== skippedTask) task.resolve(result);
      } catch (error) {
        task.reject(error);
      }
    }
  };
  const scheduleDrain = () => {
    if (draining) return;
    draining = true;
    void drain();
  };

  return {
    stateFile: filename,
    minIntervalMs: baselineInterval,
    pacing: {
      baselineIntervalMs: baselineInterval,
      warmupIntervalMs: warmupInterval,
      maxIntervalMs: maximumInterval,
      warmupDurationMs: warmupDuration,
      warmupSuccessCount: warmupSuccessTarget,
      stableSuccessCount: stableSuccessTarget,
      intervalStepMs: intervalStep,
      softBlockStepMs: softBlockStep,
    },
    async snapshot() { return { ...(await load()) }; },
    async stop(reason, metadata = {}) { throw await stop(reason, metadata); },
    run(metadata = {}, operation, { deadlineAt = null, signal = null } = {}) {
      if (typeof operation !== "function") throw new TypeError("Ozon access operation is required");
      return new Promise((resolve, reject) => {
        const hasDeadline = deadlineAt !== null
          && deadlineAt !== undefined
          && String(deadlineAt).trim() !== "";
        const numericDeadline = Number(deadlineAt);
        const activeDeadline = hasDeadline && Number.isFinite(numericDeadline)
          ? numericDeadline
          : null;
        let status = "queued";
        let timer = null;
        let abortListener = null;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          timer = null;
          if (abortListener && typeof signal?.removeEventListener === "function") {
            signal.removeEventListener("abort", abortListener);
          }
          abortListener = null;
        };
        const rejectOnce = (error) => {
          if (status === "settled") return false;
          status = "settled";
          cleanup();
          reject(error);
          return true;
        };
        const task = {
          metadata,
          operation,
          resolve(value) {
            if (status === "settled") return false;
            status = "settled";
            cleanup();
            resolve(value);
            return true;
          },
          reject: rejectOnce,
          refresh() {
            if (status !== "queued") return false;
            if (signal?.aborted) {
              rejectOnce(queueCancelledError(signal));
              return false;
            }
            if (activeDeadline !== null && now() >= activeDeadline) {
              rejectOnce(queueExpiredError(metadata, activeDeadline));
              return false;
            }
            return true;
          },
          begin() {
            if (!task.refresh()) return false;
            status = "running";
            cleanup();
            return true;
          },
        };
        if (signal && typeof signal.addEventListener === "function") {
          abortListener = () => {
            if (status === "queued") rejectOnce(queueCancelledError(signal));
          };
          if (signal.aborted) abortListener();
          else signal.addEventListener("abort", abortListener, { once: true });
        }
        if (status === "queued" && activeDeadline !== null) {
          const remainingMs = Math.max(0, activeDeadline - now());
          if (remainingMs <= 0) {
            rejectOnce(queueExpiredError(metadata, activeDeadline));
          } else {
            timer = setTimeout(() => {
              if (status === "queued") rejectOnce(queueExpiredError(metadata, activeDeadline));
            }, remainingMs);
          }
        }
        if (status !== "queued") return;
        queues[queuePriority(metadata.kind)].push(task);
        scheduleDrain();
      });
    },
  };
}

export function ozonAccessControllerFor(context, env = process.env) {
  if (!context || (typeof context !== "object" && typeof context !== "function")) {
    throw new TypeError("Playwright context is required for the Ozon access controller");
  }
  let controller = controllersByContext.get(context);
  if (controller) return controller;
  controller = createOzonAccessController({
    stateFile: resolveOzonAccessStateFile(env),
    logFile: String(env.FLOW_B_OZON_ACCESS_LOG || "").trim() || null,
    minIntervalMs: interval(
      env.FLOW_B_OZON_WARMUP_INTERVAL_MS,
      interval(
        env.FLOW_B_OZON_GLOBAL_INTERVAL_MS,
        interval(env.FLOW_B_FAVORITE_DETAIL_INTERVAL_MS, 4_000),
      ),
    ),
    baselineIntervalMs: interval(env.FLOW_B_OZON_BASE_INTERVAL_MS, 3_000),
    warmupIntervalMs: interval(
      env.FLOW_B_OZON_WARMUP_INTERVAL_MS,
      interval(
        env.FLOW_B_OZON_GLOBAL_INTERVAL_MS,
        interval(env.FLOW_B_FAVORITE_DETAIL_INTERVAL_MS, 4_000),
      ),
    ),
    maxIntervalMs: interval(env.FLOW_B_OZON_MAX_INTERVAL_MS, 8_000),
    warmupDurationMs: interval(env.FLOW_B_OZON_WARMUP_DURATION_MS, 30 * 60_000),
    warmupSuccessCount: positiveInteger(env.FLOW_B_OZON_WARMUP_SUCCESS_COUNT, 20),
    stableSuccessCount: positiveInteger(env.FLOW_B_OZON_STABLE_SUCCESS_COUNT, 20),
    intervalStepMs: interval(env.FLOW_B_OZON_INTERVAL_STEP_MS, 500),
    softBlockStepMs: interval(env.FLOW_B_OZON_SOFT_BLOCK_STEP_MS, 1_500),
  });
  controllersByContext.set(context, controller);
  return controller;
}
