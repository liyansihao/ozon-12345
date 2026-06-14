import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "flow_b_codex_transfer_20260608" / "scripts" / "flow_b_rescan_sources_deep.py"

_SPEC = importlib.util.spec_from_file_location("flow_b_rescan_sources_deep", SCRIPT)
rescan = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(rescan)


class RescanSourcesDeepTests(unittest.TestCase):
    def test_auto_favorite_config_defaults_wait_for_maozi(self):
        with patch.dict(os.environ, {}, clear=True):
            config = rescan.auto_favorite_config_from_env()

        self.assertTrue(config["enabled"])
        self.assertGreaterEqual(config["initial_wait"], 20)
        self.assertGreaterEqual(config["after_scan_wait"], 10)

    def test_scan_record_keeps_favorite_count_diagnostics(self):
        record = rescan.make_record(
            url="https://www.ozon.ru/seller/a/",
            final_url="https://www.ozon.ru/seller/a/",
            title="Seller A",
            blocked=False,
            stop_reason="stable_bottom",
            start=100.0,
            collected={"https://www.ozon.ru/product/a-123456/": "A"},
            favorite_before=10,
            favorite_after=14,
            seconds_override=3.5,
        )

        self.assertEqual(record["favorite_count_before"], 10)
        self.assertEqual(record["favorite_count_after"], 14)
        self.assertEqual(record["favorite_count_delta"], 4)

    def test_favorite_count_script_uses_synchronous_request(self):
        js = rescan.favorite_count_js()

        self.assertIn("XMLHttpRequest", js)
        self.assertIn("xhr.open('GET'", js)
        self.assertIn(", false)", js)
        self.assertNotIn("is_imported=0", js)
        self.assertNotIn("async ()", js)


if __name__ == "__main__":
    unittest.main()
