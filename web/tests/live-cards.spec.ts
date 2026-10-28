import { expect, test, type Page } from "@playwright/test";

/** Real cards and uPlot; only transport/cache publication is controlled here. */
async function fixture(
  page: Page,
  options: {
    xy?: boolean;
    held?: boolean;
    path?: "linear" | "matched";
    missing?: boolean;
    fixed?: boolean;
    points?: boolean;
  } = {},
) {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.route(/^http:\/\/127\.0\.0\.1:[0-9]+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/");
  await page.evaluate(async (options) => {
    const { ChartCard } = await import("/src/cards.ts");
    const { newChart } = await import("/src/workspace.ts");
    document.body.style.cssText =
      "margin:16px;background:#202429;color:#ddd;font:14px system-ui";
    const grid = document.createElement("main");
    grid.style.cssText = "display:flex;gap:16px;align-items:flex-start";
    document.body.append(grid);
    const runs = ["r", "x"].map((id) => ({
      id,
      name: id,
      experiment_id: "e",
      status: "running",
      params: {},
      tags: {},
      created_at: 0,
      updated_at: 0,
    }));
    const series = (run_id: string, key: string) => ({
      run_id,
      key,
      kind: "metric",
      count: 3,
      last_step: 2,
      last_timestamp: 2,
      last_value: 4,
    });
    const catalog = {
      experiments: [],
      runs,
      series: [
        series("r", "y"),
        series("r", "z"),
        series("r", "other"),
        series("x", "x"),
      ],
    };
    const id = (ref: any) => `${ref.runId}/${ref.key}`;
    const points = (values: number[]) =>
      values.map((value, step) => ({
        seq: step + 1,
        step,
        timestamp: step,
        value,
      }));
    const snapshots = new Map([
      ["r/y", points([0, 2, 4])],
      ["r/z", points([4, 3, 2])],
      ["r/other", points([1, 1, 1])],
      ["x/x", points([0, 2, 4])],
      ["r/new", points([2, 2, 2])],
    ]);
    const s: any = {
      catalog,
      series,
      snapshots,
      calls: [],
      watchers: new Set(),
      pending: [],
      hold: !!options.held,
      failures: new Set(),
      actions: [],
      writes: [],
    };
    const store = {
      clear() {
        throw Error("Live updates must not clear the shared store");
      },
      load(ref: any, signal: AbortSignal) {
        const key = id(ref),
          snapshot = snapshots.get(key) ?? [];
        s.calls.push({ key, signal });
        if (s.failures.has(key)) return Promise.reject(Error("offline"));
        if (!s.hold) return Promise.resolve(snapshot);
        // Deliberately noncooperative transport: card generation/signal checks
        // must also reject stale results after unwatch, context change or destroy.
        return new Promise((resolve) =>
          s.pending.push({ key, signal, resolve, snapshot }),
        );
      },
      watch(refs: any[], callback: () => void) {
        const watch = { keys: refs.map(id), callback };
        s.watchers.add(watch);
        return () => s.watchers.delete(watch);
      },
    };
    s.emit = (key: string, point: any) => {
      snapshots.set(key, [...snapshots.get(key)!, point]);
      for (const watch of s.watchers)
        if (watch.keys.includes(key)) watch.callback();
    };
    s.release = () => {
      s.hold = false;
      for (const pending of s.pending.splice(0))
        pending.resolve(pending.snapshot);
    };
    s.context = { api: {}, catalog, selectedRunIds: ["r"], store };
    const actions = Object.fromEntries(
      [
        "onEdit",
        "onRemove",
        "onDuplicate",
        "onMove",
        "onResize",
        "onDimensions",
      ].map((name) => [
        name,
        (...args: any[]) => s.actions.push([name, ...args]),
      ]),
    );
    s.cards = [
      options.xy ? ["y"] : options.missing ? ["y", "new"] : ["y", "z"],
      ["other"],
    ].map((keys, i) => {
      const spec = newChart("timeseries", keys, i ? "Unrelated" : "Live");
      spec.id = i ? "unrelated" : "live";
      spec.layout = { width: 620, height: 420 };
      spec.config.style.path = options.path ?? "linear";
      if (options.points) spec.config.style.points = true;
      if (options.path === "matched") spec.config.interpolation = "pchip";
      if (options.xy && i === 0)
        spec.x = {
          mode: "series",
          series: { runId: "x", key: "x", kind: "metric" },
        };
      if (options.fixed && i === 0)
        Object.assign(spec.config, { xMin: 0, xMax: 2, yMin: 0, yMax: 10 });
      const host = document.createElement("div");
      host.style.width = "620px";
      grid.append(host);
      return new ChartCard(host, spec, s.context, actions);
    });
    s.card = s.cards[0];
    s.originalSpec = JSON.stringify(s.card.spec);
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      s.writes.push([key, value]);
      return setItem.call(this, key, value);
    };
    (window as any).live = s;
  }, options);
  await expect
    .poll(() => page.evaluate(() => (window as any).live.watchers.size))
    .toBe(2);
  if (!options.held) {
    await expect(page.locator("[data-card-id=live] .u-over")).toBeVisible();
    // Let the initial observer/resize deliveries settle, not live-update timing.
    await page.waitForTimeout(150);
  }
}

