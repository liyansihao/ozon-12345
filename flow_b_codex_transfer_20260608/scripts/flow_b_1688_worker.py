#!/usr/bin/env python3
"""Long-lived JSON-line worker around the existing 1688 reliability logic."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import random
import statistics
import sys
import tempfile
import time
from pathlib import Path


def load_module(filename: str):
    spec = importlib.util.spec_from_file_location("flow_b_1688_image_median", filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load 1688 implementation: {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def format_cost_output(result: dict, recovery: dict | None = None) -> str:
    recovery = recovery or {"retry_count": 0, "retry_intervals_ms": [], "session_rebuilt": False}
    evidence_lines = []
    if result.get("same_item_evidence"):
        evidence_lines.append(f"SAME_ITEM_EVIDENCE {result['same_item_evidence']}")
    if result.get("match_evidence_key"):
        evidence_lines.append(f"MATCH_EVIDENCE_KEY {result['match_evidence_key']}")
    return "\n".join([
        *evidence_lines,
        f"COST_SOURCE {result.get('cost_source') or 'search_first_page_p70_similarity_filtered'}",
        f"REASON {result.get('reason') or ''}",
        "FILTERED_FIRST_PAGE_PRICES " + json.dumps(result.get("filtered_first_page_prices") or [], ensure_ascii=False),
        f"P70_COST {result.get('p70_cost')}",
        f"TRANSIENT_RETRY_COUNT {recovery['retry_count']}",
        "TRANSIENT_RETRY_INTERVALS_MS " + json.dumps(recovery["retry_intervals_ms"]),
        f"SESSION_REBUILT {str(bool(recovery['session_rebuilt'])).lower()}",
    ])


def analyze(module, session, request: dict) -> dict:
    image_path = Path(str(request.get("image") or "")).expanduser().resolve()
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")
    with tempfile.TemporaryDirectory(prefix="1688-image-worker-") as temp_name:
        upload_path, _note = module.normalize_image(image_path, Path(temp_name))
        raw_products = session.search_by_image(str(upload_path))
    rows = module.summarize_products(raw_products)
    result = module.first_page_p70_cost(
        rows,
        expect_title=str(request.get("expect_title") or ""),
        expect_model=str(request.get("expect_model") or ""),
        expect_category=str(request.get("expect_category") or ""),
        page_size=max(1, int(request.get("top") or 10)),
        minimum_matches=max(1, int(request.get("minimum_same_item_matches") or 3)),
    )
    top3 = rows[:3]
    result["top3_prices"] = [row["price"] for row in top3]
    result["median_cost"] = statistics.median(result["top3_prices"]) if top3 else None
    return result


def is_transient_transport_error(exc: Exception) -> bool:
    messages = []
    current = exc
    visited = set()
    while current is not None and id(current) not in visited:
        visited.add(id(current))
        messages.append(f"{type(current).__name__}: {current}".lower())
        current = current.__cause__ or current.__context__
    text = "\n".join(messages)
    return any(marker in text for marker in (
        "unexpected_eof_while_reading",
        "eof occurred in violation of protocol",
        "max retries exceeded",
        "sslerror",
        "connectionerror",
        "connection reset",
        "remote end closed connection",
        "temporarily unavailable",
        "name or service not known",
        "failed to resolve",
        "timed out",
        "timeout",
    ))


def analyze_with_transient_recovery(
    module,
    session,
    request: dict,
    *,
    load_session,
    max_retries: int = 2,
    base_delay_seconds: float = 0.5,
    max_jitter_seconds: float = 0.25,
    total_budget_seconds: float = 45.0,
    sleep=time.sleep,
    jitter=random.uniform,
    monotonic=time.monotonic,
):
    """Retry only transport failures, always with a newly built session."""
    retry_limit = max(0, int(max_retries))
    base_delay = max(0.0, float(base_delay_seconds))
    jitter_limit = max(0.0, float(max_jitter_seconds))
    budget = max(0.0, float(total_budget_seconds))
    started = monotonic()
    current_session = session
    intervals_ms = []
    for attempt in range(retry_limit + 1):
        try:
            if current_session is None:
                current_session = load_session()
            result = analyze(module, current_session, request)
            return result, current_session, {
                "retry_count": len(intervals_ms),
                "retry_intervals_ms": intervals_ms,
                "session_rebuilt": bool(intervals_ms),
            }
        except Exception as exc:
            if current_session is not None:
                try:
                    current_session.close()
                except Exception:
                    pass
            current_session = None
            delay = base_delay * (2 ** attempt) + jitter(0.0, jitter_limit)
            elapsed = monotonic() - started
            can_retry = (
                is_transient_transport_error(exc)
                and attempt < retry_limit
                and elapsed + delay <= budget
            )
            if not can_retry:
                exc.flow_b_recovery = {
                    "retry_count": len(intervals_ms),
                    "retry_intervals_ms": intervals_ms,
                    "session_rebuilt": bool(intervals_ms),
                    "budget_exhausted": elapsed + delay > budget,
                }
                raise
            intervals_ms.append(round(delay * 1000))
            sleep(delay)
    raise RuntimeError("unreachable 1688 recovery state")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--script", required=True, help="Existing 1688_image_median.py implementation")
    args = parser.parse_args()
    module = load_module(str(Path(args.script).expanduser().resolve()))
    session = None
    max_retries = max(0, int(os.environ.get("FLOW_B_1688_TRANSIENT_RETRIES", "2")))
    base_delay_seconds = max(0.0, float(os.environ.get("FLOW_B_1688_RETRY_BASE_SECONDS", "0.5")))
    max_jitter_seconds = max(0.0, float(os.environ.get("FLOW_B_1688_RETRY_JITTER_SECONDS", "0.25")))
    total_budget_seconds = max(0.0, float(os.environ.get("FLOW_B_1688_RETRY_BUDGET_SECONDS", "45")))
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            result, session, recovery = analyze_with_transient_recovery(
                module,
                session,
                request,
                load_session=module.load_session,
                max_retries=max_retries,
                base_delay_seconds=base_delay_seconds,
                max_jitter_seconds=max_jitter_seconds,
                total_budget_seconds=total_budget_seconds,
            )
            response = {
                "id": request.get("id"),
                "code": 0 if result.get("p70_cost") is not None else 2,
                "stdout": format_cost_output(result, recovery),
                "stderr": "",
                **recovery,
            }
        except Exception as exc:  # One bad image/session must not terminate the worker loop.
            session = None
            recovery = getattr(exc, "flow_b_recovery", {
                "retry_count": 0,
                "retry_intervals_ms": [],
                "session_rebuilt": False,
            })
            response = {
                "id": request.get("id"),
                "code": 1,
                "stdout": "",
                "stderr": "\n".join([
                    f"TRANSIENT_RETRY_COUNT {recovery['retry_count']}",
                    "TRANSIENT_RETRY_INTERVALS_MS " + json.dumps(recovery["retry_intervals_ms"]),
                    f"SESSION_REBUILT {str(bool(recovery['session_rebuilt'])).lower()}",
                    f"{type(exc).__name__}: {exc}",
                ]),
                **recovery,
            }
        print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
