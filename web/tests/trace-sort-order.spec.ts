import { expect, test, type Page } from "@playwright/test";

async function fixture(
  page: Page,
  explicit = false,
  records?: { grouped: boolean },
) {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.route(/^http:\/\/127\.0\.0\.1:[0-9]+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/");
  await page.evaluate(
    async ({ explicit, records }) => {
      const { ChartCard } = await import("/src/cards.ts");
      const { newChart } = await import("/src/workspace.ts");
      const { sortedRunIds } = await import("/src/trace-order.ts");
      const runs = ["b", "a", "c", "external"].map((id) => ({
        id,
        name: `Run ${id}`,
        experiment_id: id === "external" ? "other" : "e",
        status: "finished",
        params: {},
        tags: {},
        created_at: 1,
        updated_at: 1,
        ...(records
          ? { rx: { sourceId: "rx:records", uid: `uid-${id}` } }
          : {}),
      }));
      const catalog = {
        experiments: [],
        runs,
        series: runs.flatMap((run) =>
          ["loss", "accuracy"].map((key) => ({
            run_id: run.id,
            key,
            kind: "metric",
            count: 3,
            last_step: 2,
            last_timestamp: 2,
            last_value: run.id === "a" ? 1 : run.id === "b" ? 2 : 3,
          })),
        ),
      };
      const spec = newChart(
        "timeseries",
        ["loss", "accuracy"],
        "Trace ordering",
      );
      spec.layout = { width: 720, height: 480 };
      spec.config.style.path = "linear";
      spec.config.style.width = 6;
      spec.config.style.points = true;
      if (records)
        spec.records = {
          sourceId: "rx:records",
          runUids: [],
          x: "step",
          ys: ["loss", "accuracy"],
          filters: { any: false, conditions: [] },
          ...(records.grouped ? { group: "phase" } : {}),
        };
      if (explicit)
        spec.source = {
          mode: "explicit",
          series: [
            { runId: "a", key: "loss", kind: "metric" },
            { runId: "external", key: "accuracy", kind: "metric" },
            { runId: "c", key: "loss", kind: "metric" },
            { runId: "external", key: "loss", kind: "metric" },
            { runId: "a", key: "accuracy", kind: "metric" },
          ],
        };
      const s: any = { catalog, loads: 0, writes: 0, actions: 0 };
      const context = {
        api: {
          async post(path: string, request: any) {
            if (!records || path !== "/rx/plot")
              throw Error("Unexpected request");
            s.loads++;
            return {
              next_cursor: null,
              diagnostics: {
                scanned: 9,
                matched: 9,
                bytes: 0,
                invalid_json: 0,
                oversized: 0,
                skipped_axes: 0,
                skipped_groups: 0,
                omitted_traces: 0,
                points: 18,
                partial: false,
                reasons: [],
              },
              traces: request.runs.flatMap((uid: string) =>
                request.ys.flatMap((y: string) =>
                  (records.grouped ? ["train", "eval"] : [null]).map(
                    (group) => ({
                      // Match backend IDs, including both null fields when ungrouped.
                      id: JSON.stringify([
                        request.source_id,
                        uid,
                        y,
                        request.group,
                        group,
                      ]),
                      run_uid: uid,
                      y,
                      group,
                      group_label: group,
                      points: [0, 1, 2].map((x) => [x, 1, String(x + 1)]),
                    }),
                  ),
                ),
              ),
            };
          },
        },
        catalog,
        selectedRunIds: explicit ? ["b"] : ["a", "b", "c"],
        store: {
          clear() {
            throw Error("must not clear cache");
          },
          async load() {
            if (records) throw Error("records must use loadRecordPlot");
            s.loads++;
            return [0, 1, 2].map((step) => ({
              seq: step + 1,
              step,
              timestamp: step,
              value: 1,
            }));
          },
        },
      };
      const host = document.createElement("main");
      host.style.cssText = "width:720px;margin:16px";
      document.body.append(host);
      const actions = Object.fromEntries(
        [
          "onEdit",
          "onRemove",
          "onMove",
          "onDuplicate",
          "onResize",
          "onDimensions",
        ].map((key) => [key, () => s.actions++]),
      );
      s.card = new ChartCard(host, spec, context, actions);
      s.context = context;
      s.originalSpec = JSON.stringify(spec);
      s.sort = (sort: string, descending = false) => {
        s.card.setRunOrder(
          sortedRunIds(
            catalog.runs.filter((run) => run.experiment_id === "e"),
            catalog.series,
            { sort, descending },
          ),
        );
      };
      s.sort("name");
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (...args: [string, string]) {
        s.writes++;
        return setItem.apply(this, args);
      };
      (window as any).traceOrder = s;
    },
    { explicit, records },
  );
  await expect(page.locator(".u-over")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).traceOrder.card.data.length),
    )
    .toBe(records?.grouped ? 12 : explicit ? 5 : 6);
  await page.evaluate(() => {
    const s = (window as any).traceOrder;
    // The test's lookup must not depend on catalog placeholders after an update.
    s.loadedSources = [...s.card.sources];
  });
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const s = (window as any).traceOrder,
      c = s.card,
      p = c.plot,
      u = p.chart;
    const source = new Map(
      s.loadedSources.map((value: any) => [value.id, value]),
    );
    const physical = (index: number) => p.seriesSlots[index] * 2 + 1;
    const logical = (index: number) =>
      p.seriesSlots.indexOf(Math.floor((index - 1) / 2));
    const paint: string[] = [];
    const paintIds: string[] = [];
    const hook = (_u: any, index: number) => {
      const id = c.data[logical(index)].run.id;
      const item: any = source.get(id);
      paintIds.push(id);
      paint.push(`${item.runId}/${item.key}${index % 2 ? "" : ":raw"}`);
    };
    (u.hooks.drawSeries ??= []).push(hook);
    u.batch(() => u.redraw(false));
    u.hooks.drawSeries.pop();
    return {
      paint,
      paintIds,
      legend: [
        ...document.querySelectorAll<HTMLElement>(".card-legend-item"),
      ].map((node) => node.dataset.seriesId),
      nativeLegend: [...u.root.querySelectorAll(".u-legend .u-label")].map(
        (node: any) => node.textContent,
      ),
      colors: c.data.map((_d: any, index: number) => p.seriesColor(index)),
      visibility: c.data.map((_d: any, index: number) => [
        u.series[physical(index)].show,
        u.series[physical(index) + 1].show,
      ]),
      view: p.viewport(),
      history: p.navigation.snapshot(),
      pins: p.pins,
      logical: c.data.map((d: any) => d.run.id),
      selected: c.context.selectedRunIds,
      loads: s.loads,
      writes: s.writes,
      actions: s.actions,
      sameSpec: s.originalSpec === JSON.stringify(c.spec),
      cached: !s.raw || (s.raw === c.raw && s.data === c.data),
    };
  });
}

