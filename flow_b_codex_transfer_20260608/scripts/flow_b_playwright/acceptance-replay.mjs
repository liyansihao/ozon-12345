export const FIXED_STORE_IDS = Object.freeze([106637, 106640, 106644, 106646, 104965]);
export const EXCLUDED_SKUS = Object.freeze(["2815247918"]);

const EXCLUDED_SKU_SET = new Set(EXCLUDED_SKUS);
const CLOSED_SKU_STATUSES = new Set(["published", "failed", "skipped", "delayed"]);
const REASON_REQUIRED_STATUSES = new Set(["submitted", "failed", "skipped", "delayed"]);
const ERP_URGENT_FLOOR_MS = 180_000;

function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedSku(value) {
  return String(value ?? "").trim();
}

function normalizedWindow(startedAt, endedAt) {
  const start = timestamp(startedAt);
  const end = timestamp(endedAt);
  if (start === null || end === null || end < start) {
    throw new TypeError("startedAt and endedAt must define a valid ordered window");
  }
  return {
    start,
    end,
    started_at: new Date(start).toISOString(),
    ended_at: new Date(end).toISOString(),
    duration_minutes: (end - start) / 60_000,
  };
}

function sortedWindowEvents(events, window) {
  return (events || [])
    .map((event, index) => ({ event, index, at: timestamp(event?.at ?? event?.timestamp) }))
    .filter(({ at }) => at !== null && at >= window.start && at <= window.end)
    .sort((left, right) => left.at - right.at || left.index - right.index);
}

function increment(record, key, count = 1) {
  if (record instanceof Map) {
    record.set(key, Number(record.get(key) || 0) + count);
    return;
  }
  record[key] = Number(record[key] || 0) + count;
}

function qualityFailures(row) {
  const failures = [];
  const sku = normalizedSku(row?.sku);
  if (!sku) failures.push("missing_sku");
  if (EXCLUDED_SKU_SET.has(sku)) failures.push("excluded_sku");
  if (row?.strict_confirmed !== true) failures.push("strict_confirmation");
  if (String(row?.online_status || "") !== "selling") failures.push("online_status");
  if (!(Number(row?.stock) > 0)) failures.push("stock");
  if (!(Number(row?.profit_rate) > 30)) failures.push("profit");
  if (String(row?.shipping_mode || "").toUpperCase() !== "FBS") failures.push("pure_fbs");
  if (row?.same_item_1688 !== true) failures.push("same_item_cost");
  if (row?.cost_reliable !== true) failures.push("cost");
  if (row?.duplicate_precheck !== true) failures.push("duplicate_precheck");
  if (row?.forbidden_category !== false) failures.push("forbidden_category");
  if (row?.title_valid !== true) failures.push("title");
  if (row?.image_valid !== true) failures.push("image");
  if (row?.category_valid !== true) failures.push("category");
  return failures;
}

function gateResult(gate, checks, details = {}) {
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);
  return {
    gate,
    passed: failedChecks.length === 0,
    checks,
    failed_checks: failedChecks,
    ...details,
  };
}

function orderedObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

