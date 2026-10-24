"""Native client with automatic, locally durable scalar delivery."""
import hashlib
from itertools import islice
import os
from pathlib import Path
import stat
import sys
import threading
import time
from urllib.parse import quote
from .transport import Transport
from .outbox import DeliveryTimeoutError, DurableOutbox, _locked, _seconds


def _spool_path(url):
    """Stable destination identity, independent of rotating access tokens."""
    if sys.platform == "darwin":
        root = Path.home() / "Library" / "Application Support"
    elif os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        root = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
        if not root.is_absolute():
            root = Path.home() / ".local" / "state"
    return root / "nset" / "outbox" / hashlib.sha256(url.encode()).hexdigest() / "scalars.sqlite3"


def _sync_directory(path):
    if os.name != "nt":
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _mkdir(path):
    try:
        path.mkdir(mode=0o700)
    except FileNotFoundError:
        _mkdir(path.parent)
        _mkdir(path)
    except FileExistsError:
        pass
    else:
        _sync_directory(path)
        _sync_directory(path.parent)


def _private_spool(path):
    # Only our own directories are required to be private, not Application Support.
    for directory in (path.parent.parent.parent, path.parent.parent, path.parent):
        _mkdir(directory)
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or (os.name != "nt" and (
                info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077)):
            raise PermissionError("nset spool directories must be private and not symlinks")
    if path.is_symlink():
        raise PermissionError("nset spool must not be a symlink")
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or (os.name != "nt" and (
                info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077)):
            raise PermissionError("nset spool must be a private regular file")
    finally:
        os.close(fd)
    _sync_directory(path.parent)


class Client:
    def __init__(self, url="http://127.0.0.1:8080", *, token, timeout=30, flush_timeout=30):
        self.http = Transport(url, token, _seconds(timeout, "timeout", .001, 300))
        self.flush_timeout = _seconds(flush_timeout, "flush_timeout", 0, 300)
        self._destination = self.http.url
        self.spool_path = _spool_path(self.http.url)
        self._lock = threading.RLock()
        self._pid = os.getpid()
        self._closed = False
        self._close_done = threading.Event()
        self._close_error = None
        self._outbox = None
        # No disk writes for read-only clients with no retained work.
        if self.spool_path.exists():
            self._delivery().start()

    def _check_open(self):
        if os.getpid() != self._pid:
            raise RuntimeError("create a new Client after fork")
        if self._closed:
            raise RuntimeError("client is closed")

    def _delivery(self):
        self._check_open()
        if self.http.url != self._destination:
            raise ValueError("destination changed; create a new Client for the new URL")
        with self._lock:
            self._check_open()
            if self._outbox is None:
                _private_spool(self.spool_path)
                self._outbox = DurableOutbox(self, self.spool_path, _automatic=True)
            return self._outbox

    def _log_batch(self, run_id, metrics):
        self._check_open()
        with self._lock:
            box = self._delivery()
            # Validation and FULL-synchronous local commit precede success.
            box.enqueue(run_id, metrics)
            try:
                box.start()
            except Exception as error:
                # Acceptance is already durable. Flush will retry startup and
                # surface failure, rather than invite duplicate caller retries.
                with box._state.lock:
                    box._last_error = error
            return {"accepted": len(metrics)}

    def flush(self, *, timeout=None):
        """Wait for durable server acceptance, not query visibility (default 30s)."""
        self._flush(timeout=timeout)

    def _flush(self, *, timeout=None, run_id=None):
        self._check_open()
        budget = self.flush_timeout if timeout is None else _seconds(timeout, "timeout", 0, 300)
        deadline = time.monotonic() + budget
        with _locked(self._lock, deadline, self.spool_path):
            self._check_open()
            box = self._outbox
        if box is not None:
            box._wait(max(0, deadline - time.monotonic()), run_id)

    def close(self, *, timeout=None):
        """Drain within the deadline, then stop; failures retain recoverable data."""
        budget = self.flush_timeout if timeout is None else _seconds(timeout, "timeout", 0, 300)
        if os.getpid() != self._pid:
            raise RuntimeError("create a new Client after fork")
        deadline = time.monotonic() + budget
        with _locked(self._lock, deadline, self.spool_path):
            if self._closed:
                if self._close_done.is_set():
                    return
                owner = False
            else:
                self._closed = True
                owner = True
            box = self._outbox
        if not owner:
            if not self._close_done.wait(max(0, deadline - time.monotonic())):
                raise DeliveryTimeoutError(str(self.spool_path))
            if self._close_error is not None:
                raise self._close_error
            return
        try:
            if box is not None:
                try:
                    box._wait(max(0, deadline - time.monotonic()))
                finally:
                    box._shutdown(max(0, deadline - time.monotonic()))
        except BaseException as error:
            self._close_error = error
            raise
        finally:
            self._close_done.set()

    def __enter__(self):
        self._check_open()
        return self

    def __exit__(self, exc_type, exc, traceback):
        try:
            self.close()
        except Exception as error:
            if exc is None:
                raise
            if hasattr(exc, "add_note"):
                exc.add_note(f"Could not deliver tracker scalars: {error}")
        return False

    def durable_outbox(self, path, **options):
        """Open an explicit plaintext, locally durable scalar spool (not started)."""
        from .outbox import DurableOutbox
        return DurableOutbox(self, path, **options)

    def experiment(self, name):
        return self.http.request("POST", "/api/experiments", {"name": name})

    def start_run(self, experiment, name, *, params=None, tags=None):
        self._check_open()
        experiment_id = experiment["id"] if isinstance(experiment, dict) else experiment
        data = self.http.request("POST", "/api/runs", {
            "experiment_id": experiment_id, "name": name,
            "params": params or {}, "tags": tags or {},
        })
        return Run(self, data)

    def metric_history(self, run_id, key, *, page_size=10000):
        query = {"key": key, "limit": page_size}
        path = f"/api/runs/{quote(run_id, safe='')}/metrics"
        while True:
            page = self.http.request("GET", path, query=query)
            yield from page["points"]
            if page["next_after"] is None:
                return
            query.update(after=page["next_after"], snapshot=page["snapshot"])


