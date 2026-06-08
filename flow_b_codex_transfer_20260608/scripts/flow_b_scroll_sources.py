#!/usr/bin/env python3
"""Open Flow B source URLs in Chrome and scroll each until no new content loads."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path


def run_js(js: str) -> str:
    script = """
on run argv
  set js_code to item 1 of argv
  tell application "Google Chrome"
    tell active tab of front window
      execute javascript js_code
    end tell
  end tell
end run
"""
    proc = subprocess.run(["osascript", "-", js], input=script, text=True, capture_output=True)
    if proc.returncode:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip())
    return proc.stdout.strip()


def main() -> int:
    if len(sys.argv) not in {3, 4}:
        print("usage: flow_b_scroll_sources.py URLS_TXT OUT_JSONL [START_INDEX_1_BASED]", file=sys.stderr)
        return 2
    urls = [u.strip() for u in Path(sys.argv[1]).read_text().splitlines() if u.strip()]
    out = Path(sys.argv[2])
    out.parent.mkdir(parents=True, exist_ok=True)
    seen = set()
    ordered = []
    for url in urls:
        norm = url.strip()
        if norm not in seen:
            ordered.append(norm)
            seen.add(norm)

    start_index = int(sys.argv[3]) if len(sys.argv) == 4 else 1
    with out.open("a", encoding="utf-8") as f:
        for idx, url in enumerate(ordered, 1):
            if idx < start_index:
                continue
            print(f"[{idx}/{len(ordered)}] {url}", flush=True)
            run_js(f"location.href={json.dumps(url)}; 'navigating';")
            time.sleep(6)
            stable = 0
            last = {"height": 0, "count": 0}
            started = time.time()
            for _ in range(35):
                raw = run_js(
                    """
(() => {
  window.scrollTo(0, document.body.scrollHeight);
  const links = [...document.querySelectorAll('a[href*="/product/"]')]
    .map(a => a.href.split('?')[0]).filter(Boolean);
  return JSON.stringify({
    url: location.href,
    title: document.title,
    height: document.body.scrollHeight,
    y: scrollY,
    count: new Set(links).size,
    text: document.body.innerText.slice(0, 500)
  });
})()
"""
                )
                state = json.loads(raw)
                if state["height"] == last["height"] and state["count"] == last["count"]:
                    stable += 1
                else:
                    stable = 0
                last = state
                if stable >= 3:
                    break
                time.sleep(0.8)
            record = {
                "source_url": url,
                "final_url": last.get("url"),
                "title": last.get("title"),
                "height": last.get("height"),
                "product_link_count": last.get("count"),
                "seconds": round(time.time() - started, 1),
                "blocked": "Доступ ограничен" in last.get("title", "") or "Похоже, нет" in last.get("text", ""),
            }
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
            f.flush()
            print(json.dumps(record, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
