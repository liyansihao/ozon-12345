#!/usr/bin/env python3
"""Benchmark adaptive 1688 decisions against historical output evidence.

This is deliberately a local, no-network benchmark.  It measures how quickly
``adaptive_decision_from_evidence`` can replay evidence already captured in
``*.out`` files.  It does not measure 1688 search, image download, browser,
pricing, publishing, or any other live end-to-end latency.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, Callable, Iterable


BENCHMARK_SCOPE = "historical-shadow-replay"
REPORT_VERSION = "1688-binary-shadow-benchmark-v2"
EVIDENCE_LABEL = "SAME_ITEM_EVIDENCE"
DECISIONS = ("FAST", "REVIEW", "REJECT")
ACTIONS = ("ALLOW", "REJECT")
DEFAULT_MINIMUM_PRODUCTS_PER_HOUR = 20.0
DEFAULT_SAMPLE_LIMIT = 5
MAX_SAMPLE_LIMIT = 100
DEFAULT_ACTION_SAMPLE_SIZE = 100
ADAPTIVE_ACTION_VERSION = "adaptive-v5-shadow"
ADAPTIVE_ACTION_POLICY_VERSION = "adaptive-v5-policy-1"
VALUABLE_DIGITAL_THRESHOLD_CNY = 300
EXIT_ERROR = 2
EXIT_BELOW_MINIMUM = 3


class BenchmarkError(RuntimeError):
    """Raised when a benchmark cannot be run or written."""


def load_adaptive_decider(
    module_path: Path | str | None = None,
) -> Callable[[dict[str, Any]], dict[str, Any]]:
    """Load the pure adaptive evidence decider without running matcher CLI code."""
    filename = (
        Path(module_path)
        if module_path is not None
        else Path(__file__).with_name("1688_image_median.py")
    )
    filename = filename.expanduser().resolve()
    if not filename.is_file():
        raise BenchmarkError(f"1688 matcher module not found: {filename}")

    spec = importlib.util.spec_from_file_location("_benchmark_1688_image_median", filename)
    if spec is None or spec.loader is None:
        raise BenchmarkError(f"could not import 1688 matcher module: {filename}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        raise BenchmarkError(f"failed to import 1688 matcher module {filename}: {exc}") from exc

    decider = getattr(module, "adaptive_decision_from_evidence", None)
    if not callable(decider):
        raise BenchmarkError(
            "1688 matcher is missing adaptive_decision_from_evidence(evidence): "
            f"{filename}"
        )
    return decider


def _out_files(input_dir: Path) -> Iterable[Path]:
    """Yield direct-child output files deterministically without reading their bodies."""
    try:
        with os.scandir(input_dir) as entries:
            files = [
                Path(entry.path)
                for entry in entries
                if entry.is_file(follow_symlinks=False) and entry.name.endswith(".out")
            ]
    except OSError as exc:
        raise BenchmarkError(f"cannot scan input directory {input_dir}: {exc}") from exc
    yield from sorted(files, key=lambda path: path.name)


def extract_same_item_evidence(
    filename: Path | str,
) -> tuple[dict[str, Any] | None, str | None]:
    """Stream one output file and return its first validly located evidence line."""
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


def _normalize_decision(raw_result: Any) -> tuple[str, dict[str, Any]]:
    if not isinstance(raw_result, dict):
        raise ValueError("adaptive decision must return an object")
    decision = str(raw_result.get("decision") or "").strip().upper()
    if decision not in DECISIONS:
        raise ValueError(f"unknown adaptive decision: {decision or '<missing>'}")
    return decision, raw_result


def _positive_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool) or str(value).strip() == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def _row_sku(row: dict[str, Any]) -> str:
    data = row.get("data") if isinstance(row.get("data"), dict) else {}
    for value in (row.get("sku"), data.get("sku"), row.get("source_sku"), data.get("source_sku")):
        sku = str(value or "").strip()
        if sku:
            return sku
    return ""


def _row_price_cny(row: dict[str, Any]) -> float | None:
    data = row.get("data") if isinstance(row.get("data"), dict) else {}
    payload = {**row, **data}
    for field in ("sell_price", "sale_price"):
        price = _positive_number(payload.get(field))
        if price is not None:
            return price
    return None


def load_historical_price_index(
    sources: Iterable[Path | str],
) -> tuple[dict[str, float], dict[str, Any]]:
    prices: dict[str, float] = {}
    resolved_sources: list[str] = []
    invalid_rows = 0
    for source in sources:
        filename = Path(source).expanduser().resolve()
        if not filename.is_file():
            raise BenchmarkError(f"historical price JSONL not found: {filename}")
        resolved_sources.append(str(filename))
        with filename.open("r", encoding="utf-8", errors="replace") as handle:
            for raw_line in handle:
                if not raw_line.strip():
                    continue
                try:
                    row = json.loads(raw_line)
                except json.JSONDecodeError:
                    invalid_rows += 1
                    continue
                if not isinstance(row, dict):
                    invalid_rows += 1
                    continue
                sku = _row_sku(row)
                price = _row_price_cny(row)
                if sku and price is not None:
                    prices[sku] = price
    return prices, {
        "provenance": "joined_historical_price",
        "request_field": "expect_price_cny",
        "sources": resolved_sources,
        "indexed_skus": len(prices),
        "invalid_rows": invalid_rows,
    }


def load_jsonl_skus(source: Path | str) -> set[str]:
    filename = Path(source).expanduser().resolve()
    if not filename.is_file():
        raise BenchmarkError(f"selected cohort JSONL not found: {filename}")
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
    evidence: dict[str, Any], sku: str, price_index: dict[str, float]
) -> tuple[dict[str, Any], str]:
    request = evidence.get("request") if isinstance(evidence.get("request"), dict) else {}
    if _positive_number(request.get("expect_price_cny")) is not None:
        return evidence, "embedded"
    price = price_index.get(sku)
    if price is None:
        return evidence, "missing"
    return {
        **evidence,
        "request": {
            **request,
            "expect_price_cny": price,
            "expect_price_source": "joined_historical_price",
        },
    }, "joined"


def _binary_action(result: dict[str, Any]) -> tuple[str | None, list[str], bool]:
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


def _percentile(values: list[float], percentile: float) -> float | None:
    """Return a linearly interpolated percentile from seconds-based samples."""
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def _rate(count: int, elapsed_seconds: float) -> float:
    denominator = max(elapsed_seconds, 1e-9)
    return count * 3600.0 / denominator


def _rounded_rate(count: int, elapsed_seconds: float) -> float:
    return round(_rate(count, elapsed_seconds), 2)


def _rounded_milliseconds(value: float | None) -> float | None:
    return None if value is None else round(value * 1000.0, 3)


def _bounded_sample(
    filename: Path,
    decision: str,
    result: dict[str, Any],
    latency_seconds: float,
) -> dict[str, Any]:
    return {
        "file": filename.name,
        "sku": filename.stem,
        "decision": decision,
        "score": result.get("score"),
        "reason": str(result.get("reason") or "").strip(),
        "decision_latency_ms": _rounded_milliseconds(latency_seconds),
    }


def benchmark_directory(
    input_dir: Path | str,
    decider: Callable[[dict[str, Any]], Any],
    *,
    minimum_products_per_hour: float = DEFAULT_MINIMUM_PRODUCTS_PER_HOUR,
    limit: int | None = None,
    sample_limit: int = DEFAULT_SAMPLE_LIMIT,
    action_sample_size: int = DEFAULT_ACTION_SAMPLE_SIZE,
    selected_jsonl: Path | str | None = None,
    price_jsonl: Path | str | None = None,
    clock: Callable[[], float] = time.perf_counter,
) -> dict[str, Any]:
    """Replay historical evidence and return a JSON-ready benchmark report.

    Wall time covers directory discovery, streaming file reads, JSON parsing,
    and adaptive decisions.  Per-decision latency covers only the decider call.
    """
    directory = Path(input_dir).expanduser().resolve()
    if not directory.is_dir():
        raise BenchmarkError(f"input directory not found: {directory}")
    if not math.isfinite(minimum_products_per_hour) or minimum_products_per_hour < 0:
        raise BenchmarkError("minimum products per hour must be finite and zero or greater")
    if limit is not None and limit <= 0:
        raise BenchmarkError("limit must be greater than zero")
    if not 0 <= sample_limit <= MAX_SAMPLE_LIMIT:
        raise BenchmarkError(f"sample limit must be between 0 and {MAX_SAMPLE_LIMIT}")
    if action_sample_size <= 0:
        raise BenchmarkError("action sample size must be greater than zero")

    action_cohort_skus = load_jsonl_skus(selected_jsonl) if selected_jsonl is not None else None
    price_sources: list[Path | str] = []
    if price_jsonl is not None:
        price_sources.append(price_jsonl)
    price_index, price_join = load_historical_price_index(price_sources) if price_sources else ({}, {
        "provenance": "joined_historical_price",
        "request_field": "expect_price_cny",
        "sources": [],
        "indexed_skus": 0,
        "invalid_rows": 0,
    })

    files_processed = 0
    evidence_parsed = 0
    evidence_invalid = 0
    decisions_completed = 0
    decision_errors = 0
    invalid_reasons: Counter[str] = Counter()
    decision_counts: Counter[str] = Counter()
    action_counts: Counter[str] = Counter()
    action_sample_counts: Counter[str] = Counter()
    unassessable_reasons: Counter[str] = Counter()
    legacy_decisions: Counter[str] = Counter()
    price_join_counts: Counter[str] = Counter()
    latencies: list[float] = []
    samples: list[dict[str, Any]] = []
    input_skus: set[str] = set()
    cohort_decisions = 0
    cohort_nondecision_unassessable = 0

    started_at = clock()
    for filename in _out_files(directory):
        if limit is not None and files_processed >= limit:
            break
        files_processed += 1
        input_skus.add(filename.stem)
        in_action_cohort = action_cohort_skus is None or filename.stem in action_cohort_skus
        evidence, evidence_error = extract_same_item_evidence(filename)
        if evidence is None:
            evidence_invalid += 1
            invalid_reasons[evidence_error or "unknown_evidence_error"] += 1
            if in_action_cohort:
                cohort_nondecision_unassessable += 1
                unassessable_reasons[f"invalid_evidence:{evidence_error or 'unknown'}"] += 1
            continue

        evidence_parsed += 1
        evidence, price_status = _inject_historical_price(
            evidence, filename.stem, price_index
        )
        price_join_counts[price_status] += 1
        decision_started_at = clock()
        try:
            decision, result = _normalize_decision(decider(evidence))
        except Exception as exc:
            decision_finished_at = clock()
            latencies.append(max(0.0, decision_finished_at - decision_started_at))
            decision_errors += 1
            invalid_reasons[f"decision_error:{type(exc).__name__}"] += 1
            if in_action_cohort:
                cohort_nondecision_unassessable += 1
                unassessable_reasons[f"decision_error:{type(exc).__name__}"] += 1
            continue
        decision_finished_at = clock()
        latency_seconds = max(0.0, decision_finished_at - decision_started_at)
        latencies.append(latency_seconds)
        decisions_completed += 1
        decision_counts[decision] += 1
        if in_action_cohort:
            cohort_decisions += 1
            action, action_reasons, action_assessable = _binary_action(result)
            if action_assessable and action is not None:
                action_counts[action] += 1
                if sum(action_sample_counts.values()) < action_sample_size:
                    action_sample_counts[action] += 1
            else:
                unassessable_reasons.update(action_reasons)
                if result.get("version") != ADAPTIVE_ACTION_VERSION:
                    legacy_decisions[decision] += 1
        if len(samples) < sample_limit:
            samples.append(_bounded_sample(filename, decision, result, latency_seconds))

    finished_at = clock()
    elapsed_seconds = max(0.0, finished_at - started_at)
    raw_products_per_hour = _rate(decisions_completed, elapsed_seconds)
    products_per_hour = round(raw_products_per_hour, 6)
    threshold_passed = (
        decisions_completed > 0
        and raw_products_per_hour >= minimum_products_per_hour
    )
    missing_cohort_output_count = (
        len(action_cohort_skus - input_skus)
        if action_cohort_skus is not None and limit is None else 0
    )
    if missing_cohort_output_count:
        cohort_nondecision_unassessable += missing_cohort_output_count
        unassessable_reasons["missing_output_file"] += missing_cohort_output_count
    action_total = sum(action_counts.values())
    action_sample_count = sum(action_sample_counts.values())
    unassessable_count = cohort_decisions - action_total + cohort_nondecision_unassessable
    price_join.update({
        "embedded_price_evidence": price_join_counts["embedded"],
        "joined_price_evidence": price_join_counts["joined"],
        "missing_price_evidence": price_join_counts["missing"],
        "note": (
            "Joined prices are historical sale-price evidence only; missing prices "
            "never imply valuable_digital or a binary action."
        ),
    })

    return {
        "report_version": REPORT_VERSION,
        "scope": BENCHMARK_SCOPE,
        "network_mode": "disabled-by-design",
        "scope_warning": (
            "Local historical evidence replay only; this is not live 1688 or "
            "end-to-end listing throughput."
        ),
        "input": {
            "directory": str(directory),
            "file_pattern": "*.out (direct children)",
            "limit": limit,
        },
        "wall_time_seconds": round(elapsed_seconds, 6),
        "counts": {
            "files_processed": files_processed,
            "evidence_parsed": evidence_parsed,
            "evidence_invalid": evidence_invalid,
            "decision_calls": len(latencies),
            "decisions_completed": decisions_completed,
            "decision_errors": decision_errors,
        },
        "decision_counts": {
            decision: decision_counts[decision] for decision in DECISIONS
        },
        "binary_actions": {
            "scope": "selected-jsonl-cohort" if action_cohort_skus is not None else "all-processed-evidence",
            "cohort_source": str(Path(selected_jsonl).expanduser().resolve())
            if selected_jsonl is not None else None,
            "cohort_skus": len(action_cohort_skus) if action_cohort_skus is not None else None,
            "cohort_decisions": cohort_decisions,
            "cohort_missing_output_files": missing_cohort_output_count,
            "sample_target": action_sample_size,
            "sample_count": action_sample_count,
            "sample_complete": action_sample_count == action_sample_size,
            "complete_action_total": action_total,
            "sample_distribution": {
                action: action_sample_counts[action] for action in ACTIONS
            },
            "complete_action_distribution": {
                action: action_counts[action] for action in ACTIONS
            },
            "sampling_method": "first-complete-actions-in-sorted-output-filename-order",
            "unassessable_count": unassessable_count,
            "unassessable_reasons": dict(sorted(unassessable_reasons.items())),
            "legacy_decision_distribution": {
                decision: legacy_decisions[decision] for decision in DECISIONS
            },
            "readiness": "collecting",
            "enforced": False,
            "automatic_enforcement": False,
            "note": "Benchmark throughput cannot grant manual policy approval.",
        },
        "historical_price_join": price_join,
        "throughput_per_hour": {
            "files": _rounded_rate(files_processed, elapsed_seconds),
            "evidence": _rounded_rate(evidence_parsed, elapsed_seconds),
            "decision_products": products_per_hour,
            "complete_binary_actions": _rounded_rate(action_total, elapsed_seconds),
        },
        "decision_latency_ms": {
            "measure": "adaptive_decision_from_evidence call only",
            "count": len(latencies),
            "p50": _rounded_milliseconds(_percentile(latencies, 0.50)),
            "p95": _rounded_milliseconds(_percentile(latencies, 0.95)),
            "p99": _rounded_milliseconds(_percentile(latencies, 0.99)),
        },
        "acceptance": {
            "metric": "historical_shadow_decision_products_per_hour",
            "minimum_products_per_hour": float(minimum_products_per_hour),
            "measured_products_per_hour": products_per_hour,
            "quality_mode": "shadow-not-enforced",
            "does_not_assert": [
                "binary_action_correctness",
                "live_1688_throughput",
                "profitability",
            ],
            "passed": threshold_passed,
        },
        "invalid_reasons": dict(sorted(invalid_reasons.items())),
        "samples": samples,
        "sample_limit": sample_limit,
    }


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def _bounded_sample_limit(value: str) -> int:
    parsed = int(value)
    if not 0 <= parsed <= MAX_SAMPLE_LIMIT:
        raise argparse.ArgumentTypeError(f"must be between 0 and {MAX_SAMPLE_LIMIT}")
    return parsed


def _nonnegative_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0:
        raise argparse.ArgumentTypeError("must be a finite number zero or greater")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "No-network historical-shadow-replay benchmark for adaptive 1688 "
            "evidence decisions (not a live end-to-end speed test)."
        )
    )
    parser.add_argument("--input-dir", required=True, help="Directory containing historical *.out files")
    parser.add_argument("--limit", type=_positive_int, help="Process at most this many output files")
    parser.add_argument(
        "--selected-jsonl",
        help="Optional SKU cohort for binary action sampling; internal decisions remain full-corpus",
    )
    parser.add_argument(
        "--price-jsonl",
        help="Optional additional JSONL providing joined historical sell_price/sale_price",
    )
    parser.add_argument("--output", help="Write JSON report here instead of stdout")
    parser.add_argument(
        "--minimum-products-per-hour",
        type=_nonnegative_float,
        default=DEFAULT_MINIMUM_PRODUCTS_PER_HOUR,
        help=(
            "Minimum local adaptive decisions/hour; exit nonzero below it "
            f"(default: {DEFAULT_MINIMUM_PRODUCTS_PER_HOUR:g})"
        ),
    )
    parser.add_argument(
        "--sample-limit",
        type=_bounded_sample_limit,
        default=DEFAULT_SAMPLE_LIMIT,
        help=f"Maximum samples retained, 0-{MAX_SAMPLE_LIMIT} (default: {DEFAULT_SAMPLE_LIMIT})",
    )
    parser.add_argument(
        "--action-sample-size",
        type=_positive_int,
        default=DEFAULT_ACTION_SAMPLE_SIZE,
        help=f"Complete binary actions retained for the audit sample (default: {DEFAULT_ACTION_SAMPLE_SIZE})",
    )
    return parser


def main(
    argv: list[str] | None = None,
    *,
    decider: Callable[[dict[str, Any]], Any] | None = None,
    clock: Callable[[], float] = time.perf_counter,
) -> int:
    args = build_parser().parse_args(argv)
    try:
        report = benchmark_directory(
            args.input_dir,
            decider or load_adaptive_decider(),
            minimum_products_per_hour=args.minimum_products_per_hour,
            limit=args.limit,
            sample_limit=args.sample_limit,
            action_sample_size=args.action_sample_size,
            selected_jsonl=args.selected_jsonl,
            price_jsonl=args.price_jsonl,
            clock=clock,
        )
        encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        if args.output:
            output = Path(args.output).expanduser().resolve()
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(encoded, encoding="utf-8")
        else:
            sys.stdout.write(encoded)
    except (BenchmarkError, OSError) as exc:
        sys.stderr.write(f"benchmark error: {exc}\n")
        return EXIT_ERROR
    return 0 if report["acceptance"]["passed"] else EXIT_BELOW_MINIMUM


if __name__ == "__main__":
    raise SystemExit(main())
