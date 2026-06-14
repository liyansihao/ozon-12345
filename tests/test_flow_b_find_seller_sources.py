import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "flow_b_codex_transfer_20260608" / "scripts" / "flow_b_find_seller_sources.py"

_SPEC = importlib.util.spec_from_file_location("flow_b_find_seller_sources", SCRIPT)
assert _SPEC and _SPEC.loader
finder = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(finder)


class FlowBFindSellerSourcesTests(unittest.TestCase):
    def test_parse_price_text_reads_ozon_display_prices(self):
        self.assertEqual(finder.parse_price_text("75,52 ¥ 494,42¥ −84%"), 75.52)
        self.assertEqual(finder.parse_price_text("14,33 ¥"), 14.33)
        self.assertEqual(finder.parse_price_text("37 973 ¥"), 37973.0)
        self.assertEqual(finder.parse_price_text("5 758,60 ¥"), 5758.60)
        self.assertIsNone(finder.parse_price_text("Нет цены"))

    def test_product_price_filter_keeps_only_minimum_price(self):
        self.assertFalse(finder.price_is_allowed("49,99 ¥", 50))
        self.assertTrue(finder.price_is_allowed("50 ¥", 50))
        self.assertTrue(finder.price_is_allowed("75,52 ¥", 50))

    def test_normalize_seller_url_adds_minimum_price_filter(self):
        url = finder.normalize_seller_url(
            "https://www.ozon.ru/seller/horoshiy-instrument-123/?__rr=1&foo=bar",
            min_price=50,
        )

        self.assertEqual(url, "https://www.ozon.ru/seller/horoshiy-instrument-123/?currency_price=50.000%3B")

    def test_normalize_relative_seller_url(self):
        url = finder.normalize_seller_url("/seller/shandong-sheng/?from=product", min_price=50)

        self.assertEqual(url, "https://www.ozon.ru/seller/shandong-sheng/?currency_price=50.000%3B")

    def test_create_run_outputs_deduplicated_source_urls(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = finder.create_or_resume_run(
                run_root=Path(tmp),
                resume=None,
                highlight_url="https://www.ozon.ru/highlight/tovary-iz-kitaya-935133/",
                min_price=50,
            )
            rows = [
                {"seller_url": "https://www.ozon.ru/seller/a/?currency_price=50.000%3B"},
                {"seller_url": "https://www.ozon.ru/seller/a/?currency_price=50.000%3B"},
                {"seller_url": "https://www.ozon.ru/seller/b/?currency_price=50.000%3B"},
            ]

            finder.write_outputs(run_dir, rows, [{"product_url": "https://www.ozon.ru/product/1/", "price": 51}])

            self.assertEqual(
                (run_dir / "source_urls.txt").read_text(encoding="utf-8").splitlines(),
                [
                    "https://www.ozon.ru/seller/a/?currency_price=50.000%3B",
                    "https://www.ozon.ru/seller/b/?currency_price=50.000%3B",
                ],
            )
            self.assertTrue((run_dir / "start_time.txt").exists())
            self.assertTrue((run_dir / "seller_sources.json").exists())
            self.assertTrue((run_dir / "highlight_products.json").exists())


if __name__ == "__main__":
    unittest.main()
