"""Measure one complete 100k-observation browser view; no timing-based pass threshold."""
import json
import math
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
from support import Server


def main():
    server = Server().start()
    try:
        run = server.client.start_run(server.client.experiment("Dense series probe"), "Dense 100k")
        def value(step):
            return 0.05 + 1 / (1 + step / 1000) + 0.02 * math.sin(step / 200) + (0.3 if step % 7777 == 0 else 0)
        for start in range(0, 100000, 10000):
            run.log_batch([{"key": "loss", "step": step, "value": value(step)}
                           for step in range(start, start + 10000)])
        run.finish()
        env = dict(os.environ, NSET_BROWSER_URL=server.url, NSET_BROWSER_TOKEN=server.token,
                   NSET_EXPECTED_QUERY=str((value(50) + value(51)) / 2))
        subprocess.run(["node", str(ROOT / "scripts/browser_perf.mjs")], env=env, check=True)
    finally:
        server.close()


if __name__ == "__main__":
    main()
