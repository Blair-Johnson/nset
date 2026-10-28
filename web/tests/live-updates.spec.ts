import { expect, test as base, type Page, type Route } from "@playwright/test";
import { newChart } from "../src/workspace";
import type { Workspace } from "../src/workspace-types";
import type { MetricTailRequest } from "../src/api";
import type { LiveChange } from "../src/live";
import type { Point } from "../src/math";

const viewId = "server:00000000-0000-0000-0000-000000000017";
const draftKey = `nset.server-view-draft.v1:${encodeURIComponent(viewId)}`;
const keys = Array.from({ length: 24 }, (_, i) => `metric_${i}`);
const missingKey = "arrives_later";
const card = '[data-card-id="live-chart"]';
type MetricPoint = Point & { key: string };

/** Real index.html, main.ts, MetricStore, cards and uPlot. Only HTTP is mocked.
 * Live POSTs wait for explicit replies; an idle mock cannot create a hot loop.
 */
async function fixture(page: Page) {
  let high = 0;
  let cursor = "live:0";
  let cursorNumber = 0;
  let status = "running";
  let failTails = false;
  let catalogRequests = 0;
  let checkpointRequests = 0;
  const polls: Route[] = [];
  const pollBodies: { cursor: string }[] = [];
  const tails: { series: MetricTailRequest[]; limit?: number }[] = [];
  const histories: { key: string; after: string | null }[] = [];
  const writes: string[] = [];
  const unexpected: string[] = [];
  const points = new Map<string, MetricPoint[]>();
  for (const [i, key] of keys.entries()) {
    points.set(key, [
      { seq: ++high, key, step: 0, timestamp: 100, value: i + 1 },
      { seq: ++high, key, step: 1, timestamp: 101, value: i + 2 },
    ]);
  }
  const chart = newChart("timeseries", [...keys, missingKey], "Live metrics");
  chart.id = "live-chart";
  const workspace: Workspace = {
    version: 2,
    id: viewId,
    experimentId: "exp",
    name: "Live shared view",
    selectedRunIds: ["r1"],
    sections: [
      { id: "metrics", title: "Metrics", collapsed: false, cards: [chart] },
    ],
    updatedAt: 1,
  };
  const counts = () => ({
    catalog: catalogRequests,
    checkpoint: checkpointRequests,
    history: histories.length,
    tail: tails.length,
  });
  const json = (route: Route, body: unknown, code = 200) =>
    route.fulfill({
      status: code,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  await page.addInitScript(() => sessionStorage.setItem("nset.token", "test"));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    if (path === "/api/live") {
      expect(request.headers().authorization).toBe("Bearer test");
      if (request.method() === "GET") {
        checkpointRequests++;
        return json(route, { cursor });
      }
      expect(request.method()).toBe("POST");
      pollBodies.push(request.postDataJSON());
      polls.push(route);
      return;
    }
    if (path === "/api/metrics/tail") {
      expect(request.method()).toBe("POST");
      const body = request.postDataJSON() as {
        series: MetricTailRequest[];
        limit?: number;
      };
      tails.push(body);
      if (failTails)
        return json(route, { error: "temporary tail outage" }, 503);
      return json(route, {
        series: body.series.map((ref) => {
          const snapshot =
            ref.snapshot ?? points.get(ref.key)?.at(-1)?.seq ?? 0;
          return {
            runId: ref.runId,
            key: ref.key,
            points: (points.get(ref.key) ?? []).filter(
              (p) => p.seq > ref.after && p.seq <= snapshot,
            ),
            snapshot,
            next_after: null,
          };
        }),
      });
    }
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${path}`);
      return json(
        route,
        { error: "Live updates must not write workspace state" },
        500,
      );
    }
    if (path === "/api/catalog") {
      catalogRequests++;
      return json(route, {
        experiments: [{ id: "exp", name: "Experiment", created_at: 1 }],
        runs: [
          {
            id: "r1",
            experiment_id: "exp",
            name: "Run one",
            status,
            params: {},
            tags: {},
            created_at: 1,
            updated_at: high,
          },
        ],
        series: [...points].map(([key, values]) => ({
          run_id: "r1",
          key,
          kind: "metric",
          count: values.length,
          last_step: values.at(-1)!.step,
          last_timestamp: values.at(-1)!.timestamp,
          last_value: values.at(-1)!.value,
        })),
        metric_seq: high,
      });
    }
    if (path === "/api/views")
      return json(route, {
        views: [
          {
            id: viewId,
            name: workspace.name,
            experimentId: "exp",
            revision: 1,
            updatedAt: 1,
          },
        ],
      });
    if (path === `/api/views/${viewId}`) {
      if (url.searchParams.get("revision") === "1")
        return route.fulfill({ status: 204 });
      return json(route, { id: viewId, revision: 1, workspace });
    }
    if (path === "/api/runs/r1/metrics") {
      const key = url.searchParams.get("key")!;
      histories.push({ key, after: url.searchParams.get("after") });
      const snapshot = Number(
        url.searchParams.get("snapshot") ?? points.get(key)?.at(-1)?.seq ?? 0,
      );
      const values = (points.get(key) ?? []).filter((p) => p.seq <= snapshot);
      return json(route, {
        points: values,
        snapshot,
        total: values.length,
        next_after: null,
      });
    }
    unexpected.push(`${request.method()} ${path}`);
    return json(route, { error: `Unexpected API: ${path}` }, 404);
  });

  // Install before the app creates timers; leave time running during bootstrap.
  await page.clock.install();
  await page.goto(`/#/views/${encodeURIComponent(viewId)}`);
  await expect(page.locator(".workspace-view-control")).toContainText(
    "Live shared view",
  );
  await expect(page.locator(`${card} canvas`).first()).toBeVisible();
  await expect(page.locator("#connection")).toHaveText("Connected");
  // Pause only after real bootstrap/rendering. Advancing timers never waits 20s
  // of wall time, and each held poll still has the native 25s request timeout.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));

  // Read-only observation of actual production plots, installed AFTER main boot.
  // Wrappers delegate every argument/result; no card/cache/feed implementation
  // is substituted. The first live render exposes the existing uPlot instance.
  await page.evaluate(async () => {
    const { PlotPanel } = await import("/src/plot.ts");
    const state = window as any;
    state.__livePlots = new Set();
    for (const name of ["render", "updateData"] as const) {
      const original = (PlotPanel.prototype as any)[name];
      (PlotPanel.prototype as any)[name] = function (...args: any[]) {
        state.__livePlots.add(this);
        return original.apply(this, args);
      };
    }
    state.__health = [];
    const connection = document.querySelector("#connection")!;
    new MutationObserver(() =>
      state.__health.push({
        text: connection.textContent,
        connected: connection.classList.contains("connected"),
      }),
    ).observe(connection, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });

  async function until<T>(read: () => T | Promise<T>, expected: T) {
    await expect
      .poll(
        async () => {
          await page.clock.runFor(100);
          return read();
        },
        { timeout: 10_000, intervals: [0, 10, 20, 50] },
      )
      .toEqual(expected);
  }
  async function takePoll() {
    await until(() => polls.length > 0, true);
    return polls.shift()!;
  }
  async function respond(changes: LiveChange[] = [], reset = false) {
    const route = await takePoll();
    expect(route.request().postDataJSON()).toEqual({ cursor });
    cursor = `live:${++cursorNumber}`;
    await json(route, { cursor, reset, changes });
    await page.clock.runFor(150);
  }
  function append(selected = keys): LiveChange[] {
    return selected.map((key, i) => {
      const values = points.get(key) ?? [];
      const last: MetricPoint = {
        seq: ++high,
        key,
        step: values.length,
        timestamp: 100 + values.length,
        value: 1000 + high + i,
      };
      values.push(last);
      points.set(key, values);
      return {
        kind: "metric",
        runId: "r1",
        key,
        high: last.seq,
        count: 1,
        last,
      };
    });
  }
  async function plot() {
    return page.evaluate(() => {
      const panels = [...(window as any).__livePlots] as any[];
      const panel = panels.find(
        (p) => p.host.closest('[data-card-id="live-chart"]') && p.chart,
      );
      if (!panel) return null;
      return {
        counts: panel.analyzed.map((d: any) => d.count) as number[],
        lastValues: panel.analyzed.map(
          (d: any) => d.observations.at(-1)?.[1],
        ) as number[],
        statuses: panel.analyzed.map((d: any) => d.run.status) as string[],
        viewport: {
          x: [panel.chart.scales.x.min, panel.chart.scales.x.max],
          y: [panel.chart.scales.y.min, panel.chart.scales.y.max],
        },
      };
    });
  }
  async function hasValues(changes: LiveChange[]) {
    const values = changes.flatMap((c) =>
      c.kind === "metric" ? [c.last.value] : [],
    );
    await until(async () => {
      const state = await plot();
      return values.every((value) => state?.lastValues.includes(value));
    }, true);
  }
  async function unchangedHealth() {
    expect(await page.evaluate(() => (window as any).__health)).not.toEqual([]);
    expect(
      await page.evaluate(() =>
        (window as any).__health.every(
          (s: any) => s.text === "Connected" && s.connected,
        ),
      ),
    ).toBe(true);
    await expect(page.locator("#connection")).toHaveText("Connected");
  }
  return {
    page,
    counts,
    tails,
    histories,
    pollBodies,
    writes,
    unexpected,
    points,
    until,
    takePoll,
    respond,
    append,
    plot,
    hasValues,
    unchangedHealth,
    setStatus(value: string) {
      status = value;
    },
    failTails(value: boolean) {
      failTails = value;
    },
    async failPoll() {
      await json(await takePoll(), { error: "temporary feed outage" }, 503);
      await page.clock.runFor(100);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const test = base.extend<{ live: Fixture }>({
  live: async ({ page }, use) => {
    const live = await fixture(page);
    await use(live);
    expect(live.writes, "feed activity never publishes a server view").toEqual(
      [],
    );
    expect(
      live.unexpected,
      "all traffic uses the declared API contract",
    ).toEqual([]);
  },
});

test("two dozen scalar changes share one tail batch, with no history/catalog refetch", async ({
  live,
}) => {
  const before = live.counts();
  const changes = live.append();
  await live.respond(changes);
  await live.hasValues(changes);
  expect(live.counts()).toEqual({ ...before, tail: before.tail + 1 });
  const batch = live.tails.at(-1)!;
  expect(batch.series).toHaveLength(24);
  expect(batch.series.map((s) => s.key).sort()).toEqual([...keys].sort());
  expect(
    batch.series.every(
      (s) => s.runId === "r1" && s.after === live.points.get(s.key)![1].seq,
    ),
  ).toBe(true);
  expect((await live.plot())!.counts).toEqual(keys.map(() => 3));
  // The acknowledged cursor, not a fresh checkpoint, drives the next poll.
  await live.takePoll();
  expect(live.pollBodies.at(-1)).toEqual({ cursor: "live:1" });
});

test("an initially missing configured series appears without a catalog roundtrip", async ({
  live,
}) => {
  const before = live.counts();
  expect(live.points.has(missingKey)).toBe(false);
  const changes = live.append([missingKey]);
  await live.respond(changes);
  await live.hasValues(changes);
  expect((await live.plot())!.counts).toHaveLength(25);
  expect(live.counts().catalog).toBe(before.catalog);
  // A never-loaded series may need its first history snapshot; existing series
  // must not be reloaded to discover this newly advertised metric.
  expect(
    live.histories.slice(before.history).every((r) => r.key === missingKey),
  ).toBe(true);
});

test("terminal status does not unsubscribe a series before its late final point", async ({
  live,
}) => {
  const initial = live.counts();
  live.setStatus("finished");
  await live.respond([{ kind: "catalog" }]);
  await live.until(() => live.counts().catalog, initial.catalog + 1);
  const before = live.counts();
  const changes = live.append([keys[0]]);
  await live.respond(changes);
  await live.hasValues(changes);
  expect((await live.plot())!.statuses.every((s) => s === "finished")).toBe(
    true,
  );
  expect(live.counts()).toEqual({ ...before, tail: before.tail + 1 });
});

test("live points retain an unsaved shared-view draft, zoom and canvas identity", async ({
  page,
  live,
}) => {
  const first = live.append([keys[0]]);
  await live.respond(first);
  await live.hasValues(first);
  await page.getByLabel("View actions", { exact: true }).click();
  await page.getByRole("button", { name: "Rename view", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rename view", exact: true });
  await dialog.getByLabel("View name").fill("Unsaved live draft");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#view-modified")).toBeVisible();
  const draft = await page.evaluate(
    (key) => localStorage.getItem(key),
    draftKey,
  );
  expect(draft).not.toBeNull();
  const initialViewport = (await live.plot())!.viewport;
  const over = page.locator(`${card} .u-over`);
  await over.hover();
  await page.keyboard.down("Alt");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Alt");
  await live.until(
    async () =>
      JSON.stringify((await live.plot())!.viewport) !==
      JSON.stringify(initialViewport),
    true,
  );
  const zoom = (await live.plot())!.viewport;
  await page.locator(card).evaluate((node) => {
    (window as any).__liveCard = node;
    (window as any).__liveCanvas = node.querySelector("canvas");
  });
  const before = live.counts();
  const changes = live.append();
  await live.respond(changes);
  await live.hasValues(changes);
  expect((await live.plot())!.viewport).toEqual(zoom);
  expect(
    await page
      .locator(card)
      .evaluate(
        (node) =>
          node === (window as any).__liveCard &&
          node.querySelector("canvas") === (window as any).__liveCanvas,
      ),
  ).toBe(true);
  await expect(page.locator(".workspace-view-control")).toContainText(
    "Unsaved live draft",
  );
  await expect(page.locator("#view-modified")).toBeVisible();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
  ).toBe(draft);
  expect(live.counts()).toEqual({ ...before, tail: before.tail + 1 });
});

test("idle heartbeats stay Connected across several long empty responses", async ({
  page,
  live,
}) => {
  const before = live.counts();
  for (let i = 0; i < 4; i++) {
    // Native heartbeat duration is below the client's 25s request deadline.
    await page.clock.fastForward(19_000);
    await live.respond();
    await live.until(() => live.pollBodies.length, i + 2);
  }
  await live.unchangedHealth();
  expect(live.counts()).toEqual(before);
});

test("one failed poll recovers silently without a connection-indicator flicker", async ({
  live,
}) => {
  await live.respond();
  const before = live.counts();
  await live.failPoll();
  await live.respond();
  await live.until(
    async () => live.page.locator("#connection").getAttribute("data-live"),
    "live",
  );
  await live.unchangedHealth();
  expect(live.counts()).toEqual(before);
});

test("sustained failure shows Reconnecting, then an empty feed recovers dirty tails", async ({
  page,
  live,
}) => {
  const changes = live.append([keys[0]]);
  live.failTails(true);
  await live.respond(changes);
  await live.until(() => live.tails.length > 0, true);
  // Feed retries have bounded jitter; advance enough for each held retry, never
  // fabricate a stream of immediate failures that spins the application.
  for (let i = 0; i < 5; i++) {
    await live.failPoll();
    await page.clock.runFor(2000);
  }
  await expect(page.locator("#connection")).toHaveText("Reconnecting…");
  const beforeRecovery = live.counts();
  live.failTails(false);
  await live.respond(); // no replacement hint: the failed tail must stay dirty
  await live.hasValues(changes);
  await live.until(
    async () => page.locator("#connection").textContent(),
    "Connected",
  );
  expect(live.counts().catalog).toBe(beforeRecovery.catalog);
  expect(live.counts().history).toBe(beforeRecovery.history);
  expect(live.counts().tail).toBeGreaterThan(beforeRecovery.tail);
});

test("an expired cursor reset performs a full resync rather than appending stale tails", async ({
  live,
}) => {
  const warmup = live.append([keys[0]]);
  await live.respond(warmup);
  await live.hasValues(warmup);
  const before = live.counts();
  const changes = live.append(); // deliberately no per-series hints
  await live.respond([], true);
  await live.hasValues(changes);
  expect(live.counts().catalog).toBe(before.catalog + 1);
  expect(live.counts().history).toBe(before.history + keys.length);
  expect(live.counts().tail).toBe(before.tail);
  expect((await live.plot())!.counts.sort((a, b) => a - b)).toEqual([
    ...keys.slice(1).map(() => 3),
    4,
  ]);
});

test("hidden tabs pause the feed and resume from the acknowledged cursor", async ({
  page,
  live,
}) => {
  await live.respond();
  const oldPoll = await live.takePoll();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("#connection")).toHaveAttribute(
    "data-live",
    "paused",
  );
  const before = live.counts();
  const pollsBefore = live.pollBodies.length;
  await page.clock.fastForward(30_000);
  expect(live.pollBodies).toHaveLength(pollsBefore);
  expect(live.counts()).toEqual(before);
  // The browser may already have canceled this routed request.
  await oldPoll
    .fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        cursor: "ignored:hidden",
        reset: false,
        changes: [],
      }),
    })
    .catch(() => {});
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const changes = live.append([keys[0]]);
  await live.respond(changes);
  await live.hasValues(changes);
  expect(live.pollBodies.at(-1)?.cursor).toMatch(/^live:/);
  expect(live.counts().checkpoint).toBe(before.checkpoint);
  expect(live.counts().catalog).toBe(before.catalog);
});

test("logout ignores a non-cooperative old response and cannot resurrect data or write a view", async ({
  page,
  live,
}) => {
  // Unlike route.fulfill on an aborted fetch, this really delivers the old body:
  // only the transport ignores AbortSignal; the production generation guard runs.
  await page.evaluate(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input) === "/api/live" && init?.method === "POST")
        return fetch(input, { ...init, signal: undefined });
      return fetch(input, init);
    };
  });
  await live.respond(); // next POST uses the deliberately non-cooperative fetch
  const stale = await live.takePoll();
  const changes = live.append();
  const before = live.counts();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.locator("#login-dialog")).toBeVisible();
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/live") && r.request().method() === "POST",
  );
  await stale.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ cursor: "stale:logout", reset: true, changes }),
  });
  await response;
  await page.clock.runFor(1500);
  await expect(page.locator("#connection")).toHaveText("Disconnected");
  await expect(page.locator("#page")).toBeEmpty();
  expect(
    await page.evaluate(() => sessionStorage.getItem("nset.token")),
  ).toBeNull();
  expect(live.counts()).toEqual(before);
});
