#!/usr/bin/env python3
"""Best-effort add scanned Ozon products to Maozi ERP favorites."""

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


def load_product_rows(scan_path: Path, limit: int) -> list[dict]:
    records = json.loads(scan_path.read_text(encoding="utf-8"))
    rows: list[dict] = []
    seen: set[str] = set()
    for record in records:
        for link in record.get("links") or []:
            url = normalize_product_url(link.get("href") or "")
            if not url:
                continue
            sku = sku_from_url(url)
            if not sku or sku in seen:
                continue
            seen.add(sku)
            rows.append(
                {
                    "sku": sku,
                    "url": url,
                    "text": link.get("text") or "",
                    "source_url": record.get("source_url") or record.get("final_url") or "",
                }
            )
            if len(rows) >= limit:
                return rows
    return rows


def classify_maozi_panel(snapshot: dict) -> str:
    text = str(snapshot.get("text") or "")
    buttons = snapshot.get("buttons") or []
    button_text = " ".join(str(button.get("text") or "") for button in buttons)
    if "设置选品" in button_text:
        return "setting_available"
    if re.search(r"选品标签|发货模式|月销量|跟卖最低价|一键上架|编辑上架|计算利润|进入ERP", text + " " + button_text):
        return "panel_no_setting"
    return "no_panel"


def run_osascript(script: str, *args: str, timeout: int = 120) -> str:
    proc = subprocess.run(["osascript", "-", *args], input=script, text=True, capture_output=True, timeout=timeout)
    if proc.returncode:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip())
    return proc.stdout.strip()


def chrome_js_current_ozon(js: str, timeout: int = 120) -> str:
    script = """
on run argv
  set js_code to item 1 of argv
  with timeout of 120 seconds
    tell application "Google Chrome"
      if (count of windows) = 0 then make new window
      tell front window
        repeat with i from 1 to count of tabs
          if URL of tab i contains "www.ozon.ru/product" then
            set active tab index to i
            tell tab i to set js_result to execute javascript js_code
            return js_result
          end if
        end repeat
        set newTab to make new tab with properties {URL:"about:blank"}
        set active tab index to (count of tabs)
        tell active tab to set js_result to execute javascript js_code
        return js_result
      end tell
    end tell
  end timeout
end run
"""
    return run_osascript(script, js, timeout=timeout + 20)


def chrome_js_maozi(js: str, timeout: int = 120) -> str:
    script = """
on run argv
  set js_code to item 1 of argv
  with timeout of 120 seconds
    tell application "Google Chrome"
      if (count of windows) = 0 then make new window
      tell front window
        repeat with i from 1 to count of tabs
          if URL of tab i contains "ozon.maozierp.com" then
            set active tab index to i
            tell tab i to set js_result to execute javascript js_code
            return js_result
          end if
        end repeat
        set newTab to make new tab with properties {URL:"https://ozon.maozierp.com/#/product/favorite"}
        set active tab index to (count of tabs)
        delay 4
        tell active tab to set js_result to execute javascript js_code
        return js_result
      end tell
    end tell
  end timeout
end run
"""
    return run_osascript(script, js, timeout=timeout + 20)


def favorite_exists(sku: str) -> bool:
    js = f"""
JSON.stringify((async () => {{
  const token = JSON.parse(localStorage.getItem('maozierp-core-access') || '{{}}').accessToken;
  const h = {{'Accept-Language': 'zh-CN', 'Client': 'pc'}};
  if (token) h.Authorization = 'Bearer ' + token;
  const url = 'https://api.maozierp.com/api.product.favorite/lists?page=1&page_size=10&is_imported=0&sku=' + encodeURIComponent({json.dumps(sku)});
  const res = await fetch(url, {{headers: h}}).then(r => r.json());
  const list = res && res.data && Array.isArray(res.data.data) ? res.data.data : [];
  return {{exists: list.some(x => String(x.sku) === String({json.dumps(sku)})), count: list.length}};
}})())
"""
    raw = chrome_js_maozi(js)
    return bool(json.loads(raw).get("exists"))


def open_product(url: str) -> None:
    chrome_js_current_ozon(f"location.href={json.dumps(url)}; 'navigating';")


