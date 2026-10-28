"""Native scalar delivery backed by a plaintext node-local directory journal.

Enqueue publishes locally, not remotely. A valid receipt means server acceptance,
not query visibility. Protect the journal directory: metric values and destination
URL are plaintext (credentials are never persisted). Durability depends on the
filesystem/device honoring fsync. Node loss can lose the small unshipped tail;
the native client uses the same journal for automatic scalar delivery.
"""
from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import re
import threading
import time
from urllib.parse import quote
import uuid
import weakref

from .transport import APIError, Transport
from .journal import BatchConflictError, DirectoryJournal, OutboxFullError

_MAX_SAFE = 9_007_199_254_740_991
_MAX_BODY = 32 * 1024 * 1024  # Native HTTP body limit (src/config.rs).
_BATCH_ID = re.compile(r"[A-Za-z0-9._-]{1,128}\Z")
_REGISTRY_LOCK = threading.Lock()
_REGISTRY = weakref.WeakValueDictionary()


class InvalidReceiptError(RuntimeError):
    """A response did not prove acceptance of the exact pending batch."""


class DeliveryError(RuntimeError):
    """Scalar delivery failed; pending data remains in ``spool_path``."""

    def __init__(self, path, status=None, *, reason=None):
        self.spool_path, self.status = path, status
        reason = reason or (f"HTTP {status}" if status is not None else "delivery deadline expired")
        super().__init__(f"{reason}; undelivered scalars retained at {path}; "
                         "reopen Client with the same URL and journal root on this node to resume")


class DeliveryTimeoutError(DeliveryError, TimeoutError):
    """The bounded delivery wait expired, without discarding pending data."""


def _after_fork():
    global _REGISTRY_LOCK, _REGISTRY
    _REGISTRY_LOCK = threading.Lock()
    _REGISTRY = weakref.WeakValueDictionary()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork)


@contextmanager
def _locked(lock, deadline, path):
    if not lock.acquire(timeout=max(0, deadline - time.monotonic())):
        raise DeliveryTimeoutError(str(path))
    try:
        yield
    finally:
        lock.release()


