"""Direct Rust MLflow conformance: no Python gateway, adapter, or native client.

Set NSET_BINARY to the built nset executable. Official SDK tests additionally
require mlflow; missing binaries/SDKs are explicit gates, never mock evidence.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import uuid

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("NSET_BINARY", ROOT / "target/debug/nset")).resolve()
HAS_BINARY = BINARY.is_file()
HAS_SDK = importlib.util.find_spec("mlflow") is not None
API = "/api/2.0/mlflow/"


class RustServer:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nset-rust-mlflow-")
        self.directory = Path(self.temp.name)
        self.db = self.directory / "db"
        self.token = "mlflow-test-" + uuid.uuid4().hex
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.process = None
        self.log = None

    def start(self, **environment):
        self.log = open(self.directory / "server.log", "ab")
        self.process = subprocess.Popen(
            [str(BINARY), "serve", "--host", "127.0.0.1", "--port", str(self.port),
             "--token", self.token, "--db-path", str(self.db)],
            stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log,
            env={**os.environ, "NSET_INGEST_PAUSED": "false", **environment},
        )
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError((self.directory / "server.log").read_text(errors="replace"))
            try:
                self.request("GET", "/api/experiments")
                return
            except (OSError, URLError):
                time.sleep(0.05)
        raise RuntimeError("Rust server failed to become ready")

    def stop(self, kill=False):
        if self.process is not None:
            if self.process.poll() is None:
                (self.process.kill if kill else self.process.terminate)()
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
            self.process = None
        if self.log is not None:
            self.log.close()
            self.log = None

    def restart(self, kill=False):
        self.stop(kill=kill)
        self.start()

    def close(self):
        self.stop()
        self.temp.cleanup()

    def request(self, method, path, data=None, query=None):
        if query:
            path += "?" + urlencode(query)
        request = Request(self.url + path,
                          data=None if data is None else json.dumps(data).encode(),
                          method=method,
                          headers={"Authorization": "Bearer " + self.token,
                                   "Content-Type": "application/json"})
        with urlopen(request, timeout=40) as response:
            return json.load(response)

    def call(self, route, data=None, method=None):
        method = method or ("GET" if route in {"experiments/get", "experiments/get-by-name", "runs/get", "metrics/get-history"} else "POST")
        return self.request(method, API + route,
                            data=data if method != "GET" else None,
                            query=data if method == "GET" else None)

    def metadata_table(self, connection):
        # Tests inspect the native database only, never a separately hosted state DB.
        for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table'"):
            columns = {r[1] for r in connection.execute('PRAGMA table_info("' + name.replace('"', '""') + '")')}
            if {"namespace", "key", "value"} <= columns:
                return '"' + name.replace('"', '""') + '"'
        raise AssertionError("native compatibility key/value table not found")

    def stored(self, namespace, key):
        with closing(sqlite3.connect(self.db / "nset.sqlite3")) as conn, conn:
            table = self.metadata_table(conn)
            row = conn.execute(f"SELECT value FROM {table} WHERE namespace=? AND key=?", (namespace, key)).fetchone()
            return json.loads(row[0]) if row else None

    def replace_stored(self, namespace, key, value):
        assert self.process is None, "fault injection requires the server to be stopped"
        with closing(sqlite3.connect(self.db / "nset.sqlite3")) as conn, conn:
            table = self.metadata_table(conn)
            conn.execute(f"UPDATE {table} SET value=? WHERE namespace=? AND key=?", (json.dumps(value), namespace, key))


@unittest.skipUnless(HAS_BINARY, "NSET_BINARY must point to a built Rust nset")
class RustMlflowProtocolTests(unittest.TestCase):
    def setUp(self):
        self.server = RustServer()
        self.addCleanup(self.server.close)
        self.server.start()

    def call(self, route, data=None, method=None):
        return self.server.call(route, data, method)

    def create(self):
        eid = self.call("experiments/create", {"name": "test-" + uuid.uuid4().hex})["experiment_id"]
        rid = self.call("runs/create", {"experiment_id": eid, "run_name": "native-sdk"})["run"]["info"]["run_id"]
        return eid, rid

    def rejects(self, route, payload, status=400, method=None):
        with self.assertRaises(HTTPError) as error:
            self.call(route, payload, method)
        self.assertEqual(error.exception.code, status)
        body = json.load(error.exception)
        self.assertIn("error_code", body)
        self.assertIn("message", body)
        return body

    def test_experiments_lifecycle_names_and_native_config(self):
        self.assertEqual(self.call("experiments/get", {"experiment_id": "0"})["experiment"]["name"], "Default")
        name = "界" * 170
        eid = self.call("experiments/create", {"name": name, "tags": [{"key": "owner", "value": "sdk"}]})["experiment_id"]
        self.assertTrue(eid.isdecimal())
        self.rejects("experiments/create", {"name": name}, 409)
        rid = self.call("runs/create", {"experiment_id": eid, "run_name": "training"})["run"]["info"]["run_id"]
        self.assertRegex(rid, r"^[0-9a-f]{32}$")
        self.call("runs/log-batch", {"run_id": rid, "params": [{"key": "lr", "value": "0.01"}], "tags": [{"key": "owner", "value": "me"}]})
        stored = self.server.stored("mlflow.runs", rid)
        native = self.server.request("GET", "/api/runs/" + stored["native_id"])
        self.assertEqual(native["params"], {"lr": "0.01"})
        self.assertEqual(native["tags"]["owner"], "me")
        exp = self.server.stored("mlflow.experiments", eid)
        native_exp = next(e for e in self.server.request("GET", "/api/experiments")["experiments"] if e["id"] == exp["native_id"])
        self.assertTrue(native_exp["name"].startswith(f"mlflow:{eid}:"))
        self.assertLessEqual(len(native_exp["name"].encode()), 512)
        self.call("experiments/update", {"experiment_id": eid, "new_name": "renamed"})
        self.assertEqual(self.call("experiments/get-by-name", {"experiment_name": "renamed"})["experiment"]["experiment_id"], eid)
        self.call("experiments/delete", {"experiment_id": eid})
        self.assertEqual(self.call("runs/get", {"run_id": rid})["run"]["info"]["lifecycle_stage"], "deleted")
        self.rejects("runs/restore", {"run_id": rid})
        self.call("experiments/restore", {"experiment_id": eid})
        self.assertEqual(self.call("runs/get", {"run_id": rid})["run"]["info"]["lifecycle_stage"], "active")

    def test_dedup_latest_history_pagination_concurrency_restart(self):
        eid, rid = self.create()
        metrics = [{"key": "loss", "value": float(i), "timestamp": i, "step": i} for i in range(1000)]
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: self.call("runs/log-batch", {"run_id": rid, "metrics": metrics}), range(4)))
        self.call("runs/log-batch", {"run_id": rid, "metrics": [
            {"key": "loss", "value": 1001.0, "timestamp": 1000, "step": 1000},
            {"key": "loss", "value": 1000.0, "timestamp": 1000, "step": 1000},
            {"key": "loss", "value": 9999.0, "timestamp": 9999, "step": 998}]})
        result = self.call("runs/get", {"run_uuid": rid})["run"]
        self.assertEqual(result["data"]["metrics"][0]["value"], 1001.0)
        query = {"run_id": rid, "metric_key": "loss", "max_results": 500}
        first = self.call("metrics/get-history", query)
        second = self.call("metrics/get-history", dict(query, page_token=first["next_page_token"]))
        third = self.call("metrics/get-history", dict(query, page_token=second["next_page_token"]))
        self.assertEqual(sum(len(p["metrics"]) for p in [first, second, third]), 1003)
        self.rejects("metrics/get-history", dict(query, metric_key="other", page_token=first["next_page_token"]))
        self.server.restart(kill=True)
        self.assertEqual(self.call("runs/get", {"run_id": rid})["run"], result)
        self.assertEqual(len(self.call("metrics/get-history", dict(query, max_results=2000))["metrics"]), 1003)
        self.assertEqual(self.call("runs/search", {"experiment_ids": [eid], "filter": "metrics.loss >= 1001"})["runs"][0]["info"]["run_id"], rid)

    def test_recovery_replays_pending_even_after_identity_commit(self):
        _, rid = self.create()
        metric = {"key": "recover", "value": 3.5, "timestamp": 12345, "step": 7}
        self.call("runs/log-batch", {"run_id": rid, "metrics": [metric], "params": [{"key": "p", "value": "v"}]})
        # Model death between the durable identity write and final run metadata.
        # Native receipt and identity already exist; replay must retain the original
        # batch, not filter it to an empty or differently identified payload.
        self.server.stop(kill=True)
        run = self.server.stored("mlflow.runs", rid)
        run["latest_metrics"] = {}
        run["params"] = {}
        run["pending"] = {"metrics": [metric], "params": {"p": "v"}, "tags": {},
                          "info": {"status": "FINISHED", "end_time": 99},
                          "patch": {"params": {"p": "v"}, "status": "finished"}}
        self.server.replace_stored("mlflow.runs", rid, run)
        self.server.start()
        got = self.call("runs/get", {"run_id": rid})["run"]
        self.assertEqual(got["data"]["metrics"], [metric])
        self.assertEqual(got["data"]["params"], [{"key": "p", "value": "v"}])
        self.assertEqual(got["info"]["status"], "FINISHED")
        self.assertNotIn("pending", self.server.stored("mlflow.runs", rid))
        self.assertEqual(self.call("metrics/get-history", {"run_id": rid, "metric_key": "recover"})["metrics"], [metric])
        native = self.server.request("GET", "/api/runs/" + run["native_id"] + "/metrics", query={"key": "recover"})
        self.assertEqual(len(native["points"]), 1)
        # Also recover an intent that has never reached ingestion at all.
        self.server.stop()
        run = self.server.stored("mlflow.runs", rid)
        fresh = dict(metric, value=4.5, step=8)
        run["pending"] = {"metrics": [fresh], "params": {}, "tags": {}, "info": {}, "patch": {}}
        self.server.replace_stored("mlflow.runs", rid, run)
        self.server.start()
        self.assertEqual(self.call("runs/get", {"run_id": rid})["run"]["data"]["metrics"], [fresh])
        self.assertEqual(len(self.call("metrics/get-history", {"run_id": rid, "metric_key": "recover"})["metrics"]), 2)

    def test_pending_projection_does_not_block_sibling_run_or_experiment(self):
        eid, blocked = self.create()
        sibling = self.call("runs/create", {"experiment_id": eid})["run"]["info"]["run_id"]
        metric = {"key": "pending", "value": 2.0, "timestamp": 1, "step": 1}
        self.server.stop()
        self.server.start(NSET_INGEST_PAUSED="true")
        pool = ThreadPoolExecutor(max_workers=3)
        pending = pool.submit(self.call, "runs/log-batch", {"run_id": blocked, "metrics": [metric]})
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if self.server.request("GET", "/api/ingest/status")["pending_batches"]:
                    break
                time.sleep(0.02)
            else:
                self.fail("batch never reached the paused native journal")
            self.assertIn("pending", self.server.stored("mlflow.runs", blocked))
            self.assertFalse(pending.done())

            def sibling_operations():
                self.call("runs/log-parameter", {"run_id": sibling, "key": "independent", "value": "yes"})
                self.call("runs/set-tag", {"run_id": sibling, "key": "tag", "value": "yes"})
                self.call("runs/update", {"run_id": sibling, "status": "FINISHED"})
                return self.call("runs/get", {"run_id": sibling})["run"]

            got = pool.submit(sibling_operations).result(timeout=5)
            self.assertEqual(got["info"]["status"], "FINISHED")
            self.assertEqual(got["data"]["params"], [{"key": "independent", "value": "yes"}])
            # The same-run follower must still wait; it must not monopolize an
            # experiment lock while waiting for the first run's sequence lock.
            follower = pool.submit(self.call, "runs/get", {"run_id": blocked})
            time.sleep(0.1)
            self.assertFalse(follower.done())
            pool.submit(self.call, "experiments/delete", {"experiment_id": eid}).result(timeout=5)
            self.assertFalse(pending.done())
            self.assertFalse(follower.done())
            self.assertIn("pending", self.server.stored("mlflow.runs", blocked))
        finally:
            # Deliberately kill outstanding real HTTP calls instead of spending
            # 30 seconds waiting for their projection timeouts on test failures.
            self.server.stop(kill=True)
            pool.shutdown(wait=True)
        self.server.start()
        recovered = self.call("runs/get", {"run_id": blocked})["run"]
        self.assertEqual(recovered["info"]["lifecycle_stage"], "deleted")
        self.assertEqual(recovered["data"]["metrics"], [metric])
        self.assertNotIn("pending", self.server.stored("mlflow.runs", blocked))
        self.assertEqual(self.call("metrics/get-history", {"run_id": blocked, "metric_key": "pending"})["metrics"], [metric])
        self.call("experiments/restore", {"experiment_id": eid})
        self.assertEqual(self.call("runs/get", {"run_id": blocked})["run"]["info"]["lifecycle_stage"], "active")
        self.assertEqual(self.call("runs/get", {"run_id": sibling})["run"]["data"]["params"], got["data"]["params"])

    def test_experiment_creation_intent_survives_native_and_mapping_failures(self):
        self.call("experiments/get", {"experiment_id": "0"})
        for boundary in ("native", "mapping"):
            with self.subTest(boundary=boundary):
                name = "creation-crash-" + boundary + "-" + uuid.uuid4().hex
                payload = {"name": name, "tags": [{"key": "original", "value": "yes"}]}
                self.server.stop()
                with closing(sqlite3.connect(self.server.db / "nset.sqlite3")) as conn, conn:
                    table = self.server.metadata_table(conn)
                    if boundary == "native":
                        trigger = "CREATE TRIGGER reject_creation BEFORE INSERT ON experiments BEGIN SELECT RAISE(ABORT, 'test native failure'); END"
                    else:
                        trigger = f"CREATE TRIGGER reject_creation BEFORE INSERT ON {table} WHEN NEW.namespace='mlflow.experiments' AND NEW.key<>'0' BEGIN SELECT RAISE(ABORT, 'test mapping failure'); END"
                    conn.execute(trigger)
                self.server.start()
                self.rejects("experiments/create", payload, status=500)
                intent = self.server.stored("mlflow.experiment-create-intents.rust-v1", name)
                self.assertIsNotNone(intent)
                eid = intent["experiment_id"]
                self.assertIsNone(self.server.stored("mlflow.experiments", eid))
                native_name = f"mlflow:{eid}:{name}"
                native_before = [e for e in self.server.request("GET", "/api/experiments")["experiments"] if e["name"] == native_name]
                self.assertEqual(len(native_before), int(boundary == "mapping"))
                # The durable reservation also prevents a rename stealing the
                # name between the failed creation and its recovery.
                self.rejects("experiments/update", {"experiment_id": "0", "new_name": name}, status=409)
                self.server.stop(kill=True)
                with closing(sqlite3.connect(self.server.db / "nset.sqlite3")) as conn, conn:
                    conn.execute("DROP TRIGGER reject_creation")
                self.server.start()
                self.assertEqual(self.call("experiments/create", payload)["experiment_id"], eid)
                exp = self.call("experiments/get", {"experiment_id": eid})["experiment"]
                self.assertEqual(exp["creation_time"], intent["creation_time"])
                self.assertEqual(exp["tags"], payload["tags"])
                native_after = [e for e in self.server.request("GET", "/api/experiments")["experiments"] if e["name"] == native_name]
                self.assertEqual(len(native_after), 1)
                if native_before:
                    self.assertEqual(native_after[0]["id"], native_before[0]["id"])
                self.assertIsNone(self.server.stored("mlflow.experiment-create-intents.rust-v1", name))
                self.rejects("experiments/create", payload, status=409)

    def test_strict_validation_is_atomic_and_stays_usable(self):
        _, rid = self.create()
        self.call("runs/log-parameter", {"run_id": rid, "key": "p", "value": "original"})
        before = self.call("runs/get", {"run_id": rid})
        valid = {"key": "loss", "value": 1.0, "timestamp": 1, "step": 1}
        invalid_metrics = [dict(valid, value=-0.0), dict(valid, value=True), dict(valid, value="NaN"),
                           dict(valid, step=-1), dict(valid, timestamp=9007199254740992),
                           dict(valid, step=1.5), dict(valid, dataset_name="dataset"), dict(valid, model_id="m"),
                           dict(valid, key=""), dict(valid, key="x\0y"), dict(valid, run_id="f" * 32)]
        for metric in invalid_metrics:
            with self.subTest(metric=metric):
                self.rejects("runs/log-batch", {"run_id": rid, "metrics": [valid, metric], "params": [{"key": "new", "value": "no"}]})
                self.assertEqual(self.call("runs/get", {"run_id": rid}), before)
        self.rejects("runs/log-batch", {"run_id": rid, "metrics": [valid], "params": [{"key": "p", "value": "changed"}]})
        for surrogate in ["\ud800", "\udfff"]:
            self.rejects("runs/log-batch", {"run_id": rid, "metrics": [valid], "tags": [{"key": "tag", "value": surrogate}]})
        self.assertEqual(self.call("runs/get", {"run_id": rid}), before)
        self.assertNotIn("pending", self.server.stored("mlflow.runs", rid))
        self.call("runs/log-batch", {"run_id": rid, "metrics": [valid], "params": [{"key": "unicode", "value": "café 😀"}]})
        self.server.restart()
        self.assertEqual(self.call("runs/get", {"run_id": rid})["run"]["data"]["metrics"], [valid])

    def test_search_filters_orders_pages_tags_and_status(self):
        eid, _ = self.create()
        ids = []
        for i in range(3):
            rid = self.call("runs/create", {"experiment_id": eid, "run_name": f"page-{i}", "start_time": i + 1})["run"]["info"]["run_id"]
            ids.append(rid)
            self.call("runs/log-batch", {"run_id": rid, "params": [{"key": "optimizer", "value": "adam"}], "tags": [{"key": "group space", "value": "A'b"}]})
        query = {"experiment_ids": [eid], "filter": "params.optimizer = 'adam' AND tags.`group space` ILIKE 'a''%'", "order_by": ["attributes.start_time ASC"], "max_results": 2}
        first = self.call("runs/search", query)
        second = self.call("runs/search", dict(query, page_token=first["next_page_token"]))
        self.assertEqual([r["info"]["run_id"] for r in first["runs"] + second["runs"]], ids)
        for expression in ["params.optimizer = 'adam' OR status = 'RUNNING'", "metrics.loss = '1'", "params.optimizer > 'adam'", "status = 'RUNNING' AND", "status = 'RUNNING' trailing"]:
            self.rejects("runs/search", dict(query, filter=expression))
        self.rejects("runs/search", dict(query, max_results=1, page_token=first["next_page_token"]))
        self.call("runs/update", {"run_id": ids[0], "status": "KILLED", "end_time": 1234, "run_name": "renamed"})
        info = self.call("runs/get", {"run_id": ids[0]})["run"]["info"]
        self.assertEqual((info["status"], info["end_time"], info["run_name"]), ("KILLED", 1234, "renamed"))
        self.call("runs/delete-tag", {"run_id": ids[0], "key": "group space"})
        self.call("runs/delete", {"run_id": ids[0]})
        self.assertEqual(self.call("runs/search", {"experiment_ids": [eid], "run_view_type": "DELETED_ONLY"})["runs"][0]["info"]["run_id"], ids[0])
        self.call("runs/restore", {"run_id": ids[0]})

    def test_unsupported_artifacts_models_routes_fail_closed(self):
        _, rid = self.create()
        self.rejects("experiments/create", {"name": "unsupported", "artifact_location": "file:///tmp/nope"})
        for route in ["artifacts/list", "logged-models/search", "runs/log-inputs", "unknown"]:
            self.rejects(route, {"run_id": rid})
        for method in ["GET", "PUT", "POST", "DELETE"]:
            with self.assertRaises(HTTPError) as error:
                self.server.request(method, "/api/2.0/mlflow-artifacts/artifacts/unsupported/test", {} if method != "GET" else None)
            self.assertEqual(error.exception.code, 400)
        self.call("runs/log-parameter", {"run_id": rid, "key": "after", "value": "usable"})


@unittest.skipUnless(HAS_BINARY and HAS_SDK, "Requires NSET_BINARY and the official mlflow SDK")
class OfficialMlflowSDKTests(unittest.TestCase):
    def setUp(self):
        import mlflow
        from mlflow import MlflowClient
        self.mlflow = mlflow
        self.server = RustServer()
        self.addCleanup(self.server.close)
        self.server.start()
        self.environment = patch.dict(os.environ, {"MLFLOW_TRACKING_TOKEN": self.server.token,
                                                   "MLFLOW_HTTP_REQUEST_MAX_RETRIES": "0",
                                                   "MLFLOW_ENABLE_ASYNC_LOGGING": "false"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        old_uri = mlflow.get_tracking_uri()
        mlflow.set_tracking_uri(self.server.url)
        self.addCleanup(mlflow.set_tracking_uri, old_uri)
        self.addCleanup(lambda: mlflow.end_run() if mlflow.active_run() else None)
        self.client = MlflowClient(tracking_uri=self.server.url)

    def test_official_fluent_tracking_search_history_restart_and_artifact_rejection(self):
        from mlflow.entities import Metric, ViewType
        from mlflow.exceptions import MlflowException
        from requests.exceptions import HTTPError as RequestsHTTPError
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
            artifact = self.server.directory / "sample.txt"
            artifact.write_bytes(b"unsupported SDK artifact\x00bytes\n")
            with self.assertRaises((RequestsHTTPError, MlflowException)):
                self.mlflow.log_artifact(str(artifact), artifact_path="nested")
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
        self.assertEqual(len(self.client.get_metric_history(rid, "loss")), 4)
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
        self.server.restart(kill=True)
        self.assertEqual(self.client.get_run(rid).data.metrics["loss"], 8.0)
        self.assertEqual(len(self.client.get_metric_history(rid, "loss")), 4)
        self.client.set_experiment_tag(experiment.experiment_id, "owner", "sdk")
        self.client.rename_experiment(experiment.experiment_id, name + "-renamed")
        self.assertEqual(self.client.get_experiment_by_name(name + "-renamed").tags["owner"], "sdk")
        self.client.delete_experiment_tag(experiment.experiment_id, "owner")
        self.assertNotIn("owner", self.client.get_experiment(experiment.experiment_id).tags)
        self.client.delete_experiment(experiment.experiment_id)
        self.assertEqual(self.client.get_run(rid).info.lifecycle_stage, "deleted")
        self.client.restore_experiment(experiment.experiment_id)
        self.assertEqual(self.client.get_run(rid).info.lifecycle_stage, "active")

    def test_official_search_pages_rejections_and_run_updates(self):
        from mlflow.exceptions import MlflowException
        eid = self.client.create_experiment("pages-" + uuid.uuid4().hex)
        runs = [self.client.create_run(eid, start_time=i + 1, run_name=f"page-{i}") for i in range(3)]
        first = self.client.search_runs([eid], order_by=["attributes.start_time ASC"], max_results=2)
        second = self.client.search_runs([eid], order_by=["attributes.start_time ASC"], max_results=2, page_token=first.token)
        self.assertEqual([r.info.run_id for r in list(first) + list(second)], [r.info.run_id for r in runs])
        self.client.set_terminated(runs[0].info.run_id, status="KILLED", end_time=1234)
        self.assertEqual(self.client.get_run(runs[0].info.run_id).info.status, "KILLED")
        for value in [float("nan"), float("inf"), -0.0]:
            with self.assertRaises(MlflowException):
                self.client.log_metric(runs[0].info.run_id, "nonfinite", value, timestamp=1)
        with self.assertRaises(MlflowException):
            self.client.log_metric(runs[0].info.run_id, "negative", 1.0, step=-1, timestamp=1)
        with self.assertRaises(MlflowException):
            self.client.search_runs([eid], "attributes.run_name = 'x' OR attributes.run_name = 'y'")
        experiments = self.client.search_experiments(filter_string="name LIKE 'pages-%'", max_results=1)
        self.assertEqual(experiments[0].experiment_id, eid)

    def test_official_bulk_overlap_restart_and_native_projection(self):
        from mlflow.entities import Metric
        eid = self.client.create_experiment("bulk-" + uuid.uuid4().hex)
        rid = self.client.create_run(eid).info.run_id
        metrics = [Metric("bulk", float(i), i, i) for i in range(1000)]
        self.client.log_batch(rid, metrics=metrics)
        self.server.restart(kill=True)
        self.client.log_batch(rid, metrics=metrics[100:] + [Metric("bulk", 1000.0, 1000, 1000)])
        self.assertEqual(self.client.get_run(rid).data.metrics["bulk"], 1000.0)
        self.assertEqual(len(self.client.get_metric_history(rid, "bulk")), 1001)
        stored = self.server.stored("mlflow.runs", rid)
        native = self.server.request("GET", "/api/runs/" + stored["native_id"] + "/metrics", query={"key": "bulk", "limit": 10000})
        self.assertEqual(len(native["points"]), 1001)
        self.assertEqual(len({(m["step"], m["timestamp"], m["value"]) for m in native["points"]}), 1001)


if __name__ == "__main__":
    unittest.main()
