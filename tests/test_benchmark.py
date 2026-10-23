"""Pure benchmark-helper tests: no server, network, or binary build required."""
import contextlib
import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
from urllib.error import URLError

SPEC = importlib.util.spec_from_file_location(
    "ingestion_benchmark", Path(__file__).resolve().parents[1] / "scripts" / "benchmark.py")
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


class BenchmarkHelpersTests(unittest.TestCase):
    def test_defaults_preserve_sequential_workload(self):
        args = benchmark.parse_args([])
        self.assertEqual((args.points, args.batch_size, args.concurrency, args.runs, args.experiments),
                         (100000, 1000, 1, 1, 1))
        self.assertEqual(args.catalog_readers + args.history_readers, 0)

    def test_invalid_or_unbounded_config_rejected(self):
        for argv in (["--points", "0"], ["--points", "1000001"],
                     ["--batch-size", "10001"], ["--concurrency", "129"],
                     ["--points", "2", "--concurrency", "3"], ["--runs", "2"],
                     ["--experiments", "2"], ["--keys", "0"],
                     ["--catalog-readers", "10", "--history-readers", "10"],
                     ["--reader-interval", "0"], ["--reader-interval", "nan"],
                     ["--timeout", "inf"], ["--max-reader-requests", "0"],
                     ["--page-size", "50001"]):
            with self.subTest(argv=argv), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    benchmark.parse_args(argv)

    def test_uneven_partition_and_partial_batches_are_exact(self):
        args = benchmark.parse_args(["--points", "23", "--batch-size", "3",
                                     "--concurrency", "4", "--runs", "2", "--keys", "3"])
        rows = []
        for producer in range(args.concurrency):
            producer_batches = list(benchmark.batches(producer, args))
            self.assertTrue(all(0 < len(batch) <= 3 for batch in producer_batches))
            for batch in producer_batches:
                for row in batch:
                    self.assertEqual(row["step"] % args.concurrency, producer)
                    self.assertEqual(row, benchmark.point(row["step"], args.keys))
                    rows.append(row)
        self.assertEqual(sorted(row["step"] for row in rows), list(range(args.points)))
        self.assertEqual(len({row["value"] for row in rows}), args.points)
        self.assertEqual(len({row["timestamp"] for row in rows}), args.points)
        self.assertEqual({row["key"] for row in rows}, {"loss", "loss_1", "loss_2"})

    def test_history_readers_only_sample_streams_the_workload_writes(self):
        for concurrency, runs, keys in [(2, 2, 2), (8, 8, 4), (3, 2, 4)]:
            args = benchmark.parse_args(["--points", "23", "--concurrency", str(concurrency),
                                         "--runs", str(runs), "--keys", str(keys)])
            written = {(producer % runs, row["key"])
                       for producer in range(concurrency)
                       for batch in benchmark.batches(producer, args) for row in batch}
            for reader in range(4):
                targets = {benchmark.history_target(reader, index, args)
                           for index in range(args.points * 2)}
                self.assertEqual(targets, written)

    def test_nearest_rank_percentiles_and_empty(self):
        self.assertEqual(benchmark.latency_summary([]),
                         {"count": 0, "p50_ms": None, "p95_ms": None, "p99_ms": None})
        result = benchmark.latency_summary([n / 1000 for n in range(100, 0, -1)])
        self.assertEqual(result, {"count": 100, "p50_ms": 50, "p95_ms": 95, "p99_ms": 99})
        self.assertEqual(benchmark.latency_summary([0.125])["p99_ms"], 125)

    def test_failed_requests_are_not_retried_and_503_is_explicit(self):
        http = SimpleNamespace(request=Mock(side_effect=[benchmark.APIError(503, "full"),
                                                         TimeoutError("late"), {"inserted": 1}]))
        recorder = benchmark.Recorder(SimpleNamespace(http=http))
        self.assertIsNone(recorder.request("write", "POST", "/metrics", {}))
        self.assertEqual(http.request.call_count, 1)
        self.assertIsNone(recorder.request("write", "POST", "/metrics", {}))
        self.assertEqual(recorder.request("write", "POST", "/metrics", {}), {"inserted": 1})
        summary = benchmark.summarize_requests([recorder])["write"]
        self.assertEqual(summary["attempted"], 3)
        self.assertEqual(summary["acknowledged"], 1)
        self.assertEqual(summary["status_errors"], {"503": 1, "timeout": 1})
        self.assertEqual(summary["latency"]["count"], 3)
        self.assertEqual(benchmark.error_status(URLError(TimeoutError())), "timeout")
        self.assertEqual(benchmark.error_status(benchmark.APIError(500, "db")), "500")
        self.assertEqual(benchmark.error_status(OSError("reset")), "transport_or_client_error")

    def test_summary_merges_workers_without_mutating_them(self):
        recorders = []
        for _ in range(2):
            recorder = benchmark.Recorder(SimpleNamespace(http=SimpleNamespace(request=Mock(return_value={}))))
            recorder.request("catalog", "GET", "/api/catalog")
            recorders.append(recorder)
        first = benchmark.summarize_requests(recorders)
        self.assertEqual(first["catalog"]["attempted"], 2)
        self.assertEqual(first, benchmark.summarize_requests(recorders))

    def test_exact_readback_detects_each_tuple_field_and_cross_run(self):
        args = benchmark.parse_args(["--points", "8", "--concurrency", "4", "--runs", "2"])
        row = benchmark.point(3, args.keys)
        ack = bytearray([1] * args.points)
        seen = bytearray(args.points)
        benchmark.verify_point(row, 1, "loss", args, ack, seen)
        self.assertEqual(sum(seen), 1)
        for field, value in (("step", -1), ("step", True), ("step", 8), ("key", "other"),
                             ("timestamp", row["timestamp"] + 1), ("value", -5)):
            with self.subTest(field=field, value=value), self.assertRaises(benchmark.IntegrityError):
                benchmark.verify_point({**row, field: value}, 1, "loss", args, ack, bytearray(args.points))
        with self.assertRaisesRegex(benchmark.IntegrityError, "tuple mismatch"):
            benchmark.verify_point(row, 0, "loss", args, ack, bytearray(args.points))
        with self.assertRaisesRegex(benchmark.IntegrityError, "duplicate"):
            benchmark.verify_point(row, 1, "loss", args, ack, seen)
        with self.assertRaisesRegex(benchmark.IntegrityError, "unacknowledged"):
            benchmark.verify_point(row, 1, "loss", args, bytearray(args.points), bytearray(args.points))

    def history_fixture(self):
        args = benchmark.parse_args(["--points", "3", "--page-size", "2"])
        # Deliberately different insertion/step order, as concurrent writers can produce.
        rows = [{**benchmark.point(step, 1), "seq": seq}
                for seq, step in enumerate((2, 0, 1), 1)]
        pages = [{"snapshot": 3, "total": 3, "points": rows[:2], "next_after": 2},
                 {"snapshot": 3, "total": 3, "points": rows[2:], "next_after": None}]
        return args, pages

    def test_pagination_checks_exact_rows_without_assuming_step_order(self):
        args, pages = self.history_fixture()
        queries = []
        def request(*_args, **kwargs):
            queries.append(dict(kwargs["query"]))
            return pages[len(queries) - 1]
        seen = bytearray(args.points)
        result = benchmark.verify_history(SimpleNamespace(request=request), "/run", 0, "loss", args,
                                          bytearray([1] * args.points), seen, 3)
        self.assertEqual(result, 3)
        self.assertEqual(sum(seen), 3)
        self.assertEqual(queries, [{"key": "loss", "limit": 2},
                                  {"key": "loss", "limit": 2, "after": 2, "snapshot": 3}])

    def test_pagination_rejects_snapshot_count_cursor_and_missing_rows(self):
        for mode in ("snapshot", "total", "cursor", "empty", "missing", "seq", "duplicate", "failed"):
            args, pages = self.history_fixture()
            if mode == "snapshot":
                pages[1]["snapshot"] = 4
            elif mode == "total":
                pages[0]["total"] = 4
            elif mode == "cursor":
                pages[0]["next_after"] = 0
            elif mode == "empty":
                pages[0]["points"] = []
            elif mode == "missing":
                pages[1]["points"] = []
            elif mode == "seq":
                pages[1]["points"][0]["seq"] = 2
            elif mode == "duplicate":
                pages[1]["points"][0] = {**pages[0]["points"][0], "seq": 3}
            elif mode == "failed":
                pages[0] = None
            with self.subTest(mode=mode), self.assertRaises(benchmark.IntegrityError):
                benchmark.verify_history(SimpleNamespace(request=Mock(side_effect=pages)), "/run", 0,
                                         "loss", args, bytearray([1] * args.points), bytearray(args.points), 3)

    def test_empty_history_is_verified(self):
        args = benchmark.parse_args(["--points", "1"])
        page = {"snapshot": 0, "total": 0, "points": [], "next_after": None}
        self.assertEqual(benchmark.verify_history(SimpleNamespace(request=Mock(return_value=page)),
                         "/run", 0, "loss", args, bytearray(1), bytearray(1), 0), 0)


if __name__ == "__main__":
    unittest.main()
