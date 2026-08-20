import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "benchmark_1688_shadow.py"

spec = importlib.util.spec_from_file_location("benchmark_1688_shadow", SCRIPT)
benchmark = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(benchmark)


class FakeClock:
    def __init__(self, values):
        self._values = iter(values)

    def __call__(self):
        return next(self._values)


def write_output(directory, name, payload):
    path = Path(directory) / f"{name}.out"
    path.write_text(
        "irrelevant historical log line\n"
        f"SAME_ITEM_EVIDENCE {json.dumps(payload)}\n"
        "P70_COST 12.5\n",
        encoding="utf-8",
    )
    return path


def v5_result(
    *,
    decision="REVIEW",
    action="ALLOW",
    evidence_complete=True,
    policy_reasons=None,
    price_cny=350,
    **extra,
):
    return {
        "version": "adaptive-v5-shadow",
        "policy_version": "adaptive-v5-policy-1",
        "decision": decision,
        "action": action,
        "policy_reasons": list(
            policy_reasons
            if policy_reasons is not None
            else (["policy_allow"] if action == "ALLOW" else ["policy_reject"])
        ),
        "evidence_complete": evidence_complete,
        "valuable_digital": {
            "applies": False,
            "category": None,
            "price_cny": price_cny,
            "threshold_cny": 300,
        },
        **extra,
    }


def fake_decider(evidence):
    decision = evidence["decision"]
    action = "REJECT" if decision == "REJECT" else "ALLOW"
    return v5_result(
        decision=decision,
        action=action,
        score={"FAST": 90, "REVIEW": 70, "REJECT": 10}[decision],
        reason=f"test {decision.lower()}",
    )


