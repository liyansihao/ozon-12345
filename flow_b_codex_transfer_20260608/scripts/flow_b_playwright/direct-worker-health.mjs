import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const DIRECT_WORKER_HEALTH_SCHEMA_VERSION = 1;

function finiteTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizedErrorText(error) {
  return String(error?.message || error || "unknown direct source scan error")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1_000);
}

export function directWorkerErrorSignature(error) {
  return crypto.createHash("sha256").update(normalizedErrorText(error)).digest("hex");
}

async function writeJsonAtomic(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filename);
}

export function createDirectWorkerHealthTracker({
  filename,
  runId,
  generation,
  workerPid = process.pid,
  now = () => new Date(),
  write = writeJsonAtomic,
} = {}) {
  if (!String(filename || "").trim()) throw new TypeError("filename is required");
  if (!String(runId || "").trim()) throw new TypeError("runId is required");
  if (!String(generation || "").trim()) throw new TypeError("generation is required");
  if (!Number.isInteger(Number(workerPid)) || Number(workerPid) <= 0) {
    throw new TypeError("workerPid must be a positive integer");
  }

  const observed = now();
  const startedAt = (observed instanceof Date ? observed : new Date(observed)).toISOString();
  let state = {
    schema_version: DIRECT_WORKER_HEALTH_SCHEMA_VERSION,
    run_id: String(runId),
    worker_generation: String(generation),
    worker_pid: Number(workerPid),
    worker_started_at: startedAt,
    heartbeat_at: startedAt,
    producer: {
      phase: "starting",
      attempt_seq: 0,
      attempt_started_at: null,
      last_completed_at: null,
      last_success_at: null,
      last_error_at: null,
      first_consecutive_error_at: null,
      consecutive_errors: 0,
      error_signature: null,
      last_error: null,
      next_retry_at: null,
      activity_count: null,
      last_progress_at: null,
      last_progress_kind: null,
    },
  };

  const timestamp = () => {
    const value = now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  };
  let writeChain = Promise.resolve();
  const persist = (producerUpdate = {}) => {
    const heartbeatAt = timestamp();
    state = {
      ...state,
      heartbeat_at: heartbeatAt,
      producer: {
        ...state.producer,
        ...producerUpdate,
      },
    };
    const snapshot = structuredClone(state);
    const writeTask = writeChain.then(() => write(filename, snapshot));
    writeChain = writeTask.catch(() => {});
    return writeTask.then(() => structuredClone(snapshot));
  };

  return {
    snapshot: () => structuredClone(state),
    start: () => persist({ phase: "starting" }),
    scanStarted: () => persist({
      phase: "scanning",
      attempt_seq: Number(state.producer.attempt_seq || 0) + 1,
      attempt_started_at: timestamp(),
      next_retry_at: null,
    }),
    scanProgress: ({ kind = "source-progress" } = {}) => {
      const progressAt = timestamp();
      return persist({
        phase: "scanning",
        last_progress_at: progressAt,
        last_progress_kind: String(kind || "source-progress").slice(0, 100),
      });
    },
    scanSucceeded: (result = {}) => {
      const completedAt = timestamp();
      return persist({
        phase: "healthy",
        last_completed_at: completedAt,
        last_success_at: completedAt,
        last_error_at: null,
        first_consecutive_error_at: null,
        consecutive_errors: 0,
        error_signature: null,
        last_error: null,
        next_retry_at: null,
        activity_count: Number(
          result?.candidate_activity_count ?? result?.activity_count ?? 0,
        ) || 0,
      });
    },
    scanFailed: (error, { retryAt = null } = {}) => {
      const failedAt = timestamp();
      const errorSignature = directWorkerErrorSignature(error);
      const hasConsecutiveError = Number(state.producer.consecutive_errors || 0) > 0;
      return persist({
        phase: "error",
        last_completed_at: failedAt,
        last_error_at: failedAt,
        first_consecutive_error_at: hasConsecutiveError
          ? state.producer.first_consecutive_error_at
          : failedAt,
        consecutive_errors: hasConsecutiveError
          ? Number(state.producer.consecutive_errors || 0) + 1
          : 1,
        error_signature: errorSignature,
        last_error: normalizedErrorText(error),
        next_retry_at: retryAt,
        activity_count: null,
      });
    },
  };
}

