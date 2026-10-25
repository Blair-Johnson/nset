// Packaged-browser release gate. Run FROM the retained run's working directory:
// NSET_SMOKE_BINARY=/absolute/path/to/nset node /absolute/path/to/web/tests/legend-production-smoke.mjs
// Requires existing Playwright Chromium, python3, and git. No build/install, Vite,
// source-module imports, route mocks, real rx repositories, or persistent browser profile.
// All fixtures and native database state are retained in smoke-artifacts/legend-*.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { chromium, expect } from "@playwright/test";

assert.ok(process.env.NSET_SMOKE_BINARY, "Set NSET_SMOKE_BINARY to the packaged release binary");
const binary = resolve(process.env.NSET_SMOKE_BINARY);
await access(binary, constants.X_OK);
const root = resolve("smoke-artifacts");
await mkdir(root, { recursive: true });
const artifacts = await mkdtemp(join(root, "legend-"));
const token = `legend-smoke-${randomUUID()}`;
const started = performance.now();
const json = (name, value) => writeFile(join(artifacts, name), JSON.stringify(value, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const summary = { binary, artifacts, cases: [], assertions: [], success: false };
console.log(JSON.stringify({ kind: "legend-smoke-start", binary, artifacts }));

// The final catalog entry is ranked Run 5, making the second <=32-run transport
// batch observable in the actual popup. Five selected runs have no default X/Y
// pair. Other eligible runs stop before the ranking probes' X and above their Y.
const fixture = Array.from({ length: 40 }, (_, i) => {
  const rank = i < 5 ? i : i === 39 ? 5 : null;
  const alias = rank !== null ? `Rank ${rank}` : i === 38 ? "Loop" : i >= 34 ? `Missing ${i}` : `Remote ${i}`;
  const run = { id: i + 1, uid: `legend-u${i}`, alias, name: `r${i + 1} · ${alias}`, records: [] };
  if (i === 38) {
    run.records = [[10, 20], [10, 80], [30, 80], [30, 20], [10, 20]]
      .map(([step, value]) => ({ step, phase: "train", metrics: { loop: value } }));
  } else if (i >= 34 && i <= 37) {
    run.records = i % 2 ? [{ phase: "train", metrics: { loss: 12, other: 14 } }]
      : [{ step: 50, phase: "train", diagnostic: "missing both requested metrics" }];
  } else {
    for (const [phase, offset] of [["train", 0], ["probe", 4]]) {
      const points = rank !== null ? [[0, rank * 10], [100, 100 + rank * 10]] : [[0, 130], [20, 140]];
      for (const [step, value] of points)
        run.records.push({ step, phase, metrics: { loss: value + offset, other: value + offset + 2 } });
    }
  }
  return run;
});
await json("rx-fixture.json", fixture);
const repo = join(artifacts, "synthetic-rx");
execFileSync("python3", ["-c", String.raw`
import json, pathlib, sqlite3, subprocess, sys
repo=pathlib.Path(sys.argv[1])
subprocess.run(['git','init','-q',str(repo)],check=True)
(repo/'.git/rx').mkdir(parents=True)
db=sqlite3.connect(repo/'.git/rx/rx.sqlite')
db.executescript('PRAGMA user_version=8; CREATE TABLE runs(id INTEGER PRIMARY KEY,run_uid TEXT UNIQUE,state TEXT,alias TEXT,config TEXT,created_at TEXT,started_at TEXT,finished_at TEXT,exit_code INTEGER,argv TEXT); CREATE TABLE events(run_id INTEGER,seq INTEGER,received_at TEXT,data TEXT,UNIQUE(run_id,seq));')
for run in json.loads(pathlib.Path(sys.argv[2]).read_text()):
    db.execute('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)',(run['id'],run['uid'],'succeeded',run['alias'],'legend fixture','2026-10-25T00:00:00Z',None,None,0,'[]'))
    db.executemany('INSERT INTO events VALUES(?,?,?,?)',[(run['id'],seq,'2026-10-25T00:00:00Z',json.dumps(row,separators=(',',':'))) for seq,row in enumerate(run['records'])])
db.commit(); db.close()
`, repo, join(artifacts, "rx-fixture.json")], { stdio: "pipe" });

function expectedTraces(training = false) {
  const traces = new Map();
  for (const run of fixture) for (const [seq, row] of run.records.entries()) {
    if (training && row.phase !== "train") continue;
    for (const y of ["loss", "other"]) {
      const value = row.metrics?.[y];
      if (!Number.isFinite(row.step) || !Number.isFinite(value)) continue;
      const key = JSON.stringify([run.uid, `metrics.${y}`, row.phase]);
      if (!traces.has(key)) traces.set(key, []);
      traces.get(key).push([row.step, value, String(seq)]);
    }
  }
  return traces;
}
async function unusedPort() {
  for (;;) {
    const socket = createServer();
    await new Promise((ok, fail) => { socket.once("error", fail); socket.listen(0, "127.0.0.1", ok); });
    const port = socket.address().port;
    await new Promise((ok, fail) => socket.close((error) => error ? fail(error) : ok()));
    if (port !== 8082) return port;
  }
}
const port = await unusedPort();
const base = `http://127.0.0.1:${port}`;
summary.server_port = port;
// Explicit local paths and cwd isolate every server-created file from user state.
const server = spawn(binary, ["serve", "--port", String(port), "--db-path", join(artifacts, "native"),
  "--rx-repo", repo, "--token", token, "--log-level", "warn"], { cwd: artifacts, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", spawnError;
server.stdout.on("data", (data) => { serverLog += data; });
server.stderr.on("data", (data) => { serverLog += data; });
server.on("error", (error) => { spawnError = error; });
let browser;
const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch(base + "/api" + path, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
  return response.json();
};

async function scenario(name, execute) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [], network = [], pending = new Set(), scripts = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(request.url());
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    const task = (async () => {
      const request = response.request();
      const entry = { path: url.pathname, status: response.status(), body: request.postDataJSON() };
      network.push(entry);
      if (url.pathname === "/api/rx/plot" && response.ok()) {
        try { entry.result = await response.json(); } catch { entry.canceled = true; }
      }
    })().catch((error) => errors.push(`response observer: ${error}`));
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  const capture = (label) => page.screenshot({ path: join(artifacts, `${name}-${label}.png`), fullPage: true });
  try {
    await page.goto(base);
    await page.getByLabel("Access token", { exact: true }).fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await execute({ page, network, capture });
    await Promise.all([...pending]);
    assert.deepEqual(errors, [], "no browser/observer errors");
    assert.ok(scripts.length && scripts.every((url) => new URL(url).origin === base && !new URL(url).pathname.startsWith("/src/")), "only embedded scripts");
    assert.ok(network.every((entry) => entry.status < 400), "all observed API responses succeed");
    summary.cases.push({ name, success: true, api_responses: network.length, script_urls: [...new Set(scripts)] });
  } catch (error) {
    await capture("failure").catch(() => {});
    await writeFile(join(artifacts, `${name}-failure.txt`), `${error.stack ?? error}\n\n${await page.locator("body").innerText().catch(() => "")}`);
    summary.cases.push({ name, success: false, error: String(error) });
    throw error;
  } finally {
    await context.close();
    await Promise.all([...pending]);
    await json(`${name}-requests.json`, network);
    await json(`${name}-browser-errors.json`, errors);
  }
}

const card = (page) => page.locator(".dashboard-cell");
async function ready(page) {
  await expect(card(page)).toHaveCount(1);
  await expect(card(page).locator(".u-over")).toBeVisible({ timeout: 60000 });
  await expect(card(page).locator(".card-status")).toHaveText("");
  await expect(card(page).locator(".card-notice")).toBeHidden();
  await frames(page);
}
async function frames(page) {
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
}
async function selectAll(page, experimentName) {
  await page.getByRole("button", { name: experimentName, exact: true }).click();
  const all = page.getByRole("checkbox", { name: "Select all matching runs", exact: true });
  await all.check();
  await expect(all).toBeChecked();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
}
// Modify only the fresh context's own normal saved-workspace representation.
// No private app object, PlotPanel, module import, or global profile is used.
async function configureSavedCard(page, experimentId, patch = {}) {
  const saved = await page.evaluate(({ experimentId, patch }) => {
    const key = "nset.workspaces.v2";
    const library = JSON.parse(localStorage.getItem(key));
    const view = library.views.find((v) => v.id === library.activeByExperiment[experimentId]);
    if (!view) throw new Error("No active persisted workspace");
    const cards = view.sections.flatMap((section) => section.cards);
    if (cards.length !== 1) throw new Error(`Expected one persisted card, got ${cards.length}`);
    const chart = cards[0];
    chart.layout = { width: 1000, height: 640 };
    Object.assign(chart.config, { xMin: 0, xMax: 100, yMin: 0, yMax: 160,
      xScale: "linear", yScale: "linear", xFormat: "fixed-2", yFormat: "number",
      interpolation: "linear", smoothing: false, legend: true });
    chart.config.style = { ...chart.config.style, path: "linear", points: false, width: 2, fill: 0 };
    if (patch.records) chart.records = { ...chart.records, ...patch.records };
    if (patch.config) Object.assign(chart.config, patch.config);
    view.updatedAt = Date.now();
    localStorage.setItem(key, JSON.stringify(library));
    return { selected: view.selectedRunIds, chart };
  }, { experimentId, patch });
  await page.reload();
  await ready(page);
  return saved;
}
async function move(page, x, y, bounds = [0, 100, 0, 160]) {
  await card(page).locator(".u-over").scrollIntoViewIfNeeded();
  await frames(page);
  const rect = await card(page).locator(".u-over").boundingBox();
  assert.ok(rect && rect.width > 200 && rect.height > 100, "usable plot rectangle");
  const [xmin, xmax, ymin, ymax] = bounds;
  await page.mouse.move(rect.x + (x - xmin) / (xmax - xmin) * rect.width,
    rect.y + (ymax - y) / (ymax - ymin) * rect.height);
}
async function hover(page, names, values, label, { xFormatted = false } = {}) {
  const popup = card(page).locator(".card-hover");
  await expect(popup.locator(".card-hover-row > span:first-child")).toHaveText(names);
  await expect(popup.locator(".card-hover-more")).toHaveCount(0);
  await expect(popup).not.toContainText(/metrics\.|train\/loss|phase=|\d+\s+more|Missing|—/i);
  const actual = await popup.locator(".card-hover-row > span:last-child").allTextContents();
  assert.equal(actual.length, values.length);
  actual.forEach((text, i) => {
    const parsed = text.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)?.map(Number) ?? [];
    assert.equal(parsed.length, values[i].length, `${label}: one value or nearest lower/upper pair: ${text}`);
    if (values[i].length === 1) assert.doesNotMatch(text, /[(),]/, "one-sided crossing emitted once");
    else assert.match(text, /^\(.+, .+\)$/, "ordered lower/upper tuple");
    if (xFormatted) assert.match(text, /^\(?-?\d+\.\d{2}(?:, -?\d+\.\d{2})?\)?$/, "horizontal uses fixed-2 X formatter");
    parsed.forEach((value, j) => assert.ok(Math.abs(value - values[i][j]) <= 0.4,
      `${label}: ${text}; expected ${JSON.stringify(values[i])} (screen-pixel tolerance 0.4)`));
  });
  const size = await popup.evaluate((node) => ({ height: node.clientHeight, scrollHeight: node.scrollHeight }));
  assert.ok(size.height <= 125 && size.scrollHeight <= size.height + 1, "bounded popup without hidden rows");
  summary.assertions.push({ label, names, values: actual });
}
async function legend(page, count, allowed) {
  await expect(card(page).locator(".card-legend")).toBeHidden();
  await card(page).getByText("Show legend", { exact: true }).click();
  await expect(card(page).locator(".card-legend-item")).toHaveCount(count);
  const names = await card(page).locator(".card-legend-name").allTextContents();
  assert.deepEqual([...new Set(names)].sort(), [...allowed].sort(), "legend contains exactly drawable runs, not missing pairs");
  await card(page).getByText("Show legend", { exact: true }).click();
  await expect(card(page).locator(".card-legend")).toBeHidden();
}
async function completePreview(editor, expected) {
  const points = [...expected.values()].reduce((n, rows) => n + rows.length, 0);
  await expect(editor.locator('[data-role="preview"]')).toHaveAttribute("data-observation-count", String(points), { timeout: 60000 });
  await expect(editor).toContainText(`${expected.size} curve(s)`);
  await expect(editor).not.toContainText(/Partial result:|Preview unavailable:|Previous preview/);
}
async function assertPlotResponses(network, training) {
  const expected = expectedTraces(training);
  const matching = () => network.filter((entry) => entry.path === "/api/rx/plot" && entry.result &&
    entry.body.group === "phase" && entry.body.ys.length === 2 &&
    (training ? entry.body.filters.conditions.some((c) => c.path === "phase" && c.op === "eq" && c.value === "train")
      : entry.body.filters.conditions.length === 0));
  const collect = () => {
    // Continuation pages may split one trace. Preview reloads may repeat it;
    // merge by the stable event sequence, verifying repeats agree exactly.
    const traces = new Map();
    for (const entry of matching()) for (const trace of entry.result.traces) {
      const key = JSON.stringify([trace.run_uid, trace.y, trace.group]);
      if (!traces.has(key)) traces.set(key, new Map());
      const points = traces.get(key);
      for (const point of trace.points) {
        if (points.has(point[2])) assert.deepEqual(points.get(point[2]), point);
        points.set(point[2], point);
      }
    }
    return new Map([...traces].map(([key, points]) => [key,
      [...points.values()].sort((a, b) => BigInt(a[2]) < BigInt(b[2]) ? -1 : BigInt(a[2]) > BigInt(b[2]) ? 1 : 0)]));
  };
  await expect.poll(() => collect().size, { timeout: 30000 }).toBe(expected.size);
  const actual = collect();
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [key, points] of expected) assert.deepEqual(actual.get(key), points, `real UI raw trace ${key}`);
  assert.deepEqual([...new Set(matching().flatMap((entry) => entry.body.runs))].sort(), fixture.map((run) => run.uid).sort(), "UI considered every selected run, including missing pairs");
  assert.ok(matching().every((entry) => entry.body.runs.length <= 32), "bounded transport, not a selection limit");
  summary.assertions.push({ label: training ? "phase=train shared filter / Select all" : "grouped multi-metric Select all", candidates: 40, traces: expected.size });
}

try {
  for (let i = 0; ; i++) {
    if (spawnError || server.exitCode !== null) throw new Error(`Owned server startup failed: ${spawnError ?? serverLog}`);
    try { if ((await fetch(base, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    if (i >= 150) throw new Error(`Owned server readiness timeout: ${serverLog}`);
    await sleep(100);
  }
  // Avoid accidentally accepting an unrelated process in the free-port race.
  await api("/health");
  const html = await (await fetch(base)).text();
  assert.ok(!html.includes("/src/"), "packaged HTML, not development entrypoint");
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]);
  assert.ok(assets.some((url) => url.endsWith(".js")) && assets.some((url) => url.endsWith(".css")), "embedded JS and CSS");
  for (const asset of assets) {
    const url = new URL(asset, base);
    assert.equal(url.origin, base);
    const response = await fetch(url);
    assert.ok(response.ok, `embedded asset ${asset}`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await response.arrayBuffer());
    assert.ok(!text.includes("\ufffd"), `valid UTF-8 ${asset}`);
  }
  summary.embedded_assets = assets;
  const catalog = await api("/rx/catalog");
  assert.equal(catalog.runs.length, 40);
  assert.ok(!catalog.next_after, "small fixture fits one catalog page");
  assert.deepEqual(catalog.runs.map((run) => run.run_uid).sort(), fixture.map((run) => run.uid).sort());
  const source = catalog.source;
  browser = await chromium.launch();

  await scenario("rx", async ({ page, network, capture }) => {
    await selectAll(page, `rx · ${source.name}`);
    await page.locator("details[data-menu=add] summary").click();
    await page.getByRole("button", { name: "Line plot", exact: true }).click();
    let editor = page.getByRole("dialog");
    const x = editor.getByLabel("Record X field", { exact: true });
    await x.fill("step"); await x.press("Tab");
    for (const field of ["metrics.loss", "metrics.other"]) {
      const input = editor.getByLabel("Add Y field", { exact: true });
      await input.fill(field.slice(0, -1));
      await page.getByRole("option", { name: new RegExp(`^${field.replaceAll(".", "\\.")} `) }).click();
      await expect(editor.getByRole("button", { name: `Remove Y field ${field}`, exact: true })).toBeVisible();
    }
    const group = editor.getByLabel("Group by", { exact: true });
    await group.fill("phase"); await group.press("Tab");
    await completePreview(editor, expectedTraces());
    await assertPlotResponses(network, false);
    await editor.getByRole("button", { name: "Add chart", exact: true }).click();
    await ready(page);
    const saved = await configureSavedCard(page, source.id);
    assert.equal(saved.selected.length, 40, "Select all saved all candidates");
    assert.deepEqual(saved.chart.records.runUids, [], "chart follows workspace selection");
    const eligible = fixture.filter((run) => run.id <= 34 || run.id === 40).map((run) => run.name);
    await legend(page, 140, eligible);
    const ranked = [0, 1, 2, 3, 4, 39].map((index) => fixture[index].name);
    await move(page, 50, 51);
    await hover(page, ranked.slice(0, 4), [[50, 52], [60], [70], [80]], "rx vertical: nearest four unique RUNS, Y values");
    await capture("vertical-low");
    await move(page, 50, 101);
    await hover(page, [ranked[5], ranked[4], ranked[3], ranked[2]], [[100, 102], [96], [86], [76]], "rx vertical: free-Y movement changes rank, not selection order");
    await capture("vertical-high");

    // Apply the actual shared record-filter menu to the actual Select-all chart.
    await card(page).getByLabel("Chart actions", { exact: true }).click();
    await card(page).getByRole("button", { name: "Edit chart", exact: true }).click();
    editor = page.getByRole("dialog");
    await editor.getByLabel("Filter records", { exact: true }).click();
    const menu = editor.locator(".run-filter-menu");
    await menu.getByRole("button", { name: "+ Add condition", exact: true }).click();
    const path = menu.getByLabel("Condition 1 path", { exact: true });
    await path.fill("phase"); await path.press("Tab");
    await expect(menu.getByLabel("Condition 1 operator", { exact: true })).toHaveValue("eq");
    const value = menu.getByLabel("Condition 1 value", { exact: true });
    await value.fill("train"); await value.press("Tab");
    await completePreview(editor, expectedTraces(true));
    await assertPlotResponses(network, true);
    await capture("shared-filter");
    await editor.getByLabel("Filter records", { exact: true }).click();
    await editor.getByRole("button", { name: "Save changes", exact: true }).click();
    await ready(page);
    await legend(page, 70, eligible);
    await move(page, 50, 101);
    await hover(page, [ranked[5], ranked[4], ranked[3], ranked[2]], [[100, 102], [92], [82], [72]], "rx filtered: probe crossings removed, same run identities");
    await card(page).getByRole("button", { name: "Add horizontal cursor", exact: true }).click();
    await move(page, 27, 75);
    await hover(page, [ranked[5], ranked[4], ranked[3], ranked[2]], [[25], [33], [43], [53]], "rx horizontal: nearest four by X", { xFormatted: true });
    await capture("horizontal-left");
    await move(page, 72, 75);
    await hover(page, ranked.slice(0, 4), [[73], [65], [55], [45]], "rx horizontal: free-X movement changes rank", { xFormatted: true });
    await capture("horizontal-right");
    await page.reload();
    await ready(page);
    await legend(page, 70, eligible);
    await move(page, 50, 101);
    await hover(page, [ranked[5], ranked[4], ranked[3], ranked[2]], [[100, 102], [92], [82], [72]], "rx filter survives reload");

    // Preserve all 40 selected runs, but use the saved binding for one explicit
    // repeated-X loop; every point still comes from the real SQLite/API path.
    await configureSavedCard(page, source.id, { records: { runUids: [fixture[38].uid], ys: ["metrics.loop"] },
      config: { xMax: 40, yMax: 120 } });
    const bounds = [0, 40, 0, 120], loopName = [fixture[38].name];
    await legend(page, 1, loopName);
    await move(page, 20, 45, bounds);
    await hover(page, loopName, [[20, 80]], "rx loop: nearest lower/upper vertical Y branches");
    await move(page, 20, 100, bounds);
    await hover(page, loopName, [[80]], "rx loop: vertical one-sided nearest only");
    await card(page).getByRole("button", { name: "Add horizontal cursor", exact: true }).click();
    await move(page, 20, 45, bounds);
    await hover(page, loopName, [[10, 30]], "rx loop: nearest lower/upper horizontal X branches", { xFormatted: true });
    await capture("loop-pair");
    await move(page, 5, 45, bounds);
    await hover(page, loopName, [[10]], "rx loop: one-sided upper X", { xFormatted: true });
    await move(page, 35, 45, bounds);
    await hover(page, loopName, [[30]], "rx loop: one-sided lower X", { xFormatted: true });
  });

  // Native data is written only to this owned server's disposable --db-path.
  const experiment = await api("/experiments", { name: "Legend native fixture" });
  const wave = await api("/runs", { experiment_id: experiment.id, name: "Native wave", params: {}, tags: {} });
  const empty = await api("/runs", { experiment_id: experiment.id, name: "Native empty", params: {}, tags: {} });
  const wavePoints = [[0, 0], [20, 100], [40, 0], [60, 100], [80, 0]];
  const metrics = wavePoints.map(([step, value]) => ({ key: "train/loss", step, value }));
  const inserted = await api(`/runs/${encodeURIComponent(wave.id)}/metrics`, { metrics });
  assert.equal(inserted.inserted, 5);
  for (const run of [wave, empty]) await api(`/runs/${encodeURIComponent(run.id)}`, { status: "finished" }, "PATCH");
  await json("native-fixture.json", { experiment, wave, empty, metrics });
  await scenario("native", async ({ page, capture }) => {
    await selectAll(page, experiment.name);
    // The native workspace generates its one train/loss card from the catalog.
    await ready(page);
    const saved = await configureSavedCard(page, experiment.id);
    assert.equal(saved.selected.length, 2);
    await legend(page, 1, [wave.name]);
    await move(page, 44, 45);
    await hover(page, [wave.name], [[20]], "native vertical: Y interpolation");
    await card(page).getByRole("button", { name: "Add horizontal cursor", exact: true }).click();
    await move(page, 44, 50);
    await hover(page, [wave.name], [[30, 50]], "native wave: nearest pair, not all four roots", { xFormatted: true });
    await capture("crossing-pair");
    await move(page, 5, 50);
    await hover(page, [wave.name], [[10]], "native wave: one-sided upper root", { xFormatted: true });
    await move(page, 95, 50);
    await hover(page, [wave.name], [[70]], "native wave: one-sided lower root", { xFormatted: true });
    await card(page).getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect(card(page).getByRole("button", { name: "Previous view", exact: true })).toBeEnabled();
    await card(page).getByRole("button", { name: "Previous view", exact: true }).click();
    await move(page, 44, 50);
    await hover(page, [wave.name], [[30, 50]], "native navigation back restores crossing geometry", { xFormatted: true });
    await card(page).getByRole("button", { name: "Add horizontal cursor", exact: true }).click();
    await card(page).getByText("Edit positions", { exact: true }).click();
    for (const [letter, value] of [["A", "25"], ["B", "75"]]) {
      const input = card(page).getByRole("spinbutton", { name: `Cursor ${letter} level`, exact: true });
      await input.fill(value); await input.press("Tab");
    }
    await expect(card(page).locator(".card-position-readout output")).toHaveText(["25", "75", "50"]);
    await expect(card(page).locator(".card-crossings")).toHaveCount(2);
    for (const item of await card(page).locator(".card-crossings summary").allTextContents())
      assert.match(item, /4 crossings/, "A/B native inspection retains all four crossings");
    await move(page, 44, 50);
    await hover(page, [wave.name], [[30, 50]], "native A/B does not replace mouse-nearest popup", { xFormatted: true });
    await capture("ab-and-hover");
  });
  summary.success = true;
} catch (error) {
  summary.error = error.stack ?? String(error);
  throw error;
} finally {
  try { if (browser) await browser.close(); }
  finally {
    // Never kill by port/name, touch other servers, or remove retained fixtures.
    if (server.pid && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((ok) => server.once("exit", ok));
      server.kill("SIGTERM");
      const timer = setTimeout(() => { if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL"); }, 5000);
      await exited;
      clearTimeout(timer);
    }
    summary.elapsed_seconds = (performance.now() - started) / 1000;
    await writeFile(join(artifacts, "server.log"), serverLog);
    await json("summary.json", summary);
    console.log(JSON.stringify({ kind: "legend-smoke-final", ...summary }));
  }
}
