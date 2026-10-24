"""Launch a loopback-only demo with a generated token retained in ignored artifacts/."""
import argparse
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
from nset_client import Client


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--binary", type=Path, default=ROOT / "target/release/nset")
    parser.add_argument("--frames", type=int, default=16)
    args = parser.parse_args()
    artifacts = ROOT / "artifacts"
    artifacts.mkdir(exist_ok=True)
    token_path = artifacts / "preview.token"
    if not token_path.exists():
        descriptor = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            output.write(secrets.token_urlsafe(32) + "\n")
    token = token_path.read_text().strip()
    url = f"http://127.0.0.1:{args.port}"
    env = dict(os.environ)
    env.pop("NSET_TOKEN", None)
    process = subprocess.Popen([str(args.binary.resolve()), "serve", "--db-path", str(artifacts / "preview-data"),
                                "--host", "127.0.0.1", "--port", str(args.port),
                                "--token-file", str(token_path)], env=env)
    def stop(signum, frame):
        process.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        client = Client(url, token=token)
        for attempt in range(150):
            if process.poll() is not None:
                raise RuntimeError("server stopped before becoming ready")
            try:
                client.http.request("GET", "/api/health")
                break
            except Exception:
                time.sleep(0.1)
        else:
            raise RuntimeError("server did not become ready")
        if not client.http.request("GET", "/api/runs")["runs"]:
            subprocess.run([sys.executable, str(ROOT / "examples/demo.py"), "--url", url,
                            "--token-file", str(token_path), "--frames", str(args.frames)], check=True)
        print(f"Preview ready: {url}; token file: {token_path}", flush=True)
        process.wait()
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    main()
