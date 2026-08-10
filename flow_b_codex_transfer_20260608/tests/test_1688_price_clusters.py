import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


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
        self.assertEqual(result["selected_offer_id"], "offer-6")
        self.assertEqual(evidence["selected_offer_id"], result["selected_offer_id"])
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

    def test_direct_mode_accepts_one_strong_same_item_offer(self):
        result = image_median_1688.first_page_p70_cost(
            rows([18]),
            expect_title="same product lamp",
            page_size=10,
            minimum_matches=1,
        )

        self.assertEqual(result["decision"], "LIGHT_ACCEPT")
        self.assertEqual(result["p70_cost"], 18.0)
        self.assertEqual(result["filtered_first_page_prices"], [18.0])
        self.assertEqual(result["selected_price_cluster"]["count"], 1)

    def test_confirmed_bad_offer_is_excluded_before_cost_selection(self):
        result = image_median_1688.first_page_p70_cost(
            rows([10, 11, 12]),
            expect_title="same product lamp",
            page_size=10,
            minimum_matches=1,
            excluded_offer_ids=["offer-2"],
        )

        self.assertEqual(result["decision"], "LIGHT_ACCEPT")
        self.assertNotIn("offer-2", [
            row["offerId"] for row in result["filtered_rows"]
        ])
        self.assertIn("offer-2", [
            row["offerId"] for row in result["excluded_rows"]
            if row["exclude_reason"] == "manually blocked 1688 offer"
        ])

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

    def test_balanced_single_source_accepts_top_three_exact_model_image_and_specs(self):
        result = image_median_1688.balanced_same_item_assessment(
            [{
                "offerId": "strong-1",
                "title": "portable camping lamp X100 20W",
                "price": 20,
                "rank": 1,
                "shop": "factory-a",
            }],
            expect_title="portable camping lamp 20W",
            expect_model="X100",
            expect_category="lighting",
            image_metrics_by_offer={"strong-1": {"available": True, "score": 0.86}},
        )
        self.assertTrue(result["passed"])
        self.assertEqual(result["match_type"], "strong_single")

    def test_weak_type_and_pure_number_cannot_prove_same_item(self):
        type_result = image_median_1688.balanced_same_item_assessment(
            [{
                "offerId": "adapter-1",
                "title": "USB Type C adapter 150",
                "price": 10,
                "rank": 1,
                "shop": "factory-a",
            }],
            expect_title="USB Type C data cable 150",
            expect_model="150",
            expect_category="cable",
            image_metrics_by_offer={"adapter-1": {"available": True, "score": 0.99}},
        )
        numeric_result = image_median_1688.balanced_same_item_assessment(
            [{
                "offerId": "numeric-1",
                "title": "150 000 pro max",
                "price": 10,
                "rank": 1,
                "shop": "factory-a",
            }],
            expect_title="150 000 pro max",
            expect_model="150",
            expect_category="",
            image_metrics_by_offer={"numeric-1": {"available": True, "score": 0.99}},
        )
        self.assertFalse(type_result["passed"])
        self.assertFalse(numeric_result["passed"])

    def test_balanced_multi_source_requires_two_distinct_suppliers_and_one_high_image(self):
        candidates = [
            {"offerId": "offer-a", "title": "portable camping lamp", "price": 20, "rank": 4, "shop": "factory-a"},
            {"offerId": "offer-b", "title": "portable camping lamp", "price": 21, "rank": 5, "shop": "factory-b"},
        ]
        passed = image_median_1688.balanced_same_item_assessment(
            candidates,
            expect_title="portable camping lamp",
            expect_model="",
            expect_category="lighting",
            image_metrics_by_offer={
                "offer-a": {"available": True, "score": 0.82},
                "offer-b": {"available": False},
            },
        )
        same_supplier = image_median_1688.balanced_same_item_assessment(
            [{**candidates[0]}, {**candidates[1], "shop": "factory-a"}],
            expect_title="portable camping lamp",
            expect_model="",
            expect_category="lighting",
            image_metrics_by_offer={"offer-a": {"available": True, "score": 0.82}},
        )
        self.assertTrue(passed["passed"])
        self.assertEqual(passed["match_type"], "corroborated_multi")
        self.assertFalse(same_supplier["passed"])

    def test_specification_conflict_and_missing_image_fail_closed(self):
        conflict = image_median_1688.balanced_same_item_assessment(
            [{"offerId": "wrong-power", "title": "portable lamp X100 10W", "price": 20, "rank": 1, "shop": "factory-a"}],
            expect_title="portable lamp 20W",
            expect_model="X100",
            expect_category="lighting",
            image_metrics_by_offer={"wrong-power": {"available": True, "score": 0.95}},
        )
        missing_image = image_median_1688.balanced_same_item_assessment(
            [{"offerId": "no-image", "title": "portable lamp X100 20W", "price": 20, "rank": 1, "shop": "factory-a"}],
            expect_title="portable lamp 20W",
            expect_model="X100",
            expect_category="lighting",
            image_metrics_by_offer={"no-image": {"available": False, "reason": "timeout"}},
        )
        self.assertFalse(conflict["passed"])
        self.assertIn("power", conflict["rows"][0]["spec_conflicts"])
        self.assertFalse(missing_image["passed"])

    def test_cross_language_product_terms_support_two_independent_suppliers(self):
        result = image_median_1688.balanced_same_item_assessment(
            [
                {"offerId": "sweater-a", "title": "stone 拉链针织毛衣", "price": 100, "rank": 4, "shop": "factory-a"},
                {"offerId": "sweater-b", "title": "stone 立领毛衫", "price": 105, "rank": 5, "shop": "factory-b"},
            ],
            expect_title="свитер stone island",
            expect_model="",
            expect_category="服装",
            image_metrics_by_offer={"sweater-a": {"available": True, "score": 0.60}},
        )
        self.assertTrue(result["passed"])
        self.assertEqual(result["match_type"], "corroborated_multi")
        self.assertEqual(result["rows"][0]["semantic_strength"], "one_high_information_plus_product")
        self.assertIn("two independent suppliers", result["reason"])

    def test_exact_model_inside_title_can_support_a_single_cross_language_offer(self):
        result = image_median_1688.balanced_same_item_assessment(
            [{"offerId": "lamp-e27", "title": "木质布艺台灯 E27", "price": 17, "rank": 3, "shop": "factory-a"}],
            expect_title="настольная лампа E27",
            expect_model="",
            expect_category="家用照明",
            image_metrics_by_offer={"lamp-e27": {"available": True, "score": 0.70}},
        )
        self.assertTrue(result["passed"])
        self.assertEqual(result["match_type"], "strong_single")
        self.assertEqual(result["rows"][0]["semantic_strength"], "exact_model")

    def test_new_cost_evidence_uses_v3_and_binds_supplier_image_specs_and_cluster(self):
        result = image_median_1688.first_page_p70_cost(
            [{
                "offerId": "v3-offer",
                "title": "portable camping lamp X100 20W",
                "price": 18,
                "saleQuantity": 100,
                "shop": "factory-a",
                "pic": "https://img.example/v3.jpg",
            }],
            expect_title="portable camping lamp 20W",
            expect_model="X100",
            expect_price_cny=299.99,
            page_size=10,
            minimum_matches=1,
            image_metrics_by_offer={"v3-offer": {"available": True, "score": 0.92}},
        )
        evidence = json.loads(result["same_item_evidence"])
        self.assertEqual(evidence["contract"], "1688-returned-same-item-v3")
        self.assertEqual(evidence["rows"][0]["supplier_id"], "factorya")
        self.assertEqual(evidence["rows"][0]["image_url"], "https://img.example/v3.jpg")
        self.assertEqual(evidence["request"]["expect_price_cny"], 299.99)
        self.assertTrue(evidence["balanced_match"]["passed"])
        self.assertEqual(result["adaptive_match"]["version"], "adaptive-v5-shadow")
        self.assertEqual(result["adaptive_match"]["policy_version"], "adaptive-v5-policy-1")
        self.assertTrue(result["adaptive_match"]["evidence_complete"])
        self.assertEqual(result["adaptive_match"]["action"], "ALLOW")
        self.assertEqual(result["adaptive_match"]["decision"], "FAST")

    def test_image_first_fallback_requires_two_visual_suppliers_in_one_price_cluster(self):
        candidates = [
            {"offerId": "image-a", "title": "完全不同的中文标题", "price": 12, "shop": "factory-a", "pic": "https://img.example/a.jpg"},
            {"offerId": "image-b", "title": "另一个不同的中文标题", "price": 13, "shop": "factory-b", "pic": "https://img.example/b.jpg"},
            {"offerId": "unrelated", "title": "无关商品", "price": 2, "shop": "factory-c", "pic": "https://img.example/c.jpg"},
        ]
        with tempfile.NamedTemporaryFile(suffix=".jpg") as source_image, mock.patch.object(
            image_median_1688,
            "compare_remote_image",
            side_effect=lambda _source, url, timeout_seconds=0.6: {
                "available": url.endswith(("/a.jpg", "/b.jpg")),
                "score": 0.91 if url.endswith(("/a.jpg", "/b.jpg")) else 0.1,
            },
        ):
            result = image_median_1688.first_page_p70_cost(
                candidates,
                expect_title="俄罗斯商品没有中文标题",
                expect_category="家居用品",
                minimum_matches=1,
                source_image_path=source_image.name,
            )

        self.assertEqual(result["decision"], "LIGHT_ACCEPT")
        self.assertTrue(result["image_first_fallback"])
        self.assertEqual(result["filtered_first_page_prices"], [12.0, 13.0])
        self.assertTrue(result["balanced_match"]["passed"])


