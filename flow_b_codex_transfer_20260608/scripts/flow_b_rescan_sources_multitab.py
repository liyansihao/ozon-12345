#!/usr/bin/env python3
"""Fast round-robin scan Ozon seller pages across multiple Chrome tabs."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from flow_b_rescan_sources_deep import fetch_favorite_count


def run_applescript(script: str, *args: str, timeout: int = 180) -> str:
    proc = subprocess.run(["osascript", "-", *args], input=script, text=True, capture_output=True, timeout=timeout)
    if proc.returncode:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip())
    return proc.stdout.strip()


def chrome_js_on_tab(tab_index: int, js: str) -> str:
    script = """
on run argv
  set tab_index to (item 1 of argv) as integer
  set js_code to item 2 of argv
  with timeout of 120 seconds
    tell application "Google Chrome"
      tell front window
        set active tab index to tab_index
        tell tab tab_index to execute javascript js_code
      end tell
    end tell
  end timeout
end run
"""
    return run_applescript(script, str(tab_index), js, timeout=150)


def open_tabs(urls: list[str]) -> list[int]:
    script = """
on run argv
  with timeout of 120 seconds
    tell application "Google Chrome"
      if (count of windows) = 0 then make new window
      tell front window
        set ids to {}
        repeat with u in argv
          set newTab to make new tab with properties {URL:u}
          set active tab index to (count of tabs)
          set end of ids to (count of tabs as string)
        end repeat
      end tell
    end tell
  end timeout
  set AppleScript's text item delimiters to ","
  return ids as text
end run
"""
    raw = run_applescript(script, *urls, timeout=150)
    return [int(x) for x in raw.split(",") if x.strip()]


def wait_tab_loaded(tab_index: int, min_wait: float, timeout: float = 18.0) -> dict:
    time.sleep(min_wait)
    start = time.time()
    last_state: dict = {}
    while time.time() - start < timeout:
        raw = chrome_js_on_tab(
            tab_index,
            """
JSON.stringify((() => {
  const anchors = Array.from(document.querySelectorAll('a[href*="/product/"]'));
  const body = String(document.body && document.body.innerText || '');
  return {
    readyState: String(document.readyState || ''),
    title: String(document.title || ''),
    productLinks: anchors.length,
    bodyLength: body.length,
    url: String(location.href)
  };
})())
""",
        )
        try:
            last_state = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            last_state = {}
        ready = last_state.get("readyState") == "complete"
        has_content = int(last_state.get("productLinks") or 0) > 0 or int(last_state.get("bodyLength") or 0) > 1200
        if ready and has_content:
            return last_state
        time.sleep(1)
    return last_state


def scan_tab(tab_index: int, steps: int, scroll_ratio: float, delay: float) -> dict:
    collected: dict[str, str] = {}
    title = ""
    final_url = ""
    blocked = False
    stop_reason = "max_steps"
    start = time.time()
    for step in range(steps):
        raw = ""
        state = None
        for attempt in range(3):
            raw = chrome_js_on_tab(
                tab_index,
                f"""