class _SpoolState:
    def __init__(self):
        self.lock = threading.RLock()
        self.claims = {}
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
    must be finite and in 0.001..300 seconds. Journal lock waits are at most 5s.
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
    reopen the same directory to inspect or deliver remaining records.

    Each canonical HTTP payload must fit the native 32 MiB body limit.
    Limits bound pending canonical payload bytes/count, not physical journal
    size (including metadata and orphan temporary files). Same-ID different bytes are rejected locally only while pending; after
    acknowledgement, conflicts are the server's responsibility.
    """

    def __init__(self, client, path, *, max_pending_bytes=268435456,
                 max_pending_batches=10000, workers=1, retry_interval=1.0,
                 _automatic=False, _deadline=None):
        self._pid = os.getpid()
        self._automatic = _automatic
        self._permanent = {}
        self._owned_claims = {}
        self._detach_close = False
        self.max_pending_bytes = _integer(max_pending_bytes, "max_pending_bytes", 2**63 - 1)
        self.max_pending_batches = _integer(max_pending_batches, "max_pending_batches", 1_000_000)
        self.workers = _integer(workers, "workers", 32)
        self.retry_interval = _seconds(retry_interval, "retry_interval", 0.01, 3600)
        timeout = _seconds(client.http.timeout, "client timeout", 0.001, 300)
        self._http = Transport(client.http.url, client.http.token, timeout)
        if os.fspath(path) == ":memory:":
            raise ValueError("outbox requires a directory, not an in-memory database")
        if Path(path).is_symlink():
            raise PermissionError("nset journal must not be a symlink")
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
        with (self._state.lock if _deadline is None else
              _locked(self._state.lock, _deadline, self.path)):
            self._journal = DirectoryJournal(
                self.path, self._http.url, timeout=min(timeout, 5), deadline=_deadline,
                timeout_error=lambda: DeliveryTimeoutError(self.path))

    def _check_open(self):
        if os.getpid() != self._pid:
            raise RuntimeError("create a new Client after fork")
        if self._closing or self._closed:
            raise RuntimeError("outbox is closed")

    @property
    def last_error(self):
        self._check_process()
        with self._state.lock:
            return self._last_error

    def enqueue(self, run_id, metrics, *, batch_id=None):
        """Return the stable ID only after fsync and atomic local publication.

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
        self._check_open()  # Reject inherited handles before acquiring a forked lock.
        with self._state.lock:
            self._check_open()
            self._journal.enqueue(
                run_id, batch_id, payload, accepted,
                max_bytes=self.max_pending_bytes, max_batches=self.max_pending_batches)
        return batch_id

    def pending_count(self):
        self._check_process()
        with self._state.lock:
            self._check_open()
            return len(self._journal.snapshot())

    def flush(self, max_batches=None):
        """Deliver pending durable PUTs; return deleted batch count or raise.

        ``None`` considers all rows present at entry; otherwise 1..1,000,000.
        Rows added during this call are left for a later call.
        """
        return self._flush(max_batches, background=False)

    def _flush(self, max_batches, *, background):
        if max_batches is not None:
            _integer(max_batches, "max_batches", 1_000_000)
        self._check_open()
        with self._condition:
            self._check_open()
            self._active += 1
        try:
            with self._state.lock:
                ids = self._journal.snapshot()
            count = 0
            for row_id in ids:
                with self._state.lock:
                    if self._stop.is_set() or (max_batches is not None and count >= max_batches):
                        break
                    row = self._journal.read(row_id)
                    if row is None:
                        self._permanent.pop(row_id, None)
                        continue
                    if background and self._automatic and row_id in self._permanent:
                        continue
                    run_id, batch_id, payload, accepted = row
                    key = (run_id, batch_id)
                    previous = self._state.claims.get(key)
                    if previous is not None:
                        if not previous[0].is_set():
                            continue
                        # A detached owner's request must not block replay, even
                        # if its cleanup thread could not be started.
                        self._state.claims.pop(key)
                        self._state.retries.pop(key, None)
                    failures, ready_at = self._state.retries.get(key, (0, 0))
                    if background and time.monotonic() < ready_at:
                        continue
                    claim = (self._stop, object())
                    self._state.claims[key] = claim
                    self._owned_claims[key] = claim
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
                        deleted = self._journal.acknowledge(row_id, payload)
                        count += deleted
                        self._state.retries.pop(key, None)
                        self._last_error = None
                        self._permanent.pop(row_id, None)
                        self._condition.notify_all()
                except BaseException as error:
                    with self._state.lock:
                        self._last_error = error
                        if isinstance(error, APIError) and error.status not in (408, 429) and 300 <= error.status < 500:
                            self._permanent[row_id] = error.status
                        failures = min(failures + 1, 16)
                        delay = min(self.retry_interval * 2 ** (failures - 1),
                                    max(60.0, self.retry_interval))
                        if self._state.claims.get(key) is claim:
                            self._state.retries[key] = (failures, time.monotonic() + delay)
                    raise
                finally:
                    with self._state.lock:
                        if self._state.claims.get(key) is claim:
                            self._state.claims.pop(key)
                        self._owned_claims.pop(key, None)
            return count
        except BaseException as error:
            with self._state.lock:
                self._last_error = error
            raise
        finally:
            with self._condition:
                self._active -= 1
                if self._detach_close and self._active == 0:
                    self._journal.close()
                    self._closed = True
                self._condition.notify_all()

    def start(self):
        """Start optional background delivery, returning self; no implicit drain."""
        self._check_open()
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
        try:
            while not self._stop.is_set():
                try:
                    with self._state.lock:
                        if self._automatic and not self._stop.is_set():
                            ids = set(self._journal.snapshot())
                            if not ids - self._permanent.keys():
                                # Enqueue/start shares this lock: no lost wakeup.
                                self._threads.remove(threading.current_thread())
                                return
                    if self._flush(None, background=True):
                        continue
                except Exception as error:
                    with self._state.lock:
                        if not self._closing:
                            self._last_error = error
                self._stop.wait(min(self.retry_interval, 0.1))
        finally:
            if self._automatic:
                with self._state.lock:
                    current = threading.current_thread()
                    if current in self._threads:
                        self._threads.remove(current)

    def _wait(self, timeout, run_id=None):
        """Wait for server acceptance of a snapshot, never query projection."""
        self._check_open()
        deadline = time.monotonic() + timeout
        with _locked(self._state.lock, deadline, self.path):
            self._check_open()
            targets = set(self._journal.snapshot(run_id, deadline=deadline))
            if targets:
                try:
                    self.start()
                except Exception:
                    raise DeliveryError(self.path, reason="could not start scalar delivery") from None
        while targets:
            with _locked(self._state.lock, deadline, self.path):
                self._check_open()
                pending = set(self._journal.snapshot(deadline=deadline))
                targets.intersection_update(pending)
                if not targets:
                    return
                for row_id in targets:
                    if row_id in self._permanent:
                        raise DeliveryError(self.path, self._permanent[row_id])
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise DeliveryTimeoutError(self.path)
            # Unlike Condition.wait, reacquiring the lock remains deadline-bound.
            time.sleep(min(remaining, .05))

    def _shutdown(self, timeout=0):
        """Stop without waiting on a socket; release detached claims for replay."""
        self._check_process()
        self._closing = True
        self._detach_close = True
        self._stop.set()
        # Cleanup may wait for active journal work; keep that off the caller's
        # bounded shutdown path as well as any outstanding network request.
        cleanup = threading.Thread(target=self._close_stopped, name="nset-close", daemon=True)
        cleanup.start()
        cleanup.join(timeout)

    def _close_stopped(self):
        with self._condition:
            if self._closed:
                return
            self._detach_close = True
            for key, claim in self._owned_claims.items():
                if self._state.claims.get(key) is claim:
                    self._state.claims.pop(key)
                    self._state.retries.pop(key, None)
            if self._active == 0:
                self._journal.close()
                self._closed = True
            self._condition.notify_all()

    def _check_process(self):
        if os.getpid() != self._pid:
            raise RuntimeError("create a new Client after fork")

    def close(self):
        """Stop/join delivery and close the journal without flushing or dropping records."""
        self._check_process()
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
                self._journal.close()
                self._closed = True
        finally:
            if owner:
                with self._condition:
                    # An interrupted owner must let another closer finish safely.
                    self._closing = False
                    self._condition.notify_all()

    def __enter__(self):
        self._check_process()
        with self._state.lock:
            self._check_open()
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()
        return False