class ShadowBenchmarkMetricsTests(unittest.TestCase):
    def test_streamed_metrics_percentiles_rates_scope_and_bounded_samples(self):
        with tempfile.TemporaryDirectory() as temp_name:
            write_output(temp_name, "100", {"decision": "FAST"})
            write_output(temp_name, "200", {"decision": "REVIEW"})
            (Path(temp_name) / "300.out").write_text(
                "SAME_ITEM_EVIDENCE {broken json\n", encoding="utf-8"
            )

            clock = FakeClock([0.0, 0.1, 0.2, 0.3, 0.5, 1.0])
            with mock.patch.object(Path, "read_text", side_effect=AssertionError("bulk read")):
                report = benchmark.benchmark_directory(
                    temp_name,
                    fake_decider,
                    minimum_products_per_hour=20,
                    sample_limit=1,
                    clock=clock,
                )

        self.assertEqual(report["scope"], "historical-shadow-replay")
        self.assertEqual(report["network_mode"], "disabled-by-design")
        self.assertIn("not live 1688", report["scope_warning"])
        self.assertEqual(report["wall_time_seconds"], 1.0)
        self.assertEqual(
            report["counts"],
            {
                "files_processed": 3,
                "evidence_parsed": 2,
                "evidence_invalid": 1,
                "decision_calls": 2,
                "decisions_completed": 2,
                "decision_errors": 0,
            },
        )
        self.assertEqual(report["decision_counts"], {"FAST": 1, "REVIEW": 1, "REJECT": 0})
        self.assertEqual(
            report["throughput_per_hour"],
            {
                "files": 10800.0,
                "evidence": 7200.0,
                "decision_products": 7200.0,
                "complete_binary_actions": 7200.0,
            },
        )
        self.assertEqual(report["binary_actions"]["sample_count"], 2)
        self.assertEqual(
            report["binary_actions"]["sample_distribution"],
            {"ALLOW": 2, "REJECT": 0},
        )
        self.assertEqual(report["binary_actions"]["unassessable_count"], 1)
        self.assertEqual(
            report["binary_actions"]["unassessable_reasons"],
            {"invalid_evidence:invalid_json": 1},
        )
        self.assertEqual(report["binary_actions"]["readiness"], "collecting")
        self.assertFalse(report["binary_actions"]["automatic_enforcement"])
        self.assertEqual(
            report["decision_latency_ms"],
            {
                "measure": "adaptive_decision_from_evidence call only",
                "count": 2,
                "p50": 150.0,
                "p95": 195.0,
                "p99": 199.0,
            },
        )
        self.assertTrue(report["acceptance"]["passed"])
        self.assertEqual(report["invalid_reasons"], {"invalid_json": 1})
        self.assertEqual(len(report["samples"]), 1)
        self.assertEqual(report["samples"][0]["sku"], "100")

    def test_optional_limit_stops_after_requested_file_count(self):
        with tempfile.TemporaryDirectory() as temp_name:
            write_output(temp_name, "100", {"decision": "FAST"})
            write_output(temp_name, "200", {"decision": "REJECT"})
            report = benchmark.benchmark_directory(
                temp_name,
                fake_decider,
                limit=1,
                clock=FakeClock([0.0, 0.1, 0.2, 1.0]),
            )
        self.assertEqual(report["counts"]["files_processed"], 1)
        self.assertEqual(report["counts"]["decisions_completed"], 1)
        self.assertEqual(report["decision_counts"]["FAST"], 1)
        self.assertEqual(report["decision_counts"]["REJECT"], 0)

    def test_legacy_and_incomplete_actions_are_unassessable_not_inferred(self):
        def decider(evidence):
            kind = evidence["decision"]
            if evidence.get("marker") == "spoofed-structure":
                result = v5_result(decision=kind, action="ALLOW")
                result["valuable_digital"].pop("category")
                return result
            if kind == "FAST":
                return v5_result(
                    decision=kind,
                    action="ALLOW",
                    evidence_complete=False,
                )
            if kind == "REVIEW":
                return {"decision": kind}
            if kind == "REJECT":
                return {
                    **v5_result(decision=kind, action="REJECT"),
                    "version": "adaptive-v4-shadow",
                }

        with tempfile.TemporaryDirectory() as temp_name:
            write_output(temp_name, "100", {"decision": "FAST"})
            write_output(temp_name, "200", {"decision": "REVIEW"})
            write_output(temp_name, "300", {"decision": "REJECT"})
            write_output(
                temp_name,
                "400",
                {"decision": "REVIEW", "marker": "spoofed-structure"},
            )
            report = benchmark.benchmark_directory(
                temp_name,
                decider,
                clock=FakeClock([
                    0.0,
                    0.0,
                    0.1,
                    0.1,
                    0.2,
                    0.2,
                    0.3,
                    0.3,
                    0.4,
                    1.0,
                ]),
            )

        self.assertEqual(report["binary_actions"]["sample_count"], 0)
        self.assertEqual(report["binary_actions"]["unassessable_count"], 4)
        self.assertEqual(
            report["binary_actions"]["unassessable_reasons"]["unsupported_action_version"],
            2,
        )
        self.assertEqual(
            report["binary_actions"]["unassessable_reasons"]["invalid_valuable_digital"],
            2,
        )
        self.assertEqual(
            report["binary_actions"]["legacy_decision_distribution"],
            {"FAST": 0, "REVIEW": 1, "REJECT": 1},
        )

    def test_complete_v5_requires_positive_price_and_bound_applied_category(self):
        invalid_valuable_rows = [
            ("null-price", None, False, None),
            ("zero-price", 0, False, None),
            ("negative-price", -1, False, None),
            ("boolean-price", True, False, None),
            ("infinite-price", float("inf"), False, None),
            ("applies-null-category", 350, True, None),
            ("applies-blank-category", 350, True, "  "),
        ]
        for name, price, applies, category in invalid_valuable_rows:
            with self.subTest(name=name):
                candidate = v5_result(price_cny=price)
                candidate["valuable_digital"].update({
                    "applies": applies,
                    "category": category,
                })
                action, reasons, assessable = benchmark._binary_action(candidate)
                self.assertEqual(action, "ALLOW")
                self.assertFalse(assessable)
                self.assertIn("invalid_valuable_digital", reasons)

        valid = v5_result(price_cny=350)
        valid["valuable_digital"].update({
            "applies": True,
            "category": "smartphone",
        })
        self.assertEqual(benchmark._binary_action(valid), ("ALLOW", [], True))

    def test_selected_price_is_joined_before_decision_without_guessing_missing_price(self):
        observed = {}

        def decider(evidence):
            sku = evidence["marker"]
            price = (evidence.get("request") or {}).get("expect_price_cny")
            observed[sku] = price
            return v5_result(
                decision="REVIEW",
                action="ALLOW" if price else None,
                evidence_complete=bool(price),
                policy_reasons=["policy_allow"] if price else ["evidence_incomplete"],
                price_cny=price,
            )

        with tempfile.TemporaryDirectory() as temp_name:
            write_output(temp_name, "100", {"decision": "REVIEW", "marker": "joined"})
            write_output(temp_name, "200", {"decision": "REVIEW", "marker": "missing"})
            selected = Path(temp_name) / "selected.jsonl"
            selected.write_text(
                json.dumps({"sku": "100", "sale_price": 350}) + "\n",
                encoding="utf-8",
            )
            report = benchmark.benchmark_directory(
                temp_name,
                decider,
                selected_jsonl=selected,
                price_jsonl=selected,
                action_sample_size=1,
                clock=FakeClock([0.0, 0.0, 0.1, 0.1, 0.2, 1.0]),
            )

        self.assertEqual(observed, {"joined": 350.0, "missing": None})
        self.assertEqual(report["historical_price_join"]["joined_price_evidence"], 1)
        self.assertEqual(report["historical_price_join"]["missing_price_evidence"], 1)
        self.assertEqual(report["binary_actions"]["sample_count"], 1)


