"""MLflow protocol units plus real official-SDK/native-server conformance.

Run with PYTHONPATH=python and NSET_BINARY pointing to a durable-ingest nset.
An isolated adapter worktree may set NSET_COMPAT_SHARED_PATH to the gateway
worker's python directory. That is a test-only package-path overlay, not a mock.
"""
import copy
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
if os.environ.get("NSET_COMPAT_SHARED_PATH"):
    sys.path.insert(0, os.environ["NSET_COMPAT_SHARED_PATH"])
try:
    import nset_compat
    nset_compat.__path__.insert(0, str(ROOT / "python" / "nset_compat"))
    from nset_compat import mlflow as adapter
    from nset_compat.common import Request, ProtocolError
except ModuleNotFoundError as error:
    adapter = None
    ADAPTER_SKIP = f"Shared gateway modules not installed: {error}"
else:
    ADAPTER_SKIP = ""


class MemoryState:
    def __init__(self):
        self.values = {}
        self.counters = {}

    def get(self, namespace, key, default=None):
        return copy.deepcopy(self.values.get((namespace, key), default))

    def put(self, namespace, key, value):
        self.values[namespace, key] = copy.deepcopy(value)

    def get_many(self, namespace, keys):
        return {k: self.get(namespace, k) for k in keys if (namespace, k) in self.values}

    def put_many(self, namespace, mapping):
        self.values.update({(namespace, k): copy.deepcopy(v) for k, v in mapping.items()})

    def items(self, namespace):
        return [(k, copy.deepcopy(v)) for (n, k), v in self.values.items() if n == namespace]

    def next_id(self, namespace, start=1):
        value = self.counters.get(namespace, start)
        self.counters[namespace] = value + 1
        return value


class FakeNative:
    """Protocol unit helper only; NOT SDK conformance evidence."""
    def __init__(self):
        self.runs = {}
        self.experiments = {}
        self.history_calls = 0
        self.metrics = {}
        self.receipts = {}
        self.calls = []
        self.fail_after_commit = False

    def request(self, method, path, payload=None, *, query=None):
        if method == "POST":
            value = dict(payload, id=str(uuid.uuid4()))
            if path == "/api/experiments":
                self.experiments[value["id"]] = value
            if path == "/api/runs":
                self.runs[value["id"]] = value
                self.metrics[value["id"]] = []
            return value
        rid = path.split("/")[3]
        if method == "PATCH":
            for key, value in payload.items():
                if key in ("params", "tags"):
                    for k, v in value.items():
                        if v is None:
                            self.runs[rid][key].pop(k, None)
                        else:
                            self.runs[rid][key][k] = v
                else:
                    self.runs[rid][key] = value
            return self.runs[rid]
        if method == "GET" and path.endswith("/metrics"):
            self.history_calls += 1
            rows = self.metrics[rid]
            snapshot = query.get("snapshot", len(rows))
            rows = [dict(m, seq=i + 1) for i, m in enumerate(rows[:snapshot])
                    if m["key"] == query["key"] and i + 1 > query.get("after", 0)]
            page = rows[:query["limit"]]
            return {"points": page, "snapshot": snapshot,
                    "next_after": page[-1]["seq"] if len(rows) > len(page) else None}
        raise AssertionError((method, path, payload, query))

    def ingest(self, rid, batch_id, metrics, wait=True):
        self.calls.append((rid, batch_id, copy.deepcopy(metrics)))
        key = (rid, batch_id)
        if key in self.receipts:
            assert self.receipts[key] == metrics
        else:
            self.receipts[key] = copy.deepcopy(metrics)
            self.metrics[rid].extend(copy.deepcopy(metrics))
        if self.fail_after_commit:
            self.fail_after_commit = False
            raise ProtocolError(503, "TEMPORARILY_UNAVAILABLE", "injected after durable commit")
        return {"state": "applied"}


class FakeContext:
    def __init__(self):
        self.state = MemoryState()
        self.native = FakeNative()
        self.ingest_metrics = self.native.ingest
        self.locks = {}

    def lock_for(self, key):
        return self.locks.setdefault(key, threading.RLock())


