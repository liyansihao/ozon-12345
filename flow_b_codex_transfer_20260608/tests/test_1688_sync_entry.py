import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "flow_b_1688_sync.py"


class Sync1688EntryTest(unittest.TestCase):
    def test_sync_session_loader_skips_async_package_initializer(self):
        spec = importlib.util.spec_from_file_location("flow_b_1688_sync", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)

        with tempfile.TemporaryDirectory(prefix="flow-b-sync-1688-") as temp_name:
            package_dir = Path(temp_name) / "search1688api"
            package_dir.mkdir()
            (package_dir / "__init__.py").write_text(
                "raise RuntimeError('async package initializer must not run')\n",
                encoding="utf-8",
            )
            (package_dir / "utils.py").write_text("VALUE = 'sync-only'\n", encoding="utf-8")
            (package_dir / "sync_session.py").write_text(
                "from .utils import VALUE\n"
                "class Sync1688Session:\n"
                "    def __init__(self, debug=True):\n"
                "        self.debug = debug\n"
                "        self.value = VALUE\n",
                encoding="utf-8",
            )

            session_class = module.load_sync_session_class(package_dir)
            session = session_class(debug=False)

            self.assertFalse(session.debug)
            self.assertEqual(session.value, "sync-only")

    def test_entry_reuses_the_existing_cost_and_match_algorithms(self):
        spec = importlib.util.spec_from_file_location("flow_b_1688_sync_reuse", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)

        result = module.first_page_p70_cost([
            {
                "offerId": f"offer-{index}",
                "title": "same product lamp",
                "price": price,
                "saleQuantity": 100 + index,
                "shop": "shop",
            }
            for index, price in enumerate([10, 11, 12], 1)
        ], expect_title="same product lamp")

        self.assertEqual(result["p70_cost"], 12.0)
        self.assertEqual(result["cost_source"], "search_first_page_cluster_p70_similarity_filtered")


if __name__ == "__main__":
    unittest.main()
