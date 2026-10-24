"""Official EventFileWriter fixtures, no TensorFlow/PyTorch dependency.

Unit tests use an explicitly fake durable native transport. Integration tests use
support.Server and run only when NSET_BINARY points at a durable-ingest build.
PYTHONPATH=python:tests python -m unittest discover -s tests -p test_tensorboard_compat.py -v
"""
import base64
import importlib.util
import json
import os
import struct
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import unittest

from nset_client.transport import Transport
from nset_compat.tensorboard import Collector, SourceChanged, _frames

HAS_TENSORBOARD = importlib.util.find_spec("tensorboard") is not None
if HAS_TENSORBOARD:
    from tensorboard.compat.proto import event_pb2, summary_pb2, tensor_pb2, types_pb2
    from tensorboard.summary.writer.event_file_writer import EventFileWriter
    from tensorboard.util import tensor_util

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")


def event(*values, step=3, wall_time=1234.5):
    return event_pb2.Event(step=step, wall_time=wall_time,
                           summary=summary_pb2.Summary(value=values))


def simple(tag="loss", value=2.5):
    return summary_pb2.Summary.Value(tag=tag, simple_value=value)


def tensor(tag, value, plugin="scalars"):
    return summary_pb2.Summary.Value(tag=tag, tensor=tensor_util.make_tensor_proto(value),
        metadata=summary_pb2.SummaryMetadata(plugin_data=summary_pb2.SummaryMetadata.PluginData(plugin_name=plugin)))


def write_events(directory, events, suffix=""):
    directory.mkdir(parents=True, exist_ok=True)
    before = set(directory.glob("*tfevents*"))
    writer = EventFileWriter(str(directory), filename_suffix=suffix)
    for item in events:
        writer.add_event(item)
    writer.flush()
    writer.close()
    return (set(directory.glob("*tfevents*")) - before).pop()


class FakeNative:
    """Models durable PUT acceptance/deduplication, not HTTP conformance."""
    def __init__(self):
        self.runs = []
        self.batches = {}
        self.calls = []
        self.lose_put = False
        self.reject_put = False
        self.lose_run = False

    def request(self, method, path, payload=None, **kwargs):
        self.calls.append((method, path, payload))
        if path == "/api/experiments":
            return {"id": "experiment-1"}
        if path == "/api/runs" and method == "GET":
            return {"runs": self.runs}
        if path == "/api/runs" and method == "POST":
            row = dict(payload, id=f"run-{len(self.runs) + 1}")
            self.runs.append(row)
            if self.lose_run:
                self.lose_run = False
                raise ConnectionError("lost run creation response")
            return row
        if "/ingest/" in path and method == "PUT":
            if self.reject_put:
                raise ConnectionError("native not accepting writes")
            if path in self.batches:
                assert self.batches[path] == payload, "batch payload changed on replay"
            self.batches[path] = payload
            if self.lose_put:
                self.lose_put = False
                raise ConnectionError("lost durable response")
            return {"state": "accepted"}
        raise AssertionError((method, path))

    @property
    def metrics(self):
        return [row for payload in self.batches.values() for row in payload["metrics"]]