async function remember(page: Page) {
  return page.evaluate(() => {
    const s = (window as any).live,
      c = s.card;
    s.saved = {
      chart: c.plot.chart,
      canvas: c.plot.chart.ctx.canvas,
      navigation: c.plot.navigation,
    };
    return {
      view: c.plot.viewport(),
      pins: c.pins,
      history: c.plot.navigation.snapshot().history,
    };
  });
}

async function unchangedState(page: Page) {
  return page.evaluate(() => {
    const s = (window as any).live,
      c = s.card;
    return {
      same:
        c.plot.chart === s.saved.chart &&
        c.plot.chart.ctx.canvas === s.saved.canvas &&
        c.plot.navigation === s.saved.navigation,
      view: c.plot.viewport(),
      pins: c.pins,
      history: c.plot.navigation.snapshot().history,
      spec: JSON.stringify(c.spec) === s.originalSpec,
      actions: s.actions,
      writes: s.writes,
    };
  });
}

for (const path of ["linear", "matched"] as const) {
  test(`${path}: late same-step samples refresh paths/hover while preserving canvas, camera, cursors and visibility`, async ({
    page,
  }) => {
    await fixture(page, { path });
    const pointer = await page.evaluate(() => {
      const s = (window as any).live,
        c = s.card;
      c.setPin("a", 1);
      c.setPin("yB", 2.5);
      c.plot.zoom(1.5);
      s.beforeHide = c.plot.navigation.snapshot();
      c.plot.chart.setSeries(3, { show: false });
      c.plot.chart.setSeries(4, { show: false });
      c.plot.chart.batch(() => {});
      const u = c.plot.chart,
        rect = u.over.getBoundingClientRect();
      return {
        x: rect.left + u.valToPos(1, "x"),
        y: rect.top + u.valToPos(3, "y"),
      };
    });
    await page.mouse.move(pointer.x, pointer.y);
    const before = await remember(page);
    expect(
      await page.evaluate(() =>
        (window as any).live.card.plot.navigation.snapshot(),
      ),
    ).toEqual(await page.evaluate(() => (window as any).live.beforeHide));
    await page.evaluate(() =>
      (window as any).live.emit("r/y", {
        seq: 4,
        step: 1,
        timestamp: 3,
        value: 3,
      }),
    );
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).live.card.data[0].fn.at(1)),
      )
      .toBe(3);
    const after = await unchangedState(page);
    expect(after).toMatchObject({
      same: true,
      ...before,
      spec: true,
      actions: [],
      writes: [],
    });
    const readout = await page.evaluate(() => {
      const c = (window as any).live.card,
        u = c.plot.chart;
      const crossings = c.plot.hoverCrossings(
        [u.valToPos(1, "x"), u.valToPos(3, "y")],
        "x",
      );
      return {
        pointCount: c.data[0].points.length,
        rawCount: c.data[0].count,
        hidden: u.series[3].show === false && u.series[4].show === false,
        value: crossings.value(crossings.rows[0].positions[0]),
        hover: c.lastHoverX,
      };
    });
    expect(readout).toMatchObject({ pointCount: 3, rawCount: 4, hidden: true });
    expect(readout.value).toBeCloseTo(3, 7);
    await expect
      .poll(() => page.evaluate(() => (window as any).live.card.lastHoverX))
      .not.toBeNull();
    await page.mouse.move(0, 0);
    await expect
      .poll(() => page.evaluate(() => (window as any).live.card.lastHoverX))
      .toBeNull();
  });
}

