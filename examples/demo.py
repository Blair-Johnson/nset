"""Populate a running server with deliberately revealing plots and image sequences."""
import argparse
import json
import math
import os
from pathlib import Path
import random
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from nset_client import Client
from images import frame_png


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8080")
    parser.add_argument("--token", default=os.environ.get("NSET_TOKEN"))
    parser.add_argument("--token-file", type=Path)
    parser.add_argument("--frames", type=int, default=16)
    parser.add_argument("--points", type=int, default=1601)
    args = parser.parse_args()
    token = args.token_file.read_text().strip() if args.token_file else args.token
    if not token:
        parser.error("set NSET_TOKEN or pass --token-file")
    if args.frames < 2 or args.points < 2:
        parser.error("--frames and --points must be at least 2")
    client = Client(args.url, token=token)
    experiment = client.experiment("Vision training")
    ids = []
    for index, name in enumerate(["baseline · Adam", "cosine schedule", "high-rate stress test"]):
        rng = random.Random(42 + index)
        with client.start_run(experiment, name, params={"lr": [0.001, 0.003, 0.01][index],
                              "seed": 42 + index, "optimizer": "AdamW"},
                              tags={"purpose": "visual verification"}) as run:
            ids.append(run.id)
            batch = []
            for point in range(args.points):
                step = point * (7 + index)
                t = step / 10000
                loss = 1.5 * math.exp(-5 * t) + 0.12 + index * 0.025
                loss += 0.035 * math.sin(step / 130) + rng.uniform(-0.012, 0.012)
                if point % 233 == 0:
                    loss += 0.35  # Narrow spikes must remain visible in raw data.
                for key, value in [("validation/loss", loss), ("train/loss", loss * 0.83),
                                   ("train/learning_rate", 0.001 * (1 + math.cos(min(t, 1) * math.pi)) + 1e-6)]:
                    batch.append({"key": key, "step": step, "value": value,
                                  "timestamp": 1735689600000 + step * 25})
                if len(batch) >= 9000:
                    run.log_batch(batch)
                    batch = []
            if batch:
                run.log_batch(batch)
            for frame in range(args.frames):
                fraction = frame / (args.frames - 1)
                step = round(fraction * (args.points - 1) * (7 + index))
                run.log_image_bytes("validation/prediction", frame_png(fraction, index), step=step,
                                    timestamp=1735689600000 + step * 25)
        print(json.dumps({"kind": "demo_run", "run_id": run.id, "name": name}), flush=True)
    print(json.dumps({"kind": "demo_complete", "experiment_id": experiment["id"],
                      "run_ids": ids, "points_per_metric": args.points, "frames_per_run": args.frames}))


if __name__ == "__main__":
    main()
