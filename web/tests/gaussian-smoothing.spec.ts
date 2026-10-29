import { expect, test, type Page } from "@playwright/test";

type Point = { seq: number; step: number; timestamp: number; value: number };
type XY = [number, number];
type Curve = {
  id: string;
  y: Point[];
  x?: Point[];
  config?: Record<string, unknown>;
  paired?: XY[];
};
const ORIGIN = 1_700_000_000_000;
const samples = (steps: number[], values: number[]): Point[] =>
  steps.map((step, i) => ({
    seq: i + 1,
    step,
    timestamp: ORIGIN + i * 1000,
    value: values[i],
  }));

/** Real cards, native MetricStore/Api, analysis and uPlot. Only transport is fixed. */
async function fixture(page: Page, curves: Curve[]) {
  await page.setViewportSize({ width: 1400, height: 1100 });
  await page.route("**/__gaussian_fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/__gaussian_fixture");
  await page.evaluate(
    async ({ curves, origin }) => {
      const { ChartCard } = await import("/src/cards.ts");
      const { newChart } = await import("/src/workspace.ts");
      const { Api } = await import("/src/api.ts");
      const { MetricStore } = await import("/src/catalog.ts");
      document.body.style.cssText =
        "margin:16px;background:#202429;color:#ddd;font:14px system-ui";
      const grid = document.createElement("main");
      grid.style.cssText =
        "display:grid;grid-template-columns:repeat(2,620px);gap:16px";
      document.body.append(grid);
      const run = {
        id: "r",
        name: "Gaussian fixture",
        experiment_id: "e",
        status: "running",
        params: {},
        tags: {},
        created_at: origin,
        updated_at: origin,
        rx: { sourceId: "rx:test", uid: "r", state: "running" },
      };
      const histories: Record<string, any[]> = {};
      for (const curve of curves) {
        histories[`${curve.id}:y`] = curve.y;
        if (curve.x) histories[`${curve.id}:x`] = curve.x;
      }
      const catalog = {
        experiments: [],
        runs: [run],
        series: Object.entries(histories).map(([key, points]) => ({
          run_id: "r",
          key,
          kind: "metric",
          count: points.length,
          last_step: points.at(-1)?.step ?? 0,
          last_timestamp: points.at(-1)?.timestamp ?? origin,
          last_value: points.at(-1)?.value ?? 0,
        })),
        rx: { id: "rx:test", name: "fixture" },
      };
      const s: any = {
        histories,
        tails: {},
        requests: [],
        cards: {},
        defaults: structuredClone(newChart("timeseries", []).config),
      };
      const api = new Api(
        () => "fixture",
        async (path: string, init: RequestInit) => {
          const url = new URL(path, location.href);
          const body = init.body ? JSON.parse(String(init.body)) : null;
          s.requests.push({
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            body,
          });
          if (url.pathname.endsWith("/metrics")) {
            const points = histories[url.searchParams.get("key")!] ?? [];
            return Response.json({
              points,
              total: points.length,
              snapshot: Math.max(0, ...points.map((p: any) => p.seq)),
              next_after: null,
            });
          }
          if (url.pathname.endsWith("/metrics/tail"))
            return Response.json({
              series: body.series.map((ref: any) => {
                const points = (s.tails[ref.key] ?? []).filter(
                  (p: any) => p.seq > ref.after,
                );
                return {
                  runId: ref.runId,
                  key: ref.key,
                  points,
                  snapshot: Math.max(
                    ref.after,
                    ...points.map((p: any) => p.seq),
                  ),
                  next_after: null,
                };
              }),
            });
          if (url.pathname.endsWith("/rx/plot")) {
            const curve = curves.find((c) => c.id === body.ys[0])!;
            const points = curve.paired!;
            return Response.json({
              traces: [{ run_uid: "r", y: curve.id, group: null, points }],
              next_cursor: null,
              diagnostics: {
                scanned: points.length,
                matched: points.length,
                points: points.length,
                bytes: 100,
                invalid_json: 0,
                oversized: 0,
                skipped_axes: 0,
                skipped_groups: 0,
                omitted_traces: 0,
                partial: false,
                reasons: [],
              },
            });
          }
          throw Error(`Unexpected API path ${path}`);
        },
      );
      s.store = new MetricStore(api);
      const context = { api, catalog, selectedRunIds: ["r"], store: s.store };
      const actions = Object.fromEntries(
        [
          "onEdit",
          "onRemove",
          "onDuplicate",
          "onMove",
          "onResize",
          "onDimensions",
        ].map((name) => [name, () => {}]),
      );
      s.mount = (spec: any, store = s.store) => {
        const host = document.createElement("div");
        host.style.width = "620px";
        grid.append(host);
        const card = new ChartCard(
          host,
          spec,
          { ...context, store } as any,
          actions as any,
        );
        s.cards[spec.id] = card;
        return card;
      };
      s.fresh = (id: string) => {
        const spec = structuredClone(s.cards[id].spec);
        spec.id = `${id}-fresh`;
        s.freshStore = new MetricStore(api);
        s.mount(spec, s.freshStore);
      };
      for (const curve of curves) {
        const spec = newChart("timeseries", [`${curve.id}:y`], curve.id);
        spec.id = curve.id;
        spec.layout = { width: 620, height: 420 };
        Object.assign(
          spec.config,
          { smoothing: true, smoothingSigma: 1 },
          curve.config,
        );
        spec.config.style.path = "linear";
        spec.config.style.points = true;
        if (curve.x)
          spec.x = {
            mode: "series",
            series: { runId: "r", key: `${curve.id}:x`, kind: "metric" },
          };
        if (curve.paired)
          spec.records = {
            sourceId: "rx:test",
            runUids: ["r"],
            x: "coordinate",
            ys: [curve.id],
            filters: { any: false, conditions: [] },
          };
        s.mount(spec);
      }
      (window as any).gaussian = s;
    },
    { curves, origin: ORIGIN },
  );
  for (const curve of curves)
    await expect(
      page.locator(`[data-card-id="${curve.id}"] .u-over`),
    ).toBeVisible();
  // Initial ResizeObserver/IntersectionObserver deliveries are not the behavior under test.
  await page.waitForTimeout(150);
}

