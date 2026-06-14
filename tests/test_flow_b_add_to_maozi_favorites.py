import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "flow_b_codex_transfer_20260608" / "scripts" / "flow_b_add_to_maozi_favorites.py"

_SPEC = importlib.util.spec_from_file_location("flow_b_add_to_maozi_favorites", SCRIPT)
addfav = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(addfav)


class AddToMaoziFavoritesTests(unittest.TestCase):
    def test_maozi_panel_state_detects_setting_button(self):
        state = addfav.classify_maozi_panel(
            {
                "text": "选品标签： 叶销量品 发货模式：FBS",
                "buttons": [{"text": "设置选品"}, {"text": "一键上架"}],
            }
        )

        self.assertEqual(state, "setting_available")

    def test_maozi_panel_state_detects_panel_without_setting(self):
        state = addfav.classify_maozi_panel(
            {
                "text": "选品标签： 叶销量品 发货模式：FBO",
                "buttons": [{"text": "一键上架"}, {"text": "编辑上架"}],
            }
        )

        self.assertEqual(state, "panel_no_setting")

    def test_maozi_panel_state_detects_missing_panel(self):
        state = addfav.classify_maozi_panel({"text": "普通 Ozon 商品页", "buttons": []})

        self.assertEqual(state, "no_panel")

    def test_load_product_rows_from_scan_dedupes(self):
        with tempfile.TemporaryDirectory() as tmp:
            scan = Path(tmp) / "source_deep_scan.json"
            scan.write_text(
                json.dumps(
                    [
                        {
                            "source_url": "seller-a",
                            "links": [
                                {"href": "https://www.ozon.ru/product/foo-123456789/"},
                                {"href": "https://www.ozon.ru/product/foo-123456789/?a=b"},
                                {"href": "/product/bar-987654321/"},
                            ],
                        }
                    ]
                )
            )

            rows = addfav.load_product_rows(scan, limit=10)

            self.assertEqual([row["sku"] for row in rows], ["123456789", "987654321"])


if __name__ == "__main__":
    unittest.main()
