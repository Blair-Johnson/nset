"""Real HTTP acceptance, crash recovery, and outbox delivery tests."""
from concurrent.futures import ThreadPoolExecutor
import os
import time
import unittest
from unittest.mock import patch
from support import Server
from nset_client import APIError


class DurableHTTPTests(unittest.TestCase):
    def setUp(self):
        self.server = Server()
        self.addCleanup(self.server.close)

    def start(self, **env):
        with patch.dict(os.environ, env):
            self.server.start()
        self.client = self.server.client

    def run_record(self):
        return self.client.start_run(self.client.experiment("durable"), "recovery")

    def applied(self, path):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            receipt = self.client.http.request("GET", path)
            if receipt["state"] == "applied":
                return receipt
            time.sleep(0.02)
        self.fail("durable batch did not become query-visible")

    def test_acknowledged_pending_batches_survive_kill_and_replay_once(self):
        self.start(NSET_INGEST_PAUSED="true")
        run = self.run_record()
        path = run.path + "/ingest/crash-batch"
        metrics = [{"key": "loss", "step": i, "value": i / 10} for i in range(50)]
        receipt = self.client.http.request("PUT", path, {"metrics": metrics})
        self.assertEqual(receipt["state"], "pending")
        self.assertEqual(receipt["accepted"], 50)
        self.assertEqual(list(self.client.metric_history(run.id, "loss")), [])
        self.assertEqual(receipt, self.client.http.request("PUT", path, {"metrics": metrics}))
        self.server.process.kill()
        self.server.process.wait(timeout=10)
        self.server.stop()
        self.start(NSET_INGEST_PAUSED="false")
        applied = self.applied(path)
        self.assertEqual(applied["accepted_at"], receipt["accepted_at"])
        self.assertEqual(applied, self.client.http.request("PUT", path, {"metrics": metrics}))
        rows = list(self.client.metric_history(run.id, "loss"))
        self.assertEqual([(r["step"], r["value"]) for r in rows], [(i, i / 10) for i in range(50)])
        self.assertEqual({r["timestamp"] for r in rows}, {receipt["accepted_at"]})
        self.server.stop()
        self.start()
        self.assertEqual(len(list(self.client.metric_history(run.id, "loss"))), 50)

    def test_capacity_rejection_keeps_outbox_and_replays_after_restart(self):
        self.start(NSET_INGEST_PAUSED="true", NSET_INGEST_MAX_PENDING_BATCHES="1")
        run = self.run_record()
        with self.client.durable_outbox(self.server.directory / "outbox.sqlite3") as outbox:
            outbox.enqueue(run.id, [{"key": "v", "step": 0, "value": 1}], batch_id="first")
            self.assertEqual(outbox.flush(), 1)
            outbox.enqueue(run.id, [{"key": "v", "step": 1, "value": 2}], batch_id="second")
            with self.assertRaises(APIError) as caught:
                outbox.flush()
            self.assertEqual(caught.exception.status, 503)
            self.assertEqual(outbox.pending_count(), 1)
        self.server.stop()
        self.start(NSET_INGEST_PAUSED="false", NSET_INGEST_MAX_PENDING_BATCHES="1")
        self.applied(run.path + "/ingest/first")
        with self.client.durable_outbox(self.server.directory / "outbox.sqlite3") as outbox:
            self.assertEqual(outbox.flush(), 1)
            self.assertEqual(outbox.pending_count(), 0)
        self.applied(run.path + "/ingest/second")
        self.assertEqual([r["value"] for r in self.client.metric_history(run.id, "v")], [1, 2])
