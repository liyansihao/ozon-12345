import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "flow_b_codex_transfer_20260608" / "scripts" / "flow_b_seed_favorites_from_scan.py"

_SPEC = importlib.util.spec_from_file_location("flow_b_seed_favorites_from_scan", SCRIPT)
assert _SPEC and _SPEC.loader
seed = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(seed)


class FlowBSeedFavoritesFromScanTests(unittest.TestCase):
    def test_load_product_links_deduplicates_and_filters_risky_titles(self):
        with tempfile.TemporaryDirectory() as tmp:
            scan = Path(tmp) / "source_deep_scan.json"
            scan.write_text(
                json.dumps(
                    [
                        {
                            "source_url": "https://www.ozon.ru/seller/a/",
                            "links": [
                                {"href": "https://www.ozon.ru/product/safe-111/", "text": "LED настенный светильник"},
                                {"href": "https://www.ozon.ru/product/safe-111/?x=1", "text": "duplicate"},
                                {"href": "https://www.ozon.ru/product/risky-222/", "text": "Бейсболка Puma CLASS BB Cap"},
                                {"href": "https://www.ozon.ru/product/heavy-333/", "text": "Каркас лестницы на 3 ступени"},
                            ],
                        },
                        {
                            "source_url": "https://www.ozon.ru/seller/b/",
                            "links": [
                                {"href": "/product/pet-444/", "text": "Лоток из нержавеющей стали для кошек"},
                            ],
                        },
                    ]
                ),
                encoding="utf-8",
            )

            rows = seed.load_product_links(scan, limit=20)

        self.assertEqual(
            [row["url"] for row in rows],
            [
                "https://www.ozon.ru/product/safe-111/",
                "https://www.ozon.ru/product/pet-444/",
            ],
        )
        self.assertEqual(rows[0]["source_url"], "https://www.ozon.ru/seller/a/")

    def test_load_product_links_respects_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            scan = Path(tmp) / "source_deep_scan.json"
            scan.write_text(
                json.dumps(
                    [
                        {
                            "source_url": "https://www.ozon.ru/seller/a/",
                            "links": [
                                {"href": f"https://www.ozon.ru/product/item-{idx}/", "text": "generic home item"}
                                for idx in range(5)
                            ],
                        }
                    ]
                ),
                encoding="utf-8",
            )

            rows = seed.load_product_links(scan, limit=3)

        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[-1]["url"], "https://www.ozon.ru/product/item-2/")


if __name__ == "__main__":
    unittest.main()
