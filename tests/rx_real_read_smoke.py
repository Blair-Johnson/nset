"""Bounded, opt-in real-source verification using nset's configured reader only.

Usage: python tests/rx_real_read_smoke.py artifacts/nset /path/to/repo
No rx execution or direct SQLite connection is made against the source. The
private server/native store are temporary; SQLite reader coordination is allowed.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

binary = Path(sys.argv[1]).resolve()
repo = Path(sys.argv[2]).resolve()
env = os.environ.copy()
for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"):
    env.pop(key, None)
env["GIT_OPTIONAL_LOCKS"] = "0"
common = Path(subprocess.check_output(
    ["git", "-C", str(repo), "rev-parse", "--path-format=absolute", "--git-common-dir"],
    text=True, env=env).strip())
db = common / "rx/rx.sqlite"


def metadata():
    result = {}
    for suffix in ("", "-wal", "-shm"):
        path = Path(str(db) + suffix)
        try:
            st = path.stat()
            result[suffix or "database"] = {
                "device": st.st_dev, "inode": st.st_ino, "bytes": st.st_size,
                "mtime_ns": st.st_mtime_ns, "mode": oct(st.st_mode & 0o777),
            }
        except FileNotFoundError:
            result[suffix] = None
    return result


Path("artifacts").mkdir(exist_ok=True)
report = {"source": str(repo), "before": metadata(), "runs": {}}
with tempfile.TemporaryDirectory(prefix="nset-rx-real-read-") as data:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    with open("artifacts/real-source-server.log", "w") as log:
        process = subprocess.Popen([
            str(binary), "serve", "--host", "127.0.0.1", "--port", str(port),
            "--token", "test-secret", "--db-path", data, "--rx-repo", str(repo),
        ], stdout=log, stderr=log, env=env)

        def request(path, body=None):
            raw = None if body is None else json.dumps(body).encode()
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/api{path}", data=raw,
                headers={"Authorization": "Bearer test-secret", "Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=5) as response:
                body = response.read(8 * 1024 * 1024 + 1)
                if len(body) > 8 * 1024 * 1024:
                    raise RuntimeError("bounded response budget exceeded")
                return json.loads(body)

        try:
            deadline = time.monotonic() + 10
            while True:
                try:
                    request("/catalog")
                    break
                except (OSError, urllib.error.URLError):
                    if process.poll() is not None or time.monotonic() >= deadline:
                        raise
                    time.sleep(0.1)
            for rid in (859, 241):
                catalog = request(f"/rx/catalog?after={rid - 1}")
                if catalog.get("error"):
                    raise RuntimeError(catalog["error"])
                run = next((r for r in catalog["runs"] if r["id"] == str(rid)), None)
                if run is None:
                    report["runs"][str(rid)] = {"available": False}
                    raise RuntimeError(f"requested example r{rid} is unavailable")
                conditions = [{"path": "kind", "op": "eq", "value": "epoch" if rid == 859 else "metric"}]
                if rid == 241:
                    conditions.append({"path": "phase", "op": "eq", "value": "train"})
                query = {"source_id": catalog["source"]["id"], "runs": [run["run_uid"]],
                         "x": "epoch" if rid == 859 else "epochs_seen",
                         "ys": ["train_loss", "val_loss"] if rid == 859 else ["metrics.loss"],
                         "filters": {"conditions": conditions}}
                plot = request("/rx/plot", query)
                records = request("/rx/records", {**query, "limit": 2})
                for record in records["records"]:
                    assert isinstance(record["seq"], str)
                    assert json.loads(record["raw"]) == record["data"]
                result = {"available": True, "run_uid": run["run_uid"],
                          "plot": plot, "inspection": records}
                report["runs"][str(rid)] = result
                if rid == 241:
                    result["step_plot"] = request("/rx/plot", {**query, "x": "step"})
                    result["fields"] = request("/rx/fields", {**query, "prefix": "metrics."})
                    assert result["plot"]["traces"] and result["plot"]["traces"][0]["points"]
                    assert result["step_plot"]["traces"] and result["step_plot"]["traces"][0]["points"]
                    assert any(f["path"] == "metrics.loss" for f in result["fields"]["fields"])
                else:
                    assert len(plot["traces"]) == 2 and all(len(t["points"]) == 6 for t in plot["traces"]), "r859 no longer matches its six-epoch example"
                assert records["records"], "example inspection returned no matching events"
        except Exception as error:
            report["error"] = repr(error)
            raise
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise
            finally:
                report["after"] = metadata()
                Path("artifacts/real-source-read.json").write_text(json.dumps(report, indent=2))

summary = {}
for rid, result in report["runs"].items():
    if not result["available"]:
        summary[rid] = {"available": False}
        continue
    summary[rid] = {"available": True, "traces": len(result["plot"]["traces"]),
                    "points": [len(t["points"]) for t in result["plot"]["traces"]],
                    "diagnostics": result["plot"]["diagnostics"],
                    "inspected_sequences": [r["seq"] for r in result["inspection"]["records"]]}
print(json.dumps({"kind": "real_source", "gates": "passed", "runs": summary,
                  "database_metadata_unchanged": report["before"]["database"] == report["after"]["database"],
                  "evidence": "artifacts/real-source-read.json"}))
