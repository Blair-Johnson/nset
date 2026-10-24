"""Explicit native scalar delivery backed by a plaintext SQLite WAL spool.

Enqueue commits locally, not remotely. A valid receipt means server acceptance,
not query visibility. Protect the spool directory: metric values and destination
URL are plaintext (credentials are never persisted). Back up SQLite consistently,
including its WAL; durability depends on the filesystem/device honoring fsync.
This is not a W&B/MLflow adapter and does not change legacy logging methods.
"""
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from urllib.parse import quote
import uuid
import weakref

from .transport import Transport

_MAX_SAFE = 9_007_199_254_740_991
_MAX_BODY = 32 * 1024 * 1024  # Native HTTP body limit (src/config.rs).
_BATCH_ID = re.compile(r"[A-Za-z0-9._-]{1,128}\Z")
_REGISTRY_LOCK = threading.Lock()
_REGISTRY = weakref.WeakValueDictionary()


class OutboxFullError(RuntimeError):
    """Enqueue exceeded a local capacity limit; nothing was evicted."""


class BatchConflictError(ValueError):
    """A pending (run_id, batch_id) already has different canonical bytes."""


class InvalidReceiptError(RuntimeError):
    """A response did not prove acceptance of the exact pending batch."""


class _SpoolState:
    def __init__(self):
        self.lock = threading.RLock()
        self.claims = set()
        self.retries = {}


def _integer(value, label, maximum):
    if type(value) is not int or not 1 <= value <= maximum:
        raise ValueError(f"{label} must be an integer in 1..{maximum}")
    return value


def _seconds(value, label, minimum, maximum):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not minimum <= value <= maximum or not math.isfinite(value)):
        raise ValueError(f"{label} must be finite and in {minimum}..{maximum} seconds")
    return float(value)