async function read(page: Page, id: string) {
  return page.evaluate((id) => {
    const c = (window as any).gaussian.cards[id];
    const d = c.data[0],
      u = c.plot.chart;
    return {
      points: d.points as XY[],
      observations: d.observations as XY[],
      count: d.count,
      markers: u.data[0].flatMap((x: number, i: number) =>
        u.data[2][i] == null ? [] : [[x, u.data[2][i]]],
      ) as XY[],
      markersShown: u.series[2].show,
    };
  }, id);
}
async function edit(page: Page, id: string, config: Record<string, unknown>) {
  await page.evaluate(
    ({ id, config }) => {
      const card = (window as any).gaussian.cards[id];
      const next = structuredClone(card.spec);
      Object.assign(next.config, config);
      card.setSpec(next);
    },
    { id, config },
  );
}
function expectValues(actual: XY[], expected: XY[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((point, i) => expect(point[1]).toBeCloseTo(expected[i][1], 7));
}

// For a symmetric five-point impulse, the local-linear slope is zero at the
// center. This closed-form expectation is independent of production smoothing.
const centerWeight = (sigma: number) =>
  1 / (1 + 2 * Math.exp(-0.5 / sigma ** 2) + 2 * Math.exp(-2 / sigma ** 2));

test("sigma changes dense curves, not isolated points, and retains raw marker values", async ({
  page,
}) => {
  const values = [0, 0, 0, 0, 100, 0, 0, 0, 0];
  const dense = samples(
    values.map((_, i) => i),
    values,
  );
  const sparse = samples(
    values.map((_, i) => i * 100),
    values,
  );
  await fixture(page, [
    { id: "dense", y: dense, config: { smoothingSigma: 0.5 } },
    { id: "sparse", y: sparse, config: { smoothingSigma: 0.5 } },
  ]);
  expect(
    await page.evaluate(() => (window as any).gaussian.defaults.smoothingSigma),
  ).toBe(1);
  const before = await read(page, "dense");
  const isolated = await read(page, "sparse");
  expect(isolated.points).toEqual(sparse.map((p) => [p.step, p.value]));
  expect(before.points[4][1]).toBeLessThan(100);
  await edit(page, "dense", { smoothingSigma: 1 });
  await edit(page, "sparse", { smoothingSigma: 1 });
  await expect
    .poll(async () => (await read(page, "dense")).points[4][1])
    .toBeLessThan(before.points[4][1] - 10);
  const after = await read(page, "dense");
  expect(after.observations).toEqual(dense.map((p) => [p.step, p.value]));
  expect(after.markers).toEqual(after.observations);
  expect(after.markersShown).toBe(true);
  expect(after.count).toBe(dense.length);
  expect((await read(page, "sparse")).points).toEqual(
    sparse.map((p) => [p.step, p.value]),
  );
  await edit(page, "dense", { smoothing: false });
  expect((await read(page, "dense")).points).toEqual(after.observations);
});

test("log equivalent-step sigma scales with raw X while preserving transformed smoothing", async ({
  page,
}) => {
  const steps = [1, 10, 100, 1000, 10000],
    values = [0, 0, 20, 0, 0];
  const sigma = 2500;
  // Independent equivalent-unit definition, not the production mapping helper.
  const transformedSigma =
    (sigma * (Math.log10(10000) - Math.log10(1))) / (10000 - 1);
  await fixture(page, [
    {
      id: "log",
      y: samples(steps, values),
      config: { xScale: "log", smoothingSigma: sigma },
    },
    {
      id: "shifted",
      y: samples(
        steps.map((x) => x * 100),
        values,
      ),
      config: { xScale: "log", smoothingSigma: sigma * 100 },
    },
    {
      id: "relative-log",
      y: samples(steps, values).map((p) => ({
        ...p,
        timestamp: ORIGIN + p.step * 1000,
      })),
      config: { axis: "relative", xScale: "log", smoothingSigma: sigma },
    },
    { id: "linear", y: samples(steps, values) },
  ]);
  const log = await read(page, "log"),
    shifted = await read(page, "shifted");
  expectValues(shifted.points, log.points);
  const relative = await read(page, "relative-log");
  expectValues(relative.points, log.points);
  expect(relative.points.map((p) => p[0])).toEqual(steps.map((x) => x * 1000));
  expect(log.points[2][1]).toBeCloseTo(20 * centerWeight(transformedSigma), 7);
  expect((await read(page, "linear")).points[2][1]).toBe(20);
  expect(shifted.points.map((p) => p[0])).toEqual(steps.map((x) => x * 100));
});

test("linear wall and relative time bandwidths use seconds, not stored milliseconds", async ({
  page,
}) => {
  const y = samples([0, 1, 2, 3, 4], [0, 0, 20, 0, 0]);
  await fixture(page, [
    { id: "step", y },
    { id: "wall", y, config: { axis: "timestamp" } },
    { id: "relative", y, config: { axis: "relative" } },
  ]);
  const step = await read(page, "step"),
    wall = await read(page, "wall"),
    relative = await read(page, "relative");
  expectValues(wall.points, step.points);
  expectValues(relative.points, step.points);
  expect(wall.points[2][1]).toBeCloseTo(20 * centerWeight(1), 7);
  expect(wall.observations.map((p) => p[0])).toEqual(y.map((p) => p.timestamp));
  expect(relative.observations.map((p) => p[0])).toEqual([
    0, 1000, 2000, 3000, 4000,
  ]);
});

test("XY smooths both scalar channels on the common log axis before joining, never metric X", async ({
  page,
}) => {
  const steps = [1, 10, 100, 1000, 10000];
  const x = samples(steps, [10, 10, 100, 10, 10]);
  const y = samples(steps, [0, 0, 20, 0, 0]);
  const sigma = 2500;
  const transformedSigma =
    (sigma * (Math.log10(10000) - Math.log10(1))) / (10000 - 1);
  const config = { joinScale: "log", joinLog: 10, smoothingSigma: sigma };
  await fixture(page, [
    { id: "xy", x, y, config },
    { id: "metric-log", x, y, config: { ...config, xScale: "log" } },
    {
      id: "scaled-x",
      y,
      x: x.map((p) => ({ ...p, value: p.value * 1000 })),
      config,
    },
  ]);
  const xy = await read(page, "xy"),
    metricLog = await read(page, "metric-log");
  expect(xy.points).toHaveLength(5);
  expect(xy.points[2][0]).toBeCloseTo(
    10 + 90 * centerWeight(transformedSigma),
    7,
  );
  expect(xy.points[2][1]).toBeCloseTo(20 * centerWeight(transformedSigma), 7);
  expect(metricLog.points).toEqual(xy.points);
  expect(xy.observations).toEqual(x.map((p, i) => [p.value, y[i].value]));
  expect(xy.markers).toEqual([...xy.observations].sort((a, b) => a[0] - b[0]));
  expect(xy.markersShown).toBe(true);
  // A wider numeric range of displayed metric X cannot alter smoothing either.
  const scaled = await read(page, "scaled-x");
  expectValues(scaled.points, xy.points);
  scaled.points.forEach((p, i) =>
    expect(p[0]).toBeCloseTo(xy.points[i][0] * 1000, 6),
  );
});

test("asinh equivalent-step sigma uses the full raw and transformed spans", async ({
  page,
}) => {
  const steps = [-2, -1, 0, 1, 2].map((x) => Math.sinh(x));
  const sigma = 2;
  const transformedSigma =
    (sigma * (Math.asinh(steps[4]) - Math.asinh(steps[0]))) /
    (steps[4] - steps[0]);
  await fixture(page, [
    {
      id: "asinh",
      y: samples(steps, [0, 0, 20, 0, 0]),
      config: { xScale: "asinh", smoothingSigma: sigma },
    },
  ]);
  const curve = await read(page, "asinh");
  expect(curve.points[2][1]).toBeCloseTo(
    20 * centerWeight(transformedSigma),
    7,
  );
  expect(curve.observations).toEqual(
    steps.map((x, i) => [x, i === 2 ? 20 : 0]),
  );
  expect(curve.markers).toEqual(curve.observations);
  // Zooming must never shrink the data domain used to map the bandwidth.
  await page.evaluate(() => (window as any).gaussian.cards.asinh.plot.zoom(2));
  await edit(page, "asinh", { smoothing: false });
  await edit(page, "asinh", { smoothing: true });
  expectValues((await read(page, "asinh")).points, curve.points);
});

test("XY equivalent sigma shares the full channel domain before overlap and join", async ({
  page,
}) => {
  const xSteps = [1, 10, 100, 1000, 10000];
  const ySteps = [10, 100, 1000];
  const sigma = 2500;
  // The X-only endpoints belong to the common smoothing domain even though
  // they are outside the eventual XY overlap. Y must not normalize itself.
  const transformedSigma =
    (sigma * (Math.log10(10000) - Math.log10(1))) / (10000 - 1);
  await fixture(page, [
    {
      id: "unequal-xy",
      x: samples(xSteps, [10, 10, 100, 10, 10]),
      y: samples(ySteps, [0, 20, 0]),
      config: { joinScale: "log", smoothingSigma: sigma },
    },
  ]);
  const curve = await read(page, "unequal-xy");
  expect(curve.points).toHaveLength(3);
  expect(curve.points[1][0]).toBeCloseTo(
    10 + 90 * centerWeight(transformedSigma),
    7,
  );
  const yWeight = 1 / (1 + 2 * Math.exp(-0.5 / transformedSigma ** 2));
  expect(curve.points[1][1]).toBeCloseTo(20 * yWeight, 7);
  expect(curve.observations).toEqual([
    [10, 0],
    [100, 20],
    [10, 0],
  ]);
});
test("equivalent sigma uses one full-data domain across every chart series", async ({
  page,
}) => {
  const sigma = 2500;
  const transformedSigma =
    (sigma * (Math.log10(10000) - Math.log10(1))) / (10000 - 1);
  await fixture(page, [
    {
      id: "narrow",
      y: samples([10, 100, 1000], [0, 20, 0]),
      config: { xScale: "log", smoothingSigma: sigma },
    },
    {
      id: "wide",
      y: samples([1, 10, 100, 1000, 10000], [0, 0, 20, 0, 0]),
      config: { xScale: "log", smoothingSigma: sigma },
    },
  ]);
  await page.evaluate(() => {
    const card = (window as any).gaussian.cards.narrow;
    const spec = structuredClone(card.spec);
    spec.source = { mode: "selected", keys: ["narrow:y", "wide:y"] };
    card.setSpec(spec);
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).gaussian.cards.narrow.data.length),
    )
    .toBe(2);
  const curves = await page.evaluate(() =>
    (window as any).gaussian.cards.narrow.data.map(
      (trace: any) => trace.points as XY[],
    ),
  );
  const narrow = curves.find((points: XY[]) => points.length === 3)!;
  const wide = curves.find((points: XY[]) => points.length === 5)!;
  expect(narrow[1][1]).toBeCloseTo(
    20 / (1 + 2 * Math.exp(-0.5 / transformedSigma ** 2)),
    7,
  );
  expect(wide[2][1]).toBeCloseTo(20 * centerWeight(transformedSigma), 7);
});
test("paired record curves without a common coordinate stay raw, including repeated X", async ({
  page,
}) => {
  const paired: XY[] = [
    [1, 0],
    [2, 0],
    [3, 20],
    [2, 8],
    [4, 0],
  ];
  await fixture(page, [
    { id: "paired", y: [], paired, config: { smoothingSigma: 10 } },
  ]);
  const before = await read(page, "paired");
  expect(before.points).toEqual(paired);
  expect(before.observations).toEqual(paired);
  expect(before.markers).toEqual([...paired].sort((a, b) => a[0] - b[0]));
  expect(before.markersShown).toBe(true);
  await expect(
    page.locator('[data-card-id="paired"] .card-series-note'),
  ).toHaveText("Unsmoothed: no common step/time coordinate");
  await edit(page, "paired", {
    smoothingSigma: 0.1,
    joinScale: "asinh",
    joinAsinh: 2,
  });
  expect((await read(page, "paired")).points).toEqual(paired);
  expect(
    await page.evaluate(() =>
      (window as any).gaussian.requests.map((r: any) => r.path),
    ),
  ).toEqual(["/api/rx/plot"]);
});

