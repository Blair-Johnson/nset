import {
  expect,
  test as base,
  type APIRequestContext,
  type Request,
} from "@playwright/test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { newChart } from "../src/workspace";
import type { Workspace } from "../src/workspace-types";

// Opt in with NSET_LIVE_BINARY=/absolute/path/to/nset. Build the embedded web
// assets into that binary first. Nothing in this test uses the Vite baseURL,
// request routing, browser source imports, or an existing database/server.
const keys = Array.from(
  { length: 24 },
  (_, i) => `metric_${String(i).padStart(2, "0")}`,
);
const mainCard = '[data-card-id="real-live-chart"]';
const zoomCard = '[data-card-id="real-zoom-chart"]';
const epoch = 1_700_000_000_000;

type Server = { url: string; token: string; api: APIRequestContext };
const test = base.extend<{ server: Server }>({
  server: [
    async ({ playwright }, use, testInfo) => {
      const binary = process.env.NSET_LIVE_BINARY;
      test.skip(
        !binary,
        "Set NSET_LIVE_BINARY to a Rust binary with embedded frontend assets",
      );
      const root = await mkdtemp(join(tmpdir(), "nset-live-browser-"));
      const token = randomBytes(32).toString("hex");
      // Do not inherit tuning (especially paused ingest) or storage/source settings.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("NSET_")),
      );
      const child = spawn(
        resolve(binary!),
        [
          "serve",
          "--host",
          "127.0.0.1",
          "--port",
          "0",
          "--db-path",
          join(root, "db"),
        ],
        {
          cwd: root,
          env: { ...env, NSET_TOKEN: token, NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      let spawnError: Error | undefined;
      let closed = false;
      let forced = false;
      const exited = new Promise<void>((done) =>
        child.once("close", () => {
          closed = true;
          done();
        }),
      );
      child.on("error", (error) => {
        spawnError = error;
      });
      const capture = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-64_000);
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      let api: APIRequestContext | undefined;
      const waitForExit = async (ms: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          exited,
          new Promise<void>((done) => {
            timer = setTimeout(done, ms);
          }),
        ]);
        clearTimeout(timer);
        return closed;
      };
      try {
        let port = "";
        await expect
          .poll(
            () => {
              if (spawnError) throw spawnError;
              if (closed)
                throw new Error(`nset exited during startup:\n${output}`);
              const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
              port = plain.match(/\b127\.0\.0\.1:(\d+)\b/)?.[1] ?? "";
              return Number(port) > 0;
            },
            {
              timeout: 15_000,
              message: "child publishes its OS-assigned listening port",
            },
          )
          .toBe(true);
        const url = `http://127.0.0.1:${port}`;
        api = await playwright.request.newContext({
          baseURL: url,
          extraHTTPHeaders: { Authorization: `Bearer ${token}` },
          timeout: 5_000,
        });
        const unauthorized = await api.get("/api/health", {
          headers: { Authorization: "Bearer incorrect" },
        });
        expect(unauthorized.status()).toBe(401);
        const health = await api.get("/api/health");
        expect(health.status()).toBe(200);
        expect(await health.json()).toEqual({ status: "ok" });
        await use({ url, token, api });
      } finally {
        await api?.dispose();
        if (!closed) {
          child.kill("SIGTERM");
          if (!(await waitForExit(5_000))) {
            forced = true;
            child.kill("SIGKILL");
            await waitForExit(3_000);
          }
        }
        await testInfo.attach("live-server-process.txt", {
          body: Buffer.from(
            `forcedKill=${forced}; reaped=${closed}\n${output.replaceAll(token, "<redacted>")}`,
          ),
          contentType: "text/plain",
        });
        // Never remove a directory that might still be owned by a live process.
        if (closed) await rm(root, { recursive: true, force: true });
        expect(closed, "private backend process was reaped").toBe(true);
      }
    },
    { timeout: 30_000 },
  ],
});

type Traffic = {
  method: string;
  path: string;
  query: string;
  startedMs: number;
  status?: number;
  responseMs?: number;
  responseBodyBytes?: number;
  tailKeys?: string[];
  changeKinds?: string[];
  reset?: boolean;
  finishedRuns?: string[];
  bodyError?: string;
};

