#!/usr/bin/env python3
"""Replay adaptive 1688 decisions from historical ``*.out`` evidence.

The input files can be large, so each file and optional JSONL source is read a
line at a time.  Only compact counters, bounded samples, and SKU matches are
kept in memory.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import math
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Callable, Iterable


EVIDENCE_LABEL = "SAME_ITEM_EVIDENCE"
DECISIONS = ("FAST", "REVIEW", "REJECT")
ACTIONS = ("ALLOW", "REJECT")
HUMAN_VERDICTS = ("true_reject", "false_reject")
DEFAULT_ACTION_SAMPLE_SIZE = 100
DEFAULT_MAX_FALSE_REJECT_RATE = 0.05
DEFAULT_MINIMUM_LIVE_PRODUCTS_PER_HOUR = 20.0
ADAPTIVE_ACTION_VERSION = "adaptive-v5-shadow"
ADAPTIVE_ACTION_POLICY_VERSION = "adaptive-v5-policy-1"
VALUABLE_DIGITAL_THRESHOLD_CNY = 300
DECISION_ALIASES = {
    "ACCEPT": "FAST",
    "LIGHT_ACCEPT": "FAST",
    "PASS": "FAST",
    "MANUAL_REVIEW": "REVIEW",
    "BLOCK": "REJECT",
}


class ReplayError(RuntimeError):
    """Raised when replay cannot start or an input source is unusable."""


def load_adaptive_decider(
    module_path: Path | str | None = None,
) -> Callable[[dict[str, Any]], dict[str, Any]]:
    """Dynamically load ``adaptive_decision_from_evidence`` from the matcher."""
    filename = Path(module_path) if module_path is not None else Path(__file__).with_name("1688_image_median.py")
    filename = filename.expanduser().resolve()
    if not filename.is_file():
        raise ReplayError(f"1688 matcher module not found: {filename}")

    spec = importlib.util.spec_from_file_location("_replay_1688_image_median", filename)
    if spec is None or spec.loader is None:
        raise ReplayError(f"could not import 1688 matcher module: {filename}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        raise ReplayError(f"failed to import 1688 matcher module {filename}: {exc}") from exc

    decider = getattr(module, "adaptive_decision_from_evidence", None)
    if not callable(decider):
        raise ReplayError(
            "1688 matcher is missing adaptive_decision_from_evidence(evidence): "
            f"{filename}"
        )
    return decider


def extract_same_item_evidence(filename: Path | str) -> tuple[dict[str, Any] | None, str | None]:
    """Return the first evidence object in an output file and an error code."""
    path = Path(filename)
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for raw_line in handle:
                line = raw_line.lstrip("\ufeff")
                if not line.startswith(EVIDENCE_LABEL):
                    continue
                encoded = line[len(EVIDENCE_LABEL):].strip()
                if not encoded:
                    return None, "empty_evidence"
                try:
                    evidence = json.loads(encoded)
                except (TypeError, json.JSONDecodeError):
                    return None, "invalid_json"
                if not isinstance(evidence, dict):
                    return None, "evidence_not_object"
                return evidence, None
    except OSError:
        return None, "read_error"
    return None, "missing_evidence_line"


def _items(value: Any) -> list[str]:
    if value is None or value is False:
        return []
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if isinstance(value, dict):
        values: Iterable[Any] = (key for key, enabled in value.items() if enabled)
    elif isinstance(value, (list, tuple, set, frozenset)):
        values = value
    else:
        values = [value]

    result: list[str] = []
    for item in values:
        if isinstance(item, str):
            text = item.strip()
        else:
            try:
                text = json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            except (TypeError, ValueError):
                text = str(item).strip()
        if text:
            result.append(text)
    return result


def _binary_action_contract(
    result: dict[str, Any],
) -> tuple[str | None, list[str], bool]:
    """Return an action only when the exact adaptive-v5 contract is complete."""
    raw_action = result.get("action")
    action = raw_action if isinstance(raw_action, str) and raw_action in ACTIONS else None
    reasons: list[str] = []
    if raw_action is None:
        reasons.append("missing_action")
    elif action is None:
        reasons.append("invalid_action")
    if result.get("evidence_complete") is not True:
        reasons.append("evidence_incomplete")
    if result.get("version") != ADAPTIVE_ACTION_VERSION:
        reasons.append("unsupported_action_version")
    if result.get("policy_version") != ADAPTIVE_ACTION_POLICY_VERSION:
        reasons.append("invalid_policy_version")

    policy_reasons = result.get("policy_reasons")
    if not (
        isinstance(policy_reasons, list)
        and all(isinstance(item, str) for item in policy_reasons)
    ):
        reasons.append("invalid_policy_reasons")

    valuable = result.get("valuable_digital")
    required_valuable_fields = {
        "applies",
        "category",
        "price_cny",
        "threshold_cny",
    }
    valuable_price = valuable.get("price_cny") if isinstance(valuable, dict) else None
    valuable_applies = valuable.get("applies") if isinstance(valuable, dict) else None
    valuable_category = valuable.get("category") if isinstance(valuable, dict) else None
    valid_valuable_price = bool(
        isinstance(valuable_price, (int, float))
        and not isinstance(valuable_price, bool)
        and math.isfinite(valuable_price)
        and valuable_price > 0
    )
    valid_valuable = bool(
        isinstance(valuable, dict)
        and required_valuable_fields.issubset(valuable)
        and isinstance(valuable_applies, bool)
        and (isinstance(valuable_category, str) or valuable_category is None)
        and valid_valuable_price
        and (
            valuable_applies is not True
            or (isinstance(valuable_category, str) and bool(valuable_category.strip()))
        )
        and valuable.get("threshold_cny") == VALUABLE_DIGITAL_THRESHOLD_CNY
    )
    if not valid_valuable:
        reasons.append("invalid_valuable_digital")
    return action, reasons, not reasons


def _normalized_result(raw_result: Any) -> dict[str, Any]:
    """Validate the current decider contract while tolerating simple legacy forms."""
    if isinstance(raw_result, str):
        result: dict[str, Any] = {"decision": raw_result}
    elif isinstance(raw_result, dict):
        result = raw_result
    else:
        raise ValueError("adaptive decision must return a dict")

    decision = str(result.get("decision") or result.get("tier") or "").strip().upper()
    decision = DECISION_ALIASES.get(decision, decision)
    if decision not in DECISIONS:
        raise ValueError(f"unknown adaptive decision: {decision or '<missing>'}")

    reason_value = result.get("reason")
    if not reason_value and result.get("reasons"):
        reason_value = "; ".join(_items(result.get("reasons")))
    reason = str(reason_value or "unspecified").strip() or "unspecified"
    action, unassessable_reasons, action_assessable = _binary_action_contract(result)
    evidence_complete = result.get("evidence_complete") is True
    return {
        **result,
        "decision": decision,
        "reason": reason,
        "hard_conflicts": _items(result.get("hard_conflicts")),
        "missing_evidence": _items(result.get("missing_evidence")),
        "action": action,
        "policy_reasons": _items(result.get("policy_reasons")),
        "evidence_complete": evidence_complete,
        "action_assessable": action_assessable,
        "action_unassessable_reasons": unassessable_reasons,
        "legacy_action_missing": result.get("version") != ADAPTIVE_ACTION_VERSION,
    }


def _counter_dict(counter: Counter[str]) -> dict[str, int]:
    return {key: counter[key] for key in sorted(counter, key=lambda item: (-counter[item], item))}


def _sample(
    *,
    sku: str,
    evidence: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any]:
    request = evidence.get("request") if isinstance(evidence.get("request"), dict) else {}
    selected_offer = result.get("selected_offer_id") or evidence.get("selected_offer_id")
    return {
        "sku": sku,
        "expected_title": str(request.get("expect_title") or "").strip(),
        "selected_offer": str(selected_offer or "").strip(),
        "cost": evidence.get("selected_cost"),
        "reason": result["reason"],
    }


def _positive_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool) or str(value).strip() == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def _event_payload(row: dict[str, Any]) -> dict[str, Any]:
    data = row.get("data") if isinstance(row.get("data"), dict) else {}
    return {**row, **data}


def _row_price_cny(row: dict[str, Any]) -> float | None:
    payload = _event_payload(row)
    for field in ("sell_price", "sale_price"):
        price = _positive_number(payload.get(field))
        if price is not None:
            return price
    return None


def load_historical_price_index(
    sources: Iterable[Path | str],
) -> tuple[dict[str, float], dict[str, Any]]:
    """Load the latest positive historical sale price per SKU from JSONL."""
    prices: dict[str, float] = {}
    source_rows: dict[str, int] = {}
    invalid_rows: dict[str, int] = {}
    priced_rows: dict[str, int] = {}
    resolved_sources: list[str] = []
    for source in sources:
        filename = Path(source).expanduser().resolve()
        if not filename.is_file():
            raise ReplayError(f"historical price JSONL not found: {filename}")
        source_name = str(filename)
        resolved_sources.append(source_name)
        rows = 0
        invalid = 0
        with filename.open("r", encoding="utf-8", errors="replace") as handle:
            for raw_line in handle:
                if not raw_line.strip():
                    continue
                try:
                    row = json.loads(raw_line)
                except json.JSONDecodeError:
                    invalid += 1
                    continue
                if not isinstance(row, dict):
                    invalid += 1
                    continue
                rows += 1
                sku = _row_sku(row)
                price = _row_price_cny(row)
                if sku and price is not None:
                    prices[sku] = price
                    priced_rows[source_name] = priced_rows.get(source_name, 0) + 1
        source_rows[source_name] = rows
        invalid_rows[source_name] = invalid
    return prices, {
        "provenance": "joined_historical_price",
        "request_field": "expect_price_cny",
        "sources": resolved_sources,
        "source_rows": source_rows,
        "source_invalid_rows": invalid_rows,
        "source_priced_rows": priced_rows,
        "indexed_skus": len(prices),
    }


def load_jsonl_skus(source: Path | str) -> set[str]:
    filename = Path(source).expanduser().resolve()
    if not filename.is_file():
        raise ReplayError(f"selected cohort JSONL not found: {filename}")
    skus: set[str] = set()
    with filename.open("r", encoding="utf-8", errors="replace") as handle:
        for raw_line in handle:
            if not raw_line.strip():
                continue
            try:
                row = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict):
                sku = _row_sku(row)
                if sku:
                    skus.add(sku)
    return skus


def _inject_historical_price(
    evidence: dict[str, Any],
    sku: str,
    price_index: dict[str, float],
) -> tuple[dict[str, Any], str]:
    request = evidence.get("request") if isinstance(evidence.get("request"), dict) else {}
    if _positive_number(request.get("expect_price_cny")) is not None:
        return evidence, "embedded"
    joined_price = price_index.get(sku)
    if joined_price is None:
        return evidence, "missing"
    joined_request = {
        **request,
        "expect_price_cny": joined_price,
        "expect_price_source": "joined_historical_price",
    }
    return {**evidence, "request": joined_request}, "joined"


def _selected_offer_row(evidence: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    selected_id = str(result.get("selected_offer_id") or evidence.get("selected_offer_id") or "").strip()
    rows = evidence.get("rows") if isinstance(evidence.get("rows"), list) else []
    return next(
        (
            row for row in rows
            if isinstance(row, dict)
            and str(row.get("offer_id") or row.get("offerId") or "").strip() == selected_id
        ),
        {},
    )


def _conflict_dimension(conflicts: list[str], prefixes: tuple[str, ...]) -> list[str]:
    return [
        conflict for conflict in conflicts
        if any(conflict.startswith(f"{prefix}:") for prefix in prefixes)
    ]


def _reject_audit_row(
    *,
    sku: str,
    evidence: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any]:
    request = evidence.get("request") if isinstance(evidence.get("request"), dict) else {}
    selected_id = str(result.get("selected_offer_id") or evidence.get("selected_offer_id") or "").strip()
    selected = _selected_offer_row(evidence, result)
    conflicts = list(result["hard_conflicts"])
    policy_reasons = list(result["policy_reasons"] or conflicts or [result["reason"]])
    offer_url = str(selected.get("offer_url") or "").strip()
    if not offer_url and selected_id:
        offer_url = f"https://detail.1688.com/offer/{selected_id}.html"
    supplier = str(selected.get("supplier_id") or selected.get("supplier") or "").strip()
    expected_title = str(request.get("expect_title") or "").strip()
    selected_offer = {
        "id": selected_id,
        "url": offer_url,
        "title": str(selected.get("title") or "").strip(),
        "supplier": supplier,
        "cost": evidence.get("selected_cost"),
    }
    return {
        "sku": sku,
        "title": expected_title,
        "expected_title": expected_title,
        "selected_offer": selected_offer,
        "selected_offer_id": selected_offer["id"],
        "selected_offer_url": selected_offer["url"],
        "selected_offer_title": selected_offer["title"],
        "selected_offer_supplier": selected_offer["supplier"],
        "selected_offer_cost": selected_offer["cost"],
        "source": offer_url,
        "brand": {
            **(
                result.get("brand_evidence")
                if isinstance(result.get("brand_evidence"), dict)
                else {}
            ),
            "conflicts": _conflict_dimension(conflicts, ("brand",)),
        },
        "product": {
            "expected_roles": _items(result.get("expected_product_roles")),
            "selected_roles": _items(result.get("selected_product_roles")),
            "conflicts": _conflict_dimension(conflicts, ("product", "product_accessory")),
        },
        "model": {
            "expected": _items(result.get("expected_models")),
            "conflicts": _conflict_dimension(conflicts, ("model",)),
        },
        "action": "REJECT",
        "policy_reasons": policy_reasons,
        "reasons": policy_reasons,
        "human_verdict": "",
        "review_note": "",
    }


def load_reject_labels(source: Path | str | None) -> dict[str, dict[str, str]]:
    """Load human reject verdicts from JSONL, CSV, or TSV."""
    if source is None:
        return {}
    filename = Path(source).expanduser().resolve()
    if not filename.is_file():
        raise ReplayError(f"reject labels file not found: {filename}")
    rows: list[dict[str, Any]] = []
    if filename.suffix.lower() == ".jsonl":
        with filename.open("r", encoding="utf-8", errors="replace") as handle:
            for line_number, raw_line in enumerate(handle, start=1):
                if not raw_line.strip():
                    continue
                try:
                    row = json.loads(raw_line)
                except json.JSONDecodeError as exc:
                    raise ReplayError(
                        f"invalid reject label JSONL at {filename}:{line_number}: {exc.msg}"
                    ) from exc
                if not isinstance(row, dict):
                    raise ReplayError(
                        f"reject label must be an object at {filename}:{line_number}"
                    )
                rows.append(row)
    else:
        delimiter = "\t" if filename.suffix.lower() == ".tsv" else ","
        with filename.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
            rows.extend(dict(row) for row in csv.DictReader(handle, delimiter=delimiter))

    labels: dict[str, dict[str, str]] = {}
    for row in rows:
        sku = _row_sku(row)
        verdict = str(row.get("human_verdict") or row.get("verdict") or "").strip().lower()
        if not sku or not verdict:
            continue
        if verdict not in HUMAN_VERDICTS:
            raise ReplayError(
                f"invalid human_verdict for SKU {sku}: {verdict}; "
                f"expected {'|'.join(HUMAN_VERDICTS)}"
            )
        label = {
            "human_verdict": verdict,
            "review_note": str(row.get("review_note") or "").strip(),
        }
        if sku in labels and labels[sku] != label:
            raise ReplayError(f"conflicting reject labels for SKU {sku}")
        labels[sku] = label
    return labels


def load_live_summary(source: Path | str | dict[str, Any] | None) -> dict[str, Any] | None:
    if source is None:
        return None
    if isinstance(source, dict):
        return source
    filename = Path(source).expanduser().resolve()
    if not filename.is_file():
        raise ReplayError(f"live prewarm summary not found: {filename}")
    try:
        summary = json.loads(filename.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReplayError(f"cannot read live prewarm summary {filename}: {exc}") from exc
    if not isinstance(summary, dict):
        raise ReplayError(f"live prewarm summary must be an object: {filename}")
    return summary


def live_health_gate(
    summary: dict[str, Any] | None,
    *,
    minimum_products_per_hour: float = DEFAULT_MINIMUM_LIVE_PRODUCTS_PER_HOUR,
) -> dict[str, Any]:
    if not math.isfinite(minimum_products_per_hour) or minimum_products_per_hour < 0:
        raise ReplayError("minimum live products per hour must be finite and zero or greater")
    def count(name: str) -> int | None:
        if summary is None:
            return None
        try:
            raw_value = summary.get(name)
            if raw_value is None or isinstance(raw_value, bool):
                return None
            value = float(raw_value)
        except (TypeError, ValueError):
            return None
        return int(value) if math.isfinite(value) and value >= 0 and value.is_integer() else None

    acceptance = (
        summary.get("acceptance")
        if summary is not None and isinstance(summary.get("acceptance"), dict)
        else {}
    )
    measured = _positive_number(summary.get("actual_live_attempts_per_hour")) if summary else None
    candidates = count("candidates")
    completed = count("completed")
    actual_attempts = count("actual_live_attempt_count")
    unattempted = count("unattempted_count")
    cache_hits = count("cache_hits")
    cache_misses = count("cache_misses")
    errors = count("errors")
    process_errors = count("process_error_count")
    deferred = count("deferred_count")
    circuit = count("health_circuit_backoff_count")
    checks = {
        "summary_provided": summary is not None,
        "acceptance_passed": acceptance.get("passed") is True,
        "minimum_actual_live_attempts_per_hour": (
            measured is not None
            and measured >= minimum_products_per_hour
            and acceptance.get("speed_passed") is True
        ),
        "completed_all_candidates": (
            acceptance.get("completed_all_candidates") is True
            and candidates is not None
            and candidates > 0
            and completed == candidates
        ),
        "attempted_all_candidates": (
            acceptance.get("attempted_all_candidates") is True
            and candidates is not None
            and candidates > 0
            and actual_attempts == candidates
            and unattempted == 0
        ),
        "cold_cache": (
            acceptance.get("cold_cache") is True
            and candidates is not None
            and candidates > 0
            and cache_hits == 0
            and cache_misses == candidates
        ),
        "errors_zero": (
            acceptance.get("error_free") is True
            and errors == 0
            and process_errors == 0
        ),
        "deferred_zero": (
            acceptance.get("no_deferred_results") is True
            and deferred == 0
        ),
        "health_circuit_backoff_zero": (
            acceptance.get("no_health_circuit_backoff") is True
            and circuit == 0
        ),
    }
    return {
        "metric": "actual_live_recognition_attempts_per_hour",
        "minimum_products_per_hour": float(minimum_products_per_hour),
        "measured_products_per_hour": measured,
        "candidates": candidates,
        "completed": completed,
        "actual_live_attempt_count": actual_attempts,
        "unattempted_count": unattempted,
        "cache_hits": cache_hits,
        "cache_misses": cache_misses,
        "errors": errors,
        "process_error_count": process_errors,
        "deferred_count": deferred,
        "health_circuit_backoff_count": circuit,
        "checks": checks,
        "passed": all(checks.values()),
    }


def _selected_cohort_fingerprint(skus: set[str] | None) -> tuple[int | None, str | None]:
    """Mirror the prewarm candidate SKU count and SHA-256 algorithm."""
    if skus is None:
        return None, None
    normalized = {
        str(sku).strip()
        for sku in skus
        if str(sku).strip()
    }
    # JavaScript's default Array.sort compares UTF-16 code units.
    ordered = sorted(
        normalized,
        key=lambda value: value.encode("utf-16-be", errors="surrogatepass"),
    )
    payload = "\n".join(ordered) + ("\n" if ordered else "")
    # Node's UTF-8 encoder replaces any isolated UTF-16 surrogate with U+FFFD.
    well_formed_payload = (
        payload.encode("utf-16-le", errors="surrogatepass")
        .decode("utf-16-le", errors="replace")
    )
    digest = hashlib.sha256(well_formed_payload.encode("utf-8")).hexdigest()
    return len(ordered), digest


def live_action_evidence_gate(
    summary: dict[str, Any] | None,
    *,
    action_sample_size: int,
    selected_cohort_skus: set[str] | None,
) -> dict[str, Any]:
    """Validate a same-cohort, new-style live shadow binary-action sample."""
    if action_sample_size <= 0:
        raise ReplayError("action sample size must be greater than zero")

    def count(container: dict[str, Any], name: str) -> int | None:
        raw_value = container.get(name)
        if (
            not isinstance(raw_value, int)
            or isinstance(raw_value, bool)
            or raw_value < 0
        ):
            return None
        return raw_value

    report = summary if isinstance(summary, dict) else {}
    observation = (
        report.get("binary_action_observation")
        if isinstance(report.get("binary_action_observation"), dict)
        else {}
    )
    selected_count, selected_digest = _selected_cohort_fingerprint(selected_cohort_skus)
    candidates = count(report, "candidates")
    completed = count(report, "completed")
    actual_attempts = count(report, "actual_live_attempt_count")
    unattempted = count(report, "unattempted_count")
    reported_candidate_sku_count = count(report, "candidate_sku_count")
    reported_candidate_digest = report.get("candidate_skus_sha256")
    top_action_count = count(report, "adaptive_action_count")
    top_allow_count = count(report, "adaptive_allow_count")
    top_reject_count = count(report, "adaptive_reject_action_count")
    top_unassessable_count = count(report, "adaptive_action_unassessable_count")
    observed_action_count = count(observation, "action_count")
    observed_allow_count = count(observation, "allow_count")
    observed_reject_count = count(observation, "reject_count")
    observed_unassessable_count = count(observation, "unassessable_count")

    checks = {
        "summary_provided": summary is not None,
        "live_prewarm_scope": report.get("scope") == "live-1688-prewarm",
        "selected_cohort_provided": selected_cohort_skus is not None,
        "selected_cohort_nonempty": selected_count is not None and selected_count > 0,
        "candidate_sku_count_matches_selected_cohort": (
            selected_count is not None
            and reported_candidate_sku_count == selected_count
            and candidates == selected_count
        ),
        "candidate_sku_digest_matches_selected_cohort": (
            selected_digest is not None
            and isinstance(reported_candidate_digest, str)
            and reported_candidate_digest == selected_digest
        ),
        "candidate_count_at_least_action_target": (
            candidates is not None and candidates >= action_sample_size
        ),
        "completed_all_candidates": (
            candidates is not None
            and candidates > 0
            and completed == candidates
        ),
        "attempted_all_candidates": (
            candidates is not None
            and candidates > 0
            and actual_attempts == candidates
            and unattempted == 0
        ),
        "shadow_policy_declared": (
            report.get("adaptive_action_policy") == "shadow"
            and observation.get("adaptive_action_policy") == "shadow"
            and observation.get("quality_mode") == "shadow-not-enforced"
            and observation.get("enforced") is False
            and observation.get("automatic_enforcement") is False
            and observation.get("manual_approval_required") is True
        ),
        "v5_complete_action_contract_declared": (
            observation.get("matcher_version_required") == ADAPTIVE_ACTION_VERSION
            and observation.get("policy_version_required") == ADAPTIVE_ACTION_POLICY_VERSION
            and observation.get("evidence_complete_required") is True
        ),
        "top_level_action_counts_match_observation": (
            top_action_count is not None
            and top_allow_count is not None
            and top_reject_count is not None
            and top_unassessable_count is not None
            and top_action_count == observed_action_count
            and top_allow_count == observed_allow_count
            and top_reject_count == observed_reject_count
            and top_unassessable_count == observed_unassessable_count
        ),
        "allow_plus_reject_equals_action_count": (
            observed_action_count is not None
            and observed_allow_count is not None
            and observed_reject_count is not None
            and observed_allow_count + observed_reject_count == observed_action_count
            and top_allow_count + top_reject_count == top_action_count
        ) if all(
            value is not None
            for value in (
                top_action_count,
                top_allow_count,
                top_reject_count,
                observed_action_count,
                observed_allow_count,
                observed_reject_count,
            )
        ) else False,
        "complete_live_action_sample_collected": (
            observed_action_count is not None
            and observed_action_count >= action_sample_size
        ),
        "all_live_candidates_action_accounted": (
            candidates is not None
            and top_action_count is not None
            and top_unassessable_count is not None
            and observed_action_count is not None
            and observed_unassessable_count is not None
            and top_action_count + top_unassessable_count == candidates
            and observed_action_count + observed_unassessable_count == candidates
        ),
    }
    return {
        "scope": "same-cohort-live-shadow-binary-actions",
        "action_sample_target": action_sample_size,
        "selected_cohort_sku_count": selected_count,
        "selected_cohort_skus_sha256": selected_digest,
        "reported_candidate_sku_count": reported_candidate_sku_count,
        "reported_candidate_skus_sha256": reported_candidate_digest
        if isinstance(reported_candidate_digest, str) else None,
        "candidates": candidates,
        "completed": completed,
        "actual_live_attempt_count": actual_attempts,
        "action_count": observed_action_count,
        "allow_count": observed_allow_count,
        "reject_count": observed_reject_count,
        "unassessable_count": observed_unassessable_count,
        "checks": checks,
        "passed": all(checks.values()),
        "historical_replay_alone_satisfies_gate": False,
        "note": (
            "Historical replay cannot satisfy this gate. It requires a new live shadow "
            "prewarm summary whose candidate SKU count and SHA-256 digest match the current "
            "selected cohort."
        ),
    }


def _out_files(input_dir: Path) -> Iterable[Path]:
    try:
        with os.scandir(input_dir) as entries:
            paths = [
                Path(entry.path)
                for entry in entries
                if entry.is_file(follow_symlinks=False) and entry.name.endswith(".out")
            ]
    except OSError as exc:
        raise ReplayError(f"cannot scan input directory {input_dir}: {exc}") from exc
    yield from sorted(paths, key=lambda path: path.name)


def _row_sku(row: dict[str, Any]) -> str:
    data = row.get("data") if isinstance(row.get("data"), dict) else {}
    for value in (
        row.get("sku"),
        data.get("sku"),
        row.get("source_sku"),
        data.get("source_sku"),
    ):
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _scan_jsonl_matches(
    filename: Path,
    decisions_by_sku: dict[str, str],
) -> tuple[int, int, set[str], dict[str, int]]:
    rows = 0
    invalid = 0
    matched: set[str] = set()
    try:
        with filename.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    invalid += 1
                    continue
                if not isinstance(row, dict):
                    invalid += 1
                    continue
                rows += 1
                sku = _row_sku(row)
                if sku in decisions_by_sku:
                    matched.add(sku)
    except OSError as exc:
        raise ReplayError(f"cannot read JSONL source {filename}: {exc}") from exc
    by_decision = Counter(decisions_by_sku[sku] for sku in matched)
    return rows, invalid, matched, {decision: by_decision[decision] for decision in DECISIONS}


def selected_crosscheck(
    selected_jsonl: Path | str,
    decisions_by_sku: dict[str, str],
) -> dict[str, Any]:
    """Match replayed SKUs against selected JSONL and a sibling published file."""
    selected_path = Path(selected_jsonl).expanduser().resolve()
    if not selected_path.is_file():
        raise ReplayError(f"selected JSONL not found: {selected_path}")

    selected_rows, selected_invalid, matched_selected, selected_by_decision = _scan_jsonl_matches(
        selected_path, decisions_by_sku
    )
    published_path = selected_path.with_name("published.jsonl")
    if published_path == selected_path or not published_path.is_file():
        published_rows = 0
        published_invalid = 0
        matched_published: set[str] = set()
        published_by_decision = {decision: 0 for decision in DECISIONS}
        published_source: str | None = None
    else:
        published_rows, published_invalid, matched_published, published_by_decision = _scan_jsonl_matches(
            published_path, decisions_by_sku
        )
        published_source = str(published_path)

    replayed = len(decisions_by_sku)
    denominator = replayed or 1
    return {
        "source": str(selected_path),
        "published_source": published_source,
        "selected_rows": selected_rows,
        "selected_invalid": selected_invalid,
        "published_rows": published_rows,
        "published_invalid": published_invalid,
        "matched_selected": len(matched_selected),
        "matched_published": len(matched_published),
        "matched_selected_percent": round(len(matched_selected) * 100 / denominator, 2) if replayed else 0.0,
        "matched_published_percent": round(len(matched_published) * 100 / denominator, 2) if replayed else 0.0,
        "by_decision": {
            decision: {
                "selected": selected_by_decision[decision],
                "published": published_by_decision[decision],
            }
            for decision in DECISIONS
        },
    }


def replay_directory(
    input_dir: Path | str,
    decider: Callable[[dict[str, Any]], Any],
    *,
    sample_limit: int = 5,
    selected_jsonl: Path | str | None = None,
    price_jsonl: Path | str | None = None,
    reject_labels: Path | str | None = None,
    live_summary: Path | str | dict[str, Any] | None = None,
    action_sample_size: int = DEFAULT_ACTION_SAMPLE_SIZE,
    maximum_false_reject_rate: float = DEFAULT_MAX_FALSE_REJECT_RATE,
    minimum_live_products_per_hour: float = DEFAULT_MINIMUM_LIVE_PRODUCTS_PER_HOUR,
) -> dict[str, Any]:
    """Replay all direct-child ``*.out`` files and return a JSON-ready report."""
    directory = Path(input_dir).expanduser().resolve()
    if not directory.is_dir():
        raise ReplayError(f"input directory not found: {directory}")
    if sample_limit < 0:
        raise ReplayError("sample limit must be zero or greater")
    if action_sample_size <= 0:
        raise ReplayError("action sample size must be greater than zero")
    if not math.isfinite(maximum_false_reject_rate) or not 0 <= maximum_false_reject_rate <= 1:
        raise ReplayError("maximum false reject rate must be between zero and one")

    action_cohort_skus = load_jsonl_skus(selected_jsonl) if selected_jsonl is not None else None
    price_sources: list[Path | str] = []
    if price_jsonl is not None:
        price_sources.append(price_jsonl)
    price_index, price_join = load_historical_price_index(price_sources) if price_sources else ({}, {
        "provenance": "joined_historical_price",
        "request_field": "expect_price_cny",
        "sources": [],
        "source_rows": {},
        "source_invalid_rows": {},
        "source_priced_rows": {},
        "indexed_skus": 0,
    })
    labels = load_reject_labels(reject_labels)
    loaded_live_summary = load_live_summary(live_summary)
    health_gate = live_health_gate(
        loaded_live_summary,
        minimum_products_per_hour=minimum_live_products_per_hour,
    )
    live_action_gate = live_action_evidence_gate(
        loaded_live_summary,
        action_sample_size=action_sample_size,
        selected_cohort_skus=action_cohort_skus,
    )

    files_total = 0
    valid = 0
    invalid = 0
    decision_counts: Counter[str] = Counter()
    reason_counts: Counter[str] = Counter()
    conflict_counts: Counter[str] = Counter()
    missing_counts: Counter[str] = Counter()
    invalid_counts: Counter[str] = Counter()
    action_total_counts: Counter[str] = Counter()
    action_sample_counts: Counter[str] = Counter()
    unassessable_counts: Counter[str] = Counter()
    legacy_decision_counts: Counter[str] = Counter()
    price_join_counts: Counter[str] = Counter()
    cohort_price_join_counts: Counter[str] = Counter()
    cohort_decision_counts: Counter[str] = Counter()
    samples: dict[str, list[dict[str, Any]]] = {decision: [] for decision in DECISIONS}
    decisions_by_sku: dict[str, str] = {}
    input_skus: set[str] = set()
    cohort_nondecision_unassessable = 0
    action_sample_records: list[dict[str, Any]] = []
    reject_audit: list[dict[str, Any]] = []

    for filename in _out_files(directory):
        files_total += 1
        sku = filename.name[:-4]
        input_skus.add(sku)
        in_action_cohort = action_cohort_skus is None or sku in action_cohort_skus
        evidence, error = extract_same_item_evidence(filename)
        if evidence is None:
            invalid += 1
            invalid_counts[error or "unknown"] += 1
            if in_action_cohort:
                cohort_nondecision_unassessable += 1
                unassessable_counts[f"invalid_evidence:{error or 'unknown'}"] += 1
            continue
        evidence, price_status = _inject_historical_price(evidence, sku, price_index)
        price_join_counts[price_status] += 1
        try:
            result = _normalized_result(decider(evidence))
        except Exception as exc:
            invalid += 1
            invalid_counts[f"decision_error:{type(exc).__name__}"] += 1
            if in_action_cohort:
                cohort_nondecision_unassessable += 1
                unassessable_counts[f"decision_error:{type(exc).__name__}"] += 1
            continue

        valid += 1
        decision = result["decision"]
        decisions_by_sku[sku] = decision
        decision_counts[decision] += 1
        if in_action_cohort:
            cohort_decision_counts[decision] += 1
            cohort_price_join_counts[price_status] += 1
        reason_counts[result["reason"]] += 1
        conflict_counts.update(result["hard_conflicts"])
        missing_counts.update(result["missing_evidence"])
        if len(samples[decision]) < sample_limit:
            samples[decision].append(_sample(sku=sku, evidence=evidence, result=result))
        if in_action_cohort and result["action_assessable"]:
            action = result["action"]
            action_total_counts[action] += 1
            if len(action_sample_records) < action_sample_size:
                action_sample_records.append({"sku": sku, "action": action})
                action_sample_counts[action] += 1
                if action == "REJECT":
                    reject_audit.append(
                        _reject_audit_row(sku=sku, evidence=evidence, result=result)
                    )
        elif in_action_cohort:
            unassessable_counts.update(result["action_unassessable_reasons"])
            if result["legacy_action_missing"]:
                legacy_decision_counts[decision] += 1

    missing_cohort_output_count = (
        len(action_cohort_skus - input_skus)
        if action_cohort_skus is not None else 0
    )
    if missing_cohort_output_count:
        cohort_nondecision_unassessable += missing_cohort_output_count
        unassessable_counts["missing_output_file"] += missing_cohort_output_count
    price_join.update({
        "embedded_price_evidence": price_join_counts["embedded"],
        "joined_price_evidence": price_join_counts["joined"],
        "missing_price_evidence": price_join_counts["missing"],
        "cohort_embedded_price_evidence": cohort_price_join_counts["embedded"],
        "cohort_joined_price_evidence": cohort_price_join_counts["joined"],
        "cohort_missing_price_evidence": cohort_price_join_counts["missing"],
        "note": (
            "Joined prices are historical sale-price evidence only. When a price is still "
            "missing, replay does not infer valuable_digital or a binary action."
        ),
    })
    sampled_reject_skus = [row["sku"] for row in reject_audit]
    sampled_reject_set = set(sampled_reject_skus)
    labeled_rejects = {
        sku: labels[sku] for sku in sampled_reject_skus if sku in labels
    }
    missing_label_skus = [sku for sku in sampled_reject_skus if sku not in labels]
    true_rejects = sum(
        label["human_verdict"] == "true_reject" for label in labeled_rejects.values()
    )
    false_rejects = sum(
        label["human_verdict"] == "false_reject" for label in labeled_rejects.values()
    )
    sample_contains_reject = bool(sampled_reject_skus)
    all_rejects_labeled = sample_contains_reject and len(missing_label_skus) == 0
    false_reject_rate = (
        false_rejects / len(sampled_reject_skus)
        if all_rejects_labeled
        else None
    )
    false_reject_rate_passed = (
        false_reject_rate is not None
        and false_reject_rate <= maximum_false_reject_rate
    )
    sample_complete = len(action_sample_records) == action_sample_size
    readiness_checks = {
        "historical_complete_action_sample_collected": sample_complete,
        "live_complete_action_sample_collected": live_action_gate["passed"],
        "sample_contains_reject": sample_contains_reject,
        "all_sampled_rejects_labeled": all_rejects_labeled,
        "false_reject_rate_at_or_below_limit": false_reject_rate_passed,
        "live_health_gate_passed": health_gate["passed"],
    }
    readiness = (
        "awaiting_manual_approval"
        if all(readiness_checks.values())
        else "collecting"
    )
    cohort_decision_total = sum(cohort_decision_counts.values())
    unassessable_total = (
        cohort_decision_total
        - sum(action_total_counts.values())
        + cohort_nondecision_unassessable
    )

    report: dict[str, Any] = {
        "files_total": files_total,
        "evidence_valid": valid,
        "evidence_invalid": invalid,
        "decisions": {
            decision: {
                "count": decision_counts[decision],
                "percent": round(decision_counts[decision] * 100 / valid, 2) if valid else 0.0,
            }
            for decision in DECISIONS
        },
        "reasons": _counter_dict(reason_counts),
        "hard_conflicts": _counter_dict(conflict_counts),
        "missing_evidence": _counter_dict(missing_counts),
        "invalid_evidence_reasons": _counter_dict(invalid_counts),
        "samples": samples,
        "actions": {
            "scope": "selected-jsonl-cohort" if action_cohort_skus is not None else "all-valid-evidence",
            "cohort_source": str(Path(selected_jsonl).expanduser().resolve())
            if selected_jsonl is not None else None,
            "cohort_skus": len(action_cohort_skus) if action_cohort_skus is not None else None,
            "cohort_missing_output_files": missing_cohort_output_count,
            "cohort_decisions": cohort_decision_total,
            "cohort_internal_decision_distribution": {
                decision: cohort_decision_counts[decision] for decision in DECISIONS
            },
            "sample_target": action_sample_size,
            "sample_count": len(action_sample_records),
            "sample_complete": sample_complete,
            "complete_action_total": sum(action_total_counts.values()),
            "complete_action_overflow": max(
                0, sum(action_total_counts.values()) - len(action_sample_records)
            ),
            "sample_distribution": {
                action: {
                    "count": action_sample_counts[action],
                    "percent": round(
                        action_sample_counts[action] * 100 / len(action_sample_records), 2
                    ) if action_sample_records else 0.0,
                }
                for action in ACTIONS
            },
            "complete_action_distribution": {
                action: action_total_counts[action] for action in ACTIONS
            },
            "sampling_method": "first-complete-actions-in-sorted-output-filename-order",
            "mapping": "matcher-explicit-action-only",
            "evidence_complete_required": True,
        },
        "unassessable": {
            "count": unassessable_total,
            "reasons": _counter_dict(unassessable_counts),
            "legacy_decision_distribution": {
                decision: legacy_decision_counts[decision] for decision in DECISIONS
            },
            "note": "Legacy or incomplete decisions are never inferred into ALLOW/REJECT.",
        },
        "historical_price_join": price_join,
        "reject_audit": reject_audit,
        "manual_reject_audit": {
            "required_verdicts": list(HUMAN_VERDICTS),
            "minimum_sampled_reject_count": 1,
            "sample_contains_reject": sample_contains_reject,
            "sampled_reject_count": len(sampled_reject_skus),
            "labeled_reject_count": len(labeled_rejects),
            "true_reject_count": true_rejects,
            "false_reject_count": false_rejects,
            "missing_label_skus": missing_label_skus,
            "unmatched_label_skus": sorted(set(labels) - sampled_reject_set),
            "all_rejects_labeled": all_rejects_labeled,
            "false_reject_rate": (
                round(false_reject_rate, 6) if false_reject_rate is not None else None
            ),
            "maximum_false_reject_rate": maximum_false_reject_rate,
            "false_reject_rate_passed": false_reject_rate_passed,
        },
        "live_health_gate": health_gate,
        "live_action_evidence_gate": live_action_gate,
        "readiness": readiness,
        "readiness_checks": readiness_checks,
        "enforcement": {
            "mode": "shadow-not-enforced",
            "automatic_enforcement": False,
            "manual_approval_required": True,
        },
    }
    if selected_jsonl is not None:
        report["selected_crosscheck"] = selected_crosscheck(selected_jsonl, decisions_by_sku)
    return report


def _nonnegative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be zero or greater")
    return parsed


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def _rate_zero_to_one(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or not 0 <= parsed <= 1:
        raise argparse.ArgumentTypeError("must be between zero and one")
    return parsed


def _nonnegative_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0:
        raise argparse.ArgumentTypeError("must be finite and zero or greater")
    return parsed


def write_reject_audit_jsonl(filename: Path | str, rows: list[dict[str, Any]]) -> None:
    output = Path(filename).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    encoded = "".join(
        f"{json.dumps(row, ensure_ascii=False, separators=(',', ':'))}\n" for row in rows
    )
    output.write_text(encoded, encoding="utf-8")


def write_reject_audit_csv(filename: Path | str, rows: list[dict[str, Any]]) -> None:
    output = Path(filename).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "sku",
        "expected_title",
        "selected_offer_id",
        "selected_offer_url",
        "selected_offer_title",
        "selected_offer_supplier",
        "selected_offer_cost",
        "action",
        "brand",
        "product",
        "model",
        "policy_reasons",
        "human_verdict",
        "review_note",
    ]
    with output.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({
                **row,
                "brand": json.dumps(row.get("brand") or {}, ensure_ascii=False, separators=(",", ":")),
                "product": json.dumps(row.get("product") or {}, ensure_ascii=False, separators=(",", ":")),
                "model": json.dumps(row.get("model") or {}, ensure_ascii=False, separators=(",", ":")),
                "policy_reasons": "; ".join(row.get("policy_reasons") or []),
            })


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Replay FAST/REVIEW/REJECT decisions from historical 1688 outputs."
    )
    parser.add_argument("--input-dir", required=True, help="Directory containing *.out files")
    parser.add_argument(
        "--selected-jsonl",
        help=(
            "Optional SKU cohort for binary action sampling/readiness; internal decisions "
            "remain full-corpus and a sibling published.jsonl is cross-checked when present"
        ),
    )
    parser.add_argument(
        "--price-jsonl",
        help=(
            "Independent JSONL with SKU sell_price/sale_price injected as "
            "joined historical price"
        ),
    )
    parser.add_argument(
        "--reject-labels",
        help="Optional human labels JSONL/CSV/TSV with true_reject|false_reject verdicts",
    )
    parser.add_argument(
        "--live-summary",
        help="Live prewarm summary JSON used only for the >=20/hour health gate",
    )
    parser.add_argument(
        "--reject-audit-jsonl",
        "--reject-audit-output",
        dest="reject_audit_jsonl",
        help="Write the sampled REJECT audit template as JSONL",
    )
    parser.add_argument(
        "--reject-audit-csv",
        help="Write the sampled REJECT audit template as UTF-8 CSV",
    )
    parser.add_argument("--output", help="Write the JSON report here instead of stdout")
    parser.add_argument(
        "--samples-per-decision",
        "--sample-limit",
        "-n",
        dest="sample_limit",
        type=_nonnegative_int,
        default=5,
        help="Maximum examples retained for each decision (default: 5)",
    )
    parser.add_argument(
        "--action-sample-size",
        type=_positive_int,
        default=DEFAULT_ACTION_SAMPLE_SIZE,
        help=f"Complete binary actions required for acceptance (default: {DEFAULT_ACTION_SAMPLE_SIZE})",
    )
    parser.add_argument(
        "--maximum-false-reject-rate",
        type=_rate_zero_to_one,
        default=DEFAULT_MAX_FALSE_REJECT_RATE,
        help=f"Maximum manually labeled false-reject rate (default: {DEFAULT_MAX_FALSE_REJECT_RATE:g})",
    )
    parser.add_argument(
        "--minimum-live-products-per-hour",
        type=_nonnegative_float,
        default=DEFAULT_MINIMUM_LIVE_PRODUCTS_PER_HOUR,
        help=f"Minimum actual live recognition attempts/hour (default: {DEFAULT_MINIMUM_LIVE_PRODUCTS_PER_HOUR:g})",
    )
    return parser


def main(
    argv: list[str] | None = None,
    *,
    decider: Callable[[dict[str, Any]], Any] | None = None,
) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        adaptive_decider = decider or load_adaptive_decider()
        report = replay_directory(
            args.input_dir,
            adaptive_decider,
            sample_limit=args.sample_limit,
            selected_jsonl=args.selected_jsonl,
            price_jsonl=args.price_jsonl,
            reject_labels=args.reject_labels,
            live_summary=args.live_summary,
            action_sample_size=args.action_sample_size,
            maximum_false_reject_rate=args.maximum_false_reject_rate,
            minimum_live_products_per_hour=args.minimum_live_products_per_hour,
        )
        if args.reject_audit_jsonl:
            write_reject_audit_jsonl(args.reject_audit_jsonl, report["reject_audit"])
        if args.reject_audit_csv:
            write_reject_audit_csv(args.reject_audit_csv, report["reject_audit"])
        encoded = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
        if args.output:
            output = Path(args.output).expanduser().resolve()
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(encoded, encoding="utf-8")
        else:
            sys.stdout.write(encoded)
    except (ReplayError, OSError) as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