export function directWorkerHealthDecision({
  health,
  expectedRunId,
  expectedGeneration,
  expectedWorkerPid,
  workerStartedAt,
  now = Date.now(),
  enabled = true,
  eligible = true,
  startupGraceMs = 180_000,
  staleMs = 1_200_000,
  errorThreshold = 3,
  lastRecoveryAt = null,
  recoveryHistory = [],
  recoveryCooldownMs = 1_800_000,
  recoveryWindowMs = 7_200_000,
  maxRecoveriesPerWindow = 2,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const workerStartedAtMs = workerStartedAt instanceof Date
    ? workerStartedAt.getTime()
    : Number(workerStartedAt);
  const grace = Math.max(0, Number(startupGraceMs) || 0);
  const stale = Math.max(1, Number(staleMs) || 1_200_000);
  const threshold = Math.max(1, Math.floor(Number(errorThreshold) || 3));
  const cooldown = Math.max(0, Number(recoveryCooldownMs) || 0);
  const recoveryWindow = Math.max(1, Number(recoveryWindowMs) || 7_200_000);
  const maxRecoveries = Math.max(1, Math.floor(Number(maxRecoveriesPerWindow) || 2));
  const base = {
    action: "continue",
    reason: "direct-producer-healthy",
    eligible: Boolean(enabled && eligible),
    consecutive_errors: Number(health?.producer?.consecutive_errors || 0),
    error_signature: health?.producer?.error_signature || null,
    heartbeat_at: health?.heartbeat_at || null,
    stale_ms: null,
  };

  if (!enabled) return { ...base, reason: "direct-producer-watchdog-disabled" };
  if (!eligible) return { ...base, reason: "direct-producer-watchdog-paused" };
  if (!Number.isFinite(nowMs) || !Number.isFinite(workerStartedAtMs)) {
    return { ...base, reason: "direct-producer-watchdog-invalid-clock" };
  }

  const currentIdentity = health?.schema_version === DIRECT_WORKER_HEALTH_SCHEMA_VERSION
    && String(health?.run_id || "") === String(expectedRunId || "")
    && String(health?.worker_generation || "") === String(expectedGeneration || "")
    && Number(health?.worker_pid) === Number(expectedWorkerPid);
  const heartbeatAtMs = finiteTimestamp(health?.heartbeat_at);
  const currentHeartbeat = currentIdentity
    && heartbeatAtMs !== null
    && heartbeatAtMs >= workerStartedAtMs;
  let recovery = null;
  let retryInProgress = false;
  if (!currentHeartbeat) {
    if (nowMs - workerStartedAtMs < grace) {
      return { ...base, reason: "direct-producer-startup-grace" };
    }
    recovery = {
      ...base,
      action: "restart-worker",
      reason: "direct-producer-heartbeat-missing",
    };
  } else {
    const consecutiveErrors = Number(health?.producer?.consecutive_errors || 0);
    if (health?.producer?.phase === "error" && consecutiveErrors >= threshold) {
      recovery = {
        ...base,
        action: "restart-worker",
        reason: "direct-source-scan-consecutive-errors",
        consecutive_errors: consecutiveErrors,
        first_error_at: health?.producer?.first_consecutive_error_at || null,
        last_error_at: health?.producer?.last_error_at || null,
        last_error: health?.producer?.last_error || null,
      };
    }
    retryInProgress = health?.producer?.phase === "scanning"
      && consecutiveErrors >= threshold;
  }

  const heartbeatStaleMs = currentHeartbeat ? Math.max(0, nowMs - heartbeatAtMs) : null;
  if (!recovery && currentHeartbeat && heartbeatStaleMs >= stale) {
    recovery = {
      ...base,
      action: "restart-worker",
      reason: "direct-producer-progress-stale",
      stale_ms: heartbeatStaleMs,
      producer_phase: health?.producer?.phase || null,
    };
  }

  if (!recovery) {
    return {
      ...base,
      reason: retryInProgress
        ? "direct-producer-retry-in-progress"
        : "direct-producer-healthy",
      stale_ms: heartbeatStaleMs,
      producer_phase: health?.producer?.phase || null,
    };
  }

  const recentRecoveries = (Array.isArray(recoveryHistory) ? recoveryHistory : [])
    .map((entry) => finiteTimestamp(entry?.at || entry))
    .filter((timestamp) => (
      timestamp !== null
      && timestamp <= nowMs
      && nowMs - timestamp < recoveryWindow
    ))
    .sort((left, right) => left - right);
  if (recentRecoveries.length >= maxRecoveries) {
    return {
      ...recovery,
      action: "defer-recovery",
      reason: "direct-producer-recovery-budget",
      trigger_reason: recovery.reason,
      recovery_count: recentRecoveries.length,
      cooldown_until: new Date(recentRecoveries[0] + recoveryWindow).toISOString(),
    };
  }

  const lastRecoveryAtMs = finiteTimestamp(lastRecoveryAt);
  if (lastRecoveryAtMs !== null && nowMs - lastRecoveryAtMs < cooldown) {
    return {
      ...recovery,
      action: "defer-recovery",
      reason: "direct-producer-recovery-cooldown",
      trigger_reason: recovery.reason,
      cooldown_until: new Date(lastRecoveryAtMs + cooldown).toISOString(),
    };
  }

  return recovery;
}
