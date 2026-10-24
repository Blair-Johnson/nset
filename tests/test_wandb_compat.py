"""W&B protocol unit tests and opt-in official-SDK integration.

Run SDK test with NSET_WANDB_SDK_TEST=1 and NSET_BINARY pointing to a
native durable-ingestion build. SDK dependencies are test-only.
"""
import copy
from contextlib import nullcontext
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.parse import urlsplit
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
import nset_compat
# In isolated protocol worktrees PYTHONPATH can supply the shared gateway.
# Load the adapter under test explicitly, not a different worktree's adapter.
spec = importlib.util.spec_from_file_location("nset_compat.wandb", ROOT / "python/nset_compat/wandb.py")
wandb = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = wandb
spec.loader.exec_module(wandb)
from nset_compat.common import ProtocolError, Request


class State:
    def __init__(self):
        self.data = {}

    def get(self, namespace, key, default=None):
        return copy.deepcopy(self.data.get((namespace, key), default))

    def put(self, namespace, key, value):
        self.data[namespace, key] = copy.deepcopy(value)

    def delete(self, namespace, key):
        self.data.pop((namespace, key), None)

    def items(self, namespace):
        return [(k, copy.deepcopy(v)) for (ns, k), v in self.data.items() if ns == namespace]


class Artifacts:
    def __init__(self):
        self.data = {}

    def put(self, namespace, path, data, content_type="application/octet-stream"):
        self.data[namespace, path] = data, content_type

    def get(self, namespace, path):
        try:
            return self.data[namespace, path]
        except KeyError:
            raise ProtocolError(404, "NOT_FOUND", "Missing artifact")


class Native:
    def __init__(self):
        self.calls = []
        self.runs = []
        self.lose_create_response = False

    def request(self, method, path, payload=None, **kwargs):
        self.calls.append((method, path, payload))
        if method == "GET" and path == "/api/runs":
            return {"runs": copy.deepcopy(self.runs)}
        result = {"id": "native-" + str(len(self.calls))}
        if method == "POST" and path == "/api/runs":
            result.update(payload)
            self.runs.append(result)
            if self.lose_create_response:
                self.lose_create_response = False
                raise ProtocolError(503, "RETRY", "Simulated lost creation response")
        return result


class Context:
    def __init__(self):
        self.token = "unit-test-token-" + "x" * 40
        self.state, self.artifacts, self.native = State(), Artifacts(), Native()
        self.lock = threading.RLock()
        self.batches = {}
        self.attempts = []
        self.fail = False

    def lock_for(self, key):
        return self.lock

    def signed_url(self, path, expires_in=3600):
        return "http://localhost" + path + "?expires=123&signature=abc"

    def ingest_metrics(self, run_id, batch_id, metrics, wait=True):
        self.attempts.append((batch_id, copy.deepcopy(metrics)))
        if batch_id in self.batches:
            assert self.batches[batch_id] == metrics
        self.batches[batch_id] = copy.deepcopy(metrics)
        if self.fail:
            self.fail = False
            raise ProtocolError(503, "RETRY", "Simulated committed receipt timeout")
        return {"status": "applied"}


def request(path, data=None, method="POST", body=None):
    return Request(method=method, path=path, query={}, headers={},
                   body=body if body is not None else json.dumps(data).encode())


def gql(ctx, query, variables=None):
    return wandb.handle(ctx, request("/graphql", {"query": query, "variables": variables or {}}))


