#!/usr/bin/env python3
"""Collect Ozon seller source URLs from the China goods highlight page."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse


DEFAULT_HIGHLIGHT_URL = "https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/"
OZON_BASE = "https://www.ozon.ru"


def parse_price_text(text: str) -> float | None:
    """Parse Ozon RMB display price such as '5 758,60 ¥'."""
    normalized = (text or "").replace("\u00a0", " ").replace("\u202f", " ").replace("\u2009", " ")
    match = re.search(r"([0-9][0-9\s]*)(?:,(\d{1,2}))?\s*¥", normalized)
    if not match:
        return None
    whole = match.group(1).replace(" ", "")
    frac = (match.group(2) or "0").ljust(2, "0")
    try:
        return float(f"{whole}.{frac}")
    except ValueError:
        return None


def price_is_allowed(text: str, min_price: float) -> bool:
    price = parse_price_text(text)
    return price is not None and price >= min_price


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


def normalize_seller_url(url: str, min_price: float = 50) -> str | None:
    full = urljoin(OZON_BASE, url)
    parsed = urlparse(full)
    if parsed.netloc and "ozon.ru" not in parsed.netloc:
        return None
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2 or parts[0] != "seller":
        return None
    path = f"/seller/{parts[1]}/"
    query = f"currency_price={float(min_price):.3f}%3B"
    return urlunparse(("https", "www.ozon.ru", path, "", query, ""))


def run_js(js: str, timeout: int = 180) -> str:
    script = """
on run argv
  set js_code to item 1 of argv
  with timeout of 180 seconds
    tell application "Google Chrome"
      if (count of windows) is 0 then make new window
      tell active tab of front window
        execute javascript js_code
      end tell
    end tell
  end timeout
end run
"""
    last_error = ""
    for attempt in range(3):
        proc = subprocess.run(
            ["osascript", "-", js],
            input=script,
            text=True,
            capture_output=True,
            timeout=timeout + 30,
        )
        if proc.returncode == 0:
            return proc.stdout.strip()
        last_error = proc.stderr.strip() or proc.stdout.strip()
        if "-1712" not in last_error and "超时" not in last_error:
            break
        time.sleep(2 + attempt * 2)
    raise RuntimeError(last_error)


def wait_for_page(seconds: float = 5.0) -> None:
    time.sleep(seconds)


def price_filter_url(highlight_url: str, min_price: float) -> str:
    parsed = urlparse(highlight_url)
    query = f"currency_price={float(min_price):.3f}%3B"
    return urlunparse((parsed.scheme or "https", parsed.netloc or "www.ozon.ru", parsed.path, "", query, ""))


def open_highlight_and_set_price(highlight_url: str, min_price: float) -> dict:
    filtered_url = price_filter_url(highlight_url, min_price)
    run_js(f"location.href={json.dumps(filtered_url)}; 'navigating';")
    wait_for_page(8)
    raw = run_js(
        f"""
JSON.stringify((() => {{
  const minPrice = {json.dumps(str(int(min_price) if float(min_price).is_integer() else min_price))};
  const inputs = Array.from(document.querySelectorAll('input')).filter(input => {{
    const rect = input.getBoundingClientRect();
    return rect.width > 20 && rect.height > 10 && rect.left < Math.min(700, innerWidth * 0.45);
  }});
  const numeric = inputs.filter(input => /[0-9]/.test(String(input.value || input.placeholder || '')));
  const target = numeric[0] || inputs[0] || null;
  if (target) {{
    target.focus();
    target.value = minPrice;
    target.dispatchEvent(new Event('input', {{bubbles:true}}));
    target.dispatchEvent(new Event('change', {{bubbles:true}}));
    target.dispatchEvent(new KeyboardEvent('keydown', {{key:'Enter', code:'Enter', bubbles:true}}));
    target.blur();
  }}
  return {{
    url: String(location.href),
    title: String(document.title || ''),
    changedInput: Boolean(target),
    visibleInputCount: inputs.length,
    numericInputCount: numeric.length,
    bodyText: String(document.body && document.body.innerText || '').slice(0, 500)
  }};
}})())
"""
    )
    wait_for_page(3)
    return json.loads(raw)


def collect_visible_products(min_price: float) -> list[dict]:
    raw = run_js(
        """
