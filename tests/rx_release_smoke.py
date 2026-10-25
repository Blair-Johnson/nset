"""Standalone rx smoke test; creates only retained synthetic fixtures.

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
import urllib.parse
import urllib.request

# Kept inline so this release gate remains a single-file harness. The route gate
# forwards an actual backend response unchanged; it only makes busy UI observable.
COMPLETION_BROWSER = r"""
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
const [base, source] = process.argv.slice(1);
const address = new URL(base);
assert.equal(address.hostname, '127.0.0.1');
assert.ok(!['8081', '8082', ''].includes(address.port));
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await context.tracing.start({ screenshots: true, snapshots: true });
try {
  const page = await context.newPage();
  const errors = [];
  const catalogs = [];
  const filters = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/rx/catalog') catalogs.push(url);
    if (url.pathname === '/api/rx/run-filter') filters.push(request.postDataJSON());
  });
  let held = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/rx/run-filter', async route => {
    const response = await route.fetch();
    if (!held && route.request().postDataJSON().conditions.length === 2) {
      held = true;
      await gate;
    }
    await route.fulfill({ response });
  });
  try {
    await page.goto(`${base}/#/experiments/${encodeURIComponent(source)}/runs`);
    await page.getByLabel('Access token', { exact: true }).fill('test-secret');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Runs', exact: true })).toBeVisible();
    assert.equal(catalogs.length, 6);
    assert.equal(catalogs[0].searchParams.get('high_water'), null);
    for (const url of catalogs.slice(1)) {
      assert.equal(url.searchParams.get('high_water'), '1007');
      assert.ok(url.searchParams.get('source_generation'));
      assert.equal(url.searchParams.get('source_generation'), catalogs[1].searchParams.get('source_generation'));
    }
    await page.getByRole('checkbox', { name: 'Select r1', exact: true }).check();
    await page.getByRole('button', { name: 'View charts', exact: true }).click();
    if (await page.getByLabel('Expand run list', { exact: true }).isVisible())
      await page.getByLabel('Expand run list', { exact: true }).click();
    const drawer = page.locator('.run-drawer');
    const menu = drawer.locator('.run-filter-menu');
    await menu.locator('summary').click();
    async function clause(n, path, op, value) {
      await menu.getByRole('button', { name: '+ Add condition', exact: true }).click();
      await menu.getByLabel(`Condition ${n} scope`, { exact: true }).selectOption('event');
      const input = menu.getByLabel(`Condition ${n} path`, { exact: true });
      await input.fill(path);
      await input.press('Enter');
      await menu.getByLabel(`Condition ${n} operator`, { exact: true }).selectOption(op);
      if (value !== undefined) await menu.getByLabel(`Condition ${n} value`, { exact: true }).fill(value);
    }
    await clause(1, 'config.optimizer.lr', 'eq', '0.001');
    await clause(2, 'metrics.accuracy', 'exists');
    await menu.locator('summary').click();
    await expect.poll(() => held).toBe(true);
    const control = drawer.locator('.run-filter-control');
    await expect(control).toHaveAttribute('aria-busy', 'true');
    await expect(menu.locator('summary .run-filter-progress')).toHaveText('…');
    await expect(menu.locator('summary .run-filter-progress')).toHaveAttribute('aria-label', /^Searching/);
    await expect(page.getByRole('button', { name: /Continue/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry filter search', exact: true })).toBeHidden();
    await expect(control).not.toContainText(/unchecked|bounded|Continue/);
    const geometry = () => drawer.evaluate(root => ['.run-filter-control', '.run-filter-menu > summary', '.run-drawer-search'].map(selector => {
      const r = root.querySelector(selector).getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    }));
    const busyGeometry = await geometry();
    release();
    await expect(control).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
    await expect(drawer.locator('.run-drawer-row:visible')).toHaveCount(1);
    await expect(drawer.getByRole('checkbox', { name: 'Show r1007', exact: true })).toBeVisible();
    assert.deepEqual(await geometry(), busyGeometry);
    const completed = filters.filter(body => body.conditions.length === 2);
    const starts = completed.filter(body => !body.cursor);
    assert.equal(starts.length, 32);
    assert.equal(new Set(starts.flatMap(body => body.runs)).size, 1007);
    assert.ok(completed.filter(body => body.cursor && body.runs.includes('completion-1007')).length >= 5);
    assert.ok(completed.every(body => body.runs.length <= 32));
    await menu.locator('summary').click();
    await menu.getByRole('button', { name: 'Clear all', exact: true }).click();
    const missingStart = filters.length;
    await clause(1, 'present', 'missing');
    await menu.locator('summary').click();
    await expect(control).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
    await expect(drawer.locator('.run-drawer-row:visible')).toHaveCount(1);
    await expect(drawer.getByRole('checkbox', { name: 'Show r1007', exact: true })).toBeVisible();
    assert.ok(filters.slice(missingStart).filter(body => body.conditions[0]?.op === 'missing' && body.cursor).length >= 5);
    await page.getByRole('navigation', { name: 'Experiment views' }).getByRole('button', { name: 'Runs', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Select r1007', exact: true })).toBeVisible();
    await expect(page.locator('tbody tr[data-run-id]')).toHaveCount(1);
    await expect(page.locator('.selection-count')).toHaveText('1 selected');
    await page.screenshot({ path: '../artifacts/event-filter-completion-embedded.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ kind: 'embedded-completion', catalog_pages: catalogs.length,
      filter_batches: starts.length, cursor_requests: completed.filter(body => body.cursor).length,
      runs: 1007, events: 100002, separate_event_evidence: true, missing_complete: true,
      compact_progress: true, drawer_and_table: true }));
  } finally { release(); }
} finally {
  await context.tracing.stop({ path: '../artifacts/event-filter-completion-embedded-trace.zip' });
  await browser.close();
}
"""


def completion_smoke(binary):
    """A separate retained fixture, not the user's rx repository or live server."""
    root = Path("artifacts/rx-completion-demo").resolve()
    if root.exists():
        raise RuntimeError("Refusing to replace an existing completion fixture")
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
        c.executemany("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)", (
            (rid, f"completion-{rid}", "succeeded", None, "Synthetic completion fixture",
             "2026-10-24T00:00:00Z", None, None, 0, "[]") for rid in range(1, 1008)))
        c.executemany("INSERT INTO events VALUES(?,?,?,?)", (
            (rid, 1, "2026-10-24T00:00:00Z", '{"present":true}') for rid in range(1, 1007)))
        # Tiny valid events cross five 20,000-row scan budgets without 40+ MiB padding.
        c.execute("INSERT INTO events VALUES(?,?,?,?)", (
            1007, 1, "2026-10-24T00:00:00Z", '{"config":{"optimizer":{"lr":0.001}}}'))
        c.executemany("INSERT INTO events VALUES(?,?,?,?)", (
            (1007, seq, "2026-10-24T00:00:00Z", '{"kind":"padding"}')
            for seq in range(2, 100002)))
        c.execute("INSERT INTO events VALUES(?,?,?,?)", (
            1007, 100002, "2026-10-24T00:00:00Z", '{"metrics":{"accuracy":0.99}}'))
    before = hashlib.sha256(db.read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory(prefix="nset-rx-completion-smoke-") as data:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with open("artifacts/standalone-completion-smoke.log", "w") as log:
            process = subprocess.Popen([
                str(binary), "serve", "--host", "127.0.0.1", "--port", str(port),
                "--token", "test-secret", "--db-path", data, "--rx-repo", str(root),
            ], stdout=log, stderr=log,
                env={**os.environ, "GIT_DIR": "/nonexistent/nset-rx-completion-smoke"})
            def request(path, body=None):
                raw = None if body is None else json.dumps(body).encode()
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}/api{path}", data=raw,
                    headers={"Authorization": "Bearer test-secret", "Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=10) as response:
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
                source = catalog["source"]["id"]
                high = catalog["high_water"]
                generation = catalog["source_generation"]
                assert high == "1007" and isinstance(generation, str) and generation
                pages = 1
                uids = [run["run_uid"] for run in catalog["runs"]]
                while catalog["next_after"] is not None:
                    params = urllib.parse.urlencode({"after": catalog["next_after"],
                        "high_water": high, "source_generation": generation})
                    catalog = request("/rx/catalog?" + params)
                    pages += 1
                    assert pages <= 6, "catalog cursor did not finish"
                    assert catalog["high_water"] == high
                    assert catalog["source_generation"] == generation
                    assert len(catalog["runs"]) <= 200
                    uids.extend(run["run_uid"] for run in catalog["runs"])
                assert pages == 6 and len(set(uids)) == 1007 and len(uids) == 1007
                query = {"source_id": source, "runs": ["completion-1007"], "conditions": [
                    {"path": "config.optimizer.lr", "op": "eq", "value": 0.001},
                    {"path": "metrics.accuracy", "op": "exists"},
                    {"path": "present", "op": "missing"},
                ]}
                cursor = None
                cursors = set()
                filter_pages = 0
                filter_generation = None
                while True:
                    response = request("/rx/run-filter", {**query, **({"cursor": cursor} if cursor else {})})
                    filter_pages += 1
                    assert filter_pages <= 10, "filter cursor did not finish"
                    if filter_generation is None:
                        filter_generation = response["source_generation"]
                    assert response["source_generation"] == filter_generation
                    evidence = response["runs"][0]["conditions"]
                    cursor = response["cursor"]
                    if cursor is None:
                        assert evidence == [True, True, True], response
                        break
                    assert evidence == [True, None, None], response
                    assert cursor not in cursors, "filter cursor did not progress"
                    cursors.add(cursor)
                assert filter_pages >= 6, filter_pages
                subprocess.run([
                    "node", "--input-type=module", "-e", COMPLETION_BROWSER,
                    f"http://127.0.0.1:{port}", source,
                ], cwd="web", check=True, timeout=120)
                assert before == hashlib.sha256(db.read_bytes()).hexdigest()
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    raise
    return {"fixture": str(root), "runs": 1007, "events_in_late_run": 100002,
            "catalog_pages": pages, "filter_pages": filter_pages, "source_unchanged": True}

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
completion = completion_smoke(binary)
print(json.dumps({"kind": "final", "gates": "passed", "binary": "artifacts/nset",
                  "full_filter_completion": completion,
                  "fixture": "artifacts/rx-demo", "standalone_traces": 2,
                  "points_per_trace": 6, "source_unchanged": True, "embedded_ui_current": True, "utf8": True, "embedded_event_config": True, "embedded_run_filters": True}))
