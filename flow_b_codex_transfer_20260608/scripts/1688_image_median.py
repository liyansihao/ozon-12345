#!/usr/bin/env python3
"""Search 1688 by image and print the median price of the top 3 by sales.

This script intentionally uses the same 1688 H5 endpoints that the web image
search page calls, via the lightweight `search1688api` package. It is meant for
Codex agents when browser automation of 1688 is blocked.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path


GENERIC_TOKENS = {
    "1",
    "шт",
    "sht",
    "art",
    "арт",
    "для",
    "the",
    "and",
    "with",
    "без",
    "无品牌",
}

CATEGORY_KEYWORDS = {
    "汽车防盗器遥控器套": ["钥匙套", "钥匙壳", "钥匙包", "保护壳", "汽车钥匙", "本田", "honda"],
    "空调滤清器": ["空调滤", "滤清器", "滤芯", "空滤", "汽车"],
    "自动变速器过滤器": ["变速箱滤", "变速器滤", "滤清器", "滤芯", "filter"],
}

BAD_ACCESSORY_HINTS = [
    "包装盒",
    "纸盒",
    "贴纸",
    "自行车灯",
    "车前灯",
    "洗车刷",
    "吸尘器",
    "毛刷",
]


def parse_int(value: object) -> int:
    if value is None:
        return 0
    match = re.search(r"\d+(?:\.\d+)?", str(value).replace(",", ""))
    return int(float(match.group(0))) if match else 0


def parse_price(data: dict) -> float | None:
    price_info = data.get("priceInfo") or {}
    for key in ("price", "priceUnderLine", "priceInteger"):
        value = price_info.get(key)
        if value not in (None, ""):
            try:
                return float(str(value).replace(",", ""))
            except ValueError:
                pass
    return None


def normalize_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").lower()).strip()


def split_tokens(value: str) -> list[str]:
    text = normalize_text(value)
    ascii_tokens = re.findall(r"[a-z0-9][a-z0-9-]{1,}", text)
    cn_tokens = re.findall(r"[\u4e00-\u9fff]{2,}", text)
    return [token for token in ascii_tokens + cn_tokens if token not in GENERIC_TOKENS]


def model_tokens(value: str) -> list[str]:
    tokens = split_tokens(value)
    return [token for token in tokens if re.search(r"\d", token) and len(token) >= 3]


def title_tokens(value: str) -> list[str]:
    tokens = split_tokens(value)
    useful: list[str] = []
    for token in tokens:
        if re.search(r"\d", token) and len(token) >= 3:
            useful.append(token)
        elif re.search(r"[\u4e00-\u9fff]", token) and len(token) >= 2:
            useful.append(token)
        elif len(token) >= 4:
            useful.append(token)
    return useful[:16]


def category_tokens(value: str) -> list[str]:
    tokens = []
    for key, keywords in CATEGORY_KEYWORDS.items():
        if key in value:
            tokens.extend(keywords)
    tokens.extend(split_tokens(value))
    return list(dict.fromkeys(tokens))


def count_hits(title: str, tokens: list[str]) -> int:
    normalized = normalize_text(title)
    return sum(1 for token in tokens if normalize_text(token) and normalize_text(token) in normalized)


def assess_match(rows: list[dict], expect_title: str, expect_model: str, expect_category: str, match_top: int) -> dict:
    top3 = rows[:3]
    match_window = rows[:match_top]
    model_needles = model_tokens(expect_model)
    title_needles = title_tokens(expect_title)
    category_needles = category_tokens(expect_category)
    weak_needles = [token for token in category_needles if token not in title_needles]

    scored = []
    for row in match_window:
        title = row.get("title", "")
        model_hits = count_hits(title, model_needles)
        title_hits = count_hits(title, title_needles)
        category_hits = count_hits(title, weak_needles)
        bad_hits = count_hits(title, BAD_ACCESSORY_HINTS)
        score = model_hits * 3 + title_hits * 2 + category_hits - bad_hits * 2
        scored.append(
            {
                "offerId": row.get("offerId"),
                "title": title,
                "model_hits": model_hits,
                "title_hits": title_hits,
                "category_hits": category_hits,
                "bad_hits": bad_hits,
                "score": score,
                "price": row.get("price"),
                "saleQuantity": row.get("saleQuantity"),
            }
        )

    matched = [item for item in scored if (item["model_hits"] or item["title_hits"] >= 2 or item["score"] >= 2) and item["bad_hits"] == 0]
    weak_matched = [item for item in scored if item["score"] > 0 and item["bad_hits"] == 0]
    top3_bad = sum(1 for item in scored[:3] if item["bad_hits"] > 0 and item["score"] <= 0)
    model_matched = [item for item in scored if item["model_hits"] and item["bad_hits"] == 0]
    matched_for_cost = model_matched if model_needles else (matched or weak_matched)
    matched_prices = [item["price"] for item in matched_for_cost[:3] if item.get("price") is not None]
    matched_median = statistics.median(matched_prices) if matched_prices else None

    if not top3:
        decision = "REJECT"
        reason = "no valid 1688 rows"
    elif model_needles and model_matched:
        decision = "ACCEPT"
        reason = "model token matched in search window"
    elif model_needles and not model_matched:
        decision = "REJECT"
        reason = "model token not found in search window"
    elif len(matched) >= 2:
        decision = "ACCEPT"
        reason = "at least two search-window results match title/category signals"
    elif len(weak_matched) >= 2:
        decision = "REVIEW"
        reason = "two weak matches; quick visual/title review recommended"
    elif top3_bad >= 2 or not weak_matched:
        decision = "REJECT"
        reason = "top results look unrelated or accessory-biased"
    else:
        decision = "REVIEW"
        reason = "only one plausible title/category match"

    return {
        "decision": decision,
        "reason": reason,
        "model_tokens": model_needles,
        "title_tokens": title_needles,
        "category_tokens": weak_needles,
        "match_top": match_top,
        "matched_prices": matched_prices,
        "matched_median_cost": matched_median,
        "scored_rows": scored,
    }


def load_session():
    try:
        from search1688api import Sync1688Session
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Missing dependency `search1688api`. Install with:\n"
            "python3 -m pip install search1688api requests aiohttp beautifulsoup4 lxml"
        ) from exc
    return Sync1688Session(debug=False)


def is_webp(path: Path) -> bool:
    with path.open("rb") as handle:
        header = handle.read(12)
    return header.startswith(b"RIFF") and header[8:12] == b"WEBP"


def normalize_image(image_path: Path, temp_dir: Path) -> tuple[Path, str | None]:
    """Convert Ozon WebP assets to JPEG before uploading to 1688."""
    if not is_webp(image_path):
        return image_path, None

    sips = shutil.which("sips")
    if not sips:
        return image_path, "Input is WebP, but `sips` was not found; uploading original file."

    converted = temp_dir / f"{image_path.stem}_1688.jpg"
    try:
        subprocess.run(
            [sips, "-s", "format", "jpeg", str(image_path), "--out", str(converted)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        message = (exc.stderr or "").strip()
        return image_path, f"WebP-to-JPEG conversion failed; uploading original file. {message}"

    return converted, f"Converted WebP input to JPEG for 1688 upload: {converted}"


def summarize_products(raw_products: list[dict]) -> list[dict]:
    rows: list[dict] = []
    for product in raw_products:
        data = product.get("data", {}) if isinstance(product, dict) else {}
        price = parse_price(data)
        sale = parse_int(data.get("saleQuantity") or (data.get("afterPrice") or {}).get("text"))
        if price is None or not sale:
            continue
        rows.append(
            {
                "offerId": data.get("offerId"),
                "title": data.get("title", ""),
                "price": price,
                "saleQuantity": sale,
                "shop": (data.get("shop") or {}).get("text") or data.get("loginId"),
                "pic": data.get("offerPicUrl") or data.get("odPicUrl"),
                "url": data.get("linkUrl"),
            }
        )
    return sorted(rows, key=lambda row: row["saleQuantity"], reverse=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="Path to the product image crop")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON only")
    parser.add_argument("--top", type=int, default=10, help="How many sorted rows to show")
    parser.add_argument("--expect-title", default="", help="Ozon product title for fast match screening")
    parser.add_argument("--expect-model", default="", help="Product model/article/SKU-like text for strong matching")
    parser.add_argument("--expect-category", default="", help="Ozon/Maozi category text for fast match screening")
    parser.add_argument("--match-top", type=int, default=10, help="How many high-sales rows to scan for title/model matches")
    args = parser.parse_args()

    image_path = Path(args.image).expanduser().resolve()
    if not image_path.exists():
        raise SystemExit(f"Image not found: {image_path}")

    with tempfile.TemporaryDirectory(prefix="1688-image-") as temp_name:
        upload_path, note = normalize_image(image_path, Path(temp_name))
        session = load_session()
        raw_products = session.search_by_image(str(upload_path))
    rows = summarize_products(raw_products)
    top3 = rows[:3]
    median = statistics.median([row["price"] for row in top3]) if top3 else None

    payload = {
        "image": str(image_path),
        "upload_image": str(upload_path),
        "note": note,
        "valid_count": len(rows),
        "top3_prices": [row["price"] for row in top3],
        "median_cost": median,
        "match": assess_match(rows, args.expect_title, args.expect_model, args.expect_category, args.match_top)
        if (args.expect_title or args.expect_model or args.expect_category)
        else None,
        "top_rows": rows[: args.top],
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    if note:
        print(f"NOTE {note}")
    print(f"VALID_COUNT {payload['valid_count']}")
    for index, row in enumerate(payload["top_rows"], 1):
        title = row["title"][:80]
        print(
            f"{index}. sale={row['saleQuantity']} price={row['price']} "
            f"offer={row['offerId']} shop={row.get('shop') or ''} title={title}"
        )
    print("TOP3_PRICES", payload["top3_prices"])
    print("MEDIAN_COST", payload["median_cost"])
    if payload["match"]:
        print("MATCH_DECISION", payload["match"]["decision"])
        print("MATCH_REASON", payload["match"]["reason"])
        print("MATCH_MODEL_TOKENS", payload["match"]["model_tokens"])
        print("MATCH_TITLE_TOKENS", payload["match"]["title_tokens"])
        print("MATCHED_PRICES", payload["match"]["matched_prices"])
        print("MATCHED_MEDIAN_COST", payload["match"]["matched_median_cost"])
    return 0 if median is not None else 2


if __name__ == "__main__":
    sys.exit(main())