class WandbProtocolTests(unittest.TestCase):
    def setUp(self):
        self.ctx = Context()
        self.upsert()
        self.path = "/files/e/p/r/file_stream"
        self.key = wandb._identity("e", "p", "r")

    def upsert(self):
        result = gql(self.ctx, 'mutation UpsertBucket($name:String,$project:String,$entity:String,$config:JSONString) { upsertBucket(input:{name:$name,modelName:$project,entityName:$entity,config:$config}) { bucket { id name config } inserted } }',
                     {"name": "r", "project": "p", "entity": "e", "config": '{"lr":{"value":0.1}}'})
        self.assertEqual(result.status, 200, result.body)
        return result

    def stream(self, filename, lines, offset=0, **extra):
        return wandb.handle(self.ctx, request(self.path, {"files": {filename: {"offset": offset, "content": lines}}, **extra}))

    def test_history_retry_preserves_raw_and_no_duplicate_metrics(self):
        lines = ['{"loss":2,"label":"hello","_step":3,"_timestamp":12.5}', '{"bad":[1,2]}', 'not-json']
        self.stream("wandb-history.jsonl", lines)
        self.stream("wandb-history.jsonl", lines)
        self.assertEqual(len(self.ctx.batches), 1)
        rows = next(iter(self.ctx.batches.values()))
        self.assertEqual(rows, [{"key": "loss", "value": 2, "step": 3, "timestamp": 12500}])
        raw, _ = self.ctx.artifacts.get(wandb._namespace(self.key), "wandb-history.jsonl")
        self.assertEqual(raw, ("\n".join(lines) + "\n").encode())
        self.assertEqual(len(self.ctx.attempts), 1)

    def test_offline_observation_replay_at_new_offset_preserves_raw_but_deduplicates(self):
        self.stream("wandb-history.jsonl", ['{"loss":1,"_step":0,"_timestamp":12.5}'])
        self.stream("wandb-history.jsonl", ['{"_timestamp":12.5,"_step":0,"loss":1}'], offset=1)
        self.assertEqual(len(self.ctx.batches), 1)
        self.assertEqual(len(self.ctx.state.get(wandb.RUNS, self.key)["streams"]["wandb-history.jsonl"]), 2)
        self.stream("wandb-history.jsonl", ['{"loss":1,"_step":0,"_timestamp":12.5001}'], offset=2)
        self.assertEqual(len(self.ctx.batches), 2)

    def test_chunk_limit_and_unrepresentable_keys_remain_raw(self):
        values = {"metric-" + str(i): i for i in range(10001)}
        values["x" * 513] = 1
        values["huge"] = 10 ** 400
        self.stream("wandb-history.jsonl", [json.dumps(values)])
        self.assertEqual(sorted(map(len, self.ctx.batches.values())), [1, 10000])
        raw, _ = self.ctx.artifacts.get(wandb._namespace(self.key), "wandb-history.jsonl")
        self.assertEqual(json.loads(raw)["huge"], 10 ** 400)

    def test_native_create_response_loss_recovers_same_run(self):
        self.ctx.native.lose_create_response = True
        query = 'mutation { upsertBucket(input:{name:"new",modelName:"p",entityName:"e"}) { bucket { id } } }'
        first = gql(self.ctx, query)
        self.assertEqual(first.status, 503)
        created_id = self.ctx.native.runs[-1]["id"]
        second = gql(self.ctx, query)
        self.assertEqual(second.body["data"]["upsertBucket"]["bucket"]["id"], created_id)
        self.assertEqual(len(self.ctx.native.runs), 2)  # baseline plus new, not three

    def test_oversized_stream_and_missing_upload_do_not_poison_pending(self):
        self.ctx.max_body_bytes = 10
        with self.assertRaises(ProtocolError) as error:
            self.stream("output.log", ["x" * 11])
        self.assertEqual(error.exception.status, 413)
        self.assertIsNone(self.ctx.state.get(wandb.PENDING, self.key))
        with self.assertRaises(ProtocolError):
            wandb.handle(self.ctx, request(self.path, {"uploaded":["missing.png"],"complete":True}))
        self.assertIsNone(self.ctx.state.get(wandb.PENDING, self.key))
        self.stream("output.log", ["valid"])

    def test_offset_gap_and_conflict_are_explicit(self):
        self.stream("wandb-history.jsonl", ['{"loss":1}'])
        for offset, line, code in [(0, '{"loss":2}', "OFFSET_CONFLICT"), (3, '{}', "OFFSET_GAP")]:
            with self.assertRaises(ProtocolError) as error:
                self.stream("wandb-history.jsonl", [line], offset=offset)
            self.assertEqual(error.exception.code, code)

    def test_committed_native_timeout_replays_identical_batch_after_restart(self):
        self.ctx.fail = True
        with self.assertRaises(ProtocolError):
            self.stream("wandb-history.jsonl", ['{"loss":1}'])
        old = self.ctx
        self.ctx = Context()
        self.ctx.state, self.ctx.artifacts, self.ctx.native = old.state, old.artifacts, old.native
        self.ctx.batches, self.ctx.attempts = old.batches, old.attempts
        self.stream("wandb-history.jsonl", ['{"loss":1}'])
        self.assertEqual(self.ctx.attempts[0], self.ctx.attempts[1])
        self.assertEqual(len(self.ctx.batches), 1)
        self.assertIsNone(self.ctx.state.get(wandb.PENDING, self.key))

    def test_summary_console_revisions_events_and_complete_survive(self):
        self.stream("wandb-summary.json", ['{"loss":5,"label":"first"}'])
        self.stream("wandb-summary.json", ['{"loss":3,"image":{"_type":"image-file"}}'])
        self.stream("output.log", ["first"])
        self.stream("output.log", ["rewritten"])
        self.stream("wandb-events.jsonl", ['{"cpu":3.0,"_timestamp":1}'])
        result = wandb.handle(self.ctx, request(self.path, {"complete": True, "exitcode": 0}))
        self.assertEqual(result.status, 200)
        run = self.ctx.state.get(wandb.RUNS, self.key)
        self.assertEqual(run["state"], "finished")
        self.assertIn("image", json.loads(run["summaryMetrics"]))
        self.assertEqual(len([k for ns, k in self.ctx.artifacts.data if ns == "wandb.requests." + self.key and k.startswith("filestream/")]), 6)
        self.assertTrue(any(row["key"] == "system/cpu" for rows in self.ctx.batches.values() for row in rows))

    def test_resume_and_repeat_upsert(self):
        self.stream("wandb-history.jsonl", ['{"loss":1,"_step":5}'])
        result = self.upsert()
        self.assertFalse(result.body["data"]["upsertBucket"]["inserted"])
        resumed = gql(self.ctx, '{ model(name:"p",entityName:"e") { bucket(name:"r",missingOk:true) { historyLineCount historyTail wandbConfig config } } }')
        bucket = resumed.body["data"]["model"]["bucket"]
        self.assertEqual(bucket["historyLineCount"], 1)
        self.assertEqual(json.loads(json.loads(bucket["historyTail"])[0])["_step"], 5)
        self.assertIn("t", json.loads(bucket["wandbConfig"]))
        self.assertEqual(len([c for c in self.ctx.native.calls if c[:2] == ("POST", "/api/runs")]), 1)

    def test_create_upload_download_media_and_traversal(self):
        result = gql(self.ctx, 'mutation { createRunFiles(input:{entityName:"e",projectName:"p",runName:"r",files:["media/images/a.png"]}) { runID uploadHeaders files { name uploadUrl } } }')
        url = result.body["data"]["createRunFiles"]["files"][0]["uploadUrl"]
        self.assertIn("signature=", url)
        path = urlsplit(url).path
        wandb.handle(self.ctx, request(path, method="PUT", body=b"PNG test bytes"))
        downloaded = wandb.handle(self.ctx, request(path, method="GET"))
        self.assertEqual(downloaded.body, b"PNG test bytes")
        with self.assertRaises(ProtocolError):
            wandb.handle(self.ctx, request(path.rsplit("/", 1)[0] + "/%2e%2e/escape", method="PUT", body=b"bad"))

    def test_unknown_graphql_never_fake_success(self):
        for query in ('mutation { createArtifact(input:{name:"x"}) { id } }', '{ viewer { unknownField } }', '{ viewer { id } anotherUnknown }'):
            response = gql(self.ctx, query)
            self.assertGreaterEqual(response.status, 400)
            self.assertIn("errors", response.body)
        response = gql(self.ctx, '{ a:__type(name:"UnknownType") { name } serverInfo { features { name isEnabled } } }')
        self.assertEqual(response.body["data"]["a"], None)

    def test_nonfinite_bool_and_nested_values_preserved_not_projected(self):
        self.stream("wandb-history.jsonl", ['{"nan":NaN,"bool":true,"nested":{"x":1},"finite":4}'])
        self.assertEqual([r["key"] for rows in self.ctx.batches.values() for r in rows], ["finite"])
        self.assertIn(b"NaN", self.ctx.artifacts.get(wandb._namespace(self.key), "wandb-history.jsonl")[0])


