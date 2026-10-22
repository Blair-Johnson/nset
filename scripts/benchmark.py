"""Modest end-to-end throughput probe; results are observations, not guarantees."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from support import Server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--points", type=int, default=100000)
    parser.add_argument("--batch-size", type=int, default=1000)
    args = parser.parse_args()
    if args.points < 1 or not 1 <= args.batch_size <= 10000:
        parser.error("positive points and batch-size in 1..10000 required")
    server = Server().start()
    try:
        run = server.client.start_run(server.client.experiment("throughput"), "batched scalar probe")
        started = time.perf_counter()
        for start in range(0, args.points, args.batch_size):
            run.log_batch([{"key": "loss", "step": step, "value": 1 / (step + 1)}
                           for step in range(start, min(start + args.batch_size, args.points))])
        write_seconds = time.perf_counter() - started
        started = time.perf_counter()
        count = sum(1 for _ in server.client.metric_history(run.id, "loss"))
        read_seconds = time.perf_counter() - started
        if count != args.points:
            raise AssertionError(f"missing points: {count} vs {args.points}")
        print(json.dumps({"kind": "final", "phase": "http-throughput",
                          "points": count, "batch_size": args.batch_size,
                          "write_seconds": write_seconds, "read_seconds": read_seconds,
                          "observations_per_second": count / write_seconds,
                          "binary_sha256": hashlib.sha256(server.binary.read_bytes()).hexdigest(),
                          "environment": {"platform": platform.platform(), "python": sys.version,
                                          "pixi": os.environ.get("PIXI_ENVIRONMENT_NAME")}}), flush=True)
    finally:
        server.close()


if __name__ == "__main__":
    main()