export function replayAcceptanceEvents(events, { startedAt, endedAt }) {
  const window = normalizedWindow(startedAt, endedAt);
  const rows = sortedWindowEvents(events, window);
  const strictBySku = new Map();
  const strictByStore = Object.fromEntries(FIXED_STORE_IDS.map((id) => [String(id), 0]));
  const qualityViolations = {};
  const candidateBufferSamples = [];
  const finalStatusBySku = new Map();
  const deterministicTerminalAt = new Map();
  let rawStrictEvents = 0;
  let duplicateStrictEvents = 0;
  let carriedInStrictEvents = 0;
  let missingReasonTransitions = 0;
  let deterministicTerminalRetries = 0;
  let recoveredCrashes = 0;
  let unrecoveredCrashes = 0;
  let stateLossEvents = 0;
  let processSamples = 0;
  let processOwnershipViolations = 0;
  let previousWorkerGeneration = null;
  let orphanBrowserEvents = 0;
  let unexpectedProcessExits = 0;
  let erpRateLimits = 0;
  let erpBackoffViolations = 0;
  const erpBlockedUntilByStore = new Map();
  const lastErpSyncAtByStore = new Map();
  let explicitDuplicateEvents = 0;
  let securityBypassEvents = 0;

  const precedingErpRows = (events || [])
    .map((event, index) => ({ event, index, at: timestamp(event?.at ?? event?.timestamp) }))
    .filter(({ event, at }) => (
      at !== null
      && at < window.start
      && ["erp-rate-limit", "erp-sync-attempt"].includes(String(event?.type || ""))
    ))
    .sort((left, right) => left.at - right.at || left.index - right.index);
  for (const { event, at } of precedingErpRows) {
    const type = String(event.type);
    const storeKey = String(Number(event?.store_id) || "unknown");
    if (type === "erp-rate-limit") {
      const retryAfterMs = Math.max(0, Number(event?.retry_after_ms) || 0);
      const explicitBlockedUntil = timestamp(event?.blocked_until);
      erpBlockedUntilByStore.set(storeKey, Math.max(
        Number(erpBlockedUntilByStore.get(storeKey) || Number.NEGATIVE_INFINITY),
        at + Math.max(ERP_URGENT_FLOOR_MS, retryAfterMs),
        explicitBlockedUntil ?? Number.NEGATIVE_INFINITY,
      ));
    } else {
      lastErpSyncAtByStore.set(storeKey, at);
    }
  }

  for (const { event, at } of rows) {
    const type = String(event?.type || "");
    const sku = normalizedSku(event?.sku);

    if (sku && deterministicTerminalAt.has(sku) && at > deterministicTerminalAt.get(sku)) {
      if (type === "sku-attempt"
        || type === "strict-confirmed"
        || (type === "sku-transition" && String(event?.status || "") === "submitted")) {
        deterministicTerminalRetries += 1;
      }
    }

    if (type === "sku-transition") {
      const status = String(event?.status || "").trim();
      if (sku) finalStatusBySku.set(sku, status);
      if (REASON_REQUIRED_STATUSES.has(status) && !String(event?.reason || "").trim()) {
        missingReasonTransitions += 1;
      }
      if (status === "failed" && String(event?.failure_class || "") === "deterministic" && sku) {
        deterministicTerminalAt.set(sku, at);
      }
      continue;
    }

    if (type === "strict-confirmed") {
      rawStrictEvents += 1;
      const failures = qualityFailures(event);
      for (const failure of failures) increment(qualityViolations, failure);
      const submittedAt = timestamp(event?.submitted_at ?? event?.created_at ?? event?.at);
      if (submittedAt === null || submittedAt < window.start || submittedAt > window.end) {
        carriedInStrictEvents += 1;
        continue;
      }
      if (failures.length > 0) continue;
      if (strictBySku.has(sku)) {
        duplicateStrictEvents += 1;
        continue;
      }
      strictBySku.set(sku, { ...event, _confirmed_at_ms: at });
      const storeKey = String(Number(event?.store_id));
      strictByStore[storeKey] = Number(strictByStore[storeKey] || 0) + 1;
      continue;
    }

    if (type === "quality-violation") {
      increment(qualityViolations, String(event?.rule || "unspecified"));
      continue;
    }

    if (type === "duplicate-detected") {
      explicitDuplicateEvents += 1;
      continue;
    }

    if (type === "security-bypass") {
      securityBypassEvents += 1;
      continue;
    }

    if (type === "candidate-buffer") {
      candidateBufferSamples.push({
        at: new Date(at).toISOString(),
        ready_unique: Math.max(0, Number(event?.ready_unique) || 0),
        added_unique: Math.max(0, Number(event?.added_unique) || 0),
      });
      continue;
    }

    if (type === "process-snapshot") {
      processSamples += 1;
      const hasPersistedRuntimeExpectation = Object.hasOwn(event || {}, "formal_worker_started")
        || Object.hasOwn(event || {}, "worker_generation")
        || Object.hasOwn(event || {}, "recovery_pending");
      const formalWorkerStarted = event?.formal_worker_started === true
        || Number(event?.worker_generation) > 0;
      const recoveryPending = event?.recovery_pending === true;
      const workerCount = Number(event?.worker_count);
      const profileOwnerCount = Number(event?.profile_owner_count);
      const expectedWorkerCount = formalWorkerStarted ? 1 : 0;
      const expectedProfileOwnerCount = 1;
      const workerOwned = hasPersistedRuntimeExpectation
        ? (recoveryPending
          ? [0, 1].includes(workerCount)
          : workerCount === expectedWorkerCount)
        : workerCount === (
          Number.isInteger(Number(event?.expected_worker_count))
            ? Number(event.expected_worker_count)
            : 1
        );
      const profileOwned = hasPersistedRuntimeExpectation
        ? (recoveryPending
          ? [0, 1].includes(profileOwnerCount)
          : profileOwnerCount === expectedProfileOwnerCount)
        : profileOwnerCount === (
          Number.isInteger(Number(event?.expected_profile_owner_count))
            ? Number(event.expected_profile_owner_count)
            : 1
        );
      const workerGeneration = Number(event?.worker_generation);
      const generationChanged = hasPersistedRuntimeExpectation
        && Number.isInteger(workerGeneration)
        && workerGeneration > 0
        && previousWorkerGeneration !== null
        && previousWorkerGeneration > 0
        && workerGeneration !== previousWorkerGeneration;
      const ownerViolation = Number(event?.supervisor_count) !== 1
        || !workerOwned
        || !profileOwned
        || generationChanged;
      if (ownerViolation) processOwnershipViolations += 1;
      if (hasPersistedRuntimeExpectation && Number.isInteger(workerGeneration)) {
        previousWorkerGeneration = workerGeneration;
      }
      if (Number(event?.orphan_browser_count) > 0) orphanBrowserEvents += 1;
      continue;
    }

    if (type === "process-exit") {
      if (event?.planned !== true) unexpectedProcessExits += 1;
      continue;
    }

    if (type === "browser-recovery") {
      if (String(event?.outcome || "") === "recovered") recoveredCrashes += 1;
      else unrecoveredCrashes += 1;
      if (event?.state_lost === true) stateLossEvents += 1;
      continue;
    }

    if (type === "state-loss") {
      stateLossEvents += 1;
      continue;
    }

    if (type === "erp-rate-limit") {
      erpRateLimits += 1;
      const storeKey = String(Number(event?.store_id) || "unknown");
      const retryAfterMs = Math.max(0, Number(event?.retry_after_ms) || 0);
      const explicitBlockedUntil = timestamp(event?.blocked_until);
      erpBlockedUntilByStore.set(storeKey, Math.max(
        Number(erpBlockedUntilByStore.get(storeKey) || Number.NEGATIVE_INFINITY),
        at + Math.max(ERP_URGENT_FLOOR_MS, retryAfterMs),
        explicitBlockedUntil ?? Number.NEGATIVE_INFINITY,
      ));
      continue;
    }

    if (type === "erp-sync-attempt") {
      const storeKey = String(Number(event?.store_id) || "unknown");
      const blockedUntil = Number(
        erpBlockedUntilByStore.get(storeKey) || Number.NEGATIVE_INFINITY,
      );
      const lastAttemptAt = Number(
        lastErpSyncAtByStore.get(storeKey) || Number.NEGATIVE_INFINITY,
      );
      if (
        at < blockedUntil
        || (
          Number.isFinite(lastAttemptAt)
          && at - lastAttemptAt < ERP_URGENT_FLOOR_MS
        )
      ) {
        erpBackoffViolations += 1;
      }
      lastErpSyncAtByStore.set(storeKey, at);
    }
  }

  const strictRows = [...strictBySku.values()]
    .sort((left, right) => left._confirmed_at_ms - right._confirmed_at_ms);
  const targetReachedAt = strictRows.length >= 500 ? strictRows[499]._confirmed_at_ms : null;
  const effectiveHoursToTarget = targetReachedAt === null
    ? null
    : Math.max(0, targetReachedAt - window.start) / 3_600_000;
  const effectiveStrictPerHour = effectiveHoursToTarget === null
    ? 0
    : effectiveHoursToTarget === 0
      ? Number.POSITIVE_INFINITY
      : 500 / effectiveHoursToTarget;
  const totalQualityViolations = Object.values(qualityViolations)
    .reduce((sum, count) => sum + Number(count || 0), 0);

  return {
    window_started_at: window.started_at,
    window_ended_at: window.ended_at,
    duration_minutes: window.duration_minutes,
    raw_strict_events: rawStrictEvents,
    unique_strict_count: strictRows.length,
    unique_strict_skus: strictRows.map((row) => normalizedSku(row.sku)),
    duplicate_strict_events: duplicateStrictEvents,
    explicit_duplicate_events: explicitDuplicateEvents,
    carried_in_strict_events: carriedInStrictEvents,
    strict_by_store: strictByStore,
    target_reached_at: targetReachedAt === null ? null : new Date(targetReachedAt).toISOString(),
    effective_strict_per_hour: Math.round(effectiveStrictPerHour * 1_000) / 1_000,
    quality_violations: totalQualityViolations,
    quality_violations_by_rule: orderedObject(Object.entries(qualityViolations)),
    cost_violations: Number(qualityViolations.cost || 0) + Number(qualityViolations.same_item_cost || 0),
    profit_violations: Number(qualityViolations.profit || 0),
    candidate_buffer_samples: candidateBufferSamples,
    missing_reason_transitions: missingReasonTransitions,
    deterministic_terminal_retries: deterministicTerminalRetries,
    final_status_by_sku: orderedObject(finalStatusBySku.entries()),
    process_samples: processSamples,
    process_ownership_violations: processOwnershipViolations,
    orphan_browser_events: orphanBrowserEvents,
    unexpected_process_exits: unexpectedProcessExits,
    recovered_crashes: recoveredCrashes,
    unrecovered_crashes: unrecoveredCrashes,
    state_loss_events: stateLossEvents,
    erp_rate_limits: erpRateLimits,
    erp_backoff_violations: erpBackoffViolations,
    security_bypass_events: securityBypassEvents,
  };
}