@unittest.skipIf(adapter is None, ADAPTER_SKIP)
class MLflowProtocolUnitTests(unittest.TestCase):
    def setUp(self):
        self.ctx = FakeContext()
        self.rid = self.call("runs/create", {"experiment_id": "0", "start_time": 123})["run"]["info"]["run_id"]

    def call(self, route, data, method=None):
        method = method or adapter._ROUTES[route][0]
        request = Request(method, adapter.API + route,
                          query=data if method == "GET" else {},
                          body=json.dumps(data).encode() if method != "GET" else b"")
        return adapter.handle(self.ctx, request).body

    def test_ids_default_experiments_tags_and_lifecycle(self):
        default = self.call("experiments/get", {"experiment_id": "0"})["experiment"]
        self.assertEqual(default["name"], "Default")
        eid = self.call("experiments/create", {"name": "work", "tags": [{"key": "team", "value": "a"}]})["experiment_id"]
        self.assertTrue(eid.isdecimal())
        self.assertNotEqual(eid, "0")
        self.assertNotEqual(self.ctx.state.get(adapter.EXP, eid)["native_id"], eid)
        self.call("experiments/update", {"experiment_id": eid, "new_name": "renamed"})
        self.call("experiments/set-experiment-tag", {"experiment_id": eid, "key": "team", "value": "b"})
        exp = self.call("experiments/get-by-name", {"experiment_name": "renamed"})["experiment"]
        self.assertEqual(exp["tags"], [{"key": "team", "value": "b"}])
        with self.assertRaises(ProtocolError):
            self.call("experiments/create", {"name": "renamed"})
        run = self.call("runs/create", {"experiment_id": eid})["run"]
        rid = run["info"]["run_id"]
        self.call("experiments/delete", {"experiment_id": eid})
        self.assertEqual(self.call("runs/get", {"run_id": rid})["run"]["info"]["lifecycle_stage"], "deleted")
        with self.assertRaises(ProtocolError):
            self.call("runs/create", {"experiment_id": eid})
        self.call("experiments/restore", {"experiment_id": eid})
        self.assertEqual(self.call("runs/get", {"run_id": rid})["run"]["info"]["lifecycle_stage"], "active")
        # Upstream experiment restore reactivates even individually deleted runs.
        self.call("runs/delete", {"run_id": rid})
        self.call("experiments/delete", {"experiment_id": eid})
        self.call("experiments/restore", {"experiment_id": eid})
        self.assertEqual(self.call("runs/get", {"run_id": rid})["run"]["info"]["lifecycle_stage"], "active")

    def test_metric_timestamp_step_latest_and_retry(self):
        metrics = [{"key": "loss", "value": v, "step": s, "timestamp": t}
                   for v, s, t in [(9, 4, 50), (8, 4, 50), (7, 4, 49), (20, 3, 100)]]
        self.call("runs/log-batch", {"run_id": self.rid, "metrics": metrics})
        self.call("runs/log-batch", {"run_id": self.rid, "metrics": metrics[::-1]})
        latest = self.call("runs/get", {"run_id": self.rid})["run"]["data"]["metrics"]
        self.assertEqual(latest, [metrics[0]])
        history = self.call("metrics/get-history", {"run_id": self.rid, "metric_key": "loss"})["metrics"]
        self.assertEqual(len(history), 4)
        native = self.ctx.state.get(adapter.RUN, self.rid)["native_id"]
        self.assertEqual(len(self.ctx.native.metrics[native]), 4)
        self.assertEqual({(m["step"], m["timestamp"]) for m in history}, {(4, 50), (4, 49), (3, 100)})

    def test_chunking_and_recovery_after_native_commit(self):
        metrics = [{"key": "x", "value": float(i), "timestamp": 100 + i, "step": i} for i in range(10001)]
        payload = {"run_id": self.rid, "metrics": metrics,
                   "params": [{"key": "fixed", "value": "v"}], "tags": [{"key": "t", "value": "ok"}]}
        self.ctx.native.fail_after_commit = True
        with self.assertRaises(ProtocolError):
            self.call("runs/log-batch", payload)
        self.assertIn("pending", self.ctx.state.get(adapter.RUN, self.rid))
        # A fresh context sharing persisted stores simulates adapter state reconstruction.
        fresh = FakeContext()
        fresh.state, fresh.native = self.ctx.state, self.ctx.native
        fresh.ingest_metrics = fresh.native.ingest
        self.ctx = fresh
        self.call("runs/log-batch", payload)
        calls = self.ctx.native.calls
        self.assertEqual([len(c[2]) for c in calls], [10000, 10000, 1])
        self.assertEqual(calls[0][1], calls[1][1])
        self.assertNotIn("pending", self.ctx.state.get(adapter.RUN, self.rid))
        self.assertEqual(len(self.ctx.native.metrics[calls[0][0]]), 10001)
        self.assertEqual(self.call("runs/get", {"run_id": self.rid})["run"]["data"]["params"], [{"key": "fixed", "value": "v"}])

    def test_named_native_experiments_preserve_external_names_and_byte_bound(self):
        for name in ("training-loss", "界" * 170 + "ab"):
            with self.subTest(name=name):
                eid = self.call("experiments/create", {"name": name})["experiment_id"]
                stored = self.ctx.state.get(adapter.EXP, eid)
                native_name = self.ctx.native.experiments[stored["native_id"]]["name"]
                self.assertTrue(native_name.startswith(f"mlflow:{eid}:"))
                self.assertLessEqual(len(native_name.encode("utf-8")), 512)
                if name == "training-loss":
                    self.assertEqual(native_name, f"mlflow:{eid}:training-loss")
                self.assertEqual(stored["name"], name)
                self.assertEqual(self.call("experiments/get-by-name", {"experiment_name": name})["experiment"]["name"], name)
                self.call("experiments/update", {"experiment_id": eid, "new_name": name + "r" if len(name) < 100 else "renamed"})
                self.assertEqual(self.ctx.native.experiments[stored["native_id"]]["name"], native_name)

    def test_indexed_many_logs_gets_and_search_never_read_native_history(self):
        with patch.object(self.ctx.state, "get_many", wraps=self.ctx.state.get_many) as lookup:
            for i in range(100):
                metrics = [{"key": key, "value": i, "timestamp": i, "step": i} for key in ("x", "y")]
                self.call("runs/log-batch", {"run_id": self.rid, "metrics": metrics})
                self.assertEqual(len(self.call("runs/get", {"run_id": self.rid})["run"]["data"]["metrics"]), 2)
                found = self.call("runs/search", {"experiment_ids": ["0"], "filter": f"metrics.x = {i}"})
                self.assertEqual([r["info"]["run_id"] for r in found["runs"]], [self.rid])
            self.assertEqual(lookup.call_count, 100)
            self.assertTrue(all(len(call.args[1]) == 2 for call in lookup.call_args_list))
        run = self.ctx.state.get(adapter.RUN, self.rid)
        self.assertEqual(run["metric_index_version"], 1)
        self.assertEqual(len(run["latest_metrics"]), 2)
        self.assertEqual(len(self.ctx.state.items(adapter._metric_namespace(run))), 200)
        self.assertEqual(self.ctx.native.history_calls, 0)
        self.assertEqual(len(self.call("metrics/get-history", {"run_id": self.rid, "metric_key": "x"})["metrics"]), 100)
        self.assertEqual(self.ctx.native.history_calls, 1)

    def test_concurrent_overlapping_batches_deduplicate_native_observations(self):
        count, width, stride = 8, 400, 100
        barrier = threading.Barrier(count)

        def log(index):
            metrics = [{"key": "x", "value": float(i), "timestamp": i, "step": i}
                       for i in range(index * stride, index * stride + width)]
            barrier.wait(timeout=10)
            self.call("runs/log-batch", {"run_id": self.rid, "metrics": metrics})
            self.call("runs/get", {"run_id": self.rid})

        with ThreadPoolExecutor(max_workers=count) as pool:
            list(pool.map(log, range(count)))
        run = self.ctx.state.get(adapter.RUN, self.rid)
        native = self.ctx.native.metrics[run["native_id"]]
        expected = (count - 1) * stride + width
        self.assertEqual(len(native), expected)
        self.assertEqual(len({adapter._metric_tuple(m) for m in native}), expected)
        self.assertEqual(run["latest_metrics"]["x"]["step"], expected - 1)
        self.assertEqual(self.ctx.native.history_calls, 0)

    def test_recovery_between_index_and_metadata_commits_replays_original_ids(self):
        metrics = [{"key": "x", "value": i, "timestamp": i, "step": i} for i in range(3)]
        payload = {"run_id": self.rid, "metrics": metrics,
                   "params": [{"key": "p", "value": "fixed"}], "tags": [{"key": "t", "value": "yes"}]}
        original_put = self.ctx.state.put

        def fail_metadata(namespace, key, value):
            if namespace == adapter.RUN and "pending" not in value:
                raise RuntimeError("injected after index commit, before metadata commit")
            original_put(namespace, key, value)

        with patch.object(self.ctx.state, "put", side_effect=fail_metadata), self.assertRaises(RuntimeError):
            self.call("runs/log-batch", payload)
        stored = self.ctx.state.get(adapter.RUN, self.rid)
        self.assertIn("pending", stored)
        self.assertEqual(stored["latest_metrics"], {})
        self.assertEqual(len(self.ctx.state.items(adapter._metric_namespace(stored))), 3)
        fresh = FakeContext()
        fresh.state, fresh.native = self.ctx.state, self.ctx.native
        fresh.ingest_metrics = fresh.native.ingest
        self.ctx = fresh
        # The retry overlaps the interrupted write but has a different payload.
        extra = {"key": "x", "value": 3, "timestamp": 3, "step": 3}
        self.call("runs/log-batch", {"run_id": self.rid, "metrics": metrics[1:] + [extra]})
        calls = self.ctx.native.calls
        self.assertEqual(calls[0][1:], calls[1][1:])
        self.assertEqual(calls[2][2], [extra])
        stored = self.ctx.state.get(adapter.RUN, self.rid)
        self.assertNotIn("pending", stored)
        self.assertEqual(stored["params"], {"p": "fixed"})
        self.assertEqual(stored["tags"]["t"], "yes")
        self.assertEqual(stored["latest_metrics"]["x"], extra)
        self.assertEqual(len(self.ctx.native.metrics[stored["native_id"]]), 4)
        self.assertEqual(self.ctx.native.history_calls, 0)

    def test_one_time_legacy_backfill_and_interrupted_migration(self):
        metrics = [{"key": "x", "value": v, "timestamp": t, "step": s}
                   for v, t, s in [(1, 100, 2), (9, 20, 3), (8, 20, 3)]]
        run = self.ctx.state.get(adapter.RUN, self.rid)
        # Old-format persisted metadata + native data, with no index/cache.
        run.pop("metric_index_version")
        run.pop("latest_metrics")
        run["metric_keys"] = ["x"]
        self.ctx.native.metrics[run["native_id"]] = copy.deepcopy(metrics)
        self.ctx.state.put(adapter.RUN, self.rid, run)
        original_put = self.ctx.state.put

        def fail_marker(namespace, key, value):
            if namespace == adapter.RUN and "metric_index_version" in value:
                raise RuntimeError("injected before migration marker")
            original_put(namespace, key, value)

        with patch.object(self.ctx.state, "put", side_effect=fail_marker), self.assertRaises(RuntimeError):
            self.call("runs/get", {"run_id": self.rid})
        self.assertNotIn("metric_index_version", self.ctx.state.get(adapter.RUN, self.rid))
        self.assertEqual(self.ctx.native.history_calls, 1)
        self.assertEqual(self.call("runs/get", {"run_id": self.rid})["run"]["data"]["metrics"], [metrics[1]])
        self.assertEqual(self.ctx.native.history_calls, 2)
        stored = self.ctx.state.get(adapter.RUN, self.rid)
        self.assertEqual(stored["metric_index_version"], 1)
        self.assertEqual(len(self.ctx.state.items(adapter._metric_namespace(stored))), 3)
        for _ in range(3):
            self.call("runs/get", {"run_id": self.rid})
            self.call("runs/search", {"experiment_ids": ["0"]})
            self.call("runs/log-batch", {"run_id": self.rid, "metrics": metrics})
        self.assertEqual(self.ctx.native.history_calls, 2)
        self.assertEqual(self.ctx.native.calls, [])
        self.assertEqual(len(self.ctx.native.metrics[run["native_id"]]), 3)

    def test_legacy_pending_replays_stable_id_after_native_backfill(self):
        metric = {"key": "x", "value": 2, "timestamp": 5, "step": 1}
        self.ctx.native.fail_after_commit = True
        with self.assertRaises(ProtocolError):
            self.call("runs/log-batch", {"run_id": self.rid, "metrics": [metric]})
        run = self.ctx.state.get(adapter.RUN, self.rid)
        run.pop("metric_index_version")
        run.pop("latest_metrics")
        run["metric_keys"] = ["x"]
        self.ctx.state.put(adapter.RUN, self.rid, run)
        self.assertEqual(self.call("runs/get", {"run_id": self.rid})["run"]["data"]["metrics"], [metric])
        self.assertEqual(self.ctx.native.calls[0][1:], self.ctx.native.calls[1][1:])
        self.assertEqual(len(self.ctx.native.metrics[run["native_id"]]), 1)
        self.assertEqual(self.ctx.native.history_calls, 1)
        self.call("runs/log-batch", {"run_id": self.rid, "metrics": [metric]})
        self.assertEqual(len(self.ctx.native.calls), 2)
        self.assertEqual(self.ctx.native.history_calls, 1)

    def test_params_are_immutable_and_batch_validated_before_write(self):
        self.call("runs/log-parameter", {"run_id": self.rid, "key": "p", "value": "first"})
        self.call("runs/log-parameter", {"run_id": self.rid, "key": "p", "value": "first"})
        with self.assertRaises(ProtocolError):
            self.call("runs/log-batch", {"run_id": self.rid,
                      "params": [{"key": "p", "value": "second"}],
                      "metrics": [{"key": "x", "value": 1, "timestamp": 1}]})
        self.assertEqual(self.ctx.native.calls, [])
        self.call("runs/set-tag", {"run_id": self.rid, "key": "label", "value": "one"})
        self.call("runs/set-tag", {"run_id": self.rid, "key": "label", "value": "two"})
        self.call("runs/delete-tag", {"run_id": self.rid, "key": "label"})
        self.assertNotIn("label", self.ctx.state.get(adapter.RUN, self.rid)["tags"])

    def test_explicit_unsupported_metrics_and_requests(self):
        for update in ({"value": "NaN"}, {"value": "Infinity"}, {"value": -0.0}, {"step": -1},
                       {"timestamp": 2 ** 53}, {"dataset_name": "training"}, {"model_id": "m"},
                       {"timestamp": None}, {"value": True}, {"key": "x" * 513}):
            with self.subTest(update=update), self.assertRaises(ProtocolError):
                self.call("runs/log-metric", {"run_id": self.rid, "key": "x", "value": 1,
                          "timestamp": 1, "step": 0, **update})
        with self.assertRaises(ProtocolError):
            self.call("runs/log-batch", {"run_id": self.rid, "unknown": "discard?"})
        with self.assertRaises(ProtocolError):
            self.call("experiments/create", {"name": "a", "artifact_location": "s3://bucket/a"})
        with self.assertRaises(ProtocolError):
            adapter.handle(self.ctx, Request("POST", adapter.API + "registered-models/create", body=b"{}"))
        self.assertEqual(self.ctx.native.calls, [])

    def test_artifact_and_logged_model_routes_reject_without_storage(self):
        state = copy.deepcopy(self.ctx.state.values)
        native = copy.deepcopy(self.ctx.native.__dict__)
        # No artifact service exists on FakeContext: rejection needs no backend.
        paths = [
            "/api/2.0/mlflow-artifacts",
            "/api/2.0/mlflow-artifacts/artifacts",
            "/api/2.0/mlflow-artifacts/artifacts/unsupported/sample.txt",
            "/api/2.0/mlflow-artifacts/artifacts/../../sample.txt",
            adapter.API + "artifacts/list",
            adapter.API + "artifacts/download",
            adapter.API + "logged-models/search",
            adapter.API + "logged-models",
        ]
        for path in paths:
            for method in ("GET", "PUT", "POST", "DELETE"):
                with self.subTest(path=path, method=method):
                    with self.assertRaises(ProtocolError) as rejected:
                        adapter.handle(self.ctx, Request(method, path, body=b"not JSON or an artifact"))
                    self.assertEqual(rejected.exception.status, 400)
                    self.assertEqual(rejected.exception.code, "NOT_IMPLEMENTED")
                    self.assertIn("not supported", str(rejected.exception))
        self.assertEqual(self.ctx.state.values, state)
        self.assertEqual(self.ctx.native.__dict__, native)

    def test_artifact_metadata_cannot_select_an_external_or_local_store(self):
        experiment = self.call("experiments/get", {"experiment_id": "0"})["experiment"]
        run = self.call("runs/get", {"run_id": self.rid})["run"]
        self.assertEqual(experiment["artifact_location"], "mlflow-artifacts:/unsupported")
        self.assertEqual(run["info"]["artifact_uri"], "mlflow-artifacts:/unsupported")
        state = copy.deepcopy(self.ctx.state.values)
        for location in ("s3://bucket/path", "https://example.com/artifacts", "file:///tmp/artifacts",
                         "/tmp/artifacts", "mlflow-artifacts://example.com/path"):
            with self.subTest(location=location), self.assertRaises(ProtocolError) as rejected:
                self.call("experiments/create", {"name": "external", "artifact_location": location})
            self.assertEqual(rejected.exception.status, 400)
            self.assertEqual(rejected.exception.code, "NOT_IMPLEMENTED")
        self.assertEqual(self.ctx.state.values, state)

    def test_search_filters_order_and_bound_pagination(self):
        eid = self.call("experiments/create", {"name": "search"})["experiment_id"]
        for i in range(3):
            rid = self.call("runs/create", {"experiment_id": eid, "start_time": i, "run_name": f"run-{i}"})["run"]["info"]["run_id"]
            self.call("runs/log-batch", {"run_id": rid,
                      "params": [{"key": "p", "value": "a AND b"}],
                      "metrics": [{"key": "loss", "value": i, "timestamp": i, "step": 0}]})
        query = {"experiment_ids": [eid], "filter": "params.p = 'a AND b' AND metrics.loss >= 1",
                 "order_by": ["metrics.loss DESC"], "max_results": 1}
        page = self.call("runs/search", query)
        self.assertEqual(page["runs"][0]["info"]["run_name"], "run-2")
        page2 = self.call("runs/search", dict(query, page_token=page["next_page_token"]))
        self.assertEqual(page2["runs"][0]["info"]["run_name"], "run-1")
        self.assertNotIn("next_page_token", page2)
        with self.assertRaises(ProtocolError):
            self.call("runs/search", dict(query, filter="", page_token=page["next_page_token"]))
        for expression in ("metrics.loss > 0 OR metrics.loss < 2", "params.p IN ('a')",
                           "attributes.unknown = 'x'", "metrics.loss > 0 AND", "tags.p = 'x'; DROP TABLE runs"):
            with self.subTest(expression=expression), self.assertRaises(ProtocolError):
                self.call("runs/search", {"experiment_ids": [eid], "filter": expression})

    def test_history_pagination_and_update_lifecycle(self):
        for i in range(3):
            self.call("runs/log-metric", {"run_id": self.rid, "key": "x", "value": i, "timestamp": i, "step": i})
        query = {"run_id": self.rid, "metric_key": "x", "max_results": "2"}
        first = self.call("metrics/get-history", query)
        second = self.call("metrics/get-history", dict(query, page_token=first["next_page_token"]))
        self.assertEqual(len(first["metrics"] + second["metrics"]), 3)
        updated = self.call("runs/update", {"run_id": self.rid, "status": "KILLED", "end_time": 456, "run_name": "new"})["run_info"]
        self.assertEqual((updated["start_time"], updated["end_time"], updated["status"], updated["run_name"]), (123, 456, "KILLED", "new"))
        self.call("runs/delete", {"run_id": self.rid})
        with self.assertRaises(ProtocolError):
            self.call("runs/set-tag", {"run_id": self.rid, "key": "x", "value": "no"})
        self.call("runs/restore", {"run_id": self.rid})
        self.assertEqual(self.call("runs/get", {"run_id": self.rid})["run"]["info"]["lifecycle_stage"], "active")