for (const grouped of [false, true]) {
  test(`${grouped ? "grouped" : "ungrouped"} loaded record traces retain sorted stacking across catalog hints`, async ({
    page,
  }) => {
    await fixture(page, false, { grouped });
    const expectedPaint = (runs: string[]) =>
      runs.flatMap((run) =>
        ["loss", "accuracy"].flatMap((key) =>
          (grouped ? ["train", "eval"] : [null]).flatMap((group) => {
            const id = JSON.stringify([
              "rx:records",
              `uid-${run}`,
              key,
              grouped ? "phase" : null,
              group,
            ]);
            return [id, id]; // Trace followed immediately by raw observations.
          }),
        ),
      );
    const initial = await snapshot(page);
    expect(initial.paintIds).toEqual(expectedPaint(["c", "b", "a"]));
    await page.evaluate(() => {
      const s = (window as any).traceOrder;
      s.raw = s.card.raw;
      s.data = s.card.data;
      s.card.plot.zoom(2);
      s.card.plot.setPins({ a: 0.5, b: 1.5, threshold: 1 });
      s.sort("name", true);
    });
    const sorted = await snapshot(page);
    expect(sorted.paintIds).toEqual(expectedPaint(["a", "b", "c"]));
    expect(sorted.legend).toEqual(initial.legend);
    expect(sorted.nativeLegend).toEqual(initial.nativeLegend);
    expect(sorted.cached).toBe(true);
    expect(sorted.loads).toBe(1);

    for (const updateMetadata of [false, true]) {
      await page.evaluate((updateMetadata) => {
        const s = (window as any).traceOrder;
        if (updateMetadata) {
          s.card.updateCatalog({
            ...s.catalog,
            series: s.catalog.series.map((series: any) =>
              series.run_id === "external"
                ? { ...series, last_value: 99, last_timestamp: 3 }
                : series,
            ),
          });
        }
        s.sort("name", true);
      }, updateMetadata);
      const after = await snapshot(page);
      expect(after.paintIds).toEqual(sorted.paintIds);
      for (const key of [
        "legend",
        "nativeLegend",
        "colors",
        "visibility",
        "view",
        "history",
        "pins",
        "logical",
        "selected",
        "loads",
        "writes",
        "actions",
      ] as const)
        expect(after[key], key).toEqual(sorted[key]);
      expect(after.cached).toBe(true);
      expect(after.sameSpec).toBe(true);
    }
    // Ensure this exercised backend identities, not the resolveSources placeholders.
    expect(
      await page.evaluate(() => {
        const c = (window as any).traceOrder.card;
        return c.sources.every(
          (source: any) =>
            !c.data.some((series: any) => series.run.id === source.id),
        );
      }),
    ).toBe(true);
  });
}
test("top sorted run paints last; logical legends/colors and cached interaction state survive", async ({
  page,
}) => {
  await fixture(page);
  const initial = await snapshot(page);
  expect(
    initial.paint
      .filter((id) => !id.endsWith(":raw"))
      .map((id) => id.split("/")[0]),
  ).toEqual(["c", "c", "b", "b", "a", "a"]);
  await page.evaluate(() => {
    const s = (window as any).traceOrder,
      c = s.card,
      p = c.plot;
    s.raw = c.raw;
    s.data = c.data;
    p.zoom(2);
    p.setPins({ a: 0.5, b: 1.5, threshold: 1 });
    const first = p.seriesSlots[2] * 2 + 1;
    p.chart.batch(() => {
      p.chart.setSeries(first, { show: false });
      p.chart.setSeries(first + 1, { show: false });
    });
  });
  const before = await snapshot(page);
  await page.evaluate(() => (window as any).traceOrder.sort("name", true));
  const after = await snapshot(page);
  expect(after.paint.at(-1)).toBe("c/accuracy:raw");
  for (const key of [
    "legend",
    "nativeLegend",
    "colors",
    "visibility",
    "view",
    "history",
    "pins",
    "logical",
    "selected",
    "loads",
    "writes",
    "actions",
  ] as const)
    expect(after[key], key).toEqual(before[key]);
  expect(after.cached).toBe(true);
  expect(after.sameSpec).toBe(true);
  // Color refresh must still address logical sources after the physical permutation.
  await page.evaluate(() => (window as any).traceOrder.card.refreshColors());
  expect((await snapshot(page)).colors).toEqual(before.colors);
});

