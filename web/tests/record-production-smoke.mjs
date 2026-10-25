// Run against the production binary, never the user's service. All native state
// and synthetic rx data live beneath the retained run's smoke-artifacts folder.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { chromium, expect } from "@playwright/test";

const artifacts = resolve("smoke-artifacts");
await mkdir(artifacts, { recursive: true });
const binary = resolve(process.env.NSET_SMOKE_BINARY || "target/release/nset");
const token = "disposable-record-smoke";
const fixturePython = String.raw`
import json, sqlite3, subprocess, sys, pathlib, math
repo=pathlib.Path(sys.argv[1]); synthetic=sys.argv[2]=='synthetic'
if synthetic:
    subprocess.run(['git','init','-q',str(repo)],check=True)
    (repo/'.git/rx').mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(repo/'.git/rx/rx.sqlite')
    db.executescript('PRAGMA user_version=8; CREATE TABLE runs(id INTEGER PRIMARY KEY,run_uid TEXT UNIQUE,state TEXT,alias TEXT,config TEXT,created_at TEXT,started_at TEXT,finished_at TEXT,exit_code INTEGER,argv TEXT); CREATE TABLE events(run_id INTEGER,seq INTEGER,received_at TEXT,data TEXT,UNIQUE(run_id,seq));')
    for i in range(256):
        db.execute('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)',(i+1,'u'+str(i),'succeeded',None,'fixture','2026-10-25T00:00:00Z',None,None,0,'[]'))
        rows=[]
        for j in range(20005 if i==1 else 2):
            row={'step': (j%17)+0.25, 'phase':'train' if i==1 or j==0 else 'probe', 'kind':'metric' if j%2==0 else 'probe', 'metrics':{'loss':i+j/100}, 'metrics.loss':-i-j/100, 'unrelated':0}
            if i%7==0: del row['metrics']
            if i==3 and j==0: row['unrelated']=float('nan')
            if i==2 and j==0: row['diagnostic']='x'*(9*1024*1024)
            if i==255: row['late']={'field':17}
            rows.append((i+1,j-1,'2026-10-25T00:00:00Z',json.dumps(row,separators=(',',':'))))
        db.executemany('INSERT INTO events VALUES(?,?,?,?)',rows)
    db.commit(); db.close()
gitdir=subprocess.check_output(['git','-C',str(repo),'rev-parse','--git-common-dir'],text=True).strip()
gitdir=pathlib.Path(gitdir); gitdir=gitdir if gitdir.is_absolute() else repo/gitdir
db=sqlite3.connect((gitdir/'rx/rx.sqlite').resolve().as_uri()+'?mode=ro',uri=True)
runs=[{'id':str(r[0]),'uid':r[1]} for r in db.execute('SELECT id,run_uid FROM runs ORDER BY id')]
allpoints=[]
for uid,seq,raw in db.execute('SELECT r.run_uid,e.seq,e.data FROM events e JOIN runs r ON r.id=e.run_id ORDER BY r.id,e.seq'):
    try: row=json.loads(raw)
    except (ValueError,TypeError): continue
    if not isinstance(row,dict): continue
    x=row.get('step'); metrics=row.get('metrics'); y=metrics.get('loss') if isinstance(metrics,dict) else None
    if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in [x,y]): continue
    group=row.get('phase')
    if isinstance(group,(dict,list)): continue
    if isinstance(group,float) and not math.isfinite(group): continue
    allpoints.append({'uid':uid,'group':group,'point':[x,y,str(seq)],'kind':row.get('kind')})
db.close()
print(json.dumps({'runs':runs,'points':allpoints},allow_nan=False,separators=(',',':')))
`;