test("embedded frontend follows real scalar writes, idle heartbeat and durable terminal data", async ({
  page,
  server,
}, testInfo) => {
  test.setTimeout(90_000);
  const { url, token, api } = server;
  const traffic: Traffic[] = [];
  const requests = new Map<Request, Traffic>();
  const activePolls = new Set<Request>();
  const bodies: Promise<void>[] = [];
  const pageErrors: string[] = [];
  const badAuth: string[] = [];
  const timings: {
    batch: string;
    writeToVisibleMs: number;
    tailRequests: number;
  }[] = [];
  let maxActivePolls = 0;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const matching = (method: string, path: string) =>
    traffic.filter((r) => r.method === method && r.path === path);
  const counts = () => ({
    catalog: matching("GET", "/api/catalog").length,
    checkpoint: matching("GET", "/api/live").length,
    history: traffic.filter(
      (r) => r.method === "GET" && /\/runs\/[^/]+\/metrics$/.test(r.path),
    ).length,
    tail: matching("POST", "/api/metrics/tail").length,
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const target = new URL(request.url());
    if (target.origin !== url || !target.pathname.startsWith("/api/")) return;
    const row: Traffic = {
      method: request.method(),
      path: target.pathname,
      query: target.search,
      startedMs: elapsed(),
    };
    traffic.push(row);
    requests.set(request, row);
    if (request.headers().authorization !== `Bearer ${token}`)
      badAuth.push(`${row.method} ${row.path}`);
    if (row.method === "POST" && row.path === "/api/metrics/tail") {
      row.tailKeys = request
        .postDataJSON()
        .series.map((ref: { key: string }) => ref.key);
    }
    if (row.method === "POST" && row.path === "/api/live") {
      activePolls.add(request);
      maxActivePolls = Math.max(maxActivePolls, activePolls.size);
    }
  });
  page.on("requestfailed", (request) => activePolls.delete(request));
  page.on("response", (response) => {
    const request = response.request();
    const row = requests.get(request);
    if (!row) return;
    // A response ends the outstanding long poll; the next subscription may begin
    // before Playwright emits requestfinished for the previous response body.
    activePolls.delete(request);
    row.status = response.status();
    row.responseMs = elapsed() - row.startedMs;
    bodies.push(
      (async () => {
        try {
          const body = await response.body();
          row.responseBodyBytes = body.length; // decoded body bytes, not wire/compressed bytes
          if (row.path === "/api/live" && row.method === "POST") {
            const data = JSON.parse(body.toString());
            row.changeKinds = data.changes.map(
              (change: { kind: string }) => change.kind,
            );
            row.reset = data.reset;
          }
          if (row.path === "/api/catalog") {
            row.finishedRuns = JSON.parse(body.toString())
              .runs.filter(
                (run: { status: string }) => run.status === "finished",
              )
              .map((run: { id: string }) => run.id);
          }
        } catch (error) {
          row.bodyError = String(error);
        }
      })(),
    );
  });
  async function json<T>(
    method: string,
    path: string,
    data?: unknown,
  ): Promise<T> {
    const response = await api.fetch(path, {
      method,
      ...(data === undefined ? {} : { data }),
    });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(
      true,
    );
    return response.json() as Promise<T>;
  }
  const metrics = (step: number, tick: number, baseValue: number) => ({
    metrics: keys.map((key, i) => ({
      key,
      step,
      timestamp: epoch + tick * 1_000,
      value: baseValue + i,
    })),
  });
  async function hover(selector: string, fraction = 0.99) {
    const over = page.locator(`${selector} .u-over`);
    await over.scrollIntoViewIfNeeded();
    const box = await over.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 2, box!.y + 2);
    await page.mouse.move(
      box!.x + box!.width * fraction,
      box!.y + box!.height / 2,
    );
  }
  async function newestValues(baseValue: number, timeout = 5_000) {
    await expect
      .poll(
        async () => {
          // A stationary crosshair at the old X does not mean the cache is stale.
          // Explicitly move to the newly auto-fitted right edge on every observation.
          await hover(mainCard);
          return page
            .locator(`${mainCard} .u-legend .u-series[data-series-index]`)
            .evaluateAll((rows) =>
              rows
                .filter(
                  (row) =>
                    Number((row as HTMLElement).dataset.seriesIndex) % 2 === 1,
                )
                .map((row) =>
                  row.querySelector(".u-value")?.textContent?.trim(),
                ),
            );
        },
        {
          timeout,
          intervals: [50, 100, 200],
          message: "all 24 real chart legends show the newest timestamp",
        },
      )
      .toEqual(keys.map((_, i) => (baseValue + i).toFixed(2)));
  }
  try {
    const experiment = await json<{ id: string }>("POST", "/api/experiments", {
      name: "Real browser live smoke",
    });
    const run = await json<{ id: string }>("POST", "/api/runs", {
      experiment_id: experiment.id,
      name: "Live run",
      params: {},
      tags: {},
    });
    const metricPath = `/api/runs/${run.id}/metrics`;
    await json("POST", metricPath, {
      metrics: [...metrics(0, 0, 0).metrics, ...metrics(1, 1, 100).metrics],
    });
    const chart = newChart("timeseries", keys, "Real live metrics");
    chart.id = "real-live-chart";
    chart.layout = { width: 700, height: 440 };
    chart.config.axis = "timestamp";
    chart.config.yFormat = "fixed-2";
    chart.config.advanced.legend = { live: true };
    const zoom = newChart("timeseries", [keys[0]], "Retained zoom");
    zoom.id = "real-zoom-chart";
    zoom.layout = { width: 420, height: 440 };
    zoom.config.xFormat = "fixed-2";
    zoom.config.yFormat = "fixed-2";
    const workspace: Workspace = {
      version: 2,
      id: "real-live-seed",
      experimentId: experiment.id,
      name: "Real live server view",
      selectedRunIds: [run.id],
      updatedAt: Date.now(),
      sections: [
        {
          id: "metrics",
          title: "Metrics",
          collapsed: false,
          cards: [chart, zoom],
        },
      ],
    };
    const saved = await json<{ id: string }>("POST", "/api/views", {
      workspace,
    });
    expect(saved.id).toMatch(/^server:/);
    await page.setViewportSize({ width: 1600, height: 1200 });
    await page.addInitScript(
      (secret) => sessionStorage.setItem("nset.token", secret),
      token,
    );
    const document = await page.goto(
      `${url}/#/views/${encodeURIComponent(saved.id)}`,
    );
    expect(document?.status()).toBe(200);
    expect(document?.headers()["content-type"]).toContain("text/html");
    const scripts = await page
      .locator("script[src]")
      .evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLScriptElement).src),
      );
    expect(scripts.length).toBeGreaterThan(0);
    expect(
      scripts.every(
        (src) =>
          src.startsWith(`${url}/`) &&
          !src.includes("/src/") &&
          !src.includes("/@vite/"),
      ),
    ).toBe(true);
    await expect(page.locator(".workspace-view-control")).toContainText(
      workspace.name,
    );
    await expect(page.locator(`${mainCard} canvas`).first()).toBeVisible();
    await expect(page.locator(`${zoomCard} canvas`).first()).toBeVisible();
    await expect(page.locator("#connection")).toHaveText("Connected");
    await newestValues(100);
    await expect.poll(() => activePolls.size).toBe(1);
    const initial = counts();
    expect(initial).toMatchObject({
      catalog: 1,
      checkpoint: 1,
      history: 24,
      tail: 0,
    });
    expect(
      matching("GET", metricPath)
        .map((row) => new URLSearchParams(row.query).get("key"))
        .sort(),
    ).toEqual([...keys].sort());

    const canvases = await Promise.all(
      [mainCard, zoomCard].map((selector) =>
        page.locator(`${selector} canvas`).first().elementHandle(),
      ),
    );
    const health = await page.evaluateHandle(() => {
      const node = document.querySelector("#connection")!;
      const samples: { text: string | null; connected: boolean }[] = [];
      const observer = new MutationObserver(() =>
        samples.push({
          text: node.textContent,
          connected: node.classList.contains("connected"),
        }),
      );
      observer.observe(node, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      return { samples, observer };
    });
    await page
      .locator(zoomCard)
      .getByRole("button", { name: "Zoom in", exact: true })
      .click();
    await expect(
      page
        .locator(zoomCard)
        .getByRole("button", { name: "Previous view", exact: true }),
    ).toBeEnabled();
    await hover(zoomCard, 0.75);
    const cameraReadout = await page
      .locator(`${zoomCard} .mouse-axis-tick-x`)
      .textContent();
    expect(cameraReadout?.trim()).toBeTruthy();
    async function checkRetained() {
      for (const [i, selector] of [mainCard, zoomCard].entries()) {
        expect(
          await canvases[i]!.evaluate(
            (node, selector) =>
              node.isConnected &&
              node === document.querySelector(`${selector} canvas`),
            selector,
          ),
        ).toBe(true);
      }
      await expect(
        page
          .locator(zoomCard)
          .getByRole("button", { name: "Previous view", exact: true }),
      ).toBeEnabled();
      await hover(zoomCard, 0.75);
      expect(
        await page.locator(`${zoomCard} .mouse-axis-tick-x`).textContent(),
      ).toBe(cameraReadout);
    }
    async function writeAndSee(
      label: string,
      method: string,
      path: string,
      step: number,
      tick: number,
      value: number,
    ) {
      const before = counts();
      const networkStart = traffic.length;
      const sent = performance.now();
      await json(method, path, metrics(step, tick, value));
      await newestValues(
        value,
        Math.max(1, 5_000 - (performance.now() - sent)),
      );
      const writeToVisibleMs = Math.round(performance.now() - sent);
      timings.push({
        batch: label,
        writeToVisibleMs,
        tailRequests: counts().tail - before.tail,
      });
      expect(
        writeToVisibleMs,
        `${label}: rough write-to-visible budget`,
      ).toBeLessThan(5_000);
      expect(counts()).toEqual({ ...before, tail: before.tail + 1 });
      // Saved-view metadata has its own existing 3s revision poll, independent
      // of the metric feed. Record it, but do not mistake it for metric refetch.
      const metricTraffic = traffic
        .slice(networkStart)
        .filter(
          (r) =>
            !(
              r.method === "GET" &&
              (r.path === "/api/views" || r.path.startsWith("/api/views/"))
            ),
        );
      expect(
        metricTraffic.every(
          (r) =>
            r.method === "POST" &&
            ["/api/live", "/api/metrics/tail"].includes(r.path),
        ),
      ).toBe(true);
      expect(
        matching("POST", "/api/metrics/tail").at(-1)!.tailKeys?.slice().sort(),
      ).toEqual([...keys].sort());
      await checkRetained();
    }
    // Every request contains exactly 24 scalar observations. Step repeats and
    // regresses, while timestamp X remains monotonic for an exact newest readout.
    for (const [i, step] of [2, 3, 3, 1, 4].entries()) {
      await writeAndSee(
        `native-${i + 1}`,
        "POST",
        metricPath,
        step,
        i + 2,
        (i + 1) * 1_000,
      );
    }

    // No events: let the real 20s server heartbeat complete (no mocked clock).
    const idle = counts();
    const emptyPolls = () =>
      matching("POST", "/api/live").filter(
        (r) => r.changeKinds?.length === 0 && r.reset === false,
      );
    const emptyBefore = emptyPolls().length;
    await expect
      .poll(() => emptyPolls().length, {
        timeout: 23_000,
        intervals: [100, 250, 500],
      })
      .toBeGreaterThan(emptyBefore);
    expect(emptyPolls().at(-1)!.responseMs).toBeGreaterThanOrEqual(19_000);
    expect(counts()).toEqual(idle);
    await expect(page.locator("#connection")).toHaveText("Connected");
    await expect.poll(() => activePolls.size).toBe(1);

    // A status change legitimately refreshes the catalog; metric-only batches do
    // not. Wait for this refresh before sending a late durable final observation.
    await json("PATCH", `/api/runs/${run.id}`, { status: "finished" });
    await expect
      .poll(
        () =>
          matching("GET", "/api/catalog").some((r) =>
            r.finishedRuns?.includes(run.id),
          ),
        { timeout: 5_000 },
      )
      .toBe(true);
    const durablePath = `/api/runs/${run.id}/ingest/live-final-${randomBytes(8).toString("hex")}`;
    await writeAndSee(
      "durable-after-finished",
      "PUT",
      durablePath,
      5,
      7,
      9_000,
    );
    await expect
      .poll(
        async () => (await json<{ state: string }>("GET", durablePath)).state,
        { timeout: 5_000 },
      )
      .toBe("applied");
    const finalRun = await json<{ status: string }>(
      "GET",
      `/api/runs/${run.id}`,
    );
    expect(finalRun.status).toBe("finished");
    // Verify durable projection count without adding browser history traffic.
    const finalHistory = await json<{ total: number }>(
      "GET",
      `${metricPath}?key=${keys[0]}`,
    );
    expect(finalHistory.total).toBe(8);
    expect(counts().history).toBe(initial.history);
    expect(counts().checkpoint).toBe(1);
    expect(
      maxActivePolls,
      "one outstanding feed subscription for this tab",
    ).toBe(1);
    expect(
      await health.evaluate(({ samples }) =>
        samples.every((s) => s.text === "Connected" && s.connected),
      ),
    ).toBe(true);
    await health.evaluate(({ observer }) => observer.disconnect());
    expect(pageErrors).toEqual([]);
    expect(badAuth).toEqual([]);
    expect(
      traffic.filter((r) => r.status !== undefined && r.status >= 400),
    ).toEqual([]);
  } finally {
    // Abort the remaining long poll before gracefully stopping the private server.
    await page.close();
    await Promise.all(bodies);
    const observations = JSON.stringify(
      {
        note: "Single smoke run, not a benchmark. Latencies include HTTP write, polling and DOM observation; bytes are decoded browser response bodies, not wire bytes.",
        browser: testInfo.project.name,
        timings,
        maxActivePolls,
        counts: counts(),
        traffic,
        pageErrors,
        badAuth,
      },
      null,
      2,
    );
    const observationPath = testInfo.outputPath(
      "live-server-observations.json",
    );
    await writeFile(observationPath, observations);
    await testInfo.attach("live-server-observations.json", {
      path: observationPath,
      contentType: "application/json",
    });
  }
});
