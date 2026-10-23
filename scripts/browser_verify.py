"""Run real Chromium interactions against an isolated compiled server."""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
from support import Server
from images import frame_png


def main():
    server = Server().start()
    try:
        experiment = server.client.experiment("Browser verification")
        run_a = server.client.start_run(experiment, "Curve A", params={"lr": 0.001})
        run_b = server.client.start_run(experiment, "Curve B", params={"lr": 0.003})
        for run, points in [(run_a, [(0, 1), (10, 3), (20, 1)]),
                            (run_b, [(0, 2), (5, 2), (20, 4)])]:
            run.log_batch([{"key": "loss/test", "step": x, "value": y,
                            "timestamp": 1735689600000 + x * 1000} for x, y in points])
            for frame in range(4):
                run.log_image_bytes("prediction", frame_png(frame / 3), step=frame * 10)
            run.finish()
        env = dict(os.environ, NSET_BROWSER_URL=server.url, NSET_BROWSER_TOKEN=server.token,
                   NSET_BROWSER_FIXTURE=json.dumps({"experiment": experiment["id"],
                                                    "a": run_a.id, "b": run_b.id}))
        subprocess.run(["node", str(ROOT / "scripts/browser_verify.mjs")], env=env, check=True)
    finally:
        server.close()


if __name__ == "__main__":
    main()
