"""Black-box server fixture; no direct database access in API assertions."""
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "examples"))
from nset_client import Client


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

    def close(self):
        self.stop()
        self.temp.cleanup()
