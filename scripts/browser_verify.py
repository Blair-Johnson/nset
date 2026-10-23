"""Exercise the redesigned workspace against an isolated embedded Rust server."""
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
        run_a = server.client.start_run(experiment, "Curve A", params={
            "train.optim.lr": 0.001, "train.optim.batch_size": 64,
            "data.source.root_path": "/datasets/vision/train",
            "model": {"width": 128, "layers": [32, 64, 128], "pretrained": False}})
        run_b = server.client.start_run(experiment, "Curve B", params={"train.optim.lr": 0.003})
        for run, points in [(run_a, [(0, 1), (10, 3), (20, 1)]),
                            (run_b, [(0, 2), (5, 2), (20, 4)])]:
            run.log_batch([{"key": "train/loss", "step": x, "value": y,
                            "timestamp": run.data["created_at"] + x * 1000} for x, y in points])
            run.log_batch([{"key": "eval/score", "step": x, "value": y,
                            "timestamp": run.data["created_at"] + x * 1000}
                           for x, y in [(0, .1), (10, .8), (20, .9)]])
            for frame in range(4):
                run.log_image_bytes("train/prediction", frame_png(frame / 3), step=frame * 10)
            run.finish()
        other = server.client.experiment("Other experiment")
        remote = server.client.start_run(other, "Remote baseline")
        remote.log_batch([{"key": "validation/error", "step": x, "value": y}
                          for x, y in [(0, 4), (10, 2), (20, 1)]])
        remote.finish()
        env = dict(os.environ, NSET_BROWSER_URL=server.url, NSET_BROWSER_TOKEN=server.token,
                   NSET_BROWSER_FIXTURE=json.dumps({"experiment": experiment["id"],
                       "a": run_a.id, "b": run_b.id, "startA": run_a.data["created_at"],
                        "startB": run_b.data["created_at"], "other": other["id"], "remote": remote.id}))
        subprocess.run(["node", str(ROOT / "scripts/browser_verify.mjs")], env=env, check=True)
    finally:
        server.close()


if __name__ == "__main__":
    main()
