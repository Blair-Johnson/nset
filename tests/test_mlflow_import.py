"""End-to-end check of scripts/mlflow_import.py against a disposable server."""
import importlib.util
import io
import sqlite3
import struct
import sys
import tempfile
import unittest
import zlib
from contextlib import redirect_stdout
from pathlib import Path

from support import ROOT, Server

spec = importlib.util.spec_from_file_location("mlflow_import", ROOT / "scripts" / "mlflow_import.py")
mlflow_import = importlib.util.module_from_spec(spec)
sys.modules["mlflow_import"] = mlflow_import  # dataclasses resolve annotations via sys.modules
spec.loader.exec_module(mlflow_import)

RUN = "a" * 32
DELETED = "b" * 32


def png(width=2, height=2):
    raw = b"".join(b"\x00" + b"\x7f\x00\x00" * width for _ in range(height))
    chunk = lambda kind, data: (struct.pack(">I", len(data)) + kind + data
                                + struct.pack(">I", zlib.crc32(kind + data)))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def mlflow_store(directory: Path) -> tuple[Path, Path]:
    db = directory / "mlflow.db"
    conn = sqlite3.connect(db)
    conn.executescript("""
        CREATE TABLE experiments(experiment_id INTEGER, name TEXT, artifact_location TEXT, lifecycle_stage TEXT);
        CREATE TABLE runs(run_uuid TEXT, name TEXT, user_id TEXT, status TEXT, start_time INTEGER,
            end_time INTEGER, lifecycle_stage TEXT, artifact_uri TEXT, experiment_id INTEGER);
        CREATE TABLE params(key TEXT, value TEXT, run_uuid TEXT);
        CREATE TABLE tags(key TEXT, value TEXT, run_uuid TEXT);
        CREATE TABLE metrics(key TEXT, value REAL, timestamp INTEGER, run_uuid TEXT, step INTEGER, is_nan BOOLEAN);
    """)
    conn.execute("INSERT INTO experiments VALUES(1,'probe','mlflow-artifacts:/1','active')")
    conn.execute("INSERT INTO experiments VALUES(2,'old','mlflow-artifacts:/2','deleted')")
    conn.execute("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)",
                 (RUN, "baseline", "me", "FINISHED", 1000, 2000, "active", f"mlflow-artifacts:/1/{RUN}/artifacts", 1))
    conn.execute("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)",
                 (DELETED, "gone", "me", "KILLED", 500, 600, "deleted", f"mlflow-artifacts:/2/{DELETED}/artifacts", 2))
    conn.executemany("INSERT INTO params VALUES(?,?,?)",
                     [("lr", "0.001", RUN), ("layers", "4", RUN), ("opt", "adam", RUN), ("amp", "True", RUN)])
    conn.executemany("INSERT INTO tags VALUES(?,?,?)", [("mlflow.runName", "baseline", RUN), ("team", "rf", RUN)])
    rows = [("loss", 1.0 / (s + 1), 1000 + s, RUN, s, 0) for s in range(12_345)]
    rows += [("loss", 0.0, 99_999, RUN, 20_000, 1),            # NaN
             ("loss", 1.7976931348623157e308, 99_999, RUN, 20_001, 0),  # +inf encoding
             ("acc", 0.5, 1500, RUN, -1, 0),                    # negative step
             ("acc", 0.75, 1600, RUN, 3, 0),
             ("x", 1.0, 1, DELETED, 0, 0)]
    conn.executemany("INSERT INTO metrics VALUES(?,?,?,?,?,?)", rows)
    conn.commit()
    conn.close()
    images = directory / "bucket" / "1" / RUN / "artifacts" / "images"
    images.mkdir(parents=True)
    uid = "0" * 8 + "-0000-0000-0000-" + "0" * 12
    for step in (0, 5):
        stem = f"eval#recon+step+{step}+timestamp+{3000 + step}+{uid[:-1]}{step}"
        (images / f"{stem}.png").write_bytes(png())
        (images / f"{stem}+compressed.webp").write_bytes(b"thumbnail")
    (images.parent / "config.yaml").write_text("lr: 0.001\n")
    (images.parent / "plot.png").write_bytes(png(3, 3))
    return db, directory / "bucket"


class MlflowImportTest(unittest.TestCase):
    def setUp(self):
        self.server = Server().start()
        self.addCleanup(self.server.close)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db, self.bucket = mlflow_store(Path(self.temp.name))

    def run_import(self, *extra):
        argv = ["--sqlite", str(self.db), "--artifacts", str(self.bucket), "--url", self.server.url,
                "--token", self.server.token, "--work-dir", str(Path(self.temp.name) / "work"), *extra]
        with redirect_stdout(io.StringIO()):
            return mlflow_import.main(argv)

    def test_import_is_faithful_and_idempotent(self):
        self.assertEqual(self.run_import("--other-images"), 0)
        api = self.server.client.http
        experiments = {e["name"]: e for e in api.request("GET", "/api/experiments")["experiments"]}
        self.assertEqual(set(experiments), {"probe", "old (deleted in MLflow)"})
        runs = {r["name"]: r for r in api.request("GET", "/api/runs")["runs"]}
        run = runs["baseline"]
        self.assertEqual(run["status"], "finished")
        self.assertEqual(runs["gone"]["status"], "failed")
        self.assertEqual(run["params"], {"lr": 0.001, "layers": 4, "opt": "adam", "amp": True})
        self.assertEqual(run["tags"]["team"], "rf")
        self.assertEqual(run["tags"]["mlflow_import.run_id"], RUN)
        self.assertEqual(run["tags"]["mlflow_import.start_time"], 1000)
        page = api.request("GET", f"/api/runs/{run['id']}/metrics", query={"key": "loss", "limit": 5})
        self.assertEqual(page["total"], 12_345)
        self.assertEqual([(p["step"], p["timestamp"]) for p in page["points"][:2]], [(0, 1000), (1, 1001)])
        acc = api.request("GET", f"/api/runs/{run['id']}/metrics", query={"key": "acc"})
        self.assertEqual([(p["step"], p["value"]) for p in acc["points"]], [(3, 0.75)])
        images = api.request("GET", f"/api/runs/{run['id']}/images")["images"]
        self.assertEqual(sorted((i["key"], i["step"]) for i in images),
                         [("artifacts/plot.png", 0), ("eval/recon", 0), ("eval/recon", 5)])
        self.assertEqual(sorted(i["timestamp"] for i in images if i["key"] == "eval/recon"), [3000, 3005])
        report = (Path(self.temp.name) / "work" / "import-report.json").read_text()
        for reason in ("NaN metric value", "infinite metric value", "negative metric step"):
            self.assertIn(reason, report)

        # Second pass: nothing new is created and verification still passes.
        self.assertEqual(self.run_import("--other-images"), 0)
        self.assertEqual(len(api.request("GET", "/api/runs")["runs"]), 2)
        self.assertEqual(len(api.request("GET", f"/api/runs/{run['id']}/images")["images"]), 3)
        again = api.request("GET", f"/api/runs/{run['id']}/metrics", query={"key": "loss", "limit": 1})
        self.assertEqual(again["total"], 12_345)

    def test_filters_and_skip_deleted(self):
        self.assertEqual(self.run_import("--skip-deleted", "--experiment", "probe", "--no-images"), 0)
        runs = self.server.client.http.request("GET", "/api/runs")["runs"]
        self.assertEqual([r["name"] for r in runs], ["baseline"])


if __name__ == "__main__":
    unittest.main()
