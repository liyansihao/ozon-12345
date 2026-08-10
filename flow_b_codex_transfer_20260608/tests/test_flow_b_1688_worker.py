import importlib.util
import pathlib
import tempfile
import types
import unittest


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "flow_b_1688_worker.py"


class WorkerFormattingTests(unittest.TestCase):
    def test_cost_output_matches_node_parser_contract(self):
        spec = importlib.util.spec_from_file_location("flow_b_1688_worker", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        output = module.format_cost_output({
            "same_item_evidence": '{"contract":"1688-returned-same-item-v3"}',
            "match_evidence_key": "a" * 64,
            "balanced_match": {
                "passed": True,
                "match_type": "strong_single",
                "reason": "verified",
                "image_available": True,
            },
            "adaptive_match": {
                "version": "adaptive-v4-shadow",
                "decision": "FAST",
                "score": 92,
                "reason": "exact selected Offer",
                "hard_conflicts": [],
                "missing_evidence": [],
                "selected_offer_id": "offer-1",
                "supporting_offer_ids": ["offer-1"],
            },
            "cost_source": "search_first_page_cluster_p70_similarity_filtered",
            "reason": "filtered first-page similarity clustered cost",
            "filtered_first_page_prices": [10, 11, 12],
            "p70_cost": 11,
        })
        self.assertIn('SAME_ITEM_EVIDENCE {"contract":"1688-returned-same-item-v3"}', output)
        self.assertIn(f"MATCH_EVIDENCE_KEY {'a' * 64}", output)
        self.assertIn("COST_SOURCE search_first_page_cluster_p70_similarity_filtered", output)
        self.assertIn("FILTERED_FIRST_PAGE_PRICES [10, 11, 12]", output)
        self.assertIn("P70_COST 11", output)
        self.assertIn("BALANCED_MATCH_OK true", output)
        self.assertIn("BALANCED_MATCH_TYPE strong_single", output)
        self.assertIn("IMAGE_CHECK_AVAILABLE true", output)
        self.assertIn(
            'ADAPTIVE_MATCH_JSON {"version":"adaptive-v4-shadow","decision":"FAST","score":92',
            output,
        )


class WorkerTransientRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("flow_b_1688_worker_recovery", SCRIPT)
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def fake_module(self):
        return types.SimpleNamespace(
            normalize_image=lambda image_path, _temp_dir: (image_path, ""),
            summarize_products=lambda rows: rows,
            first_page_p70_cost=lambda _rows, **_kwargs: {
                "cost_source": "search_first_page_p70_similarity_filtered",
                "reason": "filtered first-page cost",
                "filtered_first_page_prices": [10, 11, 12],
                "p70_cost": 11,
            },
        )

    def test_analyze_forwards_expected_price_to_matcher(self):
        captured = {}

        def first_page_p70_cost(_rows, **kwargs):
            captured.update(kwargs)
            return {
                "cost_source": "search_first_page_p70_similarity_filtered",
                "reason": "filtered first-page cost",
                "filtered_first_page_prices": [10, 11, 12],
                "p70_cost": 11,
            }

        fake_module = types.SimpleNamespace(
            normalize_image=lambda image_path, _temp_dir: (image_path, ""),
            summarize_products=lambda rows: rows,
            first_page_p70_cost=first_page_p70_cost,
        )

        class Session:
            def search_by_image(self, _image):
                return [{"price": 11}]

        with tempfile.TemporaryDirectory() as temp_name:
            image = pathlib.Path(temp_name) / "image.jpg"
            image.write_bytes(b"image")
            self.module.analyze(fake_module, Session(), {
                "image": str(image),
                "expect_title": "same product lamp",
                "expect_price_cny": "123.45",
            })

        self.assertEqual(captured["expect_title"], "same product lamp")
        self.assertEqual(captured["expect_price_cny"], 123.45)

    def test_ssl_eof_rebuilds_session_with_bounded_backoff(self):
        sessions = []
        sleeps = []

        class Session:
            def __init__(self, fails):
                self.fails = fails
                self.closed = False

            def search_by_image(self, _image):
                if self.fails:
                    raise RuntimeError("SSL: UNEXPECTED_EOF_WHILE_READING")
                return [{"price": 11}]

            def close(self):
                self.closed = True

        def load_session():
            session = Session(fails=not sessions)
            sessions.append(session)
            return session

        with tempfile.TemporaryDirectory() as temp_name:
            image = pathlib.Path(temp_name) / "image.jpg"
            image.write_bytes(b"image")
            result, recovered_session, recovery = self.module.analyze_with_transient_recovery(
                self.fake_module(),
                None,
                {"image": str(image), "top": 10},
                load_session=load_session,
                max_retries=2,
                base_delay_seconds=0.5,
                max_jitter_seconds=0.25,
                total_budget_seconds=10,
                sleep=lambda seconds: sleeps.append(seconds),
                jitter=lambda _start, _end: 0.1,
            )

        self.assertEqual(result["p70_cost"], 11)
        self.assertIs(recovered_session, sessions[-1])
        self.assertTrue(sessions[0].closed)
        self.assertEqual(recovery["retry_count"], 1)
        self.assertEqual(recovery["retry_intervals_ms"], [600])
        self.assertEqual(sleeps, [0.6])
        self.assertEqual(len(sessions), 2)

    def test_non_transient_matching_error_is_not_retried(self):
        loads = 0
        sessions = []

        class Session:
            def __init__(self):
                self.closed = False

            def search_by_image(self, _image):
                raise ValueError("invalid image payload")

            def close(self):
                self.closed = True

        def load_session():
            nonlocal loads
            loads += 1
            session = Session()
            sessions.append(session)
            return session

        with tempfile.TemporaryDirectory() as temp_name:
            image = pathlib.Path(temp_name) / "image.jpg"
            image.write_bytes(b"image")
            with self.assertRaisesRegex(ValueError, "invalid image payload"):
                self.module.analyze_with_transient_recovery(
                    self.fake_module(),
                    None,
                    {"image": str(image), "top": 10},
                    load_session=load_session,
                    max_retries=2,
                    sleep=lambda _seconds: None,
                )

        self.assertEqual(loads, 1)
        self.assertFalse(sessions[0].closed)

    def test_non_transient_error_preserves_session_for_the_next_request(self):
        session = object()

        def fail(_module, current_session, _request):
            self.assertIs(current_session, session)
            raise ValueError("bad match payload")

        original = self.module.analyze
        self.module.analyze = fail
        try:
            with self.assertRaises(ValueError) as raised:
                self.module.analyze_with_transient_recovery(
                    self.fake_module(),
                    session,
                    {"image": "unused"},
                    load_session=lambda: self.fail("healthy session must be reused"),
                )
            self.assertIs(raised.exception.flow_b_session, session)
        finally:
            self.module.analyze = original

    def test_total_budget_prevents_another_retry(self):
        clock = iter([0.0, 4.8])

        class Session:
            def search_by_image(self, _image):
                raise RuntimeError("Connection reset by peer")

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as temp_name:
            image = pathlib.Path(temp_name) / "image.jpg"
            image.write_bytes(b"image")
            with self.assertRaisesRegex(RuntimeError, "Connection reset"):
                self.module.analyze_with_transient_recovery(
                    self.fake_module(),
                    None,
                    {"image": str(image), "top": 10},
                    load_session=Session,
                    max_retries=2,
                    base_delay_seconds=0.5,
                    max_jitter_seconds=0,
                    total_budget_seconds=5,
                    sleep=lambda _seconds: self.fail("budget-exhausted retry must not sleep"),
                    monotonic=lambda: next(clock),
                )

    def test_session_recycles_on_request_or_age_limit(self):
        session = object()
        self.assertEqual(self.module.session_recycle_reason(
            session,
            request_count=4,
            started_at=10.0,
            now=20.0,
            max_requests=4,
            max_age_seconds=120,
        ), "request-limit")
        self.assertEqual(self.module.session_recycle_reason(
            session,
            request_count=1,
            started_at=10.0,
            now=131.0,
            max_requests=4,
            max_age_seconds=120,
        ), "age-limit")
        self.assertIsNone(self.module.session_recycle_reason(
            session,
            request_count=1,
            started_at=10.0,
            now=20.0,
            max_requests=4,
            max_age_seconds=120,
        ))


if __name__ == "__main__":
    unittest.main()
