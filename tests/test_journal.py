"""Directory-journal invariants, using real files and independent processes."""
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from support import IsolatedClientTestCase
from nset_client.journal import (BatchConflictError, DirectoryJournal,
                                 JournalCorruptionError, OutboxFullError)


DESTINATION = "http://localhost:8080"
PAYLOAD = '{"metrics":[{"key":"λ","step":0,"value":1.25}]}'.encode()

# Every child reaches the stdin barrier before any opens the journal. This also
# exercises simultaneous first-open and destination-manifest publication.
ENQUEUE_CHILD = """
import sys
from nset_client.journal import DirectoryJournal, BatchConflictError, OutboxFullError
path, batch, payload, max_bytes, max_batches = sys.argv[1:]
print('ready', flush=True)
sys.stdin.readline()
journal = DirectoryJournal(path, 'http://localhost:8080', timeout=2)
try:
    journal.enqueue('run', batch, bytes.fromhex(payload), 1,
                    max_bytes=int(max_bytes), max_batches=int(max_batches))
    print('accepted', flush=True)
except (BatchConflictError, OutboxFullError) as error:
    print(type(error).__name__, flush=True)
finally:
    journal.close()
"""

LOCK_CHILD = """
import sys
from nset_client.journal import DirectoryJournal
journal = DirectoryJournal(sys.argv[1], 'http://localhost:8080')
with journal._transaction():
    print('locked', flush=True)
    sys.stdin.readline()
journal.close()
"""


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nset-journal-test-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "journal"

    def journal(self, path=None, **kwargs):
        journal = DirectoryJournal(path or self.path, DESTINATION, **kwargs)
        self.addCleanup(journal.close)
        return journal

    def enqueue(self, journal, batch="batch", payload=PAYLOAD, run="run", **limits):
        journal.enqueue(run, batch, payload, 1,
                        max_bytes=limits.get("max_bytes", 100000),
                        max_batches=limits.get("max_batches", 100))

    def files(self, path=None):
        root = path or self.path
        return {p.name: p.read_bytes() for p in root.iterdir() if p.is_file()}

    def child(self, script, *args):
        process = subprocess.Popen([sys.executable, "-c", script, *map(str, args)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        def cleanup():
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)
        self.addCleanup(cleanup)
        return process

    def race(self, items, *, max_bytes=100000, max_batches=100):
        processes = [self.child(ENQUEUE_CHILD, self.path, batch, payload.hex(),
                                max_bytes, max_batches) for batch, payload in items]
        for process in processes:
            self.assertEqual(process.stdout.readline().strip(), "ready")
        for process in processes:
            process.stdin.write("go\n")
            process.stdin.flush()
        outcomes = []
        for process in processes:
            stdout, stderr = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 0, stderr)
            outcomes.append(stdout.strip())
        return outcomes

    def test_reopen_preserves_exact_bytes_order_and_run_filter(self):
        journal = self.journal()
        self.enqueue(journal, "first", run="run/λ")
        self.enqueue(journal, "second", payload=b'{ "metrics" : [1] }\n', run="other")
        ids = journal.snapshot()
        before = self.files()
        journal.close()
        reopened = self.journal()
        self.assertEqual(reopened.snapshot(), ids)
        self.assertEqual(reopened.snapshot("run/λ"), ids[:1])
        self.assertEqual(reopened.read(ids[0]), ("run/λ", "first", PAYLOAD, 1))
        self.assertEqual(reopened.read(ids[1])[2], b'{ "metrics" : [1] }\n')
        self.assertEqual(self.files(), before)

    def test_identical_pending_id_is_noop_even_at_capacity(self):
        journal = self.journal()
        self.enqueue(journal, max_bytes=len(PAYLOAD), max_batches=1)
        before = self.files()
        self.enqueue(journal, max_bytes=len(PAYLOAD), max_batches=1)
        self.assertEqual(self.files(), before)
        with self.assertRaises(BatchConflictError):
            self.enqueue(journal, payload=PAYLOAD + b" ")
        self.assertEqual(self.files(), before)

    def test_capacity_never_evicts_and_acknowledgement_frees_space(self):
        journal = self.journal()
        self.enqueue(journal, max_bytes=len(PAYLOAD), max_batches=1)
        before = self.files()
        for limits in ({"max_batches": 1}, {"max_bytes": len(PAYLOAD)}):
            with self.subTest(limits=limits), self.assertRaises(OutboxFullError):
                self.enqueue(journal, "second", **limits)
            self.assertEqual(self.files(), before)
        record = journal.snapshot()[0]
        self.assertEqual(journal.acknowledge(record, PAYLOAD), 1)
        self.enqueue(journal, "second", max_bytes=len(PAYLOAD), max_batches=1)
        self.assertEqual(len(journal.snapshot()), 1)

    def test_independent_processes_enforce_count_capacity(self):
        results = self.race([(f"b{i}", PAYLOAD) for i in range(6)], max_batches=3)
        self.assertEqual(results.count("accepted"), 3, results)
        self.assertEqual(results.count("OutboxFullError"), 3, results)
        journal = self.journal()
        self.assertEqual(len(journal.snapshot()), 3)
        self.assertEqual(len({journal.read(r)[1] for r in journal.snapshot()}), 3)

    def test_independent_processes_enforce_byte_capacity(self):
        results = self.race([(f"b{i}", PAYLOAD) for i in range(6)],
                            max_bytes=2 * len(PAYLOAD))
        self.assertEqual(results.count("accepted"), 2, results)
        self.assertEqual(results.count("OutboxFullError"), 4, results)
        journal = self.journal()
        self.assertEqual(sum(len(journal.read(r)[2]) for r in journal.snapshot()),
                         2 * len(PAYLOAD))

    def test_independent_processes_same_exact_id_publish_once(self):
        results = self.race([("same", PAYLOAD)] * 6, max_batches=1)
        self.assertEqual(results, ["accepted"] * 6)
        self.assertEqual(len(self.journal().snapshot()), 1)

    def test_independent_processes_same_different_id_conflict(self):
        payloads = [PAYLOAD + b" " * i for i in range(6)]
        results = self.race([("same", p) for p in payloads])
        self.assertEqual(results.count("accepted"), 1, results)
        self.assertEqual(results.count("BatchConflictError"), 5, results)
        journal = self.journal()
        self.assertEqual(len(journal.snapshot()), 1)
        self.assertEqual(journal.read(journal.snapshot()[0])[2],
                         payloads[results.index("accepted")])

    def test_late_acknowledgement_cannot_remove_replacement_generation(self):
        first, second = self.journal(), self.journal()
        self.enqueue(first)
        old = first.snapshot()[0]
        self.assertEqual(first.acknowledge(old, PAYLOAD + b" "), 0)
        self.assertEqual(second.acknowledge(old, PAYLOAD), 1)
        self.enqueue(second)  # Same identity AND bytes; publication must differ.
        new = second.snapshot()[0]
        self.assertNotEqual(old, new)
        self.assertEqual(first.acknowledge(old, PAYLOAD), 0)
        self.assertIsNone(first.read(old))
        self.assertEqual(first.snapshot(), [new])
        self.assertEqual(first.read(new)[2], PAYLOAD)

    def test_torn_temporary_files_are_ignored_and_preserved(self):
        journal = self.journal()
        self.enqueue(journal)
        ids = journal.snapshot()
        temporary = self.path / ".tmp-interrupted"
        temporary.write_bytes(b'{"version":1,')
        before = self.files()
        self.assertEqual(self.journal().snapshot(), ids)
        self.assertEqual(self.files(), before)
        self.assertEqual(temporary.read_bytes(), b'{"version":1,')

    def test_corrupted_complete_records_fail_closed_and_remain_untouched(self):
        for kind in ("truncate", "bitflip", "header"):
            with self.subTest(kind=kind):
                path = Path(self.temp.name) / kind
                journal = self.journal(path)
                self.enqueue(journal)
                record = path / journal.snapshot()[0]  # Prime metadata cache.
                data = record.read_bytes()
                corrupt = {"truncate": data[:-1], "bitflip": data[:-1] + b"!",
                           "header": b"!" + data[1:]}[kind]
                record.write_bytes(corrupt)
                before = self.files(path)
                with self.assertRaises(JournalCorruptionError):
                    journal.snapshot()
                with self.assertRaises(JournalCorruptionError):
                    self.enqueue(journal, "must-not-publish")
                with self.assertRaises(JournalCorruptionError):
                    journal.acknowledge(record.name, PAYLOAD)
                with self.assertRaises(JournalCorruptionError):
                    self.journal(path)
                self.assertEqual(self.files(path), before)

    def test_missing_or_corrupt_destination_fails_closed(self):
        journal = self.journal()
        self.enqueue(journal)
        manifest = self.path / "destination.json"
        for data in (b"not json", None):
            if data is None:
                manifest.unlink()
            else:
                manifest.write_bytes(data)
            before = self.files()
            with self.assertRaises(JournalCorruptionError):
                self.journal()
            self.assertEqual(self.files(), before)

    def test_destination_mismatch_preserves_pending_bytes(self):
        journal = self.journal()
        self.enqueue(journal)
        before = self.files()
        with self.assertRaisesRegex(ValueError, "destination"):
            DirectoryJournal(self.path, "http://elsewhere:8080")
        self.assertEqual(self.files(), before)

    def test_legacy_sqlite_rejection_does_not_modify_file(self):
        connection = sqlite3.connect(self.path)
        try:
            with connection:
                connection.execute("CREATE TABLE pending (payload BLOB)")
                connection.execute("INSERT INTO pending VALUES (?)", (PAYLOAD,))
        finally:
            connection.close()
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "prior client version"):
            self.journal()
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [self.path])

    @unittest.skipIf(os.name == "nt", "POSIX mode bits")
    def test_created_directories_and_files_are_private(self):
        journal = self.journal()
        self.enqueue(journal)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o700)
        for path in self.path.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600, path.name)

    @unittest.skipIf(os.name == "nt", "POSIX permissions and symlinks")
    def test_unsafe_directory_or_symlink_is_rejected_without_repair(self):
        self.path.mkdir(mode=0o755)
        self.path.chmod(0o755)
        with self.assertRaises(PermissionError):
            self.journal()
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o755)
        self.assertEqual(list(self.path.iterdir()), [])
        target = Path(self.temp.name) / "target"
        target.mkdir(mode=0o700)
        link = Path(self.temp.name) / "link"
        link.symlink_to(target, target_is_directory=True)
        with self.assertRaises(PermissionError):
            self.journal(link)
        self.assertEqual(list(target.iterdir()), [])

    def test_lock_wait_is_bounded_for_operation_and_open_deadline(self):
        journal = self.journal(timeout=.08)
        holder = self.child(LOCK_CHILD, self.path)
        self.assertEqual(holder.stdout.readline().strip(), "locked")
        try:
            start = time.monotonic()
            with self.assertRaises(TimeoutError):
                journal.snapshot()
            self.assertLess(time.monotonic() - start, .8)
            start = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, "deadline"):
                DirectoryJournal(self.path, DESTINATION, timeout=5,
                                 deadline=start + .04,
                                 timeout_error=lambda: RuntimeError("deadline"))
            self.assertLess(time.monotonic() - start, .8)
        finally:
            stdout, stderr = holder.communicate("release\n", timeout=5)
            self.assertEqual(holder.returncode, 0, (stdout, stderr))
        self.enqueue(journal)  # Timed-out opens did not strand the lock.

    def test_publication_survives_failure_after_atomic_rename(self):
        journal = self.journal()
        with patch("nset_client.journal.sync_directory", side_effect=OSError("interrupted")):
            with self.assertRaisesRegex(OSError, "interrupted"):
                self.enqueue(journal)
        reopened = self.journal()
        self.assertEqual(len(reopened.snapshot()), 1)
        self.assertEqual(reopened.read(reopened.snapshot()[0])[2], PAYLOAD)
        self.enqueue(reopened)  # Caller can safely retry uncertain publication.
        self.assertEqual(len(reopened.snapshot()), 1)

    def test_closed_handle_rejects_access_without_removing_pending_work(self):
        journal = self.journal()
        self.enqueue(journal)
        record = journal.snapshot()[0]
        before = self.files()
        journal.close()
        for operation in (journal.snapshot, lambda: journal.read(record),
                          lambda: journal.acknowledge(record, PAYLOAD),
                          lambda: self.enqueue(journal, "new")):
            with self.assertRaisesRegex(RuntimeError, "closed"):
                operation()
        self.assertEqual(self.files(), before)