export function evaluateThreeSkuGate({ events, targetSkus }) {
  const targets = [...new Set((targetSkus || []).map(normalizedSku).filter(Boolean))];
  const targetSet = new Set(targets);
  const finalStatus = new Map();
  const finalClosed = new Map();
  const submitCounts = new Map();
  const deterministicTerminalAt = new Map();
  let missingReasons = 0;
  let deterministicTerminalRetries = 0;

  const rows = (events || [])
    .map((event, index) => ({ event, index, at: timestamp(event?.at ?? event?.timestamp) }))
    .filter(({ at, event }) => at !== null && targetSet.has(normalizedSku(event?.sku)))
    .sort((left, right) => left.at - right.at || left.index - right.index);

  for (const { event, at } of rows) {
    const sku = normalizedSku(event?.sku);
    const type = String(event?.type || "");
    if (deterministicTerminalAt.has(sku) && at > deterministicTerminalAt.get(sku)) {
      if (type === "sku-attempt"
        || type === "strict-confirmed"
        || (type === "sku-transition" && String(event?.status || "") === "submitted")) {
        deterministicTerminalRetries += 1;
      }
    }
    if (type !== "sku-transition") continue;
    const status = String(event?.status || "").trim();
    finalStatus.set(sku, status);
    finalClosed.set(sku, (
      event?.terminal === true
      || status === "published"
      || status === "skipped"
      || (status === "failed" && String(event?.failure_class || "") !== "transient")
    ));
    if (status === "submitted") increment(submitCounts, sku);
    if (REASON_REQUIRED_STATUSES.has(status) && !String(event?.reason || "").trim()) {
      missingReasons += 1;
    }
    if (status === "failed" && String(event?.failure_class || "") === "deterministic") {
      deterministicTerminalAt.set(sku, at);
    }
  }

  const unclosed = targets.filter((sku) => (
    !CLOSED_SKU_STATUSES.has(finalStatus.get(sku))
    || finalClosed.get(sku) !== true
  ));
  const duplicateSubmissions = [...submitCounts.values()]
    .reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const checks = {
    exactly_three_target_skus: targets.length === 3,
    all_statuses_closed: unclosed.length === 0,
    zero_duplicate_submissions: duplicateSubmissions === 0,
    zero_missing_reasons: missingReasons === 0,
    no_deterministic_terminal_retries: deterministicTerminalRetries === 0,
  };
  return gateResult("3-sku", checks, {
    target_skus: targets,
    final_status_by_sku: orderedObject(finalStatus.entries()),
    unclosed_skus: unclosed,
    duplicate_submissions: duplicateSubmissions,
    missing_reasons: missingReasons,
    deterministic_terminal_retries: deterministicTerminalRetries,
  });
}

