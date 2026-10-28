#!/usr/bin/env python3
"""Import MLflow tracking data into an nset server through its native HTTP API.

Sources (MLflow's own table schema, any recent MLflow version):
  --tables DIR    gzipped CSV exports named <table>.csv.gz (see scripts/mlflow_export.sh);
                  staged once into <work-dir>/staging.sqlite3
  --sqlite FILE   an MLflow SQLite backend store (mlflow.db)
  --artifacts DIR local copy of the artifact root (S3 bucket sync, mlruns/, ...)

Mapping: experiments -> experiments (by name); runs -> runs with MLflow params and
tags plus mlflow_import.* provenance tags; metrics -> durable scalar batches with
original step/timestamp; mlflow.log_image artifacts -> images with original
key/step/timestamp; other PNG/JPEG/WebP artifacts -> images at step 0 under
"artifacts/<path>". Values nset cannot represent (NaN/inf, negative steps or
timestamps, keys over 512 bytes) are dropped and counted in the report.

Re-running is safe: runs are matched by their mlflow_import.run_id tag, metric
batches use deterministic durable-ingest ids, and images are skipped when an
identical (key, step, timestamp, size) image already exists on the run.
Standard library only.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

MAX_SAFE = 9_007_199_254_740_991
MAX_KEY_BYTES = 512
BATCH_ROWS = 10_000
MAX_IMAGE_BYTES = 32 * 1024 * 1024
FLOAT_MAX = sys.float_info.max  # MLflow's SQL store encodes +/-inf as +/-float max
TAG_PREFIX = "mlflow_import."
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
STATUS = {"FINISHED": "finished", "FAILED": "failed", "KILLED": "canceled",
          "RUNNING": "running", "SCHEDULED": "running"}
# mlflow.log_image: "<key with / as #><sep>step<sep>N<sep>timestamp<sep>MS<sep><uuid>.png"
# with sep "+" (MLflow >= 2.16) or "%" (earlier); "+compressed.webp" files are thumbnails.
LOGGED_IMAGE = re.compile(
    r"^(?P<key>.+?)[+%]step[+%](?P<step>-?\d+)[+%]timestamp[+%](?P<ts>-?\d+)[+%](?P<uuid>[0-9a-fA-F-]{36})"
    r"(?P<compressed>[+%]compressed)?\.(?P<ext>png|jpe?g|webp)$")


class ImportError_(RuntimeError):
    """Fatal import problem with a user-facing message."""


# --------------------------------------------------------------------------- HTTP


class Nset:
    """Minimal nset API client: bearer auth, JSON, and patient retry on 503/connection loss."""

    def __init__(self, url: str, token: str, *, timeout: float = 120, max_wait: float = 900):
        self.url, self.token, self.timeout, self.max_wait = url.rstrip("/"), token, timeout, max_wait

    def request(self, method, path, payload=None, *, query=None, raw=None, content_type="application/json"):
        target = self.url + path + ("?" + urllib.parse.urlencode(query) if query else "")
        body = raw if raw is not None else (
            json.dumps(payload, allow_nan=False).encode() if payload is not None else None)
        deadline, delay = time.monotonic() + self.max_wait, 0.5
        while True:
            request = urllib.request.Request(target, data=body, method=method, headers={
                "Authorization": "Bearer " + self.token, "Content-Type": content_type})
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    data = response.read()
                    return json.loads(data) if data else None
            except urllib.error.HTTPError as error:
                detail = error.read().decode(errors="replace")
                if error.code != 503 or time.monotonic() > deadline:
                    raise ImportError_(f"{method} {path} -> HTTP {error.code}: {detail}") from None
                wait = float(error.headers.get("Retry-After") or delay)
            except (urllib.error.URLError, ConnectionError, TimeoutError) as error:
                if time.monotonic() > deadline:
                    raise ImportError_(f"{method} {path} failed: {error}") from None
                wait = delay
            time.sleep(min(max(wait, delay), 10))
            delay = min(delay * 1.5, 10)

    def wait_for_projection(self, timeout=1800):
        deadline = time.monotonic() + timeout
        while True:
            status = self.request("GET", "/api/ingest/status")
            if status["pending_batches"] == 0:
                return status
            if time.monotonic() > deadline:
                raise ImportError_(f"ingest projection did not drain: {status}")
            time.sleep(0.5)


# ------------------------------------------------------------------------- source

SOURCE_TABLES = ("experiments", "runs", "params", "tags", "metrics")
INDEXES = ("CREATE INDEX IF NOT EXISTS ix_params ON params(run_uuid)",
           "CREATE INDEX IF NOT EXISTS ix_tags ON tags(run_uuid)",
           "CREATE INDEX IF NOT EXISTS ix_metrics ON metrics(run_uuid,key)")


def stage_tables(tables: Path, staging: Path) -> Path:
    """Load <table>.csv.gz exports into one SQLite file (all columns TEXT, cast on read)."""
    marker = staging.with_suffix(".complete")
    if staging.exists() and marker.exists():
        return staging
    staging.unlink(missing_ok=True)
    tmp = staging.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    csv.field_size_limit(sys.maxsize)
    db = sqlite3.connect(tmp)
    for name in SOURCE_TABLES:
        path = tables / f"{name}.csv.gz"
        if not path.exists():
            raise ImportError_(f"missing {path}")
        with gzip.open(path, "rt", newline="", encoding="utf-8") as handle:
            reader = csv.reader(handle)
            header = next(reader)
            cols = ",".join(f'"{c}" TEXT' for c in header)
            db.execute(f'CREATE TABLE "{name}" ({cols})')
            marks = ",".join("?" * len(header))
            db.executemany(f'INSERT INTO "{name}" VALUES ({marks})', reader)
        print(f"  staged {name}: {db.execute(f'SELECT COUNT(*) FROM {name}').fetchone()[0]:,} rows")
    for statement in INDEXES:
        db.execute(statement)
    db.commit()
    db.close()
    tmp.rename(staging)
    marker.touch()
    return staging


class Source:
    """Read-only view over MLflow's experiments/runs/params/tags/metrics tables."""

    def __init__(self, path: Path, *, csv_text: bool):
        self.db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        self.db.row_factory = sqlite3.Row
        # CSV staging keeps Postgres booleans as 't'/'f' and empty strings for NULL.
        self.csv_text = csv_text

    def nullable(self, value):
        return None if value is None or (self.csv_text and value == "") else value

    def experiments(self):
        rows = self.db.execute("SELECT * FROM experiments").fetchall()
        return {str(r["experiment_id"]): dict(r) for r in rows}

    def runs(self):
        return [dict(r) for r in self.db.execute("SELECT * FROM runs ORDER BY CAST(start_time AS INTEGER), run_uuid")]

    def pairs(self, table, run_uuid):
        return {r["key"]: r["value"] for r in self.db.execute(
            f"SELECT key, value FROM {table} WHERE run_uuid=? ORDER BY key", (run_uuid,))}

    def metric_keys(self, run_uuid):
        return [r[0] for r in self.db.execute(
            "SELECT DISTINCT key FROM metrics WHERE run_uuid=? ORDER BY key", (run_uuid,))]

    def metrics(self, run_uuid, key):
        """Rows in a stable order so batch ids and contents are deterministic across re-runs."""
        return self.db.execute(
            "SELECT CAST(step AS INTEGER), CAST(timestamp AS INTEGER), value, is_nan FROM metrics "
            "WHERE run_uuid=? AND key=? ORDER BY CAST(step AS INTEGER), CAST(timestamp AS INTEGER), "
            "CAST(value AS REAL)", (run_uuid, key))

    def is_nan(self, flag):
        return flag in (1, "1", "t", "true", "True", True)


