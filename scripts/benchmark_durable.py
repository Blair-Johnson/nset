"""Bounded durable delivery benchmark with local spools and exact readback.

Fresh temporary server/database; all points first committed to client spools.
Delivery timing includes 503 retries and ends after all server acknowledgements.
Projection timing ends only when every acknowledged batch is query-visible.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
from http.client import HTTPException
from urllib.error import URLError
import json
import os
from pathlib import Path
import platform
import sys
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from support import Server
from nset_client import APIError, Client


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--points", type=int, default=100000)
    parser.add_argument("--batch-size", type=int, default=1000)
    parser.add_argument("--clients", type=int, default=32)
    parser.add_argument("--write-concurrency", type=int, default=8)
    parser.add_argument("--read-workers", type=int, default=2)
    parser.add_argument("--http-workers", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    if not 1 <= args.points <= 10_000_000 or not 1 <= args.batch_size <= 10000:
        parser.error("points must be 1..10000000, batch-size 1..10000")
    if not 1 <= args.clients <= 128 or args.clients > args.points:
        parser.error("clients must be 1..128 and no greater than points")
    if not 1 <= args.write_concurrency <= 1024 or not 1 <= args.read_workers <= 64 or not 1 <= args.http_workers <= 256:
        parser.error("concurrency out of range")
    if not 1 <= args.timeout <= 3600:
        parser.error("timeout must be 1..3600")
    return args


def main():
    args = arguments()
    server = Server()
    try:
        with patch.dict(os.environ, {
            "NSET_WRITE_CONCURRENCY": str(args.write_concurrency),
            "NSET_READ_WORKERS": str(args.read_workers),
            "NSET_HTTP_WORKERS": str(args.http_workers),
            "NSET_INGEST_PAUSED": "false",
        }):
            server.start()
        return measure(args, server)
    finally:
        server.close()


# Workload and verification helpers follow.
def measure(args, server):
    client = server.client
    exp = client.experiment("durable-load")
    runs = [client.start_run(exp, f"producer-{i}") for i in range(args.clients)]
    spools, expected, paths = [], [], []
    local_start = time.monotonic()
    try:
        for i, run in enumerate(runs):
            sender = Client(server.url, token=server.token, timeout=10)
            spool = sender.durable_outbox(server.directory / f"outbox-{i}.sqlite3")
            spools.append(spool)
            rows = [{"key": "sentinel", "step": n, "timestamp": 1_000_000 + n, "value": float(n)}
                    for n in range(i, args.points, args.clients)]
            expected.append(rows)
            for start in range(0, len(rows), args.batch_size):
                batch_id = f"batch-{start}"
                spool.enqueue(run.id, rows[start:start + args.batch_size], batch_id=batch_id)
                paths.append(run.path + "/ingest/" + batch_id)
        local_seconds = time.monotonic() - local_start
        print(json.dumps({"kind": "config", "config": vars(args), "python": platform.python_version(),
                          "binary_sha256": hashlib.sha256(server.binary.read_bytes()).hexdigest(),
                          "workload": "fresh DB; durable local spools; closed-loop PUT retries; exact readback"}), flush=True)
        started = time.monotonic()
        deadline = started + args.timeout

        def deliver(spool):
            overloads, network_retries = 0, 0
            while spool.pending_count():
                if time.monotonic() >= deadline:
                    raise TimeoutError("delivery deadline exceeded; unacknowledged rows remain in spool")
                try:
                    spool.flush()
                except APIError as error:
                    if error.status != 503:
                        raise
                    overloads += 1
                    time.sleep(0.02)
                except (URLError, OSError, HTTPException):
                    network_retries += 1
                    time.sleep(0.02)
            return overloads, network_retries

        with ThreadPoolExecutor(max_workers=args.clients) as pool:
            retry_stats = list(pool.map(deliver, spools))
        accepted_seconds = time.monotonic() - started
        for path in paths:
            while client.http.request("GET", path)["state"] != "applied":
                if time.monotonic() >= deadline:
                    raise TimeoutError("projection deadline exceeded; accepted batches remain journaled")
                time.sleep(0.02)
        applied_seconds = time.monotonic() - started
        errors = 0
        actual_count = 0
        for run, wanted in zip(runs, expected):
            actual = list(client.metric_history(run.id, "sentinel"))
            actual_count += len(actual)
            actual_values = sorted((p["step"], p["timestamp"], p["value"]) for p in actual)
            wanted_values = sorted((p["step"], p["timestamp"], p["value"]) for p in wanted)
            errors += int(actual_values != wanted_values)
        success = errors == 0 and actual_count == args.points
        print(json.dumps({"kind": "final", "config": vars(args), "success": success,
                          "offered_points": args.points, "verified_points": actual_count,
                          "integrity_errors": errors, "http_503": sum(s[0] for s in retry_stats),
                          "network_retries": sum(s[1] for s in retry_stats),
                          "retries": sum(sum(s) for s in retry_stats), "local_spool_seconds": local_seconds,
                          "accepted_seconds": accepted_seconds, "applied_seconds": applied_seconds,
                          "acceptance_points_per_second": args.points / accepted_seconds,
                          "query_visible_points_per_second": args.points / applied_seconds,
                          "remaining_outbox_batches": sum(s.pending_count() for s in spools)}), flush=True)
        return 0 if success else 1
    finally:
        for spool in spools:
            spool.close()


if __name__ == "__main__":
    raise SystemExit(main())
