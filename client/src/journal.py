"""Small node-local journal: immutable records, atomic publication, receipt unlink.

The caller chooses a local filesystem. Environment paths are not proof of local
storage; this module does not detect NFS or promise cross-node recovery. Files
contain plaintext metrics and a credential-free destination, never access tokens.
"""
from contextlib import contextmanager
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time
import uuid


class OutboxFullError(RuntimeError):
    """Enqueue exceeded a local capacity limit; nothing was evicted."""


class BatchConflictError(ValueError):
    """A pending (run_id, batch_id) already has different canonical bytes."""


class JournalCorruptionError(RuntimeError):
    """A published journal record is invalid; preserve it for investigation."""


_RECORD = re.compile(r"([0-9]{20})-[0-9a-f]{32}-([0-9a-f]{64})\.batch\Z")
_MAX_BODY = 32 * 1024 * 1024
_MAX_HEADER = 8192


def sync_directory(path):
    # Windows does not expose a stdlib directory fsync. File fsync + atomic
    # rename still applies there, without a power-loss directory-sync promise.
    if os.name != "nt":
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def private_directory(path):
    """Create one private directory (parent must exist); reject links/files."""
    path = Path(path)
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    else:
        sync_directory(path)
        sync_directory(path.parent)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or (os.name != "nt" and (
            info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077)):
        raise PermissionError("nset journal directories must be private and not symlinks")


