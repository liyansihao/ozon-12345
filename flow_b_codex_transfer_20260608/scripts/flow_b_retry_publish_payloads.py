#!/usr/bin/env python3
"""Retry saved Flow B publish payloads after Maozi login is restored."""

from __future__ import annotations

import datetime as dt
import json
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run_js(js_path: Path) -> str:
    proc = subprocess.run(
        ["python3", "scripts/flow_b_chrome_js_tab.py", "ozon.maozierp.com", str(js_path)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip())
    return proc.stdout.strip()


def submit(batch: Path, payload_path: Path) -> dict:
    payload = json.loads(payload_path.read_text())
    js_path = payload_path.parent / "retry_publish.js"
    result_path = payload_path.parent / "retry_publish_result.json"
    js_path.write_text(
        f"""
window.__flowBRetryPublish=null;
(async()=>{{
 const token=JSON.parse(localStorage.getItem('maozierp-core-access')||'{{}}').accessToken;
 const payload={json.dumps(payload, ensure_ascii=True)};
 const h={{'Content-Type':'application/json','Accept-Language':'zh-CN','Client':'pc'}};
 if(token) h.Authorization='Bearer '+token;
 const r=await fetch('https://api.maozierp.com/api.selection.follow/import',{{method:'POST',headers:h,body:JSON.stringify(payload)}});
 const text=await r.text();
 window.__flowBRetryPublish=JSON.stringify({{status:r.status,text,payload}});
}})().catch(e=>window.__flowBRetryPublish=JSON.stringify({{error:String(e),stack:e.stack}}));
'started';
"""
    )
    run_js(js_path)
    time.sleep(4)
    read_path = payload_path.parent / "read_retry_publish.js"
    read_path.write_text("window.__flowBRetryPublish || 'pending';\n")
    raw = run_js(read_path)
    result = json.loads(raw)
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    text = json.loads(result.get("text", "{}")) if isinstance(result.get("text"), str) else {}
    if result.get("status") == 200 and text.get("code") == 1:
        pub = ROOT / "data/flow_b/published_links.csv"
        existing = set(pub.read_text().splitlines()) if pub.exists() else set()
        with pub.open("a") as f:
            for row in payload.get("rows") or []:
                link = row.get("link")
                if link and link not in existing:
                    f.write(link + "\n")
                    existing.add(link)
        with (ROOT / "data/flow_b/candidates.jsonl").open("a") as f:
            for row in payload.get("rows") or []:
                f.write(json.dumps({
                    "run": str(batch),
                    "ts": dt.datetime.now().isoformat(timespec="seconds"),
                    "sku": row.get("sku"),
                    "link": row.get("link"),
                    "decision": "published_retry",
                    "price": row.get("price"),
                    "shop_ids": payload.get("shop_ids"),
                    "watermark_id": payload.get("watermark_id"),
                }, ensure_ascii=False) + "\n")
    return result


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: flow_b_retry_publish_payloads.py BATCH_DIR", file=sys.stderr)
        return 2
    batch = Path(sys.argv[1]).resolve()
    payloads = sorted(batch.glob("publish_*_*/publish_payload.json"))
    if not payloads:
        print("no saved publish payloads found", file=sys.stderr)
        return 1
    ok = 0
    for payload_path in payloads:
        result = submit(batch, payload_path)
        text = json.loads(result.get("text", "{}")) if isinstance(result.get("text"), str) else result.get("text")
        success = result.get("status") == 200 and isinstance(text, dict) and text.get("code") == 1
        rows = len((result.get("payload") or {}).get("rows") or [])
        print(payload_path.parent.name, "rows", rows, "success", success, "status", result.get("status"), "text", text, flush=True)
        ok += rows if success else 0
    print("published_rows", ok)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
