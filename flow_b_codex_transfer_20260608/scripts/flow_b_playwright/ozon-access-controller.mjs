import fs from "node:fs/promises";
import path from "node:path";

const controllersByContext = new WeakMap();
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function interval(value, fallback = 15_000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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

export function isOzonSoftBlockError(error) {
  return /soft block|soft-block|access denied|captcha|доступ ограничен|похоже, нет(?:\s|\u00a0)+соединения|no connection|incident:\s*[a-z0-9_]+/i
    .test(String(error?.message || error || ""));
}

export function isOzonAccessStoppedError(error) {
  return error?.code === "FLOW_B_OZON_ACCESS_STOPPED";
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

export function createOzonAccessController({
  stateFile = null,
  logFile = null,
  minIntervalMs = 15_000,
  captchaReopenDelayMs = 600_000,
  now = () => Date.now(),
  sleep = defaultSleep,
} = {}) {
  const filename = stateFile ? path.resolve(stateFile) : null;
  const timelineFilename = logFile ? path.resolve(logFile) : null;
  const minimumInterval = interval(minIntervalMs);
  const captchaReopenDelay = interval(captchaReopenDelayMs, 600_000);
  let state = null;
  let chain = Promise.resolve();

  const load = async () => {
    if (state) return state;
    state = await readState(filename);
    return state;
  };
  const persist = async () => writeState(filename, state || {});
  const settle = async () => {
    const settledAt = now();
    state = {
      ...state,
      updated_at: new Date(settledAt).toISOString(),
      last_completed_at: new Date(settledAt).toISOString(),
      next_allowed_at_ms: Math.max(
        Number(state?.next_allowed_at_ms) || 0,
        settledAt + minimumInterval,
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
      version: 1,
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

  return {
    stateFile: filename,
    minIntervalMs: minimumInterval,
    async snapshot() { return { ...(await load()) }; },
    async stop(reason, metadata = {}) { throw await stop(reason, metadata); },
    run(metadata = {}, operation) {
      if (typeof operation !== "function") throw new TypeError("Ozon access operation is required");
      const task = chain.then(async () => {
        await load();
        if (state.requires_manual_clear) throw stoppedError(state.reason, state);
        const waitMs = Math.max(0, Number(state.next_allowed_at_ms) - now());
        if (waitMs > 0) await sleep(waitMs);
        if (state.requires_manual_clear) throw stoppedError(state.reason, state);
        const startedAt = now();
        state = {
          ...state,
          version: 1,
          updated_at: new Date(startedAt).toISOString(),
          last_started_at: new Date(startedAt).toISOString(),
          next_allowed_at_ms: startedAt + minimumInterval,
          last_kind: metadata.kind || null,
          last_url: metadata.url || null,
          requires_manual_clear: false,
        };
        await persist();
        await record("started", metadata, { next_allowed_at_ms: state.next_allowed_at_ms });
        try {
          const result = await operation();
          await settle();
          await record("succeeded", metadata);
          return result;
        } catch (error) {
          let failure = error;
          if (isOzonCaptchaError(failure)) {
            const detectedAt = now();
            const retryAt = detectedAt + captchaReopenDelay;
            state = {
              ...state,
              version: 1,
              updated_at: new Date(detectedAt).toISOString(),
              requires_manual_clear: true,
              captcha_retry_pending: true,
              captcha_retry_at: new Date(retryAt).toISOString(),
              captcha_retry_count: Math.max(0, Number(state?.captcha_retry_count) || 0) + 1,
              reason: String(failure?.message || failure),
            };
            await persist();
            await record("captcha_wait", metadata, { retry_at: state.captcha_retry_at, delay_ms: captchaReopenDelay });
            await sleep(captchaReopenDelay);
            const reopenedAt = now();
            state = {
              ...state,
              updated_at: new Date(reopenedAt).toISOString(),
              last_started_at: new Date(reopenedAt).toISOString(),
              next_allowed_at_ms: reopenedAt + minimumInterval,
              requires_manual_clear: false,
              captcha_retry_pending: false,
              captcha_reopened_at: new Date(reopenedAt).toISOString(),
              reason: null,
            };
            await persist();
            await record("captcha_reopened", metadata, { next_allowed_at_ms: state.next_allowed_at_ms });
            try {
              const result = await operation();
              await settle();
              await record("succeeded", metadata, { after_captcha_reopen: true });
              return result;
            } catch (retryError) {
              failure = retryError;
              state = { ...state, captcha_retry_pending: false };
              await persist();
            }
          }
          if (isOzonAccessStoppedError(failure)) {
            await record("rejected_stopped", metadata, { reason: String(failure?.message || failure) });
            throw failure;
          }
          if (isOzonSoftBlockError(failure)) throw await stop(failure?.message || failure, metadata);
          await settle();
          await record("failed", metadata, { reason: String(failure?.message || failure) });
          throw failure;
        }
      });
      chain = task.catch(() => {});
      return task;
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
      env.FLOW_B_OZON_GLOBAL_INTERVAL_MS,
      interval(env.FLOW_B_FAVORITE_DETAIL_INTERVAL_MS, 15_000),
    ),
    captchaReopenDelayMs: interval(env.FLOW_B_OZON_CAPTCHA_REOPEN_DELAY_MS, 600_000),
  });
  controllersByContext.set(context, controller);
  return controller;
}
