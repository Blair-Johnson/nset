"""Direct Rust same-listener boundary tests; no Python HTTP server or gateway."""
import base64
from contextlib import closing
import concurrent.futures
import gzip
import http.client
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import time
import unittest
from unittest.mock import patch

from support import Server


class CompatibilityBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.server = Server().start()
        self.addCleanup(self.server.close)

    def request(self, path, body=None, method="POST", auth=True, headers=None, raw=None):
        headers = dict(headers or {})
        if auth:
            headers.setdefault("Authorization", "Bearer " + self.server.token)
        if raw is None and body is not None:
            raw = json.dumps(body).encode()
        if raw is not None:
            headers.setdefault("Content-Type", "application/json")
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=40)
        try:
            connection.request(method, path, body=raw, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_same_origin_ui_native_mlflow_wandb(self):
        status, headers, body = self.request("/", method="GET", auth=False)
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["content-type"])
        self.assertIn(b"<html", body)
        self.assertEqual(self.request("/api/health", method="GET")[0], 200)
        status, _, raw = self.request("/api/2.0/mlflow/experiments/create", {"name": "same-port"})
        self.assertEqual(status, 200, raw)
        status, _, raw = self.request("/graphql", {"query": "query { viewer { id username } }"})
        self.assertEqual(status, 200, raw)
        self.assertIsInstance(json.loads(raw)["data"]["viewer"], dict)

    def test_unauthorized_before_invalid_body(self):
        for path in ("/graphql", "/api/2.0/mlflow/runs/create", "/files/e/p/r/file_stream"):
            with self.subTest(path=path):
                status, _, raw = self.request(path, auth=False, raw=b"{broken", headers={"Content-Encoding": "nonsense"})
                self.assertEqual(status, 401, raw)
                self.assertNotIn(b"<html", raw)

    def test_basic_api_token_only_on_compat(self):
        basic = "Basic " + base64.b64encode(("api:" + self.server.token).encode()).decode()
        headers = {"Authorization": basic}
        self.assertEqual(self.request("/graphql", {"query": "{ viewer { id } }"}, headers=headers)[0], 200)
        self.assertEqual(self.request("/api/health", method="GET", headers=headers)[0], 401)
        for candidate in ("Basic !!!", "Basic " + base64.b64encode(("user:" + self.server.token).encode()).decode(), "Bearer wrong"):
            self.assertEqual(self.request("/graphql", {}, headers={"Authorization": candidate})[0], 401)

    def test_duplicate_authorization_rejected(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=5)
        try:
            connection.putrequest("POST", "/graphql")
            connection.putheader("Authorization", "Bearer " + self.server.token)
            connection.putheader("Authorization", "Bearer " + self.server.token)
            connection.putheader("Content-Length", "2")
            connection.endheaders(b"{}")
            response = connection.getresponse()
            self.assertEqual(response.status, 401)
            response.read()
        finally:
            connection.close()

    def test_reserved_unknown_and_artifact_paths_are_json_errors(self):
        before = self.server.client.http.request("GET", "/api/catalog")
        for path in ("/api/2.0/mlflow/unknown", "/api/2.0/mlflow/artifacts/list", "/api/2.0/mlflow-artifacts/artifacts/x", "/files/e/p/r/metadata.json", "/files/e/p/r/file", "/artifacts/x", "/ajax-api/2.0/mlflow/artifacts/get", "/compat/missing", "/wandb/missing", "/graphql/unknown"):
            with self.subTest(path=path):
                status, headers, raw = self.request(path, {})
                self.assertEqual(status, 400, raw)
                self.assertIn("application/json", headers["content-type"])
                self.assertNotIn(b"<html", raw)
        self.assertEqual(before, self.server.client.http.request("GET", "/api/catalog"))
        root = self.server.directory / "data"
        self.assertFalse((root / "artifacts").exists())
        self.assertFalse((root / "blobs").exists())
        self.assertFalse((root / "compat.sqlite3").exists())

    def test_create_run_files_is_explicit_nonretryable(self):
        status, _, raw = self.request("/graphql", {"query": 'mutation { createRunFiles(input:{entityName:"e",projectName:"p",runName:"r",files:["wandb-metadata.json"]}) { files { uploadUrl } } }'})
        self.assertEqual(status, 400, raw)
        self.assertIn("errors", json.loads(raw))
        self.assertNotIn(b"uploadUrl", raw)

    def test_gzip_and_concatenated_members(self):
        body = json.dumps({"query": "{ viewer { id } }"}).encode()
        for compressed in (gzip.compress(body), gzip.compress(body[:10]) + gzip.compress(body[10:])):
            status, _, raw = self.request("/graphql", raw=compressed, headers={"Content-Encoding": "gzip"})
            self.assertEqual(status, 200, raw)

    def test_bad_gzip_encoding_and_json(self):
        cases = [(b"bad", {"Content-Encoding": "gzip"}), (b"{}", {"Content-Encoding": "br"}), (b"{", {}), (b"[]", {})]
        for body, headers in cases:
            self.assertEqual(self.request("/graphql", raw=body, headers=headers)[0], 400)

    def test_compressed_and_decoded_body_limits(self):
        size = 32 * 1024 * 1024 + 1
        self.assertEqual(self.request("/graphql", raw=b" " * size)[0], 413)
        bomb = gzip.compress(b" " * size)
        self.assertEqual(self.request("/graphql", raw=bomb, headers={"Content-Encoding": "gzip"})[0], 413)
        # A second gzip member cannot bypass the uncompressed cap.
        body = gzip.compress(b" " * (size // 2)) * 3
        self.assertEqual(self.request("/graphql", raw=body, headers={"Content-Encoding": "gzip"})[0], 413)

    def test_graphql_variable_expansion_is_bounded(self):
        query = "query($v:String) { " + " ".join(f"a{i}:__type(name:$v) {{ name }}" for i in range(80)) + " }"
        status, _, raw = self.request("/graphql", {"query": query, "variables": {"v": "x" * (512 * 1024)}})
        self.assertEqual(status, 400, raw[:200])
        self.assertEqual(self.request("/api/health", method="GET")[0], 200)

    def test_graphql_response_alias_expansion_is_bounded(self):
        query = 'mutation { upsertBucket(input:{name:"bounded",modelName:"p",entityName:"e"}) { bucket { id } } }'
        self.assertEqual(self.request("/graphql", {"query": query})[0], 200)
        summary = json.dumps({"note": "x" * (512 * 1024)})
        status, _, raw = self.request("/files/e/p/bounded/file_stream", {"files": {"wandb-summary.json": {"offset": 0, "content": [summary]}}})
        self.assertEqual(status, 200, raw)
        query = '{ model(name:"p",entityName:"e") { bucket(name:"bounded") { ' + " ".join(f"a{i}:summaryMetrics" for i in range(80)) + " } } }"
        status, _, raw = self.request("/graphql", {"query": query})
        self.assertEqual(status, 400, raw[:200])
        self.assertEqual(self.request("/api/health", method="GET")[0], 200)

    def test_storage_root_rejects_second_server(self):
        env = dict(os.environ, NSET_TOKEN=self.server.token)
        result = subprocess.run([str(self.server.binary), "serve", "--port", "0", "--db-path", str(self.server.directory / "data")], env=env, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"already owned", result.stderr)
        self.assertEqual(self.request("/api/health", method="GET")[0], 200)

    def test_shutdown_drains_disconnected_write_before_releasing_root(self):
        self.server.stop()
        with patch.dict(os.environ, {"NSET_WRITE_CONCURRENCY": "1"}):
            self.server.start()
        status, _, raw = self.request("/api/2.0/mlflow/experiments/create", {"name": "shutdown"})
        self.assertEqual(status, 200, raw)
        eid = json.loads(raw)["experiment_id"]
        status, _, raw = self.request("/api/2.0/mlflow/runs/create", {"experiment_id": eid, "start_time": 100})
        self.assertEqual(status, 200, raw)
        rid = json.loads(raw)["run"]["info"]["run_id"]
        root = self.server.directory / "data"
        with closing(sqlite3.connect(root / "nset.sqlite3")) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                payload = json.dumps({"run_id": rid, "params": [{"key": "shutdown", "value": "committed"}]}).encode()
                with socket.create_connection(("127.0.0.1", self.server.port), timeout=5) as lost:
                    header = ("POST /api/2.0/mlflow/runs/log-batch HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer " + self.server.token + "\r\nContent-Type: application/json\r\nContent-Length: " + str(len(payload)) + "\r\n\r\n")
                    lost.sendall(header.encode() + payload)
                    for _ in range(50):
                        if self.request("/graphql", {})[0] == 503:
                            break
                        time.sleep(0.01)
                    else:
                        self.fail("write was not admitted")
                self.assertEqual(self.request("/graphql", {})[0], 503)
                self.server.process.terminate()
                time.sleep(0.1)
                self.assertIsNone(self.server.process.poll(), "shutdown returned with an accepted actor write still blocked")
                result = subprocess.run([str(self.server.binary), "serve", "--port", "0", "--db-path", str(root)], env=dict(os.environ, NSET_TOKEN=self.server.token), capture_output=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b"already owned", result.stderr)
            finally:
                connection.rollback()
        self.server.process.wait(timeout=10)
        self.assertEqual(self.server.process.returncode, 0)
        self.server.stop()
        self.server.start()
        runs = self.server.client.http.request("GET", "/api/runs")["runs"]
        self.assertEqual(runs[0]["params"]["shutdown"], "committed")

    def test_compat_state_and_native_data_share_database(self):
        status, _, raw = self.request("/api/2.0/mlflow/experiments/create", {"name": "storage"})
        self.assertEqual(status, 200, raw)
        eid = json.loads(raw)["experiment_id"]
        status, _, raw = self.request("/api/2.0/mlflow/runs/create", {"experiment_id": eid, "start_time": 100})
        self.assertEqual(status, 200, raw)
        root = self.server.directory / "data"
        self.assertEqual(sorted(p.name for p in root.glob("*.sqlite3")), ["ingest.sqlite3", "nset.sqlite3"])
        with closing(sqlite3.connect(root / "nset.sqlite3")) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue(any("compat" in name for name in tables), tables)

    def test_concurrent_metric_replay(self):
        status, _, raw = self.request("/api/2.0/mlflow/experiments/create", {"name": "concurrent"})
        self.assertEqual(status, 200, raw)
        eid = json.loads(raw)["experiment_id"]
        status, _, raw = self.request("/api/2.0/mlflow/runs/create", {"experiment_id": eid, "start_time": 100})
        self.assertEqual(status, 200, raw)
        run_id = json.loads(raw)["run"]["info"]["run_id"]
        payload = {"run_id": run_id, "metrics": [{"key": "loss", "value": 0.125, "step": 1, "timestamp": 1000}], "params": [], "tags": []}
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.request("/api/2.0/mlflow/runs/log-batch", payload), range(4)))
        for status, _, raw in results:
            self.assertEqual(status, 200, raw)
        status, _, raw = self.request("/api/2.0/mlflow/metrics/get-history?run_id=" + run_id + "&metric_key=loss", method="GET")
        self.assertEqual(status, 200, raw)
        self.assertEqual(len(json.loads(raw)["metrics"]), 1)

    def test_auth_precedes_shared_write_admission(self):
        self.server.stop()
        old = os.environ.get("NSET_WRITE_CONCURRENCY")
        os.environ["NSET_WRITE_CONCURRENCY"] = "1"
        try:
            self.server.start()
        finally:
            if old is None:
                os.environ.pop("NSET_WRITE_CONCURRENCY", None)
            else:
                os.environ["NSET_WRITE_CONCURRENCY"] = old
        stalled = socket.create_connection(("127.0.0.1", self.server.port), timeout=5)
        self.addCleanup(stalled.close)
        stalled.sendall(("POST /graphql HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer " + self.server.token + "\r\nContent-Length: 100\r\nContent-Type: application/json\r\n\r\n{").encode())
        for _ in range(30):
            if self.request("/graphql", {})[0] == 503:
                break
            time.sleep(0.02)
        else:
            self.fail("stalled request did not hold admission")
        self.assertEqual(self.request("/graphql", auth=False, raw=b"invalid")[0], 401)
        self.assertEqual(self.request("/api/experiments", {"name": "busy"})[0], 503)
        stalled.close()


if __name__ == "__main__":
    unittest.main()
