#!/usr/bin/env python3
"""Process a Flow B batch after source stores have been scanned."""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import ast
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests


ROOT = Path(__file__).resolve().parents[1]
FLOW_B_PROFIT_THRESHOLD = float(os.environ.get("FLOW_B_PROFIT_THRESHOLD", "30"))
SOURCE_TRACE_FIELDS = [
    "source_key",
    "source_segment",
    "source_category",
    "source_highlight_url",
    "source_highlight_category",
    "source_min_price",
    "source_seller_url",
    "source_seller_title",
    "source_final_url",
    "source_product_url",
    "source_product_text",
    "source_scan_file",
    "source_trace_count",
]

HIGHLIGHT_CATEGORY_LABELS = {
    "13812": "models",
    "7000": "kids_toys",
    "15500": "electronics",
}


def run(cmd: list[str], *, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    last_error = ""
    for attempt in range(3):
        try:
            return subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, timeout=timeout)
        except OSError as exc:
            last_error = str(exc)
            if "Resource temporarily unavailable" not in last_error:
                raise
            time.sleep(2 + attempt * 3)
    return subprocess.CompletedProcess(cmd, 1, "", last_error)


def chrome_js(batch: Path, name: str, js: str) -> str:
    path = batch / f"{name}.js"
    path.write_text(js)
    proc = run(["python3", "scripts/flow_b_chrome_js_tab.py", "ozon.maozierp.com", str(path)])
    if proc.returncode:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip())
    return proc.stdout.strip()


def ensure_maozi_tab() -> None:
    script = """
tell application "Google Chrome"
  activate
  if (count of windows) = 0 then make new window
  tell front window
    set found to false
    repeat with i from 1 to count of tabs
      if URL of tab i contains "ozon.maozierp.com" then
        set active tab index to i
        set found to true
      end if
    end repeat
    if found is false then
      set newTab to make new tab with properties {URL:"https://ozon.maozierp.com/#/product/favorite"}
      set active tab index to (count of tabs)
    end if
  end tell
end tell
"""
    subprocess.run(["osascript", "-e", script], check=False)
    time.sleep(4)


def parse_flow_b_time(value: str) -> dt.datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    for candidate in (text, text.replace("Z", "+00:00")):
        try:
            parsed = dt.datetime.fromisoformat(candidate)
            if parsed.tzinfo:
                parsed = parsed.astimezone(dt.timezone(dt.timedelta(hours=8))).replace(tzinfo=None)
            return parsed
        except ValueError:
            pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return dt.datetime.strptime(text, fmt)
        except ValueError:
            pass
    return None


def published_skus() -> set[str]:
    path = ROOT / "data/flow_b/published_links.csv"
    skus: set[str] = set()
    if path.exists():
        for line in path.read_text().splitlines():
            m = re.search(r"/product/(\d+)", line)
            if m:
                skus.add(m.group(1))
    return skus


def product_sku_from_url(url: str | None) -> str | None:
    text = str(url or "")
    parsed = urlparse(text)
    match = re.search(r"/product/(?:[^/?#]*?-)?(\d+)(?:[/?#]|$)", parsed.path)
    if match:
        return match.group(1)
    match = re.search(r"/product/(\d+)(?:[/?#]|$)", parsed.path)
    return match.group(1) if match else None


def source_key_from_scan_dir(path: Path) -> str:
    name = path.name
    match = re.match(r"find_\d+_(.+)", name)
    return match.group(1) if match else name


def source_category_from_highlight_url(url: str | None) -> tuple[str, str]:
    category = ""
    if url:
        query = parse_qs(urlparse(str(url)).query)
        values = query.get("category") or []
        category = str(values[0]) if values else ""
    return category, HIGHLIGHT_CATEGORY_LABELS.get(category, category or "unknown")


def compact_source_trace(item: dict) -> dict:
    return {key: item.get(key) for key in SOURCE_TRACE_FIELDS if item.get(key) not in (None, "")}