@unittest.skipUnless(os.environ.get("NSET_WANDB_SDK_TEST") == "1", "opt-in real SDK/native integration")
class OfficialWandbSDKTests(unittest.TestCase):
    def test_init_log_image_finish_repeat_resume_and_restart(self):
        from nset_compat.context import CompatContext
        from nset_compat.gateway import make_server
        from support import Server
        native = Server().start()
        self.addCleanup(native.close)
        self.assertGreaterEqual(len(native.token), 40)
        evidence = ROOT / "artifacts" / "wandb-sdk"
        evidence.mkdir(parents=True, exist_ok=True)
        evidence = Path(tempfile.mkdtemp(prefix="case-", dir=evidence))
        original_handle = wandb.handle
        def traced_handle(ctx, req):
            try:
                response = original_handle(ctx, req)
            except ProtocolError as exc:
                print(json.dumps({"route":req.path,"method":req.method,"status":exc.status,"error":exc.code}), flush=True)
                raise
            if response is not None:
                print(json.dumps({"route":req.path,"method":req.method,"status":response.status}), flush=True)
            return response
        wandb.handle = traced_handle
        self.addCleanup(setattr, wandb, "handle", original_handle)
        with nullcontext(str(evidence)) as directory:
            def start_gateway():
                ctx = CompatContext(native.url, native.token, Path(directory) / "gateway", "http://127.0.0.1:0")
                server = make_server(ctx)
                ctx.public_url = f"http://127.0.0.1:{server.server_address[1]}"
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                return ctx, server, thread

            ctx, server, thread = start_gateway()
            code = r'''
import json, os, sys, time
from pathlib import Path
import wandb
from PIL import Image
print(json.dumps({"sdk":wandb.__version__,"python":sys.executable}), flush=True)
phase = int(sys.argv[1])
r = wandb.init(project="sdk-project", entity="sdk-entity", id="sdk-run", resume="allow" if phase == 0 else "must", config={"lr":0.1}, settings=wandb.Settings(init_timeout=35, x_disable_stats=True, x_disable_meta=True, console="off"))
assert r.resumed == bool(phase), (phase,r.resumed)
if phase:
    Path("ready").touch()
    while not Path("go").exists():
        time.sleep(0.02)
r.config.update({"schedule":{"kind":"cosine"}}, allow_val_change=True)
r.log({"loss":3.0-phase,"label":"raw-string", "picture":wandb.Image(Image.new("RGB",(4,4),"red"))})
r.summary["note"] = "retained summary"
r.finish()
# A second distinct run verifies repeated init/finish in the same process.
if phase == 0:
    with wandb.init(project="sdk-project", entity="sdk-entity", id="sdk-second") as other:
        print("default console output", flush=True)
        other.log({"accuracy":0.9})
'''
            try:
                for phase in range(2):
                    env = dict(os.environ, WANDB_BASE_URL=ctx.public_url, WANDB_API_KEY=native.token,
                               WANDB_DIR=directory, WANDB_CONFIG_DIR=directory + "/config", WANDB_CACHE_DIR=directory + "/cache", WANDB_SILENT="true")
                    if phase == 0:
                        process = subprocess.run([sys.executable, "-c", code, str(phase)], env=env, cwd=directory, capture_output=True, text=True, timeout=150)
                        stdout, stderr, returncode = process.stdout, process.stderr, process.returncode
                    else:
                        outage_seen = threading.Event()
                        original_ingest = ctx.ingest_metrics
                        def observing_ingest(*args, **kwargs):
                            try:
                                return original_ingest(*args, **kwargs)
                            except Exception:
                                outage_seen.set()
                                raise
                        ctx.ingest_metrics = observing_ingest
                        process = subprocess.Popen([sys.executable, "-c", code, str(phase)], env=env, cwd=directory, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                        try:
                            deadline = time.monotonic() + 40
                            while not (evidence / "ready").exists() and process.poll() is None and time.monotonic() < deadline:
                                time.sleep(0.02)
                            self.assertTrue((evidence / "ready").exists(), "SDK did not reach outage barrier")
                            native.stop()
                            (evidence / "go").touch()
                            failed_while_down = outage_seen.wait(10)
                            native.start()
                            stdout, stderr = process.communicate(timeout=150)
                            returncode = process.returncode
                            self.assertTrue(failed_while_down, "No real ingest attempt observed during outage")
                        finally:
                            if process.poll() is None:
                                process.kill()
                                process.communicate()
                    print(stdout, stderr, flush=True)
                    self.assertEqual(returncode, 0, stdout + stderr)
                    if phase == 0:
                        server.shutdown(); server.server_close(); thread.join()
                        ctx.close()
                        ctx, server, thread = start_gateway()
                key = wandb._identity("sdk-entity", "sdk-project", "sdk-run")
                run = ctx.state.get(wandb.RUNS, key)
                points = list(native.client.metric_history(run["native_id"], "loss"))
                self.assertEqual([p["value"] for p in points], [3.0, 2.0])
                self.assertEqual([p["step"] for p in points], [0, 1])
                second_key = wandb._identity("sdk-entity", "sdk-project", "sdk-second")
                console, _ = ctx.artifacts.get(wandb._namespace(second_key), "output.log")
                self.assertIn(b"default console output", console)
                self.assertEqual(run["state"], "finished")
                self.assertEqual(json.loads(run["config"])["schedule"]["value"], {"kind":"cosine"})
                raw, _ = ctx.artifacts.get(wandb._namespace(key), "wandb-history.jsonl")
                self.assertIn(b"raw-string", raw)
                self.assertEqual(len(raw.splitlines()), 2)
                for row in map(json.loads, raw.splitlines()):
                    image, _ = ctx.artifacts.get(wandb._namespace(key), row["picture"]["path"])
                    self.assertTrue(image.startswith(b"\x89PNG"))
                    with urlopen(wandb._url(ctx, key, row["picture"]["path"]), timeout=10) as download:
                        self.assertEqual(download.read(), image)
                summary, _ = ctx.artifacts.get(wandb._namespace(key), "wandb-summary.json")
                self.assertIn(b"retained summary", summary)
                print(json.dumps({"kind":"final","sdk":"wandb","metrics":{"history_rows":len(points),"image_uploads":2,"restart_resume":1,"native_outage_retry":1}}), flush=True)
            finally:
                server.shutdown(); server.server_close(); thread.join()
                ctx.close()


    def test_offline_capture_then_sync_and_repeat_sync(self):
        from nset_compat.context import CompatContext
        from nset_compat.gateway import make_server
        from support import Server
        native = Server().start()
        self.addCleanup(native.close)
        root = ROOT / "artifacts" / "wandb-sdk"
        root.mkdir(parents=True, exist_ok=True)
        directory = Path(tempfile.mkdtemp(prefix="offline-", dir=root))
        env = dict(os.environ, WANDB_BASE_URL="http://127.0.0.1:1", WANDB_API_KEY=native.token,
                   WANDB_DIR=str(directory), WANDB_CONFIG_DIR=str(directory / "config"),
                   WANDB_CACHE_DIR=str(directory / "cache"), WANDB_SILENT="true")
        code = """
import wandb
from PIL import Image
with wandb.init(mode="offline",entity="sdk-entity",project="sdk-project",id="offline-run",settings=wandb.Settings(x_disable_stats=True,x_disable_meta=True,console="off")) as r:
    r.log({"offline_loss":7.0,"label":"offline raw", "picture":wandb.Image(Image.new("RGB",(3,3),"blue"))})
"""
        result = subprocess.run([sys.executable,"-c",code],env=env,cwd=directory,capture_output=True,text=True,timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        sources = list((directory / "wandb").glob("offline-run-*/run-*.wandb"))
        self.assertEqual(len(sources), 1)
        self.assertGreater(sources[0].stat().st_size, 0)
        ctx = CompatContext(native.url, native.token, directory / "gateway", "http://127.0.0.1:0")
        server = make_server(ctx)
        ctx.public_url = f"http://127.0.0.1:{server.server_address[1]}"
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        env["WANDB_BASE_URL"] = ctx.public_url
        try:
            for repeat in range(2):
                result = subprocess.run([sys.executable,"-m","wandb","sync","--include-synced",str(sources[0].parent)], env=env,cwd=directory,capture_output=True,text=True,timeout=150)
                print(result.stdout, result.stderr, flush=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            key = wandb._identity("sdk-entity","sdk-project","offline-run")
            run = ctx.state.get(wandb.RUNS, key)
            points = list(native.client.metric_history(run["native_id"],"offline_loss"))
            self.assertEqual([p["value"] for p in points],[7.0])
            self.assertEqual(run["state"], "finished")
            raw, _ = ctx.artifacts.get(wandb._namespace(key), "wandb-history.jsonl")
            self.assertIn(b"offline raw", raw)
            row = json.loads(raw.splitlines()[0])
            image, _ = ctx.artifacts.get(wandb._namespace(key), row["picture"]["path"])
            self.assertTrue(image.startswith(b"\x89PNG"))
            print(json.dumps({"kind":"final","sdk":"wandb","metrics":{"offline_sync":1,"repeat_sync_points":len(points)}}),flush=True)
        finally:
            server.shutdown(); server.server_close(); thread.join()
            ctx.close()


if __name__ == "__main__":
    unittest.main()
