#!/usr/bin/env python3
"""Find and scan high-yield Ozon China highlight seller sources with C-group pacing."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parents[1]
RUN_ROOT = ROOT / "runs" / "flow_b"

HIGH_YIELD_SOURCES = [
    {
        "key": "models_min50",
        "url": "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?category=13812",
        "min_price": 50,
        "max_scroll_steps": 150,
    },
    {
        "key": "models_min500",
        "url": "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?category=13812",
        "min_price": 500,
        "max_scroll_steps": 150,
    },
    {
        "key": "kids_toys_segment_min50",
        "url": "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?category=7000",
        "min_price": 50,
        "max_scroll_steps": 150,
        "skip_fresh_first": 28,
    },
    {
        "key": "electronics_min500",
        "url": "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?category=15500",
        "min_price": 500,
    },
    {
        "key": "electronics_min50",
        "url": "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/?category=15500",
        "min_price": 50,
    },
]


def seller_key(url: str) -> str:
    parsed = urlparse(url)
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) >= 2 and parts[0] == "seller":
        return f"seller/{parts[1]}"
    return parsed.path.rstrip("/")


def normalize_seller_url(url: str, min_price: float = 50) -> str:
    parsed = urlparse(url)
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) >= 2 and parts[0] == "seller":
        return urlunparse(("https", "www.ozon.ru", f"/seller/{parts[1]}/", "", f"currency_price={float(min_price):.3f}%3B", ""))
    return url


def run(cmd: list[str], env: dict[str, str] | None = None) -> int:
    print("+", " ".join(cmd), flush=True)
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    proc = subprocess.run(cmd, cwd=ROOT, env=merged_env)
    return proc.returncode


def scanned_seller_keys(exclude_run: Path | None = None) -> set[str]:
    keys: set[str] = set()
    for path in RUN_ROOT.glob("**/source_deep_scan*.json"):
        if exclude_run and exclude_run in path.parents:
            continue
        try:
            data = json.loads(path.read_text())
        except Exception:
            continue
        if not isinstance(data, list):
            continue
        for row in data:
            url = row.get("source_url")
            if url and row.get("stop_reason") != "checkpoint":
                keys.add(seller_key(url))
    return keys


def read_source_urls(path: Path) -> list[str]:
    if not path.exists():
        return []
    return [line.strip() for line in path.read_text().splitlines() if line.strip()]


def filter_fresh_urls(source_urls: list[str], blocked_keys: set[str]) -> list[str]:
    fresh: list[str] = []
    seen: set[str] = set()
    for url in source_urls:
        key = seller_key(url)
        if key in blocked_keys or key in seen:
            continue
        fresh.append(normalize_seller_url(url, min_price=50))
        seen.add(key)
    return fresh


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
    parser.add_argument("--seller-limit", type=int, default=120)
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

    blocked = scanned_seller_keys(exclude_run=run_dir)
    scanned_in_run: set[str] = set()
    summary = []
    for idx, source in enumerate(HIGH_YIELD_SOURCES, 1):
        find_dir = run_dir / f"find_{idx:02d}_{source['key']}"
        find_cmd = [
            sys.executable,
            "scripts/flow_b_find_seller_sources.py",
            "--highlight-url",
            source["url"],
            "--min-price",
            str(source["min_price"]),
            "--limit",
            str(args.seller_limit),
            "--max-scroll-steps",
            str(source.get("max_scroll_steps") or args.max_scroll_steps),
            "--resume",
            str(find_dir),
        ]
        if run(find_cmd) != 0:
            print(f"WARN=find failed for {source['key']}", flush=True)
            continue

        urls = read_source_urls(find_dir / "source_urls.txt")
        fresh = filter_fresh_urls(urls, blocked | scanned_in_run)
        skip_fresh_first = int(source.get("skip_fresh_first") or 0)
        if skip_fresh_first:
            fresh = fresh[skip_fresh_first:]
        fresh_path = find_dir / "source_urls_fresh_pathdedupe.txt"
        fresh_path.write_text("\n".join(fresh) + ("\n" if fresh else ""))
        print(f"{source['key']} sellers={len(urls)} fresh={len(fresh)} skipped_fresh={skip_fresh_first}", flush=True)
        if not fresh:
            summary.append({"source": source["key"], "sellers": len(urls), "fresh": 0, "delta": 0})
            continue

        scan_path = find_dir / "source_deep_scan_c_group.json"
        scan_env = {
            "FLOW_B_TAB_WORKERS": "4",
            "FLOW_B_TAB_LOAD_WAIT": "4.5",
            "FLOW_B_MAX_SCROLL_STEPS": "24",
            "FLOW_B_SCROLL_RATIO": "0.82",
            "FLOW_B_SCROLL_DELAY": "0.65",
            "FLOW_B_MAOZI_AFTER_SCAN_WAIT": "10",
            "FLOW_B_TARGET_FAVORITES": str(args.target_favorites),
            "FLOW_B_LOW_DELTA_THRESHOLD": str(args.low_delta_threshold),
            "FLOW_B_LOW_DELTA_BATCH_LIMIT": str(args.low_delta_batches),
        }
        scan_cmd = [sys.executable, "scripts/flow_b_rescan_sources_multitab.py", str(fresh_path), str(scan_path)]
        rc = run(scan_cmd, env=scan_env)
        delta = source_delta(scan_path)
        for url in fresh:
            scanned_in_run.add(seller_key(url))
        summary.append({"source": source["key"], "sellers": len(urls), "fresh": len(fresh), "delta": delta, "scan_rc": rc})
        (run_dir / "high_yield_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
        if rc != 0:
            return rc
    print(f"SUMMARY={run_dir / 'high_yield_summary.json'}", flush=True)
    print(f"RUN_DIR={run_dir}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