test("XY subscribes to both channels, refits new data, and leaves unrelated cards alone", async ({
  page,
}) => {
  await fixture(page, { xy: true });
  const before = await remember(page);
  const calls = await page.evaluate(() => {
    const s = (window as any).live;
    const own = [...s.watchers].find((watch: any) =>
      watch.keys.includes("r/y"),
    ) as any;
    if (!own.keys.includes("x/x")) throw Error("Missing fixed-X watch");
    return s.calls.filter((call: any) => call.key === "r/other").length;
  });
  await page.evaluate(() =>
    (window as any).live.emit("x/x", {
      seq: 4,
      step: 1,
      timestamp: 3,
      value: 10,
    }),
  );
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).live.card.data[0].points[1]),
    )
    .toEqual([10, 2]);
  const after = await unchangedState(page);
  expect(after.same).toBe(true);
  expect(after.view.x[1]).toBeGreaterThan(before.view.x[1]);
  expect(
    await page.evaluate(
      () =>
        (window as any).live.calls.filter((call: any) => call.key === "r/other")
          .length,
    ),
  ).toBe(calls);
});

test("fixed ranges remain fixed while an unzoomed fit follows appended data", async ({
  page,
}) => {
  await fixture(page, { fixed: true });
  const before = await remember(page);
  await page.evaluate(() =>
    (window as any).live.emit("r/y", {
      seq: 4,
      step: 100,
      timestamp: 100,
      value: 100,
    }),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).live.card.data[0].count))
    .toBe(4);
  expect((await unchangedState(page)).view).toEqual(before.view);
  await page.evaluate(() => {
    const s = (window as any).live;
    s.cards[1].plot.zoom(2);
    s.cards[1].plot.reset();
    s.emit("r/other", { seq: 4, step: 100, timestamp: 100, value: 100 });
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).live.cards[1].plot.viewport().x[1]),
    )
    .toBe(100);
});

test("hidden and offscreen cards unwatch, cancel demand, and catch up without clearing", async ({
  page,
}) => {
  await fixture(page);
  await remember(page);
  await page.evaluate(() => {
    const s = (window as any).live;
    s.hold = true;
    s.emit("r/y", { seq: 4, step: 3, timestamp: 3, value: 6 });
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).live.pending.length))
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(
    await page.evaluate(() => {
      const s = (window as any).live;
      return [
        s.watchers.size,
        s.pending.every((p: any) => p.signal.aborted),
        s.card.data[0].count,
      ];
    }),
  ).toEqual([0, true, 3]);
  await page.evaluate(() => {
    const s = (window as any).live;
    s.emit("r/y", { seq: 5, step: 4, timestamp: 4, value: 8 });
    s.release();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).live.card.data[0].count))
    .toBe(5);
  expect((await unchangedState(page)).same).toBe(true);
  await page.evaluate(() => {
    const s = (window as any).live;
    s.card.host.style.cssText = "position:absolute;top:6000px;width:620px";
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).live.watchers.size))
    .toBe(1);
  const count = await page.evaluate(() => (window as any).live.calls.length);
  await page.evaluate(() =>
    (window as any).live.emit("r/y", {
      seq: 6,
      step: 5,
      timestamp: 5,
      value: 10,
    }),
  );
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as any).live.calls.length)).toBe(
    count,
  );
  await page.evaluate(
    () => ((window as any).live.card.host.style.cssText = "width:620px"),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).live.card.data[0].count))
    .toBe(6);
  await page.evaluate(() =>
    (window as any).live.cards.forEach((c: any) => c.destroy()),
  );
  expect(await page.evaluate(() => (window as any).live.watchers.size)).toBe(0);
});

