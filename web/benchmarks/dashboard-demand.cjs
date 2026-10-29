#!/usr/bin/env node
"use strict";

/**
 * Standalone production-browser benchmark; starts NO servers and needs NO backend.
 * Parent owns immutable Vite preview builds (baseline :4202, current :4203).
 * Replay from repository root, preferably inside an rx run:
 *   node web/benchmarks/dashboard-demand.cjs --baseline-url http://127.0.0.1:4202 --current-url http://127.0.0.1:4203
 *   node web/benchmarks/dashboard-demand.cjs --help
 *
 * Only HTTP API responses and an rAF counter are instrumented; real production
 * HTML/JS/CSS, ChartCard, MetricStore and ImagePanel run without private hooks.
 * Fresh contexts + disabled HTTP cache; one shared headless Chromium process.
 * One excluded warmup pair PER rate/scenario; trial order alternates before/after.
 * CPU throttle affects renderer CPU, not network or GPU. Fixed viewport, no GPU
 * disabling flags. Idle metrics have no rAF polling; explicit GC precedes idle.
 * Search uses a real DOM input event (synthetic/untrusted), not trusted typing;
 * two rAFs are a paint opportunity proxy, NOT INP or proof of presentation.
 * Readiness means public DOM landmarks, not all background activity is finished.
 * Commit labels are supplied provenance; asset SHA-256 fingerprints identify the
 * actual bytes served. The parent must build each stated immutable source commit.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const { setTimeout: sleep } = require("node:timers/promises");
const localRequire = createRequire(path.resolve(__dirname, "../package.json"));
const ROOT = path.resolve(__dirname, "../..");
const VIEW_ID = "server:00000000-0000-0000-0000-000000000240";
const VIEW_NAME = "Dashboard demand fixture";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const SCENARIOS = [
  "sparse-open-startup",
  "sparse-folded-startup",
  "dense-first-section-opened-then-folded",
];
if (process.env.DASHBOARD_BENCH_SCENARIO) {
  const scenario = process.env.DASHBOARD_BENCH_SCENARIO;
  assert(SCENARIOS.includes(scenario), "Unknown selected scenario");
  SCENARIOS.splice(0, SCENARIOS.length, scenario);
}
const drainMs = Number(process.env.DASHBOARD_BENCH_DRAIN_MS || 500);
assert(Number.isFinite(drainMs) && drainMs >= 500 && drainMs <= 60000);
const INSTRUMENTATION = Object.freeze({
  viewport: { width: 1500, height: 1100 },
  headless: true,
  warmupPairsPerRateScenario: 1,
  drainMs,
  searchQueries: ["key_0", "section_0", "", "key_0", "section_0", ""],
  searchLabel: "search-update-through-paint",
  readiness: {
    app: "navigation start to view title + Connected + 30 section headings",
    open: "app readiness + one canvas in each of demand-0-0 and demand-0-1",
    dense:
      "app readiness; then open first section, await six scalar canvases and two decoded image frame-info[data-step='0'], then fold and drain",
  },
  gc: "HeapProfiler.collectGarbage before heap/DOM counters and idle",
  idle: "Performance.getMetrics TaskDuration delta / measured Timestamp delta; rAF callback counter sampled at endpoints only",
  cache:
    "fresh BrowserContext each trial, service workers blocked, Network.setCacheDisabled true; Playwright routing also disables HTTP cache",
});
const UNITS = {
  startupReadyMs: "ms",
  appReadyMs: "ms",
  denseOpenReadyMs: "ms",
  domNodes: "nodes",
  cards: "cards",
  scalarCanvases: "canvases",
  canvases: "canvases",
  viewers: "viewers",
  visibleCards: "cards",
  jsHeapAfterGCBytes: "bytes",
  jsHeapTotalAfterGCBytes: "bytes",
  cdpDocumentsAfterGC: "documents",
  cdpNodesAfterGC: "nodes (includes detached nodes)",
  cdpEventListenersAfterGC: "listeners",
  idleTaskMsPerSecond: "ms/s",
  idleTaskDurationMs: "ms",
  idleTimestampElapsedMs: "ms",
  idleRAFCallbacks: "callbacks",
  idleRAFCallbacksPerSecond: "callbacks/s",
  idleRAFObservationMs: "ms",
  idleAPIRequests: "requests",
  searchHandlerMedianMs: "ms",
  searchUpdateThroughPaintMedianMs: "ms",
  consoleWarnings: "messages",
  webGLWarnings: "messages",
  pageErrors: "errors",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cardId = (s, i) => `demand-${s}-${i}`;
const keyFor = (s, i) => `section_${s}/key_${i}`;
const serializedError = (error) => ({
  name: error.name,
  message: error.message,
  stack: error.stack,
});
function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}
function configFromArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    "baseline-url": env.DASHBOARD_BENCH_BASELINE_URL || "http://127.0.0.1:4202",
    "current-url": env.DASHBOARD_BENCH_CURRENT_URL || "http://127.0.0.1:4203",
    "baseline-commit":
      env.DASHBOARD_BENCH_BASELINE_COMMIT ||
      "213d2410eae12a230f922e2269643d4934602829",
    "current-commit":
      env.DASHBOARD_BENCH_CURRENT_COMMIT ||
      "cf965c8ac3bf88496ff2fd365a410b5e384d6476",
    rates: env.DASHBOARD_BENCH_RATES || "1,4",
    trials: env.DASHBOARD_BENCH_TRIALS || "5",
    "idle-ms": env.DASHBOARD_BENCH_IDLE_MS || "1000",
    "timeout-ms": env.DASHBOARD_BENCH_TIMEOUT_MS || "30000",
    output:
      env.DASHBOARD_BENCH_OUTPUT ||
      path.join(ROOT, "benchmark-results/dashboard-demand.json"),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") return { help: true };
    const match = argv[i].match(/^--([^=]+)(?:=(.*))?$/);
    assert(
      match && Object.hasOwn(options, match[1]),
      `Unknown option: ${argv[i]}`,
    );
    options[match[1]] = match[2] ?? argv[++i];
    assert(options[match[1]] !== undefined, `Missing value for ${match[1]}`);
  }
  const rates = options.rates.split(",").map(Number);
  assert(rates.length && rates.every((n) => Number.isFinite(n) && n >= 1));
  assert.equal(new Set(rates).size, rates.length, "Duplicate CPU rates");
  const trials = Number(options.trials);
  const idleMs = Number(options["idle-ms"]);
  const timeoutMs = Number(options["timeout-ms"]);
  assert(Number.isSafeInteger(trials) && trials > 0);
  assert(
    [1000, 1500, 5000].includes(idleMs),
    "Idle window must be 1000, 1500 or 5000 ms",
  );
  assert(Number.isFinite(timeoutMs) && timeoutMs >= 1000);
  const variants = ["baseline", "current"].map((name) => {
    const url = new URL(options[`${name}-url`]);
    assert(["http:", "https:"].includes(url.protocol));
    assert(!url.username && !url.password && !url.hash && !url.search);
    assert.equal(url.pathname, "/", "Use a preview server origin URL");
    const sourceCommit = options[`${name}-commit`];
    assert(/^[a-f0-9]{40}$/i.test(sourceCommit), "Use full source commit IDs");
    return { name, url: url.href, sourceCommit };
  });
  assert.notEqual(variants[0].url, variants[1].url);
  return {
    variants,
    rates,
    trials,
    idleMs,
    timeoutMs,
    output: path.resolve(options.output),
  };
}

// Literal output of newChart/defaults (workspace.ts/config.ts at both commits),
// with deterministic id, authored key, and the test fixture's layout override.
// No TS loader or product-private runtime hook is needed by this runner.
function chart(s, i) {
  const axis = () => ({
    stroke: "#abb3bc",
    grid: { stroke: "#363b40" },
    ticks: { stroke: "#737b84" },
  });
  return {
    id: cardId(s, i),
    title: `key_${i}`,
    kind: i >= 6 ? "image" : "timeseries",
    source:
      s === 0 && i === 1
        ? {
            mode: "explicit",
            series: [{ runId: "dense", key: keyFor(0, 1), kind: "metric" }],
          }
        : { mode: "selected", keys: [keyFor(s, i)] },
    config: {
      version: 1,
      axis: "step",
      interpolation: "linear",
      smoothing: false,
      smoothingSigma: 1,
      joinScale: "linear",
      joinLog: 10,
      joinAsinh: 1,
      xScale: "linear",
      yScale: "linear",
      xMin: null,
      xMax: null,
      yMin: null,
      yMax: null,
      xLabel: "",
      yLabel: "",
      xFormat: "number",
      yFormat: "number",
      height: 280,
      width: null,
      grid: true,
      ticks: true,
      legend: true,
      cursor: true,
      zoom: true,
      palette: true,
      style: {
        color: "#60a5fa",
        width: 2,
        dash: [],
        points: false,
        pointSize: 5,
        fill: 0,
        visible: true,
        path: "matched",
      },
      runs: {},
      advanced: { axes: [axis(), axis()] },
    },
    outliers: "all",
    size: "normal",
    layout: { width: 300, height: 240 },
  };
}
function makeFixture(scenario) {
  assert(SCENARIOS.includes(scenario));
  const selected = scenario.startsWith("dense") ? "dense" : "sparse";
  const workspace = {
    version: 2,
    id: VIEW_ID,
    experimentId: "demand",
    name: VIEW_NAME,
    selectedRunIds: [selected],
    updatedAt: 1,
    sections: Array.from({ length: 30 }, (_, s) => ({
      id: `section-${s}`,
      title: `Section ${String(s).padStart(2, "0")}`,
      collapsed: scenario !== "sparse-open-startup",
      cards: Array.from({ length: 8 }, (_, i) => chart(s, i)),
    })),
  };
  const summary = (runId, s, i) => ({
    run_id: runId,
    key: keyFor(s, i),
    kind: i >= 6 ? "image" : "metric",
    count: 2,
    last_step: 1,
    last_timestamp: 2,
    last_value: i >= 6 ? null : 0.5,
  });
  const catalog = {
    experiments: [{ id: "demand", name: "Demand experiment", created_at: 1 }],
    runs: ["sparse", "dense"].map((id) => ({
      id,
      name: id === "sparse" ? "Sparse run" : "Dense run",
      experiment_id: "demand",
      status: "running",
      params: {},
      tags: {},
      created_at: 1,
      updated_at: 1,
    })),
    series: [
      summary("sparse", 0, 0),
      ...workspace.sections.flatMap((section, s) =>
        section.cards.map((_, i) => summary("dense", s, i)),
      ),
    ],
    metric_seq: 2,
  };
  const cards = workspace.sections.flatMap((s) => s.cards);
  assert.equal(cards.length, 240);
  assert.equal(cards.filter((c) => c.kind === "timeseries").length, 180);
  assert.equal(cards.filter((c) => c.kind === "image").length, 60);
  assert.equal(catalog.series.length, 241);
  const sparseMatches = cards.filter(
    (c) =>
      c.source.mode === "explicit" ||
      c.source.keys.some((key) =>
        catalog.series.some((s) => s.run_id === "sparse" && s.key === key),
      ),
  );
  assert.deepEqual(
    sparseMatches.map((c) => c.id),
    [cardId(0, 0), cardId(0, 1)],
  );
  return { workspace, catalog };
}

async function productionManifest(variant, timeoutMs) {
  const assets = {};
  const fetchAsset = async (url) => {
    assert.equal(
      new URL(url).origin,
      new URL(variant.url).origin,
      "Cross-origin production asset",
    );
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      redirect: "error",
    });
    assert(
      response.ok,
      `Cannot fetch production asset ${url}: ${response.status}`,
    );
    if (/\.js(?:\?|$)/.test(url))
      assert(
        /javascript|ecmascript/.test(
          response.headers.get("content-type") || "",
        ),
        `Not JavaScript: ${url}`,
      );
    if (/\.css(?:\?|$)/.test(url))
      assert(
        (response.headers.get("content-type") || "").includes("text/css"),
        `Not CSS: ${url}`,
      );
    const body = Buffer.from(await response.arrayBuffer());
    assets[url] = {
      sha256: hash(body),
      bytes: body.length,
      contentType: response.headers.get("content-type"),
    };
    return body.toString("utf8");
  };
  const html = await fetchAsset(variant.url);
  assert(
    !html.includes("/@vite/client") && !html.includes("/src/main.ts"),
    "Expected production build, not Vite dev server",
  );
  const entries = [
    ...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi),
  ].map((m) => new URL(m[1], variant.url).href);
  assert(
    entries.length > 0 &&
      entries.every((url) => /\/assets\/[^/]+\.js(?:\?|$)/.test(url)),
    "Missing hashed production entry script",
  );
  const queue = [
    ...entries,
    ...[...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)].map(
      (m) => new URL(m[1], variant.url).href,
    ),
  ];
  while (queue.length) {
    const url = queue.shift();
    if (assets[url]) continue;
    const text = await fetchAsset(url);
    if (!/\.(?:js|css)(?:\?|$)/.test(url)) continue;
    // Follow emitted hashed assets, not library strings such as OSD's unused
    // default button filenames. Vite mapDeps paths are relative to the origin;
    // ordinary relative imports and CSS URLs are relative to their asset file.
    const references = [
      ...text.matchAll(/["'`]([^\s"'`<>]+)["'`]/g),
      ...text.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g),
    ];
    for (const match of references) {
      const ref = match[1];
      if (
        /^(?:data:|https?:)/.test(ref) ||
        !/-[\w-]{8}\.(?:js|css|woff2?|ttf|svg|png|webp|jpg)(?:\?|$)/.test(ref)
      )
        continue;
      const candidate = new URL(
        ref,
        ref.startsWith("assets/") ? variant.url : url,
      ).href;
      if (!assets[candidate] && !queue.includes(candidate))
        queue.push(candidate);
    }
  }
  return {
    ...variant,
    htmlSha256: assets[variant.url].sha256,
    entries,
    assets,
  };
}

async function installFixture(context, variant, fixture, sample) {
  const baseURL = variant.url;
  const log = (sample.api = {
    requests: [],
    histories: [],
    tails: [],
    imageMetadata: [],
    imageContent: [],
    livePolls: 0,
    unexpected: [],
  });
  sample.networkErrors = [];
  sample.loadedAssets = [];
  const { workspace, catalog } = fixture;
  const metricPoints = (runId, key, after = 0) =>
    catalog.series.some(
      (s) => s.run_id === runId && s.key === key && s.kind === "metric",
    )
      ? [0, 1]
          .map((step) => ({
            seq: step + 1,
            step,
            timestamp: step + 1,
            value: 1 - step / 2,
          }))
          .filter((p) => p.seq > after)
      : [];
  const validRef = (runId, key) => {
    assert(["sparse", "dense"].includes(runId), `Unknown run ${runId}`);
    assert(
      /^section_(?:[0-9]|[12][0-9])\/key_[0-5]$/.test(key),
      `Unknown metric key ${key}`,
    );
  };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const pathname = decodeURIComponent(url.pathname);
    const isAPI = pathname.startsWith("/api/");
    try {
      assert.equal(
        url.origin,
        new URL(baseURL).origin,
        `Blocked external request ${url.href}`,
      );
      if (!isAPI) {
        assert.equal(method, "GET", "Non-API write blocked");
        url.hash = "";
        assert(
          variant.assets[url.href],
          `Unfingerprinted static request blocked: ${url.href}`,
        );
        sample.loadedAssets.push(url.href);
        return await route.continue();
      }
      log.requests.push({ method, path: pathname, query: url.search });
      const json = (body) => route.fulfill({ json: body });
      if (pathname === "/api/live" && method === "GET")
        return await json({ cursor: "live:0" });
      if (pathname === "/api/live" && method === "POST") {
        log.livePolls++;
        // Deliberately leave long poll pending until context.close(); no hot loop.
        return;
      }
      if (pathname === "/api/metrics/tail" && method === "POST") {
        const body = request.postDataJSON();
        assert(
          Array.isArray(body.series) &&
            body.series.length >= 1 &&
            body.series.length <= 64,
        );
        assert(
          Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= 1000,
        );
        log.tails.push(body);
        return await json({
          series: body.series.map((ref) => {
            validRef(ref.runId, ref.key);
            assert(
              Number.isSafeInteger(ref.after) &&
                ref.after >= 0 &&
                ref.after <= 2,
            );
            const snapshot = ref.snapshot ?? 2;
            assert.equal(snapshot, 2);
            return {
              runId: ref.runId,
              key: ref.key,
              points: metricPoints(ref.runId, ref.key, ref.after),
              snapshot,
              next_after: null,
            };
          }),
        });
      }
      assert.equal(method, "GET", `API write blocked: ${method} ${pathname}`);
      if (pathname === "/api/catalog") return await json(catalog);
      if (pathname === "/api/views")
        return await json({
          views: [
            {
              id: VIEW_ID,
              name: workspace.name,
              experimentId: "demand",
              revision: 1,
              updatedAt: 1,
            },
          ],
        });
      if (pathname === `/api/views/${VIEW_ID}`) {
        if (url.searchParams.get("revision") === "1")
          return await route.fulfill({ status: 204 });
        return await json({ id: VIEW_ID, revision: 1, workspace });
      }
      const metrics = pathname.match(/^\/api\/runs\/(sparse|dense)\/metrics$/);
      if (metrics) {
        const runId = metrics[1],
          key = url.searchParams.get("key");
        validRef(runId, key);
        log.histories.push({
          runId,
          key,
          after: url.searchParams.get("after"),
        });
        const points = metricPoints(runId, key);
        return await json({
          points,
          snapshot: 2,
          total: points.length,
          next_after: null,
        });
      }
      const images = pathname.match(/^\/api\/runs\/(sparse|dense)\/images$/);
      if (images) {
        log.imageMetadata.push(images[1]);
        return await json({
          images: catalog.series
            .filter((s) => s.run_id === images[1] && s.kind === "image")
            .map((s, i) => ({
              id: `frame-${i}`,
              run_id: s.run_id,
              key: s.key,
              step: 0,
              timestamp: 1,
              content_type: "image/png",
              byte_length: PNG.length,
            })),
        });
      }
      if (
        /^\/api\/images\/frame-(?:[0-9]|[1-5][0-9])\/content$/.test(pathname)
      ) {
        log.imageContent.push(pathname);
        return await route.fulfill({ contentType: "image/png", body: PNG });
      }
      throw new Error(`Unexpected API read: ${method} ${pathname}`);
    } catch (error) {
      // Closing a context can cancel a pending route.fulfill; do not invent errors.
      if (sample.closing) return;
      log.unexpected.push({ method, url: url.href, error: error.message });
      await route.abort("blockedbyclient").catch(() => {});
    }
  });
  await context.addInitScript(
    ({ open, name }) => {
      sessionStorage.setItem("nset.token", "test");
      const probe = (window.__dashboardBenchmark = {
        rafCallbacks: 0,
        appReadyMs: null,
        startupReadyMs: null,
      });
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) =>
        raf((time) => {
          probe.rafCallbacks++;
          callback(time);
        });
      // MutationObserver is disconnected at readiness, before the idle window.
      const ready = () => {
        const app =
          document
            .querySelector(".workspace-view-control")
            ?.textContent?.includes(name) &&
          document.querySelector("#connection")?.textContent?.trim() ===
            "Connected" &&
          document.querySelectorAll("#dashboard .section-heading").length ===
            30;
        if (!app) return;
        probe.appReadyMs ??= performance.now();
        if (
          open &&
          ![0, 1].every(
            (i) =>
              document.querySelectorAll(`[data-card-id="demand-0-${i}"] canvas`)
                .length === 1,
          )
        )
          return;
        probe.startupReadyMs ??= performance.now();
        observer.disconnect();
      };
      const observer = new MutationObserver(ready);
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    },
    { open: sample.scenario === "sparse-open-startup", name: VIEW_NAME },
  );
}

async function domCounts(page) {
  return page.evaluate(() => {
    const count = (s) => document.querySelectorAll(s).length;
    return {
      domNodes: count("*"),
      cards: count(".dashboard-cell[data-card-id]"),
      scalarCanvases: count('#dashboard [data-card-kind="timeseries"] canvas'),
      canvases: count("#dashboard canvas"),
      viewers: count("#dashboard .openseadragon-container"),
      visibleCards: [
        ...document.querySelectorAll(".dashboard-cell[data-card-id]"),
      ].filter(
        (n) =>
          n.getClientRects().length > 0 &&
          getComputedStyle(n).visibility !== "hidden",
      ).length,
    };
  });
}
async function assertState(page, sample, expect) {
  await expect(page.locator("#dashboard .section-heading")).toHaveCount(30);
  const sparseOpen = sample.scenario === "sparse-open-startup";
  await expect(
    page.locator(`#dashboard .section-toggle[aria-expanded="${sparseOpen}"]`),
  ).toHaveCount(30);
  if (sparseOpen) {
    for (const i of [0, 1])
      await expect(
        page.locator(`[data-card-id="${cardId(0, i)}"] canvas`),
      ).toHaveCount(1);
  }
  if (sample.variant !== "current") return;
  const dense = sample.scenario.startsWith("dense");
  const expected = dense
    ? { cards: 8, scalarCanvases: 6, canvases: 8, viewers: 2, visibleCards: 0 }
    : sparseOpen
      ? {
          cards: 2,
          scalarCanvases: 2,
          canvases: 2,
          viewers: 0,
          visibleCards: 2,
        }
      : {
          cards: 0,
          scalarCanvases: 0,
          canvases: 0,
          viewers: 0,
          visibleCards: 0,
        };
  const actual = await domCounts(page);
  for (const [key, value] of Object.entries(expected))
    assert.equal(actual[key], value, `Current final ${key}`);
  const ids = await page
    .locator(".dashboard-cell[data-card-id]")
    .evaluateAll((nodes) => nodes.map((n) => n.dataset.cardId).sort());
  assert.deepEqual(
    ids,
    Array.from({ length: expected.cards }, (_, i) => cardId(0, i)).sort(),
  );
}
function metricsMap(reply) {
  return Object.fromEntries(
    reply.metrics.map(({ name, value }) => [name, value]),
  );
}
function median(values) {
  assert(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b),
    mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
async function searchInteractions(page, sample) {
  sample.search = [];
  for (const query of INSTRUMENTATION.searchQueries) {
    // Locate again for EVERY update: renderCharts may replace the input node.
    const entry = await page
      .getByRole("searchbox", { name: "Search charts", exact: true })
      .evaluate(async (input, query) => {
        input.value = query;
        const start = performance.now();
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const handlerMs = performance.now() - start;
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        return {
          query,
          handlerMs,
          updateThroughPaintMs: performance.now() - start,
        };
      }, query);
    sample.search.push({ label: INSTRUMENTATION.searchLabel, ...entry });
  }
  sample.metrics.searchHandlerMedianMs = median(
    sample.search.map((s) => s.handlerMs),
  );
  sample.metrics.searchUpdateThroughPaintMedianMs = median(
    sample.search.map((s) => s.updateThroughPaintMs),
  );
}
async function runTrial(
  browser,
  config,
  variant,
  scenario,
  rate,
  trial,
  order,
  warmup,
  expect,
  sample,
) {
  Object.assign(sample, {
    variant: variant.name,
    sourceCommit: variant.sourceCommit,
    scenario,
    cpuThrottleRate: rate,
    trial,
    order,
    warmup,
    recorded: !warmup,
    status: "running",
    pageErrors: [],
    console: [],
    metrics: {},
  });
  let context;
  const warnings = new Map();
  try {
    context = await browser.newContext({
      viewport: INSTRUMENTATION.viewport,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(config.timeoutMs);
    page.setDefaultNavigationTimeout(config.timeoutMs);
    page.on("pageerror", (error) =>
      sample.pageErrors.push(serializedError(error)),
    );
    page.on("console", (message) => {
      if (!["warning", "error"].includes(message.type())) return;
      const text = message.text(),
        key = `${message.type()}:${text}`;
      const entry = warnings.get(key) || {
        type: message.type(),
        text,
        count: 0,
      };
      entry.count++;
      warnings.set(key, entry);
    });
    const fixture = makeFixture(scenario);
    sample.fixtureSha256 = hash(JSON.stringify(fixture));
    await installFixture(context, variant, fixture, sample);
    page.on("requestfailed", (request) => {
      if (!sample.closing)
        sample.networkErrors.push({
          url: request.url(),
          error: request.failure()?.errorText,
        });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    await cdp.send("Performance.enable", { timeDomain: "timeTicks" });
    await cdp.send("HeapProfiler.enable");
    await page.goto(`${variant.url}#/views/${encodeURIComponent(VIEW_ID)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () => Number.isFinite(window.__dashboardBenchmark?.startupReadyMs),
      null,
      { polling: 50 },
    );
    Object.assign(
      sample.metrics,
      await page.evaluate(() => ({
        startupReadyMs: window.__dashboardBenchmark.startupReadyMs,
        appReadyMs: window.__dashboardBenchmark.appReadyMs,
      })),
    );
    sample.readinessCriterion =
      scenario === "sparse-open-startup"
        ? INSTRUMENTATION.readiness.open
        : INSTRUMENTATION.readiness.app;
    if (scenario.startsWith("dense")) {
      const toggle = page.locator(
        '[data-section-id="section-0"] .section-toggle',
      );
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      const started = await page.evaluate(() => performance.now());
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      for (let i = 0; i < 6; i++)
        await expect(
          page.locator(`[data-card-id="${cardId(0, i)}"] canvas`),
        ).toHaveCount(1);
      for (const i of [6, 7]) {
        const image = page.locator(`[data-card-id="${cardId(0, i)}"]`);
        await expect(image.locator(".frame-info")).toHaveAttribute(
          "data-step",
          "0",
        );
        await expect(image.locator(".image-frame-status")).toHaveText("");
        await expect(image.locator(".image-canvas")).toHaveAttribute(
          "data-zoom",
          /\d/,
        );
      }
      sample.metrics.denseOpenReadyMs = await page.evaluate(
        (start) => performance.now() - start,
        started,
      );
      assert(sample.api.imageContent.includes("/api/images/frame-0/content"));
      assert(sample.api.imageContent.includes("/api/images/frame-1/content"));
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
    }
    await assertState(page, sample, expect);
    // Same drain and GC sequence for BOTH variants; dense fold gets >=500 ms.
    await sleep(INSTRUMENTATION.drainMs);
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const dom = await cdp.send("Memory.getDOMCounters");
    Object.assign(sample.metrics, {
      jsHeapAfterGCBytes: heap.usedSize,
      jsHeapTotalAfterGCBytes: heap.totalSize,
      cdpDocumentsAfterGC: dom.documents,
      cdpNodesAfterGC: dom.nodes,
      cdpEventListenersAfterGC: dom.jsEventListeners,
    });
    const rafStart = await page.evaluate(() => ({
      callbacks: window.__dashboardBenchmark.rafCallbacks,
      time: performance.now(),
    }));
    const requestStart = sample.api.requests.length;
    const before = metricsMap(await cdp.send("Performance.getMetrics"));
    // No browser evaluations, polling, assertions, rAF probes or forced GC here.
    await sleep(config.idleMs);
    const after = metricsMap(await cdp.send("Performance.getMetrics"));
    const rafEnd = await page.evaluate(() => ({
      callbacks: window.__dashboardBenchmark.rafCallbacks,
      time: performance.now(),
    }));
    const seconds = after.Timestamp - before.Timestamp;
    assert(
      Number.isFinite(seconds) && seconds > 0,
      "Invalid CDP timestamp interval",
    );
    const taskMs = (after.TaskDuration - before.TaskDuration) * 1000;
    assert(Number.isFinite(taskMs) && taskMs >= 0, "Invalid CDP TaskDuration");
    sample.idleRaw = { before, after, rafStart, rafEnd };
    Object.assign(sample.metrics, await domCounts(page), {
      idleTaskMsPerSecond: taskMs / seconds,
      idleTaskDurationMs: taskMs,
      idleTimestampElapsedMs: seconds * 1000,
      idleRAFCallbacks: rafEnd.callbacks - rafStart.callbacks,
      idleRAFCallbacksPerSecond:
        ((rafEnd.callbacks - rafStart.callbacks) * 1000) /
        (rafEnd.time - rafStart.time),
      idleRAFObservationMs: rafEnd.time - rafStart.time,
      idleAPIRequests: sample.api.requests.length - requestStart,
    });
    if (scenario.startsWith("sparse")) await searchInteractions(page, sample);
    await assertState(page, sample, expect);
    sample.finalDOMCounts = await domCounts(page);
    if (variant.name === "current") {
      const expectedHistories = scenario.startsWith("dense")
        ? Array.from({ length: 6 }, (_, i) => `dense:${keyFor(0, i)}`)
        : scenario === "sparse-open-startup"
          ? [`sparse:${keyFor(0, 0)}`, `dense:${keyFor(0, 1)}`]
          : [];
      assert.deepEqual(
        [
          ...new Set(sample.api.histories.map((h) => `${h.runId}:${h.key}`)),
        ].sort(),
        expectedHistories.sort(),
      );
      if (scenario.startsWith("sparse")) {
        assert.deepEqual(sample.api.imageMetadata, []);
        assert.deepEqual(sample.api.imageContent, []);
      } else assert.equal(new Set(sample.api.imageContent).size, 2);
    }
    assert(
      sample.api.requests.some((r) => r.path === "/api/catalog"),
      "Catalog not fetched",
    );
    assert(sample.api.livePolls > 0, "Live subscription not established");
    assert.deepEqual(
      sample.api.unexpected,
      [],
      "Unexpected API/network request",
    );
    assert.deepEqual(sample.pageErrors, [], "Uncaught browser page error");
    const loaded = [...new Set(sample.loadedAssets)].map((u) => {
      const url = new URL(u);
      url.hash = "";
      return url.href;
    });
    sample.loadedAssets = [...new Set(loaded)].sort();
    for (const entry of variant.entries)
      assert(
        sample.loadedAssets.includes(entry),
        "Production entry not loaded",
      );
    // All real static requests were checked against the preflight manifest.
    sample.loadedAssetHashes = Object.fromEntries(
      sample.loadedAssets.map((u) => [u, variant.assets[u].sha256]),
    );
    sample.status = "complete";
  } catch (error) {
    sample.status = "failed";
    sample.error = serializedError(error);
    throw error;
  } finally {
    sample.closing = true;
    try {
      if (context) await context.close();
      if (sample.status === "complete")
        assert.deepEqual(
          sample.pageErrors,
          [],
          "Late uncaught browser page error",
        );
    } catch (error) {
      sample.status = "failed";
      sample.error ??= serializedError(error);
      throw error;
    } finally {
      sample.console = [...warnings.values()];
      sample.metrics.consoleWarnings = sample.console
        .filter((m) => m.type === "warning")
        .reduce((n, m) => n + m.count, 0);
      sample.metrics.webGLWarnings = sample.console
        .filter((m) => /webgl|gpu|context.*lost/i.test(m.text))
        .reduce((n, m) => n + m.count, 0);
      sample.metrics.pageErrors = sample.pageErrors.length;
      delete sample.closing;
    }
  }
}
function aggregate(samples) {
  const groups = new Map();
  for (const sample of samples.filter(
    (s) => s.recorded && s.status === "complete",
  )) {
    const key = `${sample.variant}/${sample.cpuThrottleRate}/${sample.scenario}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  return [...groups.values()].map((samples) => {
    const first = samples[0],
      metrics = {};
    for (const [name, unit] of Object.entries(UNITS)) {
      const values = samples
        .map((s) => s.metrics[name])
        .filter((n) => Number.isFinite(n));
      if (!values.length) continue;
      metrics[name] = {
        unit,
        n: values.length,
        min: Math.min(...values),
        median: median(values),
        max: Math.max(...values),
      };
    }
    return {
      variant: first.variant,
      cpuThrottleRate: first.cpuThrottleRate,
      scenario: first.scenario,
      n: samples.length,
      metrics,
    };
  });
}
async function main() {
  const config = configFromArgs();
  if (config.help) {
    console.log(`Production dashboard benchmark (no servers/builds started).
Usage: node web/benchmarks/dashboard-demand.cjs [options]
  --baseline-url URL       default http://127.0.0.1:4202
  --current-url URL        default http://127.0.0.1:4203
  --baseline-commit SHA40  default 213d2410eae12a230f922e2269643d4934602829
  --current-commit SHA40   default cf965c8ac3bf88496ff2fd365a410b5e384d6476
  --rates 1,4              renderer CPU throttle multipliers
  --trials 5               recorded trials per variant/rate/scenario
  --idle-ms 1000           accepts 1000, 1500 or 5000
Optional env: DASHBOARD_BENCH_ANGLE=metal (or swiftshader-webgl),
DASHBOARD_BENCH_SCENARIO=one scenario name, DASHBOARD_BENCH_DRAIN_MS=5000.
  --timeout-ms 30000       readiness/asset timeout, not an idle window
  --output PATH           default benchmark-results/dashboard-demand.json
Environment equivalents: DASHBOARD_BENCH_ followed by uppercase option name,
with hyphens replaced by underscores. Warmups: one pair per rate/scenario.
All results and runner source are saved beside output. Failed runs save partial
results with status=failed and exit nonzero; no incomplete comparison is claimed.`);
    return;
  }
  const outputDir = path.dirname(config.output);
  const report = {
    schemaVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    config: { ...config, instrumentation: INSTRUMENTATION, units: UNITS },
    variants: [],
    samples: [],
    aggregates: [],
  };
  let browser;
  const persist = async () => {
    report.aggregates = aggregate(report.samples);
    await fs.writeFile(
      `${config.output}.tmp`,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await fs.rename(`${config.output}.tmp`, config.output);
  };
  try {
    await fs.mkdir(outputDir, { recursive: true });
    const source = await fs.readFile(__filename);
    const provenancePath = path.join(outputDir, "dashboard-demand.cjs");
    assert.notEqual(
      path.resolve(provenancePath),
      path.resolve(__filename),
      "Output must not overwrite runner source",
    );
    await fs.writeFile(provenancePath, source);
    report.config.runner = {
      path: __filename,
      copiedTo: provenancePath,
      sha256: hash(source),
      sourceHead: git("rev-parse", "HEAD"),
      worktreeStatus: git("status", "--short"),
      command: [process.execPath, ...process.argv.slice(1)],
    };
    report.config.host = {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model,
      logicalCores: os.cpus().length,
      memoryBytes: os.totalmem(),
      node: process.version,
    };
    report.config.fixture = {
      sections: 30,
      cards: 240,
      scalarCards: 180,
      imageCards: 60,
      sparseNativeKeys: 1,
      sparseMatchingCharts: 2,
      pngBytes: PNG.length,
      pngSha256: hash(PNG),
      scenarioSha256: Object.fromEntries(
        SCENARIOS.map((s) => [s, hash(JSON.stringify(makeFixture(s)))]),
      ),
    };
    const { chromium, expect: baseExpect } = localRequire("@playwright/test");
    const expect = baseExpect.configure({ timeout: config.timeoutMs });
    report.config.playwrightVersion = localRequire(
      "@playwright/test/package.json",
    ).version;
    // Fetch and hash both production builds BEFORE any browser trials.
    for (const variant of config.variants)
      report.variants.push(await productionManifest(variant, config.timeoutMs));
    assert.notEqual(
      report.variants[0].assets[report.variants[0].entries[0]].sha256,
      report.variants[1].assets[report.variants[1].entries[0]].sha256,
      "Baseline/current production entry bytes are identical",
    );
    const angle = process.env.DASHBOARD_BENCH_ANGLE || "";
    assert(
      ["", "metal", "swiftshader-webgl"].includes(angle),
      "Unsupported ANGLE backend",
    );
    const args = angle ? [`--use-angle=${angle}`] : [];
    report.config.browserArgs = args;
    browser = await chromium.launch({ headless: true, args });
    const browserCDP = await browser.newBrowserCDPSession();
    report.config.graphics = await browserCDP.send("SystemInfo.getInfo");
    await browserCDP.detach();
    report.config.browserVersion = browser.version();
    report.config.browserExecutable = chromium.executablePath();
    await persist();
    for (const rate of config.rates) {
      for (const scenario of SCENARIOS) {
        for (let trial = 0; trial <= config.trials; trial++) {
          const variants =
            trial % 2 ? [...report.variants].reverse() : report.variants;
          for (const [order, variant] of variants.entries()) {
            const sample = {};
            report.samples.push(sample);
            try {
              await runTrial(
                browser,
                config,
                variant,
                scenario,
                rate,
                trial,
                order,
                trial === 0,
                expect,
                sample,
              );
            } finally {
              console.log(
                JSON.stringify({ kind: "dashboard-demand-sample", ...sample }),
              );
              await persist();
            }
          }
        }
      }
    }
    const expectedSamples =
      config.rates.length * SCENARIOS.length * config.trials * 2;
    assert.equal(
      report.samples.filter((s) => s.recorded && s.status === "complete")
        .length,
      expectedSamples,
    );
    // Recheck assets after all trials: reject a preview build changed mid-run.
    for (const variant of report.variants) {
      const verified = await productionManifest(variant, config.timeoutMs);
      assert.deepEqual(
        verified.assets,
        variant.assets,
        `Production assets changed during run: ${variant.name}`,
      );
    }
    await browser.close();
    browser = null;
    report.status = "complete";
    report.finishedAt = new Date().toISOString();
    await persist();
    console.log(
      JSON.stringify({
        kind: "dashboard-demand-summary",
        status: report.status,
        output: config.output,
        recordedSamples: expectedSamples,
        aggregates: report.aggregates,
      }),
    );
  } catch (error) {
    report.status = "failed";
    report.error = serializedError(error);
    report.finishedAt = new Date().toISOString();
    await persist().catch((saveError) =>
      console.error("Could not save partial results:", saveError),
    );
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}
module.exports = {
  INSTRUMENTATION,
  SCENARIOS,
  UNITS,
  configFromArgs,
  makeFixture,
  aggregate,
  main,
};
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
