"""Normal native APIs: local durability, honest lifecycle, and disposable HTTP."""
from concurrent.futures import ThreadPoolExecutor
import contextlib
import hashlib
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
from unittest.mock import patch

from support import ROOT, Server
from nset_client import (APIError, Client, DeliveryError, DeliveryTimeoutError,
                         OutboxFullError, Run)
from test_outbox import receipt


def private_path(root, url):
    return Path(root) / "nset" / "outbox" / hashlib.sha256(url.encode()).hexdigest() / "scalars.sqlite3"


def pending(path):
    with contextlib.closing(sqlite3.connect(path)) as db:
        return db.execute("SELECT run_id,batch_id,payload FROM outbox_pending ORDER BY id").fetchall()


class DefaultDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        patcher = patch("nset_client.client._spool_path", side_effect=lambda url: private_path(self.temp.name, url))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.clients = []
        self.addCleanup(self.cleanup_clients)

    def client(self, **kwargs):
        client = Client(token="never-persist-this-token", timeout=.05, flush_timeout=.1, **kwargs)
        self.clients.append(client)
        return client

    def cleanup_clients(self):
        for client in self.clients:
            try:
                client.close(timeout=0)
            except DeliveryError:
                pass

    def test_commits_exact_payload_before_return_without_network_wait(self):
        client = self.client()
        self.assertFalse(client.spool_path.exists())
        entered, release = threading.Event(), threading.Event()
        def blocked(*args, **kwargs):
            entered.set()
            release.wait(3)
            raise OSError("offline")
        with patch("nset_client.outbox.Transport.request", side_effect=blocked):
            try:
                run = Run(client, {"id": "run"})
                rows = [{"key": "\u03b1/loss", "step": 2, "value": -0.0},
                        {"key": "loss", "step": 2, "value": 1.25, "timestamp": 17}]
                self.assertEqual(run.log_batch(rows), {"accepted": 2})
                self.assertTrue(entered.wait(2))
                stored = pending(client.spool_path)[0]
                self.assertEqual(json.loads(stored[2])["metrics"], rows)
                self.assertIn(b'-0.0', stored[2])
                self.assertNotIn(b'timestamp', stored[2].split(b'},')[0])
                rows[0]["value"] = 999
                self.assertEqual(pending(client.spool_path)[0], stored)
                if os.name != "nt":
                    self.assertEqual(client.spool_path.stat().st_mode & 0o777, 0o600)
                    self.assertEqual(client.spool_path.parent.stat().st_mode & 0o777, 0o700)
                self.assertNotIn(b'never-persist-this-token', client.spool_path.read_bytes())
                started = time.monotonic()
                with self.assertRaises(DeliveryTimeoutError) as caught:
                    client.close(timeout=.05)
                self.assertLess(time.monotonic() - started, .5)
                self.assertEqual(caught.exception.spool_path, str(client.spool_path.resolve()))
                self.assertEqual(pending(client.spool_path)[0], stored)
                self.assertTrue(all(t.daemon for t in client._outbox._threads))
            finally:
                release.set()
        deadline = time.monotonic() + 2
        while not client._outbox._closed and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(client._outbox._closed)

    def test_retry_preserves_identity_and_idle_worker_restarts(self):
        client = self.client()
        run = Run(client, {"id": "run"})
        attempts = []
        def send(method, path, *, raw):
            attempts.append((path, raw))
            if len(attempts) == 1:
                raise OSError("response lost")
            return receipt(method, path, raw=raw)
        with patch("nset_client.outbox.Transport.request", side_effect=send):
            self.assertEqual(run.log_metrics({"loss": 2}, step=1), {"accepted": 1})
            run.flush(timeout=3)
            self.assertEqual(attempts[0], attempts[1])
            for i in range(12):
                run.log_metrics({"loss": i}, step=i)
                run.flush(timeout=2)
            self.assertEqual(pending(client.spool_path), [])
            deadline = time.monotonic() + 2
            while client._outbox._threads and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertFalse(client._outbox._threads)

    def test_permanent_errors_surface_and_reopen_can_recover(self):
        for status in (400, 401, 403, 404, 409, 413, 422):
            with self.subTest(status=status):
                client = self.client(url=f"http://127.0.0.1:{status}")
                run = Run(client, {"id": "run"})
                with patch("nset_client.outbox.Transport.request", side_effect=APIError(status, "rejected")) as send:
                    run.log_metrics({"loss": 1}, step=0)
                    with self.assertRaises(DeliveryError) as caught:
                        run.flush(timeout=2)
                    self.assertEqual(caught.exception.status, status)
                    time.sleep(.03)
                    self.assertEqual(send.call_count, 1)
                    with self.assertRaises(DeliveryError):
                        client.close(timeout=1)
                self.assertEqual(len(pending(client.spool_path)), 1)
                with patch("nset_client.outbox.Transport.request", side_effect=receipt):
                    restored = self.client(url=client.http.url)
                    restored.flush(timeout=3)
                    self.assertEqual(pending(client.spool_path), [])

    def test_run_context_does_not_finish_undelivered_data(self):
        client = self.client()
        run = Run(client, {"id": "run"})
        with patch("nset_client.outbox.Transport.request", side_effect=OSError("offline")):
            with patch.object(client.http, "request") as update:
                with self.assertRaises(DeliveryTimeoutError):
                    with run:
                        run.log_metrics({"v": 1}, step=0)
                update.assert_not_called()
                error = ValueError("training failed")
                with self.assertRaises(ValueError) as caught:
                    with run:
                        raise error
                self.assertIs(caught.exception, error)
                if hasattr(error, "__notes__"):
                    self.assertIn("retained", error.__notes__[0])
                update.assert_not_called()
        self.assertEqual(len(pending(client.spool_path)), 1)

    def test_successful_finish_waits_for_acceptance_and_rejects_late_logging(self):
        client = self.client()
        run = Run(client, {"id": "run"})
        with patch("nset_client.outbox.Transport.request", side_effect=receipt):
            run.log_metrics({"v": 1}, step=0)
            with patch.object(client.http, "request", return_value={"id": "run", "status": "finished"}) as update:
                run.finish(timeout=2)
                self.assertEqual(pending(client.spool_path), [])
                update.assert_called_once_with("PATCH", run.path, {"status": "finished"})
            with self.assertRaisesRegex(RuntimeError, "finished"):
                run.log_metrics({"v": 2}, step=1)

    def test_status_response_has_wall_clock_bound(self):
        client = self.client()
        run = Run(client, {"id": "run"})
        release = threading.Event()
        with patch.object(client.http, "request", side_effect=lambda *a: release.wait(3)):
            try:
                start = time.monotonic()
                with self.assertRaisesRegex(TimeoutError, "status uncertain"):
                    run.finish(timeout=.05)
                self.assertLess(time.monotonic() - start, .5)
            finally:
                release.set()

    def test_run_flush_is_scoped_and_client_close_preserves_other_runs(self):
        client = self.client()
        def send(method, path, *, raw):
            if '/bad/' in path:
                raise APIError(404, "missing")
            return receipt(method, path, raw=raw)
        with patch("nset_client.outbox.Transport.request", side_effect=send):
            bad, good = Run(client, {"id": "bad"}), Run(client, {"id": "good"})
            bad.log_metrics({"v": 1}, step=0)
            good.log_metrics({"v": 2}, step=0)
            good.flush(timeout=2)
            with self.assertRaises(DeliveryError):
                client.close(timeout=2)
        self.assertEqual([r[0] for r in pending(client.spool_path)], ["bad"])

    def test_capacity_validation_and_transaction_failure_never_report_acceptance(self):
        client = self.client()
        run = Run(client, {"id": "run"})
        with patch("nset_client.outbox.Transport.request", side_effect=OSError("offline")):
            run.log_metrics({"v": 1}, step=0)
            box = client._outbox
            box.max_pending_batches = 1
            with self.assertRaises(OutboxFullError):
                run.log_metrics({"v": 2}, step=1)
            with self.assertRaises(ValueError):
                run.log_metrics({"v": float("nan")}, step=2)
            box.max_pending_batches = 100
            with box._state.lock:
                box._db.execute("CREATE TRIGGER fail_insert BEFORE INSERT ON outbox_pending BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
            with self.assertRaises(sqlite3.IntegrityError):
                run.log_metrics({"v": 2}, step=1)
        self.assertEqual(len(pending(client.spool_path)), 1)

    def test_concurrent_clients_and_runs_share_safe_spool(self):
        clients = [self.client() for _ in range(4)]
        with patch("nset_client.outbox.Transport.request", side_effect=receipt):
            def log(i):
                run = Run(clients[i % 4], {"id": f"run-{i}"})
                for step in range(5):
                    run.log_metrics({"v": step}, step=step)
                run.flush(timeout=5)
            with ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(log, range(20)))
            for client in clients:
                client.flush(timeout=5)
            self.assertEqual(pending(clients[0].spool_path), [])

    def test_interrupted_close_still_stops_worker_and_retains_data(self):
        client = self.client()
        with patch("nset_client.outbox.Transport.request", side_effect=OSError("offline")):
            Run(client, {"id": "run"}).log_metrics({"v": 1}, step=0)
            with patch.object(client._outbox, "_wait", side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    client.close()
        self.assertTrue(client._outbox._stop.is_set())
        self.assertEqual(len(pending(client.spool_path)), 1)
        client.close()
        with self.assertRaisesRegex(RuntimeError, "closed"):
            Run(client, {"id": "run"}).log_metrics({"v": 1}, step=1)

    @unittest.skipIf(os.name == "nt", "POSIX permissions")
    def test_rejects_insecure_spool(self):
        client = self.client()
        client.spool_path.parent.mkdir(parents=True)
        client.spool_path.parent.chmod(0o777)
        with self.assertRaises(PermissionError):
            Run(client, {"id": "run"}).log_metrics({"v": 1}, step=0)
        self.assertFalse(client.spool_path.exists())

    def test_destination_binding_and_no_token_in_metadata(self):
        client = self.client()
        with patch("nset_client.outbox.Transport.request", side_effect=receipt):
            Run(client, {"id": "run"}).log_metrics({"v": 1}, step=0)
            client.flush(timeout=2)
            with contextlib.closing(sqlite3.connect(client.spool_path)) as db:
                self.assertEqual(db.execute("SELECT destination FROM outbox_meta").fetchall(), [(client.http.url,)])
            with patch("nset_client.client._spool_path", return_value=client.spool_path):
                with self.assertRaisesRegex(ValueError, "destination"):
                    self.client(url="http://different-server")

    @unittest.skipUnless(hasattr(os, "fork"), "fork unavailable")
    def test_inherited_client_rejected_before_any_lock(self):
        client = self.client()
        pid = os.fork()
        if pid == 0:
            try:
                Run(client, {"id": "run"}).log_metrics({"v": 1}, step=0)
            except RuntimeError:
                os._exit(0)
            os._exit(1)
        _, status = os.waitpid(pid, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 0)

    def test_detached_request_does_not_block_reopened_client(self):
        client = self.client()
        box = client._delivery()
        entered, release = threading.Event(), threading.Event()
        def stuck(*args, **kwargs):
            entered.set()
            release.wait(5)
            raise OSError("old connection failed")
        with patch.object(box._http, "request", side_effect=stuck):
            try:
                Run(client, {"id": "run"}).log_metrics({"v": 1}, step=0)
                self.assertTrue(entered.wait(2))
                before = pending(client.spool_path)
                with self.assertRaises(DeliveryTimeoutError):
                    client.close(timeout=.02)
                with patch("nset_client.outbox.Transport.request", side_effect=receipt) as send:
                    restored = self.client()
                    restored.flush(timeout=2)
                    self.assertEqual(send.call_args.kwargs['raw'], before[0][2])
                    self.assertEqual(pending(client.spool_path), [])
            finally:
                release.set()

    def test_blocked_generator_does_not_hold_shutdown_lock(self):
        client = self.client()
        entered, release = threading.Event(), threading.Event()
        errors = []
        def rows():
            entered.set()
            release.wait(3)
            yield {"key": "v", "step": 0, "value": 1}
        def log():
            try:
                Run(client, {"id": "run"}).log_batch(rows())
            except RuntimeError as error:
                errors.append(error)
        thread = threading.Thread(target=log, daemon=True)
        thread.start()
        try:
            self.assertTrue(entered.wait(2))
            start = time.monotonic()
            client.close(timeout=.02)
            self.assertLess(time.monotonic() - start, .5)
        finally:
            release.set()
            thread.join(2)
        self.assertEqual(len(errors), 1)
        self.assertFalse(client.spool_path.exists())

    def test_waits_for_lifecycle_locks_are_bounded(self):
        client = self.client()
        run = Run(client, {"id": "run"})
        for lock, operation in ((client._lock, client.close), (run._lock, run.finish),
                                (client._delivery()._state.lock, run.flush)):
            entered, release = threading.Event(), threading.Event()
            def hold():
                with lock:
                    entered.set()
                    release.wait(3)
            thread = threading.Thread(target=hold, daemon=True)
            thread.start()
            try:
                self.assertTrue(entered.wait(2))
                start = time.monotonic()
                with self.assertRaises(DeliveryTimeoutError):
                    operation(timeout=.02)
                self.assertLess(time.monotonic() - start, .5)
            finally:
                release.set()
                thread.join(2)

    def test_batch_iterator_is_bounded_before_validation(self):
        client = self.client()
        seen = []
        def rows():
            for i in range(20000):
                seen.append(i)
                yield {"key": "v", "step": i, "value": 1}
        with self.assertRaises(ValueError):
            Run(client, {"id": "run"}).log_batch(rows())
        self.assertEqual(len(seen), 10001)
        self.assertEqual(pending(client.spool_path), [])


    def test_concurrent_closer_waits_and_observes_delivery_failure(self):
        client = self.client()
        with patch("nset_client.outbox.Transport.request", side_effect=OSError("offline")):
            Run(client, {"id": "run"}).log_metrics({"v": 1}, step=0)
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(client.close, timeout=.2)
                deadline = time.monotonic() + 2
                while not client._closed and time.monotonic() < deadline:
                    time.sleep(.005)
                second = pool.submit(client.close, timeout=1)
                for future in (first, second):
                    with self.assertRaises(DeliveryTimeoutError):
                        future.result(2)
        self.assertEqual(len(pending(client.spool_path)), 1)

    def test_wal_initialization_retries_only_busy_with_a_bound(self):
        from nset_client.outbox import _enable_wal
        from unittest.mock import Mock
        db = Mock()
        cursor = Mock()
        cursor.fetchone.return_value = ('wal',)
        db.execute.side_effect = [sqlite3.OperationalError('database is locked'), cursor]
        _enable_wal(db, .1)
        self.assertEqual(db.execute.call_count, 2)
        db.execute.side_effect = sqlite3.OperationalError('database is locked')
        start = time.monotonic()
        with self.assertRaises(sqlite3.OperationalError):
            _enable_wal(db, .02)
        self.assertLess(time.monotonic() - start, .2)
        db.execute.side_effect = sqlite3.OperationalError('disk I/O error')
        db.reset_mock()
        with self.assertRaises(sqlite3.OperationalError):
            _enable_wal(db, .1)
        self.assertEqual(db.execute.call_count, 1)

    @unittest.skipIf(os.name == 'nt', 'POSIX symlink permissions')
    def test_spool_symlink_is_rejected_without_touching_target(self):
        client = self.client()
        from nset_client.client import _private_spool
        _private_spool(client.spool_path)
        client.spool_path.unlink()
        target = Path(self.temp.name) / 'untouched'
        target.write_text('retain me')
        client.spool_path.symlink_to(target)
        with self.assertRaises(PermissionError):
            Run(client, {'id': 'run'}).log_metrics({'v': 1}, step=0)
        self.assertEqual(target.read_text(), 'retain me')


    def test_worker_start_failure_keeps_local_acceptance_unambiguous(self):
        client = self.client()
        with patch('threading.Thread.start', side_effect=RuntimeError('no threads available')):
            self.assertEqual(Run(client, {'id': 'run'}).log_metrics({'v': 1}, step=0), {'accepted': 1})
            self.assertFalse(client._outbox._threads)
            with self.assertRaisesRegex(DeliveryError, 'could not start scalar delivery'):
                client.flush(timeout=1)
        self.assertEqual(len(pending(client.spool_path)), 1)
        with patch('nset_client.outbox.Transport.request', side_effect=receipt) as send:
            client.flush(timeout=2)
            self.assertEqual(send.call_count, 1)
        self.assertEqual(pending(client.spool_path), [])


    def test_final_sqlite_checkpoint_does_not_block_close(self):
        from unittest.mock import Mock
        client = self.client()
        box = client._delivery()
        original = box._db
        entered, release = threading.Event(), threading.Event()
        proxy = Mock(wraps=original)
        def close():
            entered.set()
            release.wait(3)
            original.close()
        proxy.close.side_effect = close
        box._db = proxy
        try:
            start = time.monotonic()
            client.close(timeout=.05)
            self.assertLess(time.monotonic() - start, .5)
            self.assertTrue(entered.wait(2))
        finally:
            release.set()
        deadline = time.monotonic() + 2
        while not box._closed and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(box._closed)



class DefaultDeliveryHTTPTests(unittest.TestCase):
    def setUp(self):
        self.server = Server().start()
        self.addCleanup(self.server.close)
        self.client = self.server.client
        self.run = self.client.start_run(self.client.experiment("normal delivery"), "run")

    def readback(self, run_id, key, count):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            rows = list(self.client.metric_history(run_id, key))
            if len(rows) == count:
                return rows
            time.sleep(.02)
        self.fail(f"expected {count} rows; got {len(rows)}")

    def test_normal_context_and_exact_scalar_readback(self):
        with self.run as run:
            self.assertEqual(run.log_metrics({"\u03b1/loss": -0.0}, step=4, timestamp=17), {"accepted": 1})
            self.assertEqual(run.log_batch([
                {"key": "\u03b1/loss", "step": 4, "value": 1.2345678901234567, "timestamp": 18},
                {"key": "\u03b1/loss", "step": 9_007_199_254_740_991, "value": 3, "timestamp": 0},
            ]), {"accepted": 2})
        self.assertEqual(self.client.http.request("GET", run.path)["status"], "finished")
        rows = self.readback(run.id, "\u03b1/loss", 3)
        self.assertEqual([(r['step'], r['value'], r['timestamp']) for r in rows],
                         [(4, -0.0, 17), (4, 1.2345678901234567, 18), (9_007_199_254_740_991, 3, 0)])

    def test_outage_retains_then_recovers_without_duplicate_logging(self):
        self.server.stop()
        self.assertEqual(self.run.log_metrics({"v": 1}, step=0), {"accepted": 1})
        self.run.log_batch([{"key": "v", "step": 1, "value": 2, "timestamp": 123}])
        with self.assertRaises(DeliveryTimeoutError):
            self.run.finish(timeout=.1)
        self.assertEqual(len(pending(self.client.spool_path)), 2)
        self.server.start()
        self.assertEqual(self.client.http.request("GET", self.run.path)["status"], "running")
        self.run.finish(timeout=10)
        rows = self.readback(self.run.id, "v", 2)
        self.assertEqual([r['value'] for r in rows], [1, 2])
        self.assertEqual(rows[1]['timestamp'], 123)

    def test_response_loss_retries_same_bytes_id_and_acceptance_timestamp(self):
        box = self.client._delivery()
        original = box._http.request
        attempts, receipts = [], []
        def lose(method, path, **kwargs):
            attempts.append((path, kwargs["raw"]))
            result = original(method, path, **kwargs)
            receipts.append(result)
            if len(attempts) == 1:
                raise OSError("lost response after server acceptance")
            return result
        with patch.object(box._http, "request", side_effect=lose):
            self.run.log_metrics({"v": 1.25}, step=5)
            self.run.flush(timeout=10)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0], attempts[1])
        self.assertEqual(receipts[0]['accepted_at'], receipts[1]['accepted_at'])
        rows = self.readback(self.run.id, "v", 1)
        self.assertEqual(rows[0]['timestamp'], receipts[0]['accepted_at'])

    def subprocess_env(self):
        home = self.server.directory / "child-home"
        home.mkdir(exist_ok=True)
        return dict(os.environ, HOME=str(home), XDG_STATE_HOME=str(home / 'state'),
                    LOCALAPPDATA=str(home / 'local'), PYTHONPATH=str(ROOT / "python"),
                    NSET_TEST_URL=self.server.url, NSET_TEST_TOKEN=self.server.token,
                    NSET_TEST_RUN=self.run.id)

    def test_hard_exit_resume_uses_only_normal_client(self):
        self.server.stop()
        env = self.subprocess_env()
        produce = '''import os
from nset_client import Client, Run
c = Client(os.environ['NSET_TEST_URL'], token=os.environ['NSET_TEST_TOKEN'], timeout=.1)
r = Run(c, {'id': os.environ['NSET_TEST_RUN']})
assert r.log_metrics({'v': 7}, step=9, timestamp=123) == {'accepted': 1}
print(c.spool_path, flush=True)
os._exit(0)
'''
        first = subprocess.run([sys.executable, '-c', produce], env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(first.returncode, 0, first.stderr)
        path = Path(first.stdout.strip())
        before = pending(path)
        self.assertEqual(len(before), 1)
        self.server.start()
        consume = '''import os
from nset_client import Client
with Client(os.environ['NSET_TEST_URL'], token=os.environ['NSET_TEST_TOKEN']) as c:
    c.flush(timeout=10)
'''
        second = subprocess.run([sys.executable, '-c', consume], env=env, capture_output=True, text=True, timeout=15)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(pending(path), [])
        self.assertEqual([(r['step'], r['value'], r['timestamp']) for r in self.readback(self.run.id, 'v', 1)], [(9, 7, 123)])

    def test_crash_after_server_acceptance_replays_once_after_restart(self):
        env = self.subprocess_env()
        produce = """import os, threading
from nset_client import Client, Run
c = Client(os.environ['NSET_TEST_URL'], token=os.environ['NSET_TEST_TOKEN'])
box = c._delivery()
send = box._http.request
def crash(*args, **kwargs):
    send(*args, **kwargs)
    os._exit(0)  # Accepted remotely, before the local receipt/deletion.
box._http.request = crash
print(c.spool_path, flush=True)
Run(c, {'id': os.environ['NSET_TEST_RUN']}).log_metrics({'v': 3}, step=2)
threading.Event().wait(10)
os._exit(1)
"""
        first = subprocess.run([sys.executable, '-c', produce], env=env, capture_output=True, text=True, timeout=15)
        self.assertEqual(first.returncode, 0, first.stderr)
        path = Path(first.stdout.strip())
        rows = pending(path)
        self.assertEqual(len(rows), 1)
        accepted = self.client.http.request('GET', self.run.path + '/ingest/' + rows[0][1])
        self.server.stop()
        self.server.start()
        consume = """import os
from nset_client import Client
with Client(os.environ['NSET_TEST_URL'], token=os.environ['NSET_TEST_TOKEN']) as c:
    c.flush(timeout=10)
"""
        second = subprocess.run([sys.executable, '-c', consume], env=env, capture_output=True, text=True, timeout=15)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(pending(path), [])
        visible = self.readback(self.run.id, 'v', 1)
        self.assertEqual(visible[0]['timestamp'], accepted['accepted_at'])

    def test_parallel_processes_share_destination_spool(self):
        env = self.subprocess_env()
        code = '''import os, sys
from nset_client import Client, Run
with Client(os.environ['NSET_TEST_URL'], token=os.environ['NSET_TEST_TOKEN']) as c:
    r = Run(c, {'id': os.environ['NSET_TEST_RUN']})
    for i in range(20):
        r.log_metrics({'v': int(sys.argv[1]) * 20 + i}, step=i, timestamp=1)
'''
        processes = [subprocess.Popen([sys.executable, '-c', code, str(i)], env=env,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for i in range(3)]
        try:
            results = [(process, process.communicate(timeout=20)) for process in processes]
            for process, (stdout, stderr) in results:
                self.assertEqual(process.returncode, 0, stdout + stderr)
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)
        rows = self.readback(self.run.id, 'v', 60)
        self.assertEqual(sorted(r['value'] for r in rows), list(range(60)))

    def test_server_auth_error_retained_and_rotated_token_recovers(self):
        bad = Client(self.server.url, token='incorrect', flush_timeout=2)
        try:
            Run(bad, self.run.data).log_metrics({'v': 1}, step=0)
            with self.assertRaises(DeliveryError) as caught:
                bad.flush()
            self.assertEqual(caught.exception.status, 401)
            with self.assertRaises(DeliveryError):
                bad.close()
            self.assertEqual(len(pending(bad.spool_path)), 1)
        finally:
            bad.close(timeout=0)
        with Client(self.server.url, token=self.server.token) as restored:
            restored.flush(timeout=10)
        self.readback(self.run.id, 'v', 1)

    def test_stalled_http_response_has_bounded_close_and_recoverable_replay(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        accepted, release = threading.Event(), threading.Event()
        native = self.client
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_PUT(self):
                raw = self.rfile.read(int(self.headers['Content-Length']))
                result = native.http.request('PUT', self.path, raw=raw)
                first = not accepted.is_set()
                accepted.set()
                if first:
                    release.wait(10)
                body = json.dumps(result).encode()
                self.send_response(202)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        proxy = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        proxy.daemon_threads = True
        worker = threading.Thread(target=proxy.serve_forever, daemon=True)
        worker.start()
        url = f'http://127.0.0.1:{proxy.server_port}'
        client = Client(url, token=self.server.token)
        try:
            Run(client, self.run.data).log_metrics({'v': 9}, step=1)
            self.assertTrue(accepted.wait(5))
            before = pending(client.spool_path)
            start = time.monotonic()
            with self.assertRaises(DeliveryTimeoutError):
                client.close(timeout=.05)
            self.assertLess(time.monotonic() - start, .5)
            self.assertEqual(pending(client.spool_path), before)
            with Client(url, token=self.server.token) as restored:
                restored.flush(timeout=5)
            self.assertEqual(pending(client.spool_path), [])
            self.assertEqual(self.readback(self.run.id, 'v', 1)[0]['value'], 9)
        finally:
            release.set()
            client.close(timeout=0)
            proxy.shutdown()
            proxy.server_close()
            worker.join(2)

    def test_flush_means_acceptance_not_projection(self):
        self.server.stop()
        with patch.dict(os.environ, NSET_INGEST_PAUSED='true'):
            self.server.start()
        self.run.log_metrics({'v': 1}, step=0)
        self.run.finish(timeout=10)
        self.assertEqual(pending(self.client.spool_path), [])
        self.assertEqual(list(self.client.metric_history(self.run.id, 'v')), [])
        self.assertEqual(self.client.http.request('GET', self.run.path)['status'], 'finished')
        self.server.stop()
        with patch.dict(os.environ, NSET_INGEST_PAUSED='false'):
            self.server.start()
        self.readback(self.run.id, 'v', 1)


if __name__ == '__main__':
    unittest.main()
