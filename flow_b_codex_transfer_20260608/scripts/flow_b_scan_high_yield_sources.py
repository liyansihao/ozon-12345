#!/usr/bin/env python3
"""Find and scan high-yield Ozon China highlight seller sources with C-group pacing."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUN_ROOT = ROOT / "runs" / "flow_b"

HIGH_YIELD_SOURCES = [
    {
        "key": "kids_toys_min500",
        "url": "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?category=7000",
        "min_price": 500,
        "max_scroll_steps": 240,
    },
    {
        "key": "kids_toys_segment_min50",
        "url": "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?category=7000",
        "min_price": 50,
        "max_scroll_steps": 150,
    },
    {
        "key": "playing_cards_13517_china",
        "url": "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?category=13517",
        "min_price": 50,
        "max_scroll_steps": 180,
    },
    {
        "key": "tabletop_13506_china",
        "url": "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?category=13506",
        "min_price": 50,
        "max_scroll_steps": 180,
    },
    {
        "key": "models_min500",
        "url": "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?category=13812",
        "min_price": 500,
        "max_scroll_steps": 120,
    },
    {
        "key": "models_min50",
        "url": "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?category=13812",
        "min_price": 50,
        "max_scroll_steps": 120,
    },
    {
        "key": "electronics_min500",
        "url": "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?category=15500",
        "min_price": 500,
        "max_scroll_steps": 80,
    },
    {
        "key": "electronics_min50",
        "url": "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?category=15500",
        "min_price": 50,
        "max_scroll_steps": 80,
    },
]


def run(cmd: list[str], env: dict[str, str] | None = None) -> int:
    print("+", " ".join(cmd), flush=True)
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    proc = subprocess.run(cmd, cwd=ROOT, env=merged_env)
    return proc.returncode


def source_delta(scan_path: Path) -> int:
    if not scan_path.exists():
        return 0
    try:
        rows = json.loads(scan_path.read_text())
    except Exception:
        return 0
    if not isinstance(rows, list):
        return 0
    seen_batches = set()
    total = 0
    for row in rows:
        delta = row.get("favorite_count_delta")
        key = (row.get("favorite_count_before"), row.get("favorite_count_after"), delta)
        if key in seen_batches:
            continue
        seen_batches.add(key)
        if isinstance(delta, (int, float)):
            total += int(delta)
    return total


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Scan high-yield Ozon China highlight sources with C-group pacing.")
    parser.add_argument("--run-root", default=str(RUN_ROOT))
    parser.add_argument("--target-favorites", type=int, default=1000)
    parser.add_argument("--max-scroll-steps", type=int, default=240)
    parser.add_argument("--low-delta-threshold", type=int, default=5)
    parser.add_argument("--low-delta-batches", type=int, default=2)
    parser.add_argument("--resume", default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.resume:
        run_dir = Path(args.resume).expanduser()
        run_dir.mkdir(parents=True, exist_ok=True)
    else:
        stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        run_dir = Path(args.run_root) / f"{stamp}_high_yield_c_group"
        run_dir.mkdir(parents=True, exist_ok=False)
    start_time = run_dir / "start_time.txt"
    if not start_time.exists():
        start_time.write_text(dt.datetime.now().isoformat(timespec="seconds"))
    (run_dir / "source_config.json").write_text(
        json.dumps(
            {
                "strategy": "high_yield_c_group",
                "sources": HIGH_YIELD_SOURCES,
                "target_favorites": args.target_favorites,
                "c_group": {
                    "FLOW_B_TAB_WORKERS": 4,
                    "FLOW_B_TAB_LOAD_WAIT": 4.5,
                    "FLOW_B_MAX_SCROLL_STEPS": 24,
                    "FLOW_B_SCROLL_RATIO": 0.82,
                    "FLOW_B_SCROLL_DELAY": 0.65,
                    "FLOW_B_MAOZI_AFTER_SCAN_WAIT": 10,
                },
                "low_delta_threshold": args.low_delta_threshold,
                "low_delta_batches": args.low_delta_batches,
                "created_at": dt.datetime.now().isoformat(timespec="seconds"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    print(f"RUN_DIR={run_dir}", flush=True)

    summary = []
    for idx, source in enumerate(HIGH_YIELD_SOURCES, 1):
        scan_dir = run_dir / f"scan_{idx:02d}_{source['key']}"
        scan_dir.mkdir(parents=True, exist_ok=True)
        separator = "&" if "?" in source["url"] else "?"
        scan_url = f"{source['url']}{separator}currency_price={float(source['min_price']):.3f}%3B"
        urls_path = scan_dir / "source_urls.txt"
        urls_path.write_text(scan_url + "\n")
        scan_path = scan_dir / "source_deep_scan_c_group.json"
        scan_env = {
            "FLOW_B_TAB_WORKERS": "4",
            "FLOW_B_TAB_LOAD_WAIT": "4.5",
            "FLOW_B_MAX_SCROLL_STEPS": str(source.get("max_scroll_steps") or args.max_scroll_steps),
            "FLOW_B_SCROLL_RATIO": "0.82",
            "FLOW_B_SCROLL_DELAY": "0.65",
            "FLOW_B_MAOZI_AFTER_SCAN_WAIT": "10",
            "FLOW_B_TARGET_FAVORITES": str(args.target_favorites),
            "FLOW_B_LOW_DELTA_THRESHOLD": str(args.low_delta_threshold),
            "FLOW_B_LOW_DELTA_BATCH_LIMIT": str(args.low_delta_batches),
        }
        scan_cmd = ["node", "scripts/flow_b_playwright.mjs", "scan", str(urls_path), str(scan_path)]
        rc = run(scan_cmd, env=scan_env)
        delta = source_delta(scan_path)
        summary.append({"source": source["key"], "urls": 1, "delta": delta, "scan_rc": rc})
        (run_dir / "high_yield_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
        if rc != 0:
            return rc
    print(f"SUMMARY={run_dir / 'high_yield_summary.json'}", flush=True)
    print(f"RUN_DIR={run_dir}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
