#!/usr/bin/env python3
"""Continue collecting product links from the current Chrome page."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path


def run_js(js: str, timeout: int = 90) -> str:
    script = """
on run argv
  set js_code to item 1 of argv
  with timeout of 90 seconds
    tell application "Google Chrome"
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


def collect() -> dict:
    raw = run_js(
        """
JSON.stringify((() => {
  const links = Array.from(document.querySelectorAll('a[href*="/product/"]')).map(a => ({
    href: String(a.href || '').split('?')[0],
    text: String(a.innerText || a.title || '').trim().slice(0, 120)
  })).filter(x => x.href.includes('/product/'));
  return {
    url: String(location.href),
    title: String(document.title),
    y: Math.round(scrollY),
    height: document.body.scrollHeight,
    viewport: innerHeight,
    links
  };
})())
"""
    )
    return json.loads(raw)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: flow_b_continue_current_page_scan.py OUT_JSON", file=sys.stderr)
        return 2
    out = Path(sys.argv[1])
    out.parent.mkdir(parents=True, exist_ok=True)
    seen: dict[str, str] = {}
    stable = 0
    last_count = 0
    last_y = -1
    last_height = 0
    start = time.time()
    final = {}
    for step in range(260):
        state = collect()
        for link in state.get("links", []):
            href = link.get("href")
            if href:
                seen[href] = link.get("text") or seen.get(href, "")
        y = int(state.get("y") or 0)
        height = int(state.get("height") or 0)
        viewport = int(state.get("viewport") or 0)
        near_bottom = y + viewport >= height - 120
        unchanged = len(seen) == last_count and abs(y - last_y) < 30 and abs(height - last_height) < 30 and near_bottom
        stable = stable + 1 if unchanged else 0
        last_count = len(seen)
        last_y = y
        last_height = height
        final = {
            "source_url": state.get("url"),
            "title": state.get("title"),
            "stop_reason": "checkpoint",
            "seconds": round(time.time() - start, 1),
            "cumulative_product_link_count": len(seen),
            "links": [{"href": href, "text": text} for href, text in sorted(seen.items())],
        }
        if step % 10 == 0:
            out.write_text(json.dumps([final], ensure_ascii=False, indent=2))
            print(f"step={step} cumulative={len(seen)} y={y} h={height}", flush=True)
        if stable >= 8:
            final["stop_reason"] = "stable_bottom"
            break
        run_js("window.scrollBy(0, Math.max(450, Math.floor(innerHeight * 0.55))); 'scrolled';", timeout=100)
        time.sleep(1.2)
    out.write_text(json.dumps([final], ensure_ascii=False, indent=2))
    print(json.dumps({k: final.get(k) for k in ["source_url", "title", "stop_reason", "seconds", "cumulative_product_link_count"]}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