# ------------------------------------------------------------------------- import


@dataclass
class Report:
    experiments: int = 0
    runs_created: int = 0
    runs_existing: int = 0
    runs_skipped: int = 0
    metrics_sent: int = 0
    images_sent: int = 0
    images_existing: int = 0
    bytes_sent: int = 0
    dropped: dict = field(default_factory=dict)
    unimported_artifacts: dict = field(default_factory=dict)
    mismatches: list = field(default_factory=list)

    def drop(self, reason, count=1):
        self.dropped[reason] = self.dropped.get(reason, 0) + count


def key_ok(key: str) -> bool:
    return 0 < len(key.encode()) <= MAX_KEY_BYTES


def scalar(value: str):
    """Recover the JSON type of an MLflow string param ("0.001" -> 0.001) for nset filters."""
    text = value.strip()
    if text in ("True", "true"):
        return True
    if text in ("False", "false"):
        return False
    try:
        number = int(text) if re.fullmatch(r"-?\d+", text) else float(text)
    except ValueError:
        return value
    if isinstance(number, float) and not math.isfinite(number):
        return value
    if isinstance(number, int) and abs(number) > MAX_SAFE:
        return value
    return number


class Importer:
    def __init__(self, nset: Nset, source: Source, args, report: Report):
        self.nset, self.source, self.args, self.report = nset, source, args, report
        self.experiment_ids: dict[str, str] = {}
        self.existing: dict[str, dict] = {}

    # -- experiments and runs

    def experiment_name(self, exp):
        name = exp["name"]
        if exp.get("lifecycle_stage") == "deleted":
            name += self.args.deleted_suffix
        return name

    def load_existing_runs(self):
        for run in self.nset.request("GET", "/api/runs")["runs"]:
            origin = run["tags"].get(TAG_PREFIX + "run_id")
            if origin:
                self.existing[origin] = run

    def ensure_experiment(self, exp):
        mlflow_id = str(exp["experiment_id"])
        if mlflow_id not in self.experiment_ids:
            created = self.nset.request("POST", "/api/experiments", {"name": self.experiment_name(exp)})
            self.experiment_ids[mlflow_id] = created["id"]
            self.report.experiments += 1
        return self.experiment_ids[mlflow_id]

    def run_tags(self, run, exp, tags):
        name = run.get("name") or tags.get("mlflow.runName") or run["run_uuid"]
        provenance = {
            "run_id": run["run_uuid"], "experiment_id": str(run["experiment_id"]),
            "experiment_name": exp["name"], "status": run.get("status"),
            "lifecycle_stage": run.get("lifecycle_stage"), "user_id": self.source.nullable(run.get("user_id")),
            "start_time": self.source.nullable(run.get("start_time")),
            "end_time": self.source.nullable(run.get("end_time")),
            "artifact_uri": self.source.nullable(run.get("artifact_uri")),
        }
        merged = {k: v for k, v in tags.items() if key_ok(k)}
        self.report.drop("tag key too long", len(tags) - len(merged))
        for k, v in provenance.items():
            if v not in (None, ""):
                merged[TAG_PREFIX + k] = int(v) if k.endswith("_time") else v
        return name, merged

    def import_run(self, run, exp):
        uuid = run["run_uuid"]
        if uuid in self.existing:
            self.report.runs_existing += 1
            return self.existing[uuid]
        params = self.source.pairs("params", uuid)
        tags = self.source.pairs("tags", uuid)
        name, merged = self.run_tags(run, exp, tags)
        convert = (lambda v: v) if self.args.raw_params else scalar
        native_params = {k: convert(v) for k, v in params.items() if key_ok(k)}
        self.report.drop("param key too long", len(params) - len(native_params))
        created = self.nset.request("POST", "/api/runs", {
            "experiment_id": self.ensure_experiment(exp), "name": name[:512] or uuid,
            "params": native_params, "tags": merged})
        self.report.runs_created += 1
        self.existing[uuid] = created
        return created

    def finish_run(self, native, run):
        status = STATUS.get(run.get("status") or "", "running")
        if native["status"] != status:
            self.nset.request("PATCH", f"/api/runs/{native['id']}", {"status": status})

    # -- metrics

    def metric_rows(self, uuid, key):
        for step, ts, value, nan in self.source.metrics(uuid, key):
            if self.source.is_nan(nan):
                self.report.drop("NaN metric value")
                continue
            value = float(value)
            if not math.isfinite(value) or abs(value) >= FLOAT_MAX:
                self.report.drop("infinite metric value")
                continue
            if not (0 <= step <= MAX_SAFE):
                self.report.drop("negative metric step")
                continue
            row = {"key": key, "step": step, "value": value}
            if 0 <= ts <= MAX_SAFE:
                row["timestamp"] = ts
            else:
                self.report.drop("invalid metric timestamp (server time used)")
            yield row

    def import_metrics(self, native, uuid):
        expected = {}
        for key in self.source.metric_keys(uuid):
            if not key_ok(key):
                self.report.drop("metric key too long")
                continue
            digest = hashlib.sha256(key.encode()).hexdigest()[:24]
            chunk, index, total = [], 0, 0
            for row in self.metric_rows(uuid, key):
                chunk.append(row)
                if len(chunk) == BATCH_ROWS:
                    self.submit(native["id"], f"mlflow-{uuid}-{digest}-{index}", chunk)
                    total, index, chunk = total + len(chunk), index + 1, []
            if chunk:
                self.submit(native["id"], f"mlflow-{uuid}-{digest}-{index}", chunk)
                total += len(chunk)
            if total:
                expected[key] = total
        return expected

    def submit(self, run_id, batch_id, rows):
        receipt = self.nset.request(
            "PUT", f"/api/runs/{urllib.parse.quote(run_id, safe='')}/ingest/{batch_id}", {"metrics": rows})
        if receipt["accepted"] != len(rows):
            raise ImportError_(f"batch {batch_id}: accepted {receipt['accepted']} of {len(rows)}")
        self.report.metrics_sent += len(rows)

    # -- artifacts

    def artifact_dir(self, run):
        """Map the run's artifact URI onto --artifacts (bucket root or mlruns-style tree)."""
        root = self.args.artifacts
        if root is None:
            return None
        uri = self.source.nullable(run.get("artifact_uri")) or ""
        candidates = []
        parsed = urllib.parse.urlparse(uri)
        if parsed.scheme == "mlflow-artifacts":
            candidates.append(root / parsed.path.lstrip("/"))
        elif parsed.scheme in ("s3", "gs", "wasbs", "abfss"):
            candidates.append(root / parsed.path.lstrip("/"))
        elif parsed.scheme in ("", "file"):
            candidates.append(Path(parsed.path))
        candidates.append(root / str(run["experiment_id"]) / run["run_uuid"] / "artifacts")
        return next((c for c in candidates if c.is_dir()), None)

    def image_jobs(self, run):
        directory = self.artifact_dir(run)
        if directory is None:
            return []
        jobs = []
        for path in sorted(p for p in directory.rglob("*") if p.is_file()):
            relative = path.relative_to(directory).as_posix()
            ext = path.suffix.lower()
            match = LOGGED_IMAGE.match(path.name) if relative.startswith("images/") else None
            if match:
                if match["compressed"]:
                    continue  # MLflow UI thumbnail of the original beside it
                key = match["key"].replace("#", "/")
                step, ts = int(match["step"]), int(match["ts"])
            elif ext in IMAGE_TYPES and self.args.other_images:
                key, step, ts = "artifacts/" + relative, 0, int(path.stat().st_mtime * 1000)
            else:
                self.report.unimported_artifacts[ext or "(none)"] = (
                    self.report.unimported_artifacts.get(ext or "(none)", 0) + 1)
                continue
            if not key_ok(key) or not (0 <= step <= MAX_SAFE) or not (0 <= ts <= MAX_SAFE):
                self.report.drop("image with invalid key/step/timestamp")
                continue
            if ext not in IMAGE_TYPES:
                self.report.drop("image in unsupported format")
                continue
            if path.stat().st_size > MAX_IMAGE_BYTES:
                self.report.drop("image over 32 MiB")
                continue
            jobs.append((key, step, ts, path))
        return jobs

    def import_images(self, native, run):
        jobs = self.image_jobs(run)
        if not jobs:
            return {}
        run_path = f"/api/runs/{urllib.parse.quote(native['id'], safe='')}"
        have = {(i["key"], i["step"], i["timestamp"], i["byte_length"])
                for i in self.nset.request("GET", run_path + "/images")["images"]}
        expected = {}

        def send(job):
            key, step, ts, path = job
            size = path.stat().st_size
            if (key, step, ts, size) in have:
                return "existing", size
            self.nset.request("POST", run_path + "/images", query={"key": key, "step": step, "timestamp": ts},
                              raw=path.read_bytes(), content_type=IMAGE_TYPES[path.suffix.lower()])
            return "sent", size

        with ThreadPoolExecutor(max_workers=self.args.image_workers) as pool:
            for (key, *_), (state, size) in zip(jobs, pool.map(send, jobs)):
                expected[key] = expected.get(key, 0) + 1
                if state == "sent":
                    self.report.images_sent += 1
                    self.report.bytes_sent += size
                else:
                    self.report.images_existing += 1
        return expected