class ShadowBenchmarkCliTests(unittest.TestCase):
    def test_cli_default_threshold_passes_and_fails_with_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as temp_name:
            write_output(temp_name, "100", {"decision": "FAST"})

            passing_stdout = io.StringIO()
            with contextlib.redirect_stdout(passing_stdout):
                passing_code = benchmark.main(
                    ["--input-dir", temp_name],
                    decider=fake_decider,
                    clock=FakeClock([0.0, 0.0, 0.01, 60.0]),
                )
            passing_report = json.loads(passing_stdout.getvalue())

            failing_stdout = io.StringIO()
            with contextlib.redirect_stdout(failing_stdout):
                failing_code = benchmark.main(
                    ["--input-dir", temp_name],
                    decider=fake_decider,
                    clock=FakeClock([0.0, 0.0, 0.01, 181.0]),
                )
            failing_report = json.loads(failing_stdout.getvalue())

        self.assertEqual(passing_code, 0)
        self.assertEqual(
            passing_report["acceptance"]["minimum_products_per_hour"], 20.0
        )
        self.assertEqual(passing_report["acceptance"]["measured_products_per_hour"], 60.0)
        self.assertTrue(passing_report["acceptance"]["passed"])
        self.assertEqual(failing_code, benchmark.EXIT_BELOW_MINIMUM)
        self.assertLess(failing_report["acceptance"]["measured_products_per_hour"], 20.0)
        self.assertFalse(failing_report["acceptance"]["passed"])

    def test_cli_can_write_report_to_output(self):
        with tempfile.TemporaryDirectory() as temp_name:
            write_output(temp_name, "100", {"decision": "FAST"})
            output = Path(temp_name) / "reports" / "shadow.json"
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = benchmark.main(
                    [
                        "--input-dir",
                        temp_name,
                        "--output",
                        str(output),
                        "--sample-limit",
                        "0",
                    ],
                    decider=fake_decider,
                    clock=FakeClock([0.0, 0.0, 0.01, 60.0]),
                )

            report = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(code, 0)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(report["scope"], "historical-shadow-replay")
        self.assertEqual(report["samples"], [])


if __name__ == "__main__":
    unittest.main()
