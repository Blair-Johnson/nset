"""Bounded standalone rx smoke test; creates only a retained synthetic fixture.

Run from a fresh validation worktree: python3 tests/rx_release_smoke.py artifacts/nset
The temporary server uses an ephemeral loopback port and is always terminated.
"""
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

binary = Path(sys.argv[1]).resolve()
root = Path("artifacts/rx-demo").resolve()
if root.exists():
    raise RuntimeError("Refusing to replace an existing smoke fixture")
subprocess.run(["git", "init", "-q", str(root)], check=True)
folder = root / ".git" / "rx"
folder.mkdir()
db = folder / "rx.sqlite"
with sqlite3.connect(db) as c:
    c.executescript("""
        PRAGMA user_version=8;
        CREATE TABLE runs(id INTEGER PRIMARY KEY, run_uid TEXT UNIQUE, state TEXT,
          alias TEXT, config TEXT, created_at TEXT, started_at TEXT,
          finished_at TEXT, exit_code INTEGER, argv TEXT);
        CREATE TABLE events(run_id INTEGER, seq INTEGER, received_at TEXT,
          data TEXT, UNIQUE(run_id,seq));
    """)
    for rid, uid, name in [(859, "demo-859", "six_epoch_fixture"),
                           (241, "demo-241", "nested_metric_fixture")]:
        c.execute("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)", (
            rid, uid, "succeeded", name, "Synthetic user-testing fixture",
            "2026-10-24T00:00:00Z", None, None, 0, "[]"))
        c.execute("INSERT INTO events VALUES(?,?,?,?)", (
            rid, 1, "2026-10-24T00:00:00Z",
            json.dumps({"kind": "config", "synthetic": True, "config": {
                 "callbacks": {"on_step_end": ["save"]},
                 "data": {"baseband": True}, "optimizer": {"lr": 0.001},
                  "a.b": 1, "a": {"b": 2},
                 "\u65e5\u672c\u8a9e": "caf\u00e9 \U0001f4e1",
                 "unsafe_number": 9007199254740993,
             }}, ensure_ascii=False)))
    for epoch in range(1, 7):
        c.execute("INSERT INTO events VALUES(?,?,?,?)", (
            859, epoch + 4, "2026-10-24T00:00:00Z", json.dumps({
                "kind": "epoch", "phase": "validation", "epoch": epoch,
                "train_loss": 1 / epoch, "val_loss": 1.3 / epoch,
                "model": "example", "metrics": {"accuracy": 0.9}})))
        c.execute("INSERT INTO events VALUES(?,?,?,?)", (
            241, epoch + 15, "2026-10-24T00:00:00Z", json.dumps({
                "kind": "metric", "phase": "train", "step": epoch * 1000,
                "epochs_seen": epoch / 4,
                "metrics": {"loss": 2 / epoch, "learning_rate": 0.001},
                "metrics.loss": 10 / epoch})))
c.close()
before = hashlib.sha256(db.read_bytes()).hexdigest()
with tempfile.TemporaryDirectory(prefix="nset-rx-smoke-") as data:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    with open("artifacts/standalone-smoke.log", "w") as log:
        process = subprocess.Popen([
            str(binary), "serve", "--host", "127.0.0.1", "--port", str(port),
            "--token", "test-secret", "--db-path", data, "--rx-repo", str(root),
        ], stdout=log, stderr=log,
            env={**os.environ, "GIT_DIR": "/nonexistent/nset-rx-smoke"})

        def request(path, body=None):
            raw = None if body is None else json.dumps(body).encode()
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/api{path}", data=raw,
                headers={"Authorization": "Bearer test-secret",
                         "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=3) as response:
                return json.load(response)

        try:
            deadline = time.monotonic() + 10
            while True:
                try:
                    catalog = request("/rx/catalog")
                    break
                except (OSError, urllib.error.URLError):
                    if process.poll() is not None or time.monotonic() > deadline:
                        raise
                    time.sleep(0.1)
            query = {"source_id": catalog["source"]["id"], "runs": ["demo-859"],
                     "x": "epoch", "ys": ["train_loss", "val_loss"],
                     "filters": {"conditions": [
                         {"path": "kind", "op": "eq", "value": "epoch"}]}}
            # Verify this executable embeds this run's UI, not a stale bundle.
            assets = [Path("web/dist/index.html"), *Path("web/dist/assets").iterdir()]
            for asset in assets:
                if not asset.is_file():
                    continue
                route = "/" if asset.name == "index.html" else "/" + asset.relative_to("web/dist").as_posix()
                with urllib.request.urlopen(f"http://127.0.0.1:{port}{route}", timeout=3) as response:
                    content = response.read(asset.stat().st_size + 1)
                    assert content == asset.read_bytes(), asset
                    if asset.suffix in {".html", ".js", ".css"}:
                        text = content.decode("utf-8", errors="strict")
                        assert "\ufffd" not in text, asset
                        assert response.headers.get_content_charset() == "utf-8", response.headers
            result = request("/rx/plot", query)
            assert len(result["traces"]) == 2, result
            assert all(len(trace["points"]) == 6 for trace in result["traces"])
            raw = request("/rx/records", {**query, "limit": 1})
            assert json.loads(raw["records"][0]["raw"]) == raw["records"][0]["data"]
            assert request("/catalog")["rx_enabled"] is True
            # Independent event witnesses: config at seq 1 and metric at seq 5+.
            filters = {"source_id": catalog["source"]["id"],
                       "runs": ["demo-859", "demo-241"], "conditions": [
                           {"path": "metrics.accuracy", "op": "exists"},
                           {"path": "config.optimizer.lr", "op": "eq", "value": 0.001},
                       ]}
            matches = request("/rx/run-filter", filters)
            assert matches["runs"] == [
                {"uid": "demo-859", "conditions": [True, True]},
                {"uid": "demo-241", "conditions": [False, True]},
            ], matches
            assert matches["source_generation"] and matches["cursor"] is None
            try:
                unauth = urllib.request.Request(
                    f"http://127.0.0.1:{port}/api/rx/run-filter",
                    data=json.dumps(filters).encode(),
                    headers={"Content-Type": "application/json"})
                urllib.request.urlopen(unauth, timeout=3)
                raise AssertionError("run-filter accepted an unauthenticated request")
            except urllib.error.HTTPError as error:
                assert error.code == 401
            subprocess.run([
                "node", "web/tests/run-event-config-embedded.mjs",
                f"http://127.0.0.1:{port}", catalog["source"]["id"],
            ], check=True)
            assert before == hashlib.sha256(db.read_bytes()).hexdigest()
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise
print(json.dumps({"kind": "final", "gates": "passed", "binary": "artifacts/nset",
                  "fixture": "artifacts/rx-demo", "standalone_traces": 2,
                  "points_per_trace": 6, "source_unchanged": True, "embedded_ui_current": True, "utf8": True, "embedded_event_config": True, "embedded_run_filters": True}))