# ------------------------------------------------------------------------ verify


def verify(nset: Nset, expectations: dict, report: Report):
    """Compare per-series counts in the nset catalog with what this import sent or found."""
    nset.wait_for_projection()
    catalog = nset.request("GET", "/api/catalog")
    actual = {(s["run_id"], s["kind"], s["key"]): s["count"] for s in catalog["series"]}
    for (run_id, kind, key), count in expectations.items():
        got = actual.get((run_id, kind, key), 0)
        if got != count:
            report.mismatches.append({"run_id": run_id, "kind": kind, "key": key,
                                      "expected": count, "actual": got})


# -------------------------------------------------------------------------- main


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--tables", type=Path, help="directory of MLflow <table>.csv.gz exports")
    source.add_argument("--sqlite", type=Path, help="MLflow SQLite backend store (mlflow.db)")
    parser.add_argument("--artifacts", type=Path, help="local artifact root (bucket copy or mlruns/)")
    parser.add_argument("--url", default=os.environ.get("NSET_URL", "http://127.0.0.1:8080"))
    parser.add_argument("--token", default=os.environ.get("NSET_TOKEN"), help="defaults to $NSET_TOKEN")
    parser.add_argument("--work-dir", type=Path, default=Path("mlflow-import-work"),
                        help="staging database and report location")
    parser.add_argument("--experiment", action="append", default=[],
                        help="import only these MLflow experiment ids or names (repeatable)")
    parser.add_argument("--skip-deleted", action="store_true", help="omit deleted runs and experiments")
    parser.add_argument("--deleted-suffix", default=" (deleted in MLflow)",
                        help="appended to names of deleted MLflow experiments")
    parser.add_argument("--raw-params", action="store_true",
                        help="keep params as MLflow strings instead of recovering numbers/booleans")
    parser.add_argument("--no-images", action="store_true", help="skip all image artifacts")
    parser.add_argument("--other-images", action="store_true",
                        help="also import non-log_image PNG/JPEG/WebP artifacts at step 0")
    parser.add_argument("--image-workers", type=int, default=2,
                        help="concurrent image uploads (match nset's image_concurrency)")
    parser.add_argument("--dry-run", action="store_true", help="read and summarize the source only")
    args = parser.parse_args(argv)
    if not args.dry_run and not args.token:
        parser.error("set --token or NSET_TOKEN")
    return args