test("publication during initialization catches up and live failures retain the last complete plot", async ({
  page,
}) => {
  await fixture(page, { held: true });
  await page.evaluate(() => {
    const s = (window as any).live;
    s.measurement = s.card.showMeasurement({ axis: "x", a: 1 });
    s.emit("r/y", { seq: 4, step: 1, timestamp: 3, value: 3 });
    s.release();
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).live.card.data[0]?.fn.at(1)),
    )
    .toBe(3);
  expect(await page.evaluate(() => (window as any).live.measurement)).toBe(
    true,
  );
  expect(await page.evaluate(() => (window as any).live.card.pins.a)).toBe(1);
  await remember(page);
  await page.evaluate(() => {
    const s = (window as any).live;
    s.failures.add("r/y");
    s.emit("r/y", { seq: 5, step: 1, timestamp: 4, value: 4 });
  });
  await expect(page.locator("[data-card-id=live] .card-status")).toContainText(
    "showing previous data",
  );
  expect((await unchangedState(page)).same).toBe(true);
  expect(
    await page.evaluate(() => (window as any).live.card.data[0].fn.at(1)),
  ).toBe(3);
  await page.evaluate(() => (window as any).live.failures.clear());
  await expect
    .poll(() => page.evaluate(() => (window as any).live.card.data[0].fn.at(1)))
    .toBe(4);
});

test("catalog summaries do not reload; new configured series preserve camera, cursors and draft", async ({
  page,
}) => {
  await fixture(page, { missing: true });
  await page.evaluate(() => {
    const s = (window as any).live,
      c = s.card;
    c.plot.zoom(1.5);
    c.setPin("a", 1);
    s.beforeHide = c.plot.navigation.snapshot();
    c.plot.chart.setSeries(1, { show: false });
    c.plot.chart.setSeries(2, { show: false });
    c.plot.chart.batch(() => {});
  });
  expect(
    await page.evaluate(() =>
      (window as any).live.card.plot.navigation.snapshot(),
    ),
  ).toEqual(await page.evaluate(() => (window as any).live.beforeHide));
  const before = await remember(page);
  const loads = await page.evaluate(() => (window as any).live.calls.length);
  await page.evaluate(() => {
    const s = (window as any).live;
    s.catalog = {
      ...s.catalog,
      series: s.catalog.series.map((entry: any) => ({ ...entry, count: 900 })),
    };
    s.cards.forEach((c: any) => c.updateCatalog(s.catalog));
  });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as any).live.calls.length)).toBe(
    loads,
  );
  expect((await unchangedState(page)).same).toBe(true);
  await page.evaluate(() => {
    const s = (window as any).live;
    s.catalog = {
      ...s.catalog,
      series: [...s.catalog.series, s.series("r", "new")],
    };
    s.card.updateCatalog(s.catalog);
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).live.card.data.length))
    .toBe(2);
  const after = await unchangedState(page);
  expect(after).toMatchObject({
    ...before,
    spec: true,
    actions: [],
    writes: [],
  });
  expect(
    await page.evaluate(() =>
      (window as any).live.card.plot.chart.series
        .slice(1)
        .map((s: any) => s.show),
    ),
  ).toEqual([false, false, true, false]);
  await page.evaluate(() => {
    const s = (window as any).live;
    s.saved = {
      chart: s.card.plot.chart,
      canvas: s.card.plot.chart.ctx.canvas,
      navigation: s.card.plot.navigation,
    };
    s.catalog = {
      ...s.catalog,
      runs: s.catalog.runs.map((run: any) => ({
        ...run,
        name: run.id === "r" ? "Renamed" : run.name,
      })),
    };
    s.card.updateCatalog(s.catalog);
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).live.card.data[0].run.name))
    .toContain("Renamed");
  expect((await unchangedState(page)).same).toBe(true);
});