JSON.stringify((() => {
  const anchors = Array.from(document.querySelectorAll('a[href*="/product/"]'));
  const rows = [];
  const seen = new Set();
  function closestCard(anchor) {
    const tile = anchor.closest('div[class*="tile-root"]');
    if (tile) return tile;
    let node = anchor;
    for (let i = 0; i < 5 && node; i++) {
      const text = String(node.innerText || '');
      if (text.includes('¥')) return node;
      node = node.parentElement;
    }
    return anchor;
  }
  for (const a of anchors) {
    const href = String(a.href || '').split('?')[0];
    if (!href.includes('/product/') || seen.has(href)) continue;
    const card = closestCard(a);
    const text = String(card.innerText || a.innerText || '').trim();
    rows.push({href, text: text.slice(0, 1200)});
    seen.add(href);
  }
  return rows;
})())
"""
    )
    rows = json.loads(raw)
    products = []
    for row in rows:
        url = normalize_product_url(row.get("href") or "")
        if not url:
            continue
        text = row.get("text") or ""
        price = parse_price_text(text)
        if price is None or price < min_price:
            continue
        products.append({"product_url": url, "price": price, "text": text[:240]})
    return products


def blocked_or_empty_state() -> dict:
    raw = run_js(
        """
JSON.stringify((() => {
  const text = String(document.body && document.body.innerText || '');
  return {
    url: String(location.href),
    title: String(document.title || ''),
    text: text.slice(0, 600),
    blocked: /Доступ ограничен|Access denied|captcha|Похоже, нет/i.test(String(document.title || '') + ' ' + text)
  };
})())
"""
    )
    return json.loads(raw)


def collect_highlight_products(min_price: float, need_count: int, max_scroll_steps: int = 180) -> list[dict]:
    by_url: dict[str, dict] = {}
    stable_rounds = 0
    last_count = 0
    last_y = -1
    last_height = 0
    for step in range(max_scroll_steps):
        state = blocked_or_empty_state()
        if state.get("blocked"):
            raise RuntimeError(f"Ozon page blocked or empty: {state.get('title')} {state.get('url')}")
        for product in collect_visible_products(min_price):
            by_url.setdefault(product["product_url"], product)
        if len(by_url) >= need_count:
            break
        raw = run_js(
            """
JSON.stringify((() => {
  const y = Math.round(scrollY);
  const height = document.body.scrollHeight;
  const viewport = innerHeight;
  window.scrollBy(0, Math.max(450, Math.floor(innerHeight * 0.85)));
  return {y, height, viewport};
})())
"""
        )
        pos = json.loads(raw)
        y = int(pos.get("y") or 0)
        height = int(pos.get("height") or 0)
        viewport = int(pos.get("viewport") or 0)
        near_bottom = y + viewport >= height - 120
        unchanged = len(by_url) == last_count and abs(y - last_y) < 30 and abs(height - last_height) < 30 and near_bottom
        stable_rounds = stable_rounds + 1 if unchanged else 0
        if step % 10 == 0:
            print(f"highlight step={step} products={len(by_url)} y={y} h={height}", flush=True)
        if stable_rounds >= 8:
            break
        last_count = len(by_url)
        last_y = y
        last_height = height
        time.sleep(1.0)
    return list(by_url.values())


def extract_seller_from_current_product(min_price: float) -> dict:
    for _ in range(8):
        raw = run_js(
            """
