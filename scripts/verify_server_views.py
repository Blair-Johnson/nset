"""Focused server-view verification; invoke inside Pixi (and preferably rx).

Uses disposable rx scratch when supplied, never another checkout's build target.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    os.chdir(ROOT)
    env = dict(os.environ, CARGO_PROFILE_DEV_DEBUG="0", CARGO_PROFILE_TEST_DEBUG="0", CARGO_INCREMENTAL="0", CI="1")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        env["NSET_TEST_PORT"] = str(sock.getsockname()[1])
    commands = [
        ["npm", "--prefix", "web", "ci"],
        ["npm", "--prefix", "web", "test"],
        ["npm", "--prefix", "web", "run", "build"],
        ["cargo", "fmt", "--all", "--", "--check"],
        ["cargo", "test", "--locked", "--lib", "--test", "backend_views", "--test", "backend_hardening", "--test", "backend_api", "--test", "backend_rx"],
        ["cargo", "build", "--locked"],
        ["npm", "--prefix", "web", "exec", "--", "playwright", "install", "chromium"],
        ["npm", "--prefix", "web", "run", "test:browser", "--", "server-views.spec.ts", "workbench.spec.ts", "records.spec.ts", "navigation.spec.ts", "drawer-selection.spec.ts", "http-ui-ids.spec.ts", "dashboard-settings.spec.ts", "--workers=2"],
        [sys.executable, "scripts/smoke_server_views.py"],
    ]
    if "--frontend-only" in sys.argv:
        commands = [command for command in commands if command[0] == "npm"]
    for index, command in enumerate(commands):
        print(json.dumps({"kind": "verification", "step": index, "command": command}), flush=True)
        subprocess.run(command, env=env, check=True)
    print(json.dumps({"kind": "final", "suite": "server-views", "status": "passed", "steps": len(commands)}), flush=True)


if __name__ == "__main__":
    main()