test("native legend hide-all keeps a finite camera through a live update and show restores the updated trace", async ({
  page,
}) => {
  await fixture(page, { missing: true, points: true });
  await page.evaluate(() => {
    const c = (window as any).live.card;
    c.plot.zoom(1.5);
    c.setPin("a", 1);
    // Cards use a separate folded legend. Expose PlotPanel's native legend
    // here to exercise the real paired visibility handler used by previews.
    c.plot.chart.root.querySelector(".u-legend").style.display = "table";
  });
  const before = await remember(page);
  const legend = page.locator(
    '[data-card-id=live] .u-legend .u-series[data-series-index="1"] .u-label',
  );
  await legend.click();
  const hidden = await unchangedState(page);
  expect(hidden).toMatchObject({ same: true, ...before });
  expect(
    await page.evaluate(() =>
      (window as any).live.card.plot.chart.series
        .slice(1)
        .map((s: any) => s.show),
    ),
  ).toEqual([false, false]);
  await page.evaluate(() =>
    (window as any).live.emit("r/y", {
      seq: 4,
      step: 1,
      timestamp: 3,
      value: 3,
    }),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).live.card.data[0].fn.at(1)))
    .toBe(3);
  expect(await unchangedState(page)).toMatchObject({
    same: true,
    ...before,
    spec: true,
    actions: [],
    writes: [],
  });
  expect(
    await page.evaluate(() =>
      (window as any).live.card.plot.chart.series
        .slice(1)
        .map((s: any) => s.show),
    ),
  ).toEqual([false, false]);
  await legend.click();
  expect(await unchangedState(page)).toMatchObject({ same: true, ...before });
  const shown = await page.evaluate(() => {
    const c = (window as any).live.card,
      u = c.plot.chart;
    const crossings = c.plot.hoverCrossings(
      [u.valToPos(1, "x"), u.valToPos(3, "y")],
      "x",
    );
    return {
      visible: u.series.slice(1).map((series: any) => series.show),
      value: crossings.value(crossings.rows[0].positions[0]),
    };
  });
  expect(shown.visible).toEqual([true, true]);
  expect(shown.value).toBeCloseTo(3, 7);
  await page.evaluate(() => (window as any).live.card.plot.back());
  expect(
    await page.evaluate(() => (window as any).live.card.plot.viewport()),
  ).toEqual(before.history[0]);
});
test("live batches defer throughout a pan and retain its single Back entry", async ({
  page,
}) => {
  await fixture(page);
  await remember(page);
  const over = page.locator("[data-card-id=live] .u-over");
  const box = (await over.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2, {
    steps: 4,
  });
  await page.evaluate(() => {
    const s = (window as any).live;
    for (let i = 4; i <= 8; i++)
      s.emit("r/y", { seq: i, step: i, timestamp: i, value: i });
  });
  await page.waitForTimeout(250);
  expect(
    await page.evaluate(() => {
      const c = (window as any).live.card;
      return [c.plot.interacting(), c.data[0].count];
    }),
  ).toEqual([true, 3]);
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2);
  await page.mouse.up({ button: "right" });
  const committed = await page.evaluate(() =>
    (window as any).live.card.plot.viewport(),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).live.card.data[0].count))
    .toBe(8);
  const after = await unchangedState(page);
  expect(after.same).toBe(true);
  expect(after.view).toEqual(committed);
  expect(after.history).toHaveLength(1);
});

test.describe("touch live data", () => {
  test.use({ hasTouch: true });
  test("a live append waits for both pinch contacts and keeps the committed camera", async ({
    page,
    context,
  }) => {
    await fixture(page);
    await page.evaluate(() => {
      const c = (window as any).live.card;
      c.mode = "navigate";
      c.configure();
    });
    await remember(page);
    const box = (await page
      .locator("[data-card-id=live] .u-over")
      .boundingBox())!;
    const a = {
      x: box.x + box.width / 2 - 40,
      y: box.y + box.height / 2,
      id: 1,
    };
    const b = { ...a, x: a.x + 80, id: 2 };
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [a, b],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { ...a, x: a.x - 30 },
        { ...b, x: b.x + 30 },
      ],
    });
    await page.evaluate(() =>
      (window as any).live.emit("r/y", {
        seq: 4,
        step: 3,
        timestamp: 3,
        value: 6,
      }),
    );
    await page.waitForTimeout(250);
    expect(
      await page.evaluate(() => {
        const c = (window as any).live.card;
        return [c.plot.navigation.contacts.size, c.data[0].count];
      }),
    ).toEqual([2, 3]);
    const committed = await page.evaluate(() =>
      (window as any).live.card.plot.viewport(),
    );
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() => page.evaluate(() => (window as any).live.card.data[0].count))
      .toBe(4);
    const after = await unchangedState(page);
    expect(after.same).toBe(true);
    expect(after.view).toEqual(committed);
    expect(after.history).toHaveLength(1);
    await cdp.detach();
  });
});
