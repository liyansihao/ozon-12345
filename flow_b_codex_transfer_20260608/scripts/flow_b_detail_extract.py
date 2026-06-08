#!/usr/bin/env python3
"""Collect Flow B product-detail facts from the logged-in Chrome Ozon tab."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from pathlib import Path


def osa(script: str) -> str:
    proc = subprocess.run(["osascript", "-"], input=script, text=True, capture_output=True)
    if proc.returncode:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip())
    return proc.stdout.strip()


def run_js(js: str) -> str:
    script = """
on run argv
  set js_code to item 1 of argv
  with timeout of 45 seconds
    tell application "Google Chrome"
      tell active tab of front window
        execute javascript js_code
      end tell
    end tell
  end timeout
end run
"""
    proc = subprocess.run(
        ["osascript", "-", js],
        input=script,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip())
    return proc.stdout.strip()


def parse_money(value: str) -> float | None:
    value = value.replace("\u2009", "").replace("\xa0", "").replace(" ", "")
    value = value.replace(",", ".")
    match = re.search(r"([0-9]+(?:\.[0-9]+)?)", value)
    if not match:
        return None
    return float(match.group(1))


def extract_detail(text: str, fallback_price: float) -> dict:
    mode = None
    m = re.search(r"发货模式：\s*([^\n]+)", text)
    if m:
        mode = m.group(1).strip()

    follow_min = None
    m = re.search(r"跟卖最低价：\s*¥\s*([0-9.,]+)", text)
    if m:
        follow_min = parse_money(m.group(1))
    if follow_min is None:
        m = re.search(r"Есть дешевле или быстрее\s*\nот\s*([0-9.,\s\u00a0\u2009]+)\s*¥", text)
        if m:
            follow_min = parse_money(m.group(1))

    head = text.split("选品标签：", 1)[0]
    yen_lines = [line for line in head.splitlines() if "¥" in line]
    yen_values = [parse_money(line) for line in yen_lines]
    yen_values = [x for x in yen_values if x is not None and x > 0]
    current_price = yen_values[0] if yen_values else fallback_price

    selected_basis = [fallback_price, current_price, follow_min]
    current_price_rub_suspect = False
    if current_price is not None and fallback_price and current_price > fallback_price * 3:
        current_price_rub_suspect = True
        selected_basis = [fallback_price, follow_min]
    selected = min(x for x in selected_basis if x is not None)
    return {
        "mode": mode,
        "current_price": round(current_price, 2) if current_price is not None else None,
        "follow_min": round(follow_min, 2) if follow_min is not None else None,
        "selected_price": round(selected, 2),
        "fallback_price": round(fallback_price, 2),
        "current_price_rub_suspect": current_price_rub_suspect,
    }


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: flow_b_detail_extract.py ITEMS_JSON OUT_JSON", file=sys.stderr)
        return 2
    items = json.loads(Path(sys.argv[1]).read_text())
    out_path = Path(sys.argv[2])

    # Use an existing Ozon tab when present, otherwise create a dedicated detail tab.
    osa(
        """
tell application "Google Chrome"
  activate
  if (count of windows) = 0 then make new window
  tell front window
    repeat with i from 1 to count of tabs
      if URL of tab i contains "www.ozon.ru" then
        set active tab index to i
        return
      end if
    end repeat
    set newTab to make new tab with properties {URL:"about:blank"}
    set active tab index to (count of tabs)
  end tell
end tell
"""
    )
    results = []
    for item in items:
        sku = str(item["sku"])
        url = f"https://www.ozon.ru/product/{sku}"
        run_js(f"location.href={json.dumps(url)}; 'navigating';")
        deadline = time.time() + 18
        payload = None
        while time.time() < deadline:
            time.sleep(1.5)
            raw = run_js(
                "JSON.stringify({url:location.href,title:document.title,text:document.body.innerText})"
            )
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = None
            text = payload.get("text", "") if payload else ""
            if payload and sku in text and "Доступ ограничен" not in payload.get("title", ""):
                break
        if not payload:
            results.append({**item, "detail_error": "detail page text unavailable"})
            continue
        detail = extract_detail(payload.get("text", ""), float(item["sell_price"]))
        results.append({**item, **detail, "detail_url": payload.get("url"), "detail_title": payload.get("title")})
        out_path.write_text(json.dumps(results, ensure_ascii=False, indent=2))
        print(
            sku,
            "mode=", detail.get("mode"),
            "current=", detail.get("current_price"),
            "follow=", detail.get("follow_min"),
            "selected=", detail.get("selected_price"),
            flush=True,
        )
    out_path.write_text(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
