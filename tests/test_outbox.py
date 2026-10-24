"""Pure native outbox tests: mock transport, real disposable SQLite, no server."""
import concurrent.futures
import contextlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from support import ROOT
from nset_client import (APIError, BatchConflictError, Client, DurableOutbox,
                         InvalidReceiptError, OutboxFullError)


METRICS = [{"key": "loss", "step": 0, "value": 1.25}]


def receipt(method, path, *, raw):
    assert method == "PUT", method
    assert "/ingest/" in path, path
    run_id, batch_id = path.split("/")[3], path.split("/")[-1]
    return {"run_id": run_id, "batch_id": batch_id, "state": "pending",
            "accepted": len(json.loads(raw)["metrics"]), "accepted_at": 123456}


class OutboxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "outbox.sqlite3"
        self.client = Client("http://localhost:8080", token="never-store-this-token", timeout=.05)

    def box(self, **options):
        box = self.client.durable_outbox(self.path, **options)
        self.addCleanup(box.close)
        return box

    def rows(self):
        with contextlib.closing(sqlite3.connect(self.path)) as db, db:
            return db.execute("SELECT run_id,batch_id,payload FROM outbox_pending ORDER BY id").fetchall()

    def test_offline_commit_reopen_and_credentials_not_stored(self):
        with patch("nset_client.outbox.Transport.request", side_effect=OSError("offline")) as send:
            box = self.box()
            data = [{"key": "loss", "step": 0, "value": 1.25}]
            batch_id = box.enqueue("run", data)
            data[0]["value"] = 99
            self.assertRegex(batch_id, r"^[a-z0-9]{32}$")
            self.assertEqual(box._db.execute("PRAGMA synchronous").fetchone(), (2,))
            self.assertEqual(box._db.execute("PRAGMA journal_mode").fetchone(), ("wal",))
            self.assertEqual(len(self.rows()), 1)  # visible on independent connection, already committed
            self.assertEqual(json.loads(self.rows()[0][2]), {"metrics": METRICS})
            send.assert_not_called()
            with self.assertRaisesRegex(OSError, "offline"):
                box.flush()
            self.assertIsInstance(box.last_error, OSError)
            box.close()
            for file in Path(self.temp.name).iterdir():
                self.assertNotIn(self.client.http.token.encode(), file.read_bytes())
            self.client.http.token = "rotated-secret"
            reopened = self.box()
            self.assertEqual(reopened.pending_count(), 1)
        with patch("nset_client.outbox.Transport.request", side_effect=receipt) as send:
            self.assertEqual(reopened.flush(), 1)
            self.assertEqual(reopened.pending_count(), 0)
            self.assertTrue(send.call_args.args[1].endswith(batch_id))

    def test_same_id_same_payload_noop_and_different_payload_conflict_per_run(self):
        box = self.box(max_pending_batches=1)
        box.enqueue("run", METRICS, batch_id="stable")
        reordered = [{"value": 1.25, "step": 0, "key": "loss"}]
        self.assertEqual(box.enqueue("run", reordered, batch_id="stable"), "stable")
        with self.assertRaises(BatchConflictError):
            box.enqueue("run", [{"key": "loss", "step": 1, "value": 2}], batch_id="stable")
        self.assertEqual(json.loads(self.rows()[0][2]), {"metrics": METRICS})
        box.close()
        other = self.box(max_pending_batches=2)
        other.enqueue("other-run", METRICS, batch_id="stable")
        self.assertEqual(other.pending_count(), 2)

    def test_capacity_count_and_exact_canonical_byte_limit_never_evict(self):
        box = self.box(max_pending_batches=1)
        box.enqueue("run", METRICS, batch_id="one")
        size = len(self.rows()[0][2])
        with self.assertRaises(OutboxFullError):
            box.enqueue("run", METRICS, batch_id="two")
        box.close()
        byte_box = self.box(max_pending_bytes=size)
        with self.assertRaises(OutboxFullError):
            byte_box.enqueue("run", METRICS, batch_id="two")
        self.assertEqual(byte_box.pending_count(), 1)
        with patch("nset_client.outbox.Transport.request", side_effect=receipt):
            self.assertEqual(byte_box.flush(), 1)
        byte_box.enqueue("run", METRICS, batch_id="exact")
        self.assertEqual(len(self.rows()[0][2]), size)

    def test_wire_body_limit_counts_canonical_bytes_before_transaction(self):
        box = self.box()
        box.enqueue("run", METRICS, batch_id="existing")
        metrics = [{"value": 1.25, "step": 0, "key": "\x00\u00e9"}]
        expected = '{"metrics":[{"key":"\\u0000\u00e9","step":0,"value":1.25}]}'.encode("utf-8")
        with patch("nset_client.outbox._MAX_BODY", len(expected)):
            self.assertEqual(box.enqueue("run", metrics, batch_id="exact"), "exact")
            self.assertEqual(self.rows()[-1][2], expected)
            originals = self.rows()
            statements = []
            box._db.set_trace_callback(statements.append)
            try:
                # One extra ASCII byte crosses the exact canonical UTF-8 boundary.
                oversized = [dict(metrics[0], key="\x00\u00e9a")]
                with self.assertRaisesRegex(ValueError, "HTTP body limit"):
                    box.enqueue("run", oversized, batch_id="oversized")
                self.assertEqual(statements, [])  # Not even BEGIN was issued.
            finally:
                box._db.set_trace_callback(None)
            self.assertEqual(self.rows(), originals)
        box.close()
        self.assertEqual(self.box().pending_count(), 2)

    def test_native_wire_body_limit_rejects_escape_expansion(self):
        box = self.box()
        box.enqueue("run", METRICS, batch_id="existing")
        originals = self.rows()
        metrics = [{"key": "\x00" * 512, "step": 0, "value": 10**308}] * 10000
        with self.assertRaisesRegex(ValueError, "33554432-byte HTTP body limit"):
            box.enqueue("run", metrics, batch_id="oversized")
        self.assertEqual(self.rows(), originals)

    def test_dropped_ack_replays_exact_bytes_and_id(self):
        box = self.box()
        box.enqueue("run", METRICS, batch_id="stable")
        originals = self.rows()
        with patch("nset_client.outbox.Transport.request", side_effect=OSError("lost acknowledgement")) as failed:
            with self.assertRaises(OSError):
                box.flush()
        self.assertEqual(self.rows(), originals)
        with patch("nset_client.outbox.Transport.request", side_effect=receipt) as retry:
            self.assertEqual(box.flush(), 1)
        self.assertEqual(failed.call_args, retry.call_args)
        self.assertIsNone(box.last_error)
        self.assertEqual(box.flush(), 0)

    def test_http_rejections_preserve_original_and_release_claim(self):
        box = self.box()
        box.enqueue("run", METRICS, batch_id="stable")
        originals = self.rows()
        for status in (401, 409, 429, 503):
            with self.subTest(status=status):
                with patch("nset_client.outbox.Transport.request", side_effect=APIError(status, "rejected")):
                    with self.assertRaises(APIError) as caught:
                        box.flush()
                self.assertEqual(caught.exception.status, status)
                self.assertIs(box.last_error, caught.exception)
                self.assertEqual(self.rows(), originals)
                self.assertFalse(box._state.claims)

    def test_acknowledged_id_conflict_remains_server_authority(self):
        box = self.box()
        box.enqueue("run", METRICS, batch_id="stable")
        with patch("nset_client.outbox.Transport.request", side_effect=receipt):
            box.flush()
        changed = [{"key": "loss", "step": 0, "value": 99}]
        box.enqueue("run", changed, batch_id="stable")
        with patch("nset_client.outbox.Transport.request", side_effect=APIError(409, "conflict")):
            with self.assertRaises(APIError):
                box.flush()
        self.assertEqual(json.loads(self.rows()[0][2]), {"metrics": changed})

    def test_all_malformed_receipts_retain_rows(self):
        box = self.box()
        box.enqueue("run", METRICS, batch_id="stable")
        good = {"run_id": "run", "batch_id": "stable", "state": "pending", "accepted": 1,
                "accepted_at": 123456}
        malformed = [None, [], {}, "ok"]
        for field, bad in (("run_id", "other"), ("batch_id", "other"), ("state", "received"),
                           ("accepted", 2), ("accepted", True), ("accepted", 1.0),
                           ("accepted_at", None), ("accepted_at", True), ("accepted_at", -1)):
            malformed.append(dict(good, **{field: bad}))
        for field in good:
            malformed.append({key: value for key, value in good.items() if key != field})
        for response in malformed:
            with self.subTest(response=response):
                with patch("nset_client.outbox.Transport.request", return_value=response):
                    with self.assertRaises(InvalidReceiptError):
                        box.flush()
                self.assertEqual(box.pending_count(), 1)
        with patch("nset_client.outbox.Transport.request", return_value=dict(good, state="applied")):
            self.assertEqual(box.flush(), 1)

    def test_cancellation_and_bad_json_retain_originals(self):
        box = self.box()
        box.enqueue("run", METRICS)
        original = self.rows()
        for error in (KeyboardInterrupt(), json.JSONDecodeError("bad", "", 0)):
            with patch("nset_client.outbox.Transport.request", side_effect=error):
                with self.assertRaises(type(error)):
                    box.flush()
            self.assertEqual(self.rows(), original)
            self.assertFalse(box._state.claims)

    def test_metric_validation_rejects_permanent_bad_rows_before_commit(self):
        box = self.box()
        invalid = [[], [None], [{}], [dict(METRICS[0], extra=1)],
                   [dict(METRICS[0], timestamp=None)], [dict(METRICS[0], timestamp=-1)],
                   [dict(METRICS[0], step=True)], [dict(METRICS[0], step=1.5)],
                   [dict(METRICS[0], step=2**53)], [dict(METRICS[0], value=True)],
                   [dict(METRICS[0], value=float("nan"))], [dict(METRICS[0], value=float("inf"))],
                   [dict(METRICS[0], value=10**400)], [dict(METRICS[0], key="")],
                   [dict(METRICS[0], key="é" * 257)], METRICS * 10001]
        for rows in invalid:
            with self.subTest(rows=str(rows)[:100]), self.assertRaises(ValueError):
                box.enqueue("run", rows)
        self.assertEqual(box.pending_count(), 0)
        box.enqueue("run", [dict(METRICS[0], step=2**53 - 1, timestamp=0)])

    def test_id_validation(self):
        box = self.box()
        for batch_id in ("", "a/b", "é", "x" * 129, "abc\n", 1):
            with self.subTest(batch_id=batch_id), self.assertRaises(ValueError):
                box.enqueue("run", METRICS, batch_id=batch_id)
        for run_id in ("", None, 1, "x" * 513, "a\nb"):
            with self.subTest(run_id=run_id), self.assertRaises(ValueError):
                box.enqueue(run_id, METRICS)
        self.assertEqual(box.pending_count(), 0)
        box.enqueue("run", METRICS, batch_id="Valid._-0123")

    def test_invalid_options_reject_before_creating_file(self):
        for name, values in {"workers": [0, 33, True, 1.5],
                             "max_pending_bytes": [0, -1, 2**63],
                             "max_pending_batches": [0, 1_000_001],
                             "retry_interval": [0, float("nan"), float("inf"), 3601]}.items():
            for value in values:
                with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                    self.box(**{name: value})
                self.assertFalse(self.path.exists())
        for timeout in (None, 0, -1, True, float("nan"), float("inf"), 301):
            self.client.http.timeout = timeout
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                self.box()
            self.assertFalse(self.path.exists())
        self.client.http.timeout = .05
        with self.assertRaises(ValueError):
            DurableOutbox(self.client, ":memory:")

    def test_destination_and_unknown_schema_rejected_without_payload_loss(self):
        box = self.box()
        box.enqueue("run", METRICS)
        original = self.rows()
        box.close()
        for url in ("http://localhost:8081", "https://localhost:8080", "http://localhost:8080/prefix"):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "destination"):
                DurableOutbox(Client(url, token="another"), self.path)
        self.assertEqual(self.rows(), original)
        with contextlib.closing(sqlite3.connect(self.path)) as db, db:
            db.execute("PRAGMA user_version=99")
        with self.assertRaisesRegex(ValueError, "schema"):
            self.box()
        with contextlib.closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone(), (99,))
        self.assertEqual(self.rows(), original)

    def test_flush_count_limits_and_partial_failure(self):
        box = self.box()
        for i in range(3):
            box.enqueue("run", METRICS * 2, batch_id=str(i))
        with patch("nset_client.outbox.Transport.request", side_effect=receipt):
            self.assertEqual(box.flush(max_batches=1), 1)
        self.assertEqual(box.pending_count(), 2)
        def partial(method, path, *, raw):
            if path.endswith("/2"):
                raise OSError("offline")
            return receipt(method, path, raw=raw)
        with patch("nset_client.outbox.Transport.request", side_effect=partial):
            with self.assertRaises(OSError):
                box.flush()
        self.assertEqual([row[1] for row in self.rows()], ["2"])
        for limit in (0, -1, True, 1.5):
            with self.assertRaises(ValueError):
                box.flush(limit)

    def test_busy_enqueue_and_busy_delete_preserve_original(self):
        box = self.box()
        box.enqueue("run", METRICS, batch_id="original")
        db = sqlite3.connect(self.path)
        self.addCleanup(db.close)
        db.execute("BEGIN IMMEDIATE")
        with self.assertRaises(sqlite3.OperationalError):
            box.enqueue("run", METRICS, batch_id="blocked")
        with patch("nset_client.outbox.Transport.request", side_effect=receipt):
            with self.assertRaises(sqlite3.OperationalError):
                box.flush()
        self.assertIsInstance(box.last_error, sqlite3.OperationalError)
        self.assertEqual([row[1] for row in self.rows()], ["original"])
        self.assertFalse(box._state.claims)
        db.rollback()
        with patch("nset_client.outbox.Transport.request", side_effect=receipt):
            self.assertEqual(box.flush(), 1)

    def test_concurrent_enqueue_and_flush_across_instances_only_one_claim(self):
        box = self.box(workers=4)
        second = self.box()
        box.enqueue("run", METRICS, batch_id="first")
        entered, release = threading.Event(), threading.Event()
        sends = []
        def slow(method, path, *, raw):
            sends.append(path)
            entered.set()
            self.assertTrue(release.wait(3))
            return receipt(method, path, raw=raw)
        with patch("nset_client.outbox.Transport.request", side_effect=slow):
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                delivery = pool.submit(box.flush)
                try:
                    self.assertTrue(entered.wait(3))
                    self.assertEqual(second.flush(), 0)
                    enqueues = [pool.submit(second.enqueue, "run", METRICS, batch_id=f"new-{i}")
                                for i in range(30)]
                    for future in enqueues:
                        future.result(3)
                finally:
                    release.set()
                self.assertEqual(delivery.result(3), 1)  # snapshot excludes concurrent enqueues
        self.assertEqual(len(sends), 1)
        self.assertEqual(second.pending_count(), 30)
        with patch("nset_client.outbox.Transport.request", side_effect=receipt):
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                counts = list(pool.map(lambda _: second.flush(), range(8)))
        self.assertEqual(sum(counts), 30)
        self.assertEqual(box.pending_count(), 0)

    def test_concurrent_enqueue_respects_capacity(self):
        box = self.box(max_pending_batches=5)
        def enqueue(i):
            try:
                box.enqueue("run", METRICS, batch_id=str(i))
                return True
            except OutboxFullError:
                return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(sum(pool.map(enqueue, range(30))), 5)
        self.assertEqual(box.pending_count(), 5)

    def test_background_backoff_multiple_workers_and_close_join(self):
        box = self.box(workers=4, retry_interval=.2)
        box.enqueue("run", METRICS)
        called = threading.Event()
        attempts = []
        def offline(*args, **kwargs):
            attempts.append(time.monotonic())
            called.set()
            raise OSError("offline")
        with patch("nset_client.outbox.Transport.request", side_effect=offline):
            self.assertIs(box.start(), box)
            box.start()
            self.assertEqual(len(box._threads), 4)
            self.assertTrue(called.wait(3))
            time.sleep(.08)
            self.assertEqual(len(attempts), 1)
            deadline = time.monotonic() + 3
            while len(attempts) < 2 and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertGreaterEqual(len(attempts), 2)
            self.assertGreaterEqual(attempts[1] - attempts[0], .19)
            box.close()
        self.assertTrue(all(not thread.is_alive() for thread in box._threads))
        self.assertIsInstance(box.last_error, OSError)
        self.assertEqual(self.box().pending_count(), 1)

    def test_background_delivery_and_request_timeout(self):
        box = self.box(workers=3, retry_interval=.01)
        self.assertEqual(box._http.timeout, .05)
        # The owned transport pins configuration even if the caller changes its Client.
        self.client.http.url = "http://different-host"
        self.client.http.timeout = None
        self.assertEqual(box._http.url, "http://localhost:8080")
        for i in range(15):
            box.enqueue("run", METRICS, batch_id=str(i))
        with patch("nset_client.outbox.Transport.request", side_effect=receipt) as send:
            box.start()
            deadline = time.monotonic() + 3
            while box.pending_count() and time.monotonic() < deadline:
                time.sleep(.01)
            box.close()
        self.assertEqual(send.call_count, 15)
        self.assertFalse(self.rows())
        self.assertIsNone(box.last_error)

    def test_close_waits_for_inflight_timeout_and_retains_pending(self):
        box = self.box(retry_interval=.01)
        box.enqueue("run", METRICS)
        entered = threading.Event()
        def timeout(*args, **kwargs):
            entered.set()
            time.sleep(box._http.timeout)
            raise TimeoutError("request timed out")
        with patch("nset_client.outbox.Transport.request", side_effect=timeout):
            box.start()
            self.assertTrue(entered.wait(3))
            started = time.monotonic()
            box.close()
            self.assertLess(time.monotonic() - started, 1)
        self.assertIsInstance(box.last_error, TimeoutError)
        self.assertEqual(self.box().pending_count(), 1)

    def test_actual_transport_receives_bounded_timeout_and_canonical_put(self):
        box = self.box()
        box.enqueue("run", METRICS, batch_id="bounded")
        box._http.opener = Mock()
        box._http.opener.open.side_effect = TimeoutError("timed out")
        with self.assertRaises(TimeoutError):
            box.flush()
        request = box._http.opener.open.call_args.args[0]
        self.assertEqual(request.get_method(), "PUT")
        self.assertEqual(request.full_url, "http://localhost:8080/api/runs/run/ingest/bounded")
        self.assertEqual(request.data, self.rows()[0][2])
        self.assertEqual(box._http.opener.open.call_args.kwargs["timeout"], .05)
        self.assertEqual(box.pending_count(), 1)

    def test_background_backoff_doubles_and_is_shared_by_instances(self):
        box = self.box(retry_interval=1)
        second = self.box(retry_interval=1)
        box.enqueue("run", METRICS, batch_id="retry")
        with patch("nset_client.outbox.time.monotonic", return_value=100) as clock:
            with patch("nset_client.outbox.Transport.request", side_effect=OSError("offline")) as send:
                with self.assertRaises(OSError):
                    box._flush(1, background=True)
                self.assertEqual(second._flush(1, background=True), 0)
                clock.return_value = 101
                with self.assertRaises(OSError):
                    second._flush(1, background=True)
                clock.return_value = 102.9
                self.assertEqual(box._flush(1, background=True), 0)
                clock.return_value = 103
                with self.assertRaises(OSError):
                    box._flush(1, background=True)
                self.assertEqual(send.call_count, 3)
                self.assertEqual(box._state.retries[("run", "retry")], (3, 107))
        self.assertIsInstance(box.last_error, OSError)  # empty flush did not clear it
        self.assertEqual(box.pending_count(), 1)

    def test_concurrent_close_waits_for_foreground_flush_without_deadlock(self):
        box = self.box()
        box.enqueue("run", METRICS)
        entered, release = threading.Event(), threading.Event()
        def slow(method, path, *, raw):
            entered.set()
            self.assertTrue(release.wait(3))
            return receipt(method, path, raw=raw)
        with patch("nset_client.outbox.Transport.request", side_effect=slow):
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                delivery = pool.submit(box.flush)
                try:
                    self.assertTrue(entered.wait(3))
                    close_one = pool.submit(box.close)
                    close_two = pool.submit(box.close)
                    time.sleep(.02)
                    self.assertFalse(close_one.done())
                    self.assertFalse(close_two.done())
                finally:
                    release.set()
                self.assertEqual(delivery.result(3), 1)
                close_one.result(3)
                close_two.result(3)
        self.assertEqual(self.box().pending_count(), 0)

    def test_interrupted_close_owner_releases_concurrent_follower(self):
        for interrupt_at in ("join", "wait"):
            with self.subTest(interrupt_at=interrupt_at):
                self.path = Path(self.temp.name) / f"{interrupt_at}.sqlite3"
                box = self.client.durable_outbox(self.path)
                box.enqueue("run", METRICS, batch_id="pending")
                originals = self.rows()
                entered, release = threading.Event(), threading.Event()
                owner_blocked, follower_waiting = threading.Event(), threading.Event()
                interrupted, successor_waiting = threading.Event(), threading.Event()
                interruption = KeyboardInterrupt("close interrupted")
                calls = []

                def call(function):
                    result = concurrent.futures.Future()
                    def run():
                        try:
                            result.set_result(function())
                        except BaseException as error:
                            result.set_exception(error)
                    thread = threading.Thread(target=run, daemon=True)
                    calls.append(thread)
                    return thread, result

                def slow(*args, **kwargs):
                    entered.set()
                    if not release.wait(3):
                        raise TimeoutError("test delivery was not released")
                    return {}  # No valid acceptance; the row must survive close.

                real_wait = box._condition.wait
                def wait(timeout=None):
                    current = threading.current_thread()
                    if current is owner and interrupt_at == "wait":
                        owner_blocked.set()
                        if not follower_waiting.is_set():
                            real_wait(3)  # Releases the lock for the follower.
                        if not follower_waiting.is_set():
                            raise TimeoutError("concurrent closer did not wait")
                        interrupted.set()
                        raise interruption
                    if current is follower:
                        if interrupted.is_set():
                            successor_waiting.set()
                        else:
                            follower_waiting.set()
                            box._condition.notify_all()
                    return real_wait(timeout)

                owner, owner_result = call(box.close)
                follower, follower_result = call(box.close)
                retry, retry_result = call(box.close)
                try:
                    with patch.object(box._http, "request", side_effect=slow):
                        if interrupt_at == "join":
                            box.start()
                            worker = box._threads[0]
                            real_join = worker.join
                            def join(timeout=None):
                                if threading.current_thread() is owner:
                                    owner_blocked.set()
                                    if not follower_waiting.wait(3):
                                        raise TimeoutError("concurrent closer did not wait")
                                    interrupted.set()
                                    raise interruption
                                successor_waiting.set()
                                return real_join(timeout)
                        else:
                            delivery, delivery_result = call(box.flush)
                            delivery.start()
                        self.assertTrue(entered.wait(3))
                        # In the wait case there are no workers to join.
                        join_patch = (patch.object(worker, "join", side_effect=join)
                                      if interrupt_at == "join" else
                                      patch.object(box, "_threads", []))
                        with join_patch, patch.object(box._condition, "wait", side_effect=wait):
                            owner.start()
                            self.assertTrue(owner_blocked.wait(3))
                            follower.start()
                            with self.assertRaises(KeyboardInterrupt) as caught:
                                owner_result.result(3)
                            self.assertIs(caught.exception, interruption)
                            self.assertTrue(successor_waiting.wait(3))
                            self.assertTrue(box._stop.is_set())
                            with box._condition:
                                self.assertEqual(box._active, 1)
                                self.assertFalse(box._closed)
                                self.assertEqual(box._db.execute("SELECT 1").fetchone(), (1,))
                            self.assertFalse(follower_result.done())
                            retry.start()
                            release.set()
                            follower_result.result(3)
                            retry_result.result(3)
                        if interrupt_at == "wait":
                            with self.assertRaises(InvalidReceiptError):
                                delivery_result.result(3)
                        self.assertIsInstance(box.last_error, InvalidReceiptError)
                        self.assertTrue(box._closed)
                finally:
                    release.set()
                    # Daemon callers and bounded joins keep regressions from hanging the suite.
                    for thread in calls:
                        if thread.ident is not None:
                            thread.join(3)
                self.assertTrue(all(not thread.is_alive() for thread in calls))
                box.close()
                reopened = self.box()
                self.assertEqual(reopened.pending_count(), 1)
                self.assertEqual(self.rows(), originals)

    def test_close_context_and_reopen_never_imply_flush(self):
        with patch("nset_client.outbox.Transport.request") as send:
            with self.assertRaisesRegex(RuntimeError, "training failure"):
                with self.box() as box:
                    box.enqueue("run", METRICS)
                    raise RuntimeError("training failure")
            send.assert_not_called()
            box.close()
            for operation in (box.start, box.flush, box.pending_count,
                              lambda: box.enqueue("run", METRICS)):
                with self.assertRaisesRegex(RuntimeError, "closed"):
                    operation()
        self.assertEqual(self.box().pending_count(), 1)

    def test_process_crash_during_claimed_delivery_keeps_replayable_rows(self):
        script = """
import os, sys
from nset_client import Client
box = Client(token='secret').durable_outbox(sys.argv[1])
box.enqueue('run', [{'key': 'loss', 'step': 0, 'value': 1.25}], batch_id='crash-stable')
box._http.request = lambda *args, **kwargs: os._exit(0)
box.flush()
"""
        env = dict(os.environ, PYTHONPATH=str(ROOT / "python"))
        subprocess.run([sys.executable, "-c", script, str(self.path)], env=env,
                       check=True, timeout=10)
        box = Client(token="replacement-secret").durable_outbox(self.path)
        self.addCleanup(box.close)
        self.assertEqual(box.pending_count(), 1)
        with patch("nset_client.outbox.Transport.request", side_effect=receipt):
            self.assertEqual(box.flush(), 1)


if __name__ == "__main__":
    unittest.main()
