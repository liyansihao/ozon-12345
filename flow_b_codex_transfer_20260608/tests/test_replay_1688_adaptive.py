import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "replay_1688_adaptive.py"

spec = importlib.util.spec_from_file_location("replay_1688_adaptive", SCRIPT)
replay = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(replay)


def evidence(offer, title="expected product", cost=12.5):
    return {
        "contract": "1688-returned-same-item-v3",
        "request": {"expect_title": title},
        "selected_offer_id": offer,
        "selected_cost": cost,
        "rows": [{
            "offer_id": offer,
            "offer_url": f"https://detail.1688.com/offer/{offer}.html",
            "title": f"selected {offer}",
            "supplier_id": "factory-a",
            "price": cost,
        }],
    }


def write_output(directory, sku, payload):
    path = Path(directory) / f"{sku}.out"
    path.write_text(
        "NOISE before evidence\n"
        f"SAME_ITEM_EVIDENCE {json.dumps(payload, ensure_ascii=False)}\n"
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


def cohort_digest(skus):
    normalized = sorted({str(sku).strip() for sku in skus if str(sku).strip()})
    payload = "\n".join(normalized) + ("\n" if normalized else "")
    return len(normalized), hashlib.sha256(payload.encode("utf-8")).hexdigest()


def write_selected_cohort(directory, skus):
    path = Path(directory) / "selected.jsonl"
    path.write_text(
        "".join(f'{json.dumps({"sku": sku})}\n' for sku in skus),
        encoding="utf-8",
    )
    return path


def valid_live_summary(
    *,
    candidates=1,
    rate=100,
    candidate_skus=None,
    allow_count=None,
    reject_count=0,
    unassessable_count=0,
):
    candidate_skus = (
        list(candidate_skus)
        if candidate_skus is not None
        else [f"sku-{index + 1}" for index in range(candidates)]
    )
    candidate_sku_count, candidate_skus_sha256 = cohort_digest(candidate_skus)
    if allow_count is None:
        allow_count = candidates - reject_count - unassessable_count
    action_count = allow_count + reject_count
    return {
        "scope": "live-1688-prewarm",
        "adaptive_action_policy": "shadow",
        "candidates": candidates,
        "candidate_sku_count": candidate_sku_count,
        "candidate_skus_sha256": candidate_skus_sha256,
        "completed": candidates,
        "actual_live_attempt_count": candidates,
        "actual_live_attempts_per_hour": rate,
        "unattempted_count": 0,
        "cache_hits": 0,
        "cache_misses": candidates,
        "errors": 0,
        "process_error_count": 0,
        "deferred_count": 0,
        "health_circuit_backoff_count": 0,
        "adaptive_action_count": action_count,
        "adaptive_allow_count": allow_count,
        "adaptive_reject_action_count": reject_count,
        "adaptive_action_unassessable_count": unassessable_count,
        "acceptance": {
            "completed_all_candidates": True,
            "attempted_all_candidates": True,
            "cold_cache": True,
            "error_free": True,
            "no_deferred_results": True,
            "no_health_circuit_backoff": True,
            "speed_passed": True,
            "passed": True,
        },
        "binary_action_observation": {
            "metric": "complete_binary_actions_per_hour",
            "action_count": action_count,
            "allow_count": allow_count,
            "reject_count": reject_count,
            "unassessable_count": unassessable_count,
            "matcher_version_required": "adaptive-v5-shadow",
            "policy_version_required": "adaptive-v5-policy-1",
            "evidence_complete_required": True,
            "readiness": "collecting",
            "adaptive_action_policy": "shadow",
            "quality_mode": "shadow-not-enforced",
            "enforced": False,
            "automatic_enforcement": False,
            "manual_approval_required": True,
        },
    }


def fake_decider(payload):
    offer = payload["selected_offer_id"]
    if offer.startswith("fast"):
        return v5_result(
            decision="FAST",
            score=91,
            reason="strong exact evidence",
            hard_conflicts=[],
            missing_evidence=[],
            selected_offer_id=offer,
            supporting_offer_ids=[offer],
        )
    if offer.startswith("review"):
        return v5_result(
            decision="REVIEW",
            score=68,
            reason="quantity needs confirmation",
            hard_conflicts=[],
            missing_evidence=["pack_quantity", "sku_detail"],
            selected_offer_id=offer,
        )
    return v5_result(
        decision="REJECT",
        score=5,
        reason="model conflict",
        hard_conflicts=["model_conflict"],
        missing_evidence=[],
        selected_offer_id=offer,
        action="REJECT",
        policy_reasons=["hard_conflict:model_conflict"],
        brand_evidence={
            "expected_families": ["target"],
            "selected_families": ["wrong"],
            "matched": False,
        },
        expected_product_roles=["phone"],
        selected_product_roles=["phone_case"],
        expected_models=["x100"],
    )


class AdaptiveReplayTests(unittest.TestCase):
    def test_counts_distributions_and_bounded_samples(self):
        with tempfile.TemporaryDirectory() as temp_name:
            write_output(temp_name, "100", evidence("fast-1", "fast title", 11))
            write_output(temp_name, "101", evidence("fast-2", "second fast", 12))
            write_output(temp_name, "200", evidence("review-1", "review title", 13))
            write_output(temp_name, "300", evidence("reject-1", "reject title", 14))
            (Path(temp_name) / "bad.out").write_text(
                "SAME_ITEM_EVIDENCE {broken json\n", encoding="utf-8"
            )
            (Path(temp_name) / "missing.out").write_text("P70_COST None\n", encoding="utf-8")

            report = replay.replay_directory(temp_name, fake_decider, sample_limit=1)

        self.assertEqual(report["files_total"], 6)
        self.assertEqual(report["evidence_valid"], 4)
        self.assertEqual(report["evidence_invalid"], 2)
        self.assertEqual(report["decisions"]["FAST"], {"count": 2, "percent": 50.0})
        self.assertEqual(report["decisions"]["REVIEW"], {"count": 1, "percent": 25.0})
        self.assertEqual(report["decisions"]["REJECT"], {"count": 1, "percent": 25.0})
        self.assertEqual(report["reasons"]["strong exact evidence"], 2)
        self.assertEqual(report["hard_conflicts"], {"model_conflict": 1})
        self.assertEqual(
            report["missing_evidence"], {"pack_quantity": 1, "sku_detail": 1}
        )
        self.assertEqual(
            report["invalid_evidence_reasons"],
            {"invalid_json": 1, "missing_evidence_line": 1},
        )
        self.assertEqual(report["actions"]["sample_count"], 4)
        self.assertEqual(
            report["actions"]["sample_distribution"],
            {
                "ALLOW": {"count": 3, "percent": 75.0},
                "REJECT": {"count": 1, "percent": 25.0},
            },
        )
        self.assertEqual(report["unassessable"]["count"], 2)
        self.assertEqual(
            report["unassessable"]["reasons"],
            {"invalid_evidence:invalid_json": 1, "invalid_evidence:missing_evidence_line": 1},
        )
        self.assertEqual(report["readiness"], "collecting")
        self.assertFalse(report["enforcement"]["automatic_enforcement"])
        self.assertEqual(len(report["samples"]["FAST"]), 1)
        self.assertEqual(
            report["samples"]["FAST"][0],
            {
                "sku": "100",
                "expected_title": "fast title",
                "selected_offer": "fast-1",
                "cost": 11,
                "reason": "strong exact evidence",
            },
        )

    def test_crosschecks_selected_and_sibling_published_jsonl(self):
        with tempfile.TemporaryDirectory() as temp_name:
            source = Path(temp_name) / "1688"
            source.mkdir()
            write_output(source, "100", evidence("fast-1"))
            write_output(source, "200", evidence("review-1"))
            write_output(source, "300", evidence("reject-1"))
            selected = Path(temp_name) / "selected.jsonl"
            selected.write_text(
                "\n".join([
                    json.dumps({"sku": "100"}),
                    json.dumps({"data": {"sku": "200"}}),
                    json.dumps({"sku": "not-replayed"}),
                    "not-json",
                ]) + "\n",
                encoding="utf-8",
            )
            selected.with_name("published.jsonl").write_text(
                "\n".join([
                    json.dumps({"sku": "100", "status": "published"}),
                    json.dumps({"sku": "300", "status": "published"}),
                ]) + "\n",
                encoding="utf-8",
            )

            report = replay.replay_directory(
                source, fake_decider, selected_jsonl=selected
            )

        crosscheck = report["selected_crosscheck"]
        self.assertEqual(crosscheck["selected_rows"], 3)
        self.assertEqual(crosscheck["selected_invalid"], 1)
        self.assertEqual(crosscheck["published_rows"], 2)
        self.assertEqual(crosscheck["matched_selected"], 2)
        self.assertEqual(crosscheck["matched_published"], 2)
        self.assertEqual(crosscheck["by_decision"]["FAST"], {"selected": 1, "published": 1})
        self.assertEqual(crosscheck["by_decision"]["REVIEW"], {"selected": 1, "published": 0})
        self.assertEqual(crosscheck["by_decision"]["REJECT"], {"selected": 0, "published": 1})

    def test_streams_outputs_without_path_read_text(self):
        with tempfile.TemporaryDirectory() as temp_name:
            write_output(temp_name, "100", evidence("fast-1"))
            with mock.patch.object(Path, "read_text", side_effect=AssertionError("bulk read")):
                report = replay.replay_directory(temp_name, fake_decider)
        self.assertEqual(report["evidence_valid"], 1)

    def test_cli_defaults_to_stdout_and_can_write_output(self):
        with tempfile.TemporaryDirectory() as temp_name:
            write_output(temp_name, "100", evidence("fast-1"))
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = replay.main(["--input-dir", temp_name, "-n", "0"], decider=fake_decider)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(stdout.getvalue())["samples"]["FAST"], [])

            output = Path(temp_name) / "report" / "adaptive.json"
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = replay.main(
                    ["--input-dir", temp_name, "--output", str(output)],
                    decider=fake_decider,
                )
            self.assertEqual(code, 0)
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["files_total"], 1)

    def test_only_explicit_complete_actions_enter_binary_sample(self):
        def decider(payload):
            offer = payload["selected_offer_id"]
            base = {"decision": "REVIEW", "reason": offer, "selected_offer_id": offer}
            if offer == "allow":
                return v5_result(**base, action="ALLOW")
            if offer == "reject":
                return v5_result(**base, action="REJECT")
            if offer == "incomplete":
                return v5_result(**base, action="ALLOW", evidence_complete=False)
            if offer == "invalid":
                return v5_result(**base, action="BLOCK")
            if offer == "wrong-version":
                return {
                    **v5_result(**base, action="ALLOW"),
                    "version": "adaptive-v4-shadow",
                }
            if offer == "spoofed-structure":
                result = v5_result(**base, action="ALLOW")
                result["valuable_digital"].pop("price_cny")
                return result
            return base

        with tempfile.TemporaryDirectory() as temp_name:
            for index, offer in enumerate((
                "allow",
                "reject",
                "incomplete",
                "invalid",
                "legacy",
                "wrong-version",
                "spoofed-structure",
            )):
                write_output(temp_name, str(index), evidence(offer))
            report = replay.replay_directory(
                temp_name,
                decider,
                action_sample_size=2,
            )

        self.assertEqual(report["actions"]["sample_count"], 2)
        self.assertTrue(report["actions"]["sample_complete"])
        self.assertEqual(
            report["actions"]["sample_distribution"],
            {
                "ALLOW": {"count": 1, "percent": 50.0},
                "REJECT": {"count": 1, "percent": 50.0},
            },
        )
        self.assertEqual(report["unassessable"]["count"], 5)
        self.assertEqual(report["unassessable"]["reasons"]["evidence_incomplete"], 2)
        self.assertEqual(report["unassessable"]["reasons"]["invalid_action"], 1)
        self.assertEqual(report["unassessable"]["reasons"]["missing_action"], 1)
        self.assertEqual(report["unassessable"]["reasons"]["unsupported_action_version"], 2)
        self.assertEqual(report["unassessable"]["reasons"]["invalid_valuable_digital"], 2)
        self.assertEqual(
            report["unassessable"]["legacy_decision_distribution"],
            {"FAST": 0, "REVIEW": 2, "REJECT": 0},
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
                normalized = replay._normalized_result(candidate)
                self.assertFalse(normalized["action_assessable"])
                self.assertIn(
                    "invalid_valuable_digital",
                    normalized["action_unassessable_reasons"],
                )

        valid = v5_result(price_cny=350)
        valid["valuable_digital"].update({
            "applies": True,
            "category": "smartphone",
        })
        self.assertTrue(replay._normalized_result(valid)["action_assessable"])

    def test_historical_price_join_is_injected_without_inventing_missing_value(self):
        observed = {}

        def decider(payload):
            sku_marker = payload["selected_offer_id"]
            observed[sku_marker] = (payload.get("request") or {}).get("expect_price_cny")
            price = observed[sku_marker]
            return v5_result(
                decision="REVIEW",
                reason="test",
                selected_offer_id=sku_marker,
                action="ALLOW" if price is not None else None,
                evidence_complete=price is not None,
                policy_reasons=["policy_allow"] if price is not None else ["evidence_incomplete"],
                price_cny=price,
            )

        with tempfile.TemporaryDirectory() as temp_name:
            source = Path(temp_name) / "1688"
            source.mkdir()
            write_output(source, "100", evidence("joined"))
            write_output(source, "200", evidence("missing"))
            selected = Path(temp_name) / "selected.jsonl"
            selected.write_text(
                json.dumps({"sku": "100", "data": {"sell_price": 399}}) + "\n",
                encoding="utf-8",
            )
            report = replay.replay_directory(
                source,
                decider,
                selected_jsonl=selected,
                price_jsonl=selected,
                action_sample_size=1,
            )

        self.assertEqual(observed, {"joined": 399.0, "missing": None})
        self.assertEqual(report["historical_price_join"]["provenance"], "joined_historical_price")
        self.assertEqual(report["historical_price_join"]["joined_price_evidence"], 1)
        self.assertEqual(report["historical_price_join"]["missing_price_evidence"], 1)
        self.assertEqual(report["actions"]["sample_count"], 1)
        self.assertEqual(report["actions"]["scope"], "selected-jsonl-cohort")
        self.assertEqual(report["actions"]["cohort_decisions"], 1)
        self.assertEqual(report["unassessable"]["count"], 0)
        self.assertEqual(report["decisions"]["REVIEW"]["count"], 2)

    def test_labels_live_health_and_audit_templates_gate_manual_readiness(self):
        with tempfile.TemporaryDirectory() as temp_name:
            write_output(temp_name, "100", evidence("fast-1", "allowed title", 11))
            write_output(temp_name, "200", evidence("reject-1", "rejected title", 14))
            labels = Path(temp_name) / "labels.csv"
            labels.write_text(
                "sku,human_verdict,review_note\n200,true_reject,confirmed mismatch\n",
                encoding="utf-8",
            )
            selected = write_selected_cohort(temp_name, ["100", "200"])
            live = valid_live_summary(
                candidates=2,
                rate=25,
                candidate_skus=["100", "200"],
                reject_count=1,
            )
            report = replay.replay_directory(
                temp_name,
                fake_decider,
                selected_jsonl=selected,
                reject_labels=labels,
                live_summary=live,
                action_sample_size=2,
            )
            audit_jsonl = Path(temp_name) / "reject-audit.jsonl"
            audit_csv = Path(temp_name) / "reject-audit.csv"
            replay.write_reject_audit_jsonl(audit_jsonl, report["reject_audit"])
            replay.write_reject_audit_csv(audit_csv, report["reject_audit"])
            jsonl_row = json.loads(audit_jsonl.read_text(encoding="utf-8").strip())
            csv_text = audit_csv.read_text(encoding="utf-8-sig")

        self.assertEqual(report["readiness"], "awaiting_manual_approval")
        self.assertTrue(report["live_health_gate"]["passed"])
        self.assertTrue(report["live_action_evidence_gate"]["passed"])
        self.assertTrue(
            report["readiness_checks"]["historical_complete_action_sample_collected"]
        )
        self.assertTrue(
            report["readiness_checks"]["live_complete_action_sample_collected"]
        )
        self.assertTrue(report["manual_reject_audit"]["all_rejects_labeled"])
        self.assertEqual(report["manual_reject_audit"]["false_reject_rate"], 0.0)
        self.assertFalse(report["enforcement"]["automatic_enforcement"])
        self.assertEqual(jsonl_row["human_verdict"], "")
        self.assertEqual(jsonl_row["review_note"], "")
        self.assertEqual(jsonl_row["selected_offer_id"], "reject-1")
        self.assertIn("expected_title,selected_offer_id,selected_offer_url", csv_text)
        self.assertIn("human_verdict,review_note", csv_text)

    def test_false_reject_rate_above_five_percent_never_becomes_ready(self):
        with tempfile.TemporaryDirectory() as temp_name:
            write_output(temp_name, "100", evidence("reject-1"))
            labels = Path(temp_name) / "labels.jsonl"
            labels.write_text(
                json.dumps({"sku": "100", "human_verdict": "false_reject"}) + "\n",
                encoding="utf-8",
            )
            selected = write_selected_cohort(temp_name, ["100"])
            report = replay.replay_directory(
                temp_name,
                fake_decider,
                selected_jsonl=selected,
                reject_labels=labels,
                live_summary=valid_live_summary(
                    candidate_skus=["100"],
                    reject_count=1,
                ),
                action_sample_size=1,
            )

        self.assertEqual(report["manual_reject_audit"]["false_reject_rate"], 1.0)
        self.assertFalse(report["manual_reject_audit"]["false_reject_rate_passed"])
        self.assertEqual(report["readiness"], "collecting")

    def test_zero_reject_sample_cannot_vacuously_pass_manual_audit(self):
        with tempfile.TemporaryDirectory() as temp_name:
            write_output(temp_name, "100", evidence("fast-1"))
            write_output(temp_name, "200", evidence("fast-2"))
            selected = write_selected_cohort(temp_name, ["100", "200"])
            report = replay.replay_directory(
                temp_name,
                fake_decider,
                selected_jsonl=selected,
                live_summary=valid_live_summary(
                    candidates=2,
                    candidate_skus=["100", "200"],
                ),
                action_sample_size=2,
            )

        audit = report["manual_reject_audit"]
        self.assertEqual(audit["sampled_reject_count"], 0)
        self.assertFalse(audit["sample_contains_reject"])
        self.assertFalse(audit["all_rejects_labeled"])
        self.assertIsNone(audit["false_reject_rate"])
        self.assertFalse(audit["false_reject_rate_passed"])
        self.assertFalse(report["readiness_checks"]["sample_contains_reject"])
        self.assertEqual(report["readiness"], "collecting")

    def test_live_health_gate_requires_full_prewarm_acceptance_and_consistent_counts(self):
        valid = valid_live_summary(candidates=2, rate=25)
        self.assertTrue(replay.live_health_gate(valid)["passed"])

        invalid_summaries = {}
        invalid_summaries["acceptance"] = copy.deepcopy(valid)
        invalid_summaries["acceptance"]["acceptance"]["passed"] = False
        invalid_summaries["cold_cache"] = copy.deepcopy(valid)
        invalid_summaries["cold_cache"]["cache_hits"] = 1
        invalid_summaries["cold_cache"]["cache_misses"] = 1
        invalid_summaries["attempts"] = copy.deepcopy(valid)
        invalid_summaries["attempts"]["actual_live_attempt_count"] = 1
        invalid_summaries["attempts"]["unattempted_count"] = 1
        invalid_summaries["errors"] = copy.deepcopy(valid)
        invalid_summaries["errors"]["errors"] = 1
        invalid_summaries["deferred"] = copy.deepcopy(valid)
        invalid_summaries["deferred"]["deferred_count"] = 1
        invalid_summaries["circuit"] = copy.deepcopy(valid)
        invalid_summaries["circuit"]["health_circuit_backoff_count"] = 1

        for name, summary in invalid_summaries.items():
            with self.subTest(name=name):
                self.assertFalse(replay.live_health_gate(summary)["passed"])

    def test_live_action_evidence_gate_binds_new_shadow_v5_summary_to_same_cohort(self):
        selected_skus = {"b", "a"}
        valid = valid_live_summary(
            candidates=2,
            candidate_skus=["b", "a", "a"],
            allow_count=1,
            reject_count=1,
        )
        gate = replay.live_action_evidence_gate(
            valid,
            action_sample_size=2,
            selected_cohort_skus=selected_skus,
        )
        self.assertTrue(gate["passed"])
        self.assertEqual(
            gate["selected_cohort_skus_sha256"],
            "911169ddaaf146aff539f58c26c489af3b892dff0fe283c1c264c65ae5aa59a2",
        )

        old_summary = {
            key: value
            for key, value in valid.items()
            if key not in {
                "adaptive_action_policy",
                "candidate_sku_count",
                "candidate_skus_sha256",
                "adaptive_action_count",
                "adaptive_allow_count",
                "adaptive_reject_action_count",
                "adaptive_action_unassessable_count",
                "binary_action_observation",
            }
        }
        invalid_summaries = {"old-summary": old_summary}
        invalid_summaries["missing-digest"] = copy.deepcopy(valid)
        invalid_summaries["missing-digest"].pop("candidate_skus_sha256")
        invalid_summaries["wrong-cohort-digest"] = copy.deepcopy(valid)
        invalid_summaries["wrong-cohort-digest"]["candidate_skus_sha256"] = "0" * 64
        invalid_summaries["string-count"] = copy.deepcopy(valid)
        invalid_summaries["string-count"]["adaptive_action_count"] = "2"
        invalid_summaries["enforce-policy"] = copy.deepcopy(valid)
        invalid_summaries["enforce-policy"]["adaptive_action_policy"] = "enforce"
        invalid_summaries["enforce-policy"]["binary_action_observation"][
            "adaptive_action_policy"
        ] = "enforce"
        invalid_summaries["wrong-matcher-version"] = copy.deepcopy(valid)
        invalid_summaries["wrong-matcher-version"]["binary_action_observation"][
            "matcher_version_required"
        ] = "adaptive-v4-shadow"
        invalid_summaries["insufficient-actions"] = copy.deepcopy(valid)
        invalid_summaries["insufficient-actions"].update({
            "adaptive_action_count": 1,
            "adaptive_allow_count": 1,
            "adaptive_reject_action_count": 0,
            "adaptive_action_unassessable_count": 1,
        })
        invalid_summaries["insufficient-actions"]["binary_action_observation"].update({
            "action_count": 1,
            "allow_count": 1,
            "reject_count": 0,
            "unassessable_count": 1,
        })
        invalid_summaries["action-sum-mismatch"] = copy.deepcopy(valid)
        invalid_summaries["action-sum-mismatch"]["adaptive_allow_count"] = 2
        invalid_summaries["action-sum-mismatch"]["binary_action_observation"]["allow_count"] = 2
        invalid_summaries["incomplete-live-attempts"] = copy.deepcopy(valid)
        invalid_summaries["incomplete-live-attempts"]["actual_live_attempt_count"] = 1
        invalid_summaries["incomplete-live-attempts"]["unattempted_count"] = 1

        for name, summary in invalid_summaries.items():
            with self.subTest(name=name):
                self.assertFalse(replay.live_action_evidence_gate(
                    summary,
                    action_sample_size=2,
                    selected_cohort_skus=selected_skus,
                )["passed"])

        self.assertFalse(replay.live_action_evidence_gate(
            valid,
            action_sample_size=2,
            selected_cohort_skus=None,
        )["passed"])

    def test_historical_sample_cannot_substitute_for_live_action_evidence(self):
        with tempfile.TemporaryDirectory() as temp_name:
            write_output(temp_name, "100", evidence("fast-1"))
            write_output(temp_name, "200", evidence("reject-1"))
            selected = write_selected_cohort(temp_name, ["100", "200"])
            labels = Path(temp_name) / "labels.csv"
            labels.write_text(
                "sku,human_verdict\n200,true_reject\n",
                encoding="utf-8",
            )
            old_live_summary = valid_live_summary(
                candidates=2,
                candidate_skus=["100", "200"],
                reject_count=1,
            )
            for field in (
                "adaptive_action_policy",
                "candidate_sku_count",
                "candidate_skus_sha256",
                "adaptive_action_count",
                "adaptive_allow_count",
                "adaptive_reject_action_count",
                "adaptive_action_unassessable_count",
                "binary_action_observation",
            ):
                old_live_summary.pop(field)
            report = replay.replay_directory(
                temp_name,
                fake_decider,
                selected_jsonl=selected,
                reject_labels=labels,
                live_summary=old_live_summary,
                action_sample_size=2,
            )

        self.assertTrue(
            report["readiness_checks"]["historical_complete_action_sample_collected"]
        )
        self.assertTrue(report["live_health_gate"]["passed"])
        self.assertFalse(report["live_action_evidence_gate"]["passed"])
        self.assertFalse(
            report["readiness_checks"]["live_complete_action_sample_collected"]
        )
        self.assertFalse(
            report["live_action_evidence_gate"]["historical_replay_alone_satisfies_gate"]
        )
        self.assertIn(
            "Historical replay cannot satisfy this gate",
            report["live_action_evidence_gate"]["note"],
        )
        self.assertEqual(report["readiness"], "collecting")


class AdaptiveDeciderLoadingTests(unittest.TestCase):
    def test_dynamic_loader_returns_named_function(self):
        with tempfile.TemporaryDirectory() as temp_name:
            module_path = Path(temp_name) / "matcher.py"
            module_path.write_text(
                "def adaptive_decision_from_evidence(evidence):\n"
                "    return {'decision': 'FAST', 'reason': 'ok'}\n",
                encoding="utf-8",
            )
            decider = replay.load_adaptive_decider(module_path)
        self.assertEqual(decider({})["decision"], "FAST")

    def test_dynamic_loader_has_clear_missing_function_error(self):
        with tempfile.TemporaryDirectory() as temp_name:
            module_path = Path(temp_name) / "matcher.py"
            module_path.write_text("VALUE = 1\n", encoding="utf-8")
            with self.assertRaisesRegex(
                replay.ReplayError, r"missing adaptive_decision_from_evidence\(evidence\)"
            ):
                replay.load_adaptive_decider(module_path)


if __name__ == "__main__":
    unittest.main()
