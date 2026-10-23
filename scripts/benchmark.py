"""Bounded, closed-loop HTTP ingestion probe; observations, not capacity guarantees."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import socket
import sys
import threading
import time
from urllib.error import URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from support import Server
from nset_client import Client
from nset_client.transport import APIError

SCHEMA_VERSION = 1
TIMESTAMP_BASE = 1700000000000


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--points", type=int, default=100000, help="total points across all producers")
    parser.add_argument("--batch-size", type=int, default=1000)
    parser.add_argument("--concurrency", type=int, default=1, help="closed-loop producer threads")
    parser.add_argument("--runs", type=int, default=1, help="producers share runs round-robin")
    parser.add_argument("--experiments", type=int, default=1, help="runs share experiments round-robin")
    parser.add_argument("--keys", type=int, default=1)
    parser.add_argument("--catalog-readers", type=int, default=0)
    parser.add_argument("--history-readers", type=int, default=0)
    parser.add_argument("--reader-interval", type=float, default=0.1,
                        help="minimum pause after each concurrent read, seconds")
    parser.add_argument("--max-reader-requests", type=int, default=1000, help="cap per reader")
    parser.add_argument("--page-size", type=int, default=10000)
    parser.add_argument("--timeout", type=float, default=30, help="HTTP socket timeout, seconds")
    args = parser.parse_args(argv)
    limits = {"points": (1, 1000000), "batch_size": (1, 10000), "concurrency": (1, 128),
              "runs": (1, args.concurrency), "experiments": (1, args.runs), "keys": (1, 32),
              "catalog_readers": (0, 16), "history_readers": (0, 16),
              "max_reader_requests": (1, 10000), "page_size": (1, 50000),
              "reader_interval": (0.01, 60), "timeout": (0.01, 300)}
    for name, (low, high) in limits.items():
        if not low <= getattr(args, name) <= high:
            parser.error(f"{name.replace('_', '-')} must be in {low}..{high}")
    if args.concurrency > args.points:
        parser.error("concurrency must not exceed points")
    if args.catalog_readers + args.history_readers > 16:
        parser.error("at most 16 concurrent readers total")
    return args


def point(step, keys):
    """Globally unique, exactly representable sentinels, independent of arrival order."""
    key_index = step % keys
    return {"key": "loss" if key_index == 0 else f"loss_{key_index}", "step": step,
            "timestamp": TIMESTAMP_BASE + step, "value": float(step + 1)}


def batches(producer, args):
    steps = range(producer, args.points, args.concurrency)
    for offset in range(0, len(steps), args.batch_size):
        yield [point(step, args.keys) for step in steps[offset:offset + args.batch_size]]


def history_target(reader, request_index, args):
    """Choose a run/key pair that the configured workload actually writes."""
    step = (reader + request_index) % args.points
    return (step % args.concurrency) % args.runs, point(step, args.keys)["key"]

def latency_summary(seconds):
    """Nearest-rank percentiles over all attempts (including failed requests)."""
    values = sorted(seconds)
    return {"count": len(values), **{
        f"p{percent}_ms": values[math.ceil(percent / 100 * len(values)) - 1] * 1000
        if values else None for percent in (50, 95, 99)}}


def error_status(exc):
    if isinstance(exc, APIError):
        return str(exc.status)
    if isinstance(exc, TimeoutError) or (
            isinstance(exc, URLError) and isinstance(exc.reason, TimeoutError)):
        return "timeout"
    return "transport_or_client_error"


class Recorder:
    """One recorder/client per worker; no shared mutable HTTP opener or stats lock."""
    def __init__(self, client):
        self.client = client
        self.operations = {}
        self.errors = []

    def request(self, operation, method, path, payload=None, **kwargs):
        bucket = self.operations.setdefault(operation, {"latencies": [], "acknowledged": 0,
                                                       "status_errors": Counter()})
        started = time.perf_counter()
        try:
            result = self.client.http.request(method, path, payload, **kwargs)
        except Exception as exc:
            bucket["status_errors"][error_status(exc)] += 1
            if len(self.errors) < 5:
                self.errors.append(f"{operation}: {type(exc).__name__}: {str(exc)[:240]}")
            return None
        else:
            bucket["acknowledged"] += 1
            return result
        finally:
            bucket["latencies"].append(time.perf_counter() - started)


def summarize_requests(recorders):
    merged = {}
    for recorder in recorders:
        for name, bucket in recorder.operations.items():
            target = merged.setdefault(name, {"latencies": [], "acknowledged": 0,
                                              "status_errors": Counter()})
            target["latencies"].extend(bucket["latencies"])
            target["acknowledged"] += bucket["acknowledged"]
            target["status_errors"].update(bucket["status_errors"])
    return {name: {"attempted": len(bucket["latencies"]),
                   "acknowledged": bucket["acknowledged"],
                   "status_errors": dict(sorted(bucket["status_errors"].items())),
                   "latency": latency_summary(bucket["latencies"])}
            for name, bucket in sorted(merged.items())}


class IntegrityError(RuntimeError):
    pass


def verify_point(row, run_index, key, args, acknowledged, seen):
    step = row.get("step")
    if type(step) is not int or not 0 <= step < args.points:
        raise IntegrityError(f"run {run_index}: unexpected step {step!r}")
    expected_run = (step % args.concurrency) % args.runs
    expected = point(step, args.keys)
    if expected_run != run_index or key != expected["key"] or any(
            row.get(field) != value for field, value in expected.items()):
        raise IntegrityError(f"run {run_index}, key {key}, step {step}: tuple mismatch")
    if not acknowledged[step]:
        raise IntegrityError(f"run {run_index}, step {step}: unacknowledged write observed; possible lost ack")
    if seen[step]:
        raise IntegrityError(f"run {run_index}, step {step}: duplicate observation")
    seen[step] = 1


def verify_history(recorder, path, run_index, key, args, acknowledged, seen, expected_count):
    query = {"key": key, "limit": args.page_size}
    snapshot = None
    after = 0
    count = 0
    # Extra rows cannot turn a broken cursor into an unbounded loop.
    for _ in range(args.points // args.page_size + 2):
        page = recorder.request("verify_history", "GET", path + "/metrics", query=query)
        if page is None:
            raise IntegrityError(f"run {run_index}, key {key}: readback request failed")
        if snapshot is None:
            snapshot = page["snapshot"]
        if page["snapshot"] != snapshot or page["total"] != expected_count:
            raise IntegrityError(f"run {run_index}, key {key}: snapshot/count mismatch")
        rows = page["points"]
        if len(rows) > args.page_size:
            raise IntegrityError("history exceeded requested page size")
        for row in rows:
            seq = row["seq"]
            if type(seq) is not int or not after < seq <= snapshot:
                raise IntegrityError("history sequence did not advance within snapshot")
            after = seq
            verify_point(row, run_index, key, args, acknowledged, seen)
            count += 1
        if page["next_after"] is None:
            if count != expected_count:
                raise IntegrityError(f"run {run_index}, key {key}: incomplete history")
            return count
        if not rows or page["next_after"] != after:
            raise IntegrityError("invalid history cursor")
        query.update(after=after, snapshot=snapshot)
    raise IntegrityError("history exceeded bounded page budget")


def execute(args, server, report, recorders):
    def new_recorder():
        recorder = Recorder(Client(server.url, token=server.token, timeout=args.timeout))
        recorders.append(recorder)
        return recorder

    setup = new_recorder()
    experiments = []
    paths = []
    for index in range(args.experiments):
        result = setup.request("setup", "POST", "/api/experiments",
                               {"name": "throughput" if index == 0 else f"throughput-{index}"})
        if result is None:
            raise RuntimeError("experiment setup failed (not retried)")
        experiments.append(result["id"])
    for index in range(args.runs):
        result = setup.request("setup", "POST", "/api/runs",
                               {"experiment_id": experiments[index % args.experiments],
                                "name": f"batched scalar probe {index}"})
        if result is None:
            raise RuntimeError("run setup failed (not retried)")
        paths.append(f"/api/runs/{result['id']}")
    report["run_ids"] = [path.rsplit("/", 1)[1] for path in paths]
    report["experiment_ids"] = experiments
    acknowledged = bytearray(args.points)
    gate, stop = threading.Event(), threading.Event()
    producers = []

    def produce(index, recorder, counts):
        gate.wait()
        for rows in batches(index, args):
            counts["attempted_points"] += len(rows)
            result = recorder.request("write", "POST", paths[index % args.runs] + "/metrics",
                                      {"metrics": rows})
            if result is None:
                continue  # Never retry, including 503 or ambiguous transport failures.
            if result != {"inserted": len(rows)}:
                counts["invalid_acknowledgments"] += 1
                continue
            counts["acknowledged_points"] += len(rows)
            for row in rows:
                acknowledged[row["step"]] = 1  # Producers own disjoint indices.

    def read(index, kind, recorder):
        gate.wait()
        for request_index in range(args.max_reader_requests):
            if stop.is_set():
                break
            if kind == "catalog":
                recorder.request("catalog", "GET", "/api/catalog")
            else:
                run_index, key = history_target(index, request_index, args)
                recorder.request("history", "GET", paths[run_index] + "/metrics",
                                 query={"key": key, "limit": args.page_size})
            if stop.wait(args.reader_interval):
                break

    readers = args.catalog_readers + args.history_readers
    with ThreadPoolExecutor(max_workers=args.concurrency + readers) as pool:
        futures = []
        for index in range(args.concurrency):
            counts = {"producer": index, "run": index % args.runs,
                      "attempted_points": 0, "acknowledged_points": 0,
                      "invalid_acknowledgments": 0}
            producers.append(counts)
            futures.append(pool.submit(produce, index, new_recorder(), counts))
        reader_futures = []
        for kind, number in (("catalog", args.catalog_readers), ("history", args.history_readers)):
            for index in range(number):
                reader_futures.append(pool.submit(read, index, kind, new_recorder()))
        started = time.perf_counter()
        gate.set()
        try:
            for future in futures:
                future.result()
        finally:
            report["write_seconds"] = time.perf_counter() - started
            stop.set()
        for future in reader_futures:
            future.result()
    report["producers"] = producers
    report["attempted_points"] = sum(p["attempted_points"] for p in producers)
    report["acknowledged_points"] = sum(p["acknowledged_points"] for p in producers)
    report["invalid_acknowledgments"] = sum(p["invalid_acknowledgments"] for p in producers)
    report["observations_per_second"] = report["acknowledged_points"] / report["write_seconds"]

    started = time.perf_counter()
    verifier = new_recorder()
    seen = bytearray(args.points)
    expected = Counter(((step % args.concurrency) % args.runs, point(step, args.keys)["key"])
                       for step, accepted in enumerate(acknowledged) if accepted)
    known_keys = [point(index, args.keys)["key"] for index in range(args.keys)]
    for run_index, path in enumerate(paths):
        keys = verifier.request("verify_keys", "GET", path + "/metric-keys")
        expected_keys = sorted(key for key in known_keys if expected[run_index, key])
        if keys is None or sorted(keys.get("keys", [])) != expected_keys:
            report["integrity_errors"].append(f"run {run_index}: metric key set mismatch")
        # Read even empty histories, to detect unacknowledged commits and contamination.
        for key in known_keys:
            try:
                verify_history(verifier, path, run_index, key, args, acknowledged, seen,
                               expected[run_index, key])
            except (IntegrityError, KeyError, TypeError, ValueError) as exc:
                if len(report["integrity_errors"]) < 20:
                    report["integrity_errors"].append(str(exc))
    report["points"] = sum(seen)
    report["missing_acknowledged_points"] = sum(a and not s for a, s in zip(acknowledged, seen))
    if report["missing_acknowledged_points"]:
        report["integrity_errors"].append("acknowledged points missing from verified readback")
    report["read_seconds"] = time.perf_counter() - started


def emit(event):
    print(json.dumps(event, sort_keys=True, allow_nan=False), flush=True)


def main(argv=None):
    args = parse_args(argv)
    server = Server()
    environment = {"platform": platform.platform(), "python": sys.version,
                   "python_executable": sys.executable, "hostname": socket.gethostname(),
                   "cpu_count": os.cpu_count(), "pixi": os.environ.get("PIXI_ENVIRONMENT_NAME"),
                   "storage_path": str(server.directory), "binary": str(server.binary)}
    binary_hash = None
    if server.binary.is_file():
        with server.binary.open("rb") as binary:
            binary_hash = hashlib.file_digest(binary, "sha256").hexdigest()
    common = {"schema_version": SCHEMA_VERSION, "phase": "http-throughput",
              "binary_sha256": binary_hash, "environment": environment}
    emit({**common, "kind": "config", "config": vars(args),
          "workload": "closed-loop; fresh empty temporary database; scalar writes; no retries"})
    report = {**common, "kind": "final", "config": vars(args), "success": False,
              "points": 0, "batch_size": args.batch_size, "attempted_points": 0,
              "acknowledged_points": 0, "invalid_acknowledgments": 0,
              "missing_acknowledged_points": 0, "write_seconds": 0, "read_seconds": 0,
              "observations_per_second": 0, "integrity_errors": [], "fatal_errors": [],
              "run_ids": [], "experiment_ids": [], "producers": []}
    recorders = []
    try:
        server.start()
        execute(args, server, report, recorders)
    except Exception as exc:
        report["fatal_errors"].append(f"{type(exc).__name__}: {str(exc)[:500]}")
    finally:
        try:
            server.close()
        except Exception as exc:
            report["fatal_errors"].append(f"cleanup: {type(exc).__name__}: {str(exc)[:500]}")
    report["requests"] = summarize_requests(recorders)
    report["request_error_examples"] = [error for recorder in recorders for error in recorder.errors][:20]
    report["status_errors"] = dict(sum((Counter(bucket["status_errors"])
                                       for bucket in report["requests"].values()), Counter()))
    report["attempted_requests"] = sum(b["attempted"] for b in report["requests"].values())
    report["acknowledged_requests"] = sum(b["acknowledged"] for b in report["requests"].values())
    report["failed_requests"] = sum(report["status_errors"].values())
    report["http_503"] = report["status_errors"].get("503", 0)
    report["http_500"] = report["status_errors"].get("500", 0)
    report["timeouts"] = report["status_errors"].get("timeout", 0)
    report["write_latency"] = report["requests"].get("write", {}).get("latency", latency_summary([]))
    report["request_latency"] = latency_summary([
        value for recorder in recorders for bucket in recorder.operations.values()
        for value in bucket["latencies"]])
    report["success"] = not (report["fatal_errors"] or report["integrity_errors"]
                             or report["status_errors"] or report["invalid_acknowledgments"]
                             or report["acknowledged_points"] != args.points)
    emit(report)
    return 0 if report["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
