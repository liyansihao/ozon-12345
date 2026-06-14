#!/usr/bin/env python3
"""Open scanned Ozon product pages so Maozi can add them to favorites."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse


OZON_BASE = "https://www.ozon.ru"

RISKY_TEXT_PATTERNS = [
    r"\bpuma\b",
    r"\bsokolov\b",
    r"\blenovo\b",
    r"\bbosch\b",
    r"\bpandora\b",
    r"\bzippo\b",
    r"\biphone\b",
    r"\bthinkpad\b",
    r"бейсболк",
    r"кроссов",
    r"футболк",
    r"трус",
    r"часы",
    r"кольцо",
    r"золото",
    r"ювелир",
    r"листья нори",
    r"кофе",
    r"чай",
    r"еда",
    r"каркас лестниц",
    r"косоур",
    r"планкен",
]


def normalize_product_url(url: str) -> str | None:
    full = urljoin(OZON_BASE, url)
    parsed = urlparse(full)
    if parsed.netloc and "ozon.ru" not in parsed.netloc:
        return None
    if "/product/" not in parsed.path:
        return None
    path = parsed.path
    if not path.endswith("/"):
        path += "/"
    return urlunparse(("https", "www.ozon.ru", path, "", "", ""))


def is_risky_text(text: str) -> bool:
    lower = (text or "").lower()
    return any(re.search(pattern, lower) for pattern in RISKY_TEXT_PATTERNS)


def load_product_links(scan_path: Path, limit: int) -> list[dict]:
    records = json.loads(scan_path.read_text(encoding="utf-8"))
    rows: list[dict] = []
    seen: set[str] = set()
    for record in records:
        source_url = record.get("source_url") or record.get("final_url") or ""
        for link in record.get("links") or []:
            url = normalize_product_url(link.get("href") or "")
            if not url or url in seen:
                continue
            text = link.get("text") or ""
            if is_risky_text(text):
                continue
            seen.add(url)
            rows.append({"url": url, "text": text, "source_url": source_url})
            if len(rows) >= limit:
                return rows
    return rows


def run_js(js: str, timeout: int = 120) -> str:
    script = """
on run argv
  set js_code to item 1 of argv
  with timeout of 120 seconds
    tell application "Google Chrome"
      if (count of windows) is 0 then make new window
      tell active tab of front window
        execute javascript js_code
      end tell
    end tell
  end timeout
end run
"""
    proc = subprocess.run(["osascript", "-", js], input=script, text=True, capture_output=True, timeout=timeout + 20)
    if proc.returncode:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip())
    return proc.stdout.strip()


def open_product(url: str, settle_seconds: float) -> dict:
    run_js(f"location.href={json.dumps(url)}; 'navigating';")
    time.sleep(settle_seconds)
    raw = run_js(
        """
JSON.stringify((() => {
  const text = String(document.body && document.body.innerText || '');
  return {
    url: String(location.href),
    title: String(document.title || ''),
    blocked: /Доступ ограничен|Access denied|captcha|Похоже, нет/i.test(String(document.title || '') + ' ' + text),
    hasMaoziPanel: /毛子ERP|计算利润|一键上架|选品|跟卖/i.test(text)
  };
})())
"""
    )
    return json.loads(raw)


def read_existing_progress(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def append_progress(path: Path, row: dict) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Open product links from source_deep_scan.json to seed Maozi favorites.")
    parser.add_argument("batch_dir")
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--delay", type=float, default=5.0)
    parser.add_argument("--scan-file", default="source_deep_scan.json")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    batch = Path(args.batch_dir).resolve()
    scan_path = batch / args.scan_file
    progress_path = batch / "seed_favorites_from_scan.jsonl"
    rows = load_product_links(scan_path, limit=args.limit)
    done = {row.get("url") for row in read_existing_progress(progress_path) if row.get("ok")}
    opened = 0
    for idx, row in enumerate(rows, 1):
        if row["url"] in done:
            continue
        print(f"seed [{idx}/{len(rows)}] opened={opened} {row['url']}", flush=True)
        result = {**row, "ok": False}
        try:
            state = open_product(row["url"], settle_seconds=args.delay)
            result.update(state)
            result["ok"] = not state.get("blocked")
        except Exception as exc:
            result["error"] = str(exc)
        append_progress(progress_path, result)
        opened += 1
    print(f"SEED_OPENED={opened}", flush=True)
    print(f"SEED_PROGRESS={progress_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