export function evaluateThirtyMinuteGate({
  events,
  startedAt,
  endedAt,
  minimumCandidateBuffer = 70,
}) {
  const replay = replayAcceptanceEvents(events, { startedAt, endedAt });
  const samples = replay.candidate_buffer_samples;
  const minimumObserved = samples.length
    ? Math.min(...samples.map((sample) => sample.ready_unique))
    : 0;
  const replenished = samples.slice(1).some((sample) => sample.added_unique > 0);
  const checks = {
    full_thirty_minute_window: replay.duration_minutes >= 30,
    process_ownership_observed: replay.process_samples >= 2,
    zero_orphan_processes: replay.process_ownership_violations === 0
      && replay.orphan_browser_events === 0
      && replay.unexpected_process_exits === 0,
    zero_quality_violations: replay.quality_violations === 0
      && replay.security_bypass_events === 0,
    zero_duplicates: replay.duplicate_strict_events === 0
      && replay.explicit_duplicate_events === 0,
    no_deterministic_terminal_retries: replay.deterministic_terminal_retries === 0,
    candidate_buffer_sustained: samples.length >= 2
      && minimumObserved >= Number(minimumCandidateBuffer),
    candidate_buffer_replenished: replenished,
    erp_backoff_obeyed: replay.erp_backoff_violations === 0,
  };
  return gateResult("30-minute", checks, {
    minimum_candidate_buffer: minimumObserved,
    candidate_buffer_samples: samples.length,
    ...replay,
  });
}