class JournalDeliveryTests(IsolatedClientTestCase):
    def test_blocked_http_holds_neither_process_nor_outbox_state_lock(self):
        with tempfile.TemporaryDirectory(prefix="nset-journal-http-") as temporary:
            path = Path(temporary) / "journal"
            client = self.client(DESTINATION, token="must-not-be-persisted", timeout=.2)
            first = client.durable_outbox(path)
            second = client.durable_outbox(path)
            entered, release, enqueued = threading.Event(), threading.Event(), threading.Event()
            failures, delivered = [], []
            metrics = [{"key": "loss", "step": 0, "value": 1.25}]
            first.enqueue("run", metrics, batch_id="blocked")
            def request(method, url, *, raw):
                entered.set()
                if not release.wait(5):
                    raise TimeoutError("test did not release request")
                return {"run_id": "run", "batch_id": "blocked", "accepted": 1,
                        "state": "pending", "accepted_at": 123}
            def flush():
                try:
                    delivered.append(first.flush())
                except BaseException as error:
                    failures.append(error)
            def enqueue():
                try:
                    second.enqueue("run", metrics, batch_id="while-blocked")
                    with_journal = DirectoryJournal(path, DESTINATION, timeout=.1)
                    try:
                        self.assertEqual(len(with_journal.snapshot()), 2)
                    finally:
                        with_journal.close()
                    enqueued.set()
                except BaseException as error:
                    failures.append(error)
            sender = threading.Thread(target=flush, daemon=True)
            writer = threading.Thread(target=enqueue, daemon=True)
            try:
                with patch.object(first._http, "request", side_effect=request):
                    sender.start()
                    self.assertTrue(entered.wait(2), "HTTP was never entered")
                    writer.start()
                    try:
                        self.assertTrue(enqueued.wait(1), f"enqueue blocked by HTTP: {failures}")
                    finally:
                        release.set()
                        sender.join(3)
                        writer.join(3)
                self.assertFalse(sender.is_alive())
                self.assertFalse(writer.is_alive())
                self.assertEqual(failures, [])
                self.assertEqual(delivered, [1])
                self.assertEqual(second.pending_count(), 1)
                for file in path.iterdir():
                    self.assertNotIn(b"must-not-be-persisted", file.read_bytes())
            finally:
                release.set()
                first.close()
                second.close()


if __name__ == "__main__":
    unittest.main()
