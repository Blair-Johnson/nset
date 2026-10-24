"""A copied binary must serve without the checkout or language runtimes on PATH."""
import http.client
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import subprocess
import tempfile
import time
import unittest

from support import ROOT


class StandaloneExecutableTests(unittest.TestCase):
    def test_one_executable_empty_path_ui_native_mlflow_wandb(self):
        original = Path(os.environ.get("NSET_BINARY", ROOT / "target/debug/nset")).resolve()
        with tempfile.TemporaryDirectory(prefix="nset-standalone-") as directory:
            root = Path(directory)
            binary = root / ("nset.exe" if os.name == "nt" else "nset")
            shutil.copy2(original, binary)
            empty_path = root / "empty-path"
            empty_path.mkdir()
            env = {"PATH": str(empty_path), "NSET_TOKEN": "standalone-smoke-secret-" + "x" * 40}
            if os.name == "nt":
                env["SystemRoot"] = os.environ["SystemRoot"]
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            log = open(root / "server.log", "wb")
            process = subprocess.Popen([str(binary), "serve", "--host", "127.0.0.1", "--port", str(port), "--db-path", "./state"], cwd=root, env=env, stdout=log, stderr=log)

            def request(path, body=None, auth=True):
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                headers = {"Content-Type": "application/json"}
                if auth:
                    headers["Authorization"] = "Bearer " + env["NSET_TOKEN"]
                try:
                    connection.request("GET" if body is None else "POST", path, body=None if body is None else json.dumps(body), headers=headers)
                    response = connection.getresponse()
                    raw = response.read()
                    self.assertEqual(response.status, 200, raw)
                    return raw
                finally:
                    connection.close()

            try:
                for _ in range(100):
                    if process.poll() is not None:
                        self.fail((root / "server.log").read_text())
                    try:
                        request("/api/health")
                        break
                    except OSError:
                        time.sleep(0.05)
                else:
                    self.fail("copied executable did not start")
                html = request("/", auth=False).decode()
                assets = re.findall(r'(?:src|href)="(/assets/[^"]+)"', html)
                self.assertTrue(assets, html)
                for asset in assets:
                    self.assertTrue(request(asset, auth=False))
                eid = json.loads(request("/api/2.0/mlflow/experiments/create", {"name": "outside-checkout"}))["experiment_id"]
                run = json.loads(request("/api/2.0/mlflow/runs/create", {"experiment_id": eid, "start_time": 100}))["run"]
                rid = run["info"]["run_id"]
                request("/api/2.0/mlflow/runs/log-batch", {"run_id": rid, "metrics": [{"key": "loss", "value": 0.123456789123, "step": 1, "timestamp": 100}], "params": [{"key": "batch_size", "value": "16"}], "tags": []})
                history = json.loads(request("/api/2.0/mlflow/metrics/get-history?run_id=" + rid + "&metric_key=loss"))
                self.assertEqual(history["metrics"][0]["value"], 0.123456789123)
                gql = 'mutation UpsertBucket($name:String,$project:String,$entity:String,$config:JSONString) { upsertBucket(input:{name:$name,modelName:$project,entityName:$entity,config:$config}) { bucket { id name config } inserted } }'
                result = json.loads(request("/graphql", {"query": gql, "variables": {"name": "smoke", "project": "copied", "entity": "local", "config": '{"lr":{"value":0.25}}'}}))
                self.assertIn("upsertBucket", result["data"])
                request("/files/local/copied/smoke/file_stream", {"files": {"wandb-history.jsonl": {"offset": 0, "content": ['{"_step":0,"_timestamp":1,"score":0.875}']}}, "complete": True, "exitcode": 0})
                native = json.loads(request("/api/runs"))["runs"]
                self.assertEqual(len(native), 2)
                self.assertTrue(any(run["params"].get("lr") == 0.25 for run in native), native)
                self.assertEqual(sorted(path.name for path in (root / "state").glob("*.sqlite3")), ["ingest.sqlite3", "nset.sqlite3"])
                self.assertFalse((root / "state" / "artifacts").exists())
                self.assertFalse((root / "web").exists())
                print(json.dumps({"kind": "standalone_smoke", "platform": platform.platform(), "machine": platform.machine(), "path": "empty", "ui_assets": len(assets), "native_runs": len(native), "single_port": True}), flush=True)
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                log.close()


if __name__ == "__main__":
    unittest.main()