function expectedTraces(raw, filter = () => true) {
  const traces = new Map();
  for (const p of raw.points.filter(filter)) {
    const key = JSON.stringify([p.uid, "metrics.loss", p.group]);
    if (!traces.has(key)) traces.set(key, []);
    traces.get(key).push(p.point);
  }
  return traces;
}
function flatten(replies) {
  const traces = new Map();
  for (const reply of replies)
    for (const trace of reply.traces) {
      const key = JSON.stringify([trace.run_uid, trace.y, trace.group]);
      if (!traces.has(key)) traces.set(key, []);
      traces.get(key).push(...trace.points);
    }
  return traces;
}
function compare(actual, expected) {
  assert.deepEqual(
    [...actual.keys()].sort(),
    [...expected.keys()].sort(),
    "exact trace identities",
  );
  for (const [key, points] of expected)
    assert.deepEqual(actual.get(key), points, `raw order and values: ${key}`);
}
const countPoints = (traces) =>
  [...traces.values()].reduce((sum, p) => sum + p.length, 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function unusedPort() {
  const socket = createServer();
  await new Promise((r) => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  return port;
}
const browser = await chromium.launch();
try {
  for (const mode of [
    "synthetic",
    ...(process.env.NSET_RFFM_REPO ? ["rffm"] : []),
  ]) {
    const started = performance.now();
    const repo =
      mode === "synthetic"
        ? join(artifacts, "synthetic-rx")
        : process.env.NSET_RFFM_REPO;
    const raw = JSON.parse(
      execFileSync("python3", ["-c", fixturePython, repo, mode], {
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
    const expected = expectedTraces(raw);
    const port = await unusedPort();
    assert.notEqual(port, 8082);
    const base = `http://127.0.0.1:${port}`;
    const server = spawn(binary, [
      "serve",
      "--port",
      String(port),
      "--db-path",
      join(artifacts, `${mode}-native`),
      "--rx-repo",
      repo,
      "--token",
      token,
      "--log-level",
      "warn",
    ]);
    let serverLog = "";
    server.stdout.on("data", (b) => (serverLog += b));
    server.stderr.on("data", (b) => (serverLog += b));
    const context = await browser.newContext({
      viewport: { width: 1500, height: 1100 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const requests = [];
    let replies = [];
    const pending = new Set();
    page.on("response", (response) => {
      if (!response.url().includes("/api/rx/")) return;
      const task = (async () => {
        const request = response.request();
        const body = request.postDataJSON();
        const path = new URL(response.url()).pathname;
        const entry = { path, body, status: response.status() };
        requests.push(entry);
        if (path === "/api/rx/fields" && response.ok()) {
          try {
            entry.result = await response.json();
          } catch {
            /* canceled hint request */
          }
        }
        if (path === "/api/rx/plot" && response.ok()) {
          try {
            replies.push({ body, result: await response.json() });
          } catch {
            /* canceled preview */
          }
        }
      })();
      pending.add(task);
      task.finally(() => pending.delete(task));
    });
    const api = async (path, body) => {
      const response = await fetch(base + "/api" + path, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    try {
      for (let i = 0; ; i++) {
        try {
          if ((await fetch(base)).ok) break;
        } catch {}
        if (i > 150 || server.exitCode !== null)
          throw new Error(`server startup: ${serverLog}`);
        await sleep(100);
      }
      const html = await (await fetch(base)).text();
      const assets = [
        ...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g),
      ].map((m) => m[1]);
      assert.ok(assets.length >= 2);
      let embeddedJS = "";
      for (const asset of assets) {
        const bytes = await (await fetch(new URL(asset, base))).arrayBuffer();
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        assert.ok(!text.includes("\ufffd"), `UTF-8 asset ${asset}`);
        if (asset.endsWith(".js")) embeddedJS += text;
      }
      assert.ok(
        embeddedJS.includes("Filter records"),
        "new shared-filter assets embedded",
      );
      let catalog = [],
        after,
        source,
        generation,
        highWater,
        catalogPages = 0;
      do {
        const q = new URLSearchParams(
          after
            ? { after, high_water: highWater, source_generation: generation }
            : {},
        );
        const result = await api("/rx/catalog?" + q);
        catalog.push(...result.runs);
        after = result.next_after;
        source = result.source;
        generation = result.source_generation;
        highWater = result.high_water;
        catalogPages++;
      } while (after);
      assert.deepEqual(
        catalog.map((r) => r.run_uid).sort(),
        raw.runs.map((r) => r.uid).sort(),
      );
      const query = {
        source_id: source.id,
        source_generation: generation,
        x: "step",
        ys: ["metrics.loss"],
        group: "phase",
        filters: { any: false, conditions: [] },
      };
      const apiReplies = [];
      for (let i = 0; i < catalog.length; i += 32) {
        let cursor = null;
        const seen = new Set();
        do {
          const result = await api("/rx/plot", {
            ...query,
            runs: catalog.slice(i, i + 32).map((r) => r.run_uid),
            cursor,
          });
          apiReplies.push(result);
          cursor = result.next_cursor;
          if (cursor) {
            assert.ok(!seen.has(cursor));
            seen.add(cursor);
          } else assert.equal(result.diagnostics.partial, false);
        } while (cursor);
      }
      compare(flatten(apiReplies), expected);
      await page.goto(base);
      await page.getByLabel("Access token", { exact: true }).fill(token);
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await page
        .getByRole("button", { name: `rx · ${source.name}`, exact: true })
        .click();
      await page
        .getByRole("checkbox", {
          name: "Select all matching runs",
          exact: true,
        })
        .check();
      await page
        .getByRole("button", { name: "View charts", exact: true })
        .click();
      await page.locator("details[data-menu=add] summary").click();
      await page
        .getByRole("button", { name: "Line plot", exact: true })
        .click();
      let editor = page.getByRole("dialog");
      const preview = () => editor.locator('[data-role="preview"]');
      const complete = async (traces) => {
        await expect(preview()).toHaveAttribute(
          "data-observation-count",
          String(countPoints(traces)),
          { timeout: 120000 },
        );
        await expect(editor).toContainText(`${traces.size} curve(s)`);
        await expect(editor).not.toContainText(
          /Partial result:|Preview unavailable:|Previous preview/,
        );
      };
      const x = editor.getByLabel("Record X field", { exact: true });
      await x.fill("step");
      await x.press("Tab");
      await expect(x).toHaveValue("step");
      const y = editor.getByLabel("Add Y field", { exact: true });
      await y.fill("metrics.los");
      await expect(
        page.getByRole("option", { name: /^metrics\.loss / }),
      ).toBeVisible({ timeout: 30000 });
      await page.getByRole("option", { name: /^metrics\.loss / }).click();
      await expect(
        editor.getByRole("button", {
          name: "Remove Y field metrics.loss",
          exact: true,
        }),
      ).toBeVisible();
      await expect(preview()).toHaveAttribute(
        "data-observation-count",
        String(countPoints(expected)),
        { timeout: 120000 },
      );
      await Promise.all([...pending]);
      replies = [];
      const group = editor.getByLabel("Group by", { exact: true });
      await group.fill("phase");
      await group.press("Tab");
      await complete(expected);
      await Promise.all([...pending]);
      const grouped = replies.filter(
        (p) => p.body.group === "phase" && !p.body.filters.conditions.length,
      );
      compare(flatten(grouped.map((p) => p.result)), expected);
      assert.deepEqual(
        [...new Set(grouped.flatMap((p) => p.body.runs))].sort(),
        raw.runs.map((r) => r.uid).sort(),
        "production Select all considers every run",
      );
      assert.ok(grouped.every((p) => p.body.runs.length <= 32));
      if (mode === "synthetic") {
        assert.ok(
          expected.size > 128 && raw.runs.length >= 160 && catalogPages > 1,
        );
        assert.ok([...expected.keys()].some((k) => k.includes('"u255"')));
        assert.ok(
          apiReplies.some((p) => p.next_cursor),
          "20k+ points require continuation",
        );
        assert.equal(
          expected.get(JSON.stringify(["u1", "metrics.loss", "train"])).length,
          20005,
        );
        const start = requests.length;
        await y.fill("late.fiel");
        await expect(
          page.getByRole("option", { name: /^late\.field/ }),
        ).toBeVisible({ timeout: 30000 });
        await y.press("Escape");
        await y.fill("");
        await expect
          .poll(
            () =>
              new Set(
                requests
                  .slice(start)
                  .filter(
                    (r) =>
                      r.path.endsWith("fields") &&
                      r.body.prefix === "late.fiel",
                  )
                  .flatMap((r) => r.body.runs),
              ).size,
          )
          .toBe(raw.runs.length);
      }
      await editor.getByText("Inspect records", { exact: true }).click();
      await editor
        .getByRole("button", { name: "Load records", exact: true })
        .click();
      await expect(
        editor.locator(".record-inspection summary").first(),
      ).toBeVisible({ timeout: 30000 });
      await editor.getByLabel("Filter records", { exact: true }).click();
      const menu = editor.locator(".run-filter-menu");
      await menu
        .getByRole("button", { name: "+ Add condition", exact: true })
        .click();
      const path = menu.getByLabel("Condition 1 path", { exact: true });
      await path.fill("phase");
      await path.press("Tab");
      await expect(path).toHaveValue("phase");
      await expect(
        menu.getByLabel("Condition 1 operator", { exact: true }),
      ).toHaveValue("eq");
      const value = menu.getByLabel("Condition 1 value", { exact: true });
      await value.fill("train");
      await value.press("Tab");
      await expect(value).toHaveValue("train");
      const training = expectedTraces(raw, (p) => p.group === "train");
      await complete(training);
      // Two phases in different records of one run must not satisfy AND.
      await menu
        .getByRole("button", { name: "+ Add condition", exact: true })
        .click();
      const secondPath = menu.getByLabel("Condition 2 path", { exact: true });
      await secondPath.fill("phase");
      await secondPath.press("Tab");
      const secondValue = menu.getByLabel("Condition 2 value", { exact: true });
      await secondValue.fill("probe");
      await secondValue.press("Tab");
      await complete(new Map());
      await menu
        .getByLabel("Combine conditions", { exact: true })
        .selectOption("any");
      await complete(
        expectedTraces(raw, (p) => p.group === "train" || p.group === "probe"),
      );
      await menu
        .getByRole("button", { name: "Remove condition 2", exact: true })
        .click();
      await complete(training);
      await expect
        .poll(() =>
          requests
            .filter(
              (r) => r.path.endsWith("fields") && r.body.prefix === "phase",
            )
            .some((r) => r.body.runs.includes(raw.runs.at(-1).uid)),
        )
        .toBe(true);
      await page.screenshot({
        path: join(artifacts, `${mode}-shared-filter.png`),
      });
      await editor.getByLabel("Filter records", { exact: true }).click();
      await editor
        .getByRole("button", { name: "Add chart", exact: true })
        .click();
      const card = page.locator(".dashboard-cell");
      await expect(card.locator(".uplot")).toBeVisible({ timeout: 120000 });
      await expect(card.locator(".card-notice")).toBeHidden();
      const reopen = async () => {
        await card.getByLabel("Chart actions", { exact: true }).click();
        await card
          .getByRole("button", { name: "Edit chart", exact: true })
          .click();
        editor = page.getByRole("dialog");
        await complete(training);
      };
      await reopen();
      await editor.getByLabel("Filter records", { exact: true }).click();
      await editor
        .getByLabel("Condition 1 value", { exact: true })
        .fill("probe");
      await editor
        .getByLabel("Condition 1 value", { exact: true })
        .press("Tab");
      await complete(expectedTraces(raw, (p) => p.group === "probe"));
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();
      await reopen();
      await editor.getByLabel("Filter records", { exact: true }).click();
      await expect(
        editor.getByLabel("Condition 1 value", { exact: true }),
      ).toHaveValue("train");
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.reload();
      await expect(card.locator(".uplot")).toBeVisible({ timeout: 120000 });
      await expect(card.locator(".card-notice")).toBeHidden();
      assert.ok(
        requests
          .filter((r) => /\/(fields|records|plot)$/.test(r.path))
          .every((r) => r.body.runs.length <= 32 && r.status === 200),
      );
      assert.deepEqual(errors, []);
      const summary = {
        kind: "final",
        mode,
        candidates: raw.runs.length,
        eligible_runs: new Set(raw.points.map((p) => p.uid)).size,
        traces: expected.size,
        points: countPoints(expected),
        training_traces: training.size,
        training_points: countPoints(training),
        catalog_pages: catalogPages,
        api_plot_pages: apiReplies.length,
        ui_grouped_plot_pages: grouped.length,
        elapsed_seconds: (performance.now() - started) / 1000,
        exact_raw_api_ui: true,
        assets_utf8: true,
        server_port: port,
      };
      await writeFile(
        join(artifacts, `${mode}-summary.json`),
        JSON.stringify(summary, null, 2),
      );
      console.log(JSON.stringify(summary));
    } catch (error) {
      await page
        .screenshot({ path: join(artifacts, `${mode}-failure.png`) })
        .catch(() => {});
      await writeFile(
        join(artifacts, `${mode}-failure.txt`),
        await page
          .locator("body")
          .innerText()
          .catch(() => ""),
      );
      await writeFile(
        join(artifacts, `${mode}-requests.json`),
        JSON.stringify(requests, null, 2),
      );
      await writeFile(
        join(artifacts, `${mode}-inputs.json`),
        JSON.stringify(
          await page.locator("input").evaluateAll((inputs) =>
            inputs.map((i) => ({
              label: i.getAttribute("aria-label"),
              value: i.value,
              focused: i === document.activeElement,
            })),
          ),
          null,
          2,
        ),
      );
      throw error;
    } finally {
      await context.close();
      server.kill("SIGTERM");
      await new Promise((r) =>
        server.exitCode !== null ? r() : server.once("exit", r),
      );
      await writeFile(join(artifacts, `${mode}-server.log`), serverLog);
    }
  }
} finally {
  await browser.close();
}