export function evaluateTwoHourGate({ events, startedAt, endedAt }) {
  const replay = replayAcceptanceEvents(events, { startedAt, endedAt });
  const checks = {
    full_two_hour_window: replay.duration_minutes >= 120,
    at_least_seventy_current_window_strict: replay.unique_strict_count >= 70,
    zero_duplicates: replay.duplicate_strict_events === 0
      && replay.explicit_duplicate_events === 0,
    no_deterministic_terminal_retries: replay.deterministic_terminal_retries === 0,
    zero_quality_violations: replay.quality_violations === 0
      && replay.security_bypass_events === 0,
    process_ownership_observed: replay.process_samples >= 2,
    supervisor_and_worker_stayed_owned: replay.process_ownership_violations === 0
      && replay.orphan_browser_events === 0
      && replay.unexpected_process_exits === 0,
    at_most_one_recovered_crash: replay.recovered_crashes <= 1,
    zero_unrecovered_crashes: replay.unrecovered_crashes === 0,
    zero_state_loss: replay.state_loss_events === 0,
    erp_backoff_obeyed: replay.erp_backoff_violations === 0,
  };
  return gateResult("2-hour", checks, {
    unique_current_window_strict: replay.unique_strict_count,
    ...replay,
  });
}

export function evaluateTwentyFourHourGate({ events, startedAt, endedAt }) {
  const replay = replayAcceptanceEvents(events, { startedAt, endedAt });
  const expectedByStore = Object.fromEntries(FIXED_STORE_IDS.map((id) => [String(id), 100]));
  const exactStoreSplit = FIXED_STORE_IDS.every((id) => replay.strict_by_store[String(id)] === 100)
    && Object.entries(replay.strict_by_store)
      .filter(([storeId]) => !FIXED_STORE_IDS.includes(Number(storeId)))
      .every(([, count]) => Number(count) === 0);
  const checks = {
    full_twenty_four_hour_window: replay.duration_minutes >= 1_440,
    fixed_target_exactly_five_hundred: replay.unique_strict_count === 500,
    five_stores_exactly_one_hundred_each: exactStoreSplit,
    effective_rate_at_least_thirty_five: replay.effective_strict_per_hour >= 35,
    zero_unrecovered_crashes: replay.unrecovered_crashes === 0,
    zero_orphan_processes: replay.process_ownership_violations === 0
      && replay.orphan_browser_events === 0
      && replay.unexpected_process_exits === 0,
    process_ownership_observed: replay.process_samples >= 2,
    zero_duplicates: replay.duplicate_strict_events === 0
      && replay.explicit_duplicate_events === 0,
    no_deterministic_terminal_retries: replay.deterministic_terminal_retries === 0,
    zero_cost_violations: replay.cost_violations === 0,
    zero_profit_violations: replay.profit_violations === 0,
    zero_quality_violations: replay.quality_violations === 0
      && replay.security_bypass_events === 0,
    zero_state_loss: replay.state_loss_events === 0,
    erp_backoff_obeyed: replay.erp_backoff_violations === 0,
  };
  return gateResult("24-hour", checks, {
    fixed_target: 500,
    per_store_target: 100,
    expected_strict_by_store: expectedByStore,
    unique_current_window_strict: replay.unique_strict_count,
    ...replay,
  });
}