JSON.stringify((() => {
  const links = Array.from(document.querySelectorAll('a[href*="/seller/"]')).map(a => ({
    href: String(a.href || ''),
    text: String(a.innerText || a.title || '').trim().slice(0, 200)
  }));
  const body = String(document.body && document.body.innerText || '');
  const shopTextSeen = /Магазин|Перейти|О магазине/i.test(body);
  return {
    url: String(location.href),
    title: String(document.title || ''),
    y: Math.round(scrollY),
    height: document.body.scrollHeight,
    links,
    shopTextSeen
  };
})())
"""
        )
        state = json.loads(raw)
        candidates = []
        for link in state.get("links") or []:
            seller = normalize_seller_url(link.get("href") or "", min_price=min_price)
            if seller:
                candidates.append({"seller_url": seller, "seller_text": link.get("text") or ""})
        if candidates:
            return candidates[0]
        run_js("window.scrollBy(0, Math.max(500, Math.floor(innerHeight * 0.8))); 'scrolled';")
        time.sleep(1.0)
    return {"error": "seller link not found"}


def collect_seller_sources(products: list[dict], limit: int, min_price: float) -> list[dict]:
    rows: list[dict] = []
    seen_sellers: set[str] = set()
    for idx, product in enumerate(products, 1):
        if len(seen_sellers) >= limit:
            break
        product_url = product["product_url"]
        print(f"product [{idx}/{len(products)}] sellers={len(seen_sellers)} {product_url}", flush=True)
        result = {"product_url": product_url, "price": product.get("price"), "seller_url": None}
        try:
            run_js(f"location.href={json.dumps(product_url)}; 'navigating';")
            wait_for_page(6)
            seller = extract_seller_from_current_product(min_price=min_price)
            if seller.get("seller_url"):
                result.update(seller)
                if seller["seller_url"] not in seen_sellers:
                    seen_sellers.add(seller["seller_url"])
            else:
                result.update(seller)
        except Exception as exc:
            result["error"] = str(exc)
        rows.append(result)
    return rows


def create_or_resume_run(run_root: Path, resume: str | None, highlight_url: str, min_price: float) -> Path:
    if resume:
        run_dir = Path(resume).expanduser()
        run_dir.mkdir(parents=True, exist_ok=True)
    else:
        stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        run_dir = run_root / f"{stamp}_ozon_highlight_sources"
        run_dir.mkdir(parents=True, exist_ok=False)
    start_path = run_dir / "start_time.txt"
    if not start_path.exists():
        start_path.write_text(dt.datetime.now().isoformat(timespec="seconds"), encoding="utf-8")
    (run_dir / "source_config.json").write_text(
        json.dumps(
            {"highlight_url": highlight_url, "min_price": min_price, "created_at": dt.datetime.now().isoformat(timespec="seconds")},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return run_dir


def write_outputs(run_dir: Path, seller_rows: list[dict], product_rows: list[dict]) -> list[str]:
    sellers: list[str] = []
    seen: set[str] = set()
    for row in seller_rows:
        seller = row.get("seller_url")
        if seller and seller not in seen:
            sellers.append(seller)
            seen.add(seller)
    (run_dir / "source_urls.txt").write_text("\n".join(sellers) + ("\n" if sellers else ""), encoding="utf-8")
    (run_dir / "seller_sources.json").write_text(json.dumps(seller_rows, ensure_ascii=False, indent=2), encoding="utf-8")
    (run_dir / "highlight_products.json").write_text(json.dumps(product_rows, ensure_ascii=False, indent=2), encoding="utf-8")
    return sellers


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Find Ozon seller source links from the China goods highlight page.")
    parser.add_argument("--highlight-url", default=DEFAULT_HIGHLIGHT_URL)
    parser.add_argument("--min-price", type=float, default=50)
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--run-root", default="runs/flow_b")
    parser.add_argument("--resume", default=None)
    parser.add_argument("--max-scroll-steps", type=int, default=180)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    run_dir = create_or_resume_run(Path(args.run_root), args.resume, args.highlight_url, args.min_price)
    print(f"RUN_DIR={run_dir}", flush=True)
    try:
        filter_state = open_highlight_and_set_price(args.highlight_url, args.min_price)
        (run_dir / "price_filter_state.json").write_text(json.dumps(filter_state, ensure_ascii=False, indent=2), encoding="utf-8")
        products = collect_highlight_products(args.min_price, args.limit * 3, max_scroll_steps=args.max_scroll_steps)
        (run_dir / "highlight_products_checkpoint.json").write_text(json.dumps(products, ensure_ascii=False, indent=2), encoding="utf-8")
        seller_rows = collect_seller_sources(products, args.limit, args.min_price)
        sellers = write_outputs(run_dir, seller_rows, products)
    except Exception as exc:
        (run_dir / "source_collection_error.json").write_text(
            json.dumps({"error": str(exc), "ts": dt.datetime.now().isoformat(timespec="seconds")}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"ERROR={exc}", file=sys.stderr, flush=True)
        print(f"SOURCE_URLS={run_dir / 'source_urls.txt'}", flush=True)
        return 1
    print(f"SOURCE_URLS={run_dir / 'source_urls.txt'}", flush=True)
    print(f"SELLER_COUNT={len(sellers)}", flush=True)
    if len(sellers) < args.limit:
        print(f"WARNING=only collected {len(sellers)} sellers before page/product exhaustion", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