def open_source(args) -> Source:
    if args.sqlite:
        return Source(args.sqlite, csv_text=False)
    args.work_dir.mkdir(parents=True, exist_ok=True)
    print(f"staging {args.tables} -> {args.work_dir / 'staging.sqlite3'}")
    return Source(stage_tables(args.tables, args.work_dir / "staging.sqlite3"), csv_text=True)


def selected(args, source: Source):
    experiments = source.experiments()
    wanted = set(args.experiment)
    runs = []
    for run in source.runs():
        exp = experiments.get(str(run["experiment_id"]))
        if exp is None:
            continue
        if wanted and str(exp["experiment_id"]) not in wanted and exp["name"] not in wanted:
            continue
        if args.skip_deleted and "deleted" in (run.get("lifecycle_stage"), exp.get("lifecycle_stage")):
            continue
        runs.append((run, exp))
    return runs


def main(argv=None):
    args = parse_args(argv)
    source = open_source(args)
    try:
        return run_import(args, source)
    finally:
        source.db.close()


def run_import(args, source: Source):
    runs = selected(args, source)
    report = Report()
    print(f"{len(runs)} runs across {len({str(e['experiment_id']) for _, e in runs})} experiments selected")
    if args.dry_run:
        return 0
    nset = Nset(args.url, args.token)
    nset.request("GET", "/api/health")
    importer = Importer(nset, source, args, report)
    importer.load_existing_runs()
    expectations = {}
    started = time.monotonic()
    for index, (run, exp) in enumerate(runs, 1):
        native = importer.import_run(run, exp)
        for key, count in importer.import_metrics(native, run["run_uuid"]).items():
            expectations[(native["id"], "metric", key)] = count
        if not args.no_images:
            for key, count in importer.import_images(native, run).items():
                expectations[(native["id"], "image", key)] = count
        importer.finish_run(native, run)
        print(f"[{index}/{len(runs)}] {exp['name']} / {native['name']}: "
              f"{report.metrics_sent:,} points, {report.images_sent:,} images sent "
              f"({time.monotonic() - started:.0f}s)", flush=True)
    print("waiting for ingest projection and verifying counts...")
    verify(nset, expectations, report)
    report_path = args.work_dir / "import-report.json"
    args.work_dir.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report.__dict__, indent=2, sort_keys=True))
    print(json.dumps({k: v for k, v in report.__dict__.items() if k != "mismatches"}, indent=2, sort_keys=True))
    print(f"series verified: {len(expectations) - len(report.mismatches)}/{len(expectations)}; report: {report_path}")
    return 1 if report.mismatches else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ImportError_ as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(2)
