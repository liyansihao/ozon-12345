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
    runtime_lane_schema_version: 1,
    producer: {
      phase: "starting",
      heartbeat_at: startedAt,
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
    consumer: {
      phase: "starting",
      heartbeat_at: startedAt,
      attempt_seq: 0,
      attempt_started_at: null,
      last_completed_at: null,
      last_progress_at: null,
      last_progress_kind: null,
      last_accepted_at: null,
      activity_count: null,
    },
    reconciliation: {
      phase: "starting",
      heartbeat_at: startedAt,
      attempt_seq: 0,
      attempt_started_at: null,
      last_completed_at: null,
      last_progress_at: null,
      last_progress_kind: null,
      activity_count: null,
      last_error: null,
      first_consecutive_error_at: null,
      consecutive_errors: 0,
    },
  };

  const timestamp = () => {
    const value = now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  };
  let writeChain = Promise.resolve();
  const persist = ({
    producer: producerUpdate = null,
    consumer: consumerUpdate = null,
    reconciliation: reconciliationUpdate = null,
  } = {}) => {
    const heartbeatAt = timestamp();
    state = {
      ...state,
      heartbeat_at: heartbeatAt,
      ...(producerUpdate ? {
        producer: {
          ...state.producer,
          heartbeat_at: heartbeatAt,
          ...producerUpdate,
        },
      } : {}),
      ...(consumerUpdate ? {
        consumer: {
          ...state.consumer,
          heartbeat_at: heartbeatAt,
          ...consumerUpdate,
        },
      } : {}),
      ...(reconciliationUpdate ? {
        reconciliation: {
          ...state.reconciliation,
          heartbeat_at: heartbeatAt,
          ...reconciliationUpdate,
        },
      } : {}),
    };
    const snapshot = structuredClone(state);
    const writeTask = writeChain.then(() => write(filename, snapshot));
    writeChain = writeTask.catch(() => {});
    return writeTask.then(() => structuredClone(snapshot));
  };

  return {
    snapshot: () => structuredClone(state),
    start: () => persist({ producer: { phase: "starting" } }),
    scanStarted: () => persist({ producer: {
      phase: "scanning",
      attempt_seq: Number(state.producer.attempt_seq || 0) + 1,
      attempt_started_at: timestamp(),
      next_retry_at: null,
    } }),
    scanProgress: ({ kind = "source-progress" } = {}) => {
      const progressAt = timestamp();
      return persist({ producer: {
        phase: "scanning",
        last_progress_at: progressAt,
        last_progress_kind: String(kind || "source-progress").slice(0, 100),
      } });
    },
    scanSucceeded: (result = {}) => {
      const completedAt = timestamp();
      return persist({ producer: {
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
      } });
    },
    scanFailed: (error, { retryAt = null } = {}) => {
      const failedAt = timestamp();
      const errorSignature = directWorkerErrorSignature(error);
      const hasConsecutiveError = Number(state.producer.consecutive_errors || 0) > 0;
      return persist({ producer: {
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
      } });
    },
    consumerRoundStarted: () => persist({ consumer: {
      phase: "running",
      attempt_seq: Number(state.consumer.attempt_seq || 0) + 1,
      attempt_started_at: timestamp(),
    } }),
    consumerProgress: ({ kind = "consumer-activity" } = {}) => {
      const progressAt = timestamp();
      return persist({ consumer: {
        phase: "running",
        last_progress_at: progressAt,
        last_progress_kind: String(kind || "consumer-activity").slice(0, 100),
        ...(["published", "submitted", "erp-accepted"].includes(String(kind || ""))
          ? { last_accepted_at: progressAt }
          : {}),
      } });
    },
    consumerRoundCompleted: (result = {}) => {
      const completedAt = timestamp();
      return persist({ consumer: {
        phase: "healthy",
        last_completed_at: completedAt,
        last_progress_at: completedAt,
        last_progress_kind: String(result?.kind || "consumer-round-completed").slice(0, 100),
        activity_count: Number(result?.attempted ?? result?.activity_count ?? 0) || 0,
      } });
    },
    reconciliationRoundStarted: () => persist({ reconciliation: {
      phase: "running",
      attempt_seq: Number(state.reconciliation.attempt_seq || 0) + 1,
      attempt_started_at: timestamp(),
      last_error: null,
    } }),
    reconciliationProgress: ({ kind = "reconciliation-activity" } = {}) => {
      const progressAt = timestamp();
      return persist({ reconciliation: {
        phase: "running",
        last_progress_at: progressAt,
        last_progress_kind: String(kind || "reconciliation-activity").slice(0, 100),
      } });
    },
    reconciliationRoundCompleted: (result = {}) => {
      const completedAt = timestamp();
      return persist({ reconciliation: {
        phase: "healthy",
        last_completed_at: completedAt,
        last_progress_at: completedAt,
        last_progress_kind: String(result?.kind || "reconciliation-round-completed").slice(0, 100),
        activity_count: Number(result?.attempted ?? result?.activity_count ?? 0) || 0,
        last_error: null,
        first_consecutive_error_at: null,
        consecutive_errors: 0,
      } });
    },
    reconciliationRoundFailed: (error) => {
      const completedAt = timestamp();
      const hasConsecutiveError = Number(state.reconciliation.consecutive_errors || 0) > 0;
      return persist({ reconciliation: {
        phase: "error",
        last_completed_at: completedAt,
        last_progress_at: completedAt,
        last_progress_kind: "reconciliation-round-failed",
        activity_count: null,
        last_error: normalizedErrorText(error),
        first_consecutive_error_at: hasConsecutiveError
          ? state.reconciliation.first_consecutive_error_at
          : completedAt,
        consecutive_errors: hasConsecutiveError
          ? Number(state.reconciliation.consecutive_errors || 0) + 1
          : 1,
      } });
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
  consumerStaleMs = staleMs,
  reconciliationStaleMs = staleMs,
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
  const consumerStale = Math.max(1, Number(consumerStaleMs) || stale);
  const reconciliationStale = Math.max(1, Number(reconciliationStaleMs) || stale);
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
  const heartbeatAtMs = finiteTimestamp(health?.producer?.heartbeat_at || health?.heartbeat_at);
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

  const laneRecovery = (laneName, lane, laneStaleMs) => {
    // Schema-v1 workers deployed before lane heartbeats remain compatible
    // during a rolling supervisor handoff. Every new worker writes both lanes
    // from process start, so their absence is not silently accepted afterward.
    if (!lane || typeof lane !== "object") {
      if (Number(health?.runtime_lane_schema_version) !== 1) return null;
      const elapsed = Math.max(0, nowMs - workerStartedAtMs);
      if (elapsed < laneStaleMs) return null;
      return {
        ...base,
        action: "restart-worker",
        reason: `direct-${laneName}-heartbeat-missing`,
        stale_ms: elapsed,
        [`${laneName}_phase`]: "missing",
        [`${laneName}_heartbeat_at`]: null,
      };
    }
    const laneHeartbeatAtMs = finiteTimestamp(lane?.heartbeat_at);
    const laneCurrent = currentIdentity
      && laneHeartbeatAtMs !== null
      && laneHeartbeatAtMs >= workerStartedAtMs;
    const elapsed = laneCurrent
      ? Math.max(0, nowMs - laneHeartbeatAtMs)
      : Math.max(0, nowMs - workerStartedAtMs);
    if (elapsed < laneStaleMs) return null;
    return {
      ...base,
      action: "restart-worker",
      reason: `direct-${laneName}-progress-stale`,
      stale_ms: elapsed,
      [`${laneName}_phase`]: lane?.phase || "missing",
      [`${laneName}_heartbeat_at`]: lane?.heartbeat_at || null,
    };
  };
  if (!recovery) recovery = laneRecovery("consumer", health?.consumer, consumerStale);
  if (!recovery) {
    recovery = laneRecovery(
      "reconciliation",
      health?.reconciliation,
      reconciliationStale,
    );
  }
  if (!recovery
    && health?.reconciliation?.phase === "error"
    && Number(health?.reconciliation?.consecutive_errors || 0) >= threshold) {
    recovery = {
      ...base,
      action: "restart-worker",
      reason: "direct-reconciliation-consecutive-errors",
      consecutive_errors: Number(health.reconciliation.consecutive_errors),
      first_error_at: health.reconciliation.first_consecutive_error_at || null,
      last_error: health.reconciliation.last_error || null,
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
