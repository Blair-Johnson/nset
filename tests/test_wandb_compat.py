"""Direct Rust W&B protocol tests; never start/import the removed Python gateway.

Set NSET_BINARY to a compiled nset binary. NSET_WANDB_SDK_TEST=1 additionally
runs the official SDK (optionally using NSET_WANDB_PYTHON). Default SDK metadata
upload warnings are expected: CreateRunFiles is deliberately unsupported.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
import gzip
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class RustServer:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nset-wandb-")
        self.directory = Path(self.temp.name)
        self.token = secrets.token_hex(24)
        self.binary = Path(os.environ["NSET_BINARY"]).resolve()
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.process = None
        self.log = None

    def start(self):
        self.log = open(self.directory / "server.log", "ab")
        self.process = subprocess.Popen([
            str(self.binary), "serve", "--host", "127.0.0.1", "--port", str(self.port),
            "--token", self.token, "--db-path", str(self.directory / "data"),
        ], stdout=self.log, stderr=self.log)
        for _ in range(150):
            if self.process.poll() is not None:
                break
            try:
                status, body = self.request("/api/health", method="GET")
                if status == 200 and body.get("status") == "ok":
                    return self
            except OSError:
                pass
            time.sleep(0.1)
        self.stop()
        raise RuntimeError((self.directory / "server.log").read_text(errors="replace"))

    def stop(self, kill=False):
        if self.process and self.process.poll() is None:
            self.process.kill() if kill else self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if self.log:
            self.log.close()

    def close(self):
        self.stop()
        self.temp.cleanup()

    def request(self, path, data=None, method="POST", compressed=False, basic=False):
        headers = {"Authorization": "Bearer " + self.token, "Content-Type": "application/json"}
        if basic:
            headers["Authorization"] = "Basic " + base64.b64encode(("api:" + self.token).encode()).decode()
        encoded = None if data is None else json.dumps(data).encode()
        if compressed:
            encoded = gzip.compress(encoded)
            headers["Content-Encoding"] = "gzip"
        request = Request(self.url + path, data=encoded, headers=headers, method=method)
        try:
            with urlopen(request, timeout=40) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            raw = error.read()
            return error.code, json.loads(raw) if raw else {}

    def gql(self, query, variables=None):
        return self.request("/graphql", {"query": query, "variables": variables or {}}, basic=True)

    def bucket(self, name="r", entity="e", project="p"):
        status, body = self.gql('query($e:String,$p:String,$r:String) { model(name:$p,entityName:$e) { bucket(name:$r) { id name config summaryMetrics historyLineCount historyTail eventsLineCount eventsTail logLineCount wandbConfig state } } }', {"e": entity, "p": project, "r": name})
        assert status == 200, (status, body)
        return body["data"]["model"]["bucket"]

    def points(self, run_id, key):
        query = {"key": key, "limit": 10000}
        points = []
        while True:
            status, page = self.request(f"/api/runs/{run_id}/metrics?" + urlencode(query), method="GET")
            assert status == 200, (status, page)
            points.extend(page["points"])
            if page["next_after"] is None:
                return points
            query.update(after=page["next_after"], snapshot=page["snapshot"])


@unittest.skipUnless(os.environ.get("NSET_BINARY"), "set NSET_BINARY to the Rust nset executable")
class WandbProtocolTests(unittest.TestCase):
    def setUp(self):
        self.server = RustServer()
        self.addCleanup(self.server.close)
        self.server.start()
        self.native_id = self.upsert()["bucket"]["id"]
        self.path = "/files/e/p/r/file_stream"

    def upsert(self, name="r", config=None):
        if config is None:
            config = {"lr": {"value": 0.1}, "enabled": {"value": True}, "layers": {"value": [8, 4]}}
        status, body = self.server.gql('mutation($r:String,$c:JSONString) { upsertBucket(input:{name:$r,modelName:"p",entityName:"e",config:$c}) { bucket { id name config } inserted } }', {"r": name, "c": json.dumps(config)})
        self.assertEqual(status, 200, body)
        return body["data"]["upsertBucket"]

    def stream(self, filename, lines, offset=0, **extra):
        return self.server.request(self.path, {"files": {filename: {"offset": offset, "content": lines}}, **extra})

    def test_typed_config_projects_into_native_params_and_merges(self):
        self.assertFalse(self.upsert(config={"schedule": {"value": {"kind": "cosine"}}, "nullable": {"value": None}})["inserted"])
        status, native = self.server.request("/api/runs/" + self.native_id, method="GET")
        self.assertEqual(status, 200, native)
        self.assertEqual(native["params"], {"lr": 0.1, "enabled": True, "layers": [8, 4], "schedule": {"kind": "cosine"}, "nullable": None})
        self.assertEqual(json.loads(self.server.bucket()["config"])["schedule"], {"value": {"kind": "cosine"}})
        self.server.stop(kill=True)
        self.server.start()
        self.assertEqual(self.upsert()["bucket"]["id"], self.native_id)
        self.assertEqual(self.server.request("/api/runs/" + self.native_id, method="GET")[1]["params"]["schedule"], {"kind": "cosine"})

    def test_history_retries_offline_identity_and_full_timestamp(self):
        first = '{"loss":1,"_step":0,"_timestamp":12.5}'
        for _ in range(2):
            self.assertEqual(self.stream("wandb-history.jsonl", [first])[0], 200)
        self.assertEqual(self.stream("wandb-history.jsonl", ['{"_timestamp":12.5,"_step":0,"loss":1}'], offset=1)[0], 200)
        self.assertEqual(self.stream("wandb-history.jsonl", ['{"loss":1,"_step":0,"_timestamp":12.5001}'], offset=2)[0], 200)
        points = self.server.points(self.native_id, "loss")
        self.assertEqual([p["value"] for p in points], [1, 1])
        self.assertEqual([p["timestamp"] for p in points], [12500, 12500])
        self.assertEqual(self.server.bucket()["historyLineCount"], 3)

    def test_offset_conflicts_gaps_and_invalid_completion_are_atomic(self):
        self.assertEqual(self.stream("wandb-history.jsonl", ['{"loss":1}'])[0], 200)
        for offset, line in [(0, '{"loss":2}'), (3, '{}')]:
            self.assertEqual(self.stream("wandb-history.jsonl", [line], offset)[0], 409)
        for extra in ({"complete": 1}, {"exitcode": True}, {"uploaded": ["x"]}):
            self.assertEqual(self.stream("wandb-history.jsonl", ['{"loss":9}'], 1, **extra)[0], 400)
        self.assertEqual(self.server.bucket()["historyLineCount"], 1)
        self.assertEqual([p["value"] for p in self.server.points(self.native_id, "loss")], [1])

    def test_summary_console_events_finish_and_restart_resume(self):
        for name, lines in [
            ("wandb-summary.json", ['{"loss":5,"note":"first"}']),
            ("wandb-summary.json", ['{"loss":3,"note":"retained"}']),
            ("output.log", ["é", "tail"]), ("output.log", ["updated"]),
            ("wandb-history.jsonl", ['{"loss":3,"_step":5,"_timestamp":12.5}']),
            ("wandb-events.jsonl", ['{"cpu":3,"_timestamp":1}']),
        ]:
            self.assertEqual(self.stream(name, lines)[0], 200)
        self.assertEqual(self.server.request(self.path, {"complete": True, "exitcode": 0, "uploaded": []})[0], 200)
        self.server.stop(kill=True)
        self.server.start()
        run = self.server.bucket()
        self.assertEqual(run["state"], "finished")
        self.assertEqual(run["logLineCount"], 2)
        self.assertEqual(run["eventsLineCount"], 1)
        self.assertEqual(json.loads(json.loads(run["historyTail"])[0])["_step"], 5)
        self.assertEqual(json.loads(run["summaryMetrics"]), {"loss": 3, "note": "retained"})
        self.assertIn("t", json.loads(run["wandbConfig"]))
        self.assertEqual(self.server.request("/api/runs/" + self.native_id, method="GET")[1]["status"], "finished")
        self.assertEqual(self.server.points(self.native_id, "system/cpu")[0]["value"], 3)
        self.assertFalse(self.upsert()["inserted"])
        self.assertEqual(self.stream("wandb-history.jsonl", ['{"loss":2,"_step":6}'], 1)[0], 200)
        self.assertEqual(self.server.request(self.path, {"complete": True, "exitcode": 1})[0], 200)
        self.assertEqual(self.server.request("/api/runs/" + self.native_id, method="GET")[1]["status"], "failed")

    def test_gzip_and_nonfinite_nested_raw_values(self):
        line = '{"nan":NaN,"huge":1e9999,"bool":true,"nested":{"x":1},"finite":4,"_step":2}'
        status, body = self.server.request(self.path, {"files": {"wandb-history.jsonl": {"offset": 0, "content": [line]}}}, compressed=True, basic=True)
        self.assertEqual(status, 200, body)
        self.assertEqual(self.server.points(self.native_id, "finite")[0]["value"], 4)
        for key in ("nan", "huge", "bool", "nested"):
            self.assertEqual(self.server.points(self.native_id, key), [])
        self.assertEqual(json.loads(self.server.bucket()["historyTail"]), [line])

    def test_wide_row_chunks_and_invalid_keys(self):
        row = {"metric-" + str(i): i for i in range(10001)}
        row["x" * 513] = 9
        row["huge"] = 10 ** 400
        self.assertEqual(self.stream("wandb-history.jsonl", [json.dumps(row)])[0], 200)
        for key in ("metric-0", "metric-9999", "metric-10000"):
            self.assertEqual(len(self.server.points(self.native_id, key)), 1)
        self.assertEqual(self.server.points(self.native_id, "huge"), [])

    def test_file_artifact_rejections_preflight_entire_operation(self):
        queries = [
            'mutation { createRunFiles(input:{files:["wandb-metadata.json"]}) { files { uploadUrl } } }',
            'mutation { markRunFilesUploaded(input:{files:["x"]}) { success } }',
            'mutation { createArtifact(input:{name:"x"}) { artifact { id } } }',
            '{ model(name:"p",entityName:"e") { bucket(name:"r") { files { edges { node { directUrl } } } } } }',
            'mutation { upsertBucket(input:{name:"must-not-exist",modelName:"p",entityName:"e"}) { bucket { id } } upload:createRunFiles(input:{files:["x"]}) { runID } }',
        ]
        for query in queries:
            with self.subTest(query=query):
                status, body = self.server.gql(query)
                self.assertEqual(status, 400, body)
                self.assertNotIn("data", body)
        self.assertIsNone(self.server.bucket("must-not-exist"))
        status, schema = self.server.gql('{ __type(name:"Mutation") { fields { name } } }')
        self.assertEqual(status, 200)
        self.assertNotIn("createRunFiles", {f["name"] for f in schema["data"]["__type"]["fields"]})
        for filename in ("config.yaml", "media/image.png", "../output.log", "requirements.txt"):
            self.assertEqual(self.server.request(self.path, {"files": {"wandb-history.jsonl": {"offset": 0, "content": ['{"loss":1}']}, filename: {"offset": 0, "content": ["x"]}}})[0], 400)
        self.assertEqual(self.server.bucket()["historyLineCount"], 0)
        for method in ("GET", "PUT", "HEAD"):
            self.assertEqual(self.server.request("/compat/files/wandb/run/file", {} if method == "PUT" else None, method=method)[0], 400)

    def test_graphql_selection_defaults_aliases_and_bounds(self):
        status, body = self.server.gql('query($show:Boolean=true) { me:viewer { name:username id @include(if:$show) email @skip(if:true) } unknown:__type(name:"Unknown") { name } }')
        self.assertEqual(status, 200, body)
        self.assertEqual(body["data"], {"me": {"name": "nset", "id": "nset"}, "unknown": None})
        for query in ('{viewer{unknown}}', '{viewer{id} unknown}', '{viewer{...F}}', '{viewer{id}} {viewer{id}}', '{a ' * 80 + '}' * 80, '#' + 'x' * 262145):
            self.assertEqual(self.server.gql(query)[0], 400)
        self.upsert("other")
        status, body = self.server.gql('{ model(name:"p",entityName:"e") { one:bucket(name:"r"){id} two:bucket(name:"other"){id} } }')
        self.assertEqual(status, 200, body)
        self.assertNotEqual(body["data"]["model"]["one"], body["data"]["model"]["two"])

    def test_concurrent_retries_and_cumulative_stream_restart(self):
        line = '{"loss":1,"_step":0,"_timestamp":1}'
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.stream("wandb-history.jsonl", [line]), range(16)))
        self.assertTrue(all(status == 200 for status, _ in results), results)
        self.assertEqual(len(self.server.points(self.native_id, "loss")), 1)
        for offset in range(1, 40):
            line = json.dumps({"loss": offset, "_step": offset, "_timestamp": offset + 1, "raw": "x" * 8192})
            self.assertEqual(self.stream("wandb-history.jsonl", [line], offset)[0], 200)
        self.server.stop(kill=True)
        self.server.start()
        self.assertEqual(self.stream("wandb-history.jsonl", [line], 39)[0], 200)
        self.assertEqual(self.stream("wandb-history.jsonl", [line], 40)[0], 200)
        self.assertEqual(len(self.server.points(self.native_id, "loss")), 40)
        self.assertEqual(self.server.bucket()["historyLineCount"], 41)

    def test_lost_http_ack_then_restart_retries_same_intent(self):
        payload = {"files": {"wandb-history.jsonl": {"offset": 0, "content": [json.dumps({"loss": i, "_step": i, "_timestamp": i + 1}) for i in range(250)]}}, "complete": True}
        raw = json.dumps(payload).encode()
        # Close without reading the response: the commit/ack boundary is unknown.
        with socket.create_connection(("127.0.0.1", self.server.port)) as connection:
            header = (f"POST {self.path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {self.server.token}\r\nContent-Type: application/json\r\nContent-Length: {len(raw)}\r\n\r\n").encode()
            connection.sendall(header + raw)
        self.server.stop(kill=True)
        self.server.start()
        for _ in range(2):
            status, body = self.server.request(self.path, payload)
            self.assertEqual(status, 200, body)
        self.assertEqual(len(self.server.points(self.native_id, "loss")), 250)
        self.assertEqual(self.server.bucket()["historyLineCount"], 250)
        self.assertEqual(self.server.bucket()["state"], "finished")


@unittest.skipUnless(os.environ.get("NSET_BINARY") and os.environ.get("NSET_WANDB_SDK_TEST") == "1", "opt-in official SDK against Rust nset serve")
class OfficialWandbSDKTests(unittest.TestCase):
    def setUp(self):
        self.server = RustServer()
        self.addCleanup(self.server.close)
        self.server.start()
        self.python = os.environ.get("NSET_WANDB_PYTHON", sys.executable)
        self.env = dict(os.environ, WANDB_BASE_URL=self.server.url, WANDB_API_KEY=self.server.token,
                        WANDB_DIR=str(self.server.directory), WANDB_CONFIG_DIR=str(self.server.directory / "config"),
                        WANDB_CACHE_DIR=str(self.server.directory / "cache"), WANDB_SILENT="false")

    def sdk(self, args, timeout=180):
        result = subprocess.run([self.python, *args], env=self.env, cwd=self.server.directory, capture_output=True, text=True, timeout=timeout)
        print(result.stdout, result.stderr, flush=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def test_default_scalar_finish_repeat_resume_and_restart(self):
        code = r'''
import json, sys, wandb
print(json.dumps({"sdk":wandb.__version__,"python":sys.executable}), flush=True)
phase = int(sys.argv[1])
r = wandb.init(project="sdk-project",entity="sdk-entity",id="sdk-run",resume="allow" if phase == 0 else "must",config={"lr":0.1},settings=wandb.Settings(init_timeout=35))
assert r.resumed == bool(phase), (phase,r.resumed)
r.config.update({"schedule":{"kind":"cosine"}},allow_val_change=True)
r.log({"loss":3.0-phase,"label":"raw-string"})
r.summary["note"] = "retained summary"
r.finish()
if phase == 0:
    with wandb.init(project="sdk-project",entity="sdk-entity",id="sdk-second") as other:
        print("default console output",flush=True)
        other.log({"accuracy":0.9})
'''
        for phase in range(2):
            self.sdk(["-c", code, str(phase)])
            if phase == 0:
                self.server.stop(kill=True)
                self.server.start()
        run = self.server.bucket("sdk-run", "sdk-entity", "sdk-project")
        points = self.server.points(run["id"], "loss")
        self.assertEqual([p["value"] for p in points], [3, 2])
        self.assertEqual([p["step"] for p in points], [0, 1])
        self.assertEqual(run["state"], "finished")
        self.assertEqual(json.loads(run["summaryMetrics"])["note"], "retained summary")
        self.assertIn("raw-string", run["historyTail"])
        native = self.server.request("/api/runs/" + run["id"], method="GET")[1]
        self.assertEqual(native["params"]["lr"], 0.1)
        self.assertEqual(native["params"]["schedule"], {"kind": "cosine"})
        self.assertGreater(self.server.bucket("sdk-second", "sdk-entity", "sdk-project")["logLineCount"], 0)
        # Explicit nonretryable rejection remains part of the real SDK contract.
        status, body = self.server.gql('mutation { createRunFiles(input:{entityName:"sdk-entity",projectName:"sdk-project",runName:"sdk-run",files:["wandb-metadata.json"]}) { files { uploadUrl } } }')
        self.assertEqual(status, 400, body)
        self.assertNotIn("data", body)

    def test_offline_capture_then_sync_and_repeat_sync(self):
        self.env["WANDB_BASE_URL"] = "http://127.0.0.1:1"
        self.sdk(["-c", '''
import wandb
with wandb.init(mode="offline",entity="sdk-entity",project="sdk-project",id="offline-run",config={"lr":0.2}) as r:
    r.log({"offline_loss":7.0,"label":"offline raw"})
    r.summary["note"] = "offline summary"
'''])
        sources = list((self.server.directory / "wandb").glob("offline-run-*/run-*.wandb"))
        self.assertEqual(len(sources), 1)
        self.assertGreater(sources[0].stat().st_size, 0)
        self.env["WANDB_BASE_URL"] = self.server.url
        for repeat in range(2):
            self.sdk(["-m", "wandb", "sync", "--include-synced", str(sources[0].parent)])
            if repeat == 0:
                self.server.stop(kill=True)
                self.server.start()
        run = self.server.bucket("offline-run", "sdk-entity", "sdk-project")
        self.assertEqual([p["value"] for p in self.server.points(run["id"], "offline_loss")], [7])
        self.assertEqual(run["state"], "finished")
        self.assertIn("offline raw", run["historyTail"])
        self.assertEqual(json.loads(run["summaryMetrics"])["note"], "offline summary")
        self.assertEqual(self.server.request("/api/runs/" + run["id"], method="GET")[1]["params"]["lr"], 0.2)


if __name__ == "__main__":
    unittest.main()
