"""Run the compact shell journey against isolated, genuinely embedded assets.

After building web/dist and the server: pixi run python web/tests/shell-embedded.py
NSET_BINARY can select a separately built binary. No Vite/API interception is used.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))
from support import Server


def main():
    os.environ.setdefault("NSET_BINARY", str(ROOT / "target/release/nset"))
    server = Server().start()
    try:
        experiment = server.client.experiment("Dense embedded workspace")
        for index in range(60):
            run = server.client.start_run(
                experiment, f"Run {index:02d} training",
                params={"seed": index, "training.optimizer.lr": 0.001, "enabled": True},
            )
            run.log_batch([
                {"key": "train/loss", "step": step, "value": 3 - step + index / 100}
                for step in range(3)
            ])
            run.finish()
        subprocess.run(
            ["node", str(ROOT / "web/tests/shell-embedded.mjs")],
            env=dict(os.environ, NSET_SHELL_URL=server.url, NSET_SHELL_TOKEN=server.token),
            check=True,
        )
    finally:
        server.close()


if __name__ == "__main__":
    main()