class DirectoryJournal:
    """Storage-only operations; each holds a bounded lock, never a socket.

    Record IDs identify a publication, not merely a batch ID. Thus a late receipt
    cannot delete a different publication after another process deletes/re-enqueues
    the same batch. Metadata is cached only while file stat identity is unchanged;
    newly discovered or changed complete records are fully checksum-validated.
    """

    def __init__(self, path, destination, *, timeout=5, deadline=None,
                 timeout_error=TimeoutError):
        self.path = Path(path)
        self._pid = os.getpid()
        self._closed = False
        self._timeout = min(timeout, 5)
        self._timeout_error = timeout_error
        self._cache = {}
        if self.path.is_symlink():
            raise PermissionError("nset journal must not be a symlink")
        if self.path.exists() and not self.path.is_dir():
            raise ValueError(
                f"{self.path} is an existing file (possibly a legacy SQLite outbox); "
                "it was not modified. Choose a new journal directory. To drain a "
                "legacy SQLite outbox, use the prior client version with that file; "
                "automatic migration is not supported.")
        private_directory(self.path)
        with self._transaction(deadline):
            records = self._records()
            manifest = self.path / "destination.json"
            if manifest.exists() or manifest.is_symlink():
                try:
                    with self._open_regular(manifest) as source:
                        data = source.read()
                    meta = json.loads(data)
                    if (not isinstance(meta, dict)
                            or set(meta) != {"version", "destination"}
                            or type(meta["version"]) is not int or meta["version"] != 1
                            or not isinstance(meta["destination"], str)):
                        raise ValueError("invalid destination metadata")
                except (ValueError, OSError) as error:
                    raise JournalCorruptionError(f"invalid journal metadata at {manifest}") from error
                if meta["destination"] != destination:
                    raise ValueError("outbox destination does not match client URL")
            else:
                if records:
                    raise JournalCorruptionError("journal records exist without destination metadata")
                data = json.dumps({"version": 1, "destination": destination},
                                  sort_keys=True, separators=(",", ":")).encode("utf-8")
                self._publish("destination.json", data)

    @contextmanager
    def _transaction(self, deadline=None):
        if os.getpid() != self._pid:
            raise RuntimeError("create a new Client after fork")
        if self._closed:
            raise RuntimeError("journal is closed")
        end = time.monotonic() + self._timeout
        if deadline is not None:
            end = min(end, deadline)
        fd = os.open(self.path / ".lock", os.O_CREAT | os.O_RDWR |
                     getattr(os, "O_NOFOLLOW", 0), 0o600)
        acquired = False
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise PermissionError("journal lock must be a regular file")
            if os.name == "nt":
                import msvcrt
            else:
                import fcntl
            while True:
                try:
                    if os.name == "nt":
                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    else:
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                    break
                except OSError as error:
                    if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                        raise
                    remaining = end - time.monotonic()
                    if remaining <= 0:
                        raise self._timeout_error() from None
                    time.sleep(min(.01, remaining))
            yield
        finally:
            try:
                if acquired:
                    if os.name == "nt":
                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                    else:
                        fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)

    def _publish(self, name, data):
        fd, temporary = tempfile.mkstemp(prefix=".tmp-", dir=self.path)
        try:
            with os.fdopen(fd, "wb") as target:
                target.write(data)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, self.path / name)
            sync_directory(self.path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    @staticmethod
    def _open_regular(path):
        if not stat.S_ISREG(path.lstat().st_mode):
            raise JournalCorruptionError(f"journal file is not regular: {path}")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise JournalCorruptionError(f"journal file is not regular: {path}")
        return os.fdopen(fd, "rb")

    def _read(self, record_id):
        match = _RECORD.fullmatch(record_id)
        if match is None:
            raise JournalCorruptionError(f"invalid journal record name: {record_id}")
        path = self.path / record_id
        try:
            with self._open_regular(path) as source:
                header = source.readline(_MAX_HEADER + 1)
                payload = source.read(_MAX_BODY + 1)
            meta = json.loads(header)
            if (not header.endswith(b"\n") or len(header) > _MAX_HEADER
                    or len(payload) > _MAX_BODY or not isinstance(meta, dict)
                    or set(meta) != {"version", "run_id", "batch_id", "accepted"}
                    or type(meta["version"]) is not int or meta["version"] != 1
                    or not isinstance(meta["run_id"], str)
                    or not 1 <= len(meta["run_id"].encode("utf-8")) <= 512
                    or any(ord(c) < 32 or ord(c) == 127 for c in meta["run_id"])
                    or not isinstance(meta["batch_id"], str)
                    or re.fullmatch(r"[A-Za-z0-9._-]{1,128}", meta["batch_id"]) is None
                    or type(meta["accepted"]) is not int or not 1 <= meta["accepted"] <= 10000
                    or not payload
                    or hashlib.sha256(header + payload).hexdigest() != match[2]):
                raise ValueError("invalid record or checksum")
            return meta, payload
        except (ValueError, UnicodeError) as error:
            raise JournalCorruptionError(f"corrupt journal record at {path}; file retained") from error

    def _records(self):
        records = []
        seen = set()
        keys = set()
        with os.scandir(self.path) as entries:
            for entry in entries:
                name = entry.name
                if name in (".lock", "destination.json") or name.startswith(".tmp-"):
                    continue  # A crashed writer's unpublished temporary file is not work.
                if not _RECORD.fullmatch(name) or not entry.is_file(follow_symlinks=False):
                    raise JournalCorruptionError(f"unexpected journal entry: {entry.path}")
                info = entry.stat(follow_symlinks=False)
                signature = (info.st_dev, info.st_ino, info.st_size,
                             info.st_mtime_ns, info.st_ctime_ns)
                cached = self._cache.get(name)
                if cached is None or cached[0] != signature:
                    meta, payload = self._read(name)
                    cached = (signature, meta, len(payload))
                    self._cache[name] = cached
                _, meta, size = cached
                key = (meta["run_id"], meta["batch_id"])
                if key in keys:
                    raise JournalCorruptionError("duplicate pending journal batch identity")
                keys.add(key)
                seen.add(name)
                records.append((name, meta, size))
        self._cache = {key: value for key, value in self._cache.items() if key in seen}
        return sorted(records, key=lambda record: record[0])

    def enqueue(self, run_id, batch_id, payload, accepted, *, max_bytes, max_batches):
        with self._transaction():
            records = self._records()
            for record_id, meta, _ in records:
                if (meta["run_id"], meta["batch_id"]) == (run_id, batch_id):
                    if self._read(record_id)[1] != payload:
                        raise BatchConflictError("pending batch ID already has a different payload")
                    return
            if len(records) >= max_batches or sum(row[2] for row in records) + len(payload) > max_bytes:
                raise OutboxFullError("outbox capacity exceeded; existing batches retained")
            header = json.dumps({"version": 1, "run_id": run_id, "batch_id": batch_id,
                                 "accepted": accepted}, sort_keys=True,
                                separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n"
            data = header + payload
            sequence = max(time.time_ns(), int(records[-1][0][:20]) + 1 if records else 0)
            record_id = f"{sequence:020d}-{uuid.uuid4().hex}-{hashlib.sha256(data).hexdigest()}.batch"
            self._publish(record_id, data)

    def snapshot(self, run_id=None, *, deadline=None):
        with self._transaction(deadline):
            return [record_id for record_id, meta, _ in self._records()
                    if run_id is None or meta["run_id"] == run_id]

    def read(self, record_id):
        with self._transaction():
            try:
                meta, payload = self._read(record_id)
            except FileNotFoundError:
                return None
            return meta["run_id"], meta["batch_id"], payload, meta["accepted"]

    def acknowledge(self, record_id, payload):
        """Unlink only this publication with these exact bytes, after a receipt."""
        with self._transaction():
            try:
                _, current = self._read(record_id)
            except FileNotFoundError:
                return 0
            if current != payload:
                return 0
            os.unlink(self.path / record_id)
            self._cache.pop(record_id, None)
            sync_directory(self.path)
            return 1

    def close(self):
        # No descriptor persists between transactions; outbox rejects fork reuse.
        self._closed = True
