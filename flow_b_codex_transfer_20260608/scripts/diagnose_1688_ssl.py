#!/usr/bin/env python3
"""Run an Ozon-free, instrumented 1688 cost-query baseline.

This diagnostic uses the production synchronous 1688 implementation and cost
reliability rules. It records request stages and session reuse without logging
proxy values, cookies, request bodies, or image data.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import statistics
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import requests


ROOT = Path(__file__).resolve().parents[1]
SYNC_SCRIPT = ROOT / "scripts" / "flow_b_1688_sync.py"
WORKER_SCRIPT = ROOT / "scripts" / "flow_b_1688_worker.py"
H5_ENDPOINT = "https://h5api.m.1688.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/"


def load_module(name: str, filename: Path):
    spec = importlib.util.spec_from_file_location(name, filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load module: {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SYNC = load_module("flow_b_1688_sync_diagnostic", SYNC_SCRIPT)
WORKER = load_module("flow_b_1688_worker_diagnostic", WORKER_SCRIPT)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def exception_chain(exc: BaseException) -> str:
    rows = []
    seen = set()
    current = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        rows.append(f"{type(current).__name__}: {current}")
        current = current.__cause__ or current.__context__
    return " <- ".join(rows)


def is_ssl_eof(value: object) -> bool:
    text = str(value or "").lower()
    return "unexpected_eof_while_reading" in text or "eof occurred in violation of protocol" in text


def request_stage(method: str, url: str, kwargs: dict) -> str:
    parsed = urlsplit(str(url))
    host = parsed.hostname or ""
    query_keys = {key for key, _value in parse_qsl(parsed.query, keep_blank_values=True)}
    params = kwargs.get("params")
    if isinstance(params, dict):
        query_keys.update(str(key) for key in params)
    if host == "h5api.m.1688.com":
        if method.upper() == "POST":
            return "image-upload"
        if "sign" in query_keys or "data" in query_keys:
            return "offer-list"
        return "session-token-init"
    if host == "pages-fast.1688.com":
        return "image-search-target-page"
    if host in {"www.1688.com", "s.1688.com", "login.1688.com"}:
        return "cookie-bootstrap"
    return "other"


def safe_address(url: str, kwargs: dict) -> tuple[str, list[str]]:
    parsed = urlsplit(str(url))
    query_keys = {key for key, _value in parse_qsl(parsed.query, keep_blank_values=True)}
    params = kwargs.get("params")
    if isinstance(params, dict):
        query_keys.update(str(key) for key in params)
    address = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
    return address, sorted(query_keys)


class Timeline:
    def __init__(self, filename: Path):
        self.filename = filename
        filename.parent.mkdir(parents=True, exist_ok=True)
        self.handle = filename.open("a", encoding="utf-8")

    def write(self, event: str, **payload):
        row = {"at": utc_now(), "event": event, **payload}
        self.handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
        self.handle.flush()

    def close(self):
        self.handle.close()


def make_session_class(base_class, timeline: Timeline, trust_env: bool | None):
    class InstrumentedSession(base_class):
        def __init__(self, debug=False):
            super().__init__(debug=debug)
            if trust_env is not None:
                self.trust_env = trust_env
            self.session_id = uuid.uuid4().hex[:12]
            self.query_index = None
            self.sku = None
            self.host_request_counts = {}
            self.close_count = 0
            proxy_keys = sorted(requests.utils.get_environ_proxies(H5_ENDPOINT)) if self.trust_env else []
            timeline.write(
                "session_created",
                session_id=self.session_id,
                trust_env=self.trust_env,
                environment_proxy_keys=proxy_keys,
            )

        def request(self, method, url, **kwargs):
            address, query_keys = safe_address(url, kwargs)
            host = urlsplit(str(url)).hostname or ""
            host_index = self.host_request_counts.get(host, 0) + 1
            self.host_request_counts[host] = host_index
            stage = request_stage(method, url, kwargs)
            started = time.monotonic()
            timeline.write(
                "request_started",
                query_index=self.query_index,
                sku=self.sku,
                session_id=self.session_id,
                method=str(method).upper(),
                address=address,
                query_keys=query_keys,
                stage=stage,
                session_reused=self.query_index is not None and self.query_index > 1,
                host_seen_in_session=host_index > 1,
                host_request_index=host_index,
                trust_env=self.trust_env,
            )
            try:
                response = super().request(method, url, **kwargs)
            except Exception as exc:
                duration_ms = round((time.monotonic() - started) * 1000)
                chain = exception_chain(exc)
                timeline.write(
                    "request_finished",
                    query_index=self.query_index,
                    sku=self.sku,
                    session_id=self.session_id,
                    method=str(method).upper(),
                    address=address,
                    stage=stage,
                    ok=False,
                    duration_ms=duration_ms,
                    ssl_eof=is_ssl_eof(chain),
                    error=chain,
                    host_request_index=host_index,
                )
                raise
            duration_ms = round((time.monotonic() - started) * 1000)
            timeline.write(
                "request_finished",
                query_index=self.query_index,
                sku=self.sku,
                session_id=self.session_id,
                method=str(method).upper(),
                address=address,
                stage=stage,
                ok=True,
                status_code=response.status_code,
                duration_ms=duration_ms,
                ssl_eof=False,
                host_request_index=host_index,
            )
            return response

        def close(self):
            self.close_count += 1
            timeline.write(
                "session_closed",
                query_index=self.query_index,
                sku=self.sku,
                session_id=getattr(self, "session_id", None),
                close_count=self.close_count,
            )
            return super().close()

    return InstrumentedSession


def load_fixtures(source_runs: list[Path], skus: list[str]) -> list[dict]:
    favorites = {}
    images = {}
    for source_run in source_runs:
        favorite_file = source_run / "favorite_collection.jsonl"
        for line in favorite_file.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            sku = str(row.get("sku") or "")
            image = source_run / "images" / f"{sku}.jpg"
            if sku in skus and row.get("status") == "favorited" and image.is_file():
                favorites.setdefault(sku, row)
                images.setdefault(sku, image)
    fixtures = []
    for sku in skus:
        row = favorites.get(sku)
        image = images.get(sku)
        if row is None or image is None:
            raise FileNotFoundError(f"Missing saved fixture for SKU {sku}")
        fixtures.append({
            "sku": sku,
            "image": str(image.resolve()),
            "expect_title": str(row.get("title") or ""),
            "expect_category": "",
            "top": 10,
        })
    return fixtures


def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(len(ordered) * quantile) - 1)
    return ordered[index]


def write_historical_snapshot(source_run: Path, output_dir: Path):
    timings = []
    for line in (source_run / "stage_timings.jsonl").read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("stage") == "1688_cost":
            timings.append(row)
    skipped = {}
    for line in (source_run / "skipped.jsonl").read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("data", {}).get("reason") == "1688-no-reliable-match":
            skipped[str(row.get("sku"))] = row
    destination = output_dir / "historical_v95_timeline.jsonl"
    with destination.open("w", encoding="utf-8") as handle:
        for row in timings:
            sku = str(row.get("sku"))
            ended = datetime.fromisoformat(str(row["at"]).replace("Z", "+00:00"))
            started = ended - timedelta(milliseconds=float(row.get("duration_ms") or 0))
            outcome = skipped.get(sku, {})
            cost = outcome.get("data", {}).get("cost", {})
            output_path = Path(str(cost.get("outputPath") or ""))
            raw = output_path.read_text(encoding="utf-8") if output_path.is_file() else ""
            evidence = {
                "source_run": str(source_run.resolve()),
                "sku": sku,
                "started_at": started.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "ended_at": ended.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "duration_ms": row.get("duration_ms"),
                "request_address": H5_ENDPOINT,
                "failure_stage": "session-token-init" if "Session initialization error" in raw else None,
                "ssl_eof": is_ssl_eof(raw),
                "process_code": cost.get("process_code"),
                "cache_reused": cost.get("shared_cache") is True,
                "retry_count": 0,
                "retry_interval_ms": [],
                "session_reuse_observed": None,
                "session_reuse_note": "v95 did not log worker identity; worker code resets session after every exception",
                "final_reason": cost.get("reason"),
            }
            handle.write(json.dumps(evidence, ensure_ascii=False, sort_keys=True) + "\n")


def run(args) -> dict:
    source_runs = [Path(value).expanduser().resolve() for value in args.source_run]
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    for source_run in source_runs:
        historical_dir = output_dir / f"historical_{source_run.name}"
        historical_dir.mkdir(parents=True, exist_ok=True)
        write_historical_snapshot(source_run, historical_dir)
    timeline = Timeline(output_dir / "timeline.jsonl")
    base_class = SYNC.load_sync_session_class()
    trust_env_override = {"inherit": True, "direct": False, "production": None}[args.trust_env]
    session_class = make_session_class(base_class, timeline, trust_env_override)

    def new_session():
        if args.trust_env != "production":
            created = session_class()
        else:
            original_loader = SYNC.load_sync_session_class
            SYNC.load_sync_session_class = lambda: session_class
            try:
                created = SYNC.load_session()
            finally:
                SYNC.load_sync_session_class = original_loader
        timeline.write(
            "session_configured",
            session_id=created.session_id,
            trust_env=created.trust_env,
            configuration=args.trust_env,
        )
        return created
    fixtures = load_fixtures(source_runs, [part.strip() for part in args.skus.split(",") if part.strip()])
    rows = []
    session = None
    timeline.write(
        "diagnostic_started",
        phase=args.phase,
        count=args.count,
        session_policy=args.session_policy,
        trust_env=args.trust_env,
        production_retry_layers={"python_worker": 0, "cost_bridge_code1": 0},
    )
    try:
        for index in range(1, args.count + 1):
            fixture = fixtures[(index - 1) % len(fixtures)]
            reused = session is not None
            if args.session_policy == "fresh" or session is None:
                session = new_session()
            session.query_index = index
            session.sku = fixture["sku"]
            started_at = utc_now()
            started = time.monotonic()
            timeline.write(
                "query_started",
                query_index=index,
                sku=fixture["sku"],
                session_id=session.session_id,
                session_reused=reused,
                retry_count=0,
            )
            error = ""
            result = None
            recovery = {"retry_count": 0, "retry_intervals_ms": [], "session_rebuilt": False}
            initial_session_id = session.session_id

            def load_for_retry():
                rebuilt = new_session()
                rebuilt.query_index = index
                rebuilt.sku = fixture["sku"]
                return rebuilt

            try:
                result, session, recovery = WORKER.analyze_with_transient_recovery(
                    SYNC,
                    session,
                    fixture,
                    load_session=load_for_retry,
                    max_retries=args.max_retries,
                    base_delay_seconds=args.retry_base_seconds,
                    max_jitter_seconds=args.retry_jitter_seconds,
                    total_budget_seconds=args.retry_budget_seconds,
                )
            except Exception as exc:
                error = exception_chain(exc)
                recovery = getattr(exc, "flow_b_recovery", recovery)
                session = None
            duration_ms = round((time.monotonic() - started) * 1000)
            reliable = bool(result and result.get("p70_cost") is not None)
            row = {
                "query_index": index,
                "sku": fixture["sku"],
                "started_at": started_at,
                "ended_at": utc_now(),
                "duration_ms": duration_ms,
                "session_id": session.session_id if session is not None else initial_session_id,
                "session_reused": reused,
                "retry_count": recovery["retry_count"],
                "retry_intervals_ms": recovery["retry_intervals_ms"],
                "session_rebuilt": recovery["session_rebuilt"],
                "reliable_cost": reliable,
                "p70_cost": result.get("p70_cost") if result else None,
                "reason": result.get("reason") if result else "",
                "ssl_eof": is_ssl_eof(error),
                "error": error,
            }
            rows.append(row)
            timeline.write("query_finished", **row)
            if args.session_policy == "fresh" and session is not None:
                session.close()
                session = None
    finally:
        if session is not None:
            session.close()
        timeline.write("diagnostic_finished", phase=args.phase, query_count=len(rows))
        timeline.close()

    durations = [row["duration_ms"] for row in rows]
    summary = {
        "phase": args.phase,
        "source_runs": [str(source_run) for source_run in source_runs],
        "query_count": len(rows),
        "session_policy": args.session_policy,
        "trust_env": args.trust_env,
        "reliable_cost_success_count": sum(row["reliable_cost"] for row in rows),
        "reliable_cost_success_rate": sum(row["reliable_cost"] for row in rows) / len(rows) if rows else 0,
        "ssl_eof_count": sum(row["ssl_eof"] for row in rows),
        "ssl_eof_rate": sum(row["ssl_eof"] for row in rows) / len(rows) if rows else 0,
        "p50_ms": percentile(durations, 0.50),
        "p95_ms": percentile(durations, 0.95),
        "average_ms": statistics.mean(durations) if durations else None,
        "average_retry_count": statistics.mean(row["retry_count"] for row in rows) if rows else 0,
        "rows": rows,
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({key: value for key, value in summary.items() if key != "rows"}, ensure_ascii=False, indent=2))
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-run", required=True, action="append")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--phase", required=True)
    parser.add_argument("--skus", default="2485449252,3330156278,3799335357")
    parser.add_argument("--count", type=int, default=3)
    parser.add_argument("--session-policy", choices=("worker", "fresh"), default="worker")
    parser.add_argument("--trust-env", choices=("inherit", "direct", "production"), default="inherit")
    parser.add_argument("--max-retries", type=int, default=0)
    parser.add_argument("--retry-base-seconds", type=float, default=0.5)
    parser.add_argument("--retry-jitter-seconds", type=float, default=0.25)
    parser.add_argument("--retry-budget-seconds", type=float, default=45.0)
    args = parser.parse_args()
    if args.count < 1:
        parser.error("--count must be positive")
    run(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