test("live metric summaries and stable ties reorder cached traces", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => (window as any).traceOrder.sort("metric:loss"));
  const before = await snapshot(page);
  expect(before.paint.at(-1)).toBe("a/accuracy:raw");
  await page.evaluate(() => {
    const s = (window as any).traceOrder;
    s.catalog.series.find(
      (v: any) => v.run_id === "a" && v.key === "loss",
    ).last_value = 4;
    s.card.updateCatalog(s.catalog);
    s.sort("metric:loss");
  });
  const after = await snapshot(page);
  expect(after.paint.at(-1)).toBe("b/accuracy:raw");
  expect(after.loads).toBe(before.loads);
  expect(after.selected).toEqual(before.selected);
  await page.evaluate(() =>
    (window as any).traceOrder.sort("created_at", true),
  );
  expect((await snapshot(page)).paint.at(-1)).toBe("b/accuracy:raw");
  await page.evaluate(() =>
    (window as any).traceOrder.sort("created_at", false),
  );
  expect((await snapshot(page)).paint.at(-1)).toBe("b/accuracy:raw");
});

test("explicit charts follow run ranks outside selection with stable unmatched fallback", async ({
  page,
}) => {
  await fixture(page, true);
  const before = await snapshot(page);
  expect(before.paint.filter((id) => !id.endsWith(":raw"))).toEqual([
    "external/accuracy",
    "external/loss",
    "c/loss",
    "a/loss",
    "a/accuracy",
  ]);
  await page.evaluate(() => (window as any).traceOrder.sort("name", true));
  const after = await snapshot(page);
  expect(after.paint.filter((id) => !id.endsWith(":raw"))).toEqual([
    "external/accuracy",
    "external/loss",
    "a/loss",
    "a/accuracy",
    "c/loss",
  ]);
  expect(after.legend).toEqual(before.legend);
  expect(after.colors).toEqual(before.colors);
  expect(after.loads).toBe(before.loads);
  expect(after.selected).toEqual(["b"]);
});