class AdaptiveV5ShadowDecisionTest(unittest.TestCase):
    @staticmethod
    def offer(
        offer_id,
        title,
        *,
        supplier="factory-a",
        price=20,
        image_available=True,
        image_score=0.9,
        rank=1,
    ):
        return {
            "offer_id": offer_id,
            "title": title,
            "supplier_id": supplier,
            "price": price,
            "rank": rank,
            "image": {"available": image_available, "score": image_score},
        }

    def decide(
        self,
        candidates,
        title,
        selected="selected",
        model="",
        category="",
        price_cny=100,
    ):
        selected_row = next(
            (row for row in candidates if row["offer_id"] == selected),
            None,
        )
        return image_median_1688.adaptive_same_item_decision(
            candidates,
            expect_title=title,
            expect_model=model,
            expect_category=category,
            expect_price_cny=price_cny,
            selected_offer_id=selected,
            selected_cluster=[
                {
                    "offer_id": row["offer_id"],
                    "supplier_id": row["supplier_id"],
                    "price": row["price"],
                }
                for row in candidates
            ],
            selected_cost=selected_row["price"] if selected_row else None,
        )

    def test_realme_buds_air_7_pro_rejects_generic_buds3pro(self):
        result = self.decide(
            [self.offer(
                "selected",
                "跨境2026新款v16pro适用三星buds3pro蓝牙耳机入耳式anc主动降噪",
            )],
            "realme наушники беспроводные realme buds air 7 pro",
        )
        self.assertEqual(result["decision"], "REJECT")
        self.assertTrue(any(conflict.startswith(("model:", "brand:")) for conflict in result["hard_conflicts"]))

    def test_x200_fe_uses_model_boundaries_and_rejects_x200s_x300pro(self):
        result = self.decide(
            [self.offer(
                "selected",
                "适用vivox300pro钢化膜全屏x300防窥膜vivox200s手机膜秒贴保护膜",
            )],
            "защитное стекло для телефона vivo x200 fe, 2 шт",
        )
        self.assertEqual(result["decision"], "REJECT")
        self.assertTrue(any("x200" in conflict and ("x200s" in conflict or "x300" in conflict)
                            for conflict in result["hard_conflicts"]))

    def test_shampoo_cannot_match_an_empty_dispenser_bottle(self):
        result = self.decide(
            [self.offer(
                "selected",
                "新西盟 现货500ml黑色纯露瓶 塑料按压乳液瓶 洗发水沐浴露分装瓶",
                image_score=0.34,
            )],
            "lydimoon шампунь от выпадения волос 500 мл",
        )
        self.assertEqual(result["decision"], "REJECT")
        self.assertIn("product_accessory:shampoo!=bottle", result["hard_conflicts"])

    def test_exact_single_source_can_take_fast_path(self):
        result = self.decide(
            [self.offer("selected", "portable camping lamp X100 20W", image_score=0.86)],
            "portable camping lamp 20W",
            model="X100",
        )
        self.assertEqual(result["decision"], "FAST")
        self.assertGreaterEqual(result["score"], 80)
        self.assertEqual(result["supporting_offer_ids"], ["selected"])

    def test_missing_selected_image_or_model_is_review_not_reject(self):
        missing_image = self.decide(
            [self.offer("selected", "portable camping lamp X100 20W", image_available=False)],
            "portable camping lamp 20W",
            model="X100",
        )
        missing_model = self.decide(
            [self.offer("selected", "portable camping lamp")],
            "portable camping lamp X100",
        )
        self.assertEqual(missing_image["decision"], "REVIEW")
        self.assertIn("selected_offer_image", missing_image["missing_evidence"])
        self.assertEqual(missing_model["decision"], "REVIEW")
        self.assertIn("exact_model_match", missing_model["missing_evidence"])

    def test_generic_product_can_fast_path_with_two_suppliers(self):
        result = self.decide(
            [
                self.offer("selected", "portable camping lamp", supplier="factory-a", image_score=0.82),
                self.offer("support", "portable camping lamp", supplier="factory-b", image_score=0.2, rank=2),
            ],
            "portable camping lamp",
        )
        self.assertEqual(result["decision"], "FAST")
        self.assertEqual(result["supporting_offer_ids"], ["selected", "support"])

    def test_explicit_pack_quantity_conflict_rejects_but_missing_quantity_reviews(self):
        conflict = self.decide(
            [self.offer("selected", "mi band 5 protective film 2 pcs")],
            "mi band 5 protective film 4 pcs",
        )
        missing = self.decide(
            [self.offer("selected", "mi band 5 protective film")],
            "mi band 5 protective film 4 pcs",
        )
        self.assertEqual(conflict["decision"], "REJECT")
        self.assertTrue(any(value.startswith("spec:count:") for value in conflict["hard_conflicts"]))
        self.assertEqual(missing["decision"], "REVIEW")
        self.assertIn("spec:count", missing["missing_evidence"])

    def test_correct_plus_other_variant_requires_sku_binding_instead_of_rejecting(self):
        model_variants = self.decide(
            [self.offer("selected", "vivo x200 fe x200s protective film")],
            "vivo x200 fe protective film",
        )
        count_variants = self.decide(
            [self.offer("selected", "mi band 5 protective film 2/4 pcs")],
            "mi band 5 protective film 4 pcs",
        )
        self.assertEqual(model_variants["decision"], "REVIEW")
        self.assertEqual(model_variants["hard_conflicts"], [])
        self.assertIn("selected_offer_model_variant_binding", model_variants["missing_evidence"])
        self.assertEqual(count_variants["decision"], "REVIEW")
        self.assertIn("spec_variant_binding:count", count_variants["missing_evidence"])

    def test_multi_model_aliases_and_search_card_shorthand_review_instead_of_reject(self):
        s23 = self.decide(
            [self.offer("selected", "stylus for S22 Ultra / S23 U / S24U / S25U")],
            "stylus for Samsung Galaxy S23 Ultra",
        )
        watch = self.decide(
            [self.offer("selected", "adapter for Redmi watch6/5/4 and band10/9/8pro")],
            "adapter for Redmi Watch 5/4 and Band 9/8 Pro",
        )
        self.assertEqual(s23["decision"], "REVIEW")
        self.assertEqual(s23["hard_conflicts"], [])
        self.assertIn("selected_offer_model_variant_binding", s23["missing_evidence"])
        self.assertEqual(watch["decision"], "REVIEW")
        self.assertEqual(watch["hard_conflicts"], [])

        vivo = self.decide(
            [self.offer("selected", "适用vivov70手机壳v60磁吸旋转支架")],
            "чехол для vivo v70",
        )
        self.assertEqual(vivo["decision"], "REVIEW")
        self.assertIn("selected_offer_model_variant_binding", vivo["missing_evidence"])

    def test_measurement_axes_and_multi_specs_never_create_false_hard_conflicts(self):
        straw = self.decide(
            [self.offer("selected", "吸管5mm食品级100支5x210")],
            "трубочки 100 шт 21х0,5 см",
        )
        strap = self.decide(
            [self.offer("selected", "galaxy watch 42mm/46mm metal strap 20 22mm")],
            "metal watch strap 22 mm",
        )
        lamp = self.decide(
            [self.offer("selected", "h7灯泡12v55w卤素灯100w 24v70w")],
            "H7 halogen lamp 55W 2 pcs",
        )
        for result in (straw, strap, lamp):
            self.assertNotEqual(result["decision"], "REJECT")
            self.assertEqual(result["hard_conflicts"], [])

    def test_compact_voltage_current_pairs_reject_only_a_bound_pair_mismatch(self):
        conflict = self.decide(
            [self.offer("selected", "12.6v6a 14.6v5a 16.8v4a 21v3a lithium charger")],
            "21V 4A lithium charger",
        )
        ambiguous_match = self.decide(
            [self.offer("selected", "18v21v battery for power tools")],
            "21V power-tool battery",
        )
        self.assertEqual(conflict["decision"], "REJECT")
        self.assertTrue(any("voltage_current" in value for value in conflict["hard_conflicts"]))
        self.assertEqual(ambiguous_match["decision"], "REVIEW")
        self.assertEqual(ambiguous_match["hard_conflicts"], [])

    def test_18650_nominal_and_full_charge_voltage_requires_review(self):
        result = self.decide(
            [self.offer("selected", "18650 lithium battery 3.7V")],
            "18650 rechargeable battery 4.2V",
        )
        self.assertEqual(result["decision"], "REVIEW")
        self.assertEqual(result["hard_conflicts"], [])
        self.assertIn("battery_voltage_convention_binding", result["missing_evidence"])

    def test_clear_consumable_bottle_and_film_material_conflicts_still_reject(self):
        bottle = self.decide(
            [self.offer("selected", "pet塑料瓶子300ml 500ml化妆品空包材")],
            "мужская глиняная маска для лица 100 мл",
        )
        material = self.decide(
            [self.offer("selected", "vivo x200 pro mini 钢化膜")],
            "гидрогелевая пленка vivo x200 pro mini",
        )
        self.assertEqual(bottle["decision"], "REJECT")
        self.assertIn("product_accessory:filled_consumable!=bottle", bottle["hard_conflicts"])
        self.assertEqual(material["decision"], "REJECT")
        self.assertIn("material:hydrogel!=tempered_glass", material["hard_conflicts"])

    def test_russian_genitive_earbud_case_is_an_accessory_not_earbuds(self):
        result = self.decide(
            [self.offer("selected", "三星galaxy buds4/buds4 pro真皮耳机保护套")],
            "чехла наушников Samsung Galaxy Buds 4 / Buds 4 Pro",
        )
        self.assertNotEqual(result["decision"], "REJECT")
        self.assertEqual(result["hard_conflicts"], [])

    def test_product_terms_use_boundaries_so_wire_does_not_match_wireless(self):
        result = self.decide(
            [self.offer("selected", "wireless charger X100")],
            "USB data wire X100",
        )
        self.assertEqual(result["decision"], "REVIEW")
        self.assertEqual(result["hard_conflicts"], [])
        self.assertIn("product_type_match", result["missing_evidence"])

    def test_russian_earbud_case_inflections_are_accessories(self):
        for case_form in ("чехол", "чехла", "чехлы"):
            with self.subTest(case_form=case_form):
                result = self.decide(
                    [self.offer("selected", "三星 Galaxy Buds 4 耳机保护套")],
                    f"{case_form} для наушников Samsung Galaxy Buds 4",
                )
                self.assertNotEqual(result["decision"], "REJECT")
                self.assertEqual(result["hard_conflicts"], [])

    def test_chinese_brand_aliases_normalize_to_latin_brands(self):
        aliases = {
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
        }
        for alias, canonical in aliases.items():
            with self.subTest(alias=alias):
                self.assertIn(canonical, image_median_1688._adaptive_brands(f"适用{alias}手机壳"))

        same_brand = self.decide(
            [self.offer("selected", "华为 Mate 70 手机壳")],
            "Huawei Mate 70 phone case",
        )
        self.assertNotEqual(same_brand["decision"], "REJECT")
        self.assertFalse(any(value.startswith("brand:") for value in same_brand["hard_conflicts"]))

    def test_oneplus_nord_buds3_cannot_fast_match_samsung_galaxy_buds3(self):
        result = self.decide(
            [self.offer("selected", "三星 Galaxy Buds3 无线蓝牙耳机")],
            "OnePlus Nord Buds3 E514A wireless earbuds",
        )
        self.assertEqual(result["decision"], "REJECT")
        self.assertTrue(any(value.startswith("brand:oneplus!=samsung")
                            for value in result["hard_conflicts"]))

    def test_note_pro_plus_and_network_generation_differences_review(self):
        pro_plus_vs_pro = self.decide(
            [self.offer("selected", "红米 Note 15 Pro 5G 智能手机")],
            "Redmi Note 15 Pro+ 5G smartphone",
        )
        network_generation = self.decide(
            [self.offer("selected", "红米 Note 15 Pro 4G 智能手机")],
            "Redmi Note 15 Pro 5G smartphone",
        )
        spelling_alias = self.decide(
            [self.offer("selected", "红米 Note 15 Pro+ 5G 智能手机")],
            "Redmi Note 15 Pro Plus 5G smartphone",
        )

        self.assertEqual(pro_plus_vs_pro["decision"], "REVIEW")
        self.assertEqual(pro_plus_vs_pro["hard_conflicts"], [])
        self.assertIn("exact_model_match", pro_plus_vs_pro["missing_evidence"])
        self.assertEqual(network_generation["decision"], "REVIEW")
        self.assertEqual(network_generation["hard_conflicts"], [])
        self.assertIn(
            "selected_offer_network_generation_binding",
            network_generation["missing_evidence"],
        )
        self.assertNotEqual(spelling_alias["decision"], "REJECT")
        self.assertEqual(spelling_alias["hard_conflicts"], [])

    def test_elm327_version_chipset_and_form_factor_need_binding(self):
        explicit_variant = self.decide(
            [self.offer("selected", "ELM327 v2.1 mini OBD2 adapter")],
            "ELM327 v1.5 PIC18F25K80 OBD2 adapter",
        )
        incomplete = self.decide(
            [self.offer("selected", "ELM327 OBD2 adapter")],
            "ELM327 v1.5 PIC18F25K80 OBD2 adapter",
        )

        for result in (explicit_variant, incomplete):
            self.assertEqual(result["decision"], "REVIEW")
            self.assertEqual(result["hard_conflicts"], [])
            self.assertIn("elm327_version_binding", result["missing_evidence"])
            self.assertIn("elm327_chipset_binding", result["missing_evidence"])

    def test_exact_offer_requires_cluster_and_cost_binding_before_fast(self):
        candidate = self.offer("selected", "portable camping lamp X100 20W", price=20)
        cluster = [{"offer_id": "selected", "supplier_id": "factory-a", "price": 20}]
        missing_cluster = image_median_1688.adaptive_same_item_decision(
            [candidate],
            expect_title="portable camping lamp 20W",
            expect_model="X100",
            selected_offer_id="selected",
            selected_cluster=[],
            selected_cost=20,
        )
        missing_cost = image_median_1688.adaptive_same_item_decision(
            [candidate],
            expect_title="portable camping lamp 20W",
            expect_model="X100",
            selected_offer_id="selected",
            selected_cluster=cluster,
            selected_cost=None,
        )
        bound = image_median_1688.adaptive_same_item_decision(
            [candidate],
            expect_title="portable camping lamp 20W",
            expect_model="X100",
            selected_offer_id="selected",
            selected_cluster=cluster,
            selected_cost=20,
        )

        self.assertEqual(missing_cluster["decision"], "REVIEW")
        self.assertIn("selected_offer_cluster_binding", missing_cluster["missing_evidence"])
        self.assertEqual(missing_cost["decision"], "REVIEW")
        self.assertIn("selected_offer_cost_binding", missing_cost["missing_evidence"])
        self.assertEqual(bound["decision"], "FAST")

    def test_wrong_brand_material_and_network_offers_cannot_corroborate(self):
        brand = self.decide(
            [
                self.offer("selected", "三星 wireless earbuds", supplier="factory-a"),
                self.offer("wrong-brand", "一加 wireless earbuds", supplier="factory-b", rank=2),
            ],
            "Samsung wireless earbuds",
        )
        material = self.decide(
            [
                self.offer("selected", "hydrogel protective film", supplier="factory-a"),
                self.offer("wrong-material", "tempered glass protective film", supplier="factory-b", rank=2),
            ],
            "hydrogel protective film",
        )
        network = self.decide(
            [
                self.offer("selected", "红米 5G smartphone", supplier="factory-a"),
                self.offer("wrong-network", "Redmi 4G smartphone", supplier="factory-b", rank=2),
            ],
            "Redmi 5G smartphone",
        )

        for result, excluded_offer in (
            (brand, "wrong-brand"),
            (material, "wrong-material"),
            (network, "wrong-network"),
        ):
            self.assertEqual(result["decision"], "REVIEW")
            self.assertNotIn(excluded_offer, result["supporting_offer_ids"])
            self.assertIn("independent_supplier_corroboration", result["missing_evidence"])

    def test_historical_charm_offers_do_not_fast_match_finished_bracelets(self):
        cases = (
            (
                "1034696150384",
                "韩国复古珍珠手链女ins风高级感小众钛钢手镯情侣手串手饰品批发",
                "1046628526025",
                "欧美复古双层爱心珍珠手链男女高级感痞帅设计轻奢小众手饰品批发",
            ),
            (
                "743316664937",
                "日韩潮流手链男轻奢高级感百搭气质饰品女高级感珍珠手链配饰批发",
                "1045810055330",
                "韩版设计半月湾方块简约手链女百搭个性小清新几何魔方吊坠手饰品",
            ),
        )
        for selected_id, selected_title, support_id, support_title in cases:
            with self.subTest(selected_id=selected_id):
                result = self.decide(
                    [
                        self.offer(selected_id, selected_title, supplier="factory-a", image_score=0.99),
                        self.offer(support_id, support_title, supplier="factory-b", image_score=0.99, rank=2),
                    ],
                    "шарм бижутерный сплав",
                    selected=selected_id,
                )
                self.assertEqual(result["decision"], "REVIEW")
                self.assertEqual(result["hard_conflicts"], [])
                self.assertIn("product_role:jewelry_charm", result["missing_evidence"])
                self.assertNotIn(support_id, result["supporting_offer_ids"])

    def test_historical_remote_control_blocks_require_selected_role_binding(self):
        result = self.decide(
            [
                self.offer(
                    "1010693336740",
                    "兼容乐高黑色f1方程式赛车科技机械组男孩子拼装跑车玩具积木礼物",
                    supplier="factory-a",
                    image_score=0.956,
                ),
                self.offer(
                    "1008412794161",
                    "兼容小颗粒赛博兰博保时捷跑车遥控中国积木儿童玩具拼装赛车男孩",
                    supplier="factory-b",
                    image_score=0.978,
                    rank=2,
                ),
                self.offer(
                    "1043199513523",
                    "兼容兰博基尼v12黑武士益智拼装积木玩具机械跑车男孩礼物",
                    supplier="factory-c",
                    image_score=0.933,
                    rank=3,
                ),
            ],
            "строительные блоки детские игрушки дистанционного управления модель автомобиля",
            selected="1010693336740",
        )
        self.assertEqual(result["decision"], "REVIEW")
        self.assertEqual(result["hard_conflicts"], [])
        self.assertIn("product_role:remote_control", result["missing_evidence"])
        self.assertNotIn("1010693336740", result["supporting_offer_ids"])

    def test_historical_watch_cases_bind_bumper_material_and_case_style(self):
        cases = (
            (
                "1058074580590",
                "适用三星watch7ultra保护壳 47mm保护壳ultra2表壳壳膜一体保护套",
                "чехол для samsung galaxy watch ultra 47mm бампер силиконовый",
            ),
            (
                "1007380944783",
                "清风适用红米watch5保护壳镂空半包pc红米4表壳redmiwatch5保护壳",
                "чехол для redmi watch 5 бампер силиконовый",
            ),
        )
        for offer_id, offer_title, target in cases:
            with self.subTest(offer_id=offer_id):
                result = self.decide(
                    [self.offer(offer_id, offer_title, image_score=0.86)],
                    target,
                    selected=offer_id,
                )
                self.assertEqual(result["decision"], "REVIEW")
                self.assertEqual(result["hard_conflicts"], [])
                self.assertIn("selected_offer_material_binding", result["missing_evidence"])
                self.assertIn("style:bumper", result["missing_evidence"])

    def test_historical_watch_band_binds_stainless_soft_mesh_style(self):
        result = self.decide(
            [
                self.offer(
                    "1035163374951",
                    "适用于华为手环11/pro内置磁吸huawei band11pro内置磁吸编织表带",
                    supplier="factory-a",
                    image_score=0.729,
                ),
                self.offer(
                    "1050699066546",
                    "适用华为手环11磁吸扣洞洞硅胶表带band 11pro nfc透气孔镂空腕带",
                    supplier="factory-b",
                    image_score=0.702,
                    rank=2,
                ),
            ],
            "новый ремешок для часов из мягкой сетки из нержавеющей стали, совместимый с huawei band 11/huawei band11 pro",
            selected="1035163374951",
        )
        self.assertEqual(result["decision"], "REVIEW")
        self.assertEqual(result["hard_conflicts"], [])
        self.assertIn("selected_offer_material_binding", result["missing_evidence"])
        self.assertIn("style:soft_mesh", result["missing_evidence"])
        self.assertNotIn("1050699066546", result["supporting_offer_ids"])

    def test_historical_tablet_case_requires_selected_folio_features(self):
        result = self.decide(
            [
                self.offer(
                    "978789332571",
                    "适用荣耀平板x7防摔背贴卡斯特保护壳honor padx7 2025平板保护套",
                    supplier="factory-a",
                    image_score=0.9,
                ),
                self.offer(
                    "976561959437",
                    "适用honor pad x7 2025平板电脑保护套荣耀平板x7三折支架保护壳",
                    supplier="factory-b",
                    image_score=0.8,
                    rank=2,
                ),
            ],
            'чехол для планшета honor pad x7 8.7"(2025), чехол-книжка с магнитом, подставка, авто сон/пробуждение',
            selected="978789332571",
        )
        self.assertEqual(result["decision"], "REVIEW")
        self.assertEqual(result["hard_conflicts"], [])
        for style in ("folio", "magnetic", "stand", "auto_wake"):
            self.assertIn(f"style:{style}", result["missing_evidence"])
        self.assertNotIn("976561959437", result["supporting_offer_ids"])

    def test_leather_watch_band_material_blocks_silicone_but_keeps_true_fast(self):
        target = "кожаный ремешок для samsung galaxy fit 3"
        silicone = self.decide(
            [self.offer("selected", "三星 galaxy fit3 硅胶表带智能手环腕带")],
            target,
        )
        leather = self.decide(
            [
                self.offer(
                    "selected",
                    "适用galaxy fit3 真皮表带三星fit3真皮表带智能手环腕带皮质表带",
                    image_score=0.742,
                )
            ],
            target,
        )

        self.assertEqual(silicone["decision"], "REVIEW")
        self.assertEqual(silicone["hard_conflicts"], [])
        self.assertIn("selected_offer_material_binding", silicone["missing_evidence"])
        self.assertEqual(leather["decision"], "FAST")
        self.assertEqual(leather["missing_evidence"], [])

    def test_generic_metal_and_alloy_aircraft_materials_are_one_family(self):
        result = self.decide(
            [
                self.offer(
                    "859936974349",
                    "16cm合金飞机模型 加勒比海航空 空客340 静态摆件",
                    supplier="factory-a",
                    image_score=0.836,
                ),
                self.offer(
                    "860527716628",
                    "16cm加勒比海航空a340 合金实心飞机模型厂家直销工艺品玩具",
                    supplier="factory-b",
                    image_score=0.8,
                    rank=2,
                ),
            ],
            "металлическая модель самолета аэробус 340, карибские авиалинии а340",
            selected="859936974349",
        )
        self.assertEqual(result["decision"], "FAST")
        self.assertEqual(result["missing_evidence"], [])

    def test_universal_cables_and_straps_use_brand_review_not_hard_reject(self):
        cases = (
            (
                "591932326224",
                "超级快充针通编织数据线 适用苹果安卓typec手机充电线2.4a加长线",
                "кабель usb type c, 2 метра, провод type c, шнур для зарядки телефона type c, провод тайп си для самсунг, iphone, huawei,",
            ),
            (
                "817478265257",
                "6a超级快充数据线type-c闪充适用于华为荣耀苹果手机66充电线批发",
                "xiaomi кабель для мобильных устройств usb type-c/usb type-c, 1 м, белый, оранжевый",
            ),
            (
                "945080101172",
                "三星galaxy watch9海洋硅胶表带适用三星watch8/8classic运动表带",
                "ремешок для часов 20мм для смарт-часов amazfit bip / gts , huawei honor watch , garmin , xiaomi haylou / mibro , realme",
            ),
        )
        for offer_id, offer_title, target in cases:
            with self.subTest(offer_id=offer_id):
                result = self.decide(
                    [self.offer(offer_id, offer_title, image_score=0.7)],
                    target,
                    selected=offer_id,
                )
                self.assertEqual(result["decision"], "REVIEW")
                self.assertEqual(result["hard_conflicts"], [])
                if offer_id != "591932326224":
                    self.assertIn("selected_offer_brand_binding", result["missing_evidence"])

        specific = self.decide(
            [self.offer("selected", "苹果 iPhone 15 phone case")],
            "Samsung Galaxy S24 phone case",
        )
        self.assertEqual(specific["decision"], "REJECT")
        self.assertTrue(any(value.startswith("brand:") for value in specific["hard_conflicts"]))

    def test_v5_price_boundary_activates_exact_model_policy_at_300(self):
        candidate = self.offer("selected", "三星 smartphone")
        under = self.decide(
            [candidate],
            "Samsung Galaxy S24 smartphone",
            price_cny=299.99,
        )
        threshold = self.decide(
            [candidate],
            "Samsung Galaxy S24 smartphone",
            price_cny=300,
        )

        self.assertEqual(under["action"], "ALLOW")
        self.assertFalse(under["valuable_digital"]["applies"])
        self.assertEqual(under["valuable_digital"]["price_cny"], 299.99)
        self.assertEqual(threshold["action"], "REJECT")
        self.assertTrue(threshold["valuable_digital"]["applies"])
        self.assertIn(
            "valuable_digital_selected_model_mismatch",
            threshold["policy_reasons"],
        )

    def test_v5_global_brand_policy_handles_missing_wrong_same_and_multi_brand(self):
        missing = self.decide(
            [self.offer("selected", "S24 smartphone")],
            "Samsung Galaxy S24 smartphone",
            price_cny=100,
        )
        wrong = self.decide(
            [self.offer("selected", "苹果 iPhone 15 smartphone")],
            "Samsung Galaxy S24 smartphone",
            price_cny=100,
        )
        same_alias = self.decide(
            [self.offer("selected", "三星 Galaxy S24 智能手机")],
            "самсунг Galaxy S24 smartphone",
            price_cny=300,
        )
        multi_brand = self.decide(
            [self.offer("selected", "苹果 USB Type-C 充电线")],
            "Samsung iPhone Huawei USB Type-C cable",
            price_cny=100,
        )
        unbound_selected_brand = self.decide(
            [self.offer("selected", "三星 华为 USB Type-C 充电线")],
            "Samsung USB Type-C cable",
            price_cny=100,
        )
        xiaomi_family = self.decide(
            [self.offer("selected", "小米 POCO X7 智能手机")],
            "Redmi X7 smartphone",
            price_cny=300,
        )

        self.assertEqual(missing["action"], "REJECT")
        self.assertIn("selected_brand_missing", missing["policy_reasons"])
        self.assertEqual(wrong["action"], "REJECT")
        self.assertIn("selected_brand_family_mismatch", wrong["policy_reasons"])
        self.assertEqual(same_alias["action"], "ALLOW")
        self.assertTrue(same_alias["brand_evidence"]["matched"])
        self.assertEqual(multi_brand["action"], "ALLOW")
        self.assertEqual(multi_brand["brand_evidence"]["selected_families"], ["apple"])
        self.assertEqual(unbound_selected_brand["action"], "REJECT")
        self.assertIn(
            "selected_brand_family_unbound",
            unbound_selected_brand["policy_reasons"],
        )
        self.assertEqual(xiaomi_family["action"], "ALLOW")
        self.assertEqual(xiaomi_family["brand_evidence"]["expected_families"], ["xiaomi"])

    def test_v5_all_core_digital_categories_allow_only_bound_products(self):
        cases = (
            ("phone", "Samsung Galaxy S24 smartphone", "三星 Galaxy S24 智能手机"),
            ("tablet", "Apple iPad 10 tablet", "苹果 iPad10 平板电脑"),
            ("computer", "Lenovo ThinkPad X1 laptop", "联想 ThinkPad X1 笔记本电脑"),
            ("camera", "Canon EOS R50 digital camera", "佳能 EOS R50 数码相机"),
            ("drone", "DJI Mavic 3 Pro drone", "大疆 Mavic3 Pro 无人机"),
            ("vr", "Meta Quest 3 VR headset", "Meta Quest3 VR头显"),
            ("game_console", "Sony PlayStation 5 game console", "索尼 PlayStation5 游戏主机"),
            ("smartwatch", "Garmin Fenix 8 smartwatch", "佳明 Fenix8 智能手表"),
            ("branded_earbuds", "Samsung Galaxy Buds3 earbuds", "三星 Galaxy Buds3 耳机"),
        )
        for category, target, selected_title in cases:
            with self.subTest(category=category):
                result = self.decide(
                    [self.offer("selected", selected_title)],
                    target,
                    price_cny=300,
                )
                self.assertEqual(result["action"], "ALLOW", result)
                self.assertEqual(result["valuable_digital"]["category"], category)
                self.assertTrue(result["valuable_digital"]["applies"])

    def test_v5_brand_product_words_prove_roles_without_generic_category_words(self):
        role_cases = (
            ("phone", "Apple iPhone 15", "苹果 iPhone15"),
            ("tablet", "Apple iPad 10", "苹果 iPad10"),
            ("computer", "Apple MacBook M2", "苹果 MacBook M2"),
            ("computer", "Lenovo ThinkPad X1", "联想 ThinkPad X1"),
            ("branded_earbuds", "Apple AirPods Pro 2", "苹果 AirPods Pro2"),
        )
        for category, target, selected_title in role_cases:
            with self.subTest(target=target):
                result = self.decide(
                    [self.offer("selected", selected_title)],
                    target,
                    price_cny=300,
                )
                self.assertEqual(result["action"], "ALLOW", result)
                self.assertEqual(result["valuable_digital"]["category"], category)

    def test_v5_valuable_digital_rejects_missing_brand_model_and_product_role(self):
        missing_brand = self.decide(
            [self.offer("selected", "X100 smartphone")],
            "X100 smartphone",
            price_cny=300,
        )
        missing_target_model = self.decide(
            [self.offer("selected", "三星 smartphone")],
            "Samsung smartphone",
            price_cny=300,
        )
        missing_selected_model = self.decide(
            [self.offer("selected", "三星 smartphone")],
            "Samsung Galaxy S24 smartphone",
            price_cny=300,
        )
        accessory_selected = self.decide(
            [self.offer("selected", "三星 Galaxy S24 phone case")],
            "Samsung Galaxy S24 smartphone",
            price_cny=300,
        )

        self.assertIn("valuable_digital_target_brand_missing", missing_brand["policy_reasons"])
        self.assertIn("valuable_digital_target_model_missing", missing_target_model["policy_reasons"])
        self.assertIn(
            "valuable_digital_selected_model_mismatch",
            missing_selected_model["policy_reasons"],
        )
        self.assertIn(
            "valuable_digital_product_role_mismatch",
            accessory_selected["policy_reasons"],
        )
        for result in (
            missing_brand,
            missing_target_model,
            missing_selected_model,
            accessory_selected,
        ):
            self.assertEqual(result["action"], "REJECT")

    def test_v5_accessories_are_excluded_and_missing_image_does_not_reject(self):
        accessory = self.decide(
            [self.offer("selected", "三星 Galaxy S24 phone case")],
            "Samsung Galaxy S24 phone case",
            price_cny=500,
        )
        no_image = self.decide(
            [self.offer(
                "selected",
                "三星 Galaxy S24 smartphone",
                image_available=False,
            )],
            "Samsung Galaxy S24 smartphone",
            price_cny=300,
        )

        self.assertEqual(accessory["action"], "ALLOW")
        self.assertFalse(accessory["valuable_digital"]["applies"])
        self.assertIsNone(accessory["valuable_digital"]["category"])
        self.assertEqual(no_image["decision"], "REVIEW")
        self.assertIn("selected_offer_image", no_image["missing_evidence"])
        self.assertEqual(no_image["action"], "ALLOW")

    def test_v5_incomplete_evidence_or_missing_target_price_has_null_action(self):
        candidate = self.offer("selected", "三星 Galaxy S24 smartphone", price=20)
        cluster = [{"offer_id": "selected", "supplier_id": "factory-a", "price": 20}]
        missing_cluster = image_median_1688.adaptive_same_item_decision(
            [candidate],
            expect_title="Samsung Galaxy S24 smartphone",
            expect_price_cny=300,
            selected_offer_id="selected",
            selected_cluster=[],
            selected_cost=20,
        )
        missing_cost = image_median_1688.adaptive_same_item_decision(
            [candidate],
            expect_title="Samsung Galaxy S24 smartphone",
            expect_price_cny=300,
            selected_offer_id="selected",
            selected_cluster=cluster,
            selected_cost=None,
        )
        missing_target_price = image_median_1688.adaptive_same_item_decision(
            [candidate],
            expect_title="Samsung Galaxy S24 smartphone",
            selected_offer_id="selected",
            selected_cluster=cluster,
            selected_cost=20,
        )
        for result in (missing_cluster, missing_cost, missing_target_price):
            self.assertFalse(result["evidence_complete"])
            self.assertIsNone(result["action"])
            self.assertIn("evidence_incomplete", result["policy_reasons"])

    def test_v5_brand_matching_is_explicit_dictionary_not_substring_heuristic(self):
        result = self.decide(
            [self.offer("selected", "Pixelated X100 smartphone")],
            "Pixelated X100 smartphone",
            price_cny=300,
        )
        self.assertEqual(result["brand_evidence"]["expected_families"], [])
        self.assertEqual(result["action"], "REJECT")
        self.assertIn("valuable_digital_target_brand_missing", result["policy_reasons"])

    def test_v5_brand_matching_recognizes_explicit_compact_supplier_titles(self):
        cases = (
            ("Meta Oculus Quest 2 link cable", "oculusquest2linkcable电脑vr游戏机vr眼镜数据线", "meta"),
            ("Samsung Galaxy S24 USB cable", "SamsungGalaxyS24数据线", "samsung"),
            ("Huawei Mate 70 USB cable", "HuaweiMate70数据线", "huawei"),
            ("Honor Magic 7 USB cable", "HonorMagic7数据线", "honor"),
            ("OnePlus 12 USB cable", "OnePlus12数据线", "oneplus"),
            ("Oppo Find X8 USB cable", "OppoFindX8数据线", "oppo"),
            ("Realme GT 7 USB cable", "RealmeGT7数据线", "realme"),
            ("Xiaomi 14 USB cable", "Xiaomi14数据线", "xiaomi"),
            ("Google Pixel 9 USB cable", "GooglePixel9数据线", "google"),
            ("Sony Alpha 7 USB cable", "SonyAlpha7数据线", "sony"),
            ("Canon EOS R50 USB cable", "CanonEOSR50数据线", "canon"),
            ("DJI Mavic 3 USB cable", "DJIMavic3数据线", "dji"),
            ("Garmin Fenix 8 USB cable", "GarminFenix8数据线", "garmin"),
            ("Lenovo Legion 5 USB cable", "LenovoLegion5数据线", "lenovo"),
            ("Lenovo ThinkPad X1 USB cable", "ThinkPadX1数据线", "lenovo"),
            ("Asus ROG 8 USB cable", "AsusROG8数据线", "asus"),
            ("Microsoft Surface Pro 11 USB cable", "MicrosoftSurfacePro11数据线", "microsoft"),
            ("Nintendo Switch 2 USB cable", "NintendoSwitch2数据线", "nintendo"),
            ("Valve Steam Deck USB cable", "ValveSteamDeck数据线", "valve"),
            ("GoPro Hero 12 USB cable", "GoProHero12数据线", "gopro"),
            ("Redmi Watch 5 strap", "RedmiWatch5表带", "xiaomi"),
            ("Poco X6 phone case", "PocoX6手机壳", "xiaomi"),
            ("Vivo V70 phone case", "VivoV70手机壳", "vivo"),
        )
        for target, selected_title, expected_family in cases:
            with self.subTest(selected_title=selected_title):
                result = self.decide(
                    [self.offer("selected", selected_title)],
                    target,
                    price_cny=100,
                )
                self.assertEqual(result["action"], "ALLOW", result)
                self.assertEqual(
                    result["brand_evidence"]["selected_families"],
                    [expected_family],
                )
                self.assertTrue(result["brand_evidence"]["matched"])

    def test_v5_compact_brand_matching_does_not_mine_ordinary_words(self):
        for title in ("honorary member cable", "metadata cable", "Pixelated cable"):
            with self.subTest(title=title):
                self.assertEqual(image_median_1688._adaptive_brands(title), set())

    def test_v5_explicit_device_case_contexts_are_accessories_above_300(self):
        cases = (
            ("Apple iPhone case", "phone_case"),
            ("Samsung Galaxy S24 case", "phone_case"),
            ("Google Pixel 9 cover", "phone_case"),
            ("Apple iPad case", "tablet_accessory"),
            ("Apple MacBook cover", "computer_accessory"),
            ("Lenovo ThinkPad sleeve", "computer_accessory"),
            ("Microsoft Surface stand", "computer_accessory"),
            ("Meta Quest case", "vr_accessory"),
            ("Oculus Quest cover", "vr_accessory"),
            ("Sony PlayStation case", "game_accessory"),
            ("Microsoft Xbox bag", "game_accessory"),
            ("Nintendo Switch protector", "game_accessory"),
            ("Valve Steam Deck case", "game_accessory"),
        )
        core_roles = set(image_median_1688.VALUABLE_DIGITAL_CORE_ROLES)
        for title, accessory_role in cases:
            with self.subTest(title=title):
                result = self.decide(
                    [self.offer("selected", title)],
                    title,
                    price_cny=500,
                )
                self.assertEqual(result["action"], "ALLOW", result)
                self.assertFalse(result["valuable_digital"]["applies"])
                self.assertIsNone(result["valuable_digital"]["category"])
                self.assertIn(accessory_role, result["expected_product_roles"])
                self.assertTrue(
                    core_roles.isdisjoint(result["expected_product_roles"]),
                    result,
                )

        film = self.decide(
            [self.offer("selected", "Samsung Galaxy S24 screen protector protective film")],
            "Samsung Galaxy S24 screen protector protective film",
            price_cny=500,
        )
        self.assertEqual(film["action"], "ALLOW", film)
        self.assertIn("protective_film", film["expected_product_roles"])
        self.assertNotIn("phone", film["expected_product_roles"])
        self.assertFalse(film["valuable_digital"]["applies"])

    def test_v5_bilingual_whole_devices_remain_core_without_accessory_nouns(self):
        cases = (
            ("tablet", "Apple iPad 10 tablet", "苹果 iPad10 平板电脑"),
            ("computer", "Lenovo ThinkPad X1 laptop", "联想 ThinkPad X1 笔记本电脑"),
            ("computer", "Microsoft Surface X100 computer", "微软 Surface X100 电脑整机"),
            ("vr", "Meta Quest 3 VR headset", "Meta Quest3 VR头显"),
            ("game_console", "Sony PlayStation 5 game console", "索尼 PlayStation5 游戏主机"),
            ("phone", "Samsung Galaxy S24 smartphone", "三星 Galaxy S24 智能手机"),
        )
        for category, target, selected_title in cases:
            with self.subTest(category=category):
                result = self.decide(
                    [self.offer("selected", selected_title)],
                    target,
                    price_cny=300,
                )
                self.assertEqual(result["action"], "ALLOW", result)
                self.assertTrue(result["valuable_digital"]["applies"])
                self.assertEqual(result["valuable_digital"]["category"], category)

    def test_russian_protective_koukh_is_not_leather(self):
        self.assertNotIn(
            "leather",
            image_median_1688._adaptive_materials("защитный кожух для камеры"),
        )

    def test_selected_search_card_cost_must_bind_to_the_selected_offer(self):
        candidate = self.offer("selected", "portable camping lamp X100 20W", price=20)
        result = image_median_1688.adaptive_same_item_decision(
            [candidate],
            expect_title="portable camping lamp 20W",
            expect_model="X100",
            selected_offer_id="selected",
            selected_cluster=[{"offer_id": "selected", "supplier_id": "factory-a", "price": 20}],
            selected_cost=10,
        )
        self.assertEqual(result["decision"], "REVIEW")
        self.assertIn("selected_offer_cost_binding", result["missing_evidence"])

    def test_unbound_selected_offer_is_review_not_reject(self):
        result = self.decide(
            [self.offer("other", "portable camping lamp X100")],
            "portable camping lamp X100",
            selected="selected",
        )
        self.assertEqual(result["decision"], "REVIEW")
        self.assertIn("selected_offer_evidence", result["missing_evidence"])


if __name__ == "__main__":
    unittest.main()
