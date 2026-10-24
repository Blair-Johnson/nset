"""MLflow protocol units plus real official-SDK/native-server conformance.

Run with PYTHONPATH=python and NSET_BINARY pointing to a durable-ingest nset.
An isolated adapter worktree may set NSET_COMPAT_SHARED_PATH to the gateway
worker's python directory. That is a test-only package-path overlay, not a mock.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
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
        self.metrics = {}
        self.receipts = {}
        self.calls = []
        self.fail_after_commit = False

    def request(self, method, path, payload=None, *, query=None):
        if method == "POST":
            value = dict(payload, id=str(uuid.uuid4()))
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
        if hasattr(cls.ctx, "close"):
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

    def test_official_fluent_tracking_artifacts_search_history_restart(self):
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
            self.mlflow.log_artifact(str(artifact), artifact_path="nested")
        run = self.client.get_run(rid)
        self.assertEqual(run.info.status, "FINISHED")
        self.assertIsNotNone(run.info.end_time)
        self.assertEqual(run.data.params["optimizer"], "adam")
        self.assertEqual(run.data.tags["mutable"], "second")
        self.assertEqual(run.data.metrics["loss"], 2.0)
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
        self.assertEqual(self.client.list_artifacts(rid)[0].path, "nested")
        self.assertEqual(self.client.list_artifacts(rid, "nested")[0].path, "nested/sample.txt")
        destination = Path(self.temp.name) / "downloads"
        destination.mkdir()
        downloaded = self.client.download_artifacts(rid, "nested/sample.txt", str(destination))
        self.assertEqual(Path(downloaded).read_bytes(), artifact.read_bytes())
        self.client.delete_run(rid)
        self.assertEqual(self.client.search_runs([experiment.experiment_id]), [])
        self.assertEqual(self.client.search_runs([experiment.experiment_id], run_view_type=ViewType.DELETED_ONLY)[0].info.run_id, rid)
        self.client.restore_run(rid)
        # Restart native and compatibility context; IDs, metric data and artifact bytes survive.
        self.__class__._stop_gateway()
        self.native.stop()
        self.native.start()
        self.__class__._start_gateway()
        recovered = self.client.get_run(rid)
        self.assertEqual(recovered.data.metrics["loss"], 8.0)
        self.assertEqual(recovered.data.params["optimizer"], "adam")
        self.assertEqual(len(self.client.get_metric_history(rid, "loss")), 4)
        destination2 = Path(self.temp.name) / "downloads-restart"
        destination2.mkdir()
        downloaded = self.client.download_artifacts(rid, "nested/sample.txt", str(destination2))
        self.assertEqual(Path(downloaded).read_bytes(), artifact.read_bytes())
        self.client.set_experiment_tag(experiment.experiment_id, "owner", "sdk")
        self.client.rename_experiment(experiment.experiment_id, name + "-renamed")
        self.assertEqual(self.client.get_experiment_by_name(name + "-renamed").tags["owner"], "sdk")
        self.client.delete_experiment_tag(experiment.experiment_id, "owner")
        self.assertNotIn("owner", self.client.get_experiment(experiment.experiment_id).tags)
        self.client.delete_experiment(experiment.experiment_id)
        self.assertEqual(self.client.get_experiment(experiment.experiment_id).lifecycle_stage, "deleted")
        self.client.restore_experiment(experiment.experiment_id)
        self.assertEqual(self.client.get_run(rid).info.lifecycle_stage, "active")

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
