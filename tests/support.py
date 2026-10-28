"""Black-box server fixture; no direct database access in API assertions."""
import os
import hashlib
from unittest.mock import patch
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "examples"))
import nset_client
from nset_client import Client, DeliveryError


def isolated_env(home):
    """Subprocesses use the same installed package, never a source path override."""
    env = dict(os.environ, HOME=str(home), XDG_STATE_HOME=str(home / "state"),
               LOCALAPPDATA=str(home / "local"), NSET_SPOOL_DIR=str(home / "journal"))
    env.pop("PYTHONPATH", None)
    env["NSET_TEST_CLIENT_SOURCE"] = str(Path(nset_client.__file__).resolve())
    return env


class IsolatedClientTestCase(unittest.TestCase):
    """Protect user spools even when transport receipts are globally mocked."""
    def setUp(self):
        self.client_home = tempfile.TemporaryDirectory(prefix="nset-client-test-")
        self.addCleanup(self.client_home.cleanup)
        patcher = patch.dict(os.environ, isolated_env(Path(self.client_home.name)), clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.clients = []
        self.addCleanup(self.close_clients)

    def client(self, *args, **kwargs):
        client = Client(*args, **kwargs)
        self.clients.append(client)
        return client

    def close_clients(self):
        for client in self.clients:
            client.close(timeout=1)


class Server:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nset-test-")
        self.directory = Path(self.temp.name)
        self.token = secrets.token_hex(24)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.binary = Path(os.environ.get("NSET_BINARY", ROOT / "target/debug/nset")).resolve()
        self.spool_patch = patch("nset_client.client._spool_path", side_effect=lambda url:
            self.directory / "nset" / "outbox" / hashlib.sha256(url.encode()).hexdigest() / "scalars.journal")
        self.spool_patch.start()
        self.client = Client(self.url, token=self.token)
        self.process = None

    def start(self):
        env = dict(os.environ, NSET_TOKEN=self.token)
        self.log = open(self.directory / "server.log", "ab")
        self.process = subprocess.Popen([str(self.binary), "serve", "--db-path", str(self.directory / "data"),
                                         "--host", "127.0.0.1", "--port", str(self.port)],
                                        env=env, stdout=self.log, stderr=self.log)
        for _ in range(150):
            if self.process.poll() is not None:
                break
            try:
                if self.client.http.request("GET", "/api/health")["status"] == "ok":
                    return self
            except Exception:
                time.sleep(0.1)
        self.stop()
        raise RuntimeError((self.directory / "server.log").read_text(errors="replace"))

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if getattr(self, "log", None):
            self.log.close()

    def project(self):
        """Wait explicitly for scalar acceptance and eventual test readback."""
        self.client.flush(timeout=10)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.client.http.request("GET", "/api/ingest/status")["pending_batches"] == 0:
                return
            time.sleep(.02)
        raise AssertionError("scalar projection did not drain")

    def close(self):
        try:
            self.client.close(timeout=.5)
        except DeliveryError:
            pass  # Failure tests deliberately retain data in this disposable fixture.
        finally:
            self.stop()
            self.spool_patch.stop()
            self.temp.cleanup()