def _payload(metrics):
    rows = []
    for metric in metrics:
        if len(rows) == 10000:
            raise ValueError("a batch must contain 1..10000 metric observations")
        if not isinstance(metric, dict) or not {"key", "step", "value"} <= metric.keys():
            raise ValueError("each metric needs key, step and value")
        if metric.keys() - {"key", "step", "value", "timestamp"}:
            raise ValueError("unknown metric fields")
        row = dict(metric)
        key = row["key"]
        if not isinstance(key, str) or not 1 <= len(key.encode("utf-8")) <= 512:
            raise ValueError("metric keys must be 1..512 UTF-8 bytes")
        for field in ("step", "timestamp"):
            if field in row and (type(row[field]) is not int or not 0 <= row[field] <= _MAX_SAFE):
                raise ValueError(f"{field} must be a nonnegative JS-safe integer")
        value = row["value"]
        try:
            finite = type(value) in (int, float) and math.isfinite(value)
        except OverflowError:
            finite = False
        if not finite:
            raise ValueError("metric value must be a finite number")
        rows.append(row)
    if not rows:
        raise ValueError("a batch must contain 1..10000 metric observations")
    payload = json.dumps({"metrics": rows}, sort_keys=True, separators=(",", ":"),
                         ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(payload) > _MAX_BODY:
        raise ValueError(f"canonical batch payload exceeds the {_MAX_BODY}-byte HTTP body limit")
    return payload, len(rows)


class DurableOutbox:
    """Locally durable, bounded, explicit native scalar outbox.

    The parent directory must exist. ``client`` supplies a destination, token and
    timeout, captured at construction; reopen to rotate credentials. Its timeout
    must be finite and in 0.001..300 seconds. SQLite busy waits are at most 5s.
    Socket timeouts bound blocking socket operations, not an absolute wall-clock
    deadline (e.g. DNS resolution or a peer trickling bytes can take longer).

    ``flush`` returns the number of batches this call acknowledged AND deleted,
    never the observation count. It considers a snapshot of pending row IDs,
    skips rows claimed by other callers, and raises on the first failure. Earlier
    successes remain deleted if a later attempt fails; the failed row remains.
    Explicit flush retries immediately; background delivery uses per-row capped
    exponential backoff. Concurrent flush calls can therefore return zero while
    other callers own pending work. Separate processes may replay the same row;
    server batch-ID idempotency remains authoritative.

    ``last_error`` is the latest delivery failure, cleared by a successful
    delivery (not by an empty flush). ``start`` is optional and idempotent.
    ``close`` stops and joins background workers and waits for active flushes;
    it does NOT flush or discard pending data. Context entry does not start
    delivery and context exit only closes, even on an exception. After close,
    reopen the same file to inspect or deliver remaining rows.

    Each canonical HTTP payload must fit the native 32 MiB body limit.
    Limits bound pending canonical payload bytes/count, not physical SQLite file
    size. Same-ID different bytes are rejected locally only while pending; after
    acknowledgement, conflicts are the server's responsibility.
    """

    def __init__(self, client, path, *, max_pending_bytes=268435456,
                 max_pending_batches=10000, workers=1, retry_interval=1.0):
        self.max_pending_bytes = _integer(max_pending_bytes, "max_pending_bytes", 2**63 - 1)
        self.max_pending_batches = _integer(max_pending_batches, "max_pending_batches", 1_000_000)
        self.workers = _integer(workers, "workers", 32)
        self.retry_interval = _seconds(retry_interval, "retry_interval", 0.01, 3600)
        timeout = _seconds(client.http.timeout, "client timeout", 0.001, 300)
        self._http = Transport(client.http.url, client.http.token, timeout)
        if os.fspath(path) == ":memory:":
            raise ValueError("outbox requires a file, not an in-memory database")
        self.path = str(Path(path).resolve())
        with _REGISTRY_LOCK:
            self._state = _REGISTRY.get(self.path)
            if self._state is None:
                self._state = _SpoolState()
                _REGISTRY[self.path] = self._state
        self._condition = threading.Condition(self._state.lock)
        self._stop = threading.Event()
        self._threads = []
        self._active = 0
        self._closing = False
        self._closed = False
        self._last_error = None
        with self._state.lock:
            self._db = sqlite3.connect(self.path, timeout=min(timeout, 5), check_same_thread=False)
            try:
                version = self._db.execute("PRAGMA user_version").fetchone()[0]
                if version not in (0, 1):
                    raise ValueError("unsupported outbox schema version")
                if self._db.execute("PRAGMA journal_mode=WAL").fetchone()[0] != "wal":
                    raise RuntimeError("outbox requires SQLite WAL mode")
                self._db.execute("PRAGMA synchronous=FULL")
                with self._db:
                    self._db.execute("BEGIN IMMEDIATE")
                    self._db.execute("CREATE TABLE IF NOT EXISTS outbox_meta (destination TEXT NOT NULL)")
                    self._db.execute("""CREATE TABLE IF NOT EXISTS outbox_pending (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        run_id TEXT NOT NULL, batch_id TEXT NOT NULL,
                        payload BLOB NOT NULL, accepted INTEGER NOT NULL,
                        UNIQUE(run_id, batch_id))""")
                    destinations = self._db.execute("SELECT destination FROM outbox_meta").fetchall()
                    if not destinations:
                        self._db.execute("INSERT INTO outbox_meta VALUES (?)", (self._http.url,))
                    elif destinations != [(self._http.url,)]:
                        raise ValueError("outbox destination does not match client URL")
                    self._db.execute("PRAGMA user_version=1")
            except BaseException:
                self._db.close()
                raise

    def _check_open(self):
        if self._closing or self._closed:
            raise RuntimeError("outbox is closed")

    @property
    def last_error(self):
        with self._state.lock:
            return self._last_error

    def enqueue(self, run_id, metrics, *, batch_id=None):
        """Return the stable ID only after a FULL-synchronous local commit.

        IDs are scoped by run. An identical pending enqueue is a no-op; a
        different canonical payload raises BatchConflictError. No network I/O.
        """
        if (not isinstance(run_id, str) or not 1 <= len(run_id.encode("utf-8")) <= 512
                or any(ord(c) < 32 or ord(c) == 127 for c in run_id)):
            raise ValueError("run_id must be 1..512 UTF-8 bytes without control characters")
        if batch_id is None:
            batch_id = uuid.uuid4().hex
        if not isinstance(batch_id, str) or not _BATCH_ID.fullmatch(batch_id):
            raise ValueError("batch_id must be 1..128 ASCII letters, digits, dot, underscore or hyphen")
        payload, accepted = _payload(metrics)
        with self._state.lock:
            self._check_open()
            with self._db:
                self._db.execute("BEGIN IMMEDIATE")
                existing = self._db.execute(
                    "SELECT payload FROM outbox_pending WHERE run_id=? AND batch_id=?",
                    (run_id, batch_id)).fetchone()
                if existing:
                    if existing[0] != payload:
                        raise BatchConflictError("pending batch ID already has a different payload")
                else:
                    count, size = self._db.execute(
                        "SELECT count(*), coalesce(sum(length(payload)), 0) FROM outbox_pending").fetchone()
                    if count >= self.max_pending_batches or size + len(payload) > self.max_pending_bytes:
                        raise OutboxFullError("outbox capacity exceeded; existing batches retained")
                    self._db.execute(
                        "INSERT INTO outbox_pending(run_id,batch_id,payload,accepted) VALUES (?,?,?,?)",
                        (run_id, batch_id, payload, accepted))
        return batch_id

    def pending_count(self):
        with self._state.lock:
            self._check_open()
            return self._db.execute("SELECT count(*) FROM outbox_pending").fetchone()[0]

    def flush(self, max_batches=None):
        """Deliver pending durable PUTs; return deleted batch count or raise.

        ``None`` considers all rows present at entry; otherwise 1..1,000,000.
        Rows added during this call are left for a later call.
        """
        return self._flush(max_batches, background=False)

    def _flush(self, max_batches, *, background):
        if max_batches is not None:
            _integer(max_batches, "max_batches", 1_000_000)
        with self._condition:
            self._check_open()
            self._active += 1
        try:
            with self._state.lock:
                ids = [r[0] for r in self._db.execute("SELECT id FROM outbox_pending ORDER BY id")]
            count = 0
            for row_id in ids:
                with self._state.lock:
                    if self._stop.is_set() or (max_batches is not None and count >= max_batches):
                        break
                    row = self._db.execute(
                        "SELECT run_id,batch_id,payload,accepted FROM outbox_pending WHERE id=?",
                        (row_id,)).fetchone()
                    if row is None:
                        continue
                    run_id, batch_id, payload, accepted = row
                    key = (run_id, batch_id)
                    if key in self._state.claims:
                        continue
                    failures, ready_at = self._state.retries.get(key, (0, 0))
                    if background and time.monotonic() < ready_at:
                        continue
                    self._state.claims.add(key)
                try:
                    receipt = self._http.request(
                        "PUT", f"/api/runs/{quote(run_id, safe='')}/ingest/{batch_id}", raw=payload)
                    if (not isinstance(receipt, dict)
                            or receipt.get("batch_id") != batch_id
                            or receipt.get("run_id") != run_id
                            or receipt.get("state") not in ("pending", "applied")
                            or type(receipt.get("accepted")) is not int
                            or receipt["accepted"] != accepted
                            or type(receipt.get("accepted_at")) is not int
                            or not 0 <= receipt["accepted_at"] <= _MAX_SAFE):
                        raise InvalidReceiptError("receipt does not match the pending batch")
                    with self._state.lock:
                        with self._db:
                            deleted = self._db.execute(
                                "DELETE FROM outbox_pending WHERE id=? AND payload=?",
                                (row_id, payload)).rowcount
                        count += deleted
                        self._state.retries.pop(key, None)
                        self._last_error = None
                except BaseException as error:
                    with self._state.lock:
                        self._last_error = error
                        failures = min(failures + 1, 16)
                        delay = min(self.retry_interval * 2 ** (failures - 1),
                                    max(60.0, self.retry_interval))
                        self._state.retries[key] = (failures, time.monotonic() + delay)
                    raise
                finally:
                    with self._state.lock:
                        self._state.claims.discard(key)
            return count
        except BaseException as error:
            with self._state.lock:
                self._last_error = error
            raise
        finally:
            with self._condition:
                self._active -= 1
                self._condition.notify_all()

    def start(self):
        """Start optional background delivery, returning self; no implicit drain."""
        with self._state.lock:
            self._check_open()
            if not self._threads:
                for index in range(self.workers):
                    thread = threading.Thread(target=self._worker,
                                              name=f"nset-outbox-{index}", daemon=True)
                    thread.start()
                    self._threads.append(thread)
        return self

    def _worker(self):
        while not self._stop.is_set():
            try:
                if self._flush(None, background=True):
                    continue
            except Exception as error:
                with self._state.lock:
                    if not self._closing:
                        self._last_error = error
            self._stop.wait(min(self.retry_interval, 0.1))

    def close(self):
        """Stop/join delivery and close SQLite without flushing or dropping rows."""
        owner = False
        try:
            with self._condition:
                self._condition.wait_for(lambda: self._closed or not self._closing)
                if self._closed:
                    return
                owner = True
                self._closing = True
                self._stop.set()
            for thread in self._threads:
                thread.join()
            with self._condition:
                self._condition.wait_for(lambda: self._active == 0)
                self._db.close()
                self._closed = True
        finally:
            if owner:
                with self._condition:
                    # An interrupted owner must let another closer finish safely.
                    self._closing = False
                    self._condition.notify_all()

    def __enter__(self):
        with self._state.lock:
            self._check_open()
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()
        return False
