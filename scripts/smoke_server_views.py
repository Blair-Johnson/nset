"""Real embedded-server/shared-view browser test with a disposable rx repository.

Run after web/build and cargo build: pixi run python scripts/smoke_server_views.py
NSET_BINARY overrides the debug binary; screenshots go to artifacts/server-views.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import tempfile
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


def main():
    binary = Path(os.environ.get("NSET_BINARY", Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "target")) / "debug/nset")).resolve()
    with tempfile.TemporaryDirectory(prefix="nset-shared-views-") as temp:
        directory = Path(temp)
        repo = directory / "rx-repo"
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        database = repo / ".git/rx/rx.sqlite"
        database.parent.mkdir()
        with sqlite3.connect(database) as db:
            db.executescript((ROOT / "tests/fixtures/rx-schema-9.sql").read_text())
            db.execute("INSERT INTO commands(id,argv) VALUES(1,'[]')")
            for run_id in (1, 2):
                db.execute("INSERT INTO runs(id,run_uid,state,command_id,argv,cwd_rel,config,created_at,exit_code) VALUES(?,?, 'succeeded',1,'[]','.','shared view smoke','2026-10-26T00:00:00Z',0)", (run_id, f"smoke-{run_id}"))
                for step in range(10):
                    db.execute("INSERT INTO events(run_id,seq,received_at,data) VALUES(?,?,?,?)", (run_id, step, "2026-10-26T00:00:00Z", json.dumps({"kind": "epoch", "epoch": step, "loss": run_id / (step + 1)})))
        db.close()
        before_rx = hashlib.sha256(database.read_bytes()).hexdigest()
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        url = f"http://127.0.0.1:{port}"
        token = secrets.token_hex(24)
        env = dict(os.environ, NSET_TOKEN=token, NSET_BROWSER_URL=url, NSET_BROWSER_TOKEN=token)
        command = [str(binary), "serve", "--db-path", str(directory / "data"), "--rx-repo", str(repo), "--host", "127.0.0.1", "--port", str(port)]

        def get(path):
            with urlopen(Request(url + path, headers={"Authorization": f"Bearer {token}"}), timeout=5) as response:
                return json.load(response)

        def start(log):
            process = subprocess.Popen(command, env=env, stdout=log, stderr=log)
            for _ in range(150):
                if process.poll() is not None:
                    raise RuntimeError((directory / "server.log").read_text())
                try:
                    get("/api/health")
                    return process
                except OSError:
                    time.sleep(.1)
            stop(process)
            raise RuntimeError("Server did not become ready")

        def stop(process):
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

        with (directory / "server.log").open("ab") as log:
            process = start(log)
            try:
                subprocess.run(["node", str(ROOT / "scripts/smoke_server_views.mjs")], env=env, check=True)
                saved = get("/api/views")
                assert len(saved["views"]) == 1, saved
            finally:
                stop(process)
            process = start(log)
            try:
                assert get("/api/views") == saved, "Server views did not survive restart"
                assert hashlib.sha256(database.read_bytes()).hexdigest() == before_rx, "rx database changed"
            finally:
                stop(process)
        print(json.dumps({"kind": "final", "test": "server-views-real-browser", "status": "passed", "restart_persistence": True, "rx_readonly": True}))


if __name__ == "__main__":
    main()
