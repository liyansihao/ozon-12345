import hashlib
import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "1688_image_median.py"


spec = importlib.util.spec_from_file_location("image_median_1688", SCRIPT)
image_median_1688 = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(image_median_1688)


def rows(prices, *, strong=True):
    level_title = "same product lamp"
    return [
        {
            "offerId": f"offer-{index}",
            "title": level_title,
            "price": price,
            "saleQuantity": 100 + index,
            "shop": "shop",
        }
        for index, price in enumerate(prices, 1)
    ]


class FirstPageClusterCostTest(unittest.TestCase):
    def test_selects_main_mid_cluster_instead_of_low_cluster(self):
        result = image_median_1688.first_page_p70_cost(
            rows([44, 60, 80, 135, 159, 168, 175, 265]),
            expect_title="same product lamp",
            page_size=10,
        )

        self.assertEqual(result["decision"], "LIGHT_ACCEPT")
        self.assertEqual(result["selected_price_cluster"]["prices"], [135.0, 159.0, 168.0, 175.0])
        self.assertEqual(result["p70_cost"], 168.0)
        self.assertEqual(result["cost_source"], "search_first_page_cluster_p70_similarity_filtered")
        evidence = json.loads(result["same_item_evidence"])
        self.assertEqual(evidence["selected_cost"], 168.0)
        self.assertEqual(evidence["cost_source"], result["cost_source"])
        self.assertEqual(
            [row["offer_id"] for row in evidence["selected_cluster"]],
            ["offer-4", "offer-5", "offer-6", "offer-7"],
        )
        self.assertEqual(
            hashlib.sha256(result["same_item_evidence"].encode("utf-8")).hexdigest(),
            result["match_evidence_key"],
        )

    def test_excludes_low_anchor_and_selects_body_cluster(self):
        result = image_median_1688.first_page_p70_cost(
            rows([5.8, 7.25, 17, 19.8, 21.3, 23.8, 60]),
            expect_title="same product lamp",
            page_size=10,
        )

        self.assertEqual(result["decision"], "LIGHT_ACCEPT")
        self.assertEqual(result["selected_price_cluster"]["prices"], [17.0, 19.8, 21.3, 23.8])
        self.assertEqual(result["p70_cost"], 23.8)

    def test_keeps_review_when_main_cluster_has_fewer_than_three(self):
        result = image_median_1688.first_page_p70_cost(
            rows([10, 18, 35, 70]),
            expect_title="same product lamp",
            page_size=10,
        )

        self.assertEqual(result["decision"], "REVIEW")
        self.assertIn("main price cluster fewer than 3", result["reason"])

    def test_extreme_spread_requires_strong_cluster(self):
        result = image_median_1688.first_page_p70_cost(
            rows([10, 18, 35, 70, 200, 210, 220, 230]),
            page_size=10,
        )

        self.assertEqual(result["decision"], "REVIEW")
        self.assertIn("semantic", result["reason"])

    def test_russian_title_evidence_filters_a_larger_unrelated_price_cluster(self):
        result = image_median_1688.first_page_p70_cost(
            [
                *[
                    {
                        "offerId": f"unrelated-{index}",
                        "title": "автомобильный чехол для сиденья",
                        "price": price,
                        "saleQuantity": 200 + index,
                        "shop": "other",
                    }
                    for index, price in enumerate([1, 1.1, 1.2, 1.3], 1)
                ],
                *[
                    {
                        "offerId": f"match-{index}",
                        "title": "детская кепка миньон",
                        "price": price,
                        "saleQuantity": 100 + index,
                        "shop": "same",
                    }
                    for index, price in enumerate([10, 11, 12], 1)
                ],
            ],
            expect_title="детская кепка миньон",
            page_size=10,
        )

        self.assertEqual(result["decision"], "LIGHT_ACCEPT")
        self.assertEqual(result["filtered_first_page_prices"], [10.0, 11.0, 12.0])
        self.assertEqual(result["p70_cost"], 12.0)

    def test_russian_expected_title_rejects_only_unrelated_car_seat_returns(self):
        result = image_median_1688.first_page_p70_cost(
            [
                {
                    "offerId": f"car-seat-{index}",
                    "title": "автомобильный чехол для сиденья",
                    "price": price,
                    "saleQuantity": 200 + index,
                    "shop": "unrelated",
                }
                for index, price in enumerate([10, 11, 12, 13], 1)
            ],
            expect_title="детская кепка миньон",
            page_size=10,
        )

        self.assertEqual(result["decision"], "REVIEW")
        self.assertIsNone(result["p70_cost"])
        self.assertEqual(result["filtered_first_page_prices"], [])
        self.assertIn("semantic", result["reason"])

    def test_category_only_rows_cannot_prove_exact_same_item(self):
        result = image_median_1688.first_page_p70_cost(
            [
                {
                    "offerId": f"category-only-{index}",
                    "title": f"汽车通用精品 {index}",
                    "price": price,
                    "saleQuantity": 100 + index,
                    "shop": "category",
                }
                for index, price in enumerate([20, 21, 22], 1)
            ],
            expect_title="детская кепка миньон",
            expect_category="汽车",
            page_size=10,
        )

        self.assertEqual(result["decision"], "REVIEW")
        self.assertIsNone(result["p70_cost"])
        self.assertEqual(result["filtered_first_page_prices"], [])
        self.assertTrue(all(
            "title token" in row["exclude_reason"] or "strong" in row["exclude_reason"]
            for row in result["excluded_rows"]
        ))

    def test_every_cost_row_must_match_explicit_model(self):
        result = image_median_1688.first_page_p70_cost(
            [
                {
                    "offerId": "model-1",
                    "title": "omoda s5 уплотнитель",
                    "price": 20,
                    "saleQuantity": 101,
                    "shop": "same",
                },
                {
                    "offerId": "model-2",
                    "title": "omoda s5 уплотнитель",
                    "price": 21,
                    "saleQuantity": 102,
                    "shop": "same",
                },
                {
                    "offerId": "wrong-model",
                    "title": "omoda c5 уплотнитель",
                    "price": 22,
                    "saleQuantity": 103,
                    "shop": "wrong",
                },
            ],
            expect_title="omoda уплотнитель",
            expect_model="S5",
            page_size=10,
        )

        self.assertEqual(result["decision"], "REVIEW")
        self.assertIsNone(result["p70_cost"])
        self.assertEqual(result["filtered_first_page_prices"], [20.0, 21.0])
        self.assertIn("fewer than 3", result["reason"])

    def test_non_model_metadata_does_not_disable_explicit_title_matching(self):
        result = image_median_1688.first_page_p70_cost(
            rows([20, 21, 22]),
            expect_title="same product lamp",
            expect_model="cap",
            page_size=10,
        )

        self.assertEqual(result["decision"], "LIGHT_ACCEPT")
        self.assertEqual(result["filtered_first_page_prices"], [20.0, 21.0, 22.0])
        self.assertEqual(result["p70_cost"], 22.0)

    def test_short_alphanumeric_model_remains_an_exact_required_signal(self):
        result = image_median_1688.first_page_p70_cost(
            [
                {
                    "offerId": "m4-1",
                    "title": "bmw m4 grille",
                    "price": 20,
                    "saleQuantity": 101,
                    "shop": "same",
                },
                {
                    "offerId": "m4-2",
                    "title": "bmw m4 grille",
                    "price": 21,
                    "saleQuantity": 102,
                    "shop": "same",
                },
                {
                    "offerId": "wrong-model",
                    "title": "bmw m3 grille",
                    "price": 22,
                    "saleQuantity": 103,
                    "shop": "wrong",
                },
            ],
            expect_title="bmw grille",
            expect_model="M4",
            page_size=10,
        )

        self.assertEqual(image_median_1688.model_tokens("M4"), ["m4"])
        self.assertEqual(result["decision"], "REVIEW")
        self.assertEqual(result["filtered_first_page_prices"], [20.0, 21.0])
        self.assertIn("fewer than 3", result["reason"])


if __name__ == "__main__":
    unittest.main()
