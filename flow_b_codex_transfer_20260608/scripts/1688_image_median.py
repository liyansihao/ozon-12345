#!/usr/bin/env python3
"""Search 1688 by image and estimate procurement cost from first-page matches.

This script intentionally uses the same 1688 H5 endpoints that the web image
search page calls, via the lightweight `search1688api` package. It is meant for
Codex agents when browser automation of 1688 is blocked.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import io
import json
import math
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

import requests
from PIL import Image, ImageOps


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

WEAK_EVIDENCE_TOKENS = {
    "type",
    "usb",
    "pro",
    "max",
    "mini",
    "plus",
    "new",
    "original",
    "universal",
    "универсальный",
    "оригинальный",
    "новый",
}

FEATURE_TOKENS = {
    "iphone",
    "magsafe",
    "android",
    "apple",
    "samsung",
    "xiaomi",
    "huawei",
}

ACCESSORY_INTENT_HINTS = {
    "adapter",
    "adaptor",
    "converter",
    "переходник",
    "адаптер",
    "转换器",
    "转接头",
    "转接器",
    "保护膜",
    "包装盒",
    "packaging",
}

IMAGE_HIGH_SIMILARITY = 0.78
IMAGE_VERY_HIGH_SIMILARITY = 0.90
IMAGE_CORROBORATION_SIMILARITY = 0.58
IMAGE_ONLY_SIMILARITY = 0.86
IMAGE_COMPARE_TIMEOUT_SECONDS = 0.75
IMAGE_FIRST_PROBE_TIMEOUT_SECONDS = 0.6

PRODUCT_SEMANTIC_GROUPS = [
    ("sweater", {"свитер", "джемпер", "sweater", "cardigan", "毛衣", "毛衫", "针织", "开衫"}),
    ("protective_film", {"стекло", "пленка", "плёнка", "glass", "film", "保护膜", "钢化膜", "手机膜", "玻璃膜"}),
    ("camera_lens", {"камера", "объектив", "camera", "lens", "镜头", "摄像头"}),
    ("data_cable", {"кабель", "провод", "cable", "wire", "数据线", "充电线", "线缆"}),
    ("adapter", {"переходник", "адаптер", "adapter", "adaptor", "converter", "转接头", "转换器", "适配器"}),
    ("phone_case", {"чехол", "case", "cover", "手机壳", "保护壳", "外壳"}),
    ("card_holder", {"картхолдер", "кошелек", "wallet", "cardholder", "卡包", "卡套", "钱包", "卡夹"}),
    ("ribbon", {"лента", "ribbon", "丝带", "彩带", "包装带"}),
    ("lamp", {"лампа", "фонарь", "light", "lamp", "灯", "台灯", "手电筒"}),
    ("battery", {"аккумулятор", "battery", "电池", "蓄电池"}),
]

CATEGORY_KEYWORDS = {
    "汽车防盗器遥控器套": ["钥匙套", "钥匙壳", "钥匙包", "保护壳", "汽车钥匙", "本田", "honda"],
    "空调滤清器": ["空调滤", "滤清器", "滤芯", "空滤", "汽车"],
    "自动变速器过滤器": ["变速箱滤", "变速器滤", "滤清器", "滤芯", "filter"],
}

BAD_ACCESSORY_HINTS = [
    "包装盒",
    "纸盒",
    "贴纸",
    "配件",
    "accessory",
    "sticker",
    "box",
    "packaging",
    "only",
    "自行车灯",
    "车前灯",
    "洗车刷",
    "吸尘器",
    "毛刷",
]

ADAPTIVE_MATCH_VERSION = "adaptive-v5-shadow"
ADAPTIVE_POLICY_VERSION = "adaptive-v5-policy-1"
VALUABLE_DIGITAL_THRESHOLD_CNY = 300.0

# These terms are deliberately narrow.  The legacy decision layer only hard-rejects an
# explicit contradiction; an unknown translation or an omitted field remains
# reviewable evidence instead of being treated as a mismatch.
ADAPTIVE_PRODUCT_GROUPS = {
    "jewelry_charm": {"charm", "шарм*", "首饰挂件", "饰品挂件", "串珠配件"},
    "bracelet": {"bracelet", "bangle", "браслет*", "手链", "手镯", "手串"},
    "toy_building_blocks": {
        "building blocks", "construction blocks", "строительные блоки", "конструктор",
        "积木", "拼装积木",
    },
    "remote_control": {
        "remote control", "rc", "дистанционного управления", "дистанционное управление",
        "радиоуправляем*", "遥控",
    },
    "shampoo": {"shampoo", "шампун*", "洗发水", "洗发露", "洗头膏"},
    "filled_consumable": {
        "face wash", "cleanser", "massage oil", "perfume", "fragrance", "degreaser",
        "facial mask", "гел*", "пенк*", "масл*", "парфюм*", "ароматизатор*",
        "обезжиривател*", "маска для лица", "крем*", "лосьон*", "сыворот*",
    },
    "bottle": {
        "empty bottle", "dispensing bottle", "refill bottle", "分装瓶", "空瓶", "按压瓶",
        "喷雾瓶", "瓶子", "塑料瓶", "泡沫瓶", "铝瓶", "包装瓶", "包材",
    },
    "earbuds": {"earbud", "earbuds", "headphone", "headphones", "airpods*", "наушник*", "耳机", "耳塞"},
    "earbud_accessory": {
        "earbud case", "earphone case", "charging case only", "чехол для наушников",
        "耳机壳", "耳机套", "耳机保护壳", "耳机保护套", "耳机充电盒",
    },
    "protective_film": {"protective film", "tempered glass", "стекл*", "пленк*", "плёнк*", "钢化膜", "保护膜", "手机膜"},
    "phone_case": {
        "phone case", "protective case", "чехол", "чехл*", "手机壳", "保护壳",
        "手机保护套", "保护套",
    },
    "phone": {"smartphone", "mobile phone", "iphone*", "смартфон*", "телефон*", "智能手机", "手机"},
    "dummy_phone": {"dummy phone", "mock phone", "муляж", "模型机", "展示机", "样板机"},
    "tablet": {"tablet", "tablet pc", "ipad*", "планшет*", "平板电脑", "平板"},
    "tablet_accessory": {
        "tablet case", "tablet cover", "чехол для планшета", "平板保护壳", "平板保护套",
        "平板支架",
    },
    "computer": {
        "computer", "laptop", "notebook computer", "desktop pc", "macbook*", "thinkpad*",
        "ноутбук*", "компьютер*",
        "笔记本电脑", "台式电脑", "电脑整机",
    },
    "computer_accessory": {
        "laptop case", "laptop sleeve", "laptop stand", "notebook bag", "ноутбук чехол",
        "电脑包", "笔记本保护套", "笔记本支架",
    },
    "watch": {"smartwatch", "smart watch", "watch", "умные часы", "смарт часы", "手表", "智能手表"},
    "watch_accessory": {
        "watch bezel", "watch strap", "watch band", "ремешок", "ремешка", "ремень",
        "браслет для часов", "表圈", "表带", "手表壳", "手表套",
    },
    "vr_headset": {"vr headset", "virtual reality headset", "oculus", "quest", "vr очки", "头显", "vr眼镜"},
    "vr_accessory": {"vr case", "headset case", "storage bag", "carrying case", "收纳包", "头显保护套", "vr保护套"},
    "drone": {"drone", "quadcopter", "дрон*", "квадрокоптер*", "无人机"},
    "drone_accessory": {
        "drone case", "drone propeller", "propeller guard", "чехол для дрона", "пропеллер*",
        "无人机收纳包", "无人机桨叶", "螺旋桨",
    },
    "game_console": {
        "game console", "gaming console", "игровая приставка", "playstation", "xbox",
        "nintendo switch", "steam deck", "游戏机", "游戏主机", "掌机",
    },
    "game_accessory": {
        "game controller", "gamepad", "console case", "controller", "геймпад*", "джойстик*",
        "游戏手柄", "手柄", "游戏机保护套",
    },
    "camera": {"digital camera", "камер*", "фотоаппарат*", "数码相机", "照相机"},
    "camera_accessory": {
        "camera case", "camera protector", "camera glass", "lens protector", "camera bag",
        "защита камеры", "защита камер", "стекло камеры", "相机包", "镜头膜", "镜头保护膜",
        "摄像头膜", "摄像头保护膜",
    },
    "lamp": {"lamp", "light", "фонар*", "ламп*", "台灯", "灯具", "手电筒"},
    "cable": {"cable", "wire", "кабел*", "провод*", "数据线", "充电线"},
    "adapter": {"adapter", "adaptor", "converter", "адаптер*", "переходник*", "适配器", "转接头"},
    "sweater": {"sweater", "cardigan", "свитер*", "джемпер*", "毛衣", "毛衫", "针织衫"},
}

# These are option-defining roles.  When the target explicitly asks for one,
# a generic product from the same broad category is reviewable evidence, not a
# confirmed match and not a hard contradiction.
ADAPTIVE_REQUIRED_PRODUCT_ROLES = {"jewelry_charm", "remote_control"}

VALUABLE_DIGITAL_CORE_ROLES = {
    "phone": "phone",
    "tablet": "tablet",
    "computer": "computer",
    "camera": "camera",
    "drone": "drone",
    "vr_headset": "vr",
    "game_console": "game_console",
    "watch": "smartwatch",
    "earbuds": "branded_earbuds",
}

VALUABLE_DIGITAL_ACCESSORY_ROLES = {
    "adapter", "cable", "camera_accessory", "computer_accessory", "drone_accessory",
    "dummy_phone", "earbud_accessory", "game_accessory", "phone_case", "protective_film",
    "tablet_accessory", "vr_accessory", "watch_accessory",
}

ADAPTIVE_STYLE_GROUPS = {
    "bumper": {"bumper", "бампер*", "边框壳", "边框保护壳"},
    "case_film_combo": {"case film combo", "壳膜一体", "膜壳一体", "钢化膜一体"},
    "soft_mesh": {
        "soft mesh", "mesh band", "мягкая сетка", "мягкой сетки", "мягкую сетку",
        "милан*", "不锈钢网带", "钢网表带", "网带", "米兰尼斯",
    },
    "braided": {"braided", "woven", "плетен*", "编织"},
    "folio": {"folio case", "book cover", "чехол-книжк*", "翻盖保护套", "皮套"},
    "magnetic": {"magnetic", "magnet", "магнит*", "с магнитом", "磁吸", "磁性"},
    "stand": {"stand", "kickstand", "подставк*", "支架"},
    "auto_wake": {
        "auto wake", "auto sleep", "sleep wake", "авто сон", "пробуждени*",
        "自动休眠", "智能休眠", "休眠唤醒", "自动唤醒",
    },
}

ADAPTIVE_MODEL_QUALIFIERS = {
    "air", "edge", "fe", "lite", "max", "mini", "neo", "nfc", "plus", "pro", "promax",
    "promini", "proplus", "s", "se", "t", "u", "ultra",
}

ADAPTIVE_SPEC_UNITS = {
    "w", "v", "a", "mah", "ml", "l", "mm", "cm", "m", "g", "kg",
    "вт", "в", "а", "мач", "мл", "л", "мм", "см", "м", "г", "кг",
    "瓦", "伏", "安", "毫安", "毫升", "升", "毫米", "厘米", "米", "克", "千克",
    "pcs", "pc", "pack", "шт", "штук", "件", "个", "只", "套",
}

ADAPTIVE_BRAND_ALIASES = {
    "apple": "apple", "iphone": "apple", "iphone*": "apple", "ipad": "apple", "ipad*": "apple",
    "macbook": "apple", "macbook*": "apple", "airpods": "apple", "airpods*": "apple",
    "samsung": "samsung", "galaxy": "samsung",
    "huawei": "huawei", "honor": "honor",
    "xiaomi": "xiaomi", "redmi": "redmi", "poco": "poco",
    "oneplus": "oneplus", "oppo": "oppo", "realme": "realme", "vivo": "vivo",
    "iqoo": "iqoo", "zte": "zte", "nubia": "nubia", "meizu": "meizu",
    "motorola": "motorola", "nokia": "nokia", "tecno": "tecno", "infinix": "infinix",
    "google": "google", "pixel": "google",
    "sony": "sony", "playstation": "sony",
    "microsoft": "microsoft", "surface": "microsoft", "xbox": "microsoft",
    "nintendo": "nintendo", "valve": "valve",
    "meta": "meta", "oculus": "meta", "dji": "dji",
    "lenovo": "lenovo", "thinkpad": "lenovo", "legion": "lenovo",
    "asus": "asus", "acer": "acer", "dell": "dell", "hp": "hp", "msi": "msi", "razer": "razer",
    "canon": "canon", "nikon": "nikon", "fujifilm": "fujifilm", "panasonic": "panasonic",
    "olympus": "olympus", "leica": "leica", "gopro": "gopro", "insta360": "insta360",
    "garmin": "garmin", "amazfit": "amazfit", "huami": "amazfit",
    "jbl": "jbl", "bose": "bose", "nothing": "nothing", "anker": "anker",
    "soundcore": "anker", "marshall": "marshall", "beats": "beats", "sennheiser": "sennheiser",
    "三星": "samsung",
    "华为": "huawei",
    "小米": "xiaomi",
    "红米": "redmi",
    "荣耀": "honor",
    "真我": "realme",
    "一加": "oneplus",
    "维沃": "vivo",
    "欧珀": "oppo",
    "苹果": "apple",
    "索尼": "sony",
    "中兴": "zte",
    "魅族": "meizu", "努比亚": "nubia", "摩托罗拉": "motorola", "诺基亚": "nokia",
    "谷歌": "google", "微软": "microsoft", "任天堂": "nintendo", "联想": "lenovo",
    "华硕": "asus", "宏碁": "acer", "戴尔": "dell", "惠普": "hp", "雷蛇": "razer",
    "佳能": "canon", "尼康": "nikon", "富士": "fujifilm", "松下": "panasonic",
    "奥林巴斯": "olympus", "徕卡": "leica", "大疆": "dji", "影石": "insta360",
    "佳明": "garmin", "华米": "amazfit", "森海塞尔": "sennheiser",
    "самсунг": "samsung", "хуавей": "huawei", "хонор": "honor", "сяоми": "xiaomi",
    "ксиаоми": "xiaomi", "редми": "redmi", "реалми": "realme", "ванплас": "oneplus",
    "оппо": "oppo", "виво": "vivo", "эппл": "apple", "айфон": "apple",
    "сони": "sony", "леново": "lenovo", "асус": "asus", "асер": "acer",
    "нокиа": "nokia", "моторола": "motorola", "кэнон": "canon", "канон": "canon",
    "никон": "nikon", "гармин": "garmin", "нинтендо": "nintendo",
}

# 1688 supplier titles commonly concatenate a Latin brand with a model family
# and then switch directly into Chinese, for example ``SamsungGalaxyS24手机壳``
# or ``VivoV70手机壳``.  Keep these continuations explicit and brand-specific:
# the generic semantic matcher must retain real token boundaries so ordinary
# words such as ``wireless``, ``honorary`` and ``metadata`` are never mined for
# embedded product or brand substrings.
ADAPTIVE_BRAND_COMPACT_FOLLOWERS = {
    "apple": (r"(?:iphone|ipad|macbook|airpods|watch)",),
    "meta": (r"quest",),
    "oculus": (r"quest",),
    "samsung": (r"galaxy",),
    "galaxy": (r"(?:buds|watch|tab)\d", r"[sazmf]\d"),
    "huawei": (r"(?:mate|nova|pura|freebuds|watch|fit|band)",),
    "honor": (r"(?:magic|play|pad|watch|choice)", r"x\d", r"\d"),
    "oneplus": (r"(?:nord|ace|open|buds|watch|pad)", r"\d"),
    "oppo": (r"(?:find|reno|watch|pad)", r"[akf]\d"),
    "realme": (r"(?:gt|narzo|note|buds|watch|pad)\d", r"c\d", r"\d"),
    "vivo": (r"[vxyst]\d",),
    "iqoo": (r"(?:neo|z)\d", r"\d"),
    "xiaomi": (r"(?:mix|civi|redmi|poco)", r"\d"),
    "redmi": (r"(?:watch|note|buds)\d", r"[ka]\d", r"\d"),
    "poco": (r"[xmfc]\d",),
    "google": (r"pixel\d",),
    "pixel": (r"\d",),
    "sony": (r"(?:alpha|xperia|playstation|wh|wf)\d",),
    "playstation": (r"\d",),
    "microsoft": (r"(?:surface|xbox)",),
    "surface": (r"(?:pro|go|laptop|book)\d", r"\d"),
    "nintendo": (r"switch",),
    "valve": (r"steamdeck",),
    "dji": (r"(?:mavic|mini|air|avata|neo|osmo)\d",),
    "lenovo": (r"(?:legion|yoga|ideapad|loq)\d", r"thinkpad[xtpel]\d"),
    "thinkpad": (r"[xtpel]\d",),
    "asus": (r"(?:rog|zenbook|vivobook|tuf)\d",),
    "canon": (r"(?:eos|powershot)[a-z]?\d",),
    "nikon": (r"(?:coolpix|z)\d",),
    "gopro": (r"hero\d",),
    "garmin": (r"(?:fenix|forerunner|venu|instinct|vivoactive)\d",),
    "amazfit": (r"(?:bip|gtr|gts|active|balance|trex)\d",),
}

ADAPTIVE_KNOWN_BRANDS = set(ADAPTIVE_BRAND_ALIASES.values())

# The legacy FAST/REVIEW/REJECT scorer keeps its pre-v5 brand vocabulary so
# adding policy aliases cannot silently rewrite historical decision semantics.
ADAPTIVE_LEGACY_BRAND_ALIASES = {
    "apple": "apple", "honor": "honor", "huawei": "huawei", "oneplus": "oneplus",
    "oppo": "oppo", "poco": "poco", "realme": "realme", "redmi": "redmi",
    "samsung": "samsung", "sony": "sony", "vivo": "vivo", "xiaomi": "xiaomi", "zte": "zte",
    "三星": "samsung", "华为": "huawei", "小米": "xiaomi", "红米": "redmi",
    "荣耀": "honor", "真我": "realme", "一加": "oneplus", "维沃": "vivo",
    "欧珀": "oppo", "苹果": "apple", "索尼": "sony", "中兴": "zte",
}


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
    cyrillic_tokens = re.findall(r"[а-яё][а-яё0-9-]{1,}", text, flags=re.IGNORECASE)
    cn_tokens = re.findall(r"[\u4e00-\u9fff]{2,}", text)
    return [token for token in ascii_tokens + cyrillic_tokens + cn_tokens if token not in GENERIC_TOKENS]


def high_information_tokens(value: str) -> list[str]:
    """Return title evidence that cannot be satisfied by numbers or generic feature words alone."""
    useful: list[str] = []
    for token in split_tokens(value):
        normalized = normalize_text(token)
        if not normalized or normalized in WEAK_EVIDENCE_TOKENS or normalized in FEATURE_TOKENS:
            continue
        if normalized.isdigit():
            continue
        if re.fullmatch(r"[a-z]+", normalized) and len(normalized) < 4:
            continue
        if re.search(r"[\u4e00-\u9fff]", normalized) and len(normalized) < 2:
            continue
        useful.append(normalized)
    return list(dict.fromkeys(useful))[:20]


def feature_tokens(value: str) -> list[str]:
    return [token for token in split_tokens(value) if normalize_text(token) in FEATURE_TOKENS]


def product_semantic_match(expected_value: str, returned_value: str) -> dict:
    expected = normalize_text(expected_value)
    returned = normalize_text(returned_value)
    expected_groups = [
        (name, terms)
        for name, terms in PRODUCT_SEMANTIC_GROUPS
        if any(term in expected for term in terms)
    ]
    hits = [
        name
        for name, terms in expected_groups
        if any(term in returned for term in terms)
    ]
    missing = [name for name, _terms in expected_groups if name not in hits]
    return {"hits": hits, "missing": missing}


def model_tokens(value: str) -> list[str]:
    tokens = split_tokens(value)
    return [token for token in tokens if re.search(r"\d", token) and not token.isdigit() and len(token) >= 2]


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


def matching_tokens(title: str, tokens: list[str]) -> list[str]:
    normalized = normalize_text(title)
    return sorted({
        normalized_token
        for token in tokens
        if (normalized_token := normalize_text(token)) and normalized_token in normalized
    })


def normalize_supplier(value: object) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fffа-яё]+", "", normalize_text(value), flags=re.IGNORECASE)


def extract_specs(value: str) -> dict[str, list[str]]:
    """Extract only comparison-safe quantity and technical specifications."""
    text = normalize_text(value).replace("×", "x")
    specs: dict[str, list[str]] = {}

    def add(kind: str, raw: str) -> None:
        normalized = re.sub(r"\s+", "", raw.lower())
        specs.setdefault(kind, [])
        if normalized not in specs[kind]:
            specs[kind].append(normalized)

    patterns = {
        "power": r"\b\d+(?:\.\d+)?\s*(?:w|瓦|вт)\b",
        "capacity": r"\b\d+(?:\.\d+)?\s*(?:mah|м ач|мач|毫安(?:时)?)\b",
        "length": r"\b\d+(?:\.\d+)?\s*(?:mm|cm|m|мм|см|м|毫米|厘米|米)\b",
        "count": r"\b\d+\s*(?:pcs?|pack|шт|штук|件|个|只|套)\b",
        "voltage": r"\b\d+(?:\.\d+)?\s*(?:v|伏|в)\b",
    }
    for kind, pattern in patterns.items():
        for match in re.finditer(pattern, text, flags=re.IGNORECASE):
            add(kind, match.group(0))
    for match in re.finditer(r"\b\d+(?:\.\d+)?\s*[xх]\s*\d+(?:\.\d+)?(?:\s*[xх]\s*\d+(?:\.\d+)?)?\s*(?:mm|cm|m|мм|см|毫米|厘米)?\b", text):
        add("dimensions", match.group(0))
    return specs


def spec_conflicts(expected: dict[str, list[str]], returned: dict[str, list[str]]) -> list[str]:
    conflicts: list[str] = []
    for kind in sorted(set(expected) & set(returned)):
        left = set(expected.get(kind) or [])
        right = set(returned.get(kind) or [])
        if left and right and left.isdisjoint(right):
            conflicts.append(kind)
    return conflicts


def accessory_conflict(expected_text: str, returned_text: str) -> bool:
    expected = normalize_text(expected_text)
    returned = normalize_text(returned_text)
    expected_hints = {hint for hint in ACCESSORY_INTENT_HINTS if hint in expected}
    returned_hints = {hint for hint in ACCESSORY_INTENT_HINTS if hint in returned}
    return bool(returned_hints and not expected_hints)


def _adaptive_text(value: object) -> str:
    return normalize_text(unicodedata.normalize("NFKC", str(value or "")))


def _adaptive_word_tokens(value: object) -> list[str]:
    return re.findall(r"[a-z0-9]+|[а-яё]+|[\u4e00-\u9fff]+", _adaptive_text(value))


def _adaptive_term_matches(text: str, term: str) -> bool:
    """Match semantic terms without treating a word as an arbitrary substring.

    Chinese product terms intentionally remain substring matches because titles
    normally concatenate them.  Latin and Cyrillic terms require token
    boundaries; a terminal ``*`` explicitly opts a Russian stem into suffix
    matching.  Thus ``wire`` no longer labels ``wireless`` as a cable while
    ``наушник*`` still covers normal Russian inflections.
    """
    normalized = _adaptive_text(term)
    if not normalized:
        return False
    if re.search(r"[\u4e00-\u9fff]", normalized):
        return normalized in text
    stem = normalized.endswith("*")
    if stem:
        normalized = normalized[:-1]
    escaped = re.escape(normalized).replace(r"\ ", r"[\s_-]+")
    suffix = r"[a-zа-яё0-9-]*" if stem else ""
    return bool(re.search(
        rf"(?<![a-zа-яё0-9]){escaped}{suffix}(?![a-zа-яё0-9])",
        text,
        flags=re.IGNORECASE,
    ))


def _adaptive_brand_alias_matches(text: str, alias: str) -> bool:
    """Match one explicit brand alias, including whitelisted compact titles."""
    if _adaptive_term_matches(text, alias):
        return True
    normalized = _adaptive_text(alias)
    if not normalized or normalized.endswith("*") or not re.fullmatch(r"[a-z0-9]+", normalized):
        return False
    followers = ADAPTIVE_BRAND_COMPACT_FOLLOWERS.get(normalized, ())
    if not followers:
        return False
    follower_pattern = "|".join(followers)
    return bool(re.search(
        rf"(?<![a-z0-9]){re.escape(normalized)}(?:{follower_pattern})[a-z0-9-]*(?![a-z0-9])",
        text,
        flags=re.IGNORECASE,
    ))


def _adaptive_product_types(value: object) -> set[str]:
    text = _adaptive_text(value)
    groups = {
        group
        for group, terms in ADAPTIVE_PRODUCT_GROUPS.items()
        if any(_adaptive_term_matches(text, term) for term in terms)
    }
    # Product role wins over a bare noun.  A title such as “чехол для
    # наушников” describes an earbud case, not the earbuds themselves; the
    # same applies to camera glass and watch straps.  This prevents correct
    # accessories from being rejected as accessories of a requested product.
    russian_case = r"(?<![а-яё])чех(?:ол|л[а-яё-]*)(?![а-яё])"
    russian_earbud = r"(?<![а-яё])наушник[а-яё-]*(?![а-яё])"
    earbud_accessory_context = any((
        re.search(rf"{russian_case}[^\n]{{0,48}}{russian_earbud}", text),
        re.search(rf"{russian_earbud}[^\n]{{0,48}}{russian_case}", text),
        re.search(r"(?:earbud|earphone|headphone)[^\n]{0,32}(?:case|cover)", text),
        re.search(r"(?:case|cover)[^\n]{0,32}(?:earbud|earphone|headphone)", text),
        re.search(r"耳机[^\n]{0,12}(?:壳|套|保护)", text),
    ))
    if earbud_accessory_context:
        groups.add("earbud_accessory")
        groups.discard("earbuds")
        groups.discard("phone_case")

    camera_accessory_context = any((
        re.search(r"(?:защит|стекл|пленк|плёнк)[а-яё-]*[^\n]{0,32}камер", text),
        re.search(r"камер[^\n]{0,32}(?:защит|стекл|пленк|плёнк)", text),
        re.search(r"(?:camera|lens)[^\n]{0,24}(?:protector|glass|film|cover)", text),
        re.search(r"(?:protector|glass|film|cover)[^\n]{0,24}(?:camera|lens)", text),
        re.search(r"(?:镜头|摄像头)[^\n]{0,12}(?:膜|保护|玻璃)", text),
    ))
    if camera_accessory_context:
        groups.add("camera_accessory")
        groups.discard("camera")

    watch_accessory_context = any((
        re.search(r"ремеш(?:ок|ка|ки|ку|ком|ков)?", text),
        re.search(r"(?:watch|band)[^\n]{0,28}(?:strap|band|adapter|connector|case)", text),
        re.search(r"(?:strap|adapter|connector)[^\n]{0,28}(?:watch|band)", text),
        re.search(r"(?:表带|表圈|手表壳|手表套|连接器|连接头|金属头)", text),
    ))
    if watch_accessory_context:
        groups.add("watch_accessory")
        groups.discard("watch")

    # English Ozon and supplier titles often identify an accessory as a bare
    # device family plus ``case``/``cover`` rather than saying “phone case” or
    # “tablet case”.  Bind that noun to an explicit device family so a costly
    # accessory never enters the >=CNY300 whole-device gate.  These patterns are
    # intentionally local product-family dictionaries, not arbitrary brand or
    # substring inference.
    accessory_noun = r"(?<![a-z])(?:case|cover|bag|sleeve|stand|protector)s?(?![a-z])"

    def device_accessory_context(device_pattern: str) -> bool:
        device = rf"(?<![a-z0-9])(?:{device_pattern})"
        return bool(
            re.search(rf"{device}[^\n]{{0,48}}{accessory_noun}", text)
            or re.search(rf"{accessory_noun}[^\n]{{0,48}}{device}", text)
        )

    if device_accessory_context(
        r"(?:iphone[a-z0-9-]*|samsung[\s_-]*galaxy[a-z0-9-]*|"
        r"galaxy[\s_-]*[sazmf]\d[a-z0-9-]*|(?:google[\s_-]*)?pixel[\s_-]*\d[a-z0-9-]*)"
    ):
        groups.add("phone_case")
        groups.discard("phone")
    if device_accessory_context(r"ipad[a-z0-9-]*"):
        groups.add("tablet_accessory")
        groups.discard("tablet")
    if device_accessory_context(
        r"(?:macbook[a-z0-9-]*|thinkpad[a-z0-9-]*|"
        r"(?:microsoft[\s_-]*)?surface(?:[\s_-]*(?:pro|go|laptop|book))?[a-z0-9-]*)"
    ):
        groups.add("computer_accessory")
        groups.discard("computer")
    if device_accessory_context(
        r"(?:(?:meta[\s_-]*|oculus[\s_-]*)?quest[a-z0-9-]*|oculus[a-z0-9-]*)"
    ):
        groups.add("vr_accessory")
        groups.discard("vr_headset")
    if device_accessory_context(
        r"(?:playstation[a-z0-9-]*|ps\d[a-z0-9-]*|xbox[a-z0-9-]*|"
        r"(?:nintendo[\s_-]*)?switch[a-z0-9-]*|steam[\s_-]*deck[a-z0-9-]*)"
    ):
        groups.add("game_accessory")
        groups.discard("game_console")

    if "phone_case" in groups:
        groups.discard("phone")
    return groups


def _adaptive_styles(value: object) -> set[str]:
    text = _adaptive_text(value)
    return {
        style
        for style, terms in ADAPTIVE_STYLE_GROUPS.items()
        if any(_adaptive_term_matches(text, term) for term in terms)
    }


def _adaptive_product_conflicts(expected: set[str], returned: set[str]) -> list[str]:
    conflicts: list[str] = []

    def incompatible(left: str, right: str, *, returned_without: str | None = None) -> None:
        if left not in expected or right not in returned:
            return
        if returned_without and returned_without in returned:
            return
        conflicts.append(f"product_accessory:{left}!={right}")

    if "bottle" not in expected:
        incompatible("shampoo", "bottle")
        incompatible("filled_consumable", "bottle")
    if "earbud_accessory" not in expected:
        incompatible("earbuds", "earbud_accessory")
    if "phone_case" not in expected:
        incompatible("phone", "phone_case")
    if "protective_film" not in expected:
        incompatible("phone", "protective_film")
    if "dummy_phone" not in expected:
        incompatible("phone", "dummy_phone")
    if "watch_accessory" not in expected:
        incompatible("watch", "watch_accessory")
    if "protective_film" not in expected:
        incompatible("watch", "protective_film")
    if "vr_accessory" not in expected:
        incompatible("vr_headset", "vr_accessory")
    if "camera_accessory" not in expected:
        incompatible("camera", "camera_accessory")
    incompatible("protective_film", "phone_case", returned_without="protective_film")
    incompatible("phone_case", "protective_film", returned_without="phone_case")
    incompatible("cable", "adapter", returned_without="cable")
    incompatible("adapter", "cable", returned_without="adapter")
    return conflicts


def _adaptive_brands(value: object) -> set[str]:
    text = _adaptive_text(value)
    # v5 brand policy is dictionary-only: every accepted spelling is listed
    # locally and matched on a real word boundary (Chinese aliases remain
    # explicit substring entries because supplier titles concatenate words).
    return {
        canonical
        for alias, canonical in ADAPTIVE_BRAND_ALIASES.items()
        if _adaptive_brand_alias_matches(text, alias)
    }


def _adaptive_legacy_brands(value: object) -> set[str]:
    text = _adaptive_text(value)
    return {
        canonical
        for alias, canonical in ADAPTIVE_LEGACY_BRAND_ALIASES.items()
        if _adaptive_brand_alias_matches(text, alias)
    }


def _adaptive_brand_families(brands: set[str]) -> set[str]:
    # Redmi and Poco are explicit Xiaomi product families in the local policy
    # dictionary.  No other corporate-ownership inference is performed.
    return {"xiaomi" if brand in {"redmi", "poco"} else brand for brand in brands}


def _adaptive_legacy_brand_families(brands: set[str]) -> set[str]:
    return {"xiaomi" if brand == "redmi" else brand for brand in brands}


def _adaptive_materials(value: object) -> set[str]:
    text = _adaptive_text(value)
    materials: set[str] = set()
    if re.search(r"hydrogel|гидрогел|水凝", text):
        materials.add("hydrogel")
    if re.search(r"tempered\s+glass|закаленн[а-яё-]*\s+стекл|钢化(?:膜|玻璃)", text):
        materials.add("tempered_glass")
    if re.search(r"(?<![a-z])silicon(?:e)?(?![a-z])|силикон[а-яё-]*|硅胶", text):
        materials.add("silicone")
    if re.search(r"(?<![a-z])pc(?![a-z])|polycarbonate|поликарбонат|聚碳酸酯", text):
        materials.add("polycarbonate")
    if re.search(r"stainless\s+steel|нержавеющ[а-яё-]*\s+стал[а-яё-]*|不锈钢", text):
        materials.add("stainless_steel")
    if re.search(
        r"(?<![a-z])leather(?![a-z])|"
        r"(?<![а-яё])(?:кожан[а-яё-]*|кожевенн[а-яё-]*|кож(?:а|и|е|у|ей|ею))(?![а-яё])|"
        r"真皮|皮革",
        text,
    ):
        materials.add("leather")
    # Generic metal wording and alloy wording describe the same broad
    # material family at search-card precision.  Specific stainless steel is
    # retained separately because it is an option-defining watch-band claim.
    if re.search(
        r"(?<![a-z])(?:metal|alloy)(?![a-z])|металл[а-яё-]*|металлическ[а-яё-]*|"
        r"сплав[а-яё-]*|合金|金属",
        text,
    ):
        materials.add("metal")
    return materials


def _adaptive_model_records(value: object) -> list[dict]:
    """Extract comparison-safe product model identities, excluding units and years."""
    text = _adaptive_mask_specs(value)
    # Treat the two common spellings as one qualifier while keeping them
    # distinct from the base Pro SKU.  This runs before tokenization so the
    # punctuation in compact forms such as ``Note15Pro+`` is not discarded.
    text = re.sub(r"pro(?:\s*\+|\s+plus\b)", "proplus", text)
    # Brand-product model order: `AirPods Pro 2` / `AirPods Pro2` should bind
    # to the same exact identity instead of losing `Pro` as a weak token.
    text = re.sub(
        r"\bairpods[\s_-]+(pro|max)[\s_-]*(\d{1,3})\b",
        lambda match: f"airpods{match.group(2)}{match.group(1)}",
        text,
    )
    tokens = re.findall(r"[a-z0-9]+", text)
    # A bare V-series token (for example V70) is only meaningful as a model
    # when the surrounding title explicitly names Vivo.  Keep this boolean
    # deterministic instead of deriving a prefix from unordered brand sets.
    vivo_context = any(token == "vivo" or token.startswith("vivo") for token in tokens)
    apple_silicon_context = any(
        token.startswith(("macbook", "imac", "macmini", "ipad"))
        for token in tokens
    )
    records: list[dict] = []

    def add(family: str, number: str, qualifier: str = "") -> None:
        family = re.sub(r"[^a-z]", "", family)
        qualifier = re.sub(r"[^a-z]", "", qualifier)
        if qualifier == "u":
            qualifier = "ultra"
        if not family or not number:
            return
        # OBD2 is the diagnostic protocol around an ELM327 adapter, not a
        # second product model or SKU variant.
        if family in ADAPTIVE_SPEC_UNITS or family == "obd" or qualifier in ADAPTIVE_SPEC_UNITS:
            return
        if len(number) == 4 and 1900 <= int(number) <= 2099:
            return
        canonical = f"{family}{number}{qualifier}"
        record = {
            "family": family,
            "number": number.lstrip("0") or "0",
            "qualifier": qualifier,
            "canonical": canonical,
        }
        if record not in records:
            records.append(record)

        # 1688 frequently concatenates a brand and model (`vivox200`).  Add a
        # comparison alias without the known brand so it can match `vivo
        # x200`, while retaining the original record for auditability.
        for brand in ADAPTIVE_KNOWN_BRANDS:
            if family.startswith(brand) and len(family) > len(brand):
                add(family[len(brand):], number, qualifier)
                break

    def compound_qualifier(first: str, second: str = "") -> str:
        if first == "pro" and second in {"max", "mini", "plus"}:
            return f"pro{second}"
        return first if first in ADAPTIVE_MODEL_QUALIFIERS else ""

    # Preserve slash-separated compatibility lists such as `Band 10/9/8` and
    # compact search-card forms such as `watch6/5/4`.
    # Every listed target variant is allowed; it must not conflict with a
    # returned Offer merely because another allowed target variant differs.
    for match in re.finditer(
        r"(?<![a-z0-9])([a-z]{1,24})\s*(\d+(?:\s*/\s*\d+)+)"
        r"(?:\s+(pro(?:\s+(?:max|mini|plus))?|proplus|plus|max|mini|lite|ultra|fe|se|nfc))?(?![a-z0-9])",
        text,
    ):
        family, raw_numbers, qualifier = match.groups()
        normalized_qualifier = re.sub(r"\s+", "", qualifier or "")
        for number in re.split(r"\s*/\s*", raw_numbers):
            add(family, number, normalized_qualifier)

    for index, token in enumerate(tokens):
        compact = re.fullmatch(r"([a-z]{1,16})(\d{1,6})([a-z]{0,12})", token)
        if compact:
            family, number, qualifier = compact.groups()
            if family in ADAPTIVE_SPEC_UNITS:
                if family == "v" and vivo_context:
                    family = "vivov"
                elif family == "m" and apple_silicon_context:
                    family = "applem"
                else:
                    continue
            if qualifier in ADAPTIVE_SPEC_UNITS:
                continue
            if qualifier and qualifier not in ADAPTIVE_MODEL_QUALIFIERS and len(qualifier) > 2:
                qualifier = ""
            next_token = tokens[index + 1] if index + 1 < len(tokens) else ""
            following_token = tokens[index + 2] if index + 2 < len(tokens) else ""
            if qualifier == "pro" and next_token in {"max", "mini"}:
                qualifier = f"pro{next_token}"
            elif not qualifier:
                qualifier = compound_qualifier(next_token, following_token)
            add(family, number, qualifier)

    # Separated forms must be locally adjacent in the original text.  Using a
    # regex instead of the old token look-behind prevents `type-c ... 雷电5`
    # from inventing a `c5` model after Chinese text was discarded.
    qualifier_pattern = r"pro(?:\s+(?:max|mini|plus))?|proplus|plus|max|mini|lite|ultra|fe|se|air|neo|nfc"
    attached_qualifier_pattern = r"proplus|pro|max|mini|lite|ultra|plus|fe|se|nfc"
    for match in re.finditer(
        rf"(?<![a-z0-9])([a-z]{{1,20}})\s+(\d{{1,6}})({attached_qualifier_pattern})(?![a-z0-9])",
        text,
    ):
        family, number, qualifier = match.groups()
        if family not in WEAK_EVIDENCE_TOKENS and family not in ADAPTIVE_SPEC_UNITS:
            add(family, number, qualifier)
    for match in re.finditer(
        rf"\b([a-z]{{1,20}})\s+(\d{{1,6}})(?:\s+({qualifier_pattern}))?\b",
        text,
    ):
        family, number, qualifier = match.groups()
        if family in WEAK_EVIDENCE_TOKENS or family in ADAPTIVE_SPEC_UNITS:
            continue
        add(family, number, re.sub(r"\s+", "", qualifier or ""))

    for match in re.finditer(
        rf"\b([a-z]{{2,20}})\s+([a-z]{{2,20}})\s+(\d{{1,6}})"
        rf"(?:\s+({qualifier_pattern}))?\b",
        text,
    ):
        first, second, number, qualifier = match.groups()
        if second in WEAK_EVIDENCE_TOKENS or second in ADAPTIVE_SPEC_UNITS:
            continue
        normalized_qualifier = re.sub(r"\s+", "", qualifier or "")
        add(second, number, normalized_qualifier)
        add(f"{first}{second}", number, normalized_qualifier)
    # Do not collapse an explicitly listed base model plus qualified model
    # (`Buds 4 / Buds 4 Pro`) into one record.  That list is precisely the SKU
    # ambiguity the shadow decision must route to REVIEW.
    return records


def _adaptive_family_overlap(left: str, right: str) -> bool:
    if left == right:
        return True
    if min(len(left), len(right)) < 3:
        return False
    return left in right or right in left


def _adaptive_model_comparison(expected_value: object, returned_value: object) -> dict:
    expected = _adaptive_model_records(expected_value)
    returned = _adaptive_model_records(returned_value)
    exact = []
    conflicts = []
    incomplete = []

    def relation(left: dict, right: dict) -> str:
        if not _adaptive_family_overlap(left["family"], right["family"]):
            return "unrelated"
        if left["number"] != right["number"]:
            return "conflict"
        left_qualifier = left["qualifier"]
        right_qualifier = right["qualifier"]
        if left_qualifier == right_qualifier:
            return "exact"
        if bool(left_qualifier) != bool(right_qualifier):
            return "incomplete"
        if {left_qualifier, right_qualifier} == {"pro", "proplus"}:
            return "incomplete"
        return "conflict"

    # Evaluate each returned variant against the complete set of allowed
    # target variants.  A target like `Band 10/9/8` therefore accepts Band 8,
    # while `X200 FE` plus a returned X200S remains an explicit contradiction.
    for right in returned:
        related = [left for left in expected if _adaptive_family_overlap(left["family"], right["family"])]
        relations = [(left, relation(left, right)) for left in related]
        exact_left = next((left for left, kind in relations if kind == "exact"), None)
        if exact_left:
            exact.append(right["canonical"])
            continue
        incomplete_left = next((left for left, kind in relations if kind == "incomplete"), None)
        if incomplete_left:
            incomplete.append(right["canonical"])
            continue
        conflict_left = next((left for left, kind in relations if kind == "conflict"), None)
        if conflict_left:
            conflicts.append(
                f"model:{conflict_left['canonical']}!={right['canonical']}"
            )
    related_variant_keys = {
        (right["number"], right["qualifier"])
        for right in returned
        if any(_adaptive_family_overlap(left["family"], right["family"]) for left in expected)
    }
    return {
        "expected": expected,
        "returned": returned,
        "exact": list(dict.fromkeys(exact)),
        "conflicts": list(dict.fromkeys(conflicts)),
        "incomplete": list(dict.fromkeys(incomplete)),
        "variant_ambiguity": len(related_variant_keys) > 1,
    }


def _adaptive_network_generations(value: object) -> set[str]:
    """Return explicit mobile-network generations without parsing weights."""
    text = _adaptive_text(value)
    # The non-digit guard covers compact ``pro5g`` but excludes the tail of a
    # real weight such as ``45g``.  The right guard excludes storage units
    # such as ``64gb``.
    return set(re.findall(r"(?<![0-9])([45]g)(?![a-z0-9])", text))


def _adaptive_elm327_identity(value: object) -> dict | None:
    """Extract variant evidence that the shared ELM327 name does not encode."""
    text = _adaptive_text(value)
    if not re.search(r"(?<![a-z0-9])elm[\s_-]*327(?![a-z0-9])", text):
        return None

    versions = set()
    for raw in re.findall(
        r"(?<![a-z0-9])v(?:er(?:sion)?)?\s*([0-9]+(?:[.,][0-9]+)?)(?![a-z0-9])",
        text,
    ):
        try:
            versions.add(f"{float(raw.replace(',', '.')):g}")
        except ValueError:
            continue
    chipsets = {
        f"pic{match}"
        for match in re.findall(
            r"(?<![a-z0-9])pic[\s_-]*([a-z0-9]{4,})(?![a-z0-9])",
            text,
        )
    }
    return {
        "versions": versions,
        "chipsets": chipsets,
        "mini": _adaptive_term_matches(text, "mini"),
    }


def _adaptive_spec_observations(value: object) -> tuple[str, list[dict]]:
    """Extract explicit specs and their source spans, including variant lists."""
    text = _adaptive_text(value)
    number = r"\d+(?:[.,]\d+)?"
    definitions = [
        ("capacity_mah", r"mah|мач|毫安(?:时)?", 1.0),
        ("length_mm", r"mm|мм|毫米", 1.0),
        ("length_mm", r"cm|см|厘米", 10.0),
        ("length_mm", r"m|м|米|метр(?:а|ов|ы|о)?", 1000.0),
        ("volume_ml", r"ml|мл|毫升", 1.0),
        ("volume_ml", r"l|л|升", 1000.0),
        ("weight_g", r"kg|кг|千克", 1000.0),
        ("weight_g", r"g|г|克", 1.0),
        ("power_w", r"w|вт|瓦", 1.0),
        ("voltage_v", r"v|в|伏", 1.0),
        ("current_a", r"a|а|安", 1.0),
        ("count", r"pcs?|pack|шт|штук|件|个|只|套", 1.0),
    ]
    observations: list[dict] = []

    def observe(kind: str, numeric: str, multiplier: float, span: tuple[int, int]) -> None:
        try:
            converted = float(numeric.replace(",", ".")) * multiplier
        except (TypeError, ValueError):
            return
        # A compact single-digit `4g` is overwhelmingly the mobile-network
        # generation in product titles.  Real weights retain a separator,
        # larger value, Cyrillic/Chinese unit, or kg form.
        raw = text[span[0]:span[1]]
        if kind == "weight_g" and converted <= 5 and re.fullmatch(r"\d(?:[.,]\d+)?g", raw):
            return
        normalized = f"{converted:.6f}".rstrip("0").rstrip(".")
        observations.append({"kind": kind, "value": normalized, "span": span})

    # Bind compact electrical pairs before the single-unit pass.  Search-card
    # titles commonly concatenate them (`12v55w`, `21v4a`), which must not be
    # mistaken for a missing 55 W / 4 A specification.
    pair_units = [
        ("power_w", r"w|вт|瓦"),
        ("current_a", r"a|а|安"),
    ]
    for right_kind, right_unit in pair_units:
        pair_pattern = re.compile(
            rf"(?<![0-9.])(?P<voltage>{number})\s*(?:v|в|伏)\s*"
            rf"(?P<right>{number})\s*(?:{right_unit})(?![a-zа-яё])",
            flags=re.IGNORECASE,
        )
        for match in pair_pattern.finditer(text):
            observe("voltage_v", match.group("voltage"), 1.0, match.span())
            observe(right_kind, match.group("right"), 1.0, match.span())

    for kind, unit, multiplier in definitions:
        unit_group = rf"(?:{unit})"
        # Each option repeats its unit: 250ml300ml400ml, 18v21v.
        direct_chain = re.compile(
            rf"(?<![a-zа-яё0-9])(?P<body>(?:{number}\s*{unit_group}){{2,}})(?![a-zа-яё0-9])",
            flags=re.IGNORECASE,
        )
        # A final shared unit: 100 120 150 200ml, 20 22mm, 40/44/46mm.
        shared_unit = re.compile(
            rf"(?<![a-zа-яё0-9])(?P<body>{number}(?:(?:\s*/\s*|\s+){number})+)"
            rf"\s*{unit_group}(?![a-zа-яё0-9])",
            flags=re.IGNORECASE,
        )
        single = re.compile(
            rf"(?<![a-zа-яё0-9])(?P<body>{number})\s*{unit_group}(?![a-zа-яё0-9])",
            flags=re.IGNORECASE,
        )
        for pattern in (direct_chain, shared_unit, single):
            for match in pattern.finditer(text):
                if pattern is shared_unit:
                    body = match.group("body")
                    if "/" not in body and any(
                        separator in numeric
                        for numeric in re.findall(number, body)[:-1]
                        for separator in (".", ",")
                    ):
                        continue
                for numeric_match in re.finditer(number, match.group("body")):
                    observe(kind, numeric_match.group(0), multiplier, match.span())

    # A dimension expression describes axes, not competing variants.  Capture
    # every axis when the unit is written once at the end (`21x0.5 cm`) and
    # infer an unlabelled pair (`5x210`) only when one side is independently
    # labelled in the same title (`5 mm`).
    dimension_pattern = re.compile(
        rf"(?<![a-zа-яё0-9])(?P<body>{number}(?:\s*[xх×*]\s*{number}){{1,2}})"
        rf"\s*(?P<unit>mm|мм|毫米|cm|см|厘米|m|м|米)(?![a-zа-яё])",
        flags=re.IGNORECASE,
    )
    unit_multiplier = {
        "mm": 1.0, "мм": 1.0, "毫米": 1.0,
        "cm": 10.0, "см": 10.0, "厘米": 10.0,
        "m": 1000.0, "м": 1000.0, "米": 1000.0,
    }
    for match in dimension_pattern.finditer(text):
        multiplier = unit_multiplier[match.group("unit").lower()]
        for numeric_match in re.finditer(number, match.group("body")):
            observe("length_mm", numeric_match.group(0), multiplier, match.span())

    existing_lengths = {
        observation["value"]
        for observation in observations
        if observation["kind"] == "length_mm"
    }
    for match in re.finditer(
        rf"(?<![a-zа-яё0-9])(?P<left>{number})\s*[xх×*]\s*(?P<right>{number})(?![a-zа-яё0-9])",
        text,
        flags=re.IGNORECASE,
    ):
        raw_values = [match.group("left"), match.group("right")]
        normalized_values = [
            f"{float(value.replace(',', '.')):.6f}".rstrip("0").rstrip(".")
            for value in raw_values
        ]
        if not (set(normalized_values) & existing_lengths):
            continue
        for raw_value in raw_values:
            observe("length_mm", raw_value, 1.0, match.span())
    return text, observations


def _adaptive_specs(value: object) -> dict[str, list[str]]:
    _text, observations = _adaptive_spec_observations(value)
    specs: dict[str, list[str]] = {}
    for observation in observations:
        values = specs.setdefault(observation["kind"], [])
        if observation["value"] not in values:
            values.append(observation["value"])
    return specs


def _adaptive_mask_specs(value: object) -> str:
    """Blank raw specification spans before extracting product models."""
    text, observations = _adaptive_spec_observations(value)
    characters = list(text)
    for observation in observations:
        start, end = observation["span"]
        characters[start:end] = " " * (end - start)
    return "".join(characters)


def _adaptive_spec_comparison(expected: dict[str, list[str]], returned: dict[str, list[str]]) -> dict:
    matched = []
    missing = []
    conflicts = []
    ambiguous = []
    for kind, expected_values in expected.items():
        returned_values = returned.get(kind) or []
        if not returned_values:
            missing.append(kind)
        elif set(expected_values).isdisjoint(returned_values):
            if kind == "length_mm":
                # A search-card title does not bind length/width/thickness or
                # watch-case/lug width axes to a concrete SKU.  Keep it in the
                # review lane instead of turning an axis mismatch into a hard
                # product rejection.
                ambiguous.append(kind)
            else:
                conflicts.append(
                    f"spec:{kind}:{'/'.join(expected_values)}!={'/'.join(returned_values)}"
                )
        else:
            matched.append(kind)
            if len(set(returned_values)) > 1 or set(returned_values) - set(expected_values):
                ambiguous.append(kind)
    return {
        "matched": matched,
        "missing": missing,
        "conflicts": conflicts,
        "ambiguous": ambiguous,
    }


def _adaptive_electrical_pairs(value: object) -> dict[str, set[tuple[str, str]]]:
    text = _adaptive_text(value)
    number = r"\d+(?:[.,]\d+)?"
    pairs = {"voltage_power": set(), "voltage_current": set()}

    def normalized(raw: str) -> str:
        return f"{float(raw.replace(',', '.')):.6f}".rstrip("0").rstrip(".")

    for kind, right_unit in (
        ("voltage_power", r"w|вт|瓦"),
        ("voltage_current", r"a|а|安"),
    ):
        pattern = re.compile(
            rf"(?<![0-9.])({number})\s*(?:v|в|伏)\s*({number})\s*(?:{right_unit})(?![a-zа-яё])",
            flags=re.IGNORECASE,
        )
        for match in pattern.finditer(text):
            pairs[kind].add((normalized(match.group(1)), normalized(match.group(2))))
    return pairs


def _adaptive_row_value(row: dict, snake: str, camel: str) -> object:
    return row.get(snake) if row.get(snake) not in (None, "") else row.get(camel)


def _adaptive_row_offer_id(row: dict) -> str:
    return str(_adaptive_row_value(row, "offer_id", "offerId") or "").strip()


def _adaptive_row_supplier_id(row: dict) -> str:
    value = _adaptive_row_value(row, "supplier_id", "shop")
    return normalize_supplier(value)


def _adaptive_row_image(row: dict) -> dict:
    image = row.get("image")
    return dict(image) if isinstance(image, dict) else {"available": False}


def _adaptive_positive_price(value: object) -> float | None:
    try:
        price = float(value)
    except (TypeError, ValueError):
        return None
    return price if math.isfinite(price) and price > 0 else None


def _adaptive_core_digital_category(products: set[str], brands: set[str]) -> str | None:
    if products & VALUABLE_DIGITAL_ACCESSORY_ROLES:
        return None
    for role, category in VALUABLE_DIGITAL_CORE_ROLES.items():
        if role not in products:
            continue
        if role == "earbuds" and not brands:
            return None
        return category
    return None


def _adaptive_policy_payload(
    *,
    evidence_complete: bool,
    completeness_reasons: list[str],
    expect_price_cny: object,
    expected_products: set[str],
    selected_products: set[str],
    expected_brands: set[str],
    selected_brands: set[str],
    expected_models: list[dict],
    model_comparison: dict,
    hard_conflicts: list[str],
) -> dict:
    price_cny = _adaptive_positive_price(expect_price_cny)
    category = _adaptive_core_digital_category(expected_products, expected_brands)
    applies = bool(
        category
        and price_cny is not None
        and price_cny >= VALUABLE_DIGITAL_THRESHOLD_CNY
    )
    brand_match = None
    if expected_brands:
        brand_match = bool(
            selected_brands
            and not expected_brands.isdisjoint(selected_brands)
            and not (selected_brands - expected_brands)
        )
    audit_fields = {
        "policy_version": ADAPTIVE_POLICY_VERSION,
        "evidence_complete": bool(evidence_complete),
        "valuable_digital": {
            "applies": applies,
            "category": category,
            "price_cny": price_cny,
            "threshold_cny": VALUABLE_DIGITAL_THRESHOLD_CNY,
        },
        "brand_evidence": {
            "expected_families": sorted(expected_brands),
            "selected_families": sorted(selected_brands),
            "matched": brand_match,
        },
        "expected_product_roles": sorted(expected_products),
        "selected_product_roles": sorted(selected_products),
        "expected_models": [row["canonical"] for row in expected_models],
    }
    if not evidence_complete:
        return {
            **audit_fields,
            "action": None,
            "policy_reasons": [
                "evidence_incomplete",
                *[f"evidence_incomplete:{reason}" for reason in completeness_reasons],
            ],
        }

    reject_reasons: list[str] = []
    reject_reasons.extend(f"hard_conflict:{value}" for value in hard_conflicts)

    # Global, dictionary-only brand policy.  A multi-brand target may bind to
    # one explicitly listed family, but a missing family, disjoint family, or
    # an additional unrequested family is not allowed.
    if expected_brands:
        if not selected_brands:
            reject_reasons.append("selected_brand_missing")
        elif expected_brands.isdisjoint(selected_brands):
            reject_reasons.append("selected_brand_family_mismatch")
        elif selected_brands - expected_brands:
            reject_reasons.append("selected_brand_family_unbound")

    if category and price_cny is None:
        reject_reasons.append("valuable_digital_price_missing")
    if applies:
        if not expected_brands:
            reject_reasons.append("valuable_digital_target_brand_missing")
        required_role = next(
            role
            for role, mapped_category in VALUABLE_DIGITAL_CORE_ROLES.items()
            if mapped_category == category
        )
        if (
            required_role not in selected_products
            or bool(selected_products & VALUABLE_DIGITAL_ACCESSORY_ROLES)
        ):
            reject_reasons.append("valuable_digital_product_role_mismatch")
        if not expected_models:
            reject_reasons.append("valuable_digital_target_model_missing")
        else:
            exact_model_bound = bool(model_comparison.get("exact")) and not any((
                model_comparison.get("conflicts"),
                model_comparison.get("incomplete"),
                model_comparison.get("variant_ambiguity"),
            ))
            if not exact_model_bound:
                reject_reasons.append("valuable_digital_selected_model_mismatch")

    policy_reasons = list(dict.fromkeys(reject_reasons))
    action = "REJECT" if policy_reasons else "ALLOW"
    if not policy_reasons:
        policy_reasons = [
            "valuable_digital_verified" if applies else "policy_allow"
        ]
    return {
        **audit_fields,
        "action": action,
        "policy_reasons": policy_reasons,
    }


def adaptive_same_item_decision(
    rows: list[dict],
    *,
    expect_title: str = "",
    expect_model: str = "",
    expect_category: str = "",
    expect_price_cny: float | None = None,
    selected_offer_id: str = "",
    selected_cluster: list[dict] | None = None,
    selected_cost: float | None = None,
) -> dict:
    """Return a shadow-only FAST/REVIEW/REJECT decision for the selected Offer.

    REJECT is reserved for explicit contradictions.  Missing or weak evidence
    is REVIEW, so the policy can improve precision without shrinking the live
    hot path before replay/canary evidence says it is safe.
    """
    normalized_rows = [row for row in (rows or []) if isinstance(row, dict)]
    selected_id = str(selected_offer_id or "").strip()
    selected = next(
        (row for row in normalized_rows if _adaptive_row_offer_id(row) == selected_id),
        None,
    )
    missing: list[str] = []
    hard_conflicts: list[str] = []
    expected_identity_text = " ".join(filter(None, [expect_title, expect_model]))
    expected_policy_text = " ".join(
        filter(None, [expect_title, expect_model, expect_category])
    )
    expected_products = _adaptive_product_types(expected_identity_text)
    if not expected_products:
        expected_products = _adaptive_product_types(expect_category)
    expected_policy_products = _adaptive_product_types(expected_policy_text)
    expected_specs = _adaptive_specs(expected_identity_text)
    expected_models = _adaptive_model_records(" ".join(filter(None, [expect_model, expect_title])))
    expected_materials = _adaptive_materials(expected_identity_text)
    expected_styles = _adaptive_styles(expected_identity_text)
    expected_brands = _adaptive_legacy_brand_families(
        _adaptive_legacy_brands(expected_identity_text)
    )
    expected_policy_brands = _adaptive_brand_families(
        _adaptive_brands(expected_identity_text)
    )

    if not selected_id:
        missing.append("selected_offer_id")
    if selected is None:
        missing.append("selected_offer_evidence")
        completeness_reasons = list(dict.fromkeys(missing))
        if _adaptive_positive_price(expect_price_cny) is None:
            completeness_reasons.append("expect_price_cny")
        policy = _adaptive_policy_payload(
            evidence_complete=False,
            completeness_reasons=list(dict.fromkeys(completeness_reasons)),
            expect_price_cny=expect_price_cny,
            expected_products=expected_policy_products,
            selected_products=set(),
            expected_brands=expected_policy_brands,
            selected_brands=set(),
            expected_models=expected_models,
            model_comparison={
                "exact": [], "conflicts": [], "incomplete": [], "variant_ambiguity": False,
            },
            hard_conflicts=[],
        )
        return {
            "version": ADAPTIVE_MATCH_VERSION,
            "decision": "REVIEW",
            "score": 0,
            "reason": "selected Offer is not bound to returned evidence",
            "hard_conflicts": [],
            "missing_evidence": list(dict.fromkeys(missing)),
            "selected_offer_id": selected_id or None,
            "supporting_offer_ids": [],
            **policy,
        }

    selected_title = str(selected.get("title") or "")
    if not selected_title.strip():
        missing.append("selected_offer_title")
    if not _adaptive_row_supplier_id(selected):
        missing.append("selected_offer_supplier")
    try:
        selected_price = float(selected.get("price"))
    except (TypeError, ValueError):
        selected_price = 0.0
    if not math.isfinite(selected_price) or selected_price <= 0:
        missing.append("selected_offer_price")
    selected_products = _adaptive_product_types(selected_title)
    product_conflicts = _adaptive_product_conflicts(expected_products, selected_products)
    hard_conflicts.extend(product_conflicts)
    for role in sorted(
        (expected_products & ADAPTIVE_REQUIRED_PRODUCT_ROLES) - selected_products
    ):
        missing.append(f"product_role:{role}")

    returned_brands = _adaptive_legacy_brand_families(
        _adaptive_legacy_brands(selected_title)
    )
    returned_policy_brands = _adaptive_brand_families(
        _adaptive_brands(selected_title)
    )
    if expected_brands and returned_brands:
        if expected_brands.isdisjoint(returned_brands):
            brand_conflict = (
                f"brand:{'/'.join(sorted(expected_brands))}!="
                f"{'/'.join(sorted(returned_brands))}"
            )
            if expected_models:
                hard_conflicts.append(brand_conflict)
            else:
                # Generic cables, straps and other compatibility-list
                # accessories routinely name different example brands.  With
                # no explicit target model, brand alone is insufficient for a
                # destructive mismatch decision.
                missing.append("selected_offer_brand_binding")
        elif returned_brands - expected_brands:
            missing.append("selected_offer_brand_variant_binding")

    model_comparison = _adaptive_model_comparison(
        " ".join(filter(None, [expect_model, expect_title])),
        selected_title,
    )
    if model_comparison["exact"] and (
        model_comparison["conflicts"] or model_comparison["variant_ambiguity"]
    ):
        missing.append("selected_offer_model_variant_binding")
    else:
        hard_conflicts.extend(model_comparison["conflicts"])

    expected_networks = _adaptive_network_generations(expected_identity_text)
    selected_networks = _adaptive_network_generations(selected_title)
    if expected_networks:
        if (
            not selected_networks
            or expected_networks.isdisjoint(selected_networks)
            or selected_networks - expected_networks
        ):
            # 4G/5G labels often identify separate SKUs, but search-card titles
            # do not reliably bind the label to the selected variation.  Keep
            # the uncertainty visible without upgrading it to a hard reject.
            missing.append("selected_offer_network_generation_binding")

    expected_elm327 = _adaptive_elm327_identity(expected_identity_text)
    selected_elm327 = _adaptive_elm327_identity(selected_title)
    if expected_elm327:
        if not selected_elm327:
            missing.append("selected_offer_elm327_identity")
        else:
            for field, evidence_name in (
                ("versions", "elm327_version_binding"),
                ("chipsets", "elm327_chipset_binding"),
            ):
                expected_values = expected_elm327[field]
                selected_values = selected_elm327[field]
                if expected_values != selected_values:
                    missing.append(evidence_name)
            if expected_elm327["mini"] != selected_elm327["mini"]:
                missing.append("elm327_form_factor_binding")

    selected_materials = _adaptive_materials(selected_title)
    if expected_materials & selected_materials:
        if selected_materials - expected_materials:
            missing.append("selected_offer_material_variant_binding")
    elif expected_materials:
        if (
            selected_materials
            and {"hydrogel", "tempered_glass"}
            <= expected_materials | selected_materials
        ):
            hard_conflicts.append(
                f"material:{'/'.join(sorted(expected_materials))}!={'/'.join(sorted(selected_materials))}"
            )
        else:
            missing.append("selected_offer_material_binding")

    selected_styles = _adaptive_styles(selected_title)
    for style in sorted(expected_styles - selected_styles):
        missing.append(f"style:{style}")
    selected_specs = _adaptive_specs(selected_title)
    spec_comparison = _adaptive_spec_comparison(expected_specs, selected_specs)
    battery_voltage_convention = (
        "18650" in _adaptive_text(expected_identity_text)
        and "18650" in _adaptive_text(selected_title)
        and {"4.2", "3.7"} <= set(expected_specs.get("voltage_v", [])) | set(selected_specs.get("voltage_v", []))
    )
    if battery_voltage_convention:
        spec_comparison["conflicts"] = [
            conflict
            for conflict in spec_comparison["conflicts"]
            if not conflict.startswith("spec:voltage_v:")
        ]
        missing.append("battery_voltage_convention_binding")
    hard_conflicts.extend(spec_comparison["conflicts"])
    missing.extend(
        f"spec_variant_binding:{kind}" for kind in spec_comparison["ambiguous"]
    )
    expected_electrical_pairs = _adaptive_electrical_pairs(expected_identity_text)
    selected_electrical_pairs = _adaptive_electrical_pairs(selected_title)
    for pair_kind in ("voltage_power", "voltage_current"):
        expected_pairs = expected_electrical_pairs[pair_kind]
        selected_pairs = selected_electrical_pairs[pair_kind]
        if not expected_pairs or not selected_pairs:
            continue
        if expected_pairs.isdisjoint(selected_pairs):
            left = "/".join(f"{voltage}+{right}" for voltage, right in sorted(expected_pairs))
            right = "/".join(f"{voltage}+{value}" for voltage, value in sorted(selected_pairs))
            hard_conflicts.append(f"spec:{pair_kind}:{left}!={right}")
        elif selected_pairs - expected_pairs:
            missing.append(f"spec_variant_binding:{pair_kind}")

    score = 0
    if expected_products:
        if expected_products & selected_products and not product_conflicts:
            score += 20
        elif not product_conflicts:
            score += 5
            missing.append("product_type_match")
    else:
        score += 15

    exact_model = bool(model_comparison["exact"])
    if expected_models:
        if exact_model:
            score += 35
        elif not model_comparison["conflicts"]:
            missing.append("exact_model_match")
    else:
        score += 25

    if expected_specs:
        matched_count = len(spec_comparison["matched"])
        score += round(20 * matched_count / len(expected_specs))
        missing.extend(f"spec:{kind}" for kind in spec_comparison["missing"])
    else:
        score += 15

    image = _adaptive_row_image(selected)
    image_available = image.get("available") is True
    try:
        image_score = float(image.get("score")) if image_available else 0.0
    except (TypeError, ValueError):
        image_score = 0.0
    high_image_threshold = 0.68 if exact_model else IMAGE_HIGH_SIMILARITY
    if not image_available:
        missing.append("selected_offer_image")
    elif image_score >= high_image_threshold:
        score += 20
    elif image_score >= IMAGE_CORROBORATION_SIMILARITY:
        score += 12
    else:
        score += 4
        missing.append("selected_offer_image_similarity")

    cluster_rows = [
        row for row in (selected_cluster or [])
        if isinstance(row, dict)
    ]
    cluster_offer_ids = {
        str((row or {}).get("offer_id") or (row or {}).get("offerId") or "").strip()
        for row in cluster_rows
    }
    if not cluster_offer_ids or selected_id not in cluster_offer_ids:
        missing.append("selected_offer_cluster_binding")
    selected_cluster_row = next(
        (
            row for row in cluster_rows
            if str(row.get("offer_id") or row.get("offerId") or "").strip() == selected_id
        ),
        None,
    )
    if selected_cluster_row is not None:
        try:
            cluster_price = float(selected_cluster_row.get("price"))
        except (TypeError, ValueError):
            cluster_price = 0.0
        if (
            not math.isfinite(cluster_price)
            or cluster_price <= 0
            or abs(cluster_price - selected_price) > 1e-9
        ):
            missing.append("selected_offer_cluster_price_binding")
    if selected_cost is None:
        missing.append("selected_offer_cost_binding")
    else:
        try:
            emitted_cost = float(selected_cost)
        except (TypeError, ValueError):
            emitted_cost = 0.0
        if (
            not math.isfinite(emitted_cost)
            or emitted_cost <= 0
            or abs(emitted_cost - selected_price) > 1e-9
        ):
            missing.append("selected_offer_cost_binding")
    candidate_rows = [
        row for row in normalized_rows
        if not cluster_offer_ids or _adaptive_row_offer_id(row) in cluster_offer_ids
    ]
    supporting: list[str] = []
    seen_suppliers: set[str] = set()
    for row in sorted(
        candidate_rows,
        key=lambda candidate: (
            _adaptive_row_offer_id(candidate) != selected_id,
            int(candidate.get("rank") or 9999),
        ),
    ):
        offer_id = _adaptive_row_offer_id(row)
        supplier_id = _adaptive_row_supplier_id(row)
        if not offer_id or not supplier_id or supplier_id in seen_suppliers:
            continue
        row_title = str(row.get("title") or "")
        row_products = _adaptive_product_types(row_title)
        if _adaptive_product_conflicts(expected_products, row_products):
            continue
        if expected_products and not (expected_products & row_products):
            continue
        if not (
            expected_products & ADAPTIVE_REQUIRED_PRODUCT_ROLES
        ).issubset(row_products):
            continue
        row_brands = _adaptive_legacy_brand_families(
            _adaptive_legacy_brands(row_title)
        )
        if expected_brands and (
            not row_brands
            or expected_brands.isdisjoint(row_brands)
            or bool(row_brands - expected_brands)
        ):
            continue
        row_materials = _adaptive_materials(row_title)
        if expected_materials and row_materials != expected_materials:
            continue
        row_styles = _adaptive_styles(row_title)
        if expected_styles and not expected_styles.issubset(row_styles):
            continue
        row_networks = _adaptive_network_generations(row_title)
        if expected_networks and row_networks != expected_networks:
            continue
        if expected_elm327:
            row_elm327 = _adaptive_elm327_identity(row_title)
            if not row_elm327 or any((
                row_elm327["versions"] != expected_elm327["versions"],
                row_elm327["chipsets"] != expected_elm327["chipsets"],
                row_elm327["mini"] != expected_elm327["mini"],
            )):
                continue
        row_specs = _adaptive_spec_comparison(expected_specs, _adaptive_specs(row_title))
        if row_specs["conflicts"] or row_specs["missing"] or row_specs["ambiguous"]:
            continue
        if expected_models:
            row_model = _adaptive_model_comparison(
                " ".join(filter(None, [expect_model, expect_title])), row_title
            )
            if (
                not row_model["exact"]
                or row_model["conflicts"]
                or row_model["incomplete"]
                or row_model["variant_ambiguity"]
            ):
                continue
        seen_suppliers.add(supplier_id)
        supporting.append(offer_id)

    if len(supporting) >= 2:
        score += 5
    else:
        score += 2 if supporting else 0
        if not exact_model:
            missing.append("independent_supplier_corroboration")

    hard_conflicts = list(dict.fromkeys(hard_conflicts))
    missing = list(dict.fromkeys(missing))
    basic_evidence_fields = {
        "selected_offer_id",
        "selected_offer_evidence",
        "selected_offer_title",
        "selected_offer_supplier",
        "selected_offer_price",
        "selected_offer_cluster_binding",
        "selected_offer_cluster_price_binding",
        "selected_offer_cost_binding",
    }
    completeness_reasons = [
        value for value in missing if value in basic_evidence_fields
    ]
    if _adaptive_positive_price(expect_price_cny) is None:
        completeness_reasons.append("expect_price_cny")
    completeness_reasons = list(dict.fromkeys(completeness_reasons))
    policy = _adaptive_policy_payload(
        evidence_complete=not completeness_reasons,
        completeness_reasons=completeness_reasons,
        expect_price_cny=expect_price_cny,
        expected_products=expected_policy_products,
        selected_products=selected_products,
        expected_brands=expected_policy_brands,
        selected_brands=returned_policy_brands,
        expected_models=expected_models,
        model_comparison=model_comparison,
        hard_conflicts=hard_conflicts,
    )
    score = max(0, min(100, int(round(score))))
    if hard_conflicts:
        decision = "REJECT"
        reason = f"explicit contradiction: {hard_conflicts[0]}"
    elif missing:
        decision = "REVIEW"
        reason = f"evidence needs review: {missing[0]}"
    elif score >= 80:
        decision = "FAST"
        reason = (
            "selected Offer has exact model, product and image evidence"
            if exact_model
            else "selected Offer is corroborated by product, image and independent suppliers"
        )
    else:
        decision = "REVIEW"
        reason = "evidence score below fast-path threshold"
    return {
        "version": ADAPTIVE_MATCH_VERSION,
        "decision": decision,
        "score": score,
        "reason": reason,
        "hard_conflicts": hard_conflicts,
        "missing_evidence": missing,
        "selected_offer_id": selected_id or None,
        "supporting_offer_ids": supporting[:3],
        **policy,
    }


def adaptive_decision_from_evidence(evidence: dict) -> dict:
    if not isinstance(evidence, dict):
        raise TypeError("same-item evidence must be an object")
    request = evidence.get("request") if isinstance(evidence.get("request"), dict) else {}
    return adaptive_same_item_decision(
        evidence.get("rows") if isinstance(evidence.get("rows"), list) else [],
        expect_title=str(request.get("expect_title") or ""),
        expect_model=str(request.get("expect_model") or ""),
        expect_category=str(request.get("expect_category") or ""),
        expect_price_cny=request.get("expect_price_cny"),
        selected_offer_id=str(evidence.get("selected_offer_id") or ""),
        selected_cluster=evidence.get("selected_cluster")
        if isinstance(evidence.get("selected_cluster"), list)
        else [],
        selected_cost=evidence.get("selected_cost"),
    )


def image_fingerprint(image: Image.Image) -> tuple[int, list[float]]:
    prepared = ImageOps.exif_transpose(image).convert("RGB")
    gray = prepared.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    pixels = list(gray.getdata())
    difference_hash = 0
    for row in range(8):
        for column in range(8):
            difference_hash <<= 1
            if pixels[row * 9 + column] > pixels[row * 9 + column + 1]:
                difference_hash |= 1
    histogram = [0.0] * 64
    for red, green, blue in prepared.resize((64, 64), Image.Resampling.BILINEAR).getdata():
        histogram[(red // 64) * 16 + (green // 64) * 4 + (blue // 64)] += 1.0
    length = math.sqrt(sum(value * value for value in histogram)) or 1.0
    return difference_hash, [value / length for value in histogram]


def compare_fingerprints(left: tuple[int, list[float]], right: tuple[int, list[float]]) -> dict:
    left_hash, left_histogram = left
    right_hash, right_histogram = right
    hash_similarity = 1.0 - ((left_hash ^ right_hash).bit_count() / 64.0)
    color_similarity = max(0.0, min(1.0, sum(
        left * right for left, right in zip(left_histogram, right_histogram)
    )))
    score = max(0.0, min(1.0, hash_similarity * 0.7 + color_similarity * 0.3))
    return {
        "available": True,
        "dhash_score": round(hash_similarity, 6),
        "color_score": round(color_similarity, 6),
        "score": round(score, 6),
    }


def compare_remote_image(source_image: Path, image_url: str, timeout_seconds: float = 1.5) -> dict:
    if not source_image.is_file() or not re.match(r"^https?://", str(image_url or ""), flags=re.IGNORECASE):
        return {"available": False, "reason": "missing-image"}
    session = requests.Session()
    session.trust_env = False
    try:
        response = session.get(
            image_url,
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=(min(0.8, timeout_seconds), timeout_seconds),
        )
        response.raise_for_status()
        if not response.content:
            return {"available": False, "reason": "empty-image"}
        with Image.open(source_image) as source, Image.open(io.BytesIO(response.content)) as returned:
            return compare_fingerprints(image_fingerprint(source), image_fingerprint(returned))
    except Exception as exc:
        return {"available": False, "reason": f"image-error:{type(exc).__name__}"}
    finally:
        session.close()


def balanced_same_item_assessment(
    selected_cluster_rows: list[dict],
    *,
    expect_title: str,
    expect_model: str,
    expect_category: str,
    source_image_path: Path | None = None,
    image_metrics_by_offer: dict[str, dict] | None = None,
) -> dict:
    expected_text = " ".join(filter(None, [expect_title, expect_model, expect_category]))
    expected_specs = extract_specs(expected_text)
    high_needles = high_information_tokens(expect_title)
    feature_needles = feature_tokens(expect_title)
    model_needles = model_tokens(" ".join(filter(None, [expect_model, expect_title])))
    rows: list[dict] = []
    metrics_override = dict(image_metrics_by_offer or {})
    image_offer_ids = {
        str(row.get("offerId") or "")
        for row in sorted(selected_cluster_rows, key=lambda candidate: int(candidate.get("rank") or 9999))[:3]
    }

    # Fetch the bounded top-three visual evidence concurrently.  Serial CDN
    # reads used to consume several seconds from the 1688 stage budget.
    if source_image_path is not None and image_offer_ids:
        image_probe_rows = [
            row for row in selected_cluster_rows
            if str(row.get("offerId") or "") in image_offer_ids
            and str(row.get("offerId") or "") not in metrics_override
            and str(row.get("pic") or "").strip()
        ]

        def probe_image(row: dict) -> tuple[str, dict]:
            offer_id = str(row.get("offerId") or "").strip()
            try:
                metrics = compare_remote_image(
                    source_image_path,
                    str(row.get("pic") or ""),
                    timeout_seconds=IMAGE_COMPARE_TIMEOUT_SECONDS,
                )
            except Exception as exc:  # pragma: no cover - defensive network boundary
                metrics = {"available": False, "reason": f"image-error:{type(exc).__name__}"}
            return offer_id, dict(metrics or {"available": False, "reason": "image-not-checked"})

        if image_probe_rows:
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(3, len(image_probe_rows))) as pool:
                metrics_override = {
                    **dict(pool.map(probe_image, image_probe_rows)),
                    **metrics_override,
                }

    for row in selected_cluster_rows:
        offer_id = str(row.get("offerId") or "").strip()
        title = normalize_text(row.get("title"))
        model_hits = matching_tokens(title, model_needles)
        information_hits = matching_tokens(title, high_needles)
        matched_features = matching_tokens(title, feature_needles)
        returned_specs = extract_specs(title)
        conflicts = spec_conflicts(expected_specs, returned_specs)
        product_semantics = product_semantic_match(expected_text, title)
        conflicts.extend(f"product:{name}" for name in product_semantics["missing"])
        has_accessory_conflict = accessory_conflict(expected_text, title)
        image = metrics_override.get(offer_id)
        if image is None and source_image_path is not None and offer_id in image_offer_ids:
            image = compare_remote_image(
                source_image_path,
                str(row.get("pic") or ""),
                timeout_seconds=IMAGE_COMPARE_TIMEOUT_SECONDS,
            )
        image = dict(image or {"available": False, "reason": "image-not-checked"})
        image_score = float(image.get("score") or 0)
        exact_model = bool(model_needles and model_hits)
        if exact_model:
            semantic_strength = "exact_model"
        elif len(information_hits) >= 2:
            semantic_strength = "two_high_information_terms"
        elif len(information_hits) == 1:
            semantic_strength = (
                "one_high_information_plus_product"
                if product_semantics["hits"] and not product_semantics["missing"]
                else "one_high_information_term"
            )
        elif product_semantics["hits"] and not product_semantics["missing"]:
            semantic_strength = "product_semantics"
        elif matched_features:
            semantic_strength = "feature_only"
        else:
            semantic_strength = "weak_or_none"
        image_backed = bool(image.get("available")) and image_score >= IMAGE_ONLY_SIMILARITY
        semantic_valid = (
            exact_model
            or len(information_hits) >= 1
            or bool(product_semantics["hits"] and not product_semantics["missing"])
            or image_backed
        )
        if image_backed and semantic_strength == "weak_or_none":
            semantic_strength = "image_backed"
        rows.append({
            **row,
            "rank": int(row.get("rank") or 0),
            "supplier_id": normalize_supplier(row.get("shop")),
            "image": image,
            "semantic_strength": semantic_strength,
            "semantic_hits_v3": {
                "model": model_hits,
                "high_information": information_hits,
                "feature": matched_features,
                "product": product_semantics["hits"],
            },
            "specs": returned_specs,
            "spec_conflicts": conflicts,
            "accessory_conflict": has_accessory_conflict,
            "semantic_valid": semantic_valid,
            "image_backed": image_backed,
            "strong_single": (
                1 <= int(row.get("rank") or 0) <= 3
                and bool(image.get("available"))
                and image_score >= (0.68 if exact_model else IMAGE_HIGH_SIMILARITY)
                and not conflicts
                and not has_accessory_conflict
                and (
                    exact_model
                    or len(information_hits) >= 2
                    or (len(information_hits) == 1 and image_score >= IMAGE_VERY_HIGH_SIMILARITY)
                )
            ),
        })

    strong = next((row for row in rows if row["strong_single"]), None)
    if strong:
        decision = True
        match_type = "strong_single"
        reason = "top-three image, semantics and specifications agree"
        supporting_offer_ids = [str(strong.get("offerId") or "")]
    else:
        credible = [row for row in rows if (
            row.get("semantic_valid")
            and not row.get("spec_conflicts")
            and not row.get("accessory_conflict")
            and str(row.get("offerId") or "").strip()
            and row.get("supplier_id")
        )]
        independent: list[dict] = []
        seen_offers: set[str] = set()
        seen_suppliers: set[str] = set()
        for row in credible:
            offer_id = str(row.get("offerId") or "").strip()
            supplier_id = str(row.get("supplier_id") or "")
            if offer_id in seen_offers or supplier_id in seen_suppliers:
                continue
            seen_offers.add(offer_id)
            seen_suppliers.add(supplier_id)
            independent.append(row)
        high_image = any(
            bool(row.get("image", {}).get("available"))
            and float(row.get("image", {}).get("score") or 0) >= IMAGE_CORROBORATION_SIMILARITY
            for row in independent
        )
        decision = len(independent) >= 2 and high_image
        match_type = "corroborated_multi" if decision else "rejected"
        supporting_offer_ids = [str(row.get("offerId") or "") for row in independent[:2]] if decision else []
        if decision:
            reason = "two independent suppliers agree on semantics, price cluster and image"
        elif len({row.get("supplier_id") for row in credible}) < 2:
            reason = "fewer than two independent suppliers"
        elif not high_image:
            reason = "no corroborating offer has high image similarity"
        elif any(row.get("spec_conflicts") for row in rows):
            reason = "specification conflict"
        elif any(row.get("accessory_conflict") for row in rows):
            reason = "accessory or packaging conflict"
        else:
            reason = "weak title semantics"

    return {
        "passed": decision,
        "match_type": match_type,
        "reason": reason,
        "image_available": any(bool(row.get("image", {}).get("available")) for row in rows),
        "supporting_offer_ids": supporting_offer_ids,
        "expected_specs": expected_specs,
        "rows": rows,
    }


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


def p70_index(count: int) -> int:
    return max(0, min(count - 1, int(count * 0.7 + 0.999) - 1))


def p80_index(count: int) -> int:
    return max(0, min(count - 1, int(count * 0.8 + 0.999) - 1))


def median_number(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def price_cluster_summary(cluster_rows: list[dict]) -> dict:
    prices = sorted(float(row["price"]) for row in cluster_rows if row.get("price") is not None)
    count = len(cluster_rows)
    strong_count = sum(1 for row in cluster_rows if row.get("level") == "strong")
    score_sum = sum(float(row.get("score") or 0) for row in cluster_rows)
    return {
        "count": count,
        "prices": prices,
        "min_price": prices[0] if prices else None,
        "max_price": prices[-1] if prices else None,
        "median_price": median_number(prices),
        "strong_count": strong_count,
        "strong_ratio": strong_count / count if count else 0,
        "score_sum": score_sum,
        "avg_score": score_sum / count if count else 0,
        "rows": cluster_rows,
    }


def build_price_clusters(filtered_rows: list[dict], adjacent_ratio: float = 1.8) -> list[dict]:
    priced_rows = sorted(
        [row for row in filtered_rows if row.get("price") is not None and float(row["price"]) > 0],
        key=lambda row: float(row["price"]),
    )
    if not priced_rows:
        return []

    clusters: list[list[dict]] = []
    for start in range(len(priced_rows)):
        cluster = [priced_rows[start]]
        cluster_min_price = float(priced_rows[start]["price"])
        previous_price = cluster_min_price
        for row in priced_rows[start + 1:]:
            current_price = float(row["price"])
            if current_price / previous_price <= adjacent_ratio and current_price / cluster_min_price <= adjacent_ratio:
                cluster.append(row)
                previous_price = current_price
            else:
                break
        clusters.append(cluster)
    return [price_cluster_summary(cluster) for cluster in clusters]


def choose_price_cluster(price_clusters: list[dict], all_median: float | None = None) -> dict | None:
    if not price_clusters:
        return None
    return sorted(
        price_clusters,
        key=lambda cluster: (
            cluster["count"],
            cluster["strong_count"],
            cluster["avg_score"],
            -abs((cluster["median_price"] or 0) - all_median) if all_median else 0,
        ),
        reverse=True,
    )[0]


def scored_similarity_rows(rows: list[dict], expect_title: str, expect_model: str, expect_category: str, match_top: int) -> list[dict]:
    model_needles = model_tokens(expect_model)
    title_needles = title_tokens(expect_title)
    category_needles = category_tokens(expect_category)
    weak_needles = [token for token in category_needles if token not in title_needles]
    scored = []
    for rank, row in enumerate(rows[:match_top], 1):
        title = row.get("title", "")
        semantic_hits = {
            "model": matching_tokens(title, model_needles),
            "title": matching_tokens(title, title_needles),
            "category": matching_tokens(title, weak_needles),
        }
        model_hits = len(semantic_hits["model"])
        title_hits = len(semantic_hits["title"])
        category_hits = len(semantic_hits["category"])
        bad_hits = count_hits(title, BAD_ACCESSORY_HINTS)
        score = model_hits * 3 + title_hits * 2 + category_hits - bad_hits * 3
        if bad_hits:
            level = "bad"
        elif model_needles and model_hits:
            level = "strong"
        elif title_hits >= 1 or score >= 2:
            level = "strong"
        elif category_hits or score > 0:
            level = "weak"
        else:
            level = "none"
        scored.append({
            **row,
            "rank": rank,
            "score": score,
            "level": level,
            "bad_hits": bad_hits,
            "semantic_hits": semantic_hits,
        })
    return scored


def build_same_item_evidence(
    filtered_rows: list[dict],
    *,
    expect_title: str,
    expect_model: str,
    expect_category: str,
    expect_price_cny: float | None,
    cost_source: str,
    selected_cost: float,
    selected_offer_id: str,
    selected_cluster_rows: list[dict],
    balanced_match: dict,
) -> tuple[str, str]:
    """Bind accepted return rows and request semantics into one auditable digest."""
    evidence = {
        "contract": "1688-returned-same-item-v3",
        "cost_source": cost_source,
        "request": {
            "expect_category": normalize_text(expect_category),
            "expect_model": normalize_text(expect_model),
            "expect_title": normalize_text(expect_title),
            "expect_price_cny": _adaptive_positive_price(expect_price_cny),
        },
        "rows": [
            {
                "offer_id": str(row.get("offerId") or "").strip(),
                "supplier_id": normalize_supplier(row.get("shop")),
                "supplier": normalize_text(row.get("shop")),
                "image_url": str(row.get("pic") or "").strip(),
                "offer_url": str(row.get("url") or "").strip(),
                "sale_quantity": parse_int(row.get("saleQuantity")),
                "price": float(row["price"]),
                "rank": int(row.get("rank") or 0),
                "semantic_hits": {
                    "category": list((row.get("semantic_hits") or {}).get("category") or []),
                    "model": list((row.get("semantic_hits") or {}).get("model") or []),
                    "title": list((row.get("semantic_hits") or {}).get("title") or []),
                },
                "semantic_hits_v3": dict(row.get("semantic_hits_v3") or {}),
                "semantic_strength": str(row.get("semantic_strength") or "weak_or_none"),
                "image": dict(row.get("image") or {"available": False}),
                "specs": dict(row.get("specs") or {}),
                "spec_conflicts": list(row.get("spec_conflicts") or []),
                "accessory_conflict": bool(row.get("accessory_conflict")),
                "title": normalize_text(row.get("title")),
            }
            for row in filtered_rows
        ],
        "selected_cluster": [
            {
                "offer_id": str(row.get("offerId") or "").strip(),
                "supplier_id": normalize_supplier(row.get("shop")),
                "price": float(row["price"]),
            }
            for row in selected_cluster_rows
        ],
        "selected_cost": float(selected_cost),
        "selected_offer_id": str(selected_offer_id or "").strip(),
        "balanced_match": {
            "passed": bool(balanced_match.get("passed")),
            "match_type": str(balanced_match.get("match_type") or "rejected"),
            "reason": str(balanced_match.get("reason") or ""),
            "image_available": bool(balanced_match.get("image_available")),
            "supporting_offer_ids": list(balanced_match.get("supporting_offer_ids") or []),
            "expected_specs": dict(balanced_match.get("expected_specs") or {}),
        },
    }
    encoded = json.dumps(evidence, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return encoded, hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _image_first_page_p70_cost(
    rows: list[dict],
    *,
    expect_title: str,
    expect_model: str,
    expect_category: str,
    expect_price_cny: float | None,
    page_size: int,
    source_image_path: Path | str | None,
    excluded_offer_ids: set[str],
) -> dict | None:
    """Bounded cross-language fallback using visual and supplier corroboration."""
    if source_image_path is None:
        return None
    image_path = Path(source_image_path).expanduser().resolve()
    if not image_path.is_file():
        return None

    ranked_rows = scored_similarity_rows(
        rows,
        expect_title,
        expect_model,
        expect_category,
        max(4, min(6, int(page_size) if int(page_size) > 0 else 6)),
    )
    probe_rows = [
        row for row in ranked_rows[:6]
        if str(row.get("offerId") or "").strip()
        and str(row.get("offerId") or "").strip() not in excluded_offer_ids
        and str(row.get("pic") or "").strip()
        and row.get("price") is not None
        and float(row.get("price") or 0) > 0
        and not row.get("bad_hits")
    ]
    if len(probe_rows) < 2:
        return None

    def probe(row: dict) -> tuple[str, dict]:
        offer_id = str(row.get("offerId") or "").strip()
        try:
            metrics = compare_remote_image(
                image_path,
                str(row.get("pic") or ""),
                timeout_seconds=IMAGE_FIRST_PROBE_TIMEOUT_SECONDS,
            )
        except Exception as exc:  # pragma: no cover - defensive network boundary
            metrics = {"available": False, "reason": f"image-error:{type(exc).__name__}"}
        return offer_id, dict(metrics or {"available": False, "reason": "image-not-checked"})

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(probe_rows))) as pool:
        image_metrics_by_offer = dict(pool.map(probe, probe_rows))
    image_rows = [
        row for row in probe_rows
        if float((image_metrics_by_offer.get(str(row.get("offerId") or "")) or {}).get("score") or 0)
        >= IMAGE_ONLY_SIMILARITY
    ]
    if len(image_rows) < 2:
        return None

    selected_cluster = choose_price_cluster(
        build_price_clusters(image_rows),
        median_number([float(row["price"]) for row in image_rows]),
    )
    selected_cluster_rows = list((selected_cluster or {}).get("rows") or [])
    if len(selected_cluster_rows) < 2:
        return None
    suppliers = {
        normalize_supplier(row.get("shop"))
        for row in selected_cluster_rows
        if normalize_supplier(row.get("shop"))
    }
    if len(suppliers) < 2:
        return None

    balanced_match = balanced_same_item_assessment(
        selected_cluster_rows,
        expect_title=expect_title,
        expect_model=expect_model,
        expect_category=expect_category,
        source_image_path=image_path,
        image_metrics_by_offer=image_metrics_by_offer,
    )
    if not balanced_match.get("passed"):
        return None

    prices = sorted(float(row["price"]) for row in selected_cluster_rows)
    p70_cost = prices[p70_index(len(prices))]
    selected = sorted(
        selected_cluster_rows,
        key=lambda row: (abs(float(row["price"]) - p70_cost), -row.get("score", 0), row.get("title", "")),
    )[0]
    balanced_by_offer = {
        str(row.get("offerId") or ""): row
        for row in balanced_match.get("rows") or []
    }
    evidence_rows = [
        {**row, **balanced_by_offer.get(str(row.get("offerId") or ""), {})}
        for row in image_rows
    ]
    evidence_cluster_rows = [
        {**row, **balanced_by_offer.get(str(row.get("offerId") or ""), {})}
        for row in selected_cluster_rows
    ]
    cost_source = "search_first_page_cluster_p70_similarity_filtered"
    same_item_evidence, match_evidence_key = build_same_item_evidence(
        evidence_rows,
        expect_title=expect_title,
        expect_model=expect_model,
        expect_category=expect_category,
        expect_price_cny=expect_price_cny,
        cost_source=cost_source,
        selected_cost=p70_cost,
        selected_offer_id=str(selected.get("offerId") or "").strip(),
        selected_cluster_rows=evidence_cluster_rows,
        balanced_match=balanced_match,
    )
    adaptive_match = adaptive_decision_from_evidence(json.loads(same_item_evidence))
    return {
        "decision": "LIGHT_ACCEPT",
        "reason": "image-first same-item cluster corroborated by independent suppliers",
        "p70_cost": p70_cost,
        "selected_offer_id": selected.get("offerId"),
        "first_page_prices": [float(row["price"]) for row in ranked_rows if row.get("price") is not None],
        "filtered_first_page_prices": prices,
        "price_clusters": build_price_clusters(image_rows),
        "selected_price_cluster": selected_cluster,
        "cluster_p70_cost": p70_cost,
        "cluster_p80_cost": prices[p80_index(len(prices))],
        "cost_source": cost_source,
        "same_item_evidence": same_item_evidence,
        "match_evidence_key": match_evidence_key,
        "adaptive_match": adaptive_match,
        "balanced_match": {key: value for key, value in balanced_match.items() if key != "rows"},
        "filtered_rows": image_rows,
        "excluded_rows": [],
        "image_first_fallback": True,
    }


def first_page_p70_cost(
    rows: list[dict],
    *,
    expect_title: str = "",
    expect_model: str = "",
    expect_category: str = "",
    expect_price_cny: float | None = None,
    page_size: int = 10,
    minimum_matches: int = 3,
    source_image_path: Path | str | None = None,
    image_metrics_by_offer: dict[str, dict] | None = None,
    excluded_offer_ids: list[str] | set[str] | tuple[str, ...] | None = None,
) -> dict:
    required_matches = max(1, int(minimum_matches))
    blocked_offer_ids = {
        str(offer_id).strip()
        for offer_id in (excluded_offer_ids or [])
        if str(offer_id).strip()
    }
    first_page = scored_similarity_rows(rows, expect_title, expect_model, expect_category, page_size)
    first_page_prices = [row["price"] for row in first_page if row.get("price") is not None]
    allowed_levels = {"strong"} if any(row["level"] == "strong" for row in first_page) else set()
    model_needles = model_tokens(expect_model)
    model_required = bool(model_needles)

    raw_prices = sorted(float(row["price"]) for row in first_page if row.get("price") is not None and float(row["price"]) > 0)
    candidate_rows = []
    excluded_rows = []
    seen_offer_ids = set()
    for row in first_page:
        price = row.get("price")
        offer_id = str(row.get("offerId") or "").strip()
        semantic_hits = row.get("semantic_hits") or {}
        has_required_semantic_hit = (
            bool(semantic_hits.get("model"))
            if model_required
            else bool(semantic_hits.get("title"))
        )
        reason = ""
        if offer_id and offer_id in blocked_offer_ids:
            reason = "manually blocked 1688 offer"
        elif price is None or float(price) <= 0:
            reason = "missing or invalid price"
        elif row.get("bad_hits"):
            reason = "accessory or packaging title"
        elif not allowed_levels or row.get("level") not in allowed_levels:
            reason = "not a strong same-item semantic match"
        elif not has_required_semantic_hit:
            reason = (
                "explicit model token not matched"
                if model_required
                else "explicit title token not matched"
            )
        elif not offer_id:
            reason = "missing returned offer identity"
        elif offer_id in seen_offer_ids:
            reason = "duplicate returned offer identity"

        if reason:
            excluded_rows.append({**row, "exclude_reason": reason})
        else:
            seen_offer_ids.add(offer_id)
            candidate_rows.append(row)

    anchor_prices = sorted(float(row["price"]) for row in candidate_rows)
    anchor_median = anchor_prices[len(anchor_prices) // 2] if anchor_prices else None
    filtered_rows = []
    for row in candidate_rows:
        price = row.get("price")
        reason = ""
        if anchor_median and len(anchor_prices) >= 3 and float(price) < anchor_median * 0.25:
            reason = "extreme low price"
        elif anchor_median and len(anchor_prices) >= 5 and float(price) > anchor_median * 8:
            reason = "extreme high price"

        if reason:
            excluded_rows.append({**row, "exclude_reason": reason})
        else:
            filtered_rows.append(row)

    filtered_prices = sorted(float(row["price"]) for row in filtered_rows if row.get("price") is not None)
    if len(filtered_prices) < required_matches:
        fallback = _image_first_page_p70_cost(
            rows,
            expect_title=expect_title,
            expect_model=expect_model,
            expect_category=expect_category,
            expect_price_cny=expect_price_cny,
            page_size=page_size,
            source_image_path=source_image_path,
            excluded_offer_ids=blocked_offer_ids,
        )
        if fallback is not None:
            return fallback
        shortage_reason = (
            "no explicit title/model/category semantic same-item matches"
            if not candidate_rows
            else f"filtered first-page 1688 candidates fewer than {required_matches}"
        )
        return {
            "decision": "REVIEW",
            "reason": shortage_reason,
            "p70_cost": None,
            "selected_offer_id": None,
            "first_page_prices": first_page_prices,
            "filtered_first_page_prices": filtered_prices,
            "price_clusters": [],
            "selected_price_cluster": None,
            "cluster_p70_cost": None,
            "cluster_p80_cost": None,
            "filtered_rows": filtered_rows,
            "excluded_rows": excluded_rows,
        }
    all_median = median_number(filtered_prices)
    price_clusters = build_price_clusters(filtered_rows)
    selected_cluster = choose_price_cluster(price_clusters, all_median)
    if not selected_cluster or selected_cluster["count"] < required_matches:
        return {
            "decision": "REVIEW",
            "reason": f"main price cluster fewer than {required_matches} {filtered_prices}",
            "p70_cost": None,
            "selected_offer_id": None,
            "first_page_prices": first_page_prices,
            "filtered_first_page_prices": filtered_prices,
            "price_clusters": price_clusters,
            "selected_price_cluster": selected_cluster,
            "cluster_p70_cost": None,
            "cluster_p80_cost": None,
            "filtered_rows": filtered_rows,
            "excluded_rows": excluded_rows,
        }

    main_prices = selected_cluster["prices"]
    spread_prices = filtered_prices if allowed_levels else raw_prices
    full_spread_ratio = spread_prices[-1] / spread_prices[0] if spread_prices and spread_prices[0] > 0 else 0
    main_share = selected_cluster["count"] / len(filtered_prices) if filtered_prices else 0
    main_median = selected_cluster["median_price"]
    median_ratio = max(main_median, all_median) / min(main_median, all_median) if main_median and all_median else 1
    min_main_share = 0.4 if selected_cluster["count"] >= 3 and selected_cluster["strong_ratio"] >= 0.6 else 0.5
    if main_share < min_main_share:
        return {
            "decision": "REVIEW",
            "reason": f"main price cluster share below {min_main_share:.0%} {main_prices} of {filtered_prices}",
            "p70_cost": None,
            "selected_offer_id": None,
            "first_page_prices": first_page_prices,
            "filtered_first_page_prices": filtered_prices,
            "price_clusters": price_clusters,
            "selected_price_cluster": selected_cluster,
            "cluster_p70_cost": None,
            "cluster_p80_cost": None,
            "filtered_rows": filtered_rows,
            "excluded_rows": excluded_rows,
        }
    if median_ratio > 2.5:
        return {
            "decision": "REVIEW",
            "reason": f"main price cluster median too far from all prices {main_prices} of {filtered_prices}",
            "p70_cost": None,
            "selected_offer_id": None,
            "first_page_prices": first_page_prices,
            "filtered_first_page_prices": filtered_prices,
            "price_clusters": price_clusters,
            "selected_price_cluster": selected_cluster,
            "cluster_p70_cost": None,
            "cluster_p80_cost": None,
            "filtered_rows": filtered_rows,
            "excluded_rows": excluded_rows,
        }
    if full_spread_ratio > 15 and not (selected_cluster["count"] >= 5 and selected_cluster["strong_ratio"] >= 0.6):
        return {
            "decision": "REVIEW",
            "reason": f"extreme price spread without strong main cluster {filtered_prices}",
            "p70_cost": None,
            "selected_offer_id": None,
            "first_page_prices": first_page_prices,
            "filtered_first_page_prices": filtered_prices,
            "price_clusters": price_clusters,
            "selected_price_cluster": selected_cluster,
            "cluster_p70_cost": None,
            "cluster_p80_cost": None,
            "filtered_rows": filtered_rows,
            "excluded_rows": excluded_rows,
        }

    cluster_p70_cost = main_prices[p70_index(len(main_prices))]
    cluster_p80_cost = main_prices[p80_index(len(main_prices))]
    use_p80 = full_spread_ratio > 8
    selected_cost = cluster_p80_cost if use_p80 else cluster_p70_cost
    selected = sorted(
        selected_cluster["rows"],
        key=lambda row: (abs(float(row["price"]) - selected_cost), -row.get("score", 0), row.get("title", "")),
    )[0]
    cost_source = (
        "search_first_page_cluster_p80_similarity_filtered"
        if use_p80
        else "search_first_page_cluster_p70_similarity_filtered"
    )
    balanced_match = balanced_same_item_assessment(
        selected_cluster["rows"],
        expect_title=expect_title,
        expect_model=expect_model,
        expect_category=expect_category,
        source_image_path=Path(source_image_path).expanduser().resolve() if source_image_path else None,
        image_metrics_by_offer=image_metrics_by_offer,
    )
    balanced_by_offer = {
        str(row.get("offerId") or ""): row
        for row in balanced_match.get("rows") or []
    }
    evidence_rows = [
        {**row, **balanced_by_offer.get(str(row.get("offerId") or ""), {})}
        for row in filtered_rows
    ]
    evidence_cluster_rows = [
        {**row, **balanced_by_offer.get(str(row.get("offerId") or ""), {})}
        for row in selected_cluster["rows"]
    ]
    same_item_evidence, match_evidence_key = build_same_item_evidence(
        evidence_rows,
        expect_title=expect_title,
        expect_model=expect_model,
        expect_category=expect_category,
        expect_price_cny=expect_price_cny,
        cost_source=cost_source,
        selected_cost=selected_cost,
        selected_offer_id=str(selected.get("offerId") or "").strip(),
        selected_cluster_rows=evidence_cluster_rows,
        balanced_match=balanced_match,
    )
    adaptive_match = adaptive_decision_from_evidence(json.loads(same_item_evidence))
    return {
        "decision": "LIGHT_ACCEPT",
        "reason": "filtered first-page similarity clustered cost",
        "p70_cost": selected_cost,
        "selected_offer_id": selected.get("offerId"),
        "first_page_prices": first_page_prices,
        "filtered_first_page_prices": filtered_prices,
        "price_clusters": price_clusters,
        "selected_price_cluster": selected_cluster,
        "cluster_p70_cost": cluster_p70_cost,
        "cluster_p80_cost": cluster_p80_cost,
        "cost_source": cost_source,
        "same_item_evidence": same_item_evidence,
        "match_evidence_key": match_evidence_key,
        "adaptive_match": adaptive_match,
        "balanced_match": {
            key: value for key, value in balanced_match.items() if key != "rows"
        },
        "filtered_rows": filtered_rows,
        "excluded_rows": excluded_rows,
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
        image_url = str(data.get("offerPicUrl") or data.get("odPicUrl") or "").strip()
        if image_url.startswith("//"):
            image_url = f"https:{image_url}"
        rows.append(
            {
                "offerId": data.get("offerId"),
                "title": data.get("title", ""),
                "price": price,
                "saleQuantity": sale,
                "shop": (data.get("shop") or {}).get("text") or data.get("loginId"),
                "pic": image_url,
                "url": data.get("linkUrl"),
            }
        )
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="Path to the product image crop")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON only")
    parser.add_argument("--top", type=int, default=10, help="How many sorted rows to show")
    parser.add_argument("--expect-title", default="", help="Ozon product title for fast match screening")
    parser.add_argument("--expect-model", default="", help="Product model/article/SKU-like text for strong matching")
    parser.add_argument("--expect-category", default="", help="Ozon/Maozi category text for fast match screening")
    parser.add_argument(
        "--expect-price-cny",
        type=float,
        default=None,
        help="Target product price in CNY for v5 valuable-digital policy",
    )
    parser.add_argument("--match-top", type=int, default=10, help="How many high-sales rows to scan for title/model matches")
    parser.add_argument("--min-matches", type=int, default=3, help="Minimum trustworthy same-item offers required")
    parser.add_argument(
        "--exclude-offer-id",
        action="append",
        default=[],
        help="1688 offer ID excluded by confirmed manual feedback (repeatable)",
    )
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
    p70 = first_page_p70_cost(
        rows,
        expect_title=args.expect_title,
        expect_model=args.expect_model,
        expect_category=args.expect_category,
        expect_price_cny=args.expect_price_cny,
        page_size=args.top,
        minimum_matches=max(1, args.min_matches),
        excluded_offer_ids=args.exclude_offer_id,
        source_image_path=image_path,
    )

    payload = {
        "image": str(image_path),
        "upload_image": str(upload_path),
        "note": note,
        "decision": p70["decision"],
        "reason": p70["reason"],
        "selected_cost": p70["p70_cost"],
        "selected_offer_id": p70["selected_offer_id"],
        "cost_source": p70.get("cost_source") or "search_first_page_p70_similarity_filtered",
        "first_page_prices": p70["first_page_prices"],
        "filtered_first_page_prices": p70["filtered_first_page_prices"],
        "price_clusters": p70["price_clusters"],
        "selected_price_cluster": p70["selected_price_cluster"],
        "cluster_p70_cost": p70["cluster_p70_cost"],
        "cluster_p80_cost": p70["cluster_p80_cost"],
        "p70_cost": p70["p70_cost"],
        "filtered_rows": p70["filtered_rows"],
        "excluded_rows": p70["excluded_rows"],
        "balanced_match": p70.get("balanced_match"),
        "adaptive_match": p70.get("adaptive_match"),
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
    print("DECISION", payload["decision"])
    if p70.get("same_item_evidence"):
        print("SAME_ITEM_EVIDENCE", p70["same_item_evidence"])
    if p70.get("match_evidence_key"):
        print("MATCH_EVIDENCE_KEY", p70["match_evidence_key"])
    if p70.get("selected_offer_id"):
        print("SELECTED_OFFER_ID", p70["selected_offer_id"])
    if p70.get("balanced_match"):
        print("BALANCED_MATCH_OK", str(bool(p70["balanced_match"].get("passed"))).lower())
        print("BALANCED_MATCH_TYPE", p70["balanced_match"].get("match_type") or "rejected")
        print("BALANCED_MATCH_REASON", p70["balanced_match"].get("reason") or "")
        print("IMAGE_CHECK_AVAILABLE", str(bool(p70["balanced_match"].get("image_available"))).lower())
    if p70.get("adaptive_match"):
        print(
            "ADAPTIVE_MATCH_JSON",
            json.dumps(p70["adaptive_match"], ensure_ascii=False, separators=(",", ":")),
        )
    print("COST_SOURCE", payload["cost_source"])
    print("REASON", payload["reason"])
    for index, row in enumerate(payload["top_rows"], 1):
        title = row["title"][:80]
        print(
            f"{index}. sale={row['saleQuantity']} price={row['price']} "
            f"offer={row['offerId']} shop={row.get('shop') or ''} title={title}"
        )
    print("FIRST_PAGE_PRICES", payload["first_page_prices"])
    print("FILTERED_FIRST_PAGE_PRICES", payload["filtered_first_page_prices"])
    print("PRICE_CLUSTERS", json.dumps(payload["price_clusters"], ensure_ascii=False))
    print("SELECTED_PRICE_CLUSTER", json.dumps(payload["selected_price_cluster"], ensure_ascii=False))
    print("CLUSTER_P70_COST", payload["cluster_p70_cost"])
    print("CLUSTER_P80_COST", payload["cluster_p80_cost"])
    print("P70_COST", payload["p70_cost"])
    print("TOP3_PRICES", payload["top3_prices"])
    print("MEDIAN_COST", payload["median_cost"])
    if payload["match"]:
        print("MATCH_DECISION", payload["match"]["decision"])
        print("MATCH_REASON", payload["match"]["reason"])
        print("MATCH_MODEL_TOKENS", payload["match"]["model_tokens"])
        print("MATCH_TITLE_TOKENS", payload["match"]["title_tokens"])
        print("MATCHED_PRICES", payload["match"]["matched_prices"])
        print("MATCHED_MEDIAN_COST", payload["match"]["matched_median_cost"])
    return 0 if payload["p70_cost"] is not None else 2


if __name__ == "__main__":
    sys.exit(main())
