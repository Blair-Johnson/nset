"""Durable gateway metadata, opaque artifact storage, and native ingest bridge."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
import time
from urllib.parse import quote, urlencode, urlsplit, unquote
import weakref

from nset_client.transport import Transport
from .common import ProtocolError

MAX_BODY_BYTES = 32 * 1024 * 1024
_BATCH_ID = re.compile(r"[A-Za-z0-9._-]{1,128}\Z", re.ASCII)


def _fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _mkdir(path):
    path = Path(path)
    if not path.exists():
        _mkdir(path.parent)
        path.mkdir(exist_ok=True, mode=0o700)
        _fsync_dir(path.parent)
    return path


class _DirectoryLock:
    """Lifetime advisory lock. Never unlink: waiters must share one inode."""
    def __init__(self, path):
        # Directory fsync and flock are currently supported only on POSIX.
        # Fail closed elsewhere instead of silently weakening run-level locks.
        if os.name != "posix":
            raise RuntimeError("CompatContext directory locking requires POSIX flock; this platform is unsupported")
        import fcntl

        self._file = open(path, "a+b")
        try:
            fcntl.flock(self._file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException as exc:
            self._file.close()
            if isinstance(exc, BlockingIOError):
                raise RuntimeError("Compatibility data directory is already in use by another live CompatContext") from exc
            raise

    def close(self):
        # Closing (rather than explicitly unlocking) also respects any forked
        # descriptor still using this directory. Python marks it non-inheritable
        # across exec; the OS releases it on process death.
        self._file.close()


class State:
    """One serialized SQLite connection; no lock escapes a local transaction."""
    def __init__(self, path):
        self._lock = threading.RLock()
        self._db = sqlite3.connect(path, timeout=10, check_same_thread=False, isolation_level=None)
        try:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=FULL")
            self._db.execute("CREATE TABLE IF NOT EXISTS kv (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key))")
            self._db.execute("CREATE TABLE IF NOT EXISTS sequences (namespace TEXT PRIMARY KEY, value INTEGER NOT NULL)")
            _fsync_dir(Path(path).parent)
        except BaseException:
            self._db.close()
            raise

    @staticmethod
    def _keys(namespace, key):
        if not isinstance(namespace, str) or not isinstance(key, str):
            raise TypeError("namespace and key must be strings")

    def get(self, namespace, key, default=None):
        self._keys(namespace, key)
        with self._lock:
            row = self._db.execute("SELECT value FROM kv WHERE namespace=? AND key=?", (namespace, key)).fetchone()
        return json.loads(row[0]) if row else default

    def put(self, namespace, key, value):
        self._keys(namespace, key)
        data = json.dumps(value, allow_nan=False, separators=(",", ":"))
        with self._lock:
            self._db.execute("INSERT INTO kv VALUES (?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value", (namespace, key, data))

    def get_many(self, namespace, keys):
        """Return only found keys, using bounded indexed queries in one snapshot."""
        self._keys(namespace, "")
        keys = list(keys)
        for key in keys:
            self._keys(namespace, key)
        keys = list(dict.fromkeys(keys))
        if not keys:
            return {}
        with self._lock:
            # Python <3.11 lacks getlimit; 999 is SQLite's historic default.
            limit = (self._db.getlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER)
                     if hasattr(self._db, "getlimit") else 999)
            chunk_size = min(900, limit - 1)  # One parameter is the namespace.
            if chunk_size < 1:
                raise ValueError("SQLite variable limit must allow a namespace and key")
            found = {}
            self._db.execute("BEGIN")
            try:
                for offset in range(0, len(keys), chunk_size):
                    chunk = keys[offset:offset + chunk_size]
                    placeholders = ",".join("?" for _ in chunk)
                    rows = self._db.execute(
                        "SELECT key,value FROM kv WHERE namespace=? AND key IN (" + placeholders + ")",
                        (namespace, *chunk)).fetchall()
                    found.update((key, json.loads(value)) for key, value in rows)
                self._db.execute("COMMIT")
            except BaseException:
                self._db.execute("ROLLBACK")
                raise
        return found

    def put_many(self, namespace, mapping):
        """Validate every JSON value first, then atomically upsert the mapping."""
        self._keys(namespace, "")
        rows = []
        for key, value in mapping.items():
            self._keys(namespace, key)
            rows.append((namespace, key, json.dumps(value, allow_nan=False, separators=(",", ":"))))
        if not rows:
            return
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                self._db.executemany(
                    "INSERT INTO kv VALUES (?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value",
                    rows)
                self._db.execute("COMMIT")
            except BaseException:
                self._db.execute("ROLLBACK")
                raise

    def delete(self, namespace, key):
        self._keys(namespace, key)
        with self._lock:
            self._db.execute("DELETE FROM kv WHERE namespace=? AND key=?", (namespace, key))

    def items(self, namespace):
        self._keys(namespace, "")
        with self._lock:
            rows = self._db.execute("SELECT key,value FROM kv WHERE namespace=? ORDER BY key", (namespace,)).fetchall()
        return [(key, json.loads(value)) for key, value in rows]

    def next_id(self, namespace, start=1):
        self._keys(namespace, "")
        if type(start) is not int or not 0 <= start < 2**63 - 1:
            raise ValueError("start must be a nonnegative signed 64-bit integer")
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                row = self._db.execute("SELECT value FROM sequences WHERE namespace=?", (namespace,)).fetchone()
                value = max(start, row[0] + 1) if row else start
                if value >= 2**63 - 1:
                    raise OverflowError("sequence exhausted")
                self._db.execute("INSERT INTO sequences VALUES (?,?) ON CONFLICT(namespace) DO UPDATE SET value=excluded.value", (namespace, value))
                self._db.execute("COMMIT")
                return value
            except BaseException:
                self._db.execute("ROLLBACK")
                raise

    def close(self):
        with self._lock:
            self._db.close()


def artifact_path(path, *, allow_empty=False):
    if not isinstance(path, str) or "\x00" in path or "\\" in path or path.startswith("/"):
        raise ProtocolError(400, "INVALID_PARAMETER_VALUE", "Artifact path must be relative POSIX")
    if allow_empty:
        path = path.rstrip("/")
    if not path and allow_empty:
        return path
    if not path or any(part in ("", ".", "..") for part in path.split("/")):
        raise ProtocolError(400, "INVALID_PARAMETER_VALUE", "Unsafe artifact path")
    return path


class Artifacts:
    def __init__(self, ctx, root):
        self.ctx = ctx
        self.root = _mkdir(root)

    @staticmethod
    def _namespace(namespace):
        if not isinstance(namespace, str) or not namespace:
            raise ProtocolError(400, "INVALID_PARAMETER_VALUE", "Artifact namespace is required")
        return "gateway:artifacts:" + namespace

    def put(self, namespace, path, data, content_type="application/octet-stream"):
        path = artifact_path(path)
        ns = self._namespace(namespace)
        if not isinstance(data, bytes):
            raise TypeError("artifact data must be bytes")
        if len(data) > self.ctx.max_body_bytes:
            raise ProtocolError(413, "REQUEST_TOO_LARGE", "Artifact exceeds body limit")
        if not isinstance(content_type, str) or any(c in content_type for c in "\r\n\x00"):
            raise ProtocolError(400, "INVALID_PARAMETER_VALUE", "Invalid artifact content type")
        digest = hashlib.sha256(data).hexdigest()
        # Persist content before metadata. Orphan blobs after a crash are harmless;
        # deleting blobs inline would race other logical paths sharing a digest.
        fd, name = tempfile.mkstemp(prefix=".upload-", dir=self.root)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.root / digest)
            _fsync_dir(self.root)
            self.ctx.state.put(ns, path, {"digest": digest, "content_type": content_type, "file_size": len(data)})
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def get(self, namespace, path):
        path = artifact_path(path)
        info = self.ctx.state.get(self._namespace(namespace), path)
        if info is None:
            raise ProtocolError(404, "RESOURCE_DOES_NOT_EXIST", "Artifact not found")
        if info["file_size"] > self.ctx.max_body_bytes:
            raise ProtocolError(413, "REQUEST_TOO_LARGE", "Artifact exceeds body limit")
        digest = info["digest"]
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ProtocolError(500, "DATA_LOSS", "Invalid artifact metadata")
        try:
            with open(self.root / digest, "rb") as stream:
                data = stream.read(self.ctx.max_body_bytes + 1)
        except FileNotFoundError:
            raise ProtocolError(500, "DATA_LOSS", "Artifact content is missing") from None
        if len(data) != info["file_size"] or hashlib.sha256(data).hexdigest() != digest:
            raise ProtocolError(500, "DATA_LOSS", "Artifact content integrity failure")
        return data, info["content_type"]

    def list(self, namespace, path=""):
        path = artifact_path(path, allow_empty=True)
        prefix = path + "/" if path else ""
        children = {}
        for key, info in self.ctx.state.items(self._namespace(namespace)):
            if not key.startswith(prefix):
                continue
            rest = key[len(prefix):]
            child = prefix + rest.split("/", 1)[0]
            is_dir = "/" in rest
            if child not in children or is_dir:
                children[child] = {"path": child, "is_dir": is_dir, "file_size": 0 if is_dir else info["file_size"]}
        return [children[key] for key in sorted(children)]

    def delete(self, namespace, path):
        self.ctx.state.delete(self._namespace(namespace), artifact_path(path))


def _signed_path(path):
    parsed = urlsplit(path)
    decoded = unquote(parsed.path)
    if (not path.startswith("/compat/files/") or parsed.scheme or parsed.netloc
            or parsed.query or parsed.fragment or parsed.path != path
            or "\\" in decoded or any(ord(c) < 32 for c in decoded)
            or any(p in (".", "..") for p in decoded.split("/"))):
        raise ProtocolError(400, "INVALID_PARAMETER_VALUE", "Only compatibility file paths may be signed")
    return path


class CompatContext:
    def __init__(self, native_url, token, data_dir, public_url):
        self.native = Transport(native_url, token, timeout=10)
        parsed = urlsplit(public_url)
        if (parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username
                or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
            raise ValueError("public_url must be an HTTP(S) origin without credentials")
        self.public_url = public_url.rstrip("/")
        self.token = token
        self.max_body_bytes = MAX_BODY_BYTES
        self.ingest_timeout = 30.0
        self.poll_interval = 0.05
        self._locks = weakref.WeakValueDictionary()
        self._locks_guard = threading.Lock()
        if os.name != "posix":
            raise RuntimeError("CompatContext directory locking requires POSIX flock; this platform is unsupported")
        self._close_lock = threading.Lock()
        self.state = None
        self._directory_lock = None
        self.data_dir = _mkdir(Path(data_dir).absolute())
        try:
            self._directory_lock = _DirectoryLock(self.data_dir / "compat.lock")
            self.state = State(self.data_dir / "compat.sqlite3")
            unbound = object()
            native_url = self.state.get("gateway:config", "native_url", unbound)
            if native_url is unbound:
                self.state.put("gateway:config", "native_url", self.native.url)
            elif native_url != self.native.url:
                raise ValueError("Compatibility data directory is bound to a different native URL")
            # Check the binding before creating or changing any artifact paths.
            self.artifacts = Artifacts(self, self.data_dir / "blobs")
        except BaseException:
            self.close()
            raise

    def lock_for(self, key):
        with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.RLock()
                self._locks[key] = lock
            return lock

    def signed_url(self, path, expires_in=3600):
        path = _signed_path(path)
        if type(expires_in) is not int or not 1 <= expires_in <= 604800:
            raise ValueError("expires_in must be 1..604800 seconds")
        expiry = str(int(time.time()) + expires_in)
        signature = self._signature(path, expiry)
        return self.public_url + path + "?" + urlencode({"expires": expiry, "signature": signature})

    def _signature(self, path, expiry):
        return hmac.new(self.token.encode(), (path + "\n" + expiry).encode(), hashlib.sha256).hexdigest()

    def valid_signature(self, path, query):
        try:
            _signed_path(path)
            expiry = query["expires"]
            if not re.fullmatch(r"[0-9]{1,12}", expiry):
                return False
            if not int(time.time()) < int(expiry) <= int(time.time()) + 604800:
                return False
            return hmac.compare_digest(self._signature(path, expiry).encode(), query["signature"].encode())
        except (ProtocolError, KeyError, ValueError, TypeError):
            return False

    @staticmethod
    def _receipt(receipt, run_id, batch_id, count):
        if (not isinstance(receipt, dict) or receipt.get("batch_id") != batch_id
                or receipt.get("run_id") != run_id or receipt.get("state") not in ("pending", "applied")
                or type(receipt.get("accepted")) is not int or receipt["accepted"] != count
                or type(receipt.get("accepted_at")) is not int
                or not 0 <= receipt["accepted_at"] <= 2**53 - 1):
            raise ProtocolError(502, "INVALID_BACKEND_RESPONSE", "Native ingest returned an invalid receipt")
        return receipt

    def ingest_metrics(self, run_id, batch_id, metrics, wait=True):
        if not isinstance(batch_id, str) or not _BATCH_ID.fullmatch(batch_id):
            raise ProtocolError(400, "INVALID_PARAMETER_VALUE", "Invalid ingest batch ID")
        if not isinstance(run_id, str) or not run_id or not isinstance(metrics, list) or not metrics:
            raise ProtocolError(400, "INVALID_PARAMETER_VALUE", "Run ID and nonempty metric list are required")
        try:
            canonical = json.dumps(metrics, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
            metrics = json.loads(canonical)
            # Match Transport's encoding, including wrapper and default spaces,
            # not only the compact representation used for batch identity.
            body_size = len(json.dumps({"metrics": metrics}, allow_nan=False).encode())
        except (ValueError, TypeError, RecursionError):
            raise ProtocolError(400, "INVALID_PARAMETER_VALUE", "Metrics must be finite JSON values") from None
        if body_size > self.max_body_bytes:
            raise ProtocolError(413, "REQUEST_TOO_LARGE", "Metric batch exceeds body limit")
        identity = json.dumps([run_id, batch_id], separators=(",", ":"))
        digest = hashlib.sha256(canonical).hexdigest()
        # Bind the whole caller batch before chunking: changing its size or chunk
        # count on retry must not accidentally submit a disjoint set of native IDs.
        with self.lock_for("gateway:ingest:" + identity):
            old = self.state.get("gateway:ingest", identity)
            if old is not None and old != digest:
                raise ProtocolError(409, "RESOURCE_CONFLICT", "Batch ID already binds different metrics")
            if old is None:
                self.state.put("gateway:ingest", identity, digest)
        deadline = time.monotonic() + self.ingest_timeout
        receipts = []
        for offset in range(0, len(metrics), 10000):
            chunk = metrics[offset:offset + 10000]
            chunk_id = batch_id if len(metrics) <= 10000 else "chunk-" + hashlib.sha256((batch_id + ":" + str(offset // 10000)).encode()).hexdigest()
            path = "/api/runs/" + quote(run_id, safe="") + "/ingest/" + chunk_id
            receipt = self._receipt(self.native.request("PUT", path, {"metrics": chunk}), run_id, chunk_id, len(chunk))
            while wait and receipt["state"] != "applied":
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ProtocolError(503, "TEMPORARILY_UNAVAILABLE", "Native receipt remains pending; retry the same batch ID")
                time.sleep(min(self.poll_interval, remaining))
                receipt = self._receipt(self.native.request("GET", path), run_id, chunk_id, len(chunk))
            receipts.append(receipt)
            if offset + 10000 < len(metrics) and time.monotonic() >= deadline:
                raise ProtocolError(503, "TEMPORARILY_UNAVAILABLE", "Ingest deadline reached; retry the same batch ID")
        if len(receipts) == 1:
            return receipts[0]
        return {"batch_id": batch_id, "run_id": run_id,
                "state": "applied" if all(r["state"] == "applied" for r in receipts) else "pending",
                "accepted": sum(r["accepted"] for r in receipts),
                "accepted_at": min(r["accepted_at"] for r in receipts), "receipts": receipts}

    def close(self):
        with self._close_lock:
            try:
                if self.state is not None:
                    self.state.close()
            finally:
                if self._directory_lock is not None:
                    self._directory_lock.close()
                    self._directory_lock = None