test("cached sigma and join-coordinate edits retain canvas, camera, cursors and Back history without refetch", async ({
  page,
}) => {
  const steps = [1, 2, 3, 4, 5];
  await fixture(page, [
    {
      id: "cached",
      y: samples(steps, [0, 0, 20, 0, 0]),
      x: samples(steps, [10, 10, 100, 10, 10]),
    },
  ]);
  const before = await page.evaluate(() => {
    const s = (window as any).gaussian,
      c = s.cards.cached;
    c.plot.zoom(1.5);
    c.setPin("a", 30);
    c.setPin("yB", 5);
    s.saved = {
      chart: c.plot.chart,
      canvas: c.plot.chart.ctx.canvas,
      navigation: c.plot.navigation,
    };
    return {
      view: c.plot.viewport(),
      pins: structuredClone(c.pins),
      history: c.plot.navigation.snapshot().history,
      requests: s.requests.length,
    };
  });
  let previous = (await read(page, "cached")).points;
  for (const patch of [
    { smoothingSigma: 0.5 },
    { smoothing: false },
    { smoothing: true },
    { joinScale: "log" },
    { joinLog: 2 },
    { joinScale: "asinh" },
    { joinAsinh: 2 },
  ]) {
    await edit(page, "cached", patch);
    const current = (await read(page, "cached")).points;
    if ("joinLog" in patch) {
      // Changing log base rescales both distances and mapped sigma equally.
      expectValues(current, previous);
      current.forEach((point, i) =>
        expect(point[0]).toBeCloseTo(previous[i][0], 7),
      );
    } else {
      expect(current).not.toEqual(previous);
    }
    previous = current;
    expect(
      await page.evaluate(() => {
        const s = (window as any).gaussian,
          c = s.cards.cached;
        return {
          same:
            c.plot.chart === s.saved.chart &&
            c.plot.chart.ctx.canvas === s.saved.canvas &&
            c.plot.navigation === s.saved.navigation,
          view: c.plot.viewport(),
          pins: c.pins,
          history: c.plot.navigation.snapshot().history,
          requests: s.requests.length,
        };
      }),
    ).toEqual({ same: true, ...before });
  }
});