JSON.stringify((() => {{
  const anchors = Array.from(document.querySelectorAll('a[href*="/product/"]'));
  const links = anchors.map(a => ({{
    href: String(a.href || '').split('?')[0],
    text: String(a.innerText || a.title || '').trim().slice(0, 120)
  }})).filter(x => x.href.includes('/product/'));
  const text = String(document.body && document.body.innerText || '');
  const state = {{
    url: String(location.href),
    title: String(document.title || ''),
    y: Math.round(scrollY),
    height: document.body.scrollHeight,
    viewport: innerHeight,
    links,
    blocked: /Доступ ограничен|Access denied|captcha|Похоже, нет/i.test(String(document.title || '') + ' ' + text.slice(0, 800))
  }};
  window.scrollBy(0, Math.max(500, Math.floor(innerHeight * {scroll_ratio})));
  return state;
}})())
""",
            )
            if raw:
                try:
                    state = json.loads(raw)
                    break
                except json.JSONDecodeError:
                    pass
            time.sleep(0.8 + attempt * 0.5)
        if state is None:
            stop_reason = "js_empty_or_invalid"
            break
        title = state.get("title", "")
        final_url = state.get("url", "")
        blocked = bool(state.get("blocked"))
        for link in state.get("links") or []:
            href = link.get("href")
            if href:
                collected[href] = link.get("text") or collected.get(href, "")
        if blocked:
            stop_reason = "blocked_or_empty"
            break
        y = int(state.get("y") or 0)
        height = int(state.get("height") or 0)
        viewport = int(state.get("viewport") or 0)
        if y + viewport >= height - 100 and step >= 2:
            stop_reason = "near_bottom"
            break
        time.sleep(delay)
    return {
        "final_url": final_url,
        "title": title,
        "blocked": blocked,
        "stop_reason": stop_reason,
        "seconds": round(time.time() - start, 1),
        "cumulative_product_link_count": len(collected),
        "links": [{"href": href, "text": text} for href, text in sorted(collected.items())],
    }


def close_tabs(tab_indexes: list[int]) -> None:
    for tab_index in sorted(tab_indexes, reverse=True):
        try:
            chrome_js_on_tab(tab_index, "window.close(); 'closed';")
        except Exception:
            pass


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: flow_b_rescan_sources_multitab.py URLS_TXT OUT_JSON", file=sys.stderr)
        return 2
    urls = [u.strip() for u in Path(sys.argv[1]).read_text().splitlines() if u.strip()]
    out_path = Path(sys.argv[2])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    workers = max(1, int(os.environ.get("FLOW_B_TAB_WORKERS", "3")))
    steps = int(os.environ.get("FLOW_B_MAX_SCROLL_STEPS", "18"))
    scroll_ratio = float(os.environ.get("FLOW_B_SCROLL_RATIO", "0.95"))
    delay = float(os.environ.get("FLOW_B_SCROLL_DELAY", "0.25"))
    tab_load_wait = float(os.environ.get("FLOW_B_TAB_LOAD_WAIT", "3"))
    after_wait = float(os.environ.get("FLOW_B_MAOZI_AFTER_SCAN_WAIT", "6"))
    records = []
    done_urls = set()
    if out_path.exists():
        try:
            existing = json.loads(out_path.read_text())
            if isinstance(existing, list):
                records = existing
                done_urls = {r.get("source_url") for r in records if r.get("source_url")}
        except Exception:
            records = []
            done_urls = set()
    urls = [u for u in urls if u not in done_urls]
    if done_urls:
        print(f"resume: skip {len(done_urls)} completed sellers, remaining {len(urls)}", flush=True)
    for batch_start in range(0, len(urls), workers):
        batch = urls[batch_start : batch_start + workers]
        print(f"batch {batch_start + 1}-{batch_start + len(batch)} / {len(urls)}", flush=True)
        favorite_before = fetch_favorite_count()
        tab_indexes = open_tabs(batch)
        for tab_index in tab_indexes:
            wait_tab_loaded(tab_index, tab_load_wait)
        batch_records = []
        try:
            for url, tab_index in zip(batch, tab_indexes):
                print(f"  scan tab={tab_index} {url}", flush=True)
                item = scan_tab(tab_index, steps, scroll_ratio, delay)
                batch_records.append({"source_url": url, **item, "favorite_count_before": favorite_before})
        finally:
            close_tabs(tab_indexes)
        time.sleep(after_wait)
        favorite_after = fetch_favorite_count()
        delta = None
        if favorite_before is not None and favorite_after is not None:
            delta = favorite_after - favorite_before
        for item in batch_records:
            item["favorite_count_after"] = favorite_after
            item["favorite_count_delta"] = delta
            records.append(item)
        out_path.write_text(json.dumps(records, ensure_ascii=False, indent=2))
        print(f"  favorite {favorite_before} -> {favorite_after} delta={delta}", flush=True)
        if favorite_after is not None and favorite_after >= int(os.environ.get("FLOW_B_TARGET_FAVORITES", "1000")):
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
