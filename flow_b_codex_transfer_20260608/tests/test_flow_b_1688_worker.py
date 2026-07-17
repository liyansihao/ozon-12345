import importlib.util
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "flow_b_1688_worker.py"


class WorkerFormattingTests(unittest.TestCase):
    def test_cost_output_matches_node_parser_contract(self):
        spec = importlib.util.spec_from_file_location("flow_b_1688_worker", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        output = module.format_cost_output({
            "cost_source": "search_first_page_cluster_p70_similarity_filtered",
            "reason": "filtered first-page similarity clustered cost",
            "filtered_first_page_prices": [10, 11, 12],
            "p70_cost": 11,
        })
        self.assertIn("COST_SOURCE search_first_page_cluster_p70_similarity_filtered", output)
        self.assertIn("FILTERED_FIRST_PAGE_PRICES [10, 11, 12]", output)
        self.assertIn("P70_COST 11", output)


if __name__ == "__main__":
    unittest.main()