def snapshot_maozi_panel() -> dict:
    js = """
JSON.stringify({
  url: location.href,
  title: document.title,
  text: String(document.body && document.body.innerText || ''),
  buttons: Array.from(document.querySelectorAll('button')).map((button, index) => ({
    index,
    text: String(button.innerText || button.textContent || '').trim(),
    aria: button.getAttribute('aria-label') || '',
    disabled: !!button.disabled
  })).filter(x => x.text || x.aria).slice(0, 200)
})
"""
    return json.loads(chrome_js_current_ozon(js))


def click_setting_selection() -> dict:
    js = """
JSON.stringify((() => {
  const buttons = Array.from(document.querySelectorAll('button'));
  const setting = buttons.find(button => String(button.innerText || button.textContent || '').includes('设置选品'));
  if (!setting) return {clicked: false, reason: 'setting_button_missing'};
  setting.click();
  return {clicked: true, text: String(setting.innerText || setting.textContent || '').trim()};
})())
"""
    return json.loads(chrome_js_current_ozon(js))


def choose_default_rule() -> dict:
    js = """
JSON.stringify((() => {
  const clickText = (patterns) => {
    const elements = Array.from(document.querySelectorAll('button, [role="button"], label, .ant-select-item-option-content, .ant-checkbox-wrapper, span, div'));
    const target = elements.find(el => patterns.some(pattern => String(el.innerText || el.textContent || '').trim().includes(pattern)));
    if (!target) return null;
    target.click();
    return String(target.innerText || target.textContent || '').trim();
  };
  const rule = clickText(['叶销量品']);
  const confirm = clickText(['确定', '确认', '保存']);
  return {rule, confirm};
})())
"""
    return json.loads(chrome_js_current_ozon(js))


def add_one(row: dict, wait_seconds: float) -> dict:
    sku = str(row["sku"])
    result = {**row, "ok": False, "before_favorite": False, "after_favorite": False}
    try:
        result["before_favorite"] = favorite_exists(sku)
        if result["before_favorite"]:
            result["ok"] = True
            result["status"] = "already_favorite"
            return result
        open_product(row["url"])
        deadline = time.time() + wait_seconds
        snapshot = {}
        state = "no_panel"
        while time.time() < deadline:
            time.sleep(2)
            snapshot = snapshot_maozi_panel()
            state = classify_maozi_panel(snapshot)
            if state != "no_panel":
                break
        result["panel_state"] = state
        result["panel_buttons"] = [button.get("text") for button in (snapshot.get("buttons") or []) if button.get("text")]
        if state == "setting_available":
            result["setting_click"] = click_setting_selection()
            time.sleep(1.5)
            result["rule_click"] = choose_default_rule()
            time.sleep(3)
        result["after_favorite"] = favorite_exists(sku)
        result["ok"] = result["after_favorite"]
        result["status"] = "added" if result["ok"] else ("no_setting_button" if state == "panel_no_setting" else state)
    except Exception as exc:
        result["error"] = str(exc)
        result["status"] = "error"
    return result


def read_done(progress_path: Path) -> set[str]:
    if not progress_path.exists():
        return set()
    done = set()
    for line in progress_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("ok"):
            done.add(str(row.get("sku")))
    return done


def append_jsonl(path: Path, row: dict) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Add source_deep_scan products to Maozi ERP favorites when the Maozi panel exposes selection controls.")
    parser.add_argument("batch_dir")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--wait", type=float, default=25.0)
    parser.add_argument("--scan-file", default="source_deep_scan.json")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    batch = Path(args.batch_dir).resolve()
    progress_path = batch / "maozi_favorite_add_results.jsonl"
    rows = load_product_rows(batch / args.scan_file, args.limit)
    done = read_done(progress_path)
    attempted = 0
    for idx, row in enumerate(rows, 1):
        if str(row["sku"]) in done:
            continue
        print(f"favorite [{idx}/{len(rows)}] attempted={attempted} sku={row['sku']}", flush=True)
        result = add_one(row, wait_seconds=args.wait)
        append_jsonl(progress_path, result)
        attempted += 1
    print(f"FAVORITE_ATTEMPTED={attempted}", flush=True)
    print(f"FAVORITE_PROGRESS={progress_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
