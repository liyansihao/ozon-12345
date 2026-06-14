#!/usr/bin/env python3
"""Build Flow B candidate rows from product links in source_deep_scan.json."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse


OZON_BASE = "https://www.ozon.ru"


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


def sku_from_url(url: str) -> str | None:
    match = re.search(r"-(\d{6,})(?:/|$)", url) or re.search(r"/product/(\d{6,})(?:/|$)", url)
    return match.group(1) if match else None


def parse_cny_price(value: str) -> float | None:
    text = value.replace("\u00a0", " ").replace("\u202f", " ").replace("\u2009", " ")
    match = re.search(r"([0-9][0-9\s.,]*)\s*¥", text)
    if not match:
        return None
    raw = match.group(1).replace(" ", "")
    if "," in raw and "." in raw:
        raw = raw.replace(",", "")
    elif "," in raw:
        raw = raw.replace(",", ".")
    try:
        price = float(raw)
    except ValueError:
        return None
    return round(price, 2) if price > 0 else None


def extract_sell_price(text: str) -> float | None:
    before_panel = re.split(r"选品标签|SKU：|rFBS佣金|发货模式", text, maxsplit=1)[0]
    lines = [line.strip() for line in before_panel.splitlines() if line.strip()]
    for line in lines:
        if "¥" not in line or "₽" in line:
            continue
        if any(skip in line.lower() for skip in ["черн", "банками", "другими", "продавцов"]):
            continue
        price = parse_cny_price(line)
        if price:
            return price
    return None


def extract_title(snapshot: dict) -> str:
    title = str(snapshot.get("product_title") or snapshot.get("title") or "").strip()
    title = re.sub(r"\s*купить на OZON.*$", "", title).strip()
    if title:
        return title
    text = str(snapshot.get("text") or "")
    for line in text.splitlines():
        line = line.strip()
        if len(line) > 10 and not re.search(r"^(Артикул|Распродажа|Каталог|Везде)$", line):
            return line
    return ""


def candidate_from_snapshot(snapshot: dict) -> dict:
    text = str(snapshot.get("text") or "")
    url = str(snapshot.get("url") or "")
    sku = (
        re.search(r"SKU[：:]\s*(\d{6,})", text)
        or re.search(r"Артикул:\s*(\d{6,})", text)
        or (re.search(r"(\d{6,})", sku_from_url(url) or "") if sku_from_url(url) else None)
    )
    if not sku:
        raise ValueError(f"could not extract sku from {url}")
    price = extract_sell_price(text)
    if price is None:
        raise ValueError(f"could not extract CNY sell price for {sku.group(1)}")
    weight_match = re.search(r"重\s*量[：:]\s*([0-9]+)\s*g", text, re.I)
    mode_match = re.search(r"发货模式[：:]\s*([A-Z,\s]+)", text)
    sku_value = int(sku.group(1))
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    return {
        "id": -sku_value,
        "uid": "source_deep_scan",
        "title": extract_title(snapshot),
        "sku": sku_value,
        "sell_price": price,
        "cover_image": snapshot.get("cover_image") or "",
        "rule_id": None,
        "rule_name": "source_deep_scan",
        "rule_tag": "source_deep_scan",
        "is_imported": 0,
        "create_time": now,
        "update_time": now,
        "weight": int(weight_match.group(1)) if weight_match else 900,
        "mode": mode_match.group(1).replace(" ", "").strip() if mode_match else None,
        "detail_url": f"https://www.ozon.ru/product/{sku_value}/",
        "source": "source_deep_scan",
    }


def load_scan_links(scan_path: Path, limit: int) -> list[dict]:
    records = json.loads(scan_path.read_text(encoding="utf-8"))
    rows: list[dict] = []
    seen: set[str] = set()
    for record in records:
        for link in record.get("links") or []:
            url = normalize_product_url(link.get("href") or "")
            if not url or url in seen:
                continue
            seen.add(url)
            rows.append({"url": url, "source_url": record.get("source_url"), "source_text": link.get("text") or ""})
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


def snapshot_product(url: str, settle_seconds: float) -> dict:
    run_js(f"location.href={json.dumps(url)}; 'navigating';")
    time.sleep(settle_seconds)
    raw = run_js(
        """
JSON.stringify((() => {
  const text = String(document.body && document.body.innerText || '');
  const og = document.querySelector('meta[property="og:image"]')?.content || '';
  const largest = Array.from(document.images || [])
    .map(img => ({src: img.currentSrc || img.src || '', area: (img.naturalWidth || 0) * (img.naturalHeight || 0)}))
    .filter(x => x.src.includes('ir.ozone.ru'))
    .sort((a, b) => b.area - a.area)[0];
  const h1 = document.querySelector('h1')?.innerText || '';
  return {
    url: String(location.href),
    title: String(document.title || ''),
    product_title: h1,
    text,
    cover_image: og || (largest && largest.src) || '',
    blocked: /Доступ ограничен|Access denied|captcha/i.test(String(document.title || '') + ' ' + text)
  };
})())
"""
    )
    return json.loads(raw)


def read_done(progress_path: Path) -> dict[str, dict]:
    if not progress_path.exists():
        return {}
    rows = [json.loads(line) for line in progress_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return {str(row.get("url")): row for row in rows if row.get("ok")}


def append_jsonl(path: Path, row: dict) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Enrich source_deep_scan product links into Flow B candidate rows.")
    parser.add_argument("batch_dir")
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--delay", type=float, default=5.0)
    parser.add_argument("--scan-file", default="source_deep_scan.json")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    batch = Path(args.batch_dir).resolve()
    progress_path = batch / "source_candidate_enrich.jsonl"
    output_path = batch / "source_candidates.json"
    rows = load_scan_links(batch / args.scan_file, args.limit)
    done = read_done(progress_path)
    candidates = [row["candidate"] for row in done.values() if row.get("candidate")]
    seen_skus = {str(row.get("sku")) for row in candidates}
    opened = 0
    for idx, row in enumerate(rows, 1):
        if row["url"] in done:
            continue
        print(f"enrich [{idx}/{len(rows)}] opened={opened} {row['url']}", flush=True)
        result = {**row, "ok": False}
        try:
            snapshot = snapshot_product(row["url"], args.delay)
            result["snapshot"] = {k: v for k, v in snapshot.items() if k != "text"}
            if snapshot.get("blocked"):
                result["error"] = "blocked"
            else:
                candidate = candidate_from_snapshot(snapshot)
                if str(candidate["sku"]) not in seen_skus:
                    candidates.append(candidate)
                    seen_skus.add(str(candidate["sku"]))
                result["candidate"] = candidate
                result["ok"] = True
        except Exception as exc:
            result["error"] = str(exc)
        append_jsonl(progress_path, result)
        opened += 1
        output_path.write_text(json.dumps(candidates, ensure_ascii=False, indent=2), encoding="utf-8")
    output_path.write_text(json.dumps(candidates, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"SOURCE_CANDIDATES={output_path}", flush=True)
    print(f"SOURCE_CANDIDATE_COUNT={len(candidates)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
