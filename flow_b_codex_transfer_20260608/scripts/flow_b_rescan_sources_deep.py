#!/usr/bin/env python3
"""Deep-scroll Ozon source pages and cumulatively collect product links."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path


def run_js(js: str) -> str:
    script = """
on run argv
  set js_code to item 1 of argv
  with timeout of 180 seconds
    tell application "Google Chrome"
      tell active tab of front window
        execute javascript js_code
      end tell
    end tell
  end timeout
end run
"""
    last_error = ""
    for attempt in range(3):
        proc = subprocess.run(["osascript", "-", js], input=script, text=True, capture_output=True, timeout=220)
        if not proc.returncode:
            return proc.stdout.strip()
        last_error = proc.stderr.strip() or proc.stdout.strip()
        if "-1712" not in last_error and "超时" not in last_error:
            break
        time.sleep(2 + attempt * 3)
    raise RuntimeError(last_error)


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: flow_b_rescan_sources_deep.py URLS_TXT OUT_JSON", file=sys.stderr)
        return 2

    urls = [u.strip() for u in Path(sys.argv[1]).read_text().splitlines() if u.strip()]
    out_path = Path(sys.argv[2])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    max_steps = int(os.environ.get("FLOW_B_MAX_SCROLL_STEPS", "140"))
    scroll_ratio = float(os.environ.get("FLOW_B_SCROLL_RATIO", "0.85"))
    scroll_delay = float(os.environ.get("FLOW_B_SCROLL_DELAY", "1.0"))
    ordered: list[str] = []
    seen: set[str] = set()
    for url in urls:
        if url not in seen:
            ordered.append(url)
            seen.add(url)

    records = []

    def make_record(url: str, final_url: str, title: str, blocked: bool, stop_reason: str, start: float, collected: dict[str, str]) -> dict:
        return {
            "source_url": url,
            "final_url": final_url,
            "title": title,
            "blocked": blocked,
            "stop_reason": stop_reason,
            "seconds": round(time.time() - start, 1),
            "cumulative_product_link_count": len(collected),
            "links": [{"href": href, "text": text} for href, text in sorted(collected.items())],
        }

    def save_checkpoint(record: dict) -> None:
        tmp = records + [record]
        out_path.write_text(json.dumps(tmp, ensure_ascii=False, indent=2))
    for idx, url in enumerate(ordered, 1):
        print(f"[{idx}/{len(ordered)}] {url}", flush=True)
        run_js(f"location.href={json.dumps(url)}; 'navigating';")
        time.sleep(8)
        run_js("window.scrollTo(0, 0); 'top';")
        time.sleep(1)
        collected: dict[str, str] = {}
        stable_rounds = 0
        no_new_link_rounds = 0
        last_height = 0
        last_collected = 0
        last_y = -1
        start = time.time()
        blocked = False
        title = ""
        final_url = ""
        text_head = ""
        stop_reason = "max_steps"
        try:
            for step in range(max_steps):
                raw = run_js(
                    """
JSON.stringify((() => {
  const anchors = Array.from(document.querySelectorAll('a[href*="/product/"]'));
  const links = anchors.map(a => ({
    href: String(a.href || '').split('?')[0],
    text: String(a.innerText || a.title || '').trim().slice(0, 120)
  })).filter(x => x.href.includes('/product/'));
  const text = String(document.body && document.body.innerText || '');
  return {
    url: String(location.href),
    title: String(document.title),
    y: Math.round(scrollY),
    height: document.body.scrollHeight,
    viewport: innerHeight,
    links,
    text: text.slice(0, 500)
  };
})())
"""
                )
                try:
                    state = json.loads(raw)
                except json.JSONDecodeError:
                    print(f"  invalid JS result at step={step}: {raw[:80]!r}", flush=True)
                    run_js("window.scrollBy(0, Math.max(700, Math.floor(innerHeight * 0.85))); 'scrolled';")
                    time.sleep(2)
                    continue
                title = state.get("title", "")
                final_url = state.get("url", "")
                text_head = state.get("text", "")
                if "Доступ ограничен" in title or "Похоже, нет" in text_head:
                    blocked = True
                    stop_reason = "blocked_or_empty"
                    break
                for link in state.get("links", []):
                    href = link.get("href")
                    if href:
                        collected[href] = link.get("text") or collected.get(href, "")
                y = int(state.get("y") or 0)
                height = int(state.get("height") or 0)
                near_bottom = y + int(state.get("viewport") or 0) >= height - 80
                unchanged = (
                    len(collected) == last_collected
                    and abs(height - last_height) < 20
                    and abs(y - last_y) < 20
                    and near_bottom
                )
                stable_rounds = stable_rounds + 1 if unchanged else 0
                no_new_link_rounds = no_new_link_rounds + 1 if len(collected) == last_collected else 0
                last_height = height
                last_collected = len(collected)
                last_y = y
                if step % 10 == 0:
                    print(f"  step={step} cumulative={len(collected)} y={y} h={height}", flush=True)
                    save_checkpoint(make_record(url, final_url, title, blocked, "checkpoint", start, collected))
                if stable_rounds >= 8:
                    stop_reason = "stable_bottom"
                    break
                if no_new_link_rounds >= int(os.environ.get("FLOW_B_MAX_NO_NEW_LINK_STEPS", "45")) and near_bottom:
                    stop_reason = "no_new_links_near_bottom"
                    break
                run_js(
                    f"""
(() => {{
  window.scrollBy(0, Math.max(350, Math.floor(innerHeight * {scroll_ratio})));
  return 'scrolled';
}})()
"""
                )
                time.sleep(scroll_delay)
        except Exception as exc:
            stop_reason = f"error_checkpoint: {exc}"
            print(f"  scan error after cumulative={len(collected)}: {exc}", flush=True)
        record = make_record(url, final_url, title, blocked, stop_reason, start, collected)
        records.append(record)
        out_path.write_text(json.dumps(records, ensure_ascii=False, indent=2))
        print(
            json.dumps(
                {k: record[k] for k in ["source_url", "title", "blocked", "stop_reason", "seconds", "cumulative_product_link_count"]},
                ensure_ascii=False,
            ),
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
