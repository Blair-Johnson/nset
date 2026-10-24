"""Durable, standalone TensorBoard event-file collector (TensorBoard extra only).

Run: NSET_TOKEN=... python -m nset_compat.tensorboard --logdir logs --url URL
     --state-dir collector-state [--watch] [--experiment TensorBoard]

One native run per relative event-file directory, shared across file rotations.
Scalars support legacy simple_value and real numeric rank-zero TensorProto
encodings (tensor_content or repeated numeric fields), with absent/scalars plugin
metadata. Bool, complex, non-finite, non-scalar, unknown-plugin and out-of-native-
range values are raw-preserved with warnings rather than coerced. New image
tensors require images-plugin metadata and DT_STRING [width,height,bytes...];
metadata-less image tensors are raw-preserved, not extracted.
Scalar timestamps are event.wall_time in milliseconds; duplicate/restarted steps
are appended, NOT TensorBoard's purge-orphaned-data view. SessionLog.START is
preserved and warned about; no native history is deleted. Every original protobuf
is retained in state.sqlite3 (events.raw), including unsupported summaries. Old
Summary.Image and new images-plugin DT_STRING tensors are also extracted into
artifacts. These are LOCAL durable artifacts, NOT native image charts: native
image POST is not idempotent. Back up the entire state directory, not just source
logs. There is no automatic artifact retention/deletion policy.

A successful native PUT means durable acceptance, not necessarily application.
Each <=10000-metric chunk has a persisted stable ID/payload and can be replayed
following a lost response. Checkpoints advance only after all chunks are accepted
and raw/artifact preservation commits. State is single-writer, bound to absolute
logdir, native URL and experiment; credentials are never stored. Creation of a
native run is not idempotent: a persisted intent and unique tag allow recovery
from a completed lost-response POST. If no tagged run is visible after an
ambiguous POST, stop rather than issue another POST (operator recovery needed).

Files are tracked by device/inode and their entire acknowledged-prefix SHA256;
renames retain checkpoints, new rotated files start at zero in the same run.
Truncation, in-place rewriting, or inode reuse with a different acknowledged
prefix fail closed. Partial final records remain unread until complete; bad CRC
fails closed. Missing files are warned about, never silently removed from state;
already-spooled records can be delivered without the original file. Prefix
verification is O(processed bytes) each scan. Append-only regular local files and
POSIX file locking are required; concurrent source rewriting is unsupported.
Moved logdirs, endpoint changes and experiment changes require a NEW state dir.
Deleting state replays into NEW runs, loses local-only artifacts and does NOT
purge native history. Do not delete state as a retry mechanism. There is no
implicit TensorBoard purge/restart deduplication across distinct event files.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import sqlite3
import struct
import time
from urllib.parse import quote
import uuid

from nset_client.transport import Transport

LOG = logging.getLogger(__name__)
MAX_RECORD = 64 * 1024 * 1024
SAFE_INT = 9007199254740991


class SourceChanged(RuntimeError):
    """Source no longer agrees with its durable checkpoint; do not reset it."""


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _frames(stream, offset):
    """Read complete TFRecords, validating official TensorBoard CRC32C masks."""
    from tensorboard.compat.tensorflow_stub.pywrap_tensorflow import masked_crc32c

    stream.seek(offset)
    while True:
        header = stream.read(12)
        if len(header) < 12:
            return
        size, checksum = struct.unpack("<QI", header)
        if masked_crc32c(header[:8]) != checksum:
            raise SourceChanged(f"bad TFRecord header CRC at offset {offset}")
        if size > MAX_RECORD:
            raise ValueError(f"TFRecord exceeds {MAX_RECORD} bytes at offset {offset}")
        body = stream.read(size + 4)
        if len(body) < size + 4:
            return
        raw = body[:-4]
        if masked_crc32c(raw) != struct.unpack("<I", body[-4:])[0]:
            raise SourceChanged(f"bad TFRecord data CRC at offset {offset}")
        frame = header + body
        yield offset, offset + len(frame), raw, frame
        offset += len(frame)


def _decode(raw):
    """Return scalar inputs, extracted images, and explicit preservation reasons."""
    from tensorboard.compat.proto import event_pb2
    from tensorboard.util import tensor_util

    metrics, images, reasons = [], [], []
    event = event_pb2.Event()
    try:
        event.ParseFromString(raw)
    except Exception:
        return [], [], ["malformed-event-protobuf"]
    kind = event.WhichOneof("what")
    if kind != "summary":
        if kind == "session_log":
            reasons.append("session-log-preserved-no-purge")
        elif kind != "file_version":
            reasons.append("unsupported-event:" + str(kind))
        return metrics, images, reasons
    timestamp = None
    if math.isfinite(event.wall_time):
        timestamp = int(event.wall_time * 1000) if abs(event.wall_time) <= SAFE_INT / 1000 else None
    for ordinal, value in enumerate(event.summary.value):
        encoding = value.WhichOneof("value")
        plugin = value.metadata.plugin_data.plugin_name
        try:
            number = None
            if encoding == "simple_value":
                number = float(value.simple_value)
            elif encoding == "image":
                images.append((ordinal, 0, value.tag, bytes(value.image.encoded_image_string)))
                reasons.append("image-preserved-locally")
                continue
            elif encoding == "tensor":
                array = tensor_util.make_ndarray(value.tensor)
                if plugin == "images" and array.ndim == 1 and value.tensor.dtype == 7:
                    if len(array) < 3:
                        raise ValueError("image tensor lacks encoded image payload")
                    for index, image in enumerate(array[2:]):
                        images.append((ordinal, index, value.tag, bytes(image)))
                    reasons.append("image-preserved-locally")
                    continue
                if plugin not in ("", "scalars") or array.shape != () or array.dtype.kind not in "fiu":
                    raise ValueError("not a supported numeric rank-zero scalar")
                number = float(array.item())
            else:
                raise ValueError("unsupported summary encoding")
            if (not math.isfinite(number) or timestamp is None or not 0 <= event.step <= SAFE_INT
                    or not 0 <= timestamp <= SAFE_INT or not value.tag or len(value.tag.encode("utf-8")) > 512):
                raise ValueError("scalar outside native finite/name/integer constraints")
            metrics.append({"key": value.tag, "value": number,
                            "step": event.step, "timestamp": timestamp})
        except Exception as exc:
            reasons.append(f"unsupported-summary:{encoding}:{type(exc).__name__}")
    return metrics, images, reasons


class Collector:
    """Single-writer durable collector; call scan() repeatedly or use the CLI."""

    def __init__(self, logdir, url, state_dir, *, token, experiment="TensorBoard", transport=None):
        import fcntl

        self.root = Path(logdir).resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError("logdir must be a directory")
        self.state_dir = Path(state_dir).resolve()
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.lock = open(self.state_dir / "collector.lock", "a+b")
        self.db = None
        try:
            try:
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise RuntimeError("state directory already has an active collector") from None
            self.http = transport or Transport(url, token)
            self.db = sqlite3.connect(self.state_dir / "state.sqlite3")
            self.db.row_factory = sqlite3.Row
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS runs(directory TEXT PRIMARY KEY,marker TEXT NOT NULL,
                    run_id TEXT,attempted INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS files(identity TEXT PRIMARY KEY,path TEXT NOT NULL,
                    directory TEXT NOT NULL,offset INTEGER NOT NULL,digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,identity TEXT NOT NULL,
                    start INTEGER NOT NULL,end INTEGER NOT NULL,digest TEXT NOT NULL,
                    raw BLOB NOT NULL,reasons TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,
                    run_id TEXT NOT NULL,payload TEXT NOT NULL,accepted INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS artifacts(event_id TEXT NOT NULL,ordinal INTEGER NOT NULL,
                    image_index INTEGER NOT NULL,tag TEXT NOT NULL,data BLOB NOT NULL,
                    PRIMARY KEY(event_id,ordinal,image_index));
                -- Also migrate existing state: drain only pending rows, not all history.
                -- Equal index keys retain rowid order for the queries below.
                CREATE INDEX IF NOT EXISTS events_pending ON events(done) WHERE done=0;
                CREATE INDEX IF NOT EXISTS batches_pending ON batches(event_id) WHERE accepted=0;
            """)
            config = {"logdir": str(self.root), "url": url.rstrip("/"), "experiment": experiment,
                      "version": 1}
            old = self._meta("config")
            if old is not None and old != config:
                raise ValueError("state is bound to another source, endpoint, experiment or format; use a new state dir")
            with self.db:
                if old is None:
                    self._put_meta("config", config)
                    self._put_meta("collector_id", uuid.uuid4().hex)
            self.collector_id = self._meta("collector_id")
            self.experiment = experiment
            # Ensure the newly created database directory entries are durable too.
            for directory in (self.state_dir, self.state_dir.parent):
                fd = os.open(directory, os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
        except BaseException:
            self.close()
            raise

    def close(self):
        try:
            if self.db is not None:
                self.db.close()
        finally:
            self.db = None
            self.lock.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _meta(self, key):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def _put_meta(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, _json(value)))

    def _run(self, directory):
        row = self.db.execute("SELECT * FROM runs WHERE directory=?", (directory,)).fetchone()
        if row is not None and row["run_id"]:
            return row["run_id"]
        experiment_id = self._meta("experiment_id")
        if experiment_id is None:
            experiment_id = self.http.request("POST", "/api/experiments", {"name": self.experiment})["id"]
            with self.db:
                self._put_meta("experiment_id", experiment_id)
        marker = hashlib.sha256((self.collector_id + ":" + directory).encode()).hexdigest()
        if row is not None and row["attempted"]:
            candidates = self.http.request("GET", "/api/runs", query={"experiment_id": experiment_id})["runs"]
            found = [run for run in candidates if run.get("tags", {}).get("tensorboard_collector") == marker]
            if len(found) != 1:
                raise RuntimeError("ambiguous native run creation; no unique tagged run found; "
                                   "retry after the native request finishes, or recover the runs mapping manually")
            run_id = found[0]["id"]
        else:
            with self.db:
                self.db.execute("INSERT INTO runs(directory,marker,attempted) VALUES (?,?,1)",
                                (directory, marker))
            run_id = self.http.request("POST", "/api/runs", {
                "experiment_id": experiment_id, "name": (directory if directory != "." else (self.root.name or "root")).encode("utf-8")[:512].decode("utf-8", "ignore"),
                "params": {}, "tags": {"tensorboard_collector": marker, "tensorboard_directory": directory},
            })["id"]
        with self.db:
            self.db.execute("UPDATE runs SET run_id=? WHERE directory=?", (run_id, directory))
        return run_id

    def _drain(self):
        for event in self.db.execute("SELECT * FROM events WHERE done=0 ORDER BY rowid").fetchall():
            batches = self.db.execute("SELECT * FROM batches WHERE event_id=? AND accepted=0 ORDER BY rowid",
                                      (event["id"],)).fetchall()
            for batch in batches:
                # No POST fallback: old servers must fail without moving the checkpoint.
                payload = json.loads(batch["payload"])
                receipt = self.http.request(
                    "PUT", f"/api/runs/{quote(batch['run_id'], safe='')}/ingest/{batch['id']}", payload)
                if (not isinstance(receipt, dict)
                        or receipt.get("run_id") != batch["run_id"]
                        or receipt.get("batch_id") != batch["id"]
                        or receipt.get("state") not in ("pending", "applied")
                        or type(receipt.get("accepted")) is not int
                        or receipt["accepted"] != len(payload["metrics"])
                        or not 0 <= receipt["accepted"] <= SAFE_INT
                        or type(receipt.get("accepted_at")) is not int
                        or not 0 <= receipt["accepted_at"] <= SAFE_INT):
                    raise RuntimeError("invalid durable ingest receipt; batch remains pending")
                with self.db:
                    self.db.execute("UPDATE batches SET accepted=1 WHERE id=?", (batch["id"],))
            with self.db:
                self.db.execute("UPDATE files SET offset=?,digest=? WHERE identity=?",
                                (event["end"], event["digest"], event["identity"]))
                self.db.execute("UPDATE events SET done=1 WHERE id=?", (event["id"],))

    def scan(self):
        """Process complete records, returning cumulative durable preservation counts."""
        self._drain()
        seen = set()
        for path in sorted(self.root.rglob("*tfevents*")):
            if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(self.root):
                continue
            with path.open("rb") as stream:
                stat = os.fstat(stream.fileno())
                identity = f"{stat.st_dev}:{stat.st_ino}"
                if identity in seen:
                    continue
                seen.add(identity)
                directory = path.parent.relative_to(self.root).as_posix()
                record = self.db.execute("SELECT * FROM files WHERE identity=?", (identity,)).fetchone()
                if record is None:
                    with self.db:
                        self.db.execute("INSERT INTO files VALUES (?,?,?,?,?)", (
                            identity, str(path), directory, 0, hashlib.sha256(b"").hexdigest()))
                    offset, digest = 0, hashlib.sha256(b"").hexdigest()
                else:
                    if directory != record["directory"]:
                        raise SourceChanged("event file moved between run directories")
                    offset, digest = record["offset"], record["digest"]
                prefix = hashlib.sha256()
                remaining = offset
                while remaining:
                    block = stream.read(min(1024 * 1024, remaining))
                    if not block:
                        raise SourceChanged(f"event file truncated: {path}")
                    prefix.update(block)
                    remaining -= len(block)
                if prefix.hexdigest() != digest:
                    raise SourceChanged(f"acknowledged source prefix changed: {path}")
                with self.db:
                    self.db.execute("UPDATE files SET path=? WHERE identity=?", (str(path), identity))
                for start, end, raw, frame in _frames(stream, offset):
                    prefix.update(frame)
                    event_id = hashlib.sha256(f"{self.collector_id}:{identity}:{start}:".encode() + frame).hexdigest()
                    metrics, images, reasons = _decode(raw)
                    run_id = self._run(directory) if metrics or images else None
                    with self.db:
                        self.db.execute("INSERT INTO events(id,identity,start,end,digest,raw,reasons) VALUES (?,?,?,?,?,?,?)",
                                        (event_id, identity, start, end, prefix.hexdigest(), raw, _json(reasons)))
                        for ordinal, index, tag, image in images:
                            self.db.execute("INSERT INTO artifacts VALUES (?,?,?,?,?)", (event_id, ordinal, index, tag, image))
                        for index in range(0, len(metrics), 10000):
                            batch_id = f"tb-{event_id}-{index // 10000}"
                            self.db.execute("INSERT INTO batches(id,event_id,run_id,payload) VALUES (?,?,?,?)",
                                            (batch_id, event_id, run_id, _json({"metrics": metrics[index:index + 10000]})))
                    for reason in reasons:
                        LOG.warning("TensorBoard record %s preserved: %s", event_id, reason)
                    self._drain()
        for row in self.db.execute("SELECT identity,path FROM files"):
            if row["identity"] not in seen:
                LOG.warning("Previously observed event file is missing; checkpoint retained: %s", row["path"])
        counts = self.counts()
        LOG.info("TensorBoard durable state counts: %s", _json(counts))
        return counts

    def counts(self):
        counts = dict(self.db.execute("SELECT 'records',count(*) FROM events UNION ALL "
                                      "SELECT 'processed_records',count(*) FROM events WHERE done=1 UNION ALL "
                                      "SELECT 'local_images',count(*) FROM artifacts UNION ALL "
                                      "SELECT 'accepted_batches',count(*) FROM batches WHERE accepted=1"))
        reasons = Counter()
        for row in self.db.execute("SELECT reasons FROM events"):
            reasons.update(json.loads(row[0]))
        counts["preservation_reasons"] = dict(reasons)
        return counts


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--logdir", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--experiment", default="TensorBoard")
    args = parser.parse_args(argv)
    token = os.environ.get("NSET_TOKEN")
    if not token:
        parser.error("NSET_TOKEN is required")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    with Collector(args.logdir, args.url, args.state_dir, token=token, experiment=args.experiment) as collector:
        while True:
            collector.scan()
            if not args.watch:
                break
            time.sleep(1)


if __name__ == "__main__":
    main()
