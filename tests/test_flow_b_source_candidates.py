import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "flow_b_codex_transfer_20260608" / "scripts" / "flow_b_enrich_source_candidates.py"
PROCESS = ROOT / "flow_b_codex_transfer_20260608" / "scripts" / "flow_b_process_batch.py"

_SPEC = importlib.util.spec_from_file_location("flow_b_enrich_source_candidates", SCRIPT)
enrich = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(enrich)

_PROCESS_SPEC = importlib.util.spec_from_file_location("flow_b_process_batch", PROCESS)
process = importlib.util.module_from_spec(_PROCESS_SPEC)
_PROCESS_SPEC.loader.exec_module(process)


class SourceCandidateTests(unittest.TestCase):
    def test_parse_product_snapshot_extracts_maozi_panel_fields(self):
        snapshot = {
            "url": "https://www.ozon.ru/product/karkas-kosour-2785418656/",
            "title": "Каркас косоур лестницы на 3 ступени для крыльца любой ширины купить на OZON",
            "text": "\n".join(
                [
                    "Артикул: 2785418656",
                    "Каркас косоур лестницы на 3 ступени для крыльца любой ширины",
                    "Распродажа",
                    "415,79 ¥",
                    "848,54 ¥",
                    "选品标签：",
                    "叶销量品",
                    "SKU：2785418656",
                    "重 量：13200g",
                    "发货模式：FBO,FBS",
                    "跟卖最低价：¥700.52",
                ]
            ),
            "cover_image": "https://ir.ozone.ru/s3/example.jpg",
        }

        candidate = enrich.candidate_from_snapshot(snapshot)

        self.assertEqual(candidate["sku"], 2785418656)
        self.assertEqual(candidate["sell_price"], 415.79)
        self.assertEqual(candidate["weight"], 13200)
        self.assertEqual(candidate["mode"], "FBO,FBS")
        self.assertEqual(candidate["cover_image"], "https://ir.ozone.ru/s3/example.jpg")

    def test_load_source_candidates_dedupes_and_filters_existing(self):
        with tempfile.TemporaryDirectory() as tmp:
            batch = Path(tmp)
            (batch / "source_candidates.json").write_text(
                json.dumps(
                    [
                        {"sku": 1001, "title": "Настенный светильник", "sell_price": 100, "cover_image": "a.jpg"},
                        {"sku": 1001, "title": "duplicate", "sell_price": 100, "cover_image": "a.jpg"},
                        {"sku": 1002, "title": "Бейсболка PUMA", "sell_price": 100, "cover_image": "b.jpg"},
                        {"sku": 1003, "title": "Органайзер", "sell_price": 120, "cover_image": "c.jpg"},
                    ],
                    ensure_ascii=False,
                )
            )

            loaded = process.load_source_candidates(batch, existing_skus={"1003"}, done_skus=set())

            self.assertEqual([str(row["sku"]) for row in loaded], ["1001"])
            skips = json.loads((batch / "source_candidates_direct_skips.json").read_text())
            self.assertEqual(len(skips), 1)
            self.assertIn("branded", skips[0]["skip_reason"])

    def test_fbs_mode_allows_mixed_mode_when_enabled(self):
        self.assertTrue(process.is_allowed_fbs_mode("FBS"))
        self.assertTrue(process.is_allowed_fbs_mode("FBO,FBS"))
        self.assertFalse(process.is_allowed_fbs_mode("FBO"))
        self.assertFalse(process.is_allowed_fbs_mode(None))

    def test_filter_unpublished_items_removes_already_published_skus(self):
        rows = [{"sku": "1001"}, {"sku": 1002}, {"sku": "1003"}]

        kept = process.filter_unpublished_items(rows, {"1002"})

        self.assertEqual([str(row["sku"]) for row in kept], ["1001", "1003"])


if __name__ == "__main__":
    unittest.main()