class Run:
    def __init__(self, client, data):
        self.client, self.data, self.id = client, data, data["id"]
        self.path = f"/api/runs/{quote(self.id, safe='')}"
        self._lock = threading.RLock()
        self._finished = False

    def log_batch(self, metrics):
        """Return {"accepted": count} after local commit; delivery is automatic."""
        self.client._check_open()
        rows = list(islice(metrics, 10001))  # Never execute user iterators under lifecycle locks.
        with self._lock:
            if self._finished:
                raise RuntimeError("run is finished")
            return self.client._log_batch(self.id, rows)

    def flush(self, *, timeout=None):
        """Wait for this run's pending scalars to reach durable server intake."""
        self.client._flush(timeout=timeout, run_id=self.id)

    def log_metrics(self, values, *, step, timestamp=None):
        rows = [{"key": key, "step": step, "value": value} for key, value in values.items()]
        if timestamp is not None:
            for row in rows:
                row["timestamp"] = timestamp
        return self.log_batch(rows)

    def log_image_bytes(self, key, data, *, step, content_type="image/png", timestamp=None):
        query = {"key": key, "step": step}
        if timestamp is not None:
            query["timestamp"] = timestamp
        return self.client.http.request("POST", self.path + "/images", query=query,
                                        raw=data, content_type=content_type)

    def log_image(self, key, path, *, step, timestamp=None):
        path = Path(path)
        types = {".png": "image/png", ".jpg": "image/jpeg",
                 ".jpeg": "image/jpeg", ".webp": "image/webp"}
        if path.suffix.lower() not in types:
            raise ValueError("image must be PNG, JPEG, or WebP")
        return self.log_image_bytes(key, path.read_bytes(), step=step,
                                   content_type=types[path.suffix.lower()], timestamp=timestamp)

    def finish(self, status="finished", *, timeout=None):
        """Flush scalars before updating status; raise on a bounded wait failure."""
        self.client._check_open()
        budget = self.client.flush_timeout if timeout is None else _seconds(timeout, "timeout", 0, 300)
        deadline = time.monotonic() + budget
        with _locked(self._lock, deadline, self.client.spool_path):
            self.flush(timeout=max(0, deadline - time.monotonic()))
            # urllib's socket timeout is not a wall-clock bound (DNS/trickling
            # peers). Do not let an uncertain status response hang context exit.
            done = threading.Event()
            result = []
            def update():
                try:
                    result.append(self.client.http.request("PATCH", self.path, {"status": status}))
                except BaseException as error:
                    result.append(error)
                finally:
                    done.set()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("scalars accepted; deadline expired before run status update")
            threading.Thread(target=update, name="nset-finish", daemon=True).start()
            if not done.wait(remaining):
                raise TimeoutError("scalars accepted; run status response timed out (status uncertain)")
            if isinstance(result[0], BaseException):
                raise result[0]
            self.data = result[0]
            self._finished = True
            return self.data

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        try:
            self.finish("failed" if exc_type else "finished")
        except Exception as update_error:
            if exc is None:
                raise
            if hasattr(exc, "add_note"):
                exc.add_note(f"Could not finish tracker run: {update_error}")
        return False