def build_source_trace_index(batch: Path) -> dict[str, dict]:
    index: dict[str, dict] = {}
    for scan_path in sorted(batch.glob("**/source_deep_scan*.json")):
        try:
            rows = json.loads(scan_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(rows, list):
            continue
        config_path = scan_path.parent / "source_config.json"
        try:
            config = json.loads(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
        except (OSError, json.JSONDecodeError):
            config = {}
        source_key = source_key_from_scan_dir(scan_path.parent)
        highlight_url = config.get("highlight_url") or ""
        highlight_category, source_category = source_category_from_highlight_url(highlight_url)
        try:
            scan_file = str(scan_path.relative_to(batch))
        except ValueError:
            scan_file = str(scan_path)
        for row in rows:
            if not isinstance(row, dict):
                continue
            links = row.get("links") or []
            if not isinstance(links, list):
                continue
            base = {
                "source_key": source_key,
                "source_segment": source_key,
                "source_category": source_category,
                "source_highlight_url": highlight_url,
                "source_highlight_category": highlight_category,
                "source_min_price": config.get("min_price"),
                "source_seller_url": row.get("source_url"),
                "source_seller_title": row.get("title"),
                "source_final_url": row.get("final_url"),
                "source_scan_file": scan_file,
            }
            for link in links:
                if isinstance(link, dict):
                    href = link.get("href") or link.get("url")
                    text = link.get("text") or link.get("title")
                else:
                    href = str(link)
                    text = ""
                sku = product_sku_from_url(href)
                if not sku:
                    continue
                trace = {
                    **base,
                    "source_product_url": str(href).split("?")[0],
                    "source_product_text": text,
                    "source_trace_count": 1,
                }
                if sku in index:
                    index[sku]["source_trace_count"] = int(index[sku].get("source_trace_count") or 1) + 1
                else:
                    index[sku] = compact_source_trace(trace)
    return index


def with_source_trace(row: dict, source_index: dict[str, dict]) -> dict:
    sku = str(row.get("sku") or "")
    trace = source_index.get(sku)
    if trace:
        return {**row, **trace}
    return {**row, "source_key": row.get("source_key") or "unknown_source", "source_segment": row.get("source_segment") or "unknown_source"}


APPAREL_KEYWORDS = [
    "одежд", "обув", "поло", "футбол", "рубаш", "брюк", "штаны", "шорт", "плать", "юбк", "куртк",
    "пальто", "толстов", "худи", "свитер", "носк", "трус", "бель", "бюст", "шапк", "головной убор",
    "перчатк", "шлем", "кроссов", "сандал", "тапоч", "ботин", "сумка", "рюкзак",
    "服", "衣", "裤", "裙", "鞋", "帽", "袜", "内衣", "背包", "包包",
]

DIGITAL_3C_KEYWORDS = [
    "телефон", "смартфон", "iphone", "samsung", "xiaomi", "huawei", "pixel", "планшет", "ipad",
    "ноутбук", "компьют", "монитор", "дисплей", "экран", "lcd", "науш", "гарнитур", "bluetooth",
    "заряд", "кабель", "usb", "type-c", "type c", "power bank", "powerbank", "повербанк",
    "чехол для телефона", "чехол для ключ", "аккумулятор для телефона", "камера видеонаблюдения",
    "手机", "平板", "电脑", "笔记本", "显示屏", "屏幕", "耳机", "蓝牙", "充电", "数据线", "移动电源", "充电宝",
]

FOOD_KEYWORDS = [
    "еда", "пищ", "продукт питания", "продукты питания", "съедоб", "закуск", "снек", "сладост",
    "конфет", "шоколад", "печень", "вафл", "батончик", "орех", "сухофрукт", "круп", "мук",
    "макарон", "лапша", "рис", "сахар", "соль", "спец", "приправа", "соус", "масло пищ",
    "напит", "сок", "кофе", "чай", "какао", "молок", "мед", "варень", "джем", "сироп",
    "детское питание", "смесь молочная", "молочная смесь", "пюре детское",
    "корм", "лакомство", "pet food", "cat food", "dog food",
    "food", "snack", "candy", "chocolate", "cookie", "biscuit", "tea", "coffee", "drink", "beverage",
    "sauce", "seasoning", "spice", "baby food",
    "食品", "食物", "零食", "糖果", "巧克力", "饼干", "坚果", "饮料", "茶", "咖啡", "调味", "调料",
    "酱", "蜂蜜", "果酱", "婴儿食品", "奶粉", "宠物食品", "猫粮", "狗粮", "宠物零食",
]

BRAND_RISK_KEYWORDS = [
    "knipex", "wera", "wiha", "bosch", "makita", "dewalt", "milwaukee", "stanley",
    "facom", "bahco", "gedore", "metabo", "hilti", "festool", "dremel",
    "puma", "sokolov", "lenovo", "pandora", "zippo", "haval", "geely", "exeed",
]

HUMAN_MODEL_KEYWORDS = [
    "манекен", "манекены", "манекена", "манекенов", "торс", "торсы",
    "муляж тела", "модель тела", "анатомическ", "скелет человека", "части тела",
    "голова манекена", "рука манекена", "нога манекена", "тело манекена",
    "human mannequin", "mannequin", "dress form", "body model", "torso model",
    "anatomical model", "human body model", "display dummy", "dummy model",
    "人体模型", "人体模特", "人体假人", "服装模特", "展示模特", "橱窗模特", "半身模特",
    "模特头", "模特手", "模特腿", "假人模特", "人台", "人体骨骼", "解剖模型",
]

FLOW_B_DAILY_ROUTES = {
    "home": {
        "label": "家居日用类",
        "shop_id": 77351,
        "shop_name": "JM-002家居类目",
        "watermark_id": 46764,
        "watermark_name": "LUU家具",
        "daily_cap": 100,
    },
    "pet": {
        "label": "宠物用品类",
        "shop_id": 77569,
        "shop_name": "JM-003宠物",
        "watermark_id": 46852,
        "watermark_name": "CUU宠物",
        "daily_cap": 100,
    },
    "baby": {
        "label": "母婴儿童用品类",
        "shop_id": 77577,
        "shop_name": "JM-004母婴用品",
        "watermark_id": 46856,
        "watermark_name": "TLL母婴店",
        "daily_cap": 100,
    },
    "auto": {
        "label": "汽车配件类",
        "shop_id": 58451,
        "shop_name": "JM-001",
        "watermark_id": 35626,
        "watermark_name": "鹿呦呦",
        "daily_cap": 100,
    },
    "unknown": {
        "label": "未知类目",
        "shop_id": 59096,
        "shop_name": "LILI",
        "watermark_id": 35785,
        "watermark_name": "粤泓",
        "daily_cap": 100,
    },
    "yh": {
        "label": "百货类",
        "shop_id": 78890,
        "shop_name": "LL-百货YH",
        "watermark_id": 50682,
        "watermark_name": "YH百货",
        "daily_cap": 100,
    },
    "yjm": {
        "label": "YJM店铺",
        "shop_id": 86890,
        "shop_name": "YJM",
        "watermark_id": 52054,
        "watermark_name": "YJM",
        "daily_cap": 100,
    },
}

PROHIBITED_KEYWORDS = [
    "жидк", "спрей", "аэрозол", "порош", "краска", "клей", "лак", "масло", "шампун", "лосьон",
    "лекар", "медицин", "витамин", "бад", "тест", "пластыр", "мазь", "таблет", "сироп",
    "еда", "пищ", "корм", "лакомство", "смесь", "напит", "кофе", "чай", "соус",
    "нож", "оруж", "зажигал", "табак", "вейп", "сигар", "алког", "эрот", "18+",
    "бренд", "logo", "логотип", "nike", "adidas", "apple", "samsung", "xiaomi", "huawei",
    "liquid", "spray", "powder", "glue", "medicine", "medical", "vitamin", "supplement", "food",
    "液", "喷雾", "粉", "胶水", "油漆", "药", "医疗", "维生素", "补剂", "食品", "婴儿食品", "宠物食品",
    "刀", "武器", "打火机", "烟草", "电子烟", "酒", "成人", "二手", "虚拟",
]

HOME_KEYWORDS = [
    "дом", "кух", "ванн", "мебел", "стул", "кресл", "стол", "полка", "органайзер", "хранен",
    "коврик", "ваза", "чашк", "кружк", "тарел", "сервиров", "фруктовниц", "подставк", "подушк",
    "одеял", "плед", "наволоч", "простын", "занавес", "крюч", "держател", "корзин", "ведро",
    "home", "kitchen", "bath", "chair", "table", "rack", "organizer", "storage",
    "家居", "日用", "厨房", "浴室", "收纳", "清洁", "家具", "椅", "桌", "置物", "杯", "碗", "盘", "花瓶",
]

PET_KEYWORDS = [
    "животн", "питом", "кош", "собак", "кот", "щен", "зоотовар", "попуга", "грызун",
    "ошейн", "повод", "лежанк", "миска", "когтет", "лоток", "переноск", "аквариум",
    "pet", "cat", "dog", "bird", "parrot",
    "宠物", "猫", "狗", "牵引", "项圈", "宠物玩具", "猫砂", "狗碗", "鸟", "鹦鹉",
]

BABY_KEYWORDS = [
    "детск", "ребен", "малыш", "младен", "новорож", "игруш", "конструктор", "кукла",
    "коляск", "подгуз", "пеленк", "горшок", "писсуар", "школьн", "ученик",
    "baby", "kids", "children", "toy",
    "母婴", "儿童", "婴儿", "宝宝", "玩具", "积木", "娃娃", "尿布", "尿垫",
]

AUTO_KEYWORDS = [
    "авто", "автомоб", "машин", "vehicle", "car", "toyota", "chery", "geely", "changan", "hyundai",
    "kia", "honda", "mazda", "bmw", "benz", "mercedes", "audi", "lada", "renault", "nissan",
    "коврик для порога", "подлокотник", "руль", "кпп", "багажник", "зеркал", "колес", "шина",
    "автозапчаст", "консоли автомобиля", "сиденья", "чехол брелка", "наклейки на порог",
    "汽车", "车载", "汽配", "车用", "后视镜", "方向盘", "座椅", "车门", "后备箱", "轮胎", "脚垫",
]


def direct_category_skip_reason(item: dict) -> str | None:
    text = " ".join(str(item.get(k) or "") for k in [
        "title", "name", "category", "category_text", "rule_tag", "mode", "detail_url"
    ]).lower()
    if any(k.lower() in text for k in HUMAN_MODEL_KEYWORDS):
        return "direct skip: human mannequin/model category/title"
    if any(k.lower() in text for k in APPAREL_KEYWORDS):
        return "direct skip: apparel category/title"
    if any(k.lower() in text for k in DIGITAL_3C_KEYWORDS):
        return "direct skip: digital/3C category/title"
    if any(k.lower() in text for k in FOOD_KEYWORDS):
        return "direct skip: food category/title"
    if any(k.lower() in text for k in BRAND_RISK_KEYWORDS):
        return "direct skip: branded/high-risk title"
    if any(k.lower() in text for k in PROHIBITED_KEYWORDS):
        return "direct skip: prohibited/risky category/title"
    return None


def route_category(item: dict) -> str:
    pieces = [
        item.get("title"),
        item.get("detail_title"),
        item.get("category_text"),
        " ".join(item.get("top_titles") or []),
        " ".join(str(x) for x in ((item.get("category_mapped") or {}).get("labels") or [])),
    ]
    text = " ".join(str(x or "") for x in pieces).lower()
    if any(k.lower() in text for k in PET_KEYWORDS):
        return "pet"
    if any(k.lower() in text for k in BABY_KEYWORDS):
        return "baby"
    if any(k.lower() in text for k in AUTO_KEYWORDS):
        return "auto"
    if any(k.lower() in text for k in HOME_KEYWORDS):
        return "home"
    return "unknown"


def fetch_favorites(batch: Path) -> list[dict]:
    ensure_maozi_tab()
    chrome_js(
        batch,
        "fetch_favorites",
        """
window.__flowBBatchFav=null;
(async()=>{
 const token=JSON.parse(localStorage.getItem('maozierp-core-access')||'{}').accessToken;
 if(!token) throw new Error('maozierp token missing');
 const h={'Accept-Language':'zh-CN','Client':'pc','Authorization':'Bearer '+token};
 const rows=[]; let page=1; let last=1;
 while(page<=30){
  const res=await fetch(`https://api.maozierp.com/api.product.favorite/lists?page=${page}&page_size=50&is_imported=0`,{headers:h}).then(r=>r.json());
  if(res.code!==1) throw new Error(res.msg || 'favorite list fetch failed');
  const data=res.data || {}; const list=Array.isArray(data.data)?data.data:[];
  last=Number(data.last_page||1); rows.push(...list);
  if(page>=last || !list.length) break; page++;
 }
 window.__flowBBatchFav=JSON.stringify({code:1,rows,pages:page,last});
})().catch(e=>window.__flowBBatchFav=JSON.stringify({error:String(e),stack:e.stack}));
'started';
""",
    )
    raw = "pending"
    res = None
    for _ in range(60):
        time.sleep(2)
        raw = chrome_js(batch, "read_favorites", "window.__flowBBatchFav || 'pending'\n")
        if raw and raw != "pending":
            try:
                res = json.loads(raw)
            except json.JSONDecodeError:
                res = None
            if isinstance(res, dict):
                break
    (batch / "favorites_response_raw.json").write_text(raw)
    if res is None:
        raise RuntimeError(f"favorites result did not become valid JSON: {raw[:200]!r}")
    rows = res.get("rows") or []
    start = parse_flow_b_time((batch / "start_time.txt").read_text().strip())
    done = published_skus()
    raw_candidates = [
        r for r in rows
        if str(r.get("sku") or "")
        and (start is None or ((parse_flow_b_time(str(r.get("create_time") or "")) or dt.datetime.min) >= start))
        and str(r.get("sku")) not in done
        and int(r.get("is_imported") or 0) == 0
    ]
    source_index = build_source_trace_index(batch)
    candidates, direct_skips = [], []
    for r in raw_candidates:
        traced = with_source_trace(r, source_index)
        reason = direct_category_skip_reason(traced)
        if reason:
            direct_skips.append({**traced, "skip_reason": reason})
        else:
            candidates.append(traced)
    if os.environ.get("FLOW_B_INCLUDE_SOURCE_CANDIDATES", "").lower() in {"1", "true", "yes"}:
        source_candidates = load_source_candidates(
            batch,
            existing_skus={str(r.get("sku")) for r in candidates},
            done_skus=done,
        )
        candidates.extend(source_candidates)
    (batch / "favorites_response.json").write_text(json.dumps(res, ensure_ascii=False, indent=2))
    (batch / "favorites.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    (batch / "candidate_favorites.json").write_text(json.dumps(candidates, ensure_ascii=False, indent=2))
    (batch / "category_direct_skips_before_cost.json").write_text(json.dumps(direct_skips, ensure_ascii=False, indent=2))
    source_counts: dict[str, int] = {}
    for row in candidates:
        key = str(row.get("source_key") or "unknown_source")
        source_counts[key] = source_counts.get(key, 0) + 1
    (batch / "source_trace_index_summary.json").write_text(json.dumps({
        "indexed_skus": len(source_index),
        "candidate_count": len(candidates),
        "candidate_source_counts": source_counts,
        "unknown_source_candidates": source_counts.get("unknown_source", 0),
    }, ensure_ascii=False, indent=2))
    print("favorites", len(rows), "candidates", len(candidates), "direct category skips", len(direct_skips), flush=True)
    return candidates


def load_source_candidates(batch: Path, existing_skus: set[str], done_skus: set[str]) -> list[dict]:
    path = batch / "source_candidates.json"
    if not path.exists():
        (batch / "source_candidates_loaded.json").write_text("[]")
        (batch / "source_candidates_direct_skips.json").write_text("[]")
        return []
    rows = json.loads(path.read_text(encoding="utf-8"))
    loaded, direct_skips = [], []
    seen = set(existing_skus) | set(done_skus)
    for row in rows:
        sku = str(row.get("sku") or "")
        if not sku or sku in seen:
            continue
        if not row.get("cover_image") or not row.get("sell_price"):
            continue
        reason = direct_category_skip_reason(row)
        if reason:
            direct_skips.append({**row, "skip_reason": reason})
            seen.add(sku)
            continue
        normalized = {
            **row,
            "id": row.get("id") if row.get("id") is not None else -int(sku),
            "uid": row.get("uid") or "source_deep_scan",
            "sku": int(sku),
            "rule_name": row.get("rule_name") or "source_deep_scan",
            "rule_tag": row.get("rule_tag") or "source_deep_scan",
            "is_imported": int(row.get("is_imported") or 0),
            "source": row.get("source") or "source_deep_scan",
        }
        loaded.append({**normalized, **compact_source_trace(row)})
        seen.add(sku)
    (batch / "source_candidates_loaded.json").write_text(json.dumps(loaded, ensure_ascii=False, indent=2))
    (batch / "source_candidates_direct_skips.json").write_text(json.dumps(direct_skips, ensure_ascii=False, indent=2))
    print("source candidates", len(loaded), "direct skips", len(direct_skips), flush=True)
    return loaded


def run_1688(batch: Path, items: list[dict]) -> None:
    imgdir = batch / "images"
    outdir = batch / "1688"
    imgdir.mkdir(exist_ok=True)
    outdir.mkdir(exist_ok=True)

    def dl(item: dict) -> dict:
        sku = str(item["sku"])
        path = imgdir / f"{sku}.jpg"
        try:
            r = requests.get(item.get("cover_image"), timeout=25, headers={"User-Agent": "Mozilla/5.0"})
            path.write_bytes(r.content)
            return {"sku": sku, "ok": r.status_code == 200, "status": r.status_code, "bytes": len(r.content), "path": str(path)}
        except Exception as exc:
            return {"sku": sku, "ok": False, "error": str(exc), "path": str(path)}

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        downloads = list(ex.map(dl, items))
    (batch / "image_download_results.json").write_text(json.dumps(downloads, ensure_ascii=False, indent=2))
    print("download_ok", sum(1 for r in downloads if r.get("ok")), "/", len(downloads), flush=True)

    def one(item: dict) -> list[str]:
        sku = str(item["sku"])
        img = imgdir / f"{sku}.jpg"
        out = outdir / f"{sku}.out"
        if out.exists():
            existing = out.read_text(errors="ignore")
            if "P70_COST" in existing:
                return [sku, "ok", existing[-500:]]
        timeout = int(os.environ.get("FLOW_B_1688_ITEM_TIMEOUT", "90"))
        try:
            proc = run(["python3", "scripts/1688_image_median.py", str(img)], timeout=timeout)
            text = proc.stdout + ("\nSTDERR:\n" + proc.stderr if proc.stderr else "")
        except subprocess.TimeoutExpired as exc:
            text = f"TIMEOUT after {timeout}s\nSTDOUT:\n{exc.stdout or ''}\nSTDERR:\n{exc.stderr or ''}"
            out.write_text(text)
            return [sku, "fail", text[-500:]]
        out.write_text(text)
        return [sku, "ok" if proc.returncode == 0 and "P70_COST" in text else "fail", text[-500:]]

    workers = max(1, int(os.environ.get("FLOW_B_1688_WORKERS", "3")))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(one, items))
    (batch / "1688_results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print("1688_ok", sum(1 for r in results if r[1] == "ok"), "/", len(results), flush=True)


def parse_costs(batch: Path, candidates: list[dict]) -> list[dict]:
    by_sku = {str(x["sku"]): x for x in candidates}
    parsed = []
    for sku, cand in by_sku.items():
        text = (batch / "1688" / f"{sku}.out").read_text(errors="ignore")
        valid_m = re.search(r"VALID_COUNT\s+(\d+)", text)
        valid = int(valid_m.group(1)) if valid_m else 0
        cost_m = re.search(r"P70_COST\s+([0-9.]+)", text) or re.search(r"MEDIAN_COST\s+([0-9.]+)", text)
        cost = float(cost_m.group(1)) if cost_m else None
        source_m = re.search(r"COST_SOURCE\s+(.+)", text)
        cost_source = source_m.group(1).strip() if source_m else ("legacy_median" if re.search(r"MEDIAN_COST\s+([0-9.]+)", text) else "")
        first_page_prices = parse_float_list_from_line(text, "FIRST_PAGE_PRICES")
        filtered_first_page_prices = parse_float_list_from_line(text, "FILTERED_FIRST_PAGE_PRICES")
        top3_m = re.search(r"TOP3_PRICES\s+\[([^\]]+)\]", text)
        top3: list[float] = []
        if top3_m:
            for part in top3_m.group(1).split(","):
                try:
                    top3.append(float(part.strip()))
                except ValueError:
                    pass
        titles = []
        for line in text.splitlines():
            m = re.match(r"\d+\.\s+sale=.*?price=.*?offer=.*?shop=.*?title=(.*)", line)
            if m:
                titles.append(m.group(1).strip())
        reliable = True
        reason = "ok"
        if cost is None:
            reliable = False; reason = "no 1688 cost"
        elif cost_source == "search_first_page_p70_similarity_filtered" and len(filtered_first_page_prices) < 3:
            reliable = False; reason = f"filtered first-page insufficient {len(filtered_first_page_prices)}"
        elif cost_source == "search_first_page_p70_similarity_filtered" and min(filtered_first_page_prices) <= 0:
            reliable = False; reason = f"invalid filtered first-page prices {filtered_first_page_prices}"
        elif cost_source == "search_first_page_p70_similarity_filtered" and max(filtered_first_page_prices) / min(filtered_first_page_prices) > 5:
            reliable = False; reason = f"filtered first-page price spread abnormal {filtered_first_page_prices}"
        elif cost_source != "search_first_page_p70_similarity_filtered" and (valid < 3 or len(top3) < 3):
            reliable = False; reason = f"valid_count/top3 insufficient {valid}/{len(top3)}"
        elif cost_source != "search_first_page_p70_similarity_filtered" and min(top3) <= 0:
            reliable = False; reason = f"invalid top3 prices {top3}"
        elif cost_source != "search_first_page_p70_similarity_filtered" and max(top3) / min(top3) > 5:
            reliable = False; reason = f"top3 price spread abnormal {top3}"
        elif cost >= float(cand.get("sell_price") or 0) * 0.85:
            reliable = False; reason = "1688 cost too close to sale price"
        parsed.append({
            **compact_source_trace(cand),
            "sku": sku, "title": cand.get("title"), "sell_price": cand.get("sell_price"), "weight": cand.get("weight"),
            "favorite_id": cand.get("id"), "cover_image": cand.get("cover_image"), "rule_tag": cand.get("rule_tag"),
            "cost": cost, "valid_count": valid, "top3_prices": top3, "top_titles": titles[:5],
            "first_page_prices": first_page_prices, "filtered_first_page_prices": filtered_first_page_prices,
            "p70_cost": cost if cost_source == "search_first_page_p70_similarity_filtered" else None,
            "cost_source": cost_source,
            "reliable": reliable, "reason": reason,
        })
    reliable_items = [x for x in parsed if x["reliable"]]
    blocked = [x for x in parsed if not x["reliable"]]
    (batch / "cost_screen.json").write_text(json.dumps(parsed, ensure_ascii=False, indent=2))
    (batch / "cost_reliable_items.json").write_text(json.dumps(reliable_items, ensure_ascii=False, indent=2))
    (batch / "cost_blocked_items.json").write_text(json.dumps(blocked, ensure_ascii=False, indent=2))
    print("cost reliable", len(reliable_items), "blocked", len(blocked), flush=True)
    return reliable_items


def parse_float_list_from_line(text: str, label: str) -> list[float]:
    match = re.search(rf"{re.escape(label)}\s+(\[[^\]]*\])", text)
    if not match:
        return []
    try:
        value = ast.literal_eval(match.group(1))
    except (SyntaxError, ValueError):
        return []
    if not isinstance(value, list):
        return []
    result = []
    for item in value:
        try:
            result.append(float(item))
        except (TypeError, ValueError):
            pass
    return result


def detail_extract(batch: Path, items: list[dict]) -> list[dict]:
    detail_items = []
    for x in items:
        y = dict(x)
        y["purchase_price"] = x["cost"]
        detail_items.append(y)
    in_path = batch / "detail_input.json"
    out_path = batch / "detail_facts.json"
    in_path.write_text(json.dumps(detail_items, ensure_ascii=False, indent=2))
    detail_timeout = int(os.environ.get("FLOW_B_DETAIL_EXTRACT_TIMEOUT", "2400"))
    batch_size = max(1, int(os.environ.get("FLOW_B_DETAIL_BATCH_SIZE", "40")))
    max_rounds = max(1, int(os.environ.get("FLOW_B_DETAIL_RETRY_ROUNDS", "4")))
    details_by_sku: dict[str, dict] = {}
    attempts = []
    remaining = list(detail_items)
    for round_index in range(1, max_rounds + 1):
        if not remaining:
            break
        round_remaining = []
        for chunk_index, start in enumerate(range(0, len(remaining), batch_size), 1):
            chunk = remaining[start:start + batch_size]
            chunk_in = batch / f"detail_input_round{round_index:02d}_chunk{chunk_index:03d}.json"
            chunk_out = batch / f"detail_facts_round{round_index:02d}_chunk{chunk_index:03d}.json"
            chunk_in.write_text(json.dumps(chunk, ensure_ascii=False, indent=2))
            if chunk_out.exists():
                chunk_out.unlink()
            try:
                proc = run(["python3", "scripts/flow_b_detail_extract.py", str(chunk_in), str(chunk_out)], timeout=detail_timeout)
                returncode = proc.returncode
                stdout = proc.stdout
                stderr = proc.stderr
            except subprocess.TimeoutExpired as exc:
                returncode = -1
                stdout = exc.stdout or ""
                stderr = exc.stderr or f"detail extract timed out after {detail_timeout}s"
            if stdout:
                print(stdout, end="", flush=True)
            rows = []
            if chunk_out.exists():
                try:
                    loaded = json.loads(chunk_out.read_text())
                    rows = loaded if isinstance(loaded, list) else []
                except json.JSONDecodeError:
                    rows = []
            done_skus = set()
            for row in rows:
                sku = str(row.get("sku") or "")
                if sku and not row.get("detail_error"):
                    details_by_sku[sku] = row
                    done_skus.add(sku)
            missing = [x for x in chunk if str(x["sku"]) not in done_skus]
            round_remaining.extend(missing)
            attempts.append({
                "round": round_index,
                "chunk": chunk_index,
                "input_count": len(chunk),
                "output_count": len(rows),
                "done_count": len(done_skus),
                "missing_count": len(missing),
                "returncode": returncode,
                "stderr": (stderr or "")[-1000:],
            })
        remaining = round_remaining
        (batch / "detail_input_remaining.json").write_text(json.dumps(remaining, ensure_ascii=False, indent=2))
        (batch / "detail_facts_all.json").write_text(json.dumps(list(details_by_sku.values()), ensure_ascii=False, indent=2))
    (batch / "detail_extract_attempts.json").write_text(json.dumps(attempts, ensure_ascii=False, indent=2))
    if remaining:
        raise RuntimeError(
            f"detail extraction incomplete: {len(details_by_sku)}/{len(detail_items)} done; "
            f"remaining skus: {[str(x.get('sku')) for x in remaining[:20]]}"
        )
    details = [details_by_sku[str(x["sku"])] for x in detail_items]
    out_path.write_text(json.dumps(details, ensure_ascii=False, indent=2))
    (batch / "detail_facts_all.json").write_text(json.dumps(details, ensure_ascii=False, indent=2))
    category_skips = []
    category_ok = []
    for x in details:
        reason = direct_category_skip_reason(x)
        if reason:
            category_skips.append({"sku": x.get("sku"), "title": x.get("title"), "mode": x.get("mode"), "reason": reason})
        else:
            category_ok.append(x)
    pure = [x for x in category_ok if is_allowed_fbs_mode(x.get("mode"))]
    skips = [{"sku": x.get("sku"), "title": x.get("title"), "mode": x.get("mode"), "reason": "non-FBS-or-unknown-mode"} for x in category_ok if not is_allowed_fbs_mode(x.get("mode"))]
    (batch / "calc_input_items.json").write_text(json.dumps(pure, ensure_ascii=False, indent=2))
    (batch / "detail_mode_skips.json").write_text(json.dumps(skips, ensure_ascii=False, indent=2))
    (batch / "category_direct_skips_after_detail.json").write_text(json.dumps(category_skips, ensure_ascii=False, indent=2))
    print("pure FBS", len(pure), "mode skips", len(skips), "direct category skips", len(category_skips), flush=True)
    return pure


def is_allowed_fbs_mode(mode: str | None) -> bool:
    if not mode:
        return False
    parts = {part.strip().upper() for part in str(mode).split(",") if part.strip()}
    return "FBS" in parts


def calc_profit(batch: Path, items: list[dict]) -> list[dict]:
    mini = []
    for x in items:
        y = {k: x.get(k) for k in ["sku", "title", "favorite_id", "cover_image", "weight", "rule_tag", "mode", "current_price", "follow_min", "selected_price", "detail_url", "top3_prices", "top_titles", *SOURCE_TRACE_FIELDS]}
        y["sell_price"] = x.get("selected_price") or x.get("sell_price")
        y["purchase_price"] = x.get("purchase_price") or x.get("cost")
        y["original_sell_price"] = x.get("sell_price")
        mini.append(y)
    (batch / "calc_selected_items.json").write_text(json.dumps(mini, ensure_ascii=False, indent=2))
    js = f"""
window.__flowBBatchCalc=null;
(async()=>{{
 const items={json.dumps(mini, ensure_ascii=False)};
 const token=JSON.parse(localStorage.getItem('maozierp-core-access')||'{{}}').accessToken;
 const h={{'Accept-Language':'zh-CN','Client':'pc'}};
 if(token) h.Authorization='Bearer '+token;
 const get=async (url)=>{{ const r=await fetch(url,{{headers:h}}); const t=await r.text(); try{{return JSON.parse(t)}}catch(e){{return {{code:0,raw:t.slice(0,500),status:r.status}}}} }};
 const comm=(await get('https://api.maozierp.com/api.config/get_ozon_cate_commission')).data || [];
 function pickThird(children, saleRub){{function n(s){{return Number(String(s).replace(/,/g,''));}} for(const ch of (children||[])){{const label=String(ch.label||''); const nums=[...label.matchAll(/([0-9][0-9,]*\\.?[0-9]*)\\s*₽/g)].map(m=>n(m[1])); if(label.includes('≤')&&nums.length===1&&saleRub<=nums[0]) return ch; if(label.includes('>')&&!label.includes('≤')&&nums.length===1&&saleRub>nums[0]) return ch; if(nums.length>=2&&saleRub>nums[0]&&saleRub<=nums[1]) return ch;}} return (children||[])[0];}}
 function mapCate(cate,sellCny,rate){{const top=comm.find(x=>String(x.cate_id)===String(cate[0])||String(x.value)===String(cate[0])); const second=top?.children?.find(x=>String(x.cate_id)===String(cate[1])||String(x.value)===String(cate[1])); const third=pickThird(second?.children||[],sellCny*rate); return {{mapped:[top?.cate_id||cate[0],second?.cate_id||cate[1],third?.value||cate[2]].filter(Boolean), labels:[top?.label, second?.label, third?.label]}};}}
 let rate=10.4672; const results=[];
 for(const item of items){{ const cat=await get('https://api.maozierp.com/api.tool/get_category_by_sku?keyword='+encodeURIComponent(item.sku)); const cd=cat.data||{{}}; const pi=cd.product_info||{{}}; const cm=mapCate(Array.isArray(cd.cate)?cd.cate:[],Number(item.sell_price),rate); const qs=new URLSearchParams({{sell_price:String(item.sell_price),purchase_price:String(item.purchase_price),package_weight:String(pi.weight||item.weight||1),package_length:String(pi.depth||20),package_width:String(pi.width||20),package_height:String(pi.height||20),china_fee:'0',ad_rate:'0',other_rate:'1',logistics:'CEL',profit_value:{json.dumps(str(FLOW_B_PROFIT_THRESHOLD))},profit_type:'percentage'}}); for(const v of cm.mapped) qs.append('cate[]',v); const profit=await get('https://api.maozierp.com/api.tool/calc_profit?'+qs); if(profit.data?.cnyrub_rate) rate=Number(profit.data.cnyrub_rate)||rate; const eco=(profit.data?.calc_result||[]).find(x=>x.speed==='economy'&&x.name==='CEL'); results.push({{...item, product_info:pi, category:cd.cate, category_mapped:cm, economy:eco?{{title:eco.title,price_list:eco.price_list}}:null, calc_code:profit.code, calc_msg:profit.msg}}); }}
 window.__flowBBatchCalc=JSON.stringify({{rate,results}});
}})().catch(e=>window.__flowBBatchCalc=JSON.stringify({{error:String(e),stack:e.stack}}));
'started';
"""
    chrome_js(batch, "calc_selected", js)
    raw = "pending"
    data = None
    for _ in range(90):
        time.sleep(2)
        raw = chrome_js(batch, "read_calc_result", "window.__flowBBatchCalc || 'pending'\n")
        if raw and raw != "pending":
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                data = None
            if isinstance(data, dict):
                break
    (batch / "calc_selected_raw.txt").write_text(raw)
    if data is None:
        raise RuntimeError(f"calc result did not become valid JSON: {raw[:200]!r}")
    (batch / "calc_selected.json").write_text(json.dumps(data, ensure_ascii=False, indent=2))
    print("calc results", len(data.get("results") or []), flush=True)
    return data.get("results") or []


def mismatch_reason(item: dict) -> str | None:
    title = (item.get("title") or "").lower()
    tops = " ".join(item.get("top_titles") or [])
    if any(w in title for w in ["светильник", "люстра", "лампа"]) and not any(w in tops for w in ["灯", "吊灯", "壁灯", "台灯", "吸顶灯", "射灯", "led", "LED"]):
        return "1688 mismatch for lighting"
    if any(w in title for w in ["авто", "машин", "зеркал", "камера", "уплотн", "багажник"]) and not any(w in tops for w in ["汽车", "车", "后视", "摄像", "倒车", "密封", "车载", "后备箱"]):
        return "1688 mismatch for auto item"
    if any(w in title for w in ["повербанк", "power", "заряд", "ugreen"]) and not any(w in tops for w in ["充电宝", "移动电源", "电源", "快充"]):
        return "1688 mismatch for power bank/charger"
    if any(w in title for w in ["органайзер", "подставка", "полка", "стеллаж"]) and not any(w in tops for w in ["收纳", "置物", "架", "盒", "柜"]):
        return "1688 mismatch for organizer/rack"
    if any(w in title for w in ["футбол", "толстов", "комбинезон", "майка", "платье", "шлем", "шапк", "головной убор"]):
        if not any(w in tops for w in ["服", "衣", "裤", "恤", "卫衣", "帽", "头盔", "鞋"]):
            return "1688 mismatch for apparel/headwear"
    return None


def classify(batch: Path, calc_results: list[dict]) -> list[dict]:
    items = {str(x["sku"]): x for x in json.loads((batch / "calc_input_items.json").read_text())}
    raw_pass, profit_skip, manual, final = [], [], [], []
    for r in calc_results:
        sku = str(r["sku"])
        local = items.get(sku, {})
        pl = (r.get("economy") or {}).get("price_list") or {}
        merged = {**r, **{k: local.get(k) for k in ["title", "top_titles", "top3_prices", "cover_image", "favorite_id", "rule_tag", "detail_url", "mode", *SOURCE_TRACE_FIELDS]}, "price_list": pl}
        pr = pl.get("profit_rate")
        cf = pl.get("cate_fee") or 0
        cr = pl.get("cate_rate") or 0
        if pr is not None and pr > FLOW_B_PROFIT_THRESHOLD and cf > 0 and cr > 0:
            raw_pass.append(merged)
        else:
            profit_skip.append({**merged, "skip_reason": f"profit_rate<={FLOW_B_PROFIT_THRESHOLD:g} ({pr})" if pr is not None else "no economy profit"})
    for x in raw_pass:
        reason = mismatch_reason(x)
        reason = reason or direct_category_skip_reason(x)
        if reason:
            manual.append({**x, "skip_reason": reason})
        else:
            final.append(x)
    (batch / "calc_profit_passers_raw.json").write_text(json.dumps(raw_pass, ensure_ascii=False, indent=2))
    (batch / f"publish_passers{FLOW_B_PROFIT_THRESHOLD:g}.json").write_text(json.dumps(final, ensure_ascii=False, indent=2))
    (batch / "manual_cost_review_after_calc.json").write_text(json.dumps(manual, ensure_ascii=False, indent=2))
    (batch / "skipped_after_calc.json").write_text(json.dumps(profit_skip, ensure_ascii=False, indent=2))
    print("publish passers", len(final), "manual", len(manual), "profit skips", len(profit_skip), flush=True)
    return final


def publish_one_route(batch: Path, items: list[dict], route_key: str, route: dict) -> list[str]:
    batch.mkdir(parents=True, exist_ok=True)
    offer_date = dt.datetime.now().strftime("%d%m%y")
    rows = []
    for x in items:
        sku = str(x["sku"])
        price = round(float(x["price_list"]["sell_price"]), 2)
        rows.append({
            "id": x["favorite_id"], "sku": sku, "title": x.get("title") or "", "cover_image": x.get("cover_image"),
            "link": f"https://www.ozon.ru/product/{sku}", "sell_price": price, "price": price, "old_price": round(price * 2, 2),
            "offer_id": f"mz-{offer_date}-{route_key[:2]}{sku[-5:]}", "brand": "", "source": "favorite", "source_currency": "CNY",
        })
    payload = {
        "scene": "erp",
        "shop_ids": [route["shop_id"]],
        "brand": "none",
        "image_order": "none",
        "watermark_id": route["watermark_id"],
        "floating_price": None,
        "rows": rows,
    }
    (batch / "publish_payload.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    if not rows:
        (batch / "publish_result.json").write_text(json.dumps({"skipped": "no publish rows", "payload": payload}, ensure_ascii=False, indent=2))
        return []
    js = f"""
window.__flowBBatchPublish=null;
(async()=>{{ const token=JSON.parse(localStorage.getItem('maozierp-core-access')||'{{}}').accessToken; const payload={json.dumps(payload, ensure_ascii=True)}; const h={{'Content-Type':'application/json','Accept-Language':'zh-CN','Client':'pc'}}; if(token) h.Authorization='Bearer '+token; const r=await fetch('https://api.maozierp.com/api.selection.follow/import',{{method:'POST',headers:h,body:JSON.stringify(payload)}}); const text=await r.text(); window.__flowBBatchPublish=JSON.stringify({{status:r.status,text,payload}}); }})().catch(e=>window.__flowBBatchPublish=JSON.stringify({{error:String(e),stack:e.stack}}));
'started';
"""
    chrome_js(batch, "publish", js)
    time.sleep(5)
    raw = chrome_js(batch, "read_publish_result", "window.__flowBBatchPublish || 'pending'\n")
    (batch / "publish_result_raw.txt").write_text(raw)
    result = json.loads(raw)
    (batch / "publish_result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    text = json.loads(result.get("text", "{}")) if isinstance(result.get("text"), str) else {}
    published = []
    if result.get("status") == 200 and text.get("code") == 1:
        pub = ROOT / "data/flow_b/published_links.csv"
        pub.parent.mkdir(parents=True, exist_ok=True)
        existing = set(pub.read_text().splitlines()) if pub.exists() else set()
        with pub.open("a") as f:
            for row in rows:
                if row["link"] not in existing:
                    f.write(row["link"] + "\n")
                    existing.add(row["link"])
                published.append(str(row["sku"]))
        by_sku = {str(x["sku"]): x for x in items}
        with (ROOT / "data/flow_b/candidates.jsonl").open("a") as f:
            for row in rows:
                item = by_sku.get(str(row["sku"]), {})
                pl = item.get("price_list") or {}
                f.write(json.dumps({
                    "run": str(batch), "ts": dt.datetime.now().isoformat(timespec="seconds"), "sku": row["sku"], "link": row["link"],
                    "decision": "published", "price": row["price"], "profit_rate": pl.get("profit_rate"), "profit": pl.get("profit"),
                    "cost": pl.get("purchase_price"), "logistics": (item.get("economy") or {}).get("title"),
                    "route": route_key, "category_label": route["label"], "shop_id": route["shop_id"],
                    "shop_name": route["shop_name"], "watermark_id": route["watermark_id"],
                    "watermark_name": route["watermark_name"], **compact_source_trace(item),
                }, ensure_ascii=False) + "\n")
    print("published", route["shop_name"], route["watermark_name"], len(published), published, flush=True)
    return published


def publish(batch: Path, items: list[dict]) -> list[str]:
    items = filter_unpublished_items(items, published_skus())
    routed: dict[str, list[dict]] = {key: [] for key in FLOW_B_DAILY_ROUTES}
    forced_route = os.environ.get("FLOW_B_FORCE_ROUTE")
    if forced_route and forced_route not in FLOW_B_DAILY_ROUTES:
        raise RuntimeError(f"unknown FLOW_B_FORCE_ROUTE: {forced_route}")
    route_sequence_raw = [x.strip() for x in os.environ.get("FLOW_B_ROUTE_SEQUENCE", "").split(",") if x.strip()]
    route_sequence: list[tuple[str, int | None]] = []
    route_cap_overrides: dict[str, int] = {}
    for token in route_sequence_raw:
        key, _, cap_text = token.partition(":")
        cap_override = int(cap_text) if cap_text else None
        route_sequence.append((key, cap_override))
        if cap_override is not None:
            route_cap_overrides[key] = cap_override
    if route_sequence:
        unknown_routes = [key for key, _ in route_sequence if key not in FLOW_B_DAILY_ROUTES]
        if unknown_routes:
            raise RuntimeError(f"unknown FLOW_B_ROUTE_SEQUENCE routes: {unknown_routes}")
        remaining: list[dict] = []
        idx = 0
        for key, cap_override in route_sequence:
            route = FLOW_B_DAILY_ROUTES[key]
            cap = int(cap_override if cap_override is not None else route["daily_cap"])
            group = items[idx:idx + cap]
            idx += len(group)
            for item in group:
                item["route"] = key
                item["route_label"] = route["label"]
            routed[key].extend(group)
        remaining = items[idx:]
        for item in remaining:
            item["route"] = "deferred_unassigned"
            item["route_label"] = "未分配店铺"
        if remaining:
            (batch / f"publish_deferred_unassigned_{dt.datetime.now().strftime('%Y%m%d')}.json").write_text(json.dumps(remaining, ensure_ascii=False, indent=2))
    else:
        for item in items:
            key = forced_route or route_category(item)
            item["route"] = key
            item["route_label"] = FLOW_B_DAILY_ROUTES[key]["label"]
            routed[key].append(item)

    publish_now: dict[str, list[dict]] = {}
    deferred: dict[str, list[dict]] = {}
    for key, route in FLOW_B_DAILY_ROUTES.items():
        group = routed.get(key, [])
        cap = int(route_cap_overrides.get(key, route["daily_cap"]))
        publish_now[key] = group[:cap]
        deferred[key] = group[cap:]

    routing_summary = {
        key: {
            "category": route["label"],
            "shop_id": route["shop_id"],
            "shop_name": route["shop_name"],
            "watermark_id": route["watermark_id"],
            "watermark_name": route["watermark_name"],
            "daily_cap": int(route_cap_overrides.get(key, route["daily_cap"])),
            "publish_now": len(publish_now[key]),
            "deferred_next_day": len(deferred[key]),
            "skus_now": [str(x.get("sku")) for x in publish_now[key]],
            "skus_deferred": [str(x.get("sku")) for x in deferred[key]],
        }
        for key, route in FLOW_B_DAILY_ROUTES.items()
    }
    (batch / f"publish_routing_summary_{dt.datetime.now().strftime('%Y%m%d')}.json").write_text(json.dumps(routing_summary, ensure_ascii=False, indent=2))
    all_deferred = [x for values in deferred.values() for x in values]
    if all_deferred:
        (batch / f"publish_deferred_next_day_by_store_{dt.datetime.now().strftime('%Y%m%d')}.json").write_text(json.dumps(deferred, ensure_ascii=False, indent=2))

    print("publish routing", json.dumps({k: {"now": v["publish_now"], "deferred": v["deferred_next_day"], "shop": v["shop_name"]} for k, v in routing_summary.items()}, ensure_ascii=False), flush=True)
    published: list[str] = []
    for key, group in publish_now.items():
        if not group:
            continue
        route = FLOW_B_DAILY_ROUTES[key]
        route_dir = batch / f"publish_{key}_{route['shop_id']}"
        published.extend(publish_one_route(route_dir, group, key, route))
    return published


def filter_unpublished_items(items: list[dict], done_skus: set[str]) -> list[dict]:
    return [item for item in items if str(item.get("sku") or "") not in done_skus]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: flow_b_process_batch.py BATCH_DIR", file=sys.stderr)
        return 2
    batch = Path(sys.argv[1]).resolve()
    candidates = fetch_favorites(batch)
    if not candidates:
        print("no candidates")
        return 0
    run_1688(batch, candidates)
    reliable = parse_costs(batch, candidates)
    pure = detail_extract(batch, reliable) if reliable else []
    calc = calc_profit(batch, pure) if pure else []
    passers = classify(batch, calc) if calc else []
    publish(batch, passers)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