@unittest.skipUnless(HAS_TENSORBOARD, "install official tensorboard extra")
class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "logs"
        self.root.mkdir()
        self.state = Path(self.temp.name) / "state"
        self.native = FakeNative()

    def collector(self, **kwargs):
        return Collector(self.root, "http://native.example", self.state,
                         token="test", transport=self.native, **kwargs)

    def test_real_writer_old_and_tensor_scalars_and_run_directories(self):
        write_events(self.root / "train", [event(simple(), tensor("accuracy", 0.75), tensor("count", 7))])
        write_events(self.root / "validation", [event(simple(value=0.5))])
        with self.collector() as collector:
            counts = collector.scan()
            self.assertEqual(counts["processed_records"], 4)
            self.assertEqual(counts["accepted_batches"], 2)
        self.assertEqual(len(self.native.runs), 2)
        self.assertEqual({run["name"] for run in self.native.runs}, {"train", "validation"})
        self.assertEqual(len(self.native.metrics), 4)
        self.assertTrue(all(row["timestamp"] == 1234500 and row["step"] == 3 for row in self.native.metrics))
        with self.collector() as collector:
            collector.scan()
        self.assertEqual(len(self.native.metrics), 4)
        self.assertEqual(len(self.native.runs), 2)

    def test_real_writer_partial_final_record_keeps_checkpoint(self):
        path = write_events(self.root, [event(simple())])
        original = path.read_bytes()
        with path.open("rb") as stream:
            records = list(_frames(stream, 0))
        cut = records[-1][0]
        path.write_bytes(original[:-3])
        with self.collector() as collector:
            collector.scan()
            self.assertEqual(collector.db.execute("SELECT offset FROM files").fetchone()[0], cut)
            self.assertFalse(self.native.metrics)
        with path.open("ab") as stream:
            stream.write(original[-3:])
        with self.collector() as collector:
            collector.scan()
            self.assertEqual(collector.db.execute("SELECT offset FROM files").fetchone()[0], len(original))
        self.assertEqual(len(self.native.metrics), 1)

    def test_partial_first_header_waits_for_completion(self):
        path = write_events(self.root, [event(simple())])
        original = path.read_bytes()
        path.write_bytes(original[:8])
        with self.collector() as collector:
            self.assertEqual(collector.scan()["records"], 0)
            self.assertEqual(collector.db.execute("SELECT offset FROM files").fetchone()[0], 0)
            with path.open("ab") as stream:
                stream.write(original[8:])
            self.assertEqual(collector.scan()["processed_records"], 2)
        self.assertEqual(len(self.native.metrics), 1)

    def test_lost_durable_response_replays_same_batch_across_restart(self):
        path = write_events(self.root, [event(simple())])
        self.native.lose_put = True
        with self.collector() as collector:
            with self.assertRaises(ConnectionError):
                collector.scan()
            self.assertLess(collector.db.execute("SELECT offset FROM files").fetchone()[0], path.stat().st_size)
            self.assertEqual(collector.counts()["accepted_batches"], 0)
        first_put = [call for call in self.native.calls if call[0] == "PUT"][0]
        with self.collector() as collector:
            collector.scan()
            self.assertEqual(collector.counts()["accepted_batches"], 1)
        puts = [call for call in self.native.calls if call[0] == "PUT"]
        self.assertEqual(puts, [first_put, first_put])
        self.assertEqual(len(self.native.metrics), 1)
        self.assertFalse(any(path.endswith("/metrics") for _, path, _ in self.native.calls))

    def test_outbox_survives_missing_source(self):
        path = write_events(self.root, [event(simple())])
        self.native.reject_put = True
        with self.collector() as collector:
            with self.assertRaises(ConnectionError):
                collector.scan()
        path.unlink()
        self.native.reject_put = False
        with self.collector() as collector, self.assertLogs("nset_compat.tensorboard", "WARNING"):
            collector.scan()
            self.assertEqual(collector.counts()["accepted_batches"], 1)
        self.assertEqual(len(self.native.metrics), 1)

    def test_run_creation_lost_response_recovers_tag_not_another_post(self):
        write_events(self.root, [event(simple())])
        self.native.lose_run = True
        with self.collector() as collector:
            with self.assertRaises(ConnectionError):
                collector.scan()
        with self.collector() as collector:
            collector.scan()
        self.assertEqual(len(self.native.runs), 1)
        self.assertEqual(len(self.native.metrics), 1)

    def test_ambiguous_run_creation_without_visible_run_fails_closed(self):
        write_events(self.root, [event(simple())])
        self.native.lose_run = True
        with self.collector() as collector:
            with self.assertRaises(ConnectionError):
                collector.scan()
        self.native.runs.clear()
        with self.collector() as collector:
            with self.assertRaisesRegex(RuntimeError, "ambiguous native run"):
                collector.scan()
        posts = [call for call in self.native.calls if call[:2] == ("POST", "/api/runs")]
        self.assertEqual(len(posts), 1)

    def test_crc_failure_does_not_acknowledge_corrupt_record(self):
        path = write_events(self.root, [event(simple())])
        contents = bytearray(path.read_bytes())
        contents[-1] ^= 1
        path.write_bytes(contents)
        with self.collector() as collector:
            with self.assertRaisesRegex(SourceChanged, "CRC"):
                collector.scan()
            self.assertEqual(collector.counts()["processed_records"], 1)
            self.assertFalse(self.native.metrics)

    def test_rotations_renames_and_restart_steps_append_without_purge(self):
        path = write_events(self.root, [event(simple(), step=8)])
        with self.collector() as collector:
            collector.scan()
        path.rename(path.with_name(path.name + ".rotated"))
        restart = event_pb2.Event(step=2, session_log=event_pb2.SessionLog(status=event_pb2.SessionLog.START))
        write_events(self.root, [restart, event(simple(), step=2)], ".next")
        with self.collector() as collector, self.assertLogs("nset_compat.tensorboard", "WARNING") as captured:
            collector.scan()
            self.assertEqual(collector.counts()["preservation_reasons"]["session-log-preserved-no-purge"], 1)
        self.assertIn("no-purge", " ".join(captured.output))
        self.assertEqual([row["step"] for row in self.native.metrics], [8, 2])
        self.assertEqual(len(self.native.runs), 1)

    def test_truncation_and_rewrite_rejected(self):
        path = write_events(self.root, [event(simple())])
        original = path.read_bytes()
        with self.collector() as collector:
            collector.scan()
        path.write_bytes(original[:-1])
        with self.collector() as collector:
            with self.assertRaisesRegex(SourceChanged, "truncated"):
                collector.scan()
        path.write_bytes(bytes([original[0] ^ 1]) + original[1:])
        with self.collector() as collector:
            with self.assertRaisesRegex(SourceChanged, "prefix changed"):
                collector.scan()
        self.assertEqual(len(self.native.metrics), 1)

    def test_old_new_images_and_unsupported_records_are_durable_local_artifacts(self):
        old = summary_pb2.Summary.Value(tag="old", image=summary_pb2.Summary.Image(
            height=1, width=1, colorspace=1, encoded_image_string=PNG))
        new = tensor("new", [b"1", b"1", PNG, PNG], "images")
        histogram = summary_pb2.Summary.Value(tag="hist", histo=summary_pb2.HistogramProto(min=0, max=1))
        unsupported = event(histogram, tensor("text", b"hello", "text"), simple("nan", float("nan")))
        write_events(self.root, [event(old, new), unsupported, event_pb2.Event(graph_def=b"graph")])
        with self.collector() as collector, self.assertLogs("nset_compat.tensorboard", "WARNING") as captured:
            counts = collector.scan()
            self.assertEqual(counts["local_images"], 3)
            self.assertEqual(counts["processed_records"], 4)
            images = collector.db.execute("SELECT data FROM artifacts").fetchall()
            self.assertEqual([row[0] for row in images], [PNG, PNG, PNG])
            raw = [row[0] for row in collector.db.execute("SELECT raw FROM events")]
            self.assertIn(unsupported.SerializeToString(), raw)
        self.assertGreaterEqual(len(captured.output), 5)
        self.assertFalse(self.native.metrics)
        self.assertFalse(any(path.endswith("/images") for _, path, _ in self.native.calls))
        with self.collector() as collector:
            self.assertEqual(collector.scan()["local_images"], 3)

    def test_native_constraints_and_non_scalar_tensors_preserved(self):
        write_events(self.root, [event(simple(), step=-1), event(simple(), wall_time=-1),
            event(simple("x" * 513)), event(tensor("vector", [1.0])), event(simple("unicode-λ"))])
        with self.collector() as collector, self.assertLogs("nset_compat.tensorboard", "WARNING"):
            collector.scan()
        self.assertEqual(len(self.native.metrics), 1)
        self.assertEqual(self.native.metrics[0]["key"], "unicode-λ")

    def test_large_summary_chunked_and_replay_safe(self):
        write_events(self.root, [event(*(simple(f"m{i}", i) for i in range(10001)))])
        with self.collector() as collector:
            collector.scan()
            self.assertEqual(collector.counts()["accepted_batches"], 2)
        self.assertEqual(sorted(len(payload["metrics"]) for payload in self.native.batches.values()), [1, 10000])
        with self.collector() as collector:
            collector.scan()
        self.assertEqual(len(self.native.metrics), 10001)

    def test_tensor_content_and_repeated_field_numeric_scalars(self):
        values = [
            summary_pb2.Summary.Value(tag="content", tensor=tensor_pb2.TensorProto(
                dtype=types_pb2.DT_DOUBLE, tensor_content=struct.pack("<d", 0.125))),
            summary_pb2.Summary.Value(tag="repeated", tensor=tensor_pb2.TensorProto(
                dtype=types_pb2.DT_INT64, int64_val=[42])),
            tensor("bool", True),
        ]
        write_events(self.root, [event(*values)])
        with self.collector() as collector, self.assertLogs("nset_compat.tensorboard", "WARNING"):
            collector.scan()
        self.assertEqual({row["key"]: row["value"] for row in self.native.metrics},
                         {"content": 0.125, "repeated": 42.0})

    def test_cli_process_restart_after_lost_put_response_fake_http(self):
        write_events(self.root, [event(simple())])
        native = self.native
        native.lose_put = True

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.handle_request()

            def do_GET(self):
                self.handle_request()

            def do_PUT(self):
                self.handle_request()

            def handle_request(self):
                self.assert_token = self.headers.get("Authorization") == "Bearer cli-test-token"
                if not self.assert_token:
                    self.send_error(401)
                    return
                length = int(self.headers.get("Content-Length", 0))
                payload = json.loads(self.rfile.read(length)) if length else None
                try:
                    result = native.request(self.command, self.path.split("?")[0], payload)
                except ConnectionError:
                    self.close_connection = True
                    return
                body = json.dumps(result).encode()
                self.send_response(202 if self.command == "PUT" else 200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            command = [sys.executable, "-m", "nset_compat.tensorboard", "--logdir", str(self.root),
                       "--url", f"http://127.0.0.1:{server.server_port}", "--state-dir", str(self.state)]
            env = dict(os.environ, NSET_TOKEN="cli-test-token")
            first = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(first.returncode, 0)
            second = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(len(native.metrics), 1)
            self.assertEqual(len(native.runs), 1)
            puts = [call for call in native.calls if call[0] == "PUT"]
            self.assertEqual(len(puts), 2)
            self.assertEqual(puts[0], puts[1])
            self.assertNotIn("cli-test-token", first.stderr + second.stderr)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)

    def test_state_configuration_and_concurrent_writer_rejected(self):
        with self.collector():
            with self.assertRaisesRegex(RuntimeError, "active collector"):
                self.collector()
        with self.assertRaisesRegex(ValueError, "bound to another"):
            self.collector(experiment="different")
        with self.collector():
            pass


