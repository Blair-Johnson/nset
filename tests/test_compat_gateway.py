"""Gateway unit/HTTP tests against fakes, NOT official SDK conformance tests."""
import base64
from concurrent.futures import ThreadPoolExecutor
import gzip
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import select
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qsl, urlsplit

from nset_client.transport import APIError
from nset_compat import CompatContext, ProtocolError, Request, Response, make_server
from nset_compat.context import State
from nset_compat.gateway import _load_adapters


TOKEN = "gateway-secret"


class FakeNative:
    def __init__(self):
        self.calls = []
        self.receipts = {}
        self.apply = True
        self.reject = None

    def request(self, method, path, payload=None, **kwargs):
        self.calls.append((method, path, payload))
        if self.reject:
            raise self.reject
        run_id, batch_id = path.split("/")[-3], path.split("/")[-1]
        if method == "PUT":
            self.receipts.setdefault(path, {"batch_id": batch_id, "run_id": run_id,
                                            "state": "pending", "accepted": len(payload["metrics"]), "accepted_at": 123})
        else:
            if self.apply:
                self.receipts[path]["state"] = "applied"
        return dict(self.receipts[path])


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.ctx = CompatContext("http://127.0.0.1:1", TOKEN, self.temp.name, "http://localhost:5000")
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.ctx.close)

    def test_request_json_and_header_normalization(self):
        self.assertEqual(Request("POST", "/", headers={"Content-Type": "x"}, body=b'{"x":1}').json(), {"x": 1})
        self.assertEqual(Request("GET", "/", headers={"AUTHORIZATION": "x"}).headers, {"authorization": "x"})
        for body in (b"", b"[]", b"null", b'{"x": NaN}', b'\xff'):
            with self.subTest(body=body), self.assertRaises(ProtocolError):
                Request("POST", "/", body=body).json()

    def test_state_full_wal_and_restart(self):
        state = self.ctx.state
        self.assertEqual(state._db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
        self.assertEqual(state._db.execute("PRAGMA synchronous").fetchone()[0], 2)
        state.put("mlflow:test", "key", {"values": [1, "x"]})
        self.assertEqual(state.next_id("mlflow:ids", start=5), 5)
        second = State(Path(self.temp.name) / "compat.sqlite3")
        try:
            self.assertEqual(second.get("mlflow:test", "key"), {"values": [1, "x"]})
            self.assertEqual(second.next_id("mlflow:ids"), 6)
            second.delete("mlflow:test", "key")
            self.assertEqual(state.items("mlflow:test"), [])
            self.assertEqual(state.get("mlflow:test", "key", "default"), "default")
        finally:
            second.close()

    def test_concurrent_sequence_and_per_key_atomicity(self):
        other = State(Path(self.temp.name) / "compat.sqlite3")
        try:
            with ThreadPoolExecutor(max_workers=12) as pool:
                ids = list(pool.map(lambda i: (self.ctx.state if i % 2 else other).next_id("wandb:ids"), range(100)))
            self.assertEqual(sorted(ids), list(range(1, 101)))
            def increment(_):
                with self.ctx.lock_for("counter"):
                    self.ctx.state.put("test", "counter", self.ctx.state.get("test", "counter", 0) + 1)
            with ThreadPoolExecutor(max_workers=12) as pool:
                list(pool.map(increment, range(100)))
            self.assertEqual(self.ctx.state.get("test", "counter"), 100)
            with self.ctx.lock_for("reentrant"):
                with self.ctx.lock_for("reentrant"):
                    pass
        finally:
            other.close()

    def reopen_context(self, *, native_url="http://127.0.0.1:1", token=TOKEN, public_url="http://localhost:5000"):
        ctx = CompatContext(native_url, token, self.temp.name, public_url)
        self.addCleanup(ctx.close)
        return ctx

    @unittest.skipUnless(hasattr(sqlite3.Connection, "setlimit"), "SQLite runtime limit API requires Python 3.11+")
    def test_state_bulk_indexed_reads_obey_sql_variable_limit(self):
        state = self.ctx.state
        values = {str(i): {"value": i} for i in range(2000)}
        values["null"] = None
        self.assertIsNone(state.put_many("bulk", values))
        state.put("other", "0", "wrong namespace")
        old_limit = state._db.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 17)
        statements = []
        state._db.set_trace_callback(statements.append)
        try:
            self.assertEqual(state.get_many("bulk", [*values, "missing", "0"]), values)
            selects = [sql for sql in statements if sql.startswith("SELECT")]
            self.assertEqual(len(selects), (len(values) + 1 + 15) // 16)
            self.assertTrue(all("key IN (" in sql and "namespace=" in sql for sql in selects))
            statements.clear()
            self.assertEqual(state.get_many("bulk", []), {})
            self.assertIsNone(state.put_many("bulk", {}))
            self.assertEqual(statements, [])
        finally:
            state._db.set_trace_callback(None)
            state._db.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, old_limit)

    def test_state_bulk_validation_precedes_any_mutation(self):
        state = self.ctx.state
        state.put_many("bulk", {"old": 1, "keep": 2})
        circular = []
        circular.append(circular)
        for bad in (float("nan"), float("inf"), object(), circular):
            statements = []
            state._db.set_trace_callback(statements.append)
            try:
                with self.assertRaises((TypeError, ValueError, RecursionError)):
                    state.put_many("bulk", {"old": 3, "new": "new", "bad": bad})
                self.assertEqual(statements, [])
            finally:
                state._db.set_trace_callback(None)
            self.assertEqual(state.get_many("bulk", ["old", "keep", "new", "bad"]), {"old": 1, "keep": 2})
        for call in (lambda: state.put_many("bulk", {"old": 3, 1: 4}),
                     lambda: state.put_many(None, {}),
                     lambda: state.get_many("bulk", ["old", 1]),
                     lambda: state.get_many(None, [])):
            with self.assertRaises(TypeError):
                call()
        self.assertEqual(state.get("bulk", "old"), 1)

    def test_state_bulk_rolls_back_database_failure(self):
        state = self.ctx.state
        state.put("bulk", "old", 1)
        state._db.execute("CREATE TRIGGER fail_bulk BEFORE INSERT ON kv WHEN NEW.key='fail' "
                          "BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            state.put_many("bulk", {"old": 2, "new": 3, "fail": 4})
        self.assertFalse(state._db.in_transaction)
        self.assertEqual(state.get_many("bulk", ["old", "new", "fail"]), {"old": 1})
        state.put_many("bulk", {"old": 5, "new": 6})
        self.assertEqual(state.get_many("bulk", ["old", "new"]), {"old": 5, "new": 6})

    @unittest.skipUnless(hasattr(sqlite3.Connection, "setlimit"), "SQLite runtime limit API requires Python 3.11+")
    def test_state_bulk_reads_share_one_snapshot(self):
        state = self.ctx.state
        other = State(Path(self.temp.name) / "compat.sqlite3")
        self.addCleanup(other.close)
        values = {str(i): 0 for i in range(8)}
        state.put_many("bulk", values)
        old_limit = state._db.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 5)
        selects = []
        def write_between_chunks(sql):
            if sql.startswith("SELECT"):
                selects.append(sql)
                if len(selects) == 2:
                    other.put_many("bulk", dict.fromkeys(values, 1))
        state._db.set_trace_callback(write_between_chunks)
        try:
            self.assertEqual(state.get_many("bulk", values), values)
        finally:
            state._db.set_trace_callback(None)
            state._db.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, old_limit)
        self.assertEqual(len(selects), 2)
        self.assertEqual(state.get_many("bulk", values), dict.fromkeys(values, 1))

    def test_context_exclusive_in_process_and_through_directory_alias(self):
        lock_path = Path(self.temp.name) / "compat.lock"
        inode = lock_path.stat().st_ino
        with self.assertRaisesRegex(RuntimeError, "already in use"):
            self.reopen_context()
        with tempfile.TemporaryDirectory() as parent:
            alias = Path(parent) / "alias"
            alias.symlink_to(self.temp.name, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "already in use"):
                CompatContext("http://127.0.0.1:1", TOKEN, alias, "http://localhost")
        self.ctx.close()
        reopened = self.reopen_context()
        self.ctx.close()  # Closing the former owner cannot release the new lock.
        with self.assertRaisesRegex(RuntimeError, "already in use"):
            self.reopen_context()
        reopened.close()
        reopened.close()
        self.assertEqual(lock_path.stat().st_ino, inode)
        self.reopen_context()

    def test_context_exclusive_across_processes(self):
        code = '''import sys
from nset_compat import CompatContext
try:
    CompatContext("http://127.0.0.1:1", "secret", sys.argv[1], "http://localhost")
except RuntimeError as exc:
    assert "already in use" in str(exc)
else:
    raise AssertionError("second process acquired live directory")
'''
        result = subprocess.run([sys.executable, "-c", code, self.temp.name], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.ctx.state.put("test", "still-live", True)

    def test_context_recovers_after_owner_is_killed(self):
        self.ctx.close()
        lock_path = Path(self.temp.name) / "compat.lock"
        inode = lock_path.stat().st_ino
        code = '''import sys
from nset_compat import CompatContext
c=CompatContext("http://127.0.0.1:1", "secret", sys.argv[1], "http://localhost")
c.state.put("test:kill", "key", {"saved": True})
c.artifacts.put("test:kill", "file", b"durable")
print("ready", flush=True)
sys.stdin.read()
'''
        child = subprocess.Popen([sys.executable, "-c", code, self.temp.name],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertTrue(select.select([child.stdout], [], [], 10)[0], "owner did not become ready")
            self.assertEqual(child.stdout.readline(), b"ready\n")
            with self.assertRaisesRegex(RuntimeError, "already in use"):
                self.reopen_context()
            child.kill()
            child.wait(timeout=10)
            recovered = self.reopen_context()
            self.assertEqual(recovered.state.get("test:kill", "key"), {"saved": True})
            self.assertEqual(recovered.artifacts.get("test:kill", "file")[0], b"durable")
            self.assertEqual(lock_path.stat().st_ino, inode)
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=10)

    def test_context_failed_initialization_closes_database_and_releases_lock(self):
        self.ctx.close()
        connect = sqlite3.connect
        for failure in ("_fsync_dir", "Artifacts"):
            connections = []
            def capture_connection(*args, **kwargs):
                db = connect(*args, **kwargs)
                connections.append(db)
                return db
            with patch("nset_compat.context.sqlite3.connect", side_effect=capture_connection):
                with patch("nset_compat.context." + failure, side_effect=OSError("injected init failure")):
                    with self.assertRaisesRegex(OSError, "injected init failure"):
                        self.reopen_context()
            self.assertEqual(len(connections), 1)
            with self.assertRaises(sqlite3.ProgrammingError):
                connections[0].execute("SELECT 1")
            self.reopen_context().close()

    def test_context_native_binding_precedes_artifacts_and_allows_rotation(self):
        self.assertEqual(self.ctx.state.get("gateway:config", "native_url"), self.ctx.native.url)
        self.ctx.artifacts.put("test", "file", b"original")
        self.ctx.close()
        blobs = Path(self.temp.name) / "blobs"
        before = {p.name: p.read_bytes() for p in blobs.iterdir()}
        for native_url in ("http://127.0.0.1:2", "https://127.0.0.1:1", "http://127.0.0.1:1/prefix"):
            with patch("nset_compat.context.Artifacts") as artifacts:
                with self.assertRaisesRegex(ValueError, "different native URL"):
                    self.reopen_context(native_url=native_url)
                artifacts.assert_not_called()
            self.assertEqual({p.name: p.read_bytes() for p in blobs.iterdir()}, before)
        rotated = self.reopen_context(native_url="http://127.0.0.1:1/", token="rotated", public_url="https://example.test")
        self.assertEqual(rotated.state.get("gateway:config", "native_url"), "http://127.0.0.1:1")
        self.assertEqual(rotated.artifacts.get("test", "file")[0], b"original")
        self.assertEqual(rotated.native.token, "rotated")
        self.assertEqual(rotated.public_url, "https://example.test")
        rotated.state.put("gateway:config", "native_url", None)
        rotated.close()
        with self.assertRaisesRegex(ValueError, "different native URL"):
            self.reopen_context()

    def test_context_unsupported_platform_fails_before_mutation(self):
        with patch("nset_compat.context.os.name", "nt"), patch("nset_compat.context._mkdir") as mkdir:
            with self.assertRaisesRegex(RuntimeError, "platform is unsupported"):
                self.reopen_context()
            mkdir.assert_not_called()

    def test_artifact_bytes_namespace_listing_and_dedup(self):
        artifacts = self.ctx.artifacts
        artifacts.put("mlflow:run", "nested/data.bin", b"\x00\xff", "application/custom")
        artifacts.put("wandb:run", "other", b"\x00\xff")
        artifacts.put("mlflow:run", "root.txt", b"hello", "text/plain")
        self.assertEqual(artifacts.get("mlflow:run", "nested/data.bin"), (b"\x00\xff", "application/custom"))
        self.assertEqual(artifacts.list("mlflow:run"), [
            {"path": "nested", "is_dir": True, "file_size": 0},
            {"path": "root.txt", "is_dir": False, "file_size": 5}])
        self.assertEqual(artifacts.list("mlflow:run", "nested/")[0]["path"], "nested/data.bin")
        self.assertEqual(len(list(artifacts.root.iterdir())), 2)
        artifacts.delete("mlflow:run", "nested/data.bin")
        with self.assertRaises(ProtocolError) as caught:
            artifacts.get("mlflow:run", "nested/data.bin")
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(artifacts.get("wandb:run", "other")[0], b"\x00\xff")

    def test_artifact_traversal_capacity_and_failed_sync(self):
        for path in ("../x", "/x", "a/../b", "a\\b", "a\x00b", "a//b", "./x", ""):
            with self.subTest(path=path), self.assertRaises(ProtocolError):
                self.ctx.artifacts.put("test", path, b"x")
        self.ctx.max_body_bytes = 4
        with self.assertRaises(ProtocolError) as caught:
            self.ctx.artifacts.put("test", "big", b"12345")
        self.assertEqual(caught.exception.status, 413)
        with patch("nset_compat.context.os.fsync", side_effect=OSError("full")):
            with self.assertRaises(OSError):
                self.ctx.artifacts.put("test", "not-committed", b"data")
        self.assertEqual(self.ctx.artifacts.list("test"), [])

    def test_artifact_integrity_failure_is_explicit(self):
        self.ctx.artifacts.put("test", "file", b"hello")
        blob = next(self.ctx.artifacts.root.iterdir())
        blob.write_bytes(b"wrong")
        with self.assertRaises(ProtocolError) as caught:
            self.ctx.artifacts.get("test", "file")
        self.assertEqual(caught.exception.code, "DATA_LOSS")

    def test_abrupt_process_exit_preserves_committed_data(self):
        code = '''import os, sys
from nset_compat import CompatContext
c=CompatContext("http://127.0.0.1:1","secret",sys.argv[1],"http://localhost")
c.state.put("test:crash", "key", {"saved":True})
c.artifacts.put("test:crash", "file.bin", b"durable")
os._exit(0)
'''
        self.ctx.close()
        result = subprocess.run([sys.executable, "-c", code, self.temp.name], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        reopened = self.reopen_context()
        self.assertEqual(reopened.state.get("test:crash", "key"), {"saved": True})
        self.assertEqual(reopened.artifacts.get("test:crash", "file.bin")[0], b"durable")

    def test_signatures_scope_expiry_tamper_and_replay(self):
        with patch("nset_compat.context.time.time", return_value=100):
            url = self.ctx.signed_url("/compat/files/file", expires_in=60)
            parts = urlsplit(url)
            query = dict(parse_qsl(parts.query))
            self.assertNotIn(TOKEN, url)
            self.assertTrue(self.ctx.valid_signature(parts.path, query))
            self.assertTrue(self.ctx.valid_signature(parts.path, query))
            self.assertFalse(self.ctx.valid_signature("/compat/files/other", query))
            self.assertFalse(self.ctx.valid_signature("/api/runs", query))
            self.assertFalse(self.ctx.valid_signature(parts.path, {**query, "expires": "161"}))
        with patch("nset_compat.context.time.time", return_value=160):
            self.assertFalse(self.ctx.valid_signature(parts.path, query))
        for path in ("/api/runs", "//evil/compat/files/x", "/compat/files/../x", "/compat/files/%2e%2e/x", "/compat/files/x?x=1"):
            with self.subTest(path=path), self.assertRaises(ProtocolError):
                self.ctx.signed_url(path)

    def test_durable_ingest_poll_replay_and_conflict(self):
        native = FakeNative()
        self.ctx.native = native
        metrics = [{"key": "loss", "step": 1, "value": 0.5}]
        receipt = self.ctx.ingest_metrics("run", "batch", metrics)
        self.assertEqual(receipt["state"], "applied")
        self.assertEqual([c[0] for c in native.calls], ["PUT", "GET"])
        self.assertEqual(native.calls[0][2], {"metrics": metrics})
        self.assertNotIn("timestamp", native.calls[0][2]["metrics"][0])
        self.assertEqual(self.ctx.ingest_metrics("run", "batch", metrics), receipt)
        with self.assertRaises(ProtocolError) as caught:
            self.ctx.ingest_metrics("run", "batch", [{"key": "loss", "step": 1, "value": 0.6}])
        self.assertEqual(caught.exception.status, 409)
        self.assertTrue(all(call[0] != "POST" for call in native.calls))

    def test_pending_timeout_is_recoverable_and_chunk_ids_are_stable(self):
        native = FakeNative()
        native.apply = False
        self.ctx.native = native
        self.ctx.ingest_timeout = 0.01
        self.ctx.poll_interval = 0.001
        metrics = [{"key": "x", "step": 0, "value": 1}]
        with self.assertRaises(ProtocolError) as caught:
            self.ctx.ingest_metrics("run", "pending", metrics)
        self.assertEqual(caught.exception.status, 503)
        native.apply = True
        self.assertEqual(self.ctx.ingest_metrics("run", "pending", metrics)["state"], "applied")
        self.ctx.ingest_timeout = 2
        many = metrics * 10001
        first = self.ctx.ingest_metrics("run", "chunked", many)
        self.assertEqual(first["accepted"], 10001)
        paths = [r["batch_id"] for r in first["receipts"]]
        self.assertEqual(len(set(paths)), 2)
        second = self.ctx.ingest_metrics("run", "chunked", many)
        self.assertEqual([r["batch_id"] for r in second["receipts"]], paths)
        self.assertEqual([r["accepted"] for r in second["receipts"]], [10000, 1])

    def test_ingest_errors_and_receipts_are_not_silently_accepted(self):
        native = FakeNative()
        self.ctx.native = native
        native.reject = APIError(429, "capacity")
        with self.assertRaises(APIError):
            self.ctx.ingest_metrics("run", "capacity", [{"key": "x", "step": 0, "value": 1}])
        for batch_id in ("", "bad/slash", "x" * 129, "é"):
            with self.subTest(batch_id=batch_id), self.assertRaises(ProtocolError):
                self.ctx.ingest_metrics("run", batch_id, [{}])
        with patch.object(native, "request", return_value={"state": "applied"}):
            with self.assertRaises(ProtocolError) as caught:
                self.ctx.ingest_metrics("run", "invalid-receipt", [{}])
            self.assertEqual(caught.exception.status, 502)

    def test_receipt_timestamp_is_nonnegative_js_safe_integer(self):
        receipt = {"run_id": "run", "batch_id": "batch", "state": "applied", "accepted": 1, "accepted_at": 0}
        for accepted_at in (-1, 2**53, True, 1.0, "1", None):
            with self.subTest(accepted_at=accepted_at), self.assertRaises(ProtocolError) as caught:
                self.ctx._receipt({**receipt, "accepted_at": accepted_at}, "run", "batch", 1)
            self.assertEqual(caught.exception.status, 502)
        for accepted_at in (0, 1, 2**53 - 1):
            value = {**receipt, "accepted_at": accepted_at}
            self.assertEqual(self.ctx._receipt(value, "run", "batch", 1), value)

    def test_ingest_body_limit_includes_wrapper_and_transport_encoding(self):
        native = FakeNative()
        self.ctx.native = native
        metrics = [{"key": "é", "step": 0, "value": 1.5}]
        # Transport uses default JSON separators and ASCII escapes, not the
        # compact representation used for batch identity hashing.
        body = json.dumps({"metrics": metrics}, allow_nan=False).encode()
        for limit in (len(json.dumps(metrics).encode()), len(body) - 1):
            self.ctx.max_body_bytes = limit
            with self.assertRaises(ProtocolError) as caught:
                self.ctx.ingest_metrics("run", "body-limit", metrics)
            self.assertEqual(caught.exception.status, 413)
            self.assertEqual(self.ctx.state.items("gateway:ingest"), [])
            self.assertEqual(native.calls, [])
        self.ctx.max_body_bytes = len(body)
        self.assertEqual(self.ctx.ingest_metrics("run", "body-limit", metrics)["accepted"], 1)
        self.assertEqual(json.dumps(native.calls[0][2], allow_nan=False).encode(), body)

    def test_native_origin_guard_prevents_proxy_auth_bypass_before_storage(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / "absent"
            for url in ("http://127.0.0.1/api", "http://127.0.0.1/%61pi", "https://localhost/prefix/"):
                with self.subTest(url=url), self.assertRaisesRegex(ValueError, "origin"):
                    CompatContext(url, TOKEN, directory, "http://localhost")
                self.assertFalse(directory.exists())

    def test_generated_chunk_names_cannot_alias_caller_batch_names(self):
        import hashlib
        native = FakeNative()
        self.ctx.native = native
        metrics = [{"key": "x", "step": i, "value": i} for i in range(10001)]
        first = self.ctx.ingest_metrics("run", "A", metrics)
        old_generated_name = "chunk-" + hashlib.sha256(b"A:0").hexdigest()
        second = self.ctx.ingest_metrics("run", old_generated_name, metrics[:10000])
        self.assertEqual(second["batch_id"], old_generated_name)
        self.assertEqual(len(native.receipts), 3)
        self.assertEqual(self.ctx.ingest_metrics("run", "A", metrics), first)
        self.assertEqual(self.ctx.ingest_metrics("run", old_generated_name, metrics[:10000]), second)
        self.assertEqual(len(native.receipts), 3)
        self.ctx.state.put("gateway:ingest", json.dumps(["run", "legacy"], separators=(",", ":")), "old-digest")
        with self.assertRaises(ProtocolError) as caught:
            self.ctx.ingest_metrics("run", "legacy", metrics[:1])
        self.assertEqual(caught.exception.code, "LEGACY_BATCH_IDENTITY")
        self.assertEqual(len(native.receipts), 3)
    def test_missing_adapters_are_lazy_but_broken_imports_fail(self):
        def missing(name):
            raise ModuleNotFoundError(name=name)
        with patch("nset_compat.gateway.importlib.import_module", side_effect=missing):
            self.assertEqual(_load_adapters(), [])
        with patch("nset_compat.gateway.importlib.import_module", side_effect=ModuleNotFoundError(name="internal_dependency")):
            with self.assertRaises(ModuleNotFoundError):
                _load_adapters()


class BackendHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.seen.append((self.path, self.headers.get("Authorization")))
        if "/ingest/" in self.path:
            receipt = dict(self.server.receipts[self.path][1])
            receipt["state"] = "applied"
            self._json(200, receipt)
            return
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/never-follow")
            self.end_headers()
            return
        if self.path == "/":
            body, content_type = b"<html>native UI</html>", "text/html"
        else:
            body, content_type = json.dumps({"native": True, "path": self.path}).encode(), "application/json"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):
        self.server.seen.append((self.path, self.headers.get("Authorization")))
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.endswith("/capacity"):
            self._json(503, {"error": "native capacity exhausted"})
            return
        with self.server.receipt_lock:
            old = self.server.receipts.get(self.path)
            if old is not None and old[0] != payload:
                self._json(409, {"error": "payload conflict"})
                return
            if old is None:
                receipt = {"batch_id": self.path.split("/")[-1], "run_id": self.path.split("/")[-3],
                           "state": "pending", "accepted": len(payload["metrics"]), "accepted_at": 1000}
                self.server.receipts[self.path] = (payload, receipt)
            self._json(202, self.server.receipts[self.path][1])

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.server.seen.append((self.path, self.headers.get("Authorization")))
        self.send_response(201)
        self.send_header("Content-Type", self.headers.get("Content-Type", "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.backend = ThreadingHTTPServer(("127.0.0.1", 0), BackendHandler)
        self.backend.seen = []
        self.backend.receipts = {}
        self.backend.receipt_lock = threading.Lock()
        self.backend_thread = threading.Thread(target=self.backend.serve_forever, kwargs={"poll_interval": 0.05})
        self.backend_thread.start()
        native_url = "http://127.0.0.1:" + str(self.backend.server_port)
        self.ctx = CompatContext(native_url, TOKEN, self.temp.name, "http://127.0.0.1")
        self.server = make_server(self.ctx, workers=2, max_body_bytes=1024)
        self.ctx.public_url = "http://127.0.0.1:" + str(self.server.server_port)
        self.server.adapters = [self.adapter]
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        self.ctx.close()
        self.backend.shutdown()
        self.backend.server_close()
        self.backend_thread.join(3)
        self.temp.cleanup()

    @staticmethod
    def adapter(ctx, request):
        if request.path == "/compat/ingest":
            data = request.json()
            return Response(body=ctx.ingest_metrics(data["run_id"], data["batch_id"], data["metrics"]))
        if request.path == "/compat/echo":
            return Response(body=request.json())
        if request.path == "/compat/fail":
            raise RuntimeError("sensitive exception text")
        if request.path == "/graphql":
            raise ProtocolError(400, "INVALID_PARAMETER_VALUE", "Unsupported operation")
        if request.path == "/compat/native-failure":
            raise APIError(429, "capacity exhausted")
        if request.path == "/compat/files/blob":
            if request.method == "PUT":
                ctx.artifacts.put("http:test", "blob", request.body, request.headers.get("content-type", "application/octet-stream"))
                return Response()
            body, content_type = ctx.artifacts.get("http:test", "blob")
            return Response(body=body, headers={"Content-Type": content_type})
        return None

    def request(self, method="GET", path="/api/check", body=None, headers=None, auth=True):
        headers = dict(headers or {})
        if auth:
            headers.setdefault("Authorization", "Bearer " + TOKEN)
        conn = HTTPConnection(*self.server.server_address[:2], timeout=3)
        try:
            conn.request(method, path, body=body, headers=headers)
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def raw(self, data):
        with socket.create_connection(self.server.server_address[:2], timeout=3) as sock:
            sock.sendall(data)
            chunks = []
            while True:
                part = sock.recv(4096)
                if not part:
                    break
                chunks.append(part)
            return b"".join(chunks)

    def test_auth_bearer_basic_and_static_ui(self):
        self.assertEqual(self.request(auth=False)[0], 401)
        self.assertEqual(self.request(headers={"Authorization": "Bearer wrong"})[0], 401)
        basic = base64.b64encode(("api:" + TOKEN).encode()).decode()
        self.assertEqual(self.request(headers={"Authorization": "Basic " + basic})[0], 200)
        self.assertEqual(self.backend.seen[-1][1], "Bearer " + TOKEN)
        status, headers, body = self.request(path="/", auth=False)
        self.assertEqual((status, body), (200, b"<html>native UI</html>"))
        self.assertEqual(headers["Content-Type"], "text/html")
        self.assertEqual(self.request(path="/%61pi/check", auth=False)[0], 401)

    def test_native_proxy_status_bytes_query_and_redirect(self):
        status, _, body = self.request(path="/api/check?q=a%2Fb")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["path"], "/api/check?q=a%2Fb")
        status, headers, body = self.request("POST", "/api/upload", b"\xff\x00", {"Content-Type": "application/custom"})
        self.assertEqual((status, body), (201, b"\xff\x00"))
        self.assertEqual(headers["Content-Type"], "application/custom")
        status, headers, _ = self.request(path="/redirect", auth=False)
        self.assertEqual(status, 302)
        self.assertEqual(headers["location"], "http://127.0.0.1:1/never-follow")

    def test_explicit_protocol_errors_and_safe_internal_error(self):
        for route in ("/api/2.0/mlflow/nope", "/wandb/unknown", "/compat/unknown"):
            status, _, body = self.request(path=route)
            self.assertEqual(status, 501)
            self.assertEqual(json.loads(body)["error_code"], "NOT_IMPLEMENTED")
        status, _, body = self.request("POST", "/graphql", b"{}")
        self.assertEqual(status, 400)
        self.assertIn("errors", json.loads(body))
        status, _, body = self.request(path="/compat/fail")
        self.assertEqual(status, 500)
        self.assertNotIn(b"sensitive", body)
        self.assertEqual(self.request(path="/compat/native-failure")[0], 429)
        self.assertEqual(self.backend.seen, [])

    def test_gzip_json_and_body_limits(self):
        body = gzip.compress(b'{"hello":"world"}')
        status, _, result = self.request("POST", "/compat/echo", body, {"Content-Encoding": "gzip"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(result), {"hello": "world"})
        bomb = gzip.compress(b"x" * 100000)
        self.assertEqual(self.request("POST", "/compat/echo", bomb, {"Content-Encoding": "gzip"})[0], 413)
        self.assertEqual(self.request("POST", "/compat/echo", b"bad", {"Content-Encoding": "gzip"})[0], 400)
        self.assertEqual(self.request("POST", "/compat/echo", b"{}", {"Content-Encoding": "br"})[0], 415)
        self.assertEqual(self.request("POST", "/compat/echo", b"x" * 1025)[0], 413)
        self.assertEqual(self.request("POST", "/compat/echo", b"[]")[0], 400)

    def test_ambiguous_framing_and_traversal_are_rejected(self):
        auth = b"Authorization: Bearer " + TOKEN.encode() + b"\r\n"
        for extra in (b"Content-Length: 0\r\nContent-Length: 0\r\n", b"Transfer-Encoding: chunked\r\nContent-Length: 0\r\n", b"Content-Length: -1\r\n"):
            response = self.raw(b"POST /compat/echo HTTP/1.1\r\nHost: localhost\r\n" + auth + extra + b"\r\n")
            self.assertIn(b" 400 ", response.split(b"\r\n", 1)[0])
        for path in ("/compat/files/../x", "/compat/files/%2e%2e/x", "/compat/files/a%5Cb", "http://evil.example/api/runs"):
            self.assertEqual(self.request(path=path)[0], 400)
        self.assertEqual(self.request(path="/api/check?a=1&a=2")[0], 400)

    def test_signed_download_not_upload_or_api_auth(self):
        self.assertEqual(self.request("PUT", "/compat/files/blob", b"artifact", {"Content-Type": "text/plain"})[0], 200)
        parts = urlsplit(self.ctx.signed_url("/compat/files/blob"))
        signed = parts.path + "?" + parts.query
        for _ in range(2):
            status, headers, body = self.request(path=signed, auth=False)
            self.assertEqual((status, body), (200, b"artifact"))
            self.assertEqual(headers["Content-Type"], "text/plain")
        self.assertEqual(self.request("PUT", signed, b"overwrite", auth=False)[0], 401)
        self.assertEqual(self.request(path="/api/check?" + parts.query, auth=False)[0], 401)
        self.assertEqual(self.request(path=signed + "0", auth=False)[0], 401)
        self.assertEqual(self.request(path=signed, method="HEAD", auth=False)[2], b"")

    def test_concurrent_requests_persist_every_artifact(self):
        def upload(i):
            path = "path/" + str(i)
            self.ctx.artifacts.put("concurrent", path, str(i).encode())
            return self.ctx.artifacts.get("concurrent", path)[0]
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(upload, range(40)))
        self.assertEqual(results, [str(i).encode() for i in range(40)])
        self.assertEqual(len(self.ctx.artifacts.list("concurrent", "path")), 40)

    def test_real_http_native_receipts_replay_and_capacity(self):
        payload = {"run_id": "run", "batch_id": "http-batch", "metrics": [{"key": "x", "step": 0, "value": 1}]}
        status, _, body = self.request("POST", "/compat/ingest", json.dumps(payload).encode())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["state"], "applied")
        native_path = self.backend.seen[0][0]
        self.assertTrue(native_path.startswith("/api/runs/run/ingest/gw1-"))
        self.assertEqual([p for p, _ in self.backend.seen], [native_path, native_path])
        self.assertTrue(all(auth == "Bearer " + TOKEN for _, auth in self.backend.seen))
        applied_receipt = json.loads(body)
        payload["batch_id"] = "capacity"
        status, _, body = self.request("POST", "/compat/ingest", json.dumps(payload).encode())
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error_code"], "NATIVE_ERROR")
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        self.ctx.close()
        second = CompatContext(self.ctx.native.url, TOKEN, self.temp.name, self.ctx.public_url)
        try:
            receipt = second.ingest_metrics("run", "http-batch", payload["metrics"])
            self.assertEqual(receipt, applied_receipt)
            self.assertEqual(len(self.backend.receipts), 1)
        finally:
            second.close()

    def test_worker_capacity_and_absolute_header_deadline(self):
        self.server.request_timeout = 0.3
        sockets = [socket.create_connection(self.server.server_address[:2], timeout=3) for _ in range(2)]
        try:
            for sock in sockets:
                sock.sendall(b"GET /api/check HTTP/1.1\r\nHost: localhost\r\n")
            end = time.monotonic() + 1
            while time.monotonic() < end:
                with self.server._active_lock:
                    if len(self.server._active) == 2:
                        break
                time.sleep(0.005)
            self.assertEqual(self.request()[0], 503)
            time.sleep(0.5)
            end = time.monotonic() + 1
            while time.monotonic() < end:
                with self.server._active_lock:
                    if not self.server._active:
                        break
                time.sleep(0.005)
            with self.server._active_lock:
                self.assertEqual(len(self.server._active), 0)
            self.assertEqual(self.request()[0], 200)
        finally:
            for sock in sockets:
                sock.close()

    def test_invalid_configuration(self):
        for kwargs in ({"workers": 0}, {"workers": 257}, {"max_body_bytes": 0}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                make_server(self.ctx, **kwargs)


if __name__ == "__main__":
    unittest.main()
