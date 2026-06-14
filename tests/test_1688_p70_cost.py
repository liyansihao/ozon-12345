import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "flow_b_codex_transfer_20260608" / "scripts"
sys.path.insert(0, str(SCRIPTS))

_SPEC = importlib.util.spec_from_file_location("image_median_1688", SCRIPTS / "1688_image_median.py")
assert _SPEC and _SPEC.loader
image_median = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(image_median)

from flow_b_process_batch import parse_costs  # noqa: E402
from flow_b_process_batch import FLOW_B_DAILY_ROUTES  # noqa: E402
from flow_b_process_batch import direct_category_skip_reason  # noqa: E402


class FlowB1688P70CostTests(unittest.TestCase):
    def test_yjm_route_uses_yjm_shop_and_watermark(self):
        route = FLOW_B_DAILY_ROUTES["yjm"]

        self.assertEqual(route["shop_id"], 86890)
        self.assertEqual(route["shop_name"], "YJM")
        self.assertEqual(route["watermark_id"], 52054)
        self.assertEqual(route["watermark_name"], "YJM")

    def test_direct_skip_blocks_branded_tool_title(self):
        item = {"title": "KNIPEX 71 01 160 CoBolt Компактные болторезы"}

        self.assertEqual(direct_category_skip_reason(item), "direct skip: branded/high-risk title")

    def test_direct_skip_keeps_generic_tool_title_available(self):
        item = {"title": "Компактные болторезы 160 мм для ремонта"}

        self.assertIsNone(direct_category_skip_reason(item))

    def test_summarize_products_preserves_similarity_order(self):
        raw_products = [
            {"data": {"offerId": "similar", "title": "similar result", "priceInfo": {"price": "30"}, "saleQuantity": "5"}},
            {"data": {"offerId": "popular", "title": "popular result", "priceInfo": {"price": "10"}, "saleQuantity": "500"}},
            {"data": {"offerId": "middle", "title": "middle result", "priceInfo": {"price": "20"}, "saleQuantity": "50"}},
        ]

        rows = image_median.summarize_products(raw_products)

        self.assertEqual([row["offerId"] for row in rows], ["similar", "popular", "middle"])

    def test_first_page_similarity_p70_filters_invalid_candidates(self):
        rows = [
            {"offerId": "A1", "title": "LED wall lamp 6W", "price": 10, "saleQuantity": 10},
            {"offerId": "A2", "title": "LED wall lamp 12W", "price": 12, "saleQuantity": 9},
            {"offerId": "A3", "title": "LED wall lamp 18W", "price": 14, "saleQuantity": 8},
            {"offerId": "A4", "title": "LED wall lamp 24W", "price": 16, "saleQuantity": 7},
            {"offerId": "A5", "title": "LED wall lamp 30W", "price": 18, "saleQuantity": 6},
            {"offerId": "A6", "title": "LED wall lamp 36W", "price": 20, "saleQuantity": 5},
            {"offerId": "A7", "title": "LED wall lamp 42W", "price": 22, "saleQuantity": 4},
            {"offerId": "A8", "title": "LED wall lamp 48W", "price": 24, "saleQuantity": 3},
            {"offerId": "A9", "title": "LED wall lamp packaging box only", "price": 1, "saleQuantity": 1000},
            {"offerId": "A10", "title": "LED wall lamp 60W", "price": 1000, "saleQuantity": 2},
        ]

        result = image_median.first_page_p70_cost(rows, expect_title="Настенный светильник LED", expect_model="", expect_category="lighting", page_size=10)

        self.assertEqual(result["decision"], "LIGHT_ACCEPT")
        self.assertEqual(result["p70_cost"], 20)
        self.assertEqual(result["selected_offer_id"], "A6")
        self.assertEqual(result["first_page_prices"], [10, 12, 14, 16, 18, 20, 22, 24, 1, 1000])
        self.assertEqual(result["filtered_first_page_prices"], [10, 12, 14, 16, 18, 20, 22, 24])
        self.assertGreaterEqual(len(result["excluded_rows"]), 2)

    def test_first_page_p70_returns_review_when_filtered_candidates_are_too_few(self):
        rows = [
            {"offerId": "A1", "title": "LED wall lamp 12W", "price": 12, "saleQuantity": 9},
            {"offerId": "A2", "title": "LED wall lamp packaging box only", "price": 1, "saleQuantity": 1000},
            {"offerId": "A3", "title": "unrelated phone case", "price": 9, "saleQuantity": 8},
        ]

        result = image_median.first_page_p70_cost(rows, expect_title="Настенный светильник LED", expect_model="", expect_category="lighting", page_size=10)

        self.assertEqual(result["decision"], "REVIEW")
        self.assertIsNone(result["p70_cost"])

    def test_parse_costs_uses_p70_cost_and_preserves_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            batch = Path(tmp)
            (batch / "1688").mkdir()
            (batch / "1688" / "sku1.out").write_text(
                "\n".join(
                    [
                        "VALID_COUNT 10",
                        "DECISION LIGHT_ACCEPT",
                        "COST_SOURCE search_first_page_p70_similarity_filtered",
                        "FIRST_PAGE_PRICES [10, 12, 14, 16, 18, 20, 22, 24, 1, 1000]",
                        "FILTERED_FIRST_PAGE_PRICES [10, 12, 14, 16, 18, 20, 22, 24]",
                        "P70_COST 20",
                        "TOP3_PRICES [10, 12, 14]",
                        "1. sale=10 price=10 offer=A1 shop=s title=LED wall lamp",
                    ]
                ),
                encoding="utf-8",
            )

            reliable = parse_costs(batch, [{"sku": "sku1", "title": "lamp", "sell_price": 120, "id": "1"}])
            screen = json.loads((batch / "cost_screen.json").read_text(encoding="utf-8"))

        self.assertEqual(reliable[0]["cost"], 20)
        self.assertEqual(reliable[0]["cost_source"], "search_first_page_p70_similarity_filtered")
        self.assertEqual(screen[0]["first_page_prices"], [10, 12, 14, 16, 18, 20, 22, 24, 1, 1000])
        self.assertEqual(screen[0]["filtered_first_page_prices"], [10, 12, 14, 16, 18, 20, 22, 24])