@unittest.skipUnless(HAS_TENSORBOARD and os.environ.get("NSET_BINARY"),
                     "requires official tensorboard and NSET_BINARY durable-ingest server")
class NativeCollectorIntegration(unittest.TestCase):
    def test_real_writer_native_server_lost_response_and_both_restarts(self):
        from support import Server
        server = Server().start()
        self.addCleanup(server.close)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "events"
            state = Path(temporary) / "collector"
            write_events(root / "training", [event(simple(), tensor("tensor", 1.25))])
            native = Transport(server.url, server.token)

            class LoseFirstPut:
                lost = False

                def request(self, method, path, payload=None, **kwargs):
                    result = native.request(method, path, payload, **kwargs)
                    if method == "PUT" and not self.lost:
                        self.lost = True
                        raise ConnectionError("injected loss after native durable acceptance")
                    return result

            with Collector(root, server.url, state, token=server.token, transport=LoseFirstPut()) as collector:
                with self.assertRaises(ConnectionError):
                    collector.scan()
            server.stop()
            server.start()
            with Collector(root, server.url, state, token=server.token) as collector:
                collector.scan()
                run_id = collector.db.execute("SELECT run_id FROM runs").fetchone()[0]
            import time
            deadline = time.monotonic() + 15
            while True:
                points = list(server.client.metric_history(run_id, "loss"))
                tensor_points = list(server.client.metric_history(run_id, "tensor"))
                if len(points) == len(tensor_points) == 1 or time.monotonic() >= deadline:
                    break
                time.sleep(0.05)
            self.assertEqual(len(points), 1)
            self.assertEqual(points[0]["value"], 2.5)
            self.assertEqual(points[0]["timestamp"], 1234500)
            self.assertEqual(len(tensor_points), 1)
            self.assertEqual(tensor_points[0]["value"], 1.25)
            with Collector(root, server.url, state, token=server.token) as collector:
                collector.scan()
            self.assertEqual(len(list(server.client.metric_history(run_id, "loss"))), 1)


if __name__ == "__main__":
    unittest.main()