test("table sort controls suspended dashboard draw order on resume without history requests", async ({
  page,
}) => {
  let loads = 0;
  const runs = ["a", "b", "c"].map((id, index) => ({
    id,
    name: `Run ${id}`,
    experiment_id: "e",
    status: "finished",
    params: {},
    tags: {},
    created_at: index,
    updated_at: index,
  }));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/catalog")
      return route.fulfill({
        json: {
          experiments: [{ id: "e", name: "Ordering", created_at: 0 }],
          runs,
          series: runs.map((run) => ({
            run_id: run.id,
            key: "loss",
            kind: "metric",
            count: 3,
            last_step: 2,
            last_timestamp: 2,
            last_value: 1,
          })),
        },
      });
    if (path.endsWith("/metrics")) {
      loads++;
      return route.fulfill({
        json: {
          points: [0, 1, 2].map((step) => ({
            seq: step + 1,
            step,
            timestamp: step,
            value: 1,
          })),
          total: 3,
          snapshot: 3,
          next_after: null,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const { PlotPanel } = await import("/src/plot.ts");
    const render = PlotPanel.prototype.render;
    PlotPanel.prototype.render = function (...args: Parameters<typeof render>) {
      (window as any).sortedPanel = this;
      return render.apply(this, args);
    };
  });
  await page
    .getByLabel("Access token", { exact: true })
    .fill("trace-sort-test");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Ordering", exact: true }).click();
  for (const id of ["a", "b", "c"])
    await page
      .getByRole("checkbox", { name: `Select Run ${id}`, exact: true })
      .check();
  const switchView = async (name: string) =>
    page
      .getByRole("navigation", { name: "Experiment views" })
      .getByRole("button", { name, exact: true })
      .click();
  const topLabel = () =>
    page.evaluate(() => {
      const p = (window as any).sortedPanel;
      return p?.chart?.series.at(-2)?.label;
    });
  await switchView("Charts");
  await expect.poll(topLabel).toContain("Run c");
  const requests = loads;
  const saved = await page.evaluate(() =>
    localStorage.getItem("nset.workspaces.v2"),
  );
  await switchView("Runs");
  await page.locator('.run-table button[data-sort-key="name"]').click();
  await switchView("Charts");
  await expect.poll(topLabel).toContain("Run a");
  expect(loads).toBe(requests);
  expect(
    await page.evaluate(() => localStorage.getItem("nset.workspaces.v2")),
  ).toBe(saved);
});