test("native latest-per-step tails replace old steps across timestamps and match a fresh history", async ({
  page,
}) => {
  const initial = samples([1, 2, 3], [10, 20, 30]).map((p) => ({
    ...p,
    timestamp: p.timestamp + 1000,
  }));
  await fixture(page, [
    { id: "live", y: initial, config: { axis: "timestamp", smoothing: false } },
  ]);
  expect((await read(page, "live")).points).toEqual(
    initial.map((p) => [p.timestamp, p.value]),
  );
  const correction = { seq: 5, step: 1, timestamp: ORIGIN + 500, value: 2 };
  await page.evaluate(
    ({ initial, correction }) => {
      const s = (window as any).gaussian;
      // Fixed server projection: seq 5 wins step 1 even though its timestamp and
      // value are smaller. The browser must replace, not append a new time knot.
      s.histories["live:y"] = [initial[1], initial[2], correction];
      s.tails["live:y"] = [correction];
      s.store.markDirty([{ runId: "r", key: "live:y", kind: "metric" }]);
    },
    { initial, correction },
  );
  const expected = [
    [correction.timestamp, 2],
    [initial[1].timestamp, 20],
    [initial[2].timestamp, 30],
  ];
  await expect
    .poll(async () => (await read(page, "live")).points)
    .toEqual(expected);
  const updated = await read(page, "live");
  expect(updated.count).toBe(3);
  expect(updated.markers).toEqual(expected);
  const requests = await page.evaluate(() => (window as any).gaussian.requests);
  const histories = requests.filter((r: any) => r.path.endsWith("/metrics"));
  expect(histories).toHaveLength(1);
  expect(histories[0].query.policy).toBe("latest-per-step");
  const tails = requests.filter((r: any) => r.path.endsWith("/metrics/tail"));
  expect(tails).toHaveLength(1);
  expect(tails[0].body.series).toEqual([
    { runId: "r", key: "live:y", after: 3, policy: "latest-per-step" },
  ]);
  await edit(page, "live", { smoothing: true, smoothingSigma: 2 });
  const smoothed = await read(page, "live");
  expect(smoothed.points).not.toEqual(updated.points);
  await page.evaluate(() => (window as any).gaussian.fresh("live"));
  await expect(
    page.locator('[data-card-id="live-fresh"] .u-over'),
  ).toBeVisible();
  expect(await read(page, "live-fresh")).toEqual(smoothed);
  expect(
    await page.evaluate(() =>
      (window as any).gaussian.requests
        .filter((r: any) => r.path.endsWith("/metrics"))
        .map((r: any) => r.query.policy),
    ),
  ).toEqual(["latest-per-step", "latest-per-step"]);
});