def _sdk_missing():
    if adapter is None:
        return ADAPTER_SKIP
    if importlib.util.find_spec("mlflow") is None:
        return "Official mlflow-skinny SDK is not installed; this is not a conformance run"
    try:
        from nset_compat.context import CompatContext  # noqa: F401
        from nset_compat.gateway import make_server  # noqa: F401
    except ImportError as error:
        return "Shared compatibility gateway is unavailable: " + str(error)
    binary = Path(os.environ.get("NSET_BINARY", ROOT / "target/debug/nset"))
    if not binary.is_file():
        return "Native nset executable missing; set NSET_BINARY (no implicit build)"
    return ""


SDK_SKIP = _sdk_missing()


@unittest.skipIf(bool(SDK_SKIP), SDK_SKIP)
class OfficialMLflowSDKConformanceTests(unittest.TestCase):
    """Real SDK → real gateway → real native durable metric storage."""
    @classmethod
    def setUpClass(cls):
        import mlflow
        from mlflow.tracking import MlflowClient
        from tests.support import Server
        cls.mlflow, cls.Client = mlflow, MlflowClient
        cls.native = Server().start()
        cls.temp = tempfile.TemporaryDirectory(prefix="nset-mlflow-sdk-")
        cls.old_uri = mlflow.get_tracking_uri()
        cls.environment = patch.dict(os.environ, {"MLFLOW_TRACKING_TOKEN": cls.native.token,
                                                   "MLFLOW_ENABLE_ASYNC_LOGGING": "false",
                                                   "MLFLOW_HTTP_REQUEST_MAX_RETRIES": "0"})
        cls.environment.start()
        cls._start_gateway()

    @classmethod
    def _start_gateway(cls):
        from nset_compat.context import CompatContext
        from nset_compat.gateway import make_server
        cls.ctx = CompatContext(cls.native.url, cls.native.token, Path(cls.temp.name), "http://127.0.0.1")
        cls.gateway = make_server(cls.ctx, host="127.0.0.1", port=0)
        cls.ctx.public_url = f"http://127.0.0.1:{cls.gateway.server_address[1]}"
        cls.thread = threading.Thread(target=cls.gateway.serve_forever, daemon=True)
        cls.thread.start()
        cls.mlflow.set_tracking_uri(cls.ctx.public_url)
        cls.client = cls.Client(tracking_uri=cls.ctx.public_url)

    @classmethod
    def _stop_gateway(cls):
        cls.gateway.shutdown()
        cls.gateway.server_close()
        cls.thread.join(timeout=5)
        # CompatContext owns the lifetime directory lock; close before reopening.
        cls.ctx.close()

    @classmethod
    def tearDownClass(cls):
        if cls.mlflow.active_run():
            cls.mlflow.end_run()
        cls._stop_gateway()
        cls.mlflow.set_tracking_uri(cls.old_uri)
        cls.environment.stop()
        cls.native.close()
        cls.temp.cleanup()

    def test_official_fluent_tracking_rejects_upload_search_history_restart(self):
        from requests.exceptions import HTTPError
        from mlflow.entities import Metric, ViewType
        from mlflow.exceptions import MlflowException
        name = "sdk-" + uuid.uuid4().hex
        experiment = self.mlflow.set_experiment(name)
        self.assertTrue(experiment.experiment_id.isdecimal())
        self.assertEqual(self.client.get_experiment("0").name, "Default")
        with self.mlflow.start_run(run_name="official-client") as active:
            rid = active.info.run_id
            self.assertRegex(rid, r"^[0-9a-f]{32}$")
            self.mlflow.log_params({"lr": 0.1, "optimizer": "adam"})
            self.mlflow.log_metrics({"loss": 2.0, "accuracy": 0.5}, step=3)
            self.mlflow.set_tag("mutable", "first")
            self.mlflow.set_tag("mutable", "second")
            artifact = Path(self.temp.name) / "sample.txt"
            artifact.write_bytes(b"official SDK artifact\x00bytes\n")
            requests = Mock(wraps=adapter.handle)
            with patch.dict(os.environ, {"MLFLOW_HTTP_REQUEST_MAX_RETRIES": "3"}), \
                    patch.object(self.gateway, "adapters", [requests]):
                with self.assertRaisesRegex(HTTPError, "MLflow artifact storage is not supported") as rejected:
                    self.mlflow.log_artifact(str(artifact), artifact_path="nested")
            self.assertEqual(rejected.exception.response.status_code, 400)
            self.assertEqual(rejected.exception.response.json()["error_code"], "NOT_IMPLEMENTED")
            uploads = [call.args[1] for call in requests.call_args_list
                       if call.args[1].path.startswith("/api/2.0/mlflow-artifacts")]
            self.assertEqual(len(uploads), 1, "Unsupported uploads must not be retried")
            self.assertEqual(uploads[0].method, "PUT")
            self.assertEqual(list((Path(self.temp.name) / "blobs").rglob("*")), [])
            # A rejected upload does not poison the run or scalar/config logging.
            self.mlflow.log_param("after_upload", "usable")
            self.mlflow.log_metric("after_upload", 3.0)
            self.mlflow.set_tag("after_upload", "usable")
        run = self.client.get_run(rid)
        self.assertEqual(run.info.status, "FINISHED")
        self.assertIsNotNone(run.info.end_time)
        self.assertEqual(run.data.params["optimizer"], "adam")
        self.assertEqual(run.data.tags["mutable"], "second")
        self.assertEqual(run.data.metrics["loss"], 2.0)
        self.assertEqual(run.data.params["after_upload"], "usable")
        self.assertEqual(run.data.metrics["after_upload"], 3.0)
        self.assertEqual(run.data.tags["after_upload"], "usable")
        self.client.log_batch(rid, metrics=[Metric("loss", 8.0, 100, 9), Metric("loss", 7.0, 100, 9), Metric("loss", 99.0, 999, 8)])
        self.client.log_metric(rid, "loss", 8.0, timestamp=100, step=9)
        self.assertEqual(self.client.get_run(rid).data.metrics["loss"], 8.0)
        history = self.client.get_metric_history(rid, "loss")
        self.assertEqual(len(history), 4)
        self.assertIn((8.0, 100, 9), [(m.value, m.timestamp, m.step) for m in history])
        with self.assertRaises(MlflowException):
            self.client.log_param(rid, "optimizer", "sgd")
        self.client.delete_tag(rid, "mutable")
        self.assertNotIn("mutable", self.client.get_run(rid).data.tags)
        found = self.client.search_runs([experiment.experiment_id], "params.optimizer = 'adam' AND metrics.loss >= 8")
        self.assertEqual([r.info.run_id for r in found], [rid])
        self.client.delete_run(rid)
        self.assertEqual(self.client.search_runs([experiment.experiment_id]), [])
        self.assertEqual(self.client.search_runs([experiment.experiment_id], run_view_type=ViewType.DELETED_ONLY)[0].info.run_id, rid)
        self.client.restore_run(rid)
        # Restart native and compatibility context; tracking IDs and scalar data survive.
        self.__class__._stop_gateway()
        self.native.stop()
        self.native.start()
        self.__class__._start_gateway()
        recovered = self.client.get_run(rid)
        self.assertEqual(recovered.data.metrics["loss"], 8.0)
        self.assertEqual(recovered.data.params["optimizer"], "adam")
        self.assertEqual(len(self.client.get_metric_history(rid, "loss")), 4)
        self.client.set_experiment_tag(experiment.experiment_id, "owner", "sdk")
        self.client.rename_experiment(experiment.experiment_id, name + "-renamed")
        self.assertEqual(self.client.get_experiment_by_name(name + "-renamed").tags["owner"], "sdk")
        self.client.delete_experiment_tag(experiment.experiment_id, "owner")
        self.assertNotIn("owner", self.client.get_experiment(experiment.experiment_id).tags)
        self.client.delete_experiment(experiment.experiment_id)
        self.assertEqual(self.client.get_experiment(experiment.experiment_id).lifecycle_stage, "deleted")
        self.client.restore_experiment(experiment.experiment_id)
        self.assertEqual(self.client.get_run(rid).info.lifecycle_stage, "active")

    def test_official_index_commit_crash_bulk_overlap_and_cached_reads_after_restart(self):
        from mlflow.entities import Metric
        from mlflow.exceptions import MlflowException
        name = "indexed-" + uuid.uuid4().hex
        eid = self.client.create_experiment(name)
        exp = self.ctx.state.get(adapter.EXP, eid)
        native_exp = next(e for e in self.ctx.native.request("GET", "/api/experiments")["experiments"]
                          if e["id"] == exp["native_id"])
        self.assertEqual(native_exp["name"], f"mlflow:{eid}:{name}")
        rid = self.client.create_run(eid).info.run_id
        metrics = [Metric("bulk", float(i), i, i) for i in range(1000)]
        original_put = self.ctx.state.put

        def fail_metadata(namespace, key, value):
            if namespace == adapter.RUN and key == rid and "pending" not in value:
                raise ProtocolError(503, "TEMPORARILY_UNAVAILABLE", "injected after index commit")
            original_put(namespace, key, value)

        with patch.object(self.ctx.state, "put", side_effect=fail_metadata), self.assertRaises(MlflowException):
            self.client.log_batch(rid, metrics=metrics)
        stored = self.ctx.state.get(adapter.RUN, rid)
        self.assertIn("pending", stored)
        self.assertEqual(stored["latest_metrics"], {})
        self.assertEqual(len(self.ctx.state.items(adapter._metric_namespace(stored))), 1000)
        self.__class__._stop_gateway()
        self.__class__._start_gateway()
        # Real SQLite persists the index ahead of latest metadata. Recovery must
        # still replay the original pending batch, not silently omit its metrics.
        with patch.object(adapter, "_history", side_effect=AssertionError("indexed read scanned history")):
            self.assertEqual(self.client.get_run(rid).data.metrics["bulk"], 999.0)
            self.client.log_batch(rid, metrics=metrics[100:] + [Metric("bulk", 1000.0, 1000, 1000)])
            self.assertEqual(self.client.get_run(rid).data.metrics["bulk"], 1000.0)
            found = self.client.search_runs([eid], "metrics.bulk = 1000")
            self.assertEqual([r.info.run_id for r in found], [rid])
        stored = self.ctx.state.get(adapter.RUN, rid)
        self.assertNotIn("pending", stored)
        self.assertEqual(len(stored["latest_metrics"]), 1)
        self.assertEqual(len(self.client.get_metric_history(rid, "bulk")), 1001)
        native = self.native.client.http.request("GET", f'/api/runs/{stored["native_id"]}/metrics',
                                                  query={"key": "bulk", "limit": 10000})
        self.assertEqual(len(native["points"]), 1001)
        self.assertEqual(len({(m["step"], m["timestamp"], m["value"]) for m in native["points"]}), 1001)

    def test_surrogate_values_rejected_without_mutation_and_usable_after_restart(self):
        from urllib.error import HTTPError
        from urllib.request import Request as HTTPRequest, urlopen

        eid = self.client.create_experiment("unicode-" + uuid.uuid4().hex)
        runs = []
        metric = {"key": "loss", "value": 2.0, "timestamp": 2, "step": 2}
        for surrogate in ("\ud800", "\udfff"):
            for target in ("parameter", "tag", "batch-param", "batch-tag"):
                with self.subTest(surrogate=repr(surrogate), target=target):
                    rid = self.client.create_run(eid).info.run_id
                    self.client.log_metric(rid, "loss", 1.0, timestamp=1, step=1)
                    stored = self.ctx.state.get(adapter.RUN, rid)
                    namespace = adapter._metric_namespace(stored)
                    index = self.ctx.state.items(namespace)
                    native_path = f'/api/runs/{stored["native_id"]}'
                    native = self.ctx.native.request("GET", native_path)
                    points = self.ctx.native.request("GET", native_path + "/metrics",
                                                     query={"key": "loss", "limit": 100})
                    if target.startswith("batch-"):
                        route = "runs/log-batch"
                        payload = {"run_id": rid, "metrics": [metric],
                                   "params": [{"key": "p", "value": "valid"}],
                                   "tags": [{"key": "t", "value": "valid"}]}
                        field = "params" if target == "batch-param" else "tags"
                        payload[field][0]["value"] = surrogate
                    else:
                        route = "runs/log-parameter" if target == "parameter" else "runs/set-tag"
                        payload = {"run_id": rid, "key": "invalid", "value": surrogate}
                    # Send escaped JSON directly so SDK validation cannot hide the bug.
                    request = HTTPRequest(self.ctx.public_url + adapter.API + route,
                                          data=json.dumps(payload).encode("utf-8"),
                                          headers={"Authorization": "Bearer " + self.native.token,
                                                   "Content-Type": "application/json"})
                    with self.assertRaises(HTTPError) as rejected:
                        with urlopen(request, timeout=10):
                            pass
                    with rejected.exception as response:
                        self.assertEqual(response.code, 400)
                        self.assertEqual(json.load(response)["error_code"], "INVALID_PARAMETER_VALUE")
                    self.assertNotIn("pending", self.ctx.state.get(adapter.RUN, rid))
                    self.assertEqual(self.ctx.state.get(adapter.RUN, rid), stored)
                    self.assertEqual(self.ctx.state.items(namespace), index)
                    self.assertEqual(self.ctx.native.request("GET", native_path), native)
                    self.assertEqual(self.ctx.native.request("GET", native_path + "/metrics",
                                                            query={"key": "loss", "limit": 100}), points)
                    self.assertEqual(self.client.get_run(rid).data.metrics, {"loss": 1.0})
                    runs.append(rid)
        self.__class__._stop_gateway()
        self.native.stop()
        self.native.start()
        self.__class__._start_gateway()
        for rid in runs:
            with self.subTest(restarted_run=rid):
                self.assertNotIn("pending", self.ctx.state.get(adapter.RUN, rid))
                self.assertEqual(self.client.get_run(rid).data.metrics, {"loss": 1.0})
                self.client.log_metric(rid, "loss", 2.0, timestamp=2, step=2)
                # Valid non-ASCII and non-BMP values remain supported.
                self.client.log_param(rid, "p", "caf\u00e9 \U0001f600")
                self.client.set_tag(rid, "t", "\u754c \U0001f600")
                run = self.client.get_run(rid)
                self.assertEqual(run.data.params["p"], "caf\u00e9 \U0001f600")
                self.assertEqual(run.data.tags["t"], "\u754c \U0001f600")
                self.assertEqual(run.data.metrics, {"loss": 2.0})
                self.assertEqual(len(self.client.get_metric_history(rid, "loss")), 2)
                stored = self.ctx.state.get(adapter.RUN, rid)
                self.assertNotIn("pending", stored)
                self.assertEqual(len(self.ctx.state.items(adapter._metric_namespace(stored))), 2)
        self.assertEqual({r.info.run_id for r in self.client.search_runs([eid], "metrics.loss = 2")}, set(runs))

    def test_official_native_outage_recovers_pending_write_after_restart(self):
        from mlflow.exceptions import MlflowException
        eid = self.client.create_experiment("outage-" + uuid.uuid4().hex)
        rid = self.client.create_run(eid).info.run_id
        self.native.stop()
        try:
            with self.assertRaises(MlflowException):
                self.client.log_metric(rid, "recover", 3.5, timestamp=12345, step=7)
            self.assertIn("pending", self.ctx.state.get(adapter.RUN, rid))
        finally:
            self.native.start()
        self.__class__._stop_gateway()
        self.__class__._start_gateway()
        # Reading recovers the durable intent before returning metric state.
        self.assertEqual(self.client.get_run(rid).data.metrics["recover"], 3.5)
        self.client.log_metric(rid, "recover", 3.5, timestamp=12345, step=7)
        history = self.client.get_metric_history(rid, "recover")
        self.assertEqual([(m.value, m.timestamp, m.step) for m in history], [(3.5, 12345, 7)])
        stored = self.ctx.state.get(adapter.RUN, rid)
        native = self.native.client.http.request("GET", f'/api/runs/{stored["native_id"]}/metrics',
                                                  query={"key": "recover", "limit": 100})
        self.assertEqual(len(native["points"]), 1)
        self.assertEqual(native["points"][0]["timestamp"], 12345)

    def test_official_search_pages_rejections_and_run_updates(self):
        from mlflow.exceptions import MlflowException
        eid = self.client.create_experiment("pages-" + uuid.uuid4().hex)
        runs = [self.client.create_run(eid, start_time=i + 1, run_name=f"page-{i}") for i in range(3)]
        first = self.client.search_runs([eid], order_by=["attributes.start_time ASC"], max_results=2)
        second = self.client.search_runs([eid], order_by=["attributes.start_time ASC"], max_results=2, page_token=first.token)
        self.assertEqual([r.info.run_id for r in list(first) + list(second)], [r.info.run_id for r in runs])
        self.client.set_terminated(runs[0].info.run_id, status="KILLED", end_time=1234)
        self.assertEqual(self.client.get_run(runs[0].info.run_id).info.status, "KILLED")
        with self.assertRaises(MlflowException):
            self.client.log_metric(runs[0].info.run_id, "nonfinite", float("nan"), timestamp=1)
        with self.assertRaises(MlflowException):
            self.client.log_metric(runs[0].info.run_id, "negative", 1.0, step=-1, timestamp=1)
        with self.assertRaises(MlflowException):
            self.client.search_runs([eid], "attributes.run_name = 'x' OR attributes.run_name = 'y'")
        experiments = self.client.search_experiments(filter_string="name LIKE 'pages-%'", max_results=1)
        self.assertEqual(experiments[0].experiment_id, eid)


if __name__ == "__main__":
    unittest.main()
