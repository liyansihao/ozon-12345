#!/usr/bin/env python3
"""Long-lived JSON-line worker around the existing 1688 reliability logic."""

from __future__ import annotations

import argparse
import importlib.util
import json
import statistics
import sys
import tempfile
from pathlib import Path


def load_module(filename: str):
    spec = importlib.util.spec_from_file_location("flow_b_1688_image_median", filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load 1688 implementation: {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def format_cost_output(result: dict) -> str:
    return "\n".join([
        f"COST_SOURCE {result.get('cost_source') or 'search_first_page_p70_similarity_filtered'}",
        f"REASON {result.get('reason') or ''}",
        "FILTERED_FIRST_PAGE_PRICES " + json.dumps(result.get("filtered_first_page_prices") or [], ensure_ascii=False),
        f"P70_COST {result.get('p70_cost')}",
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
    )
    top3 = rows[:3]
    result["top3_prices"] = [row["price"] for row in top3]
    result["median_cost"] = statistics.median(result["top3_prices"]) if top3 else None
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--script", required=True, help="Existing 1688_image_median.py implementation")
    args = parser.parse_args()
    module = load_module(str(Path(args.script).expanduser().resolve()))
    session = None
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            if session is None:
                session = module.load_session()
            result = analyze(module, session, request)
            response = {
                "id": request.get("id"),
                "code": 0 if result.get("p70_cost") is not None else 2,
                "stdout": format_cost_output(result),
                "stderr": "",
            }
        except Exception as exc:  # One bad image/session must not terminate the worker loop.
            session = None
            response = {
                "id": request.get("id"),
                "code": 1,
                "stdout": "",
                "stderr": f"{type(exc).__name__}: {exc}",
            }
        print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
